//! `rowkery://` links from Rowkery's views in the chat (`rowkery_mcp::views`):
//! `rowkery://open?call=<id>` opens a logged agent query as a query tab, not
//! run (the user presses ⌘↵); `rowkery://review?proposal=<id>` opens that
//! proposal's review.
//!
//! A link names a call by its id and random key, never by SQL, so a web page
//! can't make Rowkery run anything: the SQL comes from the activity log, and
//! only a query the guard let through (verdict ok) opens. The log is a plain
//! file anything on the Mac can append to, so the SQL passes the agent read
//! guard's static checks again here (`recheck_logged_read`) rather than
//! trusting the logged verdict. The page takes the
//! link with `take_open_link` (`open-link` says one is waiting), so a link
//! that launched the app waits until the page is up.
// Links arrive only on macOS (`RunEvent::Opened`), where the bundle registers the scheme.
#![cfg_attr(not(target_os = "macos"), allow(dead_code))]

use std::sync::Mutex;

use rowkery_core::config::LINK_SCHEME;
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
    /// The proposal was decided or expired since the card was drawn.
    Decided,
    /// The call isn't in the log (cleared, rotated twice, or a made-up link).
    Gone,
    /// The logged SQL fails the read guard again, whatever its verdict says.
    Refused,
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
    waiting: impl Fn(&str) -> bool,
) -> Option<OpenLink> {
    // Only this build's own scheme: Rowkery Dev's links are `rowkery-dev://`.
    let rest = url.strip_prefix(LINK_SCHEME)?.strip_prefix("://")?;
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
                }) => match rowkery_mcp::recheck_logged_read(&sql) {
                    Ok(_) => OpenLink::Sql {
                        connection,
                        database,
                        sql,
                    },
                    Err(_) => OpenLink::Refused,
                },
                _ => OpenLink::Gone,
            })
        }
        "review" => Some(match param(query, "proposal") {
            // Not the oldest one instead: the Agents page would show another change.
            Some(id) if waiting(id) => OpenLink::Proposal { id: id.to_string() },
            _ => OpenLink::Decided,
        }),
        _ => None,
    }
}

/// A link the OS handed us: keep it for the page and bring the window up.
pub fn opened(app: &AppHandle, url: &str) {
    let waiting = |id: &str| rowkery_mcp::proposals::waiting().iter().any(|p| p.id == id);
    let Some(link) = resolve(url, rowkery_mcp::audit::find_call, waiting) else {
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
        e.sql = Some(
            match id {
                "delete" => "DELETE FROM users",
                "multi" => "select 1; delete from users",
                "cte" => "with gone as (delete from users returning *) select * from gone",
                "call" => "select pg_terminate_backend(42)",
                _ => "select 1",
            }
            .into(),
        );
        e.verdict = Some(if id == "refused" {
            "Refused: no".into()
        } else {
            "ok".into()
        });
        (id != "missing").then_some(e)
    }

    fn waiting(id: &str) -> bool {
        id == "p_0123456789ab"
    }

    #[test]
    fn a_call_link_opens_only_a_query_the_guard_let_through() {
        assert_eq!(
            resolve(
                &format!("{LINK_SCHEME}://open?call=1-2-ab"),
                logged,
                waiting
            ),
            Some(OpenLink::Sql {
                connection: "pg".into(),
                database: Some("shop".into()),
                sql: "select 1".into()
            })
        );
        assert_eq!(
            resolve(
                &format!("{LINK_SCHEME}://open?call=refused"),
                logged,
                waiting
            ),
            Some(OpenLink::Gone)
        );
        assert_eq!(
            resolve(
                &format!("{LINK_SCHEME}://open?call=missing"),
                logged,
                waiting
            ),
            Some(OpenLink::Gone)
        );
        // A forged log line with verdict ok still has to be a single read.
        for forged in ["delete", "multi", "cte", "call"] {
            assert_eq!(
                resolve(
                    &format!("{LINK_SCHEME}://open?call={forged}"),
                    logged,
                    waiting
                ),
                Some(OpenLink::Refused),
                "{forged}"
            );
        }
        assert_eq!(
            resolve(
                &format!("{LINK_SCHEME}://open?sql=select%201"),
                logged,
                waiting
            ),
            Some(OpenLink::Gone)
        );
        assert_eq!(
            resolve(
                &format!("{LINK_SCHEME}://review?proposal=p_0123456789ab"),
                logged,
                waiting
            ),
            Some(OpenLink::Proposal {
                id: "p_0123456789ab".into()
            })
        );
        assert_eq!(
            resolve(
                &format!("{LINK_SCHEME}://review?proposal=p_committed000"),
                logged,
                waiting
            ),
            Some(OpenLink::Decided)
        );
        assert_eq!(
            resolve(&format!("{LINK_SCHEME}://elsewhere"), logged, waiting),
            None
        );
        assert_eq!(
            resolve("https://rowkery.com/open?call=1", logged, waiting),
            None
        );
    }
}
