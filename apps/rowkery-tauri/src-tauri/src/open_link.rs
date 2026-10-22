//! `rowkery://` links from Rowkery's views in the chat (`rowkery_mcp::views`):
//! `rowkery://open?call=<id>` opens a logged agent query as a query tab, run
//! at once; `rowkery://review?proposal=<id>` opens that proposal's review.
//!
//! A link names a call by its id and random key, never by SQL, so a web page
//! can't make Rowkery run anything: the SQL comes from the activity log, and
//! only a query the guard let through (verdict ok) opens. The page takes the
//! link with `take_open_link` (`open-link` says one is waiting), so a link
//! that launched the app waits until the page is up.
// Links arrive only on macOS (`RunEvent::Opened`), where the bundle registers the scheme.
#![cfg_attr(not(target_os = "macos"), allow(dead_code))]

use std::sync::Mutex;

use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager, State};

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum OpenLink {
    /// The agent's query, for a query tab on its connection.
    Sql {
        connection: String,
        database: Option<String>,
        sql: String,
    },
    /// A proposal's review screen.
    Proposal { id: String },
    /// The call isn't in the log (cleared, rotated twice, or a made-up link).
    Gone,
}

/// The link the page hasn't taken yet.
#[derive(Default)]
pub struct PendingLink(Mutex<Option<OpenLink>>);

/// `name=value` from the link's query string.
fn param<'a>(query: &'a str, name: &str) -> Option<&'a str> {
    query
        .split('&')
        .filter_map(|kv| kv.split_once('='))
        .find(|(k, _)| *k == name)
        .map(|(_, v)| v)
}

/// What a link asks for, read from the log; `None` for a link that isn't ours.
pub fn resolve(
    url: &str,
    find_call: impl Fn(&str) -> Option<rowkery_mcp::audit::Entry>,
) -> Option<OpenLink> {
    let rest = url.strip_prefix("rowkery://")?;
    let (action, query) = rest.split_once('?').unwrap_or((rest, ""));
    match action.trim_end_matches('/') {
        "open" => {
            let found = param(query, "call")
                .and_then(&find_call)
                .filter(|e| e.tool == "query" && e.verdict.as_deref() == Some("ok"));
            Some(match found {
                Some(rowkery_mcp::audit::Entry {
                    connection: Some(connection),
                    sql: Some(sql),
                    database,
                    ..
                }) => OpenLink::Sql {
                    connection,
                    database,
                    sql,
                },
                _ => OpenLink::Gone,
            })
        }
        "review" => Some(match param(query, "proposal") {
            Some(id) if !id.is_empty() => OpenLink::Proposal { id: id.to_string() },
            _ => OpenLink::Gone,
        }),
        _ => None,
    }
}

/// A link the OS handed us: keep it for the page and bring the window up.
pub fn opened(app: &AppHandle, url: &str) {
    let Some(link) = resolve(url, rowkery_mcp::audit::find_call) else {
        return;
    };
    if let Ok(mut slot) = app.state::<PendingLink>().0.lock() {
        *slot = Some(link);
    }
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.unminimize();
        let _ = window.show();
        let _ = window.set_focus();
    }
    let _ = app.emit("open-link", ());
}

#[tauri::command]
pub fn take_open_link(pending: State<'_, PendingLink>) -> Option<OpenLink> {
    pending.0.lock().ok().and_then(|mut slot| slot.take())
}

#[cfg(test)]
mod tests {
    use super::*;
    use rowkery_mcp::audit::Entry;

    fn logged(id: &str) -> Option<Entry> {
        let mut e = Entry::new("query");
        e.connection = Some("pg".into());
        e.database = Some("shop".into());
        e.sql = Some("select 1".into());
        e.verdict = Some(if id == "refused" {
            "Refused: no".into()
        } else {
            "ok".into()
        });
        (id != "missing").then_some(e)
    }

    #[test]
    fn a_call_link_opens_only_a_query_the_guard_let_through() {
        assert_eq!(
            resolve("rowkery://open?call=1-2-ab", logged),
            Some(OpenLink::Sql {
                connection: "pg".into(),
                database: Some("shop".into()),
                sql: "select 1".into()
            })
        );
        assert_eq!(
            resolve("rowkery://open?call=refused", logged),
            Some(OpenLink::Gone)
        );
        assert_eq!(
            resolve("rowkery://open?call=missing", logged),
            Some(OpenLink::Gone)
        );
        assert_eq!(
            resolve("rowkery://open?sql=select%201", logged),
            Some(OpenLink::Gone)
        );
        assert_eq!(
            resolve("rowkery://review?proposal=p_0123456789ab", logged),
            Some(OpenLink::Proposal {
                id: "p_0123456789ab".into()
            })
        );
        assert_eq!(resolve("rowkery://elsewhere", logged), None);
        assert_eq!(resolve("https://rowkery.com/open?call=1", logged), None);
    }
}
