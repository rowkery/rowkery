//! JSON config in the OS app-support directory (theme + saved connections).

use std::fs;
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

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
    /// Saved connections this build can't read (a newer build's engine or
    /// setting, a hand edit), kept as they were written: the app doesn't
    /// list them, and `save` writes them back after the others.
    #[serde(skip)]
    pub unread_connections: Vec<serde_json::Value>,
    /// config.json couldn't be read or set aside and is still in place:
    /// `save` refuses, so this launch never writes over it.
    #[serde(skip)]
    pub save_blocked: bool,
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
            unread_connections: Vec::new(),
            save_blocked: false,
        }
    }
}

/// What the app tells the user, once, when config.json held something this
/// build couldn't read.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct ConfigNotice {
    pub message: String,
    /// The file as it was: the copy set aside, or config.json itself when
    /// it was left alone.
    pub kept: Option<String>,
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

/// True in a Rowkery Dev build (`ROWKERY_CHANNEL=dev` at compile time,
/// `make dmg dev`): it keeps its own config folder, keychain items and agent
/// entry, so it can sit beside the release app without touching its data.
pub const DEV_BUILD: bool = match option_env!("ROWKERY_CHANNEL") {
    Some(c) => matches!(c.as_bytes(), b"dev"),
    None => false,
};

/// The URL scheme the app opens links from (views in the chat, `open_link.rs`):
/// Rowkery Dev has its own, so a link never lands in the other app.
pub const LINK_SCHEME: &str = if DEV_BUILD { "rowkery-dev" } else { "rowkery" };

/// Directory for Rowkery app data (`ROWKERY_CONFIG_DIR` overrides for tests).
pub fn config_dir() -> PathBuf {
    if let Ok(dir) = std::env::var("ROWKERY_CONFIG_DIR") {
        return PathBuf::from(dir);
    }
    #[cfg(target_os = "macos")]
    {
        if let Some(home) = home_dir() {
            return home.join(if DEV_BUILD {
                "Library/Application Support/Rowkery Dev"
            } else {
                "Library/Application Support/Rowkery"
            });
        }
    }
    #[cfg(target_os = "linux")]
    {
        if let Some(home) = home_dir() {
            return home.join(if DEV_BUILD {
                ".config/rowkery-dev"
            } else {
                ".config/rowkery"
            });
        }
    }
    #[cfg(target_os = "windows")]
    {
        if let Some(app_data) = std::env::var_os("APPDATA") {
            return PathBuf::from(app_data).join(if DEV_BUILD { "Rowkery Dev" } else { "Rowkery" });
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
    /// Reads config.json (the defaults when there is none). A saved
    /// connection this build can't read goes to `unread_connections` instead
    /// of failing the load, and settings it can't read fall back to their
    /// defaults. Fails only when the file can't be read or isn't a JSON
    /// object. Writes nothing; the app loads with [`AppConfig::load_for_app`].
    pub fn load() -> Result<Self, ConfigError> {
        let path = config_path();
        if !path.exists() {
            return Ok(Self::default());
        }
        let bytes = fs::read(&path)?;
        Ok(Self::parse(&bytes)?.0)
    }

    /// The app's load. It never fails, and no later save can replace what
    /// this build couldn't read:
    /// - a file that isn't a JSON object is renamed to
    ///   `config.json.bad-<unix seconds>` and the app starts from defaults;
    /// - when settings couldn't be read, the file is copied there first (the
    ///   next save writes their defaults);
    /// - saved connections it couldn't read stay in the file (`save` writes
    ///   them back), so they need no copy;
    /// - a file that can't be read at all, or can't be set aside, is left
    ///   where it is and this launch saves nothing (`save_blocked`).
    ///
    /// Each case comes with the notice the app shows once.
    pub fn load_for_app() -> (Self, Option<ConfigNotice>) {
        let path = config_path();
        if !path.exists() {
            return (Self::default(), None);
        }
        let in_place = Some(path.to_string_lossy().into_owned());
        let blocked = |config: Self| {
            let config = Self {
                save_blocked: true,
                ..config
            };
            let notice = ConfigNotice {
                message: "Couldn't read config.json; this launch saves nothing".into(),
                kept: in_place.clone(),
            };
            (config, Some(notice))
        };
        // The file exists, so the first launch is behind us: whatever
        // happens, the sample database isn't added again.
        let fresh = || Self {
            first_run_done: true,
            ..Self::default()
        };
        let bytes = match fs::read(&path) {
            Ok(bytes) => bytes,
            Err(e) => {
                eprintln!("config: couldn't read {}: {e}", path.display());
                return blocked(fresh());
            }
        };
        let (config, settings_read) = match Self::parse(&bytes) {
            Ok(parsed) => parsed,
            Err(e) => {
                eprintln!("config: {} isn't valid: {e}", path.display());
                let Some(kept) = set_aside(&path, |from, to| fs::rename(from, to)) else {
                    return blocked(fresh());
                };
                let notice = ConfigNotice {
                    message: "Couldn't read config.json, so Rowkery started fresh".into(),
                    kept: Some(kept),
                };
                return (fresh(), Some(notice));
            }
        };
        let unread = config.unread_connections.len();
        if settings_read && unread == 0 {
            return (config, None);
        }
        // Connections it couldn't read stay in config.json itself.
        let mut kept = in_place.clone();
        if !settings_read {
            match set_aside(&path, |from, to| fs::copy(from, to).map(|_| ())) {
                Some(copy) => kept = Some(copy),
                None => return blocked(config),
            }
        }
        let connections = match unread {
            0 => None,
            1 => Some("1 saved connection".to_string()),
            n => Some(format!("{n} saved connections")),
        };
        let message = match connections {
            None => "Couldn't read some settings, so they're reset".to_string(),
            Some(what) if settings_read => {
                format!("Couldn't read {what}; they stay in config.json")
            }
            Some(what) => format!("Couldn't read {what} and some settings"),
        };
        (config, Some(ConfigNotice { message, kept }))
    }

    /// Parses config.json's bytes one saved connection at a time. The bool
    /// is false when the settings around them couldn't be read: they're the
    /// defaults then.
    fn parse(bytes: &[u8]) -> Result<(Self, bool), ConfigError> {
        let mut value: serde_json::Value = serde_json::from_slice(bytes)?;
        let Some(object) = value.as_object_mut() else {
            return Err(ConfigError::Message("not a JSON object".into()));
        };
        let entries = match object.remove("connections") {
            Some(serde_json::Value::Array(entries)) => entries,
            None | Some(serde_json::Value::Null) => Vec::new(),
            Some(_) => return Err(ConfigError::Message("connections isn't a list".into())),
        };
        // The webview's state is opaque here, so it never fails the rest.
        let ui = object.remove("ui").filter(|ui| !ui.is_null());
        let (mut config, settings_read) = match serde_json::from_value::<Self>(value) {
            Ok(config) => (config, true),
            Err(e) => {
                eprintln!("config: settings reset to their defaults: {e}");
                let config = Self {
                    first_run_done: true,
                    ..Self::default()
                };
                (config, false)
            }
        };
        config.ui = ui;
        for entry in entries {
            match ConnectionRecord::deserialize(&entry) {
                Ok(connection) => config.connections.push(connection),
                Err(e) => {
                    eprintln!("config: kept a saved connection this build can't read: {e}");
                    config.unread_connections.push(entry);
                }
            }
        }
        if config.version < CONFIG_VERSION {
            config.version = CONFIG_VERSION;
        }
        Ok((config, settings_read))
    }

    /// Writes a temp file and renames it over `config.json`, so a crash
    /// mid-write leaves the previous file whole. Use `ConfigWriter` from the
    /// app; this is its one write path.
    pub fn save(&self) -> Result<(), ConfigError> {
        if self.save_blocked {
            return Err(ConfigError::Message(
                "Rowkery couldn't read config.json, so it won't save over it until it restarts"
                    .into(),
            ));
        }
        let dir = config_dir();
        fs::create_dir_all(&dir)?;
        let path = config_path();
        let tmp = dir.join(format!("{CONFIG_FILE}.tmp"));
        let mut value = serde_json::to_value(self)?;
        if let Some(serde_json::Value::Array(list)) = value.get_mut("connections") {
            list.extend(self.unread_connections.iter().cloned());
        }
        let json = serde_json::to_vec_pretty(&value)?;
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

/// Moves or copies (`put`) config.json to a free `config.json.bad-<unix
/// seconds>` beside it; the new path, or None when that failed.
fn set_aside(path: &Path, put: impl Fn(&Path, &Path) -> std::io::Result<()>) -> Option<String> {
    let dir = path.parent()?;
    let secs = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |d| d.as_secs());
    let mut to = dir.join(format!("{CONFIG_FILE}.bad-{secs}"));
    let mut n = 1;
    while to.exists() {
        n += 1;
        to = dir.join(format!("{CONFIG_FILE}.bad-{secs}-{n}"));
    }
    match put(path, &to) {
        Ok(()) => Some(to.to_string_lossy().into_owned()),
        Err(e) => {
            eprintln!(
                "config: couldn't keep {} as {}: {e}",
                path.display(),
                to.display()
            );
            None
        }
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
            unread_connections: Vec::new(),
            save_blocked: false,
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
            cloud_sql: None,
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
        assert_eq!(AppConfig::load_for_app(), (AppConfig::default(), None));
        std::env::remove_var("ROWKERY_CONFIG_DIR");
    }

    /// config.json and every `config.json.bad-*` beside it, by name.
    fn files(dir: &Path) -> Vec<(String, String)> {
        let mut out: Vec<_> = fs::read_dir(dir)
            .unwrap()
            .map(|e| e.unwrap())
            .filter(|e| e.file_type().unwrap().is_file())
            .map(|e| {
                let name = e.file_name().to_string_lossy().into_owned();
                (name, fs::read_to_string(e.path()).unwrap())
            })
            .filter(|(name, _)| name.starts_with(CONFIG_FILE))
            .collect();
        out.sort();
        out
    }

    const SQLITE_ENTRY: &str =
        r#"{ "kind": "sqlite", "id": "c1", "name": "local", "path": "/tmp/a.db" }"#;

    #[test]
    fn a_file_that_isnt_json_is_set_aside_not_saved_over() {
        let (_guard, dir) = test_guard();
        fs::create_dir_all(&dir).unwrap();
        let broken = r#"{ "version": 2, "theme": "system", "connections": [ "#;
        fs::write(dir.join(CONFIG_FILE), broken).unwrap();
        assert!(AppConfig::load().is_err());

        let (config, notice) = AppConfig::load_for_app();
        let notice = notice.expect("a notice");
        let kept = PathBuf::from(notice.kept.expect("kept"));
        assert!(kept
            .file_name()
            .unwrap()
            .to_string_lossy()
            .starts_with("config.json.bad-"));
        assert_eq!(fs::read_to_string(&kept).unwrap(), broken);
        assert!(!dir.join(CONFIG_FILE).exists());
        // Started fresh, without bringing the sample database back.
        assert!(config.connections.is_empty());
        assert!(config.first_run_done && !config.save_blocked);

        // The next save writes a new config.json and leaves the copy alone;
        // the next launch reads it with nothing to say.
        config.save().unwrap();
        assert_eq!(fs::read_to_string(&kept).unwrap(), broken);
        assert_eq!(files(&dir).len(), 2);
        assert_eq!(AppConfig::load_for_app().1, None);
        std::env::remove_var("ROWKERY_CONFIG_DIR");
    }

    #[test]
    fn unreadable_connections_are_kept_and_the_rest_survive() {
        let (_guard, dir) = test_guard();
        fs::create_dir_all(&dir).unwrap();
        // A newer build's engine, and a known engine with a newer setting.
        let future_kind = r#"{ "kind": "mysql", "id": "m1", "name": "shop", "host": "h" }"#;
        let future_mode = r#"{ "kind": "postgres", "id": "p1", "name": "prod", "host": "h",
            "port": 5432, "database": "app", "username": "u", "ssl_mode": "verify-everything" }"#;
        fs::write(
            dir.join(CONFIG_FILE),
            format!(
                r#"{{ "version": 2, "theme": "dark", "first_run_done": true,
                    "connections": [{future_kind}, {SQLITE_ENTRY}, {future_mode}],
                    "ui": {{ "version": 1, "keys": {{ "rowkery.sql": "select 1" }} }} }}"#
            ),
        )
        .unwrap();

        let (mut config, notice) = AppConfig::load_for_app();
        assert_eq!(config.theme, ThemePreference::Dark);
        assert_eq!(config.connections.len(), 1);
        assert_eq!(config.connections[0].id(), "c1");
        assert_eq!(config.unread_connections.len(), 2);
        assert_eq!(
            config.ui,
            Some(serde_json::json!({ "version": 1, "keys": { "rowkery.sql": "select 1" } }))
        );
        let notice = notice.expect("a notice");
        assert!(
            notice.message.contains("2 saved connections"),
            "{}",
            notice.message
        );
        // They stay in config.json itself: no copy is made.
        assert_eq!(notice.kept.map(PathBuf::from), Some(dir.join(CONFIG_FILE)));
        assert_eq!(files(&dir).len(), 1);

        // Saved (an edit elsewhere), they're written back as they were.
        config.remove_connection("c1");
        config.save().unwrap();
        let back = AppConfig::load().unwrap();
        assert!(back.connections.is_empty());
        let want: Vec<serde_json::Value> = [future_kind, future_mode]
            .iter()
            .map(|e| serde_json::from_str(e).unwrap())
            .collect();
        assert_eq!(back.unread_connections, want);
        std::env::remove_var("ROWKERY_CONFIG_DIR");
    }

    #[test]
    fn unreadable_settings_reset_after_a_copy_is_kept() {
        let (_guard, dir) = test_guard();
        fs::create_dir_all(&dir).unwrap();
        let raw = format!(
            r#"{{ "version": 2, "theme": "sepia", "connections": [{SQLITE_ENTRY}],
                "ui": {{ "version": 1, "keys": {{}} }} }}"#
        );
        fs::write(dir.join(CONFIG_FILE), &raw).unwrap();

        let (config, notice) = AppConfig::load_for_app();
        assert_eq!(config.theme, ThemePreference::System);
        assert_eq!(config.connections.len(), 1);
        assert!(config.ui.is_some());
        assert!(config.first_run_done);
        let notice = notice.expect("a notice");
        assert!(notice.message.contains("settings"), "{}", notice.message);
        let kept = notice.kept.expect("a copy");
        assert_eq!(fs::read_to_string(kept).unwrap(), raw);
        // config.json itself is still there, untouched until a save.
        assert_eq!(fs::read_to_string(dir.join(CONFIG_FILE)).unwrap(), raw);
        std::env::remove_var("ROWKERY_CONFIG_DIR");
    }

    #[test]
    fn a_file_that_cant_be_read_is_left_alone_and_never_saved_over() {
        let (_guard, dir) = test_guard();
        // A directory where the file should be: reading it fails.
        fs::create_dir_all(dir.join(CONFIG_FILE)).unwrap();
        let (config, notice) = AppConfig::load_for_app();
        assert!(config.save_blocked);
        assert!(notice.is_some());
        assert!(config.save().is_err());
        assert!(dir.join(CONFIG_FILE).is_dir());
        std::env::remove_var("ROWKERY_CONFIG_DIR");
    }
}
