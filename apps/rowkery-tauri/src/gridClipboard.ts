import type { GridCopyCell } from "./editBuffer";

/** Last block copied from the grid (exact clipboard text + typed cell values). */
let lastGridCopy: { text: string; cells: GridCopyCell[][] } | null = null;

export function recordGridCopy(text: string, cells: GridCopyCell[][]): void {
  lastGridCopy = { text, cells };
}

/** When clipboard text matches the last grid copy, return typed cells (data rows only). */
export function gridCopyRoundtrip(text: string): GridCopyCell[][] | null {
  if (!lastGridCopy || lastGridCopy.text !== text) return null;
  return lastGridCopy.cells;
}
