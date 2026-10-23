import { compareDecimal, decimalOf } from "./decimal";
import { ResultRows } from "./resultStore";
import type { QueryResultDto, Value } from "./types";

/** One sort key: a column and its direction. The first key is the primary sort. */
export interface SortKey {
  column: string;
  desc: boolean;
}

/** A saved sort: today's list, or the single key (or null) older tabs saved. */
export function sortKeys(raw: unknown): SortKey[] {
  const list = Array.isArray(raw) ? raw : raw ? [raw] : [];
  return list.filter(
    (k): k is SortKey => !!k && typeof k === "object" && typeof k.column === "string" && typeof k.desc === "boolean",
  );
}

/**
 * A header click: on the primary column it goes asc → desc → off; on any
 * other column it sorts by that column alone. ⇧-click (`secondary`) adds
 * the column as the next key, or cycles that key asc → desc → off, keeping
 * the others.
 */
export function cycleSort(keys: SortKey[], column: string, secondary = false): SortKey[] {
  if (!secondary || keys.length === 0) {
    const first = keys[0];
    if (!first || first.column !== column) return [{ column, desc: false }];
    return first.desc ? [] : [{ column, desc: true }];
  }
  const i = keys.findIndex((k) => k.column === column);
  if (i < 0) return [...keys, { column, desc: false }];
  const k = keys[i]!;
  if (!k.desc) return keys.map((x, j) => (j === i ? { column, desc: true } : x));
  return keys.filter((_, j) => j !== i);
}

/** Sets one column's direction (header menu), keeping the other keys; null removes it. */
export function setSortDirection(keys: SortKey[], column: string, desc: boolean | null): SortKey[] {
  if (desc === null) return keys.filter((k) => k.column !== column);
  if (keys.some((k) => k.column === column)) return keys.map((k) => (k.column === column ? { column, desc } : k));
  return [{ column, desc }];
}

/** The columns a table tab selects: the table's columns minus the hidden ones (empty means `*`). */
export function visibleColumns(all: readonly string[], hidden: readonly string[]): string[] {
  if (hidden.length === 0) return [];
  const gone = new Set(hidden);
  return all.filter((c) => !gone.has(c));
}

/**
 * Where hidden columns sit among the shown ones: `before` is the index of
 * the shown column they precede (`shown.length` at the end).
 */
export function hiddenGrips(all: readonly string[], hidden: readonly string[]): { before: number; names: string[] }[] {
  const gone = new Set(hidden);
  const out: { before: number; names: string[] }[] = [];
  let shown = 0;
  for (const c of all) {
    if (!gone.has(c)) {
      shown++;
      continue;
    }
    const last = out[out.length - 1];
    if (last && last.before === shown) last.names.push(c);
    else out.push({ before: shown, names: [c] });
  }
  return out;
}

const isNull = (v: Value) => !v || "Null" in v;

/** Text in the reader's locale order (case and accents still tell values apart). */
const COLLATOR = new Intl.Collator(undefined, { sensitivity: "variant" });

/**
 * A column whose values are numbers even when they arrive as text: Postgres
 * `numeric` / `decimal` come as their exact digits (`10.00`).
 */
export function isNumericType(typeName: string): boolean {
  return /^(numeric|decimal|real|double|float|int|integer|bigint|smallint|tinyint|mediumint|serial|bigserial)\d*(?![a-z_])/i.test(
    typeName.trim(),
  );
}

/**
 * Orders two cells the way the database would for one column: numbers by
 * value (BigInt digits exactly), booleans false first, text in locale order,
 * bytes by length. In a numeric column (`numeric`) text that is a number
 * orders by value, digit by digit (never through a float). NULLs are left
 * to `compareRows` (they sort last).
 */
export function compareValues(a: Value, b: Value, numeric = false): number {
  if (numeric && ("Text" in a || "Text" in b)) {
    const da = decimalOf(a);
    const db = decimalOf(b);
    if (da !== null && db !== null) return compareDecimal(da, db);
  }
  const num = (v: Value): number | bigint | null => {
    if ("Int" in v) return v.Int;
    if ("Float" in v) return v.Float;
    if ("BigInt" in v) return BigInt(v.BigInt);
    return null;
  };
  const x = num(a);
  const y = num(b);
  if (x !== null && y !== null) {
    if (typeof x === "number" && typeof y === "number") {
      // NaN after every number, as Postgres orders it.
      if (Number.isNaN(x) || Number.isNaN(y)) return Number.isNaN(x) ? (Number.isNaN(y) ? 0 : 1) : -1;
      return x < y ? -1 : x > y ? 1 : 0;
    }
    // A BigInt against a number: compare exactly when the number is an integer.
    const bx = typeof x === "bigint" ? x : Number.isInteger(x) ? BigInt(x) : null;
    const by = typeof y === "bigint" ? y : Number.isInteger(y) ? BigInt(y) : null;
    if (bx !== null && by !== null) return bx < by ? -1 : bx > by ? 1 : 0;
    const fx = Number(x);
    const fy = Number(y);
    return fx < fy ? -1 : fx > fy ? 1 : 0;
  }
  if ("Bool" in a && "Bool" in b) return Number(a.Bool) - Number(b.Bool);
  if ("Bytes" in a && "Bytes" in b) return (a.byteLength ?? a.Bytes.length) - (b.byteLength ?? b.Bytes.length);
  const ta = "Text" in a ? a.Text : JSON.stringify(a);
  const tb = "Text" in b ? b.Text : JSON.stringify(b);
  return COLLATOR.compare(ta, tb);
}

/** One key's comparison of two cells: NULLs last whichever way, like a table tab's pages. */
export function compareCells(a: Value, b: Value, desc: boolean, numeric = false): number {
  const an = isNull(a);
  const bn = isNull(b);
  if (an || bn) return an === bn ? 0 : an ? 1 : -1;
  const c = compareValues(a, b, numeric);
  return desc ? -c : c;
}

/**
 * The loaded rows' order under `keys` (column indexes): a permutation of
 * row numbers, stable, so equal rows keep the order they arrived in.
 */
export function sortedOrder(
  get: (row: number, col: number) => Value,
  rowCount: number,
  keys: { col: number; desc: boolean; numeric?: boolean }[],
): number[] {
  const order = Array.from({ length: rowCount }, (_, i) => i);
  if (keys.length === 0) return order;
  // Read each sorted column once.
  const cols = keys.map((k) => Array.from({ length: rowCount }, (_, r) => get(r, k.col)));
  order.sort((x, y) => {
    for (let i = 0; i < keys.length; i++) {
      const c = compareCells(cols[i]![x]!, cols[i]![y]!, keys[i]!.desc, keys[i]!.numeric);
      if (c !== 0) return c;
    }
    return x - y;
  });
  return order;
}

/** A query tab's result with its loaded rows sorted on the client (nothing reruns). */
export function sortResult(result: QueryResultDto, keys: SortKey[]): QueryResultDto {
  const idx = keys
    .map((k) => {
      const col = result.columns.findIndex((c) => c.name === k.column);
      // numeric's text compares by value: -3 < 9.50 < 10.00 < 100.
      return { col, desc: k.desc, numeric: col >= 0 && isNumericType(result.columns[col]!.type_name) };
    })
    .filter((k) => k.col >= 0);
  if (idx.length === 0) return result;
  const rows = result.rows;
  const order = sortedOrder((r, c) => rows.get(r, c), rows.length, idx);
  // A view over the same rows in the new order (no cell is copied); the
  // profiles carry over, since sorting doesn't change a column's shape.
  return { ...result, rows: ResultRows.ordered(rows, order) };
}
