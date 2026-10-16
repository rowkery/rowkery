//! The end-to-end test hook, built only with `--features e2e` and active only
//! when `ROWKERY_E2E_PORT` is set: a socket on 127.0.0.1 that runs JavaScript in
//! the main webview and answers with its result. `scripts/e2e/` drives the real
//! app through it (real core, IPC, WebKit, Postgres). Release builds never
//! carry it: `scripts/release.sh` builds without the feature.
//!
//! One JSON object per line each way. In: `{"id": 1, "js": "return 1 + 1", "timeout_ms": 5000}`;
//! `js` is the body of an async function. Out: `{"id": 1, "ok": true, "value": 2}` or
//! `{"id": 1, "ok": false, "error": "…"}`. The page answers with an `e2e-reply`
//! event, so a webview that stops answering shows up as a timeout (a hang).

use std::collections::HashMap;
use std::io::{BufRead, BufReader, Write};
use std::net::{TcpListener, TcpStream};
use std::sync::mpsc::{channel, Sender};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::Duration;

use serde::Deserialize;
use tauri::{AppHandle, Listener, Manager};

type Pending = Arc<Mutex<HashMap<u64, Sender<String>>>>;

#[derive(Deserialize)]
struct Request {
    id: u64,
    js: String,
    timeout_ms: Option<u64>,
}

#[derive(Deserialize)]
struct Reply {
    id: u64,
}

pub fn start(app: &AppHandle) {
    let Some(port) = std::env::var("ROWKERY_E2E_PORT")
        .ok()
        .and_then(|p| p.parse::<u16>().ok())
    else {
        return;
    };
    // WebKit slows timers and stops frames in a window it thinks is hidden;
    // above other windows, the run measures what a user in front of it sees.
    if std::env::var_os("ROWKERY_E2E_BACKGROUND").is_none() {
        if let Some(window) = app.get_webview_window("main") {
            let _ = window.set_always_on_top(true);
        }
    }
    let pending: Pending = Arc::default();
    let replies = pending.clone();
    app.listen_any("e2e-reply", move |event| {
        let payload = event.payload().to_string();
        if let Ok(Reply { id }) = serde_json::from_str::<Reply>(&payload) {
            if let Some(tx) = replies.lock().unwrap().remove(&id) {
                let _ = tx.send(payload);
            }
        }
    });
    let listener = match TcpListener::bind(("127.0.0.1", port)) {
        Ok(l) => l,
        Err(e) => {
            eprintln!("e2e: couldn't listen on 127.0.0.1:{port}: {e}");
            return;
        }
    };
    eprintln!("e2e: listening on 127.0.0.1:{port}");
    let app = app.clone();
    thread::spawn(move || {
        for stream in listener.incoming().flatten() {
            let (app, pending) = (app.clone(), pending.clone());
            thread::spawn(move || serve(stream, app, pending));
        }
    });
}

fn serve(stream: TcpStream, app: AppHandle, pending: Pending) {
    let Ok(mut out) = stream.try_clone() else {
        return;
    };
    for line in BufReader::new(stream).lines() {
        let Ok(line) = line else { return };
        let answer = match serde_json::from_str::<Request>(&line) {
            Ok(req) => run(&app, &pending, req),
            Err(e) => {
                serde_json::json!({ "id": 0, "ok": false, "error": format!("bad request: {e}") })
                    .to_string()
            }
        };
        if writeln!(out, "{answer}").is_err() {
            return;
        }
    }
}

fn run(app: &AppHandle, pending: &Pending, req: Request) -> String {
    let fail = |error: String| {
        serde_json::json!({ "id": req.id, "ok": false, "error": error }).to_string()
    };
    let Some(window) = app.get_webview_window("main") else {
        return fail("no main window".into());
    };
    let (tx, rx) = channel();
    pending.lock().unwrap().insert(req.id, tx);
    let script = format!(
        r#"(async () => {{
  const id = {id};
  let out;
  try {{
    const value = await (async () => {{ {js}
    }})();
    out = {{ id, ok: true, value: value === undefined ? null : value instanceof Node ? true : value }};
  }} catch (e) {{
    out = {{ id, ok: false, error: e && e.message ? `${{e.message}}\n${{e.stack || ""}}` : String(e) }};
  }}
  const emit = (payload) => window.__TAURI_INTERNALS__.invoke("plugin:event|emit", {{ event: "e2e-reply", payload }});
  emit(out).catch((e) => emit({{ id, ok: false, error: `the result couldn't be sent: ${{e}}` }}));
}})();"#,
        id = req.id,
        js = req.js,
    );
    if let Err(e) = window.eval(&script) {
        pending.lock().unwrap().remove(&req.id);
        return fail(format!("eval: {e}"));
    }
    let timeout = Duration::from_millis(req.timeout_ms.unwrap_or(10_000));
    match rx.recv_timeout(timeout) {
        Ok(reply) => reply,
        Err(_) => {
            pending.lock().unwrap().remove(&req.id);
            fail(format!(
                "timeout: the page didn't answer in {} ms",
                timeout.as_millis()
            ))
        }
    }
}
