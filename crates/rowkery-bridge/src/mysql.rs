//! MySQL and MariaDB windows: a tab's runs on its own session from the
//! window's pool, cancelled with `KILL QUERY`. A result comes whole (no
//! cursor to page through), up to [`MAX_TAB_ROWS`] rows.

use std::time::{Duration, Instant};

use rowkery_core::connections::MysqlConnection;
use rowkery_core::db::mysql::{
    self, open_session_via, session_introspect, session_probe_txn, session_query_stream, CancelVia,
    MysqlSession,
};
use rowkery_core::db::postgres::StreamStats;
use rowkery_core::db::{DriverError, SchemaCatalog};
use rowkery_core::edits::{ApplyCounts, ApplyFailure, RowStatement};
use rowkery_core::query_util::apply_browse_limit;
use rowkery_core::reach::{Name, Reach};
use rowkery_core::safety::{plain_read, Dialect};
use tokio::runtime::Handle;

use crate::pool::{self, Lease, SharedPool, Slot};
use crate::{
    arm_cancel, cancel_requested, disarm_cancel, finish_query_worker, push_event, CancelHandle,
    CancelSlot, CoreEvent, Forward, QueryOutcome, SharedSink, APPLY_STEP_TIMEOUT, CANCEL_SETTLE,
    FORCE_STOP_AFTER,
};

/// What a MySQL window can't do in this version yet.
pub(crate) const LATER: &str = "This isn't available for MySQL in this version yet.";

/// The window's pool, and which of its generations the run belongs to.
pub(crate) struct MysqlSlot {
    pub pool: SharedPool<MysqlSession>,
    pub window_id: String,
    pub generation: u64,
}

/// Every statement only reads: it can't open or end a transaction.
fn reads_only(sql: &str) -> bool {
    let checks = rowkery_core::safety::check_sql(sql, Dialect::Mysql);
    !checks.is_empty()
        && checks
            .iter()
            .all(|c| c.kind == rowkery_core::safety::StatementKind::Read)
}

/// Runs `sql` on the tab's session and streams its rows to `events`, up to
/// `cap` of them (`None`: an export, which keeps every row).
#[allow(clippy::too_many_arguments)]
pub(crate) fn run_query(
    runtime: &Handle,
    connection_id: String,
    config: MysqlConnection,
    pooled: MysqlSlot,
    query_id: u64,
    tab_id: u64,
    sql: String,
    apply_limit: Option<u32>,
    cap: Option<u64>,
    events: SharedSink,
    interrupt_slot: CancelSlot,
) {
    let start = Instant::now();
    let sql = match apply_limit {
        Some(limit) => apply_browse_limit(&sql, limit),
        None => sql,
    };
    let stop = interrupt_slot
        .lock()
        .map(|s| s.stop.clone())
        .unwrap_or_default();
    // Where the run's statement can be stopped from after a force stop
    // drops its session: the server goes on running it otherwise.
    let armed: std::sync::Arc<std::sync::Mutex<Option<CancelVia>>> = Default::default();
    let (stopped_events, stopped_slot, stopped_armed) =
        (events.clone(), interrupt_slot.clone(), armed.clone());
    let stopped_pool = (pooled.pool.clone(), pooled.window_id.clone());
    let (stopped_connection, stopped_config) = (connection_id.clone(), config.clone());
    let run = async move {
        let on_wait = |wait: Option<pool::WaitFor>| {
            if let Ok(mut state) = interrupt_slot.lock() {
                state.waiting = wait.is_some();
            }
            push_event(
                &events,
                CoreEvent::QueryWaiting {
                    query_id,
                    tab_id,
                    waiting: wait.is_some(),
                    tab: wait == Some(pool::WaitFor::Tab),
                },
            );
        };
        let may_open = !reads_only(&sql);
        let changes_session = rowkery_core::safety::check_sql(&sql, Dialect::Mysql)
            .iter()
            .any(|c| c.kind == rowkery_core::safety::StatementKind::Session);
        let mut attempt = 0;
        loop {
            attempt += 1;
            let leased = pool::lease_or_wait(
                &pooled.pool,
                &pooled.window_id,
                Slot::Tab(tab_id),
                pooled.generation,
                connection_id.clone(),
                config.clone(),
                &on_wait,
            )
            .await;
            let Lease {
                mut session,
                reused,
                mut out,
            } = match leased {
                Ok(lease) => lease,
                Err(err) => {
                    finish_query_worker(Err(err.into()), query_id, tab_id, start, &events);
                    disarm_cancel(&interrupt_slot);
                    return;
                }
            };
            let via = session.cancel_via();
            if let Ok(mut a) = armed.lock() {
                *a = Some(via.clone());
            }
            if !arm_cancel(&interrupt_slot, CancelHandle::Mysql(via)) {
                finish_query_worker(
                    Ok(QueryOutcome::cancelled(0)),
                    query_id,
                    tab_id,
                    start,
                    &events,
                );
                disarm_cancel(&interrupt_slot);
                pool::give_back(
                    &pooled.pool,
                    &pooled.window_id,
                    Slot::Tab(tab_id),
                    pooled.generation,
                    session,
                );
                drop(out);
                return;
            }
            if may_open {
                out.may_open_transaction();
            }
            let mut fwd = Forward::new(&events, query_id, tab_id, cap);
            let mut first_row = None;
            let streamed = session_query_stream(&mut session, &sql, |batch, first| {
                if first_row.is_none() && !batch.rows.is_empty() {
                    first_row = Some(start.elapsed());
                }
                fwd.batch(batch, first);
                Ok(())
            })
            .await;
            let sent_rows = fwd.had_result_set;
            let result = fwd.outcome(streamed.map(|rows| StreamStats { rows, first_row }));
            // A warm session whose socket died while parked fails before
            // anything ran: once more on a fresh one, for a plain read only,
            // and never when it may have held the user's transaction.
            if result.is_err()
                && reused
                && attempt == 1
                && !sent_rows
                && session.is_closed()
                && session.txn_known() == Some(false)
                && plain_read(&sql, Dialect::Mysql)
            {
                disarm_cancel(&interrupt_slot);
                if cancel_requested(&interrupt_slot) {
                    finish_query_worker(
                        Ok(QueryOutcome::cancelled(0)),
                        query_id,
                        tab_id,
                        start,
                        &events,
                    );
                    return;
                }
                continue;
            }
            let cancelled = disarm_cancel(&interrupt_slot);
            finish_query_worker(result, query_id, tab_id, start, &events);
            if cancelled {
                // The KILL may still be on its way: the tab's next run waits
                // until it has landed, so it can't stop that run instead.
                let sent = interrupt_slot
                    .lock()
                    .map(|s| s.sent.clone())
                    .unwrap_or_default();
                let pool = pooled.pool.clone();
                let (window_id, generation) = (pooled.window_id.clone(), pooled.generation);
                tokio::spawn(async move {
                    keep_after_cancel(&pool, &window_id, tab_id, generation, session, &sent).await;
                    drop(out);
                });
            } else {
                if changes_session {
                    session.note_state();
                }
                // An error says nothing of the transaction: ask, so a tab's
                // open one is never taken for none.
                pool::settle_txn(&mut session).await;
                pool::give_back(
                    &pooled.pool,
                    &pooled.window_id,
                    Slot::Tab(tab_id),
                    pooled.generation,
                    session,
                );
                drop(out);
            }
            return;
        }
    };
    runtime.spawn(async move {
        tokio::select! {
            biased;
            _ = run => {}
            _ = stop.notified() => {
                // The run, its session and any transaction in it (the
                // server rolls it back) are dropped here.
                let waited = stopped_slot
                    .lock()
                    .map(|mut s| std::mem::take(&mut s.waiting))
                    .unwrap_or_default();
                finish_query_worker(
                    Ok(QueryOutcome {
                        forced: !waited,
                        ..QueryOutcome::cancelled(0)
                    }),
                    query_id,
                    tab_id,
                    start,
                    &stopped_events,
                );
                if waited {
                    return;
                }
                let via = stopped_armed.lock().ok().and_then(|mut a| a.take());
                if let Some(via) = via {
                    tokio::spawn(async move {
                        let _ = tokio::time::timeout(FORCE_STOP_AFTER * 5, mysql::cancel(via)).await;
                    });
                }
                let (pool, window_id) = stopped_pool;
                pool::ping_idle(&pool, &window_id, Duration::ZERO, stopped_connection, stopped_config)
                    .await;
            }
        }
    });
}

/// After a cancelled run: once the `KILL QUERY` has gone, asks the session
/// what the statement left and parks it. A kill that landed after the
/// statement had ended stops this question instead, so it is asked once
/// more. A session that doesn't answer is dropped, and the tab's next
/// statement says its transaction was lost if it may have had one.
async fn keep_after_cancel(
    pool: &SharedPool<MysqlSession>,
    window_id: &str,
    tab_id: u64,
    generation: u64,
    mut session: MysqlSession,
    sent: &tokio::sync::Notify,
) {
    let _ = tokio::time::timeout(FORCE_STOP_AFTER, sent.notified()).await;
    tokio::time::sleep(CANCEL_SETTLE).await;
    let mut answered = false;
    for _ in 0..2 {
        if session.is_closed() {
            break;
        }
        if session_probe_txn(&mut session, pool::PROBE_TIMEOUT)
            .await
            .is_some()
        {
            answered = true;
            break;
        }
    }
    if answered {
        pool::give_back(pool, window_id, Slot::Tab(tab_id), generation, session);
    } else {
        pool::drop_lost(pool, window_id, Slot::Tab(tab_id), session);
    }
}

/// The catalog and what the server said it is, from a new session that is
/// then kept as the window's spare.
pub(crate) async fn open_window(
    slot: MysqlSlot,
    connection_id: String,
    config: MysqlConnection,
) -> Result<(SchemaCatalog, String, mysql::Flavor), DriverError> {
    let mut session = open_session_via(connection_id, config, None, None).await?;
    let catalog = session_introspect(&mut session).await?;
    let (version, flavor) = (session.version().to_string(), session.flavor());
    pool::give_back(
        &slot.pool,
        &slot.window_id,
        Slot::Spare,
        slot.generation,
        session,
    );
    Ok((catalog, version, flavor))
}

/// The catalog again, on the window's spare: its query tabs keep their
/// sessions and any open transaction.
pub(crate) async fn reload_schema(
    slot: MysqlSlot,
    connection_id: String,
    config: MysqlConnection,
) -> Result<SchemaCatalog, DriverError> {
    let Lease { mut session, .. } = pool::lease(
        &slot.pool,
        &slot.window_id,
        Slot::Spare,
        slot.generation,
        connection_id,
        config,
    )
    .await?;
    let catalog = session_introspect(&mut session).await;
    pool::give_back(
        &slot.pool,
        &slot.window_id,
        Slot::Spare,
        slot.generation,
        session,
    );
    catalog
}

/// Staged row edits, as one transaction on the tab's own session (waiting,
/// boundedly, for a run on it to end or for a free connection).
pub(crate) async fn apply_changes(
    slot: MysqlSlot,
    tab_id: u64,
    connection_id: String,
    config: MysqlConnection,
    table: &Name,
    statements: &[RowStatement],
    approved: Option<&Reach>,
) -> Result<Result<ApplyCounts, ApplyFailure>, String> {
    let no_room = std::sync::atomic::AtomicBool::new(false);
    let leased = tokio::time::timeout(
        APPLY_STEP_TIMEOUT,
        pool::lease_or_wait(
            &slot.pool,
            &slot.window_id,
            Slot::Tab(tab_id),
            slot.generation,
            connection_id,
            config,
            &|wait| {
                if wait == Some(pool::WaitFor::Place) {
                    no_room.store(true, std::sync::atomic::Ordering::SeqCst);
                }
            },
        ),
    )
    .await
    .unwrap_or_else(|_| {
        Err(DriverError::Message(if no_room.load(std::sync::atomic::Ordering::SeqCst) {
            "Every connection this database allows Rowkery is busy; nothing was saved. Try again once a query ends."
        } else {
            "This tab is still busy with a query; nothing was saved. Try again once it ends."
        }
        .into()))
    });
    let Lease {
        mut session,
        out: _out,
        ..
    } = leased.map_err(|e| e.into_message())?;
    let result = mysql::session_apply_changes_within(
        &mut session,
        table,
        statements,
        Some(APPLY_STEP_TIMEOUT),
        approved,
    )
    .await;
    if session.abandoned() {
        // Killed at the server with only our transaction in it.
        drop(session);
    } else if session.txn_known().is_none() || session.is_closed() {
        // It didn't say whether the user's transaction was open.
        pool::drop_lost(&slot.pool, &slot.window_id, Slot::Tab(tab_id), session);
    } else {
        pool::give_back(
            &slot.pool,
            &slot.window_id,
            Slot::Tab(tab_id),
            slot.generation,
            session,
        );
    }
    Ok(result)
}

/// A CSV import on the window's import connection (never a tab's, so never
/// inside the user's transaction).
pub(crate) async fn import_csv(
    slot: MysqlSlot,
    connection_id: String,
    config: MysqlConnection,
    spec: &rowkery_core::import::ImportSpec,
    cancel: std::sync::Arc<std::sync::atomic::AtomicBool>,
    progress: crate::ImportProgress,
) -> Result<crate::ImportOutcome, String> {
    let Lease { mut session, .. } = pool::lease(
        &slot.pool,
        &slot.window_id,
        Slot::Import,
        slot.generation,
        connection_id,
        config,
    )
    .await
    .map_err(|e| e.into_message())?;
    let result = rowkery_core::import::import_mysql(&mut session, spec, cancel, &*progress.0).await;
    if session.txn_known() == Some(false) && !session.is_closed() {
        pool::give_back(
            &slot.pool,
            &slot.window_id,
            Slot::Import,
            slot.generation,
            session,
        );
    }
    Ok(result.into())
}
