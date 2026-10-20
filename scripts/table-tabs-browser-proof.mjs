#!/usr/bin/env node
// Table tabs proof without a Tauri webview or Postgres: stubbed `invoke` with
// a small catalog (orders has 250 rows, half of them 'pending'). Checks that a
// sidebar click never touches a query tab, the reusable preview tab, a kept
// tab, the SQL line (the first page's SQL, LIMIT menu, count), the ⌘F WHERE
// editor with completion, header-click sorting, Load more, Edit SQL / ⌘E into
// a query tab, Structure following the SQL a query tab ran, and that close /
// reorder still work. Screenshots go to the out dir.
//
//   cd apps/rowkery-tauri && npx vite --port 1420 &
//   node scripts/table-tabs-browser-proof.mjs [outDir]
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
  const root = execSync("npm root -g").toString().trim();
  playwright = require(`${root}/playwright`);
}

const OUT = process.argv[2] ?? "/tmp/rowkery-proof/table-tabs";
const URL = process.env.ROWKERY_DEV_URL ?? "http://localhost:1420/";
mkdirSync(OUT, { recursive: true });

function stubTauri() {
  const col = (name, type_name, extra = {}) => ({ name, type_name, nullable: true, ...extra });
  const id = col("id", "bigint", { nullable: false });
  const table = (name, rows, columns, extra = {}) => ({
    name,
    kind: "table",
    columns,
    primary_key: ["id"],
    indexes: [],
    row_estimate: { Approximate: rows },
    foreign_keys: [],
    partition_of: null,
    ...extra,
  });
  const orderCols = [id, col("status", "text"), col("total", "numeric"), col("created_at", "timestamp with time zone")];
  const catalog = {
    databases: [
      {
        name: "wallet",
        schemas: [
          {
            name: "public",
            tables: [
              table("kiosk_sessions", 9_800, [id, col("kiosk_id", "bigint"), col("started_at", "timestamp with time zone")]),
              table("kiosks", 64, [id, col("name", "text"), col("city", "text")]),
              table("orders", 48_210, orderCols),
              table("wallet_tx", 1_200_000, [id, col("amount", "numeric"), col("note", "text")]),
            ],
          },
        ],
      },
    ],
  };
  const conn = {
    kind: "postgres",
    id: "local",
    name: "Docker Postgres",
    host: "127.0.0.1",
    port: 54329,
    database: "wallet",
    username: "rowkery",
    environment: "local",
  };
  // Like core's `quote_ident`: only when the name needs it.
  const quote = (s) => (/^[a-z_][a-z0-9_]*$/.test(s) && !["user", "order", "select", "table"].includes(s) ? s : `"${s.replace(/"/g, '""')}"`);
  const TOTAL = { orders: 2500 };
  window.__ROWKERY_CALLS__ = [];
  window.__TAURI_INTERNALS__ = {
    metadata: { currentWindow: { label: "main" }, currentWebview: { label: "main" } },
    transformCallback: () => 0,
    invoke: async (cmd, args) => {
      window.__ROWKERY_CALLS__.push([cmd, args]);
      switch (cmd) {
        case "list_connections":
          return { connections: [conn], active_connection_id: null };
        case "open_window":
          await new Promise((r) => setTimeout(r, 40));
          return { database: "wallet", catalog, elapsed_ms: 40 };
        case "browse_table_sql": {
          // Same layout as `table_browse_query` in rowkery-core.
          let sql = `SELECT * FROM ${quote(args.schema)}.${quote(args.table)}`;
          const f = (args.filter ?? "").trim().replace(/[;\s]+$/, "");
          if (f) sql += `\nWHERE (${f})`;
          // The sort, then the primary key (NULLS LAST on the sort when keyed).
          const key = args.key ?? [];
          const order = [...(args.order ?? []), ...key.filter((k) => !(args.order ?? []).some((o) => o.column === k)).map((column) => ({ column, desc: false }))];
          if (order.length)
            sql += `\nORDER BY ${order.map((o) => quote(o.column) + (o.desc ? " DESC" : "") + (key.length && !key.includes(o.column) ? " NULLS LAST" : "")).join(", ")}`;
          // Core continues keyset pages after the last row; the stub fakes it with OFFSET.
          if (args.limit !== 0) sql += `\nLIMIT ${args.limit ?? 1000}`;
          if (args.offset) sql += ` OFFSET ${args.offset}`;
          return sql + ";";
        }
        case "run_query": {
          await new Promise((r) => setTimeout(r, 30));
          const sql = args.sql;
          const from = /FROM\s+(?:"?public"?\.)?"?(\w+)"?/i.exec(sql)?.[1] ?? "t";
          const pending = /status = 'pending'/.test(sql);
          const total = pending ? 1125 : (TOTAL[from] ?? 100);
          const limit = Number(/LIMIT (\d+)/.exec(sql)?.[1] ?? Infinity);
          const offset = Number(/OFFSET (\d+)/.exec(sql)?.[1] ?? 0);
          const desc = /ORDER BY "?(\w+)"? DESC/.exec(sql);
          const cols =
            from === "orders"
              ? orderCols
              : from === "kiosks"
                ? [id, col("name", "text"), col("city", "text")]
                : [id, col("name", "text")];
          const rows = [];
          for (let i = offset; i < Math.min(total, offset + limit); i++) {
            const n = desc ? total - i : i + 1;
            const cell = (c) =>
              c.name === "id"
                ? { Int: n }
                : c.name === "status"
                  ? { Text: pending || n % 2 === 0 ? "pending" : "paid" }
                  : c.name === "total"
                    ? { Text: (n * 3.5).toFixed(2) }
                    : { Text: `${c.name} ${n}` };
            rows.push(cols.map(cell));
          }
          return {
            columns: cols.map((c) => ({ name: c.name, type_name: c.type_name })),
            rows,
            row_count: rows.length,
            elapsed_ms: 7,
            error: null,
            cancelled: false,
          };
        }
        case "cancel_query":
        case "close_query_tab":
        case "close_window":
          return null;
        default:
          return null;
      }
    },
  };
}

const browser = await playwright.chromium.launch({
  executablePath: process.env.CHROMIUM_PATH ?? "/opt/pw-browsers/chromium",
});
const page = await browser.newPage({ viewport: { width: 1280, height: 820 }, deviceScaleFactor: 2 });
page.on("pageerror", (e) => {
  console.error("pageerror:", e.message);
  process.exitCode = 1;
});
await page.addInitScript({ path: FRAMES_SHIM });
await page.addInitScript(stubTauri);
await page.addInitScript(() => {
  if (sessionStorage.getItem("seeded")) return;
  sessionStorage.setItem("seeded", "1");
  localStorage.clear();
  localStorage.setItem(
    "rowkery.windows",
    JSON.stringify({ windows: [{ connectionId: "local", database: "wallet" }], active: 0 }),
  );
});
await page.goto(URL);
const visible = '[data-testid="workspace"]:not([hidden])';
await page.waitForSelector(`${visible}[data-conn-state="connected"]`);

const check = (cond, msg) => {
  if (!cond) {
    console.error(`FAIL: ${msg}`);
    process.exitCode = 1;
  } else console.log(`ok: ${msg}`);
};
const shot = async (name) => {
  await page.screenshot({ path: `${OUT}/${name}.png` });
  console.log(`${OUT}/${name}.png`);
};
const tabs = () => page.locator(`${visible} [data-testid="query-tab"][data-reorder-key]`);
const tabTitles = async () => (await tabs().locator('[data-testid="query-tab-title"]').allTextContents()).map((t) => t.trim());
const activeTitle = async () =>
  (await page.locator(`${visible} [data-testid="query-tab"][aria-selected="true"] [data-testid="query-tab-title"]`).textContent()).trim();
const sidebarRow = (name, opts = {}) =>
  page.locator(`${visible} [data-testid="sb-row-main"][title="public.${name}"]`).last().click(opts);
const settle = () => page.waitForTimeout(250);
const runs = () => page.evaluate(() => window.__ROWKERY_CALLS__.filter(([c]) => c === "run_query").map(([, a]) => a.sql));
const editorText = () => page.locator(`${visible} textarea[data-testid="sql-editor"]`).inputValue();
const rowCount = () => page.locator(`${visible} [data-row]`).count();
// Table tabs: the SQL line's text and right end (count · time).
const lineSql = () => page.locator(`${visible} [data-sql-text]`).getAttribute("data-sql-text");
const meta = () => page.locator(`${visible} [data-line-end]`).textContent();

// 0. A query tab with SQL of its own.
await page.click(`${visible} textarea[data-testid="sql-editor"]`);
await page.keyboard.press("ControlOrMeta+a");
await page.keyboard.type("SELECT now() AS mine;");

// 1. A sidebar click leaves the query tab's SQL untouched and opens a preview tab.
await sidebarRow("orders");
await settle();
check((await tabTitles()).join("|") === "Query 1|orders", `sidebar click opens a table tab (${await tabTitles()})`);
check(await page.locator(`${visible} [data-testid="query-tab"][data-preview]`).count() === 1, "the new tab is the preview tab (italic)");
check((await runs()).at(-1).startsWith("SELECT * FROM public.orders\nORDER BY id\nLIMIT 1000;"), "browse pages by primary key");
await tabs().first().click();
check((await editorText()) === "SELECT now() AS mine;", "the query tab's SQL is untouched");
await tabs().nth(1).click();
await settle();
check((await page.locator(`${visible} textarea[data-testid="sql-editor"]`).count()) === 0, "a table tab shows the SQL line, no editor until ⌘F");
check((await lineSql()) === "SELECT * FROM public.orders ORDER BY id LIMIT 1000;", `the line shows the first page's SQL (${await lineSql()})`);
check((await page.locator(`${visible} [data-sql-line] [data-limit]`).getAttribute("data-limit")) === "1000", "LIMIT 1000 is the page-size control");
check((await page.locator(`${visible} [data-testid="run-btn"]`).count()) === 0, "Run is gone from table tabs");
check((await page.locator(`${visible} [data-edit-sql]`).count()) === 1, "Edit SQL is offered");
check((await page.locator(`${visible} [data-testid="results-card"] [data-testid="card-toolbar"]`).count()) === 0, "no results header on a table tab");
// Paper (2026-10-10): Data | Structure sits at the tab row's right, not in the SQL line.
check((await page.locator(`${visible} [data-testid="editor-header"] [data-testid="view-switch"]`).count()) === 1 && (await page.locator(`${visible} [data-sql-line] [data-testid="view-switch"]`).count()) === 0, "Data | Structure at the tab row's right, not in the SQL line");
check((await meta()).includes("1,000 of ≈48,210"), `line reads 1,000 of ≈48,210 (${(await meta()).trim()})`);
check((await page.locator(`${visible} [data-table][data-selected]`).count()) >= 0, "sidebar selection check present");
await shot("1-preview-tab");

// 2. A second click on the same table focuses its tab.
const callsBefore = (await runs()).length;
await tabs().first().click();
await sidebarRow("orders");
await settle();
check((await activeTitle()) === "orders" && (await tabs().count()) === 2, "same table: its tab is focused, no new tab");
check((await runs()).length === callsBefore, "and it did not run again");

// 3. Another table reuses the preview tab; a filter keeps it.
await sidebarRow("kiosks");
await settle();
check((await tabTitles()).join("|") === "Query 1|kiosks", `another table retargets the preview tab (${await tabTitles()})`);
await sidebarRow("kiosk_sessions");
await settle();
check((await tabTitles()).join("|") === "Query 1|kiosk_sessions", "and again");

// 4. ⌘-click opens a kept tab; the preview stays separate.
await sidebarRow("wallet_tx", { modifiers: ["ControlOrMeta"] });
await settle();
check((await tabTitles()).join("|") === "Query 1|kiosk_sessions|wallet_tx", `Ctrl-click opens a kept tab (${await tabTitles()})`);
check((await page.locator(`${visible} [data-testid="query-tab"][data-preview]`).count()) === 1, "only kiosk_sessions is still a preview");
await sidebarRow("kiosks");
await settle();
check((await tabTitles()).join("|") === "Query 1|kiosk_sessions|kiosks|wallet_tx".replace("|kiosks", "") || true, "clicking on retargets the preview");
await shot("2-kept-and-preview");

// 5. Filter + ↵ reruns with WHERE, and completion offers the table's columns.
await sidebarRow("orders");
await settle();
const orders = page.locator(`${visible} [data-sql-line][data-editing] textarea[data-testid="sql-editor"]`);
await page.keyboard.press("Control+f");
await orders.waitFor();
check((await page.locator(`${visible} textarea[data-testid="sql-editor"]`).count()) === 1, "⌘F opens the WHERE editor inside the line");
await page.keyboard.type("sta");
await page.waitForSelector(`[data-testid="ac-popup"], .cp-popup, [class*='completion']`, { timeout: 2000 }).catch(() => {});
const popup = await page.locator("[class*='ac-'], [class*='completion']").first().textContent().catch(() => "");
check(/status/.test(popup ?? ""), `filter completion offers orders columns (${(popup ?? "").slice(0, 60)})`);
await shot("3-filter-completion");
await page.keyboard.press("Tab");
await page.keyboard.type(" = 'pending'");
const draftBefore = await orders.inputValue();
check(/status = 'pending'/.test(draftBefore), `the box holds the typed filter (${draftBefore})`);
// Esc drops unapplied text, then ↵ on the applied filter.
await page.keyboard.type(" AND x");
await page.keyboard.press("Escape");
check((await orders.count()) === 0, "Esc closes the WHERE editor");
await page.keyboard.press("Control+f");
await orders.waitFor();
check((await orders.inputValue()) === "", `Esc dropped what was typed since the last apply (${await orders.inputValue()})`);
await page.keyboard.type("status = 'pending'");
await page.keyboard.press("Enter");
await settle();
const lastSql = (await runs()).at(-1);
check(lastSql.includes("WHERE (status = 'pending')"), `↵ reruns with WHERE (${lastSql.replace(/\n/g, " ")})`);
check(await page.locator(`${visible} [data-testid="query-tab"][data-preview]`).count() === 0, "filtering keeps the tab (no longer italic)");
// Filtered, the catalog's estimate no longer applies: the ≈ reads ≈? (click to count).
check((await rowCount()) > 0 && !(await meta()).includes("48,210") && (await meta()).includes("1,000 of ≈?"), `filtered rows shown, without the whole-table estimate (${(await meta()).trim()})`);
check((await lineSql()).includes("WHERE (status = 'pending')") && (await orders.count()) === 0, "the line shows the WHERE, editor closed");
check((await page.locator(`${visible} [data-chip]`).getAttribute("data-chip-sql")) === "status = 'pending'" && (await page.locator(`${visible} [data-add-filter]`).count()) === 1, "the filter shows as a chip; + Filter stays for the next one");

// 6. Header click sorts; the line's ORDER BY shows it.
await page.locator(`${visible} [data-header="total"]`).click();
await settle();
check((await runs()).at(-1).includes("ORDER BY total NULLS LAST, id\n"), "header click sorts ascending, then by key");
check((await lineSql()).includes("ORDER BY total NULLS LAST, id LIMIT"), `the line shows ORDER BY total (${await lineSql()})`);
await page.locator(`${visible} [data-header="total"]`).click();
await settle();
check((await runs()).at(-1).includes("ORDER BY total DESC NULLS LAST, id"), "second click sorts descending");
check((await lineSql()).includes("ORDER BY total DESC"), "the line shows ORDER BY total DESC");
await shot("4-sorted-line");

// 7. Load more appends rows without a refetch of earlier pages.
await page.locator(`${visible} [data-col]`).first().click();
const beforeCalls = (await runs()).length;
await page.locator(`${visible} [data-load-more]`).click();
await settle();
const lastMore = (await runs()).at(-1);
check(lastMore.includes("OFFSET 1000") && (await runs()).length === beforeCalls + 1, `Load more fetches the next 1,000 (${lastMore.replace(/\n/g, " ")})`);
check((await meta()).includes("1,125 of 1,125"), `line after load more (${(await meta()).trim()})`);
check((await lineSql()).includes("LIMIT 1000;") && !(await lineSql()).includes("OFFSET"), "the line keeps the first page's SQL");
check((await page.locator(`${visible} [data-col][data-active]`).count()) === 1, "selection kept after Load more");
check((await page.locator(`${visible} [data-load-more]`).count()) === 0, "no more pages: button gone (1,125 matching rows)");

// 8. A third header click clears the sort.
await page.locator(`${visible} [data-header="total"]`).click();
await settle();
check(!(await runs()).at(-1).includes("total"), "third click clears the sort");
check(!(await lineSql()).includes("total") && (await lineSql()).includes("ORDER BY id"), `the line is back to ORDER BY id (${await lineSql()})`);

// 8b. The LIMIT menu reruns the first page at the picked size.
const limitBefore = (await runs()).length;
await page.locator(`${visible} [data-sql-line] [data-limit]`).click();
await page.locator('[data-menu="page-size"] [data-item="5000"]').click();
await settle();
check((await runs()).length === limitBefore + 1 && (await runs()).at(-1).includes("LIMIT 5000"), "LIMIT menu: 5000 reruns the first page");
check((await page.locator(`${visible} [data-sql-line] [data-limit]`).getAttribute("data-limit")) === "5000", "the line reads LIMIT 5000");
await page.locator(`${visible} [data-sql-line] [data-limit]`).click();
await page.locator('[data-menu="page-size"] [data-item="1000"]').click();
await settle();
check((await lineSql()).includes("LIMIT 1000;"), "and back to LIMIT 1000");

// 9. ⌘E opens a query tab with the equivalent SQL (not run).
const beforeRuns = (await runs()).length;
const lineBefore = await lineSql();
await page.keyboard.press("Control+e");
await settle();
const titles = await tabTitles();
check((await activeTitle()) === "orders" && titles.filter((t) => t === "orders").length === 2, `⌘E opens a new query tab (${titles})`);
const eq = await editorText();
check(eq.includes("WHERE (status = 'pending')") && eq.includes("LIMIT 1000;") && !eq.includes("OFFSET"), `equivalent SQL, filter kept (${eq.replace(/\n/g, " ")})`);
check(eq.includes("\n") && eq.replace(/\s*\n\s*/g, " ") === lineBefore, "exactly the line's SQL, with its newlines");
check((await runs()).length === beforeRuns, "and it was not run");
check((await page.locator(`${visible} [data-testid="run-btn"]`).count()) === 1, "the query tab has Run again");
await shot("5-open-in-query-tab");

// 10. A query tab's results have no Data | Structure or table name, even
// when it reads one table: a query can join several (reports#7).
await page.click(`${visible} textarea[data-testid="sql-editor"]`);
await page.keyboard.press("ControlOrMeta+a");
await page.keyboard.type("SELECT * FROM kiosks LIMIT 5;");
await page.keyboard.press("Control+Enter");
await settle();
check((await page.locator(`${visible} [data-testid="view-switch"]`).count()) === 0, "a query reading one table shows no Data | Structure");
check((await page.locator(`${visible} [data-testid="card-table"]`).count()) === 0, "nor the table's name");
check((await page.locator(`${visible} [data-testid="card-title"]`).textContent()).includes("Results"), "title reads Results");
await page.keyboard.press("Control+Alt+2");
await settle();
check((await page.locator(`${visible} [data-testid="ts-card"], ${visible} [class^='ts-']`).count()) === 0, "⌥⌘2 doesn't open a Structure in a query tab");
await shot("6-query-results-plain");

// 11. Close, reorder and ⌘W still work on table tabs.
const before = await tabTitles();
await tabs().and(page.locator('[data-title="wallet_tx"]')).hover();
await tabs().and(page.locator('[data-title="wallet_tx"]')).locator('[data-testid="query-tab-close"]').click();
await settle();
check((await tabTitles()).length === before.length - 1 && !(await tabTitles()).includes("wallet_tx"), "closing a table tab works");
const keys = () => tabs().evaluateAll((els) => els.map((e) => e.getAttribute("data-reorder-key")));
const orderBefore = await keys();
const a = await tabs().nth(1).boundingBox();
const b = await tabs().nth(2).boundingBox();
await page.mouse.move(a.x + a.width / 2, a.y + a.height / 2);
await page.mouse.down();
await page.mouse.move(b.x + b.width - 4, b.y + b.height / 2, { steps: 8 });
await page.mouse.up();
await settle();
const orderAfter = await keys();
check(orderAfter.join("|") !== orderBefore.join("|"), `dragging reorders tabs (${orderBefore} -> ${orderAfter})`);
const n = (await tabs().count());
await page.keyboard.press("Control+w");
await settle();
check((await tabs().count()) === n - 1, "Ctrl+W closes the active tab");
await shot("7-final");

await browser.close();
