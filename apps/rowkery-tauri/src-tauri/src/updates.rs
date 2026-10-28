//! In-app updates: a quiet check after launch and Rowkery > Check for Updates….
//!
//! The page asks (`check_for_update`), and its update preference (Settings >
//! Updates, updates.ts) says whether a newer release is downloaded at once or
//! only announced until the user asks (`download_update`). A download is
//! checked against its signature, then held until the user picks Restart
//! (`restart_to_update`), the page restarts an idle app (Automatic), or the
//! user quits, which installs it for the next launch (`install_on_exit`).
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
use tauri::{AppHandle, Emitter, Manager, State, Url, WebviewWindow};
use tauri_plugin_updater::{Update, UpdaterExt};

/// The download is a few tens of MB; a slow link gets this long for the
/// feed and then the bundle.
const TIMEOUT: Duration = Duration::from_secs(300);

#[derive(Default)]
pub struct Updates {
    /// One check at a time: the quiet one and a menu pick share the result.
    checking: tauri::async_runtime::Mutex<()>,
    /// Found and not downloaded (Notify only), until the user asks.
    found: Mutex<Option<Update>>,
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
    /// Newer, not downloaded: the user downloads it (`download_update`).
    Available {
        version: String,
        notes: Option<String>,
    },
    Ready {
        version: String,
        notes: Option<String>,
    },
    /// Newer, but this copy can't be replaced where it runs (the disk
    /// image, a translocated copy): not downloaded, and `reason` says what
    /// to do.
    Misplaced {
        version: String,
        reason: String,
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

fn notes_of(update: &Update) -> Option<String> {
    update.body.clone().filter(|n| !n.trim().is_empty())
}

fn ready_status(update: &Update) -> UpdateStatus {
    UpdateStatus::Ready {
        version: update.version.clone(),
        notes: notes_of(update),
    }
}

fn misplaced_status(update: &Update, reason: &str) -> UpdateStatus {
    UpdateStatus::Misplaced {
        version: update.version.clone(),
        reason: reason.into(),
    }
}

fn available_status(update: &Update) -> UpdateStatus {
    UpdateStatus::Available {
        version: update.version.clone(),
        notes: notes_of(update),
    }
}

/// The feed's newer release, if any; `Ok(None)` when up to date, `Err(None)`
/// for a build without a feed (make dmg, dev).
async fn find(app: &AppHandle) -> Result<Option<Update>, Option<String>> {
    let mut builder = app.updater_builder().timeout(TIMEOUT);
    if let Some(url) = feed_override() {
        builder = builder
            .endpoints(vec![url])
            .map_err(|e| Some(e.to_string()))?;
    }
    let updater = match builder.build() {
        Ok(updater) => updater,
        Err(tauri_plugin_updater::Error::EmptyEndpoints) => return Err(None),
        Err(e) => return Err(Some(e.to_string())),
    };
    updater.check().await.map_err(|e| Some(e.to_string()))
}

/// Downloads `update` (`download` checks the signature against the pubkey in
/// tauri.conf.json) and holds it until a restart or quit installs it.
async fn download_and_hold(updates: &Updates, update: Update) -> Result<UpdateStatus, String> {
    let bytes = update
        .download(|_, _| {}, || {})
        .await
        .map_err(|e| e.to_string())?;
    let status = ready_status(&update);
    *updates.ready.lock().unwrap() = Some(Ready { update, bytes });
    Ok(status)
}

/// Asks the feed for a newer release and, unless `download` is false (Notify
/// only), downloads it. A second call while one runs waits for it; once an
/// update is ready, it answers at once.
#[tauri::command]
pub async fn check_for_update(
    app: AppHandle,
    updates: State<'_, Updates>,
    download: Option<bool>,
) -> Result<UpdateStatus, String> {
    if !enabled() {
        return Ok(UpdateStatus::Off);
    }
    let _one = updates.checking.lock().await;
    if let Some(ready) = updates.ready.lock().unwrap().as_ref() {
        return Ok(ready_status(&ready.update));
    }
    let update = match find(&app).await {
        Ok(Some(update)) => update,
        Ok(None) => {
            *updates.found.lock().unwrap() = None;
            return Ok(UpdateStatus::UpToDate {
                version: app.package_info().version.to_string(),
            });
        }
        Err(None) => return Ok(UpdateStatus::Off),
        Err(Some(e)) => return Err(e),
    };
    if let Some(reason) = crate::app_location::misplaced() {
        return Ok(misplaced_status(&update, reason));
    }
    if download == Some(false) {
        let status = available_status(&update);
        *updates.found.lock().unwrap() = Some(update);
        return Ok(status);
    }
    download_and_hold(&updates, update).await
}

/// Downloads the release `check_for_update` found (checking again if none
/// was kept): Notify only's Download.
#[tauri::command]
pub async fn download_update(
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
    let kept = updates.found.lock().unwrap().take();
    let update = match kept {
        Some(update) => update,
        None => match find(&app).await {
            Ok(Some(update)) => update,
            Ok(None) => {
                return Ok(UpdateStatus::UpToDate {
                    version: app.package_info().version.to_string(),
                })
            }
            Err(None) => return Ok(UpdateStatus::Off),
            Err(Some(e)) => return Err(e),
        },
    };
    if let Some(reason) = crate::app_location::misplaced() {
        return Ok(misplaced_status(&update, reason));
    }
    download_and_hold(&updates, update).await
}

/// Installs the downloaded update. A failed install keeps it, so Restart
/// can try again without downloading it again.
fn install_ready(updates: &Updates) -> Result<bool, String> {
    let Some(ready) = updates.ready.lock().unwrap().take() else {
        return Ok(false);
    };
    if let Err(e) = ready.update.install(&ready.bytes) {
        *updates.ready.lock().unwrap() = Some(ready);
        return Err(install_error(
            &e.to_string(),
            crate::app_location::misplaced(),
        ));
    }
    Ok(true)
}

/// What a failed install tells the user: where the app runs, when that's
/// the cause, else the updater's own words.
fn install_error(e: &str, misplaced: Option<&str>) -> String {
    misplaced.map_or_else(|| e.to_string(), str::to_string)
}

/// Restart into the downloaded update. The page asks only when no query
/// runs; work it can't see (a commit, an import, a SQL file, an open
/// transaction) gets the quit dialog first. The answer comes before that
/// dialog, so a failed install reaches the window that asked as
/// `update-install-failed`.
#[tauri::command]
pub fn restart_to_update(
    app: AppHandle,
    window: WebviewWindow,
    updates: State<'_, Updates>,
) -> Result<(), String> {
    if updates.ready.lock().unwrap().is_none() {
        return Err("No update is ready".into());
    }
    let restart = app.clone();
    let asked = window.label().to_string();
    crate::ask_before_quit(&app, "Restart", move || {
        match install_ready(&restart.state::<Updates>()) {
            Ok(true) => restart.restart(),
            Ok(false) => {}
            Err(e) => {
                eprintln!("update: couldn't install: {e}");
                let _ = restart.emit_to(asked.as_str(), "update-install-failed", e);
            }
        }
    });
    Ok(())
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
    fn a_failed_install_names_the_location_when_that_is_why() {
        let dmg = "Rowkery is running from the disk image. Move it to Applications, open it from there, and try again.";
        assert_eq!(
            install_error("Read-only file system (os error 30)", Some(dmg)),
            dmg
        );
        assert_eq!(
            install_error("Failed to move the new app into place", None),
            "Failed to move the new app into place"
        );
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
        let json = serde_json::to_value(UpdateStatus::Available {
            version: "0.1.2".into(),
            notes: None,
        })
        .unwrap();
        assert_eq!(
            json,
            serde_json::json!({ "status": "available", "version": "0.1.2", "notes": null })
        );
        let json = serde_json::to_value(UpdateStatus::Misplaced {
            version: "0.1.2".into(),
            reason: "Move it".into(),
        })
        .unwrap();
        assert_eq!(
            json,
            serde_json::json!({ "status": "misplaced", "version": "0.1.2", "reason": "Move it" })
        );
    }
}
