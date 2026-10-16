#!/usr/bin/env node
// Schema cache (stubbed `invoke`): `open_window` answers from the cached
// catalog (`cached: true`), the sidebar lists it at once with its refresh
// spinner on, and the `catalog-update` that follows confirms it (spinner
// off), replaces it (new tables appear), or reports the connection failed
// ("Couldn't connect"). An update for an older open of the window is ignored.
//
//   cd apps/rowkery-tauri && npx vite --port 1420 &
//   node scripts/schema-cache-browser-proof.mjs
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
  const table = (name) => ({ name, columns: [{ name: "id", type_name: "int8", nullable: false }], primary_key: ["id"], indexes: [], foreign_keys: [], row_estimate: { Approximate: 1 }, partition_of: null });
  window.__catalog = (...names) => ({ databases: [{ name: "rowkery", schemas: [{ name: "public", tables: names.map(table) }] }] });
  window.__OPENS__ = 0;
  window.__TAURI_INTERNALS__ = {
    metadata: { currentWindow: { label: "main" }, currentWebview: { label: "main" } },
    transformCallback: () => 0,
    invoke: async (cmd) => {
      if (cmd === "list_connections")
        return { connections: [{ kind: "postgres", id: "pg", name: "wallet", host: "127.0.0.1", port: 5432, database: "rowkery", username: "rowkery" }, { kind: "postgres", id: "pg2", name: "ledger", host: "127.0.0.1", port: 5432, database: "rowkery", username: "rowkery" }], active_connection_id: null };
      if (cmd === "open_window")
        return { database: "rowkery", catalog: window.__catalog("cached_a"), server_version: "16.4", elapsed_ms: 1, cached: true, open_seq: ++window.__OPENS__ };
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

const ws = '[data-testid="workspace"]:not([hidden])';
const send = (detail) =>
  page.evaluate((d) => {
    if (d.catalog) d.catalog = window.__catalog(...d.catalog);
    window.dispatchEvent(new CustomEvent("rowkery:catalog-update", { detail: d }));
  }, detail);
const spinning = () => page.locator(`${ws} [data-testid="sb-refresh"][data-spinning]`).count();
const tables = () => page.$$eval(`${ws} [data-table]`, (els) => els.map((e) => e.getAttribute("data-table")));
// Alternates connections: picking the one already shown doesn't reopen.
let n = 0;
const connect = async () => {
  await page.keyboard.press("Control+Shift+O");
  await page.waitForSelector('[data-testid="conn-popover"]');
  await page.click(`[data-testid="conn-popover"] [data-conn-id="${n++ % 2 ? "pg2" : "pg"}"]`);
  await page.waitForSelector(`${ws}[data-conn-state="connected"]`);
  check((await page.evaluate(() => window.__OPENS__)) === n, `open ${n} sent`);
};

await connect();
check((await tables()).some((t) => t.includes("cached_a")), `cached catalog listed at once (${await tables()})`);
check((await spinning()) === 1, "refresh spinner on while core checks the live catalog");
await send({ kind: "confirmed", window_id: "w1", open_seq: 1 });
await page.waitForTimeout(50);
check((await spinning()) === 0, "confirmed: spinner off, same tables");
await page.screenshot({ path: "/tmp/rowkery-proof/schema-cache-confirmed.png" }).catch(() => {});

await connect();
check((await spinning()) === 1, "second open (seq 2) from cache: spinner on");
await send({ kind: "replaced", window_id: "w1", open_seq: 1, catalog: ["stale"], server_version: "16.4" });
await page.waitForTimeout(50);
check(!(await tables()).some((t) => t.includes("stale")) && (await spinning()) === 1, "update for the older open is ignored");
await send({ kind: "replaced", window_id: "w1", open_seq: 2, catalog: ["cached_a", "new_b"], server_version: "16.5" });
await page.waitForSelector(`${ws} [data-table*="new_b"]`);
check((await spinning()) === 0, `replaced: new table listed, spinner off (${await tables()})`);

await connect();
await send({ kind: "failed", window_id: "w1", open_seq: 3, error: "password authentication failed" });
await page.waitForSelector(`${ws} [data-connect-error]`);
const err = await page.textContent(`${ws} [data-connect-error]`);
check(err.includes("Couldn't connect") && err.includes("password authentication failed"), "failed: sidebar says Couldn't connect with the error");
check((await page.getAttribute(ws, "data-conn-state")) === "error", "failed: window state is error");
await browser.close();
