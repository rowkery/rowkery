//! Saved connection records (SQLite + Postgres).

use serde::{Deserialize, Serialize};

use crate::safety::SafeMode;
use crate::secrets::ConnectionSecrets;

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "lowercase")]
pub enum ConnectionRecord {
    Sqlite(SqliteConnection),
    Postgres(PostgresConnection),
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct SqliteConnection {
    pub id: String,
    pub name: String,
    pub path: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub environment: Option<ConnectionEnvironment>,
    /// Whether writes run, wait for confirmation, or are refused. Separate
    /// from `environment`, which is only a label.
    #[serde(default, skip_serializing_if = "SafeMode::is_off")]
    pub safe_mode: SafeMode,
    /// The bundled sample database (`sample.rs`): listed under its own
    /// heading, recreated by "Open the sample database".
    #[serde(default, skip_serializing_if = "is_false")]
    pub sample: bool,
    /// Whether the MCP server (`Rowkery --mcp`) may list and read this
    /// connection. Off until the user turns it on; never set from
    /// `environment`.
    #[serde(default, skip_serializing_if = "is_false")]
    pub allow_mcp: bool,
    /// Tables the MCP server keeps from agents (`schema.table`; SQLite `main.table`).
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub mcp_hidden_tables: Vec<String>,
    /// Sharing ends at this Unix time in ms; none shares until turned off.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub mcp_until: Option<u64>,
    /// Don't keep the 24 h result samples (`rowkery_mcp::samples`) for this connection.
    #[serde(default, skip_serializing_if = "is_false")]
    pub mcp_samples_off: bool,
    /// Which databases agents may reach and, in each, which tables. None is a
    /// connection set up before this map existed: every database, minus
    /// `mcp_hidden_tables` (`rowkery_mcp::access`).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub mcp_access: Option<McpAccess>,
    /// Columns marked sensitive, per database name (SQLite `main`), as
    /// `schema.table.column`. Agents only ever get a stand-in for them
    /// (`rowkery_mcp::mask`) and Presenting hides them on screen.
    #[serde(default, skip_serializing_if = "MaskedColumns::is_empty")]
    pub masked_columns: MaskedColumns,
}

/// Per database name (SQLite: `main`): how its tables are shared. A
/// database with no entry is not shared.
pub type McpAccess = std::collections::BTreeMap<String, McpDbAccess>;

/// Per database name: its sensitive columns as `schema.table.column`.
pub type MaskedColumns = std::collections::BTreeMap<String, Vec<String>>;

#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct McpDbAccess {
    pub mode: McpTableMode,
    /// `schema.table` (SQLite `main.table`): the shared ones under `Picked`,
    /// the hidden ones under `All`.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub tables: Vec<String>,
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum McpTableMode {
    /// Only the listed tables; one created later stays hidden ("Only ticked").
    #[default]
    Picked,
    /// Every table but the listed ones ("All but unticked").
    All,
}

fn is_false(b: &bool) -> bool {
    !*b
}

fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

/// Which deployment a connection points at. The UI colours it (prd red,
/// stg orange, dev blue, local green) so production is hard to miss.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ConnectionEnvironment {
    Prd,
    Stg,
    Dev,
    Local,
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum PostgresSslMode {
    /// Plaintext.
    Disable,
    /// TLS when the server offers it, plaintext otherwise. The certificate is
    /// not checked, as in libpq.
    #[default]
    Prefer,
    /// TLS or no connection. The certificate is not checked, as in libpq.
    Require,
    /// TLS with the certificate checked against the system trust store (or
    /// `ssl_root_cert` when set) and the host name, like libpq's verify-full.
    Verify,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum SshAuthMethod {
    KeyFile,
    Password,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct SshConfig {
    pub host: String,
    pub port: u16,
    pub username: String,
    pub auth_method: SshAuthMethod,
    #[serde(default)]
    pub private_key_path: Option<String>,
    /// When true, unknown host keys are stored on successful test/connect.
    #[serde(default)]
    pub trust_host: bool,
}

/// Which of a Cloud SQL instance's addresses to dial.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum CloudSqlIpType {
    #[default]
    Public,
    Private,
    /// Private Service Connect: the instance's PSC DNS name.
    Psc,
}

/// Where the Google token for a Cloud SQL connection comes from.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum CloudSqlCredentials {
    /// The gcloud login on this machine (Application Default Credentials),
    /// read from gcloud's own file and never copied.
    #[default]
    Gcloud,
    /// A service account key file, kept in the keychain (`SecretKind::GcpKey`).
    Key,
}

/// A Postgres instance on Google Cloud SQL, reached through its connector
/// protocol (`cloudsql`): no proxy process and no local port.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct CloudSqlConfig {
    /// `project:region:instance`, as the console's "Connection name".
    pub instance: String,
    #[serde(default)]
    pub ip_type: CloudSqlIpType,
    #[serde(default)]
    pub credentials: CloudSqlCredentials,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct PostgresConnection {
    pub id: String,
    pub name: String,
    pub host: String,
    pub port: u16,
    pub database: String,
    pub username: String,
    #[serde(default)]
    pub ssl_mode: PostgresSslMode,
    /// PEM file of the CA that signs the server certificate, for `Verify`
    /// against a private CA (AWS RDS, self-hosted). `~/` is expanded.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub ssl_root_cert: Option<String>,
    #[serde(default)]
    pub ssh: Option<SshConfig>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub environment: Option<ConnectionEnvironment>,
    /// Whether writes run, wait for confirmation, or are refused. Separate
    /// from `environment`, which is only a label.
    #[serde(default, skip_serializing_if = "SafeMode::is_off")]
    pub safe_mode: SafeMode,
    /// Whether the MCP server (`Rowkery --mcp`) may list and read this
    /// connection. Off until the user turns it on; never set from
    /// `environment`.
    #[serde(default, skip_serializing_if = "is_false")]
    pub allow_mcp: bool,
    /// Tables the MCP server keeps from agents (`schema.table`; SQLite `main.table`).
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub mcp_hidden_tables: Vec<String>,
    /// Sharing ends at this Unix time in ms; none shares until turned off.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub mcp_until: Option<u64>,
    /// Don't keep the 24 h result samples (`rowkery_mcp::samples`) for this connection.
    #[serde(default, skip_serializing_if = "is_false")]
    pub mcp_samples_off: bool,
    /// Which databases agents may reach and, in each, which tables. None is a
    /// connection set up before this map existed: every database, minus
    /// `mcp_hidden_tables` (`rowkery_mcp::access`).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub mcp_access: Option<McpAccess>,
    /// Columns marked sensitive, per database name (SQLite `main`), as
    /// `schema.table.column`. Agents only ever get a stand-in for them
    /// (`rowkery_mcp::mask`) and Presenting hides them on screen.
    #[serde(default, skip_serializing_if = "MaskedColumns::is_empty")]
    pub masked_columns: MaskedColumns,
}

impl ConnectionRecord {
    pub fn id(&self) -> &str {
        match self {
            ConnectionRecord::Sqlite(c) => &c.id,
            ConnectionRecord::Postgres(c) => &c.id,
        }
    }

    pub fn display_name(&self) -> &str {
        match self {
            ConnectionRecord::Sqlite(c) => &c.name,
            ConnectionRecord::Postgres(c) => &c.name,
        }
    }

    pub fn engine_label(&self) -> &'static str {
        match self {
            ConnectionRecord::Sqlite(_) => "sqlite",
            ConnectionRecord::Postgres(_) => "postgres",
        }
    }

    pub fn environment(&self) -> Option<ConnectionEnvironment> {
        match self {
            ConnectionRecord::Sqlite(c) => c.environment,
            ConnectionRecord::Postgres(c) => c.environment,
        }
    }

    pub fn safe_mode(&self) -> SafeMode {
        match self {
            ConnectionRecord::Sqlite(c) => c.safe_mode,
            ConnectionRecord::Postgres(c) => c.safe_mode,
        }
    }

    /// Shared with the MCP server now: Allow MCP is on and any time limit
    /// hasn't passed.
    pub fn allow_mcp(&self) -> bool {
        let (on, until) = match self {
            ConnectionRecord::Sqlite(c) => (c.allow_mcp, c.mcp_until),
            ConnectionRecord::Postgres(c) => (c.allow_mcp, c.mcp_until),
        };
        on && until.is_none_or(|t| now_ms() < t)
    }

    /// Whether the MCP server keeps a short sample of each result (on unless turned off).
    pub fn mcp_samples(&self) -> bool {
        match self {
            ConnectionRecord::Sqlite(c) => !c.mcp_samples_off,
            ConnectionRecord::Postgres(c) => !c.mcp_samples_off,
        }
    }

    /// Tables kept from agents, as `schema.table`.
    pub fn mcp_hidden_tables(&self) -> &[String] {
        match self {
            ConnectionRecord::Sqlite(c) => &c.mcp_hidden_tables,
            ConnectionRecord::Postgres(c) => &c.mcp_hidden_tables,
        }
    }

    /// The databases and tables shared with agents; None for a connection
    /// saved before this existed (see `mcp_access` on the record).
    pub fn mcp_access(&self) -> Option<&McpAccess> {
        match self {
            ConnectionRecord::Sqlite(c) => c.mcp_access.as_ref(),
            ConnectionRecord::Postgres(c) => c.mcp_access.as_ref(),
        }
    }

    /// The sensitive columns of `database`, as `schema.table.column`.
    pub fn masked_columns(&self, database: &str) -> &[String] {
        let map = match self {
            ConnectionRecord::Sqlite(c) => &c.masked_columns,
            ConnectionRecord::Postgres(c) => &c.masked_columns,
        };
        map.get(database).map(Vec::as_slice).unwrap_or(&[])
    }

    pub fn uses_ssh(&self) -> bool {
        match self {
            ConnectionRecord::Sqlite(_) => false,
            ConnectionRecord::Postgres(c) => c.ssh.is_some(),
        }
    }
}

/// `~/x` → `$HOME/x`. Paths typed in the UI (key files, SQLite files) use it.
pub fn expand_home(path: &str) -> std::path::PathBuf {
    let rest = if path == "~" {
        Some("")
    } else {
        path.strip_prefix("~/")
    };
    match (rest, std::env::var_os("HOME")) {
        (Some(rest), Some(home)) => std::path::Path::new(&home).join(rest),
        _ => std::path::PathBuf::from(path),
    }
}

/// Per-field validation messages for the Postgres connection form.
#[derive(Debug, Clone, Default)]
pub struct PostgresFieldErrors {
    pub name: Option<String>,
    pub host: Option<String>,
    pub port: Option<String>,
    pub database: Option<String>,
    pub username: Option<String>,
    pub ssh_host: Option<String>,
    pub ssh_user: Option<String>,
    pub ssh_key_path: Option<String>,
    pub ssh_password: Option<String>,
}

impl PostgresFieldErrors {
    pub fn any(&self) -> bool {
        self.name.is_some()
            || self.host.is_some()
            || self.port.is_some()
            || self.database.is_some()
            || self.username.is_some()
            || self.ssh_host.is_some()
            || self.ssh_user.is_some()
            || self.ssh_key_path.is_some()
            || self.ssh_password.is_some()
    }

    pub fn first_message(&self) -> Option<String> {
        [
            &self.name,
            &self.host,
            &self.port,
            &self.database,
            &self.username,
            &self.ssh_host,
            &self.ssh_user,
            &self.ssh_key_path,
            &self.ssh_password,
        ]
        .into_iter()
        .find_map(|m| m.clone())
    }
}

pub fn validate_postgres_fields(
    pg: &PostgresConnection,
    secrets: &ConnectionSecrets,
) -> PostgresFieldErrors {
    let mut errors = PostgresFieldErrors::default();
    if pg.name.trim().is_empty() {
        errors.name = Some("Name is required".into());
    }
    if pg.host.trim().is_empty() {
        errors.host = Some("Host is required".into());
    }
    if pg.port == 0 {
        errors.port = Some("Port is required".into());
    }
    if pg.database.trim().is_empty() {
        errors.database = Some("Database is required".into());
    }
    if pg.username.trim().is_empty() {
        errors.username = Some("Username is required".into());
    }
    if let Some(ssh) = &pg.ssh {
        if ssh.host.trim().is_empty() {
            errors.ssh_host = Some("Bastion host is required when SSH tunnel is enabled".into());
        }
        if ssh.username.trim().is_empty() {
            errors.ssh_user = Some("SSH user is required when SSH tunnel is enabled".into());
        }
        match ssh.auth_method {
            SshAuthMethod::KeyFile => {
                let has_key = ssh
                    .private_key_path
                    .as_ref()
                    .is_some_and(|p| !p.trim().is_empty());
                if !has_key {
                    errors.ssh_key_path = Some(
                        "Private key path is required when SSH tunnel uses key authentication"
                            .into(),
                    );
                }
            }
            SshAuthMethod::Password => {
                let has_pw = secrets
                    .ssh_password
                    .as_ref()
                    .is_some_and(|p| !p.trim().is_empty());
                if !has_pw {
                    errors.ssh_password = Some(
                        "SSH password is required when SSH tunnel uses password authentication"
                            .into(),
                    );
                }
            }
        }
    }
    errors
}

/// Validate connection fields before save/connect (UI-friendly messages).
pub fn validate_postgres_connect(
    pg: &PostgresConnection,
    secrets: &ConnectionSecrets,
) -> Result<(), String> {
    let errors = validate_postgres_fields(pg, secrets);
    if let Some(msg) = errors.first_message() {
        Err(msg)
    } else {
        Ok(())
    }
}

/// `validate_postgres_connect` for a saved connection about to be opened: its
/// secrets live in the keychain and are read when the session opens (off the
/// core thread), so only the fields are checked here. A missing SSH password
/// still fails, at the tunnel, with its own message.
pub fn validate_postgres_target(pg: &PostgresConnection) -> Result<(), String> {
    let mut errors = validate_postgres_fields(pg, &ConnectionSecrets::default());
    errors.ssh_password = None;
    match errors.first_message() {
        Some(msg) => Err(msg),
        None => Ok(()),
    }
}

#[cfg(test)]
mod validate_tests {
    use super::*;

    #[test]
    fn a_saved_ssh_password_connection_can_be_opened() {
        let pg = PostgresConnection {
            allow_mcp: false,
            mcp_hidden_tables: Vec::new(),
            mcp_until: None,
            mcp_samples_off: false,
            mcp_access: None,
            masked_columns: Default::default(),
            id: "p".into(),
            name: "p".into(),
            host: "db".into(),
            port: 5432,
            database: "d".into(),
            username: "u".into(),
            ssl_mode: PostgresSslMode::Disable,
            ssl_root_cert: None,
            ssh: Some(SshConfig {
                host: "bastion".into(),
                port: 22,
                username: "u".into(),
                auth_method: SshAuthMethod::Password,
                private_key_path: None,
                trust_host: false,
            }),
            environment: None,
            safe_mode: Default::default(),
        };
        // The password is in the keychain, not in hand: opening must not refuse.
        assert!(validate_postgres_connect(&pg, &ConnectionSecrets::default()).is_err());
        assert_eq!(validate_postgres_target(&pg), Ok(()));
        let mut no_host = pg.clone();
        no_host.host = String::new();
        assert!(validate_postgres_target(&no_host).is_err());
    }

    #[test]
    fn expands_home_prefix_only() {
        let home = std::env::var("HOME").expect("HOME");
        assert_eq!(
            expand_home("~/.ssh/id_ed25519"),
            std::path::Path::new(&home).join(".ssh/id_ed25519")
        );
        assert_eq!(
            expand_home("/tmp/a~b"),
            std::path::PathBuf::from("/tmp/a~b")
        );
        assert_eq!(expand_home("~user/x"), std::path::PathBuf::from("~user/x"));
    }

    #[test]
    fn environment_round_trips_and_defaults_to_none() {
        let old = r#"{"kind":"sqlite","id":"s1","name":"a","path":"/tmp/a.db"}"#;
        let rec: ConnectionRecord = serde_json::from_str(old).expect("old config parses");
        assert_eq!(rec.environment(), None);
        assert!(!serde_json::to_string(&rec).unwrap().contains("environment"));

        let tagged = r#"{"kind":"postgres","id":"p1","name":"db","host":"h","port":5432,
            "database":"d","username":"u","environment":"prd"}"#;
        let rec: ConnectionRecord = serde_json::from_str(tagged).expect("tagged parses");
        assert_eq!(rec.environment(), Some(ConnectionEnvironment::Prd));
        assert!(serde_json::to_string(&rec)
            .unwrap()
            .contains(r#""environment":"prd""#));
    }

    #[test]
    fn safe_mode_round_trips_and_defaults_to_off() {
        let old = r#"{"kind":"sqlite","id":"s1","name":"a","path":"/tmp/a.db"}"#;
        let rec: ConnectionRecord = serde_json::from_str(old).expect("old config parses");
        assert_eq!(rec.safe_mode(), SafeMode::Off);
        assert!(!serde_json::to_string(&rec).unwrap().contains("safe_mode"));

        let tagged = r#"{"kind":"postgres","id":"p1","name":"db","host":"h","port":5432,
            "database":"d","username":"u","safe_mode":"read_only"}"#;
        let rec: ConnectionRecord = serde_json::from_str(tagged).expect("tagged parses");
        assert_eq!(rec.safe_mode(), SafeMode::ReadOnly);
        assert!(serde_json::to_string(&rec)
            .unwrap()
            .contains(r#""safe_mode":"read_only""#));
    }

    #[test]
    fn rejects_empty_connection_name() {
        let pg = PostgresConnection {
            environment: None,
            safe_mode: Default::default(),
            allow_mcp: false,
            mcp_hidden_tables: Vec::new(),
            mcp_until: None,
            mcp_samples_off: false,
            mcp_access: None,
            masked_columns: Default::default(),
            id: "p1".into(),
            name: String::new(),
            host: "localhost".into(),
            port: 5432,
            database: "postgres".into(),
            username: "postgres".into(),
            ssl_mode: PostgresSslMode::Prefer,
            ssl_root_cert: None,
            ssh: None,
        };
        let err =
            validate_postgres_connect(&pg, &ConnectionSecrets::default()).expect_err("should fail");
        assert!(err.contains("Name"));
    }

    #[test]
    fn rejects_incomplete_ssh_tunnel() {
        let pg = PostgresConnection {
            environment: None,
            safe_mode: Default::default(),
            allow_mcp: false,
            mcp_hidden_tables: Vec::new(),
            mcp_until: None,
            mcp_samples_off: false,
            mcp_access: None,
            masked_columns: Default::default(),
            id: "p1".into(),
            name: "test".into(),
            host: "localhost".into(),
            port: 5432,
            database: "postgres".into(),
            username: "postgres".into(),
            ssl_mode: PostgresSslMode::Prefer,
            ssl_root_cert: None,
            ssh: Some(SshConfig {
                host: String::new(),
                port: 22,
                username: String::new(),
                auth_method: SshAuthMethod::KeyFile,
                private_key_path: None,
                trust_host: false,
            }),
        };
        let err =
            validate_postgres_connect(&pg, &ConnectionSecrets::default()).expect_err("should fail");
        assert!(err.contains("Bastion host"));
    }
}
