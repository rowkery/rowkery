//! JSON config in the OS app-support directory (theme + saved connections).

use std::collections::{HashMap, HashSet};
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use serde::de::DeserializeOwned;
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};
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
    /// list them, and `save` writes them back where they were.
    #[serde(skip)]
    pub unread_connections: Vec<UnreadConnection>,
    /// Fields this build doesn't know (a newer build's restriction on a
    /// connection, a new setting), as config.json had them: `save` writes
    /// them back, so a launch of this build doesn't drop them.
    #[serde(skip)]
    pub unknown_fields: UnknownFields,
    /// Whether this launch may write config.json; shared by every copy.
    #[serde(skip)]
    pub save_gate: SaveGate,
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
            unknown_fields: UnknownFields::default(),
            save_gate: SaveGate::default(),
        }
    }
}

/// A saved connection this build can't read, as written.
#[derive(Debug, Clone, PartialEq)]
pub struct UnreadConnection {
    /// The readable connection it followed in the list (None: it came
    /// first); `save` puts it back there.
    pub after: Option<String>,
    pub entry: Value,
}

impl UnreadConnection {
    pub fn id(&self) -> Option<&str> {
        self.entry.get("id").and_then(Value::as_str)
    }
}

#[derive(Debug, Clone, PartialEq, Default)]
pub struct UnknownFields {
    /// Beside `version`, `theme`, `connections`…
    pub top: Map<String, Value>,
    /// On a readable saved connection, by its id.
    pub connections: HashMap<String, Map<String, Value>>,
}

/// A failed save is told again at most this often (the first one after
/// launch waits this long after the launch notice).
const TELL_AGAIN_AFTER: Duration = Duration::from_secs(60);

const BLOCKED: &str = "Rowkery can't read config.json, so it won't save over it. \
    Fix or move the file, then try again";

/// Whether this launch may write config.json, shared by every copy of the
/// config (the core thread's, the writer's). It's closed while the file
/// can't be read or set aside, and reopens once it can. It also keeps the
/// last failed save for the app to tell again (`take_failure`).
#[derive(Debug, Clone, Default)]
pub struct SaveGate(Arc<Mutex<Gate>>);

#[derive(Debug, Default)]
struct Gate {
    blocked: bool,
    /// The last failed save's error, logged once.
    failed: Option<String>,
    /// When the user last heard about config.json.
    told: Option<Instant>,
}

/// Not part of what the config holds: copies always compare equal.
impl PartialEq for SaveGate {
    fn eq(&self, _: &Self) -> bool {
        true
    }
}

impl SaveGate {
    fn gate(&self) -> std::sync::MutexGuard<'_, Gate> {
        self.0.lock().unwrap_or_else(|e| e.into_inner())
    }

    pub fn blocked(&self) -> bool {
        self.gate().blocked
    }

    fn block(&self) {
        self.gate().blocked = true;
    }

    /// Ok when a save may write config.json. While blocked, it tries again:
    /// a file that's gone, or that can now be read and copied aside, lifts
    /// the block.
    pub fn ready(&self) -> Result<(), ConfigError> {
        let mut gate = self.gate();
        if !gate.blocked {
            return Ok(());
        }
        let path = config_path();
        let lifted = match fs::read(&path) {
            Err(e) => e.kind() == std::io::ErrorKind::NotFound,
            Ok(_) => match set_aside(&path, |from, to| fs::copy(from, to).map(|_| ())) {
                Ok(copy) => {
                    eprintln!("config: readable again, kept a copy as {copy}");
                    true
                }
                Err(_) => false,
            },
        };
        gate.blocked = !lifted;
        if lifted {
            Ok(())
        } else {
            Err(ConfigError::Message(BLOCKED.into()))
        }
    }

    /// Keeps a save's result: a failure is logged once and told again by
    /// `take_failure`; a success clears it.
    fn note(&self, result: &Result<(), ConfigError>) {
        let mut gate = self.gate();
        match result {
            Ok(()) => gate.failed = None,
            Err(e) => {
                let e = e.to_string();
                if gate.failed.as_ref() != Some(&e) {
                    eprintln!("config: couldn't save: {e}");
                }
                gate.failed = Some(e);
            }
        }
    }

    /// The user just heard about config.json (the launch notice).
    pub fn told(&self) {
        self.gate().told = Some(Instant::now());
    }

    /// The last save's error, when it failed and the user hasn't heard about
    /// config.json for [`TELL_AGAIN_AFTER`].
    pub fn take_failure(&self) -> Option<String> {
        let mut gate = self.gate();
        let failed = gate.failed.clone()?;
        if gate.told.is_some_and(|at| at.elapsed() < TELL_AGAIN_AFTER) {
            return None;
        }
        gate.told = Some(Instant::now());
        Some(failed)
    }
}

/// What the app tells the user, once, when config.json held something this
/// build couldn't read (and again when a save fails).
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct ConfigNotice {
    pub message: String,
    /// The file as it was: the copy set aside, or config.json itself when
    /// it was left alone.
    pub kept: Option<String>,
    /// The line under the message: `kept` with the home folder as `~`, or
    /// the error.
    pub detail: Option<String>,
}

impl ConfigNotice {
    fn kept(message: impl Into<String>, kept: String) -> Self {
        Self {
            message: message.into(),
            detail: Some(tilde(&kept)),
            kept: Some(kept),
        }
    }

    /// A save that failed, for the app to tell again.
    pub fn save_failed(error: String) -> Self {
        Self {
            message: "Couldn't save to config.json".into(),
            kept: None,
            detail: Some(error),
        }
    }
}

/// `path` with the home folder as `~`.
fn tilde(path: &str) -> String {
    match home_dir().map(|h| h.to_string_lossy().into_owned()) {
        Some(home) if !home.is_empty() && path.starts_with(&home) => {
            format!("~{}", &path[home.len()..])
        }
        _ => path.to_string(),
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

/// Creates `dir` and its parents for this user only: the app's files hold
/// SQL and row values (rowkery/reports#47). A folder already there keeps its
/// mode, since `ROWKERY_CONFIG_DIR` may name one the user shares.
pub fn create_private_dir(dir: &Path) -> std::io::Result<()> {
    let mut builder = fs::DirBuilder::new();
    builder.recursive(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::DirBuilderExt;
        builder.mode(0o700);
    }
    builder.create(dir)
}

/// Opens `path` as a file only this user can read: made so, or, written by
/// an older build, narrowed to it.
pub fn open_private(path: &Path, options: &mut fs::OpenOptions) -> std::io::Result<fs::File> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::{OpenOptionsExt, PermissionsExt};
        options.mode(0o600);
        let file = options.open(path)?;
        // Best effort: a file another user owns still opens as before.
        let _ = file.set_permissions(fs::Permissions::from_mode(0o600));
        Ok(file)
    }
    #[cfg(not(unix))]
    options.open(path)
}

/// [`fs::write`] to a file only this user can read.
pub fn write_private(path: &Path, bytes: impl AsRef<[u8]>) -> std::io::Result<()> {
    use std::io::Write;
    open_private(
        path,
        fs::OpenOptions::new()
            .write(true)
            .create(true)
            .truncate(true),
    )?
    .write_all(bytes.as_ref())
}

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
    /// - saved connections and fields it couldn't read stay in the file
    ///   (`save` writes them back), so they need no copy;
    /// - a file that can't be read at all, or can't be set aside, is left
    ///   where it is and saving waits until it can be (`SaveGate`).
    ///
    /// Each case comes with the notice the app shows once.
    pub fn load_for_app() -> (Self, Option<ConfigNotice>) {
        let path = config_path();
        if !path.exists() {
            return (Self::default(), None);
        }
        let in_place = path.to_string_lossy().into_owned();
        let blocked = |config: Self, message: &str| {
            config.save_gate.block();
            (config, Some(ConfigNotice::kept(message, in_place.clone())))
        };
        const UNTIL: &str = "nothing is saved until it can be";
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
                return blocked(fresh(), &format!("Couldn't read config.json; {UNTIL}"));
            }
        };
        let (config, settings_read) = match Self::parse(&bytes) {
            Ok(parsed) => parsed,
            Err(e) => {
                eprintln!("config: {} isn't valid: {e}", path.display());
                return match set_aside(&path, |from, to| fs::rename(from, to)) {
                    Ok(kept) => {
                        let message = "Couldn't read config.json, so Rowkery started fresh";
                        (fresh(), Some(ConfigNotice::kept(message, kept)))
                    }
                    Err(e) => {
                        eprintln!("config: couldn't set it aside: {e}");
                        let message = format!("Couldn't read config.json or set it aside; {UNTIL}");
                        blocked(fresh(), &message)
                    }
                };
            }
        };
        let unread = match config.unread_connections.len() {
            0 => None,
            1 => Some("1 saved connection this version can't read stays in config.json".into()),
            n => Some(format!(
                "{n} saved connections this version can't read stay in config.json"
            )),
        };
        if settings_read {
            return match unread {
                None => (config, None),
                Some(message) => (config, Some(ConfigNotice::kept(message, in_place))),
            };
        }
        // The next save writes the settings' defaults: keep a copy first.
        match set_aside(&path, |from, to| fs::copy(from, to).map(|_| ())) {
            Ok(copy) => {
                let message = match unread {
                    None => "Couldn't read some settings, so they're reset".to_string(),
                    Some(unread) => format!("Some settings were reset; {unread}"),
                };
                (config, Some(ConfigNotice::kept(message, copy)))
            }
            Err(e) => {
                eprintln!("config: couldn't keep a copy: {e}");
                let message =
                    format!("Couldn't read some settings or keep a copy of config.json; {UNTIL}");
                blocked(config, &message)
            }
        }
    }

    /// Parses config.json's bytes one saved connection at a time. The bool
    /// is false when the settings around them couldn't be read: they're the
    /// defaults then.
    fn parse(bytes: &[u8]) -> Result<(Self, bool), ConfigError> {
        let mut value: Value = serde_json::from_slice(bytes)?;
        let Some(object) = value.as_object_mut() else {
            return Err(ConfigError::Message("not a JSON object".into()));
        };
        let entries = match object.remove("connections") {
            Some(Value::Array(entries)) => entries,
            None | Some(Value::Null) => Vec::new(),
            Some(_) => return Err(ConfigError::Message("connections isn't a list".into())),
        };
        // The webview's state is opaque here, so it never fails the rest.
        let ui = object.remove("ui").filter(|ui| !ui.is_null());
        let (mut config, settings_read) = match Self::deserialize(&value) {
            Ok(mut config) => {
                if let Some(object) = value.as_object() {
                    config.unknown_fields.top = unknown_keys(object, &config);
                }
                (config, true)
            }
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
        let mut after: Option<String> = None;
        for entry in entries {
            match ConnectionRecord::deserialize(&entry) {
                Ok(connection) => {
                    let id = connection.id().to_string();
                    if let Some(object) = entry.as_object() {
                        let unknown = unknown_keys(object, &connection);
                        if !unknown.is_empty() {
                            config
                                .unknown_fields
                                .connections
                                .insert(id.clone(), unknown);
                        }
                    }
                    config.connections.push(connection);
                    after = Some(id);
                }
                Err(e) => {
                    eprintln!("config: kept a saved connection this build can't read: {e}");
                    config.unread_connections.push(UnreadConnection {
                        after: after.clone(),
                        entry,
                    });
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
    /// app; this is its one write path. Refused while the `SaveGate` is
    /// closed; a failure is kept for the app to tell again.
    pub fn save(&self) -> Result<(), ConfigError> {
        let result = self.write();
        self.save_gate.note(&result);
        result
    }

    fn write(&self) -> Result<(), ConfigError> {
        self.save_gate.ready()?;
        let dir = config_dir();
        create_private_dir(&dir)?;
        let path = config_path();
        let tmp = dir.join(format!("{CONFIG_FILE}.tmp"));
        let mut value = serde_json::to_value(self)?;
        if let Some(object) = value.as_object_mut() {
            merge_missing(object, &self.unknown_fields.top);
            if let Some(Value::Array(list)) = object.get_mut("connections") {
                *list = self.connections_as_written(std::mem::take(list));
            }
        }
        let json = serde_json::to_vec_pretty(&value)?;
        write_private(&tmp, json)?;
        fs::rename(&tmp, &path)?;
        Ok(())
    }

    /// The saved connections as `save` writes them: each with the fields
    /// this build didn't know, and the ones it couldn't read back where they
    /// were (last, when the connection they followed is gone).
    fn connections_as_written(&self, list: Vec<Value>) -> Vec<Value> {
        let unread_after = |after: Option<&str>| -> Vec<Value> {
            self.unread_connections
                .iter()
                .filter(|u| u.after.as_deref() == after)
                .map(|u| u.entry.clone())
                .collect()
        };
        let mut out = unread_after(None);
        let mut ids = HashSet::new();
        for mut entry in list {
            let id = entry.get("id").and_then(Value::as_str).map(str::to_owned);
            if let (Some(id), Some(object)) = (&id, entry.as_object_mut()) {
                if let Some(unknown) = self.unknown_fields.connections.get(id) {
                    merge_missing(object, unknown);
                }
            }
            out.push(entry);
            if let Some(id) = id {
                out.extend(unread_after(Some(&id)));
                ids.insert(id);
            }
        }
        out.extend(
            self.unread_connections
                .iter()
                .filter(|u| u.after.as_ref().is_some_and(|a| !ids.contains(a)))
                .map(|u| u.entry.clone()),
        );
        out
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

/// The keys of `object` that `T` doesn't read: without one, it parses the
/// same, and it isn't written back. (A known field left at its default can
/// count too; written back, it reads the same.)
fn unknown_keys<T: DeserializeOwned + Serialize + PartialEq>(
    object: &Map<String, Value>,
    parsed: &T,
) -> Map<String, Value> {
    let written = serde_json::to_value(parsed).unwrap_or_default();
    object
        .iter()
        .filter(|(key, _)| written.get(key.as_str()).is_none())
        .filter(|(key, _)| {
            let mut without = object.clone();
            without.remove(key.as_str());
            T::deserialize(Value::Object(without)).is_ok_and(|t| t == *parsed)
        })
        .map(|(key, v)| (key.clone(), v.clone()))
        .collect()
}

/// Adds `extra`'s keys that `object` doesn't have.
fn merge_missing(object: &mut Map<String, Value>, extra: &Map<String, Value>) {
    for (key, v) in extra {
        object.entry(key.clone()).or_insert_with(|| v.clone());
    }
}

/// Moves or copies (`put`) config.json to a free `config.json.bad-<unix
/// seconds>` beside it; the new path.
fn set_aside(
    path: &Path,
    put: impl Fn(&Path, &Path) -> std::io::Result<()>,
) -> std::io::Result<String> {
    let dir = path.parent().unwrap_or(Path::new("."));
    let secs = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |d| d.as_secs());
    let mut to = dir.join(format!("{CONFIG_FILE}.bad-{secs}"));
    let mut n = 1;
    while to.exists() {
        n += 1;
        to = dir.join(format!("{CONFIG_FILE}.bad-{secs}-{n}"));
    }
    put(path, &to)?;
    Ok(to.to_string_lossy().into_owned())
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

    /// rowkery/reports#47: the folder and config.json are this user's only,
    /// and a file an older build left readable is narrowed when next opened.
    #[cfg(unix)]
    #[test]
    fn app_files_are_only_this_users() {
        use std::os::unix::fs::PermissionsExt;
        let (_guard, dir) = test_guard();
        let mode = |p: &Path| fs::metadata(p).unwrap().permissions().mode() & 0o777;
        AppConfig::default().save().unwrap();
        assert_eq!(mode(&dir), 0o700);
        assert_eq!(mode(&config_path()), 0o600);
        let old = dir.join("old.jsonl");
        fs::write(&old, "x").unwrap();
        fs::set_permissions(&old, fs::Permissions::from_mode(0o644)).unwrap();
        open_private(&old, fs::OpenOptions::new().append(true)).unwrap();
        assert_eq!(mode(&old), 0o600);
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
            ..AppConfig::default()
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
            mcp_timeout_s: None,
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
            mcp_timeout_s: None,
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
        assert!(config.first_run_done && !config.save_gate.blocked());

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
        let entries: Vec<_> = back
            .unread_connections
            .into_iter()
            .map(|u| u.entry)
            .collect();
        assert_eq!(entries, want);
        std::env::remove_var("ROWKERY_CONFIG_DIR");
    }

    /// A newer build's field on a connection this build reads (a
    /// restriction, say) and at the top level survives a save, and an entry
    /// it can't read keeps its place in the list.
    #[test]
    fn unknown_fields_and_unread_places_survive_a_save() {
        let (_guard, dir) = test_guard();
        fs::create_dir_all(&dir).unwrap();
        let restricted = r#"{ "kind": "sqlite", "id": "c2", "name": "two", "path": "/tmp/b.db",
            "hidden_columns": ["users.ssn"], "agent_limit": { "rows": 10 } }"#;
        let future = r#"{ "kind": "mysql", "id": "m1", "name": "shop" }"#;
        fs::write(
            dir.join(CONFIG_FILE),
            format!(
                r#"{{ "version": 2, "theme": "dark", "first_run_done": true, "sync": "icloud",
                    "connections": [{SQLITE_ENTRY}, {future}, {restricted}] }}"#
            ),
        )
        .unwrap();

        let (mut config, _) = AppConfig::load_for_app();
        assert_eq!(config.connections.len(), 2);
        // Edit both readable connections, as the app would.
        for c in config.connections.clone() {
            let ConnectionRecord::Sqlite(mut s) = c else {
                panic!("sqlite")
            };
            s.name = format!("{} renamed", s.name);
            config.upsert_connection(ConnectionRecord::Sqlite(s));
        }
        config.theme = ThemePreference::Light;
        config.save().unwrap();

        let raw: serde_json::Value =
            serde_json::from_str(&fs::read_to_string(dir.join(CONFIG_FILE)).unwrap()).unwrap();
        assert_eq!(raw["sync"], "icloud");
        assert_eq!(raw["theme"], "light");
        let list = raw["connections"].as_array().unwrap();
        let ids: Vec<_> = list.iter().map(|c| c["id"].as_str().unwrap()).collect();
        assert_eq!(ids, ["c1", "m1", "c2"]);
        assert_eq!(list[2]["name"], "two renamed");
        assert_eq!(list[2]["hidden_columns"], serde_json::json!(["users.ssn"]));
        assert_eq!(list[2]["agent_limit"], serde_json::json!({ "rows": 10 }));
        assert!(list[0].get("hidden_columns").is_none());
        // Read again, it's the same config.
        let back = AppConfig::load().unwrap();
        assert_eq!(back.connections, config.connections);
        assert_eq!(back.unknown_fields, config.unknown_fields);
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
    fn a_file_that_cant_be_read_is_never_saved_over_until_it_can_be() {
        let (_guard, dir) = test_guard();
        // A directory where the file should be: reading it fails.
        fs::create_dir_all(dir.join(CONFIG_FILE)).unwrap();
        let (config, notice) = AppConfig::load_for_app();
        assert!(config.save_gate.blocked());
        let notice = notice.expect("a notice");
        assert!(notice.message.contains("until"), "{}", notice.message);
        // Every copy shares the gate (the writer's, the core thread's).
        let copy = config.clone();
        assert!(copy.save().is_err());
        assert!(dir.join(CONFIG_FILE).is_dir());
        // Told once at launch, the failure waits a minute to be told again.
        config.save_gate.told();
        assert_eq!(config.save_gate.take_failure(), None);

        // Readable again: a copy is kept and saving resumes.
        fs::remove_dir(dir.join(CONFIG_FILE)).unwrap();
        fs::write(dir.join(CONFIG_FILE), r#"{ "theme": "dark" }"#).unwrap();
        copy.save().unwrap();
        assert!(!config.save_gate.blocked());
        let names: Vec<_> = files(&dir).into_iter().map(|(name, _)| name).collect();
        assert_eq!(names.len(), 2);
        assert!(names[1].starts_with("config.json.bad-"), "{names:?}");
        assert_eq!(files(&dir)[1].1, r#"{ "theme": "dark" }"#);
        // Later saves make no more copies.
        config.save().unwrap();
        assert_eq!(files(&dir).len(), 2);
        std::env::remove_var("ROWKERY_CONFIG_DIR");
    }

    #[test]
    fn a_failed_save_is_told_again_at_most_once_a_minute() {
        let gate = SaveGate::default();
        assert_eq!(gate.take_failure(), None);
        gate.note(&Err(ConfigError::Message("disk full".into())));
        assert_eq!(gate.take_failure().as_deref(), Some("disk full"));
        assert_eq!(gate.take_failure(), None);
        gate.note(&Ok(()));
        assert_eq!(gate.take_failure(), None);
    }

    #[test]
    fn the_kept_path_is_shown_from_home() {
        let home = home_dir().unwrap();
        let path = home
            .join("Library/config.json.bad-1")
            .to_string_lossy()
            .into_owned();
        let notice = ConfigNotice::kept("m", path.clone());
        assert_eq!(
            notice.detail.as_deref(),
            Some("~/Library/config.json.bad-1")
        );
        assert_eq!(notice.kept, Some(path));
    }
}
