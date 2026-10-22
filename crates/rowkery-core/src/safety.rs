//! Safe mode: which statements change data or schema, and whether a
//! connection's safe mode lets them run.
//!
//! The check is one pass over the SQL text with the editor's quoting rules
//! (`'…'`, Postgres `E'…'` with its backslash escapes, `"…"`, `` `…` ``,
//! `--` and nested `/* */` comments, Postgres `$tag$` bodies), so reads pay
//! nothing measurable. Text it can't be sure of (a string, comment or
//! dollar body that never ends, a nested comment, `\'` in a plain string:
//! places where servers disagree) makes its statement a write, never a
//! read. It guards against slips, not against a determined user:
//! `SELECT delete_user(1)` reads as a read. Read-only connections are also
//! read-only at the server, which catches those.

use serde::{Deserialize, Serialize};

/// A connection's safe mode. Saved on the connection; separate from its
/// environment label.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SafeMode {
    /// Everything runs straight away.
    #[default]
    Off,
    /// Writes and schema changes wait for the user to confirm.
    Confirm,
    /// Writes and schema changes are refused.
    ReadOnly,
}

impl SafeMode {
    pub fn is_off(&self) -> bool {
        *self == SafeMode::Off
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum StatementKind {
    /// SELECT, SHOW, EXPLAIN without ANALYZE, …
    Read,
    /// SET, BEGIN, COMMIT, …: change nothing in the database.
    Session,
    /// INSERT, UPDATE, DELETE, COPY FROM, CALL, and anything unrecognised.
    Write,
    /// CREATE, ALTER, DROP, TRUNCATE, GRANT, …
    Schema,
}

/// One statement of a run, as safe mode sees it.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct StatementCheck {
    pub kind: StatementKind,
    /// Upper-case verb, with the object type for schema changes:
    /// `DELETE`, `DROP TABLE`, `CREATE INDEX`.
    pub verb: String,
    /// The object it acts on as written (`public.wallets`), when found.
    pub target: Option<String>,
    /// DROP, TRUNCATE, or DELETE / UPDATE with no WHERE.
    pub destructive: bool,
    /// A session statement that would let later statements write (turning
    /// `transaction_read_only` off, `READ WRITE`, `RESET ALL`,
    /// `PRAGMA query_only`). Refused on read-only connections.
    pub unlocks_writes: bool,
}

impl StatementCheck {
    pub fn changes_data(&self) -> bool {
        matches!(self.kind, StatementKind::Write | StatementKind::Schema)
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum HoldAction {
    /// Confirm writes: shown to the user, runs once they confirm.
    Confirm,
    /// Read-only: never runs.
    Refuse,
}

/// Why a run was stopped before anything reached the database.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct SafetyHold {
    pub action: HoldAction,
    pub mode: SafeMode,
    /// The statements that caused the hold, in run order.
    pub statements: Vec<StatementCheck>,
}

/// What `mode` does with `sql`: `None` runs it. `confirmed` is the user's
/// go-ahead for this run; it never lets a read-only connection write.
pub fn hold_for(mode: SafeMode, sql: &str, confirmed: bool) -> Option<SafetyHold> {
    if mode == SafeMode::Off || (mode == SafeMode::Confirm && confirmed) {
        return None;
    }
    let statements: Vec<StatementCheck> = check_sql(sql)
        .into_iter()
        .filter(|s| s.changes_data() || (mode == SafeMode::ReadOnly && s.unlocks_writes))
        .collect();
    if statements.is_empty() {
        return None;
    }
    Some(SafetyHold {
        action: if mode == SafeMode::ReadOnly {
            HoldAction::Refuse
        } else {
            HoldAction::Confirm
        },
        mode,
        statements,
    })
}

/// Checks every statement in `sql`.
pub fn check_sql(sql: &str) -> Vec<StatementCheck> {
    tokenize(sql)
        .iter()
        .filter(|s| !s.is_empty())
        .map(|s| {
            unclear_check(s)
                .or_else(|| signal_check(s))
                .unwrap_or_else(|| check_statement(s))
        })
        .collect()
}

/// What a statement whose text Rowkery can't be sure of counts as.
pub const UNCLEAR_VERB: &str = "Unclear SQL";

/// A statement holding text that may read differently to the server
/// ([`Tok::Unclear`]): a write, so it fails closed.
fn unclear_check(toks: &[Tok]) -> Option<StatementCheck> {
    toks.contains(&Tok::Unclear).then(|| StatementCheck {
        kind: StatementKind::Write,
        verb: UNCLEAR_VERB.into(),
        target: None,
        destructive: false,
        unlocks_writes: false,
    })
}

/// Server functions that stop another session. They're called from a
/// SELECT, so the first word reads as a read; they count as writes.
const SIGNAL_FUNCTIONS: &[&str] = &["PG_CANCEL_BACKEND", "PG_TERMINATE_BACKEND"];

/// A statement that calls a [`SIGNAL_FUNCTIONS`] function anywhere in it.
fn signal_check(toks: &[Tok]) -> Option<StatementCheck> {
    let called = toks.windows(2).find_map(|w| match (&w[0], &w[1]) {
        (Tok::Word(word, _), Tok::Open) if SIGNAL_FUNCTIONS.contains(&word.as_str()) => {
            Some(word.as_str())
        }
        _ => None,
    })?;
    Some(StatementCheck {
        kind: StatementKind::Write,
        verb: called.to_string(),
        target: None,
        destructive: called == "PG_TERMINATE_BACKEND",
        unlocks_writes: false,
    })
}

/// How one statement of a SQL file sits with a transaction around it.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum InTransaction {
    /// Runs inside one like any other.
    Fine,
    /// `BEGIN` / `START TRANSACTION`.
    Begins,
    /// `COMMIT` / `END`.
    Commits,
    /// Any other transaction control: `ROLLBACK`, `SAVEPOINT`, `RELEASE`,
    /// `PREPARE TRANSACTION`, …
    Controls,
    /// Can't run inside one: `VACUUM`, `CREATE INDEX CONCURRENTLY`,
    /// `CREATE DATABASE`, …
    Never,
}

/// A SQL file statement as safe mode sees it, and how it sits with a
/// transaction (one tokenizing pass for both).
pub fn check_file_statement(sql: &str) -> Option<(StatementCheck, InTransaction)> {
    let toks = tokenize(sql).into_iter().find(|s| !s.is_empty())?;
    let check = unclear_check(&toks)
        .or_else(|| signal_check(&toks))
        .unwrap_or_else(|| check_statement(&toks));
    let words: Vec<&str> = top_level(&toks).filter_map(Tok::word).take(4).collect();
    let concurrently = || top_level(&toks).any(|t| t.is("CONCURRENTLY"));
    let role = match words.as_slice() {
        ["BEGIN", ..] | ["START", "TRANSACTION", ..] => InTransaction::Begins,
        ["COMMIT", "PREPARED", ..] => InTransaction::Controls,
        ["COMMIT", ..] | ["END", ..] => InTransaction::Commits,
        ["ROLLBACK" | "ABORT" | "SAVEPOINT" | "RELEASE", ..] | ["PREPARE", "TRANSACTION", ..] => {
            InTransaction::Controls
        }
        ["VACUUM", ..]
        | ["ALTER", "SYSTEM", ..]
        | ["CREATE" | "DROP", "DATABASE" | "TABLESPACE" | "SUBSCRIPTION", ..] => {
            InTransaction::Never
        }
        ["CREATE" | "DROP" | "REINDEX", ..] if concurrently() => InTransaction::Never,
        _ => InTransaction::Fine,
    };
    Some((check, role))
}

/// One `SELECT`, `WITH`, `VALUES` or `TABLE` statement without a `LIMIT`,
/// `OFFSET`, `FETCH` or `INTO` of its own at the top level: what a query tab
/// pages through a cursor. Queries that bound themselves are left alone.
pub fn pages_by_cursor(sql: &str) -> bool {
    let statements: Vec<Vec<Tok>> = tokenize(sql)
        .into_iter()
        .filter(|s| !s.is_empty())
        .collect();
    let [statement] = statements.as_slice() else {
        return false;
    };
    if statement.contains(&Tok::Unclear) {
        return false;
    }
    if !matches!(
        statement[0].word(),
        Some("SELECT" | "WITH" | "VALUES" | "TABLE")
    ) {
        return false;
    }
    let mut depth = 0i32;
    for tok in statement {
        match tok {
            Tok::Open => depth += 1,
            Tok::Close => depth -= 1,
            Tok::Word(w, _)
                if depth == 0 && matches!(w.as_str(), "LIMIT" | "OFFSET" | "FETCH" | "INTO") =>
            {
                return false
            }
            _ => {}
        }
    }
    true
}

/// Has a locking clause (`FOR UPDATE`, `FOR NO KEY UPDATE`, `FOR SHARE`,
/// `FOR KEY SHARE`) anywhere: through a cursor it would lock only the rows
/// fetched so far, not every row it matches.
pub fn locks_rows(sql: &str) -> bool {
    tokenize(sql).iter().any(|statement| {
        statement.windows(2).any(|pair| {
            pair[0].is("FOR") && matches!(pair[1].word(), Some("UPDATE" | "SHARE" | "NO" | "KEY"))
        })
    })
}

#[derive(Clone, Debug, PartialEq, Eq)]
enum Tok {
    /// A bare word, upper-cased, with its text as written.
    Word(String, String),
    /// A double-quoted or backticked identifier, as written.
    Quoted(String),
    Open,
    Close,
    Dot,
    Other(char),
    /// Text servers may read differently (see [`skip_string`],
    /// [`skip_block_comment`]) or that never ends.
    Unclear,
}

impl Tok {
    fn word(&self) -> Option<&str> {
        match self {
            Tok::Word(w, _) => Some(w),
            _ => None,
        }
    }
    fn is(&self, w: &str) -> bool {
        self.word() == Some(w)
    }
}

/// Statements (split on top-level `;`) as tokens. Strings, numbers and
/// comments are dropped; dollar-quoted bodies are dropped too.
fn tokenize(sql: &str) -> Vec<Vec<Tok>> {
    tokenize_spans(sql).0
}

/// `tokenize`, with each statement's byte range in `sql` (its `;` left out).
fn tokenize_spans(sql: &str) -> (Vec<Vec<Tok>>, Vec<std::ops::Range<usize>>) {
    let b = sql.as_bytes();
    let mut out = vec![Vec::new()];
    let mut spans = Vec::new();
    let mut start = 0;
    let mut i = 0;
    while let Some((lexeme, end)) = lex(b, i, true) {
        let toks = out.last_mut().unwrap();
        match lexeme {
            Lexeme::String { clear } => push_string(toks, clear),
            Lexeme::Quoted { closed } => {
                if !closed {
                    toks.push(Tok::Unclear);
                }
                toks.push(Tok::Quoted(sql[i..end].to_string()));
            }
            Lexeme::BlockComment { clear: false } => toks.push(Tok::Unclear),
            Lexeme::Dollar { closed } => {
                if !closed {
                    toks.push(Tok::Unclear);
                }
                toks.push(Tok::Other('$'));
            }
            Lexeme::Semicolon => {
                out.push(Vec::new());
                spans.push(start..i);
                start = end;
            }
            Lexeme::Open => toks.push(Tok::Open),
            Lexeme::Close => toks.push(Tok::Close),
            Lexeme::Dot => toks.push(Tok::Dot),
            Lexeme::Word => {
                let text = &sql[i..end];
                toks.push(Tok::Word(text.to_ascii_uppercase(), text.to_string()));
            }
            Lexeme::Number => toks.push(Tok::Other('0')),
            Lexeme::Other => toks.push(Tok::Other(b[i] as char)),
            Lexeme::LineComment
            | Lexeme::BlockComment { clear: true }
            | Lexeme::Space
            | Lexeme::Skip => {}
        }
        i = end;
    }
    spans.push(start..b.len().max(start));
    (out, spans)
}

/// Each statement's text as the editor splits `sql`, trimmed, empty ones
/// left out: what the SQL file reader must agree with.
#[cfg(test)]
pub(crate) fn split_statements(sql: &str) -> Vec<String> {
    let (toks, spans) = tokenize_spans(sql);
    toks.iter()
        .zip(spans)
        .filter(|(t, _)| !t.is_empty())
        .map(|(_, span)| sql[span].trim().to_string())
        .collect()
}

/// One lexeme of SQL text, as [`lex`] finds it.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum Lexeme {
    /// `'…'` or `E'…'`; `clear` as [`skip_string`] judges it.
    String {
        clear: bool,
    },
    /// `"…"` or `` `…` ``.
    Quoted {
        closed: bool,
    },
    LineComment,
    /// `clear` as [`skip_block_comment`] judges it.
    BlockComment {
        clear: bool,
    },
    /// A `$tag$ … $tag$` body.
    Dollar {
        closed: bool,
    },
    /// A `$` that opens no body: nothing.
    Skip,
    Semicolon,
    Open,
    Close,
    Dot,
    Word,
    Number,
    Space,
    /// Any other byte, as itself.
    Other,
}

/// The lexeme starting at `b[i]` and where it ends, with the editor's quoting
/// rules; `None` at the end of `b`. Unless `eof`, more text may follow `b`:
/// a lexeme that might go on past it is `None` too, for the caller to read
/// more and ask again from `i` (the SQL file reader streams this way).
pub(crate) fn lex(b: &[u8], mut i: usize, eof: bool) -> Option<(Lexeme, usize)> {
    let n = b.len();
    let start = i;
    // A lexeme that ran into the end of `b` is final only when nothing follows.
    let done = |lexeme: Lexeme, end: usize, open: bool| (eof || !open).then_some((lexeme, end));
    let c = *b.get(i)?;
    match c {
        b'\'' => {
            // Even a string closed by the last byte may go on: `''` is a quote.
            let (end, clear, _) = skip_string(b, i, false);
            done(Lexeme::String { clear }, end, end == n)
        }
        b'"' | b'`' => {
            i += 1;
            while i < n && b[i] != c {
                i += 1;
            }
            let closed = i < n;
            done(Lexeme::Quoted { closed }, (i + 1).min(n), !closed)
        }
        b'-' if b.get(i + 1) == Some(&b'-') => {
            while i < n && b[i] != b'\n' {
                i += 1;
            }
            done(Lexeme::LineComment, i, i == n)
        }
        b'/' if b.get(i + 1) == Some(&b'*') => {
            let (end, clear, closed) = skip_block_comment(b, i);
            done(Lexeme::BlockComment { clear }, end, !closed)
        }
        b'-' | b'/' if i + 1 == n => done(Lexeme::Other, n, true),
        b'$' => {
            // `$tag$ … $tag$`: the tag is empty or an identifier, so not
            // `$1`; never inside a word, which takes its own `$`.
            let mut e = i + 1;
            while e < n && (b[e].is_ascii_alphanumeric() || b[e] == b'_' || b[e] >= 0x80) {
                e += 1;
            }
            if e == n {
                return done(Lexeme::Skip, i + 1, true);
            }
            if b[e] != b'$' || b[i + 1].is_ascii_digit() {
                return Some((Lexeme::Skip, i + 1));
            }
            let tag = &b[i..=e];
            match b[e + 1..].windows(tag.len()).position(|w| w == tag) {
                Some(p) => Some((Lexeme::Dollar { closed: true }, e + 1 + p + tag.len())),
                None => done(Lexeme::Dollar { closed: false }, n, true),
            }
        }
        b';' => Some((Lexeme::Semicolon, i + 1)),
        b'(' => Some((Lexeme::Open, i + 1)),
        b')' => Some((Lexeme::Close, i + 1)),
        b'.' => Some((Lexeme::Dot, i + 1)),
        _ if c.is_ascii_alphabetic() || c == b'_' || c >= 0x80 => {
            while i < n
                && (b[i].is_ascii_alphanumeric() || b[i] == b'_' || b[i] == b'$' || b[i] >= 0x80)
            {
                i += 1;
            }
            if i == n {
                return done(Lexeme::Word, i, true);
            }
            if i == start + 1 && (c == b'E' || c == b'e') && b[i] == b'\'' {
                // `E'…'` takes backslash escapes: `E'\''` is one quote.
                let (end, clear, _) = skip_string(b, i, true);
                return done(Lexeme::String { clear }, end, end == n);
            }
            Some((Lexeme::Word, i))
        }
        _ if c.is_ascii_digit() => {
            while i < n && (b[i].is_ascii_alphanumeric() || b[i] == b'.') {
                i += 1;
            }
            done(Lexeme::Number, i, i == n)
        }
        _ if c.is_ascii_whitespace() => Some((Lexeme::Space, i + 1)),
        _ => Some((Lexeme::Other, i + 1)),
    }
}

/// Past the string opening at `b[i]` (a `'`), whether every server reads
/// it the same way, and whether it closed. `''` is a quote; with `backslash`
/// (an `E'…'` string) `\` escapes the next byte too. Unclear: it never ends, or a
/// plain string holds `\'`, which Postgres with `standard_conforming_strings`
/// off reads as a quote that doesn't end the string.
fn skip_string(b: &[u8], mut i: usize, backslash: bool) -> (usize, bool, bool) {
    let n = b.len();
    let mut clear = true;
    i += 1;
    while i < n {
        match b[i] {
            b'\\' if backslash => {
                i += 2;
                continue;
            }
            b'\\' if b.get(i + 1) == Some(&b'\'') => clear = false,
            b'\'' if b.get(i + 1) == Some(&b'\'') => {
                i += 2;
                continue;
            }
            b'\'' => return (i + 1, clear, true),
            _ => {}
        }
        i += 1;
    }
    (n, false, false)
}

/// Past the `/* … */` comment opening at `b[i]`, whether every server
/// reads it the same way, and whether it closed. Postgres nests them
/// (`/* /* */ */` is one comment); SQLite ends one at the first `*/`. So a nested one is unclear,
/// and so is one that never ends.
fn skip_block_comment(b: &[u8], mut i: usize) -> (usize, bool, bool) {
    let n = b.len();
    let mut depth = 1;
    let mut clear = true;
    i += 2;
    while i < n {
        if b[i] == b'/' && b.get(i + 1) == Some(&b'*') {
            depth += 1;
            clear = false;
            i += 2;
        } else if b[i] == b'*' && b.get(i + 1) == Some(&b'/') {
            depth -= 1;
            i += 2;
            if depth == 0 {
                return (i, clear, true);
            }
        } else {
            i += 1;
        }
    }
    (n, false, false)
}

fn push_string(toks: &mut Vec<Tok>, clear: bool) {
    if !clear {
        toks.push(Tok::Unclear);
    }
    toks.push(Tok::Other('\''));
}

/// Most statements one `propose_change` may hold.
pub const MAX_PROPOSED_STATEMENTS: usize = 20;

/// One statement of a change an agent proposes: a plain INSERT, UPDATE or
/// DELETE on one table.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct RowChange {
    /// `INSERT`, `UPDATE` or `DELETE`.
    pub verb: String,
    /// The table as written (`public.orders`, `"Orders"`).
    pub target: String,
    /// The statement's text, trimmed, without its `;`.
    pub sql: String,
    /// DELETE / UPDATE with no WHERE.
    pub destructive: bool,
}

/// The statements of a proposed change, or why it can't be one. Only plain
/// INSERT, UPDATE and DELETE pass: no CTEs (Rowkery wraps each statement in
/// its own to preview it), no RETURNING (Rowkery adds its own), and no
/// UPDATE … FROM or DELETE … USING (the preview matches rows of one table).
pub fn row_changes(sql: &str) -> Result<Vec<RowChange>, String> {
    let (statements, spans) = tokenize_spans(sql);
    let mut out = Vec::new();
    for (toks, span) in statements.iter().zip(spans) {
        if toks.is_empty() {
            continue;
        }
        if toks.contains(&Tok::Unclear) {
            return Err(
                "Refused: Rowkery can't be sure where a string or comment in this statement ends. Write strings as '…' with '' for a quote, and close every comment."
                    .into(),
            );
        }
        let check = check_statement(toks);
        let verb = toks[0].word().unwrap_or("");
        if !matches!(verb, "INSERT" | "UPDATE" | "DELETE") {
            return Err(format!(
                "Refused: a proposed change can only hold INSERT, UPDATE and DELETE statements, and this one starts with {}. Schema changes, CTEs and function calls stay with the user.",
                if check.verb.is_empty() { "something else" } else { check.verb.as_str() }
            ));
        }
        let word_at_top = |w: &str| top_level(toks).any(|t| t.is(w));
        if word_at_top("RETURNING") {
            return Err(
                "Refused: leave out RETURNING. Rowkery shows the user the changed rows itself."
                    .into(),
            );
        }
        if (verb == "UPDATE" && word_at_top("FROM")) || (verb == "DELETE" && word_at_top("USING")) {
            return Err(format!(
                "Refused: {verb} … {} isn't accepted in a proposed change. Name the rows with WHERE … IN (SELECT …) instead.",
                if verb == "UPDATE" { "FROM" } else { "USING" }
            ));
        }
        let Some(target) = check.target else {
            return Err(format!(
                "Refused: Rowkery couldn't tell which table this {verb} changes."
            ));
        };
        out.push(RowChange {
            verb: verb.to_string(),
            target,
            sql: sql[span].trim().to_string(),
            destructive: check.destructive,
        });
    }
    if out.is_empty() {
        return Err("There's no statement in sql.".into());
    }
    if out.len() > MAX_PROPOSED_STATEMENTS {
        return Err(format!(
            "Refused: a proposed change holds at most {MAX_PROPOSED_STATEMENTS} statements. Split it into smaller changes."
        ));
    }
    Ok(out)
}

/// Every identifier in `sql`, lower-cased, quotes taken off (strings and
/// comments left out): which columns a statement names.
pub fn identifiers(sql: &str) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    for tok in tokenize(sql).iter().flatten() {
        let name = match tok {
            Tok::Word(_, text) => text.to_lowercase(),
            Tok::Quoted(text) => text.trim_matches(|c| c == '"' || c == '`').to_lowercase(),
            _ => continue,
        };
        if !out.contains(&name) {
            out.push(name);
        }
    }
    out
}

const DATA_VERBS: &[&str] = &["INSERT", "UPDATE", "DELETE", "MERGE", "UPSERT", "REPLACE"];

/// Object types that follow CREATE / ALTER / DROP (first word only).
const OBJECT_TYPES: &[&str] = &[
    "TABLE",
    "INDEX",
    "VIEW",
    "MATERIALIZED",
    "SCHEMA",
    "SEQUENCE",
    "FUNCTION",
    "PROCEDURE",
    "TYPE",
    "DATABASE",
    "EXTENSION",
    "TRIGGER",
    "ROLE",
    "USER",
    "POLICY",
    "DOMAIN",
    "COLUMN",
    "CONSTRAINT",
    "OWNED",
    "RULE",
    "PUBLICATION",
    "SUBSCRIPTION",
    "SERVER",
    "TABLESPACE",
    "COLLATION",
    "AGGREGATE",
    "OPERATOR",
    "EVENT",
    "FOREIGN",
    "GROUP",
    "STATISTICS",
    "TEXT",
    "LANGUAGE",
    "CAST",
    "CONVERSION",
    "ACCESS",
    "DEFAULT",
];

/// Words skipped between a verb and the object it names.
const MODIFIERS: &[&str] = &[
    "OR",
    "REPLACE",
    "TEMP",
    "TEMPORARY",
    "UNLOGGED",
    "UNIQUE",
    "GLOBAL",
    "LOCAL",
    "IF",
    "NOT",
    "EXISTS",
    "CONCURRENTLY",
    "ONLY",
    "INTO",
    "FROM",
    "TABLE",
    "RECURSIVE",
    "VIRTUAL",
    "IGNORE",
    "ABORT",
    "FAIL",
    "ROLLBACK",
    "LOW_PRIORITY",
    "DELAYED",
    "QUICK",
];

fn check_statement(toks: &[Tok]) -> StatementCheck {
    // `(SELECT …) UNION …`: judge by the first word.
    let lead = toks.iter().take_while(|t| **t == Tok::Open).count();
    let toks = if lead < toks.len() {
        &toks[lead..]
    } else {
        toks
    };
    let first = toks[0].word().unwrap_or("");
    let session = |unlocks: bool| StatementCheck {
        kind: StatementKind::Session,
        verb: first.to_string(),
        target: None,
        destructive: false,
        unlocks_writes: unlocks,
    };
    let read = || StatementCheck {
        kind: StatementKind::Read,
        verb: first.to_string(),
        target: None,
        destructive: false,
        unlocks_writes: false,
    };
    match first {
        "SELECT" => {
            // `SELECT … INTO new_table` creates a table (Postgres).
            if top_level(toks).any(|t| t.is("INTO")) {
                data_check(toks, "SELECT INTO", 0)
            } else {
                read()
            }
        }
        "WITH" => {
            // A data-modifying CTE or main statement makes the whole run a write.
            match toks
                .iter()
                .position(|t| t.word().is_some_and(|w| DATA_VERBS[..4].contains(&w)))
            {
                Some(p) => data_check(toks, toks[p].word().unwrap(), p),
                None => read(),
            }
        }
        "EXPLAIN" => explain_check(toks),
        "SHOW" | "VALUES" | "TABLE" | "FETCH" | "MOVE" | "DECLARE" | "CLOSE" | "LISTEN"
        | "UNLISTEN" | "DESCRIBE" | "DESC" => read(),
        "PRAGMA" => {
            // `PRAGMA x` and `PRAGMA table_info(t)` read; `PRAGMA x = v` sets.
            let sets = toks.contains(&Tok::Other('='));
            if toks.iter().any(|t| t.is("QUERY_ONLY")) && (sets || toks.contains(&Tok::Open)) {
                session(true)
            } else if sets {
                StatementCheck {
                    kind: StatementKind::Write,
                    verb: "PRAGMA".into(),
                    target: None,
                    destructive: false,
                    unlocks_writes: false,
                }
            } else {
                read()
            }
        }
        "SET" | "RESET" | "BEGIN" | "START" | "COMMIT" | "END" | "ROLLBACK" | "ABORT"
        | "SAVEPOINT" | "RELEASE" | "DISCARD" | "DEALLOCATE" | "PREPARE" => {
            session(unlocks_writes(first, toks))
        }
        "INSERT" | "UPDATE" | "DELETE" | "MERGE" | "UPSERT" | "REPLACE" => {
            data_check(toks, first, 0)
        }
        "COPY" => {
            // `COPY t TO …` / `COPY (SELECT …) TO …` reads.
            if top_level(toks).any(|t| t.is("FROM")) {
                data_check(toks, "COPY", 0)
            } else {
                read()
            }
        }
        "CREATE" | "ALTER" | "DROP" | "TRUNCATE" | "GRANT" | "REVOKE" | "COMMENT" | "REINDEX"
        | "VACUUM" | "CLUSTER" | "ANALYZE" | "ANALYSE" | "SECURITY" | "IMPORT" | "REASSIGN"
        | "ATTACH" | "DETACH" | "REFRESH" => schema_check(toks, first),
        _ => StatementCheck {
            // CALL, DO, EXECUTE, LOCK, NOTIFY and anything unrecognised.
            kind: StatementKind::Write,
            verb: toks[0]
                .word()
                .map(str::to_string)
                .unwrap_or_else(|| "Statement".into()),
            target: None,
            destructive: false,
            unlocks_writes: false,
        },
    }
}

/// Tokens outside any parentheses.
fn top_level(toks: &[Tok]) -> impl Iterator<Item = &Tok> {
    let mut depth = 0i32;
    toks.iter().filter(move |t| {
        match t {
            Tok::Open => depth += 1,
            Tok::Close => depth -= 1,
            _ => return depth == 0,
        }
        false
    })
}

/// INSERT / UPDATE / DELETE / MERGE starting at `at`.
fn data_check(toks: &[Tok], verb: &str, at: usize) -> StatementCheck {
    let rest = &toks[at..];
    let target = if verb == "SELECT INTO" {
        let into = rest.iter().position(|t| t.is("INTO")).unwrap_or(0);
        object_name(&rest[into + 1..])
    } else {
        object_name(&rest[1..])
    };
    // DELETE / UPDATE with no WHERE at their own level touch every row.
    let destructive = matches!(verb, "DELETE" | "UPDATE") && {
        let mut depth = 0i32;
        !rest.iter().any(|t| {
            match t {
                Tok::Open => depth += 1,
                Tok::Close => depth -= 1,
                _ => {}
            }
            depth == 0 && t.is("WHERE")
        })
    };
    StatementCheck {
        kind: StatementKind::Write,
        verb: verb.to_string(),
        target,
        destructive,
        unlocks_writes: false,
    }
}

fn schema_check(toks: &[Tok], first: &str) -> StatementCheck {
    let mut verb = first.to_string();
    let mut i = 1;
    while i < toks.len()
        && toks[i]
            .word()
            .is_some_and(|w| MODIFIERS.contains(&w) && w != "TABLE")
    {
        i += 1;
    }
    if matches!(first, "CREATE" | "ALTER" | "DROP" | "COMMENT" | "REFRESH") {
        if first == "COMMENT" {
            // COMMENT ON TABLE x
            if toks.get(i).is_some_and(|t| t.is("ON")) {
                i += 1;
            }
        }
        if let Some(obj) = toks
            .get(i)
            .and_then(Tok::word)
            .filter(|w| OBJECT_TYPES.contains(w))
        {
            verb.push(' ');
            verb.push_str(obj);
            i += 1;
            if obj == "MATERIALIZED" && toks.get(i).is_some_and(|t| t.is("VIEW")) {
                verb.push_str(" VIEW");
                i += 1;
            }
        }
    }
    let target = if matches!(
        first,
        "GRANT" | "REVOKE" | "SECURITY" | "IMPORT" | "REASSIGN"
    ) {
        None
    } else {
        object_name(&toks[i.min(toks.len())..])
    };
    StatementCheck {
        kind: StatementKind::Schema,
        destructive: matches!(first, "DROP" | "TRUNCATE"),
        verb,
        target,
        unlocks_writes: false,
    }
}

/// `EXPLAIN ANALYZE` runs its statement, so it is checked like the statement.
fn explain_check(toks: &[Tok]) -> StatementCheck {
    let mut i = 1;
    let mut analyze = false;
    if toks.get(1) == Some(&Tok::Open) {
        // EXPLAIN (ANALYZE, BUFFERS) …; `ANALYZE false` / `off` doesn't run it.
        let close = toks
            .iter()
            .position(|t| *t == Tok::Close)
            .unwrap_or(toks.len() - 1);
        let opts = &toks[2..close];
        analyze = opts.iter().enumerate().any(|(k, t)| {
            (t.is("ANALYZE") || t.is("ANALYSE"))
                && !opts
                    .get(k + 1)
                    .is_some_and(|v| v.is("FALSE") || v.is("OFF"))
        });
        i = close + 1;
    } else {
        while let Some(w) = toks.get(i).and_then(Tok::word) {
            match w {
                "ANALYZE" | "ANALYSE" => analyze = true,
                "VERBOSE" | "QUERY" | "PLAN" => {}
                _ => break,
            }
            i += 1;
        }
    }
    let inner = (i < toks.len()).then(|| check_statement(&toks[i..]));
    if let Some(inner) = inner.filter(|c| analyze && c.changes_data()) {
        StatementCheck {
            verb: format!("EXPLAIN ANALYZE {}", inner.verb),
            ..inner
        }
    } else {
        StatementCheck {
            kind: StatementKind::Read,
            verb: "EXPLAIN".into(),
            target: None,
            destructive: false,
            unlocks_writes: false,
        }
    }
}

/// Session statements that would let a read-only session write.
fn unlocks_writes(first: &str, toks: &[Tok]) -> bool {
    let has = |w: &str| toks.iter().any(|t| t.is(w));
    let read_write = toks.windows(2).any(|p| p[0].is("READ") && p[1].is("WRITE"));
    match first {
        "SET" | "RESET" => {
            read_write
                || has("TRANSACTION_READ_ONLY")
                || has("DEFAULT_TRANSACTION_READ_ONLY")
                || (first == "RESET" && has("ALL"))
        }
        "BEGIN" | "START" => read_write,
        "DISCARD" => has("ALL"),
        _ => false,
    }
}

/// The dotted name at the start of `toks`, skipping modifiers, as written.
fn object_name(toks: &[Tok]) -> Option<String> {
    let mut i = 0;
    while toks
        .get(i)
        .and_then(Tok::word)
        .is_some_and(|w| MODIFIERS.contains(&w))
    {
        i += 1;
    }
    let mut name = String::new();
    loop {
        match toks.get(i) {
            Some(Tok::Word(_, text)) => name.push_str(text),
            Some(Tok::Quoted(text)) => name.push_str(text),
            _ => break,
        }
        if toks.get(i + 1) == Some(&Tok::Dot) {
            name.push('.');
            i += 2;
        } else {
            break;
        }
    }
    (!name.is_empty() && !name.ends_with('.')).then_some(name)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn proposed_changes_take_plain_row_statements_only() {
        let ok = row_changes(
            "UPDATE public.orders SET status = 'a;b' WHERE id = 1; -- done\n\
             INSERT INTO \"Notes\" (body) VALUES ('x'); DELETE FROM t",
        )
        .unwrap();
        assert_eq!(ok.len(), 3);
        assert_eq!(ok[0].target, "public.orders");
        assert_eq!(
            ok[0].sql,
            "UPDATE public.orders SET status = 'a;b' WHERE id = 1"
        );
        assert_eq!(ok[1].target, "\"Notes\"");
        assert!(ok[2].destructive && !ok[0].destructive);
        for bad in [
            "DROP TABLE t",
            "WITH x AS (SELECT 1) DELETE FROM t",
            "SELECT 1",
            "UPDATE t SET a = 1 RETURNING *",
            "UPDATE t SET a = u.a FROM u WHERE u.id = t.id",
            "DELETE FROM t USING u WHERE u.id = t.id",
            "CALL p()",
            "",
        ] {
            assert!(row_changes(bad).is_err(), "{bad}");
        }
        // FROM inside a subquery is fine.
        assert!(row_changes("UPDATE t SET a = 1 WHERE id IN (SELECT id FROM u)").is_ok());
        assert!(row_changes(&"DELETE FROM t WHERE id = 1;".repeat(21)).is_err());
    }

    #[test]
    fn identifiers_skip_strings_and_comments() {
        let ids = identifiers("UPDATE c SET \"Email\" = 'email' -- email\n WHERE id = 1");
        assert!(ids.contains(&"email".to_string()));
        assert_eq!(identifiers("SELECT 'email' /* email */"), vec!["select"]);
    }

    fn one(sql: &str) -> StatementCheck {
        let mut all = check_sql(sql);
        assert_eq!(all.len(), 1, "{sql}: {all:?}");
        all.remove(0)
    }

    fn kind(sql: &str) -> StatementKind {
        one(sql).kind
    }

    #[test]
    fn reads() {
        for sql in [
            "SELECT * FROM wallets",
            "select 1;",
            "  -- comment\n SELECT 'DELETE FROM x' AS hint",
            "WITH t AS (SELECT 1) SELECT * FROM t",
            "SHOW search_path",
            "EXPLAIN SELECT * FROM t",
            "EXPLAIN DELETE FROM t",
            "EXPLAIN (ANALYZE false) DELETE FROM t",
            "EXPLAIN ANALYZE SELECT 1",
            "EXPLAIN",
            "(SELECT 1) UNION (SELECT 2)",
            "VALUES (1), (2)",
            "TABLE wallets",
            "COPY wallets TO STDOUT",
            "COPY (SELECT 1) TO STDOUT",
            "PRAGMA table_info(wallets)",
            "PRAGMA user_version",
            "SELECT $$ drop table x $$",
            "SELECT \"update\" FROM t",
            "SELECT * FROM t FOR UPDATE",
        ] {
            assert_eq!(kind(sql), StatementKind::Read, "{sql}");
        }
    }

    #[test]
    fn writes() {
        for sql in [
            "INSERT INTO wallets (id) VALUES (1)",
            "UPDATE wallets SET balance = 0 WHERE id = 1",
            "DELETE FROM wallet_tx WHERE settled = false",
            "MERGE INTO t USING s ON t.id = s.id WHEN MATCHED THEN DELETE",
            "WITH gone AS (DELETE FROM t RETURNING *) SELECT count(*) FROM gone",
            "WITH x AS (SELECT 1) INSERT INTO t SELECT * FROM x",
            "EXPLAIN ANALYZE DELETE FROM t",
            "EXPLAIN (ANALYZE, BUFFERS) UPDATE t SET a = 1",
            "COPY wallets FROM '/tmp/w.csv'",
            "SELECT * INTO archive FROM wallets",
            "CALL settle()",
            "DO $$ BEGIN DELETE FROM t; END $$",
            "LOCK TABLE t",
            "PRAGMA user_version = 3",
            "REPLACE INTO t VALUES (1)",
            "frobnicate the database",
        ] {
            assert_eq!(kind(sql), StatementKind::Write, "{sql}");
        }
    }

    #[test]
    fn schema_changes() {
        for (sql, verb, target) in [
            (
                "CREATE TABLE public.t (id int)",
                "CREATE TABLE",
                Some("public.t"),
            ),
            (
                "create unique index concurrently if not exists t_a on t (a)",
                "CREATE INDEX",
                Some("t_a"),
            ),
            (
                "CREATE OR REPLACE VIEW v AS SELECT 1",
                "CREATE VIEW",
                Some("v"),
            ),
            (
                "ALTER TABLE ONLY wallets DROP COLUMN note",
                "ALTER TABLE",
                Some("wallets"),
            ),
            (
                "DROP TABLE IF EXISTS \"Old Wallets\"",
                "DROP TABLE",
                Some("\"Old Wallets\""),
            ),
            (
                "DROP MATERIALIZED VIEW daily",
                "DROP MATERIALIZED VIEW",
                Some("daily"),
            ),
            ("TRUNCATE TABLE logs", "TRUNCATE", Some("logs")),
            ("TRUNCATE logs, events", "TRUNCATE", Some("logs")),
            (
                "REFRESH MATERIALIZED VIEW daily",
                "REFRESH MATERIALIZED VIEW",
                Some("daily"),
            ),
            ("GRANT SELECT ON t TO bob", "GRANT", None),
            ("COMMENT ON TABLE t IS 'x'", "COMMENT TABLE", Some("t")),
            ("VACUUM", "VACUUM", None),
        ] {
            let c = one(sql);
            assert_eq!(c.kind, StatementKind::Schema, "{sql}");
            assert_eq!(c.verb, verb, "{sql}");
            assert_eq!(c.target.as_deref(), target, "{sql}");
        }
    }

    #[test]
    fn session_statements() {
        for sql in [
            "SET search_path TO app",
            "BEGIN",
            "COMMIT",
            "ROLLBACK",
            "SAVEPOINT a",
        ] {
            let c = one(sql);
            assert_eq!(c.kind, StatementKind::Session, "{sql}");
            assert!(!c.unlocks_writes, "{sql}");
        }
        for sql in [
            "SET default_transaction_read_only = off",
            "SET SESSION transaction_read_only TO false",
            "SET SESSION CHARACTERISTICS AS TRANSACTION READ WRITE",
            "SET TRANSACTION READ WRITE",
            "BEGIN READ WRITE",
            "START TRANSACTION ISOLATION LEVEL SERIALIZABLE, READ WRITE",
            "RESET ALL",
            "RESET default_transaction_read_only",
            "DISCARD ALL",
            "PRAGMA query_only = 0",
            "PRAGMA query_only(false)",
        ] {
            assert!(one(sql).unlocks_writes, "{sql}");
        }
    }

    #[test]
    fn destructive_statements() {
        assert!(one("DELETE FROM users").destructive);
        assert!(one("UPDATE wallets SET balance = 0").destructive);
        assert!(one("UPDATE t SET a = (SELECT b FROM s WHERE s.id = 1)").destructive);
        assert!(one("DROP TABLE t").destructive);
        assert!(one("TRUNCATE t").destructive);
        assert!(!one("DELETE FROM users WHERE id = 1").destructive);
        assert!(!one("UPDATE t SET a = 1 WHERE id IN (SELECT id FROM s)").destructive);
        assert!(!one("CREATE TABLE t (id int)").destructive);
    }

    #[test]
    fn targets_as_written() {
        assert_eq!(
            one("DELETE FROM public.Wallet_Tx WHERE id = 1")
                .target
                .as_deref(),
            Some("public.Wallet_Tx")
        );
        assert_eq!(
            one("INSERT INTO \"Orders\" VALUES (1)").target.as_deref(),
            Some("\"Orders\"")
        );
        assert_eq!(one("UPDATE ONLY t SET a = 1").target.as_deref(), Some("t"));
        assert_eq!(
            one("SELECT a INTO TEMP backup FROM t").target.as_deref(),
            Some("backup")
        );
    }

    #[test]
    fn splits_statements_like_the_editor() {
        let all = check_sql("SELECT ';'; -- ; \n DELETE FROM t; /* ; */ ;; SELECT $x$ ; $x$");
        let kinds: Vec<_> = all.iter().map(|c| c.kind).collect();
        assert_eq!(
            kinds,
            [
                StatementKind::Read,
                StatementKind::Write,
                StatementKind::Read
            ]
        );
    }

    #[test]
    fn modes() {
        let sql = "SELECT 1; UPDATE t SET a = 1 WHERE id = 2";
        assert_eq!(hold_for(SafeMode::Off, sql, false), None);
        assert_eq!(
            hold_for(SafeMode::Confirm, "SELECT 1; SET x = 1", false),
            None
        );
        let held = hold_for(SafeMode::Confirm, sql, false).unwrap();
        assert_eq!(held.action, HoldAction::Confirm);
        assert_eq!(held.statements.len(), 1);
        assert_eq!(held.statements[0].verb, "UPDATE");
        assert_eq!(hold_for(SafeMode::Confirm, sql, true), None);
        // Confirming never lets a read-only connection write.
        let refused = hold_for(SafeMode::ReadOnly, sql, true).unwrap();
        assert_eq!(refused.action, HoldAction::Refuse);
        // Unlocking writes is fine to confirm, refused when read-only.
        assert_eq!(
            hold_for(SafeMode::Confirm, "SET transaction_read_only = off", false),
            None
        );
        assert!(hold_for(SafeMode::ReadOnly, "RESET ALL", false).is_some());
        assert_eq!(hold_for(SafeMode::ReadOnly, "SELECT * FROM t", false), None);
    }

    #[test]
    fn serde_names() {
        assert_eq!(
            serde_json::to_string(&SafeMode::ReadOnly).unwrap(),
            "\"read_only\""
        );
        assert_eq!(
            serde_json::to_string(&StatementKind::Schema).unwrap(),
            "\"schema\""
        );
    }

    #[test]
    fn stopping_a_session_is_a_write() {
        for sql in [
            "SELECT pg_terminate_backend(42)",
            "select pg_cancel_backend(pid) from pg_stat_activity where state = 'active'",
            "WITH x AS (SELECT pg_catalog.pg_terminate_backend(1)) SELECT * FROM x",
        ] {
            let checks = check_sql(sql);
            assert_eq!(checks[0].kind, StatementKind::Write, "{sql}");
            assert!(hold_for(SafeMode::ReadOnly, sql, true).is_some(), "{sql}");
            assert!(hold_for(SafeMode::Confirm, sql, false).is_some(), "{sql}");
        }
        assert!(check_sql("SELECT pg_terminate_backend(1)")[0].destructive);
        assert!(!check_sql("SELECT pg_cancel_backend(1)")[0].destructive);
        // Named, not called: still a read.
        for sql in [
            "SELECT 'pg_terminate_backend(1)'",
            "SELECT proname FROM pg_proc WHERE proname = 'pg_cancel_backend'",
        ] {
            assert_eq!(check_sql(sql)[0].kind, StatementKind::Read, "{sql}");
        }
    }

    #[test]
    fn locks_rows_finds_locking_clauses() {
        for sql in [
            "SELECT * FROM t FOR UPDATE",
            "select * from t for no key update skip locked",
            "SELECT * FROM t FOR SHARE OF t",
            "SELECT * FROM (SELECT * FROM t FOR KEY SHARE) s",
        ] {
            assert!(locks_rows(sql), "{sql}");
        }
        for sql in [
            "SELECT * FROM t",
            "SELECT substring(name FROM 1 FOR 3) FROM t",
            "SELECT 'for update' AS s",
            "SELECT \"for\" FROM t",
        ] {
            assert!(!locks_rows(sql), "{sql}");
        }
    }

    #[test]
    fn pages_by_cursor_only_unbounded_reads() {
        for sql in [
            "SELECT * FROM t",
            "select * from t;  -- all of it\n",
            "WITH x AS (SELECT * FROM t LIMIT 5) SELECT * FROM x",
            "VALUES (1), (2)",
            "TABLE t",
            "SELECT nextval('s') FROM generate_series(1, 10)",
            "SELECT 'limit 5; offset 1' AS s",
            "SELECT \"limit\" FROM t",
        ] {
            assert!(pages_by_cursor(sql), "{sql}");
        }
        for sql in [
            "SELECT * FROM t LIMIT 10",
            "SELECT * FROM t OFFSET 3",
            "SELECT * FROM t FETCH FIRST 3 ROWS ONLY",
            "SELECT * INTO t2 FROM t",
            "WITH d AS (DELETE FROM t RETURNING *) INSERT INTO u SELECT * FROM d",
            "SELECT 1; SELECT 2",
            "INSERT INTO t VALUES (1)",
            "BEGIN",
            "",
        ] {
            assert!(!pages_by_cursor(sql), "{sql}");
        }
    }

    fn kinds(sql: &str) -> Vec<StatementKind> {
        check_sql(sql).iter().map(|c| c.kind).collect()
    }

    #[test]
    fn escape_strings_take_backslashes() {
        use StatementKind::*;
        // `E'\''` is one quote, so the `;` after it splits.
        assert_eq!(kinds("SELECT E'\\''; DELETE FROM t"), [Read, Write]);
        assert_eq!(kinds("SELECT e'\\''; DELETE FROM t"), [Read, Write]);
        // `\\` is one backslash; `''` is still a quote inside E'…'.
        assert_eq!(kinds("SELECT E'\\\\'; DELETE FROM t"), [Read, Write]);
        assert_eq!(kinds("SELECT E'it''s; \\n'; DELETE FROM t"), [Read, Write]);
        // An escaped quote keeps the string open across a `;`.
        assert_eq!(kinds("SELECT E'\\'; DELETE FROM t; \\''"), [Read]);
        // A word ending in E is not a prefix; U&'…' is plain quoting.
        assert_eq!(kinds("SELECT the'x'; DELETE FROM t"), [Read, Write]);
        assert_eq!(kinds("SELECT U&'d\\0061t'; DELETE FROM t"), [Read, Write]);
        assert_eq!(identifiers("SELECT E'\\' email'"), vec!["select"]);
    }

    #[test]
    fn block_comments_nest() {
        use StatementKind::*;
        // Postgres reads `/* /* */ … */` as one comment, SQLite as a comment
        // and then text: either way the statement is a write.
        let sql = "SELECT 1 /* /* */ ; DELETE FROM t; */";
        assert_eq!(kinds(sql), [Write]);
        assert_eq!(one(sql).verb, UNCLEAR_VERB);
        assert_eq!(kinds("/* /* */ DELETE FROM t; */ SELECT 1"), [Write]);
        // A plain one is fine, `/*/` and `/**/` included.
        assert_eq!(
            kinds("SELECT /*/ ; */ 1 /**/; DELETE FROM t"),
            [Read, Write]
        );
    }

    #[test]
    fn dollar_tags_take_digits_after_the_first_character() {
        use StatementKind::*;
        assert_eq!(kinds("SELECT $a1$ ; DELETE FROM t; $a1$"), [Read]);
        assert_eq!(kinds("SELECT $_9$ x $_9$; DELETE FROM t"), [Read, Write]);
        assert_eq!(kinds("SELECT $é$ ; $é$; DELETE FROM t"), [Read, Write]);
        // `$1` is a parameter, not a tag: the `;` splits.
        assert_eq!(
            kinds("SELECT $1; DELETE FROM t; SELECT $1"),
            [Read, Write, Read]
        );
        assert_eq!(kinds("SELECT $1$ ; DELETE FROM t"), [Read, Write]);
        // An inner `$a$` doesn't end `$a1$`.
        assert_eq!(kinds("SELECT $a1$ $a$ ; DELETE $a1$"), [Read]);
    }

    #[test]
    fn unclear_text_fails_closed() {
        for sql in [
            "SELECT 'never ends",
            "SELECT E'never ends\\'",
            "SELECT \"never ends",
            "SELECT 1 /* never ends",
            "SELECT $x$ never ends",
            // `standard_conforming_strings = off` reads `\'` as a quote.
            "SELECT '\\'; DELETE FROM t; --'",
            "SELECT 'C:\\'",
        ] {
            let c = check_sql(sql).remove(0);
            assert_eq!(c.kind, StatementKind::Write, "{sql}");
            assert_eq!(c.verb, UNCLEAR_VERB, "{sql}");
            assert!(hold_for(SafeMode::ReadOnly, sql, true).is_some(), "{sql}");
            assert!(hold_for(SafeMode::Confirm, sql, false).is_some(), "{sql}");
            assert!(!pages_by_cursor(sql), "{sql}");
        }
        assert!(row_changes("UPDATE t SET a = 'x\\' WHERE id = 1").is_err());
        // A backslash elsewhere in a plain string is plain text.
        assert_eq!(kind("SELECT 'a\\b', '\\\\x'"), StatementKind::Read);
        // `--` to the end of the text is a finished comment.
        assert_eq!(kind("SELECT 1 -- no newline"), StatementKind::Read);
    }

    /// The audit's strings: each hid a write from safe mode.
    #[test]
    fn hidden_writes_are_seen() {
        let sql = "SELECT E'\\''; COMMIT; BEGIN READ WRITE; DELETE FROM t; COMMIT; --'";
        let checks = check_sql(sql);
        assert_eq!(checks.len(), 5, "{checks:?}");
        assert!(checks.iter().any(|c| c.verb == "DELETE" && c.destructive));
        assert!(checks.iter().any(|c| c.unlocks_writes));
        let held = hold_for(SafeMode::Confirm, sql, false).unwrap();
        assert_eq!(held.statements[0].verb, "DELETE");
        assert_eq!(
            hold_for(SafeMode::ReadOnly, sql, true).unwrap().action,
            HoldAction::Refuse
        );
        assert!(!pages_by_cursor(sql));
        for sql in [
            "SELECT 1 /* /* */ ; DELETE FROM t; */",
            "SELECT $a1$ $$; DELETE FROM t; --$a1$; DELETE FROM t",
        ] {
            assert!(hold_for(SafeMode::Confirm, sql, false).is_some(), "{sql}");
        }

        // The `--` swallows the WHERE: this UPDATE changes every row.
        let sql = "UPDATE t SET a = E'\\'' -- ' WHERE id = 1 '";
        assert!(one(sql).destructive);
        let changes = row_changes(sql).unwrap();
        assert!(changes[0].destructive);
        // Without the E, `\'` is unclear and the proposal is refused.
        assert!(row_changes("UPDATE t SET a = '\\'' -- ' WHERE id = 1 '").is_err());
        // A real WHERE after an E-string still counts.
        assert!(!one("UPDATE t SET a = E'\\'' WHERE id = 1").destructive);
    }
}
