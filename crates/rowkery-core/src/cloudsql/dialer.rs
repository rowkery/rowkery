//! One dialer per connection: it keeps the instance's address and a client
//! certificate (renewed when a dial finds it near expiry) and hands each
//! session a fresh TLS stream to the instance. Sessions already open don't
//! need the certificate again, so nothing runs in the background.

use std::collections::HashMap;
use std::sync::{Arc, Mutex, OnceLock, Weak};
use std::time::{Duration, SystemTime};

use rustls::pki_types::ServerName;
use rustls::ClientConfig;
use tokio::net::TcpStream;
use tokio_rustls::TlsConnector;

use crate::connections::{CloudSqlConfig, CloudSqlCredentials, CloudSqlIpType};

use super::auth::{Credentials, Login};
use super::{admin, endpoints, tls, CloudSqlError, InstanceName};

/// A session's stream to the instance: Postgres runs inside it with SSL off.
pub type CloudSqlStream = tokio_rustls::client::TlsStream<TcpStream>;

/// A certificate this close to expiry is renewed before a dial.
const CERT_MARGIN: Duration = Duration::from_secs(4 * 60);
/// How long reaching the instance (TCP and TLS) may take.
const DIAL_TIMEOUT: Duration = Duration::from_secs(10);

struct Ready {
    host: String,
    server_name: ServerName<'static>,
    tls: Arc<ClientConfig>,
    expires: SystemTime,
}

pub struct CloudSqlDialer {
    instance: InstanceName,
    ip_type: CloudSqlIpType,
    login: Login,
    ready: tokio::sync::Mutex<Option<Ready>>,
}

impl std::fmt::Debug for CloudSqlDialer {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "CloudSqlDialer({})", self.instance)
    }
}

impl CloudSqlDialer {
    fn new(instance: InstanceName, ip_type: CloudSqlIpType, login: Login) -> Self {
        Self {
            instance,
            ip_type,
            login,
            ready: tokio::sync::Mutex::new(None),
        }
    }

    pub fn instance(&self) -> &InstanceName {
        &self.instance
    }

    /// The address and TLS setup, fetched again when the certificate is
    /// near expiry (or a dial with it failed).
    async fn ready(
        &self,
    ) -> Result<(String, ServerName<'static>, Arc<ClientConfig>), CloudSqlError> {
        let mut slot = self.ready.lock().await;
        if let Some(r) = slot.as_ref() {
            if SystemTime::now() + CERT_MARGIN < r.expires {
                return Ok((r.host.clone(), r.server_name.clone(), r.tls.clone()));
            }
        }
        // The key is made while the Admin API answers.
        let (key, target) = tokio::try_join!(
            tls::client_key(),
            admin::connect_target(&self.login, &self.instance, self.ip_type)
        )?;
        let (cert, expires) =
            admin::ephemeral_cert(&self.login, &self.instance, &key.public_pem).await?;
        let server_name = target
            .dns_names
            .first()
            .and_then(|n| ServerName::try_from(n.clone()).ok())
            .or_else(|| ServerName::try_from(target.host.clone()).ok())
            .ok_or_else(|| {
                CloudSqlError::Instance(format!("Bad address for the instance: {}", target.host))
            })?;
        let config = tls::client_config(&key, &cert, &target.ca_pem, target.dns_names)?;
        let r = Ready {
            host: target.host,
            server_name,
            tls: Arc::new(config),
            expires,
        };
        let out = (r.host.clone(), r.server_name.clone(), r.tls.clone());
        *slot = Some(r);
        Ok(out)
    }

    /// A TLS stream to the instance for one session (or one cancel request).
    pub async fn dial(&self) -> Result<CloudSqlStream, CloudSqlError> {
        let (host, name, config) = self.ready().await?;
        match self.dial_with(&host, name, config).await {
            Err(Dial::Tls(_)) => {
                // The instance's CA rotated, or the certificate was refused:
                // fetch both again and try once more.
                *self.ready.lock().await = None;
                let (host, name, config) = self.ready().await?;
                self.dial_with(&host, name, config)
                    .await
                    .map_err(|e| e.into_error(self, &host))
            }
            other => other.map_err(|e| e.into_error(self, &host)),
        }
    }

    async fn dial_with(
        &self,
        host: &str,
        name: ServerName<'static>,
        config: Arc<ClientConfig>,
    ) -> Result<CloudSqlStream, Dial> {
        let tcp = tokio::time::timeout(
            DIAL_TIMEOUT,
            TcpStream::connect((host, endpoints().server_port)),
        )
        .await
        .map_err(|_| Dial::Timeout)?
        .map_err(Dial::Tcp)?;
        let _ = tcp.set_nodelay(true);
        // Sessions stay open between queries: notice a dead peer (sleep, NAT
        // timeout) well before the OS default of two hours.
        let keepalive = socket2::TcpKeepalive::new()
            .with_time(Duration::from_secs(30))
            .with_interval(Duration::from_secs(10));
        let _ = socket2::SockRef::from(&tcp).set_tcp_keepalive(&keepalive);
        tokio::time::timeout(DIAL_TIMEOUT, TlsConnector::from(config).connect(name, tcp))
            .await
            .map_err(|_| Dial::Timeout)?
            .map_err(Dial::Tls)
    }

    /// Whether this dialer is what `config` asks for (a changed key file is
    /// caught by [`dialer_for`], which reads it).
    pub fn serves(&self, config: &CloudSqlConfig) -> bool {
        let login_matches = matches!(
            (&self.login, config.credentials),
            (Login::Gcloud, CloudSqlCredentials::Gcloud)
                | (Login::Key(_), CloudSqlCredentials::Key)
        );
        login_matches
            && self.ip_type == config.ip_type
            && InstanceName::parse(&config.instance).is_some_and(|n| n == self.instance)
    }

    fn matches(&self, instance: &InstanceName, ip_type: CloudSqlIpType, login: &Login) -> bool {
        self.instance == *instance
            && self.ip_type == ip_type
            && self.login.fingerprint() == login.fingerprint()
    }
}

enum Dial {
    Timeout,
    Tcp(std::io::Error),
    Tls(std::io::Error),
}

impl Dial {
    fn into_error(self, d: &CloudSqlDialer, host: &str) -> CloudSqlError {
        let at = format!("{} at {host}:{}", d.instance.name, endpoints().server_port);
        CloudSqlError::Network(match self {
            Dial::Timeout => format!("{at} did not answer in {} s", DIAL_TIMEOUT.as_secs()),
            Dial::Tcp(e) => format!("couldn't reach {at}: {e}"),
            Dial::Tls(e) => format!("the secure connection to {at} failed: {e}"),
        })
    }
}

/// Dialers by connection id, shared by every session of the connection
/// (each window's, prefetch's, the MCP server's) while any is open.
fn registry() -> &'static Mutex<HashMap<String, Weak<CloudSqlDialer>>> {
    static R: OnceLock<Mutex<HashMap<String, Weak<CloudSqlDialer>>>> = OnceLock::new();
    R.get_or_init(Default::default)
}

/// The connection's dialer: the live one when its settings still match,
/// else a new one. `key_json` is the service account key when the
/// connection signs in with one.
pub fn dialer_for(
    connection_id: &str,
    config: &CloudSqlConfig,
    key_json: Option<&str>,
) -> Result<Arc<CloudSqlDialer>, CloudSqlError> {
    let instance = InstanceName::parse(&config.instance).ok_or_else(|| {
        CloudSqlError::Instance(format!(
            "\"{}\" isn't an instance connection name (project:region:instance)",
            config.instance
        ))
    })?;
    let login = match config.credentials {
        CloudSqlCredentials::Gcloud => Login::Gcloud,
        CloudSqlCredentials::Key => {
            let json = key_json.map(str::trim).filter(|k| !k.is_empty()).ok_or_else(|| {
                CloudSqlError::Login(
                    "No service account key is saved for this connection. Add it under Google account".into(),
                )
            })?;
            Login::Key(Arc::new(Credentials::parse(json)?))
        }
    };
    let mut reg = registry().lock().unwrap_or_else(|e| e.into_inner());
    reg.retain(|_, d| d.strong_count() > 0);
    if let Some(live) = reg.get(connection_id).and_then(Weak::upgrade) {
        if live.matches(&instance, config.ip_type, &login) {
            return Ok(live);
        }
    }
    let fresh = Arc::new(CloudSqlDialer::new(instance, config.ip_type, login));
    reg.insert(connection_id.to_string(), Arc::downgrade(&fresh));
    Ok(fresh)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn cfg(instance: &str, ip_type: CloudSqlIpType) -> CloudSqlConfig {
        CloudSqlConfig {
            instance: instance.into(),
            ip_type,
            credentials: CloudSqlCredentials::Gcloud,
        }
    }

    #[test]
    fn a_connection_shares_its_dialer_until_its_settings_change() {
        let a = dialer_for("reg-1", &cfg("p:r:i", CloudSqlIpType::Public), None).unwrap();
        let b = dialer_for("reg-1", &cfg("p:r:i", CloudSqlIpType::Public), None).unwrap();
        assert!(Arc::ptr_eq(&a, &b));
        let c = dialer_for("reg-1", &cfg("p:r:i", CloudSqlIpType::Private), None).unwrap();
        assert!(!Arc::ptr_eq(&a, &c));
        let other = dialer_for("reg-2", &cfg("p:r:i", CloudSqlIpType::Public), None).unwrap();
        assert!(!Arc::ptr_eq(&a, &other));
        drop((a, b, c));
        // Once no session holds it, a dialer is gone (and its certificate).
        let d = dialer_for("reg-1", &cfg("p:r:i", CloudSqlIpType::Private), None).unwrap();
        assert_eq!(Arc::strong_count(&d), 1);
    }

    #[test]
    fn a_dialer_serves_only_its_own_settings() {
        let c = cfg("p:r:i", CloudSqlIpType::Public);
        let d = dialer_for("reg-4", &c, None).unwrap();
        assert!(d.serves(&c));
        assert!(!d.serves(&cfg("p:r:other", CloudSqlIpType::Public)));
        assert!(!d.serves(&cfg("p:r:i", CloudSqlIpType::Psc)));
        let mut key = c.clone();
        key.credentials = CloudSqlCredentials::Key;
        assert!(!d.serves(&key));
    }

    #[test]
    fn a_key_login_needs_its_key() {
        let mut c = cfg("p:r:i", CloudSqlIpType::Public);
        c.credentials = CloudSqlCredentials::Key;
        let err = dialer_for("reg-3", &c, None).unwrap_err();
        assert!(matches!(err, CloudSqlError::Login(_)));
        assert!(dialer_for("reg-3", &cfg("bad", CloudSqlIpType::Public), None).is_err());
    }
}
