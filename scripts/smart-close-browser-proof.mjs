#!/usr/bin/env node
// ⌘W closes what was used last (2026-10-14; src/closeScope.ts), without
// a Tauri webview (stubbed `invoke`). On macOS ⌘W is the menu bar's Close Tab,
// which reaches the page as `rowkery:command` "close-tab" (main.tsx); on Linux /
// Windows it is a Ctrl+W keydown. Proves:
//   - after a click in the editor, ⌘W closes the query tab, no window;
//   - after a click on a window pill or in the schema column, ⌘W closes that
//     window (its connection), with Undo, and the menu item reads Close Window;
//   - a table opened from the schema column is what ⌘W closes next;
//   - with ⌘K or the Agents page open, ⌘W closes that first, nothing else;
//   - Ctrl+W follows the same rule.
// The native menu accelerator itself can't run in Chromium; the Mac app is the proof of that.
//
//   cd apps/rowkery-tauri && npx vite --port 1420 &
//   node scripts/smart-close-browser-proof.mjs [outDir]
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

const OUT = process.argv[2] ?? "/tmp/rowkery-proof/smart-close";
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

const tabCount = (page) => page.locator(`${visible} [data-testid="query-tab"][data-reorder-key]`).count();
const winCount = (page) => page.locator('[data-testid="win-tab"][data-reorder-key]').count();
const closes = (page) => page.evaluate(() => window.__ROWKERY_CALLS__.filter(([c]) => c === "close_window").length);
const menuW = () => window.dispatchEvent(new CustomEvent("rowkery:command", { detail: "close-tab" }));
const closeTitle = (page) =>
  page.evaluate(() => {
    let title = null;
    for (const [cmd, args] of window.__ROWKERY_CALLS__)
      if (cmd === "set_menu_state") for (const it of args.items) if (it.id === "close-tab" && it.title) title = it.title;
    return title;
  });
const toastText = (page) => page.$$eval("[data-toast] > span", (els) => els.map((e) => e.textContent.trim()).join(" "));

// 1. macOS: editor, then window pill, then schema column, then a table from it.
{
  const page = await open(true);
  for (let i = 0; i < 2; i++) await page.click(`${visible} [data-testid="query-tab-add"]`);
  await page.waitForTimeout(250);
  await page.click(`${visible} [data-testid="sql-editor"]`);
  check(((await closeTitle(page)) ?? "Close Tab") === "Close Tab", "menu reads Close Tab after the editor");
  await page.evaluate(menuW);
  await page.waitForTimeout(250);
  check((await tabCount(page)) === 2 && (await winCount(page)) === 3 && (await closes(page)) === 0, "editor used last: ⌘W closed the query tab, no window");

  // A click on the active window's pill (Docker Postgres): ⌘W closes that window.
  await page.click('[data-testid="win-tab"][data-on]');
  await page.waitForTimeout(150);
  check((await closeTitle(page)) === "Close Window", `menu reads Close Window after the pill (${await closeTitle(page)})`);
  await page.screenshot({ path: `${OUT}/1-pill-used-last.png`, clip: { x: 0, y: 0, width: 1280, height: 400 } });
  await page.evaluate(menuW);
  await page.waitForTimeout(300);
  check((await winCount(page)) === 2 && (await closes(page)) === 1, "pill used last: ⌘W closed the window");
  const toast = await toastText(page);
  check(toast.startsWith("Closed Docker Postgres") && (await page.$("[data-toast-undo]")) !== null, `closing a window offers Undo (${toast})`);
  await page.screenshot({ path: `${OUT}/2-window-closed.png`, clip: { x: 0, y: 0, width: 1280, height: 800 } });

  // The next window is shown; wait for it, then use its schema column.
  await page.waitForSelector(`${visible}[data-conn-state="connected"]`);
  await page.click(`${visible} [data-testid="sql-editor"]`);
  check((await closeTitle(page)) === "Close Tab", "a click in the editor makes it Close Tab again");
  const before = await tabCount(page);
  await page.click(`${visible} [data-testid="sidebar"]`, { position: { x: 60, y: 6 } });
  await page.waitForTimeout(100);
  check((await closeTitle(page)) === "Close Window", "a click in the schema column makes it Close Window");
  // Opening a table from the schema column makes its tab the next to close.
  await page.click(`${visible} [data-testid="sb-row-main"] >> nth=0`);
  await page.waitForTimeout(300);
  const opened = await tabCount(page);
  check((await closeTitle(page)) === "Close Tab", `a table opened from the schema column makes it Close Tab (${before} → ${opened} tabs)`);
  await page.evaluate(menuW);
  await page.waitForTimeout(250);
  check(opened === before + 1 && (await winCount(page)) === 2 && (await tabCount(page)) === before, "⌘W closed that table tab, not the window");
  // Schema column again, with nothing opened: the window goes.
  await page.click(`${visible} [data-testid="sidebar"]`, { position: { x: 60, y: 6 } });
  await page.evaluate(menuW);
  await page.waitForTimeout(300);
  check((await winCount(page)) === 1, "schema column used last: ⌘W closed the window");

  // ⌘K open: ⌘W closes ⌘K, nothing else.
  await page.waitForSelector(`${visible}[data-conn-state="connected"]`);
  await page.click(`${visible} [data-testid="sql-editor"]`);
  const tabs = await tabCount(page);
  await page.keyboard.press("Meta+k");
  await page.waitForTimeout(200);
  const paletteSel = '[data-testid="cp-panel"]';
  check((await page.locator(paletteSel).count()) > 0, "⌘K is open");
  await page.evaluate(menuW);
  await page.waitForTimeout(300);
  check((await page.locator(paletteSel).count()) === 0, "⌘W closed ⌘K");
  check((await tabCount(page)) === tabs && (await winCount(page)) === 1, "and left the tabs and window alone");

  // The Agents page open: ⌘W closes the page, nothing else.
  await page.keyboard.press("Meta+Shift+a");
  await page.waitForSelector('[data-testid="agents-page"]');
  await page.evaluate(menuW);
  await page.waitForTimeout(400);
  check((await page.locator('[data-testid="agents-page"]').count()) === 0, "⌘W closed the Agents page");
  check((await tabCount(page)) === tabs && (await winCount(page)) === 1, "and left the tabs and window alone");
  await page.context().close();
}

// 2. Linux / Windows: Ctrl+W follows the same rule.
{
  const page = await open(false);
  await page.click(`${visible} [data-testid="query-tab-add"]`);
  await page.waitForTimeout(200);
  await page.click(`${visible} [data-testid="sql-editor"]`);
  await page.keyboard.press("Control+w");
  await page.waitForTimeout(250);
  check((await tabCount(page)) === 1 && (await winCount(page)) === 3, "Ctrl+W after the editor closed the query tab");
  await page.click('[data-testid="win-tab"][data-on]');
  await page.keyboard.press("Control+w");
  await page.waitForTimeout(300);
  check((await winCount(page)) === 2, "Ctrl+W after the pill closed the window");
  await page.context().close();
}

await browser.close();
