#![cfg(feature = "postgres-integration")]
//! The statement cache, cell decoding of enums / domains / arrays, and
//! results with no rows, against a real Postgres.

use rowkery_core::connections::{PostgresConnection, PostgresSslMode};
use rowkery_core::db::postgres::{
    open_session, session_declare_cursor, session_execute, session_fetch_more,
    session_note_statement, session_query_cursor, session_query_stream_with, PostgresSession,
    StreamOptions,
};
use rowkery_core::db::{Column, DriverError, Value};
use rowkery_core::secrets::{store_secret, SecretKind};

fn pg_config() -> PostgresConnection {
    let host = std::env::var("ROWKERY_PG_HOST").unwrap_or_else(|_| "127.0.0.1".into());
    let port = std::env::var("ROWKERY_PG_PORT")
        .ok()
        .and_then(|p| p.parse().ok())
        .unwrap_or(5432);
    PostgresConnection {
        id: "integration-pg".into(),
        name: "integration".into(),
        host,
        port,
        database: std::env::var("ROWKERY_PG_DB").unwrap_or_else(|_| "rowkery".into()),
        username: std::env::var("ROWKERY_PG_USER").unwrap_or_else(|_| "rowkery".into()),
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
        mcp_access: None,
        masked_columns: Default::default(),
    }
}

/// The tests in this binary share `ROWKERY_CONFIG_DIR`; held from setting it
/// until the session has read its password.
static ENV_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());

#[allow(clippy::await_holding_lock)]
async fn session(tag: &str) -> PostgresSession {
    let _env = ENV_LOCK.lock().unwrap_or_else(|e| e.into_inner());
    let password = std::env::var("ROWKERY_PG_PASSWORD").unwrap_or_else(|_| "rowkery".into());
    std::env::set_var(
        "ROWKERY_CONFIG_DIR",
        std::env::temp_dir()
            .join(format!("rowkery-pg-it-{tag}-{}", std::process::id()))
            .to_string_lossy()
            .to_string(),
    );
    store_secret("integration-pg", SecretKind::DbPassword, &password).expect("store password");
    let config = pg_config();
    open_session(config.id.clone(), config)
        .await
        .expect("open session")
}

/// What a run streamed: its columns (from the first batch) and rows.
#[derive(Debug, Default)]
struct Got {
    columns: Option<Vec<Column>>,
    rows: Vec<Vec<Value>>,
}

impl Got {
    fn take(
        &mut self,
    ) -> impl FnMut(rowkery_core::db::RowBatch, bool) -> Result<(), DriverError> + '_ {
        |batch, first| {
            if first {
                self.columns = Some(batch.columns);
            }
            self.rows.extend(batch.rows);
            Ok(())
        }
    }

    fn names(&self) -> Vec<&str> {
        self.columns
            .iter()
            .flatten()
            .map(|c| c.name.as_str())
            .collect()
    }
}

async fn plain(session: &PostgresSession, sql: &str) -> Result<Got, DriverError> {
    let mut got = Got::default();
    session_query_stream_with(session, sql, StreamOptions::default(), got.take()).await?;
    Ok(got)
}

async fn cursor(session: &mut PostgresSession, sql: &str, rows: u32) -> (Got, bool) {
    let mut got = Got::default();
    let (_, more) = session_query_cursor(session, sql, rows, StreamOptions::default(), got.take())
        .await
        .expect("cursor query")
        .expect("ran as a cursor");
    (got, more)
}

/// A FETCH prepared for one cursor must not decode the next cursor's rows:
/// float8 values came back as int8 bit patterns (4609434218613702656).
#[tokio::test]
async fn postgres_fetch_is_not_reused_across_cursors() {
    let mut s = session("fetch").await;
    let (got, more) = cursor(
        &mut s,
        "SELECT g::int8 AS a FROM generate_series(1,10) g",
        3,
    )
    .await;
    assert!(more);
    assert_eq!(got.rows[0], vec![Value::Int(1)]);
    let mut next = Got::default();
    session_fetch_more(&mut s, 3, StreamOptions::default(), next.take())
        .await
        .expect("fetch more");
    assert_eq!(next.rows[0], vec![Value::Int(4)]);

    let (got, _) = cursor(
        &mut s,
        "SELECT (g+0.5)::float8 AS b FROM generate_series(1,10) g",
        3,
    )
    .await;
    assert_eq!(got.names(), ["b"]);
    assert_eq!(
        got.rows,
        vec![
            vec![Value::Float(1.5)],
            vec![Value::Float(2.5)],
            vec![Value::Float(3.5)]
        ]
    );
    let mut next = Got::default();
    session_fetch_more(&mut s, 3, StreamOptions::default(), next.take())
        .await
        .expect("fetch more");
    assert_eq!(next.rows[0], vec![Value::Float(4.5)]);

    // The user's own cursor, declared twice with different columns.
    session_close(&mut s).await;
    session_execute(
        &s,
        "BEGIN; DECLARE c CURSOR FOR SELECT 1::int4 AS x, 2::int4 AS y",
    )
    .await
    .unwrap();
    let got = plain(&s, "FETCH 1 FROM c").await.unwrap();
    assert_eq!(got.rows, vec![vec![Value::Int(1), Value::Int(2)]]);
    session_execute(&s, "CLOSE c; DECLARE c CURSOR FOR SELECT 'z'::text AS t")
        .await
        .unwrap();
    let got = plain(&s, "FETCH 1 FROM c").await.unwrap();
    assert_eq!(got.names(), ["t"]);
    assert_eq!(got.rows, vec![vec![Value::Text("z".into())]]);
    session_execute(&s, "ROLLBACK").await.unwrap();
}

async fn session_close(s: &mut PostgresSession) {
    rowkery_core::db::postgres::session_close_cursor(s).await;
}

/// A statement cached before the user's `BEGIN`, whose table then changes
/// inside the transaction: the error is the server's, and the transaction
/// is not aborted by a hidden retry.
#[tokio::test]
async fn postgres_cache_is_not_used_inside_the_users_transaction() {
    let mut s = session("txn").await;
    session_execute(
        &s,
        "DROP TABLE IF EXISTS it_cache_txn; CREATE TABLE it_cache_txn (id int); INSERT INTO it_cache_txn VALUES (1)",
    )
    .await
    .unwrap();
    // Cached, outside any transaction.
    let got = plain(&s, "SELECT * FROM it_cache_txn").await.unwrap();
    assert_eq!(got.names(), ["id"]);
    session_note_statement(&mut s, true);

    plain(&s, "BEGIN").await.unwrap();
    session_note_statement(&mut s, false);
    plain(&s, "ALTER TABLE it_cache_txn ADD COLUMN c int")
        .await
        .unwrap();
    session_note_statement(&mut s, false);
    let got = plain(&s, "SELECT * FROM it_cache_txn")
        .await
        .expect("a fresh prepare inside the transaction");
    assert_eq!(got.names(), ["id", "c"]);
    // Still open and healthy: the ALTER is there to roll back.
    plain(&s, "SELECT 1")
        .await
        .expect("transaction not aborted");
    plain(&s, "ROLLBACK").await.unwrap();
    session_note_statement(&mut s, false);
    let got = plain(&s, "SELECT * FROM it_cache_txn").await.unwrap();
    assert_eq!(got.names(), ["id"]);

    // Outside a transaction a stale cached statement is prepared again.
    let got = plain(&s, "SELECT * FROM it_cache_txn").await.unwrap();
    assert_eq!(got.names(), ["id"]);
    // Resolve the session's state the way a cursor run does.
    let _ = cursor(&mut s, "SELECT 1", 10).await;
    let got = plain(&s, "SELECT * FROM it_cache_txn").await.unwrap();
    assert_eq!(got.names(), ["id"]);
    session_execute(&s, "ALTER TABLE it_cache_txn ADD COLUMN d int")
        .await
        .unwrap();
    let got = plain(&s, "SELECT * FROM it_cache_txn")
        .await
        .expect("re-prepared");
    assert_eq!(got.names(), ["id", "d"]);
    session_execute(&s, "DROP TABLE it_cache_txn")
        .await
        .unwrap();
}

/// Enums, domains and one-dimensional arrays decode to Postgres's text
/// output, not `<type name>`.
#[tokio::test]
async fn postgres_decodes_enums_domains_arrays() {
    let s = session("types").await;
    session_execute(
        &s,
        "DROP SCHEMA IF EXISTS it_types CASCADE; CREATE SCHEMA it_types;
         CREATE TYPE it_types.mood AS ENUM ('sad', 'ok', 'happy days');
         CREATE DOMAIN it_types.label AS text;
         CREATE DOMAIN it_types.positive AS int4 CHECK (VALUE > 0);",
    )
    .await
    .unwrap();
    let cases: &[(&str, Value)] = &[
        ("'ok'::it_types.mood", Value::Text("ok".into())),
        (
            "'happy days'::it_types.mood",
            Value::Text("happy days".into()),
        ),
        ("'hi'::it_types.label", Value::Text("hi".into())),
        ("7::it_types.positive", Value::Int(7)),
        ("NULL::it_types.mood", Value::Null),
    ];
    for (expr, want) in cases {
        let got = plain(&s, &format!("SELECT {expr} AS v")).await.unwrap();
        assert_eq!(&got.rows[0][0], want, "{expr}");
    }
    // Arrays: each must match `::text`.
    let arrays = [
        "ARRAY['a','b','c d']::text[]",
        "ARRAY['a,b','say \"hi\"','back\\slash','', 'NULL', NULL, '{x}']::text[]",
        "'{}'::text[]",
        "ARRAY[NULL, 1, -2]::int4[]",
        "ARRAY[1, 9223372036854775807]::int8[]",
        "ARRAY[3]::int2[]",
        "ARRAY[1.5, 'NaN', 'Infinity']::float8[]",
        "ARRAY[1.1]::float4[]",
        "ARRAY[true, false, NULL]::bool[]",
        "ARRAY[1.50, -0.001]::numeric[]",
        "ARRAY['200ea567-baf1-4c2e-9d3a-0123456789ab']::uuid[]",
        "ARRAY['2026-10-06'::date]",
        "ARRAY['2026-10-06 01:02:03.5'::timestamp]",
        "ARRAY['x y']::varchar[]",
        "ARRAY['sad','happy days']::it_types.mood[]",
        "'[0:1]={a,b}'::text[]",
    ];
    for expr in arrays {
        let got = plain(&s, &format!("SELECT {expr} AS v, ({expr})::text AS t"))
            .await
            .unwrap();
        assert_eq!(got.rows[0][0], got.rows[0][1], "{expr}");
    }
    // A table with an enum column, through a cursor too.
    let mut s = s;
    session_execute(
        &s,
        "CREATE TABLE it_types.t (id int PRIMARY KEY, m it_types.mood, tags text[]);
         INSERT INTO it_types.t VALUES (1, 'sad', '{a,b}'), (2, 'happy days', NULL)",
    )
    .await
    .unwrap();
    let (got, _) = cursor(&mut s, "SELECT * FROM it_types.t ORDER BY id", 10).await;
    assert_eq!(
        got.rows,
        vec![
            vec![
                Value::Int(1),
                Value::Text("sad".into()),
                Value::Text("{a,b}".into())
            ],
            vec![Value::Int(2), Value::Text("happy days".into()), Value::Null],
        ]
    );
    // A two-dimensional array keeps its placeholder.
    let got = plain(&s, "SELECT '{{1,2},{3,4}}'::int4[] AS v")
        .await
        .unwrap();
    assert_eq!(got.rows[0][0], Value::Text("<_int4>".into()));
    session_execute(&s, "DROP SCHEMA it_types CASCADE")
        .await
        .unwrap();
}

/// A query with no rows still names its columns, plain and as a cursor; a
/// statement with no result set has none.
#[tokio::test]
async fn postgres_zero_rows_keep_their_columns() {
    let mut s = session("zero").await;
    let got = plain(&s, "SELECT 1::int4 AS id, 'x'::text AS name WHERE false")
        .await
        .unwrap();
    assert_eq!(got.names(), ["id", "name"]);
    assert!(got.rows.is_empty());
    let (got, more) = cursor(
        &mut s,
        "SELECT g AS id, g::text AS name FROM generate_series(1,3) g WHERE false",
        100,
    )
    .await;
    assert!(!more);
    assert_eq!(got.names(), ["id", "name"]);
    assert!(got.rows.is_empty());
    let got = plain(&s, "CREATE TEMP TABLE it_zero (id int)")
        .await
        .unwrap();
    assert!(got.columns.is_none() && got.rows.is_empty());
}

async fn rows_in(s: &PostgresSession, count: &str) -> Value {
    plain(s, count).await.unwrap().rows[0][0].clone()
}

/// A paged run used to send `DECLARE … CURSOR FOR {sql}` in one
/// simple-protocol batch, so statements hidden after the query's text ran,
/// and `BEGIN READ WRITE` got past a read-only connection. Now the DECLARE
/// goes alone through the extended protocol and the server refuses it:
/// the DELETE never runs, read-only or not, paged or prefetched.
#[tokio::test]
#[allow(clippy::await_holding_lock)]
async fn postgres_a_cursor_never_runs_a_hidden_statement() {
    let table = format!("it_hidden_write_{}", std::process::id());
    let s = session("hidden").await;
    session_execute(
        &s,
        &format!("DROP TABLE IF EXISTS {table}; CREATE TABLE {table} (id int); INSERT INTO {table} VALUES (1)"),
    )
    .await
    .unwrap();
    let counted = format!("SELECT count(*)::int8 FROM {table}");
    let hidden = [
        format!("SELECT E'\\''; COMMIT; BEGIN READ WRITE; DELETE FROM {table}; COMMIT; --'"),
        format!("SELECT 1; COMMIT; DELETE FROM {table}; --"),
        format!("SELECT 1; DELETE FROM {table}"),
    ];
    for read_only in [false, true] {
        let mut config = pg_config();
        config.safe_mode = if read_only {
            rowkery_core::safety::SafeMode::ReadOnly
        } else {
            Default::default()
        };
        let mut tab = {
            let _env = ENV_LOCK.lock().unwrap_or_else(|e| e.into_inner());
            open_session(config.id.clone(), config).await.unwrap()
        };
        for sql in &hidden {
            let mut got = Got::default();
            let run =
                session_query_cursor(&mut tab, sql, 10, StreamOptions::default(), got.take()).await;
            assert!(matches!(run, Ok(None)), "{sql}: {run:?}");
            assert_eq!(
                rows_in(&s, &counted).await,
                Value::Int(1),
                "{sql} (read-only: {read_only})"
            );
            // Run as written (the caller's fallback), the server refuses it too.
            assert!(plain(&tab, sql).await.is_err(), "{sql}");
            assert_eq!(rows_in(&s, &counted).await, Value::Int(1), "{sql}");
            // The prefetch's DECLARE, inside its own transaction.
            session_execute(&tab, "BEGIN READ ONLY").await.unwrap();
            let declared = session_declare_cursor(&tab, "it_pf", sql).await;
            assert!(declared.is_err(), "{sql}");
            session_execute(&tab, "ROLLBACK").await.unwrap();
            assert_eq!(rows_in(&s, &counted).await, Value::Int(1), "{sql}");
        }
        // The tab still pages an honest query afterwards.
        let (got, more) = cursor(&mut tab, &format!("SELECT * FROM {table}"), 10).await;
        assert_eq!(got.rows, vec![vec![Value::Int(1)]]);
        assert!(!more);
    }
    session_execute(&s, &format!("DROP TABLE {table}"))
        .await
        .unwrap();
}

/// A locking clause in a CTE (`FOR UPDATE`, `FOR NO KEY UPDATE`,
/// `FOR UPDATE OF t`) is not the UPDATE verb: the classifier reads these as
/// reads, and Postgres runs them without changing a row. A real UPDATE
/// after one is still a write that does change rows.
#[tokio::test]
async fn postgres_locking_ctes_read_and_change_nothing() {
    use rowkery_core::safety::{check_sql, Dialect, StatementKind};
    let s = session("locking-cte").await;
    session_execute(
        &s,
        "DROP TABLE IF EXISTS rowkery_lock_cte; \
         CREATE TABLE rowkery_lock_cte (id int PRIMARY KEY, n int); \
         INSERT INTO rowkery_lock_cte SELECT g, g FROM generate_series(1, 3) g",
    )
    .await
    .expect("table");
    let snapshot = || async {
        plain(
            &s,
            "SELECT string_agg(id || ':' || n, ',' ORDER BY id) FROM rowkery_lock_cte",
        )
        .await
        .expect("snapshot")
        .rows
    };
    let before = snapshot().await;
    let kinds = |sql: &str| -> Vec<StatementKind> {
        check_sql(sql, Dialect::Postgres)
            .iter()
            .map(|c| c.kind)
            .collect()
    };
    for sql in [
        "WITH x AS (SELECT * FROM rowkery_lock_cte FOR UPDATE) SELECT * FROM x",
        "WITH x AS (SELECT * FROM rowkery_lock_cte FOR NO KEY UPDATE) SELECT * FROM x",
        "WITH x AS (SELECT * FROM rowkery_lock_cte t FOR UPDATE OF t) SELECT * FROM x",
        "WITH x AS (SELECT * FROM rowkery_lock_cte t FOR NO KEY UPDATE OF t SKIP LOCKED) SELECT count(*) FROM x",
    ] {
        assert_eq!(kinds(sql), [StatementKind::Read], "{sql}");
        let got = plain(&s, sql).await.unwrap_or_else(|e| panic!("{sql}: {e}"));
        assert!(!got.rows.is_empty(), "{sql}");
        assert_eq!(snapshot().await, before, "{sql} changed rows");
    }
    let write = "WITH x AS (SELECT * FROM rowkery_lock_cte FOR UPDATE) \
                 UPDATE rowkery_lock_cte SET n = n + 1 WHERE id IN (SELECT id FROM x)";
    assert_eq!(kinds(write), [StatementKind::Write]);
    plain(&s, write).await.expect("update");
    assert_ne!(snapshot().await, before);
    session_execute(&s, "DROP TABLE rowkery_lock_cte")
        .await
        .expect("drop");
}

/// Past `keep` rows are counted but neither decoded nor passed on, and the
/// statement still runs to its end (a write's RETURNING finishes).
#[tokio::test]
async fn keep_stops_decoding_but_not_the_statement() {
    let s = session("keep").await;
    let table = format!("it_keep_{}", std::process::id());
    session_execute(&s, &format!("CREATE TABLE {table} (n int)"))
        .await
        .unwrap();
    let opts = StreamOptions {
        keep: Some(3),
        batch_rows: 2,
        ..StreamOptions::default()
    };
    let mut got = Got::default();
    let stats = session_query_stream_with(
        &s,
        &format!("WITH w AS (INSERT INTO {table} SELECT generate_series(1, 10) RETURNING n) SELECT n FROM w ORDER BY n"),
        opts,
        got.take(),
    )
    .await
    .expect("run");
    assert_eq!(stats.rows, 10);
    assert_eq!(
        got.rows,
        vec![
            vec![Value::Int(1)],
            vec![Value::Int(2)],
            vec![Value::Int(3)]
        ]
    );
    let all = plain(&s, &format!("SELECT count(*)::int8 FROM {table}"))
        .await
        .unwrap();
    assert_eq!(all.rows, vec![vec![Value::Int(10)]]);
    session_execute(&s, &format!("DROP TABLE {table}"))
        .await
        .unwrap();
}

/// A key value read from the table can't break out of the keyset page's
/// literal on a server with `standard_conforming_strings` off, where `\'`
/// inside a plain string is a quote that doesn't end it.
#[tokio::test]
async fn keyset_literal_holds_with_standard_conforming_strings_off() {
    use rowkery_core::db::{table_browse_query, BrowseOptions, EngineKind};
    let s = session("scs").await;
    let table = format!("it_scs_{}", std::process::id());
    let breakout = r"\' OR TRUE --";
    session_execute(
        &s,
        &format!(
            r#"CREATE TABLE {table} (k text COLLATE "C" PRIMARY KEY);
              INSERT INTO {table} VALUES ('!'), ('\'' OR TRUE --'), ('zz')"#
        ),
    )
    .await
    .unwrap();
    session_execute(&s, "SET standard_conforming_strings = off")
        .await
        .unwrap();
    let opts = BrowseOptions {
        key: vec!["k".into()],
        after: Some([("k".to_string(), Value::Text(breakout.into()))].into()),
        ..BrowseOptions::first_page(100)
    };
    let sql = table_browse_query(EngineKind::Postgres, "public", &table, &opts);
    let got = plain(&s, &sql).await.expect(&sql);
    assert_eq!(got.rows, vec![vec![Value::Text("zz".into())]], "{sql}");
    // The same literal reads the same with it on (the default).
    session_execute(&s, "SET standard_conforming_strings = on")
        .await
        .unwrap();
    let got = plain(&s, &sql).await.expect(&sql);
    assert_eq!(got.rows, vec![vec![Value::Text("zz".into())]], "{sql}");
    session_execute(&s, &format!("DROP TABLE {table}"))
        .await
        .unwrap();
}
