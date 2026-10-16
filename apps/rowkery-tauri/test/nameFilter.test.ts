// A picker's filter (nameFilter.ts): what was typed exactly comes first, so ↵
// takes it, then prefixes, then the rest, each in list order (the ⇧⌘D picker).
import { test } from "vitest";
import assert from "node:assert/strict";
import { filterByName } from "../src/nameFilter";

const dbs = ["analytics", "rowkery_e2e_orders", "rowkery", "rowkery_e2e", "postgres", "orders_rowkery_e2e"];
const names = (q: string) => filterByName(dbs, q, (d) => d);

test("the exact name comes first, then names that start with it, then the rest", () => {
  assert.deepEqual(names("rowkery_e2e"), ["rowkery_e2e", "rowkery_e2e_orders", "orders_rowkery_e2e"]);
  assert.deepEqual(names("rowkery"), ["rowkery", "rowkery_e2e_orders", "rowkery_e2e", "orders_rowkery_e2e"]);
});

test("any case, trimmed; no query keeps the list as it is", () => {
  assert.deepEqual(names("  POST "), ["postgres"]);
  assert.deepEqual(names(""), dbs);
  assert.deepEqual(names("nothing"), []);
});
