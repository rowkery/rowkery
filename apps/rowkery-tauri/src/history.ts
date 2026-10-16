import type { FilterChip } from "./filterChips";

/**
 * A window's history of where its Preview tab has been: browsed tables (with
 * their filter, sort and page size) and Structure views. ‹ › and ⌘[ ⌘] walk
 * it; a new step from the middle drops the steps ahead. Session only.
 */

export interface HistoryEntry {
  tableKey: string;
  /** The table's name, for tooltips and the list. */
  name: string;
  view: "data" | "structure";
  filter: string;
  /** The filter's chips, so ‹ › bring them back as chips. */
  chips?: FilterChip[];
  /** Sort keys, primary first; empty when unsorted. */
  sort: { column: string; desc: boolean }[];
  pageSize?: number;
}

export interface History {
  entries: HistoryEntry[];
  /** The entry on screen; -1 when empty. */
  index: number;
}

export const EMPTY_HISTORY: History = { entries: [], index: -1 };
export const MAX_HISTORY = 50;

const same = (a: HistoryEntry, b: HistoryEntry) =>
  a.tableKey === b.tableKey &&
  a.view === b.view &&
  a.filter === b.filter &&
  a.sort.length === b.sort.length &&
  a.sort.every((k, i) => k.column === b.sort[i]?.column && k.desc === b.sort[i]?.desc);

/**
 * `now` is what the current entry looks like as you leave it (its filter or
 * sort may have changed since it was pushed); it replaces that entry when
 * it is the same table.
 */
function withCurrent(h: History, now: HistoryEntry | null): HistoryEntry[] {
  const cur = h.entries[h.index];
  if (!now || !cur || cur.tableKey !== now.tableKey) return h.entries;
  return h.entries.map((e, i) => (i === h.index ? now : e));
}

/** A step to `entry`: drops the steps ahead; nothing when it is where we are. */
export function pushHistory(h: History, entry: HistoryEntry, now: HistoryEntry | null = null): History {
  const entries = withCurrent(h, now).slice(0, h.index + 1);
  const cur = entries[entries.length - 1];
  if (cur && same(cur, entry)) return { entries, index: entries.length - 1 };
  const next = [...entries, entry].slice(-MAX_HISTORY);
  return { entries: next, index: next.length - 1 };
}

/** ‹ (-1) or › (+1), or a jump to `to`; null when there is nothing there. */
export function goHistory(h: History, delta: number, now: HistoryEntry | null = null): History | null {
  const index = h.index + delta;
  if (delta === 0 || index < 0 || index >= h.entries.length) return null;
  return { entries: withCurrent(h, now), index };
}

/** "wallet_tx · status = 'pending' · amount ↓", "wallets · Structure". */
export function historyLabel(e: HistoryEntry): string {
  if (e.view === "structure") return `${e.name} · Structure`;
  const parts = [e.name];
  if (e.filter.trim()) parts.push(e.filter.trim());
  if (e.sort.length) parts.push(e.sort.map((k) => `${k.column} ${k.desc ? "↓" : "↑"}`).join(", "));
  return parts.join(" · ");
}
