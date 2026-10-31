//! SQL helpers for the query runner (browse limits, selection).

/// Append `LIMIT n` for simple `SELECT` statements that do not already specify a limit.
pub fn apply_browse_limit(sql: &str, limit: u32) -> String {
    let trimmed = sql.trim();
    if trimmed.is_empty() {
        return trimmed.to_string();
    }
    let without_semicolon = trimmed.trim_end_matches(';').trim();
    let upper = without_semicolon.to_uppercase();
    if !upper.starts_with("SELECT") && !upper.starts_with("WITH") {
        return without_semicolon.to_string();
    }
    if contains_limit_clause(&upper) {
        return without_semicolon.to_string();
    }
    format!("{without_semicolon} LIMIT {limit}")
}

pub fn should_apply_browse_limit(sql: &str) -> bool {
    let trimmed = sql.trim().trim_end_matches(';').trim();
    if trimmed.is_empty() {
        return false;
    }
    let upper = trimmed.to_uppercase();
    (upper.starts_with("SELECT") || upper.starts_with("WITH")) && !contains_limit_clause(&upper)
}

fn contains_limit_clause(upper_sql: &str) -> bool {
    // Simple token scan — good enough for MVP browse queries.
    upper_sql.split_whitespace().any(|w| w == "LIMIT")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn adds_limit_to_select() {
        let sql = apply_browse_limit("select * from users", 100);
        assert_eq!(sql, "select * from users LIMIT 100");
    }

    #[test]
    fn skips_when_limit_present() {
        let sql = apply_browse_limit("SELECT * FROM t LIMIT 5", 100);
        assert!(!sql.contains("LIMIT 100"));
    }

    #[test]
    fn skips_update() {
        let sql = apply_browse_limit("UPDATE users SET x = 1", 100);
        assert_eq!(sql, "UPDATE users SET x = 1");
    }
}

/// A cell as a SQL literal to match a key on: integers and floats bare, text
/// single-quoted with quotes doubled, booleans as TRUE / FALSE. `None` for
/// NULL, bytes and non-finite floats, which can't be looked up this way.
///
/// Postgres text holding a backslash is an `E'…'` string with backslashes
/// doubled too: a plain `'…'` reads `\'` as a quote that doesn't end it on a
/// server with `standard_conforming_strings` off, so a key value read from
/// the table could break out of the literal. `E''` reads the same on every
/// server. MySQL reads `\` as an escape unless `NO_BACKSLASH_ESCAPES` is
/// set, so its text holding one is hex ([`mysql_text`]).
pub fn sql_literal(engine: crate::db::EngineKind, value: &crate::db::Value) -> Option<String> {
    use crate::db::{EngineKind, Value};
    match value {
        Value::Int(n) => Some(n.to_string()),
        // Quoted on Postgres so it takes the column's type: a real `0.1`
        // doesn't equal the double a bare `0.1` reads as.
        Value::Float(f) if f.is_finite() && engine == EngineKind::Postgres => {
            Some(format!("'{f}'"))
        }
        Value::Float(f) if f.is_finite() => Some(f.to_string()),
        Value::Text(t) if t.contains('\0') => None,
        Value::Text(t) if engine == EngineKind::Postgres && t.contains('\\') => Some(format!(
            "E'{}'",
            t.replace('\\', "\\\\").replace('\'', "''")
        )),
        Value::Text(t) if engine == EngineKind::Mysql => Some(mysql_text(t)),
        Value::Text(t) => Some(format!("'{}'", t.replace('\'', "''"))),
        Value::Bool(b) => Some(if *b { "TRUE" } else { "FALSE" }.into()),
        _ => None,
    }
}

/// `text` as a MySQL string literal that reads the same whatever the
/// session's `sql_mode`: `'…'` with quotes doubled, or, holding a backslash
/// (an escape unless `NO_BACKSLASH_ESCAPES`), the UTF-8 bytes in hex with a
/// charset introducer, which takes the column's collation like any string.
pub fn mysql_text(text: &str) -> String {
    if text.contains('\\') {
        let hex: String = text.bytes().map(|b| format!("{b:02X}")).collect();
        format!("_utf8mb4 X'{hex}'")
    } else {
        format!("'{}'", text.replace('\'', "''"))
    }
}

#[cfg(test)]
mod literal_tests {
    use super::sql_literal;
    use crate::db::{EngineKind, Value};

    fn pg(value: &Value) -> Option<String> {
        sql_literal(EngineKind::Postgres, value)
    }

    #[test]
    fn literals_are_exact_and_escaped() {
        assert_eq!(
            pg(&Value::Int(i64::MAX)).as_deref(),
            Some("9223372036854775807")
        );
        assert_eq!(pg(&Value::Text("it's".into())).as_deref(), Some("'it''s'"));
        assert_eq!(
            pg(&Value::Text("x'; DROP TABLE t; --".into())).as_deref(),
            Some("'x''; DROP TABLE t; --'")
        );
        assert_eq!(pg(&Value::Bool(false)).as_deref(), Some("FALSE"));
        assert_eq!(pg(&Value::Float(1.5)).as_deref(), Some("'1.5'"));
        assert_eq!(pg(&Value::Float(f64::NAN)), None);
        assert_eq!(pg(&Value::Null), None);
        assert_eq!(pg(&Value::Bytes(vec![1])), None);
        assert_eq!(pg(&Value::Text("a\0b".into())), None);
    }

    /// With `standard_conforming_strings` off, `'\''` reads as a string still
    /// open: a backslash makes it an `E''` string, read the same anywhere.
    #[test]
    fn backslashes_cant_end_a_postgres_literal() {
        let breakout = Value::Text(r"\' OR 1=1 --".into());
        assert_eq!(pg(&breakout).as_deref(), Some(r"E'\\'' OR 1=1 --'"));
        assert_eq!(
            pg(&Value::Text(r"C:\tmp".into())).as_deref(),
            Some(r"E'C:\\tmp'")
        );
        assert_eq!(
            sql_literal(EngineKind::Mysql, &breakout).as_deref(),
            Some("_utf8mb4 X'5C27204F5220313D31202D2D'")
        );
        assert_eq!(
            sql_literal(EngineKind::Mysql, &Value::Text("it's".into())).as_deref(),
            Some("'it''s'")
        );
        // SQLite has no escapes in strings: a backslash is a backslash.
        assert_eq!(
            sql_literal(EngineKind::Sqlite, &breakout).as_deref(),
            Some(r"'\'' OR 1=1 --'")
        );
    }
}
