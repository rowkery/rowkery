#!/usr/bin/env node
// The macOS menu bar from commands.ts (stubbed `invoke` on a faked macOS
// page; no webview or Postgres). app_menu builds Connection, Query, View, Go,
// Window and Help from src-tauri/menu.json; this proves the page's half:
//
// 1. The shown window pushes every menu item's enabled state once
//    (`set_menu_state`), disabled not hidden: Run is off before a connection,
//    New Connection… is on.
// 2. Later pushes carry only what changed: connecting enables Run, ⌘B
//    retitles Show / Hide Sidebar, a running query enables Cancel Query.
// 3. ⌘. cancels the running query (Query > Cancel Query's chord).
// 4. A menu pick arrives as Tauri's `menu-command` event (main.tsx) and runs
//    the same command as ⌘K: File > New Query Tab, View > Hide Sidebar.
//
//   cd apps/rowkery-tauri && npx vite --port 1420 &
//   node scripts/menu-bar-browser-proof.mjs [outDir]   (ROWKERY_DEV_URL for another port)
import { createRequire } from "node:module";
import { mkdirSync, readFileSync } from "node:fs";
import { execSync } from "node:child_process";

const require = createRequire(import.meta.url);
let playwright;
try {
  playwright = require("playwright");
} catch {
  playwright = require(`${execSync("npm root -g").toString().trim()}/playwright`);
}
const OUT = process.argv[2] ?? "/tmp/rowkery-proof/menu-bar";
const URL = process.env.ROWKERY_DEV_URL ?? "http://localhost:1420/";
const FRAMES_SHIM = new globalThis.URL("./lib/frames-shim.js", import.meta.url).pathname;
const MENU = JSON.parse(
  readFileSync(new globalThis.URL("../apps/rowkery-tauri/src-tauri/menu.json", import.meta.url), "utf8"),
);
const MENU_IDS = MENU.flatMap((m) => m.items.filter((i) => i.id).map((i) => i.id));
mkdirSync(OUT, { recursive: true });

function stubTauri() {
  Object.defineProperty(navigator, "platform", { get: () => "MacIntel" });
  if (!sessionStorage.getItem("seeded")) {
    localStorage.clear();
    sessionStorage.setItem("seeded", "1");
  }
  window.__CALLS__ = [];
  window.__CB__ = {};
  window.__LISTEN__ = {};
  let nextCb = 1;
  const col = (name) => ({ name, type_name: "int8", nullable: false });
  const tables = [{ name: "kiosks", kind: "table", columns: [col("id")], primary_key: ["id"], indexes: [], foreign_keys: [], row_estimate: { Exact: 3 }, partition_of: null }];
  const conn = { kind: "postgres", id: "pg", name: "wallet-dev", host: "db.internal", port: 5432, database: "wallet", username: "app" };
  window.__TAURI_INTERNALS__ = {
    metadata: { currentWindow: { label: "main" }, currentWebview: { label: "main" } },
    transformCallback: (cb) => {
      const id = nextCb++;
      window.__CB__[id] = cb;
      return id;
    },
    invoke: async (cmd, args) => {
      window.__CALLS__.push([cmd, args]);
      switch (cmd) {
        case "plugin:event|listen":
          window.__LISTEN__[args.event] = args.handler;
          return args.handler;
        case "list_connections":
          return { connections: [conn], active_connection_id: null };
        case "open_window":
          return { database: "wallet", catalog: { databases: [{ name: "wallet", schemas: [{ name: "public", tables }] }] }, elapsed_ms: 2, cached: false, open_seq: 1 };
        case "list_databases":
          return [];
        case "run_query": {
          // "pg_sleep" waits until cancelled.
          const slow = args.sql.includes("pg_sleep");
          const cancelled = slow
            ? await new Promise((resolve) => {
                window.__PENDING__ = () => resolve(true);
              })
            : false;
          if (cancelled) return { columns: [], rows: [], row_count: 0, elapsed_ms: 5, error: null, cancelled: true };
          return { columns: [{ name: "n", type_name: "int4" }], rows: [[{ Int: 1 }]], row_count: 1, elapsed_ms: 1, error: null, cancelled: false };
        }
        case "cancel_query":
          window.__PENDING__?.();
          return null;
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
const page = await browser.newPage({ viewport: { width: 1280, height: 800 }, deviceScaleFactor: 2 });
page.on("pageerror", (e) => console.error("pageerror:", e.message));
await page.addInitScript({ path: FRAMES_SHIM });
await page.addInitScript(stubTauri);
await page.goto(URL);
const ws = '[data-testid="workspace"]:not([hidden])';
await page.waitForSelector('[data-testid="titlebar"]');
await page.waitForTimeout(300);

/** Every `set_menu_state` push so far, each a list of { id, enabled, title }. */
const pushes = () => page.evaluate(() => window.__CALLS__.filter(([c]) => c === "set_menu_state").map(([, a]) => a.items));
/** The menu as app_menu now has it: id → { enabled, title }. */
const menuNow = async () => {
  const now = {};
  for (const items of await pushes()) for (const i of items) now[i.id] = { enabled: i.enabled, title: i.title ?? now[i.id]?.title };
  return now;
};
const emitMenu = (id) =>
  page.evaluate((id) => {
    const h = window.__LISTEN__["menu-command"];
    window.__CB__[h]({ event: "menu-command", id: 1, payload: id });
  }, id);

// 1 · The first push names every item, disabled rather than hidden.
let all = await pushes();
check(all.length >= 1, `the window pushed its menu state (${all.length} pushes)`);
const first = all[0];
check(
  first.map((i) => i.id).sort().join() === [...MENU_IDS].sort().join(),
  `the first push names all ${MENU_IDS.length} menu items`,
);
let menu = await menuNow();
check(menu.run?.enabled === false, "Query > Run Statement is disabled before a connection");
check(menu["new-connection"]?.enabled === true, "Connection > New Connection… is enabled");
check(menu["toggle-sidebar"]?.title === "Hide Sidebar", "View > Hide Sidebar");
check(!!(await page.evaluate(() => window.__LISTEN__["menu-command"])), "main.tsx listens for menu-command");

// 2 · Connect: Run turns on, and only changed items cross.
const pushesBefore = (await pushes()).length;
await page.keyboard.press("Meta+Shift+O");
await page.waitForSelector('[data-testid="conn-popover"]');
await page.keyboard.press("Enter");
await page.waitForSelector(`${ws}[data-conn-state="connected"]`);
await page.waitForTimeout(300);
all = await pushes();
menu = await menuNow();
check(menu.run?.enabled === true && menu["refresh-schema"]?.enabled === true, "connected: Run Statement and Refresh Schema are enabled");
const later = all.slice(pushesBefore).flat();
check(later.length > 0 && later.length < MENU_IDS.length, `later pushes carry only changes (${later.length} items over ${all.length - pushesBefore} pushes)`);
check(later.every((i) => MENU_IDS.includes(i.id)), "every pushed id is a menu item");

// ⌘B: the title follows.
await page.keyboard.press("Meta+b");
await page.waitForTimeout(250);
menu = await menuNow();
check(menu["toggle-sidebar"]?.title === "Show Sidebar", "⌘B retitles View > Show Sidebar");
const lastPush = (await pushes()).at(-1);
check(lastPush.length === 1 && lastPush[0].id === "toggle-sidebar", `that push carried one item (${lastPush.map((i) => i.id)})`);
await page.keyboard.press("Meta+b");
await page.waitForTimeout(250);

// 3 · A running query enables Cancel Query; ⌘. cancels it.
await page.click(`${ws} [data-testid="sql-editor"]`);
await page.keyboard.press("Meta+a");
await page.keyboard.type("SELECT pg_sleep(30);");
await page.keyboard.press("Meta+Enter");
await page.waitForSelector(`${ws} [data-testid="query-tab"][data-running]`, { timeout: 3000 }).catch(() => null);
await page.waitForTimeout(200);
menu = await menuNow();
check(menu.cancel?.enabled === true, "running: Query > Cancel Query is enabled");
await page.screenshot({ path: `${OUT}/1-running.png` });
await page.keyboard.press("Meta+.");
await page.waitForTimeout(400);
const cancels = (await page.evaluate(() => window.__CALLS__.filter(([c]) => c === "cancel_query").length));
check(cancels === 1, `⌘. sent one cancel_query (${cancels})`);
menu = await menuNow();
check(menu.cancel?.enabled === false, "Cancel Query is disabled again once it ended");

// 4 · Menu picks run the same commands as ⌘K.
const tabCount = () => page.$$eval(`${ws} [data-testid="query-tab"][data-reorder-key]`, (els) => els.length);
const tabsBefore = await tabCount();
await emitMenu("new-tab");
await page.waitForTimeout(300);
check((await tabCount()) === tabsBefore + 1, `File > New Query Tab added a tab (${tabsBefore} → ${await tabCount()})`);
await emitMenu("toggle-sidebar");
await page.waitForTimeout(300);
check(await page.$eval('[data-testid="app-frame"]', (el) => el.hasAttribute("data-sidebar-hidden")), "View > Hide Sidebar hid it");
menu = await menuNow();
check(menu["toggle-sidebar"]?.title === "Show Sidebar", "and the item now reads Show Sidebar");
await page.screenshot({ path: `${OUT}/2-sidebar-hidden-from-menu.png` });
await emitMenu("toggle-sidebar");
await page.waitForTimeout(300);
await emitMenu("close-tab");
await page.waitForTimeout(400);
check((await tabCount()) === tabsBefore, "File > Close Tab closed it");

await browser.close();
