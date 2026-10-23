// ⌘C on a grid block writes TSV and remembers where its NULLs were; ⌘V of that same text gets them back.
import { describe, expect, test } from "vitest";
import { cellsToTsv, pastedCells, rememberCopy } from "../src/resultsExport";
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
    [{ Int: 5 }, { Text: '"hello"' }],
  ]),
  row_count: 5,
  elapsed_ms: 1,
  error: null,
  cancelled: false,
};

const cells = [["1", null], ["2", "NULL"], ["3", ""], ["4", 'two\nlines\twith "quotes"'], ["5", '"hello"']];

describe("grid copy and paste", () => {
  const copy = cellsToTsv(result, 0, 4, 0, 1, false);

  test("copies TSV, quoting what needs it", () => {
    expect(copy.text).toBe('1\t\n2\tNULL\n3\t\n4\t"two\nlines\twith ""quotes"""\n5\t"""hello"""');
    expect([...copy.nulls]).toEqual([1]);
  });

  test("the grid's own copy pastes back exactly, NULL included", () => {
    rememberCopy(copy);
    expect(pastedCells(copy.text)).toEqual(cells);
    // The clipboard may hand it back with CRLF or a trailing line break.
    expect(pastedCells(copy.text.replace(/\n/g, "\r\n") + "\r\n")).toEqual(cells);
  });

  test("with the header, the NULLs stay on their rows", () => {
    rememberCopy(cellsToTsv(result, 0, 1, 0, 1, true));
    expect(pastedCells("id\tnote\n1\t\n2\tNULL")).toEqual([["id", "note"], ["1", null], ["2", "NULL"]]);
  });

  test("other text parses as is: NULL stays text, NULL and empty both read empty", () => {
    rememberCopy(copy);
    expect(pastedCells("1\t")).toEqual([["1", ""]]);
  });
  // Forgetting it on another copy or on leaving the window: row-edits-browser-proof.mjs.
});
