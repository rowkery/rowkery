//! Every row a change writes, in every table: its own rows plus what
//! foreign-key cascades and triggers do elsewhere.
//!
//! Postgres: `pg_stat_xact_user_tables` counts the rows the open transaction
//! inserted, updated and deleted per table, cascades and trigger writes
//! included; reading it before and after a statement gives that statement's
//! rows. Partitions count under their parent. SQLite: the update hook names
//! the table of each row written, and `total_changes()` counts the ones it
//! skips (WITHOUT ROWID tables), which show as rows Rowkery can't name.

use std::collections::{BTreeMap, HashMap};
use std::sync::{Arc, Mutex};

use serde::{Deserialize, Serialize};

use crate::db::postgres::{session_query_stream, PostgresSession};
use crate::db::Value;

/// Rows one change wrote in one table.
#[derive(Clone, Debug, Default, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
pub struct TableRows {
    /// The schema (Postgres) or database (`main`, an attached one: SQLite).
    pub schema: String,
    /// The table; a partition's rows count under the table it belongs to.
    pub table: String,
    pub inserted: u64,
    pub updated: u64,
    pub deleted: u64,
}

impl TableRows {
    pub fn total(&self) -> u64 {
        self.inserted + self.updated + self.deleted
    }
}

/// What one statement (or the commit's deferred triggers) wrote.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct Reach {
    /// Sorted by schema and table, so two reaches compare as written.
    pub tables: Vec<TableRows>,
    /// Rows no table could be named for (SQLite's WITHOUT ROWID tables).
    #[serde(default)]
    pub unnamed: u64,
}

impl Reach {
    pub fn total(&self) -> u64 {
        self.tables.iter().map(TableRows::total).sum::<u64>() + self.unnamed
    }

    pub fn is_empty(&self) -> bool {
        self.total() == 0
    }
}

/// Per-table counters as read at one moment.
pub type Counts = HashMap<(String, String), [u64; 3]>;

/// `after - before`, the tables that changed, sorted.
pub fn diff(before: &Counts, after: &Counts) -> Vec<TableRows> {
    let mut out: Vec<TableRows> = after
        .iter()
        .filter_map(|(name, now)| {
            let was = before.get(name).copied().unwrap_or_default();
            let d = |i: usize| now[i].saturating_sub(was[i]);
            let rows = TableRows {
                schema: name.0.clone(),
                table: name.1.clone(),
                inserted: d(0),
                updated: d(1),
                deleted: d(2),
            };
            (rows.total() > 0).then_some(rows)
        })
        .collect();
    out.sort();
    out
}

/// The rows this transaction has written so far, per table, partitions under
/// their top parent (`INHERITS` children keep their own name). None when the
/// server keeps no counts (`track_counts` off).
pub async fn pg_counts(session: &PostgresSession) -> Result<Option<Counts>, String> {
    const SQL: &str = "WITH RECURSIVE s AS (\
           SELECT relid, n_tup_ins AS i, n_tup_upd AS u, n_tup_del AS d FROM pg_stat_xact_user_tables \
           WHERE n_tup_ins + n_tup_upd + n_tup_del > 0), \
         up(relid, top) AS (SELECT relid, relid FROM s \
           UNION ALL SELECT up.relid, h.inhparent FROM up \
           JOIN pg_class c ON c.oid = up.top AND c.relispartition \
           JOIN pg_inherits h ON h.inhrelid = up.top) \
         SELECT n.nspname::text, c.relname::text, sum(s.i)::int8, sum(s.u)::int8, sum(s.d)::int8 \
         FROM s JOIN up ON up.relid = s.relid JOIN pg_class c ON c.oid = up.top \
         JOIN pg_namespace n ON n.oid = c.relnamespace \
         WHERE NOT c.relispartition AND current_setting('track_counts')::bool \
         GROUP BY 1, 2 \
         UNION ALL SELECT '', '', 0, 0, 0 WHERE NOT current_setting('track_counts')::bool";
    let mut rows: Vec<Vec<Value>> = Vec::new();
    session_query_stream(session, SQL, |batch, _| {
        rows.extend(batch.rows);
        Ok(())
    })
    .await
    .map_err(|e| e.into_message())?;
    let text = |v: Option<&Value>| match v {
        Some(Value::Text(t)) => t.clone(),
        _ => String::new(),
    };
    let int = |v: Option<&Value>| match v {
        Some(Value::Int(n)) => (*n).max(0) as u64,
        _ => 0,
    };
    let mut out = Counts::new();
    for r in &rows {
        let (schema, table) = (text(r.first()), text(r.get(1)));
        if table.is_empty() {
            return Ok(None);
        }
        out.insert(
            (schema, table),
            [int(r.get(2)), int(r.get(3)), int(r.get(4))],
        );
    }
    Ok(Some(out))
}

type Tally = Arc<Mutex<BTreeMap<(String, String), [u64; 3]>>>;

/// What a batch wrote beyond its own statements' rows (`own`: inserted,
/// updated, deleted in `schema.table`): every other table, and in its own
/// table what a trigger or a self-referencing cascade added. Own rows the
/// hook couldn't name (a WITHOUT ROWID table) come off the unnamed ones.
pub fn beyond(reach: Reach, schema: &str, table: &str, own: [u64; 3]) -> Reach {
    let mut left = own;
    let mut tables = reach.tables;
    for t in tables
        .iter_mut()
        .filter(|t| t.schema == schema && t.table == table)
    {
        for (n, l) in [&mut t.inserted, &mut t.updated, &mut t.deleted]
            .into_iter()
            .zip(left.iter_mut())
        {
            let take = (*n).min(*l);
            *n -= take;
            *l -= take;
        }
    }
    tables.retain(|t| t.total() > 0);
    Reach {
        tables,
        unnamed: reach.unnamed.saturating_sub(left.iter().sum()),
    }
}

/// Whether writing `target` (a `regclass` literal) can write rows anywhere
/// else, and if so the table its own rows count under (its top parent, for a
/// partition). It can when it, or a table it's a partition of, has a user
/// trigger or rule, or a foreign key cascades into it (or sets NULL or the
/// default), or it is partitioned. A table with none of these is never
/// counted, which spares the two reads of every table's counters.
pub async fn pg_reaches(
    session: &PostgresSession,
    target: &str,
) -> Result<Option<(String, String)>, String> {
    let sql = format!(
        "WITH RECURSIVE up(oid) AS (SELECT {target}::regclass::oid \
           UNION ALL SELECT h.inhparent FROM up JOIN pg_class c ON c.oid = up.oid AND c.relispartition \
           JOIN pg_inherits h ON h.inhrelid = up.oid) \
         SELECT n.nspname::text, c.relname::text FROM up JOIN pg_class c ON c.oid = up.oid \
         JOIN pg_namespace n ON n.oid = c.relnamespace \
         WHERE NOT c.relispartition AND ( \
           EXISTS (SELECT 1 FROM up u JOIN pg_class k ON k.oid = u.oid WHERE k.relkind = 'p') \
           OR EXISTS (SELECT 1 FROM pg_trigger WHERE tgrelid IN (SELECT oid FROM up) AND NOT tgisinternal) \
           OR EXISTS (SELECT 1 FROM pg_rewrite WHERE ev_class IN (SELECT oid FROM up) AND rulename <> '_RETURN') \
           OR EXISTS (SELECT 1 FROM pg_constraint WHERE contype = 'f' AND confrelid IN (SELECT oid FROM up) \
             AND (confdeltype IN ('c', 'n', 'd') OR confupdtype IN ('c', 'n', 'd'))))"
    );
    let mut rows: Vec<Vec<Value>> = Vec::new();
    session_query_stream(session, &sql, |batch, _| {
        rows.extend(batch.rows);
        Ok(())
    })
    .await
    .map_err(|e| e.into_message())?;
    let text = |v: Option<&Value>| match v {
        Some(Value::Text(t)) => t.clone(),
        _ => String::new(),
    };
    Ok(rows.first().map(|r| (text(r.first()), text(r.get(1)))))
}

/// Counts SQLite's writes per table through the connection's update hook.
/// `mark` before a statement, `reach` after it.
pub struct SqliteCounter {
    seen: Tally,
    total: i64,
}

impl SqliteCounter {
    /// Hooks `conn`; the hook stays until the connection closes or another
    /// replaces it.
    pub fn install(conn: &rusqlite::Connection) -> Self {
        use rusqlite::hooks::Action;
        let seen = Tally::default();
        let hook = seen.clone();
        conn.update_hook(Some(
            move |action: Action, db: &str, table: &str, _rowid: i64| {
                let at = match action {
                    Action::SQLITE_INSERT => 0,
                    Action::SQLITE_UPDATE => 1,
                    Action::SQLITE_DELETE => 2,
                    _ => return,
                };
                if let Ok(mut seen) = hook.lock() {
                    seen.entry((db.to_string(), table.to_string())).or_default()[at] += 1;
                }
            },
        ));
        Self { seen, total: 0 }
    }

    /// Starts counting from here.
    pub fn mark(&mut self, conn: &rusqlite::Connection) -> rusqlite::Result<()> {
        if let Ok(mut seen) = self.seen.lock() {
            seen.clear();
        }
        self.total = total_changes(conn)?;
        Ok(())
    }

    /// What was written since `mark`.
    pub fn reach(&self, conn: &rusqlite::Connection) -> rusqlite::Result<Reach> {
        let changes = total_changes(conn)?.saturating_sub(self.total).max(0) as u64;
        let tables: Vec<TableRows> = self
            .seen
            .lock()
            .map(|seen| {
                seen.iter()
                    .map(|((schema, table), n)| TableRows {
                        schema: schema.clone(),
                        table: table.clone(),
                        inserted: n[0],
                        updated: n[1],
                        deleted: n[2],
                    })
                    .collect()
            })
            .unwrap_or_default();
        let named: u64 = tables.iter().map(TableRows::total).sum();
        Ok(Reach {
            tables,
            unnamed: changes.saturating_sub(named),
        })
    }
}

fn total_changes(conn: &rusqlite::Connection) -> rusqlite::Result<i64> {
    conn.query_row("SELECT total_changes()", [], |r| r.get(0))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn diff_keeps_only_tables_that_moved() {
        let name = |t: &str| ("public".to_string(), t.to_string());
        let before: Counts = [(name("a"), [1, 0, 0]), (name("b"), [2, 0, 0])].into();
        let after: Counts = [
            (name("a"), [1, 0, 0]),
            (name("b"), [2, 0, 5]),
            (name("c"), [3, 1, 0]),
        ]
        .into();
        let d = diff(&before, &after);
        assert_eq!(d.len(), 2);
        assert_eq!((d[0].table.as_str(), d[0].deleted), ("b", 5));
        assert_eq!(
            (d[1].table.as_str(), d[1].inserted, d[1].updated),
            ("c", 3, 1)
        );
    }

    #[test]
    fn beyond_takes_off_the_batch_own_rows() {
        let t = |table: &str, i, d| TableRows {
            schema: "public".into(),
            table: table.into(),
            inserted: i,
            updated: 0,
            deleted: d,
        };
        let reach = Reach {
            tables: vec![t("kiosks", 1, 2), t("payouts", 0, 37)],
            unnamed: 0,
        };
        let left = beyond(reach, "public", "kiosks", [0, 0, 1]);
        assert_eq!(left.tables, vec![t("kiosks", 1, 1), t("payouts", 0, 37)]);
        // Only its own rows: nothing beyond.
        let own = Reach {
            tables: vec![t("kiosks", 0, 1)],
            unnamed: 0,
        };
        assert!(beyond(own, "public", "kiosks", [0, 0, 1]).is_empty());
        // A WITHOUT ROWID table's own rows were never named.
        let unnamed = Reach {
            tables: Vec::new(),
            unnamed: 3,
        };
        assert_eq!(beyond(unnamed, "main", "tags", [0, 0, 1]).unnamed, 2);
    }

    #[test]
    fn sqlite_counts_cascades_triggers_and_without_rowid_rows() {
        let conn = rusqlite::Connection::open_in_memory().unwrap();
        conn.execute_batch(
            "PRAGMA foreign_keys = ON;
             CREATE TABLE customers(id INTEGER PRIMARY KEY);
             CREATE TABLE orders(id INTEGER PRIMARY KEY, c INTEGER REFERENCES customers ON DELETE CASCADE);
             CREATE TABLE tags(id INTEGER PRIMARY KEY, c INTEGER REFERENCES customers ON DELETE CASCADE) WITHOUT ROWID;
             CREATE TABLE audit(what TEXT);
             CREATE TRIGGER a AFTER DELETE ON orders BEGIN INSERT INTO audit VALUES ('gone'); END;
             INSERT INTO customers VALUES (1), (2);
             INSERT INTO orders VALUES (1, 1), (2, 1), (3, 2);
             INSERT INTO tags VALUES (1, 1), (2, 1), (3, 1);",
        )
        .unwrap();
        let mut counter = SqliteCounter::install(&conn);
        counter.mark(&conn).unwrap();
        conn.execute("DELETE FROM customers WHERE id = 1", [])
            .unwrap();
        let reach = counter.reach(&conn).unwrap();
        let named: Vec<(&str, u64, u64)> = reach
            .tables
            .iter()
            .map(|t| (t.table.as_str(), t.inserted, t.deleted))
            .collect();
        assert_eq!(
            named,
            [("audit", 2, 0), ("customers", 0, 1), ("orders", 0, 2)]
        );
        assert_eq!(reach.unnamed, 3);
        assert_eq!(reach.total(), 8);
        counter.mark(&conn).unwrap();
        assert!(counter.reach(&conn).unwrap().is_empty());
    }
}
