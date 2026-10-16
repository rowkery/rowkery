// Presenting (`presenting.ts`): which of a result's columns are marked, the
// switch, and the connection line it shortens; the header menu's Mark row.
import { test } from "vitest";
import assert from "node:assert/strict";
import { connectionLine, markedNames, presentingOn, setPresenting } from "../src/presenting";
import { headerMenu } from "../src/contextMenus";
import type { ConnectionRecord } from "../src/types";

const marks = ["public.users.email", "public.users.phone", "billing.users.email", "public.orders.card", "my.schema.t.secret"];

test("a table's result matches its own schema and table", () => {
  assert.deepEqual([...markedNames(marks, { schema: "public", name: "users" })].sort(), ["email", "phone"]);
  assert.deepEqual([...markedNames(marks, { schema: "public", name: "orders" })], ["card"]);
  assert.deepEqual([...markedNames(marks, { schema: "public", name: "nothing" })], []);
});

test("any other result matches a column name marked anywhere in the database", () => {
  assert.deepEqual([...markedNames(marks, null)].sort(), ["card", "email", "phone", "secret"]);
});

test("names are read as the MCP server reads them: schema to the first dot, column from the last", () => {
  assert.deepEqual([...markedNames(marks, { schema: "my", name: "schema.t" })], ["secret"]);
  assert.deepEqual([...markedNames(["nodots", "a.b", ".t.c", "s.t."], null)], []);
});

test("the switch is off until turned on", () => {
  assert.equal(presentingOn(), false);
  setPresenting(true);
  assert.equal(presentingOn(), true);
  setPresenting(false);
  assert.equal(presentingOn(), false);
});

test("presenting keeps only the database or the file name", () => {
  const pg = { kind: "postgres", host: "db.example.com", port: 5432, database: "shop", user: "alice" } as unknown as ConnectionRecord;
  const lite = { kind: "sqlite", path: "/Users/me/data/app.sqlite" } as unknown as ConnectionRecord;
  assert.equal(connectionLine(pg, false), "db.example.com:5432/shop");
  assert.equal(connectionLine(pg, true), "shop");
  assert.equal(connectionLine(lite, true), "app.sqlite");
});

test("the header menu marks a column, or unmarks it, only where the grid can", () => {
  const base = { column: "email", sortable: false, hideable: false, sort: [], filterable: false, structure: false };
  assert.equal(headerMenu(base).some((r) => r.id === "mark"), false);
  assert.equal(headerMenu({ ...base, marked: false }).find((r) => r.id === "mark")?.label, "Mark as sensitive");
  assert.equal(headerMenu({ ...base, marked: true }).find((r) => r.id === "mark")?.label, "Unmark sensitive");
});
