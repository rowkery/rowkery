import { readKey, writeKey } from "./persist";

/** Recently run SQL per connection, saved (persist.ts) for the palette. */

export interface HistoryEntry {
  sql: string;
  at: number;
}

const LIMIT = 50;
/**
 * Longer SQL (a pasted dump, a long INSERT) isn't kept: every entry is
 * written to config.json with the rest of the UI state, and a cut-off copy
 * would run something else.
 */
export const MAX_SQL = 16_000;

function storageKey(connectionId: string) {
  return `rowkery.history.${connectionId}`;
}

export function loadHistory(connectionId: string | null): HistoryEntry[] {
  if (!connectionId) return [];
  try {
    const parsed: unknown = readKey(storageKey(connectionId)) ?? [];
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (e): e is HistoryEntry =>
        !!e && typeof e.sql === "string" && typeof e.at === "number",
    );
  } catch {
    return [];
  }
}

/** Newest first; running the same SQL again moves it to the top. */
export function recordHistory(
  connectionId: string | null,
  history: HistoryEntry[],
  sql: string,
): HistoryEntry[] {
  const text = sql.trim();
  if (!connectionId || !text || text.length > MAX_SQL) return history;
  const next = [
    { sql: text, at: Date.now() },
    ...history.filter((e) => e.sql !== text),
  ].slice(0, LIMIT);
  writeKey(storageKey(connectionId), next);
  return next;
}

/** A deleted connection's history goes with it (once its Undo has passed). */
export function forgetHistory(connectionId: string) {
  writeKey(storageKey(connectionId), undefined);
}
