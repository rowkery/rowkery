//! Against a live MySQL or MariaDB: `ROWKERY_MYSQL_PORT` (and `_HOST`,
//! `_USER`, `_PASSWORD`, `_DB`, all `rowkery` / 127.0.0.1 by default).
//! `ROWKERY_MYSQL_FLAVOR` (`mysql` or `mariadb`) checks the detection.
//! Each test makes its own tables, named after itself.
#![cfg(feature = "mysql-integration")]

use std::time::{Duration, Instant};

use rowkery_core::connections::{MysqlConnection, PostgresSslMode};
use rowkery_core::db::mysql::{
    cancel, open_session_via, session_execute, session_introspect, session_query_stream, Flavor,
    MysqlSession, CATALOG,
};
use rowkery_core::db::{
    table_browse_query, BrowseOptions, BrowseOrder, DriverError, EngineKind, RowBatch, RowEstimate,
    TableKind, Value,
};
use rowkery_core::safety::SafeMode;
use rowkery_core::ConnectionSecrets;

fn env(name: &str, default: &str) -> String {
    std::env::var(name).unwrap_or_else(|_| default.into())
}

fn config() -> MysqlConnection {
    MysqlConnection {
        id: "integration-mysql".into(),
        name: "integration".into(),
        host: env("ROWKERY_MYSQL_HOST", "127.0.0.1"),
        port: env("ROWKERY_MYSQL_PORT", "3306").parse().unwrap(),
        database: env("ROWKERY_MYSQL_DB", "rowkery"),
        username: env("ROWKERY_MYSQL_USER", "rowkery"),
        ssl_mode: PostgresSslMode::Disable,
        ssl_root_cert: None,
        ssh: None,
        environment: None,
        safe_mode: SafeMode::Off,
        allow_mcp: false,
        mcp_hidden_tables: Vec::new(),
        mcp_until: None,
        mcp_samples_off: false,
        mcp_timeout_s: None,
        mcp_access: None,
        masked_columns: Default::default(),
    }
}

fn secrets() -> ConnectionSecrets {
    ConnectionSecrets {
        db_password: Some(env("ROWKERY_MYSQL_PASSWORD", "rowkery")),
        ..Default::default()
    }
}

async fn open(config: MysqlConnection) -> Result<MysqlSession, DriverError> {
    open_session_via(config.id.clone(), config, Some(&secrets()), None).await
}

/// Every batch of `sql`, and what it returned.
async fn run(session: &mut MysqlSession, sql: &str) -> (Vec<RowBatch>, Result<u64, DriverError>) {
    let mut batches = Vec::new();
    let result = session_query_stream(session, sql, |b, _| {
        batches.push(b);
        Ok(())
    })
    .await;
    (batches, result)
}

async fn rows(session: &mut MysqlSession, sql: &str) -> Vec<Vec<Value>> {
    let (batches, result) = run(session, sql).await;
    result.unwrap_or_else(|e| panic!("{sql}: {e}"));
    batches.into_iter().flat_map(|b| b.rows).collect()
}

#[tokio::test]
async fn it_connects_and_says_which_server() {
    let session = open(config()).await.expect("open");
    let expected = match env("ROWKERY_MYSQL_FLAVOR", "").as_str() {
        "mysql" => Some(Flavor::Mysql),
        "mariadb" => Some(Flavor::Mariadb),
        _ => None,
    };
    if let Some(flavor) = expected {
        assert_eq!(session.flavor(), flavor);
    }
    assert!(
        session.version().split('.').count() == 3,
        "{}",
        session.version()
    );
}

#[tokio::test]
async fn a_wrong_password_says_so() {
    let mut wrong = secrets();
    wrong.db_password = Some("not-it".into());
    let config = config();
    let err = open_session_via(config.id.clone(), config, Some(&wrong), None)
        .await
        .err()
        .expect("refused");
    assert_eq!(
        err.into_message(),
        "The server rejected the password for 'rowkery'"
    );
}

#[tokio::test]
async fn cells_come_back_typed() {
    let mut s = open(config()).await.unwrap();
    session_execute(&mut s, "DROP TABLE IF EXISTS it_types")
        .await
        .unwrap();
    session_execute(
        &mut s,
        "CREATE TABLE it_types (
            id BIGINT UNSIGNED PRIMARY KEY, i INT, ti TINYINT(1), f DOUBLE, d DECIMAL(10,2),
            v VARCHAR(20), t TEXT, b BLOB, vb VARBINARY(4), bt BIT(10), dt DATETIME, dd DATE,
            j JSON, e ENUM('a','b'), y YEAR, n INT NULL)",
    )
    .await
    .unwrap();
    session_execute(
        &mut s,
        "INSERT INTO it_types VALUES (18446744073709551615, -7, 1, 1.5, 12.50, 'héllo', 'long',
            X'00FF', X'01', b'1000000001', '2026-10-31 12:00:00', '2026-10-31',
            '{\"a\": 1}', 'b', 2026, NULL)",
    )
    .await
    .unwrap();
    let (batches, result) = run(&mut s, "SELECT * FROM it_types").await;
    assert_eq!(result.unwrap(), 1);
    let types: Vec<&str> = batches[0]
        .columns
        .iter()
        .map(|c| c.type_name.as_str())
        .collect();
    assert_eq!(
        types,
        [
            "bigint unsigned",
            "int",
            "tinyint",
            "double",
            "decimal",
            "varchar",
            "text",
            "blob",
            "varbinary",
            "bit",
            "datetime",
            "date",
            // MariaDB's JSON is LONGTEXT.
            if s.flavor() == Flavor::Mariadb {
                "text"
            } else {
                "json"
            },
            "enum",
            "year",
            "int"
        ]
    );
    let row = &batches[0].rows[0];
    assert_eq!(row[0], Value::Text("18446744073709551615".into()));
    assert_eq!(row[1], Value::Int(-7));
    assert_eq!(row[2], Value::Int(1));
    assert_eq!(row[3], Value::Float(1.5));
    assert_eq!(row[4], Value::Text("12.50".into()));
    assert_eq!(row[5], Value::Text("héllo".into()));
    assert_eq!(row[7], Value::Bytes(vec![0, 0xff]));
    assert_eq!(row[8], Value::Bytes(vec![1]));
    assert_eq!(row[9], Value::Int(513));
    assert_eq!(row[10], Value::Text("2026-10-31 12:00:00".into()));
    assert_eq!(row[13], Value::Text("b".into()));
    assert_eq!(row[14], Value::Int(2026));
    assert_eq!(row[15], Value::Null);
}

#[tokio::test]
async fn several_statements_run_in_order() {
    let mut s = open(config()).await.unwrap();
    let (batches, result) = run(
        &mut s,
        "DROP TABLE IF EXISTS it_multi; CREATE TABLE it_multi (id INT PRIMARY KEY);
         INSERT INTO it_multi VALUES (1), (2), (3); SELECT id FROM it_multi ORDER BY id;
         DELETE FROM it_multi WHERE id > 1",
    )
    .await;
    // The DELETE's count is the last statement's.
    assert_eq!(result.unwrap(), 2);
    let ids: Vec<Value> = batches
        .iter()
        .flat_map(|b| b.rows.iter().map(|r| r[0].clone()))
        .collect();
    assert_eq!(ids, [Value::Int(1), Value::Int(2), Value::Int(3)]);
    // A statement that fails stops the run there.
    let (_, result) = run(&mut s, "SELECT 1; SELECT * FROM no_such_table; SELECT 2").await;
    match result {
        Err(DriverError::Server { sqlstate, .. }) => assert_eq!(sqlstate, "42S02"),
        other => panic!("{other:?}"),
    }
    // And the session is fine after.
    assert_eq!(rows(&mut s, "SELECT 5").await, [[Value::Int(5)]]);
}

#[tokio::test]
async fn the_catalog_lists_databases_as_schemas() {
    let mut s = open(config()).await.unwrap();
    session_execute(
        &mut s,
        "DROP VIEW IF EXISTS it_cat_view; DROP TABLE IF EXISTS it_cat_child;
         DROP TABLE IF EXISTS it_cat_parent;
         CREATE TABLE it_cat_parent (id INT PRIMARY KEY, code VARCHAR(10) NOT NULL DEFAULT 'x' COMMENT 'the code',
           UNIQUE KEY it_code (code)) COMMENT 'parents';
         CREATE TABLE it_cat_child (a INT, b INT, parent_id INT, PRIMARY KEY (a, b),
           CONSTRAINT it_fk FOREIGN KEY (parent_id) REFERENCES it_cat_parent (id) ON DELETE CASCADE);
         CREATE VIEW it_cat_view AS SELECT id FROM it_cat_parent",
    )
    .await
    .unwrap();
    let catalog = session_introspect(&mut s).await.unwrap();
    assert_eq!(catalog.databases.len(), 1);
    assert_eq!(catalog.databases[0].name, CATALOG);
    assert_eq!(catalog.search_path, ["rowkery"]);
    let names: Vec<&str> = catalog.databases[0]
        .schemas
        .iter()
        .map(|s| s.name.as_str())
        .collect();
    assert!(names.contains(&"rowkery"), "{names:?}");
    for system in ["mysql", "sys", "information_schema", "performance_schema"] {
        assert!(!names.contains(&system), "{names:?}");
    }
    let parent = catalog.table("rowkery", "it_cat_parent").unwrap();
    assert_eq!(parent.kind, TableKind::Table);
    assert_eq!(parent.primary_key, ["id"]);
    assert_eq!(parent.comment.as_deref(), Some("parents"));
    assert!(matches!(parent.row_estimate, RowEstimate::Approximate(_)));
    let code = &parent.columns[1];
    assert_eq!(
        (code.name.as_str(), code.type_name.as_str(), code.nullable),
        ("code", "varchar(10)", false)
    );
    assert_eq!(code.comment.as_deref(), Some("the code"));
    let default = code.default.as_deref().unwrap();
    assert!(default == "x" || default == "'x'", "{default}");
    let unique = parent.indexes.iter().find(|i| i.name == "it_code").unwrap();
    assert!(unique.unique && !unique.primary);
    assert_eq!(unique.columns, ["code"]);
    let child = catalog.table("rowkery", "it_cat_child").unwrap();
    assert_eq!(child.primary_key, ["a", "b"]);
    let fk = &child.foreign_keys[0];
    assert_eq!(
        (
            fk.name.as_str(),
            fk.columns.clone(),
            fk.ref_schema.as_str(),
            fk.ref_table.as_str(),
            fk.ref_columns.clone(),
            fk.on_delete.as_str()
        ),
        (
            "it_fk",
            vec!["parent_id".to_string()],
            "rowkery",
            "it_cat_parent",
            vec!["id".to_string()],
            "CASCADE"
        )
    );
    let view = catalog.table("rowkery", "it_cat_view").unwrap();
    assert_eq!(view.kind, TableKind::View);
    assert_eq!(view.comment, None);
    assert_eq!(view.row_estimate, RowEstimate::Unknown);
}

#[tokio::test]
async fn read_only_is_read_only_at_the_server() {
    let mut writer = open(config()).await.unwrap();
    session_execute(
        &mut writer,
        "DROP TABLE IF EXISTS it_ro; CREATE TABLE it_ro (id INT PRIMARY KEY) ENGINE=InnoDB;
         DROP TABLE IF EXISTS it_ro_myisam; CREATE TABLE it_ro_myisam (id INT) ENGINE=MyISAM",
    )
    .await
    .unwrap();
    let mut ro = config();
    ro.safe_mode = SafeMode::ReadOnly;
    let mut s = open(ro).await.unwrap();
    for sql in [
        "INSERT INTO it_ro VALUES (1)",
        "INSERT INTO it_ro_myisam VALUES (1)",
        "CREATE TABLE it_ro_new (id INT)",
    ] {
        let (_, result) = run(&mut s, sql).await;
        match result {
            Err(DriverError::Server { sqlstate, .. }) => assert_eq!(sqlstate, "25006", "{sql}"),
            other => panic!("{sql}: {other:?}"),
        }
    }
    // Something that turned it back (a stored function can) is undone
    // before the next run.
    session_execute(&mut s, "SET SESSION TRANSACTION READ WRITE")
        .await
        .unwrap();
    let (_, result) = run(&mut s, "INSERT INTO it_ro VALUES (2)").await;
    assert!(
        matches!(&result, Err(DriverError::Server { sqlstate, .. }) if sqlstate == "25006"),
        "{result:?}"
    );
    assert_eq!(
        rows(&mut s, "SELECT count(*) FROM it_ro").await,
        [[Value::Int(0)]]
    );
}

#[tokio::test]
async fn a_cancel_stops_the_running_statement() {
    let mut s = open(config()).await.unwrap();
    let via = s.cancel_via();
    let started = Instant::now();
    let killer = tokio::spawn(async move {
        tokio::time::sleep(Duration::from_millis(300)).await;
        cancel(via).await
    });
    // Killed, SLEEP alone returns 1; in a query over rows it stops with an
    // error.
    let (_, result) = run(
        &mut s,
        "SELECT SLEEP(10) FROM (SELECT 1 UNION ALL SELECT 2) t",
    )
    .await;
    killer.await.unwrap().unwrap();
    assert!(matches!(result, Err(DriverError::Cancelled)), "{result:?}");
    assert!(started.elapsed() < Duration::from_secs(5));
    assert_eq!(rows(&mut s, "SELECT 1").await, [[Value::Int(1)]]);
}

#[tokio::test]
async fn transactions_are_seen() {
    let mut s = open(config()).await.unwrap();
    assert!(!s.in_transaction());
    session_execute(&mut s, "BEGIN").await.unwrap();
    assert!(s.in_transaction());
    rows(&mut s, "SELECT 1").await;
    assert!(s.in_transaction());
    session_execute(&mut s, "ROLLBACK").await.unwrap();
    assert!(!s.in_transaction());
}

#[tokio::test]
async fn browse_pages_by_key_with_odd_values() {
    let mut s = open(config()).await.unwrap();
    session_execute(
        &mut s,
        "DROP TABLE IF EXISTS `it order`;
         CREATE TABLE `it order` (`key` VARCHAR(20) PRIMARY KEY, `rank` INT NULL);
         INSERT INTO `it order` VALUES ('a', 3), ('b\\\\c', NULL), ('it''s', 1), ('z', 2)",
    )
    .await
    .unwrap();
    let mut opts = BrowseOptions::first_page(2);
    opts.key = vec!["key".into()];
    opts.order = vec![BrowseOrder {
        column: "rank".into(),
        desc: false,
    }];
    let page =
        |opts: &BrowseOptions| table_browse_query(EngineKind::Mysql, "rowkery", "it order", opts);
    let first = rows(&mut s, &page(&opts)).await;
    assert_eq!(
        first.iter().map(|r| r[0].clone()).collect::<Vec<_>>(),
        [Value::Text("it's".into()), Value::Text("z".into())]
    );
    // The next page starts after the last row, NULLs last.
    let last = &first[1];
    opts.after = Some(
        [
            ("key".to_string(), last[0].clone()),
            ("rank".to_string(), last[1].clone()),
        ]
        .into_iter()
        .collect(),
    );
    let second = rows(&mut s, &page(&opts)).await;
    assert_eq!(
        second.iter().map(|r| r[0].clone()).collect::<Vec<_>>(),
        [Value::Text("a".into()), Value::Text("b\\c".into())]
    );
    // A key holding a backslash finds its own row.
    opts.order.clear();
    opts.after = Some(
        [("key".to_string(), Value::Text("b\\c".into()))]
            .into_iter()
            .collect(),
    );
    let after_backslash = rows(&mut s, &page(&opts)).await;
    assert_eq!(after_backslash[0][0], Value::Text("it's".into()));
}

#[tokio::test]
async fn tls_as_the_form_asks() {
    // Prefer always connects: TLS when the server has it.
    let mut prefer = config();
    prefer.ssl_mode = PostgresSslMode::Prefer;
    let mut s = open(prefer).await.expect("prefer connects");
    let cipher = rows(&mut s, "SHOW SESSION STATUS LIKE 'Ssl_cipher'").await;
    let has_tls = matches!(&cipher[0][1], Value::Text(t) if !t.is_empty());
    let mut require = config();
    require.ssl_mode = PostgresSslMode::Require;
    match open(require).await {
        Ok(_) => assert!(has_tls, "Require connected where Prefer had no TLS"),
        Err(e) => {
            assert!(!has_tls);
            assert_eq!(
                e.into_message(),
                "The server doesn't accept SSL. Check SSL under Advanced."
            );
        }
    }
    if has_tls {
        // The test servers' certificates are self-signed.
        let mut verify = config();
        verify.ssl_mode = PostgresSslMode::Verify;
        let err = open(verify).await.err().expect("an unknown CA is refused");
        assert!(err
            .into_message()
            .contains("Couldn't verify the server's certificate"),);
    }
}

#[tokio::test]
async fn a_run_returns_its_last_statements_count() {
    let mut s = open(config()).await.unwrap();
    for (sql, n) in [
        ("SELECT 1 UNION ALL SELECT 2", 2),
        (
            "DROP TABLE IF EXISTS it_count; CREATE TABLE it_count (id INT)",
            0,
        ),
        ("INSERT INTO it_count VALUES (1), (2), (3)", 3),
        ("UPDATE it_count SET id = id + 10 WHERE id > 1", 2),
        ("SELECT 1; DELETE FROM it_count", 3),
        ("DELETE FROM it_count; SELECT 1", 1),
        ("SET @x = 1", 0),
    ] {
        let (_, result) = run(&mut s, sql).await;
        assert_eq!(result.unwrap(), n, "{sql}");
    }
}
