#!/usr/bin/env node
// Results grid selection proof without a Tauri webview (stubbed `invoke`):
// drag selects a block of cells (and scrolls past the sheet's edge), ⇧-click
// and ⇧-arrows extend it, the row number selects whole rows, ⌘A selects the
// whole table and never the page's text, ⌘C copies the block as TSV and ⇧⌘C
// adds the column names; column rules show where each value ends. Right-click
// opens the cell menu (Quick Look, Copy ⌘C, Copy with headers ⇧⌘C, keys
// from commands.ts): inside the block it keeps the block, elsewhere it selects
// that cell first.
//
//   cd apps/rowkery-tauri && npx vite --port 1420 &
//   node scripts/grid-select-browser-proof.mjs [outDir]
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

const OUT = process.argv[2] ?? "/tmp/rowkery-proof/grid-select";
const URL = process.env.ROWKERY_DEV_URL ?? "http://localhost:1420/";
mkdirSync(OUT, { recursive: true });

function stubTauri() {
  const TABLES = {
    wallet: ["api_keys", "ledger_entries", "wallets"],
    orders: ["order_items", "orders", "refunds", "shipments"],
    payments: ["charges", "payouts"],
    analytics: ["daily_active", "events"],
  };
  const catalogFor = (db) => ({
    databases: [
      {
        name: db,
        schemas: [
          {
            name: "public",
            tables: (TABLES[db] ?? ["t"]).map((name, i) => ({
              name,
              columns: [{ name: "id", type_name: "int8", nullable: false }],
              primary_key: ["id"],
              indexes: [],
              row_estimate: { Approximate: 4100 * (i + 1) },
              partition_of: null,
            })),
          },
        ],
      },
    ],
  });
  const pg = (id, name, host, environment) => ({
    kind: "postgres",
    id,
    name,
    host,
    port: 5432,
    database: "wallet",
    username: "app",
    environment,
  });
  const connections = [
    pg("prd", "wallet", "wallet-prd.db.internal", "prd"),
    pg("stg", "wallet", "wallet-stg.db.internal", "stg"),
    { ...pg("local", "Docker Postgres", "127.0.0.1", "local"), port: 54329, database: "rowkery" },
    { kind: "sqlite", id: "cache", name: "analytics-cache", path: "~/cache.db" },
  ];
  const windows = {};
  window.__ROWKERY_CALLS__ = [];
  window.__TAURI_INTERNALS__ = {
    metadata: { currentWindow: { label: "main" }, currentWebview: { label: "main" } },
    transformCallback: () => 0,
    invoke: async (cmd, args) => {
      window.__ROWKERY_CALLS__.push([cmd, args]);
      switch (cmd) {
        case "list_connections":
          return { connections: structuredClone(connections), active_connection_id: null };
        case "open_window": {
          const c = connections.find((x) => x.id === args.connectionId);
          const database = c.kind === "sqlite" ? "main" : (args.database ?? c.database);
          windows[args.windowId] = { conn: c, database };
          await new Promise((r) => setTimeout(r, 60));
          return { database, catalog: catalogFor(database), elapsed_ms: 60 };
        }
        case "close_window":
          delete windows[args.windowId];
          return null;
        case "list_databases":
          return [
            { name: "analytics", size_bytes: 12_884_901_888 },
            { name: "orders", size_bytes: 4_509_715_660 },
            { name: "payments", size_bytes: 1_181_116_006 },
            { name: "postgres", size_bytes: 8_388_608 },
            { name: "wallet", size_bytes: 901_775_360 },
          ];
        case "run_query": {
          // "pg_sleep(n)" waits n seconds (cancellable), "boom" fails.
          const secs = Number(/pg_sleep\((\d+(?:\.\d+)?)\)/.exec(args.sql)?.[1] ?? 0);
          const started = performance.now();
          const cancelled = await new Promise((resolve) => {
            const t = setTimeout(() => resolve(false), secs * 1000);
            (window.__ROWKERY_PENDING__ ??= {})[`${args.windowId}:${args.tabId}`] = () => {
              clearTimeout(t);
              resolve(true);
            };
          });
          const elapsed_ms = Math.round(performance.now() - started);
          if (cancelled) return { columns: [], rows: [], row_count: 0, elapsed_ms, error: null, cancelled: true };
          if (args.sql.includes("boom"))
            return { columns: [], rows: [], row_count: 0, elapsed_ms, error: 'relation "boom" does not exist', cancelled: false };
          return {
            columns: [{ name: "tab", type_name: "int8" }, { name: "sql", type_name: "text" }],
            rows: [[{ Int: args.tabId }, { Text: args.sql }]],
            row_count: 1,
            elapsed_ms,
            error: null,
            cancelled: false,
          };
        }
        case "cancel_query":
          window.__ROWKERY_PENDING__?.[`${args.windowId}:${args.tabId}`]?.();
          return null;
        case "browse_table_sql":
          return `SELECT * FROM ${args.schema}.${args.table} LIMIT 100;`;
        default:
          return null;
      }
    },
  };
}

const browser = await playwright.chromium.launch({
  executablePath: process.env.CHROMIUM_PATH ?? "/opt/pw-browsers/chromium",
});
const check = (cond, msg) => {
  if (!cond) {
    console.error(`FAIL: ${msg}`);
    process.exitCode = 1;
  } else console.log(`ok: ${msg}`);
};
const context = await browser.newContext({ viewport: { width: 1100, height: 720 }, deviceScaleFactor: 2 });
await context.grantPermissions(["clipboard-read", "clipboard-write"], { origin: new globalThis.URL(URL).origin });
const page = await context.newPage();
page.on("pageerror", (e) => console.error("pageerror:", e.message));
await page.addInitScript({ path: FRAMES_SHIM });
await page.addInitScript(stubTauri);
await page.addInitScript(() => {
  const inv = window.__TAURI_INTERNALS__.invoke;
  const names = ["Ada Lovelace", "Grace Hopper", "Alan Turing", "Edsger Dijkstra", "Barbara Liskov", "Ken Thompson", "Margaret Hamilton", "Donald Knuth", "Frances Allen", "John McCarthy", "Radia Perlman", "Leslie Lamport", "Tony Hoare", "Niklaus Wirth"];
  // Reassigned whole (not `.invoke =`) so the frames shim wraps this invoke too.
  window.__TAURI_INTERNALS__ = { ...window.__TAURI_INTERNALS__, __framesShim: false, invoke: async (cmd, args) => {
    if (cmd === "save_connection" || cmd === "delete_connection") return null;
    if (cmd !== "run_query") return inv(cmd, args);
    return {
      columns: [
        { name: "id", type_name: "int8" },
        { name: "owner", type_name: "text" },
        { name: "email", type_name: "text" },
        { name: "balance", type_name: "numeric" },
        { name: "active", type_name: "bool" },
        { name: "note", type_name: "text" },
      ],
      rows: Array.from({ length: 120 }, (_, i) => {
        const n = names[i % names.length];
        return [
          { Int: 1001 + i },
          { Text: i === 1 ? "Hopper, Grace" : n },
          { Text: n.split(" ")[0].toLowerCase() + "@kioskuno.com" },
          { Text: (i * 173.25 + 12.5).toFixed(2) },
          { Bool: i % 4 !== 2 },
          i % 5 === 3 ? { Null: null } : { Text: `Settlement for invoice INV-${40000 + i} held for manual review by the risk team` },
        ];
      }),
      row_count: 120,
      elapsed_ms: 12,
      error: null,
      cancelled: false,
    };
  } };
  localStorage.clear();
  localStorage.setItem(
    "rowkery.windows",
    JSON.stringify({ windows: [{ connectionId: "prd", database: "wallet" }, { connectionId: "local", database: "rowkery" }], active: 1 }),
  );
});
await page.goto(URL);
const visible = '[data-testid="workspace"]:not([hidden])';
const MENU = '[data-menu="grid"]';
await page.waitForSelector(`${visible}[data-conn-state="connected"]`);
await page.click(visible + ' [data-testid="sql-editor"]');
await page.keyboard.type("SELECT id, owner, email, balance, active, note FROM wallets;");
await page.click(visible + ' [data-testid="run-btn"]');
await page.waitForSelector(visible + " [data-row]");
const card = await page.locator(visible + ' [data-testid="results-card"]').boundingBox();
const clip = { x: card.x - 8, y: card.y - 8, width: card.width + 16, height: card.height + 16 };
const clipboard = () => page.evaluate(() => navigator.clipboard.readText());
const toastText = () =>
  page.$$eval("[data-toast] > span", (els) => (els.length ? els.map((e) => e.textContent.trim()).join(" · ") : null));
const cell = (r, c) => page.locator(`${visible} [data-row="${r}"] [data-col="${c}"]`);
const center = async (loc) => {
  const b = await loc.boundingBox();
  return { x: b.x + b.width / 2, y: b.y + b.height / 2 };
};
const selCount = () => page.locator(visible + " [data-col][data-selected]").count();
const pageSelection = () => page.evaluate(() => String(window.getSelection()));

// 1. Column rules: every cell and header has a hairline on its right edge.
const rule = await cell(0, 1).evaluate((e) => getComputedStyle(e).boxShadow);
check(/inset/.test(rule) && /-1px/.test(rule), `cells draw a column rule (${rule})`);
const headRule = await page.locator(visible + " [data-header]").first().evaluate((e) => getComputedStyle(e).boxShadow);
check(/-1px/.test(headRule), "header cells draw the same rule");
await page.screenshot({ path: `${OUT}/1-column-rules.png`, clip });
console.log(`${OUT}/1-column-rules.png`);

// 2. Drag from owner (row 1) to balance (row 4) selects a 4 × 3 block, no text highlight.
const a = await center(cell(1, 1));
const b = await center(cell(4, 3));
await page.mouse.move(a.x, a.y);
await page.mouse.down();
await page.mouse.move((a.x + b.x) / 2, (a.y + b.y) / 2, { steps: 4 });
await page.mouse.move(b.x, b.y, { steps: 4 });
await page.mouse.up();
check((await selCount()) === 12, `drag selects 4 rows × 3 columns (${await selCount()} cells)`);
check((await pageSelection()) === "", "no text is highlighted by the drag");
check((await page.locator(visible + " [data-header][data-selected]").count()) === 3, "the three columns light up in the header");
await page.screenshot({ path: `${OUT}/2-drag-block.png`, clip });
console.log(`${OUT}/2-drag-block.png`);

// 3. ⌘C copies the block as TSV (a comma needs no quotes).
await page.keyboard.press("Control+c");
await page.waitForTimeout(150);
const csv = await clipboard();
check(
  csv === 'Hopper, Grace\tgrace@kioskuno.com\t185.75\nAlan Turing\talan@kioskuno.com\t359.00\nEdsger Dijkstra\tedsger@kioskuno.com\t532.25\nBarbara Liskov\tbarbara@kioskuno.com\t705.50',
  "⌘C copies the cells as TSV without the header",
);
check((await toastText()) === "Copied 12 cells · TSV", `toast: Copied 12 cells · TSV (${await toastText()})`);

// 4. ⇧⌘C adds the column names on top.
await page.keyboard.press("Control+Shift+c");
await page.waitForTimeout(150);
const csvH = await clipboard();
check(csvH.split("\n")[0] === "owner\temail\tbalance" && csvH.split("\n").length === 5, "⇧⌘C puts the header row on top");
check((await toastText()) === "Copied 12 cells · TSV with header", "toast: TSV with header");
await page.screenshot({ path: `${OUT}/3-copied-with-header.png`, clip });
console.log(`${OUT}/3-copied-with-header.png`);

// 5. ⇧-arrows grow the block; a plain arrow collapses it to one cell.
await page.keyboard.press("Shift+ArrowRight");
check((await selCount()) === 16, "⇧→ adds a column");
await page.keyboard.press("ArrowDown");
check((await selCount()) === 0 && (await page.locator(visible + " [data-col][data-active]").count()) === 1, "a plain arrow collapses to one cell");

// 6. A single cell still copies its raw value, unquoted.
await cell(1, 1).click();
await page.keyboard.press("Control+c");
await page.waitForTimeout(150);
check((await clipboard()) === "Hopper, Grace", "one cell copies as is");
await page.keyboard.press("Control+Shift+c");
await page.waitForTimeout(150);
check((await clipboard()) === 'owner\nHopper, Grace', "⇧⌘C on one cell adds its column name");

// 7. ⇧-click extends from the active cell.
await cell(3, 4).click({ modifiers: ["Shift"] });
check((await selCount()) === 12, `⇧-click extends the block (${await selCount()})`);

// 8. The row number selects whole rows; drag down the gutter adds rows.
const g1 = await center(page.locator(`${visible} [data-row="2"] [data-testid="rg-gutter"]`));
const g2 = await center(page.locator(`${visible} [data-row="4"] [data-testid="rg-gutter"]`));
await page.mouse.move(g1.x, g1.y);
await page.mouse.down();
await page.mouse.move(g2.x, g2.y, { steps: 4 });
await page.mouse.up();
check((await selCount()) === 18, `gutter drag selects rows 3–5 whole (${await selCount()})`);
await page.keyboard.press("Control+c");
await page.waitForTimeout(150);
check((await toastText()) === "Copied 3 rows · TSV", "whole rows are counted as rows");
await page.screenshot({ path: `${OUT}/4-whole-rows.png`, clip });
console.log(`${OUT}/4-whole-rows.png`);

// 9. ⌘A selects the whole table, not the page's text.
await page.keyboard.press("Control+a");
check((await pageSelection()) === "", "⌘A highlights no text");
check((await page.locator(visible + " [data-header][data-selected]").count()) === 6, "⌘A selects every column");
await page.keyboard.press("Control+Shift+c");
await page.waitForTimeout(150);
const all = await clipboard();
check(all.split("\n").length === 121 && all.startsWith("id\towner\temail\tbalance\tactive\tnote\n1001\t"), "⌘A then ⇧⌘C copies all 120 rows with the header");
check((await toastText()) === "Copied 120 rows · TSV with header", "toast: Copied 120 rows");
check(all.split("\n")[4].endsWith("\t"), "NULL copies as an empty field");
await page.screenshot({ path: `${OUT}/5-select-all.png`, clip });
console.log(`${OUT}/5-select-all.png`);

// 10. Dragging past the bottom edge scrolls the sheet and keeps extending.
await page.keyboard.press("Escape");
const wrap = page.locator(visible + ' [data-testid="results-grid-wrap"]');
const wb = await wrap.boundingBox();
const s = await center(cell(0, 0));
await page.mouse.move(s.x, s.y);
await page.mouse.down();
await page.mouse.move(s.x + 200, wb.y + wb.height + 30, { steps: 5 });
await page.waitForTimeout(700);
await page.mouse.up();
const top = await wrap.evaluate((e) => e.scrollTop);
check(top > 100, `drag below the sheet scrolls it (scrollTop ${top})`);
await page.keyboard.press("Control+c");
await page.waitForTimeout(150);
const rowsCopied = (await clipboard()).split("\n").length;
check(rowsCopied > 15, `the block grew while scrolling (${rowsCopied} rows)`);
await page.screenshot({ path: `${OUT}/6-drag-autoscroll.png`, clip });
console.log(`${OUT}/6-drag-autoscroll.png`);

// 11. Right-click inside a block keeps it and offers the two copies.
await wrap.evaluate((e) => { e.scrollTop = 0; e.scrollLeft = 0; });
// Let the last toast fade so the menu shot is clean.
await page.waitForTimeout(1800);
const m1 = await center(cell(1, 1));
const m2 = await center(cell(3, 2));
await page.mouse.move(m1.x, m1.y);
await page.mouse.down();
await page.mouse.move(m2.x, m2.y, { steps: 4 });
await page.mouse.up();
await cell(2, 2).click({ button: "right" });
await page.waitForSelector(MENU);
check((await selCount()) === 6, "right-click inside the block keeps it");
const labels = await page.$$eval(`${MENU} [data-item]`, (els) => els.map((e) => `${e.dataset.item}=${e.querySelector('[data-testid="grid-menu-label"]').textContent}:${e.dataset.keys ?? ""}`));
check(labels.join("|") === "quick-look=Quick Look:Space|csv=Copy:Ctrl+C|csv-header=Copy with headers:Ctrl+Shift+C", `menu items: ${labels.join(", ")}`);
await page.locator(`${MENU} [data-item="csv-header"]`).hover();
await page.screenshot({ path: `${OUT}/7-context-menu.png`, clip });
console.log(`${OUT}/7-context-menu.png`);
await page.locator(`${MENU} [data-item="csv-header"]`).click();
await page.waitForTimeout(200);
check((await clipboard()) === 'owner\temail\nHopper, Grace\tgrace@kioskuno.com\nAlan Turing\talan@kioskuno.com\nEdsger Dijkstra\tedsger@kioskuno.com', "Copy with headers copies the block with its header");
check((await page.locator(MENU).count()) === 0, "the menu closes after a pick");
check((await toastText()) === "Copied 6 cells · TSV with header", "toast after a menu copy");

// 12. Right-click outside the block selects that cell; Copy copies it.
await cell(6, 2).click({ button: "right" });
await page.waitForSelector(MENU);
check((await selCount()) === 0 && (await cell(6, 2).evaluate((e) => e.hasAttribute("data-active"))), "right-click elsewhere selects that cell");
await page.locator(`${MENU} [data-item="csv"]`).click();
await page.waitForTimeout(200);
check((await clipboard()) === "margaret@kioskuno.com", "Copy copies the cell");

// 13. Keyboard: ↓ ↵ picks; Esc and a click outside close without copying.
await page.evaluate(() => navigator.clipboard.writeText("-"));
await cell(0, 0).click({ button: "right" });
await page.waitForSelector(MENU);
await page.keyboard.press("ArrowDown");
await page.keyboard.press("ArrowDown");
await page.keyboard.press("Enter");
await page.waitForTimeout(200);
check((await clipboard()) === "1001", "↓ ↓ ↵ picks Copy");
await page.evaluate(() => navigator.clipboard.writeText("-"));
await cell(0, 0).click({ button: "right" });
await page.waitForSelector(MENU);
await page.keyboard.press("Escape");
await page.waitForTimeout(250);
check((await page.locator(MENU).count()) === 0 && (await clipboard()) === "-", "Esc closes the menu");
check((await page.locator(visible + " [data-col][data-active]").count()) === 1, "Esc on the menu leaves the selection");
await cell(0, 0).click({ button: "right" });
await page.waitForSelector(MENU);
await page.mouse.click(5, 5);
await page.waitForTimeout(250);
check((await page.locator(MENU).count()) === 0 && (await clipboard()) === "-", "a click outside closes the menu");
// Near the window's corner the menu opens up and to the left.
const last = page.locator(`${visible} [data-row]`).last().locator("[data-col]").last();
await last.click({ button: "right", position: { x: 5, y: 5 } });
await page.waitForSelector(MENU);
const mb = await page.locator(MENU).boundingBox();
const vp = page.viewportSize();
check(mb.x + mb.width <= vp.width && mb.y + mb.height <= vp.height, "the menu stays inside the window");
await page.keyboard.press("Escape");

// 14. ⌘A in the editor still selects the editor's text.
await page.click(visible + ' [data-testid="sql-editor"]');
await page.keyboard.press("ControlOrMeta+a");
const edSel = await page.evaluate(() => {
  const t = document.activeElement;
  return t && "selectionEnd" in t ? t.selectionEnd - t.selectionStart : 0;
});
check(edSel > 20, "⌘A in the editor selects the SQL, not the grid");

await browser.close();
