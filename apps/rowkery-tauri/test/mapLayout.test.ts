import { describe, expect, it } from "vitest";
import { buildSchemaTree } from "../src/schemaTree";
import { layoutSchemaMap, rowY, stepFrom } from "../src/mapLayout";
import type { ForeignKeyNode, SchemaCatalog, TableNode } from "../src/types";

const fk = (columns: string[], ref_table: string, ref_columns = ["id"], on_delete = "NO ACTION"): ForeignKeyNode => ({
  name: `${columns.join("_")}_${ref_table}_fkey`,
  columns,
  ref_schema: "public",
  ref_table,
  ref_columns,
  on_delete,
});

const table = (name: string, columns: string[], foreign_keys: ForeignKeyNode[] = [], primary_key = ["id"]): TableNode => ({
  name,
  kind: "table",
  columns: columns.map((c) => ({ name: c, type_name: c === "created_at" ? "timestamp with time zone" : "bigint", nullable: false })),
  primary_key,
  foreign_keys,
  row_estimate: { Approximate: 10 },
});

const shop = (tables: TableNode[]) =>
  buildSchemaTree({ databases: [{ name: "shop", schemas: [{ name: "public", tables }] }] } as unknown as SchemaCatalog);

const SHOP = shop([
  table("customers", ["id", "name"]),
  table("addresses", ["id", "customer_id", "street"], [fk(["customer_id"], "customers")]),
  table("orders", ["id", "customer_id", "address_id", "total", "created_at"], [fk(["customer_id"], "customers", ["id"], "CASCADE"), fk(["address_id"], "addresses")]),
  table("order_items", ["id", "order_id", "product_id"], [fk(["order_id"], "orders"), fk(["product_id"], "products")]),
  table("payments", ["id", "order_id"], [fk(["order_id"], "orders")]),
  table("products", ["id", "category_id"], [fk(["category_id"], "categories")]),
  table("categories", ["id"]),
  table("lonely", ["id", "note"]),
]);

const at = (layout: ReturnType<typeof layoutSchemaMap>, name: string) => layout!.boxes.find((b) => b.table.name === name);

describe("schema map layout", () => {
  it("puts what the table points to on the left and what points to it on the right", () => {
    const m = layoutSchemaMap(SHOP, "shop.public.orders", 1)!;
    expect(m.boxes.map((b) => [b.table.name, b.col]).sort()).toEqual([
      ["addresses", -1],
      ["customers", -1],
      ["order_items", 1],
      ["orders", 0],
      ["payments", 1],
    ]);
    expect(m.pointsTo).toBe(2);
    expect(m.pointedFrom).toBe(2);
    // Lines out of orders' key columns, in its column order, decide the left column's order.
    const left = m.boxes.filter((b) => b.col === -1).sort((a, b) => a.y - b.y).map((b) => b.table.name);
    expect(left).toEqual(["customers", "addresses"]);
  });

  it("lists key columns only, in the table's order", () => {
    const m = layoutSchemaMap(SHOP, "shop.public.orders", 1)!;
    expect(at(m, "orders")!.columns.map((c) => `${c.kind}:${c.name}`)).toEqual(["pk:id", "fk:customer_id", "fk:address_id"]);
    expect(at(m, "customers")!.columns.map((c) => c.name)).toEqual(["id"]);
  });

  it("reaches two steps, dimming the second, and marks each end", () => {
    const m = layoutSchemaMap(SHOP, "shop.public.order_items", 2)!;
    expect(at(m, "orders")!.dist).toBe(1);
    expect(at(m, "customers")!.dist).toBe(2);
    expect(at(m, "customers")!.col).toBe(-2);
    // Each side goes one way: payments points at orders, but not up from order_items.
    expect(at(m, "payments")).toBeUndefined();
    expect(at(m, "lonely")).toBeUndefined();
    expect(m.edges.every((e) => e.childEnd === "n")).toBe(true);
    expect(layoutSchemaMap(SHOP, "shop.public.order_items", "all")!.boxes).toHaveLength(6);
    expect(layoutSchemaMap(SHOP, "shop.public.categories", "all")!.boxes.map((b) => b.col).sort()).toEqual([0, 1, 2]);
  });

  it("leaves out a line between two boxes of one column", () => {
    // orders points at customers and at addresses, which points at customers too.
    const m = layoutSchemaMap(SHOP, "shop.public.orders", 1)!;
    expect(m.edges.some((e) => e.from === "shop.public.addresses")).toBe(false);
    expect(at(m, "addresses")!.columns.map((c) => `${c.kind}:${c.name}`)).toEqual(["pk:id", "fk:customer_id"]);
  });

  it("loops a self-reference and lists every column of a composite key", () => {
    const tree = shop([
      table("employees", ["id", "manager_id"], [fk(["manager_id"], "employees")]),
      table("grades", ["year", "term", "label"], [], ["year", "term"]),
      table("results", ["id", "year", "term"], [fk(["year", "term"], "grades", ["year", "term"])]),
      table("badges", ["employee_id", "label"], [fk(["employee_id"], "employees")], ["employee_id"]),
    ]);
    const self = layoutSchemaMap(tree, "shop.public.employees", 1)!;
    const loop = self.edges.find((e) => e.from === e.to)!;
    expect(loop.fk.columns).toEqual(["manager_id"]);
    // A key that is the child's whole primary key is one-to-one.
    expect(self.edges.find((e) => e.from === "shop.public.badges")!.childEnd).toBe("1");
    const comp = layoutSchemaMap(tree, "shop.public.results", 1)!;
    expect(at(comp, "results")!.columns.map((c) => c.name)).toEqual(["id", "year", "term"]);
    expect(at(comp, "grades")!.columns.map((c) => c.name)).toEqual(["year", "term"]);
  });

  it("reads SQLite's blank target columns as the parent's primary key", () => {
    const tree = shop([table("parents", ["id"]), table("kids", ["id", "parent_id"], [fk(["parent_id"], "parents", [""])])]);
    const m = layoutSchemaMap(tree, "shop.public.kids", 1)!;
    expect(m.edges[0].refColumns).toEqual(["id"]);
    const parent = at(m, "parents")!;
    expect(rowY(parent, "id")).toBeGreaterThan(parent.y);
  });

  it("shows a table with no keys alone, and nothing for a table it doesn't know", () => {
    const m = layoutSchemaMap(SHOP, "shop.public.lonely", 2)!;
    expect(m.boxes).toHaveLength(1);
    expect(m.edges).toHaveLength(0);
    expect(layoutSchemaMap(SHOP, "shop.public.gone", 1)).toBeNull();
  });

  it("moves between boxes with the arrow keys", () => {
    const m = layoutSchemaMap(SHOP, "shop.public.orders", 1)!;
    const key = (name: string) => at(m, name)!.key;
    expect([key("order_items"), key("payments")]).toContain(stepFrom(m.boxes, key("orders"), "ArrowRight"));
    expect(stepFrom(m.boxes, key("customers"), "ArrowDown")).toBe(key("addresses"));
    expect(stepFrom(m.boxes, key("customers"), "ArrowUp")).toBeNull();
    expect(stepFrom(m.boxes, key("customers"), "ArrowLeft")).toBeNull();
  });
});
