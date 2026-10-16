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
pub fn sql_literal(value: &crate::db::Value) -> Option<String> {
    use crate::db::Value;
    match value {
        Value::Int(n) => Some(n.to_string()),
        Value::Float(f) if f.is_finite() => Some(f.to_string()),
        Value::Text(t) if !t.contains('\0') => Some(format!("'{}'", t.replace('\'', "''"))),
        Value::Bool(b) => Some(if *b { "TRUE" } else { "FALSE" }.into()),
        _ => None,
    }
}

#[cfg(test)]
mod literal_tests {
    use super::sql_literal;
    use crate::db::Value;

    #[test]
    fn literals_are_exact_and_escaped() {
        assert_eq!(
            sql_literal(&Value::Int(i64::MAX)).as_deref(),
            Some("9223372036854775807")
        );
        assert_eq!(
            sql_literal(&Value::Text("it's".into())).as_deref(),
            Some("'it''s'")
        );
        assert_eq!(
            sql_literal(&Value::Text("x'; DROP TABLE t; --".into())).as_deref(),
            Some("'x''; DROP TABLE t; --'")
        );
        assert_eq!(sql_literal(&Value::Bool(false)).as_deref(), Some("FALSE"));
        assert_eq!(sql_literal(&Value::Float(1.5)).as_deref(), Some("1.5"));
        assert_eq!(sql_literal(&Value::Float(f64::NAN)), None);
        assert_eq!(sql_literal(&Value::Null), None);
        assert_eq!(sql_literal(&Value::Bytes(vec![1])), None);
        assert_eq!(sql_literal(&Value::Text("a\0b".into())), None);
    }
}
