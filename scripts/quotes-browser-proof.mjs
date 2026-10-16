#!/usr/bin/env node
// Auto-closing quotes proof without a Tauri webview or Postgres: serves the
// Vite frontend, stubs `window.__TAURI_INTERNALS__.invoke` with a catalog,
// types into the editor in Chromium, checks what each step inserted and
// writes screenshots.
//
//   cd apps/rowkery-tauri && npx vite --port 1420 &
//   node scripts/quotes-browser-proof.mjs [outDir]
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

const OUT = process.argv[2] ?? "/tmp/rowkery-proof/quotes";
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

// Typing ' pairs, the closing ' steps over, Backspace removes an empty pair.
await clear();
await page.keyboard.type("select '", { delay: 20 });
assert.equal(await value(), "select ''");
await page.keyboard.type("ab'", { delay: 20 });
assert.equal(await value(), "select 'ab'");
await page.keyboard.type(", \"", { delay: 20 });
assert.equal(await value(), "select 'ab', \"\"");
await page.keyboard.press("Backspace");
assert.equal(await value(), "select 'ab', ");
// Apostrophes inside words and quotes in comments stay single.
await clear();
await page.keyboard.type("select don't", { delay: 20 });
assert.equal(await value(), "select don't");
await clear();
await page.keyboard.type("-- it's", { delay: 20 });
assert.equal(await value(), "-- it's");
// A selection is wrapped, and Undo takes the pair back.
await clear();
await page.keyboard.type("abc", { delay: 20 });
await page.keyboard.press("ControlOrMeta+A");
await page.keyboard.type("'");
assert.equal(await value(), "'abc'");
await page.keyboard.press("ControlOrMeta+Z");
assert.equal(await value(), "abc");
await shot("1-quotes");
assert.deepEqual(errors, []);
await browser.close();
console.log("quotes proof: all checks passed");
