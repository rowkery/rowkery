//! Staged row edits as SQL: one INSERT, UPDATE or DELETE per changed row,
//! with typed literals and a predicate on the whole primary key (or SQLite's
//! `rowid`), so each statement can name exactly one row.
//!
//! The text built here is what Review SQL and the SafetyBar show, and what
//! `apply_changes` runs inside one transaction that rolls back unless every
//! statement changed exactly one row.

use std::collections::HashSet;

use serde::{Deserialize, Serialize};

use crate::db::{qualified_table_sql, quote_ident, EngineKind, Value};

/// The table the edits go to, as the webview's catalog describes it.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct EditTable {
    pub schema: String,
    pub table: String,
    /// Every column with its catalog type (Postgres `format_type`, SQLite's
    /// declared type), which picks how a value is written.
    pub columns: Vec<EditColumn>,
    /// The primary key's columns, or `["rowid"]` for a SQLite table without one.
    pub key: Vec<String>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct EditColumn {
    pub name: String,
    pub type_name: String,
}

/// One column's value in a change.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct CellValue {
    pub column: String,
    pub value: Value,
}

/// One staged row change. Columns an insert leaves out get their DEFAULT.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(tag = "op", rename_all = "snake_case")]
pub enum Change {
    Insert {
        values: Vec<CellValue>,
    },
    Update {
        key: Vec<CellValue>,
        set: Vec<CellValue>,
    },
    Delete {
        key: Vec<CellValue>,
    },
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Verb {
    Insert,
    Update,
    Delete,
}

impl Verb {
    fn word(self) -> &'static str {
        match self {
            Verb::Insert => "INSERT",
            Verb::Update => "UPDATE",
            Verb::Delete => "DELETE",
        }
    }
}

/// A built statement. Each must change exactly one row.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct RowStatement {
    pub verb: Verb,
    pub sql: String,
    /// `schema.table` as written in `sql`.
    pub target: String,
    /// The key predicate (`id = 3`) of an UPDATE or DELETE.
    pub predicate: Option<String>,
}

impl RowStatement {
    /// How the tray names the row: `UPDATE public.kiosks WHERE id = 3`.
    pub fn describe(&self) -> String {
        match &self.predicate {
            Some(p) => format!("{} {} WHERE {p}", self.verb.word(), self.target),
            None => format!("{} INTO {}", self.verb.word(), self.target),
        }
    }
}

/// Rows each verb changed in a committed batch.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct ApplyCounts {
    pub inserted: u64,
    pub updated: u64,
    pub deleted: u64,
}

impl ApplyCounts {
    pub fn add(&mut self, verb: Verb, rows: u64) {
        match verb {
            Verb::Insert => self.inserted += rows,
            Verb::Update => self.updated += rows,
            Verb::Delete => self.deleted += rows,
        }
    }
}

/// Why a batch was rolled back (or never began): the statement, when one
/// was at fault, and what it did.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct ApplyFailure {
    /// Index into the statements, when one was at fault.
    pub index: Option<usize>,
    /// `UPDATE public.kiosks WHERE id = 3`.
    pub statement: Option<String>,
    /// Rows the statement changed, when it ran and the count was wrong.
    pub rows: Option<u64>,
    /// `UPDATE public.kiosks WHERE id = 3 changed 2 rows`, or the server's error.
    pub message: String,
}

impl ApplyFailure {
    /// The statement ran and changed `rows` rows, not 1.
    pub fn count(index: usize, statement: &RowStatement, rows: u64) -> Self {
        let named = statement.describe();
        let noun = if rows == 1 { "row" } else { "rows" };
        Self {
            index: Some(index),
            message: format!("{named} changed {rows} {noun}"),
            statement: Some(named),
            rows: Some(rows),
        }
    }

    /// The server refused the statement.
    pub fn error(index: usize, statement: &RowStatement, error: String) -> Self {
        let named = statement.describe();
        Self {
            index: Some(index),
            message: format!("{named}: {error}"),
            statement: Some(named),
            rows: None,
        }
    }

    /// Not tied to one statement (BEGIN or COMMIT failed, a transaction was open).
    pub fn other(message: impl Into<String>) -> Self {
        Self {
            index: None,
            statement: None,
            rows: None,
            message: message.into(),
        }
    }
}

/// The statements for `changes` on `table`, in order. Fails (naming the
/// change) when a change can't be written safely: a key that isn't the
/// whole primary key, a NULL key, an unknown column, a value its column's
/// type can't take.
pub fn build_row_changes(
    engine: EngineKind,
    table: &EditTable,
    changes: &[Change],
) -> Result<Vec<RowStatement>, String> {
    if table.key.is_empty() {
        return Err("No primary key · rows here can't be edited".into());
    }
    let rowid = table.key == ["rowid"] && engine == EngineKind::Sqlite;
    if !rowid && table.key.iter().any(|k| column_type(table, k).is_none()) {
        return Err("The key names a column the table doesn't have".into());
    }
    let target = qualified_table_sql(engine, &table.schema, &table.table);
    changes
        .iter()
        .enumerate()
        .map(|(i, change)| {
            build_one(engine, table, &target, rowid, change)
                .map_err(|e| format!("Change {}: {e}", i + 1))
        })
        .collect()
}

/// `BEGIN; … COMMIT;` as Review SQL shows it, one statement per line.
pub fn transaction_sql(statements: &[RowStatement]) -> String {
    let mut out = String::from("BEGIN;\n");
    for s in statements {
        out.push_str(&s.sql);
        out.push_str(";\n");
    }
    out.push_str("COMMIT;");
    out
}

fn build_one(
    engine: EngineKind,
    table: &EditTable,
    target: &str,
    rowid: bool,
    change: &Change,
) -> Result<RowStatement, String> {
    let ident = |c: &str| quote_ident(engine, c);
    match change {
        Change::Insert { values } => {
            unique(values)?;
            let sql = if values.is_empty() {
                format!("INSERT INTO {target} DEFAULT VALUES")
            } else {
                let cols: Vec<String> = values.iter().map(|v| ident(&v.column)).collect();
                let lits = values
                    .iter()
                    .map(|v| typed(engine, table, v))
                    .collect::<Result<Vec<_>, _>>()?;
                format!(
                    "INSERT INTO {target} ({}) VALUES ({})",
                    cols.join(", "),
                    lits.join(", ")
                )
            };
            Ok(RowStatement {
                verb: Verb::Insert,
                sql,
                target: target.to_string(),
                predicate: None,
            })
        }
        Change::Update { key, set } => {
            if set.is_empty() {
                return Err("an update changes no column".into());
            }
            unique(set)?;
            let predicate = key_predicate(engine, table, rowid, key)?;
            let sets = set
                .iter()
                .map(|v| {
                    Ok(format!(
                        "{} = {}",
                        ident(&v.column),
                        typed(engine, table, v)?
                    ))
                })
                .collect::<Result<Vec<_>, String>>()?;
            Ok(RowStatement {
                verb: Verb::Update,
                sql: format!("UPDATE {target} SET {} WHERE {predicate}", sets.join(", ")),
                target: target.to_string(),
                predicate: Some(predicate),
            })
        }
        Change::Delete { key } => {
            let predicate = key_predicate(engine, table, rowid, key)?;
            Ok(RowStatement {
                verb: Verb::Delete,
                sql: format!("DELETE FROM {target} WHERE {predicate}"),
                target: target.to_string(),
                predicate: Some(predicate),
            })
        }
    }
}

/// `a = 1 AND b = 'x'` over every key column, in the table's key order.
fn key_predicate(
    engine: EngineKind,
    table: &EditTable,
    rowid: bool,
    key: &[CellValue],
) -> Result<String, String> {
    unique(key)?;
    if key.len() != table.key.len() || key.iter().any(|k| !table.key.contains(&k.column)) {
        return Err(format!(
            "the row must be named by its whole key ({})",
            table.key.join(", ")
        ));
    }
    table
        .key
        .iter()
        .map(|name| {
            let cell = key.iter().find(|k| &k.column == name).expect("checked");
            if cell.value == Value::Null {
                return Err(format!("key column {name} is NULL"));
            }
            let lit = if rowid {
                literal(engine, "integer", &cell.value)?
            } else {
                typed(engine, table, cell)?
            };
            Ok(format!("{} = {lit}", quote_ident(engine, name)))
        })
        .collect::<Result<Vec<_>, _>>()
        .map(|parts| parts.join(" AND "))
}

fn unique(cells: &[CellValue]) -> Result<(), String> {
    let mut seen = HashSet::new();
    match cells.iter().find(|c| !seen.insert(c.column.as_str())) {
        Some(c) => Err(format!("column {} is given twice", c.column)),
        None => Ok(()),
    }
}

fn column_type<'a>(table: &'a EditTable, name: &str) -> Option<&'a str> {
    table
        .columns
        .iter()
        .find(|c| c.name == name)
        .map(|c| c.type_name.as_str())
}

fn typed(engine: EngineKind, table: &EditTable, cell: &CellValue) -> Result<String, String> {
    let ty = column_type(table, &cell.column)
        .ok_or_else(|| format!("{} isn't a column of {}", cell.column, table.table))?;
    literal(engine, ty, &cell.value).map_err(|e| format!("{}: {e}", cell.column))
}

/// How a Postgres type's values are written.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Kind {
    Bool,
    Int,
    /// float4 / float8 / numeric: bare digits, `'NaN'` and `'Infinity'` quoted.
    Number,
    Json,
    Jsonb,
    Bytes,
    /// Text, and every type that reads a quoted literal (dates, uuid, enums,
    /// arrays, intervals…): the server casts it to the column's type.
    Text,
}

fn pg_kind(type_name: &str) -> Kind {
    let t = type_name.trim().to_ascii_lowercase();
    if t.ends_with("[]") || t.starts_with('_') {
        return Kind::Text;
    }
    // `numeric(10,2)`, `character varying(40)`: the modifier doesn't matter here.
    let base = t.split('(').next().unwrap_or("").trim();
    match base {
        "bool" | "boolean" => Kind::Bool,
        "smallint" | "integer" | "bigint" | "int" | "int2" | "int4" | "int8" | "smallserial"
        | "serial" | "bigserial" | "serial2" | "serial4" | "serial8" | "oid" => Kind::Int,
        "real" | "double precision" | "float4" | "float8" | "float" | "numeric" | "decimal" => {
            Kind::Number
        }
        "json" => Kind::Json,
        "jsonb" => Kind::Jsonb,
        "bytea" => Kind::Bytes,
        _ => Kind::Text,
    }
}

/// `'…'` with every `'` doubled. Never `E''`: with standard_conforming_strings
/// on (Postgres's default since 9.1, and set for every batch `apply_changes`
/// runs) a backslash is just a backslash.
fn quote(text: &str) -> Result<String, String> {
    if text.contains('\0') {
        return Err("text can't hold a NUL character".into());
    }
    Ok(format!("'{}'", text.replace('\'', "''")))
}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

fn is_integer(t: &str) -> bool {
    let digits = t.strip_prefix(['+', '-']).unwrap_or(t);
    !digits.is_empty() && digits.bytes().all(|b| b.is_ascii_digit())
}

/// `12`, `-0.5`, `.5`, `1e-3`: what both engines read as a bare number.
fn is_number(t: &str) -> bool {
    let t = t.strip_prefix(['+', '-']).unwrap_or(t);
    let (mantissa, exp) = match t.find(['e', 'E']) {
        Some(p) => (&t[..p], Some(&t[p + 1..])),
        None => (t, None),
    };
    let mut parts = mantissa.splitn(2, '.');
    let whole = parts.next().unwrap_or("");
    let frac = parts.next();
    let digits = |s: &str| s.bytes().all(|b| b.is_ascii_digit());
    let mantissa_ok = digits(whole)
        && frac.is_none_or(digits)
        && (!whole.is_empty() || frac.is_some_and(|f| !f.is_empty()));
    mantissa_ok && exp.is_none_or(is_integer)
}

fn float(f: f64) -> String {
    if f.is_nan() {
        "'NaN'".into()
    } else if f.is_infinite() {
        if f > 0.0 { "'Infinity'" } else { "'-Infinity'" }.into()
    } else {
        // Shortest text that reads back as the same f64, never an exponent.
        format!("{f}")
    }
}

/// `value` as a SQL literal for a column of `type_name`.
pub fn literal(engine: EngineKind, type_name: &str, value: &Value) -> Result<String, String> {
    match engine {
        EngineKind::Postgres => pg_literal(pg_kind(type_name), value),
        EngineKind::Sqlite => sqlite_literal(value),
    }
}

fn pg_literal(kind: Kind, value: &Value) -> Result<String, String> {
    let quoted_kind = matches!(kind, Kind::Text | Kind::Json | Kind::Jsonb);
    let cast = |lit: String| match kind {
        Kind::Json => format!("{lit}::json"),
        Kind::Jsonb => format!("{lit}::jsonb"),
        _ => lit,
    };
    Ok(match value {
        Value::Null => "NULL".into(),
        Value::Bool(b) if quoted_kind => cast(quote(&b.to_string())?),
        Value::Bool(b) => if *b { "TRUE" } else { "FALSE" }.into(),
        Value::Int(n) if quoted_kind => cast(quote(&n.to_string())?),
        Value::Int(n) => n.to_string(),
        Value::Float(f) if quoted_kind && f.is_finite() => cast(quote(&float(*f))?),
        Value::Float(f) => float(*f),
        Value::Bytes(b) => format!("'\\x{}'::bytea", hex(b)),
        Value::Text(t) => {
            let raw = pg_text(kind, t)?;
            match kind {
                Kind::Text => quote(&raw)?,
                Kind::Int => raw,
                Kind::Number => match raw.as_str() {
                    "NaN" | "Infinity" | "-Infinity" => quote(&raw)?,
                    _ => raw,
                },
                Kind::Bool => raw.to_ascii_uppercase(),
                Kind::Json | Kind::Jsonb => cast(quote(&raw)?),
                Kind::Bytes => format!("'{raw}'::bytea"),
            }
        }
    })
}

/// `text` as a column of `type_name` takes it, unquoted: the same checks and
/// spelling as [`literal`] (CSV import sends it this way, not as SQL).
pub fn typed_text(engine: EngineKind, type_name: &str, text: &str) -> Result<String, String> {
    if text.contains('\0') {
        return Err("text can't hold a NUL character".into());
    }
    match engine {
        EngineKind::Postgres => pg_text(pg_kind(type_name), text),
        EngineKind::Sqlite => Ok(text.to_string()),
    }
}

fn pg_text(kind: Kind, t: &str) -> Result<String, String> {
    Ok(match kind {
        Kind::Text => t.to_string(),
        Kind::Int => {
            let t = t.trim();
            if !is_integer(t) {
                return Err(format!("{} isn't a whole number", quote(t)?));
            }
            t.to_string()
        }
        Kind::Number => {
            let t = t.trim();
            match t.to_ascii_lowercase().as_str() {
                "nan" => "NaN".into(),
                "infinity" | "+infinity" | "inf" => "Infinity".into(),
                "-infinity" | "-inf" => "-Infinity".into(),
                _ if is_number(t) => t.to_string(),
                _ => return Err(format!("{} isn't a number", quote(t)?)),
            }
        }
        Kind::Bool => match t.trim().to_ascii_lowercase().as_str() {
            "true" | "t" | "yes" | "y" | "on" | "1" => "true".into(),
            "false" | "f" | "no" | "n" | "off" | "0" => "false".into(),
            _ => return Err(format!("{} isn't true or false", quote(t)?)),
        },
        Kind::Json | Kind::Jsonb => {
            if serde_json::from_str::<serde_json::Value>(t).is_err() {
                return Err("not valid JSON".into());
            }
            t.to_string()
        }
        Kind::Bytes => {
            // As the grid shows it: `\x` and hex digits.
            let digits = t.trim().strip_prefix("\\x").unwrap_or(t.trim());
            if !digits.len().is_multiple_of(2) || !digits.bytes().all(|b| b.is_ascii_hexdigit()) {
                return Err("bytea is written as \\x and hex digits".into());
            }
            format!("\\x{}", digits.to_ascii_lowercase())
        }
    })
}

/// SQLite converts by the column's affinity, so values go as they are:
/// text quoted, numbers bare, booleans 1 / 0, blobs `X'…'`.
fn sqlite_literal(value: &Value) -> Result<String, String> {
    Ok(match value {
        Value::Null => "NULL".into(),
        Value::Bool(b) => if *b { "1" } else { "0" }.into(),
        Value::Int(n) => n.to_string(),
        Value::Float(f) if f.is_finite() => float(*f),
        Value::Float(_) => return Err("SQLite can't store NaN or Infinity".into()),
        Value::Text(t) => quote(t)?,
        Value::Bytes(b) => format!("X'{}'", hex(b)),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn pg(ty: &str, v: Value) -> Result<String, String> {
        literal(EngineKind::Postgres, ty, &v)
    }

    fn text(s: &str) -> Value {
        Value::Text(s.into())
    }

    fn kiosks() -> EditTable {
        EditTable {
            schema: "public".into(),
            table: "kiosks".into(),
            columns: [
                ("id", "integer"),
                ("name", "text"),
                ("city", "character varying(40)"),
                ("active", "boolean"),
                ("opened_at", "timestamp with time zone"),
                ("meta", "jsonb"),
            ]
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

    #[test]
    fn edits_text_doubles_quotes_and_keeps_backslashes() {
        assert_eq!(pg("text", text("it's")).unwrap(), "'it''s'");
        assert_eq!(pg("text", text(r"C:\new\x")).unwrap(), r"'C:\new\x'");
        assert_eq!(pg("text", text(r"\'")).unwrap(), r"'\'''");
        assert_eq!(
            pg("character varying(40)", text("x'); DROP TABLE t; --")).unwrap(),
            "'x''); DROP TABLE t; --'"
        );
        assert_eq!(pg("text", text("")).unwrap(), "''");
        assert_eq!(pg("text", text("ünï 😀")).unwrap(), "'ünï 😀'");
        assert!(pg("text", text("a\0b")).is_err());
        // Never the escape-string syntax.
        assert!(!pg("text", text(r"\\n'")).unwrap().starts_with('E'));
    }

    #[test]
    fn edits_null_is_bare_for_every_type() {
        for ty in [
            "text", "integer", "boolean", "jsonb", "bytea", "numeric", "date",
        ] {
            assert_eq!(pg(ty, Value::Null).unwrap(), "NULL", "{ty}");
        }
        assert_eq!(
            literal(EngineKind::Sqlite, "TEXT", &Value::Null).unwrap(),
            "NULL"
        );
    }

    #[test]
    fn edits_integers_are_bare_and_checked() {
        assert_eq!(
            pg("bigint", Value::Int(i64::MAX)).unwrap(),
            "9223372036854775807"
        );
        assert_eq!(pg("int4", Value::Int(-3)).unwrap(), "-3");
        assert_eq!(pg("integer", text(" 42 ")).unwrap(), "42");
        assert_eq!(pg("smallint", text("-7")).unwrap(), "-7");
        assert!(pg("integer", text("4 2")).is_err());
        assert!(pg("integer", text("1; DROP TABLE t")).is_err());
        assert!(pg("integer", text("")).is_err());
        // An integer for a text column is quoted, so `text = '5'` compares.
        assert_eq!(pg("text", Value::Int(5)).unwrap(), "'5'");
    }

    #[test]
    fn edits_numeric_and_floats() {
        assert_eq!(pg("numeric(10,2)", text("12.50")).unwrap(), "12.50");
        assert_eq!(pg("numeric", text("-0.001")).unwrap(), "-0.001");
        assert_eq!(pg("numeric", text(".5")).unwrap(), ".5");
        assert_eq!(pg("numeric", text("1e-3")).unwrap(), "1e-3");
        assert_eq!(pg("numeric", text("NaN")).unwrap(), "'NaN'");
        assert_eq!(
            pg("double precision", text("-Infinity")).unwrap(),
            "'-Infinity'"
        );
        assert!(pg("numeric", text("1.2.3")).is_err());
        assert!(pg("numeric", text(".")).is_err());
        assert!(pg("numeric", text("1e")).is_err());
        assert!(pg("numeric", text("12 OR 1=1")).is_err());
        assert_eq!(pg("float8", Value::Float(1.5)).unwrap(), "1.5");
        assert_eq!(
            pg("real", Value::Float(1e21)).unwrap(),
            "1000000000000000000000"
        );
        assert_eq!(pg("float8", Value::Float(f64::NAN)).unwrap(), "'NaN'");
        assert_eq!(
            pg("float8", Value::Float(f64::INFINITY)).unwrap(),
            "'Infinity'"
        );
    }

    #[test]
    fn edits_booleans() {
        assert_eq!(pg("boolean", Value::Bool(true)).unwrap(), "TRUE");
        assert_eq!(pg("bool", Value::Bool(false)).unwrap(), "FALSE");
        assert_eq!(pg("boolean", text("f")).unwrap(), "FALSE");
        assert_eq!(pg("boolean", text("Yes")).unwrap(), "TRUE");
        assert!(pg("boolean", text("maybe")).is_err());
        assert_eq!(
            literal(EngineKind::Sqlite, "BOOLEAN", &Value::Bool(true)).unwrap(),
            "1"
        );
    }

    #[test]
    fn edits_timestamps_dates_uuid_and_enums_are_quoted() {
        assert_eq!(
            pg("timestamp with time zone", text("2026-10-05 09:30:00+00")).unwrap(),
            "'2026-10-05 09:30:00+00'"
        );
        assert_eq!(pg("timestamptz", text("now")).unwrap(), "'now'");
        assert_eq!(pg("date", text("2024-03-01")).unwrap(), "'2024-03-01'");
        assert_eq!(
            pg("time without time zone", text("09:00")).unwrap(),
            "'09:00'"
        );
        assert_eq!(pg("interval", text("1 day")).unwrap(), "'1 day'");
        assert_eq!(
            pg("uuid", text("6f1c2a4e-0000-4000-8000-000000000001")).unwrap(),
            "'6f1c2a4e-0000-4000-8000-000000000001'"
        );
        assert_eq!(pg("kiosk_status", text("o'pen")).unwrap(), "'o''pen'");
    }

    #[test]
    fn edits_json_is_checked_and_cast() {
        assert_eq!(
            pg("jsonb", text(r#"{"a": "it's"}"#)).unwrap(),
            r#"'{"a": "it''s"}'::jsonb"#
        );
        assert_eq!(pg("json", text("[1, 2]")).unwrap(), "'[1, 2]'::json");
        assert_eq!(pg("jsonb", Value::Int(3)).unwrap(), "'3'::jsonb");
        assert_eq!(pg("jsonb", Value::Bool(true)).unwrap(), "'true'::jsonb");
        assert!(pg("jsonb", text("{oops")).is_err());
    }

    #[test]
    fn edits_bytea_as_hex() {
        assert_eq!(
            pg("bytea", Value::Bytes(vec![0x01, 0xab, 0x27, 0x5c])).unwrap(),
            r"'\x01ab275c'::bytea"
        );
        assert_eq!(pg("bytea", Value::Bytes(vec![])).unwrap(), r"'\x'::bytea");
        assert_eq!(
            pg("bytea", text(r"\xDEADbeef")).unwrap(),
            r"'\xdeadbeef'::bytea"
        );
        assert!(pg("bytea", text(r"\x0")).is_err());
        assert!(pg("bytea", text("hello'")).is_err());
        assert_eq!(
            literal(EngineKind::Sqlite, "BLOB", &Value::Bytes(vec![0, 255])).unwrap(),
            "X'00ff'"
        );
    }

    #[test]
    fn edits_arrays_are_quoted_literals() {
        assert_eq!(
            pg("text[]", text(r#"{a,"b c"}"#)).unwrap(),
            r#"'{a,"b c"}'"#
        );
        assert_eq!(pg("_int4", text("{1,2}")).unwrap(), "'{1,2}'");
    }

    #[test]
    fn edits_sqlite_literals() {
        let lit = |v: Value| literal(EngineKind::Sqlite, "", &v);
        assert_eq!(lit(text("it's")).unwrap(), "'it''s'");
        assert_eq!(lit(Value::Int(-1)).unwrap(), "-1");
        assert_eq!(lit(Value::Float(0.25)).unwrap(), "0.25");
        assert!(lit(Value::Float(f64::NAN)).is_err());
        assert!(lit(text("a\0")).is_err());
    }

    #[test]
    fn edits_build_insert_update_delete_on_the_whole_key() {
        let table = kiosks();
        let out = build_row_changes(
            EngineKind::Postgres,
            &table,
            &[
                Change::Insert {
                    values: vec![
                        cell("name", text("Kiosk Puchong")),
                        cell("city", text("KL")),
                        cell("active", Value::Bool(true)),
                    ],
                },
                Change::Update {
                    key: vec![cell("id", Value::Int(3))],
                    set: vec![cell("city", text("Petaling Jaya"))],
                },
                Change::Delete {
                    key: vec![cell("id", Value::Int(9))],
                },
                Change::Insert { values: vec![] },
            ],
        )
        .unwrap();
        let sql: Vec<&str> = out.iter().map(|s| s.sql.as_str()).collect();
        assert_eq!(
            sql,
            [
                "INSERT INTO public.kiosks (name, city, active) VALUES ('Kiosk Puchong', 'KL', TRUE)",
                "UPDATE public.kiosks SET city = 'Petaling Jaya' WHERE id = 3",
                "DELETE FROM public.kiosks WHERE id = 9",
                "INSERT INTO public.kiosks DEFAULT VALUES",
            ]
        );
        assert_eq!(out[1].describe(), "UPDATE public.kiosks WHERE id = 3");
        assert_eq!(out[0].describe(), "INSERT INTO public.kiosks");
        assert_eq!(
            transaction_sql(&out[1..3]),
            "BEGIN;\nUPDATE public.kiosks SET city = 'Petaling Jaya' WHERE id = 3;\nDELETE FROM public.kiosks WHERE id = 9;\nCOMMIT;"
        );
        // Every write is held by Confirm writes and refused by Read-only.
        let held = crate::safety::hold_for(
            crate::safety::SafeMode::Confirm,
            &transaction_sql(&out),
            false,
            crate::safety::Dialect::Postgres,
        )
        .unwrap();
        assert_eq!(held.statements.len(), 4);
        assert!(held.statements.iter().all(|s| !s.destructive));
    }

    #[test]
    fn edits_multi_column_keys_and_quoted_names() {
        let table = EditTable {
            schema: "Sales".into(),
            table: "Order Lines".into(),
            columns: vec![
                EditColumn {
                    name: "order".into(),
                    type_name: "bigint".into(),
                },
                EditColumn {
                    name: "Line".into(),
                    type_name: "text".into(),
                },
                EditColumn {
                    name: "qty".into(),
                    type_name: "numeric".into(),
                },
            ],
            key: vec!["order".into(), "Line".into()],
        };
        let out = build_row_changes(
            EngineKind::Postgres,
            &table,
            &[Change::Update {
                // Key cells in any order; the predicate follows the key.
                key: vec![cell("Line", text("a\"b")), cell("order", Value::Int(7))],
                set: vec![cell("qty", text("2.5"))],
            }],
        )
        .unwrap();
        assert_eq!(
            out[0].sql,
            r#"UPDATE "Sales"."Order Lines" SET qty = 2.5 WHERE "order" = 7 AND "Line" = 'a"b'"#
        );
    }

    #[test]
    fn edits_refuse_a_partial_null_or_missing_key() {
        let table = kiosks();
        let update = |key: Vec<CellValue>| Change::Update {
            key,
            set: vec![cell("name", text("x"))],
        };
        let build = |c: Change| build_row_changes(EngineKind::Postgres, &table, &[c]);
        assert!(build(update(vec![])).is_err());
        assert!(build(update(vec![cell("name", text("x"))])).is_err());
        assert!(build(update(vec![cell("id", Value::Null)])).is_err());
        assert!(build(update(vec![
            cell("id", Value::Int(1)),
            cell("id", Value::Int(2))
        ]))
        .is_err());
        assert!(build(Change::Delete {
            key: vec![cell("id", Value::Int(1)), cell("name", text("x"))]
        })
        .is_err());
        assert!(build(Change::Update {
            key: vec![cell("id", Value::Int(1))],
            set: vec![]
        })
        .is_err());
        assert!(build(Change::Update {
            key: vec![cell("id", Value::Int(1))],
            set: vec![cell("nope", text("x"))]
        })
        .is_err());
        let err = build(Change::Update {
            key: vec![cell("id", Value::Int(1))],
            set: vec![cell("active", text("maybe"))],
        })
        .unwrap_err();
        assert!(err.starts_with("Change 1: active:"), "{err}");
        // No key at all: nothing is editable.
        let keyless = EditTable {
            key: vec![],
            ..kiosks()
        };
        assert!(build_row_changes(
            EngineKind::Postgres,
            &keyless,
            &[Change::Delete {
                key: vec![cell("id", Value::Int(1))]
            }]
        )
        .is_err());
        // `rowid` only names a SQLite row.
        let by_rowid = EditTable {
            key: vec!["rowid".into()],
            ..kiosks()
        };
        assert!(build_row_changes(EngineKind::Postgres, &by_rowid, &[]).is_err());
    }

    #[test]
    fn edits_sqlite_by_rowid() {
        let table = EditTable {
            schema: "main".into(),
            table: "notes".into(),
            columns: vec![EditColumn {
                name: "body".into(),
                type_name: "TEXT".into(),
            }],
            key: vec!["rowid".into()],
        };
        let out = build_row_changes(
            EngineKind::Sqlite,
            &table,
            &[
                Change::Update {
                    key: vec![cell("rowid", Value::Int(4))],
                    set: vec![cell("body", text("it's"))],
                },
                Change::Delete {
                    key: vec![cell("rowid", Value::Int(5))],
                },
            ],
        )
        .unwrap();
        assert_eq!(
            out[0].sql,
            "UPDATE notes SET body = 'it''s' WHERE rowid = 4"
        );
        assert_eq!(out[1].sql, "DELETE FROM notes WHERE rowid = 5");
    }

    #[test]
    fn edits_failures_name_the_row() {
        let s = RowStatement {
            verb: Verb::Update,
            sql: String::new(),
            target: "public.kiosks".into(),
            predicate: Some("id = 3".into()),
        };
        assert_eq!(
            ApplyFailure::count(1, &s, 2).message,
            "UPDATE public.kiosks WHERE id = 3 changed 2 rows"
        );
        assert_eq!(
            ApplyFailure::count(1, &s, 0).statement.as_deref(),
            Some("UPDATE public.kiosks WHERE id = 3")
        );
    }

    #[test]
    fn edits_change_wire_format() {
        let json = r#"[{"op":"update","key":[{"column":"id","value":{"Int":3}}],"set":[{"column":"city","value":null}]},{"op":"insert","values":[]}]"#;
        let changes: Vec<Change> = serde_json::from_str(json).unwrap();
        assert_eq!(
            changes[0],
            Change::Update {
                key: vec![cell("id", Value::Int(3))],
                set: vec![cell("city", Value::Null)],
            }
        );
    }
}
