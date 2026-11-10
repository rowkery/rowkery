//! Whether the relations a statement reads are shared, judged with what
//! each is a partition or child table of, read from the server for every
//! statement (`pg_inherits`): a table made a moment ago, attached as a
//! partition, in another schema or a foreign table counts as part of its
//! parent all the same, with no catalog to go stale.
//!
//! A materialized view is judged with what it was built from too
//! ([`pg_copied`]): its plan names only the view, whose rows are a stored
//! copy of other tables'.

use std::collections::HashMap;

use rowkery_core::connections::ConnectionRecord;
use rowkery_core::db::{EngineKind, Value};
use serde_json::Value as Json;

use crate::access::Tables;
use crate::guard;
use crate::mask;
use crate::target::{Store, Target};

/// One table a relation is a partition or child table of.
#[derive(Clone, Debug, PartialEq)]
pub(crate) struct Link {
    pub schema: String,
    pub name: String,
    /// Reached through partitions only, so its rows are this relation's
    /// own; a child table made with `INHERITS` is a table of its own.
    pub partition: bool,
}

/// The tables above each relation a statement reads.
#[derive(Debug, Default)]
pub(crate) struct Above(HashMap<(String, String), Vec<Link>>);

/// Every table above the `touched` relations of a Postgres statement; none
/// on SQLite, which has no partitions.
pub(crate) async fn above(
    store: &mut Store,
    target: &Target,
    touched: &[(Option<String>, String)],
) -> Result<Above, String> {
    if !matches!(target.record, ConnectionRecord::Postgres(_)) {
        return Ok(Above::default());
    }
    let lit = |v: &str| {
        rowkery_core::query_util::sql_literal(EngineKind::Postgres, &Value::Text(v.to_string()))
    };
    let mut names: Vec<String> = touched
        .iter()
        .filter_map(|(s, t)| {
            Some(format!(
                "({}, {})",
                lit(s.as_deref().unwrap_or("public"))?,
                lit(t)?
            ))
        })
        .collect();
    names.sort();
    names.dedup();
    if names.is_empty() {
        return Ok(Above::default());
    }
    // UNION, not UNION ALL: a table under several parents is reached once
    // per parent, not once per path, and pg_inherits has no cycles, so the
    // walk ends at the top of every chain however deep.
    let sql = format!(
        "WITH RECURSIVE up(child, parent, part) AS ( \
           SELECT i.inhrelid, i.inhparent, c.relispartition FROM pg_catalog.pg_inherits i \
             JOIN pg_catalog.pg_class c ON c.oid = i.inhrelid \
             JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace \
             WHERE (n.nspname::text, c.relname::text) IN (VALUES {}) \
           UNION SELECT up.child, i.inhparent, up.part AND p.relispartition \
             FROM up JOIN pg_catalog.pg_inherits i ON i.inhrelid = up.parent \
             JOIN pg_catalog.pg_class p ON p.oid = up.parent) \
         SELECT cn.nspname::text, c.relname::text, pn.nspname::text, p.relname::text, up.part::text \
           FROM up JOIN pg_catalog.pg_class c ON c.oid = up.child \
           JOIN pg_catalog.pg_namespace cn ON cn.oid = c.relnamespace \
           JOIN pg_catalog.pg_class p ON p.oid = up.parent \
           JOIN pg_catalog.pg_namespace pn ON pn.oid = p.relnamespace",
        names.join(", ")
    );
    let text = |v: Option<&Value>| match v {
        Some(Value::Text(t)) => t.clone(),
        _ => String::new(),
    };
    let mut found: HashMap<(String, String), Vec<Link>> = HashMap::new();
    for row in store.read(target, &sql).await?.rows {
        let link = Link {
            schema: text(row.get(2)),
            name: text(row.get(3)),
            partition: text(row.get(4)) == "true",
        };
        let list = found
            .entry((text(row.first()), text(row.get(1))))
            .or_default();
        if !list.contains(&link) {
            list.push(link);
        }
    }
    Ok(Above(found))
}

impl Above {
    /// The tables above `schema.rel`.
    pub fn of(&self, schema: &str, rel: &str) -> &[Link] {
        self.0
            .get(&(schema.to_string(), rel.to_string()))
            .map_or(&[], Vec::as_slice)
    }
}

/// Whether the rule keeps back any relation a statement reads (`touched`,
/// a schema of `None` meaning `default`). A hide list keeps back a relation
/// hidden itself or below a hidden table; a whitelist shares one ticked, or
/// a partition of a ticked table. A table above a hidden one needs no check
/// of its own: reading it lists the hidden one among the relations read.
pub(crate) fn keeps_back(
    rule: &Tables,
    above: &Above,
    touched: &[(Option<String>, String)],
    default: &str,
) -> bool {
    touched.iter().any(|(schema, rel)| {
        let schema = schema.as_deref().unwrap_or(default);
        let up = above.of(schema, rel);
        match rule {
            Tables::Only(_) => {
                !(rule.allows(schema, rel)
                    || up
                        .iter()
                        .any(|l| l.partition && rule.allows(&l.schema, &l.name)))
            }
            Tables::AllBut(_) => {
                !rule.allows(schema, rel) || up.iter().any(|l| !rule.allows(&l.schema, &l.name))
            }
        }
    })
}

/// The relations a Postgres statement reads: those in its plan, and when
/// Postgres pruned partitions as the executor started (`guard::pg_pruned`),
/// every partition a plan without pruning lists, since the run decides
/// again which it reads. `explain` is the `EXPLAIN` that gave `plan`.
/// Called when tables are hidden or columns masked: a plan that reads
/// tables it doesn't name is refused (`guard::pg_unnamed_scan`).
pub(crate) async fn pg_read_relations(
    store: &mut Store,
    target: &Target,
    explain: &str,
    plan: &Json,
) -> Result<Vec<(Option<String>, String)>, String> {
    if guard::pg_unnamed_scan(plan) {
        return Err(guard::UNNAMED_SCAN_REFUSAL.into());
    }
    let mut touched = guard::pg_relations(plan);
    if guard::pg_pruned(plan) {
        let found = store.read_unpruned(target, explain).await?;
        let (whole, _) = guard::pg_plan_json(found.rows)?;
        if guard::pg_unnamed_scan(&whole) {
            return Err(guard::UNNAMED_SCAN_REFUSAL.into());
        }
        for rel in guard::pg_relations(&whole) {
            if !touched.contains(&rel) {
                touched.push(rel);
            }
        }
    }
    Ok(touched)
}

/// Adds to `touched` what the materialized views among it were built from,
/// so the rest of a statement's checks see those tables as read: a
/// materialized view over a table kept back is kept back, as a view is.
///
/// A plan expands a view to the tables under it, but a materialized view
/// holds rows of its own, so its plan names nothing else. What its query
/// reads is on the server, in its rule: every relation the stored query
/// names (`pg_rewrite.ev_action`, which lists system catalogs too, where
/// `pg_depend` records nothing for them), followed through the views and
/// materialized views in it, with the partitions and child tables under
/// each table (the query may read them through their parent). A sequence or
/// type it uses is no table.
///
/// Refused outright, because a stored copy can't be checked column by
/// column: one built from a catalog that holds credentials, and one built
/// from a table with sensitive columns (the copy holds their values under
/// names of its own). That second refusal names the table, so it is handed
/// back for the caller to give once it knows the table is shared. Refused
/// too when nothing says what the copy holds: the server's rules can't be
/// read as expected, or (`guarded`: something is kept back or masked) the
/// stored query calls a function defined in the database, whose reads no
/// rule records.
pub(crate) async fn pg_copied(
    store: &mut Store,
    target: &Target,
    touched: &mut Vec<(Option<String>, String)>,
    marks: &[mask::Marked],
    guarded: bool,
) -> Result<Option<String>, String> {
    let lit = |v: &str| {
        rowkery_core::query_util::sql_literal(EngineKind::Postgres, &Value::Text(v.to_string()))
    };
    let mut names: Vec<String> = touched
        .iter()
        .filter_map(|(s, t)| {
            Some(format!(
                "({}, {})",
                lit(s.as_deref().unwrap_or("public"))?,
                lit(t)?
            ))
        })
        .collect();
    names.sort();
    names.dedup();
    if names.is_empty() {
        return Ok(None);
    }
    // Asked first and alone: nearly every statement reads no materialized
    // view, and then nothing below runs.
    let views = format!(
        "SELECT c.oid FROM pg_catalog.pg_class c \
           JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace \
           WHERE c.relkind = 'm' AND (n.nspname::text, c.relname::text) IN (VALUES {})",
        names.join(", ")
    );
    if store
        .read(target, &format!("SELECT 1 FROM ({views}) v LIMIT 1"))
        .await?
        .rows
        .is_empty()
    {
        return Ok(None);
    }
    // The relations a rule's query names, as its stored tree spells them.
    // pg_roles reads pg_authid on every server, so a tree that doesn't show
    // it is one this can't read.
    const NAMED: &str = "pg_catalog.regexp_matches(r.ev_action::text, ':relid ([0-9]+)', 'g')";
    let readable = format!(
        "SELECT 1 FROM pg_catalog.pg_rewrite r CROSS JOIN LATERAL {NAMED} AS m(id) \
           WHERE r.ev_class = 'pg_catalog.pg_roles'::regclass \
             AND m.id[1]::oid = 'pg_catalog.pg_authid'::regclass LIMIT 1"
    );
    if !matches!(store.read(target, &readable).await, Ok(found) if !found.rows.is_empty()) {
        return Err(guard::COPY_UNREADABLE.into());
    }
    // Each walk starts at the view itself. UNION, not UNION ALL: a relation
    // is reached once per materialized view however many paths lead to it,
    // and neither rules nor pg_inherits have cycles, so the walk ends.
    let walk = format!(
        "WITH RECURSIVE built(mv, rel) AS ( \
           SELECT v.oid, v.oid FROM ({views}) v \
           UNION SELECT b.mv, x.rel FROM built b CROSS JOIN LATERAL ( \
             SELECT m.id[1]::oid AS rel FROM pg_catalog.pg_class k \
               JOIN pg_catalog.pg_rewrite r ON r.ev_class = k.oid \
               CROSS JOIN LATERAL {NAMED} AS m(id) \
               WHERE k.oid = b.rel AND k.relkind IN ('v', 'm') \
             UNION ALL SELECT d.refobjid FROM pg_catalog.pg_class k \
               JOIN pg_catalog.pg_rewrite r ON r.ev_class = k.oid \
               JOIN pg_catalog.pg_depend d ON d.classid = 'pg_catalog.pg_rewrite'::regclass \
                 AND d.objid = r.oid AND d.refclassid = 'pg_catalog.pg_class'::regclass \
               WHERE k.oid = b.rel AND k.relkind IN ('v', 'm') \
             UNION ALL SELECT i.inhrelid FROM pg_catalog.pg_inherits i WHERE i.inhparent = b.rel) x)"
    );
    let text = |v: Option<&Value>| match v {
        Some(Value::Text(t)) => t.clone(),
        _ => String::new(),
    };
    if guarded {
        // A function of the database's own in the copy's query, or in a
        // view under it. Compiled IMMUTABLE code (an extension's) computes
        // on its arguments; an aggregate may step through any function.
        let calls = format!(
            "{walk} SELECT mn.nspname::text, m.relname::text, pn.nspname::text, p.proname::text \
               FROM built b JOIN pg_catalog.pg_class m ON m.oid = b.mv \
               JOIN pg_catalog.pg_namespace mn ON mn.oid = m.relnamespace \
               JOIN pg_catalog.pg_rewrite r ON r.ev_class = b.rel \
               JOIN pg_catalog.pg_depend d ON d.classid = 'pg_catalog.pg_rewrite'::regclass \
                 AND d.objid = r.oid AND d.refclassid = 'pg_catalog.pg_proc'::regclass \
               JOIN pg_catalog.pg_proc p ON p.oid = d.refobjid \
               JOIN pg_catalog.pg_namespace pn ON pn.oid = p.pronamespace \
               JOIN pg_catalog.pg_language l ON l.oid = p.prolang \
               WHERE pn.nspname NOT IN ('pg_catalog', 'information_schema') \
                 AND NOT (l.lanname IN ('c', 'internal') AND p.provolatile = 'i' AND p.prokind = 'f') \
               LIMIT 1"
        );
        if let Some(r) = store.read(target, &calls).await?.rows.first() {
            return Err(guard::copied_through_code_refusal(
                &format!("{}.{}", text(r.first()), text(r.get(1))),
                &format!("{}.{}", text(r.get(2)), text(r.get(3))),
            ));
        }
    }
    let sql = format!(
        "{walk} SELECT mn.nspname::text, m.relname::text, sn.nspname::text, s.relname::text \
           FROM built b JOIN pg_catalog.pg_class m ON m.oid = b.mv \
           JOIN pg_catalog.pg_namespace mn ON mn.oid = m.relnamespace \
           JOIN pg_catalog.pg_class s ON s.oid = b.rel \
           JOIN pg_catalog.pg_namespace sn ON sn.oid = s.relnamespace \
           WHERE b.rel <> b.mv AND s.relkind IN ('r', 'p', 'm', 'f')"
    );
    // (the materialized view, a relation it was built from)
    let built: Vec<((String, String), (String, String))> = store
        .read(target, &sql)
        .await?
        .rows
        .iter()
        .map(|r| {
            (
                (text(r.first()), text(r.get(1))),
                (text(r.get(2)), text(r.get(3))),
            )
        })
        .collect();
    if built.is_empty() {
        return Ok(None);
    }
    if let Some(((schema, name), _)) = built
        .iter()
        .find(|(_, (s, t))| guard::is_credentials(Some(s), t))
    {
        return Err(guard::copied_credentials_refusal(&format!(
            "{schema}.{name}"
        )));
    }
    let sources: Vec<(Option<String>, String)> = built
        .iter()
        .map(|(_, (s, t))| (Some(s.clone()), t.clone()))
        .collect();
    let mut masked = None;
    if !marks.is_empty() {
        // A mark on a table covers its partitions and child tables.
        let up = above(store, target, &sources).await?;
        masked = built.iter().find_map(|((schema, name), (s, t))| {
            let marked = |s: &str, t: &str| marks.iter().any(|m| m.schema == s && m.table == t);
            std::iter::once((s.as_str(), t.as_str()))
                .chain(
                    up.of(s, t)
                        .iter()
                        .map(|l| (l.schema.as_str(), l.name.as_str())),
                )
                .find(|(s, t)| marked(s, t))
                .map(|(s, t)| mask::copy_refusal(&format!("{schema}.{name}"), &format!("{s}.{t}")))
        });
    }
    for source in sources {
        if !touched.contains(&source) {
            touched.push(source);
        }
    }
    Ok(masked)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A relation and the tables above it: (schema, name, partition).
    type Up<'a> = (&'a str, &'a str, &'a [(&'a str, &'a str, bool)]);

    fn above(list: &[Up]) -> Above {
        Above(
            list.iter()
                .map(|(s, t, up)| {
                    (
                        (s.to_string(), t.to_string()),
                        up.iter()
                            .map(|(s, n, partition)| Link {
                                schema: s.to_string(),
                                name: n.to_string(),
                                partition: *partition,
                            })
                            .collect(),
                    )
                })
                .collect(),
        )
    }

    fn rel(s: &str, t: &str) -> Vec<(Option<String>, String)> {
        vec![(Some(s.into()), t.into())]
    }

    #[test]
    fn a_partition_goes_with_its_parent_and_a_child_table_needs_its_own_tick() {
        let up = above(&[
            ("other", "ledger_2024", &[("public", "ledger", true)]),
            ("public", "vip", &[("public", "people", false)]),
        ]);
        let hidden = ["public.ledger".to_string(), "public.people".to_string()];
        let hide = Tables::AllBut(&hidden);
        assert!(keeps_back(
            &hide,
            &up,
            &rel("other", "ledger_2024"),
            "public"
        ));
        assert!(keeps_back(&hide, &up, &rel("public", "vip"), "public"));
        assert!(!keeps_back(&hide, &up, &rel("public", "orders"), "public"));

        let ticked = hidden;
        let only = Tables::Only(&ticked);
        assert!(!keeps_back(
            &only,
            &up,
            &rel("other", "ledger_2024"),
            "public"
        ));
        assert!(keeps_back(&only, &up, &rel("public", "vip"), "public"));
        assert!(keeps_back(&only, &up, &rel("public", "orders"), "public"));
    }
}
