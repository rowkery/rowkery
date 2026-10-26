//! The `health` tool: the Health tab's report for an agent asked "why is
//! this slow?", limited to what the user shared. A finding on a table that
//! isn't shared is left out (by its bare name, as `sessions` blanks a query
//! naming one), a foreign key's parent that isn't shared is not named, and
//! the slowest queries come through [`sessions::shown_query`]: values as `?`,
//! a query on a table that isn't shared blanked. Nothing here runs a fix.

use std::collections::HashSet;

use rowkery_core::health::{CheckState, Detail, HealthReport, SlowQueries};
use serde_json::{json, Value as Json};

use crate::sessions::{folded, shown_query};

pub const UNSHARED_TABLE: &str = "(a table not shared with agents)";

/// The report as an agent sees it; `hidden` from [`sessions::hidden_names`].
///
/// [`sessions::hidden_names`]: crate::sessions::hidden_names
pub fn shape(mut report: HealthReport, hidden: &HashSet<String>) -> Json {
    let hides = |table: &str| hidden.contains(&folded(table));
    for check in &mut report.checks {
        let CheckState::Found { items } = &mut check.state else {
            continue;
        };
        items.retain(|i| !i.table.as_deref().is_some_and(hides));
        for item in items.iter_mut() {
            if let Detail::ForeignKeyWithoutIndex {
                references,
                constraint,
                ..
            } = &mut item.detail
            {
                let table = references.rsplit('.').next().unwrap_or(references);
                if hides(table) {
                    // Its name often spells the parent's too.
                    *references = UNSHARED_TABLE.into();
                    *constraint = "(not shown)".into();
                    item.name = None;
                }
            }
        }
        if items.is_empty() {
            check.state = CheckState::Fine;
        }
    }
    if let SlowQueries::Ranked { queries, .. } = &mut report.slow_queries {
        for q in queries.iter_mut() {
            q.query = shown_query(&q.query, hidden);
        }
    }
    let mut out = serde_json::to_value(&report).unwrap_or(Json::Null);
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
                    references: format!("public.{parent}"),
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
        let out = shape(report, &hidden);
        let text = out.to_string();
        assert!(
            !text.contains("hunter2") && !text.contains("4111"),
            "{text}"
        );
        assert!(!text.to_lowercase().contains("salaries"), "{text}");
        let checks = out["checks"].as_array().unwrap();
        assert_eq!(checks[0]["items"].as_array().unwrap().len(), 1);
        assert_eq!(checks[1]["state"], "fine");
        assert_eq!(
            checks[2]["items"][0]["detail"]["references"],
            UNSHARED_TABLE
        );
        assert_eq!(checks[2]["items"][0]["name"], Json::Null);
        assert_eq!(
            checks[2]["items"][1]["detail"]["references"],
            "public.orders"
        );
        let queries = out["slow_queries"]["queries"].as_array().unwrap();
        assert_eq!(queries[0]["query"], "SELECT * FROM orders WHERE note = ?");
        assert_eq!(queries[1]["query"], crate::sessions::HIDDEN_QUERY);
        assert_eq!(queries[2]["query"], "CREATE ROLE app LOGIN PASSWORD ?");
    }
}
