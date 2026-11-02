//! MySQL and MariaDB windows against a live server: `ROWKERY_MYSQL_PORT`
//! (and `_HOST`, `_USER`, `_PASSWORD`, `_DB`, `rowkery` / 127.0.0.1 by
//! default); `ROWKERY_MYSQL_FLAVOR` (`mysql` or `mariadb`) checks which
//! server the window says it reached.

use super::*;
use rowkery_core::connections::MysqlConnection;

fn env(name: &str, default: &str) -> String {
    std::env::var(name).unwrap_or_else(|_| default.into())
}

/// Lets the test login make stored functions (MySQL 8.0 with binary
/// logging asks for SUPER otherwise), as root.
fn trust_function_creators() {
    let mut root = record("root", SafeMode::Off);
    root.username = "root".into();
    let secrets = ConnectionSecrets {
        db_password: Some(env("ROWKERY_MYSQL_ROOT_PASSWORD", "rowkery")),
        ..Default::default()
    };
    tokio::runtime::Runtime::new().unwrap().block_on(async {
        let mut s =
            rowkery_core::db::mysql::open_session_via(root.id.clone(), root, Some(&secrets), None)
                .await
                .expect("root");
        rowkery_core::db::mysql::session_execute(
            &mut s,
            "SET GLOBAL log_bin_trust_function_creators = 1",
        )
        .await
        .expect("trust");
    });
}

/// The test server's record.
fn record(id: &str, safe_mode: SafeMode) -> MysqlConnection {
    MysqlConnection {
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
    }
}

/// The test server saved under `id`, with `safe_mode`.
fn save_mysql(bridge: &super::super::CoreBridge, id: &str, safe_mode: SafeMode) {
    CoreBridge::upsert_connection(
        bridge,
        ConnectionRecord::Mysql(record(id, safe_mode)),
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

/// ⌘E: an estimate runs nothing (even for a write), a timed read runs and
/// says what each step took, and a timed write is refused because MySQL
/// can't roll back what ANALYZE ran.
#[test]
fn mysql_plans_read_as_steps_and_never_run_writes() {
    let (_guard, _file, _path) = test_guard();
    let bridge = super::super::CoreBridge::spawn();
    save_mysql(&bridge, "my-plan", SafeMode::Off);
    bridge.open_window("w", "my-plan", None).expect("open");
    let (_, error, _) = rows_of(
        &bridge,
        "w",
        1,
        "DROP TABLE IF EXISTS bw_plan; CREATE TABLE bw_plan (id INT PRIMARY KEY, n INT);
         INSERT INTO bw_plan VALUES (1, 1), (2, 2), (3, 3), (4, 4)",
    );
    assert_eq!(error, None);

    let out = bridge
        .explain(
            "w",
            1,
            "SELECT * FROM bw_plan WHERE n = 2".into(),
            false,
            false,
        )
        .expect("estimate");
    let ExplainOutcome::Plan { plan, .. } = out else {
        panic!("{out:?}")
    };
    assert!(!plan.timed);
    let scan = plan
        .steps
        .iter()
        .find(|s| s.table.as_deref() == Some("bw_plan"))
        .unwrap_or_else(|| panic!("{plan:?}"));
    assert_eq!(scan.kind, "Table scan", "{plan:?}");

    let out = bridge
        .explain(
            "w",
            1,
            "SELECT * FROM bw_plan WHERE n > 1".into(),
            true,
            false,
        )
        .expect("timed");
    let ExplainOutcome::Plan { plan, .. } = out else {
        panic!("{out:?}")
    };
    assert!(plan.timed, "{plan:?}");
    assert!(plan.steps.iter().any(|s| s.own_ms.is_some()), "{plan:?}");

    // The estimate of a write runs nothing.
    let out = bridge
        .explain(
            "w",
            1,
            "DELETE FROM bw_plan WHERE id = 1".into(),
            false,
            false,
        )
        .expect("write estimate");
    assert!(matches!(out, ExplainOutcome::Plan { .. }), "{out:?}");
    let err = bridge
        .explain(
            "w",
            1,
            "DELETE FROM bw_plan WHERE id = 1".into(),
            true,
            true,
        )
        .expect_err("timed write");
    assert!(err.contains("can't roll it back"), "{err}");
    let (rows, _, _) = rows_of(&bridge, "w", 1, "SELECT count(*) FROM bw_plan");
    assert_eq!(rows, [[Value::Int(4)]]);
    let err = bridge
        .explain("w", 1, "SELECT 1; SELECT 2".into(), false, false)
        .expect_err("two statements");
    assert_eq!(err, "Explain works on one statement at a time.");

    // A function that writes, reached while planning (a subquery the
    // optimizer evaluates) or timing: the plan's read-only transaction
    // stops it, on every server.
    trust_function_creators();
    let (_, error, _) = rows_of(
        &bridge,
        "w",
        1,
        "DROP FUNCTION IF EXISTS bw_plan_w;
         CREATE FUNCTION bw_plan_w() RETURNS INT NOT DETERMINISTIC MODIFIES SQL DATA
         BEGIN INSERT INTO bw_plan VALUES (100 + (SELECT count(*) FROM bw_plan), 0); RETURN 1; END",
    );
    assert_eq!(error, None);
    for (sql, timed) in [
        (
            "SELECT * FROM bw_plan WHERE id = (SELECT max(id) FROM bw_plan WHERE bw_plan_w() = 1)",
            false,
        ),
        ("SELECT bw_plan_w()", true),
    ] {
        let err = bridge
            .explain("w", 1, sql.into(), timed, false)
            .expect_err(sql);
        assert_eq!(err, crate::PLAN_WOULD_WRITE, "{sql}");
    }
    // A write's plan can't be read-only: one calling a function isn't run.
    let err = bridge
        .explain(
            "w",
            1,
            "DELETE FROM bw_plan WHERE id = bw_plan_w()".into(),
            false,
            false,
        )
        .expect_err("write calling a function");
    assert_eq!(err, crate::mysql::PLAN_WRITE_CALLS);
    let (rows, _, _) = rows_of(&bridge, "w", 1, "SELECT count(*) FROM bw_plan");
    assert_eq!(rows, [[Value::Int(4)]]);
    assert!(bridge.open_transactions().is_empty());

    // Inside the tab's own transaction it would commit it: refused.
    assert_eq!(rows_of(&bridge, "w", 1, "BEGIN").1, None);
    let err = bridge
        .explain("w", 1, "SELECT * FROM bw_plan".into(), false, false)
        .expect_err("in a transaction");
    assert_eq!(err, crate::mysql::PLAN_IN_TXN);
    assert_eq!(bridge.open_transactions(), [("w".to_string(), 1)]);
    assert_eq!(rows_of(&bridge, "w", 1, "ROLLBACK").1, None);
    // A server set to another plan form still reads.
    // (8.3+ only; elsewhere these SETs fail and change nothing.)
    rows_of(
        &bridge,
        "w",
        1,
        "SET SESSION explain_json_format_version = 2",
    );
    assert!(matches!(
        bridge.explain(
            "w",
            1,
            "SELECT * FROM bw_plan WHERE n > 1".into(),
            false,
            false
        ),
        Ok(ExplainOutcome::Plan { .. })
    ));
    if env("ROWKERY_MYSQL_PORT", "") == "33084" {
        let (rows, _, _) = rows_of(
            &bridge,
            "w",
            1,
            "SELECT @@SESSION.explain_json_format_version",
        );
        assert_eq!(rows, [[Value::Int(2)]], "put back");
    }
    rows_of(&bridge, "w", 1, "SET SESSION explain_format = JSON");
    assert!(matches!(
        bridge.explain(
            "w",
            1,
            "SELECT * FROM bw_plan WHERE n > 1".into(),
            true,
            false
        ),
        Ok(ExplainOutcome::Plan { .. })
    ));
    bridge.close_window("w");
    std::env::remove_var("ROWKERY_CONFIG_DIR");
}

/// The Sessions tab on MySQL: our tabs are labelled, a blocked statement
/// is cancelled with `KILL QUERY`, ending a session asks first (`KILL`),
/// and a read-only connection refuses both. Run as a login with PROCESS
/// (`ROWKERY_MYSQL_USER=root`), it also says who blocks whom.
#[test]
fn mysql_sessions_list_ours_and_stop_through_safe_mode() {
    let (_guard, _file, _path) = test_guard();
    let bridge = super::super::CoreBridge::spawn();
    save_mysql(&bridge, "my-sessions", SafeMode::Off);
    bridge.open_window("w", "my-sessions", None).expect("open");
    rows_of(
        &bridge,
        "w",
        1,
        "DROP TABLE IF EXISTS bw_sess; CREATE TABLE bw_sess (id INT PRIMARY KEY, n INT) ENGINE=InnoDB;
         INSERT INTO bw_sess VALUES (1, 0)",
    );
    let (_, error, _) = rows_of(
        &bridge,
        "w",
        1,
        "BEGIN; SELECT n FROM bw_sess WHERE id = 1 FOR UPDATE",
    );
    assert_eq!(error, None);
    let blocked = bridge
        .run_window_query(
            "w",
            2,
            "UPDATE bw_sess SET n = 2 WHERE id = 1".into(),
            None,
            false,
        )
        .expect("run");
    let tab_row = |rows: &[SessionRow], tab: u64| {
        rows.iter()
            .find(|r| {
                r.tab
                    .as_ref()
                    .is_some_and(|t| t.window_id == "w" && t.tab_id == tab)
            })
            .cloned()
    };
    // The UPDATE shows up waiting.
    let deadline = Instant::now() + Duration::from_secs(10);
    let (holder, waiter) = loop {
        let rows = bridge.sessions("w").expect("sessions");
        if let (Some(h), Some(w)) = (tab_row(&rows, 1), tab_row(&rows, 2)) {
            if w.session
                .query
                .as_deref()
                .is_some_and(|q| q.contains("UPDATE"))
            {
                break (h, w);
            }
        }
        assert!(Instant::now() < deadline, "{rows:?}");
        thread::sleep(Duration::from_millis(100));
    };
    assert_eq!(waiter.session.state.as_deref(), Some("active"));
    assert!(holder.session.can_stop && waiter.session.can_stop);
    // Without PROCESS the server hides transactions; root has it.
    let process = env("ROWKERY_MYSQL_USER", "rowkery") == "root";
    assert_eq!(holder.session.xact_secs.is_some(), process, "{holder:?}");
    if process {
        assert_eq!(holder.session.state.as_deref(), Some("idle in transaction"));
        assert_eq!(waiter.session.blocked_by, [holder.session.pid]);
        assert!(
            waiter
                .session
                .wait
                .as_deref()
                .is_some_and(|w| w.starts_with("Lock: ")),
            "{waiter:?}"
        );
    }

    // Cancel stops the UPDATE; its tab stays.
    let out = bridge
        .stop_session("w", waiter.session.pid, StopKind::Cancel, false)
        .expect("cancel");
    assert_eq!(out, StopOutcome::Stopped { gone: false });
    let (_, error, cancelled) = wait_finished(&blocked);
    assert!(cancelled || error.is_some(), "{error:?}");
    assert_eq!(rows_of(&bridge, "w", 2, "SELECT 4").0, [[Value::Int(4)]]);

    // Ending a session asks first, with exactly what runs.
    let pid = holder.session.pid;
    let out = bridge
        .stop_session("w", pid, StopKind::End, false)
        .expect("end");
    assert_eq!(
        out,
        StopOutcome::Held {
            sql: format!("KILL {pid}")
        }
    );
    let out = bridge
        .stop_session("w", pid, StopKind::End, true)
        .expect("end");
    assert_eq!(out, StopOutcome::Stopped { gone: false });
    // Its transaction rolled back: the row is free for another tab.
    let (_, error, _) = rows_of(&bridge, "w", 2, "UPDATE bw_sess SET n = 3 WHERE id = 1");
    assert_eq!(error, None);
    let out = bridge
        .stop_session("w", pid, StopKind::End, true)
        .expect("end again");
    assert_eq!(out, StopOutcome::Stopped { gone: true });
    bridge.close_window("w");

    save_mysql(&bridge, "my-sessions-ro", SafeMode::ReadOnly);
    bridge
        .open_window("r", "my-sessions-ro", None)
        .expect("open");
    for kind in [StopKind::Cancel, StopKind::End] {
        let out = bridge.stop_session("r", 1, kind, true).expect("stop");
        assert!(matches!(out, StopOutcome::Refused { .. }), "{out:?}");
    }
    std::env::remove_var("ROWKERY_CONFIG_DIR");
}

/// How a run ended: its error, or `held: …` when safe mode stopped it.
fn ended(queue: &EventQueue) -> Option<String> {
    let deadline = Instant::now() + Duration::from_secs(20);
    loop {
        let drained: Vec<CoreEvent> = std::mem::take(&mut *queue.lock().unwrap());
        for event in drained {
            match event {
                CoreEvent::QueryFinished { error, .. } => return error,
                CoreEvent::QueryHeld { hold, .. } => {
                    return Some(format!("held: {:?}", hold.action))
                }
                _ => {}
            }
        }
        assert!(Instant::now() < deadline, "not done");
        thread::sleep(Duration::from_millis(5));
    }
}

/// After `SET NAMES gbk` the server reads the UTF-8 bytes of `日\\` (E6 97
/// A5 5C 5C) as two characters and a `\`, which escapes the quote after
/// it: the string goes on, and the DELETE that UTF-8 reads inside the next
/// string really runs (shown with safe mode off). With safe mode on, a tab
/// never gets there: `SET NAMES gbk` is refused, and a switch it can't see
/// (a prepared statement) is undone before the next statement runs.
#[test]
fn mysql_wide_charsets_never_hide_a_write() {
    let (_guard, _file, _path) = test_guard();
    let bridge = super::super::CoreBridge::spawn();
    let attack = "SELECT '日\\\\' '; DELETE FROM bw_gbk; -- '";
    save_mysql(&bridge, "my-gbk-off", SafeMode::Off);
    bridge.open_window("w", "my-gbk-off", None).expect("open");
    rows_of(
        &bridge,
        "w",
        1,
        "DROP TABLE IF EXISTS bw_gbk; CREATE TABLE bw_gbk (id INT); INSERT INTO bw_gbk VALUES (1)",
    );
    assert_eq!(rows_of(&bridge, "w", 1, "SET NAMES gbk").1, None);
    rows_of(&bridge, "w", 1, attack);
    let (rows, _, _) = rows_of(&bridge, "w", 2, "SELECT count(*) FROM bw_gbk");
    assert_eq!(rows, [[Value::Int(0)]], "the server ran the hidden DELETE");
    rows_of(&bridge, "w", 2, "INSERT INTO bw_gbk VALUES (1)");
    rows_of(&bridge, "w", 1, "SET NAMES macroman");
    rows_of(
        &bridge,
        "w",
        1,
        "SELECT 1 --好 '\n; DELETE FROM bw_gbk; -- '",
    );
    let (rows, _, _) = rows_of(&bridge, "w", 2, "SELECT count(*) FROM bw_gbk");
    assert_eq!(rows, [[Value::Int(0)]], "macroman hid the DELETE too");
    rows_of(&bridge, "w", 2, "INSERT INTO bw_gbk VALUES (1)");
    bridge.close_window("w");

    for mode in [SafeMode::Confirm, SafeMode::ReadOnly] {
        save_mysql(&bridge, "my-gbk", mode);
        bridge.open_window("c", "my-gbk", None).expect("open");
        // However the switch is spelled, it ends the run, and the session
        // is utf8mb4 again before the text after it is sent.
        for switch in [
            "SET NAMES gbk",
            "SET NAMES/**/gbk",
            "SET @a = '\\'', character_set_client = gbk",
        ] {
            let sql = format!("{switch}; {attack}");
            let queue = bridge
                .run_window_query("c", 1, sql.clone(), None, true)
                .expect("run");
            let error = ended(&queue);
            // (Read-only refuses text it can't read for sure outright.)
            assert!(
                error
                    .as_deref()
                    .is_some_and(|e| e.contains("set it back to utf8mb4") || e == "held: Refuse"),
                "{mode:?} {sql}: {error:?}"
            );
            let (rows, _, _) = rows_of(&bridge, "c", 1, "SELECT @@SESSION.character_set_client");
            assert_eq!(rows, [[Value::Text("utf8mb4".into())]]);
            let (rows, _, _) = rows_of(&bridge, "c", 2, "SELECT count(*) FROM bw_gbk");
            assert_eq!(rows, [[Value::Int(1)]], "{mode:?} {sql}");
        }
        // Not only the wide sets: under macroman a UTF-8 byte after `--`
        // starts a comment, which hid the DELETE on the next line.
        let sql = "SET NAMES macroman; SELECT 1 --好 '\n; DELETE FROM bw_gbk; -- '";
        let queue = bridge
            .run_window_query("c", 1, sql.into(), None, true)
            .expect("run");
        let error = ended(&queue);
        assert!(
            error
                .as_deref()
                .is_some_and(|e| e.contains("set it back to utf8mb4") || e == "held: Refuse"),
            "{mode:?} {sql}: {error:?}"
        );
        let (rows, _, _) = rows_of(&bridge, "c", 2, "SELECT count(*) FROM bw_gbk");
        assert_eq!(rows, [[Value::Int(1)]], "{mode:?} {sql}");
        // A switch in its own run is put back when the run ends.
        if mode == SafeMode::Confirm {
            let queue = bridge
                .run_window_query(
                    "c",
                    1,
                    "PREPARE s FROM 'SET NAMES gbk'; EXECUTE s".into(),
                    None,
                    true,
                )
                .expect("run");
            let error = ended(&queue);
            assert!(
                error.as_deref().is_some_and(|e| e.contains("set it back")),
                "{error:?}"
            );
        }
        let (rows, _, _) = rows_of(&bridge, "c", 1, "SELECT @@SESSION.character_set_client");
        assert_eq!(rows, [[Value::Text("utf8mb4".into())]]);
        bridge.close_window("c");
    }
    std::env::remove_var("ROWKERY_CONFIG_DIR");
}

/// MySQL and MariaDB start a `--` comment before DEL (0x7F) as well as
/// before a space, so the quote after it is commented out and the next line
/// is SQL. Safe mode reads it the same way and sees the DELETE.
#[test]
fn mysql_dash_dash_before_del_is_a_comment() {
    let (_guard, _file, _path) = test_guard();
    let bridge = super::super::CoreBridge::spawn();
    let attack =
        "SELECT 1 --\x7f '\n; SET SESSION TRANSACTION READ WRITE; DELETE FROM bw_del; -- '";
    save_mysql(&bridge, "my-del-off", SafeMode::Off);
    bridge.open_window("w", "my-del-off", None).expect("open");
    rows_of(
        &bridge,
        "w",
        1,
        "DROP TABLE IF EXISTS bw_del; CREATE TABLE bw_del (id INT); INSERT INTO bw_del VALUES (1)",
    );
    rows_of(&bridge, "w", 1, attack);
    let (rows, _, _) = rows_of(&bridge, "w", 2, "SELECT count(*) FROM bw_del");
    assert_eq!(rows, [[Value::Int(0)]], "the server ran the DELETE");
    rows_of(&bridge, "w", 2, "INSERT INTO bw_del VALUES (1)");
    bridge.close_window("w");

    for mode in [SafeMode::Confirm, SafeMode::ReadOnly] {
        save_mysql(&bridge, "my-del", mode);
        bridge.open_window("c", "my-del", None).expect("open");
        let queue = bridge
            .run_window_query("c", 1, attack.into(), None, false)
            .expect("run");
        let outcome = ended(&queue);
        // Confirm asks first; read-only refuses outright.
        let want = if mode == SafeMode::Confirm {
            "held: Confirm"
        } else {
            "held: Refuse"
        };
        assert_eq!(outcome.as_deref(), Some(want), "{mode:?}");
        let (rows, _, _) = rows_of(&bridge, "c", 2, "SELECT count(*) FROM bw_del");
        assert_eq!(rows, [[Value::Int(1)]], "{mode:?}");
        bridge.close_window("c");
    }
    std::env::remove_var("ROWKERY_CONFIG_DIR");
}

/// MariaDB's sql_mode MSSQL reads `[…]` as a quoted name, so `[']` holds
/// a quote safe mode would read as a string's start. A bare `[` is unclear
/// in safe mode: the DELETE behind it is held, not run.
#[test]
fn mysql_brackets_never_hide_a_write() {
    if env("ROWKERY_MYSQL_FLAVOR", "") != "mariadb" {
        return; // MySQL 8 has no MSSQL mode.
    }
    let (_guard, _file, _path) = test_guard();
    let bridge = super::super::CoreBridge::spawn();
    let attack = "SET SESSION sql_mode = 'MSSQL'; SELECT 1 AS [']; SET SESSION TRANSACTION READ WRITE; DELETE FROM bw_br; SELECT [']";
    save_mysql(&bridge, "my-br-off", SafeMode::Off);
    bridge.open_window("w", "my-br-off", None).expect("open");
    rows_of(
        &bridge,
        "w",
        1,
        "DROP TABLE IF EXISTS bw_br; CREATE TABLE bw_br (id INT); INSERT INTO bw_br VALUES (1)",
    );
    let queue = bridge
        .run_window_query("w", 1, attack.into(), None, false)
        .expect("run");
    ended(&queue);
    let (rows, _, _) = rows_of(&bridge, "w", 2, "SELECT count(*) FROM bw_br");
    assert_eq!(rows, [[Value::Int(0)]], "the server ran the DELETE");
    rows_of(&bridge, "w", 2, "INSERT INTO bw_br VALUES (1)");
    bridge.close_window("w");

    for mode in [SafeMode::Confirm, SafeMode::ReadOnly] {
        save_mysql(&bridge, "my-br", mode);
        bridge.open_window("c", "my-br", None).expect("open");
        let queue = bridge
            .run_window_query("c", 1, attack.into(), None, false)
            .expect("run");
        let outcome = ended(&queue);
        let want = if mode == SafeMode::Confirm {
            "held: Confirm"
        } else {
            "held: Refuse"
        };
        assert_eq!(outcome.as_deref(), Some(want), "{mode:?}");
        let (rows, _, _) = rows_of(&bridge, "c", 2, "SELECT count(*) FROM bw_br");
        assert_eq!(rows, [[Value::Int(1)]], "{mode:?}");
        bridge.close_window("c");
    }
    std::env::remove_var("ROWKERY_CONFIG_DIR");
}

/// Read-only on MySQL: `INTO OUTFILE` after `TABLE`, `VALUES` or `(SELECT …)`
/// is refused like any other, and a read calling a stored function is
/// refused (a read-only transaction doesn't stop `SET GLOBAL` or a file
/// write inside one); built-ins still run.
#[test]
fn mysql_read_only_refuses_files_and_stored_functions() {
    let (_guard, _file, _path) = test_guard();
    trust_function_creators();
    let bridge = super::super::CoreBridge::spawn();
    save_mysql(&bridge, "my-ro-setup", SafeMode::Off);
    bridge.open_window("w", "my-ro-setup", None).expect("open");
    rows_of(&bridge, "w", 1, "DROP FUNCTION IF EXISTS bw_ro_fn");
    rows_of(
        &bridge,
        "w",
        1,
        "CREATE FUNCTION bw_ro_fn() RETURNS INT DETERMINISTIC RETURN 1",
    );
    rows_of(
        &bridge,
        "w",
        1,
        "DROP TABLE IF EXISTS bw_ro; CREATE TABLE bw_ro (id INT); INSERT INTO bw_ro VALUES (1), (2), (3)",
    );
    // Names a lexer could read as something else: a Postgres built-in's,
    // a keyword's, a leading digit or `$`.
    for name in ["age", "ilike", "`9bw`", "`$bwz`"] {
        rows_of(&bridge, "w", 1, &format!("DROP FUNCTION IF EXISTS {name}"));
        let (_, error, _) = rows_of(
            &bridge,
            "w",
            1,
            &format!("CREATE FUNCTION {name}() RETURNS INT DETERMINISTIC RETURN 1"),
        );
        assert_eq!(error, None, "{name}");
    }
    let (_, error, _) = rows_of(
        &bridge,
        "w",
        1,
        "CREATE OR REPLACE VIEW bw_ro_v AS SELECT bw_ro_fn() AS a FROM dual;
         CREATE OR REPLACE VIEW bw_ro_v2 AS SELECT a FROM bw_ro_v",
    );
    assert_eq!(error, None);
    // Packages outside Oracle mode came with MariaDB 11.4: on 10.11 the
    // CREATE fails, and those calls aren't tried.
    let mut packages = env("ROWKERY_MYSQL_FLAVOR", "") == "mariadb";
    if packages {
        let (_, error, _) = rows_of(
            &bridge,
            "w",
            1,
            "CREATE OR REPLACE PACKAGE bw_pkg FUNCTION pf() RETURNS INT; END;
             CREATE OR REPLACE PACKAGE BODY bw_pkg FUNCTION pf() RETURNS INT RETURN 1; END",
        );
        packages = error.is_none();
    }
    bridge.close_window("w");

    save_mysql(&bridge, "my-ro", SafeMode::ReadOnly);
    bridge.open_window("c", "my-ro", None).expect("open");
    let outcome = |sql: &str| {
        ended(
            &bridge
                .run_window_query("c", 1, sql.into(), None, true)
                .expect("run"),
        )
    };
    for sql in [
        "TABLE bw_ro INTO OUTFILE '/tmp/bw_ro_x'",
        "(SELECT 1) INTO OUTFILE '/tmp/bw_ro_x'",
        "VALUES (1) INTO OUTFILE '/tmp/bw_ro_x'",
    ] {
        assert_eq!(outcome(sql).as_deref(), Some("held: Refuse"), "{sql}");
    }
    for sql in [
        "SELECT bw_ro_fn()",
        "SELECT `bw_ro_fn`() FROM bw_ro",
        "SELECT rowkery.bw_ro_fn()",
        "SET @x = bw_ro_fn()",
        "SELECT age()",
        "SELECT ilike()",
        "SELECT 9bw()",
        "SELECT $bwz()",
        "SELECT bw_ro_fn/* c */()",
        "SELECT * FROM bw_ro_v",
        "SELECT * FROM rowkery.bw_ro_v2",
    ] {
        let error = outcome(sql);
        assert!(
            error
                .as_deref()
                .is_some_and(|e| e.contains("calls the function")),
            "{sql}: {error:?}"
        );
    }
    if packages {
        for sql in ["SELECT bw_pkg.pf()", "SELECT rowkery.bw_pkg.pf()"] {
            let error = outcome(sql);
            assert!(
                error
                    .as_deref()
                    .is_some_and(|e| e.contains("calls the function")),
                "{sql}: {error:?}"
            );
        }
    }
    let (rows, _, _) = rows_of(
        &bridge,
        "c",
        1,
        "SELECT CONCAT('a', 'b'), DATE_FORMAT(NOW(), '%Y') > '2000', JSON_EXTRACT('[1]', '$[0]')",
    );
    assert_eq!(rows[0][0], Value::Text("ab".into()));
    // The check runs once, before the run: it doesn't reset FOUND_ROWS()
    // between its statements.
    let (rows, error, _) = rows_of(
        &bridge,
        "c",
        1,
        "SELECT SQL_CALC_FOUND_ROWS * FROM bw_ro LIMIT 1; SELECT FOUND_ROWS()",
    );
    assert_eq!(error, None);
    assert_eq!(
        rows.last().map(|r| r[0].clone()),
        Some(Value::Int(3)),
        "{rows:?}"
    );
    bridge.close_window("c");

    save_mysql(&bridge, "my-ro-setup", SafeMode::Off);
    bridge.open_window("w", "my-ro-setup", None).expect("open");
    rows_of(
        &bridge,
        "w",
        1,
        "DROP VIEW IF EXISTS bw_ro_v2; DROP VIEW IF EXISTS bw_ro_v; DROP FUNCTION IF EXISTS age;
         DROP FUNCTION IF EXISTS ilike; DROP FUNCTION IF EXISTS `9bw`; DROP FUNCTION IF EXISTS `$bwz`",
    );
    if packages {
        rows_of(&bridge, "w", 1, "DROP PACKAGE IF EXISTS bw_pkg");
    }
    bridge.close_window("w");
    std::env::remove_var("ROWKERY_CONFIG_DIR");
}
