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

const SERVICE: &str = if crate::config::DEV_BUILD {
    "rowkery-dev"
} else {
    "rowkery"
};
const FALLBACK_FILE: &str = "secrets.enc";
const FALLBACK_KEY_FILE: &str = "secrets.key";
const LOCK_FILE: &str = "secrets.lock";

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
    /// A Google service account key (JSON) a Cloud SQL connection signs in with.
    GcpKey,
}

impl SecretKind {
    fn label(self) -> &'static str {
        match self {
            Self::DbPassword => "db-password",
            Self::SshPassword => "ssh-password",
            Self::SshKeyPassphrase => "ssh-key-passphrase",
            Self::MaskKey => "mask-key",
            Self::GcpKey => "gcp-key",
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
    // Whole or not at all: a reader in another process never sees half.
    let tmp = fallback_path().with_extension("enc.tmp");
    fs::write(&tmp, out)?;
    fs::rename(&tmp, fallback_path())?;
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

/// Secrets added after the one item per connection: never items of their own.
const NEWER_KINDS: [SecretKind; 2] = [SecretKind::MaskKey, SecretKind::GcpKey];

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

fn cache_forget(account: &str) {
    if let Ok(mut c) = cache().lock() {
        c.remove(&cache_key(account));
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

/// Holds a lock every Rowkery process takes around a change to a
/// connection's secrets (the app and each agent's MCP server), so two
/// read-change-saves never interleave. Never nested. Without a lock file,
/// no lock: a change is still made.
fn locked<T>(change: impl FnOnce() -> T) -> T {
    let file = fs::create_dir_all(config_dir()).ok().and_then(|_| {
        fs::OpenOptions::new()
            .create(true)
            .truncate(false)
            .write(true)
            .open(config_dir().join(LOCK_FILE))
            .ok()
    });
    let held = file.as_ref().is_some_and(|f| f.lock().is_ok());
    let out = change();
    if held {
        let _ = file.as_ref().map(fs::File::unlock);
    }
    out
}

/// The connection's keychain item as it is now, for a change to it: another
/// process may have saved it since this one read it, and a save from the
/// older copy would undo that. A read refused earlier this run isn't asked
/// again, and a failed read leaves this run's copy as it was.
fn fresh_item(connection_id: &str) -> Result<Item, ()> {
    let key = cache_key(connection_id);
    let before = item_cache().lock().ok().and_then(|mut c| c.remove(&key));
    if let Some(Err(())) = before {
        if let Ok(mut c) = item_cache().lock() {
            c.insert(key, Err(()));
        }
        return Err(());
    }
    match keychain_item(connection_id) {
        Ok(item) => {
            // What this run remembers of each secret follows the item.
            for kind in KINDS.into_iter().chain(NEWER_KINDS) {
                let account = entry_account(connection_id, kind);
                match item.get(kind.label()) {
                    Some(value) => cache_put(&account, Some(value.clone())),
                    None => cache_forget(&account),
                }
            }
            Ok(item)
        }
        Err(()) => {
            if let (Some(before), Ok(mut c)) = (before, item_cache().lock()) {
                c.insert(key, before);
            }
            Err(())
        }
    }
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
    change_secrets(connection_id, secrets, &[])
}

/// Stores `set` and removes `remove` with one read and one write of the
/// connection's keychain item, made from the item as it is now.
fn change_secrets(
    connection_id: &str,
    set: &[(SecretKind, &str)],
    remove: &[SecretKind],
) -> Result<(), SecretError> {
    locked(|| {
        // A failed fresh read falls back on this run's copy, if it has one.
        let item = keychain_enabled()
            .then(|| fresh_item(connection_id).or_else(|()| keychain_item(connection_id)));
        if let Some(Ok(read)) = item {
            let mut item = read.clone();
            for (kind, secret) in set {
                item.insert(kind.label().to_string(), secret.to_string());
            }
            for kind in remove {
                item.remove(kind.label());
            }
            if item == read || item_save(connection_id, &item).is_ok() {
                for (kind, secret) in set {
                    let account = entry_account(connection_id, *kind);
                    cache_put(&account, Some(secret.to_string()));
                    // Drop any copy an older build left in the file.
                    let _ = fallback_remove_if_present(&account);
                }
                for kind in remove {
                    let account = entry_account(connection_id, *kind);
                    fallback_remove_if_present(&account)?;
                    cache_put(&account, None);
                }
                return Ok(());
            }
            // Too big for the keychain (Windows' Credential Manager holds
            // about 1,250 characters, less than a service account key): the
            // file takes them, and the item drops its older copies, which
            // reads would otherwise find first. The small ones move back
            // into the item on their next read.
            let mut item = read.clone();
            for (kind, _) in set {
                item.remove(kind.label());
            }
            for kind in remove {
                item.remove(kind.label());
            }
            if item != read {
                let _ = item_save(connection_id, &item);
            }
        }
        for (kind, secret) in set {
            let account = entry_account(connection_id, *kind);
            fallback_set(&account, secret)?;
            cache_put(&account, Some(secret.to_string()));
        }
        for kind in remove {
            let account = entry_account(connection_id, *kind);
            fallback_remove_if_present(&account)?;
            cache_put(&account, None);
        }
        Ok(())
    })
}

/// Removes one of a connection's secrets (a service account key the
/// connection no longer signs in with).
pub fn delete_secret(connection_id: &str, kind: SecretKind) -> Result<(), SecretError> {
    change_secrets(connection_id, &[], &[kind])
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
    if let (Some(v), Some(_)) = (&value, item) {
        locked(|| {
            if let Ok(mut item) = fresh_item(connection_id) {
                if !item.contains_key(kind.label()) {
                    item.insert(kind.label().to_string(), v.clone());
                    if item_save(connection_id, &item).is_ok() {
                        let _ = fallback_remove_if_present(&account);
                    }
                }
            }
        });
    }
    cache_put(&account, value.clone());
    Ok(value)
}

/// Drops what this run remembers of a connection's secrets, so the next read
/// asks the keychain again. A long-lived process (the MCP server) otherwise
/// keeps a password the app has since changed, or an item it read before
/// the app saved one.
pub fn forget_cached(connection_id: &str) {
    if let Ok(mut c) = item_cache().lock() {
        c.remove(&cache_key(connection_id));
    }
    if let Ok(mut c) = cache().lock() {
        for kind in KINDS.into_iter().chain(NEWER_KINDS) {
            c.remove(&cache_key(&entry_account(connection_id, kind)));
        }
    }
}

/// Whether this run's read of the connection's keychain item was refused (a
/// denied or unanswerable macOS prompt), so a missing password can be told
/// apart from a wrong one.
pub fn keychain_refused(connection_id: &str) -> bool {
    keychain_enabled()
        && item_cache()
            .lock()
            .ok()
            .and_then(|c| c.get(&cache_key(connection_id)).map(|r| r.is_err()))
            .unwrap_or(false)
}

/// The connection's key for the stand-ins agents get in place of sensitive
/// values (`rowkery_mcp::mask`): 32 random bytes as hex, made on first use.
/// It lives in the connection's keychain item beside its passwords, so the
/// MCP server reading it asks the keychain nothing more; with no keychain
/// to hand (a denied read), in the encrypted file. Every process gets the
/// same key: one made elsewhere since this one looked is used, not
/// replaced.
pub fn mask_key(connection_id: &str) -> Result<String, SecretError> {
    if let Some(key) = get_secret(connection_id, SecretKind::MaskKey)? {
        if !key.is_empty() {
            return Ok(key);
        }
    }
    let account = entry_account(connection_id, SecretKind::MaskKey);
    let label = SecretKind::MaskKey.label();
    locked(|| {
        let item = keychain_enabled().then(|| fresh_item(connection_id));
        if let Some(Ok(mut item)) = item {
            if let Some(key) = item.get(label).filter(|k| !k.is_empty()) {
                return Ok(key.clone());
            }
            let key = random_hex(32);
            item.insert(label.to_string(), key.clone());
            if item_save(connection_id, &item).is_ok() {
                cache_put(&account, Some(key.clone()));
                return Ok(key);
            }
        }
        if let Some(key) = fallback_get(&account)?.filter(|k| !k.is_empty()) {
            cache_put(&account, Some(key.clone()));
            return Ok(key);
        }
        let key = random_hex(32);
        fallback_set(&account, &key)?;
        cache_put(&account, Some(key.clone()));
        Ok(key)
    })
}

/// `bytes` from the OS's secure random source, as hex.
pub fn random_hex(bytes: usize) -> String {
    let mut buf = vec![0u8; bytes];
    OsRng.fill_bytes(&mut buf);
    buf.iter().map(|b| format!("{b:02x}")).collect()
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
    for kind in NEWER_KINDS {
        let account = entry_account(connection_id, kind);
        cache_put(&account, None);
        let _ = fallback_remove_if_present(&account);
    }
    Ok(())
}

/// Secrets supplied from the UI (never persisted in JSON config).
#[derive(Clone, Debug, Default, Serialize, Deserialize)]
pub struct ConnectionSecrets {
    pub db_password: Option<String>,
    pub ssh_password: Option<String>,
    pub ssh_key_passphrase: Option<String>,
    /// A Cloud SQL connection's service account key file (JSON).
    #[serde(default)]
    pub gcp_key: Option<String>,
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
            gcp_key: fill(self.gcp_key, SecretKind::GcpKey),
        }
    }

    /// The secrets typed in, by kind.
    fn typed(&self) -> Vec<(SecretKind, &str)> {
        [
            (SecretKind::DbPassword, &self.db_password),
            (SecretKind::SshPassword, &self.ssh_password),
            (SecretKind::SshKeyPassphrase, &self.ssh_key_passphrase),
            (SecretKind::GcpKey, &self.gcp_key),
        ]
        .into_iter()
        .filter_map(|(kind, v)| v.as_deref().filter(|v| !v.is_empty()).map(|v| (kind, v)))
        .collect()
    }

    pub fn persist(&self, connection_id: &str) -> Result<(), SecretError> {
        self.persist_removing(connection_id, &[])
    }

    /// `persist`, also removing `remove`, in the same keychain write.
    pub fn persist_removing(
        &self,
        connection_id: &str,
        remove: &[SecretKind],
    ) -> Result<(), SecretError> {
        let typed: Vec<(SecretKind, &str)> = self
            .typed()
            .into_iter()
            .filter(|(kind, _)| !remove.contains(kind))
            .collect();
        if typed.is_empty() && remove.is_empty() {
            return Ok(());
        }
        change_secrets(connection_id, &typed, remove)
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
        /// Longer values are refused, as Windows' Credential Manager does.
        pub max_len: Option<usize>,
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
            if k.max_len.is_some_and(|max| secret.len() > max) {
                return Err(SecretError::Keyring("too big".into()));
            }
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
        store_secret("c2", SecretKind::GcpKey, "{\"type\":\"service_account\"}").expect("store");
        let secrets = ConnectionSecrets {
            db_password: Some(String::new()),
            ssh_password: Some("typed".into()),
            ssh_key_passphrase: None,
            gcp_key: None,
        }
        .or_stored("c2");
        assert_eq!(secrets.db_password.as_deref(), Some("stored"));
        assert_eq!(secrets.ssh_password.as_deref(), Some("typed"));
        assert_eq!(secrets.ssh_key_passphrase, None);
        assert_eq!(
            secrets.gcp_key.as_deref(),
            Some("{\"type\":\"service_account\"}")
        );
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
            gcp_key: None,
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
    fn a_secret_too_big_for_the_keychain_never_leaves_an_older_one_in_front() {
        let _guard = test_guard();
        let _mock = mock_on(&[], false);
        store_secret("k5", SecretKind::DbPassword, "old").expect("store");
        mock::KEYCHAIN.lock().unwrap().as_mut().unwrap().max_len = Some(200);
        let key = format!("{{\"private_key\":\"{}\"}}", "k".repeat(300));
        ConnectionSecrets {
            db_password: Some("new".into()),
            gcp_key: Some(key.clone()),
            ..Default::default()
        }
        .persist("k5")
        .expect("persist");
        forget_cached("k5");
        assert_eq!(
            get_secret("k5", SecretKind::DbPassword).unwrap().as_deref(),
            Some("new")
        );
        assert_eq!(get_secret("k5", SecretKind::GcpKey).unwrap(), Some(key));
        mock_state(|k| {
            // The password moved back into the item on its read; the key
            // stays in the file.
            let item: Item = serde_json::from_str(&k.items["k5"]).unwrap();
            assert_eq!(item.get("db-password").map(String::as_str), Some("new"));
            assert!(!item.contains_key("gcp-key"));
        });

        delete_secret("k5", SecretKind::GcpKey).expect("delete");
        forget_cached("k5");
        assert_eq!(get_secret("k5", SecretKind::GcpKey).unwrap(), None);
        assert_eq!(
            get_secret("k5", SecretKind::DbPassword).unwrap().as_deref(),
            Some("new")
        );
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
    fn a_write_starts_from_the_item_as_it_is_now() {
        let _guard = test_guard();
        let _mock = mock_on(&[], false);
        // The app reads the item; an MCP server then adds the mask key.
        store_secret("k9", SecretKind::DbPassword, "old").unwrap();
        mock::KEYCHAIN
            .lock()
            .unwrap()
            .as_mut()
            .unwrap()
            .items
            .insert(
                "k9".into(),
                r#"{"db-password":"old","mask-key":"from-mcp"}"#.into(),
            );
        // The app's password edit keeps the key it never read.
        store_secret("k9", SecretKind::DbPassword, "new").unwrap();
        let item: Item = mock_state(|k| serde_json::from_str(&k.items["k9"]).unwrap());
        assert_eq!(item["db-password"], "new");
        assert_eq!(item["mask-key"], "from-mcp");
        // A process that read the item before any key was made finds the
        // one another made since, rather than making a second.
        mock::KEYCHAIN
            .lock()
            .unwrap()
            .as_mut()
            .unwrap()
            .items
            .insert("k9".into(), r#"{"db-password":"new"}"#.into());
        forget_cached("k9");
        assert_eq!(get_secret("k9", SecretKind::MaskKey).unwrap(), None);
        mock::KEYCHAIN
            .lock()
            .unwrap()
            .as_mut()
            .unwrap()
            .items
            .insert(
                "k9".into(),
                r#"{"db-password":"new","mask-key":"other"}"#.into(),
            );
        assert_eq!(mask_key("k9").unwrap(), "other");
        // A delete keeps what another process saved meanwhile.
        mock::KEYCHAIN
            .lock()
            .unwrap()
            .as_mut()
            .unwrap()
            .items
            .insert(
                "k9".into(),
                r#"{"db-password":"newer","mask-key":"other","gcp-key":"g"}"#.into(),
            );
        delete_secret("k9", SecretKind::GcpKey).unwrap();
        let item: Item = mock_state(|k| serde_json::from_str(&k.items["k9"]).unwrap());
        assert_eq!(item["db-password"], "newer");
        assert!(!item.contains_key("gcp-key"));
        std::env::remove_var("ROWKERY_CONFIG_DIR");
    }

    fn put_item(id: &str, json: &str) {
        mock::KEYCHAIN
            .lock()
            .unwrap()
            .as_mut()
            .unwrap()
            .items
            .insert(id.into(), json.into());
    }
    fn set_deny(deny: bool) {
        mock::KEYCHAIN.lock().unwrap().as_mut().unwrap().deny = deny;
    }
    fn reads() -> usize {
        mock_state(|k| k.reads)
    }

    #[test]
    fn a_failed_fresh_read_keeps_this_runs_copy() {
        let _guard = test_guard();
        let _mock = mock_on(&[], false);
        put_item(
            "k10",
            r#"{"db-password":"old","ssh-password":"sshpw","gcp-key":"g"}"#,
        );
        assert_eq!(
            get_secret("k10", SecretKind::DbPassword)
                .unwrap()
                .as_deref(),
            Some("old")
        );
        // The prompt for the fresh read is dismissed: the edit still goes
        // into the item, from the copy this run read.
        set_deny(true);
        store_secret("k10", SecretKind::DbPassword, "new").unwrap();
        delete_secret("k10", SecretKind::GcpKey).unwrap();
        assert!(!keychain_refused("k10"));
        assert_eq!(
            get_secret("k10", SecretKind::SshPassword)
                .unwrap()
                .as_deref(),
            Some("sshpw")
        );
        set_deny(false);
        forget_cached("k10");
        assert_eq!(
            get_secret("k10", SecretKind::DbPassword)
                .unwrap()
                .as_deref(),
            Some("new")
        );
        assert_eq!(get_secret("k10", SecretKind::GcpKey).unwrap(), None);
        std::env::remove_var("ROWKERY_CONFIG_DIR");
    }

    #[test]
    fn writes_ask_the_keychain_no_more_than_they_must() {
        let _guard = test_guard();
        let _mock = mock_on(&[], false);
        // A mask key for a connection already read: one fresh read.
        put_item("k11", r#"{"db-password":"pw"}"#);
        get_secret("k11", SecretKind::DbPassword).unwrap();
        let before = reads();
        mask_key("k11").unwrap();
        assert_eq!(reads() - before, 1);
        // Saving a connection and dropping its key: one read, one write.
        let (before, writes) = (reads(), mock_state(|k| k.writes));
        ConnectionSecrets {
            db_password: Some("pw2".into()),
            ..Default::default()
        }
        .persist_removing("k11", &[SecretKind::GcpKey])
        .unwrap();
        assert_eq!(reads() - before, 1);
        assert_eq!(mock_state(|k| k.writes) - writes, 1);
        // After a denied read this run, writes and the mask key ask nothing
        // more: they go to the file.
        set_deny(true);
        put_item("k12", r#"{"db-password":"pw"}"#);
        assert!(get_secret("k12", SecretKind::DbPassword).is_ok());
        let before = reads();
        store_secret("k12", SecretKind::DbPassword, "x").unwrap();
        let key = mask_key("k12").unwrap();
        assert_eq!(reads() - before, 0);
        assert_eq!(mask_key("k12").unwrap(), key);
        std::env::remove_var("ROWKERY_CONFIG_DIR");
    }

    #[test]
    fn mask_keys_made_at_once_are_one_key() {
        let _guard = test_guard();
        let _mock = mock_on(&[], false);
        put_item("k14", r#"{"db-password":"pw"}"#);
        let keys: Vec<String> = (0..8)
            .map(|_| std::thread::spawn(|| mask_key("k14").unwrap()))
            .collect::<Vec<_>>()
            .into_iter()
            .map(|t| t.join().unwrap())
            .collect();
        assert!(keys.iter().all(|k| *k == keys[0]), "{keys:?}");
        let item: Item = mock_state(|k| serde_json::from_str(&k.items["k14"]).unwrap());
        assert_eq!(item["mask-key"], keys[0]);
        std::env::remove_var("ROWKERY_CONFIG_DIR");
    }

    #[test]
    fn a_file_secret_moving_in_keeps_what_another_process_saved() {
        let _guard = test_guard();
        let _mock = mock_on(&[], false);
        put_item("k13", r#"{"db-password":"old"}"#);
        get_secret("k13", SecretKind::DbPassword).unwrap();
        fallback_set(&entry_account("k13", SecretKind::SshPassword), "filed").unwrap();
        put_item("k13", r#"{"db-password":"new","mask-key":"K"}"#);
        assert_eq!(
            get_secret("k13", SecretKind::SshPassword)
                .unwrap()
                .as_deref(),
            Some("filed")
        );
        let item: Item = mock_state(|k| serde_json::from_str(&k.items["k13"]).unwrap());
        assert_eq!(item["db-password"], "new");
        assert_eq!(item["mask-key"], "K");
        assert_eq!(item["ssh-password"], "filed");
        std::env::remove_var("ROWKERY_CONFIG_DIR");
    }

    #[test]
    fn forget_cached_reads_a_secret_saved_elsewhere_since() {
        let _guard = test_guard();
        store_secret("k6", SecretKind::DbPassword, "old").unwrap();
        // Another process saves a new one; this run still answers from memory.
        fallback_set(&entry_account("k6", SecretKind::DbPassword), "new").unwrap();
        assert_eq!(
            get_secret("k6", SecretKind::DbPassword).unwrap().as_deref(),
            Some("old")
        );
        forget_cached("k6");
        assert_eq!(
            get_secret("k6", SecretKind::DbPassword).unwrap().as_deref(),
            Some("new")
        );
        std::env::remove_var("ROWKERY_CONFIG_DIR");
    }

    #[test]
    fn a_refused_keychain_is_told_apart() {
        let _guard = test_guard();
        let _mock = mock_on(&[], true);
        assert!(!keychain_refused("k7"), "nothing read yet");
        assert_eq!(get_secret("k7", SecretKind::DbPassword).unwrap(), None);
        assert!(keychain_refused("k7"));
        assert!(!keychain_refused("k8"));
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
