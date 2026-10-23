//! Sensitive columns. The user marks a column once (`masked_columns` on the
//! connection); agents then only ever get a stand-in for its values
//! (`masked:` and ten hex digits of an HMAC under the connection's own key),
//! the same value always giving the same stand-in.
//!
//! A stand-in is only worth something if the value can't be read some other
//! way, and filtering is a way: `WHERE email LIKE 'a%'`, then `'ab%'`, reads
//! it a character per call. So a marked column may only be returned as it is
//! (masked on the way out) or counted. Postgres's own VERBOSE plan is the
//! source of truth: views are already expanded, so every use of the column
//! appears in it, deparsed. Anything the check can't follow (a subquery or
//! WITH query that renames it, a whole-row value) is refused, not guessed.

use std::collections::{HashMap, HashSet};

use rowkery_core::Value;
use serde_json::Value as Json;

/// One marked column.
#[derive(Clone, Debug, PartialEq)]
pub struct Marked {
    pub schema: String,
    pub table: String,
    pub column: String,
}

impl Marked {
    pub fn label(&self) -> String {
        format!("{}.{}", self.table, self.column)
    }
}

/// `schema.table.column` entries as saved; anything else is skipped.
pub fn parse(list: &[String]) -> Vec<Marked> {
    list.iter()
        .filter_map(|entry| {
            let (schema, rest) = entry.split_once('.')?;
            let (table, column) = rest.rsplit_once('.')?;
            (!schema.is_empty() && !table.is_empty() && !column.is_empty()).then(|| Marked {
                schema: schema.to_string(),
                table: table.to_string(),
                column: column.to_string(),
            })
        })
        .collect()
}

/// What an agent gets in place of a sensitive value. NULL stays NULL.
pub fn stand_in(key: &[u8], value: &Value) -> Json {
    use hmac::{Hmac, Mac};
    let text = match value {
        Value::Null => return Json::Null,
        Value::Bool(b) => b.to_string(),
        Value::Int(n) => n.to_string(),
        Value::Float(f) => f.to_string(),
        Value::Text(s) => s.clone(),
        Value::Bytes(b) => String::from_utf8_lossy(b).into_owned(),
    };
    let Ok(mut mac) = Hmac::<sha2::Sha256>::new_from_slice(key) else {
        return Json::Null;
    };
    mac.update(text.as_bytes());
    let digest = mac.finalize().into_bytes();
    let hex: String = digest.iter().take(5).map(|b| format!("{b:02x}")).collect();
    Json::String(format!("masked:{hex}"))
}

pub const SUBQUERY_REFUSAL: &str = "Refused: a masked column can only be returned from the main SELECT, not out of a subquery, WITH query, INTERSECT or EXCEPT. Select it from its table directly.";

pub fn use_refusal(label: &str) -> String {
    format!(
        "Refused: {label} is masked. You can return it as it is or count it, but not filter, sort, group or join on it, or use it in an expression."
    )
}

pub fn index_refusal(index: &str) -> String {
    format!(
        "Refused: the plan walks {index}, an index on a masked column, which would give away the order of its values. Filter or sort on another column."
    )
}

pub fn missing_refusal(table: &str, column: &str) -> String {
    format!(
        "Refused: {table} has a masked column ({column}) that is no longer in the table. Ask the user to check the table's masked columns in Rowkery."
    )
}

/// A deparsed expression as tokens: names (dotted chains, `c.*` included),
/// punctuation, and everything else (literals, numbers, `$1`).
#[derive(Debug, PartialEq)]
pub(crate) enum Tok {
    Name(Vec<String>),
    Punct(char),
    Other,
}

fn ident_at(b: &[u8], expr: &str, i: &mut usize) -> Option<String> {
    let c = *b.get(*i)?;
    if c == b'"' {
        let mut out = String::new();
        let mut j = *i + 1;
        let mut start = j;
        while j < b.len() {
            if b[j] == b'"' {
                out.push_str(&expr[start..j]);
                if b.get(j + 1) == Some(&b'"') {
                    out.push('"');
                    j += 2;
                    start = j;
                    continue;
                }
                break;
            }
            j += 1;
        }
        if j >= b.len() {
            out.push_str(&expr[start.min(b.len())..]);
        }
        *i = (j + 1).min(b.len());
        Some(out)
    } else if c.is_ascii_alphabetic() || c == b'_' || c >= 0x80 {
        let start = *i;
        while *i < b.len()
            && (b[*i].is_ascii_alphanumeric() || matches!(b[*i], b'_' | b'$') || b[*i] >= 0x80)
        {
            *i += 1;
        }
        Some(expr[start..*i].to_lowercase())
    } else {
        None
    }
}

pub(crate) fn tokens(expr: &str) -> Vec<Tok> {
    let b = expr.as_bytes();
    let mut out = Vec::new();
    let mut i = 0;
    while i < b.len() {
        let c = b[i];
        if c.is_ascii_whitespace() {
            i += 1;
        } else if c == b'\'' {
            // Deparsed literals double their quotes ('it''s').
            i += 1;
            while i < b.len() {
                if b[i] == b'\'' {
                    if b.get(i + 1) == Some(&b'\'') {
                        i += 2;
                        continue;
                    }
                    break;
                }
                i += 1;
            }
            i += 1;
            out.push(Tok::Other);
        } else if let Some(first) = ident_at(b, expr, &mut i) {
            let mut chain = vec![first];
            while b.get(i) == Some(&b'.') {
                let mut j = i + 1;
                if b.get(j) == Some(&b'*') {
                    chain.push("*".into());
                    i = j + 1;
                    break;
                }
                match ident_at(b, expr, &mut j) {
                    Some(next) => {
                        chain.push(next);
                        i = j;
                    }
                    None => break,
                }
            }
            out.push(Tok::Name(chain));
        } else if c.is_ascii_digit() || c == b'$' {
            while i < b.len()
                && (b[i].is_ascii_alphanumeric() || matches!(b[i], b'.' | b'$' | b'_'))
            {
                i += 1;
            }
            out.push(Tok::Other);
        } else {
            out.push(Tok::Punct(c as char));
            i += 1;
        }
    }
    out
}

/// The marked columns of a relation as a plan names it (schema, relation),
/// and whether that relation is a partition.
pub type MarkedOf<'a> = &'a dyn Fn(Option<&str>, &str) -> (Vec<String>, bool);

/// What the Postgres check needs to know beyond the plan.
pub struct PgFacts<'a> {
    /// The marked columns of a relation as the plan names it (a partition
    /// answers for its parent), and whether it is a partition.
    pub marked_of: MarkedOf<'a>,
    /// Indexes on marked tables that cover a marked column (by name).
    pub marked_indexes: &'a HashSet<String>,
    /// The alias of the row-cap wrapper (`guard::wrap_limit`) for this call.
    pub wrapper: &'a str,
}

/// Plan keys that name things rather than hold expressions.
const NAME_KEYS: &[&str] = &[
    "Node Type",
    "Parent Relationship",
    "Relation Name",
    "Schema",
    "Alias",
    "Index Name",
    "CTE Name",
    "Subplan Name",
    "Strategy",
    "Partial Mode",
    "Join Type",
    "Scan Direction",
    "Command",
    "Operation",
    "Function Name",
    "Sort Method",
    "Sort Space Type",
];

struct Taint {
    /// Name chains (`c.email`, bare `email`) → the column they stand for.
    names: HashMap<Vec<String>, String>,
    /// Aliases of scans with marked columns, for whole-row values (`c.*`).
    rows: HashMap<String, String>,
}

impl Taint {
    fn hit(&self, chain: &[String]) -> Option<&String> {
        self.names.get(chain)
    }

    fn whole_row(&self, chain: &[String]) -> Option<&String> {
        match chain {
            [alias, star] if star == "*" => self.rows.get(alias),
            _ => None,
        }
    }

    /// Whether a deparsed expression mentions a marked column in any way.
    fn mentions(&self, expr: &str) -> bool {
        tokens(expr).iter().any(|t| match t {
            Tok::Name(chain) => self.hit(chain).is_some() || self.whole_row(chain).is_some(),
            _ => false,
        })
    }

    /// The chain an Output entry is when it is just one name.
    fn bare(expr: &str) -> Option<Vec<String>> {
        match tokens(expr).as_slice() {
            [Tok::Name(chain)] => Some(chain.clone()),
            _ => None,
        }
    }
}

fn children(node: &Json) -> &[Json] {
    node.get("Plans")
        .and_then(Json::as_array)
        .map(Vec::as_slice)
        .unwrap_or(&[])
}

fn outputs(node: &Json) -> Vec<&str> {
    node.get("Output")
        .and_then(Json::as_array)
        .map(|list| list.iter().filter_map(Json::as_str).collect())
        .unwrap_or_default()
}

fn text<'a>(node: &'a Json, key: &str) -> Option<&'a str> {
    node.get(key).and_then(Json::as_str)
}

fn collect_scans(node: &Json, facts: &PgFacts, taint: &mut Taint) -> Result<(), String> {
    if let Some(rel) = text(node, "Relation Name") {
        let (columns, partition) = (facts.marked_of)(text(node, "Schema"), rel);
        if !columns.is_empty() {
            if let Some(index) = text(node, "Index Name") {
                if facts.marked_indexes.contains(index) {
                    return Err(index_refusal(index));
                }
            }
            let alias = text(node, "Alias").unwrap_or(rel).to_string();
            let mut aliases = vec![alias.clone()];
            // The parent of an appended partition is named by the alias
            // without the `_1`, `_2` Postgres adds per partition.
            if partition {
                if let Some((base, n)) = alias.rsplit_once('_') {
                    if !n.is_empty() && n.bytes().all(|b| b.is_ascii_digit()) {
                        aliases.push(base.to_string());
                    }
                }
            }
            let table = text(node, "Relation Name").unwrap_or(rel);
            for column in &columns {
                let label = format!("{table}.{column}");
                taint
                    .names
                    .entry(vec![column.clone()])
                    .or_insert(label.clone());
                for a in &aliases {
                    taint
                        .names
                        .insert(vec![a.clone(), column.clone()], label.clone());
                }
            }
            for a in aliases {
                taint.rows.insert(a, table.to_string());
            }
        }
    }
    for child in children(node) {
        collect_scans(child, facts, taint)?;
    }
    Ok(())
}

/// Names that stand for a marked column higher up: the first branch's names
/// of a UNION ALL (Append) whose other branches return one at the same
/// place, and the row-cap wrapper's own names.
fn propagate(node: &Json, facts: &PgFacts, taint: &mut Taint) {
    for child in children(node) {
        propagate(child, facts, taint);
    }
    let kind = text(node, "Node Type").unwrap_or("");
    let positional = |taint: &Taint, list: &[&str], i: usize| {
        list.get(i)
            .and_then(|e| Taint::bare(e))
            .and_then(|chain| taint.hit(&chain).cloned())
    };
    if matches!(kind, "Append" | "Merge Append") {
        let branches: Vec<Vec<&str>> = children(node).iter().map(outputs).collect();
        let Some(first) = branches.first() else {
            return;
        };
        for (i, entry) in first.iter().enumerate() {
            let label = branches.iter().find_map(|b| positional(taint, b, i));
            if let (Some(label), Some(chain)) = (label, Taint::bare(entry)) {
                taint.names.entry(chain).or_insert(label);
            }
        }
    }
    if kind == "Subquery Scan" && text(node, "Alias") == Some(facts.wrapper) {
        let inner = children(node).first().map(outputs).unwrap_or_default();
        for (i, entry) in outputs(node).iter().enumerate() {
            if let (Some(label), Some(chain)) = (positional(taint, &inner, i), Taint::bare(entry)) {
                taint.names.entry(chain).or_insert(label);
            }
        }
    }
}

fn check_expr(expr: &str, output: bool, sort_ok: bool, taint: &Taint) -> Result<(), String> {
    let toks = tokens(expr);
    for (i, tok) in toks.iter().enumerate() {
        let Tok::Name(chain) = tok else { continue };
        if let Some(table) = taint.whole_row(chain) {
            return Err(format!(
                "Refused: a whole-row value of {table} would carry its masked columns. Name the columns you need instead."
            ));
        }
        let Some(label) = taint.hit(chain) else {
            continue;
        };
        if output && toks.len() == 1 {
            continue;
        }
        // count(x) and count(DISTINCT x) say nothing about any one value.
        let closes = toks.get(i + 1) == Some(&Tok::Punct(')'));
        let open = |j: usize| {
            j >= 2
                && toks[j - 1] == Tok::Punct('(')
                && toks[j - 2] == Tok::Name(vec!["count".into()])
        };
        let counted = closes
            && (open(i)
                || (i >= 1 && toks[i - 1] == Tok::Name(vec!["distinct".into()]) && open(i - 1)));
        if counted || sort_ok {
            continue;
        }
        return Err(use_refusal(label));
    }
    Ok(())
}

fn check(node: &Json, parent: Option<&Json>, facts: &PgFacts, taint: &Taint) -> Result<(), String> {
    let relation = text(node, "Parent Relationship").unwrap_or("");
    let under_wrapper = parent.is_some_and(|p| {
        text(p, "Node Type") == Some("Subquery Scan") && text(p, "Alias") == Some(facts.wrapper)
    });
    if matches!(relation, "InitPlan" | "SubPlan" | "Subquery")
        && !under_wrapper
        && outputs(node).iter().any(|e| taint.mentions(e))
    {
        return Err(SUBQUERY_REFUSAL.into());
    }
    // A DISTINCT aggregate sorts its input first; only the count leaves.
    let sort_ok = text(node, "Node Type") == Some("Sort")
        && parent.is_some_and(|p| text(p, "Node Type") == Some("Aggregate"));
    if let Some(map) = node.as_object() {
        for (key, value) in map {
            if key == "Plans" || NAME_KEYS.contains(&key.as_str()) {
                continue;
            }
            let output = key == "Output";
            let sort_key = sort_ok && matches!(key.as_str(), "Sort Key" | "Presorted Key");
            let mut strings: Vec<&str> = Vec::new();
            match value {
                Json::String(s) => strings.push(s),
                Json::Array(items) => strings.extend(items.iter().filter_map(Json::as_str)),
                _ => {}
            }
            for s in strings {
                check_expr(s, output, sort_key, taint)?;
            }
        }
    }
    for child in children(node) {
        check(child, Some(node), facts, taint)?;
    }
    Ok(())
}

/// Checks a Postgres plan (`EXPLAIN (FORMAT JSON, VERBOSE)`) against the
/// marked columns: Ok with the result columns to mask, or why it's refused.
pub fn pg_check(explain_json: &Json, facts: &PgFacts) -> Result<Vec<usize>, String> {
    let root = explain_json
        .get(0)
        .and_then(|p| p.get("Plan"))
        .unwrap_or(explain_json);
    let mut taint = Taint {
        names: HashMap::new(),
        rows: HashMap::new(),
    };
    collect_scans(root, facts, &mut taint)?;
    if taint.names.is_empty() {
        return Ok(Vec::new());
    }
    propagate(root, facts, &mut taint);
    check(root, None, facts, &taint)?;
    Ok(outputs(root)
        .iter()
        .enumerate()
        .filter(|(_, e)| Taint::bare(e).is_some_and(|c| taint.hit(&c).is_some()))
        .map(|(i, _)| i)
        .collect())
}

/// Whether an index definition (`pg_get_indexdef`) covers `column`: in its
/// key, an expression, INCLUDE or its WHERE.
pub fn index_covers(definition: &str, column: &str) -> bool {
    let body = definition
        .split_once(" USING ")
        .map(|(_, b)| b)
        .unwrap_or(definition);
    tokens(body).iter().any(|t| match t {
        Tok::Name(chain) => chain.last().is_some_and(|c| c == column),
        _ => false,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn facts_for<'a>(marked_of: MarkedOf<'a>, indexes: &'a HashSet<String>) -> PgFacts<'a> {
        PgFacts {
            marked_of,
            marked_indexes: indexes,
            wrapper: "rowkery_q_1",
        }
    }

    fn customers(_: Option<&str>, rel: &str) -> (Vec<String>, bool) {
        match rel {
            "customers" => (vec!["email".into()], false),
            "ev_a" | "ev_b" => (vec!["email".into()], true),
            _ => (Vec::new(), false),
        }
    }

    fn scan(alias: &str, rel: &str, out: &[&str]) -> Json {
        json!({ "Node Type": "Seq Scan", "Relation Name": rel, "Schema": "public", "Alias": alias, "Output": out })
    }

    fn plan(root: Json) -> Json {
        json!([{ "Plan": root }])
    }

    fn run(root: Json) -> Result<Vec<usize>, String> {
        let idx = HashSet::from(["customers_email_idx".to_string()]);
        pg_check(&plan(root), &facts_for(&customers, &idx))
    }

    #[test]
    fn marks_parse_from_the_right() {
        let m = parse(&[
            "public.customers.email".into(),
            "bad".into(),
            "main.a.b.c".into(),
        ]);
        assert_eq!(m.len(), 2);
        assert_eq!(m[0].label(), "customers.email");
        assert_eq!((m[1].table.as_str(), m[1].column.as_str()), ("a.b", "c"));
    }

    #[test]
    fn stand_ins_are_stable_keyed_and_keep_null() {
        let a = stand_in(b"k1", &Value::Text("mara@x.se".into()));
        assert_eq!(a, stand_in(b"k1", &Value::Text("mara@x.se".into())));
        assert_ne!(a, stand_in(b"k2", &Value::Text("mara@x.se".into())));
        assert_ne!(a, stand_in(b"k1", &Value::Text("tomas@x.es".into())));
        assert!(a.as_str().unwrap().starts_with("masked:"));
        assert_eq!(a.as_str().unwrap().len(), "masked:".len() + 10);
        assert_eq!(stand_in(b"k1", &Value::Null), Json::Null);
    }

    #[test]
    fn tokens_handle_quotes_literals_and_stars() {
        assert_eq!(
            tokens(r#"lower("Cu"".x".email) = 'it''s c.email'"#),
            vec![
                Tok::Name(vec!["lower".into()]),
                Tok::Punct('('),
                Tok::Name(vec!["Cu\".x".into(), "email".into()]),
                Tok::Punct(')'),
                Tok::Punct('='),
                Tok::Other,
            ]
        );
        assert_eq!(tokens("c.*"), vec![Tok::Name(vec!["c".into(), "*".into()])]);
    }

    #[test]
    fn a_plain_column_is_masked_where_it_lands() {
        let root = json!({ "Node Type": "Limit", "Output": ["c.id", "c.email"],
            "Plans": [scan("c", "customers", &["c.id", "c.email"])] });
        assert_eq!(run(root), Ok(vec![1]));
        let bare = json!({ "Node Type": "Limit", "Output": ["email"],
            "Plans": [scan("customers", "customers", &["email"])] });
        assert_eq!(run(bare), Ok(vec![0]));
    }

    #[test]
    fn uses_other_than_returning_are_refused() {
        for (key, value) in [
            ("Filter", json!("(c.email ~~ 'a%'::text)")),
            ("Sort Key", json!(["c.email"])),
            ("Group Key", json!(["c.email"])),
            ("Hash Cond", json!("(c.email = o.email)")),
            ("Output", json!(["lower(c.email)"])),
            ("Output", json!(["(c.email)::integer"])),
            ("Output", json!(["min(c.email)"])),
            (
                "Output",
                json!(["count(c.email) FILTER (WHERE (c.email ~~ 'a%'::text))"]),
            ),
        ] {
            let mut node = json!({ "Node Type": "Hash Join", "Plans": [scan("c", "customers", &["c.email"])] });
            node[key] = value.clone();
            let err = run(node).expect_err(&value.to_string());
            assert!(err.contains("customers.email is masked"), "{err}");
        }
    }

    #[test]
    fn counts_pass() {
        let root = json!({ "Node Type": "Limit", "Output": ["(count(DISTINCT customers.email))", "(count(customers.email))"],
            "Plans": [{ "Node Type": "Aggregate", "Output": ["count(DISTINCT customers.email)", "PARTIAL count(customers.email)"],
                "Plans": [{ "Node Type": "Sort", "Output": ["customers.email"], "Sort Key": ["customers.email"],
                    "Plans": [scan("customers", "customers", &["customers.email"])] }] }] });
        assert_eq!(run(root), Ok(vec![]));
    }

    #[test]
    fn whole_rows_subqueries_and_marked_indexes_are_refused() {
        let whole = json!({ "Node Type": "Limit", "Output": ["row_to_json(c.*)"],
            "Plans": [scan("c", "customers", &["c.*"])] });
        assert!(run(whole).unwrap_err().contains("whole-row"));
        let init = json!({ "Node Type": "Limit", "Output": ["($0)"], "Plans": [
            { "Node Type": "Limit", "Parent Relationship": "InitPlan", "Output": ["customers.email"],
              "Plans": [scan("customers", "customers", &["customers.email"])] }] });
        assert_eq!(run(init), Err(SUBQUERY_REFUSAL.into()));
        let indexed = json!({ "Node Type": "Index Only Scan", "Index Name": "customers_email_idx",
            "Relation Name": "customers", "Alias": "customers", "Output": ["email"] });
        assert!(run(indexed).unwrap_err().contains("customers_email_idx"));
    }

    #[test]
    fn union_branches_and_partitions_carry_the_mark_up() {
        // `select phone … union all select email …`: the parent names the
        // first branch's column, which holds emails at that place.
        let union = json!({ "Node Type": "Limit", "Output": ["customers.phone"], "Plans": [
            { "Node Type": "Append", "Plans": [
                scan("customers", "customers", &["customers.phone"]),
                scan("customers_1", "customers", &["customers_1.email"])] }] });
        assert_eq!(run(union), Ok(vec![0]));
        let parts = json!({ "Node Type": "Limit", "Output": ["e.email", "e.id"], "Plans": [
            { "Node Type": "Append", "Plans": [
                scan("e_1", "ev_a", &["e_1.email", "e_1.id"]),
                scan("e_2", "ev_b", &["e_2.email", "e_2.id"])] }] });
        assert_eq!(run(parts), Ok(vec![0]));
    }

    #[test]
    fn the_wrapper_maps_by_place_and_other_subqueries_refuse() {
        let wrapped = json!({ "Node Type": "Limit", "Output": ["rowkery_q_1.n", "rowkery_q_1.email"], "Plans": [
            { "Node Type": "Subquery Scan", "Alias": "rowkery_q_1", "Output": ["rowkery_q_1.n", "rowkery_q_1.email"], "Plans": [
                { "Node Type": "WindowAgg", "Parent Relationship": "Subquery", "Output": ["row_number() OVER (?)", "customers.email"],
                  "Plans": [scan("customers", "customers", &["customers.email"])] }] }] });
        assert_eq!(run(wrapped), Ok(vec![1]));
        let other = json!({ "Node Type": "Subquery Scan", "Alias": "s", "Output": ["s.e"], "Filter": "(s.e ~~ 'a%'::text)", "Plans": [
            { "Node Type": "Seq Scan", "Parent Relationship": "Subquery", "Relation Name": "customers", "Alias": "customers", "Output": ["customers.email"] }] });
        assert_eq!(run(other), Err(SUBQUERY_REFUSAL.into()));
    }

    #[test]
    fn plans_without_marked_tables_pass_untouched() {
        let root = json!({ "Node Type": "Limit", "Output": ["o.email"], "Filter": "(o.email ~~ 'a%')",
            "Plans": [scan("o", "orders", &["o.email"])] });
        assert_eq!(run(root), Ok(vec![]));
    }

    #[test]
    fn index_definitions_are_read_past_using() {
        assert!(index_covers(
            "CREATE INDEX x ON public.customers USING btree (email)",
            "email"
        ));
        assert!(index_covers(
            "CREATE INDEX x ON public.customers USING btree (lower(email))",
            "email"
        ));
        assert!(index_covers(
            "CREATE INDEX x ON public.customers USING btree (id) INCLUDE (email)",
            "email"
        ));
        assert!(!index_covers(
            "CREATE INDEX email ON public.email USING btree (id)",
            "email"
        ));
    }
}
