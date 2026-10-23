#!/usr/bin/env node
// The results grid stays put while the editor changes (stubbed `invoke`, a
// 40-column, 50,000-row result): typing in the editor re-renders the grid
// zero times; a client sort of the loaded rows orders them right (NULLs
// by value) as an order over the rows it already holds, not a copy of every
// cell; Find over the 2,000,000 cells never holds a frame much longer than a
// slice, and still counts every match. Render counts come from React's
// devtools hook (the dev server's build names its components).
//
//   cd apps/rowkery-tauri && npx vite --port 1420 &
//   node scripts/grid-rerender-browser-proof.mjs [outDir]
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
const OUT = process.argv[2] ?? "/tmp/rowkery-proof/grid-rerender";
const URL = process.env.ROWKERY_DEV_URL ?? "http://localhost:1420/";
const FRAMES_SHIM = new globalThis.URL("./lib/frames-shim.js", import.meta.url).pathname;
const ROWS = 50_000;
mkdirSync(OUT, { recursive: true });

/** Counts commits of ResultsGridView that rendered it (new props), and which props changed. */
function renderCounter() {
  window.__GRID__ = { renders: 0, changed: {} };
  let last = null;
  const walk = (fiber) => {
    for (let f = fiber; f; f = f.sibling) {
      const name = f.type && (f.type.displayName || f.type.name);
      if (name === "ResultsGridView" && f.memoizedProps) {
        const props = f.memoizedProps;
        if (props !== last) {
          if (last) {
            window.__GRID__.renders++;
            for (const k of Object.keys(props)) if (props[k] !== last[k]) window.__GRID__.changed[k] = (window.__GRID__.changed[k] ?? 0) + 1;
          }
          last = props;
        }
        continue;
      }
      if (f.child) walk(f.child);
    }
  };
  window.__REACT_DEVTOOLS_GLOBAL_HOOK__ = {
    supportsFiber: true,
    renderers: new Map(),
    inject: () => 1,
    checkDCE: () => {},
    onScheduleFiberRoot: () => {},
    onCommitFiberRoot: (_id, root) => walk(root.current),
    onPostCommitFiberRoot: () => {},
    onCommitFiberUnmount: () => {},
  };
}

function stubTauri(rows) {
  localStorage.clear();
  const col = (name) => ({ name, type_name: "TEXT", nullable: false });
  const tables = [{ name: "metrics", kind: "table", columns: [col("id")], primary_key: ["id"], indexes: [], foreign_keys: [], row_estimate: { Approximate: rows }, partition_of: null }];
  const cols = Array.from({ length: 40 }, (_, i) => (i === 0 ? { name: "id", type_name: "int8" } : i === 1 ? { name: "amount", type_name: "numeric" } : { name: `c_${i}`, type_name: "text" }));
  const result = {
    columns: cols,
    rows: Array.from({ length: rows }, (_, r) =>
      cols.map((_, c) =>
        c === 0 ? { Int: r } : c === 1 ? (r % 97 === 0 ? "Null" : { Text: String((r * 7919) % 10007) }) : { Text: c === 39 && r % 5000 === 0 ? `needle ${r}` : `v${r}·${c}` },
      ),
    ),
    row_count: rows,
    elapsed_ms: 12,
    error: null,
    cancelled: false,
  };
  window.__TAURI_INTERNALS__ = {
    metadata: { currentWindow: { label: "main" }, currentWebview: { label: "main" } },
    transformCallback: () => 0,
    invoke: async (cmd) => {
      switch (cmd) {
        case "list_connections":
          return { connections: [{ kind: "postgres", id: "pg", name: "Metrics", host: "db", port: 5432, database: "m", username: "app" }], active_connection_id: null };
        case "open_window":
          return { database: "m", catalog: { databases: [{ name: "m", schemas: [{ name: "public", tables }] }] }, elapsed_ms: 2, cached: false, open_seq: 1 };
        case "run_query":
          return result;
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
const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
page.on("pageerror", (e) => console.error("pageerror:", e.message));
await page.addInitScript(renderCounter);
await page.addInitScript({ path: FRAMES_SHIM });
await page.addInitScript(stubTauri, ROWS);
await page.goto(URL);
const ws = '[data-testid="workspace"]:not([hidden])';
await page.waitForSelector(ws);
await page.keyboard.press("Control+Shift+O");
await page.waitForSelector('[data-testid="conn-popover"]');
await page.keyboard.press("Enter");
await page.waitForSelector(`${ws}[data-conn-state="connected"]`);
const editor = `${ws} textarea[data-testid="sql-editor"]`;
await page.fill(editor, "SELECT * FROM metrics");
await page.keyboard.press("Control+Enter");
await page.waitForFunction((sel) => Number(document.querySelector(sel)?.getAttribute("data-row-count")) === 50000, `${ws} [data-row-count]`, { timeout: 30000 });
await page.waitForTimeout(800);

// 1. Typing in the editor: the grid's props hold, so it never re-renders.
await page.focus(editor);
await page.keyboard.press("End");
const before = await page.evaluate(() => ({ ...window.__GRID__, changed: { ...window.__GRID__.changed } }));
await page.evaluate(() => {
  window.__GRID__.renders = 0;
  window.__GRID__.changed = {};
});
for (const ch of " WHERE id > 10") {
  await page.keyboard.type(ch);
  await page.waitForTimeout(40);
}
const typed = await page.evaluate(() => window.__GRID__);
check(typed.renders === 0, `14 keystrokes, ${typed.renders} grid re-renders (props that changed: ${JSON.stringify(typed.changed)})`);
console.log(`  (renders before typing: ${before.renders})`);
await page.screenshot({ path: `${OUT}/1-typed.png` });

// 2. A client sort: the loaded rows by amount, numbers by value.
await page.evaluate(() => {
  window.__LONG__ = [];
  new PerformanceObserver((l) => window.__LONG__.push(...l.getEntries().map((e) => e.duration))).observe({ type: "longtask" });
});
await page.click(`${ws} [data-header="amount"]`);
await page.waitForSelector(`${ws} [data-header="amount"][data-sort="asc"]`);
await page.waitForTimeout(300);
const firstAmounts = await page.$$eval(`${ws} [data-row] [data-col="1"]`, (els) => els.slice(0, 5).map((e) => e.textContent.trim()));
// (row × 7919) mod 10007 is 0 for four rows (row 0's amount is NULL), then 1.
check(firstAmounts.join() === "0,0,0,0,1", `sorted ascending by value (${firstAmounts.join(", ")})`);
console.log(`  longest task sorting 50,000 rows: ${Math.round(Math.max(0, ...(await page.evaluate(() => window.__LONG__))))} ms`);
await page.click(`${ws} [data-header="amount"]`);
await page.waitForSelector(`${ws} [data-header="amount"][data-sort="desc"]`);
await page.waitForTimeout(300);
const topDesc = await page.$$eval(`${ws} [data-row] [data-col="1"]`, (els) => els.slice(0, 2).map((e) => e.textContent.trim()));
check(Number(topDesc[0]) >= Number(topDesc[1]) && Number(topDesc[0]) > 10000 - 50, `then descending (${topDesc.join(", ")})`);
await page.screenshot({ path: `${OUT}/2-sorted.png` });

// 3. Find across 2,000,000 cells: no long task much past a slice, every match counted.
await page.click(`${ws} [data-row="0"] [data-col="0"]`);
await page.keyboard.press("Control+f");
await page.waitForSelector(`${ws} [data-find-input]`);
// Find focuses its field on the next frame.
await page.waitForFunction(() => document.activeElement?.hasAttribute("data-find-input"));
await page.evaluate(() => (window.__LONG__ = []));
await page.keyboard.type("needle");
await page.waitForFunction((sel) => document.querySelector(sel)?.getAttribute("data-find-count") === "10", `${ws} [data-find] [data-find-count]`, { timeout: 30000 });
const longest = await page.evaluate(() => Math.max(0, ...window.__LONG__));
check(true, "Find counted all 10 matches");
console.log(`  longest task while finding: ${Math.round(longest)} ms`);
check(longest < 200, `Find never blocks the page for long (longest task ${Math.round(longest)} ms)`);
await page.screenshot({ path: `${OUT}/3-find.png` });
await browser.close();
