#!/usr/bin/env node
// New window (stubbed `invoke`): + and ⌘T go back to the empty window when
// one is open instead of adding another (rowkery/reports#5), and from the
// Agents or Settings page they leave the page for that window
// (rowkery/reports#4).
//
//   cd apps/rowkery-tauri && npx vite --port 1420 &
//   node scripts/new-window-browser-proof.mjs [outDir]
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
const OUT = process.argv[2] ?? "/tmp/rowkery-proof/new-window";
const URL = process.env.ROWKERY_DEV_URL ?? "http://localhost:1420/";
const FRAMES_SHIM = new globalThis.URL("./lib/frames-shim.js", import.meta.url).pathname;
mkdirSync(OUT, { recursive: true });

function stubTauri(opts) {
  localStorage.clear();
  window.__CALLS__ = [];
  if (opts.mac) Object.defineProperty(navigator, "platform", { get: () => "MacIntel" });
  const sample = { kind: "sqlite", id: "sample", name: "Sample database", path: "/x/sample.sqlite", sample: true };
  window.__CONNS__ = opts.conns ?? [{ kind: "postgres", id: "pg", name: "arcade", host: "127.0.0.1", port: 5432, database: "rowkery", username: "rowkery" }];
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
          if (!window.__CONNS__.some((c) => c.id === "sample")) window.__CONNS__ = [sample, ...window.__CONNS__];
          return sample;
        case "save_connection":
          window.__CONNS__ = [...window.__CONNS__.filter((c) => c.id !== args.connection.id), args.connection];
          return null;
        case "choose_file":
          return "/Users/me/data/shop.db";
        case "read_clipboard_text":
          return "postgres://app@db.internal:5433/wallet";
        case "probe_local_servers":
          return [{ port: 5432, user: "alice" }, { port: 54329, user: "alice" }];
        case "probe_connection":
          if (args.connection.port === 5432) return { ok: false, message: 'password authentication failed for user "alice"', elapsed_ms: 0 };
          return { ok: true, message: "PostgreSQL 16.4", elapsed_ms: 3 };
        case "explain_connect_error":
          return { class: "auth", cause: `The server rejected the password for ${args.username}.`, field: "password" };
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
const page = await browser.newPage({ viewport: { width: 1280, height: 800 }, deviceScaleFactor: 2 });
page.on("pageerror", (e) => console.error("pageerror:", e.message));
await page.addInitScript({ path: FRAMES_SHIM });
await page.addInitScript(stubTauri, {});
await page.goto(URL);
const ws = '[data-testid="workspace"]:not([hidden])';
await page.waitForSelector(`${ws} [data-empty-window]`);
const pills = () => page.$$eval('[data-testid="win-tab"]', (els) => els.length);
const shownEmpty = async () => (await page.$('[data-testid="win-tab"][data-on][data-empty]')) !== null && (await page.isVisible(`${ws} [data-empty-window]`));
const agentsShown = () => page.isVisible('[data-testid="agents-page"]').catch(() => false);

// One connected window to come back from.
await page.keyboard.press("Enter");
await page.waitForSelector(`${ws}[data-conn-state="connected"]`);

// 1 · + with no empty window opens one.
await page.click('[data-testid="win-add"]');
await page.waitForSelector(`${ws} [data-empty-window]`);
check((await pills()) === 2 && (await shownEmpty()), "+ opened an empty window and showed it");

// 2 · + again, from the connected window, goes back to it (#5).
await page.click('[data-testid="win-tab"]:not([data-empty])');
await page.waitForSelector(`${ws}[data-conn-state="connected"]`);
await page.click('[data-testid="win-add"]');
await page.waitForSelector(`${ws} [data-empty-window]`);
check((await pills()) === 2 && (await shownEmpty()), "+ went back to the empty window instead of adding a second");
await page.keyboard.press("Control+t");
check((await pills()) === 2 && (await shownEmpty()), "Ctrl+T did the same");

// 3 · From the Agents page, + leaves the page for the window (#4).
await page.click('[data-testid="win-tab"]:not([data-empty])');
await page.waitForSelector(`${ws}[data-conn-state="connected"]`);
await page.keyboard.press("Control+Shift+a");
await page.waitForSelector('[data-testid="agents-page"]');
await page.screenshot({ path: `${OUT}/1-agents.png` });
await page.click('[data-testid="win-add"]');
await page.waitForFunction(() => !document.querySelector('[data-testid="agents-page"]'));
check(!(await agentsShown()) && (await shownEmpty()), "+ on the Agents page showed the empty window");
await page.screenshot({ path: `${OUT}/2-after-plus.png` });

// 4 · The same from Settings, with ⌘T.
await page.keyboard.press("Control+Comma");
await page.waitForSelector('[data-testid="settings-page"]');
await page.keyboard.press("Control+t");
await page.waitForFunction(() => !document.querySelector('[data-testid="settings-page"]'), null, { timeout: 2000 }).catch(() => {});
check(!(await page.isVisible('[data-testid="settings-page"]').catch(() => false)) && (await shownEmpty()), "Ctrl+T on Settings showed the empty window");

await browser.close();
