#!/usr/bin/env node
// rowkery/reports#45, a result of 3 MB cells (stubbed `invoke`): the grid
// puts the start of each value in the DOM, not all of it; the tooltip is
// short; ⌘C / Ctrl+C still copies the whole value; and moving through rows
// with Quick Look open stays quick.
//
//   cd apps/rowkery-tauri && npx vite --port 1420 &
//   node scripts/big-cells-browser-proof.mjs [outDir]
import { createRequire } from "node:module";
import { mkdirSync } from "node:fs";
import { execSync } from "node:child_process";

// run_query answers stream as frames (src-tauri `Frame`); the stub keeps returning results.
const FRAMES_SHIM = new globalThis.URL("./lib/frames-shim.js", import.meta.url).pathname;

const require = createRequire(import.meta.url);
let playwright;
try {
  playwright = require("playwright");
} catch {
  playwright = require(`${execSync("npm root -g").toString().trim()}/playwright`);
}
const OUT = process.argv[2] ?? "/tmp/rowkery-proof/big-cells";
const URL = process.env.ROWKERY_DEV_URL ?? "http://localhost:1420/";
mkdirSync(OUT, { recursive: true });

function stubTauri() {
  localStorage.clear();
  const MB3 = 3 * 1024 * 1024;
  const json = `{"payload":"${"y".repeat(MB3)}"}`;
  const rows = [];
  for (let i = 0; i < 40; i++) rows.push([{ Int: i + 1 }, { Text: `${i}${"x".repeat(MB3)}` }, { Text: json }]);
  const result = {
    columns: [
      { name: "id", type_name: "int4" },
      { name: "body", type_name: "text" },
      { name: "event", type_name: "jsonb" },
    ],
    rows,
    row_count: rows.length,
    elapsed_ms: 1,
    error: null,
    cancelled: false,
  };
  window.__BIG = MB3;
  window.__TAURI_INTERNALS__ = {
    metadata: { currentWindow: { label: "main" }, currentWebview: { label: "main" } },
    transformCallback: () => 0,
    invoke: async (cmd) => {
      switch (cmd) {
        case "list_connections":
          return {
            connections: [
              { kind: "postgres", id: "pg", name: "docs", host: "127.0.0.1", port: 54329, database: "rowkery", username: "rowkery" },
            ],
            active_connection_id: null,
          };
        case "open_window":
          return { database: "rowkery", catalog: { databases: [{ name: "rowkery", schemas: [{ name: "public", tables: [] }] }] }, elapsed_ms: 2 };
        case "run_query":
          return structuredClone(result);
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

const browser = await playwright.chromium.launch({
  executablePath: process.env.CHROMIUM_PATH ?? "/opt/pw-browsers/chromium",
});
const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
await context.grantPermissions(["clipboard-read", "clipboard-write"], { origin: new globalThis.URL(URL).origin });
const page = await context.newPage();
page.on("pageerror", (e) => console.error("pageerror:", e.message));
await page.addInitScript({ path: FRAMES_SHIM });
await page.addInitScript(stubTauri);
await page.goto(URL);
await page.waitForSelector('[data-testid="workspace"]:not([hidden])');
await page.keyboard.press("Control+Shift+O");
await page.waitForSelector('[data-testid="conn-popover"]');
await page.keyboard.press("Enter");
await page.waitForSelector('[data-testid="sb-scroll"]');
await page.click('[data-testid="workspace"]:not([hidden]) textarea');
const cell = (r, c) => `[data-testid="workspace"]:not([hidden]) [data-row="${r}"] [data-col="${c}"]`;
const ran = Date.now();
await page.keyboard.press("Control+Enter");
await page.waitForSelector(cell(0, 1), { timeout: 120000 });
const painted = Date.now() - ran;
check(painted < 8000, `the rows paint ${painted} ms after ⌘↩`);
await page.waitForTimeout(1200);

const dom = await page.$$eval('[data-testid="workspace"]:not([hidden]) [role="gridcell"]', (cells) => ({
  text: cells.reduce((n, c) => n + (c.textContent ?? "").length, 0),
  title: Math.max(...cells.map((c) => (c.getAttribute("title") ?? "").length)),
  cells: cells.length,
}));
console.log(`grid cells in the DOM: ${dom.cells}, their text ${dom.text} chars, longest tooltip ${dom.title} chars`);
check(dom.text < 1_000_000, `the grid's DOM holds the start of each value, not megabytes (${dom.text} chars)`);
check(dom.title <= 301, `tooltips are short (${dom.title} chars)`);

await page.click(cell(0, 1));
await page.keyboard.press("Control+c");
await page.waitForTimeout(300);
const copied = await page.evaluate(() => navigator.clipboard.readText());
const big = await page.evaluate(() => window.__BIG);
check(copied.length === big + 1, `Ctrl+C copies the whole value (${copied.length} chars)`);

const plain = Date.now();
for (let i = 0; i < 10; i++) await page.keyboard.press("ArrowDown");
await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => setTimeout(r))));
const gridSteps = Date.now() - plain;
check(gridSteps < 2000, `10 steps in the grid take ${gridSteps} ms`);
for (let i = 0; i < 10; i++) await page.keyboard.press("ArrowUp");

// Quick Look open, then ↓ through rows: each step renders the 3 MB jsonb.
await page.keyboard.press(" ");
await page.waitForSelector(".ql-body");
const walked = Date.now();
for (let i = 0; i < 10; i++) await page.keyboard.press("ArrowDown");
await page.waitForFunction(() => document.querySelector('[data-looked] [role="rowheader"]')?.textContent?.trim() === "11", null, { timeout: 120000 }).catch(() => {});
const steps = Date.now() - walked;
check(steps < 5000, `10 steps with Quick Look open take ${steps} ms`);
await page.screenshot({ path: `${OUT}/1-big-cells.png` });
console.log(`${OUT}/1-big-cells.png`);
await browser.close();
