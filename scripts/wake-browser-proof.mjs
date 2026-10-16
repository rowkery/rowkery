#!/usr/bin/env node
// Waking up (stubbed `invoke`): when the webview regains focus or becomes
// visible, every connected window asks core to check its idle sessions
// (`ping_idle`), so the first query after a laptop sleep finds a live one.
// A window that never connected is left alone.
//
//   cd apps/rowkery-tauri && npx vite --port 1420 &
//   node scripts/wake-browser-proof.mjs
import { createRequire } from "node:module";
import { execSync } from "node:child_process";

const LINUX_PLATFORM = new globalThis.URL("./lib/linux-platform.js", import.meta.url).pathname;

const require = createRequire(import.meta.url);
let playwright;
try {
  playwright = require("playwright");
} catch {
  playwright = require(`${execSync("npm root -g").toString().trim()}/playwright`);
}
const URL = process.env.ROWKERY_DEV_URL ?? "http://localhost:1420/";

function stubTauri() {
  localStorage.clear();
  window.__PINGS__ = [];
  const table = { name: "t", columns: [{ name: "id", type_name: "int8", nullable: false }], primary_key: ["id"], indexes: [], foreign_keys: [], row_estimate: { Approximate: 1 }, partition_of: null };
  window.__TAURI_INTERNALS__ = {
    metadata: { currentWindow: { label: "main" }, currentWebview: { label: "main" } },
    transformCallback: () => 0,
    invoke: async (cmd, args) => {
      if (cmd === "ping_idle") window.__PINGS__.push(args.windowId);
      if (cmd === "list_connections")
        return { connections: [{ kind: "postgres", id: "pg", name: "wallet", host: "127.0.0.1", port: 5432, database: "rowkery", username: "rowkery" }], active_connection_id: null };
      if (cmd === "open_window") return { database: "rowkery", catalog: { databases: [{ name: "rowkery", schemas: [{ name: "public", tables: [table] }] }] }, elapsed_ms: 2 };
      return null;
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
const page = await browser.newPage();
await page.addInitScript({ path: LINUX_PLATFORM });
await page.addInitScript(stubTauri);
await page.goto(URL);
await page.waitForSelector('[data-testid="workspace"]:not([hidden])'); // Paper (2026-10-10): an empty window shows no connection chip (no tab row without a connection); wait for the window, then ⇧⌘O as before.
const pings = () => page.evaluate(() => window.__PINGS__);
await page.evaluate(() => window.dispatchEvent(new Event("focus")));
await page.waitForTimeout(100);
check((await pings()).length === 0, "no connected window: focus pings nothing");
await page.keyboard.press("Control+Shift+O");
await page.waitForSelector('[data-testid="conn-popover"]');
await page.keyboard.press("Enter");
await page.waitForSelector('[data-testid="workspace"]:not([hidden])[data-conn-state="connected"]');
await page.evaluate(() => window.dispatchEvent(new Event("focus")));
await page.waitForTimeout(100);
check(JSON.stringify(await pings()) === '["w1"]', `focus pings the connected window (${JSON.stringify(await pings())})`);
await page.evaluate(() => document.dispatchEvent(new Event("visibilitychange")));
await page.waitForTimeout(100);
check((await pings()).length === 2, "becoming visible pings it again");
await browser.close();
