import type { ResultRows } from "./resultStore";
import type { Column } from "./types";

/**
 * The shape of one column in a result's first rows, drawn under its header:
 * a histogram for numbers and times, a split bar for a few repeated values
 * (text, booleans), or a count when nearly every value is different.
 *
 * rowkery-core computes the numbers once, over the first 5,000 rows, and sends
 * them in the rows frame that completes that sample (`profile.rs`, decoded
 * into `ResultRows.profiles`); this file only turns them into what the header
 * draws. Results built in the webview (All tables, test stubs' JSON rows) get
 * the same numbers from `summarizeRows`, once, when they are complete.
 */
export type ColumnProfile =
  | {
      kind: "hist";
      bars: number[];
      nullShare: number;
      /** Each bar's lowest and highest value (a drag across bars filters BETWEEN them). */
      ranges: [number, number][];
      time: boolean;
    }
  | { kind: "split"; segs: ProfileSeg[]; top: string; topShare: number; nullShare: number }
  /** `distinct` is null past the 256 values core tracks: just "unique". */
  | { kind: "unique"; distinct: number | null; nullShare: number }
  | { kind: "null" };

export interface ProfileSeg {
  share: number;
  /** Bool columns colour `true` green; everything else is a grey by rank. */
  tone: "true" | "rank" | "null";
  /** The value it stands for (clicking it filters on it); null for NULL, absent for the rest folded together. */
  value?: string | null;
}

/** rowkery-core `profile::ProfileKind`. */
export const enum ProfileKind {
  None = 0,
  Numeric = 1,
  Categorical = 2,
  Boolean = 3,
  Temporal = 4,
}

/** One column's numbers as rowkery-core sends them (`profile.rs` has the wire layout). */
export interface WireProfile {
  kind: ProfileKind;
  sampleRows: number;
  nulls: number;
  /** Distinct non-null values, or `UNIQUE` past the cap. */
  distinct: number;
  /** Numeric and temporal (epoch ms): the sample's range, split into `bins`. */
  min: number;
  max: number;
  bins: number[];
  /** One bin per whole number from `min`. */
  wholeBins: boolean;
  /** Most common values first, at most 8. */
  top: [string, number][];
}

export const UNIQUE = 0xffffffff;
/** Profiles read the first rows only, so a Load more of 100k rows stays instant. */
export const SAMPLE_ROWS = 5000;
const DISTINCT_CAP = 256;
const BINS = 14;
const TOP_N = 8;
/** A split bar shows at most this many values; the rest fold into the last segment. */
const MAX_SEGS = 3;

const NUMERIC_TYPE =
  /^(int|integer|bigint|smallint|tinyint|mediumint|real|double|float|numeric|decimal|money|serial|bigserial)/i;
const TIME_TYPE = /^(timestamp|date)/i;
/** Milliseconds count (`.123`, cut from microseconds): the histogram's edges must hold every row. */
const TIME_TEXT = /^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,3})\d*)?)?/;

/** What the header draws for one column; null for none (bytea, no rows). */
export function toColumnProfile(w: WireProfile | undefined): ColumnProfile | null {
  if (!w || w.kind === ProfileKind.None || w.sampleRows === 0) return null;
  const n = w.sampleRows;
  const nonNull = n - w.nulls;
  if (nonNull === 0) return { kind: "null" };
  const nullShare = w.nulls / n;
  if (w.kind === ProfileKind.Numeric || w.kind === ProfileKind.Temporal) {
    const span = w.max - w.min;
    const counts = w.wholeBins ? w.bins.slice(0, span + 1) : w.bins;
    const peak = Math.max(...counts);
    return {
      kind: "hist",
      ranges: counts.map((_, b) =>
        w.wholeBins ? [w.min + b, w.min + b] : [w.min + (b * span) / BINS, w.min + ((b + 1) * span) / BINS],
      ),
      time: w.kind === ProfileKind.Temporal,
      // A bin with any rows stays visible as a sliver.
      bars: counts.map((c) => (c === 0 ? 0 : Math.max(0.08, c / peak))),
      nullShare,
    };
  }
  const bool = w.kind === ProfileKind.Boolean;
  const capped = w.distinct === UNIQUE;
  // Mostly distinct values (ids, emails, uuids) have no useful split.
  if (!bool && (capped || w.distinct > 12 || (w.distinct > 3 && w.distinct >= nonNull * 0.6))) {
    return { kind: "unique", distinct: capped ? null : w.distinct, nullShare };
  }
  const shown = w.top.slice(0, MAX_SEGS);
  const segs: ProfileSeg[] = shown.map(([value, c]) => ({
    share: c / n,
    tone: bool && value === "true" ? "true" : "rank",
    value,
  }));
  const rest = nonNull - shown.reduce((s, [, c]) => s + c, 0);
  if (rest > 0) segs.push({ share: rest / n, tone: "rank" });
  if (w.nulls > 0) segs.push({ share: nullShare, tone: "null", value: null });
  const [top, topCount] = bool ? (w.top.find(([v]) => v === "true") ?? ["true", 0]) : w.top[0];
  return { kind: "split", segs, top, topShare: topCount / n, nullShare };
}

/** The header profiles of a result: what core sent (or `summarizeRows` made). Nothing is scanned here. */
export function columnProfiles(columns: Column[], rows: ResultRows): (ColumnProfile | null)[] {
  const wire = rows.profiles;
  return columns.map((_, i) => toColumnProfile(wire?.[i]));
}

/** "of first 5,000" when the profiles read fewer rows than are loaded. */
export function profileSample(rows: ResultRows): string {
  const n = rows.profiles?.[0]?.sampleRows ?? 0;
  return n > 0 && rows.length > n ? `of first ${n.toLocaleString()}` : "";
}

function cellNumber(rows: ResultRows, r: number, c: number, time: boolean): number | undefined {
  const v = rows.get(r, c);
  if ("Int" in v || "BigInt" in v || "Float" in v) {
    // A BigInt rounds to the nearest double: fine for a histogram.
    const n = Number("Int" in v ? v.Int : "BigInt" in v ? v.BigInt : v.Float);
    return Number.isFinite(n) ? n : undefined;
  }
  if (!("Text" in v)) return undefined;
  if (time) {
    const m = TIME_TEXT.exec(v.Text);
    return m
      ? Date.UTC(+m[1], +m[2] - 1, +m[3], +(m[4] ?? 0), +(m[5] ?? 0), +(m[6] ?? 0), +(m[7] ?? "0").padEnd(3, "0"))
      : undefined;
  }
  const n = Number(v.Text);
  return v.Text.trim() !== "" && Number.isFinite(n) ? n : undefined;
}

function declaredKind(type: string): ProfileKind | null {
  if (/^(bytea|blob)$/.test(type)) return ProfileKind.None;
  if (TIME_TYPE.test(type)) return ProfileKind.Temporal;
  if (NUMERIC_TYPE.test(type)) return ProfileKind.Numeric;
  if (type.startsWith("bool")) return ProfileKind.Boolean;
  // Untyped (SQLite expressions): the first non-null value decides.
  return type ? ProfileKind.Categorical : null;
}

/**
 * The numbers rowkery-core's `profile.rs` computes, for rows that never came
 * from it (All tables, JSON rows): the same rules, over the first 5,000 rows,
 * once. `frames.test.ts` checks the two agree on the golden rows.
 */
export function summarizeRows(columns: Column[], rows: ResultRows): WireProfile[] {
  const n = Math.min(rows.length, SAMPLE_ROWS);
  return columns.map((col, c) => {
    let kind = declaredKind(col.type_name.toLowerCase());
    const w: WireProfile = {
      kind: ProfileKind.Categorical,
      sampleRows: n,
      nulls: 0,
      distinct: 0,
      min: 0,
      max: 0,
      bins: new Array<number>(BINS).fill(0),
      wholeBins: false,
      top: [],
    };
    let numbers: number[] | null =
      kind === null || kind === ProfileKind.Numeric || kind === ProfileKind.Temporal ? [] : null;
    let counts: Map<string, number> | null = new Map();
    for (let r = 0; r < n; r++) {
      if (rows.isNull(r, c)) {
        w.nulls++;
        continue;
      }
      if (kind === null) {
        kind = rows.isNumber(r, c) ? ProfileKind.Numeric : rows.isBool(r, c) ? ProfileKind.Boolean : ProfileKind.Categorical;
        if (kind !== ProfileKind.Numeric) numbers = null;
      }
      if (kind === ProfileKind.None) continue;
      if (numbers) {
        const x = cellNumber(rows, r, c, kind === ProfileKind.Temporal);
        if (x === undefined) numbers = null;
        else numbers.push(x);
      }
      if (!counts) continue;
      const key = rows.text(r, c);
      const seen = counts.get(key);
      if (seen !== undefined) counts.set(key, seen + 1);
      else if (counts.size === DISTINCT_CAP) counts = null;
      else counts.set(key, 1);
    }
    w.kind = kind ?? ProfileKind.Categorical;
    if (w.kind === ProfileKind.None) return w;
    w.distinct = counts ? counts.size : UNIQUE;
    const ranged = w.kind === ProfileKind.Numeric || w.kind === ProfileKind.Temporal;
    if (numbers && ranged) {
      if (numbers.length === 0) return w;
      let min = Infinity;
      let max = -Infinity;
      for (const x of numbers) {
        if (x < min) min = x;
        if (x > max) max = x;
      }
      const span = max - min;
      w.min = min;
      w.max = max;
      w.wholeBins = span < BINS && numbers.every(Number.isInteger);
      for (const x of numbers) {
        const b = w.wholeBins
          ? x - min
          : span === 0
            ? BINS >> 1
            : Math.min(BINS - 1, Math.floor(((x - min) / span) * BINS));
        w.bins[b]++;
      }
      return w;
    }
    // A numeric type with a value that isn't a number reads as text.
    if (ranged) w.kind = ProfileKind.Categorical;
    // Stable: equal counts keep the order first seen.
    w.top = counts ? [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, TOP_N) : [];
    return w;
  });
}

/** One short line under the bar: `settled 58%`, `100 unique`, `55% null`. */
export function profileCaption(p: ColumnProfile): string {
  const pct = (x: number) => `${Math.round(x * 100)}%`;
  switch (p.kind) {
    case "null":
      return "all null";
    case "unique":
      return `${p.distinct === null ? "" : `${p.distinct.toLocaleString()} `}unique${
        p.nullShare >= 0.01 ? ` · ${pct(p.nullShare)} null` : ""
      }`;
    case "split":
      return `${p.top} ${pct(p.topShare)}`;
    case "hist":
      return p.nullShare >= 0.01 ? `${pct(p.nullShare)} null` : "";
  }
}

/** Significant digits a bin edge keeps: enough to tell bins apart, short enough to read. */
const EDGE_DIGITS = 6;

/**
 * A histogram bin edge as a filter value: plain digits (no separators),
 * times as `YYYY-MM-DD HH:MM:SS`. A drag filters BETWEEN its low and high
 * edges, so rounding never moves an edge inward past a row: the low edge
 * rounds down and the high edge up, and a high time edge covers its whole
 * second (`.999999`, as fine as Postgres keeps time).
 */
export function binEdge(x: number, time: boolean, side: "low" | "high" = "low"): string {
  if (time) {
    const whole = Math.floor(x / 1000) * 1000;
    const text = new Date(whole).toISOString().replace("T", " ").replace(/\.\d+Z$/, "");
    if (side === "low") return text.replace(/ 00:00:00$/, "");
    // A day's midnight is a date (a date column's value); any other time takes its whole second.
    return x === whole && text.endsWith(" 00:00:00") ? text.slice(0, 10) : `${text}.999999`;
  }
  if (Number.isSafeInteger(x)) return String(x);
  return roundedEdge(x, side);
}

/** `x` at `EDGE_DIGITS` significant digits, rounded down (`low`) or up (`high`), as plain digits. */
function roundedEdge(x: number, side: "low" | "high"): string {
  if (!Number.isFinite(x) || x === 0) return String(x);
  const exp = Math.floor(Math.log10(Math.abs(x)));
  const scale = 10 ** (EDGE_DIGITS - 1 - exp);
  let y = (side === "low" ? Math.floor(x * scale) : Math.ceil(x * scale)) / scale;
  y = Number(y.toPrecision(EDGE_DIGITS));
  // Float noise (x * scale) can land a hair on the wrong side: one more step out.
  const step = 10 ** (exp - EDGE_DIGITS + 1);
  if (side === "low" && y > x) y = Number((y - step).toPrecision(EDGE_DIGITS));
  if (side === "high" && y < x) y = Number((y + step).toPrecision(EDGE_DIGITS));
  return plainDigits(y);
}

/** A number without exponent notation (`1e+21` → `1000000000000000000000`, `1e-7` → `0.0000001`). */
function plainDigits(y: number): string {
  const s = String(y);
  const m = /^(-?)(\d+)(?:\.(\d+))?e([+-]\d+)$/.exec(s);
  if (!m) return s;
  const digits = m[2] + (m[3] ?? "");
  const point = m[2].length + Number(m[4]);
  if (point <= 0) return `${m[1]}0.${"0".repeat(-point)}${digits}`;
  if (point >= digits.length) return m[1] + digits + "0".repeat(point - digits.length);
  return `${m[1]}${digits.slice(0, point)}.${digits.slice(point)}`;
}
