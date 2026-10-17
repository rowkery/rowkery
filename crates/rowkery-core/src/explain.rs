//! Why a connection failed, in one sentence: the error class read from the
//! raw text (Postgres, the OS or the SSH tunnel), the cause the panel shows
//! above the raw text, and which field of the connection sheet to mark.

use serde::Serialize;

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct ConnectExplanation {
    /// `refused`, `timeout`, `dns`, `tls`, `auth`, `database`, `role`,
    /// `ssh_changed`, `ssh_unknown`, `ssh_timeout`, `ssh_auth` or `unknown`.
    pub class: &'static str,
    /// The one-line cause; none for `unknown` (the raw text stands alone).
    pub cause: Option<String>,
    /// The sheet field to focus and mark: `host`, `database`, `username`,
    /// `password`, `ssl`, `sshHost`, `sshPassword`.
    pub field: Option<&'static str>,
}

/// What the panel needs to say about the connection, beyond the raw text.
pub struct Target<'a> {
    pub host: &'a str,
    pub port: u16,
    pub username: &'a str,
    pub ssh_host: Option<&'a str>,
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

#[cfg(test)]
mod tests {
    use super::*;

    const T: Target = Target {
        host: "db.internal",
        port: 5432,
        username: "app",
        ssh_host: None,
    };
    const S: Target = Target {
        host: "10.0.0.5",
        port: 5432,
        username: "app",
        ssh_host: Some("bastion.internal"),
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
    }
}
