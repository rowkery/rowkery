use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::Duration;

use rowkery_bridge::{CoreBridge, EventSink, HeldLock, SessionRow, StopKind, StopOutcome};
use rowkery_core::config::{ConfigNotice, ThemePreference};
use rowkery_core::connections::ConnectionRecord;
use rowkery_core::db::postgres::DatabaseInfo;
use rowkery_core::db::{
    table_browse_query, BrowseOptions, BrowseOrder, Column, EngineKind, SchemaCatalog,
    TableIndexes, Value,
};
use rowkery_core::edits::{Change, EditTable};
use rowkery_core::health::HealthReport;
use rowkery_core::safety::{plain_read, Dialect, SafetyHold};
use rowkery_core::secrets::ConnectionSecrets;
use rowkery_core::CoreEvent;
use serde::Serialize;
use tauri::ipc::{Channel, InvokeResponseBody};
use tauri::{AppHandle, Manager, State};

mod done_notify;
#[cfg(feature = "e2e")]
mod e2e;
mod mcp_connect;
mod open_link;
mod sql_file;
pub mod timings;
mod updates;
use timings::{ProofEnv, Timings};

#[derive(Debug, Clone, Serialize)]
pub struct ConnectionListDto {
    pub connections: Vec<ConnectionRecord>,
}

/// One JSON message on a query's channel. A run sends `columns` once, then its
/// rows as binary frames (rowkery-core `frames.rs`), then `done`, which is the
/// only completion signal.
#[derive(Debug, Clone, Serialize)]
#[serde(tag = "t", rename_all = "snake_case")]
pub enum Frame {
    Columns {
        query_id: u64,
        columns: Vec<Column>,
    },
    /// Every connection the saved connection may hold is busy: the run waits
    /// for one (`waiting` false once it has one).
    Waiting {
        query_id: u64,
        waiting: bool,
    },
    Done(Box<DoneFrame>),
}

#[derive(Debug, Clone, Serialize)]
pub struct DoneFrame {
    pub query_id: u64,
    /// `ok`, `error`, `cancelled` or `held`.
    pub status: &'static str,
    pub row_count: u64,
    /// Rows a statement without a result set changed.
    pub affected_rows: Option<u64>,
    /// Measured in core around the whole stream.
    pub elapsed_ms: u64,
    /// From the start of the run to the first row.
    pub first_row_ms: Option<u64>,
    /// Rows frames sent before this one, and their bytes.
    pub frames: u32,
    pub bytes: u64,
    pub error: Option<String>,
    /// Five characters (`42P01`) when the server refused the statement.
    pub sqlstate: Option<String>,
    /// 1-based character offset of the error in the statement.
    pub error_position: Option<u32>,
    /// Set when safe mode stopped the query before it ran.
    pub hold: Option<SafetyHold>,
    /// The rows are a cursor page; `more` while it has rows for `fetch_more`.
    pub paged: bool,
    pub more: bool,
    /// The run reached the most rows a tab holds (`MAX_TAB_ROWS`) and left
    /// the rest out.
    pub capped: bool,
    /// The server's warnings, one per line.
    pub warning: Option<String>,
    /// Stopped without the server's answer: it may still finish the statement.
    pub forced: bool,
}

/// Rows frames are sized to arrive in about this long, from the bytes/ms the
/// webview measured on earlier frames.
const FRAME_TRANSFER_MS: f64 = 8.0;
const FRAME_MIN_BYTES: usize = 16 * 1024;
const FRAME_DEFAULT_BYTES: usize = 64 * 1024;
/// WebView2 copies channel payloads through a slower path than WebKit.
#[cfg(target_os = "windows")]
const FRAME_MAX_BYTES: usize = 256 * 1024;
#[cfg(not(target_os = "windows"))]
const FRAME_MAX_BYTES: usize = 1024 * 1024;
/// Rows wait at most this long for more to join their frame.
const FRAME_MAX_WAIT: Duration = Duration::from_millis(16);

fn frame_target_bytes(hint_bytes_per_ms: Option<f64>) -> usize {
    match hint_bytes_per_ms {
        Some(rate) if rate.is_finite() && rate > 0.0 => {
            ((rate * FRAME_TRANSFER_MS) as usize).clamp(FRAME_MIN_BYTES, FRAME_MAX_BYTES)
        }
        _ => FRAME_DEFAULT_BYTES,
    }
}

#[derive(Default)]
struct SinkState {
    query_id: u64,
    columns: Vec<Column>,
    pending: Vec<Vec<Value>>,
    /// A timer will flush `pending`.
    timer_armed: bool,
    frames: u32,
    bytes: u64,
    /// From the last frame, to size the next.
    bytes_per_row: Option<f64>,
    /// The column profiles' sample, until the frame that completes it.
    profiler: Option<rowkery_core::profile::Profiler>,
}

/// Forwards one run's core events to its webview channel, from the worker
/// that produced them: the first rows go at once, later batches gather into
/// frames of `target_bytes` (or whatever waited 16 ms), and done flushes the
/// rest. Nothing waits for the whole result.
struct ChannelSink {
    channel: Channel<InvokeResponseBody>,
    state: Arc<Mutex<SinkState>>,
    target_bytes: usize,
    /// Profiles the first rows (`profile.rs`); a next page appends to a
    /// result that has them already.
    profile: bool,
}

impl ChannelSink {
    fn new(channel: Channel<InvokeResponseBody>, target_bytes: usize) -> Self {
        Self {
            channel,
            state: Arc::default(),
            target_bytes,
            profile: true,
        }
    }

    fn without_profile(mut self) -> Self {
        self.profile = false;
        self
    }

    fn send_json(channel: &Channel<InvokeResponseBody>, frame: &Frame) {
        if let Ok(json) = serde_json::to_string(frame) {
            let _ = channel.send(InvokeResponseBody::Json(json));
        }
    }

    /// Encodes and sends what's pending. Called with the state locked, so frames
    /// leave in order.
    fn flush(channel: &Channel<InvokeResponseBody>, st: &mut SinkState, last: bool) {
        // Done with no rows left to send still owes the profile of the ones sent.
        let owes_profile = last && st.profiler.as_ref().is_some_and(|p| p.rows() > 0);
        if st.pending.is_empty() && !owes_profile {
            return;
        }
        let rows = std::mem::take(&mut st.pending);
        let sent_at_ms = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_secs_f64() * 1000.0)
            .unwrap_or(0.0);
        let mut frame = rowkery_core::frames::encode_rows(
            st.query_id,
            st.frames,
            sent_at_ms,
            last,
            &st.columns,
            &rows,
        );
        if let Some(profiler) = &mut st.profiler {
            profiler.add_rows(&rows);
            // This frame completes the sample (or the result): it carries the profiles.
            if profiler.is_full() || last {
                let profiler = st.profiler.take().unwrap();
                if profiler.rows() > 0 {
                    rowkery_core::frames::attach_profile(&mut frame, &profiler.finish());
                }
            }
        }
        if !rows.is_empty() {
            st.bytes_per_row = Some(frame.len() as f64 / rows.len() as f64);
        }
        st.frames += 1;
        st.bytes += frame.len() as u64;
        let _ = channel.send(InvokeResponseBody::Raw(frame));
    }

    fn arm_timer(&self) {
        let state = self.state.clone();
        let channel = self.channel.clone();
        thread::spawn(move || {
            thread::sleep(FRAME_MAX_WAIT);
            if let Ok(mut st) = state.lock() {
                st.timer_armed = false;
                ChannelSink::flush(&channel, &mut st, false);
            }
        });
    }
}

impl EventSink for ChannelSink {
    fn push(&self, event: CoreEvent) {
        let Ok(mut st) = self.state.lock() else {
            return;
        };
        match event {
            CoreEvent::QueryBatch {
                query_id,
                batch,
                first,
                ..
            } => {
                if first {
                    st.query_id = query_id;
                    st.columns = batch.columns.clone();
                    st.profiler = self
                        .profile
                        .then(|| rowkery_core::profile::Profiler::new(&batch.columns));
                    Self::send_json(
                        &self.channel,
                        &Frame::Columns {
                            query_id,
                            columns: batch.columns,
                        },
                    );
                }
                if batch.rows.is_empty() {
                    return;
                }
                st.pending.extend(batch.rows);
                // The first rows go at once: time to first row beats frame size.
                let full = match st.bytes_per_row {
                    None => true,
                    Some(per_row) => st.pending.len() as f64 * per_row >= self.target_bytes as f64,
                };
                if full {
                    Self::flush(&self.channel, &mut st, false);
                } else if !st.timer_armed {
                    st.timer_armed = true;
                    self.arm_timer();
                }
            }
            CoreEvent::QueryFinished {
                query_id,
                row_count,
                rows_affected,
                elapsed_ms,
                error,
                cancelled,
                detail,
                ..
            } => {
                Self::flush(&self.channel, &mut st, true);
                let done = DoneFrame {
                    query_id,
                    status: if cancelled {
                        "cancelled"
                    } else if error.is_some() {
                        "error"
                    } else {
                        "ok"
                    },
                    row_count,
                    affected_rows: rows_affected,
                    elapsed_ms,
                    first_row_ms: detail.first_row_ms,
                    frames: st.frames,
                    bytes: st.bytes,
                    error,
                    sqlstate: detail.sqlstate,
                    error_position: detail.error_position,
                    hold: None,
                    paged: detail.paged,
                    more: detail.more,
                    capped: detail.capped,
                    warning: detail.warning,
                    forced: detail.forced,
                };
                Self::send_json(&self.channel, &Frame::Done(Box::new(done)));
            }
            CoreEvent::QueryWaiting {
                query_id, waiting, ..
            } => Self::send_json(&self.channel, &Frame::Waiting { query_id, waiting }),
            CoreEvent::QueryHeld { query_id, hold, .. } => {
                let done = DoneFrame {
                    query_id,
                    status: "held",
                    row_count: 0,
                    affected_rows: None,
                    elapsed_ms: 0,
                    first_row_ms: None,
                    frames: 0,
                    bytes: 0,
                    error: None,
                    sqlstate: None,
                    error_position: None,
                    hold: Some(hold),
                    paged: false,
                    more: false,
                    capped: false,
                    warning: None,
                    forced: false,
                };
                Self::send_json(&self.channel, &Frame::Done(Box::new(done)));
            }
            _ => {}
        }
    }
}

// Connection list, save and delete read the config and touch the keychain,
// which can block (or prompt) for a while: they run on the blocking pool,
// never the main thread.
#[tauri::command]
async fn list_connections(app: AppHandle) -> Result<ConnectionListDto, String> {
    on_blocking_pool(app, |bridge| ConnectionListDto {
        connections: bridge.list_connections(),
    })
    .await
}

#[tauri::command]
async fn save_connection(
    app: AppHandle,
    connection: ConnectionRecord,
    secrets: ConnectionSecrets,
) -> Result<(), String> {
    let secrets = with_staged_key(secrets)?;
    on_blocking_pool(app, move |bridge| {
        bridge
            .upsert_connection(connection, secrets)
            .map_err(|e| e.to_string())
    })
    .await?
}

#[tauri::command]
async fn delete_connection(
    app: AppHandle,
    id: String,
    keep_secrets: Option<bool>,
) -> Result<(), String> {
    on_blocking_pool(app, move |bridge| {
        bridge
            .remove_connection(&id, keep_secrets.unwrap_or(false))
            .map_err(|e| e.to_string())
    })
    .await?
}

/// "Found on this Mac": Postgres answering on loopback (a TCP connect only).
#[tauri::command]
async fn probe_local_servers() -> Result<Vec<rowkery_core::local::LocalServer>, String> {
    tauri::async_runtime::spawn_blocking(rowkery_core::local::local_servers)
        .await
        .map_err(|e| e.to_string())
}

/// ⌘V outside a text field when the webview fired no paste event: the
/// clipboard's text, read here because the webview only reads it inside a
/// paste. Empty when it holds no text.
#[tauri::command]
fn read_clipboard_text(app: AppHandle) -> String {
    use tauri_plugin_clipboard_manager::ClipboardExt;
    app.clipboard().read_text().unwrap_or_default()
}

/// ⌘K with a pasted or typed SQLite path: whether a file is there (`~/`
/// expanded as the driver does), so a missing one saves no connection.
#[tauri::command]
async fn sqlite_file_exists(path: String) -> bool {
    tauri::async_runtime::spawn_blocking(move || {
        rowkery_core::connections::expand_home(&path).is_file()
    })
    .await
    .unwrap_or(false)
}

/// ⌘K "Open the sample database" (`reset` false) and "Reset the sample
/// database" (`reset` true). Returns its record, put back if it was deleted.
#[tauri::command]
async fn open_sample(app: AppHandle, reset: bool) -> Result<ConnectionRecord, String> {
    on_blocking_pool(app, move |bridge| bridge.open_sample(reset)).await?
}

/// Removes the keychain entries of a connection deleted with `keep_secrets`
/// (its Undo expired, or a pending delete from before a relaunch).
#[tauri::command]
async fn forget_connection_secrets(app: AppHandle, id: String) -> Result<(), String> {
    on_blocking_pool(app, move |bridge| bridge.forget_connection_secrets(&id)).await
}

/// Runs a blocking bridge call on the blocking pool. Sync commands run on the
/// main thread, so a slow connect or query would freeze the window and block
/// `cancel_query`; the bridge's blocking calls also panic on a runtime worker.
async fn on_blocking_pool<T, F>(app: AppHandle, work: F) -> Result<T, String>
where
    T: Send + 'static,
    F: FnOnce(&CoreBridge) -> T + Send + 'static,
{
    tauri::async_runtime::spawn_blocking(move || work(&app.state::<CoreBridge>()))
        .await
        .map_err(|e| e.to_string())
}

#[derive(Serialize)]
struct WindowDto {
    database: String,
    catalog: SchemaCatalog,
    server_version: Option<String>,
    elapsed_ms: u64,
    /// From the disk cache: a `catalog-update` event with `open_seq` follows.
    cached: bool,
    open_seq: u64,
}

/// Points a window at a connection (and database, else the saved one) and
/// returns its schema. Calling it again on the same window switches it.
#[tauri::command]
async fn open_window(
    app: AppHandle,
    window_id: String,
    connection_id: String,
    database: Option<String>,
) -> Result<WindowDto, String> {
    on_blocking_pool(app, move |bridge| {
        bridge
            .open_window(&window_id, &connection_id, database)
            .map(|w| WindowDto {
                database: w.database,
                catalog: w.catalog,
                server_version: w.server_version,
                elapsed_ms: w.elapsed_ms,
                cached: w.cached,
                open_seq: w.open_seq,
            })
    })
    .await?
}

#[tauri::command]
fn close_window(bridge: State<'_, CoreBridge>, window_id: String) {
    bridge.close_window(&window_id);
}

#[tauri::command]
async fn list_databases(app: AppHandle, window_id: String) -> Result<Vec<DatabaseInfo>, String> {
    on_blocking_pool(app, move |bridge| bridge.list_databases(&window_id)).await?
}

/// Index details for tables whose catalog entry deferred them (Postgres).
#[tauri::command]
async fn table_indexes(
    app: AppHandle,
    window_id: String,
    schema: String,
    tables: Vec<String>,
) -> Result<Vec<TableIndexes>, String> {
    on_blocking_pool(app, move |bridge| {
        bridge.table_indexes(&window_id, &schema, tables)
    })
    .await?
}

/// The Sessions tab: the server's other sessions on the window's database.
#[tauri::command]
async fn list_sessions(app: AppHandle, window_id: String) -> Result<Vec<SessionRow>, String> {
    on_blocking_pool(app, move |bridge| bridge.sessions(&window_id)).await?
}

/// The Health tab: what will hurt soon on the window's database.
#[tauri::command]
async fn database_health(app: AppHandle, window_id: String) -> Result<HealthReport, String> {
    on_blocking_pool(app, move |bridge| bridge.health(&window_id)).await?
}

/// The table locks one session holds.
#[tauri::command]
async fn session_locks(
    app: AppHandle,
    window_id: String,
    pid: i32,
) -> Result<Vec<HeldLock>, String> {
    on_blocking_pool(app, move |bridge| bridge.session_locks(&window_id, pid)).await?
}

/// Cancels a session's query or ends it, through safe mode.
#[tauri::command]
async fn stop_session(
    app: AppHandle,
    window_id: String,
    pid: i32,
    kind: StopKind,
    confirmed: bool,
) -> Result<StopOutcome, String> {
    on_blocking_pool(app, move |bridge| {
        bridge.stop_session(&window_id, pid, kind, confirmed)
    })
    .await?
}

/// Reloads a window's schema after DDL, keeping its query tabs' sessions.
#[tauri::command]
async fn reload_window_schema(app: AppHandle, window_id: String) -> Result<SchemaCatalog, String> {
    on_blocking_pool(app, move |bridge| bridge.reload_window_schema(&window_id)).await?
}

#[derive(Serialize)]
struct ProbeDto {
    ok: bool,
    message: String,
    elapsed_ms: u64,
}

/// Service account keys picked in the form, by the id the webview holds in
/// their place: the key itself never goes to the webview, and Save takes it
/// from here into the keychain.
fn staged_keys() -> &'static Mutex<HashMap<String, String>> {
    static KEYS: std::sync::OnceLock<Mutex<HashMap<String, String>>> = std::sync::OnceLock::new();
    KEYS.get_or_init(Default::default)
}

fn staged_key(id: &str) -> Result<String, String> {
    staged_keys()
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .get(id)
        .cloned()
        .ok_or_else(|| "Choose the service account key file again".to_string())
}

/// `secrets` with a picked key's id swapped for the key.
fn with_staged_key(mut secrets: ConnectionSecrets) -> Result<ConnectionSecrets, String> {
    if let Some(id) = secrets.gcp_key.take().filter(|k| !k.is_empty()) {
        secrets.gcp_key = Some(staged_key(&id)?);
    }
    Ok(secrets)
}

/// The service account key a Cloud SQL form uses: the one picked in the
/// form (`key`, a staged id), else the one saved for `connection_id`.
async fn cloudsql_key(
    key: Option<String>,
    connection_id: Option<String>,
) -> Result<Option<String>, String> {
    if let Some(id) = key.filter(|k| !k.trim().is_empty()) {
        return staged_key(&id).map(Some);
    }
    let Some(id) = connection_id else {
        return Ok(None);
    };
    tauri::async_runtime::spawn_blocking(move || {
        rowkery_core::secrets::get_secret(&id, rowkery_core::SecretKind::GcpKey)
    })
    .await
    .map_err(|e| e.to_string())?
    .map_err(|e| e.to_string())
}

/// The Google account a Cloud SQL connection signs in with: the service
/// account key (`credentials` "key"), else the gcloud login (null when this
/// computer has none).
#[tauri::command]
async fn cloudsql_account(
    credentials: String,
    key: Option<String>,
    connection_id: Option<String>,
) -> Result<Option<rowkery_core::cloudsql::CloudSqlAccount>, String> {
    let key = if credentials == "key" {
        match cloudsql_key(key, connection_id).await? {
            Some(key) => Some(key),
            None => return Ok(None),
        }
    } else {
        None
    };
    rowkery_core::cloudsql::account(key.as_deref())
        .await
        .map_err(|e| e.to_string())
}

/// Every Cloud SQL instance the account can see, for the instance picker.
/// `project` (the one the form names) is searched when Google won't list
/// the account's projects.
#[tauri::command]
async fn cloudsql_instances(
    credentials: String,
    key: Option<String>,
    connection_id: Option<String>,
    project: Option<String>,
) -> Result<rowkery_core::cloudsql::InstanceList, String> {
    let key = if credentials == "key" {
        cloudsql_key(key, connection_id)
            .await?
            .ok_or("No service account key yet")?
    } else {
        String::new()
    };
    rowkery_core::cloudsql::instances(
        Some(key.as_str()).filter(|k| !k.is_empty()),
        project.as_deref(),
    )
    .await
    .map_err(|e| e.to_string())
}

/// Asks for a service account key file (the native dialog: only a file the
/// user picked is read) and keeps it until Save puts it in the keychain.
/// Refuses anything that isn't a service account key. `None` when the
/// dialog was dismissed.
#[tauri::command]
async fn cloudsql_key_file(app: AppHandle) -> Result<Option<CloudSqlKeyFile>, String> {
    use std::sync::atomic::{AtomicU64, Ordering};
    use tauri_plugin_dialog::DialogExt;
    let json = tauri::async_runtime::spawn_blocking(move || {
        let Some(path) = app
            .dialog()
            .file()
            .add_filter("Service account key", &["json"])
            .blocking_pick_file()
            .and_then(|p| p.into_path().ok())
        else {
            return Ok(None);
        };
        let meta = std::fs::metadata(&path).map_err(|e| e.to_string())?;
        if meta.len() > 64 * 1024 {
            return Err("That file is too big to be a service account key".to_string());
        }
        std::fs::read_to_string(&path)
            .map(Some)
            .map_err(|e| e.to_string())
    })
    .await
    .map_err(|e| e.to_string())??;
    let Some(json) = json else {
        return Ok(None);
    };
    let account = rowkery_core::cloudsql::account(Some(&json))
        .await
        .map_err(|e| e.to_string())?
        .ok_or("Not a service account key")?;
    static NEXT: AtomicU64 = AtomicU64::new(1);
    let key = format!("picked-key-{}", NEXT.fetch_add(1, Ordering::Relaxed));
    staged_keys()
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .insert(key.clone(), json);
    Ok(Some(CloudSqlKeyFile { key, account }))
}

#[derive(serde::Serialize)]
struct CloudSqlKeyFile {
    /// Stands for the key in the form, and in its Save.
    key: String,
    account: rowkery_core::cloudsql::CloudSqlAccount,
}

/// Tests a connection from the New Connection sheet without saving it.
#[tauri::command]
async fn probe_connection(
    app: AppHandle,
    connection: ConnectionRecord,
    secrets: ConnectionSecrets,
) -> Result<ProbeDto, String> {
    let secrets = with_staged_key(secrets)?;
    on_blocking_pool(app, move |_| {
        let outcome = rowkery_bridge::probe_connection_blocking(connection, secrets);
        ProbeDto {
            ok: outcome.ok,
            message: outcome.message,
            elapsed_ms: outcome.elapsed_ms,
        }
    })
    .await
}

#[tauri::command]
#[allow(clippy::too_many_arguments)]
async fn run_query(
    app: AppHandle,
    window_id: String,
    tab_id: u64,
    sql: String,
    confirmed: Option<bool>,
    page: Option<u32>,
    hint_bytes_per_ms: Option<f64>,
    on_frame: Channel<InvokeResponseBody>,
) -> Result<u64, String> {
    on_blocking_pool(app, move |bridge| {
        let sink = Arc::new(ChannelSink::new(
            on_frame,
            frame_target_bytes(hint_bytes_per_ms),
        ));
        bridge.run_window_query_paged(
            &window_id,
            tab_id,
            sql,
            None,
            page,
            confirmed.unwrap_or(false),
            sink,
        )
    })
    .await?
}

/// ⌘E: the statement's plan as a short tree with its slowest step and one
/// hint (`CoreBridge::explain`). `timed` runs it with ANALYZE; a write goes
/// through safe mode and is rolled back.
#[tauri::command]
async fn explain_statement(
    app: AppHandle,
    window_id: String,
    tab_id: u64,
    sql: String,
    timed: bool,
    confirmed: Option<bool>,
) -> Result<rowkery_bridge::ExplainOutcome, String> {
    on_blocking_pool(app, move |bridge| {
        bridge.explain(&window_id, tab_id, sql, timed, confirmed.unwrap_or(false))
    })
    .await?
}

/// The next `rows` (0: the rest) of the tab's paged query, streamed like
/// `run_query`; the webview appends them.
#[tauri::command]
async fn fetch_more(
    app: AppHandle,
    window_id: String,
    tab_id: u64,
    rows: u32,
    hint_bytes_per_ms: Option<f64>,
    on_frame: Channel<InvokeResponseBody>,
) -> Result<u64, String> {
    on_blocking_pool(app, move |bridge| {
        let sink = Arc::new(
            ChannelSink::new(on_frame, frame_target_bytes(hint_bytes_per_ms)).without_profile(),
        );
        bridge.fetch_more_to(&window_id, tab_id, rows, sink)
    })
    .await?
}

/// What an export or a copy-all says while it runs (JSON on its channel).
#[derive(Debug, Clone, Serialize)]
#[serde(tag = "t", rename_all = "snake_case")]
enum ExportFrame {
    /// Rows written so far, about every 100 ms.
    Progress { rows: u64 },
    Done {
        rows: u64,
        error: Option<String>,
        cancelled: bool,
        /// Where the file went (exports).
        path: Option<String>,
    },
}

type ExportDone<W> = Box<dyn FnOnce(W) -> Result<(), String> + Send>;

/// Cancels the run that feeds a sink (its tab's query).
type ExportStop = Box<dyn FnOnce() + Send>;

/// Writes a run's batches straight into an `ExportWriter` (a file, or memory
/// for the clipboard), reporting progress; nothing reaches the webview but
/// counts.
struct ExportSink<W: std::io::Write + Send> {
    channel: Channel<InvokeResponseBody>,
    state: Mutex<ExportState<W>>,
    path: Option<String>,
}

struct ExportState<W: std::io::Write + Send> {
    writer: Option<rowkery_core::export::ExportWriter<W>>,
    error: Option<String>,
    last_progress: std::time::Instant,
    done: Option<ExportDone<W>>,
    /// Called once, on the first write that fails (Copy all past its cap,
    /// a full disk): nothing more can be written, so the run stops instead
    /// of reading to its end with the count frozen.
    stop: Option<ExportStop>,
}

impl<W: std::io::Write + Send> ExportSink<W> {
    fn new(
        channel: Channel<InvokeResponseBody>,
        writer: rowkery_core::export::ExportWriter<W>,
        path: Option<String>,
        done: ExportDone<W>,
        stop: ExportStop,
    ) -> Self {
        Self {
            channel,
            path,
            state: Mutex::new(ExportState {
                writer: Some(writer),
                error: None,
                last_progress: std::time::Instant::now(),
                done: Some(done),
                stop: Some(stop),
            }),
        }
    }

    /// A write's failure: a file's names the file; the clipboard's (Copy all
    /// results, shown under "Couldn't copy") is the cause alone.
    fn write_error(&self, e: std::io::Error) -> String {
        match self.path {
            Some(_) => format!("Couldn't write the file: {e}"),
            None => e.to_string(),
        }
    }

    fn send(&self, frame: &ExportFrame) {
        if let Ok(json) = serde_json::to_string(frame) {
            let _ = self.channel.send(InvokeResponseBody::Json(json));
        }
    }
}

impl<W: std::io::Write + Send> EventSink for ExportSink<W> {
    fn push(&self, event: CoreEvent) {
        let Ok(mut st) = self.state.lock() else {
            return;
        };
        match event {
            CoreEvent::QueryBatch { batch, .. } => {
                if st.error.is_some() {
                    return;
                }
                let Some(writer) = st.writer.as_mut() else {
                    return;
                };
                let written = writer
                    .columns(&batch.columns)
                    .and_then(|_| batch.rows.iter().try_for_each(|r| writer.row(r)));
                let rows = writer.rows_written();
                if let Err(e) = written {
                    st.error = Some(self.write_error(e));
                    if let Some(stop) = st.stop.take() {
                        stop();
                    }
                } else if st.last_progress.elapsed() >= Duration::from_millis(100) {
                    st.last_progress = std::time::Instant::now();
                    self.send(&ExportFrame::Progress { rows });
                }
            }
            CoreEvent::QueryFinished {
                error, cancelled, ..
            } => {
                let rows = st.writer.as_ref().map_or(0, |w| w.rows_written());
                // A run this sink stopped ends cancelled, but it failed: say
                // why, not "cancelled".
                let cancelled = cancelled && st.error.is_none();
                let mut error = st.error.take().or(error.filter(|_| !cancelled));
                if let (Some(writer), Some(done)) = (st.writer.take(), st.done.take()) {
                    if error.is_none() && !cancelled {
                        if let Err(e) = writer
                            .finish()
                            .map_err(|e| self.write_error(e))
                            .and_then(done)
                        {
                            error = Some(e);
                        }
                    }
                }
                self.send(&ExportFrame::Done {
                    rows,
                    error,
                    cancelled,
                    path: self.path.clone(),
                });
            }
            _ => {}
        }
    }
}

/// An export sink's `stop`: cancels the tab's run (it only queues the
/// cancel, so a sink may call it while core is pushing to it).
fn stop_tab_run(app: &AppHandle, window_id: &str, tab_id: u64) -> ExportStop {
    let app = app.clone();
    let window_id = window_id.to_string();
    Box::new(move || {
        app.state::<CoreBridge>()
            .cancel_window_query(&window_id, tab_id)
    })
}

/// The save dialog's suggested name, without characters a file name can't hold.
fn export_file_name(name: &str) -> String {
    let clean: String = name
        .chars()
        .map(|c| if "/\\:*?\"<>|".contains(c) { '_' } else { c })
        .collect();
    format!("{}.csv", clean.trim().trim_matches('.'))
}

/// Choose file… in the connection sheet: the native open dialog filtered to
/// `kind` ("sqlite", "pem", "key" or "sql"). `None` when dismissed.
#[tauri::command]
async fn choose_file(app: AppHandle, kind: String) -> Result<Option<String>, String> {
    use tauri_plugin_dialog::DialogExt;
    let picked = tauri::async_runtime::spawn_blocking(move || {
        let dialog = app.dialog().file();
        let dialog = match kind.as_str() {
            "sqlite" => dialog.add_filter("SQLite database", &["sqlite", "db", "sqlite3"]),
            "pem" => dialog.add_filter("Certificate", &["pem", "crt", "cer"]),
            // `.dump` too, so a pg_dump archive gets its pg_restore hint.
            "sql" => dialog.add_filter("SQL file", &["sql", "dump"]),
            _ => dialog,
        };
        dialog.blocking_pick_file()
    })
    .await
    .map_err(|e| e.to_string())?;
    Ok(picked
        .and_then(|p| p.into_path().ok())
        .map(|p| p.to_string_lossy().to_string()))
}

/// Export…: asks where (the native save dialog; CSV, TSV, JSON or SQL
/// INSERT by the extension chosen), then runs `sql` whole in the tab and
/// writes it there, streaming progress on `on_frame`. `None` when the
/// dialog was dismissed. `schema` / `table` name the INSERT target.
#[tauri::command]
#[allow(clippy::too_many_arguments)]
async fn export_results(
    app: AppHandle,
    window_id: String,
    tab_id: u64,
    sql: String,
    engine: String,
    schema: String,
    table: String,
    on_frame: Channel<InvokeResponseBody>,
) -> Result<Option<u64>, String> {
    use tauri_plugin_dialog::DialogExt;
    let dialog_app = app.clone();
    let file_name = export_file_name(&table);
    let picked = tauri::async_runtime::spawn_blocking(move || {
        dialog_app
            .dialog()
            .file()
            .set_file_name(file_name)
            .add_filter("CSV", &["csv"])
            .add_filter("TSV", &["tsv"])
            .add_filter("JSON", &["json"])
            .add_filter("SQL INSERT", &["sql"])
            .blocking_save_file()
    })
    .await
    .map_err(|e| e.to_string())?;
    let Some(path) = picked.and_then(|p| p.into_path().ok()) else {
        return Ok(None);
    };
    let path_text = path.to_string_lossy().to_string();
    let kind = if engine == "postgres" {
        EngineKind::Postgres
    } else {
        EngineKind::Sqlite
    };
    let format = rowkery_core::export::ExportFormat::from_path(&path_text, kind, &schema, &table);
    let file =
        std::fs::File::create(&path).map_err(|e| format!("Couldn't create the file: {e}"))?;
    let writer = rowkery_core::export::ExportWriter::new(std::io::BufWriter::new(file), format);
    let sink = Arc::new(ExportSink::new(
        on_frame,
        writer,
        Some(path_text),
        Box::new(|_| Ok(())),
        stop_tab_run(&app, &window_id, tab_id),
    ));
    on_blocking_pool(app, move |bridge| {
        bridge.run_window_export_to(&window_id, tab_id, sql, sink)
    })
    .await?
    .map(Some)
}

/// The most Copy all results holds in memory (100 MiB). Past it the copy
/// stops its run and says to export instead: the text is held twice at the
/// end (here and in the clipboard), and a pasteboard that size helps no one.
const CLIPBOARD_MAX_BYTES: usize = 100 * 1024 * 1024;

/// Copy all results' text as it is written, refusing to grow past
/// [`CLIPBOARD_MAX_BYTES`].
#[derive(Default)]
struct ClipboardBuf(Vec<u8>);

impl std::io::Write for ClipboardBuf {
    fn write(&mut self, buf: &[u8]) -> std::io::Result<usize> {
        if self.0.len() + buf.len() > CLIPBOARD_MAX_BYTES {
            return Err(std::io::Error::other(format!(
                "The result is over {} MiB; use Export… to write it to a file",
                CLIPBOARD_MAX_BYTES / (1024 * 1024)
            )));
        }
        self.0.extend_from_slice(buf);
        Ok(buf.len())
    }

    fn flush(&mut self) -> std::io::Result<()> {
        Ok(())
    }
}

/// Copy all results: runs `sql` whole in the tab into memory as CSV (or TSV
/// for `format: "tsv"`) and puts it on the clipboard from here, since the
/// webview's clipboard only writes inside the user's gesture.
#[tauri::command]
async fn copy_all_results(
    app: AppHandle,
    window_id: String,
    tab_id: u64,
    sql: String,
    format: String,
    on_frame: Channel<InvokeResponseBody>,
) -> Result<u64, String> {
    use tauri_plugin_clipboard_manager::ClipboardExt;
    let format = if format == "tsv" {
        rowkery_core::export::ExportFormat::Tsv
    } else {
        rowkery_core::export::ExportFormat::Csv
    };
    let writer = rowkery_core::export::ExportWriter::new(ClipboardBuf::default(), format);
    let clip = app.clone();
    let stop = stop_tab_run(&app, &window_id, tab_id);
    let sink = Arc::new(ExportSink::new(
        on_frame,
        writer,
        None,
        Box::new(move |buf: ClipboardBuf| {
            // Valid UTF-8 (the writer only writes `str`s) becomes the
            // clipboard's text in place, without a second copy.
            let mut text = String::from_utf8(buf.0)
                .unwrap_or_else(|e| String::from_utf8_lossy(e.as_bytes()).into_owned());
            text.truncate(text.trim_end_matches('\n').len());
            clip.clipboard()
                .write_text(text)
                .map_err(|e| format!("Couldn't copy: {e}"))
        }),
        stop,
    ));
    on_blocking_pool(app, move |bridge| {
        bridge.run_window_export_to(&window_id, tab_id, sql, sink)
    })
    .await?
}

/// Row counts for a SQLite window's tables, asked for after its catalog
/// is shown (introspection no longer counts; empty for Postgres).
#[tauri::command]
async fn table_counts(
    app: AppHandle,
    window_id: String,
) -> Result<Vec<rowkery_core::db::sqlite::TableCount>, String> {
    on_blocking_pool(app, move |bridge| bridge.table_counts(&window_id)).await?
}

/// The window is created hidden (`visible: false`) and shown here once React
/// has committed its first render, so launch never shows an empty
/// or half-styled window. `setup` shows it anyway after `SHOW_ANYWAY`.
#[tauri::command]
fn app_ready(app: AppHandle) {
    show_main_window(&app);
}

/// Shows the main window if the page never says it is ready (a crash before
/// the first render).
const SHOW_ANYWAY: Duration = Duration::from_secs(3);

/// How long a closing window stays hidden before it is destroyed (macOS).
#[cfg(target_os = "macos")]
const CLOSE_AFTER_HIDE: Duration = Duration::from_millis(150);

/// macOS: hides the window first and destroys it a few frames later. WebKit
/// (macOS 27.2, with an accessibility client such as VoiceOver running) can
/// crash in `ScrollingTree::takePendingScrollUpdates` when a display refresh
/// it queued lands after the webview was torn down; hidden, the page has
/// nothing left to draw by then.
#[cfg(target_os = "macos")]
fn close_after_hiding(window: &tauri::Window) {
    let _ = window.hide();
    let window = window.clone();
    thread::spawn(move || {
        thread::sleep(CLOSE_AFTER_HIDE);
        let target = window.clone();
        let _ = window.run_on_main_thread(move || {
            let _ = target.destroy();
        });
    });
}

fn show_main_window(app: &AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        if !window.is_visible().unwrap_or(false) {
            let _ = window.show();
            let _ = window.set_focus();
        }
    }
}

/// The Paper sheet behind the webview: the native window's background, so a
/// resize or the first frame never shows another colour (App.css `--bg`).
fn paper_background(dark: bool) -> tauri::window::Color {
    if dark {
        tauri::window::Color(0x1a, 0x1a, 0x1a, 0xff)
    } else {
        tauri::window::Color(0xff, 0xff, 0xff, 0xff)
    }
}

fn theme_preference(name: &str) -> ThemePreference {
    match name {
        "light" => ThemePreference::Light,
        "dark" => ThemePreference::Dark,
        _ => ThemePreference::System,
    }
}

/// Gives the window the appearance (native controls) and Paper background
/// of `pref`; on System both follow the system's appearance.
fn apply_window_theme(window: &tauri::WebviewWindow, pref: ThemePreference) {
    let explicit = match pref {
        ThemePreference::Light => Some(tauri::Theme::Light),
        ThemePreference::Dark => Some(tauri::Theme::Dark),
        ThemePreference::System => None,
    };
    let _ = window.set_theme(explicit);
    let dark = match explicit {
        Some(t) => t == tauri::Theme::Dark,
        None => window.theme().is_ok_and(|t| t == tauri::Theme::Dark),
    };
    let _ = window.set_background_color(Some(paper_background(dark)));
}

/// The appearance setting (`auto`, `light`, `dark`), from config.json.
#[tauri::command]
fn get_theme_preference(bridge: State<'_, CoreBridge>) -> &'static str {
    match bridge.get_config_blocking().map(|c| c.theme) {
        Some(ThemePreference::Light) => "light",
        Some(ThemePreference::Dark) => "dark",
        _ => "auto",
    }
}

/// Applies the appearance to the window and, with `save`, keeps it in
/// config.json, where the next launch reads it before the window exists.
#[tauri::command]
async fn set_theme_preference(app: AppHandle, theme: String, save: bool) -> Result<(), String> {
    let pref = theme_preference(&theme);
    if let Some(window) = app.get_webview_window("main") {
        apply_window_theme(&window, pref);
    }
    if save {
        on_blocking_pool(app, move |bridge| {
            bridge.save_theme(pref).map_err(|e| e.to_string())
        })
        .await??;
    }
    Ok(())
}

/// Why a connection failed, for the schema panel: the error class, a
/// one-line cause and the sheet field to mark (`rowkery_core::explain`).
#[tauri::command]
fn explain_connect_error(
    error: String,
    host: String,
    port: u16,
    username: String,
    ssh_host: Option<String>,
    cloud_sql: Option<String>,
) -> rowkery_core::explain::ConnectExplanation {
    rowkery_core::explain::explain_connect_error(
        &error,
        &rowkery_core::explain::Target {
            host: &host,
            port,
            username: &username,
            ssh_host: ssh_host.as_deref(),
            cloud_sql: cloud_sql.as_deref(),
        },
    )
}

/// Cancels the tab's query, if any, and closes its connection.
#[tauri::command]
fn close_query_tab(bridge: State<'_, CoreBridge>, window_id: String, tab_id: u64) {
    bridge.close_window_tab(&window_id, tab_id);
}

/// Cancel; a second call (Force stop) stops the run without the server.
#[tauri::command]
fn cancel_query(bridge: State<'_, CoreBridge>, window_id: String, tab_id: u64) {
    bridge.cancel_window_query(&window_id, tab_id);
}

/// ⌘K "Stop all queries": every run in every window, at once.
#[tauri::command]
fn stop_all_queries(bridge: State<'_, CoreBridge>) {
    bridge.stop_all_queries();
}

/// What a quit or a restart would cut short (an open transaction, a write,
/// a commit, an import, a SQL file run): an Automatic update waits for none
/// (updates.ts).
#[tauri::command]
async fn busy_work(app: AppHandle) -> Result<rowkery_bridge::BusyWork, String> {
    on_blocking_pool(app, |bridge| bridge.busy_work()).await
}

/// The app menu's Quit, in place of the native one (which ends the app
/// before anything can ask): it goes through [`ask_before_quit`].
#[cfg(target_os = "macos")]
const QUIT_ITEM: &str = "rowkery-quit";

/// A quit dialog is showing: another ⌘Q or close waits for its answer.
static ASKING_TO_QUIT: AtomicBool = AtomicBool::new(false);

/// Quitting (or closing the window, which quits, or restarting into an
/// update; `verb` names which) while work would be lost asks first, in one
/// native dialog naming it; `then` quits. A request made while the dialog
/// is up is dropped. The Dock's Quit, logging out and an AppleScript quit
/// don't come through here: tao has no applicationShouldTerminate hook.
fn ask_before_quit(app: &AppHandle, verb: &'static str, then: impl FnOnce() + Send + 'static) {
    use tauri_plugin_dialog::{DialogExt, MessageDialogButtons, MessageDialogKind};
    if ASKING_TO_QUIT.swap(true, Ordering::SeqCst) {
        return;
    }
    let app = app.clone();
    // The core thread answers off the main thread, which the dialog needs free.
    thread::spawn(move || {
        let Some(warning) = app.state::<CoreBridge>().busy_work().quit_warning() else {
            ASKING_TO_QUIT.store(false, Ordering::SeqCst);
            return then();
        };
        app.dialog()
            .message(warning)
            .title(format!("{verb} Rowkery?"))
            .kind(MessageDialogKind::Warning)
            .buttons(MessageDialogButtons::OkCancelCustom(
                format!("{verb} Anyway"),
                "Cancel".into(),
            ))
            .show(move |quit| {
                ASKING_TO_QUIT.store(false, Ordering::SeqCst);
                if quit {
                    then();
                }
            });
    });
}

#[derive(Debug, Serialize)]
struct OpenTransactionDto {
    window_id: String,
    tab_id: u64,
}

/// The query tabs whose session may hold the user's open transaction:
/// re-pointing their window would roll it back, so the webview refuses.
#[tauri::command]
async fn open_transactions(app: AppHandle) -> Result<Vec<OpenTransactionDto>, String> {
    on_blocking_pool(app, |bridge| {
        bridge
            .open_transactions()
            .into_iter()
            .map(|(window_id, tab_id)| OpenTransactionDto { window_id, tab_id })
            .collect()
    })
    .await
}

#[derive(Debug, Serialize)]
struct BrowseStartedDto {
    query_id: u64,
    /// What it runs (Open in query tab, history), built in core.
    sql: String,
}

/// Browses a table in one call: builds its `SELECT` (filter, sort, page) and
/// runs it in the tab, streaming frames like `run_query`.
#[tauri::command]
#[allow(clippy::too_many_arguments)]
async fn browse_table(
    app: AppHandle,
    window_id: String,
    tab_id: u64,
    engine: String,
    schema: String,
    table: String,
    columns: Option<Vec<String>>,
    filter: Option<String>,
    order: Option<Vec<BrowseOrder>>,
    limit: Option<u32>,
    offset: Option<u32>,
    key: Option<Vec<String>>,
    after: Option<HashMap<String, Value>>,
    hint_bytes_per_ms: Option<f64>,
    on_frame: Channel<InvokeResponseBody>,
) -> Result<BrowseStartedDto, String> {
    // A next page (keyset or OFFSET) joins rows that have their profiles.
    let next_page = after.is_some() || offset.is_some_and(|o| o > 0);
    let sql = browse_table_sql(
        engine, schema, table, columns, filter, order, limit, offset, key, after,
    );
    on_blocking_pool(app, move |bridge| {
        let sink = ChannelSink::new(on_frame, frame_target_bytes(hint_bytes_per_ms));
        let sink = Arc::new(if next_page {
            sink.without_profile()
        } else {
            sink
        });
        let query_id =
            bridge.run_window_query_to(&window_id, tab_id, sql.clone(), None, false, sink)?;
        Ok(BrowseStartedDto { query_id, sql })
    })
    .await?
}

/// Hover prefetch (the connection's switch is on): the first page of the
/// browse a click on this row would run, read on the window's prefetch
/// session. Takes `browse_table`'s arguments, so the SQL matches the click's
/// exactly; resolves true once cached.
#[tauri::command]
#[allow(clippy::too_many_arguments)]
async fn prefetch_table(
    app: AppHandle,
    window_id: String,
    engine: String,
    schema: String,
    table: String,
    columns: Option<Vec<String>>,
    filter: Option<String>,
    order: Option<Vec<BrowseOrder>>,
    limit: Option<u32>,
    key: Option<Vec<String>>,
) -> Result<bool, String> {
    let sql = browse_table_sql(
        engine, schema, table, columns, filter, order, limit, None, key, None,
    );
    on_blocking_pool(app, move |bridge| bridge.prefetch_table(&window_id, sql)).await?
}

/// The pointer left the row: cancel the prefetch in flight.
#[tauri::command]
fn cancel_prefetch(bridge: State<'_, CoreBridge>, window_id: String) {
    bridge.cancel_prefetch(&window_id);
}

/// The webview's saved UI state (windows, tabs, SQL, widths, pins, history),
/// as it last saved it; `null` on a first launch.
#[tauri::command]
fn load_ui_state(bridge: State<'_, CoreBridge>) -> Option<serde_json::Value> {
    bridge.ui_state()
}

/// What this launch couldn't read in config.json and where the file as it
/// was is kept, for one toast; `null` when all was read, and after the
/// first call.
#[tauri::command]
fn take_config_notice(bridge: State<'_, CoreBridge>) -> Option<ConfigNotice> {
    bridge.take_config_notice()
}

/// Replaces the webview's UI state. Returns at once: a writer thread puts it
/// in config.json within 500 ms (temp file + rename). Returns an earlier
/// save's failure for a toast, at most once a minute; `null` otherwise.
#[tauri::command]
fn save_ui_state(bridge: State<'_, CoreBridge>, ui: serde_json::Value) -> Option<ConfigNotice> {
    bridge.save_ui_state(ui)
}

/// How this launch's window was created: `native` when the system draws the
/// title bar and buttons (Linux / Windows with `native_decorations` on).
struct WindowChrome {
    native: bool,
    /// config.json's `native_decorations`, kept here so asking never waits
    /// on the core thread.
    saved: std::sync::atomic::AtomicBool,
}

#[derive(Debug, Clone, Serialize)]
struct WindowChromeDto {
    /// This window has system decorations (the page draws no controls).
    native: bool,
    /// What config.json says, i.e. what the next launch will use.
    saved: bool,
}

#[tauri::command]
fn window_chrome(chrome: State<'_, WindowChrome>) -> WindowChromeDto {
    WindowChromeDto {
        native: chrome.native,
        saved: chrome.saved.load(std::sync::atomic::Ordering::Relaxed),
    }
}

/// ⌘K "Use system window controls": saved now, applied on the next launch.
#[tauri::command]
async fn set_native_decorations(app: AppHandle, on: bool) -> Result<(), String> {
    let handle = app.clone();
    on_blocking_pool(app, move |bridge| {
        bridge
            .save_native_decorations(on)
            .map_err(|e| e.to_string())
    })
    .await??;
    handle
        .state::<WindowChrome>()
        .saved
        .store(on, std::sync::atomic::Ordering::Relaxed);
    Ok(())
}

/// The webview regained focus or became visible: check the window's sessions
/// that sat idle a minute or more and replace dead ones in the background, so
/// the first query after a laptop sleep doesn't wait on a dead socket.
#[tauri::command]
fn ping_idle(bridge: State<'_, CoreBridge>, window_id: String) {
    bridge.ping_idle(&window_id);
}

/// Quick Look: the row each foreign key points at, read on the window's own
/// Quick Look session in one round trip.
#[tauri::command]
async fn follow_keys(
    app: AppHandle,
    window_id: String,
    lookups: Vec<rowkery_bridge::FollowLookup>,
) -> Result<Vec<Option<rowkery_bridge::FollowRow>>, String> {
    on_blocking_pool(app, move |bridge| bridge.follow_keys(&window_id, lookups)).await?
}

/// Quick Look's Incoming: rows referencing this one, counted per referencing
/// table (bounded, `INCOMING_CAP + 1` means more), on the same session.
#[tauri::command]
async fn count_incoming(
    app: AppHandle,
    window_id: String,
    lookups: Vec<rowkery_bridge::FollowLookup>,
) -> Result<Vec<Option<i64>>, String> {
    on_blocking_pool(app, move |bridge| {
        bridge.count_incoming(&window_id, lookups)
    })
    .await?
}

/// Review SQL: the statements staged edits become, and their transaction.
#[tauri::command]
fn review_changes(
    engine: String,
    table: EditTable,
    changes: Vec<Change>,
) -> Result<rowkery_bridge::ReviewedChanges, String> {
    let kind = match engine.as_str() {
        "postgres" => EngineKind::Postgres,
        _ => EngineKind::Sqlite,
    };
    rowkery_bridge::review_changes(kind, &table, &changes)
}

/// ⌘R on a query tab: whether its last statement only reads, so running it
/// again changes nothing (core's `plain_read`).
#[tauri::command]
fn reads_only(engine: String, sql: String) -> bool {
    let dialect = match engine.as_str() {
        "postgres" => Dialect::Postgres,
        _ => Dialect::Sqlite,
    };
    plain_read(&sql, dialect)
}

/// Commits staged edits as one transaction on the tab's session; held by
/// Confirm writes until `confirmed` carries the SQL the user saw; refused
/// when the window is no longer on `connection_id`, the edits' connection.
#[tauri::command]
async fn apply_changes(
    app: AppHandle,
    window_id: String,
    connection_id: String,
    tab_id: u64,
    table: EditTable,
    changes: Vec<Change>,
    confirmed: Option<String>,
) -> Result<rowkery_bridge::ApplyOutcome, String> {
    on_blocking_pool(app, move |bridge| {
        bridge.apply_changes(
            &window_id,
            &connection_id,
            tab_id,
            table,
            changes,
            confirmed,
        )
    })
    .await
    .map_err(lost_answer)?
}

/// A run, import or commit whose blocking task died: its outcome is unknown.
fn lost_answer(error: String) -> String {
    format!("{} ({error})", rowkery_bridge::LOST_ANSWER)
}

/// Import CSV…: the native open dialog for a .csv / .tsv file. `None` when
/// dismissed.
#[tauri::command]
async fn choose_csv(app: AppHandle) -> Result<Option<String>, String> {
    use tauri_plugin_dialog::DialogExt;
    let picked = tauri::async_runtime::spawn_blocking(move || {
        app.dialog()
            .file()
            .add_filter("CSV or TSV", &["csv", "tsv", "tab", "txt"])
            .blocking_pick_file()
    })
    .await
    .map_err(|e| e.to_string())?;
    Ok(picked
        .and_then(|p| p.into_path().ok())
        .map(|p| p.to_string_lossy().to_string()))
}

/// The import panel's first look at a file: its first rows, delimiter and
/// row count, read off the main thread.
#[tauri::command]
async fn preview_csv(path: String) -> Result<rowkery_core::import::CsvPreview, String> {
    tauri::async_runtime::spawn_blocking(move || rowkery_core::import::preview(&path))
        .await
        .map_err(|e| e.to_string())?
}

/// The running import's cancel flag, per window (one import at a time).
#[derive(Default)]
struct Imports(Mutex<HashMap<String, Arc<std::sync::atomic::AtomicBool>>>);

/// Imports a CSV file into a table in one transaction, sending
/// `{"rows": n}` on `on_progress` at most every 100 ms.
#[tauri::command]
async fn import_csv(
    app: AppHandle,
    imports: State<'_, Imports>,
    window_id: String,
    spec: rowkery_core::import::ImportSpec,
    on_progress: Channel<InvokeResponseBody>,
) -> Result<rowkery_bridge::ImportOutcome, String> {
    let cancel = Arc::new(std::sync::atomic::AtomicBool::new(false));
    {
        let mut running = imports.0.lock().map_err(|e| e.to_string())?;
        if running.contains_key(&window_id) {
            return Err("An import is already running in this window".into());
        }
        running.insert(window_id.clone(), cancel.clone());
    }
    let last = Mutex::new(std::time::Instant::now());
    let progress = rowkery_bridge::ImportProgress(Arc::new(move |rows| {
        let Ok(mut last) = last.lock() else { return };
        if last.elapsed() >= Duration::from_millis(100) {
            *last = std::time::Instant::now();
            let _ = on_progress.send(InvokeResponseBody::Json(format!("{{\"rows\":{rows}}}")));
        }
    }));
    let id = window_id.clone();
    let done = on_blocking_pool(app.clone(), move |bridge| {
        bridge.import_csv(&id, spec, cancel, progress)
    })
    .await
    .map_err(lost_answer);
    if let Ok(mut running) = app.state::<Imports>().0.lock() {
        running.remove(&window_id);
    }
    done?
}

/// Cancel and roll back: the window's running import stops and writes nothing.
#[tauri::command]
fn cancel_import(imports: State<'_, Imports>, window_id: String) {
    if let Some(cancel) = imports
        .0
        .lock()
        .ok()
        .and_then(|r| r.get(&window_id).cloned())
    {
        cancel.store(true, std::sync::atomic::Ordering::SeqCst);
    }
}

/// SQL to browse a table: `filter` is a `WHERE` body, `order` the sort, and
/// `offset` pages past rows already loaded (by keyset after `after` when
/// `key` names the primary key).
#[tauri::command]
#[allow(clippy::too_many_arguments)]
fn browse_table_sql(
    engine: String,
    schema: String,
    table: String,
    columns: Option<Vec<String>>,
    filter: Option<String>,
    order: Option<Vec<BrowseOrder>>,
    limit: Option<u32>,
    offset: Option<u32>,
    key: Option<Vec<String>>,
    after: Option<HashMap<String, Value>>,
) -> String {
    let kind = match engine.as_str() {
        "postgres" => EngineKind::Postgres,
        _ => EngineKind::Sqlite,
    };
    let opts = BrowseOptions {
        columns: columns.unwrap_or_default(),
        filter,
        order: order.unwrap_or_default(),
        limit: limit.unwrap_or(100),
        offset: offset.unwrap_or(0),
        key: key.unwrap_or_default(),
        after,
    };
    table_browse_query(kind, &schema, &table, &opts)
}

/// The SQL line's exact count (`#`, or a click on ≈): `SELECT count(*)`
/// with the tab's WHERE, on a session of its own. `None` when cancelled
/// (`cancel_count`).
#[tauri::command]
async fn count_rows(
    app: AppHandle,
    window_id: String,
    engine: String,
    schema: String,
    table: String,
    filter: Option<String>,
) -> Result<Option<i64>, String> {
    let kind = match engine.as_str() {
        "postgres" => EngineKind::Postgres,
        _ => EngineKind::Sqlite,
    };
    let sql = rowkery_core::db::table_count_query(kind, &schema, &table, filter.as_deref());
    on_blocking_pool(app, move |bridge| bridge.count_window_rows(&window_id, sql)).await?
}

#[tauri::command]
fn cancel_count(bridge: State<'_, CoreBridge>, window_id: String) {
    bridge.cancel_window_query(&window_id, rowkery_bridge::COUNT_TAB);
}

/// What the Report an Issue sheet shows (and sends) about the app.
#[derive(Debug, Clone, Serialize)]
pub struct AppInfoDto {
    pub version: String,
    /// `std::env::consts::OS`: "macos", "windows", "linux".
    pub os: &'static str,
    /// "26.0" on macOS; None where we don't ask.
    pub os_version: Option<String>,
    pub arch: &'static str,
}

/// Connect an agent: whether Claude Code / Claude Desktop has Rowkery's MCP
/// server, and what Run would do. Off the main thread (reads the login shell).
#[tauri::command]
async fn mcp_connect_check(
    client: mcp_connect::Client,
) -> Result<mcp_connect::ConnectCheck, String> {
    tauri::async_runtime::spawn_blocking(move || {
        Ok(mcp_connect::check(client, &mcp_connect::Env::current()?))
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Connect an agent: adds (or replaces) the `rowkery` server in that client.
#[tauri::command]
async fn mcp_connect_run(client: mcp_connect::Client) -> Result<mcp_connect::ConnectRun, String> {
    tauri::async_runtime::spawn_blocking(move || {
        Ok(mcp_connect::run(client, &mcp_connect::Env::current()?))
    })
    .await
    .map_err(|e| e.to_string())?
}

/// ⌘K MCP activity: what the MCP server logged since `since` (a byte
/// offset; none for the log's tail). Off the main thread; polled while a
/// connection is shared.
#[tauri::command]
async fn mcp_activity(since: Option<u64>) -> Result<rowkery_mcp::audit::Activity, String> {
    tauri::async_runtime::spawn_blocking(move || rowkery_mcp::audit::read_since(since))
        .await
        .map_err(|e| e.to_string())
}

/// The result sample kept for one MCP activity entry (by its session and
/// time), while it's under a day old.
#[tauri::command]
async fn mcp_sample(session: u64, ts: u64) -> Result<Option<rowkery_mcp::samples::Sample>, String> {
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0);
    tauri::async_runtime::spawn_blocking(move || rowkery_mcp::samples::find(session, ts, now))
        .await
        .map_err(|e| e.to_string())
}

/// Edit access on the Agents page: a connection's databases with sizes,
/// through a read-only session (shared or not).
#[tauri::command]
async fn mcp_pick_databases(
    picker: State<'_, rowkery_mcp::picker::Picker>,
    connection_id: String,
) -> Result<Vec<rowkery_mcp::picker::PickDatabase>, String> {
    picker.databases(&connection_id).await
}

/// Edit access: one database's tables and views by schema, with row estimates.
#[tauri::command]
async fn mcp_pick_tables(
    picker: State<'_, rowkery_mcp::picker::Picker>,
    connection_id: String,
    database: String,
    refresh: bool,
) -> Result<Vec<rowkery_mcp::picker::PickTable>, String> {
    picker.tables(&connection_id, &database, refresh).await
}

/// Edit access closed: drop the picker's sessions.
#[tauri::command]
async fn mcp_pick_close(picker: State<'_, rowkery_mcp::picker::Picker>) -> Result<(), String> {
    picker.close().await;
    Ok(())
}

/// Changes agents proposed that nobody has decided on yet, oldest first.
/// Polled with the activity log.
#[tauri::command]
async fn proposals_waiting() -> Result<Vec<rowkery_mcp::proposals::Proposal>, String> {
    tauri::async_runtime::spawn_blocking(rowkery_mcp::proposals::waiting)
        .await
        .map_err(|e| e.to_string())
}

/// What the review shows before anything runs: each statement of a
/// proposed change and the triggers it would fire. Executes nothing.
#[tauri::command]
async fn proposal_plan(id: String) -> Result<rowkery_mcp::proposals::Plan, String> {
    rowkery_mcp::proposals::plan(&id).await
}

/// Checks a proposed change again and runs it in a transaction that is
/// rolled back: the rows it would change, before and after.
#[tauri::command]
async fn proposal_dry_run(id: String) -> Result<rowkery_mcp::proposals::DryRun, String> {
    rowkery_mcp::proposals::dry_run(&id).await
}

/// Commits a proposed change if it still passes every check and changes
/// the row counts the user saw (`rows`, per statement).
#[tauri::command]
async fn proposal_commit(
    bridge: State<'_, CoreBridge>,
    id: String,
    rows: Vec<u64>,
) -> Result<rowkery_mcp::proposals::CommitOutcome, String> {
    // A quit while it commits asks first.
    let _running = bridge.hold_commit();
    rowkery_mcp::proposals::commit(&id, &rows).await
}

/// The user said no; `note` goes back to the agent.
#[tauri::command]
async fn proposal_reject(id: String, note: Option<String>) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || rowkery_mcp::proposals::reject(&id, note))
        .await
        .map_err(|e| e.to_string())?
}

#[tauri::command]
async fn mcp_clear_activity() -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(rowkery_mcp::audit::clear)
        .await
        .map_err(|e| e.to_string())?
        .map_err(|e| e.to_string())
}

#[tauri::command]
fn app_info(app: AppHandle) -> AppInfoDto {
    AppInfoDto {
        version: app.package_info().version.to_string(),
        os: std::env::consts::OS,
        os_version: os_version(),
        arch: std::env::consts::ARCH,
    }
}

#[derive(Debug, Serialize)]
struct TimingsOriginDto {
    /// Unix epoch ms when the process started.
    process_start_ms: f64,
    /// ROWKERY_TIMINGS_OUT is set: the page should flush its marks.
    recording: bool,
    proof: Option<ProofEnv>,
}

#[tauri::command]
fn timings_origin(timings: State<'_, Timings>) -> TimingsOriginDto {
    TimingsOriginDto {
        process_start_ms: timings.start_epoch_ms(),
        recording: timings.recording(),
        proof: ProofEnv::from_env(),
    }
}

/// One Rust-side latency mark, for the Timings sheet.
#[derive(Serialize)]
struct RustMarkDto {
    mark: String,
    /// ms since process start.
    t: f64,
}

/// The Rust-side marks so far (process start, the launch window's socket).
#[tauri::command]
fn rust_marks(timings: State<'_, Timings>) -> Vec<RustMarkDto> {
    timings
        .marks()
        .into_iter()
        .map(|(mark, t)| RustMarkDto { mark, t })
        .collect()
}

/// Appends the page's marks to ROWKERY_TIMINGS_OUT (async: file IO stays off the main thread).
#[tauri::command]
async fn write_timings(
    lines: Vec<serde_json::Value>,
    timings: State<'_, Timings>,
) -> Result<(), String> {
    let lines: Vec<serde_json::Value> = lines
        .into_iter()
        .map(|mut l| {
            if let Some(obj) = l.as_object_mut() {
                obj.entry("source").or_insert("webview".into());
            }
            l
        })
        .collect();
    timings.write(&lines).map_err(|e| e.to_string())
}

#[cfg(target_os = "macos")]
fn os_version() -> Option<String> {
    let out = std::process::Command::new("sw_vers")
        .arg("-productVersion")
        .output()
        .ok()?;
    let v = String::from_utf8(out.stdout).ok()?.trim().to_string();
    (!v.is_empty()).then_some(v)
}

#[cfg(not(target_os = "macos"))]
fn os_version() -> Option<String> {
    None
}

/// App items of the macOS menu bar, generated from `src/commands.ts`
/// (`menuSpec`; `npm test` fails when this file is stale): each submenu in
/// order, with its items and separators.
#[derive(serde::Deserialize)]
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
struct MenuSpecSubmenu {
    submenu: String,
    items: Vec<MenuSpecEntry>,
}

#[derive(serde::Deserialize)]
#[serde(untagged)]
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
enum MenuSpecEntry {
    Item {
        id: String,
        title: String,
        accelerator: Option<String>,
    },
    Separator {
        #[allow(dead_code)]
        separator: bool,
    },
}

#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
fn menu_spec() -> Vec<MenuSpecSubmenu> {
    serde_json::from_str(include_str!("../menu.json")).expect("menu.json is valid")
}

#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
fn menu_spec_contains(spec: &[MenuSpecSubmenu], id: &str) -> bool {
    spec.iter()
        .flat_map(|s| &s.items)
        .any(|e| matches!(e, MenuSpecEntry::Item { id: i, .. } if i == id))
}

/// The macOS menu bar: the app menu (About, Check for Updates…, Settings…,
/// Services, Hide, Quit), File, Edit, Connection, Query, View, Go,
/// Window and Help, with every app item from `menu.json` (commands.ts). A pick
/// reaches the page as `menu-command` with the command id. The page disables
/// items that can't run now (`set_menu_state`). ⌘W is File > Close Tab
/// (closes the active query tab) instead of the app's only window, which quit
/// the app; Window > Close Window is the app's ⇧⌘W (close the shown window
/// pill), so the native close item is left out.
#[cfg(target_os = "macos")]
fn app_menu(app: &AppHandle) -> tauri::Result<tauri::menu::Menu<tauri::Wry>> {
    use tauri::menu::{AboutMetadata, IsMenuItem, Menu, MenuItem, PredefinedMenuItem, Submenu};
    use tauri::Wry;

    enum Entry {
        Item(MenuItem<Wry>),
        Native(PredefinedMenuItem<Wry>),
    }
    let info = app.package_info();
    let about = AboutMetadata {
        name: Some(info.name.clone()),
        version: Some(info.version.to_string()),
        ..Default::default()
    };
    let sep = || PredefinedMenuItem::separator(app).map(Entry::Native);
    let entries = |items: &[MenuSpecEntry]| -> tauri::Result<Vec<Entry>> {
        items
            .iter()
            .map(|e| match e {
                MenuSpecEntry::Item {
                    id,
                    title,
                    accelerator,
                } => MenuItem::with_id(app, id.as_str(), title, true, accelerator.as_deref())
                    .map(Entry::Item),
                MenuSpecEntry::Separator { .. } => sep(),
            })
            .collect()
    };
    fn refs(list: &[Entry]) -> Vec<&dyn IsMenuItem<Wry>> {
        list.iter()
            .map(|e| match e {
                Entry::Item(i) => i as &dyn IsMenuItem<Wry>,
                Entry::Native(i) => i as &dyn IsMenuItem<Wry>,
            })
            .collect()
    }
    let spec = menu_spec();
    // The app menu: About, then menu.json's "Rowkery" items (Check for
    // Updates…, Settings…), then the native Services and Hide, and Quit
    // (ours: it asks first when quitting would lose work).
    let mut app_items = vec![Entry::Native(PredefinedMenuItem::about(
        app,
        None,
        Some(about),
    )?)];
    if let Some(own) = spec.iter().find(|s| s.submenu == "Rowkery") {
        app_items.push(sep()?);
        app_items.append(&mut entries(&own.items)?);
    }
    app_items.extend([
        sep()?,
        Entry::Native(PredefinedMenuItem::services(app, None)?),
        sep()?,
        Entry::Native(PredefinedMenuItem::hide(app, None)?),
        Entry::Native(PredefinedMenuItem::hide_others(app, None)?),
        sep()?,
        Entry::Item(MenuItem::with_id(
            app,
            QUIT_ITEM,
            format!("Quit {}", info.name),
            true,
            Some("CmdOrCtrl+Q"),
        )?),
    ]);
    let mut submenus = vec![Submenu::with_items(
        app,
        info.name.clone(),
        true,
        &refs(&app_items),
    )?];
    // Edit: the native Undo, Redo, Cut, Copy, Paste and Select All, then
    // menu.json's "Edit" items (Format SQL).
    let mut edit_items = match spec.iter().find(|s| s.submenu == "Edit") {
        Some(own) => entries(&own.items)?,
        None => Vec::new(),
    };
    for sub in spec
        .iter()
        .filter(|s| s.submenu != "Rowkery" && s.submenu != "Edit")
    {
        let mut list = entries(&sub.items)?;
        match sub.submenu.as_str() {
            "View" => {
                list.push(sep()?);
                list.push(Entry::Native(PredefinedMenuItem::fullscreen(app, None)?));
            }
            "Window" => {
                let mut native = vec![
                    Entry::Native(PredefinedMenuItem::minimize(app, None)?),
                    Entry::Native(PredefinedMenuItem::maximize(app, None)?),
                    sep()?,
                ];
                native.append(&mut list);
                list = native;
            }
            _ => {}
        }
        submenus.push(Submenu::with_items(app, &sub.submenu, true, &refs(&list))?);
        if sub.submenu == "File" {
            let mut edit = vec![
                Entry::Native(PredefinedMenuItem::undo(app, None)?),
                Entry::Native(PredefinedMenuItem::redo(app, None)?),
                sep()?,
                Entry::Native(PredefinedMenuItem::cut(app, None)?),
                Entry::Native(PredefinedMenuItem::copy(app, None)?),
                Entry::Native(PredefinedMenuItem::paste(app, None)?),
                Entry::Native(PredefinedMenuItem::select_all(app, None)?),
            ];
            if !edit_items.is_empty() {
                edit.push(sep()?);
                edit.append(&mut edit_items);
            }
            submenus.push(Submenu::with_items(app, "Edit", true, &refs(&edit))?);
        }
    }
    let refs: Vec<&dyn IsMenuItem<Wry>> =
        submenus.iter().map(|s| s as &dyn IsMenuItem<Wry>).collect();
    Menu::with_items(app, &refs)
}

/// One menu item's state as the shown window sees it.
#[derive(serde::Deserialize)]
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
struct MenuItemState {
    id: String,
    enabled: bool,
    /// New text, for items whose title reads the state (Show / Hide Sidebar).
    title: Option<String>,
    /// The accelerator under the page's keymap (keymaps.ts).
    accelerator: Option<String>,
}

/// Each item's accelerator as the menu has it now: `menu.json`'s, then what a
/// keymap set. Only a real change touches an item's shortcut, so the default
/// keymap never changes accelerators at all.
#[cfg(target_os = "macos")]
static MENU_ACCELERATORS: Mutex<Option<HashMap<String, Option<String>>>> = Mutex::new(None);

/// Whether `accelerator` differs from what item `id` has, recording it if so.
#[cfg(target_os = "macos")]
fn accelerator_changed(id: &str, accelerator: &Option<String>) -> bool {
    let Ok(mut map) = MENU_ACCELERATORS.lock() else {
        return false;
    };
    let map = map.get_or_insert_with(|| {
        menu_spec()
            .into_iter()
            .flat_map(|s| s.items)
            .filter_map(|e| match e {
                MenuSpecEntry::Item {
                    id, accelerator, ..
                } => Some((id, accelerator)),
                MenuSpecEntry::Separator { .. } => None,
            })
            .collect()
    });
    if map.get(id) == Some(accelerator) {
        return false;
    }
    map.insert(id.to_string(), accelerator.clone());
    true
}

/// The page pushes what changed whenever its command state or keymap does
/// (`menuSync.ts`): items that can't run now are disabled, never hidden, and
/// accelerators follow the keymap without rebuilding the menu.
///
/// Async, and the menu calls run on a blocking worker: each one hops to the
/// main thread and waits there, so done from a sync command (which runs on
/// the main thread) a slow menu call held the thread WebKit paints on, and the
/// window came up blank on macOS.
#[tauri::command]
#[cfg_attr(not(target_os = "macos"), allow(unused_variables))]
async fn set_menu_state(app: AppHandle, items: Vec<MenuItemState>) {
    #[cfg(target_os = "macos")]
    {
        let _ = tauri::async_runtime::spawn_blocking(move || apply_menu_state(&app, items)).await;
    }
}

#[cfg(target_os = "macos")]
fn apply_menu_state(app: &AppHandle, items: Vec<MenuItemState>) {
    use tauri::menu::MenuItemKind;
    let Some(menu) = app.menu() else { return };
    let submenus: Vec<_> = menu
        .items()
        .unwrap_or_default()
        .into_iter()
        .filter_map(|k| match k {
            MenuItemKind::Submenu(s) => Some(s),
            _ => None,
        })
        .collect();
    for item in items {
        let found = submenus.iter().find_map(|s| s.get(item.id.as_str()));
        if let Some(MenuItemKind::MenuItem(m)) = found {
            let _ = m.set_enabled(item.enabled);
            if let Some(title) = item.title {
                let _ = m.set_text(title);
            }
            if accelerator_changed(&item.id, &item.accelerator) {
                let _ = m.set_accelerator(item.accelerator.as_deref());
            }
        }
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run(mut timings: Timings) {
    if let Ok(path) = std::env::var("ROWKERY_TIMINGS_OUT") {
        if let Err(e) = timings.record_to(&path) {
            eprintln!("ROWKERY_TIMINGS_OUT: {e}");
        }
    }
    let bridge = CoreBridge::spawn();
    timings.mark("bridge-spawned");
    // First launch: the sample database, before the webview lists connections.
    if let Err(e) = bridge.first_run() {
        eprintln!("sample database: {e}");
    }
    // Linux / Windows window chrome, from config.json. Decorations are fixed
    // here, before the window exists: toggling them later reflows the window
    // (and on macOS drops the full-size content view), so a change in ⌘K
    // shows on the next launch. macOS keeps tauri.macos.conf.json as it is.
    let config = bridge.get_config_blocking();
    let saved = config.as_ref().is_some_and(|c| c.native_decorations);
    // The appearance (light / dark Paper), also before the window exists, so
    // its first frame and the native controls match the page; on System the
    // background is set in `setup`, where the window can say what the system
    // is.
    let theme = config.map(|c| c.theme).unwrap_or_default();
    let chrome = WindowChrome {
        native: saved && cfg!(not(target_os = "macos")),
        saved: saved.into(),
    };
    let mut context = tauri::generate_context!();
    for window in &mut context.config_mut().app.windows {
        if chrome.native {
            window.decorations = true;
            window.title = "Rowkery".into();
        }
        match theme {
            ThemePreference::Light | ThemePreference::Dark => {
                let dark = theme == ThemePreference::Dark;
                window.theme = Some(if dark {
                    tauri::Theme::Dark
                } else {
                    tauri::Theme::Light
                });
                window.background_color = Some(paper_background(dark));
            }
            ThemePreference::System => {}
        }
    }
    let builder = tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_clipboard_manager::init())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_updater::Builder::new().build());
    #[cfg(target_os = "macos")]
    let builder = builder.menu(app_menu).on_menu_event(|app, event| {
        use tauri::Emitter;
        let id = event.id().as_ref();
        if id == QUIT_ITEM {
            let quit = app.clone();
            return ask_before_quit(app, "Quit", move || quit.exit(0));
        }
        if menu_spec_contains(&menu_spec(), id) {
            let _ = app.emit("menu-command", id);
        }
    });
    builder
        .manage(bridge)
        .manage(timings)
        .manage(sql_file::SqlFiles::default())
        .manage(chrome)
        .manage(updates::Updates::default())
        .manage(Imports::default())
        .manage(rowkery_mcp::picker::Picker::default())
        .manage(open_link::PendingLink::default())
        .manage(done_notify::Away::default())
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::Focused(true) = event {
                done_notify::came_back(window.app_handle());
            }
            // The one window closing quits the app: ask first when that
            // would lose work.
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                api.prevent_close();
                let app = window.app_handle().clone();
                let window = window.clone();
                ask_before_quit(&app, "Quit", move || {
                    #[cfg(target_os = "macos")]
                    close_after_hiding(&window);
                    #[cfg(not(target_os = "macos"))]
                    {
                        let target = window.clone();
                        let _ = window.run_on_main_thread(move || {
                            let _ = target.destroy();
                        });
                    }
                });
            }
        })
        .setup(move |app| {
            app.state::<Timings>().mark("setup");
            // Still hidden: the system's appearance decides the background now.
            if let Some(window) = app.get_webview_window("main") {
                apply_window_theme(&window, theme);
            }
            #[cfg(feature = "e2e")]
            e2e::start(app.handle());
            done_notify::listen(app.handle());
            // Proof runs end themselves, whatever the page is doing.
            if let Some(ms) = std::env::var("ROWKERY_AUTO_QUIT_AFTER_MS")
                .ok()
                .and_then(|v| v.parse::<u64>().ok())
            {
                let handle = app.handle().clone();
                std::thread::spawn(move || {
                    std::thread::sleep(std::time::Duration::from_millis(ms));
                    handle.exit(0);
                });
            }
            // The window opened at launch: when its session was ready, which is
            // what "socket warm" measures (the page hears of it only after it
            // asks, once the shell has painted).
            let handle = app.handle().clone();
            app.state::<CoreBridge>().on_launch_warm(move |at| {
                handle.state::<Timings>().mark_at("socket-warm", at);
            });
            // A window answered from the catalog cache learns here whether the
            // server confirmed it, replaced it or refused the connection.
            let handle = app.handle().clone();
            app.state::<CoreBridge>()
                .on_catalog_update(Arc::new(move |update| {
                    use tauri::Emitter;
                    let _ = handle.emit("catalog-update", update);
                }));
            let handle = app.handle().clone();
            thread::spawn(move || {
                thread::sleep(SHOW_ANYWAY);
                let main = handle.clone();
                let _ = handle.run_on_main_thread(move || show_main_window(&main));
            });
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            sql_file::scan_sql_file,
            sql_file::run_sql_file,
            sql_file::cancel_sql_file,
            sql_file::forget_sql_file,
            list_connections,
            reads_only,
            save_connection,
            delete_connection,
            forget_connection_secrets,
            open_sample,
            stop_all_queries,
            open_transactions,
            busy_work,
            count_rows,
            cancel_count,
            probe_local_servers,
            read_clipboard_text,
            sqlite_file_exists,
            open_window,
            close_window,
            list_databases,
            table_indexes,
            list_sessions,
            database_health,
            session_locks,
            stop_session,
            reload_window_schema,
            probe_connection,
            cloudsql_account,
            cloudsql_instances,
            cloudsql_key_file,
            run_query,
            explain_statement,
            cancel_query,
            close_query_tab,
            browse_table_sql,
            fetch_more,
            explain_connect_error,
            app_ready,
            get_theme_preference,
            set_theme_preference,
            table_counts,
            export_results,
            choose_file,
            copy_all_results,
            browse_table,
            follow_keys,
            count_incoming,
            review_changes,
            apply_changes,
            choose_csv,
            preview_csv,
            import_csv,
            cancel_import,
            prefetch_table,
            cancel_prefetch,
            ping_idle,
            load_ui_state,
            save_ui_state,
            take_config_notice,
            app_info,
            timings_origin,
            rust_marks,
            write_timings,
            set_menu_state,
            window_chrome,
            set_native_decorations,
            mcp_connect_check,
            mcp_connect_run,
            mcp_activity,
            mcp_sample,
            mcp_clear_activity,
            proposals_waiting,
            proposal_plan,
            proposal_dry_run,
            proposal_commit,
            proposal_reject,
            mcp_pick_databases,
            mcp_pick_tables,
            mcp_pick_close,
            updates::check_for_update,
            updates::download_update,
            updates::restart_to_update,
            open_link::take_open_link,
            done_notify::notify_done,
        ])
        .build(context)
        .expect("error while building tauri application")
        .run(|app, event| {
            // A rowkery:// link from a view in the chat (it may have launched us).
            #[cfg(target_os = "macos")]
            if let tauri::RunEvent::Opened { urls } = &event {
                for url in urls {
                    open_link::opened(app, url.as_str());
                }
            }
            // A click on the Dock icon brings back a minimized window unfocused.
            #[cfg(target_os = "macos")]
            if let tauri::RunEvent::Reopen { .. } = event {
                done_notify::came_back(app);
            }
            // UI state written in the last 500 ms is still in the writer.
            if let tauri::RunEvent::Exit = event {
                app.state::<CoreBridge>().flush_config();
                updates::install_on_exit(&app.state::<updates::Updates>());
            }
        });
}

#[cfg(test)]
mod frame_tests {
    use super::*;
    use rowkery_core::db::RowBatch;
    use rowkery_core::QueryDetail;

    #[derive(Debug, Clone, PartialEq)]
    enum Seen {
        Json(serde_json::Value),
        Rows(u32, bool, Vec<Vec<Value>>),
    }

    fn capture(target_bytes: usize) -> (ChannelSink, Arc<Mutex<Vec<Seen>>>) {
        let seen: Arc<Mutex<Vec<Seen>>> = Arc::default();
        let out = seen.clone();
        let channel = Channel::new(move |body| {
            out.lock().unwrap().push(match body {
                InvokeResponseBody::Json(json) => Seen::Json(serde_json::from_str(&json).unwrap()),
                InvokeResponseBody::Raw(bytes) => {
                    let (_, seq, last, rows) = rowkery_core::frames::decode_rows(&bytes).unwrap();
                    Seen::Rows(seq, last, rows)
                }
            });
            Ok(())
        });
        (ChannelSink::new(channel, target_bytes), seen)
    }

    fn columns() -> Vec<Column> {
        vec![Column {
            name: "id".into(),
            type_name: "int8".into(),
        }]
    }

    fn batch(first: bool, from: i64, n: i64) -> CoreEvent {
        CoreEvent::QueryBatch {
            query_id: 7,
            tab_id: 1,
            batch: RowBatch {
                columns: columns(),
                rows: (from..from + n).map(|i| vec![Value::Int(i)]).collect(),
            },
            first,
        }
    }

    fn finished() -> CoreEvent {
        CoreEvent::QueryFinished {
            query_id: 7,
            tab_id: 1,
            row_count: 0,
            rows_affected: None,
            elapsed_ms: 12,
            error: None,
            cancelled: false,
            detail: QueryDetail {
                first_row_ms: Some(4),
                ..QueryDetail::default()
            },
        }
    }

    #[test]
    fn first_rows_go_at_once_then_frames_gather_until_done() {
        let (sink, seen) = capture(FRAME_DEFAULT_BYTES);
        sink.push(CoreEvent::QueryStarted {
            query_id: 7,
            tab_id: 1,
        });
        sink.push(batch(true, 0, 2));
        // The first rows frame left before any more arrived.
        assert!(
            matches!(seen.lock().unwrap().last(), Some(Seen::Rows(0, false, r)) if r.len() == 2)
        );
        sink.push(batch(false, 2, 200));
        sink.push(batch(false, 202, 200));
        sink.push(finished());
        let frames = seen.lock().unwrap().clone();
        assert_eq!(
            frames[0],
            Seen::Json(
                serde_json::json!({"t": "columns", "query_id": 7, "columns": [{"name": "id", "type_name": "int8"}]})
            )
        );
        // The next 400 small rows (well under 64 KB) arrive as one last frame.
        assert!(
            matches!(&frames[2], Seen::Rows(1, true, r) if r.len() == 400 && r[0] == vec![Value::Int(2)])
        );
        let Seen::Json(done) = &frames[3] else {
            panic!("done")
        };
        assert_eq!(done["t"], "done");
        assert_eq!(done["status"], "ok");
        assert_eq!(done["frames"], 2);
        assert_eq!(done["first_row_ms"], 4);
        assert!(done["bytes"].as_u64().unwrap() > 0);
        assert_eq!(frames.len(), 4);
    }

    #[test]
    fn a_full_frame_leaves_without_waiting() {
        // A tiny target: every batch after the first is a frame of its own.
        let (sink, seen) = capture(1);
        sink.push(batch(true, 0, 1));
        sink.push(batch(false, 1, 3));
        sink.push(batch(false, 4, 3));
        let rows: Vec<usize> = seen
            .lock()
            .unwrap()
            .iter()
            .filter_map(|s| match s {
                Seen::Rows(_, _, r) => Some(r.len()),
                _ => None,
            })
            .collect();
        assert_eq!(rows, [1, 3, 3]);
    }

    #[test]
    fn rows_that_wait_are_flushed_by_the_timer() {
        let (sink, seen) = capture(FRAME_DEFAULT_BYTES);
        sink.push(batch(true, 0, 1));
        sink.push(batch(false, 1, 5));
        std::thread::sleep(FRAME_MAX_WAIT * 4);
        let frames = seen.lock().unwrap().clone();
        assert!(
            matches!(frames.last(), Some(Seen::Rows(1, false, r)) if r.len() == 5),
            "{frames:?}"
        );
    }

    /// Each rows frame as (rows, rows its profiles sampled, if it carries them).
    #[allow(clippy::type_complexity)]
    fn capture_profiles(
        target_bytes: usize,
        sink: impl FnOnce(ChannelSink) -> ChannelSink,
    ) -> (ChannelSink, Arc<Mutex<Vec<(usize, Option<u32>)>>>) {
        let seen: Arc<Mutex<Vec<(usize, Option<u32>)>>> = Arc::default();
        let out = seen.clone();
        let channel = Channel::new(move |body| {
            if let InvokeResponseBody::Raw(bytes) = body {
                let ((_, _, _, rows), profiles) =
                    rowkery_core::frames::decode_rows_and_profile(&bytes).unwrap();
                out.lock()
                    .unwrap()
                    .push((rows.len(), profiles.map(|p| p[0].sample_rows)));
            }
            Ok(())
        });
        (sink(ChannelSink::new(channel, target_bytes)), seen)
    }

    #[test]
    fn the_frame_that_completes_5000_rows_carries_the_profiles() {
        // A tiny target: every batch is a frame of its own.
        let (sink, seen) = capture_profiles(1, |s| s);
        sink.push(batch(true, 0, 1));
        sink.push(batch(false, 1, 3000));
        sink.push(batch(false, 3001, 3000));
        sink.push(batch(false, 6001, 100));
        sink.push(finished());
        assert_eq!(
            *seen.lock().unwrap(),
            [(1, None), (3000, None), (3000, Some(5000)), (100, None)]
        );
    }

    #[test]
    fn a_shorter_result_sends_them_with_its_last_rows() {
        let (sink, seen) = capture_profiles(FRAME_DEFAULT_BYTES, |s| s);
        sink.push(batch(true, 0, 1));
        sink.push(batch(false, 1, 9));
        sink.push(finished());
        assert_eq!(*seen.lock().unwrap(), [(1, None), (9, Some(10))]);
        // Every row already sent: an empty last frame carries them.
        let (sink, seen) = capture_profiles(FRAME_DEFAULT_BYTES, |s| s);
        sink.push(batch(true, 0, 2));
        sink.push(finished());
        assert_eq!(*seen.lock().unwrap(), [(2, None), (0, Some(2))]);
        // A next page never profiles.
        let (sink, seen) = capture_profiles(1, ChannelSink::without_profile);
        sink.push(batch(true, 0, 2));
        sink.push(batch(false, 2, 2));
        sink.push(finished());
        assert_eq!(*seen.lock().unwrap(), [(2, None), (2, None)]);
    }

    #[test]
    fn an_error_and_a_hold_are_done_frames() {
        let (sink, seen) = capture(FRAME_DEFAULT_BYTES);
        sink.push(CoreEvent::QueryBatch {
            query_id: 1,
            tab_id: 1,
            batch: RowBatch::default(),
            first: true,
        });
        sink.push(CoreEvent::QueryFinished {
            query_id: 1,
            tab_id: 1,
            row_count: 0,
            rows_affected: None,
            elapsed_ms: 1,
            error: Some("relation \"nope\" does not exist".into()),
            cancelled: false,
            detail: QueryDetail {
                sqlstate: Some("42P01".into()),
                error_position: Some(15),
                ..QueryDetail::default()
            },
        });
        let frames = seen.lock().unwrap().clone();
        assert_eq!(frames.len(), 2);
        let Seen::Json(done) = &frames[1] else {
            panic!()
        };
        assert_eq!(done["status"], "error");
        assert_eq!(done["sqlstate"], "42P01");
        assert_eq!(done["error_position"], 15);
        assert_eq!(done["frames"], 0);
    }

    #[test]
    fn frame_size_follows_the_measured_rate() {
        assert_eq!(frame_target_bytes(None), FRAME_DEFAULT_BYTES);
        assert_eq!(frame_target_bytes(Some(1.0)), FRAME_MIN_BYTES);
        assert_eq!(frame_target_bytes(Some(1e9)), FRAME_MAX_BYTES);
        assert_eq!(frame_target_bytes(Some(10_000.0)), 80_000);
        assert_eq!(frame_target_bytes(Some(f64::NAN)), FRAME_DEFAULT_BYTES);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn menu_json_parses_and_keeps_close_tab_on_cmd_w() {
        let spec = menu_spec();
        let file = spec.iter().find(|s| s.submenu == "File").expect("File");
        let close = file.items.iter().find_map(|e| match e {
            MenuSpecEntry::Item {
                id, accelerator, ..
            } if id == "close-tab" => Some(accelerator.clone()),
            _ => None,
        });
        assert_eq!(close, Some(Some("CmdOrCtrl+W".to_string())));
        assert!(menu_spec_contains(&spec, "report-issue"));
        assert!(!menu_spec_contains(&spec, "native:close-window"));
        // Check for Updates… and Settings… (⌘,) sit in the app menu, under About.
        let own = spec
            .iter()
            .find(|s| s.submenu == "Rowkery")
            .expect("Rowkery");
        assert!(menu_spec_contains(
            std::slice::from_ref(own),
            "check-updates"
        ));
        assert!(own.items.iter().any(|e| matches!(e,
            MenuSpecEntry::Item { id, accelerator, .. }
                if id == "settings" && accelerator.as_deref() == Some("CmdOrCtrl+,"))));
        let names: Vec<_> = spec.iter().map(|s| s.submenu.as_str()).collect();
        assert_eq!(
            names,
            [
                "Rowkery",
                "File",
                "Edit",
                "Connection",
                "Query",
                "View",
                "Go",
                "Window",
                "Help"
            ]
        );
    }

    #[test]
    fn copy_all_stops_at_its_byte_cap() {
        use std::io::Write;
        let mut buf = ClipboardBuf::default();
        buf.write_all(&vec![b'x'; CLIPBOARD_MAX_BYTES]).unwrap();
        let err = buf.write_all(b"y").unwrap_err();
        assert!(err.to_string().contains("use Export"), "{err}");
        assert!(err.to_string().contains("100 MiB"), "{err}");
        assert_eq!(buf.0.len(), CLIPBOARD_MAX_BYTES);
    }

    /// The first write that fails stops the run once, and the run's end
    /// (cancelled, as a stopped run is) reports the failure, not a cancel.
    #[test]
    fn a_failed_write_stops_the_run_and_says_why() {
        use rowkery_core::bridge::QueryDetail;
        use rowkery_core::db::{Column, RowBatch, Value};
        use std::sync::atomic::{AtomicUsize, Ordering};

        struct Full;
        impl std::io::Write for Full {
            fn write(&mut self, _: &[u8]) -> std::io::Result<usize> {
                Err(std::io::Error::other("The result is over 100 MiB"))
            }
            fn flush(&mut self) -> std::io::Result<()> {
                Ok(())
            }
        }

        let frames = Arc::new(Mutex::new(Vec::<String>::new()));
        let seen = frames.clone();
        let channel = Channel::new(move |body| {
            if let InvokeResponseBody::Json(json) = body {
                seen.lock().unwrap().push(json);
            }
            Ok(())
        });
        let stops = Arc::new(AtomicUsize::new(0));
        let counted = stops.clone();
        let sink = ExportSink::new(
            channel,
            rowkery_core::export::ExportWriter::new(Full, rowkery_core::export::ExportFormat::Csv),
            None,
            Box::new(|_| panic!("a failed copy never reaches the clipboard")),
            Box::new(move || {
                counted.fetch_add(1, Ordering::SeqCst);
            }),
        );
        let batch = || CoreEvent::QueryBatch {
            query_id: 1,
            tab_id: 1,
            batch: RowBatch {
                columns: vec![Column {
                    name: "n".into(),
                    type_name: "int8".into(),
                }],
                rows: vec![vec![Value::Int(1)]],
            },
            first: true,
        };
        sink.push(batch());
        sink.push(batch());
        assert_eq!(stops.load(Ordering::SeqCst), 1);
        sink.push(CoreEvent::QueryFinished {
            query_id: 1,
            tab_id: 1,
            row_count: 2,
            rows_affected: None,
            elapsed_ms: 1,
            error: Some("Query cancelled".into()),
            cancelled: true,
            detail: QueryDetail::default(),
        });
        let last = frames.lock().unwrap().last().cloned().unwrap();
        let done: serde_json::Value = serde_json::from_str(&last).unwrap();
        assert_eq!(done["t"], "done");
        assert_eq!(done["cancelled"], false);
        assert_eq!(done["error"], "The result is over 100 MiB");
    }
}
