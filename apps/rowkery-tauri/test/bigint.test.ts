// int8 beyond JavaScript's exact range arrives as { BigInt: "<digits>" }
// (rowkery-core's Value serializer) and every reader keeps it exact.
import { describe, expect, test } from "vitest";
import { cellsToCsv, resultsToText } from "../src/resultsExport";
import { rowToJson, sqlLiteral } from "../src/QuickLook";
import { columnProfiles as profilesOf, summarizeRows } from "../src/columnProfile";
import { ResultRows } from "../src/resultStore";
import { safeFormatCell, type QueryResultDto, type Value } from "../src/types";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const columnProfiles = (columns: any, values: any[][]) => {
  const rows = ResultRows.fromValues(values);
  rows.setProfiles(summarizeRows(columns, rows));
  return profilesOf(columns, rows);
};

const MAX = "9223372036854775807"; // 2^63 − 1
const MIN = "-9223372036854775808";
const result: QueryResultDto = {
  columns: [
    { name: "id", type_name: "int8" },
    { name: "note", type_name: "text" },
  ],
  rows: ResultRows.fromValues([
    [{ BigInt: MAX }, { Text: "max" }],
    [{ BigInt: MIN }, { Text: "min" }],
    [{ Int: 42 }, { Null: null }],
  ]),
  row_count: 3,
  elapsed_ms: 1,
  error: null,
  cancelled: false,
};

describe("BigInt cells", () => {
  test("format as their digits", () => {
    expect(safeFormatCell({ BigInt: MAX })).toBe(MAX);
  });

  test("2^63 − 1 round-trips to CSV and TSV exactly", () => {
    const csv = resultsToText(result, "csv");
    expect(csv.split(/\r?\n/)[1]).toBe(`${MAX},max`);
    expect(csv).toContain(`${MIN},min`);
    expect(resultsToText(result, "tsv")).toContain(`${MAX}\tmax`);
    expect(Number(MAX).toString()).not.toBe(MAX); // what a number would have written
  });

  test("a copied block keeps them exact", () => {
    expect(cellsToCsv(result, 0, 0, 0, 1, true)).toBe(`id,note\n${MAX},max`);
  });

  test("Quick Look's JSON writes them as bare exact numbers", () => {
    const json = rowToJson(result.columns, result.rows.row(0, 2));
    expect(json).toContain(`"id": ${MAX}`);
    expect(JSON.parse(json).note).toBe("max");
    expect(rowToJson(result.columns, result.rows.row(1, 2))).toContain(`"id": ${MIN}`);
  });

  test("a foreign-key lookup uses the exact literal", () => {
    expect(sqlLiteral({ BigInt: MAX })).toBe(MAX);
    expect(sqlLiteral({ BigInt: "1; drop table x" } as Value)).toBeNull();
    expect(sqlLiteral({ Int: 7 })).toBe("7");
  });

  test("profiles treat them as numbers", () => {
    const [p] = columnProfiles([{ name: "id", type_name: "" }], [[{ BigInt: MAX }], [{ Int: 1 }]]);
    expect(p?.kind).toBe("hist");
  });
});

describe("Quick Look's JSON keeps jsonb as stored", () => {
  test("big numbers and 1.0 inside a jsonb survive copy-as-JSON", () => {
    const columns = [
      { name: "id", type_name: "int4" },
      { name: "doc", type_name: "jsonb" },
      { name: "bad", type_name: "json" },
    ];
    const doc = '{"n": 12345678901234567890, "price": 1.0, "s": "$1"}';
    const json = rowToJson(columns, [{ Int: 1 }, { Text: doc }, { Text: "{not json" }]);
    expect(json).toContain(doc);
    // Still one valid JSON object; text that isn't JSON stays a string.
    expect(JSON.parse(json).bad).toBe("{not json");
    expect(JSON.parse(json).doc.price).toBe(1);
  });
});
