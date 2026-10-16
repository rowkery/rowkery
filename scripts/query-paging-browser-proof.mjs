#!/usr/bin/env node
// Query tab paging (stubbed `invoke`): ⌘↵ on a free-form SELECT asks
// `run_query` for a 1,000-row page; while the cursor has more the header
// reads "1,000+ rows" with Load more; scrolling to the end runs
// `fetch_more`, which appends; the last page ends it. The page-size menu
// shows only for paged results; All loads the rest at once (up to the
// 1,000,000-row cap a tab holds). A query with
// its own LIMIT comes back whole (core doesn't page it) and shows no menu.
//
//   cd apps/rowkery-tauri && npx vite --port 1420 &
//   node scripts/query-paging-browser-proof.mjs [outDir]
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
const OUT = process.argv[2] ?? "/tmp/rowkery-proof/query-paging";
const URL = process.env.ROWKERY_DEV_URL ?? "http://localhost:1420/";
mkdirSync(OUT, { recursive: true });

function stubTauri() {
  localStorage.clear();
  const TOTAL = 2500;
  window.__CALLS__ = [];
  let nextId = 0;
  // Each tab's open cursor: how many rows it has sent.
  const cursors = new Map();
  const send = (onFrame, rows, from, paged, more) => {
    const queryId = ++nextId;
    setTimeout(() => {
      const f = (x) => onFrame.onmessage({ query_id: queryId, ...x });
      f({ t: "columns", columns: [{ name: "n", type_name: "int8" }] });
      for (let i = 0; i < rows; i += 500)
        f({ t: "rows", seq: i / 500, rows: Array.from({ length: Math.min(500, rows - i) }, (_, j) => [{ Int: from + i + j + 1 }]) });
      f({ t: "done", status: "ok", row_count: rows, affected_rows: null, elapsed_ms: 4, first_row_ms: 1, frames: 1, error: null, sqlstate: null, error_position: null, hold: null, paged, more });
    }, 5);
    return queryId;
  };
  window.__TAURI_INTERNALS__ = {
    metadata: { currentWindow: { label: "main" }, currentWebview: { label: "main" } },
    transformCallback: () => 0,
    invoke: async (cmd, args) => {
      if (cmd === "run_query" || cmd === "fetch_more") window.__CALLS__.push({ cmd, sql: args.sql, page: args.page, rows: args.rows });
      switch (cmd) {
        case "list_connections":
          return { connections: [{ kind: "postgres", id: "pg", name: "arcade", host: "127.0.0.1", port: 54329, database: "rowkery", username: "rowkery" }], active_connection_id: null };
        case "open_window":
          return { database: "rowkery", catalog: { databases: [{ name: "rowkery", schemas: [{ name: "public", tables: [] }] }] }, elapsed_ms: 2, cached: false, open_seq: 1 };
        case "run_query": {
          // Like core: a read without its own LIMIT pages; anything else runs whole.
          const own = /\blimit\s+(\d+)/i.exec(args.sql);
          if (own || args.page == null) {
            cursors.delete(args.tabId);
            return send(args.onFrame, own ? Number(own[1]) : TOTAL, 0, false, false);
          }
          const n = args.page === 0 ? TOTAL : Math.min(args.page, TOTAL);
          cursors.set(args.tabId, n);
          return send(args.onFrame, n, 0, true, n < TOTAL);
        }
        case "fetch_more": {
          const from = cursors.get(args.tabId);
          if (from == null) throw "These rows are no longer open; run the query again";
          const n = args.rows === 0 ? TOTAL - from : Math.min(args.rows, TOTAL - from);
          cursors.set(args.tabId, from + n);
          return send(args.onFrame, n, from, true, from + n < TOTAL);
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
const rowCount = () => page.getAttribute(`${ws} [data-testid="results-grid-wrap"]`, "data-row-count").then(Number);
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
await waitRows(1000);
await settle();
let c = await calls();
check(c.length === 1 && c[0].cmd === "run_query" && c[0].page === 1000, `⌘↵ asks for a 1,000-row page (${JSON.stringify(c)})`);
check((await count()) === "1,000+ rows", `header reads 1,000+ rows (${await count()})`);
check((await page.$(`${ws} [data-load-more]`)) !== null, "Load more offered");
check((await page.getAttribute(`${ws} [data-page-size]`, "data-page-size")) === "1000", "page size menu shows 1,000");
await page.screenshot({ path: `${OUT}/1-first-page.png` });

await page.$eval(`${ws} [data-testid="results-grid-wrap"]`, (el) => (el.scrollTop = el.scrollHeight));
await waitRows(2000);
await settle();
c = await calls();
check(c.at(-1).cmd === "fetch_more" && c.at(-1).rows === 1000, "scrolling to the end fetches the next 1,000");
const ids = await page.$$eval(`${ws} [data-row] [data-col="0"]`, (els) => els.map((e) => Number(e.textContent)));
check(ids.includes(1001) || ids.at(-1) === 2000, `appended rows continue the cursor (${ids.at(-1)})`);

// All: the rest at once.
await page.selectOption(`${ws} [data-page-size]`, "0");
await waitRows(2500);
await settle();
c = await calls();
check(c.at(-1).cmd === "fetch_more" && c.at(-1).rows === 998_000, "All fetches the rest up to the 1,000,000-row cap (rows 998,000)");
check((await count()) === "2,500 rows" && (await page.$(`${ws} [data-load-more]`)) === null, `cursor done: 2,500 rows, no Load more (${await count()})`);
await page.screenshot({ path: `${OUT}/2-all.png` });

// The tab remembers All for its next run.
await run("SELECT n FROM big");
await waitRows(2500);
await settle();
check((await calls()).at(-1).page === 1_000_000, "the next run asks for All (up to the cap)");

// Its own LIMIT: whole, no page-size menu.
await page.selectOption(`${ws} [data-page-size]`, "1000");
await run("SELECT n FROM big LIMIT 20");
await waitRows(20);
await settle();
check((await count()) === "20 rows" && (await page.$(`${ws} [data-page-size]`)) === null, "a query with its own LIMIT: 20 rows, no page-size menu");
await browser.close();
