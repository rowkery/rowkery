//! The Cloud SQL connector against a fake Google: an Admin API on a local
//! HTTP port, and an "instance" that, like Cloud SQL's server-side proxy,
//! takes TLS only from a client certificate the API issued.

use std::collections::HashMap;
use std::net::SocketAddr;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};

use rcgen::{
    BasicConstraints, CertificateParams, CertifiedIssuer, DnType, IsCa, KeyPair, KeyUsagePurpose,
    SubjectPublicKeyInfo,
};
use rowkery_core::cloudsql::{self, CloudSqlError};
use rowkery_core::connections::{CloudSqlConfig, CloudSqlCredentials, CloudSqlIpType};
use rustls::pki_types::{CertificateDer, PrivateKeyDer, PrivatePkcs8KeyDer};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};

const SERVER_DNS: &str = "orders.asia-southeast1.sql.goog";

fn ca(name: &str) -> CertifiedIssuer<'static, KeyPair> {
    let mut p = CertificateParams::new(Vec::<String>::new()).unwrap();
    p.distinguished_name.push(DnType::CommonName, name);
    p.is_ca = IsCa::Ca(BasicConstraints::Unconstrained);
    p.key_usages = vec![KeyUsagePurpose::KeyCertSign, KeyUsagePurpose::CrlSign];
    CertifiedIssuer::self_signed(p, KeyPair::generate().unwrap()).unwrap()
}

/// What the fake Admin API says about each instance.
#[derive(Clone)]
struct Instance {
    ca_pem: String,
    /// Google's shared CA: the certificate must carry one of these names.
    dns_names: Option<Vec<String>>,
    version: &'static str,
}

struct Google {
    server_ca: CertifiedIssuer<'static, KeyPair>,
    client_ca: CertifiedIssuer<'static, KeyPair>,
    instances: Mutex<HashMap<String, Instance>>,
    certs_issued: AtomicUsize,
    /// Admin API calls about the instance this account may not see.
    denied_calls: AtomicUsize,
    /// `connectSettings` calls for `moving`, which answers with an address
    /// nothing listens on the first time.
    moving_calls: AtomicUsize,
    /// `x-goog-user-project` on the last Admin API call.
    quota_project: Mutex<Option<String>>,
}

fn json(status: u16, body: serde_json::Value) -> (u16, String) {
    (status, body.to_string())
}

impl Google {
    fn route(&self, method: &str, path: &str, headers: &str, body: &str) -> (u16, String) {
        let (path, query) = path.split_once('?').unwrap_or((path, ""));
        if path == "/token" {
            assert!(body.contains("grant_type=refresh_token"), "{body}");
            return json(
                200,
                serde_json::json!({ "access_token": "tok-1", "expires_in": 3600 }),
            );
        }
        if path == "/tokeninfo" {
            // The token goes in the body, never the URL (proxies log URLs).
            assert_eq!((method, query), ("POST", ""));
            assert!(body.contains("access_token=tok-1"), "{body}");
            return json(200, serde_json::json!({ "email": "dev@example.com" }));
        }
        assert!(
            headers
                .to_ascii_lowercase()
                .contains("authorization: bearer tok-1"),
            "{headers}"
        );
        *self.quota_project.lock().unwrap() = headers
            .lines()
            .find_map(|l| l.strip_prefix("x-goog-user-project: "))
            .map(str::to_string);
        if path == "/v1/projects" {
            return json(
                200,
                serde_json::json!({ "projects": [{ "projectId": "acme" }, { "projectId": "locked" }] }),
            );
        }
        if path == "/sql/v1beta4/projects/locked/instances" {
            return json(
                403,
                serde_json::json!({ "error": { "code": 403, "message": "Not allowed" } }),
            );
        }
        if path == "/sql/v1beta4/projects/acme/instances" {
            return json(
                200,
                serde_json::json!({ "items": [
                    { "name": "orders", "region": "asia-southeast1", "databaseVersion": "POSTGRES_16", "state": "RUNNABLE", "settings": { "activationPolicy": "ALWAYS" } },
                    { "name": "crm", "region": "us-central1", "databaseVersion": "MYSQL_8_0", "state": "RUNNABLE", "settings": { "activationPolicy": "NEVER" } }
                ] }),
            );
        }
        let Some(rest) = path.strip_prefix("/sql/v1beta4/projects/acme/instances/") else {
            return json(
                404,
                serde_json::json!({ "error": { "message": "no route" } }),
            );
        };
        let (name, action) = rest
            .split_once('/')
            .or_else(|| rest.split_once(':'))
            .unwrap_or((rest, ""));
        if name == "denied" {
            self.denied_calls.fetch_add(1, Ordering::SeqCst);
        }
        let Some(inst) = self.instances.lock().unwrap().get(name).cloned() else {
            return json(
                if name == "denied" { 403 } else { 404 },
                serde_json::json!({ "error": { "code": 403, "message": "The client is not authorized to make this request." } }),
            );
        };
        match (method, action) {
            ("GET", "connectSettings") => {
                let moved_away =
                    name == "moving" && self.moving_calls.fetch_add(1, Ordering::SeqCst) == 0;
                let ip = if moved_away { "127.0.0.2" } else { "127.0.0.1" };
                let mut s = serde_json::json!({
                    "serverCaCert": { "cert": inst.ca_pem },
                    "ipAddresses": [{ "type": "PRIMARY", "ipAddress": ip }],
                    "region": "asia-southeast1",
                    "databaseVersion": inst.version,
                    "backendType": "SECOND_GEN",
                    "serverCaMode": "GOOGLE_MANAGED_INTERNAL_CA",
                });
                if let Some(names) = inst.dns_names {
                    s["serverCaMode"] = "GOOGLE_MANAGED_CAS_CA".into();
                    s["dnsNames"] = names
                        .iter()
                        .map(|n| serde_json::json!({ "name": format!("{n}."), "connectionType": "PUBLIC" }))
                        .collect();
                }
                json(200, s)
            }
            ("POST", "generateEphemeralCert") => {
                let req: serde_json::Value = serde_json::from_str(body).unwrap();
                let pem = req["public_key"].as_str().unwrap();
                assert!(pem.starts_with("-----BEGIN RSA PUBLIC KEY-----"));
                let b64: String = pem.lines().filter(|l| !l.starts_with("-----")).collect();
                use base64::Engine;
                let der = base64::engine::general_purpose::STANDARD
                    .decode(b64)
                    .unwrap();
                let spki = SubjectPublicKeyInfo::from_der(&der).unwrap();
                let mut p = CertificateParams::new(Vec::<String>::new()).unwrap();
                p.distinguished_name.push(DnType::CommonName, "client");
                let cert = p.signed_by(&spki, &self.client_ca).unwrap();
                self.certs_issued.fetch_add(1, Ordering::SeqCst);
                json(
                    200,
                    serde_json::json!({ "ephemeralCert": { "cert": cert.pem(), "expirationTime": "2099-01-01T00:00:00.000Z" } }),
                )
            }
            _ => json(
                404,
                serde_json::json!({ "error": { "message": "no route" } }),
            ),
        }
    }
}

async fn serve_http(google: Arc<Google>) -> SocketAddr {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    tokio::spawn(async move {
        loop {
            let (mut sock, _) = listener.accept().await.unwrap();
            let google = google.clone();
            tokio::spawn(async move {
                let mut buf = Vec::new();
                let mut chunk = [0u8; 4096];
                let (head_end, length) = loop {
                    let n = sock.read(&mut chunk).await.unwrap();
                    if n == 0 {
                        return;
                    }
                    buf.extend_from_slice(&chunk[..n]);
                    if let Some(i) = buf.windows(4).position(|w| w == b"\r\n\r\n") {
                        let head = String::from_utf8_lossy(&buf[..i]).to_ascii_lowercase();
                        let length = head
                            .lines()
                            .find_map(|l| l.strip_prefix("content-length: "))
                            .and_then(|v| v.trim().parse::<usize>().ok())
                            .unwrap_or(0);
                        break (i + 4, length);
                    }
                };
                while buf.len() < head_end + length {
                    let n = sock.read(&mut chunk).await.unwrap();
                    buf.extend_from_slice(&chunk[..n]);
                }
                let head = String::from_utf8_lossy(&buf[..head_end]).to_string();
                let body = String::from_utf8_lossy(&buf[head_end..]).to_string();
                let mut first = head.lines().next().unwrap().split(' ');
                let (method, path) = (first.next().unwrap(), first.next().unwrap());
                let (status, out) = google.route(method, path, &head, &body);
                let res = format!(
                    "HTTP/1.1 {status} X\r\ncontent-type: application/json\r\ncontent-length: {}\r\nconnection: close\r\n\r\n{out}",
                    out.len()
                );
                let _ = sock.write_all(res.as_bytes()).await;
            });
        }
    });
    addr
}

/// Where the instance sends what comes through TLS: a greeting, or (once
/// set) the test Postgres.
type Upstream = Arc<Mutex<Option<SocketAddr>>>;

/// The instance's port: TLS with a client certificate from `client_ca`.
async fn serve_instance(google: &Google, upstream: Upstream) -> u16 {
    let key = KeyPair::generate().unwrap();
    let mut p = CertificateParams::new(vec![SERVER_DNS.to_string()]).unwrap();
    p.distinguished_name.push(DnType::CommonName, "acme:orders");
    let cert = p.signed_by(&key, &google.server_ca).unwrap();
    let mut client_roots = rustls::RootCertStore::empty();
    client_roots.add(google.client_ca.der().clone()).unwrap();
    let provider = Arc::new(rustls::crypto::ring::default_provider());
    let verifier = rustls::server::WebPkiClientVerifier::builder_with_provider(
        client_roots.into(),
        provider.clone(),
    )
    .build()
    .unwrap();
    let config = rustls::ServerConfig::builder_with_provider(provider)
        .with_safe_default_protocol_versions()
        .unwrap()
        .with_client_cert_verifier(verifier)
        .with_single_cert(
            vec![CertificateDer::from(cert.der().to_vec())],
            PrivateKeyDer::Pkcs8(PrivatePkcs8KeyDer::from(key.serialize_der())),
        )
        .unwrap();
    let acceptor = tokio_rustls::TlsAcceptor::from(Arc::new(config));
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = listener.local_addr().unwrap().port();
    tokio::spawn(async move {
        loop {
            let (sock, _) = listener.accept().await.unwrap();
            let acceptor = acceptor.clone();
            let upstream = *upstream.lock().unwrap();
            tokio::spawn(async move {
                let Ok(mut tls) = acceptor.accept(sock).await else {
                    return;
                };
                match upstream {
                    Some(addr) => {
                        let mut pg = TcpStream::connect(addr).await.unwrap();
                        let _ = tokio::io::copy_bidirectional(&mut tls, &mut pg).await;
                    }
                    None => {
                        let _ = tls.write_all(b"hello from orders").await;
                        let _ = tls.shutdown().await;
                    }
                }
            });
        }
    });
    port
}

fn config(name: &str) -> CloudSqlConfig {
    CloudSqlConfig {
        instance: format!("acme:asia-southeast1:{name}"),
        ip_type: CloudSqlIpType::Public,
        credentials: CloudSqlCredentials::Gcloud,
    }
}

async fn greeting(name: &str) -> Result<String, CloudSqlError> {
    let dialer = cloudsql::dialer_for(&format!("test-{name}"), &config(name), None)?;
    read_greeting(&dialer).await
}

async fn read_greeting(dialer: &Arc<cloudsql::CloudSqlDialer>) -> Result<String, CloudSqlError> {
    let mut stream = dialer.dial().await?;
    let mut out = String::new();
    let _ = stream.read_to_string(&mut out).await;
    Ok(out)
}

/// One test, since the connector reads its endpoints once per process.
#[tokio::test]
async fn connector_reaches_only_the_instance_it_was_told_about() {
    let dir = tempfile::tempdir().unwrap();
    let adc = dir.path().join("adc.json");
    std::fs::write(
        &adc,
        r#"{"type":"authorized_user","client_id":"id","client_secret":"s","refresh_token":"r","quota_project_id":"acme-billing"}"#,
    )
    .unwrap();
    std::env::set_var("GOOGLE_APPLICATION_CREDENTIALS", &adc);
    std::env::set_var("ROWKERY_CONFIG_DIR", dir.path());

    let google = Arc::new(Google {
        server_ca: ca("Google Cloud SQL Server CA"),
        client_ca: ca("Google Cloud SQL Signing CA"),
        instances: Mutex::new(HashMap::new()),
        certs_issued: AtomicUsize::new(0),
        denied_calls: AtomicUsize::new(0),
        moving_calls: AtomicUsize::new(0),
        quota_project: Mutex::new(None),
    });
    let ca_pem = google.server_ca.pem();
    let imposter_pem = ca("Someone else").pem();
    {
        let mut i = google.instances.lock().unwrap();
        let inst = |ca_pem: &str, dns_names: Option<Vec<String>>| Instance {
            ca_pem: ca_pem.to_string(),
            dns_names,
            version: "POSTGRES_16",
        };
        i.insert("orders".into(), inst(&ca_pem, None));
        i.insert(
            "orders-cas".into(),
            inst(&ca_pem, Some(vec![SERVER_DNS.into()])),
        );
        i.insert(
            "orders-wrong-name".into(),
            inst(&ca_pem, Some(vec!["other.asia-southeast1.sql.goog".into()])),
        );
        i.insert("imposter".into(), inst(&imposter_pem, None));
        i.insert("moving".into(), inst(&ca_pem, None));
        i.insert(
            "crm".into(),
            Instance {
                version: "MYSQL_8_0",
                ..inst(&ca_pem, None)
            },
        );
    }
    let http = serve_http(google.clone()).await;
    let upstream_at = Upstream::default();
    let instance_port = serve_instance(&google, upstream_at.clone()).await;
    std::env::set_var("ROWKERY_CLOUDSQL_TEST_ADMIN", format!("http://{http}"));
    std::env::set_var("ROWKERY_CLOUDSQL_TEST_PROJECTS", format!("http://{http}"));
    std::env::set_var("ROWKERY_CLOUDSQL_TEST_TOKEN", format!("http://{http}"));
    std::env::set_var("ROWKERY_CLOUDSQL_TEST_PORT", instance_port.to_string());

    // The issued certificate gets in; the connection's next dial reuses it.
    let orders = cloudsql::dialer_for("test-orders", &config("orders"), None).unwrap();
    assert_eq!(read_greeting(&orders).await.unwrap(), "hello from orders");
    assert_eq!(read_greeting(&orders).await.unwrap(), "hello from orders");
    assert_eq!(google.certs_issued.load(Ordering::SeqCst), 1);
    assert_eq!(
        google.quota_project.lock().unwrap().as_deref(),
        Some("acme-billing")
    );

    // On Google's shared CA, the certificate must name the instance.
    assert_eq!(greeting("orders-cas").await.unwrap(), "hello from orders");
    let err = greeting("orders-wrong-name").await.unwrap_err().to_string();
    assert!(err.contains("secure connection"), "{err}");
    // A server signed by any other CA isn't the instance. A certificate
    // fetched for this dial isn't fetched again to fail the same way.
    let issued = google.certs_issued.load(Ordering::SeqCst);
    let err = greeting("imposter").await.unwrap_err().to_string();
    assert!(err.contains("secure connection"), "{err}");
    assert_eq!(google.certs_issued.load(Ordering::SeqCst), issued + 1);

    // Dials waiting on a renewal that fails get its error, not one more
    // round of Admin API calls each.
    let denied = cloudsql::dialer_for("test-denied", &config("denied"), None).unwrap();
    let (a, b, c) = tokio::join!(
        read_greeting(&denied),
        read_greeting(&denied),
        read_greeting(&denied)
    );
    for err in [a, b, c] {
        let err = err.unwrap_err();
        assert!(
            matches!(err, CloudSqlError::Api { status: 403, .. }),
            "{err}"
        );
    }
    assert!(google.denied_calls.load(Ordering::SeqCst) <= 2);

    // The instance's address changed since the certificate was fetched (on
    // Linux, nothing listens on 127.0.0.2): the next dial fetches both again.
    if cfg!(target_os = "linux") {
        let moving = cloudsql::dialer_for("test-moving", &config("moving"), None).unwrap();
        let err = read_greeting(&moving).await.unwrap_err().to_string();
        assert!(err.contains("127.0.0.2"), "{err}");
        assert_eq!(read_greeting(&moving).await.unwrap(), "hello from orders");
        assert_eq!(google.moving_calls.load(Ordering::SeqCst), 2);
    }
    let err = greeting("crm").await.unwrap_err().to_string();
    assert!(err.contains("runs MySQL 8.0"), "{err}");

    // The picker's account and instances; a project it can't read is named.
    let account = cloudsql::account(None).await.unwrap().unwrap();
    assert_eq!(
        (account.kind, account.email.as_deref()),
        ("gcloud", Some("dev@example.com"))
    );
    let list = cloudsql::instances(None).await.unwrap();
    let names: Vec<_> = list
        .instances
        .iter()
        .map(|i| (i.connection_name.as_str(), i.postgres, i.state.as_str()))
        .collect();
    assert_eq!(
        names,
        vec![
            ("acme:us-central1:crm", false, "stopped"),
            ("acme:asia-southeast1:orders", true, "running")
        ]
    );
    assert_eq!(list.skipped, vec!["locked".to_string()]);

    // `gcloud auth application-default set-quota-project` keeps the refresh
    // token, so the cached token stays; the new quota project applies at once.
    std::fs::write(
        &adc,
        r#"{"type":"authorized_user","client_id":"id","client_secret":"s","refresh_token":"r","quota_project_id":"acme-other"}"#,
    )
    .unwrap();
    cloudsql::instances(None).await.unwrap();
    assert_eq!(
        google.quota_project.lock().unwrap().as_deref(),
        Some("acme-other")
    );

    // No gcloud login: the form says so rather than failing.
    std::env::set_var(
        "GOOGLE_APPLICATION_CREDENTIALS",
        dir.path().join("none.json"),
    );
    assert_eq!(cloudsql::account(None).await.unwrap(), None);
    std::env::set_var("GOOGLE_APPLICATION_CREDENTIALS", &adc);
}
