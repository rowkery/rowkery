//! Every row a change writes, in every table: its own rows plus what
//! foreign-key cascades and triggers do elsewhere.
//!
//! Postgres: `pg_stat_xact_user_tables` counts the rows the open transaction
//! inserted, updated and deleted per table, cascades and trigger writes
//! included; reading it before and after a statement gives that statement's
//! rows. Partitions count under their parent. SQLite: the update hook names
//! the table of each row written, and `total_changes()` counts the ones it
//! skips (WITHOUT ROWID tables), which show as rows Rowkery can't name.
//! MySQL keeps no such counters: [`my_reach`] follows the foreign keys a
//! batch cascades through, locking each level's rows before the next is
//! counted, so the counts are the rows the cascade will write.

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
    /// Writes that couldn't be counted (MySQL): `triggers on shop.orders`,
    /// `shop.categories cascading into itself`.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub uncounted: Vec<String>,
}

impl Reach {
    pub fn total(&self) -> u64 {
        self.tables.iter().map(TableRows::total).sum::<u64>() + self.unnamed
    }

    pub fn is_empty(&self) -> bool {
        self.total() == 0 && self.uncounted.is_empty()
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
        uncounted: reach.uncounted,
    }
}

/// Whether writing `target` (a `regclass` literal) can write rows anywhere
/// else, and if so the table its own rows count under (its top parent, for a
/// partition). It can when it, or a table it's a partition of, has a user
/// trigger or rule, or a foreign key cascades into it (or sets NULL or the
/// default), or it is partitioned or has inheritance children (whose own
/// triggers and keys a write through the parent reaches). A table with none of these is never
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
           EXISTS (SELECT 1 FROM up u JOIN pg_class k ON k.oid = u.oid WHERE k.relkind = 'p' OR k.relhassubclass) \
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
    /// Hooks `conn`; the caller removes the hook when it's done counting.
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
            uncounted: Vec::new(),
        })
    }
}

fn total_changes(conn: &rusqlite::Connection) -> rusqlite::Result<i64> {
    conn.query_row("SELECT total_changes()", [], |r| r.get(0))
}

/// A table, as `(schema, table)`.
pub type Name = (String, String);

/// What a MySQL foreign key does to its child's rows when the parent's go
/// or change.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum MyRule {
    Cascade,
    SetNull,
    /// RESTRICT, NO ACTION: never writes (it refuses).
    Refuse,
}

impl MyRule {
    pub fn parse(rule: &str) -> Self {
        match rule {
            "CASCADE" => MyRule::Cascade,
            "SET NULL" => MyRule::SetNull,
            _ => MyRule::Refuse,
        }
    }
}

/// One MySQL foreign key, its columns in order.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct MyForeignKey {
    pub child: Name,
    pub child_columns: Vec<String>,
    pub parent: Name,
    pub parent_columns: Vec<String>,
    pub on_delete: MyRule,
    pub on_update: MyRule,
}

/// How a cascade writes a table's rows.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum MyWrite {
    Delete,
    /// These columns change (set NULL, or to the parent's new key).
    Update(Vec<String>),
}

/// One table a batch's deletes cascade into: the rows `predicate` names,
/// as they are before the batch runs.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct MyStep {
    pub table: Name,
    pub write: MyWrite,
    pub predicate: String,
}

/// What a MySQL batch on one table writes elsewhere, as far as foreign keys
/// say: `steps` in order, parents before children, each to be counted (and
/// locked) in turn; and the tables it writes in ways that can't be counted.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct MyPlan {
    pub steps: Vec<MyStep>,
    pub uncounted: Vec<String>,
}

/// InnoDB stops a cascade deeper than this (`FK_MAX_CASCADE_DEL`).
const MY_MAX_DEPTH: usize = 15;
/// A predicate past this many bytes (many paths into one table) isn't sent.
const MY_MAX_PREDICATE: usize = 64 * 1024;

/// `schema.table`, as Reach names a table.
pub fn my_name(name: &Name) -> String {
    format!("{}.{}", name.0, name.1)
}

/// Plans [`MyPlan`] for a batch on `target`: `deleted`, the rows its
/// DELETEs name (their key predicates OR'ed), and `changed`, the columns
/// its UPDATEs set. `keys` must hold every key that cascades (or sets NULL)
/// from each table the walk can reach.
///
/// A table is counted only when the count is sure: reached by deletes, in
/// one way only (all deleted, or all the same columns set NULL), on no loop
/// back to itself or an earlier table, within InnoDB's depth. A key that
/// follows an UPDATE of the target's own key is never counted (whether the
/// value really changes is the server's to say). Each such table, and every
/// table past it, is named in `uncounted` instead.
pub fn my_plan(
    target: &Name,
    deleted: Option<&str>,
    changed: &[String],
    keys: &[MyForeignKey],
) -> MyPlan {
    // Every table an UPDATE of a followed key reaches, however far.
    let mut uncounted: Vec<Name> = Vec::new();
    let mut seen: Vec<(Name, MyWrite)> = vec![(target.clone(), MyWrite::Update(changed.to_vec()))];
    let mut at = 0;
    while at < seen.len() {
        let (table, how) = seen[at].clone();
        at += 1;
        for (key, child) in my_children(keys, &table, &how) {
            if !uncounted.contains(&key.child) {
                uncounted.push(key.child.clone());
            }
            if !seen.iter().any(|(t, w)| t == &key.child && *w == child) {
                seen.push((key.child.clone(), child));
            }
        }
    }
    let Some(deleted) = deleted else {
        return finish(Vec::new(), uncounted);
    };
    // The tables the deletes reach, how each is written, and the keys
    // between them. A table reached two ways is marked.
    let mut write: Vec<(Name, MyWrite)> = vec![(target.clone(), MyWrite::Delete)];
    let mut mixed: Vec<Name> = Vec::new();
    let mut edges: Vec<&MyForeignKey> = Vec::new();
    let mut at = 0;
    while at < write.len() {
        let (table, how) = write[at].clone();
        at += 1;
        for (key, child) in my_children(keys, &table, &how) {
            edges.push(key);
            // A second way in is walked too, so every table past it is named.
            let ways: Vec<&MyWrite> = write
                .iter()
                .filter(|(t, _)| t == &key.child)
                .map(|(_, w)| w)
                .collect();
            if !ways.contains(&&child) {
                if !ways.is_empty() && !mixed.contains(&key.child) {
                    mixed.push(key.child.clone());
                }
                write.push((key.child.clone(), child));
            }
        }
    }
    // Parents before children (Kahn); what is left is on a loop.
    let mut tables: Vec<&Name> = Vec::new();
    for (t, _) in &write {
        if !tables.contains(&t) {
            tables.push(t);
        }
    }
    let mut waiting: HashMap<&Name, usize> = tables.iter().map(|t| (*t, 0)).collect();
    for e in &edges {
        *waiting.get_mut(&e.child).expect("reached") += 1;
    }
    let mut order: Vec<&Name> = Vec::new();
    let mut ready: Vec<&Name> = tables.iter().copied().filter(|t| waiting[t] == 0).collect();
    while let Some(t) = ready.pop() {
        order.push(t);
        for e in edges.iter().filter(|e| &e.parent == t) {
            let n = waiting.get_mut(&e.child).expect("reached");
            *n -= 1;
            if *n == 0 {
                ready.push(&e.child);
            }
        }
    }
    let mut bad: Vec<Name> = tables
        .iter()
        .filter(|t| !order.contains(t))
        .map(|t| (*t).clone())
        .collect();
    bad.extend(mixed);
    // In order: a table is counted when every table into it is, within the
    // depth and the predicate's size.
    let mut depth: HashMap<&Name, usize> = HashMap::new();
    let mut predicate: HashMap<&Name, String> = HashMap::new();
    let mut steps = Vec::new();
    for t in order {
        if t == target {
            depth.insert(t, 0);
            predicate.insert(t, deleted.to_string());
            continue;
        }
        let into: Vec<&&MyForeignKey> = edges.iter().filter(|e| &e.child == t).collect();
        if bad.contains(t) || into.iter().any(|e| !predicate.contains_key(&e.parent)) {
            if !bad.contains(t) {
                bad.push(t.clone());
            }
            continue;
        }
        let deep = 1 + into.iter().map(|e| depth[&e.parent]).max().unwrap_or(0);
        let ors: Vec<String> = into
            .iter()
            .map(|e| {
                format!(
                    "{} IN (SELECT {} FROM {} WHERE {})",
                    my_columns(&e.child_columns),
                    my_select_list(&e.parent_columns),
                    my_table(&e.parent),
                    predicate[&e.parent]
                )
            })
            .collect();
        let text = if ors.len() == 1 {
            ors.into_iter().next().unwrap_or_default()
        } else {
            format!("({})", ors.join(" OR "))
        };
        if deep > MY_MAX_DEPTH || text.len() > MY_MAX_PREDICATE {
            bad.push(t.clone());
            continue;
        }
        depth.insert(t, deep);
        let how = write
            .iter()
            .find(|(n, _)| n == t)
            .map(|(_, w)| w.clone())
            .expect("reached");
        steps.push(MyStep {
            table: t.clone(),
            write: how,
            predicate: text.clone(),
        });
        predicate.insert(t, text);
    }
    // A loop back into the target: nothing past it is sure.
    if bad.contains(target) {
        steps.clear();
        bad = tables.iter().map(|t| (*t).clone()).collect();
    }
    for t in bad {
        if !uncounted.contains(&t) {
            uncounted.push(t);
        }
    }
    finish(steps, uncounted)
}

fn finish(steps: Vec<MyStep>, mut uncounted: Vec<Name>) -> MyPlan {
    uncounted.sort();
    MyPlan {
        steps,
        uncounted: uncounted.iter().map(my_name).collect(),
    }
}

/// The keys `how` writing `table` follows, and how each writes its child.
fn my_children<'a>(
    keys: &'a [MyForeignKey],
    table: &Name,
    how: &MyWrite,
) -> Vec<(&'a MyForeignKey, MyWrite)> {
    keys.iter()
        .filter(|k| &k.parent == table)
        .filter_map(|key| {
            let child = match how {
                MyWrite::Delete => match key.on_delete {
                    MyRule::Cascade => MyWrite::Delete,
                    MyRule::SetNull => MyWrite::Update(key.child_columns.clone()),
                    MyRule::Refuse => return None,
                },
                MyWrite::Update(cols) => {
                    if key.on_update == MyRule::Refuse
                        || !key.parent_columns.iter().any(|c| cols.contains(c))
                    {
                        return None;
                    }
                    MyWrite::Update(key.child_columns.clone())
                }
            };
            Some((key, child))
        })
        .collect()
}

/// `a, b`: a subquery's select list takes no parentheses.
fn my_select_list(cols: &[String]) -> String {
    cols.iter()
        .map(|c| crate::db::quote_ident(crate::db::EngineKind::Mysql, c))
        .collect::<Vec<_>>()
        .join(", ")
}

fn my_table(name: &Name) -> String {
    crate::db::qualified_table_sql(crate::db::EngineKind::Mysql, &name.0, &name.1)
}

fn my_columns(cols: &[String]) -> String {
    let quoted: Vec<String> = cols
        .iter()
        .map(|c| crate::db::quote_ident(crate::db::EngineKind::Mysql, c))
        .collect();
    if quoted.len() == 1 {
        quoted.into_iter().next().unwrap_or_default()
    } else {
        format!("({})", quoted.join(", "))
    }
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
            ..Reach::default()
        };
        let left = beyond(reach, "public", "kiosks", [0, 0, 1]);
        assert_eq!(left.tables, vec![t("kiosks", 1, 1), t("payouts", 0, 37)]);
        // Only its own rows: nothing beyond.
        let own = Reach {
            tables: vec![t("kiosks", 0, 1)],
            ..Reach::default()
        };
        assert!(beyond(own, "public", "kiosks", [0, 0, 1]).is_empty());
        // A WITHOUT ROWID table's own rows were never named.
        let unnamed = Reach {
            unnamed: 3,
            ..Reach::default()
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

    fn n(t: &str) -> Name {
        ("shop".to_string(), t.to_string())
    }

    fn fk(child: &str, col: &str, parent: &str, del: MyRule, upd: MyRule) -> MyForeignKey {
        MyForeignKey {
            child: n(child),
            child_columns: vec![col.into()],
            parent: n(parent),
            parent_columns: vec!["id".into()],
            on_delete: del,
            on_update: upd,
        }
    }

    #[test]
    fn my_plan_walks_parents_before_children() {
        use MyRule::*;
        let keys = [
            fk("items", "order_id", "orders", Cascade, Refuse),
            fk("notes", "item_id", "items", SetNull, Refuse),
            fk("refunds", "order_id", "orders", Refuse, Refuse),
            fk("orders", "customer_id", "customers", Cascade, Refuse),
        ];
        let plan = my_plan(&n("orders"), Some("`id` = 3"), &[], &keys);
        assert!(plan.uncounted.is_empty());
        let steps: Vec<(&str, &MyWrite)> = plan
            .steps
            .iter()
            .map(|s| (s.table.1.as_str(), &s.write))
            .collect();
        assert_eq!(
            steps,
            [
                ("items", &MyWrite::Delete),
                ("notes", &MyWrite::Update(vec!["item_id".into()]))
            ]
        );
        assert_eq!(
            plan.steps[1].predicate,
            "item_id IN (SELECT id FROM shop.items WHERE order_id IN (SELECT id FROM shop.orders WHERE `id` = 3))"
        );
        // Inserts and plain updates reach nothing.
        assert_eq!(
            my_plan(&n("orders"), None, &["note".into()], &keys),
            MyPlan::default()
        );
    }

    #[test]
    fn my_plan_joins_two_paths_of_one_kind() {
        use MyRule::*;
        let keys = [
            fk("items", "order_id", "orders", Cascade, Refuse),
            fk("tags", "order_id", "orders", Cascade, Refuse),
            fk("tags", "item_id", "items", Cascade, Refuse),
        ];
        let plan = my_plan(&n("orders"), Some("`id` = 3"), &[], &keys);
        assert!(plan.uncounted.is_empty());
        let tags = plan.steps.iter().find(|s| s.table.1 == "tags").unwrap();
        assert!(tags.predicate.starts_with('(') && tags.predicate.contains(" OR "));
        let at = |t: &str| plan.steps.iter().position(|s| s.table.1 == t).unwrap();
        assert!(at("items") < at("tags"));
    }

    #[test]
    fn my_plan_names_what_it_cannot_count() {
        use MyRule::*;
        // Self-reference on the target: nothing is sure.
        let keys = [
            fk("categories", "parent_id", "categories", Cascade, Refuse),
            fk("products", "category_id", "categories", Cascade, Refuse),
        ];
        let plan = my_plan(&n("categories"), Some("`id` = 1"), &[], &keys);
        assert!(plan.steps.is_empty());
        assert_eq!(plan.uncounted, ["shop.categories", "shop.products"]);
        // Deleted one way, set NULL another: that table and past it.
        let keys = [
            fk("a", "o", "orders", Cascade, Refuse),
            fk("b", "o", "orders", SetNull, Refuse),
            fk("b", "a", "a", Cascade, Refuse),
            fk("c", "b", "b", Cascade, Cascade),
        ];
        let plan = my_plan(&n("orders"), Some("`id` = 1"), &[], &keys);
        assert_eq!(plan.steps.len(), 1);
        assert_eq!(plan.steps[0].table.1, "a");
        assert_eq!(plan.uncounted, ["shop.b", "shop.c"]);
        // A loop below the target.
        let keys = [
            fk("a", "o", "orders", Cascade, Refuse),
            fk("b", "a", "a", Cascade, Refuse),
            fk("a", "b", "b", Cascade, Refuse),
        ];
        let plan = my_plan(&n("orders"), Some("`id` = 1"), &[], &keys);
        assert!(plan.steps.is_empty());
        assert_eq!(plan.uncounted, ["shop.a", "shop.b"]);
        // Changing a key that cascades on update.
        let keys = [fk("items", "order_id", "orders", Refuse, Cascade)];
        let plan = my_plan(&n("orders"), None, &["id".into()], &keys);
        assert_eq!(plan.uncounted, ["shop.items"]);
        assert!(my_plan(&n("orders"), None, &["note".into()], &keys)
            .uncounted
            .is_empty());
    }

    #[test]
    fn my_plan_stops_past_innodb_depth() {
        use MyRule::*;
        let mut keys = vec![fk("t1", "p", "orders", Cascade, Refuse)];
        for i in 1..20 {
            keys.push(fk(
                &format!("t{}", i + 1),
                "p",
                &format!("t{i}"),
                Cascade,
                Refuse,
            ));
        }
        let plan = my_plan(&n("orders"), Some("`id` = 1"), &[], &keys);
        assert_eq!(plan.steps.len(), 15);
        assert_eq!(plan.uncounted.len(), 5);
    }

    #[test]
    fn my_plan_composite_keys_and_followed_updates() {
        use MyRule::*;
        let lines = MyForeignKey {
            child: n("lines"),
            child_columns: vec!["oid".into(), "region".into()],
            parent: n("orders"),
            parent_columns: vec!["id".into(), "region".into()],
            on_delete: Cascade,
            on_update: Cascade,
        };
        let plan = my_plan(
            &n("orders"),
            Some("`id` = 1"),
            &[],
            std::slice::from_ref(&lines),
        );
        assert_eq!(
            plan.steps[0].predicate,
            "(oid, region) IN (SELECT id, region FROM shop.orders WHERE `id` = 1)"
        );
        // A followed key's change is named as far as it goes.
        let keys = [lines, fk("notes", "line_oid", "lines", Refuse, Cascade)];
        let mut notes = keys[1].clone();
        notes.parent_columns = vec!["oid".into()];
        let keys = [keys[0].clone(), notes];
        let plan = my_plan(&n("orders"), None, &["region".into()], &keys);
        assert_eq!(plan.uncounted, ["shop.lines", "shop.notes"]);
    }
}
