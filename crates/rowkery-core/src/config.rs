//! JSON config in the OS app-support directory (theme + saved connections).

use std::fs;
use std::path::PathBuf;

use serde::{Deserialize, Serialize};
use thiserror::Error;

use crate::connections::ConnectionRecord;

const CONFIG_FILE: &str = "config.json";
const CONFIG_VERSION: u32 = 2;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ThemePreference {
    #[default]
    System,
    Dark,
    Light,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct AppConfig {
    pub version: u32,
    pub theme: ThemePreference,
    #[serde(default)]
    pub connections: Vec<ConnectionRecord>,
    /// The webview's own state (windows, tabs, SQL, widths, pins, history…),
    /// versioned and read by the webview; core only stores it.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub ui: Option<serde_json::Value>,
    /// Set once the first launch has decided about the sample database, so
    /// deleting it never brings it back on its own.
    #[serde(default)]
    pub first_run_done: bool,
    /// Linux and Windows: the system draws the window's title bar and
    /// buttons instead of Rowkery's own (`WindowControls.tsx`). Read once,
    /// before the window is created, so a change shows on the next launch.
    /// macOS ignores it (its traffic lights are always native).
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub native_decorations: bool,
}

impl Default for AppConfig {
    fn default() -> Self {
        Self {
            version: CONFIG_VERSION,
            theme: ThemePreference::System,
            connections: Vec::new(),
            ui: None,
            first_run_done: false,
            native_decorations: false,
        }
    }
}

#[derive(Debug, Error)]
pub enum ConfigError {
    #[error("io error: {0}")]
    Io(#[from] std::io::Error),
    #[error("json error: {0}")]
    Json(#[from] serde_json::Error),
    #[error("{0}")]
    Message(String),
}

/// Directory for Rowkery app data (`ROWKERY_CONFIG_DIR` overrides for tests).
pub fn config_dir() -> PathBuf {
    if let Ok(dir) = std::env::var("ROWKERY_CONFIG_DIR") {
        return PathBuf::from(dir);
    }
    #[cfg(target_os = "macos")]
    {
        if let Some(home) = home_dir() {
            return home.join("Library/Application Support/Rowkery");
        }
    }
    #[cfg(target_os = "linux")]
    {
        if let Some(home) = home_dir() {
            return home.join(".config/rowkery");
        }
    }
    #[cfg(target_os = "windows")]
    {
        if let Some(app_data) = std::env::var_os("APPDATA") {
            return PathBuf::from(app_data).join("Rowkery");
        }
    }
    PathBuf::from(".rowkery")
}

pub fn config_path() -> PathBuf {
    config_dir().join(CONFIG_FILE)
}

fn home_dir() -> Option<PathBuf> {
    std::env::var_os("HOME")
        .or_else(|| std::env::var_os("USERPROFILE"))
        .map(PathBuf::from)
}

impl AppConfig {
    pub fn load() -> Result<Self, ConfigError> {
        let path = config_path();
        if !path.exists() {
            return Ok(Self::default());
        }
        let bytes = fs::read(&path)?;
        let mut config: Self = serde_json::from_slice(&bytes)?;
        if config.version < CONFIG_VERSION {
            config.version = CONFIG_VERSION;
        }
        Ok(config)
    }

    /// Writes a temp file and renames it over `config.json`, so a crash
    /// mid-write leaves the previous file whole. Use `ConfigWriter` from the
    /// app; this is its one write path.
    pub fn save(&self) -> Result<(), ConfigError> {
        let dir = config_dir();
        fs::create_dir_all(&dir)?;
        let path = config_path();
        let tmp = dir.join(format!("{CONFIG_FILE}.tmp"));
        let json = serde_json::to_vec_pretty(self)?;
        fs::write(&tmp, json)?;
        fs::rename(&tmp, &path)?;
        Ok(())
    }

    pub fn upsert_connection(&mut self, connection: ConnectionRecord) {
        let id = connection.id().to_string();
        if let Some(ix) = self.connections.iter().position(|c| c.id() == id) {
            self.connections[ix] = connection;
        } else {
            self.connections.push(connection);
        }
    }

    pub fn remove_connection(&mut self, id: &str) {
        self.connections.retain(|c| c.id() != id);
    }
}

/// Tests that point `ROWKERY_CONFIG_DIR` somewhere hold this: the variable is
/// process-wide, so they would race (config, secrets, the writer).
#[cfg(test)]
pub(crate) static TEST_ENV_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());

/// Locks [`TEST_ENV_LOCK`] and points `ROWKERY_CONFIG_DIR` at a fresh directory.
#[cfg(test)]
pub(crate) fn test_dir_guard(name: &str) -> std::sync::MutexGuard<'static, ()> {
    let guard = TEST_ENV_LOCK.lock().unwrap_or_else(|e| e.into_inner());
    let dir = std::env::temp_dir().join(format!("rowkery-{name}-test-{}", std::process::id()));
    let _ = fs::remove_dir_all(&dir);
    std::env::set_var("ROWKERY_CONFIG_DIR", dir.to_string_lossy().to_string());
    guard
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::connections::{ConnectionRecord, PostgresConnection, SqliteConnection};
    use std::sync::MutexGuard;

    fn test_guard() -> (MutexGuard<'static, ()>, PathBuf) {
        let guard = test_dir_guard("config");
        (guard, config_dir())
    }

    #[test]
    fn round_trip_theme_preference() {
        let (_guard, dir) = test_guard();
        let config = AppConfig {
            version: CONFIG_VERSION,
            theme: ThemePreference::Light,
            connections: vec![],
            ui: Some(serde_json::json!({ "version": 1, "windows": [] })),
            first_run_done: false,
            native_decorations: true,
        };
        config.save().unwrap();
        let loaded = AppConfig::load().unwrap();
        assert_eq!(loaded, config);
        let raw = fs::read_to_string(dir.join(CONFIG_FILE)).unwrap();
        assert!(!raw.contains("password"));
        std::env::remove_var("ROWKERY_CONFIG_DIR");
    }

    #[test]
    fn postgres_connection_json_has_no_password() {
        let (_guard, dir) = test_guard();
        let mut config = AppConfig::default();
        config.upsert_connection(ConnectionRecord::Postgres(PostgresConnection {
            environment: None,
            safe_mode: Default::default(),
            allow_mcp: false,
            mcp_hidden_tables: Vec::new(),
            mcp_until: None,
            mcp_samples_off: false,
            mcp_access: None,
            masked_columns: Default::default(),
            id: "pg1".into(),
            name: "prod".into(),
            host: "db.example.com".into(),
            port: 5432,
            database: "app".into(),
            username: "readonly".into(),
            ssl_mode: Default::default(),
            ssl_root_cert: None,
            ssh: None,
        }));
        config.save().unwrap();
        let raw = fs::read_to_string(dir.join(CONFIG_FILE)).unwrap();
        assert!(!raw.contains("password"));
        std::env::remove_var("ROWKERY_CONFIG_DIR");
    }

    #[test]
    fn sqlite_connection_round_trip() {
        let (_guard, _dir) = test_guard();
        let mut config = AppConfig::default();
        config.upsert_connection(ConnectionRecord::Sqlite(SqliteConnection {
            environment: None,
            safe_mode: Default::default(),
            allow_mcp: false,
            mcp_hidden_tables: Vec::new(),
            mcp_until: None,
            mcp_samples_off: false,
            mcp_access: None,
            masked_columns: Default::default(),
            id: "c1".into(),
            name: "local".into(),
            path: "/tmp/test.db".into(),
            sample: false,
        }));
        config.save().unwrap();
        let loaded = AppConfig::load().unwrap();
        assert_eq!(loaded.connections.len(), 1);
        assert_eq!(loaded.connections[0].display_name(), "local");
        std::env::remove_var("ROWKERY_CONFIG_DIR");
    }

    #[test]
    fn native_decorations_are_off_by_default_and_left_out_when_off() {
        let (_guard, dir) = test_guard();
        fs::create_dir_all(&dir).unwrap();
        fs::write(
            dir.join(CONFIG_FILE),
            r#"{ "version": 2, "theme": "system", "connections": [] }"#,
        )
        .unwrap();
        assert!(!AppConfig::load().unwrap().native_decorations);
        AppConfig::default().save().unwrap();
        let raw = fs::read_to_string(dir.join(CONFIG_FILE)).unwrap();
        assert!(!raw.contains("native_decorations"));
        std::env::remove_var("ROWKERY_CONFIG_DIR");
    }

    #[test]
    fn missing_file_returns_default() {
        let (_guard, _dir) = test_guard();
        let loaded = AppConfig::load().unwrap();
        assert_eq!(loaded.theme, ThemePreference::System);
        std::env::remove_var("ROWKERY_CONFIG_DIR");
    }
}
