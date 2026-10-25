//! Changes an agent proposes and only the user commits.
//!
//! `propose_change` (in the MCP process) checks a change (`change::check`)
//! and appends it to `proposals.jsonl` beside `config.json`; the agent
//! never gets a session that can write. The app lists what is waiting,
//! previews each change in a transaction it rolls back (`dry_run`), and on
//! the user's click checks it again and runs it for real (`commit`), only
//! if every statement changes as many rows as the dry run showed. Decisions
//! go to `proposal-outcomes.jsonl`, which `check_proposal` reads. A
//! proposal nobody decides on expires after a day.
//!
//! The queue file is anyone's to append to, so the app trusts nothing in it:
//! the connection, the tables and the SQL are checked again before the
//! preview and again before the commit.

use std::collections::HashMap;
use std::fs::OpenOptions;
use std::io::Write;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use rowkery_core::config::{config_dir, AppConfig};
use rowkery_core::connections::{ConnectionRecord, PostgresConnection};
use rowkery_core::db::postgres::{open_session, session_execute, session_query_stream};
use rowkery_core::safety::RowChange;
use rowkery_core::Value;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value as Json};

use crate::target::{resolve, Store, Target};

const QUEUE_FILE: &str = "proposals.jsonl";
const OUTCOMES_FILE: &str = "proposal-outcomes.jsonl";
/// Waiting proposals one connection may hold; the next is refused.
pub const MAX_WAITING: usize = 5;
/// A proposal nobody decided on is dropped after this long.
pub const EXPIRES_MS: u64 = 24 * 60 * 60 * 1000;
/// Older lines are skipped when the files are read.
const KEEP_MS: u64 = 7 * EXPIRES_MS;
/// Past this size a file starts over (the old one kept as `.1`).
const ROTATE_BYTES: u64 = 2 * 1024 * 1024;
/// Most changed rows a preview shows per statement.
pub const PREVIEW_ROWS: usize = 200;
const REASON_CHARS: usize = 1000;
const SQL_BYTES: usize = 20 * 1024;
/// Waits on locks, and on any one statement, during a commit.
const LOCK_TIMEOUT: Duration = Duration::from_secs(3);
/// Waits on locks during a dry run: shorter, so a preview never sits on
/// rows another session holds.
const DRY_RUN_LOCK_TIMEOUT: Duration = Duration::from_secs(2);
const STATEMENT_TIMEOUT: Duration = Duration::from_secs(15);

/// One proposed change, as queued.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct Proposal {
    pub id: String,
    /// Unix time in milliseconds.
    pub ts: u64,
    /// The connection's id.
    pub connection: String,
    pub database: String,
    pub sql: String,
    /// The agent's own words: why it wants the change.
    pub reason: String,
    /// How many rows the agent expects to change, if it said.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub expect_rows: Option<u64>,
    /// The MCP client's name (`claude-ai`, `claude-code`, …).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub client: Option<String>,
}

/// What the user decided, or what became of the commit.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(tag = "state", rename_all = "snake_case")]
pub enum Decision {
    /// Rows changed per statement.
    Committed { rows: Vec<u64> },
    Rejected {
        #[serde(default, skip_serializing_if = "Option::is_none")]
        note: Option<String>,
    },
    /// The commit failed (nothing was saved, unless the error says otherwise).
    Failed { error: String },
}

#[derive(Clone, Debug, Serialize, Deserialize)]
struct DecisionLine {
    id: String,
    ts: u64,
    #[serde(flatten)]
    decision: Decision,
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

/// `p_` and twelve hex digits: the time and this process, so two agents
/// proposing in the same millisecond still differ.
fn new_id() -> String {
    use std::sync::atomic::{AtomicU64, Ordering};
    static SEQ: AtomicU64 = AtomicU64::new(0);
    let mix = now_ms()
        .wrapping_mul(0x9E37_79B9_7F4A_7C15)
        .wrapping_add(u64::from(std::process::id()) << 20)
        .wrapping_add(SEQ.fetch_add(1, Ordering::Relaxed));
    format!("p_{:012x}", mix & 0xffff_ffff_ffff)
}

fn append_line(file: &str, line: &impl Serialize) -> Result<(), String> {
    let dir = config_dir();
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let mut text = serde_json::to_string(line).map_err(|e| e.to_string())?;
    text.push('\n');
    let path = dir.join(file);
    if std::fs::metadata(&path).is_ok_and(|m| m.len() > ROTATE_BYTES) {
        let _ = std::fs::rename(&path, dir.join(format!("{file}.1")));
    }
    OpenOptions::new()
        .create(true)
        .append(true)
        .open(path)
        .and_then(|mut f| f.write_all(text.as_bytes()))
        .map_err(|e| format!("Couldn't save the proposal: {e}"))
}

fn read_lines<T: for<'de> Deserialize<'de>>(file: &str) -> Vec<T> {
    let Ok(text) = std::fs::read_to_string(config_dir().join(file)) else {
        return Vec::new();
    };
    text.lines()
        .filter_map(|l| serde_json::from_str(l).ok())
        .collect()
}

/// Every proposal of the last week with its decision, oldest first.
fn load() -> Vec<(Proposal, Option<DecisionLine>)> {
    let since = now_ms().saturating_sub(KEEP_MS);
    let mut decided: HashMap<String, DecisionLine> = HashMap::new();
    for line in read_lines::<DecisionLine>(OUTCOMES_FILE) {
        // The first decision stands.
        decided.entry(line.id.clone()).or_insert(line);
    }
    let mut seen = std::collections::HashSet::new();
    read_lines::<Proposal>(QUEUE_FILE)
        .into_iter()
        .filter(|p| p.ts >= since && seen.insert(p.id.clone()))
        .map(|p| {
            let d = decided.remove(&p.id);
            (p, d)
        })
        .collect()
}

fn is_waiting(p: &Proposal, d: &Option<DecisionLine>, now: u64) -> bool {
    d.is_none() && now.saturating_sub(p.ts) < EXPIRES_MS
}

/// Proposals nobody has decided on yet, oldest first.
pub fn waiting() -> Vec<Proposal> {
    let now = now_ms();
    load()
        .into_iter()
        .filter(|(p, d)| is_waiting(p, d, now))
        .map(|(p, _)| p)
        .collect()
}

/// Queues a checked change (the MCP side). Refused when the connection
/// already has `MAX_WAITING` waiting.
pub fn submit(
    connection: &str,
    database: &str,
    sql: &str,
    reason: &str,
    expect_rows: Option<u64>,
    client: Option<String>,
) -> Result<Proposal, String> {
    let waiting_here = waiting()
        .iter()
        .filter(|p| p.connection == connection)
        .count();
    if waiting_here >= MAX_WAITING {
        return Err(format!(
            "Refused: {MAX_WAITING} changes on this connection are already waiting for the user. Wait for them to be reviewed (check_proposal) before proposing more."
        ));
    }
    let proposal = Proposal {
        id: new_id(),
        ts: now_ms(),
        connection: connection.to_string(),
        database: database.to_string(),
        sql: sql.trim().to_string(),
        reason: reason.trim().to_string(),
        expect_rows,
        client,
    };
    append_line(QUEUE_FILE, &proposal)?;
    Ok(proposal)
}

/// The reason and SQL an agent sent, or why they can't be queued.
pub fn validate_input(sql: &str, reason: &str) -> Result<(), String> {
    if reason.trim().is_empty() {
        return Err("Say why in reason: the user sees it next to the SQL.".into());
    }
    if reason.chars().count() > REASON_CHARS {
        return Err(format!("Keep reason under {REASON_CHARS} characters."));
    }
    if sql.len() > SQL_BYTES {
        return Err("The SQL is over 20 KB. Propose a smaller change.".into());
    }
    Ok(())
}

/// What `check_proposal` answers.
pub fn status(id: &str) -> Result<Json, String> {
    let now = now_ms();
    let (p, d) = load()
        .into_iter()
        .find(|(p, _)| p.id == id.trim())
        .ok_or_else(|| format!("No proposal called \"{}\".", id.trim()))?;
    let mut out = match &d {
        Some(line) => {
            let mut v = serde_json::to_value(&line.decision).unwrap_or(Json::Null);
            v["at_ms"] = json!(line.ts);
            v
        }
        None if is_waiting(&p, &d, now) => json!({ "state": "waiting" }),
        None => json!({ "state": "expired" }),
    };
    out["id"] = json!(p.id);
    if out["state"] == "rejected" {
        out["hint"] = json!("The user rejected this change. Don't send it again.");
    }
    Ok(out)
}

fn find_waiting(id: &str) -> Result<Proposal, String> {
    let now = now_ms();
    match load().into_iter().find(|(p, _)| p.id == id) {
        Some((p, d)) if is_waiting(&p, &d, now) => Ok(p),
        Some((_, Some(_))) => Err("This change was already decided.".into()),
        Some(_) => Err("This change expired before it was reviewed.".into()),
        None => Err("This change is no longer in the queue.".into()),
    }
}

fn decide(id: &str, decision: Decision) -> Result<(), String> {
    append_line(
        OUTCOMES_FILE,
        &DecisionLine {
            id: id.to_string(),
            ts: now_ms(),
            decision,
        },
    )
}

/// The user said no; the note (if any) goes back to the agent.
pub fn reject(id: &str, note: Option<String>) -> Result<(), String> {
    find_waiting(id)?;
    let note = note.map(|n| n.trim().to_string()).filter(|n| !n.is_empty());
    decide(id, Decision::Rejected { note })
}

/// One statement's dry run.
#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct StatementPreview {
    pub verb: String,
    pub target: String,
    pub sql: String,
    pub destructive: bool,
    /// Rows the statement changed.
    pub rows: u64,
    pub columns: Vec<String>,
    /// The primary key's columns (empty when the table has none).
    pub key: Vec<String>,
    /// Columns whose value differs in at least one shown row (UPDATE).
    pub changed: Vec<String>,
    /// Up to `PREVIEW_ROWS` rows: before (UPDATE, DELETE, an upsert's old
    /// row) and after (INSERT, UPDATE), cells as compact JSON.
    pub shown: Vec<PreviewRow>,
    /// Triggers on the table: they ran in the dry run too, but their own
    /// writes aren't counted or shown.
    pub triggers: Vec<String>,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct PreviewRow {
    pub before: Option<Vec<Json>>,
    pub after: Option<Vec<Json>>,
}

/// A waiting proposal with its connection's name and the dry run.
#[derive(Clone, Debug, Serialize)]
pub struct DryRun {
    pub proposal: Proposal,
    pub connection_name: String,
    pub statements: Vec<StatementPreview>,
}

/// What the commit did.
#[derive(Clone, Debug, Serialize)]
#[serde(tag = "outcome", rename_all = "snake_case")]
pub enum CommitOutcome {
    Committed {
        rows: Vec<u64>,
    },
    /// The data changed since the dry run: nothing was saved; here is a new one.
    Moved {
        dry_run: DryRun,
    },
    Failed {
        error: String,
    },
}

/// The proposal and its connection, checked again from scratch.
async fn checked(id: &str) -> Result<(Proposal, ConnectionRecord, String, Vec<RowChange>), String> {
    let proposal = find_waiting(id)?;
    let config = AppConfig::load().map_err(|e| format!("Couldn't read Rowkery's config: {e}"))?;
    let target = resolve(&config, &proposal.connection, Some(&proposal.database)).map_err(|_| {
        "This connection is no longer shared with agents, so the change can't run. Discard it, or share the connection again.".to_string()
    })?;
    let mut store = Store::default();
    let changes = crate::change::check(&mut store, &target, &proposal.sql).await?;
    Ok((proposal, target.record, target.database, changes))
}

/// Runs the change in a transaction that is rolled back, and shows what it did.
pub async fn dry_run(id: &str) -> Result<DryRun, String> {
    let (proposal, record, database, changes) = checked(id).await?;
    let statements = preview(&record, &database, &changes).await?;
    Ok(DryRun {
        proposal,
        connection_name: record.display_name().to_string(),
        statements,
    })
}

/// A trigger that fires for one statement, and on which event.
#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct PlannedTrigger {
    pub name: String,
    /// `INSERT`, `UPDATE` or `DELETE`.
    pub event: String,
}

/// One statement as the review shows it before anything runs. `verb` and
/// `target` are `None` when the lexer couldn't read them; the SQL is then
/// the whole proposal and no triggers are listed.
#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct PlannedStatement {
    pub verb: Option<String>,
    pub target: Option<String>,
    pub sql: String,
    /// DELETE / UPDATE with no WHERE.
    pub destructive: bool,
    pub triggers: Vec<PlannedTrigger>,
}

/// What the review shows when it opens: each statement and the triggers it
/// would fire. Nothing in the proposal runs.
#[derive(Clone, Debug, Serialize)]
pub struct Plan {
    pub connection_name: String,
    pub statements: Vec<PlannedStatement>,
}

/// The proposal's statements and the user triggers each would fire, read
/// from the catalog without executing the proposal (Postgres: `pg_trigger`
/// on the read-only session; SQLite: `sqlite_master`).
pub async fn plan(id: &str) -> Result<Plan, String> {
    let proposal = find_waiting(id)?;
    let config = AppConfig::load().map_err(|e| format!("Couldn't read Rowkery's config: {e}"))?;
    let target = resolve(&config, &proposal.connection, Some(&proposal.database)).map_err(|_| {
        "This connection is no longer shared with agents, so the change can't run. Discard it, or share the connection again.".to_string()
    })?;
    let connection_name = target.record.display_name().to_string();
    let Ok(changes) = rowkery_core::safety::row_changes(&proposal.sql) else {
        return Ok(Plan {
            connection_name,
            statements: vec![PlannedStatement {
                verb: None,
                target: None,
                sql: proposal.sql.clone(),
                destructive: false,
                triggers: Vec::new(),
            }],
        });
    };
    let mut store = Store::default();
    let mut statements = Vec::new();
    for change in changes {
        let events = trigger_events(&change);
        let triggers = match &target.record {
            ConnectionRecord::Postgres(_) => {
                let read = store
                    .read(
                        &target,
                        &format!(
                            "SELECT tgname::text, tgtype::int FROM pg_trigger \
                             WHERE tgrelid = to_regclass({}) AND NOT tgisinternal AND tgenabled <> 'D' \
                             ORDER BY tgname",
                            literal(&change.target)
                        ),
                    )
                    .await?;
                read.rows
                    .iter()
                    .filter_map(|r| {
                        let bits = match r.get(1) {
                            Some(Value::Int(n)) => *n,
                            _ => 0,
                        };
                        pg_trigger_event(bits, &events).map(|event| PlannedTrigger {
                            name: text(r.first()),
                            event,
                        })
                    })
                    .collect()
            }
            ConnectionRecord::Sqlite(c) => {
                let path = c.path.clone();
                let table = unquote_last(&change.target);
                tokio::task::spawn_blocking(move || sqlite_triggers(&path, &table, &events))
                    .await
                    .map_err(|e| e.to_string())??
            }
        };
        statements.push(PlannedStatement {
            verb: Some(change.verb),
            target: Some(change.target),
            sql: change.sql,
            destructive: change.destructive,
            triggers,
        });
    }
    Ok(Plan {
        connection_name,
        statements,
    })
}

/// The events a statement fires triggers for: its verb, and UPDATE too for
/// an INSERT that may turn into one (`ON CONFLICT … DO UPDATE`).
fn trigger_events(change: &RowChange) -> Vec<&'static str> {
    let verb = match change.verb.as_str() {
        "INSERT" => "INSERT",
        "UPDATE" => "UPDATE",
        _ => "DELETE",
    };
    let words = rowkery_core::safety::identifiers(&change.sql);
    if verb == "INSERT" && words.iter().any(|w| w == "conflict") {
        vec!["INSERT", "UPDATE"]
    } else {
        vec![verb]
    }
}

/// `pg_trigger.tgtype`'s event bits: the first of `events` the trigger
/// fires on.
fn pg_trigger_event(bits: i64, events: &[&str]) -> Option<String> {
    events
        .iter()
        .find(|e| {
            let bit = match **e {
                "INSERT" => 1 << 2,
                "DELETE" => 1 << 3,
                _ => 1 << 4,
            };
            bits & bit != 0
        })
        .map(|e| e.to_string())
}

/// SQLite's triggers on `table` that fire on one of `events`, read from
/// `sqlite_master` on a read-only connection.
fn sqlite_triggers(
    path: &str,
    table: &str,
    events: &[&str],
) -> Result<Vec<PlannedTrigger>, String> {
    use rusqlite::OpenFlags;
    let err = |e: rusqlite::Error| e.to_string();
    let conn = rusqlite::Connection::open_with_flags(
        rowkery_core::connections::expand_home(path),
        OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX,
    )
    .map_err(err)?;
    let rows: Vec<(String, String)> = conn
        .prepare(
            "SELECT name, sql FROM sqlite_master WHERE type = 'trigger' AND tbl_name = ?1 COLLATE NOCASE ORDER BY name",
        )
        .and_then(|mut s| {
            s.query_map([table], |r| Ok((r.get(0)?, r.get::<_, Option<String>>(1)?.unwrap_or_default())))?
                .collect()
        })
        .map_err(err)?;
    Ok(rows
        .into_iter()
        .filter_map(|(name, sql)| {
            let event = sqlite_trigger_event(&name, &sql)?;
            events
                .contains(&event.as_str())
                .then_some(PlannedTrigger { name, event })
        })
        .collect())
}

/// `CREATE TRIGGER name BEFORE UPDATE OF … ON t …` → `UPDATE`: the first
/// event word after the trigger's own name.
fn sqlite_trigger_event(name: &str, sql: &str) -> Option<String> {
    let name = name.to_lowercase();
    rowkery_core::safety::identifiers(sql)
        .into_iter()
        .skip_while(|w| w != "trigger")
        .filter(|w| *w != name)
        .find(|w| matches!(w.as_str(), "insert" | "update" | "delete"))
        .map(|w| w.to_uppercase())
}

/// A lock wait cut short reads as what happened, not as the server's words.
fn dry_run_error(error: String) -> String {
    if error.contains("lock timeout") || error.contains("database is locked") {
        format!(
            "Another session is holding these rows, so the dry run stopped after {} s. Nothing was changed.",
            DRY_RUN_LOCK_TIMEOUT.as_secs()
        )
    } else {
        error
    }
}

async fn preview(
    record: &ConnectionRecord,
    database: &str,
    changes: &[RowChange],
) -> Result<Vec<StatementPreview>, String> {
    match record {
        ConnectionRecord::Postgres(pg) => pg_preview(pg, database, changes).await,
        ConnectionRecord::Sqlite(c) => {
            let path = c.path.clone();
            let changes = changes.to_vec();
            tokio::task::spawn_blocking(move || sqlite_run(&path, &changes, None))
                .await
                .map_err(|e| e.to_string())?
                .map(|(previews, _)| previews)
        }
    }
    .map_err(dry_run_error)
}

/// Commits the change if it still passes every check and each statement
/// changes the rows the user saw in the dry run (`rows`, per statement).
pub async fn commit(id: &str, rows: &[u64]) -> Result<CommitOutcome, String> {
    let (proposal, record, database, changes) = checked(id).await?;
    if rows.len() != changes.len() {
        return Err("The change moved since you reviewed it. Review it again.".into());
    }
    let ran = match &record {
        ConnectionRecord::Postgres(pg) => {
            let target = Target {
                record: record.clone(),
                database: database.clone(),
            };
            pg_commit(pg, &target, &proposal.sql, rows).await
        }
        ConnectionRecord::Sqlite(c) => {
            let path = c.path.clone();
            let changes = changes.clone();
            let rows = rows.to_vec();
            tokio::task::spawn_blocking(move || sqlite_run(&path, &changes, Some(&rows)))
                .await
                .map_err(|e| e.to_string())?
                .map(|(_, ran)| ran.unwrap_or(RunResult::Moved))
        }
    };
    match ran {
        Ok(RunResult::Committed(counts)) => {
            decide(
                id,
                Decision::Committed {
                    rows: counts.clone(),
                },
            )?;
            Ok(CommitOutcome::Committed { rows: counts })
        }
        Ok(RunResult::Moved) => {
            let statements = preview(&record, &database, &changes).await?;
            Ok(CommitOutcome::Moved {
                dry_run: DryRun {
                    proposal,
                    connection_name: record.display_name().to_string(),
                    statements,
                },
            })
        }
        Err(error) => {
            // Before COMMIT nothing was saved: the user can try again. A
            // dropped COMMIT is final either way, and the agent hears it.
            if error.starts_with(UNKNOWN_COMMIT) {
                decide(
                    id,
                    Decision::Failed {
                        error: error.clone(),
                    },
                )?;
            }
            Ok(CommitOutcome::Failed { error })
        }
    }
}

enum RunResult {
    Committed(Vec<u64>),
    Moved,
}

const UNKNOWN_COMMIT: &str = "The connection dropped during COMMIT";

fn pg_config(pg: &PostgresConnection, database: &str) -> PostgresConnection {
    let mut config = pg.clone();
    config.database = database.to_string();
    config
}

/// A Postgres string literal: `'…'` with quotes doubled, or, when the text
/// holds a backslash, `E'…'` with backslashes doubled too. The target comes
/// from the agent's SQL (a quoted identifier can hold `\'`), and a plain
/// `'…'` reads `\'` as a quote that doesn't end it on a server with
/// `standard_conforming_strings` off. Core's `sql_literal` does the same.
fn literal(text: &str) -> String {
    if text.contains('\\') {
        format!("E'{}'", text.replace('\\', "\\\\").replace('\'', "''"))
    } else {
        format!("'{}'", text.replace('\'', "''"))
    }
}

fn text(v: Option<&Value>) -> String {
    match v {
        Some(Value::Text(t)) => t.clone(),
        _ => String::new(),
    }
}

fn timeouts_sql(lock: Duration) -> String {
    format!(
        "SET LOCAL lock_timeout = '{}s'; SET LOCAL statement_timeout = '{}s'",
        lock.as_secs(),
        STATEMENT_TIMEOUT.as_secs()
    )
}

async fn pg_rows(
    session: &rowkery_core::db::postgres::PostgresSession,
    sql: &str,
) -> Result<(Vec<String>, Vec<Vec<Value>>), String> {
    let mut columns = Vec::new();
    let mut rows = Vec::new();
    session_query_stream(session, sql, |batch, first| {
        if first {
            columns = batch.columns.into_iter().map(|c| c.name).collect();
        }
        rows.extend(batch.rows);
        Ok(())
    })
    .await
    .map_err(|e| e.into_message())?;
    Ok((columns, rows))
}

async fn pg_preview(
    pg: &PostgresConnection,
    database: &str,
    changes: &[RowChange],
) -> Result<Vec<StatementPreview>, String> {
    let session = open_session(pg.id.clone(), pg_config(pg, database))
        .await
        .map_err(|e| e.into_message())?;
    session_execute(
        &session,
        &format!("BEGIN; {}", timeouts_sql(DRY_RUN_LOCK_TIMEOUT)),
    )
    .await
    .map_err(|e| e.into_message())?;
    let mut out = Vec::new();
    let mut failed = None;
    for change in changes {
        match pg_preview_one(&session, change).await {
            Ok(p) => out.push(p),
            Err(e) => {
                failed = Some(e);
                break;
            }
        }
    }
    let _ = session_execute(&session, "ROLLBACK").await;
    match failed {
        Some(e) => Err(e),
        None => Ok(out),
    }
}

/// One statement inside the dry run's transaction. Wrapped in a CTE, the
/// change runs and returns its rows while the main query, which sees the
/// table as it was before the statement, joins each to its old row by
/// primary key.
async fn pg_preview_one(
    session: &rowkery_core::db::postgres::PostgresSession,
    change: &RowChange,
) -> Result<StatementPreview, String> {
    let rel = literal(&change.target);
    let facts = pg_rows(
        session,
        &format!(
            "SELECT 'k', a.attname::text FROM pg_index i \
             JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = ANY(i.indkey) \
             WHERE i.indrelid = {rel}::regclass AND i.indisprimary \
             UNION ALL SELECT 't', tgname::text FROM pg_trigger \
             WHERE tgrelid = {rel}::regclass AND NOT tgisinternal"
        ),
    )
    .await?
    .1;
    let key: Vec<String> = facts
        .iter()
        .filter(|r| text(r.first()) == "k")
        .map(|r| text(r.get(1)))
        .collect();
    let triggers: Vec<String> = facts
        .iter()
        .filter(|r| text(r.first()) == "t")
        .map(|r| text(r.get(1)))
        .collect();
    let quote = |c: &str| format!("\"{}\"", c.replace('"', "\"\""));
    let join_old = change.verb != "DELETE" && !key.is_empty();
    let sql = if join_old {
        let new_key: Vec<String> = key
            .iter()
            .map(|k| format!("rk_change.{}", quote(k)))
            .collect();
        let old_key: Vec<String> = key.iter().map(|k| format!("rk_old.{}", quote(k))).collect();
        format!(
            "WITH rk_change AS ({}\nRETURNING *) \
             SELECT rk_change.*, rk_old.*, (rk_old.{} IS NOT NULL) AS rk_had_old, count(*) OVER () AS rk_total \
             FROM rk_change LEFT JOIN {} rk_old ON ({}) = ({}) LIMIT {PREVIEW_ROWS}",
            change.sql,
            quote(&key[0]),
            change.target,
            old_key.join(", "),
            new_key.join(", "),
        )
    } else {
        format!(
            "WITH rk_change AS ({}\nRETURNING *) SELECT rk_change.*, count(*) OVER () AS rk_total FROM rk_change LIMIT {PREVIEW_ROWS}",
            change.sql
        )
    };
    let (columns, rows) = pg_rows(session, &sql).await?;
    let width = if join_old {
        (columns.len() - 2) / 2
    } else {
        columns.len() - 1
    };
    let total = rows
        .first()
        .and_then(|r| r.last())
        .map(|v| match v {
            Value::Int(n) => *n as u64,
            _ => 0,
        })
        .unwrap_or(0);
    let shown = rows
        .iter()
        .map(|r| {
            let new = &r[..width];
            let old = (join_old && matches!(r.get(2 * width), Some(Value::Bool(true))))
                .then(|| &r[width..2 * width]);
            shape_row(&change.verb, new, old)
        })
        .collect();
    Ok(finish(
        change,
        columns[..width].to_vec(),
        key,
        total,
        shown,
        triggers,
    ))
}

/// Cells for the UI; which side is which depends on the verb: DELETE
/// returns the rows it removed.
fn shape_row(verb: &str, returned: &[Value], old: Option<&[Value]>) -> PreviewRow {
    let cells = |vals: &[Value]| {
        let mut cut = false;
        vals.iter()
            .map(|v| crate::guard::cell(v, &mut cut))
            .collect::<Vec<_>>()
    };
    match verb {
        "DELETE" => PreviewRow {
            before: Some(cells(returned)),
            after: None,
        },
        _ => PreviewRow {
            before: old.map(cells),
            after: Some(cells(returned)),
        },
    }
}

fn finish(
    change: &RowChange,
    columns: Vec<String>,
    key: Vec<String>,
    rows: u64,
    shown: Vec<PreviewRow>,
    triggers: Vec<String>,
) -> StatementPreview {
    let changed = columns
        .iter()
        .enumerate()
        .filter(|(i, _)| {
            shown.iter().any(|r| match (&r.before, &r.after) {
                (Some(b), Some(a)) => b.get(*i) != a.get(*i),
                _ => false,
            })
        })
        .map(|(_, c)| c.clone())
        .collect();
    StatementPreview {
        verb: change.verb.clone(),
        target: change.target.clone(),
        sql: change.sql.clone(),
        destructive: change.destructive,
        rows,
        columns,
        key,
        changed,
        shown,
        triggers,
    }
}

/// Runs every statement for real in one transaction; any count that differs
/// from what the user saw rolls it all back. COMMIT is sent once, never
/// retried.
async fn pg_commit(
    pg: &PostgresConnection,
    target: &Target,
    sql: &str,
    expected: &[u64],
) -> Result<RunResult, String> {
    let session = open_session(pg.id.clone(), pg_config(pg, &target.database))
        .await
        .map_err(|e| e.into_message())?;
    session_execute(&session, &format!("BEGIN; {}", timeouts_sql(LOCK_TIMEOUT)))
        .await
        .map_err(|e| e.into_message())?;
    // Checked again in the transaction that runs it: planned at another
    // moment, `'now'` can fold into a plan that reads what the check never
    // saw (`Store::begin`).
    let mut store = Store::on_session(target, session);
    let checked = crate::change::check(&mut store, target, sql).await;
    let Some(session) = store.into_session(target) else {
        return Err("The connection closed before the change ran. Nothing was saved.".into());
    };
    let changes = match checked {
        Ok(changes) if changes.len() == expected.len() => changes,
        Ok(_) => {
            let _ = session_execute(&session, "ROLLBACK").await;
            return Ok(RunResult::Moved);
        }
        Err(e) => {
            let _ = session_execute(&session, "ROLLBACK").await;
            return Err(e);
        }
    };
    let mut counts = Vec::new();
    for (change, want) in changes.iter().zip(expected) {
        let ran = session_query_stream(&session, &change.sql, |_, _| Ok(())).await;
        match ran {
            Ok(n) if n == *want => counts.push(n),
            Ok(_) => {
                let _ = session_execute(&session, "ROLLBACK").await;
                return Ok(RunResult::Moved);
            }
            Err(e) => {
                let _ = session_execute(&session, "ROLLBACK").await;
                return Err(e.into_message());
            }
        }
    }
    if let Err(e) = session_execute(&session, "COMMIT").await {
        if session.is_closed() {
            return Err(format!(
                "{UNKNOWN_COMMIT}, so the change may or may not be saved. Reload the table to check."
            ));
        }
        let _ = session_execute(&session, "ROLLBACK").await;
        return Err(e.into_message());
    }
    Ok(RunResult::Committed(counts))
}

/// SQLite's dry run (`expected` none: always rolled back) and commit
/// (`expected` the counts the user saw). Each statement runs once with
/// RETURNING inside a savepoint, for its rows; for an UPDATE the savepoint
/// is rolled back to read the old rows by key, then the statement runs
/// again so the next one sees it.
fn sqlite_run(
    path: &str,
    changes: &[RowChange],
    expected: Option<&[u64]>,
) -> Result<(Vec<StatementPreview>, Option<RunResult>), String> {
    use rowkery_core::db::sqlite::sqlite_value_to_core;
    let err = |e: rusqlite::Error| e.to_string();
    let conn =
        rusqlite::Connection::open(rowkery_core::connections::expand_home(path)).map_err(err)?;
    let wait = if expected.is_some() {
        LOCK_TIMEOUT
    } else {
        DRY_RUN_LOCK_TIMEOUT
    };
    conn.busy_timeout(wait).map_err(err)?;
    conn.execute_batch("BEGIN IMMEDIATE").map_err(err)?;
    let result = (|| -> Result<(Vec<StatementPreview>, Option<RunResult>), String> {
        if let Some(expected) = expected {
            let mut counts = Vec::new();
            for (change, want) in changes.iter().zip(expected) {
                let n = conn.execute(&change.sql, []).map_err(err)? as u64;
                if n != *want {
                    return Ok((Vec::new(), Some(RunResult::Moved)));
                }
                counts.push(n);
            }
            return Ok((Vec::new(), Some(RunResult::Committed(counts))));
        }
        let mut out = Vec::new();
        for change in changes {
            let table = unquote_last(&change.target);
            let key: Vec<String> = conn
                .prepare("SELECT name FROM pragma_table_info(?1) WHERE pk > 0 ORDER BY pk")
                .and_then(|mut s| s.query_map([&table], |r| r.get(0))?.collect())
                .map_err(err)?;
            let triggers: Vec<String> = conn
                .prepare("SELECT name FROM sqlite_master WHERE type = 'trigger' AND tbl_name = ?1 COLLATE NOCASE")
                .and_then(|mut s| s.query_map([&table], |r| r.get(0))?.collect())
                .map_err(err)?;
            conn.execute_batch("SAVEPOINT rk_preview").map_err(err)?;
            let mut stmt = conn
                .prepare(&format!("{}\nRETURNING *", change.sql))
                .map_err(err)?;
            let columns: Vec<String> = stmt.column_names().iter().map(|c| c.to_string()).collect();
            let mut returned: Vec<Vec<Value>> = Vec::new();
            let mut total = 0u64;
            let mut rows = stmt.query([]).map_err(err)?;
            while let Some(row) = rows.next().map_err(err)? {
                total += 1;
                if returned.len() < PREVIEW_ROWS {
                    returned.push(
                        (0..columns.len())
                            .map(|i| {
                                row.get_ref(i)
                                    .map(sqlite_value_to_core)
                                    .unwrap_or(Value::Null)
                            })
                            .collect(),
                    );
                }
            }
            drop(rows);
            drop(stmt);
            let mut old: Vec<Option<Vec<Value>>> = vec![None; returned.len()];
            let key_at: Vec<usize> = key
                .iter()
                .filter_map(|k| columns.iter().position(|c| c.eq_ignore_ascii_case(k)))
                .collect();
            if change.verb == "UPDATE" && !key.is_empty() && key_at.len() == key.len() {
                conn.execute_batch("ROLLBACK TO rk_preview").map_err(err)?;
                let filter: Vec<String> = key
                    .iter()
                    .enumerate()
                    .map(|(i, k)| format!("\"{}\" IS ?{}", k.replace('"', "\"\""), i + 1))
                    .collect();
                let mut select = conn
                    .prepare(&format!(
                        "SELECT * FROM {} WHERE {}",
                        change.target,
                        filter.join(" AND ")
                    ))
                    .map_err(err)?;
                for (slot, row) in old.iter_mut().zip(&returned) {
                    let params: Vec<rusqlite::types::Value> =
                        key_at.iter().map(|&i| to_sqlite(&row[i])).collect();
                    *slot = select
                        .query_row(rusqlite::params_from_iter(params), |r| {
                            Ok((0..columns.len())
                                .map(|i| {
                                    r.get_ref(i)
                                        .map(sqlite_value_to_core)
                                        .unwrap_or(Value::Null)
                                })
                                .collect())
                        })
                        .ok();
                }
                drop(select);
                conn.execute(&change.sql, []).map_err(err)?;
            }
            conn.execute_batch("RELEASE rk_preview").map_err(err)?;
            let shown = returned
                .iter()
                .zip(&old)
                .map(|(r, o)| shape_row(&change.verb, r, o.as_deref()))
                .collect();
            out.push(finish(change, columns, key, total, shown, triggers));
        }
        Ok((out, None))
    })();
    let committing = matches!(result, Ok((_, Some(RunResult::Committed(_)))));
    if committing {
        if let Err(e) = conn.execute_batch("COMMIT") {
            let _ = conn.execute_batch("ROLLBACK");
            return Err(e.to_string());
        }
    } else {
        let _ = conn.execute_batch("ROLLBACK");
    }
    result
}

/// `main."Orders"` → `Orders`.
fn unquote_last(target: &str) -> String {
    let last = target.rsplit('.').next().unwrap_or(target);
    last.trim_matches(|c| c == '"' || c == '`' || c == '[' || c == ']')
        .to_string()
}

fn to_sqlite(v: &Value) -> rusqlite::types::Value {
    use rusqlite::types::Value as S;
    match v {
        Value::Null => S::Null,
        Value::Bool(b) => S::Integer(i64::from(*b)),
        Value::Int(n) => S::Integer(*n),
        Value::Float(f) => S::Real(*f),
        Value::Text(t) => S::Text(t.clone()),
        Value::Bytes(b) => S::Blob(b.clone()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use rowkery_core::connections::{McpDbAccess, McpTableMode, SqliteConnection};

    /// A target with `\'` (a quoted identifier can hold one) stays inside
    /// its literal whatever `standard_conforming_strings` says.
    #[test]
    fn a_target_with_a_backslash_is_an_e_string() {
        assert_eq!(literal(r#"public."it's""#), r#"'public."it''s"'"#);
        assert_eq!(
            literal(r#"public."a\') OR (1=1""#),
            r#"E'public."a\\'') OR (1=1"'"#
        );
    }

    fn sqlite_setup(dir: &std::path::Path) -> String {
        let path = dir.join("shop.sqlite");
        let conn = rusqlite::Connection::open(&path).unwrap();
        conn.execute_batch(
            "CREATE TABLE orders (id INTEGER PRIMARY KEY, status TEXT, total REAL);
             INSERT INTO orders VALUES (1, 'pending', 10), (2, 'pending', 20), (3, 'paid', 30);
             CREATE TABLE customers (id INTEGER PRIMARY KEY, email TEXT, plan TEXT);
             INSERT INTO customers VALUES (1, 'a@b.c', 'free');
             CREATE TABLE secrets (id INTEGER PRIMARY KEY, v TEXT);
             CREATE TRIGGER orders_audit AFTER UPDATE OF status ON orders BEGIN SELECT 1; END;
             CREATE TRIGGER orders_new BEFORE INSERT ON orders BEGIN SELECT 1; END;",
        )
        .unwrap();
        path.to_string_lossy().into_owned()
    }

    // The env lock spans the whole test, awaits included.
    #[allow(clippy::await_holding_lock)]
    #[tokio::test]
    async fn a_sqlite_proposal_previews_commits_once_and_reports_back() {
        let _env = crate::ENV_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        let dir = std::env::temp_dir().join(format!("rowkery-proposals-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        std::env::set_var("ROWKERY_CONFIG_DIR", dir.to_string_lossy().to_string());
        let path = sqlite_setup(&dir);
        let mut config = AppConfig::default();
        let c = SqliteConnection {
            id: "shop".into(),
            name: "Shop".into(),
            path: path.clone(),
            environment: None,
            safe_mode: Default::default(),
            sample: false,
            allow_mcp: true,
            mcp_hidden_tables: Vec::new(),
            mcp_until: None,
            mcp_samples_off: false,
            mcp_access: Some(
                [(
                    "main".to_string(),
                    McpDbAccess {
                        mode: McpTableMode::Picked,
                        tables: vec!["main.orders".into(), "main.customers".into()],
                    },
                )]
                .into_iter()
                .collect(),
            ),
            masked_columns: [("main".to_string(), vec!["main.customers.email".to_string()])]
                .into_iter()
                .collect(),
        };
        config.upsert_connection(ConnectionRecord::Sqlite(c));
        config.save().unwrap();
        let config = AppConfig::load().unwrap();
        let target = resolve(&config, "Shop", None).unwrap();
        let mut store = Store::default();

        // Refused before anything is queued.
        for bad in [
            "DELETE FROM secrets",
            "UPDATE customers SET plan = 'pro' WHERE email = 'a@b.c'",
            "UPDATE customers SET email = 'x'",
            "INSERT INTO orders (id, status) SELECT id, email FROM customers",
            "DROP TABLE orders",
        ] {
            assert!(
                crate::change::check(&mut store, &target, bad)
                    .await
                    .is_err(),
                "{bad}"
            );
        }
        let sql = "UPDATE orders SET status = 'refunded' WHERE status = 'pending'";
        assert!(crate::change::check(&mut store, &target, sql).await.is_ok());
        let p = submit("shop", "main", sql, "Stripe says refunded", Some(2), None).unwrap();
        assert_eq!(status(&p.id).unwrap()["state"], "waiting");

        // Opening the review runs nothing: the statement and the triggers
        // its event fires (not the INSERT one).
        let planned = plan(&p.id).await.unwrap();
        assert_eq!(planned.connection_name, "Shop");
        let st = &planned.statements[0];
        assert_eq!(
            (st.verb.as_deref(), st.target.as_deref(), st.sql.as_str()),
            (Some("UPDATE"), Some("orders"), sql)
        );
        assert_eq!(
            st.triggers,
            vec![PlannedTrigger {
                name: "orders_audit".into(),
                event: "UPDATE".into()
            }]
        );
        let conn = rusqlite::Connection::open(&path).unwrap();
        let count = |conn: &rusqlite::Connection, q: &str| -> i64 {
            conn.query_row(q, [], |r| r.get(0)).unwrap()
        };
        assert_eq!(
            count(
                &conn,
                "SELECT count(*) FROM orders WHERE status = 'pending'"
            ),
            2
        );

        // SQL the lexer can't read: shown whole, no triggers.
        let odd = submit(
            "shop",
            "main",
            "WITH x AS (SELECT 1) DELETE FROM orders",
            "odd",
            None,
            None,
        )
        .unwrap();
        let planned = plan(&odd.id).await.unwrap();
        assert_eq!(planned.statements.len(), 1);
        assert_eq!(planned.statements[0].target, None);
        assert!(planned.statements[0].triggers.is_empty());
        reject(&odd.id, None).unwrap();

        // Another session holds the write lock: the dry run gives up
        // after the short wait and says so.
        conn.execute_batch("BEGIN IMMEDIATE").unwrap();
        let held = dry_run(&p.id).await.unwrap_err();
        assert!(held.starts_with("Another session is holding"), "{held}");
        conn.execute_batch("ROLLBACK").unwrap();
        drop(conn);

        let run = dry_run(&p.id).await.unwrap();
        let s = &run.statements[0];
        assert_eq!((s.rows, s.key.clone()), (2, vec!["id".to_string()]));
        assert_eq!(s.changed, vec!["status".to_string()]);
        assert_eq!(s.shown[0].before.as_ref().unwrap()[1], json!("pending"));
        assert_eq!(s.shown[0].after.as_ref().unwrap()[1], json!("refunded"));
        // The dry run saved nothing.
        let conn = rusqlite::Connection::open(&path).unwrap();
        let pending: i64 = conn
            .query_row(
                "SELECT count(*) FROM orders WHERE status = 'pending'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(pending, 2);

        // Another pending order appears: the counts differ, nothing is saved.
        conn.execute("INSERT INTO orders VALUES (4, 'pending', 5)", [])
            .unwrap();
        match commit(&p.id, &[2]).await.unwrap() {
            CommitOutcome::Moved { dry_run } => assert_eq!(dry_run.statements[0].rows, 3),
            other => panic!("{other:?}"),
        }
        match commit(&p.id, &[3]).await.unwrap() {
            CommitOutcome::Committed { rows } => assert_eq!(rows, vec![3]),
            other => panic!("{other:?}"),
        }
        let refunded: i64 = conn
            .query_row(
                "SELECT count(*) FROM orders WHERE status = 'refunded'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(refunded, 3);
        assert_eq!(status(&p.id).unwrap()["state"], "committed");
        assert!(commit(&p.id, &[3]).await.is_err(), "decided once");

        // Rejected with a note; the cap of waiting proposals.
        let q = submit(
            "shop",
            "main",
            "DELETE FROM orders WHERE id = 1",
            "dup",
            None,
            None,
        )
        .unwrap();
        reject(&q.id, Some("keep it".into())).unwrap();
        let st = status(&q.id).unwrap();
        assert_eq!(
            (st["state"].clone(), st["note"].clone()),
            (json!("rejected"), json!("keep it"))
        );
        for _ in 0..MAX_WAITING {
            submit(
                "shop",
                "main",
                "DELETE FROM orders WHERE id = 1",
                "x",
                None,
                None,
            )
            .unwrap();
        }
        assert!(submit(
            "shop",
            "main",
            "DELETE FROM orders WHERE id = 1",
            "x",
            None,
            None
        )
        .is_err());
        assert_eq!(waiting().len(), MAX_WAITING);
        std::env::remove_var("ROWKERY_CONFIG_DIR");
    }

    #[test]
    fn trigger_events_follow_the_verb() {
        // tgtype bits: 4 INSERT, 8 DELETE, 16 UPDATE (plus ROW / BEFORE bits).
        assert_eq!(
            pg_trigger_event(16 | 1, &["UPDATE"]).as_deref(),
            Some("UPDATE")
        );
        assert_eq!(pg_trigger_event(4 | 2, &["UPDATE"]), None);
        assert_eq!(
            pg_trigger_event(4 | 8, &["DELETE"]).as_deref(),
            Some("DELETE")
        );
        assert_eq!(
            pg_trigger_event(16, &["INSERT", "UPDATE"]).as_deref(),
            Some("UPDATE")
        );
        let change = |verb: &str, sql: &str| RowChange {
            verb: verb.into(),
            target: "t".into(),
            sql: sql.into(),
            destructive: false,
        };
        assert_eq!(
            trigger_events(&change("INSERT", "INSERT INTO t VALUES (1)")),
            vec!["INSERT"]
        );
        assert_eq!(
            trigger_events(&change(
                "INSERT",
                "INSERT INTO t VALUES (1) ON CONFLICT (id) DO UPDATE SET v = 2"
            )),
            vec!["INSERT", "UPDATE"]
        );
        assert_eq!(
            sqlite_trigger_event(
                "update_log",
                "CREATE TRIGGER update_log AFTER DELETE ON t BEGIN SELECT 1; END"
            )
            .as_deref(),
            Some("DELETE")
        );
        assert_eq!(
            sqlite_trigger_event(
                "t_up",
                "CREATE TRIGGER IF NOT EXISTS t_up BEFORE UPDATE OF v ON t BEGIN SELECT 1; END"
            )
            .as_deref(),
            Some("UPDATE")
        );
    }

    #[test]
    fn names_lose_their_schema_and_quotes() {
        assert_eq!(unquote_last("main.\"Orders\""), "Orders");
        assert_eq!(unquote_last("orders"), "orders");
    }
}
