//! Hover prefetch: the first page of a table the pointer rests on, read ahead
//! on the window's own prefetch session, so the click that follows shows rows
//! at once. Off unless the connection's switch is on (the webview asks).
//!
//! The prefetch is the first `FETCH` of a cursor, not a second query: each
//! table's `DECLARE … NO SCROLL CURSOR` stays open in one `READ ONLY`
//! transaction on the prefetch session, and the click that browses the same
//! SQL takes the cached first page and `FETCH`es the rest of that cursor.
//! At most [`MAX_ENTRIES`] pages are kept (oldest closed first), each for
//! [`TTL`]; any write in the window or a schema reload drops them all. One
//! prefetch is in flight at a time: a newer one, a click or the pointer
//! leaving cancels it on the server. Each prefetch runs inside a savepoint,
//! so a cancelled one leaves the other cursors open.
//!
//! The transaction holds `ACCESS SHARE` locks on what its cursors read, so it
//! never outlives them: it commits as soon as no cached page has a cursor
//! left open (a page that came back whole needs none, and stays servable from
//! memory), and at the latest [`MAX_TXN_AGE`] after it began. Nothing here
//! waits without a bound: the click gives up on the cache (and runs as usual)
//! if the session is busy, a cancel that the server doesn't hear is dropped,
//! and freshness is judged by the wall clock, which keeps running while the
//! laptop sleeps.
//!
//! The session takes one of the connection's places (`pool::MAX_SESSIONS`)
//! but never waits for one: with none free, nothing is prefetched; and a
//! query tab that needs a place closes this session when it is idle.

use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant, SystemTime};

use rowkery_core::connections::PostgresConnection;
use rowkery_core::db::postgres::{
    cancel_with_token, open_session_via, session_declare_cursor, session_execute,
    session_query_stream_with, MakeRustlsConnect, PostgresSession, StreamOptions,
};
use rowkery_core::db::{DriverError, RowBatch};
use rowkery_core::ssh::SshTunnel;
use tokio_postgres::CancelToken;

/// Rows a prefetch reads: the first `FETCH` of the cursor.
pub const PREFETCH_ROWS: u32 = 200;
/// First pages kept per window.
pub const MAX_ENTRIES: usize = 8;
/// How long a first page is good for.
pub const TTL: Duration = Duration::from_secs(30);
/// The prefetch transaction (and the locks its cursors hold) ends this long
/// after `BEGIN` at the latest, whatever is still cached.
pub const MAX_TXN_AGE: Duration = if cfg!(test) {
    Duration::from_secs(4)
} else {
    Duration::from_secs(30)
};
/// How the session shows in `pg_stat_activity`.
pub const APPLICATION_NAME: &str = "Rowkery prefetch";

/// How long a click waits for the prefetch session before running as usual.
const SERVE_WAIT: Duration = Duration::from_millis(250);
/// How long a prefetch or a sweep waits for the session.
const LOCK_WAIT: Duration = Duration::from_secs(2);
/// A cancel request that gets no answer is dropped after this.
const CANCEL_LIMIT: Duration = Duration::from_secs(1);
/// A prefetch that hasn't read its page by now gives up (and its session).
const READ_LIMIT: Duration = Duration::from_secs(10);

/// One prefetched first page and the cursor that continues it.
struct Entry {
    sql: String,
    cursor: String,
    /// The session the cursor lives on (`Held::serial`).
    serial: u64,
    batches: Vec<RowBatch>,
    /// The first `FETCH` came back full: the cursor is open and may hold more.
    /// Otherwise the page is whole and needs no session to serve.
    more: bool,
    at: Instant,
    wall: SystemTime,
}

impl Entry {
    fn fresh(&self) -> bool {
        self.at.elapsed() < TTL && within(self.wall, TTL)
    }
}

/// `since` is less than `limit` ago by the wall clock (which, unlike
/// `Instant` on macOS, counts time asleep).
fn within(since: SystemTime, limit: Duration) -> bool {
    since.elapsed().is_ok_and(|d| d < limit)
}

/// The prefetch session and the transaction its cursors live in.
#[derive(Default)]
struct Held {
    session: Option<PostgresSession>,
    /// Numbers each session opened, so an entry knows whether its cursor survives.
    serial: u64,
    in_txn: bool,
    /// When our `BEGIN READ ONLY` ran.
    began: Option<SystemTime>,
    last_used: Option<SystemTime>,
}

/// A prefetch in flight, for cancelling it.
struct InFlight {
    seq: u64,
    token: CancelToken,
    tls: Option<MakeRustlsConnect>,
}

/// One window's prefetch session and its first pages.
#[derive(Default)]
pub(crate) struct Prefetcher {
    held: tokio::sync::Mutex<Held>,
    /// Newest last.
    entries: Mutex<Vec<Entry>>,
    /// Bumped by `invalidate`: a prefetch that started before keeps nothing,
    /// and the next use rolls back the cursors left open.
    epoch: AtomicU64,
    rolled_back: AtomicU64,
    /// The newest prefetch asked for; an older one still waiting gives up.
    latest: AtomicU64,
    inflight: Mutex<Option<InFlight>>,
    /// The session is to go at the next chance (a click on it was stopped).
    doomed: AtomicBool,
    /// The window went: no session is opened again.
    closed: AtomicBool,
    /// The connection's places; `None` (tests) is no cap.
    cap: Option<Arc<tokio::sync::Semaphore>>,
}

/// What a click got from the cache: the rows it sent and how it ended.
pub(crate) type Served = Result<u64, DriverError>;

impl Prefetcher {
    /// A prefetcher whose session takes a place under `cap`.
    pub fn capped(cap: Arc<tokio::sync::Semaphore>) -> Self {
        Self {
            cap: Some(cap),
            ..Self::default()
        }
    }

    /// Its session takes a place under `cap`.
    pub fn is_under(&self, cap: &Arc<tokio::sync::Semaphore>) -> bool {
        self.cap.as_ref().is_some_and(|c| Arc::ptr_eq(c, cap))
    }

    /// A first page for `sql` is cached and fresh.
    pub fn has(&self, sql: &str) -> bool {
        self.entries
            .lock()
            .map(|e| e.iter().any(|x| x.sql == sql && x.fresh()))
            .unwrap_or(false)
    }

    /// Something in the window wrote (or the schema reloaded): no cached
    /// page may be served again.
    pub fn invalidate(&self) {
        self.epoch.fetch_add(1, Ordering::SeqCst);
        if let Ok(mut e) = self.entries.lock() {
            e.clear();
        }
    }

    /// Ends the transaction (closing every cursor and releasing its locks)
    /// after `invalidate`, cancelling a prefetch in flight first.
    pub async fn release(&self) {
        self.cancel().await;
        if let Some(mut held) = self.lock(LOCK_WAIT).await {
            self.roll_back_if_invalidated(&mut held).await;
        }
    }

    /// Cancels the prefetch in flight, if any, on the server; a cancel that
    /// gets no answer (a dead link) is given up after a second.
    pub async fn cancel(&self) {
        let taken = self.inflight.lock().ok().and_then(|mut f| f.take());
        if let Some(f) = taken {
            let _ = tokio::time::timeout(CANCEL_LIMIT, cancel_with_token(f.token, f.tls)).await;
        }
    }

    /// A click served from the cache was stopped (or hung): nothing cached
    /// is used again and the session goes, now if it is free, else as soon
    /// as whoever has it lets go. A new one opens on the next prefetch.
    pub fn abandon(&self) {
        self.invalidate();
        self.doomed.store(true, Ordering::SeqCst);
        if let Ok(mut held) = self.held.try_lock() {
            self.doomed.store(false, Ordering::SeqCst);
            self.drop_session(&mut held);
        }
    }

    /// The window closed or was re-pointed: everything goes, at once where
    /// it can (dropping the session ends its transaction and locks on the
    /// server), and no session is opened again.
    pub fn shutdown(&self) {
        self.closed.store(true, Ordering::SeqCst);
        let taken = self.inflight.lock().ok().and_then(|mut f| f.take());
        if let (Some(f), Ok(runtime)) = (taken, tokio::runtime::Handle::try_current()) {
            runtime.spawn(async move {
                let _ = tokio::time::timeout(CANCEL_LIMIT, cancel_with_token(f.token, f.tls)).await;
            });
        }
        self.abandon();
    }

    /// The window regained focus (perhaps after a sleep): a session unused
    /// for `idle` may be dead without knowing it, so it goes rather than
    /// being pinged; the next prefetch opens a fresh one. Also how a query
    /// tab takes back the place it holds. True when a session went.
    pub fn drop_if_idle(&self, idle: Duration) -> bool {
        let Ok(mut held) = self.held.try_lock() else {
            return false;
        };
        let stale = held.session.is_some()
            && held
                .last_used
                .is_none_or(|t| idle.is_zero() || !within(t, idle));
        if stale {
            self.invalidate();
            self.drop_session(&mut held);
        }
        stale
    }

    /// The session, waiting at most `wait`; `None` when it stays busy.
    async fn lock(&self, wait: Duration) -> Option<tokio::sync::MutexGuard<'_, Held>> {
        let mut held = tokio::time::timeout(wait, self.held.lock()).await.ok()?;
        if self.doomed.swap(false, Ordering::SeqCst) || self.closed.load(Ordering::SeqCst) {
            self.drop_session(&mut held);
        }
        Some(held)
    }

    /// Closes the session (the server ends its transaction), keeping only
    /// whole pages, which need none.
    fn drop_session(&self, held: &mut Held) {
        held.session = None;
        held.in_txn = false;
        held.began = None;
        if let Ok(mut e) = self.entries.lock() {
            e.retain(|x| !x.more);
        }
    }

    /// Reads the first [`PREFETCH_ROWS`] of `sql` through a cursor on the
    /// prefetch session and keeps them. `Ok(true)` once cached (or already
    /// was), `Ok(false)` when cancelled, superseded or the session was busy.
    pub async fn prefetch(
        &self,
        sql: String,
        connection_id: String,
        config: PostgresConnection,
        tunnel: Option<Arc<SshTunnel>>,
    ) -> Result<bool, DriverError> {
        if self.closed.load(Ordering::SeqCst) {
            return Ok(false);
        }
        if self.has(&sql) {
            return Ok(true);
        }
        let seq = self.latest.fetch_add(1, Ordering::SeqCst) + 1;
        // One in flight: the newer one wins.
        self.cancel().await;
        let Some(mut held) = self.lock(LOCK_WAIT).await else {
            return Ok(false);
        };
        if self.latest.load(Ordering::SeqCst) != seq || self.closed.load(Ordering::SeqCst) {
            return Ok(false);
        }
        let epoch = self.epoch.load(Ordering::SeqCst);
        if !self.ready(&mut held, connection_id, config, tunnel).await? {
            return Ok(false);
        }
        let Held {
            session: Some(session),
            serial,
            ..
        } = &*held
        else {
            return Ok(false);
        };
        let (token, tls) = (session.cancel_token.clone(), session.tls.clone());
        if let Ok(mut f) = self.inflight.lock() {
            *f = Some(InFlight {
                seq,
                token: token.clone(),
                tls: tls.clone(),
            });
        }
        let cursor = format!("rowkery_pf_{seq}");
        let read = async {
            // One round, as before; the DECLARE goes alone through the
            // extended protocol, so a statement hidden after the filter's
            // text is refused, never run.
            let (saved, declared) = tokio::join!(
                session_execute(session, "SAVEPOINT rowkery_pf"),
                session_declare_cursor(session, &cursor, &sql),
            );
            saved.and(declared)?;
            let mut batches = Vec::new();
            let stats = session_query_stream_with(
                session,
                &format!("FETCH FORWARD {PREFETCH_ROWS} FROM {cursor}"),
                StreamOptions::default(),
                |b, _| {
                    batches.push(b);
                    Ok(())
                },
            )
            .await?;
            session_execute(session, "RELEASE SAVEPOINT rowkery_pf").await?;
            Ok::<_, DriverError>((batches, stats.rows))
        };
        let read = tokio::time::timeout(READ_LIMIT, read).await;
        if let Ok(mut f) = self.inflight.lock() {
            if f.as_ref().is_some_and(|f| f.seq == seq) {
                *f = None;
            }
        }
        let serial = *serial;
        held.last_used = Some(SystemTime::now());
        let (batches, rows) = match read {
            Ok(Ok(read)) => read,
            Ok(Err(err)) => {
                undo_savepoint(&mut held, self).await;
                return match err {
                    DriverError::Cancelled => Ok(false),
                    err => Err(err),
                };
            }
            // Too slow, or the link is dead: the session goes.
            Err(_) => {
                let _ = tokio::time::timeout(CANCEL_LIMIT, cancel_with_token(token, tls)).await;
                self.drop_session(&mut held);
                return Ok(false);
            }
        };
        let session = held.session.as_ref().expect("held");
        let more = rows >= u64::from(PREFETCH_ROWS);
        // Written to since it started, or the whole page came back: no cursor to keep.
        if !more || self.epoch.load(Ordering::SeqCst) != epoch {
            let _ = session_execute(session, &format!("CLOSE {cursor}")).await;
            if self.epoch.load(Ordering::SeqCst) != epoch {
                self.end_if_no_cursor(&mut held).await;
                return Ok(false);
            }
        }
        let closing: Vec<String> = {
            let mut entries = self
                .entries
                .lock()
                .map_err(|_| DriverError::Message("prefetch cache".into()))?;
            // A page of the same SQL it replaces: its cursor closes too.
            let mut closing: Vec<String> = entries
                .iter()
                .filter(|e| e.sql == sql && e.more)
                .map(|e| e.cursor.clone())
                .collect();
            entries.retain(|e| e.sql != sql);
            entries.push(Entry {
                sql,
                cursor,
                serial,
                batches,
                more,
                at: Instant::now(),
                wall: SystemTime::now(),
            });
            let over = entries.len().saturating_sub(MAX_ENTRIES);
            closing.extend(entries.drain(..over).filter(|e| e.more).map(|e| e.cursor));
            closing
        };
        close_cursors(session, &closing).await;
        self.end_if_no_cursor(&mut held).await;
        Ok(true)
    }

    /// Serves a click that browses `sql` from its prefetched first page:
    /// `on_batch` gets the cached rows, then the rest of the same cursor.
    /// `arm` hands the tab the session's cancel token (false: the tab was
    /// already cancelled). `None` when there is no usable page, or the
    /// session is busy; the caller runs the query as usual and nothing was sent.
    pub async fn serve(
        &self,
        sql: &str,
        mut on_batch: impl FnMut(RowBatch, bool),
        arm: impl FnOnce(CancelToken, Option<MakeRustlsConnect>) -> bool,
    ) -> Option<Served> {
        let entry = {
            let mut entries = self.entries.lock().ok()?;
            let at = entries.iter().position(|e| e.sql == sql && e.fresh())?;
            entries.remove(at)
        };
        // The whole page: no session involved.
        if !entry.more {
            let mut sent = 0;
            for (i, batch) in entry.batches.into_iter().enumerate() {
                sent += batch.rows.len() as u64;
                on_batch(batch, i == 0);
            }
            return Some(Ok(sent));
        }
        // The click wins over a prefetch in flight.
        self.cancel().await;
        let mut held = self.lock(SERVE_WAIT).await?;
        self.roll_back_if_invalidated(&mut held).await;
        self.end_if_old(&mut held).await;
        let usable = held.in_txn
            && held.serial == entry.serial
            && held.session.as_ref().is_some_and(|s| !s.is_closed());
        if !usable {
            return None;
        }
        held.last_used = Some(SystemTime::now());
        let session = held.session.as_ref().expect("usable");
        if !arm(session.cancel_token.clone(), session.tls.clone()) {
            close_cursors(session, &[entry.cursor]).await;
            self.end_if_no_cursor(&mut held).await;
            return Some(Err(DriverError::Cancelled));
        }
        let mut sent = 0;
        for (i, batch) in entry.batches.into_iter().enumerate() {
            sent += batch.rows.len() as u64;
            on_batch(batch, i == 0);
        }
        let cursor = entry.cursor;
        let rest = async {
            session_execute(session, "SAVEPOINT rowkery_pf").await?;
            let stats = session_query_stream_with(
                session,
                &format!("FETCH ALL FROM {cursor}"),
                StreamOptions::default(),
                |b, _| {
                    on_batch(b, false);
                    Ok(())
                },
            )
            .await?;
            session_execute(
                session,
                &format!("CLOSE {cursor}; RELEASE SAVEPOINT rowkery_pf"),
            )
            .await?;
            Ok::<_, DriverError>(stats.rows)
        }
        .await;
        match rest {
            Ok(n) => {
                self.end_if_no_cursor(&mut held).await;
                Some(Ok(sent + n))
            }
            Err(err) => {
                undo_savepoint(&mut held, self).await;
                if let Some(session) = &held.session {
                    let _ = session_execute(session, &format!("CLOSE {cursor}")).await;
                }
                self.end_if_no_cursor(&mut held).await;
                Some(Err(err))
            }
        }
    }

    /// No cached page has a cursor open: commit, so no lock outlives them.
    async fn end_if_no_cursor(&self, held: &mut Held) {
        let open = self
            .entries
            .lock()
            .map(|e| e.iter().any(|x| x.more))
            .unwrap_or(false);
        if !open {
            self.end_txn(held).await;
        }
    }

    /// The transaction began [`MAX_TXN_AGE`] ago: it ends, and the pages
    /// whose cursors it held go with it.
    async fn end_if_old(&self, held: &mut Held) {
        let old = held.in_txn && held.began.is_none_or(|t| !within(t, MAX_TXN_AGE));
        if old {
            if let Ok(mut e) = self.entries.lock() {
                e.retain(|x| !x.more);
            }
            self.end_txn(held).await;
        }
    }

    /// Commits (closing every cursor); if even that fails, the session goes.
    async fn end_txn(&self, held: &mut Held) {
        if !held.in_txn {
            return;
        }
        let Some(session) = &held.session else {
            held.in_txn = false;
            return;
        };
        match tokio::time::timeout(LOCK_WAIT, session_execute(session, "COMMIT")).await {
            Ok(Ok(())) => {
                held.in_txn = false;
                held.began = None;
            }
            _ => self.drop_session(held),
        }
    }

    /// Drops pages past their TTL (closing their cursors), ends the
    /// transaction once no cursor is left or it is too old, and closes the
    /// session after `idle`.
    pub async fn sweep(&self, idle: Duration) {
        let Some(mut held) = self.lock(LOCK_WAIT).await else {
            return;
        };
        let expired: Vec<String> = match self.entries.lock() {
            Ok(mut entries) => {
                let (old, keep): (Vec<Entry>, Vec<Entry>) =
                    entries.drain(..).partition(|e| !e.fresh());
                *entries = keep;
                old.into_iter()
                    .filter(|e| e.more)
                    .map(|e| e.cursor)
                    .collect()
            }
            Err(_) => return,
        };
        if let Some(session) = &held.session {
            close_cursors(session, &expired).await;
        }
        self.end_if_old(&mut held).await;
        self.end_if_no_cursor(&mut held).await;
        let empty = self.entries.lock().map(|e| e.is_empty()).unwrap_or(true);
        if empty && held.last_used.is_some_and(|t| !within(t, idle)) {
            self.drop_session(&mut held);
        }
    }

    /// The session open, in our `READ ONLY` transaction, with nothing left
    /// from before a write. `false` when it needs a new session and the
    /// connection has no free place: a prefetch never waits for one.
    async fn ready(
        &self,
        held: &mut Held,
        connection_id: String,
        config: PostgresConnection,
        tunnel: Option<Arc<SshTunnel>>,
    ) -> Result<bool, DriverError> {
        self.roll_back_if_invalidated(held).await;
        self.end_if_old(held).await;
        if held.session.as_ref().is_none_or(|s| s.is_closed()) {
            // The closed one's place first.
            self.drop_session(held);
            let place = match &self.cap {
                Some(cap) => match cap.clone().try_acquire_owned() {
                    Ok(place) => Some(place),
                    Err(_) => return Ok(false),
                },
                None => None,
            };
            let mut session = open_session_via(connection_id, config, None, tunnel).await?;
            if let Some(place) = place {
                session.hold(Box::new(place));
            }
            // The server ends the transaction itself if we vanish (a dead
            // link never carries our COMMIT), so its locks are bounded even then.
            let backstop = (MAX_TXN_AGE + Duration::from_secs(15)).as_secs();
            session_execute(
                &session,
                &format!(
                    "SET application_name = '{APPLICATION_NAME}'; \
                     SET idle_in_transaction_session_timeout = '{backstop}s'"
                ),
            )
            .await?;
            self.drop_session(held);
            held.session = Some(session);
            held.serial += 1;
        }
        if !held.in_txn {
            session_execute(held.session.as_ref().expect("open"), "BEGIN READ ONLY").await?;
            held.in_txn = true;
            held.began = Some(SystemTime::now());
        }
        Ok(true)
    }

    /// After `invalidate`, the cursors it orphaned go with a rollback.
    async fn roll_back_if_invalidated(&self, held: &mut Held) {
        let epoch = self.epoch.load(Ordering::SeqCst);
        if self.rolled_back.swap(epoch, Ordering::SeqCst) == epoch || !held.in_txn {
            return;
        }
        if let Some(session) = &held.session {
            if !matches!(
                tokio::time::timeout(LOCK_WAIT, session_execute(session, "ROLLBACK")).await,
                Ok(Ok(()))
            ) {
                self.drop_session(held);
            }
        }
        held.in_txn = false;
        held.began = None;
        if let Ok(mut e) = self.entries.lock() {
            e.clear();
        }
    }
}

/// A failed (or cancelled) step inside `rowkery_pf`: back to the savepoint,
/// keeping the other cursors; if even that fails, the transaction goes.
async fn undo_savepoint(held: &mut Held, owner: &Prefetcher) {
    let Some(session) = &held.session else {
        return;
    };
    let undone = tokio::time::timeout(
        LOCK_WAIT,
        session_execute(
            session,
            "ROLLBACK TO SAVEPOINT rowkery_pf; RELEASE SAVEPOINT rowkery_pf",
        ),
    )
    .await;
    if !matches!(undone, Ok(Ok(()))) {
        let rolled = tokio::time::timeout(LOCK_WAIT, session_execute(session, "ROLLBACK")).await;
        if matches!(rolled, Ok(Ok(()))) {
            held.in_txn = false;
            held.began = None;
            if let Ok(mut e) = owner.entries.lock() {
                e.retain(|x| !x.more);
            }
        } else {
            owner.drop_session(held);
        }
    }
}

async fn close_cursors(session: &PostgresSession, cursors: &[String]) {
    if cursors.is_empty() {
        return;
    }
    let sql: Vec<String> = cursors.iter().map(|c| format!("CLOSE {c}")).collect();
    let _ = tokio::time::timeout(LOCK_WAIT, session_execute(session, &sql.join("; "))).await;
}
