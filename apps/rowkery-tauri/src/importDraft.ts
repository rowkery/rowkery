import type { CsvPreview, ImportSpec } from "./api";
import type { ColumnNode, Value } from "./types";

/**
 * CSV import (2026-10-21): the panel's model. Core reads and writes the
 * file (`rowkery_core::import`); this matches its columns to the table's,
 * builds what the import is asked for, and the grid's preview rows.
 */

export type OnConflict = "stop" | "skip" | "update";
export type EmptyCells = "null" | "text";

export interface ImportDraft {
  path: string;
  preview: CsvPreview;
  /** The first record names the columns (else it is data too). */
  header: boolean;
  /** Per CSV field: the table column it goes to, or null to skip it. */
  mapping: (string | null)[];
  onConflict: OnConflict;
  empty: EmptyCells;
}

/** `Order ID`, `order_id` and `orderid` match. */
export const normalName = (s: string) => s.trim().toLowerCase().replace(/[\s_-]+/g, "");

const words = (s: string) => s.trim().toLowerCase().split(/[\s_-]+/).filter(Boolean);

/** What the table is called, for `order_id` → `id` on `orders`. */
export interface MatchTable {
  name: string;
  key: string[];
}

/**
 * A near match, tried after exact names: the column's words end the field's
 * (`gift_note` → `note`; onto a key column only after the table's own name,
 * `order_id` → `id` on `orders`), or the column is the field plus `id`
 * (`customer` → `customer_id`).
 */
function nearMatch(field: string, column: string, table?: MatchTable): boolean {
  const f = words(field);
  const c = words(column);
  if (!f.length || !c.length) return false;
  if (f.length > c.length && c.every((w, i) => w === f[f.length - c.length + i])) {
    if (!table?.key.includes(column)) return true;
    const before = f.slice(0, f.length - c.length).join("");
    const name = normalName(table.name);
    return before === name || before === name.replace(/s$/, "");
  }
  return c.length === f.length + 1 && c[c.length - 1] === "id" && f.every((w, i) => w === c[i]);
}

/** The column each name matches, by name (case, `_` and spaces ignored), then near names; null where none does. */
export function matchColumns(names: string[], columns: string[], table?: MatchTable): (string | null)[] {
  const byName = new Map<string, string>();
  for (const c of columns) if (!byName.has(normalName(c))) byName.set(normalName(c), c);
  const used = new Set<string>();
  const out = names.map((n) => {
    const c = byName.get(normalName(n));
    if (!c || used.has(c)) return null;
    used.add(c);
    return c;
  });
  // Near names only where exactly one free column fits.
  return out.map((m, i) => {
    if (m) return m;
    const fits = columns.filter((c) => !used.has(c) && nearMatch(names[i], c, table));
    if (fits.length !== 1) return null;
    used.add(fits[0]);
    return fits[0];
  });
}

/** The first row reads as data when none of its cells names a column. */
export function looksLikeData(first: string[], columns: string[]): boolean {
  // Exact names only: a near match ("Main Street" → street) is too easy for a value.
  const names = new Set(columns.map(normalName));
  return !first.some((f) => names.has(normalName(f)));
}

/** A table the file could go into: how many of its fields match, and whether the file is named after it. */
export interface TableMatch {
  key: string;
  matched: number;
  /** The file's fields. */
  total: number;
  named: boolean;
}

/**
 * `orders-october.csv` is named after `orders` (or `order`): the table's
 * words run whole in the file's (`catalog.csv` isn't named after `log`).
 */
function namedAfter(fileName: string, table: string): boolean {
  const file = words(fileName.replace(/\.[^.]*$/, "").replace(/\./g, " "));
  const name = words(table);
  if (!name.length) return false;
  const singular = [...name.slice(0, -1), name[name.length - 1].replace(/s$/, "")];
  const runs = (w: string[]) => file.some((_, i) => w.every((x, j) => file[i + j] === x));
  return runs(name) || runs(singular);
}

/**
 * Import CSV… from anywhere: the tables best fit for the file first, by
 * fields matched, then the file being named after the table (the longer
 * name wins: `order_items` over `orders` for `order_items.csv`), then name.
 */
export function rankTables(
  first: string[],
  fileName: string,
  tables: { key: string; name: string; columns: string[]; primaryKey: string[] }[],
): TableMatch[] {
  return tables
    .map((t) => ({
      key: t.key,
      name: t.name,
      matched: looksLikeData(first, t.columns)
        ? 0
        : matchColumns(first, t.columns, { name: t.name, key: t.primaryKey }).filter(Boolean).length,
      total: first.length,
      named: namedAfter(fileName, t.name),
    }))
    .sort(
      (a, b) =>
        b.matched - a.matched ||
        Number(b.named) - Number(a.named) ||
        (a.named ? b.name.length - a.name.length : 0) ||
        a.name.localeCompare(b.name),
    )
    .map(({ name: _, ...m }) => m);
}

/**
 * The table Import CSV… picks by itself: the best fit, when the file is
 * named after it or it takes at least half the file's fields (two or more,
 * so a lone `id` isn't a fit).
 */
export const guessTable = (ranked: TableMatch[]) => {
  const top = ranked[0];
  if (!top) return undefined;
  const enough = Math.min(top.total, Math.max(2, Math.ceil(top.total / 2)));
  return top.named || (top.matched > 0 && top.matched >= enough) ? top : undefined;
};

/** Without a header, fields go to the table's columns in order. */
function byPosition(width: number, columns: string[]): (string | null)[] {
  return Array.from({ length: width }, (_, i) => columns[i] ?? null);
}

export function draftFor(path: string, preview: CsvPreview, columns: string[], table?: MatchTable): ImportDraft {
  const first = preview.rows[0] ?? [];
  const header = !looksLikeData(first, columns);
  return {
    path,
    preview,
    header,
    mapping: header ? matchColumns(first, columns, table) : byPosition(first.length, columns),
    onConflict: "stop",
    empty: "null",
  };
}

/** Header ↔ data: the mapping follows (names, or the table's order). */
export function withHeader(d: ImportDraft, header: boolean, columns: string[], table?: MatchTable): ImportDraft {
  const first = d.preview.rows[0] ?? [];
  return { ...d, header, mapping: header ? matchColumns(first, columns, table) : byPosition(first.length, columns) };
}

/** Field `i` goes to `column` (null: skip); a column taken by another field leaves it. */
export function remap(d: ImportDraft, i: number, column: string | null): ImportDraft {
  const mapping = d.mapping.map((m, j) => (j === i ? column : m === column ? null : m));
  return { ...d, mapping };
}

/** What each field is called in the panel: its header cell, else `Column 3`. */
export function fieldNames(d: ImportDraft): string[] {
  const first = d.preview.rows[0] ?? [];
  return first.map((name, i) => (d.header && name.trim() ? name : `Column ${i + 1}`));
}

/** Rows the import writes. */
export const importRows = (d: ImportDraft) => Math.max(0, d.preview.records - (d.header ? 1 : 0));

/** Rows the import tab shows (core reads one more, for a header). */
export const IMPORT_SAMPLE = 20;

/** The import tab's bar: `First 20 of 12,431 rows`. */
export function importSampleText(d: ImportDraft): string {
  const total = importRows(d);
  const shown = Math.min(total, IMPORT_SAMPLE, d.preview.rows.length - (d.header ? 1 : 0));
  const n = (x: number) => x.toLocaleString("en-US");
  return shown >= total ? `${n(total)} ${total === 1 ? "row" : "rows"}` : `First ${n(shown)} of ${n(total)} rows`;
}

export function importSpec(d: ImportDraft, schema: string, table: string): ImportSpec {
  return {
    path: d.path,
    schema,
    table,
    delimiter: d.preview.delimiter,
    header: d.header,
    columns: d.mapping.flatMap((column, field) => (column ? [{ field, column }] : [])),
    on_conflict: d.onConflict,
    empty: d.empty,
  };
}

const TEXT_TYPES = new Set(["text", "character varying", "varchar", "character", "char", "bpchar", "citext", "name"]);

/** Whether a column keeps `''` under Empty text (core's `takes_empty_text`). */
export function takesEmptyText(typeName: string, sqlite: boolean): boolean {
  const t = typeName.trim().toLowerCase();
  if (sqlite) return t === "" || t.includes("char") || t.includes("clob") || t.includes("text");
  return TEXT_TYPES.has(t.split("(")[0].trim());
}

/**
 * The grid's preview: the first rows as the table's columns get them.
 * `undefined` is DEFAULT (a column no field goes to, or an empty cell where
 * the column has a DEFAULT), `null` NULL; values show as the file has them.
 */
export function previewRows(
  d: ImportDraft,
  resultColumns: string[],
  columns: ColumnNode[],
  sqlite: boolean,
  limit = 20,
): (Value | null | undefined)[][] {
  const node = new Map(columns.map((c) => [c.name, c]));
  const field = new Map(d.mapping.flatMap((c, i) => (c ? [[c, i] as const] : [])));
  return d.preview.rows.slice(d.header ? 1 : 0, (d.header ? 1 : 0) + limit).map((row) =>
    resultColumns.map((name) => {
      const i = field.get(name);
      if (i === undefined) return undefined;
      const raw = row[i] ?? "";
      if (raw !== "") return { Text: raw };
      const col = node.get(name);
      if (d.empty === "text" && col && takesEmptyText(col.type_name, sqlite)) return { Text: "" };
      return col?.default ? undefined : null;
    }),
  );
}

/** `Imported 12,431 rows`, `Imported 12,000 rows · skipped 431`, `Added 3 · updated 9`. */
export function importedText(c: { inserted: number; updated: number; skipped: number }): string {
  const n = (x: number) => x.toLocaleString("en-US");
  const rows = (x: number) => `${n(x)} ${x === 1 ? "row" : "rows"}`;
  if (c.updated) return [`Added ${n(c.inserted)}`, `updated ${n(c.updated)}`, c.skipped ? `skipped ${n(c.skipped)}` : ""].filter(Boolean).join(" · ");
  return [`Imported ${rows(c.inserted)}`, c.skipped ? `skipped ${n(c.skipped)}` : ""].filter(Boolean).join(" · ");
}

/** A dropped file the import reads. */
export const isCsvPath = (p: string) => /\.(csv|tsv|tab)$/i.test(p);
