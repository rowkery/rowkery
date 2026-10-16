//! The start of what each tool call sent back, so the Agents page can show
//! the response beside the request: the first `SAMPLE_BYTES` of the text and
//! its full size, kept in `mcp-samples.jsonl` beside the config for 24
//! hours. The audit log itself never holds rows. Connections with
//! `mcp_samples_off` keep none.

use std::fs::OpenOptions;
use std::io::Write;
use std::path::PathBuf;

use rowkery_core::config::config_dir;
use serde::{Deserialize, Serialize};
use serde_json::Value as Json;

const SAMPLES_FILE: &str = "mcp-samples.jsonl";
/// Bytes of each response kept.
pub const SAMPLE_BYTES: usize = 512;
/// Samples older than this are dropped.
pub const KEEP_MS: u64 = 24 * 60 * 60 * 1000;
/// Past this size the oldest half of the file is dropped.
const MAX_BYTES: u64 = 2 * 1024 * 1024;

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Sample {
    /// The audit entry this belongs to: its `session` and `ts`.
    pub session: u64,
    pub ts: u64,
    /// The first `SAMPLE_BYTES` of the response text, cut on a character.
    #[serde(default)]
    pub text: String,
    /// The response's full size.
    #[serde(default)]
    pub bytes: u64,
    /// Samples written before `text`: the first rows of a query.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub columns: Vec<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub rows: Vec<Vec<Json>>,
}

fn path() -> PathBuf {
    config_dir().join(SAMPLES_FILE)
}

/// The sample of one response: its start and its size.
pub fn shape(session: u64, ts: u64, text: &str) -> Sample {
    let mut end = text.len().min(SAMPLE_BYTES);
    while !text.is_char_boundary(end) {
        end -= 1;
    }
    Sample {
        session,
        ts,
        text: text[..end].to_string(),
        bytes: text.len() as u64,
        columns: Vec::new(),
        rows: Vec::new(),
    }
}

fn read_all(now: u64) -> (Vec<Sample>, bool) {
    let Ok(text) = std::fs::read_to_string(path()) else {
        return (Vec::new(), false);
    };
    let mut expired = false;
    let list = text
        .lines()
        .filter_map(|l| serde_json::from_str::<Sample>(l).ok())
        .filter(|s| {
            let fresh = now.saturating_sub(s.ts) < KEEP_MS;
            expired |= !fresh;
            fresh
        })
        .collect();
    (list, expired)
}

fn rewrite(list: &[Sample]) {
    let text: String = list
        .iter()
        .filter_map(|s| serde_json::to_string(s).ok())
        .map(|l| l + "\n")
        .collect();
    let tmp = path().with_extension("jsonl.tmp");
    if std::fs::write(&tmp, text).is_ok() {
        let _ = std::fs::rename(tmp, path());
    }
}

/// Best effort, like the audit log: a sample that can't be written never
/// fails the call. Expired samples are dropped on the way.
pub fn save(sample: &Sample, now: u64) {
    if std::fs::create_dir_all(config_dir()).is_err() {
        return;
    }
    let size = std::fs::metadata(path()).map(|m| m.len()).unwrap_or(0);
    let (mut list, expired) = read_all(now);
    if expired || size > MAX_BYTES {
        if size > MAX_BYTES {
            list.drain(..list.len() / 2);
        }
        list.push(sample.clone());
        rewrite(&list);
        return;
    }
    let Ok(line) = serde_json::to_string(sample) else {
        return;
    };
    if let Ok(mut file) = OpenOptions::new().create(true).append(true).open(path()) {
        let _ = file.write_all(format!("{line}\n").as_bytes());
    }
}

/// The sample kept for the audit entry `session` / `ts`, if it hasn't expired.
pub fn find(session: u64, ts: u64, now: u64) -> Option<Sample> {
    let (list, expired) = read_all(now);
    if expired {
        rewrite(&list);
    }
    list.into_iter()
        .find(|s| s.session == session && s.ts == ts)
}

/// Deletes every sample (Clear log).
pub fn clear() -> std::io::Result<()> {
    match std::fs::remove_file(path()) {
        Err(e) if e.kind() != std::io::ErrorKind::NotFound => Err(e),
        _ => Ok(()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_sample_keeps_the_start_of_the_response_and_its_size() {
        let text = format!("{{\"rows\":\"{}\"}}", "é".repeat(400));
        let s = shape(7, 42, &text);
        assert!(s.text.len() <= SAMPLE_BYTES);
        assert!(s.text.len() >= SAMPLE_BYTES - 1);
        assert!(text.starts_with(&s.text));
        assert_eq!(s.bytes, text.len() as u64);
        assert_eq!(shape(1, 1, "{}").text, "{}");
    }

    #[test]
    fn samples_are_found_by_entry_and_expire_after_a_day() {
        let dir = std::env::temp_dir().join(format!("rowkery-mcp-samples-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        let _env = crate::ENV_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        std::env::set_var("ROWKERY_CONFIG_DIR", dir.to_string_lossy().to_string());

        let day = KEEP_MS;
        save(&shape(1, 1_000, "[1]"), 1_000);
        save(&shape(1, 2_000, "[2]"), 2_000);
        assert_eq!(find(1, 2_000, 2_000).unwrap().text, "[2]");
        assert!(find(2, 2_000, 2_000).is_none());

        // A day later the first is gone, from the file too; the second stays.
        assert!(find(1, 1_000, 1_000 + day).is_none());
        let text = std::fs::read_to_string(dir.join(SAMPLES_FILE)).unwrap();
        assert_eq!(text.lines().count(), 1);
        assert!(find(1, 2_000, 1_000 + day).is_some());

        clear().unwrap();
        assert!(find(1, 2_000, 2_000).is_none());
        clear().unwrap();
        let _ = std::fs::remove_dir_all(dir);
        std::env::remove_var("ROWKERY_CONFIG_DIR");
    }
}
