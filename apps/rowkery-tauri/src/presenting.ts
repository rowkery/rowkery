import { useSyncExternalStore } from "react";
import { readKey, writeKey } from "./persist";
import { connectionSubtitle, type ConnectionRecord } from "./types";

/**
 * Presenting: sensitive columns (a connection's `masked_columns`, the ones
 * agents only see as stand-ins) show as dots on screen, and the schema
 * column hides the host and user. One switch for every window, kept in
 * config.json so a restart mid-demo stays hidden. Copy still copies the
 * real value: it is what's on screen that is hidden, not the data.
 */
const KEY = "rowkery.presenting";

/** What a hidden cell shows. */
export const HIDDEN_TEXT = "••••••";

const listeners = new Set<() => void>();

export function presentingOn(): boolean {
  return readKey(KEY) === true;
}

export function setPresenting(on: boolean) {
  if (on === presentingOn()) return;
  writeKey(KEY, on ? true : undefined);
  for (const l of listeners) l();
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function usePresenting(): boolean {
  return useSyncExternalStore(subscribe, presentingOn, presentingOn);
}

/**
 * The shown result's columns that are marked, by name. A table's result
 * matches `schema.table.column` exactly; any other result has no origin per
 * column, so a column is hidden when its name is marked anywhere in the
 * database (a rename with AS shows; that's the cost of not parsing SQL).
 */
export function markedNames(
  marks: readonly string[],
  table: { schema: string; name: string } | null,
): Set<string> {
  const out = new Set<string>();
  for (const m of marks) {
    // As rowkery-mcp `mask::parse` reads it: schema to the first dot, column from the last.
    const first = m.indexOf(".");
    const last = m.lastIndexOf(".");
    if (first <= 0 || last <= first + 1 || last === m.length - 1) continue;
    const column = m.slice(last + 1);
    if (!table || (m.slice(0, first) === table.schema && m.slice(first + 1, last) === table.name)) out.add(column);
  }
  return out;
}

/** A connection's second line: where it points, or while presenting only its database or file name. */
export function connectionLine(record: ConnectionRecord, presenting: boolean): string {
  if (!presenting) return connectionSubtitle(record);
  return record.kind === "sqlite" ? (record.path.split(/[\\/]/).pop() ?? "") : record.database;
}
