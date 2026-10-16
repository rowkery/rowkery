#!/usr/bin/env node
// ⌘E (Ctrl+E under the Linux pin) on a query tab shows the statement's plan
// in place of the results: the hint on top, one row per step with its own
// share of the time (or cost for an estimate), the slowest step tinted and
// open to its details, row guesses 10× off tagged. Run with timings asks for
// a timed plan; a timed plan of a write on a Confirm writes connection is
// held by the safety bar and sent with `confirmed` once confirmed. The next
// run brings the grid back. ⌘K lists Explain. Light and dark. The editor
// strip lists ⌘E plan and still fits at the narrowest window.
//
//   cd apps/rowkery-tauri && npx vite --port 1420 &
//   node scripts/query-plan-browser-proof.mjs [outDir]
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
const OUT = process.argv[2] ?? "/tmp/rowkery-proof/query-plan";
const URL = process.env.ROWKERY_DEV_URL ?? "http://localhost:1420/";
const FRAMES_SHIM = new globalThis.URL("./lib/frames-shim.js", import.meta.url).pathname;
mkdirSync(OUT, { recursive: true });

function stubTauri() {
  localStorage.clear();
  window.__EXPLAINS__ = [];
  window.__RUNS__ = [];
  const col = (name, type_name) => ({ name, type_name, nullable: false });
  const tables = [
    { name: "orders", columns: [col("id", "int8"), col("customer_id", "int8"), col("status", "text"), col("total", "numeric"), col("placed_at", "timestamptz")], primary_key: ["id"], indexes: [], foreign_keys: [], row_estimate: { Approximate: 2104700 }, partition_of: null },
    { name: "customers", columns: [col("id", "int8"), col("full_name", "text")], primary_key: ["id"], indexes: [], foreign_keys: [], row_estimate: { Approximate: 61000 }, partition_of: null },
  ];
  const step = (o) => ({ depth: 0, kind: "", schema: null, table: null, alias: null, index: null, note: null, expectedRows: null, actualRows: null, loops: null, ownMs: null, ownCost: null, miss: null, details: [], ...o });
  const hint = {
    text: "Seq scan on orders reads 2.1M rows to keep 312. orders.customer_id has no index.",
    sql: "CREATE INDEX ON public.orders (customer_id);",
    step: 2,
  };
  const timed = {
    timed: true, executionMs: 1842.6, planningMs: 0.4, rows: 312, slowest: 2, hint,
    steps: [
      step({ kind: "Sort", note: "by o.placed_at DESC", expectedRows: 9, actualRows: 312, loops: 1, ownMs: 4.0, ownCost: 10, miss: 34.7, details: [{ label: "Sort", value: "quicksort, 49 kB" }] }),
      step({ depth: 1, kind: "Nested Loop", expectedRows: 9, actualRows: 312, loops: 1, ownMs: 1.5, ownCost: 81, miss: 34.7 }),
      step({ depth: 2, kind: "Seq Scan", schema: "public", table: "orders", alias: "o", expectedRows: 9, actualRows: 312, loops: 1, ownMs: 1771, ownCost: 45900, miss: 34.7, details: [
        { label: "Filter", value: "(o.customer_id = 4012) AND (o.status = 'paid'::text)" },
        { label: "Removed", value: "2,104,388 rows" },
        { label: "Read", value: "27,410 pages, 61% from disk" },
      ] }),
      step({ depth: 2, kind: "Index Scan", schema: "public", table: "customers", alias: "c", index: "customers_pkey", expectedRows: 1, actualRows: 1, loops: 312, ownMs: 65.5, ownCost: 8.3, details: [{ label: "Index Cond", value: "c.id = o.customer_id" }] }),
    ],
  };
  const estimate = {
    ...timed, timed: false, executionMs: null, rows: null,
    hint: { ...hint, text: "Seq scan on orders reads about 2.1M rows to keep about 9. orders.customer_id has no index." },
    steps: timed.steps.map((s) => ({ ...s, actualRows: null, loops: null, ownMs: null, miss: null, details: s.details.filter((d) => d.label !== "Removed" && d.label !== "Read") })),
  };
  const deletePlan = {
    timed: true, executionMs: 12.1, planningMs: 0.2, rows: 0, slowest: 1, hint: null,
    steps: [
      step({ kind: "Delete", schema: "public", table: "orders", expectedRows: 0, actualRows: 0, loops: 1, ownMs: 0.4, ownCost: 0 }),
      step({ depth: 1, kind: "Index Scan", schema: "public", table: "orders", index: "orders_pkey", expectedRows: 10, actualRows: 10, loops: 1, ownMs: 11.2, ownCost: 40, details: [{ label: "Index Cond", value: "orders.id <= 10" }] }),
    ],
  };
  const done = { columns: [{ name: "id", type_name: "int8" }], rows: [[{ Int: 1 }], [{ Int: 2 }]], row_count: 2, elapsed_ms: 1, error: null, cancelled: false };
  window.__TAURI_INTERNALS__ = {
    metadata: { currentWindow: { label: "main" }, currentWebview: { label: "main" } },
    transformCallback: () => 0,
    invoke: async (cmd, args) => {
      switch (cmd) {
        case "list_connections":
          return { connections: [{ kind: "postgres", id: "pg", name: "shop", host: "db.stg.internal", port: 5432, database: "shop", username: "app", environment: "stg", safe_mode: "confirm" }], active_connection_id: null };
        case "open_window":
          return { database: "shop", catalog: { databases: [{ name: "shop", schemas: [{ name: "public", tables }] }] }, elapsed_ms: 2, cached: false, open_seq: 1 };
        case "run_query":
          window.__RUNS__.push(args.sql);
          return done;
        case "explain_statement": {
          window.__EXPLAINS__.push({ sql: args.sql, timed: args.timed, confirmed: args.confirmed });
          await new Promise((r) => setTimeout(r, 30));
          if (/^delete/i.test(args.sql)) {
            if (args.timed && !args.confirmed)
              return { kind: "held", hold: { action: "confirm", mode: "confirm", statements: [{ kind: "write", verb: "DELETE", target: "orders", destructive: false, unlocks_writes: false }] } };
            return { kind: "plan", plan: args.timed ? deletePlan : { ...deletePlan, timed: false }, elapsed_ms: 14 };
          }
          return { kind: "plan", plan: args.timed ? timed : estimate, elapsed_ms: args.timed ? 1850 : 3 };
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
const page = await browser.newPage({ viewport: { width: 1280, height: 760 }, deviceScaleFactor: 2 });
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
const setSql = async (text) => {
  await page.evaluate(([sel, text]) => {
    const ta = document.querySelector(sel);
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value").set.call(ta, text);
    ta.dispatchEvent(new Event("input", { bubbles: true }));
  }, [editor, text]);
  await page.focus(editor);
};
const explains = () => page.evaluate(() => window.__EXPLAINS__);
const plan = `${ws} [data-plan]`;

// ⌘E: the estimate, nothing run.
const query = `SELECT o.id, o.total, c.full_name
FROM orders o JOIN customers c ON c.id = o.customer_id
WHERE o.customer_id = 4012 AND o.status = 'paid'
ORDER BY o.placed_at DESC;`;
await setSql(query);
await page.keyboard.press("Control+e");
await page.waitForSelector(`${plan}:not([data-timed])`);
let calls = await explains();
check(calls.length === 1 && calls[0].timed === false && calls[0].sql === query, "⌘E asks for an estimate of the statement");
check((await page.evaluate(() => window.__RUNS__.length)) === 0, "nothing ran");
// Text on purpose: the header says what the card holds.
check((await page.textContent(`${ws} [data-testid="card-title"]`)) === "Plan", "the card is titled Plan");
check((await page.textContent(`${ws} [data-plan-meta]`)).startsWith("Estimate"), "the header says it is an estimate");
check((await page.$$(`${plan} [data-plan-step]`)).length === 4, "four steps");
check((await page.getAttribute(`${plan} [data-plan-step="2"]`, "data-slowest")) === "", "the seq scan is the slowest step");
check((await page.$(`${plan} [data-plan-step="2"][data-open]`)) !== null, "and opens to its details");
check((await page.$$(`${plan} [data-plan-miss]`)).length === 0, "an estimate tags no misses");
check((await page.textContent(`${plan} [data-plan-hint]`)).includes("orders.customer_id has no index"), "the hint names the column");
check((await page.$(`${ws} [data-testid="results-export"]`)) === null, "Export is hidden while the plan shows");
await page.screenshot({ path: `${OUT}/1-estimate.png` });

// Run with timings: real times and misses.
await page.click(`${ws} [data-plan-timed]`);
await page.waitForSelector(`${plan}[data-timed]`);
calls = await explains();
check(calls.at(-1).timed === true && calls.at(-1).sql === query, "Run with timings asks for a timed plan of the same statement");
check((await page.textContent(`${ws} [data-plan-meta]`)).includes("312 rows"), "the header counts the rows it returned");
check((await page.$$(`${plan} [data-plan-miss]`)).length === 3, "three row guesses tagged");
check((await page.$(`${plan} [data-plan-details]`)) !== null, "the slowest step's details show");
await page.screenshot({ path: `${OUT}/2-timed.png` });

// Clicking another step opens it instead.
await page.click(`${plan} [data-plan-step="3"]`);
check((await page.$(`${plan} [data-plan-step="3"][data-open]`)) !== null && (await page.$(`${plan} [data-plan-step="2"][data-open]`)) === null, "a click opens another step");
await page.click(`${plan} [data-plan-step="2"]`);

// Dark.
await page.evaluate(() => document.documentElement.setAttribute("data-theme", "dark"));
await page.waitForTimeout(150);
await page.screenshot({ path: `${OUT}/3-timed-dark.png` });
await page.evaluate(() => document.documentElement.setAttribute("data-theme", "light"));

// A timed plan of a write on Confirm writes: held, then sent confirmed.
await setSql("DELETE FROM orders WHERE id <= 10");
await page.keyboard.press("Control+e");
await page.waitForFunction(() => window.__EXPLAINS__.at(-1)?.sql.startsWith("DELETE") && !window.__EXPLAINS__.at(-1).timed);
await page.waitForSelector(`${plan}:not([data-timed])`);
check(true, "an estimate of a write runs nothing and needs no confirm");
await page.click(`${ws} [data-plan-timed]`);
await page.waitForSelector(`${ws} [data-testid="safe-bar"]`);
calls = await explains();
check(calls.at(-1).timed && !calls.at(-1).confirmed, "the timed plan of the write is held first");
await page.screenshot({ path: `${OUT}/4-write-held.png` });
await page.click(`${ws} [data-testid="safe-btn"][data-tone]`);
await page.waitForFunction(() => window.__EXPLAINS__.at(-1)?.confirmed === true);
await page.waitForSelector(`${plan}[data-timed]`);
check((await page.$(`${ws} [data-testid="safe-bar"]`)) === null, "confirmed: the bar goes and the timed plan shows");
await page.screenshot({ path: `${OUT}/5-write-timed.png` });

// The next run brings the grid back.
await setSql("SELECT id FROM orders");
await page.keyboard.press("Control+Enter");
await page.waitForFunction(() => window.__RUNS__.length === 1);
await page.waitForSelector(`${plan}`, { state: "detached" });
await page.waitForSelector(`${ws} [data-testid="results-export"]`);
check(true, "⌘↵ shows the results again");

// ⌘K lists Explain.
await page.keyboard.press("Control+k");
await page.keyboard.type("explain");
await page.waitForSelector('[data-item="cmd:explain"]');
check((await page.$('[data-item="cmd:explain-timed"]')) !== null, "⌘K lists Explain and Explain with timings");
await page.screenshot({ path: `${OUT}/6-palette.png` });
// Use breaks ties in ⌘K, and Run with timings was pressed above: pick by item.
await page.click('[data-item="cmd:explain"]');
await page.waitForSelector(`${plan}:not([data-timed])`);
check((await explains()).at(-1).sql === "SELECT id FROM orders", "⌘K Explain explains the editor's statement");
// That result was read from one table; its Data / Structure and table name go with it.
check((await page.textContent(`${ws} [data-testid="card-title"]`)) === "Plan" && !(await page.$(`${ws} [data-testid="card-table"]`)), "a plan over a one-table result is titled Plan, without its table");

// The editor's strip lists ⌘E plan beside Run, and fits at the narrowest window.
await page.setViewportSize({ width: 960, height: 640 });
await page.focus(editor);
await page.waitForTimeout(200);
const strip = await page.textContent(`${ws} [data-key-strip="editor"]`);
check(strip.includes("Ctrl+E plan"), `the editor strip lists Ctrl+E plan (${strip})`);
// Keys that don't fit are cut whole from the end: Run's key and ⌘E stay.
const fit = await page.evaluate((sel) => {
  const strip = document.querySelector(`${sel} [data-key-strip="editor"]`).getBoundingClientRect();
  const run = document.querySelector(`${sel} [data-testid="run-btn"]`).getBoundingClientRect();
  const card = document.querySelector(`${sel} .editor-card`).getBoundingClientRect();
  const shown = [...document.querySelectorAll(`${sel} [data-key-strip="editor"] [data-strip-item]`)]
    .filter((i) => { const r = i.getBoundingClientRect(); return r.top >= strip.top - 1 && r.bottom <= strip.bottom + 1 && r.left >= strip.left - 1; })
    .map((i) => i.dataset.stripItem);
  return { beside: strip.right <= run.left && strip.left >= card.left, shown };
}, ws);
check(fit.beside && fit.shown[0] === "run" && fit.shown[1] === "explain", `at 960 px it fits left of Run and keeps run and plan (${fit.shown.join(", ")})`);
await page.screenshot({ path: `${OUT}/7-strip-960.png` });
await browser.close();
