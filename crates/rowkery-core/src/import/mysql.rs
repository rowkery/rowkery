//! CSV import into MySQL and MariaDB: the file's rows go into a temporary
//! table in batches of multi-row INSERTs (literals that read the same in
//! every `sql_mode`), then into the table in one statement per outcome,
//! all in one transaction on the import's own connection.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};

use mysql_async::prelude::Queryable;

use super::{
    delimiter_byte, next_record, open_reader, thousands, ImportCounts, ImportError, ImportSpec,
    ImportTarget, OnConflict, Plan, TargetColumn,
};
use crate::db::mysql::{
    cancel, cell, humanize_mysql_error, rows_matched, text_rows, CancelVia, Flavor, MysqlSession,
};
use crate::db::{qualified_table_sql, EngineKind, Value};
use crate::edits::literal;
use crate::query_util::mysql_text;

/// The staging table, in the target's database (a session may have none).
const STAGE: &str = "rowkery_import_stage";
/// Bytes of SQL per staging INSERT, well under any `max_allowed_packet`.
const BATCH: usize = 512 * 1024;

/// A target column as the staging table repeats it.
struct StageColumn {
    column: TargetColumn,
    charset: Option<String>,
    collation: Option<String>,
}

/// The table's columns (with DEFAULTs as SQL, never a generated column's
/// expression) and primary key, and each column's character set.
async fn target(
    session: &mut MysqlSession,
    schema: &str,
    table: &str,
) -> Result<(ImportTarget, Vec<StageColumn>), String> {
    let (db, name) = (mysql_text(schema), mysql_text(table));
    let mariadb = session.flavor() == Flavor::Mariadb;
    let rows = text_rows(
        session,
        &format!(
            "SELECT COLUMN_NAME, COLUMN_TYPE, COLUMN_DEFAULT, EXTRA, \
               COALESCE(GENERATION_EXPRESSION, '') <> '', CHARACTER_SET_NAME, COLLATION_NAME \
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
    let stage = rows
        .iter()
        .map(|r| {
            let type_name = cell(r, 1);
            let generated = cell(r, 4) == "1";
            let default = r
                .get(2)
                .cloned()
                .flatten()
                .and_then(|d| default_sql(mariadb, &type_name, &d, &cell(r, 3)));
            StageColumn {
                column: TargetColumn {
                    name: cell(r, 0),
                    type_name,
                    default: (!generated).then_some(default).flatten(),
                    generated,
                },
                charset: r.get(5).cloned().flatten(),
                collation: r.get(6).cloned().flatten(),
            }
        })
        .collect::<Vec<_>>();
    let key = text_rows(
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
    Ok((
        ImportTarget {
            columns: stage.iter().map(|c| c.column.clone()).collect(),
            key,
        },
        stage,
    ))
}

/// `COLUMN_DEFAULT` as SQL. MariaDB writes it as SQL already (`'a'`,
/// `current_timestamp()`, `NULL`); MySQL writes a literal bare, and an
/// expression bare with `DEFAULT_GENERATED` in `EXTRA`.
fn default_sql(mariadb: bool, type_name: &str, default: &str, extra: &str) -> Option<String> {
    if mariadb {
        return (!default.eq_ignore_ascii_case("NULL")).then(|| default.to_string());
    }
    if extra.contains("DEFAULT_GENERATED") {
        return Some(format!("({default})"));
    }
    if type_name.starts_with("bit") && default.starts_with("b'") {
        return Some(default.to_string());
    }
    Some(mysql_text(default))
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

/// One staging INSERT, the rows it holds and the file lines they came from.
type Batch = (String, u64, (u64, u64));

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
            let mut rows = 0u64;
            let mut lines = (0u64, 0u64);
            let mut first = true;
            while next_record(&mut reader, &mut record)? {
                if std::mem::take(&mut first) && spec.header {
                    plan.width = Some(record.len());
                    continue;
                }
                let line = record.position().map_or(0, |p| p.line());
                let values = plan.values(&record)?;
                let lits = values
                    .iter()
                    .zip(&plan.fields)
                    .map(|(v, (_, col))| match v {
                        None => Ok("NULL".to_string()),
                        Some(text) => literal(
                            EngineKind::Mysql,
                            &col.type_name,
                            &Value::Text(text.clone()),
                        )
                        .map_err(|e| format!("Line {}, {}: {e}", thousands(line), col.name)),
                    })
                    .collect::<Result<Vec<_>, String>>()?;
                if rows == 0 {
                    sql.push_str(&head);
                    lines.0 = line;
                } else {
                    sql.push_str(", ");
                }
                sql.push('(');
                sql.push_str(&lits.join(", "));
                sql.push(')');
                rows += 1;
                lines.1 = line;
                if sql.len() >= BATCH {
                    if stop.load(Ordering::SeqCst) {
                        return Err(ImportError::Cancelled);
                    }
                    if tx
                        .blocking_send(Ok((std::mem::take(&mut sql), rows, lines)))
                        .is_err()
                    {
                        return Ok(());
                    }
                    rows = 0;
                }
            }
            if rows > 0 {
                let _ = tx.blocking_send(Ok((sql, rows, lines)));
            }
            Ok(())
        };
        if let Err(e) = run() {
            let _ = tx.blocking_send(Err(e));
        }
    });
    rx
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
    let (target, stage_columns) =
        cancellable(&via, &stop, target(session, &spec.schema, &spec.table))
            .await
            .map_err(stopped)?;
    let plan = Plan::new(EngineKind::Mysql, spec, &target)?;
    let stage = qualified_table_sql(EngineKind::Mysql, &spec.schema, STAGE);
    let ddl: Vec<String> = plan
        .fields
        .iter()
        .map(|(_, c)| {
            let s = stage_columns
                .iter()
                .find(|s| s.column.name == c.name)
                .expect("planned");
            let mut col = format!("{} {}", plan.ident(&c.name), c.type_name);
            if let (Some(cs), Some(co)) = (&s.charset, &s.collation) {
                col.push_str(&format!(" CHARACTER SET {cs} COLLATE {co}"));
            }
            col.push_str(" NULL");
            col
        })
        .collect();
    let config = session.config().clone();
    let message = |e: mysql_async::Error| stopped(humanize_mysql_error(&e, &config));
    // A temporary table commits nothing, so it is made before the transaction.
    let setup = format!(
        "DROP TEMPORARY TABLE IF EXISTS {stage}; CREATE TEMPORARY TABLE {stage} ({})",
        ddl.join(", ")
    );
    cancellable(&via, &stop, session.conn().query_drop(setup))
        .await
        .map_err(message)?;
    let result = async {
        session
            .conn()
            .query_drop("START TRANSACTION")
            .await
            .map_err(message)?;
        let head = format!("INSERT INTO {stage} ({}) VALUES ", plan.column_list());
        let mut batches = spawn_reader(spec.clone(), target.clone(), head, stop.clone());
        let mut sent = 0u64;
        while let Some(batch) = batches.recv().await {
            let (sql, n, (from, to)) = batch?;
            cancellable(&via, &stop, session.conn().query_drop(sql))
                .await
                .map_err(|e| match message(e) {
                    ImportError::Failed(text) => ImportError::Failed(format!(
                        "Lines {}–{}: {text}",
                        thousands(from),
                        thousands(to)
                    )),
                    cancelled => cancelled,
                })?;
            sent += n;
            progress(sent);
        }
        if stop.load(Ordering::SeqCst) {
            return Err(ImportError::Cancelled);
        }
        // Locks on the table are taken from here on, and a cancel ends the wait.
        let updated = match my_update_sql(&plan, &stage) {
            Some(sql) => {
                cancellable(&via, &stop, session.conn().query_drop(sql))
                    .await
                    .map_err(message)?;
                rows_matched(&session.conn().info())
                    .unwrap_or_else(|| session.conn().affected_rows())
            }
            None => 0,
        };
        cancellable(
            &via,
            &stop,
            session.conn().query_drop(my_insert_sql(&plan, &stage)),
        )
        .await
        .map_err(message)?;
        let inserted = session.conn().affected_rows();
        if stop.load(Ordering::SeqCst) {
            return Err(ImportError::Cancelled);
        }
        // Never retried: a COMMIT whose answer was lost may have landed.
        session.conn().query_drop("COMMIT").await.map_err(message)?;
        Ok(ImportCounts {
            inserted,
            updated,
            skipped: sent.saturating_sub(inserted + updated),
            elapsed_ms: start.elapsed().as_millis() as u64,
        })
    }
    .await;
    if result.is_err() {
        let _ = session.conn().query_drop("ROLLBACK").await;
    }
    let _ = session
        .conn()
        .query_drop(format!("DROP TEMPORARY TABLE IF EXISTS {stage}"))
        .await;
    result
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

/// The staged rows into the table: on Update the new ones, on Skip all but
/// those a unique key already holds.
fn my_insert_sql(plan: &Plan, stage: &str) -> String {
    let select: Vec<String> = plan
        .fields
        .iter()
        .map(|(_, c)| plan.or_default(format!("s.{}", plan.ident(&c.name)), c))
        .collect();
    let only_new = match plan.update_key() {
        Some(_) => format!(
            " WHERE NOT EXISTS (SELECT 1 FROM {} AS t WHERE {})",
            plan.target_sql,
            plan.key_match("t", "s")
        ),
        None => String::new(),
    };
    // A no-op update: the row stays, and counts as no row changed.
    let skip = match plan.on_conflict {
        OnConflict::Skip => {
            let first = plan.ident(&plan.fields[0].1.name);
            format!(
                " ON DUPLICATE KEY UPDATE {0}.{first} = {0}.{first}",
                plan.target_sql
            )
        }
        OnConflict::Stop | OnConflict::Update => String::new(),
    };
    format!(
        "INSERT INTO {} ({}) SELECT {} FROM {stage} AS s{only_new}{skip}",
        plan.target_sql,
        plan.column_list(),
        select.join(", ")
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn mysql_defaults_become_sql() {
        assert_eq!(
            default_sql(false, "varchar(5)", "it's", ""),
            Some("'it''s'".into())
        );
        assert_eq!(
            default_sql(false, "timestamp", "CURRENT_TIMESTAMP", "DEFAULT_GENERATED"),
            Some("(CURRENT_TIMESTAMP)".into())
        );
        assert_eq!(
            default_sql(false, "bit(1)", "b'1'", ""),
            Some("b'1'".into())
        );
        assert_eq!(
            default_sql(true, "varchar(5)", "'a'", ""),
            Some("'a'".into())
        );
        assert_eq!(default_sql(true, "int", "NULL", ""), None);
    }
}
