#!/usr/bin/env node
// Every connection a saved connection may hold (10) is busy: core sends the
// run a `waiting` frame (stubbed `invoke`), and the tab says so in plain
// words instead of looking stuck: Run reads "Waiting" and the results header
// "Waiting for a free connection", with the time and Cancel. Esc (and Ctrl+.) cancels the
// wait at once; Cancel does too; once a connection frees, the run goes on as
// usual and its rows show. Core's side (the cap, the wait, closing idle
// sessions, a cancel that ends the wait) is
// `postgres_an_eleventh_tab_waits_for_a_free_connection` and
// `the_cap_closes_idle_sessions_then_waits`.
//
//   cd apps/rowkery-tauri && npx vite --port 1420 &
//   node scripts/connection-cap-browser-proof.mjs [outDir]
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
const OUT = process.argv[2] ?? "/tmp/rowkery-proof/connection-cap";
const URL = process.env.ROWKERY_DEV_URL ?? "http://localhost:1420/";
const FRAMES_SHIM = new globalThis.URL("./lib/frames-shim.js", import.meta.url).pathname;
mkdirSync(OUT, { recursive: true });

function stubTauri() {
  localStorage.clear();
  window.__CALLS__ = [];
  const col = (name) => ({ name, type_name: "TEXT", nullable: false });
  const tables = [{ name: "orders", kind: "table", columns: [col("id")], primary_key: ["id"], indexes: [], foreign_keys: [], row_estimate: { Approximate: 3 }, partition_of: null }];
  // The run in flight: `free` hands it a connection, `cancel` ends its wait.
  window.__RUN__ = null;
  window.__TAURI_INTERNALS__ = {
    metadata: { currentWindow: { label: "main" }, currentWebview: { label: "main" } },
    transformCallback: () => 0,
    invoke: async (cmd, args) => {
      window.__CALLS__.push([cmd, args]);
      switch (cmd) {
        case "list_connections":
          return { connections: [{ kind: "postgres", id: "pg", name: "Midway", host: "db", port: 5432, database: "midway", username: "app", environment: "dev" }], active_connection_id: null };
        case "open_window":
          return { database: "midway", catalog: { databases: [{ name: "midway", schemas: [{ name: "public", tables }] }] }, elapsed_ms: 2, cached: false, open_seq: 1 };
        case "run_query": {
          const channel = args.onFrame;
          // All ten connections are busy: core says the run waits.
          channel?.onmessage({ t: "waiting", query_id: 0, waiting: true });
          const ended = await new Promise((resolve) => {
            window.__RUN__ = { resolve, channel };
          });
          window.__RUN__ = null;
          if (ended === "cancel") return { columns: [], rows: [], row_count: 0, elapsed_ms: 5, error: "Query cancelled", cancelled: true };
          return { columns: [{ name: "n", type_name: "int8" }], rows: [[{ Int: 1 }], [{ Int: 2 }], [{ Int: 3 }]], row_count: 3, elapsed_ms: 4 };
        }
        case "cancel_query":
          // A run waiting for a connection has nothing to ask the server: it ends at once.
          window.__RUN__?.resolve("cancel");
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
const calls = (cmd) => page.evaluate((c) => window.__CALLS__.filter(([x]) => x === c).length, cmd);
await page.waitForSelector(ws);
await page.keyboard.press("Control+Shift+O");
await page.waitForSelector('[data-testid="conn-popover"]');
await page.keyboard.press("Enter");
await page.waitForSelector(`${ws}[data-conn-state="connected"]`);

const run = async () => {
  await page.click(`${ws} textarea[data-testid="sql-editor"]`);
  await page.keyboard.press("Control+Enter");
  await page.waitForSelector(`${ws} [data-testid="run-btn"][data-waiting="connection"]`);
};
const waitingNow = () =>
  page.evaluate((sel) => {
    const btn = document.querySelector(`${sel} [data-testid="run-btn"]`);
    const meta = document.querySelector(`${sel} [data-testid="card-meta"][data-state="running"] [data-waiting="connection"]`);
    return {
      btn: btn?.dataset.waiting ?? null,
      label: btn?.querySelector('[data-testid="run-label"]')?.textContent ?? "",
      title: btn?.title ?? "",
      meta: meta?.textContent ?? null,
      cancel: !!document.querySelector(`${sel} [data-cancel="cancel"]`),
    };
  }, ws);

// 1. Waiting: Run and the results header say so, and Cancel is there.
await run();
await page.waitForTimeout(300);
let w = await waitingNow();
// Text on purpose: the plain words are what's under test.
check(w.label === "Waiting" && w.title === "Waiting for a free connection", `Run reads "${w.label}" (title "${w.title}")`);
check(!!w.meta && w.meta.startsWith("Waiting for a free connection"), `the results header reads "${w.meta}"`);
check(w.cancel, "Cancel is offered while it waits");
await page.screenshot({ path: `${OUT}/1-waiting.png` });

// 2. Esc cancels the wait at once.
await page.keyboard.press("Escape");
await page.waitForSelector(`${ws} [data-testid="card-meta"][data-state="cancelled"]`, { timeout: 1500 });
w = await waitingNow();
check((await calls("cancel_query")) === 1 && w.btn === null && w.label === "Run", "Esc ended the wait: cancelled, Run reads Run again");
await page.screenshot({ path: `${OUT}/2-cancelled.png` });

// 3. The Cancel button does too.
await run();
await page.click(`${ws} [data-cancel="cancel"]`);
await page.waitForSelector(`${ws} [data-testid="card-meta"][data-state="cancelled"]`, { timeout: 1500 });
check((await calls("cancel_query")) === 2, "Cancel ended the wait");
// And ⌘. (Ctrl+. under the Linux pin).
await run();
await page.keyboard.press("Control+.");
await page.waitForSelector(`${ws} [data-testid="card-meta"][data-state="cancelled"]`, { timeout: 1500 });
check((await calls("cancel_query")) === 3, "Ctrl+. ended the wait");

// 4. A connection frees: it stops saying it waits, runs, and shows its rows.
await run();
await page.evaluate(() => window.__RUN__.channel.onmessage({ t: "waiting", query_id: 0, waiting: false }));
await page.waitForFunction((sel) => !document.querySelector(`${sel} [data-testid="run-btn"][data-waiting]`), ws);
w = await waitingNow();
check(w.meta === null && w.label !== "Waiting", `with a connection it shows the run as usual (Run reads "${w.label}")`);
await page.screenshot({ path: `${OUT}/3-got-a-connection.png` });
await page.evaluate(() => window.__RUN__.resolve("free"));
await page.waitForSelector(`${ws} [data-row-count="3"]`);
check((await page.$(`${ws} [data-testid="run-btn"][data-waiting]`)) === null, "its 3 rows show, nothing says waiting");
await page.screenshot({ path: `${OUT}/4-rows.png` });
await browser.close();
