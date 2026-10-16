#!/usr/bin/env node
// Tab reorder proof without a Tauri webview or Postgres: serves the Vite
// frontend with a stubbed Tauri `invoke`, drags window pills along the
// title bar (`[data-testid="win-tab"][data-reorder-key]`) and query tabs sideways to new places
// (mid-drag frames captured), checks ⌘1–9 follow the new order, the window
// order survives a relaunch, Esc cancels a drag, a short drag swaps, a press
// that never moves stays a click, and close buttons are not drag handles.
// The sliding thumb is checked on the query tabs; the connection chip lives
// in the panel head, off any drag handle.
//
//   cd apps/rowkery-tauri && npx vite --port 1420 &
//   node scripts/tab-reorder-browser-proof.mjs [outDir]
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

const OUT = process.argv[2] ?? "/tmp/rowkery-proof/tab-reorder";
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
// Seed four windows before the app first loads (once; relaunches keep what it saved).
await page.addInitScript(() => {
  if (sessionStorage.getItem("seeded")) return;
  sessionStorage.setItem("seeded", "1");
  localStorage.clear();
  localStorage.setItem(
    "rowkery.windows",
    JSON.stringify({
      windows: [
        { connectionId: "prd", database: "wallet" },
        { connectionId: "stg", database: "wallet" },
        { connectionId: "local", database: "rowkery" },
        { connectionId: "cache", database: "main" },
      ],
      active: 0,
    }),
  );
});
await page.goto(URL);
await page.waitForSelector(`[data-testid="workspace"]:not([hidden])[data-conn-state="connected"]`);
await page.waitForTimeout(300);

const shot = async (name, clip) => {
  await page.waitForTimeout(80);
  await page.screenshot({ path: `${OUT}/${name}.png`, clip });
  console.log(`${OUT}/${name}.png`);
};
const check = (cond, msg) => {
  if (!cond) {
    console.error(`FAIL: ${msg}`);
    process.exitCode = 1;
  } else console.log(`ok: ${msg}`);
};
const visible = '[data-testid="workspace"]:not([hidden])';
const top = { x: 0, y: 0, width: 220, height: 400 };
const envOrder = () =>
  page.$$eval('[data-testid="win-tab"][data-reorder-key]', (els) => els.map((e) => e.getAttribute("data-env")).join(","));
const tabTitles = () =>
  page.$$eval(`${visible} [data-testid="query-tab"][data-reorder-key] [data-testid="query-tab-title"]`, (els) =>
    els.map((e) => e.textContent).join(","),
  );
const centre = async (loc) => {
  const b = await loc.boundingBox();
  return { x: b.x + b.width / 2, y: b.y + b.height / 2 };
};

check((await envOrder()) === "prd,stg,local,", "four windows restored in order");

// 1. A press that never moves stays a click: selects stg, order unchanged.
const stgTab = page.locator('[data-testid="win-tab"][data-env="stg"]');
let p = await centre(stgTab);
await page.mouse.click(p.x, p.y);
await page.waitForTimeout(200);
check((await page.getAttribute('[data-testid="win-tab"][data-on]', "data-env")) === "stg", "click selects the stg window");
check((await envOrder()) === "prd,stg,local,", "click leaves the order alone");

// 2. Drag stg past local: neighbours slide mid-drag, the order commits on drop.
p = await centre(stgTab);
const localBox = await page.locator('[data-testid="win-tab"][data-env="local"]').boundingBox();
const stgBox = await stgTab.boundingBox();
// Past halfway over local, well short of analytics-cache (across the title bar).
const stgDx = localBox.x + localBox.width * 0.75 - (stgBox.x + stgBox.width);
await page.mouse.move(p.x, p.y);
await page.mouse.down();
for (let i = 1; i <= 10; i++) {
  await page.mouse.move(p.x + (stgDx * i) / 10, p.y);
  await page.waitForTimeout(16);
}
await page.waitForTimeout(200);
await shot("1-window-dragging", top);
check(
  // Class on purpose: .reordering is the class that slides the neighbours (the motion under test).
  (await page.$eval('[data-testid="win-tabs"]', (e) => e.classList.contains("reordering"))),
  "track is in reordering mode mid-drag",
);
await page.mouse.up();
await page.waitForTimeout(250);
check((await envOrder()) === "prd,local,stg,", "stg dropped after local");
check((await page.getAttribute('[data-testid="win-tab"][data-on]', "data-env")) === "stg", "dragged window stays active");
await shot("2-window-dropped", top);

// 3. ⌘1–9 follow the new order.
await page.keyboard.press("Control+2");
await page.waitForTimeout(150);
check((await page.getAttribute('[data-testid="win-tab"][data-on]', "data-env")) === "local", "⌘2 is now the local window");
await page.keyboard.press("Control+3");
await page.waitForTimeout(150);
check((await page.getAttribute('[data-testid="win-tab"][data-on]', "data-env")) === "stg", "⌘3 is now the stg window");

// 4. Esc mid-drag puts the tabs back.
p = await centre(page.locator('[data-testid="win-tab"][data-env="prd"]'));
await page.mouse.move(p.x, p.y);
await page.mouse.down();
for (let i = 1; i <= 8; i++) {
  await page.mouse.move(p.x + 30 * i, p.y);
  await page.waitForTimeout(16);
}
await page.keyboard.press("Escape");
await page.mouse.up();
await page.waitForTimeout(250);
check((await envOrder()) === "prd,local,stg,", "Esc cancels the drag");

// 4b. A short drag swaps: the leading edge only has to reach halfway over
//     the neighbour (sideways, for window pills and query tabs alike).
const shortDrag = async (loc, neighbour, axis = "x") => {
  const p0 = await centre(loc);
  const nb = await neighbour.boundingBox();
  const me = await loc.boundingBox();
  const d =
    axis === "x" ? nb.x + nb.width / 2 - (me.x + me.width) + 6 : nb.y + nb.height / 2 - (me.y + me.height) + 6;
  await page.mouse.move(p0.x, p0.y);
  await page.mouse.down();
  for (let i = 1; i <= 6; i++) {
    const k = (d * i) / 6;
    await page.mouse.move(axis === "x" ? p0.x + k : p0.x, axis === "x" ? p0.y : p0.y + k);
    await page.waitForTimeout(16);
  }
  await page.mouse.up();
  await page.waitForTimeout(250);
  return Math.round(d);
};
const moved = await shortDrag(page.locator('[data-testid="win-tab"][data-env="prd"]'), page.locator('[data-testid="win-tab"][data-env="local"]'), "x");
check((await envOrder()) === "local,prd,stg,", `the pill swaps after a ${moved}px drag across`);
check((await page.getAttribute('[data-testid="win-tab"][data-on]', "data-env")) === "prd", "pressing a tile to drag it makes it active");

// 6. Query tabs: add two, drag the last to the front.
await page.keyboard.press("Control+1");
await page.waitForSelector(`${visible}[data-conn-state="connected"]`);
await page.click(`${visible} [data-testid="query-tab-add"]`);
await page.click(`${visible} [data-testid="query-tab-add"]`);
await page.waitForTimeout(250);
check((await tabTitles()) === "Query 1,Query 2,Query 3", "three query tabs");
const q3 = page.locator(`${visible} [data-testid="query-tab"][data-title="Query 3"]`);
const q1Box = await page.locator(`${visible} [data-testid="query-tab"][data-title="Query 1"]`).boundingBox();
p = await centre(q3);
await page.mouse.move(p.x, p.y);
await page.mouse.down();
for (let i = 1; i <= 10; i++) {
  await page.mouse.move(p.x + ((q1Box.x + 4 - p.x) * i) / 10, p.y);
  await page.waitForTimeout(16);
}
await page.waitForTimeout(200);
const edClip = await page.locator(`${visible} [data-testid="editor-header"]`).boundingBox();
await shot("3-query-tab-dragging", { x: edClip.x - 8, y: edClip.y - 8, width: 700, height: edClip.height + 16 });
await page.mouse.up();
await page.waitForTimeout(250);
check((await tabTitles()) === "Query 3,Query 1,Query 2", "Query 3 moved to the front");
check(
  (await page.textContent(`${visible} [data-testid="query-tab"][data-on] [data-testid="query-tab-title"]`)) === "Query 3",
  "dragged query tab is selected",
);
const thumb = await page.locator(`${visible} [data-testid="query-tab-thumb"]`).boundingBox();
const on = await page.locator(`${visible} [data-testid="query-tab"][data-on]`).boundingBox();
check(Math.abs(thumb.x - on.x) < 1.5, `thumb sits under the active query tab after the drop (${thumb.x} vs ${on.x})`);
await shot("4-query-tab-dropped", { x: edClip.x - 8, y: edClip.y - 8, width: 700, height: edClip.height + 16 });

// 7. Close buttons are not drag handles.
const q2 = page.locator(`${visible} [data-testid="query-tab"][data-title="Query 2"]`);
await q2.hover();
await q2.locator('[data-testid="query-tab-close"]').click();
await page.waitForTimeout(300);
check((await tabTitles()) === "Query 3,Query 1", "close button still closes");

// 7b. Same for query tabs.
const qMoved = await shortDrag(
  page.locator(`${visible} [data-testid="query-tab"][data-title="Query 3"]`),
  page.locator(`${visible} [data-testid="query-tab"][data-title="Query 1"]`),
);
check((await tabTitles()) === "Query 1,Query 3", `query tab swaps after a ${qMoved}px drag`);

// 8. The window order survives a relaunch.
await page.reload();
await page.waitForSelector(`${visible}[data-conn-state="connected"]`);
await page.waitForTimeout(200);
check((await envOrder()) === "local,prd,stg,", "window order restored after relaunch");

await browser.close();
