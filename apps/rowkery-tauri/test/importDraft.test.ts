import { describe, expect, it } from "vitest";
import type { CsvPreview } from "../src/api";
import {
  draftFor,
  fieldNames,
  importedText,
  importRows,
  importSpec,
  isCsvPath,
  looksLikeData,
  matchColumns,
  previewRows,
  remap,
  takesEmptyText,
  withHeader,
  guessTable,
  rankTables,
} from "../src/importDraft";
import type { ColumnNode } from "../src/types";

const COLUMNS = ["id", "customer_id", "email", "status", "total", "note", "created_at"];

const preview = (rows: string[][], records = rows.length): CsvPreview => ({
  file_name: "orders-october.csv",
  delimiter: ",",
  rows,
  records,
});

describe("CSV import draft", () => {
  it("matches columns by name, ignoring case, _ and spaces, each once", () => {
    expect(matchColumns(["ID", "Customer ID", "e-mail", "utm_source", "id"], COLUMNS)).toEqual([
      "id",
      "customer_id",
      "email",
      null,
      null,
    ]);
  });

  it("matches near names where one free column fits", () => {
    const orders = { name: "orders", key: ["id"] };
    expect(
      matchColumns(["order_id", "customer", "email", "status", "amount", "gift_note", "placed", "utm_source"], COLUMNS, orders),
    ).toEqual(["id", "customer_id", "email", "status", null, "note", null, null]);
    // Never onto the key from another table's id.
    expect(matchColumns(["customer_id"], ["id", "email"], orders)).toEqual([null]);
    // Two columns fit: neither is guessed.
    expect(matchColumns(["home_phone"], ["phone", "home phone x"], orders)).toEqual(["phone"]);
    expect(matchColumns(["x_note"], ["note", "x note"], orders)).toEqual(["x note"]);
  });

  it("reads a first row that names no column as data, mapped in the table's order", () => {
    expect(looksLikeData(["48210", "300", "a@x.com"], COLUMNS)).toBe(true);
    expect(looksLikeData(["order", "email"], COLUMNS)).toBe(false);
    // Only an exact column name makes it a header: "Main Street" is a value.
    expect(looksLikeData(["7", "Main Street", "acme customer"], [...COLUMNS, "street"])).toBe(true);
    const d = draftFor("/f.csv", preview([["48210", "300", "a@x.com"]], 12), COLUMNS);
    expect(d.header).toBe(false);
    expect(d.mapping).toEqual(["id", "customer_id", "email"]);
    expect(fieldNames(d)).toEqual(["Column 1", "Column 2", "Column 3"]);
    expect(importRows(d)).toBe(12);
    const h = withHeader(d, true, COLUMNS);
    expect(h.mapping).toEqual([null, null, null]);
    expect(importRows(h)).toBe(11);
  });

  it("remaps a field and frees a column another field took", () => {
    const d = draftFor("/f.csv", preview([["ref", "email", "amount"]]), COLUMNS);
    expect(d.header).toBe(true);
    expect(d.mapping).toEqual([null, "email", null]);
    const a = remap(remap(d, 0, "id"), 2, "total");
    expect(a.mapping).toEqual(["id", "email", "total"]);
    expect(remap(a, 2, "email").mapping).toEqual(["id", null, "email"]);
    expect(remap(a, 1, null).mapping).toEqual(["id", null, "total"]);
  });

  it("asks core for the mapped fields only", () => {
    const d = { ...remap(draftFor("/f.csv", preview([["order_id", "email", "x"]]), COLUMNS), 0, "id"), onConflict: "skip" as const };
    expect(importSpec(d, "public", "orders")).toEqual({
      path: "/f.csv",
      schema: "public",
      table: "orders",
      delimiter: ",",
      header: true,
      columns: [
        { field: 0, column: "id" },
        { field: 1, column: "email" },
      ],
      on_conflict: "skip",
      empty: "null",
    });
  });

  it("previews rows as the table gets them: DEFAULT, NULL or empty text", () => {
    const nodes: ColumnNode[] = [
      { name: "id", type_name: "integer", nullable: false },
      { name: "status", type_name: "text", nullable: true, default: "'pending'::text" },
      { name: "note", type_name: "character varying(80)", nullable: true },
      { name: "total", type_name: "numeric", nullable: true },
      { name: "created_at", type_name: "timestamptz", nullable: true, default: "now()" },
    ];
    const d = draftFor(
      "/f.csv",
      preview([
        ["id", "status", "note", "total"],
        ["1", "", "", ""],
        ["2", "paid", "hi", "3.5"],
      ]),
      nodes.map((c) => c.name),
    );
    const shown = ["id", "status", "note", "total", "created_at"];
    expect(previewRows(d, shown, nodes, false)).toEqual([
      [{ Text: "1" }, undefined, null, null, undefined],
      [{ Text: "2" }, { Text: "paid" }, { Text: "hi" }, { Text: "3.5" }, undefined],
    ]);
    expect(previewRows({ ...d, empty: "text" }, shown, nodes, false)[0]).toEqual([
      { Text: "1" },
      { Text: "" },
      { Text: "" },
      null,
      undefined,
    ]);
    expect(previewRows(d, shown, nodes, false, 1)).toHaveLength(1);
  });

  it("knows which columns keep empty text", () => {
    expect(takesEmptyText("character varying(40)", false)).toBe(true);
    expect(takesEmptyText("text", false)).toBe(true);
    expect(takesEmptyText("text[]", false)).toBe(false);
    expect(takesEmptyText("uuid", false)).toBe(false);
    expect(takesEmptyText("timestamp with time zone", false)).toBe(false);
    expect(takesEmptyText("VARCHAR(10)", true)).toBe(true);
    expect(takesEmptyText("", true)).toBe(true);
    expect(takesEmptyText("INTEGER", true)).toBe(false);
  });

  it("says what was imported", () => {
    expect(importedText({ inserted: 12431, updated: 0, skipped: 0 })).toBe("Imported 12,431 rows");
    expect(importedText({ inserted: 1, updated: 0, skipped: 0 })).toBe("Imported 1 row");
    expect(importedText({ inserted: 12000, updated: 0, skipped: 431 })).toBe("Imported 12,000 rows · skipped 431");
    expect(importedText({ inserted: 3, updated: 9, skipped: 0 })).toBe("Added 3 · updated 9");
  });

  it("takes .csv, .tsv and .tab drops", () => {
    expect(isCsvPath("/a/Orders.CSV")).toBe(true);
    expect(isCsvPath("/a/b.tsv")).toBe(true);
    expect(isCsvPath("/a/b.sqlite")).toBe(false);
  });
});

describe("rankTables", () => {
  const tables = [
    { key: "public.customers", name: "customers", columns: ["id", "name", "email"], primaryKey: ["id"] },
    { key: "public.orders", name: "orders", columns: ["id", "customer_id", "total", "placed_at"], primaryKey: ["id"] },
    { key: "public.order_items", name: "order_items", columns: ["order_id", "sku", "qty"], primaryKey: [] },
  ];

  it("puts the table most fields match first", () => {
    const ranked = rankTables(["order_id", "customer", "total", "placed_at"], "export.csv", tables);
    expect(ranked[0]).toEqual({ key: "public.orders", matched: 4, total: 4, named: false });
    expect(guessTable(ranked)?.key).toBe("public.orders");
  });

  it("breaks a tie by the file's name, the longer table name first", () => {
    const ranked = rankTables(["a", "b"], "order_items-2026.csv", tables);
    expect(ranked.map((m) => m.key)).toEqual(["public.order_items", "public.orders", "public.customers"]);
    expect(guessTable(ranked)?.key).toBe("public.order_items");
    expect(rankTables(["a"], "Customer.csv", tables)[0].key).toBe("public.customers");
  });

  it("needs more than a lone id to guess, and whole words of a name", () => {
    expect(guessTable(rankTables(["id", "a", "b", "c"], "data.csv", tables))).toBeUndefined();
    const logs = [{ key: "public.log", name: "log", columns: ["at"], primaryKey: [] }];
    expect(guessTable(rankTables(["x"], "catalog.csv", logs))).toBeUndefined();
    expect(guessTable(rankTables(["x"], "log-2026.csv", logs))?.key).toBe("public.log");
  });

  it("guesses nothing when nothing fits", () => {
    expect(guessTable(rankTables(["a", "b"], "data.csv", tables))).toBeUndefined();
    expect(guessTable([])).toBeUndefined();
  });

  it("counts a header-less file as matching nothing", () => {
    const ranked = rankTables(["1", "Ada", "ada@example.com"], "people.csv", tables);
    expect(ranked.every((m) => m.matched === 0)).toBe(true);
  });
});
