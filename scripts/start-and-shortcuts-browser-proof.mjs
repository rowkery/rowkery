#!/usr/bin/env node
// The switchers' popovers float in a portal above every column ([data-floating]), not inside the chip.
// Connect to start lists your connections, + / ⌘T open an empty window, ⌘B
// hides the sidebar (stubbed `invoke`, Linux keys).
//
// 1. An empty window lists the saved connections under "Your connections":
//    pinned first, then the sample, then the rest, at most eight, with engine
//    tile, subtitle and env tag, then "Show all…" (opens the ⇧⌘O picker).
//    Click or ↵ on the cursor row connects THIS window; ↵ with no cursor
//    still opens the sample. No saved connections: no section.
// 2. The title bar's + and ⌘T open a new empty window (Connect to start,
//    hollow pill) and show it, without connecting; ⌘1–9, ⇧⌘W, dragging and a
//    relaunch keep working with it.
// 3. ⌘B (Ctrl+B) hides and shows the sidebar, from the editor too, and is the
//    chord the tooltip and ⌘K show; ⌃⌘S (Ctrl+Alt+S) still works.
//
//   cd apps/rowkery-tauri && npx vite --port 1420 &
//   node scripts/start-and-shortcuts-browser-proof.mjs [outDir]
import { createRequire } from "node:module";
import { mkdirSync } from "node:fs";
import { execSync } from "node:child_process";

const require = createRequire(import.meta.url);
let playwright;
try {
  playwright = require("playwright");
} catch {
  playwright = require(`${execSync("npm root -g").toString().trim()}/playwright`);
}
const OUT = process.argv[2] ?? "/tmp/rowkery-proof/start-and-shortcuts";
const URL = process.env.ROWKERY_DEV_URL ?? "http://localhost:1420/";
const FRAMES_SHIM = new globalThis.URL("./lib/frames-shim.js", import.meta.url).pathname;
mkdirSync(OUT, { recursive: true });

function stubTauri(opts) {
  // A reload is a relaunch: keep the saved state, only seed it once.
  if (!sessionStorage.getItem("seeded")) {
    localStorage.clear();
    if (opts.pins) localStorage.setItem("rowkery.pinnedConnections", JSON.stringify(opts.pins));
    sessionStorage.setItem("seeded", "1");
  }
  window.__CALLS__ = [];
  const sample = { kind: "sqlite", id: "sample", name: "Sample database", path: "/x/sample.sqlite", sample: true };
  const envs = ["prd", "stg", "dev", "local", null];
  const pg = (i) => ({
    kind: "postgres",
    id: `c${i}`,
    name: `conn-${i}`,
    host: `db${i}.internal`,
    port: 5432,
    database: "app",
    username: "app",
    environment: envs[i % envs.length],
  });
  window.__CONNS__ =
    opts.conns === "none"
      ? []
      : [...Array.from({ length: 9 }, (_, i) => pg(i + 1)), sample, { kind: "sqlite", id: "cache", name: "analytics-cache", path: "~/cache.db" }];
  const col = (name) => ({ name, type_name: "TEXT", nullable: false });
  const tables = [{ name: "kiosks", kind: "table", columns: [col("id")], primary_key: ["id"], indexes: [], foreign_keys: [], row_estimate: { Exact: 3 }, partition_of: null }];
  window.__TAURI_INTERNALS__ = {
    metadata: { currentWindow: { label: "main" }, currentWebview: { label: "main" } },
    transformCallback: () => 0,
    invoke: async (cmd, args) => {
      window.__CALLS__.push([cmd, args]);
      switch (cmd) {
        case "list_connections":
          return { connections: window.__CONNS__, active_connection_id: null };
        case "open_window":
          return { database: "main", catalog: { databases: [{ name: "main", schemas: [{ name: "main", tables }] }] }, elapsed_ms: 2, cached: false, open_seq: 1 };
        case "open_sample":
          return sample;
        case "run_query":
          return { columns: [{ name: "n", type_name: "int4" }], rows: [[{ Int: 1 }]], row_count: 1, elapsed_ms: 1, error: null, cancelled: false };
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
let page;
const fresh = async (opts = {}) => {
  if (page) await page.close();
  page = await browser.newPage({ viewport: { width: 1280, height: 860 }, deviceScaleFactor: 2 });
  page.on("pageerror", (e) => console.error("pageerror:", e.message));
  await page.addInitScript({ path: FRAMES_SHIM });
  await page.addInitScript(stubTauri, opts);
  await page.goto(URL);
  await page.waitForSelector(`${ws} [data-empty-window]`);
};
const calls = (cmd) => page.evaluate((c) => window.__CALLS__.filter(([x]) => x === c).map(([, a]) => a), cmd);
const opened = async () => (await calls("open_window")).map((a) => a.connectionId);
const tiles = () => page.$$eval('[data-testid="win-tab"]', (els) => els.map((e) => (e.hasAttribute("data-empty") ? "empty" : e.getAttribute("aria-label"))));
const activeTile = () => page.$eval('[data-testid="win-tab"][data-on]', (e) => (e.hasAttribute("data-empty") ? "empty" : e.getAttribute("aria-label")));
const sidebarHidden = () => page.$eval('[data-testid="app-frame"]', (el) => el.hasAttribute("data-sidebar-hidden"));
const savedRows = () =>
  page.$$eval(`${ws} [data-saved-conn]`, (els) =>
    els.map((e) => ({
      id: e.getAttribute("data-saved-conn"),
      group: e.getAttribute("data-group"),
      engine: e.querySelector('[data-testid="conn-engine"]')?.getAttribute("title"),
      sub: e.querySelector('[data-testid="ew-saved-sub"]')?.textContent,
      env: e.querySelector('[data-testid="env-tag"]')?.textContent ?? null,
    })),
  );

// 1 · Your connections: pinned first, the sample next, eight at most, Show all….
await fresh({ pins: ["c7"] });
check((await page.textContent(`${ws} [data-saved-section] [data-testid="ew-section"]`)) === "Your connections", "the section is headed Your connections");
const rows = await savedRows();
check(rows.length === 8, `eight connections listed (${rows.length})`);
check(rows[0].id === "c7" && rows[0].group === "pinned", `the pinned one first (${rows[0].id})`);
check(rows[1].id === "sample" && rows[1].group === "sample", `then the sample (${rows[1].id})`);
check(rows.slice(2).map((r) => r.id).join(",") === "c1,c2,c3,c4,c5,c6", `then the rest in saved order (${rows.slice(2).map((r) => r.id)})`);
check(rows[0].engine === "PostgreSQL" && rows[1].engine === "SQLite", "each row has its engine tile");
check(rows[2].sub === "db1.internal:5432/app" && rows[1].sub === "/x/sample.sqlite", "and the connection subtitle");
check(rows[2].env === "stg" && rows[0].env === "dev" && rows[5].env === null, "and its env tag");
check((await page.getAttribute(`${ws} [data-saved-all]`, "data-saved-all")) === "3", "Show all… stands for the three left out");
const actionsText = await page.$$eval(`${ws} [data-empty-action]`, (els) => els.map((e) => e.getAttribute("data-empty-action")).join(","));
check(actionsText === "new,file,paste,sample", "the four actions stay above it");
await page.screenshot({ path: `${OUT}/1-your-connections.png` });

// ↵ with no cursor still opens the sample.
await page.keyboard.press("Enter");
await page.waitForSelector(`${ws}[data-conn-state="connected"]`);
check((await calls("open_sample")).length === 1 && (await opened()).at(-1) === "sample", "↵ with no cursor opened the sample");
check((await tiles()).length === 1, "in this window");

// Click connects this window.
await fresh({ pins: ["c7"] });
await page.click(`${ws} [data-saved-conn="c3"]`);
await page.waitForSelector(`${ws}[data-conn-state="connected"]`);
check((await opened()).join() === "c3" && (await tiles()).join() === "conn-3", "a click connected this window to conn-3");
await page.waitForFunction((s) => !document.querySelector(`${s} [data-empty-window]`), ws).catch(() => {});
check((await page.$(`${ws} [data-empty-window]`)) === null, "Connect to start gives way (a 100 ms fade)");

// ↓ moves the cursor over the saved rows too; ↵ connects the cursor row.
await fresh({ pins: ["c7"] });
for (let i = 0; i < 7; i++) await page.keyboard.press("ArrowDown");
check((await page.$eval(`${ws} [data-testid="ew-row"][data-cursor]`, (e) => e.getAttribute("data-saved-conn"))) === "c1", "the cursor reaches the saved rows (conn-1)");
check((await page.textContent(`${ws} [data-testid="ew-row"][data-cursor]`)).includes("Connect ↵"), "the cursor row offers Connect ↵");
await page.screenshot({ path: `${OUT}/2-cursor.png` });
await page.keyboard.press("Enter");
await page.waitForSelector(`${ws}[data-conn-state="connected"]`);
check((await opened()).join() === "c1" && (await calls("open_sample")).length === 0, "↵ connected this window to conn-1");

// Show all… opens the connection picker, by click and by ↵.
await fresh({ pins: ["c7"] });
await page.click(`${ws} [data-saved-all]`);
await page.waitForSelector('[data-floating] [data-testid="conn-popover"]');
check((await page.$$('[data-testid="conn-popover"] [data-conn-id]')).length === 11, "Show all… opened the picker with all eleven");
await page.screenshot({ path: `${OUT}/3-show-all.png` });
await page.keyboard.press("Escape");
await page.waitForSelector('[data-floating] [data-testid="conn-popover"]', { state: "detached" });
for (let i = 0; i < 13; i++) await page.keyboard.press("ArrowDown");
check((await page.$(`${ws} [data-testid="ew-row"][data-cursor][data-saved-all]`)) !== null, "the cursor reaches Show all…");
await page.keyboard.press("Enter");
await page.waitForSelector('[data-floating] [data-testid="conn-popover"]');
check(true, "↵ on Show all… opens the picker");
await page.keyboard.press("Escape");

// No saved connections: no section.
await fresh({ conns: "none" });
check((await page.$(`${ws} [data-saved-section]`)) === null, "no saved connections: no Your connections section");

// 2 · + and ⌘T: a new empty window, shown, not connected.
await fresh();
await page.click(`${ws} [data-saved-conn="c1"]`);
await page.waitForSelector(`${ws}[data-conn-state="connected"]`);
await page.click('[data-testid="win-add"]');
await page.waitForSelector(`${ws} [data-empty-window]`);
check((await tiles()).join() === "conn-1,empty" && (await activeTile()) === "empty", "+ opened an empty window and showed it");
// Class on purpose: the hollow penguin is the drawing under test (.penguin-plain).
check((await page.textContent(`${ws} [data-testid="ew-title"]`)) === "Connect to start" && (await page.$('[data-testid="win-tab"][data-on] .penguin-plain')) !== null, "Connect to start, hollow tile");
check((await page.$('[data-testid="conn-popover"]')) === null, "no picker popover");
await page.screenshot({ path: `${OUT}/4-plus-empty-window.png` });
await page.keyboard.press("Control+t");
await page.waitForFunction(() => document.querySelectorAll('[data-testid="win-tab"]').length === 3);
check((await tiles()).join() === "conn-1,empty,empty" && (await page.locator('[data-testid="win-tab"]').nth(2).getAttribute("data-on")) === "", "⌘T opened another and showed it");
await page.waitForTimeout(300);
check((await opened()).join() === "c1", "neither empty window connected on its own");
// ⌘1–9 reach them.
await page.keyboard.press("Control+1");
await page.waitForSelector(`${ws}[data-conn-state="connected"]`);
check((await activeTile()) === "conn-1", "⌘1 shows conn-1");
await page.keyboard.press("Control+2");
await page.waitForSelector(`${ws} [data-empty-window]`);
check((await activeTile()) === "empty", "⌘2 shows the empty window");
// ⇧⌘W closes an empty window.
await page.keyboard.press("Control+Shift+w");
await page.waitForFunction(() => document.querySelectorAll('[data-testid="win-tab"]').length === 2);
check((await tiles()).join() === "conn-1,empty", "⇧⌘W closed one empty window");
// Drag the empty pill before conn-1 (the pills run across the title bar).
const box = (sel) => page.locator(sel).boundingBox();
const emptyBox = await box('[data-testid="win-tab"][data-empty]');
const firstBox = await box('[data-testid="win-tab"]:not([data-empty])');
const p = { x: emptyBox.x + emptyBox.width / 2, y: emptyBox.y + emptyBox.height / 2 };
const dx = firstBox.x + firstBox.width * 0.25 - emptyBox.x;
await page.mouse.move(p.x, p.y);
await page.mouse.down();
for (let i = 1; i <= 10; i++) {
  await page.mouse.move(p.x + (dx * i) / 10, p.y);
  await page.waitForTimeout(16);
}
await page.mouse.up();
await page.waitForTimeout(300);
check((await tiles()).join() === "empty,conn-1", `dragging moved the empty window first (${await tiles()})`);
await page.keyboard.press("Control+2");
await page.waitForTimeout(150);
check((await activeTile()) === "conn-1", "⌘2 follows the new order");
await page.keyboard.press("Control+1");
await page.waitForTimeout(150);
// Relaunch: the empty window comes back empty and doesn't connect.
await page.waitForTimeout(1500);
await page.reload();
await page.waitForSelector(`${ws} [data-empty-window]`);
await page.waitForTimeout(300);
check((await tiles()).join() === "empty,conn-1" && (await activeTile()) === "empty", "relaunch keeps the empty window, shown");
check((await opened()).length === 0, "and nothing connects until a connected window is shown");

// 3 · ⌘B hides and shows the sidebar; ⌃⌘S still does.
await fresh();
await page.click(`${ws} [data-saved-conn="c1"]`);
await page.waitForSelector(`${ws}[data-conn-state="connected"]`);
check(!(await sidebarHidden()), "the sidebar shows");
// ⌘B has no button (the key hides the sidebar); the title bar's ⌘K
// carries the registry's keys.
check((await page.textContent('[data-testid="search-cap-key"]')) === "Ctrl K", "⌘K's keycap reads Ctrl K");
await page.keyboard.press("Control+b");
await page.waitForTimeout(300);
check(await sidebarHidden(), "Ctrl+B hid the sidebar");
await page.screenshot({ path: `${OUT}/5-ctrl-b-hidden.png` });
await page.keyboard.press("Control+b");
await page.waitForTimeout(300);
check(!(await sidebarHidden()), "Ctrl+B showed it again");
await page.keyboard.press("Control+Alt+s");
await page.waitForTimeout(300);
check(await sidebarHidden(), "Ctrl+Alt+S (⌃⌘S) still hides it");
await page.keyboard.press("Control+Alt+s");
await page.waitForTimeout(300);
check(!(await sidebarHidden()), "and shows it");
// From the SQL editor: the sidebar toggles, the text is untouched.
await page.click(`${ws} textarea[data-testid="sql-editor"]`);
const sqlBefore = await page.inputValue(`${ws} textarea[data-testid="sql-editor"]`);
await page.keyboard.press("Control+b");
await page.waitForTimeout(300);
check(await sidebarHidden(), "Ctrl+B works with the editor focused");
check((await page.inputValue(`${ws} textarea[data-testid="sql-editor"]`)) === sqlBefore, "and leaves the SQL alone");
await page.keyboard.press("Control+b");
await page.waitForTimeout(300);
// ⌘K shows Ctrl+B for Hide sidebar.
await page.keyboard.press("Control+k");
await page.waitForSelector('[data-testid="cp-panel"]');
await page.keyboard.type(">sidebar");
await page.waitForSelector('[data-item="cmd:toggle-sidebar"]');
const keys = await page.$eval('[data-item="cmd:toggle-sidebar"] [data-keys]', (e) => e.textContent);
check(keys === "Ctrl+B", `⌘K lists Hide sidebar with ${keys}`);
await page.screenshot({ path: `${OUT}/6-palette-ctrl-b.png` });
await page.keyboard.press("Escape");
await page.keyboard.press("Escape");
// The shortcuts sheet too.
await page.keyboard.press("Control+Shift+?");
await page.waitForSelector("[data-shortcuts]");
const sheetKeys = await page.getAttribute('[data-shortcut="toggle-sidebar"]', "data-keys");
const sheet = await page.textContent("[data-shortcuts]");
check(sheetKeys === "Ctrl+B" && !sheet.includes("Ctrl+Alt+S"), "the shortcuts sheet lists Ctrl+B");
await page.keyboard.press("Escape");

await browser.close();
