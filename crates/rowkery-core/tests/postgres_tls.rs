#![cfg(feature = "postgres-integration")]
//! SSL modes against two local servers, one with TLS and one without.
//! `scripts/pg-tls-servers.sh` starts them and prints the variables:
//! `ROWKERY_TLS_DIR` (holds `ca.crt` and `other-ca.crt`), `ROWKERY_TLS_PORT`
//! (TLS on, certificate for localhost / 127.0.0.1 signed by `ca.crt`) and
//! `ROWKERY_PLAIN_PORT` (TLS off). Both trust user `rowkery` without a password.
//! Skipped when the variables are unset.

use rowkery_core::connections::{PostgresConnection, PostgresSslMode};
use rowkery_core::db::postgres::{
    open_session_with_secrets, session_query_stream, PostgresSession,
};
use rowkery_core::db::Value;
use rowkery_core::secrets::ConnectionSecrets;

struct Servers {
    dir: String,
    tls_port: u16,
    plain_port: u16,
}

fn servers() -> Option<Servers> {
    let port = |name: &str| std::env::var(name).ok()?.parse().ok();
    Some(Servers {
        dir: std::env::var("ROWKERY_TLS_DIR").ok()?,
        tls_port: port("ROWKERY_TLS_PORT")?,
        plain_port: port("ROWKERY_PLAIN_PORT")?,
    })
}

async fn open(
    host: &str,
    port: u16,
    mode: PostgresSslMode,
    root_cert: Option<String>,
) -> Result<PostgresSession, String> {
    let config = PostgresConnection {
        id: "tls-test".into(),
        name: "tls".into(),
        host: host.into(),
        port,
        database: "postgres".into(),
        username: "rowkery".into(),
        ssl_mode: mode,
        ssl_root_cert: root_cert,
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
    };
    open_session_with_secrets(
        "tls-test".into(),
        config,
        Some(&ConnectionSecrets::default()),
    )
    .await
    .map_err(|e| e.to_string())
}

async fn uses_tls(session: &PostgresSession) -> bool {
    let mut ssl = None;
    session_query_stream(
        session,
        "SELECT ssl FROM pg_stat_ssl WHERE pid = pg_backend_pid()",
        |batch, _| {
            ssl = batch.rows.first().map(|row| row[0] == Value::Bool(true));
            Ok(())
        },
    )
    .await
    .expect("query");
    ssl.expect("one row")
}

#[tokio::test]
async fn ssl_modes() {
    let Some(s) = servers() else {
        eprintln!("ROWKERY_TLS_* not set, skipping");
        return;
    };
    let ca = Some(format!("{}/ca.crt", s.dir));
    let other_ca = Some(format!("{}/other-ca.crt", s.dir));
    use PostgresSslMode::*;

    // Prefer falls back to plaintext only when the server has no TLS.
    let plain = open("127.0.0.1", s.plain_port, Prefer, None).await.unwrap();
    assert!(!uses_tls(&plain).await);
    let tls = open("127.0.0.1", s.tls_port, Prefer, None).await.unwrap();
    assert!(uses_tls(&tls).await);

    // Require never goes plaintext, and doesn't need a trusted certificate.
    let err = open("127.0.0.1", s.plain_port, Require, None)
        .await
        .err()
        .expect("Require on a server without TLS must fail");
    assert!(err.contains("doesn't accept SSL"), "{err}");
    let tls = open("127.0.0.1", s.tls_port, Require, None).await.unwrap();
    assert!(uses_tls(&tls).await);

    // Verify checks the chain and the host name.
    let err = open("localhost", s.tls_port, Verify, None)
        .await
        .err()
        .expect("private CA is not in the system store");
    assert!(
        err.contains("Couldn't verify the server's certificate"),
        "{err}"
    );
    let err = open("localhost", s.tls_port, Verify, other_ca)
        .await
        .err()
        .expect("wrong CA must fail");
    assert!(
        err.contains("Couldn't verify the server's certificate"),
        "{err}"
    );
    let tls = open("localhost", s.tls_port, Verify, ca.clone())
        .await
        .unwrap();
    assert!(uses_tls(&tls).await);
    let tls = open("127.0.0.1", s.tls_port, Verify, ca).await.unwrap();
    assert!(uses_tls(&tls).await);

    let err = open(
        "localhost",
        s.tls_port,
        Verify,
        Some("/nonexistent/ca.pem".into()),
    )
    .await
    .err()
    .expect("missing CA file");
    assert!(err.contains("Couldn't read CA certificate"), "{err}");
}
