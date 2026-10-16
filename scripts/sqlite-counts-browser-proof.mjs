#!/usr/bin/env node
// SQLite row counts arrive after the catalog (stubbed `invoke`): a SQLite
// window lists its tables at once without counts, then `table_counts`
// fills them in (data-rows on each sidebar row); a Postgres window never
// asks; a refresh counts again.
//
//   cd apps/rowkery-tauri && npx vite --port 1420 &
//   node scripts/sqlite-counts-browser-proof.mjs
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
  window.__COUNTS__ = [];
  window.__ITEMS__ = 2;
  const table = (name, kind = "table") => ({ name, kind, columns: [{ name: "id", type_name: "INTEGER", nullable: false }], primary_key: ["id"], indexes: [], foreign_keys: [], row_estimate: "Unknown", partition_of: null });
  window.__TAURI_INTERNALS__ = {
    metadata: { currentWindow: { label: "main" }, currentWebview: { label: "main" } },
    transformCallback: () => 0,
    invoke: async (cmd, args) => {
      switch (cmd) {
        case "list_connections":
          return {
            connections: [
              { kind: "sqlite", id: "lite", name: "notes.sqlite", path: "/tmp/notes.sqlite" },
              { kind: "postgres", id: "pg", name: "arcade", host: "127.0.0.1", port: 54329, database: "rowkery", username: "rowkery" },
            ],
            active_connection_id: null,
          };
        case "open_window":
        case "reload_window_schema": {
          const catalog = { databases: [{ name: "main", schemas: [{ name: "main", tables: [table("items"), table("big"), table("recent", "view")] }] }] };
          return cmd === "open_window" ? { database: "main", catalog, elapsed_ms: 1, cached: false, open_seq: 1 } : catalog;
        }
        case "table_counts":
          window.__COUNTS__.push(args.windowId);
          await new Promise((r) => setTimeout(r, 150));
          return [
            { database: "main", table: "items", rows: { Exact: window.__ITEMS__ } },
            { database: "main", table: "big", rows: "Unknown" },
          ];
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
const page = await browser.newPage();
page.on("pageerror", (e) => console.error("pageerror:", e.message));
await page.addInitScript({ path: LINUX_PLATFORM });
await page.addInitScript(stubTauri);
await page.goto(URL);
const ws = '[data-testid="workspace"]:not([hidden])';
await page.waitForSelector('[data-testid="workspace"]:not([hidden])'); // Paper (2026-10-10): an empty window shows no connection chip (no tab row without a connection); wait for the window, then ⇧⌘O as before.
const pick = async (id) => {
  await page.keyboard.press("Control+Shift+O");
  await page.waitForSelector('[data-testid="conn-popover"]');
  await page.click(`[data-testid="conn-popover"] [data-conn-id="${id}"]`);
};
const rows = (t) =>
  page.evaluate(([ws, t]) => document.querySelector(`${ws} [data-table="main.main.${t}"] [data-rows]`)?.getAttribute("data-rows") ?? null, [ws, t]);

await pick("lite");
await page.waitForSelector(`${ws} [data-table="main.main.items"]`);
check((await rows("items")) === null, "tables listed at once, before any count");
await page.waitForSelector(`${ws} [data-table="main.main.items"] [data-rows]`);
check((await rows("items")) === "2", "then table_counts fills items: 2");
check((await rows("big")) === null && (await rows("recent")) === null, "over the cap and views stay without a count");
check((await page.evaluate(() => window.__COUNTS__.length)) === 1, "one table_counts call");

await page.evaluate(() => (window.__ITEMS__ = 3));
await page.keyboard.press("Control+r");
await page.waitForFunction((ws) => document.querySelector(`${ws} [data-table="main.main.items"] [data-rows]`)?.getAttribute("data-rows") === "3", ws);
check(true, "a schema refresh counts again (items: 3)");

await pick("pg");
await page.waitForSelector(`${ws}[data-conn-state="connected"]`);
await page.waitForTimeout(300);
check((await page.evaluate(() => window.__COUNTS__.length)) === 2, "a Postgres window never asks for counts");
await browser.close();
