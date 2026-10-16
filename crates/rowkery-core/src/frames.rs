//! Binary columnar rows frames: how result rows travel to the webview.
//!
//! One frame holds a run of rows, column by column, so the webview decodes it
//! with one `DataView` pass into typed arrays instead of parsing a JSON object
//! per cell. Little-endian throughout. Layout (docs/spec.md, Wire format):
//!
//! ```text
//! header   u32 magic "INL1" (0x494E4C31) · u8 frame_type (2 = rows) · u8 flags
//!          (bit0 last rows frame) · u16 reserved · u64 query_id · u32 seq ·
//!          f64 sent_at_ms (unix epoch ms; the receiver measures bytes/ms) = 28 bytes
//! rows     u32 row_count · u16 column_count · per column: u8 wire_kind,
//!          null bitmap (ceil(rows / 8) bytes, bit set = NULL), then its block
//! ```
//!
//! Blocks by wire kind (a NULL keeps its slot: zero in fixed-width blocks, an
//! empty string in string blocks):
//! - `BOOL` u8 per row · `INT32` i32 per row · `F64` f64 per row
//! - `INT64`, `NUMERIC`, `STRING`, `JSON`: a string block, `u32 offsets[rows + 1]`
//!   then the UTF-8 bytes (int8 as exact decimal digits)
//! - `BYTES`: per row `u32 length` + the first 16 bytes, zero-padded (the grid
//!   shows `<N bytes>`; the full value stays in the database)
//! - `MIXED` (a column whose cells are not all one kind, e.g. SQLite): `u8 tag`
//!   per row (0 null, 1 int32, 2 int64, 3 f64, 4 string, 5 bytes, 6 bool) then
//!   one block per tag 1–6 holding only that tag's rows, in row order, each
//!   prefixed by its `u32` count
//!
//! A frame with flags bit1 set carries the result's column profiles after its
//! blocks (`profile.rs`): the frame that completes the profile sample.
//!
//! Columns, done and hold travel as small JSON frames beside these.

use crate::db::{Column, Value};

pub const MAGIC: u32 = 0x494E_4C31;
pub const HEADER_LEN: usize = 28;
pub const FRAME_ROWS: u8 = 2;
pub const FLAG_LAST: u8 = 1;
pub const FLAG_PROFILE: u8 = 2;

/// How a column's cells are laid out in a rows frame.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
#[repr(u8)]
pub enum WireKind {
    Bool = 1,
    Int32 = 2,
    Int64 = 3,
    F64 = 4,
    Numeric = 5,
    String = 6,
    Json = 7,
    Bytes = 8,
    Mixed = 9,
}

const BYTES_PREFIX: usize = 16;

/// What a column's type says about its text cells.
fn text_kind(type_name: &str) -> WireKind {
    let t = type_name.to_ascii_lowercase();
    if t == "numeric" || t == "decimal" || t.starts_with("numeric(") || t.starts_with("decimal(") {
        WireKind::Numeric
    } else if t == "json" || t == "jsonb" {
        WireKind::Json
    } else {
        WireKind::String
    }
}

/// The one kind every non-null cell of column `c` has, or `Mixed`.
fn column_kind(column: &Column, rows: &[Vec<Value>], c: usize) -> WireKind {
    let mut kind: Option<WireKind> = None;
    for row in rows {
        let k = match row.get(c).unwrap_or(&Value::Null) {
            Value::Null => continue,
            Value::Bool(_) => WireKind::Bool,
            Value::Int(n) if i32::try_from(*n).is_ok() => WireKind::Int32,
            Value::Int(_) => WireKind::Int64,
            Value::Float(_) => WireKind::F64,
            Value::Text(_) => text_kind(&column.type_name),
            Value::Bytes(_) => WireKind::Bytes,
        };
        kind = match (kind, k) {
            (None, k) => Some(k),
            (Some(a), b) if a == b => Some(a),
            // A column of ints where some don't fit i32 is all int64.
            (Some(WireKind::Int32), WireKind::Int64) | (Some(WireKind::Int64), WireKind::Int32) => {
                Some(WireKind::Int64)
            }
            _ => return WireKind::Mixed,
        };
    }
    // An all-NULL column costs only its bitmap and empty offsets.
    kind.unwrap_or(WireKind::String)
}

struct Writer(Vec<u8>);

impl Writer {
    fn u8(&mut self, v: u8) {
        self.0.push(v);
    }
    fn u16(&mut self, v: u16) {
        self.0.extend_from_slice(&v.to_le_bytes());
    }
    fn u32(&mut self, v: u32) {
        self.0.extend_from_slice(&v.to_le_bytes());
    }
    fn i32(&mut self, v: i32) {
        self.0.extend_from_slice(&v.to_le_bytes());
    }
    fn u64(&mut self, v: u64) {
        self.0.extend_from_slice(&v.to_le_bytes());
    }
    fn f64(&mut self, v: f64) {
        self.0.extend_from_slice(&v.to_le_bytes());
    }

    /// `u32 offsets[n + 1]` then the bytes; `None` is an empty entry.
    fn strings<'a>(&mut self, cells: impl Iterator<Item = Option<std::borrow::Cow<'a, str>>>) {
        let cells: Vec<_> = cells.collect();
        let mut offset = 0u32;
        self.u32(0);
        for s in &cells {
            offset += s.as_ref().map_or(0, |s| s.len() as u32);
            self.u32(offset);
        }
        for s in cells.into_iter().flatten() {
            self.0.extend_from_slice(s.as_bytes());
        }
    }

    fn bytes_block<'a>(&mut self, cells: impl Iterator<Item = Option<&'a [u8]>>) {
        for b in cells {
            let b = b.unwrap_or(&[]);
            self.u32(b.len() as u32);
            let mut prefix = [0u8; BYTES_PREFIX];
            let n = b.len().min(BYTES_PREFIX);
            prefix[..n].copy_from_slice(&b[..n]);
            self.0.extend_from_slice(&prefix);
        }
    }
}

fn as_text(v: &Value) -> Option<std::borrow::Cow<'_, str>> {
    match v {
        Value::Null => None,
        Value::Text(s) => Some(std::borrow::Cow::Borrowed(s.as_str())),
        Value::Int(n) => Some(std::borrow::Cow::Owned(n.to_string())),
        Value::Float(f) => Some(std::borrow::Cow::Owned(f.to_string())),
        Value::Bool(b) => Some(std::borrow::Cow::Borrowed(if *b {
            "true"
        } else {
            "false"
        })),
        Value::Bytes(b) => Some(std::borrow::Cow::Owned(format!("<{} bytes>", b.len()))),
    }
}

/// Encodes one rows frame. `rows` may be empty (a result with no rows sends none).
pub fn encode_rows(
    query_id: u64,
    seq: u32,
    sent_at_ms: f64,
    last: bool,
    columns: &[Column],
    rows: &[Vec<Value>],
) -> Vec<u8> {
    let n = rows.len();
    let mut w = Writer(Vec::with_capacity(HEADER_LEN + 8 + n * columns.len() * 8));
    w.u32(MAGIC);
    w.u8(FRAME_ROWS);
    w.u8(if last { FLAG_LAST } else { 0 });
    w.u16(0);
    w.u64(query_id);
    w.u32(seq);
    w.f64(sent_at_ms);
    w.u32(n as u32);
    w.u16(columns.len() as u16);
    let cell = |r: usize, c: usize| rows[r].get(c).unwrap_or(&Value::Null);
    for (c, column) in columns.iter().enumerate() {
        let kind = column_kind(column, rows, c);
        w.u8(kind as u8);
        let mut bitmap = vec![0u8; n.div_ceil(8)];
        for r in 0..n {
            if matches!(cell(r, c), Value::Null) {
                bitmap[r / 8] |= 1 << (r % 8);
            }
        }
        w.0.extend_from_slice(&bitmap);
        match kind {
            WireKind::Bool => {
                (0..n).for_each(|r| w.u8(matches!(cell(r, c), Value::Bool(true)) as u8))
            }
            WireKind::Int32 => (0..n).for_each(|r| {
                w.i32(match cell(r, c) {
                    Value::Int(v) => *v as i32,
                    _ => 0,
                })
            }),
            WireKind::F64 => (0..n).for_each(|r| {
                w.f64(match cell(r, c) {
                    Value::Float(v) => *v,
                    _ => 0.0,
                })
            }),
            WireKind::Int64 | WireKind::Numeric | WireKind::String | WireKind::Json => {
                w.strings((0..n).map(|r| as_text(cell(r, c))))
            }
            WireKind::Bytes => w.bytes_block((0..n).map(|r| match cell(r, c) {
                Value::Bytes(b) => Some(b.as_slice()),
                _ => None,
            })),
            WireKind::Mixed => {
                let tag = |v: &Value| match v {
                    Value::Null => 0u8,
                    Value::Int(n) if i32::try_from(*n).is_ok() => 1,
                    Value::Int(_) => 2,
                    Value::Float(_) => 3,
                    Value::Text(_) => 4,
                    Value::Bytes(_) => 5,
                    Value::Bool(_) => 6,
                };
                (0..n).for_each(|r| w.u8(tag(cell(r, c))));
                for t in 1..=6u8 {
                    let rs: Vec<usize> = (0..n).filter(|&r| tag(cell(r, c)) == t).collect();
                    w.u32(rs.len() as u32);
                    match t {
                        1 => rs.iter().for_each(|&r| {
                            if let Value::Int(v) = cell(r, c) {
                                w.i32(*v as i32)
                            }
                        }),
                        2 | 4 => w.strings(rs.iter().map(|&r| as_text(cell(r, c)))),
                        3 => rs.iter().for_each(|&r| {
                            if let Value::Float(v) = cell(r, c) {
                                w.f64(*v)
                            }
                        }),
                        5 => w.bytes_block(rs.iter().map(|&r| match cell(r, c) {
                            Value::Bytes(b) => Some(b.as_slice()),
                            _ => None,
                        })),
                        _ => rs
                            .iter()
                            .for_each(|&r| w.u8(matches!(cell(r, c), Value::Bool(true)) as u8)),
                    }
                }
            }
        }
    }
    w.0
}

/// Appends the result's column profiles to an encoded rows frame and flags it.
pub fn attach_profile(frame: &mut Vec<u8>, profiles: &[crate::profile::ColumnProfile]) {
    frame[5] |= FLAG_PROFILE;
    crate::profile::write(frame, profiles);
}

/// Decodes a rows frame back into `Value`s (tests and golden files; the
/// webview has its own decoder in `resultStore.ts`). BYTES come back as their
/// 16-byte prefix and INT64 as `Int`.
/// A decoded rows frame: query id, seq, last flag, rows.
pub type DecodedRows = (u64, u32, bool, Vec<Vec<Value>>);

pub fn decode_rows(frame: &[u8]) -> Result<DecodedRows, String> {
    decode_rows_and_profile(frame).map(|(rows, _)| rows)
}

/// [`decode_rows`] plus the profiles a frame carries, if it does.
pub fn decode_rows_and_profile(
    frame: &[u8],
) -> Result<(DecodedRows, Option<Vec<crate::profile::ColumnProfile>>), String> {
    struct R<'a>(&'a [u8], usize);
    impl R<'_> {
        fn take(&mut self, n: usize) -> Result<&[u8], String> {
            let s = self.0.get(self.1..self.1 + n).ok_or("frame too short")?;
            self.1 += n;
            Ok(s)
        }
        fn u8(&mut self) -> Result<u8, String> {
            Ok(self.take(1)?[0])
        }
        fn u16(&mut self) -> Result<u16, String> {
            Ok(u16::from_le_bytes(self.take(2)?.try_into().unwrap()))
        }
        fn u32(&mut self) -> Result<u32, String> {
            Ok(u32::from_le_bytes(self.take(4)?.try_into().unwrap()))
        }
        fn i32(&mut self) -> Result<i32, String> {
            Ok(i32::from_le_bytes(self.take(4)?.try_into().unwrap()))
        }
        fn u64(&mut self) -> Result<u64, String> {
            Ok(u64::from_le_bytes(self.take(8)?.try_into().unwrap()))
        }
        fn f64(&mut self) -> Result<f64, String> {
            Ok(f64::from_le_bytes(self.take(8)?.try_into().unwrap()))
        }
        fn strings(&mut self, n: usize) -> Result<Vec<String>, String> {
            let offsets: Vec<u32> = (0..=n).map(|_| self.u32()).collect::<Result<_, _>>()?;
            let bytes = self.take(*offsets.last().unwrap_or(&0) as usize)?;
            (0..n)
                .map(|i| {
                    String::from_utf8(bytes[offsets[i] as usize..offsets[i + 1] as usize].to_vec())
                        .map_err(|e| e.to_string())
                })
                .collect()
        }
        fn bytes(&mut self, n: usize) -> Result<Vec<Vec<u8>>, String> {
            (0..n)
                .map(|_| {
                    let len = self.u32()? as usize;
                    let prefix = self.take(BYTES_PREFIX)?;
                    Ok(prefix[..len.min(BYTES_PREFIX)].to_vec())
                })
                .collect()
        }
    }
    let mut r = R(frame, 0);
    if r.u32()? != MAGIC {
        return Err("not an INL1 frame".into());
    }
    if r.u8()? != FRAME_ROWS {
        return Err("not a rows frame".into());
    }
    let flags = r.u8()?;
    let last = flags & FLAG_LAST != 0;
    r.u16()?;
    let query_id = r.u64()?;
    let seq = r.u32()?;
    r.f64()?;
    let n = r.u32()? as usize;
    let ncols = r.u16()? as usize;
    let mut rows = vec![Vec::with_capacity(ncols); n];
    for _ in 0..ncols {
        let kind = r.u8()?;
        let bitmap = r.take(n.div_ceil(8))?.to_vec();
        let null = |i: usize| bitmap[i / 8] & (1 << (i % 8)) != 0;
        let col: Vec<Value> = match kind {
            1 => (0..n)
                .map(|_| r.u8().map(|b| Value::Bool(b != 0)))
                .collect::<Result<_, _>>()?,
            2 => (0..n)
                .map(|_| r.i32().map(|v| Value::Int(v as i64)))
                .collect::<Result<_, _>>()?,
            4 => (0..n)
                .map(|_| r.f64().map(Value::Float))
                .collect::<Result<_, _>>()?,
            3 => r
                .strings(n)?
                .into_iter()
                .map(|s| s.parse().map(Value::Int).unwrap_or(Value::Null))
                .collect(),
            5..=7 => r.strings(n)?.into_iter().map(Value::Text).collect(),
            8 => r.bytes(n)?.into_iter().map(Value::Bytes).collect(),
            9 => {
                let tags = r.take(n)?.to_vec();
                let mut by_tag: Vec<std::collections::VecDeque<Value>> =
                    vec![Default::default(); 7];
                for (t, slot) in by_tag.iter_mut().enumerate().skip(1) {
                    let count = r.u32()? as usize;
                    let vals: Vec<Value> = match t {
                        1 => (0..count)
                            .map(|_| r.i32().map(|v| Value::Int(v as i64)))
                            .collect::<Result<_, _>>()?,
                        2 => r
                            .strings(count)?
                            .into_iter()
                            .map(|s| s.parse().map(Value::Int).unwrap_or(Value::Null))
                            .collect(),
                        3 => (0..count)
                            .map(|_| r.f64().map(Value::Float))
                            .collect::<Result<_, _>>()?,
                        4 => r.strings(count)?.into_iter().map(Value::Text).collect(),
                        5 => r.bytes(count)?.into_iter().map(Value::Bytes).collect(),
                        _ => (0..count)
                            .map(|_| r.u8().map(|b| Value::Bool(b != 0)))
                            .collect::<Result<_, _>>()?,
                    };
                    *slot = vals.into();
                }
                tags.iter()
                    .map(|&t| {
                        by_tag
                            .get_mut(t as usize)
                            .and_then(|q| q.pop_front())
                            .unwrap_or(Value::Null)
                    })
                    .collect()
            }
            other => return Err(format!("unknown wire kind {other}")),
        };
        for (i, v) in col.into_iter().enumerate() {
            rows[i].push(if null(i) { Value::Null } else { v });
        }
    }
    let profiles = if flags & FLAG_PROFILE != 0 {
        Some(crate::profile::read(&frame[r.1..])?)
    } else {
        None
    };
    Ok(((query_id, seq, last, rows), profiles))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn col(name: &str, type_name: &str) -> Column {
        Column {
            name: name.into(),
            type_name: type_name.into(),
        }
    }

    /// Every wire kind, NULLs in each, and a mixed (SQLite-style) column.
    pub(crate) fn golden_input() -> (Vec<Column>, Vec<Vec<Value>>) {
        let columns = vec![
            col("ok", "bool"),
            col("small", "int4"),
            col("big", "int8"),
            col("ratio", "float8"),
            col("amount", "numeric"),
            col("name", "text"),
            col("doc", "jsonb"),
            col("blob", "bytea"),
            col("any", ""),
        ];
        let rows = vec![
            vec![
                Value::Bool(true),
                Value::Int(-7),
                Value::Int(i64::MAX),
                Value::Float(1.5),
                Value::Text("12345.678".into()),
                Value::Text("it's ünïcode".into()),
                Value::Text(r#"{"a":1}"#.into()),
                Value::Bytes((0u8..20).collect()),
                Value::Int(42),
            ],
            vec![
                Value::Null,
                Value::Null,
                Value::Int(-9_007_199_254_740_993),
                Value::Null,
                Value::Null,
                Value::Text(String::new()),
                Value::Null,
                Value::Bytes(vec![0xde, 0xad]),
                Value::Text("text".into()),
            ],
            vec![
                Value::Bool(false),
                Value::Int(i32::MAX as i64),
                Value::Null,
                Value::Float(f64::NAN),
                Value::Text("-0.0005".into()),
                Value::Null,
                Value::Text("[]".into()),
                Value::Null,
                Value::Null,
            ],
            vec![
                Value::Bool(true),
                Value::Int(0),
                Value::Int(3),
                Value::Float(f64::NEG_INFINITY),
                Value::Text("NaN".into()),
                Value::Text("x".into()),
                Value::Text("null".into()),
                Value::Bytes(vec![]),
                Value::Float(2.25),
            ],
        ];
        (columns, rows)
    }

    #[test]
    fn kinds_follow_types_and_values() {
        let (columns, rows) = golden_input();
        let kinds: Vec<WireKind> = (0..columns.len())
            .map(|c| column_kind(&columns[c], &rows, c))
            .collect();
        use WireKind::*;
        assert_eq!(
            kinds,
            [Bool, Int32, Int64, F64, Numeric, String, Json, Bytes, Mixed]
        );
        assert_eq!(
            column_kind(&col("x", "int4"), &[vec![Value::Null]], 0),
            String
        );
    }

    #[test]
    fn rows_round_trip() {
        let (columns, rows) = golden_input();
        let frame = encode_rows(9, 3, 1.0, true, &columns, &rows);
        let (query_id, seq, last, back) = decode_rows(&frame).unwrap();
        assert_eq!((query_id, seq, last), (9, 3, true));
        for (r, (got, want)) in back.iter().zip(&rows).enumerate() {
            for (c, (g, w)) in got.iter().zip(want).enumerate() {
                match (g, w) {
                    // BYTES keep their first 16 bytes.
                    (Value::Bytes(g), Value::Bytes(w)) => {
                        assert_eq!(g[..], w[..w.len().min(16)], "{r},{c}")
                    }
                    (Value::Float(g), Value::Float(w)) if w.is_nan() => assert!(g.is_nan()),
                    _ => assert_eq!(g, w, "{r},{c}"),
                }
            }
        }
    }

    /// The cell as the webview's decoder reads it (`resultStore.ts` `get`):
    /// JSON can't hold NaN or ±Infinity, so floats are spelled as strings.
    fn webview_cell(v: &Value) -> serde_json::Value {
        use serde_json::json;
        match v {
            Value::Null => json!(null),
            Value::Bool(b) => json!({ "Bool": b }),
            Value::Int(n)
                if (-crate::db::JS_SAFE_INTEGER..=crate::db::JS_SAFE_INTEGER).contains(n) =>
            {
                json!({ "Int": n })
            }
            Value::Int(n) => json!({ "BigInt": n.to_string() }),
            // JavaScript's spelling of the number (`String(x)`).
            Value::Float(f) if f.is_infinite() => {
                json!({ "Float": if *f > 0.0 { "Infinity" } else { "-Infinity" } })
            }
            Value::Float(f) => json!({ "Float": f.to_string() }),
            Value::Text(t) => json!({ "Text": t }),
            Value::Bytes(b) => json!({ "Bytes": b[..b.len().min(16)], "byteLength": b.len() }),
        }
    }

    /// `tests/frames/golden.bin` is this fixture encoded; `golden.json` is what
    /// the webview must decode from it (`test/frames.test.ts` reads both).
    /// `UPDATE_GOLDEN=1 cargo test -p rowkery-core frames` rewrites them.
    #[test]
    fn golden_files_match() {
        let (columns, rows) = golden_input();
        let frame = encode_rows(42, 1, 1_700_000_000_000.0, true, &columns, &rows);
        let kinds: Vec<WireKind> = (0..columns.len())
            .map(|c| column_kind(&columns[c], &rows, c))
            .collect();
        let expected = serde_json::json!({
            "query_id": 42,
            "seq": 1,
            "last": true,
            "sent_at_ms": 1_700_000_000_000.0,
            "kinds": kinds.iter().map(|k| *k as u8).collect::<Vec<_>>(),
            "rows": rows.iter().map(|row| row.iter().map(webview_cell).collect::<Vec<_>>()).collect::<Vec<_>>(),
        });
        let dir = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/frames");
        let json = format!("{}\n", serde_json::to_string_pretty(&expected).unwrap());
        if std::env::var_os("UPDATE_GOLDEN").is_some() {
            std::fs::create_dir_all(&dir).unwrap();
            std::fs::write(dir.join("golden.bin"), &frame).unwrap();
            std::fs::write(dir.join("golden.json"), &json).unwrap();
        }
        assert_eq!(
            std::fs::read(dir.join("golden.bin")).unwrap(),
            frame,
            "UPDATE_GOLDEN=1 to rewrite"
        );
        assert_eq!(
            std::fs::read_to_string(dir.join("golden.json")).unwrap(),
            json
        );
    }

    /// `tests/frames/golden-profile.bin` is the golden frame carrying its
    /// profiles; `golden-profile.json` spells them out for `frames.test.ts`.
    #[test]
    fn profile_golden_files_match() {
        let (columns, rows) = golden_input();
        let profiles = crate::profile::profile_rows(&columns, &rows);
        let mut frame = encode_rows(42, 1, 1_700_000_000_000.0, true, &columns, &rows);
        attach_profile(&mut frame, &profiles);
        let ((_, _, _, back), got) = decode_rows_and_profile(&frame).unwrap();
        assert_eq!(back.len(), rows.len());
        assert_eq!(got.as_deref(), Some(&profiles[..]));
        let expected: Vec<serde_json::Value> = profiles
            .iter()
            .map(|p| {
                serde_json::json!({
                    "kind": p.kind as u8,
                    "sampleRows": p.sample_rows,
                    "nulls": p.nulls,
                    "distinct": p.distinct,
                    "min": p.min,
                    "max": p.max,
                    "bins": p.bins,
                    "wholeBins": p.whole_bins,
                    "top": p.top,
                })
            })
            .collect();
        let dir = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/frames");
        let json = format!("{}\n", serde_json::to_string_pretty(&expected).unwrap());
        if std::env::var_os("UPDATE_GOLDEN").is_some() {
            std::fs::write(dir.join("golden-profile.bin"), &frame).unwrap();
            std::fs::write(dir.join("golden-profile.json"), &json).unwrap();
        }
        assert_eq!(
            std::fs::read(dir.join("golden-profile.bin")).unwrap(),
            frame,
            "UPDATE_GOLDEN=1 to rewrite"
        );
        assert_eq!(
            std::fs::read_to_string(dir.join("golden-profile.json")).unwrap(),
            json
        );
    }

    #[test]
    fn an_empty_frame_has_header_and_columns_only() {
        let frame = encode_rows(1, 0, 0.0, false, &[col("a", "int4")], &[]);
        assert_eq!(frame.len(), HEADER_LEN + 4 + 2 + 1 + 4);
        assert_eq!(decode_rows(&frame).unwrap().3, Vec::<Vec<Value>>::new());
    }
}
