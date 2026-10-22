//! Run SQL file (the Inspector's "Run SQL file" panel): reads a `.sql` file
//! for its summary, then runs it on the window's connection
//! (`rowkery_core::sql_file`). The scan is kept per window, so the run is of
//! the file the user saw summarised.

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};

use rowkery_bridge::{CoreBridge, ProgressSink, IMPORT_TAB};
use rowkery_core::db::EngineKind;
use rowkery_core::sql_file::{scan, Progress, RunOptions, RunReport, Scan};
use serde::Serialize;
use tauri::ipc::Channel;
use tauri::{AppHandle, Manager, State};

/// Each window's scanned file, and the flag that stops a scan in flight.
#[derive(Default)]
pub struct SqlFiles(Mutex<HashMap<String, Entry>>);

#[derive(Default)]
struct Entry {
    scanned: Option<(PathBuf, Scan)>,
    stop: Arc<AtomicBool>,
}

/// What the scan and the run say while they go (JSON on their channel).
#[derive(Debug, Clone, Serialize)]
#[serde(tag = "t", rename_all = "snake_case")]
pub enum SqlFileFrame {
    /// Bytes of the file read so far.
    Read {
        bytes: u64,
    },
    Progress(Progress),
}

/// Reads the `.sql` file at `path` without running it and keeps what it
/// found for `run_sql_file`. `Err` only when it couldn't be read at all or
/// was stopped; a file Rowkery won't run comes back with `refused` set.
#[tauri::command]
pub async fn scan_sql_file(
    app: AppHandle,
    window_id: String,
    path: String,
    engine: String,
    on_frame: Channel<SqlFileFrame>,
) -> Result<Scan, String> {
    let engine = if engine == "postgres" {
        EngineKind::Postgres
    } else {
        EngineKind::Sqlite
    };
    let stop = Arc::new(AtomicBool::new(false));
    {
        let files = app.state::<SqlFiles>();
        let mut files = files.0.lock().map_err(|e| e.to_string())?;
        let entry = files.entry(window_id.clone()).or_default();
        entry.stop.store(true, Ordering::SeqCst);
        *entry = Entry {
            scanned: None,
            stop: stop.clone(),
        };
    }
    let path = PathBuf::from(path);
    let read = path.clone();
    let stopped = stop.clone();
    let scanned = tauri::async_runtime::spawn_blocking(move || {
        scan(&read, engine, |bytes| {
            let _ = on_frame.send(SqlFileFrame::Read { bytes });
            !stopped.load(Ordering::SeqCst)
        })
    })
    .await
    .map_err(|e| e.to_string())?
    .map_err(|e| e.message)?;
    let files = app.state::<SqlFiles>();
    let mut files = files.0.lock().map_err(|e| e.to_string())?;
    // Only if no newer scan of this window started meanwhile.
    match files.get_mut(&window_id) {
        Some(entry) if Arc::ptr_eq(&entry.stop, &stop) => {
            entry.scanned = Some((path, scanned.clone()));
        }
        _ => return Err("Choose the file again.".into()),
    }
    Ok(scanned)
}

/// Runs the file the window last scanned. `confirmed` is the panel's Run:
/// a connection under Confirm writes refuses without it.
#[tauri::command]
pub async fn run_sql_file(
    app: AppHandle,
    window_id: String,
    whole_file: bool,
    keep_going: bool,
    confirmed: bool,
    on_frame: Channel<SqlFileFrame>,
) -> Result<RunReport, String> {
    let scanned = app
        .state::<SqlFiles>()
        .0
        .lock()
        .map_err(|e| e.to_string())?
        .get(&window_id)
        .and_then(|e| e.scanned.clone());
    let Some((path, scan)) = scanned else {
        return Err("Choose the file again.".into());
    };
    let options = RunOptions {
        whole_file,
        keep_going,
    };
    let progress = ProgressSink(Box::new(move |p: &Progress| {
        let _ = on_frame.send(SqlFileFrame::Progress(p.clone()));
    }));
    tauri::async_runtime::spawn_blocking(move || {
        app.state::<CoreBridge>()
            .run_sql_file(&window_id, path, scan, options, confirmed, progress)
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Stops the window's scan or run (a run rolls back).
#[tauri::command]
pub fn cancel_sql_file(
    bridge: State<'_, CoreBridge>,
    files: State<'_, SqlFiles>,
    window_id: String,
) {
    if let Some(entry) = files.0.lock().ok().as_ref().and_then(|f| f.get(&window_id)) {
        entry.stop.store(true, Ordering::SeqCst);
    }
    bridge.cancel_window_query(&window_id, IMPORT_TAB);
}

/// The panel closed: its scan goes.
#[tauri::command]
pub fn forget_sql_file(files: State<'_, SqlFiles>, window_id: String) {
    if let Ok(mut files) = files.0.lock() {
        if let Some(entry) = files.remove(&window_id) {
            entry.stop.store(true, Ordering::SeqCst);
        }
    }
}
