// Edit access on the Agents page (`mcpAccess.ts`): Only ticked and All but
// unticked, switching between them, the old hide list, and the card's line.
import { test } from "vitest";
import assert from "node:assert/strict";
import {
  accessOf,
  accessSummary,
  defaultAccess,
  looksPersonal,
  setTables,
  sharedCount,
  tableShared,
  withMasked,
} from "../src/mcpAccess";
import type { ConnectionRecord } from "../src/types";

const pg = (over: Partial<Extract<ConnectionRecord, { kind: "postgres" }>> = {}): ConnectionRecord => ({
  kind: "postgres",
  id: "pg",
  name: "Platform API",
  host: "db",
  port: 5432,
  database: "orders",
  username: "app",
  allow_mcp: true,
  ...over,
});
const ALL = ["public.orders", "public.customers", "audit.changes"];

test("turning sharing on shares the own database with nothing ticked", () => {
  assert.deepEqual(defaultAccess(pg()), { orders: { mode: "picked", tables: [] } });
  assert.deepEqual(defaultAccess({ kind: "sqlite", id: "s", name: "s", path: "/x.db" }), {
    main: { mode: "picked", tables: [] },
  });
});

test("only ticked matches names exactly; all but unticked ignores case and takes bare names", () => {
  const picked = { mode: "picked" as const, tables: ["public.orders"] };
  assert.ok(tableShared(picked, "public.orders"));
  assert.ok(!tableShared(picked, "public.ORDERS"));
  assert.ok(!tableShared(picked, "public.customers"));
  const all = { mode: "all" as const, tables: ["Customers", "audit.CHANGES"] };
  assert.ok(tableShared(all, "public.orders"));
  assert.ok(!tableShared(all, "public.customers"));
  assert.ok(!tableShared(all, "audit.changes"));
});

test("ticks add and remove in either mode", () => {
  let picked = setTables({ mode: "picked", tables: [] }, ["public.orders", "audit.changes"], true);
  picked = setTables(picked, ["audit.changes"], false);
  assert.deepEqual(picked, { mode: "picked", tables: ["public.orders"] });
  let all = setTables({ mode: "all", tables: ["customers"] }, ["public.customers"], true);
  assert.deepEqual(all, { mode: "all", tables: [] });
  all = setTables(all, ["audit.changes"], false);
  assert.deepEqual(all, { mode: "all", tables: ["audit.changes"] });
  assert.equal(sharedCount(all, ALL), 2);
});

test("a connection saved before the map edits as every database minus its hide list", () => {
  const old = pg({ mcp_hidden_tables: ["public.customers"] });
  assert.deepEqual(accessOf(old, ["orders", "billing"]), {
    orders: { mode: "all", tables: ["public.customers"] },
    billing: { mode: "all", tables: ["public.customers"] },
  });
  assert.deepEqual(accessSummary(old), { databases: "Every database", tables: "all but 1 table" });
  const saved = pg({ mcp_access: { billing: { mode: "all" } } });
  assert.deepEqual(accessOf(saved, ["orders", "billing"]), { billing: { mode: "all" } });
});

test("the card names the shared databases and counts the tables", () => {
  assert.deepEqual(accessSummary(pg({ mcp_access: { orders: { mode: "picked", tables: [] } } })), {
    databases: "orders",
    tables: "no tables yet",
  });
  assert.deepEqual(
    accessSummary(pg({ mcp_access: { orders: { mode: "picked", tables: ["a.b", "a.c"] }, billing: { mode: "all" } } })),
    { databases: "billing, orders", tables: "2 tables, and all of billing" },
  );
});

test("column names that usually hold personal data are tagged", () => {
  for (const name of ["email", "contact_email", "Phone", "mobileNumber", "date_of_birth", "dob", "first_name", "lastName", "home_address", "iban", "ip_address", "api_key", "password_hash"]) {
    assert.equal(looksPersonal(name), true, name);
  }
  for (const name of ["id", "name", "plan", "created_at", "country", "total", "status", "card_type", "first_seen", "emailed"]) {
    assert.equal(looksPersonal(name), false, name);
  }
});

test("masked columns are kept per database, and an empty one drops out", () => {
  let m = withMasked(undefined, "app", ["public.customers.phone", "public.customers.email"], true);
  assert.deepEqual(m, { app: ["public.customers.email", "public.customers.phone"] });
  m = withMasked(m, "app", ["public.customers.email"], true);
  assert.equal(m.app.length, 2);
  m = withMasked(m, "app", ["public.customers.email", "public.customers.phone"], false);
  assert.deepEqual(m, {});
});
