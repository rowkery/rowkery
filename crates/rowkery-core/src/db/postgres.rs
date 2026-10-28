use std::net::{IpAddr, Ipv4Addr};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, OnceLock};
use std::time::Duration;

use futures::TryStreamExt;
use rustls::client::danger::{HandshakeSignatureValid, ServerCertVerified, ServerCertVerifier};
use rustls::crypto::{verify_tls12_signature, verify_tls13_signature, CryptoProvider};
use rustls::pki_types::pem::PemObject;
use rustls::pki_types::{CertificateDer, ServerName, UnixTime};
use rustls::{ClientConfig, DigitallySignedStruct, RootCertStore, SignatureScheme};

use crate::edits::{ApplyCounts, ApplyFailure, RowStatement};
use crate::reach::{self, Reach};
use crate::safety::{locks_rows, SafeMode};
use tokio_postgres::config::SslMode;
use tokio_postgres::error::{Severity, SqlState};
use tokio_postgres::types::Type;
use tokio_postgres::{AsyncMessage, CancelToken, Client, NoTls, Row, Statement};
pub use tokio_postgres_rustls::MakeRustlsConnect;
use webpki_roots::TLS_SERVER_ROOTS;

use crate::cloudsql::{dialer_for, CloudSqlDialer};
use crate::connections::{expand_home, CloudSqlCredentials, PostgresConnection, PostgresSslMode};
use crate::secrets::{forget_cached, get_secret, keychain_refused, ConnectionSecrets, SecretKind};
use crate::ssh::{humanize_ssh_error, SshTunnel};

use super::introspect::{
    ColumnNode, DatabaseNode, EnumNode, ForeignKeyNode, FunctionNode, IndexNode, RowEstimate,
    SchemaCatalog, SchemaNode, TableIndexes, TableKind, TableNode,
};
use super::{Column, DriverError, RowBatch, Value, BATCH_BYTES};

mod activity;
mod health;
mod text_types;
pub use activity::{
    rowkery_tag, session_activity, session_cancel_tagged, session_locks_held, session_stop,
    HeldLock, ServerSession, StopKind,
};
pub use health::{session_health, session_health_within};

const BATCH_SIZE: usize = 200;

/// A session's warnings, as the connection task receives them.
type Warnings = Arc<std::sync::Mutex<Vec<String>>>;
/// Warnings kept per statement; a loop that warns on every row keeps the first.
const MAX_WARNINGS: usize = 8;

/// Every session's `application_name` starts with this, then a space and
/// its [`PostgresSession::tag`], so the Sessions tab can tell which tab a
/// server session belongs to.
pub const APP_NAME: &str = "Rowkery";

/// A new session's tag: 8 hex digits, unique for this process and unlikely
/// to match another install's.
fn new_tag() -> String {
    static NEXT: AtomicU64 = AtomicU64::new(0);
    let seed = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_or(0, |d| d.as_nanos() as u64)
        ^ (u64::from(std::process::id()) << 32);
    let n = NEXT.fetch_add(1, Ordering::Relaxed);
    let mixed = (seed ^ n.wrapping_mul(0x9E37_79B9_7F4A_7C15)).wrapping_mul(0xBF58_476D_1CE4_E5B9);
    format!("{:08x}", (mixed >> 32) as u32)
}

/// How a session reaches a server that isn't simply at `host:port`.
#[derive(Clone)]
pub enum Route {
    /// Through an SSH tunnel, shared with the window's other sessions (one
    /// SSH connection per window).
    Ssh(Arc<SshTunnel>),
    /// Through the Cloud SQL connector; one dialer per connection, which
    /// the route keeps alive between sessions.
    CloudSql(Arc<CloudSqlDialer>),
}

impl Route {
    /// Still usable for a new session (a tunnel can drop; a dialer renews
    /// its certificate itself).
    pub fn is_alive(&self) -> bool {
        match self {
            Self::Ssh(t) => t.is_alive(),
            Self::CloudSql(_) => true,
        }
    }

    /// The route is the one `config` asks for.
    fn fits(&self, config: &PostgresConnection) -> bool {
        match self {
            Self::Ssh(_) => config.ssh.is_some(),
            // Each session asks `dialer_for`, which checks the settings and
            // the key; the route only keeps the dialer alive.
            Self::CloudSql(_) => config.cloud_sql.is_some(),
        }
    }
}

/// Where a cancel request goes: Postgres takes it on a new connection, made
/// the way the session's was.
#[derive(Clone)]
pub enum CancelVia {
    Plain,
    Tls(MakeRustlsConnect),
    CloudSql(Arc<CloudSqlDialer>),
}

pub struct PostgresSession {
    config: PostgresConnection,
    connection_id: String,
    route: Option<Route>,
    client: Client,
    #[allow(dead_code)]
    connection_task: tokio::task::JoinHandle<()>,
    pub cancel_token: CancelToken,
    /// How to send this session a cancel request.
    pub cancel_via: CancelVia,
    /// `BEGIN` warnings (SQLSTATE 25001) seen so far: one after ours means
    /// the user's own transaction was already open.
    txn_warnings: Arc<AtomicU64>,
    /// The server's warnings since [`session_take_warnings`] last took them
    /// (`COMMIT` with no transaction open says so only this way).
    warnings: Warnings,
    /// A query tab's paged result, waiting for its next `FETCH`.
    cursor: Option<OpenCursor>,
    /// Whether the user has a transaction open on this session, as far as
    /// we know: cursors are never declared inside one.
    txn: TxnState,
    /// Statements prepared on this session, newest last (`prepared`).
    statements: std::sync::Mutex<std::collections::VecDeque<(String, Statement)>>,
    /// In its `application_name` after [`APP_NAME`].
    tag: String,
    /// A cancel meant for a finished statement landed on one of ours inside
    /// the user's transaction and aborted it (see
    /// [`session_take_cancel_aborted`]).
    cancel_aborted: bool,
    /// Whatever the owner ties to the session's life (the bridge keeps its
    /// place under the per-connection cap here): dropped with the session.
    guard: Option<Box<dyn std::any::Any + Send + Sync>>,
    /// Whether the session writes money as `text_types::money` does, as of
    /// the last result with money in it ([`query_prepared`]).
    money_shown: AtomicBool,
}

/// Prepared statements kept per session: a re-run, and every cursor
/// `FETCH`, skips the prepare round trip.
const STATEMENT_CACHE: usize = 64;

/// What we know about the user's transaction on a session.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum TxnState {
    /// None open (a new session, or after our own COMMIT / ROLLBACK).
    None,
    /// The user's transaction is open (ours found it with a `BEGIN` warning,
    /// or `BEGIN` was refused because it had failed).
    Users,
    /// A statement that can open or end one ran since we last knew.
    Unknown,
}

/// The cursor a query tab pages through (`CURSOR`).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct OpenCursor {
    /// Declared in a transaction we began (committed when it closes), not
    /// in one the user has open.
    pub ours: bool,
}

/// The one cursor a session pages a query tab through.
pub const CURSOR: &str = "rowkery_page";

impl PostgresSession {
    pub fn connection_id(&self) -> &str {
        &self.connection_id
    }

    pub fn config(&self) -> &PostgresConnection {
        &self.config
    }

    /// The client, for work that lives beside this module (CSV import).
    pub(crate) fn client(&self) -> &Client {
        &self.client
    }

    /// True once the socket is gone (server restart, network drop).
    pub fn is_closed(&self) -> bool {
        self.client.is_closed()
    }

    /// What we know about the user's transaction on this session.
    pub fn txn_state(&self) -> TxnState {
        self.txn
    }

    /// Names this session in `pg_stat_activity` (`Rowkery <tag>`).
    pub fn tag(&self) -> &str {
        &self.tag
    }

    /// Ties `guard` to this session: it is dropped when the session is.
    pub fn hold(&mut self, guard: Box<dyn std::any::Any + Send + Sync>) {
        self.guard = Some(guard);
    }

    /// Something was tied to this session with [`Self::hold`].
    pub fn holds(&self) -> bool {
        self.guard.is_some()
    }

    /// Unties what [`Self::hold`] tied, to hand it to another session.
    pub fn unhold(&mut self) -> Option<Box<dyn std::any::Any + Send + Sync>> {
        self.guard.take()
    }
}

pub async fn open_session(
    connection_id: String,
    config: PostgresConnection,
) -> Result<PostgresSession, DriverError> {
    open_session_with_secrets(connection_id, config, None).await
}

pub async fn open_session_with_secrets(
    connection_id: String,
    config: PostgresConnection,
    secrets: Option<&ConnectionSecrets>,
) -> Result<PostgresSession, DriverError> {
    open_session_via(connection_id, config, secrets, None).await
}

/// How long the TCP connect to one of the host's addresses may take; the
/// next address gets its own.
pub const CONNECT_TIMEOUT: Duration = Duration::from_secs(10);

/// How long opening a session may take in all: every address, then TLS,
/// startup, login (a slow one over a tunnel or LDAP) and the read-only `SET`.
/// Without it a port that takes the connection and says nothing (a dead
/// `kubectl port-forward`) would hang the open for good.
pub const OPEN_TIMEOUT: Duration = Duration::from_secs(30);

/// Opens a session, through `route` when it is the one the connection uses
/// and still alive (else a new one, which `session.route()` returns for the
/// next session to share).
pub async fn open_session_via(
    connection_id: String,
    config: PostgresConnection,
    secrets: Option<&ConnectionSecrets>,
    route: Option<Route>,
) -> Result<PostgresSession, DriverError> {
    let mut port = config.port;
    let mut route = route.filter(|r| r.fits(&config) && r.is_alive());

    let mut tunneled = false;
    if let Some(ssh) = config.ssh.clone() {
        let tunnel = match route.take() {
            Some(Route::Ssh(t)) => t,
            _ => Arc::new(
                SshTunnel::open_with_timeout(&ssh, &connection_id, &config.host, port, secrets)
                    .await
                    .map_err(|e| DriverError::Message(humanize_ssh_error(&e, &ssh.host)))?,
            ),
        };
        port = tunnel.local_port;
        tunneled = true;
        route = Some(Route::Ssh(tunnel));
    }
    let mut dialer = None;
    if let Some(cloud) = config.cloud_sql.clone() {
        // The connection's live dialer, unless its settings or key changed
        // since (a replaced key must not keep serving open windows).
        let key = match cloud.credentials {
            CloudSqlCredentials::Key => gcp_key(&connection_id, secrets).await?,
            CloudSqlCredentials::Gcloud => None,
        };
        let d = dialer_for(&connection_id, &cloud, key.as_deref())
            .map_err(|e| DriverError::Message(e.to_string()))?;
        dialer = Some(d.clone());
        route = Some(Route::CloudSql(d));
    }

    let password = if let Some(secrets) = secrets {
        secrets.db_password.clone().unwrap_or_default()
    } else {
        stored_password(&connection_id).await?
    };

    let tag = new_tag();
    let mut pg_config = tokio_postgres::Config::new();
    // Through a tunnel the socket goes to the local end, but the certificate
    // is still checked against the real host name.
    pg_config.host(&config.host);
    if tunneled {
        pg_config.hostaddr(IpAddr::V4(Ipv4Addr::LOCALHOST));
    }
    pg_config
        .port(port)
        .user(&config.username)
        .dbname(&config.database)
        .password(&password)
        .connect_timeout(CONNECT_TIMEOUT)
        // Shows in pg_stat_activity, so a DBA can tell Rowkery's sessions
        // apart, and the Sessions tab which tab each one is.
        .application_name(format!("{APP_NAME} {tag}"))
        // Sessions stay open between queries, so notice a dead peer (laptop
        // sleep, NAT timeout) well before the OS default of two hours.
        .keepalives_idle(Duration::from_secs(30))
        .keepalives_interval(Duration::from_secs(10))
        .keepalives_retries(3)
        .ssl_mode(match config.ssl_mode {
            // The connector's TLS (checked against the instance's own CA)
            // carries the session; Postgres itself sees a local client.
            _ if dialer.is_some() => SslMode::Disable,
            PostgresSslMode::Disable => SslMode::Disable,
            PostgresSslMode::Prefer => SslMode::Prefer,
            PostgresSslMode::Require | PostgresSslMode::Verify => SslMode::Require,
        });

    let tls = match config.ssl_mode {
        _ if dialer.is_some() => None,
        PostgresSslMode::Disable => None,
        mode => Some(make_tls_connector(mode, config.ssl_root_cert.as_deref())?),
    };
    let humanize = |e: tokio_postgres::Error| {
        DriverError::Message(humanize_postgres_error(&e, &config.username))
    };
    let txn_warnings = Arc::new(AtomicU64::new(0));
    let warnings = Warnings::default();
    let deadline = tokio::time::Instant::now() + OPEN_TIMEOUT;
    // The outer error is the Cloud SQL connector's (no Postgres error to
    // retry on); the inner one is Postgres's.
    let connect = |pg_config: tokio_postgres::Config| {
        let tls = tls.clone();
        let dialer = dialer.clone();
        let txn_warnings = txn_warnings.clone();
        let warnings = warnings.clone();
        let late = no_answer(&config.host, config.port);
        async move {
            if let Some(dialer) = dialer {
                let mut retried = false;
                loop {
                    let stream = dialer
                        .dial()
                        .await
                        .map_err(|e| DriverError::Message(e.to_string()))?;
                    let started =
                        tokio::time::timeout(CONNECT_TIMEOUT, pg_config.connect_raw(stream, NoTls))
                            .await
                            .map_err(|_| {
                                DriverError::Message(format!(
                            "Cloud SQL: {} took the connection but Postgres did not answer in {} s",
                            dialer.instance().name,
                            CONNECT_TIMEOUT.as_secs()
                        ))
                            })?;
                    match started {
                        // Dropped before Postgres said anything: under TLS 1.3
                        // the instance refuses a client certificate only after
                        // the handshake. A new one, and once more.
                        Err(e) if !retried && e.as_db_error().is_none() => {
                            dialer.forget_certificate();
                            retried = true;
                        }
                        started => {
                            return Ok(started.map(|(client, connection)| {
                                (client, drive_connection(connection, txn_warnings, warnings))
                            }));
                        }
                    }
                }
            }
            // `connect_timeout` bounds each address's TCP connect; the
            // deadline bounds the rest (see `OPEN_TIMEOUT`).
            let started = tokio::time::timeout_at(deadline, async {
                match tls {
                    Some(tls) => pg_config.connect(tls).await.map(|(client, connection)| {
                        (client, drive_connection(connection, txn_warnings, warnings))
                    }),
                    None => pg_config.connect(NoTls).await.map(|(client, connection)| {
                        (client, drive_connection(connection, txn_warnings, warnings))
                    }),
                }
            })
            .await
            .map_err(|_| late)?;
            Ok::<_, DriverError>(started)
        }
    };
    let (client, connection_task) = match connect(pg_config.clone()).await? {
        Ok(connected) => connected,
        // A long-lived process (the MCP server) remembers the password it
        // read first; the app may have saved a new one since. Read it again
        // and retry once, only when it changed.
        Err(err) if secrets.is_none() && is_bad_password(&err) => {
            let id = connection_id.clone();
            let _ = tokio::task::spawn_blocking(move || forget_cached(&id)).await;
            let fresh = stored_password(&connection_id).await?;
            let result = if fresh != password {
                pg_config.password(&fresh);
                connect(pg_config).await?
            } else {
                Err(err)
            };
            match result {
                Ok(connected) => connected,
                Err(err) if is_bad_password(&err) => {
                    return Err(DriverError::Message(
                        no_password_message(&connection_id, &config.username, fresh.is_empty())
                            .unwrap_or_else(|| humanize_postgres_error(&err, &config.username)),
                    ));
                }
                Err(err) => return Err(humanize(err)),
            }
        }
        Err(err) => return Err(humanize(err)),
    };

    // Read-only connections are read-only at the server too, so a write that
    // safe mode's text check misses (a function call in a SELECT) still fails.
    if config.safe_mode == SafeMode::ReadOnly {
        let set = tokio::time::timeout_at(deadline, client.batch_execute(READ_ONLY_DEFAULT)).await;
        let failed = match set {
            Ok(Ok(())) => None,
            Ok(Err(e)) => Some(humanize(e)),
            Err(_) => Some(no_answer(&config.host, config.port)),
        };
        if let Some(err) = failed {
            // No session holds the connection yet: stop it here, or it
            // waits on a silent server for good.
            connection_task.abort();
            return Err(err);
        }
    }

    let cancel_token = client.cancel_token();
    let cancel_via = match (dialer, tls) {
        (Some(d), _) => CancelVia::CloudSql(d),
        (None, Some(tls)) => CancelVia::Tls(tls),
        (None, None) => CancelVia::Plain,
    };

    Ok(PostgresSession {
        config,
        connection_id,
        route,
        client,
        connection_task,
        cancel_token,
        cancel_via,
        txn_warnings,
        warnings,
        cursor: None,
        txn: TxnState::None,
        statements: Default::default(),
        tag,
        cancel_aborted: false,
        guard: None,
        money_shown: AtomicBool::new(false),
    })
}

/// A session open that gave up after [`OPEN_TIMEOUT`]: no address took the
/// connection in time, or one did and TLS, startup or login never finished.
/// `explain_connect_error` reads "did not finish connecting" as a timeout.
fn no_answer(host: &str, port: u16) -> DriverError {
    DriverError::Message(format!(
        "Connection timed out: {host}:{port} did not finish connecting in {} s",
        OPEN_TIMEOUT.as_secs()
    ))
}

/// Runs the connection, counting `BEGIN`'s "already a transaction in
/// progress" warnings and keeping every warning's text. A notice is handled
/// before the messages after it, so both are current when the batch that
/// caused it returns.
fn drive_connection<S, T>(
    mut connection: tokio_postgres::Connection<S, T>,
    txn_warnings: Arc<AtomicU64>,
    warnings: Warnings,
) -> tokio::task::JoinHandle<()>
where
    S: tokio::io::AsyncRead + tokio::io::AsyncWrite + Unpin + Send + 'static,
    T: tokio::io::AsyncRead + tokio::io::AsyncWrite + Unpin + Send + 'static,
{
    tokio::spawn(async move {
        loop {
            match futures::future::poll_fn(|cx| connection.poll_message(cx)).await {
                Some(Ok(AsyncMessage::Notice(notice))) => {
                    if notice.code() == &SqlState::ACTIVE_SQL_TRANSACTION {
                        txn_warnings.fetch_add(1, Ordering::SeqCst);
                    }
                    if notice.parsed_severity() == Some(Severity::Warning) {
                        if let Ok(mut kept) = warnings.lock() {
                            if kept.len() < MAX_WARNINGS {
                                kept.push(notice.message().to_string());
                            }
                        }
                    }
                }
                Some(Ok(_)) => {}
                Some(Err(err)) => {
                    eprintln!("postgres connection error: {err}");
                    break;
                }
                None => break,
            }
        }
    })
}

impl PostgresSession {
    /// The tunnel or connector this session goes through, to share with the
    /// next one.
    pub fn route(&self) -> Option<Route> {
        self.route.clone()
    }
}

/// The connection's service account key: typed in the form, else saved.
async fn gcp_key(
    connection_id: &str,
    secrets: Option<&ConnectionSecrets>,
) -> Result<Option<String>, DriverError> {
    if let Some(key) = secrets
        .and_then(|s| s.gcp_key.clone())
        .filter(|k| !k.is_empty())
    {
        return Ok(Some(key));
    }
    let id = connection_id.to_string();
    tokio::task::spawn_blocking(move || get_secret(&id, SecretKind::GcpKey))
        .await
        .map_err(|e| DriverError::Message(e.to_string()))?
        .map_err(|e| DriverError::Message(e.to_string()))
}

pub async fn session_test(session: &mut PostgresSession) -> Result<(), DriverError> {
    session
        .client
        .simple_query("SELECT 1")
        .await
        .map_err(|e| DriverError::Message(humanize_postgres_error(&e, &session.config.username)))?;
    Ok(())
}

/// One empty round trip; false if the server doesn't answer within `limit`.
pub async fn session_ping(session: &PostgresSession, limit: Duration) -> bool {
    matches!(
        tokio::time::timeout(limit, session.client.simple_query("")).await,
        Ok(Ok(_))
    )
}

/// `16.3` from `SHOW server_version` (drops the distro suffix).
pub async fn session_server_version(session: &PostgresSession) -> Result<String, DriverError> {
    let row = session
        .client
        .query_one("SHOW server_version", &[])
        .await
        .map_err(|e| DriverError::Message(e.to_string()))?;
    let full: String = row.get(0);
    Ok(full
        .split_whitespace()
        .next()
        .unwrap_or_default()
        .to_string())
}

fn map_query_error(err: &tokio_postgres::Error, username: &str) -> DriverError {
    if err.code() == Some(&tokio_postgres::error::SqlState::QUERY_CANCELED) {
        return DriverError::Cancelled;
    }
    let message = humanize_postgres_error(err, username);
    match err.as_db_error() {
        Some(db) => DriverError::Server {
            message,
            sqlstate: db.code().code().to_string(),
            position: match db.position() {
                Some(tokio_postgres::error::ErrorPosition::Original(p)) => Some(*p),
                _ => None,
            },
            detail: detail_lines(db),
        },
        None => DriverError::Message(message),
    }
}

/// psql's `DETAIL:` and `HINT:` lines under an error (rowkery/reports#43).
fn detail_lines(db: &tokio_postgres::error::DbError) -> Option<String> {
    let lines: Vec<String> = [("DETAIL", db.detail()), ("HINT", db.hint())]
        .into_iter()
        .filter_map(|(label, text)| text.map(|t| format!("{label}:  {t}")))
        .collect();
    (!lines.is_empty()).then(|| lines.join("\n"))
}

/// How `session_query_stream_with` batches rows.
#[derive(Clone, Copy, Debug)]
pub struct StreamOptions {
    /// Rows per batch at most.
    pub batch_rows: usize,
    /// A partial batch is sent once its first row has waited this long, so a
    /// slow query shows its first rows (and a live count) without waiting
    /// for a full batch. Checked as rows arrive.
    pub max_wait: std::time::Duration,
    /// Rows decoded and passed on at most; the rest are read off the wire
    /// and counted, never decoded (the statement still runs to its end).
    /// `None` keeps every row.
    pub keep: Option<u64>,
}

impl Default for StreamOptions {
    fn default() -> Self {
        Self {
            batch_rows: BATCH_SIZE,
            max_wait: std::time::Duration::from_millis(10),
            keep: None,
        }
    }
}

/// What a stream did besides its rows.
#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct StreamStats {
    /// Rows returned, or rows affected for a statement without a result set.
    pub rows: u64,
    /// From the call to the first row's arrival; `None` when no row came.
    pub first_row: Option<std::time::Duration>,
}

/// `sql` prepared on the session: from its cache when `cacheable`, else a
/// fresh statement closed when it drops. The `bool` is true when it came
/// from the cache.
///
/// Prepared, not `query_typed_raw`: that sends parse, bind and execute at
/// once and looks up a column type it doesn't know (an enum, a domain, an
/// extension's type) while the rows are already on their way. Its response
/// channel holds one message, so a result larger than the buffers stalls
/// the connection behind rows nobody reads, and the lookup never answers:
/// `SELECT *` on a table with an enum hung for good. Preparing looks the
/// types up before anything runs.
async fn prepared(
    session: &PostgresSession,
    sql: &str,
    cacheable: bool,
) -> Result<(Statement, bool), tokio_postgres::Error> {
    if !cacheable {
        return Ok((session.client.prepare(sql).await?, false));
    }
    if let Ok(cache) = session.statements.lock() {
        if let Some((_, st)) = cache.iter().find(|(k, _)| k == sql) {
            return Ok((st.clone(), true));
        }
    }
    let st = session.client.prepare(sql).await?;
    if let Ok(mut cache) = session.statements.lock() {
        if cache.len() >= STATEMENT_CACHE {
            cache.pop_front();
        }
        cache.push_back((sql.to_string(), st.clone()));
    }
    Ok((st, false))
}

/// Whether `sql`'s prepared statement may be kept and reused: only a plain
/// query, whose result shape is fixed by its text and the schema. A utility
/// statement's shape is settled when it runs (`FETCH` takes the columns of
/// whichever cursor has that name now, `EXECUTE` those of whichever
/// prepared statement, `SHOW` …), so a cached one would decode the next
/// result with the last one's types.
fn cacheable_sql(sql: &str) -> bool {
    let head = sql
        .trim_start()
        .chars()
        .take_while(|c| c.is_ascii_alphabetic())
        .collect::<String>()
        .to_ascii_lowercase();
    matches!(head.as_str(), "select" | "with" | "values" | "table")
}

/// Starts `sql`, prepared; the statement names the result's columns even
/// when no row comes. The cache is used only while the session is known to
/// be outside any transaction (none of the user's, no cursor of ours): a
/// cached statement the server no longer takes (its result type changed
/// with the schema) fails at bind, which would abort an open transaction.
/// Outside one nothing is lost, so it is prepared again, once.
async fn start_query(
    session: &PostgresSession,
    sql: &str,
    ahead: bool,
) -> Result<(Statement, tokio_postgres::RowStream), tokio_postgres::Error> {
    let (set, started) = tokio::join!(
        keep_read_only(&session.client, ahead),
        start_query_now(session, sql)
    );
    set?;
    started
}

async fn start_query_now(
    session: &PostgresSession,
    sql: &str,
) -> Result<(Statement, tokio_postgres::RowStream), tokio_postgres::Error> {
    let outside_txn = session.txn == TxnState::None && session.cursor.is_none();
    let (st, cached) = prepared(session, sql, outside_txn && cacheable_sql(sql)).await?;
    match query_prepared(session, &st).await {
        Err(e)
            if cached
                && (e.code() == Some(&SqlState::FEATURE_NOT_SUPPORTED)
                    || e.code() == Some(&SqlState::INVALID_SQL_STATEMENT_NAME)) =>
        {
            if let Ok(mut cache) = session.statements.lock() {
                cache.retain(|(k, _)| k != sql);
            }
            let (st, _) = prepared(session, sql, true).await?;
            let rows = query_prepared(session, &st).await?;
            Ok((st, rows))
        }
        Err(e) => Err(e),
        Ok(rows) => Ok((st, rows)),
    }
}

/// How the session writes two amounts of money, and how `text_types::money`
/// writes them. money's binary value is in units of the server locale's
/// `lc_monetary` (no cents in ja_JP), written in its symbols (`1.234,50 €`
/// in de_DE), and the user may `SET` it: the decoder is only right where
/// the session writes these the same way.
const MONEY_PROBE: &str = "SELECT '-1234567.89'::money::text, '1234567.89'::money::text";
const MONEY_AS_DECODED: [&str; 2] = ["-$1,234,567.89", "$1,234,567.89"];

/// Runs a prepared statement. One with money in its result asks
/// [`MONEY_PROBE`] too, pipelined ahead of it, so it costs no round trip.
async fn query_prepared(
    session: &PostgresSession,
    st: &Statement,
) -> Result<tokio_postgres::RowStream, tokio_postgres::Error> {
    let none = std::iter::empty::<&(dyn tokio_postgres::types::ToSql + Sync)>;
    if !st.columns().iter().any(|c| holds_money(c.type_())) {
        return session.client.query_raw(st, none()).await;
    }
    let (written, rows) = tokio::join!(
        session.client.simple_query(MONEY_PROBE),
        session.client.query_raw(st, none())
    );
    let shown = written.is_ok_and(|messages| {
        messages.iter().any(|m| match m {
            tokio_postgres::SimpleQueryMessage::Row(row) => {
                [row.get(0), row.get(1)] == MONEY_AS_DECODED.map(Some)
            }
            _ => false,
        })
    });
    session.money_shown.store(shown, Ordering::SeqCst);
    rows
}

/// Whether values of `ty` hold money: itself, or as an array or domain.
fn holds_money(ty: &Type) -> bool {
    use tokio_postgres::types::Kind;
    match ty.kind() {
        Kind::Array(element) | Kind::Domain(element) => holds_money(element),
        _ => *ty == Type::MONEY,
    }
}

/// Runs `sql` (one or more statements, no rows wanted) in one simple-protocol
/// round trip: transaction control, `DECLARE`, `CLOSE`, `SET`.
pub async fn session_execute(session: &PostgresSession, sql: &str) -> Result<(), DriverError> {
    session
        .client
        .batch_execute(sql)
        .await
        .map_err(|e| map_query_error(&e, &session.config.username))
}

/// What makes a read-only connection's sessions read-only at the server.
const READ_ONLY_DEFAULT: &str = "SET default_transaction_read_only = on";

/// Whether a run on `session` sends [`READ_ONLY_DEFAULT`] ahead of itself:
/// on a read-only connection's session, unless the tab's cursor is open.
/// A function the text check can't see into (`SELECT f()`) may turn the
/// default off, and the next transaction would start read-write. Every
/// run on a read-only connection is one statement (SQL files and imports
/// are refused there), and only one with no transaction open starts one:
/// so the SET goes ahead of every run but a `FETCH` (or an export) inside
/// the cursor's transaction, which started read-only. Inside the user's
/// own transaction it is harmless, and their `BEGIN` got one too.
fn read_only_ahead(session: &PostgresSession) -> bool {
    session.config.safe_mode == SafeMode::ReadOnly && session.cursor.is_none()
}

/// [`READ_ONLY_DEFAULT`] when `ahead`. Pipelined: the request goes out the
/// first time this is polled, so `join!`ed ahead of a statement it costs
/// no round trip. In the user's failed transaction the server refuses it
/// (25P02); that counts as done, since the rollback the transaction needs
/// undoes whatever turned the default off, and the statement after it
/// fails the same way.
async fn keep_read_only(client: &Client, ahead: bool) -> Result<(), tokio_postgres::Error> {
    if !ahead {
        return Ok(());
    }
    match client.batch_execute(READ_ONLY_DEFAULT).await {
        Err(err) if err.code() == Some(&SqlState::IN_FAILED_SQL_TRANSACTION) => Ok(()),
        done => done,
    }
}

/// Runs one statement of a SQL file in the simple protocol, as psql does,
/// and returns the rows it reports (`INSERT 0 5`: 5). Rows it returns are
/// read and dropped, never kept.
pub async fn session_run_file_statement(
    session: &PostgresSession,
    sql: &str,
) -> Result<u64, DriverError> {
    let username = &session.config.username;
    let stream = session
        .client
        .simple_query_raw(sql)
        .await
        .map_err(|e| map_query_error(&e, username))?;
    let mut stream = std::pin::pin!(stream);
    let mut rows = 0;
    while let Some(message) = stream
        .try_next()
        .await
        .map_err(|e| map_query_error(&e, username))?
    {
        if let tokio_postgres::SimpleQueryMessage::CommandComplete(n) = message {
            rows += n;
        }
    }
    Ok(rows)
}

/// Starts a `COPY … FROM stdin`: send its rows into the sink, then
/// `finish` it for the rows copied. Dropping the sink unfinished fails the
/// COPY.
pub async fn session_copy_in(
    session: &PostgresSession,
    sql: &str,
) -> Result<tokio_postgres::CopyInSink<std::io::Cursor<Vec<u8>>>, DriverError> {
    session
        .client
        .copy_in(sql)
        .await
        .map_err(|e| map_query_error(&e, &session.config.username))
}

/// The message to show for a COPY's failure.
pub fn copy_error(session: &PostgresSession, err: &tokio_postgres::Error) -> DriverError {
    map_query_error(err, &session.config.username)
}

pub async fn session_query_stream<F>(
    session: &PostgresSession,
    sql: &str,
    on_batch: F,
) -> Result<u64, DriverError>
where
    F: FnMut(RowBatch, bool) -> Result<(), DriverError>,
{
    session_query_stream_with(session, sql, StreamOptions::default(), on_batch)
        .await
        .map(|stats| stats.rows)
}

/// `session_query_stream`, batching by `opts` and timing the first row.
pub async fn session_query_stream_with<F>(
    session: &PostgresSession,
    sql: &str,
    opts: StreamOptions,
    on_batch: F,
) -> Result<StreamStats, DriverError>
where
    F: FnMut(RowBatch, bool) -> Result<(), DriverError>,
{
    stream_with(session, sql, opts, on_batch, read_only_ahead(session)).await
}

/// `session_query_stream_with`, sending [`READ_ONLY_DEFAULT`] ahead when
/// `ahead`.
async fn stream_with<F>(
    session: &PostgresSession,
    sql: &str,
    opts: StreamOptions,
    mut on_batch: F,
    ahead: bool,
) -> Result<StreamStats, DriverError>
where
    F: FnMut(RowBatch, bool) -> Result<(), DriverError>,
{
    let started = std::time::Instant::now();
    let username = session.config.username.clone();
    let trimmed = sql.trim();
    let (st, stream) = start_query(session, trimmed, ahead)
        .await
        .map_err(|e| map_query_error(&e, &username))?;
    // The prepared statement says whether rows come back, whatever the SQL
    // starts with (a comment, a bracket, `INSERT … RETURNING`, `CALL`).
    if st.columns().is_empty() {
        futures::pin_mut!(stream);
        while stream
            .try_next()
            .await
            .map_err(|e| map_query_error(&e, &username))?
            .is_some()
        {}
        return Ok(StreamStats {
            rows: stream.rows_affected().unwrap_or(0),
            first_row: None,
        });
    }

    let money_shown = session.money_shown.load(Ordering::SeqCst);
    futures::pin_mut!(stream);
    // From the statement, not the first row: a result with no rows still
    // has its columns.
    let columns: Vec<Column> = st
        .columns()
        .iter()
        .map(|col| Column {
            name: col.name().to_string(),
            type_name: col.type_().name().to_string(),
        })
        .collect();
    let mut total_rows = 0u64;
    let mut batch_rows: Vec<Vec<Value>> = Vec::with_capacity(opts.batch_rows);
    let mut batch_bytes = 0usize;
    let mut first_batch = true;
    let mut first_row = None;
    // When the oldest row of the batch being built arrived.
    let mut batch_since = started;
    let full = |n: u64| opts.keep.is_some_and(|keep| n >= keep);

    while let Some(row) = stream
        .try_next()
        .await
        .map_err(|e| map_query_error(&e, &username))?
    {
        let row: Row = row;
        if first_row.is_none() {
            first_row = Some(started.elapsed());
        }
        if full(total_rows) {
            total_rows += 1;
            continue;
        }
        let mut values = Vec::with_capacity(columns.len());
        for i in 0..columns.len() {
            let value = postgres_value_to_core(&row, i, money_shown);
            batch_bytes += value.heap_bytes();
            values.push(value);
        }
        if batch_rows.is_empty() {
            batch_since = std::time::Instant::now();
        }
        batch_rows.push(values);
        total_rows += 1;

        if batch_rows.len() >= opts.batch_rows
            || batch_bytes >= BATCH_BYTES
            || batch_since.elapsed() >= opts.max_wait
            || full(total_rows)
        {
            let batch = RowBatch {
                columns: columns.clone(),
                rows: batch_rows,
            };
            batch_rows = Vec::with_capacity(opts.batch_rows);
            batch_bytes = 0;
            on_batch(batch, first_batch)?;
            first_batch = false;
        }
    }

    if !batch_rows.is_empty() || first_batch {
        let batch = RowBatch {
            columns,
            rows: batch_rows,
        };
        on_batch(batch, first_batch)?;
    }

    Ok(StreamStats {
        rows: total_rows,
        first_row,
    })
}

/// The first page of `sql` through `CURSOR`. `Ok(None)` when the statement
/// can't be a cursor, and the caller runs it plainly.
///
/// On a read-only connection the SET of `read_only_ahead` goes first.
/// When the session is known to have no transaction open, one pipelined
/// round sends `BEGIN; SAVEPOINT`, the `DECLARE … NO SCROLL CURSOR` on its
/// own (`declare_sql`), `RELEASE` and the first `FETCH FORWARD rows`
/// (`rows` 0 fetches all). Our transaction commits when the cursor ends.
/// After a statement that may have opened one, `BEGIN` goes alone first: its
/// "already a transaction in progress" warning means the user's is open.
///
/// Inside the user's transaction the cursor is declared in it, between a
/// savepoint and its release, with no `BEGIN` and no `COMMIT`: closing it
/// leaves their transaction open and as it was. A failed transaction, and a
/// read with a locking clause (a cursor would lock only the rows fetched),
/// run plainly. The `bool` is true while rows remain.
pub async fn session_query_cursor<F>(
    session: &mut PostgresSession,
    sql: &str,
    rows: u32,
    opts: StreamOptions,
    on_batch: F,
) -> Result<Option<(StreamStats, bool)>, DriverError>
where
    F: FnMut(RowBatch, bool) -> Result<(), DriverError>,
{
    session_close_cursor(session).await;
    // Ahead of our BEGIN, as a request of its own: in one batch with it,
    // the transaction would start before the SET ran.
    let mut ahead = read_only_ahead(session);
    let mut users = session.txn == TxnState::Users;
    let mut begin = "BEGIN; ";
    if session.txn == TxnState::Unknown {
        let before = session.txn_warnings.load(Ordering::SeqCst);
        let (set, begun) = tokio::join!(
            keep_read_only(&session.client, ahead),
            session.client.batch_execute("BEGIN")
        );
        ahead = false;
        if let Err(err) = set {
            return Err(map_query_error(&err, &session.config.username));
        }
        match begun {
            Err(err) if err.code() == Some(&SqlState::IN_FAILED_SQL_TRANSACTION) => {
                session.txn = TxnState::Users;
                return Ok(None);
            }
            Err(err) => return Err(map_query_error(&err, &session.config.username)),
            Ok(()) if session.txn_warnings.load(Ordering::SeqCst) != before => {
                // Our BEGIN's warning, not the user's.
                session_take_warnings(session);
                session.txn = TxnState::Users;
                users = true;
            }
            // Ours is open.
            Ok(()) => begin = "",
        }
    }
    if users {
        if locks_rows(sql) {
            return Ok(None);
        }
        begin = "";
    }
    let before = session.txn_warnings.load(Ordering::SeqCst);
    let opening = format!("{begin}SAVEPOINT rowkery_sp");
    let declare = declare_sql(CURSOR, sql);
    let fetch = fetch_sql(rows);
    // Still one pipelined round: each request goes out, in this order, the
    // first time `join!` polls it. The DECLARE travels alone through the
    // extended protocol, so a second statement hidden in `sql` is refused by
    // the server instead of run.
    let (set, opened, declared, released, fetched) = tokio::join!(
        keep_read_only(&session.client, ahead),
        session.client.batch_execute(&opening),
        session.client.query_typed(&declare, &[]),
        session.client.batch_execute("RELEASE SAVEPOINT rowkery_sp"),
        stream_with(session, &fetch, opts, on_batch, false),
    );
    // The first failure is the one that counts; the later ones are 25P02.
    let declared = set.and(opened).and(declared.map(drop)).and(released);
    // Known to have none open, so `BEGIN` can't warn; if it did anyway, the
    // savepoint keeps their transaction as it was and ours never commits it.
    let warned = session.txn_warnings.load(Ordering::SeqCst) != before;
    if warned {
        eprintln!("rowkery: BEGIN warned on a session known to have no transaction open");
    }
    let in_users = users || warned;
    if let Err(err) = declared {
        if err.code() != Some(&SqlState::IN_FAILED_SQL_TRANSACTION) {
            let undo = if in_users {
                "ROLLBACK TO SAVEPOINT rowkery_sp; RELEASE SAVEPOINT rowkery_sp"
            } else {
                "ROLLBACK"
            };
            let _ = session.client.batch_execute(undo).await;
        }
        session.txn = if in_users {
            TxnState::Users
        } else {
            TxnState::None
        };
        return Ok(None);
    }
    session.txn = if in_users {
        TxnState::Users
    } else {
        TxnState::None
    };
    session.cursor = Some(OpenCursor { ours: !in_users });
    finish_fetch(session, rows, fetched).await.map(Some)
}

/// `DECLARE name NO SCROLL CURSOR FOR sql`. Only ever sent on its own
/// through the extended protocol ([`session_declare_cursor`]), never in a
/// simple-protocol batch: there `SELECT 1; COMMIT; DELETE …` would run every
/// statement, whatever safe mode made of the text. The newline ends a
/// trailing `--` comment.
fn declare_sql(cursor: &str, sql: &str) -> String {
    format!("DECLARE {cursor} NO SCROLL CURSOR FOR {sql}\n")
}

/// Declares `cursor` over `sql` in the session's open transaction, as one
/// extended-protocol statement: Postgres refuses `sql` holding a second
/// statement ("cannot insert multiple commands into a prepared statement")
/// rather than running it. A DECLARE returns no columns, so nothing waits
/// on a type lookup.
pub async fn session_declare_cursor(
    session: &PostgresSession,
    cursor: &str,
    sql: &str,
) -> Result<(), DriverError> {
    session
        .client
        .query_typed(&declare_sql(cursor, sql), &[])
        .await
        .map(drop)
        .map_err(|e| map_query_error(&e, &session.config.username))
}

/// The server's warnings since the last call (`there is no transaction in
/// progress` after a `COMMIT` that had nothing to commit), oldest first.
pub fn session_take_warnings(session: &PostgresSession) -> Vec<String> {
    session
        .warnings
        .lock()
        .map(|mut w| std::mem::take(&mut *w))
        .unwrap_or_default()
}

/// A statement ran as written on the session: unless it only reads, it may
/// have opened or ended a transaction (BEGIN, COMMIT, CALL, DO …), so the
/// next cursor asks first.
pub fn session_note_statement(session: &mut PostgresSession, reads_only: bool) {
    if !reads_only {
        session.txn = TxnState::Unknown;
    }
}

/// Asks the server whether a transaction block is open on the session and
/// records the answer. `SAVEPOINT` is refused outside a block (25P01) and in
/// a failed one (25P02); inside a live one it is released at once, and as a
/// utility statement it takes no snapshot, so the user's transaction is left
/// as it was. Stays `Unknown` when the server doesn't answer within `limit`.
pub async fn session_probe_txn(session: &mut PostgresSession, limit: Duration) -> TxnState {
    if session.txn != TxnState::Unknown || session.cursor.is_some() {
        return session.txn;
    }
    session.txn = probe_txn(session, limit).await.unwrap_or(TxnState::Unknown);
    session.txn
}

/// After a cancel, what the cancelled statement left: a transaction it
/// opened, ended or failed (a failed one is still open: the user must roll
/// it back). A paged result's cursor goes first: our own cursor
/// transaction is rolled back whatever the cancel left it in, and one in the
/// user's transaction is closed. The cancel may have arrived only after the
/// statement finished and land on one of these statements instead (57014):
/// each is tried again, and if that aborted the user's transaction, the
/// tab's next statement says why (`session_take_cancel_aborted`). `Unknown`
/// when the server doesn't answer within `limit`.
pub async fn session_probe_after_cancel(
    session: &mut PostgresSession,
    limit: Duration,
) -> TxnState {
    let mut hit = false;
    if let Some(cursor) = session.cursor.take() {
        let sql = if cursor.ours {
            "ROLLBACK".to_string()
        } else {
            format!("CLOSE {CURSOR}")
        };
        for _ in 0..2 {
            match tokio::time::timeout(limit, session.client.batch_execute(&sql)).await {
                Ok(Err(err)) if err.code() == Some(&SqlState::QUERY_CANCELED) => hit = true,
                _ => break,
            }
        }
    }
    session.txn = TxnState::Unknown;
    for _ in 0..3 {
        match probe_txn(session, limit).await {
            Some(state) => {
                session.txn = state;
                break;
            }
            None => hit = true,
        }
    }
    session.cancel_aborted = hit && session.txn == TxnState::Users;
    session.txn
}

/// Whether a cancel aborted the user's transaction after their statement
/// had finished (see [`session_probe_after_cancel`]); asking clears it.
pub fn session_take_cancel_aborted(session: &mut PostgresSession) -> bool {
    std::mem::take(&mut session.cancel_aborted)
}

/// [`session_probe_txn`]'s question; `None` when a cancel stopped it.
async fn probe_txn(session: &PostgresSession, limit: Duration) -> Option<TxnState> {
    let probe = tokio::time::timeout(
        limit,
        session.client.batch_execute("SAVEPOINT rowkery_probe"),
    )
    .await;
    Some(match probe {
        Ok(Ok(())) => {
            let released = tokio::time::timeout(
                limit,
                session
                    .client
                    .batch_execute("RELEASE SAVEPOINT rowkery_probe"),
            )
            .await;
            match released {
                Ok(Ok(())) => TxnState::Users,
                Ok(Err(err)) if err.code() == Some(&SqlState::QUERY_CANCELED) => return None,
                _ => TxnState::Unknown,
            }
        }
        Ok(Err(err)) if err.code() == Some(&SqlState::QUERY_CANCELED) => return None,
        Ok(Err(err)) if err.code() == Some(&SqlState::NO_ACTIVE_SQL_TRANSACTION) => TxnState::None,
        Ok(Err(err)) if err.code() == Some(&SqlState::IN_FAILED_SQL_TRANSACTION) => TxnState::Users,
        _ => TxnState::Unknown,
    })
}

/// The next `rows` of the tab's open cursor (0: the rest).
pub async fn session_fetch_more<F>(
    session: &mut PostgresSession,
    rows: u32,
    opts: StreamOptions,
    on_batch: F,
) -> Result<(StreamStats, bool), DriverError>
where
    F: FnMut(RowBatch, bool) -> Result<(), DriverError>,
{
    if session.cursor.is_none() {
        return Err(DriverError::Message(
            "These rows are no longer open; run the query again".into(),
        ));
    }
    let fetched = session_query_stream_with(session, &fetch_sql(rows), opts, on_batch).await;
    finish_fetch(session, rows, fetched).await
}

/// Whether the session holds a paged result with rows left.
pub fn session_has_cursor(session: &PostgresSession) -> bool {
    session.cursor.is_some()
}

/// Closes the tab's cursor, committing the transaction it began. Every run
/// on the tab calls it first, so nothing else runs inside our transaction.
pub async fn session_close_cursor(session: &mut PostgresSession) {
    if let Some(cursor) = session.cursor.take() {
        let sql = if cursor.ours {
            format!("CLOSE {CURSOR}; COMMIT")
        } else {
            format!("CLOSE {CURSOR}")
        };
        let _ = session.client.batch_execute(&sql).await;
    }
}

/// Runs staged row edits as one transaction on the session: every statement
/// must change exactly one row, or the whole batch rolls back and the
/// failure names the statement. Never inside the user's own transaction:
/// that is refused untouched, since our COMMIT would end it. `BEGIN` and
/// each statement get `step` to answer (a lock wait, or a socket that died without saying). On a timeout
/// the statement is cancelled and the transaction rolled back, before any
/// `COMMIT` was sent, so nothing was saved; `COMMIT` itself has no limit and
/// is never retried. If even the rollback doesn't answer, the session is
/// left `Unknown` for the caller to drop (the server rolls back when it goes).
/// What the batch writes beyond its own rows stops it before COMMIT unless
/// it is exactly `approved` (`crate::reach`).
pub async fn session_apply_changes_within(
    session: &mut PostgresSession,
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
    let username = session.config.username.clone();
    let message = |e: &tokio_postgres::Error| map_query_error(e, &username).into_full_message();
    session_close_cursor(session).await;
    let users = || {
        ApplyFailure::other(
            "This tab has a transaction open. Commit or roll it back before saving edits.",
        )
    };
    if session.txn == TxnState::Users {
        return Err(users());
    }
    // `BEGIN` alone first: a warning (or a refusal, when it failed) means the
    // user's transaction is open, and nothing else is sent.
    let before = session.txn_warnings.load(Ordering::SeqCst);
    let Ok(begun) = tokio::time::timeout(limit, session.client.batch_execute("BEGIN")).await else {
        abandon_apply(session, limit).await;
        return Err(ApplyFailure::other(late("BEGIN")));
    };
    match begun {
        Err(err) if err.code() == Some(&SqlState::IN_FAILED_SQL_TRANSACTION) => {
            session.txn = TxnState::Users;
            return Err(users());
        }
        Err(err) => return Err(ApplyFailure::other(message(&err))),
        Ok(()) if session.txn_warnings.load(Ordering::SeqCst) != before => {
            session.txn = TxnState::Users;
            return Err(users());
        }
        Ok(()) => {}
    }
    session.txn = TxnState::None;
    // Literals are built with `''` doubling only: backslashes must stay literal.
    let set = tokio::time::timeout(
        limit,
        session
            .client
            .batch_execute("SET LOCAL standard_conforming_strings = on"),
    )
    .await;
    match set {
        Ok(Ok(())) => {}
        Ok(Err(err)) => {
            rollback(&session.client).await;
            return Err(ApplyFailure::other(message(&err)));
        }
        Err(_) => {
            abandon_apply(session, limit).await;
            return Err(ApplyFailure::other(late("The database")));
        }
    }
    // Counted only when the table can write elsewhere (a trigger, a rule, a
    // cascading foreign key into it, partitions).
    let start = match tokio::time::timeout(limit, reach_start(session, statements)).await {
        Ok(Ok(start)) => start,
        Ok(Err(err)) => {
            rollback(&session.client).await;
            return Err(ApplyFailure::other(err));
        }
        Err(_) => {
            abandon_apply(session, limit).await;
            return Err(ApplyFailure::other(late("The database")));
        }
    };
    let mut counts = ApplyCounts::default();
    for (index, statement) in statements.iter().enumerate() {
        let ran =
            tokio::time::timeout(limit, session.client.execute(statement.sql.as_str(), &[])).await;
        let Ok(ran) = ran else {
            abandon_apply(session, limit).await;
            let named = statement.describe();
            return Err(ApplyFailure {
                index: Some(index),
                message: late(&named),
                statement: Some(named),
                rows: None,
                unknown: false,
                reach: None,
            });
        };
        match ran {
            Ok(1) => counts.add(statement.verb, 1),
            Ok(rows) => {
                rollback(&session.client).await;
                return Err(ApplyFailure::count(index, statement, rows));
            }
            Err(err) => {
                rollback(&session.client).await;
                return Err(ApplyFailure::error(index, statement, message(&err)));
            }
        }
    }
    if let Some((own, before)) = start {
        let beyond =
            tokio::time::timeout(limit, reach_beyond(session, own, &before, &counts)).await;
        match beyond {
            Ok(Ok(reach)) if reach.is_empty() || approved == Some(&reach) => {}
            Ok(Ok(reach)) => {
                rollback(&session.client).await;
                return Err(ApplyFailure::reaches(reach));
            }
            Ok(Err(err)) => {
                rollback(&session.client).await;
                return Err(ApplyFailure::other(err));
            }
            Err(_) => {
                abandon_apply(session, limit).await;
                return Err(ApplyFailure::other(late("The database")));
            }
        }
    }
    // A deferred constraint can still refuse the batch here.
    if let Err(err) = session.client.batch_execute("COMMIT").await {
        if session.client.is_closed() {
            // The server may have committed before the socket went.
            return Err(ApplyFailure::commit_lost());
        }
        rollback(&session.client).await;
        return Err(ApplyFailure::other(message(&err)));
    }
    Ok(counts)
}

/// The table the batch's rows count under and every table's counters before
/// it runs, when its table can write elsewhere.
async fn reach_start(
    session: &PostgresSession,
    statements: &[RowStatement],
) -> Result<Option<((String, String), reach::Counts)>, String> {
    let Some(target) = statements.first().map(|s| s.target.as_str()) else {
        return Ok(None);
    };
    let literal = crate::query_util::sql_literal(
        crate::db::EngineKind::Postgres,
        &Value::Text(target.to_string()),
    )
    .ok_or_else(|| "The table's name can't be read".to_string())?;
    let Some(own) = reach::pg_reaches(session, &literal).await? else {
        return Ok(None);
    };
    Ok(reach::pg_counts(session).await?.map(|before| (own, before)))
}

/// What the batch wrote beyond its own rows. Deferred triggers fire first,
/// as COMMIT would fire them, so their rows count too.
async fn reach_beyond(
    session: &PostgresSession,
    own: (String, String),
    before: &reach::Counts,
    counts: &ApplyCounts,
) -> Result<Reach, String> {
    session
        .client
        .batch_execute("SET CONSTRAINTS ALL IMMEDIATE")
        .await
        .map_err(|e| map_query_error(&e, &session.config.username).into_message())?;
    let Some(after) = reach::pg_counts(session).await? else {
        return Ok(Reach::default());
    };
    let all = Reach {
        tables: reach::diff(before, &after),
        unnamed: 0,
    };
    Ok(reach::beyond(all, &own.0, &own.1, counts.rows()))
}

async fn rollback(client: &Client) {
    let _ = client.batch_execute("ROLLBACK").await;
}

/// A step of an apply timed out: cancel it and roll back, both bounded. If
/// the rollback doesn't come back, the session is `Unknown` (ours may still
/// be open), for the caller to drop rather than reuse.
async fn abandon_apply(session: &mut PostgresSession, limit: Duration) {
    let limit = limit.min(Duration::from_secs(5));
    let _ = tokio::time::timeout(
        limit,
        cancel_with_token(session.cancel_token.clone(), session.cancel_via.clone()),
    )
    .await;
    let rolled = tokio::time::timeout(limit, session.client.batch_execute("ROLLBACK")).await;
    session.txn = if matches!(rolled, Ok(Ok(()))) {
        TxnState::None
    } else {
        TxnState::Unknown
    };
}

fn fetch_sql(rows: u32) -> String {
    if rows == 0 {
        format!("FETCH ALL FROM {CURSOR}")
    } else {
        format!("FETCH FORWARD {rows} FROM {CURSOR}")
    }
}

/// A short page means the end: close. A failed fetch (cancel, an error in
/// a row) aborted the transaction: roll ours back.
async fn finish_fetch(
    session: &mut PostgresSession,
    rows: u32,
    fetched: Result<StreamStats, DriverError>,
) -> Result<(StreamStats, bool), DriverError> {
    match fetched {
        Ok(stats) => {
            let more = rows > 0 && stats.rows >= u64::from(rows);
            if !more {
                session_close_cursor(session).await;
            }
            Ok((stats, more))
        }
        Err(err) => {
            if session.cursor.take().is_some_and(|c| c.ours) {
                let _ = session.client.batch_execute("ROLLBACK").await;
            }
            Err(err)
        }
    }
}

pub async fn cancel_with_token(token: CancelToken, via: CancelVia) -> Result<(), DriverError> {
    match via {
        CancelVia::Plain => token.cancel_query(NoTls).await,
        CancelVia::Tls(tls) => token.cancel_query(tls).await,
        CancelVia::CloudSql(dialer) => {
            let stream = dialer
                .dial()
                .await
                .map_err(|e| DriverError::Message(e.to_string()))?;
            token.cancel_query_raw(stream, NoTls).await
        }
    }
    .map_err(|e| DriverError::Message(e.to_string()))
}

/// A database on the server, for the database switcher.
#[derive(Clone, Debug, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub struct DatabaseInfo {
    pub name: String,
    /// Null when the user may not connect to it (size needs CONNECT).
    pub size_bytes: Option<i64>,
}

/// Databases the server accepts connections to, templates left out.
pub async fn session_list_databases(
    session: &PostgresSession,
) -> Result<Vec<DatabaseInfo>, DriverError> {
    let rows = session
        .client
        .query(
            r"
            SELECT datname::text,
                   CASE WHEN has_database_privilege(datname, 'CONNECT')
                        THEN pg_catalog.pg_database_size(datname) END
            FROM pg_catalog.pg_database
            WHERE datallowconn AND NOT datistemplate
            ORDER BY datname
            ",
            &[],
        )
        .await
        .map_err(|e| map_query_error(&e, &session.config.username))?;
    Ok(rows
        .iter()
        .map(|row| DatabaseInfo {
            name: row.get(0),
            size_bytes: row.get(1),
        })
        .collect())
}

/// A fingerprint of the catalog's shape over columns that only change with
/// DDL (oid, name, schema, kind, column count of every user relation, and
/// every constraint), so a cached catalog can be confirmed in one round trip.
/// Row estimates and sizes are left out: they move without the schema moving.
pub async fn session_catalog_fingerprint(session: &PostgresSession) -> Result<String, DriverError> {
    let row = session
        .client
        .query_one(
            r"
            SELECT coalesce(md5(string_agg(
                       c.oid || ':' || c.relname || ':' || c.relnamespace || ':' || c.relkind::text || ':' || c.relnatts,
                       ',' ORDER BY c.oid)), '')
                   || '/' ||
                   coalesce((SELECT md5(string_agg(
                       k.oid || ':' || k.conrelid || ':' || k.contype::text || ':' || coalesce(k.conkey::text, ''),
                       ',' ORDER BY k.oid))
                     FROM pg_catalog.pg_constraint k
                     JOIN pg_catalog.pg_namespace kn ON kn.oid = k.connamespace
                     WHERE kn.nspname NOT IN ('pg_catalog', 'information_schema')), '')
            FROM pg_catalog.pg_class c
            JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
            WHERE c.relkind IN ('r', 'p', 'v', 'm', 'f')
              AND n.nspname NOT IN ('pg_catalog', 'information_schema')
              AND n.nspname NOT LIKE 'pg_toast%'
            ",
            &[],
        )
        .await
        .map_err(|e| DriverError::Message(e.to_string()))?;
    Ok(row.get(0))
}

pub async fn session_introspect(session: &PostgresSession) -> Result<SchemaCatalog, DriverError> {
    let db_name = session.config.database.clone();
    let client = &session.client;

    // Sizes come from `relpages` so introspection never stats every relation file.
    let tables_q = client.query(
        r"
        SELECT n.nspname AS schema_name,
               c.relname AS table_name,
               c.reltuples::float8 AS reltuples,
               parent.relname AS partition_of,
               c.relpages::bigint * current_setting('block_size')::bigint AS table_bytes,
               c.relkind::text AS relkind,
               pg_catalog.obj_description(c.oid, 'pg_class') AS comment,
               ARRAY(SELECT pn.nspname::text FROM pg_catalog.pg_inherits i
                       JOIN pg_catalog.pg_class p ON p.oid = i.inhparent
                       JOIN pg_catalog.pg_namespace pn ON pn.oid = p.relnamespace
                     WHERE i.inhrelid = c.oid ORDER BY i.inhseqno) AS parent_schemas,
               ARRAY(SELECT p.relname::text FROM pg_catalog.pg_inherits i
                       JOIN pg_catalog.pg_class p ON p.oid = i.inhparent
                     WHERE i.inhrelid = c.oid ORDER BY i.inhseqno) AS parent_names,
               c.relispartition
        FROM pg_catalog.pg_class c
        JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
        LEFT JOIN pg_catalog.pg_inherits inh
               ON c.relispartition AND inh.inhrelid = c.oid
        LEFT JOIN pg_catalog.pg_class parent
               ON parent.oid = inh.inhparent AND parent.relnamespace = c.relnamespace
        WHERE c.relkind IN ('r', 'p', 'v', 'm', 'f')
          AND n.nspname NOT IN ('pg_catalog', 'information_schema')
        ORDER BY 1, 2
        ",
        &[],
    );

    // pg_attribute over information_schema: real type names (`text[]`, enums,
    // `varchar(255)`) instead of `ARRAY` / `USER-DEFINED`, and a cheaper plan.
    // Partitions share their parent's columns, so they are not sent again.
    let columns_q = client.query(
        r"
        SELECT n.nspname, c.relname, a.attname,
               pg_catalog.format_type(a.atttypid, a.atttypmod),
               NOT a.attnotnull,
               -- An identity column fills itself but has no pg_attrdef row.
               COALESCE(pg_catalog.pg_get_expr(d.adbin, d.adrelid),
                        CASE a.attidentity
                          WHEN 'a' THEN 'generated always as identity'
                          WHEN 'd' THEN 'generated by default as identity'
                        END),
               pg_catalog.col_description(a.attrelid, a.attnum)
        FROM pg_catalog.pg_attribute a
        JOIN pg_catalog.pg_class c ON c.oid = a.attrelid
        JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
        LEFT JOIN pg_catalog.pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum
        WHERE c.relkind IN ('r', 'p', 'v', 'm', 'f')
          AND NOT c.relispartition
          AND a.attnum > 0
          AND NOT a.attisdropped
          AND n.nspname NOT IN ('pg_catalog', 'information_schema')
        ORDER BY 1, 2, a.attnum
        ",
        &[],
    );

    // Primary keys from pg_index: information_schema's views cost several
    // times more on large catalogs. Index details load per table on demand
    // (`session_table_indexes`); they took ~45% of this load on 10k tables.
    let pks_q = client.query(
        r"
        SELECT n.nspname, t.relname, a.attname
        FROM pg_catalog.pg_index ix
        JOIN pg_catalog.pg_class t ON t.oid = ix.indrelid
        JOIN pg_catalog.pg_namespace n ON n.oid = t.relnamespace
        CROSS JOIN LATERAL unnest(ix.indkey) WITH ORDINALITY AS k(attnum, ord)
        JOIN pg_catalog.pg_attribute a ON a.attrelid = t.oid AND a.attnum = k.attnum
        WHERE ix.indisprimary
          AND n.nspname NOT IN ('pg_catalog', 'information_schema')
          AND n.nspname NOT LIKE 'pg_toast%'
        ORDER BY 1, 2, k.ord
        ",
        &[],
    );

    // For completion: where unqualified names resolve, enum labels, and the
    // user's own functions (extension members like PostGIS's are left out).
    let search_path_q = client.query("SELECT current_schemas(false)::text[]", &[]);
    let enums_q = client.query(
        r"
        SELECT n.nspname, t.typname,
               ARRAY(SELECT e.enumlabel::text FROM pg_catalog.pg_enum e
                     WHERE e.enumtypid = t.oid ORDER BY e.enumsortorder)
        FROM pg_catalog.pg_type t
        JOIN pg_catalog.pg_namespace n ON n.oid = t.typnamespace
        WHERE t.typtype = 'e'
          AND n.nspname NOT IN ('pg_catalog', 'information_schema')
        ORDER BY 1, 2
        ",
        &[],
    );
    let functions_q = client.query(
        r"
        SELECT n.nspname, p.proname,
               pg_catalog.pg_get_function_identity_arguments(p.oid),
               pg_catalog.pg_get_function_result(p.oid)
        FROM pg_catalog.pg_proc p
        JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
        WHERE p.prokind IN ('f', 'a', 'w')
          AND n.nspname NOT IN ('pg_catalog', 'information_schema')
          AND n.nspname NOT LIKE 'pg_toast%'
          AND NOT EXISTS (
            SELECT 1 FROM pg_catalog.pg_depend dep
            WHERE dep.classid = 'pg_catalog.pg_proc'::regclass
              AND dep.objid = p.oid AND dep.deptype = 'e')
        ORDER BY 1, 2
        LIMIT 2000
        ",
        &[],
    );

    // conparentid = 0 skips the copies Postgres makes on every partition.
    let fks_q = client.query(
        r"
        SELECT n.nspname, t.relname, con.conname,
               ARRAY(SELECT a.attname::text
                     FROM unnest(con.conkey) WITH ORDINALITY AS k(attnum, ord)
                     JOIN pg_catalog.pg_attribute a
                       ON a.attrelid = con.conrelid AND a.attnum = k.attnum
                     ORDER BY k.ord),
               rn.nspname, rt.relname,
               ARRAY(SELECT a.attname::text
                     FROM unnest(con.confkey) WITH ORDINALITY AS k(attnum, ord)
                     JOIN pg_catalog.pg_attribute a
                       ON a.attrelid = con.confrelid AND a.attnum = k.attnum
                     ORDER BY k.ord),
               con.confdeltype::text
        FROM pg_catalog.pg_constraint con
        JOIN pg_catalog.pg_class t ON t.oid = con.conrelid
        JOIN pg_catalog.pg_namespace n ON n.oid = t.relnamespace
        JOIN pg_catalog.pg_class rt ON rt.oid = con.confrelid
        JOIN pg_catalog.pg_namespace rn ON rn.oid = rt.relnamespace
        WHERE con.contype = 'f'
          AND con.conparentid = 0
          AND n.nspname NOT IN ('pg_catalog', 'information_schema')
        ORDER BY 1, 2, 3
        ",
        &[],
    );

    // tokio-postgres pipelines concurrent queries on one connection: one round trip.
    let (table_rows, column_rows, pk_rows, fk_rows, search_path_rows, enum_rows, function_rows) =
        futures::try_join!(
            tables_q,
            columns_q,
            pks_q,
            fks_q,
            search_path_q,
            enums_q,
            functions_q
        )
        .map_err(|e| DriverError::Message(e.to_string()))?;

    use std::collections::HashMap;

    let mut schemas: HashMap<String, HashMap<String, TableNode>> = HashMap::new();

    for row in table_rows {
        let schema = row.get::<_, String>(0);
        let table = row.get::<_, String>(1);
        let reltuples: f64 = row.get(2);
        let partition_of: Option<String> = row.get(3);
        let inherits_from: Vec<(String, String)> = row
            .get::<_, Vec<String>>(7)
            .into_iter()
            .zip(row.get::<_, Vec<String>>(8))
            .collect();
        let kind = match row.get::<_, String>(5).as_str() {
            "v" => TableKind::View,
            "m" => TableKind::MaterializedView,
            "f" => TableKind::ForeignTable,
            _ => TableKind::Table,
        };
        // A plain view has no storage and no statistics of its own; a
        // foreign table's rows are stored elsewhere.
        let table_bytes: Option<i64> = if matches!(kind, TableKind::View | TableKind::ForeignTable)
        {
            None
        } else {
            row.get(4)
        };
        let row_estimate = if reltuples < 0.0 || kind == TableKind::View {
            RowEstimate::Unknown
        } else {
            RowEstimate::Approximate(reltuples.round() as u64)
        };
        schemas.entry(schema).or_default().insert(
            table.clone(),
            TableNode {
                name: table,
                kind,
                columns: Vec::new(),
                primary_key: Vec::new(),
                indexes: Vec::new(),
                row_estimate,
                partition_of,
                inherits_from,
                is_partition: row.get(9),
                foreign_keys: Vec::new(),
                table_bytes,
                index_bytes: None,
                // A plain view or foreign table has no indexes to fetch.
                indexes_deferred: !matches!(kind, TableKind::View | TableKind::ForeignTable),
                comment: row.get(6),
            },
        );
    }

    for row in column_rows {
        let schema = row.get::<_, String>(0);
        let table = row.get::<_, String>(1);
        let name = row.get::<_, String>(2);
        let type_name = row.get::<_, String>(3);
        let nullable: bool = row.get(4);
        let default: Option<String> = row.get(5);
        let comment: Option<String> = row.get(6);
        if let Some(table_node) = schemas.get_mut(&schema).and_then(|t| t.get_mut(&table)) {
            table_node.columns.push(ColumnNode {
                name,
                type_name,
                nullable,
                default,
                comment,
            });
        }
    }

    for row in pk_rows {
        let schema = row.get::<_, String>(0);
        let table = row.get::<_, String>(1);
        let column = row.get::<_, String>(2);
        if let Some(table_node) = schemas.get_mut(&schema).and_then(|t| t.get_mut(&table)) {
            table_node.primary_key.push(column);
        }
    }

    for row in fk_rows {
        let schema = row.get::<_, String>(0);
        let table = row.get::<_, String>(1);
        let on_delete = match row.get::<_, String>(7).as_str() {
            "r" => "RESTRICT",
            "c" => "CASCADE",
            "n" => "SET NULL",
            "d" => "SET DEFAULT",
            _ => "NO ACTION",
        };
        if let Some(table_node) = schemas.get_mut(&schema).and_then(|t| t.get_mut(&table)) {
            table_node.foreign_keys.push(ForeignKeyNode {
                name: row.get(2),
                columns: row.get(3),
                ref_schema: row.get(4),
                ref_table: row.get(5),
                ref_columns: row.get(6),
                on_delete: on_delete.to_string(),
            });
        }
    }

    let mut schema_nodes = Vec::new();
    for (schema_name, tables_map) in schemas {
        let mut tables = tables_map.into_values().collect::<Vec<_>>();
        tables.sort_by(|a, b| a.name.cmp(&b.name));
        schema_nodes.push(SchemaNode {
            name: schema_name,
            tables,
        });
    }
    schema_nodes.sort_by(|a, b| a.name.cmp(&b.name));

    let search_path = search_path_rows
        .first()
        .map(|row| row.get::<_, Vec<String>>(0))
        .unwrap_or_default();
    let enums = enum_rows
        .iter()
        .map(|row| EnumNode {
            schema: row.get(0),
            name: row.get(1),
            labels: row.get(2),
        })
        .collect();
    let functions = function_rows
        .iter()
        .map(|row| FunctionNode {
            schema: row.get(0),
            name: row.get(1),
            args: row.get(2),
            returns: row.get(3),
        })
        .collect();

    Ok(SchemaCatalog {
        databases: vec![DatabaseNode {
            name: db_name,
            schemas: schema_nodes,
        }],
        search_path,
        enums,
        functions,
        ..Default::default()
    })
}

/// Indexes of `tables` in `schema`, with sizes and scan counts, for Structure.
pub async fn session_table_indexes(
    session: &PostgresSession,
    schema: &str,
    tables: &[String],
) -> Result<Vec<TableIndexes>, DriverError> {
    let rows = session
        .client
        .query(
            r"
            SELECT t.relname, i.relname,
                   -- Each key column or expression on its own, without the
                   -- WHERE, INCLUDE or operator class the whole definition has.
                   ARRAY(SELECT pg_catalog.pg_get_indexdef(ix.indexrelid, k, true)
                         FROM generate_series(1, ix.indnkeyatts) k ORDER BY k),
                   ix.indisunique, ix.indisprimary, am.amname,
                   i.relpages::bigint * current_setting('block_size')::bigint,
                   s.idx_scan
            FROM pg_catalog.pg_index ix
            JOIN pg_catalog.pg_class i ON i.oid = ix.indexrelid
            JOIN pg_catalog.pg_class t ON t.oid = ix.indrelid
            JOIN pg_catalog.pg_namespace n ON n.oid = t.relnamespace
            JOIN pg_catalog.pg_am am ON am.oid = i.relam
            LEFT JOIN pg_catalog.pg_stat_user_indexes s ON s.indexrelid = ix.indexrelid
            WHERE n.nspname = $1 AND t.relname = ANY($2)
            ORDER BY 1, 2
            ",
            &[&schema, &tables],
        )
        .await
        .map_err(|e| DriverError::Message(e.to_string()))?;

    let mut out: Vec<TableIndexes> = tables
        .iter()
        .map(|table| TableIndexes {
            schema: schema.to_string(),
            table: table.clone(),
            indexes: Vec::new(),
            index_bytes: None,
        })
        .collect();
    for row in rows {
        let table: String = row.get(0);
        // An index dropped while this reads has NULLs here.
        let columns: Vec<Option<String>> = row.try_get(2).unwrap_or_default();
        let size_bytes: Option<i64> = row.get(6);
        let Some(entry) = out.iter_mut().find(|t| t.table == table) else {
            continue;
        };
        if let Some(bytes) = size_bytes {
            entry.index_bytes = Some(entry.index_bytes.unwrap_or(0) + bytes);
        }
        entry.indexes.push(IndexNode {
            name: row.get(1),
            columns: columns.iter().flatten().map(|c| unquote_ident(c)).collect(),
            unique: row.get(3),
            primary: row.get(4),
            method: Some(row.get(5)),
            size_bytes,
            scans: row.get(7),
        });
    }
    Ok(out)
}

/// What the plan hints need about `tables` (schema, table): each one's
/// estimated rows and its indexes. Tables it can't read are left out.
pub async fn session_plan_facts(
    session: &PostgresSession,
    tables: &[(Option<String>, String)],
) -> crate::plan::PlanFacts {
    let mut facts = crate::plan::PlanFacts::default();
    let mut schemas: Vec<&str> = tables
        .iter()
        .map(|(s, _)| s.as_deref().unwrap_or("public"))
        .collect();
    schemas.sort_unstable();
    schemas.dedup();
    for schema in schemas {
        let names: Vec<String> = tables
            .iter()
            .filter(|(s, _)| s.as_deref().unwrap_or("public") == schema)
            .map(|(_, t)| t.clone())
            .collect();
        let rows = session
            .client
            .query(
                r"
                SELECT c.relname, c.reltuples::float8
                FROM pg_catalog.pg_class c
                JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
                WHERE n.nspname = $1 AND c.relname = ANY($2)
                ",
                &[&schema, &names],
            )
            .await
            .unwrap_or_default();
        let Ok(indexes) = session_table_indexes(session, schema, &names).await else {
            continue;
        };
        for t in indexes {
            let estimate = rows
                .iter()
                .find(|r| r.get::<_, String>(0) == t.table)
                .map(|r| r.get::<_, f64>(1))
                .filter(|n| *n >= 0.0);
            facts.tables.push(crate::plan::TableFacts {
                schema: Some(t.schema),
                table: t.table,
                rows: estimate,
                indexes: t
                    .indexes
                    .into_iter()
                    .map(|i| crate::plan::IndexFacts {
                        name: i.name,
                        columns: i.columns,
                    })
                    .collect(),
            });
        }
    }
    facts
}

/// A quoted identifier's name (`"Odd ""Col"""` is `Odd "Col"`); anything
/// else, an expression, as written.
fn unquote_ident(text: &str) -> String {
    match text.strip_prefix('"').and_then(|t| t.strip_suffix('"')) {
        Some(inner) if !inner.replace(r#""""#, "").contains('"') => inner.replace(r#""""#, r#"""#),
        _ => text.to_string(),
    }
}

/// TLS for a session. `Verify` checks the chain and host name against the CA
/// file when one is given, else the system trust store plus Mozilla's roots.
/// `Prefer` and `Require` encrypt without checking the certificate, as libpq
/// does, so self-signed and private-CA servers connect.
fn make_tls_connector(
    mode: PostgresSslMode,
    root_cert: Option<&str>,
) -> Result<MakeRustlsConnect, DriverError> {
    let provider = Arc::new(rustls::crypto::ring::default_provider());
    let builder = ClientConfig::builder_with_provider(provider.clone())
        .with_safe_default_protocol_versions()
        .map_err(|e| DriverError::Message(e.to_string()))?;
    let config = if mode == PostgresSslMode::Verify {
        builder
            .with_root_certificates(root_store(root_cert)?)
            .with_no_client_auth()
    } else {
        builder
            .dangerous()
            .with_custom_certificate_verifier(Arc::new(EncryptOnly(provider)))
            .with_no_client_auth()
    };
    Ok(MakeRustlsConnect::new(config))
}

fn root_store(root_cert: Option<&str>) -> Result<RootCertStore, DriverError> {
    let Some(path) = root_cert.map(str::trim).filter(|p| !p.is_empty()) else {
        return Ok(trust_roots().clone());
    };
    let path = expand_home(path);
    let certs = CertificateDer::pem_file_iter(&path)
        .and_then(|iter| iter.collect::<Result<Vec<_>, _>>())
        .map_err(|e| {
            DriverError::Message(format!(
                "Couldn't read CA certificate {}: {e}",
                path.display()
            ))
        })?;
    let mut roots = RootCertStore::empty();
    if roots.add_parsable_certificates(certs).0 == 0 {
        return Err(DriverError::Message(format!(
            "No certificates found in {}",
            path.display()
        )));
    }
    Ok(roots)
}

/// Corporate and locally added CAs live in the system store; the Mozilla
/// roots cover machines where it can't be read. Loaded once, since reading
/// the macOS trust settings takes a while and every session needs them.
pub(crate) fn trust_roots() -> &'static RootCertStore {
    static ROOTS: OnceLock<RootCertStore> = OnceLock::new();
    ROOTS.get_or_init(|| {
        let mut roots = RootCertStore::empty();
        roots.add_parsable_certificates(rustls_native_certs::load_native_certs().certs);
        roots.extend(TLS_SERVER_ROOTS.iter().cloned());
        roots
    })
}

/// Accepts any server certificate but still checks the handshake signatures,
/// so the connection is encrypted to whoever holds the certificate's key.
#[derive(Debug)]
struct EncryptOnly(Arc<CryptoProvider>);

impl ServerCertVerifier for EncryptOnly {
    fn verify_server_cert(
        &self,
        _end_entity: &CertificateDer<'_>,
        _intermediates: &[CertificateDer<'_>],
        _server_name: &ServerName<'_>,
        _ocsp_response: &[u8],
        _now: UnixTime,
    ) -> Result<ServerCertVerified, rustls::Error> {
        Ok(ServerCertVerified::assertion())
    }

    fn verify_tls12_signature(
        &self,
        message: &[u8],
        cert: &CertificateDer<'_>,
        dss: &DigitallySignedStruct,
    ) -> Result<HandshakeSignatureValid, rustls::Error> {
        verify_tls12_signature(
            message,
            cert,
            dss,
            &self.0.signature_verification_algorithms,
        )
    }

    fn verify_tls13_signature(
        &self,
        message: &[u8],
        cert: &CertificateDer<'_>,
        dss: &DigitallySignedStruct,
    ) -> Result<HandshakeSignatureValid, rustls::Error> {
        verify_tls13_signature(
            message,
            cert,
            dss,
            &self.0.signature_verification_algorithms,
        )
    }

    fn supported_verify_schemes(&self) -> Vec<SignatureScheme> {
        self.0.signature_verification_algorithms.supported_schemes()
    }
}

/// The connection's saved database password ("" when none is saved). The
/// keychain can block (or prompt): off the async workers.
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

fn is_bad_password(err: &tokio_postgres::Error) -> bool {
    err.as_db_error()
        .is_some_and(|db| db.code().code() == "28P01")
        || says_bad_password(&error_chain(err))
}

/// A wrong password in the words of Postgres, or of a pooler in front of it
/// (PgBouncer, which Cloud SQL's managed pooling and Supabase run, says
/// "SASL authentication failed" with no 28P01).
fn says_bad_password(text: &str) -> bool {
    text.contains("password authentication failed") || text.contains("SASL authentication failed")
}

/// Why no password reached Postgres, when none did: the keychain refused the
/// read, or none is saved. `None` when a password was sent (it was wrong).
fn no_password_message(connection_id: &str, username: &str, empty: bool) -> Option<String> {
    if keychain_refused(connection_id) {
        return Some(format!(
            "Couldn't read the password for '{username}' from the Keychain, so none was sent. \
             Allow Rowkery when macOS asks, then try again."
        ));
    }
    empty.then(|| {
        format!(
            "Postgres asked for a password for '{username}' and none is saved for this connection."
        )
    })
}

pub fn humanize_postgres_error(err: &tokio_postgres::Error, username: &str) -> String {
    if let Some(db) = err.as_db_error() {
        if db.code().code() == "28P01" || says_bad_password(db.message()) {
            return format!("Postgres rejected password for '{username}'");
        }
        return db.message().to_string();
    }
    let text = error_chain(err);
    if says_bad_password(&text) {
        return format!("Postgres rejected password for '{username}'");
    }
    if text.contains("server does not support TLS") {
        return "The server doesn't accept SSL. Check SSL under Advanced.".into();
    }
    if text.contains("invalid peer certificate") {
        let reason = text
            .rsplit("invalid peer certificate: ")
            .next()
            .unwrap_or("");
        return format!(
            "Couldn't verify the server's certificate ({reason}). Check SSL under Advanced."
        );
    }
    text
}

/// The error with its causes, since tokio-postgres keeps TLS and IO details
/// in the source chain.
fn error_chain(err: &tokio_postgres::Error) -> String {
    let mut text = err.to_string();
    let mut source = std::error::Error::source(err);
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

fn quoted_after(haystack: &str, prefix: &str) -> Option<String> {
    let rest = haystack.split_once(prefix).map(|(_, after)| after.trim())?;
    let after_quote = rest.strip_prefix('"')?;
    let end = after_quote.find('"')?;
    Some(after_quote[..end].to_string())
}

/// Map a Postgres connection error string onto form fields (for probe/save UI).
pub fn map_postgres_error_to_fields(message: &str) -> crate::connections::PostgresFieldErrors {
    use crate::connections::PostgresFieldErrors;

    let mut errors = PostgresFieldErrors::default();
    if message.contains("does not exist") {
        if let Some(role) = quoted_after(message, "role") {
            errors.username = Some(format!("Role \"{role}\" does not exist on this server"));
            return errors;
        }
        if let Some(db) = quoted_after(message, "database") {
            errors.database = Some(format!("Database \"{db}\" does not exist on this server"));
            return errors;
        }
    }
    if message.contains("could not translate host name")
        || message.contains("Name or service not known")
        || message.contains("Connection refused")
    {
        errors.host = Some(message.to_string());
        return errors;
    }
    errors
}

/// One cell: decoded from its binary wire value when the type is known
/// (`decode_raw`), else through tokio-postgres's own conversions, else
/// `<type name>`. Money only `money_shown` ([`query_prepared`]): written
/// wrong, a key or an edit sent back would fail or mean another amount.
fn postgres_value_to_core(row: &Row, index: usize, money_shown: bool) -> Value {
    let ty = row.columns().get(index).map(|c| c.type_().clone());
    if let Some(ty) = ty.as_ref() {
        if !money_shown && holds_money(ty) {
            return match row.try_get::<_, Option<RawValue>>(index) {
                Ok(None) => Value::Null,
                _ => Value::Text(format!("<{}>", ty.name())),
            };
        }
        if let Some(v) = decode_known_type(row, index, ty) {
            return v;
        }
    }
    if let Ok(v) = row.try_get::<_, Option<bool>>(index) {
        return match v {
            Some(b) => Value::Bool(b),
            None => Value::Null,
        };
    }
    if let Ok(v) = row.try_get::<_, Option<i64>>(index) {
        return match v {
            Some(n) => Value::Int(n),
            None => Value::Null,
        };
    }
    if let Ok(v) = row.try_get::<_, Option<i32>>(index) {
        return match v {
            Some(n) => Value::Int(n as i64),
            None => Value::Null,
        };
    }
    if let Ok(v) = row.try_get::<_, Option<f64>>(index) {
        return match v {
            Some(n) => Value::Float(n),
            None => Value::Null,
        };
    }
    if let Ok(v) = row.try_get::<_, Option<String>>(index) {
        return match v {
            Some(s) => Value::Text(s),
            None => Value::Null,
        };
    }
    if let Ok(v) = row.try_get::<_, Option<Vec<u8>>>(index) {
        return match v {
            Some(b) => Value::Bytes(b),
            None => Value::Null,
        };
    }
    let type_name = ty.as_ref().unwrap_or(&Type::TEXT).name().to_string();
    Value::Text(format!("<{type_name}>"))
}

/// Accepts any column type and hands back the raw binary wire value, so we can
/// decode types tokio-postgres only supports behind optional crates (dates,
/// uuid, numeric) without pulling those crates in.
struct RawValue<'a>(&'a [u8]);

impl<'a> tokio_postgres::types::FromSql<'a> for RawValue<'a> {
    fn from_sql(
        _ty: &Type,
        raw: &'a [u8],
    ) -> Result<Self, Box<dyn std::error::Error + Sync + Send>> {
        Ok(RawValue(raw))
    }

    fn accepts(_ty: &Type) -> bool {
        true
    }
}

fn decode_known_type(row: &Row, index: usize, ty: &Type) -> Option<Value> {
    match row.try_get::<_, Option<RawValue>>(index) {
        Ok(None) => Some(Value::Null),
        Ok(Some(RawValue(bytes))) => decode_raw(ty, bytes),
        Err(_) => None,
    }
}

/// A binary wire value of type `ty`, or `None` for a type decoded no
/// other way than the generic `FromSql` paths (and then a placeholder).
fn decode_raw(ty: &Type, b: &[u8]) -> Option<Value> {
    use tokio_postgres::types::Kind;
    match ty.kind() {
        // An enum's binary value is its label.
        Kind::Enum(_) => return std::str::from_utf8(b).ok().map(|s| Value::Text(s.into())),
        Kind::Domain(base) => return decode_raw(base, b),
        Kind::Array(element) => return decode_array(element, b).map(Value::Text),
        _ => {}
    }
    match *ty {
        Type::BOOL => match b {
            [v] => Some(Value::Bool(*v != 0)),
            _ => None,
        },
        Type::INT2 => Some(Value::Int(i16::from_be_bytes(b.try_into().ok()?) as i64)),
        Type::INT4 => Some(Value::Int(i32::from_be_bytes(b.try_into().ok()?) as i64)),
        Type::INT8 => Some(Value::Int(i64::from_be_bytes(b.try_into().ok()?))),
        Type::FLOAT4 => Some(Value::Float(f32::from_be_bytes(b.try_into().ok()?) as f64)),
        Type::FLOAT8 => Some(Value::Float(f64::from_be_bytes(b.try_into().ok()?))),
        Type::OID => Some(Value::Int(u32::from_be_bytes(b.try_into().ok()?) as i64)),
        Type::NUMERIC => decode_numeric(b).map(Value::Text),
        Type::UUID => decode_uuid(b).map(Value::Text),
        Type::DATE => decode_date(b).map(Value::Text),
        Type::TIME => decode_time(b).map(Value::Text),
        Type::TIMESTAMP => decode_timestamp(b).map(Value::Text),
        Type::TIMESTAMPTZ => decode_timestamp(b).map(|s| Value::Text(format!("{s}+00"))),
        Type::TEXT | Type::VARCHAR | Type::BPCHAR | Type::NAME | Type::UNKNOWN => {
            std::str::from_utf8(b).ok().map(|s| Value::Text(s.into()))
        }
        Type::BYTEA => Some(Value::Bytes(b.to_vec())),
        Type::INTERVAL => text_types::interval(b).map(Value::Text),
        Type::INET | Type::CIDR => text_types::inet(b).map(Value::Text),
        Type::MACADDR => text_types::macaddr(b, 6).map(Value::Text),
        Type::MACADDR8 => text_types::macaddr(b, 8).map(Value::Text),
        Type::MONEY => text_types::money(b).map(Value::Text),
        Type::BIT | Type::VARBIT => text_types::bits(b).map(Value::Text),
        Type::TIMETZ => text_types::timetz(b).map(Value::Text),
        Type::CHAR => text_types::char(b).map(Value::Text),
        // As stored, never through serde_json's f64: big integers and long
        // decimals keep every digit, so an edit writes back what was read.
        // xml's binary value is its text; jsonb's is a version byte (1) and
        // then the text.
        Type::JSON | Type::XML => std::str::from_utf8(b).ok().map(|s| Value::Text(s.into())),
        Type::JSONB => match b {
            [1, text @ ..] => std::str::from_utf8(text)
                .ok()
                .map(|s| Value::Text(s.into())),
            _ => None,
        },
        _ => None,
    }
}

/// Whether arrays of `element` are shown as text (else a placeholder).
fn array_element_shown(element: &Type) -> bool {
    use tokio_postgres::types::Kind;
    matches!(element.kind(), Kind::Enum(_))
        || matches!(
            *element,
            Type::TEXT
                | Type::VARCHAR
                | Type::BPCHAR
                | Type::NAME
                | Type::INT2
                | Type::INT4
                | Type::INT8
                | Type::FLOAT4
                | Type::FLOAT8
                | Type::BOOL
                | Type::NUMERIC
                | Type::UUID
                | Type::DATE
                | Type::TIME
                | Type::TIMESTAMP
                | Type::TIMESTAMPTZ
                | Type::JSON
                | Type::JSONB
                | Type::XML
                | Type::INTERVAL
                | Type::INET
                | Type::CIDR
                | Type::MACADDR
                | Type::MACADDR8
                | Type::MONEY
                | Type::BIT
                | Type::VARBIT
                | Type::TIMETZ
                | Type::CHAR
        )
}

/// Postgres's text output of a float (`Infinity`, not Rust's `inf`).
fn format_pg_float(f: f64, as_f32: bool) -> String {
    if f.is_nan() {
        "NaN".into()
    } else if f.is_infinite() {
        if f > 0.0 { "Infinity" } else { "-Infinity" }.into()
    } else if as_f32 {
        (f as f32).to_string()
    } else {
        f.to_string()
    }
}

/// One array element as Postgres's array output writes it: in double
/// quotes (with `"` and `\` escaped) when it is empty, reads as NULL, or
/// holds a brace, comma, quote, backslash or white space.
fn quote_array_element(text: &str) -> String {
    let needs = text.is_empty()
        || text.eq_ignore_ascii_case("null")
        || text.chars().any(|c| {
            matches!(
                c,
                '{' | '}' | ',' | '"' | '\\' | ' ' | '\t' | '\n' | '\r' | '\x0b' | '\x0c'
            )
        });
    if !needs {
        return text.to_string();
    }
    let mut out = String::with_capacity(text.len() + 2);
    out.push('"');
    for c in text.chars() {
        if c == '"' || c == '\\' {
            out.push('\\');
        }
        out.push(c);
    }
    out.push('"');
    out
}

/// A one-dimensional binary array (`ndim`, has-null flag, element oid, then
/// per dimension its length and lower bound, then per element a length,
/// -1 for NULL, and the bytes) as Postgres's text output: `{a,NULL,"c d"}`,
/// `[0:1]={a,b}` when it doesn't start at 1. `None` for more dimensions or
/// an element type not shown.
fn decode_array(element: &Type, b: &[u8]) -> Option<String> {
    if !array_element_shown(element) {
        return None;
    }
    let int =
        |i: usize| -> Option<i32> { Some(i32::from_be_bytes(b.get(i..i + 4)?.try_into().ok()?)) };
    match int(0)? {
        0 => return Some("{}".into()),
        1 => {}
        _ => return None,
    }
    let len = usize::try_from(int(12)?).ok()?;
    let lower = int(16)?;
    let mut pos = 20;
    let mut parts = Vec::with_capacity(len.min(4096));
    for _ in 0..len {
        let n = int(pos)?;
        pos += 4;
        let Ok(n) = usize::try_from(n) else {
            parts.push("NULL".to_string());
            continue;
        };
        let raw = b.get(pos..pos + n)?;
        pos += n;
        let text = match decode_raw(element, raw)? {
            Value::Text(s) => s,
            Value::Int(n) => n.to_string(),
            Value::Float(f) => format_pg_float(f, *element == Type::FLOAT4),
            Value::Bool(v) => if v { "t" } else { "f" }.to_string(),
            _ => return None,
        };
        parts.push(quote_array_element(&text));
    }
    let body = format!("{{{}}}", parts.join(","));
    Some(if lower == 1 {
        body
    } else {
        format!("[{}:{}]={body}", lower, i64::from(lower) + len as i64 - 1)
    })
}

fn decode_uuid(b: &[u8]) -> Option<String> {
    if b.len() != 16 {
        return None;
    }
    let mut out = String::with_capacity(36);
    for (i, byte) in b.iter().enumerate() {
        if matches!(i, 4 | 6 | 8 | 10) {
            out.push('-');
        }
        out.push_str(&format!("{byte:02x}"));
    }
    Some(out)
}

/// Days since 2000-01-01 (Postgres epoch) → `YYYY-MM-DD`.
fn format_pg_date(days: i64) -> String {
    // Howard Hinnant's civil_from_days, shifted from the Unix epoch.
    let z = days + 10_957 + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097);
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let y = yoe + era * 400 + i64::from(m <= 2);
    format!("{y:04}-{m:02}-{d:02}")
}

fn format_time_of_day(micros: i64) -> String {
    let secs = micros / 1_000_000;
    let frac = micros % 1_000_000;
    let (h, m, s) = (secs / 3600, (secs / 60) % 60, secs % 60);
    if frac == 0 {
        format!("{h:02}:{m:02}:{s:02}")
    } else {
        let frac = format!("{frac:06}");
        format!("{h:02}:{m:02}:{s:02}.{}", frac.trim_end_matches('0'))
    }
}

fn decode_date(b: &[u8]) -> Option<String> {
    let days = i32::from_be_bytes(b.try_into().ok()?);
    Some(match days {
        i32::MAX => "infinity".into(),
        i32::MIN => "-infinity".into(),
        d => format_pg_date(d as i64),
    })
}

fn decode_time(b: &[u8]) -> Option<String> {
    Some(format_time_of_day(i64::from_be_bytes(b.try_into().ok()?)))
}

fn decode_timestamp(b: &[u8]) -> Option<String> {
    let micros = i64::from_be_bytes(b.try_into().ok()?);
    Some(match micros {
        i64::MAX => "infinity".into(),
        i64::MIN => "-infinity".into(),
        us => {
            const DAY: i64 = 86_400_000_000;
            let days = us.div_euclid(DAY);
            let tod = us.rem_euclid(DAY);
            format!("{} {}", format_pg_date(days), format_time_of_day(tod))
        }
    })
}

/// Postgres binary NUMERIC: ndigits, weight, sign, dscale, then base-10000 digits.
fn decode_numeric(b: &[u8]) -> Option<String> {
    let rd = |i: usize| -> Option<i16> { Some(i16::from_be_bytes([*b.get(i)?, *b.get(i + 1)?])) };
    let ndigits = rd(0)? as usize;
    let weight = rd(2)? as i32;
    let sign = rd(4)? as u16;
    let dscale = rd(6)?.max(0) as usize;
    match sign {
        0xC000 => return Some("NaN".into()),
        0xD000 => return Some("Infinity".into()),
        0xF000 => return Some("-Infinity".into()),
        _ => {}
    }
    let digits: Vec<i16> = (0..ndigits).map(|i| rd(8 + i * 2)).collect::<Option<_>>()?;
    let digit_at = |pos: i32| -> i16 {
        usize::try_from(pos)
            .ok()
            .and_then(|p| digits.get(p).copied())
            .unwrap_or(0)
    };

    let mut out = String::new();
    if sign == 0x4000 {
        out.push('-');
    }
    if weight < 0 {
        out.push('0');
    } else {
        for pos in 0..=weight {
            let d = digit_at(pos);
            if pos == 0 {
                out.push_str(&d.to_string());
            } else {
                out.push_str(&format!("{d:04}"));
            }
        }
    }
    if dscale > 0 {
        let mut frac = String::with_capacity(dscale + 4);
        let mut pos = weight + 1;
        while frac.len() < dscale {
            frac.push_str(&format!("{:04}", digit_at(pos)));
            pos += 1;
        }
        frac.truncate(dscale);
        out.push('.');
        out.push_str(&frac);
    }
    Some(out)
}

#[cfg(test)]
mod decode_tests {
    use super::*;

    #[test]
    fn formats_dates_around_the_epoch() {
        assert_eq!(format_pg_date(0), "2000-01-01");
        assert_eq!(format_pg_date(-1), "1999-12-31");
        assert_eq!(format_pg_date(9765), "2026-09-26");
        assert_eq!(format_pg_date(59), "2000-02-29");
    }

    #[test]
    fn formats_timestamps() {
        let us: i64 = (9765 * 86_400 + 14 * 3600 + 43 * 60 + 23) * 1_000_000 + 120_000;
        assert_eq!(
            decode_timestamp(&us.to_be_bytes()).as_deref(),
            Some("2026-09-26 14:43:23.12")
        );
        assert_eq!(
            decode_timestamp(&(-1i64).to_be_bytes()).as_deref(),
            Some("1999-12-31 23:59:59.999999")
        );
    }

    #[test]
    fn json_keeps_its_digits() {
        let text = r#"{"id": 9007199254740993, "amount": 0.1000000000000000055}"#;
        let mut jsonb = vec![1];
        jsonb.extend_from_slice(text.as_bytes());
        assert_eq!(
            decode_raw(&Type::JSONB, &jsonb),
            Some(Value::Text(text.into()))
        );
        assert_eq!(
            decode_raw(&Type::JSON, text.as_bytes()),
            Some(Value::Text(text.into()))
        );
        // An unknown jsonb version isn't guessed at.
        assert_eq!(decode_raw(&Type::JSONB, &[2, b'1']), None);
    }

    #[test]
    fn money_is_found_in_arrays_too() {
        assert!(holds_money(&Type::MONEY));
        assert!(holds_money(&Type::MONEY_ARRAY));
        assert!(!holds_money(&Type::NUMERIC));
        assert!(!holds_money(&Type::TEXT_ARRAY));
    }

    #[test]
    fn formats_uuid() {
        let b: Vec<u8> = (0u8..16).collect();
        assert_eq!(
            decode_uuid(&b).as_deref(),
            Some("00010203-0405-0607-0809-0a0b0c0d0e0f")
        );
    }

    fn numeric(ndigits: i16, weight: i16, sign: u16, dscale: i16, digits: &[i16]) -> Vec<u8> {
        let mut b = Vec::new();
        for v in [ndigits, weight, sign as i16, dscale] {
            b.extend_from_slice(&v.to_be_bytes());
        }
        for d in digits {
            b.extend_from_slice(&d.to_be_bytes());
        }
        b
    }

    #[test]
    fn formats_numeric() {
        // 12345.678 → digits [1, 2345, 6780], weight 1, dscale 3
        let b = numeric(3, 1, 0, 3, &[1, 2345, 6780]);
        assert_eq!(decode_numeric(&b).as_deref(), Some("12345.678"));
        // -0.0005 → digits [5], weight -1, dscale 4
        let b = numeric(1, -1, 0x4000, 4, &[5]);
        assert_eq!(decode_numeric(&b).as_deref(), Some("-0.0005"));
        // 10000 → digits [1], weight 1, dscale 0
        let b = numeric(1, 1, 0, 0, &[1]);
        assert_eq!(decode_numeric(&b).as_deref(), Some("10000"));
        // 0.00 → no digits, dscale 2
        let b = numeric(0, 0, 0, 2, &[]);
        assert_eq!(decode_numeric(&b).as_deref(), Some("0.00"));
    }
}

#[cfg(test)]
mod map_error_tests {
    use super::map_postgres_error_to_fields;

    #[test]
    fn maps_missing_role_to_username() {
        let errors = map_postgres_error_to_fields(r#"role "postgres" does not exist"#);
        assert_eq!(
            errors.username.as_deref(),
            Some("Role \"postgres\" does not exist on this server")
        );
    }
}
