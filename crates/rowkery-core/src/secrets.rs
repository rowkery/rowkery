//! Connection secrets live in the OS keychain, with an encrypted-file fallback
//! when no keychain is available.

use std::fs;
use std::path::PathBuf;

use chacha20poly1305::aead::{Aead, KeyInit, OsRng};
use chacha20poly1305::{ChaCha20Poly1305, Nonce};
use rand::RngCore;
use serde::{Deserialize, Serialize};
use thiserror::Error;

use crate::config::config_dir;

const SERVICE: &str = "rowkery";
const FALLBACK_FILE: &str = "secrets.enc";
const FALLBACK_KEY_FILE: &str = "secrets.key";

#[derive(Debug, Error)]
pub enum SecretError {
    #[error("keyring: {0}")]
    Keyring(String),
    #[error("io: {0}")]
    Io(#[from] std::io::Error),
    #[error("crypto: {0}")]
    Crypto(String),
    #[error("{0}")]
    Message(String),
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SecretKind {
    DbPassword,
    SshPassword,
    SshKeyPassphrase,
    /// The key that turns a sensitive column's values into the stand-ins
    /// agents get (`mask_key`).
    MaskKey,
}

impl SecretKind {
    fn label(self) -> &'static str {
        match self {
            Self::DbPassword => "db-password",
            Self::SshPassword => "ssh-password",
            Self::SshKeyPassphrase => "ssh-key-passphrase",
            Self::MaskKey => "mask-key",
        }
    }
}

fn entry_account(connection_id: &str, kind: SecretKind) -> String {
    format!("{connection_id}:{kind}", kind = kind.label())
}

#[derive(Serialize, Deserialize, Default)]
struct FallbackStore {
    entries: std::collections::HashMap<String, String>,
}

fn fallback_path() -> PathBuf {
    config_dir().join(FALLBACK_FILE)
}

fn fallback_key_path() -> PathBuf {
    config_dir().join(FALLBACK_KEY_FILE)
}

fn load_fallback_key() -> Result<[u8; 32], SecretError> {
    let path = fallback_key_path();
    if path.exists() {
        let bytes = fs::read(&path)?;
        if bytes.len() == 32 {
            let mut key = [0u8; 32];
            key.copy_from_slice(&bytes);
            return Ok(key);
        }
    }
    let mut key = [0u8; 32];
    OsRng.fill_bytes(&mut key);
    fs::create_dir_all(config_dir())?;
    fs::write(&path, key)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(&path, fs::Permissions::from_mode(0o600))?;
    }
    Ok(key)
}

fn encrypt_store(store: &FallbackStore) -> Result<(), SecretError> {
    let key = load_fallback_key()?;
    let cipher =
        ChaCha20Poly1305::new_from_slice(&key).map_err(|e| SecretError::Crypto(e.to_string()))?;
    let mut nonce_bytes = [0u8; 12];
    OsRng.fill_bytes(&mut nonce_bytes);
    let nonce = Nonce::from_slice(&nonce_bytes);
    let plaintext = serde_json::to_vec(store).map_err(|e| SecretError::Message(e.to_string()))?;
    let ciphertext = cipher
        .encrypt(nonce, plaintext.as_ref())
        .map_err(|e| SecretError::Crypto(e.to_string()))?;
    let mut out = nonce_bytes.to_vec();
    out.extend(ciphertext);
    fs::create_dir_all(config_dir())?;
    fs::write(fallback_path(), out)?;
    Ok(())
}

fn decrypt_store() -> Result<FallbackStore, SecretError> {
    let path = fallback_path();
    if !path.exists() {
        return Ok(FallbackStore::default());
    }
    let key = load_fallback_key()?;
    let cipher =
        ChaCha20Poly1305::new_from_slice(&key).map_err(|e| SecretError::Crypto(e.to_string()))?;
    let bytes = fs::read(&path)?;
    if bytes.len() < 12 {
        return Err(SecretError::Crypto("truncated secrets file".into()));
    }
    let (nonce_bytes, ciphertext) = bytes.split_at(12);
    let nonce = Nonce::from_slice(nonce_bytes);
    let plaintext = cipher
        .decrypt(nonce, ciphertext)
        .map_err(|e| SecretError::Crypto(e.to_string()))?;
    serde_json::from_slice(&plaintext).map_err(|e| SecretError::Message(e.to_string()))
}

fn keyring_set(account: &str, secret: &str) -> Result<(), SecretError> {
    #[cfg(test)]
    if let Some(r) = mock::set(account, secret) {
        return r;
    }
    let entry =
        keyring::Entry::new(SERVICE, account).map_err(|e| SecretError::Keyring(e.to_string()))?;
    entry
        .set_password(secret)
        .map_err(|e| SecretError::Keyring(e.to_string()))
}

fn keyring_get(account: &str) -> Result<Option<String>, SecretError> {
    #[cfg(test)]
    if let Some(r) = mock::get(account) {
        return r;
    }
    let entry =
        keyring::Entry::new(SERVICE, account).map_err(|e| SecretError::Keyring(e.to_string()))?;
    match entry.get_password() {
        Ok(value) => Ok(Some(value)),
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(err) => Err(SecretError::Keyring(err.to_string())),
    }
}

fn keyring_delete(account: &str) -> Result<(), SecretError> {
    #[cfg(test)]
    if let Some(r) = mock::delete(account) {
        return r;
    }
    let entry =
        keyring::Entry::new(SERVICE, account).map_err(|e| SecretError::Keyring(e.to_string()))?;
    match entry.delete_credential() {
        Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
        Err(err) => Err(SecretError::Keyring(err.to_string())),
    }
}

fn fallback_set(account: &str, secret: &str) -> Result<(), SecretError> {
    let mut store = decrypt_store()?;
    store
        .entries
        .insert(account.to_string(), secret.to_string());
    encrypt_store(&store)
}

fn fallback_get(account: &str) -> Result<Option<String>, SecretError> {
    let store = decrypt_store()?;
    Ok(store.entries.get(account).cloned())
}

/// Removes `account` from the fallback file without creating the file or its
/// key when there is nothing to remove.
fn fallback_remove_if_present(account: &str) -> Result<(), SecretError> {
    if !fallback_path().exists() {
        return Ok(());
    }
    let mut store = decrypt_store()?;
    if store.entries.remove(account).is_some() {
        encrypt_store(&store)?;
    }
    Ok(())
}

/// The OS keychain (macOS Keychain, Windows Credential Manager, Secret Service
/// on Linux) is skipped when `ROWKERY_CONFIG_DIR` points the app at its own
/// profile, as tests and proof scripts do, so those never touch the real one.
fn keychain_enabled() -> bool {
    #[cfg(test)]
    return mock::on();
    #[cfg(not(test))]
    std::env::var_os("ROWKERY_CONFIG_DIR").is_none()
}

/// The secrets older builds kept as items of their own (`MaskKey` came
/// after the one item per connection, so it never had one).
const KINDS: [SecretKind; 3] = [
    SecretKind::DbPassword,
    SecretKind::SshPassword,
    SecretKind::SshKeyPassphrase,
];

/// A connection's secrets, by kind label: the JSON held in its one keychain
/// item. One item per connection means macOS asks once per connection (after
/// each unsigned build), and the MCP server only ever reads the items of the
/// connections it was given.
type Item = std::collections::BTreeMap<String, String>;

/// Config directory and keychain account → the secret (None: known absent).
type SecretCache =
    std::sync::Mutex<std::collections::HashMap<(std::path::PathBuf, String), Option<String>>>;

/// Secrets read or stored this run, so reconnecting doesn't ask the keychain
/// again (it can take tens of ms, or prompt). Keyed by config directory too:
/// tests point the app at several.
fn cache() -> &'static SecretCache {
    static CACHE: std::sync::OnceLock<SecretCache> = std::sync::OnceLock::new();
    CACHE.get_or_init(Default::default)
}

fn cache_key(account: &str) -> (std::path::PathBuf, String) {
    (crate::config::config_dir(), account.to_string())
}

fn cache_put(account: &str, value: Option<String>) {
    if let Ok(mut c) = cache().lock() {
        c.insert(cache_key(account), value);
    }
}

/// Each connection's keychain item as read this run; `Err` after a failed
/// read (a denied prompt), so one denial doesn't ask again for every secret.
type ItemCache =
    std::sync::Mutex<std::collections::HashMap<(std::path::PathBuf, String), Result<Item, ()>>>;

fn item_cache() -> &'static ItemCache {
    static CACHE: std::sync::OnceLock<ItemCache> = std::sync::OnceLock::new();
    CACHE.get_or_init(Default::default)
}

/// Reads the connection's keychain item, once per run. Older builds
/// kept one item per secret (`<id>:<kind>`); those are folded into the
/// connection's item and deleted (macOS asks once for each, one last time).
fn keychain_item(connection_id: &str) -> Result<Item, ()> {
    let key = cache_key(connection_id);
    if let Some(hit) = item_cache().lock().ok().and_then(|c| c.get(&key).cloned()) {
        return hit;
    }
    let read = match keyring_get(connection_id) {
        // A value that isn't our JSON is left alone rather than overwritten.
        Ok(Some(json)) => serde_json::from_str::<Item>(&json).map_err(|_| ()),
        Ok(None) => {
            let mut item = Item::new();
            let mut legacy = Vec::new();
            for kind in KINDS {
                let account = entry_account(connection_id, kind);
                if let Ok(Some(value)) = keyring_get(&account) {
                    item.insert(kind.label().to_string(), value);
                    legacy.push(account);
                }
            }
            if !legacy.is_empty() && item_save(connection_id, &item).is_ok() {
                for account in legacy {
                    let _ = keyring_delete(&account);
                }
            }
            Ok(item)
        }
        Err(_) => Err(()),
    };
    if let Ok(mut c) = item_cache().lock() {
        c.insert(key, read.clone());
    }
    read
}

fn item_save(connection_id: &str, item: &Item) -> Result<(), SecretError> {
    let json = serde_json::to_string(item).map_err(|e| SecretError::Message(e.to_string()))?;
    keyring_set(connection_id, &json)?;
    if let Ok(mut c) = item_cache().lock() {
        c.insert(cache_key(connection_id), Ok(item.clone()));
    }
    Ok(())
}

/// Store a connection secret in the OS keychain. The encrypted file beside the
/// config is only used when no keychain is available (e.g. Linux without a
/// Secret Service), since its key sits next to it.
pub fn store_secret(
    connection_id: &str,
    kind: SecretKind,
    secret: &str,
) -> Result<(), SecretError> {
    store_secrets(connection_id, &[(kind, secret)])
}

/// Stores several of a connection's secrets with one keychain write.
fn store_secrets(connection_id: &str, secrets: &[(SecretKind, &str)]) -> Result<(), SecretError> {
    for (kind, secret) in secrets {
        cache_put(
            &entry_account(connection_id, *kind),
            Some(secret.to_string()),
        );
    }
    if keychain_enabled() {
        if let Ok(mut item) = keychain_item(connection_id) {
            for (kind, secret) in secrets {
                item.insert(kind.label().to_string(), secret.to_string());
            }
            if item_save(connection_id, &item).is_ok() {
                // Drop any copy an older build left in the file.
                for (kind, _) in secrets {
                    let _ = fallback_remove_if_present(&entry_account(connection_id, *kind));
                }
                return Ok(());
            }
        }
    }
    for (kind, secret) in secrets {
        fallback_set(&entry_account(connection_id, *kind), secret)?;
    }
    Ok(())
}

/// Read a connection secret. A secret still in the fallback file is moved into
/// the keychain on first read once one is available.
/// Answered from memory after the first read this run.
pub fn get_secret(connection_id: &str, kind: SecretKind) -> Result<Option<String>, SecretError> {
    let account = entry_account(connection_id, kind);
    if let Some(hit) = cache()
        .lock()
        .ok()
        .and_then(|c| c.get(&cache_key(&account)).cloned())
    {
        return Ok(hit);
    }
    let item = if keychain_enabled() {
        keychain_item(connection_id).ok()
    } else {
        None
    };
    if let Some(value) = item.as_ref().and_then(|i| i.get(kind.label())) {
        cache_put(&account, Some(value.clone()));
        return Ok(Some(value.clone()));
    }
    let value = fallback_get(&account)?;
    if let (Some(v), Some(mut item)) = (&value, item) {
        item.insert(kind.label().to_string(), v.clone());
        if item_save(connection_id, &item).is_ok() {
            let _ = fallback_remove_if_present(&account);
        }
    }
    cache_put(&account, value.clone());
    Ok(value)
}

/// The connection's key for the stand-ins agents get in place of sensitive
/// values (`rowkery_mcp::mask`): 32 random bytes as hex, made on first use.
/// It lives in the connection's keychain item beside its passwords, so the
/// MCP server reading it asks the keychain nothing more. An error (a denied
/// keychain) means no stand-ins can be made, so marked columns are refused.
pub fn mask_key(connection_id: &str) -> Result<String, SecretError> {
    if let Some(key) = get_secret(connection_id, SecretKind::MaskKey)? {
        if !key.is_empty() {
            return Ok(key);
        }
    }
    let mut bytes = [0u8; 32];
    OsRng.fill_bytes(&mut bytes);
    let key: String = bytes.iter().map(|b| format!("{b:02x}")).collect();
    store_secret(connection_id, SecretKind::MaskKey, &key)?;
    Ok(key)
}

/// Delete a connection's secrets (keychain, older per-secret items, fallback).
pub fn delete_secrets_for_connection(connection_id: &str) -> Result<(), SecretError> {
    if let Ok(mut c) = item_cache().lock() {
        c.remove(&cache_key(connection_id));
    }
    if keychain_enabled() {
        let _ = keyring_delete(connection_id);
    }
    for kind in KINDS {
        let account = entry_account(connection_id, kind);
        cache_put(&account, None);
        if keychain_enabled() {
            let _ = keyring_delete(&account);
        }
        let _ = fallback_remove_if_present(&account);
    }
    let account = entry_account(connection_id, SecretKind::MaskKey);
    cache_put(&account, None);
    let _ = fallback_remove_if_present(&account);
    Ok(())
}

/// Secrets supplied from the UI (never persisted in JSON config).
#[derive(Clone, Debug, Default, Serialize, Deserialize)]
pub struct ConnectionSecrets {
    pub db_password: Option<String>,
    pub ssh_password: Option<String>,
    pub ssh_key_passphrase: Option<String>,
}

impl ConnectionSecrets {
    /// Fills blank fields from the stored secrets of `connection_id`, so a
    /// test of an edited connection works without retyping its passwords.
    /// Unknown ids (a connection not saved yet) leave the fields blank.
    pub fn or_stored(self, connection_id: &str) -> Self {
        let fill = |value: Option<String>, kind| match value {
            Some(v) if !v.is_empty() => Some(v),
            _ => get_secret(connection_id, kind).ok().flatten(),
        };
        Self {
            db_password: fill(self.db_password, SecretKind::DbPassword),
            ssh_password: fill(self.ssh_password, SecretKind::SshPassword),
            ssh_key_passphrase: fill(self.ssh_key_passphrase, SecretKind::SshKeyPassphrase),
        }
    }

    pub fn persist(&self, connection_id: &str) -> Result<(), SecretError> {
        let typed: Vec<(SecretKind, &str)> = [
            (SecretKind::DbPassword, &self.db_password),
            (SecretKind::SshPassword, &self.ssh_password),
            (SecretKind::SshKeyPassphrase, &self.ssh_key_passphrase),
        ]
        .into_iter()
        .filter_map(|(kind, v)| v.as_deref().filter(|v| !v.is_empty()).map(|v| (kind, v)))
        .collect();
        if typed.is_empty() {
            return Ok(());
        }
        store_secrets(connection_id, &typed)
    }
}

/// A keychain in memory for tests, so the one-item-per-connection logic runs
/// without a real one. Off unless a test turns it on (under `TEST_ENV_LOCK`).
#[cfg(test)]
mod mock {
    use super::SecretError;
    use std::collections::HashMap;
    use std::sync::Mutex;

    #[derive(Default)]
    pub struct Keychain {
        pub items: HashMap<String, String>,
        /// Every read is refused, as a denied macOS prompt is.
        pub deny: bool,
        pub reads: usize,
        pub writes: usize,
    }

    pub static KEYCHAIN: Mutex<Option<Keychain>> = Mutex::new(None);

    fn with<T>(f: impl FnOnce(&mut Keychain) -> T) -> Option<T> {
        KEYCHAIN
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .as_mut()
            .map(f)
    }

    pub fn on() -> bool {
        with(|_| ()).is_some()
    }

    pub fn get(account: &str) -> Option<Result<Option<String>, SecretError>> {
        with(|k| {
            k.reads += 1;
            if k.deny {
                Err(SecretError::Keyring("denied".into()))
            } else {
                Ok(k.items.get(account).cloned())
            }
        })
    }

    pub fn set(account: &str, secret: &str) -> Option<Result<(), SecretError>> {
        with(|k| {
            k.writes += 1;
            k.items.insert(account.to_string(), secret.to_string());
            Ok(())
        })
    }

    pub fn delete(account: &str) -> Option<Result<(), SecretError>> {
        with(|k| {
            k.items.remove(account);
            Ok(())
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::MutexGuard;

    fn test_guard() -> MutexGuard<'static, ()> {
        let guard = crate::config::TEST_ENV_LOCK
            .lock()
            .unwrap_or_else(|e| e.into_inner());
        let dir = std::env::temp_dir().join(format!("rowkery-secrets-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        std::env::set_var("ROWKERY_CONFIG_DIR", dir.to_string_lossy().to_string());
        guard
    }

    #[test]
    fn fallback_round_trip() {
        let _guard = test_guard();
        store_secret("c1", SecretKind::DbPassword, "hunter2").expect("store");
        let value = get_secret("c1", SecretKind::DbPassword).expect("get");
        assert_eq!(value.as_deref(), Some("hunter2"));
        std::env::remove_var("ROWKERY_CONFIG_DIR");
    }

    #[test]
    fn or_stored_keeps_typed_and_fills_blank() {
        let _guard = test_guard();
        store_secret("c2", SecretKind::DbPassword, "stored").expect("store");
        store_secret("c2", SecretKind::SshPassword, "ssh-stored").expect("store");
        let secrets = ConnectionSecrets {
            db_password: Some(String::new()),
            ssh_password: Some("typed".into()),
            ssh_key_passphrase: None,
        }
        .or_stored("c2");
        assert_eq!(secrets.db_password.as_deref(), Some("stored"));
        assert_eq!(secrets.ssh_password.as_deref(), Some("typed"));
        assert_eq!(secrets.ssh_key_passphrase, None);
        std::env::remove_var("ROWKERY_CONFIG_DIR");
    }

    #[test]
    fn the_mask_key_is_made_once_and_kept() {
        let _guard = test_guard();
        let first = mask_key("c4").expect("make");
        assert_eq!(first.len(), 64);
        assert_eq!(mask_key("c4").expect("read"), first);
        assert_ne!(mask_key("c5").expect("other"), first);
        std::env::remove_var("ROWKERY_CONFIG_DIR");
    }

    #[test]
    fn delete_removes_fallback_entries() {
        let _guard = test_guard();
        store_secret("c3", SecretKind::DbPassword, "gone").expect("store");
        delete_secrets_for_connection("c3").expect("delete");
        assert_eq!(get_secret("c3", SecretKind::DbPassword).expect("get"), None);
        std::env::remove_var("ROWKERY_CONFIG_DIR");
    }

    /// Turns the in-memory keychain on with `items` until the returned value
    /// drops.
    struct MockOn;
    impl Drop for MockOn {
        fn drop(&mut self) {
            *mock::KEYCHAIN.lock().unwrap_or_else(|e| e.into_inner()) = None;
        }
    }
    fn mock_on(items: &[(&str, &str)], deny: bool) -> MockOn {
        *mock::KEYCHAIN.lock().unwrap() = Some(mock::Keychain {
            items: items
                .iter()
                .map(|(a, v)| (a.to_string(), v.to_string()))
                .collect(),
            deny,
            ..Default::default()
        });
        MockOn
    }
    fn mock_state<T>(f: impl FnOnce(&mock::Keychain) -> T) -> T {
        f(mock::KEYCHAIN.lock().unwrap().as_ref().expect("mock on"))
    }

    #[test]
    fn one_keychain_item_per_connection() {
        let _guard = test_guard();
        let _mock = mock_on(&[], false);
        ConnectionSecrets {
            db_password: Some("db".into()),
            ssh_password: Some("ssh".into()),
            ssh_key_passphrase: None,
        }
        .persist("k1")
        .expect("persist");
        mock_state(|k| {
            assert_eq!(k.writes, 1, "both secrets go in one write");
            assert_eq!(k.items.len(), 1);
            let item: Item = serde_json::from_str(&k.items["k1"]).unwrap();
            assert_eq!(item["db-password"], "db");
            assert_eq!(item["ssh-password"], "ssh");
        });
        store_secret("k1b", SecretKind::DbPassword, "other").expect("store");
        mock_state(|k| assert_eq!(k.items.len(), 2, "another connection, another item"));
        std::env::remove_var("ROWKERY_CONFIG_DIR");
    }

    #[test]
    fn older_per_secret_items_fold_into_the_connection_item() {
        let _guard = test_guard();
        let _mock = mock_on(
            &[
                ("k2:db-password", "old-db"),
                ("k2:ssh-password", "old-ssh"),
                ("other:db-password", "untouched"),
            ],
            false,
        );
        assert_eq!(
            get_secret("k2", SecretKind::DbPassword).unwrap().as_deref(),
            Some("old-db")
        );
        assert_eq!(
            get_secret("k2", SecretKind::SshPassword)
                .unwrap()
                .as_deref(),
            Some("old-ssh")
        );
        assert_eq!(
            get_secret("k2", SecretKind::SshKeyPassphrase).unwrap(),
            None
        );
        mock_state(|k| {
            assert!(!k.items.contains_key("k2:db-password"));
            assert!(!k.items.contains_key("k2:ssh-password"));
            assert!(k.items.contains_key("other:db-password"));
            let item: Item = serde_json::from_str(&k.items["k2"]).unwrap();
            assert_eq!(item.len(), 2);
            // The item, then the three old accounts, once for the whole run.
            assert_eq!(k.reads, 4);
        });
        std::env::remove_var("ROWKERY_CONFIG_DIR");
    }

    #[test]
    fn a_denied_read_asks_once_per_connection() {
        let _guard = test_guard();
        fallback_set(&entry_account("k3", SecretKind::DbPassword), "from-file").unwrap();
        let _mock = mock_on(&[], true);
        assert_eq!(
            get_secret("k3", SecretKind::DbPassword).unwrap().as_deref(),
            Some("from-file")
        );
        assert_eq!(get_secret("k3", SecretKind::SshPassword).unwrap(), None);
        assert_eq!(
            get_secret("k3", SecretKind::SshKeyPassphrase).unwrap(),
            None
        );
        mock_state(|k| assert_eq!(k.reads, 1));
        std::env::remove_var("ROWKERY_CONFIG_DIR");
    }

    #[test]
    fn a_file_secret_moves_into_the_connection_item() {
        let _guard = test_guard();
        let account = entry_account("k4", SecretKind::DbPassword);
        fallback_set(&account, "filed").unwrap();
        let _mock = mock_on(&[], false);
        assert_eq!(
            get_secret("k4", SecretKind::DbPassword).unwrap().as_deref(),
            Some("filed")
        );
        assert_eq!(fallback_get(&account).unwrap(), None);
        mock_state(|k| {
            let item: Item = serde_json::from_str(&k.items["k4"]).unwrap();
            assert_eq!(item["db-password"], "filed");
        });
        std::env::remove_var("ROWKERY_CONFIG_DIR");
    }

    #[test]
    fn delete_removes_the_item_and_older_items() {
        let _guard = test_guard();
        let _mock = mock_on(&[("k5:ssh-password", "stray")], false);
        store_secret("k5", SecretKind::DbPassword, "gone").expect("store");
        delete_secrets_for_connection("k5").expect("delete");
        mock_state(|k| assert!(k.items.is_empty(), "{:?}", k.items.keys()));
        assert_eq!(get_secret("k5", SecretKind::DbPassword).unwrap(), None);
        std::env::remove_var("ROWKERY_CONFIG_DIR");
    }

    /// Needs a real keychain (macOS Keychain, Windows Credential Manager or a
    /// Linux Secret Service): `cargo test -p rowkery-core keychain -- --ignored`.
    #[test]
    #[ignore]
    fn keychain_round_trip() {
        let account = format!("rowkery-test-{}:db-password", std::process::id());
        keyring_set(&account, "hunter2").expect("set");
        assert_eq!(
            keyring_get(&account).expect("get").as_deref(),
            Some("hunter2")
        );
        keyring_delete(&account).expect("delete");
        assert_eq!(keyring_get(&account).expect("get after delete"), None);
    }
}
