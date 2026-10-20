#!/usr/bin/env node
// A tab holds at most 1,000,000 rows (stubbed `invoke`, 1.5 million rows
// behind every query). A query tab asks `run_query` for every row (no page);
// core stops at the cap and its done frame says `capped`, so a toast says
// "Stopped at 1,000,000 rows" and there's no Load more. On a table tab, All
// browses with LIMIT 1000000, not without a limit.
//
//   cd apps/rowkery-tauri && npx vite --port 1420 &
//   node scripts/row-cap-browser-proof.mjs [outDir]
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
const OUT = process.argv[2] ?? "/tmp/rowkery-proof/row-cap";
const URL = process.env.ROWKERY_DEV_URL ?? "http://localhost:1420/";
mkdirSync(OUT, { recursive: true });

function stubTauri() {
  localStorage.clear();
  const TOTAL = 1_500_000;
  window.__CALLS__ = [];
  let nextId = 0;
  const col = (name, type_name) => ({ name, type_name, nullable: true });
  const tables = [{ name: "big", columns: [col("n", "int8")], primary_key: ["n"], indexes: [], foreign_keys: [], row_estimate: { Approximate: TOTAL }, partition_of: null }];
  const send = (onFrame, rows, from, extra) => {
    const queryId = ++nextId;
    setTimeout(() => {
      const f = (x) => onFrame.onmessage({ query_id: queryId, ...x });
      f({ t: "columns", columns: [{ name: "n", type_name: "int8" }] });
      for (let i = 0, seq = 0; i < rows; i += 5000, seq++)
        f({ t: "rows", seq, rows: Array.from({ length: Math.min(5000, rows - i) }, (_, j) => [{ Int: from + i + j + 1 }]) });
      f({ t: "done", status: "ok", row_count: rows, affected_rows: null, elapsed_ms: 4, first_row_ms: 1, frames: 1, error: null, sqlstate: null, error_position: null, hold: null, ...extra });
    }, 5);
    return queryId;
  };
  window.__TAURI_INTERNALS__ = {
    metadata: { currentWindow: { label: "main" }, currentWebview: { label: "main" } },
    transformCallback: () => 0,
    invoke: async (cmd, args) => {
      if (cmd === "run_query" || cmd === "browse_table")
        window.__CALLS__.push({ cmd, sql: args.sql, page: args.page, rows: args.rows, limit: args.limit });
      switch (cmd) {
        case "list_connections":
          return { connections: [{ kind: "postgres", id: "pg", name: "arcade", host: "127.0.0.1", port: 54329, database: "rowkery", username: "rowkery" }], active_connection_id: null };
        case "open_window":
          return { database: "rowkery", catalog: { databases: [{ name: "rowkery", schemas: [{ name: "public", tables }] }] }, elapsed_ms: 2, cached: false, open_seq: 1 };
        case "run_query":
          // Core streams the rows and stops at the cap, saying so.
          return send(args.onFrame, 1_000_000, 0, { capped: true });
        case "browse_table": {
          const n = Math.min(args.limit === 0 ? TOTAL : args.limit, TOTAL);
          const queryId = send(args.onFrame, n, 0, {});
          return { query_id: queryId, sql: `SELECT * FROM public.big\nORDER BY n${args.limit ? `\nLIMIT ${args.limit}` : ""};` };
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
await page.waitForSelector(ws);
await page.keyboard.press("Control+Shift+O");
await page.waitForSelector('[data-testid="conn-popover"]');
await page.keyboard.press("Enter");
await page.waitForSelector(`${ws}[data-conn-state="connected"]`);

const calls = () => page.evaluate(() => window.__CALLS__);
const waitRows = (n) =>
  page.waitForFunction(([ws, n]) => document.querySelector(`${ws} [data-testid="results-grid-wrap"]`)?.getAttribute("data-row-count") === String(n), [ws, n], { timeout: 60_000 });
const settle = () => page.waitForFunction((ws) => !document.querySelector(`${ws} [data-testid="card-meta"][data-state="running"]`), ws, { timeout: 60_000 });
const toast = () => page.waitForSelector("[data-toast]", { timeout: 10_000 }).then((el) => el.textContent());
const noToast = () => page.waitForFunction(() => !document.querySelector("[data-toast]"), null, { timeout: 15_000 });
const run = async (sql) => {
  await page.click(`${ws} textarea[data-testid="sql-editor"]`);
  await page.keyboard.press("ControlOrMeta+a");
  await page.keyboard.type(sql);
  await page.keyboard.press("Control+Enter");
};

// Query tab: every row, up to the cap.
await run("SELECT n FROM big");
await waitRows(1_000_000);
await settle();
let c = await calls();
check(c.at(-1).cmd === "run_query" && c.at(-1).page === null, `a query asks for every row, no page (${JSON.stringify(c.at(-1))})`);
// Text on purpose: the toast's copy is what's under test.
const said = await toast();
check(said.includes("Stopped at 1,000,000 rows"), `a toast says where it stopped (${said})`);
check((await page.$(`${ws} [data-load-more]`)) === null, "no Load more at the cap");
await page.screenshot({ path: `${OUT}/1-query-tab-capped.png` });
const before = (await calls()).length;
await page.$eval(`${ws} [data-testid="results-grid-wrap"]`, (el) => (el.scrollTop = el.scrollHeight));
await page.waitForTimeout(400);
check((await calls()).length === before, "scrolling to the end at the cap asks for nothing more");
await noToast();

// Table tab: All browses with the cap as its LIMIT.
await page.click(`${ws} [data-table="rowkery.public.big"] [data-testid="sb-row-main"]`);
await waitRows(1000);
await settle();
await page.click(`${ws} [data-sql-line] [data-limit]`);
await page.click('[data-menu="page-size"] [data-item="0"]');
await waitRows(1_000_000);
await settle();
c = (await calls()).filter((x) => x.cmd === "browse_table");
check(c.at(-1).limit === 1_000_000, `table tab All: LIMIT 1000000, not every row (${c.at(-1).limit})`);
check((await page.$(`${ws} [data-load-more]`)) === null && (await toast()).includes("Stopped at 1,000,000 rows"), "no Load more, and the toast");
await page.screenshot({ path: `${OUT}/2-table-tab-capped.png` });
await browser.close();
