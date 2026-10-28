#!/usr/bin/env node
// ⌘W / Ctrl+W and idle env dots without a Tauri webview (stubbed `invoke`).
// A tab whose session holds an open transaction (`__OPEN_TXNS__`) isn't
// closed: a toast names it, and its session stays.
// Ctrl+W closes the active query tab (at once; Undo toast when it had SQL), never
// the window; the last tab turns into an empty "Query 1". On macOS ⌘W is the
// menu bar's Close Tab, which reaches the page as `rowkery:command` "close-tab"
// (main.tsx); a bare ⌘W keydown is left to the menu. Also captures the title
// bar with prd idle (not yet connected), to show its pill carries the plain
// env dot like every other environment, not a spinner or warning.
//
//   cd apps/rowkery-tauri && npx vite --port 1420 &
//   node scripts/close-tab-browser-proof.mjs [outDir]
import { createRequire } from "node:module";
import { mkdirSync } from "node:fs";
import { execSync } from "node:child_process";

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

const OUT = process.argv[2] ?? "/tmp/rowkery-proof/close-tab";
const URL = process.env.ROWKERY_DEV_URL ?? "http://localhost:1420/";
mkdirSync(OUT, { recursive: true });

function stubTauri() {
  const TABLES = {
    wallet: ["api_keys", "ledger_entries", "wallets"],
    orders: ["order_items", "orders", "refunds", "shipments"],
    payments: ["charges", "payouts"],
    analytics: ["daily_active", "events"],
  };
  const catalogFor = (db) => ({
    databases: [
      {
        name: db,
        schemas: [
          {
            name: "public",
            tables: (TABLES[db] ?? ["t"]).map((name, i) => ({
              name,
              columns: [{ name: "id", type_name: "int8", nullable: false }],
              primary_key: ["id"],
              indexes: [],
              row_estimate: { Approximate: 4100 * (i + 1) },
              partition_of: null,
            })),
          },
        ],
      },
    ],
  });
  const pg = (id, name, host, environment) => ({
    kind: "postgres",
    id,
    name,
    host,
    port: 5432,
    database: "wallet",
    username: "app",
    environment,
  });
  const connections = [
    pg("prd", "wallet", "wallet-prd.db.internal", "prd"),
    pg("stg", "wallet", "wallet-stg.db.internal", "stg"),
    { ...pg("local", "Docker Postgres", "127.0.0.1", "local"), port: 54329, database: "rowkery" },
    { kind: "sqlite", id: "cache", name: "analytics-cache", path: "~/cache.db" },
  ];
  const windows = {};
  window.__ROWKERY_CALLS__ = [];
  window.__TAURI_INTERNALS__ = {
    metadata: { currentWindow: { label: "main" }, currentWebview: { label: "main" } },
    transformCallback: () => 0,
    invoke: async (cmd, args) => {
      window.__ROWKERY_CALLS__.push([cmd, args]);
      switch (cmd) {
        case "list_connections":
          return { connections: structuredClone(connections), active_connection_id: null };
        case "open_window": {
          const c = connections.find((x) => x.id === args.connectionId);
          const database = c.kind === "sqlite" ? "main" : (args.database ?? c.database);
          windows[args.windowId] = { conn: c, database };
          await new Promise((r) => setTimeout(r, 60));
          return { database, catalog: catalogFor(database), elapsed_ms: 60 };
        }
        case "close_window":
          delete windows[args.windowId];
          return null;
        case "list_databases":
          return [
            { name: "analytics", size_bytes: 12_884_901_888 },
            { name: "orders", size_bytes: 4_509_715_660 },
            { name: "payments", size_bytes: 1_181_116_006 },
            { name: "postgres", size_bytes: 8_388_608 },
            { name: "wallet", size_bytes: 901_775_360 },
          ];
        case "run_query": {
          // "pg_sleep(n)" waits n seconds (cancellable), "boom" fails.
          const secs = Number(/pg_sleep\((\d+(?:\.\d+)?)\)/.exec(args.sql)?.[1] ?? 0);
          const started = performance.now();
          const cancelled = await new Promise((resolve) => {
            const t = setTimeout(() => resolve(false), secs * 1000);
            (window.__ROWKERY_PENDING__ ??= {})[`${args.windowId}:${args.tabId}`] = () => {
              clearTimeout(t);
              resolve(true);
            };
          });
          const elapsed_ms = Math.round(performance.now() - started);
          if (cancelled) return { columns: [], rows: [], row_count: 0, elapsed_ms, error: null, cancelled: true };
          if (args.sql.includes("boom"))
            return { columns: [], rows: [], row_count: 0, elapsed_ms, error: 'relation "boom" does not exist', cancelled: false };
          return {
            columns: [{ name: "tab", type_name: "int8" }, { name: "sql", type_name: "text" }],
            rows: [[{ Int: args.tabId }, { Text: args.sql }]],
            row_count: 1,
            elapsed_ms,
            error: null,
            cancelled: false,
          };
        }
        case "cancel_query":
        case "close_query_tab":
          window.__ROWKERY_PENDING__?.[`${args.windowId}:${args.tabId}`]?.();
          return null;
        case "open_transactions":
          return window.__OPEN_TXNS__ ?? [];
        case "browse_table_sql":
          return `SELECT * FROM ${args.schema}.${args.table} LIMIT 100;`;
        default:
          return null;
      }
    },
  };
}

const browser = await playwright.chromium.launch({
  executablePath: process.env.CHROMIUM_PATH ?? "/opt/pw-browsers/chromium",
});
const check = (cond, msg) => {
  if (!cond) {
    console.error(`FAIL: ${msg}`);
    process.exitCode = 1;
  } else console.log(`ok: ${msg}`);
};
const visible = '[data-testid="workspace"]:not([hidden])';

async function open(mac) {
  const context = await browser.newContext({
    viewport: { width: 1280, height: 800 },
    deviceScaleFactor: 2,
    userAgent: mac
      ? "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko)"
      : undefined,
  });
  const page = await context.newPage();
  page.on("pageerror", (e) => console.error("pageerror:", e.message));
  if (mac) await page.addInitScript(() => Object.defineProperty(navigator, "platform", { get: () => "MacIntel" }));
  await page.addInitScript({ path: FRAMES_SHIM });
  await page.addInitScript(stubTauri);
  await page.addInitScript(() => {
    localStorage.clear();
    localStorage.setItem(
      "rowkery.windows",
      JSON.stringify({
        windows: [
          { connectionId: "prd", database: "wallet" },
          { connectionId: "stg", database: "wallet" },
          { connectionId: "local", database: "rowkery" },
        ],
        active: 2,
      }),
    );
  });
  await page.goto(URL);
  await page.waitForSelector(`${visible}[data-conn-state="connected"]`);
  return page;
}

const tabTitles = (page) =>
  page.locator(`${visible} [data-testid="query-tab"][data-reorder-key]`).evaluateAll((els) => els.map((e) => e.textContent.trim()));
const addTabs = async (page, n) => {
  for (let i = 0; i < n; i++) await page.click(`${visible} [data-testid="query-tab-add"]`);
  await page.waitForTimeout(250);
};

// 1. Linux / Windows: Ctrl+W.
{
  const page = await open(false);
  await addTabs(page, 2);
  check((await tabTitles(page)).length === 3, "three query tabs");
  await page.click(`${visible} [data-testid="sql-editor"]`);
  await page.keyboard.type("SELECT 3;");
  await page.keyboard.press("Control+w");
  await page.waitForTimeout(300);
  let titles = await tabTitles(page);
  check(titles.length === 2 && !titles.some((t) => t.includes("Query 3")), `Ctrl+W closed the active tab (${titles})`);
  const toast = await page.$$eval("[data-toast] > span", (els) => els.map((e) => e.textContent.trim()).join(" "));
  check(toast === "Closed Query 3 with unsaved SQL" && (await page.$("[data-toast-undo]")) !== null, `closing a tab with SQL offers Undo (${toast})`);
  await page.keyboard.press("Control+w");
  await page.keyboard.press("Control+w");
  await page.waitForTimeout(300);
  titles = await tabTitles(page);
  check(titles.length === 1 && titles[0].includes("Query 1"), `closing the last tab leaves an empty Query 1 (${titles})`);
  check((await page.locator('[data-testid="win-tab"][data-reorder-key]').count()) === 3, "all three windows are still open");
  const closes = await page.evaluate(() => window.__ROWKERY_CALLS__.filter(([c]) => c === "close_window").length);
  check(closes === 0, "no window was closed");
  // The prd window is idle (hidden windows connect when first shown): its
  // tile carries the plain env dot, like stg's.
  const marks = (env) => page.locator(`[data-testid="win-tab"][data-env="${env}"] [data-testid="win-mark"]`).evaluateAll((els) => els.map((e) => e.dataset.kind));
  check(
    (await page.getAttribute('[data-testid="workspace"][hidden] >> nth=0', "data-conn-state")) === "idle",
    "a hidden window stays idle",
  );
  const prd = await marks("prd");
  check(prd.length === 1 && prd[0] === "env", `idle prd tile shows one plain env dot (${prd})`);
  check((await marks("stg")).join() === prd.join(), "same mark as the idle stg tile");
  const rail = await page.locator('[data-testid="titlebar"]').boundingBox();
  await page.screenshot({ path: `${OUT}/1-idle-dots.png`, clip: { x: rail.x, y: rail.y, width: rail.width + 200, height: 360 } });
  console.log(`${OUT}/1-idle-dots.png`);
  await page.context().close();
}

// 2. macOS: the menu's Close Tab arrives as `rowkery:command` "close-tab".
{
  const page = await open(true);
  await addTabs(page, 1);
  await page.click(`${visible} [data-testid="sql-editor"]`);
  await page.keyboard.press("Meta+w");
  await page.waitForTimeout(200);
  check((await tabTitles(page)).length === 2, "a bare ⌘W keydown is left to the menu bar");
  await page.evaluate(() => window.dispatchEvent(new CustomEvent("rowkery:command", { detail: "close-tab" })));
  await page.waitForTimeout(300);
  const titles = await tabTitles(page);
  check(titles.length === 1 && titles[0].includes("Query 1"), `menu Close Tab closed the active tab (${titles})`);
  await page.context().close();
}

// 3. A tab holding an open transaction stays open, and so does its session.
{
  const page = await open(false);
  await addTabs(page, 2);
  await page.evaluate(() => (window.__OPEN_TXNS__ = [{ window_id: "w3", tab_id: 2 }]));
  await page.keyboard.press("Control+w");
  await page.waitForTimeout(300);
  let titles = await tabTitles(page);
  check(titles.length === 2, `the tab without a transaction closed (${titles})`);
  await page.keyboard.press("Control+w");
  await page.waitForTimeout(300);
  titles = await tabTitles(page);
  check(titles.length === 2 && titles.some((t) => t.includes("Query 2")), `the tab with a transaction stayed (${titles})`);
  const toast = await page.$$eval("[data-toast] > span", (els) => els.map((e) => e.textContent.trim()).join(" "));
  check(toast.startsWith("A transaction is open in “Query 2”"), `a toast names it (${toast})`);
  const closed = await page.evaluate(() =>
    window.__ROWKERY_CALLS__.filter(([c, a]) => c === "close_query_tab" && a.tabId === 2).length,
  );
  check(closed === 0, "its session wasn't closed");
  await page.evaluate(() => (window.__OPEN_TXNS__ = []));
  await page.keyboard.press("Control+w");
  await page.waitForTimeout(300);
  check((await tabTitles(page)).length === 1, "once it ends, the tab closes");
  await page.context().close();
}

await browser.close();
