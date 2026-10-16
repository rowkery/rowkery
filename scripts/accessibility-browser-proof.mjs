#!/usr/bin/env node
// Accessibility proof without a Tauri webview (stubbed `invoke`), read from
// Chromium's accessibility tree: the results grid is a grid of rows, column
// headers, row headers and cells (with row and column indexes, since both are
// virtualized), and the cell under the ring is the one announced as ↓ moves it;
// every HTML menu has a name and announces the row ↓ highlights; ⌘K, the
// database picker and SQL completions announce their highlighted option while
// focus stays in the field. The real app's AX tree (VoiceOver) is checked with
// scripts/e2e.
//
//   cd apps/rowkery-tauri && npx vite --port 1420 &
//   node scripts/accessibility-browser-proof.mjs [outDir]
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

const OUT = process.argv[2] ?? "/tmp/rowkery-proof/accessibility";
const URL = process.env.ROWKERY_DEV_URL ?? "http://localhost:1420/";
mkdirSync(OUT, { recursive: true });

function stubTauri() {
  Object.defineProperty(Navigator.prototype, "platform", { get: () => "MacIntel" });
  const connections = [
    { kind: "postgres", id: "shop", name: "shop", host: "127.0.0.1", port: 5432, database: "shop", username: "app", environment: "local" },
  ];
  const col = (name, type_name, nullable) => ({ name, type_name, nullable, default: null });
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
                columns: [col("id", "int8", false), col("name", "text", false), col("city", "text", true), col("opened_on", "date", false), col("player_id", "int8", true)],
                primary_key: ["id"],
                foreign_keys: [{ name: "kiosks_player", columns: ["player_id"], ref_schema: "public", ref_table: "players", ref_columns: ["id"], on_delete: "NO ACTION" }],
                indexes: [],
                row_estimate: { Approximate: 12 },
                partition_of: null,
              },
              { name: "players", columns: [col("id", "int8", false), col("email", "text", true)], primary_key: ["id"], indexes: [], row_estimate: { Approximate: 1 }, partition_of: null },
            ],
          },
        ],
      },
    ],
  };
  const names = ["North Quay", "Lantern Row", "Ferry Gate", "Glasshouse", "Night Pier", "Tram Depot", "Riverside", "Market Arcade", "Canal Corner", "Station Hall", "Old Mill", "Harbour Front"];
  const cities = ["Bergen", "Valencia", "Hamburg", "Copenhagen", "Brighton", "Zurich", "Lyon", "Ghent", "Amsterdam", "Utrecht", "Porto", "Lisbon"];
  window.__TAURI_INTERNALS__ = {
    metadata: { currentWindow: { label: "main" }, currentWebview: { label: "main" } },
    transformCallback: () => 0,
    invoke: async (cmd, args) => {
      switch (cmd) {
        case "list_databases":
          return [
            { name: "analytics", size_bytes: 1_000_000 },
            { name: "shop", size_bytes: 7_400_000 },
          ];
        case "check_for_update":
          return { status: "off" };
        case "list_connections":
          return { connections: structuredClone(connections), active_connection_id: null };
        case "open_window":
          return { database: "shop", catalog, elapsed_ms: 5 };
        case "browse_table_sql":
          return `SELECT * FROM ${args.schema}.${args.table}${args.filter ? ` WHERE (${args.filter})` : ""} ORDER BY id LIMIT 1000;`;
        case "follow_keys":
          return (args.lookups ?? []).map(() => ({
            columns: [{ name: "id", type_name: "int8" }, { name: "email", type_name: "text" }],
            row: [{ Int: 7 }, { Text: "a.very.long.address+filters@example-company.com" }],
          }));
        case "run_query":
          // Quick Look reads the row a key points at.
          if (/players/.test(args.sql))
            return {
              columns: [{ name: "id", type_name: "int8" }, { name: "email", type_name: "text" }],
              rows: [[{ Int: 7 }, { Text: "a.very.long.address+filters@example-company.com" }]],
              row_count: 1,
              elapsed_ms: 1,
              error: null,
              cancelled: false,
            };
          return {
            columns: [{ name: "id", type_name: "int8" }, { name: "name", type_name: "text" }, { name: "city", type_name: "text" }, { name: "opened_on", type_name: "date" }, { name: "player_id", type_name: "int8" }],
            rows: names.map((n, i) => [{ Int: i + 1 }, { Text: n }, { Text: cities[i] }, { Text: `202${4 - (i % 4)}-0${(i % 9) + 1}-1${i % 10}` }, { Int: 7 }]),
            row_count: names.length,
            elapsed_ms: 1,
            error: null,
            cancelled: false,
          };
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
const page = await (await browser.newContext({ viewport: { width: 1200, height: 760 }, deviceScaleFactor: 2 })).newPage();
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
const cdp = await page.context().newCDPSession(page);
/** The accessibility tree under the first element matching `sel` (Chromium's own, as AT reads it). */
const axTree = async (sel) => {
  const { root } = await cdp.send("DOM.getDocument", { depth: 0 });
  const { nodeId } = await cdp.send("DOM.querySelector", { nodeId: root.nodeId, selector: sel });
  const { nodes } = await cdp.send("Accessibility.getPartialAXTree", { nodeId, fetchRelatives: false });
  const { nodes: all } = await cdp.send("Accessibility.queryAXTree", { nodeId });
  return [...nodes, ...all];
};
/** What AT announces for the element `aria-activedescendant` on the focused element points at. */
const announced = () =>
  page.evaluate(() => {
    const f = document.activeElement;
    const id = f?.getAttribute("aria-activedescendant");
    const el = id ? document.getElementById(id) : null;
    return el ? { role: el.getAttribute("role"), text: el.textContent.trim(), focusRole: f.getAttribute("role") ?? f.tagName.toLowerCase() } : null;
  });

// 1. The grid: rows, column headers, row headers and cells, indexed.
await page.click(W + ' [data-table$=".public.kiosks"] [data-testid="sb-row-main"]');
await page.waitForSelector(W + ' [data-row="11"]');
const grid = page.getByRole("grid");
const gridName = await grid.getAttribute("aria-label");
check((await grid.count()) === 1 && gridName === "kiosks rows", `one grid, named "${gridName}"`);
const nodes = await axTree(W + ' [data-testid="results-grid-wrap"]');
const roles = {};
for (const n of nodes) roles[n.role?.value] = (roles[n.role?.value] ?? 0) + 1;
check(roles.row >= 13 && roles.gridcell >= 60 && roles.columnheader >= 6 && roles.rowheader >= 12, `the tree has rows, cells and headers: ${JSON.stringify(roles)}`);
const header = await page.$$eval(W + ' [role="columnheader"]', (els) => els.map((e) => `${e.getAttribute("aria-colindex")}:${e.getAttribute("aria-label")}`));
check(header.join(" ") === "1:Row 2:id, int8 3:name, text 4:city, text 5:opened_on, date 6:player_id, int8", `column headers say name and type: ${header.join(" | ")}`);
const counts = await grid.evaluate((g) => [g.getAttribute("aria-rowcount"), g.getAttribute("aria-colcount")]);
check(counts[0] === "13" && counts[1] === "6", `counts include the header row and the row numbers: ${counts}`);

// 2. The ring is what's announced, and ↓ moves it.
await page.click(W + ' [data-row="2"] [data-col="1"]');
let a = await announced();
check(a?.role === "gridcell" && a.text === "Ferry Gate", `the clicked cell is announced: ${JSON.stringify(a)}`);
await page.keyboard.press("ArrowDown");
a = await announced();
check(a?.text === "Glasshouse", `↓ announces the next row's cell: ${JSON.stringify(a)}`);
const rowIndex = await page.evaluate(() => document.getElementById(document.activeElement.getAttribute("aria-activedescendant")).closest('[role="row"]').getAttribute("aria-rowindex"));
check(rowIndex === "5", `in row 5 of the grid (header is 1): ${rowIndex}`);

// 3. The cell menu has a name; ↓ announces its first row.
await page.click(W + ' [data-row="3"] [data-col="1"]', { button: "right" });
await page.waitForSelector('[data-menu="grid"]');
check((await page.getAttribute('[data-menu="grid"]', "aria-label")) === "Cell", "the cell menu is named Cell");
await page.keyboard.press("ArrowDown");
a = await announced();
check(a?.role === "menuitem" && a.focusRole === "menu" && a.text.length > 0, `↓ announces "${a?.text}"`);
await page.keyboard.press("Escape");
const unnamed = await page.evaluate(() => [...document.querySelectorAll('[role="menu"], [role="listbox"], [role="dialog"]')].filter((e) => !e.getAttribute("aria-label")).length);
check(unnamed === 0, "no unnamed menu, list or dialog on screen");

// 4. ⌘K right after Esc on the menu opens (the closing menu kept focus and
// swallowed keys); focus in the field, the highlighted command announced.
await page.keyboard.press("Meta+k");
const opened = await page.waitForSelector('[data-testid="cp-panel"]', { timeout: 2000 }).then(() => true, () => false);
check(opened, "⌘K right after Esc on a menu opens the palette");
if (!opened) process.exit(1);
await page.keyboard.type("copy");
a = await announced();
check(a?.focusRole === "combobox" && a.role === "option" && a.text.length > 0, `⌘K announces "${a?.text}"`);
await page.keyboard.press("ArrowDown");
const b = await announced();
check(b && b.text !== a.text, `↓ announces "${b?.text}"`);
await page.keyboard.press("Escape");
await page.keyboard.press("Escape");

// 5. ⇧⌘D: the typed database is the announced one.
await page.keyboard.press("Meta+Shift+d");
await page.waitForSelector('[data-testid="db-popover"]');
await page.keyboard.type("anal");
await page.waitForTimeout(100);
a = await announced();
check(a?.focusRole === "combobox" && /^analytics/.test(a.text), `the picker announces "${a?.text}"`);
await page.keyboard.press("Escape");

// 6. SQL completions: the highlighted one is announced from the editor.
await page.click(W + ' [data-testid="query-tab-add"]');
await page.click(W + ' [data-testid="sql-editor"]');
await page.keyboard.type("SELECT * FROM kio");
await page.waitForSelector('[data-testid="ac-popup"]');
a = await announced();
check(a?.role === "option" && /kiosks/.test(a.text), `the completion announced is "${a?.text}"`);
await page.screenshot({ path: `${OUT}/1-completion.png` });
console.log(`${OUT}/1-completion.png`);

await browser.close();
