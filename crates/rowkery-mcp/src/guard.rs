//! The checks every agent query passes, and the shaping of what goes back.
//! Pure functions, so each guard is unit-tested without a database.

use std::time::Duration;

use rowkery_core::safety::{check_sql, StatementKind};
use rowkery_core::Value;
use serde_json::Value as Json;

/// Rows a query returns when the caller doesn't say.
pub const DEFAULT_ROWS: usize = 200;
/// Most rows a query may return, whatever the caller asks for.
pub const MAX_ROWS: usize = 1000;
/// Server-side limit on one statement.
pub const STATEMENT_TIMEOUT: Duration = Duration::from_secs(10);
/// Tables with more rows than this may not be read end to end.
pub const BIG_TABLE_ROWS: u64 = 100_000;
/// Longer text cells are cut to this many characters.
pub const CELL_CHARS: usize = 200;
/// Rows stop once the JSON passes this size.
pub const PAYLOAD_BYTES: usize = 64 * 1024;

/// `sql` as exactly one read statement (SELECT, WITH, VALUES, TABLE) with
/// its trailing `;` removed, or why it is refused.
pub fn single_read(sql: &str) -> Result<String, String> {
    let checks = check_sql(sql);
    match checks.as_slice() {
        [] => Err("Empty query.".into()),
        [check] => {
            if check.unlocks_writes {
                return Err(
                    "Refused: this changes a read-only setting. This server only runs SELECT queries."
                        .into(),
                );
            }
            if check.kind != StatementKind::Read {
                return Err(format!(
                    "Refused: {} is not a read. This server only runs SELECT queries.",
                    check.verb
                ));
            }
            if !matches!(check.verb.as_str(), "SELECT" | "WITH" | "VALUES" | "TABLE") {
                return Err(format!(
                    "Refused: {} can't be run here. Send a SELECT (use the explain tool for plans).",
                    check.verb
                ));
            }
            let mut text = sql.trim();
            while let Some(rest) = text.strip_suffix(';') {
                text = rest.trim_end();
            }
            Ok(text.to_string())
        }
        many => Err(format!(
            "Refused: {} statements. Send one SELECT per call.",
            many.len()
        )),
    }
}

/// Caps the rows of a read without touching its own ORDER BY or LIMIT. The
/// newlines keep a trailing `--` comment from swallowing the wrapper.
/// `alias` names the wrapper (`wrapper_alias`).
pub fn wrap_limit(sql: &str, limit: usize, alias: &str) -> String {
    format!("SELECT * FROM (\n{sql}\n) AS {alias} LIMIT {limit}")
}

/// A fresh alias for the row-cap wrapper on each call. The masked-column
/// check (`mask::pg_check`) trusts the wrapper's subquery to be ours, so an
/// agent must not be able to name one of its own the same.
pub fn wrapper_alias() -> String {
    use std::hash::{BuildHasher, Hasher};
    let mut h = std::collections::hash_map::RandomState::new().build_hasher();
    h.write_u128(
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_nanos())
            .unwrap_or(0),
    );
    format!("rowkery_q_{:016x}", h.finish())
}

/// `max_rows` from the caller, clamped to 1..=MAX_ROWS.
pub fn row_cap(requested: Option<u64>) -> usize {
    requested
        .map(|n| (n as usize).clamp(1, MAX_ROWS))
        .unwrap_or(DEFAULT_ROWS)
}

/// A table a Postgres plan reads end to end.
#[derive(Debug, Clone, PartialEq)]
pub struct FullScan {
    pub schema: Option<String>,
    pub table: String,
}

/// One line per plan node (`Seq Scan on public.orders  rows≈1200000`), and
/// the sequential scans that read their whole table. A scan with no filter
/// straight under a LIMIT stops early, so it doesn't count.
pub fn pg_plan(explain_json: &Json) -> (Vec<String>, Vec<FullScan>) {
    let mut lines = Vec::new();
    let mut scans = Vec::new();
    let root = explain_json
        .get(0)
        .and_then(|p| p.get("Plan"))
        .unwrap_or(explain_json);
    walk_plan(root, 0, true, &mut lines, &mut scans);
    (lines, scans)
}

fn walk_plan(
    node: &Json,
    depth: usize,
    streaming: bool,
    lines: &mut Vec<String>,
    scans: &mut Vec<FullScan>,
) {
    let kind = node.get("Node Type").and_then(Json::as_str).unwrap_or("?");
    let relation = node.get("Relation Name").and_then(Json::as_str);
    let schema = node
        .get("Schema")
        .and_then(Json::as_str)
        .map(str::to_string);
    let mut line = format!("{}{kind}", "  ".repeat(depth));
    if let Some(index) = node.get("Index Name").and_then(Json::as_str) {
        line.push_str(&format!(" using {index}"));
    }
    if let Some(rel) = relation {
        match &schema {
            Some(s) => line.push_str(&format!(" on {s}.{rel}")),
            None => line.push_str(&format!(" on {rel}")),
        }
    }
    if let Some(rows) = node.get("Plan Rows").and_then(Json::as_f64) {
        line.push_str(&format!("  rows≈{}", rows as u64));
    }
    if let Some(cost) = node.get("Total Cost").and_then(Json::as_f64) {
        line.push_str(&format!("  cost {cost:.0}"));
    }
    if let Some(cond) = ["Index Cond", "Filter", "Hash Cond", "Join Filter"]
        .iter()
        .find_map(|k| node.get(*k).and_then(Json::as_str).map(|v| (*k, v)))
    {
        line.push_str(&format!("  {}: {}", cond.0, cond.1));
    }
    lines.push(line);

    // An index walked with no condition (`count(*)` as an Index Only Scan)
    // reads every entry, so it counts like a sequential scan.
    let whole_index =
        kind.contains("Index") && kind.ends_with("Scan") && node.get("Index Cond").is_none();
    if kind.ends_with("Seq Scan") || whole_index {
        let filtered = node.get("Filter").is_some();
        if let Some(rel) = relation {
            if filtered || !streaming {
                scans.push(FullScan {
                    schema: schema.clone(),
                    table: rel.to_string(),
                });
            }
        }
    }
    let passes_through = matches!(kind, "Limit" | "Subquery Scan" | "Result");
    if let Some(children) = node.get("Plans").and_then(Json::as_array) {
        for child in children {
            walk_plan(child, depth + 1, streaming && passes_through, lines, scans);
        }
    }
}

/// Every relation a Postgres plan touches (views are already expanded to
/// their tables), as (schema, table).
pub fn pg_relations(explain_json: &Json) -> Vec<(Option<String>, String)> {
    fn walk(node: &Json, out: &mut Vec<(Option<String>, String)>) {
        if let Some(rel) = node.get("Relation Name").and_then(Json::as_str) {
            let schema = node
                .get("Schema")
                .and_then(Json::as_str)
                .map(str::to_string);
            out.push((schema, rel.to_string()));
        }
        if let Some(children) = node.get("Plans").and_then(Json::as_array) {
            for child in children {
                walk(child, out);
            }
        }
    }
    let mut out = Vec::new();
    let root = explain_json
        .get(0)
        .and_then(|p| p.get("Plan"))
        .unwrap_or(explain_json);
    walk(root, &mut out);
    out
}

/// Postgres statistics hold sample values of every column (`pg_stats`'
/// most common values), so with tables hidden they're off limits too.
pub fn is_statistics(schema: Option<&str>, table: &str) -> bool {
    schema.is_none_or(|s| s == "pg_catalog")
        && matches!(table, "pg_statistic" | "pg_statistic_ext_data")
}

pub const HIDDEN_REFUSAL: &str =
    "Refused: this reads a table the user hasn't shared with agents in Rowkery. A view or join needs every table it reads shared. Leave it out of the query, or ask the user to share it.";

/// Tables SQLite's `EXPLAIN QUERY PLAN` reads in full (`SCAN t`, as opposed to
/// `SEARCH t USING INDEX`).
pub fn sqlite_full_scans(details: &[String]) -> Vec<String> {
    details
        .iter()
        .filter_map(|d| {
            let rest = d.trim().strip_prefix("SCAN ")?;
            let name = rest.split_whitespace().next()?;
            (!rest.contains("USING INTEGER PRIMARY KEY")).then(|| name.to_string())
        })
        .collect()
}

/// `db-***.rds.amazonaws.com`, `10.0.*.*`: enough to tell servers apart,
/// not enough to reach one. Local hosts stay as they are.
pub fn mask_host(host: &str) -> String {
    let host = host.trim();
    if matches!(host, "localhost" | "127.0.0.1" | "::1" | "") {
        return host.to_string();
    }
    if let Ok(std::net::IpAddr::V4(ip)) = host.parse::<std::net::IpAddr>() {
        let o = ip.octets();
        return format!("{}.{}.*.*", o[0], o[1]);
    }
    if host.parse::<std::net::IpAddr>().is_ok() {
        return "***".into();
    }
    let (first, rest) = match host.split_once('.') {
        Some((first, rest)) => (first, Some(rest)),
        None => (host, None),
    };
    let head: String = first.chars().take(3).collect();
    match rest {
        Some(rest) => format!("{head}***.{rest}"),
        None => format!("{head}***"),
    }
}

/// A cell as compact JSON: long text cut, binary left out.
pub fn cell(value: &Value, cut: &mut bool) -> Json {
    match value {
        Value::Null => Json::Null,
        Value::Bool(b) => Json::Bool(*b),
        Value::Int(n) => Json::from(*n),
        Value::Float(f) => serde_json::Number::from_f64(*f)
            .map(Json::Number)
            .unwrap_or_else(|| Json::String(f.to_string())),
        Value::Text(s) => {
            if s.chars().count() > CELL_CHARS {
                *cut = true;
                let mut short: String = s.chars().take(CELL_CHARS).collect();
                short.push('…');
                Json::String(short)
            } else {
                Json::String(s.clone())
            }
        }
        Value::Bytes(b) => Json::String(format!("<{} bytes>", b.len())),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn reads_pass_and_lose_their_semicolon() {
        assert_eq!(single_read("select 1;  ").unwrap(), "select 1");
        assert_eq!(
            single_read("WITH x AS (SELECT 1) SELECT * FROM x").unwrap(),
            "WITH x AS (SELECT 1) SELECT * FROM x"
        );
        assert!(single_read("VALUES (1)").is_ok());
        assert!(single_read("-- why\nSELECT 1").is_ok());
    }

    #[test]
    fn everything_else_is_refused() {
        for sql in [
            "DELETE FROM orders",
            "UPDATE t SET a = 1 WHERE id = 1",
            "DROP TABLE t",
            "SELECT 1; DELETE FROM t",
            "SELECT 1; SELECT 2",
            "WITH d AS (DELETE FROM t RETURNING *) SELECT * FROM d",
            "SELECT * INTO copy FROM t",
            "SET default_transaction_read_only = off",
            "SHOW search_path",
            "EXPLAIN SELECT 1",
            "PRAGMA query_only = 0",
            "BEGIN",
            "",
        ] {
            assert!(single_read(sql).is_err(), "{sql} should be refused");
        }
    }

    /// reports#12: the classifier read each of these as a read.
    #[test]
    fn classifier_bypasses_are_refused() {
        let deep_explain = "EXPLAIN ".repeat(50_000) + "SELECT 1";
        for sql in [
            "SELECT set_config('default_transaction_read_only','off',false)",
            "SELECT \"set_config\"('transaction_read_only', 'off', true)",
            "WITH a AS (SELECT 1 AS [it's]) DELETE FROM t --']",
            "WITH x AS (SELECT 1) SELECT * INTO stolen FROM x",
            "WITH a AS (SELECT 1) REPLACE INTO t SELECT * FROM a",
            "SELECT \"pg_terminate_backend\"(42)",
            "SELECT CAST(1 AS E'\\'')",
            "COPY (SELECT 1) TO PROGRAM 'true'",
            "EXPLAIN (",
            deep_explain.as_str(),
        ] {
            let err = single_read(sql).expect_err(sql);
            assert!(err.starts_with("Refused"), "{sql}: {err}");
        }
        assert!(single_read("SELECT set_config('search_path', 'app', false)").is_ok());
        assert!(single_read("SELECT m['key'], [x] FROM t").is_ok());
    }

    #[test]
    fn limit_wraps_and_survives_a_trailing_comment() {
        assert_eq!(
            wrap_limit("select * from t order by id -- newest", 201, "rowkery_q"),
            "SELECT * FROM (\nselect * from t order by id -- newest\n) AS rowkery_q LIMIT 201"
        );
        assert_eq!(row_cap(None), 200);
        assert_eq!(row_cap(Some(5000)), 1000);
        assert_eq!(row_cap(Some(0)), 1);
    }

    #[test]
    fn plan_flags_full_reads_but_not_a_limited_browse() {
        let browse = json!([{ "Plan": {
            "Node Type": "Limit", "Plan Rows": 201.0, "Total Cost": 4.0,
            "Plans": [{ "Node Type": "Seq Scan", "Relation Name": "orders", "Schema": "public",
                        "Plan Rows": 1200000.0, "Total Cost": 20000.0 }]
        }}]);
        let (lines, scans) = pg_plan(&browse);
        assert!(scans.is_empty());
        assert_eq!(
            lines[1],
            "  Seq Scan on public.orders  rows≈1200000  cost 20000"
        );

        let filtered = json!([{ "Plan": {
            "Node Type": "Limit",
            "Plans": [{ "Node Type": "Seq Scan", "Relation Name": "orders", "Schema": "public",
                        "Filter": "(note ~~* '%x%'::text)" }]
        }}]);
        assert_eq!(pg_plan(&filtered).1.len(), 1);

        let count = json!([{ "Plan": {
            "Node Type": "Limit",
            "Plans": [{ "Node Type": "Aggregate",
              "Plans": [{ "Node Type": "Gather",
                "Plans": [{ "Node Type": "Parallel Seq Scan", "Relation Name": "orders",
                            "Schema": "public" }] }] }]
        }}]);
        assert_eq!(
            pg_plan(&count).1,
            vec![FullScan {
                schema: Some("public".into()),
                table: "orders".into()
            }]
        );

        let indexed = json!([{ "Plan": {
            "Node Type": "Index Scan", "Index Name": "orders_status_idx",
            "Relation Name": "orders", "Schema": "public", "Index Cond": "(status = 'failed'::text)"
        }}]);
        assert!(pg_plan(&indexed).1.is_empty());

        let count_by_index = json!([{ "Plan": {
            "Node Type": "Limit",
            "Plans": [{ "Node Type": "Aggregate",
              "Plans": [{ "Node Type": "Index Only Scan", "Index Name": "orders_pkey",
                          "Relation Name": "orders", "Schema": "public" }] }]
        }}]);
        assert_eq!(pg_plan(&count_by_index).1.len(), 1);

        let newest = json!([{ "Plan": {
            "Node Type": "Limit",
            "Plans": [{ "Node Type": "Index Scan", "Scan Direction": "Backward", "Index Name": "orders_pkey",
                        "Relation Name": "orders", "Schema": "public" }]
        }}]);
        assert!(pg_plan(&newest).1.is_empty());
    }

    #[test]
    fn sqlite_scans() {
        let plan = vec![
            "SCAN orders".to_string(),
            "SEARCH regions USING INTEGER PRIMARY KEY (rowid=?)".to_string(),
            "SCAN events USING COVERING INDEX events_day".to_string(),
        ];
        assert_eq!(sqlite_full_scans(&plan), vec!["orders", "events"]);
    }

    #[test]
    fn plan_relations_and_hidden_tables() {
        let plan = json!([{ "Plan": {
            "Node Type": "Hash Join",
            "Plans": [
                { "Node Type": "Seq Scan", "Relation Name": "orders", "Schema": "public" },
                { "Node Type": "Hash", "Plans": [
                    { "Node Type": "Index Scan", "Relation Name": "api_keys", "Schema": "auth" }
                ]}
            ]
        }}]);
        let rels = pg_relations(&plan);
        assert_eq!(
            rels,
            vec![
                (Some("public".into()), "orders".into()),
                (Some("auth".into()), "api_keys".into())
            ]
        );
        let hidden = vec!["auth.API_KEYS".to_string(), "users".to_string()];
        let rule = crate::access::Tables::AllBut(&hidden);
        assert!(!rule.allows("auth", "api_keys"));
        assert!(!rule.allows("public", "users"));
        assert!(rule.allows("public", "api_keys"));
        assert!(is_statistics(Some("pg_catalog"), "pg_statistic"));
        assert!(!is_statistics(Some("public"), "pg_statistic"));
    }

    #[test]
    fn hosts_are_masked() {
        assert_eq!(
            mask_host("db-prod-1.abc.rds.amazonaws.com"),
            "db-***.abc.rds.amazonaws.com"
        );
        assert_eq!(mask_host("10.0.12.7"), "10.0.*.*");
        assert_eq!(mask_host("localhost"), "localhost");
        assert_eq!(mask_host("warehouse"), "war***");
    }

    #[test]
    fn cells_are_shaped() {
        let mut cut = false;
        assert_eq!(
            cell(&Value::Bytes(vec![0; 16]), &mut cut),
            json!("<16 bytes>")
        );
        let long = "x".repeat(500);
        let shaped = cell(&Value::Text(long), &mut cut);
        assert!(cut);
        assert_eq!(shaped.as_str().unwrap().chars().count(), CELL_CHARS + 1);
        assert_eq!(cell(&Value::Float(f64::NAN), &mut cut), json!("NaN"));
    }
}
