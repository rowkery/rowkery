// Editor autocomplete (`sqlComplete.ts`, `completionIndex.ts`): one case per
// caret context, on a small fixture catalog.
// @ts-nocheck -- fixtures are partial catalog objects
import { test } from "vitest";
import assert from "node:assert/strict";
import { complete, expandStar, matchName, keywordsIn } from "../src/sqlComplete";
import { buildCompletionIndex, usageFromHistory } from "../src/completionIndex";

const col = (name, type_name = "text", extra = {}) => ({ name, type_name, nullable: true, ...extra });
const table = (name, columns, extra = {}) => ({
  name,
  kind: "table",
  columns,
  primary_key: ["id"],
  indexes: [],
  row_estimate: { Approximate: extra.rows ?? 100 },
  foreign_keys: [],
  ...extra,
});
const fk = (columns, ref_table, ref_columns = ["id"], ref_schema = "public") => ({
  name: `${ref_table}_fk`,
  columns,
  ref_schema,
  ref_table,
  ref_columns,
  on_delete: "NO ACTION",
});

const catalog = {
  search_path: ["public"],
  enums: [{ schema: "public", name: "order_status", labels: ["open", "paid", "cancelled"] }],
  functions: [{ schema: "public", name: "order_total", args: "order_id bigint", returns: "numeric" }],
  databases: [
    {
      name: "shop",
      schemas: [
        {
          name: "public",
          tables: [
            table("customers", [col("id", "bigint"), col("name"), col("email")], { rows: 48_000 }),
            table(
              "orders",
              [
                col("id", "bigint"),
                col("customer_id", "bigint"),
                col("status", "order_status", { nullable: false }),
                col("total", "numeric"),
                col("created_at", "timestamp with time zone"),
              ],
              { foreign_keys: [fk(["customer_id"], "customers")], rows: 900_000 },
            ),
            table(
              "order_items",
              [col("id", "bigint"), col("order_id", "bigint"), col("product", "text"), col("qty", "integer", { nullable: false })],
              { foreign_keys: [fk(["order_id"], "orders")] },
            ),
            table("entities", [col("id", "bigint"), col("name")], { rows: 48_000 }),
            table("entity_api_keys", [col("id", "bigint"), col("entity_id", "bigint")], { rows: 310 }),
            table("entity_credit_limits", [col("id", "bigint"), col("entity_id", "bigint")], { rows: 20 }),
            table("identity_map", [col("id", "bigint")]),
            table("events", [col("id", "bigint"), col("kind")], { rows: 0 }),
            table("events_p0", [], { partition_of: "events", rows: 5000 }),
            table("active_customers", [col("id", "bigint"), col("name")], { kind: "view", row_estimate: "Unknown" }),
          ],
        },
        {
          name: "sales",
          tables: [table("invoices", [col("id", "bigint"), col("amount", "numeric")])],
        },
      ],
    },
  ],
};

const index = buildCompletionIndex(catalog, "postgres");
const none = new Map();

/** Completions at the `|` in `sql`. */
function at(sql, opts = {}, usage = none) {
  const caret = sql.indexOf("|");
  const text = sql.slice(0, caret) + sql.slice(caret + 1);
  return complete(text, caret, index, usage, opts);
}
const labels = (sql, opts, usage) => at(sql, opts, usage)?.items.map((i) => i.label) ?? [];

test("matching: prefixes, words inside names, word starts; no mid-word hits", () => {
  assert.ok(matchName("entities", "enti") > matchName("entity_api_keys", "enti"));
  assert.ok(matchName("entity_credit_limits", "limits") > 0);
  assert.ok(matchName("entity_credit_limits", "ecl") > 0);
  assert.equal(matchName("identity_map", "enti"), -1);
});

test("FROM offers only relations, not keywords or pg_catalog", () => {
  const got = labels("select * from enti|");
  assert.deepEqual(got, ["entities", "entity_api_keys", "entity_credit_limits"]);
});

test("FROM ranks tables you run more often first", () => {
  const usage = usageFromHistory([
    { sql: "select * from entity_credit_limits", at: Date.now() },
    { sql: "select * from entity_credit_limits where id = 1", at: Date.now() },
  ]);
  assert.equal(labels("select * from enti|", {}, usage)[0], "entity_credit_limits");
});

test("partitions are not suggested, their parent is", () => {
  const got = labels("select * from even|");
  assert.deepEqual(got, ["events"]);
});

test("schema. lists that schema's relations and inserts bare names", () => {
  const r = at("select * from sales.|");
  assert.deepEqual(r.items.map((i) => i.insert), ["invoices"]);
});

test("a table outside the search path inserts qualified", () => {
  const r = at("select * from invo|");
  assert.equal(r.items[0].insert, "sales.invoices");
});

test("SELECT list sees tables named after the caret", () => {
  const got = labels("select cust| from orders o");
  assert.equal(got[0], "customer_id");
});

test("alias. gives that table's columns only", () => {
  const got = labels("select o.| from orders o join customers c on c.id = o.customer_id");
  assert.deepEqual(got, ["id", "customer_id", "status", "total", "created_at"]);
});

test("JOIN puts tables linked by a foreign key first", () => {
  const r = at("select * from orders o join |", { explicit: true });
  const first = r.items.slice(0, 2).map((i) => i.label).sort();
  assert.deepEqual(first, ["customers", "order_items"]);
  assert.match(r.items.find((i) => i.label === "customers").detail, /referenced by orders/);
});

test("ON suggests the whole join condition", () => {
  const r = at("select * from orders o join customers c on |", { explicit: true });
  assert.equal(r.items[0].insert, "c.id = o.customer_id");
});

test("ON works for an incoming key too", () => {
  const r = at("select * from orders o join order_items i on |", { explicit: true });
  assert.equal(r.items[0].insert, "i.order_id = o.id");
});

test("shared column names get qualified when two tables are in scope", () => {
  const r = at("select * from orders o join customers c on c.id = o.customer_id where i|");
  const ids = r.items.filter((i) => i.label.endsWith(".id")).map((i) => i.insert).sort();
  assert.deepEqual(ids, ["c.id", "o.id"]);
});

test("WHERE: columns first, then keywords only by prefix", () => {
  const got = labels("select * from orders where st|");
  assert.equal(got[0], "status");
  assert.ok(!got.includes("identity_map"));
});

test("enum labels inside a string after =", () => {
  const r = at("select * from orders where status = '|");
  assert.deepEqual(r.items.map((i) => i.insert), ["open'", "paid'", "cancelled'"]);
});

test("enum labels in an IN list", () => {
  const got = labels("select * from orders where status in ('open', 'c|");
  assert.deepEqual(got, ["cancelled"]);
});

test("INSERT INTO t ( lists its columns, required first, skipping listed ones", () => {
  const got = labels("insert into order_items (order_id, |", { explicit: true });
  assert.equal(got[0], "qty");
  assert.ok(!got.includes("order_id"));
});

test("UPDATE … SET gives the table's columns", () => {
  assert.equal(labels("update orders set tot|")[0], "total");
});

test("statement start: statement keywords in the typed case", () => {
  assert.deepEqual(labels("sel|"), ["select"]);
  assert.deepEqual(labels("SEL|"), ["SELECT"]);
  assert.deepEqual(labels("select 1;\nupd|"), ["update"]);
});

test("common keywords first on a fresh install: SELECT above SET", () => {
  assert.deepEqual(labels("s|"), ["select", "set", "show"]);
  assert.deepEqual(labels("d|"), ["delete from", "drop"]);
});

test("keywordsIn counts each keyword once, longest phrase, statement starts apart", () => {
  const got = [...keywordsIn("select * from a left join b on a.id = b.id order by 1; update t set x = 'from'")];
  assert.deepEqual(got, ["^SELECT", "FROM", "LEFT JOIN", "ON", "ORDER BY", "^UPDATE", "SET"]);
});

test("keywords you run often rank first; SET mid-UPDATE doesn't lift the SET statement", () => {
  const habits = new Map([["^SHOW", 8], ["SET", 20]]);
  assert.equal(labels("s|", { habits })[0], "show");
  assert.deepEqual(labels("s|", { habits: new Map([["SET", 20]]) })[0], "select");
});

test("a keyword you use a lot shows from one letter, below matching columns", () => {
  assert.ok(!labels("select * f|").includes("from"));
  const habits = new Map([["FROM", 5], ["IS NULL", 5]]);
  assert.equal(labels("select * f|", { habits })[0], "from");
  const got = labels("select * from orders where status i|", { habits });
  assert.equal(got[0], "id");
  assert.ok(got.includes("is null"));
});

test("after a table, keywords need two letters (aliases are typed there)", () => {
  assert.deepEqual(labels("select * from orders o|"), []);
  assert.ok(labels("select * from orders wh|").includes("where"));
});

test("CTE names and columns resolve", () => {
  assert.ok(labels("with recent as (select id, total as amount from orders) select * from rec|").includes("recent"));
  assert.deepEqual(
    labels("with recent as (select id, total as amount from orders) select r.| from recent r"),
    ["id", "amount"],
  );
});

test("subquery columns resolve through its alias", () => {
  assert.deepEqual(labels("select s.| from (select id, name from customers) s"), ["id", "name"]);
});

test("functions: user functions and a short built-in list", () => {
  const r = at("select order_t| from orders");
  assert.equal(r.items[0].insert, "order_total()");
  assert.equal(r.items[0].caretBack, 1);
  assert.ok(labels("select coal| from orders").includes("coalesce"));
});

test("nothing inside comments, after AS, or once the name is complete", () => {
  assert.equal(at("select * from orders -- ent|"), null);
  assert.equal(at("select total as tot| from orders"), null);
  assert.equal(at("select * from entities|"), null);
});

test("quoted names complete with their quote", () => {
  const r = at('select * from "ord|');
  assert.equal(r.from, 14);
  assert.equal(r.items[0].insert, "orders");
});

test("* expands to the columns in scope", () => {
  const sql = "select * from customers";
  assert.deepEqual(expandStar(sql, 8, index), { from: 7, to: 8, insert: "id, name, email" });
  const two = "select o.* from orders o join customers c on c.id = o.customer_id";
  assert.equal(expandStar(two, 10, index).insert, "o.id, o.customer_id, o.status, o.total, o.created_at");
  assert.equal(expandStar("select count(*) from orders", 14, index), null);
});

test("a 10,000 table catalog stays under a frame per keystroke", () => {
  const big = {
    search_path: ["public"],
    databases: [
      {
        name: "big",
        schemas: [
          {
            name: "public",
            tables: Array.from({ length: 10_000 }, (_, i) =>
              table(`entity_t${i}_records`, Array.from({ length: 21 }, (_, j) => col(`col_${j}`))),
            ),
          },
        ],
      },
    ],
  };
  let t = performance.now();
  const bigIndex = buildCompletionIndex(big, "postgres");
  const build = performance.now() - t;
  for (const q of ["e", "en", "ent"]) complete(`select * from ${q}`, 14 + q.length, bigIndex, none);
  // Each keystroke's best of 5: other test files run alongside this one, and a
  // busy machine only ever adds time; a slow algorithm is slow every time.
  const best = (q: string) => {
    let min = Infinity;
    for (let i = 0; i < 5; i++) {
      t = performance.now();
      complete(`select * from ${q}`, 14 + q.length, bigIndex, none);
      min = Math.min(min, performance.now() - t);
    }
    return min;
  };
  const perKey = Math.max(...["enti", "ent9", "et9r"].map(best));
  console.log(`  10k tables: index ${build.toFixed(0)}ms, slowest keystroke ${perKey.toFixed(1)}ms`);
  assert.ok(perKey < 16, `keystroke took ${perKey}ms`);
});
