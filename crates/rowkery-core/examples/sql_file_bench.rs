//! Times Run SQL file on one file, the way the app runs it: `scan`, then
//! `run_postgres` / `run_sqlite`. Prints one JSON line with the wall times,
//! the counts and the process's peak memory (Linux `VmHWM`).
//!
//! ```text
//! cargo run --release -p rowkery-core --example sql_file_bench -- FILE postgres [--per-statement] [--cancel-after SECS]
//! cargo run --release -p rowkery-core --example sql_file_bench -- FILE sqlite:DB [...]
//! ```
//! Postgres comes from `ROWKERY_PG_HOST` / `_PORT` / `_DB` / `_USER` /
//! `_PASSWORD` (default the test server on 54329). `scripts/sql-file-load-test.sh`
//! drives it.

use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};

use rowkery_core::connections::{PostgresConnection, PostgresSslMode};
use rowkery_core::db::postgres::{cancel_with_token, open_session};
use rowkery_core::db::EngineKind;
use rowkery_core::secrets::{store_secret, SecretKind};
use rowkery_core::sql_file::{open_sqlite, run_postgres, run_sqlite, scan, RunOptions};

fn peak_kib() -> Option<u64> {
    let status = std::fs::read_to_string("/proc/self/status").ok()?;
    let line = status.lines().find(|l| l.starts_with("VmHWM:"))?;
    line.split_whitespace().nth(1)?.parse().ok()
}

fn pg_config() -> PostgresConnection {
    let env = |k: &str, d: &str| std::env::var(k).unwrap_or_else(|_| d.into());
    PostgresConnection {
        id: "sql-file-bench".into(),
        name: "bench".into(),
        host: env("ROWKERY_PG_HOST", "127.0.0.1"),
        port: env("ROWKERY_PG_PORT", "54329").parse().unwrap_or(54329),
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

#[tokio::main]
async fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let (Some(file), Some(target)) = (args.first(), args.get(1)) else {
        eprintln!(
            "usage: sql_file_bench FILE postgres|sqlite:DB [--per-statement] [--cancel-after SECS]"
        );
        std::process::exit(2);
    };
    let file = PathBuf::from(file);
    let whole_file = !args.iter().any(|a| a == "--per-statement");
    let cancel_after = args
        .iter()
        .position(|a| a == "--cancel-after")
        .and_then(|i| args.get(i + 1))
        .and_then(|s| s.parse::<f64>().ok())
        .map(Duration::from_secs_f64);
    let engine = if target == "postgres" {
        EngineKind::Postgres
    } else {
        EngineKind::Sqlite
    };

    let started = Instant::now();
    let scanned = scan(&file, engine, |_| true).expect("scan");
    let scan_ms = started.elapsed().as_millis();
    if let Some(refused) = &scanned.refused {
        eprintln!("refused: {refused:?}");
        std::process::exit(1);
    }
    let options = RunOptions {
        whole_file,
        keep_going: false,
    };
    let cancelled = Arc::new(AtomicBool::new(false));
    let cancelled_at: Arc<std::sync::Mutex<Option<Instant>>> = Arc::default();
    let started = Instant::now();
    let report = if engine == EngineKind::Postgres {
        let password = std::env::var("ROWKERY_PG_PASSWORD").unwrap_or_else(|_| "rowkery".into());
        store_secret("sql-file-bench", SecretKind::DbPassword, &password).expect("password");
        let config = pg_config();
        let session = open_session(config.id.clone(), config)
            .await
            .expect("connect");
        if let Some(after) = cancel_after {
            let (token, via) = (session.cancel_token.clone(), session.cancel_via.clone());
            let (flag, at) = (cancelled.clone(), cancelled_at.clone());
            tokio::spawn(async move {
                tokio::time::sleep(after).await;
                *at.lock().unwrap() = Some(Instant::now());
                flag.store(true, Ordering::SeqCst);
                let _ = cancel_with_token(token, via).await;
            });
        }
        run_postgres(
            &session,
            &file,
            &scanned,
            options,
            || cancelled.load(Ordering::SeqCst),
            |_| {},
        )
        .await
    } else {
        let db = target.trim_start_matches("sqlite:").to_string();
        let conn = open_sqlite(&db).expect("open");
        if let Some(after) = cancel_after {
            let handle = conn.get_interrupt_handle();
            let (flag, at) = (cancelled.clone(), cancelled_at.clone());
            std::thread::spawn(move || {
                std::thread::sleep(after);
                *at.lock().unwrap() = Some(Instant::now());
                flag.store(true, Ordering::SeqCst);
                handle.interrupt();
            });
        }
        run_sqlite(
            &conn,
            &file,
            &scanned,
            options,
            || cancelled.load(Ordering::SeqCst),
            |_| {},
        )
    };
    let run = started.elapsed();
    let stop_ms = cancelled_at
        .lock()
        .unwrap()
        .map(|at| at.elapsed().as_millis());
    let out = serde_json::json!({
        "bytes": scanned.bytes,
        "statements": scanned.statements,
        "copy_rows": scanned.copy_rows,
        "scan_ms": scan_ms,
        "run_ms": run.as_millis(),
        "rows": report.rows,
        "rows_per_sec": (report.rows as f64 / run.as_secs_f64()).round(),
        "done": report.done,
        "cancelled": report.cancelled,
        "rolled_back": report.rolled_back,
        "cancel_to_stopped_ms": stop_ms,
        "failed": report.failed,
        "peak_rss_mib": peak_kib().map(|k| k / 1024),
    });
    println!("{out}");
}
