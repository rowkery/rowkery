import { describe, expect, it } from "vitest";
import { applyTableCounts } from "../src/rowCounts";
import type { SchemaCatalog } from "../src/types";

const catalog: SchemaCatalog = {
  databases: [
    {
      name: "main",
      schemas: [
        {
          name: "main",
          tables: [
            { name: "items", row_estimate: "Unknown" },
            { name: "big", row_estimate: "Unknown" },
            { name: "v", kind: "view", row_estimate: "Unknown" },
          ],
        },
      ],
    },
  ],
} as SchemaCatalog;

describe("applyTableCounts", () => {
  it("fills counted tables and leaves the rest", () => {
    const next = applyTableCounts(catalog, [
      { database: "main", table: "items", rows: { Exact: 2 } },
      { database: "main", table: "big", rows: "Unknown" },
      { database: "other", table: "v", rows: { Exact: 9 } },
    ]);
    const tables = next.databases[0].schemas[0].tables;
    expect(tables.map((t) => t.row_estimate)).toEqual([{ Exact: 2 }, "Unknown", "Unknown"]);
    // Untouched tables keep their identity (memoized rows don't re-render).
    expect(tables[1]).toBe(catalog.databases[0].schemas[0].tables[1]);
  });

  it("returns the same catalog when nothing changes", () => {
    expect(applyTableCounts(catalog, [])).toBe(catalog);
    expect(applyTableCounts(catalog, [{ database: "main", table: "big", rows: "Unknown" }])).toBe(catalog);
  });
});
