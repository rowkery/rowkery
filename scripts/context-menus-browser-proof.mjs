#!/usr/bin/env node
// Context menus (stubbed `invoke`): right-click a schema panel row, a tab, a
// window pill, a grid header, a cell and a filter chip. Each opens the one HTML
// menu (GridMenu) with keys right-aligned; every key is the registry's
// (commands.ts, printed in `data-keys`), and pointer gestures read as dim
// hints. The cell menu offers ⌘↵ follow on a foreign key cell of a table
// tab, and ↵ edit with the staging rows where the table can be edited.
// Picks act: Structure, Insert name (and ⌥↵ on a focused row), Pin, Keep
// open, Close other tabs, Reopen, Filter by this column, Quick Look, Remove
// filter, Copy as SQL, Remove all filters, Close window; the ? menu's keys too.
//
//   cd apps/rowkery-tauri && npx vite --port 1420 &
//   node scripts/context-menus-browser-proof.mjs [outDir]
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
const OUT = process.argv[2] ?? "/tmp/rowkery-proof/context-menus";
const URL = process.env.ROWKERY_DEV_URL ?? "http://localhost:1420/";
const FRAMES_SHIM = new globalThis.URL("./lib/frames-shim.js", import.meta.url).pathname;
mkdirSync(OUT, { recursive: true });

function stubTauri() {
  localStorage.clear();
  window.__CALLS__ = [];
  const col = (name, type_name, nullable = false) => ({ name, type_name, nullable });
  const TX = [col("id", "int8"), col("amount", "numeric"), col("status", "text"), col("kiosk_id", "int4", true)];
  const KIOSKS = [col("id", "int4"), col("name", "text")];
  const table = (name, columns, fks = []) => ({
    name,
    kind: "table",
    columns,
    primary_key: ["id"],
    indexes: [],
    foreign_keys: fks,
    row_estimate: { Approximate: 40 },
    partition_of: null,
  });
  const fk = { name: "tx_kiosk", columns: ["kiosk_id"], ref_schema: "public", ref_table: "kiosks", ref_columns: ["id"], on_delete: "NO ACTION" };
  const tables = [table("kiosks", KIOSKS), table("wallet_tx", TX, [fk])];
  const browseSql = (a) => {
    let sql = `SELECT * FROM ${a.schema}.${a.table}`;
    if (a.filter?.trim()) sql += `\nWHERE (${a.filter.trim()})`;
    sql += `\nORDER BY id`;
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
          return {
            connections: [
              { kind: "postgres", id: "pg", name: "wallet-prd", host: "db", port: 5432, database: "wallet", username: "app" },
              { kind: "postgres", id: "pg2", name: "analytics", host: "db2", port: 5432, database: "analytics", username: "app" },
            ],
            active_connection_id: null,
          };
        case "open_window":
          return { database: "wallet", catalog: { databases: [{ name: "wallet", schemas: [{ name: "public", tables }] }] }, elapsed_ms: 2, cached: false, open_seq: 1 };
        case "browse_table_sql":
          return browseSql(args);
        case "run_query": {
          const kiosks = /kiosks/.test(args.sql);
          const n = /WHERE/.test(args.sql) ? 3 : 12;
          return {
            columns: (kiosks ? KIOSKS : TX).map((c) => ({ name: c.name, type_name: c.type_name })),
            rows: Array.from({ length: n }, (_, i) =>
              kiosks ? [{ Int: i + 1 }, { Text: `Kiosk ${i + 1}` }] : [{ Int: 100 + i }, { Text: "52.00" }, { Text: i % 2 ? "settled" : "pending" }, { Int: 1 + (i % 3) }],
            ),
            row_count: n,
            elapsed_ms: 3,
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

const check = (cond, msg) => {
  if (!cond) {
    console.error(`FAIL: ${msg}`);
    process.exitCode = 1;
  } else console.log(`ok: ${msg}`);
};
const browser = await playwright.chromium.launch({ executablePath: process.env.CHROMIUM_PATH ?? "/opt/pw-browsers/chromium" });
const context = await browser.newContext({ viewport: { width: 1280, height: 800 }, deviceScaleFactor: 2 });
await context.grantPermissions(["clipboard-read", "clipboard-write"]);
const page = await context.newPage();
page.on("pageerror", (e) => console.error("pageerror:", e.message));
await page.addInitScript({ path: FRAMES_SHIM });
await page.addInitScript(stubTauri);
await page.goto(URL);
const ws = '[data-testid="workspace"]:not([hidden])';
const line = `${ws} [data-sql-line]`;
const menu = (name) => `[data-menu="${name}"]`;
/** A menu's rows as `id=label:keys` (keys from `data-keys`, a hint after `~`). */
const rows = (name) =>
  page.$$eval(`${menu(name)} [data-item]`, (els) =>
    els.map((e) => {
      const hint = e.querySelector('[data-testid="grid-menu-hint"]')?.textContent;
      return `${e.dataset.item}=${e.querySelector('[data-testid="grid-menu-label"]').textContent}:${e.dataset.keys ?? ""}${hint ? `~${hint}` : ""}`;
    }),
  );
const closed = (name) => page.waitForFunction((sel) => !document.querySelector(sel), menu(name));
const clipboard = () => page.evaluate(() => navigator.clipboard.readText());
const row = (key) => `${ws} [data-table="${key}"] [data-testid="sb-row-main"]`;
/** A tab by its title (page-side checks use `tabState`). */
const tabRow = (name) => `${ws} [data-testid="query-tab"][role="tab"][data-title="${name}"]`;
const tabState = () =>
  page.$$eval(`${ws} [data-testid="query-tab"][role="tab"]`, (els) =>
    els.map((e) => `${e.dataset.title}${e.hasAttribute("data-on") ? "*" : ""}${e.hasAttribute("data-preview") ? "~" : ""}`).join(","),
  );
const cell = (r, c) => `${ws} [data-row="${r}"] [data-col="${c}"]`;

await page.waitForSelector('[data-testid="workspace"]:not([hidden])'); // Paper (2026-10-10): an empty window shows no connection chip (no tab row without a connection); wait for the window, then ⇧⌘O as before.
await page.keyboard.press("Control+Shift+O");
await page.waitForSelector('[data-testid="conn-popover"]');
await page.keyboard.press("Enter");
await page.waitForSelector(`${ws}[data-conn-state="connected"]`);

// 1. Schema panel row.
await page.click(row("wallet.public.wallet_tx"), { button: "right" });
await page.waitForSelector(menu("panel-row"));
const panelRows = await rows("panel-row");
check(
  panelRows.join("|") ===
    "open=Open:~click|open-tab=Open in a new tab:~Ctrl-click|structure=Structure:|import-csv=Import CSV…:|insert=Insert name:Alt+↵|copy-name=Copy name:|pin=Pin to top:",
  `panel row menu: ${panelRows.join(" · ")}`,
);
check((await page.$$(`${menu("panel-row")} [data-testid="grid-menu-sep"]`)).length === 2, "panel row menu: two groups ruled off");
await page.screenshot({ path: `${OUT}/1-panel-row.png` });
await page.click(`${menu("panel-row")} [data-item="insert"]`);
await closed("panel-row");
await page.waitForTimeout(100);
const inserted = await page.inputValue(`${ws} textarea[data-testid="sql-editor"]`);
check(inserted.startsWith("wallet_tx") && !inserted.startsWith("wallet_txkiosks"), `Insert name puts wallet_tx at the editor's caret: ${JSON.stringify(inserted)}`);
await page.focus(row("wallet.public.kiosks"));
await page.keyboard.press("Alt+Enter");
await page.waitForTimeout(100);
const inserted2 = await page.inputValue(`${ws} textarea[data-testid="sql-editor"]`);
check(inserted2.startsWith("wallet_txkiosks"), `⌥↵ on a focused row inserts its name too: ${JSON.stringify(inserted2)}`);
await page.click(row("wallet.public.wallet_tx"), { button: "right" });
await page.click(`${menu("panel-row")} [data-item="pin"]`);
await page.waitForSelector(`${ws} [data-table="wallet.public.wallet_tx"] [data-testid="sb-pin"][aria-pressed="true"]`);
check(true, "Pin to top pins the row");
await page.click(row("wallet.public.wallet_tx"), { button: "right" });
check((await page.textContent(`${menu("panel-row")} [data-item="pin"]`)).trim() === "Unpin", "a pinned row's menu offers Unpin");
await page.click(`${menu("panel-row")} [data-item="structure"]`);
await page.waitForSelector(`${ws} [data-testid="ts-root"], ${ws} [data-structure], ${ws} [data-testid="ts-card"]`);
check((await page.$eval(`${ws} [data-testid="query-tab"][aria-selected="true"] [data-testid="query-tab-title"]`, (e) => e.textContent)) === "wallet_tx", "Structure opens wallet_tx on its Structure view");

// 2. Tabs: the preview tab's menu.
await page.click(`${ws} [data-testid="view-switch"] button:first-child, ${ws} [data-view="data"]`).catch(() => {});
await page.keyboard.press("Control+Alt+1");
await page.waitForSelector(`${ws} [data-row]`);
await page.click(tabRow("wallet_tx"), { button: "right" });
await page.waitForSelector(menu("tab"));
const tabRows = await rows("tab");
check(
  tabRows.join("|") ===
    "keep=Keep open:~double-click|edit-sql=Edit SQL:Ctrl+E|refresh-rows=Refresh rows:Ctrl+Shift+R|new-tab=New query tab:|close=Close tab:Ctrl+W|close-others=Close other tabs:",
  `preview table tab menu: ${tabRows.join(" · ")}`,
);
await page.screenshot({ path: `${OUT}/2-tab.png` });
await page.click(`${menu("tab")} [data-item="keep"]`);
await page.waitForFunction((sel) => !document.querySelector(sel), `${ws} [data-testid="query-tab"][data-preview]`);
check(!(await tabState()).includes("~"), `Keep open turns the preview tab into a normal one: ${await tabState()}`);
await page.click(tabRow("Query 1"), { button: "right" });
check((await tabState()).includes("Query 1*"), `right-click selects the tab first: ${await tabState()}`);
const queryRows = await rows("tab");
check(!queryRows.some((r) => r.startsWith("edit-sql") || r.startsWith("keep")), `a query tab offers no Edit SQL or Keep: ${queryRows.join(" · ")}`);
await page.click(`${menu("tab")} [data-item="close-others"]`);
await page.waitForFunction((sel) => document.querySelectorAll(sel).length === 1, `${ws} [data-testid="query-tab"][role="tab"]`);
check(true, "Close other tabs leaves only Query 1");
await page.click(tabRow("Query 1"), { button: "right" });
const reopenRow = (await rows("tab")).find((r) => r.startsWith("reopen="));
check(reopenRow === "reopen=Reopen closed tab:Ctrl+Shift+T", `Reopen closed tab with its key: ${reopenRow}`);
await page.click(`${menu("tab")} [data-item="reopen"]`);
await page.waitForSelector(tabRow("wallet_tx"));
await page.waitForFunction((sel) => document.querySelector(sel)?.getAttribute("data-sql-text")?.includes("LIMIT"), `${line} [data-sql-text]`);
check(true, "Reopen brings wallet_tx back with its SQL line");

// 3. Grid header and cell on the table tab (PK id, FK kiosk_id).
await page.waitForSelector(`${ws} [data-row]`);
await page.click(`${ws} [data-header="amount"]`, { button: "right" });
await page.waitForSelector(menu("header"));
const headerRows = await rows("header");
check(
  headerRows.join("|") ===
    "asc=Sort ascending:~click|desc=Sort descending:|filter=Filter by this column:Ctrl+F|hide=Hide column:|copy-name=Copy column name:|structure=Structure:Ctrl+Alt+2|mark=Mark as sensitive:",
  `header menu: ${headerRows.join(" · ")}`,
);
await page.screenshot({ path: `${OUT}/3-header.png` });
await page.click(`${menu("header")} [data-item="filter"]`);
await page.waitForSelector(`${line} [data-chip-editor]`);
check((await page.getAttribute(`${line} [data-chip-editor]`, "data-column")) === "amount", "Filter by this column opens the chip editor on amount");
await page.keyboard.press("Escape");

await page.click(cell(1, 3), { button: "right" });
await page.waitForSelector(menu("grid"));
const cellRows = await rows("grid");
check(
  cellRows.join("|") ===
    "quick-look=Quick Look:Space|edit-cell=Edit cell:↵|set-null=Set NULL:Ctrl+Alt+N|insert-row=Insert row:Ctrl+I|duplicate-row=Duplicate row:Ctrl+D|follow-key=Follow kiosk_id:Ctrl+↵|f-only=Only rows where kiosk_id = 2:|f-hide=Hide rows where kiosk_id = 2:|f-null=Rows where kiosk_id IS NULL:|csv=Copy:Ctrl+C|csv-header=Copy as CSV with headers:Ctrl+Shift+C",
  `cell menu on an FK cell: ${cellRows.join(" · ")}`,
);
check(cellRows.some((r) => /^edit-cell=/.test(r)), "↵ edit: the table has a primary key");
await page.screenshot({ path: `${OUT}/4-cell.png` });
await page.click(`${menu("grid")} [data-item="quick-look"]`);
await page.waitForSelector(`${ws} [data-quicklook]`);
check(true, "Quick Look opens from the cell menu");
await page.keyboard.press("Escape");

// 4. Filter chips.
await page.click(cell(0, 2), { button: "right" });
await page.click(`${menu("grid")} [data-item="f-only"]`);
await page.waitForSelector(`${line} [data-chip="0"]`);
await page.click(cell(0, 3), { button: "right" });
await page.click(`${menu("grid")} [data-item="f-hide"]`);
await page.waitForSelector(`${line} [data-chip="1"]`);
await page.click(`${line} [data-chip="0"]`, { button: "right" });
await page.waitForSelector(menu("chip"));
const chipRows = await rows("chip");
check(
  chipRows.join("|") ===
    "edit=Edit filter:~click|remove=Remove filter:Backspace|copy-sql=Copy as SQL:|add=Add a filter:Ctrl+F|clear=Remove all filters:",
  `chip menu: ${chipRows.join(" · ")}`,
);
await page.screenshot({ path: `${OUT}/5-chip.png` });
await page.click(`${menu("chip")} [data-item="copy-sql"]`);
await page.waitForTimeout(150);
check((await clipboard()) === "status = 'pending'", `Copy as SQL: ${await clipboard()}`);
await page.click(`${line} [data-chip="1"]`, { button: "right" });
await page.click(`${menu("chip")} [data-item="remove"]`);
await page.waitForFunction((sel) => document.querySelectorAll(sel).length === 1, `${line} [data-chip]`);
check(true, "Remove filter drops that chip");
await page.click(cell(0, 3), { button: "right" });
await page.click(`${menu("grid")} [data-item="f-hide"]`);
await page.waitForSelector(`${line} [data-chip="1"]`);
await page.click(`${line} [data-chip="1"]`, { button: "right" });
await page.click(`${menu("chip")} [data-item="clear"]`);
await page.waitForFunction((sel) => document.querySelectorAll(sel).length === 0, `${line} [data-chip]`);
check(true, "Remove all filters clears the chips");

// 5. Rail tiles and the ? menu.
await page.keyboard.press("Control+t");
await page.waitForFunction(() => document.querySelectorAll('[data-testid="win-tab"]').length === 2);
await page.click('[data-testid="win-tab"]:not([data-empty])', { button: "right" });
await page.waitForSelector(menu("win-tab"));
check((await page.$('[data-testid="win-tab"][data-on]:not([data-empty])')) !== null, "right-click selects the tile");
const tileRows = await rows("win-tab");
check(
  tileRows.join("|") ===
    "switch-database=Switch database…:Ctrl+Shift+D|switch-connection=Switch connection…:Ctrl+Shift+O|edit-connection=Edit connection…:|reconnect=Reconnect:|new-window=New window:Ctrl+T|close-window=Close window:Ctrl+Shift+W",
  `rail tile menu: ${tileRows.join(" · ")}`,
);
await page.screenshot({ path: `${OUT}/6-win-tab.png` });
await page.keyboard.press("Escape");
await closed("win-tab");
await page.click('[data-testid="win-tab"][data-empty]', { button: "right" });
await page.waitForSelector(menu("win-tab"));
const emptyRows = await rows("win-tab");
check(emptyRows.join("|") === "new-window=New window:Ctrl+T|close-window=Close window:Ctrl+Shift+W", `an empty window's tile: ${emptyRows.join(" · ")}`);
await page.click(`${menu("win-tab")} [data-item="close-window"]`);
await page.waitForFunction(() => document.querySelectorAll('[data-testid="win-tab"]').length === 1);
check(true, "Close window closes the empty window");
// There is no ? menu: Help is a foot row that opens the shortcuts; the
// other rows are in ⌘K and the menu bar.
await page.keyboard.press("Control+k");
await page.waitForSelector('[data-testid="cp-row"]');
await page.keyboard.type(">copy");
await page.waitForTimeout(150);
const cmdRows = await page.$$eval('[data-testid="cp-row"][data-item^="cmd:"]', (els) => els.map((e) => e.dataset.item));
check(!cmdRows.includes("cmd:copy-cells") && !cmdRows.includes("cmd:quick-look"), `⌘K lists no zone keys: ${cmdRows.join(", ")}`);
await browser.close();
