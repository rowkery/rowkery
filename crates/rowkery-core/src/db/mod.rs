use serde::{Deserialize, Serialize};
use thiserror::Error;

pub mod introspect;
pub use introspect::{
    qualified_table_sql, quote_ident, table_browse_query, table_browse_sql, table_count_query,
    table_select_limit_sql, BrowseOptions, BrowseOrder, ColumnNode, DatabaseNode, EngineKind,
    EnumNode, ForeignKeyNode, FunctionNode, IndexNode, RowEstimate, SchemaCatalog, SchemaNode,
    TableIndexes, TableKind, TableNode, TableRef,
};

/// A cell. In JSON (the IPC to the webview) NULL is `null`, and an `Int`
/// outside ±(2^53 − 1), where a JavaScript number would round it, is written
/// as `{"BigInt": "<digits>"}` so it arrives exact; every other `Int` stays a
/// number. Binary formats keep the plain variants. Both forms read back.
#[derive(Clone, Debug, PartialEq)]
pub enum Value {
    Null,
    Bool(bool),
    Int(i64),
    Float(f64),
    Text(String),
    Bytes(Vec<u8>),
}

/// Largest integer a JavaScript number holds exactly (`Number.MAX_SAFE_INTEGER`).
pub const JS_SAFE_INTEGER: i64 = (1 << 53) - 1;

impl Serialize for Value {
    fn serialize<S: serde::Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
        match self {
            Value::Null if s.is_human_readable() => s.serialize_unit(),
            Value::Null => s.serialize_unit_variant("Value", 0, "Null"),
            Value::Bool(b) => s.serialize_newtype_variant("Value", 1, "Bool", b),
            Value::Int(n)
                if s.is_human_readable() && !(-JS_SAFE_INTEGER..=JS_SAFE_INTEGER).contains(n) =>
            {
                s.serialize_newtype_variant("Value", 6, "BigInt", &n.to_string())
            }
            Value::Int(n) => s.serialize_newtype_variant("Value", 2, "Int", n),
            Value::Float(f) => s.serialize_newtype_variant("Value", 3, "Float", f),
            Value::Text(t) => s.serialize_newtype_variant("Value", 4, "Text", t),
            Value::Bytes(b) => s.serialize_newtype_variant("Value", 5, "Bytes", b),
        }
    }
}

/// What `Value` reads from: the same variants plus `BigInt`.
#[derive(Deserialize)]
#[serde(rename = "Value")]
enum ValueWire {
    Null,
    Bool(bool),
    Int(i64),
    Float(f64),
    Text(String),
    Bytes(Vec<u8>),
    BigInt(String),
}

impl<'de> Deserialize<'de> for Value {
    fn deserialize<D: serde::Deserializer<'de>>(d: D) -> Result<Self, D::Error> {
        // `null` (JSON) and the `Null` variant both read as NULL.
        let wire = if d.is_human_readable() {
            Option::<ValueWire>::deserialize(d)?
        } else {
            Some(ValueWire::deserialize(d)?)
        };
        Ok(match wire {
            None | Some(ValueWire::Null) => Value::Null,
            Some(wire) => wire.into_value()?,
        })
    }
}

impl ValueWire {
    fn into_value<E: serde::de::Error>(self) -> Result<Value, E> {
        Ok(match self {
            ValueWire::Null => Value::Null,
            ValueWire::Bool(b) => Value::Bool(b),
            ValueWire::Int(n) => Value::Int(n),
            ValueWire::Float(f) => Value::Float(f),
            ValueWire::Text(t) => Value::Text(t),
            ValueWire::Bytes(b) => Value::Bytes(b),
            ValueWire::BigInt(s) => Value::Int(s.parse().map_err(E::custom)?),
        })
    }
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct Column {
    pub name: String,
    pub type_name: String,
}

#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
pub struct RowBatch {
    pub columns: Vec<Column>,
    pub rows: Vec<Vec<Value>>,
}

#[derive(Debug, Error)]
pub enum DriverError {
    #[error("not implemented: {0}")]
    NotImplemented(&'static str),
    #[error("query cancelled")]
    Cancelled,
    #[error("{0}")]
    Message(String),
    /// The server refused the statement; SQLSTATE and where in it, when known.
    #[error("{message}")]
    Server {
        message: String,
        /// Five characters, e.g. `42P01`.
        sqlstate: String,
        /// 1-based character offset into the statement, as Postgres reports it.
        position: Option<u32>,
    },
}

impl DriverError {
    /// The message as shown to the user (the server's text for `Server`).
    pub fn into_message(self) -> String {
        match self {
            DriverError::Message(msg) => msg,
            DriverError::Server { message, .. } => message,
            DriverError::Cancelled => "Cancelled".to_string(),
            DriverError::NotImplemented(f) => format!("not implemented: {f}"),
        }
    }
}

/// Database driver contract (SQLite; Postgres runs on `postgres::PostgresSession`).
pub trait Driver: Send {
    fn connect(&mut self) -> Result<(), DriverError>;

    fn test_connection(&mut self) -> Result<(), DriverError> {
        self.connect()
    }

    /// Run SQL. For result sets, invokes `on_batch` with up to ~200 rows per batch.
    /// `on_batch`'s second argument is true for the first batch of a result set.
    /// Returns row count for SELECT-style queries, or rows affected for mutations.
    fn query_stream<F>(&mut self, _sql: &str, _on_batch: F) -> Result<u64, DriverError>
    where
        F: FnMut(RowBatch, bool) -> Result<(), DriverError>,
    {
        Err(DriverError::NotImplemented("query_stream"))
    }

    fn cancel(&mut self) -> Result<(), DriverError> {
        Ok(())
    }

    fn introspect_catalog(&mut self) -> Result<SchemaCatalog, DriverError> {
        Err(DriverError::NotImplemented("introspect_catalog"))
    }
}

pub mod postgres;
pub mod sqlite;

#[cfg(test)]
mod value_wire_tests {
    use super::*;

    #[test]
    fn ints_beyond_js_precision_travel_as_strings() {
        let row = vec![
            Value::Int(i64::MAX),
            Value::Int(i64::MIN),
            Value::Int(JS_SAFE_INTEGER),
            Value::Int(-JS_SAFE_INTEGER),
            Value::Int(JS_SAFE_INTEGER + 1),
            Value::Int(42),
            Value::Null,
            Value::Float(1.5),
            Value::Text("x".into()),
        ];
        let json = serde_json::to_string(&row).unwrap();
        assert_eq!(
            json,
            r#"[{"BigInt":"9223372036854775807"},{"BigInt":"-9223372036854775808"},{"Int":9007199254740991},{"Int":-9007199254740991},{"BigInt":"9007199254740992"},{"Int":42},null,{"Float":1.5},{"Text":"x"}]"#
        );
        let back: Vec<Value> = serde_json::from_str(&json).unwrap();
        assert_eq!(back, row);
    }

    #[test]
    fn the_old_null_spelling_still_reads() {
        assert_eq!(
            serde_json::from_str::<Value>(r#""Null""#).unwrap(),
            Value::Null
        );
        assert_eq!(serde_json::from_str::<Value>("null").unwrap(), Value::Null);
    }

    #[test]
    fn a_bad_bigint_is_an_error() {
        assert!(serde_json::from_str::<Value>(r#"{"BigInt":"12x"}"#).is_err());
    }
}
