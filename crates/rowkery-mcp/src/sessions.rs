//! The `sessions` tool: what's running on a shared Postgres database, who
//! waits on whom, for an agent asked "why is this slow?". Read-only; it
//! can't stop anything.
//!
//! Query text is shown with every literal replaced by `?` and comments
//! dropped, so values typed into other people's queries never reach the
//! agent. A query naming a table the user hasn't shared is blanked (one
//! named only inside a string, as in a `DO` block, isn't caught, but the
//! string itself shows as `?`). Reading
//! `pg_stat_activity` through `query` is refused for the same reason
//! ([`ACTIVITY_REFUSAL`]).

use std::collections::HashSet;

use rowkery_core::db::postgres::ServerSession;
use rowkery_core::db::SchemaCatalog;
use serde_json::{json, Value as Json};

use crate::access::Tables;

/// More than anyone reads; the busiest come first.
const MAX_SESSIONS: usize = 100;

pub const HIDDEN_QUERY: &str = "(reads a table not shared with agents)";

/// Stands in the names of a query for one it spells in escapes (`U&"…"`).
const UNREAD_NAME: &str = "\0unread";

pub const UNCLEAR_QUERY: &str = "(its literals can't be told apart without the session's settings)";

/// Functions that return other sessions' query text as typed.
const ACTIVITY_FUNCTIONS: &[&str] = &[
    "pg_stat_get_activity",
    "pg_stat_get_backend_activity",
    "pg_stat_statements",
];

pub fn reads_activity(called: &[String]) -> bool {
    called
        .iter()
        .any(|n| ACTIVITY_FUNCTIONS.contains(&n.as_str()))
}

pub const ACTIVITY_REFUSAL: &str = "Refused: pg_stat_activity and pg_stat_statements show other sessions' queries with the values typed into them. Use the sessions tool, which shows them with values replaced by ?.";

/// The query with string, number and dollar-quoted literals as `?`, comments
/// dropped and whitespace folded; and the names it mentions (bare words
/// folded to lower case, quoted ones as written).
///
/// A backslash escapes a quote in `E'…'`, and in every string on a server
/// with `standard_conforming_strings` off, which the query's own session
/// may have set. `'a\' AND token = 'x'` is two strings one way and one the
/// other, so the query is read both ways, and blanked when they differ:
/// one of them would show a literal as SQL.
pub fn redact(sql: &str) -> (String, Vec<String>) {
    let (text, mut names) = redact_reading(sql, false);
    let (other, other_names) = redact_reading(sql, true);
    names.extend(other_names);
    if text == other {
        (text, names)
    } else {
        (UNCLEAR_QUERY.into(), names)
    }
}

/// `redact`, with a backslash escaping a quote in `E'…'` only, or in every
/// string when `backslash_everywhere`.
fn redact_reading(sql: &str, backslash_everywhere: bool) -> (String, Vec<String>) {
    let b = sql.as_bytes();
    let n = b.len();
    let mut out = String::with_capacity(n);
    let mut names = Vec::new();
    let mut i = 0;
    // The word before a string was `E`.
    let mut escaped = false;
    let space = |out: &mut String| {
        if !out.is_empty() && !out.ends_with(' ') {
            out.push(' ');
        }
    };
    while i < n {
        let c = b[i];
        match c {
            b'\'' => {
                let backslash = backslash_everywhere || escaped;
                i += 1;
                while i < n {
                    if b[i] == b'\'' {
                        if b.get(i + 1) == Some(&b'\'') {
                            i += 2;
                            continue;
                        }
                        break;
                    }
                    if backslash && b[i] == b'\\' {
                        i += 1;
                    }
                    i += 1;
                }
                i = (i + 1).min(n);
                out.push('?');
                escaped = false;
            }
            b'"' => {
                // `U&"…"` spells its name in escapes Rowkery doesn't decode
                // (`menu&"x"` is the `&` operator).
                let before = out.len().saturating_sub(2);
                if (out.ends_with("U&") || out.ends_with("u&"))
                    && !out[..before]
                        .chars()
                        .next_back()
                        .is_some_and(|ch| ch.is_alphanumeric() || ch == '_' || ch == '$')
                {
                    names.push(UNREAD_NAME.into());
                }
                let start = i + 1;
                i = start;
                // `""` is a quote inside the name.
                while i < n && (b[i] != b'"' || b.get(i + 1) == Some(&b'"')) {
                    i += if b[i] == b'"' { 2 } else { 1 };
                }
                if i >= n {
                    // Unclosed: what follows may be strings Postgres never
                    // got to read.
                    out.push('?');
                    break;
                }
                let quoted = &sql[start..i];
                names.push(quoted.replace("\"\"", "\""));
                out.push('"');
                out.push_str(quoted);
                out.push('"');
                i += 1;
            }
            b'-' if b.get(i + 1) == Some(&b'-') => {
                // Postgres ends one at a carriage return too.
                while i < n && b[i] != b'\n' && b[i] != b'\r' {
                    i += 1;
                }
                space(&mut out);
            }
            b'/' if b.get(i + 1) == Some(&b'*') => {
                // Block comments nest in Postgres.
                i += 2;
                let mut depth = 1;
                while i < n && depth > 0 {
                    if b[i] == b'/' && b.get(i + 1) == Some(&b'*') {
                        depth += 1;
                        i += 2;
                    } else if b[i] == b'*' && b.get(i + 1) == Some(&b'/') {
                        depth -= 1;
                        i += 2;
                    } else {
                        i += 1;
                    }
                }
                i = i.min(n);
                space(&mut out);
            }
            b'$' if b.get(i + 1).is_some_and(u8::is_ascii_digit) => {
                // `$1`: a parameter, not a value.
                let start = i;
                i += 1;
                while i < n && b[i].is_ascii_digit() {
                    i += 1;
                }
                out.push_str(&sql[start..i]);
            }
            b'$' => {
                // `$tag$ … $tag$`; an unclosed one runs to the end.
                let tag_end = sql[i + 1..].find('$').map(|p| i + 1 + p).filter(|&e| {
                    sql[i + 1..e]
                        .bytes()
                        .all(|ch| ch.is_ascii_alphanumeric() || ch == b'_' || ch >= 0x80)
                });
                match tag_end {
                    Some(e) => {
                        let tag = &sql[i..=e];
                        i = sql[e + 1..].find(tag).map_or(n, |p| e + 1 + p + tag.len());
                        out.push('?');
                    }
                    None => {
                        out.push('$');
                        i += 1;
                    }
                }
            }
            _ if c.is_ascii_alphabetic() || c == b'_' || c >= 0x80 => {
                let start = i;
                while i < n
                    && (b[i].is_ascii_alphanumeric()
                        || b[i] == b'_'
                        || b[i] == b'$'
                        || b[i] >= 0x80)
                {
                    i += 1;
                }
                let word = &sql[start..i];
                // E'…', B'…', X'…', N'…': the prefix goes with the literal.
                let prefix = word.len() == 1
                    && matches!(word.as_bytes()[0] | 0x20, b'e' | b'b' | b'x' | b'n')
                    && b.get(i) == Some(&b'\'');
                if prefix {
                    escaped = word.as_bytes()[0] | 0x20 == b'e';
                    continue;
                }
                names.push(word.to_lowercase());
                out.push_str(word);
            }
            _ if c.is_ascii_digit()
                || (c == b'.' && b.get(i + 1).is_some_and(u8::is_ascii_digit)) =>
            {
                while i < n && (b[i].is_ascii_alphanumeric() || b[i] == b'.' || b[i] == b'_') {
                    // 1e-5
                    if (b[i] | 0x20) == b'e' && matches!(b.get(i + 1), Some(b'-' | b'+')) {
                        i += 1;
                    }
                    i += 1;
                }
                out.push('?');
            }
            _ if c.is_ascii_whitespace() => {
                space(&mut out);
                i += 1;
            }
            _ => {
                let ch = sql[i..].chars().next().unwrap_or(' ');
                out.push(ch);
                i += ch.len_utf8();
            }
        }
    }
    (out.trim().to_string(), names)
}

/// Names of the tables agents may not see (the bare table name, so a query
/// naming it with or without its schema is caught).
pub fn hidden_names(catalog: &SchemaCatalog, rule: &Tables) -> HashSet<String> {
    if !rule.restricts() {
        return HashSet::new();
    }
    catalog
        .databases
        .iter()
        .flat_map(|db| db.schemas.iter())
        .flat_map(|s| s.tables.iter().map(move |t| (s.name.as_str(), t)))
        .filter(|(s, t)| !rule.allows_node(catalog, s, t))
        .map(|(_, t)| folded(&t.name))
        .collect()
}

/// A name as compared with [`hidden_names`]: in lower case, accented
/// letters too (a database in a single-byte encoding folds them, and
/// blanking more is safe), and cut to the 63 bytes Postgres keeps.
pub(crate) fn folded(name: &str) -> String {
    let mut name = name.to_lowercase();
    let mut end = name.len().min(63);
    while !name.is_char_boundary(end) {
        end -= 1;
    }
    name.truncate(end);
    name
}

/// The query as an agent sees it; `hidden` from [`hidden_names`].
pub fn shown_query(sql: &str, hidden: &HashSet<String>) -> String {
    let (text, names) = redact(sql);
    let hides = |name: &String| {
        (name == UNREAD_NAME && !hidden.is_empty()) || hidden.contains(&folded(name))
    };
    if names.iter().any(hides) {
        HIDDEN_QUERY.into()
    } else {
        text
    }
}

/// How long it's been at what it's doing (the query while active, the
/// transaction while idle in one, else the state).
fn age(s: &ServerSession) -> Option<f64> {
    let state = s.state.as_deref().unwrap_or("");
    if state == "active" {
        s.query_secs
    } else if state.starts_with("idle in transaction") {
        s.xact_secs
    } else {
        s.state_secs
    }
}

fn secs(v: Option<f64>) -> Json {
    v.map_or(Json::Null, |s| json!((s.max(0.0) * 10.0).round() / 10.0))
}

/// The tool's answer: sessions that need looking at first (blocking others,
/// then waiting on a lock, then the longest at it), idle ones left out
/// unless `include_idle`.
pub fn shape(sessions: &[ServerSession], hidden: &HashSet<String>, include_idle: bool) -> Json {
    let blocking = |pid: i32| {
        sessions
            .iter()
            .filter(|s| s.blocked_by.contains(&pid))
            .count()
    };
    let idle = |s: &ServerSession| s.state.as_deref() == Some("idle");
    let mut shown: Vec<&ServerSession> = sessions
        .iter()
        .filter(|s| include_idle || !idle(s))
        .collect();
    let rank = |s: &ServerSession| {
        if blocking(s.pid) > 0 {
            0
        } else if !s.blocked_by.is_empty() {
            1
        } else {
            2
        }
    };
    shown.sort_by(|a, b| {
        rank(a).cmp(&rank(b)).then(
            age(b)
                .unwrap_or(-1.0)
                .total_cmp(&age(a).unwrap_or(-1.0))
                .then(a.pid.cmp(&b.pid)),
        )
    });
    let more = shown.len().saturating_sub(MAX_SESSIONS);
    let rows: Vec<Json> = shown
        .iter()
        .take(MAX_SESSIONS)
        .map(|s| {
            let application = match &s.rowkery_tag {
                Some(tag) => s.application[..s.application.len() - tag.len() - 1].to_string(),
                None => s.application.clone(),
            };
            let mut row = json!({
                "pid": s.pid,
                "user": s.user,
                "application": application,
                "state": s.state,
                "for_secs": secs(age(s)),
                "transaction_secs": secs(s.xact_secs),
            });
            if let Some(wait) = &s.wait {
                row["waiting_on"] = json!(wait);
            }
            if !s.blocked_by.is_empty() {
                row["blocked_by"] = json!(s.blocked_by);
            }
            let n = blocking(s.pid);
            if n > 0 {
                row["blocking"] = json!(n);
            }
            row["query"] = match &s.query {
                Some(q) if !q.trim().is_empty() => json!(shown_query(q, hidden)),
                Some(_) => Json::Null,
                None => json!("(not visible to this login)"),
            };
            row
        })
        .collect();
    let mut out = json!({ "sessions": rows });
    let idle_left_out = if include_idle {
        0
    } else {
        sessions.iter().filter(|s| idle(s)).count()
    };
    if idle_left_out > 0 {
        out["idle_not_shown"] = json!(idle_left_out);
    }
    if more > 0 {
        out["more"] = json!(more);
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn hidden(names: &[&str]) -> HashSet<String> {
        names.iter().map(|s| folded(s)).collect()
    }

    #[test]
    fn literals_become_question_marks() {
        let (text, _) = redact(
            "SELECT * FROM users WHERE email = 'a@b.com' AND id IN (1, 2.5, 1e-5)\n  AND note = E'it\\'s' -- secret 42\n  AND x = $1 AND body = $q$hello$q$ /* 'x' */ LIMIT 10",
        );
        assert_eq!(
            text,
            "SELECT * FROM users WHERE email = ? AND id IN (?, ?, ?) AND note = ? AND x = $1 AND body = ? LIMIT ?"
        );
        let (text, _) = redact("select 'it''s', B'101', x'ff', col2 from t9");
        assert_eq!(text, "select ?, ?, ?, col2 from t9");
        // pg_stat_activity cuts long queries mid-literal.
        let (text, _) = redact("insert into t values ('half a sec");
        assert_eq!(text, "insert into t values (?");
    }

    #[test]
    fn comments_nest_and_dollar_tags_take_any_letter() {
        let (text, _) = redact("SELECT 1 /* /* */ ' */, 'sk_live_xyz' AS k");
        assert_eq!(text, "SELECT ? , ? AS k");
        let (text, _) = redact("SELECT 1 /* outer /* inner */ api_key=sk_live_secret */ FROM t");
        assert_eq!(text, "SELECT ? FROM t");
        let (text, _) = redact("SELECT $é$sk_live_secret$é$");
        assert_eq!(text, "SELECT ?");
        let h = hidden(&["payroll"]);
        assert_eq!(
            shown_query("/* /* */ ' */ SELECT * FROM payroll WHERE a = '1'", &h),
            HIDDEN_QUERY
        );
    }

    #[test]
    fn line_ends_and_unclosed_names_never_show_a_literal() {
        for sql in [
            "SELECT 1 -- note\r, ' --\n' AS a, 'sk_live_secret' AS b",
            "SELECT \"a, 'sk_live_secret' FROM t",
        ] {
            let shown = shown_query(sql, &HashSet::new());
            assert!(!shown.contains("sk_live"), "{sql:?} showed {shown}");
        }
    }

    #[test]
    fn long_names_match_as_postgres_cuts_them() {
        let h = hidden(&[&"a".repeat(63)]);
        let sql = format!("SELECT * FROM {}_x", "a".repeat(63));
        assert_eq!(shown_query(&sql, &h), HIDDEN_QUERY);
        // An operator after a word isn't a U& name.
        assert_eq!(
            shown_query(r#"SELECT menu&"x" FROM t"#, &hidden(&["payroll"])),
            r#"SELECT menu&"x" FROM t"#
        );
    }

    #[test]
    fn hidden_names_match_however_they_are_written() {
        assert_eq!(
            shown_query("SELECT * FROM Ärzte", &hidden(&["ärzte"])),
            HIDDEN_QUERY
        );
        assert_eq!(
            shown_query("SELECT * FROM ärzte", &hidden(&["Ärzte"])),
            HIDDEN_QUERY
        );
        let h = hidden(&["payroll", "pay\"roll"]);
        assert_eq!(
            shown_query(r#"SELECT * FROM U&"p\0061yroll""#, &h),
            HIDDEN_QUERY
        );
        assert_eq!(
            shown_query(r#"SELECT * FROM "pay""roll""#, &h),
            HIDDEN_QUERY
        );
        // Nothing hidden: an escaped name is shown as written.
        assert_eq!(
            shown_query(r#"SELECT * FROM U&"p\0061yroll""#, &HashSet::new()),
            r#"SELECT * FROM U&"p\0061yroll""#
        );
    }

    #[test]
    fn a_backslash_that_may_or_may_not_escape_blanks_the_query() {
        // One string with standard_conforming_strings on, and a token in
        // the clear read the other way: either way, nothing shows.
        for sql in [
            r"SELECT * FROM users WHERE name LIKE 'a%' ESCAPE '\' AND api_token = 'sk_live_51Hxyz' AND id = 1",
            r"SELECT 'it\'s', 'sk_live_51Hxyz'",
        ] {
            let (text, _) = redact(sql);
            assert_eq!(text, UNCLEAR_QUERY, "{sql}");
            assert!(!shown_query(sql, &HashSet::new()).contains("sk_live"));
        }
        // A backslash that reads the same both ways changes nothing.
        let (text, _) = redact(r"SELECT E'a\'b', 'c:\path' FROM t");
        assert_eq!(text, "SELECT ?, ? FROM t");
        // Names read either way are kept, so a hidden table still blanks.
        let (_, names) = redact(r"SELECT 'x\' FROM payroll, ' FROM t");
        assert!(names.contains(&"payroll".to_string()), "{names:?}");
    }

    #[test]
    fn a_query_naming_a_hidden_table_is_blanked() {
        let h = hidden(&["payroll"]);
        for sql in [
            "select * from payroll",
            "SELECT * FROM public.PAYROLL",
            "select * from \"payroll\" p",
            "update payroll set salary = 1",
        ] {
            assert_eq!(shown_query(sql, &h), HIDDEN_QUERY, "{sql}");
        }
        assert_eq!(
            shown_query("select * from orders where note = 'payroll'", &h),
            "select * from orders where note = ?"
        );
    }

    fn session(pid: i32, state: &str, secs: f64, blocked_by: Vec<i32>) -> ServerSession {
        ServerSession {
            pid,
            user: Some("app".into()),
            application: "psql".into(),
            client: Some("10.0.0.5".into()),
            state: Some(state.into()),
            wait: None,
            xact_secs: Some(secs),
            query_secs: Some(secs),
            state_secs: Some(secs),
            query: Some("select 1".into()),
            blocked_by,
            can_stop: true,
            rowkery_tag: None,
        }
    }

    #[test]
    fn blockers_come_first_and_idle_is_left_out() {
        let rows = vec![
            session(1, "active", 50.0, vec![]),
            session(2, "idle in transaction", 3.0, vec![]),
            session(3, "active", 9.0, vec![2]),
            session(4, "idle", 900.0, vec![]),
        ];
        let out = shape(&rows, &HashSet::new(), false);
        let pids: Vec<i64> = out["sessions"]
            .as_array()
            .unwrap()
            .iter()
            .map(|r| r["pid"].as_i64().unwrap())
            .collect();
        assert_eq!(pids, vec![2, 3, 1]);
        assert_eq!(out["sessions"][0]["blocking"], 1);
        assert_eq!(out["sessions"][1]["blocked_by"], json!([2]));
        assert_eq!(out["idle_not_shown"], 1);
        // The client's address isn't passed on.
        assert!(!out.to_string().contains("10.0.0.5"));
        let all = shape(&rows, &HashSet::new(), true);
        assert_eq!(all["sessions"].as_array().unwrap().len(), 4);
    }
}
