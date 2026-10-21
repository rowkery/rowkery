//! `Rowkery --mcp`: a Model Context Protocol server over stdio, so Claude
//! Code (or any MCP client) can read the schema of shared connections and run
//! guarded, read-only queries on them.
//!
//! It reads the same `config.json` and keychain as the app, on every call, so
//! turning "Allow MCP" on or off in a connection's sheet takes effect at once.
//! Only connections with `allow_mcp` set are visible. Every query is one
//! SELECT (safe mode's classifier), runs in a read-only session with a 10 s
//! statement timeout, is capped by wrapping it in `LIMIT`, and is refused
//! when its plan reads a big table end to end. Each call is appended to
//! `mcp-log.jsonl` beside the config.

pub mod access;
pub mod audit;
mod change;
#[cfg(all(test, feature = "postgres-integration"))]
mod e2e_tests;
mod functions;
mod guard;
pub mod mask;
pub mod picker;
pub mod proposals;
pub mod samples;
pub mod sessions;
mod target;

use std::sync::Arc;

use rmcp::handler::server::ServerHandler;
use rmcp::model::{
    CacheScope, CallToolRequestParams, CallToolResponse, CallToolResult, ContentBlock,
    Implementation, ListToolsResult, PaginatedRequestParams, ServerCapabilities, ServerConfig,
    Tool, ToolAnnotations,
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
what's running, what each session waits on and who blocks whom. Queries never change data: the session is \
read-only. To change data, call propose_change with the INSERT, UPDATE or DELETE statements and why: \
the user reviews a dry run in Rowkery and commits or rejects it, and check_proposal tells you which. \
Don't send a rejected change again.";

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

#[derive(Clone, Default)]
pub struct RowkeryMcp {
    store: Arc<Mutex<Store>>,
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
            "Tables and views with approximate row counts and column counts. Cached for the session; refresh reloads the schema.",
            json!({ "connection": connection, "database": database,
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
            "Run one read-only SELECT. Returns column names once, rows as arrays, and more: true when the row cap cut the result. Capped at max_rows (default 200, max 1000); refused if the plan reads a table of over 100,000 rows end to end; 10 s timeout.",
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
        let mut store = self.store.lock().await;
        store.forget_unshared(&config);
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
                list_tables(&mut store, &target, refresh).await
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
                    run_read(
                        &mut store,
                        &target,
                        sql,
                        max_rows,
                        name == "explain",
                        &mut entry,
                    )
                    .await
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
            "propose_change" => {
                let client = self.client.lock().ok().and_then(|c| c.clone());
                propose(&mut store, &target, args, client).await
            }
            other => Err(format!("Unknown tool \"{other}\".")),
        };
        (outcome, entry, target.record.mcp_samples())
    }
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
            "{hidden} more saved connection(s) are not shared. The user can turn on \"Allow MCP\" in a connection's sheet in Rowkery."
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

async fn list_tables(store: &mut Store, target: &Target, refresh: bool) -> Outcome {
    let rule = rule(target);
    let cached = store.catalog(target, refresh).await?;
    let catalog = &cached.catalog;
    let tables: Vec<Json> = all_tables(catalog)
        .filter(|(_, t)| t.partition_of.is_none())
        .filter(|(s, t)| rule.allows_node(catalog, s, t))
        .map(|(schema, t)| {
            let partitions = all_tables(catalog)
                .filter(|(s, p)| *s == schema && p.partition_of.as_deref() == Some(&t.name))
                .count();
            let mut line = format!("{schema}.{}", t.name);
            if t.kind != TableKind::Table {
                line.push_str(&format!(" ({})", kind_label(t.kind)));
            }
            if let Some(rows) = rows_estimate(&t.row_estimate) {
                line.push_str(&format!(" ~{rows} rows"));
            }
            line.push_str(&format!(", {} cols", t.columns.len()));
            if partitions > 0 {
                line.push_str(&format!(", {partitions} partitions"));
            }
            json!(line)
        })
        .collect();
    Ok(
        json!({ "database": target.database, "schema_loaded": age(cached.loaded), "tables": tables }),
    )
}

async fn search_schema(store: &mut Store, target: &Target, text: &str) -> Outcome {
    const MAX_HITS: usize = 40;
    let needle = text.trim().to_lowercase();
    let rule = rule(target);
    let cached = store.catalog(target, false).await?;
    let catalog = &cached.catalog;
    let marks = mask::parse(target.record.masked_columns(&target.database));
    let mut tables = Vec::new();
    let mut columns = Vec::new();
    for (schema, t) in all_tables(catalog)
        .filter(|(_, t)| t.partition_of.is_none())
        .filter(|(s, t)| rule.allows_node(catalog, s, t))
    {
        if t.name.to_lowercase().contains(&needle) && tables.len() < MAX_HITS {
            tables.push(json!(format!("{schema}.{}", t.name)));
        }
        for c in &t.columns {
            if c.name.to_lowercase().contains(&needle) && columns.len() < MAX_HITS {
                let masked = marks
                    .iter()
                    .any(|m| m.schema == schema && m.table == t.name && m.column == c.name);
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
    Ok(json!({ "tables": tables, "columns": columns }))
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
    let cached = store.catalog(target, false).await?;
    let catalog = &cached.catalog;
    let (_, t) = find_table(catalog, &format!("{schema}.{table}"))?;

    let columns: Vec<Json> = t
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
    for c in &t.columns {
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
    let masked: Vec<String> = mask::parse(target.record.masked_columns(&target.database))
        .into_iter()
        .filter(|m| m.schema == schema && m.table == table)
        .map(|m| m.column)
        .collect();
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

/// `explain` and `query`: the same checks, then either the plan or the rows.
async fn run_read(
    store: &mut Store,
    target: &Target,
    sql: &str,
    max_rows: Option<u64>,
    plan_only: bool,
    entry: &mut audit::Entry,
) -> Outcome {
    let sql = guard::single_read(sql)?;
    let cap = guard::row_cap(max_rows);
    let alias = guard::wrapper_alias();
    let capped = guard::wrap_limit(&sql, cap + 1, &alias);
    let engine = engine(&target.record);

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
            let explain = store
                .read(target, &format!("EXPLAIN (FORMAT JSON, VERBOSE) {capped}"))
                .await?;
            let text = match explain.rows.first().and_then(|r| r.first()) {
                Some(rowkery_core::Value::Text(t)) => t.clone(),
                _ => return Err("EXPLAIN returned no plan.".into()),
            };
            let plan: Json = serde_json::from_str(&text).map_err(|e| e.to_string())?;
            let planned = functions::scan_plan(&plan);
            if sessions::reads_activity(&planned.call_names()) {
                return Err(sessions::ACTIVITY_REFUSAL.into());
            }
            functions::check_pg(store, target, &planned, false).await?;
            let (lines, scans) = guard::pg_plan(&plan);
            let scans: Vec<(Option<String>, String)> =
                scans.into_iter().map(|s| (s.schema, s.table)).collect();
            let touched = guard::pg_relations(&plan);
            (lines, scans, touched, Some(plan))
        }
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
                ConnectionRecord::Sqlite(c) if rule(target).restricts() => {
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
    let rule = rule(target);
    if rule.restricts() {
        let cached = store.catalog(target, false).await?;
        let catalog = &cached.catalog;
        // Every relation the plan reads (views and CTEs resolved to the
        // tables underneath) must be shared, matched by its exact name.
        let blocked = touched.iter().any(|(schema, table)| {
            if guard::is_statistics(schema.as_deref(), table) {
                return true;
            }
            let schema = schema.as_deref().unwrap_or("main");
            match access::find_exact(catalog, schema, table) {
                Some(t) => !rule.allows_node(catalog, schema, t),
                None => !rule.allows(schema, table),
            }
        });
        if blocked {
            return Err(guard::HIDDEN_REFUSAL.into());
        }
    }
    // Sensitive columns: refused unless only returned or counted, and the
    // places in the result that hold one.
    let marks = mask::parse(target.record.masked_columns(&target.database));
    let masked_at = if marks.is_empty() {
        Vec::new()
    } else {
        match (&pg_plan_json, &target.record) {
            (Some(plan), _) => pg_masked(store, target, &marks, plan, &touched, &alias).await?,
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
        Some(rowkery_core::secrets::mask_key(target.id()).map_err(|e| {
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
        let mut out = json!({ "plan": plan_lines });
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
            EngineKind::Sqlite => notes.push(r.replacen("Refused: the plan", "Note: this", 1)),
        }
    }

    let result = store.read(target, &capped).await?;
    let more = result.rows.len() > cap;
    let mut cut = false;
    let mut rows = Vec::new();
    let mut size = 0usize;
    let mut payload_cut = false;
    for row in result.rows.iter().take(cap) {
        let cells: Vec<Json> = row
            .iter()
            .enumerate()
            .map(|(i, v)| match &mask_key {
                Some(key) if masked_at.contains(&i) => mask::stand_in(key.as_bytes(), v),
                _ => guard::cell(v, &mut cut),
            })
            .collect();
        let shaped = Json::Array(cells);
        size += shaped.to_string().len() + 1;
        if size > PAYLOAD_BYTES {
            payload_cut = true;
            break;
        }
        rows.push(shaped);
    }
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
) -> Result<Vec<usize>, String> {
    const INDEXES: &str = "SELECT ci.relname, n.nspname || '.' || coalesce(pt.relname, t.relname), pg_get_indexdef(i.indexrelid) \
        FROM pg_index i JOIN pg_class ci ON ci.oid = i.indexrelid JOIN pg_class t ON t.oid = i.indrelid \
        JOIN pg_namespace n ON n.oid = t.relnamespace \
        LEFT JOIN pg_inherits inh ON inh.inhrelid = t.oid LEFT JOIN pg_class pt ON pt.oid = inh.inhparent \
        WHERE n.nspname NOT IN ('pg_catalog', 'information_schema')";
    let facts = store.read(target, INDEXES).await?;
    let text = |v: Option<&rowkery_core::Value>| match v {
        Some(rowkery_core::Value::Text(t)) => t.clone(),
        _ => String::new(),
    };
    let mut indexes = std::collections::HashSet::new();
    for row in &facts.rows {
        let table = text(row.get(1));
        let definition = text(row.get(2));
        if marks.iter().any(|m| {
            table == format!("{}.{}", m.schema, m.table)
                && mask::index_covers(&definition, &m.column)
        }) {
            indexes.insert(text(row.first()));
        }
    }

    let cached = store.catalog(target, false).await?;
    let catalog = &cached.catalog;
    // A relation's parent when it is a partition (same schema).
    let parent = |schema: &str, rel: &str| {
        access::find_exact(catalog, schema, rel).and_then(|t| t.partition_of.clone())
    };
    let root_of = |schema: &str, rel: &str| {
        let mut name = rel.to_string();
        let mut partition = false;
        for _ in 0..8 {
            match parent(schema, &name) {
                Some(p) => {
                    name = p;
                    partition = true;
                }
                None => break,
            }
        }
        (name, partition)
    };
    for m in marks {
        let reads_it = touched.iter().any(|(s, t)| {
            let schema = s.as_deref().unwrap_or("public");
            schema == m.schema && root_of(schema, t).0 == m.table
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
    let marked_of = |schema: Option<&str>, rel: &str| {
        let schema = schema.unwrap_or("public");
        let (root, partition) = root_of(schema, rel);
        let columns: Vec<String> = marks
            .iter()
            .filter(|m| m.schema == schema && m.table == root)
            .map(|m| m.column.clone())
            .collect();
        (columns, partition)
    };
    mask::pg_check(
        plan,
        &mask::PgFacts {
            marked_of: &marked_of,
            marked_indexes: &indexes,
            wrapper: alias,
        },
    )
}

impl ServerHandler for RowkeryMcp {
    fn get_info(&self) -> ServerConfig {
        ServerConfig::new(ServerCapabilities::builder().enable_tools().build())
            .with_server_info(
                Implementation::new("rowkery", env!("CARGO_PKG_VERSION")).with_title("Rowkery"),
            )
            .with_instructions(INSTRUCTIONS)
    }

    async fn list_tools(
        &self,
        _request: Option<PaginatedRequestParams>,
        _context: RequestContext<RoleServer>,
    ) -> Result<ListToolsResult, McpError> {
        // Clients on MCP 2026-07-28 require ttlMs and cacheScope on list results
        // (Claude Code rejects the response without them). The tool list depends
        // on nothing per-user, but 0 / private keeps clients re-reading it.
        Ok(ListToolsResult::with_all_items(tools())
            .with_ttl_ms(0)
            .with_cache_scope(CacheScope::Private))
    }

    async fn call_tool(
        &self,
        request: CallToolRequestParams,
        context: RequestContext<RoleServer>,
    ) -> Result<CallToolResponse, McpError> {
        let args = request.arguments.unwrap_or_default();
        let client = context.peer.peer_info().map(|p| p.client_info.name.clone());
        if let Ok(mut slot) = self.client.lock() {
            slot.clone_from(&client);
        }
        let (outcome, mut entry, keep_sample) = self.dispatch(&request.name, &args).await;
        entry.client = client;
        let text = match &outcome {
            Ok(value) => value.to_string(),
            Err(message) => message.clone(),
        };
        entry.bytes = Some(text.len() as u64);
        if keep_sample && outcome.is_ok() {
            samples::save(
                &samples::shape(entry.session.unwrap_or(0), entry.ts, &text),
                entry.ts,
            );
        }
        if entry.verdict.is_none() {
            entry.verdict = Some(match &outcome {
                Ok(_) => "ok".into(),
                Err(e) => e.clone(),
            });
        }
        audit::append(&entry);
        Ok(text_result(&outcome).into())
    }
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
