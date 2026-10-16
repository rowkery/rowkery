#!/usr/bin/env node
// Command palette proof without a Tauri webview or Postgres: serves the Vite
// frontend, stubs `window.__TAURI_INTERNALS__.invoke` with a canned catalog,
// drives ⌘K in Chromium and writes screenshots.
//
//   cd apps/rowkery-tauri && npx vite --port 1420 &
//   node scripts/palette-browser-proof.mjs [outDir]
//
// Needs the `playwright` package (global install is fine) and a Chromium it can
// launch (PLAYWRIGHT_BROWSERS_PATH or /opt/pw-browsers/chromium).
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

const OUT = process.argv[2] ?? "/tmp/rowkery-proof/command-palette";
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
await page.addInitScript({ path: FRAMES_SHIM });
await page.addInitScript(stubTauri);
await page.goto(URL);
await page.waitForSelector('[data-testid="workspace"]:not([hidden])'); // Paper (2026-10-10): an empty window shows no connection chip (no tab row without a connection); wait for the window, then ⇧⌘O as before.
// Connect with ⇧⌘O → Enter, like a user would.
await page.keyboard.press("Control+Shift+O");
await page.waitForSelector('[data-testid="conn-popover"]');
await page.keyboard.press("Enter");
await page.waitForSelector('[data-testid="sb-scroll"]');
await page.waitForTimeout(300);

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

await page.keyboard.press("Control+k");
await page.waitForSelector('[data-testid="cp-panel"]');
await shot("1-empty");

await page.keyboard.type("fail");
await shot("2-fail");
const first = await page.textContent('[data-testid="cp-row"][aria-selected="true"] [data-testid="cp-label"]');
check(first?.startsWith("public.failed_jobs"), `"fail" lands on the failed_jobs table (got ${first})`);
const groupNames = await page.$$eval('[data-testid="cp-group"]', (els) => els.map((e) => e.textContent));
check(!groupNames.includes("Columns"), `no Columns group (${groupNames.join(", ")})`);

await page.keyboard.press("Enter");
await page.waitForTimeout(300);
const tabTitles = await page.$$eval('[data-testid="query-tab-title"]', (els) => els.map((e) => e.textContent));
check(!(await page.$('[data-testid="cp-panel"]')), "Enter closes the palette");
check(tabTitles.includes("failed_jobs"), `Enter browses in a tab named after the table (${tabTitles.join(", ")})`);
await shot("3-browsed");

await page.keyboard.press("Control+k");
await page.keyboard.type(">tab");
await shot("4-commands-scoped");
const cmds = await page.$$eval('[data-testid="cp-row"] [data-testid="cp-label"]', (els) => els.map((e) => e.textContent));
check(cmds.every((c) => c?.toLowerCase().includes("tab")), `">" limits to commands (${cmds.join(", ")})`);

await page.keyboard.press("Escape"); // clears the query
await page.keyboard.press("Escape"); // closes
// The panel plays a short exit before it leaves the DOM.
const closedPanel = await page
  .waitForSelector('[data-testid="cp-panel"]', { state: "detached", timeout: 1000 })
  .then(() => true, () => false);
check(closedPanel, "Esc clears, then closes");

// A table tab has no editor until ⌘F opens the WHERE editor in its SQL line;
// ⌥↵ inserts at its caret.
check(!(await page.$('[data-testid="sql-editor"]')), "the table tab shows its SQL line, no editor");
await page.keyboard.press("Control+f");
await page.waitForSelector('[data-sql-line][data-editing] textarea[data-testid="sql-editor"]');
await page.keyboard.type("queue = ");
await page.keyboard.press("Control+k");
await page.keyboard.press("Tab");
await page.keyboard.type("pay");
await shot("5-tables-tab-scope");
const scope = await page.textContent('[data-testid="cp-scope"]');
check(scope === "Tables", `Tab scopes to Tables (${scope})`);
const before = await page.inputValue('[data-sql-line] [data-testid="sql-editor"]');
const picked = (await page.textContent('[data-testid="cp-row"][aria-selected="true"] [data-testid="cp-label"]')) ?? "";
const table = picked.slice(picked.lastIndexOf(".") + 1);
await page.keyboard.press("Alt+Enter");
await page.waitForTimeout(200);
const after = await page.inputValue('[data-sql-line] [data-testid="sql-editor"]');
check(
  after.length === before.length + table.length && after.includes(table),
  `Alt+Enter inserts "${table}" at the WHERE editor's caret (${JSON.stringify(after)})`,
);
await page.keyboard.press("Escape"); // drops the unapplied filter, closes the editor

await page.keyboard.press("Control+k");
await page.keyboard.type("api_k");
await page.keyboard.press("Control+Enter");
await page.waitForSelector('[data-testid="ts-root"]', { timeout: 3000 }).catch(() => {});
check(!!(await page.$('[data-testid="ts-root"]')), "Ctrl+Enter opens the table on Structure");
await page.evaluate(() => {
  // Give the results card most of the height for the screenshot.
  const card = document.querySelector('[data-testid="editor-card"]');
  if (card) card.style.flex = "0 0 18%";
});
await shot("6-structure");
await page.evaluate(() => {
  const root = document.querySelector('[data-testid="ts-root"]');
  if (root) root.scrollTop = root.scrollHeight;
});
await shot("7-structure-bottom");
await page.keyboard.press("Control+k");
await page.keyboard.type(">show");
const show = await page.$$eval('[data-testid="cp-row"] [data-testid="cp-label"]', (els) => els.map((e) => e.textContent));
check(show.includes("Show data"), `palette offers Show data (${show.join(", ")})`);
await page.keyboard.press("Enter");
await page.waitForTimeout(200);
check(!(await page.$('[data-testid="ts-root"]')), "Show data leaves Structure");

await browser.close();
