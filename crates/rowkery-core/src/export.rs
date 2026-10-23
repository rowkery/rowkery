//! Writes a result to a file (or the clipboard) as CSV, TSV, JSON or SQL
//! `INSERT`s, batch by batch, so a whole cursor never sits in memory.

use std::io::{self, Write};

use crate::db::introspect::{qualified_table_sql, quote_ident, EngineKind};
use crate::db::{Column, Value};

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum ExportFormat {
    /// RFC 4180: fields with `,` `"` or a line break are quoted; NULL is empty.
    Csv,
    /// Tabs and line breaks inside a value become a space; NULL is empty.
    Tsv,
    /// One array of objects keyed by column name.
    Json,
    /// One `INSERT INTO table (…) VALUES (…);` per row.
    SqlInsert {
        engine: EngineKind,
        schema: String,
        table: String,
    },
}

impl ExportFormat {
    /// From a file name's extension (`.csv`, `.tsv`, `.json`, `.sql`); CSV
    /// when it has none of them. `.sql` inserts into `table`.
    pub fn from_path(path: &str, engine: EngineKind, schema: &str, table: &str) -> Self {
        let ext = path.rsplit_once('.').map(|(_, e)| e.to_ascii_lowercase());
        match ext.as_deref() {
            Some("tsv") | Some("tab") => Self::Tsv,
            Some("json") => Self::Json,
            Some("sql") => Self::SqlInsert {
                engine,
                schema: schema.to_string(),
                table: table.to_string(),
            },
            _ => Self::Csv,
        }
    }
}

/// Streams rows into `out` in `format`. Call `columns` before the first
/// rows (a result with none still gets its header), then `finish`.
pub struct ExportWriter<W: Write> {
    out: W,
    format: ExportFormat,
    columns: Vec<Column>,
    started: bool,
    rows: u64,
}

impl<W: Write> ExportWriter<W> {
    pub fn new(out: W, format: ExportFormat) -> Self {
        Self {
            out,
            format,
            columns: Vec::new(),
            started: false,
            rows: 0,
        }
    }

    pub fn rows_written(&self) -> u64 {
        self.rows
    }

    /// The result's columns: writes the header once.
    pub fn columns(&mut self, columns: &[Column]) -> io::Result<()> {
        if self.started {
            return Ok(());
        }
        self.started = true;
        self.columns = columns.to_vec();
        match &self.format {
            ExportFormat::Csv => {
                let line: Vec<String> = columns.iter().map(|c| csv_field(&c.name)).collect();
                writeln!(self.out, "{}", line.join(","))
            }
            ExportFormat::Tsv => {
                let line: Vec<String> = columns.iter().map(|c| tsv_field(&c.name)).collect();
                writeln!(self.out, "{}", line.join("\t"))
            }
            ExportFormat::Json => write!(self.out, "["),
            // Text and bytea are plain `'…'` strings, where a backslash is
            // a backslash only with standard_conforming_strings on (as
            // `apply_changes` sets it): the file says so for whatever server
            // it is loaded into.
            ExportFormat::SqlInsert {
                engine: EngineKind::Postgres,
                ..
            } => writeln!(self.out, "SET standard_conforming_strings = on;"),
            ExportFormat::SqlInsert { .. } => Ok(()),
        }
    }

    pub fn row(&mut self, row: &[Value]) -> io::Result<()> {
        let first = self.rows == 0;
        self.rows += 1;
        match &self.format {
            ExportFormat::Csv => {
                let line: Vec<String> = row.iter().map(|v| csv_field(&text(v))).collect();
                writeln!(self.out, "{}", line.join(","))
            }
            ExportFormat::Tsv => {
                let line: Vec<String> = row.iter().map(|v| tsv_field(&text(v))).collect();
                writeln!(self.out, "{}", line.join("\t"))
            }
            ExportFormat::Json => {
                let mut obj = serde_json::Map::new();
                for (c, v) in self.columns.iter().zip(row) {
                    obj.insert(c.name.clone(), json(v));
                }
                let sep = if first { "\n  " } else { ",\n  " };
                write!(self.out, "{sep}{}", serde_json::Value::Object(obj))
            }
            ExportFormat::SqlInsert {
                engine,
                schema,
                table,
            } => {
                let names: Vec<String> = self
                    .columns
                    .iter()
                    .map(|c| quote_ident(*engine, &c.name))
                    .collect();
                let values: Vec<String> = row.iter().map(|v| literal(*engine, v)).collect();
                writeln!(
                    self.out,
                    "INSERT INTO {} ({}) VALUES ({});",
                    qualified_table_sql(*engine, schema, table),
                    names.join(", "),
                    values.join(", ")
                )
            }
        }
    }

    /// Closes the JSON array and flushes; returns the writer.
    pub fn finish(mut self) -> io::Result<W> {
        if self.format == ExportFormat::Json {
            if !self.started {
                write!(self.out, "[")?;
            }
            writeln!(self.out, "{}]", if self.rows > 0 { "\n" } else { "" })?;
        }
        self.out.flush()?;
        Ok(self.out)
    }
}

/// A value as the grid shows it; NULL is empty, bytes are `\x` hex.
fn text(v: &Value) -> String {
    match v {
        Value::Null => String::new(),
        Value::Bool(b) => b.to_string(),
        Value::Int(n) => n.to_string(),
        Value::Float(f) => f.to_string(),
        Value::Text(t) => t.clone(),
        Value::Bytes(b) => hex(b),
    }
}

fn hex(b: &[u8]) -> String {
    let mut s = String::with_capacity(2 + b.len() * 2);
    s.push_str("\\x");
    for byte in b {
        s.push_str(&format!("{byte:02x}"));
    }
    s
}

fn csv_field(s: &str) -> String {
    if s.contains([',', '"', '\r', '\n']) {
        format!("\"{}\"", s.replace('"', "\"\""))
    } else {
        s.to_string()
    }
}

fn tsv_field(s: &str) -> String {
    s.split(['\t', '\r', '\n'])
        .filter(|p| !p.is_empty())
        .collect::<Vec<_>>()
        .join(" ")
}

/// Integers stay exact (JSON numbers carry any digits); non-finite floats
/// and bytes become strings.
fn json(v: &Value) -> serde_json::Value {
    match v {
        Value::Null => serde_json::Value::Null,
        Value::Bool(b) => (*b).into(),
        Value::Int(n) => (*n).into(),
        Value::Float(f) => serde_json::Number::from_f64(*f)
            .map(serde_json::Value::Number)
            .unwrap_or_else(|| f.to_string().into()),
        Value::Text(t) => t.clone().into(),
        Value::Bytes(b) => hex(b).into(),
    }
}

fn literal(engine: EngineKind, v: &Value) -> String {
    match v {
        Value::Null => "NULL".into(),
        Value::Bool(b) => if *b { "TRUE" } else { "FALSE" }.into(),
        Value::Int(n) => n.to_string(),
        Value::Float(f) if f.is_finite() => f.to_string(),
        Value::Float(f) => format!("'{f}'"),
        Value::Text(t) => format!("'{}'", t.replace('\'', "''")),
        Value::Bytes(b) => match engine {
            EngineKind::Postgres => format!("'{}'::bytea", hex(b)),
            EngineKind::Sqlite => {
                let digits: String = b.iter().map(|x| format!("{x:02X}")).collect();
                format!("X'{digits}'")
            }
        },
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn cols() -> Vec<Column> {
        ["id", "note", "ok", "data"]
            .iter()
            .map(|n| Column {
                name: n.to_string(),
                type_name: "text".into(),
            })
            .collect()
    }

    fn rows() -> Vec<Vec<Value>> {
        vec![
            vec![
                Value::Int(9_007_199_254_740_993),
                Value::Text("a, \"b\"\nc\td".into()),
                Value::Bool(true),
                Value::Bytes(vec![0xde, 0xad]),
            ],
            vec![
                Value::Int(2),
                Value::Text("it's".into()),
                Value::Null,
                Value::Null,
            ],
        ]
    }

    fn write(format: ExportFormat) -> String {
        let mut w = ExportWriter::new(Vec::new(), format);
        w.columns(&cols()).unwrap();
        for r in rows() {
            w.row(&r).unwrap();
        }
        assert_eq!(w.rows_written(), 2);
        String::from_utf8(w.finish().unwrap()).unwrap()
    }

    #[test]
    fn csv_quotes_and_nulls() {
        assert_eq!(
            write(ExportFormat::Csv),
            "id,note,ok,data\n9007199254740993,\"a, \"\"b\"\"\nc\td\",true,\\xdead\n2,it's,,\n"
        );
    }

    #[test]
    fn tsv_flattens_breaks() {
        assert_eq!(
            write(ExportFormat::Tsv),
            "id\tnote\tok\tdata\n9007199254740993\ta, \"b\" c d\ttrue\t\\xdead\n2\tit's\t\t\n"
        );
    }

    #[test]
    fn json_keeps_types_and_exact_ints() {
        let out = write(ExportFormat::Json);
        assert!(out.starts_with("[\n  {"), "{out}");
        let parsed: serde_json::Value = serde_json::from_str(&out).unwrap();
        assert_eq!(parsed[1]["note"], "it's");
        assert_eq!(parsed[1]["ok"], serde_json::Value::Null);
        assert_eq!(parsed[0]["data"], "\\xdead");
        assert!(out.contains("\"id\":9007199254740993"), "{out}");
        // No rows: an empty array.
        let mut w = ExportWriter::new(Vec::new(), ExportFormat::Json);
        w.columns(&cols()).unwrap();
        assert_eq!(String::from_utf8(w.finish().unwrap()).unwrap(), "[]\n");
    }

    #[test]
    fn sql_inserts_escape_per_engine() {
        let pg = write(ExportFormat::SqlInsert {
            engine: EngineKind::Postgres,
            schema: "public".into(),
            table: "my \"t\"".into(),
        });
        assert_eq!(
            pg.lines().last().unwrap(),
            "INSERT INTO public.\"my \"\"t\"\"\" (id, note, ok, data) VALUES (2, 'it''s', NULL, NULL);"
        );
        // Backslashes in text and in bytea's \x read as written on a server
        // with standard_conforming_strings off.
        assert!(
            pg.starts_with("SET standard_conforming_strings = on;\nINSERT INTO "),
            "{pg}"
        );
        // A line break inside a value stays in its literal.
        assert!(
            pg.contains("'a, \"b\"\nc\td', TRUE, '\\xdead'::bytea);\n"),
            "{pg}"
        );
        let lite = write(ExportFormat::SqlInsert {
            engine: EngineKind::Sqlite,
            schema: "main".into(),
            table: "t".into(),
        });
        // SQLite strings have no escapes: no SET.
        assert!(lite.starts_with("INSERT INTO t ("), "{lite}");
        assert!(lite.contains("X'DEAD');\n"), "{lite}");
    }

    #[test]
    fn format_from_extension() {
        let f = |p: &str| ExportFormat::from_path(p, EngineKind::Postgres, "public", "t");
        assert_eq!(f("/x/out.TSV"), ExportFormat::Tsv);
        assert_eq!(f("out.json"), ExportFormat::Json);
        assert!(matches!(f("out.sql"), ExportFormat::SqlInsert { .. }));
        assert_eq!(f("out.csv"), ExportFormat::Csv);
        assert_eq!(f("out"), ExportFormat::Csv);
    }
}
