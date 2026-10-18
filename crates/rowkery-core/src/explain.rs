//! Why a connection failed, in one sentence: the error class read from the
//! raw text (Postgres, the OS, the SSH tunnel or the Cloud SQL connector),
//! the cause the panel shows
//! above the raw text, and which field of the connection sheet to mark.

use serde::Serialize;

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct ConnectExplanation {
    /// `refused`, `timeout`, `dns`, `tls`, `auth`, `database`, `role`,
    /// `ssh_changed`, `ssh_unknown`, `ssh_timeout`, `ssh_auth`, a Cloud SQL
    /// class (`cloudsql_login`, `cloudsql_role`, `cloudsql_instance`,
    /// `cloudsql_api`, `cloudsql_ip`, `cloudsql_unreachable`, `cloudsql_tls`,
    /// `cloudsql`) or `unknown`.
    pub class: &'static str,
    /// The one-line cause; none for `unknown` (the raw text stands alone).
    pub cause: Option<String>,
    /// The sheet field to focus and mark: `host`, `database`, `username`,
    /// `password`, `ssl`, `sshHost`, `sshPassword`, `account`, `instance`,
    /// `ipType`.
    pub field: Option<&'static str>,
}

/// What the panel needs to say about the connection, beyond the raw text.
pub struct Target<'a> {
    pub host: &'a str,
    pub port: u16,
    pub username: &'a str,
    pub ssh_host: Option<&'a str>,
    /// The Cloud SQL instance (`project:region:instance`), when the
    /// connection goes through the connector.
    pub cloud_sql: Option<&'a str>,
}

/// A certificate Verify couldn't check, in one line that points at the setting.
pub const CERT_NOT_VERIFIED: &str =
    "Couldn't verify the server's certificate. Check SSL under Advanced.";

/// Seconds Postgres connects get before giving up (`CONNECT_TIMEOUT`).
const CONNECT_TIMEOUT_S: u64 = 10;

fn quoted(text: &str, after: &str) -> Option<String> {
    let rest = text.split_once(after)?.1.trim_start();
    let rest = rest.strip_prefix('"')?;
    Some(rest[..rest.find('"')?].to_string())
}

/// Reads `raw` (most specific class first: the tunnel's causes before the
/// generic "Could not open tunnel" around them).
pub fn explain_connect_error(raw: &str, t: &Target) -> ConnectExplanation {
    let has = |s: &str| raw.contains(s);
    let lower = raw.to_ascii_lowercase();
    let says = |s: &str| lower.contains(s);
    let bastion = t.ssh_host.unwrap_or(t.host);
    let e = |class, cause: Option<String>, field| ConnectExplanation {
        class,
        cause,
        field,
    };

    if let Some(x) = explain_cloud_sql(raw, t) {
        return x;
    }
    if has("has CHANGED") {
        return e(
            "ssh_changed",
            Some(format!(
                "The SSH host key for {bastion} has CHANGED. Nothing was sent."
            )),
            Some("sshHost"),
        );
    }
    if says("unknown ssh host key") || has("Unknown host key") || has("Unknown server key") {
        return e(
            "ssh_unknown",
            Some(format!("The SSH host {bastion} is new to this Mac.")),
            Some("sshHost"),
        );
    }
    if t.ssh_host.is_some()
        && has("Could not open tunnel")
        && (says("timed out") || says("connection refused"))
    {
        return e(
            "ssh_timeout",
            Some(format!("The SSH host {bastion} did not answer.")),
            Some("sshHost"),
        );
    }
    if has("SSH: Permission denied") || (has("tunnel") && says("authentication failed")) {
        return e(
            "ssh_auth",
            Some(format!(
                "The SSH host {bastion} refused the key or password."
            )),
            Some("sshPassword"),
        );
    }
    if says("rejected password")
        || says("password authentication failed")
        || says("sasl authentication failed")
        || says("asked for a password")
        || has("28P01")
    {
        return e(
            "auth",
            Some(format!(
                "The server rejected the password for {}.",
                t.username
            )),
            Some("password"),
        );
    }
    if let Some(role) = quoted(raw, "role") {
        if has("does not exist") {
            return e(
                "role",
                Some(format!("role \"{role}\" does not exist")),
                Some("username"),
            );
        }
    }
    if let Some(db) = quoted(raw, "database") {
        if has("does not exist") {
            return e(
                "database",
                Some(format!("database \"{db}\" does not exist")),
                Some("database"),
            );
        }
    }
    if says("connection refused") {
        return e(
            "refused",
            Some(format!("Nothing is listening on {}:{}.", t.host, t.port)),
            Some("host"),
        );
    }
    if says("failed to lookup address")
        || says("name or service not known")
        || says("nodename nor servname")
        || says("could not translate host name")
        || says("no such host")
    {
        return e(
            "dns",
            Some(format!("The name {} could not be resolved.", t.host)),
            Some("host"),
        );
    }
    if says("timed out") || says("timeout") {
        return e(
            "timeout",
            Some(format!(
                "{}:{} did not answer in {CONNECT_TIMEOUT_S} s.",
                t.host, t.port
            )),
            Some("host"),
        );
    }
    // Verify (the default off this machine) checks the certificate; the
    // fix is in the sheet's SSL setting.
    if says("invalid peer certificate") || says("couldn't verify the server's certificate") {
        return e("tls", Some(CERT_NOT_VERIFIED.into()), Some("ssl"));
    }
    if says("doesn't accept ssl") || says("server does not support tls") {
        return e(
            "tls",
            Some("The server doesn't accept SSL. Check SSL under Advanced.".into()),
            Some("ssl"),
        );
    }
    if says("certificate") || says("tls") || says("ssl") {
        return e(
            "tls",
            Some("The server's certificate was not accepted.".into()),
            None,
        );
    }
    e("unknown", None, None)
}

/// The connector's own failures (`cloudsql::CloudSqlError`); Postgres's,
/// once the connector got through, fall to the classes above.
fn explain_cloud_sql(raw: &str, t: &Target) -> Option<ConnectExplanation> {
    let e = |class, cause: String, field| {
        Some(ConnectExplanation {
            class,
            cause: Some(cause),
            field,
        })
    };
    let name = t.cloud_sql.and_then(crate::cloudsql::InstanceName::parse);
    let inst = name.as_ref().map_or("the instance", |n| n.name.as_str());
    let project = name.as_ref().map_or("its project", |n| n.project.as_str());
    let lower = raw.to_ascii_lowercase();
    if let Some(rest) = raw.split_once("Google login: ").map(|(_, r)| r) {
        return e("cloudsql_login", sentence(rest), Some("account"));
    }
    if let Some(rest) = raw.split_once("Cloud SQL Admin API: ").map(|(_, r)| r) {
        if lower.contains("service_disabled")
            || lower.contains("has not been used in project")
            || lower.contains("it is disabled")
        {
            return e(
                "cloudsql_api",
                format!("The Cloud SQL Admin API is off in {project}. Turn it on in the Google Cloud console, then try again."),
                Some("instance"),
            );
        }
        if rest.starts_with("403") {
            return e(
                "cloudsql_role",
                format!("This Google account can't connect to {inst}. It needs the Cloud SQL Client role on {project}."),
                Some("instance"),
            );
        }
        if rest.starts_with("404") {
            return e(
                "cloudsql_instance",
                format!("{project} has no Cloud SQL instance named {inst}."),
                Some("instance"),
            );
        }
        return e("cloudsql_api", sentence(raw), Some("instance"));
    }
    let rest = raw.split_once("Cloud SQL: ").map(|(_, r)| r)?;
    if rest.contains(" has no ") {
        return e("cloudsql_ip", sentence(rest), Some("ipType"));
    }
    if rest.contains("did not answer") && !rest.contains("Postgres")
        || rest.contains("couldn't reach")
    {
        return e(
            "cloudsql_unreachable",
            format!("{inst} didn't answer on port {}. A private or PSC address only answers inside its network.", crate::cloudsql::SERVER_PORT),
            Some("ipType"),
        );
    }
    if rest.contains("secure connection to") {
        return e(
            "cloudsql_tls",
            format!("The secure connection to {inst} failed, so nothing was sent."),
            None,
        );
    }
    e("cloudsql", sentence(rest), Some("instance"))
}

/// `text` as a sentence: capitalised, with a full stop.
fn sentence(text: &str) -> String {
    let text = text.trim().trim_end_matches('.');
    let mut chars = text.chars();
    let first = chars
        .next()
        .map(|c| c.to_uppercase().to_string())
        .unwrap_or_default();
    format!("{first}{}.", chars.as_str())
}

#[cfg(test)]
mod tests {
    use super::*;

    const T: Target = Target {
        host: "db.internal",
        port: 5432,
        username: "app",
        ssh_host: None,
        cloud_sql: None,
    };
    const S: Target = Target {
        host: "10.0.0.5",
        port: 5432,
        username: "app",
        ssh_host: Some("bastion.internal"),
        cloud_sql: None,
    };
    const C: Target = Target {
        host: "acme-prod:asia-southeast1:orders-prd",
        port: 5432,
        username: "app_rw",
        ssh_host: None,
        cloud_sql: Some("acme-prod:asia-southeast1:orders-prd"),
    };

    fn class(raw: &str, t: &Target) -> (&'static str, Option<String>, Option<&'static str>) {
        let x = explain_connect_error(raw, t);
        (x.class, x.cause, x.field)
    }

    #[test]
    fn postgres_and_network_classes() {
        assert_eq!(
            class(
                "error connecting to server: Connection refused (os error 61)",
                &T
            ),
            (
                "refused",
                Some("Nothing is listening on db.internal:5432.".into()),
                Some("host")
            )
        );
        assert_eq!(
            class("error connecting to server: timed out", &T),
            (
                "timeout",
                Some("db.internal:5432 did not answer in 10 s.".into()),
                Some("host")
            )
        );
        assert_eq!(
            class("error connecting to server: failed to lookup address information: nodename nor servname provided, or not known", &T),
            ("dns", Some("The name db.internal could not be resolved.".into()), Some("host"))
        );
        assert_eq!(
            class(
                "error performing TLS handshake: invalid peer certificate: UnknownIssuer",
                &T
            ),
            ("tls", Some(CERT_NOT_VERIFIED.into()), Some("ssl"))
        );
        assert_eq!(
            class(
                "Couldn't verify the server's certificate (UnknownIssuer). Check SSL under Advanced.",
                &T
            ),
            ("tls", Some(CERT_NOT_VERIFIED.into()), Some("ssl"))
        );
        assert_eq!(
            class(
                "The server doesn't accept SSL. Check SSL under Advanced.",
                &T
            )
            .2,
            Some("ssl")
        );
        assert_eq!(
            class("Postgres rejected password for 'app'", &T),
            (
                "auth",
                Some("The server rejected the password for app.".into()),
                Some("password")
            )
        );
        assert_eq!(
            class(r#"database "walet" does not exist"#, &T),
            (
                "database",
                Some(r#"database "walet" does not exist"#.into()),
                Some("database")
            )
        );
        assert_eq!(class(r#"role "ap" does not exist"#, &T).2, Some("username"));
        assert_eq!(
            class("something else entirely", &T),
            ("unknown", None, None)
        );
    }

    #[test]
    fn ssh_causes_beat_the_tunnel_wrapper() {
        assert_eq!(
            class(
                "Could not open tunnel to bastion.internal: timed out after 15 s",
                &S
            ),
            (
                "ssh_timeout",
                Some("The SSH host bastion.internal did not answer.".into()),
                Some("sshHost")
            )
        );
        assert_eq!(
            class("Could not open tunnel to bastion.internal: SSH host key for bastion.internal:22 has CHANGED; nothing was sent", &S).0,
            "ssh_changed"
        );
        assert_eq!(
            class("Could not open tunnel to bastion.internal: Unknown SSH host key for bastion.internal:22", &S),
            ("ssh_unknown", Some("The SSH host bastion.internal is new to this Mac.".into()), Some("sshHost"))
        );
        assert_eq!(
            class("SSH: Permission denied (publickey)", &S).0,
            "ssh_auth"
        );
        // A Postgres refusal behind a working tunnel is still Postgres's.
        assert_eq!(class("Postgres rejected password for 'app'", &S).0, "auth");
        // PgBouncer (Cloud SQL managed pooling, Supabase) words it its own way.
        assert_eq!(
            class("db error: FATAL: SASL authentication failed", &S).0,
            "auth"
        );
    }

    #[test]
    fn cloud_sql_causes_name_the_instance() {
        assert_eq!(
            class("Cloud SQL Admin API: 403 The client is not authorized to make this request.", &C),
            (
                "cloudsql_role",
                Some("This Google account can't connect to orders-prd. It needs the Cloud SQL Client role on acme-prod.".into()),
                Some("instance")
            )
        );
        assert_eq!(
            class(
                "Cloud SQL Admin API: 404 The Cloud SQL instance does not exist.",
                &C
            )
            .0,
            "cloudsql_instance"
        );
        assert_eq!(
            class("Cloud SQL Admin API: 403 Cloud SQL Admin API has not been used in project 123 before or it is disabled.", &C).0,
            "cloudsql_api"
        );
        assert_eq!(
            class("Google login: No gcloud login on this computer. Run `gcloud auth application-default login`, then try again", &C),
            (
                "cloudsql_login",
                Some("No gcloud login on this computer. Run `gcloud auth application-default login`, then try again.".into()),
                Some("account")
            )
        );
        assert_eq!(
            class("Cloud SQL: orders-prd at 10.0.0.3:3307 did not answer in 10 s", &C),
            (
                "cloudsql_unreachable",
                Some("orders-prd didn't answer on port 3307. A private or PSC address only answers inside its network.".into()),
                Some("ipType")
            )
        );
        assert_eq!(
            class(
                "Cloud SQL: orders-prd has no public IP. Pick Private or PSC under Advanced",
                &C
            )
            .2,
            Some("ipType")
        );
        // Through the connector, Postgres's own refusals keep their classes.
        assert_eq!(
            class("Postgres rejected password for 'app_rw'", &C).0,
            "auth"
        );
        assert_eq!(
            class(
                "Cloud SQL: orders-prd took the connection but Postgres did not answer in 10 s",
                &C
            )
            .0,
            "cloudsql"
        );
    }
}
