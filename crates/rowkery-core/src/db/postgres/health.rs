//! The Health tab's checks on Postgres: one read of `pg_catalog` and the
//! `pg_stat_*` views, no table reads. The checks run as one pipeline on the
//! session, and each fails on its own: a view the login may not read marks
//! that check "needs pg_monitor", the rest still report.

use tokio_postgres::error::SqlState;
use tokio_postgres::Row;

use super::{map_query_error, PostgresSession};
use crate::db::DriverError;
use crate::health::{
    days_left, limits, CheckKind, CheckState, ConnectionsTile, Detail, HealthCheck, HealthItem,
    HealthReport, SizeTile, SlowQueries, SlowQuery, MONITOR_ROLE,
};

/// A size or a check waits this long for a table another session holds
/// locked (a migration's ALTER TABLE, VACUUM FULL) before it gives up.
const LOCK_TIMEOUT: &str = "1s";
/// The longest any one read may take.
const STATEMENT_TIMEOUT: &str = "15s";

/// Schemas no check looks in.
const USER_SCHEMA: &str = "n.nspname NOT IN ('pg_catalog', 'information_schema') \
     AND n.nspname NOT LIKE 'pg\\_toast%' AND n.nspname NOT LIKE 'pg\\_temp\\_%'";

/// Sizes take a lock on each relation, so a table locked by a migration
/// makes this wait (up to [`LOCK_TIMEOUT`]): kept apart, so only the size
/// tile goes missing then.
fn size_sql() -> String {
    format!(
        r"
    SELECT pg_database_size(current_database())::int8,
           (SELECT coalesce(sum(pg_table_size(c.oid)), 0)::int8
              FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
             WHERE c.relkind IN ('r', 'm') AND {USER_SCHEMA}),
           (SELECT coalesce(sum(pg_relation_size(c.oid)), 0)::int8
              FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
             WHERE c.relkind = 'i' AND {USER_SCHEMA})
    "
    )
}

const TILES_SQL: &str = r"
    SELECT current_database()::text,
           current_setting('server_version'),
           (SELECT d.blks_hit::float8 / nullif(d.blks_hit + d.blks_read, 0)
              FROM pg_catalog.pg_stat_database d WHERE d.datname = current_database()),
           (SELECT extract(epoch FROM d.stats_reset)::int8
              FROM pg_catalog.pg_stat_database d WHERE d.datname = current_database()),
           (SELECT count(*) FROM pg_catalog.pg_stat_activity a WHERE a.backend_type = 'client backend'),
           (SELECT count(*) FROM pg_catalog.pg_stat_activity a
             WHERE a.backend_type = 'client backend' AND a.state = 'active'),
           current_setting('max_connections')::int8,
           (SELECT age(d.datfrozenxid)::int8 FROM pg_catalog.pg_database d
             WHERE d.datname = current_database()),
           coalesce((SELECT r.rolsuper FROM pg_catalog.pg_roles r WHERE r.rolname = current_user), false)
             OR pg_has_role(current_user, 'pg_read_all_stats', 'MEMBER')
";

/// Integer ids whose sequence is past [`limits::IDS_USED`] of the column's
/// range (or the sequence's own, when smaller).
fn ids_sql() -> String {
    format!(
        r"
    SELECT n.nspname::text, c.relname::text, a.attname::text, format_type(a.atttypid, NULL),
           s.last_value, x.cap,
           coalesce(st.n_tup_ins, 0)::int8,
           extract(epoch FROM clock_timestamp() - sd.stats_reset)::float8,
           concat_ws(E'\n',
               CASE WHEN a.atttypid <> 'int8'::regtype
                    THEN format('ALTER TABLE %I.%I ALTER COLUMN %I TYPE bigint;', n.nspname, c.relname, a.attname) END,
               CASE WHEN d.deptype = 'a' AND s.data_type <> 'bigint'::regtype
                    THEN format('ALTER SEQUENCE %I.%I AS bigint;', sn.nspname, sc.relname) END)
    FROM pg_catalog.pg_depend d
    JOIN pg_catalog.pg_class sc ON sc.oid = d.objid AND sc.relkind = 'S'
    JOIN pg_catalog.pg_namespace sn ON sn.oid = sc.relnamespace
    JOIN pg_catalog.pg_sequences s ON s.schemaname = sn.nspname AND s.sequencename = sc.relname
    JOIN pg_catalog.pg_class c ON c.oid = d.refobjid
    JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
    JOIN pg_catalog.pg_attribute a ON a.attrelid = c.oid AND a.attnum = d.refobjsubid
    LEFT JOIN pg_catalog.pg_stat_user_tables st ON st.relid = c.oid
    LEFT JOIN pg_catalog.pg_stat_database sd ON sd.datname = current_database()
    CROSS JOIN LATERAL (SELECT least(s.max_value, CASE a.atttypid
                 WHEN 'int2'::regtype THEN 32767
                 WHEN 'int4'::regtype THEN 2147483647
                 ELSE 9223372036854775807 END)::int8 AS cap) x
    WHERE d.classid = 'pg_catalog.pg_class'::regclass
      AND d.refclassid = 'pg_catalog.pg_class'::regclass
      AND d.deptype IN ('a', 'i')
      AND s.increment_by > 0
      AND s.last_value IS NOT NULL
      AND s.last_value::float8 / x.cap > {used}
      AND {USER_SCHEMA}
    ORDER BY s.last_value::float8 / x.cap DESC
    ",
        used = limits::IDS_USED,
    )
}

/// The tables holding the database's transaction age back.
const OLDEST_TABLES_SQL: &str = "
    SELECT n.nspname::text, c.relname::text, age(c.relfrozenxid)::int8, coalesce(pg_table_size(c.oid), 0)::int8,
           format('VACUUM (FREEZE, VERBOSE) %I.%I;', n.nspname, c.relname)
    FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
    WHERE c.relkind IN ('r', 'm') AND n.nspname <> 'information_schema'
      AND n.nspname NOT LIKE 'pg\\_temp\\_%'
    ORDER BY age(c.relfrozenxid) DESC
    LIMIT 5
";

fn slots_sql() -> String {
    format!(
        r"
    SELECT x.slot_name, x.slot_type, x.wal,
           format('SELECT pg_drop_replication_slot(%L);', x.slot_name)
    FROM (SELECT s.slot_name::text, s.slot_type::text,
                 pg_wal_lsn_diff(CASE WHEN pg_is_in_recovery() THEN pg_last_wal_replay_lsn()
                                      ELSE pg_current_wal_lsn() END, s.restart_lsn)::int8 AS wal
            FROM pg_catalog.pg_replication_slots s
           WHERE NOT s.active AND s.restart_lsn IS NOT NULL) x
    WHERE x.wal > {bytes}
    ORDER BY x.wal DESC
    ",
        bytes = limits::SLOT_WAL_BYTES,
    )
}

/// Not a partition's piece of a partitioned index (it can't be dropped on
/// its own) and not backing a constraint.
const DROPPABLE_INDEX: &str =
    "NOT EXISTS (SELECT 1 FROM pg_catalog.pg_constraint k WHERE k.conindid = i.indexrelid) \
     AND NOT EXISTS (SELECT 1 FROM pg_catalog.pg_inherits h WHERE h.inhrelid = i.indexrelid)";

fn unused_sql() -> String {
    format!(
        r"
    SELECT s.schemaname::text, s.relname::text, s.indexrelname::text,
           coalesce(pg_relation_size(s.indexrelid), 0)::int8,
           format('DROP INDEX CONCURRENTLY %I.%I;', s.schemaname, s.indexrelname)
    FROM pg_catalog.pg_stat_user_indexes s
    JOIN pg_catalog.pg_index i ON i.indexrelid = s.indexrelid
    WHERE s.idx_scan = 0 AND NOT i.indisunique AND NOT i.indisprimary AND i.indisvalid
      AND {DROPPABLE_INDEX}
      AND pg_relation_size(s.indexrelid) > {bytes}
    ORDER BY 4 DESC
    ",
        bytes = limits::UNUSED_INDEX_BYTES,
    )
}

/// A plain (no expression, no predicate, no INCLUDE) non-unique btree index
/// whose key columns lead another btree index on the same table, with the
/// same operator classes and collations. Of two identical indexes, the
/// newer one is reported, unless only the older one isn't unique.
fn duplicates_sql() -> String {
    format!(
        r"
    WITH ix AS (
        SELECT i.indexrelid, i.indrelid, i.indisunique, i.indisprimary,
               (string_to_array(i.indkey::text, ' ')::int2[])[1:i.indnkeyatts] AS cols,
               (string_to_array(i.indclass::text, ' ')::oid[])[1:i.indnkeyatts] AS ops,
               (string_to_array(i.indcollation::text, ' ')::oid[])[1:i.indnkeyatts] AS colls,
               i.indoption, i.indnatts = i.indnkeyatts AS no_include,
               i.indexprs IS NULL AND i.indpred IS NULL AS plain,
               n.nspname, t.relname AS tbl, c.relname AS idx, c.relkind = 'I' AS partitioned
        FROM pg_catalog.pg_index i
        JOIN pg_catalog.pg_class c ON c.oid = i.indexrelid
        JOIN pg_catalog.pg_am am ON am.oid = c.relam AND am.amname = 'btree'
        JOIN pg_catalog.pg_class t ON t.oid = i.indrelid
        JOIN pg_catalog.pg_namespace n ON n.oid = t.relnamespace
        WHERE i.indisvalid AND {USER_SCHEMA}
    )
    SELECT DISTINCT ON (a.indexrelid)
           a.nspname::text, a.tbl::text, a.idx::text, b.idx::text,
           coalesce(pg_relation_size(a.indexrelid), 0)::int8,
           -- A partitioned table's index can't be dropped concurrently.
           format(CASE WHEN a.partitioned THEN 'DROP INDEX %I.%I;' ELSE 'DROP INDEX CONCURRENTLY %I.%I;' END,
                  a.nspname, a.idx)
    FROM ix a
    JOIN ix b ON b.indrelid = a.indrelid AND b.indexrelid <> a.indexrelid AND b.plain
    JOIN pg_catalog.pg_index i ON i.indexrelid = a.indexrelid
    WHERE a.plain AND a.no_include AND NOT a.indisunique AND NOT a.indisprimary
      AND {DROPPABLE_INDEX}
      AND cardinality(a.cols) <= cardinality(b.cols)
      AND b.cols[1:cardinality(a.cols)] = a.cols
      AND b.ops[1:cardinality(a.ops)] = a.ops
      AND b.colls[1:cardinality(a.colls)] = a.colls
      AND (string_to_array(b.indoption::text, ' '))[1:cardinality(a.cols)]
          = string_to_array(a.indoption::text, ' ')
      AND (cardinality(a.cols) < cardinality(b.cols) OR b.indisunique OR b.indexrelid < a.indexrelid)
    ORDER BY a.indexrelid, cardinality(b.cols), b.indexrelid
    "
    )
}

/// Foreign keys on tables over [`limits::ROWS`] whose columns lead no valid
/// btree index (in any order). A partitioned table's key is reported once,
/// on the parent, with its rows summed over the partitions.
fn fk_sql() -> String {
    format!(
        r"
    SELECT n.nspname::text, t.relname::text, k.conname::text,
           array(SELECT a.attname::text
                   FROM unnest(k.conkey) WITH ORDINALITY u(attnum, ord)
                   JOIN pg_catalog.pg_attribute a ON a.attrelid = k.conrelid AND a.attnum = u.attnum
                  ORDER BY u.ord),
           pn.nspname || '.' || p.relname,
           x.rows,
           -- A partitioned table's index can't be built concurrently.
           format(CASE WHEN t.relkind = 'p' THEN 'CREATE INDEX ON %I.%I (%s);'
                       ELSE 'CREATE INDEX CONCURRENTLY ON %I.%I (%s);' END,
                  n.nspname, t.relname,
                  (SELECT string_agg(quote_ident(a.attname), ', ' ORDER BY u.ord)
                     FROM unnest(k.conkey) WITH ORDINALITY u(attnum, ord)
                     JOIN pg_catalog.pg_attribute a ON a.attrelid = k.conrelid AND a.attnum = u.attnum))
    FROM pg_catalog.pg_constraint k
    JOIN pg_catalog.pg_class t ON t.oid = k.conrelid AND t.relkind IN ('r', 'p')
    JOIN pg_catalog.pg_namespace n ON n.oid = t.relnamespace
    JOIN pg_catalog.pg_class p ON p.oid = k.confrelid
    JOIN pg_catalog.pg_namespace pn ON pn.oid = p.relnamespace
    CROSS JOIN LATERAL (SELECT CASE WHEN t.relkind = 'p'
             THEN (SELECT coalesce(sum(greatest(c.reltuples, 0)), 0)
                     FROM pg_catalog.pg_partition_tree(t.oid) pt
                     JOIN pg_catalog.pg_class c ON c.oid = pt.relid WHERE pt.isleaf)
             ELSE t.reltuples END::int8 AS rows) x
    WHERE k.contype = 'f' AND k.conparentid = 0 AND x.rows > {rows} AND {USER_SCHEMA}
      AND NOT EXISTS (
          SELECT 1 FROM pg_catalog.pg_index i
          JOIN pg_catalog.pg_class ic ON ic.oid = i.indexrelid
          JOIN pg_catalog.pg_am am ON am.oid = ic.relam AND am.amname = 'btree'
          WHERE i.indrelid = k.conrelid AND i.indpred IS NULL AND i.indisvalid
            AND cardinality(k.conkey) <= i.indnkeyatts
            AND (string_to_array(i.indkey::text, ' ')::int2[])[1:cardinality(k.conkey)] @> k.conkey
            AND (string_to_array(i.indkey::text, ' ')::int2[])[1:cardinality(k.conkey)] <@ k.conkey)
    ORDER BY x.rows DESC
    ",
        rows = limits::ROWS,
    )
}

fn dead_rows_sql() -> String {
    format!(
        r"
    SELECT s.schemaname::text, s.relname::text, s.n_dead_tup::int8, s.n_live_tup::int8,
           extract(epoch FROM clock_timestamp() - greatest(s.last_vacuum, s.last_autovacuum))::float8,
           coalesce(pg_table_size(s.relid), 0)::int8,
           format('VACUUM (ANALYZE) %I.%I;', s.schemaname, s.relname)
    FROM pg_catalog.pg_stat_user_tables s
    WHERE s.n_live_tup + s.n_dead_tup > {rows}
      AND s.n_dead_tup::float8 / (s.n_live_tup + s.n_dead_tup) > {share}
      AND coalesce(greatest(s.last_vacuum, s.last_autovacuum)
                   < clock_timestamp() - interval '{days} days', true)
    ORDER BY s.n_dead_tup DESC
    ",
        rows = limits::ROWS,
        share = limits::DEAD_SHARE,
        days = limits::VACUUM_DAYS,
    )
}

fn never_analyzed_sql() -> String {
    format!(
        r"
    SELECT s.schemaname::text, s.relname::text, s.n_live_tup::int8,
           format('ANALYZE %I.%I;', s.schemaname, s.relname)
    FROM pg_catalog.pg_stat_user_tables s
    WHERE s.last_analyze IS NULL AND s.last_autoanalyze IS NULL AND s.n_live_tup > {rows}
    ORDER BY s.n_live_tup DESC
    ",
        rows = limits::ROWS,
    )
}

fn long_xact_sql() -> String {
    format!(
        r"
    SELECT a.pid, a.usename::text,
           extract(epoch FROM clock_timestamp() - a.state_change)::float8,
           extract(epoch FROM clock_timestamp() - a.xact_start)::float8
    FROM pg_catalog.pg_stat_activity a
    WHERE a.datname = current_database() AND a.pid <> pg_backend_pid()
      AND a.state IN ('idle in transaction', 'idle in transaction (aborted)')
      AND a.state_change < clock_timestamp() - interval '{secs} seconds'
    ORDER BY a.state_change
    ",
        secs = limits::IDLE_XACT_SECS,
    )
}

/// Where the extension lives, and whether its view has the Postgres 13
/// column names: those come with extension version 1.8, which a server
/// upgraded without `ALTER EXTENSION … UPDATE` may not have.
const PGSS_SCHEMA_SQL: &str = "SELECT quote_ident(n.nspname), \
     string_to_array(e.extversion, '.')::int[] >= '{1,8}' \
     FROM pg_catalog.pg_extension e JOIN pg_catalog.pg_namespace n ON n.oid = e.extnamespace \
     WHERE e.extname = 'pg_stat_statements'";

fn pgss_sql(schema: &str, exec_names: bool) -> String {
    let (total, mean) = if exec_names {
        ("total_exec_time", "mean_exec_time")
    } else {
        ("total_time", "mean_time")
    };
    format!(
        r"
    WITH s AS (
        SELECT s.query, s.userid, s.calls, s.{total} AS total, s.{mean} AS mean, s.rows
        FROM {schema}.pg_stat_statements s
        WHERE s.dbid = (SELECT d.oid FROM pg_catalog.pg_database d WHERE d.datname = current_database())
    ), sum AS (SELECT nullif(sum(total), 0) AS t FROM s)
    SELECT s.query, r.rolname::text, s.calls::int8, s.total::float8, s.mean::float8, s.rows::int8,
           coalesce(s.total / sum.t, 0)::float8,
           s.query = '<insufficient privilege>'
    FROM s CROSS JOIN sum
    LEFT JOIN pg_catalog.pg_roles r ON r.oid = s.userid
    -- NULL when the extension couldn't read its query text file.
    WHERE s.query IS NOT NULL
    ORDER BY s.total DESC
    LIMIT {n}
    ",
        n = limits::SLOW_QUERIES,
    )
}

/// What a failed check reports.
fn failed(error: &tokio_postgres::Error, username: &str) -> CheckState {
    if error.code() == Some(&SqlState::INSUFFICIENT_PRIVILEGE) {
        return CheckState::NeedsRole {
            role: MONITOR_ROLE.into(),
        };
    }
    if error.code() == Some(&SqlState::LOCK_NOT_AVAILABLE) {
        return CheckState::Unavailable {
            message: "A table it reads is locked by another session. Try Refresh later.".into(),
        };
    }
    if error.code() == Some(&SqlState::QUERY_CANCELED) {
        return CheckState::Unavailable {
            message: "It took too long and was stopped.".into(),
        };
    }
    CheckState::Unavailable {
        message: map_query_error(error, username).to_string(),
    }
}

fn check(
    kind: CheckKind,
    rows: Result<Vec<Row>, tokio_postgres::Error>,
    username: &str,
    item: impl Fn(&Row) -> HealthItem,
) -> HealthCheck {
    match rows {
        Ok(rows) => HealthCheck::of(kind, false, rows.iter().map(item).collect()),
        Err(e) => HealthCheck::new(kind, false, failed(&e, username)),
    }
}

/// The database's health, read on `session` (never a tab's: a check that
/// fails mustn't abort the user's transaction).
pub async fn session_health(session: &PostgresSession) -> Result<HealthReport, DriverError> {
    let username = session.config.username.as_str();
    session
        .client
        .batch_execute(&format!(
            "SET lock_timeout = '{LOCK_TIMEOUT}'; SET statement_timeout = '{STATEMENT_TIMEOUT}'"
        ))
        .await
        .map_err(|e| map_query_error(&e, username))?;
    let read = read_health(session).await;
    // The session is the window's own, shared with the Sessions tab.
    let reset = session
        .client
        .batch_execute("RESET lock_timeout; RESET statement_timeout")
        .await
        .map_err(|e| map_query_error(&e, username));
    let report = read?;
    reset?;
    Ok(report)
}

async fn read_health(session: &PostgresSession) -> Result<HealthReport, DriverError> {
    let client = &session.client;
    let username = session.config.username.as_str();
    let sql = [
        TILES_SQL.to_string(),
        size_sql(),
        ids_sql(),
        slots_sql(),
        unused_sql(),
        duplicates_sql(),
        fk_sql(),
        dead_rows_sql(),
        never_analyzed_sql(),
        long_xact_sql(),
    ];
    let (tiles, size, ids, slots, unused, duplicates, fks, dead, analyzed, idle, pgss) = tokio::join!(
        client.query_one(&sql[0], &[]),
        client.query_one(&sql[1], &[]),
        client.query(&sql[2], &[]),
        client.query(&sql[3], &[]),
        client.query(&sql[4], &[]),
        client.query(&sql[5], &[]),
        client.query(&sql[6], &[]),
        client.query(&sql[7], &[]),
        client.query(&sql[8], &[]),
        client.query(&sql[9], &[]),
        client.query_opt(PGSS_SCHEMA_SQL, &[]),
    );
    let tiles = tiles.map_err(|e| map_query_error(&e, username))?;
    let sees_all: bool = tiles.get(8);
    let xact_age: Option<i64> = tiles.get(7);

    let transaction_age = match xact_age {
        Some(age) if age as f64 > limits::XACT_LIMIT as f64 * limits::XACT_AGE => check(
            CheckKind::TransactionAge,
            client.query(OLDEST_TABLES_SQL, &[]).await,
            username,
            |r| HealthItem {
                schema: Some(r.get(0)),
                table: Some(r.get(1)),
                name: None,
                bytes: Some(r.get(3)),
                detail: Detail::TransactionAge {
                    age: r.get(2),
                    limit: limits::XACT_LIMIT,
                },
                fix: Some(r.get(4)),
            },
        ),
        _ => HealthCheck::of(CheckKind::TransactionAge, false, Vec::new()),
    };

    let mut idle = check(CheckKind::LongTransactions, idle, username, |r| {
        HealthItem {
            schema: None,
            table: None,
            name: Some(r.get::<_, i32>(0).to_string()),
            bytes: None,
            detail: Detail::LongTransaction {
                pid: r.get(0),
                user: r.get(1),
                idle_secs: r.get(2),
                xact_secs: r.get(3),
            },
            fix: None,
        }
    });
    // Other logins' sessions show no state without pg_read_all_stats, so
    // "none found" would be a guess.
    if !sees_all && idle.state == CheckState::Fine {
        idle.state = CheckState::NeedsRole {
            role: MONITOR_ROLE.into(),
        };
    }

    let checks = vec![
        check(CheckKind::IdsRunningOut, ids, username, |r| {
            let used: i64 = r.get(4);
            let max: i64 = r.get(5);
            let secs: Option<f64> = r.get(7);
            HealthItem {
                schema: Some(r.get(0)),
                table: Some(r.get(1)),
                name: Some(r.get(2)),
                bytes: None,
                detail: Detail::IdsRunningOut {
                    type_name: r.get(3),
                    used,
                    max,
                    days_left: secs.and_then(|s| days_left(used, max, r.get(6), s)),
                },
                fix: Some(r.get(8)),
            }
        }),
        transaction_age,
        check(CheckKind::ReplicationSlots, slots, username, |r| {
            HealthItem {
                schema: None,
                table: None,
                name: Some(r.get(0)),
                bytes: Some(r.get(2)),
                detail: Detail::ReplicationSlot {
                    slot_type: r.get(1),
                    wal_bytes: r.get(2),
                },
                fix: Some(r.get(3)),
            }
        }),
        check(CheckKind::UnusedIndexes, unused, username, |r| HealthItem {
            schema: Some(r.get(0)),
            table: Some(r.get(1)),
            name: Some(r.get(2)),
            bytes: Some(r.get(3)),
            detail: Detail::UnusedIndex,
            fix: Some(r.get(4)),
        }),
        check(CheckKind::DuplicateIndexes, duplicates, username, |r| {
            HealthItem {
                schema: Some(r.get(0)),
                table: Some(r.get(1)),
                name: Some(r.get(2)),
                bytes: Some(r.get(4)),
                detail: Detail::DuplicateIndex {
                    covered_by: r.get(3),
                },
                fix: Some(r.get(5)),
            }
        }),
        check(CheckKind::ForeignKeysWithoutIndex, fks, username, |r| {
            HealthItem {
                schema: Some(r.get(0)),
                table: Some(r.get(1)),
                name: Some(r.get(2)),
                bytes: None,
                detail: Detail::ForeignKeyWithoutIndex {
                    constraint: r.get(2),
                    columns: r.get(3),
                    references: r.get(4),
                    rows: Some(r.get(5)),
                },
                fix: Some(r.get(6)),
            }
        }),
        check(CheckKind::DeadRows, dead, username, |r| HealthItem {
            schema: Some(r.get(0)),
            table: Some(r.get(1)),
            name: None,
            bytes: Some(r.get(5)),
            detail: Detail::DeadRows {
                dead: r.get(2),
                live: r.get(3),
                vacuumed_secs_ago: r.get(4),
            },
            fix: Some(r.get(6)),
        }),
        check(CheckKind::NeverAnalyzed, analyzed, username, |r| {
            HealthItem {
                schema: Some(r.get(0)),
                table: Some(r.get(1)),
                name: None,
                bytes: None,
                detail: Detail::NeverAnalyzed {
                    rows: Some(r.get(2)),
                },
                fix: Some(r.get(3)),
            }
        }),
        idle,
    ];

    let slow_queries = slow_queries(session, pgss, sees_all).await;
    let size = size.ok().map(|r| SizeTile {
        total_bytes: r.get(0),
        table_bytes: Some(r.get(1)),
        index_bytes: Some(r.get(2)),
    });
    Ok(HealthReport {
        database: tiles.get(0),
        // `16.4 (Ubuntu 16.4-1)` reads as `16.4`.
        server: format!(
            "Postgres {}",
            tiles
                .get::<_, &str>(1)
                .split_whitespace()
                .next()
                .unwrap_or("")
        ),
        size,
        cache_hit: tiles.get(2),
        connections: Some(ConnectionsTile {
            used: tiles.get(4),
            max: tiles.get(6),
            active: tiles.get(5),
        }),
        stats_since: tiles.get(3),
        transaction_age: xact_age.map(|a| a as f64 / limits::XACT_LIMIT as f64),
        checks,
        slow_queries,
    })
}

async fn slow_queries(
    session: &PostgresSession,
    extension: Result<Option<Row>, tokio_postgres::Error>,
    sees_all: bool,
) -> SlowQueries {
    let unavailable = |e: &tokio_postgres::Error| SlowQueries::Unavailable {
        message: map_query_error(e, &session.config.username).to_string(),
    };
    let row = match extension {
        Ok(Some(row)) => row,
        Ok(None) => {
            return SlowQueries::Off {
                loaded: preloaded(session).await,
            }
        }
        Err(e) => return unavailable(&e),
    };
    let (schema, exec_names): (String, bool) = (row.get(0), row.get(1));
    match session
        .client
        .query(&pgss_sql(&schema, exec_names), &[])
        .await
    {
        Ok(rows) => {
            let hidden = rows.iter().any(|r| r.get::<_, bool>(7));
            SlowQueries::Ranked {
                queries: rows
                    .iter()
                    .filter(|r| !r.get::<_, bool>(7))
                    .map(|r| SlowQuery {
                        query: r.get(0),
                        user: r.get(1),
                        calls: r.get(2),
                        total_ms: r.get(3),
                        mean_ms: r.get(4),
                        rows: r.get(5),
                        share: r.get(6),
                    })
                    .collect(),
                partial: hidden || !sees_all,
            }
        }
        // "pg_stat_statements must be loaded via shared_preload_libraries"
        Err(e) if e.code() == Some(&SqlState::OBJECT_NOT_IN_PREREQUISITE_STATE) => {
            SlowQueries::Off { loaded: false }
        }
        Err(e) if e.code() == Some(&SqlState::INSUFFICIENT_PRIVILEGE) => SlowQueries::NeedsRole {
            role: MONITOR_ROLE.into(),
        },
        Err(e) => unavailable(&e),
    }
}

/// Whether the server loads `pg_stat_statements` (so only `CREATE
/// EXTENSION` is missing). A login that may not read the setting reads as
/// not loaded.
async fn preloaded(session: &PostgresSession) -> bool {
    session
        .client
        .query_one(
            "SELECT coalesce(current_setting('shared_preload_libraries', true), '')",
            &[],
        )
        .await
        .map(|r| {
            r.get::<_, String>(0)
                .split(',')
                .any(|lib| lib.trim().trim_matches('"') == "pg_stat_statements")
        })
        .unwrap_or(false)
}
