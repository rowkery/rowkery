//! One JSON line per tool call in `mcp-log.jsonl` beside `config.json`:
//! time, tool, the arguments as sent, connection, database, what was shared
//! then, SQL, rows, ms (the query's own run), how long the whole call took,
//! response size and the verdict. Never result rows (`samples` keeps a
//! short, expiring start of each response). The app reads it back
//! (`read_since`) for ⌘K MCP activity.

use std::fs::{File, OpenOptions};
use std::io::{Read, Seek, SeekFrom, Write};
use std::path::PathBuf;
use std::sync::OnceLock;
use std::time::{SystemTime, UNIX_EPOCH};

use rowkery_core::config::config_dir;
use serde::{Deserialize, Serialize};

const LOG_FILE: &str = "mcp-log.jsonl";
/// Past this size the log moves to `mcp-log.1.jsonl` (replacing the last one).
const ROTATE_BYTES: u64 = 8 * 1024 * 1024;
/// A first read (or a read after the log moved) starts this far from the end.
const TAIL_BYTES: u64 = 512 * 1024;
/// At most this many entries come back from one read.
const MAX_ENTRIES: usize = 1000;

#[derive(Debug, Default, Clone, Serialize, Deserialize)]
pub struct Entry {
    /// Unix time in milliseconds.
    pub ts: u64,
    pub tool: String,
    /// When this server process started (ms): one value per agent session.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub session: Option<u64>,
    /// The MCP client's own name (`claude-code`, …), from its handshake.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub client: Option<String>,
    /// The connection's id once resolved; what the client wrote otherwise.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub connection: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub database: Option<String>,
    /// describe_table's table, search_schema's text.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub target: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub sql: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub rows: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub ms: Option<u64>,
    /// The whole call, from the request arriving to the answer being ready.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub took_ms: Option<u64>,
    /// `ok`, `would refuse`, or the refusal / error text.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub verdict: Option<String>,
    /// The arguments exactly as the agent sent them (a string, cut, past 4 KB).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub args: Option<serde_json::Value>,
    /// What was shared when the call ran (`access::Tables::scope`).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub scope: Option<serde_json::Value>,
    /// Size of the response text the agent got.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub bytes: Option<u64>,
    /// A random key the call's "Open in Rowkery" link carries, so a web page
    /// can't guess a link to it (`views`).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub link_key: Option<String>,
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

/// This process's start, the `session` every entry it writes carries.
fn session() -> u64 {
    static STARTED: OnceLock<u64> = OnceLock::new();
    *STARTED.get_or_init(now_ms)
}

/// Now, but never the same as an earlier entry of this process, so
/// (`session`, `ts`) names one entry (its result sample is found by it).
fn unique_ms() -> u64 {
    use std::sync::atomic::{AtomicU64, Ordering};
    static LAST: AtomicU64 = AtomicU64::new(0);
    let now = now_ms();
    let prev = LAST
        .fetch_update(Ordering::SeqCst, Ordering::SeqCst, |last| {
            Some(now.max(last + 1))
        })
        .unwrap_or(0);
    now.max(prev + 1)
}

impl Entry {
    pub fn new(tool: &str) -> Self {
        Self {
            ts: unique_ms(),
            tool: tool.to_string(),
            session: Some(session()),
            ..Self::default()
        }
    }

    /// Gives the call a link key, so a view can open it in Rowkery.
    pub fn add_link_key(&mut self) {
        self.link_key = Some(rowkery_core::secrets::random_hex(16));
    }

    /// `session-ts-key`: what a view's "Open in Rowkery" link names the call by.
    pub fn call_id(&self) -> Option<String> {
        Some(format!(
            "{}-{}-{}",
            self.session?,
            self.ts,
            self.link_key.as_deref()?
        ))
    }
}

fn log_path() -> PathBuf {
    config_dir().join(LOG_FILE)
}

/// Best effort: a log that can't be written never fails the call.
pub fn append(entry: &Entry) {
    let dir = config_dir();
    if std::fs::create_dir_all(&dir).is_err() {
        return;
    }
    let Ok(mut line) = serde_json::to_string(entry) else {
        return;
    };
    line.push('\n');
    let path = dir.join(LOG_FILE);
    if std::fs::metadata(&path).is_ok_and(|m| m.len() > ROTATE_BYTES) {
        let _ = std::fs::rename(&path, dir.join("mcp-log.1.jsonl"));
    }
    if let Ok(mut file) = OpenOptions::new().create(true).append(true).open(path) {
        let _ = file.write_all(line.as_bytes());
    }
}

/// Entries written since `offset`, and the offset to ask from next time.
#[derive(Debug, Default, Serialize)]
pub struct Activity {
    pub entries: Vec<Entry>,
    pub offset: u64,
    /// The log started over (first read, cleared or moved): replace, don't append.
    pub reset: bool,
}

/// Reads complete lines after `offset`. With no offset, or one past the end
/// (the log was cleared or moved), it reads the last `TAIL_BYTES` instead.
pub fn read_since(offset: Option<u64>) -> Activity {
    read_file(&log_path(), offset)
}

fn read_file(path: &std::path::Path, offset: Option<u64>) -> Activity {
    let Ok(mut file) = File::open(path) else {
        return Activity {
            reset: true,
            ..Activity::default()
        };
    };
    let len = file.metadata().map(|m| m.len()).unwrap_or(0);
    let (start, reset) = match offset {
        Some(o) if o <= len => (o, false),
        _ => (len.saturating_sub(TAIL_BYTES), true),
    };
    if start == len {
        return Activity {
            entries: Vec::new(),
            offset: len,
            reset,
        };
    }
    let mut buf = Vec::with_capacity((len - start) as usize);
    if file.seek(SeekFrom::Start(start)).is_err() || file.read_to_end(&mut buf).is_err() {
        return Activity {
            entries: Vec::new(),
            offset: start,
            reset,
        };
    }
    // Only whole lines; a line still being written waits for the next read.
    let Some(end) = buf.iter().rposition(|&b| b == b'\n') else {
        return Activity {
            entries: Vec::new(),
            offset: start,
            reset,
        };
    };
    let mut body = &buf[..=end];
    // A tail read can start mid-line: drop that partial first line.
    if reset && start > 0 {
        match body.iter().position(|&b| b == b'\n') {
            Some(i) => body = &body[i + 1..],
            None => body = &[],
        }
    }
    let mut entries: Vec<Entry> = body
        .split(|&b| b == b'\n')
        .filter(|l| !l.is_empty())
        .filter_map(|l| serde_json::from_slice(l).ok())
        .collect();
    if entries.len() > MAX_ENTRIES {
        entries.drain(..entries.len() - MAX_ENTRIES);
    }
    Activity {
        entries,
        offset: start + end as u64 + 1,
        reset,
    }
}

/// The logged call a view's link names (`Entry::call_id`), from the log
/// or the one it moved to. A wrong key finds nothing.
pub fn find_call(id: &str) -> Option<Entry> {
    let mut parts = id.splitn(3, '-');
    let session: u64 = parts.next()?.parse().ok()?;
    let ts: u64 = parts.next()?.parse().ok()?;
    let key = parts.next()?;
    let dir = config_dir();
    [dir.join(LOG_FILE), dir.join("mcp-log.1.jsonl")]
        .iter()
        .filter_map(|path| std::fs::read(path).ok())
        .find_map(|bytes| {
            bytes
                .split(|&b| b == b'\n')
                .filter_map(|l| serde_json::from_slice::<Entry>(l).ok())
                .find(|e| {
                    e.session == Some(session) && e.ts == ts && e.link_key.as_deref() == Some(key)
                })
        })
}

/// Empties the log (⌘K MCP activity > Clear log).
pub fn clear() -> std::io::Result<()> {
    crate::samples::clear()?;
    let path = log_path();
    let _ = std::fs::remove_file(config_dir().join("mcp-log.1.jsonl"));
    match File::create(path) {
        Ok(_) => Ok(()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(e) => Err(e),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn line(tool: &str, ts: u64) -> String {
        let mut e = Entry::new(tool);
        e.ts = ts;
        format!("{}\n", serde_json::to_string(&e).unwrap())
    }

    #[test]
    fn entries_of_one_process_never_share_a_time() {
        let a = Entry::new("query");
        let b = Entry::new("query");
        assert!(b.ts > a.ts);
        assert_eq!(a.session, b.session);
    }

    #[test]
    fn reads_whole_lines_and_continues_from_the_offset() {
        let dir = std::env::temp_dir().join(format!("rowkery-audit-{}", now_ms()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join(LOG_FILE);
        std::fs::write(
            &path,
            format!("{}{}{{\"ts\":3,\"to", line("a", 1), line("b", 2)),
        )
        .unwrap();

        let first = read_file(&path, None);
        assert!(first.reset);
        assert_eq!(
            first
                .entries
                .iter()
                .map(|e| e.tool.as_str())
                .collect::<Vec<_>>(),
            ["a", "b"]
        );

        // The half-written line finishes; the next read picks up only it.
        let mut f = OpenOptions::new().append(true).open(&path).unwrap();
        f.write_all(b"ol\":\"c\"}\n").unwrap();
        let next = read_file(&path, Some(first.offset));
        assert!(!next.reset);
        assert_eq!(next.entries.len(), 1);
        assert_eq!(next.entries[0].tool, "c");

        // Cleared: the old offset is past the end, so it starts over.
        std::fs::write(&path, "").unwrap();
        let after = read_file(&path, Some(next.offset));
        assert!(after.reset);
        assert!(after.entries.is_empty());
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn a_tail_read_skips_the_partial_first_line() {
        let dir = std::env::temp_dir().join(format!("rowkery-audit-tail-{}", now_ms()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join(LOG_FILE);
        let mut text = String::new();
        let mut n = 0;
        while (text.len() as u64) < TAIL_BYTES + 4096 {
            text.push_str(&line("query", n));
            n += 1;
        }
        std::fs::write(&path, &text).unwrap();
        let read = read_file(&path, None);
        assert!(!read.entries.is_empty());
        assert!(read.entries.len() <= MAX_ENTRIES);
        assert_eq!(read.entries.last().unwrap().ts, n - 1);
        assert_eq!(read.offset, text.len() as u64);
        let _ = std::fs::remove_dir_all(dir);
    }
}
