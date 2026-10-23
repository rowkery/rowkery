//! Warm Postgres sessions, so a query doesn't pay for TCP, TLS, auth and an
//! SSH tunnel every time it runs.
//!
//! Each query tab keeps its own session between runs (so `SET` and
//! `BEGIN … COMMIT` carry across them, and cancel only ever hits that tab's
//! backend), and each window keeps the session its schema load used as a
//! spare for the first run. Anything unused for [`IDLE_CLOSE`] is closed, so a
//! forgotten window goes back to holding no sockets.
//!
//! Nothing is sent to check a session when it is leased: one already known to
//! be closed is replaced before the query goes out, and a dead socket not yet
//! noticed fails the query (reads then retry once, see the bridge). Sessions
//! that sat idle are pinged off the critical path instead, when the webview
//! regains focus ([`ping_idle`]), so the first query after a laptop sleep
//! finds a live one. A window's SSH sessions share one tunnel.
//!
//! A session that may hold the user's open transaction (`txn_state` not
//! `None`) is never swept or pinged: closing it would roll their work back.
//! While a tab's (or Quick Look's) own session is out running something, the
//! next lease for that slot waits for it rather than taking another session,
//! which would run outside the transaction. If such a session is lost anyway
//! (the server or the network dropped it, or a stuck run was stopped), the
//! tab's next statement reports that the transaction is gone instead of
//! running on a fresh session as if nothing happened.
//!
//! Hover prefetch has a session of its own per window, never the spare
//! ([`Prefetcher`]): its cursors stay open between uses, so it isn't parked
//! here, but it goes with the window like the rest.
//!
//! One saved connection holds at most [`MAX_SESSIONS`] sessions at once,
//! across all its windows (2026-10-16). Each session keeps its place
//! under that cap for as long as it lives (`PostgresSession::hold`). A run
//! that needs a new session when none is free first closes an idle one (a
//! dead one, else the least recently used with no cursor, then one with a
//! cursor of ours, then the window's prefetch session); the tab that loses
//! it just reconnects on its next run. A session that may hold the user's
//! open transaction is never closed or handed away for this. When every
//! place is taken by sessions running something or holding a transaction,
//! query tabs and Quick Look wait for one ([`lease_or_wait`] says so, so the
//! tab can show it), and the wait is cancelled like any run. Schema loads,
//! the Sessions tab and the spare never wait: past the cap their session is
//! used once and closed, not kept. Hover prefetch counts too but never waits
//! or keeps a place from a tab: it skips the prefetch when the cap is full,
//! and gives its session up when a tab needs the place. The MCP server is a
//! process of its own, outside this.

use std::collections::HashMap;
use std::sync::atomic::AtomicU64;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use rowkery_core::connections::PostgresConnection;
use rowkery_core::db::postgres::{
    open_session_via, session_has_cursor, session_ping, session_probe_txn, PostgresSession, Route,
    TxnState,
};
use rowkery_core::db::DriverError;
use tokio::sync::{OwnedSemaphorePermit, Semaphore};

use crate::prefetch::Prefetcher;

/// The most sessions one saved connection holds open at once, across its
/// windows (2026-10-16): 50 tabs no longer mean 50 backends.
pub(crate) const MAX_SESSIONS: usize = 10;
/// Sessions unused this long are closed (2026-10-16: was 5 minutes);
/// the tab's next run opens a new one. Never one holding the user's open
/// transaction or a paged result's cursor.
pub(crate) const IDLE_CLOSE: Duration = Duration::from_secs(2 * 60);
/// How often a run waiting for a free place looks again, besides being woken
/// when a session is given back or closed (a prefetch ending wakes nobody).
const RECHECK: Duration = Duration::from_millis(500);
/// How often idle sessions are swept.
pub(crate) const SWEEP_EVERY: Duration = Duration::from_secs(30);
/// [`ping_idle`] checks sessions idle at least this long: after a laptop sleep
/// or a network change their sockets may be dead without knowing it yet.
pub(crate) const PING_AFTER: Duration = Duration::from_secs(60);
const PING_TIMEOUT: Duration = Duration::from_secs(3);
/// How long asking a session whether a transaction is open may take.
pub(crate) const PROBE_TIMEOUT: Duration = Duration::from_secs(2);

/// What a tab's next statement says when the session holding its open
/// transaction was lost.
pub(crate) const LOST_TXN: &str = "This tab's connection was lost while a transaction was open in it, so the server rolled that transaction back: nothing since BEGIN was saved. Nothing was run now; run your statements again.";
/// The same, when we only know a statement that can open one had run.
pub(crate) const LOST_MAYBE_TXN: &str = "This tab's connection was lost, and with it any transaction that was open in it (the server rolled it back). Nothing was run now; check what was saved and run your statements again.";

/// The session may hold the user's transaction: never close it on our own.
fn at_risk(session: &PostgresSession) -> bool {
    session.txn_state() != TxnState::None
}

/// Idle close leaves it: it may hold the user's transaction, or a paged
/// result whose Load more would fail without it.
fn kept_when_idle(session: &PostgresSession) -> bool {
    at_risk(session) || session_has_cursor(session)
}

/// Which of a window's sessions.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub(crate) enum Slot {
    /// The session the schema load used, kept for the first run.
    Spare,
    /// A query tab's own session.
    Tab(u64),
    /// Quick Look's foreign-key lookups: never a tab's session or transaction.
    QuickLook,
    /// The Sessions tab's reads and stops: never a tab's session, nor the spare.
    Monitor,
    /// CSV import: its own transaction, never a tab's session or transaction.
    Import,
    /// Run SQL file: used for one file, then closed (the file's `SET`s stay
    /// on it), never parked.
    SqlFile,
}

type Key = (String, Slot);

/// Slots whose session must never be swapped for another while it is out.
fn waits(slot: Slot) -> bool {
    matches!(slot, Slot::Tab(_) | Slot::QuickLook)
}

struct Parked {
    session: PostgresSession,
    generation: u64,
    last_used: Instant,
}

#[derive(Default)]
pub(crate) struct SessionPool {
    parked: HashMap<Key, Parked>,
    /// Bumped whenever a window is re-pointed or closed, so a session that
    /// was out running a query for the old target is dropped, not parked.
    generations: HashMap<String, u64>,
    /// Each window's route (SSH tunnel or Cloud SQL dialer), shared by its
    /// sessions; dropped with the window, or once it has no parked sessions
    /// (sessions in use keep theirs).
    tunnels: HashMap<String, (u64, Route)>,
    /// Each window's prefetch session and first pages, for its generation.
    prefetchers: HashMap<String, (u64, Arc<Prefetcher>)>,
    /// Slots whose own session is out (leased or being pinged), by checkout.
    out: HashMap<Key, u64>,
    /// Woken whenever a checkout ends.
    returned: Arc<tokio::sync::Notify>,
    /// Tabs whose session went while it may have held a transaction:
    /// `true` when it surely did.
    lost: HashMap<Key, bool>,
    next_checkout: u64,
    /// Numbers each window's Quick Look batches; the newest wins.
    quick_look: HashMap<String, Arc<AtomicU64>>,
    /// The tab each session tag was last parked for, so the Sessions tab can
    /// say which of the server's sessions are ours.
    tags: HashMap<String, (String, u64)>,
    /// Each saved connection's places ([`MAX_SESSIONS`]), by connection id.
    caps: HashMap<String, Arc<Semaphore>>,
}

pub(crate) type SharedPool = Arc<Mutex<SessionPool>>;

/// A session taken from the pool (or freshly opened) for one piece of work.
pub(crate) struct Lease {
    pub session: PostgresSession,
    /// True when the session was reused rather than opened for this lease.
    pub reused: bool,
    /// Holds the slot until the session is given back (or this is dropped).
    pub out: Checkout,
}

/// A slot's session is out. Ends with `give_back` (or ping's restore); if
/// dropped first, the session went with it, and a tab that may have had a
/// transaction open in it is marked lost.
pub(crate) struct Checkout {
    pool: Option<SharedPool>,
    key: Key,
    id: u64,
    /// The session may have held the user's transaction when it went out.
    risk: Option<bool>,
}

impl Checkout {
    fn none() -> Self {
        Self {
            pool: None,
            key: (String::new(), Slot::Spare),
            id: 0,
            risk: None,
        }
    }
}

impl Drop for Checkout {
    fn drop(&mut self) {
        let Some(pool) = self.pool.take() else {
            return;
        };
        let notify = match pool.lock() {
            Ok(mut p) => {
                if p.out.get(&self.key) == Some(&self.id) {
                    p.out.remove(&self.key);
                    if let (Some(sure), Slot::Tab(_)) = (self.risk, self.key.1) {
                        p.lost.insert(self.key.clone(), sure);
                    }
                }
                Some(p.returned.clone())
            }
            Err(_) => None,
        };
        if let Some(n) = notify {
            n.notify_waiters();
        }
    }
}

fn risk_of(session: &PostgresSession) -> Option<bool> {
    match session.txn_state() {
        TxnState::None => None,
        TxnState::Users => Some(true),
        TxnState::Unknown => Some(false),
    }
}

impl SessionPool {
    /// How many tabs' parked sessions may hold the user's open transaction.
    /// A session out running a query isn't parked; the page knows those.
    pub fn user_transactions(&self) -> usize {
        self.parked
            .iter()
            .filter(|((_, slot), p)| {
                matches!(slot, Slot::Tab(_)) && !p.session.is_closed() && at_risk(&p.session)
            })
            .count()
    }

    pub fn generation(&self, window_id: &str) -> u64 {
        self.generations.get(window_id).copied().unwrap_or(0)
    }

    /// Forgets the window's sessions and starts a new generation. The caller
    /// drops the returned sessions outside the lock.
    pub fn reset_window(&mut self, window_id: &str) -> (u64, Vec<PostgresSession>) {
        let generation = self.generation(window_id) + 1;
        self.generations.insert(window_id.to_string(), generation);
        self.tunnels.remove(window_id);
        if let Some((_, f)) = self.prefetchers.remove(window_id) {
            f.shutdown();
        }
        // Checkouts of the old generation end on their own; nothing waits on them.
        self.out.retain(|(w, _), _| w != window_id);
        self.tags.retain(|_, (w, _)| w != window_id);
        self.lost.retain(|(w, _), _| w != window_id);
        self.returned.notify_waiters();
        let keys: Vec<Key> = self
            .parked
            .keys()
            .filter(|(w, _)| w == window_id)
            .cloned()
            .collect();
        let dropped = keys
            .into_iter()
            .filter_map(|k| self.parked.remove(&k))
            .map(|p| p.session)
            .collect();
        (generation, dropped)
    }

    /// Closes the window entirely (no new generation is needed afterwards,
    /// but bumping it keeps in-flight sessions from being parked).
    pub fn close_window(&mut self, window_id: &str) -> Vec<PostgresSession> {
        let (_, dropped) = self.reset_window(window_id);
        dropped
    }

    pub fn close_tab(&mut self, window_id: &str, tab_id: u64) -> Option<PostgresSession> {
        let key = (window_id.to_string(), Slot::Tab(tab_id));
        self.lost.remove(&key);
        self.tags
            .retain(|_, t| *t != (window_id.to_string(), tab_id));
        self.parked.remove(&key).map(|p| p.session)
    }

    /// The window's prefetcher for this generation, made on first use; its
    /// session takes a place under `connection_id`'s cap.
    pub fn prefetcher(
        &mut self,
        window_id: &str,
        generation: u64,
        connection_id: &str,
    ) -> Option<Arc<Prefetcher>> {
        if self.generation(window_id) != generation {
            return None;
        }
        let cap = self.cap(connection_id);
        let fresh = || (generation, Arc::new(Prefetcher::capped(cap.clone())));
        let entry = self
            .prefetchers
            .entry(window_id.to_string())
            .or_insert_with(fresh);
        if entry.0 != generation {
            *entry = fresh();
        }
        Some(entry.1.clone())
    }

    /// The saved connection's places.
    pub fn cap(&mut self, connection_id: &str) -> Arc<Semaphore> {
        self.caps
            .entry(connection_id.to_string())
            .or_insert_with(|| Arc::new(Semaphore::new(MAX_SESSIONS)))
            .clone()
    }

    /// Gives `session` a place under its connection's cap if it has none;
    /// false when every place is taken.
    fn place(&mut self, session: &mut PostgresSession) -> bool {
        if session.holds() {
            return true;
        }
        match self.cap(session.connection_id()).try_acquire_owned() {
            Ok(place) => {
                session.hold(Box::new(place));
                true
            }
            Err(_) => false,
        }
    }

    /// Takes out a parked session of `connection_id` that can be closed to
    /// free its place: a dead one first, then the least recently used with
    /// no cursor, then one with a cursor of ours. Never one that may hold
    /// the user's transaction. The caller drops it outside the lock.
    fn evict(&mut self, connection_id: &str) -> Option<PostgresSession> {
        let key = self
            .parked
            .iter()
            .filter(|(_, p)| {
                p.session.connection_id() == connection_id
                    && p.session.holds()
                    && (p.session.is_closed() || !at_risk(&p.session))
            })
            .min_by_key(|(_, p)| {
                (
                    !p.session.is_closed(),
                    session_has_cursor(&p.session),
                    p.last_used,
                )
            })
            .map(|(k, _)| k.clone())?;
        let p = self.parked.remove(&key)?;
        let (w, slot) = key;
        if p.session.is_closed() {
            self.note_lost(&w, slot, &p.session);
        }
        if let Slot::Tab(tab_id) = slot {
            self.tags.retain(|_, t| *t != (w.clone(), tab_id));
        }
        Some(p.session)
    }

    /// The prefetchers whose sessions take places under `cap`.
    fn prefetchers_under(&self, cap: &Arc<Semaphore>) -> Vec<Arc<Prefetcher>> {
        self.prefetchers
            .values()
            .map(|(_, f)| f.clone())
            .filter(|f| f.is_under(cap))
            .collect()
    }

    /// The counter that numbers the window's Quick Look batches.
    pub fn quick_look_seq(&mut self, window_id: &str) -> Arc<AtomicU64> {
        self.quick_look
            .entry(window_id.to_string())
            .or_default()
            .clone()
    }

    /// The window's prefetcher if it has one (nothing is made).
    pub fn existing_prefetcher(&self, window_id: &str) -> Option<Arc<Prefetcher>> {
        self.prefetchers
            .get(window_id)
            .filter(|(g, _)| *g == self.generation(window_id))
            .map(|(_, p)| p.clone())
    }

    /// The window's live route, for a session opened outside the pool.
    pub fn window_tunnel(&self, window_id: &str, generation: u64) -> Option<Route> {
        self.tunnel(window_id, generation)
    }

    /// Session tags and the tab (window, tab id) each belongs to.
    pub fn tag_tabs(&self) -> HashMap<String, (String, u64)> {
        self.tags.clone()
    }

    /// The slot's own session, else the window's spare (never for the
    /// Sessions tab, which would leave the next query a cold start).
    fn take(&mut self, window_id: &str, slot: Slot, generation: u64) -> Option<Parked> {
        let own = (window_id.to_string(), slot);
        let spare = (window_id.to_string(), Slot::Spare);
        let spare = (slot != Slot::Monitor).then_some(spare);
        std::iter::once(own)
            .chain(spare)
            .find_map(|k| self.parked.remove(&k))
            .filter(|p| p.generation == generation)
    }

    /// Keeps `session` for the next use of `slot`. Returns it back when it
    /// shouldn't be kept, for the caller to drop.
    pub fn park(
        &mut self,
        window_id: &str,
        slot: Slot,
        generation: u64,
        mut session: PostgresSession,
    ) -> Option<PostgresSession> {
        if self.generation(window_id) != generation {
            return Some(session);
        }
        if session.is_closed() {
            self.note_lost(window_id, slot, &session);
            return Some(session);
        }
        let key = (window_id.to_string(), slot);
        // Past the cap (a schema load or the Sessions tab, which never
        // wait): used once, not kept. The session it would replace hands
        // over its place first.
        if !session.holds() {
            if let Some(place) = self.parked.get_mut(&key).and_then(|p| p.session.unhold()) {
                session.hold(place);
            }
        }
        if !self.place(&mut session) {
            return Some(session);
        }
        // The first SSH session parked (often the schema load's) lends the
        // window its tunnel.
        if let Some(t) = session.route() {
            if self.tunnel(window_id, generation).is_none() {
                self.keep_tunnel(window_id, generation, t);
            }
        }
        if let Slot::Tab(tab_id) = slot {
            self.tags
                .insert(session.tag().to_string(), (window_id.to_string(), tab_id));
        }
        let old = self.parked.insert(
            key,
            Parked {
                session,
                generation,
                last_used: Instant::now(),
            },
        );
        old.map(|p| p.session)
    }

    /// A tab's session that may have held the user's transaction is gone.
    fn note_lost(&mut self, window_id: &str, slot: Slot, session: &PostgresSession) {
        if let (Some(sure), Slot::Tab(_)) = (risk_of(session), slot) {
            self.lost.insert((window_id.to_string(), slot), sure);
        }
    }

    /// Removes sessions idle for `idle` or longer, and the tunnels of windows
    /// left with no parked session. A session that may hold the user's open
    /// transaction, or a paged result's cursor, stays (unless its socket is
    /// already gone).
    pub fn sweep(&mut self, idle: Duration) -> Vec<PostgresSession> {
        let stale: Vec<Key> = self
            .parked
            .iter()
            .filter(|(_, p)| {
                p.session.is_closed()
                    || (p.last_used.elapsed() >= idle && !kept_when_idle(&p.session))
            })
            .map(|(k, _)| k.clone())
            .collect();
        let mut dropped = Vec::new();
        for (w, slot) in stale {
            if let Some(p) = self.parked.remove(&(w.clone(), slot)) {
                if p.session.is_closed() {
                    self.note_lost(&w, slot, &p.session);
                }
                dropped.push(p.session);
            }
        }
        let parked = &self.parked;
        self.tunnels
            .retain(|w, (_, t)| t.is_alive() && parked.keys().any(|(pw, _)| pw == w));
        dropped
    }

    /// The window's live tunnel for this generation, if it has one.
    fn tunnel(&self, window_id: &str, generation: u64) -> Option<Route> {
        self.tunnels
            .get(window_id)
            .filter(|(g, t)| *g == generation && t.is_alive())
            .map(|(_, t)| t.clone())
    }

    fn keep_tunnel(&mut self, window_id: &str, generation: u64, tunnel: Route) {
        if self.generation(window_id) == generation {
            self.tunnels
                .insert(window_id.to_string(), (generation, tunnel));
        }
    }

    /// The window's sessions idle for `idle` or longer, taken out to be
    /// pinged (their slots marked out, so a run waits for the ping). Never a
    /// session that may hold the user's transaction.
    fn take_idle(&mut self, window_id: &str, idle: Duration) -> Vec<(Slot, Parked, u64)> {
        let keys: Vec<Key> = self
            .parked
            .iter()
            .filter(|((w, _), p)| {
                w == window_id && p.last_used.elapsed() >= idle && !at_risk(&p.session)
            })
            .map(|(k, _)| k.clone())
            .collect();
        keys.into_iter()
            .filter_map(|k| {
                let p = self.parked.remove(&k)?;
                self.next_checkout += 1;
                let id = self.next_checkout;
                self.out.insert(k.clone(), id);
                Some((k.1, p, id))
            })
            .collect()
    }

    /// Puts back a pinged session without counting the ping as use.
    fn restore(
        &mut self,
        window_id: &str,
        slot: Slot,
        id: u64,
        parked: Option<Parked>,
    ) -> Option<PostgresSession> {
        let key = (window_id.to_string(), slot);
        if self.out.get(&key) == Some(&id) {
            self.out.remove(&key);
            self.returned.notify_waiters();
        }
        let parked = parked?;
        if parked.session.is_closed()
            || self.generation(window_id) != parked.generation
            || self.parked.contains_key(&key)
        {
            return Some(parked.session);
        }
        self.parked.insert(key, parked);
        None
    }

    /// Marks the slot's own session out (one checkout at a time per slot that
    /// waits), and says whether the tab lost a transaction since.
    fn check_out(&mut self, pool: &SharedPool, key: &Key) -> Checkout {
        if !waits(key.1) {
            return Checkout::none();
        }
        self.next_checkout += 1;
        let id = self.next_checkout;
        self.out.insert(key.clone(), id);
        Checkout {
            pool: Some(pool.clone()),
            key: key.clone(),
            id,
            risk: None,
        }
    }
}

/// What a lease found in the pool (short-lived, so its size doesn't matter).
#[allow(clippy::large_enum_variant)]
enum Found {
    /// The slot's own session is out: wait for it.
    Busy,
    /// The tab's transaction went with its session.
    Lost(bool),
    Ready(Option<Parked>, Option<Route>, Checkout),
}

/// Takes the slot's warm session (or the window's spare), checking it is
/// still alive, or opens a new one ([`lease_or_wait`], without being told
/// of a wait for a free place).
pub(crate) async fn lease(
    pool: &SharedPool,
    window_id: &str,
    slot: Slot,
    generation: u64,
    connection_id: String,
    config: PostgresConnection,
) -> Result<Lease, DriverError> {
    lease_or_wait(
        pool,
        window_id,
        slot,
        generation,
        connection_id,
        config,
        &|_| {},
    )
    .await
}

/// [`lease`], calling `on_wait(true)` when a new session must wait for a
/// free place under the connection's cap, and `on_wait(false)` once it has
/// one. Dropping the future while it waits gives nothing up.
pub(crate) async fn lease_or_wait(
    pool: &SharedPool,
    window_id: &str,
    slot: Slot,
    generation: u64,
    connection_id: String,
    config: PostgresConnection,
    on_wait: &(dyn Fn(bool) + Send + Sync),
) -> Result<Lease, DriverError> {
    let key = (window_id.to_string(), slot);
    let (parked, tunnel, mut out) = loop {
        let returned = pool.lock().map(|p| p.returned.clone()).ok();
        let wake = returned.as_ref().map(|n| n.notified());
        let mut wake = std::pin::pin!(wake);
        if let Some(w) = wake.as_mut().as_pin_mut() {
            w.enable();
        }
        let found = match pool.lock() {
            Ok(mut p) => {
                if waits(slot) && p.out.contains_key(&key) && p.generation(window_id) == generation
                {
                    Found::Busy
                } else if let Some(sure) = p.lost.remove(&key) {
                    Found::Lost(sure)
                } else {
                    let out = p.check_out(pool, &key);
                    Found::Ready(
                        p.take(window_id, slot, generation),
                        p.tunnel(window_id, generation),
                        out,
                    )
                }
            }
            Err(_) => Found::Ready(None, None, Checkout::none()),
        };
        match found {
            Found::Busy => match wake.as_mut().as_pin_mut() {
                Some(w) => w.await,
                None => tokio::task::yield_now().await,
            },
            Found::Lost(sure) => {
                return Err(DriverError::Message(
                    if sure { LOST_TXN } else { LOST_MAYBE_TXN }.into(),
                ))
            }
            Found::Ready(parked, tunnel, out) => break (parked, tunnel, out),
        }
    };
    // Already known dead: replaced before anything is sent, so this is safe
    // for any statement. No ping here; that would cost a round trip per run.
    // But if it may have held the user's transaction, that is gone: say so.
    match parked {
        Some(parked) if !parked.session.is_closed() => {
            out.risk = risk_of(&parked.session);
            return Ok(Lease {
                session: parked.session,
                reused: true,
                out,
            });
        }
        Some(parked) if matches!(slot, Slot::Tab(_)) => {
            if let Some(sure) = risk_of(&parked.session) {
                return Err(DriverError::Message(
                    if sure { LOST_TXN } else { LOST_MAYBE_TXN }.into(),
                ));
            }
        }
        _ => {}
    }
    let place = room(pool, &connection_id, waits(slot), on_wait).await;
    let mut session = open_session_via(connection_id, config, None, tunnel).await?;
    if let Some(place) = place {
        session.hold(Box::new(place));
    }
    if let (Some(t), Ok(mut p)) = (session.route(), pool.lock()) {
        p.keep_tunnel(window_id, generation, t);
    }
    Ok(Lease {
        session,
        reused: false,
        out,
    })
}

/// A place under `connection_id`'s cap for a new session, closing an idle
/// session (or a prefetch session) to free one. With none to free, `wait`
/// waits for one, telling `on_wait`; else `None`: the session opened is used
/// once and not kept.
async fn room(
    pool: &SharedPool,
    connection_id: &str,
    wait: bool,
    on_wait: &(dyn Fn(bool) + Send + Sync),
) -> Option<OwnedSemaphorePermit> {
    let returned = pool.lock().ok()?.returned.clone();
    let mut waited = false;
    let done = |place: Option<OwnedSemaphorePermit>, waited: bool| {
        if waited {
            on_wait(false);
        }
        place
    };
    loop {
        let wake = returned.notified();
        let mut wake = std::pin::pin!(wake);
        wake.as_mut().enable();
        let (cap, evicted, prefetchers) = {
            let Ok(mut p) = pool.lock() else {
                return done(None, waited);
            };
            let cap = p.cap(connection_id);
            if let Ok(place) = cap.clone().try_acquire_owned() {
                return done(Some(place), waited);
            }
            let evicted = p.evict(connection_id);
            let prefetchers = match evicted {
                Some(_) => Vec::new(),
                None => p.prefetchers_under(&cap),
            };
            (cap, evicted, prefetchers)
        };
        if let Some(session) = evicted {
            // Its place is free once it is dropped: taken next time round.
            drop(session);
            continue;
        }
        let mut freed = false;
        for f in prefetchers {
            freed |= f.drop_if_idle(Duration::ZERO);
        }
        if freed {
            continue;
        }
        if !wait {
            return done(None, waited);
        }
        if !waited {
            waited = true;
            on_wait(true);
        }
        tokio::select! {
            place = cap.acquire_owned() => return done(place.ok(), waited),
            _ = wake => {}
            _ = tokio::time::sleep(RECHECK) => {}
        }
    }
}

/// Pings the window's sessions idle for `idle` or longer, all at once and off
/// any query's path; a dead one is replaced by a fresh session in its slot, so
/// the next run finds it warm. Returns how many were replaced.
pub(crate) async fn ping_idle(
    pool: &SharedPool,
    window_id: &str,
    idle: Duration,
    connection_id: String,
    config: PostgresConnection,
) -> usize {
    let taken = pool
        .lock()
        .map(|mut p| p.take_idle(window_id, idle))
        .unwrap_or_default();
    let checks = taken.into_iter().map(|(slot, parked, id)| async move {
        let alive =
            !parked.session.is_closed() && session_ping(&parked.session, PING_TIMEOUT).await;
        (slot, parked, id, alive)
    });
    let mut replaced = 0;
    for (slot, parked, id, alive) in futures::future::join_all(checks).await {
        let back = if alive {
            pool.lock()
                .ok()
                .and_then(|mut p| p.restore(window_id, slot, id, Some(parked)))
        } else {
            let Parked {
                generation,
                last_used,
                session,
            } = parked;
            drop(session);
            // The dead one's place, unless a waiting run took it first.
            let (tunnel, place) = pool
                .lock()
                .map(|mut p| {
                    let place = p.cap(&connection_id).try_acquire_owned().ok();
                    (p.tunnel(window_id, generation), place)
                })
                .unwrap_or((None, None));
            let opened = match place {
                Some(place) => {
                    open_session_via(connection_id.clone(), config.clone(), None, tunnel)
                        .await
                        .map(|mut fresh| {
                            fresh.hold(Box::new(place));
                            fresh
                        })
                }
                None => Err(DriverError::Message("no free place".into())),
            };
            match opened {
                Ok(fresh) => {
                    replaced += 1;
                    pool.lock().ok().and_then(|mut p| {
                        if let Some(t) = fresh.route() {
                            p.keep_tunnel(window_id, generation, t);
                        }
                        p.restore(
                            window_id,
                            slot,
                            id,
                            Some(Parked {
                                session: fresh,
                                generation,
                                last_used,
                            }),
                        )
                    })
                }
                Err(_) => pool
                    .lock()
                    .ok()
                    .and_then(|mut p| p.restore(window_id, slot, id, None)),
            }
        };
        drop(back);
    }
    replaced
}

/// Parks a session after use, dropping it outside the lock if it isn't kept,
/// and ends the slot's checkout so a run waiting for it goes ahead.
pub(crate) fn give_back(
    pool: &SharedPool,
    window_id: &str,
    slot: Slot,
    generation: u64,
    session: PostgresSession,
) {
    let rejected = match pool.lock() {
        Ok(mut p) => {
            let rejected = p.park(window_id, slot, generation, session);
            let key = (window_id.to_string(), slot);
            p.out.remove(&key);
            // Also wakes a run waiting for a place: this session may be one
            // it can close now.
            p.returned.notify_waiters();
            rejected
        }
        Err(_) => Some(session),
    };
    drop(rejected);
}

/// After a statement that may have opened or ended a transaction, asks the
/// server which, so a session that holds none can be swept and pinged again.
pub(crate) async fn settle_txn(session: &mut PostgresSession) {
    if session.txn_state() == TxnState::Unknown && !session.is_closed() {
        session_probe_txn(session, PROBE_TIMEOUT).await;
    }
}

/// Closes idle sessions every [`SWEEP_EVERY`], for the life of the runtime.
pub(crate) async fn sweep_forever(pool: SharedPool) {
    let mut tick = tokio::time::interval(SWEEP_EVERY);
    loop {
        tick.tick().await;
        let (stale, prefetchers) = pool
            .lock()
            .map(|mut p| {
                let prefetchers: Vec<Arc<Prefetcher>> =
                    p.prefetchers.values().map(|(_, f)| f.clone()).collect();
                (p.sweep(IDLE_CLOSE), prefetchers)
            })
            .unwrap_or_default();
        drop(stale);
        for f in prefetchers {
            f.sweep(IDLE_CLOSE).await;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use rowkery_core::connections::PostgresSslMode;
    use rowkery_core::db::postgres::{
        open_session_with_secrets, session_execute, session_note_statement, session_query_cursor,
    };
    use rowkery_core::secrets::ConnectionSecrets;

    fn config() -> Option<PostgresConnection> {
        let host = std::env::var("ROWKERY_PG_HOST").ok()?;
        Some(PostgresConnection {
            allow_mcp: false,
            mcp_hidden_tables: Vec::new(),
            mcp_until: None,
            mcp_samples_off: false,
            mcp_access: None,
            masked_columns: Default::default(),
            environment: None,
            safe_mode: Default::default(),
            id: "fixb-pool".into(),
            name: "fixb pool".into(),
            host,
            port: std::env::var("ROWKERY_PG_PORT")
                .ok()
                .and_then(|p| p.parse().ok())
                .unwrap_or(54329),
            database: std::env::var("ROWKERY_PG_DB").unwrap_or_else(|_| "rowkery".into()),
            username: std::env::var("ROWKERY_PG_USER").unwrap_or_else(|_| "rowkery".into()),
            ssl_mode: PostgresSslMode::Disable,
            ssl_root_cert: None,
            ssh: None,
            cloud_sql: None,
        })
    }

    async fn open(config: &PostgresConnection) -> PostgresSession {
        let secrets = ConnectionSecrets {
            db_password: Some(
                std::env::var("ROWKERY_PG_PASSWORD").unwrap_or_else(|_| "rowkery".into()),
            ),
            ..Default::default()
        };
        open_session_with_secrets("fixb-pool".into(), config.clone(), Some(&secrets))
            .await
            .expect("open")
    }

    /// A session holding the user's open transaction is never swept or
    /// pinged; one with none is. A tab whose own session is out waits for
    /// it, even with a spare parked, instead of running outside its
    /// transaction; and if it is lost while out, the next lease says so.
    #[test]
    fn a_transactions_session_is_kept_and_waited_for() {
        let Some(config) = config() else {
            eprintln!("skip a_transactions_session_is_kept_and_waited_for (set ROWKERY_PG_HOST)");
            return;
        };
        let runtime = tokio::runtime::Runtime::new().unwrap();
        runtime.block_on(async {
            let pool = SharedPool::default();
            let mut in_txn = open(&config).await;
            session_execute(&in_txn, "BEGIN").await.unwrap();
            session_note_statement(&mut in_txn, false);
            settle_txn(&mut in_txn).await;
            assert_eq!(in_txn.txn_state(), TxnState::Users);
            let mut idle = open(&config).await;
            session_note_statement(&mut idle, false);
            settle_txn(&mut idle).await;
            assert_eq!(
                idle.txn_state(),
                TxnState::None,
                "the probe says none is open"
            );
            give_back(&pool, "w", Slot::Tab(1), 0, in_txn);
            give_back(&pool, "w", Slot::Tab(2), 0, idle);

            // Pinged and swept: only the idle one goes.
            assert_eq!(
                ping_idle(
                    &pool,
                    "w",
                    Duration::ZERO,
                    "fixb-pool".into(),
                    config.clone()
                )
                .await,
                0
            );
            let dropped = pool.lock().unwrap().sweep(Duration::ZERO);
            assert_eq!(dropped.len(), 1);
            drop(dropped);
            give_back(&pool, "w", Slot::Spare, 0, open(&config).await);

            // Tab 1 is out: a second lease waits rather than take the spare.
            let first = lease(
                &pool,
                "w",
                Slot::Tab(1),
                0,
                "fixb-pool".into(),
                config.clone(),
            )
            .await
            .unwrap();
            assert_eq!(first.session.txn_state(), TxnState::Users);
            let waiting = {
                let (pool, config) = (pool.clone(), config.clone());
                tokio::spawn(async move {
                    lease(&pool, "w", Slot::Tab(1), 0, "fixb-pool".into(), config).await
                })
            };
            tokio::time::sleep(Duration::from_millis(300)).await;
            assert!(!waiting.is_finished(), "waits for its own session");
            let Lease { session, out, .. } = first;
            give_back(&pool, "w", Slot::Tab(1), 0, session);
            drop(out);
            let second = tokio::time::timeout(Duration::from_secs(2), waiting)
                .await
                .expect("goes once it is back")
                .unwrap()
                .unwrap();
            assert!(second.reused);
            assert_eq!(
                second.session.txn_state(),
                TxnState::Users,
                "the same session"
            );

            // Dropped while out with the transaction open: the next lease says so.
            drop(second);
            let lost = lease(
                &pool,
                "w",
                Slot::Tab(1),
                0,
                "fixb-pool".into(),
                config.clone(),
            )
            .await;
            assert!(matches!(lost, Err(DriverError::Message(m)) if m == LOST_TXN));
            // Once.
            assert!(lease(
                &pool,
                "w",
                Slot::Tab(1),
                0,
                "fixb-pool".into(),
                config.clone()
            )
            .await
            .is_ok());
        });
    }

    /// The chosen numbers (2026-10-16).
    #[test]
    fn ten_sessions_per_connection_closed_after_two_idle_minutes() {
        assert_eq!(MAX_SESSIONS, 10);
        assert_eq!(IDLE_CLOSE, Duration::from_secs(120));
    }

    /// A connection nothing listens on, for prefetches that must not connect.
    fn nowhere() -> PostgresConnection {
        PostgresConnection {
            allow_mcp: false,
            mcp_hidden_tables: Vec::new(),
            mcp_until: None,
            mcp_samples_off: false,
            mcp_access: None,
            masked_columns: Default::default(),
            environment: None,
            safe_mode: Default::default(),
            id: "cap-nowhere".into(),
            name: "nowhere".into(),
            host: "127.0.0.1".into(),
            port: 1,
            database: "x".into(),
            username: "x".into(),
            ssl_mode: PostgresSslMode::Disable,
            ssl_root_cert: None,
            ssh: None,
            cloud_sql: None,
        }
    }

    /// Hover prefetch never waits for a place: with none free it reads
    /// nothing (and connects nowhere); a session it failed to open gives its
    /// place straight back.
    #[test]
    fn a_prefetch_never_waits_for_a_place() {
        let runtime = tokio::runtime::Runtime::new().unwrap();
        runtime.block_on(async {
            let full = Arc::new(Semaphore::new(0));
            let f = Prefetcher::capped(full.clone());
            assert!(f.is_under(&full));
            assert!(!f.is_under(&Arc::new(Semaphore::new(0))));
            let read = tokio::time::timeout(
                Duration::from_secs(1),
                f.prefetch("SELECT 1".into(), "cap-nowhere".into(), nowhere(), None),
            )
            .await
            .expect("does not wait");
            assert!(matches!(read, Ok(false)), "nothing prefetched");

            let one = Arc::new(Semaphore::new(1));
            let f = Prefetcher::capped(one.clone());
            let read = f
                .prefetch("SELECT 1".into(), "cap-nowhere".into(), nowhere(), None)
                .await;
            assert!(read.is_err(), "nothing listens there");
            assert_eq!(one.available_permits(), 1, "its place came back");
        });
    }

    async fn open_as(config: &PostgresConnection, id: &str) -> PostgresSession {
        let secrets = ConnectionSecrets {
            db_password: Some(
                std::env::var("ROWKERY_PG_PASSWORD").unwrap_or_else(|_| "rowkery".into()),
            ),
            ..Default::default()
        };
        open_session_with_secrets(id.into(), config.clone(), Some(&secrets))
            .await
            .expect("open")
    }

    /// One connection holds at most ten sessions. Past that a parked one
    /// isn't kept; a new one first closes the least recently used idle
    /// session (one with no cursor before one with a cursor); with none to
    /// close it waits, says so, and gets the place as soon as one frees. It
    /// never closes a session holding the user's transaction, and idle close
    /// leaves that one and a paged result's cursor alone. A wait that is
    /// dropped (a cancel) holds nothing.
    #[test]
    fn the_cap_closes_idle_sessions_then_waits() {
        let Some(config) = config() else {
            eprintln!("skip the_cap_closes_idle_sessions_then_waits (set ROWKERY_PG_HOST)");
            return;
        };
        let id = "cap-pool";
        let runtime = tokio::runtime::Runtime::new().unwrap();
        runtime.block_on(async {
            let pool = SharedPool::default();
            let cap = pool.lock().unwrap().cap(id);
            let parked = |slot: Slot| {
                pool.lock()
                    .unwrap()
                    .parked
                    .contains_key(&("w".to_string(), slot))
            };
            let take = |slot: Slot| {
                pool.lock()
                    .unwrap()
                    .parked
                    .remove(&("w".to_string(), slot))
                    .expect("parked")
                    .session
            };
            for tab in 1..=10 {
                give_back(&pool, "w", Slot::Tab(tab), 0, open_as(&config, id).await);
            }
            assert_eq!(cap.available_permits(), 0);
            // An eleventh (a schema load past the cap) is used once, not kept.
            give_back(&pool, "w", Slot::Tab(11), 0, open_as(&config, id).await);
            assert!(!parked(Slot::Tab(11)));
            assert_eq!(pool.lock().unwrap().parked.len(), 10);

            // A new session closes the least recently used idle one: tab 1.
            let waits = Arc::new(Mutex::new(Vec::new()));
            let seen = waits.clone();
            let on_wait = move |w: bool| seen.lock().unwrap().push(w);
            let place = room(&pool, id, true, &on_wait).await.expect("a place");
            assert!(!parked(Slot::Tab(1)), "tab 1's idle session went");
            assert!(waits.lock().unwrap().is_empty(), "no wait");
            drop(place);

            // Tab 2 holds the user's transaction; tab 3 a paged result's cursor.
            let mut in_txn = take(Slot::Tab(2));
            session_execute(&in_txn, "BEGIN").await.unwrap();
            session_note_statement(&mut in_txn, false);
            settle_txn(&mut in_txn).await;
            assert_eq!(in_txn.txn_state(), TxnState::Users);
            give_back(&pool, "w", Slot::Tab(2), 0, in_txn);
            let mut paged = take(Slot::Tab(3));
            session_query_cursor(
                &mut paged,
                "SELECT g FROM generate_series(1, 100) g",
                10,
                Default::default(),
                |_, _| Ok(()),
            )
            .await
            .unwrap();
            assert!(session_has_cursor(&paged));
            give_back(&pool, "w", Slot::Tab(3), 0, paged);

            // Idle close keeps both, and closes the rest.
            drop(pool.lock().unwrap().sweep(Duration::ZERO));
            assert!(parked(Slot::Tab(2)) && parked(Slot::Tab(3)));
            assert_eq!(pool.lock().unwrap().parked.len(), 2);
            assert_eq!(cap.available_permits(), 8);
            // Eight sessions busy running something (out of the pool).
            let mut busy = Vec::new();
            for _ in 0..8 {
                let place = room(&pool, id, true, &|_| {}).await.expect("free");
                let mut s = open_as(&config, id).await;
                s.hold(Box::new(place));
                busy.push(s);
            }
            // Full: the cursor's session goes before anyone waits, never
            // the transaction's.
            let place = room(&pool, id, true, &on_wait).await.expect("a place");
            assert!(!parked(Slot::Tab(3)), "the cursor's session went");
            assert!(parked(Slot::Tab(2)), "the transaction's stays");
            let mut s = open_as(&config, id).await;
            s.hold(Box::new(place));
            busy.push(s);

            // Nothing left to close: it waits, and says so.
            let waiting = {
                let (pool, seen) = (pool.clone(), waits.clone());
                tokio::spawn(async move {
                    room(&pool, id, true, &move |w: bool| {
                        seen.lock().unwrap().push(w)
                    })
                    .await
                })
            };
            tokio::time::sleep(Duration::from_millis(300)).await;
            assert!(!waiting.is_finished(), "waits");
            assert_eq!(*waits.lock().unwrap(), vec![true]);
            // Cancelled: the wait holds nothing.
            waiting.abort();
            let _ = waiting.await;
            assert_eq!(cap.available_permits(), 0);
            // Without waiting (the Sessions tab, a schema load): no place.
            assert!(room(&pool, id, false, &|_| {}).await.is_none());

            let waiting = {
                let (pool, seen) = (pool.clone(), waits.clone());
                tokio::spawn(async move {
                    room(&pool, id, true, &move |w: bool| {
                        seen.lock().unwrap().push(w)
                    })
                    .await
                })
            };
            tokio::time::sleep(Duration::from_millis(300)).await;
            assert!(!waiting.is_finished());
            // A busy session ends: its place goes to the waiting one.
            drop(busy.pop());
            let place = tokio::time::timeout(Duration::from_secs(2), waiting)
                .await
                .expect("goes once a place frees")
                .unwrap();
            assert!(place.is_some());
            assert_eq!(*waits.lock().unwrap(), vec![true, true, false]);
            assert!(parked(Slot::Tab(2)), "the transaction's session stayed");

            // A run that finishes parks an idle session: a waiting one closes it.
            let mut s = open_as(&config, id).await;
            s.hold(Box::new(place.unwrap()));
            let waiting = {
                let pool = pool.clone();
                tokio::spawn(async move { room(&pool, id, true, &|_| {}).await })
            };
            tokio::time::sleep(Duration::from_millis(300)).await;
            assert!(!waiting.is_finished());
            give_back(&pool, "w", Slot::Tab(4), 0, s);
            let place = tokio::time::timeout(Duration::from_secs(2), waiting)
                .await
                .expect("closes the idle one")
                .unwrap();
            assert!(place.is_some());
            assert!(!parked(Slot::Tab(4)));
            assert!(parked(Slot::Tab(2)));
        });
    }
}
