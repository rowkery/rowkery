import { invoke } from "@tauri-apps/api/core";
import type { ConnectionRecord, MaskedColumns, McpAccess, McpDbAccess } from "./types";

/**
 * What a shared connection lets agents reach, as Edit access on the Agents
 * page edits it: per database, `picked` (an allow list, tables created later
 * stay hidden; what Edit access writes) or `all` (a hide list, kept for
 * connections shared before the map). The
 * MCP server applies the same rules (rowkery-mcp `access.rs`); a database
 * with no entry isn't shared. A connection saved before the map existed has
 * none and shares every database minus `mcp_hidden_tables`.
 */

/** The database a connection opens on; SQLite's one is `main`. */
export function ownDatabase(c: ConnectionRecord): string {
  return c.kind === "postgres" ? c.database : "main";
}

/** What turning sharing on shares at first: the own database, no tables until they're listed. */
export function defaultAccess(c: ConnectionRecord): McpAccess {
  return { [ownDatabase(c)]: { mode: "picked", tables: [] } };
}

/**
 * The map Edit access starts from: the saved one, or for a connection saved
 * before it, every listed database as All but its hidden tables (what the
 * server does for it), so the first tick changes nothing else.
 */
export function accessOf(c: ConnectionRecord, databases: string[]): McpAccess {
  if (c.mcp_access) return c.mcp_access;
  const hidden = c.mcp_hidden_tables ?? [];
  const out: McpAccess = {};
  for (const db of databases.length ? databases : [ownDatabase(c)]) out[db] = { mode: "all", tables: [...hidden] };
  return out;
}

/** A hide-list entry against `schema.table`: case ignored, a bare name in any schema (as the server). */
function hides(entry: string, name: string): boolean {
  const e = entry.toLowerCase();
  const n = name.toLowerCase();
  return e.includes(".") ? e === n : n.slice(n.indexOf(".") + 1) === e;
}

/** Whether one `schema.table` is shared under a database's rule. */
export function tableShared(rule: McpDbAccess, name: string): boolean {
  const list = rule.tables ?? [];
  // Picked names match exactly, as the server matches them.
  return rule.mode === "picked" ? list.includes(name) : !list.some((h) => hides(h, name));
}

/** Shares (`on`) or keeps back each of `names`. */
export function setTables(rule: McpDbAccess, names: string[], on: boolean): McpDbAccess {
  const list = rule.tables ?? [];
  if (rule.mode === "picked") {
    const tables = on ? [...list, ...names.filter((n) => !list.includes(n))] : list.filter((t) => !names.includes(t));
    return { mode: "picked", tables };
  }
  const tables = on
    ? list.filter((h) => !names.some((n) => hides(h, n)))
    : [...list, ...names.filter((n) => !list.some((h) => hides(h, n)))];
  return { mode: "all", tables };
}

export function sharedCount(rule: McpDbAccess, all: string[]): number {
  return all.reduce((n, t) => n + Number(tableShared(rule, t)), 0);
}

/** A database's tables as the picker lists them (rowkery-mcp `picker.rs`). */
export interface PickTable {
  schema: string;
  name: string;
  kind: "table" | "view" | "materialized view";
  rows: number | null;
  big: boolean;
  columns: PickColumn[];
}

export interface PickColumn {
  name: string;
  type: string;
}

export interface PickDatabase {
  name: string;
  size_bytes: number | null;
}

const databases = new Map<string, Promise<PickDatabase[]>>();
const tables = new Map<string, Promise<PickTable[]>>();
const loadedTables = new Map<string, PickTable[]>();
const key = (id: string, db: string) => `${id}\u0000${db}`;

/** A connection's databases with sizes, loaded once per page visit unless `refresh`. */
export function pickDatabases(id: string, refresh = false): Promise<PickDatabase[]> {
  let found = refresh ? undefined : databases.get(id);
  if (!found) {
    found = invoke<PickDatabase[]>("mcp_pick_databases", { connectionId: id });
    databases.set(id, found);
    found.catch(() => databases.delete(id));
  }
  return found;
}

/** One database's tables and views, by schema. */
export function pickTables(id: string, db: string, refresh = false): Promise<PickTable[]> {
  const k = key(id, db);
  let found = refresh ? undefined : tables.get(k);
  if (!found) {
    found = invoke<PickTable[]>("mcp_pick_tables", { connectionId: id, database: db, refresh });
    tables.set(k, found);
    found.then((list) => loadedTables.set(k, list)).catch(() => tables.delete(k));
  }
  return found;
}

/** Edit access closed: the app drops the sessions the picker opened. */
export function closePicker(): Promise<void> {
  return invoke<void>("mcp_pick_close").catch(() => undefined);
}

/** The tables already loaded for a database, without asking for them. */
export function loadedTablesOf(id: string, db: string): PickTable[] | undefined {
  return loadedTables.get(key(id, db));
}

/** Test hook. */
export function resetPickerForTests() {
  databases.clear();
  tables.clear();
  loadedTables.clear();
}

export const tableName = (t: PickTable) => `${t.schema}.${t.name}`;

/**
 * The card's line: the shared databases, and how many tables ("8 of 23"
 * once the editor has listed them, else what the rule says).
 */
export function accessSummary(c: ConnectionRecord): { databases: string; tables: string } {
  if (!c.mcp_access) {
    const hidden = c.mcp_hidden_tables?.length ?? 0;
    return {
      databases: c.kind === "postgres" ? "Every database" : "This file",
      tables: hidden ? `all but ${hidden} ${hidden === 1 ? "table" : "tables"}` : "all tables",
    };
  }
  const entries = Object.entries(c.mcp_access).sort(([a], [b]) => a.localeCompare(b));
  if (!entries.length) return { databases: "No databases", tables: "" };
  const names = c.kind === "postgres" ? entries.map(([db]) => db).join(", ") : "This file";
  const lists = entries.map(([db]) => loadedTablesOf(c.id, db)?.map(tableName));
  if (lists.every((l) => l !== undefined)) {
    let shared = 0;
    let total = 0;
    entries.forEach(([, rule], i) => {
      shared += sharedCount(rule, lists[i]!);
      total += lists[i]!.length;
    });
    return { databases: names, tables: shared === 0 ? "no tables yet" : `${shared} of ${total} tables` };
  }
  const picked = entries.filter(([, r]) => r.mode === "picked");
  const pickedN = picked.reduce((n, [, r]) => n + (r.tables?.length ?? 0), 0);
  const hiddenN = entries.reduce((n, [, r]) => n + (r.mode === "all" ? (r.tables?.length ?? 0) : 0), 0);
  if (picked.length === entries.length)
    return { databases: names, tables: pickedN === 0 ? "no tables yet" : `${pickedN} ${pickedN === 1 ? "table" : "tables"}` };
  if (!picked.length)
    return { databases: names, tables: hiddenN ? `all but ${hiddenN} ${hiddenN === 1 ? "table" : "tables"}` : "all tables" };
  const allOf = `all of ${entries.filter(([, r]) => r.mode === "all").map(([db]) => db).join(", ")}`;
  return { databases: names, tables: pickedN ? `${pickedN} ${pickedN === 1 ? "table" : "tables"}, and ${allOf}` : allOf };
}

/** The saved name of a sensitive column: `schema.table.column`. */
export const columnName = (t: PickTable, column: string) => `${t.schema}.${t.name}.${column}`;

/** One database's sensitive columns. */
export function maskedOf(c: ConnectionRecord, db: string): string[] {
  return c.masked_columns?.[db] ?? [];
}

/** The map with `names` marked (or not) in `db`; an empty database drops out. */
export function withMasked(all: MaskedColumns | undefined, db: string, names: string[], on: boolean): MaskedColumns {
  const list = all?.[db] ?? [];
  const next = on ? [...list, ...names.filter((n) => !list.includes(n))] : list.filter((n) => !names.includes(n));
  const out = { ...(all ?? {}) };
  if (next.length) out[db] = next.sort();
  else delete out[db];
  return out;
}

/** Words in a column's name that usually mean personal data. */
const PERSONAL = new Set([
  "email", "mail", "phone", "mobile", "tel", "telephone", "fax",
  "address", "street", "addr", "postcode", "postal", "zip", "zipcode",
  "birth", "birthday", "birthdate", "dob",
  "ssn", "passport", "iban", "nric",
  "password", "passwd", "secret", "token",
  "ip",
  "surname", "lastname", "firstname", "fullname",
]);
/** Pairs of words that only mean personal data together. */
const PERSONAL_PAIRS = [
  ["first", "name"], ["last", "name"], ["full", "name"], ["middle", "name"], ["display", "name"],
  ["date", "birth"], ["tax", "id"], ["national", "id"], ["social", "security"], ["card", "number"],
  ["account", "number"], ["api", "key"], ["ip", "address"],
];

/** Whether a column's name looks like it holds personal data (email, phone, date of birth…). */
export function looksPersonal(column: string): boolean {
  const words = column
    .replace(/([a-z])([A-Z])/g, "$1_$2")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
  if (words.some((w) => PERSONAL.has(w))) return true;
  return PERSONAL_PAIRS.some(([a, b]) => words.includes(a) && words.includes(b));
}
