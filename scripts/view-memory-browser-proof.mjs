#!/usr/bin/env node
// Table tabs remember between tables, stubbed `invoke`: a table opened from
// the sidebar starts in the view the last table showed (Data, Structure or
// Map), and the map's reach (1 step, 2 steps, All) is one setting per
// database that survives closing and reopening a tab. Screenshots go to
// outDir, by default /tmp/rowkery-proof/view-memory.
//
//   cd apps/rowkery-tauri && npx vite --port 1420 &
//   node scripts/view-memory-browser-proof.mjs [outDir]
import { createRequire } from "node:module";
import { mkdirSync } from "node:fs";
import { execSync } from "node:child_process";

const LINUX_PLATFORM = new globalThis.URL("./lib/linux-platform.js", import.meta.url).pathname;

const require = createRequire(import.meta.url);
let playwright;
try {
  playwright = require("playwright");
} catch {
  playwright = require(`${execSync("npm root -g").toString().trim()}/playwright`);
}
const OUT = process.argv[2] ?? "/tmp/rowkery-proof/view-memory";
const URL = process.env.ROWKERY_DEV_URL ?? "http://localhost:1420/";
mkdirSync(OUT, { recursive: true });

function stubTauri(extraTables) {
  localStorage.clear();
  const col = (name, type_name = "bigint") => ({ name, type_name, nullable: false });
  const fk = (columns, ref_table, ref_columns = ["id"], on_delete = "NO ACTION") => ({
    name: `${ref_table}_${columns.join("_")}_fkey`,
    columns,
    ref_schema: "public",
    ref_table,
    ref_columns,
    on_delete,
  });
  const t = (name, rows, columns, foreign_keys = [], primary_key = ["id"]) => ({
    name,
    kind: "table",
    columns,
    primary_key,
    foreign_keys,
    indexes: [],
    row_estimate: { Approximate: rows },
    partition_of: null,
  });
  const tables = [
    t("customers", 900, [col("id"), col("name", "text"), col("email", "text")]),
    t("addresses", 1200, [col("id"), col("customer_id"), col("street", "text")], [fk(["customer_id"], "customers", ["id"], "CASCADE")]),
    t("coupons", 38, [col("id", "text"), col("percent", "integer")]),
    t(
      "orders",
      48210,
      [col("id"), col("customer_id"), col("address_id"), col("coupon_id", "text"), col("total", "numeric(12,2)"), col("created_at", "timestamp with time zone")],
      [fk(["customer_id"], "customers", ["id"], "CASCADE"), fk(["address_id"], "addresses"), fk(["coupon_id"], "coupons", ["id"], "SET NULL")],
    ),
    t("order_items", 120000, [col("id"), col("order_id"), col("product_id"), col("qty", "integer")], [fk(["order_id"], "orders", ["id"], "CASCADE"), fk(["product_id"], "products")]),
    t("payments", 51000, [col("id"), col("order_id"), col("amount", "numeric")], [fk(["order_id"], "orders")]),
    t("shipments", 47000, [col("id"), col("order_id")], [fk(["order_id"], "orders")]),
    t("refunds", 2100, [col("id"), col("order_id")], [fk(["order_id"], "orders")]),
    t("products", 3400, [col("id"), col("category_id"), col("title", "text")], [fk(["category_id"], "categories")]),
    t("categories", 64, [col("id"), col("parent_id"), col("name", "text")], [fk(["parent_id"], "categories")]),
    t("terms", 12, [col("year", "integer"), col("term", "integer"), col("label", "text")], [], ["year", "term"]),
    t("reviews", 300, [col("id"), col("order_id"), col("customer_id"), col("stars", "integer")]),
    t("grades", 800, [col("id"), col("year", "integer"), col("term", "integer")], [fk(["year", "term"], "terms", ["year", "term"])]),
    ...Array.from({ length: extraTables }, (_, i) => t(`spare_${String(i).padStart(3, "0")}`, 1, [col("id")])),
  ];
  window.__queries = [];
  let nextId = 0;
  window.__TAURI_INTERNALS__ = {
    metadata: { currentWindow: { label: "main" }, currentWebview: { label: "main" } },
    transformCallback: () => 0,
    invoke: async (cmd, args) => {
      const { onFrame, ...rest } = args ?? {};
      if (/query|browse|count/.test(cmd)) window.__queries.push(cmd);
      switch (cmd) {
        case "list_connections":
          return { connections: [{ kind: "postgres", id: "pg", name: "shop", host: "db", port: 5432, database: "shop", username: "rowkery" }], active_connection_id: null };
        case "open_window":
          return { database: "shop", catalog: { databases: [{ name: "shop", schemas: [{ name: "public", tables }] }] }, elapsed_ms: 2, cached: false, open_seq: 1 };
        case "browse_table": {
          const queryId = ++nextId;
          const tb = tables.find((x) => x.name === rest.table);
          setTimeout(() => {
            const send = (f) => onFrame.onmessage({ query_id: queryId, ...f });
            send({ t: "columns", columns: tb.columns.map((c) => ({ name: c.name, type_name: "text" })) });
            send({ t: "done", status: "ok", row_count: 0, affected_rows: null, elapsed_ms: 1, first_row_ms: 1, frames: 1, error: null, sqlstate: null, error_position: null, hold: null });
          }, 5);
          return { query_id: queryId, sql: `SELECT * FROM public.${rest.table};` };
        }
        case "count_rows":
          return 0;
        default:
          return null;
      }
    },
  };
}

const check = (cond, msg) => {
  if (!cond) {
    console.error(`FAIL: ${msg}`);
    process.exitCode = 1;
  } else console.log(`ok: ${msg}`);
};
const browser = await playwright.chromium.launch({ executablePath: process.env.CHROMIUM_PATH ?? "/opt/pw-browsers/chromium" });
const ws = '[data-testid="workspace"]:not([hidden])';
const map = `${ws} [data-testid="schema-map"]`;
const context = await browser.newContext({ viewport: { width: 1280, height: 820 }, deviceScaleFactor: 2, colorScheme: "dark" });
const page = await context.newPage();
const errors = [];
page.on("pageerror", (e) => errors.push(e.message));
await page.addInitScript({ path: LINUX_PLATFORM });
await page.addInitScript(stubTauri, 0);
await page.goto(URL);
await page.waitForSelector(ws);
await page.keyboard.press("Control+Shift+O");
await page.waitForSelector('[data-testid="conn-popover"]');
await page.keyboard.press("Enter");
await page.waitForSelector(`${ws}[data-conn-state="connected"]`);

const row = (name) => `${ws} [data-table="shop.public.${name}"] [data-testid="sb-row-main"]`;
const view = () => page.getAttribute(`${ws} [data-testid="view-switch"] [aria-selected="true"]`, "data-view");
const settle = () => page.waitForTimeout(250);
const tabCount = () => page.locator(`${ws} [data-testid="query-tab-close"]`).count();

// 1. The first table opens in Data; after Structure, the next ones open in Structure.
await page.click(row("orders"));
await page.waitForSelector(`${ws} [data-testid="view-switch"] [data-view="map"]`);
check((await view()) === "data", "the first table opens in Data");
await page.click(`${ws} [data-testid="view-switch"] [data-view="structure"]`);
await settle();
await page.click(row("customers"));
await settle();
check((await view()) === "structure", "a sidebar click after Structure opens the next table in Structure");
await page.click(row("payments"), { modifiers: ["Control"] });
await settle();
check((await view()) === "structure", "a table kept in its own tab opens in Structure too");

// 2. Map: the reach is one setting for the database and survives closing the tab.
await page.click(`${ws} [data-testid="view-switch"] [data-view="map"]`);
await page.waitForSelector(map);
await page.click(`${map} [data-testid="sm-depths"] [data-depth="all"]`);
await settle();
check((await page.getAttribute(map, "data-depth")) === "all", "All is picked on payments");
await page.click(row("refunds"));
await page.waitForSelector(map);
check((await page.getAttribute(map, "data-depth")) === "all", "the next table opens in Map with All");
await page.screenshot({ path: `${OUT}/1-refunds-map-all.png` });
console.log(`${OUT}/1-refunds-map-all.png`);
const before = await tabCount();
await page.keyboard.press("Control+w");
await settle();
check((await tabCount()) === before - 1, "the tab closed");
await page.click(row("refunds"));
await page.waitForSelector(map);
check((await page.getAttribute(map, "data-depth")) === "all", "reopening the table keeps All, not 1 step");
await page.click(`${map} [data-testid="sm-depths"] [data-depth="2"]`);
await settle();
await page.click(row("shipments"));
await page.waitForSelector(map);
check((await page.getAttribute(map, "data-depth")) === "2", "2 steps carries to another table of the database");
const saved = await page.evaluate(() => [localStorage.getItem("rowkery.mapDepth"), localStorage.getItem("rowkery.tableView")]);
console.log(`saved: ${saved.join(" ")}`);

// 3. Back to Data, and the next table opens in Data again.
await page.click(`${ws} [data-testid="view-switch"] [data-view="data"]`);
await settle();
await page.click(row("products"));
await settle();
check((await view()) === "data", "after Data, the next table opens in Data");
await page.screenshot({ path: `${OUT}/2-back-to-data.png` });
console.log(`${OUT}/2-back-to-data.png`);

check(errors.length === 0, `no page errors (${errors.join("; ")})`);
await browser.close();
