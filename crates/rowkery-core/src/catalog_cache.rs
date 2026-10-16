//! A connection's catalog on disk, so a window shows its schema the moment it
//! opens and confirms it with the server in one round trip.
//!
//! One file per connection and database under `catalog/` beside config.json,
//! written after every full introspection and keyed on the server version and
//! a fingerprint of the catalog's shape (`session_catalog_fingerprint`). It is
//! never written after a failed connect, and a file that doesn't parse is a
//! cache miss, never an error.

use std::fs;
use std::path::PathBuf;

use serde::{Deserialize, Serialize};

use crate::config::config_dir;
use crate::db::SchemaCatalog;

const FORMAT: u32 = 1;

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct CachedCatalog {
    #[serde(default)]
    pub format: u32,
    pub server_version: Option<String>,
    pub fingerprint: String,
    pub catalog: SchemaCatalog,
}

impl CachedCatalog {
    pub fn new(
        server_version: Option<String>,
        fingerprint: String,
        catalog: SchemaCatalog,
    ) -> Self {
        Self {
            format: FORMAT,
            server_version,
            fingerprint,
            catalog,
        }
    }

    /// Still the live catalog: same server version and shape.
    pub fn matches(&self, server_version: Option<&str>, fingerprint: &str) -> bool {
        self.server_version.as_deref() == server_version && self.fingerprint == fingerprint
    }
}

/// File names keep only safe characters; anything else is hex-escaped.
fn safe(name: &str) -> String {
    name.bytes()
        .map(|b| match b {
            b'a'..=b'z' | b'A'..=b'Z' | b'0'..=b'9' | b'-' | b'_' => (b as char).to_string(),
            other => format!("%{other:02x}"),
        })
        .collect()
}

fn dir(connection_id: &str) -> PathBuf {
    config_dir().join("catalog").join(safe(connection_id))
}

fn path(connection_id: &str, database: &str) -> PathBuf {
    dir(connection_id).join(format!("{}.json", safe(database)))
}

/// The cached catalog, or None (missing, unreadable or an older format).
pub fn load(connection_id: &str, database: &str) -> Option<CachedCatalog> {
    let bytes = fs::read(path(connection_id, database)).ok()?;
    serde_json::from_slice::<CachedCatalog>(&bytes)
        .ok()
        .filter(|c| c.format == FORMAT)
}

/// Writes the catalog (temp file + rename). Errors are dropped: a cache.
pub fn store(connection_id: &str, database: &str, cached: &CachedCatalog) {
    let target = path(connection_id, database);
    let Some(parent) = target.parent() else {
        return;
    };
    if fs::create_dir_all(parent).is_err() {
        return;
    }
    let tmp = target.with_extension("json.tmp");
    if let Ok(bytes) = serde_json::to_vec(cached) {
        if fs::write(&tmp, bytes).is_ok() {
            let _ = fs::rename(&tmp, &target);
        }
    }
}

/// Removes every cached database of a connection (it was deleted).
pub fn forget(connection_id: &str) {
    let _ = fs::remove_dir_all(dir(connection_id));
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::config::test_dir_guard;

    #[test]
    fn stores_loads_matches_and_forgets() {
        let _guard = test_dir_guard("catalog-cache");
        assert_eq!(load("pg/1", "app"), None);
        let cached = CachedCatalog::new(
            Some("16.4".into()),
            "abc/def".into(),
            SchemaCatalog::default(),
        );
        store("pg/1", "app db", &cached);
        assert_eq!(load("pg/1", "app db"), Some(cached.clone()));
        assert!(cached.matches(Some("16.4"), "abc/def"));
        assert!(!cached.matches(Some("16.5"), "abc/def"));
        assert!(!cached.matches(Some("16.4"), "abc/xyz"));
        // A broken file is a miss.
        fs::write(path("pg/1", "app db"), b"{ not json").unwrap();
        assert_eq!(load("pg/1", "app db"), None);
        store("pg/1", "app db", &cached);
        forget("pg/1");
        assert_eq!(load("pg/1", "app db"), None);
    }
}
