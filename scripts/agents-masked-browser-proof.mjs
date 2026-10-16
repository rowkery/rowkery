#!/usr/bin/env node
// Sensitive columns on the Agents page (2026-10-15) proof with a
// stubbed Tauri `invoke`: each table row in Edit access ends in an eye
// button that opens the table's columns beside the list (orange with a count
// once a column is masked); a column row masks or unmasks its column and
// saves the connection's whole `masked_columns` map at once; names that look
// personal (email, phone, full_name) are tagged and Mask suggested masks
// them all; the column list closes with its ×, and in dark the panel keeps
// to the tokens. That agents only get stand-ins for those columns, and every
// other way of reading them is refused, is proved by `cargo test -p
// rowkery-mcp` (`--features postgres-integration` for the Postgres leak test).
//
//   cd apps/rowkery-tauri && npx vite --port 1420 &
//   node scripts/agents-masked-browser-proof.mjs [outDir]
import { createRequire } from "node:module";
import { mkdirSync } from "node:fs";
import { execSync } from "node:child_process";

const FRAMES_SHIM = new globalThis.URL("./lib/frames-shim.js", import.meta.url).pathname;

const require = createRequire(import.meta.url);
let playwright;
try {
  playwright = require("playwright");
} catch {
  const root = execSync("npm root -g").toString().trim();
  playwright = require(`${root}/playwright`);
}

const OUT = process.argv[2] ?? "/tmp/rowkery-proof/agents-masked";
const URL = process.env.ROWKERY_DEV_URL ?? "http://localhost:1420/";
mkdirSync(OUT, { recursive: true });

function stubTauri() {
  const connections = [
    {
      kind: "postgres",
      id: "api",
      name: "Platform API",
      host: "api-db.c9x.rds.amazonaws.com",
      port: 5432,
      database: "orders",
      username: "app",
      environment: "stg",
      allow_mcp: true,
      mcp_access: { orders: { mode: "picked", tables: ["public.customers", "public.orders"] } },
    },
  ];
  const col = (name, type) => ({ name, type });
  const t = (name, rows, columns) => ({ schema: "public", name, kind: "table", rows, big: rows > 100_000, columns });
  const TABLES = [
    t("api_keys", 140, [col("id", "bigint"), col("token", "text")]),
    t("customers", 61_000, [
      col("id", "bigint"),
      col("full_name", "text"),
      col("email", "citext"),
      col("phone", "text"),
      col("country", "char(2)"),
      col("plan", "plan_tier"),
      col("created_at", "timestamptz"),
    ]),
    t("orders", 84_000, [col("id", "bigint"), col("customer_id", "bigint"), col("total", "numeric(12,2)")]),
    t("products", 2_400, [col("id", "bigint"), col("name", "text")]),
  ];
  window.__ROWKERY_CALLS__ = [];
  window.__TAURI_INTERNALS__ = {
    metadata: { currentWindow: { label: "main" }, currentWebview: { label: "main" } },
    transformCallback: () => 0,
    invoke: async (cmd, args) => {
      window.__ROWKERY_CALLS__.push([cmd, args]);
      switch (cmd) {
        case "list_connections":
          return { connections: structuredClone(connections), active_connection_id: null };
        case "save_connection": {
          const i = connections.findIndex((c) => c.id === args.connection.id);
          if (i >= 0) connections[i] = args.connection;
          return null;
        }
        case "mcp_activity":
          return { entries: [], offset: 0, reset: true };
        case "mcp_pick_databases":
          return [{ name: "orders", size_bytes: 1.2 * 1024 ** 3 }];
        case "mcp_pick_tables":
          await new Promise((r) => setTimeout(r, 30));
          return structuredClone(TABLES);
        default:
          return null;
      }
    },
  };
}

const browser = await playwright.chromium.launch({
  executablePath: process.env.CHROMIUM_PATH ?? "/opt/pw-browsers/chromium",
});
const context = await browser.newContext({ viewport: { width: 1360, height: 820 }, deviceScaleFactor: 2 });
const page = await context.newPage();
page.on("pageerror", (e) => console.error("pageerror:", e.message));
await page.addInitScript({ path: FRAMES_SHIM });
await page.addInitScript(stubTauri);
await page.goto(URL);
await page.waitForSelector('[data-testid="workspace"]:not([hidden])');

let failed = 0;
const check = (ok, what) => {
  console.log(`${ok ? "ok  " : "FAIL"} ${what}`);
  if (!ok) failed++;
};
const shot = async (name) => {
  await page.waitForTimeout(250);
  await page.screenshot({ path: `${OUT}/${name}.png` });
  console.log(`${OUT}/${name}.png`);
};
const saves = () =>
  page.evaluate(() => window.__ROWKERY_CALLS__.filter(([c]) => c === "save_connection").map(([, a]) => a.connection));
const waitSaves = (n) =>
  page.waitForFunction((k) => window.__ROWKERY_CALLS__.filter(([c]) => c === "save_connection").length >= k, n, { timeout: 4000 });

await page.keyboard.press("Control+Shift+A");
await page.waitForSelector('[data-testid="agents-page"]');
await page.click('[data-mcp-edit="api"] [data-testid="mcp-cn-sub"]');
await page.waitForSelector('[data-mcp-editor="api"] [data-ag-table="public.customers"]');

// 1. Each table row ends in its columns button; nothing is open yet.
check((await page.$$("[data-ag-columns]")).length === 4, "every table has a columns button");
check(!(await page.$('[data-testid="ag-columns"]')), "no column list until one is opened");

// 2. Opening customers lists its columns beside the tables, personal ones tagged.
await page.click('[data-ag-columns="public.customers"]');
await page.waitForSelector('[data-ag-columns-of="public.customers"]');
check((await page.$$("[data-ag-col]")).length === 7, "the table's seven columns are listed");
check((await page.textContent('[data-testid="ag-masked-count"]')) === "0 masked", "0 masked");
check((await page.getAttribute('[data-ag-columns="public.customers"]', "aria-expanded")) === "true", "its button reads expanded");
// Text on purpose: the suggestion's label is what's under test.
const tagged = await page.$$eval("[data-ag-col]", (rows) =>
  rows.filter((r) => /Looks personal/.test(r.textContent)).map((r) => r.getAttribute("data-ag-col")),
);
check(JSON.stringify(tagged) === JSON.stringify(["full_name", "email", "phone"]), `names that look personal are tagged: ${tagged.join(", ")}`);
const before = (await saves()).length;

// 3. A column row masks its column and saves at once.
await page.click('[data-ag-col="email"]');
await waitSaves(before + 1);
let saved = (await saves()).at(-1);
check(
  JSON.stringify(saved.masked_columns) === JSON.stringify({ orders: ["public.customers.email"] }),
  `masking a column saves it: ${JSON.stringify(saved.masked_columns)}`,
);
check(JSON.stringify(saved.mcp_access) === JSON.stringify({ orders: { mode: "picked", tables: ["public.customers", "public.orders"] } }), "and leaves the table access as it was");
check((await page.getAttribute('[data-ag-col="email"]', "aria-checked")) === "true", "the row reads masked");
check((await page.getAttribute('[data-ag-columns="public.customers"]', "data-masked")) === "1", "the table's button counts it");
check((await page.textContent('[data-testid="ag-masked-count"]')) === "1 masked", "1 masked");

// 4. Mask suggested masks the rest that look personal.
await page.click("[data-ag-mask-suggested]");
await waitSaves(before + 2);
saved = (await saves()).at(-1);
check(
  JSON.stringify(saved.masked_columns.orders) ===
    JSON.stringify(["public.customers.email", "public.customers.full_name", "public.customers.phone"]),
  `Mask suggested masks full_name and phone too: ${JSON.stringify(saved.masked_columns.orders)}`,
);
check(!(await page.$("[data-ag-mask-suggested]")), "with nothing left to suggest, the button goes");
// Unmask one again.
await page.click('[data-ag-col="full_name"]');
await waitSaves(before + 3);
saved = (await saves()).at(-1);
check(saved.masked_columns.orders.length === 2 && !saved.masked_columns.orders.includes("public.customers.full_name"), "clicking a masked row unmasks it");
await shot("1-columns");

// 5. Nothing clipped: the panel's rows fit their column.
const clipped = await page.$$eval("[data-ag-col]", (rows) => rows.filter((r) => r.scrollWidth > r.clientWidth + 1).length);
check(clipped === 0, "no column row overflows");

// 6. Another table's button switches the list; × closes it.
await page.click('[data-ag-columns="public.orders"]');
await page.waitForSelector('[data-ag-columns-of="public.orders"]');
check(!(await page.$("[data-ag-mask-suggested]")), "orders has nothing that looks personal");
await page.click('[data-testid="ag-columns"] [aria-label="Close columns"]');
await page.waitForSelector('[data-testid="ag-columns"]', { state: "detached" });
check(true, "× closes the column list");

// 7. Dark.
await page.evaluate(() => document.documentElement.setAttribute("data-theme", "dark"));
await page.click('[data-ag-columns="public.customers"]');
await page.waitForSelector('[data-ag-columns-of="public.customers"]');
await shot("2-columns-dark");

await browser.close();
if (failed) {
  console.error(`${failed} check(s) failed`);
  process.exit(1);
}
