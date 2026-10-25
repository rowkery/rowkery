use std::collections::{HashMap, HashSet};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};

use rusqlite::types::ValueRef;
use rusqlite::{Connection, InterruptHandle, OpenFlags};

use crate::connections::expand_home;
use crate::edits::{ApplyCounts, ApplyFailure, RowStatement};

use super::introspect::{
    ColumnNode, DatabaseNode, ForeignKeyNode, IndexNode, RowEstimate, SchemaCatalog, SchemaNode,
    TableKind, TableNode,
};
use super::{Column, Driver, DriverError, RowBatch, Value, BATCH_BYTES};

const SQLITE_EXACT_COUNT_THRESHOLD: u64 = 10_000;

pub use rusqlite::InterruptHandle as SqliteInterruptHandle;

/// Version of the SQLite library linked into the app (`3.46.0`).
pub fn sqlite_version() -> &'static str {
    rusqlite::version()
}

const BATCH_SIZE: usize = 200;

/// What a statement fails with when another connection on the file holds
/// the lock it needs (another tab's open transaction, an edit being saved,
/// an agent) for longer than the busy timeout rusqlite sets on every
/// connection it opens (5 s).
pub const SQLITE_LOCKED: &str = "database is locked";
/// A read-only open finding a hot journal: a program stopped mid-write, and
/// only a read-write open rolls that back.
pub const SQLITE_UNFINISHED_WRITE: &str = "The file has a write left unfinished by a program that stopped. Open it in Rowkery once to recover it, then try again.";

/// SQLite's own objects (`sqlite_sequence`, `sqlite_stat1`, …): names that
/// start with exactly `sqlite_`. Not `LIKE 'sqlite_%'`, which ignores case
/// and reads `_` as any character, so it also hid tables like `SqliteLogs`.
const NOT_INTERNAL: &str = "substr(m.name, 1, 7) <> 'sqlite_'";

/// What a statement did: rows it returned (and whether a page left some),
/// or rows it changed.
enum Ran {
    Rows { rows: u64, more: bool },
    Changed(u64),
}

/// SQLite driver on a dedicated connection with `interrupt()` for cancel.
pub struct SqliteDriver {
    path: String,
    conn: Option<Arc<Mutex<Connection>>>,
    interrupt: Option<InterruptHandle>,
    cancelled: Arc<AtomicBool>,
    read_only: bool,
    /// Opened read-only at the file (`SQLITE_OPEN_READ_ONLY`), so no
    /// statement, `PRAGMA query_only = off` included, can write.
    file_read_only: bool,
    /// The file the connection opened, to notice it was replaced.
    opened: Option<FileId>,
}

/// Which file a path named when it was opened (device and inode on Unix;
/// elsewhere only that it exists).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
struct FileId(u64, u64);

fn file_id(path: &std::path::Path) -> Option<FileId> {
    let meta = std::fs::metadata(path).ok()?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        Some(FileId(meta.dev(), meta.ino()))
    }
    #[cfg(not(unix))]
    {
        let _ = meta;
        Some(FileId(0, 0))
    }
}

impl SqliteDriver {
    pub fn new(path: impl Into<String>) -> Self {
        Self {
            path: path.into(),
            conn: None,
            interrupt: None,
            cancelled: Arc::new(AtomicBool::new(false)),
            read_only: false,
            file_read_only: false,
            opened: None,
        }
    }

    /// Refuses writes at the SQLite level (`PRAGMA query_only`) for
    /// read-only connections.
    pub fn read_only(mut self, read_only: bool) -> Self {
        self.read_only = read_only;
        self
    }

    /// Read-only at the file as well as by `PRAGMA query_only`, for a
    /// connection that never writes (the MCP server's): a statement that
    /// turns the pragma off still can't write.
    pub fn read_only_file(mut self) -> Self {
        self.read_only = true;
        self.file_read_only = true;
        self
    }

    pub fn path(&self) -> &str {
        &self.path
    }

    pub fn take_interrupt_handle(&mut self) -> Option<InterruptHandle> {
        self.interrupt.take()
    }

    /// A handle that interrupts whatever runs on the connection next, for a
    /// connection kept across runs (each run arms its own).
    pub fn interrupt_handle(&self) -> Option<InterruptHandle> {
        let conn = self.conn.as_ref()?.lock().ok()?;
        Some(conn.get_interrupt_handle())
    }

    /// Turns `PRAGMA query_only` on or off on an open connection, when the
    /// connection's safe mode changed since it was opened. Read-only sends
    /// it on every call: a run on the connection may have switched it off
    /// (`PRAGMA "query_only"(0)` reads as a read to the classifier).
    pub fn set_read_only(&mut self, read_only: bool) -> Result<(), DriverError> {
        if self.read_only == read_only && !read_only {
            return Ok(());
        }
        let conn = self.connection()?;
        let guard = conn
            .lock()
            .map_err(|_| DriverError::Message("lock poisoned".into()))?;
        guard
            .pragma_update(None, "query_only", read_only)
            .map_err(|e| DriverError::Message(e.to_string()))?;
        self.read_only = read_only;
        Ok(())
    }

    /// Whether a transaction is open on the connection (BEGIN without its
    /// COMMIT or ROLLBACK yet). False when it isn't connected.
    pub fn in_transaction(&self) -> bool {
        self.conn
            .as_ref()
            .and_then(|c| c.lock().ok().map(|c| !c.is_autocommit()))
            .unwrap_or(false)
    }

    /// The path no longer names the file the connection opened: it was
    /// deleted, or replaced (a fresh copy renamed over it).
    pub fn file_replaced(&self) -> bool {
        self.opened.is_some() && file_id(&expand_home(&self.path)) != self.opened
    }

    /// Runs staged row edits as one transaction: every statement must change
    /// exactly one row, or the whole batch rolls back and the failure names
    /// the statement.
    pub fn apply_changes(&self, statements: &[RowStatement]) -> Result<ApplyCounts, ApplyFailure> {
        let conn = self
            .connection()
            .map_err(|e| ApplyFailure::other(e.into_message()))?;
        let conn = conn
            .lock()
            .map_err(|_| ApplyFailure::other("lock poisoned"))?;
        if !conn.is_autocommit() {
            return Err(ApplyFailure::other(
                "This tab has a transaction open. Commit or roll it back before saving edits.",
            ));
        }
        // IMMEDIATE takes the write lock now, so no other writer slips in between.
        conn.execute_batch("BEGIN IMMEDIATE")
            .map_err(|e| ApplyFailure::other(e.to_string()))?;
        let rollback = || {
            let _ = conn.execute_batch("ROLLBACK");
        };
        let mut counts = ApplyCounts::default();
        for (index, statement) in statements.iter().enumerate() {
            match conn.execute(&statement.sql, []) {
                Ok(1) => counts.add(statement.verb, 1),
                Ok(rows) => {
                    rollback();
                    return Err(ApplyFailure::count(index, statement, rows as u64));
                }
                Err(err) => {
                    rollback();
                    return Err(ApplyFailure::error(index, statement, err.to_string()));
                }
            }
        }
        if let Err(err) = conn.execute_batch("COMMIT") {
            rollback();
            return Err(ApplyFailure::other(err.to_string()));
        }
        Ok(counts)
    }

    /// One page of a read: steps past the first `skip` rows without reading
    /// them, streams the next `take` (0: all the rest) and stops. The `bool`
    /// is true while rows remain. The statement is finished when this
    /// returns, so nothing stays open on the file between pages.
    pub fn query_page<F>(
        &mut self,
        sql: &str,
        skip: u64,
        take: u32,
        on_batch: F,
    ) -> Result<(u64, bool), DriverError>
    where
        F: FnMut(RowBatch, bool) -> Result<(), DriverError>,
    {
        let take = (take > 0).then_some(u64::from(take));
        match self.query_rows(sql, skip, take, on_batch)? {
            Ran::Rows { rows, more } => Ok((rows, more)),
            Ran::Changed(_) => Ok((0, false)),
        }
    }

    fn query_rows<F>(
        &mut self,
        sql: &str,
        skip: u64,
        take: Option<u64>,
        mut on_batch: F,
    ) -> Result<Ran, DriverError>
    where
        F: FnMut(RowBatch, bool) -> Result<(), DriverError>,
    {
        self.cancelled.store(false, Ordering::SeqCst);
        let conn = self.connection()?;
        let guard = conn
            .lock()
            .map_err(|_| DriverError::Message("lock poisoned".into()))?;

        let mut stmt = guard.prepare(sql).map_err(map_query_error)?;
        let column_count = stmt.column_count();
        if column_count == 0 {
            let affected = guard.execute(sql, []).map_err(map_query_error)? as u64;
            return Ok(Ran::Changed(affected));
        }

        // Columns with no declared type (expressions) are named by their
        // first value's storage class, read from the first batch's rows.
        let mut columns = result_columns(&stmt);

        let mut rows = stmt.query([]).map_err(map_query_error)?;

        for _ in 0..skip {
            if self.cancelled.load(Ordering::SeqCst) {
                return Err(DriverError::Cancelled);
            }
            if rows.next().map_err(map_query_error)?.is_none() {
                break;
            }
        }

        let mut total_rows = 0u64;
        let mut more = false;
        let mut batch_rows: Vec<Vec<Value>> = Vec::with_capacity(BATCH_SIZE);
        let mut batch_bytes = 0usize;
        let mut first_batch = true;

        while let Some(row) = rows.next().map_err(map_query_error)? {
            if self.cancelled.load(Ordering::SeqCst) {
                return Err(DriverError::Cancelled);
            }
            if take.is_some_and(|take| total_rows >= take) {
                more = true;
                break;
            }
            let mut values = Vec::with_capacity(column_count);
            for i in 0..column_count {
                let value = row.get_ref(i).map_err(map_query_error)?;
                let value = sqlite_value_to_core(value);
                batch_bytes += value.heap_bytes();
                values.push(value);
            }
            batch_rows.push(values);
            total_rows += 1;

            // The first batch names untyped columns from its values, so it
            // only goes early once each has one, or at a far larger size.
            let full = batch_bytes >= BATCH_BYTES
                && (!first_batch
                    || batch_bytes >= FIRST_BATCH_BYTES
                    || all_typed(&columns, &batch_rows));
            if batch_rows.len() >= BATCH_SIZE || full {
                if first_batch {
                    name_untyped(&mut columns, &batch_rows);
                }
                let batch = RowBatch {
                    columns: columns.clone(),
                    rows: batch_rows,
                };
                batch_rows = Vec::with_capacity(BATCH_SIZE);
                batch_bytes = 0;
                on_batch(batch, first_batch)?;
                first_batch = false;
            }
        }

        if !batch_rows.is_empty() || first_batch {
            if first_batch {
                name_untyped(&mut columns, &batch_rows);
            }
            let batch = RowBatch {
                columns,
                rows: batch_rows,
            };
            on_batch(batch, first_batch)?;
        }

        Ok(Ran::Rows {
            rows: total_rows,
            more,
        })
    }

    fn connection(&self) -> Result<Arc<Mutex<Connection>>, DriverError> {
        self.conn
            .clone()
            .ok_or_else(|| DriverError::Message("not connected".into()))
    }
}

impl Driver for SqliteDriver {
    fn connect(&mut self) -> Result<(), DriverError> {
        let expanded = expand_home(&self.path);
        let path = expanded.as_path();
        if !path.exists() {
            return Err(DriverError::Message(format!(
                "SQLite file not found: {}",
                self.path
            )));
        }
        let flags = if self.file_read_only {
            OpenFlags::SQLITE_OPEN_READ_ONLY
        } else {
            OpenFlags::SQLITE_OPEN_READ_WRITE | OpenFlags::SQLITE_OPEN_CREATE
        };
        let conn = Connection::open_with_flags(path, flags)
            .map_err(|e| DriverError::Message(e.to_string()))?;
        if self.file_read_only {
            // The first read is where SQLite finds a write a crash left
            // unfinished, which only a read-write open can roll back.
            conn.query_row("SELECT count(*) FROM sqlite_master", [], |_| Ok(()))
                .map_err(map_query_error)?;
        }
        if self.read_only {
            conn.pragma_update(None, "query_only", true)
                .map_err(|e| DriverError::Message(e.to_string()))?;
        }
        let interrupt = conn.get_interrupt_handle();
        self.conn = Some(Arc::new(Mutex::new(conn)));
        self.interrupt = Some(interrupt);
        self.opened = file_id(path);
        self.cancelled.store(false, Ordering::SeqCst);
        Ok(())
    }

    fn test_connection(&mut self) -> Result<(), DriverError> {
        self.connect()?;
        let conn = self.connection()?;
        let guard = conn
            .lock()
            .map_err(|_| DriverError::Message("lock poisoned".into()))?;
        guard
            .query_row("SELECT 1", [], |_| Ok(()))
            .map_err(|e| DriverError::Message(e.to_string()))?;
        Ok(())
    }

    fn query_stream<F>(&mut self, sql: &str, on_batch: F) -> Result<u64, DriverError>
    where
        F: FnMut(RowBatch, bool) -> Result<(), DriverError>,
    {
        match self.query_rows(sql, 0, None, on_batch)? {
            Ran::Rows { rows, .. } => Ok(rows),
            Ran::Changed(affected) => Ok(affected),
        }
    }

    fn cancel(&mut self) -> Result<(), DriverError> {
        self.cancelled.store(true, Ordering::SeqCst);
        if let Some(handle) = &self.interrupt {
            handle.interrupt();
        }
        Ok(())
    }

    fn introspect_catalog(&mut self) -> Result<SchemaCatalog, DriverError> {
        introspect_sqlite(self)
    }
}

/// Maps an `interrupt()` abort to `Cancelled` so callers can tell it from a
/// real error, a lock held elsewhere to `SQLITE_LOCKED`, and a crashed
/// write a read-only open can't undo to `SQLITE_UNFINISHED_WRITE`.
fn map_query_error(e: rusqlite::Error) -> DriverError {
    match &e {
        rusqlite::Error::SqliteFailure(err, _)
            if err.extended_code == rusqlite::ffi::SQLITE_READONLY_ROLLBACK =>
        {
            DriverError::Message(SQLITE_UNFINISHED_WRITE.into())
        }
        rusqlite::Error::SqliteFailure(err, _)
            if err.code == rusqlite::ErrorCode::OperationInterrupted =>
        {
            DriverError::Cancelled
        }
        rusqlite::Error::SqliteFailure(err, _)
            if matches!(
                err.code,
                rusqlite::ErrorCode::DatabaseBusy | rusqlite::ErrorCode::DatabaseLocked
            ) =>
        {
            DriverError::Message(SQLITE_LOCKED.into())
        }
        _ => DriverError::Message(e.to_string()),
    }
}

/// A plain SQL error (`SQLITE_ERROR`: no such table, a bad view), as opposed
/// to a lock, an interrupt, an I/O failure or a corrupt file.
fn plain_sql_error(e: &rusqlite::Error) -> bool {
    matches!(e, rusqlite::Error::SqliteFailure(err, _)
        if err.extended_code & 0xff == rusqlite::ffi::SQLITE_ERROR)
}

/// One table's row count, filled in after the catalog is shown.
#[derive(Clone, Debug, PartialEq, serde::Serialize)]
pub struct TableCount {
    pub database: String,
    pub table: String,
    pub rows: RowEstimate,
}

impl SqliteDriver {
    /// Exact row counts for every table (views left out), each capped at
    /// 10,000 rows (more reads as unknown). Run after the catalog lands:
    /// counting is most of what introspection used to cost.
    pub fn table_counts(&self) -> Result<Vec<TableCount>, DriverError> {
        let conn = self.connection()?;
        let guard = conn
            .lock()
            .map_err(|_| DriverError::Message("lock poisoned".into()))?;
        let msg = |e: rusqlite::Error| DriverError::Message(e.to_string());
        let mut out = Vec::new();
        let databases: Vec<String> = guard
            .prepare("SELECT name FROM pragma_database_list WHERE name <> 'temp' ORDER BY seq")
            .map_err(msg)?
            .query_map([], |r| r.get(0))
            .map_err(msg)?
            .collect::<Result<_, _>>()
            .map_err(msg)?;
        for db in databases {
            let tables: Vec<String> = guard
                .prepare(&format!(
                    "SELECT m.name FROM {}sqlite_master m WHERE m.type = 'table' AND {NOT_INTERNAL} ORDER BY m.name",
                    sqlite_db_prefix(&db)
                ))
                .map_err(msg)?
                .query_map([], |r| r.get(0))
                .map_err(msg)?
                .collect::<Result<_, _>>()
                .map_err(msg)?;
            for table in tables {
                let rows = sqlite_row_estimate(&guard, &db, &table);
                out.push(TableCount {
                    database: db.clone(),
                    table,
                    rows,
                });
            }
        }
        Ok(out)
    }
}

fn introspect_sqlite(driver: &SqliteDriver) -> Result<SchemaCatalog, DriverError> {
    let conn = driver.connection()?;
    let guard = conn
        .lock()
        .map_err(|_| DriverError::Message("lock poisoned".into()))?;

    let mut databases = Vec::new();
    let mut db_stmt = guard
        .prepare("SELECT name FROM pragma_database_list WHERE name NOT IN ('temp') ORDER BY seq")
        .map_err(|e| DriverError::Message(e.to_string()))?;
    let db_rows = db_stmt
        .query_map([], |row| row.get::<_, String>(0))
        .map_err(|e| DriverError::Message(e.to_string()))?;

    for db_name in db_rows.flatten() {
        let schema_name = if db_name == "main" {
            "main".to_string()
        } else {
            db_name.clone()
        };
        let tables = list_sqlite_tables(&guard, &db_name, &schema_name)?;
        databases.push(DatabaseNode {
            name: db_name,
            schemas: vec![SchemaNode {
                name: schema_name,
                tables,
            }],
        });
    }

    if databases.is_empty() {
        databases.push(DatabaseNode {
            name: "main".into(),
            schemas: vec![SchemaNode {
                name: "main".into(),
                tables: list_sqlite_tables(&guard, "main", "main")?,
            }],
        });
    }

    Ok(SchemaCatalog {
        databases,
        ..Default::default()
    })
}

/// A database file's tables and views with their columns, indexes and
/// foreign keys, in four set-returning pragma queries (`pragma_table_info`
/// and friends joined to `sqlite_schema`) instead of several per table.
fn list_sqlite_tables(
    guard: &Connection,
    db_name: &str,
    schema_name: &str,
) -> Result<Vec<TableNode>, DriverError> {
    let msg = |e: rusqlite::Error| DriverError::Message(e.to_string());
    let prefix = sqlite_db_prefix(db_name);
    let schema_arg = sqlite_string_literal(db_name);
    let master = format!("{prefix}sqlite_master m");
    let relations = format!("m.type IN ('table', 'view') AND {NOT_INTERNAL}");

    let mut tables: Vec<TableNode> = Vec::new();
    let mut at: HashMap<String, usize> = HashMap::new();
    {
        let mut stmt = guard
            .prepare(&format!(
                "SELECT m.name, m.type = 'view' FROM {master} WHERE {relations} ORDER BY m.name"
            ))
            .map_err(msg)?;
        let rows = stmt
            .query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, bool>(1)?)))
            .map_err(msg)?;
        for row in rows {
            let (name, is_view) = row.map_err(msg)?;
            at.insert(name.clone(), tables.len());
            tables.push(TableNode {
                name,
                kind: if is_view {
                    TableKind::View
                } else {
                    TableKind::Table
                },
                columns: Vec::new(),
                primary_key: Vec::new(),
                indexes: Vec::new(),
                // Counted afterwards (`table_counts`), off the first paint; a
                // view's rows stay unknown (counting them runs the view).
                row_estimate: RowEstimate::Unknown,
                partition_of: None,
                foreign_keys: Vec::new(),
                table_bytes: None,
                index_bytes: None,
                indexes_deferred: false,
                // SQLite has no COMMENT.
                comment: None,
            });
        }
    }

    // Columns, in order; `pk` is the column's place in the primary key.
    // One query reads every relation's; when it fails with a plain SQL error
    // (a view whose table was dropped can't be read), each relation is read
    // on its own and a broken one is listed without columns rather than
    // failing the catalog. Any other error (a lock, an interrupt, I/O, a
    // corrupt file) fails it.
    {
        let one = format!(
            "SELECT ?1, p.name, p.type, p.\"notnull\", p.dflt_value, p.pk
             FROM pragma_table_info(?1, {schema_arg}) p ORDER BY p.cid"
        );
        let all = format!(
            "SELECT m.name, p.name, p.type, p.\"notnull\", p.dflt_value, p.pk
             FROM {master} JOIN pragma_table_info(m.name, {schema_arg}) p
             WHERE {relations} ORDER BY m.name, p.cid"
        );
        let rows = match column_rows(guard, &all, []) {
            Ok(rows) => rows,
            Err(e) if plain_sql_error(&e) => {
                let mut rows = Vec::new();
                for t in &tables {
                    match column_rows(guard, &one, [&t.name]) {
                        Ok(more) => rows.extend(more),
                        Err(e) if plain_sql_error(&e) => {}
                        Err(e) => return Err(msg(e)),
                    }
                }
                rows
            }
            Err(e) => return Err(msg(e)),
        };
        let mut keys: HashMap<usize, Vec<(i64, String)>> = HashMap::new();
        for (table, name, type_name, notnull, default, pk) in rows {
            let Some(&i) = at.get(&table) else { continue };
            if pk > 0 {
                keys.entry(i).or_default().push((pk, name.clone()));
            }
            tables[i].columns.push(ColumnNode {
                name,
                type_name,
                nullable: !notnull,
                default,
                comment: None,
            });
        }
        for (i, mut pk) in keys {
            pk.sort_by_key(|(ord, _)| *ord);
            tables[i].primary_key = pk.into_iter().map(|(_, n)| n).collect();
        }
        // A lone INTEGER PRIMARY KEY is the rowid: it fills itself, like a
        // default (not in a WITHOUT ROWID table, where it is a plain column).
        let without_rowid: HashSet<String> = guard
            .prepare(&format!(
                "SELECT m.name FROM {master} WHERE m.type = 'table' AND m.sql LIKE '%without%rowid%'"
            ))
            .and_then(|mut stmt| stmt.query_map([], |r| r.get::<_, String>(0))?.collect())
            .map_err(msg)?;
        for table in tables.iter_mut() {
            if table.primary_key.len() != 1 || without_rowid.contains(&table.name) {
                continue;
            }
            let key = &table.primary_key[0];
            if let Some(col) = table.columns.iter_mut().find(|c| &c.name == key) {
                if col.type_name.eq_ignore_ascii_case("integer") {
                    // The rowid is never NULL, though `pragma_table_info`
                    // reports no NOT NULL for it (NULL means "the next id").
                    col.nullable = false;
                    if col.default.is_none() {
                        col.default = Some("rowid".into());
                    }
                }
            }
        }
    }

    // Indexes and their columns (an expression's column has no name).
    {
        let mut stmt = guard
            .prepare(&format!(
                "SELECT m.name, il.name, il.\"unique\", il.origin = 'pk', ii.name
                 FROM {master}
                 JOIN pragma_index_list(m.name, {schema_arg}) il
                 JOIN pragma_index_info(il.name, {schema_arg}) ii
                 WHERE m.type = 'table' AND {NOT_INTERNAL}
                 ORDER BY m.name, il.seq DESC, ii.seqno"
            ))
            .map_err(msg)?;
        let rows = stmt
            .query_map([], |r| {
                Ok((
                    r.get::<_, String>(0)?,
                    r.get::<_, String>(1)?,
                    r.get::<_, bool>(2)?,
                    r.get::<_, bool>(3)?,
                    r.get::<_, Option<String>>(4)?,
                ))
            })
            .map_err(msg)?;
        for row in rows {
            let (table, name, unique, primary, column) = row.map_err(msg)?;
            let Some(&i) = at.get(&table) else { continue };
            let indexes = &mut tables[i].indexes;
            if indexes.last().is_none_or(|ix| ix.name != name) {
                indexes.push(IndexNode {
                    name,
                    columns: Vec::new(),
                    unique,
                    primary,
                    method: None,
                    size_bytes: None,
                    scans: None,
                });
            }
            if let Some(ix) = indexes.last_mut() {
                ix.columns
                    .push(column.unwrap_or_else(|| "(expression)".into()));
            }
        }
    }

    // Foreign keys: one row per column pair, grouped by constraint id.
    {
        let mut stmt = guard
            .prepare(&format!(
                "SELECT m.name, fk.id, fk.\"table\", fk.\"from\", fk.\"to\", fk.on_delete
                 FROM {master}
                 JOIN pragma_foreign_key_list(m.name, {schema_arg}) fk
                 WHERE m.type = 'table' AND {NOT_INTERNAL}
                 ORDER BY m.name, fk.id, fk.seq"
            ))
            .map_err(msg)?;
        let rows = stmt
            .query_map([], |r| {
                Ok((
                    r.get::<_, String>(0)?,
                    r.get::<_, i64>(1)?,
                    r.get::<_, String>(2)?,
                    r.get::<_, String>(3)?,
                    r.get::<_, Option<String>>(4)?,
                    r.get::<_, String>(5)?,
                ))
            })
            .map_err(msg)?;
        let mut last: Option<(usize, i64)> = None;
        for row in rows {
            let (table, id, ref_table, from, to, on_delete) = row.map_err(msg)?;
            let Some(&i) = at.get(&table) else { continue };
            // A missing `to` means the parent's primary key; the UI shows it as such.
            let to = to.unwrap_or_default();
            let fks = &mut tables[i].foreign_keys;
            match (last == Some((i, id)), fks.last_mut()) {
                (true, Some(fk)) => {
                    fk.columns.push(from);
                    fk.ref_columns.push(to);
                }
                _ => fks.push(ForeignKeyNode {
                    name: format!("fk_{table}_{id}"),
                    columns: vec![from],
                    ref_schema: schema_name.to_string(),
                    ref_table,
                    ref_columns: vec![to],
                    on_delete,
                }),
            }
            last = Some((i, id));
        }
    }

    Ok(tables)
}

/// One column of `pragma_table_info`, with its relation's name first.
type ColumnRow = (String, String, String, bool, Option<String>, i64);

fn column_rows<P: rusqlite::Params>(
    guard: &Connection,
    sql: &str,
    params: P,
) -> rusqlite::Result<Vec<ColumnRow>> {
    let mut stmt = guard.prepare(sql)?;
    let rows = stmt.query_map(params, |r| {
        Ok((
            r.get(0)?,
            r.get(1)?,
            r.get(2)?,
            r.get::<_, i64>(3)? != 0,
            r.get(4)?,
            r.get(5)?,
        ))
    })?;
    rows.collect()
}

/// Rows counted for a plan hint stop here (`PLAN_COUNT_CAP` means "more").
pub const PLAN_COUNT_CAP: u64 = 1_000_000;

/// What the plan hints need about `tables` in the file at `path`: rows
/// (counted, up to `PLAN_COUNT_CAP`) and each index's columns. Tables it
/// can't read are left out.
pub fn sqlite_plan_facts(
    path: &str,
    tables: &[(Option<String>, String)],
) -> crate::plan::PlanFacts {
    let mut facts = crate::plan::PlanFacts::default();
    let Ok(conn) = Connection::open_with_flags(
        expand_home(path),
        OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX,
    ) else {
        return facts;
    };
    for (_, table) in tables {
        let quoted = sqlite_ident_quote(table);
        let rows: Option<f64> = conn
            .query_row(
                &format!("SELECT COUNT(*) FROM (SELECT 1 FROM {quoted} LIMIT {PLAN_COUNT_CAP})"),
                [],
                |r| r.get::<_, i64>(0),
            )
            .ok()
            .map(|n| n as f64);
        let Some(rows) = rows else { continue };
        let mut indexes = Vec::new();
        let names: Vec<String> = conn
            .prepare(&format!(
                "PRAGMA index_list({})",
                sqlite_string_literal(table)
            ))
            .and_then(|mut st| {
                st.query_map([], |r| r.get::<_, String>(1))?
                    .collect::<Result<Vec<_>, _>>()
            })
            .unwrap_or_default();
        for name in names {
            let columns: Vec<String> = conn
                .prepare(&format!(
                    "PRAGMA index_info({})",
                    sqlite_string_literal(&name)
                ))
                .and_then(|mut st| {
                    st.query_map([], |r| r.get::<_, Option<String>>(2))?
                        .collect::<Result<Vec<_>, _>>()
                })
                .unwrap_or_default()
                .into_iter()
                .map(|c| c.unwrap_or_else(|| "(expression)".into()))
                .collect();
            indexes.push(crate::plan::IndexFacts { name, columns });
        }
        facts.tables.push(crate::plan::TableFacts {
            schema: None,
            table: table.clone(),
            rows: Some(rows),
            indexes,
        });
    }
    facts
}

fn sqlite_row_estimate(guard: &Connection, db_name: &str, table: &str) -> RowEstimate {
    let qualified = format!(
        "SELECT COUNT(*) FROM (SELECT 1 FROM {}{} LIMIT {})",
        sqlite_db_prefix(db_name),
        sqlite_ident_quote(table),
        SQLITE_EXACT_COUNT_THRESHOLD + 1
    );
    match guard.query_row(&qualified, [], |row| row.get::<_, i64>(0)) {
        Ok(n) if n >= 0 => {
            let n = n as u64;
            if n <= SQLITE_EXACT_COUNT_THRESHOLD {
                RowEstimate::Exact(n)
            } else {
                RowEstimate::Unknown
            }
        }
        _ => RowEstimate::Unknown,
    }
}

fn sqlite_string_literal(name: &str) -> String {
    let escaped = name.replace('\'', "''");
    format!("'{escaped}'")
}

fn sqlite_ident_quote(name: &str) -> String {
    let escaped = name.replace('"', "\"\"");
    format!("\"{escaped}\"")
}

fn sqlite_db_prefix(db_name: &str) -> String {
    if db_name == "main" {
        String::new()
    } else {
        format!("{}.", sqlite_ident_quote(db_name))
    }
}

/// A result's columns, each with its declared type (`sqlite3_column_decltype`:
/// the table column's type as written, `VARCHAR(20)`), or `""` when it has
/// none (an expression, a column declared without a type).
fn result_columns(stmt: &rusqlite::Statement<'_>) -> Vec<Column> {
    // rusqlite panics on a declared type that isn't UTF-8; read it as none.
    let declared = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        stmt.columns()
            .into_iter()
            .map(|c| c.decl_type().map(str::to_string))
            .collect::<Vec<_>>()
    }))
    .unwrap_or_default();
    (0..stmt.column_count())
        .map(|i| Column {
            name: stmt.column_name(i).unwrap_or("?").to_string(),
            type_name: declared.get(i).cloned().flatten().unwrap_or_default(),
        })
        .collect()
}

/// Past this the first batch goes even with an expression column that has
/// had only NULLs, which then stays untyped.
const FIRST_BATCH_BYTES: usize = 16 * BATCH_BYTES;

/// Whether every untyped column has a non-null value in `rows` for
/// [`name_untyped`] to name it by.
fn all_typed(columns: &[Column], rows: &[Vec<Value>]) -> bool {
    columns.iter().enumerate().all(|(i, column)| {
        !column.type_name.is_empty()
            || rows
                .iter()
                .any(|row| !matches!(row.get(i), None | Some(Value::Null)))
    })
}

/// Names each untyped column by the storage class of its first non-null
/// value in `rows` (`integer`, `real`, `text`, `blob`, as `typeof()` says),
/// the way SQLite itself types an expression's value. A column with only
/// NULLs (or no rows) stays `""`. Runs once, on the first batch.
fn name_untyped(columns: &mut [Column], rows: &[Vec<Value>]) {
    for (i, column) in columns.iter_mut().enumerate() {
        if !column.type_name.is_empty() {
            continue;
        }
        let class = rows.iter().find_map(|row| match row.get(i) {
            Some(Value::Int(_)) => Some("integer"),
            Some(Value::Float(_)) => Some("real"),
            Some(Value::Text(_)) => Some("text"),
            Some(Value::Bytes(_)) => Some("blob"),
            _ => None,
        });
        if let Some(class) = class {
            column.type_name = class.into();
        }
    }
}

pub fn sqlite_value_to_core(value: ValueRef) -> Value {
    match value {
        ValueRef::Null => Value::Null,
        ValueRef::Integer(i) => Value::Int(i),
        ValueRef::Real(f) => Value::Float(f),
        ValueRef::Text(s) => Value::Text(String::from_utf8_lossy(s).into_owned()),
        ValueRef::Blob(b) => Value::Bytes(b.to_vec()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use rusqlite::Connection;
    use tempfile::NamedTempFile;

    fn temp_db() -> (NamedTempFile, String) {
        let file = NamedTempFile::new().expect("temp file");
        let path = file.path().to_string_lossy().to_string();
        let conn = Connection::open(file.path()).expect("open");
        conn.execute_batch(
            "CREATE TABLE items (id INTEGER PRIMARY KEY, name TEXT, qty INTEGER);
             INSERT INTO items (name, qty) VALUES ('alpha', 1), ('beta', 2);",
        )
        .expect("schema");
        (file, path)
    }

    #[test]
    fn connect_and_query_rows() {
        let (_file, path) = temp_db();
        let mut driver = SqliteDriver::new(path);
        driver.connect().expect("connect");
        let mut batches = Vec::new();
        let count = driver
            .query_stream("SELECT id, name, qty FROM items ORDER BY id", |batch, _| {
                batches.push(batch);
                Ok(())
            })
            .expect("query");
        assert_eq!(count, 2);
        assert_eq!(batches.len(), 1);
        assert_eq!(batches[0].rows.len(), 2);
        assert_eq!(batches[0].rows[0][1], Value::Text("alpha".into()));
    }

    #[test]
    fn big_cells_send_a_batch_before_its_row_count() {
        let (_file, path) = temp_db();
        let mut driver = SqliteDriver::new(path);
        driver.connect().expect("connect");
        let mut sizes = Vec::new();
        driver
            .query_stream(
                "WITH RECURSIVE c(x) AS (SELECT 1 UNION ALL SELECT x + 1 FROM c WHERE x < 10)
                 SELECT x, zeroblob(600000) FROM c",
                |batch, _| {
                    sizes.push(batch.rows.len());
                    Ok(())
                },
            )
            .expect("query");
        assert_eq!(sizes, vec![2, 2, 2, 2, 2]);
    }

    #[test]
    fn a_first_batch_of_big_cells_waits_to_type_its_columns() {
        let (_file, path) = temp_db();
        let mut driver = SqliteDriver::new(path);
        driver.connect().expect("connect");
        let (mut sizes, mut types) = (Vec::new(), Vec::new());
        driver
            .query_stream(
                "WITH RECURSIVE c(x) AS (SELECT 1 UNION ALL SELECT x + 1 FROM c WHERE x < 10)
                 SELECT CASE WHEN x < 4 THEN NULL ELSE x END AS late, zeroblob(600000) FROM c",
                |batch, first| {
                    if first {
                        types = batch.columns.iter().map(|c| c.type_name.clone()).collect();
                    }
                    sizes.push(batch.rows.len());
                    Ok(())
                },
            )
            .expect("query");
        assert_eq!(types, vec!["integer", "blob"]);
        assert_eq!(sizes, vec![4, 2, 2, 2]);
    }

    #[test]
    fn query_page_reads_one_page_at_a_time() {
        let (_file, path) = temp_db();
        let mut driver = SqliteDriver::new(path);
        driver.connect().expect("connect");
        driver
            .query_stream(
                "WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 498) \
                 INSERT INTO items (name, qty) SELECT 'n' || i, i FROM n",
                |_, _| Ok(()),
            )
            .expect("fill");
        let total: u64 = 2 + 498;
        let sql = "SELECT id FROM items ORDER BY id";
        let read = |driver: &mut SqliteDriver, skip: u64, take: u32| {
            let mut ids = Vec::new();
            let (rows, more) = driver
                .query_page(sql, skip, take, |batch, _| {
                    ids.extend(batch.rows.into_iter().map(|r| r[0].clone()));
                    Ok(())
                })
                .expect("page");
            assert_eq!(rows as usize, ids.len());
            (ids, more)
        };
        let (first, more) = read(&mut driver, 0, 300);
        assert_eq!(first.len(), 300);
        assert!(more);
        assert_eq!(first[0], Value::Int(1));
        let (second, more) = read(&mut driver, 300, 300);
        assert_eq!(second.len() as u64, total - 300);
        assert!(!more, "the last page says so");
        assert_eq!(second[0], Value::Int(301));
        // A page that ends exactly at the last row has nothing left.
        let (_, more) = read(&mut driver, 0, total as u32);
        assert!(!more);
        // 0 reads the rest.
        let (rest, more) = read(&mut driver, 450, 0);
        assert_eq!(rest.len(), 50);
        assert!(!more);
    }

    #[test]
    fn zero_rows_keep_their_columns() {
        let (_file, path) = temp_db();
        let mut driver = SqliteDriver::new(path);
        driver.connect().expect("connect");
        let mut batches = Vec::new();
        let count = driver
            .query_stream("SELECT id, name FROM items WHERE 0", |batch, first| {
                assert!(first);
                batches.push(batch);
                Ok(())
            })
            .expect("query");
        assert_eq!(count, 0);
        assert_eq!(batches.len(), 1);
        let names: Vec<_> = batches[0].columns.iter().map(|c| c.name.as_str()).collect();
        assert_eq!(names, ["id", "name"]);
        assert!(batches[0].rows.is_empty());
    }

    #[test]
    fn read_only_refuses_writes_the_check_would_miss() {
        let (_file, path) = temp_db();
        let mut driver = SqliteDriver::new(path).read_only(true);
        driver.connect().expect("connect");
        let err = driver
            .query_stream("INSERT INTO items (name, qty) VALUES ('x', 1)", |_, _| {
                Ok(())
            })
            .expect_err("read-only");
        assert!(err.to_string().contains("readonly"), "{err}");
        let count = driver
            .query_stream("SELECT * FROM items", |_, _| Ok(()))
            .expect("reads still run");
        assert_eq!(count, 2);
    }

    #[test]
    fn a_write_a_crash_left_unfinished_is_named_on_a_read_only_open() {
        // What a read-only open's first read gets from a hot journal, which
        // only a read-write open can roll back.
        let hot = rusqlite::Error::SqliteFailure(
            rusqlite::ffi::Error::new(rusqlite::ffi::SQLITE_READONLY_ROLLBACK),
            None,
        );
        assert_eq!(map_query_error(hot).into_message(), SQLITE_UNFINISHED_WRITE);
    }

    #[test]
    fn a_read_only_file_refuses_writes_with_the_pragma_off() {
        let (_file, path) = temp_db();
        // A WAL database: the read-only open makes its -wal and -shm files
        // (the directory is writable) but writes nothing else.
        {
            let conn = Connection::open(&path).unwrap();
            conn.pragma_update(None, "journal_mode", "wal").unwrap();
        }
        let mut driver = SqliteDriver::new(path).read_only_file();
        driver.connect().expect("connect");
        driver
            .query_stream("PRAGMA query_only = 0", |_, _| Ok(()))
            .expect("pragma");
        let err = driver
            .query_stream("DELETE FROM items", |_, _| Ok(()))
            .expect_err("read-only file");
        assert!(err.to_string().contains("readonly"), "{err}");
        let count = driver
            .query_stream("SELECT * FROM items", |_, _| Ok(()))
            .expect("reads still run");
        assert_eq!(count, 2);
    }

    #[test]
    fn update_returns_rows_affected() {
        let (_file, path) = temp_db();
        let mut driver = SqliteDriver::new(path);
        driver.connect().expect("connect");
        let affected = driver
            .query_stream(
                "UPDATE items SET qty = 9 WHERE name = 'alpha'",
                |_batch, _| Ok(()),
            )
            .expect("update");
        assert_eq!(affected, 1);
    }

    #[test]
    fn missing_file_errors() {
        let mut driver = SqliteDriver::new("/no/such/file.db");
        let err = driver.connect().unwrap_err();
        assert!(err.to_string().contains("not found"));
    }

    #[test]
    fn introspect_catalog_includes_tables() {
        let (_file, path) = temp_db();
        let mut driver = SqliteDriver::new(path);
        driver.connect().expect("connect");
        let catalog = driver.introspect_catalog().expect("introspect");
        let table = catalog
            .find_table("main", "main", "items")
            .expect("items table");
        assert_eq!(table.columns.len(), 3);
        assert_eq!(table.primary_key, vec!["id".to_string()]);
        // Rows are counted afterwards, off the first paint.
        assert_eq!(table.row_estimate, RowEstimate::Unknown);
        let counts = driver.table_counts().expect("counts");
        assert!(counts.contains(&TableCount {
            database: "main".into(),
            table: "items".into(),
            rows: RowEstimate::Exact(2),
        }));
        assert_eq!(table.kind, TableKind::Table);
    }

    #[test]
    fn introspect_catalog_includes_views() {
        let (file, path) = temp_db();
        Connection::open(file.path())
            .expect("open")
            .execute_batch("CREATE VIEW big_items AS SELECT id, name FROM items WHERE qty > 1;")
            .expect("view");
        let mut driver = SqliteDriver::new(path);
        driver.connect().expect("connect");
        let catalog = driver.introspect_catalog().expect("introspect");
        let view = catalog
            .find_table("main", "main", "big_items")
            .expect("big_items view");
        assert_eq!(view.kind, TableKind::View);
        let names: Vec<_> = view.columns.iter().map(|c| c.name.as_str()).collect();
        assert_eq!(names, vec!["id", "name"]);
        assert_eq!(view.row_estimate, RowEstimate::Unknown);
    }

    #[test]
    fn a_broken_view_does_not_fail_the_catalog() {
        let (file, path) = temp_db();
        Connection::open(file.path())
            .expect("open")
            .execute_batch(
                "CREATE TABLE gone (id INTEGER);
                 CREATE VIEW orphan AS SELECT id FROM gone;
                 CREATE VIEW fine AS SELECT name FROM items;
                 DROP TABLE gone;",
            )
            .expect("schema");
        let mut driver = SqliteDriver::new(path);
        driver.connect().expect("connect");
        let catalog = driver.introspect_catalog().expect("introspect");
        let orphan = catalog
            .find_table("main", "main", "orphan")
            .expect("listed");
        assert!(orphan.columns.is_empty(), "it can't be read");
        let fine = catalog.find_table("main", "main", "fine").expect("fine");
        assert_eq!(fine.columns.len(), 1);
        let items = catalog.find_table("main", "main", "items").expect("items");
        assert_eq!(items.primary_key, vec!["id".to_string()]);
    }

    #[test]
    fn tables_named_like_sqlite_are_listed() {
        let (file, path) = temp_db();
        Connection::open(file.path())
            .expect("open")
            .execute_batch(
                "CREATE TABLE SqliteLogs (id INTEGER PRIMARY KEY AUTOINCREMENT, line TEXT);
                 CREATE INDEX sqlitelogs_line ON SqliteLogs(line);
                 INSERT INTO SqliteLogs (line) VALUES ('a');",
            )
            .expect("schema");
        let mut driver = SqliteDriver::new(path);
        driver.connect().expect("connect");
        let catalog = driver.introspect_catalog().expect("introspect");
        let logs = catalog
            .find_table("main", "main", "SqliteLogs")
            .expect("listed");
        assert_eq!(logs.columns.len(), 2);
        assert_eq!(logs.indexes.len(), 1);
        // SQLite's own table (AUTOINCREMENT made it) stays hidden.
        assert!(catalog
            .find_table("main", "main", "sqlite_sequence")
            .is_none());
        let counts = driver.table_counts().expect("counts");
        assert!(counts.iter().any(|c| c.table == "SqliteLogs"));
        assert!(counts.iter().all(|c| c.table != "sqlite_sequence"));
    }

    /// Only a plain SQL error lets the catalog read relations one at a time;
    /// a lock (or an interrupt, I/O, corruption) fails it.
    #[test]
    fn only_a_plain_sql_error_is_a_broken_relation() {
        let (file, _path) = temp_db();
        let conn = Connection::open(file.path()).expect("open");
        let missing = conn.prepare("SELECT * FROM nope").map(|_| ()).unwrap_err();
        assert!(plain_sql_error(&missing), "{missing:?}");
        let holder = Connection::open(file.path()).expect("open");
        holder.execute_batch("BEGIN EXCLUSIVE").expect("lock");
        conn.busy_timeout(std::time::Duration::ZERO)
            .expect("timeout");
        let locked = conn
            .query_row("SELECT count(*) FROM items", [], |_| Ok(()))
            .unwrap_err();
        assert!(!plain_sql_error(&locked), "{locked:?}");
        assert_eq!(map_query_error(locked).into_message(), SQLITE_LOCKED);
    }

    /// A kept connection: a transaction carries across runs, safe mode
    /// changes reach it, and a file replaced under it is noticed.
    #[test]
    fn a_kept_connection_holds_its_transaction() {
        let (file, path) = temp_db();
        let mut driver = SqliteDriver::new(path.clone());
        driver.connect().expect("connect");
        let run = |driver: &mut SqliteDriver, sql: &str| driver.query_stream(sql, |_, _| Ok(()));
        run(&mut driver, "BEGIN").expect("begin");
        assert!(driver.in_transaction());
        run(&mut driver, "DELETE FROM items").expect("delete");
        run(&mut driver, "ROLLBACK").expect("rollback");
        assert!(!driver.in_transaction());
        assert_eq!(run(&mut driver, "SELECT * FROM items").unwrap(), 2);

        driver.set_read_only(true).expect("read-only");
        assert!(run(&mut driver, "DELETE FROM items").is_err());
        // A run that switches the backstop off gets it back on its next run.
        run(&mut driver, "PRAGMA \"query_only\"(0)").expect("pragma");
        driver.set_read_only(true).expect("still read-only");
        assert!(run(&mut driver, "DELETE FROM items").is_err());
        driver.set_read_only(false).expect("writable");
        assert_eq!(
            run(&mut driver, "DELETE FROM items WHERE qty = 1").unwrap(),
            1
        );

        assert!(!driver.file_replaced());
        let fresh = NamedTempFile::new().expect("temp file");
        std::fs::rename(fresh.path(), file.path()).expect("replace");
        assert!(driver.file_replaced());
        drop(file);
        let _ = path;
    }

    #[test]
    fn a_lone_integer_primary_key_fills_itself_like_a_default() {
        let (file, path) = temp_db();
        Connection::open(file.path())
            .expect("open")
            .execute_batch(
                "CREATE TABLE notes (id INTEGER PRIMARY KEY, body TEXT NOT NULL);
                 CREATE TABLE codes (id INT PRIMARY KEY, label TEXT);
                 CREATE TABLE pairs (a INTEGER, b INTEGER, PRIMARY KEY (a, b));
                 CREATE TABLE keyed (id INTEGER PRIMARY KEY, v TEXT) WITHOUT ROWID;
                 CREATE TABLE stamped (id INTEGER PRIMARY KEY DEFAULT 7);",
            )
            .expect("schema");
        let mut driver = SqliteDriver::new(path);
        driver.connect().expect("connect");
        let catalog = driver.introspect_catalog().expect("introspect");
        let default_of = |table: &str, column: &str| {
            let t = catalog.find_table("main", "main", table).expect("table");
            t.columns
                .iter()
                .find(|c| c.name == column)
                .expect("column")
                .default
                .clone()
        };
        // The rowid: ⌘I starts on the next column.
        assert_eq!(default_of("notes", "id").as_deref(), Some("rowid"));
        assert_eq!(default_of("notes", "body"), None);
        // INT (not INTEGER), a two-column key and WITHOUT ROWID are plain columns.
        assert_eq!(default_of("codes", "id"), None);
        assert_eq!(default_of("pairs", "a"), None);
        assert_eq!(default_of("keyed", "id"), None);
        // A declared default stays as it is.
        assert_eq!(default_of("stamped", "id").as_deref(), Some("7"));
    }

    #[test]
    fn results_carry_declared_types_and_expressions_their_value_class() {
        let (file, path) = temp_db();
        Connection::open(file.path())
            .expect("open")
            .execute_batch(
                "CREATE TABLE typed (id integer PRIMARY KEY, name VARCHAR(20), price REAL,
                     born DATETIME, raw BLOB, loose);
                 INSERT INTO typed (name, price, born, raw, loose)
                     VALUES ('a', 1.5, '2026-01-02', x'00', 7);",
            )
            .expect("schema");
        let mut driver = SqliteDriver::new(path);
        driver.connect().expect("connect");
        let types_of = |driver: &mut SqliteDriver, sql: &str| {
            let mut types = Vec::new();
            driver
                .query_stream(sql, |batch, first| {
                    if first {
                        types = batch.columns.iter().map(|c| c.type_name.clone()).collect();
                    }
                    Ok(())
                })
                .expect("query");
            types
        };
        // Table columns: the declared type (SQLite spells a rowid key INTEGER),
        // like Postgres names its columns.
        assert_eq!(
            types_of(&mut driver, "SELECT * FROM typed"),
            [
                "INTEGER",
                "VARCHAR(20)",
                "REAL",
                "DATETIME",
                "BLOB",
                "integer"
            ]
        );
        // Expressions (and the untyped `loose`) go by their value's storage
        // class; a column of only NULLs says nothing.
        assert_eq!(
            types_of(
                &mut driver,
                "SELECT id + 1 AS next, name || '!' AS shout, price * 2 AS twice,
                        zeroblob(2) AS bytes, NULL AS empty, loose FROM typed"
            ),
            ["integer", "text", "real", "blob", "", "integer"]
        );
        // No rows: the declared types still come through, expressions stay untyped.
        assert_eq!(
            types_of(&mut driver, "SELECT id, id * 2 AS d FROM typed WHERE 0"),
            ["INTEGER", ""]
        );
        // Every batch of a long result carries the same types.
        let mut seen = Vec::new();
        driver
            .query_stream(
                "WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 450)
                 SELECT i, i * 0.5 AS half FROM n",
                |batch, _| {
                    seen.push(
                        batch
                            .columns
                            .iter()
                            .map(|c| c.type_name.clone())
                            .collect::<Vec<_>>(),
                    );
                    Ok(())
                },
            )
            .expect("query");
        assert!(seen.len() > 1, "{} batches", seen.len());
        assert!(seen.iter().all(|t| t == &["integer", "real"]), "{seen:?}");
    }

    #[test]
    fn a_rowid_primary_key_is_never_null() {
        let (file, path) = temp_db();
        Connection::open(file.path())
            .expect("open")
            .execute_batch(
                "CREATE TABLE notes (id INTEGER PRIMARY KEY, body TEXT);
                 CREATE TABLE later (body TEXT, id integer, PRIMARY KEY (id));
                 CREATE TABLE codes (id INT PRIMARY KEY, label TEXT);
                 CREATE TABLE stamped (id INTEGER PRIMARY KEY DEFAULT 7);
                 INSERT INTO notes (id, body) VALUES (NULL, 'first');
                 INSERT INTO notes (body) VALUES ('second');",
            )
            .expect("schema");
        let mut driver = SqliteDriver::new(path);
        driver.connect().expect("connect");
        let catalog = driver.introspect_catalog().expect("introspect");
        let nullable = |table: &str, column: &str| {
            let t = catalog.find_table("main", "main", table).expect("table");
            t.columns
                .iter()
                .find(|c| c.name == column)
                .expect("column")
                .nullable
        };
        // The rowid alias, however the key is written, can't be NULL.
        assert!(!nullable("notes", "id"));
        assert!(!nullable("later", "id"));
        assert!(!nullable("stamped", "id"));
        assert!(nullable("notes", "body"));
        // INT PRIMARY KEY is a plain column: SQLite lets it hold NULL.
        assert!(nullable("codes", "id"));
        // An id inserted as NULL (or left out) reads back as the number it got.
        let mut ids = Vec::new();
        driver
            .query_stream("SELECT id FROM notes ORDER BY id", |batch, _| {
                ids.extend(batch.rows.into_iter().map(|r| r[0].clone()));
                Ok(())
            })
            .expect("query");
        assert_eq!(ids, [Value::Int(1), Value::Int(2)]);
    }

    #[test]
    fn introspect_reads_indexes_keys_and_foreign_keys() {
        let (file, path) = temp_db();
        Connection::open(file.path())
            .expect("open")
            .execute_batch(
                "CREATE TABLE seats (hall TEXT NOT NULL, no INTEGER NOT NULL, label TEXT DEFAULT 'free',
                     PRIMARY KEY (no, hall));
                 CREATE UNIQUE INDEX seats_label ON seats(label);
                 CREATE INDEX seats_lower ON seats(lower(label), no);
                 CREATE TABLE tickets (id INTEGER PRIMARY KEY, hall TEXT, no INTEGER,
                     FOREIGN KEY (no, hall) REFERENCES seats(no, hall) ON DELETE CASCADE);",
            )
            .expect("schema");
        let mut driver = SqliteDriver::new(path);
        driver.connect().expect("connect");
        let catalog = driver.introspect_catalog().expect("introspect");
        let seats = catalog.find_table("main", "main", "seats").expect("seats");
        assert_eq!(seats.primary_key, vec!["no", "hall"]);
        let cols: Vec<_> = seats
            .columns
            .iter()
            .map(|c| (c.name.as_str(), c.nullable, c.default.as_deref()))
            .collect();
        assert_eq!(
            cols,
            vec![
                ("hall", false, None),
                ("no", false, None),
                ("label", true, Some("'free'"))
            ]
        );
        let mut idx: Vec<_> = seats
            .indexes
            .iter()
            .map(|i| (i.name.as_str(), i.columns.join(","), i.unique, i.primary))
            .collect();
        idx.sort();
        assert_eq!(
            idx,
            vec![
                ("seats_label", "label".to_string(), true, false),
                ("seats_lower", "(expression),no".to_string(), false, false),
                (
                    "sqlite_autoindex_seats_1",
                    "no,hall".to_string(),
                    true,
                    true
                ),
            ]
        );
        let tickets = catalog
            .find_table("main", "main", "tickets")
            .expect("tickets");
        assert_eq!(tickets.foreign_keys.len(), 1);
        let fk = &tickets.foreign_keys[0];
        assert_eq!(
            (
                fk.columns.clone(),
                fk.ref_table.as_str(),
                fk.ref_columns.clone(),
                fk.on_delete.as_str()
            ),
            (
                vec!["no".to_string(), "hall".to_string()],
                "seats",
                vec!["no".to_string(), "hall".to_string()],
                "CASCADE"
            )
        );
    }
}
