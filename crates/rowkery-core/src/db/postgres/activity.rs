//! What's running on the server: every client session on the connection's
//! database, what it waits on and who blocks it, for the Sessions tab and
//! the agents' `sessions` tool; and stopping one.
//!
//! One read of `pg_stat_activity` (shared memory, no table reads). The
//! Postgres docs warn that `pg_blocking_pids()` briefly locks the lock
//! manager, so it runs only for sessions already waiting on a lock.

use serde::{Deserialize, Serialize};

use super::{map_query_error, PostgresSession, APP_NAME};
use crate::db::DriverError;

/// One client session on the server, as `pg_stat_activity` shows it.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct ServerSession {
    pub pid: i32,
    /// The login it runs as; `None` when the server doesn't say.
    pub user: Option<String>,
    pub application: String,
    /// The client's address; `None` over a Unix socket.
    pub client: Option<String>,
    /// `active`, `idle`, `idle in transaction`, …
    pub state: Option<String>,
    /// What it's waiting on, as `Lock: relation` or `IO: DataFileRead`.
    pub wait: Option<String>,
    /// Seconds since its transaction, its current (or last) query and its
    /// state began, measured on the server.
    pub xact_secs: Option<f64>,
    pub query_secs: Option<f64>,
    pub state_secs: Option<f64>,
    /// The query text; `None` when this login may not see it.
    pub query: Option<String>,
    /// Sessions holding the lock it waits for.
    pub blocked_by: Vec<i32>,
    /// This login may cancel or end it.
    pub can_stop: bool,
    /// The tag of a Rowkery session (see [`PostgresSession::tag`]).
    pub rowkery_tag: Option<String>,
}

/// A table lock a session holds.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct HeldLock {
    /// `schema.table`, or the oid when the table isn't in this database.
    pub table: String,
    pub mode: String,
}

const SESSIONS_SQL: &str = r"
    WITH me AS (
        SELECT r.rolsuper AS super,
               pg_has_role(current_user, 'pg_signal_backend', 'MEMBER') AS signal
        FROM pg_catalog.pg_roles r WHERE r.rolname = current_user
    )
    SELECT a.pid,
           a.usename::text,
           coalesce(a.application_name, ''),
           host(a.client_addr),
           a.state,
           CASE WHEN a.wait_event_type IS NOT NULL
                THEN a.wait_event_type || ': ' || coalesce(a.wait_event, '') END,
           extract(epoch FROM clock_timestamp() - a.xact_start)::float8,
           extract(epoch FROM clock_timestamp() - a.query_start)::float8,
           extract(epoch FROM clock_timestamp() - a.state_change)::float8,
           CASE WHEN a.query = '<insufficient privilege>' THEN NULL ELSE a.query END,
           CASE WHEN a.wait_event_type = 'Lock' THEN pg_blocking_pids(a.pid)
                ELSE '{}'::int[] END,
           coalesce(me.super
               OR (a.usesysid IS NOT NULL AND pg_has_role(current_user, a.usesysid, 'MEMBER'))
               OR (me.signal AND NOT coalesce(
                      (SELECT t.rolsuper FROM pg_catalog.pg_roles t WHERE t.oid = a.usesysid),
                      false)),
               false)
    FROM pg_catalog.pg_stat_activity a, me
    WHERE a.backend_type = 'client backend'
      AND a.datname = current_database()
      AND a.pid <> pg_backend_pid()
";

/// Every other client session on this session's database.
pub async fn session_activity(
    session: &PostgresSession,
) -> Result<Vec<ServerSession>, DriverError> {
    let rows = session
        .client
        .query(SESSIONS_SQL, &[])
        .await
        .map_err(|e| map_query_error(&e, &session.config.username))?;
    Ok(rows
        .iter()
        .map(|row| {
            let application: String = row.get(2);
            ServerSession {
                pid: row.get(0),
                user: row.get(1),
                rowkery_tag: rowkery_tag(&application).map(str::to_string),
                application,
                client: row.get(3),
                state: row.get(4),
                wait: row.get(5),
                xact_secs: row.get(6),
                query_secs: row.get(7),
                state_secs: row.get(8),
                query: row.get(9),
                blocked_by: row.get(10),
                can_stop: row.get(11),
            }
        })
        .collect())
}

/// The table locks `pid` holds.
pub async fn session_locks_held(
    session: &PostgresSession,
    pid: i32,
) -> Result<Vec<HeldLock>, DriverError> {
    let rows = session
        .client
        .query(
            r"
            SELECT coalesce(n.nspname || '.' || c.relname, l.relation::text), l.mode
            FROM pg_catalog.pg_locks l
            LEFT JOIN pg_catalog.pg_class c ON c.oid = l.relation
            LEFT JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
            WHERE l.pid = $1 AND l.granted AND l.locktype = 'relation'
              AND (n.nspname IS NULL OR n.nspname NOT IN ('pg_catalog', 'information_schema'))
            ORDER BY 1, 2
            ",
            &[&pid],
        )
        .await
        .map_err(|e| map_query_error(&e, &session.config.username))?;
    Ok(rows
        .iter()
        .map(|row| HeldLock {
            table: row.get(0),
            mode: row.get(1),
        })
        .collect())
}

/// How to stop a session.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum StopKind {
    /// Stops its statement; it stays connected.
    Cancel,
    /// Disconnects it; its open transaction rolls back.
    End,
}

impl StopKind {
    /// Exactly what runs, for Review SQL.
    pub fn sql(self, pid: i32) -> String {
        match self {
            StopKind::Cancel => format!("SELECT pg_cancel_backend({pid})"),
            StopKind::End => format!("SELECT pg_terminate_backend({pid})"),
        }
    }
}

/// Sends the signal. `Ok(false)` when the session had already gone.
pub async fn session_stop(
    session: &PostgresSession,
    pid: i32,
    kind: StopKind,
) -> Result<bool, DriverError> {
    let sql = match kind {
        StopKind::Cancel => "SELECT pg_cancel_backend($1)",
        StopKind::End => "SELECT pg_terminate_backend($1)",
    };
    let row = session
        .client
        .query_one(sql, &[&pid])
        .await
        .map_err(|e| match e.code() {
            Some(&tokio_postgres::error::SqlState::INSUFFICIENT_PRIVILEGE) => DriverError::Message(
                "Your login can't stop this session. Postgres lets you stop your own login's sessions, or anyone's with superuser or pg_signal_backend.".into(),
            ),
            _ => map_query_error(&e, &session.config.username),
        })?;
    Ok(row.get(0))
}

/// Cancels whatever the Rowkery session tagged `tag` is running, from
/// `session` (another one): after a force stop closed that session's socket,
/// the server would otherwise run its statement to the end. `Ok(false)` when
/// no such session is left.
pub async fn session_cancel_tagged(
    session: &PostgresSession,
    tag: &str,
) -> Result<bool, DriverError> {
    let row = session
        .client
        .query_one(
            "SELECT coalesce(bool_or(pg_cancel_backend(pid)), false) \
             FROM pg_catalog.pg_stat_activity WHERE application_name = $1",
            &[&format!("{APP_NAME} {tag}")],
        )
        .await
        .map_err(|e| map_query_error(&e, &session.config.username))?;
    Ok(row.get(0))
}

/// The tag in a Rowkery session's `application_name`.
pub fn rowkery_tag(application: &str) -> Option<&str> {
    application
        .strip_prefix(APP_NAME)
        .and_then(|rest| rest.strip_prefix(' '))
        .filter(|tag| tag.len() == 8 && tag.bytes().all(|b| b.is_ascii_hexdigit()))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_rowkery_tags() {
        assert_eq!(rowkery_tag("Rowkery 0a1b2c3d"), Some("0a1b2c3d"));
        assert_eq!(rowkery_tag("Rowkery"), None);
        assert_eq!(rowkery_tag("Rowkery prefetch"), None);
        assert_eq!(rowkery_tag("psql"), None);
    }

    #[test]
    fn stop_sql_is_exact() {
        assert_eq!(StopKind::Cancel.sql(42), "SELECT pg_cancel_backend(42)");
        assert_eq!(StopKind::End.sql(42), "SELECT pg_terminate_backend(42)");
    }
}
