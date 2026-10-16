#!/usr/bin/env node
// Closed tabs and their rows without a Tauri webview (stubbed `invoke`),
// macOS keys: within the Undo toast, ⌘⇧T (or Undo) puts a closed tab back
// with its rows and runs nothing; once the toast has gone, Recently closed
// keeps the tab's SQL but not its rows, so a reopened query tab waits for ⌘↵
// and a reopened table tab browses again. Ten closed 2,000-row results don't
// stay in memory, nor do thirty re-runs of one tab's query: live result
// objects are counted after a forced GC (CDP).
//
//   cd apps/rowkery-tauri && npx vite --port 1420 &
//   node scripts/closed-tab-rows-browser-proof.mjs [outDir]
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

const OUT = process.argv[2] ?? "/tmp/rowkery-proof/closed-tab-rows";
const URL = process.env.ROWKERY_DEV_URL ?? "http://localhost:1420/";
mkdirSync(OUT, { recursive: true });

function stubTauri() {
  Object.defineProperty(Navigator.prototype, "platform", { get: () => "MacIntel", configurable: true });
  const connections = [{ kind: "postgres", id: "shop", name: "Shop", host: "127.0.0.1", port: 5432, database: "shop", username: "app", environment: "local" }];
  const catalog = {
    databases: [
      {
        name: "shop",
        schemas: [
          {
            name: "public",
            tables: [
              {
                name: "kiosks",
                columns: [{ name: "id", type_name: "int8", nullable: false }, { name: "name", type_name: "text", nullable: true }],
                primary_key: ["id"],
                indexes: [],
                row_estimate: { Approximate: 50 },
                partition_of: null,
              },
            ],
          },
        ],
      },
    ],
  };
  window.__RUNS__ = [];
  window.__TAURI_INTERNALS__ = {
    metadata: { currentWindow: { label: "main" }, currentWebview: { label: "main" } },
    transformCallback: () => 0,
    invoke: async (cmd, args) => {
      switch (cmd) {
        case "check_for_update":
          return { status: "off" };
        case "list_connections":
          return { connections: structuredClone(connections), active_connection_id: null };
        case "open_window":
          return { database: "shop", catalog, elapsed_ms: 5 };
        case "browse_table_sql":
          return `SELECT * FROM ${args.schema}.${args.table} ORDER BY id LIMIT 1000;`;
        case "run_query": {
          window.__RUNS__.push(args.sql);
          const n = /big/.test(args.sql) ? 2000 : /kiosks/.test(args.sql) ? 50 : 1;
          const columns = Array.from({ length: 8 }, (_, i) => ({ name: `c${i}`, type_name: "text" }));
          return {
            columns,
            rows: Array.from({ length: n }, (_, r) => columns.map((_, i) => ({ Text: `row ${r} value ${i} ${args.sql.length}` }))),
            row_count: n,
            elapsed_ms: 1,
            error: null,
            cancelled: false,
          };
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
const page = await (await browser.newContext({ viewport: { width: 1200, height: 760 } })).newPage();
page.on("pageerror", (e) => {
  console.error("pageerror:", e.message);
  process.exitCode = 1;
});
await page.addInitScript({ path: FRAMES_SHIM });
await page.addInitScript(stubTauri);
await page.addInitScript(() => {
  localStorage.clear();
  localStorage.setItem("rowkery.windows", JSON.stringify({ windows: [{ connectionId: "shop", database: "shop" }], active: 0 }));
});
await page.goto(URL);
const W = '[data-testid="workspace"]:not([hidden])';
await page.waitForSelector(W + '[data-conn-state="connected"]');

const runs = () => page.evaluate(() => window.__RUNS__.length);
const rowsShown = () => page.locator(`${W} [data-row]`).count();
const editorSql = () => page.inputValue(`${W} [data-testid="sql-editor"]`);
const tabTitles = () => page.$$eval(`${W} [data-testid="query-tab"]`, (els) => els.map((e) => e.dataset.title));
// ⌘W and ⇧⌘T are menu bar items on macOS: they reach the page as `rowkery:command`.
const menu = (id) => page.evaluate((id) => window.dispatchEvent(new CustomEvent("rowkery:command", { detail: id })), id);
const closeTab = () => menu("close-tab");
const reopenTab = () => menu("reopen-closed-tab");
const toastGone = () => page.waitForSelector("[data-toast]", { state: "detached", timeout: 15_000 });
const runSql = async (sql) => {
  await page.click(`${W} [data-testid="query-tab-add"]`);
  await page.fill(`${W} [data-testid="sql-editor"]`, sql);
  await page.keyboard.press("Meta+Enter");
  await page.waitForSelector(`${W} [data-row="0"]`);
};

// 1. Within the toast, ⌘⇧T puts the tab back with its rows and runs nothing.
await runSql("SELECT 'kept' AS mine;");
let before = await runs();
await closeTab();
await page.waitForSelector("[data-toast]");
await reopenTab();
await page.waitForSelector(`${W} [data-row="0"]`);
check((await runs()) === before && (await editorSql()) === "SELECT 'kept' AS mine;", "within the Undo toast, ⌘⇧T brings the rows back without running anything");

// 2. After the toast: the SQL comes back, the rows don't, nothing runs until ⌘↵.
await closeTab();
await toastGone();
before = await runs();
await reopenTab();
await page.waitForFunction((ws) => document.querySelector(`${ws} [data-testid="sql-editor"]`)?.value === "SELECT 'kept' AS mine;", W);
await page.waitForTimeout(300);
check((await rowsShown()) === 0 && (await runs()) === before, "after the toast, a reopened query tab has its SQL and no rows, and runs nothing");
await page.screenshot({ path: `${OUT}/1-reopened-query.png` });
console.log(`${OUT}/1-reopened-query.png`);
await page.click(`${W} [data-testid="sql-editor"]`);
await page.keyboard.press("Meta+Enter");
await page.waitForSelector(`${W} [data-row="0"]`);
check((await runs()) === before + 1, "⌘↵ runs it again");

// 3. A table tab reopened after the toast browses again.
await page.click(`${W} [data-table$=".public.kiosks"] [data-testid="sb-row-main"]`, { modifiers: ["Meta"] });
await page.waitForSelector(`${W} [data-testid="query-tab"][data-on][data-title="kiosks"]`);
await page.waitForSelector(`${W} [data-row="0"]`);
await closeTab();
await toastGone();
before = await runs();
await reopenTab();
await page.waitForSelector(`${W} [data-testid="query-tab"][data-on][data-title="kiosks"]`);
await page.waitForSelector(`${W} [data-row="0"]`);
check((await runs()) === before + 1, `a reopened table tab browses again (${(await tabTitles()).join(", ")})`);

// 4. Ten closed 2,000-row results don't stay in memory.
const cdp = await page.context().newCDPSession(page);
const { result: proto } = await cdp.send("Runtime.evaluate", {
  expression: `(() => {
    const el = document.querySelector('${W} [data-testid="results-grid-wrap"]');
    const key = Object.keys(el).find((k) => k.startsWith("__reactFiber$"));
    for (let f = el[key]; f; f = f.return) {
      const p = f.memoizedProps || {};
      const r = p.rows || (p.result && p.result.rows);
      if (r && typeof r.appendFrame === "function") return Object.getPrototypeOf(r);
    }
    return null;
  })()`,
});
const liveResults = async () => {
  await cdp.send("HeapProfiler.collectGarbage");
  await cdp.send("HeapProfiler.collectGarbage");
  const { objects } = await cdp.send("Runtime.queryObjects", { prototypeObjectId: proto.objectId });
  const { result } = await cdp.send("Runtime.callFunctionOn", { objectId: objects.objectId, functionDeclaration: "function () { return this.length; }", returnByValue: true });
  return result.value;
};
const start = await liveResults();
for (let i = 0; i < 10; i++) {
  await runSql(`SELECT * FROM big /* ${i} */;`);
  await closeTab();
  await page.waitForSelector("[data-toast]");
}
await toastGone();
const after = await liveResults();
check(after - start <= 1, `10 closed 2,000-row tabs leave ${after - start} more live results (${start} → ${after})`);
check((await tabTitles()).length <= 3, `the tab row is back to ${(await tabTitles()).join(", ")}`);

// 5. Re-running one tab's query keeps only the latest result. The editor's
// callbacks used to chain every render they were made in, and each render
// held the result shown then.
await runSql("SELECT * FROM big;");
const beforeReruns = await liveResults();
for (let i = 0; i < 30; i++) {
  const n = await runs();
  await page.fill(`${W} [data-testid="sql-editor"]`, `SELECT * FROM big /* ${i} */;`);
  await page.keyboard.press("Meta+Enter");
  await page.waitForFunction((n) => window.__RUNS__.length > n, n);
  await page.waitForSelector(`${W} [data-row="0"]`);
}
const afterReruns = await liveResults();
// The latest result, React's previous render of it and one still settling: a
// handful at most (before the fix, one per run).
check(afterReruns - beforeReruns <= 5, `30 re-runs in one tab leave ${afterReruns - beforeReruns} more live results (${beforeReruns} → ${afterReruns})`);

await browser.close();
