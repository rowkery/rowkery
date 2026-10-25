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
        "DROP TABLE IF EXISTS mcp_e2e_secret, mcp_e2e_visible, mcp_e2e_big CASCADE;
         DROP VIEW IF EXISTS mcp_e2e_secret_view;
         DROP FUNCTION IF EXISTS mcp_e2e_bump();
         DROP VIEW IF EXISTS mcp_e2e_peek_view;
         DROP DOMAIN IF EXISTS mcp_e2e_dom;
         DROP FUNCTION IF EXISTS mcp_e2e_peek(), mcp_e2e_peek_folded(), mcp_e2e_eq(int, int) CASCADE;
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
         CREATE DOMAIN mcp_e2e_dom AS int CHECK (mcp_e2e_eq(VALUE, 0));
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

    // `'now'` is folded into the plan when it's made: the checked EXPLAIN
    // and the run plan at one moment, so a filter on its microseconds can't
    // leave the hidden table out of the check and read it in the run.
    let flip = "SELECT ssn FROM mcp_e2e_secret \
                WHERE extract(microseconds FROM 'now'::timestamp)::bigint % 2 = 0";
    for _ in 0..40 {
        match query(&mcp, flip).await {
            Ok(out) => assert_eq!(out["rows"], json!([]), "the run read the hidden table"),
            Err(err) => assert!(err.starts_with("Refused"), "{err}"),
        }
    }

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
        ("SELECT 1::mcp_e2e_dom", "public.mcp_e2e_dom"),
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
         DROP TABLE mcp_e2e_secret, mcp_e2e_visible, mcp_e2e_big, mcp_e2e_events;
         DROP FUNCTION mcp_e2e_bump(), mcp_e2e_peek(), mcp_e2e_peek_folded(), mcp_e2e_eq(int, int) CASCADE;",
    )
    .await;
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
        "DROP TABLE IF EXISTS mcp_mask_customers, mcp_mask_orders, mcp_mask_events CASCADE;
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
         INSERT INTO mcp_mask_events VALUES (1, 'mara@fjord.se', '2026-02-01');
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
        "SELECT plan FROM mcp_mask_customers UNION ALL SELECT email FROM mcp_mask_customers",
        "SELECT e.email FROM mcp_mask_events e",
        "SELECT email FROM mcp_mask_customers ORDER BY id LIMIT 2",
        "SELECT row_number() OVER (ORDER BY id), email FROM mcp_mask_customers",
        "WITH x AS (SELECT email FROM mcp_mask_customers) SELECT email FROM x",
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
        "SELECT id FROM mcp_mask_events WHERE email LIKE 'm%'",
        "SELECT id FROM mcp_mask_view WHERE email > 'm'",
        "SELECT count(email) FILTER (WHERE email LIKE 'm%') FROM mcp_mask_customers",
        "SELECT mcp_mask_lookup(1)",
    ] {
        let err = query(&mcp, sql).await.expect_err(sql);
        assert!(err.starts_with("Refused"), "{sql}: {err}");
        assert!(!err.contains("mara@"), "{sql}: {err}");
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
        "DROP TABLE IF EXISTS mcp_mask_customers, mcp_mask_orders, mcp_mask_events CASCADE;
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
    use crate::proposals::{self, CommitOutcome};
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
    match proposals::commit(&id, &[2, 2]).await.unwrap() {
        CommitOutcome::Moved { dry_run } => assert_eq!(dry_run.statements[0].rows, 3),
        other => panic!("{other:?}"),
    }
    match proposals::commit(&id, &[3, 2]).await.unwrap() {
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
    let flip = "UPDATE mcp_p_orders SET note = (SELECT max(id)::text FROM mcp_p_hidden \
                WHERE extract(microseconds FROM 'now'::timestamp)::bigint % 2 = 0) WHERE id = 1";
    for _ in 0..40 {
        let Ok(sent) = propose(flip).await else {
            continue;
        };
        let _ = proposals::commit(sent["id"].as_str().unwrap(), &[1]).await;
        let note = query(&mcp, "SELECT note FROM mcp_p_orders WHERE id = 1")
            .await
            .unwrap();
        assert_ne!(
            note["rows"],
            json!([["4242"]]),
            "the commit read the hidden table"
        );
    }

    // Read-only connections take no proposals.
    pg.safe_mode = rowkery_core::safety::SafeMode::ReadOnly;
    save(pg);
    let err = propose("DELETE FROM mcp_p_orders WHERE id = 1")
        .await
        .expect_err("read-only");
    assert!(err.contains("Read-only"), "{err}");
    std::env::remove_var("ROWKERY_CONFIG_DIR");
}
