import { describe, expect, test } from "vitest";
import { cellsToCsv } from "../src/resultsExport";
import { gridCopyRoundtrip, recordGridCopy } from "../src/gridClipboard";
import { parseInput } from "../src/editBuffer";
import { ResultRows } from "../src/resultStore";
import type { QueryResultDto, Value } from "../src/types";

const result: QueryResultDto = {
  columns: [
    { name: "city", type_name: "text" },
    { name: "tag", type_name: "text" },
  ],
  rows: ResultRows.fromValues([
    [{ Null: null }, { Text: "NULL" }],
    [{ Text: "line1\nline2" }, { Text: "" }],
    [{ Text: "a,b" }, { Text: "x" }],
  ]),
  row_count: 3,
  elapsed_ms: 1,
  error: null,
  cancelled: false,
};

function cellValue(isNull: boolean, v: Value): Value | null {
  if (isNull) return null;
  return !v || "Null" in v ? null : v;
}

describe("grid copy round trip", () => {
  test("typed cells restore on an exact clipboard match", () => {
    const cells: (Value | null)[][] = [
      [null, { Text: "NULL" }],
      [{ Text: "line1\nline2" }, { Text: "" }],
    ];
    const text = cellsToCsv(result, 0, 1, 0, 1, false, (r, c) => result.rows.text(r, c));
    recordGridCopy(text, cells, false);
    expect(gridCopyRoundtrip(text)).toEqual(cells);
    expect(gridCopyRoundtrip(text + " ")).toBeNull();
  });

  test("single-cell copy records NULL, empty and comma text", () => {
    const cases: [number, number, string][] = [
      [0, 0, "NULL"],
      [0, 1, "NULL"],
      [1, 1, ""],
      [2, 0, "a,b"],
    ];
    for (const [r, c, text] of cases) {
      const v = cellValue(result.rows.isNull(r, c), result.rows.get(r, c));
      recordGridCopy(text, [[v]], false);
      expect(gridCopyRoundtrip(text)).toEqual([[v]]);
    }
  });

  test("round trip keeps text NULL while external paste would stage SQL NULL", () => {
    recordGridCopy("NULL", [{ Text: "NULL" }], false);
    expect(gridCopyRoundtrip("NULL")).toEqual([{ Text: "NULL" }]);
    const externalNull = (text: string, kind: "text" | "int") =>
      text === "NULL" || (text === "" && kind !== "text") ? null : parseInput(kind, text);
    expect(externalNull("NULL", "int")).toBeNull();
    expect(externalNull("NULL", "text")).toBeNull();
  });
});
