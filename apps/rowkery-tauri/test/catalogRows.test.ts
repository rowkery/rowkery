// ⌘K "All tables as rows": the catalog as a result (`catalogRows.ts`).
import { describe, expect, test } from "vitest";
import { catalogResult } from "../src/catalogRows";
import { buildSchemaTree } from "../src/schemaTree";
import type { SchemaCatalog } from "../src/types";

const catalog = {
  databases: [
    {
      name: "wallet",
      schemas: [
        {
          name: "public",
          tables: [
            {
              name: "events",
              kind: "table",
              columns: [{ name: "id", type_name: "int8", nullable: false }],
              row_estimate: { Approximate: 0 },
              table_bytes: 8192,
              index_bytes: 8192,
              comment: "\nEvery event.\nPartitioned by month.",
            },
            { name: "events_p0", partition_of: "events", row_estimate: { Approximate: 1200 } },
            { name: "wallets", row_estimate: { Exact: 12 } },
            { name: "balances", kind: "materialized_view", row_estimate: "Unknown" },
          ],
        },
      ],
    },
  ],
} as unknown as SchemaCatalog;

describe("catalogResult", () => {
  test("one row per table, partition and view, with a SQL comment line", () => {
    const { result, sql } = catalogResult(buildSchemaTree(catalog));
    expect(sql).toBe("-- 4 tables and views in wallet, from the catalog");
    expect(result.columns.map((c) => c.name)).toEqual([
      "name",
      "schema",
      "kind",
      "≈ rows",
      "size",
      "columns",
      "partition of",
      "comment",
    ]);
    expect(result.row_count).toBe(4);
    const col = (c: number) => Array.from({ length: 4 }, (_, r) => result.rows.text(r, c));
    expect(col(0)).toEqual(["events", "events_p0", "wallets", "balances"]);
    expect(col(2)).toEqual(["table", "partition", "table", "mat view"]);
    expect(result.rows.text(1, 6)).toBe("events");
    expect(result.rows.isNull(3, 3)).toBe(true);
    expect(result.rows.isNull(2, 5)).toBe(true);
    expect(result.rows.text(0, 7)).toBe("Every event.");
    expect(result.rows.isNull(2, 7)).toBe(true);
  });
});
