//! Register a Postgres connection in ROWKERY_CONFIG_DIR for GUI verification.
use rowkery_core::config::{AppConfig, ThemePreference};
use rowkery_core::connections::{ConnectionRecord, PostgresConnection, PostgresSslMode};
use rowkery_core::secrets::{store_secret, SecretKind};

fn main() {
    let id = std::env::var("ROWKERY_UX_CONN_ID").unwrap_or_else(|_| "ux-pg-local".into());
    let host = std::env::var("ROWKERY_PG_HOST").unwrap_or_else(|_| "127.0.0.1".into());
    let port = std::env::var("ROWKERY_PG_PORT")
        .ok()
        .and_then(|p| p.parse().ok())
        .unwrap_or(54329);
    let database = std::env::var("ROWKERY_PG_DB").unwrap_or_else(|_| "rowkery".into());
    let username = std::env::var("ROWKERY_PG_USER").unwrap_or_else(|_| "rowkery".into());
    let password = std::env::var("ROWKERY_PG_PASSWORD").unwrap_or_else(|_| "rowkery".into());
    let name = std::env::var("ROWKERY_UX_CONN_NAME").unwrap_or_else(|_| "ux-local".into());

    store_secret(&id, SecretKind::DbPassword, &password).expect("store password");

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
        id: id.clone(),
        name,
        host,
        port,
        database,
        username,
        ssl_mode: PostgresSslMode::Disable,
        ssl_root_cert: None,
        ssh: None,
        cloud_sql: None,
    };

    let mut config = AppConfig::load().unwrap_or_default();
    config.theme = ThemePreference::Dark;
    config.upsert_connection(ConnectionRecord::Postgres(pg));
    config.save().expect("save config");
    eprintln!("registered connection {id}");
}
