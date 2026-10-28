//! SSH local port-forward via `russh`.

use std::collections::HashMap;
use std::fs;
use std::net::SocketAddr;
use std::path::PathBuf;
use std::sync::Arc;
use std::time::Duration;

use russh::client::{self, Config, Handler};
use russh::keys::{
    decode_secret_key, Algorithm, EcdsaCurve, HashAlg, PrivateKeyWithHashAlg, PublicKey,
    PublicKeyOrCertificate,
};
use russh::{Channel, Preferred};
use thiserror::Error;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};
use tokio::sync::oneshot;
use tokio::task::JoinHandle;

use crate::config::config_dir;
use crate::connections::{expand_home, SshAuthMethod, SshConfig};
use crate::secrets::{get_secret, ConnectionSecrets, SecretError, SecretKind};

#[derive(Debug, Error)]
pub enum SshError {
    #[error("{0}")]
    Message(String),
    #[error("secret store: {0}")]
    Secret(#[from] SecretError),
}

/// The tunnel's error for people. Specific causes first: the host key, a
/// refused login, then the tunnel failing to open, which keeps its inner
/// cause (it used to swallow it, so a changed host key read as a timeout).
pub fn humanize_ssh_error(err: &SshError, bastion_host: &str) -> String {
    let msg = err.to_string();
    if msg.contains("has CHANGED") || msg.contains("Unknown SSH host key") {
        return msg;
    }
    if msg.starts_with("SSH: Permission denied") || msg.starts_with("SSH: The key file") {
        return msg;
    }
    if msg.starts_with("Could not open tunnel") {
        return msg;
    }
    if msg.contains("Connection refused") || msg.contains("timed out") {
        return format!("Could not open tunnel to {bastion_host}: {msg}");
    }
    format!("SSH: {msg}")
}

/// Why a key file didn't open: its passphrase first, as that's the usual cause.
/// A crypto error only means a wrong passphrase on a key that parses as an
/// encrypted OpenSSH key; a damaged or odd file raises the same error.
fn key_error(e: &russh::keys::Error, key_text: &str, had_passphrase: bool) -> String {
    use russh::keys::{ssh_key, Error};
    match e {
        Error::KeyIsEncrypted => {
            "SSH: The key file is encrypted, and no passphrase is saved for it.".into()
        }
        Error::SshKey(ssh_key::Error::Crypto)
            if had_passphrase
                && ssh_key::PrivateKey::from_openssh(key_text).is_ok_and(|k| k.is_encrypted()) =>
        {
            "SSH: The key file's passphrase is wrong.".into()
        }
        e => format!("Invalid SSH key: {e}"),
    }
}

/// What `check_server_key` found wrong, for the error after the handshake.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum KeyProblem {
    Unknown,
    Changed,
}

fn known_hosts_path() -> PathBuf {
    config_dir().join("ssh_known_hosts")
}

fn load_known_hosts() -> HashMap<String, String> {
    let path = known_hosts_path();
    if !path.exists() {
        return HashMap::new();
    }
    let text = fs::read_to_string(path).unwrap_or_default();
    let mut map = HashMap::new();
    for line in text.lines() {
        let line = line.trim();
        if line.is_empty() || line.starts_with('#') {
            continue;
        }
        let mut parts = line.split_whitespace();
        let host = parts.next().unwrap_or_default();
        let fingerprint = parts.next().unwrap_or_default();
        if !host.is_empty() && !fingerprint.is_empty() {
            map.insert(host.to_string(), fingerprint.to_string());
        }
    }
    map
}

fn persist_known_host(host: &str, fingerprint: &str) -> Result<(), SshError> {
    crate::config::create_private_dir(&config_dir())
        .map_err(|e| SshError::Message(e.to_string()))?;
    let mut map = load_known_hosts();
    map.insert(host.to_string(), fingerprint.to_string());
    let mut lines = Vec::new();
    for (h, fp) in map {
        lines.push(format!("{h} {fp}"));
    }
    crate::config::write_private(&known_hosts_path(), lines.join("\n"))
        .map_err(|e| SshError::Message(e.to_string()))?;
    Ok(())
}

/// SHA-256 of the key's SSH wire encoding, base64 with its padding: the
/// form `ssh_known_hosts` has always stored, so saved hosts still match.
fn host_key_fingerprint(key: &PublicKey) -> String {
    use russh::keys::ssh_encoding::Encode;
    use sha2::{Digest, Sha256};
    let bytes = key
        .key_data()
        .encode_vec()
        .expect("encoding a public key into a Vec can't fail");
    let digest = Sha256::digest(bytes);
    format!(
        "SHA256:{}",
        base64::Engine::encode(&base64::engine::general_purpose::STANDARD, digest)
    )
}

struct ClientHandler {
    host: String,
    trust_host: bool,
    known_hosts: HashMap<String, String>,
    problem: Arc<std::sync::Mutex<Option<KeyProblem>>>,
}

impl Handler for ClientHandler {
    type Error = russh::Error;

    async fn check_server_key(
        &mut self,
        server_key: &PublicKeyOrCertificate,
    ) -> Result<bool, Self::Error> {
        let note = |p| {
            if let Ok(mut slot) = self.problem.lock() {
                *slot = Some(p);
            }
        };
        // Host certificates are never asked for, so one arriving anyway is
        // refused as an unknown key.
        let PublicKeyOrCertificate::PublicKey { key, .. } = server_key else {
            note(KeyProblem::Unknown);
            return Err(russh::Error::UnknownKey);
        };
        let fingerprint = host_key_fingerprint(key);
        let host_key = self.host.clone();
        if let Some(expected) = self.known_hosts.get(&host_key) {
            if expected == &fingerprint {
                return Ok(true);
            }
            note(KeyProblem::Changed);
            return Err(russh::Error::UnknownKey);
        }
        if self.trust_host
            || std::env::var("ROWKERY_SSH_TRUST_HOSTS")
                .map(|v| v == "1")
                .unwrap_or(false)
        {
            persist_known_host(&host_key, &fingerprint).map_err(|_| russh::Error::UnknownKey)?;
            return Ok(true);
        }
        note(KeyProblem::Unknown);
        Err(russh::Error::UnknownKey)
    }
}

/// A local port forwarded over SSH to the database. Every connection to
/// `local_port` gets its own direct-tcpip channel on the one SSH connection,
/// so a window's sessions share a tunnel.
/// `get_secret` on the blocking pool: the keychain can block or prompt.
async fn secret_off_thread(
    connection_id: &str,
    kind: SecretKind,
) -> Result<Option<String>, SshError> {
    let id = connection_id.to_string();
    tokio::task::spawn_blocking(move || get_secret(&id, kind))
        .await
        .map_err(|e| SshError::Message(e.to_string()))?
        .map_err(SshError::from)
}

pub struct SshTunnel {
    pub local_port: u16,
    shutdown: Option<oneshot::Sender<()>>,
    task: JoinHandle<()>,
    /// Set once the SSH connection under it has gone.
    dead: Arc<std::sync::atomic::AtomicBool>,
}

/// Tunnels open now (tests count them).
pub static OPEN_TUNNELS: std::sync::atomic::AtomicUsize = std::sync::atomic::AtomicUsize::new(0);

/// How long connecting and authenticating may take before the tunnel gives up.
pub const SSH_OPEN_TIMEOUT: Duration = Duration::from_secs(15);
/// SSH keepalives: one every 15 s, and the connection is given up after
/// three unanswered.
const SSH_KEEPALIVE_INTERVAL: Duration = Duration::from_secs(15);
const SSH_KEEPALIVE_MAX: usize = 3;
/// Host key types asked for, in the order russh 0.46 asked for them, so a
/// bastion presents the same key it did and its saved fingerprint matches.
const HOST_KEYS: &[Algorithm] = &[
    Algorithm::Ed25519,
    Algorithm::Ecdsa {
        curve: EcdsaCurve::NistP256,
    },
    Algorithm::Ecdsa {
        curve: EcdsaCurve::NistP521,
    },
    Algorithm::Rsa {
        hash: Some(HashAlg::Sha256),
    },
    Algorithm::Rsa {
        hash: Some(HashAlg::Sha512),
    },
];

impl SshTunnel {
    /// True while the SSH connection still carries new channels.
    pub fn is_alive(&self) -> bool {
        !self.dead.load(std::sync::atomic::Ordering::Relaxed) && !self.task.is_finished()
    }

    /// `open`, giving up after [`SSH_OPEN_TIMEOUT`] (an unreachable bastion
    /// otherwise waits for the OS's TCP timeout).
    pub async fn open_with_timeout(
        ssh: &SshConfig,
        connection_id: &str,
        remote_host: &str,
        remote_port: u16,
        secrets: Option<&ConnectionSecrets>,
    ) -> Result<Self, SshError> {
        tokio::time::timeout(
            SSH_OPEN_TIMEOUT,
            Self::open(ssh, connection_id, remote_host, remote_port, secrets),
        )
        .await
        .map_err(|_| {
            SshError::Message(format!(
                "Could not open tunnel to {}: timed out after {} s",
                ssh.host,
                SSH_OPEN_TIMEOUT.as_secs()
            ))
        })?
    }

    pub async fn open(
        ssh: &SshConfig,
        connection_id: &str,
        remote_host: &str,
        remote_port: u16,
        // Secrets typed into an unsaved form win over the keychain.
        secrets: Option<&ConnectionSecrets>,
    ) -> Result<Self, SshError> {
        let config = Arc::new(Config {
            inactivity_timeout: Some(Duration::from_secs(3600)),
            // A tunnel whose server stopped answering (sleep, a network
            // change) closes within a minute, so queries through it fail
            // instead of waiting on it forever.
            keepalive_interval: Some(SSH_KEEPALIVE_INTERVAL),
            keepalive_max: SSH_KEEPALIVE_MAX,
            preferred: Preferred {
                key: HOST_KEYS.into(),
                ..Preferred::DEFAULT
            },
            ..Default::default()
        });
        let host_key = format!("{}:{}", ssh.host, ssh.port);
        let problem = Arc::new(std::sync::Mutex::new(None));
        let handler = ClientHandler {
            host: host_key.clone(),
            trust_host: ssh.trust_host,
            known_hosts: load_known_hosts(),
            problem: problem.clone(),
        };
        let addr = format!("{}:{}", ssh.host, ssh.port);
        let mut handle = client::connect(config, &addr, handler).await.map_err(|e| {
            let why = match problem.lock().ok().and_then(|p| *p) {
                Some(KeyProblem::Changed) => {
                    format!("SSH host key for {host_key} has CHANGED; nothing was sent")
                }
                Some(KeyProblem::Unknown) => format!("Unknown SSH host key for {host_key}"),
                None => e.to_string(),
            };
            SshError::Message(format!("Could not open tunnel to {}: {why}", ssh.host))
        })?;

        let auth_ok = match ssh.auth_method {
            SshAuthMethod::Password => {
                let supplied = secrets.and_then(|s| s.ssh_password.clone());
                let password = match supplied {
                    Some(p) => Some(p),
                    None => secret_off_thread(connection_id, SecretKind::SshPassword).await?,
                }
                .filter(|s| !s.is_empty())
                .ok_or_else(|| SshError::Message("SSH password not stored".into()))?;
                handle
                    .authenticate_password(&ssh.username, password)
                    .await
                    .map_err(|e| SshError::Message(e.to_string()))?
                    .success()
            }
            SshAuthMethod::KeyFile => {
                let path = ssh
                    .private_key_path
                    .as_ref()
                    .filter(|p| !p.is_empty())
                    .ok_or_else(|| SshError::Message("SSH private key path is required".into()))?;
                let key_text = fs::read_to_string(expand_home(path))
                    .map_err(|e| SshError::Message(format!("Could not read key file: {e}")))?;
                let passphrase = match secrets.and_then(|s| s.ssh_key_passphrase.clone()) {
                    Some(p) => Some(p),
                    None => secret_off_thread(connection_id, SecretKind::SshKeyPassphrase).await?,
                };
                let key = decode_secret_key(&key_text, passphrase.as_deref()).map_err(|e| {
                    SshError::Message(key_error(&e, &key_text, passphrase.is_some()))
                })?;
                // RSA keys sign with the best hash the server takes (SHA-2).
                let hash = handle
                    .best_supported_rsa_hash()
                    .await
                    .map_err(|e| SshError::Message(e.to_string()))?
                    .flatten();
                handle
                    .authenticate_publickey(
                        &ssh.username,
                        PrivateKeyWithHashAlg::new(Arc::new(key), hash),
                    )
                    .await
                    .map_err(|e| SshError::Message(e.to_string()))?
                    .success()
            }
        };
        if !auth_ok {
            // Named as ssh does: which way in the host refused.
            return Err(SshError::Message(match ssh.auth_method {
                SshAuthMethod::Password => "SSH: Permission denied (password)".into(),
                SshAuthMethod::KeyFile => "SSH: Permission denied (publickey)".into(),
            }));
        }

        let listener = TcpListener::bind(SocketAddr::from(([127, 0, 0, 1], 0)))
            .await
            .map_err(|e| SshError::Message(e.to_string()))?;
        let local_port = listener
            .local_addr()
            .map_err(|e| SshError::Message(e.to_string()))?
            .port();

        let (shutdown_tx, mut shutdown_rx) = oneshot::channel();
        let remote_host = remote_host.to_string();
        let dead = Arc::new(std::sync::atomic::AtomicBool::new(false));
        let gone = dead.clone();
        let task = tokio::spawn(async move {
            loop {
                tokio::select! {
                    _ = &mut shutdown_rx => break,
                    accept = listener.accept() => {
                        match accept {
                            Ok((tcp, _)) => {
                                match handle
                                    .channel_open_direct_tcpip(
                                        remote_host.clone(),
                                        remote_port as u32,
                                        "127.0.0.1",
                                        0,
                                    )
                                    .await
                                {
                                    // Each socket on its own task: sessions share the tunnel.
                                    Ok(channel) => {
                                        tokio::spawn(pipe_tcp_channel(tcp, channel));
                                    }
                                    Err(_) if handle.is_closed() => break,
                                    Err(_) => {}
                                }
                            }
                            Err(_) => break,
                        }
                    }
                }
            }
            gone.store(true, std::sync::atomic::Ordering::Relaxed);
        });

        OPEN_TUNNELS.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
        Ok(Self {
            local_port,
            shutdown: Some(shutdown_tx),
            task,
            dead,
        })
    }
}

async fn pipe_tcp_channel(tcp: TcpStream, mut channel: Channel<client::Msg>) -> Result<(), String> {
    let (mut tcp_rd, mut tcp_wr) = tcp.into_split();
    // Plain channel data. (`make_writer_ext(Some(n))` sends SSH *extended* data
    // of type n, like stderr, which sshd never forwards to the database: the
    // tunnel carried nothing.)
    let mut ch_wr = channel.make_writer();
    let mut ch_rd = channel.make_reader();

    let client_to_remote = async {
        let mut buf = [0u8; 8192];
        loop {
            let n = tcp_rd.read(&mut buf).await.map_err(|e| e.to_string())?;
            if n == 0 {
                break;
            }
            ch_wr
                .write_all(&buf[..n])
                .await
                .map_err(|e| e.to_string())?;
        }
        Ok(())
    };

    let remote_to_client = async {
        let mut buf = [0u8; 8192];
        loop {
            let n = ch_rd.read(&mut buf).await.map_err(|e| e.to_string())?;
            if n == 0 {
                break;
            }
            tcp_wr
                .write_all(&buf[..n])
                .await
                .map_err(|e| e.to_string())?;
        }
        Ok(())
    };

    tokio::try_join!(client_to_remote, remote_to_client).map(|_| ())
}

impl Drop for SshTunnel {
    fn drop(&mut self) {
        if let Some(tx) = self.shutdown.take() {
            let _ = tx.send(());
        }
        self.task.abort();
        OPEN_TUNNELS.fetch_sub(1, std::sync::atomic::Ordering::Relaxed);
    }
}

#[cfg(test)]
mod key_file_tests {
    use super::*;

    /// rowkery/reports#51: an encrypted key says what it needs.
    #[test]
    fn an_encrypted_key_asks_for_its_passphrase() {
        let mut rng = rand_core_010::UnwrapErr(getrandom::SysRng);
        let key = russh::keys::PrivateKey::random(&mut rng, Algorithm::Ed25519)
            .unwrap()
            .encrypt(&mut rng, "right horse")
            .unwrap()
            .to_openssh(russh::keys::ssh_key::LineEnding::LF)
            .unwrap();
        let opened = |p: Option<&str>| {
            decode_secret_key(&key, p)
                .map(|_| ())
                .map_err(|e| key_error(&e, &key, p.is_some()))
        };
        assert_eq!(
            opened(None),
            Err("SSH: The key file is encrypted, and no passphrase is saved for it.".into())
        );
        assert_eq!(
            opened(Some("wrong")),
            Err("SSH: The key file's passphrase is wrong.".into())
        );
        assert_eq!(opened(Some("right horse")), Ok(()));
        let err = SshError::Message(opened(None).unwrap_err());
        assert_eq!(
            humanize_ssh_error(&err, "bastion"),
            "SSH: The key file is encrypted, and no passphrase is saved for it."
        );
        let refused = SshError::Message("SSH: Permission denied (password)".into());
        assert_eq!(
            humanize_ssh_error(&refused, "bastion"),
            "SSH: Permission denied (password)"
        );
    }

    /// A crypto error on a key that isn't encrypted is a bad file, not a
    /// wrong passphrase, even with a stale passphrase saved.
    #[test]
    fn a_damaged_key_is_not_blamed_on_its_passphrase() {
        let mut rng = rand_core_010::UnwrapErr(getrandom::SysRng);
        let plain = russh::keys::PrivateKey::random(&mut rng, Algorithm::Ed25519)
            .unwrap()
            .to_openssh(russh::keys::ssh_key::LineEnding::LF)
            .unwrap();
        let crypto = russh::keys::Error::SshKey(russh::keys::ssh_key::Error::Crypto);
        assert!(key_error(&crypto, &plain, true).starts_with("Invalid SSH key: "));
        assert!(key_error(&crypto, "not a key", true).starts_with("Invalid SSH key: "));
    }

    /// A key file the app can't read says so, instead of reading as a
    /// refused login.
    #[test]
    fn an_unreadable_key_file_is_not_a_refused_login() {
        let err =
            SshError::Message("Could not read key file: Permission denied (os error 13)".into());
        let msg = humanize_ssh_error(&err, "bastion");
        assert_eq!(
            msg,
            "SSH: Could not read key file: Permission denied (os error 13)"
        );
        let target = crate::explain::Target {
            host: "db",
            port: 5432,
            username: "app",
            ssh_host: Some("bastion"),
            cloud_sql: None,
        };
        assert_ne!(
            crate::explain::explain_connect_error(&msg, &target).class,
            "ssh_auth"
        );
    }
}
