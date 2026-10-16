//! The sample database: a small SQLite file built from `sample/sample.sql`
//! beside config.json on first launch and opened writable. The SQL ships in
//! the binary, so "copying the bundle" is writing it out again: a reset puts
//! back exactly the same rows.

use std::fs;
use std::path::PathBuf;

use crate::config::{config_dir, AppConfig};
use crate::connections::{ConnectionRecord, SqliteConnection};

/// Built into the binary; deterministic, so every copy is the same.
pub const SAMPLE_SQL: &str = include_str!("../sample/sample.sql");
pub const SAMPLE_ID: &str = "sample";
pub const SAMPLE_NAME: &str = "Sample database";
const SAMPLE_FILE: &str = "sample.sqlite";

/// Where the working copy lives (Application Support on macOS).
pub fn sample_path() -> PathBuf {
    config_dir().join(SAMPLE_FILE)
}

/// Writes a fresh copy over `sample_path()`: built in a temp file and
/// renamed, so a failed build leaves the old copy, and an open window sees
/// either the old file or the new one, never half of one.
pub fn write_sample() -> Result<PathBuf, String> {
    let dir = config_dir();
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let path = sample_path();
    let tmp = dir.join(format!("{SAMPLE_FILE}.tmp"));
    let _ = fs::remove_file(&tmp);
    {
        let conn = rusqlite::Connection::open(&tmp).map_err(|e| e.to_string())?;
        conn.execute_batch(SAMPLE_SQL)
            .map_err(|e| format!("Couldn't build the sample database: {e}"))?;
    }
    fs::rename(&tmp, &path).map_err(|e| e.to_string())?;
    Ok(path)
}

/// The record for the working copy: plain name, no environment, safe mode Off.
pub fn sample_record() -> ConnectionRecord {
    ConnectionRecord::Sqlite(SqliteConnection {
        id: SAMPLE_ID.into(),
        name: SAMPLE_NAME.into(),
        path: sample_path().to_string_lossy().to_string(),
        environment: None,
        safe_mode: Default::default(),
        sample: true,
        allow_mcp: false,
        mcp_hidden_tables: Vec::new(),
        mcp_until: None,
        mcp_samples_off: false,
        mcp_access: None,
        masked_columns: Default::default(),
    })
}

/// First launch's decision: `None` once taken, else whether to add the
/// sample (only when there are no saved connections). The caller writes the
/// file (`write_sample`) off the core thread, then calls `apply_first_run`.
pub fn first_run_plan(config: &AppConfig) -> Option<bool> {
    (!config.first_run_done).then_some(config.connections.is_empty())
}

/// Records the decision so a deleted sample stays deleted; with `added`
/// the sample's record joins the list.
pub fn apply_first_run(config: &mut AppConfig, added: bool) {
    config.first_run_done = true;
    if added {
        upsert_sample(config);
    }
}

/// "Open the sample database": its record, put back if it was deleted.
/// The caller writes the file first when it is missing or being reset.
pub fn upsert_sample(config: &mut AppConfig) -> ConnectionRecord {
    let record = config
        .connections
        .iter()
        .find(|c| matches!(c, ConnectionRecord::Sqlite(s) if s.sample))
        .cloned()
        .unwrap_or_else(sample_record);
    config.upsert_connection(record.clone());
    record
}

/// The file is missing (deleted by hand, or never written).
pub fn sample_missing() -> bool {
    !sample_path().exists()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::config::test_dir_guard;

    fn count(path: &PathBuf, table: &str) -> i64 {
        let conn = rusqlite::Connection::open(path).unwrap();
        conn.query_row(&format!("SELECT COUNT(*) FROM {table}"), [], |r| r.get(0))
            .unwrap()
    }

    #[test]
    fn first_run_writes_the_sample_once() {
        let _guard = test_dir_guard("sample-first");
        let mut config = AppConfig::default();
        assert_eq!(first_run_plan(&config), Some(true));
        let path = write_sample().unwrap();
        apply_first_run(&mut config, true);
        assert_eq!(config.connections, vec![sample_record()]);
        assert_eq!(count(&path, "kiosks"), 12);
        assert_eq!(count(&path, "kiosk_sessions"), 600);
        // Deleted, it stays deleted.
        config.remove_connection(SAMPLE_ID);
        assert_eq!(first_run_plan(&config), None);
        std::env::remove_var("ROWKERY_CONFIG_DIR");
    }

    #[test]
    fn existing_users_get_no_sample() {
        let _guard = test_dir_guard("sample-existing");
        let mut config = AppConfig::default();
        config.upsert_connection(ConnectionRecord::Sqlite(SqliteConnection {
            allow_mcp: false,
            mcp_hidden_tables: Vec::new(),
            mcp_until: None,
            mcp_samples_off: false,
            mcp_access: None,
            masked_columns: Default::default(),
            id: "mine".into(),
            name: "mine".into(),
            path: "/tmp/mine.db".into(),
            environment: None,
            safe_mode: Default::default(),
            sample: false,
        }));
        assert_eq!(first_run_plan(&config), Some(false));
        apply_first_run(&mut config, false);
        assert!(config.first_run_done);
        assert_eq!(config.connections.len(), 1);
        assert!(sample_missing());
        std::env::remove_var("ROWKERY_CONFIG_DIR");
    }

    #[test]
    fn reset_puts_the_rows_back() {
        let _guard = test_dir_guard("sample-reset");
        let mut config = AppConfig::default();
        let path = write_sample().unwrap();
        assert_eq!(upsert_sample(&mut config), sample_record());
        rusqlite::Connection::open(&path)
            .unwrap()
            .execute_batch("DELETE FROM kiosk_sessions; DROP VIEW daily_takings;")
            .unwrap();
        assert_eq!(count(&path, "kiosk_sessions"), 0);
        write_sample().unwrap();
        assert_eq!(count(&path, "kiosk_sessions"), 600);
        assert_eq!(count(&path, "daily_takings"), 600);
        // Upserting again doesn't duplicate it.
        upsert_sample(&mut config);
        assert_eq!(config.connections.len(), 1);
        std::env::remove_var("ROWKERY_CONFIG_DIR");
    }
}
