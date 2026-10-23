//! A port that takes the connection and then says nothing (a dead `kubectl
//! port-forward`): opening a session gives up after `CONNECT_TIMEOUT`
//! instead of waiting on the handshake for good. No Postgres needed.

use std::net::TcpListener;
use std::time::{Duration, Instant};

use rowkery_core::connections::{PostgresConnection, PostgresSslMode};
use rowkery_core::db::postgres::{open_session_with_secrets, CONNECT_TIMEOUT};
use rowkery_core::ConnectionSecrets;

fn config(port: u16, ssl_mode: PostgresSslMode) -> PostgresConnection {
    PostgresConnection {
        id: "silent-port".into(),
        name: "silent".into(),
        host: "127.0.0.1".into(),
        port,
        database: "rowkery".into(),
        username: "rowkery".into(),
        ssl_mode,
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

#[tokio::test]
async fn a_silent_port_times_out() {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let port = listener.local_addr().unwrap().port();
    // Accepts every connection and keeps it open, never writing a byte.
    std::thread::spawn(move || {
        let mut held = Vec::new();
        for stream in listener.incoming().flatten() {
            held.push(stream);
        }
    });
    let secrets = ConnectionSecrets {
        db_password: Some("rowkery".into()),
        ..Default::default()
    };
    let started = Instant::now();
    // Plain (startup waits) and Prefer (the SSL request waits), at once.
    let (plain, tls) = tokio::join!(
        open_session_with_secrets(
            "silent-plain".into(),
            config(port, PostgresSslMode::Disable),
            Some(&secrets),
        ),
        open_session_with_secrets(
            "silent-tls".into(),
            config(port, PostgresSslMode::Prefer),
            Some(&secrets),
        ),
    );
    let waited = started.elapsed();
    for result in [plain, tls] {
        let err = result.err().expect("a silent port can't open a session");
        let message = err.into_message();
        assert!(message.contains("timed out"), "{message}");
        assert!(message.contains(&format!("127.0.0.1:{port}")), "{message}");
    }
    assert!(waited >= CONNECT_TIMEOUT, "{waited:?}");
    assert!(
        waited < CONNECT_TIMEOUT + Duration::from_secs(5),
        "{waited:?}"
    );
}
