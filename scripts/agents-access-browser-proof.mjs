#!/usr/bin/env node
// Agents page redesign (2026-10-14) proof with a stubbed Tauri `invoke`:
// the picked call opens Access (what was shared then), Request (the
// arguments as sent) and Response (the first 512 B of what went back);
// in Settings › Agents (2026-10-17, from the Agents page's Sharing),
// clicking a shared card opens Edit access (no button for it), which takes
// the cards' place and lists the connection's databases
// and the picked one's tables by schema; ticking a table, a schema, All
// tables (over the filter) and a database each save the whole access map at
// once; ticking a database ticks every table in it (an allow list, so tables
// made later stay hidden); there's no Only ticked | All but unticked switch
// (removed 2026-10-14); the tick mark is white and centred;
// ⌘F filters tables; Esc goes back
// to the cards; a connection saved before the map edits as every database
// minus its hidden tables, and can't be ticked until those are listed (a
// tick then would unshare the rest); Done closes the picker's sessions;
// turning sharing on shares the own database with
// nothing ticked, opens Edit access and ticks its tables. The server's side (whitelist
// refused through views, joins and catalogs; unshared databases) is proved
// by `cargo test -p rowkery-mcp` (with `--features postgres-integration`).
//
//   cd apps/rowkery-tauri && npx vite --port 1420 &
//   node scripts/agents-access-browser-proof.mjs [outDir]
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

const OUT = process.argv[2] ?? "/tmp/rowkery-proof/agents-access";
const URL = process.env.ROWKERY_DEV_URL ?? "http://localhost:1420/";
mkdirSync(OUT, { recursive: true });

function stubTauri() {
  const pg = (id, name, database, environment, over) => ({
    kind: "postgres",
    id,
    name,
    host: `${id}-db.c9x.rds.amazonaws.com`,
    port: 5432,
    database,
    username: "app",
    environment,
    ...over,
  });
  const connections = [
    pg("api", "Platform API", "orders", "stg", {
      allow_mcp: true,
      mcp_access: { orders: { mode: "picked", tables: ["public.orders", "public.order_items"] } },
    }),
    pg("ops", "ops_portal", "ops", "dev", { allow_mcp: true, mcp_hidden_tables: ["public.api_keys"] }),
    pg("prd", "Platform API", "orders", "prd", { allow_mcp: false }),
  ];
  const DBS = [
    { name: "analytics", size_bytes: 4.8 * 1024 ** 3 },
    { name: "billing", size_bytes: 310 * 1024 ** 2 },
    { name: "ops", size_bytes: 90 * 1024 ** 2 },
    { name: "orders", size_bytes: 1.2 * 1024 ** 3 },
  ];
  const t = (schema, name, rows, kind = "table") => ({ schema, name, kind, rows, big: rows > 100_000 });
  const TABLES = [
    t("audit", "changes", 2_000_000),
    t("audit", "daily_totals", 400, "view"),
    t("public", "api_keys", 140),
    t("public", "categories", 38),
    t("public", "customers", 61_000),
    t("public", "events", 4_100_000),
    t("public", "order_items", 310_000),
    t("public", "orders", 84_000),
    t("public", "products", 2_400),
  ];
  const t0 = Date.now();
  const session = t0 - 150_000;
  const at = (s) => t0 - s * 1000;
  const base = { session, client: "claude-code" };
  const scope = { databases: 1, mode: "picked", tables: 2, timeout_s: 10 };
  const sql = "select status, count(*) from orders where created_at > now() - interval '7 days' group by 1";
  const log = [
    { ...base, ts: at(140), tool: "list_connections", rows: 2, verdict: "ok", args: {}, bytes: 210 },
    {
      ...base,
      ts: at(120),
      tool: "describe_table",
      connection: "api",
      database: "orders",
      target: "public.orders",
      verdict: "ok",
      args: { connection: "Platform API", table: "orders" },
      scope,
      bytes: 3482,
    },
    {
      ...base,
      ts: at(30),
      tool: "query",
      connection: "api",
      database: "orders",
      sql,
      rows: 4,
      ms: 38,
      verdict: "ok",
      args: { connection: "Platform API", database: "orders", sql, max_rows: 200 },
      scope: { ...scope, max_rows: 200 },
      bytes: 1126,
    },
  ];
  const response =
    '{"columns":["status","count"],"rows":[["paid",1240],["pending",212],["refunded",31],["cancelled",9]],"row_count":4,"more":false,"elapsed_ms":38,"types":["order_status","int8"],"notes":["' +
    "x".repeat(400);
  let offset = 0;
  window.__ROWKERY_CALLS__ = [];
  window.__TAURI_INTERNALS__ = {
    metadata: { currentWindow: { label: "main" }, currentWebview: { label: "main" } },
    transformCallback: () => 0,
    invoke: async (cmd, args) => {
      window.__ROWKERY_CALLS__.push([cmd, args]);
      switch (cmd) {
        case "list_connections":
          return { connections: structuredClone(connections), active_connection_id: null };
        case "save_connection": {
          const i = connections.findIndex((c) => c.id === args.connection.id);
          if (i >= 0) connections[i] = args.connection;
          return null;
        }
        case "mcp_activity":
          if (args.since == null || args.since > offset) {
            offset = log.length;
            return { entries: structuredClone(log), offset, reset: true };
          }
          return { entries: [], offset, reset: false };
        case "mcp_sample":
          return args.ts === log[2].ts ? { session, ts: args.ts, text: response.slice(0, 512), bytes: 1126 } : null;
        case "mcp_pick_databases":
          await new Promise((r) => setTimeout(r, 30));
          if (window.__FAIL_DBS__) throw "Timed out connecting.";
          return structuredClone(DBS);
        case "mcp_pick_tables":
          await new Promise((r) => setTimeout(r, 30));
          return structuredClone(TABLES);
        default:
          return null;
      }
    },
  };
}

const browser = await playwright.chromium.launch({
  executablePath: process.env.CHROMIUM_PATH ?? "/opt/pw-browsers/chromium",
});
const context = await browser.newContext({ viewport: { width: 1360, height: 860 }, deviceScaleFactor: 2 });
await context.grantPermissions(["clipboard-read", "clipboard-write"], { origin: URL });
const page = await context.newPage();
page.on("pageerror", (e) => console.error("pageerror:", e.message));
await page.addInitScript({ path: FRAMES_SHIM });
await page.addInitScript(stubTauri);
await page.goto(URL);
await page.waitForSelector('[data-testid="workspace"]:not([hidden])');

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
const saves = () =>
  page.evaluate(() => window.__ROWKERY_CALLS__.filter(([c]) => c === "save_connection").map(([, a]) => a.connection));
const lastSave = async () => (await saves()).at(-1);
const waitSaves = (n) =>
  page.waitForFunction((k) => window.__ROWKERY_CALLS__.filter(([c]) => c === "save_connection").length >= k, n, { timeout: 4000 });

await page.keyboard.press("Control+Shift+A");
await page.waitForSelector('[data-testid="agents-page"]');

// 1. The picked call: Access, Request, Response.
await page.waitForSelector('[data-testid="mcp-detail"] [data-mcp-box="response"] .mcp-json');
const access = await page.textContent('[data-mcp-box="access"]');
check(/orders/.test(access) && /2\s*ticked/.test(access) && /200 rows · 10 s · read-only/.test(access), `Access says what was shared then: ${access}`);
const request = await page.textContent('[data-mcp-box="request"]');
check(/"max_rows": 200/.test(request) && /"connection": "Platform API"/.test(request), "Request shows the arguments as sent");
const resHead = await page.textContent('[data-mcp-box="response"] h5');
check(/first 512 B of 1.1 KB/.test(resHead), `Response says how much was kept: ${resHead}`);
check(/"paid", 1240/.test(await page.textContent('[data-mcp-box="response"] .mcp-json')), "Response shows the start of the rows");
await page.click("[data-mcp-copy-request]");
const copied = await page.evaluate(() => navigator.clipboard.readText());
check(JSON.parse(copied).max_rows === 200, "Copy request copies the arguments as JSON");
const metas = await page.$$eval('[data-testid="ag-call-meta"]', (els) => els.map((e) => e.textContent));
check(metas.includes("3.4 KB") && metas.includes("4 rows"), `every call shows its size: ${metas.join(" | ")}`);
await shot("1-log-request");
await page.click("[data-ag-sharing]");
await page.waitForSelector('[data-testid="settings-page"] [data-testid="mcp-map"]');

// 2. Clicking a shared card opens its Edit access (there's no Edit access button).
check(!(await page.$('[data-mcp-conn="api"] button:text-is("Edit access")')), "no Edit access button on the card");
check(!(await page.$('[data-mcp-edit="prd"]')), "a card that isn't shared doesn't open Edit access");
await page.click('[data-mcp-conn="api"] [data-mcp-duration="off"]');
await page.waitForTimeout(150);
check(!(await page.$("[data-mcp-editor]")), "a duration click stays a duration click");
await page.click('[data-mcp-edit="api"] [data-testid="mcp-cn-sub"]');
await page.waitForSelector('[data-mcp-editor="api"] [data-ag-table="public.orders"]');
check(!(await page.$('[data-testid="mcp-map"]')), "the cards make way for Edit access");
check(/Platform API/.test(await page.textContent('[data-mcp-editor="api"]')), "Edit access names its connection");
check((await page.$$("[data-ag-db]")).length === 4, "every database of the server is listed");
check((await page.getAttribute('[data-ag-db-tick="orders"]', "aria-checked")) === "true", "the shared database is ticked");
check((await page.getAttribute('[data-ag-db-tick="billing"]', "aria-checked")) === "false", "the others are not");
check((await page.textContent('[data-testid="ag-table-count"]')) === "2 of 9", "Tables: 2 of 9");
const thead = await page.textContent('[data-mcp-editor="api"] .ag-ed-thead h3'); // Class on purpose: the heading under test.
check(/^Tables\s/.test(thead) && !/ in /.test(thead), `the tables heading says only Tables: ${thead}`);
// The mark: white, drawn over the whole box and centred by its mask.
const mark = await page.$eval('[data-ag-table="public.orders"] .ag-cb', (el) => {
  const st = getComputedStyle(el, "::after");
  const box = el.getBoundingClientRect();
  return { bg: st.backgroundColor, w: parseFloat(st.width), h: parseFloat(st.height), box: box.width, pos: st.maskPosition || st.webkitMaskPosition };
});
check(mark.bg === "rgb(255, 255, 255)", `the tick mark is white: ${mark.bg}`);
check(Math.abs(mark.w - mark.h) < 0.5 && mark.box - mark.w <= 2 && /50% 50%|center/.test(mark.pos), `the tick mark fills the box, centred: ${JSON.stringify(mark)}`);
check(
  await page.$eval('[data-testid="settings-page"] [data-testid="page-back"]', (b) => b.parentElement.firstElementChild === b),
  "the page's way out is first in its head",
);
check((await page.getAttribute('[data-ag-schema="public"]', "aria-checked")) === "mixed", "a schema with some ticked reads mixed");
await shot("2-edit-access");

// 3. Ticks save at once.
await page.click('[data-ag-table="public.customers"]');
await waitSaves(1);
let saved = await lastSave();
check(
  JSON.stringify(saved.mcp_access) ===
    JSON.stringify({ orders: { mode: "picked", tables: ["public.orders", "public.order_items", "public.customers"] } }),
  `ticking a table saves it: ${JSON.stringify(saved.mcp_access)}`,
);
await page.click('[data-ag-schema="audit"]');
await waitSaves(2);
saved = await lastSave();
check(saved.mcp_access.orders.tables.includes("audit.changes") && saved.mcp_access.orders.tables.includes("audit.daily_totals"), "a schema tick ticks its tables");

// 4. ⌘F filters tables; All tables acts on what the filter shows.
await page.click('[data-ag-table="public.orders"]'); // untick, then tick back through All tables
await waitSaves(3);
await page.keyboard.press("Control+f");
check(await page.evaluate(() => document.activeElement?.hasAttribute("data-ag-table-filter")), "⌘F puts the keyboard in the tables filter");
await page.keyboard.type("order");
await page.waitForTimeout(100);
check((await page.$$("[data-ag-table]")).length === 2, "the filter leaves the matching tables");
await page.click("[data-ag-all-tables]");
await waitSaves(4);
saved = await lastSave();
check(saved.mcp_access.orders.tables.includes("public.orders") && !saved.mcp_access.orders.tables.includes("public.events"), "All tables ticks only the filtered ones");
await shot("3-filtered");
await page.fill("[data-ag-table-filter]", "");

// 5. There is no Only ticked | All but unticked switch (2026-10-14).
check(!(await page.$("[data-ag-mode]")), "no mode switch over the tables");

// 6. Ticking a database shares it with every table in it (an allow list), and lists them.
await page.click('[data-ag-db-tick="billing"]');
await waitSaves(5);
saved = await lastSave();
check(
  saved.mcp_access.billing.mode === "picked" && saved.mcp_access.billing.tables.length === 9,
  `a ticked database ticks all its tables: ${JSON.stringify(saved.mcp_access.billing)}`,
);
check((await page.getAttribute('[data-ag-db="billing"]', "data-picked")) !== null, "and shows its tables");
check((await page.textContent('[data-testid="ag-table-count"]')) === "9 of 9", "Tables: 9 of 9");
await shot("4-two-databases");

// 7. Esc goes back to the cards, not out of Settings.
await page.keyboard.press("Escape");
await page.waitForSelector('[data-testid="mcp-editor"]', { state: "detached" });
check(!!(await page.$('[data-testid="settings-page"] [data-testid="mcp-map"]')), "Esc closes Edit access and shows the cards again");
const sub = await page.textContent('[data-mcp-conn="api"] [data-testid="mcp-cn-sub"]');
check(/billing, orders/.test(sub), `the card names the shared databases: ${sub}`);

// 8. A connection saved before the map: every database, minus its hidden tables.
check(/Every database · all but 1 table/.test(await page.textContent('[data-mcp-conn="ops"] [data-testid="mcp-cn-sub"]')), "an old connection reads as every database minus its hidden table");
// Until its databases are listed it can't be ticked: a tick then would save
// only the picked database and unshare the others.
await page.evaluate(() => (window.__FAIL_DBS__ = true));
const closes = () => page.evaluate(() => window.__ROWKERY_CALLS__.filter(([c]) => c === "mcp_pick_close").length);
const closed = await closes();
await page.click('[data-mcp-edit="ops"]');
await page.waitForSelector('[data-mcp-editor="ops"] [data-ag-table="public.api_keys"]');
await page.waitForSelector('[data-mcp-editor="ops"] .ag-error'); // Class on purpose: the error line.
const stuck = (await saves()).length;
check(await page.$eval('[data-ag-table="public.events"]', (b) => b.disabled), "with its databases not listed, tables can't be ticked");
await page.click('[data-ag-table="public.events"]', { force: true });
await page.waitForTimeout(150);
check((await saves()).length === stuck, "and a click saves nothing");
await page.click("[data-mcp-done]");
await page.waitForFunction((n) => window.__ROWKERY_CALLS__.filter(([c]) => c === "mcp_pick_close").length > n, closed);
check(true, "Done closes the picker's sessions");
await page.evaluate(() => (window.__FAIL_DBS__ = false));
await page.click('[data-mcp-edit="ops"]');
await page.waitForSelector('[data-mcp-editor="ops"] [data-ag-table="public.api_keys"]');
await page.waitForSelector('[data-mcp-editor="ops"] [data-ag-db-tick="analytics"]');
check((await page.$$('[data-ag-db-tick][aria-checked="true"]')).length === 4, "every database shows ticked");
check((await page.getAttribute('[data-ag-table="public.api_keys"]', "aria-checked")) === "false", "its hidden table shows unticked");
const before = (await saves()).length;
await page.click('[data-ag-db-tick="analytics"]');
await waitSaves(before + 1);
saved = await lastSave();
check(
  JSON.stringify(Object.keys(saved.mcp_access).sort()) === JSON.stringify(["billing", "ops", "orders"]) &&
    saved.mcp_access.ops.mode === "all" &&
    saved.mcp_access.ops.tables[0] === "public.api_keys",
  `the first change writes the map as it was, minus that database: ${JSON.stringify(saved.mcp_access)}`,
);
await page.click("[data-mcp-done]");

// 9. Sharing a connection: its own database, Edit access open, its tables ticked once listed.
await page.click('[data-mcp-allow="prd"]');
await page.waitForSelector('[data-mcp-editor="prd"]');
saved = (await saves()).filter((c) => c.id === "prd")[0];
check(saved.allow_mcp && JSON.stringify(saved.mcp_access) === JSON.stringify({ orders: { mode: "picked", tables: [] } }), "turning sharing on shares the own database, nothing until its tables are listed");
await page.waitForFunction(
  () => window.__ROWKERY_CALLS__.filter(([c, a]) => c === "save_connection" && a.connection.id === "prd").length >= 2,
  null,
  { timeout: 4000 },
);
saved = (await saves()).filter((c) => c.id === "prd").at(-1);
check(saved.mcp_access.orders.mode === "picked" && saved.mcp_access.orders.tables.length === 9, "then every table in it is ticked");
await page.click("[data-mcp-done]");
await page.waitForFunction(() => /9 of 9 tables/.test(document.querySelector('[data-mcp-conn="prd"] [data-testid="mcp-cn-sub"]')?.textContent ?? ""));
check(true, "the card says 9 of 9 tables");
// Reopening Edit access later doesn't tick anything again.
await page.click('[data-mcp-edit="prd"]');
await page.waitForSelector('[data-mcp-editor="prd"] [data-ag-table="public.events"]');
await page.click('[data-ag-table="public.events"]');
await page.click("[data-mcp-done]");
const kept = (await saves()).length;
await page.click('[data-mcp-edit="prd"]');
await page.waitForSelector('[data-mcp-editor="prd"] [data-ag-table="public.events"]');
await page.waitForTimeout(200);
check((await saves()).length === kept && (await page.getAttribute('[data-ag-table="public.events"]', "aria-checked")) === "false", "reopening Edit access keeps an unticked table unticked");
await page.click("[data-mcp-done]");

// 10. Dark.
await page.evaluate(() => document.documentElement.setAttribute("data-theme", "dark"));
await page.click('[data-mcp-edit="api"]');
await page.waitForSelector('[data-mcp-editor="api"] [data-ag-table="public.orders"]');
await shot("5-edit-access-dark");
await page.keyboard.press("Escape");
await page.waitForSelector('[data-testid="mcp-map"]');
await page.click("[data-ag-can-do]");
await page.waitForSelector('[data-testid="ag-can-do"]');
await shot("7-can-do-dark");
await page.keyboard.press("Escape");
await page.waitForSelector('[data-testid="ag-can-do"]', { state: "detached" });
await page.waitForFunction(() => document.activeElement?.matches('[data-testid="settings-page"]'));
check(true, "focus comes back to the page when the sheet closes");
await page.keyboard.press("Escape");
await page.waitForSelector('[data-testid="settings-page"]', { state: "detached" });
await page.keyboard.press("Control+Shift+A");
await page.waitForSelector('[data-testid="mcp-detail"]');
await shot("6-log-dark");

await browser.close();
if (failed) {
  console.error(`${failed} check(s) failed`);
  process.exit(1);
}
