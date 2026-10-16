#!/usr/bin/env node
// Run All Statements proof without a Tauri webview (stubbed `invoke`): ⌘K
// "Run all statements" sends each statement of the editor as its own run, in
// order, on the tab (a server takes one statement per query: the whole text
// as one run failed on Postgres with "cannot insert multiple commands into a
// prepared statement"); the results show the last statement's; a failing
// statement stops the rest. The real app path is scripts/e2e (QRY-3b).
//
//   cd apps/rowkery-tauri && npx vite --port 1420 &
//   node scripts/run-all-browser-proof.mjs [outDir]
import { createRequire } from "node:module";
import { mkdirSync } from "node:fs";
import { execSync } from "node:child_process";

const FRAMES_SHIM = new globalThis.URL("./lib/frames-shim.js", import.meta.url).pathname;

const require = createRequire(import.meta.url);
let playwright;
try {
  playwright = require("playwright");
} catch {
  const root = execSync("npm root -g").toString().trim();
  playwright = require(`${root}/playwright`);
}

const OUT = process.argv[2] ?? "/tmp/rowkery-proof/run-all";
const URL = process.env.ROWKERY_DEV_URL ?? "http://localhost:1420/";
mkdirSync(OUT, { recursive: true });

function stubTauri() {
  const connections = [
    { kind: "postgres", id: "local", name: "Docker Postgres", host: "127.0.0.1", port: 54329, database: "rowkery", username: "rowkery", environment: "local" },
  ];
  const catalog = { databases: [{ name: "rowkery", schemas: [{ name: "public", tables: [] }] }] };
  window.__RUNS__ = [];
  window.__TAURI_INTERNALS__ = {
    metadata: { currentWindow: { label: "main" }, currentWebview: { label: "main" } },
    transformCallback: () => 0,
    invoke: async (cmd, args) => {
      switch (cmd) {
        case "list_connections":
          return { connections: structuredClone(connections), active_connection_id: null };
        case "open_window":
          return { database: "rowkery", catalog, elapsed_ms: 10 };
        case "run_query": {
          window.__RUNS__.push(args.sql);
          // Like Postgres: one statement per query.
          const count = args.sql.split(";").filter((s) => s.trim()).length;
          await new Promise((r) => setTimeout(r, 30));
          if (count > 1)
            return { columns: [], rows: [], row_count: 0, elapsed_ms: 1, error: "cannot insert multiple commands into a prepared statement", cancelled: false };
          if (args.sql.includes("boom"))
            return { columns: [], rows: [], row_count: 0, elapsed_ms: 1, error: 'column "boom" does not exist', cancelled: false };
          const n = /SELECT (\d+)/i.exec(args.sql)?.[1] ?? "0";
          return { columns: [{ name: "n", type_name: "int4" }], rows: [[{ Int: Number(n) }]], row_count: 1, elapsed_ms: 1, error: null, cancelled: false };
        }
        default:
          return null;
      }
    },
  };
}

const browser = await playwright.chromium.launch({ executablePath: process.env.CHROMIUM_PATH ?? "/opt/pw-browsers/chromium" });
const check = (cond, msg) => {
  if (!cond) {
    console.error(`FAIL: ${msg}`);
    process.exitCode = 1;
  } else console.log(`ok: ${msg}`);
};
const page = await (await browser.newContext({ viewport: { width: 1100, height: 720 }, deviceScaleFactor: 2 })).newPage();
page.on("pageerror", (e) => {
  console.error("pageerror:", e.message);
  process.exitCode = 1;
});
await page.addInitScript({ path: FRAMES_SHIM });
await page.addInitScript(stubTauri);
await page.addInitScript(() => {
  localStorage.clear();
  localStorage.setItem("rowkery.windows", JSON.stringify({ windows: [{ connectionId: "local", database: "rowkery" }], active: 0 }));
});
await page.goto(URL);
const visible = '[data-testid="workspace"]:not([hidden])';
await page.waitForSelector(visible + '[data-conn-state="connected"]');
const runAll = async (sql) => {
  await page.evaluate(() => (window.__RUNS__ = []));
  await page.click(visible + ' [data-testid="sql-editor"]');
  await page.keyboard.press("ControlOrMeta+a");
  await page.keyboard.type(sql);
  await page.keyboard.press("Control+k");
  await page.keyboard.type(">run all statements");
  await page.waitForSelector('[data-testid="cp-row"][data-item="cmd:run-all"]');
  await page.keyboard.press("Enter");
  await page.waitForTimeout(600);
  return page.evaluate(() => window.__RUNS__);
};

// 1. Three statements: three runs in order; the last result shows.
let runs = await runAll("SELECT 1;\nSELECT 2;\nSELECT 3;");
check(JSON.stringify(runs) === JSON.stringify(["SELECT 1;", "SELECT 2;", "SELECT 3;"]), `each statement runs on its own, in order: ${JSON.stringify(runs)}`);
const cell = await page.locator(visible + ' [data-row="0"] [data-col="0"]').textContent();
check(cell === "3", `the last statement's result shows (${cell})`);
const card = await page.locator(visible + ' [data-testid="results-card"]').boundingBox();
await page.screenshot({ path: `${OUT}/1-run-all.png`, clip: { x: card.x - 8, y: card.y - 8, width: card.width + 16, height: card.height + 16 } });
console.log(`${OUT}/1-run-all.png`);

// 2. A failing statement stops the rest and shows its error.
runs = await runAll("SELECT 1;\nSELECT boom;\nSELECT 3;");
check(JSON.stringify(runs) === JSON.stringify(["SELECT 1;", "SELECT boom;"]), `a failing statement stops the rest: ${JSON.stringify(runs)}`);
check((await page.locator(visible + ' [data-testid="card-meta"][data-state="error"]').count()) === 1, "its error shows");

// 3. ⌘↵ still runs only the statement at the caret.
await page.evaluate(() => (window.__RUNS__ = []));
await page.click(visible + ' [data-testid="sql-editor"]');
await page.keyboard.press("Control+Enter");
await page.waitForTimeout(300);
const one = await page.evaluate(() => window.__RUNS__);
check(one.length === 1, `⌘↵ runs one statement: ${JSON.stringify(one)}`);

await browser.close();
