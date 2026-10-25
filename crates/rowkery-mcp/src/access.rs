//! What a shared connection lets agents reach: which of its databases, and
//! in each one which tables. The user picks both on the Agents page; the
//! record keeps them as `mcp_access` (database → mode + tables).
//!
//! A connection saved before that map existed has none: every database is
//! shared and only `mcp_hidden_tables` is kept back, as before.

use rowkery_core::connections::{ConnectionRecord, McpTableMode};
use rowkery_core::db::{SchemaCatalog, TableNode};
use serde_json::{json, Value as Json};

/// The table rule of one shared database.
#[derive(Clone, Copy, Debug)]
pub enum Tables<'a> {
    /// Only these `schema.table` names, matched exactly ("Only ticked").
    Only(&'a [String]),
    /// Every table but these, matched without case ("All but unticked").
    AllBut(&'a [String]),
}

/// How `database` of a shared connection is shared; None when it isn't.
pub fn tables<'a>(record: &'a ConnectionRecord, database: &str) -> Option<Tables<'a>> {
    match record.mcp_access() {
        None => Some(Tables::AllBut(record.mcp_hidden_tables())),
        Some(map) => map.get(database).map(|a| match a.mode {
            McpTableMode::Picked => Tables::Only(&a.tables),
            McpTableMode::All => Tables::AllBut(&a.tables),
        }),
    }
}

/// The databases agents may use, sorted; None means every one on the server.
pub fn databases(record: &ConnectionRecord) -> Option<Vec<&str>> {
    record
        .mcp_access()
        .map(|map| map.keys().map(String::as_str).collect())
}

/// The database a call runs on when it names none: the connection's own when
/// shared, else the first shared one.
pub fn default_database(record: &ConnectionRecord) -> Option<String> {
    let own = match record {
        ConnectionRecord::Postgres(pg) => pg.database.as_str(),
        ConnectionRecord::Sqlite(_) => "main",
    };
    match databases(record) {
        None => Some(own.to_string()),
        Some(list) if list.contains(&own) => Some(own.to_string()),
        Some(list) => list.first().map(|d| d.to_string()),
    }
}

/// `schema.table` against one name of a list: `schema.table` or a bare
/// `table` (any schema). `exact` compares case; otherwise case is ignored.
fn names(entry: &str, schema: &str, table: &str, exact: bool) -> bool {
    let eq = |a: &str, b: &str| {
        if exact {
            a == b
        } else {
            a.eq_ignore_ascii_case(b)
        }
    };
    match entry.split_once('.') {
        Some((s, t)) => eq(s, schema) && eq(t, table),
        None => eq(entry, table),
    }
}

impl Tables<'_> {
    /// Whether the rule lets this one name through (no partition parents).
    pub fn allows(&self, schema: &str, table: &str) -> bool {
        match self {
            // Picked names come from the catalog, so they match exactly:
            // ticking `public."Users"` must not share `public.users`.
            Tables::Only(list) => list.iter().any(|e| names(e, schema, table, true)),
            Tables::AllBut(list) => !list.iter().any(|e| names(e, schema, table, false)),
        }
    }

    /// Anything is kept back: a whitelist, or a hide list with names on it.
    pub fn restricts(&self) -> bool {
        match self {
            Tables::Only(_) => true,
            Tables::AllBut(list) => !list.is_empty(),
        }
    }

    /// Whether a catalog table is reachable, the same way
    /// `lineage::keeps_back` judges a statement. A whitelist shares a
    /// partition of a ticked table, in any schema; a child table made with
    /// `INHERITS` needs its own tick. A hide list hides a partition or child
    /// table of a hidden table, and a table with one below it, since reading
    /// it reads their rows.
    pub fn allows_node(&self, catalog: &SchemaCatalog, schema: &str, t: &TableNode) -> bool {
        match self {
            Tables::Only(_) => partition_of(catalog, schema, t)
                .iter()
                .any(|(s, n)| self.allows(s, n)),
            Tables::AllBut(_) => {
                lineage(catalog, schema, t, Direction::Down).is_some_and(|below| {
                    below.iter().all(|&(s, n)| match catalog.table(s, n) {
                        Some(node) => lineage(catalog, s, node, Direction::Up)
                            .is_some_and(|up| up.iter().all(|(s, n)| self.allows(s, n))),
                        None => self.allows(s, n),
                    })
                })
            }
        }
    }

    /// The log's record of what was shared when a call ran.
    pub fn scope(&self, record: &ConnectionRecord, max_rows: Option<usize>) -> Json {
        let (mode, list) = match self {
            Tables::Only(l) => ("picked", l),
            Tables::AllBut(l) => ("all", l),
        };
        let mut out = json!({
            "databases": databases(record).map_or(json!("all"), |d| json!(d.len())),
            "mode": mode,
            "tables": list.len(),
            "timeout_s": crate::guard::STATEMENT_TIMEOUT.as_secs(),
        });
        if let Some(n) = max_rows {
            out["max_rows"] = json!(n);
        }
        out
    }
}

#[derive(Clone, Copy, PartialEq)]
enum Direction {
    /// The tables a table is a partition or child table of.
    Up,
    /// Its partitions and child tables.
    Down,
}

/// Most tables walked from one. A bigger tree is refused whole rather than
/// read in part.
const LINEAGE_MAX: usize = 100_000;

/// `schema.t` and every table above it, or below it, in any schema; `None`
/// past [`LINEAGE_MAX`].
fn lineage<'a>(
    catalog: &'a SchemaCatalog,
    schema: &'a str,
    t: &'a TableNode,
    direction: Direction,
) -> Option<Vec<(&'a str, &'a str)>> {
    let mut seen = vec![(schema, t.name.as_str())];
    let mut known: std::collections::HashSet<(&str, &str)> = seen.iter().copied().collect();
    let mut next = 0;
    while let Some(&(s, name)) = seen.get(next) {
        next += 1;
        let linked: Vec<(&str, &str)> = match direction {
            Direction::Up => {
                let node = if next == 1 {
                    Some(t)
                } else {
                    find_exact(catalog, s, name)
                };
                node.map(|n| {
                    n.inherits_from
                        .iter()
                        .map(|(s, n)| (s.as_str(), n.as_str()))
                        // A catalog cached before `inherits_from` has only this.
                        .chain(n.partition_of.as_deref().map(|p| (s, p)))
                        .collect()
                })
                .unwrap_or_default()
            }
            Direction::Down => catalog
                .inherited_by(s, name)
                .iter()
                .map(|(s, n)| (s.as_str(), n.as_str()))
                .collect(),
        };
        for link in linked {
            if known.insert(link) {
                seen.push(link);
            }
        }
        if seen.len() > LINEAGE_MAX {
            return None;
        }
    }
    Some(seen)
}

/// `schema.t` and the tables it's a partition of, up through partitions
/// only, in any schema.
fn partition_of<'a>(
    catalog: &'a SchemaCatalog,
    schema: &'a str,
    t: &'a TableNode,
) -> Vec<(&'a str, &'a str)> {
    let mut chain = vec![(schema, t.name.as_str())];
    let mut node = Some(t);
    while let Some(n) = node.filter(|n| n.is_partition || n.partition_of.is_some()) {
        let &(s, _) = chain.last().expect("chain");
        let Some(parent) = n
            .inherits_from
            .first()
            .map(|(s, n)| (s.as_str(), n.as_str()))
            // A catalog cached before `inherits_from` has only this.
            .or_else(|| n.partition_of.as_deref().map(|p| (s, p)))
        else {
            break;
        };
        if chain.contains(&parent) || chain.len() > LINEAGE_DEPTH {
            break;
        }
        chain.push(parent);
        node = catalog.table(parent.0, parent.1);
    }
    chain
}

/// Deepest chain of partitions followed up.
const LINEAGE_DEPTH: usize = 64;

/// The table `schema.name` with that exact spelling.
pub fn find_exact<'a>(
    catalog: &'a SchemaCatalog,
    schema: &str,
    name: &str,
) -> Option<&'a TableNode> {
    catalog.table(schema, name)
}

#[cfg(test)]
mod tests {
    use super::*;
    use rowkery_core::connections::{McpDbAccess, SqliteConnection};

    fn sqlite(
        access: Option<Vec<(&str, McpTableMode, &[&str])>>,
        hidden: &[&str],
    ) -> ConnectionRecord {
        ConnectionRecord::Sqlite(SqliteConnection {
            id: "c".into(),
            name: "c".into(),
            path: "/tmp/x.db".into(),
            environment: None,
            safe_mode: Default::default(),
            sample: false,
            allow_mcp: true,
            mcp_hidden_tables: hidden.iter().map(|s| s.to_string()).collect(),
            mcp_until: None,
            mcp_samples_off: false,
            mcp_access: access.map(|list| {
                list.into_iter()
                    .map(|(db, mode, tables)| {
                        (
                            db.to_string(),
                            McpDbAccess {
                                mode,
                                tables: tables.iter().map(|s| s.to_string()).collect(),
                            },
                        )
                    })
                    .collect()
            }),
            masked_columns: Default::default(),
        })
    }

    /// `(schema, table, parents, partition)`.
    type Row<'a> = (&'a str, &'a str, &'a [(&'a str, &'a str)], bool);

    fn catalog(tables: &[Row]) -> SchemaCatalog {
        use rowkery_core::db::{DatabaseNode, RowEstimate, SchemaNode, TableKind};
        let mut schemas: Vec<SchemaNode> = Vec::new();
        for &(schema, name, parents, partition) in tables {
            let node = TableNode {
                name: name.into(),
                kind: TableKind::Table,
                columns: Vec::new(),
                primary_key: Vec::new(),
                indexes: Vec::new(),
                row_estimate: RowEstimate::Unknown,
                partition_of: None,
                inherits_from: parents
                    .iter()
                    .map(|(s, n)| (s.to_string(), n.to_string()))
                    .collect(),
                is_partition: partition,
                foreign_keys: Vec::new(),
                table_bytes: None,
                index_bytes: None,
                indexes_deferred: false,
                comment: None,
            };
            match schemas.iter_mut().find(|s| s.name == schema) {
                Some(s) => s.tables.push(node),
                None => schemas.push(SchemaNode {
                    name: schema.into(),
                    tables: vec![node],
                }),
            }
        }
        let mut c = SchemaCatalog::default();
        c.databases.push(DatabaseNode {
            name: "db".into(),
            schemas,
        });
        c
    }

    #[test]
    fn partitions_and_child_tables_are_judged_with_every_table_above_and_below() {
        // ledger is partitioned into a partition in another schema, itself
        // partitioned again; vip inherits from people and from staff.
        let c = catalog(&[
            ("public", "ledger", &[], false),
            ("other", "ledger_2024", &[("public", "ledger")], true),
            ("arch", "ledger_2024_q1", &[("other", "ledger_2024")], true),
            ("public", "people", &[], false),
            ("public", "staff", &[], false),
            (
                "public",
                "vip",
                &[("public", "people"), ("public", "staff")],
                false,
            ),
        ]);
        assert_eq!(
            c.inherited_by("public", "ledger"),
            [("other".to_string(), "ledger_2024".to_string())]
        );
        assert_eq!(c.inherited_by("public", "staff").len(), 1);
        assert!(c.table("arch", "ledger_2024_q1").is_some());
        assert!(c.table("public", "LEDGER").is_none());
        let node = |s: &str, n: &str| c.table(s, n).expect(n);

        // Hiding the middle partition keeps back everything it's part of.
        let hidden = ["other.ledger_2024".to_string()];
        let hide = Tables::AllBut(&hidden);
        assert!(!hide.allows_node(&c, "public", node("public", "ledger")));
        assert!(!hide.allows_node(&c, "arch", node("arch", "ledger_2024_q1")));
        assert!(hide.allows_node(&c, "public", node("public", "people")));
        // A child of a hidden parent is hidden, and so is its other parent,
        // whose rows include it.
        let hidden = ["public.staff".to_string()];
        let hide = Tables::AllBut(&hidden);
        assert!(!hide.allows_node(&c, "public", node("public", "vip")));
        assert!(!hide.allows_node(&c, "public", node("public", "people")));

        // Ticking the root shares its partitions at every level; a child
        // table needs its own tick.
        let ticked = ["public.ledger".to_string(), "public.people".to_string()];
        let only = Tables::Only(&ticked);
        assert!(only.allows_node(&c, "arch", node("arch", "ledger_2024_q1")));
        assert!(only.allows_node(&c, "other", node("other", "ledger_2024")));
        assert!(!only.allows_node(&c, "public", node("public", "vip")));
    }

    #[test]
    fn an_old_connection_shares_every_database_minus_its_hidden_tables() {
        let c = sqlite(None, &["main.secret"]);
        let t = tables(&c, "anything").expect("shared");
        assert!(t.allows("main", "orders"));
        assert!(!t.allows("main", "SECRET"));
        assert!(t.restricts());
        assert_eq!(databases(&c), None);
        assert_eq!(default_database(&c).as_deref(), Some("main"));
    }

    #[test]
    fn picked_shares_only_the_ticked_tables_with_their_exact_names() {
        let c = sqlite(
            Some(vec![("main", McpTableMode::Picked, &["main.orders"])]),
            &[],
        );
        let t = tables(&c, "main").expect("shared");
        assert!(t.allows("main", "orders"));
        assert!(!t.allows("main", "ORDERS"));
        assert!(!t.allows("main", "customers"));
        assert!(!t.allows("main", "sqlite_master"));
        assert!(t.restricts());
        assert!(tables(&c, "other").is_none());
    }

    #[test]
    fn a_database_without_an_entry_is_not_shared() {
        let c = sqlite(Some(vec![]), &[]);
        assert!(tables(&c, "main").is_none());
        assert_eq!(default_database(&c), None);
        let c = sqlite(Some(vec![("main", McpTableMode::All, &[])]), &[]);
        assert!(!tables(&c, "main").unwrap().restricts());
    }
}
