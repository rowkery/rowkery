//! One dialer per connection: it keeps the instance's address and a client
//! certificate and hands each session a fresh TLS stream to the instance.
//! A dial that finds the certificate near expiry renews it, in the
//! background while the old one still works, so no dial (a cancel request
//! least of all) waits on the Admin API for a certificate it doesn't need.
//! A dial that fails with a cached address and certificate fetches both
//! again and tries once more. Sessions already open don't need the
//! certificate again.

use std::collections::HashMap;
use std::sync::{Arc, Mutex, OnceLock, Weak};
use std::time::{Duration, Instant, SystemTime};

use rustls::pki_types::ServerName;
use rustls::ClientConfig;
use tokio::net::TcpStream;
use tokio_rustls::TlsConnector;

use crate::connections::{CloudSqlConfig, CloudSqlCredentials, CloudSqlIpType};

use super::auth::{Credentials, Login};
use super::{admin, endpoints, tls, CloudSqlError, InstanceName};

/// A session's stream to the instance: Postgres runs inside it with SSL off.
pub type CloudSqlStream = tokio_rustls::client::TlsStream<TcpStream>;

/// A certificate this close to expiry is renewed.
const CERT_MARGIN: Duration = Duration::from_secs(4 * 60);
/// A certificate with more than this left still serves a dial while it's
/// being renewed.
const CERT_USABLE: Duration = Duration::from_secs(30);
/// How long reaching the instance (TCP and TLS) may take.
const DIAL_TIMEOUT: Duration = Duration::from_secs(10);
/// How long a whole dial may take: a renewal's Admin API calls, then TCP and
/// TLS, and the one retry.
const DIAL_DEADLINE: Duration = Duration::from_secs(30);

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
    /// The address and TLS setup dials use.
    ready: Mutex<Option<Arc<Ready>>>,
    /// Held while one renewal talks to the Admin API, so the others wait for
    /// it instead of asking for certificates of their own.
    renewing: tokio::sync::Mutex<()>,
    /// The last renewal that failed, and when: the answer for the dials that
    /// were waiting on it.
    failed: Mutex<Option<(Instant, CloudSqlError)>>,
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
            ready: Mutex::new(None),
            renewing: tokio::sync::Mutex::new(()),
            failed: Mutex::new(None),
        }
    }

    pub fn instance(&self) -> &InstanceName {
        &self.instance
    }

    /// The setup in use, when its certificate has more than `margin` left.
    fn cached(&self, margin: Duration) -> Option<Arc<Ready>> {
        let slot = self.ready.lock().unwrap_or_else(|e| e.into_inner());
        slot.as_ref()
            .filter(|r| SystemTime::now() + margin < r.expires)
            .cloned()
    }

    /// Drops the cached setup when it is still `r`, so the next dial fetches
    /// the address and a certificate again.
    fn forget(&self, r: &Arc<Ready>) {
        let mut slot = self.ready.lock().unwrap_or_else(|e| e.into_inner());
        if slot.as_ref().is_some_and(|s| Arc::ptr_eq(s, r)) {
            *slot = None;
        }
    }

    /// Drops the cached setup: the instance refused a session made with it
    /// (its certificate, after the TLS handshake).
    pub fn forget_certificate(&self) {
        *self.ready.lock().unwrap_or_else(|e| e.into_inner()) = None;
    }

    /// The setup for a dial, and whether it was fetched for this one.
    async fn ready(self: &Arc<Self>) -> Result<(Arc<Ready>, bool), CloudSqlError> {
        let asked = Instant::now();
        if let Some(r) = self.cached(CERT_MARGIN) {
            return Ok((r, false));
        }
        if let Some(r) = self.cached(CERT_USABLE) {
            // Near expiry but still good: renew it behind this dial, once.
            if self.renewing.try_lock().is_ok() {
                let me = self.clone();
                tokio::spawn(async move {
                    let _renewing = me.renewing.lock().await;
                    if me.cached(CERT_MARGIN).is_none() {
                        let _ = me.renew().await;
                    }
                });
            }
            return Ok((r, false));
        }
        let _renewing = self.renewing.lock().await;
        // Another dial may have renewed it while this one waited, or failed
        // to: that failure is this dial's answer too, not another try.
        if let Some(r) = self.cached(CERT_MARGIN) {
            return Ok((r, false));
        }
        if let Some((at, e)) = &*self.failed.lock().unwrap_or_else(|e| e.into_inner()) {
            if *at >= asked {
                return Err(e.clone());
            }
        }
        Ok((self.renew().await?, true))
    }

    /// Asks the Admin API for the address and a new certificate.
    async fn renew(&self) -> Result<Arc<Ready>, CloudSqlError> {
        let renewed = self.fetch().await;
        if let Err(e) = &renewed {
            *self.failed.lock().unwrap_or_else(|e| e.into_inner()) =
                Some((Instant::now(), e.clone()));
        }
        renewed
    }

    async fn fetch(&self) -> Result<Arc<Ready>, CloudSqlError> {
        // The address and the certificate are asked for at once (the key,
        // made once per run, goes into the certificate request).
        let cert = async {
            let key = tls::client_key().await?;
            let cert = admin::ephemeral_cert(&self.login, &self.instance, &key.public_pem).await?;
            Ok::<_, CloudSqlError>((key, cert))
        };
        let ((key, (cert, expires)), target) = tokio::try_join!(
            cert,
            admin::connect_target(&self.login, &self.instance, self.ip_type)
        )?;
        let server_name = target
            .dns_names
            .first()
            .and_then(|n| ServerName::try_from(n.clone()).ok())
            .or_else(|| ServerName::try_from(target.host.clone()).ok())
            .ok_or_else(|| {
                CloudSqlError::Instance(format!("Bad address for the instance: {}", target.host))
            })?;
        let config = tls::client_config(&key, &cert, &target.ca_pem, target.dns_names)?;
        let r = Arc::new(Ready {
            host: target.host,
            server_name,
            tls: Arc::new(config),
            expires,
        });
        *self.ready.lock().unwrap_or_else(|e| e.into_inner()) = Some(r.clone());
        Ok(r)
    }

    /// A TLS stream to the instance for one session (or one cancel request).
    pub async fn dial(self: &Arc<Self>) -> Result<CloudSqlStream, CloudSqlError> {
        tokio::time::timeout(DIAL_DEADLINE, self.dial_once())
            .await
            .unwrap_or_else(|_| {
                Err(CloudSqlError::Network(format!(
                    "{} couldn't be reached in {} s",
                    self.instance.name,
                    DIAL_DEADLINE.as_secs()
                )))
            })
    }

    async fn dial_once(self: &Arc<Self>) -> Result<CloudSqlStream, CloudSqlError> {
        let (r, fresh) = self.ready().await?;
        match self.dial_with(&r).await {
            Err(_) if !fresh => {
                // The address moved, the CA rotated or the certificate was
                // refused: fetch both again and try once more. (Just-fetched
                // ones would only fail the same way.)
                self.forget(&r);
                let (r, _) = self.ready().await?;
                self.dial_with(&r)
                    .await
                    .map_err(|e| e.into_error(self, &r.host))
            }
            other => other.map_err(|e| e.into_error(self, &r.host)),
        }
    }

    async fn dial_with(&self, r: &Ready) -> Result<CloudSqlStream, Dial> {
        let tcp = tokio::time::timeout(
            DIAL_TIMEOUT,
            TcpStream::connect((r.host.as_str(), endpoints().server_port)),
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
        let connector = TlsConnector::from(r.tls.clone());
        tokio::time::timeout(DIAL_TIMEOUT, connector.connect(r.server_name.clone(), tcp))
            .await
            .map_err(|_| Dial::Timeout)?
            .map_err(Dial::Tls)
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
            Login::Key(Arc::new(Credentials::parse_key(json)?))
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

    /// A dialer holding a certificate with `left` to go.
    fn holding(left: Duration) -> (Arc<CloudSqlDialer>, Arc<Ready>) {
        let tls =
            ClientConfig::builder_with_provider(Arc::new(rustls::crypto::ring::default_provider()))
                .with_safe_default_protocol_versions()
                .unwrap()
                .with_root_certificates(rustls::RootCertStore::empty())
                .with_no_client_auth();
        let r = Arc::new(Ready {
            host: "127.0.0.1".into(),
            server_name: ServerName::try_from("db.example").unwrap(),
            tls: Arc::new(tls),
            expires: SystemTime::now() + left,
        });
        let d = Arc::new(CloudSqlDialer::new(
            InstanceName::parse("p:r:i").unwrap(),
            CloudSqlIpType::Public,
            Login::Gcloud,
        ));
        *d.ready.lock().unwrap() = Some(r.clone());
        (d, r)
    }

    #[tokio::test]
    async fn a_renewal_doesnt_hold_up_a_dial_whose_certificate_still_works() {
        // Near expiry, while another dial renews: the old one serves at once.
        let (d, r) = holding(Duration::from_secs(60));
        let renewing = d.renewing.lock().await;
        let (got, fresh) = tokio::time::timeout(Duration::from_millis(200), d.ready())
            .await
            .expect("waited on the renewal")
            .unwrap();
        assert!(Arc::ptr_eq(&got, &r) && !fresh);

        // Nearly gone: it waits for the renewal rather than fail mid-handshake.
        let (d, _) = holding(Duration::from_secs(10));
        let _renewing = d.renewing.lock().await;
        assert!(tokio::time::timeout(Duration::from_millis(200), d.ready())
            .await
            .is_err());
        drop(renewing);
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
