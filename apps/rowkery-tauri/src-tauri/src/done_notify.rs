//! "Tell me when it's done": a macOS banner when a long job finishes (or an
//! agent proposes a change) while Rowkery isn't the app in front, and the
//! dock badge counting them until the user comes back.
//!
//! The page decides what is worth a banner and writes its text (connection,
//! tab, rows and time, never SQL, values or error text); here it shows only
//! when Rowkery isn't the active app. A click on a banner brings the window
//! forward and tells the page what the latest banner was about
//! (`notification-open`): macOS hands every click to the one delegate the
//! newest banner set, so the latest target is the one a click can name.
//! Whether banners show at all, and how, is up to System Settings ›
//! Notifications.

use std::sync::atomic::{AtomicI64, Ordering};
use std::sync::Mutex;

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager, Runtime, WebviewWindow};
use tauri_plugin_notification::NotificationExt;

/// Where a banner's click takes the user: a window's tab, or the proposals.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Target {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    window_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    tab_id: Option<u64>,
    /// A proposal's id: the click opens its review.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    proposal: Option<String>,
}

/// Banners shown since the user last came back (the dock badge), and what
/// the latest was about.
#[derive(Default)]
pub struct Away {
    count: AtomicI64,
    latest: Mutex<Option<Target>>,
}

/// Rowkery is the app in front. The key window alone would miss a save
/// panel or an alert of Rowkery's own being key.
#[cfg(target_os = "macos")]
fn in_front(window: &WebviewWindow) -> bool {
    match objc2::MainThreadMarker::new() {
        Some(mtm) => objc2_app_kit::NSApplication::sharedApplication(mtm).isActive(),
        None => window.is_focused().unwrap_or(true),
    }
}

#[cfg(not(target_os = "macos"))]
fn in_front(window: &WebviewWindow) -> bool {
    window.is_focused().unwrap_or(true)
}

/// Shows the banner unless Rowkery is in front. A sync command: it runs on
/// the main thread, as AppKit wants.
#[tauri::command]
pub fn notify_done(
    window: WebviewWindow,
    away: tauri::State<'_, Away>,
    title: String,
    body: String,
    target: Target,
) {
    if in_front(&window) {
        return;
    }
    let shown = window
        .app_handle()
        .notification()
        .builder()
        .title(title)
        .body(body)
        .show();
    if let Err(e) = shown {
        eprintln!("notification: {e}");
        return;
    }
    *away.latest.lock().unwrap_or_else(|e| e.into_inner()) = Some(target);
    let count = away.count.fetch_add(1, Ordering::Relaxed) + 1;
    let _ = window.set_badge_count(Some(count));
}

/// The user is back in Rowkery (focused it, or clicked its Dock icon): the
/// badge clears.
pub fn came_back<R: Runtime>(app: &AppHandle<R>) {
    let away = app.state::<Away>();
    if away.count.swap(0, Ordering::Relaxed) > 0 {
        if let Some(window) = app.get_webview_window("main") {
            let _ = window.set_badge_count(None);
        }
    }
}

/// A click on a banner: the window comes forward on what it was about.
pub fn listen<R: Runtime>(app: &AppHandle<R>) {
    let handle = app.clone();
    let _ = app.notification().on_action(move |performed| {
        if performed.action_id() != "tap" {
            return;
        }
        let target = handle
            .state::<Away>()
            .latest
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .take();
        let app = handle.clone();
        let _ = handle.run_on_main_thread(move || {
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.unminimize();
                let _ = window.show();
                let _ = window.set_focus();
            }
            if let Some(target) = target {
                let _ = app.emit("notification-open", target);
            }
        });
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_target_reads_as_the_page_sends_it_and_goes_back_the_same() {
        let sent = serde_json::json!({ "windowId": "w2", "tabId": 5 });
        let target: Target = serde_json::from_value(sent.clone()).unwrap();
        assert_eq!(target.window_id.as_deref(), Some("w2"));
        assert_eq!(serde_json::to_value(&target).unwrap(), sent);
        let proposal: Target =
            serde_json::from_value(serde_json::json!({ "proposal": "p1" })).unwrap();
        assert_eq!(proposal.proposal.as_deref(), Some("p1"));
    }
}
