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
/// Left once a keychain item was read or saved for this profile (see
/// [`keychain_used`]).
const USED_FILE: &str = "keychain.used";

#[derive(Debug, Error)]
pub enum SecretError {
    #[error("keyring: {0}")]
    Keyring(String),
    /// There is no keychain to ask (no Secret Service on Linux, no keychain
    /// or logon session on macOS and Windows), unlike one that refused.
    #[error("no keychain: {0}")]
    NoKeychain(String),
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
    let read = || match fs::read(&path) {
        Ok(bytes) => Ok(<[u8; 32]>::try_from(bytes).ok()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(e) => Err(SecretError::from(e)),
    };
    if let Some(key) = read()? {
        return Ok(key);
    }
    // Made under the lock, so two processes never each make one.
    locked(|| {
        if let Some(key) = read()? {
            return Ok(key);
        }
        let mut key = [0u8; 32];
        OsRng.fill_bytes(&mut key);
        replace_whole(&path, &key)?;
        Ok(key)
    })
}

/// Replaces `path` with `bytes` whole: a reader in another process never
/// sees half.
fn replace_whole(path: &std::path::Path, bytes: &[u8]) -> Result<(), SecretError> {
    fs::create_dir_all(config_dir())?;
    let tmp = path.with_extension(format!("tmp.{}", random_hex(8)));
    let placed = write_whole(&tmp, bytes).and_then(|()| Ok(fs::rename(&tmp, path)?));
    if placed.is_err() {
        let _ = fs::remove_file(&tmp);
    }
    placed
}

/// Writes `bytes` to a new file only this user can read, on disk before
/// it returns.
fn write_whole(path: &std::path::Path, bytes: &[u8]) -> Result<(), SecretError> {
    use std::io::Write;
    let mut options = fs::OpenOptions::new();
    options.write(true).create(true).truncate(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let mut file = options.open(path)?;
    file.write_all(bytes)?;
    file.sync_all()?;
    Ok(())
}

fn encrypt_store(store: &FallbackStore) -> Result<(), SecretError> {
    changed();
    let written = encrypt_store_now(store);
    changed();
    written
}

fn encrypt_store_now(store: &FallbackStore) -> Result<(), SecretError> {
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
    replace_whole(&fallback_path(), &out)
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
    let read = keyring_get_now(account);
    if read.is_ok() {
        mark_used();
    }
    read
}

fn keyring_get_now(account: &str) -> Result<Option<String>, SecretError> {
    #[cfg(test)]
    if let Some(r) = mock::get(account) {
        return r;
    }
    let entry =
        keyring::Entry::new(SERVICE, account).map_err(|e| SecretError::Keyring(e.to_string()))?;
    match entry.get_password() {
        Ok(value) => Ok(Some(value)),
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(err) if no_keychain(&err) => Err(SecretError::NoKeychain(err.to_string())),
        Err(err) => Err(SecretError::Keyring(err.to_string())),
    }
}

/// Whether a failed read found no keychain at all rather than one that
/// refused. macOS and Windows say so with `NoStorageAccess` (no keychain, no
/// logon session; a denied prompt is a `PlatformFailure` there). On Linux
/// it's the other way round: a locked or dismissed Secret Service is
/// `NoStorageAccess`, and one that can't be reached at all a
/// `PlatformFailure`.
///
/// Read alone, that can't tell a machine with no keychain from one whose
/// keychain is out for a moment (a Secret Service that quit, a Windows
/// service logon): it's trusted only where the keychain never answered
/// this profile on this machine ([`keychain_used`]), checked again when a
/// key would be made or a secret removed.
fn no_keychain(err: &keyring::Error) -> bool {
    if cfg!(any(target_os = "macos", target_os = "windows")) {
        matches!(err, keyring::Error::NoStorageAccess(_))
    } else {
        matches!(err, keyring::Error::PlatformFailure(_))
    }
}

fn keyring_delete(account: &str) -> Result<(), SecretError> {
    changed();
    let deleted = keyring_delete_now(account);
    changed();
    deleted
}

fn keyring_delete_now(account: &str) -> Result<(), SecretError> {
    #[cfg(test)]
    if let Some(r) = mock::delete(account) {
        return r;
    }
    let entry =
        keyring::Entry::new(SERVICE, account).map_err(|e| SecretError::Keyring(e.to_string()))?;
    match entry.delete_credential() {
        Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
        Err(err) if no_keychain(&err) => Err(SecretError::NoKeychain(err.to_string())),
        Err(err) => Err(SecretError::Keyring(err.to_string())),
    }
}

/// The fallback file's entries. A file that can't be decrypted or parsed
/// (its key lost) holds nothing anyone can read, so it counts as empty; one
/// that can't be read at all may hold the newer copy of a secret
/// (`change_secrets`), so that is an error.
fn file_store() -> Result<FallbackStore, SecretError> {
    if !fallback_path().exists() {
        return Ok(FallbackStore::default());
    }
    match decrypt_store() {
        Err(SecretError::Io(e)) => Err(SecretError::Io(e)),
        read => Ok(read.unwrap_or_default()),
    }
}

/// Puts `set` in the fallback file and takes `remove` out of it, with one
/// write (none if nothing changes).
fn file_change(set: &[(String, &str)], remove: &[String]) -> Result<(), SecretError> {
    let mut store = file_store()?;
    let before = store.entries.clone();
    for (account, secret) in set {
        store.entries.insert(account.clone(), secret.to_string());
    }
    store.entries.retain(|account, _| !remove.contains(account));
    if store.entries != before {
        encrypt_store(&store)?;
    }
    Ok(())
}

fn fallback_set(account: &str, secret: &str) -> Result<(), SecretError> {
    file_change(&[(account.to_string(), secret)], &[])
}

/// `account`'s copy in the fallback file.
fn file_copy(account: &str) -> Result<Option<String>, SecretError> {
    Ok(file_store()?.entries.get(account).cloned())
}

/// Removes `accounts`' copies from the fallback file, which reads find
/// before the keychain's.
fn drop_file_copies(accounts: &[String]) -> Result<(), SecretError> {
    file_change(&[], accounts)
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

/// Whether the keychain answered this profile on this machine before. Then
/// one that can't be reached is out for now, not missing: a key made in the
/// file meanwhile would be a second one, and a removal from the file alone
/// would leave the item's copy. A profile copied to another machine starts
/// unmarked there.
fn keychain_used() -> bool {
    fs::read_to_string(config_dir().join(USED_FILE)).is_ok_and(|id| id == machine_id())
}

/// Leaves the marker [`keychain_used`] reads, once per profile per run.
fn mark_used() {
    static MARKED: std::sync::Mutex<Vec<PathBuf>> = std::sync::Mutex::new(Vec::new());
    let dir = config_dir();
    let Ok(mut marked) = MARKED.lock() else {
        return;
    };
    if marked.contains(&dir) && dir.join(USED_FILE).exists() {
        return;
    }
    if (keychain_used() || replace_whole(&dir.join(USED_FILE), machine_id().as_bytes()).is_ok())
        && !marked.contains(&dir)
    {
        marked.push(dir);
    }
}

/// This machine, as the marker records it.
fn machine_id() -> String {
    #[cfg(windows)]
    return std::env::var("COMPUTERNAME").unwrap_or_default();
    #[cfg(not(windows))]
    ["/etc/machine-id", "/var/lib/dbus/machine-id"]
        .iter()
        .find_map(|path| fs::read_to_string(path).ok())
        .map(|id| id.trim().to_string())
        .unwrap_or_default()
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

/// Why a connection's keychain item couldn't be read.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Unread {
    /// A denied or unanswerable prompt, or a value that isn't our JSON.
    Refused,
    /// No keychain to ask: the file holds everything.
    NoKeychain,
    /// A keychain this machine answered before can't be reached now (a
    /// Secret Service that quit): refused, but asked again next time, never
    /// remembered.
    Outage,
    /// Another process held the lock past [`LOCK_WAIT`]; asked again next
    /// time, never remembered.
    Busy,
}

/// Each connection's keychain item as read this run; `Err` after a failed
/// read (a denied prompt, or no keychain), so one denial doesn't ask again
/// for every secret. Never [`Unread::Busy`] or [`Unread::Outage`].
type ItemCache =
    std::sync::Mutex<std::collections::HashMap<(std::path::PathBuf, String), Result<Item, Unread>>>;

fn item_cache() -> &'static ItemCache {
    static CACHE: std::sync::OnceLock<ItemCache> = std::sync::OnceLock::new();
    CACHE.get_or_init(Default::default)
}

/// Reads the connection's keychain item, once per run.
fn keychain_item(connection_id: &str) -> Result<Item, Unread> {
    let key = cache_key(connection_id);
    if let Some(hit) = item_cache().lock().ok().and_then(|c| c.get(&key).cloned()) {
        return hit;
    }
    let saves = changes();
    let read = read_item(connection_id);
    if !passing(&read) {
        if let Ok(mut c) = item_cache().lock() {
            if unchanged_since(saves) {
                c.insert(key, read.clone());
            }
        }
    }
    read
}

/// A failed read that may go another way next time: never remembered.
fn passing(read: &Result<Item, Unread>) -> bool {
    matches!(read, Err(Unread::Busy | Unread::Outage))
}

/// Whether a failed read found no keychain at all, as of now: the marker
/// may have been left since a cached read (another process saved an item).
fn none_here(unread: Unread) -> bool {
    unread == Unread::NoKeychain && !keychain_used()
}

/// Saves and deletes this run, of the item or the file. A read made without
/// the lock is remembered only if none started while it was out, or it
/// could stand in front of a newer value. Each change counts before it
/// remembers its own value, and the check is made holding the cache it
/// fills, so a change can't slip between the check and the insert.
static CHANGES: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);

fn changed() {
    CHANGES.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
}

fn changes() -> u64 {
    CHANGES.load(std::sync::atomic::Ordering::SeqCst)
}

fn unchanged_since(saves: u64) -> bool {
    changes() == saves
}

/// Connections whose older per-secret items were looked for this run and
/// are gone, so a connection with no item yet isn't asked about them again.
fn folded() -> &'static std::sync::Mutex<std::collections::HashSet<(PathBuf, String)>> {
    static FOLDED: std::sync::OnceLock<
        std::sync::Mutex<std::collections::HashSet<(PathBuf, String)>>,
    > = std::sync::OnceLock::new();
    FOLDED.get_or_init(Default::default)
}

fn mark_folded(key: &(PathBuf, String)) {
    if let Ok(mut f) = folded().lock() {
        f.insert(key.clone());
    }
}

/// Removes the older per-secret items a fold couldn't (its save failed),
/// once a save of the item, made from the fold's, holds them.
fn finish_fold(connection_id: &str) {
    let key = cache_key(connection_id);
    if folded().lock().is_ok_and(|f| f.contains(&key)) {
        return;
    }
    for kind in KINDS {
        let _ = keyring_delete(&entry_account(connection_id, kind));
    }
    mark_folded(&key);
}

/// The connection's item as the keychain holds it now. Older builds kept
/// one item per secret (`<id>:<kind>`); those are folded into the
/// connection's item and deleted (macOS asks once for each, one last time).
fn read_item(connection_id: &str) -> Result<Item, Unread> {
    // A value that isn't our JSON is left alone rather than overwritten.
    let parse = |json: String| serde_json::from_str::<Item>(&json).map_err(|_| Unread::Refused);
    let unread = |err: SecretError| match err {
        SecretError::NoKeychain(_) if keychain_used() => Unread::Outage,
        SecretError::NoKeychain(_) => Unread::NoKeychain,
        _ => Unread::Refused,
    };
    let key = cache_key(connection_id);
    match keyring_get(connection_id) {
        Ok(Some(json)) => {
            mark_used();
            mark_folded(&key);
            return parse(json);
        }
        Ok(None) => {}
        Err(err) => return Err(unread(err)),
    }
    if folded().lock().is_ok_and(|f| f.contains(&key)) {
        return Ok(Item::new());
    }
    let held = HELD.get();
    locked(|| {
        // Another process may have folded them, or saved an item, since
        // the read above.
        if !held {
            match keyring_get(connection_id) {
                Ok(Some(json)) => {
                    mark_used();
                    return Ok(parse(json));
                }
                Ok(None) => {}
                Err(err) => return Ok(Err(unread(err))),
            }
        }
        let mut item = Item::new();
        let mut legacy = Vec::new();
        for kind in KINDS {
            let account = entry_account(connection_id, kind);
            match keyring_get(&account) {
                Ok(Some(value)) => {
                    mark_used();
                    item.insert(kind.label().to_string(), value);
                    legacy.push(account);
                }
                Ok(None) => {}
                // Folding without it would lose it: a refused read.
                Err(err) => return Ok(Err(unread(err))),
            }
        }
        if legacy.is_empty() || item_save(connection_id, &item).is_ok() {
            for account in legacy {
                let _ = keyring_delete(&account);
            }
            mark_folded(&key);
        }
        Ok(Ok(item))
    })
    .unwrap_or(Err(Unread::Busy))
}

/// How long a change waits for another process's change to the secrets.
#[cfg(not(test))]
const LOCK_WAIT: std::time::Duration = std::time::Duration::from_secs(10);
#[cfg(test)]
const LOCK_WAIT: std::time::Duration = std::time::Duration::from_millis(500);

thread_local! {
    /// Whether this thread holds the lock, so a change inside a change
    /// doesn't wait on itself.
    static HELD: std::cell::Cell<bool> = const { std::cell::Cell::new(false) };
}

/// The lock file, held: unlocked when dropped, a panic included.
struct Held(fs::File);

impl Drop for Held {
    fn drop(&mut self) {
        HELD.set(false);
        let _ = self.0.unlock();
    }
}

fn busy() -> SecretError {
    SecretError::Message(
        "Another Rowkery window or agent is changing saved passwords. Try again.".into(),
    )
}

/// Runs `change` holding a lock every Rowkery process takes around a change
/// to a connection's secrets (the app and each agent's MCP server), so two
/// read-change-saves never interleave. One held elsewhere is waited on for
/// [`LOCK_WAIT`] (another process may be waiting on a keychain prompt),
/// then the change is turned down. Without a lock file, no lock: a change
/// is still made.
fn locked<T>(change: impl FnOnce() -> Result<T, SecretError>) -> Result<T, SecretError> {
    if HELD.get() {
        return change();
    }
    let file = fs::create_dir_all(config_dir()).ok().and_then(|_| {
        fs::OpenOptions::new()
            .create(true)
            .truncate(false)
            .write(true)
            .open(config_dir().join(LOCK_FILE))
            .ok()
    });
    let started = std::time::Instant::now();
    let _held = match file {
        Some(file) => loop {
            match file.try_lock() {
                Ok(()) => {
                    HELD.set(true);
                    break Some(Held(file));
                }
                Err(fs::TryLockError::WouldBlock) if started.elapsed() < LOCK_WAIT => {
                    std::thread::sleep(std::time::Duration::from_millis(20));
                }
                Err(fs::TryLockError::WouldBlock) => return Err(busy()),
                Err(fs::TryLockError::Error(_)) => break None,
            }
        },
        None => None,
    };
    change()
}

/// The connection's keychain item as it is now, for a change to it: another
/// process may have saved it since this one read it, and a save from the
/// older copy would undo that. A read refused earlier this run isn't asked
/// again, and a failed read leaves a copy this run read as it was.
fn fresh_item(connection_id: &str) -> Result<Item, Unread> {
    let key = cache_key(connection_id);
    let before = item_cache().lock().ok().and_then(|c| c.get(&key).cloned());
    if let Some(Err(unread)) = before {
        return Err(unread);
    }
    let read = read_item(connection_id);
    if let Ok(mut c) = item_cache().lock() {
        match (&read, before) {
            (Ok(item), _) => {
                c.insert(key, Ok(item.clone()));
            }
            (Err(Unread::Busy | Unread::Outage), _) | (Err(_), Some(_)) => {}
            (Err(unread), None) => {
                c.insert(key, Err(*unread));
            }
        }
    }
    if read.is_ok() {
        // Read again on next use: the file may hold a newer copy.
        for kind in KINDS.into_iter().chain(NEWER_KINDS) {
            cache_forget(&entry_account(connection_id, kind));
        }
    }
    read
}

fn item_save(connection_id: &str, item: &Item) -> Result<(), SecretError> {
    let json = serde_json::to_string(item).map_err(|e| SecretError::Message(e.to_string()))?;
    changed();
    let saved = keyring_set(connection_id, &json);
    changed();
    saved?;
    mark_used();
    if let Ok(mut c) = item_cache().lock() {
        c.insert(cache_key(connection_id), Ok(item.clone()));
    }
    // A read that took the old copy from the cache before the insert
    // isn't remembered after it.
    changed();
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
///
/// Where the item can't take a secret (no keychain, a keychain that can't
/// be reached, too big for it), the encrypted file does. A denied prompt
/// saves nothing: it isn't asked again until the next save. Reads look in the file first, and
/// every save into the item drops the file's copy, so the newer of the two
/// is always the one read, and an item that couldn't be read is never
/// saved from an older copy.
fn change_secrets(
    connection_id: &str,
    set: &[(SecretKind, &str)],
    remove: &[SecretKind],
) -> Result<(), SecretError> {
    locked(|| {
        let read = if keychain_enabled() {
            match fresh_item(connection_id) {
                Ok(read) => Some(read),
                // No keychain: the file holds everything.
                Err(unread) if none_here(unread) => None,
                // A secret left in the item can't be removed from the file.
                // A denied prompt: the password isn't put anywhere else.
                Err(Unread::Refused) => {
                    if let Ok(mut c) = item_cache().lock() {
                        c.remove(&cache_key(connection_id));
                    }
                    return Err(SecretError::Message(
                        "The keychain prompt was denied, so nothing was saved. Save again and \
                         click Always Allow."
                            .into(),
                    ));
                }
                Err(_) if !remove.is_empty() => {
                    // Ask again on the next try.
                    if let Ok(mut c) = item_cache().lock() {
                        c.remove(&cache_key(connection_id));
                    }
                    return Err(SecretError::Message(
                        "Rowkery couldn't read this connection's keychain item, so nothing was \
                         saved. Try again."
                            .into(),
                    ));
                }
                Err(_) => None,
            }
        } else {
            None
        };
        let accounts: Vec<String> = set
            .iter()
            .map(|(kind, _)| *kind)
            .chain(remove.iter().copied())
            .map(|kind| entry_account(connection_id, kind))
            .collect();
        for account in &accounts {
            cache_forget(account);
        }
        let mut saved = false;
        if let Some(read) = &read {
            let mut item = read.clone();
            for (kind, secret) in set {
                item.insert(kind.label().to_string(), secret.to_string());
            }
            for kind in remove {
                item.remove(kind.label());
            }
            // The file's copies go first: left behind a save, they would
            // stand in front of it. A save that then fails puts the new
            // values in the file below.
            drop_file_copies(&accounts)?;
            saved = item == *read || item_save(connection_id, &item).is_ok();
            if saved && item != *read {
                finish_fold(connection_id);
            }
        }
        if !saved {
            let filed: Vec<(String, &str)> = set
                .iter()
                .map(|(kind, secret)| (entry_account(connection_id, *kind), *secret))
                .collect();
            let removed: Vec<String> = remove
                .iter()
                .map(|kind| entry_account(connection_id, *kind))
                .collect();
            file_change(&filed, &removed)?;
            // Too big for the keychain (Windows' Credential Manager holds
            // about 1,250 characters, less than a service account key): the
            // item drops what it held of them. The small ones move back into
            // it on their next read. For what was set, only tidying: the
            // file's copies, read first, stand in front of the item's.
            if let Some(read) = read {
                let mut item = read.clone();
                for kind in set.iter().map(|(kind, _)| kind).chain(remove) {
                    item.remove(kind.label());
                }
                if item != read {
                    let held_removed = remove.iter().any(|kind| read.contains_key(kind.label()));
                    // Only a removal the item still holds is lost if it
                    // fails: no copy is left to stand in front of it.
                    if let Err(err) = item_save(connection_id, &item) {
                        if held_removed {
                            return Err(err);
                        }
                    }
                }
            }
        }
        for (kind, secret) in set {
            cache_put(
                &entry_account(connection_id, *kind),
                Some(secret.to_string()),
            );
        }
        for kind in remove {
            cache_put(&entry_account(connection_id, *kind), None);
        }
        Ok(())
    })
}

/// Removes one of a connection's secrets (a service account key the
/// connection no longer signs in with).
pub fn delete_secret(connection_id: &str, kind: SecretKind) -> Result<(), SecretError> {
    change_secrets(connection_id, &[], &[kind])
}

/// What this run remembers of `account`: `Some(None)` when known absent.
fn cached(account: &str) -> Option<Option<String>> {
    cache()
        .lock()
        .ok()
        .and_then(|c| c.get(&cache_key(account)).cloned())
}

/// Read a connection secret: the fallback file's copy, which is the newer
/// (see [`change_secrets`]) and moves into the keychain item once it can,
/// else the item's. Answered from memory after the first read this run.
pub fn get_secret(connection_id: &str, kind: SecretKind) -> Result<Option<String>, SecretError> {
    let account = entry_account(connection_id, kind);
    if let Some(hit) = cached(&account) {
        return Ok(hit);
    }
    let saves = changes();
    let mut value = file_copy(&account)?;
    if value.is_some() && keychain_enabled() {
        // Again under the lock: another process may have moved it in, or
        // saved a newer one, since.
        // Remembered under it too, so a change made just after can't be
        // undone by this.
        return locked(|| {
            let value = match file_copy(&account)? {
                Some(filed) => {
                    move_in(connection_id)?;
                    Some(filed)
                }
                None => fresh_item(connection_id)
                    .ok()
                    .and_then(|item| item.get(kind.label()).cloned()),
            };
            cache_put(&account, value.clone());
            Ok(value)
        });
    }
    if value.is_none() && keychain_enabled() {
        match keychain_item(connection_id) {
            Ok(item) => value = item.get(kind.label()).cloned(),
            // Not "none saved", or a blank password would be tried.
            Err(Unread::Busy) => return Err(busy()),
            Err(Unread::Outage) => {
                return Err(SecretError::Message(
                    "The keychain can't be reached right now, so the saved password can't be read. Try again."
                        .into(),
                ))
            }
            Err(_) => {}
        }
    }
    if let Ok(mut c) = cache().lock() {
        if unchanged_since(saves) {
            c.insert(cache_key(&account), value.clone());
        }
    }
    Ok(value)
}

/// Connections whose file copies wouldn't all fit in their item this run,
/// so reads don't try again.
fn stuck() -> &'static std::sync::Mutex<std::collections::HashSet<(PathBuf, String)>> {
    static STUCK: std::sync::OnceLock<
        std::sync::Mutex<std::collections::HashSet<(PathBuf, String)>>,
    > = std::sync::OnceLock::new();
    STUCK.get_or_init(Default::default)
}

/// Moves every secret of the connection the file holds into its item, with
/// one read and one write; if the item can't take them all (too big), one
/// at a time, and the rest stay in the file. Under the lock.
fn move_in(connection_id: &str) -> Result<(), SecretError> {
    let key = cache_key(connection_id);
    if stuck().lock().is_ok_and(|s| s.contains(&key)) {
        return Ok(());
    }
    let Ok(mut item) = fresh_item(connection_id) else {
        return Ok(());
    };
    let mut filed = Vec::new();
    for kind in KINDS.into_iter().chain(NEWER_KINDS) {
        let account = entry_account(connection_id, kind);
        if let Some(value) = file_copy(&account)? {
            filed.push((kind, account, value));
        }
    }
    let mut all = item.clone();
    for (kind, _, value) in &filed {
        all.insert(kind.label().to_string(), value.clone());
    }
    let moved: Vec<String> = if item_save(connection_id, &all).is_ok() {
        filed.into_iter().map(|(_, account, _)| account).collect()
    } else {
        let mut moved = Vec::new();
        for (kind, account, value) in filed {
            let mut next = item.clone();
            next.insert(kind.label().to_string(), value);
            if item_save(connection_id, &next).is_ok() {
                item = next;
                moved.push(account);
            }
        }
        if let Ok(mut s) = stuck().lock() {
            s.insert(key);
        }
        moved
    };
    if !moved.is_empty() {
        finish_fold(connection_id);
    }
    drop_file_copies(&moved)
}

/// Drops what this run remembers of a connection's secrets, so the next read
/// asks the keychain again. A long-lived process (the MCP server) otherwise
/// keeps a password the app has since changed, or an item it read before
/// the app saved one.
pub fn forget_cached(connection_id: &str) {
    // A read already out isn't remembered over the forgetting.
    changed();
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
            .and_then(|c| {
                c.get(&cache_key(connection_id))
                    .map(|r| *r == Err(Unread::Refused))
            })
            .unwrap_or(false)
}

/// The connection's key for the stand-ins agents get in place of sensitive
/// values (`rowkery_mcp::mask`): 32 random bytes as hex, made on first use.
/// It lives in the connection's keychain item beside its passwords, so the
/// MCP server reading it asks the keychain nothing more. Every process gets
/// the same key: one made elsewhere since this one looked is used, not
/// replaced. An error (a denied keychain) means no stand-ins can be made,
/// so marked columns are refused: a key made elsewhere could hold a
/// different one. Where there is no keychain at all, the file holds it.
pub fn mask_key(connection_id: &str) -> Result<String, SecretError> {
    let account = entry_account(connection_id, SecretKind::MaskKey);
    if let Some(Some(key)) = cached(&account) {
        if !key.is_empty() {
            return Ok(key);
        }
    }
    locked(|| {
        let key = mask_key_now(connection_id, &account)?;
        cache_put(&account, Some(key.clone()));
        Ok(key)
    })
}

/// [`mask_key`]'s work, under the lock.
fn mask_key_now(connection_id: &str, account: &str) -> Result<String, SecretError> {
    let label = SecretKind::MaskKey.label();
    // One in the file is the newer, as for any secret (`get_secret`),
    // and moves into the item if it can. A file that can't be read
    // may hold it: refused, never a second key.
    if let Some(key) = file_copy(account)?.filter(|k| !k.is_empty()) {
        if keychain_enabled() {
            move_in(connection_id)?;
        }
        return Ok(key);
    }
    let key = random_hex(32);
    let read = if keychain_enabled() {
        fresh_item(connection_id)
    } else {
        Err(Unread::NoKeychain)
    };
    let mut item = match read {
        Ok(item) => item,
        // Nowhere else a key could be: the file holds it.
        Err(unread) if !keychain_enabled() || none_here(unread) => {
            fallback_set(account, &key)?;
            return Ok(key);
        }
        Err(_) => {
            return Err(SecretError::Message(
                "the connection's keychain item couldn't be read".into(),
            ))
        }
    };
    if let Some(made) = item.get(label).filter(|k| !k.is_empty()) {
        return Ok(made.clone());
    }
    item.insert(label.to_string(), key.clone());
    if item_save(connection_id, &item).is_ok() {
        finish_fold(connection_id);
    } else {
        fallback_set(account, &key)?;
    }
    Ok(key)
}

/// `bytes` from the OS's secure random source, as hex.
pub fn random_hex(bytes: usize) -> String {
    let mut buf = vec![0u8; bytes];
    OsRng.fill_bytes(&mut buf);
    buf.iter().map(|b| format!("{b:02x}")).collect()
}

/// Delete a connection's secrets (keychain, older per-secret items, fallback).
pub fn delete_secrets_for_connection(connection_id: &str) -> Result<(), SecretError> {
    locked(|| {
        // Counted first, and the caches cleared last: a read that began
        // before the deletes isn't remembered over them.
        changed();
        // The item's delete failing (a keychain out for now) is told: left
        // behind, its secrets would come back with the same id.
        let deleted = match keychain_enabled().then(|| keyring_delete(connection_id)) {
            Some(Err(SecretError::NoKeychain(_))) if !keychain_used() => Ok(()),
            Some(Err(err)) => Err(err),
            _ => Ok(()),
        };
        let accounts: Vec<String> = KINDS
            .into_iter()
            .chain(NEWER_KINDS)
            .map(|kind| entry_account(connection_id, kind))
            .collect();
        if keychain_enabled() {
            for kind in KINDS {
                let _ = keyring_delete(&entry_account(connection_id, kind));
            }
        }
        let _ = drop_file_copies(&accounts);
        if let Ok(mut c) = item_cache().lock() {
            c.remove(&cache_key(connection_id));
        }
        changed();
        for account in &accounts {
            cache_put(account, None);
        }
        deleted
    })
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
        /// There is no keychain, as on Linux without a Secret Service.
        pub absent: bool,
        /// Every write is refused, as a denied macOS prompt is.
        pub refuse_writes: bool,
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
            if k.absent {
                Err(SecretError::NoKeychain("no Secret Service".into()))
            } else if k.deny {
                Err(SecretError::Keyring("denied".into()))
            } else {
                Ok(k.items.get(account).cloned())
            }
        })
    }

    pub fn set(account: &str, secret: &str) -> Option<Result<(), SecretError>> {
        with(|k| {
            k.writes += 1;
            if k.absent {
                return Err(SecretError::NoKeychain("no Secret Service".into()));
            }
            if k.refuse_writes {
                return Err(SecretError::Keyring("denied".into()));
            }
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
            // The item, again under the lock, then the three old accounts,
            // once for the whole run.
            assert_eq!(k.reads, 5);
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
    fn a_denied_prompt_saves_nothing_and_asks_again_next_save() {
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
        // Another process adds the mask key; then the prompt for the fresh
        // read is denied. Nothing is saved, in the item or the file, so the
        // key isn't dropped by a save from this run's copy either.
        put_item(
            "k10",
            r#"{"db-password":"old","ssh-password":"sshpw","gcp-key":"g","mask-key":"K"}"#,
        );
        set_deny(true);
        let err = store_secret("k10", SecretKind::DbPassword, "new").unwrap_err();
        assert!(err.to_string().contains("Always Allow"), "{err}");
        assert_eq!(
            file_copy(&entry_account("k10", SecretKind::DbPassword)).unwrap(),
            None
        );
        // A removal needs the item: refused too, and asked again next time.
        assert!(delete_secret("k10", SecretKind::GcpKey).is_err());
        assert!(!keychain_refused("k10"));
        let item: Item = mock_state(|k| serde_json::from_str(&k.items["k10"]).unwrap());
        assert_eq!(item["db-password"], "old");
        assert_eq!(item["mask-key"], "K");
        // Allowed on the next save, it goes into the item.
        set_deny(false);
        store_secret("k10", SecretKind::DbPassword, "new").unwrap();
        let item: Item = mock_state(|k| serde_json::from_str(&k.items["k10"]).unwrap());
        assert_eq!(item["db-password"], "new");
        assert_eq!(item["mask-key"], "K");
        assert_eq!(
            get_secret("k10", SecretKind::DbPassword)
                .unwrap()
                .as_deref(),
            Some("new")
        );
        delete_secret("k10", SecretKind::GcpKey).unwrap();
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
        // A mask key for a connection not read yet: one read.
        put_item("k15", r#"{"db-password":"pw"}"#);
        let before = reads();
        mask_key("k15").unwrap();
        assert_eq!(reads() - before, 1);
        // A connection with no item looks for older per-secret items once.
        store_secret("k16", SecretKind::DbPassword, "a").unwrap();
        let before = reads();
        store_secret("k16", SecretKind::DbPassword, "b").unwrap();
        assert_eq!(reads() - before, 1);
        // After a denied read this run, a write asks nothing more and saves
        // nothing. No mask key is made: the item may hold one already.
        set_deny(true);
        put_item("k12", r#"{"db-password":"pw","mask-key":"K"}"#);
        assert!(get_secret("k12", SecretKind::DbPassword).is_ok());
        let before = reads();
        assert!(mask_key("k12").is_err());
        assert!(store_secret("k12", SecretKind::DbPassword, "x").is_err());
        assert_eq!(reads() - before, 0);
        assert_eq!(
            file_copy(&entry_account("k12", SecretKind::DbPassword)).unwrap(),
            None
        );
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
    fn a_save_into_the_item_drops_the_files_copy() {
        let _guard = test_guard();
        let _mock = mock_on(&[], false);
        put_item("k17", r#"{"db-password":"pw"}"#);
        let account = entry_account("k17", SecretKind::SshPassword);
        fallback_set(&account, "old-file").unwrap();
        store_secret("k17", SecretKind::SshPassword, "new").unwrap();
        assert_eq!(file_copy(&account).unwrap(), None);
        forget_cached("k17");
        assert_eq!(
            get_secret("k17", SecretKind::SshPassword)
                .unwrap()
                .as_deref(),
            Some("new")
        );
        std::env::remove_var("ROWKERY_CONFIG_DIR");
    }

    #[test]
    fn a_file_copy_moved_in_elsewhere_meanwhile_gives_way() {
        let _guard = test_guard();
        let _mock = mock_on(&[], false);
        put_item("k19", r#"{"db-password":"old"}"#);
        let account = entry_account("k19", SecretKind::DbPassword);
        fallback_set(&account, "V1").unwrap();
        // Another process holds the lock while this one reads the file.
        let other = fs::OpenOptions::new()
            .write(true)
            .open(config_dir().join(LOCK_FILE))
            .unwrap();
        other.lock().unwrap();
        let reader = std::thread::spawn(|| get_secret("k19", SecretKind::DbPassword).unwrap());
        std::thread::sleep(std::time::Duration::from_millis(200));
        // It saves a newer one into the item, dropping the file's copy.
        put_item("k19", r#"{"db-password":"V2"}"#);
        drop_file_copies(std::slice::from_ref(&account)).unwrap();
        other.unlock().unwrap();
        assert_eq!(reader.join().unwrap().as_deref(), Some("V2"));
        let item: Item = mock_state(|k| serde_json::from_str(&k.items["k19"]).unwrap());
        assert_eq!(item["db-password"], "V2");
        std::env::remove_var("ROWKERY_CONFIG_DIR");
    }

    #[test]
    fn an_unreadable_file_counts_as_empty() {
        let _guard = test_guard();
        fs::create_dir_all(config_dir()).unwrap();
        fs::write(fallback_path(), b"not a secrets file at all").unwrap();
        assert_eq!(get_secret("k20", SecretKind::DbPassword).unwrap(), None);
        store_secret("k20", SecretKind::DbPassword, "pw").unwrap();
        forget_cached("k20");
        assert_eq!(
            get_secret("k20", SecretKind::DbPassword)
                .unwrap()
                .as_deref(),
            Some("pw")
        );
        std::env::remove_var("ROWKERY_CONFIG_DIR");
    }

    #[test]
    fn a_panic_inside_a_change_lets_go_of_the_lock() {
        let _guard = test_guard();
        let crashed = std::panic::catch_unwind(|| {
            let _ = locked(|| -> Result<(), SecretError> { panic!("inside") });
        });
        assert!(crashed.is_err());
        assert!(!HELD.get());
        let file = fs::OpenOptions::new()
            .write(true)
            .open(config_dir().join(LOCK_FILE))
            .unwrap();
        file.try_lock().expect("free");
        std::env::remove_var("ROWKERY_CONFIG_DIR");
    }

    #[test]
    fn a_change_waits_for_one_held_elsewhere_then_gives_up() {
        let _guard = test_guard();
        fs::create_dir_all(config_dir()).unwrap();
        let other = fs::OpenOptions::new()
            .create(true)
            .truncate(false)
            .write(true)
            .open(config_dir().join(LOCK_FILE))
            .unwrap();
        other.lock().unwrap();
        let started = std::time::Instant::now();
        assert!(store_secret("k18", SecretKind::DbPassword, "pw").is_err());
        assert!(started.elapsed() >= LOCK_WAIT);
        other.unlock().unwrap();
        store_secret("k18", SecretKind::DbPassword, "pw").unwrap();
        std::env::remove_var("ROWKERY_CONFIG_DIR");
    }

    #[test]
    fn a_lock_held_too_long_is_asked_again_not_taken_as_a_refusal() {
        let _guard = test_guard();
        let _mock = mock_on(&[("k22:db-password", "old-db")], false);
        fs::create_dir_all(config_dir()).unwrap();
        let other = fs::OpenOptions::new()
            .create(true)
            .truncate(false)
            .write(true)
            .open(config_dir().join(LOCK_FILE))
            .unwrap();
        // Folding the older item waits for the lock, then gives up.
        other.lock().unwrap();
        assert!(get_secret("k22", SecretKind::DbPassword).is_err());
        assert!(!keychain_refused("k22"));
        other.unlock().unwrap();
        assert_eq!(
            get_secret("k22", SecretKind::DbPassword)
                .unwrap()
                .as_deref(),
            Some("old-db")
        );
        std::env::remove_var("ROWKERY_CONFIG_DIR");
    }

    #[test]
    fn a_keychain_used_before_and_gone_now_is_refused_not_replaced() {
        let _guard = test_guard();
        let _mock = mock_on(&[], false);
        store_secret("k24", SecretKind::DbPassword, "pw").unwrap();
        // The Secret Service quits; another process starts.
        mock::KEYCHAIN.lock().unwrap().as_mut().unwrap().absent = true;
        forget_cached("k24");
        assert!(mask_key("k24").is_err(), "never a second key");
        assert!(delete_secret("k24", SecretKind::DbPassword).is_err());
        assert!(get_secret("k24", SecretKind::DbPassword).is_err());
        // Back again: asked again, not remembered as gone.
        mock::KEYCHAIN.lock().unwrap().as_mut().unwrap().absent = false;
        assert_eq!(
            get_secret("k24", SecretKind::DbPassword)
                .unwrap()
                .as_deref(),
            Some("pw")
        );
        let key = mask_key("k24").unwrap();
        assert!(file_copy(&entry_account("k24", SecretKind::MaskKey))
            .unwrap()
            .is_none());
        assert_eq!(mask_key("k24").unwrap(), key);
        // A profile copied to another machine starts unmarked there.
        fs::write(config_dir().join(USED_FILE), "another-machine").unwrap();
        assert!(!keychain_used());
        std::env::remove_var("ROWKERY_CONFIG_DIR");
    }

    #[test]
    fn a_removal_the_item_still_holds_is_never_reported_done() {
        let _guard = test_guard();
        let _mock = mock_on(&[], false);
        put_item("k25", r#"{"db-password":"a","gcp-key":"g"}"#);
        mock::KEYCHAIN
            .lock()
            .unwrap()
            .as_mut()
            .unwrap()
            .refuse_writes = true;
        assert!(change_secrets(
            "k25",
            &[(SecretKind::DbPassword, "b")],
            &[SecretKind::GcpKey]
        )
        .is_err());
        // Set alone: the file holds it, read first.
        store_secret("k25", SecretKind::SshPassword, "s").unwrap();
        assert_eq!(
            get_secret("k25", SecretKind::SshPassword)
                .unwrap()
                .as_deref(),
            Some("s")
        );
        std::env::remove_var("ROWKERY_CONFIG_DIR");
    }

    #[test]
    fn with_no_keychain_the_file_holds_everything() {
        let _guard = test_guard();
        let _mock = mock_on(&[], false);
        mock::KEYCHAIN.lock().unwrap().as_mut().unwrap().absent = true;
        let key = mask_key("k23").expect("a key without a keychain");
        assert_eq!(key.len(), 64);
        forget_cached("k23");
        assert_eq!(mask_key("k23").unwrap(), key);
        store_secret("k23", SecretKind::DbPassword, "pw").unwrap();
        delete_secret("k23", SecretKind::DbPassword).unwrap();
        assert_eq!(get_secret("k23", SecretKind::DbPassword).unwrap(), None);
        assert!(!keychain_refused("k23"));
        assert_eq!(
            file_copy(&entry_account("k23", SecretKind::MaskKey))
                .unwrap()
                .as_deref(),
            Some(key.as_str())
        );
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
        assert_eq!(file_copy(&account).unwrap(), None);
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
