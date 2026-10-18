//! The Cloud SQL Admin API calls the connector makes: where an instance is
//! and which CA signs it (`connectSettings`), a client certificate for our
//! key (`generateEphemeralCert`), and the instances an account can see.

use std::sync::Arc;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use futures::StreamExt;
use serde::{Deserialize, Serialize};

use crate::connections::CloudSqlIpType;

use super::auth::{self, Credentials, Login};
use super::{endpoints, http, CloudSqlError, InstanceName};

/// Google's own message from an error body (`{"error":{"message":…}}`).
pub(crate) fn google_message(body: &str) -> Option<String> {
    #[derive(Deserialize)]
    struct Body {
        error: Inner,
    }
    #[derive(Deserialize)]
    struct Inner {
        #[serde(default)]
        message: String,
    }
    let m = serde_json::from_str::<Body>(body).ok()?.error.message;
    (!m.trim().is_empty()).then(|| m.trim().to_string())
}

/// One authorised call, retried once with a new token if Google says the
/// token it had cached is no good.
async fn call<T: serde::de::DeserializeOwned>(
    login: &Login,
    build: impl Fn(&reqwest::Client) -> reqwest::RequestBuilder,
) -> Result<T, CloudSqlError> {
    let creds = login.credentials().await?;
    for attempt in 0..2 {
        let token = auth::token(&creds).await?;
        let mut req = build(http()?).bearer_auth(&token.value);
        if let Some(q) = &token.quota_project {
            req = req.header("x-goog-user-project", q);
        }
        let res = req.send().await.map_err(|e| {
            CloudSqlError::Network(format!("Couldn't reach the Cloud SQL Admin API: {e}"))
        })?;
        let status = res.status();
        let body = res
            .text()
            .await
            .map_err(|e| CloudSqlError::Network(e.to_string()))?;
        if status == reqwest::StatusCode::UNAUTHORIZED && attempt == 0 {
            auth::forget(&creds);
            continue;
        }
        if !status.is_success() {
            return Err(CloudSqlError::Api {
                status: status.as_u16(),
                message: google_message(&body)
                    .unwrap_or_else(|| status.canonical_reason().unwrap_or("").to_string()),
            });
        }
        return serde_json::from_str(&body).map_err(|e| {
            CloudSqlError::Network(format!("Unexpected answer from the Admin API: {e}"))
        });
    }
    unreachable!("the second attempt always returns")
}

fn instance_url(name: &InstanceName) -> String {
    format!(
        "{}/sql/v1beta4/projects/{}/instances/{}",
        endpoints().admin,
        name.project,
        name.name
    )
}

#[derive(Deserialize, Default)]
#[serde(rename_all = "camelCase", default)]
struct ConnectSettings {
    server_ca_cert: Option<SslCert>,
    ip_addresses: Vec<IpMapping>,
    region: String,
    database_version: String,
    backend_type: String,
    dns_name: String,
    dns_names: Vec<DnsNameMapping>,
    psc_enabled: bool,
    server_ca_mode: String,
}

#[derive(Deserialize, Default)]
#[serde(rename_all = "camelCase", default)]
struct SslCert {
    cert: String,
    expiration_time: String,
}

#[derive(Deserialize, Default)]
#[serde(rename_all = "camelCase", default)]
struct IpMapping {
    #[serde(rename = "type")]
    kind: String,
    ip_address: String,
}

#[derive(Deserialize, Default)]
#[serde(rename_all = "camelCase", default)]
struct DnsNameMapping {
    name: String,
    connection_type: String,
}

/// What a session needs to reach the instance.
pub(crate) struct Target {
    /// IP address, or the PSC DNS name.
    pub host: String,
    pub ca_pem: String,
    /// Names the server certificate must carry (any one), when the instance
    /// is on Google's shared CA; empty when it has a CA of its own.
    pub dns_names: Vec<String>,
}

pub(crate) async fn connect_target(
    login: &Login,
    name: &InstanceName,
    ip_type: CloudSqlIpType,
) -> Result<Target, CloudSqlError> {
    let url = format!("{}/connectSettings", instance_url(name));
    let s: ConnectSettings = call(login, |c| c.get(&url)).await?;
    target_from(s, name, ip_type)
}

fn target_from(
    s: ConnectSettings,
    name: &InstanceName,
    ip_type: CloudSqlIpType,
) -> Result<Target, CloudSqlError> {
    let bad = |m: String| Err(CloudSqlError::Instance(m));
    let inst = &name.name;
    if !s.region.is_empty() && s.region != name.region {
        return bad(format!(
            "{inst} is in {}, not {}. Check the instance name",
            s.region, name.region
        ));
    }
    if !s.backend_type.is_empty() && s.backend_type != "SECOND_GEN" {
        return bad(format!(
            "{inst} is a first-generation instance, which the connector can't reach"
        ));
    }
    if !s.database_version.is_empty() && !s.database_version.starts_with("POSTGRES") {
        return bad(format!(
            "{inst} runs {}. Rowkery connects to Postgres instances",
            engine_label(&s.database_version)
        ));
    }
    let named = |kind: &str| {
        s.dns_names
            .iter()
            .find(|d| d.connection_type == kind && !d.name.is_empty())
            .map(|d| d.name.trim_end_matches('.').to_string())
    };
    let ip = |kind: &str| {
        s.ip_addresses
            .iter()
            .find(|i| i.kind == kind && !i.ip_address.is_empty())
            .map(|i| i.ip_address.clone())
    };
    let host = match ip_type {
        CloudSqlIpType::Public => ip("PRIMARY"),
        CloudSqlIpType::Private => ip("PRIVATE"),
        CloudSqlIpType::Psc => named("PRIVATE_SERVICE_CONNECT").or_else(|| {
            (s.psc_enabled && !s.dns_name.is_empty())
                .then(|| s.dns_name.trim_end_matches('.').to_string())
        }),
    };
    let Some(host) = host else {
        let (what, other) = match ip_type {
            CloudSqlIpType::Public => ("public IP", "Private or PSC"),
            CloudSqlIpType::Private => ("private IP", "Public or PSC"),
            CloudSqlIpType::Psc => ("Private Service Connect address", "Public or Private"),
        };
        return bad(format!("{inst} has no {what}. Pick {other} under Advanced"));
    };
    let ca_pem = s.server_ca_cert.map(|c| c.cert).unwrap_or_default();
    if ca_pem.trim().is_empty() {
        return bad(format!("The Admin API sent no CA for {inst}"));
    }
    let shared_ca = s.server_ca_mode.ends_with("_CAS_CA");
    let dns_names = if shared_ca {
        let mut names: Vec<String> = s
            .dns_names
            .iter()
            .map(|d| d.name.trim_end_matches('.').to_string())
            .filter(|n| !n.is_empty())
            .collect();
        if !s.dns_name.is_empty() {
            names.push(s.dns_name.trim_end_matches('.').to_string());
        }
        if names.is_empty() {
            return bad(format!(
                "The Admin API sent no DNS name to check {inst}'s certificate against"
            ));
        }
        names
    } else {
        Vec::new()
    };
    Ok(Target {
        host,
        ca_pem,
        dns_names,
    })
}

/// A client certificate for `public_pem`, and when it stops working.
pub(crate) async fn ephemeral_cert(
    login: &Login,
    name: &InstanceName,
    public_pem: &str,
) -> Result<(String, SystemTime), CloudSqlError> {
    #[derive(Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct Res {
        ephemeral_cert: SslCert,
    }
    let url = format!("{}:generateEphemeralCert", instance_url(name));
    let body = serde_json::json!({ "public_key": public_pem });
    let res: Res = call(login, |c| c.post(&url).json(&body)).await?;
    let expires = parse_rfc3339(&res.ephemeral_cert.expiration_time)
        .unwrap_or_else(|| SystemTime::now() + Duration::from_secs(3600));
    Ok((res.ephemeral_cert.cert, expires))
}

/// `2026-10-18T10:31:13.281Z` (UTC only, as Google writes it).
fn parse_rfc3339(text: &str) -> Option<SystemTime> {
    let text = text.trim().strip_suffix('Z')?;
    let (date, time) = text.split_once('T')?;
    let mut d = date.splitn(3, '-').map(|p| p.parse::<i64>().ok());
    let (y, m, day) = (d.next()??, d.next()??, d.next()??);
    let time = time.split('.').next()?;
    let mut t = time.splitn(3, ':').map(|p| p.parse::<u64>().ok());
    let (hh, mm, ss) = (t.next()??, t.next()??, t.next()??);
    // Days from the civil date (Howard Hinnant's algorithm).
    let y = if m <= 2 { y - 1 } else { y };
    let era = y.div_euclid(400);
    let yoe = y - era * 400;
    let mp = (m + 9) % 12;
    let doy = (153 * mp + 2) / 5 + day - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    let days = u64::try_from(era * 146_097 + doe - 719_468).ok()?;
    Some(UNIX_EPOCH + Duration::from_secs(days * 86_400 + hh * 3600 + mm * 60 + ss))
}

/// `POSTGRES_16` → `Postgres 16`, `MYSQL_8_0` → `MySQL 8.0`.
fn engine_label(version: &str) -> String {
    let mut parts = version.split('_');
    let engine = match parts.next().unwrap_or_default() {
        "POSTGRES" => "Postgres".to_string(),
        "MYSQL" => "MySQL".to_string(),
        "SQLSERVER" => "SQL Server".to_string(),
        other => other.to_string(),
    };
    let (numbers, words): (Vec<&str>, Vec<&str>) =
        parts.partition(|p| p.chars().all(|c| c.is_ascii_digit()));
    let mut label = engine;
    if !numbers.is_empty() {
        label = format!("{label} {}", numbers.join("."));
    }
    for w in words {
        let mut chars = w.chars();
        if let Some(first) = chars.next() {
            label = format!("{label} {first}{}", chars.as_str().to_ascii_lowercase());
        }
    }
    label
}

/// The Google account the form shows above the instance picker.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct CloudSqlAccount {
    /// `gcloud` or `key`.
    pub kind: &'static str,
    /// Unknown when Google won't say (the token has no email scope).
    pub email: Option<String>,
}

fn login_for(key_json: Option<&str>) -> Result<Login, CloudSqlError> {
    match key_json.map(str::trim).filter(|k| !k.is_empty()) {
        Some(json) => Ok(Login::Key(Arc::new(Credentials::parse(json)?))),
        None => Ok(Login::Gcloud),
    }
}

/// The account a connection would use: the service account in `key_json`,
/// else the gcloud login (`None` when this computer has none).
pub async fn account(key_json: Option<&str>) -> Result<Option<CloudSqlAccount>, CloudSqlError> {
    let login = login_for(key_json)?;
    if let Login::Key(c) = &login {
        return Ok(Some(CloudSqlAccount {
            kind: "key",
            email: c.email(),
        }));
    }
    let creds = match login.credentials().await {
        Ok(c) => c,
        Err(CloudSqlError::Login(m)) if m.starts_with("No gcloud login") => return Ok(None),
        Err(e) => return Err(e),
    };
    let email = match creds.email() {
        Some(e) => Some(e),
        None => auth::token_email(&auth::token(&creds).await?).await,
    };
    Ok(Some(CloudSqlAccount {
        kind: "gcloud",
        email,
    }))
}

/// An instance the account can see, for the picker.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct CloudSqlInstance {
    pub project: String,
    pub name: String,
    pub region: String,
    /// `project:region:name`.
    pub connection_name: String,
    /// `Postgres 16`, `MySQL 8.0`.
    pub engine: String,
    pub postgres: bool,
    /// `running`, `stopped`, or Google's own state in lower case.
    pub state: String,
}

#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize)]
pub struct InstanceList {
    pub instances: Vec<CloudSqlInstance>,
    /// Projects whose instances couldn't be listed (no permission, or the
    /// Admin API is off there), so the picker can say some are missing.
    pub skipped: Vec<String>,
}

/// Every Cloud SQL instance in the projects the account can see.
pub async fn instances(key_json: Option<&str>) -> Result<InstanceList, CloudSqlError> {
    let login = login_for(key_json)?;
    let projects = projects(&login).await?;
    let lists: Vec<_> = futures::stream::iter(projects)
        .map(|p| {
            let login = login.clone();
            async move {
                let r = project_instances(&login, &p).await;
                (p, r)
            }
        })
        .buffer_unordered(8)
        .collect()
        .await;
    let mut out = InstanceList::default();
    for (project, listed) in lists {
        match listed {
            Ok(list) => out.instances.extend(list),
            Err(_) => out.skipped.push(project),
        }
    }
    out.instances
        .sort_by(|a, b| (&a.project, &a.name).cmp(&(&b.project, &b.name)));
    out.skipped.sort();
    Ok(out)
}

async fn projects(login: &Login) -> Result<Vec<String>, CloudSqlError> {
    #[derive(Deserialize, Default)]
    #[serde(rename_all = "camelCase", default)]
    struct Page {
        projects: Vec<Project>,
        next_page_token: String,
    }
    #[derive(Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct Project {
        project_id: String,
    }
    let url = format!("{}/v1/projects", endpoints().projects);
    let mut out = Vec::new();
    let mut page_token = String::new();
    // A cap, so an account in thousands of projects still gets a list.
    for _ in 0..10 {
        let page: Page = call(login, |c| {
            let mut q = vec![("filter", "lifecycleState:ACTIVE"), ("pageSize", "500")];
            if !page_token.is_empty() {
                q.push(("pageToken", page_token.as_str()));
            }
            c.get(&url).query(&q)
        })
        .await?;
        out.extend(page.projects.into_iter().map(|p| p.project_id));
        if page.next_page_token.is_empty() {
            break;
        }
        page_token = page.next_page_token;
    }
    Ok(out)
}

async fn project_instances(
    login: &Login,
    project: &str,
) -> Result<Vec<CloudSqlInstance>, CloudSqlError> {
    #[derive(Deserialize, Default)]
    #[serde(rename_all = "camelCase", default)]
    struct Page {
        items: Vec<Item>,
        next_page_token: String,
    }
    #[derive(Deserialize, Default)]
    #[serde(rename_all = "camelCase", default)]
    struct Item {
        name: String,
        region: String,
        database_version: String,
        state: String,
        settings: Settings,
    }
    #[derive(Deserialize, Default)]
    #[serde(rename_all = "camelCase", default)]
    struct Settings {
        activation_policy: String,
    }
    let url = format!(
        "{}/sql/v1beta4/projects/{project}/instances",
        endpoints().admin
    );
    let mut out = Vec::new();
    let mut page_token = String::new();
    for _ in 0..10 {
        let page: Page = call(login, |c| {
            let mut req = c.get(&url);
            if !page_token.is_empty() {
                req = req.query(&[("pageToken", page_token.as_str())]);
            }
            req
        })
        .await?;
        out.extend(page.items.into_iter().map(|i| {
            // A stopped instance is RUNNABLE with activation policy NEVER.
            let state = if i.state == "RUNNABLE" && i.settings.activation_policy == "NEVER" {
                "stopped".to_string()
            } else if i.state == "RUNNABLE" {
                "running".to_string()
            } else {
                i.state.to_ascii_lowercase()
            };
            CloudSqlInstance {
                connection_name: format!("{project}:{}:{}", i.region, i.name),
                project: project.to_string(),
                engine: engine_label(&i.database_version),
                postgres: i.database_version.starts_with("POSTGRES"),
                name: i.name,
                region: i.region,
                state,
            }
        }));
        if page.next_page_token.is_empty() {
            break;
        }
        page_token = page.next_page_token;
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn name() -> InstanceName {
        InstanceName::parse("acme:asia-southeast1:orders").unwrap()
    }

    fn settings(json: serde_json::Value) -> ConnectSettings {
        serde_json::from_value(json).unwrap()
    }

    fn base() -> serde_json::Value {
        serde_json::json!({
            "serverCaCert": { "cert": "-----BEGIN CERTIFICATE-----\nAA==\n-----END CERTIFICATE-----\n" },
            "ipAddresses": [
                { "type": "PRIMARY", "ipAddress": "34.1.2.3" },
                { "type": "PRIVATE", "ipAddress": "10.0.0.3" }
            ],
            "region": "asia-southeast1",
            "databaseVersion": "POSTGRES_16",
            "backendType": "SECOND_GEN",
            "serverCaMode": "GOOGLE_MANAGED_INTERNAL_CA"
        })
    }

    #[test]
    fn picks_the_address_asked_for() {
        let t = target_from(settings(base()), &name(), CloudSqlIpType::Public).unwrap();
        assert_eq!(t.host, "34.1.2.3");
        assert!(t.dns_names.is_empty());
        let t = target_from(settings(base()), &name(), CloudSqlIpType::Private).unwrap();
        assert_eq!(t.host, "10.0.0.3");
        let err = target_from(settings(base()), &name(), CloudSqlIpType::Psc)
            .err()
            .unwrap();
        assert_eq!(
            err.to_string(),
            "Cloud SQL: orders has no Private Service Connect address. Pick Public or Private under Advanced"
        );
    }

    #[test]
    fn psc_and_shared_ca_instances_use_their_dns_names() {
        let mut j = base();
        j["serverCaMode"] = "GOOGLE_MANAGED_CAS_CA".into();
        j["pscEnabled"] = true.into();
        j["dnsNames"] = serde_json::json!([
            { "name": "abc.asia-southeast1.sql.goog.", "connectionType": "PRIVATE_SERVICE_CONNECT" },
            { "name": "xyz.asia-southeast1.sql.goog.", "connectionType": "PUBLIC" }
        ]);
        let t = target_from(settings(j.clone()), &name(), CloudSqlIpType::Psc).unwrap();
        assert_eq!(t.host, "abc.asia-southeast1.sql.goog");
        assert_eq!(
            t.dns_names,
            vec![
                "abc.asia-southeast1.sql.goog",
                "xyz.asia-southeast1.sql.goog"
            ]
        );
        j["dnsNames"] = serde_json::json!([]);
        assert!(target_from(settings(j), &name(), CloudSqlIpType::Public).is_err());
    }

    #[test]
    fn refuses_the_wrong_engine_or_region() {
        let mut j = base();
        j["databaseVersion"] = "MYSQL_8_0".into();
        let err = target_from(settings(j), &name(), CloudSqlIpType::Public)
            .err()
            .unwrap();
        assert!(err.to_string().contains("runs MySQL 8.0"), "{err}");
        let mut j = base();
        j["region"] = "us-central1".into();
        let err = target_from(settings(j), &name(), CloudSqlIpType::Public)
            .err()
            .unwrap();
        assert!(err.to_string().contains("is in us-central1"), "{err}");
    }

    #[test]
    fn reads_google_times_and_messages() {
        let t = parse_rfc3339("2026-10-18T10:31:13.281Z").unwrap();
        assert_eq!(
            t.duration_since(UNIX_EPOCH).unwrap().as_secs(),
            1_792_319_473
        );
        assert_eq!(parse_rfc3339("1970-01-01T00:00:00Z"), Some(UNIX_EPOCH));
        assert_eq!(parse_rfc3339("garbage"), None);
        assert_eq!(
            google_message(r#"{"error":{"code":403,"message":"Not authorized"}}"#).as_deref(),
            Some("Not authorized")
        );
        assert_eq!(google_message("<html>"), None);
        assert_eq!(engine_label("POSTGRES_16"), "Postgres 16");
        assert_eq!(
            engine_label("SQLSERVER_2019_STANDARD"),
            "SQL Server 2019 Standard"
        );
    }
}
