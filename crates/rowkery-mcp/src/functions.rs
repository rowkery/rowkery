//! Which Postgres functions an agent's statement may call: an allow-list,
//! checked twice. First on the SQL as sent, before any EXPLAIN, because the
//! planner already evaluates some calls (an IMMUTABLE function with constant
//! arguments is folded into its result, and leaves no trace in the plan).
//! Then on the plan (EXPLAIN VERBOSE), where Postgres has deparsed every
//! expression that will run, views and SQL functions expanded.
//!
//! Allowed: Postgres's own functions in `pg_catalog` that only compute on
//! their arguments. That is every function whose overloads are all
//! IMMUTABLE, and the stable or volatile ones listed in [`ALLOWED`] (dates,
//! JSON builders, text search, catalog descriptions). [`refused_builtin`]
//! names the ones refused whatever their volatility, with the reason given
//! back to the agent. Everything outside `pg_catalog` and
//! `information_schema` (plpgsql or SQL functions, extensions such as
//! tablefunc's crosstab or http) is refused by name, since its body never
//! appears in the plan and can read tables that aren't shared. `pg_sleep` is
//! refused too: it only holds the agent's one session.
//!
//! Names are resolved against `pg_proc`, not trusted as written: a bare name
//! that a schema other than `pg_catalog` also defines may be resolved to
//! that one, so it is refused unless every such overload is compiled
//! (C, IMMUTABLE) extension code like citext's `max`. What the plan can't
//! show is refused when database code is behind it: operators, views (and
//! views over those views), domains and casts whose functions are written
//! in SQL or a procedural language, or are compiled but not IMMUTABLE.

use std::collections::HashSet;

use serde_json::Value as Json;

use crate::target::{Store, Target};

/// One call as written: `pg_catalog.lower(`, `"my fn"(`.
#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub struct Call {
    pub schema: Option<String>,
    pub name: String,
}

/// What a piece of SQL (or a deparsed plan expression) names. Bare names are
/// folded to lower case as Postgres does; quoted ones stay as written.
#[derive(Debug, Default, Clone)]
pub struct Scan {
    /// Names followed by `(`, with their schema when qualified.
    pub calls: Vec<Call>,
    /// `x.name` with no `(`: possibly a function called on a row (`t.f`).
    pub dotted: Vec<String>,
    /// Every name, for the views and types the statement mentions.
    pub words: Vec<String>,
    /// Operator symbols (`=`, `->>`, `===`).
    pub operators: Vec<String>,
    /// A `U&"…"` name, whose escapes would hide what it names.
    pub unicode_names: bool,
}

impl Scan {
    fn merge(&mut self, other: Scan) {
        fn add<T: PartialEq>(into: &mut Vec<T>, from: Vec<T>) {
            for item in from {
                if !into.contains(&item) {
                    into.push(item);
                }
            }
        }
        add(&mut self.calls, other.calls);
        add(&mut self.dotted, other.dotted);
        add(&mut self.words, other.words);
        add(&mut self.operators, other.operators);
        self.unicode_names |= other.unicode_names;
    }

    /// The called names, without their schema.
    pub fn call_names(&self) -> Vec<String> {
        let mut out: Vec<String> = Vec::new();
        for c in &self.calls {
            if !out.contains(&c.name) {
                out.push(c.name.clone());
            }
        }
        out
    }

    /// Every name and operator worth looking up in the catalog.
    fn lookups(&self) -> (Vec<String>, Vec<String>) {
        let mut names: Vec<String> = self.words.clone();
        for c in &self.calls {
            if !names.contains(&c.name) {
                names.push(c.name.clone());
            }
        }
        (names, self.operators.clone())
    }
}

#[derive(Debug, PartialEq)]
enum Tok {
    Name(String),
    Dot,
    Open,
    Cast,
    Op(String),
    Other,
}

const OP_CHARS: &[u8] = b"+-*/<>=~!@#%^&|`?";

/// The tokens of `text`. `backslash` reads every string as an escape string
/// (`standard_conforming_strings = off`); `scan_sql` runs both ways, so a
/// quote that one reading ends and the other doesn't can't hide a call.
fn tokenize(text: &str, backslash: bool) -> (Vec<Tok>, bool) {
    let b = text.as_bytes();
    let n = b.len();
    let mut out = Vec::new();
    let mut unicode = false;
    let mut i = 0;
    // A '…' string from `i` (at the quote) to after its end.
    let string = |mut i: usize, escapes: bool| -> usize {
        i += 1;
        while i < n {
            match b[i] {
                b'\\' if escapes => i += 2,
                b'\'' if b.get(i + 1) == Some(&b'\'') => i += 2,
                b'\'' => return i + 1,
                _ => i += 1,
            }
        }
        n
    };
    let quoted = |mut i: usize| -> (usize, String) {
        let mut name = Vec::new();
        i += 1;
        while i < n {
            if b[i] == b'"' {
                if b.get(i + 1) == Some(&b'"') {
                    name.push(b'"');
                    i += 2;
                    continue;
                }
                return (i + 1, String::from_utf8_lossy(&name).into_owned());
            }
            name.push(b[i]);
            i += 1;
        }
        (n, String::from_utf8_lossy(&name).into_owned())
    };
    while i < n {
        let c = b[i];
        match c {
            _ if c.is_ascii_whitespace() => i += 1,
            b'-' if b.get(i + 1) == Some(&b'-') => {
                while i < n && b[i] != b'\n' {
                    i += 1;
                }
            }
            b'/' if b.get(i + 1) == Some(&b'*') => {
                // Postgres nests block comments.
                let mut depth = 0;
                while i < n {
                    if b[i] == b'/' && b.get(i + 1) == Some(&b'*') {
                        depth += 1;
                        i += 2;
                    } else if b[i] == b'*' && b.get(i + 1) == Some(&b'/') {
                        depth -= 1;
                        i += 2;
                        if depth == 0 {
                            break;
                        }
                    } else {
                        i += 1;
                    }
                }
            }
            b'\'' => {
                i = string(i, backslash);
                out.push(Tok::Other);
            }
            b'"' => {
                let (end, name) = quoted(i);
                i = end;
                out.push(Tok::Name(name));
            }
            b'$' if b.get(i + 1).is_some_and(u8::is_ascii_digit) => {
                i += 1;
                while i < n && b[i].is_ascii_digit() {
                    i += 1;
                }
                out.push(Tok::Other);
            }
            b'$' => {
                let mut e = i + 1;
                while e < n && (b[e].is_ascii_alphanumeric() || b[e] == b'_' || b[e] >= 0x80) {
                    e += 1;
                }
                let tag_ok =
                    b.get(e) == Some(&b'$') && !b.get(i + 1).is_some_and(u8::is_ascii_digit);
                if tag_ok {
                    let tag = &text[i..=e];
                    i = text[e + 1..].find(tag).map_or(n, |p| e + 1 + p + tag.len());
                } else {
                    i += 1;
                }
                out.push(Tok::Other);
            }
            b'(' => {
                out.push(Tok::Open);
                i += 1;
            }
            b'.' if !b.get(i + 1).is_some_and(u8::is_ascii_digit) => {
                out.push(Tok::Dot);
                i += 1;
            }
            b':' if b.get(i + 1) == Some(&b':') => {
                out.push(Tok::Cast);
                i += 2;
            }
            _ if c.is_ascii_digit() || c == b'.' => {
                while i < n && (b[i].is_ascii_alphanumeric() || b[i] == b'_' || b[i] == b'.') {
                    i += 1;
                }
                out.push(Tok::Other);
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
                let word = &text[start..i];
                let next = b.get(i).copied();
                match (word.to_ascii_lowercase().as_str(), next) {
                    ("e", Some(b'\'')) => {
                        i = string(i, true);
                        out.push(Tok::Other);
                    }
                    ("b" | "x" | "n", Some(b'\'')) => {
                        i = string(i, backslash);
                        out.push(Tok::Other);
                    }
                    ("u", Some(b'&')) if matches!(b.get(i + 1), Some(b'\'' | b'"')) => {
                        if b[i + 1] == b'"' {
                            unicode = true;
                            let (end, name) = quoted(i + 1);
                            i = end;
                            out.push(Tok::Name(name));
                        } else {
                            i = string(i + 1, backslash);
                            out.push(Tok::Other);
                        }
                    }
                    (lower, _) => out.push(Tok::Name(lower.to_string())),
                }
            }
            _ if OP_CHARS.contains(&c) => {
                let start = i;
                while i < n
                    && OP_CHARS.contains(&b[i])
                    && !(b[i] == b'-' && b.get(i + 1) == Some(&b'-'))
                    && !(b[i] == b'/' && b.get(i + 1) == Some(&b'*'))
                {
                    i += 1;
                }
                // Postgres's rule: a multi-character operator only ends in
                // + or - when it also holds one of ~!@#%^&|`?.
                let mut end = i;
                if !text[start..end]
                    .bytes()
                    .any(|ch| b"~!@#%^&|`?".contains(&ch))
                {
                    while end > start + 1 && matches!(b[end - 1], b'+' | b'-') {
                        end -= 1;
                    }
                }
                out.push(Tok::Op(text[start..end].to_string()));
                i = end;
            }
            _ => {
                out.push(Tok::Other);
                i += 1;
            }
        }
    }
    (out, unicode)
}

fn scan(text: &str, backslash: bool) -> Scan {
    let (toks, unicode_names) = tokenize(text, backslash);
    let mut s = Scan {
        unicode_names,
        ..Scan::default()
    };
    for (i, tok) in toks.iter().enumerate() {
        match tok {
            Tok::Name(name) => {
                if !s.words.contains(name) {
                    s.words.push(name.clone());
                }
                let after_dot = i > 0 && toks[i - 1] == Tok::Dot;
                if toks.get(i + 1) == Some(&Tok::Open) {
                    // `x::numeric(10, 2)` is a type modifier, not a call.
                    if i > 0 && toks[i - 1] == Tok::Cast {
                        continue;
                    }
                    let schema = match (after_dot, i.checked_sub(2).map(|j| &toks[j])) {
                        (true, Some(Tok::Name(q))) => Some(q.clone()),
                        _ => None,
                    };
                    let call = Call {
                        schema,
                        name: name.clone(),
                    };
                    if !s.calls.contains(&call) {
                        s.calls.push(call);
                    }
                } else if after_dot && !s.dotted.contains(name) {
                    s.dotted.push(name.clone());
                }
            }
            Tok::Op(op) if !s.operators.contains(op) => s.operators.push(op.clone()),
            _ => {}
        }
    }
    s
}

/// What the SQL as sent names, read both ways a server may read strings.
pub fn scan_sql(sql: &str) -> Scan {
    let mut s = scan(sql, false);
    s.merge(scan(sql, true));
    s
}

/// Plan keys whose values are names, not expressions.
pub(crate) const NAME_KEYS: &[&str] = &[
    "Node Type",
    "Relation Name",
    "Schema",
    "Alias",
    "Index Name",
    "CTE Name",
    "Subplan Name",
    "Parent Relationship",
    "Strategy",
    "Join Type",
    "Scan Direction",
    "Partial Mode",
    "Operation",
    "Command",
    "Function Name",
];

/// What an `EXPLAIN (FORMAT JSON, VERBOSE)` plan calls. A Function Scan
/// names its function with its schema; every other expression is deparsed
/// text.
pub fn scan_plan(plan: &Json) -> Scan {
    fn walk(value: &Json, key: Option<&str>, out: &mut Scan) {
        match value {
            Json::String(s) if !key.is_some_and(|k| NAME_KEYS.contains(&k)) => {
                out.merge(scan_sql(s));
            }
            Json::Array(items) => items.iter().for_each(|v| walk(v, key, out)),
            Json::Object(map) => {
                if let Some(Json::String(name)) = map.get("Function Name") {
                    let call = Call {
                        schema: map.get("Schema").and_then(Json::as_str).map(str::to_string),
                        name: name.clone(),
                    };
                    if !out.calls.contains(&call) {
                        out.calls.push(call);
                    }
                }
                map.iter().for_each(|(k, v)| walk(v, Some(k), out));
            }
            _ => {}
        }
    }
    let mut out = Scan::default();
    walk(plan, None, &mut out);
    out
}

/// One `pg_proc` row for a name the statement uses.
#[derive(Debug, Clone, PartialEq)]
pub struct Function {
    pub schema: String,
    pub name: String,
    /// `provolatile`: i, s or v.
    pub volatility: char,
    /// Compiled (C or internal) and IMMUTABLE: extension code like
    /// citext's `max` or PostGIS's `st_distance`, which computes on its
    /// arguments and runs no SQL.
    pub compiled: bool,
    pub args: u32,
}

/// What the catalog says about the names a statement uses.
#[derive(Debug, Default, Clone)]
pub struct Facts {
    pub functions: Vec<Function>,
    /// Operators outside `pg_catalog` backed by database code: (schema, symbol).
    pub operators: Vec<(String, String)>,
    /// Views that run database code: (schema, name).
    pub views: Vec<(String, String)>,
    /// Domains and types whose checks or casts run database code.
    pub types: Vec<(String, String)>,
}

fn core(schema: &str) -> bool {
    matches!(schema, "pg_catalog" | "information_schema")
}

/// The catalog query behind [`Facts`], for these names and operators. Each
/// name goes in as hex, so nothing in it is read as SQL.
pub fn facts_sql(names: &[String], operators: &[String]) -> String {
    fn list(items: &[String]) -> String {
        let hex: Vec<String> = items.iter().map(|s| text_literal(s)).collect();
        format!("ARRAY[{}]::text[]", hex.join(", "))
    }
    format!(
        "WITH RECURSIVE \
        stepped AS MATERIALIZED (SELECT DISTINCT a.aggfnoid::oid AS oid FROM pg_aggregate a \
          CROSS JOIN LATERAL unnest(ARRAY[a.aggtransfn, a.aggfinalfn, a.aggcombinefn, \
            a.aggserialfn, a.aggdeserialfn, a.aggmtransfn, a.aggminvtransfn, \
            a.aggmfinalfn]::oid[]) AS step(oid) \
          JOIN pg_proc f ON f.oid = step.oid \
          JOIN pg_language fl ON fl.oid = f.prolang \
          WHERE NOT (fl.lanname IN ('c', 'internal') AND f.provolatile = 'i')), \
        code AS (SELECT p.oid FROM pg_proc p JOIN pg_namespace s ON s.oid = p.pronamespace \
          JOIN pg_language l ON l.oid = p.prolang \
          WHERE s.nspname NOT IN ('pg_catalog', 'information_schema') \
          AND NOT (l.lanname IN ('c', 'internal') AND p.provolatile = 'i' \
            AND p.oid NOT IN (SELECT oid FROM stepped))), \
        bad_ops AS (SELECT o.oid FROM pg_operator o WHERE o.oprcode IN (SELECT oid FROM code)), \
        built_on(child, parent) AS MATERIALIZED (\
          SELECT oid, typbasetype FROM pg_type WHERE typbasetype <> 0 \
          UNION ALL SELECT oid, typelem FROM pg_type WHERE typelem <> 0 \
          UNION ALL SELECT rngtypid, rngsubtype FROM pg_range \
          UNION ALL SELECT k.reltype, a.atttypid FROM pg_class k JOIN pg_attribute a \
            ON a.attrelid = k.oid AND a.attnum > 0 AND NOT a.attisdropped WHERE k.relkind = 'c'), \
        bad_types(oid) AS (SELECT t.oid FROM pg_type t JOIN (\
            SELECT k.castsource AS oid FROM pg_cast k WHERE k.castfunc IN (SELECT oid FROM code) \
            UNION SELECT k.casttarget FROM pg_cast k WHERE k.castfunc IN (SELECT oid FROM code) \
            UNION SELECT c.contypid FROM pg_constraint c JOIN pg_depend d \
              ON d.classid = 'pg_constraint'::regclass AND d.objid = c.oid \
              AND d.refclassid = 'pg_proc'::regclass \
              WHERE c.contypid <> 0 AND d.refobjid IN (SELECT oid FROM code)) x ON x.oid = t.oid \
          WHERE t.typnamespace <> 'pg_catalog'::regnamespace \
          UNION \
          SELECT e.child FROM built_on e JOIN bad_types b ON b.oid = e.parent), \
        tainted(oid) AS (\
          SELECT r.ev_class FROM pg_rewrite r JOIN pg_class v ON v.oid = r.ev_class AND v.relkind = 'v' \
          JOIN pg_depend d ON d.classid = 'pg_rewrite'::regclass AND d.objid = r.oid \
          WHERE (d.refclassid = 'pg_proc'::regclass AND d.refobjid IN (SELECT oid FROM code)) \
          OR (d.refclassid = 'pg_operator'::regclass AND d.refobjid IN (SELECT oid FROM bad_ops)) \
          OR (d.refclassid = 'pg_type'::regclass AND d.refobjid IN (SELECT oid FROM bad_types)) \
          UNION \
          SELECT r.ev_class FROM pg_rewrite r JOIN pg_class v ON v.oid = r.ev_class AND v.relkind = 'v' \
          JOIN pg_depend d ON d.classid = 'pg_rewrite'::regclass AND d.objid = r.oid \
          JOIN tainted t ON d.refclassid = 'pg_class'::regclass AND d.refobjid = t.oid) \
        SELECT 'f', s.nspname::text, p.proname::text, p.provolatile::text, \
          (l.lanname IN ('c', 'internal') AND p.provolatile = 'i' \
            AND p.oid NOT IN (SELECT oid FROM stepped))::text, p.pronargs::text \
          FROM pg_proc p JOIN pg_namespace s ON s.oid = p.pronamespace JOIN pg_language l ON l.oid = p.prolang \
          WHERE p.proname::text = ANY ({names}) \
        UNION ALL SELECT 'o', s.nspname::text, o.oprname::text, '', '', '' \
          FROM pg_operator o JOIN pg_namespace s ON s.oid = o.oprnamespace \
          WHERE o.oid IN (SELECT oid FROM bad_ops) AND o.oprname::text = ANY ({ops}) \
        UNION ALL SELECT 'v', s.nspname::text, c.relname::text, '', '', '' \
          FROM pg_class c JOIN pg_namespace s ON s.oid = c.relnamespace \
          WHERE c.oid IN (SELECT oid FROM tainted) AND c.relname::text = ANY ({names}) \
        UNION ALL SELECT 't', s.nspname::text, t.typname::text, '', '', '' \
          FROM pg_type t JOIN pg_namespace s ON s.oid = t.typnamespace \
          WHERE t.oid IN (SELECT oid FROM bad_types) AND t.typname::text = ANY ({names})",
        names = list(names),
        ops = list(operators),
    )
}

/// `text` as a SQL text value, written in hex so nothing in it is read as SQL.
pub fn text_literal(text: &str) -> String {
    let h: String = text.bytes().map(|b| format!("{b:02x}")).collect();
    format!("convert_from(decode('{h}', 'hex'), 'UTF8')")
}

/// [`Facts`] from the rows of [`facts_sql`], each five or six text cells.
pub fn facts_from_rows(rows: &[Vec<String>]) -> Facts {
    let mut f = Facts::default();
    for r in rows {
        let cell = |i: usize| r.get(i).cloned().unwrap_or_default();
        let pair = (cell(1), cell(2));
        match cell(0).as_str() {
            "f" => f.functions.push(Function {
                schema: pair.0,
                name: pair.1,
                volatility: cell(3).chars().next().unwrap_or('v'),
                compiled: cell(4) == "true",
                args: cell(5).parse().unwrap_or(0),
            }),
            "o" => f.operators.push(pair),
            "v" => f.views.push(pair),
            "t" => f.types.push(pair),
            _ => {}
        }
    }
    f
}

/// Built-ins that aren't IMMUTABLE but only compute on their arguments, the
/// clock or the catalog's descriptions. Every overload of each name is safe.
#[rustfmt::skip]
pub const ALLOWED: &[&str] = &[
    // Dates and times (stable through the session's time zone).
    "age", "clock_timestamp", "date", "date_add", "date_part", "date_subtract", "date_trunc",
    "extract", "isfinite", "make_timestamptz", "now", "overlaps", "statement_timestamp", "time",
    "timeofday", "timestamp", "timestamptz", "timetz", "timezone", "to_char", "to_date",
    "to_number", "to_timestamp", "transaction_timestamp", "generate_series",
    // Text, numbers, arrays.
    "anytextcat", "textanycat", "concat", "concat_ws", "convert", "convert_from", "convert_to",
    "format", "length", "money", "numeric", "quote_literal", "quote_nullable", "random",
    "random_normal", "gen_random_uuid", "array_to_string", "array_sample", "array_shuffle",
    // JSON.
    "array_to_json", "json_agg", "json_agg_strict", "json_build_array", "json_build_object",
    "json_object_agg", "json_object_agg_strict", "json_object_agg_unique",
    "json_object_agg_unique_strict", "json_populate_record", "json_populate_recordset",
    "json_to_record", "json_to_recordset", "json_to_tsvector", "jsonb_agg", "jsonb_agg_strict",
    "jsonb_build_array", "jsonb_build_object", "jsonb_path_exists_tz", "jsonb_path_match_tz",
    "jsonb_path_query_array_tz", "jsonb_path_query_first_tz", "jsonb_path_query_tz",
    "jsonb_populate_record", "jsonb_populate_recordset", "jsonb_to_record", "jsonb_to_recordset",
    "jsonb_to_tsvector", "row_to_json", "to_json", "to_jsonb",
    // Text search (ts_rewrite and ts_stat run SQL text and are refused).
    "phraseto_tsquery", "plainto_tsquery", "to_tsquery", "to_tsvector", "websearch_to_tsquery",
    "ts_headline", "ts_match_tq", "ts_match_tt", "get_current_ts_config",
    // XML values (not the *_to_xml functions, which run queries).
    "xml", "xml_is_well_formed",
    // Enums; TABLESAMPLE's methods.
    "enum_first", "enum_last", "enum_range", "system", "bernoulli",
    // Who and where, and what the system views that describe tables call
    // (information_schema, pg_tables, pg_views, pg_indexes).
    "current_database", "current_schema", "current_schemas", "current_user", "session_user",
    "version", "pg_typeof", "pg_collation_for", "format_type", "pg_get_userbyid", "pg_get_expr",
    "pg_get_constraintdef", "pg_get_indexdef", "pg_get_viewdef", "pg_get_triggerdef",
    "pg_get_ruledef", "pg_get_partkeydef", "pg_get_serial_sequence", "pg_get_function_arguments",
    "pg_get_function_identity_arguments", "pg_get_function_result", "pg_get_function_arg_default",
    "pg_get_statisticsobjdef", "obj_description", "col_description", "shobj_description",
    "pg_has_role", "has_any_column_privilege", "has_column_privilege", "has_database_privilege",
    "has_foreign_data_wrapper_privilege", "has_function_privilege", "has_language_privilege",
    "has_schema_privilege", "has_sequence_privilege", "has_server_privilege",
    "has_table_privilege", "has_tablespace_privilege", "has_type_privilege", "aclexplode",
    "pg_table_is_visible", "pg_type_is_visible", "pg_function_is_visible",
    "pg_is_other_temp_schema", "pg_my_temp_schema", "pg_options_to_table",
    "pg_column_is_updatable", "pg_relation_is_updatable", "pg_relation_size", "pg_table_size",
    "pg_indexes_size", "pg_total_relation_size", "pg_column_size", "pg_encoding_to_char",
    "pg_char_to_encoding", "getdatabaseencoding", "pg_client_encoding", "row_security_active",
    "pg_is_in_recovery", "pg_get_keywords",
];

/// Functions refused by name, built in or not, whatever their volatility,
/// and why.
pub fn refused_builtin(name: &str) -> Option<&'static str> {
    const TEXT: &str = "runs a query given as text, which can read tables the plan never shows";
    const NET: &str = "reaches other hosts from the database server";
    const FILES: &str = "reads or writes files on the database server";
    const STATE: &str = "changes the server's or the session's state";
    const SLEEP: &str = "only waits, holding the agent's session";
    let has = |prefixes: &[&str]| prefixes.iter().any(|p| name.starts_with(p));
    Some(
        if matches!(name, "ts_rewrite" | "ts_stat" | "connectby" | "xpath_table")
            || name.contains("_to_xml")
            || has(&["crosstab", "dblink"])
        {
            TEXT
        } else if has(&["http"]) {
            NET
        } else if matches!(
            name,
            "pg_read_file"
                | "pg_read_binary_file"
                | "pg_stat_file"
                | "pg_current_logfile"
                | "loread"
                | "lowrite"
        ) || has(&["pg_ls_", "pg_file_", "lo_"])
        {
            FILES
        } else if matches!(
            name,
            "pg_terminate_backend"
                | "pg_cancel_backend"
                | "pg_reload_conf"
                | "pg_rotate_logfile"
                | "pg_switch_wal"
                | "pg_promote"
                | "pg_log_backend_memory_contexts"
                | "pg_drop_replication_slot"
                | "pg_import_system_collations"
                | "pg_notify"
                | "set_config"
                | "setseed"
                | "nextval"
                | "setval"
                | "txid_current"
                | "pg_current_xact_id"
        ) || has(&[
            "pg_advisory_",
            "pg_try_advisory_",
            "pg_create_",
            "pg_backup_",
            "pg_wal_replay_",
            "pg_replication_",
            "pg_logical_",
            "pg_stat_reset",
        ]) || name.ends_with("_reset")
        {
            STATE
        } else if has(&["pg_sleep"]) {
            SLEEP
        } else {
            return None;
        },
    )
}

/// Why calling `call` is refused, given what the catalog holds for its name.
pub fn call_refusal(call: &Call, facts: &Facts) -> Option<String> {
    let n = &call.name;
    if let Some(why) = refused_builtin(n) {
        return Some(format!(
            "Refused: {n}() {why}. Agents can call Postgres's built-in functions that only compute on their arguments. Leave it out of the query."
        ));
    }
    let named: Vec<&Function> = facts.functions.iter().filter(|f| &f.name == n).collect();
    let builtin: Vec<&Function> = match call.schema.as_deref() {
        Some("information_schema") => return None,
        Some("pg_catalog") => named
            .iter()
            .copied()
            .filter(|f| f.schema == "pg_catalog")
            .collect(),
        Some(schema) => {
            // Not a function at all when nothing by that name lives there
            // (Postgres says so itself).
            return named
                .iter()
                .any(|f| f.schema == schema)
                .then(|| defined_here(schema, n));
        }
        None => {
            let mine: Vec<&Function> = named.iter().copied().filter(|f| !core(&f.schema)).collect();
            let builtin: Vec<&Function> =
                named.iter().copied().filter(|f| core(&f.schema)).collect();
            if let Some(first) = mine.first() {
                if builtin.is_empty() {
                    return Some(defined_here(&first.schema, n));
                }
                if let Some(code) = mine.iter().find(|f| !f.compiled) {
                    return Some(format!(
                        "Refused: {n}() here may be {}.{n}(), which is defined in the database rather than built into Postgres. Write pg_catalog.{n}(…) for the built-in.",
                        code.schema
                    ));
                }
            }
            builtin
        }
    };
    if builtin.is_empty()
        || builtin.iter().all(|f| f.schema == "information_schema")
        || ALLOWED.contains(&n.as_str())
        || builtin.iter().all(|f| f.volatility == 'i')
    {
        return None;
    }
    Some(format!(
        "Refused: {n}() isn't one of the built-in functions agents can call: ones that only compute on their arguments, like count, sum, date_trunc, lower or jsonb_extract_path_text. Leave it out of the query."
    ))
}

fn defined_here(schema: &str, name: &str) -> String {
    format!(
        "Refused: {schema}.{name}() is defined in the database, not built into Postgres. What it runs never shows in the plan, so it could read tables that aren't shared. Agents can call only Postgres's built-in functions."
    )
}

/// Why a statement that names what `scan` holds is refused, if it is.
/// `before_plan` adds the checks for what the planner could evaluate before
/// the plan is read: a function called on a row (`t.f`) and `U&"…"` names.
pub fn refusal(scan: &Scan, facts: &Facts, before_plan: bool) -> Option<String> {
    if before_plan && scan.unicode_names {
        return Some(
            "Refused: names written with Unicode escapes (U&\"…\") can't be checked here. Write the name plainly."
                .into(),
        );
    }
    if let Some(why) = scan.calls.iter().find_map(|c| call_refusal(c, facts)) {
        return Some(why);
    }
    if before_plan {
        let on_row = scan.dotted.iter().find_map(|d| {
            facts
                .functions
                .iter()
                .find(|f| &f.name == d && !core(&f.schema) && !f.compiled && f.args >= 1)
        });
        if let Some(f) = on_row {
            return Some(defined_here(&f.schema, &f.name));
        }
    }
    if let Some((schema, op)) = facts
        .operators
        .iter()
        .find(|(_, op)| scan.operators.contains(op))
    {
        return Some(format!(
            "Refused: the operator {op} here may be {schema}.{op}, which calls a function defined in the database whose body isn't in the plan. Use a built-in operator or function instead."
        ));
    }
    let words: HashSet<&String> = scan.words.iter().collect();
    if let Some((schema, view)) = facts.views.iter().find(|(_, v)| words.contains(v)) {
        return Some(format!(
            "Refused: {schema}.{view} is a view that calls a function defined in the database, whose body isn't in the plan. Query the tables under it instead."
        ));
    }
    if let Some((schema, ty)) = facts.types.iter().find(|(_, t)| words.contains(t)) {
        return Some(format!(
            "Refused: casting to or checking {schema}.{ty} runs a function defined in the database, whose body isn't in the plan. Leave it out of the query."
        ));
    }
    None
}

/// Refused when `scan` names a function, operator, view or type the
/// allow-list doesn't cover, looked up in this database's catalog.
pub async fn check_pg(
    store: &mut Store,
    target: &Target,
    scan: &Scan,
    before_plan: bool,
) -> Result<(), String> {
    let (names, operators) = scan.lookups();
    let found = store.read(target, &facts_sql(&names, &operators)).await?;
    let rows: Vec<Vec<String>> = found
        .rows
        .iter()
        .map(|r| {
            r.iter()
                .map(|v| match v {
                    rowkery_core::Value::Text(t) => t.clone(),
                    _ => String::new(),
                })
                .collect()
        })
        .collect();
    match refusal(scan, &facts_from_rows(&rows), before_plan) {
        Some(why) => Err(why),
        None => Ok(()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn f(schema: &str, name: &str, volatility: char, compiled: bool) -> Function {
        Function {
            schema: schema.into(),
            name: name.into(),
            volatility,
            compiled,
            args: 1,
        }
    }

    /// A catalog like Postgres 16's, plus a database with its own code.
    fn facts() -> Facts {
        Facts {
            functions: vec![
                f("pg_catalog", "count", 'i', true),
                f("pg_catalog", "sum", 'i', true),
                f("pg_catalog", "lower", 'i', true),
                f("pg_catalog", "coalesce_like", 'i', true),
                f("pg_catalog", "string_agg", 'i', true),
                f("pg_catalog", "row_number", 'i', true),
                f("pg_catalog", "jsonb_extract_path_text", 'i', true),
                f("pg_catalog", "date_trunc", 'i', true),
                f("pg_catalog", "date_trunc", 's', true),
                f("pg_catalog", "now", 's', true),
                f("pg_catalog", "max", 'i', true),
                f("pg_catalog", "ts_rewrite", 'i', true),
                f("pg_catalog", "ts_rewrite", 'v', true),
                f("pg_catalog", "pg_backend_pid", 's', true),
                f("pg_catalog", "current_setting", 's', true),
                f("pg_catalog", "pg_sleep", 'v', true),
                f("pg_catalog", "pg_stat_get_activity", 'v', true),
                f("information_schema", "_pg_char_max_length", 'i', false),
                f("public", "crosstab", 's', false),
                f("public", "http_get", 'v', false),
                f("public", "pg_stat_statements_reset", 'v', false),
                f("public", "secret_count", 'i', false),
                f("public", "row_secret", 's', false),
                // citext's max: compiled, immutable.
                f("public", "max", 'i', true),
                f("app", "lower", 's', false),
            ],
            operators: vec![("public".into(), "===".into())],
            views: vec![("public".into(), "leaky_view".into())],
            types: vec![("public".into(), "checked_email".into())],
        }
    }

    fn check(sql: &str) -> Option<String> {
        refusal(&scan_sql(sql), &facts(), true)
    }

    #[test]
    fn analytics_pass() {
        for sql in [
            "SELECT count(*), sum(total) FROM orders",
            "SELECT date_trunc('day', created_at), count(*) FROM orders GROUP BY 1",
            "SELECT payload ->> 'kind', coalesce(note, '') FROM events",
            "SELECT string_agg(name, ', ') FROM users",
            "SELECT row_number() OVER (PARTITION BY a ORDER BY b) FROM t",
            "SELECT now() - interval '1 day', x::numeric(10, 2)",
            "SELECT pg_catalog.lower(name), max(id) FROM t",
            "SELECT information_schema._pg_char_max_length(1, 2)",
            "SELECT jsonb_extract_path_text(doc, 'a') FROM t",
            // Words in strings and comments aren't calls.
            "SELECT 'pg_read_file(x)', $$ts_rewrite($$ -- crosstab(\nFROM t",
            "SELECT nope_not_a_function(1)",
        ] {
            assert_eq!(check(sql), None, "{sql}");
        }
    }

    #[test]
    fn server_functions_and_sql_runners_are_refused() {
        for (sql, said) in [
            (
                "SELECT ts_rewrite('a'::tsquery, 'SELECT * FROM secrets')",
                "ts_rewrite() runs a query given as text",
            ),
            (
                "SELECT * FROM crosstab('select * from secrets') AS ct(a int)",
                "crosstab() runs a query",
            ),
            (
                "SELECT http_get('http://169.254.169.254/')",
                "reaches other hosts",
            ),
            ("SELECT pg_stat_statements_reset()", "changes the server"),
            (
                "SELECT query_to_xml('select 1', true, false, '')",
                "runs a query",
            ),
            ("SELECT pg_catalog.pg_read_file('/etc/hosts')", "files"),
            ("SELECT \"pg_advisory_lock\"(1)", "state"),
            ("SELECT pg_sleep(5)", "only waits"),
            ("SELECT nextval('s')", "state"),
            ("SELECT pg_backend_pid()", "isn't one of the built-in"),
            ("SELECT current_setting('x')", "isn't one of the built-in"),
            ("SELECT secret_count()", "public.secret_count() is defined"),
            ("SELECT app.lower('x')", "app.lower() is defined"),
            ("SELECT lower(x) FROM t", "may be app.lower()"),
            (
                "SELECT t.row_secret FROM t",
                "public.row_secret() is defined",
            ),
            ("SELECT 1 === 2", "operator ==="),
            ("SELECT * FROM leaky_view", "public.leaky_view is a view"),
            ("SELECT 'a'::checked_email", "public.checked_email runs"),
            ("SELECT U&\"\\0074s_rewrite\"('a', 'b')", "Unicode"),
        ] {
            let why = check(sql).unwrap_or_else(|| panic!("{sql} passed"));
            assert!(
                why.starts_with("Refused") && why.contains(said),
                "{sql}: {why}"
            );
        }
        // A citext-like compiled max next to the built-in passes, and a
        // schema that defines nothing by that name isn't a function at all.
        assert_eq!(check("SELECT max(email) FROM users"), None);
        assert_eq!(check("SELECT public.lower('x')"), None);
    }

    #[test]
    fn hiding_a_call_from_the_scan_does_not_work() {
        for sql in [
            "SELECT ts_rewrite /* x */ ('a', 'b')",
            "SELECT pg_catalog . ts_rewrite\n('a', 'b')",
            "SELECT TS_REWRITE('a', 'b')",
            // With standard_conforming_strings off, \' doesn't end the string.
            "SELECT 'a\\' , secret_count() --'",
            // An escape string the other way.
            "SELECT E'\\'', secret_count() --'",
        ] {
            assert!(check(sql).is_some(), "{sql} passed");
        }
        // A real nested comment hides nothing it shouldn't: this one is all comment.
        assert_eq!(check("SELECT 1 /* a /* b */ secret_count() */"), None);
    }

    #[test]
    fn plans_are_read_with_schemas() {
        // Shapes from Postgres 16's EXPLAIN (FORMAT JSON, VERBOSE).
        let plan = json!([{ "Plan": {
            "Node Type": "Limit",
            "Output": ["'x'::text", "(lower((oid)::text))"],
            "Plans": [{
                "Node Type": "Function Scan",
                "Function Name": "crosstab",
                "Schema": "public",
                "Alias": "ct",
                "Function Call": "crosstab('select 1'::text)"
            }, {
                "Node Type": "Seq Scan",
                "Relation Name": "ts_rewrite(",
                "Filter": "(o.note <> 'call pg_read_file(x) later'::text)",
                "Output": ["pg_catalog.pg_read_file('/etc/hosts'::text)", "(x)::numeric(10,2)"]
            }]
        }}]);
        let s = scan_plan(&plan);
        assert!(s.calls.contains(&Call {
            schema: Some("public".into()),
            name: "crosstab".into()
        }));
        assert!(s.calls.contains(&Call {
            schema: Some("pg_catalog".into()),
            name: "pg_read_file".into()
        }));
        assert!(s.calls.iter().any(|c| c.name == "lower"));
        // Names of relations and string literals aren't calls; nor is a typmod.
        for name in ["ts_rewrite", "numeric"] {
            assert!(!s.call_names().contains(&name.to_string()), "{name}");
        }
        assert!(refusal(&s, &facts(), false).is_some());
        let ordinary = json!([{ "Plan": {
            "Node Type": "Aggregate",
            "Output": ["count(*)", "date_trunc('day'::text, o.created_at)", "(o.doc ->> 'k'::text)"],
            "Plans": [{ "Node Type": "Seq Scan", "Relation Name": "lo_orders", "Output": ["o.id"] }]
        }}]);
        assert_eq!(refusal(&scan_plan(&ordinary), &facts(), false), None);
    }

    #[test]
    fn operators_follow_postgres_rules() {
        let s = scan_sql("SELECT a=-1, b->>'k', c @> d, e<=f");
        for op in ["=", "-", "->>", "@>", "<="] {
            assert!(
                s.operators.contains(&op.to_string()),
                "{op}: {:?}",
                s.operators
            );
        }
    }

    #[test]
    fn every_allowed_name_is_safe() {
        for name in ALLOWED {
            assert!(
                refused_builtin(name).is_none(),
                "{name} is both allowed and refused"
            );
        }
        for name in ["now", "date_trunc", "to_char", "generate_series", "format"] {
            assert!(ALLOWED.contains(&name), "{name}");
        }
    }

    #[test]
    fn facts_query_hides_its_input() {
        let sql = facts_sql(&["x'); DROP TABLE t; --".into()], &[]);
        assert!(!sql.contains("DROP"));
        assert!(sql.contains("ARRAY[]::text[]"));
        let f = facts_from_rows(&[
            vec!["f", "public", "g", "s", "false", "2"]
                .into_iter()
                .map(String::from)
                .collect(),
            vec!["v", "public", "w", "", "", ""]
                .into_iter()
                .map(String::from)
                .collect(),
        ]);
        assert_eq!(f.functions[0].volatility, 's');
        assert_eq!(f.functions[0].args, 2);
        assert_eq!(f.views, vec![("public".to_string(), "w".to_string())]);
    }
}
