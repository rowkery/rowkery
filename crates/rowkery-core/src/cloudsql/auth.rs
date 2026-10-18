//! Google access tokens for the Cloud SQL Admin API: from the gcloud login
//! on this machine (Application Default Credentials) or from a service
//! account key kept in the keychain. Tokens live in memory only.

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use base64::Engine;
use serde::Deserialize;
use sha2::{Digest, Sha256};

use super::{endpoints, http, CloudSqlError};

/// What a service account's token is for: the Admin API, and listing the
/// projects it can see (for the instance picker). Nothing broader.
const SCOPES: &str = "https://www.googleapis.com/auth/sqlservice.admin https://www.googleapis.com/auth/cloudplatformprojects.readonly";
/// What a service account needs to act as another one (`generateAccessToken`
/// accepts nothing narrower), asked for only when it's the source of an
/// impersonated login.
const IMPERSONATION_SCOPE: &str = "https://www.googleapis.com/auth/cloud-platform";
/// A token this close to expiry is renewed before use.
const TOKEN_MARGIN: Duration = Duration::from_secs(120);

/// The command that makes a gcloud login Rowkery can use.
pub const GCLOUD_LOGIN: &str = "gcloud auth application-default login";

/// A credential file, as gcloud and the console write them.
#[derive(Clone, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub(crate) enum Credentials {
    /// `gcloud auth application-default login`.
    AuthorizedUser {
        client_id: String,
        client_secret: String,
        refresh_token: String,
        #[serde(default)]
        quota_project_id: Option<String>,
    },
    /// A key created for a service account in the console.
    ServiceAccount {
        client_email: String,
        private_key: String,
        #[serde(default)]
        private_key_id: Option<String>,
        #[serde(default)]
        token_uri: Option<String>,
    },
    /// `gcloud auth application-default login --impersonate-service-account`.
    ImpersonatedServiceAccount {
        service_account_impersonation_url: String,
        source_credentials: Box<Credentials>,
    },
    /// Workload identity federation: not something a desktop login makes.
    ExternalAccount {},
}

impl std::fmt::Debug for Credentials {
    // Never print a refresh token or a private key.
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        let kind = match self {
            Self::AuthorizedUser { .. } => "authorized_user",
            Self::ServiceAccount { .. } => "service_account",
            Self::ImpersonatedServiceAccount { .. } => "impersonated_service_account",
            Self::ExternalAccount {} => "external_account",
        };
        write!(f, "Credentials({kind})")
    }
}

impl Credentials {
    pub(crate) fn parse(json: &str) -> Result<Self, CloudSqlError> {
        let creds: Self = serde_json::from_str(json).map_err(|e| {
            CloudSqlError::Login(format!("Couldn't read the Google credentials: {e}"))
        })?;
        if matches!(creds, Self::ExternalAccount {}) {
            return Err(CloudSqlError::Login(
                "Workload identity (external_account) credentials aren't supported; use a gcloud login or a service account key".into(),
            ));
        }
        Ok(creds)
    }

    /// The account's email when the file names it (service accounts).
    pub(crate) fn email(&self) -> Option<String> {
        match self {
            Self::ServiceAccount { client_email, .. } => Some(client_email.clone()),
            Self::ImpersonatedServiceAccount {
                service_account_impersonation_url,
                ..
            } => impersonated_email(service_account_impersonation_url),
            _ => None,
        }
    }

    /// Sent as `x-goog-user-project` (a user login's quota project). Read
    /// from the file each call, so `set-quota-project` applies at once.
    pub(crate) fn quota_project(&self) -> Option<&str> {
        match self {
            Self::AuthorizedUser {
                quota_project_id, ..
            } => quota_project_id.as_deref(),
            _ => None,
        }
    }
}

/// `…/serviceAccounts/name@project.iam.gserviceaccount.com:generateAccessToken`.
fn impersonated_email(url: &str) -> Option<String> {
    let tail = url.rsplit_once("/serviceAccounts/")?.1;
    Some(tail.split(':').next()?.to_string())
}

/// gcloud's Application Default Credentials file: `GOOGLE_APPLICATION_CREDENTIALS`,
/// else `application_default_credentials.json` in gcloud's config folder.
pub(crate) fn adc_path() -> Option<PathBuf> {
    if let Some(p) = std::env::var_os("GOOGLE_APPLICATION_CREDENTIALS").filter(|p| !p.is_empty()) {
        return Some(PathBuf::from(p));
    }
    let dir = if let Some(d) = std::env::var_os("CLOUDSDK_CONFIG").filter(|d| !d.is_empty()) {
        PathBuf::from(d)
    } else if cfg!(windows) {
        PathBuf::from(std::env::var_os("APPDATA")?).join("gcloud")
    } else {
        PathBuf::from(std::env::var_os("HOME")?).join(".config/gcloud")
    };
    Some(dir.join("application_default_credentials.json"))
}

/// The gcloud login, or `None` when this machine has none.
pub(crate) fn gcloud_credentials() -> Result<Option<Credentials>, CloudSqlError> {
    let Some(path) = adc_path() else {
        return Ok(None);
    };
    match std::fs::read_to_string(&path) {
        Ok(json) => Credentials::parse(&json).map(Some),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(e) => Err(CloudSqlError::Login(format!(
            "Couldn't read {}: {e}",
            path.display()
        ))),
    }
}

/// A bearer token and when it stops working.
#[derive(Clone)]
pub(crate) struct Token {
    pub value: String,
    expires: SystemTime,
}

impl Token {
    fn fresh(&self) -> bool {
        SystemTime::now() + TOKEN_MARGIN < self.expires
    }
}

/// Tokens by credential (a hash of its file), shared by every connection
/// that uses it.
fn cache() -> &'static Mutex<HashMap<[u8; 32], Token>> {
    static CACHE: OnceLock<Mutex<HashMap<[u8; 32], Token>>> = OnceLock::new();
    CACHE.get_or_init(Default::default)
}

fn cache_key(creds: &Credentials) -> [u8; 32] {
    let mut h = Sha256::new();
    match creds {
        Credentials::AuthorizedUser { refresh_token, .. } => h.update(refresh_token),
        Credentials::ServiceAccount {
            client_email,
            private_key,
            ..
        } => {
            h.update(client_email);
            h.update(private_key);
        }
        Credentials::ImpersonatedServiceAccount {
            service_account_impersonation_url,
            source_credentials,
        } => {
            h.update(service_account_impersonation_url);
            h.update(cache_key(source_credentials));
        }
        Credentials::ExternalAccount {} => {}
    }
    h.finalize().into()
}

/// A token for `creds`, from memory while it has a while left.
pub(crate) async fn token(creds: &Credentials) -> Result<Token, CloudSqlError> {
    let key = cache_key(creds);
    if let Some(t) = cache().lock().ok().and_then(|c| c.get(&key).cloned()) {
        if t.fresh() {
            return Ok(t);
        }
    }
    let t = fetch(creds, SCOPES).await?;
    if let Ok(mut c) = cache().lock() {
        c.insert(key, t.clone());
    }
    Ok(t)
}

/// Drops a token the API refused, so the next try fetches a new one.
pub(crate) fn forget(creds: &Credentials) {
    if let Ok(mut c) = cache().lock() {
        c.remove(&cache_key(creds));
    }
}

#[derive(Deserialize)]
struct TokenResponse {
    access_token: String,
    #[serde(default)]
    expires_in: Option<u64>,
}

#[derive(Deserialize)]
struct OAuthError {
    #[serde(default)]
    error: String,
    #[serde(default)]
    error_description: String,
}

/// A new token for `creds`; `scope` applies to service account keys (a user
/// login's scopes were fixed when gcloud signed in).
fn fetch<'a>(
    creds: &'a Credentials,
    scope: &'static str,
) -> futures::future::BoxFuture<'a, Result<Token, CloudSqlError>> {
    Box::pin(async move {
        match creds {
            Credentials::AuthorizedUser {
                client_id,
                client_secret,
                refresh_token,
                ..
            } => {
                let form = [
                    ("grant_type", "refresh_token"),
                    ("client_id", client_id.as_str()),
                    ("client_secret", client_secret.as_str()),
                    ("refresh_token", refresh_token.as_str()),
                ];
                let uri = format!("{}/token", endpoints().token);
                token_request(&uri, &form, true).await
            }
            Credentials::ServiceAccount {
                client_email,
                private_key,
                private_key_id,
                token_uri,
            } => {
                let default_uri = format!("{}/token", endpoints().token);
                let uri = token_uri.as_deref().unwrap_or(&default_uri);
                let assertion = jwt_assertion(
                    client_email,
                    private_key,
                    private_key_id.as_deref(),
                    uri,
                    scope,
                )?;
                let form = [
                    ("grant_type", "urn:ietf:params:oauth:grant-type:jwt-bearer"),
                    ("assertion", assertion.as_str()),
                ];
                token_request(uri, &form, false).await
            }
            Credentials::ImpersonatedServiceAccount {
                service_account_impersonation_url,
                source_credentials,
            } => {
                let source = fetch(source_credentials, IMPERSONATION_SCOPE).await?;
                impersonate(service_account_impersonation_url, &source).await
            }
            Credentials::ExternalAccount {} => Err(CloudSqlError::Login(
                "Workload identity credentials aren't supported".into(),
            )),
        }
    })
}

async fn token_request(
    uri: &str,
    form: &[(&str, &str)],
    user: bool,
) -> Result<Token, CloudSqlError> {
    let res =
        http()?.post(uri).form(form).send().await.map_err(|e| {
            CloudSqlError::Network(format!("Couldn't reach Google to sign in: {e}"))
        })?;
    let status = res.status();
    let body = res
        .text()
        .await
        .map_err(|e| CloudSqlError::Network(e.to_string()))?;
    if !status.is_success() {
        let err: OAuthError = serde_json::from_str(&body).unwrap_or(OAuthError {
            error: status.to_string(),
            error_description: String::new(),
        });
        // invalid_grant / invalid_rapt: the refresh token was revoked or the
        // session needs a fresh sign-in.
        let why = format!("{} {}", err.error, err.error_description);
        return Err(if user {
            CloudSqlError::Login(format!(
                "Google refused the gcloud login ({}). Run `{GCLOUD_LOGIN}` again",
                why.trim()
            ))
        } else {
            CloudSqlError::Login(format!(
                "Google refused the service account key ({})",
                why.trim()
            ))
        });
    }
    let t: TokenResponse = serde_json::from_str(&body)
        .map_err(|e| CloudSqlError::Login(format!("Unexpected answer from Google sign-in: {e}")))?;
    Ok(Token {
        value: t.access_token,
        expires: SystemTime::now() + Duration::from_secs(t.expires_in.unwrap_or(3600)),
    })
}

async fn impersonate(url: &str, source: &Token) -> Result<Token, CloudSqlError> {
    #[derive(Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct Impersonated {
        access_token: String,
    }
    let scopes: Vec<&str> = SCOPES.split(' ').collect();
    let res = http()?
        .post(url)
        .bearer_auth(&source.value)
        .json(&serde_json::json!({ "scope": scopes, "lifetime": "3600s" }))
        .send()
        .await
        .map_err(|e| CloudSqlError::Network(e.to_string()))?;
    let status = res.status();
    let body = res
        .text()
        .await
        .map_err(|e| CloudSqlError::Network(e.to_string()))?;
    if !status.is_success() {
        return Err(CloudSqlError::Login(format!(
            "Couldn't act as the service account: {}",
            super::admin::google_message(&body).unwrap_or_else(|| status.to_string())
        )));
    }
    let t: Impersonated =
        serde_json::from_str(&body).map_err(|e| CloudSqlError::Login(e.to_string()))?;
    Ok(Token {
        value: t.access_token,
        // `expireTime` is RFC 3339; an hour is what was asked for.
        expires: SystemTime::now() + Duration::from_secs(3540),
    })
}

/// A signed JWT that trades for a service account's token (RS256).
fn jwt_assertion(
    email: &str,
    private_key_pem: &str,
    key_id: Option<&str>,
    audience: &str,
    scope: &str,
) -> Result<String, CloudSqlError> {
    let bad_key =
        |why: &str| CloudSqlError::Login(format!("The service account key's private key {why}"));
    let der = super::tls::pem_blocks(private_key_pem, "PRIVATE KEY")
        .into_iter()
        .next()
        .ok_or_else(|| bad_key("is missing"))?;
    let key =
        ring::signature::RsaKeyPair::from_pkcs8(&der).map_err(|_| bad_key("isn't an RSA key"))?;
    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs();
    let mut header = serde_json::json!({ "alg": "RS256", "typ": "JWT" });
    if let Some(kid) = key_id {
        header["kid"] = kid.into();
    }
    let claims = serde_json::json!({
        "iss": email,
        "scope": scope,
        "aud": audience,
        "iat": now,
        "exp": now + 3600,
    });
    let signing_input = format!(
        "{}.{}",
        URL_SAFE_NO_PAD.encode(header.to_string()),
        URL_SAFE_NO_PAD.encode(claims.to_string())
    );
    let mut sig = vec![0; key.public().modulus_len()];
    key.sign(
        &ring::signature::RSA_PKCS1_SHA256,
        &ring::rand::SystemRandom::new(),
        signing_input.as_bytes(),
        &mut sig,
    )
    .map_err(|_| bad_key("couldn't sign"))?;
    Ok(format!("{signing_input}.{}", URL_SAFE_NO_PAD.encode(sig)))
}

/// Who a token belongs to, for the form's account row (a user login's file
/// doesn't name its account).
pub(crate) async fn token_email(token: &Token) -> Option<String> {
    #[derive(Deserialize)]
    struct Info {
        #[serde(default)]
        email: Option<String>,
    }
    // In the body, not the URL, which proxies log.
    let res = http()
        .ok()?
        .post(format!("{}/tokeninfo", endpoints().token))
        .form(&[("access_token", token.value.as_str())])
        .send()
        .await
        .ok()?;
    if !res.status().is_success() {
        return None;
    }
    res.json::<Info>().await.ok()?.email
}

/// Where a connection's Google login comes from.
#[derive(Clone)]
pub(crate) enum Login {
    /// gcloud's file, read again whenever a token is needed, so a fresh
    /// `gcloud auth application-default login` is picked up.
    Gcloud,
    /// A service account key (from the keychain, or typed in the form).
    Key(Arc<Credentials>),
}

impl Login {
    pub(crate) async fn credentials(&self) -> Result<Arc<Credentials>, CloudSqlError> {
        match self {
            Self::Key(c) => Ok(c.clone()),
            Self::Gcloud => tokio::task::spawn_blocking(gcloud_credentials)
                .await
                .map_err(|e| CloudSqlError::Login(e.to_string()))??
                .map(Arc::new)
                .ok_or_else(|| {
                    CloudSqlError::Login(format!(
                        "No gcloud login on this computer. Run `{GCLOUD_LOGIN}`, then try again"
                    ))
                }),
        }
    }

    /// Identifies the login for the dialer registry (never the secret itself).
    pub(crate) fn fingerprint(&self) -> Option<[u8; 32]> {
        match self {
            Self::Gcloud => None,
            Self::Key(c) => Some(cache_key(c)),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_each_kind_of_credentials_file() {
        let user = Credentials::parse(
            r#"{"type":"authorized_user","client_id":"id","client_secret":"s","refresh_token":"r","quota_project_id":"q"}"#,
        )
        .unwrap();
        assert!(matches!(user, Credentials::AuthorizedUser { .. }));
        assert_eq!(user.quota_project(), Some("q"));
        assert_eq!(user.email(), None);

        let sa = Credentials::parse(
            r#"{"type":"service_account","client_email":"bot@p.iam.gserviceaccount.com","private_key":"k","project_id":"p"}"#,
        )
        .unwrap();
        assert_eq!(sa.email().as_deref(), Some("bot@p.iam.gserviceaccount.com"));

        let imp = Credentials::parse(
            r#"{"type":"impersonated_service_account","service_account_impersonation_url":"https://iamcredentials.googleapis.com/v1/projects/-/serviceAccounts/ro@p.iam.gserviceaccount.com:generateAccessToken","source_credentials":{"type":"authorized_user","client_id":"id","client_secret":"s","refresh_token":"r"}}"#,
        )
        .unwrap();
        assert_eq!(imp.email().as_deref(), Some("ro@p.iam.gserviceaccount.com"));

        assert!(Credentials::parse(r#"{"type":"external_account"}"#).is_err());
        assert!(Credentials::parse("not json").is_err());
    }

    #[test]
    fn debug_never_prints_secrets() {
        let user = Credentials::parse(
            r#"{"type":"authorized_user","client_id":"id","client_secret":"s","refresh_token":"SECRET"}"#,
        )
        .unwrap();
        assert!(!format!("{user:?}").contains("SECRET"));
    }

    #[test]
    fn jwt_assertion_is_signed_with_the_key() {
        let pkcs8 = super::super::tls::test_rsa_pkcs8_pem();
        let jwt =
            jwt_assertion("bot@p.iam", &pkcs8, Some("kid1"), "https://t/token", SCOPES).unwrap();
        let parts: Vec<&str> = jwt.split('.').collect();
        assert_eq!(parts.len(), 3);
        let claims: serde_json::Value =
            serde_json::from_slice(&URL_SAFE_NO_PAD.decode(parts[1]).unwrap()).unwrap();
        assert_eq!(claims["iss"], "bot@p.iam");
        assert_eq!(claims["aud"], "https://t/token");
        assert!(claims["scope"]
            .as_str()
            .unwrap()
            .contains("sqlservice.admin"));
        let header: serde_json::Value =
            serde_json::from_slice(&URL_SAFE_NO_PAD.decode(parts[0]).unwrap()).unwrap();
        assert_eq!(header["kid"], "kid1");
        // The signature checks out against the key's public half.
        let der = super::super::tls::pem_blocks(&pkcs8, "PRIVATE KEY").remove(0);
        let pair = ring::signature::RsaKeyPair::from_pkcs8(&der).unwrap();
        let public = ring::signature::UnparsedPublicKey::new(
            &ring::signature::RSA_PKCS1_2048_8192_SHA256,
            pair.public().as_ref(),
        );
        let sig = URL_SAFE_NO_PAD.decode(parts[2]).unwrap();
        public
            .verify(format!("{}.{}", parts[0], parts[1]).as_bytes(), &sig)
            .unwrap();
    }

    #[test]
    fn impersonation_url_names_the_account() {
        assert_eq!(
            impersonated_email("https://x/v1/projects/-/serviceAccounts/a@b.iam.gserviceaccount.com:generateAccessToken").as_deref(),
            Some("a@b.iam.gserviceaccount.com")
        );
        assert_eq!(impersonated_email("https://x/other"), None);
    }
}
