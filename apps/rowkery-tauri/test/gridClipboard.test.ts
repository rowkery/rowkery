import { describe, expect, test } from "vitest";
import { cellsToCsv } from "../src/resultsExport";
import { gridCopyRoundtrip, recordGridCopy } from "../src/gridClipboard";
import { pasteCellForGrid } from "../src/editBuffer";
import { ResultRows } from "../src/resultStore";
import type { QueryResultDto } from "../src/types";

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

const textEd = { kind: "text" as const, nullable: true, default: null };

describe("grid copy round trip", () => {
  test("typed cells restore on an exact clipboard match", () => {
    const cells = [
      [null, { Text: "NULL" }],
      [{ Text: "line1\nline2" }, { Text: "" }],
    ];
    const text = cellsToCsv(result, 0, 1, 0, 1, false, (r, c) => result.rows.text(r, c));
    recordGridCopy(text, cells);
    expect(gridCopyRoundtrip(text)).toEqual(cells);
    expect(gridCopyRoundtrip(text + " ")).toBeNull();
  });

  test("pasteCellForGrid stages round-tripped empty text as empty, not NULL", () => {
    recordGridCopy("", [[{ Text: "" }]]);
    const typed = gridCopyRoundtrip("");
    expect(typed).toEqual([[{ Text: "" }]]);
    expect(pasteCellForGrid(textEd, { fromRoundtrip: true, typed: typed![0][0], text: "" })).toEqual({
      value: { Text: "" },
    });
    expect(pasteCellForGrid(textEd, { fromRoundtrip: false, typed: undefined, text: "" })).toEqual({
      value: { Text: "" },
    });
  });
});
