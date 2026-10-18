//! Google Cloud SQL without the Cloud SQL Auth Proxy: the same connector
//! protocol, spoken in-process. The Admin API names the instance's address
//! and CA and signs a short-lived client certificate for a key made here;
//! the session then runs plain Postgres inside a TLS connection to the
//! instance's port 3307. No proxy process, and no local port another
//! program could reach.

mod admin;
mod auth;
mod dialer;
mod tls;

use std::sync::OnceLock;

use thiserror::Error;

pub use admin::{account, instances, CloudSqlAccount, CloudSqlInstance, InstanceList};
pub use auth::GCLOUD_LOGIN;
pub use dialer::{dialer_for, CloudSqlDialer, CloudSqlStream};

/// The port Cloud SQL's server-side proxy listens on.
pub const SERVER_PORT: u16 = 3307;

/// Why the connector couldn't get a session to the instance. The text is
/// what the connection panel shows; `explain` reads its prefixes.
#[derive(Debug, Clone, Error, PartialEq, Eq)]
pub enum CloudSqlError {
    /// No usable Google login, or Google refused it.
    #[error("Google login: {0}")]
    Login(String),
    /// The Admin API answered with an error.
    #[error("Cloud SQL Admin API: {status} {message}")]
    Api { status: u16, message: String },
    /// The instance can't be reached the way the connection asks.
    #[error("Cloud SQL: {0}")]
    Instance(String),
    /// Google or the instance couldn't be reached at all.
    #[error("Cloud SQL: {0}")]
    Network(String),
}

/// `project:region:instance`, the console's "Connection name". A project in
/// a Workspace domain has a colon of its own (`example.com:project`).
#[derive(Clone, Debug, PartialEq, Eq, Hash)]
pub struct InstanceName {
    pub project: String,
    pub region: String,
    pub name: String,
}

impl InstanceName {
    pub fn parse(text: &str) -> Option<Self> {
        let text = text.trim();
        let (rest, name) = text.rsplit_once(':')?;
        let (project, region) = rest.rsplit_once(':')?;
        let ok = |s: &str| !s.is_empty() && !s.contains(char::is_whitespace) && !s.contains('/');
        if !(ok(project) && ok(region) && ok(name)) || project.matches(':').count() > 1 {
            return None;
        }
        Some(Self {
            project: project.into(),
            region: region.into(),
            name: name.into(),
        })
    }
}

impl std::fmt::Display for InstanceName {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}:{}:{}", self.project, self.region, self.name)
    }
}

/// Where the connector's HTTP calls go: Google, unless a test points them
/// at a fake (`ROWKERY_CLOUDSQL_TEST_*`, read only in debug builds).
struct Endpoints {
    admin: String,
    projects: String,
    token: String,
    /// The instance's port ([`SERVER_PORT`]).
    server_port: u16,
}

fn endpoints() -> &'static Endpoints {
    static E: OnceLock<Endpoints> = OnceLock::new();
    E.get_or_init(|| {
        let var = |name: &str, default: &str| {
            if cfg!(debug_assertions) {
                if let Ok(v) = std::env::var(name) {
                    return v;
                }
            }
            default.to_string()
        };
        Endpoints {
            admin: var(
                "ROWKERY_CLOUDSQL_TEST_ADMIN",
                "https://sqladmin.googleapis.com",
            ),
            projects: var(
                "ROWKERY_CLOUDSQL_TEST_PROJECTS",
                "https://cloudresourcemanager.googleapis.com",
            ),
            token: var(
                "ROWKERY_CLOUDSQL_TEST_TOKEN",
                "https://oauth2.googleapis.com",
            ),
            server_port: var("ROWKERY_CLOUDSQL_TEST_PORT", "")
                .parse()
                .unwrap_or(SERVER_PORT),
        }
    })
}

/// One HTTP client for Google's APIs: rustls with ring (the app's only TLS
/// stack) and the system's trust store, so a corporate proxy's CA works.
fn http() -> Result<&'static reqwest::Client, CloudSqlError> {
    static CLIENT: OnceLock<Result<reqwest::Client, String>> = OnceLock::new();
    CLIENT
        .get_or_init(|| {
            let provider = std::sync::Arc::new(rustls::crypto::ring::default_provider());
            let tls = rustls::ClientConfig::builder_with_provider(provider)
                .with_safe_default_protocol_versions()
                .map_err(|e| e.to_string())?
                .with_root_certificates(crate::db::postgres::trust_roots().clone())
                .with_no_client_auth();
            reqwest::Client::builder()
                .tls_backend_preconfigured(tls)
                .connect_timeout(std::time::Duration::from_secs(10))
                .timeout(std::time::Duration::from_secs(30))
                .user_agent(concat!("Rowkery/", env!("CARGO_PKG_VERSION")))
                .build()
                .map_err(|e| e.to_string())
        })
        .as_ref()
        .map_err(|e| CloudSqlError::Network(format!("Couldn't set up HTTPS: {e}")))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_connection_names() {
        let n = InstanceName::parse(" acme-prod:asia-southeast1:orders-prd ").unwrap();
        assert_eq!(
            (n.project.as_str(), n.region.as_str(), n.name.as_str()),
            ("acme-prod", "asia-southeast1", "orders-prd")
        );
        assert_eq!(n.to_string(), "acme-prod:asia-southeast1:orders-prd");
        let d = InstanceName::parse("example.com:acme:us-central1:db").unwrap();
        assert_eq!(d.project, "example.com:acme");
        for bad in [
            "",
            "orders-prd",
            "p:r",
            "p::i",
            ":r:i",
            "a:b:c:d:e",
            "p:r:i x",
            "p/x:r:i",
        ] {
            assert_eq!(InstanceName::parse(bad), None, "{bad}");
        }
    }

    #[test]
    fn errors_read_as_the_panel_expects() {
        assert_eq!(
            CloudSqlError::Api {
                status: 403,
                message: "Forbidden".into()
            }
            .to_string(),
            "Cloud SQL Admin API: 403 Forbidden"
        );
        assert!(CloudSqlError::Login("x".into())
            .to_string()
            .starts_with("Google login: "));
    }
}
