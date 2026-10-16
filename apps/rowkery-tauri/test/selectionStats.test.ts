import { describe, expect, test } from "vitest";
import { formatStats, selectionStats } from "../src/selectionStats";
import type { Value } from "../src/types";

const grid: Value[][] = [
  [{ Int: 1 }, { Text: "920.00" }, { Text: "pending" }],
  [{ Int: 2 }, { Text: "410.50" }, { Null: null }],
  [{ BigInt: "9007199254740993" }, { Text: "388.00" }, { Float: 1.5 }],
];
const get = (r: number, c: number) => grid[r][c];
const types = ["int8", "numeric", "text"];

describe("selectionStats", () => {
  test("numeric text counts in a numeric column", () => {
    const s = selectionStats({ r0: 0, r1: 2, c0: 1, c1: 1 }, get, types)!;
    expect(s).toEqual({ cells: 3, numbers: 3, sum: 1718.5, avg: 1718.5 / 3 });
    expect(formatStats(s)).toBe("3 cells · sum 1,718.50 · avg 572.83");
  });

  test("text and NULL are counted as cells, not numbers", () => {
    const s = selectionStats({ r0: 0, r1: 2, c0: 2, c1: 2 }, get, types)!;
    expect(s.cells).toBe(3);
    expect(s.numbers).toBe(1);
    // A text column's digits would be text: "pending" never parses anyway.
  });

  test("one cell, or nothing numeric", () => {
    expect(selectionStats({ r0: 0, r1: 0, c0: 0, c1: 0 }, get, types)).toBeNull();
    const words = selectionStats({ r0: 0, r1: 1, c0: 2, c1: 2 }, get, types)!;
    expect(formatStats(words)).toBe("2 cells");
  });

  test("integers sum without decimals", () => {
    const s = selectionStats({ r0: 0, r1: 1, c0: 0, c1: 0 }, get, types)!;
    expect(formatStats(s)).toBe("2 cells · sum 3 · avg 1.50");
  });
});
