#![cfg(feature = "postgres-integration")]

use rowkery_core::connections::{PostgresConnection, PostgresSslMode};
use rowkery_core::db::postgres::{open_session, session_query_stream, session_test};
use rowkery_core::secrets::{store_secret, SecretKind};

/// The tests in this binary share `ROWKERY_CONFIG_DIR` and the secrets file
/// under it; run in parallel, one would read the file while another writes
/// it. Each test holds this for its whole run.
static ENV_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());

fn pg_config() -> PostgresConnection {
    let host = std::env::var("ROWKERY_PG_HOST").unwrap_or_else(|_| "127.0.0.1".into());
    let port = std::env::var("ROWKERY_PG_PORT")
        .ok()
        .and_then(|p| p.parse().ok())
        .unwrap_or(5432);
    let database = std::env::var("ROWKERY_PG_DB").unwrap_or_else(|_| "rowkery".into());
    let username = std::env::var("ROWKERY_PG_USER").unwrap_or_else(|_| "rowkery".into());
    PostgresConnection {
        id: "integration-pg".into(),
        name: "integration".into(),
        host,
        port,
        database,
        username,
        ssl_mode: PostgresSslMode::Disable,
        ssl_root_cert: None,
        ssh: None,
        cloud_sql: None,
        environment: None,
        safe_mode: Default::default(),
        allow_mcp: false,
        mcp_hidden_tables: Vec::new(),
        mcp_until: None,
        mcp_samples_off: false,
        mcp_timeout_s: None,
        mcp_access: None,
        masked_columns: Default::default(),
    }
}

#[tokio::test]
#[allow(clippy::await_holding_lock)]
async fn postgres_connect_and_select() {
    let _env = ENV_LOCK.lock().unwrap_or_else(|e| e.into_inner());
    let password = std::env::var("ROWKERY_PG_PASSWORD").unwrap_or_else(|_| "rowkery".into());
    std::env::set_var(
        "ROWKERY_CONFIG_DIR",
        std::env::temp_dir()
            .join(format!("rowkery-pg-it-{}", std::process::id()))
            .to_string_lossy()
            .to_string(),
    );
    store_secret("integration-pg", SecretKind::DbPassword, &password).expect("store password");

    let config = pg_config();
    let mut session = open_session(config.id.clone(), config)
        .await
        .expect("open session");
    session_test(&mut session).await.expect("test");

    let rows = session_query_stream(&session, "SELECT 1 AS one", |_batch, _| Ok(()))
        .await
        .expect("query");
    assert_eq!(rows, 1);
}

/// Types decoded from the binary wire format must match Postgres's own text output.
#[tokio::test]
#[allow(clippy::await_holding_lock)]
async fn postgres_decodes_dates_uuid_numeric() {
    let _env = ENV_LOCK.lock().unwrap_or_else(|e| e.into_inner());
    use rowkery_core::db::Value;

    let password = std::env::var("ROWKERY_PG_PASSWORD").unwrap_or_else(|_| "rowkery".into());
    std::env::set_var(
        "ROWKERY_CONFIG_DIR",
        std::env::temp_dir()
            .join(format!("rowkery-pg-it-decode-{}", std::process::id()))
            .to_string_lossy()
            .to_string(),
    );
    store_secret("integration-pg", SecretKind::DbPassword, &password).expect("store password");
    let config = pg_config();
    let session = open_session(config.id.clone(), config)
        .await
        .expect("open session");

    let cases = [
        "'2026-09-26 14:43:23.12'::timestamp",
        "'1969-07-20 20:17:40'::timestamp",
        "'infinity'::timestamp",
        "'2026-09-26'::date",
        "'1899-12-31'::date",
        "'14:43:23.000501'::time",
        "'200ea567-baf1-4c2e-9d3a-0123456789ab'::uuid",
        "12345.678::numeric",
        "-0.0005::numeric",
        "10000::numeric",
        "0.00::numeric(10,2)",
        "123456789012345678901234567890.5::numeric",
        "'NaN'::numeric",
        "(-7)::int2",
        "1.5::float4",
        // Every digit survives: no trip through an f64.
        r#"'{"id": 9007199254740993, "amount": 0.1000000000000000055}'::jsonb"#,
        r#"'{"id":9007199254740993,  "amount":0.1000000000000000055}'::json"#,
        "'<a b=\"1\">x</a>'::xml",
        r#"ARRAY['{"a": 1}', '{"b": [2, "c d"]}']::jsonb[]"#,
        r#"ARRAY['{"a":1}']::json[]"#,
        // Shown as Postgres writes them, not as `<interval>`.
        "'1 year 2 mons -3 days 04:05:06.5'::interval",
        "'-1 day'::interval",
        "'-04:00:00'::interval",
        "'1 day -00:00:01'::interval",
        "'0'::interval",
        "'100 hours 0.000001 sec'::interval",
        "'-1 mon'::interval",
        "'-2 years -3 mons'::interval",
        "ARRAY['1 day', '2 hours']::interval[]",
        "'::ffff:1.2.3.4'::inet",
        "'::1.2.3.4'::inet",
        "'::1'::inet",
        "'::'::inet",
        "'::0.0.0.2'::inet",
        "'2001:db8::1/64'::inet",
        "'fe80::1:2:3:4'::inet",
        "'1:0:0:1:0:0:0:1'::inet",
        "'0:0:1::'::inet",
        "'1:2:3:4:5:6:7:8'::inet",
        "'192.168.1.5'::inet",
        "'192.168.1.5/24'::inet",
        "'10.0.0.0/8'::cidr",
        "'2001:db8::/32'::cidr",
        "ARRAY['10.0.0.1', '::1']::inet[]",
        "'-1234.5'::money",
        "'1234567.891'::money",
        "'0'::money",
        "ARRAY['1234.5']::money[]",
        "'08:00:2b:01:02:03'::macaddr",
        "'08:00:2b:01:02:03:04:05'::macaddr8",
        "B'0101'::bit(4)",
        "B'101100111'::varbit",
        "B''::varbit",
        "'12:00:00+05:30'::timetz",
        "'01:02:03.5-08'::timetz",
        "'00:00:00+00'::timetz",
        "'a'::\"char\"",
        "''::\"char\"",
        "ARRAY['a', 'b']::\"char\"[]",
    ];
    for expr in cases {
        // format('%s') writes the type's own output, as psql shows it
        // (`::text` on an inet always adds its prefix).
        let sql = format!("SELECT {expr} AS v, format('%s', {expr}) AS t");
        let mut got = None;
        session_query_stream(&session, &sql, |batch, _| {
            got = batch.rows.into_iter().next();
            Ok(())
        })
        .await
        .expect("query");
        let row = got.expect("row");
        let Value::Text(expected) = &row[1] else {
            panic!("text column for {expr}: {:?}", row[1]);
        };
        let actual = match &row[0] {
            Value::Text(s) => s.clone(),
            Value::Int(n) => n.to_string(),
            Value::Float(f) => f.to_string(),
            other => panic!("{expr}: unexpected {other:?}"),
        };
        assert_eq!(&actual, expected, "{expr}");
    }

    let mut got = None;
    session_query_stream(
        &session,
        "SELECT '2026-09-26 14:43:23+00'::timestamptz AS v, NULL::timestamptz AS n",
        |batch, _| {
            got = batch.rows.into_iter().next();
            Ok(())
        },
    )
    .await
    .expect("query");
    let row = got.expect("row");
    assert_eq!(row[0], Value::Text("2026-09-26 14:43:23+00".into()));
    assert_eq!(row[1], Value::Null);
}

/// int8 at the edges of its range reaches the webview exact: as a BigInt
/// string past ±(2^53 − 1), a plain number inside it; numeric stays text.
#[tokio::test]
#[allow(clippy::await_holding_lock)]
async fn postgres_int8_extremes_travel_exact() {
    let _env = ENV_LOCK.lock().unwrap_or_else(|e| e.into_inner());
    let password = std::env::var("ROWKERY_PG_PASSWORD").unwrap_or_else(|_| "rowkery".into());
    std::env::set_var(
        "ROWKERY_CONFIG_DIR",
        std::env::temp_dir()
            .join(format!("rowkery-pg-it-int8-{}", std::process::id()))
            .to_string_lossy()
            .to_string(),
    );
    store_secret("integration-pg", SecretKind::DbPassword, &password).expect("store password");
    let config = pg_config();
    let session = open_session(config.id.clone(), config)
        .await
        .expect("open session");
    let mut got = None;
    session_query_stream(
        &session,
        "SELECT 9223372036854775807::int8, (-9223372036854775807 - 1)::int8, \
         9007199254740993::int8, 9007199254740991::int8, 42::int8, \
         99999999999999999999.5::numeric",
        |batch, _| {
            got = batch.rows.into_iter().next();
            Ok(())
        },
    )
    .await
    .expect("query");
    let json = serde_json::to_string(&got.expect("row")).unwrap();
    assert_eq!(
        json,
        r#"[{"BigInt":"9223372036854775807"},{"BigInt":"-9223372036854775808"},{"BigInt":"9007199254740993"},{"Int":9007199254740991},{"Int":42},{"Text":"99999999999999999999.5"}]"#
    );
}

/// A refused statement keeps its SQLSTATE and position; a slow stream sends
/// its first rows before the batch fills, and times its first row.
#[tokio::test]
#[allow(clippy::await_holding_lock)]
async fn postgres_errors_and_slow_streams() {
    let _env = ENV_LOCK.lock().unwrap_or_else(|e| e.into_inner());
    use rowkery_core::db::postgres::{session_query_stream_with, StreamOptions};
    use rowkery_core::db::DriverError;

    let password = std::env::var("ROWKERY_PG_PASSWORD").unwrap_or_else(|_| "rowkery".into());
    std::env::set_var(
        "ROWKERY_CONFIG_DIR",
        std::env::temp_dir()
            .join(format!("rowkery-pg-it-stream-{}", std::process::id()))
            .to_string_lossy()
            .to_string(),
    );
    store_secret("integration-pg", SecretKind::DbPassword, &password).expect("store password");
    let config = pg_config();
    let session = open_session(config.id.clone(), config)
        .await
        .expect("open session");

    let err = session_query_stream(&session, "SELECT id FROM no_such_table", |_, _| Ok(()))
        .await
        .expect_err("missing table");
    match err {
        DriverError::Server {
            sqlstate,
            position,
            message,
            ..
        } => {
            assert_eq!(sqlstate, "42P01");
            assert_eq!(position, Some(16));
            assert!(message.contains("no_such_table"), "{message}");
        }
        other => panic!("expected a server error, got {other:?}"),
    }

    // DETAIL and HINT come along, as psql prints them (rowkery/reports#43).
    let err = session_query_stream(&session, "SELECT 1 + 'a'::text", |_, _| Ok(()))
        .await
        .expect_err("no such operator");
    let DriverError::Server { detail, .. } = &err else {
        panic!("expected a server error, got {err:?}")
    };
    assert!(
        detail.as_deref().is_some_and(|d| d.starts_with("HINT:  ")),
        "{detail:?}"
    );
    let full = err.into_full_message();
    assert!(
        full.starts_with("operator does not exist") && full.contains("\nHINT:  "),
        "{full}"
    );
    session_query_stream(
        &session,
        "CREATE TEMP TABLE it_detail (id int PRIMARY KEY)",
        |_, _| Ok(()),
    )
    .await
    .expect("temp table");
    let err = session_query_stream(&session, "INSERT INTO it_detail VALUES (1), (1)", |_, _| {
        Ok(())
    })
    .await
    .expect_err("duplicate key");
    let DriverError::Server { detail, .. } = &err else {
        panic!("expected a server error, got {err:?}")
    };
    assert_eq!(
        detail.as_deref(),
        Some("DETAIL:  Key (id)=(1) already exists.")
    );

    // Five rows 60 ms apart: the first batch can't wait for 200 rows. Each row
    // is over 8 KB because Postgres only flushes its output buffer when it fills
    // (or the statement ends), so smaller rows arrive together anyway.
    let mut batches = Vec::new();
    let stats = session_query_stream_with(
        &session,
        "SELECT g, repeat('x', 9000), pg_sleep(0.06) FROM generate_series(1, 5) g",
        StreamOptions::default(),
        |batch, _| {
            batches.push(batch.rows.len());
            Ok(())
        },
    )
    .await
    .expect("query");
    assert_eq!(stats.rows, 5);
    assert!(
        batches.len() > 1,
        "first rows should not wait for the rest: {batches:?}"
    );
    let first = stats.first_row.expect("first row").as_millis();
    assert!((40..250).contains(&first), "first row at {first} ms");
}

/// Structure view data: defaults, primary/unique indexes, access method and foreign keys;
/// completion data: enums, functions, search path.
#[tokio::test]
#[allow(clippy::await_holding_lock)]
async fn postgres_introspects_structure() {
    let _env = ENV_LOCK.lock().unwrap_or_else(|e| e.into_inner());
    use rowkery_core::db::postgres::{session_introspect, session_table_indexes};
    use rowkery_core::db::{RowEstimate, TableKind};

    let password = std::env::var("ROWKERY_PG_PASSWORD").unwrap_or_else(|_| "rowkery".into());
    std::env::set_var(
        "ROWKERY_CONFIG_DIR",
        std::env::temp_dir()
            .join(format!("rowkery-pg-it-structure-{}", std::process::id()))
            .to_string_lossy()
            .to_string(),
    );
    store_secret("integration-pg", SecretKind::DbPassword, &password).expect("store password");
    let config = pg_config();
    let session = open_session(config.id.clone(), config)
        .await
        .expect("open session");

    let setup = r"
        DROP SCHEMA IF EXISTS it_structure CASCADE;
        DROP FOREIGN DATA WRAPPER IF EXISTS it_structure_fdw CASCADE;
        CREATE SCHEMA it_structure;
        CREATE FOREIGN DATA WRAPPER it_structure_fdw;
        CREATE SERVER it_structure_srv FOREIGN DATA WRAPPER it_structure_fdw;
        CREATE FOREIGN TABLE it_structure.remote_scores (id int, score int) SERVER it_structure_srv;
        CREATE TABLE it_structure.players (
            id bigserial PRIMARY KEY,
            handle text NOT NULL UNIQUE,
            region text NOT NULL DEFAULT 'sg'
        );
        CREATE TABLE it_structure.wallets (
            id bigserial PRIMARY KEY,
            player_id bigint NOT NULL REFERENCES it_structure.players(id) ON DELETE CASCADE,
            tags text[]
        );
        CREATE INDEX wallets_tags_gin ON it_structure.wallets USING gin (tags);
        CREATE TABLE it_structure.events (
            id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
            seq int GENERATED BY DEFAULT AS IDENTITY,
            label text
        );
        CREATE VIEW it_structure.sg_players AS SELECT id, handle FROM it_structure.players WHERE region = 'sg';
        CREATE MATERIALIZED VIEW it_structure.wallet_counts AS SELECT player_id, count(*) AS n FROM it_structure.wallets GROUP BY player_id;
        CREATE TYPE it_structure.wallet_state AS ENUM ('open', 'frozen', 'closed');
        CREATE FUNCTION it_structure.wallet_total(p bigint) RETURNS bigint LANGUAGE sql AS 'SELECT p';
        COMMENT ON TABLE it_structure.wallets IS 'One wallet per player.
Balances live in wallet_counts.';
        COMMENT ON COLUMN it_structure.wallets.player_id IS 'The player this wallet belongs to.'
    ";
    for stmt in setup.split(';').filter(|s| !s.trim().is_empty()) {
        session_query_stream(&session, stmt, |_b, _| Ok(()))
            .await
            .expect("setup");
    }

    let catalog = session_introspect(&session).await.expect("introspect");
    let schema = catalog.databases[0]
        .schemas
        .iter()
        .find(|s| s.name == "it_structure")
        .expect("schema");
    let players = schema.tables.iter().find(|t| t.name == "players").unwrap();
    let wallets = schema.tables.iter().find(|t| t.name == "wallets").unwrap();

    // Identity columns fill themselves: they read as a default (⌘I starts after them).
    let events = schema.tables.iter().find(|t| t.name == "events").unwrap();
    let default_of = |name: &str| {
        events
            .columns
            .iter()
            .find(|c| c.name == name)
            .unwrap()
            .default
            .clone()
    };
    assert_eq!(
        default_of("id").as_deref(),
        Some("generated always as identity")
    );
    assert_eq!(
        default_of("seq").as_deref(),
        Some("generated by default as identity")
    );
    assert_eq!(default_of("label"), None);

    // COMMENT ON TABLE / COLUMN, whole (the UI shows the first line).
    assert_eq!(
        wallets.comment.as_deref(),
        Some("One wallet per player.\nBalances live in wallet_counts.")
    );
    assert!(players.comment.is_none());
    let player_id = wallets
        .columns
        .iter()
        .find(|c| c.name == "player_id")
        .unwrap();
    assert_eq!(
        player_id.comment.as_deref(),
        Some("The player this wallet belongs to.")
    );
    assert!(wallets
        .columns
        .iter()
        .find(|c| c.name == "tags")
        .unwrap()
        .comment
        .is_none());

    let region = players.columns.iter().find(|c| c.name == "region").unwrap();
    assert_eq!(region.default.as_deref(), Some("'sg'::text"));
    assert!(players.table_bytes.is_some());

    assert_eq!(players.primary_key, vec!["id"]);
    // Index details are fetched per table when Structure opens.
    assert!(players.indexes_deferred && players.indexes.is_empty());
    let details = session_table_indexes(
        &session,
        "it_structure",
        &["players".to_string(), "wallets".to_string()],
    )
    .await
    .expect("table indexes");
    let (players_ix, wallets_ix) = (&details[0], &details[1]);
    assert_eq!(players_ix.table, "players");
    assert!(players_ix.index_bytes.is_some());

    let pkey = players_ix.indexes.iter().find(|i| i.primary).expect("pkey");
    assert_eq!(pkey.columns, vec!["id"]);
    assert_eq!(pkey.method.as_deref(), Some("btree"));
    assert!(players_ix
        .indexes
        .iter()
        .any(|i| i.unique && !i.primary && i.columns == vec!["handle"]));

    let gin = wallets_ix
        .indexes
        .iter()
        .find(|i| i.name == "wallets_tags_gin")
        .unwrap();
    assert_eq!(gin.method.as_deref(), Some("gin"));

    assert_eq!(wallets.foreign_keys.len(), 1);
    let fk = &wallets.foreign_keys[0];
    assert_eq!(fk.columns, vec!["player_id"]);
    assert_eq!(fk.ref_schema, "it_structure");
    assert_eq!(fk.ref_table, "players");
    assert_eq!(fk.ref_columns, vec!["id"]);
    assert_eq!(fk.on_delete, "CASCADE");

    let state = catalog
        .enums
        .iter()
        .find(|e| e.schema == "it_structure" && e.name == "wallet_state")
        .expect("enum");
    assert_eq!(state.labels, vec!["open", "frozen", "closed"]);
    let total = catalog
        .functions
        .iter()
        .find(|f| f.schema == "it_structure" && f.name == "wallet_total")
        .expect("function");
    assert_eq!(total.args, "p bigint");
    assert_eq!(total.returns, "bigint");
    assert!(catalog.search_path.iter().any(|s| s == "public"));

    assert_eq!(players.kind, TableKind::Table);
    let view = schema
        .tables
        .iter()
        .find(|t| t.name == "sg_players")
        .unwrap();
    assert_eq!(view.kind, TableKind::View);
    let view_cols: Vec<_> = view.columns.iter().map(|c| c.name.as_str()).collect();
    assert_eq!(view_cols, vec!["id", "handle"]);
    assert_eq!(view.row_estimate, RowEstimate::Unknown);
    assert!(view.table_bytes.is_none());
    let matview = schema
        .tables
        .iter()
        .find(|t| t.name == "wallet_counts")
        .unwrap();
    assert_eq!(matview.kind, TableKind::MaterializedView);
    assert_eq!(matview.columns.len(), 2);
    let foreign = schema
        .tables
        .iter()
        .find(|t| t.name == "remote_scores")
        .expect("foreign table");
    assert_eq!(foreign.kind, TableKind::ForeignTable);
    assert_eq!(foreign.columns.len(), 2);
    assert!(foreign.table_bytes.is_none());
    assert!(!foreign.indexes_deferred);

    for cleanup in [
        "DROP SCHEMA it_structure CASCADE",
        "DROP FOREIGN DATA WRAPPER it_structure_fdw CASCADE",
    ] {
        session_query_stream(&session, cleanup, |_b, _| Ok(()))
            .await
            .expect("cleanup");
    }
}

/// Read-only connections are read-only at the server: a write the text check
/// can't see (here sent straight to the session) still fails.
#[tokio::test]
#[allow(clippy::await_holding_lock)]
async fn postgres_read_only_session_refuses_writes() {
    let _env = ENV_LOCK.lock().unwrap_or_else(|e| e.into_inner());
    use rowkery_core::safety::SafeMode;

    let password = std::env::var("ROWKERY_PG_PASSWORD").unwrap_or_else(|_| "rowkery".into());
    std::env::set_var(
        "ROWKERY_CONFIG_DIR",
        std::env::temp_dir()
            .join(format!("rowkery-pg-it-ro-{}", std::process::id()))
            .to_string_lossy()
            .to_string(),
    );
    store_secret("integration-pg", SecretKind::DbPassword, &password).expect("store password");
    let mut config = pg_config();
    config.safe_mode = SafeMode::ReadOnly;
    let session = open_session(config.id.clone(), config)
        .await
        .expect("open session");
    let err = session_query_stream(
        &session,
        "CREATE TEMP TABLE rowkery_ro_probe AS SELECT 1 AS one",
        |_, _| Ok(()),
    )
    .await
    .expect_err("read-only session");
    assert!(err.to_string().contains("read-only transaction"), "{err}");
    let rows = session_query_stream(&session, "SELECT 1", |_, _| Ok(()))
        .await
        .expect("reads still run");
    assert_eq!(rows, 1);
}

/// Sessions through one SSH tunnel: the second reuses the first's tunnel.
#[tokio::test]
#[allow(clippy::await_holding_lock)]
async fn postgres_sessions_share_an_ssh_tunnel() {
    let _env = ENV_LOCK.lock().unwrap_or_else(|e| e.into_inner());
    use rowkery_core::connections::{SshAuthMethod, SshConfig};
    use rowkery_core::db::postgres::open_session_via;
    use rowkery_core::ssh::OPEN_TUNNELS;
    use std::sync::atomic::Ordering;
    let Ok(ssh_host) = std::env::var("ROWKERY_SSH_HOST") else {
        eprintln!("skip (set ROWKERY_SSH_HOST)");
        return;
    };
    let password = std::env::var("ROWKERY_PG_PASSWORD").unwrap_or_else(|_| "rowkery".into());
    std::env::set_var(
        "ROWKERY_CONFIG_DIR",
        std::env::temp_dir()
            .join(format!("rowkery-pg-it-ssh-{}", std::process::id()))
            .to_string_lossy()
            .to_string(),
    );
    store_secret("integration-pg", SecretKind::DbPassword, &password).expect("store password");
    store_secret("integration-pg", SecretKind::SshPassword, "rowkeryssh").expect("store ssh");
    let mut config = pg_config();
    config.host = "127.0.0.1".into();
    config.ssh = Some(SshConfig {
        host: ssh_host,
        port: 2222,
        username: "rowkery".into(),
        auth_method: SshAuthMethod::Password,
        private_key_path: None,
        trust_host: true,
    });
    let before = OPEN_TUNNELS.load(Ordering::Relaxed);
    let a = tokio::time::timeout(
        std::time::Duration::from_secs(20),
        open_session_via(config.id.clone(), config.clone(), None, None),
    )
    .await
    .expect("first session in time")
    .expect("first session");
    let b = tokio::time::timeout(
        std::time::Duration::from_secs(20),
        open_session_via(config.id.clone(), config.clone(), None, a.route()),
    )
    .await
    .expect("second session in time")
    .expect("second session");
    assert_eq!(OPEN_TUNNELS.load(Ordering::Relaxed) - before, 1);
    let n = session_query_stream(&b, "SELECT 1", |_, _| Ok(()))
        .await
        .expect("query b");
    assert_eq!(n, 1);
    let n = session_query_stream(&a, "SELECT 1", |_, _| Ok(()))
        .await
        .expect("query a");
    assert_eq!(n, 1);
    drop((a, b));
}

/// Keyset pages over Postgres types that travel as text (timestamptz,
/// numeric, uuid), NULLs and mixed directions return what one ordered query
/// does.
#[tokio::test]
#[allow(clippy::await_holding_lock)]
async fn postgres_keyset_pages_match_one_ordered_query() {
    let _env = ENV_LOCK.lock().unwrap_or_else(|e| e.into_inner());
    use rowkery_core::db::{table_browse_query, BrowseOptions, BrowseOrder, EngineKind, Value};
    use std::collections::HashMap;

    let password = std::env::var("ROWKERY_PG_PASSWORD").unwrap_or_else(|_| "rowkery".into());
    std::env::set_var(
        "ROWKERY_CONFIG_DIR",
        std::env::temp_dir()
            .join(format!("rowkery-pg-it-{}", std::process::id()))
            .to_string_lossy()
            .to_string(),
    );
    store_secret("integration-pg", SecretKind::DbPassword, &password).expect("store password");
    let config = pg_config();
    let session = open_session(config.id.clone(), config)
        .await
        .expect("open session");
    let rows = |sql: String| {
        let session = &session;
        async move {
            let mut names = Vec::new();
            let mut out: Vec<Vec<Value>> = Vec::new();
            session_query_stream(session, &sql, |b, _| {
                names = b.columns.iter().map(|c| c.name.clone()).collect();
                out.extend(b.rows);
                Ok(())
            })
            .await
            .unwrap_or_else(|e| panic!("{sql}: {e}"));
            (names, out)
        }
    };
    rows("DROP TABLE IF EXISTS pg_temp.keyset_t".into()).await;
    rows("CREATE TEMP TABLE keyset_t (id bigint PRIMARY KEY, at timestamptz, amount numeric(12,3), ref uuid, label text)".into()).await;
    rows(
        "INSERT INTO keyset_t SELECT i,
            CASE WHEN i % 6 = 0 THEN NULL ELSE timestamptz '2024-01-01 00:00:00.123456+00' + (i % 4) * interval '1 hour' END,
            CASE WHEN i % 5 = 0 THEN NULL ELSE (i % 3) * 1.125 END,
            md5((i % 2)::text)::uuid,
            CASE WHEN i % 7 = 0 THEN NULL ELSE 'l' || (i % 3) END
          FROM generate_series(1, 83) i"
            .into(),
    )
    .await;
    let o = |column: &str, desc: bool| BrowseOrder {
        column: column.into(),
        desc,
    };
    for order in [
        vec![],
        vec![o("at", true)],
        vec![o("amount", false), o("label", true)],
        vec![o("ref", false), o("at", false), o("amount", true)],
    ] {
        let base = BrowseOptions {
            order: order.clone(),
            key: vec!["id".into()],
            ..BrowseOptions::first_page(0)
        };
        let (_, all) = rows(table_browse_query(
            EngineKind::Postgres,
            "pg_temp",
            "keyset_t",
            &base,
        ))
        .await;
        let mut paged: Vec<Vec<Value>> = Vec::new();
        let mut after = None;
        loop {
            let opts = BrowseOptions {
                limit: 5,
                offset: paged.len() as u32,
                after: after.clone(),
                ..base.clone()
            };
            let sql = table_browse_query(EngineKind::Postgres, "pg_temp", "keyset_t", &opts);
            assert!(!sql.contains("OFFSET"), "{sql}");
            let (names, page) = rows(sql).await;
            let n = page.len();
            if let Some(last) = page.last() {
                after = Some(
                    names
                        .iter()
                        .cloned()
                        .zip(last.iter().cloned())
                        .collect::<HashMap<_, _>>(),
                );
            }
            paged.extend(page);
            if n < 5 {
                break;
            }
        }
        assert_eq!(paged.len(), 83);
        assert_eq!(paged, all, "order {order:?}");
    }
}

/// A long-lived process (the MCP server) read the password before the app
/// saved a new one: the rejected login reads it again and connects. With
/// nothing saved at all, the error says so instead of "rejected password".
#[tokio::test]
#[allow(clippy::await_holding_lock)]
async fn postgres_rereads_a_password_saved_since() {
    let _env = ENV_LOCK.lock().unwrap_or_else(|e| e.into_inner());
    let password = std::env::var("ROWKERY_PG_PASSWORD").unwrap_or_else(|_| "rowkery".into());
    let base = std::env::temp_dir().join(format!("rowkery-pg-reread-{}", std::process::id()));
    let (app, mcp) = (base.join("app"), base.join("mcp"));
    let _ = std::fs::remove_dir_all(&base);
    let config = PostgresConnection {
        id: "reread-pg".into(),
        ..pg_config()
    };

    // What another process saved: the right password.
    std::env::set_var("ROWKERY_CONFIG_DIR", &app);
    store_secret("reread-pg", SecretKind::DbPassword, &password).expect("store");
    // This process still remembers an old one.
    std::env::set_var("ROWKERY_CONFIG_DIR", &mcp);
    store_secret("reread-pg", SecretKind::DbPassword, "old-password").expect("store old");
    for file in ["secrets.enc", "secrets.key"] {
        std::fs::copy(app.join(file), mcp.join(file)).expect("copy");
    }
    let mut session = open_session(config.id.clone(), config.clone())
        .await
        .expect("connects with the password saved since");
    session_test(&mut session).await.expect("test");

    let empty = PostgresConnection {
        id: "never-saved-pg".into(),
        ..pg_config()
    };
    let err = open_session(empty.id.clone(), empty)
        .await
        .err()
        .expect("no password saved");
    assert!(err.to_string().contains("none is saved"), "{err}");
}

#[tokio::test]
#[allow(clippy::await_holding_lock)]
async fn postgres_health_finds_each_problem_and_its_fix_clears_it() {
    let _env = ENV_LOCK.lock().unwrap_or_else(|e| e.into_inner());
    use rowkery_core::db::postgres::session_health;
    use rowkery_core::health::{CheckKind, CheckState, Detail, SlowQueries};

    let password = std::env::var("ROWKERY_PG_PASSWORD").unwrap_or_else(|_| "rowkery".into());
    std::env::set_var(
        "ROWKERY_CONFIG_DIR",
        std::env::temp_dir()
            .join(format!("rowkery-pg-it-health-{}", std::process::id()))
            .to_string_lossy()
            .to_string(),
    );
    store_secret("integration-pg", SecretKind::DbPassword, &password).expect("store password");
    let config = pg_config();
    let session = open_session(config.id.clone(), config)
        .await
        .expect("open session");
    let run = async |sql: &str| {
        for stmt in sql.split(';').filter(|s| !s.trim().is_empty()) {
            session_query_stream(&session, stmt, |_b, _| Ok(()))
                .await
                .unwrap_or_else(|e| panic!("{stmt}: {e}"));
        }
    };
    run(r"
        DROP SCHEMA IF EXISTS it_health CASCADE;
        CREATE SCHEMA it_health;
        CREATE TABLE it_health.ids (id serial PRIMARY KEY);
        SELECT setval('it_health.ids_id_seq', 2000000000);
        CREATE TABLE it_health.dup (a int, b int);
        CREATE INDEX dup_a ON it_health.dup (a);
        CREATE INDEX dup_ab ON it_health.dup (a, b);
        CREATE UNIQUE INDEX dup_a_unique ON it_health.dup (a);
        CREATE INDEX dup_b1 ON it_health.dup (b);
        CREATE INDEX dup_b2 ON it_health.dup (b);
        CREATE INDEX dup_b_desc ON it_health.dup (b DESC);
        CREATE TABLE it_health.parent (id int PRIMARY KEY);
        INSERT INTO it_health.parent VALUES (1);
        CREATE TABLE it_health.child (id serial PRIMARY KEY,
            parent_id int REFERENCES it_health.parent (id));
        INSERT INTO it_health.child (parent_id) SELECT 1 FROM generate_series(1, 20000);
        CREATE TABLE it_health.indexed_child (id serial PRIMARY KEY,
            parent_id int REFERENCES it_health.parent (id));
        CREATE INDEX ON it_health.indexed_child (parent_id, id);
        INSERT INTO it_health.indexed_child (parent_id) SELECT 1 FROM generate_series(1, 20000);
        ANALYZE it_health.child;
        ANALYZE it_health.indexed_child;
        CREATE TABLE it_health.brin_child (id serial PRIMARY KEY,
            parent_id int REFERENCES it_health.parent (id));
        CREATE INDEX ON it_health.brin_child USING brin (parent_id);
        INSERT INTO it_health.brin_child (parent_id) SELECT 1 FROM generate_series(1, 20000);
        ANALYZE it_health.brin_child;
        CREATE TABLE it_health.part (id int, x int) PARTITION BY RANGE (id);
        CREATE TABLE it_health.part_1 PARTITION OF it_health.part FOR VALUES FROM (0) TO (100);
        CREATE INDEX part_x ON it_health.part (x);
        CREATE INDEX part_x_id ON it_health.part (x, id);
        CREATE TABLE it_health.dead (id int) WITH (autovacuum_enabled = false);
        INSERT INTO it_health.dead SELECT generate_series(1, 20000);
        ANALYZE it_health.dead;
        DELETE FROM it_health.dead WHERE id % 2 = 0;
        CREATE TABLE it_health.fresh (id int) WITH (autovacuum_enabled = false);
        INSERT INTO it_health.fresh SELECT generate_series(1, 20000);
        CREATE TABLE it_health.big (id int, n int) WITH (autovacuum_enabled = false);
        INSERT INTO it_health.big SELECT g, g FROM generate_series(1, 700000) g;
        CREATE INDEX big_n ON it_health.big (n);
        ANALYZE it_health.big;
        SELECT pg_stat_force_next_flush();
        SELECT 1
    ")
    .await;

    let report = session_health(&session).await.expect("health");
    assert!(report.server.starts_with("Postgres "), "{}", report.server);
    assert!(report.size.as_ref().is_some_and(|s| s.total_bytes > 0));
    assert!(report.connections.as_ref().is_some_and(|c| c.max > 0));
    assert!(report.transaction_age.is_some_and(|a| a < 0.5));
    // The CI server doesn't load pg_stat_statements; a local one may.
    assert!(
        matches!(
            report.slow_queries,
            SlowQueries::Off { .. } | SlowQueries::Ranked { partial: false, .. }
        ),
        "{:?}",
        report.slow_queries
    );
    let ours = |kind: CheckKind| -> Vec<rowkery_core::health::HealthItem> {
        let check = report
            .checks
            .iter()
            .find(|c| c.check == kind)
            .unwrap_or_else(|| panic!("{kind:?} missing"));
        assert!(
            matches!(check.state, CheckState::Fine | CheckState::Found { .. }),
            "{kind:?}: {:?}",
            check.state
        );
        check
            .items()
            .iter()
            .filter(|i| i.schema.as_deref() == Some("it_health"))
            .cloned()
            .collect()
    };
    let names = |kind: CheckKind| -> Vec<String> {
        ours(kind)
            .iter()
            .map(|i| i.name.clone().or(i.table.clone()).unwrap_or_default())
            .collect()
    };

    let ids = ours(CheckKind::IdsRunningOut);
    assert_eq!(ids.len(), 1, "{ids:?}");
    assert!(matches!(
        ids[0].detail,
        Detail::IdsRunningOut {
            used: 2_000_000_000,
            max: 2_147_483_647,
            ..
        }
    ));
    let mut dups = ours(CheckKind::DuplicateIndexes);
    dups.sort_by(|a, b| a.name.cmp(&b.name));
    let dup_pairs: Vec<(String, String)> = dups
        .iter()
        .map(|i| match &i.detail {
            Detail::DuplicateIndex { covered_by } => (i.name.clone().unwrap(), covered_by.clone()),
            other => panic!("{other:?}"),
        })
        .collect();
    assert_eq!(
        dup_pairs,
        [
            ("dup_a".to_string(), "dup_a_unique".to_string()),
            ("dup_b2".to_string(), "dup_b1".to_string()),
            ("part_x".to_string(), "part_x_id".to_string()),
        ]
    );
    let mut fks = names(CheckKind::ForeignKeysWithoutIndex);
    fks.sort();
    // A BRIN index doesn't serve the key's lookups.
    assert_eq!(fks, ["brin_child_parent_id_fkey", "child_parent_id_fkey"]);
    assert_eq!(names(CheckKind::DeadRows), ["dead"]);
    assert!(names(CheckKind::NeverAnalyzed).contains(&"fresh".to_string()));
    assert!(!names(CheckKind::NeverAnalyzed).contains(&"child".to_string()));
    let unused = names(CheckKind::UnusedIndexes);
    assert!(unused.contains(&"big_n".to_string()), "{unused:?}");
    assert!(!unused.iter().any(|n| n.starts_with("dup")), "{unused:?}");

    // Each fix is valid SQL that clears its finding.
    let fixed = [
        CheckKind::IdsRunningOut,
        CheckKind::DuplicateIndexes,
        CheckKind::ForeignKeysWithoutIndex,
        CheckKind::DeadRows,
        CheckKind::NeverAnalyzed,
        CheckKind::UnusedIndexes,
    ];
    for kind in fixed {
        for item in ours(kind) {
            run(item.fix.as_deref().expect("fix")).await;
        }
    }
    run("SELECT pg_stat_force_next_flush(); SELECT 1").await;
    let report = session_health(&session).await.expect("health again");
    for kind in fixed {
        let left: Vec<_> = report
            .checks
            .iter()
            .filter(|c| c.check == kind)
            .flat_map(|c| c.items())
            .filter(|i| i.schema.as_deref() == Some("it_health"))
            .collect();
        assert!(left.is_empty(), "{kind:?} still finds {left:?}");
    }
    run("DROP SCHEMA it_health CASCADE").await;
}

/// Whether rows come back is the statement's, not its first word's: a
/// leading comment, a bracket or `… RETURNING` still shows its rows.
#[tokio::test]
#[allow(clippy::await_holding_lock)]
async fn postgres_rows_from_any_statement_that_returns_them() {
    let _env = ENV_LOCK.lock().unwrap_or_else(|e| e.into_inner());
    let password = std::env::var("ROWKERY_PG_PASSWORD").unwrap_or_else(|_| "rowkery".into());
    std::env::set_var(
        "ROWKERY_CONFIG_DIR",
        std::env::temp_dir()
            .join(format!("rowkery-pg-it-rows-{}", std::process::id()))
            .to_string_lossy()
            .to_string(),
    );
    store_secret("integration-pg", SecretKind::DbPassword, &password).expect("store password");
    let config = pg_config();
    let session = open_session(config.id.clone(), config)
        .await
        .expect("open session");
    session_query_stream(
        &session,
        "CREATE TEMP TABLE returning_rows (id serial PRIMARY KEY, v text)",
        |_, _| Ok(()),
    )
    .await
    .expect("create");
    for (sql, columns, rows) in [
        ("-- why\nSELECT 1 AS a", 1, 1),
        ("/* why */ select 1 AS a, 2 AS b", 2, 1),
        ("(SELECT 1 AS a) UNION ALL (SELECT 2)", 1, 2),
        (
            "INSERT INTO returning_rows (v) VALUES ('x'), ('y') RETURNING id, v",
            2,
            2,
        ),
        ("UPDATE returning_rows SET v = 'z' RETURNING id", 1, 2),
    ] {
        let mut got = (0, 0);
        let n = session_query_stream(&session, sql, |batch, _| {
            got.0 = batch.columns.len();
            got.1 += batch.rows.len();
            Ok(())
        })
        .await
        .expect(sql);
        assert_eq!(got, (columns, rows), "{sql}");
        assert_eq!(n, rows as u64, "{sql}");
    }
    // Without RETURNING it's a count of rows changed, and no result.
    let mut batches = 0;
    let n = session_query_stream(&session, "DELETE FROM returning_rows", |_, _| {
        batches += 1;
        Ok(())
    })
    .await
    .expect("delete");
    assert_eq!((n, batches), (2, 0));
}
