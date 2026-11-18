//! Reaching a shared connection: read-only sessions, the schema catalog
//! cache, and running a capped read on Postgres or SQLite.

use std::collections::{HashMap, HashSet};
use std::time::{Duration, Instant};

use rowkery_core::config::AppConfig;
use rowkery_core::connections::{ConnectionRecord, PostgresConnection};
use rowkery_core::db::postgres::{
    cancel_with_token, open_session, session_activity, session_execute, session_health_within,
    session_introspect, session_list_databases, session_ping, session_query_stream,
    session_table_indexes, PostgresSession, ServerSession,
};
use rowkery_core::db::sqlite::SqliteDriver;
use rowkery_core::db::{Column, Driver, DriverError, SchemaCatalog, Value};
use rowkery_core::health::HealthReport;
use rowkery_core::safety::SafeMode;

/// Longest a call waits to open a session.
const CONNECT_TIMEOUT: Duration = Duration::from_secs(20);

/// Longest a call waits on a session once open: the statement limit, and
/// time beside it for the plan check and the guards.
fn call_timeout(statement: Duration) -> Duration {
    statement + Duration::from_secs(10)
}

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

    pub(crate) fn key(&self) -> (String, String) {
        (self.id().to_string(), self.database.clone())
    }

    /// The limit on one statement here ([`crate::guard::statement_timeout`]).
    pub fn timeout(&self) -> Duration {
        crate::guard::statement_timeout(&self.record)
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
        // Not shared with agents until its guards are in.
        ConnectionRecord::Mysql(_) => return Err(crate::MYSQL_NOT_SHARED.into()),
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

/// What every MCP statement on Postgres runs under besides read-only, which
/// the session sends ahead of each statement itself. Sent again ahead of
/// each call, in the same round trip, so a `set_config` in an earlier
/// SELECT can't loosen it. Pruning is put back after [`Store::read_unpruned`].
fn guards(timeout: Duration) -> String {
    format!(
        "SET statement_timeout = '{}s'; RESET enable_partition_pruning",
        timeout.as_secs()
    )
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

fn message(err: DriverError, timeout: Duration) -> String {
    match err {
        DriverError::Cancelled => format!(
            "Stopped after {} s (statement timeout). Filter on an indexed column or aggregate less.",
            timeout.as_secs()
        ),
        DriverError::Message(m) if m.contains(rowkery_core::db::sqlite::TOO_BIG) => format!(
            "Stopped: a value this reads or builds, or one row of them together, is over {} MB, more than an agent's query takes. Leave that column out, or read its size with length().",
            SQLITE_VALUE_BYTES >> 20
        ),
        other => other.to_string(),
    }
}

/// The largest text or binary value an agent's SQLite statement may build or
/// read, and the most one row's values may hold together. An answer keeps
/// 200 characters of a cell, but SQLite and the reader each hold the whole
/// value first: a 1 GB one cost the server process nearly 3 GB. Past this
/// the statement fails instead.
const SQLITE_VALUE_BYTES: i32 = 64 << 20;

/// Opens the file with writes refused (`PRAGMA query_only`) and the size of
/// one value capped.
fn open_sqlite(path: &str) -> Result<SqliteDriver, String> {
    let mut driver = SqliteDriver::new(path)
        .read_only(true)
        .max_value_bytes(SQLITE_VALUE_BYTES);
    driver.connect().map_err(|e| e.to_string())?;
    Ok(driver)
}

/// Each health check's own limit: the dozen of them run one after another
/// within the call's timeout, so a slow one is "unavailable" on its own.
const HEALTH_CHECK_TIMEOUT: Duration = Duration::from_millis(1500);

/// The file's health on a read-only connection, interrupted after the
/// timeout like [`sqlite_read`]: sizing walks the file's pages.
fn sqlite_health(path: &str, timeout: Duration) -> Result<HealthReport, String> {
    let mut driver = open_sqlite(path)?;
    let interrupt = driver.take_interrupt_handle();
    let (done_tx, done_rx) = std::sync::mpsc::channel::<()>();
    let watchdog = std::thread::spawn(move || {
        if done_rx.recv_timeout(timeout).is_err() {
            if let Some(handle) = interrupt {
                handle.interrupt();
            }
        }
    });
    let report = driver.health();
    let _ = done_tx.send(());
    let _ = watchdog.join();
    report.map_err(|e| message(e, timeout))
}

/// Runs `sql` on a read-only SQLite connection, interrupted after the timeout,
/// handing each row to `each` until it wants no more.
fn sqlite_read<S, F>(
    path: &str,
    sql: &str,
    timeout: Duration,
    mut state: S,
    mut each: F,
) -> Result<Read<S>, String>
where
    F: FnMut(&mut S, Vec<Value>) -> bool,
{
    let mut driver = open_sqlite(path)?;
    let interrupt = driver.take_interrupt_handle();
    let (done_tx, done_rx) = std::sync::mpsc::channel::<()>();
    let watchdog = std::thread::spawn(move || {
        if done_rx.recv_timeout(timeout).is_err() {
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
        result.map_err(|e| message(e, timeout))?;
    }
    Ok(Read {
        columns,
        state,
        elapsed_ms: started.elapsed().as_millis() as u64,
    })
}

impl Store {
    /// A read-only session on the target's database, opened once and reused.
    async fn session(&mut self, target: &Target) -> Result<&PostgresSession, String> {
        let ConnectionRecord::Postgres(pg) = &target.record else {
            return Err("not a Postgres connection".into());
        };
        let key = target.key();
        if self.adopted.as_ref() == Some(&key) {
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
            let session =
                tokio::time::timeout(CONNECT_TIMEOUT, open_session(pg.id.clone(), config))
                    .await
                    .map_err(|_| "Timed out connecting.".to_string())?
                    .map_err(|e| e.to_string())?;
            self.sessions.insert(key.clone(), session);
            self.left_open.remove(&key);
        }
        Ok(self.sessions.get(&key).expect("session"))
    }

    /// [`guards`], with pruning turned off when `unpruned`, after rolling
    /// back a transaction a call that stopped early left open, when this
    /// statement isn't inside a call's own.
    fn guards_for(&self, key: &(String, String), timeout: Duration, unpruned: bool) -> String {
        let guards = if self.open.as_ref() != Some(key) && self.left_open.contains(key) {
            format!("ROLLBACK; {}", guards(timeout))
        } else {
            guards(timeout)
        };
        if unpruned {
            format!("{guards}; SET enable_partition_pruning = off")
        } else {
            guards
        }
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
        let key = target.key();
        // A commit's adopted session is in its owner's transaction already.
        if self.adopted.as_ref() == Some(&key) {
            return Ok(());
        }
        self.open = None;
        self.guarded(target, "Timed out waiting for the server.", async |s| {
            session_execute(s, "BEGIN READ ONLY").await
        })
        .await?;
        self.left_open.insert(key.clone());
        self.open = Some(key);
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

    /// Runs `call` on the target's session with [`guards`] sent ahead in the
    /// same round trip, within [`call_timeout`]. A session that doesn't
    /// answer in time has its statement cancelled and is dropped, as is one
    /// that refuses the guards (what ran beside them is thrown away).
    async fn guarded<T>(
        &mut self,
        target: &Target,
        late: &str,
        call: impl AsyncFnOnce(&PostgresSession) -> Result<T, DriverError>,
    ) -> Result<T, String> {
        self.guarded_as(target, late, false, call).await
    }

    /// [`Self::guarded`], with partition pruning off for `call` when
    /// `unpruned`.
    async fn guarded_as<T>(
        &mut self,
        target: &Target,
        late: &str,
        unpruned: bool,
        call: impl AsyncFnOnce(&PostgresSession) -> Result<T, DriverError>,
    ) -> Result<T, String> {
        let key = target.key();
        self.session(target).await?;
        // An adopted session's owner set it up for its own transaction, and
        // goes on to run its change there planned as usual.
        let adopted = self.adopted.as_ref() == Some(&key);
        let guards = if adopted {
            unpruned.then(|| "SET LOCAL enable_partition_pruning = off".to_string())
        } else {
            Some(self.guards_for(&key, target.timeout(), unpruned))
        };
        let session = self.sessions.get(&key).expect("session");
        let cancel = (session.cancel_token.clone(), session.cancel_via.clone());
        let run = async {
            let (set, out) = match &guards {
                Some(guards) => tokio::join!(session_execute(session, guards), call(session)),
                None => (Ok(()), call(session).await),
            };
            if adopted && unpruned && set.is_ok() && out.is_ok() {
                let reset = session_execute(session, "RESET enable_partition_pruning").await;
                return (reset, out);
            }
            (set, out)
        };
        let (set, out) = match tokio::time::timeout(call_timeout(target.timeout()), run).await {
            Ok(done) => done,
            Err(_) => {
                let _ =
                    tokio::time::timeout(CANCEL_WAIT, cancel_with_token(cancel.0, cancel.1)).await;
                self.sessions.remove(&key);
                return Err(late.into());
            }
        };
        if let Err(err) = set {
            self.sessions.remove(&key);
            return Err(message(err, target.timeout()));
        }
        // A transaction an earlier call left open is closed now.
        if guards.as_deref().is_some_and(|g| g.starts_with("ROLLBACK")) {
            self.left_open.remove(&key);
        }
        out.map_err(|e| message(e, target.timeout()))
    }

    /// Holds nothing worth keeping: no session, no cached schema.
    pub fn is_idle(&self) -> bool {
        self.sessions.is_empty() && self.catalogs.is_empty()
    }

    pub async fn list_databases(
        &mut self,
        target: &Target,
    ) -> Result<Vec<(String, Option<i64>)>, String> {
        match &target.record {
            ConnectionRecord::Sqlite(_) => Ok(vec![("main".into(), None)]),
            ConnectionRecord::Mysql(_) => Err(crate::MYSQL_NOT_SHARED.into()),
            ConnectionRecord::Postgres(_) => {
                let list = self
                    .guarded(target, "Timed out.", async |s| {
                        session_list_databases(s).await
                    })
                    .await?;
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
                ConnectionRecord::Mysql(_) => return Err(crate::MYSQL_NOT_SHARED.into()),
                ConnectionRecord::Sqlite(sqlite) => {
                    let mut driver = open_sqlite(&sqlite.path)?;
                    driver.introspect_catalog().map_err(|e| e.to_string())?
                }
                ConnectionRecord::Postgres(_) => {
                    self.guarded(target, "Timed out reading the schema.", async |s| {
                        session_introspect(s).await
                    })
                    .await?
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
        self.guarded(target, "Timed out.", async |s| session_activity(s).await)
            .await
    }

    /// The database's health (the Health tab's report, before
    /// [`crate::health::shape`] leaves out what isn't shared).
    pub async fn health(&mut self, target: &Target) -> Result<HealthReport, String> {
        match &target.record {
            ConnectionRecord::Mysql(_) => Err(crate::MYSQL_NOT_SHARED.into()),
            ConnectionRecord::Sqlite(sqlite) => {
                let (path, timeout) = (sqlite.path.clone(), target.timeout());
                tokio::task::spawn_blocking(move || sqlite_health(&path, timeout))
                    .await
                    .map_err(|e| e.to_string())?
            }
            ConnectionRecord::Postgres(_) => {
                self.guarded(target, "Timed out.", async |s| {
                    session_health_within(s, HEALTH_CHECK_TIMEOUT).await
                })
                .await
            }
        }
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
        let tables = [table.to_string()];
        let fetched = self
            .guarded(target, "Timed out reading indexes.", async |s| {
                session_table_indexes(s, schema, &tables).await
            })
            .await?;
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
        state: S,
        each: F,
    ) -> Result<Read<S>, String>
    where
        S: Send + 'static,
        F: FnMut(&mut S, Vec<Value>) -> bool + Send + 'static,
    {
        self.read_as(target, false, sql, limit, state, each).await
    }

    /// [`Self::read`] on Postgres with partition pruning off, for an
    /// `EXPLAIN` that lists every partition the run could read. The next
    /// statement's guards put pruning back (on an adopted session, it's put
    /// back straight after).
    pub async fn read_unpruned(
        &mut self,
        target: &Target,
        sql: &str,
    ) -> Result<ReadResult, String> {
        let read = self
            .read_as(target, true, sql, usize::MAX, Vec::new(), |rows, row| {
                rows.push(row);
                true
            })
            .await?;
        Ok(ReadResult { rows: read.state })
    }

    /// [`Self::read_each`], with partition pruning off when `unpruned`
    /// (Postgres).
    async fn read_as<S, F>(
        &mut self,
        target: &Target,
        unpruned: bool,
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
            ConnectionRecord::Mysql(_) => Err(crate::MYSQL_NOT_SHARED.into()),
            ConnectionRecord::Sqlite(sqlite) => {
                let path = sqlite.path.clone();
                let (sql, timeout) = (sql.to_string(), target.timeout());
                tokio::task::spawn_blocking(move || sqlite_read(&path, &sql, timeout, state, each))
                    .await
                    .map_err(|e| e.to_string())?
            }
            ConnectionRecord::Postgres(_) => {
                let started = Instant::now();
                let mut columns = Vec::new();
                let (mut seen, mut stopped) = (0usize, false);
                self.guarded_as(
                    target,
                    "Timed out waiting for the server.",
                    unpruned,
                    async |s| {
                        let read = session_query_stream(s, sql, |batch, first| {
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
                        })
                        .await;
                        match read {
                            Err(_) if stopped => Ok(()),
                            read => read.map(|_| ()),
                        }
                    },
                )
                .await?;
                // Rows left on the wire are read off before the session
                // answers again: if that takes long, cancel and drop it.
                let key = target.key();
                if stopped && seen < limit {
                    if let Some(session) = self.sessions.get(&key) {
                        if !session_ping(session, DRAIN_WAIT).await {
                            let cancel = (session.cancel_token.clone(), session.cancel_via.clone());
                            let _ = tokio::time::timeout(
                                CANCEL_WAIT,
                                cancel_with_token(cancel.0, cancel.1),
                            )
                            .await;
                            self.sessions.remove(&key);
                        }
                    }
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

#[cfg(all(test, feature = "postgres-integration"))]
impl Store {
    /// Runs `sql` on the target's session past the guards, as a function an
    /// agent called might.
    pub async fn loosen(&mut self, target: &Target, sql: &str) {
        let session = self.session(target).await.expect("session");
        session_execute(session, sql).await.expect("loosen");
    }

    /// A setting of the target's session as it stands, read past the guards.
    pub async fn setting(&mut self, target: &Target, name: &str) -> String {
        let session = self.session(target).await.expect("session");
        let mut value = String::new();
        session_query_stream(
            session,
            &format!("SELECT current_setting('{name}')"),
            |batch, _| {
                if let Some(Value::Text(v)) = batch.rows.first().and_then(|r| r.first()) {
                    value = v.clone();
                }
                Ok(())
            },
        )
        .await
        .expect("setting");
        value
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

    let mut conn = rusqlite::Connection::open_with_flags(
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
    }))
    .map_err(|e| e.to_string())?;
    conn.prepare(sql).map_err(|e| e.to_string())?;
    let mut list = seen.lock().map(|l| l.clone()).unwrap_or_default();
    let opened = sqlite_opened(&conn, sql)?;
    if opened.virtual_table && sqlite_joins_unseen(&conn, sql)? {
        return Err(SQLITE_VIRTUAL_REFUSAL.into());
    }
    for table in opened.tables {
        if !list.iter().any(|(s, t)| s == "main" && *t == table) {
            list.push(("main".to_string(), table));
        }
    }
    Ok(list)
}

/// What a query that reads a table with a masked column is told when it,
/// or a view it reaches, joins with `USING` or `NATURAL`.
pub(crate) const SQLITE_USING_REFUSAL: &str = "Refused: on SQLite a query that reads a table with a masked column can't join with USING or NATURAL JOIN, in its own text or in a view it reads. Write the join with ON.";

/// A virtual table has no root page for the bytecode to name, so one joined
/// with `USING` or `NATURAL` can't be told from any other.
pub(crate) const SQLITE_VIRTUAL_REFUSAL: &str = "Refused: on SQLite a query that reads a virtual table (full-text search, json_each, a pragma function) can't join with USING or NATURAL JOIN while tables are hidden or columns masked. Write the join with ON.";

/// Text `rowkery_core::safety::sqlite_names` won't read.
const SQLITE_UNCLEAR_REFUSAL: &str = "Refused: Rowkery can't be sure how SQLite reads this query, or a view it reads: it holds a parameter (?, :name, @name, $name), a byte-order mark, or a string or comment that never ends. Write the values in and send it again.";

/// What a SQLite statement opens (`sqlite_opened`).
pub(crate) struct Opened {
    /// The tables behind the root pages it opens.
    pub tables: Vec<String>,
    /// It opens a virtual table, which no root page names.
    pub virtual_table: bool,
}

/// The tables whose b-trees a SQLite statement opens, read from its
/// bytecode (`EXPLAIN`; nothing runs): the table behind every root page an
/// `Open…` opcode names, an index counted as its table. The authorizer
/// alone misses a table reached only through the columns of a `USING` or
/// `NATURAL` join, which SQLite compares without asking it
/// (rowkery/reports#78). A root page with no table to its name is refused.
pub(crate) fn sqlite_opened(conn: &rusqlite::Connection, sql: &str) -> Result<Opened, String> {
    const UNKNOWN: &str = "Refused: Rowkery couldn't tell which tables this reads.";
    // Cursors over rows the statement makes itself, with no root page.
    const OWN: &[&str] = &["OpenEphemeral", "OpenAutoindex", "OpenPseudo", "OpenDup"];
    let roots: HashMap<i64, String> = conn
        .prepare("SELECT rootpage, tbl_name FROM sqlite_master WHERE rootpage > 0")
        .and_then(|mut s| s.query_map([], |r| Ok((r.get(0)?, r.get(1)?)))?.collect())
        .map_err(|e| e.to_string())?;
    let opens: Vec<(String, i64, i64)> = conn
        .prepare(&format!("EXPLAIN {sql}"))
        .and_then(|mut s| {
            s.query_map([], |r| Ok((r.get(1)?, r.get(3)?, r.get(4)?)))?
                .collect()
        })
        .map_err(|e| e.to_string())?;
    let mut tables: Vec<String> = Vec::new();
    let mut virtual_table = false;
    for (opcode, root, database) in opens {
        virtual_table |= opcode == "VOpen";
        if !(opcode.starts_with("Open") || opcode == "ReopenIdx") || OWN.contains(&opcode.as_str())
        {
            continue;
        }
        let table = match (database, root) {
            (0, 1) => "sqlite_master".to_string(),
            (0, root) => roots.get(&root).cloned().ok_or(UNKNOWN)?,
            // Only `main` holds anything on a connection opened to look.
            _ => return Err(UNKNOWN.into()),
        };
        if !tables.contains(&table) {
            tables.push(table);
        }
    }
    Ok(Opened {
        tables,
        virtual_table,
    })
}

/// Whether a SQLite statement, or a view its text can reach, joins with
/// `USING` or `NATURAL`: the two joins whose column comparisons the
/// authorizer isn't asked about. A view is reached by its name in the text
/// (or in the text of a view reached before it), bare or quoted. Text that
/// may be read another way, or holds a parameter, is refused.
pub(crate) fn sqlite_joins_unseen(conn: &rusqlite::Connection, sql: &str) -> Result<bool, String> {
    let mut views: Vec<(String, String)> = conn
        .prepare("SELECT upper(name), coalesce(sql, '') FROM sqlite_master WHERE type = 'view'")
        .and_then(|mut s| s.query_map([], |r| Ok((r.get(0)?, r.get(1)?)))?.collect())
        .map_err(|e| e.to_string())?;
    let mut texts = vec![sql.to_string()];
    while let Some(text) = texts.pop() {
        let Some((bare, quoted)) = rowkery_core::safety::sqlite_names(&text) else {
            return Err(SQLITE_UNCLEAR_REFUSAL.into());
        };
        if bare.iter().any(|w| w == "USING" || w == "NATURAL") {
            return Ok(true);
        }
        // A name the lexer can't hand back whole is taken as reached.
        let named = |name: &String| {
            name.contains(['"', '`', '[', ']', '\'', '\\'])
                || !name.is_ascii()
                || bare.contains(name)
                || quoted.contains(name)
        };
        let (reached, rest): (Vec<_>, Vec<_>) = views.into_iter().partition(|(n, _)| named(n));
        texts.extend(reached.into_iter().map(|(_, text)| text));
        views = rest;
    }
    Ok(false)
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
    let mut conn = rusqlite::Connection::open_with_flags(
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
    }))
    .map_err(|e| e.to_string())?;
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
    conn.authorizer(None::<fn(AuthContext<'_>) -> Authorization>)
        .map_err(|e| e.to_string())?;
    let reads = reads.lock().map(|m| m.clone()).unwrap_or_default();
    // A `USING` or `NATURAL` join compares its columns without the
    // authorizer hearing of it, so the counts above miss a join on a marked
    // column (rowkery/reports#78). Refused wherever a table with one is read.
    let opened = sqlite_opened(&conn, sql)?;
    let reads_marked = |table: &str| marked.iter().any(|(m, _)| m == &table.to_lowercase());
    if (opened.virtual_table
        || reads.keys().any(|(t, _)| reads_marked(t))
        || opened.tables.iter().any(|t| reads_marked(t)))
        && sqlite_joins_unseen(&conn, sql)?
    {
        return Err(if opened.virtual_table {
            SQLITE_VIRTUAL_REFUSAL
        } else {
            SQLITE_USING_REFUSAL
        }
        .into());
    }
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
        // rowkery/reports#78: SQLite compares the columns of a USING or
        // NATURAL join without asking the authorizer; the bytecode still
        // names every table opened.
        let conn = rusqlite::Connection::open(&path).unwrap();
        conn.execute_batch(
            "create table pub(v text, w text);
             create index secret_v on secret(v);
             create table keyed(v text primary key, n int) without rowid;
             create view counted as select count(*) n from pub natural full join secret;",
        )
        .unwrap();
        drop(conn);
        for sql in [
            "select v from pub full join secret using (v)",
            "select v from secret full join pub using (v)",
            "select v from pub natural full join secret",
            "select v from pub join secret using (v)",
            "select w from pub natural join secret",
            "select count(*) from pub natural full join secret",
            "select * from (select null as id, null as v) natural full join secret",
            "select v from (select 'x' as v) full join secret using (v)",
            "select n from counted",
            "select count(*) from pub left join secret indexed by secret_v using (v)",
        ] {
            assert!(reads(sql).contains(&"secret".into()), "{sql}");
        }
        assert_eq!(reads("select w from pub"), vec!["pub".to_string()]);
        assert_eq!(
            reads("select n from keyed where v = 'a'"),
            vec!["keyed".to_string()]
        );
        assert_eq!(
            reads("select v from pub join keyed using (v)"),
            ["pub", "keyed"]
        );
        assert_eq!(reads("select 1"), Vec::<String>::new());
        assert_eq!(
            reads("select count(*) from sqlite_master"),
            ["sqlite_master"]
        );
        // A virtual table has no root page: joined this way it is refused,
        // and named by the authorizer as before when it isn't.
        let conn = rusqlite::Connection::open(&path).unwrap();
        conn.execute_batch("create virtual table docs using fts5(title, body);")
            .unwrap();
        drop(conn);
        for sql in [
            "select * from (select null as title, null as body) natural full join docs",
            "select name from (select 'v' as name) join pragma_table_info('secret') using (name)",
            "select * from (select 1 as key) natural join json_each('[1]')",
        ] {
            let err = sqlite_tables_read(p, sql).expect_err(sql);
            assert!(err.contains("virtual table"), "{sql}: {err}");
        }
        assert!(reads("select title from docs where docs match 'a'").contains(&"docs".into()));
        assert!(reads("select count(*) from docs").contains(&"docs".into()));
        assert!(reads("select j.value from pub, json_each('[1]') j").contains(&"pub".into()));
        // What SQLite reads another way than the lexer is refused, not
        // guessed; a parameter nobody binds stops at the bytecode already.
        for sql in [
            "select * from (select null as title) \u{FEFF}natural full join docs",
            "select $a(--), title from (select null as title) natural full join docs",
        ] {
            let err = sqlite_tables_read(p, sql).expect_err(sql);
            assert!(
                err.contains("can't be sure") || err.contains("parameters"),
                "{sql}: {err}"
            );
        }
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
            crate::guard::STATEMENT_TIMEOUT,
            0usize,
            |seen, _| {
                *seen += 1;
                *seen < 3
            },
        )
        .unwrap();
        assert_eq!(read.state, 3);
        assert_eq!(read.columns.len(), 1);
        assert!(started.elapsed() < crate::guard::STATEMENT_TIMEOUT);
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn a_sqlite_read_stops_at_the_timeout_it_is_given() {
        let dir = std::env::temp_dir().join(format!("rowkery-mcp-timeout-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("t.db");
        rusqlite::Connection::open(&path).unwrap();
        let started = Instant::now();
        let err = sqlite_read(
            path.to_str().unwrap(),
            "WITH RECURSIVE c(x) AS (SELECT 1 UNION ALL SELECT x + 1 FROM c) SELECT count(*) FROM c",
            Duration::from_secs(1),
            (),
            |_, _| true,
        )
        .err()
        .expect("interrupted");
        assert!(started.elapsed() < Duration::from_secs(5));
        assert!(err.starts_with("Stopped after 1 s"), "{err}");
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn a_sqlite_read_refuses_a_huge_value() {
        let dir = std::env::temp_dir().join(format!("rowkery-mcp-big-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("t.db");
        rusqlite::Connection::open(&path)
            .unwrap()
            .execute_batch(
                "CREATE TABLE docs (id INTEGER PRIMARY KEY, title TEXT, body BLOB);
                 INSERT INTO docs VALUES (1, 'small', x'00'), (2, 'big', zeroblob(70000000));
                 CREATE TABLE wide (a BLOB, b BLOB, c BLOB);
                 INSERT INTO wide VALUES (zeroblob(30000000), zeroblob(30000000), zeroblob(30000000));",
            )
            .unwrap();
        let read = |sql: &str| {
            sqlite_read(
                path.to_str().unwrap(),
                sql,
                crate::guard::STATEMENT_TIMEOUT,
                Vec::new(),
                |rows, row| {
                    rows.push(row);
                    true
                },
            )
            .map(|r| r.state)
        };
        for sql in [
            // Built by a function, read from a row, and made by joining.
            "SELECT zeroblob(1000000000)",
            "SELECT * FROM docs",
            "SELECT hex(zeroblob(40000000))",
            // Each value under the limit, the row over it.
            "SELECT * FROM wide",
        ] {
            let err = read(sql).expect_err(sql);
            assert!(
                err.starts_with("Stopped: a value this reads or builds, or one row of them together, is over 64 MB"),
                "{sql}: {err}"
            );
        }
        // The rest of a row with a huge value still reads, and so does a
        // value under the limit.
        assert_eq!(
            read("SELECT id, title, length(body) FROM docs WHERE id = 2").unwrap(),
            vec![vec![
                Value::Int(2),
                Value::Text("big".into()),
                Value::Int(70_000_000)
            ]]
        );
        assert_eq!(read("SELECT * FROM docs WHERE id = 1").unwrap().len(), 1);
        assert_eq!(read("SELECT zeroblob(8000000)").unwrap().len(), 1);
        assert_eq!(read("SELECT a, b FROM wide").unwrap().len(), 1);
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn the_guards_set_the_connections_limit() {
        assert!(guards(Duration::from_secs(300)).starts_with("SET statement_timeout = '300s';"));
        assert!(call_timeout(Duration::from_secs(300)) > Duration::from_secs(300));
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
                 create table leads(id integer primary key, email text);
                 create view matched as select leads.email from leads join customers using (email);
                 create view lead_names as select id, email from leads;
                 create view \"through it\" as select * from matched;
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
        // rowkery/reports#78: a USING or NATURAL join compares a marked
        // column without the authorizer hearing of it.
        for sql in [
            "select email from customers full join leads using (email)",
            "select email from customers full join (select 'zzz' as email) using (email)",
            "select email from customers natural full join (select 'zzz' as email)",
            "select email from (select 'zzz' as email) natural full join customers",
            "select id from customers join (select 'a@x' as email) using (email)",
            "select customers.id from customers join leads using (email)",
            "select id from customers natural join (select 'a@x' as email)",
            "select c.id from customers c left join leads l USING(email) where l.id is not null",
            "select email from customers/**/natural/**/full join leads",
            "select email from customers full join leads [l]using(email)",
            "select 1 as \"a\"\"b\", email from customers full join leads using (email)",
            "select '--', email from customers full join leads using (email)",
            "select * from matched",
            "select m.email from matched m join lead_names n on n.id = 1",
            // A view reached through another, by a quoted name.
            "select * from [through it]",
            "select * from \"Through It\"",
            "select * from 'through it'",
            // Stricter than it must be: the join isn't on the marked column.
            "select c.plan from customers c join leads using (id)",
        ] {
            let err = check(sql).expect_err(sql);
            assert!(err.contains("USING or NATURAL"), "{sql}: {err}");
        }
        for sql in [
            "select email from customers full join leads \u{FEFF}using (email)",
            "select email from customers \u{FEFF}natural full join leads",
            "select * from \u{FEFF}matched",
            "select $a(--), email from customers natural full join leads",
            "select :a('), email from customers natural full join leads --'",
        ] {
            let err = check(sql).expect_err(sql);
            assert!(
                err.contains("can't be sure") || err.contains("parameters"),
                "{sql}: {err}"
            );
        }
        // The same joins written with ON are judged as before, and a join
        // that reads no marked table may use either word.
        assert_eq!(
            check("select c.id, c.email from customers c join leads l on l.id = c.id"),
            Ok(vec![1])
        );
        assert!(check("select c.id from customers c join leads l on l.email = c.email").is_err());
        assert_eq!(
            check("select l.email from leads l join lead_names using (id)"),
            Ok(vec![])
        );
        assert_eq!(
            check("select plan as \"using\", 'natural' from customers -- using"),
            Ok(vec![])
        );
        let _ = std::fs::remove_dir_all(dir);
    }
}
