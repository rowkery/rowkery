//! Writes `config.json` on a thread of its own, so no caller (and never the
//! bridge's core thread) waits on the disk.
//!
//! Two kinds of change reach it: the app config (connections, theme), sent as
//! a numbered snapshot when it changes, and the webview's UI state (windows,
//! tabs, SQL, widths, pins, history…), an opaque JSON blob sent as often as
//! the webview likes. UI state is written at most once per [`DEBOUNCE`]; a
//! config snapshot asked for with `write_config` is written at once and its
//! result returned, so a failed save still reaches the user. Every write is a
//! temp file renamed over `config.json`: a crash mid-write leaves the old file.

use std::sync::mpsc;
use std::thread;
use std::time::{Duration, Instant};

use crate::config::{AppConfig, ConfigError};

/// UI state changes within this window share one write.
pub const DEBOUNCE: Duration = Duration::from_millis(500);

enum Msg {
    Config {
        seq: u64,
        config: AppConfig,
        done: Option<mpsc::Sender<Result<(), String>>>,
    },
    Ui(serde_json::Value),
    Flush(mpsc::Sender<()>),
}

#[derive(Clone)]
pub struct ConfigWriter {
    tx: mpsc::Sender<Msg>,
}

impl ConfigWriter {
    /// Starts the writer from the config as loaded (its `ui` included).
    pub fn spawn(initial: AppConfig) -> Self {
        let (tx, rx) = mpsc::channel();
        thread::Builder::new()
            .name("rowkery-config-writer".into())
            .spawn(move || run(initial, rx))
            .expect("spawn config writer");
        Self { tx }
    }

    /// Writes this config snapshot now and waits for the result. `seq` orders
    /// snapshots: one older than the last written is skipped (two saves racing
    /// from different threads can't put an older config back).
    pub fn write_config(&self, seq: u64, config: AppConfig) -> Result<(), ConfigError> {
        let (done, wait) = mpsc::channel();
        self.tx
            .send(Msg::Config {
                seq,
                config,
                done: Some(done),
            })
            .map_err(|_| ConfigError::Message("config writer stopped".into()))?;
        wait.recv()
            .map_err(|_| ConfigError::Message("config writer stopped".into()))?
            .map_err(ConfigError::Message)
    }

    /// Replaces the UI state; written within [`DEBOUNCE`]. Returns at once.
    pub fn publish_ui(&self, ui: serde_json::Value) {
        let _ = self.tx.send(Msg::Ui(ui));
    }

    /// Writes anything pending now (app exit) and waits for it.
    pub fn flush(&self) {
        let (done, wait) = mpsc::channel();
        if self.tx.send(Msg::Flush(done)).is_ok() {
            let _ = wait.recv();
        }
    }
}

fn run(mut current: AppConfig, rx: mpsc::Receiver<Msg>) {
    let mut written_seq = 0u64;
    // When pending UI state was first published; None when nothing waits.
    let mut dirty_since: Option<Instant> = None;
    loop {
        let msg = match dirty_since {
            None => match rx.recv() {
                Ok(m) => m,
                Err(_) => return,
            },
            Some(since) => {
                let left = DEBOUNCE.saturating_sub(since.elapsed());
                match rx.recv_timeout(left) {
                    Ok(m) => m,
                    Err(mpsc::RecvTimeoutError::Timeout) => {
                        if let Err(e) = current.save() {
                            eprintln!("config: {e}");
                        }
                        dirty_since = None;
                        continue;
                    }
                    Err(mpsc::RecvTimeoutError::Disconnected) => {
                        let _ = current.save();
                        return;
                    }
                }
            }
        };
        match msg {
            Msg::Ui(ui) => {
                current.ui = Some(ui);
                dirty_since.get_or_insert_with(Instant::now);
            }
            Msg::Config { seq, config, done } => {
                let result = if seq < written_seq {
                    Ok(())
                } else {
                    written_seq = seq;
                    let ui = current.ui.take();
                    current = AppConfig { ui, ..config };
                    // This write carries any pending UI state too.
                    dirty_since = None;
                    current.save().map_err(|e| e.to_string())
                };
                if let Some(done) = done {
                    let _ = done.send(result);
                }
            }
            Msg::Flush(done) => {
                if dirty_since.take().is_some() {
                    let _ = current.save();
                }
                let _ = done.send(());
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::config::{config_path, test_dir_guard};
    use serde_json::json;

    fn on_disk() -> AppConfig {
        AppConfig::load().expect("load")
    }

    #[test]
    fn ui_state_is_debounced_and_config_written_at_once() {
        let _guard = test_dir_guard("writer");
        let writer = ConfigWriter::spawn(AppConfig::default());
        writer.publish_ui(json!({ "v": 1 }));
        writer.publish_ui(json!({ "v": 2 }));
        // Not yet: the debounce hasn't passed.
        assert!(!config_path().exists());
        std::thread::sleep(DEBOUNCE + Duration::from_millis(200));
        assert_eq!(on_disk().ui, Some(json!({ "v": 2 })));

        // A config snapshot is written now and keeps the UI state.
        let config = AppConfig {
            theme: crate::config::ThemePreference::Dark,
            ..AppConfig::default()
        };
        writer.write_config(1, config).expect("write");
        let back = on_disk();
        assert_eq!(back.theme, crate::config::ThemePreference::Dark);
        assert_eq!(back.ui, Some(json!({ "v": 2 })));

        // An older snapshot can't overwrite a newer one.
        writer.write_config(0, AppConfig::default()).expect("stale");
        assert_eq!(on_disk().theme, crate::config::ThemePreference::Dark);

        // Flush writes pending UI state before the debounce ends.
        writer.publish_ui(json!({ "v": 3 }));
        writer.flush();
        assert_eq!(on_disk().ui, Some(json!({ "v": 3 })));
    }
}
