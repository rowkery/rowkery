#!/usr/bin/env node
// Presenting and marking from the grid (2026-10-15) proof with a
// stubbed Tauri `invoke`. A sensitive column (the connection's
// `masked_columns`, what agents only see as stand-ins) carries an eye in its
// grid header. The eye button at the schema column's foot (or ⌘K Start /
// Stop presenting) turns Presenting on for the window: it goes orange, the
// marked column's cells show dots (no tooltip, no profile bar, no find match,
// no editor), Quick Look shows dots too, Copy still copies the real value,
// and the host line under the connection's name goes, also in ⌘K. A query
// tab hides a column by name when that name is marked anywhere in the
// database. Right-click a table tab's header: Mark as sensitive saves the
// whole `masked_columns` map, Unmark sensitive takes it out. Light and dark.
// That agents only get stand-ins is proved by `cargo test -p rowkery-mcp`.
//
//   cd apps/rowkery-tauri && npx vite --port 1420 &
//   node scripts/presenting-browser-proof.mjs [outDir]
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
const OUT = process.argv[2] ?? "/tmp/rowkery-proof/presenting";
const URL = process.env.ROWKERY_DEV_URL ?? "http://localhost:1420/";
const FRAMES_SHIM = new globalThis.URL("./lib/frames-shim.js", import.meta.url).pathname;
mkdirSync(OUT, { recursive: true });

function stubTauri() {
  localStorage.clear();
  window.__CALLS__ = [];
  const connections = [
    {
      kind: "postgres",
      id: "pg",
      name: "shop-prd",
      host: "shop-db.c9x.rds.amazonaws.com",
      port: 5432,
      database: "shop",
      username: "app",
      environment: "prd",
      masked_columns: { shop: ["public.customers.email"] },
    },
  ];
  const col = (name, type_name, nullable = false) => ({ name, type_name, nullable });
  const CUSTOMERS = [col("id", "int8"), col("full_name", "text"), col("email", "text"), col("phone", "text", true), col("country", "text")];
  const table = (name, columns) => ({
    name,
    kind: "table",
    columns,
    primary_key: ["id"],
    indexes: [],
    foreign_keys: [],
    row_estimate: { Approximate: 12 },
    partition_of: null,
  });
  const tables = [table("customers", CUSTOMERS)];
  const people = ["Aisha Rahman", "Ben Okafor", "Chen Wei", "Dana Cruz", "Eli Novak", "Farah Lim", "Gus Patel", "Hana Sato"];
  const rowOf = (i) => [
    { Int: i + 1 },
    { Text: people[i % people.length] },
    { Text: `${people[i % people.length].split(" ")[0].toLowerCase()}@example.com` },
    { Text: `+60 12-${String(3000000 + i * 1111).slice(0, 3)} ${String(4000 + i)}` },
    { Text: ["MY", "SG", "ID"][i % 3] },
  ];
  window.__TAURI_INTERNALS__ = {
    metadata: { currentWindow: { label: "main" }, currentWebview: { label: "main" } },
    transformCallback: () => 0,
    invoke: async (cmd, args) => {
      window.__CALLS__.push([cmd, args]);
      switch (cmd) {
        case "list_connections":
          return { connections: structuredClone(connections), active_connection_id: null };
        case "save_connection": {
          const i = connections.findIndex((c) => c.id === args.connection.id);
          if (i >= 0) connections[i] = args.connection;
          return null;
        }
        case "open_window":
          return { database: "shop", catalog: { databases: [{ name: "shop", schemas: [{ name: "public", tables }] }] }, elapsed_ms: 2, cached: false, open_seq: 1 };
        case "browse_table_sql":
          return `SELECT * FROM ${args.schema}.${args.table}\nORDER BY id${args.limit ? `\nLIMIT ${args.limit}` : ""};`;
        case "run_query": {
          const n = 8;
          const picked = /select email, full_name/i.test(args.sql) ? [2, 1] : [0, 1, 2, 3, 4];
          return {
            columns: picked.map((i) => ({ name: CUSTOMERS[i].name, type_name: CUSTOMERS[i].type_name })),
            rows: Array.from({ length: n }, (_, r) => picked.map((i) => rowOf(r)[i])),
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
const cell = (r, c) => `${ws} [data-row="${r}"] [data-col="${c}"]`;
const presentBtn = `${ws} [data-testid="sb-presenting"]`;
const cellText = (r, c) => page.textContent(cell(r, c));
const saves = () => page.evaluate(() => window.__CALLS__.filter(([c]) => c === "save_connection").map(([, a]) => a.connection.masked_columns));

await page.waitForSelector(ws);
await page.keyboard.press("Control+Shift+O");
await page.waitForSelector('[data-testid="conn-popover"]');
await page.keyboard.press("Enter");
await page.waitForSelector(`${ws}[data-conn-state="connected"]`);
await page.click(`${ws} [data-table="shop.public.customers"] [data-testid="sb-row-main"]`);
await page.waitForSelector(cell(0, 2));

// 1. Off: values show; the marked column wears an eye.
check(!!(await page.$(`${ws} [data-header="email"] [data-marked]`)), "email's header carries the sensitive eye");
check(!(await page.$(`${ws} [data-header="full_name"] [data-marked]`)), "full_name's header doesn't");
check((await cellText(0, 2)) === "aisha@example.com", `off: email shows (${await cellText(0, 2)})`);
check(!!(await page.$(`${ws} [data-sb-sub]`)), "off: the host line shows under the connection's name");
check((await page.getAttribute(presentBtn, "aria-pressed")) === "false", "the foot's Presenting button is off");
await page.screenshot({ path: `${OUT}/1-off.png` });

// 2. On: dots, no tooltip, the host line goes, the button is orange.
await page.click(presentBtn);
await page.waitForSelector(`${cell(0, 2)}[data-hidden]`);
check((await cellText(0, 2)) === "••••••", `on: email shows dots (${await cellText(0, 2)})`);
check((await page.getAttribute(cell(0, 2), "title")) === null, "on: a hidden cell has no tooltip");
check((await cellText(0, 1)) === "Aisha Rahman", "on: full_name, not marked, still shows");
check(!(await page.$(`${ws} [data-sb-sub]`)), "on: the host line is gone");
check((await page.getAttribute(presentBtn, "aria-pressed")) === "true" && (await page.getAttribute(presentBtn, "data-on")) === "", "on: the button is pressed (orange)");
await page.mouse.move(700, 400);
await page.waitForTimeout(400);
const btnColor = await page.$eval(presentBtn, (e) => getComputedStyle(e).color);
const accColor = await page.evaluate(() => {
  const p = document.createElement("span");
  p.style.color = "var(--acc)";
  document.body.append(p);
  const c = getComputedStyle(p).color;
  p.remove();
  return c;
});
check(btnColor === accColor, `on: the button takes --acc (${btnColor})`);
const emailHeaderTitle = await page.getAttribute(`${ws} [data-header="email"]`, "title");
check(!/example\.com/.test(emailHeaderTitle ?? ""), "on: the header's tooltip has no sample of the values");
await page.screenshot({ path: `${OUT}/2-on-light.png` });

// 3. Copy still copies the real value.
await page.click(cell(1, 2));
await page.keyboard.press("Control+C");
await page.waitForTimeout(150);
check((await page.evaluate(() => navigator.clipboard.readText())) === "ben@example.com", "on: Copy copies the real email");

// 4. Quick Look shows dots for the marked column.
await page.keyboard.press("Space");
await page.waitForSelector(`${ws} [data-quicklook]`);
const ql = await page.textContent(`${ws} [data-quicklook]`);
check(!ql.includes("ben@example.com") && ql.includes("••••••") && ql.includes("Ben Okafor"), "on: Quick Look shows dots for email, the name as it is");
await page.screenshot({ path: `${OUT}/3-quick-look.png` });
await page.keyboard.press("Escape");

// 5. The editor doesn't open on a hidden cell.
await page.dblclick(cell(2, 2));
await page.waitForTimeout(150);
check(!(await page.$(`${ws} [data-testid="cell-editor"], ${ws} .rg-editor`)), "on: double-click doesn't open an editor on a hidden cell");
await page.keyboard.press("Escape");

// 6. ⌘K lists Stop presenting, and the connection's ⌘K line drops the host.
await page.keyboard.press("Control+K");
await page.waitForSelector('[data-testid="cp-panel"]');
await page.keyboard.type("shop-prd");
await page.waitForTimeout(150);
const connRow = await page.$$eval('[data-testid="cp-row"]', (els) => els.map((e) => e.textContent).join(" | "));
check(connRow.includes("shop-prd") && !connRow.includes("rds.amazonaws.com"), `on: ⌘K's connection row has no host (${connRow.slice(0, 80)})`);
await page.keyboard.press("ControlOrMeta+A");
await page.keyboard.type("presenting");
await page.waitForTimeout(150);
check(!!(await page.$('[data-item="cmd:presenting"]')), "⌘K finds the presenting command");
const cmdText = await page.textContent('[data-item="cmd:presenting"]');
check(/Stop presenting/.test(cmdText), `⌘K says Stop presenting while on (${cmdText})`);
// The first Esc clears the search, the second closes ⌘K.
await page.keyboard.press("Escape");
await page.keyboard.press("Escape");
await page.waitForFunction(() => !document.querySelector('[data-testid="cp-scrim"]'));

// 7. Mark as sensitive from the header (table tab), then Unmark.
await page.click(`${ws} [data-header="phone"]`, { button: "right" });
await page.waitForSelector('[data-menu="header"]');
check((await page.textContent('[data-menu="header"] [data-item="mark"]')).includes("Mark as sensitive"), "phone's header menu offers Mark as sensitive");
await page.click('[data-menu="header"] [data-item="mark"]');
await page.waitForSelector(`${cell(0, 3)}[data-hidden]`);
const saved = await saves();
check(JSON.stringify(saved.at(-1)) === JSON.stringify({ shop: ["public.customers.email", "public.customers.phone"] }), `Mark saves the whole map (${JSON.stringify(saved.at(-1))})`);
check(!!(await page.$(`${ws} [data-header="phone"] [data-marked]`)), "phone now carries the eye, and its cells are dots");
await page.click(`${ws} [data-header="phone"]`, { button: "right" });
await page.waitForSelector('[data-menu="header"]');
check((await page.textContent('[data-menu="header"] [data-item="mark"]')).includes("Unmark sensitive"), "a marked column's menu offers Unmark sensitive");
await page.click('[data-menu="header"] [data-item="mark"]');
await page.waitForFunction((sel) => !document.querySelector(sel), `${cell(0, 3)}[data-hidden]`);
check(JSON.stringify((await saves()).at(-1)) === JSON.stringify({ shop: ["public.customers.email"] }), "Unmark takes it back out");

// 8. A query tab hides by column name.
await page.click(`${ws} [data-testid="query-tab"][data-title="Query 1"]`);
await page.click(`${ws} textarea[data-testid="sql-editor"]`);
await page.keyboard.press("ControlOrMeta+a");
await page.keyboard.type("select email, full_name from customers;");
await page.keyboard.press("Control+Enter");
await page.waitForSelector(`${cell(0, 0)}[data-hidden]`);
check((await cellText(0, 0)) === "••••••" && (await cellText(0, 1)) === "Aisha Rahman", "a query tab's email column is dots, full_name shows");
await page.click(`${ws} [data-header="email"]`, { button: "right" });
await page.waitForSelector('[data-menu="header"]');
check(!(await page.$('[data-menu="header"] [data-item="mark"]')), "a query tab's header menu has no Mark row (no table to name)");
await page.keyboard.press("Escape");

// 9. Dark.
await page.evaluate(() => document.documentElement.setAttribute("data-theme", "dark"));
await page.waitForTimeout(150);
await page.screenshot({ path: `${OUT}/4-on-dark.png` });
const darkCell = await page.$eval(cell(0, 0), (e) => getComputedStyle(e).color);
check(!!darkCell, `dark: hidden cells take the mute token (${darkCell})`);

// 10. Off again from ⌘K: values come back, and the setting is saved.
await page.keyboard.press("Control+K");
await page.waitForSelector('[data-testid="cp-panel"]');
await page.keyboard.type("stop presenting");
await page.waitForTimeout(150);
await page.keyboard.press("Enter");
await page.waitForFunction((sel) => !document.querySelector(sel), `${cell(0, 0)}[data-hidden]`);
check((await cellText(0, 0)) === "aisha@example.com", "⌘K Stop presenting shows the values again");
check((await page.getAttribute(presentBtn, "aria-pressed")) === "false", "the foot's button is off again");

await browser.close();
