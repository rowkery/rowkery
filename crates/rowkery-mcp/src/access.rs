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

    /// Whether a catalog table is reachable. A partition goes with its
    /// parent: shared when the parent is ticked, hidden when it's hidden.
    pub fn allows_node(&self, catalog: &SchemaCatalog, schema: &str, t: &TableNode) -> bool {
        let mut chain = vec![t.name.as_str()];
        let mut parent = t.partition_of.as_deref();
        while let Some(p) = parent {
            if chain.len() > 8 || chain.contains(&p) {
                break;
            }
            chain.push(p);
            parent = find_exact(catalog, schema, p).and_then(|n| n.partition_of.as_deref());
        }
        match self {
            Tables::Only(_) => chain.iter().any(|n| self.allows(schema, n)),
            Tables::AllBut(_) => chain.iter().all(|n| self.allows(schema, n)),
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

/// The table `schema.name` with that exact spelling.
pub fn find_exact<'a>(
    catalog: &'a SchemaCatalog,
    schema: &str,
    name: &str,
) -> Option<&'a TableNode> {
    catalog
        .databases
        .iter()
        .flat_map(|db| db.schemas.iter())
        .filter(|s| s.name == schema)
        .flat_map(|s| s.tables.iter())
        .find(|t| t.name == name)
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
