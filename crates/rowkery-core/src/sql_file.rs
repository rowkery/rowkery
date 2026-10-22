//! Run SQL file: a plain `.sql` file (`pg_dump -Fp`, `sqlite3 .dump`, or
//! written by hand), read as a stream so a file of any size runs in flat
//! memory.
//!
//! The file is read twice. [`scan`] reads it first, without touching the
//! database: it counts statements by kind for the panel, refuses what
//! Rowkery can't run (a pg_dump archive, psql commands, COPY on SQLite) and
//! decides whether the file can run as one transaction. Running reads it
//! again, statement by statement ([`Reader`]), and checks first that it is
//! the file that was scanned (same size and modified time).
//!
//! Statements split on `;` with the editor's quoting rules (`safety::lex`),
//! plus psql's rule for routine bodies: inside `CREATE FUNCTION`,
//! `CREATE PROCEDURE` or `CREATE TRIGGER`, a `;` between `BEGIN` and `END`
//! doesn't end the statement (`BEGIN ATOMIC` bodies, SQLite triggers).
//! `COPY … FROM stdin` is followed by its rows up to a `\.` line, which go
//! to the server as COPY data, never through the splitter. pg_dump's
//! `\restrict` / `\unrestrict` lines are skipped; any other psql command
//! stops the run before anything executes.

use std::fs::File;
use std::io::{self, Read, Seek};
use std::path::Path;
use std::time::SystemTime;

use serde::Serialize;

use crate::db::EngineKind;
use crate::safety::{check_file_statement, lex, InTransaction, Lexeme};

/// Bytes read from the file at a time (at least). Tiny in tests, so every
/// lexeme gets cut somewhere.
const CHUNK: usize = if cfg!(test) { 3 } else { 256 * 1024 };
/// The longest statement accepted: Postgres refuses a query over 1 GB too.
pub const MAX_STATEMENT: usize = 1 << 30;
/// COPY data handed to the server at a time (about).
pub const COPY_CHUNK: usize = if cfg!(test) { 8 } else { 256 * 1024 };

/// What the reader found next in the file.
#[derive(Debug, PartialEq, Eq)]
pub enum Piece {
    Statement(Statement),
    /// A psql command line (`\connect db`), as written. `inside`: it came
    /// in the middle of a statement.
    Meta {
        line: u64,
        text: String,
        inside: bool,
    },
}

#[derive(Debug, PartialEq, Eq)]
pub struct Statement {
    /// Numbers the file's statements from 0, the same on every read.
    pub index: u64,
    /// Line of its first word (1-based).
    pub line: u64,
    /// From its first word to its `;` (left out).
    pub sql: String,
    /// The first word, upper-cased.
    pub verb: String,
    /// `COPY … FROM stdin`: its rows follow ([`Reader::copy_chunk`]).
    pub copy_in: bool,
}

/// Why reading the file stopped.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct ReadError {
    pub line: Option<u64>,
    pub message: String,
}

impl ReadError {
    fn at(line: u64, message: impl Into<String>) -> Self {
        Self {
            line: Some(line),
            message: message.into(),
        }
    }
}

impl From<io::Error> for ReadError {
    fn from(e: io::Error) -> Self {
        Self {
            line: None,
            message: format!("Couldn't read the file: {e}"),
        }
    }
}

/// The statement being read: what the splitter needs to know about it.
#[derive(Default)]
struct Pending {
    /// Where its first lexeme starts in the buffer.
    first: Option<usize>,
    words: u32,
    /// Its first four words, upper-cased (`CREATE OR REPLACE FUNCTION`).
    lead: Vec<String>,
    parens: i32,
    copy: Copy,
    /// `CREATE … FUNCTION | PROCEDURE | TRIGGER` ([`Self::is_routine`]).
    routine: bool,
    /// `BEGIN` … `END` depth inside a routine body.
    begin_depth: u32,
    /// The last word was `BEGIN` in a function or procedure: a body only
    /// when `ATOMIC` follows (`begin` alone may be a name).
    after_begin: bool,
    /// A body opened, so the statement must end with its `END`.
    body: bool,
    last_was_end: bool,
}

#[derive(Default, PartialEq, Eq)]
enum Copy {
    #[default]
    No,
    /// `COPY …` saw `FROM`.
    From,
    Stdin,
}

impl Pending {
    /// `CREATE [OR REPLACE] [TEMP] FUNCTION | PROCEDURE | TRIGGER`.
    fn is_routine(&self) -> bool {
        self.routine_kind().is_some()
    }

    fn routine_kind(&self) -> Option<&str> {
        let lead: Vec<&str> = self.lead.iter().map(String::as_str).collect();
        let rest = match lead.as_slice() {
            ["CREATE", "OR", "REPLACE", rest @ ..] | ["CREATE", rest @ ..] => rest,
            _ => return None,
        };
        let rest = match rest {
            ["TEMP" | "TEMPORARY", rest @ ..] => rest,
            _ => rest,
        };
        match rest.first() {
            Some(&kind @ ("FUNCTION" | "PROCEDURE" | "TRIGGER")) => Some(kind),
            _ => None,
        }
    }

    /// Called with each word outside strings and comments. Allocates only
    /// for the first four.
    fn word(&mut self, word: &[u8]) {
        self.words += 1;
        if self.lead.len() < 4 {
            self.lead
                .push(String::from_utf8_lossy(word).to_ascii_uppercase());
            self.routine = self.is_routine();
        } else if !self.routine && self.copy == Copy::No && self.lead[0] != "COPY" {
            return;
        }
        if self.parens != 0 {
            return;
        }
        let is = |w: &str| word.eq_ignore_ascii_case(w.as_bytes());
        if self.lead[0] == "COPY" {
            self.copy = match self.copy {
                Copy::Stdin => Copy::Stdin,
                Copy::From if is("STDIN") => Copy::Stdin,
                _ if is("FROM") => Copy::From,
                _ => Copy::No,
            };
        }
        if self.words > 2 && self.routine {
            // A body is Postgres's `BEGIN ATOMIC` or a SQLite trigger's
            // `BEGIN`; CASE … END only counts inside one, where its END would
            // close it.
            let opens = if std::mem::take(&mut self.after_begin) {
                is("ATOMIC")
            } else if is("BEGIN") {
                let trigger = self.routine_kind() == Some("TRIGGER");
                self.after_begin = !trigger;
                trigger
            } else {
                is("CASE") && self.begin_depth > 0
            };
            if opens {
                self.begin_depth += 1;
                self.body = true;
            } else if is("END") {
                self.begin_depth = self.begin_depth.saturating_sub(1);
            }
            self.last_was_end = is("END");
        }
    }
}

/// Reads a SQL file's statements one at a time.
pub struct Reader<R> {
    src: R,
    buf: Vec<u8>,
    /// Where the unread text starts in `buf`: what is before it goes when
    /// more is read (not per statement, which would move the rest each time).
    base: usize,
    /// Where splitting resumes in `buf`.
    pos: usize,
    eof: bool,
    /// Line number of `buf[base]`.
    line: u64,
    /// File offset of `buf[base]`.
    offset: u64,
    stmt: Pending,
    /// In a COPY's rows; `copy_line` while the rest of the COPY's own line
    /// is still to skip.
    copy: bool,
    copy_line: bool,
    index: u64,
}

impl<R: Read> Reader<R> {
    pub fn new(src: R) -> Self {
        Self {
            src,
            buf: Vec::with_capacity(CHUNK * 2),
            base: 0,
            pos: 0,
            eof: false,
            line: 1,
            offset: 0,
            stmt: Pending::default(),
            copy: false,
            copy_line: false,
            index: 0,
        }
    }

    /// Bytes of the file read past so far.
    pub fn offset(&self) -> u64 {
        self.offset
    }

    /// Reads more of the file: at least as much as is pending, so a long
    /// lexeme that is lexed again from its start costs linear time in all.
    fn fill(&mut self) -> io::Result<()> {
        self.compact();
        // What is held is one statement, psql line or COPY row: never more
        // than that much memory.
        if self.buf.len() > MAX_STATEMENT + CHUNK {
            return Err(io::Error::other("a statement or line in it is over 1 GB"));
        }
        let want = (self.buf.len() - self.pos).max(CHUNK);
        let start = self.buf.len();
        self.buf.resize(start + want, 0);
        let mut got = 0;
        while got < want {
            match self.src.read(&mut self.buf[start + got..]) {
                Ok(0) => {
                    self.eof = true;
                    break;
                }
                Ok(n) => got += n,
                Err(e) if e.kind() == io::ErrorKind::Interrupted => {}
                Err(e) => {
                    self.buf.truncate(start + got);
                    return Err(e);
                }
            }
        }
        self.buf.truncate(start + got);
        Ok(())
    }

    /// Drops what was read past from `buf`.
    fn compact(&mut self) {
        if self.base == 0 {
            return;
        }
        self.buf.drain(..self.base);
        self.pos -= self.base;
        if let Some(first) = &mut self.stmt.first {
            *first -= self.base;
        }
        self.base = 0;
    }

    /// Reads past `buf[..end]`, keeping the line and offset counts.
    fn consume(&mut self, end: usize) {
        self.line += memchr::memchr_iter(b'\n', &self.buf[self.base..end]).count() as u64;
        self.offset += (end - self.base) as u64;
        self.base = end;
        self.pos = end;
    }

    fn line_at(&self, at: usize) -> u64 {
        self.line + memchr::memchr_iter(b'\n', &self.buf[self.base..at]).count() as u64
    }

    /// The next statement or psql command; `None` at the end of the file.
    /// The rows of a `COPY … FROM stdin` are skipped unless read first with
    /// [`Self::copy_chunk`].
    pub fn next_piece(&mut self) -> Result<Option<Piece>, ReadError> {
        while self.copy {
            self.copy_chunk()?;
        }
        loop {
            if let Some(first) = self.stmt.first {
                if self.buf.len() - first > MAX_STATEMENT {
                    return Err(ReadError::at(
                        self.line_at(first),
                        "This statement is over 1 GB, or a quote or comment in it never ends.",
                    ));
                }
            }
            let Some((lexeme, end)) = lex(&self.buf, self.pos, self.eof) else {
                if !self.eof {
                    self.fill()?;
                    continue;
                }
                // The end: a last statement without its `;`.
                let piece = match self.stmt.first {
                    Some(first) => Some(self.statement(first, self.buf.len(), self.buf.len())?),
                    None => {
                        self.consume(self.buf.len());
                        None
                    }
                };
                return Ok(piece.map(Piece::Statement));
            };
            let at = self.pos;
            match lexeme {
                Lexeme::Space | Lexeme::LineComment | Lexeme::BlockComment { .. } => {}
                Lexeme::Semicolon if self.stmt.begin_depth == 0 => match self.stmt.first {
                    Some(first) => {
                        return self
                            .statement(first, at, end)
                            .map(Piece::Statement)
                            .map(Some)
                    }
                    None => {
                        self.consume(end);
                        continue;
                    }
                },
                Lexeme::Other if self.buf[at] == b'\\' => return self.meta().map(Some),
                _ => {
                    self.stmt.first.get_or_insert(at);
                    match lexeme {
                        Lexeme::Open => self.stmt.parens += 1,
                        Lexeme::Close => self.stmt.parens -= 1,
                        Lexeme::Word => {
                            let (buf, stmt) = (&self.buf, &mut self.stmt);
                            stmt.word(&buf[at..end]);
                        }
                        _ => {}
                    }
                }
            }
            self.pos = end;
        }
    }

    /// Ends the statement at `buf[first..stop]`, consuming through `end`.
    fn statement(&mut self, first: usize, stop: usize, end: usize) -> Result<Statement, ReadError> {
        let line = self.line_at(first);
        let sql = String::from_utf8(self.buf[first..stop].to_vec()).map_err(|_| {
            ReadError::at(
                line,
                "This statement isn't UTF-8 text. Save the file as UTF-8 and read it again.",
            )
        })?;
        let pending = std::mem::take(&mut self.stmt);
        // A body that never closes would run the rest of the file as one
        // statement, past what the summary shows.
        if pending.body && (pending.begin_depth > 0 || !pending.last_was_end) {
            return Err(ReadError::at(
                line,
                format!("Line {line}: Rowkery can't tell where this routine's body ends. Check its BEGIN … END."),
            ));
        }
        let copy_in = pending.copy == Copy::Stdin;
        self.consume(end);
        if copy_in {
            self.copy = true;
            self.copy_line = true;
        }
        let index = self.index;
        self.index += 1;
        let mut sql = sql;
        sql.truncate(sql.trim_end().len());
        Ok(Statement {
            index,
            line,
            sql,
            verb: pending.lead.into_iter().next().unwrap_or_default(),
            copy_in,
        })
    }

    /// The psql command whose `\` is at `buf[pos]`: its whole line.
    fn meta(&mut self) -> Result<Piece, ReadError> {
        // `pos` stays on the `\` as reading more moves the buffer.
        let stop = loop {
            match memchr::memchr(b'\n', &self.buf[self.pos..]) {
                Some(p) => break self.pos + p,
                None if self.eof => break self.buf.len(),
                None => self.fill()?,
            }
        };
        let at = self.pos;
        let line = self.line_at(at);
        let text = String::from_utf8_lossy(&self.buf[at..stop])
            .trim()
            .to_string();
        let inside = self.stmt.first.is_some();
        self.stmt = Pending::default();
        self.consume((stop + 1).min(self.buf.len()));
        Ok(Piece::Meta { line, text, inside })
    }

    /// The next rows of the COPY just read, as COPY data (whole lines);
    /// `None` once its `\.` line (or the end of the file) is reached.
    pub fn copy_chunk(&mut self) -> Result<Option<Vec<u8>>, ReadError> {
        if !self.copy {
            return Ok(None);
        }
        // COPY data moves a chunk at a time: from `buf[0]` here.
        self.compact();
        if self.copy_line {
            // The rows start on the line after the COPY.
            loop {
                if let Some(p) = memchr::memchr(b'\n', &self.buf) {
                    self.consume(p + 1);
                    break;
                }
                if self.eof {
                    self.consume(self.buf.len());
                    break;
                }
                self.fill()?;
            }
            self.copy_line = false;
            self.compact();
        }
        loop {
            match end_marker(&self.buf, 0, self.eof) {
                Marker::Yes(len) => {
                    self.consume(len);
                    self.copy = false;
                    return Ok(None);
                }
                Marker::NeedMore => {
                    self.fill()?;
                    continue;
                }
                Marker::No => {}
            }
            // Whole lines up to the next `\.` line, at most about a chunk.
            let window = self.buf.len().min(COPY_CHUNK);
            let mut search = 0;
            let cut = loop {
                match memchr::memmem::find(&self.buf[search..], b"\n\\.") {
                    Some(p) if search + p < window => {
                        let at = search + p + 1;
                        match end_marker(&self.buf, at, self.eof) {
                            Marker::Yes(_) | Marker::NeedMore => break Some(at),
                            Marker::No => search = at,
                        }
                    }
                    // Else whole lines within the window, or one longer line.
                    _ => {
                        break memchr::memrchr(b'\n', &self.buf[..window])
                            .or_else(|| memchr::memchr(b'\n', &self.buf))
                            .map(|p| p + 1)
                    }
                }
            };
            match cut {
                Some(cut) => {
                    let rows = self.buf[..cut].to_vec();
                    self.consume(cut);
                    return Ok(Some(rows));
                }
                None if self.eof => {
                    if self.buf.is_empty() {
                        self.copy = false;
                        return Ok(None);
                    }
                    // A last row without its newline.
                    let rows = std::mem::take(&mut self.buf);
                    self.offset += rows.len() as u64;
                    self.pos = 0;
                    return Ok(Some(rows));
                }
                None => self.fill()?,
            }
        }
    }
}

enum Marker {
    No,
    /// `\.` and its line end, this many bytes.
    Yes(usize),
    NeedMore,
}

/// Whether the line at `b[at]` is COPY's end marker `\.`.
fn end_marker(b: &[u8], at: usize, eof: bool) -> Marker {
    let rest = &b[at..];
    let need = if eof { Marker::No } else { Marker::NeedMore };
    match rest {
        [] | [b'\\'] => need,
        [b'\\', b'.'] | [b'\\', b'.', b'\r'] if eof => Marker::Yes(rest.len()),
        [b'\\', b'.'] | [b'\\', b'.', b'\r'] => Marker::NeedMore,
        [b'\\', b'.', b'\n', ..] => Marker::Yes(3),
        [b'\\', b'.', b'\r', b'\n', ..] => Marker::Yes(4),
        _ => Marker::No,
    }
}

/// One line of the panel's "What it does": statements of one kind.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct KindCount {
    /// `DROP TABLE`, `CREATE INDEX`, `COPY`, `DELETE without WHERE`.
    pub label: String,
    /// Statements; rows for COPY.
    pub count: u64,
    pub destructive: bool,
}

/// Why the file can't run as one transaction.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct PerStatement {
    pub line: u64,
    /// `CREATE INDEX CONCURRENTLY can't run inside a transaction`.
    pub reason: String,
}

/// What [`scan`] found in a file, for the panel and for the run.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct Scan {
    pub bytes: u64,
    #[serde(skip)]
    pub modified: Option<SystemTime>,
    /// `pg_dump 16.4` or `sqlite3 .dump`, when the file says.
    pub source: Option<String>,
    /// Statements that will run.
    pub statements: u64,
    /// Destructive kinds first, then in the order they first appear.
    pub kinds: Vec<KindCount>,
    pub copy_rows: u64,
    /// Something in it changes data or schema (safe mode).
    pub writes: bool,
    /// The file's own `BEGIN` … `COMMIT` around everything, which Rowkery's
    /// transaction replaces: these statements (by index) are skipped.
    pub skip: Vec<u64>,
    /// Set when it must run statement by statement.
    pub per_statement: Option<PerStatement>,
    /// Set when it can't run at all; nothing was or will be executed.
    pub refused: Option<ReadError>,
}

/// psql commands pg_dump writes (17.6, 16.10, …) that a run skips.
fn skipped_meta(text: &str) -> bool {
    let command = text.split_whitespace().next().unwrap_or("");
    matches!(command, "\\restrict" | "\\unrestrict")
}

/// Reads the whole file at `path` without running anything. `progress` gets
/// the bytes read so far now and then; returning `false` stops the scan
/// (`Err` with no line).
pub fn scan(
    path: &Path,
    engine: EngineKind,
    mut progress: impl FnMut(u64) -> bool,
) -> Result<Scan, ReadError> {
    let file = File::open(path)?;
    let meta = file.metadata()?;
    let mut scan = Scan {
        bytes: meta.len(),
        modified: meta.modified().ok(),
        source: None,
        statements: 0,
        kinds: Vec::new(),
        copy_rows: 0,
        writes: false,
        skip: Vec::new(),
        per_statement: None,
        refused: None,
    };
    let mut head = Vec::with_capacity(4096);
    (&file).take(4096).read_to_end(&mut head)?;
    (&file).rewind()?;
    if let Some(refusal) = not_sql(&head) {
        scan.refused = Some(ReadError {
            line: None,
            message: refusal.into(),
        });
        return Ok(scan);
    }
    scan.source = source(&head);

    let mut reader = Reader::new(file);
    // Labels and their first-seen order.
    let mut kinds: Vec<(KindCount, usize)> = Vec::new();
    let mut count = |label: &str, destructive: bool, n: u64| match kinds
        .iter_mut()
        .find(|(k, _)| k.label == label && k.destructive == destructive)
    {
        Some((k, _)) => k.count += n,
        None => {
            let order = kinds.len();
            kinds.push((
                KindCount {
                    label: label.to_string(),
                    count: n,
                    destructive,
                },
                order,
            ));
        }
    };
    let mut begins: Vec<(u64, u64)> = Vec::new();
    let mut commits: Vec<(u64, u64)> = Vec::new();
    let mut control: Option<(u64, String)> = None;
    let mut last = None;
    let mut next_report = 0u64;
    let refuse = |scan: &mut Scan, line: u64, message: String| {
        scan.refused = Some(ReadError::at(line, message));
    };
    loop {
        if reader.offset() >= next_report {
            if !progress(reader.offset()) {
                return Err(ReadError {
                    line: None,
                    message: "Stopped.".into(),
                });
            }
            next_report = reader.offset() + 8 * 1024 * 1024;
        }
        let piece = match reader.next_piece() {
            Ok(Some(piece)) => piece,
            Ok(None) => break,
            Err(e) => {
                scan.refused = Some(e);
                return Ok(scan);
            }
        };
        let statement = match piece {
            Piece::Meta {
                inside: false,
                text,
                ..
            } if skipped_meta(&text) => continue,
            Piece::Meta { line, text, .. } => {
                refuse(
                    &mut scan,
                    line,
                    format!("Line {line} is a psql command ({text}), which only psql can run. Remove it, or run the file with psql."),
                );
                return Ok(scan);
            }
            Piece::Statement(statement) => statement,
        };
        let Some((check, role)) = check_file_statement(classified(&statement.sql)) else {
            continue;
        };
        scan.statements += 1;
        scan.writes |= check.changes_data() || check.unlocks_writes;
        last = Some(statement.index);
        if statement.copy_in {
            if engine == EngineKind::Sqlite {
                refuse(
                    &mut scan,
                    statement.line,
                    format!("Line {}: COPY … FROM stdin is Postgres only, so this file can't run on SQLite.", statement.line),
                );
                return Ok(scan);
            }
            let mut rows = 0;
            loop {
                match reader.copy_chunk() {
                    Ok(Some(chunk)) => {
                        rows += memchr::memchr_iter(b'\n', &chunk).count() as u64;
                        if chunk.last() != Some(&b'\n') {
                            rows += 1;
                        }
                    }
                    Ok(None) => break,
                    Err(e) => {
                        scan.refused = Some(e);
                        return Ok(scan);
                    }
                }
            }
            scan.copy_rows += rows;
            count("COPY", false, rows);
            continue;
        }
        let label = match check.verb.as_str() {
            "DELETE" | "UPDATE" if check.destructive => format!("{} without WHERE", check.verb),
            _ => check.verb.clone(),
        };
        count(&label, check.destructive, 1);
        match role {
            InTransaction::Fine => {}
            InTransaction::Begins => begins.push((statement.index, statement.line)),
            InTransaction::Commits => commits.push((statement.index, statement.line)),
            InTransaction::Controls => {
                control.get_or_insert((statement.line, check.verb.clone()));
            }
            InTransaction::Never => {
                if scan.per_statement.is_none() {
                    let what = if statement.sql.to_ascii_uppercase().contains("CONCURRENTLY") {
                        format!("{} CONCURRENTLY", check.verb)
                    } else {
                        check.verb.clone()
                    };
                    scan.per_statement = Some(PerStatement {
                        line: statement.line,
                        reason: format!("{what} can't run inside a transaction"),
                    });
                }
            }
        }
    }
    progress(reader.offset());

    // The file's own BEGIN … COMMIT around everything: ours replaces it.
    let wraps = matches!((begins.as_slice(), commits.as_slice(), &control),
        ([(b, _)], [(c, _)], None) if b < c && Some(*c) == last);
    if wraps {
        scan.skip = vec![begins[0].0, commits[0].0];
        scan.statements -= 2;
        for kind in kinds.iter_mut() {
            if matches!(kind.0.label.as_str(), "BEGIN" | "START" | "COMMIT" | "END") {
                kind.0.count -= 1;
            }
        }
        kinds.retain(|(k, _)| k.count > 0);
    } else if scan.per_statement.is_none() {
        let first = begins
            .iter()
            .chain(&commits)
            .map(|(_, line)| *line)
            .chain(control.as_ref().map(|(line, _)| *line))
            .min();
        if let Some(line) = first {
            scan.per_statement = Some(PerStatement {
                line,
                reason: "The file opens and ends its own transactions".into(),
            });
        }
    }
    kinds.sort_by_key(|(k, order)| (!k.destructive, *order));
    scan.kinds = kinds.into_iter().map(|(k, _)| k).collect();
    Ok(scan)
}

/// Why a file that starts with `head` isn't a SQL file, if it isn't.
fn not_sql(head: &[u8]) -> Option<&'static str> {
    if head.starts_with(b"PGDMP") {
        Some("This is a pg_dump archive (custom format), not a .sql file. Turn it into one with pg_restore -f out.sql, then run out.sql.")
    } else if head.starts_with(b"SQLite format 3\0") {
        Some("This is a SQLite database, not a .sql file. Open it with Open SQLite File… instead.")
    } else if head.starts_with(&[0x1f, 0x8b]) || head.starts_with(b"PK\x03\x04") {
        Some("This file is compressed. Unzip it, then run the .sql inside.")
    } else if head.len() >= 262 && &head[257..262] == b"ustar" {
        Some("This is a tar archive (pg_dump -Ft?). Turn it into a .sql file with pg_restore -f out.sql, then run out.sql.")
    } else {
        None
    }
}

/// `pg_dump 16.4` or `sqlite3 .dump`, from the file's first lines.
fn source(head: &[u8]) -> Option<String> {
    let text = String::from_utf8_lossy(head);
    if let Some(rest) = text
        .lines()
        .find_map(|l| l.strip_prefix("-- Dumped by pg_dump version "))
    {
        let version = rest.split_whitespace().next().unwrap_or("");
        return Some(format!("pg_dump {version}"));
    }
    let start = text.trim_start();
    if start.starts_with("PRAGMA foreign_keys=OFF;\nBEGIN TRANSACTION;") {
        return Some("sqlite3 .dump".into());
    }
    None
}

/// How a run goes, as the panel set it.
#[derive(Clone, Copy, Debug, PartialEq, Eq, serde::Deserialize)]
pub struct RunOptions {
    /// All or nothing in one transaction; else each statement commits.
    pub whole_file: bool,
    /// Per statement only: an error is noted and the run goes on.
    pub keep_going: bool,
}

/// Where a run is, about every [`PROGRESS_EVERY`].
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize)]
pub struct Progress {
    /// Statements done.
    pub done: u64,
    /// The one running: its line and its start, on one line.
    pub line: u64,
    pub current: String,
    /// Bytes of the file read past.
    pub bytes: u64,
    /// Rows written so far (COPY, INSERT, UPDATE, DELETE).
    pub rows: u64,
    /// Every statement ran and COMMIT is sent: from here a stopped run may
    /// or may not be saved.
    pub committing: bool,
}

pub const PROGRESS_EVERY: std::time::Duration = std::time::Duration::from_millis(100);

/// The statement that stopped a run.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct Failure {
    pub line: Option<u64>,
    /// Its start, on one line.
    pub statement: String,
    pub message: String,
}

/// How a run ended.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize)]
pub struct RunReport {
    /// Statements that ran without error.
    pub done: u64,
    pub rows: u64,
    pub elapsed_ms: u64,
    /// What stopped it (an error, or the file).
    pub failed: Option<Failure>,
    /// Errors passed over with Keep going, and the first of them.
    pub errors: u64,
    pub first_error: Option<Failure>,
    pub cancelled: bool,
    /// Nothing from the file was kept: the whole-file transaction rolled back.
    pub rolled_back: bool,
    /// Per statement: of `done`, those in a transaction of the file's own
    /// still open when the run ended, which rolled back with it.
    pub lost: u64,
}

/// A statement's start on one line, for progress and errors.
pub fn preview(sql: &str) -> String {
    let mut out = String::new();
    for word in sql.split_whitespace() {
        if out.len() + word.len() > 120 {
            out.push('…');
            break;
        }
        if !out.is_empty() {
            out.push(' ');
        }
        out.push_str(word);
    }
    out
}

/// Opens the scanned file for its run, refusing if it changed since.
pub fn open_scanned(path: &Path, scan: &Scan) -> Result<Reader<File>, String> {
    let file = File::open(path).map_err(|e| format!("Couldn't open the file: {e}"))?;
    let meta = file
        .metadata()
        .map_err(|e| format!("Couldn't read the file: {e}"))?;
    if meta.len() != scan.bytes || meta.modified().ok() != scan.modified {
        return Err(
            "The file changed since Rowkery read it. Read it again before running it.".into(),
        );
    }
    Ok(Reader::new(file))
}

/// Refuses options the scan rules out.
pub fn check_options(scan: &Scan, options: RunOptions) -> Result<(), String> {
    if let Some(refused) = &scan.refused {
        return Err(refused.message.clone());
    }
    if options.whole_file && scan.per_statement.is_some() {
        return Err("This file can't run as one transaction.".into());
    }
    if options.whole_file && options.keep_going {
        return Err("Keep going needs Per statement: one error ends a transaction.".into());
    }
    Ok(())
}

/// The next statement to run: psql commands the scan let through and the
/// file's own BEGIN / COMMIT around everything are passed over.
pub fn next_to_run<R: Read>(
    reader: &mut Reader<R>,
    scan: &Scan,
) -> Result<Option<Statement>, ReadError> {
    loop {
        match reader.next_piece()? {
            None => return Ok(None),
            Some(Piece::Meta {
                inside: false,
                text,
                ..
            }) if skipped_meta(&text) => {}
            Some(Piece::Meta { line, .. }) => {
                return Err(ReadError::at(
                    line,
                    "The file changed since Rowkery read it.",
                ))
            }
            Some(Piece::Statement(s)) if scan.skip.contains(&s.index) => {}
            Some(Piece::Statement(s)) => return Ok(Some(s)),
        }
    }
}

/// Counts the rows a statement reports when it writes them.
fn counts_rows(verb: &str) -> bool {
    matches!(
        verb,
        "INSERT" | "UPDATE" | "DELETE" | "MERGE" | "REPLACE" | "UPSERT" | "COPY"
    )
}

/// Keeps a run's progress and how it is ending.
struct Tally<F> {
    progress: Progress,
    report: RunReport,
    keep_going: bool,
    whole_file: bool,
    /// `done` when the file's own transaction began, while it is open.
    open_since: Option<u64>,
    started: std::time::Instant,
    last_sent: Option<std::time::Instant>,
    on_progress: F,
}

impl<F: FnMut(&Progress)> Tally<F> {
    fn new(options: RunOptions, on_progress: F) -> Self {
        Self {
            progress: Progress::default(),
            report: RunReport::default(),
            keep_going: options.keep_going && !options.whole_file,
            whole_file: options.whole_file,
            open_since: None,
            started: std::time::Instant::now(),
            last_sent: None,
            on_progress,
        }
    }

    /// Sends progress when it's due (the preview is only made then).
    fn starting(&mut self, statement: &Statement, bytes: u64) {
        match statement.verb.as_str() {
            "BEGIN" | "START" => {
                self.open_since.get_or_insert(self.progress.done);
            }
            "COMMIT" | "END" | "ROLLBACK" | "ABORT" => self.open_since = None,
            _ => {}
        }
        if self.last_sent.is_none_or(|t| t.elapsed() >= PROGRESS_EVERY) {
            self.last_sent = Some(std::time::Instant::now());
            self.progress.line = statement.line;
            self.progress.current = preview(&statement.sql);
            self.progress.bytes = bytes;
            (self.on_progress)(&self.progress);
        }
    }

    /// A COPY's rows are going: its progress is the bytes read.
    fn copying(&mut self, bytes: u64) {
        if self.last_sent.is_none_or(|t| t.elapsed() >= PROGRESS_EVERY) {
            self.last_sent = Some(std::time::Instant::now());
            self.progress.bytes = bytes;
            (self.on_progress)(&self.progress);
        }
    }

    fn committing(&mut self) {
        self.progress.committing = true;
        (self.on_progress)(&self.progress);
    }

    fn ran(&mut self, rows: u64) {
        self.progress.done += 1;
        self.progress.rows += rows;
    }

    /// Notes a failed statement; true when the run goes on (Keep going).
    fn failed(&mut self, statement: &Statement, message: String) -> bool {
        let failure = Failure {
            line: Some(statement.line),
            statement: preview(&statement.sql),
            message,
        };
        if self.keep_going {
            self.report.errors += 1;
            self.report.first_error.get_or_insert(failure);
            true
        } else {
            self.report.failed = Some(failure);
            false
        }
    }

    fn file_failed(&mut self, error: ReadError) {
        self.report.failed = Some(Failure {
            line: error.line,
            statement: String::new(),
            message: error.message,
        });
    }

    fn finish(mut self, bytes: u64) -> RunReport {
        self.progress.bytes = bytes;
        (self.on_progress)(&self.progress);
        self.report.done = self.progress.done;
        self.report.rows = self.progress.rows;
        // The caller drops the connection, so an open one rolls back.
        if let (false, Some(since)) = (self.whole_file, self.open_since) {
            self.report.lost = self.progress.done - since;
        }
        self.report.elapsed_ms = self.started.elapsed().as_millis() as u64;
        self.report
    }
}

/// What a statement is, it says in its start: the classifier's tokens cost
/// about 48 times the text, so a 500 MB INSERT is read from its first 64 kB.
/// A DELETE or UPDATE whose WHERE comes later counts as without one, the
/// safe side.
fn classified(sql: &str) -> &str {
    const HEAD: usize = 64 * 1024;
    if sql.len() <= HEAD {
        return sql;
    }
    let mut end = HEAD;
    while !sql.is_char_boundary(end) {
        end -= 1;
    }
    &sql[..end]
}

/// Runs the scanned file on a SQLite connection ([`open_sqlite`]).
/// `cancelled` says a cancel was asked for; whoever asks interrupts the
/// connection too.
pub fn run_sqlite(
    conn: &rusqlite::Connection,
    path: &Path,
    scan: &Scan,
    options: RunOptions,
    cancelled: impl Fn() -> bool,
    on_progress: impl FnMut(&Progress),
) -> RunReport {
    let mut tally = Tally::new(options, on_progress);
    let mut reader = match check_options(scan, options).and_then(|_| open_scanned(path, scan)) {
        Ok(reader) => reader,
        Err(message) => {
            tally.file_failed(ReadError {
                line: None,
                message,
            });
            return tally.finish(0);
        }
    };
    if options.whole_file {
        if let Err(e) = conn.execute_batch("BEGIN IMMEDIATE") {
            tally.file_failed(ReadError {
                line: None,
                message: e.to_string(),
            });
            return tally.finish(0);
        }
    }
    let mut ok = true;
    loop {
        if cancelled() {
            tally.report.cancelled = true;
            ok = false;
            break;
        }
        let statement = match next_to_run(&mut reader, scan) {
            Ok(Some(statement)) => statement,
            Ok(None) => break,
            Err(e) => {
                tally.file_failed(e);
                ok = false;
                break;
            }
        };
        tally.starting(&statement, reader.offset());
        match conn.execute_batch(&statement.sql) {
            Ok(()) => {
                let rows = if counts_rows(&statement.verb) {
                    conn.changes()
                } else {
                    0
                };
                tally.ran(rows);
            }
            Err(_) if cancelled() => {
                tally.report.cancelled = true;
                ok = false;
                break;
            }
            Err(e) => {
                if !tally.failed(&statement, e.to_string()) {
                    ok = false;
                    break;
                }
            }
        }
    }
    // A cancel after the last statement still rolls back.
    if ok && cancelled() {
        tally.report.cancelled = true;
        ok = false;
    }
    if options.whole_file {
        let ended = if ok {
            conn.execute_batch("COMMIT")
        } else {
            conn.execute_batch("ROLLBACK")
        };
        match ended {
            Ok(()) => tally.report.rolled_back = !ok,
            Err(e) if ok => {
                let _ = conn.execute_batch("ROLLBACK");
                tally.report.rolled_back = true;
                tally.file_failed(ReadError {
                    line: None,
                    message: e.to_string(),
                });
            }
            // A failed statement can end SQLite's transaction itself.
            Err(_) => tally.report.rolled_back = conn.is_autocommit(),
        }
    }
    let bytes = reader.offset();
    tally.finish(bytes)
}

/// A connection of its own for a run on the SQLite file at `path` (never a
/// tab's: those may hold a transaction). Waits a while for another writer.
pub fn open_sqlite(path: &str) -> Result<rusqlite::Connection, String> {
    let path = crate::connections::expand_home(path);
    let conn =
        rusqlite::Connection::open_with_flags(&path, rusqlite::OpenFlags::SQLITE_OPEN_READ_WRITE)
            .map_err(|e| e.to_string())?;
    conn.busy_timeout(std::time::Duration::from_secs(5))
        .map_err(|e| e.to_string())?;
    // As the sqlite3 shell: off unless the file turns it on. The bundled
    // library starts with it on, and a .dump's own `PRAGMA foreign_keys=OFF`
    // does nothing inside the run's transaction, so rows dumped before
    // their parent would fail.
    conn.execute_batch("PRAGMA foreign_keys=OFF")
        .map_err(|e| e.to_string())?;
    Ok(conn)
}

/// What the file reader thread hands a Postgres run.
enum Feed {
    Statement(Statement, u64),
    /// COPY data, and the bytes of the file read past.
    Rows(Vec<u8>, u64),
    RowsEnd,
    Failed(ReadError),
}

/// Pieces read ahead of the run: COPY data moves in [`COPY_CHUNK`]s, so
/// this bounds the memory a run holds.
const READ_AHEAD: usize = 32;

/// Reads the file on a thread of its own, ahead of the run.
fn feed(mut reader: Reader<File>, scan: Scan) -> tokio::sync::mpsc::Receiver<Feed> {
    let (tx, rx) = tokio::sync::mpsc::channel(READ_AHEAD);
    std::thread::spawn(move || {
        let send = |item: Feed| tx.blocking_send(item).is_ok();
        loop {
            let statement = match next_to_run(&mut reader, &scan) {
                Ok(Some(statement)) => statement,
                Ok(None) => return,
                Err(e) => {
                    send(Feed::Failed(e));
                    return;
                }
            };
            let copy = statement.copy_in;
            if !send(Feed::Statement(statement, reader.offset())) {
                return;
            }
            if !copy {
                continue;
            }
            loop {
                match reader.copy_chunk() {
                    Ok(Some(rows)) => {
                        if !send(Feed::Rows(rows, reader.offset())) {
                            return;
                        }
                    }
                    Ok(None) => break,
                    Err(e) => {
                        send(Feed::Failed(e));
                        return;
                    }
                }
            }
            if !send(Feed::RowsEnd) {
                return;
            }
        }
    });
    rx
}

/// Runs the scanned file on a Postgres session of its own (never a tab's:
/// the dump's `SET`s stay on it, so the caller drops it after).
/// `cancelled` says a cancel was asked for; whoever asks sends the session
/// a cancel request too.
pub async fn run_postgres(
    session: &crate::db::postgres::PostgresSession,
    path: &Path,
    scan: &Scan,
    options: RunOptions,
    cancelled: impl Fn() -> bool,
    on_progress: impl FnMut(&Progress),
) -> RunReport {
    use crate::db::postgres::{
        copy_error, session_copy_in, session_execute, session_run_file_statement,
    };
    use crate::db::DriverError;
    use futures::SinkExt;

    let mut tally = Tally::new(options, on_progress);
    let reader = match check_options(scan, options).and_then(|_| open_scanned(path, scan)) {
        Ok(reader) => reader,
        Err(message) => {
            tally.file_failed(ReadError {
                line: None,
                message,
            });
            return tally.finish(0);
        }
    };
    if options.whole_file {
        if let Err(e) = session_execute(session, "BEGIN").await {
            tally.file_failed(ReadError {
                line: None,
                message: e.into_message(),
            });
            return tally.finish(0);
        }
    }
    let mut rx = feed(reader, scan.clone());
    let mut bytes = 0;
    let mut ok = true;
    let is_cancel = |e: &DriverError| matches!(e, DriverError::Cancelled) || cancelled();
    'run: while let Some(item) = rx.recv().await {
        if cancelled() {
            tally.report.cancelled = true;
            ok = false;
            break;
        }
        let (statement, offset) = match item {
            Feed::Statement(statement, offset) => (statement, offset),
            Feed::Failed(e) => {
                tally.file_failed(e);
                ok = false;
                break;
            }
            // Rows of a COPY that failed under Keep going: dropped.
            Feed::Rows(..) | Feed::RowsEnd => continue,
        };
        bytes = offset;
        tally.starting(&statement, offset);
        let ran = if statement.copy_in {
            match session_copy_in(session, &statement.sql).await {
                Ok(sink) => {
                    let mut sink = std::pin::pin!(sink);
                    let mut sent = Ok(());
                    loop {
                        match rx.recv().await {
                            Some(Feed::Rows(rows, offset)) => {
                                if sent.is_ok() {
                                    sent = sink.send(io::Cursor::new(rows)).await;
                                }
                                bytes = offset;
                                tally.copying(offset);
                                if cancelled() {
                                    tally.report.cancelled = true;
                                    ok = false;
                                    break 'run;
                                }
                            }
                            Some(Feed::RowsEnd) => break,
                            Some(Feed::Failed(e)) => {
                                tally.file_failed(e);
                                ok = false;
                                break 'run;
                            }
                            Some(Feed::Statement(..)) | None => {
                                ok = false;
                                break 'run;
                            }
                        }
                    }
                    match sent {
                        Ok(()) => sink
                            .as_mut()
                            .finish()
                            .await
                            .map_err(|e| copy_error(session, &e)),
                        Err(e) => Err(copy_error(session, &e)),
                    }
                }
                Err(e) => Err(e),
            }
        } else {
            session_run_file_statement(session, &statement.sql).await
        };
        match ran {
            Ok(rows) => tally.ran(if counts_rows(&statement.verb) {
                rows
            } else {
                0
            }),
            Err(e) if is_cancel(&e) => {
                tally.report.cancelled = true;
                ok = false;
                break;
            }
            Err(e) => {
                if !tally.failed(&statement, e.into_message()) {
                    ok = false;
                    break;
                }
            }
        }
    }
    drop(rx);
    if ok && cancelled() {
        tally.report.cancelled = true;
        ok = false;
    }
    if options.whole_file {
        if ok {
            tally.committing();
            if let Err(e) = session_execute(session, "COMMIT").await {
                let message = if session.is_closed() {
                    "The connection dropped during COMMIT, so the file may or may not be saved. Reload the schema to check.".to_string()
                } else {
                    let _ = session_execute(session, "ROLLBACK").await;
                    tally.report.rolled_back = true;
                    e.into_message()
                };
                tally.file_failed(ReadError {
                    line: None,
                    message,
                });
            }
        } else {
            // Nothing was committed; if even this doesn't answer, the server
            // rolls back when the caller drops the session.
            let _ = session_execute(session, "ROLLBACK").await;
            tally.report.rolled_back = true;
        }
    }
    tally.finish(bytes)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::safety::split_statements;

    fn pieces(sql: &str) -> Vec<Piece> {
        let mut reader = Reader::new(sql.as_bytes());
        let mut out = Vec::new();
        while let Some(piece) = reader.next_piece().unwrap() {
            out.push(piece);
        }
        out
    }

    fn statements(sql: &str) -> Vec<String> {
        pieces(sql)
            .into_iter()
            .filter_map(|p| match p {
                Piece::Statement(s) => Some(s.sql),
                Piece::Meta { .. } => None,
            })
            .collect()
    }

    #[test]
    fn splits_like_the_editor_while_streaming() {
        let corpus = [
            "SELECT 1; SELECT 2",
            "SELECT 'a;b''c;'; SELECT E'x\\';y'; SELECT \"q;\"",
            "SELECT 1 -- c;\n; /* a; /* b; */ c; */ SELECT 2;",
            "CREATE FUNCTION f() RETURNS int AS $body$ SELECT 1; $body$ LANGUAGE sql; SELECT $$;$$",
            "SELECT $1; SELECT a$b; SELECT 12e3; SELECT `x;y`;",
            "SELECT 'never ends; SELECT 2",
            "SELECT 1;;; ;\n\nSELECT 'é;ü';",
            "SELECT $tag$ open; SELECT 3",
            "SELECT 1 /* open; SELECT 2",
            "INSERT INTO t VALUES (1, 'x'), (2, 'y''z');\nINSERT INTO t VALUES (3, E'\\\\');",
        ];
        for sql in corpus {
            let ours = statements(sql);
            let editor = split_statements(sql);
            assert_eq!(ours.len(), editor.len(), "{sql}: {ours:?} vs {editor:?}");
            for (o, e) in ours.iter().zip(&editor) {
                assert!(e.ends_with(o.as_str()), "{sql}: {o:?} vs {e:?}");
            }
        }
    }

    #[test]
    fn routine_bodies_keep_their_semicolons() {
        let sql = "CREATE TRIGGER t AFTER INSERT ON a BEGIN UPDATE b SET n = CASE WHEN 1 THEN 2 END; INSERT INTO c VALUES (1); END;\n\
                   CREATE OR REPLACE FUNCTION f() RETURNS int LANGUAGE sql BEGIN ATOMIC SELECT 1; SELECT 2; END;\n\
                   CREATE TRIGGER pg AFTER INSERT ON a FOR EACH ROW EXECUTE FUNCTION g();\n\
                   BEGIN; SELECT 1; COMMIT;";
        let got = statements(sql);
        assert_eq!(got.len(), 6, "{got:?}");
        assert!(got[0].ends_with("VALUES (1); END"));
        assert!(got[1].ends_with("SELECT 2; END"));
        assert!(got[2].ends_with("g()"));
        assert_eq!(&got[3..], ["BEGIN", "SELECT 1", "COMMIT"]);
    }

    #[test]
    fn copy_rows_pass_through_untouched() {
        let sql = "SET x = 1;\nCOPY public.t (a, b) FROM stdin;\n1\t'; DROP\n2\t\\N\n\\.\nSELECT 1;\nCOPY t FROM STDIN;\r\nx\r\n\\.\r\nCOPY u FROM stdin;\nlast";
        let mut reader = Reader::new(sql.as_bytes());
        let mut got = Vec::new();
        while let Some(piece) = reader.next_piece().unwrap() {
            let Piece::Statement(s) = piece else { panic!() };
            let mut rows = Vec::new();
            while let Some(chunk) = reader.copy_chunk().unwrap() {
                rows.extend(chunk);
            }
            got.push((s.line, s.sql, s.copy_in, String::from_utf8(rows).unwrap()));
        }
        assert_eq!(
            got,
            [
                (1, "SET x = 1".into(), false, "".into()),
                (
                    2,
                    "COPY public.t (a, b) FROM stdin".into(),
                    true,
                    "1\t'; DROP\n2\t\\N\n".into()
                ),
                (6, "SELECT 1".into(), false, "".into()),
                (7, "COPY t FROM STDIN".into(), true, "x\r\n".into()),
                (10, "COPY u FROM stdin".into(), true, "last".into()),
            ]
        );
    }

    #[test]
    fn copy_rows_are_skipped_when_not_read() {
        let got = statements("COPY t FROM stdin;\na;b\n\\.\nSELECT 2;");
        assert_eq!(got, ["COPY t FROM stdin", "SELECT 2"]);
    }

    #[test]
    fn psql_commands_are_found_with_their_line() {
        let got = pieces("\\restrict abc\n\nSET a = 1;\nSELECT 1\n\\gset\n\\connect other\n");
        assert_eq!(
            got[0],
            Piece::Meta {
                line: 1,
                text: "\\restrict abc".into(),
                inside: false
            }
        );
        assert!(matches!(&got[1], Piece::Statement(s) if s.sql == "SET a = 1" && s.line == 3));
        assert_eq!(
            got[2],
            Piece::Meta {
                line: 5,
                text: "\\gset".into(),
                inside: true
            }
        );
        assert!(matches!(
            &got[3],
            Piece::Meta {
                line: 6,
                inside: false,
                ..
            }
        ));
    }

    fn scan_text(sql: &str, engine: EngineKind) -> Scan {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("f.sql");
        std::fs::write(&path, sql).unwrap();
        scan(&path, engine, |_| true).unwrap()
    }

    const PG_DUMP: &str = "--\n-- PostgreSQL database dump\n--\n\n\\restrict k3y\n\n-- Dumped from database version 16.4\n-- Dumped by pg_dump version 16.4\n\nSET statement_timeout = 0;\nSELECT pg_catalog.set_config('search_path', '', false);\nDROP TABLE IF EXISTS public.orders;\nCREATE TABLE public.orders (id int, note text);\nCOPY public.orders (id, note) FROM stdin;\n1\ta\n2\tb\n3\tc\n\\.\n\nCREATE INDEX orders_id ON public.orders (id);\nDELETE FROM public.orders;\n\n\\unrestrict k3y\n";

    #[test]
    fn scan_counts_a_pg_dump() {
        let scan = scan_text(PG_DUMP, EngineKind::Postgres);
        assert_eq!(scan.refused, None);
        assert_eq!(scan.source.as_deref(), Some("pg_dump 16.4"));
        assert_eq!(scan.statements, 7);
        assert_eq!(scan.copy_rows, 3);
        assert!(scan.writes);
        assert_eq!(scan.per_statement, None);
        let kinds: Vec<(&str, u64, bool)> = scan
            .kinds
            .iter()
            .map(|k| (k.label.as_str(), k.count, k.destructive))
            .collect();
        assert_eq!(
            kinds,
            [
                ("DROP TABLE", 1, true),
                ("DELETE without WHERE", 1, true),
                ("SET", 1, false),
                ("SELECT", 1, false),
                ("CREATE TABLE", 1, false),
                ("COPY", 3, false),
                ("CREATE INDEX", 1, false),
            ]
        );
    }

    #[test]
    fn scan_drops_a_sqlite_dumps_own_transaction() {
        let sql = "PRAGMA foreign_keys=OFF;\nBEGIN TRANSACTION;\nCREATE TABLE t(a);\nINSERT INTO t VALUES(1);\nCOMMIT;\n";
        let scan = scan_text(sql, EngineKind::Sqlite);
        assert_eq!(scan.source.as_deref(), Some("sqlite3 .dump"));
        assert_eq!(scan.skip, [1, 4]);
        assert_eq!(scan.statements, 3);
        assert_eq!(scan.per_statement, None);
        assert!(!scan
            .kinds
            .iter()
            .any(|k| k.label == "BEGIN" || k.label == "COMMIT"));
    }

    #[test]
    fn scan_says_when_it_must_run_per_statement() {
        let scan = scan_text(
            "CREATE TABLE t(a int);\nCREATE INDEX CONCURRENTLY i ON t (a);\n",
            EngineKind::Postgres,
        );
        let per = scan.per_statement.unwrap();
        assert_eq!(per.line, 2);
        assert_eq!(
            per.reason,
            "CREATE INDEX CONCURRENTLY can't run inside a transaction"
        );
        let scan = scan_text(
            "INSERT INTO t VALUES (1);\nCOMMIT;\nBEGIN;\nSELECT 1;\n",
            EngineKind::Sqlite,
        );
        assert_eq!(scan.per_statement.unwrap().line, 2);
        assert!(scan.skip.is_empty());
    }

    #[test]
    fn scan_refuses_what_it_cant_run() {
        let refused = |sql: &[u8], engine| {
            let dir = tempfile::tempdir().unwrap();
            let path = dir.path().join("f");
            std::fs::write(&path, sql).unwrap();
            scan(&path, engine, |_| true).unwrap().refused.unwrap()
        };
        let archive = refused(b"PGDMP\x01\x0e\x00", EngineKind::Postgres);
        assert!(
            archive.message.contains("pg_restore -f out.sql"),
            "{archive:?}"
        );
        let meta = refused(b"SELECT 1;\n\\connect other\n", EngineKind::Postgres);
        assert_eq!(meta.line, Some(2));
        assert!(meta.message.contains("\\connect other"));
        let copy = refused(b"COPY t FROM stdin;\n1\n\\.\n", EngineKind::Sqlite);
        assert_eq!(copy.line, Some(1));
        let bytes = refused(b"SELECT 'caf\xe9';", EngineKind::Postgres);
        assert!(bytes.message.contains("UTF-8"));
    }

    fn sqlite_run(
        sql: &str,
        options: RunOptions,
        cancel: bool,
    ) -> (RunReport, rusqlite::Connection) {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("f.sql");
        std::fs::write(&path, sql).unwrap();
        let scan = scan(&path, EngineKind::Sqlite, |_| true).unwrap();
        let conn = rusqlite::Connection::open_in_memory().unwrap();
        conn.execute_batch("CREATE TABLE kept(a)").unwrap();
        let report = run_sqlite(&conn, &path, &scan, options, || cancel, |_| {});
        (report, conn)
    }

    const WHOLE: RunOptions = RunOptions {
        whole_file: true,
        keep_going: false,
    };

    fn count(conn: &rusqlite::Connection, table: &str) -> Option<i64> {
        conn.query_row(&format!("SELECT count(*) FROM {table}"), [], |r| r.get(0))
            .ok()
    }

    #[test]
    fn sqlite_whole_file_commits_or_rolls_back() {
        let dump = "PRAGMA foreign_keys=OFF;\nBEGIN TRANSACTION;\nCREATE TABLE t(a);\nINSERT INTO t VALUES(1);\nINSERT INTO t VALUES(2);\nCREATE TRIGGER g AFTER INSERT ON t BEGIN INSERT INTO kept VALUES (new.a); END;\nCOMMIT;\n";
        let (report, conn) = sqlite_run(dump, WHOLE, false);
        assert_eq!(report.failed, None);
        assert_eq!(
            (report.done, report.rows, report.rolled_back),
            (5, 2, false)
        );
        assert_eq!(count(&conn, "t"), Some(2));

        let broken = "CREATE TABLE t(a);\nINSERT INTO t VALUES(1);\nINSERT INTO nope VALUES(1);\nINSERT INTO t VALUES(2);\n";
        let (report, conn) = sqlite_run(broken, WHOLE, false);
        let failed = report.failed.unwrap();
        assert_eq!(failed.line, Some(3));
        assert!(failed.message.contains("nope"), "{}", failed.message);
        assert!(report.rolled_back);
        assert_eq!(count(&conn, "t"), None);

        let (report, conn) = sqlite_run(dump, WHOLE, true);
        assert!(report.cancelled && report.rolled_back);
        assert_eq!(count(&conn, "t"), None);
    }

    #[test]
    fn a_name_like_begin_opens_no_body() {
        // `begin` is a fine Postgres name: only BEGIN ATOMIC opens a body,
        // so the COMMIT and DROPs after it stay statements of their own.
        let sql = "CREATE FUNCTION public.begin() RETURNS int LANGUAGE sql RETURN 1;\nCOMMIT;\nDROP TABLE users;\nDROP TABLE orders;\n";
        assert_eq!(statements(sql).len(), 4);
        let scanned = scan_text(sql, EngineKind::Postgres);
        assert_eq!(scanned.statements, 4);
        assert!(scanned
            .kinds
            .iter()
            .any(|k| k.label == "DROP TABLE" && k.destructive && k.count == 2));
        assert!(scanned.per_statement.is_some());
    }

    #[test]
    fn a_body_that_never_ends_is_refused() {
        let sql = "CREATE FUNCTION f() RETURNS int LANGUAGE sql BEGIN ATOMIC SELECT 1;\nDROP TABLE users;\n";
        let refused = scan_text(sql, EngineKind::Postgres)
            .refused
            .expect("refused");
        assert_eq!(refused.line, Some(1));
        let sql = "CREATE TRIGGER g AFTER INSERT ON t BEGIN SELECT 1; END x;\nDROP TABLE t;\n";
        assert!(scan_text(sql, EngineKind::Sqlite).refused.is_some());
    }

    #[test]
    fn a_huge_statement_is_classified_from_its_start() {
        let mut sql = String::from("INSERT INTO t VALUES (1)");
        while sql.len() < 200 * 1024 {
            sql.push_str(", (1)");
        }
        assert_eq!(classified(&sql).len(), 64 * 1024);
        let scanned = scan_text(&format!("{sql};\n"), EngineKind::Sqlite);
        assert_eq!(scanned.kinds[0].label, "INSERT");
    }

    #[test]
    fn a_sqlite_dump_runs_with_rows_before_their_parent() {
        let dir = tempfile::tempdir().unwrap();
        let db = dir.path().join("d.db");
        rusqlite::Connection::open(&db).unwrap();
        let path = dir.path().join("f.sql");
        std::fs::write(&path, "PRAGMA foreign_keys=OFF;\nBEGIN TRANSACTION;\nCREATE TABLE child(p REFERENCES parent(id));\nINSERT INTO child VALUES(1);\nCREATE TABLE parent(id INTEGER PRIMARY KEY);\nINSERT INTO parent VALUES(1);\nCOMMIT;\n").unwrap();
        let scanned = scan(&path, EngineKind::Sqlite, |_| true).unwrap();
        let conn = open_sqlite(db.to_str().unwrap()).unwrap();
        let report = run_sqlite(&conn, &path, &scanned, WHOLE, || false, |_| {});
        assert_eq!(report.failed, None);
        assert_eq!(count(&conn, "child"), Some(1));
    }

    #[test]
    fn statements_in_the_files_open_transaction_are_lost() {
        // Two transactions of its own, so no wrapper the run passes over.
        let sql = "CREATE TABLE t(a);\nBEGIN;\nINSERT INTO t VALUES(1);\nCOMMIT;\nBEGIN;\nINSERT INTO t VALUES(2);\nINSERT INTO nope VALUES(1);\nCOMMIT;\n";
        let each = RunOptions {
            whole_file: false,
            keep_going: false,
        };
        let (report, _conn) = sqlite_run(sql, each, false);
        assert_eq!(report.failed.unwrap().line, Some(7));
        assert_eq!((report.done, report.lost), (6, 2));
    }

    #[test]
    fn sqlite_per_statement_stops_or_keeps_going() {
        let sql = "CREATE TABLE t(a);\nINSERT INTO nope VALUES(1);\nINSERT INTO t VALUES(2);\n";
        let stop = RunOptions {
            whole_file: false,
            keep_going: false,
        };
        let (report, conn) = sqlite_run(sql, stop, false);
        assert_eq!(report.failed.unwrap().line, Some(2));
        assert_eq!(count(&conn, "t"), Some(0));
        let on = RunOptions {
            whole_file: false,
            keep_going: true,
        };
        let (report, conn) = sqlite_run(sql, on, false);
        assert_eq!((report.done, report.errors), (2, 1));
        assert_eq!(report.first_error.unwrap().line, Some(2));
        assert_eq!(count(&conn, "t"), Some(1));
    }

    #[test]
    fn a_changed_file_is_not_run() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("f.sql");
        std::fs::write(&path, "CREATE TABLE t(a);").unwrap();
        let scan = scan(&path, EngineKind::Sqlite, |_| true).unwrap();
        std::fs::write(&path, "DROP TABLE kept; CREATE TABLE t(a);").unwrap();
        let conn = rusqlite::Connection::open_in_memory().unwrap();
        let report = run_sqlite(&conn, &path, &scan, WHOLE, || false, |_| {});
        assert!(report.failed.unwrap().message.contains("changed"));
    }
}
