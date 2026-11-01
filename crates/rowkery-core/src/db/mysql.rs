//! MySQL and MariaDB: one session per tab, on `mysql_async` with rustls.
//! Which server it is comes from `VERSION()`, never from the saved record.
//!
//! Results come over the text protocol (`COM_QUERY`), as the `mysql` client
//! reads them, so any statement runs, several per run included. Each cell
//! is typed from its column's metadata (`value`).

use std::collections::HashMap;
use std::path::PathBuf;
use std::time::{Duration, Instant};

use futures::TryStreamExt;
use mysql_async::consts::{ColumnFlags, ColumnType};
use mysql_async::prelude::Queryable;
use mysql_async::{Conn, Opts, OptsBuilder, Row, SslOpts};

use crate::connections::{expand_home, MysqlConnection, PostgresSslMode};
use crate::edits::{ApplyCounts, ApplyFailure, RowStatement, Verb};
use crate::query_util::mysql_text;
use crate::reach::{self, MyForeignKey, MyPlan, MyRule, MyWrite, Name, Reach, TableRows};
use crate::route::{self, Route};
use crate::safety::{statement_texts, Dialect, SafeMode};
use crate::secrets::{get_secret, ConnectionSecrets, SecretKind};

use super::introspect::{
    ColumnNode, DatabaseNode, ForeignKeyNode, FunctionNode, IndexNode, RowEstimate, SchemaCatalog,
    SchemaNode, TableKind, TableNode,
};
use super::{Column, DriverError, RowBatch, Value, BATCH_BYTES};

mod activity;
pub use activity::{session_activity, session_stop};

/// The one catalog a MySQL server has (`information_schema`'s
/// `TABLE_CATALOG`): the catalog's single database. Its databases are the
/// catalog's schemas.
pub const CATALOG: &str = "def";

/// Databases every server has for itself, left out of the catalog.
const SYSTEM_SCHEMAS: &str = "'information_schema', 'performance_schema', 'mysql', 'sys'";

/// Rows per batch at most.
const BATCH_SIZE: usize = 200;

pub use super::postgres::{CONNECT_TIMEOUT, OPEN_TIMEOUT};

/// Which server answers.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Flavor {
    Mysql,
    Mariadb,
}

impl Flavor {
    pub fn name(self) -> &'static str {
        match self {
            Flavor::Mysql => "MySQL",
            Flavor::Mariadb => "MariaDB",
        }
    }
}

/// What `VERSION()` says: `8.4.3` or `11.4.2-MariaDB-ubu2404`.
pub fn parse_version(full: &str) -> (Flavor, String) {
    let flavor = if full.to_ascii_lowercase().contains("mariadb") {
        Flavor::Mariadb
    } else {
        Flavor::Mysql
    };
    // MariaDB once put `5.5.5-` ahead of its own version for old clients.
    let full = full.strip_prefix("5.5.5-").unwrap_or(full);
    let version = full.split(['-', ' ']).next().unwrap_or(full).to_string();
    (flavor, version)
}

pub struct MysqlSession {
    config: MysqlConnection,
    connection_id: String,
    route: Option<Route>,
    conn: Conn,
    /// How to reach the server again, for a cancel.
    opts: Opts,
    flavor: Flavor,
    version: String,
    /// The server's id for the connection, as text: what the Sessions
    /// tab knows it by (`PROCESSLIST.ID`).
    tag: String,
    /// Kept while the session lives (a place under the connection's cap).
    guard: Option<Box<dyn std::any::Any + Send + Sync>>,
    /// See [`MysqlSession::keeps_state`].
    stateful: bool,
    /// A save's step didn't answer: the connection was killed at the
    /// server, and the session is dropped, never reused.
    abandoned: bool,
}

/// How to stop what a session is running: `KILL QUERY` from a second
/// connection, made the way the session's was.
#[derive(Clone)]
pub struct CancelVia {
    opts: Opts,
    thread_id: u32,
}

impl MysqlSession {
    pub fn connection_id(&self) -> &str {
        &self.connection_id
    }

    pub fn config(&self) -> &MysqlConnection {
        &self.config
    }

    pub fn flavor(&self) -> Flavor {
        self.flavor
    }

    /// `8.4.3`, `11.4.2`.
    pub fn version(&self) -> &str {
        &self.version
    }

    /// Names this session's connection in the Sessions tab: its
    /// `PROCESSLIST.ID`.
    pub fn tag(&self) -> &str {
        &self.tag
    }

    /// The server's id for this connection (`CONNECTION_ID()`).
    pub fn thread_id(&self) -> u32 {
        self.conn.id()
    }

    /// The tunnel this session goes through, to share with the next one.
    pub fn route(&self) -> Option<Route> {
        self.route.clone()
    }

    pub fn cancel_via(&self) -> CancelVia {
        CancelVia {
            opts: self.opts.clone(),
            thread_id: self.conn.id(),
        }
    }

    /// The server said a transaction is open after the last statement
    /// (`SERVER_STATUS_IN_TRANS`).
    pub fn in_transaction(&self) -> bool {
        self.txn_known() == Some(true)
    }

    /// Whether a transaction is open, as the last OK said; `None` after
    /// an error, which carries no status (ask with [`session_probe_txn`]).
    pub fn txn_known(&self) -> Option<bool> {
        if self.abandoned {
            return None;
        }
        self.status()
            .map(|s| s.contains(mysql_async::consts::StatusFlags::SERVER_STATUS_IN_TRANS))
    }

    fn status(&self) -> Option<mysql_async::consts::StatusFlags> {
        self.conn.last_ok_packet().map(|ok| ok.status_flags())
    }

    /// The session holds what a new one wouldn't: a `USE`, a `SET`
    /// (autocommit off, a variable), so it isn't closed when idle.
    pub fn keeps_state(&self) -> bool {
        self.stateful
            || self.status().is_some_and(|s| {
                !s.contains(mysql_async::consts::StatusFlags::SERVER_STATUS_AUTOCOMMIT)
            })
    }

    /// A statement that changes the session (`USE`, `SET`) ran on it.
    pub fn note_state(&mut self) {
        self.stateful = true;
    }

    /// The socket is gone: nothing more can run on it.
    pub fn is_closed(&self) -> bool {
        self.abandoned || self.conn.is_disconnected()
    }

    /// A save gave up on it (see [`session_apply_changes_within`]): the
    /// server rolled its own transaction back, and no user's was open.
    pub fn abandoned(&self) -> bool {
        self.abandoned
    }

    /// The driver's connection, for core's own statements (an import).
    pub(crate) fn conn(&mut self) -> &mut Conn {
        &mut self.conn
    }

    /// Keeps `guard` while the session lives.
    pub fn hold(&mut self, guard: Box<dyn std::any::Any + Send + Sync>) {
        self.guard = Some(guard);
    }

    pub fn holds(&self) -> bool {
        self.guard.is_some()
    }

    pub fn unhold(&mut self) -> Option<Box<dyn std::any::Any + Send + Sync>> {
        self.guard.take()
    }
}

/// Asks the server whether a transaction is open: `DO 0` changes nothing
/// and its OK carries the status flags. `None` when it doesn't answer
/// within `limit`.
pub async fn session_probe_txn(session: &mut MysqlSession, limit: Duration) -> Option<bool> {
    match tokio::time::timeout(limit, session.conn.query_drop("DO 0")).await {
        Ok(Ok(())) => Some(session.in_transaction()),
        _ => None,
    }
}

/// Opens a session, through `route` when it is the window's tunnel and
/// still alive (else a new one, which `session.route()` returns for the
/// next session to share). `secrets` are the form's, for a connection not
/// saved yet; else the password comes from the keychain.
pub async fn open_session_via(
    connection_id: String,
    config: MysqlConnection,
    secrets: Option<&ConnectionSecrets>,
    route: Option<Route>,
) -> Result<MysqlSession, DriverError> {
    let mut route = route.filter(|r| r.fits(config.ssh.as_ref(), None) && r.is_alive());
    let mut port = config.port;
    let mut tunneled = false;
    if let Some(ssh) = &config.ssh {
        let tunnel = route::ssh_tunnel(
            ssh,
            route.take(),
            &connection_id,
            &config.host,
            port,
            secrets,
        )
        .await?;
        port = tunnel.local_port;
        tunneled = true;
        route = Some(Route::Ssh(tunnel));
    }
    let password = match secrets.and_then(|s| s.db_password.clone()) {
        Some(p) => p,
        None if secrets.is_some() => String::new(),
        None => stored_password(&connection_id).await?,
    };
    let builder = |tls: Option<SslOpts>| {
        let mut b = OptsBuilder::default()
            // Through a tunnel the socket goes to the local end; the
            // certificate is still checked against the real host name.
            .ip_or_hostname(if tunneled {
                "127.0.0.1".to_string()
            } else {
                config.host.clone()
            })
            .tcp_port(port)
            .user(Some(config.username.clone()))
            .pass(Some(password.clone()))
            .db_name((!config.database.trim().is_empty()).then(|| config.database.clone()))
            // Never the server's own socket file, even for localhost: the
            // form names a TCP port.
            .prefer_socket(false)
            .tcp_keepalive(Some(Duration::from_secs(30)))
            .stmt_cache_size(0)
            .connect_attribute("program_name", super::postgres::APP_NAME)
            .ssl_opts(tls);
        // Read-only connections are read-only at the server too, so a write
        // the text check misses (a function in a SELECT) still fails.
        if config.safe_mode == SafeMode::ReadOnly {
            b = b.init(vec![READ_ONLY]);
        }
        b
    };
    let deadline = tokio::time::Instant::now() + OPEN_TIMEOUT;
    let late = || {
        DriverError::Message(format!(
            "Connection timed out: {}:{} did not finish connecting in {} s",
            config.host,
            config.port,
            OPEN_TIMEOUT.as_secs()
        ))
    };
    let tls = tls_opts(&config, tunneled)?;
    let prefer = config.ssl_mode == PostgresSslMode::Prefer;
    let mut opts: Opts = builder(tls).into();
    let mut opened = tokio::time::timeout_at(deadline, Conn::new(opts.clone()))
        .await
        .map_err(|_| late())?;
    // Prefer: TLS when the server offers it, as the `mysql` client does.
    if prefer
        && matches!(
            opened,
            Err(mysql_async::Error::Driver(
                mysql_async::DriverError::NoClientSslFlagFromServer
            ))
        )
    {
        opts = builder(None).into();
        opened = tokio::time::timeout_at(deadline, Conn::new(opts.clone()))
            .await
            .map_err(|_| late())?;
    }
    let mut conn = opened.map_err(|e| DriverError::Message(humanize_mysql_error(&e, &config)))?;
    let first: Option<(String, Option<String>)> = tokio::time::timeout_at(
        deadline,
        conn.query_first("SELECT VERSION(), @@SESSION.character_set_client"),
    )
    .await
    .map_err(|_| late())?
    .map_err(|e| map_error(e, &config))?;
    let (full, charset) = first.unwrap_or_default();
    let (flavor, version) = parse_version(&full);
    // The server's own default (or its init_connect) may pick gbk and the
    // like: with safe mode on, sessions read text as safe mode does.
    if config.safe_mode != SafeMode::Off
        && !charset
            .as_deref()
            .is_some_and(crate::safety::mysql_plain_charset)
    {
        tokio::time::timeout_at(deadline, conn.query_drop("SET NAMES utf8mb4"))
            .await
            .map_err(|_| late())?
            .map_err(|e| map_error(e, &config))?;
    }
    let tag = conn.id().to_string();
    Ok(MysqlSession {
        config,
        connection_id,
        route,
        conn,
        opts,
        flavor,
        version,
        tag,
        guard: None,
        stateful: false,
        abandoned: false,
    })
}

/// What makes a read-only connection's sessions read-only at the server:
/// each transaction after it starts read-only, autocommit statements too.
const READ_ONLY: &str = "SET SESSION TRANSACTION READ ONLY";

/// Sends [`READ_ONLY`] ahead of a run on a read-only connection. A stored
/// function can turn the session's access mode back (MariaDB lets it), so
/// it is set again before every statement. A transaction already open
/// keeps the mode it started with (the user's `BEGIN` got one too), and
/// the server refuses the SET inside one; after an error, which says
/// nothing of it, the server is asked first.
async fn read_only_ahead(session: &mut MysqlSession) -> Result<(), DriverError> {
    if session.config.safe_mode != SafeMode::ReadOnly {
        return Ok(());
    }
    if session.txn_known().is_none() {
        session
            .conn
            .query_drop("DO 0")
            .await
            .map_err(|e| map_error(e, &session.config))?;
    }
    if session.txn_known() == Some(false) {
        session
            .conn
            .query_drop(READ_ONLY)
            .await
            .map_err(|e| map_error(e, &session.config))?;
    }
    Ok(())
}

fn tls_opts(config: &MysqlConnection, tunneled: bool) -> Result<Option<SslOpts>, DriverError> {
    Ok(match config.ssl_mode {
        PostgresSslMode::Disable => None,
        // Encrypted, the certificate not checked, as the `mysql` client's
        // PREFERRED and REQUIRED.
        PostgresSslMode::Prefer | PostgresSslMode::Require => Some(
            SslOpts::default()
                .with_danger_accept_invalid_certs(true)
                .with_danger_skip_domain_validation(true),
        ),
        // VERIFY_IDENTITY: the system's roots or the given CA, and the name.
        PostgresSslMode::Verify => {
            let mut ssl = SslOpts::default();
            if let Some(path) = config
                .ssl_root_cert
                .as_deref()
                .map(str::trim)
                .filter(|p| !p.is_empty())
            {
                let path: PathBuf = expand_home(path);
                if !path.is_file() {
                    return Err(DriverError::Message(format!(
                        "Couldn't read CA certificate {}: no such file",
                        path.display()
                    )));
                }
                ssl = ssl
                    .with_root_certs(vec![path.into()])
                    .with_disable_built_in_roots(true);
            }
            if tunneled {
                ssl = ssl.with_danger_tls_hostname_override(Some(config.host.clone()));
            }
            Some(ssl)
        }
    })
}

async fn stored_password(connection_id: &str) -> Result<String, DriverError> {
    let id = connection_id.to_string();
    Ok(
        tokio::task::spawn_blocking(move || get_secret(&id, SecretKind::DbPassword))
            .await
            .map_err(|e| DriverError::Message(e.to_string()))?
            .map_err(|e| DriverError::Message(e.to_string()))?
            .unwrap_or_default(),
    )
}

/// Server error codes that mean the statement was stopped on purpose:
/// `KILL QUERY` (1317), MySQL's `max_execution_time` (3024) and MariaDB's
/// `max_statement_time` (1969).
const CANCELLED: [u16; 3] = [1317, 3024, 1969];

fn map_error(err: mysql_async::Error, config: &MysqlConnection) -> DriverError {
    match err {
        mysql_async::Error::Server(e) if CANCELLED.contains(&e.code) => DriverError::Cancelled,
        mysql_async::Error::Server(e) => DriverError::Server {
            message: e.message,
            sqlstate: e.state,
            position: None,
            detail: None,
        },
        other => DriverError::Message(humanize_mysql_error(&other, config)),
    }
}

/// The error as the connection form shows it.
pub fn humanize_mysql_error(err: &mysql_async::Error, config: &MysqlConnection) -> String {
    match err {
        // ER_ACCESS_DENIED_ERROR: wrong user or password. Before the
        // handshake ends it isn't known whether MySQL or MariaDB said it.
        mysql_async::Error::Server(e) if e.code == 1045 => {
            format!("The server rejected the password for '{}'", config.username)
        }
        // ER_BAD_DB_ERROR.
        mysql_async::Error::Server(e) if e.code == 1049 => {
            format!(
                "There's no database named '{}' on this server",
                config.database
            )
        }
        mysql_async::Error::Server(e) => e.message.clone(),
        mysql_async::Error::Driver(mysql_async::DriverError::NoClientSslFlagFromServer) => {
            "The server doesn't accept SSL. Check SSL under Advanced.".into()
        }
        mysql_async::Error::Io(io) => {
            let text = error_chain(io);
            if text.contains("invalid peer certificate") {
                let reason = text
                    .rsplit("invalid peer certificate: ")
                    .next()
                    .unwrap_or("");
                format!(
                    "Couldn't verify the server's certificate ({reason}). Check SSL under Advanced."
                )
            } else {
                text
            }
        }
        other => error_chain(other),
    }
}

fn error_chain(err: &dyn std::error::Error) -> String {
    let mut text = err.to_string();
    let mut source = err.source();
    while let Some(cause) = source {
        let cause_text = cause.to_string();
        if !text.contains(&cause_text) {
            text.push_str(": ");
            text.push_str(&cause_text);
        }
        source = cause.source();
    }
    text
}

/// One empty round trip; false if the server doesn't answer within `limit`.
pub async fn session_ping(session: &mut MysqlSession, limit: Duration) -> bool {
    matches!(
        tokio::time::timeout(limit, session.conn.ping()).await,
        Ok(Ok(()))
    )
}

/// `KILL QUERY` for the session's running statement. The connection
/// stays; the statement ends with a cancel.
pub async fn cancel(via: CancelVia) -> Result<(), DriverError> {
    kill(via, "KILL QUERY").await
}

/// Ends the session at the server (`KILL`): its statement stops and its
/// transaction rolls back, whatever its client does.
pub async fn kill_connection(via: CancelVia) -> Result<(), DriverError> {
    kill(via, "KILL").await
}

/// `{what} <thread id>` from a second connection.
async fn kill(via: CancelVia, what: &str) -> Result<(), DriverError> {
    let mut conn = tokio::time::timeout(CONNECT_TIMEOUT, Conn::new(via.opts.clone()))
        .await
        .map_err(|_| DriverError::Message("The server didn't take the cancel in time".into()))?
        .map_err(|e| DriverError::Message(e.to_string()))?;
    let killed = tokio::time::timeout(
        CONNECT_TIMEOUT,
        conn.query_drop(format!("{what} {}", via.thread_id)),
    )
    .await
    .map_err(|_| DriverError::Message("The server didn't take the cancel in time".into()))
    .and_then(|r| r.map_err(|e| DriverError::Message(e.to_string())));
    let _ = conn.disconnect().await;
    killed
}

/// Runs `sql` (one or more statements) and streams each result set's rows
/// in batches; `on_batch`'s second argument is true for the first batch
/// of a result set. Returns the last result set's row count, or the rows
/// the last statement changed when it returned none.
///
/// On a read-only connection each statement goes on its own, with
/// [`READ_ONLY`] again ahead of it: a stored function in one statement can
/// turn the session read-write (MariaDB lets it), and the next must still
/// be refused. Safe mode has refused unclear text there, so this split is
/// the server's.
pub async fn session_query_stream<F>(
    session: &mut MysqlSession,
    sql: &str,
    mut on_batch: F,
) -> Result<u64, DriverError>
where
    F: FnMut(RowBatch, bool) -> Result<(), DriverError>,
{
    // With safe mode on, statements go one at a time, as safe mode split
    // them, and after any that may change the session the client character
    // set is checked: under gbk and the like the server would read the
    // next one's quotes where safe mode didn't. A routine's body (`CREATE
    // … BEGIN …; END`) is the exception: split, it wouldn't run.
    let guard = session.config.safe_mode != SafeMode::Off;
    let texts = statement_texts(sql, Dialect::Mysql);
    let compound = texts.iter().any(|t| {
        let upper = t.trim_start().to_ascii_uppercase();
        upper.starts_with("CREATE")
            && upper
                .split(|c: char| !c.is_ascii_alphanumeric())
                .any(|w| w == "BEGIN")
    });
    let pieces = if session.config.safe_mode == SafeMode::ReadOnly || (guard && !compound) {
        texts
    } else {
        vec![sql]
    };
    let mut last = 0u64;
    for piece in pieces {
        last = stream_statements(session, piece, &mut on_batch).await?;
        if guard && !crate::safety::plain_read(piece, Dialect::Mysql) {
            keep_plain_charset(session).await?;
        }
    }
    Ok(last)
}

/// Puts the session back to utf8mb4 when its client character set isn't
/// one safe mode reads as the server does, and says so.
async fn keep_plain_charset(session: &mut MysqlSession) -> Result<(), DriverError> {
    let rows = text_rows(session, "SELECT @@SESSION.character_set_client").await?;
    let charset = rows
        .first()
        .and_then(|r| r.first().cloned().flatten())
        .unwrap_or_default();
    if crate::safety::mysql_plain_charset(&charset) {
        return Ok(());
    }
    session_execute(session, "SET NAMES utf8mb4").await?;
    Err(DriverError::Message(format!(
        "This set the session's character set to {charset}, in which MySQL reads quotes and backslashes differently from safe mode. Rowkery set it back to utf8mb4 and ran nothing after it."
    )))
}

async fn stream_statements<F>(
    session: &mut MysqlSession,
    sql: &str,
    on_batch: &mut F,
) -> Result<u64, DriverError>
where
    F: FnMut(RowBatch, bool) -> Result<(), DriverError>,
{
    read_only_ahead(session).await?;
    // A CALL ends with an OK of its own after the result sets it returned:
    // its count is the last result set's, not that OK's.
    let calls = statement_texts(sql, Dialect::Mysql)
        .last()
        .is_some_and(|s| s.get(..4).is_some_and(|w| w.eq_ignore_ascii_case("CALL")));
    let config = &session.config;
    let mut result = session
        .conn
        .query_iter(sql)
        .await
        .map_err(|e| map_error(e, config))?;
    let mut last = 0u64;
    let mut had_rows = false;
    loop {
        let Some(mut stream) = result
            .stream::<Row>()
            .await
            .map_err(|e| map_error(e, config))?
        else {
            break;
        };
        let cols = stream.columns();
        if cols.is_empty() {
            // A statement with no result set: what it changed.
            if !(calls && had_rows) {
                last = stream.affected_rows();
            }
        } else {
            let meta: Vec<Column> = cols.iter().map(column).collect();
            let kinds: Vec<Kind> = cols.iter().map(Kind::of).collect();
            let empty = || RowBatch {
                columns: meta.clone(),
                rows: Vec::new(),
            };
            let mut batch = empty();
            let mut first = true;
            let mut bytes = 0usize;
            let mut count = 0u64;
            let mut started = Instant::now();
            while let Some(row) = stream.try_next().await.map_err(|e| map_error(e, config))? {
                let cells: Vec<Value> = row
                    .unwrap_raw()
                    .into_iter()
                    .zip(&kinds)
                    .map(|(v, k)| k.value(v))
                    .collect();
                bytes += cells.iter().map(Value::heap_bytes).sum::<usize>();
                batch.rows.push(cells);
                count += 1;
                // A slow query shows its first rows without waiting for a
                // full batch.
                if batch.rows.len() >= BATCH_SIZE
                    || bytes >= BATCH_BYTES
                    || started.elapsed() >= Duration::from_millis(10)
                {
                    on_batch(std::mem::replace(&mut batch, empty()), first)?;
                    first = false;
                    bytes = 0;
                    started = Instant::now();
                }
            }
            if first || !batch.rows.is_empty() {
                on_batch(batch, first)?;
            }
            last = count;
            had_rows = true;
        }
    }
    Ok(last)
}

/// Runs one statement of a SQL file, any rows it returns read and dropped:
/// the rows the last result changed. A statement that is only a comment
/// to this server (a dump's MariaDB `/*M! … */` line, on MySQL) runs
/// nothing, as with the mysql client.
pub async fn session_run_file_statement(
    session: &mut MysqlSession,
    sql: &str,
) -> Result<u64, DriverError> {
    let config = &session.config;
    let mut result = match session.conn.query_iter(sql).await {
        Ok(result) => result,
        // ER_EMPTY_QUERY.
        Err(mysql_async::Error::Server(e)) if e.code == 1065 => return Ok(0),
        Err(e) => return Err(map_error(e, config)),
    };
    let mut last = 0;
    while let Some(mut stream) = result
        .stream::<Row>()
        .await
        .map_err(|e| map_error(e, config))?
    {
        if stream.columns().is_empty() {
            last = stream.affected_rows();
        } else {
            while stream
                .try_next()
                .await
                .map_err(|e| map_error(e, config))?
                .is_some()
            {}
        }
    }
    Ok(last)
}

/// What of this session changes how quotes or backslashes read, if
/// anything: an `sql_mode` flag (`ANSI_QUOTES`, `NO_BACKSLASH_ESCAPES`, …)
/// or a client character set in which `\` can end a character (`gbk`, …).
/// A SQL file is split without them. Said as "sql_mode has X" or
/// "character set is x".
pub async fn session_lexical_mode(
    session: &mut MysqlSession,
) -> Result<Option<String>, DriverError> {
    let rows = text_rows(
        session,
        "SELECT @@SESSION.sql_mode, @@SESSION.character_set_client",
    )
    .await?;
    let cell = |i: usize| {
        rows.first()
            .and_then(|r| r.get(i).cloned().flatten())
            .unwrap_or_default()
            .to_ascii_uppercase()
    };
    let mode = cell(0);
    if let Some(flag) = crate::sql_file::MYSQL_LEXICAL_MODES
        .iter()
        .find(|flag| mode.split(',').any(|m| m.starts_with(*flag)))
    {
        return Ok(Some(format!("sql_mode has {flag}")));
    }
    let charset = cell(1);
    Ok(crate::sql_file::MYSQL_LEXICAL_CHARSETS
        .contains(&charset.as_str())
        .then(|| format!("character set is {}", charset.to_ascii_lowercase())))
}

/// Before ⌘E: a transaction of its own, rolled back after, so what the
/// server evaluates while planning or timing (a function in a subquery)
/// keeps nothing. `read_only` (for a read) refuses any write outright;
/// the server won't explain a write in one, so a write's plan has a
/// read-write one. On MySQL 8.3+ also JSON plans in the form Rowkery
/// reads. Only outside a transaction: `START TRANSACTION` would commit the
/// user's. Returns what [`session_plan_end`] puts back.
pub async fn session_plan_begin(
    session: &mut MysqlSession,
    read_only: bool,
) -> Result<Option<u32>, DriverError> {
    let mut restore = None;
    if session.flavor == Flavor::Mysql {
        // Unknown before 8.3, where version 1 is the only form.
        let version = text_rows(session, "SELECT @@SESSION.explain_json_format_version")
            .await
            .ok()
            .and_then(|rows| {
                rows.first()?
                    .first()?
                    .as_deref()?
                    .trim()
                    .parse::<u32>()
                    .ok()
            });
        if let Some(v) = version.filter(|v| *v != 1) {
            session_execute(session, "SET SESSION explain_json_format_version = 1").await?;
            restore = Some(v);
        }
    }
    let begin = if read_only {
        "START TRANSACTION READ ONLY"
    } else {
        "START TRANSACTION"
    };
    if let Err(e) = session_execute(session, begin).await {
        session_plan_end(session, restore).await;
        return Err(e);
    }
    Ok(restore)
}

/// After ⌘E: rolls its transaction back and puts the session's plan
/// form back.
pub async fn session_plan_end(session: &mut MysqlSession, restore: Option<u32>) {
    let _ = session_execute(session, "ROLLBACK").await;
    if let Some(v) = restore {
        let _ = session_execute(
            session,
            &format!("SET SESSION explain_json_format_version = {v}"),
        )
        .await;
    }
}

/// Runs `sql`, no rows wanted.
pub async fn session_execute(session: &mut MysqlSession, sql: &str) -> Result<(), DriverError> {
    let config = &session.config;
    session
        .conn
        .query_drop(sql)
        .await
        .map_err(|e| map_error(e, config))
}

/// Runs staged row edits as one transaction on the tab's session: every
/// statement must change exactly one row (an UPDATE counts the row it
/// matched, changed or not), or the whole batch rolls back and the failure
/// names the statement. Never inside the user's own transaction (MySQL's
/// `START TRANSACTION` would commit it): that is refused untouched.
///
/// MySQL keeps no per-table counts, so what the batch writes beyond its
/// own rows is planned from the foreign keys before anything runs
/// ([`reach::my_plan`]): the target's rows, then each table the deletes
/// cascade into, are locked (`FOR UPDATE`, parents before children) and
/// counted. With the parents locked, no other session can add or move a
/// child until we end, so the counts are the rows the cascade writes.
/// Writes that can't be counted (a trigger, a loop) are named instead. The
/// batch stops before COMMIT unless that reach is exactly `approved`.
///
/// Each step gets `step` to answer. On a timeout the connection is killed
/// at the server (which rolls the transaction back) and the session is
/// marked [`MysqlSession::abandoned`] for the caller to drop. COMMIT has no
/// limit and is never retried.
pub async fn session_apply_changes_within(
    session: &mut MysqlSession,
    target: &Name,
    statements: &[RowStatement],
    step: Option<Duration>,
    approved: Option<&Reach>,
) -> Result<ApplyCounts, ApplyFailure> {
    let limit = step.unwrap_or(Duration::MAX);
    let late = |what: &str| {
        format!(
            "{what} didn't answer within {} s, so it was stopped and nothing was saved.",
            limit.as_secs()
        )
    };
    let open = match session.txn_known() {
        Some(open) => Some(open),
        None => session_probe_txn(session, limit).await,
    };
    match open {
        Some(false) => {}
        Some(true) => {
            return Err(ApplyFailure::other(
                "This tab has a transaction open. Commit or roll it back before saving edits.",
            ))
        }
        // Left unknown: the caller drops the session.
        None => return Err(ApplyFailure::other(late("The database"))),
    }
    // The catalog reads come first: inside the transaction the first plain
    // read would fix its snapshot before the rows are locked.
    let planned = match tokio::time::timeout(limit, my_plan_for(session, target, statements)).await
    {
        Ok(Ok(planned)) => planned,
        Ok(Err(err)) => {
            // With autocommit off the reads opened a transaction of ours.
            if session.in_transaction() {
                rollback(session, limit).await;
            }
            return Err(ApplyFailure::other(err.into_message()));
        }
        Err(_) => {
            abandon(session);
            return Err(ApplyFailure::other(late("The database")));
        }
    };
    match tokio::time::timeout(limit, session.conn.query_drop("START TRANSACTION")).await {
        Ok(Ok(())) => {}
        Ok(Err(err)) => return Err(ApplyFailure::other(humanize(session, &err))),
        Err(_) => {
            abandon(session);
            return Err(ApplyFailure::other(late("START TRANSACTION")));
        }
    }
    let reach = match tokio::time::timeout(limit, my_count(session, planned)).await {
        Ok(Ok(reach)) => reach,
        Ok(Err(err)) => {
            rollback(session, limit).await;
            return Err(ApplyFailure::other(err.into_message()));
        }
        Err(_) => {
            abandon(session);
            return Err(ApplyFailure::other(late("The database")));
        }
    };
    let mut counts = ApplyCounts::default();
    for (index, statement) in statements.iter().enumerate() {
        match tokio::time::timeout(limit, session.conn.query_drop(&statement.sql)).await {
            Err(_) => {
                abandon(session);
                let named = statement.describe();
                return Err(ApplyFailure {
                    index: Some(index),
                    message: late(&named),
                    statement: Some(named),
                    rows: None,
                    unknown: false,
                    reach: None,
                });
            }
            Ok(Err(err)) => {
                let message = humanize(session, &err);
                rollback(session, limit).await;
                return Err(ApplyFailure::error(index, statement, message));
            }
            Ok(Ok(())) => {
                let rows = match statement.verb {
                    Verb::Update => rows_matched(&session.conn.info())
                        .unwrap_or_else(|| session.conn.affected_rows()),
                    Verb::Insert | Verb::Delete => session.conn.affected_rows(),
                };
                if rows != 1 {
                    rollback(session, limit).await;
                    return Err(ApplyFailure::count(index, statement, rows));
                }
                counts.add(statement.verb, 1);
            }
        }
    }
    if !reach.is_empty() && approved != Some(&reach) {
        rollback(session, limit).await;
        return Err(ApplyFailure::reaches(reach));
    }
    if let Err(err) = session.conn.query_drop("COMMIT").await {
        // Refused by the server: nothing was saved. Anything else (the
        // socket went): it may have been.
        if !matches!(err, mysql_async::Error::Server(_)) {
            return Err(ApplyFailure::commit_lost());
        }
        let message = humanize(session, &err);
        rollback(session, limit).await;
        return Err(ApplyFailure::other(message));
    }
    Ok(counts)
}

fn humanize(session: &MysqlSession, err: &mysql_async::Error) -> String {
    humanize_mysql_error(err, &session.config)
}

/// Kills the session's connection at the server, which rolls its
/// transaction back (and stops a statement waiting on a lock), and marks
/// the session for dropping.
fn abandon(session: &mut MysqlSession) {
    session.abandoned = true;
    let via = session.cancel_via();
    tokio::spawn(async move {
        let _ = kill(via, "KILL").await;
    });
}

/// Bounded: a ROLLBACK that doesn't answer abandons the session.
async fn rollback(session: &mut MysqlSession, limit: Duration) {
    let bound = limit.min(Duration::from_secs(5));
    match tokio::time::timeout(bound, session.conn.query_drop("ROLLBACK")).await {
        Ok(Ok(())) => {}
        _ => abandon(session),
    }
}

/// An UPDATE's `Rows matched: 1  Changed: 0  Warnings: 0`: the first
/// number, which is the matched rows in every language the server speaks.
pub(crate) fn rows_matched(info: &str) -> Option<u64> {
    let start = info.find(|c: char| c.is_ascii_digit())?;
    let digits: String = info[start..]
        .chars()
        .take_while(char::is_ascii_digit)
        .collect();
    digits.parse().ok()
}

/// The most tables a cascade walk loads keys for before giving up counting.
const MAX_REACH_TABLES: usize = 200;

/// A reach plan and the rows the batch's DELETEs name.
struct Planned {
    target: Name,
    deleted: Option<String>,
    plan: MyPlan,
}

/// `select` (a SELECT) without the session's `sql_select_limit`, which
/// would cut a catalog read or a count short (or to nothing).
fn unlimited(session: &MysqlSession, select: &str) -> String {
    const ALL: &str = "18446744073709551615";
    match session.flavor {
        Flavor::Mariadb => format!("SET STATEMENT sql_select_limit = {ALL} FOR {select}"),
        Flavor::Mysql => {
            let rest = select.strip_prefix("SELECT ").unwrap_or(select);
            format!("SELECT /*+ SET_VAR(sql_select_limit = {ALL}) */ {rest}")
        }
    }
}

pub(crate) async fn select_text(
    session: &mut MysqlSession,
    select: &str,
) -> Result<Vec<Vec<Option<String>>>, DriverError> {
    let sql = unlimited(session, select);
    text_rows(session, &sql).await
}

/// What the batch can write beyond its own rows, from the catalog: the
/// keys it cascades through (none while the tab has `foreign_key_checks`
/// off: InnoDB cascades nothing then) and the target's triggers.
async fn my_plan_for(
    session: &mut MysqlSession,
    target: &Name,
    statements: &[RowStatement],
) -> Result<Planned, DriverError> {
    let deletes: Vec<&str> = statements
        .iter()
        .filter(|s| s.verb == Verb::Delete)
        .filter_map(|s| s.predicate.as_deref())
        .collect();
    let deleted = match deletes.as_slice() {
        [] => None,
        [one] => Some(one.to_string()),
        many => Some(
            many.iter()
                .map(|p| format!("({p})"))
                .collect::<Vec<_>>()
                .join(" OR "),
        ),
    };
    let mut changed: Vec<String> = Vec::new();
    for s in statements.iter().filter(|s| s.verb == Verb::Update) {
        for c in &s.set {
            if !changed.contains(c) {
                changed.push(c.clone());
            }
        }
    }
    let settings = select_text(
        session,
        "SELECT @@foreign_key_checks, @@lower_case_table_names",
    )
    .await?;
    let setting = |i: usize| settings.first().map(|r| cell(r, i)).unwrap_or_default();
    let cascades = setting(0) != "0";
    // Names compare without case when the server stores them so.
    let fold = setting(1) != "0";
    let name = |n: &Name| {
        if fold {
            (n.0.to_lowercase(), n.1.to_lowercase())
        } else {
            n.clone()
        }
    };
    // The catalog's own spelling, for information_schema.
    let (db, table) = (mysql_text(&target.0), mysql_text(&target.1));
    // Several statements are one change only if the table can roll back.
    if statements.len() > 1 {
        let engine = select_text(
            session,
            &format!(
                "SELECT t.ENGINE FROM information_schema.TABLES t \
                 JOIN information_schema.ENGINES e ON e.ENGINE = t.ENGINE \
                 WHERE t.TABLE_SCHEMA = {db} AND t.TABLE_NAME = {table} \
                 AND COALESCE(e.TRANSACTIONS, 'NO') <> 'YES'"
            ),
        )
        .await?;
        if let Some(engine) = engine.first().map(|r| cell(r, 0)) {
            return Err(DriverError::Message(format!(
                "{} is a {engine} table, which can't roll back, so these changes can't be saved as one. Commit them one row at a time.",
                target.1
            )));
        }
    }
    let target = name(target);
    // The keys out of the target and every table they reach, a level per
    // round.
    let mut keys: Vec<MyForeignKey> = Vec::new();
    let mut loaded: Vec<Name> = Vec::new();
    let mut next = if cascades && (deleted.is_some() || !changed.is_empty()) {
        vec![target.clone()]
    } else {
        Vec::new()
    };
    while !next.is_empty() && loaded.len() < MAX_REACH_TABLES {
        let found = cascading_keys(session, &next).await?;
        loaded.append(&mut next);
        for mut key in found {
            key.child = name(&key.child);
            key.parent = name(&key.parent);
            if !loaded.contains(&key.child) && !next.contains(&key.child) {
                next.push(key.child.clone());
            }
            keys.push(key);
        }
    }
    let mut plan = if next.is_empty() {
        reach::my_plan(&target, deleted.as_deref(), &changed, &keys)
    } else {
        // Too far to follow: name what was seen, count nothing.
        let mut all: Vec<String> = loaded.iter().chain(&next).map(reach::my_name).collect();
        all.sort();
        all.dedup();
        MyPlan {
            steps: Vec::new(),
            uncounted: all,
        }
    };
    // A trigger on the target writes what it likes. Cascaded rows fire
    // none (InnoDB), so the target's are the only ones.
    let verbs: Vec<&str> = statements
        .iter()
        .map(|s| match s.verb {
            Verb::Insert => "'INSERT'",
            Verb::Update => "'UPDATE'",
            Verb::Delete => "'DELETE'",
        })
        .collect();
    let triggers = select_text(
        session,
        &format!(
            "SELECT 1 FROM information_schema.TRIGGERS \
             WHERE EVENT_OBJECT_SCHEMA = {db} AND EVENT_OBJECT_TABLE = {table} \
             AND EVENT_MANIPULATION IN ({}) LIMIT 1",
            verbs.join(", ")
        ),
    )
    .await?;
    if !triggers.is_empty() {
        plan.uncounted
            .insert(0, format!("triggers on {}", reach::my_name(&target)));
    } else {
        // information_schema shows triggers only to a login with the
        // TRIGGER privilege on the table: without it, there may be some.
        const ME: &str = "CONCAT('''', SUBSTRING_INDEX(CURRENT_USER(), '@', 1), '''@''', SUBSTRING_INDEX(CURRENT_USER(), '@', -1), '''')";
        let sees = select_text(
            session,
            &format!(
                "SELECT 1 FROM information_schema.USER_PRIVILEGES \
                 WHERE PRIVILEGE_TYPE = 'TRIGGER' AND GRANTEE = {ME} \
                 UNION ALL SELECT 1 FROM information_schema.SCHEMA_PRIVILEGES \
                 WHERE PRIVILEGE_TYPE = 'TRIGGER' AND GRANTEE = {ME} AND TABLE_SCHEMA = {db} \
                 UNION ALL SELECT 1 FROM information_schema.TABLE_PRIVILEGES \
                 WHERE PRIVILEGE_TYPE = 'TRIGGER' AND GRANTEE = {ME} AND TABLE_SCHEMA = {db} \
                 AND TABLE_NAME = {table}"
            ),
        )
        .await?;
        if sees.is_empty() {
            plan.uncounted.insert(
                0,
                format!(
                    "any triggers on {} this login can't see",
                    reach::my_name(&target)
                ),
            );
        }
    }
    Ok(Planned {
        target,
        deleted,
        plan,
    })
}

/// The plan's counts, with the rows locked: the target's, then each
/// level's, parents before children (see [`session_apply_changes_within`]).
/// Runs inside the batch's transaction, before its statements.
async fn my_count(session: &mut MysqlSession, planned: Planned) -> Result<Reach, DriverError> {
    let Planned {
        target,
        deleted,
        plan,
    } = planned;
    let mut tables = Vec::new();
    if let (Some(deleted), false) = (&deleted, plan.steps.is_empty()) {
        let table = super::qualified_table_sql(super::EngineKind::Mysql, &target.0, &target.1);
        let lock = unlimited(
            session,
            &format!("SELECT 1 FROM {table} WHERE {deleted} FOR UPDATE"),
        );
        session_execute(session, &lock).await?;
        for step in &plan.steps {
            let table =
                super::qualified_table_sql(super::EngineKind::Mysql, &step.table.0, &step.table.1);
            let rows = select_text(
                session,
                &format!(
                    "SELECT COUNT(*) FROM {table} WHERE {} FOR UPDATE",
                    step.predicate
                ),
            )
            .await?;
            let n: u64 = rows
                .first()
                .map(|r| cell(r, 0))
                .and_then(|n| n.parse().ok())
                .ok_or_else(|| DriverError::Message("The server didn't count the rows".into()))?;
            if n == 0 {
                continue;
            }
            let (updated, deleted) = match step.write {
                MyWrite::Delete => (0, n),
                MyWrite::Update(_) => (n, 0),
            };
            tables.push(TableRows {
                schema: step.table.0.clone(),
                table: step.table.1.clone(),
                inserted: 0,
                updated,
                deleted,
            });
        }
    }
    tables.sort();
    Ok(Reach {
        tables,
        unnamed: 0,
        uncounted: plan.uncounted,
    })
}

/// The keys that cascade or set NULL out of `parents`, columns in order.
async fn cascading_keys(
    session: &mut MysqlSession,
    parents: &[Name],
) -> Result<Vec<MyForeignKey>, DriverError> {
    let pairs: Vec<String> = parents
        .iter()
        .map(|(s, t)| format!("({}, {})", mysql_text(s), mysql_text(t)))
        .collect();
    let rows = select_text(
        session,
        &format!(
            "SELECT k.TABLE_SCHEMA, k.TABLE_NAME, k.CONSTRAINT_NAME, k.COLUMN_NAME, \
               k.REFERENCED_TABLE_SCHEMA, k.REFERENCED_TABLE_NAME, k.REFERENCED_COLUMN_NAME, \
               rc.DELETE_RULE, rc.UPDATE_RULE \
             FROM information_schema.KEY_COLUMN_USAGE k \
             JOIN information_schema.REFERENTIAL_CONSTRAINTS rc \
               ON rc.CONSTRAINT_SCHEMA = k.CONSTRAINT_SCHEMA AND rc.CONSTRAINT_NAME = k.CONSTRAINT_NAME \
               AND rc.TABLE_NAME = k.TABLE_NAME \
             WHERE (k.REFERENCED_TABLE_SCHEMA, k.REFERENCED_TABLE_NAME) IN ({}) \
               AND (rc.DELETE_RULE IN ('CASCADE', 'SET NULL') OR rc.UPDATE_RULE IN ('CASCADE', 'SET NULL')) \
             ORDER BY k.TABLE_SCHEMA, k.TABLE_NAME, k.CONSTRAINT_NAME, k.ORDINAL_POSITION",
            pairs.join(", ")
        ),
    )
    .await?;
    let mut keys: Vec<(String, MyForeignKey)> = Vec::new();
    for r in &rows {
        let child = (cell(r, 0), cell(r, 1));
        let name = cell(r, 2);
        match keys.last_mut() {
            Some((n, key)) if *n == name && key.child == child => {
                key.child_columns.push(cell(r, 3));
                key.parent_columns.push(cell(r, 6));
            }
            _ => keys.push((
                name,
                MyForeignKey {
                    child,
                    child_columns: vec![cell(r, 3)],
                    parent: (cell(r, 4), cell(r, 5)),
                    parent_columns: vec![cell(r, 6)],
                    on_delete: MyRule::parse(&cell(r, 7)),
                    on_update: MyRule::parse(&cell(r, 8)),
                },
            )),
        }
    }
    Ok(keys.into_iter().map(|(_, k)| k).collect())
}

/// How a column's text-protocol cells become [`Value`]s.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Kind {
    Int,
    /// `BIGINT UNSIGNED`: an Int while it fits, else its digits.
    UInt,
    Float,
    /// `BIT(n)`: big-endian bytes, as an Int.
    Bit,
    Bytes,
    Text,
}

impl Kind {
    fn of(col: &mysql_async::Column) -> Kind {
        use ColumnType::*;
        let binary = col.character_set() == 63;
        let unsigned = col.flags().contains(ColumnFlags::UNSIGNED_FLAG);
        match col.column_type() {
            MYSQL_TYPE_LONGLONG if unsigned => Kind::UInt,
            MYSQL_TYPE_TINY | MYSQL_TYPE_SHORT | MYSQL_TYPE_LONG | MYSQL_TYPE_INT24
            | MYSQL_TYPE_LONGLONG | MYSQL_TYPE_YEAR => Kind::Int,
            MYSQL_TYPE_FLOAT | MYSQL_TYPE_DOUBLE => Kind::Float,
            MYSQL_TYPE_BIT => Kind::Bit,
            // JSON comes with the binary charset, and is text.
            MYSQL_TYPE_JSON => Kind::Text,
            MYSQL_TYPE_GEOMETRY | MYSQL_TYPE_VECTOR => Kind::Bytes,
            MYSQL_TYPE_TINY_BLOB
            | MYSQL_TYPE_MEDIUM_BLOB
            | MYSQL_TYPE_LONG_BLOB
            | MYSQL_TYPE_BLOB
            | MYSQL_TYPE_VAR_STRING
            | MYSQL_TYPE_STRING
            | MYSQL_TYPE_VARCHAR
                if binary =>
            {
                Kind::Bytes
            }
            // DECIMAL stays exact as its digits; dates and times as the
            // server writes them (`0000-00-00` included).
            _ => Kind::Text,
        }
    }

    fn value(self, raw: Option<mysql_async::Value>) -> Value {
        let bytes = match raw {
            None | Some(mysql_async::Value::NULL) => return Value::Null,
            Some(mysql_async::Value::Bytes(b)) => b,
            // The text protocol sends bytes; anything else as itself.
            Some(mysql_async::Value::Int(n)) => return Value::Int(n),
            Some(mysql_async::Value::UInt(n)) => return uint(n),
            Some(mysql_async::Value::Float(f)) => return Value::Float(f.into()),
            Some(mysql_async::Value::Double(f)) => return Value::Float(f),
            Some(other) => return Value::Text(other.as_sql(true).trim_matches('\'').to_string()),
        };
        let text = || std::str::from_utf8(&bytes).ok();
        match self {
            Kind::Int => text()
                .and_then(|t| t.parse().ok())
                .map_or_else(|| as_text(bytes.clone()), Value::Int),
            Kind::UInt => text()
                .and_then(|t| t.parse().ok())
                .map_or_else(|| as_text(bytes.clone()), uint),
            Kind::Float => text()
                .and_then(|t| t.parse().ok())
                .map_or_else(|| as_text(bytes.clone()), Value::Float),
            Kind::Bit if bytes.len() <= 8 => {
                uint(bytes.iter().fold(0u64, |n, b| (n << 8) | u64::from(*b)))
            }
            Kind::Bit | Kind::Bytes => Value::Bytes(bytes),
            Kind::Text => as_text(bytes),
        }
    }
}

/// `'it''s'` as `it's`; `None` unless `sql` is one quoted literal.
fn unquote_literal(sql: &str) -> Option<String> {
    let inner = sql.strip_prefix('\'')?.strip_suffix('\'')?;
    // A lone quote inside: more than one literal (or not one at all).
    if inner.replace("''", "").contains('\'') || inner.contains('\\') {
        return None;
    }
    Some(inner.replace("''", "'"))
}

fn uint(n: u64) -> Value {
    i64::try_from(n).map_or_else(|_| Value::Text(n.to_string()), Value::Int)
}

/// UTF-8 text; bytes that aren't stay bytes, never changed.
fn as_text(bytes: Vec<u8>) -> Value {
    match String::from_utf8(bytes) {
        Ok(t) => Value::Text(t),
        Err(e) => Value::Bytes(e.into_bytes()),
    }
}

/// A result column's name and the type the grid shows for it.
fn column(col: &mysql_async::Column) -> Column {
    Column {
        name: col.name_str().into_owned(),
        type_name: type_name(col),
    }
}

/// The column's type as a person writes it: `int`, `bigint unsigned`,
/// `varchar`, `blob`. The text protocol doesn't say a column's length or
/// whether `TEXT` was `MEDIUMTEXT`, so these are the base names.
fn type_name(col: &mysql_async::Column) -> String {
    use ColumnType::*;
    let binary = col.character_set() == 63;
    let flags = col.flags();
    let base = match col.column_type() {
        MYSQL_TYPE_TINY => "tinyint",
        MYSQL_TYPE_SHORT => "smallint",
        MYSQL_TYPE_INT24 => "mediumint",
        MYSQL_TYPE_LONG => "int",
        MYSQL_TYPE_LONGLONG => "bigint",
        MYSQL_TYPE_FLOAT => "float",
        MYSQL_TYPE_DOUBLE => "double",
        MYSQL_TYPE_DECIMAL | MYSQL_TYPE_NEWDECIMAL => "decimal",
        MYSQL_TYPE_BIT => "bit",
        MYSQL_TYPE_YEAR => "year",
        MYSQL_TYPE_DATE | MYSQL_TYPE_NEWDATE => "date",
        MYSQL_TYPE_TIME | MYSQL_TYPE_TIME2 => "time",
        MYSQL_TYPE_DATETIME | MYSQL_TYPE_DATETIME2 => "datetime",
        MYSQL_TYPE_TIMESTAMP | MYSQL_TYPE_TIMESTAMP2 => "timestamp",
        MYSQL_TYPE_JSON => "json",
        MYSQL_TYPE_GEOMETRY => "geometry",
        MYSQL_TYPE_VECTOR => "vector",
        MYSQL_TYPE_ENUM => "enum",
        MYSQL_TYPE_SET => "set",
        _ if flags.contains(ColumnFlags::ENUM_FLAG) => "enum",
        _ if flags.contains(ColumnFlags::SET_FLAG) => "set",
        MYSQL_TYPE_TINY_BLOB | MYSQL_TYPE_MEDIUM_BLOB | MYSQL_TYPE_LONG_BLOB | MYSQL_TYPE_BLOB => {
            if binary {
                "blob"
            } else {
                "text"
            }
        }
        MYSQL_TYPE_STRING => {
            if binary {
                "binary"
            } else {
                "char"
            }
        }
        MYSQL_TYPE_VAR_STRING | MYSQL_TYPE_VARCHAR => {
            if binary {
                "varbinary"
            } else {
                "varchar"
            }
        }
        MYSQL_TYPE_NULL => "null",
        _ => "unknown",
    };
    let numeric = matches!(
        col.column_type(),
        MYSQL_TYPE_TINY
            | MYSQL_TYPE_SHORT
            | MYSQL_TYPE_INT24
            | MYSQL_TYPE_LONG
            | MYSQL_TYPE_LONGLONG
            | MYSQL_TYPE_FLOAT
            | MYSQL_TYPE_DOUBLE
            | MYSQL_TYPE_DECIMAL
            | MYSQL_TYPE_NEWDECIMAL
    );
    if numeric && flags.contains(ColumnFlags::UNSIGNED_FLAG) {
        format!("{base} unsigned")
    } else {
        base.to_string()
    }
}

/// Rows of one catalog query, each cell as text (NULL: `None`).
pub(crate) async fn text_rows(
    session: &mut MysqlSession,
    sql: &str,
) -> Result<Vec<Vec<Option<String>>>, DriverError> {
    let config = &session.config;
    let rows: Vec<Row> = session
        .conn
        .query(sql)
        .await
        .map_err(|e| map_error(e, config))?;
    Ok(rows
        .into_iter()
        .map(|row| {
            row.unwrap_raw()
                .into_iter()
                .map(|v| match v {
                    None | Some(mysql_async::Value::NULL) => None,
                    Some(mysql_async::Value::Bytes(b)) => {
                        Some(String::from_utf8_lossy(&b).into_owned())
                    }
                    Some(v) => Some(v.as_sql(true).trim_matches('\'').to_string()),
                })
                .collect()
        })
        .collect())
}

pub(crate) fn cell(row: &[Option<String>], i: usize) -> String {
    row.get(i).cloned().flatten().unwrap_or_default()
}

/// The server's databases (minus its own) as schemas of [`CATALOG`], with
/// their tables, views, columns, keys, indexes and foreign keys, from
/// `information_schema`. Row counts are the server's estimates.
pub async fn session_introspect(session: &mut MysqlSession) -> Result<SchemaCatalog, DriverError> {
    let mariadb = session.flavor == Flavor::Mariadb;
    let where_schema = format!("NOT IN ({SYSTEM_SCHEMAS})");
    let schemas = text_rows(
        session,
        &format!(
            "SELECT SCHEMA_NAME FROM information_schema.SCHEMATA \
             WHERE SCHEMA_NAME {where_schema} ORDER BY SCHEMA_NAME"
        ),
    )
    .await?;
    let tables = text_rows(
        session,
        &format!(
            "SELECT TABLE_SCHEMA, TABLE_NAME, TABLE_TYPE, TABLE_ROWS, DATA_LENGTH, INDEX_LENGTH, \
             TABLE_COMMENT FROM information_schema.TABLES WHERE TABLE_SCHEMA {where_schema} \
             ORDER BY TABLE_SCHEMA, TABLE_NAME"
        ),
    )
    .await?;
    let columns = text_rows(
        session,
        &format!(
            "SELECT TABLE_SCHEMA, TABLE_NAME, COLUMN_NAME, COLUMN_TYPE, IS_NULLABLE, \
             COLUMN_DEFAULT, COLUMN_COMMENT FROM information_schema.COLUMNS \
             WHERE TABLE_SCHEMA {where_schema} \
             ORDER BY TABLE_SCHEMA, TABLE_NAME, ORDINAL_POSITION"
        ),
    )
    .await?;
    let indexes = text_rows(
        session,
        &format!(
            "SELECT TABLE_SCHEMA, TABLE_NAME, INDEX_NAME, NON_UNIQUE, COLUMN_NAME, INDEX_TYPE \
             FROM information_schema.STATISTICS WHERE TABLE_SCHEMA {where_schema} \
             ORDER BY TABLE_SCHEMA, TABLE_NAME, INDEX_NAME, SEQ_IN_INDEX"
        ),
    )
    .await?;
    let foreign_keys = text_rows(
        session,
        &format!(
            "SELECT k.TABLE_SCHEMA, k.TABLE_NAME, k.CONSTRAINT_NAME, k.COLUMN_NAME, \
             k.REFERENCED_TABLE_SCHEMA, k.REFERENCED_TABLE_NAME, k.REFERENCED_COLUMN_NAME, \
             r.DELETE_RULE \
             FROM information_schema.KEY_COLUMN_USAGE k \
             JOIN information_schema.REFERENTIAL_CONSTRAINTS r \
               ON r.CONSTRAINT_SCHEMA = k.CONSTRAINT_SCHEMA \
              AND r.CONSTRAINT_NAME = k.CONSTRAINT_NAME AND r.TABLE_NAME = k.TABLE_NAME \
             WHERE k.TABLE_SCHEMA {where_schema} AND k.REFERENCED_TABLE_NAME IS NOT NULL \
             ORDER BY k.TABLE_SCHEMA, k.TABLE_NAME, k.CONSTRAINT_NAME, k.ORDINAL_POSITION"
        ),
    )
    .await?;
    let functions = text_rows(
        session,
        &format!(
            "SELECT r.ROUTINE_SCHEMA, r.ROUTINE_NAME, r.DTD_IDENTIFIER, r.SPECIFIC_NAME \
             FROM information_schema.ROUTINES r \
             WHERE r.ROUTINE_TYPE = 'FUNCTION' AND r.ROUTINE_SCHEMA {where_schema} \
             ORDER BY r.ROUTINE_SCHEMA, r.ROUTINE_NAME"
        ),
    )
    .await?;
    // Joined here, not with GROUP_CONCAT: that stops at the session's
    // `group_concat_max_len` (1024 bytes unless raised).
    let parameters = text_rows(
        session,
        &format!(
            "SELECT p.SPECIFIC_SCHEMA, p.SPECIFIC_NAME, \
               CONCAT(p.PARAMETER_NAME, ' ', p.DTD_IDENTIFIER) \
             FROM information_schema.PARAMETERS p \
             WHERE p.ROUTINE_TYPE = 'FUNCTION' AND p.ORDINAL_POSITION > 0 \
               AND p.SPECIFIC_SCHEMA {where_schema} \
             ORDER BY p.SPECIFIC_SCHEMA, p.SPECIFIC_NAME, p.ORDINAL_POSITION"
        ),
    )
    .await?;
    let mut args: HashMap<(String, String), Vec<String>> = HashMap::new();
    for r in &parameters {
        args.entry((cell(r, 0), cell(r, 1)))
            .or_default()
            .push(cell(r, 2));
    }
    let current = text_rows(session, "SELECT DATABASE()").await?;

    let mut out: Vec<SchemaNode> = schemas
        .iter()
        .map(|r| SchemaNode {
            name: cell(r, 0),
            tables: Vec::new(),
        })
        .collect();
    let schema_at: HashMap<String, usize> = out
        .iter()
        .enumerate()
        .map(|(i, s)| (s.name.clone(), i))
        .collect();
    // Where each table went, for the rows about its columns and keys.
    let mut table_at: HashMap<(String, String), (usize, usize)> = HashMap::new();
    for r in &tables {
        let Some(&s) = schema_at.get(&cell(r, 0)) else {
            continue;
        };
        table_at.insert((cell(r, 0), cell(r, 1)), (s, out[s].tables.len()));
        let kind = match cell(r, 2).as_str() {
            "VIEW" | "SYSTEM VIEW" => TableKind::View,
            _ => TableKind::Table,
        };
        let int = |i: usize| {
            r.get(i)
                .cloned()
                .flatten()
                .and_then(|t| t.parse::<i64>().ok())
        };
        let comment = cell(r, 6);
        out[s].tables.push(TableNode {
            name: cell(r, 1),
            kind,
            columns: Vec::new(),
            primary_key: Vec::new(),
            indexes: Vec::new(),
            row_estimate: match (kind, int(3)) {
                (TableKind::Table, Some(n)) => RowEstimate::Approximate(n.max(0) as u64),
                _ => RowEstimate::Unknown,
            },
            partition_of: None,
            inherits_from: Vec::new(),
            is_partition: false,
            foreign_keys: Vec::new(),
            table_bytes: int(4),
            index_bytes: int(5),
            indexes_deferred: false,
            // A view's comment is the word VIEW.
            comment: (!comment.is_empty() && kind == TableKind::Table).then_some(comment),
        });
    }
    let table = |r: &[Option<String>]| table_at.get(&(cell(r, 0), cell(r, 1))).copied();
    for r in &columns {
        let Some((s, t)) = table(r) else {
            continue;
        };
        let default = r.get(5).cloned().flatten();
        // MariaDB writes a default as SQL (`'abc'`, `NULL`); MySQL as the
        // value, which both show.
        let default = match default {
            Some(d) if mariadb && d == "NULL" => None,
            Some(d) if mariadb => Some(unquote_literal(&d).unwrap_or(d)),
            d => d,
        };
        let comment = cell(r, 6);
        out[s].tables[t].columns.push(ColumnNode {
            name: cell(r, 2),
            type_name: cell(r, 3),
            nullable: cell(r, 4) == "YES",
            default,
            comment: (!comment.is_empty()).then_some(comment),
        });
    }
    for r in &indexes {
        let Some((s, t)) = table(r) else {
            continue;
        };
        let name = cell(r, 2);
        // A functional key part has no column (MySQL 8 shows NULL).
        let column = r
            .get(4)
            .cloned()
            .flatten()
            .unwrap_or_else(|| "(expression)".into());
        let node = &mut out[s].tables[t];
        if name == "PRIMARY" {
            node.primary_key.push(column.clone());
        }
        match node.indexes.iter_mut().find(|i| i.name == name) {
            Some(index) => index.columns.push(column),
            None => node.indexes.push(IndexNode {
                primary: name == "PRIMARY",
                unique: cell(r, 3) == "0",
                method: Some(cell(r, 5).to_ascii_lowercase()),
                name,
                columns: vec![column],
                size_bytes: None,
                scans: None,
            }),
        }
    }
    for r in &foreign_keys {
        let Some((s, t)) = table(r) else {
            continue;
        };
        let name = cell(r, 2);
        let node = &mut out[s].tables[t];
        match node.foreign_keys.iter_mut().find(|f| f.name == name) {
            Some(fk) => {
                fk.columns.push(cell(r, 3));
                fk.ref_columns.push(cell(r, 6));
            }
            None => node.foreign_keys.push(ForeignKeyNode {
                name,
                columns: vec![cell(r, 3)],
                ref_schema: cell(r, 4),
                ref_table: cell(r, 5),
                ref_columns: vec![cell(r, 6)],
                on_delete: cell(r, 7),
            }),
        }
    }
    Ok(SchemaCatalog {
        databases: vec![DatabaseNode {
            name: CATALOG.into(),
            schemas: out,
        }],
        search_path: current
            .first()
            .and_then(|r| r.first().cloned().flatten())
            .into_iter()
            .collect(),
        enums: Vec::new(),
        functions: functions
            .iter()
            .map(|r| FunctionNode {
                schema: cell(r, 0),
                name: cell(r, 1),
                args: args
                    .get(&(cell(r, 0), cell(r, 3)))
                    .map(|a| a.join(", "))
                    .unwrap_or_default(),
                returns: cell(r, 2),
            })
            .collect(),
        derived: Default::default(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_server_says_which_it_is() {
        assert_eq!(parse_version("8.4.3"), (Flavor::Mysql, "8.4.3".into()));
        assert_eq!(
            parse_version("11.4.2-MariaDB-ubu2404"),
            (Flavor::Mariadb, "11.4.2".into())
        );
        assert_eq!(
            parse_version("5.5.5-10.11.6-MariaDB-log"),
            (Flavor::Mariadb, "10.11.6".into())
        );
        assert_eq!(
            parse_version("8.0.36-0ubuntu0.22.04.1"),
            (Flavor::Mysql, "8.0.36".into())
        );
    }

    #[test]
    fn cells_keep_their_type() {
        let b = |s: &str| Some(mysql_async::Value::Bytes(s.as_bytes().to_vec()));
        assert_eq!(Kind::Int.value(b("-42")), Value::Int(-42));
        assert_eq!(
            Kind::UInt.value(b("18446744073709551615")),
            Value::Text("18446744073709551615".into())
        );
        assert_eq!(Kind::UInt.value(b("7")), Value::Int(7));
        assert_eq!(Kind::Float.value(b("1.5")), Value::Float(1.5));
        assert_eq!(Kind::Text.value(b("12.50")), Value::Text("12.50".into()));
        assert_eq!(Kind::Text.value(None), Value::Null);
        assert_eq!(
            Kind::Bit.value(Some(mysql_async::Value::Bytes(vec![1, 0]))),
            Value::Int(256)
        );
        // A BIT(64) with its top bit set is unsigned, as `b + 0` reads it.
        assert_eq!(
            Kind::Bit.value(Some(mysql_async::Value::Bytes(vec![0xff; 8]))),
            Value::Text("18446744073709551615".into())
        );
        assert_eq!(unquote_literal("'it''s'").as_deref(), Some("it's"));
        assert_eq!(unquote_literal("'a' + 'b'"), None);
        assert_eq!(unquote_literal("current_timestamp()"), None);
        assert_eq!(
            Kind::Text.value(Some(mysql_async::Value::Bytes(vec![0xff]))),
            Value::Bytes(vec![0xff])
        );
    }
}
