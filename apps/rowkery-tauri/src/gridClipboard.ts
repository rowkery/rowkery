import type { Value } from "./types";

/** Last block copied from the grid (exact clipboard text + typed cell values). */
let lastGridCopy: { text: string; cells: (Value | null)[][]; withHeader: boolean } | null = null;

export function recordGridCopy(
  text: string,
  cells: (Value | null)[][],
  withHeader: boolean,
): void {
  lastGridCopy = { text, cells, withHeader };
}

/** When clipboard text matches the last grid copy, return typed cells (no header row). */
export function gridCopyRoundtrip(text: string): (Value | null)[][] | null {
  if (!lastGridCopy || lastGridCopy.text !== text) return null;
  return lastGridCopy.cells;
}
