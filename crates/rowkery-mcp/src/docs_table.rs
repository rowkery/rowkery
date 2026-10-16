//! The docs site's MCP reference (apps/docs/lib/generated/mcp-tools.json): every tool's name,
//! description and inputs from `tools()`, the instructions clients get, and the guard's limits.
//! The test fails when the file is stale; `UPDATE_DOCS=1 cargo test -p rowkery-mcp docs_table`
//! rewrites it.

use super::*;

fn docs_json() -> Json {
    let tools: Vec<Json> = tools()
        .into_iter()
        .map(|t| {
            let schema = Json::Object((*t.input_schema).clone());
            let required: Vec<&str> = schema["required"]
                .as_array()
                .map(|r| r.iter().filter_map(Json::as_str).collect())
                .unwrap_or_default();
            let inputs: Vec<Json> = schema["properties"]
                .as_object()
                .map(|props| {
                    props
                        .iter()
                        .map(|(name, p)| {
                            json!({
                                "name": name,
                                "type": p["type"],
                                "description": p["description"],
                                "required": required.contains(&name.as_str()),
                                "minimum": p["minimum"],
                                "maximum": p["maximum"],
                            })
                        })
                        .collect()
                })
                .unwrap_or_default();
            let read_only = t
                .annotations
                .as_ref()
                .and_then(|a| a.read_only_hint)
                .unwrap_or(false);
            json!({ "name": t.name, "description": t.description, "read_only": read_only, "inputs": inputs })
        })
        .collect();
    json!({
        "instructions": INSTRUCTIONS,
        "limits": {
            "default_rows": guard::DEFAULT_ROWS,
            "max_rows": guard::MAX_ROWS,
            "timeout_s": guard::STATEMENT_TIMEOUT.as_secs(),
            "big_table_rows": guard::BIG_TABLE_ROWS,
            "cell_chars": guard::CELL_CHARS,
            "payload_bytes": guard::PAYLOAD_BYTES,
        },
        "tools": tools,
    })
}

#[test]
fn docs_table_matches_the_tools() {
    let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../../apps/docs/lib/generated/mcp-tools.json");
    let want = format!("{}\n", serde_json::to_string_pretty(&docs_json()).unwrap());
    if std::env::var_os("UPDATE_DOCS").is_some() {
        std::fs::write(&path, &want).unwrap();
    }
    let have = std::fs::read_to_string(&path).unwrap_or_default();
    assert!(
        have == want,
        "apps/docs/lib/generated/mcp-tools.json is stale: run UPDATE_DOCS=1 cargo test -p rowkery-mcp docs_table"
    );
}
