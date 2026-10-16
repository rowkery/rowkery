import type { Value } from "./types";

/** What a selected block adds up to, for the SQL line's right end. */
export interface SelectionStats {
  cells: number;
  /** Cells that held a number (NULLs and text are left out of sum and avg). */
  numbers: number;
  sum: number;
  avg: number;
}

/** Past this many cells the stats aren't worth a frame. */
export const STATS_LIMIT = 200_000;

const NUMERIC_TYPE = /^(int|integer|bigint|smallint|tinyint|mediumint|real|double|float|numeric|decimal|money|serial|bigserial)/i;

function numberOf(v: Value, numericColumn: boolean): number | null {
  if ("Int" in v) return v.Int;
  if ("Float" in v) return Number.isFinite(v.Float) ? v.Float : null;
  if ("BigInt" in v) return Number(v.BigInt);
  // numeric / decimal travel as text to keep their digits.
  if ("Text" in v && numericColumn && /^-?\d+(\.\d+)?(e[+-]?\d+)?$/i.test(v.Text.trim())) return Number(v.Text);
  return null;
}

/**
 * Count, sum and average over the block `r0..r1 × c0..c1` (inclusive).
 * `get` reads one cell; `types` are the columns' type names. Null when the
 * block is one cell or larger than `STATS_LIMIT`.
 */
export function selectionStats(
  rect: { r0: number; r1: number; c0: number; c1: number },
  get: (row: number, col: number) => Value,
  types: string[],
): SelectionStats | null {
  const cells = (rect.r1 - rect.r0 + 1) * (rect.c1 - rect.c0 + 1);
  if (cells < 2 || cells > STATS_LIMIT) return null;
  let numbers = 0;
  let sum = 0;
  for (let c = rect.c0; c <= rect.c1; c++) {
    const numericColumn = NUMERIC_TYPE.test(types[c] ?? "");
    for (let r = rect.r0; r <= rect.r1; r++) {
      const n = numberOf(get(r, c), numericColumn);
      if (n !== null) {
        numbers++;
        sum += n;
      }
    }
  }
  return { cells, numbers, sum, avg: numbers ? sum / numbers : 0 };
}

/** "3 cells · sum 1,718.50 · avg 572.83"; just the count when no cell is a number. */
export function formatStats(s: SelectionStats): string {
  const fmt = (n: number) =>
    n.toLocaleString(undefined, { minimumFractionDigits: Number.isInteger(n) ? 0 : 2, maximumFractionDigits: 2 });
  const cells = `${s.cells.toLocaleString()} cells`;
  return s.numbers ? `${cells} · sum ${fmt(s.sum)} · avg ${fmt(s.avg)}` : cells;
}
