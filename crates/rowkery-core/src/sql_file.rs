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
use crate::safety::{check_file_statement, lex, Dialect, InTransaction, Lexeme, StatementKind};

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
    /// MySQL: `CREATE … PROCEDURE | FUNCTION | TRIGGER | EVENT` seen.
    my_routine: bool,
    /// MySQL: such a routine's body opened with `BEGIN`, so its `;` needs a
    /// `DELIMITER` of its own, as the mysql client splits.
    my_compound: bool,
    /// The last lexeme was a `.` (`NEW.begin` is a name).
    after_dot: bool,
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

    /// MySQL's rule: the mysql client splits on its delimiter alone, so no
    /// body is kept whole here; a routine whose body opens with `BEGIN` is
    /// only noted, for [`Reader`] to refuse when `;` ends it. Words are
    /// looked at only in a `CREATE` (a dump's INSERTs cost nothing).
    fn my_word(&mut self, word: &[u8]) {
        self.words += 1;
        let after_dot = std::mem::take(&mut self.after_dot);
        if self.lead.len() < 4 {
            self.lead
                .push(String::from_utf8_lossy(word).to_ascii_uppercase());
        }
        if self.lead[0] != "CREATE" || self.my_compound || after_dot {
            return;
        }
        let is = |w: &str| word.eq_ignore_ascii_case(w.as_bytes());
        if !self.my_routine {
            self.my_routine = ["PROCEDURE", "FUNCTION", "TRIGGER", "EVENT"]
                .iter()
                .any(|w| is(w));
        } else if is("BEGIN") && self.parens == 0 {
            self.my_compound = true;
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
    /// How statements are split: as the engine that will run them reads
    /// the text, so each one checked is one the engine runs.
    dialect: Dialect,
    /// MySQL: what ends a statement, as the file's `DELIMITER` lines set it
    /// (the mysql client's rule; `;` until one does).
    delimiter: Vec<u8>,
}

impl<R: Read> Reader<R> {
    pub fn new(src: R, dialect: Dialect) -> Self {
        Self {
            dialect,
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
            delimiter: b";".to_vec(),
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
            if self.delimiter != b";" {
                // The file's own delimiter ends a statement wherever a
                // lexeme could start; `;` is then just text.
                let d = self.delimiter.len();
                if self.buf.len() - self.pos < d && !self.eof {
                    self.fill()?;
                    continue;
                }
                if self.buf[self.pos..].starts_with(&self.delimiter) {
                    let at = self.pos;
                    match self.stmt.first {
                        Some(first) => {
                            return self
                                .statement(first, at, at + d)
                                .map(Piece::Statement)
                                .map(Some)
                        }
                        None => {
                            self.consume(at + d);
                            continue;
                        }
                    }
                }
            }
            let Some((lexeme, mut end)) = lex(&self.buf, self.pos, self.eof, self.dialect) else {
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
            // The mysql client finds its delimiter anywhere outside strings,
            // names and comments: inside a word (`END$$`) or a `/*! … */`
            // too. The lexeme ends there; the delimiter is found next.
            if self.delimiter != b";"
                && end - at > 1
                && matches!(
                    lexeme,
                    Lexeme::Word
                        | Lexeme::Number
                        | Lexeme::Executable { .. }
                        | Lexeme::Other
                        | Lexeme::Skip
                        | Lexeme::Bracket { .. }
                )
            {
                if !self.eof && self.buf.len() < end + self.delimiter.len() {
                    self.fill()?;
                    continue;
                }
                if let Some(k) = (at + 1..end).find(|&k| self.buf[k..].starts_with(&self.delimiter))
                {
                    end = k;
                }
            }
            match lexeme {
                Lexeme::Space | Lexeme::LineComment | Lexeme::BlockComment { .. } => {}
                Lexeme::Semicolon if self.stmt.begin_depth == 0 && self.delimiter == b";" => {
                    match self.stmt.first {
                        Some(first) if self.stmt.my_compound => {
                            let line = self.line_at(first);
                            return Err(ReadError::at(
                            line,
                            format!("Line {line}: this routine's body has ; in it, so it needs a delimiter of its own: put DELIMITER ;; on the line before it and ;; after its END, as the mysql client reads it."),
                        ));
                        }
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
                    }
                }
                Lexeme::Other if self.buf[at] == b'\\' => return self.meta().map(Some),
                Lexeme::Word
                    if self.dialect == Dialect::Mysql
                        && self.stmt.first.is_none()
                        && self.buf[at..end].eq_ignore_ascii_case(b"DELIMITER") =>
                {
                    self.set_delimiter()?;
                    continue;
                }
                // MariaDB's `/*M!999999\- enable the sandbox mode */`: a
                // command to its client, a comment to every server.
                Lexeme::Executable { inner, .. }
                    if self.stmt.first.is_none() && self.buf.get(inner.0) == Some(&b'\\') =>
                {
                    let line = self.line_at(at);
                    let text = String::from_utf8_lossy(&self.buf[at..end]).into_owned();
                    self.consume(end);
                    return Ok(Some(Piece::Meta {
                        line,
                        text,
                        inside: false,
                    }));
                }
                _ => {
                    self.stmt.first.get_or_insert(at);
                    let mysql = self.dialect == Dialect::Mysql;
                    match lexeme {
                        Lexeme::Open => self.stmt.parens += 1,
                        Lexeme::Close => self.stmt.parens -= 1,
                        Lexeme::Word if mysql => {
                            let (buf, stmt) = (&self.buf, &mut self.stmt);
                            stmt.my_word(&buf[at..end]);
                        }
                        Lexeme::Word => {
                            let (buf, stmt) = (&self.buf, &mut self.stmt);
                            stmt.word(&buf[at..end]);
                        }
                        _ => {}
                    }
                    if !matches!(lexeme, Lexeme::Word) {
                        self.stmt.after_dot = lexeme == Lexeme::Dot;
                    }
                }
            }
            self.pos = end;
        }
    }

    /// Ends the statement at `buf[first..stop]`, consuming through `end`.
    fn statement(&mut self, first: usize, stop: usize, end: usize) -> Result<Statement, ReadError> {
        let line = self.line_at(first);
        let text = &self.buf[first..stop];
        let sql = match std::str::from_utf8(text) {
            Ok(sql) => sql.to_string(),
            Err(_) if self.dialect == Dialect::Mysql => mysql_hex_binary(text)
                .and_then(|sql| String::from_utf8(sql).ok())
                .ok_or_else(|| {
                    ReadError::at(
                        line,
                        "This statement holds bytes that aren't UTF-8 text. If they are binary values in a dump, make the dump again with --hex-blob. Otherwise save the file as UTF-8 and read it again.",
                    )
                })?,
            Err(_) => {
                return Err(ReadError::at(
                    line,
                    "This statement isn't UTF-8 text. Save the file as UTF-8 and read it again.",
                ))
            }
        };
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

    /// The mysql client's `DELIMITER xx` line whose word is at `buf[pos]`:
    /// statements end at `xx` from here on.
    fn set_delimiter(&mut self) -> Result<(), ReadError> {
        let stop = loop {
            match memchr::memchr(b'\n', &self.buf[self.pos..]) {
                Some(p) => break self.pos + p,
                None if self.eof => break self.buf.len(),
                None => self.fill()?,
            }
        };
        let at = self.pos;
        let line = self.line_at(at);
        let text = String::from_utf8_lossy(&self.buf[at + "DELIMITER".len()..stop]).into_owned();
        let delimiter = text.split_whitespace().next().unwrap_or("");
        if delimiter.is_empty() || delimiter.contains('\\') {
            return Err(ReadError::at(
                line,
                format!("Line {line}: DELIMITER needs the text that ends each statement, such as DELIMITER ;; (no backslash)."),
            ));
        }
        self.delimiter = delimiter.as_bytes().to_vec();
        self.consume((stop + 1).min(self.buf.len()));
        Ok(())
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

/// Client commands dumps write that a run skips: pg_dump's (17.6, 16.10,
/// …) `\restrict` lines, and mariadb-dump's sandbox line, which only
/// restricts its own client.
fn skipped_meta(text: &str) -> bool {
    let command = text.split_whitespace().next().unwrap_or("");
    matches!(command, "\\restrict" | "\\unrestrict") || text.starts_with("/*M!999999\\- ")
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

    let mut reader = Reader::new(file, engine.into());
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
                let client = if engine == EngineKind::Mysql {
                    "the mysql client"
                } else {
                    "psql"
                };
                let what = if engine == EngineKind::Mysql {
                    "mysql client"
                } else {
                    "psql"
                };
                refuse(
                    &mut scan,
                    line,
                    format!("Line {line} is a {what} command ({text}), which only {client} can run. Remove it, or run the file with {client}."),
                );
                return Ok(scan);
            }
            Piece::Statement(statement) => statement,
        };
        let (head, cut) = classified(&statement.sql);
        let Some((mut check, role)) = check_file_statement(head, engine.into()) else {
            continue;
        };
        // What comes after the head is unread. A long INSERT (a dump's rows)
        // adds rows; anything else, a long `WITH … DELETE` or a SELECT calling
        // a writing function, may change anything, so it is listed in red.
        let unread = cut && !starts_insert(head);
        if cut {
            check.kind = StatementKind::Write;
            if unread {
                check.destructive = true;
            } else {
                check.verb = "INSERT".into();
            }
        }
        if engine == EngineKind::Mysql && check.verb.starts_with("SET") {
            if let Some(why) = mysql_mode_change(&statement.sql) {
                refuse(
                    &mut scan,
                    statement.line,
                    format!("Line {}: {why}", statement.line),
                );
                return Ok(scan);
            }
        }
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
            _ if unread => format!("{} (not fully read)", check.verb),
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
            InTransaction::Never if engine == EngineKind::Mysql => {
                if scan.per_statement.is_none() {
                    let reason = mysql_never_reason(&check.verb, &statement.sql);
                    scan.per_statement = Some(PerStatement {
                        line: statement.line,
                        reason,
                    });
                }
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

/// `sql_mode` flags that change how MySQL reads quotes and backslashes,
/// which the file was split without (`ANSI` and the like include
/// `ANSI_QUOTES`).
pub const MYSQL_LEXICAL_MODES: [&str; 7] = [
    "ANSI",
    "NO_BACKSLASH_ESCAPES",
    "ORACLE",
    "DB2",
    "MSSQL",
    "POSTGRESQL",
    "MAXDB",
];

/// A MySQL statement holding bytes that aren't UTF-8, with each
/// `_binary '…'` value that holds them written as `_binary 0x…`: the same
/// bytes in a string of the same kind, as text Rowkery can keep. mysqldump
/// writes BLOB, BINARY and BIT values that way unless told `--hex-blob`.
///
/// `None` when such bytes sit anywhere else (a plain string as mariadb-dump
/// writes them, a name, a comment): what the server makes of those depends
/// on where the value goes, so no other spelling means the same everywhere.
///
/// Escapes read as the server reads them with backslash escapes on and
/// UTF-8 as its client character set, where neither `\` nor a quote can be
/// part of a longer character. A run checks both before each statement
/// (`session_lexical_mode`).
fn mysql_hex_binary(sql: &[u8]) -> Option<Vec<u8>> {
    const HEX: &[u8; 16] = b"0123456789ABCDEF";
    // What can run on from a hex literal, or into one, as a single word.
    let word_byte = |b: u8| b.is_ascii_alphanumeric() || b == b'_' || b == b'$' || b >= 0x80;
    #[derive(PartialEq)]
    enum Last {
        Other,
        Dot,
        /// The word `_binary`, not after a `.` (which makes it a name).
        Introducer,
        /// A value this wrote in hex: a string right after it would have
        /// been joined to it, and isn't to `0x…`.
        Hex,
    }
    let mut out = Vec::with_capacity(sql.len() + sql.len() / 2);
    let mut last = Last::Other;
    let mut i = 0;
    while let Some((lexeme, end)) = lex(sql, i, true, Dialect::Mysql) {
        let text = &sql[i..end];
        i = end;
        match lexeme {
            Lexeme::Space | Lexeme::LineComment | Lexeme::BlockComment { .. } => {
                out.extend_from_slice(text);
                continue;
            }
            // `/*! 'tail' */` is a string to the server as much as a bare one.
            Lexeme::String { .. } | Lexeme::Executable { .. } if last == Last::Hex => return None,
            Lexeme::String { .. } if std::str::from_utf8(text).is_err() => {
                if last != Last::Introducer {
                    return None;
                }
                // A quote ends a word and `0x…` doesn't: `_binary'…'alias`
                // would run together into one name.
                if out.last().is_some_and(|b| word_byte(*b)) {
                    out.push(b' ');
                }
                out.extend_from_slice(b"0x");
                for byte in mysql_string_bytes(text)? {
                    out.extend_from_slice(&[
                        HEX[usize::from(byte >> 4)],
                        HEX[usize::from(byte & 15)],
                    ]);
                }
                if sql.get(i).is_some_and(|b| word_byte(*b)) {
                    out.push(b' ');
                }
                last = Last::Hex;
                continue;
            }
            _ => out.extend_from_slice(text),
        }
        last = match lexeme {
            Lexeme::Dot => Last::Dot,
            Lexeme::Word if last != Last::Dot && text.eq_ignore_ascii_case(b"_binary") => {
                Last::Introducer
            }
            _ => Last::Other,
        };
    }
    Some(out)
}

/// The bytes of the MySQL string `text` (`'…'`, quotes included) as the
/// server unescapes them (`sql_lex.cc`'s `get_text`): `\0`, `\b`, `\n`,
/// `\r`, `\t` and `\Z` are control bytes, `\%` and `\_` keep their
/// backslash, any other escaped byte is itself, and `''` is one quote.
/// `None` when it isn't one closed `'…'`.
fn mysql_string_bytes(text: &[u8]) -> Option<Vec<u8>> {
    let inner = text.strip_prefix(b"'")?.strip_suffix(b"'")?;
    let mut out = Vec::with_capacity(inner.len());
    let mut bytes = inner.iter().copied();
    while let Some(byte) = bytes.next() {
        match byte {
            b'\\' => match bytes.next()? {
                b'0' => out.push(0),
                b'b' => out.push(8),
                b'n' => out.push(b'\n'),
                b'r' => out.push(b'\r'),
                b't' => out.push(b'\t'),
                b'Z' => out.push(0x1A),
                c @ (b'%' | b'_') => out.extend_from_slice(&[b'\\', c]),
                c => out.push(c),
            },
            b'\'' => {
                if bytes.next()? != b'\'' {
                    return None;
                }
                out.push(b'\'');
            }
            _ => out.push(byte),
        }
    }
    Some(out)
}

/// MySQL's client character sets other than UTF-8. Rowkery's text is
/// UTF-8, and the server reads it otherwise under any of these: in gbk,
/// big5, sjis, cp932 and gb18030 a byte from 0x81 and the `\` after it are
/// one character, and in macroman or hp8 a UTF-8 byte after `--` starts a
/// comment.
pub const MYSQL_NON_UTF8_CHARSETS: [&str; 35] = [
    "ARMSCII8", "ASCII", "BIG5", "BINARY", "CP1250", "CP1251", "CP1256", "CP1257", "CP850",
    "CP852", "CP866", "CP932", "DEC8", "EUCJPMS", "EUCKR", "GB18030", "GB2312", "GBK", "GEOSTD8",
    "GREEK", "HEBREW", "HP8", "KEYBCS2", "KOI8R", "KOI8U", "LATIN1", "LATIN2", "LATIN5", "LATIN7",
    "MACCE", "MACROMAN", "SJIS", "SWE7", "TIS620", "UJIS",
];

/// Whether the server reads Rowkery's UTF-8 text otherwise under the client
/// character set `name`: anything but utf8mb4 and utf8mb3 (`utf8`), names
/// this list doesn't know included.
pub fn mysql_non_utf8(name: &str) -> bool {
    !matches!(
        name.trim().to_ascii_lowercase().as_str(),
        "utf8mb4" | "utf8mb3" | "utf8"
    )
}

/// Why a MySQL file's `SET` statement `sql` can't run: it sets an
/// `sql_mode` or client character set that reads the rest of the file
/// differently from how Rowkery split it. One set from a variable is
/// checked on the server as the run goes.
fn mysql_mode_change(sql: &str) -> Option<String> {
    let upper = sql.to_ascii_uppercase();
    let words: Vec<&str> = upper
        .split(|c: char| !(c.is_ascii_alphanumeric() || c == '_'))
        .filter(|w| !w.is_empty())
        .collect();
    let has = |w: &str| words.contains(&w);
    if has("SQL_MODE") {
        if let Some(flag) = MYSQL_LEXICAL_MODES
            .iter()
            .find(|f| words.iter().any(|w| w.starts_with(*f)))
        {
            return Some(format!("this sets sql_mode with {flag}, which changes how MySQL reads quotes or backslashes in the rest of the file. Rowkery splits a file the default way, so it can't run this one."));
        }
        // MariaDB's `SET STATEMENT sql_mode = … FOR …` holds the statement
        // it reads under that mode.
        if words.get(1) == Some(&"STATEMENT") && has("FOR") {
            return Some("SET STATEMENT sql_mode = … FOR … can change how MySQL reads the statement inside it, so Rowkery can't run this file.".into());
        }
    }
    if has("NAMES") || has("CHARACTER") || has("CHARSET") || has("CHARACTER_SET_CLIENT") {
        if let Some(set) = MYSQL_NON_UTF8_CHARSETS.iter().find(|c| has(c)) {
            let set = set.to_ascii_lowercase();
            return Some(format!("this sets the character set to {set}, in which MySQL reads the rest of the file differently from how Rowkery split it. Save the file as UTF-8 (utf8mb4) to run it."));
        }
    }
    None
}

/// Why a MySQL statement keeps the file from running as one transaction:
/// the server's own words where they are sure, "may" where it depends.
fn mysql_never_reason(verb: &str, sql: &str) -> String {
    if verb == crate::safety::UNCLEAR_VERB {
        return "Rowkery can't read this statement for sure, so it may be one MySQL commits by itself".into();
    }
    let upper = sql.to_ascii_uppercase();
    match verb {
        "SET" if upper.contains("AUTOCOMMIT") => "SET autocommit changes when MySQL commits".into(),
        "SET" if upper.contains("TRANSACTION") => {
            "SET … TRANSACTION changes the transaction itself".into()
        }
        "SET" if upper.contains("PASSWORD") || upper.contains("ROLE") => {
            "SET PASSWORD and SET DEFAULT ROLE commit by themselves on MySQL".into()
        }
        _ if [
            "CREATE",
            "ALTER",
            "DROP",
            "RENAME",
            "TRUNCATE",
            "LOCK",
            "GRANT",
            "REVOKE",
            "ANALYZE",
            "OPTIMIZE",
            "REPAIR",
            "FLUSH",
            "RESET",
            "INSTALL",
            "UNINSTALL",
        ]
        .contains(&verb.split(' ').next().unwrap_or("")) =>
        {
            format!("{verb} commits by itself on MySQL")
        }
        _ => format!("{verb} may commit by itself on MySQL"),
    }
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
    // `-- MySQL dump 10.13  Distrib 8.0.46, for Linux`,
    // `-- MariaDB dump 10.19  Distrib 10.11.19-MariaDB, for …` (10.x),
    // `-- MariaDB dump 10.19-11.4.13-MariaDB, for …` (11.x).
    for line in text.lines().take(3) {
        if let Some(rest) = line.strip_prefix("-- MySQL dump ") {
            let version = rest.split("Distrib ").nth(1)?.split([',', ' ']).next()?;
            return Some(format!("mysqldump {version}"));
        }
        if let Some(rest) = line.strip_prefix("-- MariaDB dump ") {
            let version = match rest.split_once("Distrib ") {
                Some((_, after)) => after,
                None => rest.split_once('-')?.1,
            };
            let version = version.split(['-', ',', ' ']).next()?;
            return Some(format!("mariadb-dump {version}"));
        }
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

/// Opens the scanned file for its run on `engine` (the one it was scanned
/// for), refusing if it changed since.
pub fn open_scanned(path: &Path, scan: &Scan, engine: EngineKind) -> Result<Reader<File>, String> {
    let file = File::open(path).map_err(|e| format!("Couldn't open the file: {e}"))?;
    let meta = file
        .metadata()
        .map_err(|e| format!("Couldn't read the file: {e}"))?;
    if meta.len() != scan.bytes || meta.modified().ok() != scan.modified {
        return Err(
            "The file changed since Rowkery read it. Read it again before running it.".into(),
        );
    }
    Ok(Reader::new(file, engine.into()))
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
/// about 48 times the text, so a 500 MB INSERT is read from its first 64 kB,
/// and `true` says it was cut. A DELETE or UPDATE whose WHERE comes later
/// counts as without one, and a cut statement that reads as no write
/// counts as one: the safe side.
fn classified(sql: &str) -> (&str, bool) {
    const HEAD: usize = 64 * 1024;
    if sql.len() <= HEAD {
        return (sql, false);
    }
    let mut end = HEAD;
    while !sql.is_char_boundary(end) {
        end -= 1;
    }
    (&sql[..end], true)
}

/// Whether `sql` is an INSERT, after any leading space and comments.
fn starts_insert(sql: &str) -> bool {
    let mut rest = sql.trim_start();
    loop {
        if let Some(after) = rest.strip_prefix("--") {
            rest = after.find('\n').map_or("", |n| &after[n..]).trim_start();
        } else if let Some(after) = rest.strip_prefix("/*") {
            rest = after
                .find("*/")
                .map_or("", |n| &after[n + 2..])
                .trim_start();
        } else {
            break;
        }
    }
    rest.get(..6)
        .is_some_and(|w| w.eq_ignore_ascii_case("INSERT"))
        && !rest[6..].starts_with(|c: char| c.is_ascii_alphanumeric() || c == '_')
}

/// Runs `sql`, one statement of a file, on SQLite: exactly one statement
/// as SQLite reads it, which is the one safe mode checked. If SQLite finds
/// another after it, or a parameter left unbound (which it would read as
/// NULL), nothing runs. Any rows it returns are read and dropped.
fn run_one_sqlite(conn: &rusqlite::Connection, sql: &str) -> rusqlite::Result<()> {
    let mut batch = rusqlite::Batch::new(conn, sql);
    let Some(mut statement) = batch.next()? else {
        return Ok(());
    };
    let refuse = |why: &str| {
        Err(rusqlite::Error::SqliteFailure(
            rusqlite::ffi::Error::new(rusqlite::ffi::SQLITE_MISUSE),
            Some(why.to_string()),
        ))
    };
    if batch.next().map_or(true, |more| more.is_some()) {
        return refuse(
            "SQLite reads more than one statement here, so it wasn't run: Rowkery checked it as one.",
        );
    }
    if statement.parameter_count() > 0 {
        return refuse(
            "This statement has a parameter ($a, :a, ?) with no value, so it wasn't run.",
        );
    }
    let mut rows = statement.raw_query();
    while rows.next()?.is_some() {}
    Ok(())
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
    let mut reader = match check_options(scan, options)
        .and_then(|_| open_scanned(path, scan, EngineKind::Sqlite))
    {
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
        match run_one_sqlite(conn, &statement.sql) {
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
    let reader = match check_options(scan, options)
        .and_then(|_| open_scanned(path, scan, EngineKind::Postgres))
    {
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

/// Runs the scanned file on a MySQL session of its own (never a tab's:
/// the file's `SET`s and `USE` stay on it, so the caller drops it after).
/// `cancelled` says a cancel was asked for; whoever asks sends the server
/// `KILL QUERY` too.
///
/// The file was split with backslash escapes and `"` as a string, MySQL's
/// default reading: a session whose `sql_mode` reads them otherwise is
/// refused, at the start and after any statement that sets `sql_mode`.
/// MySQL commits by itself before DDL; the scan sends such files per
/// statement, and a whole-file run stops if its transaction ends anyway.
pub async fn run_mysql(
    session: &mut crate::db::mysql::MysqlSession,
    path: &Path,
    scan: &Scan,
    options: RunOptions,
    cancelled: impl Fn() -> bool,
    on_progress: impl FnMut(&Progress),
) -> RunReport {
    use crate::db::mysql::{session_execute, session_lexical_mode, session_run_file_statement};
    use crate::db::DriverError;

    let mut tally = Tally::new(options, on_progress);
    let failed = |tally: &mut Tally<_>, message: String| {
        tally.file_failed(ReadError {
            line: None,
            message,
        })
    };
    let reader = match check_options(scan, options)
        .and_then(|_| open_scanned(path, scan, EngineKind::Mysql))
    {
        Ok(reader) => reader,
        Err(message) => {
            failed(&mut tally, message);
            return tally.finish(0);
        }
    };
    let lexical = |what: String| {
        format!("This connection's {what}, which changes how MySQL reads quotes, backslashes or comments. Rowkery reads a file the default way, so it can't run it here.")
    };
    match session_lexical_mode(session).await {
        Ok(None) => {}
        Ok(Some(flag)) => {
            failed(&mut tally, lexical(flag));
            return tally.finish(0);
        }
        Err(e) => {
            failed(&mut tally, e.into_message());
            return tally.finish(0);
        }
    }
    if options.whole_file {
        if let Err(e) = session_execute(session, "START TRANSACTION").await {
            failed(&mut tally, e.into_message());
            return tally.finish(0);
        }
    }
    let mut rx = feed(reader, scan.clone());
    let mut bytes = 0;
    let mut ok = true;
    let is_cancel = |e: &DriverError| matches!(e, DriverError::Cancelled) || cancelled();
    while let Some(item) = rx.recv().await {
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
            // MySQL has no COPY: the reader sends no rows.
            Feed::Rows(..) | Feed::RowsEnd => continue,
        };
        bytes = offset;
        tally.starting(&statement, offset);
        let mut ran = false;
        match session_run_file_statement(session, &statement.sql).await {
            Ok(rows) => {
                ran = true;
                tally.ran(if counts_rows(&statement.verb) {
                    rows
                } else {
                    0
                })
            }
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
        // A `SET` of `sql_mode` or the character set may read the rest of
        // the file otherwise, and so may one built at run time (EXECUTE,
        // a MariaDB block): the server says, after anything but rows. A
        // routine runs under its own mode.
        let sets_mode = !matches!(
            statement.verb.as_str(),
            "INSERT" | "REPLACE" | "UPDATE" | "DELETE"
        );
        if sets_mode {
            let flag = match session_lexical_mode(session).await {
                Ok(flag) => flag.map(lexical),
                Err(e) => Some(e.into_message()),
            };
            if let Some(message) = flag {
                tally.report.failed = Some(Failure {
                    line: Some(statement.line),
                    statement: preview(&statement.sql),
                    message,
                });
                ok = false;
                break;
            }
        }
        // What the server says, not the file's words: DDL commits by itself.
        match session.txn_known() {
            Some(false) if options.whole_file => {
                tally.report.failed = Some(Failure {
                    line: Some(statement.line),
                    statement: preview(&statement.sql),
                    message: "MySQL committed the transaction at this statement, so what ran up to here is saved and the rest didn't run.".into(),
                });
                return tally.finish(offset);
            }
            Some(false) => tally.open_since = None,
            Some(true) if ran && !options.whole_file => {
                let since = tally.progress.done.saturating_sub(1);
                tally.open_since.get_or_insert(since);
            }
            _ => {}
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
                failed(&mut tally, message);
            }
        } else {
            // If even this doesn't answer, the server rolls back when the
            // caller drops the session.
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
        let mut reader = Reader::new(sql.as_bytes(), Dialect::Either);
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
        let mut reader = Reader::new(sql.as_bytes(), Dialect::Either);
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

    #[test]
    fn a_mysqldump_binary_value_is_kept_as_hex() {
        let statements = |sql: &[u8]| -> Result<Vec<String>, ReadError> {
            let mut reader = Reader::new(sql, Dialect::Mysql);
            let mut out = Vec::new();
            while let Some(piece) = reader.next_piece()? {
                if let Piece::Statement(s) = piece {
                    out.push(s.sql);
                }
            }
            Ok(out)
        };
        // As mysqldump 8.4 writes a BINARY(16) key, a BIT(8) and a BLOB
        // holding a PNG's first bytes; text beside them stays as it is.
        let dump = b"INSERT INTO `t` VALUES (_binary '\\0\x11\\\"3DUfw\x88\x99\xaa\xbb\\\xcc\\\xdd\\\xee\xff','caf\xc3\xa9',_binary '\xaa'),\n(_binary '\\'\\'\\\\\\\\\\0',_binary 'plain; text',_binary '\x89PNG\\r\\n\\Z\\n');\nSELECT 2;\n";
        assert_eq!(
            statements(dump).unwrap(),
            [
                "INSERT INTO `t` VALUES (_binary 0x00112233445566778899AABBCCDDEEFF,'caf\u{e9}',_binary 0xAA),\n(_binary '\\'\\'\\\\\\\\\\0',_binary 'plain; text',_binary 0x89504E470D0A1A0A)",
                "SELECT 2"
            ]
        );
        // Every escape as the server reads it.
        assert_eq!(
            statements(b"SELECT _binary'\xff\\0\\b\\n\\r\\t\\Z\\%\\_\\\\\\'\\\"\\a\\\xfe''\"'")
                .unwrap(),
            ["SELECT _binary 0xFF00080A0D091A5C255C5F5C272261FE2722"]
        );
        // A word on either side stays its own word.
        assert_eq!(
            statements(b"SELECT _binary'\xff'abc, _binary '\xfe' /* c */ FROM t").unwrap(),
            ["SELECT _binary 0xFF abc, _binary 0xFE /* c */ FROM t"]
        );
        // Anywhere else such bytes mean what the column makes of them
        // (mariadb-dump writes binary values as plain strings): refused, and
        // the message says what works.
        for sql in [
            &b"INSERT INTO t VALUES ('\xff');"[..],
            b"INSERT INTO t VALUES (_binary \"\xff\");",
            b"SELECT t._binary '\xff';",
            b"SELECT _binary '\xff' 'tail';",
            b"SELECT _binary 'head' '\xff';",
            b"SELECT _binary '\xff' /*!50000 'tail' */;",
            b"SELECT 1 /* \xff */;",
            b"SELECT `\xff`;",
            b"SELECT _binary '\xff",
        ] {
            let refused = statements(sql).unwrap_err();
            assert!(refused.message.contains("--hex-blob"), "{refused:?}");
        }
        // Postgres and SQLite have no such values.
        let mut reader = Reader::new(&b"SELECT _binary '\xff';"[..], Dialect::Postgres);
        assert!(!reader
            .next_piece()
            .unwrap_err()
            .message
            .contains("hex-blob"));
    }

    /// The shape of a mariadb-dump 11.4 file (mysqldump 8 writes the same
    /// but for the first line and its header).
    const MARIADB_DUMP: &str = "/*M!999999\\- enable the sandbox mode */ \n-- MariaDB dump 10.19-11.4.13-MariaDB, for debian-linux-gnu (x86_64)\n--\n/*!40101 SET @OLD_SQL_MODE=@@SQL_MODE, SQL_MODE='NO_AUTO_VALUE_ON_ZERO' */;\nDROP TABLE IF EXISTS `p`;\nCREATE TABLE `p` (`id` int NOT NULL, `name` varchar(20), PRIMARY KEY (`id`));\nLOCK TABLES `p` WRITE;\n/*!40000 ALTER TABLE `p` DISABLE KEYS */;\nINSERT INTO `p` VALUES (1,'it\\'s'),(2,'semi;colon');\n/*!40000 ALTER TABLE `p` ENABLE KEYS */;\nUNLOCK TABLES;\nDELIMITER ;;\n/*!50003 CREATE*/ /*!50017 DEFINER=`root`@`localhost`*/ /*!50003 TRIGGER t BEFORE INSERT ON p FOR EACH ROW BEGIN SET NEW.name = CONCAT(NEW.name, ';'); END \n*/;;\nCREATE DEFINER=`root`@`localhost` PROCEDURE `pr`()\nBEGIN SELECT 1; SELECT 2; END\n;;\nDELIMITER ;\n/*!40101 SET SQL_MODE=@OLD_SQL_MODE */;\n-- Dump completed\n";

    fn mysql_statements(sql: &str) -> Vec<Piece> {
        let mut reader = Reader::new(sql.as_bytes(), Dialect::Mysql);
        let mut out = Vec::new();
        while let Some(piece) = reader.next_piece().unwrap() {
            out.push(piece);
        }
        out
    }

    #[test]
    fn mysql_files_split_as_the_mysql_client_reads_them() {
        let pieces = mysql_statements(MARIADB_DUMP);
        assert!(
            matches!(&pieces[0], Piece::Meta { line: 1, text, inside: false } if text.starts_with("/*M!999999\\-"))
        );
        let sql: Vec<&str> = pieces
            .iter()
            .filter_map(|p| match p {
                Piece::Statement(s) => Some(s.sql.as_str()),
                Piece::Meta { .. } => None,
            })
            .collect();
        assert_eq!(sql.len(), 11, "{sql:#?}");
        assert_eq!(
            sql[5],
            "INSERT INTO `p` VALUES (1,'it\\'s'),(2,'semi;colon')"
        );
        // The file's own delimiter keeps each body whole, `;` and all.
        assert!(sql[8].starts_with("/*!50003 CREATE*/") && sql[8].ends_with("END \n*/"));
        assert_eq!(
            sql[9],
            "CREATE DEFINER=`root`@`localhost` PROCEDURE `pr`()\nBEGIN SELECT 1; SELECT 2; END"
        );
        assert_eq!(sql[10], "/*!40101 SET SQL_MODE=@OLD_SQL_MODE */");
        // Any delimiter, even one that starts a comment or a string.
        let got = mysql_statements(
            "DELIMITER //\nSELECT 1; SELECT 2//\nSELECT '//'//\ndelimiter ;\nSELECT 3;",
        );
        let sql: Vec<String> = got
            .into_iter()
            .filter_map(|p| match p {
                Piece::Statement(s) => Some(s.sql),
                Piece::Meta { .. } => None,
            })
            .collect();
        assert_eq!(sql, ["SELECT 1; SELECT 2", "SELECT '//'", "SELECT 3"]);
        // `-- ` needs its space, `#` is a comment.
        let got = mysql_statements("SELECT 1--1;\n# a; comment\nSELECT 2;");
        assert_eq!(got.len(), 2);
        // The client finds a delimiter inside a word or a `/*! … */`, not
        // in a plain comment or a string.
        let texts = |sql: &str| -> Vec<String> {
            mysql_statements(sql)
                .into_iter()
                .filter_map(|p| match p {
                    Piece::Statement(s) => Some(s.sql),
                    Piece::Meta { .. } => None,
                })
                .collect()
        };
        assert_eq!(
            texts("DELIMITER $$\nCREATE PROCEDURE p() BEGIN SELECT 1; END$$\nDELIMITER ;\nSELECT 2;\n"),
            ["CREATE PROCEDURE p() BEGIN SELECT 1; END", "SELECT 2"]
        );
        assert_eq!(
            texts("DELIMITER ab\nSELECT cab SELECT 1"),
            ["SELECT c", "SELECT 1"]
        );
        assert_eq!(
            texts("DELIMITER $$\nSELECT /*!50000 1 $$\nSELECT /* 3 $$ */ 4$$\nSELECT 'x$$'$$"),
            ["SELECT /*!50000 1", "SELECT /* 3 $$ */ 4", "SELECT 'x$$'"]
        );
    }

    #[test]
    fn mysql_scans_say_what_commits_by_itself() {
        let scan = scan_text(MARIADB_DUMP, EngineKind::Mysql);
        assert_eq!(scan.refused, None);
        assert_eq!(scan.source.as_deref(), Some("mariadb-dump 11.4.13"));
        assert_eq!(scan.statements, 11);
        let per = scan.per_statement.unwrap();
        assert_eq!(
            (per.line, per.reason.as_str()),
            (5, "DROP TABLE commits by itself on MySQL")
        );
        let kinds: Vec<&str> = scan.kinds.iter().map(|k| k.label.as_str()).collect();
        assert!(
            kinds.contains(&"ALTER TABLE") && kinds.contains(&"LOCK"),
            "{kinds:?}"
        );
        let mysql = scan_text(
            "-- MySQL dump 10.13  Distrib 8.0.46, for Linux (x86_64)\nSELECT 1;\n",
            EngineKind::Mysql,
        );
        assert_eq!(mysql.source.as_deref(), Some("mysqldump 8.0.46"));
        let maria10 = scan_text("-- MariaDB dump 10.19  Distrib 10.11.19-MariaDB, for debian-linux-gnu (x86_64)\nSELECT 1;\n", EngineKind::Mysql);
        assert_eq!(maria10.source.as_deref(), Some("mariadb-dump 10.11.19"));
        // Rows alone can run as one transaction; the file's own around them
        // is replaced by Rowkery's.
        let rows = scan_text(
            "SET NAMES utf8mb4;\nBEGIN;\nINSERT INTO t VALUES (1);\nUPDATE t SET a = 2;\nCOMMIT;\n",
            EngineKind::Mysql,
        );
        assert_eq!((rows.per_statement, rows.skip), (None, vec![1, 4]));
        for (sql, reason) in [
            ("INSERT INTO t VALUES (1);\nCALL p();\n", "CALL may commit"),
            ("INSERT INTO t VALUES (1);\nSET TRANSACTION ISOLATION LEVEL SERIALIZABLE;\n", "SET … TRANSACTION changes"),
            ("INSERT INTO t VALUES (1);\nSET STATEMENT max_statement_time = 10 FOR CREATE TABLE x (a int);\n", "SET STATEMENT may commit"),
            ("INSERT INTO t VALUES (1);\nSET PASSWORD = 'x';\n", "SET PASSWORD"),
            ("INSERT INTO t VALUES (1);\n/*!00000 SELECT 1; DELETE FROM t */;\n", "Rowkery can't read"),
            ("INSERT INTO t VALUES (1);\nSET autocommit = 1;\n", "SET"),
            ("INSERT INTO t VALUES (1);\nTRUNCATE t;\n", "TRUNCATE"),
        ] {
            let per = scan_text(sql, EngineKind::Mysql).per_statement.unwrap();
            assert_eq!(per.line, 2, "{sql}");
            assert!(per.reason.starts_with(reason), "{sql}: {}", per.reason);
        }
        assert_eq!(
            scan_text(
                "CREATE TEMPORARY TABLE x (a int);\nINSERT INTO x VALUES (1);\n",
                EngineKind::Mysql
            )
            .per_statement,
            None
        );
    }

    #[test]
    fn mysql_scans_refuse_what_the_split_cant_hold() {
        let refused = |sql: &str| scan_text(sql, EngineKind::Mysql).refused.unwrap();
        // A body with `;` and no delimiter of its own: the mysql client
        // would send it in pieces.
        let body = refused("SELECT 1;\nCREATE PROCEDURE p()\nBEGIN SELECT 1; SELECT 2; END;\n");
        assert_eq!(body.line, Some(2));
        assert!(body.message.contains("DELIMITER ;;"), "{body:?}");
        // …but a body of one statement, or `begin` as a name, is fine.
        for sql in [
            "CREATE TRIGGER t BEFORE INSERT ON a FOR EACH ROW SET NEW.begin = 1;\n",
            "CREATE FUNCTION f() RETURNS int DETERMINISTIC RETURN 1;\n",
        ] {
            assert_eq!(scan_text(sql, EngineKind::Mysql).refused, None, "{sql}");
        }
        assert_eq!(
            scan_text("INSERT INTO t VALUES ('sql_mode ANSI');\nCREATE FUNCTION f() RETURNS int RETURN (SELECT begin FROM t);\n", EngineKind::Mysql).refused,
            None
        );
        for sql in [
            "SET NAMES gbk;\n",
            "/*!40101 SET character_set_client = sjis */;\n",
            "SET CHARACTER SET big5;\n",
            "/*!40101 SET NAMES latin1 */;\n",
            "SET NAMES macroman;\n",
        ] {
            assert!(
                refused(sql).message.contains("Save the file as UTF-8"),
                "{sql}"
            );
        }
        let client = refused("SELECT 1;\n\\G\n");
        assert!(
            client.message.contains("mysql client command (\\G)"),
            "{client:?}"
        );
        let mode = refused("SET SESSION sql_mode = 'ANSI_QUOTES';\nSELECT \"a\";\n");
        assert_eq!(mode.line, Some(1));
        assert!(mode.message.contains("ANSI"), "{mode:?}");
        assert!(
            refused("/*!40101 SET SQL_MODE='NO_BACKSLASH_ESCAPES' */;\n")
                .message
                .contains("NO_BACKSLASH_ESCAPES")
        );
        assert!(refused("SET STATEMENT sql_mode = @m FOR SELECT 1;\n")
            .message
            .contains("SET STATEMENT"));
        assert!(refused("DELIMITER\nSELECT 1;\n")
            .message
            .contains("DELIMITER ;;"));
        // MySQL has no COPY: its rows' `\.` reads as a client command.
        assert_eq!(refused("COPY t FROM stdin;\n1\n\\.\n").line, Some(3));
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
        assert_eq!(classified(&sql), (&sql[..64 * 1024], true));
        let scanned = scan_text(&format!("{sql};\n"), EngineKind::Sqlite);
        assert_eq!(scanned.kinds[0].label, "INSERT");
    }

    #[test]
    fn a_huge_statement_whose_write_comes_late_is_a_write() {
        let mut sql = String::from("WITH fixes (id, v) AS (VALUES (1, 'a')");
        while sql.len() < 200 * 1024 {
            sql.push_str(", (1, 'a')");
        }
        sql.push_str(") UPDATE t SET v = fixes.v FROM fixes WHERE t.id = fixes.id");
        // The panel lists it in red, since what it changes is unread.
        let unread = |scan: &Scan| {
            scan.writes
                && scan
                    .kinds
                    .iter()
                    .any(|k| k.destructive && k.label.ends_with("(not fully read)"))
        };
        for engine in [EngineKind::Postgres, EngineKind::Sqlite] {
            assert!(
                unread(&scan_text(&format!("{sql};\n"), engine)),
                "{engine:?}"
            );
        }
        // A short one is read whole, and a long read-only SELECT still reads
        // as a write: what follows its head is unknown.
        assert!(
            !scan_text(
                "WITH x AS (SELECT 1) SELECT * FROM x;\n",
                EngineKind::Postgres
            )
            .writes
        );
        let mut select = String::from("SELECT 1");
        while select.len() < 70 * 1024 {
            select.push_str(", 1");
        }
        assert!(unread(&scan_text(
            &format!("{select};\n"),
            EngineKind::Postgres
        )));
        // A long INSERT, a dump's rows cut mid-string, is an INSERT.
        let mut insert = String::from("-- rows\nINSERT INTO t VALUES (1, 'a')");
        while insert.len() < 70 * 1024 {
            insert.push_str(", (1, 'a')");
        }
        let scan = scan_text(&format!("{insert};\n"), EngineKind::Postgres);
        assert!(scan.writes);
        assert_eq!(scan.kinds.len(), 1);
        assert_eq!(
            (scan.kinds[0].label.as_str(), scan.kinds[0].destructive),
            ("INSERT", false)
        );
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

    /// A file is split as the engine that runs it reads it, each statement
    /// is checked that way, and on SQLite each piece runs as exactly one
    /// statement: what runs is what was checked.
    #[test]
    fn sqlite_files_split_check_and_run_as_sqlite_reads_them() {
        use crate::safety::UNCLEAR_VERB;
        // Read as either engine, `E'\' …'` is one string hiding the DELETE;
        // SQLite has no E'…' strings and runs it. Its own statement now.
        let sql = "CREATE TABLE t(e);\nINSERT INTO t VALUES(1);\nSELECT E'\\' FROM t; DELETE FROM t; --';\n";
        let scanned = scan_text(sql, EngineKind::Sqlite);
        assert_eq!(scanned.statements, 4, "{:?}", scanned.kinds);
        assert!(
            scanned
                .kinds
                .iter()
                .any(|k| k.label.contains("DELETE") && k.destructive),
            "{:?}",
            scanned.kinds
        );
        let (report, conn) = sqlite_run(sql, WHOLE, false);
        assert_eq!((report.done, report.failed), (4, None));
        assert_eq!(count(&conn, "t"), Some(0));

        // `[a;b]` is one SQLite name, not two statements.
        let sql =
            "CREATE TABLE u([a;b]);\nINSERT INTO u([a;b]) VALUES (1);\nSELECT [a;b] FROM u;\n";
        assert_eq!(scan_text(sql, EngineKind::Sqlite).statements, 3);
        let (report, conn) = sqlite_run(sql, WHOLE, false);
        assert_eq!((report.done, report.failed), (3, None));
        assert_eq!(count(&conn, "u"), Some(1));

        // Two statements as the engine reads them are never classified by
        // the first alone; a routine's body is one statement.
        let (check, _) = check_file_statement("SELECT 1; DELETE FROM t", Dialect::Sqlite).unwrap();
        assert_eq!(check.verb, UNCLEAR_VERB);
        let (check, _) = check_file_statement(
            "CREATE TRIGGER g AFTER INSERT ON t BEGIN DELETE FROM t; END",
            Dialect::Sqlite,
        )
        .unwrap();
        assert!(
            check.verb != UNCLEAR_VERB && check.changes_data(),
            "{check:?}"
        );

        // On SQLite a piece runs only if it is one statement with no
        // parameter left unbound.
        let conn = rusqlite::Connection::open_in_memory().unwrap();
        conn.execute_batch("CREATE TABLE t(a); INSERT INTO t VALUES (1);")
            .unwrap();
        for sql in [
            "SELECT 1; DELETE FROM t",
            "SELECT 1 /* */; DELETE FROM t",
            "WITH x AS (SELECT $a) DELETE FROM t WHERE 1 OR $a",
            "DELETE FROM t WHERE a = ?",
        ] {
            assert!(run_one_sqlite(&conn, sql).is_err(), "{sql}");
            assert_eq!(count(&conn, "t"), Some(1), "{sql}");
        }
        for sql in [
            "SELECT a FROM t -- done",
            "SELECT a FROM t; -- done",
            "CREATE TRIGGER g AFTER INSERT ON t BEGIN SELECT 1; END",
            "",
        ] {
            assert!(run_one_sqlite(&conn, sql).is_ok(), "{sql}");
        }
    }
}
