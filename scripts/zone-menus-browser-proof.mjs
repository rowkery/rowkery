#!/usr/bin/env node
// Zone menus proof with a stubbed Tauri `invoke`: each zone carries one `…`
// (the results head on a query tab, the SQL line's end on a table tab, the
// editor's foot left of Run, the schema panel's head) listing that zone's
// commands from the registry with their keys, only the ones that can run
// now; a pick runs the command. Data | Structure sits at the tab row's right
// on a table tab (Paper, 2026-10-10) and in the results head on a query tab
// that reads one table.
//
//   cd apps/rowkery-tauri && npx vite --port 1420 &
//   node scripts/zone-menus-browser-proof.mjs [outDir]
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

const OUT = process.argv[2] ?? "/tmp/rowkery-proof/zone-menus";
const URL = process.env.ROWKERY_DEV_URL ?? "http://localhost:1420/";
mkdirSync(OUT, { recursive: true });

function stubTauri() {
  const COLUMNS = [
    { name: "id", type_name: "int8", nullable: false },
    { name: "amount", type_name: "numeric", nullable: false },
    { name: "status", type_name: "text", nullable: false },
  ];
  const catalog = {
    databases: [
      {
        name: "wallet",
        schemas: [
          {
            name: "public",
            tables: [
              {
                name: "wallet_tx",
                columns: COLUMNS,
                primary_key: ["id"],
                indexes: [],
                row_estimate: { Approximate: 36150 },
                partition_of: null,
              },
            ],
          },
        ],
      },
    ],
  };
  const connections = [
    { kind: "postgres", id: "pg", name: "wallet-prd", host: "db.internal", port: 5432, database: "wallet", username: "app", environment: "prd" },
  ];
  // A table tab's page, as core would build it (the line shows exactly this).
  const browseSql = (a) => {
    let sql = `SELECT * FROM ${a.schema}.${a.table}`;
    if (a.filter?.trim()) sql += `\nWHERE (${a.filter.trim()})`;
    const order = [...(a.order ?? []).map((o) => `${o.column}${o.desc ? " DESC" : ""} NULLS LAST`), ...(a.key ?? []).filter((k) => !(a.order ?? []).some((o) => o.column === k))];
    if (order.length) sql += `\nORDER BY ${order.join(", ")}`;
    if (a.limit) sql += `\nLIMIT ${a.limit}`;
    return sql + ";";
  };
  window.__ROWKERY_CALLS__ = [];
  window.__TAURI_INTERNALS__ = {
    metadata: { currentWindow: { label: "main" }, currentWebview: { label: "main" } },
    transformCallback: () => 0,
    invoke: async (cmd, args) => {
      window.__ROWKERY_CALLS__.push([cmd, args]);
      switch (cmd) {
        case "list_connections":
          return { connections: structuredClone(connections), active_connection_id: null };
        case "open_window":
          await new Promise((r) => setTimeout(r, 30));
          return { database: "wallet", catalog, elapsed_ms: 30 };
        case "close_window":
          return null;
        case "probe_connection":
          return { ok: true, message: "PostgreSQL 16.4", elapsed_ms: 3 };
        case "browse_table_sql":
          return browseSql(args);
        case "run_query": {
          const n = /WHERE/.test(args.sql) ? 312 : 1000;
          return {
            columns: COLUMNS.map((c) => ({ name: c.name, type_name: c.type_name })),
            rows: Array.from({ length: n }, (_, i) => [{ Int: 48207 - i }, { Text: "920.00" }, { Text: i % 4 ? "settled" : "pending" }]),
            row_count: n,
            elapsed_ms: 3,
            error: null,
            cancelled: false,
            // A table page: the SQL line shows exactly what ran.
            sql: args.sql,
          };
        }
        case "count_rows":
          return 36152;
        default:
          return null;
      }
    },
  };
}

const browser = await playwright.chromium.launch({
  executablePath: process.env.CHROMIUM_PATH ?? "/opt/pw-browsers/chromium",
});
const context = await browser.newContext({ viewport: { width: 1280, height: 800 }, deviceScaleFactor: 2 });
const page = await context.newPage();
page.on("pageerror", (e) => console.error("pageerror:", e.message));
await page.addInitScript({ path: FRAMES_SHIM });
await page.addInitScript(stubTauri);
await page.goto(URL);
await page.waitForSelector('[data-testid="workspace"]:not([hidden])'); // Paper (2026-10-10): an empty window shows no connection chip (no tab row without a connection); wait for the window, then ⇧⌘O as before.

let failed = 0;
const check = (ok, what) => {
  console.log(`${ok ? "ok  " : "FAIL"} ${what}`);
  if (!ok) failed++;
};
const shot = async (name) => {
  await page.waitForTimeout(250);
  await page.screenshot({ path: `${OUT}/${name}.png` });
  console.log(`${OUT}/${name}.png`);
};
const ws = '[data-testid="workspace"]:not([hidden])';
const rows = (zone) => page.$$eval(`[data-menu="zone-${zone}"] [data-item]`, (els) => els.map((e) => e.getAttribute("data-item")));
const openZone = async (zone) => {
  await page.click(`${ws} [data-testid="zone-menu"][data-zone="${zone}"]`);
  await page.waitForSelector(`[data-menu="zone-${zone}"]`);
};
const calls = (name) => page.evaluate((n) => window.__ROWKERY_CALLS__.filter(([c]) => c === n), name);

// Connect.
await page.keyboard.press("Control+Shift+O");
await page.waitForSelector('[data-testid="conn-popover"]');
await page.click('[data-conn-id="pg"]');
await page.waitForSelector(`${ws}[data-conn-state="connected"]`);

// 1. The panel's `…`: the connection's commands, with keys.
await openZone("panel");
const panel = await rows("panel");
check(
  panel.includes("refresh-schema") && panel.includes("edit-connection") && panel.includes("switch-database") && panel.includes("agents"),
  `panel menu: ${panel.join(", ")}`,
);
check(!!(await page.$('[data-menu="zone-panel"] [data-item="switch-database"] kbd')), "rows print their keys");
await shot("1-panel-menu");
await page.click('[data-menu="zone-panel"] [data-item="switch-database"]');
await page.waitForSelector('[data-testid="db-popover"], [data-testid="conn-popover"]');
check(true, "a pick runs the command (Switch database opened its picker)");
await page.keyboard.press("Escape");

// 2. A query tab: no results yet, so the results `…` and Data | Structure are absent; the editor's `…` offers Run all.
check(!(await page.$(`${ws} [data-testid="zone-menu"][data-zone="results"]`)), "no results: no results menu");
await openZone("editor");
const editor = await rows("editor");
check(editor.includes("run-all") && !editor.includes("cancel"), `editor menu before a run: ${editor.join(", ")}`);
await page.keyboard.press("Escape");
await page.click(`${ws} [data-testid="sql-editor"]`).catch(() => {});
await page.keyboard.type("select * from wallet_tx");
await page.keyboard.press("Control+Enter");
await page.waitForSelector(`${ws} [data-row]`);

// 3. With rows: the results head's `…` lists find, copy, export, clear, timings; a pick opens Timings.
await openZone("results");
const results = await rows("results");
check(
  ["find-results", "copy-csv", "export", "clear-results", "timings"].every((id) => results.includes(id)),
  `results menu on a query tab: ${results.join(", ")}`,
);
await shot("2-results-menu");
await page.click('[data-menu="zone-results"] [data-item="timings"]');
await page.waitForSelector("[data-timings]");
check(true, "Timings opened from the results menu");
await page.keyboard.press("Escape");
await page.waitForSelector("[data-timings]", { state: "detached" });
check(!!(await page.$(`${ws} [data-testid="card-toolbar"] [data-testid="view-switch"]`)), "a query reading one table keeps Data | Structure in its results head");

// 4. Run all from the editor's `…` runs the statements.
const runsBefore = (await calls("run_query")).length;
// The editor has focus (its key strip shows): the `…` must not move as the strip goes.
await page.click(`${ws} [data-testid="sql-editor"]`).catch(() => {});
await page.waitForSelector(`${ws} [data-key-strip="editor"]`).catch(() => {});
await openZone("editor");
await page.click('[data-menu="zone-editor"] [data-item="run-all"]');
await page.waitForFunction((n) => window.__ROWKERY_CALLS__.filter(([c]) => c === "run_query").length > n, runsBefore);
check(true, "Run all statements ran from the editor menu");

// 5. A table tab: Data | Structure at the tab row's right (Paper, 2026-10-10:
// back from the SQL line); the WHERE row's end carries the results `…`.
await page.click(`${ws} [data-table="wallet.public.wallet_tx"] [data-testid="sb-row-main"]`);
await page.waitForSelector(`${ws} [data-testid="editor-header"] [data-testid="view-switch"]`);
await page.waitForFunction((sel) => document.querySelector(`${sel} [data-sql-text]`)?.getAttribute("data-sql-text"), ws);
check(!(await page.$(`${ws} [data-sql-line] [data-testid="view-switch"]`)), "nothing in the SQL line");
const box = await page.evaluate((sel) => {
  const sw = document.querySelector(`${sel} [data-testid="editor-header"] [data-testid="view-switch"]`).getBoundingClientRect();
  const tabs = document.querySelector(`${sel} [data-testid="query-tabs"]`).getBoundingClientRect();
  return { right: sw.left >= tabs.right - 1, inRow: sw.top >= tabs.top - 1 && sw.bottom <= tabs.bottom + 1 };
}, ws);
check(box.right && box.inRow, `the switch sits in the tab row, right of the tabs (${JSON.stringify(box)})`);
check(!!(await page.$(`${ws} [data-sql-line] [data-testid="zone-menu"][data-zone="results"]`)), "the SQL line's end carries the results menu");
await shot("3-table-tab");
await page.click(`${ws} [data-testid="editor-header"] [data-testid="view-switch"] [data-view="structure"]`);
await page.waitForSelector(`${ws} [data-testid="ts-root"]`).catch(() => {});
check((await page.getAttribute(`${ws} [data-testid="editor-header"] [data-testid="view-switch"] [data-view="structure"]`, "aria-selected")) === "true", "Structure selected from the tab row");
await shot("4-structure");

await browser.close();
if (failed) {
  console.error(`${failed} check(s) failed`);
  process.exit(1);
}
