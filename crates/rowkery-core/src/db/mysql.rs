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
use crate::route::{self, Route};
use crate::safety::SafeMode;
use crate::secrets::{get_secret, ConnectionSecrets, SecretKind};

use super::introspect::{
    ColumnNode, DatabaseNode, ForeignKeyNode, FunctionNode, IndexNode, RowEstimate, SchemaCatalog,
    SchemaNode, TableKind, TableNode,
};
use super::{Column, DriverError, RowBatch, Value, BATCH_BYTES};

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
    /// In its `program_name` connect attribute, after `Rowkery `.
    tag: String,
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

    /// Names this session's connection in `performance_schema`
    /// (`program_name` = `Rowkery <tag>`).
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
        self.conn.last_ok_packet().is_some_and(|ok| {
            ok.status_flags()
                .contains(mysql_async::consts::StatusFlags::SERVER_STATUS_IN_TRANS)
        })
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
    let tag = super::postgres::new_tag();
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
            .connect_attribute(
                "program_name",
                format!("{} {tag}", super::postgres::APP_NAME),
            )
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
    let full: Option<String> =
        tokio::time::timeout_at(deadline, conn.query_first("SELECT VERSION()"))
            .await
            .map_err(|_| late())?
            .map_err(|e| map_error(e, &config))?;
    let (flavor, version) = parse_version(full.as_deref().unwrap_or_default());
    Ok(MysqlSession {
        config,
        connection_id,
        route,
        conn,
        opts,
        flavor,
        version,
        tag,
    })
}

/// What makes a read-only connection's sessions read-only at the server:
/// each transaction after it starts read-only, autocommit statements too.
const READ_ONLY: &str = "SET SESSION TRANSACTION READ ONLY";

/// Whether a run sends [`READ_ONLY`] ahead of itself. A stored function
/// can turn the session's access mode back (MariaDB lets it), so it is set
/// again before every run on a read-only connection. A transaction already
/// open keeps the mode it started with: the user's `BEGIN` got one too.
fn read_only_ahead(session: &MysqlSession) -> bool {
    session.config.safe_mode == SafeMode::ReadOnly && !session.in_transaction()
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
    let mut conn = tokio::time::timeout(CONNECT_TIMEOUT, Conn::new(via.opts.clone()))
        .await
        .map_err(|_| DriverError::Message("The server didn't take the cancel in time".into()))?
        .map_err(|e| DriverError::Message(e.to_string()))?;
    let killed = conn
        .query_drop(format!("KILL QUERY {}", via.thread_id))
        .await
        .map_err(|e| DriverError::Message(e.to_string()));
    let _ = conn.disconnect().await;
    killed
}

/// Runs `sql` (one or more statements) and streams each result set's rows
/// in batches; `on_batch`'s second argument is true for the first batch
/// of a result set. Returns the last result set's row count, or the rows
/// the last statement changed when it returned none.
pub async fn session_query_stream<F>(
    session: &mut MysqlSession,
    sql: &str,
    mut on_batch: F,
) -> Result<u64, DriverError>
where
    F: FnMut(RowBatch, bool) -> Result<(), DriverError>,
{
    if read_only_ahead(session) {
        session
            .conn
            .query_drop(READ_ONLY)
            .await
            .map_err(|e| map_error(e, &session.config))?;
    }
    let config = &session.config;
    let mut result = session
        .conn
        .query_iter(sql)
        .await
        .map_err(|e| map_error(e, config))?;
    let mut last = 0u64;
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
            last = stream.affected_rows();
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
        }
    }
    Ok(last)
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
                Value::Int(bytes.iter().fold(0i64, |n, b| (n << 8) | i64::from(*b)))
            }
            Kind::Bit | Kind::Bytes => Value::Bytes(bytes),
            Kind::Text => as_text(bytes),
        }
    }
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
async fn text_rows(
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

fn cell(row: &[Option<String>], i: usize) -> String {
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
            "SELECT r.ROUTINE_SCHEMA, r.ROUTINE_NAME, r.DTD_IDENTIFIER, \
             (SELECT GROUP_CONCAT(CONCAT(p.PARAMETER_NAME, ' ', p.DTD_IDENTIFIER) \
                ORDER BY p.ORDINAL_POSITION SEPARATOR ', ') \
              FROM information_schema.PARAMETERS p \
              WHERE p.SPECIFIC_SCHEMA = r.ROUTINE_SCHEMA AND p.SPECIFIC_NAME = r.SPECIFIC_NAME \
                AND p.ORDINAL_POSITION > 0) \
             FROM information_schema.ROUTINES r \
             WHERE r.ROUTINE_TYPE = 'FUNCTION' AND r.ROUTINE_SCHEMA {where_schema} \
             ORDER BY r.ROUTINE_SCHEMA, r.ROUTINE_NAME"
        ),
    )
    .await?;
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
        // MariaDB writes a default as SQL (`'abc'`, `NULL`); MySQL as the value.
        let default = match default {
            Some(d) if mariadb && d == "NULL" => None,
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
                args: cell(r, 3),
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
        assert_eq!(
            Kind::Text.value(Some(mysql_async::Value::Bytes(vec![0xff]))),
            Value::Bytes(vec![0xff])
        );
    }
}
