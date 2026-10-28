#!/usr/bin/env node
// The schema column with 2,000 tables (stubbed `invoke`): a section longer
// than 200 rows keeps only the rows near the view in the page
// (rowkery/reports#27), yet every table can still be reached by scrolling or
// the filter, opened, and lines up under a section above it that folds,
// unfolds or gains a pin, and is one row per table again once partitions a
// filter opened fold away. A short section renders every row, as before.
//
//   cd apps/rowkery-tauri && npx vite --port 1420 &
//   node scripts/sidebar-windowed-browser-proof.mjs [outDir]
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
const OUT = process.argv[2] ?? "/tmp/rowkery-proof/sidebar-windowed";
const URL = process.env.ROWKERY_DEV_URL ?? "http://localhost:1420/";
const FRAMES_SHIM = new globalThis.URL("./lib/frames-shim.js", import.meta.url).pathname;
mkdirSync(OUT, { recursive: true });

function stubTauri() {
  localStorage.clear();
  const table = (name, rows) => ({
    name,
    columns: [{ name: "id", type_name: "int8", nullable: false }],
    primary_key: ["id"],
    indexes: [],
    foreign_keys: [],
    row_estimate: { Approximate: rows },
    partition_of: null,
  });
  const schemas = [
    { name: "audit", tables: ["events", "logins", "trail"].map((n) => table(n, 10)) },
    { name: "public", tables: [] },
  ];
  // Tables 100-139 are partitioned, four partitions each.
  for (let i = 0; i < 2000; i++) {
    const name = `table_${String(i).padStart(4, "0")}`;
    schemas[1].tables.push(table(name, i));
    if (i >= 100 && i < 140) {
      for (let k = 0; k < 4; k++) schemas[1].tables.push({ ...table(`${name}_p${k}`, 1), partition_of: name });
    }
  }
  const catalog = { databases: [{ name: "rowkery", schemas }] };
  const connections = [{ kind: "postgres", id: "pg", name: "big", host: "127.0.0.1", port: 5432, database: "rowkery", username: "rowkery" }];
  localStorage.setItem("rowkery.windows", JSON.stringify({ windows: [{ connectionId: "pg", database: "rowkery" }], active: 0 }));
  window.__TAURI_INTERNALS__ = {
    metadata: { currentWindow: { label: "main" }, currentWebview: { label: "main" } },
    transformCallback: () => 0,
    invoke: async (cmd, args) => {
      switch (cmd) {
        case "list_connections":
          return { connections, active_connection_id: null };
        case "open_window":
          return { database: "rowkery", catalog, elapsed_ms: 3, server_version: "PostgreSQL 16.4" };
        case "browse_table_sql":
          return `SELECT * FROM ${args.schema}.${args.table} LIMIT 100;`;
        case "run_query":
          return { columns: [{ name: "id", type_name: "int8" }], rows: [[{ Int: 1 }]], row_count: 1, elapsed_ms: 1, error: null, cancelled: false };
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
const visible = '[data-testid="workspace"]:not([hidden])';

const browser = await playwright.chromium.launch();
const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
page.on("pageerror", (e) => console.error("pageerror:", e.message));
await page.addInitScript({ path: FRAMES_SHIM });
await page.addInitScript(stubTauri);
await page.goto(URL);
await page.waitForSelector(`${visible}[data-conn-state="connected"]`);
await page.waitForTimeout(300);

const scroll = page.locator(`${visible} [data-testid="sb-scroll"]`);
const rowsInPage = () => page.locator(`${visible} .sidebar [data-table^="rowkery.public."]`).count();
const auditRows = () => page.locator(`${visible} .sidebar [data-table^="rowkery.audit."]`).count();
/** Whether `key`'s row is in the page and inside the scroll area's view. */
const inView = (key) =>
  page.evaluate(([sel, key]) => {
    const row = document.querySelector(`${sel} .sidebar [data-table="${key}"]`);
    const box = document.querySelector(`${sel} [data-testid="sb-scroll"]`).getBoundingClientRect();
    if (!row) return false;
    const r = row.getBoundingClientRect();
    return r.top >= box.top - 1 && r.bottom <= box.bottom + 1;
  }, [visible, key]);
const toBottom = async () => {
  await scroll.evaluate((e) => (e.scrollTop = e.scrollHeight));
  await page.waitForTimeout(250);
};

const n = await rowsInPage();
check(n > 0 && n < 120, `2,000 tables, ${n} rows in the page`);
check((await auditRows()) === 3, "the short section renders all its rows");
check(await inView("rowkery.public.table_0000"), "the first table shows at the top");

await toBottom();
check(await inView("rowkery.public.table_1999"), "scrolled to the end, the last table shows");
await page.screenshot({ path: `${OUT}/1-bottom.png` });
console.log(`${OUT}/1-bottom.png`);
await page.click(`${visible} .sidebar [data-table="rowkery.public.table_1990"] [data-testid="sb-row-main"]`);
await page.waitForTimeout(300);
check(
  (await page.getAttribute(`${visible} .sidebar [data-table="rowkery.public.table_1990"]`, "data-selected")) === "",
  "a table deep in the list opens and shows selected",
);

// A section above folds and unfolds: the end still lines up.
await scroll.evaluate((e) => (e.scrollTop = 0));
await page.waitForTimeout(150);
await page.click(`${visible} [data-section-key="rowkery.audit"] .sb-section-header`);
await page.waitForTimeout(150);
check((await auditRows()) === 0, "the audit section folded");
await toBottom();
check(await inView("rowkery.public.table_1999"), "with a section above folded, the last table shows");
await scroll.evaluate((e) => (e.scrollTop = 0));
await page.waitForTimeout(150);
await page.click(`${visible} [data-section-key="rowkery.audit"] .sb-section-header`);
await page.waitForTimeout(150);

// A pin adds a section above it.
await page.hover(`${visible} .sidebar [data-table="rowkery.public.table_0002"]`);
await page.click(`${visible} .sidebar [data-table="rowkery.public.table_0002"] [data-testid="sb-pin"]`);
await page.waitForTimeout(200);
await toBottom();
check(await inView("rowkery.public.table_1999"), "with a Pinned section above, the last table shows");

// The filter reaches any table.
await scroll.evaluate((e) => (e.scrollTop = 0));
await page.fill(`${visible} [data-testid="sb-filter"] input`, "table_1777");
await page.waitForTimeout(250);
check(await inView("rowkery.public.table_1777"), "the filter finds a table far down");
check((await rowsInPage()) <= 2, "and shows only the matches");
await page.fill(`${visible} [data-testid="sb-filter"] input`, "");
await page.waitForTimeout(250);
const back = await rowsInPage();
check(back > 0 && back < 120, `cleared, the list is windowed again (${back} rows)`);
await page.screenshot({ path: `${OUT}/2-top.png` });
console.log(`${OUT}/2-top.png`);

// A filter opens every parent's partitions; scrolled past them and
// cleared, the list is back to one row each, not the heights they had.
const listHeight = () =>
  page.evaluate((sel) => document.querySelector(`${sel} ul[data-windowed]`).getBoundingClientRect().height, visible);
await page.fill(`${visible} [data-testid="sb-filter"] input`, "_0");
await page.waitForTimeout(250);
for (let at = 0; at < 14000; at += 250) {
  await scroll.evaluate((e, at) => (e.scrollTop = at), at);
  await page.waitForTimeout(40);
}
await page.fill(`${visible} [data-testid="sb-filter"] input`, "");
await page.waitForTimeout(300);
const height = Math.round(await listHeight());
check(height === 2000 * 30, `cleared after partitions showed, the list is 2,000 rows tall (${height}px)`);

await browser.close();
