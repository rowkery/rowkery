//! CSV import into an existing table (2026-10-21).
//!
//! The file is streamed here, never through the webview: [`preview`] reads
//! its first rows and counts the rest; [`import_postgres`] and
//! [`import_sqlite`] write every row in one transaction that rolls back
//! whole on any error or a cancel.
//!
//! Postgres stages the rows with `COPY … FROM STDIN` into a temporary table
//! shaped like the target's columns (so the server reports a bad value with
//! its line and column), then runs one `INSERT … SELECT` that fills empty
//! cells with the column's DEFAULT and applies Stop, Skip or Update when a
//! key already exists. SQLite runs one prepared INSERT per row.
//!
//! Values are checked with the grid's rules ([`crate::edits::typed_text`]),
//! so a bad one stops the import with its line and column named.

use std::fs::File;
use std::io::BufReader;
use std::path::Path;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};

use crate::db::postgres::{cancel_with_token, humanize_postgres_error, PostgresSession, TxnState};
use crate::db::{qualified_table_sql, quote_ident, EngineKind};
use crate::edits::typed_text;

/// Rows the panel shows from the top of the file (the grid's preview).
pub const PREVIEW_ROWS: usize = 20;
/// Rows between progress reports and cancel checks.
const PROGRESS_EVERY: u64 = 1000;
/// Bytes per `COPY` message.
const COPY_CHUNK: usize = 64 * 1024;
/// The staging table, dropped when the transaction ends.
const STAGE: &str = "pg_temp.rowkery_import";

/// The top of a file and how it is split, for the panel.
#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct CsvPreview {
    pub file_name: String,
    /// `,`, `;`, `|` or a tab.
    pub delimiter: String,
    /// The first records as read (the header, when there is one, first).
    pub rows: Vec<Vec<String>>,
    /// Every record in the file, the first row included.
    pub records: u64,
}

/// What happens when a row's key is already in the table.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum OnConflict {
    /// The import fails and nothing is written.
    #[default]
    Stop,
    /// The existing row stays; the file's row is left out.
    Skip,
    /// The existing row takes the file's values.
    Update,
}

/// What an empty cell becomes.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum EmptyCells {
    /// NULL, or the column's DEFAULT when it has one.
    #[default]
    Null,
    /// `''` in a text column; other columns as for `Null`.
    Text,
}

/// One CSV field and the column it goes to.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct ImportColumn {
    /// 0-based position in each record.
    pub field: usize,
    pub column: String,
}

/// An import as the panel asks for it.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct ImportSpec {
    pub path: String,
    pub schema: String,
    pub table: String,
    pub delimiter: String,
    /// The first record names the columns and isn't imported.
    pub header: bool,
    pub columns: Vec<ImportColumn>,
    #[serde(default)]
    pub on_conflict: OnConflict,
    #[serde(default)]
    pub empty: EmptyCells,
}

/// A column of the table as the database describes it.
#[derive(Clone, Debug, PartialEq)]
pub struct TargetColumn {
    pub name: String,
    pub type_name: String,
    /// Its DEFAULT expression, as SQL.
    pub default: Option<String>,
    /// Filled in by the database (generated, or an identity GENERATED
    /// ALWAYS): it can't be imported into.
    pub generated: bool,
}

/// The table's columns and primary key, read on the import's own connection.
#[derive(Clone, Debug, PartialEq)]
pub struct ImportTarget {
    pub columns: Vec<TargetColumn>,
    pub key: Vec<String>,
}

/// Rows each outcome took.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize)]
pub struct ImportCounts {
    pub inserted: u64,
    pub updated: u64,
    pub skipped: u64,
    pub elapsed_ms: u64,
}

/// Why nothing was written.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum ImportError {
    Cancelled,
    Failed(String),
}

impl From<String> for ImportError {
    fn from(message: String) -> Self {
        ImportError::Failed(message)
    }
}

impl From<&str> for ImportError {
    fn from(message: &str) -> Self {
        ImportError::Failed(message.into())
    }
}

/// `12,431`.
pub fn thousands(n: u64) -> String {
    let digits = n.to_string();
    let mut out = String::new();
    for (i, c) in digits.chars().enumerate() {
        if i > 0 && (digits.len() - i).is_multiple_of(3) {
            out.push(',');
        }
        out.push(c);
    }
    out
}

/// The delimiter by the extension (`.tsv`, `.tab`), else the most common of
/// `,` `;` `|` and tab on the first line.
pub fn detect_delimiter(path: &Path, first_line: &[u8]) -> u8 {
    let ext = path
        .extension()
        .map(|e| e.to_string_lossy().to_ascii_lowercase())
        .unwrap_or_default();
    if ext == "tsv" || ext == "tab" {
        return b'\t';
    }
    let mut best = (b',', 0);
    for d in *b",\t;|" {
        let mut quoted = false;
        let n = first_line
            .iter()
            .filter(|&&b| {
                if b == b'"' {
                    quoted = !quoted;
                }
                !quoted && b == d
            })
            .count();
        if n > best.1 {
            best = (d, n);
        }
    }
    best.0
}

fn delimiter_byte(delimiter: &str) -> Result<u8, String> {
    match delimiter.as_bytes() {
        [b] if matches!(b, b',' | b'\t' | b';' | b'|') => Ok(*b),
        _ => Err(format!("{delimiter:?} isn't a delimiter Rowkery reads")),
    }
}

fn open_reader(path: &str, delimiter: u8) -> Result<csv::Reader<BufReader<File>>, String> {
    let file = File::open(path).map_err(|e| format!("Couldn't open the file: {e}"))?;
    Ok(csv::ReaderBuilder::new()
        .has_headers(false)
        .flexible(true)
        .delimiter(delimiter)
        .from_reader(BufReader::with_capacity(256 * 1024, file)))
}

/// The next record into `record`; false at the end. A UTF-8 BOM before the
/// first one is dropped.
fn next_record(
    reader: &mut csv::Reader<BufReader<File>>,
    record: &mut csv::StringRecord,
) -> Result<bool, String> {
    let first = reader.position().record() == 0;
    match reader.read_record(record) {
        Ok(more) => {
            if more && first {
                if let Some(head) = record.get(0) {
                    if let Some(rest) = head.strip_prefix('\u{feff}') {
                        let mut fixed = csv::StringRecord::new();
                        fixed.push_field(rest);
                        record.iter().skip(1).for_each(|f| fixed.push_field(f));
                        fixed.set_position(record.position().cloned());
                        *record = fixed;
                    }
                }
            }
            Ok(more)
        }
        Err(e) => Err(read_error(&e)),
    }
}

fn read_error(e: &csv::Error) -> String {
    let line = e
        .position()
        .map(|p| format!("Line {}: ", thousands(p.line())))
        .unwrap_or_default();
    match e.kind() {
        csv::ErrorKind::Utf8 { .. } => {
            format!("{line}this file isn't UTF-8 text. Save it as UTF-8 and try again.")
        }
        csv::ErrorKind::Io(io) => format!("Couldn't read the file: {io}"),
        _ => format!("{line}{e}"),
    }
}

/// The first [`PREVIEW_ROWS`] + 1 records of `path` and how many it holds.
pub fn preview(path: &str) -> Result<CsvPreview, String> {
    let first_line = {
        use std::io::{BufRead, Read};
        let file = File::open(path).map_err(|e| format!("Couldn't open the file: {e}"))?;
        let mut line = Vec::new();
        BufReader::new(file)
            .take(64 * 1024)
            .read_until(b'\n', &mut line)
            .map_err(|e| format!("Couldn't read the file: {e}"))?;
        line
    };
    let delimiter = detect_delimiter(Path::new(path), &first_line);
    let mut reader = open_reader(path, delimiter)?;
    let mut record = csv::StringRecord::new();
    let mut rows = Vec::new();
    let mut records = 0u64;
    while next_record(&mut reader, &mut record)? {
        if rows.len() <= PREVIEW_ROWS {
            rows.push(record.iter().map(str::to_string).collect());
        }
        records += 1;
    }
    if records == 0 {
        return Err("This file is empty".into());
    }
    Ok(CsvPreview {
        file_name: Path::new(path)
            .file_name()
            .map(|n| n.to_string_lossy().to_string())
            .unwrap_or_else(|| path.to_string()),
        delimiter: (delimiter as char).to_string(),
        rows,
        records,
    })
}

/// A text column takes `''` for an empty cell under [`EmptyCells::Text`].
fn takes_empty_text(engine: EngineKind, type_name: &str) -> bool {
    let t = type_name.trim().to_ascii_lowercase();
    match engine {
        // SQLite's TEXT affinity, and a column declared with no type.
        EngineKind::Sqlite => {
            t.is_empty() || t.contains("char") || t.contains("clob") || t.contains("text")
        }
        EngineKind::Postgres => {
            let base = t.split('(').next().unwrap_or("").trim();
            matches!(
                base,
                "text"
                    | "character varying"
                    | "varchar"
                    | "character"
                    | "char"
                    | "bpchar"
                    | "citext"
                    | "name"
            )
        }
    }
}

/// The import checked against the table: which field goes to which column.
struct Plan<'a> {
    engine: EngineKind,
    target_sql: String,
    fields: Vec<(usize, &'a TargetColumn)>,
    /// Fields every record must have.
    width: Option<usize>,
    empty: EmptyCells,
    on_conflict: OnConflict,
    key: &'a [String],
}

impl<'a> Plan<'a> {
    fn new(
        engine: EngineKind,
        spec: &ImportSpec,
        target: &'a ImportTarget,
    ) -> Result<Self, String> {
        if spec.columns.is_empty() {
            return Err("Pick at least one column to import".into());
        }
        let mut fields = Vec::new();
        for c in &spec.columns {
            let col = target
                .columns
                .iter()
                .find(|t| t.name == c.column)
                .ok_or_else(|| format!("{} isn't a column of {}", c.column, spec.table))?;
            if col.generated {
                return Err(format!(
                    "{} is filled in by the database, so it can't be imported. Skip it.",
                    col.name
                ));
            }
            if fields
                .iter()
                .any(|(_, t): &(usize, &TargetColumn)| t.name == col.name)
            {
                return Err(format!("Two fields go to {}", col.name));
            }
            fields.push((c.field, col));
        }
        let key = &target.key;
        if spec.on_conflict == OnConflict::Update && key.is_empty() {
            return Err(format!(
                "{} has no primary key, so existing rows can't be updated",
                spec.table
            ));
        }
        Ok(Self {
            engine,
            target_sql: qualified_table_sql(engine, &spec.schema, &spec.table),
            fields,
            width: None,
            empty: spec.empty,
            on_conflict: spec.on_conflict,
            key,
        })
    }

    fn ident(&self, name: &str) -> String {
        quote_ident(self.engine, name)
    }

    fn column_list(&self) -> String {
        self.fields
            .iter()
            .map(|(_, c)| self.ident(&c.name))
            .collect::<Vec<_>>()
            .join(", ")
    }

    /// The record's values in field order, `None` for NULL (or DEFAULT).
    fn values(&mut self, record: &csv::StringRecord) -> Result<Vec<Option<String>>, String> {
        let line = record.position().map_or(0, |p| p.line());
        let width = *self.width.get_or_insert(record.len());
        if record.len() != width {
            return Err(format!(
                "Line {} has {} values; the first row has {}",
                thousands(line),
                record.len(),
                width
            ));
        }
        self.fields
            .iter()
            .map(|(field, col)| {
                let raw = record.get(*field).ok_or_else(|| {
                    format!("The file has no column {} for {}", field + 1, col.name)
                })?;
                if raw.is_empty() {
                    let text = self.empty == EmptyCells::Text
                        && takes_empty_text(self.engine, &col.type_name);
                    return Ok(text.then(String::new));
                }
                typed_text(self.engine, &col.type_name, raw)
                    .map(Some)
                    .map_err(|e| format!("Line {}, {}: {e}", thousands(line), col.name))
            })
            .collect()
    }

    /// `ON CONFLICT …` for Skip, after the INSERT's rows. Update inserts
    /// only the new rows, after updating the others.
    fn conflict_sql(&self) -> String {
        match self.on_conflict {
            OnConflict::Skip if self.key.is_empty() => " ON CONFLICT DO NOTHING".into(),
            OnConflict::Skip => format!(" ON CONFLICT ({}) DO NOTHING", self.idents(self.key)),
            OnConflict::Stop | OnConflict::Update => String::new(),
        }
    }

    fn idents(&self, names: &[String]) -> String {
        names
            .iter()
            .map(|n| self.ident(n))
            .collect::<Vec<_>>()
            .join(", ")
    }

    /// Update, when the file carries the whole key: where each key field
    /// sits among the fields. `None`: every row is new.
    fn update_key(&self) -> Option<Vec<usize>> {
        if self.on_conflict != OnConflict::Update {
            return None;
        }
        self.key
            .iter()
            .map(|k| self.fields.iter().position(|(_, c)| &c.name == k))
            .collect()
    }

    /// The fields an update writes: all but the key's.
    fn update_fields(&self) -> impl Iterator<Item = (usize, &TargetColumn)> {
        self.fields
            .iter()
            .enumerate()
            .filter(|(_, (_, c))| !self.key.contains(&c.name))
            .map(|(i, (_, c))| (i, *c))
    }

    /// `t.k = s.k AND …` over the key.
    fn key_match(&self, a: &str, b: &str) -> String {
        self.key
            .iter()
            .map(|k| {
                let k = self.ident(k);
                format!("{a}.{k} = {b}.{k}")
            })
            .collect::<Vec<_>>()
            .join(" AND ")
    }

    /// `value`, or the column's DEFAULT when it is NULL and there is one.
    fn or_default(&self, value: String, col: &TargetColumn) -> String {
        match &col.default {
            Some(d) => format!("COALESCE({value}, {d})"),
            None => value,
        }
    }

    /// Postgres, Update: the rows whose key is already there. An empty cell
    /// keeps the row's value.
    fn pg_update_sql(&self) -> Option<String> {
        self.update_key()?;
        let set: Vec<String> = self
            .update_fields()
            .map(|(_, c)| {
                let name = self.ident(&c.name);
                format!("{name} = COALESCE(s.{name}, t.{name})")
            })
            .collect();
        if set.is_empty() {
            return None;
        }
        Some(format!(
            "UPDATE {} AS t SET {} FROM {STAGE} AS s WHERE {}",
            self.target_sql,
            set.join(", "),
            self.key_match("t", "s")
        ))
    }

    /// Postgres: the staged rows into the table (on Update, the new ones).
    fn pg_insert_sql(&self) -> String {
        let select: Vec<String> = self
            .fields
            .iter()
            .map(|(_, c)| self.or_default(format!("s.{}", self.ident(&c.name)), c))
            .collect();
        let only_new = match self.update_key() {
            Some(_) => format!(
                " WHERE NOT EXISTS (SELECT 1 FROM {} AS t WHERE {})",
                self.target_sql,
                self.key_match("t", "s")
            ),
            None => String::new(),
        };
        format!(
            "INSERT INTO {} ({}) SELECT {} FROM {STAGE} AS s{only_new}{}",
            self.target_sql,
            self.column_list(),
            select.join(", "),
            self.conflict_sql()
        )
    }

    /// SQLite: one row, its values bound as `?1…`.
    fn sqlite_insert_sql(&self) -> String {
        let values: Vec<String> = self
            .fields
            .iter()
            .enumerate()
            .map(|(i, (_, c))| self.or_default(format!("?{}", i + 1), c))
            .collect();
        format!(
            "INSERT INTO {} ({}) VALUES ({}){}",
            self.target_sql,
            self.column_list(),
            values.join(", "),
            self.conflict_sql()
        )
    }

    /// SQLite, Update: whether the row's key is already there, with the
    /// key's fields to bind. `None` when every row is new.
    fn sqlite_exists_sql(&self) -> Option<(String, Vec<usize>)> {
        let at = self.update_key()?;
        let predicate: Vec<String> = at
            .iter()
            .enumerate()
            .map(|(i, &f)| format!("{} = ?{}", self.ident(&self.fields[f].1.name), i + 1))
            .collect();
        Some((
            format!(
                "SELECT 1 FROM {} WHERE {}",
                self.target_sql,
                predicate.join(" AND ")
            ),
            at,
        ))
    }

    /// SQLite, Update: one existing row, bound like the INSERT. An empty
    /// cell keeps the row's value. `None` when only the key is imported.
    fn sqlite_update_sql(&self) -> Option<String> {
        let at = self.update_key()?;
        let set: Vec<String> = self
            .update_fields()
            .map(|(i, c)| {
                let name = self.ident(&c.name);
                format!("{name} = COALESCE(?{}, {name})", i + 1)
            })
            .collect();
        if set.is_empty() {
            return None;
        }
        let predicate: Vec<String> = at
            .iter()
            .map(|&f| format!("{} = ?{}", self.ident(&self.fields[f].1.name), f + 1))
            .collect();
        Some(format!(
            "UPDATE {} SET {} WHERE {}",
            self.target_sql,
            set.join(", "),
            predicate.join(" AND ")
        ))
    }
}

/// `value` in COPY's text format.
fn copy_field(out: &mut Vec<u8>, value: &Option<String>) {
    let Some(text) = value else {
        out.extend_from_slice(b"\\N");
        return;
    };
    for b in text.bytes() {
        match b {
            b'\\' => out.extend_from_slice(b"\\\\"),
            b'\t' => out.extend_from_slice(b"\\t"),
            b'\n' => out.extend_from_slice(b"\\n"),
            b'\r' => out.extend_from_slice(b"\\r"),
            _ => out.push(b),
        }
    }
}

/// The file line the `n`th imported record (1-based) starts on.
fn line_of_record(spec: &ImportSpec, n: u64) -> Option<u64> {
    let mut reader = open_reader(&spec.path, delimiter_byte(&spec.delimiter).ok()?).ok()?;
    let mut record = csv::StringRecord::new();
    let skip = u64::from(spec.header);
    for _ in 0..n + skip {
        if !next_record(&mut reader, &mut record).ok()? {
            return None;
        }
    }
    record.position().map(|p| p.line())
}

/// What Postgres said about a COPY row: `line 3, column total: "x"` becomes
/// the file's line and the column.
fn copy_error(spec: &ImportSpec, message: &str, context: Option<&str>) -> String {
    let at = context.and_then(|w| {
        let rest = &w[w.find(", line ")? + 7..];
        let digits: String = rest.chars().take_while(|c| c.is_ascii_digit()).collect();
        let n: u64 = digits.parse().ok()?;
        let column = rest
            .strip_prefix(&digits)
            .and_then(|r| r.strip_prefix(", column "))
            .and_then(|r| r.split(':').next())
            .map(str::to_string);
        Some((line_of_record(spec, n)?, column))
    });
    match at {
        Some((line, Some(column))) => format!("Line {}, {column}: {message}", thousands(line)),
        Some((line, None)) => format!("Line {}: {message}", thousands(line)),
        None => message.to_string(),
    }
}

/// The table's columns (with DEFAULTs, never a generated column's
/// expression) and primary key.
pub async fn postgres_target(
    session: &PostgresSession,
    schema: &str,
    table: &str,
) -> Result<ImportTarget, String> {
    let client = session.client();
    let name = qualified_table_sql(EngineKind::Postgres, schema, table);
    let username = session.config().username.clone();
    let err = |e: tokio_postgres::Error| humanize_postgres_error(&e, &username);
    let rows = client
        .query(
            "SELECT a.attname::text, format_type(a.atttypid, a.atttypmod), \
                    CASE WHEN a.attgenerated <> '' THEN NULL \
                         WHEN a.attidentity <> '' THEN \
                           format('nextval(%L::regclass)', pg_get_serial_sequence($1, a.attname)) \
                         ELSE pg_get_expr(d.adbin, d.adrelid) END, \
                    a.attgenerated <> '' OR a.attidentity = 'a' \
             FROM pg_attribute a \
             LEFT JOIN pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum \
             WHERE a.attrelid = $1::text::regclass AND a.attnum > 0 AND NOT a.attisdropped \
             ORDER BY a.attnum",
            &[&name],
        )
        .await
        .map_err(err)?;
    let columns = rows
        .iter()
        .map(|r| TargetColumn {
            name: r.get(0),
            type_name: r.get(1),
            default: r.get(2),
            generated: r.get(3),
        })
        .collect();
    let key = client
        .query(
            "SELECT a.attname::text FROM pg_index i \
             JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = ANY(i.indkey) \
             WHERE i.indrelid = $1::text::regclass AND i.indisprimary \
             ORDER BY array_position(i.indkey::int2[], a.attnum)",
            &[&name],
        )
        .await
        .map_err(err)?
        .iter()
        .map(|r| r.get(0))
        .collect();
    Ok(ImportTarget { columns, key })
}

/// Reads the file on its own thread into COPY-ready chunks (and the rows
/// each holds), stopping at the first bad value or when `cancel` is set.
fn spawn_copy_reader(
    spec: ImportSpec,
    engine: EngineKind,
    target: ImportTarget,
    cancel: Arc<AtomicBool>,
) -> tokio::sync::mpsc::Receiver<Result<(bytes::Bytes, u64), ImportError>> {
    let (tx, rx) = tokio::sync::mpsc::channel(4);
    std::thread::spawn(move || {
        let run = || -> Result<(), ImportError> {
            let mut plan = Plan::new(engine, &spec, &target)?;
            let mut reader = open_reader(&spec.path, delimiter_byte(&spec.delimiter)?)?;
            let mut record = csv::StringRecord::new();
            let mut chunk = Vec::with_capacity(COPY_CHUNK + 4096);
            let mut rows = 0u64;
            let mut first = true;
            while next_record(&mut reader, &mut record)? {
                if std::mem::take(&mut first) && spec.header {
                    plan.width = Some(record.len());
                    continue;
                }
                for (i, v) in plan.values(&record)?.iter().enumerate() {
                    if i > 0 {
                        chunk.push(b'\t');
                    }
                    copy_field(&mut chunk, v);
                }
                chunk.push(b'\n');
                rows += 1;
                if chunk.len() >= COPY_CHUNK {
                    if cancel.load(Ordering::SeqCst) {
                        return Err(ImportError::Cancelled);
                    }
                    let out = bytes::Bytes::from(std::mem::take(&mut chunk));
                    if tx.blocking_send(Ok((out, rows))).is_err() {
                        return Ok(());
                    }
                    rows = 0;
                }
            }
            if !chunk.is_empty() {
                let _ = tx.blocking_send(Ok((bytes::Bytes::from(chunk), rows)));
            }
            Ok(())
        };
        if let Err(e) = run() {
            let _ = tx.blocking_send(Err(e));
        }
    });
    rx
}

/// Runs `work` until it ends or `cancel` is set; then the server is asked
/// to cancel it and `work` ends with its error.
async fn cancellable<T, E>(
    session: &PostgresSession,
    cancel: &AtomicBool,
    work: impl std::future::Future<Output = Result<T, E>>,
) -> Result<T, E> {
    let mut work = std::pin::pin!(work);
    let mut sent = false;
    loop {
        tokio::select! {
            done = &mut work => return done,
            _ = tokio::time::sleep(Duration::from_millis(50)), if !sent => {
                if cancel.load(Ordering::SeqCst) {
                    sent = true;
                    let _ = cancel_with_token(session.cancel_token.clone(), session.cancel_via.clone()).await;
                }
            }
        }
    }
}

/// Imports `spec` on `session`, which must have no transaction open: one
/// transaction, rolled back on any error or a cancel. `progress` hears the
/// rows sent so far.
pub async fn import_postgres(
    session: &PostgresSession,
    spec: &ImportSpec,
    cancel: Arc<AtomicBool>,
    progress: &(dyn Fn(u64) + Send + Sync),
) -> Result<ImportCounts, ImportError> {
    let start = Instant::now();
    if session.txn_state() != TxnState::None {
        return Err("A transaction is open on this connection".into());
    }
    // Reading the defaults waits on a lock another session holds on the table.
    let target = cancellable(
        session,
        &cancel,
        postgres_target(session, &spec.schema, &spec.table),
    )
    .await
    .map_err(|e| match cancel.load(Ordering::SeqCst) {
        true => ImportError::Cancelled,
        false => ImportError::Failed(e),
    })?;
    let plan = Plan::new(EngineKind::Postgres, spec, &target)?;
    let client = session.client();
    let username = session.config().username.clone();
    let message = |e: &tokio_postgres::Error| {
        // A statement timeout raises the same code as our cancel.
        if e.code() == Some(&tokio_postgres::error::SqlState::QUERY_CANCELED)
            && cancel.load(Ordering::SeqCst)
        {
            return ImportError::Cancelled;
        }
        let text = humanize_postgres_error(e, &username);
        let db = e.as_db_error();
        let text = match db.and_then(|d| d.detail()) {
            Some(detail) => format!("{text}. {detail}"),
            None => text,
        };
        ImportError::Failed(copy_error(spec, &text, db.and_then(|d| d.where_())))
    };
    client
        .batch_execute("BEGIN")
        .await
        .map_err(|e| message(&e))?;
    let rollback = || async {
        let _ = client.batch_execute("ROLLBACK").await;
    };
    let result: Result<ImportCounts, ImportError> = async {
        // Built from the column types, so it needs no SELECT on the table
        // and takes no lock on it.
        let columns: Vec<String> = plan
            .fields
            .iter()
            .map(|(_, c)| format!("{} {}", plan.ident(&c.name), c.type_name))
            .collect();
        let create = format!(
            "CREATE TEMP TABLE {STAGE} ({}) ON COMMIT DROP",
            columns.join(", ")
        );
        cancellable(session, &cancel, client.batch_execute(&create))
            .await
            .map_err(|e| message(&e))?;
        let copy_sql = format!("COPY {STAGE} ({}) FROM STDIN", plan.column_list());
        let copy = cancellable(
            session,
            &cancel,
            client.copy_in::<_, bytes::Bytes>(&copy_sql),
        )
        .await
        .map_err(|e| message(&e))?;
        let mut copy = std::pin::pin!(copy);
        let mut rows = spawn_copy_reader(
            spec.clone(),
            EngineKind::Postgres,
            target.clone(),
            cancel.clone(),
        );
        let mut sent = 0u64;
        while let Some(chunk) = rows.recv().await {
            // Dropping `copy` unfinished makes the server abort the COPY.
            let (bytes, n) = chunk?;
            futures::SinkExt::send(&mut copy, bytes)
                .await
                .map_err(|e| message(&e))?;
            sent += n;
            progress(sent);
        }
        if cancel.load(Ordering::SeqCst) {
            return Err(ImportError::Cancelled);
        }
        cancellable(session, &cancel, copy.as_mut().finish())
            .await
            .map_err(|e| message(&e))?;
        // Locks on the table are taken from here on, and a cancel ends the wait.
        let updated = match plan.pg_update_sql() {
            Some(sql) => cancellable(session, &cancel, client.execute(&sql, &[]))
                .await
                .map_err(|e| message(&e))?,
            None => 0,
        };
        let inserted = cancellable(session, &cancel, client.execute(&plan.pg_insert_sql(), &[]))
            .await
            .map_err(|e| message(&e))?;
        if cancel.load(Ordering::SeqCst) {
            return Err(ImportError::Cancelled);
        }
        Ok(ImportCounts {
            inserted,
            updated,
            skipped: sent.saturating_sub(inserted + updated),
            elapsed_ms: 0,
        })
    }
    .await;
    let mut counts = match result {
        Ok(counts) => counts,
        Err(e) => {
            rollback().await;
            return Err(e);
        }
    };
    // Never retried: a COMMIT whose answer was lost may have landed.
    client
        .batch_execute("COMMIT")
        .await
        .map_err(|e| message(&e))?;
    counts.elapsed_ms = start.elapsed().as_millis() as u64;
    Ok(counts)
}

/// The SQLite table's columns (with DEFAULTs) and primary key.
pub fn sqlite_target(conn: &rusqlite::Connection, table: &str) -> Result<ImportTarget, String> {
    let sql = format!(
        "PRAGMA table_xinfo({})",
        quote_ident(EngineKind::Sqlite, table)
    );
    let mut stmt = conn.prepare(&sql).map_err(|e| e.to_string())?;
    // cid, name, type, notnull, dflt_value, pk, hidden (non-zero: generated).
    let rows = stmt
        .query_map([], |r| {
            Ok((
                r.get::<_, String>(1)?,
                r.get::<_, String>(2)?,
                r.get::<_, Option<String>>(4)?,
                r.get::<_, i64>(5)?,
                r.get::<_, i64>(6)?,
            ))
        })
        .map_err(|e| e.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| e.to_string())?;
    if rows.is_empty() {
        return Err(format!("{table} isn't a table in this database"));
    }
    let mut pk: Vec<(i64, String)> = rows
        .iter()
        .filter(|r| r.3 > 0)
        .map(|r| (r.3, r.0.clone()))
        .collect();
    pk.sort();
    Ok(ImportTarget {
        columns: rows
            .into_iter()
            .map(|(name, type_name, default, _, hidden)| TargetColumn {
                name,
                type_name,
                default,
                generated: hidden != 0,
            })
            .collect(),
        key: pk.into_iter().map(|(_, n)| n).collect(),
    })
}

/// [`import_sqlite`] on a connection of its own to the file at `db_path`.
pub fn import_sqlite_file(
    db_path: &str,
    spec: &ImportSpec,
    cancel: &AtomicBool,
    progress: &dyn Fn(u64),
) -> Result<ImportCounts, ImportError> {
    let path = crate::connections::expand_home(db_path);
    if !path.exists() {
        return Err(format!("SQLite file not found: {db_path}").into());
    }
    let conn =
        rusqlite::Connection::open_with_flags(&path, rusqlite::OpenFlags::SQLITE_OPEN_READ_WRITE)
            .map_err(|e| e.to_string())?;
    import_sqlite(&conn, spec, cancel, progress)
}

/// Imports `spec` on `conn` (a connection of its own, in autocommit) in one
/// `BEGIN IMMEDIATE` transaction, rolled back on any error or a cancel.
pub fn import_sqlite(
    conn: &rusqlite::Connection,
    spec: &ImportSpec,
    cancel: &AtomicBool,
    progress: &dyn Fn(u64),
) -> Result<ImportCounts, ImportError> {
    let start = Instant::now();
    if !conn.is_autocommit() {
        return Err("A transaction is open on this connection".into());
    }
    let target = sqlite_target(conn, &spec.table)?;
    let mut plan = Plan::new(EngineKind::Sqlite, spec, &target)?;
    let mut reader = open_reader(&spec.path, delimiter_byte(&spec.delimiter)?)?;
    let _ = conn.busy_timeout(Duration::from_secs(2));
    conn.execute_batch("BEGIN IMMEDIATE")
        .map_err(|e| match e.sqlite_error_code() {
            Some(rusqlite::ErrorCode::DatabaseBusy | rusqlite::ErrorCode::DatabaseLocked) => {
                ImportError::Failed(
                    "The database is busy with another write. Try again once it ends.".into(),
                )
            }
            _ => ImportError::Failed(e.to_string()),
        })?;
    let result = (|| -> Result<ImportCounts, ImportError> {
        let mut insert = conn
            .prepare(&plan.sqlite_insert_sql())
            .map_err(|e| e.to_string())?;
        let exists = match plan.on_conflict {
            OnConflict::Update => plan.sqlite_exists_sql(),
            _ => None,
        };
        let mut exists = match exists {
            Some((sql, at)) => Some((conn.prepare(&sql).map_err(|e| e.to_string())?, at)),
            None => None,
        };
        let mut update = match plan.sqlite_update_sql() {
            Some(sql) => Some(conn.prepare(&sql).map_err(|e| e.to_string())?),
            None => None,
        };
        let mut counts = ImportCounts::default();
        let mut record = csv::StringRecord::new();
        let mut rows = 0u64;
        let mut first = true;
        while next_record(&mut reader, &mut record)? {
            if std::mem::take(&mut first) && spec.header {
                plan.width = Some(record.len());
                continue;
            }
            let values = plan.values(&record)?;
            let line = record.position().map_or(0, |p| p.line());
            let at_line = |e: rusqlite::Error| format!("Line {}: {e}", thousands(line));
            let existed = match &mut exists {
                Some((stmt, at)) => stmt
                    .exists(rusqlite::params_from_iter(at.iter().map(|&i| &values[i])))
                    .map_err(at_line)?,
                None => false,
            };
            if existed {
                let n = match &mut update {
                    Some(stmt) => stmt
                        .execute(rusqlite::params_from_iter(values.iter()))
                        .map_err(at_line)?,
                    None => 0,
                };
                match n {
                    0 => counts.skipped += 1,
                    _ => counts.updated += 1,
                }
            } else {
                let n = insert
                    .execute(rusqlite::params_from_iter(values.iter()))
                    .map_err(at_line)?;
                match n {
                    0 => counts.skipped += 1,
                    _ => counts.inserted += 1,
                }
            }
            rows += 1;
            if rows.is_multiple_of(PROGRESS_EVERY) {
                if cancel.load(Ordering::SeqCst) {
                    return Err(ImportError::Cancelled);
                }
                progress(rows);
            }
        }
        if cancel.load(Ordering::SeqCst) {
            return Err(ImportError::Cancelled);
        }
        Ok(counts)
    })();
    let mut counts = match result {
        Ok(counts) => counts,
        Err(e) => {
            let _ = conn.execute_batch("ROLLBACK");
            return Err(e);
        }
    };
    if let Err(e) = conn.execute_batch("COMMIT") {
        let _ = conn.execute_batch("ROLLBACK");
        return Err(ImportError::Failed(e.to_string()));
    }
    counts.elapsed_ms = start.elapsed().as_millis() as u64;
    Ok(counts)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    fn file(name: &str, text: &str) -> (tempfile::TempDir, String) {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join(name);
        std::fs::File::create(&path)
            .unwrap()
            .write_all(text.as_bytes())
            .unwrap();
        (dir, path.to_string_lossy().to_string())
    }

    fn col(name: &str, ty: &str, default: Option<&str>) -> TargetColumn {
        TargetColumn {
            name: name.into(),
            type_name: ty.into(),
            default: default.map(str::to_string),
            generated: false,
        }
    }

    fn orders() -> ImportTarget {
        ImportTarget {
            columns: vec![
                col("id", "integer", None),
                col("email", "text", None),
                col("total", "numeric(10,2)", None),
                col("status", "text", Some("'pending'::text")),
                col("note", "character varying(80)", None),
            ],
            key: vec!["id".into()],
        }
    }

    fn spec(path: &str, columns: &[(usize, &str)]) -> ImportSpec {
        ImportSpec {
            path: path.into(),
            schema: "public".into(),
            table: "orders".into(),
            delimiter: ",".into(),
            header: true,
            columns: columns
                .iter()
                .map(|(f, c)| ImportColumn {
                    field: *f,
                    column: c.to_string(),
                })
                .collect(),
            on_conflict: OnConflict::Stop,
            empty: EmptyCells::Null,
        }
    }

    #[test]
    fn import_thousands() {
        assert_eq!(thousands(0), "0");
        assert_eq!(thousands(999), "999");
        assert_eq!(thousands(4812), "4,812");
        assert_eq!(thousands(1234567), "1,234,567");
    }

    #[test]
    fn import_detects_the_delimiter() {
        let p = Path::new("a.csv");
        assert_eq!(detect_delimiter(p, b"a,b,c\n"), b',');
        assert_eq!(detect_delimiter(p, b"a;b;c\n"), b';');
        assert_eq!(detect_delimiter(p, b"a\tb\n"), b'\t');
        assert_eq!(detect_delimiter(p, b"a|b|c\n"), b'|');
        // Quoted commas don't count.
        assert_eq!(detect_delimiter(p, b"\"a,b,c\";d;e\n"), b';');
        assert_eq!(detect_delimiter(Path::new("x.TSV"), b"a,b,c"), b'\t');
        assert_eq!(detect_delimiter(p, b"one"), b',');
    }

    #[test]
    fn import_preview_reads_quotes_bom_and_counts() {
        let (_d, path) = file(
            "orders.csv",
            "\u{feff}id,email,note\r\n1,a@x.com,\"hello, \"\"you\"\"\"\r\n2,b@x.com,\"two\nlines\"\r\n\r\n3,c@x.com,\r\n",
        );
        let p = preview(&path).unwrap();
        assert_eq!(p.file_name, "orders.csv");
        assert_eq!(p.delimiter, ",");
        assert_eq!(p.records, 4);
        assert_eq!(p.rows[0], ["id", "email", "note"]);
        assert_eq!(p.rows[1][2], "hello, \"you\"");
        assert_eq!(p.rows[2][2], "two\nlines");
        assert_eq!(p.rows[3], ["3", "c@x.com", ""]);
    }

    #[test]
    fn import_preview_keeps_only_the_top() {
        let text: String = (0..500).map(|i| format!("{i}\t{i}\n")).collect();
        let (_d, path) = file("big.tsv", &text);
        let p = preview(&path).unwrap();
        assert_eq!(p.delimiter, "\t");
        assert_eq!(p.records, 500);
        assert_eq!(p.rows.len(), PREVIEW_ROWS + 1);
    }

    #[test]
    fn import_preview_refuses_empty_and_non_utf8() {
        let (_d, path) = file("e.csv", "");
        assert_eq!(preview(&path).unwrap_err(), "This file is empty");
        let dir = tempfile::tempdir().unwrap();
        let bad = dir.path().join("latin1.csv");
        std::fs::write(&bad, b"name\ncaf\xe9\n").unwrap();
        let err = preview(&bad.to_string_lossy()).unwrap_err();
        assert!(err.starts_with("Line 2: this file isn't UTF-8"), "{err}");
    }

    #[test]
    fn import_values_follow_the_grid_rules() {
        let target = orders();
        let s = spec("x", &[(0, "id"), (1, "total"), (2, "note"), (3, "status")]);
        let mut plan = Plan::new(EngineKind::Postgres, &s, &target).unwrap();
        let mut rec = csv::StringRecord::from(vec![" 7 ", "12.50", "", ""]);
        let mut pos = csv::Position::new();
        pos.set_line(4812);
        rec.set_position(Some(pos.clone()));
        assert_eq!(
            plan.values(&rec).unwrap(),
            [Some("7".into()), Some("12.50".into()), None, None]
        );
        let mut bad = csv::StringRecord::from(vec!["8", "n/a", "x", "y"]);
        bad.set_position(Some(pos.clone()));
        assert_eq!(
            plan.values(&bad).unwrap_err(),
            "Line 4,812, total: 'n/a' isn't a number"
        );
        let mut short = csv::StringRecord::from(vec!["8", "1"]);
        short.set_position(Some(pos));
        assert_eq!(
            plan.values(&short).unwrap_err(),
            "Line 4,812 has 2 values; the first row has 4"
        );
        // Empty text keeps '' in text columns only.
        let s = ImportSpec {
            empty: EmptyCells::Text,
            ..s
        };
        let mut plan = Plan::new(EngineKind::Postgres, &s, &target).unwrap();
        let rec = csv::StringRecord::from(vec!["1", "", "", ""]);
        assert_eq!(
            plan.values(&rec).unwrap(),
            [
                Some("1".into()),
                None,
                Some(String::new()),
                Some(String::new())
            ]
        );
    }

    #[test]
    fn import_plan_checks_the_mapping() {
        let target = orders();
        let err = |cols: &[(usize, &str)], on: OnConflict, t: &ImportTarget| {
            let s = ImportSpec {
                on_conflict: on,
                ..spec("x", cols)
            };
            Plan::new(EngineKind::Postgres, &s, t).err()
        };
        assert_eq!(
            err(&[], OnConflict::Stop, &target).as_deref(),
            Some("Pick at least one column to import")
        );
        assert_eq!(
            err(&[(0, "nope")], OnConflict::Stop, &target).as_deref(),
            Some("nope isn't a column of orders")
        );
        assert_eq!(
            err(&[(0, "id"), (1, "id")], OnConflict::Stop, &target).as_deref(),
            Some("Two fields go to id")
        );
        let keyless = ImportTarget {
            key: vec![],
            ..orders()
        };
        assert!(err(&[(0, "id")], OnConflict::Update, &keyless).is_some());
        assert!(err(&[(0, "id")], OnConflict::Skip, &keyless).is_none());
    }

    #[test]
    fn import_builds_the_postgres_insert() {
        let target = orders();
        let s = spec("x", &[(0, "id"), (1, "email"), (2, "status")]);
        let sql = |on: OnConflict| {
            let s = ImportSpec {
                on_conflict: on,
                ..s.clone()
            };
            let plan = Plan::new(EngineKind::Postgres, &s, &target).unwrap();
            (plan.pg_update_sql(), plan.pg_insert_sql())
        };
        assert_eq!(
            sql(OnConflict::Stop),
            (None, "INSERT INTO public.orders (id, email, status) SELECT s.id, s.email, COALESCE(s.status, 'pending'::text) FROM pg_temp.rowkery_import AS s".into())
        );
        assert!(sql(OnConflict::Skip)
            .1
            .ends_with(" ON CONFLICT (id) DO NOTHING"));
        // Update: an empty cell keeps the row's value; only new rows are inserted.
        let (update, insert) = sql(OnConflict::Update);
        assert_eq!(
            update.as_deref(),
            Some("UPDATE public.orders AS t SET email = COALESCE(s.email, t.email), status = COALESCE(s.status, t.status) FROM pg_temp.rowkery_import AS s WHERE t.id = s.id")
        );
        assert!(
            insert.ends_with(" FROM pg_temp.rowkery_import AS s WHERE NOT EXISTS (SELECT 1 FROM public.orders AS t WHERE t.id = s.id)"),
            "{insert}"
        );
    }

    #[test]
    fn import_builds_the_sqlite_insert() {
        let target = ImportTarget {
            columns: vec![
                col("id", "INTEGER", None),
                col("Note Text", "TEXT", Some("'-'")),
            ],
            key: vec!["id".into()],
        };
        let s = ImportSpec {
            on_conflict: OnConflict::Update,
            ..spec("x", &[(1, "Note Text"), (0, "id")])
        };
        let plan = Plan::new(EngineKind::Sqlite, &s, &target).unwrap();
        assert_eq!(
            plan.sqlite_insert_sql(),
            r#"INSERT INTO orders ("Note Text", id) VALUES (COALESCE(?1, '-'), ?2)"#
        );
        assert_eq!(
            plan.sqlite_exists_sql(),
            Some(("SELECT 1 FROM orders WHERE id = ?1".into(), vec![1]))
        );
        assert_eq!(
            plan.sqlite_update_sql().as_deref(),
            Some(r#"UPDATE orders SET "Note Text" = COALESCE(?1, "Note Text") WHERE id = ?2"#)
        );
        // A keyless table skips any conflict.
        let keyless = ImportTarget {
            key: vec![],
            ..target
        };
        let s = ImportSpec {
            on_conflict: OnConflict::Skip,
            ..s
        };
        assert!(Plan::new(EngineKind::Sqlite, &s, &keyless)
            .unwrap()
            .sqlite_insert_sql()
            .ends_with(" ON CONFLICT DO NOTHING"));
    }

    #[test]
    fn import_copy_text_is_escaped() {
        let mut out = Vec::new();
        copy_field(&mut out, &Some("a\\b\tc\nd\re".into()));
        out.push(b'|');
        copy_field(&mut out, &None);
        out.push(b'|');
        copy_field(&mut out, &Some(String::new()));
        assert_eq!(out, b"a\\\\b\\tc\\nd\\re|\\N|");
    }

    #[test]
    fn import_names_the_line_of_a_copy_error() {
        let (_d, path) = file("o.csv", "id,note\n1,\"two\nlines\"\n2,x\n3,y\n");
        let s = spec(&path, &[(0, "id")]);
        assert_eq!(
            copy_error(
                &s,
                "invalid input syntax for type integer: \"x\"",
                Some("COPY rowkery_import, line 2, column id: \"x\"")
            ),
            "Line 4, id: invalid input syntax for type integer: \"x\""
        );
        assert_eq!(copy_error(&s, "boom", None), "boom");
        assert_eq!(
            copy_error(&s, "boom", Some("COPY rowkery_import, line 3")),
            "Line 5: boom"
        );
    }

    fn sqlite_db() -> (tempfile::TempDir, rusqlite::Connection) {
        let dir = tempfile::tempdir().unwrap();
        let conn = rusqlite::Connection::open(dir.path().join("t.sqlite")).unwrap();
        conn.execute_batch(
            "CREATE TABLE orders (id INTEGER PRIMARY KEY, email TEXT NOT NULL, \
             total REAL, status TEXT DEFAULT 'pending', note TEXT);
             INSERT INTO orders (id, email) VALUES (1, 'old@x.com');",
        )
        .unwrap();
        (dir, conn)
    }

    /// id, email, total, status, note.
    type Row = (i64, String, Option<f64>, Option<String>, Option<String>);

    fn all(conn: &rusqlite::Connection) -> Vec<Row> {
        conn.prepare("SELECT id, email, total, status, note FROM orders ORDER BY id")
            .unwrap()
            .query_map([], |r| {
                Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?))
            })
            .unwrap()
            .collect::<Result<_, _>>()
            .unwrap()
    }

    #[test]
    fn import_sqlite_stop_skip_update_and_defaults() {
        let (dir, conn) = sqlite_db();
        let path = dir.path().join("o.csv");
        std::fs::write(
            &path,
            "order_id,mail,amount,state,gift\n1,new@x.com,5,paid,\n2,b@x.com,7.5,,hi\n3,c@x.com,,shipped,\"a,b\"\n",
        )
        .unwrap();
        let mut s = spec(
            &path.to_string_lossy(),
            &[
                (0, "id"),
                (1, "email"),
                (2, "total"),
                (3, "status"),
                (4, "note"),
            ],
        );
        let never = AtomicBool::new(false);
        // Stop: id 1 exists, nothing is written.
        let err = import_sqlite(&conn, &s, &never, &|_| {}).unwrap_err();
        assert!(
            matches!(&err, ImportError::Failed(m) if m.starts_with("Line 2: UNIQUE constraint failed")),
            "{err:?}"
        );
        assert_eq!(all(&conn).len(), 1);
        assert!(conn.is_autocommit());
        // Skip: the two new rows go in; empty status takes its DEFAULT.
        s.on_conflict = OnConflict::Skip;
        let done = import_sqlite(&conn, &s, &never, &|_| {}).unwrap();
        assert_eq!((done.inserted, done.updated, done.skipped), (2, 0, 1));
        assert_eq!(
            all(&conn),
            [
                (1, "old@x.com".into(), None, Some("pending".into()), None),
                (
                    2,
                    "b@x.com".into(),
                    Some(7.5),
                    Some("pending".into()),
                    Some("hi".into())
                ),
                (
                    3,
                    "c@x.com".into(),
                    None,
                    Some("shipped".into()),
                    Some("a,b".into())
                ),
            ]
        );
        // Update: every row exists now; empty note becomes '' under Empty text.
        s.on_conflict = OnConflict::Update;
        s.empty = EmptyCells::Text;
        let done = import_sqlite(&conn, &s, &never, &|_| {}).unwrap();
        assert_eq!((done.inserted, done.updated, done.skipped), (0, 3, 0));
        assert_eq!(
            all(&conn)[0],
            (
                1,
                "new@x.com".into(),
                Some(5.0),
                Some("paid".into()),
                Some(String::new())
            )
        );
        // Update with empty cells as NULL: the row keeps its values.
        let before = all(&conn)[1].clone();
        std::fs::write(&path, "order_id,mail,amount,state,gift\n2,,,,\n").unwrap();
        s.empty = EmptyCells::Null;
        let done = import_sqlite(&conn, &s, &never, &|_| {}).unwrap();
        assert_eq!((done.inserted, done.updated, done.skipped), (0, 1, 0));
        assert_eq!(all(&conn)[1], before);
    }

    #[test]
    fn import_sqlite_rolls_back_a_bad_row_and_a_cancel() {
        let (dir, conn) = sqlite_db();
        let path = dir.path().join("o.csv");
        let mut text = String::from("id,email\n");
        for i in 10..3000 {
            text.push_str(&format!("{i},u{i}@x.com\n"));
        }
        text.push_str("3000,\n");
        std::fs::write(&path, &text).unwrap();
        let s = spec(&path.to_string_lossy(), &[(0, "id"), (1, "email")]);
        let err = import_sqlite(&conn, &s, &AtomicBool::new(false), &|_| {}).unwrap_err();
        assert!(
            matches!(&err, ImportError::Failed(m) if m.starts_with("Line 2,992: NOT NULL constraint failed")),
            "{err:?}"
        );
        assert_eq!(all(&conn).len(), 1);
        let seen = std::sync::Mutex::new(Vec::new());
        let cancel = AtomicBool::new(false);
        let err = import_sqlite(&conn, &s, &cancel, &|n| {
            seen.lock().unwrap().push(n);
            cancel.store(true, Ordering::SeqCst);
        })
        .unwrap_err();
        assert_eq!(err, ImportError::Cancelled);
        assert_eq!(*seen.lock().unwrap(), [1000]);
        assert_eq!(all(&conn).len(), 1);
        assert!(conn.is_autocommit());
    }

    #[test]
    fn import_sqlite_reads_the_target() {
        let (_dir, conn) = sqlite_db();
        conn.execute_batch(
            "CREATE TABLE g (a INT, b INT GENERATED ALWAYS AS (a * 2), PRIMARY KEY (a))",
        )
        .unwrap();
        let t = sqlite_target(&conn, "g").unwrap();
        let b = TargetColumn {
            generated: true,
            ..col("b", "INT", None)
        };
        assert_eq!(t.columns, [col("a", "INT", None), b]);
        let s = ImportSpec {
            table: "g".into(),
            ..spec("x", &[(0, "b")])
        };
        assert_eq!(
            Plan::new(EngineKind::Sqlite, &s, &t).err().as_deref(),
            Some("b is filled in by the database, so it can't be imported. Skip it.")
        );
        assert_eq!(t.key, ["a"]);
        assert!(sqlite_target(&conn, "nope").is_err());
    }
}
