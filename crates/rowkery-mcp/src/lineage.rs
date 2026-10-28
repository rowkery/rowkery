//! Whether the relations a statement reads are shared, judged with what
//! each is a partition or child table of, read from the server for every
//! statement (`pg_inherits`): a table made a moment ago, attached as a
//! partition, in another schema or a foreign table counts as part of its
//! parent all the same, with no catalog to go stale.

use std::collections::HashMap;

use rowkery_core::connections::ConnectionRecord;
use rowkery_core::db::{EngineKind, Value};
use serde_json::Value as Json;

use crate::access::Tables;
use crate::guard;
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
