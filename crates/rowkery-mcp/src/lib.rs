//! `Rowkery --mcp`: a Model Context Protocol server over stdio, so Claude
//! Code (or any MCP client) can read the schema of shared connections and run
//! guarded, read-only queries on them.
//!
//! It reads the same `config.json` and keychain as the app, on every call, so
//! turning sharing on or off in Rowkery takes effect at once.
//! Only connections with `allow_mcp` set are visible. Every query is one
//! SELECT (safe mode's classifier), runs in a read-only session with a 10 s
//! statement timeout (longer where the user gave the connection more), is
//! capped by wrapping it in `LIMIT`, and is refused when its plan reads a
//! big table end to end. Each call is appended to
//! `mcp-log.jsonl` beside the config.

pub mod access;
pub mod audit;
mod change;
#[cfg(all(test, feature = "postgres-integration"))]
mod e2e_tests;
mod functions;
mod guard;
pub mod health;
mod lineage;
pub mod mask;
pub mod picker;
pub mod proposals;
pub mod samples;
pub mod sessions;
mod target;
mod views;

use std::collections::HashMap;
use std::sync::Arc;

use rmcp::handler::server::ServerHandler;
use rmcp::model::{
    CacheScope, CallToolRequestParams, CallToolResponse, CallToolResult, ContentBlock,
    Implementation, ListResourcesResult, ListToolsResult, PaginatedRequestParams,
    ReadResourceRequestParams, ReadResourceResponse, ServerCapabilities, ServerConfig, Tool,
    ToolAnnotations,
};
use rmcp::service::{RequestContext, RoleServer};
use rmcp::{ErrorData as McpError, ServiceExt};
use rowkery_core::config::AppConfig;
use rowkery_core::connections::ConnectionRecord;
use rowkery_core::db::{EngineKind, RowEstimate, SchemaCatalog, TableKind, TableNode};
use serde_json::{json, Map, Value as Json};
use tokio::sync::Mutex;

use access::Tables;
use guard::{BIG_TABLE_ROWS, PAYLOAD_BYTES};
use target::{resolve, Store, Target};

const INSTRUCTIONS: &str =
    "Rowkery gives read-only access to the database connections the user shared \
from the Rowkery app. Start with list_connections. Before writing a query, look at the tables with \
list_tables or search_schema and call describe_table for each table you will use, so you know its \
columns and indexes. Filter on indexed columns, aggregate in SQL (count, sum, group by) instead of \
pulling rows, and ask for no more rows than you will read. Queries are single SELECT statements; \
results are capped (200 rows by default, 1000 at most) and a plan that reads a table of more than \
100,000 rows end to end is refused, so rewrite it with an indexed WHERE. explain shows the plan \
without running the query. Columns the user marked sensitive come back masked (masked: and ten hex \
digits; the same value always gives the same stand-in). You can return or count a masked column (on SQLite \
only return it) but not filter, sort, group or join on it; describe_table lists them. For a slow or stuck database, sessions shows \
what's running, what each session waits on and who blocks whom, and health shows what will hurt soon \
(unused or missing indexes, dead rows, ids running out, the slowest queries). Queries never change data: the session is \
read-only. To change data, call propose_change with the INSERT, UPDATE or DELETE statements and why: \
the user reviews a dry run in Rowkery and commits or rejects it, and check_proposal tells you which. \
Don't send a rejected change again. Before a change, describe_table shows the columns, defaults, keys \
and enum labels; don't query existing rows just to see example values. Read only what the change \
depends on, such as the row it updates or an id it references, and select only the columns you need.";

/// The checks a logged query passes again, without a database, before a
/// `rowkery://open` link puts it in a tab: one read statement, no `U&"…"`
/// name, no function refused by name and no schema-qualified call outside
/// `pg_catalog` / `information_schema`. The log is a plain file, so its
/// verdict alone proves nothing. A bare call to a function defined in the
/// database still passes: telling it from a built-in needs the catalog.
/// The engine isn't known here, so text the engines read differently fails
/// closed.
pub fn recheck_logged_read(sql: &str) -> Result<(), String> {
    let sql = guard::single_read(sql, rowkery_core::safety::Dialect::Either)?;
    let scan = functions::scan_sql(&sql);
    if scan.unicode_names {
        return Err(
            "Refused: names written with Unicode escapes (U&\"…\") can't be checked here.".into(),
        );
    }
    for call in &scan.calls {
        if let Some(schema) = call.schema.as_deref() {
            if !matches!(schema, "pg_catalog" | "information_schema") {
                return Err(format!(
                    "Refused: {schema}.{}() isn't built into Postgres.",
                    call.name
                ));
            }
        }
        if let Some(why) = functions::refused_builtin(&call.name) {
            return Err(format!("Refused: {} {why}.", call.name));
        }
        // An extension that runs SQL in another session, called unqualified.
        if call.name.starts_with("pg_background_") {
            return Err(format!(
                "Refused: {}() isn't built into Postgres.",
                call.name
            ));
        }
    }
    Ok(())
}

#[cfg(test)]
mod recheck_tests {
    use super::recheck_logged_read;

    #[test]
    fn refuses_hidden_names_and_database_functions() {
        for sql in [
            r#"SELECT U&"pg\005fterminate\005fbackend"(pid) FROM pg_stat_activity"#,
            r#"SELECT U&"set\005fconfig"('a', 'b', false)"#,
            "SELECT cron.schedule('* * * * *', 'DELETE FROM users')",
            "SELECT public.purge_all_orders()",
            "SELECT pg_background_launch('DELETE FROM users')",
            "SELECT pg_terminate_backend(42)",
        ] {
            assert!(recheck_logged_read(sql).is_err(), "{sql}");
        }
        for sql in [
            "select 1",
            "select lower(name) from users",
            "select pg_catalog.lower('A')",
            "select * from information_schema.tables",
        ] {
            assert!(recheck_logged_read(sql).is_ok(), "{sql}");
        }
    }
}

/// Runs the server on stdin / stdout until the client disconnects.
pub fn run_stdio() -> i32 {
    let runtime = match tokio::runtime::Runtime::new() {
        Ok(rt) => rt,
        Err(err) => {
            eprintln!("rowkery mcp: {err}");
            return 1;
        }
    };
    runtime.block_on(async {
        let server = RowkeryMcp::default();
        match server.serve(rmcp::transport::stdio()).await {
            Ok(running) => {
                let _ = running.waiting().await;
                0
            }
            Err(err) => {
                eprintln!("rowkery mcp: {err}");
                1
            }
        }
    })
}

type Stores = HashMap<(String, String), Arc<Mutex<Store>>>;

#[derive(Clone, Default)]
pub struct RowkeryMcp {
    /// One store per connection and database: a call waits only for calls
    /// on the same one, which share its session.
    stores: Arc<std::sync::Mutex<Stores>>,
    /// The client's name from its handshake, kept with what it proposes.
    client: Arc<std::sync::Mutex<Option<String>>>,
}

fn schema(properties: Json, required: &[&str]) -> Arc<Map<String, Json>> {
    let value = json!({ "type": "object", "properties": properties, "required": required });
    Arc::new(value.as_object().cloned().unwrap_or_default())
}

fn tools() -> Vec<Tool> {
    let connection =
        json!({ "type": "string", "description": "Connection id or name from list_connections" });
    let database = json!({ "type": "string", "description": "Postgres database (default: the connection's own)" });
    let read_only = ToolAnnotations::new().read_only(true).destructive(false);
    let tool = |name: &'static str, description: &'static str, props: Json, required: &[&str]| {
        Tool::new(name, description, schema(props, required)).with_annotations(read_only.clone())
    };
    vec![
        tool(
            "list_connections",
            "Saved Rowkery connections the user shared with MCP: id, name, engine, environment label, masked host, default database.",
            json!({}),
            &[],
        ),
        tool(
            "list_databases",
            "Databases on a Postgres connection (SQLite has one, \"main\").",
            json!({ "connection": connection }),
            &["connection"],
        ),
        tool(
            "list_tables",
            "Tables and views with approximate row counts and column counts: up to 500, schemas on the search path first, with a count per schema of any not listed. Cached for the session; refresh reloads the schema.",
            json!({ "connection": connection, "database": database,
                    "schema": { "type": "string", "description": "List only this schema" },
                    "refresh": { "type": "boolean", "description": "Reload the schema from the database" } }),
            &["connection"],
        ),
        tool(
            "search_schema",
            "Find tables and columns whose name contains the text. Cheaper than listing a big schema.",
            json!({ "connection": connection, "database": database,
                    "text": { "type": "string", "description": "Part of a table or column name" } }),
            &["connection", "text"],
        ),
        tool(
            "describe_table",
            "Columns (type, nullability, default), primary key, indexes with their columns, foreign keys both ways and enum labels. Use it to pick indexed columns before querying.",
            json!({ "connection": connection, "database": database,
                    "table": { "type": "string", "description": "Table name, optionally schema.table" } }),
            &["connection", "table"],
        ),
        tool(
            "explain",
            "The query plan without running the query (EXPLAIN, never ANALYZE), its slowest step, one hint when a rule matches (a missing index, a sort on disk), and whether query would refuse it for reading a big table end to end.",
            json!({ "connection": connection, "database": database,
                    "sql": { "type": "string", "description": "One SELECT statement" } }),
            &["connection", "sql"],
        ),
        tool(
            "query",
            "Run one read-only SELECT. Returns column names once, rows as arrays, and more: true when the row cap cut the result. Capped at max_rows (default 200, max 1000); refused if the plan reads a table of over 100,000 rows end to end; 10 s timeout unless list_connections gives the connection a longer timeout_s.",
            json!({ "connection": connection, "database": database,
                    "sql": { "type": "string", "description": "One SELECT statement" },
                    "max_rows": { "type": "integer", "minimum": 1, "maximum": guard::MAX_ROWS } }),
            &["connection", "sql"],
        ),
        tool(
            "sessions",
            "What's running on a Postgres database: each session's user, application, state, how long it has been at it, what it waits on and which sessions block it. Blockers come first; idle sessions are left out unless include_idle. Query text has its values replaced by ?, and a query on a table not shared with you is blanked.",
            json!({ "connection": connection, "database": database,
                    "include_idle": { "type": "boolean", "description": "Also list idle sessions" } }),
            &["connection"],
        ),
        tool(
            "health",
            "What will hurt soon on the database, from its catalog and statistics (on Postgres no table is read; on SQLite it walks the file's pages): IDs running out, transaction age, inactive replication slots, unused and repeated indexes, foreign keys with no index, dead rows, never-analyzed tables, long idle transactions, and on Postgres the slowest queries from pg_stat_statements. Each finding has its numbers, how far to trust it and the SQL that would fix it, which you can't run: tell the user. Only shared tables are covered: left_out counts a check's findings on tables not shared, and a foreign key's unshared parent is not named. Query text has its values replaced by ?.",
            json!({ "connection": connection, "database": database }),
            &["connection"],
        ),
        Tool::new(
            "propose_change",
            "Ask the user to make a change to the data. Send INSERT, UPDATE and DELETE statements (no CTEs, RETURNING, UPDATE … FROM or DELETE … USING) on shared tables, with reason saying why. Nothing runs now: Rowkery shows the user a dry run and only they can commit it. Returns an id at once; call check_proposal later to learn whether it was committed, rejected or expired (after 24 h). Masked columns can't be mentioned, and functions defined in the database can't be called.",
            schema(
                json!({ "connection": connection, "database": database,
                        "sql": { "type": "string", "description": "One or more INSERT, UPDATE or DELETE statements, run in order in one transaction" },
                        "reason": { "type": "string", "description": "Why, in a sentence the user will read next to the SQL" },
                        "expect_rows": { "type": "integer", "minimum": 0, "description": "How many rows you expect to change in all, shown next to the dry run's count" } }),
                &["connection", "sql", "reason"],
            ),
        )
        .with_annotations(ToolAnnotations::new().read_only(false).destructive(false)),
        tool(
            "check_proposal",
            "What became of a change sent with propose_change: waiting, committed (with rows changed), rejected (with the user's note, if any), failed or expired.",
            json!({ "id": { "type": "string", "description": "The id propose_change returned" } }),
            &["id"],
        ),
    ]
}

/// What a tool call produced, before it is wrapped for the client.
type Outcome = Result<Json, String>;

fn text_result(outcome: &Outcome) -> CallToolResult {
    match outcome {
        Ok(value) => CallToolResult::success(vec![ContentBlock::text(value.to_string())]),
        Err(message) => CallToolResult::error(vec![ContentBlock::text(message.clone())]),
    }
}

fn arg<'a>(args: &'a Map<String, Json>, name: &str) -> Option<&'a str> {
    args.get(name).and_then(Json::as_str)
}

fn required<'a>(args: &'a Map<String, Json>, name: &str) -> Result<&'a str, String> {
    arg(args, name)
        .filter(|s| !s.trim().is_empty())
        .ok_or_else(|| format!("Missing \"{name}\"."))
}

fn engine(record: &ConnectionRecord) -> EngineKind {
    match record {
        ConnectionRecord::Sqlite(_) => EngineKind::Sqlite,
        ConnectionRecord::Postgres(_) => EngineKind::Postgres,
    }
}

fn rows_estimate(estimate: &RowEstimate) -> Option<u64> {
    match estimate {
        RowEstimate::Exact(n) | RowEstimate::Approximate(n) => Some(*n),
        RowEstimate::Unknown => None,
    }
}

fn kind_label(kind: TableKind) -> &'static str {
    match kind {
        TableKind::Table => "table",
        TableKind::View => "view",
        TableKind::MaterializedView => "materialized view",
        TableKind::ForeignTable => "foreign table",
    }
}

/// `schema.table` or `table`; a bare name is looked up along the search path,
/// then in any schema when only one has it.
fn find_table<'a>(
    catalog: &'a SchemaCatalog,
    name: &str,
) -> Result<(&'a str, &'a TableNode), String> {
    let name = name.trim().trim_matches('"');
    let (schema, table) = match name.split_once('.') {
        Some((s, t)) => (Some(s.trim_matches('"')), t.trim_matches('"')),
        None => (None, name),
    };
    let mut hits: Vec<(&str, &TableNode)> = catalog
        .databases
        .iter()
        .flat_map(|db| db.schemas.iter())
        .filter(|s| schema.is_none_or(|want| s.name.eq_ignore_ascii_case(want)))
        .flat_map(|s| s.tables.iter().map(move |t| (s.name.as_str(), t)))
        .filter(|(_, t)| t.name.eq_ignore_ascii_case(table))
        .collect();
    if hits.len() > 1 {
        if let Some(pos) = catalog
            .search_path
            .iter()
            .find_map(|sp| hits.iter().position(|(s, _)| s == sp))
        {
            return Ok(hits.swap_remove(pos));
        }
        let names: Vec<String> = hits
            .iter()
            .map(|(s, t)| format!("{s}.{}", t.name))
            .collect();
        return Err(format!(
            "\"{name}\" is in several schemas: {}. Pass schema.table.",
            names.join(", ")
        ));
    }
    hits.pop()
        .ok_or_else(|| format!("No table \"{name}\". Try search_schema."))
}

fn all_tables(catalog: &SchemaCatalog) -> impl Iterator<Item = (&str, &TableNode)> {
    catalog
        .databases
        .iter()
        .flat_map(|db| db.schemas.iter())
        .flat_map(|s| s.tables.iter().map(move |t| (s.name.as_str(), t)))
}

/// The table rule of the database a call resolved to (shared, or `resolve`
/// would have refused it).
fn rule(target: &Target) -> Tables<'_> {
    access::tables(&target.record, &target.database).unwrap_or(Tables::Only(&[]))
}

/// The arguments as the agent sent them, for the log: cut at 4 KB.
fn logged_args(args: &Map<String, Json>) -> Json {
    const MAX: usize = 4096;
    let text = Json::Object(args.clone()).to_string();
    if text.len() <= MAX {
        return Json::Object(args.clone());
    }
    let mut end = MAX;
    while !text.is_char_boundary(end) {
        end -= 1;
    }
    json!(format!("{}…", &text[..end]))
}

fn age(loaded: std::time::Instant) -> String {
    let secs = loaded.elapsed().as_secs();
    match secs {
        0..=59 => "just now".into(),
        60..=3599 => format!("{} min ago", secs / 60),
        _ => format!("{} h ago", secs / 3600),
    }
}

impl RowkeryMcp {
    fn stores(&self) -> std::sync::MutexGuard<'_, Stores> {
        self.stores.lock().unwrap_or_else(|e| e.into_inner())
    }

    /// Drops the sessions and schemas of connections no longer shared, so a
    /// transaction a stopped call left open ends with the sharing.
    fn forget_unshared(&self, config: &AppConfig) {
        self.stores().retain(|(id, _), _| {
            config
                .connections
                .iter()
                .any(|c| c.allow_mcp() && c.id() == id)
        });
    }

    /// Drops the target's store once a call leaves it holding nothing and
    /// no other call is waiting on it, as for a database that isn't there.
    fn forget_idle(&self, key: &(String, String)) {
        let mut stores = self.stores();
        let idle = stores.get(key).is_some_and(|store| {
            Arc::strong_count(store) == 1 && store.try_lock().is_ok_and(|s| s.is_idle())
        });
        if idle {
            stores.remove(key);
        }
    }

    /// Runs one tool call; the entry to log, and whether a sample of the
    /// response may be kept (off per connection with `mcp_samples_off`).
    async fn dispatch(
        &self,
        name: &str,
        args: &Map<String, Json>,
    ) -> (Outcome, audit::Entry, bool) {
        let mut entry = audit::Entry::new(name);
        entry.connection = arg(args, "connection").map(str::to_string);
        entry.sql = arg(args, "sql").map(str::to_string);
        entry.args = Some(logged_args(args));
        let config = match AppConfig::load() {
            Ok(c) => c,
            Err(err) => {
                return (
                    Err(format!("Couldn't read Rowkery's config: {err}")),
                    entry,
                    false,
                )
            }
        };
        self.forget_unshared(&config);
        if name == "list_connections" {
            entry.rows = Some(config.connections.iter().filter(|c| c.allow_mcp()).count() as u64);
            // The list names every shared connection, so it's kept only when
            // none of them has its response samples switched off.
            let keep = config
                .connections
                .iter()
                .filter(|c| c.allow_mcp())
                .all(|c| c.mcp_samples());
            return (Ok(list_connections(&config)), entry, keep);
        }
        if name == "check_proposal" {
            entry.target = arg(args, "id").map(str::to_string);
            let outcome = required(args, "id").and_then(proposals::status);
            return (outcome, entry, false);
        }
        let target = match required(args, "connection")
            .and_then(|c| resolve(&config, c, arg(args, "database")))
        {
            Ok(t) => t,
            Err(e) => return (Err(e), entry, false),
        };
        entry.connection = Some(target.id().to_string());
        entry.database = Some(target.database.clone());
        let shared = self.stores().entry(target.key()).or_default().clone();
        let mut store = shared.lock().await;
        // A call that waited behind a long one runs as the config is now.
        let target = match current(&target) {
            Ok(t) => t,
            Err(e) => return (Err(e), entry, false),
        };
        store.settle();
        let cap =
            (name == "query").then(|| guard::row_cap(args.get("max_rows").and_then(Json::as_u64)));
        entry.scope = Some(rule(&target).scope(&target.record, cap));
        entry.target = arg(args, "table")
            .or_else(|| arg(args, "text"))
            .map(str::to_string);
        let outcome = match name {
            "list_databases" => list_databases(&mut store, &target).await,
            "list_tables" => {
                let refresh = args.get("refresh").and_then(Json::as_bool).unwrap_or(false);
                let schema = args.get("schema").and_then(Json::as_str);
                list_tables(&mut store, &target, refresh, schema).await
            }
            "search_schema" => match required(args, "text") {
                Ok(text) => search_schema(&mut store, &target, text).await,
                Err(e) => Err(e),
            },
            "describe_table" => match required(args, "table") {
                Ok(table) => describe_table(&mut store, &target, table).await,
                Err(e) => Err(e),
            },
            "explain" | "query" => match required(args, "sql") {
                Ok(sql) => {
                    let max_rows = args.get("max_rows").and_then(Json::as_u64);
                    // The checks and the run in one transaction (`Store::begin`).
                    match store.begin(&target).await {
                        Ok(()) => {
                            let read = run_read(
                                &mut store,
                                &target,
                                sql,
                                max_rows,
                                name == "explain",
                                &mut entry,
                            )
                            .await;
                            store.end(&target).await;
                            read
                        }
                        Err(e) => Err(e),
                    }
                }
                Err(e) => Err(e),
            },
            "sessions" => {
                let include_idle = args
                    .get("include_idle")
                    .and_then(Json::as_bool)
                    .unwrap_or(false);
                list_sessions(&mut store, &target, include_idle, &mut entry).await
            }
            "health" => database_health(&mut store, &target).await,
            "propose_change" => {
                let client = self.client.lock().ok().and_then(|c| c.clone());
                propose(&mut store, &target, args, client).await
            }
            other => Err(format!("Unknown tool \"{other}\".")),
        };
        // Sharing turned off or changed while it ran: the answer isn't sent.
        // A queued change is the user's to review either way.
        let outcome = match current(&target) {
            Ok(now) if now.record == target.record || name == "propose_change" => outcome,
            _ => Err("The connection's sharing changed during the call, so its answer was dropped. Call again.".into()),
        };
        drop(store);
        drop(shared);
        self.forget_idle(&target.key());
        (outcome, entry, target.record.mcp_samples())
    }
}

/// The target as the config has it now.
fn current(target: &Target) -> Result<Target, String> {
    let config = AppConfig::load().map_err(|e| format!("Couldn't read Rowkery's config: {e}"))?;
    let now = resolve(&config, target.id(), Some(&target.database))?;
    if now.key() != target.key() {
        return Err("The connection's sharing changed during the call. Call again.".into());
    }
    Ok(now)
}

/// Checks a change and queues it for the user; nothing runs.
async fn propose(
    store: &mut Store,
    target: &Target,
    args: &Map<String, Json>,
    client: Option<String>,
) -> Outcome {
    let sql = required(args, "sql")?;
    // A blank reason gets validate_input's "say why", not a bare "Missing".
    let reason = arg(args, "reason").unwrap_or_default();
    proposals::validate_input(sql, reason)?;
    let changes = change::check(store, target, sql).await?;
    let expect_rows = args.get("expect_rows").and_then(Json::as_u64);
    let proposal = proposals::submit(
        target.id(),
        &target.database,
        sql,
        reason,
        expect_rows,
        client,
    )?;
    Ok(json!({
        "id": proposal.id,
        "state": "waiting",
        "statements": changes.len(),
        "note": "Waiting for the user to review it in Rowkery. Call check_proposal with this id later; don't send it again.",
    }))
}

fn list_connections(config: &AppConfig) -> Json {
    let shared: Vec<Json> = config
        .connections
        .iter()
        .filter(|c| c.allow_mcp())
        .map(|c| {
            let mut item =
                json!({ "id": c.id(), "name": c.display_name(), "engine": c.engine_label() });
            if let Some(env) = c.environment() {
                item["environment"] = serde_json::to_value(env).unwrap_or(Json::Null);
            }
            if let ConnectionRecord::Postgres(pg) = c {
                item["host"] = json!(guard::mask_host(&pg.host));
            }
            item["database"] = json!(access::default_database(c));
            let timeout = guard::statement_timeout(c);
            if timeout != guard::STATEMENT_TIMEOUT {
                item["timeout_s"] = json!(timeout.as_secs());
            }
            if let Some(list) = access::databases(c) {
                if list.len() > 1 {
                    item["databases"] = json!(list);
                }
            }
            item
        })
        .collect();
    let hidden = config.connections.len() - shared.len();
    let mut out = json!({ "connections": shared });
    if hidden > 0 {
        out["not_shared"] = json!(format!(
            "{hidden} more saved connection(s) are not shared. The user can share one in Rowkery, under Settings › Agents."
        ));
    }
    out
}

async fn list_databases(store: &mut Store, target: &Target) -> Outcome {
    let list = store.list_databases(target).await?;
    let names: Vec<Json> = list
        .into_iter()
        .filter(|(name, _)| access::tables(&target.record, name).is_some())
        .map(|(name, size)| match size {
            Some(bytes) => json!(format!("{name} ({} MB)", bytes / 1_048_576)),
            None => json!(name),
        })
        .collect();
    Ok(json!({ "databases": names }))
}

/// A partition, in its parent's schema or another.
fn is_partition(t: &TableNode) -> bool {
    t.is_partition || t.partition_of.is_some()
}

/// Whether `schema.t` gets a line of its own: a partition is counted with
/// its parent instead, unless the parent isn't shared (a partition ticked
/// on its own).
fn own_line(rule: &access::Tables, catalog: &SchemaCatalog, schema: &str, t: &TableNode) -> bool {
    if !is_partition(t) {
        return true;
    }
    let parent = t
        .inherits_from
        .first()
        .map(|(s, n)| (s.as_str(), n.as_str()))
        .or_else(|| t.partition_of.as_deref().map(|p| (schema, p)));
    match parent.and_then(|(s, n)| catalog.table(s, n).map(|p| (s, p))) {
        Some((s, p)) => !rule.allows_node(catalog, s, p),
        None => true,
    }
}

/// The table whose columns `schema.t` has: a partition's are its root
/// table's, since the catalog lists them once per partitioned table.
fn column_source<'a>(
    catalog: &'a SchemaCatalog,
    schema: &'a str,
    t: &'a TableNode,
) -> &'a TableNode {
    if !t.columns.is_empty() || !is_partition(t) {
        return t;
    }
    access::partition_of(catalog, schema, t)
        .last()
        .and_then(|&(s, n)| catalog.table(s, n))
        .unwrap_or(t)
}

/// The schema a relation named without one is in.
fn default_schema(record: &ConnectionRecord) -> &'static str {
    match record {
        ConnectionRecord::Postgres(_) => "public",
        ConnectionRecord::Sqlite(_) => "main",
    }
}

/// Tables `list_tables` names. A schema of thousands would fill the agent's
/// context; past this, it counts the rest per schema.
const MAX_TABLES: usize = 500;

/// MySQL isn't shared with agents until its guards are in.
const MYSQL_NOT_SHARED: &str = "Refused: Rowkery doesn't share MySQL connections with agents yet.";

async fn list_tables(
    store: &mut Store,
    target: &Target,
    refresh: bool,
    schema: Option<&str>,
) -> Outcome {
    let rule = rule(target);
    let cached = store.catalog(target, refresh).await?;
    let catalog = &cached.catalog;
    let wanted = |s: &str| schema.is_none_or(|want| s.eq_ignore_ascii_case(want.trim()));
    // Counted in one pass: one per table is slow with thousands of them.
    // A hidden partition isn't counted: the count would tell it's there.
    let mut partitions = std::collections::HashMap::<(&str, &str), usize>::new();
    for (s, t) in all_tables(catalog) {
        if !is_partition(t) || !rule.allows_node(catalog, s, t) {
            continue;
        }
        let parent = t
            .inherits_from
            .first()
            .map(|(s, n)| (s.as_str(), n.as_str()))
            .or_else(|| t.partition_of.as_deref().map(|p| (s, p)));
        if let Some(parent) = parent {
            *partitions.entry(parent).or_default() += 1;
        }
    }
    let mut shared: Vec<(&str, &TableNode)> = all_tables(catalog)
        .filter(|(s, _)| wanted(s))
        .filter(|(s, t)| own_line(&rule, catalog, s, t))
        .filter(|(s, t)| rule.allows_node(catalog, s, t))
        .collect();
    if let Some(want) = schema.filter(|_| shared.is_empty()) {
        if !catalog
            .databases
            .iter()
            .flat_map(|db| db.schemas.iter())
            .any(|s| wanted(&s.name))
        {
            return Err(format!("No schema \"{}\".", want.trim()));
        }
    }
    // The schemas a bare name finds first are the ones the agent will want.
    let rank = |s: &str| catalog.search_path.iter().position(|p| p == s);
    shared.sort_by_key(|(s, _)| rank(s).unwrap_or(usize::MAX));
    let tables: Vec<Json> = shared
        .iter()
        .take(MAX_TABLES)
        .map(|&(schema, t)| {
            let mut line = format!("{schema}.{}", t.name);
            if t.kind != TableKind::Table {
                line.push_str(&format!(" ({})", kind_label(t.kind)));
            }
            if let Some(rows) = rows_estimate(&t.row_estimate) {
                line.push_str(&format!(" ~{rows} rows"));
            }
            line.push_str(&format!(
                ", {} cols",
                column_source(catalog, schema, t).columns.len()
            ));
            if let Some(n) = partitions.get(&(schema, t.name.as_str())) {
                line.push_str(&format!(", {n} partitions"));
            }
            json!(line)
        })
        .collect();
    let mut out = json!({ "database": target.database, "schema_loaded": age(cached.loaded), "tables": tables });
    if shared.len() > MAX_TABLES {
        let mut not_listed = Map::new();
        for (schema, _) in &shared[MAX_TABLES..] {
            let n = not_listed.entry(schema.to_string()).or_insert(json!(0));
            *n = json!(n.as_u64().unwrap_or(0) + 1);
        }
        out["not_listed"] = Json::Object(not_listed);
        out["note"] = json!(
            "More tables than are listed: pass schema to list one schema, or find tables by name with search_schema."
        );
    }
    Ok(out)
}

async fn search_schema(store: &mut Store, target: &Target, text: &str) -> Outcome {
    const MAX_HITS: usize = 40;
    let needle = text.trim().to_lowercase();
    let rule = rule(target);
    let marks = masked_marks(store, target).await?;
    let cached = store.catalog(target, false).await?;
    let catalog = &cached.catalog;
    let mut tables = Vec::new();
    let mut columns = Vec::new();
    let (mut more_tables, mut more_columns) = (0usize, 0usize);
    for (schema, t) in all_tables(catalog)
        .filter(|(s, t)| own_line(&rule, catalog, s, t))
        .filter(|(s, t)| rule.allows_node(catalog, s, t))
    {
        if t.name.to_lowercase().contains(&needle) {
            if tables.len() == MAX_HITS {
                more_tables += 1;
            } else {
                tables.push(json!(format!("{schema}.{}", t.name)));
            }
        }
        let above = access::above(catalog, schema, t);
        for c in &column_source(catalog, schema, t).columns {
            if c.name.to_lowercase().contains(&needle) && columns.len() == MAX_HITS {
                more_columns += 1;
            } else if c.name.to_lowercase().contains(&needle) {
                let masked = marks.iter().any(|m| {
                    m.column == c.name && above.contains(&(m.schema.as_str(), m.table.as_str()))
                });
                columns.push(json!(format!(
                    "{schema}.{}.{} {}{}",
                    t.name,
                    c.name,
                    c.type_name,
                    if masked { " (masked)" } else { "" }
                )));
            }
        }
    }
    let mut out = json!({ "tables": tables, "columns": columns });
    if more_tables + more_columns > 0 {
        out["note"] = json!(format!(
            "{more_tables} more tables and {more_columns} more columns match. Search for longer text."
        ));
    }
    Ok(out)
}

async fn describe_table(store: &mut Store, target: &Target, name: &str) -> Outcome {
    let (schema, table) = {
        let cached = store.catalog(target, false).await?;
        let (schema, t) = find_table(&cached.catalog, name)?;
        if !rule(target).allows_node(&cached.catalog, schema, t) {
            return Err(format!("No table called \"{}\".", name.trim()));
        }
        (schema.to_string(), t.name.clone())
    };
    let rule = rule(target);
    store.load_indexes(target, &schema, &table).await?;
    let marks = masked_marks(store, target).await?;
    let cached = store.catalog(target, false).await?;
    let catalog = &cached.catalog;
    let (_, t) = find_table(catalog, &format!("{schema}.{table}"))?;
    let own = column_source(catalog, &schema, t);

    let columns: Vec<Json> = own
        .columns
        .iter()
        .map(|c| {
            let mut line = format!("{} {}", c.name, c.type_name);
            if !c.nullable {
                line.push_str(" not null");
            }
            if let Some(default) = &c.default {
                line.push_str(&format!(" default {default}"));
            }
            json!(line)
        })
        .collect();
    let indexes: Vec<Json> = t
        .indexes
        .iter()
        .map(|i| {
            let mut line = i.name.clone();
            if i.primary {
                line.push_str(" primary key");
            } else if i.unique {
                line.push_str(" unique");
            }
            if let Some(method) = &i.method {
                line.push_str(&format!(" {method}"));
            }
            line.push_str(&format!(" ({})", i.columns.join(", ")));
            if let Some(scans) = i.scans {
                line.push_str(&format!(" scans {scans}"));
            }
            json!(line)
        })
        .collect();
    let references: Vec<Json> = t
        .foreign_keys
        .iter()
        .filter(|fk| {
            access::find_exact(catalog, &fk.ref_schema, &fk.ref_table).map_or_else(
                || rule.allows(&fk.ref_schema, &fk.ref_table),
                |t| rule.allows_node(catalog, &fk.ref_schema, t),
            )
        })
        .map(|fk| {
            json!(format!(
                "({}) → {}.{}({})",
                fk.columns.join(", "),
                fk.ref_schema,
                fk.ref_table,
                fk.ref_columns.join(", ")
            ))
        })
        .collect();
    let referenced_by: Vec<Json> = all_tables(catalog)
        .filter(|(s, other)| rule.allows_node(catalog, s, other))
        .flat_map(|(s, other)| {
            other
                .foreign_keys
                .iter()
                .filter(|fk| fk.ref_schema == schema && fk.ref_table == table)
                .map(move |fk| {
                    json!(format!(
                        "{s}.{}({}) → ({})",
                        other.name,
                        fk.columns.join(", "),
                        fk.ref_columns.join(", ")
                    ))
                })
        })
        .collect();
    let mut enums = Map::new();
    for c in &own.columns {
        let ty = c.type_name.trim_end_matches("[]");
        if let Some(e) = catalog
            .enums
            .iter()
            .find(|e| e.name == ty || format!("{}.{}", e.schema, e.name) == ty)
        {
            enums.insert(c.name.clone(), json!(e.labels));
        }
    }

    let mut out = json!({
        "table": format!("{schema}.{table}"),
        "kind": kind_label(t.kind),
        "columns": columns,
        "primary_key": t.primary_key,
    });
    if let Some(rows) = rows_estimate(&t.row_estimate) {
        out["rows"] = json!(rows);
    }
    for (key, list) in [
        ("indexes", indexes),
        ("references", references),
        ("referenced_by", referenced_by),
    ] {
        if !list.is_empty() {
            out[key] = json!(list);
        }
    }
    if !enums.is_empty() {
        out["enum_values"] = Json::Object(enums);
    }
    let above = access::above(catalog, &schema, t);
    let mut masked: Vec<String> = marks
        .into_iter()
        .filter(|m| above.contains(&(m.schema.as_str(), m.table.as_str())))
        .map(|m| m.column)
        .collect();
    masked.sort();
    masked.dedup();
    if !masked.is_empty() {
        out["masked"] = json!(masked);
    }
    Ok(out)
}

async fn list_sessions(
    store: &mut Store,
    target: &Target,
    include_idle: bool,
    entry: &mut audit::Entry,
) -> Outcome {
    let found = store.activity(target).await?;
    let rule = rule(target);
    let hidden = if rule.restricts() {
        sessions::hidden_names(&store.catalog(target, false).await?.catalog, &rule)
    } else {
        Default::default()
    };
    let out = sessions::shape(&found, &hidden, include_idle);
    entry.rows = out["sessions"].as_array().map(|r| r.len() as u64);
    Ok(out)
}

async fn database_health(store: &mut Store, target: &Target) -> Outcome {
    let report = store.health(target).await?;
    let rule = rule(target);
    if !rule.restricts() {
        return Ok(health::shape(
            report,
            &|_, _| Some(true),
            &Default::default(),
        ));
    }
    // A table made since the catalog was read would otherwise slip through:
    // read it again once, and leave out what it still doesn't know.
    let stale = {
        let catalog = &store.catalog(target, false).await?.catalog;
        health::tables(&report)
            .iter()
            .any(|(s, t)| catalog.table(s, t).is_none())
    };
    let catalog = &store.catalog(target, stale).await?.catalog;
    let hidden = sessions::hidden_names(catalog, &rule);
    let shares = |schema: &str, table: &str| {
        catalog
            .table(schema, table)
            .map(|t| rule.allows_node(catalog, schema, t))
    };
    Ok(health::shape(report, &shares, &hidden))
}

/// Refused when a Postgres plan uses a credentials catalog's secret column
/// (`guard::credentials_use`); `written` is the SQL as sent.
pub(crate) async fn refuse_credentials(
    store: &mut Store,
    target: &Target,
    plan: &Json,
    touched: &[(Option<String>, String)],
    written: &functions::Scan,
) -> Result<(), String> {
    if !touched
        .iter()
        .any(|(schema, table)| guard::is_credentials(schema.as_deref(), table))
    {
        return Ok(());
    }
    let found = store.read(target, guard::CREDENTIAL_COLUMNS_SQL).await?;
    let columns: Vec<(String, String)> = found
        .rows
        .iter()
        .filter_map(|r| match (r.first(), r.get(1)) {
            (Some(rowkery_core::Value::Text(t)), Some(rowkery_core::Value::Text(c))) => {
                Some((t.clone(), c.clone()))
            }
            _ => None,
        })
        .collect();
    match guard::credentials_use(plan, &columns, &written.call_names()) {
        Some(why) => Err(why.into()),
        None => Ok(()),
    }
}

/// A read's rows shaped for the agent as they arrive (masked places as
/// stand-ins, long text cut), so no more than the cap and 64 KB is held.
#[derive(Default)]
struct Shaper {
    cap: usize,
    masked_at: Vec<usize>,
    key: Option<String>,
    rows: Vec<Json>,
    size: usize,
    /// Rows read, the one past the cap included.
    seen: usize,
    cut: bool,
    payload_cut: bool,
}

impl Shaper {
    /// Takes one row; false once no more are wanted.
    fn take(&mut self, row: Vec<rowkery_core::Value>) -> bool {
        self.seen += 1;
        if self.seen > self.cap {
            return false;
        }
        let cells: Vec<Json> = row
            .iter()
            .enumerate()
            .map(|(i, v)| match &self.key {
                Some(key) if self.masked_at.contains(&i) => mask::stand_in(key.as_bytes(), v),
                _ => guard::cell(v, &mut self.cut),
            })
            .collect();
        let shaped = Json::Array(cells);
        self.size += shaped.to_string().len() + 1;
        if self.size > PAYLOAD_BYTES {
            self.payload_cut = true;
            return false;
        }
        self.rows.push(shaped);
        true
    }
}

/// `explain` and `query`: the same checks, then either the plan or the rows.
async fn run_read(
    store: &mut Store,
    target: &Target,
    sql: &str,
    max_rows: Option<u64>,
    plan_only: bool,
    entry: &mut audit::Entry,
) -> Outcome {
    let engine = engine(&target.record);
    let sql = guard::single_read(sql, engine.into())?;
    let cap = guard::row_cap(max_rows);
    let alias = guard::wrapper_alias();
    let capped = guard::wrap_limit(&sql, cap + 1, &alias);
    let rule = rule(target);
    let marks = masked_marks(store, target).await?;

    // The plan, and the big tables it would read end to end.
    let mut sqlite_eqp: Vec<(i64, i64, String)> = Vec::new();
    let (plan_lines, scanned, touched, pg_plan_json) = match engine {
        EngineKind::Postgres => {
            // The SQL as sent, before the planner evaluates any of it.
            let written = functions::scan_sql(&sql);
            if sessions::reads_activity(&written.call_names()) {
                return Err(sessions::ACTIVITY_REFUSAL.into());
            }
            functions::check_pg(store, target, &written, true).await?;
            let explain_sql = format!("EXPLAIN (FORMAT JSON, VERBOSE) {capped}");
            let explain = store.read(target, &explain_sql).await?;
            let (plan, _) = guard::pg_plan_json(explain.rows)?;
            let planned = functions::scan_plan(&plan);
            if sessions::reads_activity(&planned.call_names()) {
                return Err(sessions::ACTIVITY_REFUSAL.into());
            }
            functions::check_pg(store, target, &planned, false).await?;
            let (lines, scans) = guard::pg_plan(&plan);
            let scans: Vec<(Option<String>, String)> =
                scans.into_iter().map(|s| (s.schema, s.table)).collect();
            let touched = if rule.restricts() || !marks.is_empty() {
                lineage::pg_read_relations(store, target, &explain_sql, &plan).await?
            } else {
                guard::pg_relations(&plan)
            };
            refuse_credentials(store, target, &plan, &touched, &written).await?;
            (lines, scans, touched, Some(plan))
        }
        EngineKind::Mysql => return Err(MYSQL_NOT_SHARED.into()),
        EngineKind::Sqlite => {
            let explain = store
                .read(target, &format!("EXPLAIN QUERY PLAN {capped}"))
                .await?;
            let details: Vec<String> = explain
                .rows
                .iter()
                .filter_map(|r| match r.last() {
                    Some(rowkery_core::Value::Text(t)) => Some(t.clone()),
                    _ => None,
                })
                .collect();
            sqlite_eqp = explain
                .rows
                .iter()
                .filter_map(|r| match (r.first(), r.get(1), r.last()) {
                    (
                        Some(rowkery_core::Value::Int(id)),
                        Some(rowkery_core::Value::Int(parent)),
                        Some(rowkery_core::Value::Text(d)),
                    ) => Some((*id, *parent, d.clone())),
                    _ => None,
                })
                .collect();
            let scans = guard::sqlite_full_scans(&details)
                .into_iter()
                .map(|t| (None, t))
                .collect();
            let touched = match &target.record {
                ConnectionRecord::Sqlite(c) if rule.restricts() || !marks.is_empty() => {
                    target::sqlite_tables_read(&c.path, &capped)?
                        .into_iter()
                        .map(|(s, t)| (Some(s), t))
                        .collect()
                }
                _ => Vec::new(),
            };
            (details, scans, touched, None)
        }
    };
    // Statistics give nothing away when every table is shared and nothing
    // is masked.
    if (rule.restricts() || !marks.is_empty())
        && touched
            .iter()
            .any(|(schema, table)| guard::is_statistics(schema.as_deref(), table))
    {
        return Err(guard::STATISTICS_REFUSAL.into());
    }
    if rule.restricts() {
        // Every relation the plan reads (views and CTEs resolved to the
        // tables underneath) must be shared, matched by its exact name, with
        // what it's a partition or child table of.
        let above = lineage::above(store, target, &touched).await?;
        if lineage::keeps_back(&rule, &above, &touched, default_schema(&target.record)) {
            return Err(guard::HIDDEN_REFUSAL.into());
        }
    }
    // Sensitive columns: refused unless only returned or counted, and the
    // places in the result that hold one.
    let masked_at = if marks.is_empty() {
        Vec::new()
    } else {
        match (&pg_plan_json, &target.record) {
            (Some(plan), _) => {
                let written = functions::scan_sql(&sql).call_names();
                pg_masked(store, target, &marks, plan, &touched, &alias, &written).await?
            }
            (None, ConnectionRecord::Sqlite(c)) => {
                let pairs: Vec<(String, String)> = marks
                    .iter()
                    .filter(|m| m.schema.eq_ignore_ascii_case("main"))
                    .map(|m| (m.table.clone(), m.column.clone()))
                    .collect();
                target::sqlite_mask_check(&c.path, &sql, &pairs)?
            }
            _ => Vec::new(),
        }
    };
    let mask_key = if masked_at.is_empty() || plan_only {
        None
    } else {
        // Off the async threads: it can wait on the app's keychain prompt.
        let id = target.id().to_string();
        let key = tokio::task::spawn_blocking(move || rowkery_core::secrets::mask_key(&id))
            .await
            .map_err(|e| e.to_string())
            .and_then(|key| key.map_err(|e| e.to_string()));
        Some(key.map_err(|e| {
            format!("Refused: Rowkery couldn't read the key it masks values with from the keychain ({e}).")
        })?)
    };

    let mut big = Vec::new();
    {
        let cached = store.catalog(target, false).await?;
        for (schema, table) in &scanned {
            let name = match schema {
                Some(s) => format!("{s}.{table}"),
                None => table.clone(),
            };
            if let Ok((s, t)) = find_table(&cached.catalog, &name) {
                if rows_estimate(&t.row_estimate).is_some_and(|n| n > BIG_TABLE_ROWS) {
                    big.push((
                        s.to_string(),
                        t.name.clone(),
                        rows_estimate(&t.row_estimate).unwrap_or(0),
                    ));
                }
            }
        }
    }
    let mut refusal = None;
    if !big.is_empty() {
        let mut parts = Vec::new();
        for (schema, table, rows) in &big {
            store.load_indexes(target, schema, table).await?;
            let cached = store.catalog(target, false).await?;
            let indexed = find_table(&cached.catalog, &format!("{schema}.{table}"))
                .map(|(_, t)| {
                    let mut cols: Vec<String> = t
                        .indexes
                        .iter()
                        .map(|i| format!("({})", i.columns.join(", ")))
                        .collect();
                    cols.dedup();
                    cols.join(", ")
                })
                .unwrap_or_default();
            let indexed = if indexed.is_empty() {
                "none".to_string()
            } else {
                indexed
            };
            parts.push(format!(
                "{schema}.{table} (~{rows} rows; indexed: {indexed})"
            ));
        }
        refusal = Some(format!(
            "Refused: the plan reads {} end to end. Filter on an indexed column, or aggregate a narrower range.",
            parts.join(" and ")
        ));
    }

    if plan_only {
        let (shown, more) = guard::plan_shown(plan_lines);
        let mut out = json!({ "plan": shown });
        if more > 0 {
            out["plan_note"] = json!(format!(
                "{more} more plan lines not shown: the answer stops at {} KB.",
                PAYLOAD_BYTES / 1024
            ));
        }
        // The same reading of the plan the app shows on ⌘E: its slowest step
        // and one hint.
        let readable = match &pg_plan_json {
            Some(json) => rowkery_core::plan::parse_pg(json).ok(),
            None => Some(rowkery_core::plan::parse_sqlite(&sqlite_eqp)),
        };
        if let Some(mut readable) = readable {
            let tables = rowkery_core::plan::tables(&readable);
            if engine == EngineKind::Postgres {
                for (schema, table) in &tables {
                    let schema = schema.as_deref().unwrap_or("public");
                    // A hint is extra: a table whose indexes won't load just gets none.
                    let _ = store.load_indexes(target, schema, table).await;
                }
            }
            let facts = match (&target.record, store.catalog(target, false).await) {
                // SQLite catalogs leave big tables uncounted: count for the hint.
                (ConnectionRecord::Sqlite(c), _) => {
                    rowkery_core::db::sqlite::sqlite_plan_facts(&c.path, &tables)
                }
                (_, Ok(cached)) => {
                    rowkery_core::plan::PlanFacts::from_catalog(&cached.catalog, &tables)
                }
                (_, Err(_)) => rowkery_core::plan::PlanFacts::default(),
            };
            rowkery_core::plan::add_hint(&mut readable, engine, &facts);
            if let Some(step) = readable.slowest.map(|i| &readable.steps[i]) {
                let mut name = step.kind.clone();
                if let Some(t) = &step.table {
                    name.push_str(&format!(" on {t}"));
                }
                out["slowest_step"] = json!(name);
            }
            if let Some(hint) = readable.hint {
                out["hint"] = json!(hint.text);
                if let Some(sql) = hint.sql {
                    out["hint_sql"] = json!(sql);
                }
            }
        }
        if let Some(r) = &refusal {
            out["query_would_refuse"] = json!(r);
        }
        entry.verdict = Some(if refusal.is_some() {
            "would refuse".into()
        } else {
            "ok".into()
        });
        return Ok(out);
    }
    // SQLite is a local file nobody else is waiting on, and the timeout
    // bounds it, so a full scan there runs with a note instead.
    let mut notes = Vec::new();
    if let Some(r) = refusal {
        match engine {
            EngineKind::Postgres => return Err(r),
            EngineKind::Mysql => return Err(r),
            EngineKind::Sqlite => notes.push(r.replacen("Refused: the plan", "Note: this", 1)),
        }
    }

    let shaper = Shaper {
        cap,
        masked_at: masked_at.clone(),
        key: mask_key,
        ..Shaper::default()
    };
    let result = store
        .read_each(target, &capped, cap + 1, shaper, Shaper::take)
        .await?;
    let Shaper {
        rows,
        seen,
        cut,
        payload_cut,
        ..
    } = result.state;
    let more = seen > cap;
    if cut {
        notes.push(format!("text over {} chars was cut", guard::CELL_CHARS));
    }
    if payload_cut {
        notes.push(format!(
            "stopped at {} rows to stay under 64 KB",
            rows.len()
        ));
    }
    entry.rows = Some(rows.len() as u64);
    entry.ms = Some(result.elapsed_ms);
    let names: Vec<String> = result.columns.iter().map(|c| c.name.clone()).collect();
    let mut out = json!({
        "columns": names,
        "rows": rows,
        "row_count": rows.len(),
        "more": more || payload_cut,
        "elapsed_ms": result.elapsed_ms,
    });
    let types: Vec<&str> = result
        .columns
        .iter()
        .map(|c| c.type_name.as_str())
        .collect();
    if types.iter().any(|t| !t.is_empty()) {
        out["types"] = json!(types);
    }
    if !masked_at.is_empty() {
        let masked: Vec<&str> = masked_at
            .iter()
            .filter_map(|i| names.get(*i).map(String::as_str))
            .collect();
        out["masked"] = json!(masked);
    }
    if !notes.is_empty() {
        out["notes"] = json!(notes);
    }
    Ok(out)
}

/// The columns the user marked sensitive, and every generated column that
/// would hand one back under another name (`email_lower … AS
/// (lower(email))`, rowkery/reports#30). Postgres: a generated column whose
/// expression names a marked column of its table (by word, so a near miss
/// over-masks, never under-masks). SQLite keeps the expression only in the
/// CREATE TABLE text, so every generated column of a table with a marked
/// column is masked.
pub(crate) async fn masked_marks(
    store: &mut Store,
    target: &Target,
) -> Result<Vec<mask::Marked>, String> {
    let mut marks = mask::parse(target.record.masked_columns(&target.database));
    if marks.is_empty() {
        return Ok(marks);
    }
    let text = |v: Option<&rowkery_core::Value>| match v {
        Some(rowkery_core::Value::Text(t)) => t.clone(),
        _ => String::new(),
    };
    let engine = engine(&target.record);
    let lit = |v: &str| {
        rowkery_core::query_util::sql_literal(engine, &rowkery_core::Value::Text(v.to_string()))
    };
    let mut tables: Vec<(String, String)> = Vec::new();
    for m in &marks {
        if !tables.contains(&(m.schema.clone(), m.table.clone())) {
            tables.push((m.schema.clone(), m.table.clone()));
        }
    }
    let mut more = Vec::new();
    match engine {
        EngineKind::Postgres => {
            let names: Vec<String> = tables
                .iter()
                .filter_map(|(s, t)| Some(format!("({}, {})", lit(s)?, lit(t)?)))
                .collect();
            // The marked tables and every partition or child table under
            // them, in any schema: one may define a generated column of its
            // own (or its own expression for one), read by the parent's
            // marks. Each row names the marked table it's under.
            let sql = format!(
                "WITH RECURSIVE under(rel, top) AS ( \
                   SELECT c.oid, c.oid FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace \
                     WHERE (n.nspname, c.relname) IN (VALUES {}) \
                   UNION SELECT i.inhrelid, u.top FROM under u JOIN pg_inherits i ON i.inhparent = u.rel) \
                 SELECT n.nspname, c.relname, a.attname, pg_get_expr(d.adbin, d.adrelid), tn.nspname, t.relname \
                 FROM under u JOIN pg_attribute a ON a.attrelid = u.rel \
                   JOIN pg_class c ON c.oid = u.rel JOIN pg_namespace n ON n.oid = c.relnamespace \
                   JOIN pg_class t ON t.oid = u.top JOIN pg_namespace tn ON tn.oid = t.relnamespace \
                   JOIN pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum \
                 WHERE a.attgenerated <> '' AND NOT a.attisdropped",
                names.join(", ")
            );
            for row in store.read(target, &sql).await?.rows {
                let (schema, table) = (text(row.first()), text(row.get(1)));
                let (top_schema, top) = (text(row.get(4)), text(row.get(5)));
                let words = functions::scan_sql(&text(row.get(3))).words;
                let from_marked = marks.iter().any(|m| {
                    m.schema == top_schema
                        && m.table == top
                        && words.iter().any(|w| w.eq_ignore_ascii_case(&m.column))
                });
                if from_marked {
                    more.push(mask::Marked {
                        schema,
                        table,
                        column: text(row.get(2)),
                    });
                }
            }
        }
        EngineKind::Mysql => return Err(MYSQL_NOT_SHARED.into()),
        EngineKind::Sqlite => {
            for (schema, table) in tables
                .iter()
                .filter(|(s, _)| s.eq_ignore_ascii_case("main"))
            {
                let Some(name) = lit(table) else { continue };
                let sql =
                    format!("SELECT name FROM pragma_table_xinfo({name}) WHERE hidden IN (2, 3)");
                for row in store.read(target, &sql).await?.rows {
                    more.push(mask::Marked {
                        schema: schema.clone(),
                        table: table.clone(),
                        column: text(row.first()),
                    });
                }
            }
        }
    }
    // One added since the catalog was cached: read it again, or the
    // checks that go by its columns would refuse the table.
    if engine == EngineKind::Postgres && !more.is_empty() {
        let catalog = &store.catalog(target, false).await?.catalog;
        let stale = more.iter().any(|m| {
            access::find_exact(catalog, &m.schema, &m.table).is_some_and(|t| {
                !t.columns.is_empty() && !t.columns.iter().any(|c| c.name == m.column)
            })
        });
        if stale {
            store.catalog(target, true).await?;
        }
    }
    for m in more {
        if !marks.contains(&m) {
            marks.push(m);
        }
    }
    Ok(marks)
}

/// The Postgres side of the masked-column check: a table whose marked column
/// has gone is refused (functions defined in the database never get this far,
/// `functions::check_pg`), then `mask::pg_check` reads the plan.
async fn pg_masked(
    store: &mut Store,
    target: &Target,
    marks: &[mask::Marked],
    plan: &Json,
    touched: &[(Option<String>, String)],
    alias: &str,
    written_calls: &[String],
) -> Result<Vec<usize>, String> {
    let text = |v: Option<&rowkery_core::Value>| match v {
        Some(rowkery_core::Value::Text(t)) => t.clone(),
        _ => String::new(),
    };
    // The tables each relation the plan reads is a partition or child table
    // of, from the server: the catalog links only partitions in their
    // parent's schema, and no child tables.
    let names: Vec<String> = touched
        .iter()
        .filter_map(|(s, t)| {
            let lit = |v: &str| {
                rowkery_core::query_util::sql_literal(
                    EngineKind::Postgres,
                    &rowkery_core::Value::Text(v.to_string()),
                )
            };
            Some(format!(
                "({}, {})",
                lit(s.as_deref().unwrap_or("public"))?,
                lit(t)?
            ))
        })
        .collect();
    let mut ancestors: std::collections::HashMap<(String, String), Vec<(String, String)>> =
        std::collections::HashMap::new();
    if !names.is_empty() {
        // UNION, not UNION ALL: a table under several parents is reached
        // once per parent, not once per path, and pg_inherits has no
        // cycles, so the walk ends at the top of every chain however deep.
        let sql = format!(
            "WITH RECURSIVE up(child, parent) AS ( \
               SELECT i.inhrelid, i.inhparent FROM pg_inherits i \
                 JOIN pg_class c ON c.oid = i.inhrelid JOIN pg_namespace n ON n.oid = c.relnamespace \
                 WHERE (n.nspname, c.relname) IN (VALUES {}) \
               UNION SELECT up.child, i.inhparent FROM up \
                 JOIN pg_inherits i ON i.inhrelid = up.parent) \
             SELECT cn.nspname, c.relname, pn.nspname, p.relname FROM up \
               JOIN pg_class c ON c.oid = up.child JOIN pg_namespace cn ON cn.oid = c.relnamespace \
               JOIN pg_class p ON p.oid = up.parent JOIN pg_namespace pn ON pn.oid = p.relnamespace",
            names.join(", ")
        );
        for row in store.read(target, &sql).await?.rows {
            ancestors
                .entry((text(row.first()), text(row.get(1))))
                .or_default()
                .push((text(row.get(2)), text(row.get(3))));
        }
    }
    let lineage = |schema: &str, rel: &str| {
        let mut all = vec![(schema.to_string(), rel.to_string())];
        if let Some(up) = ancestors.get(&(schema.to_string(), rel.to_string())) {
            all.extend(up.iter().cloned());
        }
        all
    };

    const INDEXES: &str = "SELECT ci.relname, n.nspname, t.relname, pg_get_indexdef(i.indexrelid) \
        FROM pg_index i JOIN pg_class ci ON ci.oid = i.indexrelid JOIN pg_class t ON t.oid = i.indrelid \
        JOIN pg_namespace n ON n.oid = t.relnamespace \
        WHERE n.nspname NOT IN ('pg_catalog', 'information_schema')";
    // An index covering a marked column, on the marked table or any of its
    // partitions and child tables, wherever they live.
    let mut indexes = std::collections::HashSet::new();
    for row in store.read(target, INDEXES).await?.rows {
        let definition = text(row.get(3));
        let marked = lineage(&text(row.get(1)), &text(row.get(2)))
            .iter()
            .any(|(s, t)| {
                marks.iter().any(|m| {
                    m.schema == *s && m.table == *t && mask::index_covers(&definition, &m.column)
                })
            });
        if marked {
            indexes.insert(text(row.first()));
        }
    }

    let cached = store.catalog(target, false).await?;
    let catalog = &cached.catalog;
    // Only the user's own marks: a generated column `masked_marks` added
    // may be newer than the cached catalog, and the user never marked it.
    for m in &mask::parse(target.record.masked_columns(&target.database)) {
        let reads_it = touched.iter().any(|(s, t)| {
            lineage(s.as_deref().unwrap_or("public"), t)
                .iter()
                .any(|(s, t)| *s == m.schema && *t == m.table)
        });
        if !reads_it {
            continue;
        }
        if let Some(t) = access::find_exact(catalog, &m.schema, &m.table) {
            if !t.columns.iter().any(|c| c.name == m.column) {
                return Err(mask::missing_refusal(
                    &format!("{}.{}", m.schema, m.table),
                    &m.column,
                ));
            }
        }
    }
    // A partition or child table answers for the tables above it.
    let marked_of = |schema: Option<&str>, rel: &str| {
        let mut columns: Vec<(String, String)> = Vec::new();
        for (s, t) in lineage(schema.unwrap_or("public"), rel) {
            for m in marks.iter().filter(|m| m.schema == s && m.table == t) {
                if !columns.iter().any(|(c, _)| *c == m.column) {
                    columns.push((m.column.clone(), m.table.clone()));
                }
            }
        }
        columns
    };
    // A table with masked columns, by every name its columns have.
    let columns_of = |schema: Option<&str>, rel: &str| {
        let marked = marked_of(schema, rel);
        if marked.is_empty() {
            return None;
        }
        // The catalog may list a partition without its columns.
        let columns = lineage(schema.unwrap_or("public"), rel)
            .iter()
            .filter_map(|(s, t)| access::find_exact(catalog, s, t))
            .find(|t| !t.columns.is_empty())
            .map(|t| t.columns.iter().map(|c| c.name.clone()).collect())
            .unwrap_or_default();
        Some(columns)
    };
    mask::pg_renamed(plan, &columns_of, written_calls)?;
    mask::pg_check(
        plan,
        &mask::PgFacts {
            marked_of: &marked_of,
            is_part: &|schema, rel| {
                ancestors.contains_key(&(schema.unwrap_or("public").to_string(), rel.to_string()))
            },
            marked_indexes: &indexes,
            wrapper: alias,
        },
    )
}

impl ServerHandler for RowkeryMcp {
    fn get_info(&self) -> ServerConfig {
        ServerConfig::new(
            ServerCapabilities::builder()
                .enable_tools()
                .enable_resources()
                .build(),
        )
        .with_server_info(
            Implementation::new("rowkery", env!("CARGO_PKG_VERSION")).with_title("Rowkery"),
        )
        .with_instructions(INSTRUCTIONS)
    }

    async fn list_tools(
        &self,
        _request: Option<PaginatedRequestParams>,
        context: RequestContext<RoleServer>,
    ) -> Result<ListToolsResult, McpError> {
        let mut list = tools();
        if draws_views(&context) {
            views::add_to(&mut list);
        }
        // Clients on MCP 2026-07-28 require ttlMs and cacheScope on list results
        // (Claude Code rejects the response without them). The tool list depends
        // on nothing per-user, but 0 / private keeps clients re-reading it.
        Ok(ListToolsResult::with_all_items(list)
            .with_ttl_ms(0)
            .with_cache_scope(CacheScope::Private))
    }

    async fn list_resources(
        &self,
        _request: Option<PaginatedRequestParams>,
        context: RequestContext<RoleServer>,
    ) -> Result<ListResourcesResult, McpError> {
        // Only a host that draws views has a use for the page.
        let list = if draws_views(&context) {
            views::list()
        } else {
            ListResourcesResult::default()
        };
        Ok(list.with_ttl_ms(0).with_cache_scope(CacheScope::Private))
    }

    async fn read_resource(
        &self,
        request: ReadResourceRequestParams,
        _context: RequestContext<RoleServer>,
    ) -> Result<ReadResourceResponse, McpError> {
        views::read(&request.uri)
            .map(|r| {
                r.with_ttl_ms(0)
                    .with_cache_scope(CacheScope::Private)
                    .into()
            })
            .ok_or_else(|| {
                McpError::resource_not_found(format!("No resource {}", request.uri), None)
            })
    }

    async fn call_tool(
        &self,
        request: CallToolRequestParams,
        context: RequestContext<RoleServer>,
    ) -> Result<CallToolResponse, McpError> {
        let args = request.arguments.unwrap_or_default();
        let views = draws_views(&context);
        // The view's own calls: a click, not the agent, so they aren't logged.
        if views {
            let page = match request.name.as_ref() {
                "open_in_rowkery" => Some(
                    views::link(&args)
                        .and_then(|url| views::open(&url))
                        .map(|()| json!({ "opened": true })),
                ),
                "proposal_status" => Some(required(&args, "id").and_then(proposals::status)),
                _ => None,
            };
            if let Some(outcome) = page {
                return Ok(text_result(&outcome).into());
            }
        }
        let client = context.peer.peer_info().map(|p| p.client_info.name.clone());
        if let Ok(mut slot) = self.client.lock() {
            slot.clone_from(&client);
        }
        let started = std::time::Instant::now();
        let (outcome, mut entry, keep_sample) = self.dispatch(&request.name, &args).await;
        entry.took_ms = Some(started.elapsed().as_millis() as u64);
        entry.client = client;
        if views && views::CAN_OPEN && request.name == "query" && outcome.is_ok() {
            entry.add_link_key();
        }
        let page_meta = views
            .then(|| views::page_meta(&request.name, &args, outcome.as_ref(), &entry))
            .flatten();
        let text = match &outcome {
            Ok(value) => value.to_string(),
            Err(message) => message.clone(),
        };
        entry.bytes = Some(text.len() as u64);
        let sample = (keep_sample && outcome.is_ok())
            .then(|| samples::shape(entry.session.unwrap_or(0), entry.ts, &text));
        if entry.verdict.is_none() {
            entry.verdict = Some(match &outcome {
                Ok(_) => "ok".into(),
                Err(e) => e.clone(),
            });
        }
        // File writes, which can wait up to a second for another process's
        // lock: off the async workers.
        let _ = tokio::task::spawn_blocking(move || {
            if let Some(sample) = sample {
                samples::save(&sample, entry.ts);
            }
            audit::append(&entry);
        })
        .await;
        let mut result = text_result(&outcome);
        if views && request.name == "query" && outcome.is_ok() {
            result.content.push(ContentBlock::text(views::SHOWN_NOTE));
        }
        result.meta = page_meta;
        Ok(result.into())
    }
}

/// The client draws MCP Apps views (`views`): it said so at `initialize`, or
/// in this request's `_meta` on protocols without a handshake.
fn draws_views(context: &RequestContext<RoleServer>) -> bool {
    context
        .client_capabilities()
        .is_some_and(|caps| views::supported(&caps))
}

#[cfg(test)]
mod docs_table;

/// Tests that point `ROWKERY_CONFIG_DIR` somewhere hold this, one at a time.
#[cfg(test)]
pub(crate) static ENV_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());

#[cfg(test)]
mod tests {
    use super::*;
    use rowkery_core::connections::{McpDbAccess, McpTableMode, SqliteConnection};

    async fn call(mcp: &RowkeryMcp, tool: &str, args: Json) -> Outcome {
        let args = args.as_object().cloned().unwrap_or_default();
        mcp.dispatch(tool, &args).await.0
    }

    // The env lock spans the whole test, awaits included: each test has its own runtime.
    #[allow(clippy::await_holding_lock)]
    #[tokio::test]
    async fn a_sqlite_whitelist_shares_only_the_ticked_tables() {
        let _env = ENV_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        let dir = std::env::temp_dir().join(format!("rowkery-mcp-picked-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        std::env::set_var("ROWKERY_CONFIG_DIR", dir.to_string_lossy().to_string());
        let db = dir.join("t.db");
        rusqlite::Connection::open(&db)
            .unwrap()
            .execute_batch(
                "create table orders(id integer primary key, n int);
                 create table secret(id integer primary key, v text);
                 create view peek as select v from secret;
                 insert into orders values (1, 2);
                 insert into orders (n) with recursive c(x) as
                   (select 1 union all select x + 1 from c where x < 20000) select x from c;",
            )
            .unwrap();
        let mut config = AppConfig::default();
        config.upsert_connection(ConnectionRecord::Sqlite(SqliteConnection {
            id: "s".into(),
            name: "s".into(),
            path: db.to_string_lossy().to_string(),
            environment: None,
            safe_mode: Default::default(),
            sample: false,
            allow_mcp: true,
            mcp_hidden_tables: Vec::new(),
            mcp_until: None,
            mcp_samples_off: false,
            mcp_timeout_s: None,
            mcp_access: Some(
                [(
                    "main".to_string(),
                    McpDbAccess {
                        mode: McpTableMode::Picked,
                        tables: vec!["main.orders".into(), "main.peek".into()],
                    },
                )]
                .into_iter()
                .collect(),
            ),
            masked_columns: Default::default(),
        }));
        config.save().unwrap();
        let mcp = RowkeryMcp::default();
        let q = |sql: &'static str| json!({ "connection": "s", "sql": sql });

        let ok = call(&mcp, "query", q("select n from orders where id = 1"))
            .await
            .unwrap();
        assert_eq!(ok["rows"], json!([[2]]));
        // The query asks for 2.4 GB of cells. Rows are shaped as they
        // arrive, so it answers within 64 KB and stops reading there.
        let big = call(
            &mcp,
            "query",
            q(
                "with recursive c(x) as (select 1 union all select x + 1 from c where x < 400)
               select x, printf('%.*c', 3000000, 'x'), printf('%.*c', 3000000, 'y') from c",
            ),
        )
        .await
        .unwrap();
        assert_eq!(big["more"], true);
        assert!(
            big["row_count"].as_u64().unwrap() < 200,
            "{}",
            big["row_count"]
        );
        assert!(
            big["notes"].to_string().contains("64 KB"),
            "{}",
            big["notes"]
        );
        // explain reads the plan the way the app's ⌘E does.
        let plan = call(&mcp, "explain", q("select id from orders where n = 7"))
            .await
            .unwrap();
        assert_eq!(
            plan["hint"],
            "SQLite reads every row of orders (20,001). If you filter or join on one of its columns, an index on it lets SQLite go straight to the rows."
        );
        for sql in [
            "select * from secret",
            "select * from peek",
            "select * from orders join secret using (id)",
            "select name from sqlite_master",
        ] {
            let err = call(&mcp, "query", q(sql)).await.expect_err(sql);
            assert!(err.starts_with("Refused"), "{sql}: {err}");
        }
        let tables = call(&mcp, "list_tables", json!({ "connection": "s" }))
            .await
            .unwrap()
            .to_string();
        assert!(
            tables.contains("main.orders") && !tables.contains("main.secret"),
            "{tables}"
        );

        // The log keeps the arguments as sent and what was shared then.
        let (_, entry, keep) = mcp
            .dispatch("query", q("select n from orders").as_object().unwrap())
            .await;
        assert!(keep);
        assert_eq!(entry.args.unwrap()["sql"], "select n from orders");
        let scope = entry.scope.unwrap();
        assert_eq!(scope["mode"], "picked");
        assert_eq!(scope["tables"], 2);
        assert_eq!(scope["databases"], 1);
        assert_eq!(scope["max_rows"], guard::DEFAULT_ROWS);

        std::env::remove_var("ROWKERY_CONFIG_DIR");
        let _ = std::fs::remove_dir_all(dir);
    }

    // The env lock spans the whole test, awaits included: each test has its own runtime.
    #[allow(clippy::await_holding_lock)]
    #[tokio::test]
    async fn sqlite_statistics_are_kept_back_while_a_column_is_masked() {
        let _env = ENV_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        let dir = std::env::temp_dir().join(format!("rowkery-mcp-stat4-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        std::env::set_var("ROWKERY_CONFIG_DIR", dir.to_string_lossy().to_string());
        let db = dir.join("t.db");
        rusqlite::Connection::open(&db)
            .unwrap()
            .execute_batch(
                "create table customers(id integer primary key, email text);
                 create index customers_email on customers(email);
                 insert into customers(email) values ('mara@fjord.se'), ('tomas@ibarra.dev');
                 create table people(id integer primary key, email text,
                   dom text generated always as (substr(email, instr(email, '@') + 1)) virtual,
                   up text generated always as (upper(email)) stored);
                 insert into people(email) values ('mara@fjord.se');
                 analyze;",
            )
            .unwrap();
        let save = |masked: Vec<String>| {
            let mut config = AppConfig::default();
            config.upsert_connection(ConnectionRecord::Sqlite(SqliteConnection {
                id: "s".into(),
                name: "s".into(),
                path: db.to_string_lossy().to_string(),
                environment: None,
                safe_mode: Default::default(),
                sample: false,
                allow_mcp: true,
                mcp_hidden_tables: Vec::new(),
                mcp_until: None,
                mcp_samples_off: false,
                mcp_timeout_s: None,
                mcp_access: Some(
                    [(
                        "main".to_string(),
                        McpDbAccess {
                            mode: McpTableMode::All,
                            tables: Vec::new(),
                        },
                    )]
                    .into_iter()
                    .collect(),
                ),
                masked_columns: [("main".to_string(), masked)].into_iter().collect(),
            }));
            config.save().unwrap();
        };
        save(vec!["main.customers.email".into()]);
        let mcp = RowkeryMcp::default();
        let q = |sql: &'static str| json!({ "connection": "s", "sql": sql });

        // sqlite_stat4 keeps index samples, the emails among them.
        for sql in [
            "select cast(sample as text) from sqlite_stat4",
            "select * from main.SQLITE_STAT4",
            "select stat from sqlite_stat1",
        ] {
            let err = call(&mcp, "query", q(sql)).await.expect_err(sql);
            assert_eq!(err, guard::STATISTICS_REFUSAL, "{sql}");
        }
        call(&mcp, "query", q("select count(*) from customers"))
            .await
            .expect("plain read");

        // A generated column carries the marked one (rowkery/reports#30).
        save(vec!["main.people.email".into()]);
        let out = call(&mcp, "query", q("select dom, up from people"))
            .await
            .expect("returned");
        let text = out["rows"].to_string();
        assert!(!text.contains("fjord") && !text.contains("FJORD"), "{text}");
        for sql in [
            "select id from people where up like 'M%'",
            "select lower(dom) from people",
        ] {
            let err = call(&mcp, "query", q(sql)).await.expect_err(sql);
            assert!(err.starts_with("Refused"), "{sql}: {err}");
        }

        // Nothing masked: nothing to keep back.
        save(Vec::new());
        call(&mcp, "query", q("select count(*) from sqlite_stat4"))
            .await
            .expect("statistics with nothing kept back");

        std::env::remove_var("ROWKERY_CONFIG_DIR");
        let _ = std::fs::remove_dir_all(dir);
    }

    // The env lock spans the whole test, awaits included: each test has its own runtime.
    #[allow(clippy::await_holding_lock)]
    #[tokio::test]
    async fn list_tables_stops_at_its_cap_and_says_how_many_more() {
        let _env = ENV_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        let dir = std::env::temp_dir().join(format!("rowkery-mcp-many-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        std::env::set_var("ROWKERY_CONFIG_DIR", dir.to_string_lossy().to_string());
        let db = dir.join("t.db");
        let sql: String = (0..MAX_TABLES + 3)
            .map(|i| format!("create table t{i:04}(id integer primary key);"))
            .collect();
        rusqlite::Connection::open(&db)
            .unwrap()
            .execute_batch(&sql)
            .unwrap();
        let mut config = AppConfig::default();
        config.upsert_connection(ConnectionRecord::Sqlite(SqliteConnection {
            id: "s".into(),
            name: "s".into(),
            path: db.to_string_lossy().to_string(),
            environment: None,
            safe_mode: Default::default(),
            sample: false,
            allow_mcp: true,
            mcp_hidden_tables: Vec::new(),
            mcp_until: None,
            mcp_samples_off: false,
            mcp_timeout_s: None,
            mcp_access: None,
            masked_columns: Default::default(),
        }));
        config.save().unwrap();
        let mcp = RowkeryMcp::default();
        let listed = call(&mcp, "list_tables", json!({ "connection": "s" }))
            .await
            .unwrap();
        let names = listed["tables"].as_array().unwrap();
        assert_eq!(names.len(), MAX_TABLES);
        assert_eq!(names[0], "main.t0000, 1 cols");
        assert!(!listed.to_string().contains("t0500"));
        assert_eq!(listed["not_listed"], json!({ "main": 3 }));
        assert!(listed["note"].as_str().unwrap().contains("search_schema"));
        let one = call(
            &mcp,
            "list_tables",
            json!({ "connection": "s", "schema": "MAIN" }),
        )
        .await
        .unwrap();
        assert_eq!(one["not_listed"], json!({ "main": 3 }));
        assert!(call(
            &mcp,
            "list_tables",
            json!({ "connection": "s", "schema": "nope" })
        )
        .await
        .is_err());
        let found = call(
            &mcp,
            "search_schema",
            json!({ "connection": "s", "text": "t0502" }),
        )
        .await
        .unwrap();
        assert_eq!(found["tables"], json!(["main.t0502"]));
        assert!(found.get("note").is_none());
        let many = call(
            &mcp,
            "search_schema",
            json!({ "connection": "s", "text": "t0" }),
        )
        .await
        .unwrap();
        assert_eq!(many["tables"].as_array().unwrap().len(), 40);
        assert_eq!(
            many["note"],
            "463 more tables and 0 more columns match. Search for longer text."
        );

        // Exactly the cap: nothing left over.
        rusqlite::Connection::open(&db)
            .unwrap()
            .execute_batch("drop table t0500; drop table t0501; drop table t0502;")
            .unwrap();
        let full = call(
            &mcp,
            "list_tables",
            json!({ "connection": "s", "refresh": true }),
        )
        .await
        .unwrap();
        assert_eq!(full["tables"].as_array().unwrap().len(), MAX_TABLES);
        assert!(full.get("not_listed").is_none() && full.get("note").is_none());
        // The description says the same cap.
        assert!(tools().iter().any(|t| t.name == "list_tables"
            && t.description
                .as_deref()
                .unwrap_or("")
                .contains(&MAX_TABLES.to_string())));
        std::env::remove_var("ROWKERY_CONFIG_DIR");
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn long_arguments_are_cut_for_the_log() {
        let mut args = Map::new();
        args.insert("sql".into(), json!("é".repeat(3000)));
        let logged = logged_args(&args);
        let text = logged.as_str().expect("cut to a string");
        assert!(text.len() <= 4096 + "…".len());
        assert!(text.ends_with('…'));
        args.insert("sql".into(), json!("select 1"));
        assert_eq!(logged_args(&args), json!({ "sql": "select 1" }));
    }
}
