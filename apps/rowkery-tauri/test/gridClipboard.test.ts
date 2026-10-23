// ⌘C on a grid block writes TSV and remembers its cells; ⌘V of that same text gets NULL back.
import { describe, expect, test } from "vitest";
import { cellsToTsv, copiedCells, rememberCopy } from "../src/resultsExport";
import { parsePaste } from "../src/editBuffer";
import { ResultRows } from "../src/resultStore";
import type { QueryResultDto } from "../src/types";

const result: QueryResultDto = {
  columns: [
    { name: "id", type_name: "int4" },
    { name: "note", type_name: "text" },
  ],
  rows: ResultRows.fromValues([
    [{ Int: 1 }, { Null: null }],
    [{ Int: 2 }, { Text: "NULL" }],
    [{ Int: 3 }, { Text: "" }],
    [{ Int: 4 }, { Text: 'two\nlines\twith "quotes"' }],
  ]),
  row_count: 4,
  elapsed_ms: 1,
  error: null,
  cancelled: false,
};

describe("grid copy and paste", () => {
  const copy = cellsToTsv(result, 0, 3, 0, 1, false);

  test("copies TSV, quoting what needs it", () => {
    expect(copy.text).toBe('1\t\n2\tNULL\n3\t\n4\t"two\nlines\twith ""quotes"""');
  });

  test("the grid's own copy pastes back exactly, NULL included", () => {
    rememberCopy(copy);
    const cells = [["1", null], ["2", "NULL"], ["3", ""], ["4", 'two\nlines\twith "quotes"']];
    expect(copiedCells(copy.text)).toEqual(cells);
    // The clipboard may hand it back with CRLF or a trailing line break.
    expect(copiedCells(copy.text.replace(/\n/g, "\r\n") + "\r\n")).toEqual(cells);
  });

  test("other text parses as is: NULL stays text, NULL and empty both read empty", () => {
    rememberCopy(copy);
    expect(copiedCells("1\tNULL")).toBeNull();
    expect(parsePaste(copy.text)).toEqual([["1", ""], ["2", "NULL"], ["3", ""], ["4", 'two\nlines\twith "quotes"']]);
  });
});
