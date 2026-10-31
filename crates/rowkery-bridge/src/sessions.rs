//! The Sessions tab: the server's sessions read on a session of the window's
//! own (never a tab's, so a tab's transaction is never touched), and
//! stopping one through safe mode. The Health tab reads on the same session.
//! MySQL and MariaDB windows have the Sessions tab too; Health is Postgres
//! and SQLite only for now.

use rowkery_core::connections::{MysqlConnection, PostgresConnection};
use rowkery_core::db::mysql::{self, MysqlSession};
use rowkery_core::db::postgres::{
    session_activity, session_cancel_tagged, session_health, session_locks_held, session_stop,
    HeldLock, PostgresSession, ServerSession, StopKind,
};
use rowkery_core::db::DriverError;
use rowkery_core::health::HealthReport;
use rowkery_core::safety::SafeMode;
use serde::{Deserialize, Serialize};

use crate::mysql::MysqlSlot;
use crate::pool::{self, Lease, SharedPool, Slot};

/// A server session, and the Rowkery tab it belongs to when it's one of ours.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct SessionRow {
    #[serde(flatten)]
    pub session: ServerSession,
    pub tab: Option<SessionTab>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct SessionTab {
    pub window_id: String,
    pub tab_id: u64,
}

/// What a stop did.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "status", rename_all = "snake_case")]
pub enum StopOutcome {
    /// Signalled; `gone` when the session had already ended.
    Stopped { gone: bool },
    /// Waits for the user to confirm exactly `sql`.
    Held { sql: String },
    /// Safe mode refuses it.
    Refused { message: String },
}

pub(crate) const READ_ONLY: &str =
    "This connection is read-only, so its sessions can't be stopped from Rowkery.";

/// What safe mode does with a stop. Ending a session always asks first: it
/// rolls back someone's open transaction, which no Undo can bring back.
/// `sql` is what the stop runs, for Review SQL.
pub(crate) fn stop_gate(
    mode: SafeMode,
    kind: StopKind,
    sql: String,
    confirmed: bool,
) -> Option<StopOutcome> {
    if mode == SafeMode::ReadOnly {
        return Some(StopOutcome::Refused {
            message: READ_ONLY.into(),
        });
    }
    if !confirmed && (mode == SafeMode::Confirm || kind == StopKind::End) {
        return Some(StopOutcome::Held { sql });
    }
    None
}

/// The window a Sessions call is for, and how to reach its server.
pub(crate) struct Target {
    pub pool: SharedPool,
    pub window_id: String,
    pub generation: u64,
    pub connection_id: String,
    pub config: PostgresConnection,
}

impl Target {
    /// Runs `work` on the window's Sessions session, then parks it again.
    async fn on_session<T>(
        self,
        work: impl AsyncFnOnce(&PostgresSession) -> Result<T, DriverError>,
    ) -> Result<T, DriverError> {
        let Lease { session, .. } = pool::lease(
            &self.pool,
            &self.window_id,
            Slot::Monitor,
            self.generation,
            self.connection_id,
            self.config,
        )
        .await?;
        let done = work(&session).await;
        pool::give_back(
            &self.pool,
            &self.window_id,
            Slot::Monitor,
            self.generation,
            session,
        );
        done
    }
}

/// Every other client session on the window's database, with ours labelled.
pub(crate) async fn list(target: Target) -> Result<Vec<SessionRow>, DriverError> {
    let pool = target.pool.clone();
    let read = target
        .on_session(async |s| session_activity(s).await)
        .await?;
    Ok(label_tabs(&pool, None, read))
}

/// Joins each server session to the Rowkery tab whose tag it carries;
/// with `window`, only that window's tabs.
fn label_tabs<S: pool::PoolSession>(
    pool: &SharedPool<S>,
    window: Option<&str>,
    read: Vec<ServerSession>,
) -> Vec<SessionRow> {
    let mut tabs = pool.lock().map(|p| p.tag_tabs()).unwrap_or_default();
    if let Some(window) = window {
        tabs.retain(|_, (w, _)| w == window);
    }
    read.into_iter()
        .map(|session| {
            let tab = session
                .rowkery_tag
                .as_deref()
                .and_then(|t| tabs.get(t))
                .map(|(window_id, tab_id)| SessionTab {
                    window_id: window_id.clone(),
                    tab_id: *tab_id,
                });
            SessionRow { session, tab }
        })
        .collect()
}

/// A MySQL window's Sessions call: its pool and how to reach its server.
pub(crate) struct MysqlTarget {
    pub slot: MysqlSlot,
    pub connection_id: String,
    pub config: MysqlConnection,
}

impl MysqlTarget {
    /// Runs `work` on the window's Sessions session, then parks it again.
    async fn on_session<T>(
        self,
        work: impl AsyncFnOnce(&mut MysqlSession) -> Result<T, DriverError>,
    ) -> Result<T, DriverError> {
        let MysqlSlot {
            pool,
            window_id,
            generation,
        } = self.slot;
        let Lease { mut session, .. } = pool::lease(
            &pool,
            &window_id,
            Slot::Monitor,
            generation,
            self.connection_id,
            self.config,
        )
        .await?;
        let done = work(&mut session).await;
        pool::give_back(&pool, &window_id, Slot::Monitor, generation, session);
        done
    }
}

/// Every other session this login may see on the server, ours labelled.
pub(crate) async fn mysql_list(target: MysqlTarget) -> Result<Vec<SessionRow>, DriverError> {
    let pool = target.slot.pool.clone();
    let window = target.slot.window_id.clone();
    let read = target
        .on_session(async |s| mysql::session_activity(s).await)
        .await?;
    // A MySQL id is only unique on its server, and other windows may be on
    // other servers: only this window's tabs are named.
    Ok(label_tabs(&pool, Some(&window), read))
}

/// Stops session `id` (`KILL QUERY` / `KILL`) once safe mode allows it.
pub(crate) async fn mysql_stop(
    target: MysqlTarget,
    id: i32,
    kind: StopKind,
    confirmed: bool,
) -> Result<StopOutcome, DriverError> {
    if let Some(gated) = stop_gate(target.config.safe_mode, kind, kind.mysql_sql(id), confirmed) {
        return Ok(gated);
    }
    let sent = target
        .on_session(async |s| mysql::session_stop(s, id, kind).await)
        .await?;
    Ok(StopOutcome::Stopped { gone: !sent })
}

/// The database's health, for the Health tab.
pub(crate) async fn health(target: Target) -> Result<HealthReport, DriverError> {
    target.on_session(async |s| session_health(s).await).await
}

pub(crate) async fn locks(target: Target, pid: i32) -> Result<Vec<HeldLock>, DriverError> {
    target
        .on_session(async |s| session_locks_held(s, pid).await)
        .await
}

/// Stops `pid` once safe mode allows it.
pub(crate) async fn stop(
    target: Target,
    pid: i32,
    kind: StopKind,
    confirmed: bool,
) -> Result<StopOutcome, DriverError> {
    if let Some(gated) = stop_gate(target.config.safe_mode, kind, kind.sql(pid), confirmed) {
        return Ok(gated);
    }
    let sent = target
        .on_session(async |s| session_stop(s, pid, kind).await)
        .await?;
    Ok(StopOutcome::Stopped { gone: !sent })
}

/// After a force stop closed a tab's session: cancels what the server still
/// runs for it (by the session's tag), on the window's Sessions session. Not
/// through safe mode: it only stops what the user already stopped.
pub(crate) async fn cancel_stopped(target: Target, tag: String) -> Result<bool, DriverError> {
    target
        .on_session(async |s| session_cancel_tagged(s, &tag).await)
        .await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn safe_mode_gates_stops() {
        use StopKind::*;
        let held = |kind: StopKind| Some(StopOutcome::Held { sql: kind.sql(7) });
        let gate = |mode, kind: StopKind, confirmed| stop_gate(mode, kind, kind.sql(7), confirmed);
        assert_eq!(gate(SafeMode::Off, Cancel, false), None);
        assert_eq!(gate(SafeMode::Off, End, false), held(End));
        assert_eq!(gate(SafeMode::Off, End, true), None);
        assert_eq!(gate(SafeMode::Confirm, Cancel, false), held(Cancel));
        assert_eq!(gate(SafeMode::Confirm, Cancel, true), None);
        for kind in [Cancel, End] {
            assert!(matches!(
                gate(SafeMode::ReadOnly, kind, true),
                Some(StopOutcome::Refused { .. })
            ));
        }
    }
}
