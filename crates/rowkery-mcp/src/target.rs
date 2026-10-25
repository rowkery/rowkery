//! Reaching a shared connection: read-only sessions, the schema catalog
//! cache, and running a capped read on Postgres or SQLite.

use std::collections::{HashMap, HashSet};
use std::time::{Duration, Instant};

use rowkery_core::config::AppConfig;
use rowkery_core::connections::{ConnectionRecord, PostgresConnection};
use rowkery_core::db::postgres::{
    cancel_with_token, open_session, session_activity, session_execute, session_introspect,
    session_list_databases, session_ping, session_query_stream, session_table_indexes,
    PostgresSession, ServerSession,
};
use rowkery_core::db::sqlite::SqliteDriver;
use rowkery_core::db::{Column, Driver, DriverError, SchemaCatalog, Value};
use rowkery_core::safety::SafeMode;

use crate::guard::STATEMENT_TIMEOUT;

/// Longest any one call waits on the database, connecting included.
const CALL_TIMEOUT: Duration = Duration::from_secs(20);

/// A shared connection with the database a call asked for.
pub struct Target {
    pub record: ConnectionRecord,
    /// Postgres database; the file name for SQLite.
    pub database: String,
}

impl Target {
    pub fn id(&self) -> &str {
        self.record.id()
    }

    fn key(&self) -> (String, String) {
        (self.id().to_string(), self.database.clone())
    }
}

/// What the client wrote for "connection", matched by id or name.
pub fn resolve(
    config: &AppConfig,
    connection: &str,
    database: Option<&str>,
) -> Result<Target, String> {
    let wanted = connection.trim();
    let record = config
        .connections
        .iter()
        .find(|c| c.id() == wanted)
        .or_else(|| {
            config
                .connections
                .iter()
                .find(|c| c.display_name().eq_ignore_ascii_case(wanted))
        })
        .filter(|c| c.allow_mcp())
        .cloned()
        .ok_or_else(|| {
            format!(
                "No shared connection called \"{wanted}\". list_connections shows the ones \
                 shared; the user shares one in Rowkery, under Settings › Agents."
            )
        })?;
    let asked = database.map(str::trim).filter(|d| !d.is_empty());
    let database = match (&record, asked) {
        (ConnectionRecord::Postgres(_), Some(d)) => d.to_string(),
        _ => crate::access::default_database(&record)
            .ok_or_else(|| "No database on this connection is shared yet.".to_string())?,
    };
    // An unshared database reads as one that doesn't exist.
    if crate::access::tables(&record, &database).is_none() {
        return Err(format!("No database called \"{database}\"."));
    }
    Ok(Target { record, database })
}

/// Any saved connection by id, shared or not: the Agents page's picker
/// lists what could be shared before it is.
pub fn any(config: &AppConfig, id: &str, database: Option<&str>) -> Result<Target, String> {
    let record = config
        .connections
        .iter()
        .find(|c| c.id() == id)
        .cloned()
        .ok_or_else(|| "That connection was deleted.".to_string())?;
    let database = match &record {
        ConnectionRecord::Postgres(pg) => database.unwrap_or(&pg.database).to_string(),
        ConnectionRecord::Sqlite(_) => "main".to_string(),
    };
    Ok(Target { record, database })
}

pub struct CachedCatalog {
    pub catalog: SchemaCatalog,
    pub loaded: Instant,
}

/// Rows of one read, all kept.
pub struct ReadResult {
    pub rows: Vec<Vec<Value>>,
}

/// What a read gave besides what its `each` kept.
pub struct Read<S> {
    pub columns: Vec<Column>,
    pub state: S,
    pub elapsed_ms: u64,
}

/// How long a stopped Postgres read may take to read off the rows it left on
/// the wire, checked with an empty round trip. Past this the statement is
/// cancelled and the session dropped instead.
const DRAIN_WAIT: Duration = Duration::from_millis(500);

/// How long a cancel request may take before the session is dropped anyway.
const CANCEL_WAIT: Duration = Duration::from_secs(1);

#[derive(Default)]
pub struct Store {
    sessions: HashMap<(String, String), PostgresSession>,
    catalogs: HashMap<(String, String), CachedCatalog>,
    /// The session a call holds one transaction open on (`begin`).
    open: Option<(String, String)>,
    /// Sessions a `begin` opened a transaction on and no `end` has rolled
    /// back yet.
    left_open: HashSet<(String, String)>,
    /// A session handed in with its transaction already open (`on_session`),
    /// kept as it came.
    adopted: Option<(String, String)>,
}

fn message(err: DriverError) -> String {
    match err {
        DriverError::Cancelled => format!(
            "Stopped after {} s (statement timeout). Filter on an indexed column or aggregate less.",
            STATEMENT_TIMEOUT.as_secs()
        ),
        other => other.to_string(),
    }
}

/// Opens the file read-only, with `PRAGMA query_only` on top.
fn open_sqlite(path: &str) -> Result<SqliteDriver, String> {
    let mut driver = SqliteDriver::new(path).read_only_file();
    driver.connect().map_err(message)?;
    Ok(driver)
}

/// Runs `sql` on a read-only SQLite connection, interrupted after the timeout,
/// handing each row to `each` until it wants no more.
fn sqlite_read<S, F>(path: &str, sql: &str, mut state: S, mut each: F) -> Result<Read<S>, String>
where
    F: FnMut(&mut S, Vec<Value>) -> bool,
{
    let mut driver = open_sqlite(path)?;
    let interrupt = driver.take_interrupt_handle();
    let (done_tx, done_rx) = std::sync::mpsc::channel::<()>();
    let watchdog = std::thread::spawn(move || {
        if done_rx.recv_timeout(STATEMENT_TIMEOUT).is_err() {
            if let Some(handle) = interrupt {
                handle.interrupt();
            }
        }
    });
    let started = Instant::now();
    let mut columns = Vec::new();
    let mut stopped = false;
    let result = driver.query_stream(sql, |batch, first| {
        if first {
            columns = batch.columns;
        }
        for row in batch.rows {
            if !each(&mut state, row) {
                stopped = true;
                return Err(DriverError::Message(String::new()));
            }
        }
        Ok(())
    });
    let _ = done_tx.send(());
    let _ = watchdog.join();
    if !stopped {
        result.map_err(message)?;
    }
    Ok(Read {
        columns,
        state,
        elapsed_ms: started.elapsed().as_millis() as u64,
    })
}

impl Store {
    /// A read-only session on the target's database, opened once and reused.
    /// The guards are set again before every statement, so a `set_config` in
    /// an earlier SELECT can't loosen them.
    async fn session(&mut self, target: &Target) -> Result<&PostgresSession, String> {
        self.session_then(target, "").await
    }

    /// [`Self::session`], running `then` after the guards in the same trip.
    async fn session_then(
        &mut self,
        target: &Target,
        then: &str,
    ) -> Result<&PostgresSession, String> {
        let ConnectionRecord::Postgres(pg) = &target.record else {
            return Err("not a Postgres connection".into());
        };
        let key = target.key();
        if self.adopted.as_ref() == Some(&key) {
            debug_assert!(
                then.is_empty(),
                "an adopted session's owner runs its own statements"
            );
            return self
                .sessions
                .get(&key)
                .ok_or_else(|| "The connection closed.".to_string());
        }
        if self
            .sessions
            .get(&key)
            .is_some_and(|s| s.is_closed() || s.config() != &read_only(pg, &target.database))
        {
            self.sessions.remove(&key);
        }
        // A fresh session mid-call would run the rest outside the call's
        // transaction, planned at another moment.
        if self.open.as_ref() == Some(&key) && !self.sessions.contains_key(&key) {
            self.open = None;
            return Err("The connection closed during the call.".into());
        }
        if !self.sessions.contains_key(&key) {
            let config = read_only(pg, &target.database);
            let session = tokio::time::timeout(CALL_TIMEOUT, open_session(pg.id.clone(), config))
                .await
                .map_err(|_| "Timed out connecting.".to_string())?
                .map_err(message)?;
            self.sessions.insert(key.clone(), session);
            self.left_open.remove(&key);
        }
        // Outside a call's transaction, one a call that stopped early left
        // open is rolled back first.
        let close = if self.open.as_ref() != Some(&key) && self.left_open.contains(&key) {
            "ROLLBACK; "
        } else {
            ""
        };
        let session = self.sessions.get(&key).expect("session");
        session_execute(
            session,
            &format!(
                "{close}SET default_transaction_read_only = on; SET statement_timeout = '{}s'{then}",
                STATEMENT_TIMEOUT.as_secs()
            ),
        )
        .await
        .map_err(message)?;
        Ok(session)
    }

    /// Opens one read-only transaction on Postgres for every statement up to
    /// [`Self::end`]: a check's `EXPLAIN` and the run it allows then plan
    /// against the same moment, since `'now'` and `'today'` are the
    /// transaction's start and are folded into the plan. Planned apart, the
    /// same SQL can read a partition or table in the run that the checked
    /// plan left out.
    pub async fn begin(&mut self, target: &Target) -> Result<(), String> {
        if !matches!(target.record, ConnectionRecord::Postgres(_)) {
            return Ok(());
        }
        self.open = None;
        self.session_then(target, "; BEGIN READ ONLY").await?;
        self.left_open.insert(target.key());
        self.open = Some(target.key());
        Ok(())
    }

    /// Starts a call outside any transaction an earlier call didn't end, so
    /// its first statement rolls that one back.
    pub fn settle(&mut self) {
        self.open = None;
    }

    /// Rolls back what [`Self::begin`] opened, or drops a session that
    /// can't, so the next call starts clean.
    pub async fn end(&mut self, target: &Target) {
        let key = target.key();
        if self.open.as_ref() != Some(&key) {
            return;
        }
        self.open = None;
        let rolled_back = match self.sessions.get(&key) {
            Some(session) => session_execute(session, "ROLLBACK").await.is_ok(),
            None => true,
        };
        self.left_open.remove(&key);
        if !rolled_back {
            self.sessions.remove(&key);
        }
    }

    /// A store whose statements on `target` run on `session`, inside the
    /// transaction its owner opened (a commit checks a change in the one
    /// that runs it). [`Self::into_session`] hands it back.
    pub fn on_session(target: &Target, session: PostgresSession) -> Self {
        let mut store = Self::default();
        store.sessions.insert(target.key(), session);
        store.adopted = Some(target.key());
        store
    }

    /// The session given to [`Self::on_session`].
    pub fn into_session(mut self, target: &Target) -> Option<PostgresSession> {
        self.sessions.remove(&target.key())
    }

    /// Drops whatever this process holds for connections no longer shared.
    pub fn forget_unshared(&mut self, config: &AppConfig) {
        let shared: Vec<&str> = config
            .connections
            .iter()
            .filter(|c| c.allow_mcp())
            .map(|c| c.id())
            .collect();
        self.sessions
            .retain(|(id, _), _| shared.contains(&id.as_str()));
        self.catalogs
            .retain(|(id, _), _| shared.contains(&id.as_str()));
    }

    pub async fn list_databases(
        &mut self,
        target: &Target,
    ) -> Result<Vec<(String, Option<i64>)>, String> {
        match &target.record {
            ConnectionRecord::Sqlite(_) => Ok(vec![("main".into(), None)]),
            ConnectionRecord::Postgres(_) => {
                let session = self.session(target).await?;
                let list = tokio::time::timeout(CALL_TIMEOUT, session_list_databases(session))
                    .await
                    .map_err(|_| "Timed out.".to_string())?
                    .map_err(message)?;
                Ok(list.into_iter().map(|d| (d.name, d.size_bytes)).collect())
            }
        }
    }

    /// The target's catalog, from this process's cache unless `refresh`.
    pub async fn catalog(
        &mut self,
        target: &Target,
        refresh: bool,
    ) -> Result<&CachedCatalog, String> {
        let key = target.key();
        if refresh || !self.catalogs.contains_key(&key) {
            let catalog = match &target.record {
                ConnectionRecord::Sqlite(sqlite) => {
                    let mut driver = open_sqlite(&sqlite.path)?;
                    driver.introspect_catalog().map_err(message)?
                }
                ConnectionRecord::Postgres(_) => {
                    let session = self.session(target).await?;
                    tokio::time::timeout(CALL_TIMEOUT, session_introspect(session))
                        .await
                        .map_err(|_| "Timed out reading the schema.".to_string())?
                        .map_err(message)?
                }
            };
            self.catalogs.insert(
                key.clone(),
                CachedCatalog {
                    catalog,
                    loaded: Instant::now(),
                },
            );
        }
        Ok(self.catalogs.get(&key).expect("catalog"))
    }

    /// The other client sessions on the target's database.
    pub async fn activity(&mut self, target: &Target) -> Result<Vec<ServerSession>, String> {
        if !matches!(target.record, ConnectionRecord::Postgres(_)) {
            return Err(
                "SQLite has no other sessions to show; sessions is for Postgres connections."
                    .into(),
            );
        }
        let session = self.session(target).await?;
        tokio::time::timeout(CALL_TIMEOUT, session_activity(session))
            .await
            .map_err(|_| "Timed out.".to_string())?
            .map_err(message)
    }

    /// Fills in a Postgres table's indexes, which the catalog load leaves out.
    pub async fn load_indexes(
        &mut self,
        target: &Target,
        schema: &str,
        table: &str,
    ) -> Result<(), String> {
        let key = target.key();
        let deferred = self
            .catalogs
            .get(&key)
            .and_then(|c| c.catalog.find_table(&target.database, schema, table))
            .is_some_and(|t| t.indexes_deferred);
        if !deferred {
            return Ok(());
        }
        let session = self.session(target).await?;
        let fetched = tokio::time::timeout(
            CALL_TIMEOUT,
            session_table_indexes(session, schema, &[table.to_string()]),
        )
        .await
        .map_err(|_| "Timed out reading indexes.".to_string())?
        .map_err(message)?;
        if let Some(cached) = self.catalogs.get_mut(&key) {
            for db in &mut cached.catalog.databases {
                for s in db.schemas.iter_mut().filter(|s| s.name == schema) {
                    for t in s.tables.iter_mut().filter(|t| t.name == table) {
                        if let Some(found) = fetched.iter().find(|f| f.table == table) {
                            t.indexes = found.indexes.clone();
                            t.index_bytes = found.index_bytes;
                        }
                        t.indexes_deferred = false;
                    }
                }
            }
        }
        Ok(())
    }

    /// Runs one read (already checked and capped) with the session guards on.
    pub async fn read(&mut self, target: &Target, sql: &str) -> Result<ReadResult, String> {
        let read = self
            .read_each(target, sql, usize::MAX, Vec::new(), |rows, row| {
                rows.push(row);
                true
            })
            .await?;
        Ok(ReadResult { rows: read.state })
    }

    /// `read`, handing each row to `each` as it arrives instead of keeping
    /// them all; the read stops at the first row `each` turns down. `limit`
    /// is the most rows `sql` returns: after a stop short of it, a Postgres
    /// session that can't read off the rest within [`DRAIN_WAIT`] has its
    /// statement cancelled and is dropped.
    pub async fn read_each<S, F>(
        &mut self,
        target: &Target,
        sql: &str,
        limit: usize,
        mut state: S,
        mut each: F,
    ) -> Result<Read<S>, String>
    where
        S: Send + 'static,
        F: FnMut(&mut S, Vec<Value>) -> bool + Send + 'static,
    {
        match &target.record {
            ConnectionRecord::Sqlite(sqlite) => {
                let path = sqlite.path.clone();
                let sql = sql.to_string();
                tokio::task::spawn_blocking(move || sqlite_read(&path, &sql, state, each))
                    .await
                    .map_err(|e| e.to_string())?
            }
            ConnectionRecord::Postgres(_) => {
                let key = target.key();
                let session = self.session(target).await?;
                let cancel = (session.cancel_token.clone(), session.cancel_via.clone());
                let started = Instant::now();
                let mut columns = Vec::new();
                let (mut seen, mut stopped) = (0usize, false);
                let run = session_query_stream(session, sql, |batch, first| {
                    if first {
                        columns = batch.columns;
                    }
                    for row in batch.rows {
                        seen += 1;
                        if !each(&mut state, row) {
                            stopped = true;
                            return Err(DriverError::Message(String::new()));
                        }
                    }
                    Ok(())
                });
                let timed_out = match tokio::time::timeout(CALL_TIMEOUT, run).await {
                    Ok(Err(err)) if !stopped => return Err(message(err)),
                    Ok(_) => false,
                    Err(_) => true,
                };
                // The server's own timeout should have fired first: cancel
                // and drop a session that stopped answering, too.
                let drop = timed_out
                    || stopped && seen < limit && !session_ping(session, DRAIN_WAIT).await;
                if drop {
                    let _ =
                        tokio::time::timeout(CANCEL_WAIT, cancel_with_token(cancel.0, cancel.1))
                            .await;
                    self.sessions.remove(&key);
                }
                if timed_out {
                    return Err("Timed out waiting for the server.".into());
                }
                Ok(Read {
                    columns,
                    state,
                    elapsed_ms: started.elapsed().as_millis() as u64,
                })
            }
        }
    }
}

/// The saved config with the database swapped in and safe mode forced to
/// Read-only, which opens the session with `default_transaction_read_only`.
fn read_only(pg: &PostgresConnection, database: &str) -> PostgresConnection {
    let mut config = pg.clone();
    config.database = database.to_string();
    config.safe_mode = SafeMode::ReadOnly;
    config
}

/// The (schema, table) pairs a SQLite statement reads, collected by the
/// authorizer while it is prepared; nothing runs. Views and CTEs report the
/// tables underneath, aliases report the real name.
pub fn sqlite_tables_read(path: &str, sql: &str) -> Result<Vec<(String, String)>, String> {
    use rusqlite::hooks::{AuthAction, AuthContext, Authorization};
    use rusqlite::OpenFlags;
    use std::sync::{Arc, Mutex};

    let conn = rusqlite::Connection::open_with_flags(
        rowkery_core::connections::expand_home(path),
        OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX,
    )
    .map_err(|e| e.to_string())?;
    let seen: Arc<Mutex<Vec<(String, String)>>> = Arc::default();
    let sink = Arc::clone(&seen);
    conn.authorizer(Some(move |ctx: AuthContext<'_>| {
        if let AuthAction::Read { table_name, .. } = ctx.action {
            let schema = ctx.database_name.unwrap_or("main").to_string();
            if let Ok(mut list) = sink.lock() {
                if !list.iter().any(|(s, t)| *s == schema && t == table_name) {
                    list.push((schema, table_name.to_string()));
                }
            }
        }
        Authorization::Allow
    }));
    conn.prepare(sql).map_err(|e| e.to_string())?;
    let list = seen.lock().map(|l| l.clone()).unwrap_or_default();
    Ok(list)
}

/// SQLite's version of the masked-column check (`mask`). It has no verbose
/// plan, so the rule is stricter: every read of a marked column must be a
/// result column taken straight from it (the authorizer counts the reads,
/// the column metadata names each result column's origin), and the plan may
/// not sort, group, combine results or walk an index on it. Ok with the
/// result columns to mask; `marked` is (table, column), compared without case.
pub fn sqlite_mask_check(
    path: &str,
    sql: &str,
    marked: &[(String, String)],
) -> Result<Vec<usize>, String> {
    use rusqlite::hooks::{AuthAction, AuthContext, Authorization};
    use rusqlite::{ffi, OpenFlags};
    use std::ffi::{CStr, CString};
    use std::sync::{Arc, Mutex};

    const REFUSAL: &str = "Refused: on SQLite a masked column can only be returned as it is, from the main SELECT, with no sorting, grouping, subqueries or combined results in the same query.";
    let key = |t: &str, c: &str| (t.to_lowercase(), c.to_lowercase());
    let marked: Vec<(String, String)> = marked.iter().map(|(t, c)| key(t, c)).collect();
    let conn = rusqlite::Connection::open_with_flags(
        rowkery_core::connections::expand_home(path),
        OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX,
    )
    .map_err(|e| e.to_string())?;
    let views: Vec<String> = conn
        .prepare("SELECT lower(name) FROM sqlite_master WHERE type = 'view'")
        .and_then(|mut s| s.query_map([], |r| r.get(0))?.collect())
        .map_err(|e| e.to_string())?;
    let selects = Arc::new(std::sync::atomic::AtomicUsize::new(0));
    let selects_in = Arc::clone(&selects);
    let reads: Arc<Mutex<HashMap<(String, String), usize>>> = Arc::default();
    let sink = Arc::clone(&reads);
    conn.authorizer(Some(move |ctx: AuthContext<'_>| {
        // One SELECT per query level; a view's own (named by the accessor)
        // is the user's, not the agent's.
        if matches!(ctx.action, AuthAction::Select)
            && ctx
                .accessor
                .is_none_or(|a| !views.contains(&a.to_lowercase()))
        {
            selects_in.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
        }
        if let AuthAction::Read {
            table_name,
            column_name,
        } = ctx.action
        {
            if let Ok(mut map) = sink.lock() {
                *map.entry((table_name.to_lowercase(), column_name.to_lowercase()))
                    .or_default() += 1;
            }
        }
        Authorization::Allow
    }));
    // The origin of each result column needs the raw statement.
    let c_sql = CString::new(sql).map_err(|e| e.to_string())?;
    let mut origins: Vec<Option<(String, String)>> = Vec::new();
    unsafe {
        let mut stmt: *mut ffi::sqlite3_stmt = std::ptr::null_mut();
        let rc = ffi::sqlite3_prepare_v2(
            conn.handle(),
            c_sql.as_ptr(),
            -1,
            &mut stmt,
            std::ptr::null_mut(),
        );
        if rc != ffi::SQLITE_OK || stmt.is_null() {
            ffi::sqlite3_finalize(stmt);
            return Err(conn
                .prepare(sql)
                .err()
                .map(|e| e.to_string())
                .unwrap_or_else(|| "SQLite couldn't prepare the query.".into()));
        }
        let text = |p: *const std::os::raw::c_char| {
            (!p.is_null()).then(|| CStr::from_ptr(p).to_string_lossy().into_owned())
        };
        for i in 0..ffi::sqlite3_column_count(stmt) {
            let table = text(ffi::sqlite3_column_table_name(stmt, i));
            let column = text(ffi::sqlite3_column_origin_name(stmt, i));
            origins.push(table.zip(column).map(|(t, c)| key(&t, &c)));
        }
        ffi::sqlite3_finalize(stmt);
    }
    conn.authorizer(None::<fn(AuthContext<'_>) -> Authorization>);
    let reads = reads.lock().map(|m| m.clone()).unwrap_or_default();
    let mut positions = Vec::new();
    let mut any = false;
    for m in &marked {
        let read = reads.get(m).copied().unwrap_or(0);
        if read == 0 {
            continue;
        }
        any = true;
        let returned: Vec<usize> = origins
            .iter()
            .enumerate()
            .filter(|(_, o)| o.as_ref() == Some(m))
            .map(|(i, _)| i)
            .collect();
        if returned.len() != read {
            return Err(REFUSAL.into());
        }
        positions.extend(returned);
    }
    if !any {
        return Ok(Vec::new());
    }
    // SQLite folds a subquery into the outer query, and a filter on its
    // renamed column then reads nothing new, so nested SELECTs are out.
    if selects.load(std::sync::atomic::Ordering::Relaxed) > 1 {
        return Err(REFUSAL.into());
    }
    // Indexes that would hand back a marked column in its own order.
    let mut indexes = Vec::new();
    for (table, column) in &marked {
        let mut stmt = conn
            .prepare(
                "SELECT il.name FROM pragma_index_list(?1) AS il, pragma_index_xinfo(il.name) AS ii \
                 WHERE lower(ii.name) = ?2 OR ii.cid = -2",
            )
            .map_err(|e| e.to_string())?;
        let names = stmt
            .query_map([table, column], |r| r.get::<_, String>(0))
            .map_err(|e| e.to_string())?;
        indexes.extend(names.flatten());
    }
    let mut stmt = conn
        .prepare(&format!("EXPLAIN QUERY PLAN {sql}"))
        .map_err(|e| e.to_string())?;
    let details = stmt
        .query_map([], |r| r.get::<_, String>(3))
        .map_err(|e| e.to_string())?;
    for detail in details.flatten() {
        let upper = detail.to_uppercase();
        let combined = [
            "TEMP B-TREE",
            "COMPOUND",
            "UNION",
            "INTERSECT",
            "EXCEPT",
            "SUBQUERY",
            "CO-ROUTINE",
            "MATERIALIZE",
        ]
        .iter()
        .any(|w| upper.contains(w));
        let indexed = indexes
            .iter()
            .any(|i| upper.contains(&format!("INDEX {}", i.to_uppercase())));
        if combined || indexed {
            return Err(REFUSAL.into());
        }
    }
    positions.sort_unstable();
    Ok(positions)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sqlite_reads_see_through_aliases_views_and_subqueries() {
        let dir = std::env::temp_dir().join(format!("rowkery-mcp-auth-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("t.db");
        let _ = std::fs::remove_file(&path);
        let conn = rusqlite::Connection::open(&path).unwrap();
        conn.execute_batch(
            "create table secret(id integer primary key, v text);
             create table t(id integer primary key, s int);
             create view vv as select * from secret;",
        )
        .unwrap();
        drop(conn);
        let p = path.to_str().unwrap();
        let reads = |sql: &str| {
            sqlite_tables_read(p, sql)
                .unwrap()
                .into_iter()
                .map(|(_, t)| t)
                .collect::<Vec<_>>()
        };
        assert!(reads("select * from t a join secret b on b.id = a.s").contains(&"secret".into()));
        assert!(reads("select * from vv").contains(&"secret".into()));
        assert!(
            reads("select * from t where s in (select id from secret)").contains(&"secret".into())
        );
        assert!(
            reads("with x as (select v from secret) select * from x").contains(&"secret".into())
        );
        assert_eq!(reads("select s from t"), vec!["t".to_string()]);
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn a_sqlite_read_stops_at_the_first_row_turned_down() {
        let dir = std::env::temp_dir().join(format!("rowkery-mcp-each-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("t.db");
        rusqlite::Connection::open(&path).unwrap();
        let started = Instant::now();
        let read = sqlite_read(
            path.to_str().unwrap(),
            "WITH RECURSIVE c(x) AS (SELECT 1 UNION ALL SELECT x + 1 FROM c) SELECT x FROM c",
            0usize,
            |seen, _| {
                *seen += 1;
                *seen < 3
            },
        )
        .unwrap();
        assert_eq!(read.state, 3);
        assert_eq!(read.columns.len(), 1);
        assert!(started.elapsed() < STATEMENT_TIMEOUT);
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn sqlite_masked_columns_may_only_be_returned() {
        let dir = std::env::temp_dir().join(format!("rowkery-mcp-mask-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("t.db");
        let _ = std::fs::remove_file(&path);
        rusqlite::Connection::open(&path)
            .unwrap()
            .execute_batch(
                "create table customers(id integer primary key, email text, plan text);
                 create table phones(id integer primary key, num text);
                 create index phones_num on phones(num);
                 create view cv as select id, email from customers;
                 insert into customers values (1, 'a@x', 'pro'), (2, 'b@x', 'free');",
            )
            .unwrap();
        let p = path.to_str().unwrap();
        let marked = [
            ("customers".to_string(), "email".to_string()),
            ("phones".to_string(), "num".to_string()),
        ];
        let check = |sql: &str| sqlite_mask_check(p, sql, &marked);
        assert_eq!(check("select id, email from customers"), Ok(vec![1]));
        assert_eq!(check("select * from customers"), Ok(vec![1]));
        assert_eq!(check("select * from cv"), Ok(vec![1]));
        assert_eq!(
            check("select c.email, c.plan from customers c where c.plan = 'pro'"),
            Ok(vec![0])
        );
        assert_eq!(check("select count(*) from customers"), Ok(vec![]));
        for sql in [
            "select id from customers where email like 'a%'",
            "select lower(email) from customers",
            "select email from customers order by email",
            "select email from customers order by 1",
            "select distinct email from customers",
            "select email, count(*) from customers group by 1",
            "select plan from customers union all select email from customers",
            "select email from customers union select 'a@x'",
            "select (select email from customers limit 1)",
            "select e from (select email as e from customers)",
            "select e from (select email as e from customers) where e like 'a%'",
            "select e from (select email as e from customers) order by e",
            "with x as (select email e from customers) select e from x where e > 'a'",
            "select c.email from customers c join customers d on d.email = c.email",
            "select num from phones indexed by phones_num",
        ] {
            assert!(check(sql).is_err(), "{sql}");
        }
        let _ = std::fs::remove_dir_all(dir);
    }
}
