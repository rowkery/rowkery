//! Column profiles: the shape of a result's first rows, drawn under each grid
//! header (a histogram, a split bar of the top values, or "N unique").
//!
//! Computed once, here, over the first [`SAMPLE_ROWS`] rows (or all of them
//! when fewer) as they stream past the channel sink, and sent in the rows
//! frame that completes the sample (`frames::attach_profile`). The webview
//! only draws them (`columnProfile.ts`); nothing scans rows on its thread,
//! and nothing merges histograms as more rows load.
//!
//! Wire layout, per frame: `u16 n`, then per column `u8 kind` · `u8 flags`
//! (bit0: whole-number bins, one per value from `min`) · `u32 sample_rows` ·
//! `u32 nulls` · `u32 distinct` (`0xFFFFFFFF` = "unique": more than
//! [`DISTINCT_CAP`] keys) · `f64 min` · `f64 max` · `u32 bins[14]` ·
//! `u8 top_n` then per top value `u32 len` + UTF-8 bytes · `u32 count`.

use std::collections::HashMap;

use crate::db::{Column, Value};

/// Profiles read this many rows at most, so a 100k-row result costs no more.
pub const SAMPLE_ROWS: usize = 5000;
/// Distinct values tracked per column; past it the column reads "unique".
pub const DISTINCT_CAP: usize = 256;
pub const BINS: usize = 14;
/// Most common values sent per column.
pub const TOP_N: usize = 8;
/// `distinct` when more than [`DISTINCT_CAP`] values were seen.
pub const UNIQUE: u32 = u32::MAX;
const FLAG_WHOLE_BINS: u8 = 1;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
#[repr(u8)]
pub enum ProfileKind {
    /// No profile (bytea / blob).
    None = 0,
    Numeric = 1,
    Categorical = 2,
    Boolean = 3,
    /// Dates and timestamps; `min`, `max` and bins in Unix epoch ms.
    Temporal = 4,
}

#[derive(Clone, Debug, PartialEq)]
pub struct ColumnProfile {
    pub kind: ProfileKind,
    pub sample_rows: u32,
    pub nulls: u32,
    /// Distinct non-null values, or [`UNIQUE`].
    pub distinct: u32,
    /// Numeric and temporal: the sample's range, split into `bins`.
    pub min: f64,
    pub max: f64,
    pub bins: [u32; BINS],
    /// A few whole numbers (ids 2041–2047) get a bin each: bin `b` is `min + b`.
    pub whole_bins: bool,
    /// Categorical and boolean: the most common values, most common first
    /// (ties in the order first seen).
    pub top: Vec<(String, u32)>,
}

fn is_numeric_type(t: &str) -> bool {
    const PREFIXES: [&str; 14] = [
        "int",
        "integer",
        "bigint",
        "smallint",
        "tinyint",
        "mediumint",
        "real",
        "double",
        "float",
        "numeric",
        "decimal",
        "money",
        "serial",
        "bigserial",
    ];
    PREFIXES.iter().any(|p| t.starts_with(p))
}

fn is_time_type(t: &str) -> bool {
    t.starts_with("timestamp") || t.starts_with("date")
}

/// What the column's declared type says; `None` (outer) when it says nothing
/// (SQLite expressions), so the first non-null value decides.
fn declared_kind(type_name: &str) -> Option<ProfileKind> {
    let t = type_name.to_ascii_lowercase();
    if t == "bytea" || t == "blob" {
        Some(ProfileKind::None)
    } else if is_time_type(&t) {
        Some(ProfileKind::Temporal)
    } else if is_numeric_type(&t) {
        Some(ProfileKind::Numeric)
    } else if t.starts_with("bool") {
        Some(ProfileKind::Boolean)
    } else if t.is_empty() {
        None
    } else {
        Some(ProfileKind::Categorical)
    }
}

/// Days from 1970-01-01 to a civil date (proleptic Gregorian).
fn days_from_civil(y: i64, m: i64, d: i64) -> i64 {
    let y = if m <= 2 { y - 1 } else { y };
    let era = y.div_euclid(400);
    let yoe = y - era * 400;
    let mp = (m + 9) % 12;
    let doy = (153 * mp + 2) / 5 + d - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    era * 146_097 + doe - 719_468
}

/// `YYYY-MM-DD[ T]HH:MM:SS…` → epoch ms, the zone ignored (as the grid reads it).
fn time_ms(s: &str) -> Option<f64> {
    let b = s.as_bytes();
    let num = |from: usize, len: usize| -> Option<i64> {
        let part = b.get(from..from + len)?;
        part.iter()
            .all(u8::is_ascii_digit)
            .then(|| std::str::from_utf8(part).ok()?.parse().ok())?
    };
    let (y, mo, d) = (num(0, 4)?, num(5, 2)?, num(8, 2)?);
    if b[4] != b'-' || b[7] != b'-' {
        return None;
    }
    let (mut h, mut mi, mut sec, mut ms) = (0, 0, 0, 0);
    if matches!(b.get(10), Some(b' ' | b'T'))
        && b.get(13) == Some(&b':')
        && b.get(16) == Some(&b':')
    {
        if let (Some(a), Some(c), Some(e)) = (num(11, 2), num(14, 2), num(17, 2)) {
            (h, mi, sec) = (a, c, e);
            // Milliseconds count (microseconds cut): a histogram edge built
            // from whole seconds would leave out the rows past them.
            if b.get(19) == Some(&b'.') {
                let mut scale = 100;
                for &digit in b[20..].iter().take(3).take_while(|c| c.is_ascii_digit()) {
                    ms += i64::from(digit - b'0') * scale;
                    scale /= 10;
                }
            }
        }
    }
    let days = days_from_civil(y, mo, d);
    Some(((days * 24 + h) * 60 + mi) as f64 * 60_000.0 + (sec * 1000 + ms) as f64)
}

/// A cell as a number for the histogram: `Some(None)` for NULL, `None` when
/// it isn't one (the column then profiles as categorical).
fn cell_number(v: &Value, time: bool) -> Option<Option<f64>> {
    let x = match v {
        Value::Null => return Some(None),
        Value::Int(n) => *n as f64,
        Value::Float(f) => *f,
        Value::Text(s) if time => time_ms(s)?,
        Value::Text(s) => {
            let t = s.trim();
            if t.is_empty() {
                return None;
            }
            t.parse().ok()?
        }
        Value::Bool(_) | Value::Bytes(_) => return None,
    };
    x.is_finite().then_some(Some(x))
}

/// A cell's value as the grid prints it, the key it is counted under.
fn cell_key(v: &Value) -> String {
    match v {
        Value::Null => String::new(),
        Value::Bool(b) => b.to_string(),
        Value::Int(n) => n.to_string(),
        // JavaScript's spelling, as the grid prints it.
        Value::Float(f) if f.is_infinite() => {
            (if *f > 0.0 { "Infinity" } else { "-Infinity" }).into()
        }
        Value::Float(f) => f.to_string(),
        Value::Text(s) => s.clone(),
        Value::Bytes(b) => format!("<{} bytes>", b.len()),
    }
}

#[derive(Default)]
struct ColumnAcc {
    kind: Option<ProfileKind>,
    rows: u32,
    nulls: u32,
    /// Numeric / temporal candidates: every value so far; `None` once one wasn't a number.
    numbers: Option<Vec<f64>>,
    /// Counts in first-seen order, and where each key sits in it.
    counts: Vec<(String, u32)>,
    index: HashMap<String, usize>,
    /// More than `DISTINCT_CAP` keys: counting stopped.
    over_cap: bool,
}

impl ColumnAcc {
    fn new(column: &Column) -> Self {
        let kind = declared_kind(&column.type_name);
        Self {
            kind,
            numbers: match kind {
                Some(ProfileKind::Numeric | ProfileKind::Temporal) | None => Some(Vec::new()),
                _ => None,
            },
            ..Self::default()
        }
    }

    fn add(&mut self, v: &Value) {
        self.rows += 1;
        if matches!(v, Value::Null) {
            self.nulls += 1;
            return;
        }
        if self.kind.is_none() {
            // An untyped column goes by its first non-null value.
            self.kind = Some(match v {
                Value::Int(_) | Value::Float(_) => ProfileKind::Numeric,
                Value::Bool(_) => ProfileKind::Boolean,
                _ => ProfileKind::Categorical,
            });
            if self.kind != Some(ProfileKind::Numeric) {
                self.numbers = None;
            }
        }
        if self.kind == Some(ProfileKind::None) {
            return;
        }
        if let Some(numbers) = &mut self.numbers {
            match cell_number(v, self.kind == Some(ProfileKind::Temporal)) {
                Some(Some(x)) => numbers.push(x),
                _ => self.numbers = None,
            }
        }
        if self.over_cap {
            return;
        }
        let key = cell_key(v);
        if let Some(&i) = self.index.get(&key) {
            self.counts[i].1 += 1;
        } else if self.counts.len() == DISTINCT_CAP {
            self.over_cap = true;
            self.counts = Vec::new();
            self.index = HashMap::new();
        } else {
            self.index.insert(key.clone(), self.counts.len());
            self.counts.push((key, 1));
        }
    }

    fn finish(self) -> ColumnProfile {
        let mut p = ColumnProfile {
            kind: self.kind.unwrap_or(ProfileKind::Categorical),
            sample_rows: self.rows,
            nulls: self.nulls,
            distinct: if self.over_cap {
                UNIQUE
            } else {
                self.counts.len() as u32
            },
            min: 0.0,
            max: 0.0,
            bins: [0; BINS],
            whole_bins: false,
            top: Vec::new(),
        };
        if p.kind == ProfileKind::None {
            p.distinct = 0;
            return p;
        }
        match self.numbers {
            Some(values) if matches!(p.kind, ProfileKind::Numeric | ProfileKind::Temporal) => {
                if values.is_empty() {
                    return p;
                }
                let (min, max) = values
                    .iter()
                    .fold((f64::INFINITY, f64::NEG_INFINITY), |(lo, hi), &x| {
                        (lo.min(x), hi.max(x))
                    });
                let span = max - min;
                p.min = min;
                p.max = max;
                p.whole_bins = span < BINS as f64 && values.iter().all(|x| x.fract() == 0.0);
                for x in values {
                    let b = if p.whole_bins {
                        (x - min) as usize
                    } else if span == 0.0 {
                        BINS / 2
                    } else {
                        (((x - min) / span * BINS as f64) as usize).min(BINS - 1)
                    };
                    p.bins[b] += 1;
                }
            }
            _ => {
                // A numeric type with a value that isn't a number reads as text.
                if matches!(p.kind, ProfileKind::Numeric | ProfileKind::Temporal) {
                    p.kind = ProfileKind::Categorical;
                }
                let mut ranked = self.counts;
                // Stable: equal counts keep the order first seen.
                ranked.sort_by_key(|a| std::cmp::Reverse(a.1));
                ranked.truncate(TOP_N);
                p.top = ranked;
            }
        }
        p
    }
}

/// Gathers the first [`SAMPLE_ROWS`] rows of a result as they stream past,
/// then profiles them once.
pub struct Profiler {
    columns: Vec<ColumnAcc>,
    rows: usize,
    limit: usize,
}

impl Profiler {
    pub fn new(columns: &[Column]) -> Self {
        Self::with_limit(columns, SAMPLE_ROWS)
    }

    pub fn with_limit(columns: &[Column], limit: usize) -> Self {
        Self {
            columns: columns.iter().map(ColumnAcc::new).collect(),
            rows: 0,
            limit,
        }
    }

    /// Reads rows until the sample is full; rows past it are ignored.
    pub fn add_rows(&mut self, rows: &[Vec<Value>]) {
        for row in rows.iter().take(self.limit - self.rows) {
            for (c, acc) in self.columns.iter_mut().enumerate() {
                acc.add(row.get(c).unwrap_or(&Value::Null));
            }
        }
        self.rows = (self.rows + rows.len()).min(self.limit);
    }

    pub fn rows(&self) -> usize {
        self.rows
    }

    pub fn is_full(&self) -> bool {
        self.rows >= self.limit
    }

    pub fn finish(self) -> Vec<ColumnProfile> {
        self.columns.into_iter().map(ColumnAcc::finish).collect()
    }
}

/// Profiles of `rows`' first [`SAMPLE_ROWS`] rows.
pub fn profile_rows(columns: &[Column], rows: &[Vec<Value>]) -> Vec<ColumnProfile> {
    let mut p = Profiler::new(columns);
    p.add_rows(rows);
    p.finish()
}

/// Appends the profile block (layout in the module docs).
pub fn write(out: &mut Vec<u8>, profiles: &[ColumnProfile]) {
    out.extend_from_slice(&(profiles.len() as u16).to_le_bytes());
    for p in profiles {
        out.push(p.kind as u8);
        out.push(if p.whole_bins { FLAG_WHOLE_BINS } else { 0 });
        for v in [p.sample_rows, p.nulls, p.distinct] {
            out.extend_from_slice(&v.to_le_bytes());
        }
        out.extend_from_slice(&p.min.to_le_bytes());
        out.extend_from_slice(&p.max.to_le_bytes());
        for b in p.bins {
            out.extend_from_slice(&b.to_le_bytes());
        }
        out.push(p.top.len().min(TOP_N) as u8);
        for (value, count) in p.top.iter().take(TOP_N) {
            out.extend_from_slice(&(value.len() as u32).to_le_bytes());
            out.extend_from_slice(value.as_bytes());
            out.extend_from_slice(&count.to_le_bytes());
        }
    }
}

/// Reads a profile block from the front of `b` (tests and golden files; the
/// webview's reader is in `resultStore.ts`).
pub fn read(b: &[u8]) -> Result<Vec<ColumnProfile>, String> {
    struct R<'a>(&'a [u8], usize);
    impl R<'_> {
        fn take(&mut self, n: usize) -> Result<&[u8], String> {
            let s = self.0.get(self.1..self.1 + n).ok_or("profile too short")?;
            self.1 += n;
            Ok(s)
        }
        fn u8(&mut self) -> Result<u8, String> {
            Ok(self.take(1)?[0])
        }
        fn u32(&mut self) -> Result<u32, String> {
            Ok(u32::from_le_bytes(self.take(4)?.try_into().unwrap()))
        }
        fn f64(&mut self) -> Result<f64, String> {
            Ok(f64::from_le_bytes(self.take(8)?.try_into().unwrap()))
        }
    }
    let mut r = R(b, 0);
    let n = u16::from_le_bytes(r.take(2)?.try_into().unwrap());
    let mut out = Vec::with_capacity(n as usize);
    for _ in 0..n {
        let kind = match r.u8()? {
            0 => ProfileKind::None,
            1 => ProfileKind::Numeric,
            2 => ProfileKind::Categorical,
            3 => ProfileKind::Boolean,
            4 => ProfileKind::Temporal,
            k => return Err(format!("unknown profile kind {k}")),
        };
        let flags = r.u8()?;
        let (sample_rows, nulls, distinct) = (r.u32()?, r.u32()?, r.u32()?);
        let (min, max) = (r.f64()?, r.f64()?);
        let mut bins = [0u32; BINS];
        for slot in &mut bins {
            *slot = r.u32()?;
        }
        let top_n = r.u8()?;
        let mut top = Vec::with_capacity(top_n as usize);
        for _ in 0..top_n {
            let len = r.u32()? as usize;
            let value = String::from_utf8(r.take(len)?.to_vec()).map_err(|e| e.to_string())?;
            top.push((value, r.u32()?));
        }
        out.push(ColumnProfile {
            kind,
            sample_rows,
            nulls,
            distinct,
            min,
            max,
            bins,
            whole_bins: flags & FLAG_WHOLE_BINS != 0,
            top,
        });
    }
    Ok(out)
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

    fn text(s: &str) -> Value {
        Value::Text(s.into())
    }

    fn one(type_name: &str, cells: Vec<Value>) -> ColumnProfile {
        let rows: Vec<Vec<Value>> = cells.into_iter().map(|v| vec![v]).collect();
        profile_rows(&[col("c", type_name)], &rows).remove(0)
    }

    #[test]
    fn a_few_whole_numbers_get_a_bin_each() {
        let p = one(
            "int8",
            vec![
                Value::Int(2041),
                Value::Int(2042),
                Value::Int(2042),
                Value::Int(2044),
            ],
        );
        assert_eq!(p.kind, ProfileKind::Numeric);
        assert!(p.whole_bins);
        assert_eq!((p.min, p.max), (2041.0, 2044.0));
        assert_eq!(p.bins[..4], [1, 2, 0, 1]);
        assert_eq!(p.distinct, 3);
    }

    #[test]
    fn a_wide_spread_uses_fourteen_bins_and_counts_nulls() {
        let mut cells: Vec<Value> = (0..99).map(|i| Value::Int(i * 100)).collect();
        cells.push(Value::Null);
        let p = one("numeric", cells);
        assert!(!p.whole_bins);
        assert_eq!((p.sample_rows, p.nulls), (100, 1));
        assert_eq!(p.bins.iter().sum::<u32>(), 99);
        // The maximum lands in the last bin.
        assert!(p.bins[BINS - 1] > 0);
    }

    #[test]
    fn numeric_text_and_one_value_columns() {
        let p = one("numeric(10,2)", vec![text("1.50"), text(" 2.25 ")]);
        assert_eq!((p.min, p.max), (1.5, 2.25));
        // One value: its rows sit in the middle bin.
        let p = one("float8", vec![Value::Float(0.5), Value::Float(0.5)]);
        assert_eq!(p.bins[BINS / 2], 2);
    }

    #[test]
    fn a_value_that_is_not_a_number_makes_it_categorical() {
        let p = one("numeric", vec![text("1"), text("NaN"), text("1")]);
        assert_eq!(p.kind, ProfileKind::Categorical);
        assert_eq!(p.top, [("1".into(), 2), ("NaN".into(), 1)]);
    }

    #[test]
    fn timestamps_read_from_text_in_epoch_ms() {
        let p = one(
            "timestamptz",
            vec![
                text("2026-01-01 10:00:00+00"),
                text("2026-03-01T10:00:00.5"),
                text("2026-02-01"),
            ],
        );
        assert_eq!(p.kind, ProfileKind::Temporal);
        assert_eq!(p.min, 1_767_261_600_000.0);
        // The max keeps its half second: a drag's high edge must cover that row.
        assert_eq!(p.max, 1_772_359_200_500.0);
        assert_eq!(time_ms("1970-01-01"), Some(0.0));
        assert_eq!(time_ms("1969-12-31 23:59:59"), Some(-1000.0));
        assert_eq!(time_ms("soon"), None);
        // Fractions keep their milliseconds (microseconds are cut).
        assert_eq!(time_ms("1970-01-01 00:00:01.5"), Some(1500.0));
        assert_eq!(time_ms("1970-01-01T00:00:01.123456+00"), Some(1123.0));
        assert_eq!(time_ms("1969-12-31 23:59:59.250"), Some(-750.0));
    }

    #[test]
    fn top_values_most_common_first_ties_as_first_seen() {
        let cells = ["b", "a", "a", "b", "c", "a"].map(text).into();
        let p = one("text", cells);
        assert_eq!(p.kind, ProfileKind::Categorical);
        assert_eq!(p.distinct, 3);
        assert_eq!(p.top, [("a".into(), 3), ("b".into(), 2), ("c".into(), 1)]);
        let cells = (0..20).map(|i| text(&format!("v{i}"))).collect();
        let p = one("text", cells);
        assert_eq!(p.distinct, 20);
        assert_eq!(p.top.len(), TOP_N);
        assert_eq!(p.top[0], ("v0".into(), 1));
    }

    #[test]
    fn distinct_tracking_stops_at_the_cap() {
        let at_cap = one("text", (0..256).map(|i| text(&i.to_string())).collect());
        assert_eq!(at_cap.distinct, 256);
        let past = one("text", (0..257).map(|i| text(&i.to_string())).collect());
        assert_eq!(past.distinct, UNIQUE);
        assert!(past.top.is_empty());
        // Repeats of tracked values never trip it.
        let repeats = one(
            "text",
            (0..4000).map(|i| text(&(i % 256).to_string())).collect(),
        );
        assert_eq!(repeats.distinct, 256);
        assert_eq!(repeats.top[0].1, 16);
    }

    #[test]
    fn booleans_bytea_all_null_and_untyped_columns() {
        let p = one(
            "bool",
            vec![Value::Bool(true), Value::Bool(false), Value::Bool(true)],
        );
        assert_eq!(p.kind, ProfileKind::Boolean);
        assert_eq!(p.top, [("true".into(), 2), ("false".into(), 1)]);
        assert_eq!(
            one("bytea", vec![Value::Bytes(vec![1])]).kind,
            ProfileKind::None
        );
        let p = one("text", vec![Value::Null, Value::Null]);
        assert_eq!((p.sample_rows, p.nulls, p.distinct), (2, 2, 0));
        // SQLite expressions: the first non-null value decides.
        let p = one("", vec![Value::Null, Value::Int(1), Value::Int(5)]);
        assert_eq!(p.kind, ProfileKind::Numeric);
        assert_eq!(one("", vec![Value::Bool(true)]).kind, ProfileKind::Boolean);
        assert_eq!(one("", vec![text("x")]).kind, ProfileKind::Categorical);
    }

    #[test]
    fn only_the_first_5000_rows_are_read() {
        let columns = [col("k", "text")];
        let mut p = Profiler::new(&columns);
        let a: Vec<Vec<Value>> = (0..3000).map(|_| vec![text("a")]).collect();
        let b: Vec<Vec<Value>> = (0..3000).map(|_| vec![text("b")]).collect();
        p.add_rows(&a);
        assert!(!p.is_full());
        p.add_rows(&b);
        assert!(p.is_full());
        assert_eq!(p.rows(), SAMPLE_ROWS);
        p.add_rows(&b);
        let out = p.finish().remove(0);
        assert_eq!(out.sample_rows, SAMPLE_ROWS as u32);
        assert_eq!(out.top, [("a".into(), 3000), ("b".into(), 2000)]);
    }

    #[test]
    fn the_wire_block_round_trips() {
        let columns = [col("n", "int4"), col("s", "text"), col("b", "bytea")];
        let rows = vec![
            vec![Value::Int(1), text("ünï"), Value::Bytes(vec![])],
            vec![Value::Null, text("x"), Value::Null],
        ];
        let profiles = profile_rows(&columns, &rows);
        let mut out = Vec::new();
        write(&mut out, &profiles);
        assert_eq!(read(&out).unwrap(), profiles);
    }
}
