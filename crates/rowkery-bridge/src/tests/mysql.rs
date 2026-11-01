//! MySQL and MariaDB windows against a live server: `ROWKERY_MYSQL_PORT`
//! (and `_HOST`, `_USER`, `_PASSWORD`, `_DB`, `rowkery` / 127.0.0.1 by
//! default); `ROWKERY_MYSQL_FLAVOR` (`mysql` or `mariadb`) checks which
//! server the window says it reached.

use super::*;
use rowkery_core::connections::MysqlConnection;

fn env(name: &str, default: &str) -> String {
    std::env::var(name).unwrap_or_else(|_| default.into())
}

/// The test server saved under `id`, with `safe_mode`.
fn save_mysql(bridge: &super::super::CoreBridge, id: &str, safe_mode: SafeMode) {
    CoreBridge::upsert_connection(
        bridge,
        ConnectionRecord::Mysql(MysqlConnection {
            id: id.into(),
            name: id.into(),
            host: env("ROWKERY_MYSQL_HOST", "127.0.0.1"),
            port: env("ROWKERY_MYSQL_PORT", "3306").parse().unwrap(),
            database: env("ROWKERY_MYSQL_DB", "rowkery"),
            username: env("ROWKERY_MYSQL_USER", "rowkery"),
            ssl_mode: PostgresSslMode::Disable,
            ssl_root_cert: None,
            ssh: None,
            environment: None,
            safe_mode,
            allow_mcp: false,
            mcp_hidden_tables: Vec::new(),
            mcp_until: None,
            mcp_samples_off: false,
            mcp_timeout_s: None,
            mcp_access: None,
            masked_columns: Default::default(),
            mariadb: false,
        }),
        ConnectionSecrets {
            db_password: Some(env("ROWKERY_MYSQL_PASSWORD", "rowkery")),
            ..Default::default()
        },
    )
    .expect("save");
}

/// Every row a run sent, and how it ended.
fn rows_of(
    bridge: &super::super::CoreBridge,
    window: &str,
    tab: u64,
    sql: &str,
) -> (Vec<Vec<Value>>, Option<String>, bool) {
    let queue = bridge
        .run_window_query(window, tab, sql.into(), None, false)
        .expect("run");
    let mut rows = Vec::new();
    let deadline = Instant::now() + Duration::from_secs(20);
    while Instant::now() < deadline {
        let drained: Vec<CoreEvent> = std::mem::take(&mut *queue.lock().unwrap());
        for event in drained {
            match event {
                CoreEvent::QueryBatch { batch, .. } => rows.extend(batch.rows),
                CoreEvent::QueryFinished {
                    error, cancelled, ..
                } => return (rows, error, cancelled),
                CoreEvent::QueryHeld { hold, .. } => {
                    return (rows, Some(format!("held: {:?}", hold.action)), false)
                }
                _ => {}
            }
        }
        thread::sleep(Duration::from_millis(5));
    }
    panic!("not done: {sql}");
}

#[test]
fn mysql_window_opens_runs_and_reloads() {
    let (_guard, _file, _path) = test_guard();
    let bridge = super::super::CoreBridge::spawn();
    save_mysql(&bridge, "my-open", SafeMode::Off);
    let opened = bridge.open_window("w", "my-open", None).expect("open");
    let expected = match env("ROWKERY_MYSQL_FLAVOR", "").as_str() {
        "mariadb" => Some("MariaDB"),
        "mysql" => Some("MySQL"),
        _ => opened.server_flavor,
    };
    assert_eq!(opened.server_flavor, expected);
    assert!(opened.server_version.is_some());
    let schemas: Vec<&str> = opened.catalog.databases[0]
        .schemas
        .iter()
        .map(|s| s.name.as_str())
        .collect();
    assert!(schemas.contains(&"rowkery"), "{schemas:?}");

    let (rows, error, _) = rows_of(
        &bridge,
        "w",
        1,
        "DROP TABLE IF EXISTS bw_t; CREATE TABLE bw_t (id INT PRIMARY KEY, name TEXT);
         INSERT INTO bw_t VALUES (1, 'a'), (2, 'b'); SELECT id, name FROM bw_t ORDER BY id",
    );
    assert_eq!(error, None);
    assert_eq!(
        rows,
        [
            vec![Value::Int(1), Value::Text("a".into())],
            vec![Value::Int(2), Value::Text("b".into())]
        ]
    );
    let (_, error, _) = rows_of(&bridge, "w", 1, "SELECT * FROM bw_no_such_table");
    assert!(error.is_some_and(|e| e.contains("bw_no_such_table")));
    // The tab's session is still good after an error.
    assert_eq!(rows_of(&bridge, "w", 1, "SELECT 7").0, [[Value::Int(7)]]);
    let catalog = bridge.reload_window_schema("w").expect("reload");
    assert!(catalog.table("rowkery", "bw_t").is_some());
    bridge.close_window("w");
    std::env::remove_var("ROWKERY_CONFIG_DIR");
}

#[test]
fn mysql_read_only_and_confirm_hold_writes() {
    let (_guard, _file, _path) = test_guard();
    let bridge = super::super::CoreBridge::spawn();
    save_mysql(&bridge, "my-ro", SafeMode::ReadOnly);
    bridge.open_window("w", "my-ro", None).expect("open");
    let (_, error, _) = rows_of(&bridge, "w", 1, "CREATE TABLE bw_ro (id INT)");
    assert_eq!(error.as_deref(), Some("held: Refuse"));
    // A versioned comment that a server may skip doesn't hide a write.
    let (_, error, _) = rows_of(&bridge, "w", 1, "/*!99999 EXPLAIN */ DELETE FROM bw_t");
    assert_eq!(error.as_deref(), Some("held: Refuse"));
    assert_eq!(rows_of(&bridge, "w", 1, "SELECT 1").0, [[Value::Int(1)]]);
    std::env::remove_var("ROWKERY_CONFIG_DIR");
}

/// Cancel stops the running statement with `KILL QUERY`; the tab's
/// session stays and its next run isn't the one killed.
#[test]
fn mysql_cancel_stops_the_statement_and_keeps_the_tab() {
    let (_guard, _file, _path) = test_guard();
    let bridge = super::super::CoreBridge::spawn();
    save_mysql(&bridge, "my-cancel", SafeMode::Off);
    bridge.open_window("w", "my-cancel", None).expect("open");
    // Not SLEEP or BENCHMARK: killed, they return a value as if done.
    let queue = bridge
        .run_window_query(
            "w",
            1,
            "SELECT COUNT(*) FROM information_schema.COLLATIONS a, information_schema.COLLATIONS b, \
             information_schema.COLLATIONS c, information_schema.COLLATIONS d"
                .into(),
            None,
            false,
        )
        .expect("run");
    thread::sleep(Duration::from_millis(300));
    let started = Instant::now();
    bridge.cancel_window_query("w", 1);
    let (_, error, cancelled) = wait_finished(&queue);
    assert!(cancelled, "{error:?}");
    assert!(started.elapsed() < Duration::from_secs(3));
    for n in 0..3 {
        assert_eq!(
            rows_of(&bridge, "w", 1, &format!("SELECT {n}")).0,
            [[Value::Int(n)]]
        );
    }
    std::env::remove_var("ROWKERY_CONFIG_DIR");
}

/// A tab's open transaction stays with it, holds off a safe mode change,
/// and is counted for a quit.
#[test]
fn mysql_an_open_transaction_stays_with_its_tab() {
    let (_guard, _file, _path) = test_guard();
    let bridge = super::super::CoreBridge::spawn();
    save_mysql(&bridge, "my-txn", SafeMode::Off);
    bridge.open_window("w", "my-txn", None).expect("open");
    rows_of(
        &bridge,
        "w",
        1,
        "DROP TABLE IF EXISTS bw_txn; CREATE TABLE bw_txn (id INT) ENGINE=InnoDB",
    );
    assert_eq!(
        rows_of(&bridge, "w", 1, "BEGIN; INSERT INTO bw_txn VALUES (1)").1,
        None
    );
    assert_eq!(bridge.open_transactions(), [("w".to_string(), 1)]);
    // Another tab doesn't see the uncommitted row.
    assert_eq!(
        rows_of(&bridge, "w", 2, "SELECT count(*) FROM bw_txn").0,
        [[Value::Int(0)]]
    );
    // A failed statement inside it leaves it open, and it stays counted.
    let (_, error, _) = rows_of(&bridge, "w", 1, "INSERT INTO bw_txn_missing VALUES (1)");
    assert!(error.is_some());
    assert_eq!(bridge.open_transactions(), [("w".to_string(), 1)]);
    let refused = super::set_safe_mode(&bridge, "my-txn", SafeMode::ReadOnly);
    assert_eq!(refused.err().as_deref(), Some(SAFE_MODE_IN_TXN));
    assert_eq!(rows_of(&bridge, "w", 1, "COMMIT").1, None);
    assert!(bridge.open_transactions().is_empty());
    assert_eq!(
        rows_of(&bridge, "w", 2, "SELECT count(*) FROM bw_txn").0,
        [[Value::Int(1)]]
    );
    // Now it changes, and the window's sessions are read-only from then on.
    super::set_safe_mode(&bridge, "my-txn", SafeMode::ReadOnly).expect("changes");
    let (_, error, _) = rows_of(&bridge, "w", 1, "INSERT INTO bw_txn VALUES (2)");
    assert_eq!(error.as_deref(), Some("held: Refuse"));
    std::env::remove_var("ROWKERY_CONFIG_DIR");
}

/// On a read-only connection, an error inside the user's transaction
/// doesn't make the next statement fail (the server refuses a change of
/// access mode inside a transaction).
#[test]
fn mysql_read_only_transaction_survives_an_error() {
    let (_guard, _file, _path) = test_guard();
    let bridge = super::super::CoreBridge::spawn();
    save_mysql(&bridge, "my-ro-txn", SafeMode::ReadOnly);
    bridge.open_window("w", "my-ro-txn", None).expect("open");
    assert_eq!(rows_of(&bridge, "w", 1, "BEGIN").1, None);
    assert!(rows_of(&bridge, "w", 1, "SELECT nope_no_column")
        .1
        .is_some());
    assert_eq!(rows_of(&bridge, "w", 1, "SELECT 3").0, [[Value::Int(3)]]);
    assert_eq!(bridge.open_transactions(), [("w".to_string(), 1)]);
    assert_eq!(rows_of(&bridge, "w", 1, "ROLLBACK").1, None);
    assert!(bridge.open_transactions().is_empty());
    std::env::remove_var("ROWKERY_CONFIG_DIR");
}

/// Stop all queries ends a run without the server's help.
#[test]
fn mysql_force_stop_ends_the_run() {
    let (_guard, _file, _path) = test_guard();
    let bridge = super::super::CoreBridge::spawn();
    save_mysql(&bridge, "my-stop", SafeMode::Off);
    bridge.open_window("w", "my-stop", None).expect("open");
    let queue = bridge
        .run_window_query("w", 1, "SELECT SLEEP(20)".into(), None, false)
        .expect("run");
    thread::sleep(Duration::from_millis(300));
    let started = Instant::now();
    bridge.stop_all_queries();
    let (_, _, cancelled) = wait_finished(&queue);
    assert!(cancelled);
    assert!(started.elapsed() < Duration::from_secs(2));
    assert_eq!(rows_of(&bridge, "w", 1, "SELECT 5").0, [[Value::Int(5)]]);
    std::env::remove_var("ROWKERY_CONFIG_DIR");
}

#[test]
fn mysql_quick_look_follows_keys_and_counts() {
    let (_guard, _file, _path) = test_guard();
    let bridge = super::super::CoreBridge::spawn();
    save_mysql(&bridge, "my-follow", SafeMode::ReadOnly);
    bridge.open_window("w", "my-follow", None).expect("open");
    save_mysql(&bridge, "my-setup", SafeMode::Off);
    bridge.open_window("s", "my-setup", None).expect("open");
    let (_, error, _) = rows_of(
        &bridge,
        "s",
        1,
        "DROP TABLE IF EXISTS bf_c, bf_p; CREATE TABLE bf_p (id INT PRIMARY KEY, name TEXT);
         CREATE TABLE bf_c (id INT PRIMARY KEY, p INT);
         INSERT INTO bf_p VALUES (1, 'it''s'), (2, 'b'); INSERT INTO bf_c VALUES (1, 1), (2, 1), (3, 2)",
    );
    assert_eq!(error, None);
    let lookup = |table: &str, column: &str, value: i64| FollowLookup {
        schema: "rowkery".into(),
        table: table.into(),
        column: column.into(),
        value: Value::Int(value),
    };
    let found = bridge
        .follow_keys("w", vec![lookup("bf_p", "id", 1), lookup("bf_p", "id", 9)])
        .expect("follow");
    assert_eq!(
        found[0].as_ref().map(|r| r.row.clone()),
        Some(vec![Value::Int(1), Value::Text("it's".into())])
    );
    assert_eq!(found[1], None);
    let counts = bridge
        .count_incoming(
            "w",
            vec![
                lookup("bf_c", "p", 1),
                lookup("bf_c", "p", 2),
                lookup("bf_c", "p", 3),
            ],
        )
        .expect("count");
    assert_eq!(counts, [Some(2), Some(1), Some(0)]);
    bridge.close_window("w");
    bridge.close_window("s");
    std::env::remove_var("ROWKERY_CONFIG_DIR");
}

#[test]
fn mysql_sql_files_run_and_respect_safe_mode() {
    use rowkery_core::sql_file::{scan, RunOptions};
    let (_guard, _file, _path) = test_guard();
    let bridge = super::super::CoreBridge::spawn();
    save_mysql(&bridge, "my-file", SafeMode::Confirm);
    bridge.open_window("w", "my-file", None).expect("open");
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("f.sql");
    std::fs::write(
        &path,
        "DROP TABLE IF EXISTS bs_t;\nCREATE TABLE bs_t (id INT PRIMARY KEY, note TEXT);\nDELIMITER ;;\nINSERT INTO bs_t VALUES (1, 'a;b');;\nDELIMITER ;\nINSERT INTO bs_t VALUES (2, 'it\\'s');\n",
    )
    .unwrap();
    let scanned = scan(&path, EngineKind::Mysql, |_| true).unwrap();
    assert_eq!(scanned.statements, 4);
    let per = RunOptions {
        whole_file: false,
        keep_going: false,
    };
    let sink = || ProgressSink(Box::new(|_| {}));
    // Confirm writes: only the panel's Run (confirmed) runs it.
    let held = bridge.run_sql_file("w", path.clone(), scanned.clone(), per, false, sink());
    assert!(held.is_err_and(|e| e.contains("confirms writes")));
    let whole = RunOptions {
        whole_file: true,
        keep_going: false,
    };
    let refused = bridge.run_sql_file("w", path.clone(), scanned.clone(), whole, true, sink());
    assert_eq!(
        refused.unwrap().failed.unwrap().message,
        "This file can't run as one transaction."
    );
    let report = bridge
        .run_sql_file("w", path.clone(), scanned, per, true, sink())
        .expect("run");
    assert_eq!((report.done, report.rows, report.failed), (4, 2, None));
    let (rows, _, _) = rows_of(&bridge, "w", 1, "SELECT note FROM bs_t ORDER BY id");
    assert_eq!(
        rows,
        [[Value::Text("a;b".into())], [Value::Text("it's".into())]]
    );
    bridge.close_window("w");
    std::env::remove_var("ROWKERY_CONFIG_DIR");
}
