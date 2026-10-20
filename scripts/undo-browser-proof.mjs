#!/usr/bin/env node
// Undo instead of confirm (stubbed `invoke`): closing a query tab, closing a
// window and deleting a connection happen at once, and the toast offers Undo
// (a button, and ⌥⌘Z — Ctrl+Alt+Z here) for 10 s. ⌘⇧T reopens the most
// recently closed tab with its SQL. Deleting a connection asks first (Keep /
// Delete in the sheet's foot; Esc backs out), then the record goes
// (delete_connection with keepSecrets), its windows empty but keep their
// tabs; Undo saves the record back with empty secrets (keychain kept); when
// the toast goes any other way the keychain entries are removed
// (forget_connection_secrets). ⌘Z in the editor stays text undo.
//
//   cd apps/rowkery-tauri && npx vite --port 1420 &
//   node scripts/undo-browser-proof.mjs [outDir]
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
const OUT = process.argv[2] ?? "/tmp/rowkery-proof/undo";
const URL = process.env.ROWKERY_DEV_URL ?? "http://localhost:1420/";
mkdirSync(OUT, { recursive: true });

function stubTauri() {
  localStorage.clear();
  window.__CALLS__ = [];
  const conns = [
    { kind: "postgres", id: "pg", name: "wallet-prd", host: "db.example", port: 5432, database: "wallet", username: "rowkery" },
    { kind: "postgres", id: "an", name: "analytics", host: "127.0.0.1", port: 5432, database: "events", username: "rowkery" },
  ];
  const table = { name: "events", columns: [{ name: "id", type_name: "int8", nullable: false }], primary_key: ["id"], indexes: [], foreign_keys: [], row_estimate: { Approximate: 10 }, partition_of: null };
  window.__TAURI_INTERNALS__ = {
    metadata: { currentWindow: { label: "main" }, currentWebview: { label: "main" } },
    transformCallback: () => 0,
    invoke: async (cmd, args) => {
      if (["delete_connection", "forget_connection_secrets", "save_connection"].includes(cmd)) window.__CALLS__.push({ cmd, ...args });
      switch (cmd) {
        case "list_connections":
          return { connections: conns.map((c) => ({ ...c })), active_connection_id: null };
        case "delete_connection": {
          const i = conns.findIndex((c) => c.id === args.id);
          if (i >= 0) conns.splice(i, 1);
          return null;
        }
        case "save_connection":
          if (!conns.some((c) => c.id === args.connection.id)) conns.push(args.connection);
          return null;
        case "open_window":
          return { database: args.connectionId === "an" ? "events" : "wallet", catalog: { databases: [{ name: "x", schemas: [{ name: "public", tables: [table] }] }] }, elapsed_ms: 2, cached: false, open_seq: 1 };
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

const calls = (cmd) => page.evaluate((cmd) => window.__CALLS__.filter((c) => c.cmd === cmd), cmd);
const toast = () => page.$$eval("[data-toast] > span", (els) => els.map((e) => e.textContent.trim()).join(" · ")).catch(() => "");
const waitToast = (text) => page.waitForFunction((t) => [...document.querySelectorAll("[data-toast] > span")].some((e) => e.textContent.includes(t)), text);
const tabs = () => page.$$eval(`${ws} [data-testid="query-tab"] [data-testid="query-tab-title"]`, (els) => els.map((e) => e.textContent));
const editor = () => page.$eval(`${ws} textarea[data-testid="sql-editor"]`, (el) => el.value);
const typeSql = async (sql) => {
  await page.click(`${ws} textarea[data-testid="sql-editor"]`);
  await page.keyboard.press("ControlOrMeta+a");
  await page.keyboard.type(sql);
};

// Two query tabs; close the second.
await typeSql("SELECT 1;");
await page.click(`${ws} [aria-label="New query tab"]`);
await typeSql("SELECT 2 AS kept;");
check((await tabs()).join("|") === "Query 1|Query 2", "two tabs");
await page.keyboard.press("Control+w");
await waitToast("Closed Query 2");
check((await toast()) === "Closed Query 2 with unsaved SQL", `toast: ${await toast()}`);
// The tab narrows away in 140 ms.
await page.waitForFunction((ws) => document.querySelectorAll(`${ws} [data-testid="query-tab"]`).length === 1, ws, { timeout: 1000 }).catch(() => {});
check((await page.$("[data-toast-undo]")) !== null && (await tabs()).join("|") === "Query 1", "closed at once, Undo offered");
await page.screenshot({ path: `${OUT}/1-closed-tab-undo.png` });
await page.click("[data-toast-undo]");
await page.waitForFunction((ws) => document.querySelectorAll(`${ws} [data-testid="query-tab"]`).length === 2, ws);
check((await tabs()).join("|") === "Query 1|Query 2" && (await editor()) === "SELECT 2 AS kept;", "Undo puts it back, active, with its SQL");

// ⌥⌘Z from anywhere.
await page.keyboard.press("Control+w");
await waitToast("Closed Query 2");
await page.keyboard.press("Control+Alt+z");
await page.waitForFunction((ws) => document.querySelectorAll(`${ws} [data-testid="query-tab"]`).length === 2, ws);
check((await editor()) === "SELECT 2 AS kept;", "⌥⌘Z (Ctrl+Alt+Z) does the same");

// ⌘Z in the editor is text undo, never the toast's.
await page.keyboard.press("Control+w");
await waitToast("Closed Query 2");
await page.click(`${ws} textarea[data-testid="sql-editor"]`);
await page.keyboard.press("End");
await page.keyboard.type(" --x");
await page.keyboard.press("Control+z");
await page.waitForTimeout(100);
check((await tabs()).join("|") === "Query 1", "⌘Z in the editor doesn't reopen the tab");

// ⌘⇧T: any time, from Recently closed.
await page.keyboard.press("Control+Shift+t");
await page.waitForFunction((ws) => document.querySelectorAll(`${ws} [data-testid="query-tab"]`).length === 2, ws);
await waitToast("Reopened");
check((await toast()) === "Reopened Query 2" && (await editor()) === "SELECT 2 AS kept;", "⌘⇧T reopens Query 2 with its SQL");
await page.keyboard.press("Control+k");
await page.keyboard.type("reopen");
await page.waitForTimeout(100);
check((await page.$('[data-testid="cp-row"][data-item="cmd:reopen-closed-tab"]')) === null, "⌘K lists Reopen closed tab only while one is closed");
await page.keyboard.press("Escape");
await page.keyboard.press("Escape");

// A second window, then ⇧⌘W with Undo.
// ⌘T: a new empty window; its Your connections list connects it.
await page.keyboard.press("Control+t");
await page.waitForSelector(`${ws} [data-empty-window]`);
await page.click(`${ws} [data-saved-conn="an"]`);
await page.waitForFunction(() => document.querySelectorAll('[data-testid="win-tab"]').length === 2);
await page.waitForSelector(`${ws}[data-conn-state="connected"]`);
await typeSql("SELECT * FROM events;");
await page.waitForTimeout(100);
await page.keyboard.press("Control+Shift+w");
await waitToast("Closed analytics");
check((await toast()) === "Closed analytics / events" && (await page.$$('[data-testid="win-tab"]')).length === 1, `window closed at once (${await toast()})`);
await page.click("[data-toast-undo]");
await page.waitForFunction(() => document.querySelectorAll('[data-testid="win-tab"]').length === 2);
await page.waitForSelector(`${ws}[data-conn-state="connected"]`);
check((await editor()) === "SELECT * FROM events;", "Undo brings the window back with its tab and SQL");
await page.screenshot({ path: `${OUT}/2-window-back.png` });

// Delete analytics: one step, Undo, and the keychain kept.
await page.keyboard.press("Control+k");
await page.keyboard.type("edit connection");
await page.waitForSelector('[data-testid="cp-row"][data-item="cmd:edit-connection"]');
await page.keyboard.press("Enter");
await page.waitForSelector("[data-delete]");
await page.click("[data-delete]");
// Delete… asks first: Esc and Keep back out without deleting.
await page.waitForSelector("[data-delete-confirm]");
await page.locator('[data-testid="nc-sheet"]').screenshot({ path: `${OUT}/delete-confirm.png` });
await page.keyboard.press("Escape");
await page.waitForSelector("[data-delete]");
check((await page.locator('[data-testid="nc-sheet"]').count()) === 1, "Esc backs out of the delete question, the sheet stays");
await page.click("[data-delete]");
await page.click("[data-delete-keep]");
check((await calls("delete_connection")).length === 0, "Keep deletes nothing");
await page.click("[data-delete]");
await page.click("[data-delete-go]");
await waitToast("Removed analytics");
let del = await calls("delete_connection");
check(del.length === 1 && del[0].keepSecrets === true, `deleted once confirmed, with keepSecrets (${JSON.stringify(del)})`);
check((await page.getAttribute(ws, "data-conn-state")) === "idle", "its window is emptied");
await page.screenshot({ path: `${OUT}/3-removed-undo.png` });
await page.click("[data-toast-undo]");
await waitToast("Restored");
const save = (await calls("save_connection")).at(-1);
check(save?.connection.id === "an" && JSON.stringify(save.secrets) === "{}", "Undo saves the record back with empty secrets (keychain kept)");
await page.waitForSelector(`${ws}[data-conn-state="connected"]`);
check((await editor()) === "SELECT * FROM events;" && (await calls("forget_connection_secrets")).length === 0, "the window reconnects with its tab; keychain never touched");

// Delete again and let it go (a new toast commits it): keychain entries removed.
await page.keyboard.press("Control+k");
await page.keyboard.type("edit connection");
await page.waitForSelector('[data-testid="cp-row"][data-item="cmd:edit-connection"]');
await page.keyboard.press("Enter");
await page.click("[data-delete]");
await page.click("[data-delete-go]");
await waitToast("Removed analytics");
check((await calls("forget_connection_secrets")).length === 0, "keychain kept while the toast is live");
await page.keyboard.press("Control+1");
await page.keyboard.press("Control+w");
await waitToast("Closed");
const forgot = await calls("forget_connection_secrets");
check(forgot.length === 1 && forgot[0].id === "an", "a new toast commits it: forget_connection_secrets(an)");
await browser.close();
