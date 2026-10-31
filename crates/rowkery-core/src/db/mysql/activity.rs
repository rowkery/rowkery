//! What's running on a MySQL or MariaDB server, for the Sessions tab: one
//! read of `information_schema.PROCESSLIST`, and stopping a session with
//! `KILL QUERY` or `KILL`.
//!
//! Without the PROCESS privilege the server shows only this login's own
//! sessions and hides its transactions (`INNODB_TRX`), so open transactions
//! and lock waits are shown only when the login may read them.

use mysql_async::prelude::Queryable;

use super::{text_rows, Flavor, MysqlSession};
use crate::db::postgres::{ServerSession, StopKind};
use crate::db::DriverError;

const SESSIONS_SQL: &str = r"
    SELECT p.ID, p.USER, p.HOST, p.COMMAND, p.TIME, p.STATE, p.INFO,
           p.USER = SUBSTRING_INDEX(CURRENT_USER(), '@', 1)
    FROM information_schema.PROCESSLIST p
    WHERE p.ID <> CONNECTION_ID()
      AND p.COMMAND NOT IN ('Daemon', 'Binlog Dump', 'Binlog Dump GTID')
      AND p.USER NOT IN ('system user', 'event_scheduler')
    ORDER BY p.ID
";

/// Each open InnoDB transaction's session and its age in seconds. Needs
/// PROCESS.
const TRX_SQL: &str = r"
    SELECT trx_mysql_thread_id, TIMESTAMPDIFF(MICROSECOND, trx_started, NOW(6)) / 1e6
    FROM information_schema.INNODB_TRX
";

/// Who waits on whom for a row lock: (waiting session, holding session).
fn waits_sql(flavor: Flavor) -> &'static str {
    match flavor {
        Flavor::Mysql => {
            r"
            SELECT r.trx_mysql_thread_id, b.trx_mysql_thread_id
            FROM performance_schema.data_lock_waits w
            JOIN information_schema.INNODB_TRX r
              ON r.trx_id = w.REQUESTING_ENGINE_TRANSACTION_ID
            JOIN information_schema.INNODB_TRX b
              ON b.trx_id = w.BLOCKING_ENGINE_TRANSACTION_ID
            "
        }
        Flavor::Mariadb => {
            r"
            SELECT r.trx_mysql_thread_id, b.trx_mysql_thread_id
            FROM information_schema.INNODB_LOCK_WAITS w
            JOIN information_schema.INNODB_TRX r ON r.trx_id = w.requesting_trx_id
            JOIN information_schema.INNODB_TRX b ON b.trx_id = w.blocking_trx_id
            "
        }
    }
}

/// May this login stop other logins' sessions (`SUPER`, or MySQL's
/// `CONNECTION_ADMIN`, MariaDB's `CONNECTION ADMIN`)? Granted directly;
/// through a role it shows as not, and the server still decides at KILL.
const ADMIN_SQL: &str = r"
    SELECT COUNT(*) FROM information_schema.USER_PRIVILEGES
    WHERE PRIVILEGE_TYPE IN ('SUPER', 'CONNECTION_ADMIN', 'CONNECTION ADMIN')
      AND GRANTEE = CONCAT('''', SUBSTRING_INDEX(CURRENT_USER(), '@', 1), '''@''',
                           SUBSTRING_INDEX(CURRENT_USER(), '@', -1), '''')
";

/// Every other client session this login may see. `rowkery_tag` is the
/// session's id, as [`MysqlSession::tag`] names Rowkery's own.
pub async fn session_activity(
    session: &mut MysqlSession,
) -> Result<Vec<ServerSession>, DriverError> {
    let rows = text_rows(session, SESSIONS_SQL).await?;
    // Optional reads: a login without PROCESS gets an error, and the list
    // goes without them.
    let trx: Vec<(i64, f64)> = text_rows(session, TRX_SQL)
        .await
        .map(|rows| {
            rows.iter()
                .filter_map(|r| Some((num(r, 0)? as i64, num(r, 1)?)))
                .collect()
        })
        .unwrap_or_default();
    let waits: Vec<(i64, i64)> = if trx.is_empty() {
        Vec::new()
    } else {
        text_rows(session, waits_sql(session.flavor()))
            .await
            .map(|rows| {
                rows.iter()
                    .filter_map(|r| Some((num(r, 0)? as i64, num(r, 1)? as i64)))
                    .collect()
            })
            .unwrap_or_default()
    };
    // A login that may read `mysql.user` sees every login's grants here.
    let admin = text_rows(session, ADMIN_SQL)
        .await
        .ok()
        .and_then(|rows| num(rows.first()?, 0))
        .is_some_and(|n| n > 0.0);
    Ok(rows
        .iter()
        .filter_map(|r| {
            let id = num(r, 0)? as i64;
            // Session ids are shared with Postgres pids (i32); an id past
            // that (two billion connections since the server started)
            // isn't shown.
            let pid = i32::try_from(id).ok()?;
            let text = |i: usize| r.get(i).cloned().flatten();
            let command = text(3).unwrap_or_default();
            let xact_secs = trx.iter().find(|(t, _)| *t == id).map(|(_, s)| *s);
            let blocked_by: Vec<i32> = waits
                .iter()
                .filter(|(w, _)| *w == id)
                .filter_map(|(_, b)| i32::try_from(*b).ok())
                .collect();
            let time = num(r, 4);
            let active = command != "Sleep";
            let state = match command.as_str() {
                "Sleep" if xact_secs.is_some() => "idle in transaction".to_string(),
                "Sleep" => "idle".to_string(),
                "Query" | "Execute" => "active".to_string(),
                other => other.to_ascii_lowercase(),
            };
            let thread_state = text(5).filter(|s| !s.is_empty());
            let wait = if !blocked_by.is_empty() {
                Some(format!(
                    "Lock: {}",
                    thread_state.as_deref().unwrap_or("row")
                ))
            } else {
                thread_state.filter(|s| active && s.starts_with("Waiting"))
            };
            Some(ServerSession {
                pid,
                user: text(1),
                application: String::new(),
                client: text(2).filter(|h| !h.is_empty()),
                state: Some(state),
                wait,
                xact_secs,
                query_secs: if active { time } else { None },
                state_secs: time,
                query: text(6),
                blocked_by,
                can_stop: admin || text(7).as_deref() == Some("1"),
                rowkery_tag: Some(id.to_string()),
            })
        })
        .collect())
}

fn num(row: &[Option<String>], i: usize) -> Option<f64> {
    row.get(i)?.as_deref()?.trim().parse().ok()
}

impl StopKind {
    /// Exactly what runs on MySQL, for Review SQL.
    pub fn mysql_sql(self, id: i32) -> String {
        match self {
            StopKind::Cancel => format!("KILL QUERY {id}"),
            StopKind::End => format!("KILL {id}"),
        }
    }
}

/// `KILL QUERY` or `KILL`. `Ok(false)` when the session had already gone.
pub async fn session_stop(
    session: &mut MysqlSession,
    id: i32,
    kind: StopKind,
) -> Result<bool, DriverError> {
    match session.conn.query_drop(kind.mysql_sql(id)).await {
        Ok(()) => Ok(true),
        // ER_NO_SUCH_THREAD.
        Err(mysql_async::Error::Server(e)) if e.code == 1094 => Ok(false),
        // ER_KILL_DENIED_ERROR.
        Err(mysql_async::Error::Server(e)) if e.code == 1095 => Err(DriverError::Message(
            "Your login can't stop this session. MySQL lets you stop your own login's sessions, or anyone's with CONNECTION_ADMIN or SUPER.".into(),
        )),
        Err(e) => Err(super::map_error(e, &session.config)),
    }
}
