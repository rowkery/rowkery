#!/usr/bin/env node
// reports#7: a run of several statements (Run All, or a selection of several)
// keeps each statement's result. A list beside the grid shows every statement
// with how it ended (rows, rows changed, Error); picking one, by click or
// ↑ / ↓, shows its result. Only the run's last statement keeps its cursor, so
// an earlier one with rows left says "N+ rows" without Load more. A failing
// statement stops the run and shows its error. A single statement's run
// takes the list away.
//
//   cd apps/rowkery-tauri && npx vite --port 1420 &
//   node scripts/statement-list-browser-proof.mjs [outDir]
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
const OUT = process.argv[2] ?? "/tmp/rowkery-proof/statement-list";
const URL = process.env.ROWKERY_DEV_URL ?? "http://localhost:1420/";
const FRAMES_SHIM = new globalThis.URL("./lib/frames-shim.js", import.meta.url).pathname;
mkdirSync(OUT, { recursive: true });

function stubTauri() {
  localStorage.clear();
  window.__RUNS__ = [];
  const col = (name, type_name) => ({ name, type_name, nullable: false });
  const tables = [
    { name: "users", columns: [col("id", "int8"), col("email", "text")], primary_key: ["id"], indexes: [], foreign_keys: [], row_estimate: { Approximate: 1200 }, partition_of: null },
    { name: "orders", columns: [col("id", "int8"), col("status", "text")], primary_key: ["id"], indexes: [], foreign_keys: [], row_estimate: { Approximate: 8400 }, partition_of: null },
  ];
  const done = { columns: [], rows: [], row_count: 0, elapsed_ms: 1, error: null, cancelled: false };
  const T = (s) => ({ Text: s });
  const I = (n) => ({ Int: n });
  window.__TAURI_INTERNALS__ = {
    metadata: { currentWindow: { label: "main" }, currentWebview: { label: "main" } },
    transformCallback: () => 0,
    invoke: async (cmd, args) => {
      switch (cmd) {
        case "list_connections":
          return { connections: [{ kind: "postgres", id: "pg", name: "shop", host: "127.0.0.1", port: 5432, database: "shop", username: "rowkery" }], active_connection_id: null };
        case "open_window":
          return { database: "shop", catalog: { databases: [{ name: "shop", schemas: [{ name: "public", tables }] }] }, elapsed_ms: 2, cached: false, open_seq: 1 };
        case "run_query": {
          const sql = args.sql;
          window.__RUNS__.push(sql);
          if (/;\s*\S/.test(sql)) return { ...done, error: "cannot insert multiple commands into a prepared statement", sqlstate: "42601" };
          if (/\bnmae\b/.test(sql)) return { ...done, error: 'column "nmae" does not exist', sqlstate: "42703", error_position: sql.indexOf("nmae") + 1 };
          // A page of a longer read: the cursor has rows left. A full page,
          // so the grid's end (which loads more) stays out of sight.
          if (/from users/i.test(sql)) {
            const rows = Array.from({ length: 200 }, (_, n) => [I(n + 1), T(`u${n + 1}@example.com`)]);
            return { ...done, elapsed_ms: 4, columns: [col("id", "int8"), col("email", "text")], rows, row_count: 200, paged: true, more: true };
          }
          if (/group by status/i.test(sql)) return { ...done, columns: [col("status", "text"), col("count", "int8")], rows: [[T("paid"), I(6120)], [T("pending"), I(1830)], [T("refunded"), I(450)]], row_count: 3 };
          if (/^update/i.test(sql)) return { ...done, affected_rows: 1 };
          if (/^select/i.test(sql)) return { ...done, columns: [col("id", "int8"), col("status", "text")], rows: [[I(42), T("shipped")]], row_count: 1 };
          return done;
        }
        case "fetch_more": {
          const rows = Array.from({ length: 50 }, (_, n) => [I(n + 201), T(`u${n + 201}@example.com`)]);
          return { ...done, columns: [col("id", "int8"), col("email", "text")], rows, row_count: 50, paged: true, more: false };
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
await page.addInitScript({ path: FRAMES_SHIM });
await page.addInitScript(stubTauri);
await page.goto(URL);
const ws = '[data-testid="workspace"]:not([hidden])';
await page.waitForSelector(ws);
await page.keyboard.press("Control+Shift+O");
await page.waitForSelector('[data-testid="conn-popover"]');
await page.keyboard.press("Enter");
await page.waitForSelector(`${ws}[data-conn-state="connected"]`);

const editor = `${ws} textarea[data-testid="sql-editor"]`;
const list = `${ws} [data-testid="statement-list"]`;
const row = (i) => `${list} [data-statement="${i}"]`;
const setSql = (text) =>
  page.evaluate(([sel, text]) => {
    const ta = document.querySelector(sel);
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value").set.call(ta, text);
    ta.dispatchEvent(new Event("input", { bubbles: true }));
  }, [editor, text]);
const idle = () => page.waitForFunction((ws) => !document.querySelector(`${ws} [data-testid="card-meta"][data-state="running"]`), ws);
const gridRows = () => page.getAttribute(`${ws} [data-row-count]`, "data-row-count").then(Number).catch(() => null);
const meta = () => page.textContent(`${ws} [data-testid="card-meta"]`).catch(() => null);
const selected = () => page.getAttribute(`${list} [aria-selected="true"]`, "data-statement");
// Text on purpose: the outcome line is what's under test.
const rowMeta = (i) => page.textContent(`${row(i)} [data-testid="statement-outcome"]`);

// Run All (Ctrl+Alt+↵) on four statements.
const script = `SELECT id, email FROM users ORDER BY id;

SELECT status, count(*) FROM orders GROUP BY status;

UPDATE orders SET status = 'shipped' WHERE id = 42;

SELECT id, status FROM orders WHERE id = 42;`;
await setSql(script);
await page.focus(editor);
await page.keyboard.press("Control+Alt+Enter");
await page.waitForFunction(() => window.__RUNS__.length === 4);
await idle();
await page.waitForSelector(row(3));
check((await page.$$(`${list} [data-statement]`)).length === 4, "four statements listed");
check((await selected()) === "3" && (await gridRows()) === 1, "the last statement shows, as before");
check(/^4\s*SELECT/.test((await page.textContent(row(3)))?.trim() ?? ""), "rows are numbered");
check(/1 row changed/.test(await rowMeta(2)), `the UPDATE says what it changed (${await rowMeta(2)})`);
check(/200\+ rows/.test(await rowMeta(0)), `a read with rows left says so (${await rowMeta(0)})`);
await page.screenshot({ path: `${OUT}/1-run-all.png` });

// Click: the first statement's rows. Its cursor is gone, so no Load more.
await page.click(row(0));
await page.waitForFunction(() => document.querySelector('[data-testid="workspace"]:not([hidden]) [data-row-count]')?.getAttribute("data-row-count") === "200");
check((await selected()) === "0", "a click shows that statement");
check(/200\+ rows/.test((await meta()) ?? ""), `its count keeps the + (${await meta()})`);
check((await page.$(`${ws} [data-load-more]`)) === null, "no Load more for an earlier statement");
await page.screenshot({ path: `${OUT}/2-first-picked.png` });

// ↓ steps to the next one; ↓ again to the UPDATE.
await page.keyboard.press("ArrowDown");
await page.waitForFunction(() => document.querySelector('[data-testid="workspace"]:not([hidden]) [data-row-count]')?.getAttribute("data-row-count") === "3");
check((await selected()) === "1", "↓ shows the next statement");
await page.keyboard.press("ArrowDown");
await page.waitForFunction(() => /1 row changed/.test(document.querySelector('[data-testid="workspace"]:not([hidden]) [data-testid="results-card"]')?.textContent ?? ""));
check((await selected()) === "2", "↓ again: the UPDATE, and the grid says 1 row changed");
await page.keyboard.press("ArrowUp");
await page.waitForFunction(() => document.querySelector('[data-testid="workspace"]:not([hidden]) [data-row-count]')?.getAttribute("data-row-count") === "3");
check((await selected()) === "1", "↑ goes back");

// The run's last statement keeps its cursor: Load more, also after
// looking at another one and coming back.
await setSql("SELECT status, count(*) FROM orders GROUP BY status;\nSELECT id, email FROM users;");
await page.focus(editor);
await page.keyboard.press("Control+Alt+Enter");
await page.waitForSelector(row(1));
await idle();
check((await page.$(`${ws} [data-load-more]`)) !== null, "the last statement can load more");
await page.click(row(0));
await page.waitForFunction(() => !document.querySelector('[data-testid="workspace"]:not([hidden]) [data-load-more]'));
await page.click(row(1));
await page.waitForSelector(`${ws} [data-load-more]`);
// Load more grows the shown statement, and its row in the list says so.
await page.click(`${ws} [data-load-more]`);
await page.waitForFunction((sel) => /250 rows/.test(document.querySelector(sel)?.textContent ?? ""), `${row(1)} [data-testid="statement-outcome"]`);
await page.click(row(0));
await page.click(row(1));
await page.waitForFunction(() => document.querySelector('[data-testid="workspace"]:not([hidden]) [data-row-count]')?.getAttribute("data-row-count") === "250");
check(true, "still loads more after showing another statement, and keeps the rows it loaded");

// A failing statement stops the run; its row says Error and its error shows.
await page.evaluate(() => (window.__RUNS__ = []));
const bad = "SELECT status, count(*) FROM orders GROUP BY status;\nSELECT nmae FROM orders;\nSELECT 2;";
await setSql(bad);
await page.focus(editor);
await page.keyboard.press("Control+Alt+Enter");
await page.waitForSelector(`${ws} [data-query-error="42703"]`);
await idle();
check((await page.evaluate(() => window.__RUNS__.length)) === 2, "the run stops at the failing statement");
check((await page.$$(`${list} [data-statement]`)).length === 2, "the list holds what ran");
check((await page.getAttribute(row(1), "data-state")) === "error" && (await selected()) === "1", "the failed one is marked and shown");
await page.screenshot({ path: `${OUT}/3-stops-at-error.png` });
await page.click(row(0));
await page.waitForFunction(() => document.querySelector('[data-testid="workspace"]:not([hidden]) [data-row-count]')?.getAttribute("data-row-count") === "3");
check((await page.$(`${ws} [data-query-error]`)) === null, "the statement before it still shows its rows");

// One statement, ⌘↵ at the caret: the list goes away.
await setSql("SELECT 1;");
await page.focus(editor);
await page.keyboard.press("Control+Enter");
await page.waitForFunction(() => window.__RUNS__.at(-1) === "SELECT 1;");
await idle();
check((await page.$(list)) === null, "a single statement's run has no list");
await page.screenshot({ path: `${OUT}/4-single-run.png` });

// Dark.
await setSql(script);
await page.focus(editor);
await page.keyboard.press("Control+Alt+Enter");
await page.waitForSelector(row(3));
await idle();
await page.emulateMedia({ colorScheme: "dark" });
await page.waitForTimeout(200);
await page.screenshot({ path: `${OUT}/5-run-all-dark.png` });
await browser.close();
