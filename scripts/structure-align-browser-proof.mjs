#!/usr/bin/env node
// Structure alignment (rowkery/reports#6), stubbed `invoke`, light and dark.
// Proves: in every row of the Columns table, the first line of each cell
// (name, type, nullable, key badges) sits on one baseline, whether or not the
// name has a comment or the type a default, and the header labels share the
// columns' left edges. Index and relation rows stay within a pixel.
// Screenshots go to outDir, by default /tmp/rowkery-proof/structure-align:
// structure, structure-dark.
//
//   cd apps/rowkery-tauri && npx vite --port 1420 &
//   node scripts/structure-align-browser-proof.mjs [outDir]
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
const OUT = process.argv[2] ?? "/tmp/rowkery-proof/structure-align";
const URL = process.env.ROWKERY_DEV_URL ?? "http://localhost:1420/";
mkdirSync(OUT, { recursive: true });

function stubTauri() {
  localStorage.clear();
  const col = (name, type_name, extra = {}) => ({ name, type_name, nullable: true, ...extra });
  const ix = (name, columns, extra = {}) => ({ name, columns, unique: false, primary: false, method: "btree", size_bytes: 16384, scans: 12, ...extra });
  const orders = {
    name: "orders",
    kind: "table",
    comment: "One row per checkout",
    columns: [
      col("id", "bigint", { nullable: false, default: "nextval('orders_id_seq'::regclass)" }),
      col("customer_id", "bigint", { nullable: false }),
      col("email", "character varying(255)", { comment: "Copied from the customer at checkout" }),
      col("status", "text", { nullable: false, default: "'pending'::text" }),
      col("total", "numeric(12,2)"),
      col("note", "text"),
      col("created_at", "timestamp with time zone", { nullable: false, default: "now()" }),
    ],
    primary_key: ["id"],
    indexes: [
      ix("orders_pkey", ["id"], { unique: true, primary: true }),
      ix("orders_email_key", ["email"], { unique: true }),
      ix("orders_status_created_idx", ["status", "created_at DESC"], { scans: 0 }),
    ],
    foreign_keys: [{ name: "orders_customer_id_fkey", columns: ["customer_id"], ref_schema: "public", ref_table: "customers", ref_columns: ["id"], on_delete: "CASCADE" }],
    row_estimate: { Approximate: 48210 },
    table_bytes: 7340032,
    index_bytes: 2097152,
    partition_of: null,
  };
  const customers = {
    name: "customers",
    kind: "table",
    columns: [col("id", "bigint", { nullable: false }), col("name", "text")],
    primary_key: ["id"],
    indexes: [ix("customers_pkey", ["id"], { unique: true, primary: true })],
    foreign_keys: [],
    row_estimate: { Approximate: 900 },
    partition_of: null,
  };
  const items = {
    name: "order_items",
    kind: "table",
    columns: [col("id", "bigint", { nullable: false }), col("order_id", "bigint", { nullable: false })],
    primary_key: ["id"],
    indexes: [ix("order_items_pkey", ["id"], { unique: true, primary: true })],
    foreign_keys: [{ name: "order_items_order_id_fkey", columns: ["order_id"], ref_schema: "public", ref_table: "orders", ref_columns: ["id"], on_delete: "CASCADE" }],
    row_estimate: { Approximate: 120000 },
    partition_of: null,
  };
  const tables = [orders, customers, items];
  let nextId = 0;
  window.__TAURI_INTERNALS__ = {
    metadata: { currentWindow: { label: "main" }, currentWebview: { label: "main" } },
    transformCallback: () => 0,
    invoke: async (cmd, args) => {
      const { onFrame, ...rest } = args ?? {};
      switch (cmd) {
        case "list_connections":
          return { connections: [{ kind: "postgres", id: "pg", name: "shop", host: "db", port: 5432, database: "shop", username: "rowkery" }], active_connection_id: null };
        case "open_window":
          return { database: "shop", catalog: { databases: [{ name: "shop", schemas: [{ name: "public", tables }] }] }, elapsed_ms: 2, cached: false, open_seq: 1 };
        case "browse_table": {
          const queryId = ++nextId;
          const t = tables.find((x) => x.name === rest.table);
          setTimeout(() => {
            const send = (f) => onFrame.onmessage({ query_id: queryId, ...f });
            send({ t: "columns", columns: t.columns.map((c) => ({ name: c.name, type_name: "text" })) });
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
const context = await browser.newContext({ viewport: { width: 1180, height: 820 }, deviceScaleFactor: 2, colorScheme: "light" });
const page = await context.newPage();
const errors = [];
page.on("pageerror", (e) => errors.push(e.message));
await page.addInitScript({ path: LINUX_PLATFORM });
await page.addInitScript(stubTauri);
await page.goto(URL);

const ws = '[data-testid="workspace"]:not([hidden])';
await page.waitForSelector(ws);
await page.keyboard.press("Control+Shift+O");
await page.waitForSelector('[data-testid="conn-popover"]');
await page.keyboard.press("Enter");
await page.waitForSelector(`${ws}[data-conn-state="connected"]`);
await page.click(`${ws} [data-table="shop.public.orders"] [data-testid="sb-row-main"]`);
await page.click(`${ws} [data-testid="view-switch"] [data-view="structure"]`);
await page.waitForSelector(`${ws} [data-testid="ts-root"] [data-column="created_at"]`);
await page.waitForTimeout(400);

// The baseline of each cell's first line of text, and each cell's left edge.
const measure = () =>
  page.evaluate((ws) => {
    const firstBaseline = (cell) => {
      const walker = document.createTreeWalker(cell, NodeFilter.SHOW_TEXT, { acceptNode: (n) => (n.data.trim() ? 1 : 3) });
      const text = walker.nextNode();
      if (!text) return null;
      const range = document.createRange();
      range.setStart(text, 0);
      range.setEnd(text, 1);
      const r = range.getBoundingClientRect();
      const s = getComputedStyle(text.parentElement);
      // Baseline ≈ glyph box bottom less the descent share of the font size.
      const probe = document.createElement("span");
      probe.style.cssText = `font:${s.font};display:inline-block;width:0;height:0;vertical-align:baseline`;
      const holder = document.createElement("span");
      holder.style.cssText = `font:${s.font};line-height:normal`;
      holder.append("x", probe);
      text.parentElement.append(holder);
      const hb = holder.getBoundingClientRect();
      const pb = probe.getBoundingClientRect();
      holder.remove();
      return r.top + (pb.top - hb.top);
    };
    const root = document.querySelector(`${ws} [data-testid="ts-root"]`);
    const rows = [...root.querySelectorAll('[role="row"]'), ...root.querySelectorAll('[data-testid="ts-index"], [data-testid="ts-relation"]')];
    return rows.map((row) => {
      const cells = [...row.children];
      return {
        kind: row.getAttribute("role") === "row" ? "column" : "item",
        name: row.dataset.column ?? (row.getAttribute("role") === "row" ? "(head)" : row.title || row.textContent.slice(0, 24)),
        baselines: cells.map(firstBaseline),
        lefts: cells.map((c) => c.getBoundingClientRect().left),
      };
    });
  }, ws);

const rows = await measure();
const head = rows.find((r) => r.name === "(head)");
for (const r of rows) {
  if (r.kind === "item") {
    const b = r.baselines.filter((x) => x !== null);
    const spread = Math.max(...b) - Math.min(...b);
    check(spread < 1, `${r.name}: its parts share a baseline (spread ${spread.toFixed(2)} px)`);
    continue;
  }
  const b = r.baselines.filter((x) => x !== null);
  const spread = Math.max(...b) - Math.min(...b);
  check(spread < 0.75, `${r.name}: first lines share a baseline (spread ${spread.toFixed(2)} px: ${b.map((x) => x.toFixed(1)).join(" / ")})`);
  check(r.lefts.every((l, i) => Math.abs(l - head.lefts[i]) < 0.5), `${r.name}: cells start under their headers`);
}
const root = await page.locator(`${ws} [data-testid="ts-root"]`).boundingBox();
const clip = { x: root.x, y: root.y, width: Math.min(root.width, 900), height: Math.min(root.height, 640) };
await page.mouse.move(1, 1);
await page.screenshot({ path: `${OUT}/structure.png`, clip });
console.log(`${OUT}/structure.png`);
await page.emulateMedia({ colorScheme: "dark" });
await page.waitForFunction(() => document.documentElement.dataset.theme === "dark");
await page.waitForTimeout(300);
await page.screenshot({ path: `${OUT}/structure-dark.png`, clip });
console.log(`${OUT}/structure-dark.png`);
check(errors.length === 0, `no page errors (${errors.join("; ")})`);
await browser.close();
