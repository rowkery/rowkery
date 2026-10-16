#!/usr/bin/env node
// UX fixes proof with a stubbed Tauri `invoke` (no webview or Postgres):
// arrowing through a long database list keeps the cursor in view, a saved
// connection can be edited (pencil on hover, ⌘E on the highlighted row) and
// deleted in one step with an Undo toast, pins sort to the top of every picker
// (connection chip and the Connect to start list), and right-click shows no
// webview menu on app chrome. The delete confirm step was removed from the app
// (one step + Undo now), so its check became the Undo one.
//
//   cd apps/rowkery-tauri && npx vite --port 1420 &
//   node scripts/ux-fixes-browser-proof.mjs [outDir]
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

const OUT = process.argv[2] ?? "/tmp/rowkery-proof/ux-fixes";
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
          return Array.from({ length: 30 }, (_, i) => ({
            name: `tenant_${String(i + 1).padStart(2, "0")}`,
            size_bytes: 1_000_000 * (i + 1),
          }));
        case "save_connection": {
          const i = connections.findIndex((c) => c.id === args.connection.id);
          if (i >= 0) connections[i] = args.connection;
          else connections.push(args.connection);
          return null;
        }
        case "probe_connection":
          return { ok: true, message: "PostgreSQL 16.4", elapsed_ms: 3 };
        case "delete_connection": {
          const i = connections.findIndex((c) => c.id === args.id);
          if (i >= 0) connections.splice(i, 1);
          return null;
        }
        case "run_query": {
          const w = windows[args.windowId];
          return {
            columns: [
              { name: "window", type_name: "text" },
              { name: "current_database", type_name: "text" },
            ],
            rows: [[{ Text: `${w.conn.name} (${w.conn.environment})` }, { Text: w.database }]],
            row_count: 1,
            elapsed_ms: 4,
            error: null,
            cancelled: false,
          };
        }
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
const page = await browser.newPage({ viewport: { width: 1280, height: 800 }, deviceScaleFactor: 2 });
page.on("pageerror", (e) => console.error("pageerror:", e.message));
await page.addInitScript({ path: FRAMES_SHIM });
await page.addInitScript(stubTauri);
await page.goto(URL);
await page.evaluate(() => localStorage.clear());
await page.reload();
await page.waitForSelector('[data-testid="workspace"]:not([hidden])'); // Paper (2026-10-10): an empty window shows no connection chip (no tab row without a connection); wait for the window, then ⇧⌘O as before.

const shot = async (name, clip) => {
  await page.waitForTimeout(250);
  await page.screenshot({ path: `${OUT}/${name}.png`, clip });
  console.log(`${OUT}/${name}.png`);
};
const check = (cond, msg) => {
  if (!cond) {
    console.error(`FAIL: ${msg}`);
    process.exitCode = 1;
  } else console.log(`ok: ${msg}`);
};
const text = (sel) => page.textContent(sel).then((t) => t?.trim());
const visible = '[data-testid="workspace"]:not([hidden])';
const top = { x: 0, y: 0, width: 1280, height: 560 };
const cursorInView = (listSel) =>
  page.evaluate((sel) => {
    const list = document.querySelector(sel);
    const row = list.querySelector('[aria-selected="true"]');
    const l = list.getBoundingClientRect();
    const r = row.getBoundingClientRect();
    return { inView: r.top >= l.top - 0.5 && r.bottom <= l.bottom + 0.5, name: row.textContent };
  }, listSel);

await page.keyboard.press("Control+Shift+O");
await page.waitForSelector("[data-conn-id]");
await page.keyboard.press("Enter");
await page.waitForSelector(`${visible}[data-conn-state="connected"]`);

// 1. Arrowing down a 30-row database list keeps the cursor in view,
// even with the pointer resting over the list.
await page.keyboard.press("Control+Shift+D");
await page.waitForSelector('[data-testid="db-option"]');
const box = await page.locator('[data-testid="db-popover"] [data-testid="conn-list"]').boundingBox();
await page.mouse.move(box.x + box.width / 2, box.y + 60);
for (let i = 0; i < 24; i++) await page.keyboard.press("ArrowDown");
let v = await cursorInView('[data-testid="db-popover"] [data-testid="conn-list"]');
check(v.inView && v.name.includes("tenant_25"), `cursor on ${v.name} is scrolled into view`);
await shot("1-database-scrolled", top);
for (let i = 0; i < 20; i++) await page.keyboard.press("ArrowUp");
v = await cursorInView('[data-testid="db-popover"] [data-testid="conn-list"]');
check(v.inView && v.name.includes("tenant_05"), `arrowing up scrolls back (${v.name})`);
await page.keyboard.press("Escape");

// 2. Edit: pencil on hover in the connection picker, sheet prefilled.
await page.keyboard.press("Control+Shift+O");
await page.waitForSelector("[data-conn-id]");
await page.hover("[data-conn-id] >> nth=1");
check(await page.isVisible('[data-conn-id] >> nth=1 >> [data-testid="conn-edit"]'), "pencil shows on hover");
await shot("2-picker-edit-hover", top);
await page.click('[data-conn-id] >> nth=1 >> [data-testid="conn-edit"]');
await page.waitForSelector('[data-testid="nc-sheet"]');
check((await text('[data-testid="nc-title"]')) === "Edit connection", "sheet opens in edit mode");
check((await page.inputValue('[data-testid="nc-sheet"] [data-field="name"] input')) === "wallet", "name prefilled");
await page.fill('[data-testid="nc-sheet"] [data-field="name"] input', "wallet staging");
await shot("3-edit-sheet", { x: 0, y: 0, width: 1280, height: 800 });
await page.keyboard.press("Control+Enter");
await page.waitForSelector('[data-testid="nc-sheet"]', { state: "detached" });
const saved = await page.evaluate(() =>
  window.__ROWKERY_CALLS__.filter(([c]) => c === "save_connection").map(([, a]) => a),
);
check(saved.length === 1 && saved[0].connection.id === "stg" && saved[0].connection.name === "wallet staging", "saved under the same id");
check(!saved[0].secrets.db_password, "blank password keeps the stored one");

// 3. ⌘E on the highlighted row, then Delete: one step (no confirm), with Undo.
await page.keyboard.press("Control+Shift+O");
await page.waitForSelector("[data-conn-id]");
await page.keyboard.type("staging");
await page.keyboard.press("Control+e");
await page.waitForSelector('[data-testid="nc-sheet"]');
check((await page.inputValue('[data-testid="nc-sheet"] [data-field="name"] input')) === "wallet staging", "⌘E edits the highlighted row");
await page.click('[data-testid="nc-sheet"] [data-delete]');
await page.waitForSelector('[data-testid="nc-sheet"]', { state: "detached" });
await page.waitForSelector("[data-toast-undo]");
await shot("4-deleted-undo", { x: 0, y: 0, width: 1280, height: 800 });
const deleted = await page.evaluate(() =>
  window.__ROWKERY_CALLS__.filter(([c]) => c === "delete_connection").map(([, a]) => a.id),
);
check(deleted.join() === "stg", `deleted at once, Undo offered (${deleted.join()})`);
await page.keyboard.press("Control+Shift+O");
await page.waitForSelector("[data-conn-id]");
check(!(await text('[data-testid="conn-list"]')).includes("wallet staging"), "deleted connection gone from the picker");
await page.keyboard.press("Escape");

// 4. Pin: hover a row, click the pin, it moves to the top and stays there.
await page.keyboard.press("Control+Shift+O");
await page.waitForSelector("[data-conn-id]");
const names = () => page.$$eval('[data-conn-id] [data-testid="conn-option-name"]', (els) => els.map((e) => e.textContent));
const before = await names();
await page.hover("[data-conn-id] >> nth=2");
await page.click('[data-conn-id] >> nth=2 >> [data-testid="conn-pin"]');
let after = await names();
check(after[0] === before[2], `pinned ${before[2]} moved to the top`);
check((await text('[data-testid="conn-list"] [data-testid="conn-section"]')) === "Pinned", "Pinned heading above pinned rows");
check(
  await page.$eval('[data-testid="conn-divider"]', (d) => d.nextElementSibling?.querySelector('[data-testid="conn-option-name"]')?.textContent === "wallet"),
  "divider sits between pinned and the rest",
);
await shot("5-pinned", top);
check(
  (await page.$$eval('[data-conn-id] [data-testid="conn-engine"]', (t) => t.map((e) => e.title))).join() ===
    "SQLite,PostgreSQL,PostgreSQL",
  "each row shows its engine logo",
);
await page.keyboard.press("Escape");
// ⌘T opens an empty window: its Your connections list puts the pin first too.
await page.keyboard.press("Control+t");
await page.waitForSelector(`${visible} [data-saved-conn]`);
after = await page.$$eval(`${visible} [data-saved-conn] [data-testid="ew-saved-name"]`, (els) => els.map((e) => e.textContent));
check(after[0] === before[2], "pin applies in the Connect to start list too");
await page.keyboard.press("Control+Shift+w");
await page.waitForFunction(() => !document.querySelector('[data-testid="workspace"]:not([hidden]) [data-empty-window]'));

// 5. Right-click on chrome: default prevented; in the editor: allowed.
const prevented = (sel) =>
  page.evaluate((s) => {
    const el = document.querySelector(s);
    const ev = new MouseEvent("contextmenu", { bubbles: true, cancelable: true });
    return !el.dispatchEvent(ev);
  }, sel);
check(await prevented('[data-testid="conn-chip"]'), "right-click on the title chip shows no webview menu");
check(await prevented(`${visible} [data-testid="sb-scroll"]`), "right-click on the sidebar shows no webview menu");
check(!(await prevented(`${visible} [data-testid="sql-editor"]`)), "SQL editor keeps its native edit menu");

await browser.close();
