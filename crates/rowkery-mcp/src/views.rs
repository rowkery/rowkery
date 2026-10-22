//! Rowkery's views in the chat (MCP Apps, `io.modelcontextprotocol/ui`).
//!
//! On a host that draws them (Claude Desktop and web, VS Code, Goose), a
//! `query` result shows as a sortable grid and a `propose_change` as a card,
//! both from one page bundled here (`view.html`). The page reads the same
//! text the agent got; what only the page needs (the call id, the
//! connection's label, a proposal's statements) goes in the result's `_meta`
//! under `rowkery/view`, which hosts don't hand to the model. The page has no
//! network. Hosts without the extension get today's text and none of the
//! extra tools or resources.
//!
//! Opening Rowkery works on macOS only, so elsewhere there's no call id and no
//! `open_in_rowkery`, and the page shows no button.
//!
//! "Open in Rowkery" and "Review in Rowkery" call `open_in_rowkery`, a tool
//! only the page can see, and the server opens the `rowkery://` link itself:
//! Claude asks before every link a local server's page opens, and has dropped
//! custom schemes before. The link carries a logged call id with a random
//! key, never SQL; the app looks the call up in its log.

use rmcp::model::{
    ClientCapabilities, ListResourcesResult, MetaObject, ReadResourceResult, Resource,
    ResourceContents, Tool,
};
use rowkery_core::config::AppConfig;
use serde_json::{json, Map, Value as Json};

pub const EXTENSION: &str = "io.modelcontextprotocol/ui";
pub const MIME: &str = "text/html;profile=mcp-app";
pub const VIEW_URI: &str = "ui://rowkery/view.html";
/// The result `_meta` key the page reads.
pub const META_KEY: &str = "rowkery/view";
/// The page can bring Rowkery to the front (`open`).
pub const CAN_OPEN: bool = cfg!(target_os = "macos");

const VIEW_HTML: &str = include_str!("view.html");
const MARK_SVG: &str = include_str!("../../../apps/rowkery-tauri/brand/rowkery-mark-no-shadow.svg");

/// The client draws MCP Apps views (it lists our MIME type under the extension).
pub fn supported(caps: &ClientCapabilities) -> bool {
    caps.extensions
        .as_ref()
        .and_then(|e| e.get(EXTENSION))
        .and_then(|ui| ui.get("mimeTypes"))
        .and_then(Json::as_array)
        .is_some_and(|types| types.iter().any(|t| t.as_str() == Some(MIME)))
}

fn meta(value: Json) -> MetaObject {
    MetaObject(value.as_object().cloned().unwrap_or_default())
}

/// Points `query` and `propose_change` at the view; adds the page-only tools.
pub fn add_to(tools: &mut Vec<Tool>) {
    for tool in tools.iter_mut() {
        if tool.name == "query" || tool.name == "propose_change" {
            // `ui/resourceUri` too, for hosts from before the nested form.
            tool.meta = Some(meta(
                json!({ "ui": { "resourceUri": VIEW_URI }, "ui/resourceUri": VIEW_URI }),
            ));
        }
    }
    let page_only = |name: &'static str, description: &'static str, props: Json| {
        let schema = json!({ "type": "object", "properties": props });
        let mut tool = Tool::new(
            name,
            description,
            std::sync::Arc::new(schema.as_object().cloned().unwrap_or_default()),
        );
        tool.meta = Some(meta(json!({ "ui": { "visibility": ["app"] } })));
        tool
    };
    if CAN_OPEN {
        tools.push(page_only(
            "open_in_rowkery",
            "Rowkery's view only: brings Rowkery to the front with a query call as a new tab, or a proposal's review screen.",
            json!({ "call": { "type": "string" }, "proposal": { "type": "string" } }),
        ));
    }
    tools.push(page_only(
        "proposal_status",
        "Rowkery's view only: what became of a proposal, for its card.",
        json!({ "id": { "type": "string" } }),
    ));
}

pub fn list() -> ListResourcesResult {
    ListResourcesResult::with_all_items(vec![Resource::new(VIEW_URI, "rowkery-view")
        .with_title("Rowkery")
        .with_mime_type(MIME)])
}

pub fn read(uri: &str) -> Option<ReadResourceResult> {
    (uri == VIEW_URI).then(|| {
        let html = VIEW_HTML.replace("<!--mark-->", MARK_SVG);
        // No csp: the host's default allows no network, which the page needs none of.
        let contents = ResourceContents::text(html, VIEW_URI)
            .with_mime_type(MIME)
            .with_meta(meta(json!({ "ui": { "prefersBorder": false } })));
        ReadResourceResult::new(vec![contents])
    })
}

/// The connection's name and environment for the view's header.
fn label(connection: Option<&str>) -> Json {
    let config = AppConfig::load().unwrap_or_default();
    match connection.and_then(|id| config.connections.iter().find(|c| c.id() == id)) {
        Some(c) => {
            let mut out = json!({ "name": c.display_name() });
            if let Some(env) = c.environment() {
                out["environment"] = serde_json::to_value(env).unwrap_or(Json::Null);
            }
            out
        }
        None => Json::Null,
    }
}

/// What only the view gets for a successful call (the result's `_meta`):
/// the call's id, the connection's label and a proposal's statements, never
/// rows (those are in the text the agent got). `None` for tools without a view.
pub fn page_meta(
    tool: &str,
    args: &Map<String, Json>,
    outcome: &Json,
    entry: &crate::audit::Entry,
) -> Option<MetaObject> {
    let mut out = match tool {
        "query" => {
            let mut out = json!({ "kind": "rows" });
            if let Some(id) = entry.call_id() {
                out["call"] = json!(id);
            }
            out
        }
        "propose_change" => {
            let sql = args.get("sql").and_then(Json::as_str).unwrap_or_default();
            let statements: Vec<Json> = rowkery_core::safety::row_changes(sql)
                .unwrap_or_default()
                .into_iter()
                .map(|c| json!({ "verb": c.verb, "target": c.target, "sql": c.sql }))
                .collect();
            json!({
                "kind": "proposal",
                "id": outcome["id"],
                "statements": statements,
                "reason": args.get("reason"),
                "expect_rows": args.get("expect_rows"),
            })
        }
        _ => return None,
    };
    out["connection"] = label(entry.connection.as_deref());
    if let Some(db) = &entry.database {
        out["database"] = json!(db);
    }
    Some(meta(json!({ META_KEY: out })))
}

/// A call id or proposal id as the server writes them: letters, digits, `-`
/// and `_`, so it can't smuggle anything into the link.
fn plain_id(id: &str) -> Option<&str> {
    let id = id.trim();
    (!id.is_empty()
        && id.len() <= 80
        && id
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_'))
    .then_some(id)
}

/// The `rowkery://` link for a page-only `open_in_rowkery` call.
pub fn link(args: &Map<String, Json>) -> Result<String, String> {
    let arg = |name| args.get(name).and_then(Json::as_str);
    match (arg("call"), arg("proposal")) {
        (Some(call), None) => plain_id(call)
            .map(|id| format!("rowkery://open?call={id}"))
            .ok_or_else(|| "Not a call id.".into()),
        (None, Some(p)) => plain_id(p)
            .map(|id| format!("rowkery://review?proposal={id}"))
            .ok_or_else(|| "Not a proposal id.".into()),
        _ => Err("Pass call or proposal.".into()),
    }
}

/// Hands the link to macOS, which starts Rowkery if it isn't running (the
/// app registers the scheme in its bundle; `open_link.rs` takes it).
pub fn open(url: &str) -> Result<(), String> {
    if !cfg!(target_os = "macos") {
        return Err("Opening Rowkery from the chat works on macOS for now.".into());
    }
    let status = std::process::Command::new("open")
        .arg(url)
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .status()
        .map_err(|e| format!("Couldn't open Rowkery: {e}"))?;
    if status.success() {
        Ok(())
    } else {
        Err("Couldn't open Rowkery. Is it installed?".into())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn args(v: Json) -> Map<String, Json> {
        v.as_object().cloned().unwrap()
    }

    #[test]
    fn only_clients_that_list_the_mime_type_get_views() {
        let caps = |v: Json| -> ClientCapabilities { serde_json::from_value(v).unwrap() };
        assert!(supported(&caps(
            json!({ "extensions": { EXTENSION: { "mimeTypes": [MIME] } } })
        )));
        assert!(!supported(&caps(json!({}))));
        assert!(!supported(&caps(
            json!({ "extensions": { EXTENSION: { "mimeTypes": ["text/html"] } } })
        )));
    }

    #[test]
    fn links_carry_only_plain_ids() {
        assert_eq!(
            link(&args(json!({ "call": "1760000000000-1760000001234-9f2c" }))).unwrap(),
            "rowkery://open?call=1760000000000-1760000001234-9f2c"
        );
        assert_eq!(
            link(&args(json!({ "proposal": "p_0123456789ab" }))).unwrap(),
            "rowkery://review?proposal=p_0123456789ab"
        );
        for bad in [
            json!({ "call": "1&sql=drop" }),
            json!({ "call": "" }),
            json!({ "proposal": "p 1" }),
            json!({ "call": "1", "proposal": "p_1" }),
            json!({}),
        ] {
            assert!(link(&args(bad)).is_err());
        }
    }

    #[test]
    fn the_page_ships_with_the_mark_and_no_network() {
        let page = read(VIEW_URI).unwrap();
        let ResourceContents::TextResourceContents {
            text, mime_type, ..
        } = &page.contents[0]
        else {
            panic!("text page");
        };
        assert_eq!(mime_type.as_deref(), Some(MIME));
        assert!(text.contains("fill-rule=\"evenodd\""));
        assert!(!text.contains("<!--mark-->"));
        for net in [
            "http://",
            "https://",
            "fetch(",
            "XMLHttpRequest",
            "WebSocket",
        ] {
            assert!(
                !text.replace("http://www.w3.org/2000/svg", "").contains(net),
                "{net}"
            );
        }
        assert!(read("ui://rowkery/other.html").is_none());
    }

    #[test]
    fn page_only_tools_are_hidden_from_the_model() {
        let mut tools = vec![
            Tool::new("query", "q", std::sync::Arc::new(Map::new())),
            Tool::new("explain", "e", std::sync::Arc::new(Map::new())),
        ];
        add_to(&mut tools);
        let meta = |name: &str| {
            tools
                .iter()
                .find(|t| t.name == name)
                .and_then(|t| t.meta.as_ref())
                .map(|m| Json::Object(m.0.clone()))
        };
        assert_eq!(meta("query").unwrap()["ui"]["resourceUri"], VIEW_URI);
        assert_eq!(meta("query").unwrap()["ui/resourceUri"], VIEW_URI);
        assert!(meta("explain").is_none());
        let status = meta("proposal_status").unwrap();
        assert_eq!(status, json!({ "ui": { "visibility": ["app"] } }));
        // Only where Rowkery can be opened from the chat.
        assert_eq!(
            meta("open_in_rowkery"),
            CAN_OPEN.then(|| json!({ "ui": { "visibility": ["app"] } }))
        );
    }

    /// A host that draws views, end to end over the wire: the tools point at
    /// the page, a query's result carries the rows and a call id the app can
    /// find in the log, and the page-only tools aren't logged.
    // The env lock spans the whole test, awaits included: each test has its own runtime.
    #[allow(clippy::await_holding_lock)]
    #[tokio::test]
    async fn a_host_that_draws_views_gets_rows_and_a_call_it_can_open() {
        use rmcp::ServiceExt;
        use rowkery_core::connections::{ConnectionRecord, SqliteConnection};
        use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};

        let _env = crate::ENV_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        let dir = std::env::temp_dir().join(format!("rowkery-mcp-views-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        std::env::set_var("ROWKERY_CONFIG_DIR", dir.to_string_lossy().to_string());
        let db = dir.join("t.db");
        rusqlite::Connection::open(&db)
            .unwrap()
            .execute_batch("create table orders(id integer primary key, total real); insert into orders values (1, 9.5), (2, 3);")
            .unwrap();
        let mut config = AppConfig::default();
        config.upsert_connection(ConnectionRecord::Sqlite(SqliteConnection {
            id: "s".into(),
            name: "shop".into(),
            path: db.to_string_lossy().to_string(),
            environment: Some(rowkery_core::connections::ConnectionEnvironment::Prd),
            safe_mode: Default::default(),
            sample: false,
            allow_mcp: true,
            mcp_hidden_tables: Vec::new(),
            mcp_until: None,
            mcp_samples_off: false,
            mcp_access: None,
            masked_columns: Default::default(),
        }));
        config.save().unwrap();

        let (client, server) = tokio::io::duplex(1 << 20);
        let (server_read, server_write) = tokio::io::split(server);
        tokio::spawn(async move {
            if let Ok(running) = crate::RowkeryMcp::default()
                .serve((server_read, server_write))
                .await
            {
                let _ = running.waiting().await;
            }
        });
        let (client_read, mut client_write) = tokio::io::split(client);
        let mut lines = BufReader::new(client_read).lines();
        // A request, or a notification (id 0) that gets no reply.
        let mut ask = async |id: u64, method: &str, params: Json| -> Json {
            let mut msg = json!({ "jsonrpc": "2.0", "method": method, "params": params });
            if id > 0 {
                msg["id"] = json!(id);
            }
            client_write
                .write_all(format!("{msg}\n").as_bytes())
                .await
                .unwrap();
            if id == 0 {
                return Json::Null;
            }
            loop {
                let line = lines.next_line().await.unwrap().unwrap();
                let reply: Json = serde_json::from_str(&line).unwrap();
                if reply["id"] == json!(id) {
                    return reply;
                }
            }
        };
        ask(
            1,
            "initialize",
            json!({ "protocolVersion": "2025-11-25", "clientInfo": { "name": "host", "version": "1" },
                    "capabilities": { "extensions": { EXTENSION: { "mimeTypes": [MIME] } } } }),
        )
        .await;
        ask(0, "notifications/initialized", json!({})).await;

        let tools = ask(2, "tools/list", json!({})).await;
        let names: Vec<&str> = tools["result"]["tools"]
            .as_array()
            .unwrap()
            .iter()
            .filter_map(|t| t["name"].as_str())
            .collect();
        assert!(names.contains(&"proposal_status"));
        assert_eq!(names.contains(&"open_in_rowkery"), CAN_OPEN);
        let page = ask(3, "resources/read", json!({ "uri": VIEW_URI })).await;
        assert_eq!(page["result"]["contents"][0]["mimeType"], MIME);

        let result = ask(
            4,
            "tools/call",
            json!({ "name": "query", "arguments": { "connection": "s", "sql": "select id, total from orders order by id" } }),
        )
        .await;
        // The agent's text is the rows as before: no call id, no label.
        let text: Json =
            serde_json::from_str(result["result"]["content"][0]["text"].as_str().unwrap()).unwrap();
        assert_eq!(text["rows"], json!([[1, 9.5], [2, 3.0]]));
        assert!(text.get("call").is_none() && text.get("connection").is_none());
        // What only the page needs rides in _meta.
        let view = &result["result"]["_meta"][META_KEY];
        assert_eq!(view["kind"], "rows");
        assert_eq!(
            view["connection"],
            json!({ "name": "shop", "environment": "prd" })
        );
        assert!(result["result"].get("structuredContent").is_none());

        if CAN_OPEN {
            let call = view["call"].as_str().unwrap();
            let entry = crate::audit::find_call(call).unwrap();
            assert_eq!(
                entry.sql.as_deref(),
                Some("select id, total from orders order by id")
            );
            assert_eq!(entry.connection.as_deref(), Some("s"));
            // Without the right key, the call isn't found.
            let (prefix, _) = call.rsplit_once('-').unwrap();
            assert!(crate::audit::find_call(&format!("{prefix}-0000")).is_none());
        } else {
            assert!(view.get("call").is_none());
        }

        // A bad id is refused before anything opens; nothing is logged.
        let logged = crate::audit::read_since(None).entries.len();
        let refused = ask(
            5,
            "tools/call",
            json!({ "name": "open_in_rowkery", "arguments": { "call": "x&y" } }),
        )
        .await;
        assert_eq!(refused["result"]["isError"], true);
        assert_eq!(crate::audit::read_since(None).entries.len(), logged);
        let _ = std::fs::remove_dir_all(dir);
    }
}
