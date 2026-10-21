#!/usr/bin/env node
// Import CSV (stubbed `invoke`; the open dialog, the file's preview and the
// import itself are core's, so `choose_csv`, `preview_csv` and `import_csv`
// stand in for them): ⌘K "Import CSV…" from a query tab picks the table the
// file fits best, brings its tab forward and opens the panel in the
// inspector beside its grid, with columns matched by name and the file's
// first rows tinted at the top of the grid; a field is remapped from
// its picker; Import sends exactly the mapping and choices, shows progress
// with Cancel and roll back, and a toast says what went in. A failure keeps
// the panel open with the line and column; Cancel and roll back cancels; the
// schema panel's table menu offers Import CSV… (not on views); a .csv dropped
// on a table row opens the panel for that table, and anywhere else for the
// best fit; the Table picker moves the import to another table, and the
// Connection picker to a window on another connection.
//
//   cd apps/rowkery-tauri && npx vite --port 1420 &
//   node scripts/csv-import-browser-proof.mjs [outDir]
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
const OUT = process.argv[2] ?? "/tmp/rowkery-proof/csv-import";
const URL = process.env.ROWKERY_DEV_URL ?? "http://localhost:1420/";
mkdirSync(OUT, { recursive: true });

function stubTauri() {
  localStorage.clear();
  const col = (name, type_name, extra = {}) => ({ name, type_name, nullable: true, ...extra });
  const table = (name, columns, rows, kind = "table") => ({
    name,
    kind,
    columns,
    primary_key: kind === "table" ? ["id"] : [],
    indexes: [],
    foreign_keys: [],
    row_estimate: { Approximate: rows },
    partition_of: null,
  });
  const orders = [
    col("id", "integer", { nullable: false }),
    col("customer_id", "integer"),
    col("email", "text"),
    col("status", "text", { default: "'pending'::text" }),
    col("total", "numeric(10,2)"),
    col("note", "text"),
    col("created_at", "timestamp with time zone", { default: "now()" }),
  ];
  const tables = [
    table("customers", [col("id", "integer", { nullable: false }), col("name", "text"), col("email", "text")], 900),
    table("orders", orders, 48200),
    table("recent_orders", orders, 0, "view"),
  ];
  const wire = (cols) => cols.map((c) => ({ name: c.name, type_name: c.type_name }));
  const statuses = ["pending", "paid", "shipped", "refunded"];
  const rowOf = (t, n) =>
    t === "customers"
      ? [{ Int: n }, { Text: `Customer ${n}` }, { Text: `c${n}@mail.com` }]
      : [
          { Int: 48210 - n },
          { Int: 300 + n * 37 },
          { Text: `user${n + 2}@mail.com` },
          { Text: statuses[n % 4] },
          { Text: (19.5 + n * 7.25).toFixed(2) },
          n % 3 ? { Null: null } : { Text: "Gift wrap" },
          { Text: `2026-10-${String(20 - Math.floor(n / 4)).padStart(2, "0")} 14:${String(10 + n * 3).padStart(2, "0")}` },
        ];
  const header = ["order_id", "customer", "email", "status", "amount", "gift_note", "placed", "utm_source"];
  const fileRows = Array.from({ length: 20 }, (_, i) => [
    String(60000 + i),
    String(120 + i),
    `new${i}@mail.com`,
    statuses[(i + 1) % 4],
    (9.5 + i).toFixed(2),
    i % 2 ? "" : "Thanks!",
    `2026-10-21 0${i % 10}:00`,
    "newsletter",
  ]);
  window.__CALLS__ = [];
  window.__DIALOG__ = "/home/me/orders-october.csv";
  // What the next import does: "ok", "fail" or "slow" (runs until cancelled).
  window.__IMPORT__ = "ok";
  let cancel = null;
  let nextId = 0;
  window.__TAURI_INTERNALS__ = {
    metadata: { currentWindow: { label: "main" }, currentWebview: { label: "main" } },
    transformCallback: () => 0,
    invoke: async (cmd, args) => {
      const { onFrame, onProgress, ...rest } = args ?? {};
      window.__CALLS__.push([cmd, rest]);
      switch (cmd) {
        case "list_connections":
          return {
            connections: [
              { kind: "postgres", id: "pg", name: "shop", host: "db", port: 5432, database: "shop", username: "rowkery" },
              { kind: "postgres", id: "wh", name: "warehouse", host: "wh", port: 5432, database: "shop", username: "rowkery" },
            ],
            active_connection_id: null,
          };
        case "open_window":
          return { database: "shop", catalog: { databases: [{ name: "shop", schemas: [{ name: "public", tables }] }] }, elapsed_ms: 2, cached: false, open_seq: 1 };
        case "browse_table": {
          const t = rest.table;
          const cols = t === "customers" ? tables[0].columns : orders;
          const n = 14;
          const queryId = ++nextId;
          setTimeout(() => {
            const send = (f) => onFrame.onmessage({ query_id: queryId, ...f });
            send({ t: "columns", columns: wire(cols) });
            send({ t: "rows", seq: 0, rows: Array.from({ length: n }, (_, i) => rowOf(t, i)) });
            send({ t: "done", status: "ok", row_count: n, affected_rows: null, elapsed_ms: 1, first_row_ms: 1, frames: 1, error: null, sqlstate: null, error_position: null, hold: null });
          }, 5);
          return { query_id: queryId, sql: `SELECT * FROM public.${t}\nORDER BY id\nLIMIT ${rest.limit};` };
        }
        case "choose_csv":
          return window.__DIALOG__;
        case "preview_csv":
          return { file_name: rest.path.split("/").pop(), delimiter: ",", rows: [header, ...fileRows], records: 12432 };
        case "import_csv": {
          const mode = window.__IMPORT__;
          if (mode === "fail") return { status: "failed", message: "Line 4,812, total: 'n/a' isn't a number" };
          return new Promise((resolve) => {
            let rows = 0;
            const tick = () => {
              rows += mode === "slow" ? 2600 : 4200;
              onProgress.onmessage({ rows: Math.min(rows, 12431) });
              if (rows >= 12431 && mode !== "slow") {
                cancel = null;
                resolve({ status: "imported", inserted: 12000, updated: 0, skipped: 431, elapsed_ms: 840 });
              } else if (mode !== "slow" || rows < 7800) timer = setTimeout(tick, mode === "slow" ? 150 : 60);
            };
            let timer = setTimeout(tick, 60);
            cancel = () => {
              clearTimeout(timer);
              cancel = null;
              resolve({ status: "cancelled" });
            };
          });
        }
        case "cancel_import":
          cancel?.();
          return null;
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
const page = await browser.newPage({ viewport: { width: 1180, height: 700 }, deviceScaleFactor: 2 });
page.on("pageerror", (e) => {
  console.error("pageerror:", e.message);
  process.exitCode = 1;
});
await page.addInitScript({ path: LINUX_PLATFORM });
await page.addInitScript(stubTauri);
await page.goto(URL);
const ws = '[data-testid="workspace"]:not([hidden])';
await page.waitForSelector(ws);
await page.keyboard.press("Control+Shift+O");
await page.waitForSelector('[data-testid="conn-popover"]');
await page.keyboard.press("Enter");
await page.waitForSelector(`${ws}[data-conn-state="connected"]`);

const shot = (name) => page.screenshot({ path: `${OUT}/${name}.png` });
const panel = `${ws} [data-inspector="import"]`;
const calls = (cmd) => page.evaluate((cmd) => window.__CALLS__.filter(([c]) => c === cmd).map(([, a]) => a), cmd);
const toast = async () => {
  await page.waitForSelector("[data-toast]");
  const parts = await page.$$eval("[data-toast] > span", (els) => els.map((e) => e.textContent.trim()));
  return parts.join(" ").replace(/\s+/g, " ").trim();
};
const mapping = () =>
  page.$$eval(`${panel} [data-import-field]`, (els) => els.map((e) => `${e.querySelector("[data-import-pick]").textContent.trim()}${e.hasAttribute("data-skipped") ? "(skipped)" : ""}`));
const openTable = async (name) => {
  await page.click(`${ws} [data-table="shop.public.${name}"] [data-testid="sb-row-main"]`);
  await page.waitForFunction((ws) => document.querySelector(`${ws} [data-testid="results-grid-wrap"]`)?.getAttribute("data-row-count") === "14", ws);
};

const chip = (name) => page.textContent(`${panel} [data-import-picker="${name}"]`).then((t) => t.trim());
const rowCount = () => page.getAttribute(`${ws} [data-testid="results-grid-wrap"]`, "data-row-count");
const activeTabTitle = () => page.textContent(`${ws} [data-testid="query-tab"][aria-selected="true"] [data-testid="query-tab-title"]`).then((t) => t.trim());
// The import tab shows the file's rows and nothing of a table's or a query's.
const importTabClean = async (table) => {
  const edges = await page.evaluate((ws) => {
    const grid = document.querySelector(`${ws} [data-testid="results-grid-wrap"]`).getBoundingClientRect();
    const panel = document.querySelector(`${ws} [data-inspector="import"]`).getBoundingClientRect();
    return { grid: Math.round(grid.right), panel: Math.round(panel.left) };
  }, ws);
  check(edges.grid <= edges.panel, `the grid ends where the panel starts, nothing under it (${edges.grid} ≤ ${edges.panel})`);
  check((await activeTabTitle()) === `Import · ${table}`, `the import tab is shown (${await activeTabTitle()})`);
  const leaks = await page.evaluate((ws) => {
    const w = document.querySelector(ws);
    return ["[data-empty-rows]", '[data-testid="sql-editor"]', "[data-sql-line]", "[data-add-filter]", '[data-testid="run-btn"]'].filter((sel) => w.querySelector(sel));
  }, ws);
  check(leaks.length === 0, `no query line, filter, editor or "No records" (${leaks.join(", ")})`);
};

// ⌘K Import CSV… from the query tab: the file first, then the table it fits.
await page.keyboard.press("Control+k");
await page.waitForSelector('[data-testid="cp-row"]');
await page.keyboard.type("import csv");
await page.waitForSelector('[data-testid="cp-row"][data-item="cmd:import-csv"]');
await page.click('[data-testid="cp-row"][data-item="cmd:import-csv"]');
await page.waitForSelector(panel);
check((await page.textContent(`${panel} [data-import-file]`)).trim() === "orders-october.csv · 12,431 rows · 8 columns", "the panel names the file, its rows and columns");
check((await chip("connection")) === "shop", "Connection is the window's");
check((await chip("table")) === "orders", `Table is the best fit for the file (${await chip("table")})`);
await importTabClean("orders");
check(
  JSON.stringify(await mapping()) ===
    JSON.stringify(["id", "customer_id", "email", "status", "skip(skipped)", "note", "skip(skipped)", "skip(skipped)"]),
  `columns match by name and near name (${(await mapping()).join(", ")})`,
);
check((await page.getAttribute(`${panel} [data-import-matched]`, "data-import-matched")) === "5", "5 of 8 matched");
const previewCount = await page.locator(`${ws} [data-import-row]`).count();
check(previewCount === 20, `the file's first rows show in the grid (${previewCount})`);
const firstPreview = await page.$$eval(`${ws} [data-import-row="0"] [data-col]`, (els) => els.map((e) => e.textContent.trim()));
check(firstPreview[0] === "60000" && firstPreview[2] === "new0@mail.com" && firstPreview[4] === "default" && firstPreview[6] === "default", `preview cells read as the table gets them (${firstPreview.join(" | ")})`);
const focusAt = await page.evaluate(() => (document.activeElement?.hasAttribute("data-import-body") ? "panel" : document.activeElement?.outerHTML.slice(0, 60)));
check((await page.locator(`${panel} [data-import-option="header"] [data-choice="header"][aria-checked="true"]`).count()) === 1, "First row: Header is offered and picked");
check(focusAt === "panel", `focus lands in the panel, not on Import (${focusAt})`);

// Remap amount → total and placed → created_at from their pickers.
const pickField = async (field, column) => {
  await page.click(`${panel} [data-import-pick="${field}"]`);
  await page.waitForSelector('[data-menu="import-column"]');
  await page.click(`[data-menu="import-column"] [data-item="${column}"]`);
};
await pickField(4, "total");
await pickField(6, "created_at");
check((await page.getAttribute(`${panel} [data-import-matched]`, "data-import-matched")) === "7", "7 of 8 matched after picking two");
const secondPreview = await page.$$eval(`${ws} [data-import-row="1"] [data-col]`, (els) => els.map((e) => e.textContent.trim()));
check(secondPreview[4] === "10.50" && secondPreview[5] === "NULL", `the preview follows the mapping, an empty note is NULL (${secondPreview.join(" | ")})`);
await page.click(`${panel} [data-import-option="conflict"] [data-choice="skip"]`);
await page.mouse.move(600, 650);
await shot("1-panel");

// Import: progress, then the toast; the spec is exactly what the panel shows.
await page.evaluate(() => (window.__IMPORT__ = "ok"));
await page.click(`${panel} [data-import-run]`);
await page.waitForSelector(`${panel} [data-import-progress]`);
await page.waitForFunction((p) => Number(document.querySelector(`${p} [data-import-progress]`)?.dataset.importProgress) > 0, panel);
await page.waitForSelector(panel, { state: "detached" });
check((await toast()) === "Imported 12,000 rows · skipped 431 orders · 840 ms", `toast says what went in (${await toast()})`);
const spec = (await calls("import_csv"))[0]?.spec;
check(
  spec?.path === "/home/me/orders-october.csv" &&
    spec.table === "orders" &&
    spec.schema === "public" &&
    spec.header === true &&
    spec.on_conflict === "skip" &&
    spec.empty === "null" &&
    JSON.stringify(spec.columns.map((c) => `${c.field}:${c.column}`)) === JSON.stringify(["0:id", "1:customer_id", "2:email", "3:status", "4:total", "5:note", "6:created_at"]),
  `import_csv gets the mapping and choices (${JSON.stringify(spec)})`,
);
check((await page.locator(`${ws} [data-import-row]`).count()) === 0, "the preview rows leave with the panel");
await page.waitForTimeout(400);
const tabsAfter = await page.$$eval(`${ws} [data-testid="query-tab"]:not([aria-hidden]) [data-testid="query-tab-title"]`, (els) => els.map((e) => e.textContent.trim()));
check((await activeTabTitle()) === "orders" && !tabsAfter.some((t) => t.startsWith("Import")), `after Import the import tab gives way to the table's own tab (${tabsAfter.join(", ")} · ${await activeTabTitle()})`);
await page.waitForFunction(() => !document.querySelector("[data-toast]"), null, { timeout: 6000 });

// The schema panel's table menu: Import CSV… on a table, not on a view.
await page.click(`${ws} [data-table="shop.public.recent_orders"] [data-testid="sb-row-main"]`, { button: "right" });
await page.waitForSelector('[data-menu="panel-row"]');
check((await page.locator('[data-menu="panel-row"] [data-item="import-csv"]').count()) === 0, "a view's menu has no Import CSV…");
await page.keyboard.press("Escape");
await page.click(`${ws} [data-table="shop.public.orders"] [data-testid="sb-row-main"]`, { button: "right" });
await page.click('[data-menu="panel-row"] [data-item="import-csv"]');
await page.waitForSelector(panel);

// A failure keeps the panel, naming the line and column.
await page.evaluate(() => (window.__IMPORT__ = "fail"));
await page.click(`${panel} [data-import-run]`);
await page.waitForSelector(`${panel} [data-import-error]`);
check((await page.textContent(`${panel} [data-import-error]`)).trim() === "Line 4,812, total: 'n/a' isn't a number", "a bad value is named by line and column");
await shot("3-failed");

// Cancel and roll back.
await page.evaluate(() => (window.__IMPORT__ = "slow"));
await page.click(`${panel} [data-import-run]`);
await page.waitForSelector(`${panel} [data-import-cancel-run]`);
await page.waitForFunction((p) => Number(document.querySelector(`${p} [data-import-progress]`)?.dataset.importProgress) >= 5000, panel);
await page.mouse.move(600, 650);
const clockText = (await page.textContent(`${panel} .ci-clock`)).trim();
check(/^\d+:\d\d$/.test(clockText), `the clock counts up (${clockText})`);
await shot("2-importing");
await page.click(`${panel} [data-import-cancel-run]`);
check((await toast()) === "Import cancelled Nothing was written", `cancel rolls back (${await toast()})`);
check((await calls("cancel_import")).length === 1, "cancel_import was asked once");
check(!!(await page.$(`${panel} [data-import-run]`)), "the panel stays for another go");
// Esc closes it.
await page.click(`${panel} [data-import-file]`);
await page.keyboard.press("Escape");
await page.waitForSelector(panel, { state: "detached" });
check(true, "Esc closes the panel");

// A .csv dropped on a table row opens the panel for that table.
await openTable("orders");
const box = await page.locator(`${ws} [data-table="shop.public.customers"]`).boundingBox();
await page.evaluate(
  ([x, y]) =>
    window.dispatchEvent(new CustomEvent("rowkery:file-drag", { detail: { type: "drop", paths: ["/home/me/people.csv"], x, y } })),
  [box.x + box.width / 2, box.y + box.height / 2],
);
await page.waitForSelector(panel);
check((await chip("table")) === "customers", "a drop on customers imports into customers");
check((await calls("preview_csv")).at(-1)?.path === "/home/me/people.csv", "the dropped file is the one read");
await importTabClean("customers");

// The Table picker: best fit first with its match count; filter and ↵ moves the import.
await page.click(`${panel} [data-import-picker="table"]`);
await page.waitForSelector('[data-import-popover="table"]');
const choices = await page.$$eval('[data-import-popover="table"] [data-import-choice]', (els) => els.map((e) => e.textContent.replace(/\s+/g, " ").trim()));
check(JSON.stringify(choices) === JSON.stringify(["orders5 of 8 columns", "✓customers1 of 8 columns"]), `tables ranked by fit, no views (${choices.join(" | ")})`);
await page.waitForTimeout(300);
await shot("5-table-picker");
await page.keyboard.type("ord");
await page.keyboard.press("Enter");
await page.waitForSelector('[data-import-popover="table"]', { state: "detached" });
check((await chip("table")) === "orders", "↵ picks the filtered table");
check((await page.getAttribute(`${panel} [data-import-matched]`, "data-import-matched")) === "5", "the columns match the new table");
check((await page.locator(`${ws} [data-import-row]`).count()) === 20 && (await activeTabTitle()) === "Import · orders", "the preview follows the table, in the same tab");
await page.click(`${panel} [data-import-file]`);
await page.keyboard.press("Escape");
await page.waitForSelector(panel, { state: "detached" });

// Dropped anywhere else (here the editor of a query tab): the best fit.
await page.keyboard.press("Control+k");
await page.keyboard.type("new query tab");
await page.click('[data-testid="cp-row"][data-item="cmd:new-tab"]');
const editor = await page.locator(`${ws} [data-testid="sql-editor"]`).boundingBox();
await page.evaluate(
  ([x, y]) =>
    window.dispatchEvent(new CustomEvent("rowkery:file-drag", { detail: { type: "drop", paths: ["/home/me/orders-october.csv"], x, y } })),
  [editor.x + 40, editor.y + 20],
);
await page.waitForSelector(panel);
check((await chip("table")) === "orders", "a drop on the editor imports into the best fit");

// The Connection picker: the import moves to a window on warehouse.
await page.click(`${panel} [data-import-picker="connection"]`);
await page.waitForSelector('[data-import-popover="connection"]');
await page.click('[data-import-popover="connection"] [data-import-choice="wh"]');
await page.waitForFunction(() => document.querySelectorAll('[data-testid="workspace"]').length === 2);
await page.waitForSelector(panel);
check((await chip("connection")) === "warehouse", "the panel opens again on warehouse");
check((await chip("table")) === "orders", "with the table the file fits there");
check((await calls("preview_csv")).at(-1)?.path === "/home/me/orders-october.csv", "the same file is read");

// Dark.
await page.emulateMedia({ colorScheme: "dark" });
await page.waitForTimeout(400);
await shot("4-panel-dark");
await browser.close();
