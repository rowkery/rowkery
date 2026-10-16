#!/usr/bin/env node
// Editor autocomplete proof without a Tauri webview or Postgres: serves the
// Vite frontend, stubs `window.__TAURI_INTERNALS__.invoke` with a catalog,
// types into the editor in Chromium, checks what each step inserted and
// writes screenshots.
//
//   cd apps/rowkery-tauri && npx vite --port 1420 &
//   node scripts/autocomplete-browser-proof.mjs [outDir]
//
// Needs the `playwright` package (global install is fine) and a Chromium it can
// launch (PLAYWRIGHT_BROWSERS_PATH or /opt/pw-browsers/chromium).
import { createRequire } from "node:module";
import { mkdirSync } from "node:fs";
import { execSync } from "node:child_process";
import assert from "node:assert/strict";

// run_query answers stream as frames (src-tauri `Frame`); the stub keeps returning results.
const FRAMES_SHIM = new globalThis.URL("./lib/frames-shim.js", import.meta.url).pathname;

const require = createRequire(import.meta.url);
let playwright;
try {
  playwright = require("playwright");
} catch {
  const root = execSync("npm root -g").toString().trim();
  playwright = require(`${root}/playwright`);
}

const OUT = process.argv[2] ?? "/tmp/rowkery-proof/autocomplete";
const URL = process.env.ROWKERY_DEV_URL ?? "http://localhost:1420/";
mkdirSync(OUT, { recursive: true });

function stubTauri() {
  const col = (name, type_name, extra = {}) => ({ name, type_name, nullable: true, ...extra });
  const table = (name, rows, columns, extra = {}) => ({
    name,
    kind: "table",
    columns,
    primary_key: ["id"],
    indexes: [],
    indexes_deferred: true,
    row_estimate: { Approximate: rows },
    foreign_keys: [],
    table_bytes: rows * 120,
    partition_of: null,
    ...extra,
  });
  const fk = (columns, ref_table) => ({
    name: `${ref_table}_fk`,
    columns,
    ref_schema: "public",
    ref_table,
    ref_columns: ["id"],
    on_delete: "NO ACTION",
  });
  const id = col("id", "bigint", { nullable: false });
  const tables = [
    table("customers", 48_210, [id, col("name", "text"), col("email", "character varying(255)"), col("created_at", "timestamp with time zone")]),
    table("entities", 48_000, [id, col("name", "text"), col("country", "text")]),
    table("entity_api_keys", 310, [id, col("entity_id", "bigint"), col("key", "text")], { foreign_keys: [fk(["entity_id"], "entities")] }),
    table("entity_credit_limit_transactions", 1_200_000, [id, col("entity_id", "bigint"), col("amount", "numeric")], { foreign_keys: [fk(["entity_id"], "entities")] }),
    table("entity_credit_limits", 2_100, [id, col("entity_id", "bigint"), col("limit_cents", "bigint")], { foreign_keys: [fk(["entity_id"], "entities")] }),
    table("entity_user_api_keys", 2_100, [id, col("entity_id", "bigint")], { foreign_keys: [fk(["entity_id"], "entities")] }),
    table("entity_whitelists", 95, [id, col("entity_id", "bigint"), col("cidr", "inet")], { foreign_keys: [fk(["entity_id"], "entities")] }),
    table("identity_providers", 4, [id, col("name", "text")]),
    table(
      "orders",
      912_000,
      [
        id,
        col("customer_id", "bigint", { nullable: false }),
        col("status", "order_status", { nullable: false }),
        col("total_cents", "bigint"),
        col("created_at", "timestamp with time zone"),
      ],
      { foreign_keys: [fk(["customer_id"], "customers")] },
    ),
    table("order_items", 2_400_000, [id, col("order_id", "bigint"), col("sku", "text"), col("qty", "integer")], {
      foreign_keys: [fk(["order_id"], "orders")],
    }),
  ];
  const catalog = {
    search_path: ["public"],
    enums: [{ schema: "public", name: "order_status", labels: ["pending", "paid", "shipped", "refunded"] }],
    functions: [{ schema: "public", name: "order_total", args: "order_id bigint", returns: "numeric" }],
    databases: [{ name: "shop", schemas: [{ name: "public", tables }] }],
  };
  const connections = [
    { kind: "postgres", id: "pg-docker-test", name: "shop-prod", host: "127.0.0.1", port: 54329, database: "shop", username: "rowkery" },
  ];
  localStorage.setItem(
    "rowkery.history.pg-docker-test",
    JSON.stringify([
      { sql: "select * from entity_credit_limits where entity_id = 7", at: Date.now() - 3600e3 },
      { sql: "select * from entity_credit_limits order by id desc", at: Date.now() - 7200e3 },
    ]),
  );
  const result = {
    columns: [{ name: "?column?", type_name: "int4" }],
    rows: [[{ Int: 1 }]],
    row_count: 1,
    elapsed_ms: 3,
    error: null,
    cancelled: false,
  };
  window.__ROWKERY_CALLS__ = [];
  window.__TAURI_INTERNALS__ = {
    metadata: { currentWindow: { label: "main" }, currentWebview: { label: "main" } },
    transformCallback: () => 0,
    invoke: async (cmd, args) => {
      window.__ROWKERY_CALLS__.push([cmd, args]);
      switch (cmd) {
        case "list_connections":
          return { connections, active_connection_id: null };
        case "open_window":
          return { database: "shop", catalog, server_version: "16.4", elapsed_ms: 9 };
        case "reload_window_schema":
          return catalog;
        case "list_databases":
          return [];
        case "browse_table_sql":
          return `SELECT * FROM ${args.schema}.${args.table}\nLIMIT 100;`;
        case "table_indexes":
          return args.tables.map((t) => ({
            schema: args.schema,
            table: t,
            index_bytes: 49152,
            indexes: [
              { name: `${t}_pkey`, columns: ["id"], unique: true, primary: true, method: "btree", size_bytes: 16384, scans: 120 },
              { name: `${t}_created_at_idx`, columns: ["created_at"], unique: false, method: "btree", size_bytes: 32768, scans: 0 },
            ],
          }));
        case "run_query":
          return result;
        default:
          return null;
      }
    },
  };
}

const browser = await playwright.chromium.launch({
  executablePath: process.env.CHROMIUM_PATH ?? "/opt/pw-browsers/chromium",
});
const page = await browser.newPage({ viewport: { width: 1280, height: 800 }, deviceScaleFactor: 2 });
const errors = [];
page.on("pageerror", (e) => errors.push(e.message));
await page.addInitScript({ path: FRAMES_SHIM });
await page.addInitScript(stubTauri);
await page.goto(URL);
await page.waitForSelector('[data-testid="workspace"]:not([hidden])'); // Paper (2026-10-10): an empty window shows no connection chip (no tab row without a connection); wait for the window, then ⇧⌘O as before.
// Connect with ⇧⌘O → Enter, like a user would.
await page.keyboard.press("Control+Shift+O");
await page.waitForSelector('[data-testid="conn-popover"]');
await page.keyboard.press("Enter");
await page.waitForSelector('[data-testid="sb-scroll"]');
await page.waitForTimeout(400);

const shot = async (name) => {
  await page.waitForTimeout(200);
  await page.screenshot({ path: `${OUT}/${name}.png` });
  console.log(`${OUT}/${name}.png`);
};
const editor = page.locator('textarea[data-testid="sql-editor"]');
const value = () => editor.inputValue();
const labels = () => page.locator('[data-testid="ac-row"] [data-testid="ac-label"]').allTextContents();
const popupOpen = async () => (await page.locator('[data-testid="ac-popup"]').count()) > 0;
const clear = async () => {
  await editor.click();
  await page.keyboard.press("ControlOrMeta+A");
  await page.keyboard.press("Delete");
};
const calls = (cmd) => page.evaluate((c) => window.__ROWKERY_CALLS__.filter(([n]) => n === c).length, cmd);

// 1. FROM: only relations, frequent ones first, no keywords / pg_catalog.
await clear();
await page.keyboard.type("select * from enti", { delay: 30 });
await page.waitForSelector('[data-testid="ac-popup"]');
let got = await labels();
assert.equal(got[0], "entity_credit_limits", `history boost: ${got}`);
assert.ok(got.includes("entities") && !got.includes("identity_providers"), `${got}`);
await shot("1-from-tables");
await page.keyboard.press("ArrowDown");
await page.keyboard.press("Enter");
assert.equal(await value(), "select * from entities");

// 2. JOIN: tables linked by a foreign key first.
await clear();
await page.keyboard.type("select * from orders o\njoin c", { delay: 30 });
await page.waitForSelector('[data-testid="ac-popup"]');
got = await labels();
assert.equal(got[0], "customers", `${got}`);
await shot("2-join-fk-first");
await page.keyboard.press("Enter");

// 3. ON: the whole condition from the foreign key (⌃Space with nothing typed).
await page.keyboard.type(" c on ", { delay: 30 });
await page.keyboard.press("Control+Space");
await page.waitForSelector('[data-testid="ac-popup"]');
got = await labels();
assert.equal(got[0], "c.id = o.customer_id", `${got}`);
await shot("3-on-condition");
await page.keyboard.press("Tab");
assert.equal(await value(), "select * from orders o\njoin customers c on c.id = o.customer_id");

// 4. alias. lists that table's columns with types and key icons.
await page.keyboard.type("\nwhere o.", { delay: 30 });
await page.waitForSelector('[data-testid="ac-popup"]');
got = await labels();
assert.deepEqual(got, ["id", "customer_id", "status", "total_cents", "created_at"]);
await shot("4-alias-columns");
await page.keyboard.type("st", { delay: 30 });
await page.keyboard.press("Enter");

// 5. Enum labels inside the string.
await page.keyboard.type(" = '", { delay: 30 });
await page.waitForSelector('[data-testid="ac-popup"]');
got = await labels();
assert.deepEqual(got, ["pending", "paid", "shipped", "refunded"]);
await shot("5-enum-values");
await page.keyboard.press("ArrowDown");
await page.keyboard.press("Enter");
assert.ok((await value()).endsWith("where o.status = 'paid'"), await value());

// 6. Esc closes the list; Enter with no list is a newline.
await clear();
await page.keyboard.type("select * from ord", { delay: 30 });
await page.waitForSelector('[data-testid="ac-popup"]');
await page.keyboard.press("Escape");
assert.equal(await popupOpen(), false);
await page.keyboard.press("Enter");
assert.equal(await value(), "select * from ord\n");

// 7. Tab after * spells out the columns.
await clear();
await page.keyboard.type("select * from customers", { delay: 10 });
await page.keyboard.press("Escape");
for (let i = 0; i < " from customers".length; i++) await page.keyboard.press("ArrowLeft");
await page.keyboard.press("Tab");
assert.equal(await value(), "select id, name, email, created_at from customers");

// 8. Keyword completion in the typed case; ⌘↵ still runs with the list open.
await clear();
await page.keyboard.type("SEL", { delay: 30 });
await page.waitForSelector('[data-testid="ac-popup"]');
assert.deepEqual(await labels(), ["SELECT"]);
await page.keyboard.press("Enter");
await page.keyboard.type(" 1", { delay: 30 });
const runsBefore = await calls("run_query");
await page.keyboard.press("Control+Enter");
await page.waitForTimeout(200);
assert.equal(await calls("run_query"), runsBefore + 1);

// 9. DDL reloads the schema in the background, without re-opening the
// window (that would close its query tabs' sessions).
const opensBefore = await calls("open_window");
const reloadsBefore = await calls("reload_window_schema");
await clear();
await page.keyboard.type("create table coupons (id bigint primary key)", { delay: 5 });
await page.keyboard.press("Escape");
await page.keyboard.press("Control+Enter");
await page.waitForTimeout(400);
assert.equal(await calls("reload_window_schema"), reloadsBefore + 1);
assert.equal(await calls("open_window"), opensBefore);

// 10. Structure fetches index details when it opens.
await page.locator('[data-testid="sb-scroll"] [data-table$=".orders"] [data-testid="sb-row-main"]').first().click();
await page.waitForTimeout(300);
await page.keyboard.press("Control+Alt+2");
await page.waitForSelector('[data-testid="ts-root"]');
await page.waitForTimeout(300);
const ixCalls = await page.evaluate(() => window.__ROWKERY_CALLS__.filter(([n]) => n === "table_indexes").map(([, a]) => a));
assert.deepEqual(ixCalls.at(-1), { windowId: ixCalls.at(-1).windowId, schema: "public", tables: ["orders"] });
assert.ok((await page.locator('[data-testid="ts-index"]').count()) === 2);
await shot("6-structure-indexes");

// 11. Keywords rank by what you run: SELECT above SET on a fresh install,
// FROM from one letter after a few runs, and the counts survive a relaunch.
// The sidebar click above opened orders in its own table tab, whose editor is
// a WHERE filter line (columns and functions, no statement keywords), so go
// back to the query tab first.
await page.locator('[data-testid="workspace"]:not([hidden]) [data-testid="query-tab"][data-reorder-key]').first().click();
await page.waitForTimeout(200);
await clear();
await page.keyboard.type("s", { delay: 30 });
await page.waitForSelector('[data-testid="ac-popup"]');
assert.equal((await labels())[0], "select", `fresh install: ${await labels()}`);
await clear();
await page.keyboard.type("select * f", { delay: 30 });
await page.waitForTimeout(150);
assert.ok(!(await labels()).includes("from"), "FROM needs two letters before you've used it");
for (let i = 0; i < 3; i++) {
  await clear();
  await page.keyboard.type(`select * from orders where id = ${i}`, { delay: 2 });
  await page.keyboard.press("Escape");
  await page.keyboard.press("Control+Enter");
  await page.waitForTimeout(250);
}
await page.reload();
await page.waitForSelector('[data-testid="sb-scroll"]');
await page.waitForTimeout(400);
await clear();
await page.keyboard.type("select * f", { delay: 30 });
await page.waitForSelector('[data-testid="ac-popup"]');
got = await labels();
assert.equal(got[0], "from", `after three runs: ${got}`);
await shot("7-keyword-habits");

assert.deepEqual(errors, []);
console.log("autocomplete proof: all checks passed");
await browser.close();
