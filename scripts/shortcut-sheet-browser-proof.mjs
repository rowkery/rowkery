#!/usr/bin/env node
// The shortcut sheet from commands.ts (stubbed `invoke`, Linux keys).
//
// 1. ⇧⌘/ opens it: sections in menu-bar order with anchors, every registry
//    command with a chord (keycaps formatted by the registry) plus the static
//    gesture rows, "Used 0 of n" on a fresh install.
// 2. Pressing shortcuts brightens their rows (data-used, filled dot) and the
//    count follows; menu or ⌘K picks don't count; the counts survive a
//    relaunch (usedKeys in config.json, here its localStorage mirror).
// 3. Typing filters by label, chord or synonym; an anchor scrolls to its
//    section; Esc clears, then closes.
// 4. ? opens it with focus in the grid or the schema panel, never in the
//    editor; the schema column's Help button and ⌘K open it too.
// 5. Keymap: TablePlus swaps only its chords: the sheet marks them, ⌘K, the
//    title bar's + tooltip and the Data | Structure tooltip read them, Ctrl+T then
//    opens a query tab (not a window), and the choice survives a relaunch.
//
//   cd apps/rowkery-tauri && npx vite --port 1420 &
//   node scripts/shortcut-sheet-browser-proof.mjs [outDir]   (ROWKERY_DEV_URL for another port)
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
const OUT = process.argv[2] ?? "/tmp/rowkery-proof/shortcut-sheet";
const URL = process.env.ROWKERY_DEV_URL ?? "http://localhost:1420/";
const FRAMES_SHIM = new globalThis.URL("./lib/frames-shim.js", import.meta.url).pathname;
mkdirSync(OUT, { recursive: true });

function stubTauri() {
  if (!sessionStorage.getItem("seeded")) {
    localStorage.clear();
    localStorage.setItem("rowkery.windows", JSON.stringify({ windows: [{ connectionId: "pg", database: "wallet" }], active: 0 }));
    sessionStorage.setItem("seeded", "1");
  }
  window.__CALLS__ = [];
  const col = (name, type_name = "int8") => ({ name, type_name, nullable: false });
  const tables = [
    { name: "kiosks", kind: "table", columns: [col("id"), col("city", "text")], primary_key: ["id"], indexes: [], foreign_keys: [], row_estimate: { Exact: 3 }, partition_of: null },
  ];
  const conn = { kind: "postgres", id: "pg", name: "wallet-dev", host: "db.internal", port: 5432, database: "wallet", username: "app" };
  window.__TAURI_INTERNALS__ = {
    metadata: { currentWindow: { label: "main" }, currentWebview: { label: "main" } },
    transformCallback: () => 0,
    invoke: async (cmd, args) => {
      window.__CALLS__.push([cmd, args]);
      switch (cmd) {
        case "list_connections":
          return { connections: [conn], active_connection_id: null };
        case "open_window":
          return { database: "wallet", catalog: { databases: [{ name: "wallet", schemas: [{ name: "public", tables }] }] }, elapsed_ms: 2, cached: false, open_seq: 1 };
        case "list_databases":
          return [];
        case "browse_table_sql":
          return `SELECT * FROM ${args.table} LIMIT 1000`;
        case "run_query":
          return {
            columns: [{ name: "id", type_name: "int8" }, { name: "city", type_name: "text" }],
            rows: [[{ Int: 1 }, { Text: "KL" }], [{ Int: 2 }, { Text: "Penang" }]],
            row_count: 2,
            elapsed_ms: 1,
            error: null,
            cancelled: false,
          };
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
const page = await browser.newPage({ viewport: { width: 1280, height: 860 }, deviceScaleFactor: 2 });
page.on("pageerror", (e) => console.error("pageerror:", e.message));
await page.addInitScript({ path: FRAMES_SHIM });
await page.addInitScript(stubTauri);
await page.goto(URL);
const ws = '[data-testid="workspace"]:not([hidden])';
const connected = () => page.waitForSelector(`${ws}[data-conn-state="connected"]`);
await connected();
await page.waitForTimeout(300);

const sheet = "[data-shortcuts]";
const openSheet = async () => {
  await page.keyboard.press("Control+Shift+Slash");
  await page.waitForSelector(sheet);
};
const closeSheet = async () => {
  await page.keyboard.press("Escape");
  await page.waitForSelector(sheet, { state: "detached" });
};
const used = () => page.$eval("[data-used-count]", (e) => [Number(e.dataset.usedCount), Number(e.dataset.usedTotal)]);
const row = (id) =>
  page.$eval(`[data-shortcut="${id}"]`, (e) => ({ keys: e.dataset.keys, used: e.hasAttribute("data-used"), remapped: e.hasAttribute("data-remapped"), static: e.hasAttribute("data-static") })).catch(() => null);
const tabCount = () => page.$$eval(`${ws} [data-testid="query-tab"][data-reorder-key]`, (els) => els.length);

// 1 · Generated from the registry.
await openSheet();
const [n0, total] = await used();
check(n0 === 1 && total > 20, `fresh install: Used ${n0} of ${total} (the ⇧⌘/ that opened it)`);
check((await page.textContent("[data-used-count]")) === `Used 1 of ${total}`, "the header reads Used 1 of n");
check((await row("keyboard-shortcuts"))?.used, "Keyboard shortcuts is the used one");
const anchors = await page.$$eval("[data-anchor]", (els) => els.map((e) => e.dataset.anchor));
check(anchors.join() === "Connection,Query,Editor,Grid,Schema panel,View,Navigate,Windows,Help", `sections in order: ${anchors.join(", ")}`);
const want = {
  run: "Ctrl+↵",
  cancel: "Ctrl+.",
  "switch-connection": "Ctrl+Shift+O",
  "show-structure": "Ctrl+Alt+2",
  "history-back": "Alt+←",
  "keyboard-shortcuts": "Ctrl+Shift+/",
  "command-palette": "Ctrl+K",
  complete: "Ctrl+Space",
  "filter-schema": "/",
};
for (const [id, keys] of Object.entries(want)) check((await row(id))?.keys === keys, `${id} reads ${keys} (${(await row(id))?.keys})`);
check((await row("copy-cells"))?.static && (await row("grid-extend"))?.keys === "Shift+click/arrows", "gesture rows are static, with their keys");
check((await page.$$('[data-shortcut="copy-cells"] [data-testid="ks-dot"]')).length === 0, "static rows have no used dot");
await page.screenshot({ path: `${OUT}/1-fresh.png` });
await closeSheet();

// 2 · Used keys brighten.
await page.keyboard.press("Control+b");
await page.waitForTimeout(200);
await page.keyboard.press("Control+b");
await page.click(`${ws} textarea[data-testid="sql-editor"]`);
await page.keyboard.press("Control+Enter");
await page.waitForTimeout(300);
await page.keyboard.press("Control+k");
await page.waitForSelector('[data-testid="cp-panel"]');
// A ⌘K pick of New query tab runs it, but it isn't a key press.
await page.keyboard.type(">new query tab");
await page.keyboard.press("Enter");
await page.waitForTimeout(300);
await openSheet();
let [n1] = await used();
check(n1 === 4, `four shortcuts used (${n1}): ⇧⌘/, Ctrl+B, Ctrl+↵, Ctrl+K`);
for (const id of ["toggle-sidebar", "run", "command-palette"]) check((await row(id))?.used, `${id} is bright`);
check(!(await row("new-tab"))?.used, "the ⌘K pick of New query tab doesn't count");
check(!(await row("refresh-schema"))?.used, "an unused one stays dim");
const colors = await page.$eval('[data-shortcut="run"] [data-testid="ks-label"]', (e) => getComputedStyle(e).color);
const dim = await page.$eval('[data-shortcut="refresh-schema"] [data-testid="ks-label"]', (e) => getComputedStyle(e).color);
check(colors !== dim, `used reads brighter (${colors} vs ${dim})`);
await page.screenshot({ path: `${OUT}/2-used.png` });
await closeSheet();
// Relaunch: the counts stay.
await page.waitForTimeout(1300);
await page.reload();
await connected();
await openSheet();
[n1] = await used();
check(n1 === 4, `after a relaunch still Used ${n1} of ${total}`);
const saved = await page.evaluate(() => JSON.parse(localStorage.getItem("rowkery.usedKeys") ?? "{}"));
check(saved.run === 1 && saved["toggle-sidebar"] === 2, `usedKeys counts presses (${JSON.stringify(saved)})`);

// 3 · Search, anchors, Esc.
await page.keyboard.type("struct");
const found = await page.$$eval("[data-shortcut]", (els) => els.map((e) => e.dataset.shortcut));
check(found.join() === "show-structure", `typing "struct" leaves Show structure (${found})`);
await page.keyboard.press("Escape");
check((await page.inputValue('[data-testid="ks-filter"]')) === "" && !!(await page.$(sheet)), "Esc clears the search first");
await page.keyboard.type("hotkeys");
check((await page.$$eval("[data-shortcut]", (els) => els.map((e) => e.dataset.shortcut))).join() === "keyboard-shortcuts", "a synonym finds Keyboard shortcuts");
await page.keyboard.press("Escape");
await page.click('[data-anchor="Grid"]');
await page.waitForTimeout(100);
const top = await page.evaluate(() => {
  const list = document.querySelector('[data-testid="ks-list"]');
  const sec = document.querySelector('[data-section="Grid"]');
  return Math.abs(sec.getBoundingClientRect().top - list.getBoundingClientRect().top);
});
check(top < 4, `the Grid anchor scrolled to its section (${top}px)`);
check((await page.getAttribute('[data-anchor="Grid"]', "data-on")) === "", "and lights its anchor");
await page.screenshot({ path: `${OUT}/3-anchor.png` });
await closeSheet();

// 4 · ? in the grid and the panel, not in the editor.
await page.click(`${ws} [data-testid="sb-row-main"]`);
await page.waitForSelector(`${ws} [data-testid="results-grid-wrap"]`);
await page.waitForTimeout(300);
await page.click(`${ws} [data-testid="results-grid-wrap"] [role="gridcell"], ${ws} [data-testid="results-grid-wrap"] [data-col]`);
await page.keyboard.press("Shift+Slash");
check(!!(await page.waitForSelector(sheet, { timeout: 1500 }).catch(() => null)), "? in the grid opens the sheet");
await closeSheet();
await page.focus(`${ws} [data-testid="sb-row-main"]`);
await page.keyboard.press("Shift+Slash");
check(!!(await page.waitForSelector(sheet, { timeout: 1500 }).catch(() => null)), "? on a schema panel row opens it");
await closeSheet();
await page.click(`${ws} [data-testid="sb-filter"] input`);
await page.keyboard.press("Shift+Slash");
await page.waitForTimeout(200);
check(!(await page.$(sheet)) && (await page.inputValue(`${ws} [data-testid="sb-filter"] input`)) === "?", "? in the filter box types it");
await page.keyboard.press("Escape");
// The schema column's Help row opens the sheet.
const helpKeys = await page.getAttribute(`${ws} [data-testid="sb-help"]`, "title");
check(helpKeys.includes("Ctrl+Shift+/"), `the Help row's tooltip prints ${helpKeys}`);
await page.click(`${ws} [data-testid="sb-help"]`);
await page.waitForSelector(sheet);
await closeSheet();

// 5 · Keymap: TablePlus.
await openSheet();
await page.click("[data-keymap-picker]");
await page.screenshot({ path: `${OUT}/4-keymap-menu.png` });
await page.click('[data-keymap-option="tableplus"]');
check((await page.getAttribute(sheet, "data-keymap")) === "tableplus", "the sheet now reads TablePlus");
check((await row("new-tab"))?.keys === "Ctrl+T" && (await row("new-tab"))?.remapped, "New query tab: Ctrl+T, marked");
check((await row("new-window"))?.keys === "Ctrl+Alt+T", "New window moves to Ctrl+Alt+T");
check((await row("show-structure"))?.keys === "Ctrl+Alt+]", "Show structure: Ctrl+Alt+]");
check((await row("run"))?.keys === "Ctrl+↵" && !(await row("run"))?.remapped, "Run keeps Rowkery's chord");
const remapped = await page.$$eval("[data-remapped]", (els) => els.length);
check(remapped === 4, `only the colliding chords move (${remapped})`);
await page.screenshot({ path: `${OUT}/5-tableplus.png` });
await closeSheet();
check((await page.getAttribute('[data-testid="win-add"]', "title")) === "Open a new window  Ctrl+Alt+T", `the rail's + tooltip follows (${await page.getAttribute('[data-testid="win-add"]', "title")})`);
const tiles = await page.$$eval('[data-testid="win-tab"]', (els) => els.length);
const tabs0 = await tabCount();
await page.keyboard.press("Control+t");
await page.waitForTimeout(300);
check((await tabCount()) === tabs0 + 1 && (await page.$$eval('[data-testid="win-tab"]', (els) => els.length)) === tiles, "Ctrl+T opened a query tab, not a window");
await page.keyboard.press("Control+k");
await page.waitForSelector('[data-testid="cp-panel"]');
await page.keyboard.type(">new query tab");
await page.waitForSelector('[data-item="cmd:new-tab"]');
check((await page.$eval('[data-item="cmd:new-tab"] [data-keys]', (e) => e.textContent)) === "Ctrl+T", "⌘K prints Ctrl+T for New query tab");
await page.keyboard.press("Escape");
await page.keyboard.press("Escape");
await page.waitForTimeout(1300);
await page.reload();
await connected();
await openSheet();
check((await page.getAttribute(sheet, "data-keymap")) === "tableplus", "the keymap survives a relaunch");
check((await row("new-tab"))?.used, "and Ctrl+T counted as New query tab");
await page.click("[data-keymap-picker]");
await page.click('[data-keymap-option="rowkery"]');
check((await row("new-window"))?.keys === "Ctrl+T", "back to Rowkery: New window is Ctrl+T again");
await closeSheet();

await browser.close();
