//! The Sessions tab: the server's sessions read on a session of the window's
//! own (never a tab's, so a tab's transaction is never touched), and
//! stopping one through safe mode.

use rowkery_core::connections::PostgresConnection;
use rowkery_core::db::postgres::{
    session_activity, session_locks_held, session_stop, HeldLock, PostgresSession, ServerSession,
    StopKind,
};
use rowkery_core::db::DriverError;
use rowkery_core::safety::SafeMode;
use serde::{Deserialize, Serialize};

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
pub(crate) fn stop_gate(
    mode: SafeMode,
    pid: i32,
    kind: StopKind,
    confirmed: bool,
) -> Option<StopOutcome> {
    if mode == SafeMode::ReadOnly {
        return Some(StopOutcome::Refused {
            message: READ_ONLY.into(),
        });
    }
    if !confirmed && (mode == SafeMode::Confirm || kind == StopKind::End) {
        return Some(StopOutcome::Held { sql: kind.sql(pid) });
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
    let tabs = pool.lock().map(|p| p.tag_tabs()).unwrap_or_default();
    Ok(read
        .into_iter()
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
        .collect())
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
    if let Some(gated) = stop_gate(target.config.safe_mode, pid, kind, confirmed) {
        return Ok(gated);
    }
    let sent = target
        .on_session(async |s| session_stop(s, pid, kind).await)
        .await?;
    Ok(StopOutcome::Stopped { gone: !sent })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn safe_mode_gates_stops() {
        use StopKind::*;
        let held = |kind: StopKind| Some(StopOutcome::Held { sql: kind.sql(7) });
        assert_eq!(stop_gate(SafeMode::Off, 7, Cancel, false), None);
        assert_eq!(stop_gate(SafeMode::Off, 7, End, false), held(End));
        assert_eq!(stop_gate(SafeMode::Off, 7, End, true), None);
        assert_eq!(stop_gate(SafeMode::Confirm, 7, Cancel, false), held(Cancel));
        assert_eq!(stop_gate(SafeMode::Confirm, 7, Cancel, true), None);
        for kind in [Cancel, End] {
            assert!(matches!(
                stop_gate(SafeMode::ReadOnly, 7, kind, true),
                Some(StopOutcome::Refused { .. })
            ));
        }
    }
}
