//! The `health` tool: the Health tab's report for an agent asked "why is
//! this slow?", limited to what the user shared. A finding is kept only on a
//! table the catalog knows and the rule shares (exact schema and name, so a
//! table made since the catalog was read, a temp table or a system catalog
//! stays out); a check whose findings were all left out says how many
//! (`left_out`) instead of reading "fine". A foreign key's parent that isn't
//! shared is not named, and the slowest queries come through
//! [`sessions::shown_query`]: values as `?`, a query on a table that isn't
//! shared blanked. Nothing here runs a fix.

use std::collections::HashSet;

use rowkery_core::health::{CheckState, Detail, HealthReport, SlowQueries};
use serde_json::{json, Value as Json};

use crate::sessions::shown_query;

pub const UNSHARED_TABLE: &str = "(a table not shared with agents)";

/// SQLite's items carry no schema; its catalog calls the one schema `main`.
const SQLITE_SCHEMA: &str = "main";

/// Every table the report names, a foreign key's parent too, as
/// `(schema, table)`.
pub fn tables(report: &HealthReport) -> Vec<(&str, &str)> {
    let mut out = Vec::new();
    for check in &report.checks {
        let CheckState::Found { items } = &check.state else {
            continue;
        };
        for item in items {
            if let Some(table) = &item.table {
                out.push((
                    item.schema.as_deref().unwrap_or(SQLITE_SCHEMA),
                    table.as_str(),
                ));
            }
            if let Detail::ForeignKeyWithoutIndex {
                parent_schema,
                parent_table,
                ..
            } = &item.detail
            {
                out.push((
                    parent_schema.as_deref().unwrap_or(SQLITE_SCHEMA),
                    parent_table.as_str(),
                ));
            }
        }
    }
    out
}

/// The report as an agent sees it. `shares(schema, table)` says whether the
/// user shared a catalog table (`None` for one the catalog doesn't know,
/// which stays out too); `hidden` from [`sessions::hidden_names`].
///
/// [`sessions::hidden_names`]: crate::sessions::hidden_names
pub fn shape(
    mut report: HealthReport,
    shares: &dyn Fn(&str, &str) -> Option<bool>,
    hidden: &HashSet<String>,
) -> Json {
    let shown = |schema: Option<&str>, table: &str| {
        shares(schema.unwrap_or(SQLITE_SCHEMA), table) == Some(true)
    };
    let mut left_out = Vec::new();
    for check in &mut report.checks {
        let CheckState::Found { items } = &mut check.state else {
            left_out.push(0);
            continue;
        };
        let before = items.len();
        // An item on no table (a slot, a session, the file) is the database's.
        items.retain(|i| {
            i.table
                .as_deref()
                .is_none_or(|t| shown(i.schema.as_deref(), t))
        });
        left_out.push(before - items.len());
        for item in items.iter_mut() {
            if let Detail::ForeignKeyWithoutIndex {
                parent_schema,
                parent_table,
                constraint,
                ..
            } = &mut item.detail
            {
                if !shown(parent_schema.as_deref(), parent_table) {
                    *parent_schema = None;
                    *parent_table = UNSHARED_TABLE.into();
                    // Its name often spells the parent's too.
                    *constraint = "(not shown)".into();
                    item.name = None;
                }
            }
        }
    }
    if let SlowQueries::Ranked { queries, .. } = &mut report.slow_queries {
        for q in queries.iter_mut() {
            q.query = shown_query(&q.query, hidden);
        }
    }
    let mut out = serde_json::to_value(&report).unwrap_or(Json::Null);
    if let Some(checks) = out["checks"].as_array_mut() {
        for (check, n) in checks.iter_mut().zip(left_out) {
            if n > 0 {
                check["left_out"] = json!(n);
            }
        }
    }
    // Unix seconds read poorly to an agent.
    if let Some(since) = report.stats_since {
        out["stats_since"] = json!(format!("{} days ago", (now_secs() - since).max(0) / 86_400));
    }
    out
}

fn now_secs() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_or(0, |d| d.as_secs() as i64)
}

#[cfg(test)]
mod tests {
    use super::*;
    use rowkery_core::health::{CheckKind, HealthCheck, HealthItem, SlowQuery};

    fn item(table: &str, detail: Detail) -> HealthItem {
        HealthItem {
            schema: Some("public".into()),
            table: Some(table.into()),
            name: Some(format!("{table}_idx")),
            bytes: Some(1),
            detail,
            fix: Some(format!("DROP INDEX CONCURRENTLY public.{table}_idx;")),
        }
    }

    #[test]
    fn leaves_out_what_isnt_shared() {
        let fk = |table: &str, parent: &str| {
            item(
                table,
                Detail::ForeignKeyWithoutIndex {
                    constraint: format!("{table}_fkey"),
                    columns: vec!["parent_id".into()],
                    parent_schema: Some("public".into()),
                    parent_table: parent.into(),
                    rows: Some(20_000),
                },
            )
        };
        let report = HealthReport {
            database: "shop".into(),
            server: "Postgres 16.4".into(),
            size: None,
            cache_hit: None,
            connections: None,
            stats_since: None,
            transaction_age: None,
            checks: vec![
                HealthCheck::of(
                    CheckKind::UnusedIndexes,
                    false,
                    vec![
                        item("orders", Detail::UnusedIndex),
                        item("Salaries", Detail::UnusedIndex),
                        HealthItem {
                            schema: Some("archive".into()),
                            ..item("orders", Detail::UnusedIndex)
                        },
                    ],
                ),
                HealthCheck::of(
                    CheckKind::DuplicateIndexes,
                    false,
                    vec![item(
                        "salaries",
                        Detail::DuplicateIndex {
                            covered_by: "x".into(),
                        },
                    )],
                ),
                HealthCheck::of(
                    CheckKind::ForeignKeysWithoutIndex,
                    false,
                    vec![fk("orders", "salaries"), fk("items", "orders")],
                ),
            ],
            slow_queries: SlowQueries::Ranked {
                queries: vec![
                    SlowQuery {
                        query: "SELECT * FROM orders WHERE note = 'card 4111'".into(),
                        user: None,
                        calls: 1,
                        total_ms: 1.0,
                        mean_ms: 1.0,
                        rows: 1,
                        share: 0.5,
                    },
                    SlowQuery {
                        query: "SELECT pay FROM salaries WHERE id = $1".into(),
                        user: None,
                        calls: 1,
                        total_ms: 1.0,
                        mean_ms: 1.0,
                        rows: 1,
                        share: 0.3,
                    },
                    SlowQuery {
                        query: "CREATE ROLE app LOGIN PASSWORD 'hunter2'".into(),
                        user: None,
                        calls: 1,
                        total_ms: 1.0,
                        mean_ms: 1.0,
                        rows: 0,
                        share: 0.2,
                    },
                ],
                partial: false,
            },
        };
        let hidden = HashSet::from(["salaries".to_string()]);
        // `Salaries` is a table made since the catalog was read; `archive.orders` is hidden.
        let shares = |schema: &str, table: &str| match (schema, table) {
            ("public", "orders" | "items") => Some(true),
            ("public", "salaries") | ("archive", "orders") => Some(false),
            _ => None,
        };
        let out = shape(report, &shares, &hidden);
        let text = out.to_string();
        assert!(
            !text.contains("hunter2") && !text.contains("4111"),
            "{text}"
        );
        assert!(!text.to_lowercase().contains("salaries"), "{text}");
        let checks = out["checks"].as_array().unwrap();
        assert_eq!(checks[0]["items"].as_array().unwrap().len(), 1);
        assert_eq!(checks[0]["left_out"], 2);
        assert_eq!(checks[0]["items"][0]["schema"], "public");
        // Its one finding was on a table not shared: not "fine".
        assert_eq!(checks[1]["state"], "found");
        assert_eq!(checks[1]["left_out"], 1);
        assert!(checks[2].get("left_out").is_none());
        assert_eq!(
            checks[2]["items"][0]["detail"]["parent_table"],
            UNSHARED_TABLE
        );
        assert_eq!(checks[2]["items"][0]["name"], Json::Null);
        assert_eq!(checks[2]["items"][1]["detail"]["parent_table"], "orders");
        let queries = out["slow_queries"]["queries"].as_array().unwrap();
        assert_eq!(queries[0]["query"], "SELECT * FROM orders WHERE note = ?");
        assert_eq!(queries[1]["query"], crate::sessions::HIDDEN_QUERY);
        assert_eq!(queries[2]["query"], "CREATE ROLE app LOGIN PASSWORD ?");
    }
}
