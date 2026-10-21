use std::collections::HashMap;
use std::panic::{catch_unwind, AssertUnwindSafe};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::mpsc;
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::{Duration, Instant};

use rowkery_core::catalog_cache::{self, CachedCatalog};
use rowkery_core::config::{AppConfig, ConfigError, ThemePreference};
use rowkery_core::config_writer::ConfigWriter;
use rowkery_core::connections::{
    validate_postgres_target, CloudSqlCredentials, ConnectionRecord, PostgresConnection,
};
use rowkery_core::db::postgres::{
    cancel_with_token, open_session, open_session_with_secrets, session_apply_changes_within,
    session_catalog_fingerprint, session_close_cursor, session_execute, session_fetch_more,
    session_introspect, session_list_databases, session_note_statement, session_plan_facts,
    session_probe_txn, session_query_cursor, session_query_stream_with, session_server_version,
    session_table_indexes, session_test, CancelVia, DatabaseInfo, PostgresSession, StreamOptions,
    StreamStats, TxnState,
};
use rowkery_core::db::sqlite::{sqlite_version, SqliteDriver, TableCount};
use rowkery_core::db::{
    qualified_table_sql, quote_ident, table_browse_query, BrowseOptions, Driver, DriverError,
    EngineKind, RowBatch, Value,
};
use rowkery_core::db::{SchemaCatalog, TableIndexes};
use rowkery_core::edits::{
    build_row_changes, transaction_sql, ApplyCounts, ApplyFailure, Change, EditTable, RowStatement,
};
use rowkery_core::import::{ImportCounts, ImportError, ImportSpec};
use rowkery_core::plan::{self, Plan, PlanFacts};
use rowkery_core::query_util::apply_browse_limit;
use rowkery_core::safety::{
    check_sql, hold_for, pages_by_cursor, SafeMode, SafetyHold, StatementKind,
};
use rowkery_core::sample;
use rowkery_core::secrets::{
    delete_secret, delete_secrets_for_connection, ConnectionSecrets, SecretKind,
};
use rowkery_core::{CoreEvent, QueryDetail};
use tokio::runtime::{Handle, Runtime};
use tokio::sync::oneshot;
use tokio_postgres::CancelToken;

mod pool;
mod prefetch;
mod sessions;
use pool::{Lease, SharedPool, Slot};
pub use prefetch::{
    APPLICATION_NAME as PREFETCH_APPLICATION_NAME, MAX_ENTRIES as PREFETCH_MAX_ENTRIES,
    PREFETCH_ROWS,
};
pub use rowkery_core::db::postgres::{HeldLock, StopKind};
pub use sessions::{SessionRow, SessionTab, StopOutcome};

#[derive(Debug)]
#[allow(clippy::large_enum_variant)]
enum Command {
    Ping {
        respond_to: oneshot::Sender<Event>,
    },
    GetConfig {
        respond_to: oneshot::Sender<Event>,
    },
    SetTheme {
        theme: ThemePreference,
        respond_to: oneshot::Sender<Event>,
    },
    /// Saved for the next launch; the running window keeps its decorations.
    SetNativeDecorations {
        on: bool,
        respond_to: oneshot::Sender<Event>,
    },
    /// Secrets are stored by the caller first (keychain IO stays off the core thread).
    UpsertConnection {
        connection: ConnectionRecord,
        respond_to: oneshot::Sender<Event>,
    },
    DeleteConnection {
        id: String,
        respond_to: oneshot::Sender<Event>,
    },
    /// First launch decided (`sample.rs`); the caller wrote the file.
    FirstRun {
        add_sample: bool,
        respond_to: oneshot::Sender<Event>,
    },
    /// The sample's record, put back if deleted; the caller wrote the file.
    UpsertSample {
        respond_to: oneshot::Sender<(Event, ConnectionRecord)>,
    },
    OpenWindow {
        window_id: String,
        connection_id: String,
        database: Option<String>,
        respond_to: oneshot::Sender<Result<WindowOpened, String>>,
    },
    CloseWindow {
        window_id: String,
    },
    /// Pings the window's sessions idle at least `idle`, replacing dead ones;
    /// replies with how many were replaced.
    PingIdle {
        window_id: String,
        idle: Duration,
        respond_to: Option<oneshot::Sender<usize>>,
    },
    FollowKeys {
        window_id: String,
        lookups: Vec<FollowLookup>,
        /// Count the rows each lookup matches (Quick Look's Incoming) instead
        /// of reading the one it points at.
        count: bool,
        respond_to: oneshot::Sender<Result<Vec<Option<FollowRow>>, String>>,
    },
    RunWindowQuery {
        window_id: String,
        tab_id: u64,
        sql: String,
        apply_limit: Option<u32>,
        /// Rows per page when the statement can page through a cursor.
        page: Option<u32>,
        /// An export of the tab's result: reads only, run whole inside
        /// whatever the tab's session has open (its cursor stays).
        export: bool,
        /// Not the statement but its plan (⌘E), see `CoreBridge::explain`.
        explain: Option<ExplainRun>,
        confirmed: bool,
        /// Where its events go; the reply is the run's query id.
        sink: SharedSink,
        respond_to: oneshot::Sender<Result<u64, String>>,
    },
    /// The next `rows` (0: all the rest) of the tab's cursor, as a new run.
    FetchMore {
        window_id: String,
        tab_id: u64,
        rows: u32,
        sink: SharedSink,
        respond_to: oneshot::Sender<Result<u64, String>>,
    },
    CloseWindowTab {
        window_id: String,
        tab_id: u64,
    },
    /// Staged row edits, committed as one transaction on the tab's session.
    ApplyChanges {
        window_id: String,
        tab_id: u64,
        table: EditTable,
        changes: Vec<Change>,
        confirmed: Option<String>,
        respond_to: oneshot::Sender<Result<ApplyOutcome, String>>,
    },
    /// CSV import into a table, on a session (or SQLite connection) of its own.
    ImportCsv {
        window_id: String,
        spec: ImportSpec,
        cancel: Arc<AtomicBool>,
        progress: ImportProgress,
        respond_to: oneshot::Sender<Result<ImportOutcome, String>>,
    },
    /// Hover prefetch: the first page of `sql` on the window's prefetch session.
    Prefetch {
        window_id: String,
        sql: String,
        respond_to: oneshot::Sender<Result<bool, String>>,
    },
    /// The pointer left: cancel the prefetch in flight.
    CancelPrefetch {
        window_id: String,
    },
    Prefetched {
        window_id: String,
        sql: String,
        respond_to: oneshot::Sender<bool>,
    },
    CancelWindowQuery {
        window_id: String,
        tab_id: u64,
    },
    /// ⌘K "Stop all queries": every run in every window, at once.
    StopAllQueries,
    /// Whether any tab's session may hold the user's open transaction.
    HoldsTransaction {
        respond_to: oneshot::Sender<bool>,
    },
    ListDatabases {
        window_id: String,
        respond_to: oneshot::Sender<Result<Vec<DatabaseInfo>, String>>,
    },
    /// SQLite row counts, after the catalog (empty for Postgres, whose
    /// catalog carries estimates).
    TableCounts {
        window_id: String,
        respond_to: oneshot::Sender<Result<Vec<TableCount>, String>>,
    },
    TableIndexes {
        window_id: String,
        schema: String,
        tables: Vec<String>,
        respond_to: oneshot::Sender<Result<Vec<TableIndexes>, String>>,
    },
    Sessions {
        window_id: String,
        respond_to: oneshot::Sender<Result<Vec<SessionRow>, String>>,
    },
    SessionLocks {
        window_id: String,
        pid: i32,
        respond_to: oneshot::Sender<Result<Vec<HeldLock>, String>>,
    },
    StopSession {
        window_id: String,
        pid: i32,
        kind: StopKind,
        confirmed: bool,
        respond_to: oneshot::Sender<Result<StopOutcome, String>>,
    },
    ReloadWindowSchema {
        window_id: String,
        respond_to: oneshot::Sender<Result<SchemaCatalog, String>>,
    },
    ListConnections {
        respond_to: oneshot::Sender<Vec<ConnectionRecord>>,
    },
}

#[derive(Debug, Clone, PartialEq)]
pub enum Event {
    Pong,
    Config(AppConfig),
    /// The config changed: this numbered copy is for `ConfigWriter`, which
    /// the caller hands it to (the core thread never touches the disk).
    Snapshot(u64, Box<AppConfig>),
    ThemeSaved,
    ConfigError(String),
    Ok,
    Error(String),
}

#[allow(clippy::large_enum_variant)]
enum CancelHandle {
    Sqlite(rowkery_core::db::sqlite::SqliteInterruptHandle),
    Postgres { token: CancelToken, tls: CancelVia },
}

/// Events for one caller only, so concurrent window queries don't drain each
/// other's batches from the shared queue.
pub type EventQueue = Arc<Mutex<Vec<CoreEvent>>>;

/// One foreign key to follow: the row of `schema.table` whose `column` is `value`.
#[derive(Debug, Clone, serde::Deserialize)]
pub struct FollowLookup {
    pub schema: String,
    pub table: String,
    pub column: String,
    pub value: rowkery_core::db::Value,
}

/// The row a lookup found.
#[derive(Debug, Clone, PartialEq, serde::Serialize)]
pub struct FollowRow {
    pub columns: Vec<rowkery_core::db::Column>,
    pub row: Vec<rowkery_core::db::Value>,
}

/// `SELECT * … WHERE column = literal LIMIT 1`, or `None` when the value
/// can't be matched (NULL, bytes).
fn follow_sql(engine: EngineKind, lookup: &FollowLookup) -> Option<String> {
    let literal = rowkery_core::query_util::sql_literal(&lookup.value)?;
    let opts = BrowseOptions {
        filter: Some(format!(
            "{} = {literal}",
            quote_ident(engine, &lookup.column)
        )),
        order: Vec::new(),
        limit: 1,
        ..BrowseOptions::default()
    };
    Some(table_browse_query(
        engine,
        &lookup.schema,
        &lookup.table,
        &opts,
    ))
}

/// Incoming rows counted at most this far: Quick Look prints `100+` past it.
pub const INCOMING_CAP: i64 = 100;

/// How long the server may spend on one Incoming count before it reads as
/// unknown (`—`): an unindexed column of a big table scans it whole.
const INCOMING_TIMEOUT: Duration = Duration::from_millis(1500);
/// How long a Quick Look batch may take before it is cancelled.
const QUICK_LOOK_LIMIT: Duration = Duration::from_secs(5);

/// `SELECT count(*) FROM (SELECT 1 … WHERE column = literal LIMIT 101) s`:
/// how many rows reference a value, bounded so a hot key costs no more than
/// a cold one.
fn incoming_sql(engine: EngineKind, lookup: &FollowLookup) -> Option<String> {
    let literal = rowkery_core::query_util::sql_literal(&lookup.value)?;
    Some(format!(
        "SELECT count(*) AS n FROM (SELECT 1 FROM {} WHERE {} = {literal} LIMIT {}) s",
        qualified_table_sql(engine, &lookup.schema, &lookup.table),
        quote_ident(engine, &lookup.column),
        INCOMING_CAP + 1
    ))
}

fn lookup_sql(engine: EngineKind, lookup: &FollowLookup, count: bool) -> Option<String> {
    if count {
        incoming_sql(engine, lookup)
    } else {
        follow_sql(engine, lookup)
    }
}

/// First row of a single-row result, as a `FollowRow`.
fn first_row(batches: Vec<RowBatch>) -> Option<FollowRow> {
    let columns = batches.first()?.columns.clone();
    let row = batches.into_iter().flat_map(|b| b.rows).next()?;
    Some(FollowRow { columns, row })
}

/// How a commit of staged edits ended.
#[derive(Debug, Clone, PartialEq, serde::Serialize)]
#[serde(tag = "status", rename_all = "snake_case")]
pub enum ApplyOutcome {
    /// Every statement changed its one row, and the transaction committed.
    Committed {
        #[serde(flatten)]
        counts: ApplyCounts,
        elapsed_ms: u64,
    },
    /// Confirm writes: nothing ran. `sql` is the transaction to show; send
    /// it back as `confirmed` to run exactly that. Read-only: refused.
    Held { hold: SafetyHold, sql: String },
    /// Nothing was kept.
    RolledBack {
        #[serde(flatten)]
        failure: ApplyFailure,
        elapsed_ms: u64,
    },
}

/// Hears how many rows of an import were sent so far.
#[derive(Clone)]
pub struct ImportProgress(pub Arc<dyn Fn(u64) + Send + Sync>);

impl std::fmt::Debug for ImportProgress {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("ImportProgress")
    }
}

/// How a CSV import ended.
#[derive(Debug, Clone, PartialEq, serde::Serialize)]
#[serde(tag = "status", rename_all = "snake_case")]
pub enum ImportOutcome {
    /// Every row went in, in one transaction.
    Imported {
        #[serde(flatten)]
        counts: ImportCounts,
    },
    /// Rolled back: nothing was written.
    Cancelled,
    Failed {
        message: String,
    },
    /// Read-only: nothing ran.
    Refused,
}

impl From<Result<ImportCounts, ImportError>> for ImportOutcome {
    fn from(result: Result<ImportCounts, ImportError>) -> Self {
        match result {
            Ok(counts) => ImportOutcome::Imported { counts },
            Err(ImportError::Cancelled) => ImportOutcome::Cancelled,
            Err(ImportError::Failed(message)) => ImportOutcome::Failed { message },
        }
    }
}

/// The statements Review SQL shows for `changes`, and their transaction text.
#[derive(Debug, Clone, PartialEq, serde::Serialize)]
pub struct ReviewedChanges {
    pub statements: Vec<RowStatement>,
    pub sql: String,
}

/// `build_row_changes` for Review SQL: what `apply_changes` would run.
pub fn review_changes(
    engine: EngineKind,
    table: &EditTable,
    changes: &[Change],
) -> Result<ReviewedChanges, String> {
    let statements = build_row_changes(engine, table, changes)?;
    let sql = transaction_sql(&statements);
    Ok(ReviewedChanges { statements, sql })
}

/// Where a query's events go as they happen: the webview's channel
/// (rowkery-tauri forwards each as a frame), or a queue (tests).
pub trait EventSink: Send + Sync {
    fn push(&self, event: CoreEvent);
}

impl EventSink for Mutex<Vec<CoreEvent>> {
    fn push(&self, event: CoreEvent) {
        if let Ok(mut queue) = self.lock() {
            queue.push(event);
        }
    }
}

pub type SharedSink = Arc<dyn EventSink>;

impl std::fmt::Debug for dyn EventSink {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("EventSink")
    }
}

/// How a run ended when it ran.
#[derive(Debug, Clone, Copy, Default)]
struct QueryOutcome {
    row_count: u64,
    rows_affected: Option<u64>,
    cancelled: bool,
    first_row_ms: Option<u64>,
    /// A cursor page, and whether the cursor has more.
    paged: bool,
    more: bool,
    /// Rows past `MAX_TAB_ROWS` were left out.
    capped: bool,
}

impl QueryOutcome {
    fn cancelled(row_count: u64) -> Self {
        Self {
            row_count,
            cancelled: true,
            ..Self::default()
        }
    }
}

/// Why a run failed, with the server's SQLSTATE and position when it said.
#[derive(Debug, Clone, Default)]
struct QueryFailure {
    message: String,
    sqlstate: Option<String>,
    position: Option<u32>,
}

impl From<String> for QueryFailure {
    fn from(message: String) -> Self {
        Self {
            message,
            ..Self::default()
        }
    }
}

impl From<DriverError> for QueryFailure {
    fn from(err: DriverError) -> Self {
        match err {
            DriverError::Server {
                message,
                sqlstate,
                position,
            } => Self {
                message,
                sqlstate: Some(sqlstate),
                position,
            },
            other => other.into_message().into(),
        }
    }
}

type QueryResult = Result<QueryOutcome, QueryFailure>;

/// What a window points at: one saved connection on one database. Its warm
/// sessions live in the pool and close after a few idle minutes.
#[derive(Clone, Debug)]
#[allow(clippy::large_enum_variant)]
enum WindowTarget {
    Sqlite {
        connection_id: String,
        path: String,
        safe_mode: SafeMode,
    },
    Postgres {
        connection_id: String,
        config: PostgresConnection,
    },
}

/// Result of opening a window: the database it landed on and its schema.
#[derive(Clone, Debug)]
pub struct WindowOpened {
    pub database: String,
    pub catalog: SchemaCatalog,
    /// `16.4` for Postgres, the linked library's `3.46.0` for SQLite; `None`
    /// when the server would not say.
    pub server_version: Option<String>,
    pub elapsed_ms: u64,
    /// The catalog came from the disk cache; a `CatalogUpdate` with this
    /// `open_seq` follows once the server confirms or replaces it.
    pub cached: bool,
    /// Numbers this open, to match the `CatalogUpdate` that follows it.
    pub open_seq: u64,
}

/// What became of a cached catalog once the window's session opened.
#[derive(Clone, Debug, PartialEq, serde::Serialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum CatalogUpdate {
    /// Same server version and shape: the cached catalog stands.
    Confirmed { window_id: String, open_seq: u64 },
    /// The schema changed (or the server did): here is the live one.
    Replaced {
        window_id: String,
        open_seq: u64,
        catalog: SchemaCatalog,
        server_version: Option<String>,
    },
    /// The window couldn't connect after all.
    Failed {
        window_id: String,
        open_seq: u64,
        error: String,
    },
}

/// Where catalog updates go (rowkery-tauri forwards them to the webview).
pub type CatalogListener = Arc<dyn Fn(CatalogUpdate) + Send + Sync>;
type ListenerSlot = Arc<Mutex<Option<CatalogListener>>>;

fn notify_catalog(listener: &ListenerSlot, update: CatalogUpdate) {
    if let Some(f) = listener.lock().ok().and_then(|l| l.clone()) {
        f(update);
    }
}

/// When the window opened at launch had its session (or its SQLite file):
/// the `socket-warm` mark, told to a listener whenever it registers.
#[derive(Default)]
struct LaunchWarm {
    at: Option<Instant>,
    listener: Option<Box<dyn FnOnce(Instant) + Send>>,
}

type LaunchWarmSlot = Arc<Mutex<LaunchWarm>>;

fn launch_warm_reached(slot: &LaunchWarmSlot) {
    let at = Instant::now();
    let listener = match slot.lock() {
        Ok(mut warm) if warm.at.is_none() => {
            warm.at = Some(at);
            warm.listener.take()
        }
        _ => None,
    };
    if let Some(f) = listener {
        f(at);
    }
}

/// The window the app will show first, opened while the webview boots.
struct EarlyOpen {
    window_id: String,
    connection_id: String,
    database: Option<String>,
    /// The open in flight (or done); `open_window` for the same target joins it.
    done:
        futures::future::Shared<futures::future::BoxFuture<'static, Result<WindowOpened, String>>>,
    /// Its cache check's outcome, kept: it can land before the webview
    /// listens, so joining the open sends it again.
    update: Arc<Mutex<Option<CatalogUpdate>>>,
}

struct CoreState {
    /// Started at launch from the saved windows; taken by the matching `open_window`.
    early: Option<EarlyOpen>,
    /// When `early` had its session.
    launch_warm: LaunchWarmSlot,
    /// Receives catalog updates for opens answered from the cache.
    catalog_listener: ListenerSlot,
    next_open_seq: u64,
    config: AppConfig,
    /// Numbers config snapshots, so an older one never overwrites a newer.
    config_seq: u64,
    windows: HashMap<String, WindowTarget>,
    window_interrupts: HashMap<(String, u64), CancelSlot>,
    next_query_id: AtomicU64,
    /// Warm Postgres sessions per window and query tab.
    pool: SharedPool,
    /// SQLite query tabs' paged reads.
    sqlite_pages: SharedSqlitePages,
    runtime: Handle,
}

/// Cancel state for one running query. `requested` keeps a cancel that lands
/// before the worker has a live handle, so the worker can stop on its own.
/// `stop` ends a Postgres run without the server's help (`force_stop`).
#[derive(Default)]
struct CancelState {
    requested: bool,
    handle: Option<CancelHandle>,
    stop: Arc<tokio::sync::Notify>,
    /// The run is waiting for a free connection: nothing to ask the server,
    /// so a cancel stops it at once.
    waiting: bool,
}

/// The tab id the SQL line's exact count runs under: its own slot (and
/// session), so counting never touches a tab's rows or its cursor.
pub const COUNT_TAB: u64 = u64::MAX - 1;

/// How long a cancel gets to end a run before the run is stopped outright:
/// a dead socket (sleep, a network change, a dropped SSH tunnel) never
/// answers a cancel, and the query sent into it never returns.
const FORCE_STOP_AFTER: Duration = Duration::from_secs(3);

type CancelSlot = Arc<Mutex<CancelState>>;

/// Stores the worker's cancel handle. Returns `false` if a cancel was already
/// requested, in which case the worker should stop without running the query.
fn arm_cancel(slot: &CancelSlot, handle: CancelHandle) -> bool {
    match slot.lock() {
        Ok(state) if state.requested => false,
        Ok(mut state) => {
            state.handle = Some(handle);
            true
        }
        Err(_) => true,
    }
}

fn cancel_requested(slot: &CancelSlot) -> bool {
    slot.lock().map(|state| state.requested).unwrap_or(false)
}

/// Clears the worker's cancel handle. Returns whether a cancel was requested,
/// read under the same lock so none can slip in between.
fn disarm_cancel(slot: &CancelSlot) -> bool {
    match slot.lock() {
        Ok(mut state) => {
            state.handle = None;
            state.requested
        }
        Err(_) => true,
    }
}

fn push_event<S: EventSink + ?Sized>(events: &Arc<S>, event: CoreEvent) {
    events.push(event);
}

const CORE_PANIC_MESSAGE: &str = "Internal error in rowkery-core (please report this bug)";

fn with_catch<F, T>(f: F) -> Result<T, String>
where
    F: FnOnce() -> T,
{
    match catch_unwind(AssertUnwindSafe(f)) {
        Ok(value) => Ok(value),
        Err(_) => {
            eprintln!("rowkery-core: command handler panicked");
            Err(CORE_PANIC_MESSAGE.into())
        }
    }
}

/// Outcome of testing a connection that may not be saved yet.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ProbeOutcome {
    pub ok: bool,
    /// Server version on success (e.g. `PostgreSQL 16.3`), the error otherwise.
    pub message: String,
    pub elapsed_ms: u64,
}

/// Opens a throwaway session, runs `SELECT 1` and closes it. Blocks the calling
/// thread; must not run on a tokio worker.
pub fn probe_connection_blocking(
    connection: ConnectionRecord,
    secrets: ConnectionSecrets,
) -> ProbeOutcome {
    let start = Instant::now();
    let connection_id = connection.id().to_string();
    let secrets = secrets.or_stored(&connection_id);
    let (ok, message) = match connection {
        ConnectionRecord::Sqlite(sqlite) => {
            let mut driver = SqliteDriver::new(sqlite.path.clone());
            match driver.test_connection() {
                Ok(()) => (true, "SQLite".to_string()),
                Err(e) => (false, driver_error_message(e)),
            }
        }
        ConnectionRecord::Postgres(pg) => {
            let probe_id = format!("{connection_id}-probe");
            match Runtime::new() {
                Err(e) => (false, e.to_string()),
                Ok(runtime) => {
                    let test_result = with_catch(|| {
                        runtime.block_on(async {
                            let mut session =
                                open_session_with_secrets(probe_id, pg, Some(&secrets)).await?;
                            session_test(&mut session).await?;
                            Ok(session_server_version(&session).await.ok())
                        })
                    });
                    match test_result {
                        Ok(Ok(Some(version))) => (true, format!("PostgreSQL {version}")),
                        Ok(Ok(None)) => (true, "PostgreSQL".to_string()),
                        Ok(Err(e)) => (false, driver_error_message(e)),
                        Err(msg) => (false, msg),
                    }
                }
            }
        }
    };
    ProbeOutcome {
        ok,
        message,
        elapsed_ms: start.elapsed().as_millis() as u64,
    }
}

fn driver_error_message(err: DriverError) -> String {
    err.into_message()
}

/// A SQLite query tab's paged read. SQLite keeps nothing open between pages
/// (no lock stays on the file): the next page runs the statement again on a
/// new connection and steps past the rows already sent.
#[derive(Clone, Debug)]
struct SqliteCursor {
    path: String,
    sql: String,
    sent: u64,
}

/// Each SQLite tab's paged read with rows left, and the latest run on each
/// tab: only that run may leave one.
#[derive(Default)]
struct SqlitePages {
    latest: HashMap<(String, u64), u64>,
    open: HashMap<(String, u64), SqliteCursor>,
}

type SharedSqlitePages = Arc<Mutex<SqlitePages>>;

impl SqlitePages {
    /// `query_id` is now the tab's run; whatever page it had is gone.
    fn start(&mut self, key: &(String, u64), query_id: u64) -> Option<SqliteCursor> {
        self.latest.insert(key.clone(), query_id);
        self.open.remove(key)
    }

    fn forget_window(&mut self, window_id: &str) {
        self.latest.retain(|(w, _), _| w != window_id);
        self.open.retain(|(w, _), _| w != window_id);
    }

    fn forget_tab(&mut self, key: &(String, u64)) {
        self.latest.remove(key);
        self.open.remove(key);
    }
}

/// A page of a SQLite tab's read: `take` rows (0: the rest) after `skip`.
struct SqlitePageRun {
    pages: SharedSqlitePages,
    key: (String, u64),
    skip: u64,
    take: u32,
}

#[allow(clippy::too_many_arguments)]
fn run_sqlite_query_worker(
    db_path: String,
    query_id: u64,
    tab_id: u64,
    sql: String,
    apply_limit: Option<u32>,
    read_only: bool,
    events: SharedSink,
    interrupt_slot: CancelSlot,
    cap: Option<u64>,
    page: Option<SqlitePageRun>,
) {
    let start = Instant::now();
    let sql = match apply_limit {
        Some(limit) => apply_browse_limit(&sql, limit),
        None => sql,
    };

    let result = (|| -> QueryResult {
        let mut driver = SqliteDriver::new(db_path.clone()).read_only(read_only);
        driver.connect().map_err(|e| e.to_string())?;
        if let Some(handle) = driver.take_interrupt_handle() {
            if !arm_cancel(&interrupt_slot, CancelHandle::Sqlite(handle)) {
                return Ok(QueryOutcome::cancelled(0));
            }
        }
        let mut fwd = Forward::new(&events, query_id, tab_id, cap);
        let mut first_row_ms = None;
        let on_batch = |batch: RowBatch, first: bool| {
            if cancel_requested(&interrupt_slot) {
                return Err(DriverError::Cancelled);
            }
            if first_row_ms.is_none() && !batch.rows.is_empty() {
                // A local file: the first batch is a few ms after its first row.
                first_row_ms = Some(start.elapsed().as_millis() as u64);
            }
            fwd.batch(batch, first);
            Ok(())
        };

        let outcome = match &page {
            None => driver.query_stream(&sql, on_batch).map(|n| (n, None)),
            Some(p) => driver
                .query_page(&sql, p.skip, p.take, on_batch)
                .map(|(n, more)| (n, Some(more))),
        };

        match outcome {
            Ok((_, Some(more))) => {
                let more = more || fwd.capped;
                if let Some(p) = &page {
                    if let Ok(mut pages) = p.pages.lock() {
                        if more && pages.latest.get(&p.key) == Some(&query_id) {
                            pages.open.insert(
                                p.key.clone(),
                                SqliteCursor {
                                    path: db_path.clone(),
                                    sql: sql.clone(),
                                    sent: p.skip + fwd.row_count,
                                },
                            );
                        }
                    }
                }
                Ok(QueryOutcome {
                    row_count: fwd.row_count,
                    first_row_ms,
                    paged: true,
                    more,
                    capped: fwd.capped,
                    ..QueryOutcome::default()
                })
            }
            Ok((affected, None)) => Ok(if fwd.had_result_set {
                QueryOutcome {
                    row_count: fwd.row_count,
                    first_row_ms,
                    capped: fwd.capped,
                    ..QueryOutcome::default()
                }
            } else {
                QueryOutcome {
                    rows_affected: Some(affected),
                    ..QueryOutcome::default()
                }
            }),
            Err(DriverError::Cancelled) => Ok(QueryOutcome::cancelled(fwd.row_count)),
            Err(err) => Err(err.into()),
        }
    })();

    finish_query_worker(result, query_id, tab_id, start, &events);
    disarm_cancel(&interrupt_slot);
}

/// Where a window query's session comes from and goes back to.
struct PoolSlot {
    pool: SharedPool,
    window_id: String,
    generation: u64,
}

/// The most rows one run sends a tab. Past it the rest are read and left
/// out (never cancelled: a write's RETURNING still finishes, and the user's
/// transaction is untouched), and the run says `capped`. Paged loading stops
/// there too: the webview asks for no more than what is left of it.
pub const MAX_TAB_ROWS: u64 = 1_000_000;

/// Passes a run's batches on as `QueryBatch` events, counting rows, up to
/// `cap` of them.
struct Forward<'a> {
    events: &'a SharedSink,
    query_id: u64,
    tab_id: u64,
    row_count: u64,
    had_result_set: bool,
    /// `None` for an export or a plan, which keep every row.
    cap: Option<u64>,
    capped: bool,
}

impl<'a> Forward<'a> {
    fn new(events: &'a SharedSink, query_id: u64, tab_id: u64, cap: Option<u64>) -> Self {
        Self {
            events,
            query_id,
            tab_id,
            row_count: 0,
            had_result_set: false,
            cap,
            capped: false,
        }
    }

    fn batch(&mut self, mut batch: RowBatch, first: bool) {
        if batch.rows.is_empty() && !first {
            return;
        }
        if let Some(cap) = self.cap {
            let room = usize::try_from(cap.saturating_sub(self.row_count)).unwrap_or(usize::MAX);
            if batch.rows.len() > room {
                batch.rows.truncate(room);
                self.capped = true;
                if batch.rows.is_empty() && (!first || self.had_result_set) {
                    return;
                }
            }
        }
        self.had_result_set = true;
        self.row_count += batch.rows.len() as u64;
        push_event(
            self.events,
            CoreEvent::QueryBatch {
                query_id: self.query_id,
                tab_id: self.tab_id,
                batch,
                first,
            },
        );
    }

    fn outcome(&self, stats: Result<StreamStats, DriverError>) -> QueryResult {
        match stats {
            Ok(stats) if self.had_result_set => Ok(QueryOutcome {
                row_count: self.row_count,
                first_row_ms: stats.first_row.map(|d| d.as_millis() as u64),
                capped: self.capped,
                ..QueryOutcome::default()
            }),
            Ok(stats) => Ok(QueryOutcome {
                rows_affected: Some(stats.rows),
                ..QueryOutcome::default()
            }),
            Err(DriverError::Cancelled) => Ok(QueryOutcome::cancelled(self.row_count)),
            Err(err) => Err(err.into()),
        }
    }
}

/// A plan run (⌘E): estimate or timed, and where the worker leaves what the
/// hints need, before its run finishes.
#[derive(Clone, Debug)]
struct ExplainRun {
    timed: bool,
    side: Arc<Mutex<ExplainSide>>,
}

#[derive(Debug, Default)]
struct ExplainSide {
    engine: Option<EngineKind>,
    facts: PlanFacts,
}

/// What ⌘E got back.
#[derive(Debug, Clone, PartialEq, serde::Serialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum ExplainOutcome {
    Plan {
        plan: Plan,
        elapsed_ms: u64,
    },
    /// Safe mode stopped a timed plan of a write before it ran.
    Held {
        hold: SafetyHold,
    },
    Cancelled,
}

/// Collects a plan run's rows and tells the waiting caller how it ended.
struct ExplainSink {
    rows: Mutex<Vec<Vec<Value>>>,
    done: Mutex<Option<mpsc::Sender<CoreEvent>>>,
}

impl EventSink for ExplainSink {
    fn push(&self, event: CoreEvent) {
        match event {
            CoreEvent::QueryBatch { batch, .. } => {
                if let Ok(mut rows) = self.rows.lock() {
                    rows.extend(batch.rows);
                }
            }
            CoreEvent::QueryStarted { .. } | CoreEvent::QueryWaiting { .. } => {}
            done => {
                if let Some(tx) = self.done.lock().ok().and_then(|mut d| d.take()) {
                    let _ = tx.send(done);
                }
            }
        }
    }
}

/// Holds a run's events until `release`: lets the SQLite plan worker gather
/// facts after the plan comes back but before the caller hears it finished.
#[derive(Default)]
struct HeldEvents(Mutex<Vec<CoreEvent>>);

impl EventSink for HeldEvents {
    fn push(&self, event: CoreEvent) {
        if let Ok(mut q) = self.0.lock() {
            q.push(event);
        }
    }
}

/// SQLite's `EXPLAIN QUERY PLAN` rows as (id, parent, detail).
fn sqlite_plan_rows(rows: &[Vec<Value>]) -> Vec<(i64, i64, String)> {
    rows.iter()
        .filter_map(|r| match (r.first(), r.get(1), r.last()) {
            (Some(Value::Int(id)), Some(Value::Int(parent)), Some(Value::Text(d))) => {
                Some((*id, *parent, d.clone()))
            }
            _ => None,
        })
        .collect()
}

/// What a Postgres run does on its tab's session.
enum PgWork {
    /// A statement; a free-form read pages through a cursor when `page` is set.
    Query { sql: String, page: Option<u32> },
    /// The next rows of the tab's cursor.
    More { rows: u32 },
    /// A read run whole on the session as it is: an open page cursor and its
    /// transaction stay (an export of the tab's result).
    Within { sql: String },
    /// `EXPLAIN …` of a statement. A timed plan of a write runs inside a
    /// transaction (or a savepoint in the user's) that is always rolled back;
    /// then the facts the hints need are read into `side`.
    Explain {
        sql: String,
        rollback: bool,
        side: Arc<Mutex<ExplainSide>>,
    },
}

/// Runs the work on `session`, streaming batches. Returns the outcome and
/// whether any rows were sent.
async fn stream_on_session(
    session: &mut PostgresSession,
    work: &PgWork,
    query_id: u64,
    tab_id: u64,
    events: &SharedSink,
) -> (QueryResult, bool) {
    // What the tab shows is capped; an export or a plan keeps every row.
    let cap = match work {
        PgWork::Query { .. } | PgWork::More { .. } => Some(MAX_TAB_ROWS),
        PgWork::Within { .. } | PgWork::Explain { .. } => None,
    };
    let mut fwd = Forward::new(events, query_id, tab_id, cap);
    let opts = StreamOptions::default;
    let paged = |fwd: &Forward, r: Result<(StreamStats, bool), DriverError>| {
        let more = r.as_ref().is_ok_and(|(_, more)| *more);
        fwd.outcome(r.map(|(stats, _)| stats))
            .map(|o| QueryOutcome {
                paged: true,
                more,
                ..o
            })
    };
    let result = match work {
        PgWork::Query {
            sql,
            page: Some(rows),
        } if pages_by_cursor(sql) => {
            let first = session_query_cursor(session, sql, *rows, opts(), |b, first| {
                fwd.batch(b, first);
                Ok(())
            })
            .await;
            match first {
                Ok(Some(page)) => paged(&fwd, Ok(page)),
                Err(err) => paged(&fwd, Err(err)),
                // Not as a cursor (a failed or locking read in the user's
                // transaction, or Postgres won't take it as one): run it as
                // written; past MAX_TAB_ROWS its rows are left out.
                Ok(None) => {
                    let stats = session_query_stream_with(session, sql, opts(), |b, first| {
                        fwd.batch(b, first);
                        Ok(())
                    })
                    .await;
                    fwd.outcome(stats)
                }
            }
        }
        PgWork::Query { sql, .. } => {
            session_close_cursor(session).await;
            let stats = session_query_stream_with(session, sql, opts(), |b, first| {
                fwd.batch(b, first);
                Ok(())
            })
            .await;
            session_note_statement(session, reads_only(sql));
            fwd.outcome(stats)
        }
        PgWork::Within { sql } => {
            let stats = session_query_stream_with(session, sql, opts(), |b, first| {
                fwd.batch(b, first);
                Ok(())
            })
            .await;
            fwd.outcome(stats)
        }
        PgWork::More { rows } => {
            let more = session_fetch_more(session, *rows, opts(), |b, first| {
                fwd.batch(b, first);
                Ok(())
            })
            .await;
            paged(&fwd, more)
        }
        PgWork::Explain {
            sql,
            rollback,
            side,
        } => {
            session_close_cursor(session).await;
            // In the user's own transaction a savepoint keeps it as it was.
            let within_users = *rollback
                && match session.txn_state() {
                    TxnState::Users => true,
                    TxnState::None => false,
                    TxnState::Unknown => {
                        session_probe_txn(session, Duration::from_secs(5)).await == TxnState::Users
                    }
                };
            let (begin, end) = if within_users {
                (
                    "SAVEPOINT rowkery_explain",
                    "ROLLBACK TO SAVEPOINT rowkery_explain; RELEASE SAVEPOINT rowkery_explain",
                )
            } else {
                ("BEGIN", "ROLLBACK")
            };
            if *rollback {
                if let Err(err) = session_execute(session, begin).await {
                    return (fwd.outcome(Err(err)), false);
                }
            }
            let mut text = String::new();
            let stats = session_query_stream_with(session, sql, opts(), |b, first| {
                if let Some(Value::Text(t)) = b.rows.first().and_then(|r| r.first()) {
                    text.push_str(t);
                }
                fwd.batch(b, first);
                Ok(())
            })
            .await;
            if *rollback {
                let ended = session_execute(session, end).await;
                if ended.is_err() && stats.is_ok() {
                    return (fwd.outcome(ended.map(|_| StreamStats::default())), true);
                }
            }
            if stats.is_ok() {
                let tables = serde_json::from_str(&text)
                    .ok()
                    .and_then(|json| plan::parse_pg(&json).ok())
                    .map(|p| plan::tables(&p))
                    .unwrap_or_default();
                let facts = session_plan_facts(session, &tables).await;
                if let Ok(mut side) = side.lock() {
                    side.facts = facts;
                }
            }
            fwd.outcome(stats)
        }
    };
    (result, fwd.had_result_set)
}

/// Every statement only reads: it can't open or end a transaction.
fn reads_only(sql: &str) -> bool {
    let checks = check_sql(sql);
    !checks.is_empty() && checks.iter().all(|c| c.kind == StatementKind::Read)
}

/// Safe to send again after the connection dropped under it: it can't have
/// changed anything.
fn is_read_only(sql: &str) -> bool {
    let lower = sql.trim_start().to_ascii_lowercase();
    ["select", "show", "explain", "table", "values"]
        .iter()
        .any(|kw| lower.starts_with(kw))
        && !lower.contains("explain analyze")
}

#[allow(clippy::too_many_arguments)]
fn run_postgres_query_on_runtime(
    runtime: Handle,
    connection_id: String,
    config: PostgresConnection,
    pooled: PoolSlot,
    query_id: u64,
    tab_id: u64,
    work: PgWork,
    apply_limit: Option<u32>,
    events: SharedSink,
    interrupt_slot: CancelSlot,
) {
    let start = Instant::now();
    let work = match (work, apply_limit) {
        (PgWork::Query { sql, page }, Some(limit)) => PgWork::Query {
            sql: apply_browse_limit(&sql, limit),
            page,
        },
        (work, _) => work,
    };
    let stop = interrupt_slot
        .lock()
        .map(|s| s.stop.clone())
        .unwrap_or_default();
    let stopped_events = events.clone();
    let stopped_pool = (pooled.pool.clone(), pooled.window_id.clone());
    let (stopped_connection, stopped_config) = (connection_id.clone(), config.clone());
    let stopped_slot = interrupt_slot.clone();
    let run = async move {
        let mut attempt = 0;
        // Every connection the saved connection may hold is busy: the tab
        // says it is waiting for one, and a cancel stops the wait at once.
        let on_wait = |waiting: bool| {
            if let Ok(mut state) = interrupt_slot.lock() {
                state.waiting = waiting;
            }
            push_event(
                &events,
                CoreEvent::QueryWaiting {
                    query_id,
                    tab_id,
                    waiting,
                },
            );
        };
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
            // `_out` holds the tab's slot until the session is given back.
            let Lease {
                mut session,
                reused,
                out: _out,
            } = match leased {
                Ok(lease) => lease,
                Err(err) => {
                    finish_query_worker(Err(err.into()), query_id, tab_id, start, &events);
                    disarm_cancel(&interrupt_slot);
                    return;
                }
            };
            // Cancel targets the backend of the session this run is on.
            let handle = CancelHandle::Postgres {
                token: session.cancel_token.clone(),
                tls: session.cancel_via.clone(),
            };
            if !arm_cancel(&interrupt_slot, handle) {
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
                return;
            }
            let (result, sent_rows) =
                stream_on_session(&mut session, &work, query_id, tab_id, &events).await;

            // A warm session whose socket died while parked (server restart,
            // network change) fails before anything ran: try once more on a
            // fresh one when the statement can't have changed anything. Never
            // when it may have held the user's transaction: a fresh session
            // would run outside it (the next run says the transaction is gone).
            if result.is_err()
                && reused
                && attempt == 1
                && !sent_rows
                && session.is_closed()
                && session.txn_state() == TxnState::None
                && matches!(&work, PgWork::Query { sql, .. } if is_read_only(sql))
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
            // After a cancel the request may still be on its way to this
            // backend; parking the session could let it hit the next run.
            if !cancelled {
                // A statement that may have opened or ended a transaction:
                // ask which, off the result's path, so the pool knows
                // whether this session may ever be closed on its own.
                if matches!(&work, PgWork::Query { sql, .. } if !reads_only(sql)) {
                    pool::settle_txn(&mut session).await;
                }
                pool::give_back(
                    &pooled.pool,
                    &pooled.window_id,
                    Slot::Tab(tab_id),
                    pooled.generation,
                    session,
                );
            }
            return;
        }
    };
    runtime.spawn(async move {
        tokio::select! {
            // A run that has finished wins over a stop that arrives with it.
            biased;
            _ = run => {}
            _ = stop.notified() => {
                // The run (and its session, socket and any transaction of
                // ours, which the server rolls back) is dropped here.
                finish_query_worker(
                    Ok(QueryOutcome::cancelled(0)),
                    query_id,
                    tab_id,
                    start,
                    &stopped_events,
                );
                // Stopped while waiting for a free connection: nothing hung.
                let waited = stopped_slot
                    .lock()
                    .map(|mut s| std::mem::take(&mut s.waiting))
                    .unwrap_or(false);
                if waited {
                    return;
                }
                // The socket that hung may not be the only dead one: check
                // the window's parked sessions now, so the next run doesn't
                // find another (the prefetch session goes rather than waits).
                let (pool, window_id) = stopped_pool;
                if let Some(f) = pool.lock().ok().and_then(|p| p.existing_prefetcher(&window_id)) {
                    f.drop_if_idle(Duration::ZERO);
                }
                pool::ping_idle(&pool, &window_id, Duration::ZERO, stopped_connection, stopped_config)
                    .await;
            }
        }
    });
}

/// How long saving edits waits for the tab's session, for `BEGIN`, and for
/// each statement, before it stops and rolls back. `COMMIT` has no limit.
const APPLY_STEP_TIMEOUT: Duration = if cfg!(test) {
    Duration::from_secs(2)
} else {
    Duration::from_secs(20)
};

/// A write in the window: no prefetched page may be served again, and the
/// prefetch transaction ends, so its cursors' locks don't hold up DDL.
fn invalidate_prefetch(pool: &SharedPool, window_id: &str, runtime: &Handle) {
    if let Some(f) = pool
        .lock()
        .ok()
        .and_then(|p| p.existing_prefetcher(window_id))
    {
        f.invalidate();
        runtime.spawn(async move { f.release().await });
    }
}

/// A write's events, passed on; when it ends (committed, failed or stopped)
/// the window's prefetched pages are dropped again, since one taken while it
/// was in flight read the rows from before it.
struct InvalidateOnFinish {
    inner: SharedSink,
    pool: SharedPool,
    window_id: String,
    runtime: Handle,
}

impl EventSink for InvalidateOnFinish {
    fn push(&self, event: CoreEvent) {
        if matches!(event, CoreEvent::QueryFinished { .. }) {
            invalidate_prefetch(&self.pool, &self.window_id, &self.runtime);
        }
        self.inner.push(event);
    }
}

/// Builds the statements, asks safe mode, then runs them as one transaction:
/// on SQLite on a fresh connection, on Postgres on the tab's own session.
#[allow(clippy::too_many_arguments)]
fn apply_changes_now(
    state: &mut CoreState,
    window_id: String,
    tab_id: u64,
    table: EditTable,
    changes: Vec<Change>,
    confirmed: Option<String>,
    respond_to: oneshot::Sender<Result<ApplyOutcome, String>>,
) {
    let Some(target) = state.windows.get(&window_id).cloned() else {
        let _ = respond_to.send(Err("This window is not connected".into()));
        return;
    };
    let (engine, safe_mode) = match &target {
        WindowTarget::Sqlite { safe_mode, .. } => (EngineKind::Sqlite, *safe_mode),
        WindowTarget::Postgres { config, .. } => (EngineKind::Postgres, config.safe_mode),
    };
    let statements = match build_row_changes(engine, &table, &changes) {
        Ok(s) if s.is_empty() => {
            let _ = respond_to.send(Err("Nothing to commit".into()));
            return;
        }
        Ok(s) => s,
        Err(err) => {
            let _ = respond_to.send(Err(err));
            return;
        }
    };
    let sql = transaction_sql(&statements);
    // A confirmation covers the text the user saw, and nothing else.
    if confirmed.as_ref().is_some_and(|seen| *seen != sql) {
        let _ = respond_to.send(Err(
            "The changes moved since you confirmed them. Review them again.".into(),
        ));
        return;
    }
    if let Some(hold) = hold_for(safe_mode, &sql, confirmed.is_some()) {
        let _ = respond_to.send(Ok(ApplyOutcome::Held { hold, sql }));
        return;
    }
    // A write in the window: no prefetched page may be served again.
    invalidate_prefetch(&state.pool, &window_id, &state.runtime);
    let start = Instant::now();
    let outcome = move |result: Result<ApplyCounts, ApplyFailure>| {
        let elapsed_ms = start.elapsed().as_millis() as u64;
        match result {
            Ok(counts) => ApplyOutcome::Committed { counts, elapsed_ms },
            Err(failure) => ApplyOutcome::RolledBack {
                failure,
                elapsed_ms,
            },
        }
    };
    match target {
        WindowTarget::Sqlite { path, .. } => {
            thread::spawn(move || {
                let result = with_catch(|| {
                    let mut driver = SqliteDriver::new(path);
                    driver.connect().map_err(driver_error_message)?;
                    Ok(driver.apply_changes(&statements))
                })
                .and_then(|r| r);
                let _ = respond_to.send(result.map(outcome));
            });
        }
        WindowTarget::Postgres {
            connection_id,
            config,
        } => {
            let pool = state.pool.clone();
            let generation = pool.lock().map(|p| p.generation(&window_id)).unwrap_or(0);
            let runtime = state.runtime.clone();
            state.runtime.spawn(async move {
                // The tab's own session, waiting (boundedly) for a run on it
                // to end, or for a free connection.
                let no_room = std::sync::atomic::AtomicBool::new(false);
                let leased = tokio::time::timeout(
                    APPLY_STEP_TIMEOUT,
                    pool::lease_or_wait(
                        &pool,
                        &window_id,
                        Slot::Tab(tab_id),
                        generation,
                        connection_id,
                        config,
                        &|waiting| {
                            if waiting {
                                no_room.store(true, Ordering::SeqCst);
                            }
                        },
                    ),
                )
                .await
                .unwrap_or_else(|_| {
                    Err(DriverError::Message(if no_room.load(Ordering::SeqCst) {
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
                } = match leased {
                    Ok(lease) => lease,
                    Err(err) => {
                        let _ = respond_to.send(Err(err.into_message()));
                        return;
                    }
                };
                // BEGIN and each statement are bounded; COMMIT is not (and
                // is never retried).
                let result =
                    session_apply_changes_within(&mut session, &statements, Some(APPLY_STEP_TIMEOUT))
                        .await;
                // Committed (or not): a page prefetched meanwhile read the
                // rows from before.
                invalidate_prefetch(&pool, &window_id, &runtime);
                // A step timed out and even the rollback didn't answer: the
                // session goes (the server rolls ours back), never reused.
                if session.txn_state() != TxnState::Unknown {
                    pool::give_back(&pool, &window_id, Slot::Tab(tab_id), generation, session);
                }
                let _ = respond_to.send(Ok(outcome(result)));
            });
        }
    }
}

/// Imports a CSV file in one transaction on a connection of the import's
/// own (never a tab's session, so never inside the user's transaction).
/// Read-only refuses; under Confirm writes the panel's Import button was
/// the confirmation.
fn import_csv_now(
    state: &mut CoreState,
    window_id: String,
    spec: ImportSpec,
    cancel: Arc<AtomicBool>,
    progress: ImportProgress,
    respond_to: oneshot::Sender<Result<ImportOutcome, String>>,
) {
    let Some(target) = state.windows.get(&window_id).cloned() else {
        let _ = respond_to.send(Err("This window is not connected".into()));
        return;
    };
    let safe_mode = match &target {
        WindowTarget::Sqlite { safe_mode, .. } => *safe_mode,
        WindowTarget::Postgres { config, .. } => config.safe_mode,
    };
    if safe_mode == SafeMode::ReadOnly {
        let _ = respond_to.send(Ok(ImportOutcome::Refused));
        return;
    }
    invalidate_prefetch(&state.pool, &window_id, &state.runtime);
    match target {
        WindowTarget::Sqlite { path, .. } => {
            thread::spawn(move || {
                let result = with_catch(|| {
                    rowkery_core::import::import_sqlite_file(&path, &spec, &cancel, &*progress.0)
                });
                let _ = respond_to.send(result.map(ImportOutcome::from));
            });
        }
        WindowTarget::Postgres {
            connection_id,
            config,
        } => {
            let pool = state.pool.clone();
            let generation = pool.lock().map(|p| p.generation(&window_id)).unwrap_or(0);
            let runtime = state.runtime.clone();
            state.runtime.spawn(async move {
                let Lease { session, .. } = match pool::lease(
                    &pool,
                    &window_id,
                    Slot::Import,
                    generation,
                    connection_id,
                    config,
                )
                .await
                {
                    Ok(lease) => lease,
                    Err(err) => {
                        let _ = respond_to.send(Err(err.into_message()));
                        return;
                    }
                };
                let result =
                    rowkery_core::import::import_postgres(&session, &spec, cancel, &*progress.0)
                        .await;
                // Written (or not): a page prefetched meanwhile read the rows from before.
                invalidate_prefetch(&pool, &window_id, &runtime);
                if !session.is_closed() {
                    pool::give_back(&pool, &window_id, Slot::Import, generation, session);
                }
                let _ = respond_to.send(Ok(result.into()));
            });
        }
    }
}

fn finish_query_worker<S: EventSink + ?Sized>(
    result: QueryResult,
    query_id: u64,
    tab_id: u64,
    start: Instant,
    events: &Arc<S>,
) {
    let elapsed_ms = start.elapsed().as_millis() as u64;
    let event = match result {
        Ok(outcome) => CoreEvent::QueryFinished {
            query_id,
            tab_id,
            row_count: outcome.row_count,
            rows_affected: outcome.rows_affected,
            elapsed_ms,
            error: outcome.cancelled.then(|| "Query cancelled".to_string()),
            cancelled: outcome.cancelled,
            detail: QueryDetail {
                first_row_ms: outcome.first_row_ms,
                paged: outcome.paged,
                more: outcome.more,
                capped: outcome.capped,
                ..QueryDetail::default()
            },
        },
        Err(failure) => CoreEvent::QueryFinished {
            query_id,
            tab_id,
            row_count: 0,
            rows_affected: None,
            elapsed_ms,
            error: Some(failure.message),
            cancelled: false,
            detail: QueryDetail {
                sqlstate: failure.sqlstate,
                error_position: failure.position,
                ..QueryDetail::default()
            },
        },
    };
    push_event(events, event);
}

/// Resolves a saved connection to a window target, on `database` when given
/// (Postgres needs a new session per database, so this just swaps the name).
fn window_target(
    state: &CoreState,
    connection_id: &str,
    database: Option<String>,
) -> Result<WindowTarget, String> {
    let record = state
        .config
        .connections
        .iter()
        .find(|c| c.id() == connection_id)
        .cloned()
        .ok_or_else(|| "Connection not found".to_string())?;
    match record {
        ConnectionRecord::Sqlite(sqlite) => Ok(WindowTarget::Sqlite {
            connection_id: connection_id.to_string(),
            path: sqlite.path,
            safe_mode: sqlite.safe_mode,
        }),
        ConnectionRecord::Postgres(mut pg) => {
            if let Some(db) = database.filter(|d| !d.trim().is_empty()) {
                pg.database = db;
            }
            validate_postgres_target(&pg)?;
            Ok(WindowTarget::Postgres {
                connection_id: connection_id.to_string(),
                config: pg,
            })
        }
    }
}

/// Opens a SQLite file and reads its schema (blocking).
fn load_sqlite_catalog(path: String) -> Result<SchemaCatalog, String> {
    with_catch(|| {
        let mut driver = SqliteDriver::new(path);
        driver.connect()?;
        driver.introspect_catalog()
    })
    .and_then(|r| r.map_err(driver_error_message))
}

/// Connects and loads the schema off the core thread, then parks the session
/// as the window's spare (closed if nothing uses it for a while).
/// The active window of the saved UI state (`rowkery.windows` in persist.ts):
/// its id as the webview names it (`w1`, `w2`… by position), connection and
/// database.
fn saved_active_window(ui: &serde_json::Value) -> Option<(String, String, Option<String>)> {
    let saved = ui.get("keys")?.get("rowkery.windows")?;
    let windows = saved.get("windows")?.as_array()?;
    let active = saved.get("active").and_then(|a| a.as_u64()).unwrap_or(0) as usize;
    let w = windows.get(active)?;
    let connection_id = w.get("connectionId")?.as_str()?.to_string();
    let database = w
        .get("database")
        .and_then(|d| d.as_str())
        .map(str::to_string);
    Some((format!("w{}", active + 1), connection_id, database))
}

/// Starts opening the window the app will show first (session, catalog,
/// server version) before the webview has asked, so the socket is warm and
/// the schema loaded by the time it does.
fn start_early_open(state: &mut CoreState, ui: Option<&serde_json::Value>) {
    let Some((window_id, connection_id, database)) = ui.and_then(saved_active_window) else {
        return;
    };
    let Ok(target) = window_target(state, &connection_id, database.clone()) else {
        return;
    };
    state.windows.insert(window_id.clone(), target.clone());
    let (generation, stale) = match state.pool.lock() {
        Ok(mut pool) => pool.reset_window(&window_id),
        Err(_) => (0, Vec::new()),
    };
    drop(stale);
    let (tx, rx) = oneshot::channel();
    state.next_open_seq += 1;
    // Records the update as well as forwarding it (see `EarlyOpen::update`).
    let update: Arc<Mutex<Option<CatalogUpdate>>> = Arc::default();
    let recording: ListenerSlot = {
        let (update, forward) = (update.clone(), state.catalog_listener.clone());
        Arc::new(Mutex::new(Some(Arc::new(move |u: CatalogUpdate| {
            if let Ok(mut kept) = update.lock() {
                *kept = Some(u.clone());
            }
            notify_catalog(&forward, u);
        }) as CatalogListener)))
    };
    spawn_open_window(
        &state.runtime,
        target,
        PoolSlot {
            pool: state.pool.clone(),
            window_id: window_id.clone(),
            generation,
        },
        state.next_open_seq,
        recording,
        tx,
        Some(state.launch_warm.clone()),
    );
    use futures::FutureExt;
    let done = rx
        .map(|r| r.unwrap_or_else(|_| Err("open cancelled".into())))
        .boxed()
        .shared();
    state.early = Some(EarlyOpen {
        window_id,
        connection_id,
        database,
        done,
        update,
    });
}

/// Points a window at a connection (and database), resetting its sessions,
/// and loads its schema.
fn open_window_now(
    state: &mut CoreState,
    window_id: String,
    connection_id: String,
    database: Option<String>,
    respond_to: oneshot::Sender<Result<WindowOpened, String>>,
) {
    match window_target(state, &connection_id, database) {
        Err(msg) => {
            let _ = respond_to.send(Err(msg));
        }
        Ok(target) => {
            state.windows.insert(window_id.clone(), target.clone());
            // Re-pointing drops the old target's warm sessions.
            let (generation, stale) = match state.pool.lock() {
                Ok(mut pool) => pool.reset_window(&window_id),
                Err(_) => (0, Vec::new()),
            };
            drop(stale);
            let slot = PoolSlot {
                pool: state.pool.clone(),
                window_id,
                generation,
            };
            state.next_open_seq += 1;
            spawn_open_window(
                &state.runtime,
                target,
                slot,
                state.next_open_seq,
                state.catalog_listener.clone(),
                respond_to,
                None,
            );
        }
    }
}

/// Forgets a window, closes its sessions and cancels its queries.
fn close_window_now(state: &mut CoreState, window_id: String) {
    state.windows.remove(&window_id);
    if let Ok(mut pages) = state.sqlite_pages.lock() {
        pages.forget_window(&window_id);
    }
    let stale = state
        .pool
        .lock()
        .map(|mut pool| pool.close_window(&window_id))
        .unwrap_or_default();
    drop(stale);
    let tabs: Vec<(String, u64)> = state
        .window_interrupts
        .keys()
        .filter(|(w, _)| *w == window_id)
        .cloned()
        .collect();
    for key in tabs {
        if let Some(slot) = state.window_interrupts.remove(&key) {
            request_cancel(&state.runtime, &slot);
        }
    }
}

#[allow(clippy::too_many_arguments)]
fn spawn_open_window(
    runtime: &Handle,
    target: WindowTarget,
    slot: PoolSlot,
    open_seq: u64,
    listener: ListenerSlot,
    respond_to: oneshot::Sender<Result<WindowOpened, String>>,
    // The window opened at launch: its session's moment is the `socket-warm` mark.
    warm: Option<LaunchWarmSlot>,
) {
    let start = Instant::now();
    match target {
        WindowTarget::Sqlite { path, .. } => {
            thread::spawn(move || {
                let result = load_sqlite_catalog(path);
                if let (Some(warm), Ok(_)) = (&warm, &result) {
                    launch_warm_reached(warm);
                }
                let result = result.map(|catalog| WindowOpened {
                    database: "main".into(),
                    catalog,
                    server_version: Some(sqlite_version().to_string()),
                    elapsed_ms: start.elapsed().as_millis() as u64,
                    cached: false,
                    open_seq,
                });
                let _ = respond_to.send(result);
            });
        }
        WindowTarget::Postgres {
            connection_id,
            config,
        } => {
            let database = config.database.clone();
            // The schema this window showed last time, at once; the server
            // confirms or replaces it below, off the reply's path.
            let cached = catalog_cache::load(&connection_id, &database);
            let mut respond_to = Some(respond_to);
            if let Some(c) = &cached {
                if let Some(tx) = respond_to.take() {
                    let _ = tx.send(Ok(WindowOpened {
                        database: database.clone(),
                        catalog: c.catalog.clone(),
                        server_version: c.server_version.clone(),
                        elapsed_ms: start.elapsed().as_millis() as u64,
                        cached: true,
                        open_seq,
                    }));
                }
            }
            let window_id = slot.window_id.clone();
            runtime.spawn(async move {
                let result = async {
                    let session = open_session(connection_id.clone(), config).await?;
                    if let Some(warm) = &warm {
                        launch_warm_reached(warm);
                    }
                    // One pipelined round trip: is the cache still the catalog?
                    let (version, fingerprint) = tokio::join!(
                        session_server_version(&session),
                        session_catalog_fingerprint(&session),
                    );
                    let version = version.ok();
                    let fingerprint = fingerprint.ok();
                    let still = matches!(
                        (&cached, &fingerprint),
                        (Some(c), Some(fp)) if c.matches(version.as_deref(), fp)
                    );
                    let catalog = if still {
                        None
                    } else {
                        let catalog = session_introspect(&session).await?;
                        if let Some(fp) = &fingerprint {
                            catalog_cache::store(
                                &connection_id,
                                &database,
                                &CachedCatalog::new(version.clone(), fp.clone(), catalog.clone()),
                            );
                        }
                        Some(catalog)
                    };
                    // Kept warm for the window's first query.
                    pool::give_back(
                        &slot.pool,
                        &slot.window_id,
                        Slot::Spare,
                        slot.generation,
                        session,
                    );
                    Ok::<_, DriverError>((catalog, version))
                }
                .await
                .map_err(driver_error_message);
                match (respond_to, result) {
                    // Not cached: the reply waited for the catalog.
                    (Some(tx), result) => {
                        let _ = tx.send(result.map(|(catalog, server_version)| WindowOpened {
                            database,
                            catalog: catalog.unwrap_or_default(),
                            server_version,
                            elapsed_ms: start.elapsed().as_millis() as u64,
                            cached: false,
                            open_seq,
                        }));
                    }
                    // Answered from the cache: say what the server said.
                    (None, Ok((None, _))) => notify_catalog(
                        &listener,
                        CatalogUpdate::Confirmed {
                            window_id,
                            open_seq,
                        },
                    ),
                    (None, Ok((Some(catalog), server_version))) => notify_catalog(
                        &listener,
                        CatalogUpdate::Replaced {
                            window_id,
                            open_seq,
                            catalog,
                            server_version,
                        },
                    ),
                    (None, Err(error)) => notify_catalog(
                        &listener,
                        CatalogUpdate::Failed {
                            window_id,
                            open_seq,
                            error,
                        },
                    ),
                }
            });
        }
    }
}

/// Marks a query cancelled and interrupts it if its worker is running.
/// Asks the run to stop: SQLite is interrupted; Postgres gets a cancel
/// request, and if the run hasn't ended `FORCE_STOP_AFTER` later (or this is
/// the second ask) it is stopped outright.
fn request_cancel(runtime: &Handle, slot: &CancelSlot) {
    if let Ok(mut guard) = slot.lock() {
        let again = guard.requested;
        guard.requested = true;
        let stop = guard.stop.clone();
        match guard.handle.take() {
            Some(CancelHandle::Sqlite(handle)) => handle.interrupt(),
            Some(CancelHandle::Postgres { token, tls }) => {
                runtime.spawn(async move {
                    // The cancel itself can hang on a dead tunnel; it gets
                    // the same time as the run.
                    let _ =
                        tokio::time::timeout(FORCE_STOP_AFTER, cancel_with_token(token, tls)).await;
                });
                runtime.spawn(async move {
                    tokio::time::sleep(FORCE_STOP_AFTER).await;
                    stop.notify_one();
                });
            }
            // Asked twice, or waiting for a free connection: stop now.
            None if again || guard.waiting => stop.notify_one(),
            None => {
                runtime.spawn(async move {
                    tokio::time::sleep(FORCE_STOP_AFTER).await;
                    stop.notify_one();
                });
            }
        }
    }
}

/// Stops a run at once, without waiting for the server (⌘K "Stop all queries").
/// Runs `work` on the runtime for a Postgres window; a SQLite window has no
/// server sessions to show.
fn with_postgres<T, F, Fut>(
    state: &CoreState,
    window_id: String,
    respond_to: oneshot::Sender<Result<T, String>>,
    work: F,
) where
    T: Send + 'static,
    F: FnOnce(sessions::Target) -> Fut,
    Fut: std::future::Future<Output = Result<T, DriverError>> + Send + 'static,
{
    match state.windows.get(&window_id).cloned() {
        None => {
            let _ = respond_to.send(Err("This window is not connected".into()));
        }
        Some(WindowTarget::Sqlite { .. }) => {
            let _ = respond_to.send(Err("SQLite has no other sessions to show".into()));
        }
        Some(WindowTarget::Postgres {
            connection_id,
            config,
        }) => {
            let pool = state.pool.clone();
            let generation = pool.lock().map(|p| p.generation(&window_id)).unwrap_or(0);
            let work = work(sessions::Target {
                pool,
                window_id,
                generation,
                connection_id,
                config,
            });
            state.runtime.spawn(async move {
                let _ = respond_to.send(work.await.map_err(driver_error_message));
            });
        }
    }
}

fn force_stop(runtime: &Handle, slot: &CancelSlot) {
    request_cancel(runtime, slot);
    if let Ok(guard) = slot.lock() {
        guard.stop.notify_one();
    }
}

pub struct CoreBridge {
    command_tx: mpsc::Sender<Command>,
    /// Owns every write of config.json (connections, theme, UI state).
    writer: ConfigWriter,
    /// The webview's UI state as last published (or loaded), for a reload.
    ui: Arc<Mutex<Option<serde_json::Value>>>,
    catalog_listener: ListenerSlot,
    launch_warm: LaunchWarmSlot,
}

/// The config as it is now, numbered, for the caller to write.
fn config_snapshot(state: &mut CoreState) -> Event {
    state.config_seq += 1;
    Event::Snapshot(state.config_seq, Box::new(state.config.clone()))
}

fn dispatch_command(state: &mut CoreState, command: Command) {
    match command {
        Command::Ping { respond_to } => {
            let _ = respond_to.send(Event::Pong);
        }
        Command::GetConfig { respond_to } => {
            let _ = respond_to.send(Event::Config(state.config.clone()));
        }
        Command::SetTheme { theme, respond_to } => {
            state.config.theme = theme;
            let _ = respond_to.send(config_snapshot(state));
        }
        Command::SetNativeDecorations { on, respond_to } => {
            state.config.native_decorations = on;
            let _ = respond_to.send(config_snapshot(state));
        }
        Command::UpsertConnection {
            connection,
            respond_to,
        } => {
            let event = {
                // Open windows follow a changed safe mode on their next run.
                // Warm Postgres sessions were opened under the old mode
                // (read-only or not), so those windows start fresh ones.
                let (id, mode) = (connection.id().to_string(), connection.safe_mode());
                let mut stale = Vec::new();
                for (window_id, target) in state.windows.iter_mut() {
                    match target {
                        WindowTarget::Sqlite {
                            connection_id,
                            safe_mode,
                            ..
                        } if *connection_id == id => *safe_mode = mode,
                        WindowTarget::Postgres {
                            connection_id,
                            config,
                        } if *connection_id == id && config.safe_mode != mode => {
                            config.safe_mode = mode;
                            if let Ok(mut pool) = state.pool.lock() {
                                stale.extend(pool.reset_window(window_id).1);
                            }
                        }
                        _ => {}
                    }
                }
                drop(stale);
                state.config.upsert_connection(connection);
                config_snapshot(state)
            };
            let _ = respond_to.send(event);
        }
        Command::FirstRun {
            add_sample,
            respond_to,
        } => {
            sample::apply_first_run(&mut state.config, add_sample);
            let _ = respond_to.send(config_snapshot(state));
        }
        Command::UpsertSample { respond_to } => {
            let record = sample::upsert_sample(&mut state.config);
            let _ = respond_to.send((config_snapshot(state), record));
        }
        Command::DeleteConnection { id, respond_to } => {
            state.config.remove_connection(&id);
            let _ = respond_to.send(config_snapshot(state));
        }
        Command::OpenWindow {
            window_id,
            connection_id,
            database,
            respond_to,
        } => {
            // The window opened at launch: join it instead of starting over.
            if let Some(early) = state.early.take() {
                let same = early.window_id == window_id
                    && early.connection_id == connection_id
                    && (database.is_none() || database == early.database)
                    && state.windows.contains_key(&window_id);
                if same {
                    let listener = state.catalog_listener.clone();
                    state.runtime.spawn(async move {
                        let _ = respond_to.send(early.done.await);
                        // A check that finished while the webview booted was
                        // sent to no one: say it again now the reply is out.
                        // The webview drops it if it already had it.
                        let kept = early.update.lock().ok().and_then(|u| u.clone());
                        if let Some(update) = kept {
                            notify_catalog(&listener, update);
                        }
                    });
                    return;
                }
            }
            open_window_now(state, window_id, connection_id, database, respond_to);
        }
        Command::CloseWindow { window_id } => {
            if state
                .early
                .as_ref()
                .is_some_and(|e| e.window_id == window_id)
            {
                state.early = None;
            }
            close_window_now(state, window_id);
        }
        Command::PingIdle {
            window_id,
            idle,
            respond_to,
        } => {
            let replaced = match state.windows.get(&window_id).cloned() {
                Some(WindowTarget::Postgres {
                    connection_id,
                    config,
                }) => Some((connection_id, config)),
                _ => None,
            };
            let Some((connection_id, config)) = replaced else {
                if let Some(tx) = respond_to {
                    let _ = tx.send(0);
                }
                return;
            };
            // The prefetch session isn't pinged: one idle that long goes (its
            // pages are stale by then), and the next prefetch opens a fresh one.
            if let Some(f) = state
                .pool
                .lock()
                .ok()
                .and_then(|p| p.existing_prefetcher(&window_id))
            {
                f.drop_if_idle(idle);
            }
            let pool = state.pool.clone();
            state.runtime.spawn(async move {
                let n = pool::ping_idle(&pool, &window_id, idle, connection_id, config).await;
                if let Some(tx) = respond_to {
                    let _ = tx.send(n);
                }
            });
        }
        Command::FollowKeys {
            window_id,
            lookups,
            count,
            respond_to,
        } => {
            match state.windows.get(&window_id).cloned() {
                None => {
                    let _ = respond_to.send(Err("This window is not connected".into()));
                }
                Some(WindowTarget::Sqlite { path, .. }) => {
                    thread::spawn(move || {
                        let result = (|| {
                            let mut driver = SqliteDriver::new(path).read_only(true);
                            driver.connect().map_err(driver_error_message)?;
                            Ok(lookups
                                .iter()
                                .map(|l| {
                                    let sql = lookup_sql(EngineKind::Sqlite, l, count)?;
                                    let mut batches = Vec::new();
                                    driver
                                        .query_stream(&sql, |b, _| {
                                            batches.push(b);
                                            Ok(())
                                        })
                                        .ok()?;
                                    first_row(batches)
                                })
                                .collect())
                        })();
                        let _ = respond_to.send(result);
                    });
                }
                Some(WindowTarget::Postgres {
                    connection_id,
                    config,
                }) => {
                    let pool = state.pool.clone();
                    let (generation, latest) = pool
                        .lock()
                        .map(|mut p| (p.generation(&window_id), p.quick_look_seq(&window_id)))
                        .unwrap_or_default();
                    // A newer batch supersedes this one: it cancels on the server
                    // instead of queueing behind it.
                    let seq = latest.fetch_add(1, Ordering::SeqCst) + 1;
                    state.runtime.spawn(async move {
                    let superseded = || latest.load(Ordering::SeqCst) != seq;
                    let result = async {
                        // Quick Look's own session: never a tab's, so a lookup can't
                        // land inside a transaction the user has open. While an
                        // older batch has it, this waits (that one is cancelling),
                        // so Quick Look never runs on two backends at once.
                        let Lease {
                            session, out: _out, ..
                        } = pool::lease(
                            &pool,
                            &window_id,
                            Slot::QuickLook,
                            generation,
                            connection_id,
                            config,
                        )
                        .await
                        .map_err(|e| e.to_string())?;
                        if superseded() {
                            pool::give_back(&pool, &window_id, Slot::QuickLook, generation, session);
                            return Ok(lookups.iter().map(|_| None).collect());
                        }
                        let (token, tls) = (session.cancel_token.clone(), session.cancel_via.clone());
                        // Counts are bounded on the server (an unindexed column
                        // of a big table); one that runs out reads as unknown.
                        // Pipelined ahead of the lookups, so it costs no round trip.
                        let limit = if count {
                            format!("SET statement_timeout = '{}ms'", INCOMING_TIMEOUT.as_millis())
                        } else {
                            "RESET statement_timeout".to_string()
                        };
                        let all = async {
                            let set = session_execute(&session, &limit);
                            // All lookups at once: tokio-postgres pipelines them on one socket.
                            let lookups = futures::future::join_all(lookups.iter().map(|l| {
                                let session = &session;
                                async move {
                                    let sql = lookup_sql(EngineKind::Postgres, l, count)?;
                                    let mut batches = Vec::new();
                                    session_query_stream_with(
                                        session,
                                        &sql,
                                        StreamOptions::default(),
                                        |b, _| {
                                            batches.push(b);
                                            Ok(())
                                        },
                                    )
                                    .await
                                    .ok()?;
                                    first_row(batches)
                                }
                            }));
                            futures::join!(set, lookups).1
                        };
                        let (rows, cancelled) = {
                        let mut all = std::pin::pin!(all);
                        let started = Instant::now();
                        let mut cancelled = false;
                        let rows = loop {
                            tokio::select! {
                                rows = &mut all => break Some(rows),
                                _ = tokio::time::sleep(Duration::from_millis(50)) => {
                                    // Superseded, or the server isn't answering:
                                    // cancel whatever runs now, again until the
                                    // pipeline drains (a cancel ends one statement).
                                    if superseded() || started.elapsed() > QUICK_LOOK_LIMIT {
                                        cancelled = true;
                                        let _ = tokio::time::timeout(
                                            Duration::from_secs(1),
                                            cancel_with_token(token.clone(), tls.clone()),
                                        )
                                        .await;
                                    }
                                    // A dead link drains nothing: give up on it.
                                    if started.elapsed() > QUICK_LOOK_LIMIT * 2 {
                                        break None;
                                    }
                                }
                            }
                        };
                        (rows, cancelled)
                        };
                        let rows = rows.unwrap_or_else(|| lookups.iter().map(|_| None).collect());
                        // After a cancel, one may still be on its way to this
                        // backend: the session goes rather than meet the next batch.
                        if !cancelled {
                            pool::give_back(&pool, &window_id, Slot::QuickLook, generation, session);
                        }
                        Ok::<_, String>(rows)
                    }
                    .await;
                    let _ = respond_to.send(result);
                });
                }
            }
        }
        Command::RunWindowQuery {
            window_id,
            tab_id,
            sql,
            apply_limit,
            page,
            export,
            explain,
            confirmed,
            sink,
            respond_to,
        } => {
            let Some(target) = state.windows.get(&window_id).cloned() else {
                let _ = respond_to.send(Err("This window is not connected".into()));
                return;
            };
            let query_id = state.next_query_id.fetch_add(1, Ordering::SeqCst);
            let engine = match &target {
                WindowTarget::Sqlite { .. } => EngineKind::Sqlite,
                WindowTarget::Postgres { .. } => EngineKind::Postgres,
            };
            // ⌘E: the statement's plan instead. Only a timed plan runs it, so
            // only a timed plan of a write goes through safe mode, and it is
            // rolled back.
            let mut plan_rollback = false;
            let mut user_sql = sql.clone();
            let sql = match &explain {
                None => sql,
                Some(run) => {
                    let checks = check_sql(&sql);
                    if checks.len() != 1 {
                        let _ = respond_to
                            .send(Err("Explain works on one statement at a time.".into()));
                        return;
                    }
                    if let Ok(mut side) = run.side.lock() {
                        side.engine = Some(engine);
                    }
                    plan_rollback = run.timed
                        && engine == EngineKind::Postgres
                        && checks[0].kind != StatementKind::Read;
                    match plan::explain_sql(engine, &sql, run.timed) {
                        Ok(explain_sql) => explain_sql,
                        Err(e) => {
                            let _ = respond_to.send(Err(e));
                            return;
                        }
                    }
                }
            };
            if !explain
                .as_ref()
                .is_some_and(|r| r.timed && engine == EngineKind::Postgres)
            {
                // An estimate never runs the statement; safe mode reads the
                // EXPLAIN itself, which it counts as a read.
                user_sql = sql.clone();
            }
            let reads_only = || {
                let checks = check_sql(&sql);
                !checks.is_empty() && checks.iter().all(|c| c.kind == StatementKind::Read)
            };
            if export && !reads_only() && explain.is_none() {
                let _ = respond_to.send(Err("Only a query that reads can be exported".into()));
                return;
            }
            let safe_mode = match &target {
                WindowTarget::Sqlite { safe_mode, .. } => *safe_mode,
                WindowTarget::Postgres { config, .. } => config.safe_mode,
            };
            // Safe mode: nothing reaches the database until the user confirms
            // (or ever, on a read-only connection).
            if let Some(hold) = hold_for(safe_mode, &user_sql, confirmed) {
                push_event(
                    &sink,
                    CoreEvent::QueryHeld {
                        query_id,
                        tab_id,
                        hold,
                    },
                );
                let _ = respond_to.send(Ok(query_id));
                return;
            }
            // A write in the window: no prefetched page may be served again.
            let prefetcher = state
                .pool
                .lock()
                .ok()
                .and_then(|p| p.existing_prefetcher(&window_id));
            // Its transaction ends first, so the cursors' locks don't hold up
            // DDL; and again once the write ends, since a prefetch taken while
            // it was in flight read the rows from before it.
            // A plan's write is rolled back: nothing to invalidate.
            let writes = !export && explain.is_none() && !reads_only();
            if writes {
                invalidate_prefetch(&state.pool, &window_id, &state.runtime);
            }
            let slot: CancelSlot = Arc::default();
            state
                .window_interrupts
                .insert((window_id.clone(), tab_id), slot.clone());
            let events: SharedSink = match &target {
                WindowTarget::Postgres { .. } if writes => Arc::new(InvalidateOnFinish {
                    inner: sink,
                    pool: state.pool.clone(),
                    window_id: window_id.clone(),
                    runtime: state.runtime.clone(),
                }),
                _ => sink,
            };
            // A new run ends the tab's SQLite page (an export leaves it).
            let tab_key = (window_id.clone(), tab_id);
            if !export {
                if let Ok(mut pages) = state.sqlite_pages.lock() {
                    pages.start(&tab_key, query_id);
                }
            }
            // A SQLite free-form read pages like a Postgres cursor: the first
            // page now, the rest on demand (`FetchMore`).
            let sqlite_page = match (page, &target) {
                (Some(take), WindowTarget::Sqlite { .. })
                    if !export
                        && explain.is_none()
                        && apply_limit.is_none()
                        && pages_by_cursor(&sql)
                        && reads_only() =>
                {
                    Some(SqlitePageRun {
                        pages: state.sqlite_pages.clone(),
                        key: tab_key,
                        skip: 0,
                        take,
                    })
                }
                _ => None,
            };
            let cap = (!export && explain.is_none()).then_some(MAX_TAB_ROWS);
            push_event(&events, CoreEvent::QueryStarted { query_id, tab_id });
            match target {
                WindowTarget::Sqlite {
                    path, safe_mode, ..
                } => {
                    let events = events.clone();
                    thread::spawn(move || {
                        let Some(run) = explain else {
                            run_sqlite_query_worker(
                                path,
                                query_id,
                                tab_id,
                                sql,
                                apply_limit,
                                safe_mode == SafeMode::ReadOnly,
                                events,
                                slot,
                                cap,
                                sqlite_page,
                            );
                            return;
                        };
                        let held: Arc<HeldEvents> = Arc::default();
                        run_sqlite_query_worker(
                            path.clone(),
                            query_id,
                            tab_id,
                            sql,
                            None,
                            safe_mode == SafeMode::ReadOnly,
                            held.clone(),
                            slot,
                            None,
                            None,
                        );
                        let queued = held
                            .0
                            .lock()
                            .map(|mut q| std::mem::take(&mut *q))
                            .unwrap_or_default();
                        let rows: Vec<Vec<Value>> = queued
                            .iter()
                            .filter_map(|e| match e {
                                CoreEvent::QueryBatch { batch, .. } => Some(batch.rows.clone()),
                                _ => None,
                            })
                            .flatten()
                            .collect();
                        let tables = plan::tables(&plan::parse_sqlite(&sqlite_plan_rows(&rows)));
                        let facts = rowkery_core::db::sqlite::sqlite_plan_facts(&path, &tables);
                        if let Ok(mut side) = run.side.lock() {
                            side.facts = facts;
                        }
                        for event in queued {
                            push_event(&events, event);
                        }
                    });
                }
                WindowTarget::Postgres {
                    connection_id,
                    config,
                } => {
                    let pooled = PoolSlot {
                        generation: state
                            .pool
                            .lock()
                            .map(|p| p.generation(&window_id))
                            .unwrap_or(0),
                        pool: state.pool.clone(),
                        window_id,
                    };
                    // A browse the pointer prefetched: its first page is
                    // cached and the rest comes from the same cursor.
                    let cached = prefetcher.filter(|f| {
                        !export
                            && explain.is_none()
                            && page.is_none()
                            && apply_limit.is_none()
                            && f.has(&sql)
                    });
                    match cached {
                        Some(prefetcher) => {
                            let runtime = state.runtime.clone();
                            let stop = slot.lock().map(|s| s.stop.clone()).unwrap_or_default();
                            state.runtime.spawn(async move {
                                let start = Instant::now();
                                let mut fwd =
                                    Forward::new(&events, query_id, tab_id, Some(MAX_TAB_ROWS));
                                // Under the same stop as any run: Cancel's
                                // force stop (or Stop all) ends it even when the
                                // prefetch session's socket is dead.
                                let served = tokio::select! {
                                    biased;
                                    served = prefetcher.serve(
                                        &sql,
                                        |b, first| fwd.batch(b, first),
                                        |token, tls| {
                                            arm_cancel(&slot, CancelHandle::Postgres { token, tls })
                                        },
                                    ) => Some(served),
                                    _ = stop.notified() => None,
                                };
                                let Some(served) = served else {
                                    // The session (and anything cached on it) goes.
                                    prefetcher.abandon();
                                    disarm_cancel(&slot);
                                    finish_query_worker(
                                        Ok(QueryOutcome::cancelled(fwd.row_count)),
                                        query_id,
                                        tab_id,
                                        start,
                                        &events,
                                    );
                                    return;
                                };
                                match served {
                                    Some(result) => {
                                        disarm_cancel(&slot);
                                        let outcome = fwd.outcome(result.map(|rows| StreamStats {
                                            rows,
                                            first_row: Some(Duration::ZERO),
                                        }));
                                        finish_query_worker(
                                            outcome, query_id, tab_id, start, &events,
                                        );
                                    }
                                    None => run_postgres_query_on_runtime(
                                        runtime,
                                        connection_id,
                                        config,
                                        pooled,
                                        query_id,
                                        tab_id,
                                        PgWork::Query { sql, page },
                                        apply_limit,
                                        events,
                                        slot,
                                    ),
                                }
                            });
                        }
                        None => run_postgres_query_on_runtime(
                            state.runtime.clone(),
                            connection_id,
                            config,
                            pooled,
                            query_id,
                            tab_id,
                            match explain {
                                Some(run) => PgWork::Explain {
                                    sql,
                                    rollback: plan_rollback,
                                    side: run.side,
                                },
                                None if export => PgWork::Within { sql },
                                None => PgWork::Query { sql, page },
                            },
                            apply_limit,
                            events,
                            slot,
                        ),
                    }
                }
            }
            let _ = respond_to.send(Ok(query_id));
        }
        Command::FetchMore {
            window_id,
            tab_id,
            rows,
            sink,
            respond_to,
        } => {
            let query_id = state.next_query_id.fetch_add(1, Ordering::SeqCst);
            let target = state.windows.get(&window_id).cloned();
            if let Some(WindowTarget::Sqlite {
                path, safe_mode, ..
            }) = target
            {
                let key = (window_id.clone(), tab_id);
                let cursor = state
                    .sqlite_pages
                    .lock()
                    .ok()
                    .and_then(|mut pages| pages.start(&key, query_id))
                    .filter(|c| c.path == path);
                let slot: CancelSlot = Arc::default();
                state.window_interrupts.insert(key.clone(), slot.clone());
                push_event(&sink, CoreEvent::QueryStarted { query_id, tab_id });
                let Some(cursor) = cursor else {
                    finish_query_worker(
                        Err("These rows are no longer open; run the query again"
                            .to_string()
                            .into()),
                        query_id,
                        tab_id,
                        Instant::now(),
                        &sink,
                    );
                    let _ = respond_to.send(Ok(query_id));
                    return;
                };
                let pages = state.sqlite_pages.clone();
                thread::spawn(move || {
                    run_sqlite_query_worker(
                        cursor.path,
                        query_id,
                        tab_id,
                        cursor.sql,
                        None,
                        safe_mode == SafeMode::ReadOnly,
                        sink,
                        slot,
                        Some(MAX_TAB_ROWS),
                        Some(SqlitePageRun {
                            pages,
                            key,
                            skip: cursor.sent,
                            take: rows,
                        }),
                    );
                });
                let _ = respond_to.send(Ok(query_id));
                return;
            }
            let Some(WindowTarget::Postgres {
                connection_id,
                config,
            }) = target
            else {
                let _ = respond_to.send(Err("Nothing more to load".into()));
                return;
            };
            let slot: CancelSlot = Arc::default();
            state
                .window_interrupts
                .insert((window_id.clone(), tab_id), slot.clone());
            push_event(&sink, CoreEvent::QueryStarted { query_id, tab_id });
            run_postgres_query_on_runtime(
                state.runtime.clone(),
                connection_id,
                config,
                PoolSlot {
                    generation: state
                        .pool
                        .lock()
                        .map(|p| p.generation(&window_id))
                        .unwrap_or(0),
                    pool: state.pool.clone(),
                    window_id,
                },
                query_id,
                tab_id,
                PgWork::More { rows },
                None,
                sink,
                slot,
            );
            let _ = respond_to.send(Ok(query_id));
        }
        Command::ApplyChanges {
            window_id,
            tab_id,
            table,
            changes,
            confirmed,
            respond_to,
        } => apply_changes_now(
            state, window_id, tab_id, table, changes, confirmed, respond_to,
        ),
        Command::ImportCsv {
            window_id,
            spec,
            cancel,
            progress,
            respond_to,
        } => import_csv_now(state, window_id, spec, cancel, progress, respond_to),
        Command::CloseWindowTab { window_id, tab_id } => {
            if let Ok(mut pages) = state.sqlite_pages.lock() {
                pages.forget_tab(&(window_id.clone(), tab_id));
            }
            if let Some(slot) = state.window_interrupts.remove(&(window_id.clone(), tab_id)) {
                request_cancel(&state.runtime, &slot);
            }
            let stale = state
                .pool
                .lock()
                .ok()
                .and_then(|mut pool| pool.close_tab(&window_id, tab_id));
            drop(stale);
        }
        Command::StopAllQueries => {
            for slot in state.window_interrupts.values() {
                force_stop(&state.runtime, slot);
            }
        }
        Command::HoldsTransaction { respond_to } => {
            let held = state
                .pool
                .lock()
                .map(|p| p.holds_user_transaction())
                .unwrap_or(true);
            let _ = respond_to.send(held);
        }
        Command::Prefetch {
            window_id,
            sql,
            respond_to,
        } => {
            let Some(WindowTarget::Postgres {
                connection_id,
                config,
            }) = state.windows.get(&window_id).cloned()
            else {
                let _ = respond_to.send(Ok(false));
                return;
            };
            // A browse only reads, but safe mode has the last word; and only
            // one statement that reads is ever kept open as a cursor.
            let one_read = {
                let checks = check_sql(&sql);
                checks.len() == 1 && checks[0].kind == StatementKind::Read
            };
            if hold_for(config.safe_mode, &sql, false).is_some() || !one_read {
                let _ = respond_to.send(Ok(false));
                return;
            }
            let picked = state.pool.lock().ok().and_then(|mut p| {
                let generation = p.generation(&window_id);
                p.prefetcher(&window_id, generation, &connection_id)
                    .map(|f| (f, p.window_tunnel(&window_id, generation)))
            });
            let Some((prefetcher, tunnel)) = picked else {
                let _ = respond_to.send(Ok(false));
                return;
            };
            state.runtime.spawn(async move {
                let done = prefetcher
                    .prefetch(sql, connection_id, config, tunnel)
                    .await
                    .map_err(driver_error_message);
                let cached = done == Ok(true);
                let _ = respond_to.send(done);
                // Its cursor (and the locks it holds) goes once the page is
                // stale or the transaction too old, unless the window went
                // first (then the prefetcher is gone, not kept alive by this).
                if cached {
                    let prefetcher = Arc::downgrade(&prefetcher);
                    let wait = prefetch::TTL.min(prefetch::MAX_TXN_AGE);
                    tokio::time::sleep(wait + Duration::from_millis(100)).await;
                    if let Some(f) = prefetcher.upgrade() {
                        f.sweep(pool::IDLE_CLOSE).await;
                    }
                }
            });
        }
        Command::CancelPrefetch { window_id } => {
            if let Some(f) = state
                .pool
                .lock()
                .ok()
                .and_then(|p| p.existing_prefetcher(&window_id))
            {
                state.runtime.spawn(async move { f.cancel().await });
            }
        }
        Command::Prefetched {
            window_id,
            sql,
            respond_to,
        } => {
            let has = state
                .pool
                .lock()
                .ok()
                .and_then(|p| p.existing_prefetcher(&window_id))
                .is_some_and(|f| f.has(&sql));
            let _ = respond_to.send(has);
        }
        Command::CancelWindowQuery { window_id, tab_id } => {
            if let Some(slot) = state.window_interrupts.get(&(window_id, tab_id)) {
                request_cancel(&state.runtime, slot);
            }
        }
        Command::ListDatabases {
            window_id,
            respond_to,
        } => match state.windows.get(&window_id).cloned() {
            None => {
                let _ = respond_to.send(Err("This window is not connected".into()));
            }
            Some(WindowTarget::Sqlite { .. }) => {
                let _ = respond_to.send(Ok(Vec::new()));
            }
            Some(WindowTarget::Postgres {
                connection_id,
                config,
            }) => {
                let pool = state.pool.clone();
                let generation = pool.lock().map(|p| p.generation(&window_id)).unwrap_or(0);
                state.runtime.spawn(async move {
                    let result = async {
                        let Lease { session, .. } = pool::lease(
                            &pool,
                            &window_id,
                            Slot::Spare,
                            generation,
                            connection_id,
                            config,
                        )
                        .await?;
                        let listed = session_list_databases(&session).await;
                        pool::give_back(&pool, &window_id, Slot::Spare, generation, session);
                        listed
                    }
                    .await
                    .map_err(driver_error_message);
                    let _ = respond_to.send(result);
                });
            }
        },
        Command::TableCounts {
            window_id,
            respond_to,
        } => match state.windows.get(&window_id).cloned() {
            None => {
                let _ = respond_to.send(Err("This window is not connected".into()));
            }
            Some(WindowTarget::Postgres { .. }) => {
                let _ = respond_to.send(Ok(Vec::new()));
            }
            Some(WindowTarget::Sqlite { path, .. }) => {
                thread::spawn(move || {
                    let counted = with_catch(|| {
                        let mut driver = SqliteDriver::new(path).read_only(true);
                        driver.connect()?;
                        driver.table_counts()
                    })
                    .and_then(|r| r.map_err(driver_error_message));
                    let _ = respond_to.send(counted);
                });
            }
        },
        Command::Sessions {
            window_id,
            respond_to,
        } => with_postgres(state, window_id, respond_to, sessions::list),
        Command::SessionLocks {
            window_id,
            pid,
            respond_to,
        } => with_postgres(state, window_id, respond_to, move |t| {
            sessions::locks(t, pid)
        }),
        Command::StopSession {
            window_id,
            pid,
            kind,
            confirmed,
            respond_to,
        } => with_postgres(state, window_id, respond_to, move |t| {
            sessions::stop(t, pid, kind, confirmed)
        }),
        Command::TableIndexes {
            window_id,
            schema,
            tables,
            respond_to,
        } => match state.windows.get(&window_id).cloned() {
            None => {
                let _ = respond_to.send(Err("This window is not connected".into()));
            }
            // SQLite catalogs carry their indexes; nothing is deferred.
            Some(WindowTarget::Sqlite { .. }) => {
                let _ = respond_to.send(Ok(Vec::new()));
            }
            Some(WindowTarget::Postgres {
                connection_id,
                config,
            }) => {
                let pool = state.pool.clone();
                let generation = pool.lock().map(|p| p.generation(&window_id)).unwrap_or(0);
                state.runtime.spawn(async move {
                    let result = async {
                        let Lease { session, .. } = pool::lease(
                            &pool,
                            &window_id,
                            Slot::Spare,
                            generation,
                            connection_id,
                            config,
                        )
                        .await?;
                        let indexes = session_table_indexes(&session, &schema, &tables).await;
                        pool::give_back(&pool, &window_id, Slot::Spare, generation, session);
                        indexes
                    }
                    .await
                    .map_err(driver_error_message);
                    let _ = respond_to.send(result);
                });
            }
        },
        Command::ReloadWindowSchema {
            window_id,
            respond_to,
        } => {
            // A schema reload (after DDL, or ⌘R): prefetched pages may be stale.
            if let Some(f) = state
                .pool
                .lock()
                .ok()
                .and_then(|p| p.existing_prefetcher(&window_id))
            {
                f.invalidate();
                state.runtime.spawn(async move { f.release().await });
            }
            match state.windows.get(&window_id).cloned() {
                None => {
                    let _ = respond_to.send(Err("This window is not connected".into()));
                }
                Some(WindowTarget::Sqlite { path, .. }) => {
                    thread::spawn(move || {
                        let _ = respond_to.send(load_sqlite_catalog(path));
                    });
                }
                // On the window's spare session, unlike `OpenWindow`: its query
                // tabs keep their warm sessions and any open transaction.
                Some(WindowTarget::Postgres {
                    connection_id,
                    config,
                }) => {
                    let pool = state.pool.clone();
                    let generation = pool.lock().map(|p| p.generation(&window_id)).unwrap_or(0);
                    let database = config.database.clone();
                    state.runtime.spawn(async move {
                        let result = async {
                            let Lease { session, .. } = pool::lease(
                                &pool,
                                &window_id,
                                Slot::Spare,
                                generation,
                                connection_id.clone(),
                                config,
                            )
                            .await?;
                            // Pipelined; the fresh catalog replaces the cached one.
                            let (catalog, version, fingerprint) = tokio::join!(
                                session_introspect(&session),
                                session_server_version(&session),
                                session_catalog_fingerprint(&session),
                            );
                            pool::give_back(&pool, &window_id, Slot::Spare, generation, session);
                            if let (Ok(catalog), Ok(fp)) = (&catalog, fingerprint) {
                                catalog_cache::store(
                                    &connection_id,
                                    &database,
                                    &CachedCatalog::new(version.ok(), fp, catalog.clone()),
                                );
                            }
                            catalog
                        }
                        .await
                        .map_err(driver_error_message);
                        let _ = respond_to.send(result);
                    });
                }
            }
        }
        Command::ListConnections { respond_to } => {
            let _ = respond_to.send(state.config.connections.clone());
        }
    }
}

impl CoreBridge {
    pub fn spawn() -> Self {
        let (command_tx, command_rx) = mpsc::channel();
        let initial = AppConfig::load().unwrap_or_default();
        let catalog_listener: ListenerSlot = Arc::default();
        let thread_listener = catalog_listener.clone();
        let launch_warm: LaunchWarmSlot = Arc::default();
        let thread_launch_warm = launch_warm.clone();
        let writer = ConfigWriter::spawn(initial.clone());
        let ui = Arc::new(Mutex::new(initial.ui.clone()));
        thread::Builder::new()
            .name("rowkery-core".into())
            .spawn(move || {
                let runtime = Runtime::new().expect("tokio runtime");
                let runtime_handle = runtime.handle().clone();
                let pool = SharedPool::default();
                runtime_handle.spawn(pool::sweep_forever(pool.clone()));
                let _tokio_driver = thread::Builder::new()
                    .name("rowkery-tokio".into())
                    .spawn(move || {
                        runtime.block_on(async { std::future::pending::<()>().await });
                    })
                    .expect("tokio driver");

                let early_ui = initial.ui.clone();
                let mut state = CoreState {
                    early: None,
                    launch_warm: thread_launch_warm,
                    catalog_listener: thread_listener,
                    next_open_seq: 0,
                    config: AppConfig {
                        ui: None,
                        ..initial
                    },
                    config_seq: 0,
                    windows: HashMap::new(),
                    window_interrupts: HashMap::new(),
                    next_query_id: AtomicU64::new(1),
                    pool: pool.clone(),
                    sqlite_pages: SharedSqlitePages::default(),
                    runtime: runtime_handle,
                };
                // Commands may spawn onto the runtime from this thread
                // (a closing window's prefetcher cancels its query).
                let runtime = state.runtime.clone();
                let _in_runtime = runtime.enter();
                // The first window: connecting while the webview boots.
                start_early_open(&mut state, early_ui.as_ref());
                while let Ok(command) = command_rx.recv() {
                    if with_catch(|| dispatch_command(&mut state, command)).is_err() {
                        // panic already logged in with_catch
                    }
                }
            })
            .expect("spawn core thread");
        Self {
            command_tx,
            writer,
            ui,
            catalog_listener,
            launch_warm,
        }
    }

    /// Calls `f` with the moment the window opened at launch had its session
    /// (at once if it has already; never when nothing opened at launch or it
    /// failed): the `socket-warm` latency mark.
    pub fn on_launch_warm(&self, f: impl FnOnce(Instant) + Send + 'static) {
        let Ok(mut warm) = self.launch_warm.lock() else {
            return;
        };
        match warm.at {
            Some(at) => {
                drop(warm);
                f(at);
            }
            None => warm.listener = Some(Box::new(f)),
        }
    }

    /// Where updates to cached catalogs go (one listener; the app's webview).
    pub fn on_catalog_update(&self, listener: CatalogListener) {
        if let Ok(mut slot) = self.catalog_listener.lock() {
            *slot = Some(listener);
        }
    }

    /// Writes a config snapshot the core thread handed back, on this thread.
    fn write_snapshot(&self, event: Event) -> Result<(), ConfigError> {
        match event {
            Event::Snapshot(seq, config) => self.writer.write_config(seq, *config),
            Event::ConfigError(msg) | Event::Error(msg) => Err(ConfigError::Message(msg)),
            _ => Err(ConfigError::Message("unexpected reply".into())),
        }
    }

    /// The webview's saved UI state (windows, tabs, SQL, …), versioned by it.
    pub fn ui_state(&self) -> Option<serde_json::Value> {
        self.ui.lock().ok().and_then(|u| u.clone())
    }

    /// Replaces the webview's UI state; written to config.json within 500 ms
    /// by the writer thread. Returns at once.
    pub fn save_ui_state(&self, ui: serde_json::Value) {
        if let Ok(mut u) = self.ui.lock() {
            *u = Some(ui.clone());
        }
        self.writer.publish_ui(ui);
    }

    /// Writes anything pending now (app exit).
    pub fn flush_config(&self) {
        self.writer.flush();
    }

    fn send_command<F, T>(&self, build: F) -> Option<T>
    where
        F: FnOnce(oneshot::Sender<T>) -> Command,
    {
        let (tx, rx) = oneshot::channel();
        let cmd = build(tx);
        self.command_tx.send(cmd).ok()?;
        rx.blocking_recv().ok()
    }

    /// Opens (or re-points) a window at a connection, optionally on another
    /// database, and returns its schema. Blocks until the schema is loaded.
    pub fn open_window(
        &self,
        window_id: &str,
        connection_id: &str,
        database: Option<String>,
    ) -> Result<WindowOpened, String> {
        self.send_command(|respond_to| Command::OpenWindow {
            window_id: window_id.to_string(),
            connection_id: connection_id.to_string(),
            database,
            respond_to,
        })
        .ok_or_else(|| "Connect was interrupted".to_string())?
    }

    /// Forgets a window and cancels its running queries.
    pub fn close_window(&self, window_id: &str) {
        let _ = self.command_tx.send(Command::CloseWindow {
            window_id: window_id.to_string(),
        });
    }

    /// Starts a query in a window and returns its query id at once. Its
    /// `QueryStarted`, batches and `QueryFinished` go to `sink` as they
    /// happen, from the core's worker threads. When the connection's safe
    /// mode stops it, `sink` gets a single `QueryHeld`; `confirmed` is the
    /// user's go-ahead on a Confirm writes connection.
    pub fn run_window_query_to(
        &self,
        window_id: &str,
        tab_id: u64,
        sql: String,
        apply_limit: Option<u32>,
        confirmed: bool,
        sink: SharedSink,
    ) -> Result<u64, String> {
        self.run_window_query_paged(window_id, tab_id, sql, apply_limit, None, confirmed, sink)
    }

    /// `run_window_query_to` that pages a free-form read (one `SELECT`,
    /// `WITH`, `VALUES` or `TABLE` without its own `LIMIT`) through a
    /// Postgres cursor, `page` rows at a time (0: all). Its done event says
    /// `paged`, and `more` while the cursor has rows for `fetch_more_to`.
    #[allow(clippy::too_many_arguments)]
    pub fn run_window_query_paged(
        &self,
        window_id: &str,
        tab_id: u64,
        sql: String,
        apply_limit: Option<u32>,
        page: Option<u32>,
        confirmed: bool,
        sink: SharedSink,
    ) -> Result<u64, String> {
        self.send_command(|respond_to| Command::RunWindowQuery {
            window_id: window_id.to_string(),
            tab_id,
            sql,
            apply_limit,
            page,
            export: false,
            explain: None,
            confirmed,
            sink,
            respond_to,
        })
        .ok_or_else(|| "core thread stopped".to_string())?
    }

    /// Runs `sql` (reads only) whole in the tab for an export: on Postgres
    /// inside whatever the tab's session has open, so it sees the user's
    /// transaction and leaves the tab's page cursor where it was. Events go
    /// to `sink` like a run's; the tab's Cancel stops it.
    pub fn run_window_export_to(
        &self,
        window_id: &str,
        tab_id: u64,
        sql: String,
        sink: SharedSink,
    ) -> Result<u64, String> {
        self.send_command(|respond_to| Command::RunWindowQuery {
            window_id: window_id.to_string(),
            tab_id,
            sql,
            apply_limit: None,
            page: None,
            export: true,
            explain: None,
            confirmed: false,
            sink,
            respond_to,
        })
        .ok_or_else(|| "core thread stopped".to_string())?
    }

    /// Streams the next `rows` (0: the rest) of the tab's open cursor as a
    /// new run, appended to the last one in the tab.
    pub fn fetch_more_to(
        &self,
        window_id: &str,
        tab_id: u64,
        rows: u32,
        sink: SharedSink,
    ) -> Result<u64, String> {
        self.send_command(|respond_to| Command::FetchMore {
            window_id: window_id.to_string(),
            tab_id,
            rows,
            sink,
            respond_to,
        })
        .ok_or_else(|| "core thread stopped".to_string())?
    }

    /// Checks the window's sessions that sat idle a minute or more (the
    /// webview calls this when it regains focus, the closest thing to a wake
    /// signal): dead ones are replaced in the background, so the first query
    /// after a laptop sleep finds a live session. Returns at once.
    pub fn ping_idle(&self, window_id: &str) {
        let _ = self.command_tx.send(Command::PingIdle {
            window_id: window_id.to_string(),
            idle: pool::PING_AFTER,
            respond_to: None,
        });
    }

    /// `ping_idle` for sessions idle at least `idle`, waiting for the result
    /// (tests).
    pub fn ping_idle_blocking(&self, window_id: &str, idle: Duration) -> usize {
        self.send_command(|respond_to| Command::PingIdle {
            window_id: window_id.to_string(),
            idle,
            respond_to: Some(respond_to),
        })
        .unwrap_or(0)
    }

    /// Follows each foreign key to the one row it points at, on the window's
    /// Quick Look session (all lookups pipelined on it). `None` where nothing
    /// matched or the value can't be looked up.
    pub fn follow_keys(
        &self,
        window_id: &str,
        lookups: Vec<FollowLookup>,
    ) -> Result<Vec<Option<FollowRow>>, String> {
        self.send_command(|respond_to| Command::FollowKeys {
            window_id: window_id.to_string(),
            lookups,
            count: false,
            respond_to,
        })
        .ok_or_else(|| "core thread stopped".to_string())?
    }

    /// Quick Look's Incoming: how many rows of each `schema.table` have
    /// `column = value`, counted up to `INCOMING_CAP + 1`, on the same Quick
    /// Look session as `follow_keys`. `None` where the value can't be matched
    /// or the count failed.
    pub fn count_incoming(
        &self,
        window_id: &str,
        lookups: Vec<FollowLookup>,
    ) -> Result<Vec<Option<i64>>, String> {
        let rows = self
            .send_command(|respond_to| Command::FollowKeys {
                window_id: window_id.to_string(),
                lookups,
                count: true,
                respond_to,
            })
            .ok_or_else(|| "core thread stopped".to_string())??;
        Ok(rows
            .into_iter()
            .map(|r| match r?.row.first()? {
                rowkery_core::db::Value::Int(n) => Some(*n),
                rowkery_core::db::Value::Text(t) => t.parse().ok(),
                _ => None,
            })
            .collect())
    }

    /// ⌘E: the plan of `sql` (one statement) on the tab's session, read as a
    /// short tree with its slowest step and one hint. An estimate runs
    /// nothing. `timed` runs it with ANALYZE: a write goes through safe mode
    /// (`confirmed` is the go-ahead) and is rolled back. The tab's Cancel
    /// stops it. Blocks until the plan is back.
    pub fn explain(
        &self,
        window_id: &str,
        tab_id: u64,
        sql: String,
        timed: bool,
        confirmed: bool,
    ) -> Result<ExplainOutcome, String> {
        let (tx, rx) = mpsc::channel();
        let sink = Arc::new(ExplainSink {
            rows: Mutex::default(),
            done: Mutex::new(Some(tx)),
        });
        let side: Arc<Mutex<ExplainSide>> = Arc::default();
        self.send_command(|respond_to| Command::RunWindowQuery {
            window_id: window_id.to_string(),
            tab_id,
            sql,
            apply_limit: None,
            page: None,
            export: false,
            explain: Some(ExplainRun {
                timed,
                side: side.clone(),
            }),
            confirmed,
            sink: sink.clone(),
            respond_to,
        })
        .ok_or_else(|| "core thread stopped".to_string())??;
        let done = rx
            .recv()
            .map_err(|_| "The plan was interrupted".to_string())?;
        let elapsed_ms = match done {
            CoreEvent::QueryHeld { hold, .. } => return Ok(ExplainOutcome::Held { hold }),
            CoreEvent::QueryFinished {
                cancelled: true, ..
            } => return Ok(ExplainOutcome::Cancelled),
            CoreEvent::QueryFinished {
                error: Some(error), ..
            } => return Err(error),
            CoreEvent::QueryFinished { elapsed_ms, .. } => elapsed_ms,
            _ => return Err("The plan was interrupted".into()),
        };
        let rows = sink.rows.lock().map(|r| r.clone()).unwrap_or_default();
        let side = side
            .lock()
            .map_err(|_| "The plan was interrupted".to_string())?;
        let engine = side.engine.unwrap_or(EngineKind::Postgres);
        let mut plan = match engine {
            EngineKind::Postgres => {
                let text: String = rows
                    .iter()
                    .filter_map(|r| match r.first() {
                        Some(Value::Text(t)) => Some(t.as_str()),
                        _ => None,
                    })
                    .collect();
                let json: serde_json::Value = serde_json::from_str(&text)
                    .map_err(|e| format!("Couldn't read the plan: {e}"))?;
                plan::parse_pg(&json)?
            }
            EngineKind::Sqlite => plan::parse_sqlite(&sqlite_plan_rows(&rows)),
        };
        plan::add_hint(&mut plan, engine, &side.facts);
        Ok(ExplainOutcome::Plan { plan, elapsed_ms })
    }

    /// `run_window_query_to` into a queue the caller drains.
    pub fn run_window_query(
        &self,
        window_id: &str,
        tab_id: u64,
        sql: String,
        apply_limit: Option<u32>,
        confirmed: bool,
    ) -> Result<EventQueue, String> {
        let queue: EventQueue = Arc::default();
        self.run_window_query_to(
            window_id,
            tab_id,
            sql,
            apply_limit,
            confirmed,
            queue.clone(),
        )?;
        Ok(queue)
    }

    /// Commits staged row edits as one transaction on the tab's session
    /// (see `rowkery_core::edits`). Every statement must change exactly one
    /// row or nothing is kept. Safe mode decides first: Confirm writes holds
    /// the batch until it comes back with `confirmed` set to the `sql` the
    /// hold returned; Read-only refuses it.
    pub fn apply_changes(
        &self,
        window_id: &str,
        tab_id: u64,
        table: EditTable,
        changes: Vec<Change>,
        confirmed: Option<String>,
    ) -> Result<ApplyOutcome, String> {
        self.send_command(|respond_to| Command::ApplyChanges {
            window_id: window_id.to_string(),
            tab_id,
            table,
            changes,
            confirmed,
            respond_to,
        })
        .ok_or_else(|| "core thread stopped".to_string())?
    }

    /// Imports a CSV file into a table (see `rowkery_core::import`): one
    /// transaction on a connection of its own, rolled back whole on any
    /// error or once `cancel` is set. `progress` hears the rows sent so far.
    /// Read-only refuses. Blocks until it ends.
    pub fn import_csv(
        &self,
        window_id: &str,
        spec: ImportSpec,
        cancel: Arc<AtomicBool>,
        progress: ImportProgress,
    ) -> Result<ImportOutcome, String> {
        self.send_command(|respond_to| Command::ImportCsv {
            window_id: window_id.to_string(),
            spec,
            cancel,
            progress,
            respond_to,
        })
        .ok_or_else(|| "core thread stopped".to_string())?
    }

    /// Cancels the tab's query, if any, and closes its warm session.
    pub fn close_window_tab(&self, window_id: &str, tab_id: u64) {
        let _ = self.command_tx.send(Command::CloseWindowTab {
            window_id: window_id.to_string(),
            tab_id,
        });
    }

    /// Hover prefetch: reads the first [`PREFETCH_ROWS`] of `sql` (a browse)
    /// through a cursor on the window's prefetch session and keeps them, so
    /// a `run_window_query` of the same SQL shows them at once and continues
    /// that cursor. Blocks until done; `Ok(false)` when it was cancelled,
    /// superseded, held by safe mode, or the window isn't Postgres.
    pub fn prefetch_table(&self, window_id: &str, sql: String) -> Result<bool, String> {
        self.send_command(|respond_to| Command::Prefetch {
            window_id: window_id.to_string(),
            sql,
            respond_to,
        })
        .ok_or_else(|| "core thread stopped".to_string())?
    }

    /// The pointer left the row: cancels the prefetch in flight on the server.
    pub fn cancel_prefetch(&self, window_id: &str) {
        let _ = self.command_tx.send(Command::CancelPrefetch {
            window_id: window_id.to_string(),
        });
    }

    /// A fresh first page of `sql` is cached for the window.
    pub fn prefetched(&self, window_id: &str, sql: &str) -> bool {
        self.send_command(|respond_to| Command::Prefetched {
            window_id: window_id.to_string(),
            sql: sql.to_string(),
            respond_to,
        })
        .unwrap_or(false)
    }

    pub fn cancel_window_query(&self, window_id: &str, tab_id: u64) {
        let _ = self.command_tx.send(Command::CancelWindowQuery {
            window_id: window_id.to_string(),
            tab_id,
        });
    }

    /// The SQL line's exact count: runs `sql` (one `SELECT count(*)`) on the
    /// window's count slot, a session of its own, and blocks until it ends.
    /// `None` when it was cancelled (`cancel_window_query(window, COUNT_TAB)`).
    pub fn count_window_rows(&self, window_id: &str, sql: String) -> Result<Option<i64>, String> {
        type Cell = Arc<Mutex<Option<rowkery_core::db::Value>>>;
        struct CountSink(Cell, mpsc::Sender<(Option<String>, bool)>);
        impl EventSink for CountSink {
            fn push(&self, event: CoreEvent) {
                match event {
                    CoreEvent::QueryBatch { batch, .. } => {
                        if let (Ok(mut cell), Some(first)) =
                            (self.0.lock(), batch.rows.first().and_then(|r| r.first()))
                        {
                            *cell = Some(first.clone());
                        }
                    }
                    CoreEvent::QueryFinished {
                        error, cancelled, ..
                    } => {
                        let _ = self.1.send((error, cancelled));
                    }
                    // Safe mode stopped it: nothing will run, so say so now.
                    CoreEvent::QueryHeld { .. } => {
                        let _ = self.1.send((
                            Some("This count isn't a plain read, so safe mode stopped it".into()),
                            false,
                        ));
                    }
                    _ => {}
                }
            }
        }
        // One statement that only reads; anything else is never counted.
        let checks = check_sql(&sql);
        if checks.len() != 1 || checks[0].kind != StatementKind::Read {
            return Err("Only a single read can be counted".into());
        }
        let (tx, rx) = mpsc::channel();
        let cell: Cell = Arc::default();
        // Only the sink holds the sender: if the run is dropped without an
        // ending, the channel closes and this returns instead of hanging.
        self.run_window_query_to(
            window_id,
            COUNT_TAB,
            sql,
            None,
            false,
            Arc::new(CountSink(cell.clone(), tx)),
        )?;
        let (error, cancelled) = rx
            .recv()
            .map_err(|_| "Counting was interrupted".to_string())?;
        if cancelled {
            return Ok(None);
        }
        if let Some(error) = error {
            return Err(error);
        }
        let cell = cell.lock().ok().and_then(|c| c.clone());
        match cell {
            Some(rowkery_core::db::Value::Int(n)) => Ok(Some(n)),
            Some(rowkery_core::db::Value::Text(t)) => t
                .parse()
                .map(Some)
                .map_err(|_| format!("Unexpected count: {t}")),
            other => Err(format!("Unexpected count: {other:?}")),
        }
    }

    /// Stops every running query in every window without waiting for the
    /// servers: the kill switch for runs stuck on a dead connection.
    pub fn stop_all_queries(&self) {
        let _ = self.command_tx.send(Command::StopAllQueries);
    }

    /// Whether any tab's Postgres session may hold the user's open
    /// transaction (a restart would roll it back). True when unknown.
    pub fn holds_transaction(&self) -> bool {
        self.send_command(|respond_to| Command::HoldsTransaction { respond_to })
            .unwrap_or(true)
    }

    /// Databases on the window's server; empty for SQLite.
    pub fn list_databases(&self, window_id: &str) -> Result<Vec<DatabaseInfo>, String> {
        self.send_command(|respond_to| Command::ListDatabases {
            window_id: window_id.to_string(),
            respond_to,
        })
        .ok_or_else(|| "Listing databases was interrupted".to_string())?
    }

    /// The server's other sessions on the window's database (Postgres only),
    /// read on a session of the window's own.
    pub fn sessions(&self, window_id: &str) -> Result<Vec<SessionRow>, String> {
        self.send_command(|respond_to| Command::Sessions {
            window_id: window_id.to_string(),
            respond_to,
        })
        .ok_or_else(|| "Reading sessions was interrupted".to_string())?
    }

    /// The table locks session `pid` holds.
    pub fn session_locks(&self, window_id: &str, pid: i32) -> Result<Vec<HeldLock>, String> {
        self.send_command(|respond_to| Command::SessionLocks {
            window_id: window_id.to_string(),
            pid,
            respond_to,
        })
        .ok_or_else(|| "Reading locks was interrupted".to_string())?
    }

    /// Cancels `pid`'s query or ends the session, as safe mode allows;
    /// `confirmed` is the user's go-ahead for exactly that.
    pub fn stop_session(
        &self,
        window_id: &str,
        pid: i32,
        kind: StopKind,
        confirmed: bool,
    ) -> Result<StopOutcome, String> {
        self.send_command(|respond_to| Command::StopSession {
            window_id: window_id.to_string(),
            pid,
            kind,
            confirmed,
            respond_to,
        })
        .ok_or_else(|| "Stopping the session was interrupted".to_string())?
    }

    /// Index details for `tables` in `schema`, which Postgres catalogs defer.
    /// Removes a saved connection and its cached catalogs. With
    /// `keep_secrets` its keychain entries stay, so an Undo can save the
    /// record back as it was; `forget_connection_secrets` removes them once
    /// the Undo is gone.
    pub fn remove_connection(&self, id: &str, keep_secrets: bool) -> Result<(), ConfigError> {
        let event = self
            .send_command(|respond_to| Command::DeleteConnection {
                id: id.to_string(),
                respond_to,
            })
            .ok_or_else(|| ConfigError::Message("core thread stopped".into()))?;
        let result = self.write_snapshot(event);
        // The record is gone (or its save failed); its cached catalogs (and
        // keychain entries) go either way, on this thread, not the core's.
        if !keep_secrets {
            let _ = delete_secrets_for_connection(id);
        }
        catalog_cache::forget(id);
        result
    }

    /// First launch: with no saved connections, writes the sample database
    /// and adds its record. Runs once per config (`first_run_done`); the file
    /// is written here, off the core thread. Returns whether it was added.
    pub fn first_run(&self) -> Result<bool, String> {
        let Some(Event::Config(config)) =
            self.send_command(|respond_to| Command::GetConfig { respond_to })
        else {
            return Ok(false);
        };
        let Some(add_sample) = sample::first_run_plan(&config) else {
            return Ok(false);
        };
        // A failed write still records the decision, without the record.
        let add_sample = add_sample && sample::write_sample().is_ok();
        let event = self
            .send_command(|respond_to| Command::FirstRun {
                add_sample,
                respond_to,
            })
            .ok_or("core thread stopped")?;
        self.write_snapshot(event).map_err(|e| e.to_string())?;
        Ok(add_sample)
    }

    /// "Open the sample database" (`reset` false: the file is written only
    /// when missing) and "Reset the sample database" (`reset` true: a fresh
    /// copy over the working one). Returns its record, put back if deleted.
    pub fn open_sample(&self, reset: bool) -> Result<ConnectionRecord, String> {
        if reset || sample::sample_missing() {
            sample::write_sample()?;
        }
        let (event, record) = self
            .send_command(|respond_to| Command::UpsertSample { respond_to })
            .ok_or("core thread stopped")?;
        self.write_snapshot(event).map_err(|e| e.to_string())?;
        Ok(record)
    }

    /// The keychain entries of a connection removed with `keep_secrets`.
    pub fn forget_connection_secrets(&self, id: &str) {
        let _ = delete_secrets_for_connection(id);
    }

    /// Row counts for a SQLite window's tables, counted after its catalog
    /// is shown (empty for Postgres).
    pub fn table_counts(&self, window_id: &str) -> Result<Vec<TableCount>, String> {
        self.send_command(|respond_to| Command::TableCounts {
            window_id: window_id.to_string(),
            respond_to,
        })
        .ok_or_else(|| "Counting rows was interrupted".to_string())?
    }

    pub fn table_indexes(
        &self,
        window_id: &str,
        schema: &str,
        tables: Vec<String>,
    ) -> Result<Vec<TableIndexes>, String> {
        self.send_command(|respond_to| Command::TableIndexes {
            window_id: window_id.to_string(),
            schema: schema.to_string(),
            tables,
            respond_to,
        })
        .ok_or_else(|| "Loading indexes was interrupted".to_string())?
    }

    /// Reloads a window's schema without re-pointing it, so its query tabs
    /// keep their sessions (`open_window` would drop them).
    pub fn reload_window_schema(&self, window_id: &str) -> Result<SchemaCatalog, String> {
        self.send_command(|respond_to| Command::ReloadWindowSchema {
            window_id: window_id.to_string(),
            respond_to,
        })
        .ok_or_else(|| "Reloading the schema was interrupted".to_string())?
    }

    pub fn ping(&self) -> Option<Event> {
        self.send_command(|respond_to| Command::Ping { respond_to })
    }

    pub fn get_config_blocking(&self) -> Option<AppConfig> {
        let event = self.send_command(|respond_to| Command::GetConfig { respond_to })?;
        match event {
            Event::Config(cfg) => Some(cfg),
            _ => None,
        }
    }

    pub fn save_theme(&self, theme: ThemePreference) -> Result<(), ConfigError> {
        let Some(event) = self.send_command(|respond_to| Command::SetTheme { theme, respond_to })
        else {
            return Err(ConfigError::Message("core thread stopped".into()));
        };
        self.write_snapshot(event)
    }

    /// Saves `native_decorations` (Linux / Windows window chrome). It is read
    /// before the window is created, so it shows on the next launch.
    pub fn save_native_decorations(&self, on: bool) -> Result<(), ConfigError> {
        let Some(event) =
            self.send_command(|respond_to| Command::SetNativeDecorations { on, respond_to })
        else {
            return Err(ConfigError::Message("core thread stopped".into()));
        };
        self.write_snapshot(event)
    }
}

impl Clone for CoreBridge {
    fn clone(&self) -> Self {
        Self {
            command_tx: self.command_tx.clone(),
            writer: self.writer.clone(),
            ui: self.ui.clone(),
            catalog_listener: self.catalog_listener.clone(),
            launch_warm: self.launch_warm.clone(),
        }
    }
}

impl CoreBridge {
    pub fn list_connections(&self) -> Vec<ConnectionRecord> {
        self.send_command(|respond_to| Command::ListConnections { respond_to })
            .unwrap_or_default()
    }

    pub fn upsert_connection(
        &self,
        connection: ConnectionRecord,
        secrets: ConnectionSecrets,
    ) -> Result<(), ConfigError> {
        // Keychain IO on the caller's thread (the Tauri blocking pool), so a
        // slow or prompting keychain never stalls the core thread's queries.
        secrets
            .persist(connection.id())
            .map_err(|e| ConfigError::Message(e.to_string()))?;
        // A connection that stops signing in with a service account key
        // doesn't keep it.
        let uses_key = |c: &ConnectionRecord| {
            matches!(c, ConnectionRecord::Postgres(pg) if pg
                .cloud_sql
                .as_ref()
                .is_some_and(|c| c.credentials == CloudSqlCredentials::Key))
        };
        let used_key = self
            .list_connections()
            .iter()
            .any(|c| c.id() == connection.id() && uses_key(c));
        if used_key && !uses_key(&connection) {
            delete_secret(connection.id(), SecretKind::GcpKey)
                .map_err(|e| ConfigError::Message(e.to_string()))?;
        }
        let event = self
            .send_command(|respond_to| Command::UpsertConnection {
                connection,
                respond_to,
            })
            .ok_or_else(|| ConfigError::Message("core thread stopped".into()))?;
        self.write_snapshot(event)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use rowkery_core::connections::{
        PostgresConnection, PostgresSslMode, SqliteConnection, SshAuthMethod, SshConfig,
    };
    use rowkery_core::db::Value;
    use rowkery_core::secrets::ConnectionSecrets;
    use rusqlite::Connection;
    use std::fs;
    use std::sync::{Mutex, MutexGuard};
    use tempfile::NamedTempFile;

    static TEST_DIR_LOCK: Mutex<()> = Mutex::new(());

    fn test_guard() -> (MutexGuard<'static, ()>, NamedTempFile, String) {
        let guard = TEST_DIR_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        let dir = std::env::temp_dir().join(format!("rowkery-bridge-test-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).expect("mkdir");
        std::env::set_var("ROWKERY_CONFIG_DIR", dir.to_string_lossy().to_string());
        let file = NamedTempFile::new_in(dir).expect("temp db");
        let path = file.path().to_string_lossy().to_string();
        let conn = Connection::open(file.path()).expect("open");
        conn.execute_batch("CREATE TABLE t (id INTEGER); INSERT INTO t VALUES (1);")
            .expect("schema");
        (guard, file, path)
    }

    #[test]
    fn ping_round_trip() {
        let bridge = super::CoreBridge::spawn();
        assert_eq!(bridge.ping(), Some(Event::Pong));
    }

    /// Regression: nested `Runtime::block_on` on `rowkery-core` panicked with
    /// "Cannot start a runtime from within a runtime" (Save & connect).
    #[test]
    fn postgres_connect_no_server_returns_error_without_panic() {
        let (_guard, _file, _path) = test_guard();
        let bridge = super::CoreBridge::spawn();
        let id = "postgres-down";
        CoreBridge::upsert_connection(
            &bridge,
            ConnectionRecord::Postgres(PostgresConnection {
                environment: None,
                safe_mode: Default::default(),
                allow_mcp: false,
                mcp_hidden_tables: Vec::new(),
                mcp_until: None,
                mcp_samples_off: false,
                mcp_access: None,
                masked_columns: Default::default(),
                id: id.into(),
                name: "down".into(),
                host: "127.0.0.1".into(),
                port: 5439,
                database: "postgres".into(),
                username: "postgres".into(),
                ssl_mode: PostgresSslMode::Disable,
                ssl_root_cert: None,
                ssh: None,
                cloud_sql: None,
            }),
            ConnectionSecrets::default(),
        )
        .expect("save");
        let err = bridge
            .open_window("w1", id, None)
            .expect_err("should not connect");
        assert!(
            !err.is_empty(),
            "expected a human-readable error, got empty string"
        );
        std::env::remove_var("ROWKERY_CONFIG_DIR");
    }

    /// Secrets are stored by the caller (not the core thread) before the
    /// record, and removed with it.
    #[test]
    fn save_and_delete_connection_store_and_remove_secrets() {
        use rowkery_core::secrets::{get_secret, SecretKind};
        let (_guard, _file, _path) = test_guard();
        let bridge = super::CoreBridge::spawn();
        let id = "pg-secret";
        CoreBridge::upsert_connection(
            &bridge,
            ConnectionRecord::Postgres(PostgresConnection {
                allow_mcp: false,
                mcp_hidden_tables: Vec::new(),
                mcp_until: None,
                mcp_samples_off: false,
                mcp_access: None,
                masked_columns: Default::default(),
                environment: None,
                safe_mode: Default::default(),
                id: id.into(),
                name: "secret".into(),
                host: "127.0.0.1".into(),
                port: 5432,
                database: "postgres".into(),
                username: "postgres".into(),
                ssl_mode: PostgresSslMode::Disable,
                ssl_root_cert: None,
                ssh: None,
                cloud_sql: None,
            }),
            ConnectionSecrets {
                db_password: Some("hunter2".into()),
                ..Default::default()
            },
        )
        .expect("save");
        assert_eq!(
            get_secret(id, SecretKind::DbPassword).unwrap().as_deref(),
            Some("hunter2")
        );
        assert!(CoreBridge::list_connections(&bridge)
            .iter()
            .any(|c| c.id() == id));

        bridge.remove_connection(id, false).expect("delete");
        assert!(CoreBridge::list_connections(&bridge).is_empty());
        assert_eq!(get_secret(id, SecretKind::DbPassword).unwrap(), None);
        std::env::remove_var("ROWKERY_CONFIG_DIR");
    }

    /// A connection moved from a service account key to the gcloud login
    /// drops the key.
    #[test]
    fn switching_off_a_key_deletes_it() {
        use rowkery_core::connections::{CloudSqlConfig, CloudSqlIpType};
        use rowkery_core::secrets::{get_secret, SecretKind};
        let (_guard, _file, _path) = test_guard();
        let bridge = super::CoreBridge::spawn();
        let id = "pg-cloudsql-key";
        let record = |credentials| {
            ConnectionRecord::Postgres(PostgresConnection {
                allow_mcp: false,
                mcp_hidden_tables: Vec::new(),
                mcp_until: None,
                mcp_samples_off: false,
                mcp_access: None,
                masked_columns: Default::default(),
                environment: None,
                safe_mode: Default::default(),
                id: id.into(),
                name: "orders".into(),
                host: "acme:asia-southeast1:orders".into(),
                port: 5432,
                database: "postgres".into(),
                username: "postgres".into(),
                ssl_mode: PostgresSslMode::Disable,
                ssl_root_cert: None,
                ssh: None,
                cloud_sql: Some(CloudSqlConfig {
                    instance: "acme:asia-southeast1:orders".into(),
                    ip_type: CloudSqlIpType::Public,
                    credentials,
                }),
            })
        };
        CoreBridge::upsert_connection(
            &bridge,
            record(CloudSqlCredentials::Key),
            ConnectionSecrets {
                gcp_key: Some("{\"type\":\"service_account\"}".into()),
                ..Default::default()
            },
        )
        .expect("save");
        assert!(get_secret(id, SecretKind::GcpKey).unwrap().is_some());
        CoreBridge::upsert_connection(
            &bridge,
            record(CloudSqlCredentials::Gcloud),
            ConnectionSecrets::default(),
        )
        .expect("save");
        assert_eq!(get_secret(id, SecretKind::GcpKey).unwrap(), None);
        std::env::remove_var("ROWKERY_CONFIG_DIR");
    }

    #[test]
    fn postgres_connect_empty_name_rejected_at_core() {
        let (_guard, _file, _path) = test_guard();
        let bridge = super::CoreBridge::spawn();
        let id = "postgres-noname";
        CoreBridge::upsert_connection(
            &bridge,
            ConnectionRecord::Postgres(PostgresConnection {
                environment: None,
                safe_mode: Default::default(),
                allow_mcp: false,
                mcp_hidden_tables: Vec::new(),
                mcp_until: None,
                mcp_samples_off: false,
                mcp_access: None,
                masked_columns: Default::default(),
                id: id.into(),
                name: String::new(),
                host: "127.0.0.1".into(),
                port: 5432,
                database: "postgres".into(),
                username: "postgres".into(),
                ssl_mode: PostgresSslMode::Disable,
                ssl_root_cert: None,
                ssh: None,
                cloud_sql: None,
            }),
            ConnectionSecrets::default(),
        )
        .expect("save");
        let err = bridge
            .open_window("w1", id, None)
            .expect_err("should not connect");
        assert!(err.contains("Name"), "expected name validation, got: {err}");
        std::env::remove_var("ROWKERY_CONFIG_DIR");
    }

    #[test]
    fn postgres_connect_incomplete_ssh_returns_error_without_panic() {
        let (_guard, _file, _path) = test_guard();
        let bridge = super::CoreBridge::spawn();
        let id = "postgres-bad-ssh";
        CoreBridge::upsert_connection(
            &bridge,
            ConnectionRecord::Postgres(PostgresConnection {
                environment: None,
                safe_mode: Default::default(),
                allow_mcp: false,
                mcp_hidden_tables: Vec::new(),
                mcp_until: None,
                mcp_samples_off: false,
                mcp_access: None,
                masked_columns: Default::default(),
                id: id.into(),
                name: "bad ssh".into(),
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
                cloud_sql: None,
            }),
            ConnectionSecrets::default(),
        )
        .expect("save");
        let err = bridge
            .open_window("w1", id, None)
            .expect_err("should not connect");
        assert!(
            !err.is_empty(),
            "expected a human-readable error, got empty string"
        );
        std::env::remove_var("ROWKERY_CONFIG_DIR");
    }

    #[test]
    fn sqlite_introspect_via_bridge() {
        let (_guard, _file, path) = test_guard();
        let bridge = super::CoreBridge::spawn();
        let id = "sqlite-introspect";
        CoreBridge::upsert_connection(
            &bridge,
            ConnectionRecord::Sqlite(SqliteConnection {
                environment: None,
                safe_mode: Default::default(),
                allow_mcp: false,
                mcp_hidden_tables: Vec::new(),
                mcp_until: None,
                mcp_samples_off: false,
                mcp_access: None,
                masked_columns: Default::default(),
                id: id.into(),
                name: "test".into(),
                path,
                sample: false,
            }),
            ConnectionSecrets::default(),
        )
        .expect("save");
        let opened = bridge.open_window("w1", id, None).expect("open");
        assert!(opened.catalog.find_table("main", "main", "t").is_some());
        let reloaded = bridge.reload_window_schema("w1").expect("reload");
        assert!(reloaded.find_table("main", "main", "t").is_some());
        std::env::remove_var("ROWKERY_CONFIG_DIR");
    }

    #[test]
    fn sqlite_query_via_bridge() {
        let (_guard, _file, path) = test_guard();
        let bridge = super::CoreBridge::spawn();
        let id = "sqlite-test";
        CoreBridge::upsert_connection(
            &bridge,
            ConnectionRecord::Sqlite(SqliteConnection {
                environment: None,
                safe_mode: Default::default(),
                allow_mcp: false,
                mcp_hidden_tables: Vec::new(),
                mcp_until: None,
                mcp_samples_off: false,
                mcp_access: None,
                masked_columns: Default::default(),
                id: id.into(),
                name: "test".into(),
                path,
                sample: false,
            }),
            ConnectionSecrets::default(),
        )
        .expect("save");
        bridge.open_window("w1", id, None).expect("open");
        let queue = bridge
            .run_window_query("w1", 1, "SELECT id FROM t".into(), None, false)
            .expect("run");
        let (rows, error, cancelled) = wait_finished(&queue);
        assert_eq!((rows, error, cancelled), (1, None, false));
        std::env::remove_var("ROWKERY_CONFIG_DIR");
    }

    fn wait_finished(queue: &EventQueue) -> (u64, Option<String>, bool) {
        for _ in 0..100 {
            let drained: Vec<CoreEvent> = std::mem::take(&mut *queue.lock().unwrap());
            for event in drained {
                if let CoreEvent::QueryFinished {
                    row_count,
                    error,
                    cancelled,
                    ..
                } = event
                {
                    return (row_count, error, cancelled);
                }
            }
            thread::sleep(std::time::Duration::from_millis(20));
        }
        panic!("query did not finish");
    }

    /// Quick Look follows foreign keys in one call; a quote in a text key is
    /// escaped, not run; NULL and a missing row give `None`.
    #[test]
    fn sqlite_follow_keys_finds_the_rows_keys_point_at() {
        let (_guard, _file, path) = test_guard();
        Connection::open(&path)
            .unwrap()
            .execute_batch(
                "CREATE TABLE kiosks (id INTEGER PRIMARY KEY, name TEXT, code TEXT);
                 INSERT INTO kiosks VALUES (7, 'Bangsar', 'it''s');",
            )
            .unwrap();
        let bridge = super::CoreBridge::spawn();
        let id = "sqlite-follow";
        CoreBridge::upsert_connection(
            &bridge,
            ConnectionRecord::Sqlite(SqliteConnection {
                environment: None,
                safe_mode: Default::default(),
                allow_mcp: false,
                mcp_hidden_tables: Vec::new(),
                mcp_until: None,
                mcp_samples_off: false,
                mcp_access: None,
                masked_columns: Default::default(),
                id: id.into(),
                name: "test".into(),
                path,
                sample: false,
            }),
            ConnectionSecrets::default(),
        )
        .expect("save");
        bridge.open_window("w1", id, None).expect("open");
        let look = |column: &str, value: Value| FollowLookup {
            schema: "main".into(),
            table: "kiosks".into(),
            column: column.into(),
            value,
        };
        let rows = bridge
            .follow_keys(
                "w1",
                vec![
                    look("id", Value::Int(7)),
                    look("code", Value::Text("it's".into())),
                    look("code", Value::Text("x' OR '1'='1".into())),
                    look("id", Value::Null),
                    look("id", Value::Int(8)),
                ],
            )
            .expect("follow");
        let names: Vec<Option<Value>> = rows
            .iter()
            .map(|r| r.as_ref().map(|r| r.row[1].clone()))
            .collect();
        assert_eq!(
            names,
            [
                Some(Value::Text("Bangsar".into())),
                Some(Value::Text("Bangsar".into())),
                None,
                None,
                None
            ]
        );
        assert_eq!(rows[0].as_ref().unwrap().columns[1].name, "name");
        assert!(bridge.follow_keys("nope", vec![]).is_err());
        std::env::remove_var("ROWKERY_CONFIG_DIR");
    }

    /// Quick Look's Incoming counts the rows referencing a value, stopping
    /// one past the cap; NULL can't be matched.
    #[test]
    fn sqlite_count_incoming_is_bounded() {
        let (_guard, _file, path) = test_guard();
        Connection::open(&path)
            .unwrap()
            .execute_batch(
                "CREATE TABLE sessions (id INTEGER PRIMARY KEY, kiosk_id INTEGER);
                 WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 150)
                 INSERT INTO sessions SELECT i, CASE WHEN i <= 2 THEN 7 ELSE 3 END FROM n;",
            )
            .unwrap();
        let bridge = super::CoreBridge::spawn();
        let id = "sqlite-incoming";
        CoreBridge::upsert_connection(
            &bridge,
            ConnectionRecord::Sqlite(SqliteConnection {
                allow_mcp: false,
                mcp_hidden_tables: Vec::new(),
                mcp_until: None,
                mcp_samples_off: false,
                mcp_access: None,
                masked_columns: Default::default(),
                environment: None,
                safe_mode: Default::default(),
                id: id.into(),
                name: "test".into(),
                path,
                sample: false,
            }),
            ConnectionSecrets::default(),
        )
        .expect("save");
        bridge.open_window("w1", id, None).expect("open");
        let look = |value: Value| FollowLookup {
            schema: "main".into(),
            table: "sessions".into(),
            column: "kiosk_id".into(),
            value,
        };
        let counts = bridge
            .count_incoming(
                "w1",
                vec![
                    look(Value::Int(7)),
                    look(Value::Int(3)),
                    look(Value::Int(9)),
                    look(Value::Null),
                ],
            )
            .expect("count");
        assert_eq!(
            counts,
            [Some(2), Some(super::INCOMING_CAP + 1), Some(0), None]
        );
        std::env::remove_var("ROWKERY_CONFIG_DIR");
    }

    /// Saving a connection is on disk when the call returns; UI state reaches
    /// disk through the writer, and a restart reads both back.
    #[test]
    fn config_and_ui_state_survive_a_restart() {
        let (_guard, _file, path) = test_guard();
        let bridge = super::CoreBridge::spawn();
        assert_eq!(bridge.ui_state(), None);
        CoreBridge::upsert_connection(
            &bridge,
            ConnectionRecord::Sqlite(SqliteConnection {
                allow_mcp: false,
                mcp_hidden_tables: Vec::new(),
                mcp_until: None,
                mcp_samples_off: false,
                mcp_access: None,
                masked_columns: Default::default(),
                environment: None,
                safe_mode: Default::default(),
                id: "kept".into(),
                name: "kept".into(),
                path,
                sample: false,
            }),
            ConnectionSecrets::default(),
        )
        .expect("save");
        // On disk already, with no wait.
        assert_eq!(AppConfig::load().unwrap().connections.len(), 1);
        let ui = serde_json::json!({ "version": 1, "windows": [{ "connectionId": "kept", "tabs": [{ "sql": "select 1" }] }] });
        bridge.save_ui_state(ui.clone());
        assert_eq!(bridge.ui_state(), Some(ui.clone()));
        bridge.flush_config();
        drop(bridge);

        let again = super::CoreBridge::spawn();
        assert_eq!(again.ui_state(), Some(ui));
        assert_eq!(CoreBridge::list_connections(&again).len(), 1);
        // A theme change keeps the UI state in the file.
        again.save_theme(ThemePreference::Dark).expect("theme");
        let disk = AppConfig::load().unwrap();
        assert_eq!(disk.theme, ThemePreference::Dark);
        assert!(disk.ui.is_some());
        // So does the window-chrome switch, which the next launch reads.
        assert!(!again.get_config_blocking().unwrap().native_decorations);
        again.save_native_decorations(true).expect("decorations");
        let disk = AppConfig::load().unwrap();
        assert!(disk.native_decorations);
        assert!(disk.ui.is_some());
        drop(again);
        let third = super::CoreBridge::spawn();
        assert!(third.get_config_blocking().unwrap().native_decorations);
        std::env::remove_var("ROWKERY_CONFIG_DIR");
    }

    /// First launch writes the sample and lists it; a second launch doesn't
    /// bring a deleted sample back; "Open the sample database" does, and a
    /// reset puts its rows back.
    #[test]
    fn the_sample_database_on_first_run_open_and_reset() {
        let (_guard, _file, _path) = test_guard();
        let bridge = super::CoreBridge::spawn();
        assert_eq!(bridge.first_run(), Ok(true));
        let listed = CoreBridge::list_connections(&bridge);
        assert_eq!(listed, vec![rowkery_core::sample::sample_record()]);
        assert!(AppConfig::load().unwrap().first_run_done);
        bridge.remove_connection("sample", false).expect("delete");
        drop(bridge);

        let again = super::CoreBridge::spawn();
        assert_eq!(again.first_run(), Ok(false));
        assert!(CoreBridge::list_connections(&again).is_empty());
        let path = rowkery_core::sample::sample_path();
        Connection::open(&path)
            .unwrap()
            .execute_batch(
                "INSERT INTO games (title, genre, price_cents) VALUES ('Extra', 'demo', 1);",
            )
            .unwrap();
        let games = || -> i64 {
            Connection::open(&path)
                .unwrap()
                .query_row("SELECT COUNT(*) FROM games", [], |r| r.get(0))
                .unwrap()
        };
        // Open keeps the working copy as it is; reset writes a fresh one.
        assert_eq!(again.open_sample(false).unwrap().id(), "sample");
        assert_eq!(games(), 9);
        assert_eq!(CoreBridge::list_connections(&again).len(), 1);
        again.open_sample(true).unwrap();
        assert_eq!(games(), 8);
        assert_eq!(CoreBridge::list_connections(&again).len(), 1);
        std::env::remove_var("ROWKERY_CONFIG_DIR");
    }

    /// At launch the saved active window opens before the webview asks; the
    /// matching `open_window` joins it (here: it still has the catalog read
    /// before the file was removed), another window opens afresh.
    #[test]
    fn the_saved_active_window_opens_at_launch() {
        let (_guard, _file, path) = test_guard();
        let bridge = super::CoreBridge::spawn();
        CoreBridge::upsert_connection(
            &bridge,
            ConnectionRecord::Sqlite(SqliteConnection {
                allow_mcp: false,
                mcp_hidden_tables: Vec::new(),
                mcp_until: None,
                mcp_samples_off: false,
                mcp_access: None,
                masked_columns: Default::default(),
                environment: None,
                safe_mode: Default::default(),
                id: "early".into(),
                name: "early".into(),
                path: path.clone(),
                sample: false,
            }),
            ConnectionSecrets::default(),
        )
        .expect("save");
        bridge.save_ui_state(serde_json::json!({
            "version": 1,
            "keys": { "rowkery.windows": { "windows": [
                { "connectionId": null, "database": null },
                { "connectionId": "early", "database": null }
            ], "active": 1 } }
        }));
        bridge.flush_config();
        drop(bridge);

        let started = Instant::now();
        let relaunched = super::CoreBridge::spawn();
        thread::sleep(std::time::Duration::from_millis(300));
        // The launch-time open says when its file was ready, to a listener
        // that registers after the fact too (the app's setup runs later).
        let (tx, rx) = std::sync::mpsc::channel();
        relaunched.on_launch_warm(move |at| {
            let _ = tx.send(at);
        });
        let warm = rx
            .recv_timeout(std::time::Duration::from_secs(2))
            .expect("launch warm");
        assert!(warm >= started && warm <= Instant::now());
        std::fs::remove_file(&path).expect("remove db");
        let joined = relaunched.open_window("w2", "early", None).expect("w2");
        assert!(
            joined.catalog.find_table("main", "main", "t").is_some(),
            "w2 joined the launch-time open"
        );
        let fresh = relaunched.open_window("w3", "early", None);
        assert!(fresh.is_err(), "w3 opened afresh, and the file is gone");
        std::env::remove_var("ROWKERY_CONFIG_DIR");
    }

    /// Postgres: after a relaunch the first window's open is already done
    /// (session warm, schema loaded) when the webview asks for it.
    #[test]
    fn postgres_launch_time_open_is_ready_when_asked() {
        if std::env::var("ROWKERY_PG_HOST").is_err() {
            eprintln!("skip postgres_launch_time_open_is_ready_when_asked (set ROWKERY_PG_HOST)");
            return;
        }
        let (_guard, _file, _path) = test_guard();
        let bridge = super::CoreBridge::spawn();
        CoreBridge::upsert_connection(
            &bridge,
            ConnectionRecord::Postgres(PostgresConnection {
                allow_mcp: false,
                mcp_hidden_tables: Vec::new(),
                mcp_until: None,
                mcp_samples_off: false,
                mcp_access: None,
                masked_columns: Default::default(),
                environment: None,
                safe_mode: Default::default(),
                id: "pg-early".into(),
                name: "pg early".into(),
                host: std::env::var("ROWKERY_PG_HOST").unwrap(),
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
            }),
            ConnectionSecrets {
                db_password: Some(
                    std::env::var("ROWKERY_PG_PASSWORD").unwrap_or_else(|_| "rowkery".into()),
                ),
                ..Default::default()
            },
        )
        .expect("save");
        // Cold: no launch-time open.
        let started = Instant::now();
        bridge.open_window("w1", "pg-early", None).expect("open");
        let cold = started.elapsed();
        bridge.save_ui_state(serde_json::json!({
            "version": 1,
            "keys": { "rowkery.windows": { "windows": [{ "connectionId": "pg-early", "database": "rowkery" }], "active": 0 } }
        }));
        bridge.flush_config();
        drop(bridge);

        let relaunched = super::CoreBridge::spawn();
        // The webview takes about this long to boot.
        thread::sleep(cold * 2 + std::time::Duration::from_millis(100));
        let started = Instant::now();
        let opened = relaunched
            .open_window("w1", "pg-early", None)
            .expect("open");
        let warm = started.elapsed();
        assert!(opened.catalog.databases.iter().any(|d| d.name == "rowkery"));
        assert!(
            warm * 3 < cold,
            "launch-time open: asked after {warm:?}, cold open took {cold:?}"
        );
        let (one, ..) = window_query(&relaunched, "w1", 1, "SELECT 1");
        assert_eq!(one, Some(Value::Int(1)));
        std::env::remove_var("ROWKERY_CONFIG_DIR");
    }

    /// A launch-time open answered from the catalog cache checks the cache
    /// while the webview boots, before anything listens. Joining it must
    /// still deliver that outcome, or the sidebar spinner never stops.
    #[test]
    fn postgres_launch_time_cache_check_reaches_a_late_listener() {
        if std::env::var("ROWKERY_PG_HOST").is_err() {
            eprintln!(
                "skip postgres_launch_time_cache_check_reaches_a_late_listener (set ROWKERY_PG_HOST)"
            );
            return;
        }
        let (_guard, _file, _path) = test_guard();
        let bridge = super::CoreBridge::spawn();
        CoreBridge::upsert_connection(
            &bridge,
            ConnectionRecord::Postgres(PostgresConnection {
                allow_mcp: false,
                mcp_hidden_tables: Vec::new(),
                mcp_until: None,
                mcp_samples_off: false,
                mcp_access: None,
                masked_columns: Default::default(),
                environment: None,
                safe_mode: Default::default(),
                id: "pg-late".into(),
                name: "pg late".into(),
                host: std::env::var("ROWKERY_PG_HOST").unwrap(),
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
            }),
            ConnectionSecrets {
                db_password: Some(
                    std::env::var("ROWKERY_PG_PASSWORD").unwrap_or_else(|_| "rowkery".into()),
                ),
                ..Default::default()
            },
        )
        .expect("save");
        // Cold open: fills the catalog cache.
        bridge.open_window("w1", "pg-late", None).expect("open");
        bridge.save_ui_state(serde_json::json!({
            "version": 1,
            "keys": { "rowkery.windows": { "windows": [{ "connectionId": "pg-late", "database": "rowkery" }], "active": 0 } }
        }));
        bridge.flush_config();
        drop(bridge);

        let relaunched = super::CoreBridge::spawn();
        // The webview boots; the cache check finishes with no one listening.
        thread::sleep(std::time::Duration::from_millis(1500));
        let updates: Arc<Mutex<Vec<CatalogUpdate>>> = Arc::default();
        let sink = updates.clone();
        relaunched.on_catalog_update(Arc::new(move |u| sink.lock().unwrap().push(u)));
        let opened = relaunched.open_window("w1", "pg-late", None).expect("open");
        assert!(opened.cached, "answered from the catalog cache");
        let deadline = Instant::now() + std::time::Duration::from_secs(5);
        loop {
            let got = updates.lock().unwrap().clone();
            if got.iter().any(|u| {
                matches!(u, CatalogUpdate::Confirmed { window_id, open_seq }
                    if window_id == "w1" && *open_seq == opened.open_seq)
            }) {
                break;
            }
            assert!(
                Instant::now() < deadline,
                "no Confirmed for the joined open: {got:?}"
            );
            thread::sleep(std::time::Duration::from_millis(20));
        }
        std::env::remove_var("ROWKERY_CONFIG_DIR");
    }

    #[test]
    fn sqlite_windows_run_queries_on_their_own_queues() {
        let (_guard, _file, path) = test_guard();
        let bridge = super::CoreBridge::spawn();
        let id = "sqlite-windows";
        CoreBridge::upsert_connection(
            &bridge,
            ConnectionRecord::Sqlite(SqliteConnection {
                allow_mcp: false,
                mcp_hidden_tables: Vec::new(),
                mcp_until: None,
                mcp_samples_off: false,
                mcp_access: None,
                masked_columns: Default::default(),
                environment: None,
                safe_mode: Default::default(),
                id: id.into(),
                name: "test".into(),
                path,
                sample: false,
            }),
            ConnectionSecrets::default(),
        )
        .expect("save");

        let opened = bridge.open_window("w1", id, None).expect("open w1");
        assert_eq!(opened.database, "main");
        assert!(opened.catalog.find_table("main", "main", "t").is_some());
        assert_eq!(opened.server_version.as_deref(), Some(sqlite_version()));
        bridge.open_window("w2", id, None).expect("open w2");
        assert!(bridge.list_databases("w1").expect("list").is_empty());

        // Both windows run tab 1 at once; neither steals the other's result.
        let q1 = bridge
            .run_window_query("w1", 1, "SELECT id FROM t".into(), None, false)
            .expect("run w1");
        let q2 = bridge
            .run_window_query("w2", 1, "SELECT id FROM t WHERE 0".into(), None, false)
            .expect("run w2");
        let (rows2, err2, _) = wait_finished(&q2);
        let (rows1, err1, _) = wait_finished(&q1);
        assert_eq!((err1, err2), (None, None));
        assert!(rows1 > 0);
        assert_eq!(rows2, 0);

        bridge.close_window("w2");
        let err = bridge
            .run_window_query("w2", 1, "SELECT 1".into(), None, false)
            .expect_err("closed window");
        assert!(err.contains("not connected"));
        assert!(bridge.open_window("w3", "missing", None).is_err());
        std::env::remove_var("ROWKERY_CONFIG_DIR");
    }

    fn held(queue: &EventQueue) -> Option<rowkery_core::safety::SafetyHold> {
        std::mem::take(&mut *queue.lock().unwrap())
            .into_iter()
            .find_map(|e| match e {
                CoreEvent::QueryHeld { hold, .. } => Some(hold),
                _ => None,
            })
    }

    #[test]
    fn safe_mode_holds_and_refuses_writes() {
        use rowkery_core::safety::HoldAction;
        let (_guard, _file, path) = test_guard();
        let bridge = super::CoreBridge::spawn();
        let save = |id: &str, safe_mode: SafeMode| {
            CoreBridge::upsert_connection(
                &bridge,
                ConnectionRecord::Sqlite(SqliteConnection {
                    environment: None,
                    safe_mode,
                    allow_mcp: false,
                    mcp_hidden_tables: Vec::new(),
                    mcp_until: None,
                    mcp_samples_off: false,
                    mcp_access: None,
                    masked_columns: Default::default(),
                    id: id.into(),
                    name: id.into(),
                    path: path.clone(),
                    sample: false,
                }),
                ConnectionSecrets::default(),
            )
            .expect("save");
        };
        save("confirm", SafeMode::Confirm);
        save("ro", SafeMode::ReadOnly);
        bridge.open_window("wc", "confirm", None).expect("open");
        bridge.open_window("wr", "ro", None).expect("open");
        let run = |w: &str, sql: &str, confirmed: bool| {
            bridge
                .run_window_query(w, 1, sql.into(), None, confirmed)
                .expect("run")
        };
        let count = |w: &str| wait_finished(&run(w, "SELECT id FROM t", false)).0;

        // Reads run straight away in both modes.
        assert_eq!(count("wc"), 1);
        assert_eq!(count("wr"), 1);

        // Confirm writes: held until confirmed, then it runs.
        let hold = held(&run("wc", "INSERT INTO t VALUES (2)", false)).expect("held");
        assert_eq!(hold.action, HoldAction::Confirm);
        assert_eq!(hold.statements[0].verb, "INSERT");
        assert_eq!(hold.statements[0].target.as_deref(), Some("t"));
        assert_eq!(count("wc"), 1, "nothing ran while held");
        let (_, err, _) = wait_finished(&run("wc", "INSERT INTO t VALUES (2)", true));
        assert_eq!(err, None);
        assert_eq!(count("wc"), 2);

        // Read-only: refused even when confirmed, and SQLite refuses too.
        let hold = held(&run("wr", "DELETE FROM t", true)).expect("refused");
        assert_eq!(hold.action, HoldAction::Refuse);
        assert!(hold.statements[0].destructive);
        assert!(held(&run("wr", "PRAGMA query_only = 0", true)).is_some());
        assert_eq!(count("wr"), 2);

        // A saved change applies to open windows without reopening them.
        save("ro", SafeMode::Off);
        let (_, err, _) = wait_finished(&run("wr", "DELETE FROM t", false));
        assert_eq!(err, None);
        assert_eq!(count("wr"), 0);
        std::env::remove_var("ROWKERY_CONFIG_DIR");
    }

    /// ⌘E on SQLite: the plan tree, a hint from counted rows, safe mode
    /// never involved (nothing runs).
    #[test]
    fn sqlite_explain_reads_the_plan_and_runs_nothing() {
        let (_guard, _file, path) = test_guard();
        Connection::open(&path)
            .unwrap()
            .execute_batch(
                "CREATE TABLE big (id INTEGER PRIMARY KEY, n INT);
                 INSERT INTO big (n) WITH RECURSIVE c(x) AS
                   (SELECT 1 UNION ALL SELECT x + 1 FROM c WHERE x < 12000) SELECT x FROM c;",
            )
            .unwrap();
        let bridge = super::CoreBridge::spawn();
        CoreBridge::upsert_connection(
            &bridge,
            ConnectionRecord::Sqlite(SqliteConnection {
                environment: None,
                safe_mode: SafeMode::ReadOnly,
                allow_mcp: false,
                mcp_hidden_tables: Vec::new(),
                mcp_until: None,
                mcp_samples_off: false,
                mcp_access: None,
                masked_columns: Default::default(),
                id: "plan".into(),
                name: "plan".into(),
                path: path.clone(),
                sample: false,
            }),
            ConnectionSecrets::default(),
        )
        .expect("save");
        bridge.open_window("w", "plan", None).expect("open");
        let out = bridge
            .explain(
                "w",
                1,
                "SELECT * FROM big WHERE n = 5 ORDER BY n;".into(),
                true,
                false,
            )
            .expect("explain");
        let ExplainOutcome::Plan { plan, .. } = out else {
            panic!("{out:?}")
        };
        assert!(!plan.timed);
        assert_eq!(plan.steps[0].kind, "Scan");
        assert_eq!(plan.steps[0].table.as_deref(), Some("big"));
        assert_eq!(
            plan.hint.expect("hint").text,
            "SQLite reads every row of big (12,000). If you filter or join on one of its columns, an index on it lets SQLite go straight to the rows."
        );
        // A write's plan on a read-only connection: EXPLAIN QUERY PLAN never
        // runs it, and the row is still there.
        let out = bridge
            .explain("w", 1, "DELETE FROM big WHERE id = 1".into(), false, false)
            .expect("explain");
        assert!(matches!(out, ExplainOutcome::Plan { .. }), "{out:?}");
        assert_eq!(
            int_of(window_query(&bridge, "w", 1, "SELECT count(*) FROM big").0),
            12000
        );
        let err = bridge
            .explain("w", 1, "SELECT 1; SELECT 2".into(), false, false)
            .expect_err("two statements");
        assert_eq!(err, "Explain works on one statement at a time.");
        std::env::remove_var("ROWKERY_CONFIG_DIR");
    }

    /// ⌘E on Postgres: an estimate with a missing-index hint; a timed plan of
    /// a write held by Confirm writes, then run and rolled back, also inside
    /// the user's own transaction.
    #[test]
    fn postgres_explain_estimates_times_and_rolls_back_writes() {
        let (_guard, _file, _path) = test_guard();
        let bridge = super::CoreBridge::spawn();
        if save_pg_at(&bridge, "plan-pg", None, SafeMode::Confirm).is_none() {
            eprintln!(
                "skip postgres_explain_estimates_times_and_rolls_back_writes (set ROWKERY_PG_HOST)"
            );
            return;
        }
        save_pg_at(&bridge, "plan-setup", None, SafeMode::Off);
        bridge.open_window("w", "plan-pg", None).expect("open");
        bridge.open_window("s", "plan-setup", None).expect("open");
        for sql in [
            "DROP TABLE IF EXISTS plan_orders",
            "CREATE TABLE plan_orders (id int PRIMARY KEY, customer_id int, total int)",
            "INSERT INTO plan_orders SELECT g, g % 5000, g FROM generate_series(1, 60000) g",
            "ANALYZE plan_orders",
        ] {
            assert_eq!(window_query(&bridge, "s", 9, sql).1, None, "{sql}");
        }
        let rows = |bridge: &super::CoreBridge| {
            int_of(window_query(bridge, "s", 9, "SELECT count(*)::int FROM plan_orders").0)
        };
        assert_eq!(rows(&bridge), 60000);

        let ExplainOutcome::Plan { plan, .. } = bridge
            .explain(
                "w",
                1,
                "SELECT * FROM plan_orders WHERE customer_id = 42".into(),
                false,
                false,
            )
            .expect("estimate")
        else {
            panic!("no plan")
        };
        assert!(!plan.timed);
        assert!(plan.steps.iter().any(|s| s.kind.ends_with("Seq Scan")));
        let hint = plan.hint.expect("hint");
        assert!(
            hint.text.ends_with("plan_orders.customer_id has no index."),
            "{}",
            hint.text
        );
        assert_eq!(
            hint.sql.as_deref(),
            Some("CREATE INDEX ON public.plan_orders (customer_id);")
        );

        // Timed read: real times.
        let ExplainOutcome::Plan { plan, .. } = bridge
            .explain(
                "w",
                1,
                "SELECT count(*) FROM plan_orders".into(),
                true,
                false,
            )
            .expect("timed")
        else {
            panic!("no plan")
        };
        assert!(plan.timed && plan.execution_ms.is_some());
        assert_eq!(plan.rows, Some(1.0));

        // Timed write: held, then run and rolled back.
        let delete = "DELETE FROM plan_orders WHERE id <= 10".to_string();
        let out = bridge
            .explain("w", 1, delete.clone(), true, false)
            .expect("held");
        assert!(matches!(out, ExplainOutcome::Held { .. }), "{out:?}");
        let ExplainOutcome::Plan { plan, .. } = bridge
            .explain("w", 1, delete.clone(), true, true)
            .expect("timed write")
        else {
            panic!("no plan")
        };
        assert_eq!(plan.steps[0].kind, "Delete");
        assert_eq!(rows(&bridge), 60000, "rolled back");

        // Inside the user's own transaction: a savepoint, and the transaction
        // carries on with its own change.
        let run = |sql: &str| {
            let queue = bridge
                .run_window_query("w", 1, sql.into(), None, true)
                .expect("run");
            wait_finished(&queue).1
        };
        assert_eq!(run("BEGIN"), None);
        assert_eq!(run("DELETE FROM plan_orders WHERE id = 60000"), None);
        let out = bridge
            .explain("w", 1, delete, true, true)
            .expect("timed write");
        assert!(matches!(out, ExplainOutcome::Plan { .. }), "{out:?}");
        assert_eq!(run("COMMIT"), None);
        assert_eq!(
            rows(&bridge),
            59999,
            "the user's delete kept, ours rolled back"
        );
        window_query(&bridge, "s", 9, "DROP TABLE plan_orders");
        std::env::remove_var("ROWKERY_CONFIG_DIR");
    }

    #[test]
    fn seed_pg_verify_connection_for_gui() {
        if std::env::var("ROWKERY_SEED_PG_GUI").is_err() {
            return;
        }
        let (_guard, _file, _path) = test_guard();
        let bridge = super::CoreBridge::spawn();
        let host = std::env::var("ROWKERY_PG_HOST").unwrap_or_else(|_| "127.0.0.1".into());
        let port = std::env::var("ROWKERY_PG_PORT")
            .ok()
            .and_then(|p| p.parse().ok())
            .unwrap_or(54329);
        CoreBridge::upsert_connection(
            &bridge,
            ConnectionRecord::Postgres(PostgresConnection {
                environment: None,
                safe_mode: Default::default(),
                allow_mcp: false,
                mcp_hidden_tables: Vec::new(),
                mcp_until: None,
                mcp_samples_off: false,
                mcp_access: None,
                masked_columns: Default::default(),
                id: "pg-verify".into(),
                name: "PG Verify".into(),
                host,
                port,
                database: std::env::var("ROWKERY_PG_DB").unwrap_or_else(|_| "rowkery".into()),
                username: std::env::var("ROWKERY_PG_USER").unwrap_or_else(|_| "rowkery".into()),
                ssl_mode: PostgresSslMode::Disable,
                ssl_root_cert: None,
                ssh: None,
                cloud_sql: None,
            }),
            ConnectionSecrets {
                db_password: Some(
                    std::env::var("ROWKERY_PG_PASSWORD").unwrap_or_else(|_| "rowkery".into()),
                ),
                ssh_password: None,
                ssh_key_passphrase: None,
                gcp_key: None,
            },
        )
        .expect("seed");
        std::env::remove_var("ROWKERY_CONFIG_DIR");
    }

    #[test]
    fn probe_reports_version_and_errors_without_saving() {
        let (_guard, _file, path) = test_guard();
        let lite = probe_connection_blocking(
            ConnectionRecord::Sqlite(SqliteConnection {
                environment: None,
                safe_mode: Default::default(),
                allow_mcp: false,
                mcp_hidden_tables: Vec::new(),
                mcp_until: None,
                mcp_samples_off: false,
                mcp_access: None,
                masked_columns: Default::default(),
                id: "probe-lite".into(),
                name: "lite".into(),
                path,
                sample: false,
            }),
            ConnectionSecrets::default(),
        );
        assert!(lite.ok, "{}", lite.message);

        let missing = probe_connection_blocking(
            ConnectionRecord::Sqlite(SqliteConnection {
                environment: None,
                safe_mode: Default::default(),
                allow_mcp: false,
                mcp_hidden_tables: Vec::new(),
                mcp_until: None,
                mcp_samples_off: false,
                mcp_access: None,
                masked_columns: Default::default(),
                id: "probe-missing".into(),
                name: "missing".into(),
                path: "/nonexistent/rowkery.sqlite".into(),
                sample: false,
            }),
            ConnectionSecrets::default(),
        );
        assert!(!missing.ok);
        assert!(missing.message.contains("not found"), "{}", missing.message);

        if std::env::var("ROWKERY_PG_HOST").is_err() {
            eprintln!("skip postgres probe (set ROWKERY_PG_HOST)");
            return;
        }
        let pg = PostgresConnection {
            environment: None,
            safe_mode: Default::default(),
            allow_mcp: false,
            mcp_hidden_tables: Vec::new(),
            mcp_until: None,
            mcp_samples_off: false,
            mcp_access: None,
            masked_columns: Default::default(),
            id: "probe-pg".into(),
            name: "probe".into(),
            host: std::env::var("ROWKERY_PG_HOST").unwrap(),
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
        };
        let good = probe_connection_blocking(
            ConnectionRecord::Postgres(pg.clone()),
            ConnectionSecrets {
                db_password: std::env::var("ROWKERY_PG_PASSWORD").ok(),
                ..Default::default()
            },
        );
        assert!(good.ok, "{}", good.message);
        assert!(good.message.starts_with("PostgreSQL 1"), "{}", good.message);

        let bad = probe_connection_blocking(
            ConnectionRecord::Postgres(PostgresConnection {
                database: "rowkery_probe_missing_db".into(),
                ..pg
            }),
            ConnectionSecrets {
                db_password: std::env::var("ROWKERY_PG_PASSWORD").ok(),
                ..Default::default()
            },
        );
        assert!(!bad.ok);
        // Nothing was saved by probing.
        let bridge = super::CoreBridge::spawn();
        assert!(CoreBridge::list_connections(&bridge)
            .iter()
            .all(|c| !c.id().starts_with("probe")));
    }

    /// Needs a second database named `orders` on the test server.
    #[test]
    fn postgres_window_switches_database() {
        if std::env::var("ROWKERY_PG_HOST").is_err() {
            eprintln!("skip postgres_window_switches_database (set ROWKERY_PG_HOST)");
            return;
        }
        let (_guard, _file, _path) = test_guard();
        let bridge = super::CoreBridge::spawn();
        let id = "postgres-window";
        CoreBridge::upsert_connection(
            &bridge,
            ConnectionRecord::Postgres(PostgresConnection {
                environment: None,
                safe_mode: Default::default(),
                allow_mcp: false,
                mcp_hidden_tables: Vec::new(),
                mcp_until: None,
                mcp_samples_off: false,
                mcp_access: None,
                masked_columns: Default::default(),
                id: id.into(),
                name: "pg window".into(),
                host: std::env::var("ROWKERY_PG_HOST").unwrap(),
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
            }),
            ConnectionSecrets {
                db_password: Some(
                    std::env::var("ROWKERY_PG_PASSWORD").unwrap_or_else(|_| "rowkery".into()),
                ),
                ..Default::default()
            },
        )
        .expect("save");

        let opened = bridge.open_window("w1", id, None).expect("open");
        assert_eq!(opened.database, "rowkery");
        let version = opened.server_version.expect("server version");
        assert!(
            version.chars().next().is_some_and(|c| c.is_ascii_digit()),
            "{version}"
        );
        let dbs = bridge.list_databases("w1").expect("list databases");
        let names: Vec<&str> = dbs.iter().map(|d| d.name.as_str()).collect();
        assert!(
            names.contains(&"rowkery") && names.contains(&"orders"),
            "{names:?}"
        );
        assert!(!names.contains(&"template0"));
        assert!(dbs.iter().all(|d| d.size_bytes.is_some()));

        let opened = bridge
            .open_window("w1", id, Some("orders".into()))
            .expect("switch database");
        assert_eq!(opened.database, "orders");
        let queue = bridge
            .run_window_query("w1", 1, "SELECT current_database()".into(), None, false)
            .expect("run");
        let mut current = None;
        for _ in 0..200 {
            let drained: Vec<CoreEvent> = std::mem::take(&mut *queue.lock().unwrap());
            for event in drained {
                if let CoreEvent::QueryBatch { batch, .. } = event {
                    current = batch.rows.first().and_then(|r| r.first()).cloned();
                }
            }
            if current.is_some() {
                break;
            }
            thread::sleep(std::time::Duration::from_millis(20));
        }
        assert_eq!(
            current,
            Some(rowkery_core::db::Value::Text("orders".into()))
        );

        let err = bridge
            .open_window("w2", id, Some("rowkery_missing_db".into()))
            .expect_err("missing database");
        assert!(!err.is_empty());
        std::env::remove_var("ROWKERY_CONFIG_DIR");
    }

    #[test]
    fn postgres_schema_and_query_via_bridge() {
        if std::env::var("ROWKERY_PG_HOST").is_err() {
            eprintln!("skip postgres_schema_and_query_via_bridge (set ROWKERY_PG_HOST)");
            return;
        }
        let (_guard, _file, _path) = test_guard();
        let bridge = super::CoreBridge::spawn();
        let id = "postgres-verify";
        let host = std::env::var("ROWKERY_PG_HOST").unwrap_or_else(|_| "127.0.0.1".into());
        let port = std::env::var("ROWKERY_PG_PORT")
            .ok()
            .and_then(|p| p.parse().ok())
            .unwrap_or(54329);
        let database = std::env::var("ROWKERY_PG_DB").unwrap_or_else(|_| "rowkery".into());
        let username = std::env::var("ROWKERY_PG_USER").unwrap_or_else(|_| "rowkery".into());
        let password = std::env::var("ROWKERY_PG_PASSWORD").unwrap_or_else(|_| "rowkery".into());
        CoreBridge::upsert_connection(
            &bridge,
            ConnectionRecord::Postgres(PostgresConnection {
                environment: None,
                safe_mode: Default::default(),
                allow_mcp: false,
                mcp_hidden_tables: Vec::new(),
                mcp_until: None,
                mcp_samples_off: false,
                mcp_access: None,
                masked_columns: Default::default(),
                id: id.into(),
                name: "pg verify".into(),
                host,
                port,
                database,
                username,
                ssl_mode: PostgresSslMode::Disable,
                ssl_root_cert: None,
                ssh: None,
                cloud_sql: None,
            }),
            ConnectionSecrets {
                db_password: Some(password),
                ssh_password: None,
                ssh_key_passphrase: None,
                gcp_key: None,
            },
        )
        .expect("save");
        bridge.open_window("w1", id, None).expect("open");
        let run = |sql: &str| {
            let queue = bridge
                .run_window_query("w1", 1, sql.into(), None, false)
                .expect("run");
            wait_finished(&queue)
        };
        // The test seeds its own table, so it runs on a fresh test Postgres.
        for sql in [
            "CREATE SCHEMA IF NOT EXISTS verify_bridge",
            "DROP TABLE IF EXISTS verify_bridge.widgets CASCADE",
            "CREATE TABLE verify_bridge.widgets (id serial PRIMARY KEY, name text NOT NULL, \
             qty integer, meta jsonb DEFAULT '{}'::jsonb)",
            "INSERT INTO verify_bridge.widgets (name, qty) VALUES ('alpha', 3), ('beta', 7), ('gamma', 11)",
        ] {
            let (_, error, _) = run(sql);
            assert!(error.is_none(), "seed failed: {sql}: {error:?}");
        }
        let reloaded = bridge.reload_window_schema("w1").expect("reload");
        assert!(
            reloaded
                .find_table("rowkery", "verify_bridge", "widgets")
                .is_some(),
            "expected verify_bridge.widgets in catalog"
        );
        let (rows, error, _) = run("SELECT 1 AS one");
        assert!(error.is_none(), "SELECT 1 should succeed, got: {error:?}");
        assert_eq!(rows, 1);

        let (rows, error, _) = run("SELECT * FROM verify_bridge.widgets LIMIT 10");
        assert!(error.is_none(), "widgets query failed: {error:?}");
        assert!(rows >= 3, "expected at least 3 rows");

        let (_, error, _) = run("SELECT * FROM users");
        let err = error.expect("missing users table should error");
        assert!(
            err.contains("users") || err.contains("does not exist"),
            "expected postgres message, got: {err}"
        );
        assert_ne!(err, "db error");
        std::env::remove_var("ROWKERY_CONFIG_DIR");
    }

    #[test]
    fn probe_connection_does_not_persist_record() {
        let (_guard, _file, path) = test_guard();
        let bridge = super::CoreBridge::spawn();
        assert!(CoreBridge::list_connections(&bridge).is_empty());
        let outcome = probe_connection_blocking(
            ConnectionRecord::Sqlite(SqliteConnection {
                environment: None,
                safe_mode: Default::default(),
                allow_mcp: false,
                mcp_hidden_tables: Vec::new(),
                mcp_until: None,
                mcp_samples_off: false,
                mcp_access: None,
                masked_columns: Default::default(),
                id: "probe-sqlite".into(),
                name: "probe".into(),
                path,
                sample: false,
            }),
            ConnectionSecrets::default(),
        );
        assert!(outcome.ok, "probe should connect: {}", outcome.message);
        assert_eq!(outcome.message, "SQLite");
        assert!(
            CoreBridge::list_connections(&bridge).is_empty(),
            "probe must not upsert sidebar connections"
        );
        std::env::remove_var("ROWKERY_CONFIG_DIR");
    }

    /// Waits for the next `QueryFinished` and returns `(error, cancelled)`.
    fn wait_query_finished(
        queue: &EventQueue,
        timeout: std::time::Duration,
    ) -> Option<(Option<String>, bool)> {
        let deadline = std::time::Instant::now() + timeout;
        while std::time::Instant::now() < deadline {
            let drained: Vec<CoreEvent> = std::mem::take(&mut *queue.lock().unwrap());
            for event in drained {
                if let CoreEvent::QueryFinished {
                    error, cancelled, ..
                } = event
                {
                    return Some((error, cancelled));
                }
            }
            thread::sleep(std::time::Duration::from_millis(10));
        }
        None
    }

    fn connect_sqlite(bridge: &super::CoreBridge, path: String) {
        CoreBridge::upsert_connection(
            bridge,
            ConnectionRecord::Sqlite(SqliteConnection {
                environment: None,
                safe_mode: Default::default(),
                allow_mcp: false,
                mcp_hidden_tables: Vec::new(),
                mcp_until: None,
                mcp_samples_off: false,
                mcp_access: None,
                masked_columns: Default::default(),
                id: "cancel-sqlite".into(),
                name: "cancel".into(),
                path,
                sample: false,
            }),
            ConnectionSecrets::default(),
        )
        .expect("save");
        bridge
            .open_window("w1", "cancel-sqlite", None)
            .expect("open");
    }

    const SLOW_SQLITE: &str = "WITH RECURSIVE n(x) AS (SELECT 1 UNION ALL SELECT x + 1 FROM n) \
                               SELECT count(*) FROM n";

    #[test]
    fn sqlite_cancel_stops_running_query() {
        let (_guard, _file, path) = test_guard();
        let bridge = super::CoreBridge::spawn();
        connect_sqlite(&bridge, path);
        let queue = bridge
            .run_window_query("w1", 1, SLOW_SQLITE.into(), None, false)
            .expect("run");
        thread::sleep(std::time::Duration::from_millis(300));
        bridge.cancel_window_query("w1", 1);
        let (error, cancelled) =
            wait_query_finished(&queue, std::time::Duration::from_secs(5)).expect("finish");
        assert!(cancelled, "query should report cancelled, error: {error:?}");
        std::env::remove_var("ROWKERY_CONFIG_DIR");
    }

    #[test]
    fn sqlite_cancel_right_after_run_is_not_lost() {
        let (_guard, _file, path) = test_guard();
        let bridge = super::CoreBridge::spawn();
        connect_sqlite(&bridge, path);
        let queue = bridge
            .run_window_query("w1", 1, SLOW_SQLITE.into(), None, false)
            .expect("run");
        bridge.cancel_window_query("w1", 1);
        let (error, cancelled) =
            wait_query_finished(&queue, std::time::Duration::from_secs(5)).expect("finish");
        assert!(cancelled, "query should report cancelled, error: {error:?}");
        std::env::remove_var("ROWKERY_CONFIG_DIR");
    }

    #[test]
    fn postgres_cancel_stops_running_query() {
        if std::env::var("ROWKERY_PG_HOST").is_err() {
            eprintln!("skip postgres_cancel_stops_running_query (set ROWKERY_PG_HOST)");
            return;
        }
        let (_guard, _file, _path) = test_guard();
        let bridge = super::CoreBridge::spawn();
        let id = "postgres-cancel";
        CoreBridge::upsert_connection(
            &bridge,
            ConnectionRecord::Postgres(PostgresConnection {
                environment: None,
                safe_mode: Default::default(),
                allow_mcp: false,
                mcp_hidden_tables: Vec::new(),
                mcp_until: None,
                mcp_samples_off: false,
                mcp_access: None,
                masked_columns: Default::default(),
                id: id.into(),
                name: "pg cancel".into(),
                host: std::env::var("ROWKERY_PG_HOST").unwrap_or_else(|_| "127.0.0.1".into()),
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
            }),
            ConnectionSecrets {
                db_password: Some(
                    std::env::var("ROWKERY_PG_PASSWORD").unwrap_or_else(|_| "rowkery".into()),
                ),
                ssh_password: None,
                ssh_key_passphrase: None,
                gcp_key: None,
            },
        )
        .expect("save");
        bridge.open_window("w1", id, None).expect("open");
        let sleep = || {
            bridge
                .run_window_query("w1", 1, "SELECT pg_sleep(30)".into(), None, false)
                .expect("run")
        };

        // Cancel once the query is running on the server.
        let queue = sleep();
        thread::sleep(std::time::Duration::from_millis(1500));
        bridge.cancel_window_query("w1", 1);
        let (error, cancelled) =
            wait_query_finished(&queue, std::time::Duration::from_secs(5)).expect("finish");
        assert!(
            cancelled,
            "pg_sleep should report cancelled, error: {error:?}"
        );

        // Cancel before the query's session has finished opening.
        let queue = sleep();
        bridge.cancel_window_query("w1", 1);
        let (error, cancelled) =
            wait_query_finished(&queue, std::time::Duration::from_secs(5)).expect("finish");
        assert!(
            cancelled,
            "early cancel should not be lost, error: {error:?}"
        );
        std::env::remove_var("ROWKERY_CONFIG_DIR");
    }

    /// The SQL line's exact count runs on its own slot and returns the number.
    #[test]
    fn count_window_rows_counts_with_the_where() {
        let (_guard, _file, path) = test_guard();
        let bridge = super::CoreBridge::spawn();
        CoreBridge::upsert_connection(
            &bridge,
            ConnectionRecord::Sqlite(SqliteConnection {
                allow_mcp: false,
                mcp_hidden_tables: Vec::new(),
                mcp_until: None,
                mcp_samples_off: false,
                mcp_access: None,
                masked_columns: Default::default(),
                environment: None,
                safe_mode: Default::default(),
                id: "count".into(),
                name: "count".into(),
                path,
                sample: false,
            }),
            ConnectionSecrets::default(),
        )
        .expect("save");
        bridge.open_window("w", "count", None).expect("open");
        window_query(&bridge, "w", 1, "INSERT INTO t VALUES (2), (3)");
        let count = |filter| {
            bridge.count_window_rows(
                "w",
                rowkery_core::db::table_count_query(
                    rowkery_core::db::EngineKind::Sqlite,
                    "main",
                    "t",
                    filter,
                ),
            )
        };
        assert_eq!(count(None), Ok(Some(3)));
        assert_eq!(count(Some("id > 1")), Ok(Some(2)));
        assert!(count(Some("nope > 1")).is_err());
    }

    /// A column of a type the driver doesn't know (an enum here) used to
    /// deadlock tokio-postgres's one-shot `query_typed` once the result was
    /// bigger than its buffers: `SELECT *` never finished. Prepared first,
    /// every run ends, paged or not, after a schema change, and when two
    /// cursors with different columns follow each other.
    #[test]
    fn postgres_custom_types_and_schema_changes_never_hang() {
        let Ok(host) = std::env::var("ROWKERY_PG_HOST") else {
            eprintln!(
                "skip postgres_custom_types_and_schema_changes_never_hang (set ROWKERY_PG_HOST)"
            );
            return;
        };
        let (_guard, _file, _path) = test_guard();
        let bridge = super::CoreBridge::spawn();
        let id = "pg-types";
        CoreBridge::upsert_connection(
            &bridge,
            ConnectionRecord::Postgres(PostgresConnection {
                allow_mcp: false,
                mcp_hidden_tables: Vec::new(),
                mcp_until: None,
                mcp_samples_off: false,
                mcp_access: None,
                masked_columns: Default::default(),
                environment: None,
                safe_mode: Default::default(),
                id: id.into(),
                name: "pg types".into(),
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
            }),
            ConnectionSecrets {
                db_password: Some(
                    std::env::var("ROWKERY_PG_PASSWORD").unwrap_or_else(|_| "rowkery".into()),
                ),
                ..Default::default()
            },
        )
        .expect("save");
        bridge.open_window("w", id, None).expect("open");
        for sql in [
            "DROP TABLE IF EXISTS rowkery_types_t",
            "DROP TYPE IF EXISTS rowkery_mood",
            "CREATE TYPE rowkery_mood AS ENUM ('ok', 'sad')",
            "CREATE TABLE rowkery_types_t (id serial PRIMARY KEY, m rowkery_mood, iv interval, j jsonb, tz timestamptz, n numeric, a int[], note text)",
            "INSERT INTO rowkery_types_t (m, iv, j, tz, n, a, note) SELECT 'ok', '1 day', '{\"a\": 1}', now(), 1.5, ARRAY[1, 2], repeat('x', 200) FROM generate_series(1, 400)",
        ] {
            let (_, err, ..) = window_query(&bridge, "w", 9, sql);
            assert_eq!(err, None, "{sql}");
        }
        let run = |tab: u64, sql: &str, page: Option<u32>| {
            let queue: EventQueue = Arc::default();
            bridge
                .run_window_query_paged("w", tab, sql.into(), None, page, false, queue.clone())
                .expect("run");
            let Some((cancelled, error, _)) =
                wait_stopped(&queue, std::time::Duration::from_secs(10))
            else {
                let out = std::process::Command::new("psql")
                    .args(["-h", "127.0.0.1", "-p", "54329", "-U", "rowkery", "-d", "rowkery", "-Atc",
                        "select state, wait_event, left(query, 120) from pg_stat_activity where datname = 'rowkery' and pid <> pg_backend_pid()"])
                    .output()
                    .map(|o| String::from_utf8_lossy(&o.stdout).to_string())
                    .unwrap_or_default();
                panic!("tab {tab} {page:?} {sql}: never ended\n{out}");
            };
            assert!(!cancelled);
            error
        };
        // Fresh sessions (new tabs): whole, then paged through a cursor.
        assert_eq!(run(1, "SELECT * FROM rowkery_types_t;", None), None);
        assert_eq!(run(2, "SELECT * FROM rowkery_types_t;", Some(100)), None);
        // Another cursor with other columns on the same session.
        assert_eq!(
            run(2, "SELECT id, m FROM rowkery_types_t;", Some(100)),
            None
        );
        // Tab 2's cursor still has rows (its transaction holds a lock the
        // ALTER would wait on); closing the tab ends it, as in the app.
        bridge.close_window_tab("w", 2);
        // The schema changes under a prepared statement: prepared again.
        assert_eq!(
            run(9, "ALTER TABLE rowkery_types_t ADD COLUMN extra int;", None),
            None
        );
        assert_eq!(run(1, "SELECT * FROM rowkery_types_t;", None), None);
        window_query(&bridge, "w", 9, "DROP TABLE rowkery_types_t");
        window_query(&bridge, "w", 9, "DROP TYPE rowkery_mood");
        std::env::remove_var("ROWKERY_CONFIG_DIR");
    }

    /// A TCP proxy to Postgres that can freeze: sockets stay open but nothing
    /// passes either way, like a laptop waking on another network or an SSH
    /// tunnel whose server went away. Returns its port and the switch.
    fn freezing_proxy(upstream: String) -> (u16, Arc<std::sync::atomic::AtomicBool>) {
        use std::io::{Read, Write};
        use std::net::{TcpListener, TcpStream};
        use std::sync::atomic::AtomicBool;
        let frozen = Arc::new(AtomicBool::new(false));
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        let pump = |mut from: TcpStream, mut to: TcpStream, frozen: Arc<AtomicBool>| {
            thread::spawn(move || {
                from.set_read_timeout(Some(std::time::Duration::from_millis(50)))
                    .ok();
                let mut buf = [0u8; 16384];
                loop {
                    if frozen.load(Ordering::SeqCst) {
                        thread::sleep(std::time::Duration::from_millis(50));
                        continue;
                    }
                    match from.read(&mut buf) {
                        Ok(0) => return,
                        // Read as the freeze began: lost, like on a dead link.
                        Ok(_) if frozen.load(Ordering::SeqCst) => {}
                        Ok(n) => {
                            if to.write_all(&buf[..n]).is_err() {
                                return;
                            }
                        }
                        Err(e)
                            if e.kind() == std::io::ErrorKind::WouldBlock
                                || e.kind() == std::io::ErrorKind::TimedOut => {}
                        Err(_) => return,
                    }
                }
            });
        };
        let accept_frozen = frozen.clone();
        thread::spawn(move || {
            for client in listener.incoming().flatten() {
                let Ok(server) = TcpStream::connect(&upstream) else {
                    continue;
                };
                pump(
                    client.try_clone().unwrap(),
                    server.try_clone().unwrap(),
                    accept_frozen.clone(),
                );
                pump(server, client, accept_frozen.clone());
            }
        });
        (port, frozen)
    }

    /// Waits for the run's QueryFinished; returns (cancelled, error, waited).
    fn wait_stopped(
        queue: &EventQueue,
        limit: std::time::Duration,
    ) -> Option<(bool, Option<String>, std::time::Duration)> {
        let start = std::time::Instant::now();
        while start.elapsed() < limit {
            for event in std::mem::take(&mut *queue.lock().unwrap()) {
                if let CoreEvent::QueryFinished {
                    cancelled, error, ..
                } = event
                {
                    return Some((cancelled, error, start.elapsed()));
                }
            }
            thread::sleep(std::time::Duration::from_millis(10));
        }
        None
    }

    /// A query sent into a dead connection never answers, and neither does a
    /// cancel: the run is stopped anyway, a few seconds after Cancel (or at
    /// once with Stop all), and the tab works again once the network does.
    #[test]
    fn postgres_cancel_stops_a_run_on_a_dead_connection() {
        let Ok(host) = std::env::var("ROWKERY_PG_HOST") else {
            eprintln!(
                "skip postgres_cancel_stops_a_run_on_a_dead_connection (set ROWKERY_PG_HOST)"
            );
            return;
        };
        let (_guard, _file, _path) = test_guard();
        let pg_port: u16 = std::env::var("ROWKERY_PG_PORT")
            .ok()
            .and_then(|p| p.parse().ok())
            .unwrap_or(54329);
        let (port, frozen) = freezing_proxy(format!("{host}:{pg_port}"));
        let bridge = super::CoreBridge::spawn();
        let id = "pg-dead-link";
        CoreBridge::upsert_connection(
            &bridge,
            ConnectionRecord::Postgres(PostgresConnection {
                allow_mcp: false,
                mcp_hidden_tables: Vec::new(),
                mcp_until: None,
                mcp_samples_off: false,
                mcp_access: None,
                masked_columns: Default::default(),
                environment: None,
                safe_mode: Default::default(),
                id: id.into(),
                name: "pg dead link".into(),
                host: "127.0.0.1".into(),
                port,
                database: std::env::var("ROWKERY_PG_DB").unwrap_or_else(|_| "rowkery".into()),
                username: std::env::var("ROWKERY_PG_USER").unwrap_or_else(|_| "rowkery".into()),
                ssl_mode: PostgresSslMode::Disable,
                ssl_root_cert: None,
                ssh: None,
                cloud_sql: None,
            }),
            ConnectionSecrets {
                db_password: Some(
                    std::env::var("ROWKERY_PG_PASSWORD").unwrap_or_else(|_| "rowkery".into()),
                ),
                ..Default::default()
            },
        )
        .expect("save");
        bridge.open_window("w", id, None).expect("open");
        // A warm session in tab 1, then the network goes.
        assert_eq!(window_query(&bridge, "w", 1, "SELECT 1").1, None);
        frozen.store(true, Ordering::SeqCst);

        // Cancel: the server can't hear it; the run stops ~3 s later.
        let queue = bridge
            .run_window_query(
                "w",
                1,
                "SELECT * FROM generate_series(1, 10)".into(),
                None,
                false,
            )
            .expect("run");
        thread::sleep(std::time::Duration::from_millis(500));
        let early = wait_stopped(&queue, std::time::Duration::from_millis(10));
        assert!(early.is_none(), "hangs, but got {early:?}");
        bridge.cancel_window_query("w", 1);
        let (cancelled, _, waited) =
            wait_stopped(&queue, std::time::Duration::from_secs(8)).expect("stopped");
        assert!(cancelled);
        assert!(
            waited >= std::time::Duration::from_secs(2),
            "the cancel got its chance first"
        );

        // Cancel twice: stopped at once.
        let queue = bridge
            .run_window_query("w", 1, "SELECT 2".into(), None, false)
            .expect("run");
        thread::sleep(std::time::Duration::from_millis(300));
        bridge.cancel_window_query("w", 1);
        bridge.cancel_window_query("w", 1);
        let (cancelled, _, waited) =
            wait_stopped(&queue, std::time::Duration::from_secs(2)).expect("stopped");
        assert!(cancelled && waited < std::time::Duration::from_secs(1));

        // Stop all: every tab, at once.
        let q2 = bridge
            .run_window_query("w", 2, "SELECT 3".into(), None, false)
            .expect("run");
        let q3 = bridge
            .run_window_query("w", 3, "SELECT 4".into(), None, false)
            .expect("run");
        thread::sleep(std::time::Duration::from_millis(300));
        bridge.stop_all_queries();
        for q in [&q2, &q3] {
            let (cancelled, _, waited) =
                wait_stopped(q, std::time::Duration::from_secs(2)).expect("stopped");
            assert!(cancelled && waited < std::time::Duration::from_secs(1));
        }

        // The network is back: the tab runs on a fresh session.
        frozen.store(false, Ordering::SeqCst);
        assert_eq!(
            window_query(&bridge, "w", 1, "SELECT 5").0,
            Some(rowkery_core::db::Value::Int(5))
        );
        std::env::remove_var("ROWKERY_CONFIG_DIR");
    }

    /// Runs `sql` in a window tab; returns the first cell, error, cancelled
    /// and elapsed ms.
    fn window_query(
        bridge: &super::CoreBridge,
        window_id: &str,
        tab_id: u64,
        sql: &str,
    ) -> (
        Option<rowkery_core::db::Value>,
        Option<String>,
        bool,
        u64,
        Option<u64>,
    ) {
        let queue = bridge
            .run_window_query(window_id, tab_id, sql.into(), None, false)
            .expect("run");
        let mut cell = None;
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(10);
        while std::time::Instant::now() < deadline {
            let drained: Vec<CoreEvent> = std::mem::take(&mut *queue.lock().unwrap());
            for event in drained {
                match event {
                    CoreEvent::QueryBatch { batch, .. } => {
                        cell = batch.rows.first().and_then(|r| r.first()).cloned();
                    }
                    CoreEvent::QueryFinished {
                        error,
                        cancelled,
                        elapsed_ms,
                        rows_affected,
                        ..
                    } => return (cell, error, cancelled, elapsed_ms, rows_affected),
                    _ => {}
                }
            }
            thread::sleep(std::time::Duration::from_millis(5));
        }
        panic!("query did not finish: {sql}");
    }

    #[test]
    fn postgres_safe_mode_change_recycles_warm_sessions() {
        if std::env::var("ROWKERY_PG_HOST").is_err() {
            eprintln!(
                "skip postgres_safe_mode_change_recycles_warm_sessions (set ROWKERY_PG_HOST)"
            );
            return;
        }
        let (_guard, _file, _path) = test_guard();
        let bridge = super::CoreBridge::spawn();
        let id = "postgres-safe";
        let save = |safe_mode: SafeMode| {
            CoreBridge::upsert_connection(
                &bridge,
                ConnectionRecord::Postgres(PostgresConnection {
                    environment: None,
                    safe_mode,
                    allow_mcp: false,
                    mcp_hidden_tables: Vec::new(),
                    mcp_until: None,
                    mcp_samples_off: false,
                    mcp_access: None,
                    masked_columns: Default::default(),
                    id: id.into(),
                    name: "pg safe".into(),
                    host: std::env::var("ROWKERY_PG_HOST").unwrap(),
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
                }),
                ConnectionSecrets {
                    db_password: Some(
                        std::env::var("ROWKERY_PG_PASSWORD").unwrap_or_else(|_| "rowkery".into()),
                    ),
                    ..Default::default()
                },
            )
            .expect("save");
        };
        save(SafeMode::Off);
        bridge.open_window("w", id, None).expect("open");
        let read_only = || window_query(&bridge, "w", 1, "SHOW default_transaction_read_only").0;
        let text = |v: &str| Some(rowkery_core::db::Value::Text(v.into()));
        assert_eq!(read_only(), text("off"));

        // The tab's warm session was opened read-write: switching to
        // Read-only gives it a fresh, read-only one.
        save(SafeMode::ReadOnly);
        assert_eq!(read_only(), text("on"));
        let queue = bridge
            .run_window_query("w", 1, "CREATE TEMP TABLE t (n int)".into(), None, true)
            .expect("run");
        assert!(held(&queue).is_some(), "refused before it ran");

        // And back: Off drops the read-only session.
        save(SafeMode::Off);
        assert_eq!(read_only(), text("off"));
        assert_eq!(
            window_query(&bridge, "w", 1, "CREATE TEMP TABLE t (n int)").1,
            None
        );
        std::env::remove_var("ROWKERY_CONFIG_DIR");
    }

    /// A run sends a tab at most its cap: the batch that crosses it is cut,
    /// later ones are dropped (still read), and the outcome says `capped`.
    #[test]
    fn forward_stops_at_the_cap() {
        let queue: EventQueue = Arc::default();
        let sink: SharedSink = queue.clone();
        let batch = |n: i64| RowBatch {
            columns: vec![rowkery_core::db::Column {
                name: "n".into(),
                type_name: String::new(),
            }],
            rows: (0..n)
                .map(|i| vec![rowkery_core::db::Value::Int(i)])
                .collect(),
        };
        let mut fwd = Forward::new(&sink, 1, 1, Some(5));
        fwd.batch(batch(3), true);
        fwd.batch(batch(3), false);
        fwd.batch(batch(3), false);
        let outcome = fwd.outcome(Ok(StreamStats::default())).expect("ok");
        assert_eq!((outcome.row_count, outcome.capped), (5, true));
        let sent: Vec<usize> = queue
            .lock()
            .unwrap()
            .iter()
            .filter_map(|e| match e {
                CoreEvent::QueryBatch { batch, .. } => Some(batch.rows.len()),
                _ => None,
            })
            .collect();
        assert_eq!(sent, [3, 2]);

        // Under the cap, or with none (an export): every row, not capped.
        let mut fwd = Forward::new(&sink, 2, 1, Some(9));
        fwd.batch(batch(9), true);
        let outcome = fwd.outcome(Ok(StreamStats::default())).expect("ok");
        assert_eq!((outcome.row_count, outcome.capped), (9, false));
        let mut fwd = Forward::new(&sink, 3, 1, None);
        fwd.batch(batch(9), true);
        fwd.batch(batch(9), false);
        assert_eq!(
            fwd.outcome(Ok(StreamStats::default())).unwrap().row_count,
            18
        );
    }

    /// A SQLite query tab pages a free-form read like a Postgres cursor:
    /// the first page, then the rest on demand. Writes, reads with their own
    /// LIMIT and table browses run whole; a new run ends the page.
    #[test]
    fn sqlite_query_tabs_page() {
        let (_guard, _file, path) = test_guard();
        {
            let conn = Connection::open(&path).expect("open");
            conn.execute_batch(
                "WITH RECURSIVE n(i) AS (SELECT 2 UNION ALL SELECT i + 1 FROM n WHERE i < 2500) \
                 INSERT INTO t SELECT i FROM n",
            )
            .expect("fill");
        }
        let bridge = super::CoreBridge::spawn();
        connect_sqlite(&bridge, path);
        let paged = |tab: u64, sql: &str, page: u32| {
            let queue: EventQueue = Arc::default();
            bridge
                .run_window_query_paged(
                    "w1",
                    tab,
                    sql.into(),
                    None,
                    Some(page),
                    false,
                    queue.clone(),
                )
                .expect("run");
            drain_paged(&queue)
        };
        let more = |tab: u64, rows: u32| {
            let queue: EventQueue = Arc::default();
            bridge
                .fetch_more_to("w1", tab, rows, queue.clone())
                .expect("fetch");
            drain_paged(&queue)
        };
        let int = |n: i64| Some(rowkery_core::db::Value::Int(n));
        let sql = "SELECT id FROM t ORDER BY id";
        assert_eq!(paged(1, sql, 1000), (1000, int(1), None, true, true));
        assert_eq!(more(1, 1000), (1000, int(1001), None, true, true));
        assert_eq!(more(1, 1000), (500, int(2001), None, true, false));
        let (_, _, error, _, more_left) = more(1, 1000);
        assert!(error.is_some() && !more_left, "nothing left after the end");
        // The rest at once.
        assert!(paged(1, sql, 1000).4);
        assert_eq!(more(1, 0), (1500, int(1001), None, true, false));
        // Its own LIMIT: whole, not paged.
        assert_eq!(
            paged(1, &format!("{sql} LIMIT 3"), 1000),
            (3, int(1), None, false, false)
        );
        // A new run on the tab ends its page; another tab's stays.
        assert!(paged(1, sql, 1000).4);
        assert!(paged(2, sql, 1000).4);
        assert_eq!(paged(1, "SELECT 7", 1000), (1, int(7), None, true, false));
        assert!(more(1, 1000).2.is_some(), "the old page is gone");
        assert_eq!(more(2, 1000), (1000, int(1001), None, true, true));
        // A write runs once, whole, and is never paged.
        let (_, _, error, was_paged, _) = paged(
            3,
            "WITH x AS (SELECT 1) DELETE FROM t WHERE id > 2400 RETURNING id",
            10,
        );
        assert_eq!((error, was_paged), (None, false));
        assert_eq!(paged(3, "SELECT count(*) FROM t", 10).1, int(2400));
    }

    /// What a paged run or `fetch_more` streamed: rows, first cell, error,
    /// and the done event's `paged` / `more`.
    fn drain_paged(
        queue: &EventQueue,
    ) -> (
        u64,
        Option<rowkery_core::db::Value>,
        Option<String>,
        bool,
        bool,
    ) {
        let mut cell = None;
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(10);
        while std::time::Instant::now() < deadline {
            let drained: Vec<CoreEvent> = std::mem::take(&mut *queue.lock().unwrap());
            for event in drained {
                match event {
                    CoreEvent::QueryBatch { batch, .. } if cell.is_none() => {
                        cell = batch.rows.first().and_then(|r| r.first()).cloned();
                    }
                    CoreEvent::QueryFinished {
                        row_count,
                        error,
                        detail,
                        ..
                    } => return (row_count, cell, error, detail.paged, detail.more),
                    _ => {}
                }
            }
            thread::sleep(std::time::Duration::from_millis(5));
        }
        panic!("paged run did not finish");
    }

    /// Query tabs page free-form reads through a cursor: pages until the
    /// end, `nextval()` still commits, an open user transaction is left as
    /// it was, statements that can't be cursors run as written, and a
    /// failed page leaves the tab usable.
    #[test]
    fn postgres_query_tabs_page_through_a_cursor() {
        if std::env::var("ROWKERY_PG_HOST").is_err() {
            eprintln!("skip postgres_query_tabs_page_through_a_cursor (set ROWKERY_PG_HOST)");
            return;
        }
        let (_guard, _file, _path) = test_guard();
        let bridge = super::CoreBridge::spawn();
        let id = "postgres-paged";
        CoreBridge::upsert_connection(
            &bridge,
            ConnectionRecord::Postgres(PostgresConnection {
                allow_mcp: false,
                mcp_hidden_tables: Vec::new(),
                mcp_until: None,
                mcp_samples_off: false,
                mcp_access: None,
                masked_columns: Default::default(),
                environment: None,
                safe_mode: SafeMode::Off,
                id: id.into(),
                name: "pg paged".into(),
                host: std::env::var("ROWKERY_PG_HOST").unwrap(),
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
            }),
            ConnectionSecrets {
                db_password: Some(
                    std::env::var("ROWKERY_PG_PASSWORD").unwrap_or_else(|_| "rowkery".into()),
                ),
                ..Default::default()
            },
        )
        .expect("save");
        bridge.open_window("w", id, None).expect("open");
        let paged = |tab: u64, sql: &str, page: u32| {
            let queue: EventQueue = Arc::default();
            bridge
                .run_window_query_paged(
                    "w",
                    tab,
                    sql.into(),
                    None,
                    Some(page),
                    false,
                    queue.clone(),
                )
                .expect("run");
            drain_paged(&queue)
        };
        let more = |tab: u64, rows: u32| {
            let queue: EventQueue = Arc::default();
            bridge
                .fetch_more_to("w", tab, rows, queue.clone())
                .expect("fetch");
            drain_paged(&queue)
        };
        let int = |n: i64| Some(rowkery_core::db::Value::Int(n));
        let plain = |tab: u64, sql: &str| window_query(&bridge, "w", tab, sql);
        assert_eq!(plain(9, "DROP TABLE IF EXISTS paged_t").1, None);
        assert_eq!(plain(9, "CREATE TABLE paged_t (n int)").1, None);
        assert_eq!(plain(9, "DROP SEQUENCE IF EXISTS paged_seq").1, None);
        assert_eq!(plain(9, "CREATE SEQUENCE paged_seq").1, None);

        // 2,500 rows, 1,000 at a time.
        let sql = "SELECT g::int8 FROM generate_series(1, 2500) g";
        assert_eq!(paged(1, sql, 1000), (1000, int(1), None, true, true));
        assert_eq!(more(1, 1000), (1000, int(1001), None, true, true));
        assert_eq!(more(1, 1000), (500, int(2001), None, true, false));
        let (_, _, error, _, more_left) = more(1, 1000);
        assert!(
            error.is_some() && !more_left,
            "the cursor closed at the end"
        );
        // All at once.
        assert_eq!(paged(1, sql, 0), (2500, int(1), None, true, false));
        // Bounded by its own LIMIT: not paged.
        let queue: EventQueue = Arc::default();
        bridge
            .run_window_query_paged(
                "w",
                1,
                format!("{sql} LIMIT 3"),
                None,
                Some(1000),
                false,
                queue.clone(),
            )
            .expect("run");
        assert_eq!(drain_paged(&queue), (3, int(1), None, false, false));

        // An export runs the whole statement inside the tab's open cursor
        // transaction and leaves the cursor where it was.
        assert!(paged(1, sql, 1000).4);
        let queue: EventQueue = Arc::default();
        bridge
            .run_window_export_to("w", 1, sql.into(), queue.clone())
            .expect("export");
        assert_eq!(drain_paged(&queue), (2500, int(1), None, false, false));
        assert_eq!(more(1, 1000), (1000, int(1001), None, true, true));
        assert!(bridge
            .run_window_export_to("w", 1, "DELETE FROM paged_t".into(), queue.clone())
            .is_err());

        // nextval() commits with the cursor's transaction.
        let (n, _, error, _, _) = paged(
            2,
            "SELECT nextval('paged_seq') FROM generate_series(1, 5)",
            1000,
        );
        assert_eq!((n, error), (5, None));
        assert_eq!(plain(9, "SELECT last_value FROM paged_seq").0, int(5));

        // A write after an open page runs on its own, not inside our transaction.
        assert!(paged(2, sql, 1000).4);
        assert_eq!(plain(2, "INSERT INTO paged_t VALUES (1)").1, None);
        assert_eq!(plain(9, "SELECT count(*) FROM paged_t").0, int(1));

        // Inside the user's transaction the cursor is declared in it: it
        // pages, sees the transaction's own rows, and closing it neither
        // commits nor rolls back their transaction.
        assert_eq!(plain(3, "BEGIN").1, None);
        assert_eq!(plain(3, "INSERT INTO paged_t VALUES (2)").1, None);
        assert_eq!(paged(3, sql, 1000), (1000, int(1), None, true, true));
        assert_eq!(more(3, 1000), (1000, int(1001), None, true, true));
        assert_eq!(
            paged(3, "SELECT count(*)::int8 FROM paged_t", 1000),
            (1, int(2), None, true, false)
        );
        assert_eq!(plain(3, "SELECT count(*) FROM paged_t").0, int(2));
        assert_eq!(plain(3, "ROLLBACK").1, None);
        assert_eq!(plain(9, "SELECT count(*) FROM paged_t").0, int(1));
        // Once it ends, the tab pages in its own transaction again.
        assert_eq!(paged(3, sql, 1000), (1000, int(1), None, true, true));
        // A transaction opened on a session that just paged is seen too,
        // and stays the user's: their ROLLBACK still undoes their insert.
        assert_eq!(plain(3, "BEGIN").1, None);
        assert_eq!(paged(3, sql, 1000), (1000, int(1), None, true, true));
        assert_eq!(plain(3, "INSERT INTO paged_t VALUES (5)").1, None);
        assert_eq!(paged(3, sql, 1000), (1000, int(1), None, true, true));
        assert_eq!(plain(3, "ROLLBACK").1, None);
        assert_eq!(plain(9, "SELECT count(*) FROM paged_t").0, int(1));
        // A locking read in their transaction runs whole: a cursor would
        // lock only the rows fetched so far.
        assert_eq!(plain(3, "BEGIN").1, None);
        assert_eq!(
            paged(3, "SELECT n::int8 FROM paged_t FOR UPDATE", 1000),
            (1, int(1), None, false, false)
        );
        assert_eq!(plain(3, "COMMIT").1, None);

        // Can't be a cursor (data-modifying WITH): runs as written.
        let (n, _, error, was_paged, _) = paged(
            4,
            "WITH d AS (DELETE FROM paged_t WHERE n = 1 RETURNING n) SELECT n FROM d",
            1000,
        );
        assert_eq!((n, error, was_paged), (1, None, false));
        assert_eq!(plain(9, "SELECT count(*) FROM paged_t").0, int(0));

        // The same inside the user's transaction keeps that transaction usable.
        assert_eq!(plain(4, "BEGIN").1, None);
        assert_eq!(plain(4, "INSERT INTO paged_t VALUES (3)").1, None);
        let (_, _, error, was_paged, _) = paged(
            4,
            "WITH d AS (DELETE FROM paged_t WHERE n = 3 RETURNING n) SELECT n FROM d",
            1000,
        );
        assert_eq!((error, was_paged), (None, false));
        assert_eq!(plain(4, "COMMIT").1, None);

        // A failed transaction stays the user's to roll back.
        assert_eq!(plain(5, "BEGIN").1, None);
        assert!(plain(5, "SELECT 1/0").1.is_some());
        assert!(paged(5, sql, 1000).2.is_some());
        assert_eq!(plain(5, "ROLLBACK").1, None);
        assert_eq!(plain(5, "SELECT 7::int8").0, int(7));

        // A page that fails (division by zero at row 1,500) ends the cursor;
        // the tab runs the next query normally.
        let failing = "SELECT (1 / (g - 1500))::int8 FROM generate_series(1, 3000) g";
        assert!(paged(6, failing, 1000).4);
        let (_, _, error, _, more_left) = more(6, 1000);
        assert!(error.is_some_and(|e| e.contains("division")) && !more_left);
        assert_eq!(plain(6, "SELECT 8::int8").0, int(8));
        assert_eq!(plain(6, "INSERT INTO paged_t VALUES (4)").1, None);
        assert_eq!(
            plain(9, "SELECT count(*) FROM paged_t WHERE n = 4").0,
            int(1)
        );

        assert_eq!(plain(9, "DROP TABLE paged_t").1, None);
        assert_eq!(plain(9, "DROP SEQUENCE paged_seq").1, None);
        std::env::remove_var("ROWKERY_CONFIG_DIR");
    }

    /// Saves the test Postgres as connection `id`, or `None` without ROWKERY_PG_HOST.
    fn save_test_pg(bridge: &super::CoreBridge, id: &str) -> Option<()> {
        let host = std::env::var("ROWKERY_PG_HOST").ok()?;
        CoreBridge::upsert_connection(
            bridge,
            ConnectionRecord::Postgres(PostgresConnection {
                allow_mcp: false,
                mcp_hidden_tables: Vec::new(),
                mcp_until: None,
                mcp_samples_off: false,
                mcp_access: None,
                masked_columns: Default::default(),
                environment: None,
                safe_mode: Default::default(),
                id: id.into(),
                name: id.into(),
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
            }),
            ConnectionSecrets {
                db_password: Some(
                    std::env::var("ROWKERY_PG_PASSWORD").unwrap_or_else(|_| "rowkery".into()),
                ),
                ..Default::default()
            },
        )
        .expect("save");
        Some(())
    }

    /// Every row a window query returns, and whether it failed.
    fn window_rows(
        bridge: &super::CoreBridge,
        window_id: &str,
        tab_id: u64,
        sql: &str,
    ) -> (Vec<Vec<Value>>, Option<String>) {
        let queue = bridge
            .run_window_query(window_id, tab_id, sql.into(), None, false)
            .expect("run");
        let mut rows = Vec::new();
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(10);
        while std::time::Instant::now() < deadline {
            for event in std::mem::take(&mut *queue.lock().unwrap()) {
                match event {
                    CoreEvent::QueryBatch { batch, .. } => rows.extend(batch.rows),
                    CoreEvent::QueryFinished { error, .. } => return (rows, error),
                    _ => {}
                }
            }
            thread::sleep(std::time::Duration::from_millis(5));
        }
        panic!("query did not finish: {sql}");
    }

    fn prefetch_sessions(bridge: &super::CoreBridge, window_id: &str) -> i64 {
        let (n, ..) = window_query(
            bridge,
            window_id,
            99,
            &format!(
                "SELECT count(*)::int FROM pg_stat_activity WHERE datname = current_database() AND application_name = '{}'",
                super::PREFETCH_APPLICATION_NAME
            ),
        );
        match n {
            Some(Value::Int(n)) => n,
            other => panic!("count: {other:?}"),
        }
    }

    /// Hover prefetch reads the first 200 rows through a cursor; the click
    /// on the same browse shows them and FETCHes the rest of that cursor (so
    /// a row changed in between still reads as it was when the prefetch
    /// declared it), on one prefetch session.
    #[test]
    fn postgres_prefetch_is_the_first_fetch_the_click_continues() {
        let (_guard, _file, _path) = test_guard();
        let bridge = super::CoreBridge::spawn();
        if save_test_pg(&bridge, "pg-prefetch").is_none() {
            eprintln!(
                "skip postgres_prefetch_is_the_first_fetch_the_click_continues (set ROWKERY_PG_HOST)"
            );
            return;
        }
        bridge.open_window("w", "pg-prefetch", None).expect("open");
        bridge
            .open_window("other", "pg-prefetch", None)
            .expect("open other");
        window_query(&bridge, "w", 1, "DROP TABLE IF EXISTS pf_items");
        window_query(
            &bridge,
            "w",
            1,
            "CREATE TABLE pf_items (id int PRIMARY KEY, n text)",
        );
        window_query(
            &bridge,
            "w",
            1,
            "INSERT INTO pf_items SELECT i, 'n' || i FROM generate_series(1, 1500) i",
        );
        let sql = "SELECT * FROM public.pf_items ORDER BY id LIMIT 1000";
        let before = prefetch_sessions(&bridge, "w");
        assert_eq!(bridge.prefetch_table("w", sql.into()), Ok(true));
        assert!(bridge.prefetched("w", sql));
        assert_eq!(
            prefetch_sessions(&bridge, "w"),
            before + 1,
            "one prefetch session"
        );

        // Another window writes (it can't see this window's cache).
        window_query(
            &bridge,
            "other",
            1,
            "UPDATE pf_items SET n = 'changed' WHERE id IN (5, 900)",
        );
        let (rows, error) = window_rows(&bridge, "w", 2, sql);
        assert_eq!(error, None);
        assert_eq!(
            rows.len(),
            1000,
            "the cached 200 and the cursor's other 800"
        );
        let ids: Vec<i64> = rows
            .iter()
            .map(|r| match &r[0] {
                Value::Int(n) => *n,
                other => panic!("id: {other:?}"),
            })
            .collect();
        assert_eq!(ids, (1..=1000).collect::<Vec<_>>());
        assert_eq!(
            rows[4][1],
            Value::Text("n5".into()),
            "row 5 from the cached page"
        );
        assert_eq!(
            rows[899][1],
            Value::Text("n900".into()),
            "row 900 from the same cursor, not a second query"
        );
        assert!(!bridge.prefetched("w", sql), "a page serves one click");
        // The next click runs it afresh.
        let (rows, _) = window_rows(&bridge, "w", 2, sql);
        assert_eq!(rows[899][1], Value::Text("changed".into()));
        window_query(&bridge, "w", 1, "DROP TABLE pf_items");
        bridge.close_window("w");
        bridge.close_window("other");
        std::env::remove_var("ROWKERY_CONFIG_DIR");
    }

    /// Eight pages at most (the oldest cursor closes), one prefetch in flight
    /// that the pointer leaving cancels without losing the other cursors, a
    /// write in the window drops them all, and safe mode's Read-only still
    /// lets a browse be prefetched.
    #[test]
    fn postgres_prefetch_lru_cancel_and_writes() {
        let (_guard, _file, _path) = test_guard();
        let bridge = Arc::new(super::CoreBridge::spawn());
        if save_test_pg(&bridge, "pg-prefetch-lru").is_none() {
            eprintln!("skip postgres_prefetch_lru_cancel_and_writes (set ROWKERY_PG_HOST)");
            return;
        }
        bridge
            .open_window("w", "pg-prefetch-lru", None)
            .expect("open");
        window_query(&bridge, "w", 1, "DROP TABLE IF EXISTS pf_lru");
        window_query(&bridge, "w", 1, "CREATE TABLE pf_lru (id int PRIMARY KEY)");
        window_query(
            &bridge,
            "w",
            1,
            "INSERT INTO pf_lru SELECT generate_series(1, 600)",
        );
        let before = prefetch_sessions(&bridge, "w");
        let page = |from: usize| {
            format!("SELECT * FROM public.pf_lru WHERE id > {from} ORDER BY id LIMIT 300")
        };
        for i in 0..=super::PREFETCH_MAX_ENTRIES {
            assert_eq!(bridge.prefetch_table("w", page(i)), Ok(true));
        }
        assert!(!bridge.prefetched("w", &page(0)), "the oldest went");
        for i in 1..=super::PREFETCH_MAX_ENTRIES {
            assert!(bridge.prefetched("w", &page(i)), "page {i} kept");
        }
        assert_eq!(
            prefetch_sessions(&bridge, "w"),
            before + 1,
            "one prefetch session for nine"
        );

        // The pointer leaves while a slow one runs: cancelled on the server.
        let slow = "SELECT pg_sleep(5) AS s, id FROM public.pf_lru LIMIT 1".to_string();
        let started = std::time::Instant::now();
        let waiting = {
            let bridge = bridge.clone();
            thread::spawn(move || bridge.prefetch_table("w", slow))
        };
        thread::sleep(std::time::Duration::from_millis(400));
        bridge.cancel_prefetch("w");
        assert_eq!(waiting.join().unwrap(), Ok(false));
        assert!(
            started.elapsed() >= std::time::Duration::from_millis(400),
            "it was running"
        );
        assert!(
            started.elapsed() < std::time::Duration::from_secs(3),
            "cancelled, not finished"
        );

        // The other cursors survived: a click still continues one.
        let (rows, error) = window_rows(&bridge, "w", 2, &page(3));
        assert_eq!(error, None);
        assert_eq!(rows.len(), 300);
        assert_eq!(rows[299][0], Value::Int(303));

        // A write in this window: nothing cached is served again.
        assert!(bridge.prefetched("w", &page(4)));
        window_query(&bridge, "w", 1, "UPDATE pf_lru SET id = id WHERE id = 1");
        assert!(!bridge.prefetched("w", &page(4)));
        // And the next prefetch starts clean.
        assert_eq!(bridge.prefetch_table("w", page(4)), Ok(true));
        let (rows, _) = window_rows(&bridge, "w", 2, &page(4));
        assert_eq!(rows.len(), 300);

        // A write is never prefetched.
        assert_eq!(
            bridge.prefetch_table("w", "DELETE FROM pf_lru".into()),
            Ok(false)
        );
        window_query(&bridge, "w", 1, "DROP TABLE pf_lru");
        bridge.close_window("w");
        std::env::remove_var("ROWKERY_CONFIG_DIR");
    }

    /// Quick Look follows three keys on one session of its own, never a tab's,
    /// and later lookups reuse it.
    #[test]
    fn postgres_follow_keys_use_one_quick_look_session() {
        if std::env::var("ROWKERY_PG_HOST").is_err() {
            eprintln!("skip postgres_follow_keys_use_one_quick_look_session (set ROWKERY_PG_HOST)");
            return;
        }
        let (_guard, _file, _path) = test_guard();
        let bridge = super::CoreBridge::spawn();
        let id = "postgres-follow";
        CoreBridge::upsert_connection(
            &bridge,
            ConnectionRecord::Postgres(PostgresConnection {
                allow_mcp: false,
                mcp_hidden_tables: Vec::new(),
                mcp_until: None,
                mcp_samples_off: false,
                mcp_access: None,
                masked_columns: Default::default(),
                environment: None,
                safe_mode: Default::default(),
                id: id.into(),
                name: "pg follow".into(),
                host: std::env::var("ROWKERY_PG_HOST").unwrap(),
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
            }),
            ConnectionSecrets {
                db_password: Some(
                    std::env::var("ROWKERY_PG_PASSWORD").unwrap_or_else(|_| "rowkery".into()),
                ),
                ..Default::default()
            },
        )
        .expect("save");
        bridge.open_window("w", id, None).expect("open");
        // Tab 1 holds an open transaction the lookups must not join.
        window_query(
            &bridge,
            "w",
            1,
            "CREATE TABLE IF NOT EXISTS follow_parent (id int PRIMARY KEY, name text)",
        );
        window_query(&bridge, "w", 1, "INSERT INTO follow_parent VALUES (1, 'one'), (2, 'two'), (3, 'three') ON CONFLICT DO NOTHING");
        window_query(&bridge, "w", 1, "BEGIN");
        let backends = |bridge: &super::CoreBridge| {
            let (n, ..) = window_query(
                bridge,
                "w",
                1,
                "SELECT count(*)::int FROM pg_stat_activity WHERE datname = current_database() AND backend_type = 'client backend'",
            );
            match n {
                Some(Value::Int(n)) => n,
                other => panic!("count: {other:?}"),
            }
        };
        let before = backends(&bridge);
        let look = |value: i64| FollowLookup {
            schema: "public".into(),
            table: "follow_parent".into(),
            column: "id".into(),
            value: Value::Int(value),
        };
        let rows = bridge
            .follow_keys("w", vec![look(1), look(2), look(3)])
            .expect("follow");
        let names: Vec<Value> = rows
            .iter()
            .map(|r| r.as_ref().unwrap().row[1].clone())
            .collect();
        assert_eq!(
            names,
            [
                Value::Text("one".into()),
                Value::Text("two".into()),
                Value::Text("three".into())
            ]
        );
        let after = backends(&bridge);
        assert!(
            after <= before + 1,
            "three lookups opened {} sessions",
            after - before
        );
        bridge.follow_keys("w", vec![look(2)]).expect("again");
        assert_eq!(backends(&bridge), after, "the Quick Look session is reused");
        // Incoming counts run on that same session too.
        let counts = bridge
            .count_incoming("w", vec![look(2), look(9)])
            .expect("count");
        assert_eq!(counts, [Some(1), Some(0)]);
        assert_eq!(
            backends(&bridge),
            after,
            "Incoming reuses the Quick Look session"
        );
        window_query(&bridge, "w", 1, "ROLLBACK");
        std::env::remove_var("ROWKERY_CONFIG_DIR");
    }

    /// The Sessions tab sees a lock chain, labels our own tab, and stops a
    /// session through safe mode.
    #[test]
    fn postgres_sessions_show_a_lock_chain_and_stop_one() {
        if std::env::var("ROWKERY_PG_HOST").is_err() {
            eprintln!(
                "skip postgres_sessions_show_a_lock_chain_and_stop_one (set ROWKERY_PG_HOST)"
            );
            return;
        }
        let (_guard, _file, _path) = test_guard();
        let bridge = super::CoreBridge::spawn();
        let id = "postgres-sessions";
        CoreBridge::upsert_connection(
            &bridge,
            ConnectionRecord::Postgres(PostgresConnection {
                allow_mcp: false,
                mcp_hidden_tables: Vec::new(),
                mcp_until: None,
                mcp_samples_off: false,
                mcp_access: None,
                masked_columns: Default::default(),
                environment: None,
                safe_mode: Default::default(),
                id: id.into(),
                name: "pg sessions".into(),
                host: std::env::var("ROWKERY_PG_HOST").unwrap(),
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
            }),
            ConnectionSecrets {
                db_password: Some(
                    std::env::var("ROWKERY_PG_PASSWORD").unwrap_or_else(|_| "rowkery".into()),
                ),
                ..Default::default()
            },
        )
        .expect("save");
        bridge.open_window("w", id, None).expect("open");
        window_query(
            &bridge,
            "w",
            1,
            "CREATE TABLE IF NOT EXISTS fixb_sessions (x int)",
        );
        let pid = |tab| match window_query(&bridge, "w", tab, "SELECT pg_backend_pid()").0 {
            Some(Value::Int(p)) => p as i32,
            other => panic!("pid: {other:?}"),
        };
        let holder = pid(1);
        window_query(&bridge, "w", 1, "BEGIN");
        let (_, err, ..) = window_query(
            &bridge,
            "w",
            1,
            "LOCK TABLE fixb_sessions IN ACCESS EXCLUSIVE MODE",
        );
        assert_eq!(err, None);
        // Tab 2 waits on tab 1's lock.
        let waiting = bridge
            .run_window_query(
                "w",
                2,
                "SELECT count(*) FROM fixb_sessions".into(),
                None,
                false,
            )
            .expect("run");
        let deadline = Instant::now() + Duration::from_secs(5);
        let rows = loop {
            let rows = bridge.sessions("w").expect("sessions");
            if rows.iter().any(|r| r.session.blocked_by.contains(&holder))
                || Instant::now() > deadline
            {
                break rows;
            }
            thread::sleep(Duration::from_millis(50));
        };
        let ours = rows
            .iter()
            .find(|r| r.session.pid == holder)
            .expect("the holder is listed");
        assert_eq!(
            ours.tab,
            Some(super::SessionTab {
                window_id: "w".into(),
                tab_id: 1
            })
        );
        assert_eq!(ours.session.state.as_deref(), Some("idle in transaction"));
        assert!(ours.session.can_stop);
        let blocked = rows
            .iter()
            .find(|r| r.session.blocked_by.contains(&holder))
            .expect("tab 2 waits on tab 1");
        assert_eq!(blocked.session.wait.as_deref(), Some("Lock: relation"));
        let locks = bridge.session_locks("w", holder).expect("locks");
        assert!(locks
            .iter()
            .any(|l| l.table == "public.fixb_sessions" && l.mode == "AccessExclusiveLock"));

        // Cancel runs at once with safe mode off; End always asks first.
        assert_eq!(
            bridge.stop_session("w", blocked.session.pid, StopKind::Cancel, false),
            Ok(super::StopOutcome::Stopped { gone: false })
        );
        wait_stopped(&waiting, Duration::from_secs(5)).expect("tab 2 stops");
        assert_eq!(
            bridge.stop_session("w", holder, StopKind::End, false),
            Ok(super::StopOutcome::Held {
                sql: format!("SELECT pg_terminate_backend({holder})")
            })
        );
        assert_eq!(
            bridge.stop_session("w", holder, StopKind::End, true),
            Ok(super::StopOutcome::Stopped { gone: false })
        );
        thread::sleep(Duration::from_millis(200));
        let (_, err, ..) = window_query(&bridge, "w", 1, "SELECT 1");
        assert!(
            err.is_some_and(|e| e.contains("transaction")),
            "tab 1 is told its transaction went"
        );
        window_query(&bridge, "w", 3, "DROP TABLE fixb_sessions");
        std::env::remove_var("ROWKERY_CONFIG_DIR");
    }

    /// A session the server killed while parked is replaced at lease, before
    /// anything is sent (so even a write is safe); `ping_idle` replaces dead
    /// idle sessions ahead of the next run and leaves live ones alone.
    #[test]
    fn postgres_dead_sessions_are_replaced_off_the_query_path() {
        if std::env::var("ROWKERY_PG_HOST").is_err() {
            eprintln!(
                "skip postgres_dead_sessions_are_replaced_off_the_query_path (set ROWKERY_PG_HOST)"
            );
            return;
        }
        let (_guard, _file, _path) = test_guard();
        let bridge = super::CoreBridge::spawn();
        let id = "postgres-dead";
        CoreBridge::upsert_connection(
            &bridge,
            ConnectionRecord::Postgres(PostgresConnection {
                allow_mcp: false,
                mcp_hidden_tables: Vec::new(),
                mcp_until: None,
                mcp_samples_off: false,
                mcp_access: None,
                masked_columns: Default::default(),
                environment: None,
                safe_mode: Default::default(),
                id: id.into(),
                name: "pg dead".into(),
                host: std::env::var("ROWKERY_PG_HOST").unwrap(),
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
            }),
            ConnectionSecrets {
                db_password: Some(
                    std::env::var("ROWKERY_PG_PASSWORD").unwrap_or_else(|_| "rowkery".into()),
                ),
                ..Default::default()
            },
        )
        .expect("save");
        bridge.open_window("w", id, None).expect("open");
        let pid = |tab| match window_query(&bridge, "w", tab, "SELECT pg_backend_pid()").0 {
            Some(Value::Int(p)) => p,
            other => panic!("pid: {other:?}"),
        };
        let kill = |victim: i64| {
            let (_, err, ..) = window_query(
                &bridge,
                "w",
                9,
                &format!("SELECT pg_terminate_backend({victim})"),
            );
            assert_eq!(err, None);
            thread::sleep(std::time::Duration::from_millis(200));
        };
        let (name, ..) = window_query(&bridge, "w", 1, "SHOW application_name");
        assert!(
            matches!(name, Some(Value::Text(ref n)) if n.starts_with("Rowkery ")),
            "{name:?}"
        );

        // Killed while parked: the next statement, a write, runs on a fresh one.
        let first = pid(1);
        kill(first);
        window_query(
            &bridge,
            "w",
            1,
            "CREATE TEMP TABLE IF NOT EXISTS t_dead (x int)",
        );
        let (_, err, ..) = window_query(&bridge, "w", 1, "INSERT INTO t_dead VALUES (1)");
        assert_eq!(err, None, "a write after the kill runs on a replacement");
        let second = pid(1);
        assert_ne!(second, first);

        // Idle sessions: a live one is kept, a dead one replaced in the background.
        assert_eq!(bridge.ping_idle_blocking("w", std::time::Duration::ZERO), 0);
        assert_eq!(pid(1), second, "a live session stays");
        kill(second);
        assert!(bridge.ping_idle_blocking("w", std::time::Duration::ZERO) >= 1);
        let third = pid(1);
        assert_ne!(third, second);
        std::env::remove_var("ROWKERY_CONFIG_DIR");
    }

    /// A window's sessions share one SSH tunnel: three tabs running at once
    /// open one SSH connection, not three; closing the window closes it.
    #[test]
    fn postgres_window_sessions_share_one_ssh_tunnel() {
        let (Ok(pg_host), Ok(ssh_host)) = (
            std::env::var("ROWKERY_PG_HOST"),
            std::env::var("ROWKERY_SSH_HOST"),
        ) else {
            eprintln!("skip postgres_window_sessions_share_one_ssh_tunnel (set ROWKERY_PG_HOST and ROWKERY_SSH_HOST)");
            return;
        };
        use rowkery_core::connections::{SshAuthMethod, SshConfig};
        use rowkery_core::ssh::OPEN_TUNNELS;
        use std::sync::atomic::Ordering;
        let (_guard, _file, _path) = test_guard();
        let bridge = super::CoreBridge::spawn();
        let id = "postgres-ssh";
        CoreBridge::upsert_connection(
            &bridge,
            ConnectionRecord::Postgres(PostgresConnection {
                allow_mcp: false,
                mcp_hidden_tables: Vec::new(),
                mcp_until: None,
                mcp_samples_off: false,
                mcp_access: None,
                masked_columns: Default::default(),
                environment: None,
                safe_mode: Default::default(),
                id: id.into(),
                name: "pg over ssh".into(),
                host: pg_host,
                port: std::env::var("ROWKERY_PG_PORT")
                    .ok()
                    .and_then(|p| p.parse().ok())
                    .unwrap_or(54329),
                database: std::env::var("ROWKERY_PG_DB").unwrap_or_else(|_| "rowkery".into()),
                username: std::env::var("ROWKERY_PG_USER").unwrap_or_else(|_| "rowkery".into()),
                ssl_mode: PostgresSslMode::Disable,
                ssl_root_cert: None,
                ssh: Some(SshConfig {
                    host: ssh_host,
                    port: std::env::var("ROWKERY_SSH_PORT")
                        .ok()
                        .and_then(|p| p.parse().ok())
                        .unwrap_or(2222),
                    username: std::env::var("ROWKERY_SSH_USER")
                        .unwrap_or_else(|_| "rowkery".into()),
                    auth_method: SshAuthMethod::Password,
                    private_key_path: None,
                    trust_host: true,
                }),
                cloud_sql: None,
            }),
            ConnectionSecrets {
                db_password: Some(
                    std::env::var("ROWKERY_PG_PASSWORD").unwrap_or_else(|_| "rowkery".into()),
                ),
                ssh_password: Some(
                    std::env::var("ROWKERY_SSH_PASSWORD").unwrap_or_else(|_| "rowkeryssh".into()),
                ),
                ..Default::default()
            },
        )
        .expect("save");
        let before = OPEN_TUNNELS.load(Ordering::Relaxed);
        bridge.open_window("w", id, None).expect("open over ssh");
        let queues: Vec<_> = (1..=3)
            .map(|tab| {
                bridge
                    .run_window_query(
                        "w",
                        tab,
                        "SELECT pg_sleep(0.2), pg_backend_pid()".into(),
                        None,
                        false,
                    )
                    .expect("run")
            })
            .collect();
        for q in &queues {
            let (rows, err, _) = wait_finished(q);
            assert_eq!((rows, err), (1, None));
        }
        assert_eq!(
            OPEN_TUNNELS.load(Ordering::Relaxed) - before,
            1,
            "three tabs, one SSH tunnel"
        );
        bridge.close_window("w");
        thread::sleep(std::time::Duration::from_millis(300));
        assert_eq!(
            OPEN_TUNNELS.load(Ordering::Relaxed),
            before,
            "closing the window closes it"
        );
        std::env::remove_var("ROWKERY_CONFIG_DIR");
    }

    /// A window shows its cached catalog at once and the server confirms it;
    /// after DDL elsewhere the cached one is replaced; a server that refuses
    /// after the cached reply is reported, not cached.
    #[test]
    fn postgres_catalog_cache_confirms_replaces_and_fails() {
        if std::env::var("ROWKERY_PG_HOST").is_err() {
            eprintln!(
                "skip postgres_catalog_cache_confirms_replaces_and_fails (set ROWKERY_PG_HOST)"
            );
            return;
        }
        let (_guard, _file, _path) = test_guard();
        let bridge = super::CoreBridge::spawn();
        let updates: Arc<Mutex<Vec<CatalogUpdate>>> = Arc::default();
        let seen = updates.clone();
        bridge.on_catalog_update(Arc::new(move |u| seen.lock().unwrap().push(u)));
        let pg = |id: &str, port: u16| {
            ConnectionRecord::Postgres(PostgresConnection {
                allow_mcp: false,
                mcp_hidden_tables: Vec::new(),
                mcp_until: None,
                mcp_samples_off: false,
                mcp_access: None,
                masked_columns: Default::default(),
                environment: None,
                safe_mode: Default::default(),
                id: id.into(),
                name: id.into(),
                host: std::env::var("ROWKERY_PG_HOST").unwrap(),
                port,
                database: std::env::var("ROWKERY_PG_DB").unwrap_or_else(|_| "rowkery".into()),
                username: std::env::var("ROWKERY_PG_USER").unwrap_or_else(|_| "rowkery".into()),
                ssl_mode: PostgresSslMode::Disable,
                ssl_root_cert: None,
                ssh: None,
                cloud_sql: None,
            })
        };
        let port = std::env::var("ROWKERY_PG_PORT")
            .ok()
            .and_then(|p| p.parse().ok())
            .unwrap_or(54329);
        let secrets = ConnectionSecrets {
            db_password: Some(
                std::env::var("ROWKERY_PG_PASSWORD").unwrap_or_else(|_| "rowkery".into()),
            ),
            ..Default::default()
        };
        CoreBridge::upsert_connection(&bridge, pg("pg-cache", port), secrets.clone())
            .expect("save");
        let wait_update = |n: usize| {
            for _ in 0..200 {
                if updates.lock().unwrap().len() >= n {
                    return updates.lock().unwrap()[n - 1].clone();
                }
                thread::sleep(std::time::Duration::from_millis(20));
            }
            panic!("no catalog update #{n}");
        };
        let first = bridge.open_window("w1", "pg-cache", None).expect("open");
        assert!(!first.cached, "nothing cached yet");

        let second = bridge.open_window("w2", "pg-cache", None).expect("open");
        assert!(second.cached);
        assert_eq!(second.catalog, first.catalog);
        assert_eq!(
            wait_update(1),
            CatalogUpdate::Confirmed {
                window_id: "w2".into(),
                open_seq: second.open_seq
            }
        );

        // DDL elsewhere: the next cached open is replaced with the live catalog.
        window_query(&bridge, "w1", 1, "DROP TABLE IF EXISTS cache_probe");
        window_query(&bridge, "w1", 1, "CREATE TABLE cache_probe (id int)");
        let third = bridge.open_window("w3", "pg-cache", None).expect("open");
        assert!(third.cached);
        assert!(third
            .catalog
            .find_table("rowkery", "public", "cache_probe")
            .is_none());
        match wait_update(2) {
            CatalogUpdate::Replaced {
                window_id, catalog, ..
            } => {
                assert_eq!(window_id, "w3");
                assert!(catalog
                    .find_table("rowkery", "public", "cache_probe")
                    .is_some());
            }
            other => panic!("expected Replaced, got {other:?}"),
        }
        window_query(&bridge, "w1", 1, "DROP TABLE cache_probe");

        // A cached open whose server then refuses: Failed, and the cache stays as it was.
        CoreBridge::upsert_connection(&bridge, pg("pg-cache", 1), secrets).expect("save");
        let fourth = bridge
            .open_window("w4", "pg-cache", None)
            .expect("cached reply");
        assert!(fourth.cached);
        assert!(
            matches!(wait_update(3), CatalogUpdate::Failed { ref window_id, .. } if window_id == "w4")
        );

        bridge.remove_connection("pg-cache", false).expect("delete");
        assert_eq!(
            rowkery_core::catalog_cache::load("pg-cache", "rowkery"),
            None,
            "deleted with the connection"
        );
        std::env::remove_var("ROWKERY_CONFIG_DIR");
    }

    #[test]
    fn postgres_tabs_keep_their_session_between_runs() {
        if std::env::var("ROWKERY_PG_HOST").is_err() {
            eprintln!("skip postgres_tabs_keep_their_session_between_runs (set ROWKERY_PG_HOST)");
            return;
        }
        let (_guard, _file, _path) = test_guard();
        let bridge = super::CoreBridge::spawn();
        let id = "postgres-warm";
        CoreBridge::upsert_connection(
            &bridge,
            ConnectionRecord::Postgres(PostgresConnection {
                environment: None,
                safe_mode: Default::default(),
                allow_mcp: false,
                mcp_hidden_tables: Vec::new(),
                mcp_until: None,
                mcp_samples_off: false,
                mcp_access: None,
                masked_columns: Default::default(),
                id: id.into(),
                name: "pg warm".into(),
                host: std::env::var("ROWKERY_PG_HOST").unwrap(),
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
            }),
            ConnectionSecrets {
                db_password: Some(
                    std::env::var("ROWKERY_PG_PASSWORD").unwrap_or_else(|_| "rowkery".into()),
                ),
                ..Default::default()
            },
        )
        .expect("save");
        bridge.open_window("w", id, None).expect("open");
        let pid = |tab| window_query(&bridge, "w", tab, "SELECT pg_backend_pid()").0;

        // The first run adopts the schema load's session; later runs reuse it.
        let first = pid(1);
        assert!(first.is_some());
        for _ in 0..3 {
            assert_eq!(pid(1), first, "tab 1 should stay on one backend");
        }
        // Session state carries across runs in a tab.
        window_query(&bridge, "w", 1, "SET application_name = 'rowkery-warm'");
        let (name, ..) = window_query(&bridge, "w", 1, "SHOW application_name");
        assert_eq!(
            name,
            Some(rowkery_core::db::Value::Text("rowkery-warm".into()))
        );

        // So does a temp table, and writes report the rows they touched.
        let run = |sql: &str| window_query(&bridge, "w", 1, sql);
        assert_eq!(run("CREATE TEMP TABLE warm (n int)").1, None);
        assert_eq!(
            run("INSERT INTO warm SELECT generate_series(1, 3)").4,
            Some(3)
        );
        assert_eq!(
            run("SELECT count(*) FROM warm").0,
            Some(rowkery_core::db::Value::Int(3))
        );

        // Another tab gets its own backend.
        let second = pid(2);
        assert!(second.is_some() && second != first);
        assert_eq!(pid(2), second);

        // After a cancel the tab starts over on a fresh session.
        let queue = bridge
            .run_window_query("w", 1, "SELECT pg_sleep(30)".into(), None, false)
            .expect("run");
        thread::sleep(std::time::Duration::from_millis(300));
        bridge.cancel_window_query("w", 1);
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(5);
        let mut cancelled = false;
        while !cancelled && std::time::Instant::now() < deadline {
            for event in std::mem::take(&mut *queue.lock().unwrap()) {
                if let CoreEvent::QueryFinished { cancelled: c, .. } = event {
                    assert!(c, "pg_sleep should be cancelled");
                    cancelled = true;
                }
            }
            thread::sleep(std::time::Duration::from_millis(10));
        }
        assert!(cancelled);
        let after_cancel = pid(1);
        assert!(after_cancel.is_some() && after_cancel != first);
        assert_eq!(pid(1), after_cancel);

        // A backend killed while parked is replaced without an error.
        let killed = match after_cancel.clone() {
            Some(rowkery_core::db::Value::Int(p)) => p,
            other => panic!("pid {other:?}"),
        };
        let (_, err, ..) = window_query(
            &bridge,
            "w",
            2,
            &format!("SELECT pg_terminate_backend({killed})"),
        );
        assert_eq!(err, None);
        thread::sleep(std::time::Duration::from_millis(200));
        let (cell, err, ..) = window_query(&bridge, "w", 1, "SELECT pg_backend_pid()");
        assert_eq!(err, None, "a dead parked session should be replaced");
        assert!(cell.is_some() && cell != after_cancel);

        // Re-pointing the window drops its sessions.
        bridge.open_window("w", id, None).expect("reopen");
        assert_ne!(pid(2), second);

        // Warm runs skip connecting: print cold vs warm for a quick look.
        bridge.close_window_tab("w", 3);
        let cold = window_query(&bridge, "w", 3, "SELECT 1").3;
        let warm: Vec<u64> = (0..5)
            .map(|_| window_query(&bridge, "w", 3, "SELECT 1").3)
            .collect();
        eprintln!("first run {cold} ms, warm runs {warm:?} ms");
        std::env::remove_var("ROWKERY_CONFIG_DIR");
    }

    #[test]
    fn postgres_schema_reload_keeps_tab_sessions() {
        let Ok(host) = std::env::var("ROWKERY_PG_HOST") else {
            eprintln!("skip postgres_schema_reload_keeps_tab_sessions (set ROWKERY_PG_HOST)");
            return;
        };
        let (_guard, _file, _path) = test_guard();
        let bridge = super::CoreBridge::spawn();
        let id = "postgres-reload";
        CoreBridge::upsert_connection(
            &bridge,
            ConnectionRecord::Postgres(PostgresConnection {
                environment: None,
                safe_mode: Default::default(),
                allow_mcp: false,
                mcp_hidden_tables: Vec::new(),
                mcp_until: None,
                mcp_samples_off: false,
                mcp_access: None,
                masked_columns: Default::default(),
                id: id.into(),
                name: "pg reload".into(),
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
            }),
            ConnectionSecrets {
                db_password: Some(
                    std::env::var("ROWKERY_PG_PASSWORD").unwrap_or_else(|_| "rowkery".into()),
                ),
                ..Default::default()
            },
        )
        .expect("save");
        bridge.open_window("w", id, None).expect("open");
        let run = |sql: &str| window_query(&bridge, "w", 1, sql);
        let has_probe = |catalog: &SchemaCatalog| {
            catalog
                .databases
                .iter()
                .flat_map(|d| &d.schemas)
                .flat_map(|s| &s.tables)
                .any(|t| t.name == "it_reload_probe")
        };
        assert_eq!(run("DROP TABLE IF EXISTS public.it_reload_probe").1, None);
        let pid = run("SELECT pg_backend_pid()").0;
        assert!(pid.is_some());

        // DDL inside a transaction: the reload can't see it yet, and must not
        // close the tab's session (that would roll the transaction back).
        assert_eq!(run("BEGIN").1, None);
        assert_eq!(
            run("CREATE TABLE public.it_reload_probe (id int PRIMARY KEY)").1,
            None
        );
        let catalog = bridge.reload_window_schema("w").expect("reload");
        assert!(!has_probe(&catalog), "uncommitted table is not visible yet");
        assert_eq!(
            run("SELECT pg_backend_pid()").0,
            pid,
            "tab keeps its backend"
        );
        assert_eq!(run("COMMIT").1, None);
        let catalog = bridge.reload_window_schema("w").expect("reload");
        assert!(has_probe(&catalog), "committed table shows after a reload");

        // Index details load on the window's spare session, not the tab's.
        let loaded = bridge
            .table_indexes("w", "public", vec!["it_reload_probe".into()])
            .expect("indexes");
        assert_eq!(loaded.len(), 1);
        assert!(loaded[0].indexes.iter().any(|ix| ix.primary));
        assert_eq!(run("SELECT pg_backend_pid()").0, pid);

        assert_eq!(run("DROP TABLE public.it_reload_probe").1, None);
        std::env::remove_var("ROWKERY_CONFIG_DIR");
    }

    fn edit_table(schema: &str, table: &str, columns: &[(&str, &str)], key: &[&str]) -> EditTable {
        EditTable {
            schema: schema.into(),
            table: table.into(),
            columns: columns
                .iter()
                .map(|(name, ty)| rowkery_core::edits::EditColumn {
                    name: name.to_string(),
                    type_name: ty.to_string(),
                })
                .collect(),
            key: key.iter().map(|k| k.to_string()).collect(),
        }
    }

    fn cell(column: &str, value: Value) -> rowkery_core::edits::CellValue {
        rowkery_core::edits::CellValue {
            column: column.into(),
            value,
        }
    }

    fn update(id: i64, column: &str, value: Value) -> Change {
        Change::Update {
            key: vec![cell("id", Value::Int(id))],
            set: vec![cell(column, value)],
        }
    }

    #[test]
    fn sqlite_apply_changes_commits_or_rolls_back_whole() {
        use rowkery_core::safety::HoldAction;
        let (_guard, _file, path) = test_guard();
        Connection::open(&path)
            .expect("open")
            .execute_batch(
                "CREATE TABLE k (id INTEGER PRIMARY KEY, name TEXT);
                 INSERT INTO k VALUES (1, 'a'), (2, 'b'), (3, 'c');
                 CREATE TABLE dup (id INTEGER, name TEXT);
                 INSERT INTO dup VALUES (1, 'x'), (2, 'y'), (2, 'z');",
            )
            .expect("seed");
        let bridge = super::CoreBridge::spawn();
        for (id, safe_mode) in [
            ("off", SafeMode::Off),
            ("confirm", SafeMode::Confirm),
            ("ro", SafeMode::ReadOnly),
        ] {
            CoreBridge::upsert_connection(
                &bridge,
                ConnectionRecord::Sqlite(SqliteConnection {
                    allow_mcp: false,
                    mcp_hidden_tables: Vec::new(),
                    mcp_until: None,
                    mcp_samples_off: false,
                    mcp_access: None,
                    masked_columns: Default::default(),
                    environment: None,
                    safe_mode,
                    id: id.into(),
                    name: id.into(),
                    path: path.clone(),
                    sample: false,
                }),
                ConnectionSecrets::default(),
            )
            .expect("save");
            bridge.open_window(id, id, None).expect("open");
        }
        let k = edit_table("main", "k", &[("id", "INTEGER"), ("name", "TEXT")], &["id"]);
        let read = |sql: &str| window_query(&bridge, "off", 1, sql).0;
        let name_of = |id: i64| read(&format!("SELECT name FROM k WHERE id = {id}"));

        // Committed: one of each verb.
        let out = bridge
            .apply_changes(
                "off",
                1,
                k.clone(),
                vec![
                    Change::Insert {
                        values: vec![cell("name", Value::Text("new".into()))],
                    },
                    update(1, "name", Value::Text("it's".into())),
                    Change::Delete {
                        key: vec![cell("id", Value::Int(3))],
                    },
                ],
                None,
            )
            .expect("apply");
        let ApplyOutcome::Committed { counts, .. } = out else {
            panic!("{out:?}")
        };
        assert_eq!((counts.inserted, counts.updated, counts.deleted), (1, 1, 1));
        assert_eq!(name_of(1), Some(Value::Text("it's".into())));
        assert_eq!(name_of(3), None);

        // A statement that matches no row rolls the whole batch back.
        let out = bridge
            .apply_changes(
                "off",
                1,
                k.clone(),
                vec![
                    update(2, "name", Value::Text("kept?".into())),
                    update(99, "name", Value::Text("nobody".into())),
                ],
                None,
            )
            .expect("apply");
        let ApplyOutcome::RolledBack { failure, .. } = out else {
            panic!("{out:?}")
        };
        assert_eq!(failure.index, Some(1));
        assert_eq!(failure.rows, Some(0));
        assert_eq!(failure.message, "UPDATE k WHERE id = 99 changed 0 rows");
        assert_eq!(name_of(2), Some(Value::Text("b".into())));

        // A key that matches two rows: rolled back, and the row is named.
        let dup = edit_table(
            "main",
            "dup",
            &[("id", "INTEGER"), ("name", "TEXT")],
            &["id"],
        );
        let out = bridge
            .apply_changes(
                "off",
                1,
                dup,
                vec![
                    update(1, "name", Value::Text("one".into())),
                    update(2, "name", Value::Text("two".into())),
                ],
                None,
            )
            .expect("apply");
        let ApplyOutcome::RolledBack { failure, .. } = out else {
            panic!("{out:?}")
        };
        assert_eq!(failure.message, "UPDATE dup WHERE id = 2 changed 2 rows");
        assert_eq!(
            read("SELECT name FROM dup WHERE id = 1"),
            Some(Value::Text("x".into()))
        );

        // rowid names a row of a table without a primary key.
        let t = edit_table("main", "t", &[("id", "INTEGER")], &["rowid"]);
        let out = bridge
            .apply_changes(
                "off",
                1,
                t,
                vec![Change::Update {
                    key: vec![cell("rowid", Value::Int(1))],
                    set: vec![cell("id", Value::Int(5))],
                }],
                None,
            )
            .expect("apply");
        assert!(matches!(out, ApplyOutcome::Committed { .. }), "{out:?}");
        assert_eq!(read("SELECT id FROM t"), Some(Value::Int(5)));

        // Confirm writes: held with the exact text; only that text runs.
        let change = vec![update(2, "name", Value::Text("confirmed".into()))];
        let out = bridge
            .apply_changes("confirm", 1, k.clone(), change.clone(), None)
            .expect("apply");
        let ApplyOutcome::Held { hold, sql } = out else {
            panic!("{out:?}")
        };
        assert_eq!(hold.action, HoldAction::Confirm);
        assert_eq!(
            sql,
            "BEGIN;\nUPDATE k SET name = 'confirmed' WHERE id = 2;\nCOMMIT;"
        );
        assert_eq!(name_of(2), Some(Value::Text("b".into())), "nothing ran");
        assert!(bridge
            .apply_changes(
                "confirm",
                1,
                k.clone(),
                change.clone(),
                Some("BEGIN;".into())
            )
            .is_err());
        let out = bridge
            .apply_changes("confirm", 1, k.clone(), change.clone(), Some(sql))
            .expect("apply");
        assert!(matches!(out, ApplyOutcome::Committed { .. }), "{out:?}");
        assert_eq!(name_of(2), Some(Value::Text("confirmed".into())));

        // Read-only: refused, confirmed or not.
        let change = vec![update(2, "name", Value::Text("refused".into()))];
        let sql = review_changes(EngineKind::Sqlite, &k, &change).unwrap().sql;
        let out = bridge
            .apply_changes("ro", 1, k.clone(), change, Some(sql))
            .expect("apply");
        let ApplyOutcome::Held { hold, .. } = out else {
            panic!("{out:?}")
        };
        assert_eq!(hold.action, HoldAction::Refuse);
        assert_eq!(name_of(2), Some(Value::Text("confirmed".into())));

        // Nothing to commit, or no key: refused before anything runs.
        assert!(bridge
            .apply_changes("off", 1, k.clone(), vec![], None)
            .is_err());
        let keyless = edit_table("main", "k", &[("id", "INTEGER")], &[]);
        assert!(bridge
            .apply_changes(
                "off",
                1,
                keyless,
                vec![update(1, "id", Value::Int(1))],
                None
            )
            .is_err());
        std::env::remove_var("ROWKERY_CONFIG_DIR");
    }

    #[test]
    fn postgres_apply_changes_commits_or_rolls_back_whole() {
        use rowkery_core::safety::HoldAction;
        let Ok(host) = std::env::var("ROWKERY_PG_HOST") else {
            eprintln!(
                "skip postgres_apply_changes_commits_or_rolls_back_whole (set ROWKERY_PG_HOST)"
            );
            return;
        };
        let (_guard, _file, _path) = test_guard();
        let bridge = super::CoreBridge::spawn();
        for (id, safe_mode) in [
            ("off", SafeMode::Off),
            ("confirm", SafeMode::Confirm),
            ("ro", SafeMode::ReadOnly),
        ] {
            CoreBridge::upsert_connection(
                &bridge,
                ConnectionRecord::Postgres(PostgresConnection {
                    allow_mcp: false,
                    mcp_hidden_tables: Vec::new(),
                    mcp_until: None,
                    mcp_samples_off: false,
                    mcp_access: None,
                    masked_columns: Default::default(),
                    environment: None,
                    safe_mode,
                    id: id.into(),
                    name: id.into(),
                    host: host.clone(),
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
                }),
                ConnectionSecrets {
                    db_password: Some(
                        std::env::var("ROWKERY_PG_PASSWORD").unwrap_or_else(|_| "rowkery".into()),
                    ),
                    ..Default::default()
                },
            )
            .expect("save");
            bridge.open_window(id, id, None).expect("open");
        }
        let run = |sql: &str| window_query(&bridge, "off", 1, sql);
        // A unique index stands in for the key; dropping it lets a duplicate in.
        for sql in [
            "DROP TABLE IF EXISTS public.it_edits",
            "CREATE TABLE public.it_edits (id int NOT NULL, name text, price numeric(10,2), \
             meta jsonb, raw bytea, at timestamptz, ok boolean, tags text[], \
             kind text DEFAULT 'plain')",
            "CREATE UNIQUE INDEX it_edits_id ON public.it_edits (id)",
            "INSERT INTO public.it_edits (id, name) VALUES (1, 'one'), (2, 'two'), (3, 'three')",
            "DROP INDEX public.it_edits_id",
            "INSERT INTO public.it_edits (id, name) VALUES (2, 'two again')",
        ] {
            assert_eq!(run(sql).1, None, "{sql}");
        }
        let table = edit_table(
            "public",
            "it_edits",
            &[
                ("id", "integer"),
                ("name", "text"),
                ("price", "numeric(10,2)"),
                ("meta", "jsonb"),
                ("raw", "bytea"),
                ("at", "timestamp with time zone"),
                ("ok", "boolean"),
                ("tags", "text[]"),
                ("kind", "text"),
            ],
            &["id"],
        );
        let text = |s: &str| Value::Text(s.into());
        let check = |sql: &str| run(sql).0;

        // The duplicate: its UPDATE matches 2 rows, so nothing is kept.
        let out = bridge
            .apply_changes(
                "off",
                1,
                table.clone(),
                vec![
                    update(1, "name", text("changed")),
                    update(2, "name", text("both?")),
                ],
                None,
            )
            .expect("apply");
        let ApplyOutcome::RolledBack { failure, .. } = out else {
            panic!("{out:?}")
        };
        assert_eq!(failure.index, Some(1));
        assert_eq!(failure.rows, Some(2));
        assert_eq!(
            failure.message,
            "UPDATE public.it_edits WHERE id = 2 changed 2 rows"
        );
        assert_eq!(
            check("SELECT name FROM public.it_edits WHERE id = 1"),
            Some(text("one")),
            "the first statement was rolled back"
        );

        // Every literal kind round-trips through a committed batch.
        let out = bridge
            .apply_changes(
                "off",
                1,
                table.clone(),
                vec![
                    Change::Insert {
                        values: vec![cell("id", Value::Int(10)), cell("name", text("ten"))],
                    },
                    Change::Update {
                        key: vec![cell("id", Value::Int(1))],
                        set: vec![
                            cell("name", text(r"it's a \ backslash")),
                            cell("price", text("12.50")),
                            cell("meta", text(r#"{"a": "it's", "b": [1, 2]}"#)),
                            cell("raw", Value::Bytes(vec![0x00, 0xff, 0x27, 0x5c])),
                            cell("at", text("2026-10-05 09:30:00+00")),
                            cell("ok", Value::Bool(true)),
                            cell("tags", text(r#"{a,"b c"}"#)),
                        ],
                    },
                    Change::Delete {
                        key: vec![cell("id", Value::Int(3))],
                    },
                ],
                None,
            )
            .expect("apply");
        let ApplyOutcome::Committed { counts, .. } = out else {
            panic!("{out:?}")
        };
        assert_eq!((counts.inserted, counts.updated, counts.deleted), (1, 1, 1));
        assert_eq!(
            check(
                r#"SELECT name = 'it''s a \ backslash' AND price = 12.50
                   AND meta = '{"a": "it''s", "b": [1, 2]}'::jsonb
                   AND raw = '\x00ff275c'::bytea
                   AND at = '2026-10-05 09:30:00+00'::timestamptz
                   AND ok AND tags = ARRAY['a', 'b c']
                   FROM public.it_edits WHERE id = 1"#
            ),
            Some(Value::Bool(true))
        );
        // Columns an insert leaves out get their default.
        assert_eq!(
            check("SELECT kind FROM public.it_edits WHERE id = 10"),
            Some(text("plain"))
        );
        assert_eq!(
            check("SELECT count(*) FROM public.it_edits WHERE id = 3"),
            Some(Value::Int(0))
        );

        // NULL is written bare.
        let out = bridge
            .apply_changes(
                "off",
                1,
                table.clone(),
                vec![update(1, "meta", Value::Null)],
                None,
            )
            .expect("apply");
        assert!(matches!(out, ApplyOutcome::Committed { .. }), "{out:?}");
        assert_eq!(
            check("SELECT meta IS NULL FROM public.it_edits WHERE id = 1"),
            Some(Value::Bool(true))
        );

        // A server error names the statement and keeps nothing.
        let out = bridge
            .apply_changes(
                "off",
                1,
                table.clone(),
                vec![
                    update(10, "name", text("ten?")),
                    Change::Insert {
                        values: vec![cell("name", text("no id"))],
                    },
                ],
                None,
            )
            .expect("apply");
        let ApplyOutcome::RolledBack { failure, .. } = out else {
            panic!("{out:?}")
        };
        assert_eq!(failure.index, Some(1));
        assert!(
            failure.message.starts_with("INSERT INTO public.it_edits: "),
            "{}",
            failure.message
        );
        assert_eq!(
            check("SELECT name FROM public.it_edits WHERE id = 10"),
            Some(text("ten"))
        );

        // Never inside the user's own transaction on the tab.
        assert_eq!(window_query(&bridge, "off", 7, "BEGIN").1, None);
        let out = bridge
            .apply_changes(
                "off",
                7,
                table.clone(),
                vec![update(10, "name", text("x"))],
                None,
            )
            .expect("apply");
        let ApplyOutcome::RolledBack { failure, .. } = out else {
            panic!("{out:?}")
        };
        assert!(failure.message.contains("transaction open"), "{failure:?}");
        assert_eq!(window_query(&bridge, "off", 7, "ROLLBACK").1, None);
        let out = bridge
            .apply_changes(
                "off",
                7,
                table.clone(),
                vec![update(10, "name", text("x"))],
                None,
            )
            .expect("apply");
        assert!(matches!(out, ApplyOutcome::Committed { .. }), "{out:?}");

        // Confirm writes: held with the statements, then exactly those run.
        let change = vec![update(10, "name", text("confirmed"))];
        let out = bridge
            .apply_changes("confirm", 1, table.clone(), change.clone(), None)
            .expect("apply");
        let ApplyOutcome::Held { hold, sql } = out else {
            panic!("{out:?}")
        };
        assert_eq!(hold.action, HoldAction::Confirm);
        assert_eq!(hold.statements[0].verb, "UPDATE");
        assert!(sql.contains("UPDATE public.it_edits SET name = 'confirmed' WHERE id = 10;"));
        assert_eq!(
            check("SELECT name FROM public.it_edits WHERE id = 10"),
            Some(text("x"))
        );
        let out = bridge
            .apply_changes("confirm", 1, table.clone(), change, Some(sql))
            .expect("apply");
        assert!(matches!(out, ApplyOutcome::Committed { .. }), "{out:?}");
        assert_eq!(
            check("SELECT name FROM public.it_edits WHERE id = 10"),
            Some(text("confirmed"))
        );

        // Read-only: refused, even confirmed.
        let change = vec![update(10, "name", text("refused"))];
        let sql = review_changes(EngineKind::Postgres, &table, &change)
            .unwrap()
            .sql;
        let out = bridge
            .apply_changes("ro", 1, table.clone(), change, Some(sql))
            .expect("apply");
        let ApplyOutcome::Held { hold, .. } = out else {
            panic!("{out:?}")
        };
        assert_eq!(hold.action, HoldAction::Refuse);
        assert_eq!(
            check("SELECT name FROM public.it_edits WHERE id = 10"),
            Some(text("confirmed"))
        );

        assert_eq!(run("DROP TABLE public.it_edits").1, None);
        std::env::remove_var("ROWKERY_CONFIG_DIR");
    }

    // ---- Review fixes: prefetch, Quick Look, counts, edits, transactions ----

    /// Saves the test Postgres (through `port` when given, e.g. a
    /// `freezing_proxy`) as connection `id` in `safe_mode`.
    fn save_pg_at(
        bridge: &super::CoreBridge,
        id: &str,
        port: Option<u16>,
        safe_mode: SafeMode,
    ) -> Option<()> {
        let host = std::env::var("ROWKERY_PG_HOST").ok()?;
        let pg_port = std::env::var("ROWKERY_PG_PORT")
            .ok()
            .and_then(|p| p.parse().ok())
            .unwrap_or(54329);
        CoreBridge::upsert_connection(
            bridge,
            ConnectionRecord::Postgres(PostgresConnection {
                allow_mcp: false,
                mcp_hidden_tables: Vec::new(),
                mcp_until: None,
                mcp_samples_off: false,
                mcp_access: None,
                masked_columns: Default::default(),
                environment: None,
                safe_mode,
                id: id.into(),
                name: id.into(),
                host: if port.is_some() {
                    "127.0.0.1".into()
                } else {
                    host
                },
                port: port.unwrap_or(pg_port),
                database: std::env::var("ROWKERY_PG_DB").unwrap_or_else(|_| "rowkery".into()),
                username: std::env::var("ROWKERY_PG_USER").unwrap_or_else(|_| "rowkery".into()),
                ssl_mode: PostgresSslMode::Disable,
                ssl_root_cert: None,
                ssh: None,
                cloud_sql: None,
            }),
            ConnectionSecrets {
                db_password: Some(
                    std::env::var("ROWKERY_PG_PASSWORD").unwrap_or_else(|_| "rowkery".into()),
                ),
                ..Default::default()
            },
        )
        .expect("save");
        Some(())
    }

    fn pg_upstream() -> Option<String> {
        let host = std::env::var("ROWKERY_PG_HOST").ok()?;
        let port = std::env::var("ROWKERY_PG_PORT").unwrap_or_else(|_| "54329".into());
        Some(format!("{host}:{port}"))
    }

    fn int_of(v: Option<Value>) -> i64 {
        match v {
            Some(Value::Int(n)) => n,
            other => panic!("int: {other:?}"),
        }
    }

    /// A click served from the prefetch cache whose socket died: Cancel
    /// force-stops it within FORCE_STOP_AFTER (Stop all at once), the
    /// prefetch session goes with it, and the next prefetch isn't wedged.
    #[test]
    fn postgres_a_cached_click_on_a_dead_link_stops_and_frees_the_prefetcher() {
        let Some(upstream) = pg_upstream() else {
            eprintln!("skip postgres_a_cached_click_on_a_dead_link_stops (set ROWKERY_PG_HOST)");
            return;
        };
        let (_guard, _file, _path) = test_guard();
        let (port, frozen) = freezing_proxy(upstream);
        let bridge = super::CoreBridge::spawn();
        save_pg_at(&bridge, "fixb-pf-dead", Some(port), SafeMode::Off).unwrap();
        bridge.open_window("w", "fixb-pf-dead", None).expect("open");
        window_query(&bridge, "w", 1, "DROP TABLE IF EXISTS fixb_pf_dead");
        window_query(
            &bridge,
            "w",
            1,
            "CREATE TABLE fixb_pf_dead AS SELECT i AS id FROM generate_series(1, 1000) i",
        );
        let sql = "SELECT * FROM public.fixb_pf_dead ORDER BY id";

        // Cancel: the server never hears it; stopped FORCE_STOP_AFTER later.
        assert_eq!(bridge.prefetch_table("w", sql.into()), Ok(true));
        frozen.store(true, Ordering::SeqCst);
        let queue = bridge
            .run_window_query("w", 2, sql.into(), None, false)
            .expect("run");
        thread::sleep(std::time::Duration::from_millis(300));
        bridge.cancel_window_query("w", 2);
        let (cancelled, _, waited) = wait_stopped(
            &queue,
            super::FORCE_STOP_AFTER + std::time::Duration::from_secs(2),
        )
        .expect("a cancelled cached click ends");
        assert!(cancelled);
        assert!(waited < super::FORCE_STOP_AFTER + std::time::Duration::from_millis(1500));

        // The link is back: the prefetcher isn't wedged, and Stop all ends
        // the next stuck click at once.
        frozen.store(false, Ordering::SeqCst);
        assert!(!bridge.prefetched("w", sql), "its pages went with it");
        let started = std::time::Instant::now();
        assert_eq!(bridge.prefetch_table("w", sql.into()), Ok(true));
        assert!(started.elapsed() < std::time::Duration::from_secs(5));
        frozen.store(true, Ordering::SeqCst);
        let queue = bridge
            .run_window_query("w", 2, sql.into(), None, false)
            .expect("run");
        thread::sleep(std::time::Duration::from_millis(300));
        bridge.stop_all_queries();
        let (cancelled, _, waited) =
            wait_stopped(&queue, std::time::Duration::from_secs(2)).expect("stopped");
        assert!(cancelled && waited < std::time::Duration::from_secs(1));

        frozen.store(false, Ordering::SeqCst);
        let (rows, error) = window_rows(&bridge, "w", 2, sql);
        assert_eq!((rows.len(), error), (1000, None));
        assert_eq!(bridge.prefetch_table("w", sql.into()), Ok(true));
        // The proxy lost bytes (TCP wouldn't): the backends it stranded idle
        // in their transactions until idle_in_transaction_session_timeout.
        window_query(
            &bridge,
            "w",
            1,
            "SELECT pg_terminate_backend(pid) FROM pg_locks WHERE pid <> pg_backend_pid() AND relation = 'public.fixb_pf_dead'::regclass",
        );
        window_query(&bridge, "w", 1, "DROP TABLE fixb_pf_dead");
        bridge.close_window("w");
        std::env::remove_var("ROWKERY_CONFIG_DIR");
    }

    /// A page prefetched while a write in the window was still running read
    /// the rows from before it: once the write ends it is dropped, and the
    /// browse sees the new value.
    #[test]
    fn postgres_a_prefetch_during_a_write_is_not_served_after_it() {
        let (_guard, _file, _path) = test_guard();
        let bridge = super::CoreBridge::spawn();
        if save_pg_at(&bridge, "fixb-pf-write", None, SafeMode::Off).is_none() {
            eprintln!("skip postgres_a_prefetch_during_a_write (set ROWKERY_PG_HOST)");
            return;
        }
        bridge
            .open_window("w", "fixb-pf-write", None)
            .expect("open");
        window_query(&bridge, "w", 1, "DROP TABLE IF EXISTS fixb_pf_write");
        window_query(
            &bridge,
            "w",
            1,
            "CREATE TABLE fixb_pf_write AS SELECT i AS id, 'old' AS n FROM generate_series(1, 10) i",
        );
        let sql = "SELECT * FROM public.fixb_pf_write ORDER BY id";
        // A slow write: committed only when the whole batch ends.
        let write = bridge
            .run_window_query(
                "w",
                1,
                "WITH s AS (SELECT pg_sleep(1.5)) UPDATE fixb_pf_write SET n = 'new' FROM s WHERE id = 1"
                    .into(),
                None,
                false,
            )
            .expect("run");
        thread::sleep(std::time::Duration::from_millis(300));
        assert_eq!(bridge.prefetch_table("w", sql.into()), Ok(true));
        assert!(bridge.prefetched("w", sql), "cached while the write runs");
        let (_, error, _) = wait_stopped(&write, std::time::Duration::from_secs(10)).unwrap();
        let error = error.filter(|e| !e.is_empty());
        assert_eq!(error, None);
        assert!(!bridge.prefetched("w", sql), "dropped when the write ended");
        let (rows, _) = window_rows(&bridge, "w", 2, sql);
        assert_eq!(rows[0][1], Value::Text("new".into()));
        window_query(&bridge, "w", 1, "DROP TABLE fixb_pf_write");
        std::env::remove_var("ROWKERY_CONFIG_DIR");
    }

    /// Locks other backends hold on `table`.
    fn locks_on(bridge: &super::CoreBridge, window_id: &str, table: &str) -> i64 {
        int_of(
            window_query(
                bridge,
                window_id,
                98,
                &format!(
                    "SELECT count(*)::int FROM pg_locks WHERE pid <> pg_backend_pid() AND relation = 'public.{table}'::regclass"
                ),
            )
            .0,
        )
    }

    /// The prefetch transaction ends as soon as no cursor is left open (a
    /// small table's page comes back whole), and at the latest MAX_TXN_AGE
    /// after it began; closing the window ends it at once. Its locks never
    /// hold up DDL from elsewhere.
    #[test]
    fn postgres_the_prefetch_transaction_never_outlives_its_cursors() {
        let (_guard, _file, _path) = test_guard();
        let bridge = super::CoreBridge::spawn();
        if save_pg_at(&bridge, "fixb-pf-locks", None, SafeMode::Off).is_none() {
            eprintln!(
                "skip postgres_the_prefetch_transaction_never_outlives (set ROWKERY_PG_HOST)"
            );
            return;
        }
        bridge
            .open_window("w", "fixb-pf-locks", None)
            .expect("open");
        bridge
            .open_window("other", "fixb-pf-locks", None)
            .expect("open");
        for sql in [
            "DROP TABLE IF EXISTS fixb_pf_small",
            "DROP TABLE IF EXISTS fixb_pf_big",
            "CREATE TABLE fixb_pf_small AS SELECT i AS id FROM generate_series(1, 10) i",
            "CREATE TABLE fixb_pf_big AS SELECT i AS id FROM generate_series(1, 1000) i",
        ] {
            assert_eq!(window_query(&bridge, "other", 1, sql).1, None, "{sql}");
        }

        // A small table: the page is whole, the transaction already over.
        let small = "SELECT * FROM public.fixb_pf_small ORDER BY id";
        assert_eq!(bridge.prefetch_table("w", small.into()), Ok(true));
        assert_eq!(locks_on(&bridge, "other", "fixb_pf_small"), 0);
        window_query(&bridge, "other", 1, "SET lock_timeout = '2s'");
        let (_, error, ..) = window_query(&bridge, "other", 1, "DROP TABLE fixb_pf_small");
        assert_eq!(error, None, "the DROP isn't blocked");
        assert!(
            bridge.prefetched("w", small),
            "a whole page needs no session"
        );

        // A big one keeps its cursor (and lock) open, but not past the age cap.
        let big = "SELECT * FROM public.fixb_pf_big ORDER BY id";
        assert_eq!(bridge.prefetch_table("w", big.into()), Ok(true));
        assert_eq!(locks_on(&bridge, "other", "fixb_pf_big"), 1);
        thread::sleep(super::prefetch::MAX_TXN_AGE + std::time::Duration::from_millis(1500));
        assert_eq!(locks_on(&bridge, "other", "fixb_pf_big"), 0, "ended by age");
        assert!(
            !bridge.prefetched("w", big),
            "its page went with its cursor"
        );

        // Closing the window ends it at once.
        assert_eq!(bridge.prefetch_table("w", big.into()), Ok(true));
        assert_eq!(locks_on(&bridge, "other", "fixb_pf_big"), 1);
        bridge.close_window("w");
        thread::sleep(std::time::Duration::from_millis(300));
        assert_eq!(
            locks_on(&bridge, "other", "fixb_pf_big"),
            0,
            "gone with the window"
        );
        window_query(&bridge, "other", 1, "SET lock_timeout = '2s'");
        let (_, error, ..) = window_query(&bridge, "other", 1, "DROP TABLE fixb_pf_big");
        assert_eq!(error, None);
        std::env::remove_var("ROWKERY_CONFIG_DIR");
    }

    /// Incoming counts are bounded on the server (a timeout reads as
    /// unknown), and a burst of them never runs on more than one backend:
    /// each new batch cancels the one before.
    #[test]
    fn postgres_incoming_counts_are_bounded_and_one_at_a_time() {
        let (_guard, _file, _path) = test_guard();
        let bridge = Arc::new(super::CoreBridge::spawn());
        if save_pg_at(&bridge, "fixb-incoming", None, SafeMode::Off).is_none() {
            eprintln!("skip postgres_incoming_counts_are_bounded (set ROWKERY_PG_HOST)");
            return;
        }
        bridge
            .open_window("w", "fixb-incoming", None)
            .expect("open");
        for sql in [
            "DROP VIEW IF EXISTS fixb_slow_ref",
            "DROP TABLE IF EXISTS fixb_fast_ref",
            "CREATE VIEW fixb_slow_ref AS SELECT 1 AS ref FROM pg_sleep(4)",
            "CREATE TABLE fixb_fast_ref AS SELECT 1 AS ref FROM generate_series(1, 3)",
        ] {
            assert_eq!(window_query(&bridge, "w", 1, sql).1, None, "{sql}");
        }
        let look = |table: &str| FollowLookup {
            schema: "public".into(),
            table: table.into(),
            column: "ref".into(),
            value: Value::Int(1),
        };
        let started = std::time::Instant::now();
        assert_eq!(
            bridge.count_incoming("w", vec![look("fixb_slow_ref")]),
            Ok(vec![None])
        );
        assert!(
            started.elapsed() < std::time::Duration::from_millis(3500),
            "bounded, took {:?}",
            started.elapsed()
        );

        // Six at once (↑↓ through rows): one backend at a time.
        let started = std::time::Instant::now();
        let calls: Vec<_> = (0..6)
            .map(|i| {
                let bridge = bridge.clone();
                let lookups = vec![look("fixb_slow_ref"), look("fixb_slow_ref")];
                thread::sleep(std::time::Duration::from_millis(20 * i));
                thread::spawn(move || bridge.count_incoming("w", lookups))
            })
            .collect();
        let mut most = 0;
        while calls.iter().any(|c| !c.is_finished()) {
            let n = int_of(
                window_query(
                    &bridge,
                    "w",
                    9,
                    "SELECT count(*)::int FROM pg_stat_activity WHERE state = 'active' AND query LIKE '%fixb_slow_ref%' AND pid <> pg_backend_pid()",
                )
                .0,
            );
            most = most.max(n);
            assert!(started.elapsed() < std::time::Duration::from_secs(15));
            thread::sleep(std::time::Duration::from_millis(50));
        }
        for c in calls {
            assert_eq!(c.join().unwrap(), Ok(vec![None, None]));
        }
        assert!(most <= 1, "{most} backends counted at once");
        assert!(started.elapsed() < std::time::Duration::from_secs(8));

        // And Quick Look still counts what it can.
        assert_eq!(
            bridge.count_incoming("w", vec![look("fixb_fast_ref")]),
            Ok(vec![Some(3)])
        );
        window_query(&bridge, "w", 1, "DROP VIEW fixb_slow_ref");
        window_query(&bridge, "w", 1, "DROP TABLE fixb_fast_ref");
        std::env::remove_var("ROWKERY_CONFIG_DIR");
    }

    /// `count_window_rows` with a timeout, so a hang fails the test.
    fn count_within(
        bridge: &Arc<super::CoreBridge>,
        window_id: &str,
        sql: &str,
    ) -> Result<Option<i64>, String> {
        let (tx, rx) = mpsc::channel();
        let (bridge, window_id, sql) = (bridge.clone(), window_id.to_string(), sql.to_string());
        thread::spawn(move || {
            let _ = tx.send(bridge.count_window_rows(&window_id, sql));
        });
        rx.recv_timeout(std::time::Duration::from_secs(10))
            .expect("the count hung")
    }

    /// On a Read-only connection the count runs (a read), and anything that
    /// isn't a single read is refused at once instead of waiting forever.
    #[test]
    fn count_window_rows_on_read_only_never_hangs() {
        let (_guard, _file, path) = test_guard();
        let bridge = Arc::new(super::CoreBridge::spawn());
        CoreBridge::upsert_connection(
            &bridge,
            ConnectionRecord::Sqlite(SqliteConnection {
                allow_mcp: false,
                mcp_hidden_tables: Vec::new(),
                mcp_until: None,
                mcp_samples_off: false,
                mcp_access: None,
                masked_columns: Default::default(),
                environment: None,
                safe_mode: SafeMode::ReadOnly,
                id: "fixb-count-ro".into(),
                name: "ro".into(),
                path,
                sample: false,
            }),
            ConnectionSecrets::default(),
        )
        .expect("save");
        bridge
            .open_window("s", "fixb-count-ro", None)
            .expect("open");
        let mut windows = vec!["s"];
        if save_pg_at(&bridge, "fixb-count-ro-pg", None, SafeMode::ReadOnly).is_some() {
            bridge
                .open_window("p", "fixb-count-ro-pg", None)
                .expect("open");
            windows.push("p");
        }
        for w in windows {
            let table = if w == "s" { "t" } else { "pg_class" };
            assert!(
                matches!(count_within(&bridge, w, &format!("SELECT count(*) FROM {table}")), Ok(Some(n)) if n > 0),
                "{w}"
            );
            assert!(count_within(&bridge, w, "DELETE FROM t").is_err(), "{w}");
            assert!(
                count_within(&bridge, w, "SELECT count(*) FROM t; DELETE FROM t").is_err(),
                "{w}"
            );
        }
        std::env::remove_var("ROWKERY_CONFIG_DIR");
    }

    /// Saving edits waits a bounded time for a row lock (or a dead link):
    /// it stops before COMMIT, rolls back, says so, and the tab still saves
    /// once the lock is gone.
    #[test]
    fn postgres_apply_changes_times_out_before_commit() {
        let (_guard, _file, _path) = test_guard();
        let bridge = super::CoreBridge::spawn();
        if save_pg_at(&bridge, "fixb-apply-timeout", None, SafeMode::Off).is_none() {
            eprintln!("skip postgres_apply_changes_times_out_before_commit (set ROWKERY_PG_HOST)");
            return;
        }
        bridge
            .open_window("w", "fixb-apply-timeout", None)
            .expect("open");
        for sql in [
            "DROP TABLE IF EXISTS fixb_apply",
            "CREATE TABLE fixb_apply (id int PRIMARY KEY, name text)",
            "INSERT INTO fixb_apply VALUES (1, 'before')",
            // Tab 5 holds the row's lock in an open transaction.
            "BEGIN",
        ] {
            assert_eq!(window_query(&bridge, "w", 5, sql).1, None, "{sql}");
        }
        assert_eq!(
            window_query(
                &bridge,
                "w",
                5,
                "UPDATE fixb_apply SET name = 'held' WHERE id = 1"
            )
            .1,
            None
        );
        let table = edit_table(
            "public",
            "fixb_apply",
            &[("id", "int4"), ("name", "text")],
            &["id"],
        );
        let started = std::time::Instant::now();
        let out = bridge
            .apply_changes(
                "w",
                1,
                table.clone(),
                vec![update(1, "name", Value::Text("edited".into()))],
                None,
            )
            .expect("apply");
        let ApplyOutcome::RolledBack { failure, .. } = out else {
            panic!("{out:?}")
        };
        assert!(
            failure.message.contains("didn't answer"),
            "{}",
            failure.message
        );
        assert!(started.elapsed() < std::time::Duration::from_secs(8));
        assert_eq!(window_query(&bridge, "w", 5, "ROLLBACK").1, None);
        assert_eq!(
            window_query(&bridge, "w", 5, "SELECT name FROM fixb_apply WHERE id = 1").0,
            Some(Value::Text("before".into()))
        );
        let out = bridge
            .apply_changes(
                "w",
                1,
                table,
                vec![update(1, "name", Value::Text("edited".into()))],
                None,
            )
            .expect("apply");
        assert!(matches!(out, ApplyOutcome::Committed { .. }), "{out:?}");
        window_query(&bridge, "w", 5, "DROP TABLE fixb_apply");
        std::env::remove_var("ROWKERY_CONFIG_DIR");
    }

    /// A tab's open transaction survives the idle ping, and if its session
    /// dies anyway, the next statement says the transaction was lost instead
    /// of running (a COMMIT "succeeding") on a fresh session.
    #[test]
    fn postgres_a_lost_transaction_is_reported_not_papered_over() {
        let (_guard, _file, _path) = test_guard();
        let bridge = super::CoreBridge::spawn();
        if save_pg_at(&bridge, "fixb-txn", None, SafeMode::Off).is_none() {
            eprintln!("skip postgres_a_lost_transaction_is_reported (set ROWKERY_PG_HOST)");
            return;
        }
        bridge.open_window("w", "fixb-txn", None).expect("open");
        for sql in [
            "DROP TABLE IF EXISTS fixb_txn",
            "CREATE TABLE fixb_txn (id int)",
        ] {
            assert_eq!(window_query(&bridge, "w", 9, sql).1, None, "{sql}");
        }
        let run = |tab, sql: &str| window_query(&bridge, "w", tab, sql);
        let rows = |bridge: &super::CoreBridge| {
            int_of(window_query(bridge, "w", 9, "SELECT count(*)::int FROM fixb_txn").0)
        };

        // Pinged while idle in a transaction: left alone, it commits.
        assert_eq!(run(1, "BEGIN").1, None);
        assert_eq!(run(1, "INSERT INTO fixb_txn VALUES (1)").1, None);
        bridge.ping_idle_blocking("w", std::time::Duration::ZERO);
        assert_eq!(run(1, "COMMIT").1, None);
        assert_eq!(rows(&bridge), 1);

        // Its backend dies: the COMMIT that follows is refused, clearly.
        assert_eq!(run(1, "BEGIN").1, None);
        assert_eq!(run(1, "INSERT INTO fixb_txn VALUES (2)").1, None);
        let pid = int_of(run(1, "SELECT pg_backend_pid()").0);
        assert_eq!(
            run(9, &format!("SELECT pg_terminate_backend({pid})")).1,
            None
        );
        thread::sleep(std::time::Duration::from_millis(300));
        let (_, error, ..) = run(1, "COMMIT");
        let error = error.expect("the COMMIT is refused");
        assert!(error.contains("transaction"), "{error}");
        assert_eq!(rows(&bridge), 1, "the insert went with its transaction");
        // Said once; the tab works again.
        assert_eq!(int_of(run(1, "SELECT 7").0), 7);
        assert_eq!(run(9, "DROP TABLE fixb_txn").1, None);
        std::env::remove_var("ROWKERY_CONFIG_DIR");
    }

    /// Ten tabs hold the user's open transactions: the connection's cap is
    /// full and none of them may be closed, so an eleventh tab's run says it
    /// is waiting for a free connection, and Cancel ends that wait at once.
    /// Once a tab commits, its idle session is closed for the next run (it
    /// reconnects on its own next run), and the other transactions are
    /// still open.
    #[test]
    fn postgres_an_eleventh_tab_waits_for_a_free_connection() {
        let (_guard, _file, _path) = test_guard();
        let bridge = super::CoreBridge::spawn();
        let id = "postgres-cap";
        if save_test_pg(&bridge, id).is_none() {
            eprintln!(
                "skip postgres_an_eleventh_tab_waits_for_a_free_connection (set ROWKERY_PG_HOST)"
            );
            return;
        }
        bridge.open_window("w", id, None).expect("open");
        for tab in 1..=pool::MAX_SESSIONS as u64 {
            assert_eq!(window_query(&bridge, "w", tab, "BEGIN").1, None);
        }
        let started = |tab: u64| {
            assert_eq!(
                window_query(&bridge, "w", tab, "SELECT now() = statement_timestamp()").0,
                Some(Value::Bool(false)),
                "tab {tab}'s transaction is still open"
            );
        };
        started(2);

        let queue = bridge
            .run_window_query("w", 11, "SELECT 11".into(), None, false)
            .expect("run");
        let deadline = Instant::now() + Duration::from_secs(5);
        let waiting = loop {
            let events = queue.lock().unwrap().clone();
            if events.iter().any(|e| {
                matches!(
                    e,
                    CoreEvent::QueryWaiting {
                        waiting: true,
                        tab_id: 11,
                        ..
                    }
                )
            }) {
                break true;
            }
            if Instant::now() > deadline
                || events
                    .iter()
                    .any(|e| matches!(e, CoreEvent::QueryFinished { .. }))
            {
                break false;
            }
            thread::sleep(Duration::from_millis(5));
        };
        assert!(waiting, "says it waits for a free connection");
        let asked = Instant::now();
        bridge.cancel_window_query("w", 11);
        let cancelled = loop {
            let finished = queue.lock().unwrap().iter().find_map(|e| match e {
                CoreEvent::QueryFinished { cancelled, .. } => Some(*cancelled),
                _ => None,
            });
            if let Some(c) = finished {
                break c;
            }
            assert!(asked.elapsed() < Duration::from_secs(5), "the wait ends");
            thread::sleep(Duration::from_millis(5));
        };
        assert!(cancelled);
        assert!(
            asked.elapsed() < Duration::from_secs(1),
            "at once, not after the force-stop delay: {:?}",
            asked.elapsed()
        );

        // Tab 1 commits: its idle session makes room for tab 11, which
        // doesn't wait.
        assert_eq!(window_query(&bridge, "w", 1, "COMMIT").1, None);
        let queue = bridge
            .run_window_query("w", 11, "SELECT 11::int8".into(), None, false)
            .expect("run");
        let deadline = Instant::now() + Duration::from_secs(10);
        let (cell, error) = loop {
            let events = queue.lock().unwrap().clone();
            let batch = events.iter().find_map(|e| match e {
                CoreEvent::QueryBatch { batch, .. } => batch.rows.first()?.first().cloned(),
                _ => None,
            });
            if let Some(error) = events.iter().find_map(|e| match e {
                CoreEvent::QueryFinished { error, .. } => Some(error.clone()),
                _ => None,
            }) {
                assert!(
                    !events
                        .iter()
                        .any(|e| matches!(e, CoreEvent::QueryWaiting { .. })),
                    "no wait"
                );
                break (batch, error);
            }
            assert!(Instant::now() < deadline, "tab 11 ran");
            thread::sleep(Duration::from_millis(5));
        };
        assert_eq!((cell, error), (Some(Value::Int(11)), None));
        // Tab 1 reconnects on its next run (taking tab 11's idle session's
        // place); the open transactions were never touched.
        assert_eq!(window_query(&bridge, "w", 1, "SELECT 1").1, None);
        for tab in 2..=pool::MAX_SESSIONS as u64 {
            started(tab);
            assert_eq!(window_query(&bridge, "w", tab, "ROLLBACK").1, None);
        }
        std::env::remove_var("ROWKERY_CONFIG_DIR");
    }

    fn import_spec(path: &str, schema: &str, columns: &[(usize, &str)]) -> ImportSpec {
        ImportSpec {
            path: path.into(),
            schema: schema.into(),
            table: "it_import".into(),
            delimiter: ",".into(),
            header: true,
            columns: columns
                .iter()
                .map(|(field, column)| rowkery_core::import::ImportColumn {
                    field: *field,
                    column: column.to_string(),
                })
                .collect(),
            on_conflict: rowkery_core::import::OnConflict::Stop,
            empty: rowkery_core::import::EmptyCells::Null,
        }
    }

    fn quiet() -> ImportProgress {
        ImportProgress(Arc::new(|_| {}))
    }

    #[test]
    fn sqlite_import_csv_writes_once_and_read_only_refuses() {
        let (_guard, _file, path) = test_guard();
        Connection::open(&path)
            .expect("open")
            .execute_batch("CREATE TABLE it_import (id INTEGER PRIMARY KEY, name TEXT NOT NULL);")
            .expect("seed");
        let csv = std::env::temp_dir().join(format!("it-import-{}.csv", std::process::id()));
        fs::write(&csv, "id,name\n1,one\n2,two\n").expect("csv");
        let bridge = super::CoreBridge::spawn();
        for (id, safe_mode) in [("confirm", SafeMode::Confirm), ("ro", SafeMode::ReadOnly)] {
            CoreBridge::upsert_connection(
                &bridge,
                ConnectionRecord::Sqlite(SqliteConnection {
                    allow_mcp: false,
                    mcp_hidden_tables: Vec::new(),
                    mcp_until: None,
                    mcp_samples_off: false,
                    mcp_access: None,
                    masked_columns: Default::default(),
                    environment: None,
                    safe_mode,
                    id: id.into(),
                    name: id.into(),
                    path: path.clone(),
                    sample: false,
                }),
                ConnectionSecrets::default(),
            )
            .expect("save");
            bridge.open_window(id, id, None).expect("open");
        }
        let spec = import_spec(&csv.to_string_lossy(), "main", &[(0, "id"), (1, "name")]);
        let never = Arc::new(AtomicBool::new(false));
        assert_eq!(
            bridge.import_csv("ro", spec.clone(), never.clone(), quiet()),
            Ok(ImportOutcome::Refused)
        );
        // Confirm writes: the panel's Import button was the confirmation.
        let out = bridge
            .import_csv("confirm", spec.clone(), never.clone(), quiet())
            .expect("import");
        assert!(
            matches!(out, ImportOutcome::Imported { counts } if counts.inserted == 2),
            "{out:?}"
        );
        let count = |sql: &str| window_query(&bridge, "confirm", 1, sql).0;
        assert_eq!(count("SELECT count(*) FROM it_import"), Some(Value::Int(2)));
        // Again: both keys exist, Stop names the line and keeps nothing new.
        let out = bridge
            .import_csv("confirm", spec, never, quiet())
            .expect("import");
        assert!(
            matches!(&out, ImportOutcome::Failed { message } if message.starts_with("Line 2: UNIQUE")),
            "{out:?}"
        );
        let _ = fs::remove_file(&csv);
        std::env::remove_var("ROWKERY_CONFIG_DIR");
    }

    #[test]
    fn postgres_import_csv() {
        use rowkery_core::import::{EmptyCells, OnConflict};
        let Ok(host) = std::env::var("ROWKERY_PG_HOST") else {
            eprintln!("skip postgres_import_csv (set ROWKERY_PG_HOST)");
            return;
        };
        let (_guard, _file, _path) = test_guard();
        let bridge = super::CoreBridge::spawn();
        for (id, safe_mode) in [("off", SafeMode::Off), ("ro", SafeMode::ReadOnly)] {
            CoreBridge::upsert_connection(
                &bridge,
                ConnectionRecord::Postgres(PostgresConnection {
                    allow_mcp: false,
                    mcp_hidden_tables: Vec::new(),
                    mcp_until: None,
                    mcp_samples_off: false,
                    mcp_access: None,
                    masked_columns: Default::default(),
                    environment: None,
                    safe_mode,
                    id: id.into(),
                    name: id.into(),
                    host: host.clone(),
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
                }),
                ConnectionSecrets {
                    db_password: Some(
                        std::env::var("ROWKERY_PG_PASSWORD").unwrap_or_else(|_| "rowkery".into()),
                    ),
                    ..Default::default()
                },
            )
            .expect("save");
            bridge.open_window(id, id, None).expect("open");
        }
        let run = |sql: &str| window_query(&bridge, "off", 1, sql);
        for sql in [
            "DROP TABLE IF EXISTS public.it_import",
            "CREATE TABLE public.it_import (id int PRIMARY KEY, email text NOT NULL, \
             total numeric(10,2), status text DEFAULT 'pending', note text, \
             placed timestamptz DEFAULT '2026-01-01', meta jsonb)",
            "INSERT INTO public.it_import (id, email) VALUES (1, 'old@x.com')",
        ] {
            assert_eq!(run(sql).1, None, "{sql}");
        }
        let one = |sql: &str| run(sql).0;
        let dir = tempfile::tempdir().expect("dir");
        let write = |name: &str, text: &str| {
            let p = dir.path().join(name);
            fs::write(&p, text).expect("csv");
            p.to_string_lossy().to_string()
        };
        let small = write(
            "small.csv",
            "order_id,mail,amount,state,gift,placed,meta\n\
             1,new@x.com,5,paid,,2026-10-20 14:10,\n\
             2,b@x.com,7.50,,\"tab\there, back\\slash\",,\"{\"\"a\"\": 1}\"\n\
             3,c@x.com,,shipped,,,\n",
        );
        let cols = [
            (0, "id"),
            (1, "email"),
            (2, "total"),
            (3, "status"),
            (4, "note"),
            (5, "placed"),
            (6, "meta"),
        ];
        let never = Arc::new(AtomicBool::new(false));
        let import = |spec: ImportSpec| {
            bridge
                .import_csv("off", spec, never.clone(), quiet())
                .expect("import")
        };
        let mut spec = import_spec(&small, "public", &cols);

        // Read-only refuses before anything runs.
        assert_eq!(
            bridge.import_csv("ro", spec.clone(), never.clone(), quiet()),
            Ok(ImportOutcome::Refused)
        );
        // Stop: id 1 is there, so nothing is kept.
        let out = import(spec.clone());
        assert!(
            matches!(&out, ImportOutcome::Failed { message } if message.contains("Key (id)=(1) already exists")),
            "{out:?}"
        );
        assert_eq!(one("SELECT count(*) FROM it_import"), Some(Value::Int(1)));
        // Skip: two new rows; empty cells take the DEFAULT, text keeps its tab and backslash.
        spec.on_conflict = OnConflict::Skip;
        let out = import(spec.clone());
        assert!(
            matches!(out, ImportOutcome::Imported { counts } if (counts.inserted, counts.updated, counts.skipped) == (2, 0, 1)),
            "{out:?}"
        );
        assert_eq!(
            one("SELECT status || '|' || note || '|' || placed::date || '|' || (meta->>'a') FROM it_import WHERE id = 2"),
            Some(Value::Text("pending|tab\there, back\\slash|2026-01-01|1".into()))
        );
        assert_eq!(
            one("SELECT total IS NULL AND note IS NULL FROM it_import WHERE id = 3"),
            Some(Value::Bool(true))
        );
        // Update: all three exist; Empty text gives note ''.
        spec.on_conflict = OnConflict::Update;
        spec.empty = EmptyCells::Text;
        let out = import(spec.clone());
        assert!(
            matches!(out, ImportOutcome::Imported { counts } if (counts.inserted, counts.updated, counts.skipped) == (0, 3, 0)),
            "{out:?}"
        );
        assert_eq!(
            one("SELECT email || '|' || total || '|' || note FROM it_import WHERE id = 1"),
            Some(Value::Text("new@x.com|5.00|".into()))
        );

        // A value the server refuses names the file's line and the column.
        let bad = write(
            "bad.csv",
            "id,email,placed\n10,a@x.com,2026-01-01\n11,\"multi\nline\",soon\n",
        );
        let out = import(import_spec(
            &bad,
            "public",
            &[(0, "id"), (1, "email"), (2, "placed")],
        ));
        assert!(
            matches!(&out, ImportOutcome::Failed { message } if message.starts_with("Line 3, placed: invalid input syntax for type timestamp with time zone")),
            "{out:?}"
        );
        // A value the grid's rules refuse is caught before it is sent.
        let bad = write("bad2.csv", "id,email,total\n12,a@x.com,n/a\n");
        let out = import(import_spec(
            &bad,
            "public",
            &[(0, "id"), (1, "email"), (2, "total")],
        ));
        assert_eq!(
            out,
            ImportOutcome::Failed {
                message: "Line 2, total: 'n/a' isn't a number".into()
            }
        );
        assert_eq!(one("SELECT count(*) FROM it_import"), Some(Value::Int(3)));

        // The tab's open transaction is untouched: the import runs beside it.
        assert_eq!(run("BEGIN").1, None);
        assert_eq!(
            run("INSERT INTO it_import (id, email) VALUES (500, 'mine')").1,
            None
        );
        let side = write("side.csv", "id,email\n600,side@x.com\n");
        let out = import(import_spec(&side, "public", &[(0, "id"), (1, "email")]));
        assert!(matches!(out, ImportOutcome::Imported { .. }), "{out:?}");
        assert_eq!(run("ROLLBACK").1, None);
        assert_eq!(
            one("SELECT count(*) FROM it_import WHERE id IN (500, 600)"),
            Some(Value::Int(1))
        );

        // 100k rows, timed; then a cancel rolls the same file back.
        let mut big = String::from("id,email,total,status,note,placed,meta\n");
        for i in 0..100_000 {
            big.push_str(&format!(
                "{},user{i}@mail.com,{}.{:02},{},\"note, {i}\",2026-10-{:02} 14:{:02},\n",
                1000 + i,
                i % 500,
                i % 100,
                ["pending", "paid", "shipped"][i % 3],
                1 + i % 28,
                i % 60
            ));
        }
        let big = write("big.csv", &big);
        let start = Instant::now();
        let out = import(import_spec(&big, "public", &cols));
        let took = start.elapsed();
        assert!(
            matches!(out, ImportOutcome::Imported { counts } if counts.inserted == 100_000),
            "{out:?}"
        );
        eprintln!(
            "postgres_import_csv: 100,000 rows in {} ms",
            took.as_millis()
        );
        assert_eq!(run("DELETE FROM it_import WHERE id >= 1000").1, None);
        let cancel = Arc::new(AtomicBool::new(false));
        let seen = Arc::new(AtomicU64::new(0));
        let (c, s) = (cancel.clone(), seen.clone());
        let out = bridge
            .import_csv(
                "off",
                import_spec(&big, "public", &cols),
                cancel,
                ImportProgress(Arc::new(move |n| {
                    s.store(n, Ordering::SeqCst);
                    c.store(true, Ordering::SeqCst);
                })),
            )
            .expect("import");
        assert_eq!(out, ImportOutcome::Cancelled);
        assert!(seen.load(Ordering::SeqCst) > 0);
        assert_eq!(
            one("SELECT count(*) FROM it_import WHERE id >= 1000"),
            Some(Value::Int(0))
        );

        // Update with empty cells as NULL: the row keeps its values.
        let blank = write("blank.csv", "id,email,total,status,note\n3,,,,\n");
        let mut keep = import_spec(
            &blank,
            "public",
            &[
                (0, "id"),
                (1, "email"),
                (2, "total"),
                (3, "status"),
                (4, "note"),
            ],
        );
        keep.on_conflict = OnConflict::Update;
        let out = import(keep);
        assert!(
            matches!(out, ImportOutcome::Imported { counts } if (counts.inserted, counts.updated) == (0, 1)),
            "{out:?}"
        );
        assert_eq!(
            one("SELECT email || '|' || status FROM it_import WHERE id = 3"),
            Some(Value::Text("c@x.com|shipped".into()))
        );

        // Waiting on a lock a tab holds: Cancel ends the wait.
        assert_eq!(run("BEGIN").1, None);
        assert_eq!(run("LOCK TABLE it_import IN ACCESS EXCLUSIVE MODE").1, None);
        let cancel = Arc::new(AtomicBool::new(false));
        let later = cancel.clone();
        let timer = std::thread::spawn(move || {
            std::thread::sleep(Duration::from_millis(400));
            later.store(true, Ordering::SeqCst);
        });
        let out = bridge
            .import_csv(
                "off",
                import_spec(&side, "public", &[(0, "id"), (1, "email")]),
                cancel,
                quiet(),
            )
            .expect("import");
        timer.join().unwrap();
        assert_eq!(out, ImportOutcome::Cancelled);
        assert_eq!(run("ROLLBACK").1, None);

        // Identity columns: BY DEFAULT fills an empty cell; ALWAYS can't be imported into.
        for sql in [
            "DROP TABLE IF EXISTS public.it_ident",
            "CREATE TABLE public.it_ident (id int GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY, \
             name text, n int GENERATED ALWAYS AS IDENTITY)",
        ] {
            assert_eq!(run(sql).1, None, "{sql}");
        }
        let ident = write("ident.csv", "id,name,n\n,a,\n5,b,\n");
        let ident_spec = |columns: &[(usize, &str)]| ImportSpec {
            table: "it_ident".into(),
            ..import_spec(&ident, "public", columns)
        };
        let out = import(ident_spec(&[(0, "id"), (1, "name")]));
        assert!(matches!(out, ImportOutcome::Imported { .. }), "{out:?}");
        assert_eq!(
            one("SELECT string_agg(id::text, ',' ORDER BY id) FROM it_ident"),
            Some(Value::Text("1,5".into()))
        );
        let out = import(ident_spec(&[(1, "name"), (2, "n")]));
        assert_eq!(
            out,
            ImportOutcome::Failed {
                message: "n is filled in by the database, so it can't be imported. Skip it.".into()
            }
        );
        assert_eq!(run("DROP TABLE public.it_ident").1, None);
        assert_eq!(run("DROP TABLE public.it_import").1, None);
        std::env::remove_var("ROWKERY_CONFIG_DIR");
    }
}
