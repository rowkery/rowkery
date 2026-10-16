//! Times SQLite introspection on a generated file: 300 tables, each with
//! three indexes, a foreign key and 5,000 rows, plus 20 views.
//!
//!     cargo run --release -p rowkery-core --example sqlite_introspect_bench

use std::time::Instant;

use rowkery_core::db::sqlite::SqliteDriver;
use rowkery_core::db::Driver;

fn main() {
    let dir = tempfile::tempdir().expect("tempdir");
    let path = dir.path().join("bench.sqlite");
    let conn = rusqlite::Connection::open(&path).expect("open");
    let mut sql = String::from("BEGIN;");
    for t in 0..300 {
        let parent = if t == 0 { 0 } else { t - 1 };
        sql.push_str(&format!(
            "CREATE TABLE t{t} (id INTEGER PRIMARY KEY, parent_id INTEGER REFERENCES t{parent}(id), name TEXT NOT NULL DEFAULT 'x', qty INTEGER, at TEXT);
             CREATE INDEX t{t}_name ON t{t}(name); CREATE INDEX t{t}_qty_at ON t{t}(qty, at); CREATE UNIQUE INDEX t{t}_at ON t{t}(at);
             WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 5000)
             INSERT INTO t{t} (parent_id, name, qty, at) SELECT i, 'n' || i, i % 7, 'a' || i FROM n;"
        ));
    }
    for v in 0..20 {
        sql.push_str(&format!("CREATE VIEW v{v} AS SELECT id, name FROM t{v};"));
    }
    sql.push_str("COMMIT;");
    conn.execute_batch(&sql).expect("generate");
    drop(conn);

    let mut best = f64::MAX;
    for _ in 0..5 {
        let mut driver = SqliteDriver::new(path.to_string_lossy().to_string());
        driver.connect().expect("connect");
        let start = Instant::now();
        let catalog = driver.introspect_catalog().expect("introspect");
        let ms = start.elapsed().as_secs_f64() * 1000.0;
        best = best.min(ms);
        let tables = &catalog.databases[0].schemas[0].tables;
        let indexes: usize = tables.iter().map(|t| t.indexes.len()).sum();
        let fks: usize = tables.iter().map(|t| t.foreign_keys.len()).sum();
        println!(
            "{} relations, {indexes} indexes, {fks} foreign keys: {ms:.1} ms",
            tables.len()
        );
    }
    println!("best {best:.1} ms");
}
