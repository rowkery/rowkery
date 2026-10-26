//! "Tell me when it's done": a macOS banner when a long job finishes (or an
//! agent proposes a change) while Rowkery isn't the app in front, and the
//! dock badge counting them until the user comes back.
//!
//! The page decides what is worth a banner and writes its text (connection,
//! tab, rows and time, never SQL, values or error text); here it shows only
//! when the window isn't focused. A click on the banner brings the window
//! forward and tells the page which window and tab it was about
//! (`notification-open`). Whether banners show at all, and how, is up to
//! System Settings › Notifications.

use std::sync::atomic::{AtomicI32, AtomicI64, Ordering};

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

/// Banners shown since the user last came back: the dock badge.
#[derive(Default)]
pub struct Away {
    count: AtomicI64,
    next_id: AtomicI32,
}

/// Shows the banner unless Rowkery is in front; true when it showed.
#[tauri::command]
pub fn notify_done(
    window: WebviewWindow,
    away: tauri::State<'_, Away>,
    title: String,
    body: String,
    target: Target,
) -> bool {
    if window.is_focused().unwrap_or(true) {
        return false;
    }
    let id = away.next_id.fetch_add(1, Ordering::Relaxed) + 1;
    let shown = window
        .app_handle()
        .notification()
        .builder()
        .id(id)
        .title(title)
        .body(body)
        .extra("target", &target)
        .show();
    if let Err(e) = shown {
        eprintln!("notification: {e}");
        return false;
    }
    let count = away.count.fetch_add(1, Ordering::Relaxed) + 1;
    let _ = window.set_badge_count(Some(count));
    true
}

/// The user is back in Rowkery: the badge clears.
pub fn came_back<R: Runtime>(window: &tauri::Window<R>) {
    let away = window.state::<Away>();
    if away.count.swap(0, Ordering::Relaxed) > 0 {
        let _ = window.set_badge_count(None);
    }
}

/// A click on a banner: the window comes forward on what it was about.
pub fn listen<R: Runtime>(app: &AppHandle<R>) {
    let handle = app.clone();
    let _ = app.notification().on_action(move |performed| {
        if performed.action_id() != "tap" {
            return;
        }
        let target = performed
            .notification()
            .and_then(|n| n.extra().get("target").cloned())
            .and_then(|v| serde_json::from_value::<Target>(v).ok());
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
    fn a_target_reads_back_from_the_banner_as_the_page_sent_it() {
        let sent = serde_json::json!({ "windowId": "w2", "tabId": 5 });
        let target: Target = serde_json::from_value(sent.clone()).unwrap();
        assert_eq!(target.window_id.as_deref(), Some("w2"));
        assert_eq!(serde_json::to_value(&target).unwrap(), sent);
        let proposal: Target =
            serde_json::from_value(serde_json::json!({ "proposal": "p1" })).unwrap();
        assert_eq!(proposal.proposal.as_deref(), Some("p1"));
    }
}
