// The sidebar's row counts: what the window saw itself over the catalog's estimate (`withSeenCounts`).
import { describe, expect, test } from "vitest";
import { buildSchemaTree, withSeenCounts } from "../src/schemaTree";
import type { SchemaCatalog } from "../src/types";

const tree = buildSchemaTree({
  databases: [
    {
      name: "wallet",
      schemas: [
        {
          name: "public",
          tables: [
            { name: "events", row_estimate: { Approximate: 0 } },
            { name: "events_p0", partition_of: "events", row_estimate: { Approximate: 1200 } },
            { name: "kiosks", row_estimate: { Approximate: 2 } },
          ],
        },
      ],
    },
  ],
} as unknown as SchemaCatalog);

describe("withSeenCounts", () => {
  test("a seen count replaces the estimate", () => {
    const out = withSeenCounts(tree, { "wallet.public.kiosks": { rows: 0, over: 2 } });
    const kiosks = out[0].tables.find((t) => t.name === "kiosks");
    expect(kiosks?.rows).toBe(0);
    expect(out[0].tables.find((t) => t.name === "events")).toBe(tree[0].tables.find((t) => t.name === "events"));
  });

  test("partitions take their seen counts too", () => {
    const out = withSeenCounts(tree, { "wallet.public.events_p0": { rows: 3, over: 1200 } });
    expect(out[0].tables.find((t) => t.name === "events")?.partitions[0].rows).toBe(3);
  });

  test("the same tree when nothing differs", () => {
    expect(withSeenCounts(tree, {})).toBe(tree);
    expect(withSeenCounts(tree, { "wallet.public.kiosks": { rows: 2, over: 2 } })).toBe(tree);
    expect(withSeenCounts(tree, { "other.public.kiosks": { rows: 5, over: 2 } })).toBe(tree);
  });

  test("a catalog count that moved since wins", () => {
    // Seen over an estimate of 7; the catalog now says 2 (ANALYZE ran).
    expect(withSeenCounts(tree, { "wallet.public.kiosks": { rows: 0, over: 7 } })).toBe(tree);
  });
});
