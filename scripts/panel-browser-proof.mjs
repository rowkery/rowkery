#!/usr/bin/env node
// The switchers' popovers float in a portal above every column ([data-floating]), not inside the chip.
// Schema panel resize and hide (stubbed `invoke`): the panel starts at 264
// px (Paper, 2026-10-10); dragging its right edge resizes it live
// and clamps to 240–360; the width is saved (config.json via save_ui_state)
// and comes back on relaunch; double-click returns it to 264. ⌃⌘S (Ctrl+Alt+S here) hides it: the
// connection / database switchers and the environment tag appear at the tab
// row's left, ⇧⌘O opens the connection picker from there and the panel
// stays hidden; "/" brings the panel back and the identity text goes.
//
//   cd apps/rowkery-tauri && npx vite --port 1420 &
//   node scripts/panel-browser-proof.mjs [outDir]
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
const OUT = process.argv[2] ?? "/tmp/rowkery-proof/panel";
const URL = process.env.ROWKERY_DEV_URL ?? "http://localhost:1420/";
mkdirSync(OUT, { recursive: true });

function stubTauri() {
  // The saved UI state survives the reload (a relaunch), nothing else does.
  if (!sessionStorage.getItem("booted")) {
    localStorage.clear();
    sessionStorage.setItem("booted", "1");
  }
  const table = (name) => ({ name, columns: [{ name: "id", type_name: "int8", nullable: false }], primary_key: ["id"], indexes: [], foreign_keys: [], row_estimate: { Approximate: 10 }, partition_of: null });
  window.__TAURI_INTERNALS__ = {
    metadata: { currentWindow: { label: "main" }, currentWebview: { label: "main" } },
    transformCallback: () => 0,
    invoke: async (cmd, args) => {
      switch (cmd) {
        case "save_ui_state":
          sessionStorage.setItem("ui", JSON.stringify(args.ui));
          return null;
        case "load_ui_state":
          return JSON.parse(sessionStorage.getItem("ui") ?? "null");
        case "list_connections":
          return {
            connections: [
              { kind: "postgres", id: "pg", name: "wallet-prd", host: "db.example", port: 5432, database: "wallet", username: "rowkery", environment: "prd" },
              { kind: "postgres", id: "pg2", name: "analytics", host: "127.0.0.1", port: 5432, database: "events", username: "rowkery" },
            ],
            active_connection_id: null,
          };
        case "open_window":
          return { database: "wallet", catalog: { databases: [{ name: "wallet", schemas: [{ name: "public", tables: [table("wallet_transactions_2026_reconciliation"), table("players")] }] }] }, elapsed_ms: 3, cached: false, open_seq: 1 };
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
await page.addInitScript({ path: LINUX_PLATFORM });
await page.addInitScript(stubTauri);
await page.goto(URL);
const ws = '[data-testid="workspace"]:not([hidden])';
await page.waitForSelector('[data-testid="workspace"]:not([hidden])'); // Paper (2026-10-10): an empty window shows no connection chip (no tab row without a connection); wait for the window, then ⇧⌘O as before.
await page.keyboard.press("Control+Shift+O");
await page.waitForSelector('[data-testid="conn-popover"]');
await page.keyboard.press("Enter");
await page.waitForSelector(`${ws}[data-conn-state="connected"]`);
await page.waitForTimeout(300);

const panelWidth = () => page.$eval(`${ws} [data-testid="sidebar"]`, (el) => Math.round(el.getBoundingClientRect().width));
const mainLeft = () => page.$eval(`${ws} [data-testid="main"]`, (el) => Math.round(el.getBoundingClientRect().left));
const attr = () => page.getAttribute('[data-testid="app-frame"]', "data-panel-width");
check((await panelWidth()) === 264 && (await attr()) === "264", `the panel starts at 264 px (${await panelWidth()})`);
const left0 = await mainLeft();

const drag = async (dx, { midShot } = {}) => {
  const box = await page.locator("[data-panel-resizer]").boundingBox();
  const x = box.x + box.width / 2;
  const y = box.y + box.height / 2;
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(x + dx / 2, y, { steps: 4 });
  if (midShot) await page.screenshot({ path: midShot });
  await page.mouse.move(x + dx, y, { steps: 4 });
  await page.mouse.up();
  await page.waitForTimeout(50);
};

await drag(56, { midShot: `${OUT}/1-resizing.png` });
check((await panelWidth()) === 320 && (await attr()) === "320", `dragging the edge 56 px makes it 320 (${await panelWidth()})`);
check((await mainLeft()) === left0 + 56, "the main column follows, live");
await drag(200);
check((await panelWidth()) === 360, `clamped at 360 (${await panelWidth()})`);
await drag(-400);
check((await panelWidth()) === 240, `clamped at 240 (${await panelWidth()})`);
await drag(60);
await page.screenshot({ path: `${OUT}/2-wide-300.png` });
const clipped = await page.$$eval(`${ws} [data-testid="sb-head-switch"] [data-testid="conn-chip-name"]`, (els) => els.filter((e) => e.scrollWidth > e.clientWidth).length);
check(clipped === 0, `the panel head shows whole names when they fit (${clipped} clipped)`);

// Relaunch: the width comes back from the saved state.
await page.waitForTimeout(1300);
await page.reload();
await page.waitForSelector(`${ws} [data-testid="sidebar"]`);
await page.waitForTimeout(300);
check((await panelWidth()) === 300 && (await attr()) === "300", `relaunch restores 300 px (${await panelWidth()})`);
await page.dblclick("[data-panel-resizer]");
check((await panelWidth()) === 264, "double-click returns to 264");
await page.keyboard.press("Control+Shift+O");
await page.waitForSelector('[data-testid="conn-popover"]');
await page.keyboard.press("Enter");
await page.waitForSelector(`${ws}[data-conn-state="connected"]`);
await page.waitForTimeout(200);

// Hide: the identity text at the tab row's left.
check((await page.$(`${ws} [data-identity]`)) === null, "no identity text while the panel shows");
await page.keyboard.press("Control+Alt+S");
await page.waitForSelector(`${ws} [data-identity]`);
await page.waitForTimeout(400);
const ident = (await page.textContent(`${ws} [data-identity]`)).replace(/\s+/g, " ").trim();
check(/wallet-prd/.test(ident) && /wallet/.test(ident) && /prd/.test(ident), `identity reads connection / database and the env tag (${ident})`);
check((await page.$("[data-panel-resizer]")) === null, "no resizer while hidden");
await page.screenshot({ path: `${OUT}/3-hidden-identity.png` });
await page.keyboard.press("Control+Shift+O");
await page.waitForSelector(`[data-floating] [data-testid="conn-popover"]`);
check((await page.getAttribute('[data-testid="app-frame"]', "class")).includes("sidebar-hidden"), "⇧⌘O opens the picker from the identity text; the panel stays hidden");
await page.screenshot({ path: `${OUT}/4-picker-from-identity.png` });
await page.keyboard.press("Escape");
await page.waitForTimeout(150);

// "/" brings the panel back with the filter focused; the identity goes.
await page.click(`${ws} [data-testid="results-card"]`, { position: { x: 200, y: 200 } }).catch(() => {});
await page.keyboard.press("/");
await page.waitForFunction(() => !document.querySelector('[data-testid="app-frame"]').hasAttribute("data-sidebar-hidden"));
await page.waitForFunction((ws) => !document.querySelector(`${ws} [data-identity]`), ws, { timeout: 2000 }).catch(() => {});
check((await page.$(`${ws} [data-identity]`)) === null, "/ shows the panel and the identity text goes");
await browser.close();
