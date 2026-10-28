//! The checks every agent query passes, and the shaping of what goes back.
//! Pure functions, so each guard is unit-tested without a database.

use std::time::Duration;

use rowkery_core::connections::ConnectionRecord;
use rowkery_core::safety::{check_sql, Dialect, StatementKind};
use rowkery_core::Value;
use serde_json::Value as Json;

/// Rows a query returns when the caller doesn't say.
pub const DEFAULT_ROWS: usize = 200;
/// Most rows a query may return, whatever the caller asks for.
pub const MAX_ROWS: usize = 1000;
/// Server-side limit on one statement, unless the connection gives agents
/// longer (Settings › Agents).
pub const STATEMENT_TIMEOUT: Duration = Duration::from_secs(10);
/// The statement limits a connection may give agents, in seconds; the
/// first is [`STATEMENT_TIMEOUT`].
pub const STATEMENT_TIMEOUTS_S: [u64; 4] = [10, 30, 60, 300];
/// Tables with more rows than this may not be read end to end.
pub const BIG_TABLE_ROWS: u64 = 100_000;
/// Longer text cells are cut to this many characters.
pub const CELL_CHARS: usize = 200;
/// Rows stop once the JSON passes this size.
pub const PAYLOAD_BYTES: usize = 64 * 1024;
/// Biggest Postgres plan parsed. A query over a table with many partitions,
/// or many joins, can make a plan far bigger than its SQL (about 26 bytes
/// per partition and column), and parsed it takes several times its text.
pub const PLAN_BYTES: usize = 8 * 1024 * 1024;

/// The connection's limit on one agent statement: the one it saved when
/// that's one of [`STATEMENT_TIMEOUTS_S`], else [`STATEMENT_TIMEOUT`], so a
/// hand-edited config can't give agents longer than the app offers.
pub fn statement_timeout(record: &ConnectionRecord) -> Duration {
    match record.mcp_timeout_s() {
        Some(s) if STATEMENT_TIMEOUTS_S.contains(&s) => Duration::from_secs(s),
        _ => STATEMENT_TIMEOUT,
    }
}

/// The JSON plan in `EXPLAIN (FORMAT JSON …)`'s one cell, and its text;
/// refused past [`PLAN_BYTES`] before it's parsed.
pub fn pg_plan_json(rows: Vec<Vec<Value>>) -> Result<(Json, String), String> {
    let Some(Value::Text(text)) = rows.into_iter().next().and_then(|r| r.into_iter().next()) else {
        return Err("EXPLAIN returned no JSON plan.".into());
    };
    if text.len() > PLAN_BYTES {
        return Err(format!(
            "Refused: the query's plan is {:.1} MB, more than the {} MB Rowkery checks. Filter on the partition key, select fewer columns, or join fewer tables or views.",
            text.len() as f64 / (1024.0 * 1024.0),
            PLAN_BYTES / (1024 * 1024)
        ));
    }
    let plan = serde_json::from_str(&text).map_err(|e| {
        if e.to_string().starts_with("recursion limit exceeded") {
            "Refused: the query's plan is nested too deep to check. Join fewer tables at once."
                .to_string()
        } else {
            e.to_string()
        }
    })?;
    Ok((plan, text))
}

/// Plan lines up to [`PAYLOAD_BYTES`], and how many more were left out.
pub fn plan_shown(mut lines: Vec<String>) -> (Vec<String>, usize) {
    let mut size = 0;
    let keep = lines
        .iter()
        .position(|l| {
            size += l.len() + 4;
            size > PAYLOAD_BYTES
        })
        .unwrap_or(lines.len());
    let more = lines.len() - keep;
    lines.truncate(keep);
    (lines, more)
}

/// `sql` as exactly one read statement (SELECT, WITH, VALUES, TABLE) with
/// its trailing `;` removed, or why it is refused. `dialect`: the
/// connection's engine.
pub fn single_read(sql: &str, dialect: Dialect) -> Result<String, String> {
    let checks = check_sql(sql, dialect);
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

/// Why a plan that reads tables it doesn't name is refused when tables are
/// hidden or columns masked.
pub const UNNAMED_SCAN_REFUSAL: &str = "Postgres would read some tables here without naming them in its plan (a join or aggregate pushed down to a foreign server, or a custom scan), so Rowkery can't check them against the hidden tables and masked columns. Query each foreign table on its own.";

/// Whether a Postgres plan has a scan that reads relations without a
/// `Relation Name`: a Foreign Scan whose join or aggregate postgres_fdw
/// pushed down (it lists them only as text in `Relations`), or a Custom
/// Scan. `pg_relations` can't see what those read.
pub fn pg_unnamed_scan(explain_json: &Json) -> bool {
    fn walk(node: &Json) -> bool {
        let kind = node.get("Node Type").and_then(Json::as_str);
        (matches!(kind, Some("Foreign Scan" | "Custom Scan"))
            && node.get("Relation Name").is_none())
            || node
                .get("Plans")
                .and_then(Json::as_array)
                .is_some_and(|children| children.iter().any(walk))
    }
    let root = explain_json
        .get(0)
        .and_then(|p| p.get("Plan"))
        .unwrap_or(explain_json);
    walk(root)
}

/// Whether Postgres left partitions out of the plan as the executor
/// started (`Subplans Removed`): pruning on values only known then, such as
/// `now()`, which the run works out again and may land elsewhere.
pub fn pg_pruned(explain_json: &Json) -> bool {
    fn walk(node: &Json) -> bool {
        node.get("Subplans Removed")
            .and_then(Json::as_u64)
            .is_some_and(|n| n > 0)
            || node
                .get("Plans")
                .and_then(Json::as_array)
                .is_some_and(|children| children.iter().any(walk))
    }
    let root = explain_json
        .get(0)
        .and_then(|p| p.get("Plan"))
        .unwrap_or(explain_json);
    walk(root)
}

/// Statistics hold sample values of every column (Postgres's `pg_stats`
/// and `pg_stats_ext` most common values and histograms, read from these
/// two catalogs; SQLite's `sqlite_stat3` / `sqlite_stat4` index samples),
/// so with tables hidden or columns masked they're off limits too. SQLite
/// reserves the `sqlite_` prefix, so the name alone says it's the catalog.
pub fn is_statistics(schema: Option<&str>, table: &str) -> bool {
    let pg = schema.is_none_or(|s| s == "pg_catalog")
        && matches!(table, "pg_statistic" | "pg_statistic_ext_data");
    let sqlite = schema != Some("pg_catalog")
        && table
            .get(..11)
            .is_some_and(|p| p.eq_ignore_ascii_case("sqlite_stat"));
    pg || sqlite
}

/// Postgres catalogs that hold credentials, and the column of each that
/// holds them: role password hashes (`pg_authid.rolpassword`, under
/// `pg_shadow`), foreign servers' user mappings with their passwords
/// (`pg_user_mapping.umoptions`, under `pg_user_mappings` and
/// `information_schema.user_mapping_options`) and subscriptions' connection
/// strings (`pg_subscription.subconninfo`).
const SECRETS: &[(&str, &str)] = &[
    ("pg_authid", "rolpassword"),
    ("pg_user_mapping", "umoptions"),
    ("pg_subscription", "subconninfo"),
];

pub fn is_credentials(schema: Option<&str>, table: &str) -> bool {
    schema.is_none_or(|s| s == "pg_catalog") && SECRETS.iter().any(|(t, _)| *t == table)
}

/// The columns of the credentials catalogs in order, as (catalog, column)
/// rows, for [`credentials_use`].
pub const CREDENTIAL_COLUMNS_SQL: &str = "SELECT c.relname::text, a.attname::text \
    FROM pg_catalog.pg_attribute a JOIN pg_catalog.pg_class c ON c.oid = a.attrelid \
    WHERE c.relnamespace = 'pg_catalog'::regnamespace \
    AND c.relname IN ('pg_authid', 'pg_user_mapping', 'pg_subscription') \
    AND a.attnum > 0 AND NOT a.attisdropped ORDER BY c.relname, a.attnum";

/// Why a plan that reads a credentials catalog is refused: it uses the
/// secret column. Read for an agent, whatever is shared, never; the rest of
/// the catalog (role names under `pg_roles`, `information_schema.schemata`
/// and the privilege views) stays open.
///
/// Every use of the column shows in the plan by its name, views expanded:
/// anywhere in an expression, or as a whole row (`a.*`). One place lists it
/// without using it: a scan straight under a join (through Hash, Sort or
/// Material) may emit the catalog's whole row, every column in order, and
/// the join takes only what it names. Names the check can't follow are
/// refused: a column alias list on the catalog (`pg_authid AS a(…, pw)`,
/// seen in `written_calls`, the `name(` calls of the SQL as sent) or a
/// column of the scan the catalog doesn't have.
pub fn credentials_use(
    plan: &Json,
    columns: &[(String, String)],
    written_calls: &[String],
) -> Option<&'static str> {
    use crate::mask::{tokens, Tok};
    // The credentials scans as (alias, catalog).
    fn scans(node: &Json, out: &mut Vec<(String, String)>) {
        let rel = node.get("Relation Name").and_then(Json::as_str);
        let schema = node.get("Schema").and_then(Json::as_str);
        if let Some(rel) = rel.filter(|r| is_credentials(schema, r)) {
            let alias = node.get("Alias").and_then(Json::as_str).unwrap_or(rel);
            out.push((alias.to_string(), rel.to_string()));
        }
        for child in node
            .get("Plans")
            .and_then(Json::as_array)
            .into_iter()
            .flatten()
        {
            scans(child, out);
        }
    }
    let root = plan.get(0).and_then(|p| p.get("Plan")).unwrap_or(plan);
    let mut found = Vec::new();
    scans(root, &mut found);
    if found.is_empty() {
        return None;
    }
    let columns_of = |rel: &str| -> Vec<&str> {
        columns
            .iter()
            .filter(|(t, _)| t == rel)
            .map(|(_, c)| c.as_str())
            .collect()
    };
    // Postgres tells a repeated alias apart with `_1`, `_2`.
    let base = |alias: &str| -> String {
        match alias.rsplit_once('_') {
            Some((b, n)) if !n.is_empty() && n.bytes().all(|c| c.is_ascii_digit()) => b.into(),
            _ => alias.into(),
        }
    };
    if found
        .iter()
        .any(|(alias, _)| written_calls.contains(alias) || written_calls.contains(&base(alias)))
    {
        return Some(CREDENTIALS_RENAMED);
    }
    let secret = |name: &str| SECRETS.iter().any(|(_, c)| *c == name);
    // An Output that is a catalog's whole row, in order.
    let whole_row = |list: &[&str]| {
        found.iter().any(|(alias, rel)| {
            let cols = columns_of(rel);
            list.len() == cols.len()
                && list.iter().zip(&cols).all(|(entry, col)| {
                    matches!(tokens(entry).as_slice(),
                        [Tok::Name(chain)] if chain.last().map(String::as_str) == Some(*col)
                            && (chain.len() == 1 || (chain.len() == 2 && chain[0] == *alias)))
                })
        })
    };
    const PASS: &[&str] = &["Hash", "Sort", "Incremental Sort", "Material", "Memoize"];
    const JOINS: &[&str] = &["Hash Join", "Merge Join", "Nested Loop"];
    fn walk(
        node: &Json,
        under_join: bool,
        check: &dyn Fn(&Json, bool) -> Option<&'static str>,
    ) -> Option<&'static str> {
        let kind = node.get("Node Type").and_then(Json::as_str).unwrap_or("");
        if let Some(why) = check(node, under_join) {
            return Some(why);
        }
        let next = JOINS.contains(&kind) || (PASS.contains(&kind) && under_join);
        node.get("Plans")
            .and_then(Json::as_array)
            .into_iter()
            .flatten()
            .find_map(|child| walk(child, next, check))
    }
    let check = |node: &Json, under_join: bool| -> Option<&'static str> {
        let kind = node.get("Node Type").and_then(Json::as_str).unwrap_or("");
        let rel = node.get("Relation Name").and_then(Json::as_str);
        let schema = node.get("Schema").and_then(Json::as_str);
        let own = rel.filter(|r| is_credentials(schema, r));
        let map = node.as_object()?;
        for (key, value) in map {
            if key == "Plans" || crate::functions::NAME_KEYS.contains(&key.as_str()) {
                continue;
            }
            let list: Vec<&str> = match value {
                Json::String(s) => vec![s.as_str()],
                Json::Array(items) => items.iter().filter_map(Json::as_str).collect(),
                _ => continue,
            };
            let passing = key == "Output"
                && under_join
                && (own.is_some() || PASS.contains(&kind))
                && whole_row(&list);
            if passing {
                continue;
            }
            for entry in &list {
                let toks = tokens(entry);
                for tok in &toks {
                    let Tok::Name(chain) = tok else { continue };
                    if chain.last().is_some_and(|n| secret(n)) {
                        return Some(CREDENTIALS_REFUSAL);
                    }
                    if let [head, col] = chain.as_slice() {
                        if let Some((_, rel)) = found.iter().find(|(a, _)| a == head) {
                            if col == "*" {
                                return Some(CREDENTIALS_REFUSAL);
                            }
                            if !columns_of(rel).contains(&col.as_str()) {
                                return Some(CREDENTIALS_RENAMED);
                            }
                        }
                    }
                }
                // A scan of the catalog that emits a bare name: one of its own.
                if let (Some(rel), "Output", [Tok::Name(chain)]) =
                    (own, key.as_str(), toks.as_slice())
                {
                    let name = chain[0].as_str();
                    let constant = matches!(name, "null" | "true" | "false");
                    if chain.len() == 1 && !constant && !columns_of(rel).contains(&name) {
                        return Some(CREDENTIALS_RENAMED);
                    }
                }
            }
        }
        None
    };
    walk(root, false, &check)
}

pub const STATISTICS_REFUSAL: &str =
    "Refused: column statistics (pg_stats, pg_statistic, sqlite_stat4) hold sample values of every column, including ones the user masked or hasn't shared. Leave them out of the query.";

pub const CREDENTIALS_REFUSAL: &str =
    "Refused: this reads a password or connection string (pg_authid.rolpassword under pg_shadow, pg_user_mapping.umoptions under pg_user_mappings, or pg_subscription.subconninfo). Agents never read these. Leave that column out; role names (pg_roles.rolname) are fine.";

pub const CREDENTIALS_RENAMED: &str =
    "Refused: this renames the columns of a catalog that holds passwords or connection strings (pg_authid, pg_user_mapping or pg_subscription), so Rowkery can't tell which one it reads. Use the columns' own names.";

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
            if s.chars().nth(CELL_CHARS).is_some() {
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
    fn partitions_left_out_as_the_run_starts_are_seen_at_any_depth() {
        let pruned = json!([{ "Plan": { "Node Type": "Limit", "Plans": [
            { "Node Type": "Append", "Subplans Removed": 2, "Plans": [] }
        ] } }]);
        assert!(pg_pruned(&pruned));
        let none = json!([{ "Plan": { "Node Type": "Append", "Subplans Removed": 0, "Plans": [
            { "Node Type": "Seq Scan", "Relation Name": "ledger_1" }
        ] } }]);
        assert!(!pg_pruned(&none));
    }

    /// postgres_fdw with `use_remote_estimate` pushes a join of two foreign
    /// tables down as one Foreign Scan that names them only in `Relations`
    /// (the plan as Postgres 16 gave it).
    #[test]
    fn a_scan_that_names_no_relation_is_seen() {
        let pushed = json!([{ "Plan": { "Node Type": "Foreign Scan", "Operation": "Select",
            "Relations": "(crm.people p) INNER JOIN (crm.accounts a)",
            "Remote SQL": "SELECT r1.email FROM (crm.people r1 INNER JOIN crm.accounts r2 ON (((r2.pid = r1.id))))" } }]);
        assert!(pg_unnamed_scan(&pushed));
        assert!(pg_relations(&pushed).is_empty());
        let custom = json!([{ "Plan": { "Node Type": "Limit", "Plans": [
            { "Node Type": "Custom Scan", "Custom Plan Provider": "x" }
        ] } }]);
        assert!(pg_unnamed_scan(&custom));
        let named = json!([{ "Plan": { "Node Type": "Hash Join", "Plans": [
            { "Node Type": "Foreign Scan", "Relation Name": "people", "Schema": "crm" },
            { "Node Type": "Seq Scan", "Relation Name": "orders", "Schema": "public" }
        ] } }]);
        assert!(!pg_unnamed_scan(&named));
    }

    #[test]
    fn a_plan_past_its_cap_is_refused_before_it_is_parsed() {
        let cell = |t: String| vec![vec![Value::Text(t)]];
        let (plan, text) = pg_plan_json(cell(r#"[{"Plan": {}}]"#.into())).unwrap();
        assert_eq!(plan[0]["Plan"], json!({}));
        assert_eq!(text, r#"[{"Plan": {}}]"#);
        let exact = format!("[{}]", " ".repeat(PLAN_BYTES - 2));
        assert!(pg_plan_json(cell(exact)).is_ok());
        let big = format!("[{}]", " ".repeat(PLAN_BYTES - 1));
        let err = pg_plan_json(cell(big)).unwrap_err();
        assert!(
            err.starts_with("Refused: the query's plan is 8.0 MB, more than the 8 MB"),
            "{err}"
        );
        let deep = format!("{}{}", "[".repeat(200), "]".repeat(200));
        assert!(pg_plan_json(cell(deep))
            .unwrap_err()
            .contains("nested too deep"),);
        assert_eq!(
            pg_plan_json(Vec::new()).unwrap_err(),
            "EXPLAIN returned no JSON plan."
        );
    }

    #[test]
    fn plan_lines_stop_at_the_answer_size() {
        let lines: Vec<String> = (0..10_000).map(|i| format!("Seq Scan on p{i}")).collect();
        let (shown, more) = plan_shown(lines);
        assert!(more > 0);
        assert_eq!(shown.len() + more, 10_000);
        assert!(shown.iter().map(|l| l.len() + 4).sum::<usize>() <= PAYLOAD_BYTES);
        assert_eq!(
            plan_shown(vec!["Result".into()]),
            (vec!["Result".into()], 0)
        );
    }

    #[test]
    fn reads_pass_and_lose_their_semicolon() {
        assert_eq!(
            single_read("select 1;  ", Dialect::Either).unwrap(),
            "select 1"
        );
        assert_eq!(
            single_read("WITH x AS (SELECT 1) SELECT * FROM x", Dialect::Either).unwrap(),
            "WITH x AS (SELECT 1) SELECT * FROM x"
        );
        assert!(single_read("VALUES (1)", Dialect::Either).is_ok());
        assert!(single_read("-- why\nSELECT 1", Dialect::Either).is_ok());
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
            assert!(
                single_read(sql, Dialect::Either).is_err(),
                "{sql} should be refused"
            );
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
            let err = single_read(sql, Dialect::Either).expect_err(sql);
            assert!(err.starts_with("Refused"), "{sql}: {err}");
        }
        // The ones only one engine reads that way: refused there too.
        for (sql, dialect) in [
            (
                "WITH a AS (SELECT 1 AS [it's]) DELETE FROM t --']",
                Dialect::Sqlite,
            ),
            (
                "WITH a AS (SELECT CAST(1 AS E'\\')) DELETE FROM t --')",
                Dialect::Sqlite,
            ),
        ] {
            assert!(single_read(sql, dialect).is_err(), "{sql}");
        }
        assert!(single_read(
            "SELECT set_config('search_path', 'app', false)",
            Dialect::Either
        )
        .is_ok());
        assert!(single_read("SELECT m['key'], [x] FROM t", Dialect::Either).is_ok());
        assert!(single_read("SELECT [it's] FROM t", Dialect::Sqlite).is_ok());
        assert!(single_read("SELECT d['a]b'] FROM t", Dialect::Postgres).is_ok());
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
        assert!(is_statistics(Some("main"), "sqlite_stat4"));
        assert!(is_statistics(Some("other"), "SQLITE_STAT1"));
        assert!(!is_statistics(Some("main"), "sqlite_master"));
        assert!(is_credentials(Some("pg_catalog"), "pg_authid"));
        assert!(is_credentials(Some("pg_catalog"), "pg_user_mapping"));
        assert!(!is_credentials(Some("public"), "pg_authid"));
    }

    #[test]
    fn credentials_refuse_only_the_secret_column() {
        let cols: Vec<(String, String)> = ["oid", "rolname", "rolpassword"]
            .iter()
            .map(|c| ("pg_authid".to_string(), c.to_string()))
            .collect();
        let scan = |out: &[&str]| {
            json!({ "Node Type": "Seq Scan", "Relation Name": "pg_authid",
                "Schema": "pg_catalog", "Alias": "u", "Output": out })
        };
        let joined = |top: &[&str], scan: Json| {
            json!([{ "Plan": { "Node Type": "Hash Join", "Output": top,
                "Hash Cond": "(u.oid = n.nspowner)", "Plans": [scan,
                { "Node Type": "Hash", "Plans": [{ "Node Type": "Seq Scan",
                  "Relation Name": "pg_namespace", "Schema": "pg_catalog", "Alias": "n" }] }] } }])
        };
        let full = ["u.oid", "u.rolname", "u.rolpassword"];
        // information_schema.schemata: the whole row under a join, unused.
        let plan = joined(&["n.nspname", "(u.rolname)::name"], scan(&full));
        assert_eq!(credentials_use(&plan, &cols, &[]), None);
        // The same row anywhere else, or the column used, is refused.
        let plan = json!([{ "Plan": scan(&full) }]);
        assert_eq!(
            credentials_use(&plan, &cols, &[]),
            Some(CREDENTIALS_REFUSAL)
        );
        let plan = joined(&["u.rolpassword"], scan(&full));
        assert_eq!(
            credentials_use(&plan, &cols, &[]),
            Some(CREDENTIALS_REFUSAL)
        );
        let plan = joined(&["u.*"], scan(&["u.oid"]));
        assert_eq!(
            credentials_use(&plan, &cols, &[]),
            Some(CREDENTIALS_REFUSAL)
        );
        // Names it can't follow: an alias list, or a column it doesn't have.
        let plan = joined(&["u.rolname"], scan(&["u.oid", "u.rolname"]));
        assert_eq!(
            credentials_use(&plan, &cols, &["u".into()]),
            Some(CREDENTIALS_RENAMED)
        );
        let plan = joined(&["u.pw"], scan(&["u.oid", "u.pw"]));
        assert_eq!(
            credentials_use(&plan, &cols, &[]),
            Some(CREDENTIALS_RENAMED)
        );
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
