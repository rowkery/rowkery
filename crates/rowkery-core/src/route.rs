//! How a session reaches a server that isn't simply at `host:port`: an SSH
//! tunnel or the Cloud SQL connector. Shared by every network engine, so
//! each opens (or reuses) its window's tunnel the same way.

use std::sync::Arc;

use crate::cloudsql::CloudSqlDialer;
use crate::connections::SshConfig;
use crate::db::DriverError;
use crate::secrets::ConnectionSecrets;
use crate::ssh::{humanize_ssh_error, SshTunnel};

/// A window's route, shared by its sessions.
#[derive(Clone)]
pub enum Route {
    /// Through an SSH tunnel, shared with the window's other sessions (one
    /// SSH connection per window).
    Ssh(Arc<SshTunnel>),
    /// Through the Cloud SQL connector; one dialer per connection, which
    /// the route keeps alive between sessions.
    CloudSql(Arc<CloudSqlDialer>),
}

impl Route {
    /// Still usable for a new session (a tunnel can drop; a dialer renews
    /// its certificate itself).
    pub fn is_alive(&self) -> bool {
        match self {
            Self::Ssh(t) => t.is_alive(),
            Self::CloudSql(_) => true,
        }
    }

    /// The route is the kind a connection with these settings asks for.
    pub(crate) fn fits(&self, ssh: bool, cloud_sql: bool) -> bool {
        match self {
            Self::Ssh(_) => ssh,
            // Each session asks `dialer_for`, which checks the settings and
            // the key; the route only keeps the dialer alive.
            Self::CloudSql(_) => cloud_sql,
        }
    }
}

/// The tunnel to `host:port` through `ssh`: the one `reuse` holds when it
/// is a tunnel, else a new one. Its error is the one the user sees.
pub(crate) async fn ssh_tunnel(
    ssh: &SshConfig,
    reuse: Option<Route>,
    connection_id: &str,
    host: &str,
    port: u16,
    secrets: Option<&ConnectionSecrets>,
) -> Result<Arc<SshTunnel>, DriverError> {
    if let Some(Route::Ssh(tunnel)) = reuse {
        return Ok(tunnel);
    }
    SshTunnel::open_with_timeout(ssh, connection_id, host, port, secrets)
        .await
        .map(Arc::new)
        .map_err(|e| DriverError::Message(humanize_ssh_error(&e, &ssh.host)))
}
