//! In-app updates: a quiet check after launch and Rowkery > Check for Updates….
//!
//! The page asks (`check_for_update`). A newer release announced by the feed
//! is downloaded and checked against its signature, then held until the user
//! picks Restart (`restart_to_update`) or quits, which installs it for the next
//! launch (`install_on_exit`). Nothing restarts on its own.
//!
//! The feed is the latest GitHub release's latest.json on the public repo
//! (github.com/rowkery/rowkery/releases/latest/download/latest.json), whose
//! bundle URL names that release's tag; `scripts/release.sh` builds it into
//! `plugins.updater.endpoints`. A build without one (make dmg, dev) doesn't
//! update itself. Debug builds and proof runs never check, unless
//! `ROWKERY_UPDATE_URL` names a feed (scripts/update-rehearsal.sh).
//! `ROWKERY_UPDATES=0` turns checking off.

use std::sync::Mutex;
use std::time::Duration;

use serde::Serialize;
use tauri::{AppHandle, State, Url};
use tauri_plugin_updater::{Update, UpdaterExt};

/// The download is a few tens of MB; a slow link gets this long for the
/// feed and then the bundle.
const TIMEOUT: Duration = Duration::from_secs(300);

#[derive(Default)]
pub struct Updates {
    /// One check at a time: the quiet one and a menu pick share the result.
    checking: tauri::async_runtime::Mutex<()>,
    ready: Mutex<Option<Ready>>,
}

/// A verified update, downloaded and not yet installed.
struct Ready {
    update: Update,
    bytes: Vec<u8>,
}

#[derive(Debug, Serialize, PartialEq)]
#[serde(tag = "status", rename_all = "kebab-case")]
pub enum UpdateStatus {
    /// This build doesn't check (a debug build, a proof run, `ROWKERY_UPDATES=0`).
    Off,
    UpToDate {
        version: String,
    },
    Ready {
        version: String,
        notes: Option<String>,
    },
}

fn feed_override() -> Option<Url> {
    std::env::var("ROWKERY_UPDATE_URL")
        .ok()
        .and_then(|u| Url::parse(u.trim()).ok())
}

fn checks(debug: bool, feed_override: bool, updates_env: Option<&str>, proof: bool) -> bool {
    if updates_env == Some("0") {
        return false;
    }
    feed_override || (!debug && !proof)
}

fn enabled() -> bool {
    let proof = crate::timings::ProofEnv::from_env().is_some()
        || std::env::var_os("ROWKERY_TIMINGS_OUT").is_some();
    checks(
        cfg!(debug_assertions),
        feed_override().is_some(),
        std::env::var("ROWKERY_UPDATES").ok().as_deref(),
        proof,
    )
}

fn ready_status(update: &Update) -> UpdateStatus {
    UpdateStatus::Ready {
        version: update.version.clone(),
        notes: update.body.clone().filter(|n| !n.trim().is_empty()),
    }
}

/// Asks the feed for a newer release and downloads it. A second call while one
/// runs waits for it; once an update is ready, it answers at once.
#[tauri::command]
pub async fn check_for_update(
    app: AppHandle,
    updates: State<'_, Updates>,
) -> Result<UpdateStatus, String> {
    if !enabled() {
        return Ok(UpdateStatus::Off);
    }
    let _one = updates.checking.lock().await;
    if let Some(ready) = updates.ready.lock().unwrap().as_ref() {
        return Ok(ready_status(&ready.update));
    }
    let mut builder = app.updater_builder().timeout(TIMEOUT);
    if let Some(url) = feed_override() {
        builder = builder.endpoints(vec![url]).map_err(|e| e.to_string())?;
    }
    let updater = match builder.build() {
        Ok(updater) => updater,
        // Built without a feed (make dmg, dev): this build doesn't update itself.
        Err(tauri_plugin_updater::Error::EmptyEndpoints) => return Ok(UpdateStatus::Off),
        Err(e) => return Err(e.to_string()),
    };
    let Some(update) = updater.check().await.map_err(|e| e.to_string())? else {
        return Ok(UpdateStatus::UpToDate {
            version: app.package_info().version.to_string(),
        });
    };
    // `download` checks the signature against the pubkey in tauri.conf.json.
    let bytes = update
        .download(|_, _| {}, || {})
        .await
        .map_err(|e| e.to_string())?;
    let status = ready_status(&update);
    *updates.ready.lock().unwrap() = Some(Ready { update, bytes });
    Ok(status)
}

fn install_ready(updates: &Updates) -> Result<bool, String> {
    let Some(ready) = updates.ready.lock().unwrap().take() else {
        return Ok(false);
    };
    ready
        .update
        .install(&ready.bytes)
        .map_err(|e| e.to_string())?;
    Ok(true)
}

/// Restart into the downloaded update. The page asks only when nothing runs.
#[tauri::command]
pub fn restart_to_update(app: AppHandle, updates: State<'_, Updates>) -> Result<(), String> {
    if !install_ready(&updates)? {
        return Err("No update is ready".into());
    }
    app.restart()
}

/// Quitting with an update downloaded installs it, so the next launch runs it.
pub fn install_on_exit(updates: &Updates) {
    if let Err(e) = install_ready(updates) {
        eprintln!("update: couldn't install on quit: {e}");
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn release_builds_check_and_proofs_and_debug_builds_do_not() {
        assert!(checks(false, false, None, false));
        assert!(!checks(true, false, None, false));
        assert!(!checks(false, false, None, true));
    }

    #[test]
    fn a_feed_override_checks_anywhere_unless_updates_are_off() {
        assert!(checks(true, true, None, true));
        assert!(!checks(true, true, Some("0"), false));
        assert!(!checks(false, false, Some("0"), false));
        assert!(checks(false, false, Some("1"), false));
    }

    #[test]
    fn the_status_is_tagged_for_the_page() {
        let json = serde_json::to_value(UpdateStatus::UpToDate {
            version: "0.1.0".into(),
        })
        .unwrap();
        assert_eq!(
            json,
            serde_json::json!({ "status": "up-to-date", "version": "0.1.0" })
        );
        let json = serde_json::to_value(UpdateStatus::Off).unwrap();
        assert_eq!(json, serde_json::json!({ "status": "off" }));
    }
}
