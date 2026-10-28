//! Every guard, end to end: real tool calls through `dispatch` against the
//! test Postgres (`docker compose -f docker-compose.test.yml up -d`, then
//! `ROWKERY_PG_PORT=54329 cargo test -p rowkery-mcp --features postgres-integration`).
//! Each refused case is something an agent can actually send.

use rowkery_core::config::AppConfig;
use rowkery_core::connections::{
    ConnectionRecord, McpDbAccess, McpTableMode, PostgresConnection, PostgresSslMode,
};
use rowkery_core::db::postgres::{open_session, session_execute};
use rowkery_core::secrets::{store_secret, SecretKind};
use serde_json::{json, Map, Value as Json};

use crate::RowkeryMcp;

const ID: &str = "mcp-e2e-pg";

/// A condition Postgres folds to true or false at parse time, from the
/// transaction's start: a check and a run planned apart can see it differ.
/// Hashed, so a coarse server clock still lands on both sides.
const NOW_COIN: &str =
    "(hashint8((extract(epoch FROM 'now'::timestamp) * 1000000)::bigint) & 1) = 0";

fn pg_config() -> PostgresConnection {
    let env = |k: &str, d: &str| std::env::var(k).unwrap_or_else(|_| d.into());
    PostgresConnection {
        id: ID.into(),
        name: "e2e".into(),
        host: env("ROWKERY_PG_HOST", "127.0.0.1"),
        port: env("ROWKERY_PG_PORT", "5432").parse().unwrap_or(5432),
        database: env("ROWKERY_PG_DB", "rowkery"),
        username: env("ROWKERY_PG_USER", "rowkery"),
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

fn save(pg: PostgresConnection) {
    let mut config = AppConfig::default();
    config.upsert_connection(ConnectionRecord::Postgres(pg));
    config.save().expect("save config");
}

async fn call(mcp: &RowkeryMcp, tool: &str, args: Json) -> Result<Json, String> {
    let args: Map<String, Json> = args.as_object().cloned().unwrap_or_default();
    mcp.dispatch(tool, &args).await.0
}

async fn query(mcp: &RowkeryMcp, sql: &str) -> Result<Json, String> {
    call(mcp, "query", json!({ "connection": ID, "sql": sql })).await
}

/// The newest Rowkery backend other than `setup`'s: the MCP server's
/// session (agents can't call pg_backend_pid() themselves).
async fn mcp_backend(setup: &rowkery_core::db::postgres::PostgresSession) -> Json {
    let mut pid = Json::Null;
    rowkery_core::db::postgres::session_query_stream(
        setup,
        "SELECT pid FROM pg_stat_activity
         WHERE application_name LIKE 'Rowkery %' AND pid <> pg_backend_pid()
         ORDER BY backend_start DESC LIMIT 1",
        |batch, _| {
            if let Some(row) = batch.rows.first() {
                pid = json!(format!("{:?}", row[0]));
            }
            Ok(())
        },
    )
    .await
    .expect("backend");
    pid
}

// The env lock spans the whole test, awaits included: each test has its own runtime.
#[allow(clippy::await_holding_lock)]
#[tokio::test]
async fn guards_hold_against_a_real_postgres() {
    let dir = std::env::temp_dir().join(format!("rowkery-mcp-e2e-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    let _env = crate::ENV_LOCK.lock().unwrap_or_else(|e| e.into_inner());
    std::env::set_var("ROWKERY_CONFIG_DIR", dir.to_string_lossy().to_string());
    let password = std::env::var("ROWKERY_PG_PASSWORD").unwrap_or_else(|_| "rowkery".into());
    store_secret(ID, SecretKind::DbPassword, &password).expect("store password");

    // Fixtures, written by a normal (writable) session.
    let setup = open_session(ID.into(), pg_config()).await.expect("connect");
    session_execute(
        &setup,
        "DROP TABLE IF EXISTS mcp_e2e_secret, mcp_e2e_visible, mcp_e2e_big, mcp_e2e_child CASCADE;
         DROP VIEW IF EXISTS mcp_e2e_secret_view;
         DROP FUNCTION IF EXISTS mcp_e2e_bump();
         DROP VIEW IF EXISTS mcp_e2e_peek_view;
         DROP TYPE IF EXISTS mcp_e2e_comp;
         DROP DOMAIN IF EXISTS mcp_e2e_dom2;
         DROP DOMAIN IF EXISTS mcp_e2e_dom;
         DROP FUNCTION IF EXISTS mcp_e2e_peek(), mcp_e2e_peek_folded(), mcp_e2e_eq(int, int) CASCADE;
         DROP FUNCTION IF EXISTS mcp_e2e_step(text, int) CASCADE;
         DROP TABLE IF EXISTS mcp_e2e_events;
         CREATE TABLE mcp_e2e_secret (id int PRIMARY KEY, ssn text);
         INSERT INTO mcp_e2e_secret VALUES (1, '123-45-6789');
         CREATE TABLE mcp_e2e_visible (id int PRIMARY KEY, n int);
         INSERT INTO mcp_e2e_visible VALUES (1, 0);
         CREATE TABLE mcp_e2e_big (id int PRIMARY KEY, v text);
         INSERT INTO mcp_e2e_big SELECT g, 'v' || g FROM generate_series(1, 150000) g;
         ANALYZE mcp_e2e_big;
         CREATE VIEW mcp_e2e_secret_view AS SELECT id FROM mcp_e2e_secret;
         CREATE FUNCTION mcp_e2e_bump() RETURNS int LANGUAGE plpgsql AS
           $$ BEGIN UPDATE mcp_e2e_visible SET n = n + 1; RETURN 1; END $$;
         CREATE FUNCTION mcp_e2e_peek() RETURNS text LANGUAGE plpgsql STABLE AS
           $$ BEGIN RETURN (SELECT ssn FROM mcp_e2e_secret LIMIT 1); END $$;
         CREATE FUNCTION mcp_e2e_peek_folded() RETURNS text LANGUAGE plpgsql IMMUTABLE AS
           $$ BEGIN RETURN (SELECT ssn FROM mcp_e2e_secret LIMIT 1); END $$;
         CREATE VIEW mcp_e2e_peek_view AS SELECT mcp_e2e_peek_folded() AS x;
         CREATE FUNCTION mcp_e2e_eq(int, int) RETURNS bool LANGUAGE plpgsql IMMUTABLE AS
           $$ BEGIN RETURN (SELECT count(*) FROM mcp_e2e_secret) > $1; END $$;
         CREATE OPERATOR === (FUNCTION = mcp_e2e_eq, LEFTARG = int, RIGHTARG = int);
         CREATE FUNCTION mcp_e2e_step(text, int) RETURNS text LANGUAGE plpgsql IMMUTABLE AS
           $$ BEGIN RETURN (SELECT ssn FROM mcp_e2e_secret LIMIT 1); END $$;
         CREATE AGGREGATE mcp_e2e_agg(int) (SFUNC = mcp_e2e_step, STYPE = text);
         DROP AGGREGATE IF EXISTS public.every(int);
         CREATE AGGREGATE public.every(int) (SFUNC = mcp_e2e_step, STYPE = text);
         CREATE DOMAIN mcp_e2e_dom AS int CHECK (mcp_e2e_eq(VALUE, 0));
         CREATE DOMAIN mcp_e2e_dom2 AS mcp_e2e_dom;
         CREATE TYPE mcp_e2e_comp AS (x mcp_e2e_dom);
         CREATE TABLE mcp_e2e_events (id int PRIMARY KEY, kind text, amount numeric,
           at timestamptz, doc jsonb);
         INSERT INTO mcp_e2e_events VALUES
           (1, 'sale', 10, '2026-10-01 09:00+00', '{\"k\": \"a\", \"tags\": [1, 2]}'),
           (2, 'sale', 5, '2026-10-01 18:00+00', '{\"k\": \"b\"}'),
           (3, 'refund', -5, '2026-10-02 10:00+00', null);",
    )
    .await
    .expect("fixtures");
    // tablefunc ships in Postgres's contrib package; without it the
    // crosstab case is skipped.
    let tablefunc = session_execute(&setup, "CREATE EXTENSION IF NOT EXISTS tablefunc")
        .await
        .is_ok();

    let mut pg = pg_config();
    pg.allow_mcp = true;
    pg.mcp_hidden_tables = vec!["public.mcp_e2e_secret".into()];
    save(pg.clone());
    let mcp = RowkeryMcp::default();

    // Reads that should work.
    let ok = query(&mcp, "SELECT n FROM mcp_e2e_visible")
        .await
        .expect("plain read");
    assert_eq!(ok["rows"], json!([[0]]));
    query(&mcp, "SELECT v FROM mcp_e2e_big WHERE id = 5")
        .await
        .expect("indexed read");
    // Rows are shaped as they arrive: 800 MB of cells, read to the row cap,
    // answers in its first 200 characters each.
    let big = query(
        &mcp,
        "SELECT repeat('x', 4000000) FROM generate_series(1, 400)",
    )
    .await
    .expect("big cells");
    assert_eq!(big["more"], true);
    assert_eq!(big["row_count"], 200);
    assert_eq!(big["notes"], json!(["text over 200 chars was cut"]));
    let before = mcp_backend(&setup).await;
    assert_ne!(before, Json::Null);
    // A read stopped at 64 KB with a few rows left keeps its session: they
    // are read off before the next call.
    let cut = query(
        &mcp,
        "SELECT repeat('x', 1000), repeat('y', 1000) FROM generate_series(1, 400)",
    )
    .await
    .expect("cut at 64 KB");
    assert!(
        cut["notes"].to_string().contains("64 KB"),
        "{}",
        cut["notes"]
    );
    let kept = mcp_backend(&setup).await;
    assert_eq!(kept, before, "a short drain keeps the session");
    // One whose rest takes seconds to come is cancelled and its session
    // dropped; the next call opens a fresh one.
    let slow = query(
        &mcp,
        "SELECT repeat('x', 1000), repeat('y', 1000),
                (SELECT count(*) FROM generate_series(1, 200000 + g))
         FROM generate_series(1, 400) g",
    )
    .await
    .expect("cut at 64 KB, slow rest");
    assert!(
        slow["notes"].to_string().contains("64 KB"),
        "{}",
        slow["notes"]
    );
    query(&mcp, "SELECT 1").await.expect("fresh session");
    let fresh = mcp_backend(&setup).await;
    assert_ne!(fresh, before, "a slow drain drops the session");
    let ok = query(&mcp, "SELECT n FROM mcp_e2e_visible")
        .await
        .expect("read after a cancelled one");
    assert_eq!(ok["rows"], json!([[0]]));

    // `'now'` is folded into the plan when it's made: the checked EXPLAIN
    // and the run plan at one moment, so a filter on its microseconds can't
    // leave the hidden table out of the check and read it in the run.
    let flip = format!("SELECT ssn FROM mcp_e2e_secret WHERE {NOW_COIN}");
    let (mut ran, mut refused) = (0, 0);
    for _ in 0..200 {
        match query(&mcp, &flip).await {
            Ok(out) => {
                assert_eq!(out["rows"], json!([]), "the run read the hidden table");
                ran += 1;
            }
            Err(err) => {
                assert_eq!(err, crate::guard::HIDDEN_REFUSAL);
                refused += 1;
            }
        }
        // Each clean run is a chance to catch a run planned apart.
        if ran >= 20 && refused > 0 {
            break;
        }
    }
    assert!(ran > 0 && refused > 0, "{ran} ran, {refused} refused");

    // Everyday analytics stay open: aggregates, dates, JSON, windows, and
    // the system views that describe tables.
    for sql in [
        "SELECT count(*), sum(amount), avg(amount), min(at), max(at) FROM mcp_e2e_events",
        "SELECT date_trunc('day', at) AS day, count(*) FROM mcp_e2e_events GROUP BY 1 ORDER BY 1",
        "SELECT doc ->> 'k', coalesce(doc ->> 'missing', 'none'), doc -> 'tags' -> 0 FROM mcp_e2e_events",
        "SELECT kind, string_agg(id::text, ', ' ORDER BY id) FROM mcp_e2e_events GROUP BY kind",
        "SELECT id, row_number() OVER w, lag(amount) OVER w, sum(amount) OVER w FROM mcp_e2e_events WINDOW w AS (ORDER BY at)",
        "SELECT to_char(at, 'YYYY-MM-DD'), extract(hour FROM at), at > now() - interval '10 years' FROM mcp_e2e_events",
        "SELECT percentile_cont(0.5) WITHIN GROUP (ORDER BY amount), count(*) FILTER (WHERE kind = 'sale') FROM mcp_e2e_events",
        "SELECT CASE WHEN amount > 0 THEN 'in' ELSE 'out' END, round(amount / 3, 2), abs(amount) FROM mcp_e2e_events",
        "SELECT jsonb_array_elements(doc -> 'tags'), jsonb_build_object('id', id) FROM mcp_e2e_events WHERE doc ? 'tags'",
        "SELECT g, lower(upper('X')) FROM generate_series(1, 3) g",
        "SELECT column_name, data_type FROM information_schema.columns WHERE table_name = 'mcp_e2e_events'",
        "SELECT tablename FROM pg_tables WHERE schemaname = 'public' AND tablename = 'mcp_e2e_events'",
    ] {
        query(&mcp, sql)
            .await
            .unwrap_or_else(|e| panic!("{sql}: {e}"));
    }

    // Functions that run SQL out of sight, and database code the plan
    // never shows (refused before the planner can fold it into a value).
    let mut hidden_runners = vec![
        (
            "SELECT ts_rewrite('a'::tsquery, 'SELECT ssn::tsquery, ssn::tsquery FROM mcp_e2e_secret')",
            "ts_rewrite() runs a query given as text",
        ),
        ("SELECT mcp_e2e_peek()", "public.mcp_e2e_peek() is defined"),
        ("SELECT mcp_e2e_peek_folded()", "public.mcp_e2e_peek_folded() is defined"),
        ("SELECT public.mcp_e2e_peek_folded()", "public.mcp_e2e_peek_folded() is defined"),
        ("SELECT x FROM mcp_e2e_peek_view", "public.mcp_e2e_peek_view is a view"),
        ("SELECT 1 === 0", "operator ==="),
        // An aggregate's own row is `internal`; its step is database code.
        (
            "SELECT mcp_e2e_agg(n) FROM mcp_e2e_visible",
            "public.mcp_e2e_agg() is defined",
        ),
        // Named like a built-in one, it wins on its argument type.
        (
            "SELECT every(n) FROM mcp_e2e_visible",
            "public.every(), which is defined in the database",
        ),
        ("SELECT 1::mcp_e2e_dom", "public.mcp_e2e_dom"),
        // Its check runs for a type built on it too.
        ("SELECT 1::mcp_e2e_dom2", "public.mcp_e2e_dom2"),
        ("SELECT ARRAY[1]::mcp_e2e_dom[]", "public.mcp_e2e_dom"),
        ("SELECT ROW(1)::mcp_e2e_comp", "public.mcp_e2e_comp"),
        ("SELECT pg_sleep(1)", "pg_sleep() only waits"),
        ("SELECT nextval('mcp_e2e_nope')", "nextval() changes"),
        // Caught in the plan: a system view over functions not on the list.
        ("SELECT * FROM pg_stat_user_tables", "pg_stat_get_"),
    ];
    if tablefunc {
        hidden_runners.push((
            "SELECT * FROM crosstab('SELECT id::text, ''a'', ssn FROM mcp_e2e_secret') AS ct(id text, a text)",
            "crosstab() runs a query given as text",
        ));
    } else {
        eprintln!("tablefunc isn't installed: crosstab case skipped");
    }
    for (sql, said) in hidden_runners {
        let err = query(&mcp, sql).await.expect_err(sql);
        assert!(
            err.starts_with("Refused") && err.contains(said),
            "{sql}: {err}"
        );
        assert!(!err.contains("123-45"), "{sql}: {err}");
    }
    let explained = call(
        &mcp,
        "explain",
        json!({ "connection": ID, "sql": "SELECT mcp_e2e_peek_folded()" }),
    )
    .await
    .expect_err("explain folds nothing");
    assert!(explained.contains("mcp_e2e_peek_folded"), "{explained}");

    // Refused by Rowkery before anything runs.
    for sql in [
        "DELETE FROM mcp_e2e_visible",
        "SELECT 1; DELETE FROM mcp_e2e_visible",
        "WITH d AS (DELETE FROM mcp_e2e_visible RETURNING *) SELECT * FROM d",
        "SELECT * FROM mcp_e2e_secret",
        "SELECT * FROM mcp_e2e_visible v JOIN mcp_e2e_secret s ON s.id = v.id",
        "SELECT * FROM pg_catalog.pg_statistic",
        "SELECT query_to_xml('select * from mcp_e2e_secret', true, false, '')",
        "SELECT table_to_xml('mcp_e2e_secret', true, false, '')",
        "SELECT pg_terminate_backend(pg_backend_pid())",
        "SELECT pg_cancel_backend(pid) FROM pg_stat_activity",
        "SELECT pg_read_file('/etc/hostname')",
        "SELECT count(*) FROM pg_ls_dir('.')",
        "SELECT \"pg_reload_conf\"()",
        "SELECT pg_advisory_lock(42)",
        "SELECT set_config('default_transaction_read_only', 'off', false)",
        "SELECT E'\\'', pg_catalog.pg_read_file('/etc/hostname') --'",
        "SELECT * FROM mcp_e2e_big WHERE v = 'v7'",
        "SELECT query FROM pg_stat_activity",
        "SELECT * FROM pg_catalog.pg_stat_get_activity(NULL)",
    ] {
        let err = query(&mcp, sql).await.expect_err(sql);
        assert!(err.starts_with("Refused"), "{sql}: {err}");
    }

    // A write hidden in a function: refused by name (the read-only session
    // would stop the write anyway).
    let err = query(&mcp, "SELECT mcp_e2e_bump()")
        .await
        .expect_err("bump");
    assert!(
        err.contains("mcp_e2e_bump() is defined in the database"),
        "bump: {err}"
    );

    // The hidden table is invisible to the schema tools too.
    let tables = call(&mcp, "list_tables", json!({ "connection": ID }))
        .await
        .unwrap();
    assert!(!tables.to_string().contains("public.mcp_e2e_secret "));
    assert!(call(
        &mcp,
        "describe_table",
        json!({ "connection": ID, "table": "mcp_e2e_secret" })
    )
    .await
    .is_err());

    // sessions: who blocks whom, with values replaced by ? and a query on
    // the hidden table blanked.
    let holder = open_session(ID.into(), pg_config()).await.expect("holder");
    session_execute(
        &holder,
        "BEGIN; UPDATE mcp_e2e_visible SET n = n WHERE id = 1 AND 'tok-visible' <> 'x'",
    )
    .await
    .expect("hold a row lock");
    let reader = open_session(ID.into(), pg_config()).await.expect("reader");
    session_execute(
        &reader,
        "BEGIN; SELECT ssn FROM mcp_e2e_secret WHERE ssn = '123-45-6789'",
    )
    .await
    .expect("read the secret");
    let waiter = open_session(ID.into(), pg_config()).await.expect("waiter");
    let waiting = tokio::spawn(async move {
        session_execute(&waiter, "UPDATE mcp_e2e_visible SET n = n WHERE id = 1").await
    });
    let mut found = Json::Null;
    for _ in 0..50 {
        found = call(&mcp, "sessions", json!({ "connection": ID }))
            .await
            .expect("sessions");
        let rows = found["sessions"].as_array().cloned().unwrap_or_default();
        if rows.iter().any(|r| r.get("blocked_by").is_some()) {
            break;
        }
        tokio::time::sleep(std::time::Duration::from_millis(100)).await;
    }
    let text = found.to_string();
    let rows = found["sessions"].as_array().expect("rows");
    assert!(rows[0]["blocking"].as_u64() >= Some(1), "{text}");
    assert!(rows.iter().any(|r| r.get("blocked_by").is_some()), "{text}");
    assert!(text.contains("AND ? <> ?"), "{text}");
    assert!(text.contains(crate::sessions::HIDDEN_QUERY), "{text}");
    for leak in ["123-45-6789", "mcp_e2e_secret", "tok-visible"] {
        assert!(!text.contains(leak), "{leak} in {text}");
    }
    session_execute(&holder, "ROLLBACK").await.expect("release");
    waiting.await.expect("join").expect("waiter ran");
    session_execute(&reader, "ROLLBACK")
        .await
        .expect("end read");

    // health: the report, with nothing about the hidden table (pg_stat_statements,
    // when the server loads it, has the queries above). Made since the
    // catalog was read: an index repeating the hidden table's key, and a
    // shared table whose foreign key to it has no index.
    session_execute(
        &setup,
        "CREATE INDEX mcp_e2e_secret_dup ON mcp_e2e_secret (id);
         CREATE TABLE mcp_e2e_child (id int PRIMARY KEY, secret_id int REFERENCES mcp_e2e_secret);
         INSERT INTO mcp_e2e_child SELECT g, NULL FROM generate_series(1, 20000) g;
         ANALYZE mcp_e2e_child;",
    )
    .await
    .expect("health fixtures");
    let health = call(&mcp, "health", json!({ "connection": ID }))
        .await
        .expect("health");
    let text = health.to_string();
    let check = |kind: &str| {
        health["checks"]
            .as_array()
            .and_then(|c| c.iter().find(|c| c["check"] == kind))
            .cloned()
            .unwrap_or(Json::Null)
    };
    let repeated = check("duplicate_indexes");
    assert_eq!(repeated["state"], "found", "{text}");
    assert!(repeated["left_out"].as_u64() >= Some(1), "{text}");
    let fks = check("foreign_keys_without_index");
    let child = fks["items"]
        .as_array()
        .and_then(|i| i.iter().find(|i| i["table"] == "mcp_e2e_child"))
        .unwrap_or_else(|| panic!("the shared child's key: {text}"));
    assert_eq!(
        child["detail"]["parent_table"],
        crate::health::UNSHARED_TABLE
    );
    assert_eq!(child["detail"]["constraint"], "(not shown)");
    assert!(
        health["server"]
            .as_str()
            .is_some_and(|s| s.starts_with("Postgres ")),
        "{text}"
    );
    assert!(
        matches!(
            health["slow_queries"]["state"].as_str(),
            Some("off" | "ranked")
        ),
        "{text}"
    );
    for leak in ["123-45-6789", "mcp_e2e_secret", "tok-visible"] {
        assert!(!text.contains(leak), "{leak} in {text}");
    }

    // Only ticked: the picked tables and nothing else, not even the
    // catalogs, a view over an unticked table, or another database.
    pg.mcp_access = Some(
        [(
            pg.database.clone(),
            McpDbAccess {
                mode: McpTableMode::Picked,
                tables: vec![
                    "public.mcp_e2e_visible".into(),
                    "public.mcp_e2e_big".into(),
                    "public.mcp_e2e_secret_view".into(),
                ],
            },
        )]
        .into_iter()
        .collect(),
    );
    save(pg.clone());
    query(&mcp, "SELECT n FROM mcp_e2e_visible")
        .await
        .expect("ticked read");
    for sql in [
        "SELECT * FROM mcp_e2e_secret",
        "SELECT * FROM mcp_e2e_secret_view",
        "SELECT relname FROM pg_class",
        "SELECT table_name FROM information_schema.tables",
        "SELECT * FROM pg_catalog.pg_stats",
    ] {
        let err = query(&mcp, sql).await.expect_err(sql);
        assert!(err.starts_with("Refused"), "{sql}: {err}");
    }
    let tables = call(&mcp, "list_tables", json!({ "connection": ID }))
        .await
        .unwrap()
        .to_string();
    assert!(tables.contains("mcp_e2e_visible") && tables.contains("mcp_e2e_big"));
    assert!(!tables.contains("public.mcp_e2e_secret "), "{tables}");
    let dbs = call(&mcp, "list_databases", json!({ "connection": ID }))
        .await
        .unwrap();
    assert_eq!(dbs["databases"].as_array().map(Vec::len), Some(1), "{dbs}");
    let err = call(
        &mcp,
        "query",
        json!({ "connection": ID, "database": "postgres", "sql": "SELECT 1" }),
    )
    .await
    .expect_err("unshared database");
    assert_eq!(err, "No database called \"postgres\".");
    pg.mcp_access = None;

    // A share that ran out is gone at once.
    pg.mcp_until = Some(1);
    save(pg);
    assert!(query(&mcp, "SELECT 1").await.is_err());

    // Nothing changed.
    let left = rowkery_core::db::postgres::session_query_stream(
        &setup,
        "SELECT 1 FROM mcp_e2e_visible WHERE n = 0",
        |_, _| Ok(()),
    )
    .await
    .expect("check");
    assert_eq!(left, 1);
    let _ = session_execute(
        &setup,
        "DROP VIEW mcp_e2e_secret_view, mcp_e2e_peek_view; DROP DOMAIN mcp_e2e_dom;
         DROP TABLE mcp_e2e_child, mcp_e2e_secret, mcp_e2e_visible, mcp_e2e_big, mcp_e2e_events;
         DROP FUNCTION mcp_e2e_bump(), mcp_e2e_peek(), mcp_e2e_peek_folded(), mcp_e2e_eq(int, int) CASCADE;",
    )
    .await;
    std::env::remove_var("ROWKERY_CONFIG_DIR");
}

/// A hidden table's rows can't be read through its partitions or child
/// tables, in any schema, nor through a parent whose rows include them.
#[allow(clippy::await_holding_lock)]
#[tokio::test]
async fn hidden_tables_hold_through_partitions_and_child_tables() {
    let dir = std::env::temp_dir().join(format!("rowkery-mcp-e2e-tree-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    let _env = crate::ENV_LOCK.lock().unwrap_or_else(|e| e.into_inner());
    std::env::set_var("ROWKERY_CONFIG_DIR", dir.to_string_lossy().to_string());
    let password = std::env::var("ROWKERY_PG_PASSWORD").unwrap_or_else(|_| "rowkery".into());
    store_secret(ID, SecretKind::DbPassword, &password).expect("store password");
    let setup = open_session(ID.into(), pg_config()).await.expect("connect");
    let cleanup = "DROP SCHEMA IF EXISTS mcp_e2e_other CASCADE;
         DROP TABLE IF EXISTS mcp_e2e_ledger, mcp_e2e_people CASCADE;";
    session_execute(&setup, cleanup).await.expect("cleanup");
    session_execute(
        &setup,
        "CREATE SCHEMA mcp_e2e_other;
         CREATE TABLE mcp_e2e_ledger (id int, amount int) PARTITION BY RANGE (id);
         CREATE TABLE mcp_e2e_other.mcp_e2e_ledger_1 PARTITION OF mcp_e2e_ledger
           FOR VALUES FROM (0) TO (100);
         INSERT INTO mcp_e2e_ledger VALUES (1, 42);
         CREATE TABLE mcp_e2e_people (id int, name text);
         CREATE TABLE mcp_e2e_other.mcp_e2e_vip (perk text) INHERITS (mcp_e2e_people);
         INSERT INTO mcp_e2e_people VALUES (1, 'ada');
         INSERT INTO mcp_e2e_other.mcp_e2e_vip VALUES (2, 'grace', 'lounge');",
    )
    .await
    .expect("fixtures");

    let mut pg = pg_config();
    pg.allow_mcp = true;
    pg.mcp_hidden_tables = vec![
        "public.mcp_e2e_ledger".into(),
        "mcp_e2e_other.mcp_e2e_vip".into(),
    ];
    save(pg.clone());
    let mcp = RowkeryMcp::default();
    for sql in [
        // A partition in another schema is its hidden parent's rows.
        "SELECT amount FROM mcp_e2e_other.mcp_e2e_ledger_1",
        // A parent reads its hidden child table's rows.
        "SELECT name FROM mcp_e2e_people",
    ] {
        let err = query(&mcp, sql).await.expect_err(sql);
        assert!(err.starts_with("Refused"), "{sql}: {err}");
    }
    // Its own rows alone are fine.
    let own = query(&mcp, "SELECT name FROM ONLY mcp_e2e_people")
        .await
        .expect("ONLY the parent");
    assert_eq!(own["rows"], json!([["ada"]]));
    let tables = call(&mcp, "list_tables", json!({ "connection": ID }))
        .await
        .unwrap()
        .to_string();
    assert!(
        !tables.contains("mcp_e2e_ledger") && !tables.contains("mcp_e2e_people"),
        "{tables}"
    );
    // A partition made after the schema was read is still its parent's.
    session_execute(
        &setup,
        "CREATE TABLE mcp_e2e_other.mcp_e2e_ledger_2 PARTITION OF mcp_e2e_ledger
           FOR VALUES FROM (100) TO (200);
         INSERT INTO mcp_e2e_ledger VALUES (150, 7);",
    )
    .await
    .expect("new partition");
    let err = query(&mcp, "SELECT amount FROM mcp_e2e_other.mcp_e2e_ledger_2")
        .await
        .expect_err("new partition");
    assert!(err.starts_with("Refused"), "{err}");
    // So is a table attached as one later.
    session_execute(
        &setup,
        "CREATE TABLE mcp_e2e_other.mcp_e2e_ledger_3 (id int, amount int);
         INSERT INTO mcp_e2e_other.mcp_e2e_ledger_3 VALUES (250, 1);",
    )
    .await
    .expect("loose table");
    query(&mcp, "SELECT amount FROM mcp_e2e_other.mcp_e2e_ledger_3")
        .await
        .expect("not a partition yet");
    session_execute(
        &setup,
        "ALTER TABLE mcp_e2e_ledger ATTACH PARTITION mcp_e2e_other.mcp_e2e_ledger_3
           FOR VALUES FROM (200) TO (300);",
    )
    .await
    .expect("attach");
    let err = query(&mcp, "SELECT amount FROM mcp_e2e_other.mcp_e2e_ledger_3")
        .await
        .expect_err("attached");
    assert!(err.starts_with("Refused"), "{err}");

    // Ticking the parent shares its partitions wherever they live.
    pg.mcp_hidden_tables = Vec::new();
    pg.mcp_access = Some(
        [(
            pg.database.clone(),
            McpDbAccess {
                mode: McpTableMode::Picked,
                tables: vec![
                    "public.mcp_e2e_ledger".into(),
                    "public.mcp_e2e_people".into(),
                ],
            },
        )]
        .into_iter()
        .collect(),
    );
    save(pg.clone());
    let mcp = RowkeryMcp::default();
    let ok = query(&mcp, "SELECT amount FROM mcp_e2e_other.mcp_e2e_ledger_1")
        .await
        .expect("a ticked parent's partition");
    assert_eq!(ok["rows"], json!([[42]]));
    // A child table made with INHERITS is a table of its own: ticking its
    // parent doesn't share it, nor the parent's rows that include it.
    for sql in [
        "SELECT name FROM mcp_e2e_other.mcp_e2e_vip",
        "SELECT name FROM mcp_e2e_people",
    ] {
        let err = query(&mcp, sql).await.expect_err(sql);
        assert!(err.starts_with("Refused"), "{sql}: {err}");
    }
    let tables = call(&mcp, "list_tables", json!({ "connection": ID }))
        .await
        .unwrap()
        .to_string();
    assert!(
        tables.contains("public.mcp_e2e_ledger") && !tables.contains("mcp_e2e_vip"),
        "{tables}"
    );
    assert!(!tables.contains("mcp_e2e_ledger_1"), "{tables}");
    assert!(tables.contains("2 cols, 3 partitions"), "{tables}");

    // Partitions Postgres leaves out as the run starts (`now()` is only
    // known then) still count: with one partition ticked, a query that the
    // plan says reads only it is refused, since the run decides again.
    pg.mcp_access = Some(
        [(
            pg.database.clone(),
            McpDbAccess {
                mode: McpTableMode::Picked,
                tables: vec!["mcp_e2e_other.mcp_e2e_ledger_1".into()],
            },
        )]
        .into_iter()
        .collect(),
    );
    save(pg);
    let mcp = RowkeryMcp::default();
    query(&mcp, "SELECT amount FROM mcp_e2e_other.mcp_e2e_ledger_1")
        .await
        .expect("the ticked partition");
    // Ticked on its own, a partition gets its own line.
    let tables = call(&mcp, "list_tables", json!({ "connection": ID }))
        .await
        .unwrap()
        .to_string();
    assert!(
        tables.contains("mcp_e2e_other.mcp_e2e_ledger_1")
            && !tables.contains("public.mcp_e2e_ledger"),
        "{tables}"
    );
    // With its parent's columns, which the schema lists once for them all.
    assert!(tables.contains(", 2 cols"), "{tables}");
    let described = call(
        &mcp,
        "describe_table",
        json!({ "connection": ID, "table": "mcp_e2e_other.mcp_e2e_ledger_1" }),
    )
    .await
    .unwrap();
    assert_eq!(
        described["columns"],
        json!(["id integer", "amount integer"])
    );
    let pruned =
        "SELECT amount FROM mcp_e2e_ledger WHERE id < date_part('year', now())::int - 1950";
    let err = query(&mcp, pruned).await.expect_err("pruned at the start");
    assert!(err.starts_with("Refused"), "{err}");
    // Only planning with pruning on leaves the unticked partitions out.
    let next = query(&mcp, "SELECT amount FROM mcp_e2e_ledger WHERE id = 1")
        .await
        .expect("pruning is back on for the next");
    assert_eq!(next["rows"], json!([[42]]));

    let _ = session_execute(&setup, cleanup).await;
    std::env::remove_var("ROWKERY_CONFIG_DIR");
}

/// The leak table of the sensitive-columns proposal, row by row: a marked
/// column comes back as a stand-in when returned or counted, and every
/// other way of reading it is refused before anything runs.
#[allow(clippy::await_holding_lock)]
#[tokio::test]
async fn masked_columns_hold_against_a_real_postgres() {
    let dir = std::env::temp_dir().join(format!("rowkery-mcp-e2e-mask-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    let _env = crate::ENV_LOCK.lock().unwrap_or_else(|e| e.into_inner());
    std::env::set_var("ROWKERY_CONFIG_DIR", dir.to_string_lossy().to_string());
    let password = std::env::var("ROWKERY_PG_PASSWORD").unwrap_or_else(|_| "rowkery".into());
    store_secret(ID, SecretKind::DbPassword, &password).expect("store password");

    let setup = open_session(ID.into(), pg_config()).await.expect("connect");
    session_execute(
        &setup,
        "DROP TABLE IF EXISTS mcp_mask_customers, mcp_mask_orders, mcp_mask_events, mcp_mask_people, mcp_mask_tagged, mcp_mask_upart, mcp_mask_log_2024, mcp_mask_log_2025, mcp_mask_vc CASCADE;
         DROP SCHEMA IF EXISTS mcp_mask_s CASCADE;
         DROP FUNCTION IF EXISTS mcp_mask_lookup(int);
         CREATE TABLE mcp_mask_customers (id int PRIMARY KEY, email text, plan text);
         CREATE INDEX mcp_mask_customers_email ON mcp_mask_customers (lower(email));
         INSERT INTO mcp_mask_customers VALUES
           (1, 'mara@fjord.se', 'pro'), (2, 'tomas@ibarra.dev', 'free'), (3, 'mara@fjord.se', 'pro');
         CREATE TABLE mcp_mask_orders (id int PRIMARY KEY, customer_id int, total int);
         INSERT INTO mcp_mask_orders VALUES (10, 1, 40), (11, 2, 15);
         CREATE TABLE mcp_mask_events (id int, email text, at date) PARTITION BY RANGE (at);
         CREATE TABLE mcp_mask_events_a PARTITION OF mcp_mask_events
           FOR VALUES FROM ('2026-01-01') TO ('2026-07-01');
         CREATE SCHEMA mcp_mask_s;
         CREATE TABLE mcp_mask_s.events_b PARTITION OF mcp_mask_events
           FOR VALUES FROM ('2026-07-01') TO ('2027-01-01');
         INSERT INTO mcp_mask_events VALUES (1, 'mara@fjord.se', '2026-02-01'),
           (2, 'tomas@ibarra.dev', '2026-08-01');
         CREATE TABLE mcp_mask_people (id int, email text);
         CREATE TABLE mcp_mask_staff () INHERITS (mcp_mask_people);
         INSERT INTO mcp_mask_people VALUES (1, 'mara@fjord.se');
         INSERT INTO mcp_mask_staff VALUES (2, 'tomas@ibarra.dev');
         CREATE TABLE mcp_mask_tagged (id int, tag text);
         CREATE TABLE mcp_mask_both () INHERITS (mcp_mask_people, mcp_mask_tagged);
         INSERT INTO mcp_mask_both VALUES (3, 'kim@x.io', 'vip');
         CREATE TABLE mcp_mask_upart (id int) PARTITION BY RANGE (id);
         CREATE TABLE mcp_mask_upart_a PARTITION OF mcp_mask_upart FOR VALUES FROM (0) TO (100);
         INSERT INTO mcp_mask_upart VALUES (1), (2);
         CREATE TABLE mcp_mask_log_2024 (id int, email text);
         CREATE TABLE mcp_mask_log_2025 (id int, email text);
         INSERT INTO mcp_mask_log_2024 VALUES (1, 'mara@fjord.se');
         INSERT INTO mcp_mask_log_2025 VALUES (2, 'tomas@ibarra.dev');
         CREATE TABLE mcp_mask_vc (id int, email varchar(100));
         INSERT INTO mcp_mask_vc VALUES (1, 'mara@fjord.se');
         CREATE VIEW mcp_mask_view AS SELECT id, email FROM mcp_mask_customers;
         CREATE FUNCTION mcp_mask_lookup(i int) RETURNS text LANGUAGE plpgsql STABLE AS
           $$ BEGIN RETURN (SELECT email FROM mcp_mask_customers WHERE id = i); END $$;",
    )
    .await
    .expect("fixtures");

    // Shared as "All tables": nothing hidden, only the columns masked.
    let mut pg = pg_config();
    pg.allow_mcp = true;
    pg.mcp_access = Some(
        [(
            pg.database.clone(),
            McpDbAccess {
                mode: McpTableMode::All,
                tables: Vec::new(),
            },
        )]
        .into_iter()
        .collect(),
    );
    pg.masked_columns = [(
        pg.database.clone(),
        vec![
            "public.mcp_mask_customers.email".to_string(),
            "public.mcp_mask_events.email".to_string(),
            "public.mcp_mask_people.email".to_string(),
            "public.mcp_mask_log_2024.email".to_string(),
            "public.mcp_mask_log_2025.email".to_string(),
            "public.mcp_mask_vc.email".to_string(),
        ],
    )]
    .into_iter()
    .collect();
    save(pg.clone());
    let mcp = RowkeryMcp::default();

    let rows = |out: &Json| out["rows"].as_array().cloned().unwrap_or_default();
    let stand_in = |v: &Json| {
        v.as_str()
            .is_some_and(|s| s.starts_with("masked:") && !s.contains('@'))
    };

    // Returned: masked, the same email giving the same stand-in.
    let out = query(
        &mcp,
        "SELECT id, email, plan FROM mcp_mask_customers ORDER BY id",
    )
    .await
    .expect("plain read");
    let r = rows(&out);
    assert!(r.iter().all(|row| stand_in(&row[1])), "{out}");
    assert_eq!(r[0][1], r[2][1]);
    assert_ne!(r[0][1], r[1][1]);
    assert_eq!(r[0][2], "pro");
    assert_eq!(out["masked"], json!(["email"]));
    for sql in [
        "SELECT * FROM mcp_mask_customers",
        "SELECT * FROM mcp_mask_view",
        "SELECT c.email, o.total FROM mcp_mask_orders o JOIN mcp_mask_customers c ON c.id = o.customer_id",
        "SELECT email FROM mcp_mask_customers UNION ALL SELECT email FROM mcp_mask_events",
        "SELECT e.email FROM mcp_mask_events e",
        "SELECT email FROM mcp_mask_customers ORDER BY id LIMIT 2",
        "SELECT row_number() OVER (ORDER BY id), email FROM mcp_mask_customers",
        "WITH x AS (SELECT email FROM mcp_mask_customers) SELECT email FROM x",
        // Partitions (one in another schema) and child tables answer for
        // the table that was marked.
        "SELECT email FROM mcp_mask_events",
        "SELECT email FROM mcp_mask_events WHERE at > '2026-07-01'",
        "SELECT email FROM mcp_mask_s.events_b",
        "SELECT email FROM mcp_mask_people",
        "SELECT email FROM mcp_mask_staff",
        "SELECT p.email FROM mcp_mask_people p JOIN mcp_mask_orders o ON o.customer_id = p.id",
        // Tables whose own names end in a number.
        "SELECT email FROM mcp_mask_log_2024 UNION ALL SELECT email FROM mcp_mask_log_2025",
    ] {
        let out = query(&mcp, sql).await.unwrap_or_else(|e| panic!("{sql}: {e}"));
        let text = out["rows"].to_string();
        assert!(!text.contains('@'), "{sql} leaked: {text}");
        assert!(text.contains("masked:"), "{sql}: {text}");
    }
    // Counted: fine.
    let out = query(
        &mcp,
        "SELECT count(DISTINCT email), count(email) FROM mcp_mask_customers",
    )
    .await
    .expect("counts");
    assert_eq!(out["rows"], json!([[2, 3]]));

    // Every other use is refused before anything runs.
    for sql in [
        "SELECT id FROM mcp_mask_customers WHERE email LIKE 'm%'",
        "SELECT id FROM mcp_mask_customers WHERE email = 'mara@fjord.se'",
        "SELECT lower(email) FROM mcp_mask_customers",
        "SELECT email || '' FROM mcp_mask_customers",
        "SELECT substr(email, 1, 1) FROM mcp_mask_customers",
        "SELECT email::int FROM mcp_mask_customers",
        "SELECT email FROM mcp_mask_customers ORDER BY email",
        "SELECT email, count(*) FROM mcp_mask_customers GROUP BY email",
        "SELECT DISTINCT email FROM mcp_mask_customers",
        "SELECT min(email) FROM mcp_mask_customers",
        "SELECT string_agg(email, ',') FROM mcp_mask_customers",
        "SELECT to_json(c) FROM mcp_mask_customers c",
        "SELECT row_to_json(c.*) FROM mcp_mask_customers c",
        "SELECT c FROM mcp_mask_customers c",
        "SELECT a.id FROM mcp_mask_customers a JOIN mcp_mask_customers b ON a.email = b.email",
        "SELECT (SELECT email FROM mcp_mask_customers LIMIT 1)",
        "SELECT * FROM (SELECT email AS e FROM mcp_mask_customers OFFSET 0) s WHERE s.e LIKE 'm%'",
        "WITH x AS MATERIALIZED (SELECT email AS e FROM mcp_mask_customers) SELECT e FROM x",
        "SELECT email FROM mcp_mask_customers INTERSECT SELECT 'mara@fjord.se'",
        "SELECT email FROM mcp_mask_customers EXCEPT SELECT 'mara@fjord.se'",
        "SELECT email FROM mcp_mask_customers UNION SELECT 'x'",
        // A union names its column after the first part: masked values
        // under a literal's name, a guess masked to compare, or an unmarked
        // column beside one.
        "SELECT 'x' UNION ALL SELECT email FROM mcp_mask_customers",
        "SELECT * FROM (SELECT NULL::text AS e UNION ALL SELECT email FROM mcp_mask_customers) s",
        "SELECT email FROM mcp_mask_customers WHERE id = 1 UNION ALL SELECT 'mara@fjord.se'",
        "SELECT count(DISTINCT e) FROM (SELECT email AS e FROM mcp_mask_customers UNION ALL SELECT 'mara@fjord.se') s",
        "SELECT plan FROM mcp_mask_customers UNION ALL SELECT email FROM mcp_mask_customers",
        "WITH RECURSIVE r(e, n) AS (SELECT 'x'::text, 0 UNION ALL SELECT c.email, r.n + 1 FROM r JOIN mcp_mask_customers c ON c.id = r.n + 1) SELECT e FROM r",
        // The same through a union or partitions nested a level down.
        "SELECT 'x' UNION ALL SELECT * FROM (SELECT email FROM mcp_mask_customers UNION ALL SELECT email FROM mcp_mask_customers OFFSET 0) s",
        "SELECT 'x' UNION ALL SELECT * FROM (SELECT email FROM mcp_mask_events OFFSET 0) s",
        "SELECT * FROM (SELECT email FROM mcp_mask_customers UNION ALL SELECT email FROM mcp_mask_customers OFFSET 0) s UNION ALL SELECT 'mara@fjord.se'",
        "SELECT email FROM mcp_mask_people UNION ALL SELECT 'mara@fjord.se'",
        "SELECT email FROM mcp_mask_events f_1 WHERE at = '2026-02-01' UNION ALL SELECT f.email FROM unnest(ARRAY['mara@fjord.se', 'zz']) f(email)",
        "WITH RECURSIVE r(e) AS (SELECT email FROM mcp_mask_events UNION ALL SELECT e FROM r WHERE false) SELECT e FROM r",
        "WITH x AS MATERIALIZED (SELECT email FROM mcp_mask_customers UNION ALL SELECT email FROM mcp_mask_events) SELECT y.email FROM x y",
        "SELECT ARRAY(SELECT email FROM mcp_mask_customers UNION ALL SELECT email FROM mcp_mask_events)",
        "SELECT ARRAY(SELECT email FROM mcp_mask_events)",
        "SELECT s.e FROM (SELECT email AS e, id FROM mcp_mask_customers UNION ALL SELECT email, id FROM mcp_mask_events OFFSET 0) s WHERE s.id > 0",
        "SELECT email FROM mcp_mask_events EXCEPT ALL SELECT 'zz'",
        "SELECT email FROM mcp_mask_people EXCEPT ALL SELECT 'zz'",
        "SELECT id FROM mcp_mask_events WHERE email LIKE 'm%'",
        "SELECT id FROM mcp_mask_view WHERE email > 'm'",
        "SELECT count(email) FILTER (WHERE email LIKE 'm%') FROM mcp_mask_customers",
        "SELECT mcp_mask_lookup(1)",
    ] {
        let err = query(&mcp, sql).await.expect_err(sql);
        assert!(err.starts_with("Refused"), "{sql}: {err}");
        assert!(!err.contains("mara@"), "{sql}: {err}");
    }
    // Postgres names a table read in parts by its alias, numbered when
    // something with no node of its own (another partitioned table, a
    // union's subquery) took it first, and cuts a long one to fit: never
    // the real values.
    let long = "a".repeat(63);
    for sql in [
        "SELECT o.id, x.email FROM mcp_mask_upart o JOIN (SELECT id, email FROM mcp_mask_events o) x ON x.id = o.id".to_string(),
        "SELECT x.email FROM (SELECT 1 AS k UNION ALL SELECT 2) e, (SELECT email FROM mcp_mask_events e) x".to_string(),
        "SELECT x.email FROM (SELECT 1 AS k UNION ALL SELECT 2) p, (SELECT email FROM mcp_mask_people p) x".to_string(),
        format!("SELECT {long}.email FROM mcp_mask_events {long}"),
        format!("SELECT {long}.email FROM mcp_mask_people {long}"),
        format!("SELECT {long}.id FROM mcp_mask_events {long} ORDER BY {long}.email"),
    ] {
        match query(&mcp, &sql).await {
            Ok(out) => assert!(!out["rows"].to_string().contains('@'), "{sql} leaked: {out}"),
            Err(err) => assert!(err.starts_with("Refused"), "{sql}: {err}"),
        }
    }
    // A reused alias with no marked column read is fine.
    for sql in [
        "SELECT id FROM mcp_mask_log_2024 UNION ALL SELECT id FROM mcp_mask_log_2025",
        // A child of a marked table and an unmarked one, read through the
        // unmarked one without the marked column.
        "SELECT t.id, t.tag FROM mcp_mask_tagged t",
        "SELECT t.id FROM mcp_mask_orders t UNION ALL SELECT t.id FROM mcp_mask_customers t",
        "SELECT c.id FROM mcp_mask_orders c WHERE c.customer_id IN (SELECT c.id FROM mcp_mask_people c)",
    ] {
        query(&mcp, sql).await.unwrap_or_else(|e| panic!("{sql}: {e}"));
    }

    // The union cases above are refused for the union, not by chance.
    for sql in [
        "SELECT 'x' UNION ALL SELECT email FROM mcp_mask_customers",
        "SELECT email FROM mcp_mask_customers WHERE id = 1 UNION ALL SELECT 'mara@fjord.se'",
        "SELECT 'x' UNION ALL SELECT * FROM (SELECT email FROM mcp_mask_customers UNION ALL SELECT email FROM mcp_mask_customers OFFSET 0) s",
        "SELECT 'x' UNION ALL SELECT * FROM (SELECT email FROM mcp_mask_events OFFSET 0) s",
        "SELECT * FROM (SELECT email FROM mcp_mask_customers UNION ALL SELECT email FROM mcp_mask_customers OFFSET 0) s UNION ALL SELECT 'mara@fjord.se'",
        "SELECT email FROM mcp_mask_people UNION ALL SELECT 'mara@fjord.se'",
    ] {
        let err = query(&mcp, sql).await.expect_err(sql);
        assert!(err.contains("without the UNION ALL"), "{sql}: {err}");
    }
    // Marked columns of different types can't be followed through a union.
    let err = query(
        &mcp,
        "SELECT email FROM mcp_mask_vc UNION ALL SELECT email FROM mcp_mask_customers",
    )
    .await
    .expect_err("varchar beside text");
    assert!(err.contains("different types"), "{err}");
    // However high an alias's number, the check answers at once.
    let started = std::time::Instant::now();
    match query(
        &mcp,
        "SELECT email FROM mcp_mask_events x_99999999999 UNION ALL SELECT email FROM mcp_mask_customers y",
    )
    .await
    {
        Ok(out) => assert!(!out["rows"].to_string().contains('@'), "{out}"),
        Err(err) => assert!(err.starts_with("Refused"), "{err}"),
    }
    assert!(started.elapsed() < std::time::Duration::from_secs(2));
    // The agent's own `f` beside a partition it named `f_1` is never
    // masked: no stand-in of a guess to compare.
    match query(
        &mcp,
        "SELECT f.email FROM unnest(ARRAY['mara@fjord.se', 'zz']) f(email), mcp_mask_events f_1 WHERE f_1.at = '2026-02-01'",
    )
    .await
    {
        Ok(out) => assert_eq!(out["rows"], json!([["mara@fjord.se"], ["zz"]]), "{out}"),
        Err(err) => assert!(err.starts_with("Refused"), "{err}"),
    }

    // A column alias list renames the masked column in the plan, so a
    // filter on it would go unseen: refused. A plain alias is fine.
    for sql in [
        "SELECT i FROM mcp_mask_customers AS c(i, e) WHERE e LIKE 'm%'",
        "SELECT e FROM mcp_mask_customers c(i, e) ORDER BY e",
        "SELECT o.total FROM mcp_mask_orders o JOIN mcp_mask_customers AS x(i, e) ON x.i = o.customer_id WHERE x.e = 'mara@fjord.se'",
        "SELECT i FROM mcp_mask_events AS ev(i, m) WHERE m LIKE 'm%'",
    ] {
        let err = query(&mcp, sql).await.expect_err(sql);
        assert!(err.starts_with("Refused: this renames"), "{sql}: {err}");
    }
    for sql in [
        "SELECT c.id, c.email FROM mcp_mask_customers c WHERE c.plan = 'pro'",
        "SELECT c.email FROM mcp_mask_customers AS c JOIN mcp_mask_orders o ON o.customer_id = c.id",
        "SELECT x.n FROM (SELECT id AS n FROM mcp_mask_orders) AS x(n)",
    ] {
        let out = query(&mcp, sql)
            .await
            .unwrap_or_else(|e| panic!("{sql}: {e}"));
        assert!(!out["rows"].to_string().contains('@'), "{sql}: {out}");
    }
    // The explain tool holds to the same rule.
    let err = call(
        &mcp,
        "explain",
        json!({ "connection": ID, "sql": "SELECT id FROM mcp_mask_customers WHERE email LIKE 'm%'" }),
    )
    .await
    .expect_err("explain");
    assert!(err.contains("is masked"), "{err}");

    // Nor an index on a partition in another schema, walked here because
    // the planner is told to avoid plain scans.
    session_execute(
        &setup,
        "CREATE INDEX mcp_mask_events_b_email ON mcp_mask_s.events_b (email);
         ALTER ROLE CURRENT_USER SET enable_seqscan = off;
         ALTER ROLE CURRENT_USER SET enable_bitmapscan = off;",
    )
    .await
    .expect("partition index");
    let forced = RowkeryMcp::default();
    let walked = query(&forced, "SELECT email FROM mcp_mask_s.events_b").await;
    let walked_parent = query(&forced, "SELECT email FROM mcp_mask_events").await;
    session_execute(
        &setup,
        "ALTER ROLE CURRENT_USER RESET enable_seqscan; ALTER ROLE CURRENT_USER RESET enable_bitmapscan;",
    )
    .await
    .expect("reset planner");
    for walked in [walked, walked_parent] {
        let err = walked.expect_err("an index on a partition elsewhere");
        assert!(err.contains("mcp_mask_events_b_email"), "{err}");
    }

    // An index on the column (here an expression index) can't be walked for
    // its order. Forced with the planner settings so the plan really uses it.
    session_execute(&setup, "INSERT INTO mcp_mask_customers SELECT g, 'u' || g || '@x.io', 'free' FROM generate_series(4, 3000) g; ANALYZE mcp_mask_customers;")
        .await
        .expect("more rows");
    let err = query(
        &mcp,
        "SELECT id FROM mcp_mask_customers ORDER BY lower(email) LIMIT 1",
    )
    .await
    .expect_err("index order");
    assert!(err.starts_with("Refused"), "{err}");

    // Statistics hold the column's own values (the ANALYZE above put
    // mara@ in pg_stats' most common values): refused, with every table
    // shared, through each view over them. So are the catalogs that hold
    // credentials, through theirs.
    let stats = rowkery_core::db::postgres::session_query_stream(
        &setup,
        "SELECT 1 FROM pg_stats WHERE tablename = 'mcp_mask_customers' AND attname = 'email' AND most_common_vals::text LIKE '%mara@%'",
        |_, _| Ok(()),
    )
    .await
    .expect("stats");
    assert_eq!(stats, 1, "the fixture puts the email in the statistics");
    for sql in [
        "SELECT most_common_vals::text FROM pg_stats WHERE tablename = 'mcp_mask_customers' AND attname = 'email'",
        "SELECT histogram_bounds::text FROM pg_catalog.pg_stats",
        "SELECT stavalues1::text FROM pg_statistic",
        "SELECT stxdmcv::text FROM pg_statistic_ext_data",
        "SELECT s.most_common_vals::text FROM mcp_mask_orders o, pg_stats s LIMIT 1",
    ] {
        let err = query(&mcp, sql).await.expect_err(sql);
        assert_eq!(err, crate::guard::STATISTICS_REFUSAL, "{sql}");
    }
    // The secret columns, by name, as a whole row or behind a view.
    for sql in [
        "SELECT rolname, rolpassword FROM pg_authid",
        "SELECT * FROM pg_authid",
        "SELECT a::text FROM pg_authid a",
        "SELECT rolname FROM pg_authid WHERE rolpassword LIKE 'SCRAM%'",
        "SELECT r.pw FROM (SELECT rolpassword AS pw FROM pg_authid OFFSET 0) r",
        "SELECT s.pw FROM pg_namespace n JOIN (SELECT oid, rolpassword AS pw FROM pg_authid OFFSET 0) s ON s.oid = n.nspowner",
        "SELECT usename, passwd FROM pg_shadow",
        "SELECT * FROM pg_shadow",
        "SELECT umoptions::text FROM pg_user_mappings",
        "SELECT * FROM pg_user_mapping",
        "SELECT * FROM information_schema.user_mapping_options",
        "SELECT subconninfo FROM pg_subscription",
    ] {
        let err = query(&mcp, sql).await.expect_err(sql);
        assert_eq!(err, crate::guard::CREDENTIALS_REFUSAL, "{sql}");
    }
    // Renamed columns can't be followed: refused.
    for sql in [
        "SELECT pw FROM pg_authid AS a(i, n, s, h, r, d, l, c, b, k, pw, u)",
        "SELECT a.rolname FROM pg_authid a(oid, rolpassword, s, h, r, d, l, c, b, k, rolname)",
        "SELECT x.n FROM pg_namespace n JOIN pg_authid AS x(o, n) ON x.o = n.nspowner",
    ] {
        let err = query(&mcp, sql).await.expect_err(sql);
        assert_eq!(err, crate::guard::CREDENTIALS_RENAMED, "{sql}");
    }
    // The rest of those catalogs stays open: role names and owners, and the
    // information_schema views over them.
    for sql in [
        "SELECT rolname, rolsuper FROM pg_roles",
        "SELECT * FROM pg_roles",
        "SELECT usename, passwd FROM pg_user",
        "SELECT rolname FROM pg_authid WHERE rolcanlogin",
        "SELECT n.nspname, r.rolname FROM pg_namespace n JOIN pg_roles r ON r.oid = n.nspowner",
        "SELECT c.relname, r.rolname FROM pg_class c JOIN pg_roles r ON r.oid = c.relowner WHERE c.relname = 'mcp_mask_orders'",
        "SELECT s.rolname FROM pg_namespace n JOIN (SELECT * FROM pg_authid OFFSET 0) s ON s.oid = n.nspowner",
        "SELECT * FROM information_schema.schemata",
        "SELECT * FROM information_schema.table_privileges WHERE table_name = 'mcp_mask_orders'",
        "SELECT * FROM information_schema.role_table_grants WHERE table_name = 'mcp_mask_orders'",
        "SELECT * FROM information_schema.column_privileges WHERE table_name = 'mcp_mask_orders'",
        "SELECT * FROM information_schema.enabled_roles",
        "SELECT * FROM information_schema.applicable_roles",
        "SELECT * FROM pg_group",
        "SELECT srvname, usename FROM pg_user_mappings",
        "SELECT subname FROM pg_subscription",
    ] {
        query(&mcp, sql)
            .await
            .unwrap_or_else(|e| panic!("{sql}: {e}"));
    }
    // Views that call functions off the list are refused for those first.
    for sql in [
        "SELECT * FROM pg_stats_ext",
        "SELECT * FROM pg_stats_ext_exprs",
        "SELECT * FROM pg_stat_subscription",
    ] {
        let err = query(&mcp, sql).await.expect_err(sql);
        assert!(err.starts_with("Refused"), "{sql}: {err}");
    }
    let err = call(
        &mcp,
        "explain",
        json!({ "connection": ID, "sql": "SELECT * FROM pg_stats" }),
    )
    .await
    .expect_err("explain stats");
    assert_eq!(err, crate::guard::STATISTICS_REFUSAL);
    // The views that describe tables stay open.
    for sql in [
        "SELECT column_name FROM information_schema.columns WHERE table_name = 'mcp_mask_orders'",
        "SELECT tablename, tableowner FROM pg_tables WHERE tablename = 'mcp_mask_orders'",
    ] {
        query(&mcp, sql)
            .await
            .unwrap_or_else(|e| panic!("{sql}: {e}"));
    }

    // describe_table names the masked columns, so agents don't try.
    let described = call(
        &mcp,
        "describe_table",
        json!({ "connection": ID, "table": "mcp_mask_customers" }),
    )
    .await
    .expect("describe");
    assert_eq!(described["masked"], json!(["email"]));

    // A marked column that has gone (renamed) stops the table being read.
    session_execute(
        &setup,
        "ALTER TABLE mcp_mask_customers RENAME COLUMN email TO mail",
    )
    .await
    .expect("rename");
    let _ = call(
        &mcp,
        "list_tables",
        json!({ "connection": ID, "refresh": true }),
    )
    .await;
    let err = query(&mcp, "SELECT mail FROM mcp_mask_customers")
        .await
        .expect_err("renamed");
    assert!(err.contains("no longer in the table"), "{err}");

    // Nothing masked and nothing hidden: statistics show nothing the agent
    // can't read anyway, but credentials stay refused.
    pg.masked_columns = Default::default();
    save(pg);
    query(
        &mcp,
        "SELECT attname FROM pg_stats WHERE tablename = 'mcp_mask_customers'",
    )
    .await
    .expect("statistics with nothing kept back");
    let err = query(&mcp, "SELECT rolpassword FROM pg_authid")
        .await
        .expect_err("credentials");
    assert_eq!(err, crate::guard::CREDENTIALS_REFUSAL);

    session_execute(
        &setup,
        "DROP TABLE IF EXISTS mcp_mask_customers, mcp_mask_orders, mcp_mask_events, mcp_mask_people, mcp_mask_tagged, mcp_mask_upart, mcp_mask_log_2024, mcp_mask_log_2025, mcp_mask_vc CASCADE;
         DROP SCHEMA IF EXISTS mcp_mask_s CASCADE;
         DROP FUNCTION IF EXISTS mcp_mask_lookup(int);",
    )
    .await
    .expect("cleanup");
    std::env::remove_var("ROWKERY_CONFIG_DIR");
    let _ = std::fs::remove_dir_all(dir);
}

// The env lock spans the whole test, awaits included: each test has its own runtime.
#[allow(clippy::await_holding_lock)]
#[tokio::test]
async fn proposed_changes_hold_against_a_real_postgres() {
    use crate::proposals::{self, tests::seen, CommitOutcome};
    let dir = std::env::temp_dir().join(format!("rowkery-mcp-e2e-propose-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    let _env = crate::ENV_LOCK.lock().unwrap_or_else(|e| e.into_inner());
    std::env::set_var("ROWKERY_CONFIG_DIR", dir.to_string_lossy().to_string());
    let password = std::env::var("ROWKERY_PG_PASSWORD").unwrap_or_else(|_| "rowkery".into());
    store_secret(ID, SecretKind::DbPassword, &password).expect("store password");

    let setup = open_session(ID.into(), pg_config()).await.expect("connect");
    session_execute(
        &setup,
        "DROP TABLE IF EXISTS mcp_p_orders, mcp_p_customers, mcp_p_hidden, mcp_p_log, mcp_p_serial, mcp_p_ident,
           mcp_p_peeks, mcp_p_other CASCADE;
         DROP FUNCTION IF EXISTS mcp_p_peek() CASCADE;
         DROP SEQUENCE IF EXISTS mcp_p_other_seq;
         CREATE TABLE mcp_p_serial (id serial PRIMARY KEY, note text, at timestamptz DEFAULT now(),
           pid int DEFAULT pg_backend_pid());
         CREATE TABLE mcp_p_ident (id int GENERATED ALWAYS AS IDENTITY PRIMARY KEY, note text);
         DROP FUNCTION IF EXISTS mcp_p_fn(int);
         DROP FUNCTION IF EXISTS mcp_p_trg() CASCADE;
         CREATE TABLE mcp_p_customers (id int PRIMARY KEY, email text, plan text, seats int);
         INSERT INTO mcp_p_customers VALUES (1, 'a@b.c', 'team', 5), (2, 'd@e.f', 'team', 8);
         CREATE TABLE mcp_p_orders (id int PRIMARY KEY, status text, note text);
         INSERT INTO mcp_p_orders VALUES (1, 'pending', null), (2, 'pending', null), (3, 'paid', null);
         CREATE TABLE mcp_p_hidden (id int PRIMARY KEY);
         INSERT INTO mcp_p_hidden VALUES (4242);
         CREATE FUNCTION mcp_p_peek() RETURNS text LANGUAGE plpgsql AS
           $$ BEGIN RETURN (SELECT max(id)::text FROM mcp_p_hidden); END $$;
         CREATE TABLE mcp_p_peeks (id serial PRIMARY KEY, note text DEFAULT mcp_p_peek(), n int);
         CREATE SEQUENCE mcp_p_other_seq;
         CREATE TABLE mcp_p_other (id bigint PRIMARY KEY DEFAULT nextval('mcp_p_other_seq'), n int);
         CREATE TABLE mcp_p_log (msg text);
         CREATE FUNCTION mcp_p_fn(int) RETURNS int LANGUAGE sql AS 'SELECT $1';
         CREATE FUNCTION mcp_p_trg() RETURNS trigger LANGUAGE plpgsql AS
           $$ BEGIN INSERT INTO mcp_p_log VALUES ('changed'); RETURN NEW; END $$;
         CREATE TRIGGER mcp_p_audit AFTER UPDATE ON mcp_p_orders FOR EACH ROW EXECUTE FUNCTION mcp_p_trg();
         CREATE TRIGGER mcp_p_cust_new BEFORE INSERT ON mcp_p_customers FOR EACH ROW EXECUTE FUNCTION mcp_p_trg();
         CREATE TRIGGER mcp_p_cust_off AFTER UPDATE ON mcp_p_customers FOR EACH ROW EXECUTE FUNCTION mcp_p_trg();
         ALTER TABLE mcp_p_customers DISABLE TRIGGER mcp_p_cust_off;",
    )
    .await
    .expect("fixtures");

    let mut pg = pg_config();
    pg.allow_mcp = true;
    pg.mcp_access = Some(
        [(
            pg.database.clone(),
            McpDbAccess {
                mode: McpTableMode::Picked,
                tables: vec![
                    "public.mcp_p_orders".into(),
                    "public.mcp_p_customers".into(),
                    "public.mcp_p_serial".into(),
                    "public.mcp_p_ident".into(),
                    "public.mcp_p_peeks".into(),
                    "public.mcp_p_other".into(),
                ],
            },
        )]
        .into_iter()
        .collect(),
    );
    pg.masked_columns = [(
        pg.database.clone(),
        vec!["public.mcp_p_customers.email".to_string()],
    )]
    .into_iter()
    .collect();
    save(pg.clone());
    let mcp = RowkeryMcp::default();
    let propose = |sql: &str| {
        call(
            &mcp,
            "propose_change",
            json!({ "connection": ID, "sql": sql, "reason": "test" }),
        )
    };

    for sql in [
        "DELETE FROM mcp_p_hidden",
        "UPDATE mcp_p_orders SET note = 'x' WHERE id IN (SELECT id FROM mcp_p_hidden)",
        "UPDATE mcp_p_customers SET plan = 'pro' WHERE email = 'a@b.c'",
        "UPDATE mcp_p_customers SET email = 'x' WHERE id = 1",
        "UPDATE mcp_p_orders SET note = (SELECT email FROM mcp_p_customers WHERE id = 1)",
        "INSERT INTO mcp_p_orders (id, status, note) SELECT id + 10, 'x', c::text FROM mcp_p_customers c",
        "UPDATE mcp_p_orders SET note = mcp_p_fn(1)::text",
        "UPDATE mcp_p_orders SET note = pg_read_file('/etc/hostname')",
        "TRUNCATE mcp_p_orders",
        "SELECT 1",
        "UPDATE mcp_p_orders SET note = (SELECT rolpassword FROM pg_authid LIMIT 1)",
        "UPDATE mcp_p_orders SET note = (SELECT most_common_vals::text FROM pg_stats LIMIT 1)",
        "UPDATE mcp_p_orders SET note = (SELECT e FROM mcp_p_customers AS c(i, e) WHERE i = 1)",
    ] {
        let err = propose(sql).await.expect_err(sql);
        assert!(err.starts_with("Refused"), "{sql}: {err}");
    }

    // A default written in plpgsql runs what the plan can't show (here it
    // reads the hidden table), and nextval on another table's sequence
    // isn't the table's own: both are checked like the agent's SQL.
    for (sql, said) in [
        (
            "INSERT INTO mcp_p_peeks (n) VALUES (1)",
            "mcp_p_peek() is defined",
        ),
        (
            "UPDATE mcp_p_peeks SET note = DEFAULT WHERE id = 1",
            "mcp_p_peek() is defined",
        ),
        (
            "INSERT INTO mcp_p_other (n) VALUES (1)",
            "nextval() changes",
        ),
    ] {
        let err = propose(sql).await.expect_err(sql);
        assert!(
            err.starts_with("Refused") && err.contains(said),
            "{sql}: {err}"
        );
    }

    // A table's own compiled defaults fill in a serial or identity key
    // (nextval, in the plan) or a built-in like pg_backend_pid(); a call
    // the agent writes is still refused.
    for sql in [
        "INSERT INTO mcp_p_serial (note) VALUES ('a')",
        "INSERT INTO mcp_p_serial VALUES (DEFAULT, 'b')",
        "INSERT INTO mcp_p_ident (note) VALUES ('c')",
        "INSERT INTO mcp_p_ident (note) SELECT status FROM mcp_p_orders WHERE id = 1",
    ] {
        let sent = propose(sql).await.unwrap_or_else(|e| panic!("{sql}: {e}"));
        proposals::reject(sent["id"].as_str().unwrap(), None).expect("reject");
    }
    for (sql, said) in [
        (
            "INSERT INTO mcp_p_serial (id, note) VALUES (nextval('mcp_p_serial_id_seq'), 'd')",
            "nextval() changes",
        ),
        (
            "INSERT INTO mcp_p_serial (note) VALUES (setval('mcp_p_serial_id_seq', 1)::text)",
            "setval() changes",
        ),
        (
            "INSERT INTO mcp_p_ident (note) VALUES (pg_read_file('/etc/hostname'))",
            "pg_read_file() reads",
        ),
        (
            "UPDATE mcp_p_serial SET note = nextval('mcp_p_ident_id_seq')::text",
            "nextval() changes",
        ),
        (
            "INSERT INTO mcp_p_ident (note) VALUES (pg_backend_pid()::text)",
            "pg_backend_pid() isn't one",
        ),
    ] {
        let err = propose(sql).await.expect_err(sql);
        assert!(
            err.starts_with("Refused") && err.contains(said),
            "{sql}: {err}"
        );
    }
    let serial = propose("INSERT INTO mcp_p_serial (note) VALUES ('e')")
        .await
        .expect("serial insert");
    let serial = serial["id"].as_str().unwrap();
    let run = proposals::dry_run(serial).await.expect("serial dry run");
    assert_eq!(run.statements[0].rows, 1);
    proposals::reject(serial, None).expect("reject");
    // A blank reason is asked for, not reported as a missing argument.
    let blank = call(
        &mcp,
        "propose_change",
        json!({ "connection": ID, "sql": "DELETE FROM mcp_p_orders WHERE id = 1", "reason": " " }),
    )
    .await
    .expect_err("blank reason");
    assert!(blank.starts_with("Say why"), "{blank}");

    // Two statements, several columns: the dry run shows old and new rows.
    let sent = propose(
        "UPDATE mcp_p_orders SET status = 'refunded' WHERE status = 'pending';
         UPDATE mcp_p_customers SET plan = 'business', seats = 25 WHERE id IN (1, 2)",
    )
    .await
    .expect("propose");
    let id = sent["id"].as_str().unwrap().to_string();

    // Opening the review runs nothing; it lists the triggers each
    // statement's event fires: not an INSERT trigger, not a disabled one.
    let planned = proposals::plan(&id).await.expect("plan");
    assert_eq!(planned.statements.len(), 2);
    assert_eq!(planned.statements[0].verb.as_deref(), Some("UPDATE"));
    assert_eq!(
        planned.statements[0].target.as_deref(),
        Some("mcp_p_orders")
    );
    assert_eq!(
        planned.statements[0].triggers,
        vec![proposals::PlannedTrigger {
            name: "mcp_p_audit".into(),
            event: "UPDATE".into()
        }]
    );
    assert!(planned.statements[1].triggers.is_empty());
    let untouched = query(
        &mcp,
        "SELECT count(*) FROM mcp_p_orders WHERE status = 'pending'",
    )
    .await
    .unwrap();
    assert_eq!(untouched["rows"], json!([[2]]), "the plan ran nothing");

    // Another session holds a row the change needs: the dry run stops at
    // its short lock timeout instead of waiting.
    let holder = open_session(ID.into(), pg_config()).await.expect("connect");
    session_execute(
        &holder,
        "BEGIN; SELECT * FROM mcp_p_orders WHERE id = 1 FOR UPDATE",
    )
    .await
    .unwrap();
    let started = std::time::Instant::now();
    let held = proposals::dry_run(&id).await.expect_err("lock held");
    assert!(held.starts_with("Another session is holding"), "{held}");
    assert!(started.elapsed() < std::time::Duration::from_secs(5));
    session_execute(&holder, "ROLLBACK").await.unwrap();

    let run = proposals::dry_run(&id).await.expect("dry run");
    let (orders, customers) = (&run.statements[0], &run.statements[1]);
    assert_eq!(orders.rows, 2);
    assert_eq!(orders.changed, vec!["status".to_string()]);
    assert_eq!(orders.triggers, vec!["mcp_p_audit".to_string()]);
    assert_eq!(
        orders.shown[0].before.as_ref().unwrap()[1],
        json!("pending")
    );
    assert_eq!(
        orders.shown[0].after.as_ref().unwrap()[1],
        json!("refunded")
    );
    assert_eq!(
        customers.changed,
        vec!["plan".to_string(), "seats".to_string()]
    );
    let still = query(
        &mcp,
        "SELECT count(*) FROM mcp_p_orders WHERE status = 'pending'",
    )
    .await
    .unwrap();
    assert_eq!(still["rows"], json!([[2]]), "the dry run saved nothing");

    // The data moves: nothing is saved and a fresh dry run comes back.
    session_execute(
        &setup,
        "UPDATE mcp_p_orders SET status = 'pending' WHERE id = 3",
    )
    .await
    .unwrap();
    match proposals::commit(&id, &seen(&[2, 2])).await.unwrap() {
        CommitOutcome::Moved { dry_run } => assert_eq!(dry_run.statements[0].rows, 3),
        other => panic!("{other:?}"),
    }
    match proposals::commit(&id, &seen(&[3, 2])).await.unwrap() {
        CommitOutcome::Committed { rows } => assert_eq!(rows, vec![3, 2]),
        other => panic!("{other:?}"),
    }
    let done = call(&mcp, "check_proposal", json!({ "id": id }))
        .await
        .unwrap();
    assert_eq!(done["state"], "committed");
    let seats = query(&mcp, "SELECT sum(seats) FROM mcp_p_customers")
        .await
        .unwrap();
    assert_eq!(seats["rows"], json!([[50]]));

    // A commit checks the change again in its own transaction, where
    // `'now'` folds the same way for the check and the run.
    let flip = format!(
        "UPDATE mcp_p_orders SET note = (SELECT max(id)::text FROM mcp_p_hidden \
         WHERE {NOW_COIN}) WHERE id = 1"
    );
    let (mut committed, mut refused) = (0, 0);
    // A commit lands only when its three checks (propose, commit, and in
    // the commit's transaction) all come up clean, about one try in eight.
    for _ in 0..300 {
        if committed >= 5 && refused > 0 {
            break;
        }
        let id = match propose(&flip).await {
            Ok(sent) => sent["id"].as_str().unwrap().to_string(),
            Err(err) => {
                assert_eq!(err, crate::guard::HIDDEN_REFUSAL);
                refused += 1;
                continue;
            }
        };
        match proposals::commit(&id, &seen(&[1])).await {
            Ok(CommitOutcome::Committed { .. }) => committed += 1,
            Ok(CommitOutcome::Failed { error }) | Err(error) => {
                assert_eq!(error, crate::guard::HIDDEN_REFUSAL);
                refused += 1;
            }
            Ok(other) => panic!("{other:?}"),
        }
        // A refused commit leaves the proposal waiting; the queue holds five.
        let _ = proposals::reject(&id, None);
        let note = query(&mcp, "SELECT note FROM mcp_p_orders WHERE id = 1")
            .await
            .unwrap();
        assert_ne!(
            note["rows"],
            json!([["4242"]]),
            "the commit read the hidden table"
        );
    }
    assert!(
        committed > 0 && refused > 0,
        "{committed} committed, {refused} refused"
    );

    // Read-only connections take no proposals.
    pg.safe_mode = rowkery_core::safety::SafeMode::ReadOnly;
    save(pg);
    let err = propose("DELETE FROM mcp_p_orders WHERE id = 1")
        .await
        .expect_err("read-only");
    assert!(err.contains("Read-only"), "{err}");
    std::env::remove_var("ROWKERY_CONFIG_DIR");
}

// The env lock spans the whole test, awaits included: each test has its own runtime.
#[allow(clippy::await_holding_lock)]
#[tokio::test]
async fn a_proposal_counts_what_its_cascades_and_triggers_write() {
    use crate::proposals::{self, CommitOutcome, DryRun, Seen};
    let dir = std::env::temp_dir().join(format!("rowkery-mcp-e2e-reach-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    let _env = crate::ENV_LOCK.lock().unwrap_or_else(|e| e.into_inner());
    std::env::set_var("ROWKERY_CONFIG_DIR", dir.to_string_lossy().to_string());
    let password = std::env::var("ROWKERY_PG_PASSWORD").unwrap_or_else(|_| "rowkery".into());
    store_secret(ID, SecretKind::DbPassword, &password).expect("store password");
    let setup = open_session(ID.into(), pg_config()).await.expect("connect");
    session_execute(
        &setup,
        "DROP TABLE IF EXISTS mcp_r_customers, mcp_r_orders, mcp_r_payments, mcp_r_log CASCADE;
         DROP FUNCTION IF EXISTS mcp_r_note() CASCADE;
         CREATE TABLE mcp_r_customers (id int PRIMARY KEY);
         CREATE TABLE mcp_r_orders (id int PRIMARY KEY,
           customer int REFERENCES mcp_r_customers ON DELETE CASCADE);
         CREATE TABLE mcp_r_payments (id int, customer int REFERENCES mcp_r_customers ON DELETE CASCADE)
           PARTITION BY RANGE (id);
         CREATE TABLE mcp_r_payments_a PARTITION OF mcp_r_payments FOR VALUES FROM (0) TO (100);
         CREATE TABLE mcp_r_payments_b PARTITION OF mcp_r_payments FOR VALUES FROM (100) TO (200);
         CREATE TABLE mcp_r_log (what text);
         CREATE FUNCTION mcp_r_note() RETURNS trigger LANGUAGE plpgsql AS
           $$ BEGIN INSERT INTO mcp_r_log VALUES (TG_TABLE_NAME); RETURN NULL; END $$;
         CREATE TRIGGER mcp_r_gone AFTER DELETE ON mcp_r_orders FOR EACH ROW EXECUTE FUNCTION mcp_r_note();
         CREATE CONSTRAINT TRIGGER mcp_r_late AFTER DELETE ON mcp_r_customers
           DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION mcp_r_note();
         INSERT INTO mcp_r_customers VALUES (1), (2);
         INSERT INTO mcp_r_orders SELECT g, 1 + g % 2 FROM generate_series(1, 20) g;
         INSERT INTO mcp_r_payments VALUES (5, 1), (150, 1), (6, 2);",
    )
    .await
    .expect("fixtures");
    let mut pg = pg_config();
    pg.allow_mcp = true;
    pg.mcp_access = Some(
        [(
            pg.database.clone(),
            McpDbAccess {
                mode: McpTableMode::Picked,
                tables: vec![
                    "public.mcp_r_customers".into(),
                    "public.mcp_r_orders".into(),
                ],
            },
        )]
        .into_iter()
        .collect(),
    );
    save(pg);
    let mcp = RowkeryMcp::default();
    let sent = call(
        &mcp,
        "propose_change",
        json!({ "connection": ID, "sql": "DELETE FROM mcp_r_customers WHERE id = 1", "reason": "test" }),
    )
    .await
    .expect("a cascade into tables not shared is allowed");
    let id = sent["id"].as_str().unwrap().to_string();

    let counts = |run: &DryRun| -> Vec<(String, u64, u64)> {
        run.statements[0]
            .reach
            .as_ref()
            .unwrap()
            .tables
            .iter()
            .map(|t| (t.table.clone(), t.inserted, t.deleted))
            .collect()
    };
    let run = proposals::dry_run(&id).await.expect("dry run");
    assert_eq!(run.statements[0].rows, 1);
    assert_eq!(
        run.statements[0].table,
        Some(["public".to_string(), "mcp_r_customers".to_string()])
    );
    // Partitions count under their table; the trigger's inserts are counted.
    assert_eq!(
        counts(&run),
        [
            ("mcp_r_customers".to_string(), 0, 1),
            ("mcp_r_log".to_string(), 10, 0),
            ("mcp_r_orders".to_string(), 0, 10),
            ("mcp_r_payments".to_string(), 0, 2),
        ]
    );
    // The deferred trigger fired before the rollback, as COMMIT would.
    let late = run.at_commit.clone().unwrap();
    assert_eq!(
        (
            late.tables.len(),
            late.tables[0].table.as_str(),
            late.tables[0].inserted
        ),
        (1, "mcp_r_log", 1)
    );
    assert_eq!(
        run.unshared,
        [
            ["public".to_string(), "mcp_r_log".to_string()],
            ["public".to_string(), "mcp_r_payments".to_string()],
        ]
    );
    let saw = |run: &DryRun| Seen {
        rows: vec![run.statements[0].rows],
        reach: vec![run.statements[0].reach.clone()],
        at_commit: run.at_commit.clone(),
    };

    // A payment lands in another partition: one customer still, but the
    // cascade now reaches three payments, so nothing is saved.
    session_execute(&setup, "INSERT INTO mcp_r_payments VALUES (151, 1)")
        .await
        .unwrap();
    let again = match proposals::commit(&id, &saw(&run)).await.unwrap() {
        CommitOutcome::Moved { dry_run } => *dry_run,
        other => panic!("{other:?}"),
    };
    assert_eq!(counts(&again)[3], ("mcp_r_payments".to_string(), 0, 3));
    let left = query(&mcp, "SELECT count(*) FROM mcp_r_orders")
        .await
        .unwrap();
    assert_eq!(left["rows"], json!([[20]]), "nothing saved");

    match proposals::commit(&id, &saw(&again)).await.unwrap() {
        CommitOutcome::Committed { rows } => assert_eq!(rows, vec![1]),
        other => panic!("{other:?}"),
    }
    let left = query(&mcp, "SELECT count(*) FROM mcp_r_orders")
        .await
        .unwrap();
    assert_eq!(left["rows"], json!([[10]]));
    // The agent hears its own statement's rows, nothing about the others.
    let done = call(&mcp, "check_proposal", json!({ "id": id }))
        .await
        .unwrap();
    assert!(!done.to_string().contains("payments"), "{done}");
    std::env::remove_var("ROWKERY_CONFIG_DIR");
}

// The env lock spans the whole test, awaits included: each test has its own runtime.
#[allow(clippy::await_holding_lock)]
#[tokio::test]
async fn a_slow_call_holds_up_only_its_own_connection() {
    let dir = std::env::temp_dir().join(format!("rowkery-mcp-e2e-slow-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    let _env = crate::ENV_LOCK.lock().unwrap_or_else(|e| e.into_inner());
    std::env::set_var("ROWKERY_CONFIG_DIR", dir.to_string_lossy().to_string());
    let password = std::env::var("ROWKERY_PG_PASSWORD").unwrap_or_else(|_| "rowkery".into());
    let ids = [ID, "mcp-e2e-pg-other"];
    for id in ids {
        store_secret(id, SecretKind::DbPassword, &password).expect("store password");
    }
    let setup = open_session(ID.into(), pg_config()).await.expect("connect");
    session_execute(
        &setup,
        "DROP TABLE IF EXISTS mcp_slow_locked; CREATE TABLE mcp_slow_locked (id int)",
    )
    .await
    .expect("fixtures");
    let mut config = AppConfig::default();
    for id in ids {
        let mut pg = pg_config();
        pg.id = id.into();
        pg.name = id.into();
        pg.allow_mcp = true;
        config.upsert_connection(ConnectionRecord::Postgres(pg));
    }
    config.save().expect("save config");
    let mcp = RowkeryMcp::default();

    // A read held up by a lock, well inside its statement timeout.
    session_execute(&setup, "BEGIN; LOCK TABLE mcp_slow_locked")
        .await
        .expect("lock");
    let held = tokio::spawn({
        let mcp = mcp.clone();
        async move { query(&mcp, "SELECT count(*) FROM mcp_slow_locked").await }
    });
    tokio::time::sleep(std::time::Duration::from_millis(300)).await;
    assert!(!held.is_finished(), "the read should wait for the lock");

    // Another connection answers meanwhile.
    let other = tokio::time::timeout(
        std::time::Duration::from_secs(3),
        call(
            &mcp,
            "query",
            json!({ "connection": "mcp-e2e-pg-other", "sql": "SELECT 1" }),
        ),
    )
    .await
    .expect("the other connection waited behind the slow call");
    assert_eq!(other.expect("other")["rows"], json!([[1]]));
    assert!(!held.is_finished());
    let listed = call(&mcp, "list_connections", json!({})).await;
    assert!(listed.is_ok());

    session_execute(&setup, "ROLLBACK").await.expect("unlock");
    let read = held.await.expect("join").expect("read");
    assert_eq!(read["rows"], json!([[0]]));

    // A database that isn't there leaves nothing behind.
    let database = pg_config().database;
    let missing = call(
        &mcp,
        "query",
        json!({ "connection": ID, "database": "mcp_no_such_db", "sql": "SELECT 1" }),
    )
    .await;
    assert!(missing.is_err());
    assert!(!mcp
        .stores()
        .contains_key(&(ID.to_string(), "mcp_no_such_db".to_string())));

    // Unsharing a connection drops its session on the next call, whichever.
    let other = ("mcp-e2e-pg-other".to_string(), database.clone());
    assert!(mcp.stores().contains_key(&other));
    config.connections.retain(|c| c.id() == ID);
    config.save().expect("save config");
    call(&mcp, "list_connections", json!({}))
        .await
        .expect("list");
    assert!(!mcp.stores().contains_key(&other));
    assert!(mcp.stores().contains_key(&(ID.to_string(), database)));

    session_execute(&setup, "DROP TABLE mcp_slow_locked")
        .await
        .expect("cleanup");
    std::env::remove_var("ROWKERY_CONFIG_DIR");
    let _ = std::fs::remove_dir_all(&dir);
}

// The env lock spans the whole test, awaits included: each test has its own runtime.
#[allow(clippy::await_holding_lock)]
#[tokio::test]
async fn guards_go_ahead_of_every_call() {
    let dir = std::env::temp_dir().join(format!("rowkery-mcp-e2e-g-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    let _env = crate::ENV_LOCK.lock().unwrap_or_else(|e| e.into_inner());
    std::env::set_var("ROWKERY_CONFIG_DIR", dir.to_string_lossy().to_string());
    let password = std::env::var("ROWKERY_PG_PASSWORD").unwrap_or_else(|_| "rowkery".into());
    store_secret(ID, SecretKind::DbPassword, &password).expect("store password");
    let mut pg = pg_config();
    pg.allow_mcp = true;
    save(pg);
    let target = crate::target::resolve(&AppConfig::load().unwrap(), ID, None).unwrap();
    let mut store = crate::target::Store::default();

    // A read puts them back, read-only too.
    store
        .loosen(
            &target,
            "SET statement_timeout = 0; SET default_transaction_read_only = off",
        )
        .await;
    let read = store
        .read(
            &target,
            "SELECT current_setting('statement_timeout'), current_setting('default_transaction_read_only')",
        )
        .await
        .expect("read");
    assert_eq!(
        read.rows,
        vec![vec![
            rowkery_core::Value::Text("10s".into()),
            rowkery_core::Value::Text("on".into())
        ]]
    );
    // So does every other call.
    for call in ["databases", "catalog", "activity"] {
        store
            .loosen(
                &target,
                "SET statement_timeout = 0; SET enable_partition_pruning = off",
            )
            .await;
        match call {
            "databases" => drop(store.list_databases(&target).await.expect(call)),
            "catalog" => drop(store.catalog(&target, true).await.expect(call)),
            _ => drop(store.activity(&target).await.expect(call)),
        }
        assert_eq!(
            store.setting(&target, "statement_timeout").await,
            "10s",
            "{call}"
        );
        assert_eq!(
            store.setting(&target, "enable_partition_pruning").await,
            "on",
            "{call}"
        );
    }

    // An unpruned read turns pruning off for itself only, even when it fails.
    let pruning = "SELECT current_setting('enable_partition_pruning')";
    let off = vec![vec![rowkery_core::Value::Text("off".into())]];
    let on = vec![vec![rowkery_core::Value::Text("on".into())]];
    assert_eq!(
        store
            .read_unpruned(&target, pruning)
            .await
            .expect("unpruned")
            .rows,
        off
    );
    assert!(store.read_unpruned(&target, "SELECT nope").await.is_err());
    assert_eq!(store.read(&target, pruning).await.expect("read").rows, on);

    // On a commit's adopted session, inside its owner's transaction, it's
    // put back straight after: the change then plans as usual.
    let session = open_session(ID.into(), pg_config()).await.expect("connect");
    session_execute(&session, "BEGIN").await.expect("begin");
    let mut adopted = crate::target::Store::on_session(&target, session);
    assert_eq!(
        adopted
            .read_unpruned(&target, pruning)
            .await
            .expect("adopted")
            .rows,
        off
    );
    assert_eq!(
        adopted.setting(&target, "enable_partition_pruning").await,
        "on"
    );
    let session = adopted.into_session(&target).expect("session");
    session_execute(&session, "ROLLBACK")
        .await
        .expect("rollback");
    std::env::remove_var("ROWKERY_CONFIG_DIR");
}

// The env lock spans the whole test, awaits included: each test has its own runtime.
#[allow(clippy::await_holding_lock)]
#[tokio::test]
async fn a_longer_query_limit_lets_a_read_run_past_the_default() {
    let dir = std::env::temp_dir().join(format!("rowkery-mcp-e2e-limit-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    let _env = crate::ENV_LOCK.lock().unwrap_or_else(|e| e.into_inner());
    std::env::set_var("ROWKERY_CONFIG_DIR", dir.to_string_lossy().to_string());
    let password = std::env::var("ROWKERY_PG_PASSWORD").unwrap_or_else(|_| "rowkery".into());
    store_secret(ID, SecretKind::DbPassword, &password).expect("store password");
    let setup = open_session(ID.into(), pg_config()).await.expect("connect");
    session_execute(
        &setup,
        "DROP TABLE IF EXISTS mcp_limit_locked; CREATE TABLE mcp_limit_locked (id int)",
    )
    .await
    .expect("fixtures");
    let share = |limit: Option<u64>| {
        let mut pg = pg_config();
        pg.allow_mcp = true;
        pg.mcp_timeout_s = limit;
        save(pg);
    };
    let mcp = RowkeryMcp::default();
    let locked = "SELECT count(*) FROM mcp_limit_locked";

    // 30 s: a read held up past the default 10 s and the old 20 s call
    // limit still answers once the lock goes.
    share(Some(30));
    session_execute(&setup, "BEGIN; LOCK TABLE mcp_limit_locked")
        .await
        .expect("lock");
    let held = tokio::spawn({
        let mcp = mcp.clone();
        async move { query(&mcp, locked).await }
    });
    tokio::time::sleep(std::time::Duration::from_secs(22)).await;
    assert!(
        !held.is_finished(),
        "the read should still wait for the lock"
    );
    session_execute(&setup, "ROLLBACK").await.expect("unlock");
    let read = held.await.expect("join").expect("read");
    assert_eq!(read["rows"], json!([[0]]));

    // Unset: stopped at 10 s, and the message says so.
    share(None);
    session_execute(&setup, "BEGIN; LOCK TABLE mcp_limit_locked")
        .await
        .expect("lock");
    let started = std::time::Instant::now();
    let err = query(&mcp, locked).await.expect_err("timed out");
    assert!(started.elapsed() < std::time::Duration::from_secs(15));
    assert!(err.contains("10 s"), "{err}");
    session_execute(&setup, "ROLLBACK").await.expect("unlock");

    // Sharing turned off while a read waits: its answer isn't sent.
    share(Some(30));
    session_execute(&setup, "BEGIN; LOCK TABLE mcp_limit_locked")
        .await
        .expect("lock");
    let held = tokio::spawn({
        let mcp = mcp.clone();
        async move { query(&mcp, locked).await }
    });
    tokio::time::sleep(std::time::Duration::from_millis(500)).await;
    save(pg_config());
    session_execute(&setup, "ROLLBACK").await.expect("unlock");
    let err = held.await.expect("join").expect_err("dropped");
    assert!(err.contains("dropped"), "{err}");

    // One session, its limit lowered: the next statement runs under it.
    let mut store = crate::target::Store::default();
    let setting = "SELECT current_setting('statement_timeout')";
    for (limit, want) in [(Some(300), "5min"), (None, "10s")] {
        share(limit);
        let target = crate::target::resolve(&AppConfig::load().unwrap(), ID, None).unwrap();
        let read = store.read(&target, setting).await.expect("read");
        assert_eq!(
            read.rows,
            vec![vec![rowkery_core::Value::Text(want.into())]]
        );
    }

    session_execute(&setup, "DROP TABLE mcp_limit_locked")
        .await
        .expect("cleanup");
    std::env::remove_var("ROWKERY_CONFIG_DIR");
    let _ = std::fs::remove_dir_all(&dir);
}
