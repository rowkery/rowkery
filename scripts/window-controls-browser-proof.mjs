#!/usr/bin/env node
// Linux / Windows window chrome (stubbed `invoke`). By default the page draws
// its own window buttons in the title bar; ⌘K "Use system window
// controls (next launch)" saves `native_decorations` and says it applies on
// the next launch, leaving this window's buttons as they are; the title then
// offers the way back. A launch created with system decorations
// (`window_chrome` native) draws no buttons and keeps no room for them: the
// title bar's first pill sits where the buttons would be.
//
//   cd apps/rowkery-tauri && npx vite --port 1420 &
//   node scripts/window-controls-browser-proof.mjs [outDir]
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
const OUT = process.argv[2] ?? "/tmp/rowkery-proof/window-controls";
const URL = process.env.ROWKERY_DEV_URL ?? "http://localhost:1420/";
const FRAMES_SHIM = new globalThis.URL("./lib/frames-shim.js", import.meta.url).pathname;
mkdirSync(OUT, { recursive: true });

function stubTauri(native) {
  localStorage.clear();
  window.__CALLS__ = [];
  let saved = native;
  const col = (name) => ({ name, type_name: "TEXT", nullable: false });
  const tables = [{ name: "entities", kind: "table", columns: [col("id")], primary_key: ["id"], indexes: [], foreign_keys: [], row_estimate: { Approximate: 1800 }, partition_of: null }];
  window.__TAURI_INTERNALS__ = {
    metadata: { currentWindow: { label: "main" }, currentWebview: { label: "main" } },
    transformCallback: () => 0,
    invoke: async (cmd, args) => {
      window.__CALLS__.push([cmd, args]);
      switch (cmd) {
        case "window_chrome":
          return { native, saved };
        case "set_native_decorations":
          saved = args.on;
          return null;
        case "list_connections":
          return {
            connections: [{ kind: "postgres", id: "dev", name: "Midway dev", host: "db", port: 5432, database: "midway", username: "app", environment: "dev" }],
            active_connection_id: null,
          };
        case "open_window":
          return { database: "midway", catalog: { databases: [{ name: "midway", schemas: [{ name: "public", tables }] }] }, elapsed_ms: 2, cached: false, open_seq: 1 };
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

async function open(native) {
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 }, deviceScaleFactor: 2 });
  page.on("pageerror", (e) => console.error("pageerror:", e.message));
  await page.addInitScript({ path: FRAMES_SHIM });
  await page.addInitScript(stubTauri, native);
  await page.goto(URL);
  await page.waitForSelector('[data-testid="workspace"]:not([hidden])'); // Paper (2026-10-10): an empty window shows no connection chip (no tab row without a connection); wait for the window, then ⇧⌘O as before.
  await page.keyboard.press("Control+Shift+O");
  await page.waitForSelector('[data-testid="conn-popover"]');
  await page.keyboard.press("Enter");
  await page.waitForSelector('[data-testid="workspace"]:not([hidden])[data-conn-state="connected"]');
  return page;
}

const paletteRow = async (page) => {
  await page.keyboard.press("Control+k");
  await page.waitForSelector('[data-testid="cp-panel"]');
  await page.keyboard.type(">window controls");
  const row = await page.$('[data-item="cmd:window-controls"]');
  return row ? (await row.textContent()).trim() : null;
};

// 1. The default: our buttons in the title bar's corner.
let page = await open(false);
check(await page.evaluate(() => window.__CALLS__.some(([c]) => c === "window_chrome")), "the page asks how the window was created");
check((await page.$$('[data-testid="traffic"] [data-testid="traffic-btn"]')).length === 3, "drawn close / minimize / maximize");
// Class on purpose: the root class switches the chrome styling under test.
check(!(await page.evaluate(() => document.documentElement.classList.contains("native-decorations"))), "no native-decorations class");
// The buttons sit in the 48 px title bar, left of the
// first window pill and level with it.
const drawn = await page.evaluate(() => {
  const mid = (r) => Math.round(r.top + r.height / 2);
  const t = document.querySelector('[data-testid="traffic"]').getBoundingClientRect();
  const p = document.querySelector('[data-testid="win-tab"]').getBoundingClientRect();
  return { tRight: Math.round(t.right), pLeft: Math.round(p.left), tMid: mid(t), pMid: mid(p) };
});
check(drawn.pLeft >= drawn.tRight + 8 && drawn.tMid === 24 && drawn.pMid === 24, `the first pill sits right of the buttons, both level in the bar (${JSON.stringify(drawn)})`);
await page.screenshot({ path: `${OUT}/1-drawn-controls.png` });

// 2. ⌘K saves the switch for the next launch; this window keeps its buttons.
let title = await paletteRow(page);
check(title === "Use system window controls (next launch)", `⌘K offers: ${title}`);
await page.screenshot({ path: `${OUT}/2-palette.png` });
await page.keyboard.press("Enter");
await page.waitForSelector('[data-testid="toast-message"]');
const toast = await page.textContent('[data-testid="toast-message"]');
check(toast === "System window controls from the next launch", `toast: ${toast}`);
const set = await page.evaluate(() => window.__CALLS__.filter(([c]) => c === "set_native_decorations").map(([, a]) => a.on));
check(set.join() === "true", "saved native_decorations on");
check((await page.$$('[data-testid="traffic"] [data-testid="traffic-btn"]')).length === 3, "this launch keeps the drawn buttons");
await page.screenshot({ path: `${OUT}/3-saved-toast.png` });
await page.waitForSelector('[data-testid="cp-panel"]', { state: "detached" });
title = await paletteRow(page);
check(title === "Use Rowkery window controls (next launch)", `then ⌘K offers the way back: ${title}`);
await page.keyboard.press("Enter");
await page.waitForFunction(() => document.querySelector('[data-testid="toast-message"]')?.textContent === "The next launch keeps these window controls");
check(true, "picking it again says the next launch keeps these controls");
await page.close();

// 3. A launch with system decorations: no corner, no gap.
page = await open(true);
check(await page.evaluate(() => document.documentElement.classList.contains("native-decorations")), "native-decorations class on the root");
check((await page.$('[data-testid="traffic-zone"]')) === null, "no drawn buttons, no corner drag zone");
const native = await page.$eval('[data-testid="win-tab"]', (e) => {
  const r = e.getBoundingClientRect();
  return { left: Math.round(r.left), mid: Math.round(r.top + r.height / 2) };
});
check(native.left <= 30 && native.mid === 24, `the first pill moves into the buttons' room, level in the bar (${JSON.stringify(native)})`);
const frame = await page.$eval('[data-testid="app-frame"]', (e) => getComputedStyle(e).borderTopLeftRadius);
check(frame === "0px", "the frame is square under the title bar");
await page.screenshot({ path: `${OUT}/4-native.png` });
// Hiding the panel keeps the layout whole.
await page.keyboard.press("Control+Alt+s");
await page.waitForSelector('[data-testid="app-frame"][data-sidebar-hidden]');
await page.waitForTimeout(500); // the panel slides out
await page.screenshot({ path: `${OUT}/5-native-panel-hidden.png` });
check((await page.$eval('[data-testid="win-tab"]', (e) => Math.round(e.getBoundingClientRect().left))) === native.left, "the title bar stays put with the panel hidden");
title = await paletteRow(page);
check(title === "Use Rowkery window controls (next launch)", `⌘K offers the drawn controls back: ${title}`);
await browser.close();
