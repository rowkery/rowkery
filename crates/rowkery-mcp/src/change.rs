//! What makes a proposed change acceptable, before it is queued and again
//! before the app previews or commits it: plain INSERT / UPDATE / DELETE
//! statements (`safety::row_changes`) on shared tables, on a connection
//! that isn't Read-only, calling only the built-in functions agents may
//! call (`functions`) and never naming a masked column. Postgres plans each statement (EXPLAIN
//! without ANALYZE, which runs nothing, on the read-only session); SQLite's
//! authorizer reports what each one touches while it is prepared.

use std::collections::HashSet;

use rowkery_core::connections::ConnectionRecord;
use rowkery_core::safety::{self, RowChange, SafeMode};
use serde_json::Value as Json;

use crate::access;
use crate::functions;
use crate::guard;
use crate::mask;
use crate::target::{Store, Target};

/// The checked statements of `sql`, or why the change is refused.
pub async fn check(
    store: &mut Store,
    target: &Target,
    sql: &str,
) -> Result<Vec<RowChange>, String> {
    if target.record.safe_mode() == SafeMode::ReadOnly {
        return Err(format!(
            "Refused: {} is Read-only in Rowkery, so it takes no changes, proposed or not.",
            target.record.display_name()
        ));
    }
    let changes = safety::row_changes(sql)?;
    let marks = mask::parse(target.record.masked_columns(&target.database));
    match &target.record {
        ConnectionRecord::Postgres(_) => {
            for change in &changes {
                // The statement as sent, before the planner evaluates any of
                // it; then the plan, views and SQL functions expanded.
                functions::check_pg(store, target, &functions::scan_sql(&change.sql), true).await?;
                let explain = store
                    .read(
                        target,
                        &format!("EXPLAIN (FORMAT JSON, VERBOSE) {}", change.sql),
                    )
                    .await?;
                let text = match explain.rows.first().and_then(|r| r.first()) {
                    Some(rowkery_core::Value::Text(t)) => t.clone(),
                    _ => return Err("EXPLAIN returned no plan.".into()),
                };
                let plan: Json = serde_json::from_str(&text).map_err(|e| e.to_string())?;
                functions::check_pg(store, target, &functions::scan_plan(&plan), false).await?;
                let touched = guard::pg_relations(&plan);
                refuse_unshared(store, target, &touched).await?;
                masked_mention(store, target, &marks, &touched, change, &text).await?;
            }
        }
        ConnectionRecord::Sqlite(c) => {
            for change in &changes {
                let facts = sqlite_facts(&c.path, &change.sql)?;
                let touched: Vec<(Option<String>, String)> = facts
                    .tables
                    .iter()
                    .map(|(s, t)| (Some(s.clone()), t.clone()))
                    .collect();
                refuse_unshared(store, target, &touched).await?;
                for m in marks
                    .iter()
                    .filter(|m| m.schema.eq_ignore_ascii_case("main"))
                {
                    let key = (m.table.to_lowercase(), m.column.to_lowercase());
                    if facts.columns.contains(&key) {
                        return Err(masked_refusal(m));
                    }
                }
                masked_mention(store, target, &marks, &touched, change, "").await?;
            }
        }
    }
    Ok(changes)
}

fn masked_refusal(m: &mask::Marked) -> String {
    format!(
        "Refused: {} is masked, and a proposed change can't read, write or filter on a masked column.",
        m.label()
    )
}

/// Every relation a statement touches must be shared (statistics never are).
async fn refuse_unshared(
    store: &mut Store,
    target: &Target,
    touched: &[(Option<String>, String)],
) -> Result<(), String> {
    let rule =
        access::tables(&target.record, &target.database).unwrap_or(access::Tables::Only(&[]));
    let statistics = touched
        .iter()
        .any(|(s, t)| guard::is_statistics(s.as_deref(), t));
    if statistics {
        return Err(guard::HIDDEN_REFUSAL.into());
    }
    if !rule.restricts() {
        return Ok(());
    }
    let cached = store.catalog(target, false).await?;
    let catalog = &cached.catalog;
    let default = match target.record {
        ConnectionRecord::Postgres(_) => "public",
        ConnectionRecord::Sqlite(_) => "main",
    };
    let blocked = touched.iter().any(|(schema, table)| {
        let schema = schema.as_deref().unwrap_or(default);
        match access::find_exact(catalog, schema, table) {
            Some(t) => !rule.allows_node(catalog, schema, t),
            None => !rule.allows(schema, table),
        }
    });
    if blocked {
        return Err(guard::HIDDEN_REFUSAL.into());
    }
    Ok(())
}

/// A masked column of a table the statement touches may not appear in it
/// at all: not in the SQL, and not in the plan (a view or `SELECT *` that
/// copies it into another table names it there), and no whole row of it.
async fn masked_mention(
    store: &mut Store,
    target: &Target,
    marks: &[mask::Marked],
    touched: &[(Option<String>, String)],
    change: &RowChange,
    plan_text: &str,
) -> Result<(), String> {
    if marks.is_empty() {
        return Ok(());
    }
    let cached = store.catalog(target, false).await?;
    let catalog = &cached.catalog;
    let default = match target.record {
        ConnectionRecord::Postgres(_) => "public",
        ConnectionRecord::Sqlite(_) => "main",
    };
    // A partition counts as its parent table.
    let root = |schema: &str, rel: &str| {
        let mut name = rel.to_string();
        for _ in 0..8 {
            match access::find_exact(catalog, schema, &name).and_then(|t| t.partition_of.clone()) {
                Some(p) => name = p,
                None => break,
            }
        }
        name
    };
    let named = safety::identifiers(&change.sql);
    let plan_words = words(plan_text);
    for m in marks {
        let touches = touched.iter().any(|(s, t)| {
            let schema = s.as_deref().unwrap_or(default);
            schema.eq_ignore_ascii_case(&m.schema) && root(schema, t).eq_ignore_ascii_case(&m.table)
        });
        let column = m.column.to_lowercase();
        // `c::text`, `row_to_json(c)`: a whole row carries every column
        // (the plan writes it `c.*`).
        let whole_row = plan_text.contains(".*");
        if touches && (named.contains(&column) || plan_words.contains(&column) || whole_row) {
            return Err(masked_refusal(m));
        }
    }
    Ok(())
}

/// The identifier-like words of a plan's text, lower-cased.
fn words(text: &str) -> HashSet<String> {
    text.split(|c: char| !(c.is_alphanumeric() || c == '_' || c == '$'))
        .filter(|w| !w.is_empty())
        .map(str::to_lowercase)
        .collect()
}

/// What one SQLite statement touches, from the authorizer while it is
/// prepared (nothing runs): tables read or written, and the columns read or
/// updated, as (table, column) lower-cased.
pub struct SqliteFacts {
    pub tables: Vec<(String, String)>,
    pub columns: HashSet<(String, String)>,
}

pub fn sqlite_facts(path: &str, sql: &str) -> Result<SqliteFacts, String> {
    use rusqlite::hooks::{AuthAction, AuthContext, Authorization};
    use rusqlite::OpenFlags;
    use std::sync::{Arc, Mutex};

    let conn = rusqlite::Connection::open_with_flags(
        rowkery_core::connections::expand_home(path),
        OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX,
    )
    .map_err(|e| e.to_string())?;
    let facts = Arc::new(Mutex::new(SqliteFacts {
        tables: Vec::new(),
        columns: HashSet::new(),
    }));
    let sink = Arc::clone(&facts);
    conn.authorizer(Some(move |ctx: AuthContext<'_>| {
        let schema = ctx.database_name.unwrap_or("main").to_string();
        let (table, column) = match ctx.action {
            AuthAction::Read {
                table_name,
                column_name,
            }
            | AuthAction::Update {
                table_name,
                column_name,
            } => (table_name, Some(column_name)),
            AuthAction::Insert { table_name } | AuthAction::Delete { table_name } => {
                (table_name, None)
            }
            _ => return Authorization::Allow,
        };
        if let Ok(mut f) = sink.lock() {
            if !f.tables.iter().any(|(s, t)| *s == schema && t == table) {
                f.tables.push((schema, table.to_string()));
            }
            if let Some(column) = column {
                f.columns
                    .insert((table.to_lowercase(), column.to_lowercase()));
            }
        }
        Authorization::Allow
    }));
    conn.prepare(sql).map_err(|e| e.to_string())?;
    drop(conn);
    let facts = Arc::try_unwrap(facts)
        .map_err(|_| "authorizer still held".to_string())?
        .into_inner()
        .map_err(|e| e.to_string())?;
    Ok(facts)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sqlite_facts_name_tables_and_columns_written_or_read() {
        let dir = std::env::temp_dir().join(format!("rowkery-change-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("t.sqlite");
        let _ = std::fs::remove_file(&path);
        let conn = rusqlite::Connection::open(&path).unwrap();
        conn.execute_batch(
            "CREATE TABLE c (id INTEGER PRIMARY KEY, email TEXT, plan TEXT);
             CREATE TABLE o (id INTEGER PRIMARY KEY, c_id INT, note TEXT);",
        )
        .unwrap();
        drop(conn);
        let p = path.to_string_lossy();
        let f = sqlite_facts(&p, "UPDATE c SET plan = 'pro' WHERE id = 1").unwrap();
        assert_eq!(f.tables, vec![("main".to_string(), "c".to_string())]);
        assert!(f.columns.contains(&("c".into(), "plan".into())));
        assert!(!f.columns.contains(&("c".into(), "email".into())));
        let f = sqlite_facts(
            &p,
            "UPDATE o SET note = (SELECT email FROM c WHERE c.id = o.c_id)",
        )
        .unwrap();
        assert!(f.columns.contains(&("c".into(), "email".into())));
        assert_eq!(f.tables.len(), 2);
        let f = sqlite_facts(&p, "DELETE FROM o WHERE id = 3").unwrap();
        assert!(f.tables.contains(&("main".to_string(), "o".to_string())));
    }

    #[test]
    fn plan_words_split_qualified_names() {
        let w = words(r#"[{"Output": ["c.email", "(lower(c.plan))"]}]"#);
        assert!(w.contains("email") && w.contains("plan") && !w.contains("c.email"));
    }
}
