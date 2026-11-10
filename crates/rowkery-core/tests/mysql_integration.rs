//! Against a live MySQL or MariaDB: `ROWKERY_MYSQL_PORT` (and `_HOST`,
//! `_USER`, `_PASSWORD`, `_DB`, all `rowkery` / 127.0.0.1 by default).
//! `ROWKERY_MYSQL_FLAVOR` (`mysql` or `mariadb`) checks the detection.
//! Tests that make stored functions sign in as root once
//! (`ROWKERY_MYSQL_ROOT_PASSWORD`, `rowkery` by default).
//! Each test makes its own tables, named after itself.
#![cfg(feature = "mysql-integration")]

use std::time::{Duration, Instant};

use rowkery_core::connections::{MysqlConnection, PostgresSslMode};
use rowkery_core::db::mysql::{
    cancel, open_session_via, session_execute, session_introspect, session_probe_txn,
    session_query_stream, Flavor, MysqlSession, CATALOG,
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
        mariadb: false,
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

/// Lets the test user make stored functions: with binary logging on (MySQL
/// 8.0's default) only a SUPER user may, unless the server trusts them.
async fn trust_function_creators() {
    let mut root = config();
    root.username = "root".into();
    let secrets = ConnectionSecrets {
        db_password: Some(env("ROWKERY_MYSQL_ROOT_PASSWORD", "rowkery")),
        ..Default::default()
    };
    let mut s = open_session_via(root.id.clone(), root, Some(&secrets), None)
        .await
        .unwrap();
    session_execute(&mut s, "SET GLOBAL log_bin_trust_function_creators = 1")
        .await
        .unwrap();
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
    // MariaDB's `'x'` reads as MySQL's `x`.
    assert_eq!(code.default.as_deref(), Some("x"));
    // Arguments past GROUP_CONCAT's 1024 bytes are all there.
    let long_arg = format!("a_{}", "x".repeat(60));
    let params: Vec<String> = (0..20).map(|i| format!("{long_arg}{i} INT")).collect();
    trust_function_creators().await;
    session_execute(
        &mut s,
        &format!(
            "DROP FUNCTION IF EXISTS it_many; CREATE FUNCTION it_many({}) RETURNS INT DETERMINISTIC RETURN 1",
            params.join(", ")
        ),
    )
    .await
    .unwrap();
    let catalog = session_introspect(&mut s).await.unwrap();
    let many = catalog
        .functions
        .iter()
        .find(|f| f.name == "it_many")
        .unwrap();
    assert_eq!(many.args.matches(&long_arg).count(), 20, "{}", many.args);
    assert!(
        many.args.contains(&format!("{long_arg}19 int")),
        "{}",
        many.args
    );
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
    // So is one turned back by an earlier statement of the same run.
    trust_function_creators().await;
    session_execute(
        &mut writer,
        "DROP FUNCTION IF EXISTS it_unlock; DROP FUNCTION IF EXISTS it_write;
         CREATE FUNCTION it_unlock() RETURNS INT DETERMINISTIC
           BEGIN SET SESSION TRANSACTION READ WRITE; RETURN 1; END;
         CREATE FUNCTION it_write() RETURNS INT DETERMINISTIC
           BEGIN INSERT INTO it_ro VALUES (3); RETURN 1; END",
    )
    .await
    .unwrap();
    let (_, result) = run(&mut s, "SELECT it_unlock(); SELECT it_write()").await;
    assert!(result.is_err(), "{result:?}");
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
    // A failed statement keeps it open; its packet says nothing of it,
    // and asking says so.
    assert!(run(&mut s, "SELECT * FROM it_no_such_table")
        .await
        .1
        .is_err());
    assert_eq!(s.txn_known(), None);
    assert_eq!(
        session_probe_txn(&mut s, Duration::from_secs(2)).await,
        Some(true)
    );
    session_execute(&mut s, "ROLLBACK").await.unwrap();
    assert!(!s.in_transaction());
    assert_eq!(
        session_probe_txn(&mut s, Duration::from_secs(2)).await,
        Some(false)
    );
    assert!(!s.is_closed());
    // Autocommit off is state a new session wouldn't have.
    assert!(!s.keeps_state());
    session_execute(&mut s, "SET autocommit = 0").await.unwrap();
    assert!(s.keeps_state());
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

/// MySQL 8 caches a table's row count for a day once anything has read it:
/// the catalog reads it fresh, and leaves the session's setting as it was.
#[tokio::test]
async fn row_estimates_follow_a_table_just_filled() {
    let mut s = open(config()).await.unwrap();
    session_execute(
        &mut s,
        "DROP TABLE IF EXISTS it_fresh; CREATE TABLE it_fresh (id INT PRIMARY KEY)",
    )
    .await
    .unwrap();
    let estimate = |catalog: &rowkery_core::db::SchemaCatalog| {
        catalog
            .table("rowkery", "it_fresh")
            .unwrap()
            .row_estimate
            .clone()
    };
    // Read while empty: MySQL 8 now has 0 in its cache.
    let before = session_introspect(&mut s).await.unwrap();
    assert_eq!(estimate(&before), RowEstimate::Approximate(0));
    let values: Vec<String> = (1..=500).map(|i| format!("({i})")).collect();
    session_execute(
        &mut s,
        &format!("INSERT INTO it_fresh VALUES {}", values.join(", ")),
    )
    .await
    .unwrap();
    // No ANALYZE TABLE, which would refresh the cache by itself. The
    // engine's own count is an estimate: near 500, never the cached 0.
    let after = session_introspect(&mut s).await.unwrap();
    assert!(
        matches!(estimate(&after), RowEstimate::Approximate(n) if n > 0),
        "{:?}",
        estimate(&after)
    );
    if s.flavor() == Flavor::Mysql {
        let kept = rows(&mut s, "SELECT @@SESSION.information_schema_stats_expiry").await;
        assert_ne!(kept[0][0], Value::Int(0));
    }
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
        (
            "DROP PROCEDURE IF EXISTS it_three; \
             CREATE PROCEDURE it_three() SELECT 1 UNION ALL SELECT 2 UNION ALL SELECT 3",
            0,
        ),
        // A CALL's own OK after its rows doesn't count over them.
        ("CALL it_three()", 3),
    ] {
        let (_, result) = run(&mut s, sql).await;
        assert_eq!(result.unwrap(), n, "{sql}");
    }
}

/// A wrong password, an unknown database and one the user may not use each
/// mark their own field in the form.
#[tokio::test]
async fn failed_logins_are_explained() {
    use rowkery_core::explain::{explain_connect_error, Target};
    let fail = |c: MysqlConnection, password: &str| {
        let secrets = ConnectionSecrets {
            db_password: Some(password.into()),
            ..Default::default()
        };
        async move {
            match open_session_via(c.id.clone(), c, Some(&secrets), None).await {
                Ok(_) => panic!("signed in"),
                Err(e) => e.to_string(),
            }
        }
    };
    let c = config();
    let t = Target {
        host: &c.host,
        port: c.port,
        username: &c.username,
        ssh_host: None,
        cloud_sql: None,
    };
    let wrong = fail(c.clone(), "not-the-password").await;
    let x = explain_connect_error(&wrong, &t);
    assert_eq!((x.class, x.field), ("auth", Some("password")), "{wrong}");

    let mut missing = c.clone();
    missing.database = "no_such_database_here".into();
    let raw = fail(missing, &env("ROWKERY_MYSQL_PASSWORD", "rowkery")).await;
    let x = explain_connect_error(&raw, &t);
    assert_eq!((x.class, x.field), ("database", Some("database")), "{raw}");

    let mut theirs = c.clone();
    theirs.database = "mysql".into();
    let raw = fail(theirs, &env("ROWKERY_MYSQL_PASSWORD", "rowkery")).await;
    let x = explain_connect_error(&raw, &t);
    assert_eq!((x.class, x.field), ("database", Some("database")), "{raw}");
}

// Staged row edits and what they reach.

use rowkery_core::db::mysql::session_apply_changes_within;
use rowkery_core::edits::{build_row_changes, CellValue, Change, EditColumn, EditTable};
use rowkery_core::reach::{Reach, TableRows};

fn edit_table(table: &str, columns: &[(&str, &str)]) -> EditTable {
    EditTable {
        schema: config().database,
        table: table.into(),
        columns: columns
            .iter()
            .map(|(n, t)| EditColumn {
                name: n.to_string(),
                type_name: t.to_string(),
            })
            .collect(),
        key: vec!["id".into()],
    }
}

fn cell(column: &str, value: Value) -> CellValue {
    CellValue {
        column: column.into(),
        value,
    }
}

fn delete(id: i64) -> Change {
    Change::Delete {
        key: vec![cell("id", Value::Int(id))],
    }
}

async fn apply(
    s: &mut MysqlSession,
    table: &EditTable,
    changes: &[Change],
    approved: Option<&Reach>,
) -> Result<rowkery_core::edits::ApplyCounts, rowkery_core::edits::ApplyFailure> {
    let statements = build_row_changes(EngineKind::Mysql, table, changes).unwrap();
    let name = (table.schema.clone(), table.table.clone());
    session_apply_changes_within(
        s,
        &name,
        &statements,
        Some(Duration::from_secs(10)),
        approved,
    )
    .await
}

async fn count(s: &mut MysqlSession, sql: &str) -> i64 {
    match rows(s, sql).await[0][0] {
        Value::Int(n) => n,
        ref v => panic!("{sql}: {v:?}"),
    }
}

fn deleted(table: &str, n: u64) -> TableRows {
    TableRows {
        schema: config().database,
        table: table.into(),
        inserted: 0,
        updated: 0,
        deleted: n,
    }
}

#[tokio::test]
async fn edits_write_exact_literals_one_row_each() {
    let mut s = open(config()).await.unwrap();
    session_execute(
        &mut s,
        "DROP TABLE IF EXISTS it_ed_kiosks; CREATE TABLE it_ed_kiosks (id INT PRIMARY KEY, \
         name VARCHAR(40), on_air TINYINT(1), blob_v VARBINARY(8), price DECIMAL(10,2), doc JSON, \
         seen DATETIME, n INT NOT NULL DEFAULT 7)",
    )
    .await
    .unwrap();
    let table = edit_table(
        "it_ed_kiosks",
        &[
            ("id", "int"),
            ("name", "varchar(40)"),
            ("on_air", "tinyint(1)"),
            ("blob_v", "varbinary(8)"),
            ("price", "decimal(10,2)"),
            ("doc", "json"),
            ("seen", "datetime"),
            ("n", "int"),
        ],
    );
    let insert = Change::Insert {
        values: vec![
            cell("id", Value::Int(1)),
            cell("name", Value::Text(r"it's a \n back\slash".into())),
            cell("on_air", Value::Bool(true)),
            cell("blob_v", Value::Text(r"\x00ff".into())),
            cell("price", Value::Text("12.50".into())),
            cell("doc", Value::Text(r#"{"a": "b\\c"}"#.into())),
            cell("seen", Value::Text("2026-10-31 09:15:00".into())),
        ],
    };
    let counts = apply(&mut s, &table, &[insert], None).await.unwrap();
    assert_eq!(counts.inserted, 1);
    let got = rows(
        &mut s,
        "SELECT name, on_air, HEX(blob_v), price, JSON_UNQUOTE(JSON_EXTRACT(doc, '$.a')), seen, n FROM it_ed_kiosks",
    )
    .await;
    assert_eq!(got[0][0], Value::Text(r"it's a \n back\slash".into()));
    assert_eq!(got[0][1], Value::Int(1));
    assert_eq!(got[0][2], Value::Text("00FF".into()));
    assert_eq!(got[0][4], Value::Text(r"b\c".into()));
    assert_eq!(got[0][6], Value::Int(7));
    // An UPDATE to the value it already has still names its one row.
    let same = Change::Update {
        key: vec![cell("id", Value::Int(1))],
        set: vec![cell("on_air", Value::Bool(true))],
    };
    assert_eq!(
        apply(&mut s, &table, &[same], None).await.unwrap().updated,
        1
    );
    // An empty insert takes every default.
    let empty = edit_table("it_ed_auto", &[("id", "int")]);
    session_execute(
        &mut s,
        "DROP TABLE IF EXISTS it_ed_auto; CREATE TABLE it_ed_auto (id INT AUTO_INCREMENT PRIMARY KEY)",
    )
    .await
    .unwrap();
    let blank = Change::Insert { values: vec![] };
    assert_eq!(
        apply(&mut s, &empty, &[blank], None)
            .await
            .unwrap()
            .inserted,
        1
    );
    // A row that isn't there rolls the whole batch back.
    let two = Change::Insert {
        values: vec![cell("id", Value::Int(2))],
    };
    let failure = apply(&mut s, &table, &[two, delete(99)], None)
        .await
        .unwrap_err();
    assert_eq!(failure.index, Some(1));
    assert_eq!(failure.rows, Some(0));
    assert_eq!(count(&mut s, "SELECT COUNT(*) FROM it_ed_kiosks").await, 1);
    assert_eq!(s.txn_known(), Some(false));
    // NaN can't be written.
    let nan = Change::Update {
        key: vec![cell("id", Value::Int(1))],
        set: vec![cell("price", Value::Float(f64::NAN))],
    };
    assert!(build_row_changes(EngineKind::Mysql, &table, &[nan]).is_err());
}

#[tokio::test]
async fn edits_refuse_the_users_transaction() {
    let mut s = open(config()).await.unwrap();
    session_execute(
        &mut s,
        "DROP TABLE IF EXISTS it_ed_open; CREATE TABLE it_ed_open (id INT PRIMARY KEY); \
         INSERT INTO it_ed_open VALUES (1)",
    )
    .await
    .unwrap();
    let table = edit_table("it_ed_open", &[("id", "int")]);
    session_execute(&mut s, "BEGIN").await.unwrap();
    let failure = apply(&mut s, &table, &[delete(1)], None).await.unwrap_err();
    assert!(
        failure.message.contains("transaction open"),
        "{}",
        failure.message
    );
    // Untouched: still open, the row still there.
    assert!(s.in_transaction());
    session_execute(&mut s, "ROLLBACK").await.unwrap();
    assert_eq!(count(&mut s, "SELECT COUNT(*) FROM it_ed_open").await, 1);
}

async fn shop(s: &mut MysqlSession, prefix: &str) {
    let p = prefix;
    session_execute(
        s,
        &format!(
            "DROP TABLE IF EXISTS {p}_notes, {p}_items, {p}_orders, {p}_customers; \
             CREATE TABLE {p}_customers (id INT PRIMARY KEY); \
             CREATE TABLE {p}_orders (id INT PRIMARY KEY, customer_id INT, \
               FOREIGN KEY (customer_id) REFERENCES {p}_customers (id) ON DELETE CASCADE); \
             CREATE TABLE {p}_items (id INT PRIMARY KEY, order_id INT, \
               FOREIGN KEY (order_id) REFERENCES {p}_orders (id) ON DELETE CASCADE); \
             CREATE TABLE {p}_notes (id INT PRIMARY KEY, item_id INT, \
               FOREIGN KEY (item_id) REFERENCES {p}_items (id) ON DELETE SET NULL); \
             INSERT INTO {p}_customers VALUES (1), (2); \
             INSERT INTO {p}_orders VALUES (10, 1), (11, 1), (12, 2); \
             INSERT INTO {p}_items VALUES (100, 10), (101, 10), (102, 11), (103, 12); \
             INSERT INTO {p}_notes VALUES (1, 100), (2, 102), (3, 103), (4, NULL)"
        ),
    )
    .await
    .unwrap();
}

#[tokio::test]
async fn cascades_are_counted_before_commit() {
    let mut s = open(config()).await.unwrap();
    shop(&mut s, "it_cc").await;
    let table = edit_table("it_cc_customers", &[("id", "int")]);
    let failure = apply(&mut s, &table, &[delete(1)], None).await.unwrap_err();
    let reach = failure.reach.expect("stops before commit");
    let mut notes = deleted("it_cc_notes", 0);
    notes.updated = 2;
    assert_eq!(
        reach.tables,
        [deleted("it_cc_items", 3), notes, deleted("it_cc_orders", 2)]
    );
    assert!(reach.uncounted.is_empty());
    // Nothing was saved.
    assert_eq!(count(&mut s, "SELECT COUNT(*) FROM it_cc_orders").await, 3);
    // Approved, it commits, and the server wrote exactly that.
    apply(&mut s, &table, &[delete(1)], Some(&reach))
        .await
        .unwrap();
    assert_eq!(count(&mut s, "SELECT COUNT(*) FROM it_cc_orders").await, 1);
    assert_eq!(count(&mut s, "SELECT COUNT(*) FROM it_cc_items").await, 1);
    assert_eq!(
        count(
            &mut s,
            "SELECT COUNT(*) FROM it_cc_notes WHERE item_id IS NULL"
        )
        .await,
        3
    );
    // A table no key cascades from writes nowhere else.
    let leaf = edit_table("it_cc_notes", &[("id", "int")]);
    assert_eq!(
        apply(&mut s, &leaf, &[delete(4)], None)
            .await
            .unwrap()
            .deleted,
        1
    );
}

#[tokio::test]
async fn a_child_added_meanwhile_is_counted() {
    let mut s = open(config()).await.unwrap();
    shop(&mut s, "it_cr").await;
    let table = edit_table("it_cr_customers", &[("id", "int")]);
    let reach = apply(&mut s, &table, &[delete(1)], None)
        .await
        .unwrap_err()
        .reach
        .unwrap();
    // Another session adds an order for customer 1 and commits while the
    // save is waiting on its lock.
    let mut other = open(config()).await.unwrap();
    session_execute(&mut other, "BEGIN; INSERT INTO it_cr_orders VALUES (13, 1)")
        .await
        .unwrap();
    let commit_later = tokio::spawn(async move {
        tokio::time::sleep(Duration::from_millis(400)).await;
        session_execute(&mut other, "COMMIT").await.unwrap();
    });
    let failure = apply(&mut s, &table, &[delete(1)], Some(&reach))
        .await
        .unwrap_err();
    commit_later.await.unwrap();
    let now = failure.reach.expect("the reach moved");
    assert!(now.tables.contains(&deleted("it_cr_orders", 3)), "{now:?}");
    assert_eq!(count(&mut s, "SELECT COUNT(*) FROM it_cr_orders").await, 4);
}

#[tokio::test]
async fn writes_it_cannot_count_are_named() {
    let mut s = open(config()).await.unwrap();
    session_execute(
        &mut s,
        "DROP TABLE IF EXISTS it_un_log, it_un_lines, it_un_cats, it_un_trig; \
         CREATE TABLE it_un_cats (id INT PRIMARY KEY, parent_id INT, \
           FOREIGN KEY (parent_id) REFERENCES it_un_cats (id) ON DELETE CASCADE); \
         INSERT INTO it_un_cats VALUES (1, NULL), (2, 1), (3, 2); \
         CREATE TABLE it_un_trig (id INT PRIMARY KEY); \
         CREATE TABLE it_un_log (what VARCHAR(10)); \
         CREATE TABLE it_un_lines (id INT PRIMARY KEY, trig_id INT, \
           FOREIGN KEY (trig_id) REFERENCES it_un_trig (id) ON UPDATE CASCADE); \
         INSERT INTO it_un_trig VALUES (1), (2); INSERT INTO it_un_lines VALUES (1, 1)",
    )
    .await
    .unwrap();
    trust_function_creators().await;
    session_execute(
        &mut s,
        "CREATE TRIGGER it_un_t AFTER DELETE ON it_un_trig FOR EACH ROW INSERT INTO it_un_log VALUES ('gone')",
    )
    .await
    .unwrap();
    let db = config().database;
    // Cascading into itself: named, not counted; approved, it commits.
    let cats = edit_table("it_un_cats", &[("id", "int")]);
    let reach = apply(&mut s, &cats, &[delete(1)], None)
        .await
        .unwrap_err()
        .reach
        .unwrap();
    assert!(reach.tables.is_empty());
    assert_eq!(reach.uncounted, [format!("{db}.it_un_cats")]);
    apply(&mut s, &cats, &[delete(1)], Some(&reach))
        .await
        .unwrap();
    assert_eq!(count(&mut s, "SELECT COUNT(*) FROM it_un_cats").await, 0);
    // A trigger on the table.
    let trig = edit_table("it_un_trig", &[("id", "int")]);
    let reach = apply(&mut s, &trig, &[delete(2)], None)
        .await
        .unwrap_err()
        .reach
        .unwrap();
    assert_eq!(reach.uncounted, [format!("triggers on {db}.it_un_trig")]);
    // Changing a key another table follows; another column is fine.
    let rekey = Change::Update {
        key: vec![cell("id", Value::Int(1))],
        set: vec![cell("id", Value::Int(5))],
    };
    let reach = apply(&mut s, &trig, std::slice::from_ref(&rekey), None)
        .await
        .unwrap_err()
        .reach
        .unwrap();
    assert_eq!(reach.uncounted, [format!("{db}.it_un_lines")]);
    apply(&mut s, &trig, &[rekey], Some(&reach)).await.unwrap();
    assert_eq!(count(&mut s, "SELECT trig_id FROM it_un_lines").await, 5);
    let lines = edit_table("it_un_lines", &[("id", "int"), ("trig_id", "int")]);
    let plain = Change::Update {
        key: vec![cell("id", Value::Int(1))],
        set: vec![cell("trig_id", Value::Int(5))],
    };
    assert_eq!(
        apply(&mut s, &lines, &[plain], None).await.unwrap().updated,
        1
    );
}

#[tokio::test]
async fn reach_holds_whatever_the_tab_set() {
    let mut s = open(config()).await.unwrap();
    session_execute(
        &mut s,
        "DROP TABLE IF EXISTS it_ts_g, it_ts_c, it_ts_p; \
         CREATE TABLE it_ts_p (id INT, region INT, code INT UNIQUE, PRIMARY KEY (id, region)); \
         CREATE TABLE it_ts_c (id INT PRIMARY KEY, pid INT, pregion INT, code INT UNIQUE, \
           FOREIGN KEY (pid, pregion) REFERENCES it_ts_p (id, region) ON DELETE CASCADE, \
           FOREIGN KEY (code) REFERENCES it_ts_p (code) ON UPDATE CASCADE); \
         CREATE TABLE it_ts_g (id INT PRIMARY KEY, code INT, \
           FOREIGN KEY (code) REFERENCES it_ts_c (code) ON UPDATE CASCADE); \
         INSERT INTO it_ts_p VALUES (1, 1, 10), (1, 2, 20); \
         INSERT INTO it_ts_c VALUES (1, 1, 1, 10), (2, 1, 1, NULL), (3, 1, 2, 20); \
         INSERT INTO it_ts_g VALUES (1, 20)",
    )
    .await
    .unwrap();
    let mut table = edit_table(
        "it_ts_p",
        &[("id", "int"), ("region", "int"), ("code", "int")],
    );
    table.key = vec!["id".into(), "region".into()];
    let gone = Change::Delete {
        key: vec![cell("id", Value::Int(1)), cell("region", Value::Int(1))],
    };
    // A composite key cascades and is counted.
    let failure = apply(&mut s, &table, std::slice::from_ref(&gone), None)
        .await
        .unwrap_err();
    let reach = failure
        .reach
        .unwrap_or_else(|| panic!("{}", failure.message));
    assert_eq!(reach.tables, [deleted("it_ts_c", 2)]);
    // A select limit on the tab cuts no count short.
    session_execute(&mut s, "SET sql_select_limit = 0")
        .await
        .unwrap();
    let again = apply(&mut s, &table, std::slice::from_ref(&gone), None)
        .await
        .unwrap_err()
        .reach
        .unwrap();
    assert_eq!(again, reach);
    session_execute(&mut s, "SET sql_select_limit = DEFAULT")
        .await
        .unwrap();
    // Changing a followed key names every table it reaches.
    let rekey = Change::Update {
        key: vec![cell("id", Value::Int(1)), cell("region", Value::Int(1))],
        set: vec![cell("code", Value::Int(11))],
    };
    let db = config().database;
    let reach = apply(&mut s, &table, std::slice::from_ref(&rekey), None)
        .await
        .unwrap_err()
        .reach
        .unwrap();
    assert_eq!(
        reach.uncounted,
        [format!("{db}.it_ts_c"), format!("{db}.it_ts_g")]
    );
    // With foreign key checks off InnoDB cascades nothing, and nothing is
    // counted.
    session_execute(&mut s, "SET foreign_key_checks = 0")
        .await
        .unwrap();
    apply(&mut s, &table, &[gone], None).await.unwrap();
    session_execute(&mut s, "SET foreign_key_checks = 1")
        .await
        .unwrap();
    assert_eq!(count(&mut s, "SELECT COUNT(*) FROM it_ts_c").await, 3);
}

#[tokio::test]
async fn triggers_a_login_cannot_see_are_named() {
    let mut s = open(config()).await.unwrap();
    session_execute(
        &mut s,
        "DROP TABLE IF EXISTS it_ht; CREATE TABLE it_ht (id INT PRIMARY KEY); \
         INSERT INTO it_ht VALUES (1), (2)",
    )
    .await
    .unwrap();
    let mut root = config();
    root.username = "root".into();
    let root_secrets = ConnectionSecrets {
        db_password: Some(env("ROWKERY_MYSQL_ROOT_PASSWORD", "rowkery")),
        ..Default::default()
    };
    let mut r = open_session_via(root.id.clone(), root, Some(&root_secrets), None)
        .await
        .unwrap();
    let db = config().database;
    session_execute(
        &mut r,
        &format!(
            "DROP USER IF EXISTS 'it_narrow'@'%'; CREATE USER 'it_narrow'@'%' IDENTIFIED BY 'narrow'; \
             GRANT SELECT, DELETE ON {db}.it_ht TO 'it_narrow'@'%'"
        ),
    )
    .await
    .unwrap();
    let mut narrow = config();
    narrow.username = "it_narrow".into();
    let secrets = ConnectionSecrets {
        db_password: Some("narrow".into()),
        ..Default::default()
    };
    let mut n = open_session_via(narrow.id.clone(), narrow, Some(&secrets), None)
        .await
        .unwrap();
    let table = edit_table("it_ht", &[("id", "int")]);
    let reach = apply(&mut n, &table, &[delete(1)], None)
        .await
        .unwrap_err()
        .reach
        .unwrap();
    assert_eq!(
        reach.uncounted,
        [format!("any triggers on {db}.it_ht this login can't see")]
    );
    apply(&mut n, &table, &[delete(1)], Some(&reach))
        .await
        .unwrap();
    // The table's owner sees there are none.
    assert_eq!(
        apply(&mut s, &table, &[delete(2)], None)
            .await
            .unwrap()
            .deleted,
        1
    );
    session_execute(&mut r, "DROP USER 'it_narrow'@'%'")
        .await
        .unwrap();
}

// CSV import.

use rowkery_core::import::{
    import_mysql, EmptyCells, ImportColumn, ImportError, ImportSpec, OnConflict,
};

fn csv_file(name: &str, text: &str) -> String {
    let path = std::env::temp_dir().join(format!("{name}.csv"));
    std::fs::write(&path, text).unwrap();
    path.to_string_lossy().into_owned()
}

fn spec(path: String, table: &str, columns: &[&str], on_conflict: OnConflict) -> ImportSpec {
    ImportSpec {
        path,
        schema: config().database,
        table: table.into(),
        delimiter: ",".into(),
        header: true,
        columns: columns
            .iter()
            .enumerate()
            .map(|(field, c)| ImportColumn {
                field,
                column: c.to_string(),
            })
            .collect(),
        on_conflict,
        empty: EmptyCells::Null,
    }
}

async fn import(
    s: &mut MysqlSession,
    spec: &ImportSpec,
) -> Result<rowkery_core::import::ImportCounts, ImportError> {
    let stop = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false));
    import_mysql(s, spec, stop, &|_| {}).await
}

#[tokio::test]
async fn csv_imports_stop_skip_and_update() {
    let mut s = open(config()).await.unwrap();
    session_execute(
        &mut s,
        "DROP TABLE IF EXISTS it_csv; CREATE TABLE it_csv (id INT PRIMARY KEY, \
         name VARCHAR(20) NOT NULL DEFAULT 'none', note TEXT, seen DATETIME DEFAULT CURRENT_TIMESTAMP, \
         code VARCHAR(5) UNIQUE, n INT AS (id * 2)); \
         INSERT INTO it_csv (id, name, code) VALUES (1, 'old', 'a')",
    )
    .await
    .unwrap();
    let cols = ["id", "name", "note", "code"];
    // Stop: a key already there fails it, nothing written.
    let file = csv_file(
        "it_csv_1",
        "id,name,note,code\n2,Bo,\"back\\slash, it's\",b\n1,dup,,z\n",
    );
    let failure = import(
        &mut s,
        &spec(file.clone(), "it_csv", &cols, OnConflict::Stop),
    )
    .await;
    assert!(
        matches!(failure, Err(ImportError::Failed(ref m)) if m.contains("Duplicate")),
        "{failure:?}"
    );
    assert_eq!(count(&mut s, "SELECT COUNT(*) FROM it_csv").await, 1);
    // Skip: the new row in, the old one kept; empty cells take the defaults.
    let counts = import(
        &mut s,
        &spec(file.clone(), "it_csv", &cols, OnConflict::Skip),
    )
    .await
    .unwrap();
    assert_eq!((counts.inserted, counts.updated, counts.skipped), (1, 0, 1));
    let got = rows(
        &mut s,
        "SELECT name, note, seen IS NOT NULL, n FROM it_csv WHERE id = 2",
    )
    .await;
    assert_eq!(
        got[0][..3],
        [
            Value::Text("Bo".into()),
            Value::Text("back\\slash, it's".into()),
            Value::Int(1)
        ]
    );
    assert_eq!(
        count(&mut s, "SELECT COUNT(*) FROM it_csv WHERE name = 'old'").await,
        1
    );
    // Update: existing rows take the file's values (an empty cell keeps
    // the old one), new rows go in; the defaults fill a new row's gaps.
    let file = csv_file("it_csv_2", "id,name,note,code\n1,,new note,\n3,,,c\n");
    let counts = import(&mut s, &spec(file, "it_csv", &cols, OnConflict::Update))
        .await
        .unwrap();
    assert_eq!((counts.inserted, counts.updated, counts.skipped), (1, 1, 0));
    let got = rows(
        &mut s,
        "SELECT id, name, note, code FROM it_csv WHERE id IN (1, 3) ORDER BY id",
    )
    .await;
    assert_eq!(
        got[0],
        [
            Value::Int(1),
            Value::Text("old".into()),
            Value::Text("new note".into()),
            Value::Text("a".into())
        ]
    );
    assert_eq!(got[1][1], Value::Text("none".into()));
    // A bad value names its line, and nothing is written.
    let file = csv_file("it_csv_3", "id,name,note,code\n4,x,,d\nfive,y,,e\n");
    let failure = import(&mut s, &spec(file, "it_csv", &cols, OnConflict::Stop)).await;
    assert!(
        matches!(failure, Err(ImportError::Failed(ref m)) if m.starts_with("Line 3, id")),
        "{failure:?}"
    );
    assert_eq!(count(&mut s, "SELECT COUNT(*) FROM it_csv").await, 3);
    // A generated column can't be imported into.
    let file = csv_file("it_csv_4", "id,n\n9,1\n");
    assert!(import(
        &mut s,
        &spec(file, "it_csv", &["id", "n"], OnConflict::Stop)
    )
    .await
    .is_err());
    assert_eq!(s.txn_known(), Some(false));
    // Many rows go in batches.
    let mut big = String::from("id,name,note,code\n");
    for i in 100..20_100 {
        big.push_str(&format!("{i},row {i},{},\n", "x".repeat(40)));
    }
    let file = csv_file("it_csv_5", &big);
    let counts = import(&mut s, &spec(file, "it_csv", &cols, OnConflict::Stop))
        .await
        .unwrap();
    assert_eq!(counts.inserted, 20_000);
}

#[tokio::test]
async fn csv_imports_leave_empty_cells_to_the_table() {
    let mut s = open(config()).await.unwrap();
    let mariadb = s.flavor() == Flavor::Mariadb;
    session_execute(
        &mut s,
        "DROP TABLE IF EXISTS it_csvd, it_csvm; CREATE TABLE it_csvd (id INT AUTO_INCREMENT PRIMARY KEY, \
         doc JSON DEFAULT ('[\"it''s\"]'), bin VARBINARY(4) DEFAULT 'ab', f FLOAT DEFAULT 1.5, \
         d DATE, v VARCHAR(3), h INT DEFAULT 2, twice INT DEFAULT (h * 2)); \
         CREATE TABLE it_csvm (id INT PRIMARY KEY) ENGINE = MyISAM",
    )
    .await
    .unwrap();
    let cols = ["id", "doc", "bin", "f", "d", "v", "h"];
    // Empty cells take the table's defaults, expressions included; an
    // empty id takes the next AUTO_INCREMENT; a row of empty cells is all
    // defaults.
    let file = csv_file(
        "it_csvd_1",
        "id,doc,bin,f,d,v,h\n,,,1.2345678,2024-02-29,abc,5\n,,,,,,\n",
    );
    let counts = import(&mut s, &spec(file, "it_csvd", &cols, OnConflict::Stop))
        .await
        .unwrap();
    assert_eq!(counts.inserted, 2);
    let got = rows(
        &mut s,
        "SELECT id, JSON_UNQUOTE(JSON_EXTRACT(doc, '$[0]')), bin, f = CAST(1.2345678 AS FLOAT), twice FROM it_csvd ORDER BY id",
    )
    .await;
    assert_eq!(got[0][0], Value::Int(1));
    if !mariadb {
        // MariaDB keeps JSON as text: its expression default reads the same.
        assert_eq!(got[0][1], Value::Text("it's".into()));
    }
    assert_eq!(got[0][2], Value::Bytes(b"ab".to_vec()));
    assert_eq!(got[0][3], Value::Int(1));
    assert_eq!(
        (got[0][4].clone(), got[1][4].clone()),
        (Value::Int(10), Value::Int(4))
    );
    // Strict, whatever the server's mode: a value the column can't hold
    // fails, naming its line, and the session's mode comes back.
    session_execute(&mut s, "SET SESSION sql_mode = ''")
        .await
        .unwrap();
    let file = csv_file(
        "it_csvd_2",
        "id,doc,bin,f,d,v,h\n10,,,,,ok,\n11,,,,2020-02-30,,\n",
    );
    let failure = import(&mut s, &spec(file, "it_csvd", &cols, OnConflict::Stop)).await;
    assert!(
        matches!(failure, Err(ImportError::Failed(ref m)) if m.starts_with("Line 3:") && !m.contains("rowkery_import")),
        "{failure:?}"
    );
    assert_eq!(
        rows(&mut s, "SELECT @@SESSION.sql_mode").await[0][0],
        Value::Text("".into())
    );
    let file = csv_file("it_csvd_3", "id,doc,bin,f,d,v,h\n12,,,,,abcdef,\n");
    assert!(
        import(&mut s, &spec(file, "it_csvd", &cols, OnConflict::Stop))
            .await
            .is_err()
    );
    assert_eq!(count(&mut s, "SELECT COUNT(*) FROM it_csvd").await, 2);
    // A table that can't roll back is refused before anything is written.
    let file = csv_file("it_csvd_4", "id\n1\n");
    let failure = import(&mut s, &spec(file, "it_csvm", &["id"], OnConflict::Stop)).await;
    assert!(
        matches!(failure, Err(ImportError::Failed(ref m)) if m.contains("MyISAM")),
        "{failure:?}"
    );
}

#[tokio::test]
async fn several_edits_need_a_table_that_rolls_back() {
    let mut s = open(config()).await.unwrap();
    session_execute(
        &mut s,
        "DROP TABLE IF EXISTS it_ed_myisam; CREATE TABLE it_ed_myisam (id INT PRIMARY KEY) ENGINE = MyISAM; \
         INSERT INTO it_ed_myisam VALUES (1), (2)",
    )
    .await
    .unwrap();
    let table = edit_table("it_ed_myisam", &[("id", "int")]);
    let failure = apply(&mut s, &table, &[delete(1), delete(99)], None)
        .await
        .unwrap_err();
    assert!(failure.message.contains("MyISAM"), "{}", failure.message);
    assert_eq!(count(&mut s, "SELECT COUNT(*) FROM it_ed_myisam").await, 2);
    // One row alone is one statement.
    assert_eq!(
        apply(&mut s, &table, &[delete(1)], None)
            .await
            .unwrap()
            .deleted,
        1
    );
}

/// Runs `sql` as a SQL file: its scan, then the run.
async fn run_file(
    s: &mut MysqlSession,
    sql: &str,
    whole_file: bool,
) -> (
    rowkery_core::sql_file::Scan,
    rowkery_core::sql_file::RunReport,
) {
    use rowkery_core::sql_file::{run_mysql, scan, RunOptions};
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("f.sql");
    std::fs::write(&path, sql).unwrap();
    let scanned = scan(&path, EngineKind::Mysql, |_| true).unwrap();
    assert_eq!(scanned.refused, None, "{sql}");
    let options = RunOptions {
        whole_file,
        keep_going: false,
    };
    let report = run_mysql(s, &path, &scanned, options, || false, |_| {}).await;
    (scanned, report)
}

#[tokio::test]
async fn sql_files_run_as_the_mysql_client_runs_them() {
    trust_function_creators().await;
    let mut s = open(config()).await.unwrap();
    session_execute(
        &mut s,
        "DROP TABLE IF EXISTS it_file_c, it_file_p, it_file_x; DROP PROCEDURE IF EXISTS it_file_proc",
    )
    .await
    .unwrap();
    // A dump's shape: versioned comments, rows with escapes and `;`, and
    // bodies under DELIMITER ;; (a trigger as mysqldump writes it).
    let dump = "/*M!999999\\- enable the sandbox mode */ \n\
        /*!40101 SET @OLD_SQL_MODE=@@SQL_MODE, SQL_MODE='NO_AUTO_VALUE_ON_ZERO' */;\n\
        /*M!100616 SET @OLD_NOTE_VERBOSITY=@@NOTE_VERBOSITY, NOTE_VERBOSITY=0 */;\n\
        CREATE TABLE `it_file_p` (`id` int NOT NULL, `name` varchar(20), PRIMARY KEY (`id`)) ENGINE=InnoDB;\n\
        CREATE TABLE `it_file_c` (`id` int NOT NULL AUTO_INCREMENT, `p` int, `note` text, PRIMARY KEY (`id`)) ENGINE=InnoDB;\n\
        LOCK TABLES `it_file_p` WRITE;\n\
        /*!40000 ALTER TABLE `it_file_p` DISABLE KEYS */;\n\
        INSERT INTO `it_file_p` VALUES (1,'it\\'s'),(2,'back\\\\slash;');\n\
        /*!40000 ALTER TABLE `it_file_p` ENABLE KEYS */;\n\
        UNLOCK TABLES;\n\
        DELIMITER ;;\n\
        /*!50003 CREATE*/ /*!50003 TRIGGER it_file_t BEFORE INSERT ON it_file_c FOR EACH ROW BEGIN SET NEW.note = CONCAT(NEW.note, ';'); IF NEW.p IS NULL THEN SET NEW.p = 1; END IF; END \n*/;;\n\
        CREATE PROCEDURE `it_file_proc`()\nBEGIN INSERT INTO it_file_c (note) VALUES ('a'); INSERT INTO it_file_c (p, note) VALUES (2, 'b'); END\n;;\n\
        DELIMITER ;\n\
        CALL it_file_proc();\n\
        /*!40101 SET SQL_MODE=@OLD_SQL_MODE */;\n";
    let (scanned, report) = run_file(&mut s, dump, false).await;
    assert!(scanned.per_statement.is_some());
    assert_eq!(report.failed, None, "{report:?}");
    assert_eq!(report.done, scanned.statements);
    assert_eq!(
        rows(&mut s, "SELECT name FROM it_file_p ORDER BY id").await,
        [
            [Value::Text("it's".into())],
            [Value::Text("back\\slash;".into())]
        ]
    );
    assert_eq!(
        rows(&mut s, "SELECT p, note FROM it_file_c ORDER BY id").await,
        [
            [Value::Int(1), Value::Text("a;".into())],
            [Value::Int(2), Value::Text("b;".into())]
        ]
    );

    // Rows alone run as one transaction: an error keeps nothing.
    let (scanned, report) = run_file(
        &mut s,
        "INSERT INTO it_file_p VALUES (3, 'x');\nINSERT INTO it_file_p VALUES (1, 'dup');\n",
        true,
    )
    .await;
    assert_eq!(scanned.per_statement, None);
    assert!(report.rolled_back && report.failed.is_some(), "{report:?}");
    assert_eq!(count(&mut s, "SELECT COUNT(*) FROM it_file_p").await, 2);
    let (_, report) = run_file(
        &mut s,
        "BEGIN;\nINSERT INTO it_file_p VALUES (3, 'x');\nUPDATE it_file_p SET name = 'y' WHERE id = 3;\nCOMMIT;\n",
        true,
    )
    .await;
    assert_eq!(
        (report.failed.is_none(), report.rows),
        (true, 2),
        "{report:?}"
    );
    assert_eq!(count(&mut s, "SELECT COUNT(*) FROM it_file_p").await, 3);
    // Per statement, the file's own transaction left open rolls back with
    // the session (a temporary table doesn't commit it).
    let mut own = open(config()).await.unwrap();
    let (_, report) = run_file(
        &mut own,
        "BEGIN;\nINSERT INTO it_file_p VALUES (4, 'z');\nCREATE TEMPORARY TABLE it_file_tmp (a int);\nINSERT INTO it_file_p VALUES (5, 'z');\n",
        false,
    )
    .await;
    assert_eq!((report.done, report.lost), (4, 4), "{report:?}");
    drop(own);
    let (_, report) = run_file(
        &mut open(config()).await.unwrap(),
        "BEGIN;\nINSERT INTO it_file_p VALUES (4, 'z');\nCREATE TABLE it_file_x (a int);\nINSERT INTO it_file_p VALUES (5, 'z');\n",
        false,
    )
    .await;
    // The CREATE committed the BEGIN's transaction, and autocommit saved
    // the INSERT after it: nothing was left open to lose.
    assert_eq!((report.done, report.lost), (4, 0), "{report:?}");
    session_execute(&mut s, "DROP TABLE IF EXISTS it_file_x")
        .await
        .unwrap();
    tokio::time::sleep(Duration::from_millis(200)).await;
    assert_eq!(
        count(&mut s, "SELECT COUNT(*) FROM it_file_p WHERE id = 4").await,
        1
    );
    assert_eq!(
        count(&mut s, "SELECT COUNT(*) FROM it_file_p WHERE id = 5").await,
        1
    );
}

#[tokio::test]
async fn sql_files_stop_where_quotes_would_read_otherwise() {
    let mut s = open(config()).await.unwrap();
    session_execute(&mut s, "SET SESSION sql_mode = 'ANSI'")
        .await
        .unwrap();
    let (_, report) = run_file(&mut s, "SELECT 1;\n", false).await;
    let failed = report.failed.unwrap();
    assert!(failed.message.contains("ANSI"), "{failed:?}");
    assert_eq!(report.done, 0);
    session_execute(&mut s, "SET SESSION sql_mode = DEFAULT")
        .await
        .unwrap();
    // Set from a variable, it is caught on the server as the run goes.
    let (_, report) = run_file(
        &mut s,
        "SET @m = 'NO_BACKSLASH_ESCAPES';\nSET SESSION sql_mode = @m;\nSELECT 'a\\'';\n",
        false,
    )
    .await;
    let failed = report.failed.unwrap();
    assert_eq!(failed.line, Some(2));
    assert!(
        failed.message.contains("NO_BACKSLASH_ESCAPES"),
        "{failed:?}"
    );
    assert_eq!(report.done, 2);
    // A character set where `\` can end a character reads quotes otherwise.
    session_execute(&mut s, "SET SESSION sql_mode = DEFAULT")
        .await
        .unwrap();
    let (_, report) = run_file(
        &mut s,
        "SET @c = 'gbk';\nSET character_set_client = @c;\nSELECT 1;\n",
        false,
    )
    .await;
    let failed = report.failed.unwrap();
    assert_eq!(failed.line, Some(2));
    assert!(
        failed.message.contains("character set is gbk"),
        "{failed:?}"
    );
    let (_, report) = run_file(&mut s, "SELECT 1;\n", false).await;
    assert!(report.failed.unwrap().message.contains("gbk"));
    // So does any set but UTF-8 (macroman reads `--好` as a comment), and
    // one switched to at run time is caught after its statement too.
    session_execute(&mut s, "SET NAMES utf8mb4").await.unwrap();
    let (_, report) = run_file(
        &mut s,
        "SET @q = CONCAT('SET NAMES mac', 'roman');\nPREPARE p FROM @q;\nEXECUTE p;\nSELECT 2;\n",
        false,
    )
    .await;
    let failed = report.failed.unwrap();
    assert_eq!(failed.line, Some(3), "{failed:?}");
    assert!(
        failed.message.contains("character set is macroman"),
        "{failed:?}"
    );
}

/// FLOAT cells come back widened to f64, and no literal of that double
/// matches the stored float exactly: pages by such a sort walk by OFFSET.
#[tokio::test]
async fn browse_by_a_float_sort_walks_every_row_once() {
    let mut s = open(config()).await.unwrap();
    session_execute(
        &mut s,
        "DROP TABLE IF EXISTS it_float_pages;
         CREATE TABLE it_float_pages (id INT PRIMARY KEY, f FLOAT, d DOUBLE);
         INSERT INTO it_float_pages VALUES
           (1, 0.1, 1e300), (2, 0.1, 1e-300), (3, 0.2, 0.1), (4, 3.3e38, -1e300),
           (5, 1e-30, 1.5), (6, 0.7, 2.5e-10)",
    )
    .await
    .unwrap();
    for column in ["f", "d"] {
        let mut opts = BrowseOptions::first_page(2);
        opts.key = vec!["id".into()];
        opts.order = vec![BrowseOrder {
            column: column.into(),
            desc: false,
        }];
        let mut seen = Vec::new();
        for _ in 0..6 {
            let sql = table_browse_query(EngineKind::Mysql, "rowkery", "it_float_pages", &opts);
            let page = rows(&mut s, &sql).await;
            if page.is_empty() {
                break;
            }
            let last = page.last().unwrap().clone();
            seen.extend(page.iter().map(|r| r[0].clone()));
            opts.offset += page.len() as u32;
            opts.after = Some(
                [
                    ("id".to_string(), last[0].clone()),
                    (
                        column.to_string(),
                        last[if column == "f" { 1 } else { 2 }].clone(),
                    ),
                ]
                .into_iter()
                .collect(),
            );
        }
        seen.sort_by_key(|v| match v {
            Value::Int(n) => *n,
            _ => 0,
        });
        assert_eq!(
            seen,
            (1..=6).map(Value::Int).collect::<Vec<_>>(),
            "by {column}"
        );
    }
}

/// A double is written so the server reads the same double back: no
/// 301-digit decimal (capped at 65 digits) and no tiny value rounded to 0.
#[tokio::test]
async fn edits_write_doubles_that_read_back_the_same() {
    let mut s = open(config()).await.unwrap();
    session_execute(
        &mut s,
        "DROP TABLE IF EXISTS it_ed_doubles; CREATE TABLE it_ed_doubles (id INT PRIMARY KEY, d DOUBLE)",
    )
    .await
    .unwrap();
    let table = edit_table("it_ed_doubles", &[("id", "int"), ("d", "double")]);
    for (id, f) in [
        (1, 1e300),
        (2, 1e-300),
        (3, 0.1),
        (4, -2.5e-10),
        (5, 123456.75),
    ] {
        let insert = Change::Insert {
            values: vec![cell("id", Value::Int(id)), cell("d", Value::Float(f))],
        };
        apply(&mut s, &table, &[insert], None).await.unwrap();
        let got = rows(
            &mut s,
            &format!("SELECT d FROM it_ed_doubles WHERE id = {id}"),
        )
        .await;
        assert_eq!(got[0][0], Value::Float(f), "{f}");
    }
}
