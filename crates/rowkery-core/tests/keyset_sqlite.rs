//! Keyset pages walk a table exactly as one ordered query does: every row
//! once, in order, through duplicates, NULLs and mixed directions.

use std::collections::HashMap;

use rowkery_core::db::sqlite::SqliteDriver;

use rowkery_core::db::{table_browse_query, BrowseOptions, BrowseOrder, Driver, EngineKind, Value};

fn rows(driver: &mut SqliteDriver, sql: &str) -> (Vec<String>, Vec<Vec<Value>>) {
    let mut names = Vec::new();
    let mut out = Vec::new();
    driver
        .query_stream(sql, |b, _| {
            names = b.columns.iter().map(|c| c.name.clone()).collect();
            out.extend(b.rows);
            Ok(())
        })
        .unwrap_or_else(|e| panic!("{sql}: {e}"));
    (names, out)
}

#[test]
fn keyset_pages_match_one_ordered_query() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("k.sqlite");
    std::fs::File::create(&path).unwrap();
    let mut driver = SqliteDriver::new(path.to_string_lossy().to_string());
    driver.connect().unwrap();
    rows(
        &mut driver,
        "CREATE TABLE t (tenant TEXT NOT NULL, id INTEGER NOT NULL, score REAL, name TEXT, PRIMARY KEY (tenant, id))",
    );
    let mut insert = String::from("INSERT INTO t VALUES ");
    for i in 0..97 {
        let score = if i % 7 == 0 {
            "NULL".to_string()
        } else {
            format!("{}", (i % 5) as f64 / 2.0)
        };
        let name = if i % 11 == 0 {
            "NULL".to_string()
        } else {
            format!("'n{}'", i % 4)
        };
        let tenant = ["a", "b'c", "d"][i % 3];
        insert.push_str(&format!(
            "{}('{}', {}, {score}, {name})",
            if i > 0 { "," } else { "" },
            tenant.replace('\'', "''"),
            i / 3
        ));
    }
    rows(&mut driver, &insert);

    let key = vec!["tenant".to_string(), "id".to_string()];
    let orders: Vec<Vec<BrowseOrder>> = vec![
        vec![],
        vec![BrowseOrder {
            column: "score".into(),
            desc: true,
        }],
        vec![
            BrowseOrder {
                column: "name".into(),
                desc: false,
            },
            BrowseOrder {
                column: "score".into(),
                desc: true,
            },
        ],
        vec![BrowseOrder {
            column: "id".into(),
            desc: true,
        }],
    ];
    for order in orders {
        for filter in [None, Some("id % 2 = 0".to_string())] {
            let base = BrowseOptions {
                filter: filter.clone(),
                order: order.clone(),
                key: key.clone(),
                ..BrowseOptions::first_page(0)
            };
            let (_, all) = rows(
                &mut driver,
                &table_browse_query(EngineKind::Sqlite, "main", "t", &base),
            );
            let mut paged = Vec::new();
            let mut after = None;
            loop {
                let opts = BrowseOptions {
                    limit: 4,
                    offset: paged.len() as u32,
                    after: after.clone(),
                    ..base.clone()
                };
                let sql = table_browse_query(EngineKind::Sqlite, "main", "t", &opts);
                assert!(!sql.contains("OFFSET"), "{sql}");
                let (names, page) = rows(&mut driver, &sql);
                let n = page.len();
                if let Some(last) = page.last() {
                    let map: HashMap<String, Value> =
                        names.iter().cloned().zip(last.iter().cloned()).collect();
                    after = Some(map);
                }
                paged.extend(page);
                if n < 4 {
                    break;
                }
            }
            assert_eq!(paged, all, "order {order:?} filter {filter:?}");
        }
    }
}
