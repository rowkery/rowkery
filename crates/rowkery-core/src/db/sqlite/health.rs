//! The Health tab's checks on SQLite, from the file's pages and schema: the
//! bundled build has the `dbstat` table, so sizes and row estimates come
//! from a walk of the pages without reading a row. SQLite keeps no usage
//! statistics, so there are no unused-index or slow-query checks.

use std::collections::HashMap;

use rusqlite::Connection;

use super::{sqlite_ident_quote, SqliteDriver};
use crate::db::DriverError;
use crate::health::{
    limits, CheckKind, Detail, HealthCheck, HealthItem, HealthReport, SizeTile, SlowQueries,
};

/// A b-tree as `dbstat` sees it.
struct Tree {
    bytes: i64,
    /// Cells on all its pages: about the row count for a table.
    cells: i64,
}

/// An index's key columns as `(column, descending, collation)`; `None`
/// for an expression.
type Key = (Option<String>, bool, String);

struct Index {
    name: String,
    unique: bool,
    /// `c` from CREATE INDEX, `u` from UNIQUE, `pk` from PRIMARY KEY.
    origin: String,
    partial: bool,
    keys: Vec<Key>,
    /// Creation order, from `sqlite_master`'s rowid.
    order: i64,
}

impl SqliteDriver {
    /// The main database's health.
    pub fn health(&self) -> Result<HealthReport, DriverError> {
        let conn = self.connection()?;
        let guard = conn
            .lock()
            .map_err(|_| DriverError::Message("lock poisoned".into()))?;
        health(&guard, self.path()).map_err(|e| DriverError::Message(e.to_string()))
    }
}

fn pragma(conn: &Connection, name: &str) -> rusqlite::Result<i64> {
    conn.query_row(&format!("PRAGMA main.{name}"), [], |r| r.get(0))
}

fn health(conn: &Connection, path: &str) -> rusqlite::Result<HealthReport> {
    let page_size = pragma(conn, "page_size")?;
    let file_bytes = pragma(conn, "page_count")? * page_size;
    let free_bytes = pragma(conn, "freelist_count")? * page_size;

    // name -> (type, creation order)
    let mut objects: HashMap<String, (String, i64)> = HashMap::new();
    let mut tables: Vec<String> = Vec::new();
    {
        let mut stmt = conn.prepare(
            "SELECT m.name, m.type, m.rowid FROM main.sqlite_master m \
             WHERE m.type IN ('table', 'index')",
        )?;
        let mut rows = stmt.query([])?;
        while let Some(r) = rows.next()? {
            let name: String = r.get(0)?;
            let kind: String = r.get(1)?;
            objects.insert(name, (kind, r.get(2)?));
        }
        // `table`, not `virtual` or `shadow` (a full-text index's own tables).
        let mut stmt = conn.prepare(
            "SELECT t.name FROM pragma_table_list t \
             WHERE t.schema = 'main' AND t.type = 'table' AND substr(t.name, 1, 7) <> 'sqlite_' \
             ORDER BY t.name",
        )?;
        for name in stmt.query_map([], |r| r.get(0))? {
            tables.push(name?);
        }
    }

    // One walk of the pages, which reads the whole file and holds a read
    // lock meanwhile: only for a small file.
    let walk = file_bytes <= limits::SQLITE_WALK_BYTES;
    let trees: HashMap<String, Tree> = conn
        .prepare("SELECT name, pgsize, ncell FROM dbstat('main', 1)")
        .and_then(|mut stmt| {
            if !walk {
                return Ok(HashMap::new());
            }
            stmt.query_map([], |r| {
                Ok((
                    r.get::<_, String>(0)?,
                    Tree {
                        bytes: r.get(1)?,
                        cells: r.get(2)?,
                    },
                ))
            })?
            .collect()
        })
        .unwrap_or_default();
    let of = |kind: &str| -> Option<i64> {
        (!trees.is_empty()).then(|| {
            trees
                .iter()
                .filter(|(name, _)| objects.get(*name).is_some_and(|o| o.0 == kind))
                .map(|(_, t)| t.bytes)
                .sum()
        })
    };
    let size = Some(SizeTile {
        total_bytes: file_bytes,
        table_bytes: of("table"),
        index_bytes: of("index"),
    });

    // table -> its row count in sqlite_stat1, when analyzed.
    let analyzed: HashMap<String, i64> = conn
        .prepare("SELECT tbl, stat FROM main.sqlite_stat1")
        .and_then(|mut s| {
            s.query_map([], |r| {
                let stat: Option<String> = r.get(1)?;
                let rows = stat
                    .as_deref()
                    .and_then(|s| s.split(' ').next()?.parse().ok())
                    .unwrap_or(0);
                Ok((r.get::<_, String>(0)?.to_lowercase(), rows))
            })?
            .collect()
        })
        .unwrap_or_default();
    // `Some(rows)` for a table over the size limit (`Some(None)` when only
    // that much is known): the page walk's count, else the analyzed count,
    // else a count that stops just past the limit.
    let over = |table: &str| -> rusqlite::Result<Option<Option<i64>>> {
        if let Some(t) = trees.get(table) {
            return Ok((t.cells > limits::ROWS).then_some(Some(t.cells)));
        }
        if let Some(&rows) = analyzed.get(&table.to_lowercase()) {
            return Ok((rows > limits::ROWS).then_some(Some(rows)));
        }
        let counted: i64 = conn.query_row(
            &format!(
                "SELECT count(*) FROM (SELECT 1 FROM main.{} LIMIT {})",
                sqlite_ident_quote(table),
                limits::ROWS + 1
            ),
            [],
            |r| r.get(0),
        )?;
        Ok((counted > limits::ROWS).then_some(None))
    };

    let mut duplicates = Vec::new();
    let mut fks = Vec::new();
    let mut never_analyzed = Vec::new();
    for table in &tables {
        let indexes = indexes(conn, table, &objects)?;
        duplicates.extend(duplicate_indexes(table, &indexes, &trees));
        if let Some(rows) = over(table)? {
            fks.extend(unindexed_foreign_keys(
                conn, table, &indexes, rows, &objects,
            )?);
            let has_stats = analyzed.contains_key(&table.to_lowercase());
            if !indexes.is_empty() && !has_stats {
                never_analyzed.push(HealthItem {
                    schema: None,
                    table: Some(table.clone()),
                    name: None,
                    bytes: None,
                    detail: Detail::NeverAnalyzed { rows },
                    fix: Some(format!("ANALYZE main.{};", sqlite_ident_quote(table))),
                });
            }
        }
    }

    let free = if free_bytes >= limits::FREE_BYTES
        && free_bytes as f64 > file_bytes as f64 * limits::FREE_SHARE
    {
        vec![HealthItem {
            schema: None,
            table: None,
            name: None,
            bytes: Some(free_bytes),
            detail: Detail::FreePages {
                free_bytes,
                file_bytes,
            },
            fix: Some("VACUUM;".into()),
        }]
    } else {
        Vec::new()
    };

    let database = std::path::Path::new(path)
        .file_name()
        .map_or_else(|| path.to_string(), |n| n.to_string_lossy().into_owned());
    Ok(HealthReport {
        database,
        server: format!("SQLite {}", rusqlite::version()),
        size,
        cache_hit: None,
        connections: None,
        stats_since: None,
        transaction_age: None,
        checks: vec![
            HealthCheck::of(CheckKind::FreePages, true, free),
            HealthCheck::of(CheckKind::DuplicateIndexes, true, duplicates),
            HealthCheck::of(CheckKind::ForeignKeysWithoutIndex, true, fks),
            HealthCheck::of(CheckKind::NeverAnalyzed, true, never_analyzed),
        ],
        slow_queries: SlowQueries::None,
    })
}

fn indexes(
    conn: &Connection,
    table: &str,
    objects: &HashMap<String, (String, i64)>,
) -> rusqlite::Result<Vec<Index>> {
    let mut list = conn.prepare(
        "SELECT name, \"unique\", origin, partial FROM pragma_index_list(?1, 'main') ORDER BY seq",
    )?;
    let mut keys = conn.prepare(
        "SELECT cid, name, \"desc\", coll FROM pragma_index_xinfo(?1, 'main') \
         WHERE key = 1 ORDER BY seqno",
    )?;
    let listed: Vec<(String, bool, String, bool)> = list
        .query_map([table], |r| {
            Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?))
        })?
        .collect::<Result<_, _>>()?;
    listed
        .into_iter()
        .map(|(name, unique, origin, partial)| {
            let keys = keys
                .query_map([&name], |r| {
                    let cid: i64 = r.get(0)?;
                    let column: Option<String> = r.get(1)?;
                    Ok((
                        (cid != -2).then_some(column).flatten(),
                        r.get(2)?,
                        r.get(3)?,
                    ))
                })?
                .collect::<Result<_, _>>()?;
            let order = objects.get(&name).map_or(i64::MAX, |o| o.1);
            Ok(Index {
                name,
                unique,
                origin,
                partial,
                keys,
                order,
            })
        })
        .collect()
}

/// Plain non-unique indexes whose keys lead another index (see the Postgres
/// check for the rule on two identical ones).
fn duplicate_indexes(
    table: &str,
    indexes: &[Index],
    trees: &HashMap<String, Tree>,
) -> Vec<HealthItem> {
    let plain = |i: &Index| !i.partial && i.keys.iter().all(|k| k.0.is_some());
    indexes
        .iter()
        .filter(|a| a.origin == "c" && !a.unique && plain(a))
        .filter_map(|a| {
            let by = indexes
                .iter()
                .filter(|b| b.name != a.name && plain(b) && b.keys.starts_with(&a.keys))
                .filter(|b| b.keys.len() > a.keys.len() || b.unique || b.order < a.order)
                .min_by_key(|b| (b.keys.len(), b.order))?;
            Some(HealthItem {
                schema: None,
                table: Some(table.to_string()),
                name: Some(a.name.clone()),
                bytes: trees.get(&a.name).map(|t| t.bytes),
                detail: Detail::DuplicateIndex {
                    covered_by: by.name.clone(),
                },
                fix: Some(format!("DROP INDEX main.{};", sqlite_ident_quote(&a.name))),
            })
        })
        .collect()
}

fn unindexed_foreign_keys(
    conn: &Connection,
    table: &str,
    indexes: &[Index],
    rows: Option<i64>,
    objects: &HashMap<String, (String, i64)>,
) -> rusqlite::Result<Vec<HealthItem>> {
    // An INTEGER PRIMARY KEY is the rowid: already the table's own index.
    let rowid: Option<String> = {
        let mut stmt = conn
            .prepare("SELECT name, upper(type) FROM pragma_table_info(?1, 'main') WHERE pk > 0")?;
        let pk: Vec<(String, String)> = stmt
            .query_map([table], |r| Ok((r.get(0)?, r.get(1)?)))?
            .collect::<Result<_, _>>()?;
        match pk.as_slice() {
            [(name, kind)] if kind == "INTEGER" => Some(name.clone()),
            _ => None,
        }
    };
    let mut stmt = conn.prepare(
        "SELECT id, \"table\", \"from\" FROM pragma_foreign_key_list(?1, 'main') ORDER BY id, seq",
    )?;
    let mut keys: Vec<(i64, String, Vec<String>)> = Vec::new();
    for row in stmt.query_map([table], |r| {
        Ok((
            r.get::<_, i64>(0)?,
            r.get::<_, String>(1)?,
            r.get::<_, String>(2)?,
        ))
    })? {
        let (id, parent, column) = row?;
        match keys.last_mut() {
            Some((last, _, cols)) if *last == id => cols.push(column),
            _ => keys.push((id, parent, vec![column])),
        }
    }
    let same = |a: &str, b: &str| a.eq_ignore_ascii_case(b);
    Ok(keys
        .into_iter()
        .filter(|(_, _, cols)| {
            let by_rowid = matches!((cols.as_slice(), &rowid), ([c], Some(r)) if same(c, r));
            let by_index = indexes.iter().any(|i| {
                !i.partial
                    && i.keys.len() >= cols.len()
                    && i.keys[..cols.len()].iter().all(|k| {
                        k.0.as_deref()
                            .is_some_and(|name| cols.iter().any(|c| same(c, name)))
                    })
            });
            !by_rowid && !by_index
        })
        .map(|(id, parent, cols)| {
            let quoted: Vec<String> = cols.iter().map(|c| sqlite_ident_quote(c)).collect();
            let base = format!("{table}_{}_idx", cols.join("_"));
            let taken = |name: &str| objects.keys().any(|k| k.eq_ignore_ascii_case(name));
            let index = (1..)
                .map(|n| {
                    if n == 1 {
                        base.clone()
                    } else {
                        format!("{base}_{n}")
                    }
                })
                .find(|name| !taken(name))
                .unwrap_or(base);
            HealthItem {
                schema: None,
                table: Some(table.to_string()),
                name: Some(format!("{table} → {parent}")),
                bytes: None,
                detail: Detail::ForeignKeyWithoutIndex {
                    constraint: format!("foreign key {}", id + 1),
                    columns: cols.clone(),
                    parent_schema: None,
                    parent_table: parent,
                    rows,
                },
                fix: Some(format!(
                    "CREATE INDEX main.{} ON {} ({});",
                    sqlite_ident_quote(&index),
                    sqlite_ident_quote(table),
                    quoted.join(", ")
                )),
            }
        })
        .collect())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::Driver;
    use crate::health::{CheckState, HealthReport};

    fn found(report: &HealthReport, kind: CheckKind) -> &[HealthItem] {
        let check = report.checks.iter().find(|c| c.check == kind).unwrap();
        assert!(
            matches!(check.state, CheckState::Fine | CheckState::Found { .. }),
            "{:?}",
            check.state
        );
        check.items()
    }

    #[test]
    fn finds_each_problem_and_its_fix_clears_it() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("shop.sqlite");
        let conn = Connection::open(&path).unwrap();
        conn.execute_batch(
            r"
            CREATE TABLE parent (id INTEGER PRIMARY KEY);
            WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 30000)
            INSERT INTO parent SELECT i FROM n;
            CREATE TABLE child (id INTEGER PRIMARY KEY, parent_id INTEGER REFERENCES parent (id), note TEXT);
            CREATE TABLE covered (id INTEGER PRIMARY KEY, parent_id INTEGER REFERENCES parent (id));
            CREATE INDEX covered_parent ON covered (parent_id, id);
            CREATE TABLE by_rowid (id INTEGER PRIMARY KEY REFERENCES parent (id));
            CREATE INDEX child_note ON child (note);
            CREATE INDEX child_note_id ON child (note, id);
            CREATE INDEX child_note_desc ON child (note DESC);
            CREATE INDEX child_lower ON child (lower(note));
            WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 30000)
            INSERT INTO child (parent_id, note) SELECT 1, 'note ' || i FROM n;
            WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 30000)
            INSERT INTO covered (parent_id) SELECT 1 FROM n;
            WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 30000)
            INSERT INTO by_rowid (id) SELECT i FROM n;
            CREATE VIRTUAL TABLE notes USING fts5(body);
            WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 30000)
            INSERT INTO notes SELECT 'note ' || i FROM n;
            CREATE TABLE junk (blob BLOB);
            WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 600)
            INSERT INTO junk SELECT randomblob(8000) FROM n;
            DROP TABLE junk;
            ",
        )
        .unwrap();
        drop(conn);

        let mut driver = SqliteDriver::new(path.to_string_lossy()).read_only(true);
        driver.connect().unwrap();
        let report = driver.health().unwrap();
        assert_eq!(report.database, "shop.sqlite");
        assert!(report.server.starts_with("SQLite 3."));
        let size = report
            .size
            .as_ref()
            .expect("dbstat is in the bundled build");
        assert!(size.table_bytes > Some(0) && size.index_bytes > Some(0));
        assert!(matches!(report.slow_queries, SlowQueries::None));

        let free = found(&report, CheckKind::FreePages);
        assert!(
            matches!(free, [HealthItem { detail: Detail::FreePages { free_bytes, .. }, .. }]
            if *free_bytes > 4_000_000)
        );
        let dups: Vec<_> = found(&report, CheckKind::DuplicateIndexes)
            .iter()
            .map(|i| (i.name.clone().unwrap(), &i.detail))
            .collect();
        assert_eq!(dups.len(), 1, "{dups:?}");
        assert_eq!(dups[0].0, "child_note");
        assert!(
            matches!(dups[0].1, Detail::DuplicateIndex { covered_by } if covered_by == "child_note_id")
        );
        let fks: Vec<_> = found(&report, CheckKind::ForeignKeysWithoutIndex)
            .iter()
            .map(|i| i.table.clone().unwrap())
            .collect();
        assert_eq!(fks, ["child"]);
        let unanalyzed: Vec<_> = found(&report, CheckKind::NeverAnalyzed)
            .iter()
            .map(|i| i.table.clone().unwrap())
            .collect();
        assert_eq!(unanalyzed, ["child", "covered"]);

        let conn = Connection::open(&path).unwrap();
        for check in &report.checks {
            for item in check.items() {
                conn.execute_batch(item.fix.as_deref().unwrap()).unwrap();
            }
        }
        drop(conn);
        let mut driver = SqliteDriver::new(path.to_string_lossy()).read_only(true);
        driver.connect().unwrap();
        let report = driver.health().unwrap();
        for check in &report.checks {
            assert!(check.items().is_empty(), "{:?}", check);
        }
    }
}
