//! CSV import into MySQL and MariaDB: the file's rows go into a temporary
//! table in batches of multi-row INSERTs (literals that read the same in
//! every `sql_mode`), then into the table, all in one transaction on the
//! import's own connection, under a strict `sql_mode` (a value the column
//! can't hold fails the import, as Postgres would, never stored cut down).
//!
//! An empty cell's column is left out of the INSERT, so the server fills
//! it as the table says (its DEFAULT, AUTO_INCREMENT, NULL): no DEFAULT is
//! copied as text. Rows are inserted grouped by which cells were empty.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};

use mysql_async::prelude::Queryable;

use super::{
    delimiter_byte, next_record, open_reader, thousands, ImportCounts, ImportError, ImportSpec,
    ImportTarget, OnConflict, Plan, TargetColumn,
};
use crate::db::mysql::{
    cancel, cell, humanize_mysql_error, rows_matched, select_text, CancelVia, MysqlSession,
};
use crate::db::{qualified_table_sql, EngineKind, Value};
use crate::edits::literal;
use crate::query_util::mysql_text;

/// Bytes of SQL per staging INSERT, well under any `max_allowed_packet`.
const BATCH: usize = 512 * 1024;
/// The staging table's own columns: its key (a server may require one) and
/// which of the row's cells were empty (`0`/`1` per field).
const ROW: &str = "rowkery_row";
const EMPTY: &str = "rowkery_empty";
/// What the import runs under, whatever the server's default: strict, and
/// none of the modes that change how a literal or `''` reads.
const SQL_MODE: &str = "STRICT_ALL_TABLES,NO_ZERO_IN_DATE,NO_ZERO_DATE,\
    ERROR_FOR_DIVISION_BY_ZERO,NO_ENGINE_SUBSTITUTION";

/// A target column as the staging table repeats it.
struct StageColumn {
    name: String,
    charset: Option<String>,
    collation: Option<String>,
}

/// The table's columns and primary key, each column's character set, and
/// whether the table can roll back.
async fn target(
    session: &mut MysqlSession,
    schema: &str,
    table: &str,
) -> Result<(ImportTarget, Vec<StageColumn>, String), String> {
    let (db, name) = (mysql_text(schema), mysql_text(table));
    let rows = select_text(
        session,
        &format!(
            "SELECT COLUMN_NAME, COLUMN_TYPE, COALESCE(GENERATION_EXPRESSION, '') <> '', \
               CHARACTER_SET_NAME, COLLATION_NAME \
             FROM information_schema.COLUMNS \
             WHERE TABLE_SCHEMA = {db} AND TABLE_NAME = {name} ORDER BY ORDINAL_POSITION"
        ),
    )
    .await
    .map_err(|e| e.into_message())?;
    if rows.is_empty() {
        return Err(format!(
            "{schema}.{table} isn't there, or this login can't see it"
        ));
    }
    let columns = rows
        .iter()
        .map(|r| TargetColumn {
            name: cell(r, 0),
            type_name: cell(r, 1),
            // Never pasted into SQL: an empty cell's column is left out.
            default: None,
            generated: cell(r, 2) == "1",
        })
        .collect();
    let stage = rows
        .iter()
        .map(|r| StageColumn {
            name: cell(r, 0),
            charset: r.get(3).cloned().flatten(),
            collation: r.get(4).cloned().flatten(),
        })
        .collect();
    let key = select_text(
        session,
        &format!(
            "SELECT COLUMN_NAME FROM information_schema.KEY_COLUMN_USAGE \
             WHERE TABLE_SCHEMA = {db} AND TABLE_NAME = {name} AND CONSTRAINT_NAME = 'PRIMARY' \
             ORDER BY ORDINAL_POSITION"
        ),
    )
    .await
    .map_err(|e| e.into_message())?
    .iter()
    .map(|r| cell(r, 0))
    .collect();
    let engine = select_text(
        session,
        &format!(
            "SELECT t.ENGINE, COALESCE(e.TRANSACTIONS, 'NO') FROM information_schema.TABLES t \
             LEFT JOIN information_schema.ENGINES e ON e.ENGINE = t.ENGINE \
             WHERE t.TABLE_SCHEMA = {db} AND t.TABLE_NAME = {name}"
        ),
    )
    .await
    .map_err(|e| e.into_message())?;
    let (engine, rolls_back) = engine
        .first()
        .map(|r| (cell(r, 0), cell(r, 1) == "YES"))
        .unwrap_or_default();
    if !rolls_back {
        return Err(format!(
            "{table} is a {engine} table, which can't roll back: a failed import would leave some rows in. Rowkery imports only into tables that can (InnoDB)."
        ));
    }
    Ok((ImportTarget { columns, key }, stage, engine))
}

/// Runs `work` until it ends or `stop` is set; then `KILL QUERY` stops it
/// and `work` ends with its error.
async fn cancellable<T>(
    via: &CancelVia,
    stop: &AtomicBool,
    work: impl std::future::Future<Output = T>,
) -> T {
    let mut work = std::pin::pin!(work);
    let mut sent = false;
    loop {
        tokio::select! {
            done = &mut work => return done,
            _ = tokio::time::sleep(Duration::from_millis(50)), if !sent => {
                if stop.load(Ordering::SeqCst) {
                    sent = true;
                    let _ = cancel(via.clone()).await;
                }
            }
        }
    }
}

/// One staging INSERT, its rows' file lines in order.
type Batch = (String, Vec<u64>);

/// Reads the file on its own thread into staging INSERTs, stopping at the
/// first bad value or when `stop` is set.
fn spawn_reader(
    spec: ImportSpec,
    target: ImportTarget,
    head: String,
    stop: Arc<AtomicBool>,
) -> tokio::sync::mpsc::Receiver<Result<Batch, ImportError>> {
    let (tx, rx) = tokio::sync::mpsc::channel(4);
    std::thread::spawn(move || {
        let run = || -> Result<(), ImportError> {
            let mut plan = Plan::new(EngineKind::Mysql, &spec, &target)?;
            let mut reader = open_reader(&spec.path, delimiter_byte(&spec.delimiter)?)?;
            let mut record = csv::StringRecord::new();
            let mut sql = String::new();
            let mut lines = Vec::new();
            let mut first = true;
            while next_record(&mut reader, &mut record)? {
                if std::mem::take(&mut first) && spec.header {
                    plan.width = Some(record.len());
                    continue;
                }
                let line = record.position().map_or(0, |p| p.line());
                let values = plan.values(&record)?;
                let mut empty = String::with_capacity(values.len());
                let mut lits = Vec::with_capacity(values.len());
                for (v, (_, col)) in values.iter().zip(&plan.fields) {
                    empty.push(if v.is_some() { '0' } else { '1' });
                    lits.push(match v {
                        None => "NULL".to_string(),
                        Some(text) => literal(
                            EngineKind::Mysql,
                            &col.type_name,
                            &Value::Text(text.clone()),
                        )
                        .map_err(|e| format!("Line {}, {}: {e}", thousands(line), col.name))?,
                    });
                }
                sql.push_str(if lines.is_empty() { &head } else { ", " });
                sql.push_str(&format!("('{empty}', {})", lits.join(", ")));
                lines.push(line);
                if sql.len() >= BATCH {
                    if stop.load(Ordering::SeqCst) {
                        return Err(ImportError::Cancelled);
                    }
                    let batch = (std::mem::take(&mut sql), std::mem::take(&mut lines));
                    if tx.blocking_send(Ok(batch)).is_err() {
                        return Ok(());
                    }
                }
            }
            if !lines.is_empty() {
                let _ = tx.blocking_send(Ok((sql, lines)));
            }
            Ok(())
        };
        if let Err(e) = run() {
            let _ = tx.blocking_send(Err(e));
        }
    });
    rx
}

/// The server's `… at row N` (of a multi-row INSERT) as the file's line,
/// and the staging table named as the table.
fn batch_error(text: &str, lines: &[u64], stage: &str, table: &str) -> String {
    let text = text.replace(stage, table);
    let line = text
        .rfind("at row ")
        .and_then(|at| {
            text[at + 7..]
                .chars()
                .take_while(char::is_ascii_digit)
                .collect::<String>()
                .parse::<usize>()
                .ok()
        })
        .and_then(|n| lines.get(n.checked_sub(1)?));
    match (line, lines.first(), lines.last()) {
        (Some(line), _, _) => format!("Line {}: {text}", thousands(*line)),
        (None, Some(a), Some(b)) => format!("Lines {}–{}: {text}", thousands(*a), thousands(*b)),
        _ => text,
    }
}

/// Imports `spec` on `session`, which must have no transaction open: one
/// transaction, rolled back on any error or a cancel. `progress` hears the
/// rows staged so far.
///
/// Skip leaves out a row that collides with any unique key (MySQL's
/// `ON DUPLICATE KEY`), where Postgres looks at the primary key only.
pub async fn import_mysql(
    session: &mut MysqlSession,
    spec: &ImportSpec,
    stop: Arc<AtomicBool>,
    progress: &(dyn Fn(u64) + Send + Sync),
) -> Result<ImportCounts, ImportError> {
    let start = Instant::now();
    if session.txn_known() != Some(false) {
        return Err("A transaction is open on this connection".into());
    }
    let via = session.cancel_via();
    let stopped = |e: String| match stop.load(Ordering::SeqCst) {
        true => ImportError::Cancelled,
        false => ImportError::Failed(e),
    };
    let (target, stage_columns, _) =
        cancellable(&via, &stop, target(session, &spec.schema, &spec.table))
            .await
            .map_err(stopped)?;
    let plan = Plan::new(EngineKind::Mysql, spec, &target)?;
    // Its own name per connection: never the name of a table it would hide.
    let stage_name = format!("rowkery_import_{}", session.thread_id());
    let stage = qualified_table_sql(EngineKind::Mysql, &spec.schema, &stage_name);
    let mut ddl = vec![
        format!("{ROW} BIGINT AUTO_INCREMENT PRIMARY KEY"),
        format!("{EMPTY} VARCHAR({}) NOT NULL", plan.fields.len().max(1)),
    ];
    for (_, c) in &plan.fields {
        let s = stage_columns
            .iter()
            .find(|s| s.name == c.name)
            .expect("planned");
        let mut col = format!("{} {}", plan.ident(&c.name), c.type_name);
        if let (Some(cs), Some(co)) = (&s.charset, &s.collation) {
            col.push_str(&format!(" CHARACTER SET {cs} COLLATE {co}"));
        }
        col.push_str(" NULL");
        ddl.push(col);
    }
    let config = session.config().clone();
    let message = |e: mysql_async::Error| stopped(humanize_mysql_error(&e, &config));
    let mode = select_text(session, "SELECT @@SESSION.sql_mode")
        .await
        .map_err(|e| ImportError::Failed(e.into_message()))?
        .first()
        .map(|r| cell(r, 0))
        .unwrap_or_default();
    // A temporary table commits nothing, so it is made before the transaction.
    let setup = format!(
        "SET SESSION sql_mode = '{SQL_MODE}'; CREATE TEMPORARY TABLE {stage} ({})",
        ddl.join(", ")
    );
    let made = cancellable(&via, &stop, session.conn().query_drop(setup)).await;
    let result = match made {
        Err(e) => Err(match message(e) {
            ImportError::Failed(text) if text.contains("denied") => ImportError::Failed(format!(
                "{text}. Importing needs the CREATE TEMPORARY TABLES privilege on {}.",
                spec.schema
            )),
            other => other,
        }),
        Ok(()) => {
            let result = run(
                session,
                spec,
                &plan,
                &target,
                &stage,
                &stage_name,
                &via,
                &stop,
                progress,
            )
            .await;
            if result.is_err() {
                let _ = session.conn().query_drop("ROLLBACK").await;
            }
            result
        }
    };
    let _ = session
        .conn()
        .query_drop(format!(
            "DROP TEMPORARY TABLE IF EXISTS {stage}; SET SESSION sql_mode = {}",
            mysql_text(&mode)
        ))
        .await;
    let mut counts = result?;
    counts.elapsed_ms = start.elapsed().as_millis() as u64;
    Ok(counts)
}

#[allow(clippy::too_many_arguments)]
async fn run(
    session: &mut MysqlSession,
    spec: &ImportSpec,
    plan: &Plan<'_>,
    target: &ImportTarget,
    stage: &str,
    stage_name: &str,
    via: &CancelVia,
    stop: &Arc<AtomicBool>,
    progress: &(dyn Fn(u64) + Send + Sync),
) -> Result<ImportCounts, ImportError> {
    let config = session.config().clone();
    let stopped = |e: String| match stop.load(Ordering::SeqCst) {
        true => ImportError::Cancelled,
        false => ImportError::Failed(e),
    };
    let message = |e: mysql_async::Error| stopped(humanize_mysql_error(&e, &config));
    session
        .conn()
        .query_drop("START TRANSACTION")
        .await
        .map_err(message)?;
    let head = format!(
        "INSERT INTO {stage} ({EMPTY}, {}) VALUES ",
        plan.column_list()
    );
    let mut batches = spawn_reader(spec.clone(), target.clone(), head, stop.clone());
    let mut sent = 0u64;
    while let Some(batch) = batches.recv().await {
        let (sql, lines) = batch?;
        cancellable(via, stop, session.conn().query_drop(sql))
            .await
            .map_err(|e| match message(e) {
                ImportError::Failed(text) => {
                    ImportError::Failed(batch_error(&text, &lines, stage_name, &spec.table))
                }
                cancelled => cancelled,
            })?;
        sent += lines.len() as u64;
        progress(sent);
    }
    if stop.load(Ordering::SeqCst) {
        return Err(ImportError::Cancelled);
    }
    // Locks on the table are taken from here on, and a cancel ends the wait.
    let updated = match my_update_sql(plan, stage) {
        Some(sql) => {
            cancellable(via, stop, session.conn().query_drop(sql))
                .await
                .map_err(message)?;
            rows_matched(&session.conn().info()).unwrap_or_else(|| session.conn().affected_rows())
        }
        None => 0,
    };
    // One INSERT for each set of empty cells, in the order the file first has it.
    let masks = select_text(
        session,
        &format!("SELECT {EMPTY} FROM {stage} GROUP BY {EMPTY} ORDER BY MIN({ROW})"),
    )
    .await
    .map_err(|e| stopped(e.into_message()))?;
    let mut inserted = 0;
    for mask in masks.iter().map(|r| cell(r, 0)) {
        if mask.contains('0') {
            let sql = my_insert_sql(plan, stage, &mask);
            cancellable(via, stop, session.conn().query_drop(sql))
                .await
                .map_err(message)?;
            inserted += session.conn().affected_rows();
            continue;
        }
        // Every cell empty: rows of defaults alone, which name no column
        // (and so can't be told apart from a row already there).
        let n: u64 = select_text(
            session,
            &format!(
                "SELECT COUNT(*) FROM {stage} WHERE {EMPTY} = {}",
                mysql_text(&mask)
            ),
        )
        .await
        .map_err(|e| stopped(e.into_message()))?
        .first()
        .and_then(|r| cell(r, 0).parse().ok())
        .unwrap_or(0);
        let mut left = n;
        while left > 0 {
            let take = left.min(1000);
            let sql = format!(
                "INSERT INTO {} () VALUES {}",
                plan.target_sql,
                vec!["()"; take as usize].join(", ")
            );
            cancellable(via, stop, session.conn().query_drop(sql))
                .await
                .map_err(message)?;
            inserted += session.conn().affected_rows();
            left -= take;
        }
    }
    if stop.load(Ordering::SeqCst) {
        return Err(ImportError::Cancelled);
    }
    // Never retried: a COMMIT whose answer was lost may have landed.
    session.conn().query_drop("COMMIT").await.map_err(message)?;
    Ok(ImportCounts {
        inserted,
        updated,
        skipped: sent.saturating_sub(inserted + updated),
        elapsed_ms: 0,
    })
}

/// Update: the rows whose key is already there. An empty cell keeps the
/// row's value.
fn my_update_sql(plan: &Plan, stage: &str) -> Option<String> {
    plan.update_key()?;
    let set: Vec<String> = plan
        .update_fields()
        .map(|(_, c)| {
            let name = plan.ident(&c.name);
            format!("t.{name} = COALESCE(s.{name}, t.{name})")
        })
        .collect();
    if set.is_empty() {
        return None;
    }
    Some(format!(
        "UPDATE {} AS t JOIN {stage} AS s ON {} SET {}",
        plan.target_sql,
        plan.key_match("t", "s"),
        set.join(", ")
    ))
}

/// The staged rows whose empty cells are `mask` (not all of them) into the
/// table, those columns left for the server to fill: on Update the new rows, on Skip all
/// but those a unique key already holds.
fn my_insert_sql(plan: &Plan, stage: &str, mask: &str) -> String {
    let kept: Vec<&TargetColumn> = plan
        .fields
        .iter()
        .zip(mask.chars().chain(std::iter::repeat('0')))
        .filter(|(_, empty)| *empty == '0')
        .map(|((_, c), _)| *c)
        .collect();
    let names: Vec<String> = kept.iter().map(|c| plan.ident(&c.name)).collect();
    let select: Vec<String> = names.iter().map(|n| format!("s.{n}")).collect();
    let only_new = match plan.update_key() {
        Some(_) => format!(
            " AND NOT EXISTS (SELECT 1 FROM {} AS t WHERE {})",
            plan.target_sql,
            plan.key_match("t", "s")
        ),
        None => String::new(),
    };
    // A no-op update: the row stays, and counts as no row changed.
    let skip = match (plan.on_conflict, kept.first()) {
        (OnConflict::Skip, Some(first)) => {
            let first = plan.ident(&first.name);
            format!(
                " ON DUPLICATE KEY UPDATE {0}.{first} = {0}.{first}",
                plan.target_sql
            )
        }
        _ => String::new(),
    };
    format!(
        "INSERT INTO {} ({}) SELECT {} FROM {stage} AS s WHERE s.{EMPTY} = {}{only_new} ORDER BY s.{ROW}{skip}",
        plan.target_sql,
        names.join(", "),
        select.join(", "),
        mysql_text(mask),
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn batch_errors_name_the_line() {
        let lines = [4, 9, 12];
        assert_eq!(
            batch_error(
                "Incorrect date value: 'x' for column `shop`.`rowkery_import_7`.`d` at row 2",
                &lines,
                "rowkery_import_7",
                "orders"
            ),
            "Line 9: Incorrect date value: 'x' for column `shop`.`orders`.`d` at row 2"
        );
        assert_eq!(
            batch_error("Lost connection", &lines, "rowkery_import_7", "orders"),
            "Lines 4–12: Lost connection"
        );
    }

    #[test]
    fn empty_cells_are_left_to_the_server() {
        let target = ImportTarget {
            columns: ["id", "name", "n"]
                .iter()
                .map(|n| TargetColumn {
                    name: n.to_string(),
                    type_name: "int".into(),
                    default: None,
                    generated: false,
                })
                .collect(),
            key: vec!["id".into()],
        };
        let spec = ImportSpec {
            path: String::new(),
            schema: "shop".into(),
            table: "t".into(),
            delimiter: ",".into(),
            header: true,
            columns: ["id", "name", "n"]
                .iter()
                .enumerate()
                .map(|(field, c)| super::super::ImportColumn {
                    field,
                    column: c.to_string(),
                })
                .collect(),
            on_conflict: OnConflict::Skip,
            empty: Default::default(),
        };
        let plan = Plan::new(EngineKind::Mysql, &spec, &target).unwrap();
        assert_eq!(
            my_insert_sql(&plan, "shop.st", "010"),
            "INSERT INTO shop.t (id, n) SELECT s.id, s.n FROM shop.st AS s WHERE s.rowkery_empty = '010' \
             ORDER BY s.rowkery_row ON DUPLICATE KEY UPDATE shop.t.id = shop.t.id"
        );
    }
}
