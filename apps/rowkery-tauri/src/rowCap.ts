import type { Value } from "./types";

/**
 * The most rows one tab holds (core's `MAX_TAB_ROWS`). Paging stops there:
 * a fetch never asks for more than is left of it, and core leaves out what a
 * single run returns past it.
 */
export const MAX_TAB_ROWS = 1_000_000;

/** What the toast says when a tab stops loading at the cap. */
export const CAPPED_MESSAGE = `Stopped at ${MAX_TAB_ROWS.toLocaleString("en-US")} rows`;

/**
 * Rows the next fetch asks for: `page` (0: all the rest) within what the tab
 * may still hold after `loaded`. 0 when it holds all it may.
 */
export function nextFetchRows(page: number, loaded: number, cap = MAX_TAB_ROWS): number {
  const room = Math.max(0, cap - loaded);
  return page > 0 ? Math.min(page, room) : room;
}

/**
 * The last loaded row as the next page's `after`: only the columns pages are
 * ordered by (the sort, then the key). A bytes cell is left out: the grid
 * may hold just its first bytes, so it is no value to continue from, and
 * core pages by OFFSET when a column is missing.
 */
export function pageAfter(names: string[], cell: (name: string) => Value | undefined): Record<string, Value> {
  const after: Record<string, Value> = {};
  for (const name of names) {
    const v = cell(name);
    if (v !== undefined && !(typeof v === "object" && "Bytes" in v)) after[name] = v;
  }
  return after;
}

/** Whether a tab with `loaded` rows has reached the cap. */
export function atCap(loaded: number, cap = MAX_TAB_ROWS): boolean {
  return loaded >= cap;
}
