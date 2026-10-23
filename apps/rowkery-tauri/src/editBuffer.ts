import type { EditTable, RowChange } from "./api";
import { decimalKey, decimalOf } from "./decimal";
import { valueText } from "./resultStore";
import type { ColumnNode, EnumNode, SafeMode, TableNode, Value } from "./types";

/**
 * A table tab's staged edits: nothing reaches the database until Commit.
 * Rows are named by their primary key's values, so the marks survive a new
 * sort, filter or page. Plain JSON: it is saved with the tab (config.json)
 * and travels with it to Recently closed.
 */
export interface EditBuffer {
  /** The table the edits belong to; a tab showing another table ignores them. */
  tableKey: string;
  /**
   * The connection they were staged on. Another server can have a table of
   * the same name: there they are parked (`bindEdits`), never shown or sent.
   */
  connectionId: string;
  /** New rows, newest first (shown at the top of the grid). */
  inserts: PendingInsert[];
  /** Edited rows by `rowKey`. */
  updates: Record<string, RowUpdate>;
  /** Rows marked for delete by `rowKey`. */
  deletes: Record<string, KeyCells>;
}

/** A row's primary key: each key column and its value. */
export type KeyCells = { column: string; value: Value }[];

export interface RowUpdate {
  key: KeyCells;
  /** The staged values. */
  set: Record<string, Value | null>;
  /** What each staged column held before (the tooltip, Esc reverts to it). */
  was: Record<string, Value | null>;
}

export interface PendingInsert {
  id: number;
  /** Staged values; a column left out is sent as DEFAULT. */
  values: Record<string, Value | null>;
}

export const emptyBuffer = (tableKey: string, connectionId: string): EditBuffer => ({
  tableKey,
  connectionId,
  inserts: [],
  updates: {},
  deletes: {},
});

/** One canonical spelling per value: `Int` and `BigInt` of the same number match. */
export function valueKey(v: Value | null | undefined): string {
  if (!v || "Null" in v) return "null";
  if ("Int" in v) return `n:${v.Int}`;
  if ("BigInt" in v) return `n:${v.BigInt}`;
  if ("Float" in v) return `f:${v.Float}`;
  if ("Bool" in v) return `b:${v.Bool}`;
  if ("Text" in v) return `t:${v.Text}`;
  return `x:${v.Bytes.join(",")}`;
}

/**
 * A boolean column's cell as a boolean: Postgres sends `Bool`, SQLite the
 * integers 1 and 0 (or text `t` / `f`). Null when it reads as neither.
 */
export function boolOf(v: Value | null | undefined): boolean | null {
  if (!v || "Null" in v) return null;
  if ("Bool" in v) return v.Bool;
  if ("Int" in v) return v.Int === 1 ? true : v.Int === 0 ? false : null;
  if ("BigInt" in v) return v.BigInt === "1" ? true : v.BigInt === "0" ? false : null;
  if ("Float" in v) return v.Float === 1 ? true : v.Float === 0 ? false : null;
  if ("Text" in v) {
    const t = v.Text.trim().toLowerCase();
    if (t === "t" || t === "true" || t === "1") return true;
    if (t === "f" || t === "false" || t === "0") return false;
  }
  return null;
}

/**
 * `valueKey` as a column of `kind` reads it: a bool column's `Int 1` is
 * `Bool true`; a number column's `Float 1.5`, `Text "1.50"` and `Int` agree
 * by value (digits compared exactly). Other kinds compare as stored.
 */
export function columnValueKey(v: Value | null | undefined, kind?: EditorKind): string {
  if (!v || "Null" in v) return "null";
  if (kind === "bool") {
    const b = boolOf(v);
    if (b !== null) return `b:${b}`;
  } else if (kind === "int" || kind === "number") {
    const d = decimalOf(v);
    if (d !== null) return `d:${decimalKey(d)}`;
  }
  return valueKey(v);
}

/** Two values are the same edit for a column of `kind` (see `columnValueKey`). */
export const sameValue = (a: Value | null | undefined, b: Value | null | undefined, kind?: EditorKind) =>
  columnValueKey(a, kind) === columnValueKey(b, kind);

export function rowKey(key: KeyCells): string {
  return JSON.stringify(key.map((k) => [k.column, valueKey(k.value)]));
}

export function changeCount(b: EditBuffer | null | undefined): number {
  if (!b) return 0;
  return b.inserts.length + Object.keys(b.updates).length + Object.keys(b.deletes).length;
}

/**
 * Stages `value` in a row's column; back to what it was (as a column of
 * `kind` compares it: a SQLite bool's 1 is true), the column is no longer edited.
 */
export function stageCell(
  b: EditBuffer,
  key: KeyCells,
  column: string,
  value: Value | null,
  was: Value | null,
  kind?: EditorKind,
): EditBuffer {
  const k = rowKey(key);
  const cur = b.updates[k];
  const original = cur && column in cur.was ? cur.was[column] : was;
  const set = { ...cur?.set };
  const before = { ...cur?.was };
  if (sameValue(value, original, kind)) {
    delete set[column];
    delete before[column];
  } else {
    set[column] = value;
    before[column] = original;
  }
  const updates = { ...b.updates };
  if (Object.keys(set).length) updates[k] = { key, set, was: before };
  else delete updates[k];
  return { ...b, updates };
}

/** Esc on an edited cell: its original value again. */
export function revertCell(b: EditBuffer, key: KeyCells, column: string): EditBuffer {
  const cur = b.updates[rowKey(key)];
  if (!cur || !(column in cur.set)) return b;
  return stageCell(b, key, column, cur.was[column], cur.was[column]);
}

/** ⌫ on whole rows: marks them for delete, or unmarks them when all were marked. */
export function toggleDeletes(b: EditBuffer, keys: KeyCells[]): EditBuffer {
  const deletes = { ...b.deletes };
  const all = keys.every((k) => rowKey(k) in deletes);
  for (const key of keys) {
    if (all) delete deletes[rowKey(key)];
    else deletes[rowKey(key)] = key;
  }
  return { ...b, deletes };
}

export function addInserts(b: EditBuffer, rows: PendingInsert[]): EditBuffer {
  return { ...b, inserts: [...rows, ...b.inserts] };
}

/** Stages a new row's cell; `undefined` puts it back to DEFAULT. */
export function setInsertCell(b: EditBuffer, id: number, column: string, value: Value | null | undefined): EditBuffer {
  return {
    ...b,
    inserts: b.inserts.map((row) => {
      if (row.id !== id) return row;
      const values = { ...row.values };
      if (value === undefined) delete values[column];
      else values[column] = value;
      return { ...row, values };
    }),
  };
}

export function removeInsert(b: EditBuffer, id: number): EditBuffer {
  return { ...b, inserts: b.inserts.filter((r) => r.id !== id) };
}

const cells = (values: Record<string, Value | null>) =>
  Object.entries(values).map(([column, value]) => ({ column, value: value ?? null }));

/**
 * What core builds the statements from: inserts in the order they were
 * made, then updates, then deletes. A row marked for delete drops its edits.
 */
export function bufferChanges(b: EditBuffer): RowChange[] {
  const out: RowChange[] = [];
  for (const row of [...b.inserts].reverse()) out.push({ op: "insert", values: cells(row.values) });
  for (const [k, u] of Object.entries(b.updates)) {
    if (!(k in b.deletes)) out.push({ op: "update", key: u.key, set: cells(u.set) });
  }
  for (const key of Object.values(b.deletes)) out.push({ op: "delete", key });
  return out;
}

/**
 * What is left of `current` once `sent` committed: edits staged while the
 * commit ran stay, measured from the values it wrote; the rows it deleted
 * and inserted, and the cells it wrote unchanged since, are gone.
 */
export function withoutCommitted(current: EditBuffer | undefined, sent: EditBuffer): EditBuffer | undefined {
  if (!current || current.tableKey !== sent.tableKey || current.connectionId !== sent.connectionId) return current;
  const sentIds = new Set(sent.inserts.map((r) => r.id));
  const updates: Record<string, RowUpdate> = {};
  for (const [k, u] of Object.entries(current.updates)) {
    if (k in sent.deletes) continue;
    const wrote = k in sent.updates ? sent.updates[k].set : {};
    const set: Record<string, Value | null> = {};
    const was: Record<string, Value | null> = {};
    for (const [column, value] of Object.entries(u.set)) {
      const committed = column in wrote;
      if (committed && sameValue(value, wrote[column])) continue;
      set[column] = value;
      was[column] = committed ? wrote[column] : u.was[column];
    }
    if (Object.keys(set).length) updates[k] = { key: u.key, set, was };
  }
  const deletes: Record<string, KeyCells> = {};
  for (const [k, d] of Object.entries(current.deletes)) if (!(k in sent.deletes)) deletes[k] = d;
  const left: EditBuffer = { ...current, inserts: current.inserts.filter((r) => !sentIds.has(r.id)), updates, deletes };
  return changeCount(left) ? left : undefined;
}

const isRecord = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);

const isKey = (v: unknown): v is KeyCells =>
  Array.isArray(v) && v.length > 0 && v.every((c) => isRecord(c) && typeof c.column === "string" && isRecord(c.value));

/**
 * A buffer read back from config.json, or undefined when it doesn't hold
 * together. One saved before buffers named their connection is dropped
 * (`legacyEditCount` counts it for the toast): the window's saved connection
 * is exactly what the old bug got wrong, so nothing says where it belongs.
 */
export function savedBuffer(raw: unknown): EditBuffer | undefined {
  if (!isRecord(raw) || typeof raw.connectionId !== "string" || !raw.connectionId) return undefined;
  return parseBuffer(raw, raw.connectionId);
}

/** How many edits a saved buffer with no connection held (dropped on restore); 0 for any other. */
export function legacyEditCount(raw: unknown): number {
  if (!isRecord(raw) || typeof raw.connectionId === "string") return 0;
  return changeCount(parseBuffer(raw, ""));
}

function parseBuffer(raw: Record<string, unknown>, connectionId: string): EditBuffer | undefined {
  if (typeof raw.tableKey !== "string") return undefined;
  if (!Array.isArray(raw.inserts) || !isRecord(raw.updates) || !isRecord(raw.deletes)) return undefined;
  const inserts = raw.inserts.filter(
    (r): r is PendingInsert => isRecord(r) && typeof r.id === "number" && isRecord(r.values),
  );
  const updates: Record<string, RowUpdate> = {};
  for (const u of Object.values(raw.updates)) {
    if (isRecord(u) && isKey(u.key) && isRecord(u.set) && isRecord(u.was)) {
      updates[rowKey(u.key)] = u as unknown as RowUpdate;
    }
  }
  const deletes: Record<string, KeyCells> = {};
  for (const d of Object.values(raw.deletes)) if (isKey(d)) deletes[rowKey(d)] = d;
  const b: EditBuffer = { tableKey: raw.tableKey, connectionId, inserts, updates, deletes };
  return changeCount(b) ? b : undefined;
}

/** A tab's parked buffers as saved, by the connection each was staged on. */
export function savedParked(raw: unknown): Record<string, EditBuffer> | undefined {
  if (!isRecord(raw)) return undefined;
  const out: Record<string, EditBuffer> = {};
  for (const [id, v] of Object.entries(raw)) {
    const b = savedBuffer(v);
    if (b && b.connectionId === id) out[id] = b;
  }
  return Object.keys(out).length ? out : undefined;
}

/** A tab's staged edits: the shown buffer and the ones parked on other connections. */
export interface TabEdits {
  edits?: EditBuffer;
  parked?: Record<string, EditBuffer>;
}

/**
 * A tab's edits for the connection its window is on now: a buffer staged on
 * another connection is parked (kept, never shown or committed here), and
 * the one parked for this connection comes back. `same` when nothing moved.
 */
export function bindEdits(
  tab: TabEdits,
  connectionId: string,
): TabEdits & { same: boolean; parkedNow?: EditBuffer; restored?: EditBuffer } {
  let { edits, parked } = tab;
  let parkedNow: EditBuffer | undefined;
  let restored: EditBuffer | undefined;
  if (edits && edits.connectionId !== connectionId) {
    parkedNow = edits;
    parked = { ...parked, [edits.connectionId]: edits };
    edits = undefined;
  }
  if (!edits && parked?.[connectionId]) {
    const { [connectionId]: back, ...rest } = parked;
    restored = back;
    edits = back;
    parked = rest;
  }
  if (parked && !Object.keys(parked).length) parked = undefined;
  return { edits, parked, same: !parkedNow && !restored, parkedNow, restored };
}

/** Edits a tab holds that aren't shown here: parked on other connections. */
export function parkedCount(tab: TabEdits): number {
  let n = 0;
  for (const b of Object.values(tab.parked ?? {})) n += changeCount(b);
  return n;
}

/**
 * A tab's edits once `sent` committed, wherever the rest of them now are:
 * its shown buffer, or the one parked for the connection `sent` went to,
 * so that switching back never brings what already committed (`withoutCommitted`).
 */
export function withoutCommittedTab(tab: TabEdits, sent: EditBuffer): TabEdits {
  const edits = withoutCommitted(tab.edits, sent);
  let parked = tab.parked;
  const there = parked?.[sent.connectionId];
  if (parked && there) {
    const left = withoutCommitted(there, sent);
    const { [sent.connectionId]: _done, ...rest } = parked;
    parked = left ? { ...rest, [sent.connectionId]: left } : rest;
    if (!Object.keys(parked).length) parked = undefined;
  }
  return { edits, parked };
}

/**
 * Parked buffers whose connection is gone (deleted): no switch ever brings
 * them back, so they go. `live` is every saved connection's id.
 */
export function pruneParked(
  parked: Record<string, EditBuffer> | undefined,
  live: ReadonlySet<string>,
): Record<string, EditBuffer> | undefined {
  if (!parked) return parked;
  const ids = Object.keys(parked);
  if (ids.every((id) => live.has(id))) return parked;
  const kept = Object.fromEntries(ids.filter((id) => live.has(id)).map((id) => [id, parked[id]]));
  return Object.keys(kept).length ? kept : undefined;
}

/** More staged deletes than this, and ⌘S shows Review SQL before it commits (safe mode or not). */
export const REVIEW_DELETES_OVER = 50;

/**
 * ⌘S goes through Review SQL instead of committing at once: many deletes,
 * or every loaded row marked for delete (⌘A then ⌫), whatever safe mode says.
 */
export function commitNeedsReview(b: EditBuffer | null | undefined, loadedRows: number, loadedDeleted: number): boolean {
  if (!b) return false;
  const deletes = Object.keys(b.deletes).length;
  return deletes > REVIEW_DELETES_OVER || (loadedRows > 1 && loadedDeleted >= loadedRows);
}

/** How soon after a run ends an Esc still counts as meant for that run. */
export const ESC_AFTER_RUN_MS = 500;

/**
 * Esc discards staged edits only when no query is running and none just
 * ended: an Esc pressed to cancel a query that finished first keeps them.
 */
export function escMayDiscard(running: boolean, lastRunEndedAt: number | null, now: number): boolean {
  return !running && (lastRunEndedAt === null || now - lastRunEndedAt >= ESC_AFTER_RUN_MS);
}

/**
 * Why a table tab's rows can't be edited, or null when they can: the tray
 * says it when ↵ is pressed, and no editor opens.
 */
export function editRefusal(
  table: TableNode | undefined,
  safeMode: SafeMode,
  shownColumns: string[],
): string | null {
  if (safeMode === "read_only") return "Read-only connection · Change safe mode…";
  if (!table) return "This table isn't in the schema yet";
  if (table.kind && table.kind !== "table") return "Views can't be edited";
  const pk = table.primary_key ?? [];
  if (!pk.length) return "No primary key · rows here can't be edited";
  const missing = pk.filter((c) => !shownColumns.includes(c));
  if (missing.length) return `Show ${missing.join(", ")} to edit rows`;
  return null;
}

/** The table as core's `build_row_changes` reads it. */
export function editTableOf(schema: string, table: TableNode): EditTable {
  return {
    schema,
    table: table.name,
    columns: (table.columns ?? []).map((c) => ({ name: c.name, type_name: c.type_name })),
    key: table.primary_key ?? [],
  };
}

/** Which editor a column gets; null for columns edited elsewhere (bytes). */
export type EditorKind = "text" | "int" | "number" | "bool" | "enum" | "date" | "json";

export interface ColumnEditor {
  kind: EditorKind;
  nullable: boolean;
  /** Catalog default: an inserted row shows it dim and sends DEFAULT. */
  default: string | null;
  /** Enum labels, from the catalog. */
  labels?: string[];
  /** Dim format hint for dates and times. */
  placeholder?: string;
  /** A single-column foreign key: the picker searches this table. */
  fk?: { schema: string; table: string; column: string };
}

const unqualify = (name: string) => name.replace(/^.*\./, "").replace(/^"|"$/g, "");

/** A catalog column's editor (Postgres `format_type` names, SQLite declared types). */
export function columnEditor(column: ColumnNode, engine: "postgres" | "sqlite", enums: EnumNode[]): ColumnEditor | null {
  const t = column.type_name.trim().toLowerCase();
  const base = { nullable: column.nullable, default: column.default ?? null };
  if (engine === "sqlite") {
    if (/blob/.test(t)) return null;
    if (/int/.test(t)) return { kind: "int", ...base };
    if (/real|floa|doub|numeric|decimal/.test(t)) return { kind: "number", ...base };
    if (/bool/.test(t)) return { kind: "bool", ...base };
    if (/date|time/.test(t)) return { kind: "date", placeholder: "YYYY-MM-DD HH:MM:SS", ...base };
    if (/json/.test(t)) return { kind: "json", ...base };
    return { kind: "text", ...base };
  }
  if (t.endsWith("[]")) return { kind: "text", ...base };
  const name = t.split("(")[0].trim();
  if (name === "bytea") return null;
  if (name === "boolean" || name === "bool") return { kind: "bool", ...base };
  if (/^(smallint|integer|bigint|int[248]?|oid)$/.test(name)) return { kind: "int", ...base };
  if (/^(real|double precision|numeric|decimal|float[48]?)$/.test(name)) return { kind: "number", ...base };
  if (/^jsonb?$/.test(name)) return { kind: "json", ...base };
  if (/^(date|time|timestamp|interval)/.test(name)) {
    const placeholder =
      name === "date" ? "YYYY-MM-DD · now()" : name.startsWith("time ") || name === "time" ? "HH:MM:SS" : name === "interval" ? "1 day" : "YYYY-MM-DD HH:MM:SS · now()";
    return { kind: "date", placeholder, ...base };
  }
  const en = enums.find((e) => e.name === unqualify(column.type_name));
  if (en) return { kind: "enum", labels: en.labels, ...base };
  return { kind: "text", ...base };
}

const INTEGER = /^[+-]?\d+$/;
const NUMBER = /^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/;

/** What an editor's text stages as, or why it can't. */
export function parseInput(kind: EditorKind, text: string): { value: Value } | { error: string } {
  const t = text.trim();
  switch (kind) {
    case "int": {
      if (!INTEGER.test(t)) return { error: "Whole numbers only" };
      const n = Number(t);
      return { value: Number.isSafeInteger(n) ? { Int: n } : { BigInt: t.replace(/^\+/, "") } };
    }
    case "number":
      // Text keeps numeric's digits exact; core checks it and writes it bare.
      if (!NUMBER.test(t) && !/^[+-]?(nan|infinity)$/i.test(t)) return { error: "Numbers only" };
      return { value: { Text: t } };
    case "bool":
      if (/^(true|t|yes|1)$/i.test(t)) return { value: { Bool: true } };
      if (/^(false|f|no|0)$/i.test(t)) return { value: { Bool: false } };
      return { error: "true or false" };
    case "date":
      // `now()` is how people type it; Postgres reads the word.
      return { value: { Text: /^now(\(\))?$/i.test(t) ? "now" : text } };
    case "json":
      try {
        JSON.parse(text);
      } catch {
        return { error: "Not valid JSON" };
      }
      return { value: { Text: text } };
    default:
      return { value: { Text: text } };
  }
}

/** The number literals of a JSON text, in order, as written (strings skipped). */
function jsonNumbers(text: string): string[] {
  const out: string[] = [];
  const num = /-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?/y;
  for (let i = 0; i < text.length; ) {
    const ch = text[i];
    if (ch === '"') {
      i++;
      while (i < text.length && text[i] !== '"') i += text[i] === "\\" ? 2 : 1;
      i++;
    } else if (ch === "-" || (ch >= "0" && ch <= "9")) {
      num.lastIndex = i;
      const m = num.exec(text);
      if (!m) return [];
      out.push(m[0]);
      i += m[0].length;
    } else i++;
  }
  return out;
}

/**
 * The JSON editor's first text: the value pretty-printed when that loses
 * nothing, else exactly as stored. `JSON.parse` rounds numbers past 2^53
 * and reads `1.0` as `1`; a jsonb holding them opens as its own text.
 */
export function jsonEditorText(raw: string): string {
  let pretty: string;
  try {
    pretty = JSON.stringify(JSON.parse(raw), null, 2);
  } catch {
    return raw;
  }
  const a = jsonNumbers(raw);
  const b = jsonNumbers(pretty);
  return a.length === b.length && a.every((n, i) => n === b[i]) ? pretty : raw;
}

/** What a cell's editor starts with: NULL (and a new row's DEFAULT) is empty. */
export function editorStartText(kind: EditorKind, initial: Value | null): string {
  if (!initial || "Null" in initial) return "";
  const raw = valueText(initial);
  return kind === "json" ? jsonEditorText(raw) : raw;
}

/**
 * Rows of fields split on `sep`. A field is quoted only when it opens with a quote, closes at a
 * field or line boundary and needed the quotes (a `sep`, line break or `""` inside); anything
 * else, like Excel's `"Best" seller` or a lone `"hello"`, is taken as it is.
 */
function splitQuoted(text: string, sep: string): { rows: string[][]; quoted: boolean } {
  const rows: string[][] = [];
  let row: string[] = [];
  let quoted = false;
  let i = 0;
  const boundary = (at: number) => at >= text.length || text[at] === sep || text[at] === "\n";
  for (;;) {
    let field: string | null = null;
    if (text[i] === '"') {
      let j = i + 1;
      let inner = "";
      let escaped = false;
      for (;;) {
        const q = text.indexOf('"', j);
        if (q < 0) break;
        inner += text.slice(j, q);
        if (text[q + 1] === '"') {
          inner += '"';
          escaped = true;
          j = q + 2;
          continue;
        }
        if (boundary(q + 1) && (escaped || inner.includes(sep) || inner.includes("\n"))) {
          field = inner;
          i = q + 1;
          quoted = true;
        }
        break;
      }
    }
    if (field === null) {
      let end = i;
      while (!boundary(end)) end++;
      field = text.slice(i, end);
      i = end;
    }
    row.push(field);
    if (i >= text.length) break;
    if (text[i] === "\n") {
      rows.push(row);
      row = [];
    }
    i++;
  }
  rows.push(row);
  return { rows, quoted };
}

/**
 * A pasted block: TSV, which with no tabs is one value per line. Only text with no tabs, several
 * lines, a quoted field and the same two or more fields on every line is read as CSV.
 */
export function parsePaste(text: string): string[][] {
  const t = text.replace(/\r\n?/g, "\n").replace(/\n$/, "");
  if (!t.includes("\t") && t.includes("\n") && t.includes('"') && t.includes(",")) {
    const csv = splitQuoted(t, ",");
    const n = csv.rows[0].length;
    if (csv.quoted && csv.rows.length > 1 && n > 1 && csv.rows.every((r) => r.length === n)) return csv.rows;
  }
  return splitQuoted(t, "\t").rows;
}
