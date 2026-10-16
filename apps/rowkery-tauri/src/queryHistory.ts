import { readKey, writeKey } from "./persist";

/** Recently run SQL per connection, saved (persist.ts) for the palette. */

export interface HistoryEntry {
  sql: string;
  at: number;
}

const LIMIT = 50;

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
  if (!connectionId || !text) return history;
  const next = [
    { sql: text, at: Date.now() },
    ...history.filter((e) => e.sql !== text),
  ].slice(0, LIMIT);
  writeKey(storageKey(connectionId), next);
  return next;
}
