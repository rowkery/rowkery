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

export const emptyBuffer = (tableKey: string): EditBuffer => ({ tableKey, inserts: [], updates: {}, deletes: {} });

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
  if (!current || current.tableKey !== sent.tableKey) return current;
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

/** A buffer read back from config.json, or undefined when it doesn't hold together. */
export function savedBuffer(raw: unknown): EditBuffer | undefined {
  if (!isRecord(raw) || typeof raw.tableKey !== "string") return undefined;
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
  const b: EditBuffer = { tableKey: raw.tableKey, inserts, updates, deletes };
  return changeCount(b) ? b : undefined;
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

/** Binary cells are never pasted from a typed round trip (frames carry a prefix only). */
export const gridCopyBytes = Symbol("gridCopyBytes");
export type GridCopyCell = Value | null | typeof gridCopyBytes;

export function stripTrailingLineBreak(text: string): string {
  if (text.endsWith("\r\n")) return text.slice(0, -2);
  if (text.endsWith("\n") || text.endsWith("\r")) return text.slice(0, -1);
  return text;
}

function appendQuotedChar(field: string, ch: string, next: string | undefined): { field: string; i: number } {
  if (ch === "\r") {
    if (next === "\n") return { field: field + "\n", i: 2 };
    return { field: field + "\n", i: 1 };
  }
  return { field: field + ch, i: 1 };
}

function endRow(rows: string[][], row: string[], field: string): { row: string[]; field: string } {
  row.push(field);
  rows.push(row);
  return { row: [], field: "" };
}

function parseDelimitedPlain(text: string, sep: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let i = 0;
  while (i < text.length) {
    const ch = text[i];
    if (ch === sep) {
      row.push(field);
      field = "";
      if (sep === "\n") {
        rows.push(row);
        row = [];
      }
      i++;
      continue;
    }
    if (sep !== "\n" && (ch === "\r" || ch === "\n")) {
      if (ch === "\r" && text[i + 1] === "\n") i++;
      ({ row, field } = endRow(rows, row, field));
      i++;
      continue;
    }
    field += ch;
    i++;
  }
  row.push(field);
  rows.push(row);
  return rows;
}

/** TSV / RFC 4180: a leading `"` quotes the field; Excel drops quotes on simple `"word"` cells. */
function parseDelimitedQuoted(text: string, sep: string): { rows: string[][]; unclosed: boolean } {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let i = 0;
  let quoted = false;
  while (i < text.length) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i += 2;
        } else {
          quoted = false;
          i++;
        }
      } else {
        const step = appendQuotedChar(field, ch, text[i + 1]);
        field = step.field;
        i += step.i;
      }
      continue;
    }
    if (field === "" && ch === '"') {
      quoted = true;
      i++;
      continue;
    }
    if (ch === sep) {
      row.push(field);
      field = "";
      if (sep === "\n") {
        rows.push(row);
        row = [];
      }
      i++;
      continue;
    }
    if (sep !== "\n" && (ch === "\r" || ch === "\n")) {
      if (ch === "\r" && text[i + 1] === "\n") i++;
      ({ row, field } = endRow(rows, row, field));
      i++;
      continue;
    }
    field += ch;
    i++;
  }
  row.push(field);
  rows.push(row);
  return { rows, unclosed: quoted };
}

/**
 * Spreadsheet-style fields: a leading `"` opens quoting (RFC 4180 / Excel);
 * `""` is a literal quote inside; `\r\n` and bare `\r` end rows outside quotes.
 * An unclosed quote re-parses the whole input with no quote handling.
 */
export function parseDelimited(text: string, sep: string): string[][] {
  const { rows, unclosed } = parseDelimitedQuoted(text, sep);
  return unclosed ? parseDelimitedPlain(text, sep) : rows;
}

function noTabNeedsQuoteRules(text: string, openAt: number): boolean {
  let i = openAt + 1;
  while (i < text.length) {
    if (text[i] === '"') {
      if (text[i + 1] === '"') {
        return true;
      }
      const inner = text.slice(openAt + 1, i);
      return inner.includes("\n") || inner.includes("\r");
    }
    i++;
  }
  return false;
}

/** One value per line; quotes apply only when the field needs them (embedded newline or `""`). */
function parseNoTabPaste(text: string): string[][] {
  const rows: string[][] = [];
  let field = "";
  let i = 0;
  const pushRow = () => {
    rows.push([field]);
    field = "";
  };
  while (i < text.length) {
    if (field === "" && text[i] === '"') {
      if (!noTabNeedsQuoteRules(text, i)) {
        field += '"';
        i++;
        continue;
      }
      i++;
      while (i < text.length) {
        if (text[i] === '"') {
          if (text[i + 1] === '"') {
            field += '"';
            i += 2;
          } else {
            i++;
            break;
          }
        } else {
          const step = appendQuotedChar(field, text[i], text[i + 1]);
          field = step.field;
          i += step.i;
        }
      }
      if (i < text.length && (text[i] === "\r" || text[i] === "\n")) {
        if (text[i] === "\r" && text[i + 1] === "\n") i++;
        pushRow();
        i++;
      }
      continue;
    }
    if (text[i] === "\r") {
      if (text[i + 1] === "\n") i++;
      pushRow();
      i++;
      continue;
    }
    if (text[i] === "\n") {
      pushRow();
      i++;
      continue;
    }
    field += text[i++];
  }
  pushRow();
  return rows;
}

/** A pasted block: quote-aware TSV when it has tabs; else one value per line. */
export function parsePaste(text: string): string[][] {
  const trimmed = stripTrailingLineBreak(text);
  if (trimmed.includes("\t")) return parseDelimited(trimmed, "\t");
  if (trimmed === "") return [[""]];
  return parseNoTabPaste(trimmed);
}

/** Whether a copied typed value can stage into this column without re-parsing. */
export function valueFitsEditor(ed: ColumnEditor, value: Value): boolean {
  if ("Bytes" in value) return false;
  switch (ed.kind) {
    case "int":
      return "Int" in value || "BigInt" in value;
    case "bool":
      return "Bool" in value;
    case "number":
      return "Int" in value || "Float" in value || ("Text" in value && NUMBER.test(value.Text));
    case "enum":
      return "Text" in value && (!ed.labels?.length || ed.labels.includes(value.Text));
    case "text":
      return "Text" in value;
    default:
      return false;
  }
}

function externalPasteText(ed: ColumnEditor, text: string): { value: Value | null } | { error: string } {
  const asNull = text === "NULL" || (text === "" && ed.kind !== "text");
  if (asNull) {
    if (!ed.nullable) return { error: "Can't be NULL" };
    return { value: null };
  }
  const parsed = parseInput(ed.kind, text);
  return "error" in parsed ? parsed : { value: parsed.value };
}

/** One pasted cell: in-app typed round trip, or plain text from outside. */
export function pasteCellForGrid(
  ed: ColumnEditor,
  opts: { fromRoundtrip: boolean; typed: GridCopyCell | undefined; text: string },
): { value: Value | null } | { error: string } {
  const { fromRoundtrip, typed, text } = opts;
  if (!fromRoundtrip || typed === undefined) return externalPasteText(ed, text);
  if (typed === gridCopyBytes) return { error: "Can't paste this cell" };
  if (typed === null) {
    if (!ed.nullable) return { error: "Can't be NULL" };
    return { value: null };
  }
  if (valueFitsEditor(ed, typed)) return { value: typed };
  const reparsed = parseInput(ed.kind, valueText(typed));
  if ("error" in reparsed) return reparsed;
  if (
    ed.kind === "enum" &&
    ed.labels?.length &&
    "Text" in reparsed.value &&
    !ed.labels.includes(reparsed.value.Text)
  ) {
    return { error: "Not a valid label" };
  }
  return { value: reparsed.value };
}
