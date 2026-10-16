#!/usr/bin/env node
// commands.ts registry proof (stubbed `invoke`, no webview or Postgres): ⌘K
// lists exactly the commands whose `canRun` holds, with the keycaps the
// registry formats, and a macOS menu bar pick (`rowkery:command`, see main.tsx)
// runs the same command as ⌘K. Asserts on data-* attributes only.
//
//   cd apps/rowkery-tauri && npx vite --port 1420 &
//   node scripts/commands-browser-proof.mjs [outDir]
//
// Needs the `playwright` package (global install is fine) and Chromium.
import { createRequire } from "node:module";
import { mkdirSync } from "node:fs";
import { execSync } from "node:child_process";

const LINUX_PLATFORM = new globalThis.URL("./lib/linux-platform.js", import.meta.url).pathname;

const require = createRequire(import.meta.url);
let playwright;
try {
  playwright = require("playwright");
} catch {
  const root = execSync("npm root -g").toString().trim();
  playwright = require(`${root}/playwright`);
}

const OUT = process.argv[2] ?? "/tmp/rowkery-proof/commands";
const URL = process.env.ROWKERY_DEV_URL ?? "http://localhost:1420/";
mkdirSync(OUT, { recursive: true });

function stubTauri() {
  const col = (name, type_name) => ({ name, type_name, nullable: true });
  const table = (name, rows, cols, partition_of = null) => ({
    name,
    columns: cols.map(([n, t]) => col(n, t)),
    primary_key: ["id"],
    indexes: [],
    row_estimate: { Approximate: rows },
    partition_of,
  });
  const walletCols = [
    ["id", "int8"],
    ["player_id", "text"],
    ["wallet_id", "text"],
    ["amount_cents", "int8"],
    ["currency", "text"],
    ["created_at", "timestamptz"],
  ];
  const tables = [
    table("active_players", 48210, [
      ["id", "int4"],
      ["nickname", "text"],
      ["last_seen_at", "timestamptz"],
    ]),
    {
      name: "api_keys",
      columns: [
        { name: "id", type_name: "bigint", nullable: false, default: "nextval('api_keys_id_seq'::regclass)" },
        { name: "key", type_name: "character varying(128)", nullable: false },
        { name: "entity_name", type_name: "character varying(64)", nullable: false },
        { name: "remarks", type_name: "text", nullable: true },
        { name: "is_active", type_name: "boolean", nullable: false, default: "true" },
        { name: "created_at", type_name: "timestamp(0) without time zone", nullable: true },
        { name: "updated_at", type_name: "timestamp(0) without time zone", nullable: true },
      ],
      primary_key: ["id"],
      indexes: [
        { name: "api_keys_pkey", columns: ["id"], unique: true, primary: true, method: "btree", size_bytes: 16384, scans: 0 },
        { name: "api_keys_entity_name_index", columns: ["entity_name"], unique: false, method: "btree", size_bytes: 16384, scans: 0 },
        { name: "api_keys_key_unique", columns: ["key"], unique: true, method: "btree", size_bytes: 16384, scans: 0 },
      ],
      foreign_keys: [],
      row_estimate: { Approximate: 1 },
      table_bytes: 8192,
      index_bytes: 49152,
      partition_of: null,
    },
    {
      name: "kiosk_sessions",
      columns: [
        { name: "id", type_name: "bigint", nullable: false },
        { name: "api_key_id", type_name: "bigint", nullable: false },
        { name: "started_at", type_name: "timestamp with time zone", nullable: false, default: "now()" },
      ],
      primary_key: ["id"],
      indexes: [
        { name: "kiosk_sessions_pkey", columns: ["id"], unique: true, primary: true, method: "btree", size_bytes: 8192, scans: 12 },
      ],
      foreign_keys: [
        { name: "kiosk_sessions_api_key_fk", columns: ["api_key_id"], ref_schema: "public", ref_table: "api_keys", ref_columns: ["id"], on_delete: "CASCADE" },
      ],
      row_estimate: { Approximate: 830 },
      table_bytes: 65536,
      index_bytes: 16384,
      partition_of: null,
    },
    table("failed_jobs", 1204, [
      ["id", "int8"],
      ["queue", "text"],
      ["payload", "jsonb"],
      ["failed_at", "timestamptz"],
      ["exception", "text"],
    ]),
    table("webhooks", 3380, [
      ["id", "int8"],
      ["url", "text"],
      ["last_failure", "text"],
      ["fail_count", "int4"],
    ]),
    table("game_wallet_transactions", 0, walletCols),
    ...Array.from({ length: 4 }, (_, i) =>
      table(`game_wallet_transactions_p${i}`, 2_400_000, walletCols, "game_wallet_transactions"),
    ),
    table("payouts", 91_550, [
      ["id", "int8"],
      ["player_id", "text"],
      ["status", "text"],
      ["paid_at", "timestamptz"],
    ]),
  ];
  const catalog = {
    databases: [{ name: "rowkery", schemas: [{ name: "public", tables }] }],
  };
  const connections = [
    {
      kind: "postgres",
      id: "pg-docker-test",
      name: "kioskuno-wallet",
      host: "127.0.0.1",
      port: 54329,
      database: "rowkery",
      username: "rowkery",
    },
    { kind: "sqlite", id: "local", name: "local-cache", path: "~/cache.db" },
  ];
  const now = Date.now();
  localStorage.setItem(
    "rowkery.history.pg-docker-test",
    JSON.stringify([
      { sql: "SELECT * FROM payouts WHERE status = 'failed' ORDER BY paid_at DESC;", at: now - 3 * 864e5 },
      { sql: "SELECT queue, count(*) FROM failed_jobs GROUP BY 1;", at: now - 42 * 60e3 },
    ]),
  );
  const result = {
    columns: [
      { name: "id", type_name: "int8" },
      { name: "queue", type_name: "text" },
      { name: "failed_at", type_name: "timestamptz" },
    ],
    rows: Array.from({ length: 24 }, (_, i) => [
      { Int: 9000 + i },
      { Text: i % 3 ? "emails" : "payouts" },
      { Text: `2026-09-26 0${i % 10}:1${i % 6}:00+00` },
    ]),
    row_count: 24,
    elapsed_ms: 12,
    error: null,
    cancelled: false,
  };
  window.__ROWKERY_CALLS__ = [];
  window.__TAURI_INTERNALS__ = {
    metadata: { currentWindow: { label: "main" }, currentWebview: { label: "main" } },
    transformCallback: () => 0,
    invoke: async (cmd, args) => {
      window.__ROWKERY_CALLS__.push([cmd, args]);
      switch (cmd) {
        case "list_connections":
          return { connections, active_connection_id: null };
        case "open_window":
          return { database: args.database ?? "wallet", catalog, elapsed_ms: 9 };
        case "list_databases":
          return [];
        case "browse_table_sql":
          return `SELECT * FROM ${args.schema}.${args.table} LIMIT 100;`;
        case "run_query":
          return result;
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
await page.addInitScript({ path: LINUX_PLATFORM });
await page.addInitScript(stubTauri);
await page.goto(URL);
const visible = '[data-testid="workspace"]:not([hidden])';
await page.waitForSelector('[data-testid="workspace"]:not([hidden])'); // Paper (2026-10-10): an empty window shows no connection chip (no tab row without a connection); wait for the window, then ⇧⌘O as before.

const shot = async (name) => {
  await page.waitForTimeout(250);
  await page.screenshot({ path: `${OUT}/${name}.png` });
  console.log(`${OUT}/${name}.png`);
};
const check = (cond, msg) => {
  if (!cond) {
    console.error(`FAIL: ${msg}`);
    process.exitCode = 1;
  } else console.log(`ok: ${msg}`);
};
/** ⌘K command rows: id → keycap text ("" when none). */
const commandRows = () =>
  page.$$eval('[data-item^="cmd:"]', (els) =>
    Object.fromEntries(els.map((e) => [e.dataset.item.slice(4), e.querySelector("[data-keys]")?.textContent ?? ""])),
  );
const openCommands = async () => {
  await page.keyboard.press("Control+k");
  await page.waitForSelector('[data-testid="cp-panel"]');
  await page.keyboard.type(">");
};
const closePalette = async () => {
  await page.keyboard.press("Escape");
  await page.keyboard.press("Escape");
  await page.waitForSelector('[data-testid="cp-panel"]', { state: "detached" });
};

// 1. Before connecting: nothing that needs a connection.
await openCommands();
let rows = await commandRows();
await shot("1-disconnected");
check(!("run" in rows) && !("refresh-schema" in rows), "no Run or Refresh schema while disconnected");
check(rows["new-connection"] === "Ctrl+N", `New connection… shows Ctrl+N (${rows["new-connection"]})`);
await closePalette();

// Connect with Ctrl+Shift+O → Enter.
await page.keyboard.press("Control+Shift+O");
await page.waitForSelector('[data-testid="conn-popover"]');
await page.keyboard.press("Enter");
await page.waitForSelector(`${visible}[data-conn-state="connected"]`);
await page.waitForTimeout(300);

// 2. Connected, one query tab: the registry's Linux / Windows keycaps.
await openCommands();
rows = await commandRows();
await shot("2-connected");
const want = {
  run: "Ctrl+↵",
  // Run all statements has a key since 2026-10-07 (⌥⌘↵, Ctrl+Alt+↵ here).
  "run-all": "Ctrl+Alt+↵",
  "close-tab": "Ctrl+W",
  "filter-schema": "/",
  "toggle-sidebar": "Ctrl+B",
  "switch-connection": "Ctrl+Shift+O",
  "switch-database": "Ctrl+Shift+D",
  "new-window": "Ctrl+T",
  "refresh-schema": "Ctrl+R",
};
for (const [id, keys] of Object.entries(want)) {
  check(rows[id] === keys, `${id} listed with "${keys}" (got ${JSON.stringify(rows[id])})`);
}
check(!("cancel" in rows), "no Cancel while nothing runs");
check(!("next-tab" in rows) && !("close-window" in rows), "no tab or window cycling with one of each");
check(!("refresh" in rows), "no Refresh rows on a query tab");
await closePalette();

// 3. A menu bar pick runs the same command: New query tab via ⌘K, then
// File > Close Tab and Help > Report an Issue… as `rowkery:command`.
const tabCount = () => page.$$eval(`${visible} [data-reorder-key]`, (els) => els.length);
const before = await tabCount();
await openCommands();
await page.keyboard.type("new query tab");
await page.keyboard.press("Enter");
await page.waitForTimeout(250);
check((await tabCount()) === before + 1, `⌘K New query tab adds a tab (${before} → ${await tabCount()})`);
await page.evaluate(() => window.dispatchEvent(new CustomEvent("rowkery:command", { detail: "close-tab" })));
await page.waitForTimeout(400);
check((await tabCount()) === before, `menu Close Tab closes it (${await tabCount()})`);
await page.evaluate(() => window.dispatchEvent(new CustomEvent("rowkery:command", { detail: "report-issue" })));
const sheet = await page.waitForSelector('[role="dialog"][aria-label="Report an issue"]', { timeout: 2000 }).catch(() => null);
check(!!sheet, "menu Report an Issue… opens the report sheet");
await shot("3-report-from-menu");

await browser.close();
