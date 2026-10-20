#!/usr/bin/env node
// A query tab loads every row its query returns (stubbed `invoke`, reports#7):
// ⌘↵ asks `run_query` with no page, the header reads the whole count, and
// there is no Load more or page-size menu. Its own LIMIT is what it gets: a
// LIMIT 2000 shows 2,000 rows, not a 1,000-row page. Scrolling to the end
// asks for nothing more.
//
//   cd apps/rowkery-tauri && npx vite --port 1420 &
//   node scripts/query-whole-results-browser-proof.mjs [outDir]
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
const OUT = process.argv[2] ?? "/tmp/rowkery-proof/query-whole-results";
const URL = process.env.ROWKERY_DEV_URL ?? "http://localhost:1420/";
mkdirSync(OUT, { recursive: true });

function stubTauri() {
  localStorage.clear();
  const TOTAL = 2500;
  window.__CALLS__ = [];
  let nextId = 0;
  const send = (onFrame, rows) => {
    const queryId = ++nextId;
    setTimeout(() => {
      const f = (x) => onFrame.onmessage({ query_id: queryId, ...x });
      f({ t: "columns", columns: [{ name: "n", type_name: "int8" }] });
      for (let i = 0; i < rows; i += 500)
        f({ t: "rows", seq: i / 500, rows: Array.from({ length: Math.min(500, rows - i) }, (_, j) => [{ Int: i + j + 1 }]) });
      f({ t: "done", status: "ok", row_count: rows, affected_rows: null, elapsed_ms: 4, first_row_ms: 1, frames: 1, error: null, sqlstate: null, error_position: null, hold: null });
    }, 5);
    return queryId;
  };
  window.__TAURI_INTERNALS__ = {
    metadata: { currentWindow: { label: "main" }, currentWebview: { label: "main" } },
    transformCallback: () => 0,
    invoke: async (cmd, args) => {
      if (cmd === "run_query" || cmd === "fetch_more") window.__CALLS__.push({ cmd, sql: args.sql, page: args.page });
      switch (cmd) {
        case "list_connections":
          return { connections: [{ kind: "postgres", id: "pg", name: "arcade", host: "127.0.0.1", port: 54329, database: "rowkery", username: "rowkery" }], active_connection_id: null };
        case "open_window":
          return { database: "rowkery", catalog: { databases: [{ name: "rowkery", schemas: [{ name: "public", tables: [] }] }] }, elapsed_ms: 2, cached: false, open_seq: 1 };
        case "run_query": {
          // Like core with no page: every row, or as many as its own LIMIT says.
          const own = /\blimit\s+(\d+)/i.exec(args.sql);
          return send(args.onFrame, own ? Math.min(Number(own[1]), TOTAL) : TOTAL);
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
await page.addInitScript({ path: LINUX_PLATFORM });
await page.addInitScript(stubTauri);
await page.goto(URL);
const ws = '[data-testid="workspace"]:not([hidden])';
await page.waitForSelector('[data-testid="workspace"]:not([hidden])'); // Paper (2026-10-10): an empty window shows no connection chip (no tab row without a connection); wait for the window, then ⇧⌘O as before.
await page.keyboard.press("Control+Shift+O");
await page.waitForSelector('[data-testid="conn-popover"]');
await page.keyboard.press("Enter");
await page.waitForSelector(`${ws}[data-conn-state="connected"]`);

const calls = () => page.evaluate(() => window.__CALLS__);
const waitRows = (n) => page.waitForFunction(([ws, n]) => document.querySelector(`${ws} [data-testid="results-grid-wrap"]`)?.getAttribute("data-row-count") === String(n), [ws, n]);
const settle = () => page.waitForFunction((ws) => !document.querySelector(`${ws} [data-testid="card-meta"][data-state="running"]`), ws);
const count = () => page.textContent(`${ws} [data-testid="card-meta"] b`);
const run = async (sql) => {
  await page.click(`${ws} textarea[data-testid="sql-editor"]`);
  await page.keyboard.press("ControlOrMeta+a");
  await page.keyboard.type(sql);
  await page.keyboard.press("Control+Enter");
};

await run("SELECT n FROM big");
await waitRows(2500);
await settle();
let c = await calls();
check(c.length === 1 && c[0].cmd === "run_query" && c[0].page === null, `⌘↵ asks for every row, no page (${JSON.stringify(c)})`);
check((await count()) === "2,500 rows", `header reads the whole count (${await count()})`);
check((await page.$(`${ws} [data-load-more]`)) === null && (await page.$(`${ws} [data-page-size]`)) === null, "no Load more, no page-size menu");
await page.screenshot({ path: `${OUT}/1-whole-result.png` });

await page.$eval(`${ws} [data-testid="results-grid-wrap"]`, (el) => (el.scrollTop = el.scrollHeight));
await page.waitForTimeout(400);
check((await calls()).length === 1, "scrolling to the end asks for nothing more");

// Its own LIMIT is what it gets, past what a page used to be.
await run("SELECT n FROM big LIMIT 2000");
await waitRows(2000);
await settle();
check((await count()) === "2,000 rows", `LIMIT 2000 shows 2,000 rows (${await count()})`);
await browser.close();
