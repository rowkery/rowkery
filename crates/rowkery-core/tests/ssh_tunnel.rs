//! The SSH tunnel against an in-process russh server: host keys are refused
//! until trusted, trusted ones are saved and checked, a changed one is
//! refused, password and key-file logins work, and bytes reach the database
//! port through the tunnel.

use std::sync::Arc;

use russh::keys::ssh_key::private::Ed25519Keypair;
use russh::keys::ssh_key::LineEnding;
use russh::keys::{HashAlg, PrivateKey, PublicKey};
use russh::server::{self, Auth, Msg, Session};
use russh::Channel;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};

use rowkery_core::connections::{SshAuthMethod, SshConfig};
use rowkery_core::secrets::ConnectionSecrets;
use rowkery_core::ssh::SshTunnel;

const USER: &str = "tunnel";
const PASSWORD: &str = "open sesame";

fn key(seed: u8) -> PrivateKey {
    PrivateKey::from(Ed25519Keypair::from_seed(&[seed; 32]))
}

#[derive(Clone)]
struct Bastion {
    client_key: PublicKey,
}

impl server::Handler for Bastion {
    type Error = russh::Error;

    async fn auth_password(&mut self, user: &str, password: &str) -> Result<Auth, Self::Error> {
        Ok(if user == USER && password == PASSWORD {
            Auth::Accept
        } else {
            Auth::reject()
        })
    }

    async fn auth_publickey(&mut self, user: &str, key: &PublicKey) -> Result<Auth, Self::Error> {
        Ok(
            if user == USER && key.key_data() == self.client_key.key_data() {
                Auth::Accept
            } else {
                Auth::reject()
            },
        )
    }

    async fn channel_open_direct_tcpip(
        &mut self,
        channel: Channel<Msg>,
        host: &str,
        port: u32,
        _originator: &str,
        _originator_port: u32,
        reply: server::ChannelOpenHandle,
        _session: &mut Session,
    ) -> Result<(), Self::Error> {
        let target = format!("{host}:{port}");
        reply.accept().await;
        tokio::spawn(async move {
            let Ok(mut tcp) = TcpStream::connect(target).await else {
                return;
            };
            let mut stream = channel.into_stream();
            let _ = tokio::io::copy_bidirectional(&mut tcp, &mut stream).await;
        });
        Ok(())
    }
}

/// A russh server on a free port with host key `host_seed`.
async fn bastion(host_seed: u8, client_key: PublicKey) -> u16 {
    let config = Arc::new(server::Config {
        keys: vec![key(host_seed)],
        auth_rejection_time: std::time::Duration::from_millis(10),
        ..Default::default()
    });
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = listener.local_addr().unwrap().port();
    tokio::spawn(async move {
        loop {
            let Ok((socket, _)) = listener.accept().await else {
                return;
            };
            let handler = Bastion {
                client_key: client_key.clone(),
            };
            let config = config.clone();
            tokio::spawn(async move {
                if let Ok(session) = server::run_stream(config, socket, handler).await {
                    let _ = session.await;
                }
            });
        }
    });
    port
}

/// The "database": echoes every byte back.
async fn echo() -> u16 {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = listener.local_addr().unwrap().port();
    tokio::spawn(async move {
        while let Ok((mut socket, _)) = listener.accept().await {
            tokio::spawn(async move {
                let (mut r, mut w) = socket.split();
                let _ = tokio::io::copy(&mut r, &mut w).await;
            });
        }
    });
    port
}

fn ssh(port: u16, auth_method: SshAuthMethod, key_path: Option<String>, trust: bool) -> SshConfig {
    SshConfig {
        host: "127.0.0.1".into(),
        port,
        username: USER.into(),
        auth_method,
        private_key_path: key_path,
        trust_host: trust,
    }
}

fn password(p: &str) -> ConnectionSecrets {
    ConnectionSecrets {
        ssh_password: Some(p.into()),
        ..Default::default()
    }
}

async fn open(
    config: &SshConfig,
    secrets: &ConnectionSecrets,
    db: u16,
) -> Result<SshTunnel, String> {
    SshTunnel::open_with_timeout(config, "ssh-test", "127.0.0.1", db, Some(secrets))
        .await
        .map_err(|e| e.to_string())
}

async fn round_trip(tunnel: &SshTunnel) {
    let mut tcp = TcpStream::connect(("127.0.0.1", tunnel.local_port))
        .await
        .unwrap();
    tcp.write_all(b"SELECT 1").await.unwrap();
    let mut back = [0u8; 8];
    tcp.read_exact(&mut back).await.unwrap();
    assert_eq!(&back, b"SELECT 1");
}

#[tokio::test]
async fn tunnel_checks_host_keys_and_carries_bytes() {
    let dir = tempfile::tempdir().unwrap();
    // The only test in this binary, so the variable can't race another.
    std::env::set_var("ROWKERY_CONFIG_DIR", dir.path());
    std::env::remove_var("ROWKERY_SSH_TRUST_HOSTS");

    let client = key(9);
    let db = echo().await;
    let port = bastion(1, client.public_key().clone()).await;

    // An unknown host key is refused unless the user trusts it.
    let err = open(
        &ssh(port, SshAuthMethod::Password, None, false),
        &password(PASSWORD),
        db,
    )
    .await
    .err()
    .expect("an unknown host key must be refused");
    assert!(err.contains("Unknown SSH host key"), "{err}");

    // Trusted: saved in the form ssh_known_hosts has always used (padded).
    let tunnel = open(
        &ssh(port, SshAuthMethod::Password, None, true),
        &password(PASSWORD),
        db,
    )
    .await
    .unwrap();
    round_trip(&tunnel).await;
    drop(tunnel);
    let saved = std::fs::read_to_string(dir.path().join("ssh_known_hosts")).unwrap();
    let fingerprint = format!("{}=", key(1).public_key().fingerprint(HashAlg::Sha256));
    assert_eq!(saved.trim(), format!("127.0.0.1:{port} {fingerprint}"));

    // Saved: opens without trusting again.
    let tunnel = open(
        &ssh(port, SshAuthMethod::Password, None, false),
        &password(PASSWORD),
        db,
    )
    .await
    .unwrap();
    round_trip(&tunnel).await;
    drop(tunnel);

    // A wrong password is refused.
    let err = open(
        &ssh(port, SshAuthMethod::Password, None, false),
        &password("nope"),
        db,
    )
    .await
    .err()
    .expect("a wrong password must be refused");
    assert!(err.contains("Permission denied"), "{err}");

    // A key file logs in.
    let key_file = dir.path().join("id_ed25519");
    std::fs::write(
        &key_file,
        client.to_openssh(LineEnding::LF).unwrap().as_bytes(),
    )
    .unwrap();
    let with_key = ssh(
        port,
        SshAuthMethod::KeyFile,
        Some(key_file.to_string_lossy().into_owned()),
        false,
    );
    let tunnel = open(&with_key, &ConnectionSecrets::default(), db)
        .await
        .unwrap();
    round_trip(&tunnel).await;
    drop(tunnel);

    // Another server answering at a saved address is refused, even trusted.
    let other = bastion(2, client.public_key().clone()).await;
    std::fs::write(
        dir.path().join("ssh_known_hosts"),
        format!("127.0.0.1:{other} {fingerprint}"),
    )
    .unwrap();
    let err = open(
        &ssh(other, SshAuthMethod::Password, None, true),
        &password(PASSWORD),
        db,
    )
    .await
    .err()
    .expect("a changed host key must be refused");
    assert!(err.contains("CHANGED"), "{err}");
}
