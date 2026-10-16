#!/usr/bin/env node
// Grid polish proof without a Tauri webview (stubbed `invoke`): columns fit
// their first rows' values (measured in the grid's fonts, not estimated, and
// widened as a streamed result's rows arrive); a NOT NULL column's cell menu
// has no "IS NULL" row; Quick Look's followed-key label is one line; a
// connection named after its database shows the name once; ⌘F on a column
// the table doesn't have says so and ↵ takes the one it meant. The real app's
// check (WebKit's fonts) is scripts/e2e RES-13 and TBL-2b.
//
//   cd apps/rowkery-tauri && npx vite --port 1420 &
//   node scripts/grid-polish-browser-proof.mjs [outDir]
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

const OUT = process.argv[2] ?? "/tmp/rowkery-proof/grid-polish";
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

// 1. The panel head: "shop" once. The head names the
//    database (the title bar names the connection), so the chip shows it.
const head = await page.$eval('[data-testid="sb-head"]', (e) => e.innerText.replace(/\s+/g, " ").trim());
check(!/shop.*shop/.test(head), `named after its database, the name shows once: "${head}"`);
check((await page.textContent('[data-testid="sb-head"] [data-testid="db-chip"] [data-testid="conn-chip-name"]'))?.trim() === "shop", "the database chip names it");
check((await page.locator('[data-testid="sb-head"] .sb-head-sep').count()) === 0, "and no / between them");
await page.screenshot({ path: `${OUT}/0-head.png`, clip: await page.locator('[data-testid="sb-head"]').boundingBox() });
console.log(`${OUT}/0-head.png`);

// 2. Columns fit their values.
await page.click(W + ' [data-table$=".public.kiosks"] [data-testid="sb-row-main"]');
await page.waitForSelector(W + ' [data-row="11"]');
const cut = await page.$$eval(W + " [data-row] [data-col]", (cells) => cells.filter((c) => c.scrollWidth > c.clientWidth).map((c) => c.textContent));
check(cut.length === 0, `no value is cut off: ${JSON.stringify(cut)}`);
const grid = await page.locator(W + ' [data-testid="results-grid-wrap"]').boundingBox();
await page.screenshot({ path: `${OUT}/1-columns-fit.png`, clip: { x: grid.x, y: grid.y, width: Math.min(grid.width, 700), height: 420 } });
console.log(`${OUT}/1-columns-fit.png`);

// 3. A NOT NULL column's menu has no IS NULL row; a nullable one does.
const menuIds = async (col) => {
  await page.click(W + ` [data-row="1"] [data-col="${col}"]`, { button: "right" });
  await page.waitForSelector("[data-menu]");
  const ids = await page.$$eval("[data-menu] [data-item]", (els) => els.map((e) => e.dataset.item));
  await page.keyboard.press("Escape");
  return ids;
};
check(!(await menuIds(1)).includes("f-null"), "name (NOT NULL): no 'IS NULL' row");
check((await menuIds(2)).includes("f-null"), "city (nullable): the 'IS NULL' row stays");

// 4. Quick Look's followed-key label is one line, the whole of it its title.
await page.click(W + ' [data-row="0"] [data-col="4"]');
await page.keyboard.press("Space");
await page.waitForSelector('[data-follow="player_id"]');
// 2026-10-13: a "normal" line-height reads as NaN; measure it from the font size then.
const follow = await page.$eval('[data-follow="player_id"]', (e) => { const s = getComputedStyle(e); const lh = parseFloat(s.lineHeight) || parseFloat(s.fontSize) * 1.3; return { lines: Math.round(e.getBoundingClientRect().height / lh), title: e.title }; });
check(follow.lines === 1, `the label is one line (${follow.lines})`);
check(follow.title === "a.very.long.address+filters@example-company.com", `its title is the whole label: ${follow.title}`);
await page.keyboard.press("Escape");

// 5. ⌘F `nam = 'Old Mill'`: no column nam; ↵ again takes name.
await page.keyboard.press("Meta+f");
await page.waitForSelector(W + " [data-chip-editor]");
await page.keyboard.type("nam = 'Old Mill'");
await page.keyboard.press("Enter");
await page.waitForSelector("[data-toast-offer]");
const toast = await page.$eval("[data-toast]", (e) => e.textContent.replace(/\s+/g, " "));
check(/No column nam/.test(toast) && /Use name/.test(toast), `the toast says so: ${toast}`);
check((await page.$eval("[data-toast]", (e) => e.dataset.toast)) === "error", "as an error, not a ✓");
await page.screenshot({ path: `${OUT}/2-unknown-column.png`, clip: await page.locator("[data-toast]").boundingBox() });
console.log(`${OUT}/2-unknown-column.png`);
await page.keyboard.press("Enter");
await page.waitForFunction(() => /name = 'Old Mill'/.test(document.querySelector('[data-testid="workspace"]:not([hidden]) [data-sql-text]')?.dataset.sqlText ?? ""));
check(true, "↵ applied the chip on name");

await browser.close();
