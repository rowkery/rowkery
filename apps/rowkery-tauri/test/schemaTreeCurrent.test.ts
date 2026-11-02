import { describe, expect, it } from "vitest";
import { buildSchemaTree } from "../src/schemaTree";
import type { SchemaCatalog } from "../src/types";

const table = (name: string) => ({ name, kind: "table", columns: [] });
// A MySQL server: its databases are schemas of the catalog "def".
const catalog = {
  databases: [
    {
      name: "def",
      schemas: [
        { name: "app", tables: [table("users")] },
        { name: "rowkery", tables: [] },
        { name: "shop", tables: [table("orders")] },
      ],
    },
  ],
} as unknown as SchemaCatalog;

describe("a MySQL window's default database", () => {
  it("comes first and is marked, even with no tables", () => {
    const tree = buildSchemaTree(catalog, "rowkery");
    expect(tree.map((s) => [s.schema, !!s.current])).toEqual([
      ["rowkery", true],
      ["app", false],
      ["shop", false],
    ]);
  });

  it("leaves the order alone without one", () => {
    expect(buildSchemaTree(catalog).map((s) => s.schema)).toEqual(["app", "rowkery", "shop"]);
    expect(buildSchemaTree(catalog, "gone").some((s) => s.current)).toBe(false);
  });
});
