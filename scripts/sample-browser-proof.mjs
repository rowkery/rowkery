#!/usr/bin/env node
// The sample database (stubbed `invoke`; core's first run, open and reset
// are tested in rowkery-core / rowkery-bridge). A first launch with only the
// sample record opens it with the Getting started tab whose SELECT has
// already run; the database slot reads sample.sqlite, never "main"; the
// picker lists it under "Sample". ⌘K Reset rewrites it and reconnects the
// window; deleted, ⌘K Open brings it back; a new connection saved from the
// sample window opens in its own window with the "returns to the sample" toast.
//
//   cd apps/rowkery-tauri && npx vite --port 1420 &
//   node scripts/sample-browser-proof.mjs [outDir]
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
const OUT = process.argv[2] ?? "/tmp/rowkery-proof/sample";
const URL = process.env.ROWKERY_DEV_URL ?? "http://localhost:1420/";
const FRAMES_SHIM = new globalThis.URL("./lib/frames-shim.js", import.meta.url).pathname;
mkdirSync(OUT, { recursive: true });

function stubTauri() {
  localStorage.clear();
  window.__CALLS__ = [];
  const sample = { kind: "sqlite", id: "sample", name: "Sample database", path: "/Users/me/Library/Application Support/Rowkery/sample.sqlite", sample: true };
  window.__CONNS__ = [sample];
  const col = (name, type_name) => ({ name, type_name, nullable: false });
  const t = (name, cols, kind = "table") => ({ name, kind, columns: cols.map((c) => col(c, "TEXT")), primary_key: ["id"], indexes: [], foreign_keys: [], row_estimate: { Exact: 12 }, partition_of: null });
  const tables = [
    t("games", ["id", "title"]), t("kiosk_sessions", ["id", "kiosk_id"]), t("kiosks", ["id", "name", "city", "opened_on"]),
    t("players", ["id", "nickname"]), t("wallet_tx", ["id", "wallet_id"]), t("wallets", ["id", "player_id"]),
    t("daily_takings", ["day", "city"], "view"),
  ];
  const kiosks = ["Harbour Front", "Old Mill", "Station Hall", "Canal Corner", "Market Arcade", "Riverside", "Tram Depot", "Night Pier", "Glasshouse", "Ferry Gate", "Lantern Row", "North Quay"];
  window.__TAURI_INTERNALS__ = {
    metadata: { currentWindow: { label: "main" }, currentWebview: { label: "main" } },
    transformCallback: () => 0,
    invoke: async (cmd, args) => {
      window.__CALLS__.push([cmd, args]);
      switch (cmd) {
        case "list_connections":
          return { connections: window.__CONNS__, active_connection_id: null };
        case "open_window":
          if (args.connectionId === "pg") return { database: "wallet", catalog: { databases: [{ name: "wallet", schemas: [{ name: "public", tables: tables.slice(0, 1) }] }] }, elapsed_ms: 2, cached: false, open_seq: 1 };
          return { database: "main", catalog: { databases: [{ name: "main", schemas: [{ name: "main", tables }] }] }, server_version: "3.45.0", elapsed_ms: 2, cached: false, open_seq: 1 };
        case "run_query":
          return {
            columns: [{ name: "name", type_name: "TEXT" }, { name: "city", type_name: "TEXT" }, { name: "opened_on", type_name: "DATE" }],
            rows: kiosks.slice().reverse().map((k, i) => [{ Text: k }, { Text: "City" }, { Text: `2024-0${(i % 9) + 1}-01` }]),
            row_count: 12, elapsed_ms: 2, error: null, cancelled: false,
          };
        case "open_sample":
          if (!window.__CONNS__.some((c) => c.id === "sample")) window.__CONNS__ = [sample, ...window.__CONNS__];
          return sample;
        case "delete_connection":
          window.__CONNS__ = window.__CONNS__.filter((c) => c.id !== args.id);
          return null;
        case "probe_connection":
          return { ok: true, message: "PostgreSQL 16.4", elapsed_ms: 9 };
        case "save_connection":
          window.__CONNS__ = [...window.__CONNS__.filter((c) => c.id !== args.connection.id), args.connection];
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
const calls = (cmd) => page.evaluate((c) => window.__CALLS__.filter(([x]) => x === c).map(([, a]) => a), cmd);
const waitToast = (text) => page.waitForFunction((t) => [...document.querySelectorAll("[data-toast] > span")].some((e) => e.textContent.includes(t)), text);
const palette = async (text, id) => {
  await page.keyboard.press("Control+k");
  await page.keyboard.type(text);
  await page.waitForSelector(`[data-testid="cp-row"][data-item="cmd:${id}"]`);
  await page.keyboard.press("Enter");
};

// First launch: the sample, Getting started already run.
await page.waitForSelector(`${ws}[data-conn-state="connected"]`);
await page.waitForSelector(`${ws} [data-row]`);
const tabTitles = await page.$$eval(`${ws} [data-testid="query-tab-title"]`, (els) => els.map((e) => e.textContent.trim()));
check(tabTitles.join("|") === "Getting started", `one tab, Getting started (${tabTitles.join("|")})`);
const ran = await calls("run_query");
check(ran.length === 1 && /^-- Rowkery sample[\s\S]*SELECT name, city, opened_on\nFROM kiosks ORDER BY opened_on DESC;$/.test(ran[0].sql), "its SELECT ran as the window connected (comments and all, nothing after)");
check((await page.$$(`${ws} [data-row]`)).length === 12, "12 rows on the first screen");
check((await page.textContent(`${ws} [data-db-file]`)) === "sample.sqlite", "the database slot reads sample.sqlite");
const editorText = await page.inputValue(`${ws} textarea`);
check(editorText.includes('-- Ctrl+K "Reset the sample database" puts this file back.'), "the lesson is in the SQL, with this platform's keys");
await page.screenshot({ path: `${OUT}/1-first-launch.png` });

// The picker: under its own heading, with its tooltip.
await page.keyboard.press("Control+Shift+O");
await page.waitForSelector('[data-testid="conn-popover"]');
check((await page.textContent('[data-testid="conn-section"][data-section="sample"]')) === "Sample", "the picker lists it under Sample");
check(((await page.getAttribute('[data-conn-id="sample"]', "title")) ?? "").startsWith("A bundled SQLite file"), "row tooltip says what it is");
await page.screenshot({ path: `${OUT}/2-picker.png` });
await page.keyboard.press("Escape");
await page.waitForFunction(() => !document.querySelector('[data-testid="conn-popover"]'));

// ⌘K Reset: a fresh copy, the window reconnects.
const opensBefore = (await calls("open_window")).length;
await palette("reset sample", "reset-sample");
await waitToast("Sample database reset");
await page.waitForFunction((n) => window.__CALLS__.filter(([c]) => c === "open_window").length > n, opensBefore);
check((await calls("open_sample")).at(-1)?.reset === true, "Reset calls open_sample with reset");
await page.waitForSelector(`${ws}[data-conn-state="connected"]`);
check(true, "the window reconnected to the fresh copy");

// A new connection saved from the sample window opens its own window.
await page.keyboard.press("Control+N");
await page.waitForSelector('[data-testid="nc-sheet"]');
await page.fill('[data-testid="nc-sheet"] [data-field="url"] input', "postgres://app:pw@db.internal/wallet");
await page.fill('[data-testid="nc-sheet"] [data-field="name"] input', "wallet-prd");
await page.keyboard.press("Control+Enter");
await waitToast("Connected to wallet-prd");
const toastText = await page.$$eval("[data-toast] > span", (els) => els.map((e) => e.textContent.trim()).join(" · "));
check(toastText === "Connected to wallet-prd · Ctrl+1 returns to the sample", `toast: ${toastText}`);
await page.waitForFunction(() => document.querySelectorAll('[data-testid="win-tab"]').length === 2);
check(true, "two windows: the sample stays where it is");
await page.screenshot({ path: `${OUT}/3-connected-from-sample.png` });

// Deleted, ⌘K Open brings it back into this window when it's empty.
await page.keyboard.press("Control+1");
await page.waitForSelector(`${ws} [data-db-file]`);
await palette("edit connection", "edit-connection");
await page.waitForSelector('[data-testid="nc-sheet"] [data-delete]');
await page.click('[data-testid="nc-sheet"] [data-delete]');
await waitToast("Removed Sample database");
await page.waitForSelector(`${ws}[data-conn-state="idle"]`);
await palette("open the sample", "open-sample");
await page.waitForSelector(`${ws}[data-conn-state="connected"] [data-db-file]`);
check((await calls("open_sample")).at(-1)?.reset === false, "⌘K Open the sample database puts it back in the emptied window");
await browser.close();
