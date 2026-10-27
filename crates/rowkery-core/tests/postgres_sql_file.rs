#![cfg(feature = "postgres-integration")]
//! Run SQL file against a real Postgres: COPY rows, the whole-file
//! transaction, rollback on error and on cancel, per-statement runs.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

use rowkery_core::connections::{PostgresConnection, PostgresSslMode};
use rowkery_core::db::postgres::{
    cancel_with_token, open_session, session_run_file_statement, PostgresSession,
};
use rowkery_core::db::EngineKind;
use rowkery_core::secrets::{store_secret, SecretKind};
use rowkery_core::sql_file::{run_postgres, scan, RunOptions, RunReport};

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
        mcp_timeout_s: None,
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

const WHOLE: RunOptions = RunOptions {
    whole_file: true,
    keep_going: false,
};

async fn run(tag: &str, sql: &str, options: RunOptions) -> (RunReport, PostgresSession) {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("f.sql");
    std::fs::write(&path, sql).unwrap();
    let scanned = scan(&path, EngineKind::Postgres, |_| true).unwrap();
    assert_eq!(scanned.refused, None);
    let session = session(tag).await;
    let report = run_postgres(&session, &path, &scanned, options, || false, |_| {}).await;
    // The run's session keeps the dump's SETs: check on a fresh one.
    (report, self::session(tag).await)
}

async fn rows(session: &PostgresSession, table: &str) -> Option<u64> {
    session_run_file_statement(session, &format!("SELECT * FROM {table}"))
        .await
        .ok()
}

#[tokio::test]
async fn copy_rows_commit_as_one_transaction() {
    let sql = "SET statement_timeout = 0;\nSELECT pg_catalog.set_config('search_path', '', false);\nDROP TABLE IF EXISTS public.sqlfile_copy;\nCREATE TABLE public.sqlfile_copy (id int PRIMARY KEY, note text);\nCOPY public.sqlfile_copy (id, note) FROM stdin;\n1\tone\n2\t\\N\n3\ttab\\there\n\\.\nINSERT INTO public.sqlfile_copy VALUES (4, 'x;y');\n";
    let (report, check) = run("copy", sql, WHOLE).await;
    assert_eq!(report.failed, None, "{report:?}");
    assert_eq!(
        (report.done, report.rows, report.rolled_back),
        (6, 4, false)
    );
    assert_eq!(rows(&check, "public.sqlfile_copy").await, Some(4));
}

#[tokio::test]
async fn an_error_rolls_the_whole_file_back() {
    let sql = "DROP TABLE IF EXISTS public.sqlfile_err;\nCREATE TABLE public.sqlfile_err (id int);\nCOPY public.sqlfile_err (id) FROM stdin;\n1\n2\n\\.\nINSERT INTO public.sqlfile_err VALUES ('not a number');\nINSERT INTO public.sqlfile_err VALUES (3);\n";
    let (report, check) = run("err", sql, WHOLE).await;
    let failed = report.failed.expect("fails");
    assert_eq!(failed.line, Some(7));
    assert!(
        failed.message.contains("not a number"),
        "{}",
        failed.message
    );
    assert!(report.rolled_back);
    assert_eq!(rows(&check, "public.sqlfile_err").await, None);

    // A bad COPY row fails the same way.
    let sql = "CREATE TABLE public.sqlfile_bad (id int);\nCOPY public.sqlfile_bad (id) FROM stdin;\n1\nx\n\\.\n";
    let (report, check) = run("badcopy", sql, WHOLE).await;
    assert_eq!(report.failed.expect("fails").line, Some(2));
    assert_eq!(rows(&check, "public.sqlfile_bad").await, None);
}

#[tokio::test]
async fn per_statement_keeps_what_ran() {
    let sql = "DROP TABLE IF EXISTS public.sqlfile_per;\nCREATE TABLE public.sqlfile_per (id int);\nCREATE INDEX CONCURRENTLY sqlfile_per_id ON public.sqlfile_per (id);\nINSERT INTO public.sqlfile_per VALUES ('bad');\nINSERT INTO public.sqlfile_per VALUES (1);\n";
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("f.sql");
    std::fs::write(&path, sql).unwrap();
    let scanned = scan(&path, EngineKind::Postgres, |_| true).unwrap();
    assert_eq!(scanned.per_statement.as_ref().map(|p| p.line), Some(3));
    let options = RunOptions {
        whole_file: false,
        keep_going: true,
    };
    let session = session("per").await;
    let report = run_postgres(&session, &path, &scanned, options, || false, |_| {}).await;
    assert_eq!((report.done, report.errors), (4, 1), "{report:?}");
    assert_eq!(report.first_error.unwrap().line, Some(4));
    assert_eq!(rows(&session, "public.sqlfile_per").await, Some(1));
}

#[tokio::test]
async fn cancel_rolls_back() {
    let sql = "DROP TABLE IF EXISTS public.sqlfile_cancel;\nCREATE TABLE public.sqlfile_cancel (id int);\nSELECT pg_sleep(30);\nINSERT INTO public.sqlfile_cancel VALUES (1);\n";
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("f.sql");
    std::fs::write(&path, sql).unwrap();
    let scanned = scan(&path, EngineKind::Postgres, |_| true).unwrap();
    let session = session("cancel").await;
    let cancelled = Arc::new(AtomicBool::new(false));
    let (token, via) = (session.cancel_token.clone(), session.cancel_via.clone());
    let flag = cancelled.clone();
    tokio::spawn(async move {
        tokio::time::sleep(std::time::Duration::from_millis(500)).await;
        flag.store(true, Ordering::SeqCst);
        cancel_with_token(token, via).await.unwrap();
    });
    let started = std::time::Instant::now();
    let report = run_postgres(
        &session,
        &path,
        &scanned,
        WHOLE,
        || cancelled.load(Ordering::SeqCst),
        |_| {},
    )
    .await;
    assert!(started.elapsed() < std::time::Duration::from_secs(10));
    assert!(report.cancelled && report.rolled_back, "{report:?}");
    assert_eq!(rows(&session, "public.sqlfile_cancel").await, None);
}
