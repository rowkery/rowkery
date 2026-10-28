use super::*;
use rowkery_core::connections::{
    PostgresConnection, PostgresSslMode, SqliteConnection, SshAuthMethod, SshConfig,
};
use rowkery_core::db::Value;
use rowkery_core::secrets::ConnectionSecrets;
use rusqlite::Connection;
use std::fs;
use std::sync::{Mutex, MutexGuard};
use tempfile::NamedTempFile;

static TEST_DIR_LOCK: Mutex<()> = Mutex::new(());

/// Force stop sends no cancel request of the tab's own (see `force_stop`).
pub(super) static NO_TOKEN_CANCEL: AtomicBool = AtomicBool::new(false);

fn test_guard() -> (MutexGuard<'static, ()>, NamedTempFile, String) {
    let guard = TEST_DIR_LOCK.lock().unwrap_or_else(|e| e.into_inner());
    let dir = std::env::temp_dir().join(format!("rowkery-bridge-test-{}", std::process::id()));
    let _ = fs::remove_dir_all(&dir);
    fs::create_dir_all(&dir).expect("mkdir");
    std::env::set_var("ROWKERY_CONFIG_DIR", dir.to_string_lossy().to_string());
    let file = NamedTempFile::new_in(dir).expect("temp db");
    let path = file.path().to_string_lossy().to_string();
    let conn = Connection::open(file.path()).expect("open");
    conn.execute_batch("CREATE TABLE t (id INTEGER); INSERT INTO t VALUES (1);")
        .expect("schema");
    (guard, file, path)
}

#[test]
fn ping_round_trip() {
    let bridge = super::CoreBridge::spawn();
    assert_eq!(bridge.ping(), Some(Event::Pong));
}

/// Regression: nested `Runtime::block_on` on `rowkery-core` panicked with
/// "Cannot start a runtime from within a runtime" (Save & connect).
#[test]
fn postgres_connect_no_server_returns_error_without_panic() {
    let (_guard, _file, _path) = test_guard();
    let bridge = super::CoreBridge::spawn();
    let id = "postgres-down";
    CoreBridge::upsert_connection(
        &bridge,
        ConnectionRecord::Postgres(PostgresConnection {
            environment: None,
            safe_mode: Default::default(),
            allow_mcp: false,
            mcp_hidden_tables: Vec::new(),
            mcp_until: None,
            mcp_samples_off: false,
            mcp_timeout_s: None,
            mcp_access: None,
            masked_columns: Default::default(),
            id: id.into(),
            name: "down".into(),
            host: "127.0.0.1".into(),
            port: 5439,
            database: "postgres".into(),
            username: "postgres".into(),
            ssl_mode: PostgresSslMode::Disable,
            ssl_root_cert: None,
            ssh: None,
            cloud_sql: None,
        }),
        ConnectionSecrets::default(),
    )
    .expect("save");
    let err = bridge
        .open_window("w1", id, None)
        .expect_err("should not connect");
    assert!(
        !err.is_empty(),
        "expected a human-readable error, got empty string"
    );
    std::env::remove_var("ROWKERY_CONFIG_DIR");
}

/// Secrets are stored by the caller (not the core thread) before the
/// record, and removed with it.
#[test]
fn save_and_delete_connection_store_and_remove_secrets() {
    use rowkery_core::secrets::{get_secret, SecretKind};
    let (_guard, _file, _path) = test_guard();
    let bridge = super::CoreBridge::spawn();
    let id = "pg-secret";
    CoreBridge::upsert_connection(
        &bridge,
        ConnectionRecord::Postgres(PostgresConnection {
            allow_mcp: false,
            mcp_hidden_tables: Vec::new(),
            mcp_until: None,
            mcp_samples_off: false,
            mcp_timeout_s: None,
            mcp_access: None,
            masked_columns: Default::default(),
            environment: None,
            safe_mode: Default::default(),
            id: id.into(),
            name: "secret".into(),
            host: "127.0.0.1".into(),
            port: 5432,
            database: "postgres".into(),
            username: "postgres".into(),
            ssl_mode: PostgresSslMode::Disable,
            ssl_root_cert: None,
            ssh: None,
            cloud_sql: None,
        }),
        ConnectionSecrets {
            db_password: Some("hunter2".into()),
            ..Default::default()
        },
    )
    .expect("save");
    assert_eq!(
        get_secret(id, SecretKind::DbPassword).unwrap().as_deref(),
        Some("hunter2")
    );
    assert!(CoreBridge::list_connections(&bridge)
        .iter()
        .any(|c| c.id() == id));

    bridge.remove_connection(id, false).expect("delete");
    assert!(CoreBridge::list_connections(&bridge).is_empty());
    assert_eq!(get_secret(id, SecretKind::DbPassword).unwrap(), None);
    std::env::remove_var("ROWKERY_CONFIG_DIR");
}

/// A connection moved from a service account key to the gcloud login
/// drops the key.
#[test]
fn switching_off_a_key_deletes_it() {
    use rowkery_core::connections::{CloudSqlConfig, CloudSqlIpType};
    use rowkery_core::secrets::{get_secret, SecretKind};
    let (_guard, _file, _path) = test_guard();
    let bridge = super::CoreBridge::spawn();
    let id = "pg-cloudsql-key";
    let record = |credentials| {
        ConnectionRecord::Postgres(PostgresConnection {
            allow_mcp: false,
            mcp_hidden_tables: Vec::new(),
            mcp_until: None,
            mcp_samples_off: false,
            mcp_timeout_s: None,
            mcp_access: None,
            masked_columns: Default::default(),
            environment: None,
            safe_mode: Default::default(),
            id: id.into(),
            name: "orders".into(),
            host: "acme:asia-southeast1:orders".into(),
            port: 5432,
            database: "postgres".into(),
            username: "postgres".into(),
            ssl_mode: PostgresSslMode::Disable,
            ssl_root_cert: None,
            ssh: None,
            cloud_sql: Some(CloudSqlConfig {
                instance: "acme:asia-southeast1:orders".into(),
                ip_type: CloudSqlIpType::Public,
                credentials,
            }),
        })
    };
    CoreBridge::upsert_connection(
        &bridge,
        record(CloudSqlCredentials::Key),
        ConnectionSecrets {
            gcp_key: Some("{\"type\":\"service_account\"}".into()),
            ..Default::default()
        },
    )
    .expect("save");
    assert!(get_secret(id, SecretKind::GcpKey).unwrap().is_some());
    CoreBridge::upsert_connection(
        &bridge,
        record(CloudSqlCredentials::Gcloud),
        ConnectionSecrets::default(),
    )
    .expect("save");
    assert_eq!(get_secret(id, SecretKind::GcpKey).unwrap(), None);
    std::env::remove_var("ROWKERY_CONFIG_DIR");
}

#[test]
fn postgres_connect_empty_name_rejected_at_core() {
    let (_guard, _file, _path) = test_guard();
    let bridge = super::CoreBridge::spawn();
    let id = "postgres-noname";
    CoreBridge::upsert_connection(
        &bridge,
        ConnectionRecord::Postgres(PostgresConnection {
            environment: None,
            safe_mode: Default::default(),
            allow_mcp: false,
            mcp_hidden_tables: Vec::new(),
            mcp_until: None,
            mcp_samples_off: false,
            mcp_timeout_s: None,
            mcp_access: None,
            masked_columns: Default::default(),
            id: id.into(),
            name: String::new(),
            host: "127.0.0.1".into(),
            port: 5432,
            database: "postgres".into(),
            username: "postgres".into(),
            ssl_mode: PostgresSslMode::Disable,
            ssl_root_cert: None,
            ssh: None,
            cloud_sql: None,
        }),
        ConnectionSecrets::default(),
    )
    .expect("save");
    let err = bridge
        .open_window("w1", id, None)
        .expect_err("should not connect");
    assert!(err.contains("Name"), "expected name validation, got: {err}");
    std::env::remove_var("ROWKERY_CONFIG_DIR");
}

#[test]
fn postgres_connect_incomplete_ssh_returns_error_without_panic() {
    let (_guard, _file, _path) = test_guard();
    let bridge = super::CoreBridge::spawn();
    let id = "postgres-bad-ssh";
    CoreBridge::upsert_connection(
        &bridge,
        ConnectionRecord::Postgres(PostgresConnection {
            environment: None,
            safe_mode: Default::default(),
            allow_mcp: false,
            mcp_hidden_tables: Vec::new(),
            mcp_until: None,
            mcp_samples_off: false,
            mcp_timeout_s: None,
            mcp_access: None,
            masked_columns: Default::default(),
            id: id.into(),
            name: "bad ssh".into(),
            host: "localhost".into(),
            port: 5432,
            database: "postgres".into(),
            username: "postgres".into(),
            ssl_mode: PostgresSslMode::Prefer,
            ssl_root_cert: None,
            ssh: Some(SshConfig {
                host: String::new(),
                port: 22,
                username: String::new(),
                auth_method: SshAuthMethod::KeyFile,
                private_key_path: None,
                trust_host: false,
            }),
            cloud_sql: None,
        }),
        ConnectionSecrets::default(),
    )
    .expect("save");
    let err = bridge
        .open_window("w1", id, None)
        .expect_err("should not connect");
    assert!(
        !err.is_empty(),
        "expected a human-readable error, got empty string"
    );
    std::env::remove_var("ROWKERY_CONFIG_DIR");
}

#[test]
fn sqlite_introspect_via_bridge() {
    let (_guard, _file, path) = test_guard();
    let bridge = super::CoreBridge::spawn();
    let id = "sqlite-introspect";
    CoreBridge::upsert_connection(
        &bridge,
        ConnectionRecord::Sqlite(SqliteConnection {
            environment: None,
            safe_mode: Default::default(),
            allow_mcp: false,
            mcp_hidden_tables: Vec::new(),
            mcp_until: None,
            mcp_samples_off: false,
            mcp_timeout_s: None,
            mcp_access: None,
            masked_columns: Default::default(),
            id: id.into(),
            name: "test".into(),
            path,
            sample: false,
        }),
        ConnectionSecrets::default(),
    )
    .expect("save");
    let opened = bridge.open_window("w1", id, None).expect("open");
    assert!(opened.catalog.find_table("main", "main", "t").is_some());
    let reloaded = bridge.reload_window_schema("w1").expect("reload");
    assert!(reloaded.find_table("main", "main", "t").is_some());
    std::env::remove_var("ROWKERY_CONFIG_DIR");
}

#[test]
fn sqlite_query_via_bridge() {
    let (_guard, _file, path) = test_guard();
    let bridge = super::CoreBridge::spawn();
    let id = "sqlite-test";
    CoreBridge::upsert_connection(
        &bridge,
        ConnectionRecord::Sqlite(SqliteConnection {
            environment: None,
            safe_mode: Default::default(),
            allow_mcp: false,
            mcp_hidden_tables: Vec::new(),
            mcp_until: None,
            mcp_samples_off: false,
            mcp_timeout_s: None,
            mcp_access: None,
            masked_columns: Default::default(),
            id: id.into(),
            name: "test".into(),
            path,
            sample: false,
        }),
        ConnectionSecrets::default(),
    )
    .expect("save");
    bridge.open_window("w1", id, None).expect("open");
    let queue = bridge
        .run_window_query("w1", 1, "SELECT id FROM t".into(), None, false)
        .expect("run");
    let (rows, error, cancelled) = wait_finished(&queue);
    assert_eq!((rows, error, cancelled), (1, None, false));
    std::env::remove_var("ROWKERY_CONFIG_DIR");
}

fn wait_finished(queue: &EventQueue) -> (u64, Option<String>, bool) {
    for _ in 0..100 {
        let drained: Vec<CoreEvent> = std::mem::take(&mut *queue.lock().unwrap());
        for event in drained {
            if let CoreEvent::QueryFinished {
                row_count,
                error,
                cancelled,
                ..
            } = event
            {
                return (row_count, error, cancelled);
            }
        }
        thread::sleep(std::time::Duration::from_millis(20));
    }
    panic!("query did not finish");
}

/// Quick Look follows foreign keys in one call; a quote in a text key is
/// escaped, not run; NULL and a missing row give `None`.
#[test]
fn sqlite_follow_keys_finds_the_rows_keys_point_at() {
    let (_guard, _file, path) = test_guard();
    Connection::open(&path)
        .unwrap()
        .execute_batch(
            "CREATE TABLE kiosks (id INTEGER PRIMARY KEY, name TEXT, code TEXT);
                 INSERT INTO kiosks VALUES (7, 'Bangsar', 'it''s');",
        )
        .unwrap();
    let bridge = super::CoreBridge::spawn();
    let id = "sqlite-follow";
    CoreBridge::upsert_connection(
        &bridge,
        ConnectionRecord::Sqlite(SqliteConnection {
            environment: None,
            safe_mode: Default::default(),
            allow_mcp: false,
            mcp_hidden_tables: Vec::new(),
            mcp_until: None,
            mcp_samples_off: false,
            mcp_timeout_s: None,
            mcp_access: None,
            masked_columns: Default::default(),
            id: id.into(),
            name: "test".into(),
            path,
            sample: false,
        }),
        ConnectionSecrets::default(),
    )
    .expect("save");
    bridge.open_window("w1", id, None).expect("open");
    let look = |column: &str, value: Value| FollowLookup {
        schema: "main".into(),
        table: "kiosks".into(),
        column: column.into(),
        value,
    };
    let rows = bridge
        .follow_keys(
            "w1",
            vec![
                look("id", Value::Int(7)),
                look("code", Value::Text("it's".into())),
                look("code", Value::Text("x' OR '1'='1".into())),
                look("id", Value::Null),
                look("id", Value::Int(8)),
            ],
        )
        .expect("follow");
    let names: Vec<Option<Value>> = rows
        .iter()
        .map(|r| r.as_ref().map(|r| r.row[1].clone()))
        .collect();
    assert_eq!(
        names,
        [
            Some(Value::Text("Bangsar".into())),
            Some(Value::Text("Bangsar".into())),
            None,
            None,
            None
        ]
    );
    assert_eq!(rows[0].as_ref().unwrap().columns[1].name, "name");
    assert!(bridge.follow_keys("nope", vec![]).is_err());
    std::env::remove_var("ROWKERY_CONFIG_DIR");
}

/// Quick Look's Incoming counts the rows referencing a value, stopping
/// one past the cap; NULL can't be matched.
#[test]
fn sqlite_count_incoming_is_bounded() {
    let (_guard, _file, path) = test_guard();
    Connection::open(&path)
        .unwrap()
        .execute_batch(
            "CREATE TABLE sessions (id INTEGER PRIMARY KEY, kiosk_id INTEGER);
                 WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 150)
                 INSERT INTO sessions SELECT i, CASE WHEN i <= 2 THEN 7 ELSE 3 END FROM n;",
        )
        .unwrap();
    let bridge = super::CoreBridge::spawn();
    let id = "sqlite-incoming";
    CoreBridge::upsert_connection(
        &bridge,
        ConnectionRecord::Sqlite(SqliteConnection {
            allow_mcp: false,
            mcp_hidden_tables: Vec::new(),
            mcp_until: None,
            mcp_samples_off: false,
            mcp_timeout_s: None,
            mcp_access: None,
            masked_columns: Default::default(),
            environment: None,
            safe_mode: Default::default(),
            id: id.into(),
            name: "test".into(),
            path,
            sample: false,
        }),
        ConnectionSecrets::default(),
    )
    .expect("save");
    bridge.open_window("w1", id, None).expect("open");
    let look = |value: Value| FollowLookup {
        schema: "main".into(),
        table: "sessions".into(),
        column: "kiosk_id".into(),
        value,
    };
    let counts = bridge
        .count_incoming(
            "w1",
            vec![
                look(Value::Int(7)),
                look(Value::Int(3)),
                look(Value::Int(9)),
                look(Value::Null),
            ],
        )
        .expect("count");
    assert_eq!(
        counts,
        [Some(2), Some(super::INCOMING_CAP + 1), Some(0), None]
    );
    std::env::remove_var("ROWKERY_CONFIG_DIR");
}

/// Saving a connection is on disk when the call returns; UI state reaches
/// disk through the writer, and a restart reads both back.
#[test]
fn config_and_ui_state_survive_a_restart() {
    let (_guard, _file, path) = test_guard();
    let bridge = super::CoreBridge::spawn();
    assert_eq!(bridge.ui_state(), None);
    CoreBridge::upsert_connection(
        &bridge,
        ConnectionRecord::Sqlite(SqliteConnection {
            allow_mcp: false,
            mcp_hidden_tables: Vec::new(),
            mcp_until: None,
            mcp_samples_off: false,
            mcp_timeout_s: None,
            mcp_access: None,
            masked_columns: Default::default(),
            environment: None,
            safe_mode: Default::default(),
            id: "kept".into(),
            name: "kept".into(),
            path,
            sample: false,
        }),
        ConnectionSecrets::default(),
    )
    .expect("save");
    // On disk already, with no wait.
    assert_eq!(AppConfig::load().unwrap().connections.len(), 1);
    let ui = serde_json::json!({ "version": 1, "windows": [{ "connectionId": "kept", "tabs": [{ "sql": "select 1" }] }] });
    bridge.save_ui_state(ui.clone());
    assert_eq!(bridge.ui_state(), Some(ui.clone()));
    bridge.flush_config();
    drop(bridge);

    let again = super::CoreBridge::spawn();
    assert_eq!(again.ui_state(), Some(ui));
    assert_eq!(CoreBridge::list_connections(&again).len(), 1);
    // A theme change keeps the UI state in the file.
    again.save_theme(ThemePreference::Dark).expect("theme");
    let disk = AppConfig::load().unwrap();
    assert_eq!(disk.theme, ThemePreference::Dark);
    assert!(disk.ui.is_some());
    // So does the window-chrome switch, which the next launch reads.
    assert!(!again.get_config_blocking().unwrap().native_decorations);
    again.save_native_decorations(true).expect("decorations");
    let disk = AppConfig::load().unwrap();
    assert!(disk.native_decorations);
    assert!(disk.ui.is_some());
    drop(again);
    let third = super::CoreBridge::spawn();
    assert!(third.get_config_blocking().unwrap().native_decorations);
    std::env::remove_var("ROWKERY_CONFIG_DIR");
}

/// Regression: a config.json that didn't parse was replaced by the defaults
/// on the first UI-state write, losing every saved connection and tab. Now
/// it is set aside before anything writes, the user hears about it once,
/// and a connection this build can't read survives a launch that saves.
#[test]
fn a_config_it_cant_read_survives_a_launch() {
    let (_guard, _file, path) = test_guard();
    let dir = rowkery_core::config::config_dir();
    let config_json = dir.join("config.json");
    let broken = r#"{ "version": 2, "theme": "system", "connections": [ { "kind": "#;
    fs::write(&config_json, broken).unwrap();
    let bridge = super::CoreBridge::spawn();
    assert_eq!(bridge.first_run(), Ok(false));
    let notice = bridge.take_config_notice().expect("a notice");
    assert_eq!(bridge.take_config_notice(), None);
    let kept = notice.kept.expect("kept");
    bridge.save_ui_state(serde_json::json!({ "version": 1, "keys": {} }));
    bridge.flush_config();
    drop(bridge);
    assert_eq!(fs::read_to_string(&kept).unwrap(), broken);

    // One entry a newer build wrote beside one this build reads.
    let sqlite = format!(r#"{{ "kind": "sqlite", "id": "ok", "name": "ok", "path": {path:?} }}"#);
    let future = r#"{"kind":"mysql","id":"m1","name":"shop"}"#;
    fs::write(
        &config_json,
        format!(r#"{{ "version": 2, "theme": "system", "first_run_done": true, "connections": [{future}, {sqlite}] }}"#),
    )
    .unwrap();
    let bridge = super::CoreBridge::spawn();
    let listed = CoreBridge::list_connections(&bridge);
    assert_eq!(listed.iter().map(|c| c.id()).collect::<Vec<_>>(), ["ok"]);
    assert!(bridge.take_config_notice().is_some());
    bridge.save_theme(ThemePreference::Dark).expect("theme");
    drop(bridge);
    let raw = fs::read_to_string(&config_json).unwrap();
    assert!(raw.contains(r#""kind": "mysql""#), "{raw}");
    assert_eq!(AppConfig::load().unwrap().theme, ThemePreference::Dark);

    // A file it can't read at all: adding a connection is refused before
    // anything changes, so it isn't listed with nothing saved.
    fs::remove_file(&config_json).unwrap();
    fs::create_dir(&config_json).unwrap();
    let bridge = super::CoreBridge::spawn();
    assert!(bridge.take_config_notice().is_some());
    let record = ConnectionRecord::Sqlite(SqliteConnection {
        id: "new".into(),
        name: "new".into(),
        path: path.clone(),
        environment: None,
        safe_mode: Default::default(),
        sample: false,
        allow_mcp: false,
        mcp_hidden_tables: Vec::new(),
        mcp_until: None,
        mcp_samples_off: false,
        mcp_timeout_s: None,
        mcp_access: None,
        masked_columns: Default::default(),
    });
    let refused = bridge.upsert_connection(record, ConnectionSecrets::default());
    assert!(refused.is_err());
    assert!(CoreBridge::list_connections(&bridge).is_empty());
    assert!(config_json.is_dir());
    drop(bridge);
    fs::remove_dir(&config_json).unwrap();
    std::env::remove_var("ROWKERY_CONFIG_DIR");
}

/// First launch writes the sample and lists it; a second launch doesn't
/// bring a deleted sample back; "Open the sample database" does, and a
/// reset puts its rows back.
#[test]
fn the_sample_database_on_first_run_open_and_reset() {
    let (_guard, _file, _path) = test_guard();
    let bridge = super::CoreBridge::spawn();
    assert_eq!(bridge.first_run(), Ok(true));
    let listed = CoreBridge::list_connections(&bridge);
    assert_eq!(listed, vec![rowkery_core::sample::sample_record()]);
    assert!(AppConfig::load().unwrap().first_run_done);
    bridge.remove_connection("sample", false).expect("delete");
    drop(bridge);

    let again = super::CoreBridge::spawn();
    assert_eq!(again.first_run(), Ok(false));
    assert!(CoreBridge::list_connections(&again).is_empty());
    let path = rowkery_core::sample::sample_path();
    Connection::open(&path)
        .unwrap()
        .execute_batch("INSERT INTO games (title, genre, price_cents) VALUES ('Extra', 'demo', 1);")
        .unwrap();
    let games = || -> i64 {
        Connection::open(&path)
            .unwrap()
            .query_row("SELECT COUNT(*) FROM games", [], |r| r.get(0))
            .unwrap()
    };
    // Open keeps the working copy as it is; reset writes a fresh one.
    assert_eq!(again.open_sample(false).unwrap().id(), "sample");
    assert_eq!(games(), 9);
    assert_eq!(CoreBridge::list_connections(&again).len(), 1);
    again.open_sample(true).unwrap();
    assert_eq!(games(), 8);
    assert_eq!(CoreBridge::list_connections(&again).len(), 1);
    std::env::remove_var("ROWKERY_CONFIG_DIR");
}

/// At launch the saved active window opens before the webview asks; the
/// matching `open_window` joins it (here: it still has the catalog read
/// before the file was removed), another window opens afresh.
#[test]
fn the_saved_active_window_opens_at_launch() {
    let (_guard, _file, path) = test_guard();
    let bridge = super::CoreBridge::spawn();
    CoreBridge::upsert_connection(
        &bridge,
        ConnectionRecord::Sqlite(SqliteConnection {
            allow_mcp: false,
            mcp_hidden_tables: Vec::new(),
            mcp_until: None,
            mcp_samples_off: false,
            mcp_timeout_s: None,
            mcp_access: None,
            masked_columns: Default::default(),
            environment: None,
            safe_mode: Default::default(),
            id: "early".into(),
            name: "early".into(),
            path: path.clone(),
            sample: false,
        }),
        ConnectionSecrets::default(),
    )
    .expect("save");
    bridge.save_ui_state(serde_json::json!({
        "version": 1,
        "keys": { "rowkery.windows": { "windows": [
            { "connectionId": null, "database": null },
            { "connectionId": "early", "database": null }
        ], "active": 1 } }
    }));
    bridge.flush_config();
    drop(bridge);

    let started = Instant::now();
    let relaunched = super::CoreBridge::spawn();
    thread::sleep(std::time::Duration::from_millis(300));
    // The launch-time open says when its file was ready, to a listener
    // that registers after the fact too (the app's setup runs later).
    let (tx, rx) = std::sync::mpsc::channel();
    relaunched.on_launch_warm(move |at| {
        let _ = tx.send(at);
    });
    let warm = rx
        .recv_timeout(std::time::Duration::from_secs(2))
        .expect("launch warm");
    assert!(warm >= started && warm <= Instant::now());
    std::fs::remove_file(&path).expect("remove db");
    let joined = relaunched.open_window("w2", "early", None).expect("w2");
    assert!(
        joined.catalog.find_table("main", "main", "t").is_some(),
        "w2 joined the launch-time open"
    );
    let fresh = relaunched.open_window("w3", "early", None);
    assert!(fresh.is_err(), "w3 opened afresh, and the file is gone");
    std::env::remove_var("ROWKERY_CONFIG_DIR");
}

/// Postgres: after a relaunch the first window's open is already done
/// (session warm, schema loaded) when the webview asks for it.
#[test]
fn postgres_launch_time_open_is_ready_when_asked() {
    if std::env::var("ROWKERY_PG_HOST").is_err() {
        eprintln!("skip postgres_launch_time_open_is_ready_when_asked (set ROWKERY_PG_HOST)");
        return;
    }
    let (_guard, _file, _path) = test_guard();
    let bridge = super::CoreBridge::spawn();
    CoreBridge::upsert_connection(
        &bridge,
        ConnectionRecord::Postgres(PostgresConnection {
            allow_mcp: false,
            mcp_hidden_tables: Vec::new(),
            mcp_until: None,
            mcp_samples_off: false,
            mcp_timeout_s: None,
            mcp_access: None,
            masked_columns: Default::default(),
            environment: None,
            safe_mode: Default::default(),
            id: "pg-early".into(),
            name: "pg early".into(),
            host: std::env::var("ROWKERY_PG_HOST").unwrap(),
            port: std::env::var("ROWKERY_PG_PORT")
                .ok()
                .and_then(|p| p.parse().ok())
                .unwrap_or(54329),
            database: std::env::var("ROWKERY_PG_DB").unwrap_or_else(|_| "rowkery".into()),
            username: std::env::var("ROWKERY_PG_USER").unwrap_or_else(|_| "rowkery".into()),
            ssl_mode: PostgresSslMode::Disable,
            ssl_root_cert: None,
            ssh: None,
            cloud_sql: None,
        }),
        ConnectionSecrets {
            db_password: Some(
                std::env::var("ROWKERY_PG_PASSWORD").unwrap_or_else(|_| "rowkery".into()),
            ),
            ..Default::default()
        },
    )
    .expect("save");
    // Cold: no launch-time open.
    let started = Instant::now();
    bridge.open_window("w1", "pg-early", None).expect("open");
    let cold = started.elapsed();
    bridge.save_ui_state(serde_json::json!({
            "version": 1,
            "keys": { "rowkery.windows": { "windows": [{ "connectionId": "pg-early", "database": "rowkery" }], "active": 0 } }
        }));
    bridge.flush_config();
    drop(bridge);

    let relaunched = super::CoreBridge::spawn();
    // The webview takes about this long to boot.
    thread::sleep(cold * 2 + std::time::Duration::from_millis(100));
    let started = Instant::now();
    let opened = relaunched
        .open_window("w1", "pg-early", None)
        .expect("open");
    let warm = started.elapsed();
    assert!(opened.catalog.databases.iter().any(|d| d.name == "rowkery"));
    assert!(
        warm * 3 < cold,
        "launch-time open: asked after {warm:?}, cold open took {cold:?}"
    );
    let (one, ..) = window_query(&relaunched, "w1", 1, "SELECT 1");
    assert_eq!(one, Some(Value::Int(1)));
    std::env::remove_var("ROWKERY_CONFIG_DIR");
}

/// A launch-time open answered from the catalog cache checks the cache
/// while the webview boots, before anything listens. Joining it must
/// still deliver that outcome, or the sidebar spinner never stops.
#[test]
fn postgres_launch_time_cache_check_reaches_a_late_listener() {
    if std::env::var("ROWKERY_PG_HOST").is_err() {
        eprintln!(
            "skip postgres_launch_time_cache_check_reaches_a_late_listener (set ROWKERY_PG_HOST)"
        );
        return;
    }
    let (_guard, _file, _path) = test_guard();
    let bridge = super::CoreBridge::spawn();
    CoreBridge::upsert_connection(
        &bridge,
        ConnectionRecord::Postgres(PostgresConnection {
            allow_mcp: false,
            mcp_hidden_tables: Vec::new(),
            mcp_until: None,
            mcp_samples_off: false,
            mcp_timeout_s: None,
            mcp_access: None,
            masked_columns: Default::default(),
            environment: None,
            safe_mode: Default::default(),
            id: "pg-late".into(),
            name: "pg late".into(),
            host: std::env::var("ROWKERY_PG_HOST").unwrap(),
            port: std::env::var("ROWKERY_PG_PORT")
                .ok()
                .and_then(|p| p.parse().ok())
                .unwrap_or(54329),
            database: std::env::var("ROWKERY_PG_DB").unwrap_or_else(|_| "rowkery".into()),
            username: std::env::var("ROWKERY_PG_USER").unwrap_or_else(|_| "rowkery".into()),
            ssl_mode: PostgresSslMode::Disable,
            ssl_root_cert: None,
            ssh: None,
            cloud_sql: None,
        }),
        ConnectionSecrets {
            db_password: Some(
                std::env::var("ROWKERY_PG_PASSWORD").unwrap_or_else(|_| "rowkery".into()),
            ),
            ..Default::default()
        },
    )
    .expect("save");
    // Cold open: fills the catalog cache.
    bridge.open_window("w1", "pg-late", None).expect("open");
    bridge.save_ui_state(serde_json::json!({
            "version": 1,
            "keys": { "rowkery.windows": { "windows": [{ "connectionId": "pg-late", "database": "rowkery" }], "active": 0 } }
        }));
    bridge.flush_config();
    drop(bridge);

    let relaunched = super::CoreBridge::spawn();
    // The webview boots; the cache check finishes with no one listening.
    thread::sleep(std::time::Duration::from_millis(1500));
    let updates: Arc<Mutex<Vec<CatalogUpdate>>> = Arc::default();
    let sink = updates.clone();
    relaunched.on_catalog_update(Arc::new(move |u| sink.lock().unwrap().push(u)));
    let opened = relaunched.open_window("w1", "pg-late", None).expect("open");
    assert!(opened.cached, "answered from the catalog cache");
    let deadline = Instant::now() + std::time::Duration::from_secs(5);
    loop {
        let got = updates.lock().unwrap().clone();
        if got.iter().any(|u| {
            matches!(u, CatalogUpdate::Confirmed { window_id, open_seq }
                    if window_id == "w1" && *open_seq == opened.open_seq)
        }) {
            break;
        }
        assert!(
            Instant::now() < deadline,
            "no Confirmed for the joined open: {got:?}"
        );
        thread::sleep(std::time::Duration::from_millis(20));
    }
    std::env::remove_var("ROWKERY_CONFIG_DIR");
}

#[test]
fn sqlite_windows_run_queries_on_their_own_queues() {
    let (_guard, _file, path) = test_guard();
    let bridge = super::CoreBridge::spawn();
    let id = "sqlite-windows";
    CoreBridge::upsert_connection(
        &bridge,
        ConnectionRecord::Sqlite(SqliteConnection {
            allow_mcp: false,
            mcp_hidden_tables: Vec::new(),
            mcp_until: None,
            mcp_samples_off: false,
            mcp_timeout_s: None,
            mcp_access: None,
            masked_columns: Default::default(),
            environment: None,
            safe_mode: Default::default(),
            id: id.into(),
            name: "test".into(),
            path,
            sample: false,
        }),
        ConnectionSecrets::default(),
    )
    .expect("save");

    let opened = bridge.open_window("w1", id, None).expect("open w1");
    assert_eq!(opened.database, "main");
    assert!(opened.catalog.find_table("main", "main", "t").is_some());
    assert_eq!(opened.server_version.as_deref(), Some(sqlite_version()));
    bridge.open_window("w2", id, None).expect("open w2");
    assert!(bridge.list_databases("w1").expect("list").is_empty());

    // Both windows run tab 1 at once; neither steals the other's result.
    let q1 = bridge
        .run_window_query("w1", 1, "SELECT id FROM t".into(), None, false)
        .expect("run w1");
    let q2 = bridge
        .run_window_query("w2", 1, "SELECT id FROM t WHERE 0".into(), None, false)
        .expect("run w2");
    let (rows2, err2, _) = wait_finished(&q2);
    let (rows1, err1, _) = wait_finished(&q1);
    assert_eq!((err1, err2), (None, None));
    assert!(rows1 > 0);
    assert_eq!(rows2, 0);

    bridge.close_window("w2");
    let err = bridge
        .run_window_query("w2", 1, "SELECT 1".into(), None, false)
        .expect_err("closed window");
    assert!(err.contains("not connected"));
    assert!(bridge.open_window("w3", "missing", None).is_err());
    std::env::remove_var("ROWKERY_CONFIG_DIR");
}

fn held(queue: &EventQueue) -> Option<rowkery_core::safety::SafetyHold> {
    std::mem::take(&mut *queue.lock().unwrap())
        .into_iter()
        .find_map(|e| match e {
            CoreEvent::QueryHeld { hold, .. } => Some(hold),
            _ => None,
        })
}

#[test]
fn safe_mode_holds_and_refuses_writes() {
    use rowkery_core::safety::HoldAction;
    let (_guard, _file, path) = test_guard();
    let bridge = super::CoreBridge::spawn();
    let save = |id: &str, safe_mode: SafeMode| {
        CoreBridge::upsert_connection(
            &bridge,
            ConnectionRecord::Sqlite(SqliteConnection {
                environment: None,
                safe_mode,
                allow_mcp: false,
                mcp_hidden_tables: Vec::new(),
                mcp_until: None,
                mcp_samples_off: false,
                mcp_timeout_s: None,
                mcp_access: None,
                masked_columns: Default::default(),
                id: id.into(),
                name: id.into(),
                path: path.clone(),
                sample: false,
            }),
            ConnectionSecrets::default(),
        )
        .expect("save");
    };
    save("confirm", SafeMode::Confirm);
    save("ro", SafeMode::ReadOnly);
    bridge.open_window("wc", "confirm", None).expect("open");
    bridge.open_window("wr", "ro", None).expect("open");
    let run = |w: &str, sql: &str, confirmed: bool| {
        bridge
            .run_window_query(w, 1, sql.into(), None, confirmed)
            .expect("run")
    };
    let count = |w: &str| wait_finished(&run(w, "SELECT id FROM t", false)).0;

    // Reads run straight away in both modes.
    assert_eq!(count("wc"), 1);
    assert_eq!(count("wr"), 1);

    // Confirm writes: held until confirmed, then it runs.
    let hold = held(&run("wc", "INSERT INTO t VALUES (2)", false)).expect("held");
    assert_eq!(hold.action, HoldAction::Confirm);
    assert_eq!(hold.statements[0].verb, "INSERT");
    assert_eq!(hold.statements[0].target.as_deref(), Some("t"));
    assert_eq!(count("wc"), 1, "nothing ran while held");
    let (_, err, _) = wait_finished(&run("wc", "INSERT INTO t VALUES (2)", true));
    assert_eq!(err, None);
    assert_eq!(count("wc"), 2);

    // Read-only: refused even when confirmed, and SQLite refuses too.
    let hold = held(&run("wr", "DELETE FROM t", true)).expect("refused");
    assert_eq!(hold.action, HoldAction::Refuse);
    assert!(hold.statements[0].destructive);
    assert!(held(&run("wr", "PRAGMA query_only = 0", true)).is_some());
    assert_eq!(count("wr"), 2);

    // A saved change applies to open windows without reopening them.
    save("ro", SafeMode::Off);
    let (_, err, _) = wait_finished(&run("wr", "DELETE FROM t", false));
    assert_eq!(err, None);
    assert_eq!(count("wr"), 0);
    std::env::remove_var("ROWKERY_CONFIG_DIR");
}

/// ⌘E on SQLite: the plan tree, a hint from counted rows, safe mode
/// never involved (nothing runs).
#[test]
fn sqlite_explain_reads_the_plan_and_runs_nothing() {
    let (_guard, _file, path) = test_guard();
    Connection::open(&path)
        .unwrap()
        .execute_batch(
            "CREATE TABLE big (id INTEGER PRIMARY KEY, n INT);
                 INSERT INTO big (n) WITH RECURSIVE c(x) AS
                   (SELECT 1 UNION ALL SELECT x + 1 FROM c WHERE x < 12000) SELECT x FROM c;",
        )
        .unwrap();
    let bridge = super::CoreBridge::spawn();
    CoreBridge::upsert_connection(
        &bridge,
        ConnectionRecord::Sqlite(SqliteConnection {
            environment: None,
            safe_mode: SafeMode::ReadOnly,
            allow_mcp: false,
            mcp_hidden_tables: Vec::new(),
            mcp_until: None,
            mcp_samples_off: false,
            mcp_timeout_s: None,
            mcp_access: None,
            masked_columns: Default::default(),
            id: "plan".into(),
            name: "plan".into(),
            path: path.clone(),
            sample: false,
        }),
        ConnectionSecrets::default(),
    )
    .expect("save");
    bridge.open_window("w", "plan", None).expect("open");
    let out = bridge
        .explain(
            "w",
            1,
            "SELECT * FROM big WHERE n = 5 ORDER BY n;".into(),
            true,
            false,
        )
        .expect("explain");
    let ExplainOutcome::Plan { plan, .. } = out else {
        panic!("{out:?}")
    };
    assert!(!plan.timed);
    assert_eq!(plan.steps[0].kind, "Scan");
    assert_eq!(plan.steps[0].table.as_deref(), Some("big"));
    assert_eq!(
            plan.hint.expect("hint").text,
            "SQLite reads every row of big (12,000). If you filter or join on one of its columns, an index on it lets SQLite go straight to the rows."
        );
    // A write's plan on a read-only connection: EXPLAIN QUERY PLAN never
    // runs it, and the row is still there.
    let out = bridge
        .explain("w", 1, "DELETE FROM big WHERE id = 1".into(), false, false)
        .expect("explain");
    assert!(matches!(out, ExplainOutcome::Plan { .. }), "{out:?}");
    assert_eq!(
        int_of(window_query(&bridge, "w", 1, "SELECT count(*) FROM big").0),
        12000
    );
    let err = bridge
        .explain("w", 1, "SELECT 1; SELECT 2".into(), false, false)
        .expect_err("two statements");
    assert_eq!(err, "Explain works on one statement at a time.");
    std::env::remove_var("ROWKERY_CONFIG_DIR");
}

/// A timed plan never wraps its statement in `BEGIN … ROLLBACK` unless the
/// tab surely has no transaction: an unknown state (the probe didn't answer)
/// takes the savepoint form, which can't end the user's transaction.
#[test]
fn a_timed_plan_on_an_unknown_transaction_keeps_it() {
    assert!(!super::plan_in_savepoint(TxnState::None));
    assert!(super::plan_in_savepoint(TxnState::Users));
    assert!(super::plan_in_savepoint(TxnState::Unknown));
}

/// ⌘E on Postgres: an estimate with a missing-index hint; a timed plan of
/// a write held by Confirm writes, then run and rolled back, also inside
/// the user's own transaction.
#[test]
fn postgres_explain_estimates_times_and_rolls_back_writes() {
    let (_guard, _file, _path) = test_guard();
    let bridge = super::CoreBridge::spawn();
    if save_pg_at(&bridge, "plan-pg", None, SafeMode::Confirm).is_none() {
        eprintln!(
            "skip postgres_explain_estimates_times_and_rolls_back_writes (set ROWKERY_PG_HOST)"
        );
        return;
    }
    save_pg_at(&bridge, "plan-setup", None, SafeMode::Off);
    bridge.open_window("w", "plan-pg", None).expect("open");
    bridge.open_window("s", "plan-setup", None).expect("open");
    for sql in [
        "DROP TABLE IF EXISTS plan_orders",
        "CREATE TABLE plan_orders (id int PRIMARY KEY, customer_id int, total int)",
        "INSERT INTO plan_orders SELECT g, g % 5000, g FROM generate_series(1, 60000) g",
        "ANALYZE plan_orders",
    ] {
        assert_eq!(window_query(&bridge, "s", 9, sql).1, None, "{sql}");
    }
    let rows = |bridge: &super::CoreBridge| {
        int_of(window_query(bridge, "s", 9, "SELECT count(*)::int FROM plan_orders").0)
    };
    assert_eq!(rows(&bridge), 60000);

    let ExplainOutcome::Plan { plan, .. } = bridge
        .explain(
            "w",
            1,
            "SELECT * FROM plan_orders WHERE customer_id = 42".into(),
            false,
            false,
        )
        .expect("estimate")
    else {
        panic!("no plan")
    };
    assert!(!plan.timed);
    assert!(plan.steps.iter().any(|s| s.kind.ends_with("Seq Scan")));
    let hint = plan.hint.expect("hint");
    assert!(
        hint.text.ends_with("plan_orders.customer_id has no index."),
        "{}",
        hint.text
    );
    assert_eq!(
        hint.sql.as_deref(),
        Some("CREATE INDEX ON public.plan_orders (customer_id);")
    );

    // Timed read: real times.
    let ExplainOutcome::Plan { plan, .. } = bridge
        .explain(
            "w",
            1,
            "SELECT count(*) FROM plan_orders".into(),
            true,
            false,
        )
        .expect("timed")
    else {
        panic!("no plan")
    };
    assert!(plan.timed && plan.execution_ms.is_some());
    assert_eq!(plan.rows, Some(1.0));

    // A timed read that writes through a function: rolled back too.
    assert_eq!(
        window_query(
            &bridge,
            "s",
            9,
            "CREATE OR REPLACE FUNCTION plan_orders_trim() RETURNS int LANGUAGE sql \
             AS $$ DELETE FROM plan_orders WHERE id <= 10 RETURNING 1 $$"
        )
        .1,
        None
    );
    let out = bridge
        .explain("w", 1, "SELECT plan_orders_trim()".into(), true, false)
        .expect("timed function");
    assert!(matches!(out, ExplainOutcome::Plan { .. }), "{out:?}");
    assert_eq!(rows(&bridge), 60000, "the function's delete rolled back");

    // Timed write: held, then run and rolled back.
    let delete = "DELETE FROM plan_orders WHERE id <= 10".to_string();
    let out = bridge
        .explain("w", 1, delete.clone(), true, false)
        .expect("held");
    assert!(matches!(out, ExplainOutcome::Held { .. }), "{out:?}");
    let ExplainOutcome::Plan { plan, .. } = bridge
        .explain("w", 1, delete.clone(), true, true)
        .expect("timed write")
    else {
        panic!("no plan")
    };
    assert_eq!(plan.steps[0].kind, "Delete");
    assert_eq!(rows(&bridge), 60000, "rolled back");

    // Inside the user's own transaction: a savepoint, and the transaction
    // carries on with its own change.
    let run = |sql: &str| {
        let queue = bridge
            .run_window_query("w", 1, sql.into(), None, true)
            .expect("run");
        wait_finished(&queue).1
    };
    assert_eq!(run("BEGIN"), None);
    assert_eq!(run("DELETE FROM plan_orders WHERE id = 60000"), None);
    let out = bridge
        .explain("w", 1, delete, true, true)
        .expect("timed write");
    assert!(matches!(out, ExplainOutcome::Plan { .. }), "{out:?}");
    assert_eq!(run("COMMIT"), None);
    assert_eq!(
        rows(&bridge),
        59999,
        "the user's delete kept, ours rolled back"
    );
    window_query(&bridge, "s", 9, "DROP FUNCTION plan_orders_trim()");
    window_query(&bridge, "s", 9, "DROP TABLE plan_orders");
    std::env::remove_var("ROWKERY_CONFIG_DIR");
}

#[test]
fn seed_pg_verify_connection_for_gui() {
    if std::env::var("ROWKERY_SEED_PG_GUI").is_err() {
        return;
    }
    let (_guard, _file, _path) = test_guard();
    let bridge = super::CoreBridge::spawn();
    let host = std::env::var("ROWKERY_PG_HOST").unwrap_or_else(|_| "127.0.0.1".into());
    let port = std::env::var("ROWKERY_PG_PORT")
        .ok()
        .and_then(|p| p.parse().ok())
        .unwrap_or(54329);
    CoreBridge::upsert_connection(
        &bridge,
        ConnectionRecord::Postgres(PostgresConnection {
            environment: None,
            safe_mode: Default::default(),
            allow_mcp: false,
            mcp_hidden_tables: Vec::new(),
            mcp_until: None,
            mcp_samples_off: false,
            mcp_timeout_s: None,
            mcp_access: None,
            masked_columns: Default::default(),
            id: "pg-verify".into(),
            name: "PG Verify".into(),
            host,
            port,
            database: std::env::var("ROWKERY_PG_DB").unwrap_or_else(|_| "rowkery".into()),
            username: std::env::var("ROWKERY_PG_USER").unwrap_or_else(|_| "rowkery".into()),
            ssl_mode: PostgresSslMode::Disable,
            ssl_root_cert: None,
            ssh: None,
            cloud_sql: None,
        }),
        ConnectionSecrets {
            db_password: Some(
                std::env::var("ROWKERY_PG_PASSWORD").unwrap_or_else(|_| "rowkery".into()),
            ),
            ssh_password: None,
            ssh_key_passphrase: None,
            gcp_key: None,
        },
    )
    .expect("seed");
    std::env::remove_var("ROWKERY_CONFIG_DIR");
}

#[test]
fn probe_reports_version_and_errors_without_saving() {
    let (_guard, _file, path) = test_guard();
    let lite = probe_connection_blocking(
        ConnectionRecord::Sqlite(SqliteConnection {
            environment: None,
            safe_mode: Default::default(),
            allow_mcp: false,
            mcp_hidden_tables: Vec::new(),
            mcp_until: None,
            mcp_samples_off: false,
            mcp_timeout_s: None,
            mcp_access: None,
            masked_columns: Default::default(),
            id: "probe-lite".into(),
            name: "lite".into(),
            path,
            sample: false,
        }),
        ConnectionSecrets::default(),
    );
    assert!(lite.ok, "{}", lite.message);

    let missing = probe_connection_blocking(
        ConnectionRecord::Sqlite(SqliteConnection {
            environment: None,
            safe_mode: Default::default(),
            allow_mcp: false,
            mcp_hidden_tables: Vec::new(),
            mcp_until: None,
            mcp_samples_off: false,
            mcp_timeout_s: None,
            mcp_access: None,
            masked_columns: Default::default(),
            id: "probe-missing".into(),
            name: "missing".into(),
            path: "/nonexistent/rowkery.sqlite".into(),
            sample: false,
        }),
        ConnectionSecrets::default(),
    );
    assert!(!missing.ok);
    assert!(missing.message.contains("not found"), "{}", missing.message);

    if std::env::var("ROWKERY_PG_HOST").is_err() {
        eprintln!("skip postgres probe (set ROWKERY_PG_HOST)");
        return;
    }
    let pg = PostgresConnection {
        environment: None,
        safe_mode: Default::default(),
        allow_mcp: false,
        mcp_hidden_tables: Vec::new(),
        mcp_until: None,
        mcp_samples_off: false,
        mcp_timeout_s: None,
        mcp_access: None,
        masked_columns: Default::default(),
        id: "probe-pg".into(),
        name: "probe".into(),
        host: std::env::var("ROWKERY_PG_HOST").unwrap(),
        port: std::env::var("ROWKERY_PG_PORT")
            .ok()
            .and_then(|p| p.parse().ok())
            .unwrap_or(54329),
        database: std::env::var("ROWKERY_PG_DB").unwrap_or_else(|_| "rowkery".into()),
        username: std::env::var("ROWKERY_PG_USER").unwrap_or_else(|_| "rowkery".into()),
        ssl_mode: PostgresSslMode::Disable,
        ssl_root_cert: None,
        ssh: None,
        cloud_sql: None,
    };
    let good = probe_connection_blocking(
        ConnectionRecord::Postgres(pg.clone()),
        ConnectionSecrets {
            db_password: std::env::var("ROWKERY_PG_PASSWORD").ok(),
            ..Default::default()
        },
    );
    assert!(good.ok, "{}", good.message);
    assert!(good.message.starts_with("PostgreSQL 1"), "{}", good.message);

    let bad = probe_connection_blocking(
        ConnectionRecord::Postgres(PostgresConnection {
            database: "rowkery_probe_missing_db".into(),
            ..pg
        }),
        ConnectionSecrets {
            db_password: std::env::var("ROWKERY_PG_PASSWORD").ok(),
            ..Default::default()
        },
    );
    assert!(!bad.ok);
    // Nothing was saved by probing.
    let bridge = super::CoreBridge::spawn();
    assert!(CoreBridge::list_connections(&bridge)
        .iter()
        .all(|c| !c.id().starts_with("probe")));
}

/// Needs a second database named `orders` on the test server.
#[test]
fn postgres_window_switches_database() {
    if std::env::var("ROWKERY_PG_HOST").is_err() {
        eprintln!("skip postgres_window_switches_database (set ROWKERY_PG_HOST)");
        return;
    }
    let (_guard, _file, _path) = test_guard();
    let bridge = super::CoreBridge::spawn();
    let id = "postgres-window";
    CoreBridge::upsert_connection(
        &bridge,
        ConnectionRecord::Postgres(PostgresConnection {
            environment: None,
            safe_mode: Default::default(),
            allow_mcp: false,
            mcp_hidden_tables: Vec::new(),
            mcp_until: None,
            mcp_samples_off: false,
            mcp_timeout_s: None,
            mcp_access: None,
            masked_columns: Default::default(),
            id: id.into(),
            name: "pg window".into(),
            host: std::env::var("ROWKERY_PG_HOST").unwrap(),
            port: std::env::var("ROWKERY_PG_PORT")
                .ok()
                .and_then(|p| p.parse().ok())
                .unwrap_or(54329),
            database: std::env::var("ROWKERY_PG_DB").unwrap_or_else(|_| "rowkery".into()),
            username: std::env::var("ROWKERY_PG_USER").unwrap_or_else(|_| "rowkery".into()),
            ssl_mode: PostgresSslMode::Disable,
            ssl_root_cert: None,
            ssh: None,
            cloud_sql: None,
        }),
        ConnectionSecrets {
            db_password: Some(
                std::env::var("ROWKERY_PG_PASSWORD").unwrap_or_else(|_| "rowkery".into()),
            ),
            ..Default::default()
        },
    )
    .expect("save");

    let opened = bridge.open_window("w1", id, None).expect("open");
    assert_eq!(opened.database, "rowkery");
    let version = opened.server_version.expect("server version");
    assert!(
        version.chars().next().is_some_and(|c| c.is_ascii_digit()),
        "{version}"
    );
    let dbs = bridge.list_databases("w1").expect("list databases");
    let names: Vec<&str> = dbs.iter().map(|d| d.name.as_str()).collect();
    assert!(
        names.contains(&"rowkery") && names.contains(&"orders"),
        "{names:?}"
    );
    assert!(!names.contains(&"template0"));
    assert!(dbs.iter().all(|d| d.size_bytes.is_some()));

    let opened = bridge
        .open_window("w1", id, Some("orders".into()))
        .expect("switch database");
    assert_eq!(opened.database, "orders");
    let queue = bridge
        .run_window_query("w1", 1, "SELECT current_database()".into(), None, false)
        .expect("run");
    let mut current = None;
    for _ in 0..200 {
        let drained: Vec<CoreEvent> = std::mem::take(&mut *queue.lock().unwrap());
        for event in drained {
            if let CoreEvent::QueryBatch { batch, .. } = event {
                current = batch.rows.first().and_then(|r| r.first()).cloned();
            }
        }
        if current.is_some() {
            break;
        }
        thread::sleep(std::time::Duration::from_millis(20));
    }
    assert_eq!(
        current,
        Some(rowkery_core::db::Value::Text("orders".into()))
    );

    let err = bridge
        .open_window("w2", id, Some("rowkery_missing_db".into()))
        .expect_err("missing database");
    assert!(!err.is_empty());
    std::env::remove_var("ROWKERY_CONFIG_DIR");
}

#[test]
fn postgres_schema_and_query_via_bridge() {
    if std::env::var("ROWKERY_PG_HOST").is_err() {
        eprintln!("skip postgres_schema_and_query_via_bridge (set ROWKERY_PG_HOST)");
        return;
    }
    let (_guard, _file, _path) = test_guard();
    let bridge = super::CoreBridge::spawn();
    let id = "postgres-verify";
    let host = std::env::var("ROWKERY_PG_HOST").unwrap_or_else(|_| "127.0.0.1".into());
    let port = std::env::var("ROWKERY_PG_PORT")
        .ok()
        .and_then(|p| p.parse().ok())
        .unwrap_or(54329);
    let database = std::env::var("ROWKERY_PG_DB").unwrap_or_else(|_| "rowkery".into());
    let username = std::env::var("ROWKERY_PG_USER").unwrap_or_else(|_| "rowkery".into());
    let password = std::env::var("ROWKERY_PG_PASSWORD").unwrap_or_else(|_| "rowkery".into());
    CoreBridge::upsert_connection(
        &bridge,
        ConnectionRecord::Postgres(PostgresConnection {
            environment: None,
            safe_mode: Default::default(),
            allow_mcp: false,
            mcp_hidden_tables: Vec::new(),
            mcp_until: None,
            mcp_samples_off: false,
            mcp_timeout_s: None,
            mcp_access: None,
            masked_columns: Default::default(),
            id: id.into(),
            name: "pg verify".into(),
            host,
            port,
            database,
            username,
            ssl_mode: PostgresSslMode::Disable,
            ssl_root_cert: None,
            ssh: None,
            cloud_sql: None,
        }),
        ConnectionSecrets {
            db_password: Some(password),
            ssh_password: None,
            ssh_key_passphrase: None,
            gcp_key: None,
        },
    )
    .expect("save");
    bridge.open_window("w1", id, None).expect("open");
    let run = |sql: &str| {
        let queue = bridge
            .run_window_query("w1", 1, sql.into(), None, false)
            .expect("run");
        wait_finished(&queue)
    };
    // The test seeds its own table, so it runs on a fresh test Postgres.
    for sql in [
            "CREATE SCHEMA IF NOT EXISTS verify_bridge",
            "DROP TABLE IF EXISTS verify_bridge.widgets CASCADE",
            "CREATE TABLE verify_bridge.widgets (id serial PRIMARY KEY, name text NOT NULL, \
             qty integer, meta jsonb DEFAULT '{}'::jsonb)",
            "INSERT INTO verify_bridge.widgets (name, qty) VALUES ('alpha', 3), ('beta', 7), ('gamma', 11)",
        ] {
            let (_, error, _) = run(sql);
            assert!(error.is_none(), "seed failed: {sql}: {error:?}");
        }
    let reloaded = bridge.reload_window_schema("w1").expect("reload");
    assert!(
        reloaded
            .find_table("rowkery", "verify_bridge", "widgets")
            .is_some(),
        "expected verify_bridge.widgets in catalog"
    );
    let (rows, error, _) = run("SELECT 1 AS one");
    assert!(error.is_none(), "SELECT 1 should succeed, got: {error:?}");
    assert_eq!(rows, 1);

    let (rows, error, _) = run("SELECT * FROM verify_bridge.widgets LIMIT 10");
    assert!(error.is_none(), "widgets query failed: {error:?}");
    assert!(rows >= 3, "expected at least 3 rows");

    let (_, error, _) = run("SELECT * FROM users");
    let err = error.expect("missing users table should error");
    assert!(
        err.contains("users") || err.contains("does not exist"),
        "expected postgres message, got: {err}"
    );
    assert_ne!(err, "db error");
    std::env::remove_var("ROWKERY_CONFIG_DIR");
}

#[test]
fn probe_connection_does_not_persist_record() {
    let (_guard, _file, path) = test_guard();
    let bridge = super::CoreBridge::spawn();
    assert!(CoreBridge::list_connections(&bridge).is_empty());
    let outcome = probe_connection_blocking(
        ConnectionRecord::Sqlite(SqliteConnection {
            environment: None,
            safe_mode: Default::default(),
            allow_mcp: false,
            mcp_hidden_tables: Vec::new(),
            mcp_until: None,
            mcp_samples_off: false,
            mcp_timeout_s: None,
            mcp_access: None,
            masked_columns: Default::default(),
            id: "probe-sqlite".into(),
            name: "probe".into(),
            path,
            sample: false,
        }),
        ConnectionSecrets::default(),
    );
    assert!(outcome.ok, "probe should connect: {}", outcome.message);
    assert_eq!(outcome.message, "SQLite");
    assert!(
        CoreBridge::list_connections(&bridge).is_empty(),
        "probe must not upsert sidebar connections"
    );
    std::env::remove_var("ROWKERY_CONFIG_DIR");
}

/// Waits for the next `QueryFinished` and returns `(error, cancelled)`.
fn wait_query_finished(
    queue: &EventQueue,
    timeout: std::time::Duration,
) -> Option<(Option<String>, bool)> {
    let deadline = std::time::Instant::now() + timeout;
    while std::time::Instant::now() < deadline {
        let drained: Vec<CoreEvent> = std::mem::take(&mut *queue.lock().unwrap());
        for event in drained {
            if let CoreEvent::QueryFinished {
                error, cancelled, ..
            } = event
            {
                return Some((error, cancelled));
            }
        }
        thread::sleep(std::time::Duration::from_millis(10));
    }
    None
}

fn connect_sqlite(bridge: &super::CoreBridge, path: String) {
    CoreBridge::upsert_connection(
        bridge,
        ConnectionRecord::Sqlite(SqliteConnection {
            environment: None,
            safe_mode: Default::default(),
            allow_mcp: false,
            mcp_hidden_tables: Vec::new(),
            mcp_until: None,
            mcp_samples_off: false,
            mcp_timeout_s: None,
            mcp_access: None,
            masked_columns: Default::default(),
            id: "cancel-sqlite".into(),
            name: "cancel".into(),
            path,
            sample: false,
        }),
        ConnectionSecrets::default(),
    )
    .expect("save");
    bridge
        .open_window("w1", "cancel-sqlite", None)
        .expect("open");
}

const SLOW_SQLITE: &str = "WITH RECURSIVE n(x) AS (SELECT 1 UNION ALL SELECT x + 1 FROM n) \
                               SELECT count(*) FROM n";

#[test]
fn sqlite_cancel_stops_running_query() {
    let (_guard, _file, path) = test_guard();
    let bridge = super::CoreBridge::spawn();
    connect_sqlite(&bridge, path);
    let queue = bridge
        .run_window_query("w1", 1, SLOW_SQLITE.into(), None, false)
        .expect("run");
    thread::sleep(std::time::Duration::from_millis(300));
    bridge.cancel_window_query("w1", 1);
    let (error, cancelled) =
        wait_query_finished(&queue, std::time::Duration::from_secs(5)).expect("finish");
    assert!(cancelled, "query should report cancelled, error: {error:?}");
    std::env::remove_var("ROWKERY_CONFIG_DIR");
}

#[test]
fn sqlite_cancel_right_after_run_is_not_lost() {
    let (_guard, _file, path) = test_guard();
    let bridge = super::CoreBridge::spawn();
    connect_sqlite(&bridge, path);
    let queue = bridge
        .run_window_query("w1", 1, SLOW_SQLITE.into(), None, false)
        .expect("run");
    bridge.cancel_window_query("w1", 1);
    let (error, cancelled) =
        wait_query_finished(&queue, std::time::Duration::from_secs(5)).expect("finish");
    assert!(cancelled, "query should report cancelled, error: {error:?}");
    std::env::remove_var("ROWKERY_CONFIG_DIR");
}

/// A cancel keeps interrupting until its run ends, but never the next run
/// on the same tab's connection.
#[test]
fn sqlite_cancel_leaves_the_next_run_alone() {
    let (_guard, _file, path) = test_guard();
    let bridge = super::CoreBridge::spawn();
    connect_sqlite(&bridge, path);
    let next = "WITH RECURSIVE n(x) AS (SELECT 1 UNION ALL SELECT x + 1 FROM n LIMIT 300000) \
                SELECT count(*) FROM n";
    for _ in 0..10 {
        let queue = bridge
            .run_window_query("w1", 1, SLOW_SQLITE.into(), None, false)
            .expect("run");
        bridge.cancel_window_query("w1", 1);
        let after = bridge
            .run_window_query("w1", 1, next.into(), None, false)
            .expect("run");
        let (_, cancelled) =
            wait_query_finished(&queue, std::time::Duration::from_secs(5)).expect("finish");
        assert!(cancelled);
        let (error, cancelled) =
            wait_query_finished(&after, std::time::Duration::from_secs(5)).expect("finish");
        assert!(!cancelled && error.is_none(), "next run: {error:?}");
    }
    std::env::remove_var("ROWKERY_CONFIG_DIR");
}

#[test]
fn postgres_cancel_stops_running_query() {
    if std::env::var("ROWKERY_PG_HOST").is_err() {
        eprintln!("skip postgres_cancel_stops_running_query (set ROWKERY_PG_HOST)");
        return;
    }
    let (_guard, _file, _path) = test_guard();
    let bridge = super::CoreBridge::spawn();
    let id = "postgres-cancel";
    CoreBridge::upsert_connection(
        &bridge,
        ConnectionRecord::Postgres(PostgresConnection {
            environment: None,
            safe_mode: Default::default(),
            allow_mcp: false,
            mcp_hidden_tables: Vec::new(),
            mcp_until: None,
            mcp_samples_off: false,
            mcp_timeout_s: None,
            mcp_access: None,
            masked_columns: Default::default(),
            id: id.into(),
            name: "pg cancel".into(),
            host: std::env::var("ROWKERY_PG_HOST").unwrap_or_else(|_| "127.0.0.1".into()),
            port: std::env::var("ROWKERY_PG_PORT")
                .ok()
                .and_then(|p| p.parse().ok())
                .unwrap_or(54329),
            database: std::env::var("ROWKERY_PG_DB").unwrap_or_else(|_| "rowkery".into()),
            username: std::env::var("ROWKERY_PG_USER").unwrap_or_else(|_| "rowkery".into()),
            ssl_mode: PostgresSslMode::Disable,
            ssl_root_cert: None,
            ssh: None,
            cloud_sql: None,
        }),
        ConnectionSecrets {
            db_password: Some(
                std::env::var("ROWKERY_PG_PASSWORD").unwrap_or_else(|_| "rowkery".into()),
            ),
            ssh_password: None,
            ssh_key_passphrase: None,
            gcp_key: None,
        },
    )
    .expect("save");
    bridge.open_window("w1", id, None).expect("open");
    let sleep = || {
        bridge
            .run_window_query("w1", 1, "SELECT pg_sleep(30)".into(), None, false)
            .expect("run")
    };

    // Cancel once the query is running on the server.
    let queue = sleep();
    thread::sleep(std::time::Duration::from_millis(1500));
    bridge.cancel_window_query("w1", 1);
    let (error, cancelled) =
        wait_query_finished(&queue, std::time::Duration::from_secs(5)).expect("finish");
    assert!(
        cancelled,
        "pg_sleep should report cancelled, error: {error:?}"
    );

    // Cancel before the query's session has finished opening.
    let queue = sleep();
    bridge.cancel_window_query("w1", 1);
    let (error, cancelled) =
        wait_query_finished(&queue, std::time::Duration::from_secs(5)).expect("finish");
    assert!(
        cancelled,
        "early cancel should not be lost, error: {error:?}"
    );
    std::env::remove_var("ROWKERY_CONFIG_DIR");
}

/// The SQL line's exact count runs on its own slot and returns the number.
#[test]
fn count_window_rows_counts_with_the_where() {
    let (_guard, _file, path) = test_guard();
    let bridge = super::CoreBridge::spawn();
    CoreBridge::upsert_connection(
        &bridge,
        ConnectionRecord::Sqlite(SqliteConnection {
            allow_mcp: false,
            mcp_hidden_tables: Vec::new(),
            mcp_until: None,
            mcp_samples_off: false,
            mcp_timeout_s: None,
            mcp_access: None,
            masked_columns: Default::default(),
            environment: None,
            safe_mode: Default::default(),
            id: "count".into(),
            name: "count".into(),
            path,
            sample: false,
        }),
        ConnectionSecrets::default(),
    )
    .expect("save");
    bridge.open_window("w", "count", None).expect("open");
    window_query(&bridge, "w", 1, "INSERT INTO t VALUES (2), (3)");
    let count = |filter| {
        bridge.count_window_rows(
            "w",
            rowkery_core::db::table_count_query(
                rowkery_core::db::EngineKind::Sqlite,
                "main",
                "t",
                filter,
            ),
        )
    };
    assert_eq!(count(None), Ok(Some(3)));
    assert_eq!(count(Some("id > 1")), Ok(Some(2)));
    assert!(count(Some("nope > 1")).is_err());
}

/// A column of a type the driver doesn't know (an enum here) used to
/// deadlock tokio-postgres's one-shot `query_typed` once the result was
/// bigger than its buffers: `SELECT *` never finished. Prepared first,
/// every run ends, paged or not, after a schema change, and when two
/// cursors with different columns follow each other.
#[test]
fn postgres_custom_types_and_schema_changes_never_hang() {
    let Ok(host) = std::env::var("ROWKERY_PG_HOST") else {
        eprintln!("skip postgres_custom_types_and_schema_changes_never_hang (set ROWKERY_PG_HOST)");
        return;
    };
    let (_guard, _file, _path) = test_guard();
    let bridge = super::CoreBridge::spawn();
    let id = "pg-types";
    CoreBridge::upsert_connection(
        &bridge,
        ConnectionRecord::Postgres(PostgresConnection {
            allow_mcp: false,
            mcp_hidden_tables: Vec::new(),
            mcp_until: None,
            mcp_samples_off: false,
            mcp_timeout_s: None,
            mcp_access: None,
            masked_columns: Default::default(),
            environment: None,
            safe_mode: Default::default(),
            id: id.into(),
            name: "pg types".into(),
            host,
            port: std::env::var("ROWKERY_PG_PORT")
                .ok()
                .and_then(|p| p.parse().ok())
                .unwrap_or(54329),
            database: std::env::var("ROWKERY_PG_DB").unwrap_or_else(|_| "rowkery".into()),
            username: std::env::var("ROWKERY_PG_USER").unwrap_or_else(|_| "rowkery".into()),
            ssl_mode: PostgresSslMode::Disable,
            ssl_root_cert: None,
            ssh: None,
            cloud_sql: None,
        }),
        ConnectionSecrets {
            db_password: Some(
                std::env::var("ROWKERY_PG_PASSWORD").unwrap_or_else(|_| "rowkery".into()),
            ),
            ..Default::default()
        },
    )
    .expect("save");
    bridge.open_window("w", id, None).expect("open");
    for sql in [
            "DROP TABLE IF EXISTS rowkery_types_t",
            "DROP TYPE IF EXISTS rowkery_mood",
            "CREATE TYPE rowkery_mood AS ENUM ('ok', 'sad')",
            "CREATE TABLE rowkery_types_t (id serial PRIMARY KEY, m rowkery_mood, iv interval, j jsonb, tz timestamptz, n numeric, a int[], note text)",
            "INSERT INTO rowkery_types_t (m, iv, j, tz, n, a, note) SELECT 'ok', '1 day', '{\"a\": 1}', now(), 1.5, ARRAY[1, 2], repeat('x', 200) FROM generate_series(1, 400)",
        ] {
            let (_, err, ..) = window_query(&bridge, "w", 9, sql);
            assert_eq!(err, None, "{sql}");
        }
    let run = |tab: u64, sql: &str, page: Option<u32>| {
        let queue: EventQueue = Arc::default();
        bridge
            .run_window_query_paged("w", tab, sql.into(), None, page, false, queue.clone())
            .expect("run");
        let Some((cancelled, error, _)) = wait_stopped(&queue, std::time::Duration::from_secs(10))
        else {
            let out = std::process::Command::new("psql")
                    .args(["-h", "127.0.0.1", "-p", "54329", "-U", "rowkery", "-d", "rowkery", "-Atc",
                        "select state, wait_event, left(query, 120) from pg_stat_activity where datname = 'rowkery' and pid <> pg_backend_pid()"])
                    .output()
                    .map(|o| String::from_utf8_lossy(&o.stdout).to_string())
                    .unwrap_or_default();
            panic!("tab {tab} {page:?} {sql}: never ended\n{out}");
        };
        assert!(!cancelled);
        error
    };
    // Fresh sessions (new tabs): whole, then paged through a cursor.
    assert_eq!(run(1, "SELECT * FROM rowkery_types_t;", None), None);
    assert_eq!(run(2, "SELECT * FROM rowkery_types_t;", Some(100)), None);
    // Another cursor with other columns on the same session.
    assert_eq!(
        run(2, "SELECT id, m FROM rowkery_types_t;", Some(100)),
        None
    );
    // Tab 2's cursor still has rows (its transaction holds a lock the
    // ALTER would wait on); closing the tab ends it, as in the app.
    bridge.close_window_tab("w", 2);
    // The schema changes under a prepared statement: prepared again.
    assert_eq!(
        run(9, "ALTER TABLE rowkery_types_t ADD COLUMN extra int;", None),
        None
    );
    assert_eq!(run(1, "SELECT * FROM rowkery_types_t;", None), None);
    window_query(&bridge, "w", 9, "DROP TABLE rowkery_types_t");
    window_query(&bridge, "w", 9, "DROP TYPE rowkery_mood");
    std::env::remove_var("ROWKERY_CONFIG_DIR");
}

/// A TCP proxy to Postgres that can freeze: sockets stay open but nothing
/// passes either way, like a laptop waking on another network or an SSH
/// tunnel whose server went away. Returns its port and the switch.
fn freezing_proxy(upstream: String) -> (u16, Arc<std::sync::atomic::AtomicBool>) {
    use std::io::{Read, Write};
    use std::net::{TcpListener, TcpStream};
    use std::sync::atomic::AtomicBool;
    let frozen = Arc::new(AtomicBool::new(false));
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let port = listener.local_addr().unwrap().port();
    let pump = |mut from: TcpStream, mut to: TcpStream, frozen: Arc<AtomicBool>| {
        thread::spawn(move || {
            from.set_read_timeout(Some(std::time::Duration::from_millis(50)))
                .ok();
            let mut buf = [0u8; 16384];
            loop {
                if frozen.load(Ordering::SeqCst) {
                    thread::sleep(std::time::Duration::from_millis(50));
                    continue;
                }
                match from.read(&mut buf) {
                    Ok(0) => return,
                    // Read as the freeze began: lost, like on a dead link.
                    Ok(_) if frozen.load(Ordering::SeqCst) => {}
                    Ok(n) => {
                        if to.write_all(&buf[..n]).is_err() {
                            return;
                        }
                    }
                    Err(e)
                        if e.kind() == std::io::ErrorKind::WouldBlock
                            || e.kind() == std::io::ErrorKind::TimedOut => {}
                    Err(_) => return,
                }
            }
        });
    };
    let accept_frozen = frozen.clone();
    thread::spawn(move || {
        for client in listener.incoming().flatten() {
            let Ok(server) = TcpStream::connect(&upstream) else {
                continue;
            };
            pump(
                client.try_clone().unwrap(),
                server.try_clone().unwrap(),
                accept_frozen.clone(),
            );
            pump(server, client, accept_frozen.clone());
        }
    });
    (port, frozen)
}

/// Waits for the run's QueryFinished; returns (cancelled, error, waited).
fn wait_stopped(
    queue: &EventQueue,
    limit: std::time::Duration,
) -> Option<(bool, Option<String>, std::time::Duration)> {
    let start = std::time::Instant::now();
    while start.elapsed() < limit {
        for event in std::mem::take(&mut *queue.lock().unwrap()) {
            if let CoreEvent::QueryFinished {
                cancelled, error, ..
            } = event
            {
                return Some((cancelled, error, start.elapsed()));
            }
        }
        thread::sleep(std::time::Duration::from_millis(10));
    }
    None
}

/// A query sent into a dead connection never answers, and neither does a
/// cancel: the run is stopped anyway, a few seconds after Cancel (or at
/// once with Stop all), and the tab works again once the network does.
#[test]
fn postgres_cancel_stops_a_run_on_a_dead_connection() {
    let Ok(host) = std::env::var("ROWKERY_PG_HOST") else {
        eprintln!("skip postgres_cancel_stops_a_run_on_a_dead_connection (set ROWKERY_PG_HOST)");
        return;
    };
    let (_guard, _file, _path) = test_guard();
    let pg_port: u16 = std::env::var("ROWKERY_PG_PORT")
        .ok()
        .and_then(|p| p.parse().ok())
        .unwrap_or(54329);
    let (port, frozen) = freezing_proxy(format!("{host}:{pg_port}"));
    let bridge = super::CoreBridge::spawn();
    let id = "pg-dead-link";
    CoreBridge::upsert_connection(
        &bridge,
        ConnectionRecord::Postgres(PostgresConnection {
            allow_mcp: false,
            mcp_hidden_tables: Vec::new(),
            mcp_until: None,
            mcp_samples_off: false,
            mcp_timeout_s: None,
            mcp_access: None,
            masked_columns: Default::default(),
            environment: None,
            safe_mode: Default::default(),
            id: id.into(),
            name: "pg dead link".into(),
            host: "127.0.0.1".into(),
            port,
            database: std::env::var("ROWKERY_PG_DB").unwrap_or_else(|_| "rowkery".into()),
            username: std::env::var("ROWKERY_PG_USER").unwrap_or_else(|_| "rowkery".into()),
            ssl_mode: PostgresSslMode::Disable,
            ssl_root_cert: None,
            ssh: None,
            cloud_sql: None,
        }),
        ConnectionSecrets {
            db_password: Some(
                std::env::var("ROWKERY_PG_PASSWORD").unwrap_or_else(|_| "rowkery".into()),
            ),
            ..Default::default()
        },
    )
    .expect("save");
    bridge.open_window("w", id, None).expect("open");
    // A warm session in tab 1, then the network goes.
    assert_eq!(window_query(&bridge, "w", 1, "SELECT 1").1, None);
    frozen.store(true, Ordering::SeqCst);

    // Cancel: the server can't hear it; the run stops ~3 s later.
    let queue = bridge
        .run_window_query(
            "w",
            1,
            "SELECT * FROM generate_series(1, 10)".into(),
            None,
            false,
        )
        .expect("run");
    thread::sleep(std::time::Duration::from_millis(500));
    let early = wait_stopped(&queue, std::time::Duration::from_millis(10));
    assert!(early.is_none(), "hangs, but got {early:?}");
    bridge.cancel_window_query("w", 1);
    let (cancelled, _, waited) =
        wait_stopped(&queue, std::time::Duration::from_secs(8)).expect("stopped");
    assert!(cancelled);
    assert!(
        waited >= std::time::Duration::from_secs(2),
        "the cancel got its chance first"
    );

    // Cancel twice at once (a quick double Esc): one cancel, which gets its
    // chance before the run is stopped.
    let queue = bridge
        .run_window_query("w", 1, "SELECT 2".into(), None, false)
        .expect("run");
    thread::sleep(std::time::Duration::from_millis(300));
    bridge.cancel_window_query("w", 1);
    bridge.cancel_window_query("w", 1);
    let (cancelled, _, waited) =
        wait_stopped(&queue, std::time::Duration::from_secs(8)).expect("stopped");
    assert!(
        cancelled && waited >= std::time::Duration::from_secs(2),
        "{waited:?}"
    );

    // Cancel, and again a second later (Force stop): stopped at once.
    let queue = bridge
        .run_window_query("w", 1, "SELECT 2".into(), None, false)
        .expect("run");
    thread::sleep(std::time::Duration::from_millis(300));
    bridge.cancel_window_query("w", 1);
    thread::sleep(std::time::Duration::from_millis(1100));
    let early = wait_stopped(&queue, std::time::Duration::from_millis(10));
    assert!(
        early.is_none(),
        "still waiting on the cancel, but got {early:?}"
    );
    bridge.cancel_window_query("w", 1);
    let (cancelled, _, waited) =
        wait_stopped(&queue, std::time::Duration::from_secs(2)).expect("stopped");
    assert!(cancelled && waited < std::time::Duration::from_secs(1));

    // Stop all: every tab, at once.
    let q2 = bridge
        .run_window_query("w", 2, "SELECT 3".into(), None, false)
        .expect("run");
    let q3 = bridge
        .run_window_query("w", 3, "SELECT 4".into(), None, false)
        .expect("run");
    thread::sleep(std::time::Duration::from_millis(300));
    bridge.stop_all_queries();
    for q in [&q2, &q3] {
        let (cancelled, _, waited) =
            wait_stopped(q, std::time::Duration::from_secs(2)).expect("stopped");
        assert!(cancelled && waited < std::time::Duration::from_secs(1));
    }

    // The network is back: the tab runs on a fresh session.
    frozen.store(false, Ordering::SeqCst);
    assert_eq!(
        window_query(&bridge, "w", 1, "SELECT 5").0,
        Some(rowkery_core::db::Value::Int(5))
    );
    std::env::remove_var("ROWKERY_CONFIG_DIR");
}

/// Runs `sql` in a window tab; returns the first cell, error, cancelled
/// and elapsed ms.
fn window_query(
    bridge: &super::CoreBridge,
    window_id: &str,
    tab_id: u64,
    sql: &str,
) -> (
    Option<rowkery_core::db::Value>,
    Option<String>,
    bool,
    u64,
    Option<u64>,
) {
    let queue = bridge
        .run_window_query(window_id, tab_id, sql.into(), None, false)
        .expect("run");
    let mut cell = None;
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(10);
    while std::time::Instant::now() < deadline {
        let drained: Vec<CoreEvent> = std::mem::take(&mut *queue.lock().unwrap());
        for event in drained {
            match event {
                CoreEvent::QueryBatch { batch, .. } => {
                    cell = batch.rows.first().and_then(|r| r.first()).cloned();
                }
                CoreEvent::QueryFinished {
                    error,
                    cancelled,
                    elapsed_ms,
                    rows_affected,
                    ..
                } => return (cell, error, cancelled, elapsed_ms, rows_affected),
                _ => {}
            }
        }
        thread::sleep(std::time::Duration::from_millis(5));
    }
    panic!("query did not finish: {sql}");
}

#[test]
fn postgres_safe_mode_change_recycles_warm_sessions() {
    if std::env::var("ROWKERY_PG_HOST").is_err() {
        eprintln!("skip postgres_safe_mode_change_recycles_warm_sessions (set ROWKERY_PG_HOST)");
        return;
    }
    let (_guard, _file, _path) = test_guard();
    let bridge = super::CoreBridge::spawn();
    let id = "postgres-safe";
    let save = |safe_mode: SafeMode| {
        CoreBridge::upsert_connection(
            &bridge,
            ConnectionRecord::Postgres(PostgresConnection {
                environment: None,
                safe_mode,
                allow_mcp: false,
                mcp_hidden_tables: Vec::new(),
                mcp_until: None,
                mcp_samples_off: false,
                mcp_timeout_s: None,
                mcp_access: None,
                masked_columns: Default::default(),
                id: id.into(),
                name: "pg safe".into(),
                host: std::env::var("ROWKERY_PG_HOST").unwrap(),
                port: std::env::var("ROWKERY_PG_PORT")
                    .ok()
                    .and_then(|p| p.parse().ok())
                    .unwrap_or(54329),
                database: std::env::var("ROWKERY_PG_DB").unwrap_or_else(|_| "rowkery".into()),
                username: std::env::var("ROWKERY_PG_USER").unwrap_or_else(|_| "rowkery".into()),
                ssl_mode: PostgresSslMode::Disable,
                ssl_root_cert: None,
                ssh: None,
                cloud_sql: None,
            }),
            ConnectionSecrets {
                db_password: Some(
                    std::env::var("ROWKERY_PG_PASSWORD").unwrap_or_else(|_| "rowkery".into()),
                ),
                ..Default::default()
            },
        )
        .expect("save");
    };
    save(SafeMode::Off);
    bridge.open_window("w", id, None).expect("open");
    let read_only = || window_query(&bridge, "w", 1, "SHOW default_transaction_read_only").0;
    let text = |v: &str| Some(rowkery_core::db::Value::Text(v.into()));
    assert_eq!(read_only(), text("off"));
    // A function that turns the session's read-only default off, out of
    // sight of the text check.
    let flip = "CREATE OR REPLACE FUNCTION rowkery_safe_flip_ro() RETURNS text LANGUAGE sql \
                AS $$ SELECT set_config('default_transaction_read_only', 'off', false) $$";
    assert_eq!(window_query(&bridge, "w", 1, flip).1, None);

    // The tab's warm session was opened read-write: switching to
    // Read-only gives it a fresh, read-only one.
    save(SafeMode::ReadOnly);
    assert_eq!(read_only(), text("on"));
    let queue = bridge
        .run_window_query("w", 1, "CREATE TEMP TABLE t (n int)".into(), None, true)
        .expect("run");
    assert!(held(&queue).is_some(), "refused before it ran");
    // set_config on it is refused; a function doing it is undone before the next run.
    let queue = bridge
        .run_window_query(
            "w",
            1,
            "SELECT set_config('default_transaction_read_only', 'off', false)".into(),
            None,
            true,
        )
        .expect("run");
    assert!(held(&queue).is_some(), "set_config refused");
    assert_eq!(
        window_query(&bridge, "w", 1, "SELECT rowkery_safe_flip_ro()").0,
        text("off")
    );
    assert_eq!(read_only(), text("on"), "read-only again for the next run");

    // And back: Off drops the read-only session.
    save(SafeMode::Off);
    assert_eq!(read_only(), text("off"));
    assert_eq!(
        window_query(&bridge, "w", 1, "CREATE TEMP TABLE t (n int)").1,
        None
    );
    window_query(&bridge, "w", 1, "DROP FUNCTION rowkery_safe_flip_ro()");
    std::env::remove_var("ROWKERY_CONFIG_DIR");
}

/// A run sends a tab at most its cap: the batch that crosses it is cut,
/// later ones are dropped (still read), and the outcome says `capped`.
#[test]
fn forward_stops_at_the_cap() {
    let queue: EventQueue = Arc::default();
    let sink: SharedSink = queue.clone();
    let batch = |n: i64| RowBatch {
        columns: vec![rowkery_core::db::Column {
            name: "n".into(),
            type_name: String::new(),
        }],
        rows: (0..n)
            .map(|i| vec![rowkery_core::db::Value::Int(i)])
            .collect(),
    };
    let mut fwd = Forward::new(&sink, 1, 1, Some(5));
    fwd.batch(batch(3), true);
    fwd.batch(batch(3), false);
    fwd.batch(batch(3), false);
    let outcome = fwd.outcome(Ok(StreamStats::default())).expect("ok");
    assert_eq!((outcome.row_count, outcome.capped), (5, true));
    let sent: Vec<usize> = queue
        .lock()
        .unwrap()
        .iter()
        .filter_map(|e| match e {
            CoreEvent::QueryBatch { batch, .. } => Some(batch.rows.len()),
            _ => None,
        })
        .collect();
    assert_eq!(sent, [3, 2]);

    // Under the cap, or with none (an export): every row, not capped.
    let mut fwd = Forward::new(&sink, 2, 1, Some(9));
    fwd.batch(batch(9), true);
    let outcome = fwd.outcome(Ok(StreamStats::default())).expect("ok");
    assert_eq!((outcome.row_count, outcome.capped), (9, false));
    let mut fwd = Forward::new(&sink, 3, 1, None);
    fwd.batch(batch(9), true);
    fwd.batch(batch(9), false);
    assert_eq!(
        fwd.outcome(Ok(StreamStats::default())).unwrap().row_count,
        18
    );
}

/// A SQLite query tab pages a free-form read like a Postgres cursor:
/// the first page, then the rest on demand. Writes, reads with their own
/// LIMIT and table browses run whole; a new run ends the page.
#[test]
fn sqlite_query_tabs_page() {
    let (_guard, _file, path) = test_guard();
    {
        let conn = Connection::open(&path).expect("open");
        conn.execute_batch(
            "WITH RECURSIVE n(i) AS (SELECT 2 UNION ALL SELECT i + 1 FROM n WHERE i < 2500) \
                 INSERT INTO t SELECT i FROM n",
        )
        .expect("fill");
    }
    let bridge = super::CoreBridge::spawn();
    connect_sqlite(&bridge, path);
    let paged = |tab: u64, sql: &str, page: u32| {
        let queue: EventQueue = Arc::default();
        bridge
            .run_window_query_paged(
                "w1",
                tab,
                sql.into(),
                None,
                Some(page),
                false,
                queue.clone(),
            )
            .expect("run");
        drain_paged(&queue)
    };
    let more = |tab: u64, rows: u32| {
        let queue: EventQueue = Arc::default();
        bridge
            .fetch_more_to("w1", tab, rows, queue.clone())
            .expect("fetch");
        drain_paged(&queue)
    };
    let int = |n: i64| Some(rowkery_core::db::Value::Int(n));
    let sql = "SELECT id FROM t ORDER BY id";
    assert_eq!(paged(1, sql, 1000), (1000, int(1), None, true, true));
    assert_eq!(more(1, 1000), (1000, int(1001), None, true, true));
    assert_eq!(more(1, 1000), (500, int(2001), None, true, false));
    let (_, _, error, _, more_left) = more(1, 1000);
    assert!(error.is_some() && !more_left, "nothing left after the end");
    // The rest at once.
    assert!(paged(1, sql, 1000).4);
    assert_eq!(more(1, 0), (1500, int(1001), None, true, false));
    // Its own LIMIT: whole, not paged.
    assert_eq!(
        paged(1, &format!("{sql} LIMIT 3"), 1000),
        (3, int(1), None, false, false)
    );
    // A new run on the tab ends its page; another tab's stays.
    assert!(paged(1, sql, 1000).4);
    assert!(paged(2, sql, 1000).4);
    assert_eq!(paged(1, "SELECT 7", 1000), (1, int(7), None, true, false));
    assert!(more(1, 1000).2.is_some(), "the old page is gone");
    assert_eq!(more(2, 1000), (1000, int(1001), None, true, true));
    // A write runs once, whole, and is never paged.
    let (_, _, error, was_paged, _) = paged(
        3,
        "WITH x AS (SELECT 1) DELETE FROM t WHERE id > 2400 RETURNING id",
        10,
    );
    assert_eq!((error, was_paged), (None, false));
    assert_eq!(paged(3, "SELECT count(*) FROM t", 10).1, int(2400));
}

/// A SQLite tab keeps its connection between runs, like a Postgres tab its
/// session: BEGIN … ROLLBACK across runs undoes the DELETE, its pages read
/// inside its transaction, edits refuse to join it, closing the tab rolls
/// it back, and a restart is warned about while one is open.
#[test]
fn sqlite_tabs_keep_their_connection_between_runs() {
    let (_guard, _file, path) = test_guard();
    {
        let conn = Connection::open(&path).expect("open");
        conn.execute_batch(
            "CREATE TABLE orders (id INTEGER PRIMARY KEY, item TEXT);
             WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 30)
             INSERT INTO orders SELECT i, 'x' FROM n;",
        )
        .expect("seed");
    }
    let bridge = super::CoreBridge::spawn();
    connect_sqlite(&bridge, path.clone());
    let run = |tab: u64, sql: &str| window_query(&bridge, "w1", tab, sql);
    let count = |tab: u64| run(tab, "SELECT count(*) FROM orders").0;
    let on_disk = || {
        Connection::open(&path)
            .unwrap()
            .query_row("SELECT count(*) FROM orders", [], |r| r.get::<_, i64>(0))
            .unwrap()
    };

    // Three runs: the rollback undoes the delete.
    assert_eq!(run(1, "BEGIN").1, None);
    assert_eq!(run(1, "DELETE FROM orders").4, Some(30));
    assert_eq!(count(1), Some(Value::Int(0)), "inside the transaction");
    assert_eq!(bridge.busy_work().transactions, 1);
    assert_eq!(on_disk(), 30, "not committed");
    assert_eq!(run(1, "ROLLBACK").1, None);
    assert_eq!(count(1), Some(Value::Int(30)));
    assert_eq!(bridge.busy_work().transactions, 0);

    // Connection state carries too: a temp table, a pragma.
    run(1, "CREATE TEMP TABLE scratch (n)");
    run(1, "INSERT INTO scratch VALUES (1), (2)");
    assert_eq!(
        run(1, "SELECT count(*) FROM scratch").0,
        Some(Value::Int(2))
    );
    assert!(
        run(2, "SELECT count(*) FROM scratch").1.is_some(),
        "tab 2's own"
    );

    // A page and the next one read inside the tab's transaction.
    run(1, "BEGIN");
    run(1, "DELETE FROM orders WHERE id > 25");
    let queue: EventQueue = Arc::default();
    bridge
        .run_window_query_paged(
            "w1",
            1,
            "SELECT id FROM orders ORDER BY id".into(),
            None,
            Some(20),
            false,
            queue.clone(),
        )
        .expect("run");
    assert_eq!(drain_paged(&queue).0, 20);
    let queue: EventQueue = Arc::default();
    bridge
        .fetch_more_to("w1", 1, 20, queue.clone())
        .expect("fetch");
    assert_eq!(drain_paged(&queue).0, 5, "the uncommitted delete shows");

    // Edits never join it.
    let orders = edit_table(
        "main",
        "orders",
        &[("id", "INTEGER"), ("item", "TEXT")],
        &["id"],
    );
    let out = bridge
        .apply_changes(
            "w1",
            "cancel-sqlite",
            1,
            orders.clone(),
            vec![update(1, "item", Value::Text("y".into()))],
            None,
            None,
        )
        .expect("apply");
    let ApplyOutcome::RolledBack { failure, .. } = out else {
        panic!("{out:?}")
    };
    assert!(failure.message.contains("transaction open"), "{failure:?}");
    assert_eq!(count(1), Some(Value::Int(25)));

    // Closing the tab rolls it back; its next run starts fresh.
    bridge.close_window_tab("w1", 1);
    assert_eq!(on_disk(), 30);
    assert_eq!(count(1), Some(Value::Int(30)));
    assert!(run(1, "SELECT count(*) FROM scratch").1.is_some());

    // Re-pointing the window, or a new safe mode, would too: both are
    // refused while it's open, as on Postgres, and it stays as it was.
    run(1, "BEGIN");
    run(1, "DELETE FROM orders");
    assert_eq!(bridge.open_transactions(), vec![("w1".to_string(), 1)]);
    let refused = bridge
        .open_window("w1", "cancel-sqlite", None)
        .expect_err("refused");
    assert_eq!(refused, super::REPOINT_IN_TXN);
    let refused = set_safe_mode(&bridge, "cancel-sqlite", SafeMode::Confirm).expect_err("refused");
    assert!(refused.contains("transaction open"), "{refused}");
    assert_eq!(count(1), Some(Value::Int(0)));
    assert!(run(1, "ROLLBACK").1.is_none(), "the transaction was kept");
    assert!(bridge.open_transactions().is_empty());
    bridge
        .open_window("w1", "cancel-sqlite", None)
        .expect("reopen");
    assert_eq!(count(1), Some(Value::Int(30)));

    // With none open, edits save on the tab's connection.
    let out = bridge
        .apply_changes(
            "w1",
            "cancel-sqlite",
            1,
            orders,
            vec![update(1, "item", Value::Text("y".into()))],
            None,
            None,
        )
        .expect("apply");
    assert!(matches!(out, ApplyOutcome::Committed { .. }), "{out:?}");
    std::env::remove_var("ROWKERY_CONFIG_DIR");
}

/// A SQLite file with 30 orders, open in window `w1`.
fn sqlite_orders() -> (
    MutexGuard<'static, ()>,
    NamedTempFile,
    String,
    super::CoreBridge,
) {
    let (guard, file, path) = test_guard();
    Connection::open(&path)
        .expect("open")
        .execute_batch(
            "CREATE TABLE orders (id INTEGER PRIMARY KEY, item TEXT);
             WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 30)
             INSERT INTO orders SELECT i, 'x' FROM n;",
        )
        .expect("seed");
    let bridge = super::CoreBridge::spawn();
    connect_sqlite(&bridge, path.clone());
    (guard, file, path, bridge)
}

fn orders_on_disk(path: &str) -> i64 {
    Connection::open(path)
        .unwrap()
        .query_row("SELECT count(*) FROM orders", [], |r| r.get(0))
        .unwrap()
}

/// SQLite rolls back the whole transaction when a write inside it is
/// cancelled or fails a certain way; the tab says so, instead of
/// "Cancelled" or the bare error. A read cancelled inside one keeps it.
#[test]
fn sqlite_says_when_a_run_rolled_back_the_tabs_transaction() {
    let (_guard, _file, path, bridge) = sqlite_orders();
    let run = |sql: &str| window_query(&bridge, "w1", 1, sql);

    // An error: INSERT OR ROLLBACK on a duplicate key.
    run("BEGIN");
    assert_eq!(run("DELETE FROM orders WHERE id > 20").4, Some(10));
    let error = run("INSERT OR ROLLBACK INTO orders VALUES (1, 'dup')")
        .1
        .expect("fails");
    assert!(error.contains("UNIQUE"), "{error}");
    assert!(error.ends_with(SQLITE_ERROR_ROLLED_BACK), "{error}");
    assert_eq!(bridge.busy_work().transactions, 0);
    assert_eq!(run("SELECT count(*) FROM orders").0, Some(Value::Int(30)));

    // A plain error leaves the transaction open and says nothing more.
    run("BEGIN");
    let error = run("INSERT INTO orders VALUES (1, 'dup')")
        .1
        .expect("fails");
    assert!(!error.contains(SQLITE_ERROR_ROLLED_BACK), "{error}");
    assert_eq!(bridge.busy_work().transactions, 1);

    // A cancelled read keeps it.
    let queue = bridge
        .run_window_query("w1", 1, SLOW_SQLITE.into(), None, false)
        .expect("run");
    thread::sleep(std::time::Duration::from_millis(300));
    bridge.cancel_window_query("w1", 1);
    let (error, cancelled) =
        wait_query_finished(&queue, std::time::Duration::from_secs(5)).expect("finish");
    assert!(cancelled, "{error:?}");
    assert_eq!(bridge.busy_work().transactions, 1);

    // A cancelled write ends it.
    assert_eq!(run("DELETE FROM orders WHERE id > 20").4, Some(10));
    let queue = bridge
        .run_window_query(
            "w1",
            1,
            "INSERT INTO orders (item) \
             WITH RECURSIVE n(x) AS (SELECT 1 UNION ALL SELECT x + 1 FROM n) SELECT 'z' FROM n"
                .into(),
            None,
            false,
        )
        .expect("run");
    thread::sleep(std::time::Duration::from_millis(300));
    bridge.cancel_window_query("w1", 1);
    let (error, cancelled) =
        wait_query_finished(&queue, std::time::Duration::from_secs(5)).expect("finish");
    assert!(!cancelled);
    assert_eq!(error.as_deref(), Some(SQLITE_CANCEL_ROLLED_BACK));
    assert_eq!(bridge.busy_work().transactions, 0);
    assert_eq!(run("SELECT count(*) FROM orders").0, Some(Value::Int(30)));
    assert_eq!(orders_on_disk(&path), 30);
    std::env::remove_var("ROWKERY_CONFIG_DIR");
}

/// A SQLite connection doesn't switch to Read-only under a tab's open
/// transaction, as on Postgres: the change is refused, so a later COMMIT
/// can't write under Read-only what the tab deleted before (`query_only`
/// doesn't refuse COMMIT). Once it ends, the switch goes through.
#[test]
fn sqlite_read_only_waits_for_an_open_transaction() {
    let (_guard, _file, path, bridge) = sqlite_orders();
    let run = |sql: &str| window_query(&bridge, "w1", 1, sql);
    run("BEGIN");
    assert_eq!(run("DELETE FROM orders").4, Some(30));
    let refused = set_safe_mode(&bridge, "cancel-sqlite", SafeMode::ReadOnly).expect_err("refused");
    assert_eq!(refused, super::SAFE_MODE_IN_TXN);
    assert!(run("ROLLBACK").1.is_none(), "the transaction was kept");
    assert_eq!(orders_on_disk(&path), 30);
    set_safe_mode(&bridge, "cancel-sqlite", SafeMode::ReadOnly).expect("none open");
    assert_eq!(run("SELECT count(*) FROM orders").0, Some(Value::Int(30)));
    std::env::remove_var("ROWKERY_CONFIG_DIR");
}

/// A tab running a read inside its open transaction still counts as
/// holding it: a re-point or a safe mode change is refused until it ends,
/// and the transaction is kept. A read outside one doesn't count.
#[test]
fn sqlite_a_running_tab_keeps_its_transaction() {
    let (_guard, _file, path, bridge) = sqlite_orders();
    let run = |tab: u64, sql: &str| window_query(&bridge, "w1", tab, sql);
    let wait_running = || thread::sleep(Duration::from_millis(300));

    let queue = bridge
        .run_window_query("w1", 2, SLOW_SQLITE.into(), None, false)
        .expect("run");
    wait_running();
    assert!(bridge.open_transactions().is_empty(), "a read outside one");
    bridge.cancel_window_query("w1", 2);
    wait_query_finished(&queue, Duration::from_secs(5)).expect("stopped");

    // A write outside one may open one, so a re-point waits; closing the
    // tab (held) doesn't: it cancels the write, as it always did.
    let queue = bridge
        .run_window_query(
            "w1",
            2,
            format!("DELETE FROM orders WHERE id = ({SLOW_SQLITE})"),
            None,
            false,
        )
        .expect("run");
    wait_running();
    assert_eq!(bridge.open_transactions(), vec![("w1".to_string(), 2)]);
    assert!(bridge.held_transactions().is_empty(), "a write outside one");
    bridge.cancel_window_query("w1", 2);
    wait_query_finished(&queue, Duration::from_secs(5)).expect("stopped");

    run(1, "BEGIN");
    assert_eq!(run(1, "DELETE FROM orders").4, Some(30));
    let queue = bridge
        .run_window_query("w1", 1, SLOW_SQLITE.into(), None, false)
        .expect("run");
    wait_running();
    assert_eq!(bridge.open_transactions(), vec![("w1".to_string(), 1)]);
    assert_eq!(bridge.held_transactions(), vec![("w1".to_string(), 1)]);
    assert_eq!(bridge.busy_work().transactions, 1, "a quit asks first");
    let refused = bridge
        .open_window("w1", "cancel-sqlite", None)
        .expect_err("refused");
    assert_eq!(refused, super::REPOINT_IN_TXN);
    let refused = set_safe_mode(&bridge, "cancel-sqlite", SafeMode::ReadOnly).expect_err("refused");
    assert_eq!(refused, super::SAFE_MODE_IN_TXN);
    bridge.cancel_window_query("w1", 1);
    wait_query_finished(&queue, Duration::from_secs(5)).expect("stopped");
    assert!(run(1, "ROLLBACK").1.is_none(), "the transaction was kept");
    assert_eq!(orders_on_disk(&path), 30);
    std::env::remove_var("ROWKERY_CONFIG_DIR");
}

/// A write that waits out another tab's transaction says which tab holds
/// it, and a file replaced under a tab's open transaction refuses the
/// tab's next run instead of writing to the deleted copy.
#[cfg(unix)]
#[test]
fn sqlite_names_the_tab_holding_the_lock_and_notices_a_replaced_file() {
    let (_guard, _file, path, bridge) = sqlite_orders();
    let run = |tab: u64, sql: &str| window_query(&bridge, "w1", tab, sql);
    run(1, "BEGIN");
    assert_eq!(run(1, "DELETE FROM orders WHERE id > 20").4, Some(10));
    // Waits out the busy timeout (5 s), then names the other tab.
    assert_eq!(
        run(2, "DELETE FROM orders").1.as_deref(),
        Some(SQLITE_HELD_HERE)
    );

    let fresh = path.clone() + ".fresh";
    std::fs::copy(&path, &fresh).expect("copy");
    std::fs::rename(&fresh, &path).expect("replace");
    assert_eq!(run(1, "COMMIT").1.as_deref(), Some(SQLITE_FILE_REPLACED));
    assert_eq!(
        run(1, "SELECT count(*) FROM orders").0,
        Some(Value::Int(30))
    );
    assert_eq!(bridge.busy_work().transactions, 0);
    std::env::remove_var("ROWKERY_CONFIG_DIR");
}

/// What a paged run or `fetch_more` streamed: rows, first cell, error,
/// and the done event's `paged` / `more`.
fn drain_paged(
    queue: &EventQueue,
) -> (
    u64,
    Option<rowkery_core::db::Value>,
    Option<String>,
    bool,
    bool,
) {
    let mut cell = None;
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(10);
    while std::time::Instant::now() < deadline {
        let drained: Vec<CoreEvent> = std::mem::take(&mut *queue.lock().unwrap());
        for event in drained {
            match event {
                CoreEvent::QueryBatch { batch, .. } if cell.is_none() => {
                    cell = batch.rows.first().and_then(|r| r.first()).cloned();
                }
                CoreEvent::QueryFinished {
                    row_count,
                    error,
                    detail,
                    ..
                } => return (row_count, cell, error, detail.paged, detail.more),
                _ => {}
            }
        }
        thread::sleep(std::time::Duration::from_millis(5));
    }
    panic!("paged run did not finish");
}

/// Query tabs page free-form reads through a cursor: pages until the
/// end, `nextval()` still commits, an open user transaction is left as
/// it was, statements that can't be cursors run as written, and a
/// failed page leaves the tab usable.
#[test]
fn postgres_query_tabs_page_through_a_cursor() {
    if std::env::var("ROWKERY_PG_HOST").is_err() {
        eprintln!("skip postgres_query_tabs_page_through_a_cursor (set ROWKERY_PG_HOST)");
        return;
    }
    let (_guard, _file, _path) = test_guard();
    let bridge = super::CoreBridge::spawn();
    let id = "postgres-paged";
    CoreBridge::upsert_connection(
        &bridge,
        ConnectionRecord::Postgres(PostgresConnection {
            allow_mcp: false,
            mcp_hidden_tables: Vec::new(),
            mcp_until: None,
            mcp_samples_off: false,
            mcp_timeout_s: None,
            mcp_access: None,
            masked_columns: Default::default(),
            environment: None,
            safe_mode: SafeMode::Off,
            id: id.into(),
            name: "pg paged".into(),
            host: std::env::var("ROWKERY_PG_HOST").unwrap(),
            port: std::env::var("ROWKERY_PG_PORT")
                .ok()
                .and_then(|p| p.parse().ok())
                .unwrap_or(54329),
            database: std::env::var("ROWKERY_PG_DB").unwrap_or_else(|_| "rowkery".into()),
            username: std::env::var("ROWKERY_PG_USER").unwrap_or_else(|_| "rowkery".into()),
            ssl_mode: PostgresSslMode::Disable,
            ssl_root_cert: None,
            ssh: None,
            cloud_sql: None,
        }),
        ConnectionSecrets {
            db_password: Some(
                std::env::var("ROWKERY_PG_PASSWORD").unwrap_or_else(|_| "rowkery".into()),
            ),
            ..Default::default()
        },
    )
    .expect("save");
    bridge.open_window("w", id, None).expect("open");
    let paged = |tab: u64, sql: &str, page: u32| {
        let queue: EventQueue = Arc::default();
        bridge
            .run_window_query_paged("w", tab, sql.into(), None, Some(page), false, queue.clone())
            .expect("run");
        drain_paged(&queue)
    };
    let more = |tab: u64, rows: u32| {
        let queue: EventQueue = Arc::default();
        bridge
            .fetch_more_to("w", tab, rows, queue.clone())
            .expect("fetch");
        drain_paged(&queue)
    };
    let int = |n: i64| Some(rowkery_core::db::Value::Int(n));
    let plain = |tab: u64, sql: &str| window_query(&bridge, "w", tab, sql);
    assert_eq!(plain(9, "DROP TABLE IF EXISTS paged_t").1, None);
    assert_eq!(plain(9, "CREATE TABLE paged_t (n int)").1, None);
    assert_eq!(plain(9, "DROP SEQUENCE IF EXISTS paged_seq").1, None);
    assert_eq!(plain(9, "CREATE SEQUENCE paged_seq").1, None);

    // 2,500 rows, 1,000 at a time.
    let sql = "SELECT g::int8 FROM generate_series(1, 2500) g";
    assert_eq!(paged(1, sql, 1000), (1000, int(1), None, true, true));
    assert_eq!(more(1, 1000), (1000, int(1001), None, true, true));
    assert_eq!(more(1, 1000), (500, int(2001), None, true, false));
    let (_, _, error, _, more_left) = more(1, 1000);
    assert!(
        error.is_some() && !more_left,
        "the cursor closed at the end"
    );
    // All at once.
    assert_eq!(paged(1, sql, 0), (2500, int(1), None, true, false));
    // Bounded by its own LIMIT: not paged.
    let queue: EventQueue = Arc::default();
    bridge
        .run_window_query_paged(
            "w",
            1,
            format!("{sql} LIMIT 3"),
            None,
            Some(1000),
            false,
            queue.clone(),
        )
        .expect("run");
    assert_eq!(drain_paged(&queue), (3, int(1), None, false, false));

    // An export runs the whole statement inside the tab's open cursor
    // transaction and leaves the cursor where it was.
    assert!(paged(1, sql, 1000).4);
    let queue: EventQueue = Arc::default();
    bridge
        .run_window_export_to("w", 1, sql.into(), queue.clone())
        .expect("export");
    assert_eq!(drain_paged(&queue), (2500, int(1), None, false, false));
    assert_eq!(more(1, 1000), (1000, int(1001), None, true, true));
    assert!(bridge
        .run_window_export_to("w", 1, "DELETE FROM paged_t".into(), queue.clone())
        .is_err());

    // nextval() commits with the cursor's transaction.
    let (n, _, error, _, _) = paged(
        2,
        "SELECT nextval('paged_seq') FROM generate_series(1, 5)",
        1000,
    );
    assert_eq!((n, error), (5, None));
    assert_eq!(plain(9, "SELECT last_value FROM paged_seq").0, int(5));

    // A write after an open page runs on its own, not inside our transaction.
    assert!(paged(2, sql, 1000).4);
    assert_eq!(plain(2, "INSERT INTO paged_t VALUES (1)").1, None);
    assert_eq!(plain(9, "SELECT count(*) FROM paged_t").0, int(1));

    // Inside the user's transaction the cursor is declared in it: it
    // pages, sees the transaction's own rows, and closing it neither
    // commits nor rolls back their transaction.
    assert_eq!(plain(3, "BEGIN").1, None);
    assert_eq!(plain(3, "INSERT INTO paged_t VALUES (2)").1, None);
    assert_eq!(paged(3, sql, 1000), (1000, int(1), None, true, true));
    assert_eq!(more(3, 1000), (1000, int(1001), None, true, true));
    assert_eq!(
        paged(3, "SELECT count(*)::int8 FROM paged_t", 1000),
        (1, int(2), None, true, false)
    );
    assert_eq!(plain(3, "SELECT count(*) FROM paged_t").0, int(2));
    assert_eq!(plain(3, "ROLLBACK").1, None);
    assert_eq!(plain(9, "SELECT count(*) FROM paged_t").0, int(1));
    // Once it ends, the tab pages in its own transaction again.
    assert_eq!(paged(3, sql, 1000), (1000, int(1), None, true, true));
    // A transaction opened on a session that just paged is seen too,
    // and stays the user's: their ROLLBACK still undoes their insert.
    assert_eq!(plain(3, "BEGIN").1, None);
    assert_eq!(paged(3, sql, 1000), (1000, int(1), None, true, true));
    assert_eq!(plain(3, "INSERT INTO paged_t VALUES (5)").1, None);
    assert_eq!(paged(3, sql, 1000), (1000, int(1), None, true, true));
    assert_eq!(plain(3, "ROLLBACK").1, None);
    assert_eq!(plain(9, "SELECT count(*) FROM paged_t").0, int(1));
    // A locking read in their transaction runs whole: a cursor would
    // lock only the rows fetched so far.
    assert_eq!(plain(3, "BEGIN").1, None);
    assert_eq!(
        paged(3, "SELECT n::int8 FROM paged_t FOR UPDATE", 1000),
        (1, int(1), None, false, false)
    );
    assert_eq!(plain(3, "COMMIT").1, None);

    // Can't be a cursor (data-modifying WITH): runs as written.
    let (n, _, error, was_paged, _) = paged(
        4,
        "WITH d AS (DELETE FROM paged_t WHERE n = 1 RETURNING n) SELECT n FROM d",
        1000,
    );
    assert_eq!((n, error, was_paged), (1, None, false));
    assert_eq!(plain(9, "SELECT count(*) FROM paged_t").0, int(0));

    // The same inside the user's transaction keeps that transaction usable.
    assert_eq!(plain(4, "BEGIN").1, None);
    assert_eq!(plain(4, "INSERT INTO paged_t VALUES (3)").1, None);
    let (_, _, error, was_paged, _) = paged(
        4,
        "WITH d AS (DELETE FROM paged_t WHERE n = 3 RETURNING n) SELECT n FROM d",
        1000,
    );
    assert_eq!((error, was_paged), (None, false));
    assert_eq!(plain(4, "COMMIT").1, None);

    // A failed transaction stays the user's to roll back.
    assert_eq!(plain(5, "BEGIN").1, None);
    assert!(plain(5, "SELECT 1/0").1.is_some());
    assert!(paged(5, sql, 1000).2.is_some());
    assert_eq!(plain(5, "ROLLBACK").1, None);
    assert_eq!(plain(5, "SELECT 7::int8").0, int(7));

    // A page that fails (division by zero at row 1,500) ends the cursor;
    // the tab runs the next query normally.
    let failing = "SELECT (1 / (g - 1500))::int8 FROM generate_series(1, 3000) g";
    assert!(paged(6, failing, 1000).4);
    let (_, _, error, _, more_left) = more(6, 1000);
    assert!(error.is_some_and(|e| e.contains("division")) && !more_left);
    assert_eq!(plain(6, "SELECT 8::int8").0, int(8));
    assert_eq!(plain(6, "INSERT INTO paged_t VALUES (4)").1, None);
    assert_eq!(
        plain(9, "SELECT count(*) FROM paged_t WHERE n = 4").0,
        int(1)
    );

    assert_eq!(plain(9, "DROP TABLE paged_t").1, None);
    assert_eq!(plain(9, "DROP SEQUENCE paged_seq").1, None);
    std::env::remove_var("ROWKERY_CONFIG_DIR");
}

/// Saves the test Postgres as connection `id`, or `None` without ROWKERY_PG_HOST.
fn save_test_pg(bridge: &super::CoreBridge, id: &str) -> Option<()> {
    let host = std::env::var("ROWKERY_PG_HOST").ok()?;
    CoreBridge::upsert_connection(
        bridge,
        ConnectionRecord::Postgres(PostgresConnection {
            allow_mcp: false,
            mcp_hidden_tables: Vec::new(),
            mcp_until: None,
            mcp_samples_off: false,
            mcp_timeout_s: None,
            mcp_access: None,
            masked_columns: Default::default(),
            environment: None,
            safe_mode: Default::default(),
            id: id.into(),
            name: id.into(),
            host,
            port: std::env::var("ROWKERY_PG_PORT")
                .ok()
                .and_then(|p| p.parse().ok())
                .unwrap_or(54329),
            database: std::env::var("ROWKERY_PG_DB").unwrap_or_else(|_| "rowkery".into()),
            username: std::env::var("ROWKERY_PG_USER").unwrap_or_else(|_| "rowkery".into()),
            ssl_mode: PostgresSslMode::Disable,
            ssl_root_cert: None,
            ssh: None,
            cloud_sql: None,
        }),
        ConnectionSecrets {
            db_password: Some(
                std::env::var("ROWKERY_PG_PASSWORD").unwrap_or_else(|_| "rowkery".into()),
            ),
            ..Default::default()
        },
    )
    .expect("save");
    Some(())
}

/// Every row a window query returns, and whether it failed.
fn window_rows(
    bridge: &super::CoreBridge,
    window_id: &str,
    tab_id: u64,
    sql: &str,
) -> (Vec<Vec<Value>>, Option<String>) {
    let queue = bridge
        .run_window_query(window_id, tab_id, sql.into(), None, false)
        .expect("run");
    let mut rows = Vec::new();
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(10);
    while std::time::Instant::now() < deadline {
        for event in std::mem::take(&mut *queue.lock().unwrap()) {
            match event {
                CoreEvent::QueryBatch { batch, .. } => rows.extend(batch.rows),
                CoreEvent::QueryFinished { error, .. } => return (rows, error),
                _ => {}
            }
        }
        thread::sleep(std::time::Duration::from_millis(5));
    }
    panic!("query did not finish: {sql}");
}

fn prefetch_sessions(bridge: &super::CoreBridge, window_id: &str) -> i64 {
    let (n, ..) = window_query(
            bridge,
            window_id,
            99,
            &format!(
                "SELECT count(*)::int FROM pg_stat_activity WHERE datname = current_database() AND application_name = '{}'",
                super::PREFETCH_APPLICATION_NAME
            ),
        );
    match n {
        Some(Value::Int(n)) => n,
        other => panic!("count: {other:?}"),
    }
}

/// Hover prefetch reads the first 200 rows through a cursor; the click
/// on the same browse shows them and FETCHes the rest of that cursor (so
/// a row changed in between still reads as it was when the prefetch
/// declared it), on one prefetch session.
#[test]
fn postgres_prefetch_is_the_first_fetch_the_click_continues() {
    let (_guard, _file, _path) = test_guard();
    let bridge = super::CoreBridge::spawn();
    if save_test_pg(&bridge, "pg-prefetch").is_none() {
        eprintln!(
            "skip postgres_prefetch_is_the_first_fetch_the_click_continues (set ROWKERY_PG_HOST)"
        );
        return;
    }
    bridge.open_window("w", "pg-prefetch", None).expect("open");
    bridge
        .open_window("other", "pg-prefetch", None)
        .expect("open other");
    window_query(&bridge, "w", 1, "DROP TABLE IF EXISTS pf_items");
    window_query(
        &bridge,
        "w",
        1,
        "CREATE TABLE pf_items (id int PRIMARY KEY, n text)",
    );
    window_query(
        &bridge,
        "w",
        1,
        "INSERT INTO pf_items SELECT i, 'n' || i FROM generate_series(1, 1500) i",
    );
    let sql = "SELECT * FROM public.pf_items ORDER BY id LIMIT 1000";
    let before = prefetch_sessions(&bridge, "w");
    assert_eq!(bridge.prefetch_table("w", sql.into()), Ok(true));
    assert!(bridge.prefetched("w", sql));
    assert_eq!(
        prefetch_sessions(&bridge, "w"),
        before + 1,
        "one prefetch session"
    );

    // Another window writes (it can't see this window's cache).
    window_query(
        &bridge,
        "other",
        1,
        "UPDATE pf_items SET n = 'changed' WHERE id IN (5, 900)",
    );
    let (rows, error) = window_rows(&bridge, "w", 2, sql);
    assert_eq!(error, None);
    assert_eq!(
        rows.len(),
        1000,
        "the cached 200 and the cursor's other 800"
    );
    let ids: Vec<i64> = rows
        .iter()
        .map(|r| match &r[0] {
            Value::Int(n) => *n,
            other => panic!("id: {other:?}"),
        })
        .collect();
    assert_eq!(ids, (1..=1000).collect::<Vec<_>>());
    assert_eq!(
        rows[4][1],
        Value::Text("n5".into()),
        "row 5 from the cached page"
    );
    assert_eq!(
        rows[899][1],
        Value::Text("n900".into()),
        "row 900 from the same cursor, not a second query"
    );
    assert!(!bridge.prefetched("w", sql), "a page serves one click");
    // The next click runs it afresh.
    let (rows, _) = window_rows(&bridge, "w", 2, sql);
    assert_eq!(rows[899][1], Value::Text("changed".into()));
    window_query(&bridge, "w", 1, "DROP TABLE pf_items");
    bridge.close_window("w");
    bridge.close_window("other");
    std::env::remove_var("ROWKERY_CONFIG_DIR");
}

/// Eight pages at most (the oldest cursor closes), one prefetch in flight
/// that the pointer leaving cancels without losing the other cursors, a
/// write in the window drops them all, and safe mode's Read-only still
/// lets a browse be prefetched.
#[test]
fn postgres_prefetch_lru_cancel_and_writes() {
    let (_guard, _file, _path) = test_guard();
    let bridge = Arc::new(super::CoreBridge::spawn());
    if save_test_pg(&bridge, "pg-prefetch-lru").is_none() {
        eprintln!("skip postgres_prefetch_lru_cancel_and_writes (set ROWKERY_PG_HOST)");
        return;
    }
    bridge
        .open_window("w", "pg-prefetch-lru", None)
        .expect("open");
    window_query(&bridge, "w", 1, "DROP TABLE IF EXISTS pf_lru");
    window_query(&bridge, "w", 1, "CREATE TABLE pf_lru (id int PRIMARY KEY)");
    window_query(
        &bridge,
        "w",
        1,
        "INSERT INTO pf_lru SELECT generate_series(1, 600)",
    );
    let before = prefetch_sessions(&bridge, "w");
    let page = |from: usize| {
        format!("SELECT * FROM public.pf_lru WHERE id > {from} ORDER BY id LIMIT 300")
    };
    for i in 0..=super::PREFETCH_MAX_ENTRIES {
        assert_eq!(bridge.prefetch_table("w", page(i)), Ok(true));
    }
    assert!(!bridge.prefetched("w", &page(0)), "the oldest went");
    for i in 1..=super::PREFETCH_MAX_ENTRIES {
        assert!(bridge.prefetched("w", &page(i)), "page {i} kept");
    }
    assert_eq!(
        prefetch_sessions(&bridge, "w"),
        before + 1,
        "one prefetch session for nine"
    );

    // The pointer leaves while a slow one runs: cancelled on the server.
    let slow = "SELECT pg_sleep(5) AS s, id FROM public.pf_lru LIMIT 1".to_string();
    let started = std::time::Instant::now();
    let waiting = {
        let bridge = bridge.clone();
        thread::spawn(move || bridge.prefetch_table("w", slow))
    };
    thread::sleep(std::time::Duration::from_millis(400));
    bridge.cancel_prefetch("w");
    assert_eq!(waiting.join().unwrap(), Ok(false));
    assert!(
        started.elapsed() >= std::time::Duration::from_millis(400),
        "it was running"
    );
    assert!(
        started.elapsed() < std::time::Duration::from_secs(3),
        "cancelled, not finished"
    );

    // The other cursors survived: a click still continues one.
    let (rows, error) = window_rows(&bridge, "w", 2, &page(3));
    assert_eq!(error, None);
    assert_eq!(rows.len(), 300);
    assert_eq!(rows[299][0], Value::Int(303));

    // A write in this window: nothing cached is served again.
    assert!(bridge.prefetched("w", &page(4)));
    window_query(&bridge, "w", 1, "UPDATE pf_lru SET id = id WHERE id = 1");
    assert!(!bridge.prefetched("w", &page(4)));
    // And the next prefetch starts clean.
    assert_eq!(bridge.prefetch_table("w", page(4)), Ok(true));
    let (rows, _) = window_rows(&bridge, "w", 2, &page(4));
    assert_eq!(rows.len(), 300);

    // A write is never prefetched.
    assert_eq!(
        bridge.prefetch_table("w", "DELETE FROM pf_lru".into()),
        Ok(false)
    );
    window_query(&bridge, "w", 1, "DROP TABLE pf_lru");
    bridge.close_window("w");
    std::env::remove_var("ROWKERY_CONFIG_DIR");
}

/// Quick Look follows three keys on one session of its own, never a tab's,
/// and later lookups reuse it.
#[test]
fn postgres_follow_keys_use_one_quick_look_session() {
    if std::env::var("ROWKERY_PG_HOST").is_err() {
        eprintln!("skip postgres_follow_keys_use_one_quick_look_session (set ROWKERY_PG_HOST)");
        return;
    }
    let (_guard, _file, _path) = test_guard();
    let bridge = super::CoreBridge::spawn();
    let id = "postgres-follow";
    CoreBridge::upsert_connection(
        &bridge,
        ConnectionRecord::Postgres(PostgresConnection {
            allow_mcp: false,
            mcp_hidden_tables: Vec::new(),
            mcp_until: None,
            mcp_samples_off: false,
            mcp_timeout_s: None,
            mcp_access: None,
            masked_columns: Default::default(),
            environment: None,
            safe_mode: Default::default(),
            id: id.into(),
            name: "pg follow".into(),
            host: std::env::var("ROWKERY_PG_HOST").unwrap(),
            port: std::env::var("ROWKERY_PG_PORT")
                .ok()
                .and_then(|p| p.parse().ok())
                .unwrap_or(54329),
            database: std::env::var("ROWKERY_PG_DB").unwrap_or_else(|_| "rowkery".into()),
            username: std::env::var("ROWKERY_PG_USER").unwrap_or_else(|_| "rowkery".into()),
            ssl_mode: PostgresSslMode::Disable,
            ssl_root_cert: None,
            ssh: None,
            cloud_sql: None,
        }),
        ConnectionSecrets {
            db_password: Some(
                std::env::var("ROWKERY_PG_PASSWORD").unwrap_or_else(|_| "rowkery".into()),
            ),
            ..Default::default()
        },
    )
    .expect("save");
    bridge.open_window("w", id, None).expect("open");
    // Tab 1 holds an open transaction the lookups must not join.
    window_query(
        &bridge,
        "w",
        1,
        "CREATE TABLE IF NOT EXISTS follow_parent (id int PRIMARY KEY, name text)",
    );
    window_query(&bridge, "w", 1, "INSERT INTO follow_parent VALUES (1, 'one'), (2, 'two'), (3, 'three') ON CONFLICT DO NOTHING");
    window_query(&bridge, "w", 1, "BEGIN");
    let backends = |bridge: &super::CoreBridge| {
        let (n, ..) = window_query(
                bridge,
                "w",
                1,
                "SELECT count(*)::int FROM pg_stat_activity WHERE datname = current_database() AND backend_type = 'client backend'",
            );
        match n {
            Some(Value::Int(n)) => n,
            other => panic!("count: {other:?}"),
        }
    };
    let before = backends(&bridge);
    let look = |value: i64| FollowLookup {
        schema: "public".into(),
        table: "follow_parent".into(),
        column: "id".into(),
        value: Value::Int(value),
    };
    let rows = bridge
        .follow_keys("w", vec![look(1), look(2), look(3)])
        .expect("follow");
    let names: Vec<Value> = rows
        .iter()
        .map(|r| r.as_ref().unwrap().row[1].clone())
        .collect();
    assert_eq!(
        names,
        [
            Value::Text("one".into()),
            Value::Text("two".into()),
            Value::Text("three".into())
        ]
    );
    let after = backends(&bridge);
    assert!(
        after <= before + 1,
        "three lookups opened {} sessions",
        after - before
    );
    bridge.follow_keys("w", vec![look(2)]).expect("again");
    assert_eq!(backends(&bridge), after, "the Quick Look session is reused");
    // Incoming counts run on that same session too.
    let counts = bridge
        .count_incoming("w", vec![look(2), look(9)])
        .expect("count");
    assert_eq!(counts, [Some(1), Some(0)]);
    assert_eq!(
        backends(&bridge),
        after,
        "Incoming reuses the Quick Look session"
    );
    window_query(&bridge, "w", 1, "ROLLBACK");
    std::env::remove_var("ROWKERY_CONFIG_DIR");
}

/// The Sessions tab sees a lock chain, labels our own tab, and stops a
/// session through safe mode.
#[test]
fn postgres_sessions_show_a_lock_chain_and_stop_one() {
    if std::env::var("ROWKERY_PG_HOST").is_err() {
        eprintln!("skip postgres_sessions_show_a_lock_chain_and_stop_one (set ROWKERY_PG_HOST)");
        return;
    }
    let (_guard, _file, _path) = test_guard();
    let bridge = super::CoreBridge::spawn();
    let id = "postgres-sessions";
    CoreBridge::upsert_connection(
        &bridge,
        ConnectionRecord::Postgres(PostgresConnection {
            allow_mcp: false,
            mcp_hidden_tables: Vec::new(),
            mcp_until: None,
            mcp_samples_off: false,
            mcp_timeout_s: None,
            mcp_access: None,
            masked_columns: Default::default(),
            environment: None,
            safe_mode: Default::default(),
            id: id.into(),
            name: "pg sessions".into(),
            host: std::env::var("ROWKERY_PG_HOST").unwrap(),
            port: std::env::var("ROWKERY_PG_PORT")
                .ok()
                .and_then(|p| p.parse().ok())
                .unwrap_or(54329),
            database: std::env::var("ROWKERY_PG_DB").unwrap_or_else(|_| "rowkery".into()),
            username: std::env::var("ROWKERY_PG_USER").unwrap_or_else(|_| "rowkery".into()),
            ssl_mode: PostgresSslMode::Disable,
            ssl_root_cert: None,
            ssh: None,
            cloud_sql: None,
        }),
        ConnectionSecrets {
            db_password: Some(
                std::env::var("ROWKERY_PG_PASSWORD").unwrap_or_else(|_| "rowkery".into()),
            ),
            ..Default::default()
        },
    )
    .expect("save");
    bridge.open_window("w", id, None).expect("open");
    window_query(
        &bridge,
        "w",
        1,
        "CREATE TABLE IF NOT EXISTS fixb_sessions (x int)",
    );
    let pid = |tab| match window_query(&bridge, "w", tab, "SELECT pg_backend_pid()").0 {
        Some(Value::Int(p)) => p as i32,
        other => panic!("pid: {other:?}"),
    };
    let holder = pid(1);
    window_query(&bridge, "w", 1, "BEGIN");
    let (_, err, ..) = window_query(
        &bridge,
        "w",
        1,
        "LOCK TABLE fixb_sessions IN ACCESS EXCLUSIVE MODE",
    );
    assert_eq!(err, None);
    // Tab 2 waits on tab 1's lock.
    let waiting = bridge
        .run_window_query(
            "w",
            2,
            "SELECT count(*) FROM fixb_sessions".into(),
            None,
            false,
        )
        .expect("run");
    let deadline = Instant::now() + Duration::from_secs(5);
    let rows = loop {
        let rows = bridge.sessions("w").expect("sessions");
        if rows.iter().any(|r| r.session.blocked_by.contains(&holder)) || Instant::now() > deadline
        {
            break rows;
        }
        thread::sleep(Duration::from_millis(50));
    };
    let ours = rows
        .iter()
        .find(|r| r.session.pid == holder)
        .expect("the holder is listed");
    assert_eq!(
        ours.tab,
        Some(super::SessionTab {
            window_id: "w".into(),
            tab_id: 1
        })
    );
    assert_eq!(ours.session.state.as_deref(), Some("idle in transaction"));
    assert!(ours.session.can_stop);
    let blocked = rows
        .iter()
        .find(|r| r.session.blocked_by.contains(&holder))
        .expect("tab 2 waits on tab 1");
    assert_eq!(blocked.session.wait.as_deref(), Some("Lock: relation"));
    let locks = bridge.session_locks("w", holder).expect("locks");
    assert!(locks
        .iter()
        .any(|l| l.table == "public.fixb_sessions" && l.mode == "AccessExclusiveLock"));

    // Cancel runs at once with safe mode off; End always asks first.
    assert_eq!(
        bridge.stop_session("w", blocked.session.pid, StopKind::Cancel, false),
        Ok(super::StopOutcome::Stopped { gone: false })
    );
    wait_stopped(&waiting, Duration::from_secs(5)).expect("tab 2 stops");
    assert_eq!(
        bridge.stop_session("w", holder, StopKind::End, false),
        Ok(super::StopOutcome::Held {
            sql: format!("SELECT pg_terminate_backend({holder})")
        })
    );
    assert_eq!(
        bridge.stop_session("w", holder, StopKind::End, true),
        Ok(super::StopOutcome::Stopped { gone: false })
    );
    thread::sleep(Duration::from_millis(200));
    let (_, err, ..) = window_query(&bridge, "w", 1, "SELECT 1");
    assert!(
        err.is_some_and(|e| e.contains("transaction")),
        "tab 1 is told its transaction went"
    );
    window_query(&bridge, "w", 3, "DROP TABLE fixb_sessions");
    std::env::remove_var("ROWKERY_CONFIG_DIR");
}

/// A session the server killed while parked is replaced at lease, before
/// anything is sent (so even a write is safe); `ping_idle` replaces dead
/// idle sessions ahead of the next run and leaves live ones alone.
#[test]
fn postgres_dead_sessions_are_replaced_off_the_query_path() {
    if std::env::var("ROWKERY_PG_HOST").is_err() {
        eprintln!(
            "skip postgres_dead_sessions_are_replaced_off_the_query_path (set ROWKERY_PG_HOST)"
        );
        return;
    }
    let (_guard, _file, _path) = test_guard();
    let bridge = super::CoreBridge::spawn();
    let id = "postgres-dead";
    CoreBridge::upsert_connection(
        &bridge,
        ConnectionRecord::Postgres(PostgresConnection {
            allow_mcp: false,
            mcp_hidden_tables: Vec::new(),
            mcp_until: None,
            mcp_samples_off: false,
            mcp_timeout_s: None,
            mcp_access: None,
            masked_columns: Default::default(),
            environment: None,
            safe_mode: Default::default(),
            id: id.into(),
            name: "pg dead".into(),
            host: std::env::var("ROWKERY_PG_HOST").unwrap(),
            port: std::env::var("ROWKERY_PG_PORT")
                .ok()
                .and_then(|p| p.parse().ok())
                .unwrap_or(54329),
            database: std::env::var("ROWKERY_PG_DB").unwrap_or_else(|_| "rowkery".into()),
            username: std::env::var("ROWKERY_PG_USER").unwrap_or_else(|_| "rowkery".into()),
            ssl_mode: PostgresSslMode::Disable,
            ssl_root_cert: None,
            ssh: None,
            cloud_sql: None,
        }),
        ConnectionSecrets {
            db_password: Some(
                std::env::var("ROWKERY_PG_PASSWORD").unwrap_or_else(|_| "rowkery".into()),
            ),
            ..Default::default()
        },
    )
    .expect("save");
    bridge.open_window("w", id, None).expect("open");
    let pid = |tab| match window_query(&bridge, "w", tab, "SELECT pg_backend_pid()").0 {
        Some(Value::Int(p)) => p,
        other => panic!("pid: {other:?}"),
    };
    let kill = |victim: i64| {
        let (_, err, ..) = window_query(
            &bridge,
            "w",
            9,
            &format!("SELECT pg_terminate_backend({victim})"),
        );
        assert_eq!(err, None);
        thread::sleep(std::time::Duration::from_millis(200));
    };
    let (name, ..) = window_query(&bridge, "w", 1, "SHOW application_name");
    assert!(
        matches!(name, Some(Value::Text(ref n)) if n.starts_with("Rowkery ")),
        "{name:?}"
    );

    // Killed while parked: the next statement, a write, runs on a fresh one.
    let first = pid(1);
    kill(first);
    window_query(
        &bridge,
        "w",
        1,
        "CREATE TEMP TABLE IF NOT EXISTS t_dead (x int)",
    );
    let (_, err, ..) = window_query(&bridge, "w", 1, "INSERT INTO t_dead VALUES (1)");
    assert_eq!(err, None, "a write after the kill runs on a replacement");
    let second = pid(1);
    assert_ne!(second, first);

    // Idle sessions: a live one is kept, a dead one replaced in the background.
    assert_eq!(bridge.ping_idle_blocking("w", std::time::Duration::ZERO), 0);
    assert_eq!(pid(1), second, "a live session stays");
    kill(second);
    assert!(bridge.ping_idle_blocking("w", std::time::Duration::ZERO) >= 1);
    let third = pid(1);
    assert_ne!(third, second);
    std::env::remove_var("ROWKERY_CONFIG_DIR");
}

/// A TCP proxy to Postgres that holds each new connection (accepted,
/// nothing passed) while `hold` is set, like a laptop whose network is
/// still coming back. Returns its port, the switch, and how many it holds.
fn holding_proxy(
    upstream: String,
) -> (
    u16,
    Arc<std::sync::atomic::AtomicBool>,
    Arc<std::sync::atomic::AtomicUsize>,
) {
    use std::net::{TcpListener, TcpStream};
    use std::sync::atomic::{AtomicBool, AtomicUsize};
    let hold = Arc::new(AtomicBool::new(false));
    let held = Arc::new(AtomicUsize::new(0));
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let port = listener.local_addr().unwrap().port();
    let (switch, count) = (hold.clone(), held.clone());
    thread::spawn(move || {
        for client in listener.incoming().flatten() {
            let (hold, held, upstream) = (switch.clone(), count.clone(), upstream.clone());
            thread::spawn(move || {
                if hold.load(Ordering::SeqCst) {
                    held.fetch_add(1, Ordering::SeqCst);
                    while hold.load(Ordering::SeqCst) {
                        thread::sleep(std::time::Duration::from_millis(10));
                    }
                    held.fetch_sub(1, Ordering::SeqCst);
                }
                let Ok(server) = TcpStream::connect(&upstream) else {
                    return;
                };
                let (mut c, mut s) = (client.try_clone().unwrap(), server.try_clone().unwrap());
                thread::spawn(move || {
                    let _ = std::io::copy(&mut c, &mut s);
                });
                let (mut s, mut c) = (server, client);
                let _ = std::io::copy(&mut s, &mut c);
            });
        }
    });
    (port, hold, held)
}

/// After a sleep, the window's dead sessions are replaced side by side, and
/// a run never waits for its own tab's replacement: it opens its own session
/// (the replacement is dropped), and a tab closed meanwhile keeps none.
#[test]
fn postgres_a_run_never_waits_for_its_sessions_replacement() {
    let Ok(host) = std::env::var("ROWKERY_PG_HOST") else {
        eprintln!(
            "skip postgres_a_run_never_waits_for_its_sessions_replacement (set ROWKERY_PG_HOST)"
        );
        return;
    };
    let pg_port = std::env::var("ROWKERY_PG_PORT").unwrap_or_else(|_| "54329".into());
    let (port, hold, held) = holding_proxy(format!("{host}:{pg_port}"));
    let (_guard, _file, _path) = test_guard();
    let bridge = super::CoreBridge::spawn();
    let id = "postgres-replacing";
    CoreBridge::upsert_connection(
        &bridge,
        ConnectionRecord::Postgres(PostgresConnection {
            allow_mcp: false,
            mcp_hidden_tables: Vec::new(),
            mcp_until: None,
            mcp_samples_off: false,
            mcp_timeout_s: None,
            mcp_access: None,
            masked_columns: Default::default(),
            environment: None,
            safe_mode: Default::default(),
            id: id.into(),
            name: id.into(),
            host: "127.0.0.1".into(),
            port,
            database: std::env::var("ROWKERY_PG_DB").unwrap_or_else(|_| "rowkery".into()),
            username: std::env::var("ROWKERY_PG_USER").unwrap_or_else(|_| "rowkery".into()),
            ssl_mode: PostgresSslMode::Disable,
            ssl_root_cert: None,
            ssh: None,
            cloud_sql: None,
        }),
        ConnectionSecrets {
            db_password: Some(
                std::env::var("ROWKERY_PG_PASSWORD").unwrap_or_else(|_| "rowkery".into()),
            ),
            ..Default::default()
        },
    )
    .expect("save");
    bridge.open_window("w", id, None).expect("open");
    let pid = |tab| match window_query(&bridge, "w", tab, "SELECT pg_backend_pid()").0 {
        Some(Value::Int(p)) => p,
        other => panic!("pid: {other:?}"),
    };
    let pids: Vec<i64> = [1, 2, 3].into_iter().map(pid).collect();
    for victim in &pids {
        let (_, err, ..) = window_query(
            &bridge,
            "w",
            9,
            &format!("SELECT pg_terminate_backend({victim})"),
        );
        assert_eq!(err, None);
    }
    thread::sleep(std::time::Duration::from_millis(300));

    // The network is still coming back: replacements can't open yet.
    hold.store(true, Ordering::SeqCst);
    thread::scope(|scope| {
        let ping = scope.spawn(|| bridge.ping_idle_blocking("w", std::time::Duration::ZERO));
        // Pings of the dead may each take their whole 3 s.
        let deadline = Instant::now() + Duration::from_secs(20);
        while held.load(Ordering::SeqCst) < 3 {
            assert!(Instant::now() < deadline, "three replacements open at once");
            thread::sleep(Duration::from_millis(10));
        }
        // Tab 2 closes while its replacement opens.
        bridge.close_window_tab("w", 2);
        let deadline = Instant::now() + Duration::from_secs(10);
        // Tab 1 runs: it doesn't wait for its replacement but opens its own,
        // which is held too until the network is back.
        let queue = bridge
            .run_window_query("w", 1, "SELECT 1::int8".into(), None, false)
            .expect("run");
        while held.load(Ordering::SeqCst) < 4 {
            assert!(Instant::now() < deadline, "tab 1 opens its own session");
            thread::sleep(Duration::from_millis(10));
        }
        hold.store(false, Ordering::SeqCst);
        let events = loop {
            let events = queue.lock().unwrap().clone();
            if events
                .iter()
                .any(|e| matches!(e, CoreEvent::QueryFinished { .. }))
            {
                break events;
            }
            assert!(Instant::now() < deadline, "tab 1 ran");
            thread::sleep(Duration::from_millis(5));
        };
        assert!(
            !events
                .iter()
                .any(|e| matches!(e, CoreEvent::QueryWaiting { .. })),
            "no wait: {events:?}"
        );
        assert!(events
            .iter()
            .any(|e| matches!(e, CoreEvent::QueryFinished { error: None, .. })));
        // Only tab 3's replacement is kept: tab 1 has its own, tab 2 closed.
        assert_eq!(ping.join().unwrap(), 1);
    });
}

/// A window's sessions share one SSH tunnel: three tabs running at once
/// open one SSH connection, not three; closing the window closes it.
#[test]
fn postgres_window_sessions_share_one_ssh_tunnel() {
    let (Ok(pg_host), Ok(ssh_host)) = (
        std::env::var("ROWKERY_PG_HOST"),
        std::env::var("ROWKERY_SSH_HOST"),
    ) else {
        eprintln!("skip postgres_window_sessions_share_one_ssh_tunnel (set ROWKERY_PG_HOST and ROWKERY_SSH_HOST)");
        return;
    };
    use rowkery_core::connections::{SshAuthMethod, SshConfig};
    use rowkery_core::ssh::OPEN_TUNNELS;
    use std::sync::atomic::Ordering;
    let (_guard, _file, _path) = test_guard();
    let bridge = super::CoreBridge::spawn();
    let id = "postgres-ssh";
    CoreBridge::upsert_connection(
        &bridge,
        ConnectionRecord::Postgres(PostgresConnection {
            allow_mcp: false,
            mcp_hidden_tables: Vec::new(),
            mcp_until: None,
            mcp_samples_off: false,
            mcp_timeout_s: None,
            mcp_access: None,
            masked_columns: Default::default(),
            environment: None,
            safe_mode: Default::default(),
            id: id.into(),
            name: "pg over ssh".into(),
            host: pg_host,
            port: std::env::var("ROWKERY_PG_PORT")
                .ok()
                .and_then(|p| p.parse().ok())
                .unwrap_or(54329),
            database: std::env::var("ROWKERY_PG_DB").unwrap_or_else(|_| "rowkery".into()),
            username: std::env::var("ROWKERY_PG_USER").unwrap_or_else(|_| "rowkery".into()),
            ssl_mode: PostgresSslMode::Disable,
            ssl_root_cert: None,
            ssh: Some(SshConfig {
                host: ssh_host,
                port: std::env::var("ROWKERY_SSH_PORT")
                    .ok()
                    .and_then(|p| p.parse().ok())
                    .unwrap_or(2222),
                username: std::env::var("ROWKERY_SSH_USER").unwrap_or_else(|_| "rowkery".into()),
                auth_method: SshAuthMethod::Password,
                private_key_path: None,
                trust_host: true,
            }),
            cloud_sql: None,
        }),
        ConnectionSecrets {
            db_password: Some(
                std::env::var("ROWKERY_PG_PASSWORD").unwrap_or_else(|_| "rowkery".into()),
            ),
            ssh_password: Some(
                std::env::var("ROWKERY_SSH_PASSWORD").unwrap_or_else(|_| "rowkeryssh".into()),
            ),
            ..Default::default()
        },
    )
    .expect("save");
    let before = OPEN_TUNNELS.load(Ordering::Relaxed);
    bridge.open_window("w", id, None).expect("open over ssh");
    let queues: Vec<_> = (1..=3)
        .map(|tab| {
            bridge
                .run_window_query(
                    "w",
                    tab,
                    "SELECT pg_sleep(0.2), pg_backend_pid()".into(),
                    None,
                    false,
                )
                .expect("run")
        })
        .collect();
    for q in &queues {
        let (rows, err, _) = wait_finished(q);
        assert_eq!((rows, err), (1, None));
    }
    assert_eq!(
        OPEN_TUNNELS.load(Ordering::Relaxed) - before,
        1,
        "three tabs, one SSH tunnel"
    );
    bridge.close_window("w");
    thread::sleep(std::time::Duration::from_millis(300));
    assert_eq!(
        OPEN_TUNNELS.load(Ordering::Relaxed),
        before,
        "closing the window closes it"
    );
    std::env::remove_var("ROWKERY_CONFIG_DIR");
}

/// A window shows its cached catalog at once and the server confirms it;
/// after DDL elsewhere the cached one is replaced; a server that refuses
/// after the cached reply is reported, not cached.
#[test]
fn postgres_catalog_cache_confirms_replaces_and_fails() {
    if std::env::var("ROWKERY_PG_HOST").is_err() {
        eprintln!("skip postgres_catalog_cache_confirms_replaces_and_fails (set ROWKERY_PG_HOST)");
        return;
    }
    let (_guard, _file, _path) = test_guard();
    let bridge = super::CoreBridge::spawn();
    let updates: Arc<Mutex<Vec<CatalogUpdate>>> = Arc::default();
    let seen = updates.clone();
    bridge.on_catalog_update(Arc::new(move |u| seen.lock().unwrap().push(u)));
    let pg = |id: &str, port: u16| {
        ConnectionRecord::Postgres(PostgresConnection {
            allow_mcp: false,
            mcp_hidden_tables: Vec::new(),
            mcp_until: None,
            mcp_samples_off: false,
            mcp_timeout_s: None,
            mcp_access: None,
            masked_columns: Default::default(),
            environment: None,
            safe_mode: Default::default(),
            id: id.into(),
            name: id.into(),
            host: std::env::var("ROWKERY_PG_HOST").unwrap(),
            port,
            database: std::env::var("ROWKERY_PG_DB").unwrap_or_else(|_| "rowkery".into()),
            username: std::env::var("ROWKERY_PG_USER").unwrap_or_else(|_| "rowkery".into()),
            ssl_mode: PostgresSslMode::Disable,
            ssl_root_cert: None,
            ssh: None,
            cloud_sql: None,
        })
    };
    let port = std::env::var("ROWKERY_PG_PORT")
        .ok()
        .and_then(|p| p.parse().ok())
        .unwrap_or(54329);
    let secrets = ConnectionSecrets {
        db_password: Some(
            std::env::var("ROWKERY_PG_PASSWORD").unwrap_or_else(|_| "rowkery".into()),
        ),
        ..Default::default()
    };
    CoreBridge::upsert_connection(&bridge, pg("pg-cache", port), secrets.clone()).expect("save");
    let wait_update = |n: usize| {
        for _ in 0..200 {
            if updates.lock().unwrap().len() >= n {
                return updates.lock().unwrap()[n - 1].clone();
            }
            thread::sleep(std::time::Duration::from_millis(20));
        }
        panic!("no catalog update #{n}");
    };
    let first = bridge.open_window("w1", "pg-cache", None).expect("open");
    assert!(!first.cached, "nothing cached yet");

    let second = bridge.open_window("w2", "pg-cache", None).expect("open");
    assert!(second.cached);
    assert_eq!(second.catalog, first.catalog);
    assert_eq!(
        wait_update(1),
        CatalogUpdate::Confirmed {
            window_id: "w2".into(),
            open_seq: second.open_seq
        }
    );

    // DDL elsewhere: the next cached open is replaced with the live catalog.
    window_query(&bridge, "w1", 1, "DROP TABLE IF EXISTS cache_probe");
    window_query(&bridge, "w1", 1, "CREATE TABLE cache_probe (id int)");
    let third = bridge.open_window("w3", "pg-cache", None).expect("open");
    assert!(third.cached);
    assert!(third
        .catalog
        .find_table("rowkery", "public", "cache_probe")
        .is_none());
    match wait_update(2) {
        CatalogUpdate::Replaced {
            window_id, catalog, ..
        } => {
            assert_eq!(window_id, "w3");
            assert!(catalog
                .find_table("rowkery", "public", "cache_probe")
                .is_some());
        }
        other => panic!("expected Replaced, got {other:?}"),
    }
    window_query(&bridge, "w1", 1, "DROP TABLE cache_probe");

    // A cached open whose server then refuses: Failed, and the cache stays as it was.
    CoreBridge::upsert_connection(&bridge, pg("pg-cache", 1), secrets).expect("save");
    let fourth = bridge
        .open_window("w4", "pg-cache", None)
        .expect("cached reply");
    assert!(fourth.cached);
    assert!(
        matches!(wait_update(3), CatalogUpdate::Failed { ref window_id, .. } if window_id == "w4")
    );

    bridge.remove_connection("pg-cache", false).expect("delete");
    assert_eq!(
        rowkery_core::catalog_cache::load("pg-cache", "rowkery"),
        None,
        "deleted with the connection"
    );
    std::env::remove_var("ROWKERY_CONFIG_DIR");
}

#[test]
fn postgres_tabs_keep_their_session_between_runs() {
    if std::env::var("ROWKERY_PG_HOST").is_err() {
        eprintln!("skip postgres_tabs_keep_their_session_between_runs (set ROWKERY_PG_HOST)");
        return;
    }
    let (_guard, _file, _path) = test_guard();
    let bridge = super::CoreBridge::spawn();
    let id = "postgres-warm";
    CoreBridge::upsert_connection(
        &bridge,
        ConnectionRecord::Postgres(PostgresConnection {
            environment: None,
            safe_mode: Default::default(),
            allow_mcp: false,
            mcp_hidden_tables: Vec::new(),
            mcp_until: None,
            mcp_samples_off: false,
            mcp_timeout_s: None,
            mcp_access: None,
            masked_columns: Default::default(),
            id: id.into(),
            name: "pg warm".into(),
            host: std::env::var("ROWKERY_PG_HOST").unwrap(),
            port: std::env::var("ROWKERY_PG_PORT")
                .ok()
                .and_then(|p| p.parse().ok())
                .unwrap_or(54329),
            database: std::env::var("ROWKERY_PG_DB").unwrap_or_else(|_| "rowkery".into()),
            username: std::env::var("ROWKERY_PG_USER").unwrap_or_else(|_| "rowkery".into()),
            ssl_mode: PostgresSslMode::Disable,
            ssl_root_cert: None,
            ssh: None,
            cloud_sql: None,
        }),
        ConnectionSecrets {
            db_password: Some(
                std::env::var("ROWKERY_PG_PASSWORD").unwrap_or_else(|_| "rowkery".into()),
            ),
            ..Default::default()
        },
    )
    .expect("save");
    bridge.open_window("w", id, None).expect("open");
    let pid = |tab| window_query(&bridge, "w", tab, "SELECT pg_backend_pid()").0;

    // The first run adopts the schema load's session; later runs reuse it.
    let first = pid(1);
    assert!(first.is_some());
    for _ in 0..3 {
        assert_eq!(pid(1), first, "tab 1 should stay on one backend");
    }
    // Session state carries across runs in a tab.
    window_query(&bridge, "w", 1, "SET application_name = 'rowkery-warm'");
    let (name, ..) = window_query(&bridge, "w", 1, "SHOW application_name");
    assert_eq!(
        name,
        Some(rowkery_core::db::Value::Text("rowkery-warm".into()))
    );

    // So does a temp table, and writes report the rows they touched.
    let run = |sql: &str| window_query(&bridge, "w", 1, sql);
    assert_eq!(run("CREATE TEMP TABLE warm (n int)").1, None);
    assert_eq!(
        run("INSERT INTO warm SELECT generate_series(1, 3)").4,
        Some(3)
    );
    assert_eq!(
        run("SELECT count(*) FROM warm").0,
        Some(rowkery_core::db::Value::Int(3))
    );

    // Another tab gets its own backend.
    let second = pid(2);
    assert!(second.is_some() && second != first);
    assert_eq!(pid(2), second);

    // After a cancel the tab keeps its session (and any transaction in it).
    let queue = bridge
        .run_window_query("w", 1, "SELECT pg_sleep(30)".into(), None, false)
        .expect("run");
    thread::sleep(std::time::Duration::from_millis(300));
    bridge.cancel_window_query("w", 1);
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(5);
    let mut cancelled = false;
    while !cancelled && std::time::Instant::now() < deadline {
        for event in std::mem::take(&mut *queue.lock().unwrap()) {
            if let CoreEvent::QueryFinished { cancelled: c, .. } = event {
                assert!(c, "pg_sleep should be cancelled");
                cancelled = true;
            }
        }
        thread::sleep(std::time::Duration::from_millis(10));
    }
    assert!(cancelled);
    assert_eq!(pid(1), first, "a cancel keeps the tab's session");

    // A backend killed while parked is replaced without an error.
    let killed = match first.clone() {
        Some(rowkery_core::db::Value::Int(p)) => p,
        other => panic!("pid {other:?}"),
    };
    let (_, err, ..) = window_query(
        &bridge,
        "w",
        2,
        &format!("SELECT pg_terminate_backend({killed})"),
    );
    assert_eq!(err, None);
    thread::sleep(std::time::Duration::from_millis(200));
    let (cell, err, ..) = window_query(&bridge, "w", 1, "SELECT pg_backend_pid()");
    assert_eq!(err, None, "a dead parked session should be replaced");
    assert!(cell.is_some() && cell != first);

    // Re-pointing the window drops its sessions.
    bridge.open_window("w", id, None).expect("reopen");
    assert_ne!(pid(2), second);

    // Warm runs skip connecting: print cold vs warm for a quick look.
    bridge.close_window_tab("w", 3);
    let cold = window_query(&bridge, "w", 3, "SELECT 1").3;
    let warm: Vec<u64> = (0..5)
        .map(|_| window_query(&bridge, "w", 3, "SELECT 1").3)
        .collect();
    eprintln!("first run {cold} ms, warm runs {warm:?} ms");
    std::env::remove_var("ROWKERY_CONFIG_DIR");
}

#[test]
fn postgres_schema_reload_keeps_tab_sessions() {
    let Ok(host) = std::env::var("ROWKERY_PG_HOST") else {
        eprintln!("skip postgres_schema_reload_keeps_tab_sessions (set ROWKERY_PG_HOST)");
        return;
    };
    let (_guard, _file, _path) = test_guard();
    let bridge = super::CoreBridge::spawn();
    let id = "postgres-reload";
    CoreBridge::upsert_connection(
        &bridge,
        ConnectionRecord::Postgres(PostgresConnection {
            environment: None,
            safe_mode: Default::default(),
            allow_mcp: false,
            mcp_hidden_tables: Vec::new(),
            mcp_until: None,
            mcp_samples_off: false,
            mcp_timeout_s: None,
            mcp_access: None,
            masked_columns: Default::default(),
            id: id.into(),
            name: "pg reload".into(),
            host,
            port: std::env::var("ROWKERY_PG_PORT")
                .ok()
                .and_then(|p| p.parse().ok())
                .unwrap_or(54329),
            database: std::env::var("ROWKERY_PG_DB").unwrap_or_else(|_| "rowkery".into()),
            username: std::env::var("ROWKERY_PG_USER").unwrap_or_else(|_| "rowkery".into()),
            ssl_mode: PostgresSslMode::Disable,
            ssl_root_cert: None,
            ssh: None,
            cloud_sql: None,
        }),
        ConnectionSecrets {
            db_password: Some(
                std::env::var("ROWKERY_PG_PASSWORD").unwrap_or_else(|_| "rowkery".into()),
            ),
            ..Default::default()
        },
    )
    .expect("save");
    bridge.open_window("w", id, None).expect("open");
    let run = |sql: &str| window_query(&bridge, "w", 1, sql);
    let has_probe = |catalog: &SchemaCatalog| {
        catalog
            .databases
            .iter()
            .flat_map(|d| &d.schemas)
            .flat_map(|s| &s.tables)
            .any(|t| t.name == "it_reload_probe")
    };
    assert_eq!(run("DROP TABLE IF EXISTS public.it_reload_probe").1, None);
    let pid = run("SELECT pg_backend_pid()").0;
    assert!(pid.is_some());

    // DDL inside a transaction: the reload can't see it yet, and must not
    // close the tab's session (that would roll the transaction back).
    assert_eq!(run("BEGIN").1, None);
    assert_eq!(
        run("CREATE TABLE public.it_reload_probe (id int PRIMARY KEY)").1,
        None
    );
    let catalog = bridge.reload_window_schema("w").expect("reload");
    assert!(!has_probe(&catalog), "uncommitted table is not visible yet");
    assert_eq!(
        run("SELECT pg_backend_pid()").0,
        pid,
        "tab keeps its backend"
    );
    assert_eq!(run("COMMIT").1, None);
    let catalog = bridge.reload_window_schema("w").expect("reload");
    assert!(has_probe(&catalog), "committed table shows after a reload");

    // Index details load on the window's spare session, not the tab's.
    let loaded = bridge
        .table_indexes("w", "public", vec!["it_reload_probe".into()])
        .expect("indexes");
    assert_eq!(loaded.len(), 1);
    assert!(loaded[0].indexes.iter().any(|ix| ix.primary));
    assert_eq!(run("SELECT pg_backend_pid()").0, pid);

    assert_eq!(run("DROP TABLE public.it_reload_probe").1, None);
    std::env::remove_var("ROWKERY_CONFIG_DIR");
}

fn edit_table(schema: &str, table: &str, columns: &[(&str, &str)], key: &[&str]) -> EditTable {
    EditTable {
        schema: schema.into(),
        table: table.into(),
        columns: columns
            .iter()
            .map(|(name, ty)| rowkery_core::edits::EditColumn {
                name: name.to_string(),
                type_name: ty.to_string(),
            })
            .collect(),
        key: key.iter().map(|k| k.to_string()).collect(),
    }
}

fn cell(column: &str, value: Value) -> rowkery_core::edits::CellValue {
    rowkery_core::edits::CellValue {
        column: column.into(),
        value,
    }
}

fn update(id: i64, column: &str, value: Value) -> Change {
    Change::Update {
        key: vec![cell("id", Value::Int(id))],
        set: vec![cell(column, value)],
    }
}

#[test]
fn sqlite_apply_changes_commits_or_rolls_back_whole() {
    use rowkery_core::safety::HoldAction;
    let (_guard, _file, path) = test_guard();
    Connection::open(&path)
        .expect("open")
        .execute_batch(
            "CREATE TABLE k (id INTEGER PRIMARY KEY, name TEXT);
                 INSERT INTO k VALUES (1, 'a'), (2, 'b'), (3, 'c');
                 CREATE TABLE dup (id INTEGER, name TEXT);
                 INSERT INTO dup VALUES (1, 'x'), (2, 'y'), (2, 'z');",
        )
        .expect("seed");
    let bridge = super::CoreBridge::spawn();
    for (id, safe_mode) in [
        ("off", SafeMode::Off),
        ("confirm", SafeMode::Confirm),
        ("ro", SafeMode::ReadOnly),
    ] {
        CoreBridge::upsert_connection(
            &bridge,
            ConnectionRecord::Sqlite(SqliteConnection {
                allow_mcp: false,
                mcp_hidden_tables: Vec::new(),
                mcp_until: None,
                mcp_samples_off: false,
                mcp_timeout_s: None,
                mcp_access: None,
                masked_columns: Default::default(),
                environment: None,
                safe_mode,
                id: id.into(),
                name: id.into(),
                path: path.clone(),
                sample: false,
            }),
            ConnectionSecrets::default(),
        )
        .expect("save");
        bridge.open_window(id, id, None).expect("open");
    }
    let k = edit_table("main", "k", &[("id", "INTEGER"), ("name", "TEXT")], &["id"]);
    let read = |sql: &str| window_query(&bridge, "off", 1, sql).0;
    let name_of = |id: i64| read(&format!("SELECT name FROM k WHERE id = {id}"));

    // Committed: one of each verb.
    let out = bridge
        .apply_changes(
            "off",
            "off",
            1,
            k.clone(),
            vec![
                Change::Insert {
                    values: vec![cell("name", Value::Text("new".into()))],
                },
                update(1, "name", Value::Text("it's".into())),
                Change::Delete {
                    key: vec![cell("id", Value::Int(3))],
                },
            ],
            None,
            None,
        )
        .expect("apply");
    let ApplyOutcome::Committed { counts, .. } = out else {
        panic!("{out:?}")
    };
    assert_eq!((counts.inserted, counts.updated, counts.deleted), (1, 1, 1));
    assert_eq!(name_of(1), Some(Value::Text("it's".into())));
    assert_eq!(name_of(3), None);

    // A statement that matches no row rolls the whole batch back.
    let out = bridge
        .apply_changes(
            "off",
            "off",
            1,
            k.clone(),
            vec![
                update(2, "name", Value::Text("kept?".into())),
                update(99, "name", Value::Text("nobody".into())),
            ],
            None,
            None,
        )
        .expect("apply");
    let ApplyOutcome::RolledBack { failure, .. } = out else {
        panic!("{out:?}")
    };
    assert_eq!(failure.index, Some(1));
    assert_eq!(failure.rows, Some(0));
    assert_eq!(failure.message, "UPDATE k WHERE id = 99 changed 0 rows");
    assert_eq!(name_of(2), Some(Value::Text("b".into())));

    // A key that matches two rows: rolled back, and the row is named.
    let dup = edit_table(
        "main",
        "dup",
        &[("id", "INTEGER"), ("name", "TEXT")],
        &["id"],
    );
    let out = bridge
        .apply_changes(
            "off",
            "off",
            1,
            dup,
            vec![
                update(1, "name", Value::Text("one".into())),
                update(2, "name", Value::Text("two".into())),
            ],
            None,
            None,
        )
        .expect("apply");
    let ApplyOutcome::RolledBack { failure, .. } = out else {
        panic!("{out:?}")
    };
    assert_eq!(failure.message, "UPDATE dup WHERE id = 2 changed 2 rows");
    assert_eq!(
        read("SELECT name FROM dup WHERE id = 1"),
        Some(Value::Text("x".into()))
    );

    // rowid names a row of a table without a primary key.
    let t = edit_table("main", "t", &[("id", "INTEGER")], &["rowid"]);
    let out = bridge
        .apply_changes(
            "off",
            "off",
            1,
            t,
            vec![Change::Update {
                key: vec![cell("rowid", Value::Int(1))],
                set: vec![cell("id", Value::Int(5))],
            }],
            None,
            None,
        )
        .expect("apply");
    assert!(matches!(out, ApplyOutcome::Committed { .. }), "{out:?}");
    assert_eq!(read("SELECT id FROM t"), Some(Value::Int(5)));

    // Confirm writes: held with the exact text; only that text runs.
    let change = vec![update(2, "name", Value::Text("confirmed".into()))];
    let out = bridge
        .apply_changes(
            "confirm",
            "confirm",
            1,
            k.clone(),
            change.clone(),
            None,
            None,
        )
        .expect("apply");
    let ApplyOutcome::Held { hold, sql } = out else {
        panic!("{out:?}")
    };
    assert_eq!(hold.action, HoldAction::Confirm);
    assert_eq!(
        sql,
        "BEGIN;\nUPDATE k SET name = 'confirmed' WHERE id = 2;\nCOMMIT;"
    );
    assert_eq!(name_of(2), Some(Value::Text("b".into())), "nothing ran");
    assert!(bridge
        .apply_changes(
            "confirm",
            "confirm",
            1,
            k.clone(),
            change.clone(),
            Some("BEGIN;".into()),
            None
        )
        .is_err());
    let out = bridge
        .apply_changes(
            "confirm",
            "confirm",
            1,
            k.clone(),
            change.clone(),
            Some(sql),
            None,
        )
        .expect("apply");
    assert!(matches!(out, ApplyOutcome::Committed { .. }), "{out:?}");
    assert_eq!(name_of(2), Some(Value::Text("confirmed".into())));

    // Read-only: refused, confirmed or not.
    let change = vec![update(2, "name", Value::Text("refused".into()))];
    let sql = review_changes(EngineKind::Sqlite, &k, &change).unwrap().sql;
    let out = bridge
        .apply_changes("ro", "ro", 1, k.clone(), change, Some(sql), None)
        .expect("apply");
    let ApplyOutcome::Held { hold, .. } = out else {
        panic!("{out:?}")
    };
    assert_eq!(hold.action, HoldAction::Refuse);
    assert_eq!(name_of(2), Some(Value::Text("confirmed".into())));

    // Staged on another connection than the window's: refused, nothing runs,
    // even with safe mode off and a table of the same name here.
    let err = bridge
        .apply_changes(
            "off",
            "confirm",
            1,
            k.clone(),
            vec![update(2, "name", Value::Text("elsewhere".into()))],
            None,
            None,
        )
        .expect_err("another connection's edits");
    assert!(err.contains("another connection"), "{err}");
    assert_eq!(name_of(2), Some(Value::Text("confirmed".into())));

    // Nothing to commit, or no key: refused before anything runs.
    assert!(bridge
        .apply_changes("off", "off", 1, k.clone(), vec![], None, None)
        .is_err());
    let keyless = edit_table("main", "k", &[("id", "INTEGER")], &[]);
    assert!(bridge
        .apply_changes(
            "off",
            "off",
            1,
            keyless,
            vec![update(1, "id", Value::Int(1))],
            None,
            None
        )
        .is_err());
    std::env::remove_var("ROWKERY_CONFIG_DIR");
}

#[test]
fn postgres_apply_changes_commits_or_rolls_back_whole() {
    use rowkery_core::safety::HoldAction;
    let Ok(host) = std::env::var("ROWKERY_PG_HOST") else {
        eprintln!("skip postgres_apply_changes_commits_or_rolls_back_whole (set ROWKERY_PG_HOST)");
        return;
    };
    let (_guard, _file, _path) = test_guard();
    let bridge = super::CoreBridge::spawn();
    for (id, safe_mode) in [
        ("off", SafeMode::Off),
        ("confirm", SafeMode::Confirm),
        ("ro", SafeMode::ReadOnly),
    ] {
        CoreBridge::upsert_connection(
            &bridge,
            ConnectionRecord::Postgres(PostgresConnection {
                allow_mcp: false,
                mcp_hidden_tables: Vec::new(),
                mcp_until: None,
                mcp_samples_off: false,
                mcp_timeout_s: None,
                mcp_access: None,
                masked_columns: Default::default(),
                environment: None,
                safe_mode,
                id: id.into(),
                name: id.into(),
                host: host.clone(),
                port: std::env::var("ROWKERY_PG_PORT")
                    .ok()
                    .and_then(|p| p.parse().ok())
                    .unwrap_or(54329),
                database: std::env::var("ROWKERY_PG_DB").unwrap_or_else(|_| "rowkery".into()),
                username: std::env::var("ROWKERY_PG_USER").unwrap_or_else(|_| "rowkery".into()),
                ssl_mode: PostgresSslMode::Disable,
                ssl_root_cert: None,
                ssh: None,
                cloud_sql: None,
            }),
            ConnectionSecrets {
                db_password: Some(
                    std::env::var("ROWKERY_PG_PASSWORD").unwrap_or_else(|_| "rowkery".into()),
                ),
                ..Default::default()
            },
        )
        .expect("save");
        bridge.open_window(id, id, None).expect("open");
    }
    let run = |sql: &str| window_query(&bridge, "off", 1, sql);
    // A unique index stands in for the key; dropping it lets a duplicate in.
    for sql in [
        "DROP TABLE IF EXISTS public.it_edits",
        "CREATE TABLE public.it_edits (id int NOT NULL, name text, price numeric(10,2), \
             meta jsonb, raw bytea, at timestamptz, ok boolean, tags text[], \
             kind text DEFAULT 'plain')",
        "CREATE UNIQUE INDEX it_edits_id ON public.it_edits (id)",
        "INSERT INTO public.it_edits (id, name) VALUES (1, 'one'), (2, 'two'), (3, 'three')",
        "DROP INDEX public.it_edits_id",
        "INSERT INTO public.it_edits (id, name) VALUES (2, 'two again')",
    ] {
        assert_eq!(run(sql).1, None, "{sql}");
    }
    let table = edit_table(
        "public",
        "it_edits",
        &[
            ("id", "integer"),
            ("name", "text"),
            ("price", "numeric(10,2)"),
            ("meta", "jsonb"),
            ("raw", "bytea"),
            ("at", "timestamp with time zone"),
            ("ok", "boolean"),
            ("tags", "text[]"),
            ("kind", "text"),
        ],
        &["id"],
    );
    let text = |s: &str| Value::Text(s.into());
    let check = |sql: &str| run(sql).0;

    // The duplicate: its UPDATE matches 2 rows, so nothing is kept.
    let out = bridge
        .apply_changes(
            "off",
            "off",
            1,
            table.clone(),
            vec![
                update(1, "name", text("changed")),
                update(2, "name", text("both?")),
            ],
            None,
            None,
        )
        .expect("apply");
    let ApplyOutcome::RolledBack { failure, .. } = out else {
        panic!("{out:?}")
    };
    assert_eq!(failure.index, Some(1));
    assert_eq!(failure.rows, Some(2));
    assert_eq!(
        failure.message,
        "UPDATE public.it_edits WHERE id = 2 changed 2 rows"
    );
    assert_eq!(
        check("SELECT name FROM public.it_edits WHERE id = 1"),
        Some(text("one")),
        "the first statement was rolled back"
    );

    // Every literal kind round-trips through a committed batch.
    let out = bridge
        .apply_changes(
            "off",
            "off",
            1,
            table.clone(),
            vec![
                Change::Insert {
                    values: vec![cell("id", Value::Int(10)), cell("name", text("ten"))],
                },
                Change::Update {
                    key: vec![cell("id", Value::Int(1))],
                    set: vec![
                        cell("name", text(r"it's a \ backslash")),
                        cell("price", text("12.50")),
                        cell("meta", text(r#"{"a": "it's", "b": [1, 2]}"#)),
                        cell("raw", Value::Bytes(vec![0x00, 0xff, 0x27, 0x5c])),
                        cell("at", text("2026-10-05 09:30:00+00")),
                        cell("ok", Value::Bool(true)),
                        cell("tags", text(r#"{a,"b c"}"#)),
                    ],
                },
                Change::Delete {
                    key: vec![cell("id", Value::Int(3))],
                },
            ],
            None,
            None,
        )
        .expect("apply");
    let ApplyOutcome::Committed { counts, .. } = out else {
        panic!("{out:?}")
    };
    assert_eq!((counts.inserted, counts.updated, counts.deleted), (1, 1, 1));
    assert_eq!(
        check(
            r#"SELECT name = 'it''s a \ backslash' AND price = 12.50
                   AND meta = '{"a": "it''s", "b": [1, 2]}'::jsonb
                   AND raw = '\x00ff275c'::bytea
                   AND at = '2026-10-05 09:30:00+00'::timestamptz
                   AND ok AND tags = ARRAY['a', 'b c']
                   FROM public.it_edits WHERE id = 1"#
        ),
        Some(Value::Bool(true))
    );
    // Columns an insert leaves out get their default.
    assert_eq!(
        check("SELECT kind FROM public.it_edits WHERE id = 10"),
        Some(text("plain"))
    );
    assert_eq!(
        check("SELECT count(*) FROM public.it_edits WHERE id = 3"),
        Some(Value::Int(0))
    );

    // NULL is written bare.
    let out = bridge
        .apply_changes(
            "off",
            "off",
            1,
            table.clone(),
            vec![update(1, "meta", Value::Null)],
            None,
            None,
        )
        .expect("apply");
    assert!(matches!(out, ApplyOutcome::Committed { .. }), "{out:?}");
    assert_eq!(
        check("SELECT meta IS NULL FROM public.it_edits WHERE id = 1"),
        Some(Value::Bool(true))
    );

    // A server error names the statement and keeps nothing.
    let out = bridge
        .apply_changes(
            "off",
            "off",
            1,
            table.clone(),
            vec![
                update(10, "name", text("ten?")),
                Change::Insert {
                    values: vec![cell("name", text("no id"))],
                },
            ],
            None,
            None,
        )
        .expect("apply");
    let ApplyOutcome::RolledBack { failure, .. } = out else {
        panic!("{out:?}")
    };
    assert_eq!(failure.index, Some(1));
    assert!(
        failure.message.starts_with("INSERT INTO public.it_edits: "),
        "{}",
        failure.message
    );
    assert_eq!(
        check("SELECT name FROM public.it_edits WHERE id = 10"),
        Some(text("ten"))
    );

    // Never inside the user's own transaction on the tab.
    assert_eq!(window_query(&bridge, "off", 7, "BEGIN").1, None);
    let out = bridge
        .apply_changes(
            "off",
            "off",
            7,
            table.clone(),
            vec![update(10, "name", text("x"))],
            None,
            None,
        )
        .expect("apply");
    let ApplyOutcome::RolledBack { failure, .. } = out else {
        panic!("{out:?}")
    };
    assert!(failure.message.contains("transaction open"), "{failure:?}");
    assert_eq!(window_query(&bridge, "off", 7, "ROLLBACK").1, None);
    let out = bridge
        .apply_changes(
            "off",
            "off",
            7,
            table.clone(),
            vec![update(10, "name", text("x"))],
            None,
            None,
        )
        .expect("apply");
    assert!(matches!(out, ApplyOutcome::Committed { .. }), "{out:?}");

    // Confirm writes: held with the statements, then exactly those run.
    let change = vec![update(10, "name", text("confirmed"))];
    let out = bridge
        .apply_changes(
            "confirm",
            "confirm",
            1,
            table.clone(),
            change.clone(),
            None,
            None,
        )
        .expect("apply");
    let ApplyOutcome::Held { hold, sql } = out else {
        panic!("{out:?}")
    };
    assert_eq!(hold.action, HoldAction::Confirm);
    assert_eq!(hold.statements[0].verb, "UPDATE");
    assert!(sql.contains("UPDATE public.it_edits SET name = 'confirmed' WHERE id = 10;"));
    assert_eq!(
        check("SELECT name FROM public.it_edits WHERE id = 10"),
        Some(text("x"))
    );
    let out = bridge
        .apply_changes(
            "confirm",
            "confirm",
            1,
            table.clone(),
            change,
            Some(sql),
            None,
        )
        .expect("apply");
    assert!(matches!(out, ApplyOutcome::Committed { .. }), "{out:?}");
    assert_eq!(
        check("SELECT name FROM public.it_edits WHERE id = 10"),
        Some(text("confirmed"))
    );

    // Read-only: refused, even confirmed.
    let change = vec![update(10, "name", text("refused"))];
    let sql = review_changes(EngineKind::Postgres, &table, &change)
        .unwrap()
        .sql;
    let out = bridge
        .apply_changes("ro", "ro", 1, table.clone(), change, Some(sql), None)
        .expect("apply");
    let ApplyOutcome::Held { hold, .. } = out else {
        panic!("{out:?}")
    };
    assert_eq!(hold.action, HoldAction::Refuse);
    assert_eq!(
        check("SELECT name FROM public.it_edits WHERE id = 10"),
        Some(text("confirmed"))
    );

    assert_eq!(run("DROP TABLE public.it_edits").1, None);
    std::env::remove_var("ROWKERY_CONFIG_DIR");
}

// ---- Review fixes: prefetch, Quick Look, counts, edits, transactions ----

/// Saves the test Postgres (through `port` when given, e.g. a
/// `freezing_proxy`) as connection `id` in `safe_mode`.
fn save_pg_at(
    bridge: &super::CoreBridge,
    id: &str,
    port: Option<u16>,
    safe_mode: SafeMode,
) -> Option<()> {
    let host = std::env::var("ROWKERY_PG_HOST").ok()?;
    let pg_port = std::env::var("ROWKERY_PG_PORT")
        .ok()
        .and_then(|p| p.parse().ok())
        .unwrap_or(54329);
    CoreBridge::upsert_connection(
        bridge,
        ConnectionRecord::Postgres(PostgresConnection {
            allow_mcp: false,
            mcp_hidden_tables: Vec::new(),
            mcp_until: None,
            mcp_samples_off: false,
            mcp_timeout_s: None,
            mcp_access: None,
            masked_columns: Default::default(),
            environment: None,
            safe_mode,
            id: id.into(),
            name: id.into(),
            host: if port.is_some() {
                "127.0.0.1".into()
            } else {
                host
            },
            port: port.unwrap_or(pg_port),
            database: std::env::var("ROWKERY_PG_DB").unwrap_or_else(|_| "rowkery".into()),
            username: std::env::var("ROWKERY_PG_USER").unwrap_or_else(|_| "rowkery".into()),
            ssl_mode: PostgresSslMode::Disable,
            ssl_root_cert: None,
            ssh: None,
            cloud_sql: None,
        }),
        ConnectionSecrets {
            db_password: Some(
                std::env::var("ROWKERY_PG_PASSWORD").unwrap_or_else(|_| "rowkery".into()),
            ),
            ..Default::default()
        },
    )
    .expect("save");
    Some(())
}

fn pg_upstream() -> Option<String> {
    let host = std::env::var("ROWKERY_PG_HOST").ok()?;
    let port = std::env::var("ROWKERY_PG_PORT").unwrap_or_else(|_| "54329".into());
    Some(format!("{host}:{port}"))
}

fn int_of(v: Option<Value>) -> i64 {
    match v {
        Some(Value::Int(n)) => n,
        other => panic!("int: {other:?}"),
    }
}

/// A click served from the prefetch cache whose socket died: Cancel
/// force-stops it within FORCE_STOP_AFTER (Stop all at once), the
/// prefetch session goes with it, and the next prefetch isn't wedged.
#[test]
fn postgres_a_cached_click_on_a_dead_link_stops_and_frees_the_prefetcher() {
    let Some(upstream) = pg_upstream() else {
        eprintln!("skip postgres_a_cached_click_on_a_dead_link_stops (set ROWKERY_PG_HOST)");
        return;
    };
    let (_guard, _file, _path) = test_guard();
    let (port, frozen) = freezing_proxy(upstream);
    let bridge = super::CoreBridge::spawn();
    save_pg_at(&bridge, "fixb-pf-dead", Some(port), SafeMode::Off).unwrap();
    bridge.open_window("w", "fixb-pf-dead", None).expect("open");
    window_query(&bridge, "w", 1, "DROP TABLE IF EXISTS fixb_pf_dead");
    window_query(
        &bridge,
        "w",
        1,
        "CREATE TABLE fixb_pf_dead AS SELECT i AS id FROM generate_series(1, 1000) i",
    );
    let sql = "SELECT * FROM public.fixb_pf_dead ORDER BY id";

    // Cancel: the server never hears it; stopped FORCE_STOP_AFTER later.
    assert_eq!(bridge.prefetch_table("w", sql.into()), Ok(true));
    frozen.store(true, Ordering::SeqCst);
    let queue = bridge
        .run_window_query("w", 2, sql.into(), None, false)
        .expect("run");
    thread::sleep(std::time::Duration::from_millis(300));
    bridge.cancel_window_query("w", 2);
    let (cancelled, _, waited) = wait_stopped(
        &queue,
        super::FORCE_STOP_AFTER + std::time::Duration::from_secs(2),
    )
    .expect("a cancelled cached click ends");
    assert!(cancelled);
    assert!(waited < super::FORCE_STOP_AFTER + std::time::Duration::from_millis(1500));

    // The link is back: the prefetcher isn't wedged, and Stop all ends
    // the next stuck click at once.
    frozen.store(false, Ordering::SeqCst);
    assert!(!bridge.prefetched("w", sql), "its pages went with it");
    let started = std::time::Instant::now();
    assert_eq!(bridge.prefetch_table("w", sql.into()), Ok(true));
    assert!(started.elapsed() < std::time::Duration::from_secs(5));
    frozen.store(true, Ordering::SeqCst);
    let queue = bridge
        .run_window_query("w", 2, sql.into(), None, false)
        .expect("run");
    thread::sleep(std::time::Duration::from_millis(300));
    bridge.stop_all_queries();
    let (cancelled, _, waited) =
        wait_stopped(&queue, std::time::Duration::from_secs(2)).expect("stopped");
    assert!(cancelled && waited < std::time::Duration::from_secs(1));

    frozen.store(false, Ordering::SeqCst);
    let (rows, error) = window_rows(&bridge, "w", 2, sql);
    assert_eq!((rows.len(), error), (1000, None));
    assert_eq!(bridge.prefetch_table("w", sql.into()), Ok(true));
    // The proxy lost bytes (TCP wouldn't): the backends it stranded idle
    // in their transactions until idle_in_transaction_session_timeout.
    window_query(
            &bridge,
            "w",
            1,
            "SELECT pg_terminate_backend(pid) FROM pg_locks WHERE pid <> pg_backend_pid() AND relation = 'public.fixb_pf_dead'::regclass",
        );
    window_query(&bridge, "w", 1, "DROP TABLE fixb_pf_dead");
    bridge.close_window("w");
    std::env::remove_var("ROWKERY_CONFIG_DIR");
}

/// A page prefetched while a write in the window was still running read
/// the rows from before it: once the write ends it is dropped, and the
/// browse sees the new value.
#[test]
fn postgres_a_prefetch_during_a_write_is_not_served_after_it() {
    let (_guard, _file, _path) = test_guard();
    let bridge = super::CoreBridge::spawn();
    if save_pg_at(&bridge, "fixb-pf-write", None, SafeMode::Off).is_none() {
        eprintln!("skip postgres_a_prefetch_during_a_write (set ROWKERY_PG_HOST)");
        return;
    }
    bridge
        .open_window("w", "fixb-pf-write", None)
        .expect("open");
    window_query(&bridge, "w", 1, "DROP TABLE IF EXISTS fixb_pf_write");
    window_query(
        &bridge,
        "w",
        1,
        "CREATE TABLE fixb_pf_write AS SELECT i AS id, 'old' AS n FROM generate_series(1, 10) i",
    );
    let sql = "SELECT * FROM public.fixb_pf_write ORDER BY id";
    // A slow write: committed only when the whole batch ends.
    let write = bridge
            .run_window_query(
                "w",
                1,
                "WITH s AS (SELECT pg_sleep(1.5)) UPDATE fixb_pf_write SET n = 'new' FROM s WHERE id = 1"
                    .into(),
                None,
                false,
            )
            .expect("run");
    thread::sleep(std::time::Duration::from_millis(300));
    assert_eq!(bridge.prefetch_table("w", sql.into()), Ok(true));
    assert!(bridge.prefetched("w", sql), "cached while the write runs");
    let (_, error, _) = wait_stopped(&write, std::time::Duration::from_secs(10)).unwrap();
    let error = error.filter(|e| !e.is_empty());
    assert_eq!(error, None);
    assert!(!bridge.prefetched("w", sql), "dropped when the write ended");
    let (rows, _) = window_rows(&bridge, "w", 2, sql);
    assert_eq!(rows[0][1], Value::Text("new".into()));
    window_query(&bridge, "w", 1, "DROP TABLE fixb_pf_write");
    std::env::remove_var("ROWKERY_CONFIG_DIR");
}

/// Locks other backends hold on `table`.
fn locks_on(bridge: &super::CoreBridge, window_id: &str, table: &str) -> i64 {
    int_of(
            window_query(
                bridge,
                window_id,
                98,
                &format!(
                    "SELECT count(*)::int FROM pg_locks WHERE pid <> pg_backend_pid() AND relation = 'public.{table}'::regclass"
                ),
            )
            .0,
        )
}

/// The prefetch transaction ends as soon as no cursor is left open (a
/// small table's page comes back whole), and at the latest MAX_TXN_AGE
/// after it began; closing the window ends it at once. Its locks never
/// hold up DDL from elsewhere.
#[test]
fn postgres_the_prefetch_transaction_never_outlives_its_cursors() {
    let (_guard, _file, _path) = test_guard();
    let bridge = super::CoreBridge::spawn();
    if save_pg_at(&bridge, "fixb-pf-locks", None, SafeMode::Off).is_none() {
        eprintln!("skip postgres_the_prefetch_transaction_never_outlives (set ROWKERY_PG_HOST)");
        return;
    }
    bridge
        .open_window("w", "fixb-pf-locks", None)
        .expect("open");
    bridge
        .open_window("other", "fixb-pf-locks", None)
        .expect("open");
    for sql in [
        "DROP TABLE IF EXISTS fixb_pf_small",
        "DROP TABLE IF EXISTS fixb_pf_big",
        "CREATE TABLE fixb_pf_small AS SELECT i AS id FROM generate_series(1, 10) i",
        "CREATE TABLE fixb_pf_big AS SELECT i AS id FROM generate_series(1, 1000) i",
    ] {
        assert_eq!(window_query(&bridge, "other", 1, sql).1, None, "{sql}");
    }

    // A small table: the page is whole, the transaction already over.
    let small = "SELECT * FROM public.fixb_pf_small ORDER BY id";
    assert_eq!(bridge.prefetch_table("w", small.into()), Ok(true));
    assert_eq!(locks_on(&bridge, "other", "fixb_pf_small"), 0);
    window_query(&bridge, "other", 1, "SET lock_timeout = '2s'");
    let (_, error, ..) = window_query(&bridge, "other", 1, "DROP TABLE fixb_pf_small");
    assert_eq!(error, None, "the DROP isn't blocked");
    assert!(
        bridge.prefetched("w", small),
        "a whole page needs no session"
    );

    // A big one keeps its cursor (and lock) open, but not past the age cap.
    let big = "SELECT * FROM public.fixb_pf_big ORDER BY id";
    assert_eq!(bridge.prefetch_table("w", big.into()), Ok(true));
    assert_eq!(locks_on(&bridge, "other", "fixb_pf_big"), 1);
    thread::sleep(super::prefetch::MAX_TXN_AGE + std::time::Duration::from_millis(1500));
    assert_eq!(locks_on(&bridge, "other", "fixb_pf_big"), 0, "ended by age");
    assert!(
        !bridge.prefetched("w", big),
        "its page went with its cursor"
    );

    // Closing the window ends it at once.
    assert_eq!(bridge.prefetch_table("w", big.into()), Ok(true));
    assert_eq!(locks_on(&bridge, "other", "fixb_pf_big"), 1);
    bridge.close_window("w");
    thread::sleep(std::time::Duration::from_millis(300));
    assert_eq!(
        locks_on(&bridge, "other", "fixb_pf_big"),
        0,
        "gone with the window"
    );
    window_query(&bridge, "other", 1, "SET lock_timeout = '2s'");
    let (_, error, ..) = window_query(&bridge, "other", 1, "DROP TABLE fixb_pf_big");
    assert_eq!(error, None);
    std::env::remove_var("ROWKERY_CONFIG_DIR");
}

/// Incoming counts are bounded on the server (a timeout reads as
/// unknown), and a burst of them never runs on more than one backend:
/// each new batch cancels the one before.
#[test]
fn postgres_incoming_counts_are_bounded_and_one_at_a_time() {
    let (_guard, _file, _path) = test_guard();
    let bridge = Arc::new(super::CoreBridge::spawn());
    if save_pg_at(&bridge, "fixb-incoming", None, SafeMode::Off).is_none() {
        eprintln!("skip postgres_incoming_counts_are_bounded (set ROWKERY_PG_HOST)");
        return;
    }
    bridge
        .open_window("w", "fixb-incoming", None)
        .expect("open");
    for sql in [
        "DROP VIEW IF EXISTS fixb_slow_ref",
        "DROP TABLE IF EXISTS fixb_fast_ref",
        "CREATE VIEW fixb_slow_ref AS SELECT 1 AS ref FROM pg_sleep(4)",
        "CREATE TABLE fixb_fast_ref AS SELECT 1 AS ref FROM generate_series(1, 3)",
    ] {
        assert_eq!(window_query(&bridge, "w", 1, sql).1, None, "{sql}");
    }
    let look = |table: &str| FollowLookup {
        schema: "public".into(),
        table: table.into(),
        column: "ref".into(),
        value: Value::Int(1),
    };
    let started = std::time::Instant::now();
    assert_eq!(
        bridge.count_incoming("w", vec![look("fixb_slow_ref")]),
        Ok(vec![None])
    );
    assert!(
        started.elapsed() < std::time::Duration::from_millis(3500),
        "bounded, took {:?}",
        started.elapsed()
    );

    // Six at once (↑↓ through rows): one backend at a time.
    let started = std::time::Instant::now();
    let calls: Vec<_> = (0..6)
        .map(|i| {
            let bridge = bridge.clone();
            let lookups = vec![look("fixb_slow_ref"), look("fixb_slow_ref")];
            thread::sleep(std::time::Duration::from_millis(20 * i));
            thread::spawn(move || bridge.count_incoming("w", lookups))
        })
        .collect();
    let mut most = 0;
    while calls.iter().any(|c| !c.is_finished()) {
        let n = int_of(
                window_query(
                    &bridge,
                    "w",
                    9,
                    "SELECT count(*)::int FROM pg_stat_activity WHERE state = 'active' AND query LIKE '%fixb_slow_ref%' AND pid <> pg_backend_pid()",
                )
                .0,
            );
        most = most.max(n);
        assert!(started.elapsed() < std::time::Duration::from_secs(15));
        thread::sleep(std::time::Duration::from_millis(50));
    }
    for c in calls {
        assert_eq!(c.join().unwrap(), Ok(vec![None, None]));
    }
    assert!(most <= 1, "{most} backends counted at once");
    assert!(started.elapsed() < std::time::Duration::from_secs(8));

    // And Quick Look still counts what it can.
    assert_eq!(
        bridge.count_incoming("w", vec![look("fixb_fast_ref")]),
        Ok(vec![Some(3)])
    );
    window_query(&bridge, "w", 1, "DROP VIEW fixb_slow_ref");
    window_query(&bridge, "w", 1, "DROP TABLE fixb_fast_ref");
    std::env::remove_var("ROWKERY_CONFIG_DIR");
}

/// `count_window_rows` with a timeout, so a hang fails the test.
fn count_within(
    bridge: &Arc<super::CoreBridge>,
    window_id: &str,
    sql: &str,
) -> Result<Option<i64>, String> {
    let (tx, rx) = mpsc::channel();
    let (bridge, window_id, sql) = (bridge.clone(), window_id.to_string(), sql.to_string());
    thread::spawn(move || {
        let _ = tx.send(bridge.count_window_rows(&window_id, sql));
    });
    rx.recv_timeout(std::time::Duration::from_secs(10))
        .expect("the count hung")
}

/// On a Read-only connection the count runs (a read), and anything that
/// isn't a single read is refused at once instead of waiting forever.
#[test]
fn count_window_rows_on_read_only_never_hangs() {
    let (_guard, _file, path) = test_guard();
    let bridge = Arc::new(super::CoreBridge::spawn());
    CoreBridge::upsert_connection(
        &bridge,
        ConnectionRecord::Sqlite(SqliteConnection {
            allow_mcp: false,
            mcp_hidden_tables: Vec::new(),
            mcp_until: None,
            mcp_samples_off: false,
            mcp_timeout_s: None,
            mcp_access: None,
            masked_columns: Default::default(),
            environment: None,
            safe_mode: SafeMode::ReadOnly,
            id: "fixb-count-ro".into(),
            name: "ro".into(),
            path,
            sample: false,
        }),
        ConnectionSecrets::default(),
    )
    .expect("save");
    bridge
        .open_window("s", "fixb-count-ro", None)
        .expect("open");
    let mut windows = vec!["s"];
    if save_pg_at(&bridge, "fixb-count-ro-pg", None, SafeMode::ReadOnly).is_some() {
        bridge
            .open_window("p", "fixb-count-ro-pg", None)
            .expect("open");
        windows.push("p");
    }
    for w in windows {
        let table = if w == "s" { "t" } else { "pg_class" };
        assert!(
            matches!(count_within(&bridge, w, &format!("SELECT count(*) FROM {table}")), Ok(Some(n)) if n > 0),
            "{w}"
        );
        assert!(count_within(&bridge, w, "DELETE FROM t").is_err(), "{w}");
        assert!(
            count_within(&bridge, w, "SELECT count(*) FROM t; DELETE FROM t").is_err(),
            "{w}"
        );
    }
    std::env::remove_var("ROWKERY_CONFIG_DIR");
}

/// Saving edits waits a bounded time for a row lock (or a dead link):
/// it stops before COMMIT, rolls back, says so, and the tab still saves
/// once the lock is gone.
#[test]
fn postgres_apply_changes_times_out_before_commit() {
    let (_guard, _file, _path) = test_guard();
    let bridge = super::CoreBridge::spawn();
    if save_pg_at(&bridge, "fixb-apply-timeout", None, SafeMode::Off).is_none() {
        eprintln!("skip postgres_apply_changes_times_out_before_commit (set ROWKERY_PG_HOST)");
        return;
    }
    bridge
        .open_window("w", "fixb-apply-timeout", None)
        .expect("open");
    for sql in [
        "DROP TABLE IF EXISTS fixb_apply",
        "CREATE TABLE fixb_apply (id int PRIMARY KEY, name text)",
        "INSERT INTO fixb_apply VALUES (1, 'before')",
        // Tab 5 holds the row's lock in an open transaction.
        "BEGIN",
    ] {
        assert_eq!(window_query(&bridge, "w", 5, sql).1, None, "{sql}");
    }
    assert_eq!(
        window_query(
            &bridge,
            "w",
            5,
            "UPDATE fixb_apply SET name = 'held' WHERE id = 1"
        )
        .1,
        None
    );
    let table = edit_table(
        "public",
        "fixb_apply",
        &[("id", "int4"), ("name", "text")],
        &["id"],
    );
    let started = std::time::Instant::now();
    let out = bridge
        .apply_changes(
            "w",
            "fixb-apply-timeout",
            1,
            table.clone(),
            vec![update(1, "name", Value::Text("edited".into()))],
            None,
            None,
        )
        .expect("apply");
    let ApplyOutcome::RolledBack { failure, .. } = out else {
        panic!("{out:?}")
    };
    assert!(
        failure.message.contains("didn't answer"),
        "{}",
        failure.message
    );
    assert!(started.elapsed() < std::time::Duration::from_secs(8));
    assert_eq!(window_query(&bridge, "w", 5, "ROLLBACK").1, None);
    assert_eq!(
        window_query(&bridge, "w", 5, "SELECT name FROM fixb_apply WHERE id = 1").0,
        Some(Value::Text("before".into()))
    );
    let out = bridge
        .apply_changes(
            "w",
            "fixb-apply-timeout",
            1,
            table,
            vec![update(1, "name", Value::Text("edited".into()))],
            None,
            None,
        )
        .expect("apply");
    assert!(matches!(out, ApplyOutcome::Committed { .. }), "{out:?}");
    window_query(&bridge, "w", 5, "DROP TABLE fixb_apply");
    std::env::remove_var("ROWKERY_CONFIG_DIR");
}

/// A tab's open transaction survives the idle ping, and if its session
/// dies anyway, the next statement says the transaction was lost instead
/// of running (a COMMIT "succeeding") on a fresh session.
#[test]
fn postgres_a_lost_transaction_is_reported_not_papered_over() {
    let (_guard, _file, _path) = test_guard();
    let bridge = super::CoreBridge::spawn();
    if save_pg_at(&bridge, "fixb-txn", None, SafeMode::Off).is_none() {
        eprintln!("skip postgres_a_lost_transaction_is_reported (set ROWKERY_PG_HOST)");
        return;
    }
    bridge.open_window("w", "fixb-txn", None).expect("open");
    for sql in [
        "DROP TABLE IF EXISTS fixb_txn",
        "CREATE TABLE fixb_txn (id int)",
    ] {
        assert_eq!(window_query(&bridge, "w", 9, sql).1, None, "{sql}");
    }
    let run = |tab, sql: &str| window_query(&bridge, "w", tab, sql);
    let rows = |bridge: &super::CoreBridge| {
        int_of(window_query(bridge, "w", 9, "SELECT count(*)::int FROM fixb_txn").0)
    };

    // Pinged while idle in a transaction: left alone, it commits.
    assert_eq!(run(1, "BEGIN").1, None);
    assert_eq!(run(1, "INSERT INTO fixb_txn VALUES (1)").1, None);
    bridge.ping_idle_blocking("w", std::time::Duration::ZERO);
    assert_eq!(run(1, "COMMIT").1, None);
    assert_eq!(rows(&bridge), 1);

    // Its backend dies: the COMMIT that follows is refused, clearly.
    assert_eq!(run(1, "BEGIN").1, None);
    assert_eq!(run(1, "INSERT INTO fixb_txn VALUES (2)").1, None);
    let pid = int_of(run(1, "SELECT pg_backend_pid()").0);
    assert_eq!(
        run(9, &format!("SELECT pg_terminate_backend({pid})")).1,
        None
    );
    thread::sleep(std::time::Duration::from_millis(300));
    let (_, error, ..) = run(1, "COMMIT");
    let error = error.expect("the COMMIT is refused");
    assert!(error.contains("transaction"), "{error}");
    assert_eq!(rows(&bridge), 1, "the insert went with its transaction");
    // Said once; the tab works again.
    assert_eq!(int_of(run(1, "SELECT 7").0), 7);
    assert_eq!(run(9, "DROP TABLE fixb_txn").1, None);
    std::env::remove_var("ROWKERY_CONFIG_DIR");
}

/// Ten tabs hold the user's open transactions: the connection's cap is
/// full and none of them may be closed, so an eleventh tab's run says it
/// is waiting for a free connection, and Cancel ends that wait at once.
/// Once a tab commits, its idle session is closed for the next run (it
/// reconnects on its own next run), and the other transactions are
/// still open.
#[test]
fn postgres_an_eleventh_tab_waits_for_a_free_connection() {
    let (_guard, _file, _path) = test_guard();
    let bridge = super::CoreBridge::spawn();
    let id = "postgres-cap";
    if save_test_pg(&bridge, id).is_none() {
        eprintln!(
            "skip postgres_an_eleventh_tab_waits_for_a_free_connection (set ROWKERY_PG_HOST)"
        );
        return;
    }
    bridge.open_window("w", id, None).expect("open");
    for tab in 1..=pool::MAX_SESSIONS as u64 {
        assert_eq!(window_query(&bridge, "w", tab, "BEGIN").1, None);
    }
    let started = |tab: u64| {
        assert_eq!(
            window_query(&bridge, "w", tab, "SELECT now() = statement_timestamp()").0,
            Some(Value::Bool(false)),
            "tab {tab}'s transaction is still open"
        );
    };
    started(2);

    let queue = bridge
        .run_window_query("w", 11, "SELECT 11".into(), None, false)
        .expect("run");
    let deadline = Instant::now() + Duration::from_secs(5);
    let waiting = loop {
        let events = queue.lock().unwrap().clone();
        if events.iter().any(|e| {
            matches!(
                e,
                CoreEvent::QueryWaiting {
                    waiting: true,
                    tab: false,
                    tab_id: 11,
                    ..
                }
            )
        }) {
            break true;
        }
        if Instant::now() > deadline
            || events
                .iter()
                .any(|e| matches!(e, CoreEvent::QueryFinished { .. }))
        {
            break false;
        }
        thread::sleep(Duration::from_millis(5));
    };
    assert!(waiting, "says it waits for a free connection");
    let asked = Instant::now();
    bridge.cancel_window_query("w", 11);
    let cancelled = loop {
        let finished = queue.lock().unwrap().iter().find_map(|e| match e {
            CoreEvent::QueryFinished { cancelled, .. } => Some(*cancelled),
            _ => None,
        });
        if let Some(c) = finished {
            break c;
        }
        assert!(asked.elapsed() < Duration::from_secs(5), "the wait ends");
        thread::sleep(Duration::from_millis(5));
    };
    assert!(cancelled);
    assert!(
        asked.elapsed() < Duration::from_secs(1),
        "at once, not after the force-stop delay: {:?}",
        asked.elapsed()
    );

    // Tab 1 commits: its idle session makes room for tab 11, which
    // doesn't wait.
    assert_eq!(window_query(&bridge, "w", 1, "COMMIT").1, None);
    let queue = bridge
        .run_window_query("w", 11, "SELECT 11::int8".into(), None, false)
        .expect("run");
    let deadline = Instant::now() + Duration::from_secs(10);
    let (cell, error) = loop {
        let events = queue.lock().unwrap().clone();
        let batch = events.iter().find_map(|e| match e {
            CoreEvent::QueryBatch { batch, .. } => batch.rows.first()?.first().cloned(),
            _ => None,
        });
        if let Some(error) = events.iter().find_map(|e| match e {
            CoreEvent::QueryFinished { error, .. } => Some(error.clone()),
            _ => None,
        }) {
            assert!(
                !events
                    .iter()
                    .any(|e| matches!(e, CoreEvent::QueryWaiting { .. })),
                "no wait"
            );
            break (batch, error);
        }
        assert!(Instant::now() < deadline, "tab 11 ran");
        thread::sleep(Duration::from_millis(5));
    };
    assert_eq!((cell, error), (Some(Value::Int(11)), None));
    // Tab 1 reconnects on its next run (taking tab 11's idle session's
    // place); the open transactions were never touched.
    assert_eq!(window_query(&bridge, "w", 1, "SELECT 1").1, None);
    for tab in 2..=pool::MAX_SESSIONS as u64 {
        started(tab);
        assert_eq!(window_query(&bridge, "w", tab, "ROLLBACK").1, None);
    }
    std::env::remove_var("ROWKERY_CONFIG_DIR");
}

fn import_spec(path: &str, schema: &str, columns: &[(usize, &str)]) -> ImportSpec {
    ImportSpec {
        path: path.into(),
        schema: schema.into(),
        table: "it_import".into(),
        delimiter: ",".into(),
        header: true,
        columns: columns
            .iter()
            .map(|(field, column)| rowkery_core::import::ImportColumn {
                field: *field,
                column: column.to_string(),
            })
            .collect(),
        on_conflict: rowkery_core::import::OnConflict::Stop,
        empty: rowkery_core::import::EmptyCells::Null,
    }
}

fn quiet() -> ImportProgress {
    ImportProgress(Arc::new(|_| {}))
}

#[test]
fn sqlite_import_csv_writes_once_and_read_only_refuses() {
    let (_guard, _file, path) = test_guard();
    Connection::open(&path)
        .expect("open")
        .execute_batch("CREATE TABLE it_import (id INTEGER PRIMARY KEY, name TEXT NOT NULL);")
        .expect("seed");
    let csv = std::env::temp_dir().join(format!("it-import-{}.csv", std::process::id()));
    fs::write(&csv, "id,name\n1,one\n2,two\n").expect("csv");
    let bridge = super::CoreBridge::spawn();
    for (id, safe_mode) in [("confirm", SafeMode::Confirm), ("ro", SafeMode::ReadOnly)] {
        CoreBridge::upsert_connection(
            &bridge,
            ConnectionRecord::Sqlite(SqliteConnection {
                allow_mcp: false,
                mcp_hidden_tables: Vec::new(),
                mcp_until: None,
                mcp_samples_off: false,
                mcp_timeout_s: None,
                mcp_access: None,
                masked_columns: Default::default(),
                environment: None,
                safe_mode,
                id: id.into(),
                name: id.into(),
                path: path.clone(),
                sample: false,
            }),
            ConnectionSecrets::default(),
        )
        .expect("save");
        bridge.open_window(id, id, None).expect("open");
    }
    let spec = import_spec(&csv.to_string_lossy(), "main", &[(0, "id"), (1, "name")]);
    let never = Arc::new(AtomicBool::new(false));
    assert_eq!(
        bridge.import_csv("ro", spec.clone(), never.clone(), quiet()),
        Ok(ImportOutcome::Refused)
    );
    // Confirm writes: the panel's Import button was the confirmation.
    let out = bridge
        .import_csv("confirm", spec.clone(), never.clone(), quiet())
        .expect("import");
    assert!(
        matches!(out, ImportOutcome::Imported { counts } if counts.inserted == 2),
        "{out:?}"
    );
    let count = |sql: &str| window_query(&bridge, "confirm", 1, sql).0;
    assert_eq!(count("SELECT count(*) FROM it_import"), Some(Value::Int(2)));
    // Again: both keys exist, Stop names the line and keeps nothing new.
    let out = bridge
        .import_csv("confirm", spec, never, quiet())
        .expect("import");
    assert!(
        matches!(&out, ImportOutcome::Failed { message } if message.starts_with("Line 2: UNIQUE")),
        "{out:?}"
    );
    let _ = fs::remove_file(&csv);
    std::env::remove_var("ROWKERY_CONFIG_DIR");
}

#[test]
fn postgres_import_csv() {
    use rowkery_core::import::{EmptyCells, OnConflict};
    let Ok(host) = std::env::var("ROWKERY_PG_HOST") else {
        eprintln!("skip postgres_import_csv (set ROWKERY_PG_HOST)");
        return;
    };
    let (_guard, _file, _path) = test_guard();
    let bridge = super::CoreBridge::spawn();
    for (id, safe_mode) in [("off", SafeMode::Off), ("ro", SafeMode::ReadOnly)] {
        CoreBridge::upsert_connection(
            &bridge,
            ConnectionRecord::Postgres(PostgresConnection {
                allow_mcp: false,
                mcp_hidden_tables: Vec::new(),
                mcp_until: None,
                mcp_samples_off: false,
                mcp_timeout_s: None,
                mcp_access: None,
                masked_columns: Default::default(),
                environment: None,
                safe_mode,
                id: id.into(),
                name: id.into(),
                host: host.clone(),
                port: std::env::var("ROWKERY_PG_PORT")
                    .ok()
                    .and_then(|p| p.parse().ok())
                    .unwrap_or(54329),
                database: std::env::var("ROWKERY_PG_DB").unwrap_or_else(|_| "rowkery".into()),
                username: std::env::var("ROWKERY_PG_USER").unwrap_or_else(|_| "rowkery".into()),
                ssl_mode: PostgresSslMode::Disable,
                ssl_root_cert: None,
                ssh: None,
                cloud_sql: None,
            }),
            ConnectionSecrets {
                db_password: Some(
                    std::env::var("ROWKERY_PG_PASSWORD").unwrap_or_else(|_| "rowkery".into()),
                ),
                ..Default::default()
            },
        )
        .expect("save");
        bridge.open_window(id, id, None).expect("open");
    }
    let run = |sql: &str| window_query(&bridge, "off", 1, sql);
    for sql in [
        "DROP TABLE IF EXISTS public.it_import",
        "CREATE TABLE public.it_import (id int PRIMARY KEY, email text NOT NULL, \
             total numeric(10,2), status text DEFAULT 'pending', note text, \
             placed timestamptz DEFAULT '2026-01-01', meta jsonb)",
        "INSERT INTO public.it_import (id, email) VALUES (1, 'old@x.com')",
    ] {
        assert_eq!(run(sql).1, None, "{sql}");
    }
    let one = |sql: &str| run(sql).0;
    let dir = tempfile::tempdir().expect("dir");
    let write = |name: &str, text: &str| {
        let p = dir.path().join(name);
        fs::write(&p, text).expect("csv");
        p.to_string_lossy().to_string()
    };
    let small = write(
        "small.csv",
        "order_id,mail,amount,state,gift,placed,meta\n\
             1,new@x.com,5,paid,,2026-10-20 14:10,\n\
             2,b@x.com,7.50,,\"tab\there, back\\slash\",,\"{\"\"a\"\": 1}\"\n\
             3,c@x.com,,shipped,,,\n",
    );
    let cols = [
        (0, "id"),
        (1, "email"),
        (2, "total"),
        (3, "status"),
        (4, "note"),
        (5, "placed"),
        (6, "meta"),
    ];
    let never = Arc::new(AtomicBool::new(false));
    let import = |spec: ImportSpec| {
        bridge
            .import_csv("off", spec, never.clone(), quiet())
            .expect("import")
    };
    let mut spec = import_spec(&small, "public", &cols);

    // Read-only refuses before anything runs.
    assert_eq!(
        bridge.import_csv("ro", spec.clone(), never.clone(), quiet()),
        Ok(ImportOutcome::Refused)
    );
    // Stop: id 1 is there, so nothing is kept.
    let out = import(spec.clone());
    assert!(
        matches!(&out, ImportOutcome::Failed { message } if message.contains("Key (id)=(1) already exists")),
        "{out:?}"
    );
    assert_eq!(one("SELECT count(*) FROM it_import"), Some(Value::Int(1)));
    // Skip: two new rows; empty cells take the DEFAULT, text keeps its tab and backslash.
    spec.on_conflict = OnConflict::Skip;
    let out = import(spec.clone());
    assert!(
        matches!(out, ImportOutcome::Imported { counts } if (counts.inserted, counts.updated, counts.skipped) == (2, 0, 1)),
        "{out:?}"
    );
    assert_eq!(
            one("SELECT status || '|' || note || '|' || placed::date || '|' || (meta->>'a') FROM it_import WHERE id = 2"),
            Some(Value::Text("pending|tab\there, back\\slash|2026-01-01|1".into()))
        );
    assert_eq!(
        one("SELECT total IS NULL AND note IS NULL FROM it_import WHERE id = 3"),
        Some(Value::Bool(true))
    );
    // Update: all three exist; Empty text gives note ''.
    spec.on_conflict = OnConflict::Update;
    spec.empty = EmptyCells::Text;
    let out = import(spec.clone());
    assert!(
        matches!(out, ImportOutcome::Imported { counts } if (counts.inserted, counts.updated, counts.skipped) == (0, 3, 0)),
        "{out:?}"
    );
    assert_eq!(
        one("SELECT email || '|' || total || '|' || note FROM it_import WHERE id = 1"),
        Some(Value::Text("new@x.com|5.00|".into()))
    );

    // A value the server refuses names the file's line and the column.
    let bad = write(
        "bad.csv",
        "id,email,placed\n10,a@x.com,2026-01-01\n11,\"multi\nline\",soon\n",
    );
    let out = import(import_spec(
        &bad,
        "public",
        &[(0, "id"), (1, "email"), (2, "placed")],
    ));
    assert!(
        matches!(&out, ImportOutcome::Failed { message } if message.starts_with("Line 3, placed: invalid input syntax for type timestamp with time zone")),
        "{out:?}"
    );
    // A value the grid's rules refuse is caught before it is sent.
    let bad = write("bad2.csv", "id,email,total\n12,a@x.com,n/a\n");
    let out = import(import_spec(
        &bad,
        "public",
        &[(0, "id"), (1, "email"), (2, "total")],
    ));
    assert_eq!(
        out,
        ImportOutcome::Failed {
            message: "Line 2, total: 'n/a' isn't a number".into()
        }
    );
    assert_eq!(one("SELECT count(*) FROM it_import"), Some(Value::Int(3)));

    // The tab's open transaction is untouched: the import runs beside it.
    assert_eq!(run("BEGIN").1, None);
    assert_eq!(
        run("INSERT INTO it_import (id, email) VALUES (500, 'mine')").1,
        None
    );
    let side = write("side.csv", "id,email\n600,side@x.com\n");
    let out = import(import_spec(&side, "public", &[(0, "id"), (1, "email")]));
    assert!(matches!(out, ImportOutcome::Imported { .. }), "{out:?}");
    assert_eq!(run("ROLLBACK").1, None);
    assert_eq!(
        one("SELECT count(*) FROM it_import WHERE id IN (500, 600)"),
        Some(Value::Int(1))
    );

    // 100k rows, timed; then a cancel rolls the same file back.
    let mut big = String::from("id,email,total,status,note,placed,meta\n");
    for i in 0..100_000 {
        big.push_str(&format!(
            "{},user{i}@mail.com,{}.{:02},{},\"note, {i}\",2026-10-{:02} 14:{:02},\n",
            1000 + i,
            i % 500,
            i % 100,
            ["pending", "paid", "shipped"][i % 3],
            1 + i % 28,
            i % 60
        ));
    }
    let big = write("big.csv", &big);
    let start = Instant::now();
    let out = import(import_spec(&big, "public", &cols));
    let took = start.elapsed();
    assert!(
        matches!(out, ImportOutcome::Imported { counts } if counts.inserted == 100_000),
        "{out:?}"
    );
    eprintln!(
        "postgres_import_csv: 100,000 rows in {} ms",
        took.as_millis()
    );
    assert_eq!(run("DELETE FROM it_import WHERE id >= 1000").1, None);
    let cancel = Arc::new(AtomicBool::new(false));
    let seen = Arc::new(AtomicU64::new(0));
    let (c, s) = (cancel.clone(), seen.clone());
    let out = bridge
        .import_csv(
            "off",
            import_spec(&big, "public", &cols),
            cancel,
            ImportProgress(Arc::new(move |n| {
                s.store(n, Ordering::SeqCst);
                c.store(true, Ordering::SeqCst);
            })),
        )
        .expect("import");
    assert_eq!(out, ImportOutcome::Cancelled);
    assert!(seen.load(Ordering::SeqCst) > 0);
    assert_eq!(
        one("SELECT count(*) FROM it_import WHERE id >= 1000"),
        Some(Value::Int(0))
    );

    // Update with empty cells as NULL: the row keeps its values.
    let blank = write("blank.csv", "id,email,total,status,note\n3,,,,\n");
    let mut keep = import_spec(
        &blank,
        "public",
        &[
            (0, "id"),
            (1, "email"),
            (2, "total"),
            (3, "status"),
            (4, "note"),
        ],
    );
    keep.on_conflict = OnConflict::Update;
    let out = import(keep);
    assert!(
        matches!(out, ImportOutcome::Imported { counts } if (counts.inserted, counts.updated) == (0, 1)),
        "{out:?}"
    );
    assert_eq!(
        one("SELECT email || '|' || status FROM it_import WHERE id = 3"),
        Some(Value::Text("c@x.com|shipped".into()))
    );

    // Waiting on a lock a tab holds: Cancel ends the wait.
    assert_eq!(run("BEGIN").1, None);
    assert_eq!(run("LOCK TABLE it_import IN ACCESS EXCLUSIVE MODE").1, None);
    let cancel = Arc::new(AtomicBool::new(false));
    let later = cancel.clone();
    let timer = std::thread::spawn(move || {
        std::thread::sleep(Duration::from_millis(400));
        later.store(true, Ordering::SeqCst);
    });
    let out = bridge
        .import_csv(
            "off",
            import_spec(&side, "public", &[(0, "id"), (1, "email")]),
            cancel,
            quiet(),
        )
        .expect("import");
    timer.join().unwrap();
    assert_eq!(out, ImportOutcome::Cancelled);
    assert_eq!(run("ROLLBACK").1, None);

    // Identity columns: BY DEFAULT fills an empty cell; ALWAYS can't be imported into.
    for sql in [
        "DROP TABLE IF EXISTS public.it_ident",
        "CREATE TABLE public.it_ident (id int GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY, \
             name text, n int GENERATED ALWAYS AS IDENTITY)",
    ] {
        assert_eq!(run(sql).1, None, "{sql}");
    }
    let ident = write("ident.csv", "id,name,n\n,a,\n5,b,\n");
    let ident_spec = |columns: &[(usize, &str)]| ImportSpec {
        table: "it_ident".into(),
        ..import_spec(&ident, "public", columns)
    };
    let out = import(ident_spec(&[(0, "id"), (1, "name")]));
    assert!(matches!(out, ImportOutcome::Imported { .. }), "{out:?}");
    assert_eq!(
        one("SELECT string_agg(id::text, ',' ORDER BY id) FROM it_ident"),
        Some(Value::Text("1,5".into()))
    );
    let out = import(ident_spec(&[(1, "name"), (2, "n")]));
    assert_eq!(
        out,
        ImportOutcome::Failed {
            message: "n is filled in by the database, so it can't be imported. Skip it.".into()
        }
    );
    assert_eq!(run("DROP TABLE public.it_ident").1, None);
    assert_eq!(run("DROP TABLE public.it_import").1, None);
    std::env::remove_var("ROWKERY_CONFIG_DIR");
}

/// Run SQL file goes through safe mode: read-only refuses, Confirm
/// writes needs the panel's Run, and a run commits the whole file.
#[test]
fn sqlite_sql_file_runs_through_safe_mode() {
    let (_guard, _file, path) = test_guard();
    let bridge = super::CoreBridge::spawn();
    let dir = tempfile::tempdir().unwrap();
    let file = dir.path().join("f.sql");
    std::fs::write(
        &file,
        "CREATE TABLE imported(a);\nINSERT INTO imported VALUES (1), (2);\n",
    )
    .unwrap();
    let scan = rowkery_core::sql_file::scan(&file, EngineKind::Sqlite, |_| true).unwrap();
    let options = RunOptions {
        whole_file: true,
        keep_going: false,
    };
    let progress = || ProgressSink(Box::new(|_| {}));
    for (id, mode) in [
        ("ro", SafeMode::ReadOnly),
        ("confirm", SafeMode::Confirm),
        ("off", SafeMode::Off),
    ] {
        CoreBridge::upsert_connection(
            &bridge,
            ConnectionRecord::Sqlite(SqliteConnection {
                environment: None,
                safe_mode: mode,
                allow_mcp: false,
                mcp_hidden_tables: Vec::new(),
                mcp_until: None,
                mcp_samples_off: false,
                mcp_timeout_s: None,
                mcp_access: None,
                masked_columns: Default::default(),
                id: id.into(),
                name: id.into(),
                path: path.clone(),
                sample: false,
            }),
            ConnectionSecrets::default(),
        )
        .expect("save");
        bridge.open_window(id, id, None).expect("open");
    }
    let run = |window: &str, confirmed: bool| {
        bridge.run_sql_file(
            window,
            file.clone(),
            scan.clone(),
            options,
            confirmed,
            progress(),
        )
    };
    assert!(run("ro", true).unwrap_err().contains("read-only"));
    assert!(run("confirm", false).unwrap_err().contains("Run"));
    let report = run("off", false).expect("runs");
    assert_eq!((report.done, report.rows, report.failed), (2, 2, None));
    let count: i64 = Connection::open(&path)
        .unwrap()
        .query_row("SELECT count(*) FROM imported", [], |r| r.get(0))
        .unwrap();
    assert_eq!(count, 2);
    std::env::remove_var("ROWKERY_CONFIG_DIR");
}

/// A run's end: its error, whether it was cancelled, and what else core said.
fn window_query_detail(
    bridge: &super::CoreBridge,
    window_id: &str,
    tab_id: u64,
    sql: &str,
) -> (Option<String>, bool, QueryDetail) {
    let queue = bridge
        .run_window_query(window_id, tab_id, sql.into(), None, false)
        .expect("run");
    wait_detail(&queue, Duration::from_secs(10)).unwrap_or_else(|| panic!("not done: {sql}"))
}

fn wait_detail(
    queue: &EventQueue,
    within: Duration,
) -> Option<(Option<String>, bool, QueryDetail)> {
    let deadline = Instant::now() + within;
    while Instant::now() < deadline {
        let drained: Vec<CoreEvent> = std::mem::take(&mut *queue.lock().unwrap());
        for event in drained {
            if let CoreEvent::QueryFinished {
                error,
                cancelled,
                detail,
                ..
            } = event
            {
                return Some((error, cancelled, detail));
            }
        }
        thread::sleep(Duration::from_millis(5));
    }
    None
}

/// The tabs holding a transaction, once the run that opened one has parked
/// its session (that happens just after the run reports it finished).
fn open_transactions_once_parked(bridge: &super::CoreBridge) -> Vec<(String, u64)> {
    let deadline = Instant::now() + Duration::from_secs(3);
    loop {
        let open = bridge.open_transactions();
        if !open.is_empty() || Instant::now() > deadline {
            return open;
        }
        thread::sleep(Duration::from_millis(20));
    }
}

/// Saves the connection again with `mode`.
fn set_safe_mode(bridge: &super::CoreBridge, id: &str, mode: SafeMode) -> Result<(), String> {
    let mut record = bridge
        .list_connections()
        .into_iter()
        .find(|c| c.id() == id)
        .expect("saved");
    match &mut record {
        ConnectionRecord::Postgres(pg) => pg.safe_mode = mode,
        ConnectionRecord::Sqlite(lite) => lite.safe_mode = mode,
    }
    CoreBridge::upsert_connection(bridge, record, ConnectionSecrets::default())
        .map_err(|e| e.to_string())
}

/// A transaction open in a tab: safe mode doesn't change under it (that
/// would start the window's sessions afresh and roll it back), it commits
/// as usual afterwards, and a COMMIT with nothing open says so through the
/// server's warning instead of reading as a plain success. A re-point that
/// happens anyway leaves the tab saying its transaction was lost.
#[test]
fn postgres_an_open_transaction_holds_off_a_safe_mode_change() {
    let (_guard, _file, _path) = test_guard();
    let bridge = super::CoreBridge::spawn();
    let id = "keepopen-safe";
    if save_pg_at(&bridge, id, None, SafeMode::Off).is_none() {
        eprintln!(
            "skip postgres_an_open_transaction_holds_off_a_safe_mode_change (set ROWKERY_PG_HOST)"
        );
        return;
    }
    bridge.open_window("w", id, None).expect("open");
    let run = |tab, sql: &str| window_query(&bridge, "w", tab, sql);
    for sql in [
        "DROP TABLE IF EXISTS keepopen_safe",
        "CREATE TABLE keepopen_safe (id int)",
    ] {
        assert_eq!(run(9, sql).1, None, "{sql}");
    }
    let rows = || int_of(run(9, "SELECT count(*)::int FROM keepopen_safe").0);

    assert_eq!(run(1, "BEGIN").1, None);
    assert_eq!(run(1, "INSERT INTO keepopen_safe VALUES (1)").1, None);
    assert_eq!(
        open_transactions_once_parked(&bridge),
        vec![("w".to_string(), 1)]
    );
    let refused = set_safe_mode(&bridge, id, SafeMode::Confirm).expect_err("refused");
    assert!(refused.contains("transaction open"), "{refused}");
    let saved = bridge.list_connections();
    assert_eq!(
        saved.iter().find(|c| c.id() == id).map(|c| c.safe_mode()),
        Some(SafeMode::Off),
        "the old mode stays"
    );
    assert_eq!(run(1, "COMMIT").1, None, "the transaction was kept");
    assert_eq!(rows(), 1);
    assert!(bridge.open_transactions().is_empty());

    // Nothing open: COMMIT runs, and the server's warning comes with it.
    let (error, _, detail) = window_query_detail(&bridge, "w", 1, "COMMIT");
    assert_eq!(error, None);
    let warning = detail.warning.expect("a warning");
    assert!(warning.contains("no transaction in progress"), "{warning}");
    // Only that run's: the next one has none.
    assert_eq!(
        window_query_detail(&bridge, "w", 1, "SELECT 1").2.warning,
        None
    );
    // A BEGIN of ours that finds the user's open says nothing to them.
    assert_eq!(run(1, "BEGIN").1, None);
    assert_eq!(
        window_query_detail(&bridge, "w", 1, "SELECT 2").2.warning,
        None
    );
    assert_eq!(run(1, "ROLLBACK").1, None);

    set_safe_mode(&bridge, id, SafeMode::Confirm).expect("changes with none open");
    set_safe_mode(&bridge, id, SafeMode::Off).expect("and back");

    // Nor does a re-point (another database, Reconnect): core refuses it
    // as the app does, and the transaction commits afterwards.
    assert_eq!(run(2, "BEGIN").1, None);
    assert_eq!(run(2, "INSERT INTO keepopen_safe VALUES (2)").1, None);
    assert_eq!(
        open_transactions_once_parked(&bridge),
        vec![("w".to_string(), 2)]
    );
    let refused = bridge.open_window("w", id, None).expect_err("refused");
    assert_eq!(refused, super::REPOINT_IN_TXN);
    assert_eq!(run(2, "COMMIT").1, None, "the transaction was kept");
    assert_eq!(rows(), 2);
    assert_eq!(run(9, "DROP TABLE keepopen_safe").1, None);
    std::env::remove_var("ROWKERY_CONFIG_DIR");
}

/// A cancel inside the user's transaction keeps the tab's session: the
/// cancelled statement leaves the transaction failed (ROLLBACK still
/// needed), and a cancel that lands as a statement finishes leaves it open.
/// Neither drops the session and the transaction with it.
#[test]
fn postgres_a_cancel_keeps_the_transaction_it_hit() {
    let (_guard, _file, _path) = test_guard();
    let bridge = super::CoreBridge::spawn();
    let id = "keepopen-cancel";
    if save_pg_at(&bridge, id, None, SafeMode::Off).is_none() {
        eprintln!("skip postgres_a_cancel_keeps_the_transaction_it_hit (set ROWKERY_PG_HOST)");
        return;
    }
    bridge.open_window("w", id, None).expect("open");
    let run = |tab, sql: &str| window_query(&bridge, "w", tab, sql);
    for sql in [
        "DROP TABLE IF EXISTS keepopen_cancel",
        "CREATE TABLE keepopen_cancel (id int)",
    ] {
        assert_eq!(run(9, sql).1, None, "{sql}");
    }

    // Cancelled mid-statement: the transaction is failed, not gone.
    assert_eq!(run(1, "BEGIN").1, None);
    assert_eq!(run(1, "INSERT INTO keepopen_cancel VALUES (1)").1, None);
    let queue = bridge
        .run_window_query("w", 1, "SELECT pg_sleep(30)".into(), None, false)
        .expect("run");
    thread::sleep(Duration::from_millis(800));
    bridge.cancel_window_query("w", 1);
    let (_, cancelled, detail) = wait_detail(&queue, Duration::from_secs(5)).expect("done");
    assert!(cancelled && !detail.forced);
    let error = run(1, "SELECT 1")
        .1
        .expect("the failed transaction refuses it");
    assert!(error.contains("aborted"), "{error}");
    assert_eq!(
        open_transactions_once_parked(&bridge),
        vec![("w".to_string(), 1)]
    );
    assert_eq!(run(1, "ROLLBACK").1, None);

    // A cancel racing a short statement: either way the session stays, and
    // when the INSERT won, it is there inside the transaction.
    let pid = |tab| run(tab, "SELECT pg_backend_pid()").0;
    let backend = pid(2);
    assert!(backend.is_some());
    for n in 0..5 {
        assert_eq!(run(2, "BEGIN").1, None);
        let queue = bridge
            .run_window_query(
                "w",
                2,
                format!("INSERT INTO keepopen_cancel VALUES ({n})"),
                None,
                false,
            )
            .expect("run");
        // Later each time, so some cancels land as the INSERT ends.
        thread::sleep(Duration::from_millis(n * 3));
        bridge.cancel_window_query("w", 2);
        let (_, cancelled, _) = wait_detail(&queue, Duration::from_secs(5)).expect("done");
        let (seen, error, ..) = run(
            2,
            &format!("SELECT count(*)::int FROM keepopen_cancel WHERE id = {n}"),
        );
        match error {
            // Not stopped: the INSERT is there, inside the transaction.
            None if !cancelled => assert_eq!(int_of(seen), 1, "the INSERT is kept"),
            // Stopped before it ran, or the cancel came as it ended.
            None => assert!(int_of(seen) <= 1),
            Some(e) => assert!(e.contains("aborted"), "{e}"),
        }
        assert_eq!(run(2, "ROLLBACK").1, None);
        assert_eq!(pid(2), backend, "still the same session");
    }
    assert_eq!(
        int_of(run(9, "SELECT count(*)::int FROM keepopen_cancel").0),
        0
    );
    assert_eq!(run(9, "DROP TABLE keepopen_cancel").1, None);
    std::env::remove_var("ROWKERY_CONFIG_DIR");
}

/// Force stop closes the tab's socket, which the server doesn't notice
/// while it runs: a cancel from another session stops the statement there,
/// and the run says it was stopped without the server's answer.
#[test]
fn postgres_a_force_stop_cancels_on_the_server_too() {
    let (_guard, _file, _path) = test_guard();
    let bridge = super::CoreBridge::spawn();
    let id = "keepopen-force";
    if save_pg_at(&bridge, id, None, SafeMode::Off).is_none() {
        eprintln!("skip postgres_a_force_stop_cancels_on_the_server_too (set ROWKERY_PG_HOST)");
        return;
    }
    bridge.open_window("w", id, None).expect("open");
    let sql = "SELECT pg_sleep(30) AS keepopen_force";
    let queue = bridge
        .run_window_query("w", 1, sql.into(), None, false)
        .expect("run");
    thread::sleep(Duration::from_millis(800));
    // The tab's own cancel request never arrives: only the one from another
    // session can stop it.
    NO_TOKEN_CANCEL.store(true, Ordering::SeqCst);
    bridge.stop_all_queries();
    thread::sleep(Duration::from_millis(100));
    NO_TOKEN_CANCEL.store(false, Ordering::SeqCst);
    let (_, cancelled, detail) = wait_detail(&queue, Duration::from_secs(5)).expect("done");
    assert!(cancelled && detail.forced);
    let running = || {
        int_of(
            window_query(
                &bridge,
                "w",
                9,
                &format!(
                    "SELECT count(*)::int FROM pg_stat_activity \
                     WHERE state = 'active' AND query = '{sql}'"
                ),
            )
            .0,
        )
    };
    let deadline = Instant::now() + Duration::from_secs(5);
    while running() > 0 {
        assert!(Instant::now() < deadline, "still running on the server");
        thread::sleep(Duration::from_millis(100));
    }
    std::env::remove_var("ROWKERY_CONFIG_DIR");
}

/// Waits for no tab's session to hold a transaction.
fn no_open_transactions(bridge: &super::CoreBridge, what: &str) {
    let deadline = Instant::now() + Duration::from_secs(5);
    while !bridge.open_transactions().is_empty() {
        assert!(
            Instant::now() < deadline,
            "{what}: {:?}",
            bridge.open_transactions()
        );
        thread::sleep(Duration::from_millis(20));
    }
}

/// A tab closed while its query runs inside a transaction: its session is
/// dropped when the cancelled run comes back, not parked for a tab that no
/// longer exists, so nothing is left holding the transaction (or blocking
/// safe mode).
#[test]
fn postgres_a_tab_closed_mid_run_leaves_no_transaction_behind() {
    let (_guard, _file, _path) = test_guard();
    let bridge = super::CoreBridge::spawn();
    let id = "keepopen-closed";
    if save_pg_at(&bridge, id, None, SafeMode::Off).is_none() {
        eprintln!(
            "skip postgres_a_tab_closed_mid_run_leaves_no_transaction_behind (set ROWKERY_PG_HOST)"
        );
        return;
    }
    bridge.open_window("w", id, None).expect("open");
    let sql = "SELECT pg_sleep(30) AS keepopen_closed";
    assert_eq!(window_query(&bridge, "w", 3, "BEGIN").1, None);
    let queue = bridge
        .run_window_query("w", 3, sql.into(), None, false)
        .expect("run");
    thread::sleep(Duration::from_millis(500));
    assert_eq!(bridge.open_transactions(), vec![("w".to_string(), 3)]);
    bridge.close_window_tab("w", 3);
    wait_detail(&queue, Duration::from_secs(5)).expect("stopped");
    no_open_transactions(&bridge, "the closed tab's transaction");
    set_safe_mode(&bridge, id, SafeMode::Confirm).expect("nothing in the way");
    set_safe_mode(&bridge, id, SafeMode::Off).expect("and back");
    // Its backend is gone from the server, not idle in a transaction.
    let deadline = Instant::now() + Duration::from_secs(5);
    loop {
        let left = int_of(
            window_query(
                &bridge,
                "w",
                9,
                &format!(
                    "SELECT count(*)::int FROM pg_stat_activity \
                     WHERE query = '{sql}' AND pid <> pg_backend_pid()"
                ),
            )
            .0,
        );
        if left == 0 {
            break;
        }
        assert!(Instant::now() < deadline, "its session is still there");
        thread::sleep(Duration::from_millis(100));
    }
    std::env::remove_var("ROWKERY_CONFIG_DIR");
}

/// A tab whose session is out running a statement inside the user's
/// transaction still counts: safe mode doesn't change under it, and the
/// transaction commits afterwards.
#[test]
fn postgres_a_running_tab_holds_off_a_safe_mode_change() {
    let (_guard, _file, _path) = test_guard();
    let bridge = super::CoreBridge::spawn();
    let id = "keepopen-running";
    if save_pg_at(&bridge, id, None, SafeMode::Off).is_none() {
        eprintln!("skip postgres_a_running_tab_holds_off_a_safe_mode_change (set ROWKERY_PG_HOST)");
        return;
    }
    bridge.open_window("w", id, None).expect("open");
    let run = |tab, sql: &str| window_query(&bridge, "w", tab, sql);
    for sql in [
        "DROP TABLE IF EXISTS keepopen_running",
        "CREATE TABLE keepopen_running (id int)",
    ] {
        assert_eq!(run(9, sql).1, None, "{sql}");
    }
    assert_eq!(run(1, "BEGIN").1, None);
    assert_eq!(run(1, "INSERT INTO keepopen_running VALUES (1)").1, None);
    let queue = bridge
        .run_window_query("w", 1, "SELECT pg_sleep(1)".into(), None, false)
        .expect("run");
    thread::sleep(Duration::from_millis(300));
    let refused = set_safe_mode(&bridge, id, SafeMode::Confirm).expect_err("refused");
    assert!(refused.contains("transaction open"), "{refused}");
    let refused = bridge.open_window("w", id, None).expect_err("refused");
    assert_eq!(refused, super::REPOINT_IN_TXN);
    let (error, ..) = wait_detail(&queue, Duration::from_secs(5)).expect("done");
    assert_eq!(error, None);
    assert_eq!(run(1, "COMMIT").1, None, "the transaction was kept");
    assert_eq!(
        int_of(run(9, "SELECT count(*)::int FROM keepopen_running").0),
        1
    );
    assert_eq!(run(9, "DROP TABLE keepopen_running").1, None);
    std::env::remove_var("ROWKERY_CONFIG_DIR");
}

/// A force stop of a statement that may have opened or ended a transaction
/// (a write, on a session that held none when the run began) still tells
/// the tab: its next statement says a transaction may be gone.
#[test]
fn postgres_a_force_stop_of_a_write_marks_the_transaction_lost() {
    let (_guard, _file, _path) = test_guard();
    let bridge = super::CoreBridge::spawn();
    let id = "keepopen-forced-write";
    if save_pg_at(&bridge, id, None, SafeMode::Off).is_none() {
        eprintln!("skip postgres_a_force_stop_of_a_write_marks_the_transaction_lost (set ROWKERY_PG_HOST)");
        return;
    }
    bridge.open_window("w", id, None).expect("open");
    let queue = bridge
        .run_window_query(
            "w",
            4,
            "CREATE TEMP TABLE keepopen_forced AS SELECT 1 AS id FROM pg_sleep(30)".into(),
            None,
            false,
        )
        .expect("run");
    thread::sleep(Duration::from_millis(800));
    bridge.stop_all_queries();
    let (error, cancelled, detail) = wait_detail(&queue, Duration::from_secs(5)).expect("done");
    assert!(
        cancelled && detail.forced,
        "{error:?} {cancelled} {detail:?}"
    );
    let error = window_query(&bridge, "w", 4, "COMMIT")
        .1
        .expect("the tab is told");
    assert_eq!(error, super::pool::LOST_MAYBE_TXN);
    std::env::remove_var("ROWKERY_CONFIG_DIR");
}

/// A Postgres connection to the test server (or to `port`, a proxy in
/// front of it) with `safe_mode`, saved under `id`.
fn save_pg_with(bridge: &super::CoreBridge, id: &str, port: Option<u16>, safe_mode: SafeMode) {
    let (host, port) = match port {
        Some(p) => ("127.0.0.1".to_string(), p),
        None => (
            std::env::var("ROWKERY_PG_HOST").unwrap(),
            std::env::var("ROWKERY_PG_PORT")
                .ok()
                .and_then(|p| p.parse().ok())
                .unwrap_or(54329),
        ),
    };
    CoreBridge::upsert_connection(
        bridge,
        ConnectionRecord::Postgres(PostgresConnection {
            environment: None,
            safe_mode,
            allow_mcp: false,
            mcp_hidden_tables: Vec::new(),
            mcp_until: None,
            mcp_samples_off: false,
            mcp_timeout_s: None,
            mcp_access: None,
            masked_columns: Default::default(),
            id: id.into(),
            name: id.into(),
            host,
            port,
            database: std::env::var("ROWKERY_PG_DB").unwrap_or_else(|_| "rowkery".into()),
            username: std::env::var("ROWKERY_PG_USER").unwrap_or_else(|_| "rowkery".into()),
            ssl_mode: PostgresSslMode::Disable,
            ssl_root_cert: None,
            ssh: None,
            cloud_sql: None,
        }),
        ConnectionSecrets {
            db_password: Some(
                std::env::var("ROWKERY_PG_PASSWORD").unwrap_or_else(|_| "rowkery".into()),
            ),
            ..Default::default()
        },
    )
    .expect("save");
}

/// A function the text check can't see into turns the session's read-only
/// default off: the next transaction still starts read-only, after a
/// plain run, inside the user's transaction (committed or failed and
/// rolled back) and after paging through a cursor.
#[test]
fn postgres_read_only_holds_after_a_function_turns_it_off() {
    if std::env::var("ROWKERY_PG_HOST").is_err() {
        eprintln!(
            "skip postgres_read_only_holds_after_a_function_turns_it_off (set ROWKERY_PG_HOST)"
        );
        return;
    }
    let (_guard, _file, _path) = test_guard();
    let bridge = super::CoreBridge::spawn();
    let id = "postgres-ro-holds";
    save_pg_with(&bridge, id, None, SafeMode::Off);
    bridge.open_window("w", id, None).expect("open");
    let run = |sql: &str| window_query(&bridge, "w", 1, sql);
    for sql in [
        "DROP TABLE IF EXISTS rowkery_ro_t",
        "CREATE TABLE rowkery_ro_t (n int)",
        "CREATE OR REPLACE FUNCTION rowkery_ro_flip() RETURNS text LANGUAGE sql \
         AS $$ SELECT set_config('default_transaction_read_only', 'off', false) $$",
        "CREATE OR REPLACE FUNCTION rowkery_ro_write() RETURNS int LANGUAGE sql \
         AS $$ INSERT INTO rowkery_ro_t VALUES (1) RETURNING 1 $$",
    ] {
        assert_eq!(run(sql).1, None, "{sql}");
    }

    save_pg_with(&bridge, id, None, SafeMode::ReadOnly);
    let text = |v: &str| Some(Value::Text(v.into()));
    let refused = |what: &str| {
        let (_, err, ..) = run("SELECT rowkery_ro_write()");
        assert!(
            err.as_deref().is_some_and(|e| e.contains("read-only")),
            "{what}: {err:?}"
        );
        assert_eq!(
            run("SHOW default_transaction_read_only").0,
            text("on"),
            "{what}"
        );
    };

    // A plain run.
    assert_eq!(run("SELECT rowkery_ro_flip()").0, text("off"));
    refused("after a plain run");

    // Inside the user's transaction, then committed.
    assert_eq!(run("BEGIN").1, None);
    assert_eq!(run("SELECT rowkery_ro_flip()").0, text("off"));
    assert_eq!(run("COMMIT").1, None);
    refused("after the user's transaction");

    // The user's transaction failed: the SET is refused there (25P02),
    // and the run's own error is what the tab shows.
    assert_eq!(run("BEGIN").1, None);
    assert_eq!(run("SELECT rowkery_ro_flip()").0, text("off"));
    assert!(run("SELECT 1 / 0").1.is_some());
    let (_, err, ..) = run("SELECT 1");
    assert!(
        err.as_deref().is_some_and(|e| e.contains("aborted")),
        "{err:?}"
    );
    assert_eq!(run("ROLLBACK").1, None);
    refused("after the failed transaction");

    // Pages of a cursor, each running the function again.
    let paged = |sql: &str, page: u32| {
        let queue: EventQueue = Arc::default();
        bridge
            .run_window_query_paged("w", 1, sql.into(), None, Some(page), false, queue.clone())
            .expect("run");
        drain_paged(&queue)
    };
    let more = |rows: u32| {
        let queue: EventQueue = Arc::default();
        bridge
            .fetch_more_to("w", 1, rows, queue.clone())
            .expect("fetch");
        drain_paged(&queue)
    };
    let sql = "SELECT g, rowkery_ro_flip() FROM generate_series(1, 300) g";
    let (rows, _, err, is_paged, left) = paged(sql, 100);
    assert_eq!((rows, err, is_paged, left), (100, None, true, true));
    let (rows, _, err, _, left) = more(100);
    assert_eq!((rows, err, left), (100, None, true));
    // Mid-cursor: the next run starts read-only.
    let (_, err, ..) = run("SELECT rowkery_ro_write()");
    assert!(
        err.as_deref().is_some_and(|e| e.contains("read-only")),
        "{err:?}"
    );
    assert_eq!(paged(sql, 100).2, None);
    let (rows, _, err, _, _) = more(0);
    assert_eq!((rows, err), (200, None));
    refused("after paging");

    // The cursor's own BEGIN, right after a run that turned the default
    // off: its transaction starts read-only too.
    assert_eq!(run("SELECT rowkery_ro_flip()").0, text("off"));
    let (_, _, err, ..) = paged(
        "SELECT g, rowkery_ro_write() FROM generate_series(1, 3) g",
        100,
    );
    assert!(
        err.as_deref().is_some_and(|e| e.contains("read-only")),
        "{err:?}"
    );

    save_pg_with(&bridge, id, None, SafeMode::Off);
    assert_eq!(
        run("SELECT count(*) FROM rowkery_ro_t").0,
        Some(Value::Int(0))
    );
    run("DROP FUNCTION rowkery_ro_flip()");
    run("DROP FUNCTION rowkery_ro_write()");
    run("DROP TABLE rowkery_ro_t");
    std::env::remove_var("ROWKERY_CONFIG_DIR");
}

/// A TCP proxy to Postgres whose open sockets can be broken: once
/// `break_now` is called, each socket open then is closed the moment its
/// client next sends, before anything reaches the server, like a warm
/// session whose link died while it was parked. Later sockets pass.
fn breaking_proxy(upstream: String) -> (u16, impl Fn()) {
    use std::io::{Read, Write};
    use std::net::{Shutdown, TcpListener, TcpStream};
    use std::sync::atomic::AtomicUsize;
    let accepted = Arc::new(AtomicUsize::new(0));
    let broken_below = Arc::new(AtomicUsize::new(0));
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let port = listener.local_addr().unwrap().port();
    let (accepted_in, broken_in) = (accepted.clone(), broken_below.clone());
    thread::spawn(move || {
        for client in listener.incoming().flatten() {
            let Ok(server) = TcpStream::connect(&upstream) else {
                continue;
            };
            let n = accepted_in.fetch_add(1, Ordering::SeqCst);
            let pump = |mut from: TcpStream, mut to: TcpStream, check: bool| {
                let broken = broken_in.clone();
                thread::spawn(move || {
                    let mut buf = [0u8; 16384];
                    while let Ok(read) = from.read(&mut buf) {
                        if read == 0 {
                            break;
                        }
                        if check && n < broken.load(Ordering::SeqCst) {
                            break;
                        }
                        if to.write_all(&buf[..read]).is_err() {
                            break;
                        }
                    }
                    let _ = from.shutdown(Shutdown::Both);
                    let _ = to.shutdown(Shutdown::Both);
                });
            };
            pump(
                client.try_clone().unwrap(),
                server.try_clone().unwrap(),
                true,
            );
            pump(server, client, false);
        }
    });
    let break_now = move || broken_below.store(accepted.load(Ordering::SeqCst), Ordering::SeqCst);
    (port, break_now)
}

/// A read whose parked session died unnoticed is sent again on a fresh
/// one when it calls only built-ins that compute (`count(*)`), never when
/// it calls any other function.
#[test]
fn postgres_a_read_on_a_dead_parked_session_is_retried() {
    let Ok(host) = std::env::var("ROWKERY_PG_HOST") else {
        eprintln!("skip postgres_a_read_on_a_dead_parked_session_is_retried (set ROWKERY_PG_HOST)");
        return;
    };
    let pg_port = std::env::var("ROWKERY_PG_PORT").unwrap_or_else(|_| "54329".into());
    let (port, break_now) = breaking_proxy(format!("{host}:{pg_port}"));
    let (_guard, _file, _path) = test_guard();
    let bridge = super::CoreBridge::spawn();
    save_pg_with(&bridge, "postgres-retry", Some(port), SafeMode::Off);
    bridge
        .open_window("w", "postgres-retry", None)
        .expect("open");
    let run = |sql: &str| window_query(&bridge, "w", 1, sql);
    let pid = || match run("SELECT pg_backend_pid()") {
        (Some(Value::Int(p)), None, ..) => p,
        other => panic!("pid: {other:?}"),
    };

    let first = pid();
    break_now();
    let (count, err, ..) = run("SELECT count(*) FROM generate_series(1, 3)");
    assert_eq!((count, err), (Some(Value::Int(3)), None), "retried");
    let second = pid();
    assert_ne!(second, first, "on a fresh session");

    break_now();
    let (_, err, ..) = run("SELECT pg_backend_pid()");
    assert!(err.is_some(), "another function: not sent again");
    assert_ne!(pid(), second);
    std::env::remove_var("ROWKERY_CONFIG_DIR");
}

/// What a quit would cut short: a tab's write while it runs, and a
/// transaction left open in a tab; nothing once both have ended.
#[test]
fn postgres_busy_work_counts_writes_and_open_transactions() {
    let (_guard, _file, _path) = test_guard();
    let bridge = super::CoreBridge::spawn();
    let id = "quitguard-busy";
    if save_pg_at(&bridge, id, None, SafeMode::Off).is_none() {
        eprintln!(
            "skip postgres_busy_work_counts_writes_and_open_transactions (set ROWKERY_PG_HOST)"
        );
        return;
    }
    bridge.open_window("w", id, None).expect("open");
    assert!(bridge.busy_work().is_idle());
    let queue = bridge
        .run_window_query(
            "w",
            1,
            "DO $$ BEGIN PERFORM pg_sleep(1); END $$".into(),
            None,
            false,
        )
        .expect("run");
    thread::sleep(Duration::from_millis(300));
    let busy = bridge.busy_work();
    assert_eq!(
        (busy.writes, busy.transactions),
        (1, 0),
        "the write is running, and opened no transaction"
    );
    let (error, _) = wait_query_finished(&queue, Duration::from_secs(10)).expect("done");
    assert_eq!(error, None);
    assert_eq!(bridge.busy_work().writes, 0);

    assert_eq!(window_query(&bridge, "w", 1, "BEGIN").1, None);
    let deadline = Instant::now() + Duration::from_secs(3);
    while bridge.busy_work().transactions != 1 {
        assert!(Instant::now() < deadline, "the open transaction counts");
        thread::sleep(Duration::from_millis(20));
    }
    assert!(bridge.busy_work().quit_warning().is_some());
    // A read running inside it still holds it.
    let queue = bridge
        .run_window_query("w", 1, "SELECT pg_sleep(1)".into(), None, false)
        .expect("run");
    thread::sleep(Duration::from_millis(300));
    assert_eq!(bridge.busy_work().transactions, 1, "a running tab counts");
    let (error, _) = wait_query_finished(&queue, Duration::from_secs(10)).expect("done");
    assert_eq!(error, None);
    assert_eq!(window_query(&bridge, "w", 1, "ROLLBACK").1, None);
    let deadline = Instant::now() + Duration::from_secs(3);
    while !bridge.busy_work().is_idle() {
        assert!(Instant::now() < deadline, "idle again");
        thread::sleep(Duration::from_millis(20));
    }
    std::env::remove_var("ROWKERY_CONFIG_DIR");
}

/// A proxy to `upstream` that, once its flag is set, drops every new
/// client at once: the server becomes unreachable for new sessions.
fn refusing_proxy(upstream: String) -> (u16, Arc<AtomicBool>) {
    use std::net::{Shutdown, TcpListener, TcpStream};
    let refuse = Arc::new(AtomicBool::new(false));
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let port = listener.local_addr().unwrap().port();
    let refusing = refuse.clone();
    thread::spawn(move || {
        for client in listener.incoming().flatten() {
            if refusing.load(Ordering::SeqCst) {
                drop(client);
                continue;
            }
            let Ok(server) = TcpStream::connect(&upstream) else {
                continue;
            };
            for (mut from, mut to) in [
                (client.try_clone().unwrap(), server.try_clone().unwrap()),
                (server, client),
            ] {
                thread::spawn(move || {
                    let _ = std::io::copy(&mut from, &mut to);
                    let _ = to.shutdown(Shutdown::Both);
                });
            }
        }
    });
    (port, refuse)
}

fn wait_idle(bridge: &super::CoreBridge, what: &str) {
    let deadline = Instant::now() + Duration::from_secs(5);
    loop {
        let work = bridge.busy_work();
        if work.is_idle() {
            return;
        }
        assert!(Instant::now() < deadline, "{what}: still busy {work:?}");
        thread::sleep(Duration::from_millis(20));
    }
}

/// Work that ends early stops counting, so a quit doesn't ask about it: a
/// cancelled write, and a commit, an import and a SQL file run that can't
/// reach the server.
#[test]
fn postgres_work_that_ends_early_stops_counting() {
    let Some(upstream) = pg_upstream() else {
        eprintln!("skip postgres_work_that_ends_early_stops_counting (set ROWKERY_PG_HOST)");
        return;
    };
    let (_guard, _file, _path) = test_guard();
    let (port, refuse) = refusing_proxy(upstream);
    let bridge = super::CoreBridge::spawn();
    let id = "quitguard-early";
    save_pg_at(&bridge, id, Some(port), SafeMode::Off).unwrap();
    bridge.open_window("w", id, None).expect("open");

    // Cancelled mid-run.
    let queue = bridge
        .run_window_query(
            "w",
            1,
            "DO $$ BEGIN PERFORM pg_sleep(30); END $$".into(),
            None,
            false,
        )
        .expect("run");
    let deadline = Instant::now() + Duration::from_secs(5);
    while bridge.busy_work().writes != 1 {
        assert!(Instant::now() < deadline, "the write counts");
        thread::sleep(Duration::from_millis(20));
    }
    bridge.cancel_window_query("w", 1);
    let (error, _) = wait_query_finished(&queue, Duration::from_secs(10)).expect("stopped");
    assert!(error.is_some(), "it was cancelled");
    wait_idle(&bridge, "after a cancel");

    // The server can't be reached: each fails, and none still counts.
    refuse.store(true, Ordering::SeqCst);
    let commit = bridge.apply_changes(
        "w",
        id,
        7,
        edit_table(
            "public",
            "it_nowhere",
            &[("id", "int4"), ("name", "text")],
            &["id"],
        ),
        vec![update(1, "name", Value::Text("x".into()))],
        None,
        None,
    );
    assert!(
        !matches!(commit, Ok(ApplyOutcome::Committed { .. })),
        "{commit:?}"
    );
    wait_idle(&bridge, "after an unreachable commit");

    let dir = tempfile::tempdir().unwrap();
    let csv = dir.path().join("rows.csv");
    fs::write(&csv, "id,name\n1,one\n").unwrap();
    let import = bridge.import_csv(
        "w",
        import_spec(&csv.to_string_lossy(), "public", &[(0, "id"), (1, "name")]),
        Arc::new(AtomicBool::new(false)),
        quiet(),
    );
    assert!(
        !matches!(import, Ok(ImportOutcome::Imported { .. })),
        "{import:?}"
    );
    wait_idle(&bridge, "after an unreachable import");

    let file = dir.path().join("f.sql");
    fs::write(&file, "CREATE TABLE it_nowhere_file(a int);\n").unwrap();
    let scan = rowkery_core::sql_file::scan(&file, EngineKind::Postgres, |_| true).unwrap();
    let run = bridge.run_sql_file(
        "w",
        file,
        scan,
        RunOptions {
            whole_file: true,
            keep_going: false,
        },
        true,
        ProgressSink(Box::new(|_| {})),
    );
    assert!(run.as_ref().map_or(true, |r| r.failed.is_some()), "{run:?}");
    wait_idle(&bridge, "after an unreachable SQL file");
    std::env::remove_var("ROWKERY_CONFIG_DIR");
}

/// A run whose worker goes away without a finish (a panic, an early return)
/// still ends: the guard's drop sends a failed finish, once.
#[test]
fn finish_guard_ends_a_run_whose_worker_vanished() {
    let queue: Arc<Mutex<Vec<CoreEvent>>> = Arc::default();
    let guard = finish_guard(queue.clone(), 7, 3);
    let worker = guard.clone();
    let _ = thread::spawn(move || {
        push_event(
            &worker,
            CoreEvent::QueryStarted {
                query_id: 7,
                tab_id: 3,
            },
        );
        panic!("worker panicked mid-run");
    })
    .join();
    drop(guard);
    let errors: Vec<_> = queue
        .lock()
        .unwrap()
        .iter()
        .filter_map(|e| match e {
            CoreEvent::QueryFinished {
                query_id: 7,
                tab_id: 3,
                error,
                cancelled: false,
                ..
            } => error.clone(),
            _ => None,
        })
        .collect();
    assert_eq!(errors, vec![RUN_LOST_MESSAGE.to_string()]);

    // A run that finished says nothing more when it goes.
    let queue: Arc<Mutex<Vec<CoreEvent>>> = Arc::default();
    let guard = finish_guard(queue.clone(), 8, 3);
    finish_query_worker(Ok(QueryOutcome::cancelled(0)), 8, 3, Instant::now(), &guard);
    drop(guard);
    assert_eq!(queue.lock().unwrap().len(), 1);
}

/// ⌘E keeps its own handle on the sink (and so on the sender it waits on):
/// a plan worker that dies still wakes it, with an error.
#[test]
fn explain_wait_ends_when_the_plan_worker_dies() {
    let (tx, rx) = mpsc::channel();
    let sink = Arc::new(ExplainSink {
        rows: Mutex::default(),
        done: Mutex::new(Some(tx)),
    });
    let guard = finish_guard(sink.clone(), 1, 1);
    let _ = thread::spawn(move || {
        let _held = guard;
        panic!("plan worker panicked");
    })
    .join();
    match rx.recv_timeout(Duration::from_secs(5)) {
        Ok(CoreEvent::QueryFinished { error: Some(e), .. }) => assert_eq!(e, RUN_LOST_MESSAGE),
        other => panic!("expected a failed finish, got {other:?}"),
    }
    drop(sink);
}

/// A tab's run that finds the tab's session still out with an earlier run
/// (one the webview gave up on) says it is waiting, so it never reads as a
/// hang, and runs once the session is back.
#[test]
fn postgres_a_run_behind_the_tabs_busy_session_says_it_waits() {
    let (_guard, _file, _path) = test_guard();
    let bridge = super::CoreBridge::spawn();
    let id = "postgres-busy-tab";
    if save_test_pg(&bridge, id).is_none() {
        eprintln!(
            "skip postgres_a_run_behind_the_tabs_busy_session_says_it_waits (set ROWKERY_PG_HOST)"
        );
        return;
    }
    bridge.open_window("w", id, None).expect("open");
    let first = bridge
        .run_window_query("w", 1, "SELECT pg_sleep(1)".into(), None, false)
        .expect("run");
    // Let the first run take the tab's session.
    let deadline = Instant::now() + Duration::from_secs(5);
    while !first
        .lock()
        .unwrap()
        .iter()
        .any(|e| matches!(e, CoreEvent::QueryStarted { .. }))
    {
        assert!(Instant::now() < deadline, "the first run started");
        thread::sleep(Duration::from_millis(5));
    }
    thread::sleep(Duration::from_millis(100));
    let second = bridge
        .run_window_query("w", 1, "SELECT 2::int8".into(), None, false)
        .expect("run");
    let deadline = Instant::now() + Duration::from_secs(10);
    let events = loop {
        let events = second.lock().unwrap().clone();
        if events
            .iter()
            .any(|e| matches!(e, CoreEvent::QueryFinished { .. }))
        {
            break events;
        }
        assert!(Instant::now() < deadline, "the second run ended");
        thread::sleep(Duration::from_millis(5));
    };
    let waits: Vec<(bool, bool)> = events
        .iter()
        .filter_map(|e| match e {
            CoreEvent::QueryWaiting { waiting, tab, .. } => Some((*waiting, *tab)),
            _ => None,
        })
        .collect();
    assert_eq!(
        waits,
        vec![(true, true), (false, false)],
        "said it waited for the tab's own session, then that it has one"
    );
    let error = events.iter().find_map(|e| match e {
        CoreEvent::QueryFinished { error, .. } => Some(error.clone()),
        _ => None,
    });
    assert_eq!(error, Some(None));
    std::env::remove_var("ROWKERY_CONFIG_DIR");
}

/// A deleted row's cascades and trigger writes stop the commit before
/// COMMIT with their counts; committing again with those counts saves it
/// all, and different counts stop it again.
#[test]
fn sqlite_apply_changes_stops_when_a_cascade_reaches_other_tables() {
    let (_guard, _file, path) = test_guard();
    Connection::open(&path)
        .expect("open")
        .execute_batch(
            "CREATE TABLE kiosks (id INTEGER PRIMARY KEY, name TEXT);
             CREATE TABLE kiosk_sessions (id INTEGER PRIMARY KEY,
               kiosk INTEGER REFERENCES kiosks ON DELETE CASCADE);
             CREATE TABLE audit_log (what TEXT);
             CREATE TRIGGER kiosk_gone AFTER DELETE ON kiosks BEGIN INSERT INTO audit_log VALUES ('kiosk'); END;
             INSERT INTO kiosks VALUES (1, 'a'), (2, 'b');
             INSERT INTO kiosk_sessions VALUES (1, 2), (2, 2), (3, 1);",
        )
        .expect("seed");
    let bridge = super::CoreBridge::spawn();
    CoreBridge::upsert_connection(
        &bridge,
        ConnectionRecord::Sqlite(SqliteConnection {
            allow_mcp: false,
            mcp_timeout_s: None,
            mcp_hidden_tables: Vec::new(),
            mcp_until: None,
            mcp_samples_off: false,
            mcp_access: None,
            masked_columns: Default::default(),
            environment: None,
            safe_mode: SafeMode::Off,
            id: "off".into(),
            name: "off".into(),
            path: path.clone(),
            sample: false,
        }),
        ConnectionSecrets::default(),
    )
    .expect("save");
    bridge.open_window("off", "off", None).expect("open");
    let kiosks = edit_table(
        "main",
        "kiosks",
        &[("id", "INTEGER"), ("name", "TEXT")],
        &["id"],
    );
    let count =
        |table: &str| window_query(&bridge, "off", 1, &format!("SELECT count(*) FROM {table}")).0;
    let apply = |changes: Vec<Change>, reach: Option<Reach>| {
        bridge
            .apply_changes("off", "off", 1, kiosks.clone(), changes, None, reach)
            .expect("apply")
    };

    // An edit to a name reaches nothing: it commits as before.
    let out = apply(vec![update(1, "name", Value::Text("A".into()))], None);
    assert!(matches!(out, ApplyOutcome::Committed { .. }), "{out:?}");

    let delete = || {
        vec![Change::Delete {
            key: vec![cell("id", Value::Int(2))],
        }]
    };
    let ApplyOutcome::RolledBack { failure, .. } = apply(delete(), None) else {
        panic!("a cascade stops the commit")
    };
    let reach = failure.reach.expect("the other tables' counts");
    let seen: Vec<(&str, u64, u64)> = reach
        .tables
        .iter()
        .map(|t| (t.table.as_str(), t.inserted, t.deleted))
        .collect();
    assert_eq!(seen, [("audit_log", 1, 0), ("kiosk_sessions", 0, 2)]);
    assert_eq!(
        count("kiosk_sessions"),
        Some(Value::Int(3)),
        "nothing saved"
    );

    // Another session joins the kiosk: the counts the user saw are stale.
    window_query(
        &bridge,
        "off",
        1,
        "INSERT INTO kiosk_sessions VALUES (4, 2)",
    );
    let ApplyOutcome::RolledBack { failure, .. } = apply(delete(), Some(reach)) else {
        panic!("different counts stop it again")
    };
    let reach = failure.reach.expect("the new counts");
    assert_eq!(reach.tables[1].deleted, 3);

    let out = apply(delete(), Some(reach));
    assert!(matches!(out, ApplyOutcome::Committed { .. }), "{out:?}");
    assert_eq!(count("kiosk_sessions"), Some(Value::Int(1)));
    assert_eq!(count("audit_log"), Some(Value::Int(1)));
}

#[test]
fn postgres_apply_changes_stops_when_a_cascade_reaches_other_tables() {
    let Ok(host) = std::env::var("ROWKERY_PG_HOST") else {
        eprintln!("skip postgres_apply_changes_stops_when_a_cascade_reaches_other_tables (set ROWKERY_PG_HOST)");
        return;
    };
    let (_guard, _file, _path) = test_guard();
    let bridge = super::CoreBridge::spawn();
    CoreBridge::upsert_connection(
        &bridge,
        ConnectionRecord::Postgres(PostgresConnection {
            allow_mcp: false,
            mcp_timeout_s: None,
            mcp_hidden_tables: Vec::new(),
            mcp_until: None,
            mcp_samples_off: false,
            mcp_access: None,
            masked_columns: Default::default(),
            environment: None,
            safe_mode: SafeMode::Off,
            id: "off".into(),
            name: "off".into(),
            host,
            port: std::env::var("ROWKERY_PG_PORT")
                .ok()
                .and_then(|p| p.parse().ok())
                .unwrap_or(54329),
            database: std::env::var("ROWKERY_PG_DB").unwrap_or_else(|_| "rowkery".into()),
            username: std::env::var("ROWKERY_PG_USER").unwrap_or_else(|_| "rowkery".into()),
            ssl_mode: PostgresSslMode::Disable,
            ssl_root_cert: None,
            ssh: None,
            cloud_sql: None,
        }),
        ConnectionSecrets {
            db_password: Some(
                std::env::var("ROWKERY_PG_PASSWORD").unwrap_or_else(|_| "rowkery".into()),
            ),
            ..Default::default()
        },
    )
    .expect("save");
    bridge.open_window("off", "off", None).expect("open");
    let run = |sql: &str| window_query(&bridge, "off", 1, sql);
    for sql in [
        "DROP TABLE IF EXISTS public.it_kiosks, public.it_sessions, public.it_payouts, public.it_audit, public.it_plain, public.it_parent CASCADE",
        "DROP FUNCTION IF EXISTS public.it_note() CASCADE",
        "CREATE TABLE public.it_kiosks (id int PRIMARY KEY, name text)",
        "CREATE TABLE public.it_sessions (id int PRIMARY KEY, kiosk int REFERENCES public.it_kiosks ON DELETE CASCADE)",
        "CREATE TABLE public.it_payouts (id int, kiosk int REFERENCES public.it_kiosks ON DELETE CASCADE) PARTITION BY RANGE (id)",
        "CREATE TABLE public.it_payouts_a PARTITION OF public.it_payouts FOR VALUES FROM (0) TO (100)",
        "CREATE TABLE public.it_payouts_b PARTITION OF public.it_payouts FOR VALUES FROM (100) TO (200)",
        "CREATE TABLE public.it_audit (what text)",
        "CREATE TABLE public.it_plain (id int PRIMARY KEY, name text)",
        "CREATE FUNCTION public.it_note() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN INSERT INTO public.it_audit VALUES (TG_OP); RETURN NULL; END $$",
        "CREATE CONSTRAINT TRIGGER it_late AFTER DELETE ON public.it_kiosks DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.it_note()",
        "INSERT INTO public.it_kiosks VALUES (1, 'a'), (2, 'b')",
        "INSERT INTO public.it_sessions SELECT g, 1 + g % 2 FROM generate_series(1, 6) g",
        "INSERT INTO public.it_payouts VALUES (5, 2), (150, 2), (6, 1)",
        "INSERT INTO public.it_plain VALUES (1, 'p')",
        "CREATE TABLE public.it_parent (id int PRIMARY KEY, name text)",
        "CREATE TABLE public.it_child () INHERITS (public.it_parent)",
        "CREATE TRIGGER it_child_note AFTER UPDATE ON public.it_child FOR EACH ROW EXECUTE FUNCTION public.it_note()",
        "INSERT INTO public.it_child VALUES (9, 'c')",
    ] {
        assert_eq!(run(sql).1, None, "{sql}");
    }
    let kiosks = edit_table(
        "public",
        "it_kiosks",
        &[("id", "integer"), ("name", "text")],
        &["id"],
    );
    let apply = |table: &EditTable, changes: Vec<Change>, reach: Option<Reach>| {
        bridge
            .apply_changes("off", "off", 1, table.clone(), changes, None, reach)
            .expect("apply")
    };
    // A table nothing cascades into, with no trigger, isn't counted at all.
    let plain = edit_table(
        "public",
        "it_plain",
        &[("id", "integer"), ("name", "text")],
        &["id"],
    );
    let out = apply(
        &plain,
        vec![update(1, "name", Value::Text("q".into()))],
        None,
    );
    assert!(matches!(out, ApplyOutcome::Committed { .. }), "{out:?}");
    // A row of an inheritance child, edited through the parent, fires the
    // child's trigger: counted, though the parent has none of its own.
    let parent = edit_table(
        "public",
        "it_parent",
        &[("id", "integer"), ("name", "text")],
        &["id"],
    );
    let ApplyOutcome::RolledBack { failure, .. } = apply(
        &parent,
        vec![update(9, "name", Value::Text("d".into()))],
        None,
    ) else {
        panic!("the child's trigger stops the commit")
    };
    let reach = failure.reach.expect("the child's trigger counted");
    assert!(
        reach
            .tables
            .iter()
            .any(|t| t.table == "it_audit" && t.inserted == 1),
        "{reach:?}"
    );
    // Renaming a kiosk writes nothing else.
    let out = apply(
        &kiosks,
        vec![update(1, "name", Value::Text("A".into()))],
        None,
    );
    assert!(matches!(out, ApplyOutcome::Committed { .. }), "{out:?}");

    let delete = || {
        vec![Change::Delete {
            key: vec![cell("id", Value::Int(2))],
        }]
    };
    let ApplyOutcome::RolledBack { failure, .. } = apply(&kiosks, delete(), None) else {
        panic!("a cascade stops the commit")
    };
    let reach = failure.reach.expect("the other tables' counts");
    let seen: Vec<(&str, u64, u64)> = reach
        .tables
        .iter()
        .map(|t| (t.table.as_str(), t.inserted, t.deleted))
        .collect();
    // Partitions count under their table; the deferred trigger fired first.
    assert_eq!(
        seen,
        [
            ("it_audit", 1, 0),
            ("it_payouts", 0, 2),
            ("it_sessions", 0, 3)
        ]
    );
    assert_eq!(
        run("SELECT count(*)::int FROM public.it_sessions").0,
        Some(Value::Int(6)),
        "nothing saved"
    );
    let out = apply(&kiosks, delete(), Some(reach));
    assert!(matches!(out, ApplyOutcome::Committed { .. }), "{out:?}");
    assert_eq!(
        run("SELECT count(*)::int FROM public.it_sessions").0,
        Some(Value::Int(3))
    );
    for sql in [
        "DROP TABLE public.it_sessions, public.it_payouts, public.it_audit, public.it_plain, public.it_kiosks, public.it_parent CASCADE",
        "DROP FUNCTION public.it_note()",
    ] {
        run(sql);
    }
}
