#!/usr/bin/env node
// Keys and pickers proof without a Tauri webview (stubbed `invoke`), macOS
// keys: ⌃⌘F is left to macOS (full screen) on query and table tabs, where ⌘F
// opens Find or the filter; ⌥⌘↵ runs every statement, from the editor too;
// in the ⇧⌘D picker, typing puts the cursor on the best match, so ↵ switches
// to what was typed (it used to stay on the current database). ⇧⌘O and ⇧⌘D
// focus their list before the next frame, so a key typed right after lands in it.
//
//   cd apps/rowkery-tauri && npx vite --port 1420 &
//   node scripts/keys-and-pickers-browser-proof.mjs [outDir]
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

const OUT = process.argv[2] ?? "/tmp/rowkery-proof/keys-and-pickers";
const URL = process.env.ROWKERY_DEV_URL ?? "http://localhost:1420/";
mkdirSync(OUT, { recursive: true });

function stubTauri() {
  Object.defineProperty(Navigator.prototype, "platform", { get: () => "MacIntel" });
  const connections = [
    { kind: "postgres", id: "local", name: "Docker Postgres", host: "127.0.0.1", port: 54329, database: "rowkery_e2e_orders", username: "rowkery", environment: "local" },
  ];
  const table = (name) => ({
    name,
    columns: [{ name: "id", type_name: "int8", nullable: false }, { name: "status", type_name: "text", nullable: true }],
    primary_key: ["id"],
    indexes: [],
    row_estimate: { Approximate: 10 },
    partition_of: null,
  });
  const catalogFor = (db) => ({ databases: [{ name: db, schemas: [{ name: "public", tables: [table(db === "rowkery_e2e" ? "people" : "orders")] }] }] });
  window.__RUNS__ = [];
  window.__OPENED__ = [];
  window.__TAURI_INTERNALS__ = {
    metadata: { currentWindow: { label: "main" }, currentWebview: { label: "main" } },
    transformCallback: () => 0,
    invoke: async (cmd, args) => {
      switch (cmd) {
        case "list_connections":
          return { connections: structuredClone(connections), active_connection_id: null };
        case "open_window": {
          const database = args.database ?? "rowkery_e2e_orders";
          window.__OPENED__.push(database);
          return { database, catalog: catalogFor(database), elapsed_ms: 5 };
        }
        case "list_databases":
          return [
            { name: "analytics", size_bytes: 1_000_000 },
            { name: "rowkery", size_bytes: 10_000_000 },
            { name: "rowkery_e2e", size_bytes: 136_000_000 },
            { name: "rowkery_e2e_orders", size_bytes: 7_400_000 },
            { name: "postgres", size_bytes: 7_300_000 },
          ];
        case "browse_table_sql":
          return `SELECT * FROM ${args.schema}.${args.table} ORDER BY id LIMIT 1000;`;
        case "run_query": {
          window.__RUNS__.push(args.sql);
          const n = /SELECT (\d+)/i.exec(args.sql)?.[1] ?? "1";
          return { columns: [{ name: "n", type_name: "int4" }], rows: [[{ Int: Number(n) }]], row_count: 1, elapsed_ms: 1, error: null, cancelled: false };
        }
        default:
          return null;
      }
    },
  };
}

const browser = await playwright.chromium.launch({ executablePath: process.env.CHROMIUM_PATH ?? "/opt/pw-browsers/chromium" });
const check = (cond, msg) => {
  if (!cond) {
    console.error(`FAIL: ${msg}`);
    process.exitCode = 1;
  } else console.log(`ok: ${msg}`);
};
const page = await (await browser.newContext({ viewport: { width: 1100, height: 720 }, deviceScaleFactor: 2 })).newPage();
page.on("pageerror", (e) => {
  console.error("pageerror:", e.message);
  process.exitCode = 1;
});
await page.addInitScript({ path: FRAMES_SHIM });
await page.addInitScript(stubTauri);
await page.addInitScript(() => {
  localStorage.clear();
  localStorage.setItem("rowkery.windows", JSON.stringify({ windows: [{ connectionId: "local", database: "rowkery_e2e_orders" }], active: 0 }));
});
await page.goto(URL);
const visible = '[data-testid="workspace"]:not([hidden])';
await page.waitForSelector(visible + '[data-conn-state="connected"]');
// Whether the page took the key (preventDefault), seen from the window after every handler ran.
const tookKey = (key, mods) =>
  page.evaluate(
    ([key, mods]) =>
      new Promise((resolve) => {
        const ev = new KeyboardEvent("keydown", { key, code: `Key${key.toUpperCase()}`, bubbles: true, cancelable: true, ...mods });
        (document.activeElement ?? document.body).dispatchEvent(ev);
        setTimeout(() => resolve(ev.defaultPrevented), 50);
      }),
    [key, mods],
  );

// 1. ⌃⌘F on a query tab: left to macOS; ⌘F still opens Find.
await page.click(visible + ' [data-testid="sql-editor"]');
check((await tookKey("f", { metaKey: true, ctrlKey: true })) === false, "⌃⌘F on a query tab is left to macOS (full screen)");
check((await page.locator(visible + " [data-find-count]").count()) === 0, "⌃⌘F didn't open Find");

// 2. On a table tab too; ⌘F still opens the filter.
await page.click(visible + ' [data-table$=".public.orders"] [data-testid="sb-row-main"]');
await page.waitForSelector(visible + " [data-row]");
await page.click(visible + ' [data-row="0"] [data-col="0"]');
check((await tookKey("f", { metaKey: true, ctrlKey: true })) === false, "⌃⌘F on a table tab is left to macOS");
check((await page.locator(visible + " [data-chip-editor]").count()) === 0, "⌃⌘F didn't open the filter");
check((await tookKey("f", { metaKey: true })) === true, "⌘F still opens the filter");
await page.keyboard.press("Escape");

// 3. ⇧⌘O and ⇧⌘D focus their list in the same task as the key, before any
// frame: a key typed right after (↵, a name's first letter) lands in it.
const focusedOnOpen = (key, popover) =>
  page.evaluate(
    async ([key, popover]) => {
      const init = { key, code: `Key${key.toUpperCase()}`, metaKey: true, shiftKey: true, bubbles: true, cancelable: true };
      (document.activeElement ?? document.body).dispatchEvent(new KeyboardEvent("keydown", init));
      for (let i = 0; i < 5; i++) await Promise.resolve();
      return document.activeElement === document.querySelector(`${popover} input`);
    },
    [key, popover],
  );
check(await focusedOnOpen("O", '[data-testid="conn-popover"]'), "⇧⌘O focuses its list before the next frame");
await page.keyboard.press("Escape");
await page.waitForSelector('[data-testid="conn-popover"]', { state: "detached" });

// ⇧⌘D, type the exact name, ↵: the window switches to it.
check(await focusedOnOpen("D", '[data-testid="db-popover"]'), "⇧⌘D focuses its list before the next frame");
await page.waitForSelector('[data-testid="db-popover"]');
await page.keyboard.type("rowkery_e2e");
await page.waitForTimeout(150);
const order = await page.$$eval('[data-testid="db-option"]', (els) => els.map((e) => e.textContent.replace(/[\d.]+ [KMG]?B$/, "").replace("✓", "").trim()));
check(order[0] === "rowkery_e2e", `the exact name is first: ${order.join(", ")}`);
const cursor = await page.$eval('[role="option"][aria-selected="true"]', (e) => e.textContent);
check(/^\s*rowkery_e2e\s*[\d.]/.test(cursor), `the cursor is on it, not on the current database: ${cursor.trim()}`);
await page.screenshot({ path: `${OUT}/1-db-picker.png`, clip: await page.locator('[data-testid="db-popover"]').boundingBox() });
console.log(`${OUT}/1-db-picker.png`);
await page.keyboard.press("Enter");
await page.waitForFunction(() => window.__OPENED__.at(-1) === "rowkery_e2e");
check(true, "↵ switched the window to rowkery_e2e");

// 4. ⌥⌘↵ from the editor runs every statement.
await page.waitForSelector(visible + '[data-conn-state="connected"]');
await page.click(visible + ' [data-testid="query-tab-add"]');
await page.click(visible + ' [data-testid="sql-editor"]');
await page.keyboard.type("SELECT 1;\nSELECT 2;\nSELECT 3;");
await page.evaluate(() => (window.__RUNS__ = []));
await page.keyboard.press("Alt+Meta+Enter");
await page.waitForTimeout(600);
const runs = await page.evaluate(() => window.__RUNS__);
check(JSON.stringify(runs) === JSON.stringify(["SELECT 1;", "SELECT 2;", "SELECT 3;"]), `⌥⌘↵ runs every statement: ${JSON.stringify(runs)}`);
await page.evaluate(() => (window.__RUNS__ = []));
await page.keyboard.press("Meta+Enter");
await page.waitForTimeout(300);
check((await page.evaluate(() => window.__RUNS__.length)) === 1, "⌘↵ still runs one statement");

await browser.close();
