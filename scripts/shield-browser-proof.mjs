#!/usr/bin/env node
// The safe-mode shield (stubbed `invoke`): an icon at the right end of the
// schema panel head (bare when Off) opens a three-item menu — Off, Confirm
// writes, Read-only, the current one checked, a footer saying the database
// enforces Read-only — never a cycler. Picking saves the connection with
// empty secrets (keychain kept) and toasts; Esc or a second click closes
// without a change. ⌘K "Change safe mode…" and a Read-only refusal's
// "Change safe mode…" open the same menu; with the panel hidden it opens
// under the shield too (in the title bar since 2026-10-13). The label beside Run is gone.
//
//   cd apps/rowkery-tauri && npx vite --port 1420 &
//   node scripts/shield-browser-proof.mjs [outDir]
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
const OUT = process.argv[2] ?? "/tmp/rowkery-proof/shield";
const URL = process.env.ROWKERY_DEV_URL ?? "http://localhost:1420/";
const FRAMES_SHIM = new globalThis.URL("./lib/frames-shim.js", import.meta.url).pathname;
mkdirSync(OUT, { recursive: true });

function stubTauri() {
  localStorage.clear();
  window.__SAVES__ = [];
  const conn = { kind: "postgres", id: "pg", name: "wallet-prd", host: "db.example", port: 5432, database: "wallet", username: "rowkery", environment: "prd", safe_mode: "off" };
  const table = { name: "wallets", columns: [{ name: "id", type_name: "int8", nullable: false }], primary_key: ["id"], indexes: [], foreign_keys: [], row_estimate: { Approximate: 10 }, partition_of: null };
  window.__TAURI_INTERNALS__ = {
    metadata: { currentWindow: { label: "main" }, currentWebview: { label: "main" } },
    transformCallback: () => 0,
    invoke: async (cmd, args) => {
      switch (cmd) {
        case "list_connections":
          return { connections: [{ ...conn }], active_connection_id: null };
        case "save_connection":
          window.__SAVES__.push({ mode: args.connection.safe_mode, secrets: args.secrets });
          conn.safe_mode = args.connection.safe_mode;
          return null;
        case "open_window":
          return { database: "wallet", catalog: { databases: [{ name: "wallet", schemas: [{ name: "public", tables: [table] }] }] }, elapsed_ms: 3, cached: false, open_seq: 1 };
        case "run_query": {
          const write = /^\s*delete/i.test(args.sql);
          if (write && conn.safe_mode === "read_only")
            return { hold: { action: "refuse", mode: "read_only", statements: [{ kind: "write", verb: "DELETE", target: "wallets", destructive: true, unlocks_writes: false }] } };
          return { columns: [{ name: "n", type_name: "int4" }], rows: [[{ Int: 1 }]], row_count: 1, elapsed_ms: 1, error: null, cancelled: false };
        }
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
const menu = '[data-menu="safe-mode"]';
await page.waitForSelector('[data-testid="workspace"]:not([hidden])'); // Paper (2026-10-10): an empty window shows no connection chip (no tab row without a connection); wait for the window, then ⇧⌘O as before.
await page.keyboard.press("Control+Shift+O");
await page.waitForSelector('[data-testid="conn-popover"]');
await page.keyboard.press("Enter");
await page.waitForSelector(`${ws}[data-conn-state="connected"]`);
await page.waitForTimeout(200);

// Safe mode sits in the title bar, for the shown window.
const shield = '[data-testid="titlebar"] [data-shield]';
check((await page.getAttribute(shield, "data-shield")) === "off", "a shield in the title bar, Off");
check((await page.getAttribute(shield, "title")) === "Safe mode: Off · Change…", "tooltip: Safe mode: Off · Change…");
check((await page.$(`${ws} .composer-safe`)) === null, "no safe-mode label beside Run");

await page.click(shield);
await page.waitForSelector(menu);
const rows = await page.$$eval(`${menu} [data-item]`, (els) => els.map((e) => `${e.dataset.item}:${e.getAttribute("aria-checked")}:${e.textContent.replace("✓", "").trim()}`));
check(rows.join("|") === "off:true:Off|confirm:false:Confirm writes|read_only:false:Read-only", `three rows, the current one checked (${rows.join(" | ")})`);
check((await page.textContent(`${menu} [data-testid="grid-menu-footer"]`)) === "The database enforces Read-only. Environment never changes this.", "footer line");
await page.screenshot({ path: `${OUT}/1-shield-menu.png` });

// Esc and a second click close it, changing nothing.
await page.keyboard.press("Escape");
await page.waitForFunction((m) => !document.querySelector(m), menu);
await page.click(shield);
await page.waitForSelector(menu);
await page.click(shield);
await page.waitForTimeout(250);
check((await page.$(menu)) === null && (await page.evaluate(() => window.__SAVES__.length)) === 0, "Esc or a second click closes it with nothing saved");

// Picking Confirm writes saves (empty secrets keep the keychain) and toasts.
await page.click(shield);
await page.click(`${menu} [data-item="confirm"]`);
await page.waitForFunction((s) => document.querySelector(s)?.dataset.shield === "confirm", shield);
const save = await page.evaluate(() => window.__SAVES__.at(-1));
check(save.mode === "confirm" && JSON.stringify(save.secrets) === "{}", `saved Confirm writes with empty secrets (${JSON.stringify(save)})`);
const toast = await page.$$eval("[data-toast] > span", (els) => els.map((e) => e.textContent.trim()).join(" · "));
check(toast === "Safe mode: Confirm writes · wallet-prd", `toast: ${toast}`);
check((await page.getAttribute(shield, "title")) === "Safe mode: Confirm writes · Change…", "tooltip follows the mode");

// ⌘K "Change safe mode…" opens the same menu, now with Confirm writes checked.
// Keyboard only: keep the pointer off the menu so hover doesn't move the cursor.
await page.mouse.move(900, 700);
await page.keyboard.press("Control+k");
await page.keyboard.type("change safe mode");
await page.waitForSelector('[data-testid="cp-row"][data-item="cmd:change-safe-mode"]');
await page.keyboard.press("Enter");
await page.waitForSelector(menu);
check((await page.getAttribute(`${menu} [data-item="confirm"]`, "aria-checked")) === "true", "⌘K Change safe mode… opens the menu, Confirm writes checked");
await page.keyboard.press("ArrowDown");
await page.keyboard.press("ArrowDown");
await page.keyboard.press("ArrowDown");
await page.keyboard.press("Enter");
await page.waitForFunction((s) => document.querySelector(s)?.dataset.shield === "read_only", shield);
check(true, "↓↓↓ ↵ picks Read-only from the keyboard");
await page.screenshot({ path: `${OUT}/2-read-only.png` });

// A refusal's "Change safe mode…" opens the menu, not the sheet.
await page.click(`${ws} textarea[data-testid="sql-editor"]`);
await page.keyboard.press("ControlOrMeta+a");
await page.keyboard.type("DELETE FROM wallets;");
await page.keyboard.press("Control+Enter");
await page.waitForSelector(`${ws} [data-testid="safe-refuse"] button, ${ws} [data-testid="safe-btn"]`);
await page.click(`${ws} [data-testid="safe-btn"]`);
await page.waitForSelector(menu);
check((await page.$('[data-testid="nc-sheet"], .nc-panel')) === null, "the refusal's Change safe mode… opens the menu, no sheet");
await page.keyboard.press("Escape");
await page.waitForTimeout(150);

// Panel hidden: the menu still opens under the shield, which stays in the
// title bar.
await page.keyboard.press("Control+Alt+S");
await page.waitForSelector(`${ws} [data-identity]`);
await page.waitForTimeout(400);
await page.keyboard.press("Control+k");
await page.keyboard.type("change safe mode");
await page.waitForSelector('[data-testid="cp-row"][data-item="cmd:change-safe-mode"]');
await page.keyboard.press("Enter");
await page.waitForSelector(menu);
const [m, id] = await page.evaluate((menu) => [document.querySelector(menu).getBoundingClientRect(), document.querySelector('[data-testid="titlebar"] [data-shield]').getBoundingClientRect()].map((r) => ({ x: Math.round(r.left), y: Math.round(r.top), b: Math.round(r.bottom) })), menu);
check(m.x === id.x && m.y >= id.b && m.y <= id.b + 12, `panel hidden: under the title bar's shield (${JSON.stringify({ m, id })})`);
await page.screenshot({ path: `${OUT}/3-hidden-panel.png` });
await browser.close();
