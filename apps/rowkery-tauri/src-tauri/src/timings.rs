//! Latency marks from process start. `main` captures the start before
//! anything else; the webview reads it with `timings_origin` and back-dates
//! its `process-start` mark (an `Instant` can't cross IPC, the epoch can).
//! With `ROWKERY_TIMINGS_OUT=<file>` both sides append their marks there as
//! JSON lines, which `scripts/latency-proof.sh` checks against
//! `scripts/budgets.json`.

use std::fs::{File, OpenOptions};
use std::io::{self, Write};
use std::sync::Mutex;
use std::time::{Instant, SystemTime, UNIX_EPOCH};

use serde::Serialize;
use serde_json::{json, Value};

pub struct Timings {
    start: Instant,
    start_epoch_ms: f64,
    out: Option<Mutex<File>>,
    /// Every Rust-side mark, for the Timings sheet (a handful, at launch).
    marks: Mutex<Vec<(String, f64)>>,
}

impl Timings {
    /// Call first thing in `main`.
    pub fn start() -> Self {
        let start = Instant::now();
        let start_epoch_ms = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|d| d.as_secs_f64() * 1000.0)
            .unwrap_or(0.0);
        Self {
            start,
            start_epoch_ms,
            out: None,
            marks: Mutex::default(),
        }
    }

    /// Starts recording to `path` (appends), with the `process-start` mark.
    pub fn record_to(&mut self, path: &str) -> io::Result<()> {
        let file = OpenOptions::new().create(true).append(true).open(path)?;
        self.out = Some(Mutex::new(file));
        self.write(&[json!({
            "mark": "process-start",
            "t": 0.0,
            "epoch_ms": self.start_epoch_ms,
            "source": "rust",
        })])
    }

    pub fn recording(&self) -> bool {
        self.out.is_some()
    }

    pub fn start_epoch_ms(&self) -> f64 {
        self.start_epoch_ms
    }

    /// ms since process start, to 0.1 ms.
    pub fn since_start(&self) -> f64 {
        (self.start.elapsed().as_secs_f64() * 10_000.0).round() / 10.0
    }

    /// A Rust-side mark, now.
    pub fn mark(&self, name: &str) {
        self.mark_at(name, Instant::now());
    }

    /// A Rust-side mark at `at` (something that happened on another thread).
    pub fn mark_at(&self, name: &str, at: Instant) {
        let t = (at.saturating_duration_since(self.start).as_secs_f64() * 10_000.0).round() / 10.0;
        if let Ok(mut marks) = self.marks.lock() {
            marks.push((name.to_string(), t));
        }
        if self.out.is_some() {
            let _ = self.write(&[json!({ "mark": name, "t": t, "source": "rust" })]);
        }
    }

    /// The Rust-side marks so far, in the order taken.
    pub fn marks(&self) -> Vec<(String, f64)> {
        self.marks.lock().map(|m| m.clone()).unwrap_or_default()
    }

    /// Appends one JSON line per entry; no-op unless recording.
    pub fn write(&self, lines: &[Value]) -> io::Result<()> {
        let Some(out) = &self.out else {
            return Ok(());
        };
        let mut buf = Vec::new();
        for line in lines {
            serde_json::to_writer(&mut buf, line)?;
            buf.push(b'\n');
        }
        let mut file = out
            .lock()
            .map_err(|_| io::Error::other("timings file lock"))?;
        file.write_all(&buf)
    }
}

/// Proof automation read from the environment by `latency-proof.sh` runs.
#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct ProofEnv {
    /// `ROWKERY_AUTO_RUN_SQL`, split into statements on `;`.
    pub run_sql: Vec<String>,
    /// `ROWKERY_AUTO_BROWSE_TABLE` as `schema.table`.
    pub browse_table: Option<String>,
}

impl ProofEnv {
    /// Read only in debug builds and in builds made for a proof
    /// (`VITE_ROWKERY_AUTO_PROOF` set at build time, as `latency-proof.sh`
    /// does), so a shipped app never takes SQL from its environment.
    pub fn from_env() -> Option<Self> {
        if !cfg!(debug_assertions) && option_env!("VITE_ROWKERY_AUTO_PROOF").is_none() {
            return None;
        }
        Self::from_values(
            std::env::var("ROWKERY_AUTO_RUN_SQL").ok(),
            std::env::var("ROWKERY_AUTO_BROWSE_TABLE").ok(),
        )
    }

    fn from_values(sql: Option<String>, table: Option<String>) -> Option<Self> {
        let run_sql: Vec<String> = sql
            .unwrap_or_default()
            .split(';')
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .map(|s| format!("{s};"))
            .collect();
        let browse_table = table.filter(|t| !t.trim().is_empty());
        (!run_sql.is_empty() || browse_table.is_some()).then_some(Self {
            run_sql,
            browse_table,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn records_json_lines_from_process_start() {
        let dir = std::env::temp_dir().join(format!("rowkery-timings-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("t.jsonl");
        let _ = std::fs::remove_file(&path);
        let mut t = Timings::start();
        assert!(!t.recording());
        t.mark("ignored");
        t.record_to(path.to_str().unwrap()).unwrap();
        t.mark("bridge-spawned");
        t.write(&[json!({ "mark": "shell-painted", "t": 120.5 })])
            .unwrap();
        let text = std::fs::read_to_string(&path).unwrap();
        let marks: Vec<Value> = text
            .lines()
            .map(|l| serde_json::from_str(l).unwrap())
            .collect();
        let names: Vec<&str> = marks.iter().map(|m| m["mark"].as_str().unwrap()).collect();
        assert_eq!(names, ["process-start", "bridge-spawned", "shell-painted"]);
        assert!(marks[0]["epoch_ms"].as_f64().unwrap() > 1.6e12);
        assert!(marks[1]["t"].as_f64().unwrap() >= 0.0);
        // Kept in memory too, recording or not, for the Timings sheet.
        let kept: Vec<String> = t.marks().into_iter().map(|(m, _)| m).collect();
        assert_eq!(kept, ["ignored", "bridge-spawned"]);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn proof_env_splits_statements() {
        assert_eq!(ProofEnv::from_values(None, None), None);
        let env = ProofEnv::from_values(
            Some("SELECT 1; select * from t ;\n".into()),
            Some("public.kiosks".into()),
        )
        .unwrap();
        assert_eq!(env.run_sql, ["SELECT 1;", "select * from t;"]);
        assert_eq!(env.browse_table.as_deref(), Some("public.kiosks"));
        assert_eq!(
            ProofEnv::from_values(Some(" ; ".into()), Some(" ".into())),
            None
        );
    }
}
