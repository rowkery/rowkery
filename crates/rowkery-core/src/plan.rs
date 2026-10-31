//! Query plans as a short tree a person can read: one step per plan node,
//! each step's own share of the time (or cost, for an estimate), the row
//! counts Postgres guessed badly, and at most one plain hint.
//!
//! Postgres plans come from `EXPLAIN (FORMAT JSON, VERBOSE[, ANALYZE,
//! BUFFERS])`, SQLite's from `EXPLAIN QUERY PLAN` (no times or counts there).
//! Hints are fixed rules checked in order, the first match wins; facts about
//! the tables involved (indexes, row counts) come from the caller.

use serde::Serialize;
use serde_json::Value as Json;

use crate::db::{qualified_table_sql, quote_ident, EngineKind, RowEstimate, SchemaCatalog};

/// A row-count guess this many times off (either way) is tagged.
pub const MISS_RATIO: f64 = 10.0;
/// …and only when it's off by at least this many rows over all loops.
const MISS_ROWS: f64 = 100.0;
/// Tables smaller than this never get an index hint.
const BIG_TABLE_ROWS: f64 = 10_000.0;
/// A step under this share of the plan's time (or cost) gets no hint.
const HINT_SHARE: f64 = 0.10;

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Plan {
    pub steps: Vec<PlanStep>,
    /// Run with ANALYZE: times and actual rows are real.
    pub timed: bool,
    pub execution_ms: Option<f64>,
    pub planning_ms: Option<f64>,
    /// Rows the statement returned (timed Postgres plans).
    pub rows: Option<f64>,
    /// Index into `steps` of the step with the most time (or cost) of its own.
    pub slowest: Option<usize>,
    pub hint: Option<Hint>,
}

#[derive(Clone, Debug, Default, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PlanStep {
    pub depth: usize,
    /// `Seq Scan`, `Hash Join`, `Scan` (SQLite).
    pub kind: String,
    pub schema: Option<String>,
    pub table: Option<String>,
    pub alias: Option<String>,
    pub index: Option<String>,
    /// A few words after the kind: `by placed_at`, `left`, a CTE's name.
    pub note: Option<String>,
    /// Per loop, as Postgres reports both.
    pub expected_rows: Option<f64>,
    pub actual_rows: Option<f64>,
    pub loops: Option<f64>,
    /// Time spent in this step itself, all loops, without its children.
    pub own_ms: Option<f64>,
    /// Estimated cost of this step itself, without its children.
    pub own_cost: Option<f64>,
    /// How many times off the row guess was, when it's worth a tag.
    pub miss: Option<f64>,
    pub details: Vec<Detail>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct Detail {
    pub label: String,
    pub value: String,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Hint {
    pub text: String,
    /// Something to copy: an index, `ANALYZE`, a `SET`. Never run for you.
    pub sql: Option<String>,
    /// The step it is about.
    pub step: Option<usize>,
}

/// What the hints need to know about the tables a plan reads.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct PlanFacts {
    pub tables: Vec<TableFacts>,
}

#[derive(Clone, Debug, Default, PartialEq)]
pub struct TableFacts {
    pub schema: Option<String>,
    pub table: String,
    /// Estimated rows in the table (`reltuples`, SQLite's count).
    pub rows: Option<f64>,
    /// Each index's columns (or expressions) in order.
    pub indexes: Vec<IndexFacts>,
}

#[derive(Clone, Debug, Default, PartialEq)]
pub struct IndexFacts {
    pub name: String,
    pub columns: Vec<String>,
}

impl PlanFacts {
    fn find(&self, schema: Option<&str>, table: &str) -> Option<&TableFacts> {
        self.tables.iter().find(|t| {
            t.table.eq_ignore_ascii_case(table)
                && match (schema, t.schema.as_deref()) {
                    (Some(a), Some(b)) => a.eq_ignore_ascii_case(b),
                    _ => true,
                }
        })
    }
}

impl PlanFacts {
    /// Facts for `tables` from a loaded catalog (SQLite catalogs carry their
    /// indexes; Postgres ones only after `load_indexes`).
    pub fn from_catalog(catalog: &SchemaCatalog, tables: &[(Option<String>, String)]) -> Self {
        let mut out = PlanFacts::default();
        for schema in catalog.databases.iter().flat_map(|d| d.schemas.iter()) {
            for t in &schema.tables {
                let wanted = tables.iter().any(|(s, name)| {
                    name.eq_ignore_ascii_case(&t.name)
                        && s.as_deref()
                            .is_none_or(|s| s.eq_ignore_ascii_case(&schema.name))
                });
                if !wanted {
                    continue;
                }
                out.tables.push(TableFacts {
                    schema: Some(schema.name.clone()),
                    table: t.name.clone(),
                    rows: match t.row_estimate {
                        RowEstimate::Exact(n) | RowEstimate::Approximate(n) => Some(n as f64),
                        RowEstimate::Unknown => None,
                    },
                    indexes: t
                        .indexes
                        .iter()
                        .map(|i| IndexFacts {
                            name: i.name.clone(),
                            columns: i.columns.clone(),
                        })
                        .collect(),
                });
            }
        }
        out
    }
}

/// The statement that asks for `sql`'s plan. `sql` is one statement; a
/// trailing semicolon is dropped.
pub fn explain_sql(engine: EngineKind, sql: &str, timed: bool) -> Result<String, String> {
    let body = explain_body(sql)?;
    Ok(match engine {
        EngineKind::Postgres if timed => {
            format!("EXPLAIN (FORMAT JSON, VERBOSE, ANALYZE, BUFFERS) {body}")
        }
        EngineKind::Postgres => format!("EXPLAIN (FORMAT JSON, VERBOSE) {body}"),
        EngineKind::Sqlite => format!("EXPLAIN QUERY PLAN {body}"),
        // The form depends on the server: `mysql_explain_sql`.
        EngineKind::Mysql => return Err("Plans for MySQL are asked with mysql_explain_sql.".into()),
    })
}

/// `sql` without its trailing `;`, refused when empty or already an
/// EXPLAIN.
fn explain_body(sql: &str) -> Result<&str, String> {
    let body = sql.trim().trim_end_matches(';').trim_end();
    if body.is_empty() {
        return Err("There's no statement to explain.".into());
    }
    let first = body
        .split(|c: char| !c.is_ascii_alphabetic())
        .next()
        .unwrap_or("");
    if first.eq_ignore_ascii_case("explain") {
        return Err("This is already an EXPLAIN. Remove it and press ⌘E again.".into());
    }
    Ok(body)
}

/// The statement that asks a MySQL server for `sql`'s plan: MySQL's tree
/// (`EXPLAIN ANALYZE` when timed, which runs it), MariaDB's JSON
/// (`ANALYZE FORMAT=JSON` when timed). Read by [`parse_mysql`].
pub fn mysql_explain_sql(mariadb: bool, sql: &str, timed: bool) -> Result<String, String> {
    let body = explain_body(sql)?;
    // MariaDB's `ANALYZE FORMAT=JSON …` is its EXPLAIN ANALYZE.
    if body
        .get(..7)
        .is_some_and(|w| w.eq_ignore_ascii_case("ANALYZE"))
        && body.len() > 8
        && body[7..]
            .trim_start()
            .get(..6)
            .is_some_and(|w| w.eq_ignore_ascii_case("FORMAT"))
    {
        return Err("This is already an EXPLAIN. Remove it and press ⌘E again.".into());
    }
    Ok(match (mariadb, timed) {
        // MySQL 8.0 and 8.4 have no tree for an UPDATE or DELETE; JSON
        // covers every statement on both servers.
        (_, false) => format!("EXPLAIN FORMAT=JSON {body}"),
        (false, true) => format!("EXPLAIN ANALYZE FORMAT=TREE {body}"),
        (true, true) => format!("ANALYZE FORMAT=JSON {body}"),
    })
}

/// Marks a row guess that was far off, as Postgres plans do.
fn tag_miss(step: &mut PlanStep) {
    if let (Some(exp), Some(act)) = (step.expected_rows, step.actual_rows) {
        let ratio = exp.max(1.0) / act.max(1.0);
        let ratio = ratio.max(1.0 / ratio);
        if ratio >= MISS_RATIO && (exp - act).abs() * step.loops.unwrap_or(1.0) >= MISS_ROWS {
            step.miss = Some(ratio);
        }
    }
}

/// Reads a MySQL plan: MySQL's tree text or MariaDB's JSON, whichever the
/// server sent (no hint: none are written for MySQL yet).
pub fn parse_mysql(text: &str, timed: bool) -> Result<Plan, String> {
    let text = text.trim();
    let mut plan = if text.starts_with('{') {
        let json: Json =
            serde_json::from_str(text).map_err(|e| format!("Couldn't read the plan: {e}"))?;
        parse_mysql_json(&json, timed)
    } else if text.starts_with("->") {
        parse_mysql_tree(text, timed)
    } else {
        // `<not executable by iterator executor>`: an INSERT … VALUES.
        return Err("MySQL has no plan to show for this statement.".into());
    };
    if plan.steps.is_empty() {
        return Err("MySQL has no plan to show for this statement.".into());
    }
    plan.slowest = slowest(&plan);
    Ok(plan)
}

/// MySQL's `EXPLAIN FORMAT=TREE` / `EXPLAIN ANALYZE`: one `-> …` line per
/// step, four spaces deeper per level. Costs and times there include the
/// children; each step keeps its own.
fn parse_mysql_tree(text: &str, timed: bool) -> Plan {
    let mut steps: Vec<PlanStep> = Vec::new();
    // Inclusive cost and time of each step, to take its children's out.
    let mut totals: Vec<(Option<f64>, Option<f64>)> = Vec::new();
    for line in text.lines() {
        let Some(at) = line.find("-> ") else { continue };
        let depth = line[..at].len() / 4;
        let rest = &line[at + 3..];
        let (head, figures) = match rest.find("  (") {
            Some(i) => (&rest[..i], &rest[i..]),
            None => match rest
                .find(" (actual time=")
                .or_else(|| rest.find(" (never executed)"))
            {
                Some(i) => (&rest[..i], &rest[i..]),
                None => (rest, ""),
            },
        };
        let figure = |key: &str| -> Option<(f64, f64)> {
            let from = figures.find(key)? + key.len();
            let value: String = figures[from..]
                .chars()
                .take_while(|c| c.is_ascii_digit() || matches!(c, '.' | 'e' | '-' | '+'))
                .collect();
            let (a, b) = value.split_once("..").unwrap_or((&value, &value));
            Some((a.parse().ok()?, b.parse().ok()?))
        };
        let actual = figures.find("(actual ").map(|i| &figures[i..]);
        let in_actual = |key: &str| -> Option<(f64, f64)> {
            let a = actual?;
            let from = a.find(key)? + key.len();
            let value: String = a[from..]
                .chars()
                .take_while(|c| c.is_ascii_digit() || matches!(c, '.' | 'e' | '-' | '+'))
                .collect();
            let (x, y) = value.split_once("..").unwrap_or((&value, &value));
            Some((x.parse().ok()?, y.parse().ok()?))
        };
        let mut step = PlanStep {
            depth,
            ..PlanStep::default()
        };
        let cost = figure("cost=").map(|c| c.1);
        step.expected_rows = figure("rows=").map(|r| r.0);
        if timed {
            step.actual_rows = in_actual("rows=").map(|r| r.0);
            step.loops = in_actual("loops=").map(|r| r.0);
            if figures.contains("(never executed)") {
                step.actual_rows = Some(0.0);
                step.loops = Some(0.0);
            }
        }
        let time = in_actual("actual time=").map(|t| t.1 * step.loops.unwrap_or(1.0));
        mysql_tree_head(head, &mut step);
        if timed {
            tag_miss(&mut step);
        }
        steps.push(step);
        totals.push((cost, time));
    }
    // Own = inclusive minus the direct children's inclusive.
    for i in 0..steps.len() {
        let depth = steps[i].depth;
        let children: Vec<usize> = (i + 1..steps.len())
            .take_while(|&j| steps[j].depth > depth)
            .filter(|&j| steps[j].depth == depth + 1)
            .collect();
        // `part` 0 is the cost, 1 the time.
        let own = |part: usize| {
            let of = |j: usize| if part == 0 { totals[j].0 } else { totals[j].1 };
            of(i).map(|t| (t - children.iter().filter_map(|&j| of(j)).sum::<f64>()).max(0.0))
        };
        steps[i].own_cost = own(0);
        steps[i].own_ms = if timed { own(1) } else { None };
    }
    Plan {
        // Each top-level part (a subquery in the select list is one) adds
        // its own time.
        execution_ms: if timed {
            steps
                .iter()
                .zip(&totals)
                .filter(|(s, _)| s.depth == 0)
                .filter_map(|(_, t)| t.1)
                .reduce(|a, b| a + b)
        } else {
            None
        },
        rows: if timed {
            steps
                .first()
                .and_then(|s| Some(s.actual_rows? * s.loops.unwrap_or(1.0)))
        } else {
            None
        },
        steps,
        timed,
        planning_ms: None,
        slowest: None,
        hint: None,
    }
}

/// `Index scan on pl_b using PRIMARY`, `Filter: (a > 1)`,
/// `Single-row index lookup on o using PRIMARY (id=c.order_id)`.
fn mysql_tree_head(head: &str, step: &mut PlanStep) {
    let unquote = |s: &str| s.trim_matches('`').to_string();
    if let Some((kind, cond)) = head.split_once(": ") {
        step.kind = kind.to_string();
        step.details.push(Detail {
            label: kind.to_string(),
            value: cond.trim().to_string(),
        });
        return;
    }
    let Some((kind, rest)) = head.split_once(" on ") else {
        step.kind = head.to_string();
        return;
    };
    step.kind = kind.to_string();
    let (table, rest) = match rest.split_once(" using ") {
        Some((t, r)) => (t, Some(r)),
        None => (rest, None),
    };
    // `<union temporary>` is one name; a real one ends at its alias.
    let table = match table.find('>') {
        Some(end) if table.starts_with('<') => &table[..=end],
        _ => table.split_whitespace().next().unwrap_or(table),
    };
    if !table.starts_with('<') {
        step.table = Some(unquote(table));
    } else {
        step.note = Some(table.to_string());
    }
    if let Some(rest) = rest {
        let (index, cond) = match rest.split_once(" (") {
            Some((i, c)) => (i, Some(c.trim_end_matches(')'))),
            None => (rest, None),
        };
        step.index = Some(unquote(index.split_whitespace().next().unwrap_or(index)));
        if let Some(cond) = cond {
            step.details.push(Detail {
                label: "Index Cond".into(),
                value: cond.to_string(),
            });
        }
    }
}

/// `EXPLAIN FORMAT=JSON` (both servers) and MariaDB's `ANALYZE FORMAT=JSON`:
/// each `table` is a step, as are sorts, temporary tables and subqueries
/// around them.
fn parse_mysql_json(json: &Json, timed: bool) -> Plan {
    fn walk(node: &Json, depth: usize, timed: bool, steps: &mut Vec<PlanStep>) {
        match node {
            Json::Array(items) => {
                for item in items {
                    walk(item, depth, timed, steps);
                }
            }
            Json::Object(map) => {
                for (key, value) in map {
                    let kind = match key.as_str() {
                        "table" => {
                            steps.push(mariadb_table(value, depth, timed));
                            walk_inner(value, depth + 1, timed, steps);
                            continue;
                        }
                        "filesort" => Some("Sort"),
                        // MySQL: an ORDER BY an index needs no sort step.
                        "ordering_operation"
                            if value.get("using_filesort").and_then(Json::as_bool)
                                == Some(true) =>
                        {
                            Some("Sort")
                        }
                        "grouping_operation" => Some("Group"),
                        "materialized_from_subquery" => Some("Materialize"),
                        "temporary_table" => Some("Temporary table"),
                        "duplicates_removal" => Some("Remove duplicates"),
                        "materialized" => Some("Materialize"),
                        "query_block" if depth > 0 => Some("Subquery"),
                        "union_result" => Some("Union"),
                        _ => None,
                    };
                    match kind {
                        Some(kind) => {
                            let mut step = PlanStep {
                                depth,
                                kind: kind.into(),
                                note: value
                                    .get("sort_key")
                                    .and_then(Json::as_str)
                                    .map(|k| format!("by {k}")),
                                ..PlanStep::default()
                            };
                            if timed {
                                step.loops = value.get("r_loops").and_then(Json::as_f64);
                            }
                            steps.push(step);
                            walk(value, depth + 1, timed, steps);
                        }
                        None => walk(value, depth, timed, steps),
                    }
                }
            }
            _ => {}
        }
    }
    /// A table's own subqueries (`materialized`, …), not its fields.
    fn walk_inner(table: &Json, depth: usize, timed: bool, steps: &mut Vec<PlanStep>) {
        if let Json::Object(map) = table {
            for (key, value) in map {
                if value.is_object() || value.is_array() {
                    if matches!(
                        key.as_str(),
                        "r_engine_stats"
                            | "possible_keys"
                            | "used_key_parts"
                            | "used_columns"
                            | "ref"
                            | "cost_info"
                    ) {
                        continue;
                    }
                    walk(
                        &serde_json::json!({ key.clone(): value.clone() }),
                        depth,
                        timed,
                        steps,
                    );
                }
            }
        }
    }
    let mut steps = Vec::new();
    walk(json, 0, timed, &mut steps);
    let total = json
        .get("query_block")
        .and_then(|q| q.get("r_total_time_ms"))
        .and_then(Json::as_f64);
    Plan {
        steps,
        timed,
        execution_ms: if timed { total } else { None },
        planning_ms: if timed {
            json.get("query_optimization")
                .and_then(|q| q.get("r_total_time_ms"))
                .and_then(Json::as_f64)
        } else {
            None
        },
        rows: None,
        slowest: None,
        hint: None,
    }
}

fn mariadb_table(t: &Json, depth: usize, timed: bool) -> PlanStep {
    let text = |k: &str| t.get(k).and_then(Json::as_str).map(str::to_string);
    let num = |k: &str| t.get(k).and_then(Json::as_f64);
    // MySQL writes its costs as strings.
    let figure = |v: Option<&Json>| match v? {
        Json::String(s) => s.parse::<f64>().ok(),
        v => v.as_f64(),
    };
    let access = text("access_type");
    // The words MySQL's tree uses, so both servers read the same.
    let kind = match access.as_deref() {
        Some("ALL") => "Table scan",
        Some("index") => "Index scan",
        Some("range") => "Index range scan",
        Some("ref" | "eq_ref" | "ref_or_null") => "Index lookup",
        Some("const" | "system") => "Constant row",
        Some("index_merge") => "Index merge",
        Some("fulltext") => "Full-text search",
        Some(other) => other,
        // `{"message": "No tables used"}` and the like.
        None => t.get("message").and_then(Json::as_str).unwrap_or("Table"),
    };
    let mut step = PlanStep {
        depth,
        kind: kind.into(),
        table: text("table_name"),
        index: text("key"),
        expected_rows: num("rows").or_else(|| num("rows_examined_per_scan")),
        own_cost: num("cost").or_else(|| {
            let info = t.get("cost_info")?;
            Some(figure(info.get("read_cost"))? + figure(info.get("eval_cost")).unwrap_or(0.0))
        }),
        ..PlanStep::default()
    };
    if let Some(cond) = text("attached_condition") {
        step.details.push(Detail {
            label: "Filter".into(),
            value: cond,
        });
    }
    if timed {
        step.actual_rows = num("r_rows");
        step.loops = num("r_loops");
        step.own_ms = match (num("r_table_time_ms"), num("r_other_time_ms")) {
            (None, None) => num("r_total_time_ms"),
            (a, b) => Some(a.unwrap_or(0.0) + b.unwrap_or(0.0)),
        };
        tag_miss(&mut step);
    }
    step
}

/// Reads Postgres's `EXPLAIN (FORMAT JSON)` output (no hint yet).
pub fn parse_pg(explain: &Json) -> Result<Plan, String> {
    let top = explain.get(0).unwrap_or(explain);
    let root = top
        .get("Plan")
        .ok_or_else(|| "EXPLAIN returned no plan.".to_string())?;
    let timed = root.get("Actual Total Time").is_some() || root.get("Actual Loops").is_some();
    let mut steps = Vec::new();
    walk_pg(root, 0, 1.0, timed, &mut steps);
    let mut plan = Plan {
        rows: timed
            .then(|| {
                let s = steps.first()?;
                Some(s.actual_rows? * s.loops.unwrap_or(1.0))
            })
            .flatten(),
        steps,
        timed,
        execution_ms: top.get("Execution Time").and_then(Json::as_f64),
        planning_ms: top.get("Planning Time").and_then(Json::as_f64),
        slowest: None,
        hint: None,
    };
    plan.slowest = slowest(&plan);
    Ok(plan)
}

fn num(node: &Json, key: &str) -> Option<f64> {
    node.get(key).and_then(Json::as_f64)
}

fn text<'a>(node: &'a Json, key: &str) -> Option<&'a str> {
    node.get(key).and_then(Json::as_str)
}

fn list(node: &Json, key: &str) -> Option<String> {
    let items: Vec<&str> = node
        .get(key)?
        .as_array()?
        .iter()
        .filter_map(Json::as_str)
        .collect();
    (!items.is_empty()).then(|| items.join(", "))
}

/// Adds `node` and its children; returns (time over all loops, total cost).
/// `procs` is how many processes share the loops (inside a Gather), so a
/// parallel step's time isn't counted once per worker.
fn walk_pg(
    node: &Json,
    depth: usize,
    procs: f64,
    timed: bool,
    steps: &mut Vec<PlanStep>,
) -> (f64, f64) {
    let at = steps.len();
    let kind_raw = text(node, "Node Type").unwrap_or("?");
    let kind = match (kind_raw, text(node, "Strategy")) {
        ("Aggregate", Some("Hashed")) => "Hash Aggregate".to_string(),
        ("Aggregate", Some("Sorted")) => "Group Aggregate".to_string(),
        ("Aggregate", Some("Mixed")) => "Mixed Aggregate".to_string(),
        // `Delete on orders` reads better than `ModifyTable`.
        ("ModifyTable", _) => text(node, "Operation").unwrap_or(kind_raw).to_string(),
        _ if node.get("Parallel Aware").and_then(Json::as_bool) == Some(true)
            && !kind_raw.starts_with("Parallel") =>
        {
            format!("Parallel {kind_raw}")
        }
        _ => kind_raw.to_string(),
    };
    let loops = num(node, "Actual Loops");
    let mut step = PlanStep {
        depth,
        kind,
        schema: text(node, "Schema").map(str::to_string),
        table: text(node, "Relation Name").map(str::to_string),
        alias: text(node, "Alias").map(str::to_string),
        index: text(node, "Index Name").map(str::to_string),
        note: pg_note(node),
        expected_rows: num(node, "Plan Rows"),
        actual_rows: num(node, "Actual Rows"),
        loops,
        ..PlanStep::default()
    };
    step.details = pg_details(node, loops.unwrap_or(1.0));
    if timed {
        if let (Some(exp), Some(act)) = (step.expected_rows, step.actual_rows) {
            let ratio = exp.max(1.0) / act.max(1.0);
            let ratio = ratio.max(1.0 / ratio);
            if ratio >= MISS_RATIO && (exp - act).abs() * loops.unwrap_or(1.0) >= MISS_ROWS {
                step.miss = Some(ratio);
            }
        }
    }
    steps.push(step);

    let inner_procs = if kind_raw.starts_with("Gather") {
        num(node, "Workers Launched").unwrap_or(0.0) + 1.0
    } else {
        procs
    };
    let (mut child_ms, mut child_cost) = (0.0, 0.0);
    if let Some(children) = node.get("Plans").and_then(Json::as_array) {
        for child in children {
            let (ms, cost) = walk_pg(child, depth + 1, inner_procs, timed, steps);
            child_ms += ms;
            child_cost += cost;
        }
    }
    let ms = num(node, "Actual Total Time").unwrap_or(0.0) * loops.unwrap_or(1.0) / procs;
    let cost = num(node, "Total Cost").unwrap_or(0.0);
    if timed {
        steps[at].own_ms = Some((ms - child_ms).max(0.0));
    }
    steps[at].own_cost = Some((cost - child_cost).max(0.0));
    (ms, cost)
}

fn pg_note(node: &Json) -> Option<String> {
    if let Some(keys) = list(node, "Sort Key") {
        return Some(format!("by {keys}"));
    }
    if let Some(join) = text(node, "Join Type").filter(|j| *j != "Inner") {
        return Some(join.to_ascii_lowercase());
    }
    if let Some(cte) = text(node, "CTE Name") {
        return Some(cte.to_string());
    }
    if let Some(f) = text(node, "Function Name") {
        return Some(format!("{f}()"));
    }
    if let Some(sub) = text(node, "Subplan Name") {
        return Some(sub.to_string());
    }
    list(node, "Group Key").map(|keys| format!("by {keys}"))
}

fn pg_details(node: &Json, loops: f64) -> Vec<Detail> {
    let mut out = Vec::new();
    let mut add = |label: &str, value: String| {
        out.push(Detail {
            label: label.into(),
            value,
        })
    };
    for key in [
        "Index Cond",
        "Recheck Cond",
        "Hash Cond",
        "Merge Cond",
        "Join Filter",
        "Filter",
    ] {
        if let Some(v) = text(node, key) {
            add(key, strip_parens(v).to_string());
        }
    }
    if let Some(n) = num(node, "Rows Removed by Filter").filter(|n| *n > 0.0) {
        add("Removed", format!("{} rows", exact(n * loops)));
    }
    if let Some(n) = num(node, "Rows Removed by Index Recheck").filter(|n| *n > 0.0) {
        add("Rechecked away", format!("{} rows", exact(n * loops)));
    }
    if let Some(method) = text(node, "Sort Method") {
        let space = num(node, "Sort Space Used").map(|kb| format!(", {}", size_kb(kb)));
        let place = match text(node, "Sort Space Type") {
            Some("Disk") => " on disk",
            _ => "",
        };
        add(
            "Sort",
            format!("{method}{}{place}", space.unwrap_or_default()),
        );
    }
    if let Some(batches) = num(node, "Hash Batches") {
        let mem = num(node, "Peak Memory Usage").map(|kb| format!(", {}", size_kb(kb)));
        add(
            "Hash",
            format!(
                "{} {}{}",
                count(batches),
                if batches == 1.0 { "batch" } else { "batches" },
                mem.unwrap_or_default()
            ),
        );
    }
    if let Some(kb) = num(node, "Disk Usage").filter(|kb| *kb > 0.0) {
        add("Spilled", format!("{} to disk", size_kb(kb)));
    }
    let hit = num(node, "Shared Hit Blocks").unwrap_or(0.0);
    let read = num(node, "Shared Read Blocks").unwrap_or(0.0);
    if hit + read > 0.0 {
        let disk = if read > 0.0 {
            format!(", {}% from disk", ((read / (hit + read)) * 100.0).round())
        } else {
            String::new()
        };
        add("Read", format!("{} pages{disk}", exact(hit + read)));
    }
    if let Some(w) = num(node, "Workers Launched") {
        add("Workers", count(w));
    }
    out
}

/// `((a = 1))` → `a = 1`: Postgres wraps every condition in parentheses.
fn strip_parens(s: &str) -> &str {
    let mut s = s.trim();
    while s.starts_with('(') && s.ends_with(')') && balanced_inside(&s[1..s.len() - 1]) {
        s = s[1..s.len() - 1].trim();
    }
    s
}

fn balanced_inside(s: &str) -> bool {
    let mut depth = 0i32;
    let mut quoted = false;
    for c in s.chars() {
        match c {
            '\'' => quoted = !quoted,
            '(' if !quoted => depth += 1,
            ')' if !quoted => {
                depth -= 1;
                if depth < 0 {
                    return false;
                }
            }
            _ => {}
        }
    }
    depth == 0
}

/// Reads SQLite's `EXPLAIN QUERY PLAN` rows as (id, parent, detail).
pub fn parse_sqlite(rows: &[(i64, i64, String)]) -> Plan {
    fn add(rows: &[(i64, i64, String)], parent: i64, depth: usize, steps: &mut Vec<PlanStep>) {
        for (id, p, detail) in rows {
            if *p == parent && *id != parent {
                steps.push(sqlite_step(detail, depth));
                add(rows, *id, depth + 1, steps);
            }
        }
    }
    let mut steps = Vec::new();
    add(rows, 0, 0, &mut steps);
    Plan {
        steps,
        timed: false,
        execution_ms: None,
        planning_ms: None,
        rows: None,
        slowest: None,
        hint: None,
    }
}

fn sqlite_step(detail: &str, depth: usize) -> PlanStep {
    let d = detail.trim();
    let mut step = PlanStep {
        depth,
        kind: d.to_string(),
        ..PlanStep::default()
    };
    let (kind, rest) = if let Some(rest) = d.strip_prefix("SCAN ") {
        ("Scan", rest)
    } else if let Some(rest) = d.strip_prefix("SEARCH ") {
        ("Search", rest)
    } else if let Some(rest) = d.strip_prefix("USE TEMP B-TREE ") {
        step.kind = "Temp B-tree".into();
        step.note = Some(rest.to_ascii_lowercase());
        return step;
    } else {
        return step;
    };
    step.kind = kind.into();
    let mut words = rest.split_whitespace();
    let table = words.next().unwrap_or("").to_string();
    if table == "CONSTANT" {
        step.kind = format!("{kind} constant row");
        return step;
    }
    step.table = Some(table);
    if let Some(alias) = rest.split(" AS ").nth(1) {
        step.alias = alias.split_whitespace().next().map(str::to_string);
    }
    if let Some(using) = rest.split(" USING ").nth(1) {
        if using.starts_with("INTEGER PRIMARY KEY") || using.starts_with("PRIMARY KEY") {
            step.index = Some("primary key".into());
        } else {
            step.index = using
                .split("INDEX ")
                .nth(1)
                .and_then(|s| s.split_whitespace().next())
                .map(str::to_string);
        }
        if let (Some(open), Some(close)) = (using.find('('), using.rfind(')')) {
            if open < close {
                step.details.push(Detail {
                    label: "Index Cond".into(),
                    value: using[open + 1..close].to_string(),
                });
            }
        }
    }
    step
}

fn weight(step: &PlanStep, timed: bool) -> f64 {
    if timed {
        step.own_ms.unwrap_or(0.0)
    } else {
        step.own_cost.unwrap_or(0.0)
    }
}

fn slowest(plan: &Plan) -> Option<usize> {
    if plan.steps.len() < 2 {
        return None;
    }
    let (at, w) = plan
        .steps
        .iter()
        .enumerate()
        .map(|(i, s)| (i, weight(s, plan.timed)))
        .fold(
            (0, f64::MIN),
            |best, cur| if cur.1 > best.1 { cur } else { best },
        );
    (w > 0.0).then_some(at)
}

/// Tables the plan reads, as (schema, table), for gathering `PlanFacts`.
pub fn tables(plan: &Plan) -> Vec<(Option<String>, String)> {
    let mut out: Vec<(Option<String>, String)> = Vec::new();
    for s in &plan.steps {
        if let Some(t) = &s.table {
            let key = (s.schema.clone(), t.clone());
            if !out.contains(&key) {
                out.push(key);
            }
        }
    }
    out
}

/// Sets `plan.hint`: the first rule that matches, about a step that matters.
pub fn add_hint(plan: &mut Plan, engine: EngineKind, facts: &PlanFacts) {
    plan.hint = match engine {
        EngineKind::Postgres => pg_hint(plan, facts),
        EngineKind::Sqlite => sqlite_hint(plan, facts),
        EngineKind::Mysql => None,
    };
}

/// Steps worth a hint, heaviest first.
fn candidates(plan: &Plan) -> Vec<usize> {
    let total: f64 = plan.steps.iter().map(|s| weight(s, plan.timed)).sum();
    let mut out: Vec<usize> = (0..plan.steps.len())
        .filter(|&i| total <= 0.0 || weight(&plan.steps[i], plan.timed) / total >= HINT_SHARE)
        .collect();
    out.sort_by(|&a, &b| {
        weight(&plan.steps[b], plan.timed).total_cmp(&weight(&plan.steps[a], plan.timed))
    });
    out
}

fn detail<'a>(step: &'a PlanStep, label: &str) -> Option<&'a str> {
    step.details
        .iter()
        .find(|d| d.label == label)
        .map(|d| d.value.as_str())
}

fn is_seq_scan(step: &PlanStep) -> bool {
    step.kind.ends_with("Seq Scan")
}

fn qualified(engine: EngineKind, step: &PlanStep) -> String {
    let table = step.table.as_deref().unwrap_or("");
    match (&step.schema, engine) {
        (Some(s), EngineKind::Postgres) => qualified_table_sql(engine, s, table),
        _ => quote_ident(engine, table),
    }
}

fn pg_hint(plan: &Plan, facts: &PlanFacts) -> Option<Hint> {
    let order = candidates(plan);
    let pick = |rule: &dyn Fn(usize, &PlanStep) -> Option<Hint>| {
        order.iter().find_map(|&i| rule(i, &plan.steps[i]))
    };
    let pg = EngineKind::Postgres;

    // 1. A filtered seq scan that keeps under 1% of a big table, on a column
    //    no index starts with.
    let missing_index = |i: usize, s: &PlanStep| -> Option<Hint> {
        if !is_seq_scan(s) {
            return None;
        }
        let table = s.table.as_deref()?;
        let filter = detail(s, "Filter")?;
        let t = facts.find(s.schema.as_deref(), table)?;
        let (scanned, kept, about) = if plan.timed {
            let kept = s.actual_rows?;
            let removed = removed_per_loop(s);
            (kept + removed, kept, "")
        } else {
            (t.rows?, s.expected_rows?, "about ")
        };
        if scanned < BIG_TABLE_ROWS || kept / scanned.max(1.0) >= 0.01 {
            return None;
        }
        let refs = filter_columns(filter, s.alias.as_deref().unwrap_or(table));
        let col = refs
            .iter()
            .find(|r| r.wrapped.is_none() && !leads_index(t, &r.column))?;
        Some(Hint {
            text: format!(
                "Seq scan on {table} reads {about}{} rows to keep {about}{}. {table}.{} has no index.",
                count(scanned),
                count(kept),
                col.column
            ),
            sql: Some(format!(
                "CREATE INDEX ON {} ({});",
                qualified(pg, s),
                quote_ident(pg, &col.column)
            )),
            step: Some(i),
        })
    };
    if let Some(h) = pick(&missing_index) {
        return Some(h);
    }

    // 2. A scan whose row guess was far off: statistics are likely stale.
    if plan.timed {
        let stale = |i: usize, s: &PlanStep| -> Option<Hint> {
            s.table.as_deref()?;
            s.miss?;
            let loops = s.loops.unwrap_or(1.0);
            let (exp, act) = (s.expected_rows? * loops, s.actual_rows? * loops);
            if (exp - act).abs() < 1_000.0 {
                return None;
            }
            Some(Hint {
                text: format!(
                    "Postgres expected {} rows from {} and got {}. Its statistics may be out of date.",
                    count(exp),
                    s.table.as_deref()?,
                    count(act)
                ),
                sql: Some(format!("ANALYZE {};", qualified(pg, s))),
                step: Some(i),
            })
        };
        if let Some(h) = pick(&stale) {
            return Some(h);
        }
    }

    // 3. A sort that spilled to disk.
    let sort_disk = |i: usize, s: &PlanStep| -> Option<Hint> {
        let sort = detail(s, "Sort")?;
        if !sort.ends_with(" on disk") {
            return None;
        }
        let kb = kb_in(sort)?;
        Some(Hint {
            text: format!(
                "The sort wrote {} to disk. A larger work_mem keeps it in memory.",
                size_kb(kb)
            ),
            sql: Some(work_mem(kb * 3.0)),
            step: Some(i),
        })
    };
    if let Some(h) = pick(&sort_disk) {
        return Some(h);
    }

    // 4. A hash that split into batches on disk, or a hash aggregate that spilled.
    let hash_disk = |i: usize, s: &PlanStep| -> Option<Hint> {
        if let Some(kb) = detail(s, "Spilled").and_then(kb_in) {
            return Some(Hint {
                text: format!(
                    "The {} wrote {} to disk. A larger work_mem keeps it in memory.",
                    s.kind.to_ascii_lowercase(),
                    size_kb(kb)
                ),
                sql: Some(work_mem(kb * 2.0)),
                step: Some(i),
            });
        }
        let hash = detail(s, "Hash")?;
        let batches: f64 = hash
            .split_whitespace()
            .next()?
            .replace(',', "")
            .parse()
            .ok()?;
        if batches <= 1.0 {
            return None;
        }
        let kb = kb_in(hash).unwrap_or(4096.0);
        Some(Hint {
            text: format!(
                "The hash join split into {} batches on disk. A larger work_mem keeps it in one.",
                count(batches)
            ),
            sql: Some(work_mem(kb * batches * 1.5)),
            step: Some(i),
        })
    };
    if let Some(h) = pick(&hash_disk) {
        return Some(h);
    }

    // 5. A seq scan repeated once per outer row.
    if plan.timed {
        let repeated = |i: usize, s: &PlanStep| -> Option<Hint> {
            let loops = s.loops?;
            if !is_seq_scan(s) || loops <= 100.0 {
                return None;
            }
            let table = s.table.as_deref()?;
            let mut text = format!(
                "{table} is scanned in full {} times, once per row from the other side of the join.",
                count(loops)
            );
            let mut sql = None;
            let t = facts.find(s.schema.as_deref(), table);
            if let (Some(t), Some(filter)) = (t, detail(s, "Filter")) {
                let refs = filter_columns(filter, s.alias.as_deref().unwrap_or(table));
                if let Some(c) = refs
                    .iter()
                    .find(|r| r.wrapped.is_none() && !leads_index(t, &r.column))
                {
                    text.push_str(&format!(" {table}.{} has no index.", c.column));
                    sql = Some(format!(
                        "CREATE INDEX ON {} ({});",
                        qualified(pg, s),
                        quote_ident(pg, &c.column)
                    ));
                }
            }
            Some(Hint {
                text,
                sql,
                step: Some(i),
            })
        };
        if let Some(h) = pick(&repeated) {
            return Some(h);
        }
    }

    // 6. A filter that wraps an indexed column in a function, so the index
    //    can't be used.
    let unused = |i: usize, s: &PlanStep| -> Option<Hint> {
        if !is_seq_scan(s) {
            return None;
        }
        let table = s.table.as_deref()?;
        let t = facts.find(s.schema.as_deref(), table)?;
        let refs = filter_columns(detail(s, "Filter")?, s.alias.as_deref().unwrap_or(table));
        refs.iter().find_map(|r| {
            let f = r.wrapped.as_deref()?;
            let index = t.indexes.iter().find(|ix| {
                ix.columns
                    .first()
                    .is_some_and(|c| c.eq_ignore_ascii_case(&r.column))
            })?;
            let expr = format!("{f}({})", r.column);
            let call = format!("{}(", f.to_ascii_lowercase());
            if t.indexes.iter().any(|ix| {
                ix.columns.first().is_some_and(|c| {
                    let c = c.to_ascii_lowercase();
                    c.starts_with(&call) && c.contains(&r.column.to_ascii_lowercase())
                })
            }) {
                return None;
            }
            Some(Hint {
                text: format!(
                    "{expr} can't use {}. Index {expr}, or compare {} directly.",
                    index.name, r.column
                ),
                sql: Some(format!("CREATE INDEX ON {} ({expr});", qualified(pg, s))),
                step: Some(i),
            })
        })
    };
    pick(&unused)
}

fn sqlite_hint(plan: &Plan, facts: &PlanFacts) -> Option<Hint> {
    let full = plan.steps.iter().enumerate().find_map(|(i, s)| {
        if s.kind != "Scan" || s.index.is_some() {
            return None;
        }
        let table = s.table.as_deref()?;
        let rows = facts.find(None, table)?.rows?;
        let size = if rows >= crate::db::sqlite::PLAN_COUNT_CAP as f64 {
            format!("over {}", count(rows))
        } else {
            count(rows)
        };
        (rows >= BIG_TABLE_ROWS).then(|| Hint {
            text: format!(
                "SQLite reads every row of {table} ({size}). If you filter or join on one of its columns, an index on it lets SQLite go straight to the rows."
            ),
            sql: None,
            step: Some(i),
        })
    });
    full.or_else(|| {
        plan.steps.iter().enumerate().find_map(|(i, s)| {
            (s.kind == "Temp B-tree" && s.note.as_deref() == Some("for order by")).then(|| Hint {
                text: "SQLite sorts the rows itself. An index on the ORDER BY columns returns them already in order.".into(),
                sql: None,
                step: Some(i),
            })
        })
    })
}

fn removed_per_loop(s: &PlanStep) -> f64 {
    // `Removed` holds the total over all loops.
    let total = detail(s, "Removed")
        .and_then(|v| v.split_whitespace().next())
        .and_then(parse_count)
        .unwrap_or(0.0);
    total / s.loops.unwrap_or(1.0).max(1.0)
}

fn leads_index(t: &TableFacts, column: &str) -> bool {
    t.indexes.iter().any(|ix| {
        ix.columns
            .first()
            .is_some_and(|c| c.eq_ignore_ascii_case(column))
    })
}

/// A column of the scanned table a filter mentions, and the function it's
/// wrapped in, if any (`lower(o.email)`).
#[derive(Debug, PartialEq)]
struct ColumnRef {
    column: String,
    wrapped: Option<String>,
}

/// Columns of the table aliased `alias` in a VERBOSE filter, in order:
/// `((o.customer_id = 4012) AND (lower(o.email) = 'x'))`.
fn filter_columns(filter: &str, alias: &str) -> Vec<ColumnRef> {
    let mut out: Vec<ColumnRef> = Vec::new();
    let bytes = filter.as_bytes();
    let ident = |c: u8| c.is_ascii_alphanumeric() || c == b'_' || c == b'$';
    let mut i = 0;
    let mut quoted = false;
    while i < bytes.len() {
        let c = bytes[i];
        if c == b'\'' {
            quoted = !quoted;
            i += 1;
            continue;
        }
        if quoted
            || !(ident(c) || c == b'"')
            || (i > 0 && (ident(bytes[i - 1]) || bytes[i - 1] == b'.'))
        {
            i += 1;
            continue;
        }
        // One name, possibly quoted.
        let read = |at: usize| -> (String, usize) {
            if bytes.get(at) == Some(&b'"') {
                let end = filter[at + 1..]
                    .find('"')
                    .map_or(bytes.len(), |e| at + 1 + e);
                (filter[at + 1..end].to_string(), (end + 1).min(bytes.len()))
            } else {
                let mut end = at;
                while end < bytes.len() && ident(bytes[end]) {
                    end += 1;
                }
                (filter[at..end].to_string(), end)
            }
        };
        let (first, end) = read(i);
        if first.eq_ignore_ascii_case(alias) && bytes.get(end) == Some(&b'.') {
            let (column, after) = read(end + 1);
            let wrapped = function_before(filter, i);
            if !column.is_empty()
                && !out
                    .iter()
                    .any(|r| r.column == column && r.wrapped == wrapped)
            {
                out.push(ColumnRef { column, wrapped });
            }
            i = after;
        } else {
            i = end.max(i + 1);
        }
    }
    out
}

/// `lower` in `lower(o.email`, when `at` is the start of `o.email`.
fn function_before(s: &str, at: usize) -> Option<String> {
    let mut head = s[..at].trim_end();
    head.strip_suffix('(')?;
    while let Some(h) = head.strip_suffix('(') {
        head = h.trim_end();
    }
    let name: String = head
        .chars()
        .rev()
        .take_while(|c| c.is_ascii_alphanumeric() || *c == '_')
        .collect::<Vec<_>>()
        .into_iter()
        .rev()
        .collect();
    (!name.is_empty()
        && !name.eq_ignore_ascii_case("and")
        && !name.eq_ignore_ascii_case("or")
        && !name.eq_ignore_ascii_case("not"))
    .then_some(name)
}

/// The first `123 kB` or `1.5 MB` in `s`, in kB.
fn kb_in(s: &str) -> Option<f64> {
    let words: Vec<&str> = s
        .split(|c: char| c.is_whitespace() || c == ',')
        .filter(|w| !w.is_empty())
        .collect();
    words.windows(2).find_map(|w| {
        let n: f64 = w[0].parse().ok()?;
        match w[1] {
            "kB" => Some(n),
            "MB" => Some(n * 1024.0),
            "GB" => Some(n * 1024.0 * 1024.0),
            _ => None,
        }
    })
}

/// `SET work_mem` to the next power of two in MB that holds `kb` (16 MB at least).
fn work_mem(kb: f64) -> String {
    let mut mb = 16u64;
    while (mb as f64) * 1024.0 < kb && mb < 1 << 20 {
        mb *= 2;
    }
    if mb >= 1024 {
        format!("SET work_mem = '{}GB';", mb / 1024)
    } else {
        format!("SET work_mem = '{mb}MB';")
    }
}

fn size_kb(kb: f64) -> String {
    if kb >= 1024.0 * 1024.0 {
        format!("{:.1} GB", kb / 1024.0 / 1024.0)
    } else if kb >= 1024.0 {
        format!("{} MB", (kb / 1024.0).round())
    } else {
        format!("{} kB", kb.round())
    }
}

/// `312`, `48,200`, `2.1M`.
pub fn count(n: f64) -> String {
    let n = n.round();
    if n >= 1_000_000.0 {
        let m = n / 1_000_000.0;
        if m >= 100.0 {
            format!("{}M", m.round())
        } else {
            format!("{m:.1}M")
        }
    } else {
        exact(n)
    }
}

/// `2,104,388`.
pub fn exact(n: f64) -> String {
    let digits = (n.round() as u64).to_string();
    let mut out = String::new();
    for (i, c) in digits.chars().enumerate() {
        if i > 0 && (digits.len() - i).is_multiple_of(3) {
            out.push(',');
        }
        out.push(c);
    }
    out
}

fn parse_count(s: &str) -> Option<f64> {
    if let Some(m) = s.strip_suffix('M') {
        return m.parse::<f64>().ok().map(|m| m * 1_000_000.0);
    }
    s.replace(',', "").parse().ok()
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn orders_facts(indexes: Vec<IndexFacts>) -> PlanFacts {
        PlanFacts {
            tables: vec![TableFacts {
                schema: Some("public".into()),
                table: "orders".into(),
                rows: Some(2_104_700.0),
                indexes,
            }],
        }
    }

    fn pkey() -> IndexFacts {
        IndexFacts {
            name: "orders_pkey".into(),
            columns: vec!["id".into()],
        }
    }

    /// Shaped like Postgres 16's EXPLAIN (FORMAT JSON, VERBOSE, ANALYZE, BUFFERS).
    fn slow_lookup() -> Json {
        json!([{
            "Plan": {
                "Node Type": "Sort", "Plan Rows": 9.0, "Total Cost": 46000.0,
                "Actual Total Time": 1842.0, "Actual Rows": 312.0, "Actual Loops": 1.0,
                "Sort Key": ["o.placed_at DESC"], "Sort Method": "quicksort",
                "Sort Space Used": 49.0, "Sort Space Type": "Memory",
                "Plans": [{
                    "Node Type": "Nested Loop", "Join Type": "Inner", "Plan Rows": 9.0,
                    "Total Cost": 45990.0, "Actual Total Time": 1838.0,
                    "Actual Rows": 312.0, "Actual Loops": 1.0,
                    "Plans": [{
                        "Node Type": "Seq Scan", "Relation Name": "orders", "Schema": "public",
                        "Alias": "o", "Plan Rows": 9.0, "Total Cost": 45900.0,
                        "Actual Total Time": 1771.0, "Actual Rows": 312.0, "Actual Loops": 1.0,
                        "Filter": "((o.customer_id = 4012) AND ((o.status)::text = 'paid'::text))",
                        "Rows Removed by Filter": 2104388.0,
                        "Shared Hit Blocks": 10690.0, "Shared Read Blocks": 16720.0
                    }, {
                        "Node Type": "Index Scan", "Relation Name": "customers", "Schema": "public",
                        "Alias": "c", "Index Name": "customers_pkey", "Plan Rows": 1.0,
                        "Total Cost": 8.3, "Actual Total Time": 0.21, "Actual Rows": 1.0,
                        "Actual Loops": 312.0, "Index Cond": "(c.id = o.customer_id)"
                    }]
                }]
            },
            "Planning Time": 0.4,
            "Execution Time": 1842.6
        }])
    }

    #[test]
    fn explain_sql_wraps_one_statement() {
        assert_eq!(
            explain_sql(EngineKind::Postgres, "select 1;\n", false).unwrap(),
            "EXPLAIN (FORMAT JSON, VERBOSE) select 1"
        );
        assert_eq!(
            explain_sql(EngineKind::Postgres, "select 1", true).unwrap(),
            "EXPLAIN (FORMAT JSON, VERBOSE, ANALYZE, BUFFERS) select 1"
        );
        assert_eq!(
            explain_sql(EngineKind::Sqlite, "select 1", true).unwrap(),
            "EXPLAIN QUERY PLAN select 1"
        );
        assert!(explain_sql(EngineKind::Postgres, "explain select 1", false).is_err());
        assert!(explain_sql(EngineKind::Postgres, " ; ", false).is_err());
    }

    #[test]
    fn timed_plan_has_own_times_misses_and_the_slowest_step() {
        let plan = parse_pg(&slow_lookup()).unwrap();
        assert!(plan.timed);
        assert_eq!(plan.steps.len(), 4);
        assert_eq!(plan.rows, Some(312.0));
        assert_eq!(plan.execution_ms, Some(1842.6));
        let kinds: Vec<(&str, usize)> = plan
            .steps
            .iter()
            .map(|s| (s.kind.as_str(), s.depth))
            .collect();
        assert_eq!(
            kinds,
            [
                ("Sort", 0),
                ("Nested Loop", 1),
                ("Seq Scan", 2),
                ("Index Scan", 2)
            ]
        );
        assert_eq!(plan.steps[0].note.as_deref(), Some("by o.placed_at DESC"));
        // Own time: the loop's 1838 ms minus the scans under it (1771 + 0.21 × 312).
        let own = plan.steps[1].own_ms.unwrap();
        assert!((own - (1838.0 - 1771.0 - 65.52)).abs() < 0.01, "{own}");
        assert_eq!(plan.slowest, Some(2));
        assert!(plan.steps[2].miss.unwrap() > 34.0);
        assert_eq!(plan.steps[3].miss, None);
        let scan = &plan.steps[2];
        assert_eq!(
            detail(scan, "Filter"),
            Some("(o.customer_id = 4012) AND ((o.status)::text = 'paid'::text)")
        );
        assert_eq!(detail(scan, "Removed"), Some("2,104,388 rows"));
        assert_eq!(detail(scan, "Read"), Some("27,410 pages, 61% from disk"));
    }

    #[test]
    fn missing_index_is_the_hint_and_names_the_column() {
        let mut plan = parse_pg(&slow_lookup()).unwrap();
        add_hint(&mut plan, EngineKind::Postgres, &orders_facts(vec![pkey()]));
        let hint = plan.hint.unwrap();
        assert_eq!(
            hint.text,
            "Seq scan on orders reads 2.1M rows to keep 312. orders.customer_id has no index."
        );
        assert_eq!(
            hint.sql.as_deref(),
            Some("CREATE INDEX ON public.orders (customer_id);")
        );
        assert_eq!(hint.step, Some(2));
    }

    #[test]
    fn with_the_index_in_place_stale_statistics_come_next() {
        let mut plan = parse_pg(&slow_lookup()).unwrap();
        let facts = orders_facts(vec![
            pkey(),
            IndexFacts {
                name: "orders_customer_id_idx".into(),
                columns: vec!["customer_id".into()],
            },
            IndexFacts {
                name: "orders_status_idx".into(),
                columns: vec!["status".into()],
            },
        ]);
        add_hint(&mut plan, EngineKind::Postgres, &facts);
        // 9 vs 312 is off by 35× but under 1,000 rows: not stale enough.
        assert_eq!(plan.hint, None);

        let mut big = slow_lookup();
        big[0]["Plan"]["Plans"][0]["Plans"][0]["Actual Rows"] = json!(48200.0);
        let mut plan = parse_pg(&big).unwrap();
        add_hint(&mut plan, EngineKind::Postgres, &facts);
        let hint = plan.hint.unwrap();
        assert_eq!(
            hint.text,
            "Postgres expected 9 rows from orders and got 48,200. Its statistics may be out of date."
        );
        assert_eq!(hint.sql.as_deref(), Some("ANALYZE public.orders;"));
    }

    #[test]
    fn estimate_uses_the_table_size_and_cost() {
        let mut est = slow_lookup();
        fn strip(n: &mut Json) {
            if let Some(o) = n.as_object_mut() {
                o.retain(|k, _| {
                    !k.starts_with("Actual")
                        && !k.starts_with("Rows Removed")
                        && !k.starts_with("Shared")
                });
                if let Some(Json::Array(kids)) = o.get_mut("Plans") {
                    kids.iter_mut().for_each(strip);
                }
            }
        }
        strip(&mut est[0]["Plan"]);
        est[0].as_object_mut().unwrap().remove("Execution Time");
        let mut plan = parse_pg(&est).unwrap();
        assert!(!plan.timed);
        assert_eq!(plan.slowest, Some(2));
        assert!(plan
            .steps
            .iter()
            .all(|s| s.own_ms.is_none() && s.miss.is_none()));
        add_hint(&mut plan, EngineKind::Postgres, &orders_facts(vec![pkey()]));
        assert_eq!(
            plan.hint.unwrap().text,
            "Seq scan on orders reads about 2.1M rows to keep about 9. orders.customer_id has no index."
        );
    }

    #[test]
    fn small_tables_and_small_steps_get_no_hint() {
        let mut plan = parse_pg(&slow_lookup()).unwrap();
        let mut facts = orders_facts(vec![pkey()]);
        add_hint(&mut plan, EngineKind::Postgres, &PlanFacts::default());
        assert_eq!(plan.hint, None, "no facts, no index advice");
        facts.tables[0].rows = Some(5_000.0);
        let mut small = slow_lookup();
        small[0]["Plan"]["Plans"][0]["Plans"][0]["Rows Removed by Filter"] = json!(4000.0);
        let mut plan = parse_pg(&small).unwrap();
        add_hint(&mut plan, EngineKind::Postgres, &facts);
        assert_eq!(plan.hint, None);
    }

    #[test]
    fn spills_to_disk() {
        let plan_json = json!([{ "Plan": {
            "Node Type": "Sort", "Plan Rows": 1000000.0, "Total Cost": 900.0,
            "Actual Total Time": 900.0, "Actual Rows": 1000000.0, "Actual Loops": 1.0,
            "Sort Key": ["e.created_at"], "Sort Method": "external merge",
            "Sort Space Used": 188416.0, "Sort Space Type": "Disk",
            "Plans": [{ "Node Type": "Seq Scan", "Relation Name": "events", "Schema": "public",
                "Alias": "e", "Plan Rows": 1000000.0, "Total Cost": 100.0,
                "Actual Total Time": 100.0, "Actual Rows": 1000000.0, "Actual Loops": 1.0 }]
        }}]);
        let mut plan = parse_pg(&plan_json).unwrap();
        add_hint(&mut plan, EngineKind::Postgres, &PlanFacts::default());
        let hint = plan.hint.unwrap();
        assert_eq!(
            hint.text,
            "The sort wrote 184 MB to disk. A larger work_mem keeps it in memory."
        );
        assert_eq!(hint.sql.as_deref(), Some("SET work_mem = '1GB';"));

        let hash = json!([{ "Plan": {
            "Node Type": "Hash Join", "Join Type": "Inner", "Plan Rows": 10.0, "Total Cost": 10.0,
            "Actual Total Time": 500.0, "Actual Rows": 10.0, "Actual Loops": 1.0,
            "Plans": [{ "Node Type": "Hash", "Plan Rows": 10.0, "Total Cost": 5.0,
                "Actual Total Time": 400.0, "Actual Rows": 10.0, "Actual Loops": 1.0,
                "Hash Batches": 16.0, "Peak Memory Usage": 4100.0 }]
        }}]);
        let mut plan = parse_pg(&hash).unwrap();
        add_hint(&mut plan, EngineKind::Postgres, &PlanFacts::default());
        assert_eq!(
            plan.hint.unwrap().text,
            "The hash join split into 16 batches on disk. A larger work_mem keeps it in one."
        );
    }

    #[test]
    fn repeated_scan_and_wrapped_column() {
        let loops = json!([{ "Plan": {
            "Node Type": "Nested Loop", "Join Type": "Inner", "Plan Rows": 300.0, "Total Cost": 9000.0,
            "Actual Total Time": 900.0, "Actual Rows": 312.0, "Actual Loops": 1.0,
            "Plans": [
                { "Node Type": "Index Scan", "Relation Name": "orders", "Schema": "public", "Alias": "o",
                  "Index Name": "orders_pkey", "Plan Rows": 300.0, "Total Cost": 10.0,
                  "Actual Total Time": 1.0, "Actual Rows": 312.0, "Actual Loops": 1.0 },
                { "Node Type": "Seq Scan", "Relation Name": "customers", "Schema": "public", "Alias": "c",
                  "Plan Rows": 1.0, "Total Cost": 30.0, "Actual Total Time": 2.8,
                  "Actual Rows": 1.0, "Actual Loops": 312.0,
                  "Filter": "(c.code = o.customer_code)", "Rows Removed by Filter": 900.0 }
            ]
        }}]);
        let facts = PlanFacts {
            tables: vec![TableFacts {
                schema: Some("public".into()),
                table: "customers".into(),
                rows: Some(901.0),
                indexes: vec![],
            }],
        };
        let mut plan = parse_pg(&loops).unwrap();
        add_hint(&mut plan, EngineKind::Postgres, &facts);
        let hint = plan.hint.unwrap();
        assert_eq!(
            hint.text,
            "customers is scanned in full 312 times, once per row from the other side of the join. customers.code has no index."
        );
        assert_eq!(
            hint.sql.as_deref(),
            Some("CREATE INDEX ON public.customers (code);")
        );

        let wrapped = json!([{ "Plan": {
            "Node Type": "Seq Scan", "Relation Name": "customers", "Schema": "public", "Alias": "customers",
            "Plan Rows": 3.0, "Total Cost": 1500.0, "Actual Total Time": 40.0,
            "Actual Rows": 1.0, "Actual Loops": 1.0,
            "Filter": "(lower((customers.email)::text) = 'mara@x.se'::text)",
            "Rows Removed by Filter": 60999.0 }}]);
        let facts = PlanFacts {
            tables: vec![TableFacts {
                schema: Some("public".into()),
                table: "customers".into(),
                rows: Some(61000.0),
                indexes: vec![IndexFacts {
                    name: "customers_email_idx".into(),
                    columns: vec!["email".into()],
                }],
            }],
        };
        let mut plan = parse_pg(&wrapped).unwrap();
        add_hint(&mut plan, EngineKind::Postgres, &facts);
        let hint = plan.hint.unwrap();
        assert_eq!(
            hint.text,
            "lower(email) can't use customers_email_idx. Index lower(email), or compare email directly."
        );
        assert_eq!(
            hint.sql.as_deref(),
            Some("CREATE INDEX ON public.customers (lower(email));")
        );
    }

    #[test]
    fn filter_columns_reads_verbose_conditions() {
        let refs = filter_columns(
            "((o.customer_id = 4012) AND ((o.status)::text = 'o.fake'::text) AND (lower(o.\"Email\") = 'x') AND (c.id = 1))",
            "o",
        );
        assert_eq!(
            refs,
            [
                ColumnRef {
                    column: "customer_id".into(),
                    wrapped: None
                },
                ColumnRef {
                    column: "status".into(),
                    wrapped: None
                },
                ColumnRef {
                    column: "Email".into(),
                    wrapped: Some("lower".into())
                },
            ]
        );
    }

    #[test]
    fn parallel_steps_count_wall_time_once() {
        let par = json!([{ "Plan": {
            "Node Type": "Gather", "Plan Rows": 10.0, "Total Cost": 100.0, "Workers Launched": 2,
            "Actual Total Time": 300.0, "Actual Rows": 10.0, "Actual Loops": 1.0,
            "Plans": [{ "Node Type": "Seq Scan", "Parallel Aware": true, "Relation Name": "events",
                "Plan Rows": 3.0, "Total Cost": 90.0, "Actual Total Time": 290.0,
                "Actual Rows": 3.0, "Actual Loops": 3.0 }]
        }}]);
        let plan = parse_pg(&par).unwrap();
        assert_eq!(plan.steps[1].kind, "Parallel Seq Scan");
        assert_eq!(plan.steps[1].own_ms, Some(290.0));
        assert_eq!(plan.steps[0].own_ms, Some(10.0));
    }

    #[test]
    fn sqlite_plan_tree_and_hints() {
        let rows = vec![
            (2, 0, "SCAN orders".to_string()),
            (
                5,
                0,
                "SEARCH customers USING INTEGER PRIMARY KEY (rowid=?)".to_string(),
            ),
            (9, 0, "USE TEMP B-TREE FOR ORDER BY".to_string()),
        ];
        let mut plan = parse_sqlite(&rows);
        assert_eq!(plan.steps.len(), 3);
        assert_eq!(plan.steps[0].kind, "Scan");
        assert_eq!(plan.steps[0].table.as_deref(), Some("orders"));
        assert_eq!(plan.steps[1].index.as_deref(), Some("primary key"));
        assert_eq!(detail(&plan.steps[1], "Index Cond"), Some("rowid=?"));
        assert_eq!(plan.steps[2].note.as_deref(), Some("for order by"));
        let mut facts = orders_facts(vec![]);
        facts.tables[0].schema = None;
        add_hint(&mut plan, EngineKind::Sqlite, &facts);
        assert_eq!(
            plan.hint.as_ref().unwrap().text,
            "SQLite reads every row of orders (over 2.1M). If you filter or join on one of its columns, an index on it lets SQLite go straight to the rows."
        );
        facts.tables[0].rows = Some(50.0);
        add_hint(&mut plan, EngineKind::Sqlite, &facts);
        assert_eq!(plan.hint.unwrap().step, Some(2));

        let nested = vec![
            (1, 0, "CO-ROUTINE t".to_string()),
            (
                3,
                1,
                "SCAN orders USING COVERING INDEX orders_status".to_string(),
            ),
            (7, 0, "SCAN t".to_string()),
        ];
        let plan = parse_sqlite(&nested);
        let shape: Vec<(usize, &str)> = plan
            .steps
            .iter()
            .map(|s| (s.depth, s.kind.as_str()))
            .collect();
        assert_eq!(shape, [(0, "CO-ROUTINE t"), (1, "Scan"), (0, "Scan")]);
        assert_eq!(plan.steps[1].index.as_deref(), Some("orders_status"));
    }

    #[test]
    fn counts_read_like_people_write_them() {
        assert_eq!(count(312.0), "312");
        assert_eq!(count(48200.0), "48,200");
        assert_eq!(count(2_104_700.0), "2.1M");
        assert_eq!(count(312_000_000.0), "312M");
        assert_eq!(parse_count("2,104,388"), Some(2_104_388.0));
    }

    /// MySQL 8.0's `EXPLAIN ANALYZE` of a join, as the server sent it.
    const MYSQL_ANALYZE: &str = "-> Nested loop inner join  (cost=1.6 rows=3) (actual time=0.0556..0.0622 rows=3 loops=1)\n    -> Filter: (pl_b.a is not null)  (cost=0.55 rows=3) (actual time=0.011..0.0142 rows=3 loops=1)\n        -> Index scan on pl_b using PRIMARY  (cost=0.55 rows=3) (actual time=0.0097..0.0126 rows=3 loops=1)\n    -> Filter: (pl_a.n > 0)  (cost=0.283 rows=1) (actual time=0.00336..0.0035 rows=1 loops=3)\n        -> Single-row index lookup on pl_a using PRIMARY (id=pl_b.a)  (cost=0.283 rows=1) (actual time=0.00261..0.00265 rows=1 loops=3)\n";

    #[test]
    fn mysql_trees_read_as_steps_with_their_own_share() {
        let plan = parse_mysql(MYSQL_ANALYZE, true).unwrap();
        let kinds: Vec<(usize, &str)> = plan
            .steps
            .iter()
            .map(|s| (s.depth, s.kind.as_str()))
            .collect();
        assert_eq!(
            kinds,
            [
                (0, "Nested loop inner join"),
                (1, "Filter"),
                (2, "Index scan"),
                (1, "Filter"),
                (2, "Single-row index lookup"),
            ]
        );
        let lookup = &plan.steps[4];
        assert_eq!(
            (lookup.table.as_deref(), lookup.index.as_deref()),
            (Some("pl_a"), Some("PRIMARY"))
        );
        assert_eq!(lookup.details[0].value, "id=pl_b.a");
        assert_eq!((lookup.actual_rows, lookup.loops), (Some(1.0), Some(3.0)));
        // Times are per loop and include the children: own = all loops
        // less the children's.
        assert!((lookup.own_ms.unwrap() - 0.00795).abs() < 1e-9);
        let filter = &plan.steps[3];
        assert!((filter.own_ms.unwrap() - (0.0105 - 0.00795)).abs() < 1e-9);
        assert_eq!(plan.steps[1].details[0].value, "(pl_b.a is not null)");
        assert_eq!(plan.execution_ms, Some(0.0622));
        assert_eq!(plan.rows, Some(3.0));
        assert!(plan.slowest.is_some());
        // An estimate: costs, no times.
        let estimate = MYSQL_ANALYZE
            .lines()
            .map(|l| l.split(" (actual").next().unwrap())
            .collect::<Vec<_>>()
            .join("\n");
        let plan = parse_mysql(&estimate, false).unwrap();
        assert!(plan
            .steps
            .iter()
            .all(|s| s.own_ms.is_none() && s.actual_rows.is_none()));
        assert!((plan.steps[0].own_cost.unwrap() - (1.6 - 0.55 - 0.283)).abs() < 1e-9);
        assert_eq!(
            parse_mysql("<not executable by iterator executor>\n", false).unwrap_err(),
            "MySQL has no plan to show for this statement."
        );
    }

    #[test]
    fn mysql_json_estimates_read_as_steps() {
        let json = r#"{"query_block":{"select_id":1,"cost_info":{"query_cost":"2.45"},"ordering_operation":{"using_filesort":true,"nested_loop":[{"table":{"table_name":"a","access_type":"ALL","rows_examined_per_scan":4,"cost_info":{"read_cost":"0.52","eval_cost":"0.13","prefix_cost":"0.65"},"used_columns":["id","n"],"attached_condition":"(`a`.`n` > 1)"}},{"table":{"table_name":"b","access_type":"eq_ref","key":"PRIMARY","ref":["rowkery.a.n"],"rows_examined_per_scan":1,"cost_info":{"read_cost":"0.33","eval_cost":"0.13"}}}]}}}"#;
        let plan = parse_mysql(json, false).unwrap();
        let kinds: Vec<_> = plan
            .steps
            .iter()
            .map(|s| (s.depth, s.kind.as_str(), s.table.as_deref()))
            .collect();
        assert_eq!(
            kinds,
            [
                (0, "Sort", None),
                (1, "Table scan", Some("a")),
                (1, "Index lookup", Some("b"))
            ]
        );
        assert_eq!(plan.steps[1].expected_rows, Some(4.0));
        assert!((plan.steps[1].own_cost.unwrap() - 0.65).abs() < 1e-9);
        assert_eq!(plan.steps[2].index.as_deref(), Some("PRIMARY"));
        assert_eq!(plan.slowest, Some(1));
        // An ORDER BY an index has no sort step.
        let json = r#"{"query_block":{"ordering_operation":{"using_filesort":false,"table":{"table_name":"a","access_type":"index","key":"PRIMARY","rows_examined_per_scan":4}}}}"#;
        let plan = parse_mysql(json, false).unwrap();
        assert_eq!(plan.steps.len(), 1);
        assert_eq!(plan.steps[0].kind, "Index scan");
    }

    #[test]
    fn mariadb_json_reads_as_steps() {
        let json = r#"{"query_optimization":{"r_total_time_ms":0.2},"query_block":{"select_id":1,"r_loops":1,"r_total_time_ms":0.11,"filesort":{"sort_key":"pl_a.n desc","r_loops":1,"temporary_table":{"nested_loop":[{"table":{"table_name":"pl_b","access_type":"ALL","r_loops":1,"rows":3,"r_rows":3,"r_table_time_ms":0.02,"r_other_time_ms":0.01,"r_engine_stats":{"pages_accessed":1},"filtered":100,"attached_condition":"pl_b.a is not null"}},{"table":{"table_name":"pl_a","access_type":"eq_ref","possible_keys":["PRIMARY","n"],"key":"PRIMARY","ref":["rowkery.pl_b.a"],"r_loops":3,"rows":1,"r_rows":1,"r_table_time_ms":0.03,"r_other_time_ms":0.01}}]}}}}"#;
        let plan = parse_mysql(json, true).unwrap();
        let kinds: Vec<(usize, &str)> = plan
            .steps
            .iter()
            .map(|s| (s.depth, s.kind.as_str()))
            .collect();
        assert_eq!(
            kinds,
            [
                (0, "Sort"),
                (1, "Temporary table"),
                (2, "Table scan"),
                (2, "Index lookup")
            ]
        );
        assert_eq!(plan.steps[0].note.as_deref(), Some("by pl_a.n desc"));
        let scan = &plan.steps[2];
        assert_eq!(scan.table.as_deref(), Some("pl_b"));
        assert_eq!(scan.details[0].value, "pl_b.a is not null");
        assert!((scan.own_ms.unwrap() - 0.03).abs() < 1e-9);
        assert_eq!(plan.slowest, Some(3));
        assert_eq!(
            (plan.execution_ms, plan.planning_ms),
            (Some(0.11), Some(0.2))
        );
        assert_eq!(
            mysql_explain_sql(true, "SELECT 1;", true).unwrap(),
            "ANALYZE FORMAT=JSON SELECT 1"
        );
        assert_eq!(
            mysql_explain_sql(false, "SELECT 1", false).unwrap(),
            "EXPLAIN FORMAT=JSON SELECT 1"
        );
        assert!(mysql_explain_sql(true, "analyze format=json select 1", false).is_err());
    }
}
