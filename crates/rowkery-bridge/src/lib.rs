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
    session_probe_after_cancel, session_probe_txn, session_query_cursor, session_query_stream_with,
    session_server_version, session_table_indexes, session_take_cancel_aborted,
    session_take_warnings, session_test, CancelVia, DatabaseInfo, PostgresSession, StreamOptions,
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
use rowkery_core::sql_file::{
    open_sqlite, run_postgres, run_sqlite, Progress, RunOptions, RunReport, Scan,
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
    /// Run SQL file: the file `scan` read, on a session (or SQLite
    /// connection) of its own. Cancelled like a tab, as [`IMPORT_TAB`].
    RunSqlFile {
        window_id: String,
        path: std::path::PathBuf,
        scan: Box<Scan>,
        options: RunOptions,
        confirmed: bool,
        on_progress: ProgressSink,
        respond_to: oneshot::Sender<Result<RunReport, String>>,
    },
    /// ⌘K "Stop all queries": every run in every window, at once.
    StopAllQueries,
    /// Whether any tab's session may hold the user's open transaction.
    HoldsTransaction {
        respond_to: oneshot::Sender<bool>,
    },
    /// Each window's query tabs that may hold the user's open transaction.
    OpenTransactions {
        respond_to: oneshot::Sender<Vec<(String, u64)>>,
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
#[derive(Debug, Clone, Default)]
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
    /// The server's warnings, one per line.
    warning: Option<String>,
    /// Stopped without the server's answer (`force_stop`).
    forced: bool,
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
    /// Told once the Postgres cancel request has gone out (or given up), so
    /// the run can ask what it left before parking its session.
    sent: Arc<tokio::sync::Notify>,
    /// The tag of the Postgres session the run is on, for a cancel from
    /// another session after a force stop.
    tag: Option<String>,
}

/// The tab id a window's Run SQL file runs under, for cancelling it.
pub const IMPORT_TAB: u64 = u64::MAX - 2;

/// Where a SQL file run's progress goes.
pub struct ProgressSink(pub Box<dyn Fn(&Progress) + Send + Sync>);

impl std::fmt::Debug for ProgressSink {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("ProgressSink")
    }
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
    // Only this run's warnings reach its result.
    session_take_warnings(session);
    let cancel_aborted = session_take_cancel_aborted(session);
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
    let warnings = session_take_warnings(session);
    let result = result
        .map(|o| QueryOutcome {
            warning: (!warnings.is_empty()).then(|| warnings.join("\n")),
            ..o
        })
        .map_err(|mut failure| {
            // 25P02: the transaction is aborted. Say what aborted it.
            if cancel_aborted && failure.sqlstate.as_deref() == Some("25P02") {
                failure.message.push_str(CANCEL_ABORTED);
            }
            failure
        });
    (result, fwd.had_result_set)
}

/// After "current transaction is aborted" when a cancel aborted it.
const CANCEL_ABORTED: &str = " (The last Cancel reached the server after your statement had finished, and aborted the transaction. ROLLBACK to go on.)";

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
    let stopped_generation = pooled.generation;
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
            // `out` holds the tab's slot until the session is given back.
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
            // Cancel targets the backend of the session this run is on.
            let handle = CancelHandle::Postgres {
                token: session.cancel_token.clone(),
                tls: session.cancel_via.clone(),
            };
            if let Ok(mut state) = interrupt_slot.lock() {
                state.tag = Some(session.tag().to_string());
            }
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
                drop(out);
                return;
            }
            // A statement that may open a transaction: from now on the tab
            // counts as holding one, and a force stop marks it lost.
            if matches!(&work, PgWork::Query { sql, .. } if !reads_only(sql)) {
                out.may_open_transaction();
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
            // backend: the tab's next run waits (its slot stays out) until
            // the cancel has gone and the server said what the statement
            // left, so a transaction open in the session is kept.
            if cancelled {
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
                drop(out);
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
                // Stopped while waiting for a free connection: nothing hung.
                let (waited, tag) = stopped_slot
                    .lock()
                    .map(|mut s| (std::mem::take(&mut s.waiting), s.tag.take()))
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
                let (pool, window_id) = stopped_pool;
                // The server keeps running what the closed socket sent: ask
                // it to stop from another session of the window's own.
                if let Some(tag) = tag {
                    let target = sessions::Target {
                        pool: pool.clone(),
                        window_id: window_id.clone(),
                        generation: stopped_generation,
                        connection_id: stopped_connection.clone(),
                        config: stopped_config.clone(),
                    };
                    tokio::spawn(async move {
                        let cancel = sessions::cancel_stopped(target, tag);
                        let _ = tokio::time::timeout(STOPPED_CANCEL_WITHIN, cancel).await;
                    });
                }
                // The socket that hung may not be the only dead one: check
                // the window's parked sessions now, so the next run doesn't
                // find another (the prefetch session goes rather than waits).
                if let Some(f) = pool.lock().ok().and_then(|p| p.existing_prefetcher(&window_id)) {
                    f.drop_if_idle(Duration::ZERO);
                }
                pool::ping_idle(&pool, &window_id, Duration::ZERO, stopped_connection, stopped_config)
                    .await;
            }
        }
    });
}

/// How long the cancel sent after a force stop may take, from another
/// session (which may need a new connection).
const STOPPED_CANCEL_WITHIN: Duration = Duration::from_secs(15);
/// How long after the cancel went out the server gets to deliver it, before
/// the run asks what its statement left.
const CANCEL_SETTLE: Duration = Duration::from_millis(50);

/// After a cancelled run: once the cancel has gone out, asks the session
/// what the statement left and parks it, so a transaction open in it (even
/// one the cancel failed: the user still has to roll it back) stays with
/// the tab. A session that doesn't answer, or whose socket is gone, is
/// dropped, and the tab's next statement says its transaction was lost.
async fn keep_after_cancel(
    pool: &SharedPool,
    window_id: &str,
    tab_id: u64,
    generation: u64,
    mut session: PostgresSession,
    sent: &tokio::sync::Notify,
) {
    let _ = tokio::time::timeout(FORCE_STOP_AFTER, sent.notified()).await;
    tokio::time::sleep(CANCEL_SETTLE).await;
    if session.is_closed() {
        pool::drop_lost(pool, window_id, Slot::Tab(tab_id), session);
        return;
    }
    let probed = tokio::time::timeout(
        pool::PROBE_TIMEOUT * 2,
        session_probe_after_cancel(&mut session, pool::PROBE_TIMEOUT),
    )
    .await;
    if matches!(probed, Ok(TxnState::None | TxnState::Users)) {
        pool::give_back(pool, window_id, Slot::Tab(tab_id), generation, session);
    } else {
        pool::drop_lost(pool, window_id, Slot::Tab(tab_id), session);
    }
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
                warning: outcome.warning,
                forced: outcome.forced,
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

/// Why a window wasn't re-pointed.
pub const REPOINT_IN_TXN: &str = "A query tab in this window has a transaction open, and switching would roll it back. COMMIT or ROLLBACK it first.";

/// Why safe mode didn't change.
pub const SAFE_MODE_IN_TXN: &str = "A query tab on this connection has a transaction open, and changing safe mode would roll it back. COMMIT or ROLLBACK it first.";

/// The window's query tabs that may hold the user's open transaction, which
/// re-pointing the window or a new safe mode would roll back. SQLite runs
/// each query on a connection of its own, so no transaction outlives a run.
fn window_transactions(state: &CoreState, window_id: &str) -> Vec<u64> {
    match state.windows.get(window_id) {
        Some(WindowTarget::Postgres { .. }) => state
            .pool
            .lock()
            .map(|p| p.open_transactions(window_id))
            .unwrap_or_default(),
        Some(WindowTarget::Sqlite { .. }) | None => Vec::new(),
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
                let sent = guard.sent.clone();
                runtime.spawn(async move {
                    // The cancel itself can hang on a dead tunnel; it gets
                    // the same time as the run.
                    let _ =
                        tokio::time::timeout(FORCE_STOP_AFTER, cancel_with_token(token, tls)).await;
                    sent.notify_one();
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

struct SqlFileRun {
    path: std::path::PathBuf,
    scan: Box<Scan>,
    options: RunOptions,
    confirmed: bool,
    on_progress: ProgressSink,
}

/// Run SQL file. Safe mode first: read-only connections refuse, and under
/// Confirm writes the panel's Run is the confirmation. One at a time per
/// window; a window's queries keep running beside it.
fn run_sql_file(
    state: &mut CoreState,
    window_id: String,
    run: SqlFileRun,
    respond_to: oneshot::Sender<Result<RunReport, String>>,
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
        let _ = respond_to.send(Err(
            "This connection is read-only, so a SQL file can't run on it.".into(),
        ));
        return;
    }
    if safe_mode == SafeMode::Confirm && run.scan.writes && !run.confirmed {
        let _ = respond_to.send(Err(
            "This connection confirms writes: press Run on the file's summary to run it.".into(),
        ));
        return;
    }
    let key = (window_id.clone(), IMPORT_TAB);
    if state
        .window_interrupts
        .get(&key)
        .is_some_and(|slot| Arc::strong_count(slot) > 1)
    {
        let _ = respond_to.send(Err("A SQL file is already running in this window.".into()));
        return;
    }
    let slot: CancelSlot = Arc::default();
    state.window_interrupts.insert(key, slot.clone());
    invalidate_prefetch(&state.pool, &window_id, &state.runtime);
    let SqlFileRun {
        path,
        scan,
        options,
        confirmed: _,
        on_progress,
    } = run;
    match target {
        WindowTarget::Sqlite { path: db, .. } => {
            thread::spawn(move || {
                let report = with_catch(|| {
                    let conn = open_sqlite(&db)?;
                    if !arm_cancel(&slot, CancelHandle::Sqlite(conn.get_interrupt_handle())) {
                        return Ok(RunReport {
                            cancelled: true,
                            ..RunReport::default()
                        });
                    }
                    let report = run_sqlite(
                        &conn,
                        &path,
                        &scan,
                        options,
                        || cancel_requested(&slot),
                        |p| (on_progress.0)(p),
                    );
                    disarm_cancel(&slot);
                    Ok(report)
                })
                .and_then(|r| r);
                let _ = respond_to.send(report);
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
                let stop = slot.lock().map(|s| s.stop.clone()).ok();
                let committing = Arc::new(AtomicBool::new(false));
                let sent = committing.clone();
                let on_progress = move |p: &rowkery_core::sql_file::Progress| {
                    sent.store(p.committing, Ordering::SeqCst);
                    (on_progress.0)(p)
                };
                let work = async {
                    let Lease { session, .. } = pool::lease(
                        &pool,
                        &window_id,
                        Slot::SqlFile,
                        generation,
                        connection_id,
                        config,
                    )
                    .await
                    .map_err(driver_error_message)?;
                    let handle = CancelHandle::Postgres {
                        token: session.cancel_token.clone(),
                        tls: session.cancel_via.clone(),
                    };
                    if !arm_cancel(&slot, handle) {
                        return Ok(RunReport {
                            cancelled: true,
                            ..RunReport::default()
                        });
                    }
                    let report = run_postgres(
                        &session,
                        &path,
                        &scan,
                        options,
                        || cancel_requested(&slot),
                        on_progress,
                    )
                    .await;
                    disarm_cancel(&slot);
                    // Never parked: the file's SETs stay on the session.
                    drop(session);
                    Ok(report)
                };
                let report = match stop {
                    Some(stop) => tokio::select! {
                        report = work => report,
                        _ = stop.notified() => {
                            // Stopped during COMMIT, the server may have saved it.
                            let committing = committing.load(Ordering::SeqCst);
                            Ok(RunReport {
                                cancelled: true,
                                rolled_back: options.whole_file && !committing,
                                failed: Some(rowkery_core::sql_file::Failure {
                                    line: None,
                                    statement: String::new(),
                                    message: if committing {
                                        "The server didn't answer during COMMIT, so Rowkery closed the connection. The file may or may not be saved: reload the schema to check."
                                    } else {
                                        "The server didn't answer the cancel, so Rowkery closed the connection. The server rolls back what was still open when it notices."
                                    }
                                    .into(),
                                }),
                                ..RunReport::default()
                            })
                        }
                    },
                    None => work.await,
                };
                invalidate_prefetch(&pool, &window_id, &runtime);
                let _ = respond_to.send(report);
            });
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
    // A test stands in for a cancel request that never reaches the server.
    #[cfg(test)]
    let skip = tests::NO_TOKEN_CANCEL.load(std::sync::atomic::Ordering::SeqCst);
    #[cfg(not(test))]
    let skip = false;
    if !skip {
        request_cancel(runtime, slot);
    }
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
            let event = 'event: {
                // Open windows follow a changed safe mode on their next run.
                // Warm Postgres sessions were opened under the old mode
                // (read-only or not), so those windows start fresh ones:
                // never while a tab's transaction is open in one, which
                // that would roll back.
                let (id, mode) = (connection.id().to_string(), connection.safe_mode());
                let changes_mode = state
                    .config
                    .connections
                    .iter()
                    .any(|c| c.id() == id && c.safe_mode() != mode);
                // One lock for the check and the resets: nothing opens a
                // transaction in between.
                let mut pool = state.pool.lock().ok();
                let held = state.windows.iter().any(|(w, target)| {
                    matches!(target, WindowTarget::Postgres { connection_id, .. } if *connection_id == id)
                        && pool
                            .as_ref()
                            .is_some_and(|p| !p.open_transactions(w).is_empty())
                });
                if changes_mode && held {
                    break 'event Event::Error(SAFE_MODE_IN_TXN.into());
                }
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
                            if let Some(pool) = pool.as_mut() {
                                stale.extend(pool.reset_window(window_id).1);
                            }
                        }
                        _ => {}
                    }
                }
                // The sessions close outside the lock.
                drop(pool);
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
            // Re-pointing (another connection or database, Reconnect) starts
            // the window's sessions afresh: never over a tab's transaction.
            if state.windows.contains_key(&window_id)
                && !window_transactions(state, &window_id).is_empty()
            {
                let _ = respond_to.send(Err(REPOINT_IN_TXN.into()));
                return;
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
        Command::OpenTransactions { respond_to } => {
            let mut open: Vec<(String, u64)> = state
                .windows
                .keys()
                .flat_map(|w| {
                    let tabs = window_transactions(state, w);
                    tabs.into_iter().map(move |t| (w.clone(), t))
                })
                .collect();
            open.sort();
            let _ = respond_to.send(open);
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
        Command::RunSqlFile {
            window_id,
            path,
            scan,
            options,
            confirmed,
            on_progress,
            respond_to,
        } => run_sql_file(
            state,
            window_id,
            SqlFileRun {
                path,
                scan,
                options,
                confirmed,
                on_progress,
            },
            respond_to,
        ),
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

    /// Runs the SQL file at `path`, which `scan` read, and blocks until it
    /// ends. Cancel with `cancel_window_query(window, IMPORT_TAB)`.
    pub fn run_sql_file(
        &self,
        window_id: &str,
        path: std::path::PathBuf,
        scan: Scan,
        options: RunOptions,
        confirmed: bool,
        on_progress: ProgressSink,
    ) -> Result<RunReport, String> {
        self.send_command(|respond_to| Command::RunSqlFile {
            window_id: window_id.to_string(),
            path,
            scan: Box::new(scan),
            options,
            confirmed,
            on_progress,
            respond_to,
        })
        .unwrap_or_else(|| Err("Rowkery's core stopped".into()))
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

    /// Each window's query tabs (window id, tab id) whose session may hold
    /// the user's open transaction.
    pub fn open_transactions(&self) -> Vec<(String, u64)> {
        self.send_command(|respond_to| Command::OpenTransactions { respond_to })
            .unwrap_or_default()
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
mod tests;
