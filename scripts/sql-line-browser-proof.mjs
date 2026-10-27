#!/usr/bin/env node
// The SQL line on a table tab (stubbed `invoke`; the stub builds SQL the way
// core does), the Paper head chosen on 2026-10-10: a read-only QUERY row
// with the exact first-page SQL, coloured like the editor, LIMIT as the
// page-size control and Edit SQL at its right end, over a WHERE row holding
// the filter chips, "1,000 of ≈36,150 rows · 3 ms" and refresh. No Open in
// query tab chip, no results header: chrome before the grid header ≤ 124 px. ⌘F opens the
// WHERE editor in the line; # (or a click on ≈) counts exactly; a selected
// block reads count · sum · avg; Edit SQL opens exactly the line's SQL.
//
//   cd apps/rowkery-tauri && npx vite --port 1420 &
//   node scripts/sql-line-browser-proof.mjs [outDir]
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
const OUT = process.argv[2] ?? "/tmp/rowkery-proof/sql-line";
const URL = process.env.ROWKERY_DEV_URL ?? "http://localhost:1420/";
const FRAMES_SHIM = new globalThis.URL("./lib/frames-shim.js", import.meta.url).pathname;
mkdirSync(OUT, { recursive: true });

function stubTauri() {
  localStorage.clear();
  window.__CALLS__ = [];
  const TOTAL = 36150;
  const col = (name, type_name) => ({ name, type_name, nullable: false });
  const tables = [{ name: "wallet_tx", kind: "table", columns: [col("id", "int8"), col("amount", "numeric"), col("status", "text")], primary_key: ["id"], indexes: [], foreign_keys: [], row_estimate: { Approximate: TOTAL }, partition_of: null }];
  // Like core's table_browse_query (first page).
  const browseSql = (a) => {
    let sql = `SELECT * FROM ${a.schema}.${a.table}`;
    if (a.filter?.trim()) sql += `\nWHERE (${a.filter.trim()})`;
    const order = [...(a.order ?? []).map((o) => `${o.column}${o.desc ? " DESC" : ""} NULLS LAST`), ...(a.key ?? []).filter((k) => !(a.order ?? []).some((o) => o.column === k))];
    if (order.length) sql += `\nORDER BY ${order.join(", ")}`;
    if (a.limit) sql += `\nLIMIT ${a.limit}`;
    return sql + ";";
  };
  window.__TAURI_INTERNALS__ = {
    metadata: { currentWindow: { label: "main" }, currentWebview: { label: "main" } },
    transformCallback: () => 0,
    invoke: async (cmd, args) => {
      window.__CALLS__.push([cmd, args]);
      switch (cmd) {
        case "list_connections":
          return { connections: [{ kind: "postgres", id: "pg", name: "wallet-prd", host: "db", port: 5432, database: "wallet", username: "app" }], active_connection_id: null };
        case "open_window":
          return { database: "wallet", catalog: { databases: [{ name: "wallet", schemas: [{ name: "public", tables }] }] }, elapsed_ms: 2, cached: false, open_seq: 1 };
        case "browse_table_sql":
          return browseSql(args);
        case "run_query": {
          const limit = Number(/LIMIT (\d+)/.exec(args.sql)?.[1] ?? 1000);
          const filtered = /WHERE/.test(args.sql);
          const n = filtered ? 312 : Math.min(limit, TOTAL);
          return {
            columns: [{ name: "id", type_name: "int8" }, { name: "amount", type_name: "numeric" }, { name: "status", type_name: "text" }],
            rows: Array.from({ length: n }, (_, i) => [{ Int: 48207 - i }, { Text: ["920.00", "410.50", "388.00"][i % 3] }, { Text: i % 4 ? "settled" : "pending" }]),
            row_count: n,
            elapsed_ms: 3,
            error: null,
            cancelled: false,
          };
        }
        case "count_rows":
          await new Promise((r) => setTimeout(r, 50));
          return args.filter ? 312 : 36152;
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
const line = `${ws} [data-sql-line]`;
const lineText = () => page.getAttribute(`${line} [data-sql-text]`, "data-sql-text");
const end = () => page.textContent(`${line} [data-line-end]`);
await page.waitForSelector('[data-testid="workspace"]:not([hidden])'); // Paper (2026-10-10): an empty window shows no connection chip (no tab row without a connection); wait for the window, then ⇧⌘O as before.
await page.keyboard.press("Control+Shift+O");
await page.waitForSelector('[data-testid="conn-popover"]');
await page.keyboard.press("Enter");
await page.waitForSelector(`${ws}[data-conn-state="connected"]`);
await page.click(`${ws} [data-table="wallet.public.wallet_tx"] [data-testid="sb-row-main"]`);
await page.waitForSelector(`${ws} [data-row]`);
await page.waitForFunction((sel) => document.querySelector(sel)?.getAttribute("data-sql-text"), `${line} [data-sql-text]`);

// The line: exact SQL, literals as sent.
check((await lineText()) === "SELECT * FROM public.wallet_tx ORDER BY id LIMIT 1000;", `line: ${await lineText()}`);
check((await page.textContent(`${line} [data-limit]`)) === "LIMIT 1000", "LIMIT 1000 as sent (never 1,000)");
// Class on purpose: .k is the keyword colour under test.
check((await page.$(`${line} [data-sql-text] .k`)) !== null, "coloured like the editor");
check((await end()).includes("1,000 of ≈36,150") && (await end()).includes("3 ms"), `right end: ${await end()}`);
check((await page.textContent(`${line} [data-sql-query] [data-edit-sql]`)).includes("Edit SQL"), "Edit SQL at the right end of the QUERY row");
// No WHERE field, no Open in query tab chip, no results header.
check(!(await page.isVisible(`${ws} [data-testid="results-card"] [data-testid="card-toolbar"]`)), "the line replaces the results header");
// Paper (2026-10-10): Data | Structure sits at the tab row's right again, not in the line.
check((await page.$(`${ws} [data-testid="editor-header"] [data-testid="view-switch"]`)) !== null && !(await page.$(`${line} [data-testid="view-switch"]`)), "Data | Structure at the tab row's right (Paper), not in the line");
const chrome = await page.evaluate((sel) => {
  const main = document.querySelector(`${sel} [data-testid="main"]`).getBoundingClientRect().top;
  const header = document.querySelector(`${sel} [data-testid="rg-header"]`)?.getBoundingClientRect().top;
  return Math.round(header - main);
}, ws);
// Paper (2026-10-10) chose the prototype's two rows, QUERY over WHERE (12/16/10 px padding, 1 px rule): 121 px measured.
check(chrome <= 124, `chrome before the grid header: ${chrome}px (the two-row Paper head under the tab row; the one-line head was 79)`);
const rows = await page.evaluate((sel) => {
  const q = document.querySelector(`${sel} [data-sql-query]`).getBoundingClientRect();
  const w = document.querySelector(`${sel} [data-testid="sql-line-where"]`).getBoundingClientRect();
  return { q: q.top, w: w.top };
}, line);
check(rows.w > rows.q + 15, `QUERY row over the WHERE row (${rows.q} → ${rows.w})`);
await page.screenshot({ path: `${OUT}/1-line.png` });

// # counts exactly.
await page.click(`${ws} [data-row="0"] [data-col="0"]`);
await page.keyboard.press("Shift+Digit3");
await page.waitForFunction((sel) => document.querySelector(sel)?.textContent.includes("36,152"), `${line} [data-line-end]`);
check((await end()).includes("1,000 of 36,152"), `# counted exactly: ${await end()}`);

// A selected block: count · sum · avg in place of the count.
await page.click(`${ws} [data-row="0"] [data-col="1"]`);
await page.click(`${ws} [data-row="2"] [data-col="1"]`, { modifiers: ["Shift"] });
await page.waitForSelector(`${line} [data-stats]`);
check((await page.textContent(`${line} [data-stats]`)) === "3 cells · sum 1,718.50 · avg 572.83", `stats: ${await page.textContent(`${line} [data-stats]`)}`);
await page.screenshot({ path: `${OUT}/2-stats.png` });
await page.click(`${ws} [data-row="5"] [data-col="0"]`);
await page.waitForFunction((sel) => !document.querySelector(sel), `${line} [data-stats]`);
check(true, "deselecting brings the count back");

// LIMIT → page size.
await page.click(`${line} [data-limit]`);
await page.waitForSelector('[data-menu="page-size"]');
await page.click('[data-menu="page-size"] [data-item="5000"]');
await page.waitForFunction((sel) => document.querySelector(sel)?.getAttribute("data-sql-text")?.endsWith("LIMIT 5000;"), `${line} [data-sql-text]`);
check((await lineText()) === "SELECT * FROM public.wallet_tx ORDER BY id LIMIT 5000;", "LIMIT menu: 5000 rows rewrites the literal");

// ⌘F: the WHERE editor in the line; ↵ applies, the line shows WHERE.
await page.keyboard.press("Control+f");
await page.waitForSelector(`${line}[data-editing] [data-testid="sql-editor"]`);
await page.keyboard.type("status = 'pending'");
await page.screenshot({ path: `${OUT}/3-filter.png` });
await page.keyboard.press("Enter");
await page.waitForFunction((sel) => document.querySelector(sel)?.getAttribute("data-sql-text")?.includes("WHERE"), `${line} [data-sql-text]`);
check((await lineText()) === "SELECT * FROM public.wallet_tx WHERE (status = 'pending') ORDER BY id LIMIT 5000;", `filtered: ${await lineText()}`);
await page.waitForFunction((sel) => document.querySelector(sel)?.textContent.includes("312 of 312"), `${line} [data-line-end]`);
check(true, "a filtered result that fits reads 312 of 312 (no ≈)");

// ↻ and ⌘R run the first page again.
const browses = () => page.evaluate(() => window.__CALLS__.filter(([c]) => c === "run_query").length);
let before = await browses();
await page.click(`${line} [data-refresh-rows]`);
await page.waitForFunction((n) => window.__CALLS__.filter(([c]) => c === "run_query").length > n, before);
before = await browses();
await page.click(`${ws} [data-row="1"] [data-col="0"]`);
await page.keyboard.press("Control+R");
await page.waitForFunction((n) => window.__CALLS__.filter(([c]) => c === "run_query").length > n, before);
check(true, "↻ and ⌘R refresh the rows");

// All rows: no LIMIT in the SQL, but the page size still opens from the line.
await page.click(`${line} [data-limit]`);
await page.click('[data-menu="page-size"] [data-item="0"]');
await page.waitForFunction((sel) => !document.querySelector(sel)?.getAttribute("data-sql-text")?.includes("LIMIT"), `${line} [data-sql-text]`);
await page.waitForSelector(`${line} [data-limit="0"]`);
await page.click(`${line} [data-limit="0"]`);
await page.click('[data-menu="page-size"] [data-item="5000"]');
await page.waitForFunction((sel) => document.querySelector(sel)?.getAttribute("data-sql-text")?.endsWith("LIMIT 5000;"), `${line} [data-sql-text]`);
check(true, "All rows can go back to paged (the 'all rows' control)");

// A long line gives way in its body: LIMIT stays in view.
await page.setViewportSize({ width: 900, height: 800 });
await page.waitForTimeout(100);
const limitBox = await page.locator(`${line} [data-limit]`).boundingBox();
const lineBox = await page.locator(`${line} [data-sql-text]`).boundingBox();
check(!!limitBox && limitBox.x + limitBox.width <= lineBox.x + lineBox.width + 1, "narrow window: LIMIT still visible, the body is cut instead");
await page.screenshot({ path: `${OUT}/4-narrow.png` });
await page.setViewportSize({ width: 1280, height: 800 });

// ⌥↵ from ⌘K on a table tab inserts into the WHERE editor (opened first).
await page.keyboard.press("Control+k");
await page.keyboard.type("wallet_tx");
await page.waitForSelector('[data-testid="cp-row"]');
await page.keyboard.press("Alt+Enter");
await page.waitForSelector(`${line}[data-editing] textarea[data-testid="sql-editor"]`);
await page.waitForFunction((sel) => document.querySelector(sel)?.value.includes("wallet_tx"), `${line} textarea[data-testid="sql-editor"]`);
check(true, "⌥↵ from ⌘K inserts into the table tab's WHERE editor");
await page.keyboard.press("Escape");

// Edit SQL ⌘E opens exactly this SQL.
await page.keyboard.press("Control+e");
await page.waitForFunction(() => document.querySelector('[data-testid="workspace"]:not([hidden]) textarea[data-testid="sql-editor"]')?.value.includes("WHERE"));
const opened = await page.inputValue(`${ws} textarea[data-testid="sql-editor"]`);
check(opened === "SELECT * FROM public.wallet_tx\nWHERE (status = 'pending')\nORDER BY id\nLIMIT 5000;", `Edit SQL opened the line's SQL: ${JSON.stringify(opened)}`);
await browser.close();
