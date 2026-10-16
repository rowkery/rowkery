#!/usr/bin/env node
// ⌘K kinds proof (stubbed `invoke`, no webview or Postgres): group headers
// print their scope prefix, synonyms find commands, picks are counted
// (config.json's `rowkery.commandUses`, mirrored to localStorage) and the most
// used lead the empty list, a pasted postgres:// URL or SQLite path is the
// first row and opens the filled sheet / the file (once core says the file
// is there; a missing one saves nothing), and All tables as rows
// opens the catalog as a result. Asserts on data-* attributes only.
//
//   cd apps/rowkery-tauri && npx vite --port 1420 &
//   node scripts/palette-kinds-browser-proof.mjs [outDir]
//
// Needs the `playwright` package (global install is fine) and Chromium.
import { createRequire } from "node:module";
import { mkdirSync } from "node:fs";
import { execSync } from "node:child_process";

const FRAMES_SHIM = new globalThis.URL("./lib/frames-shim.js", import.meta.url).pathname;

const require = createRequire(import.meta.url);
let playwright;
try {
  playwright = require("playwright");
} catch {
  playwright = require(`${execSync("npm root -g").toString().trim()}/playwright`);
}

const OUT = process.argv[2] ?? "/tmp/rowkery-proof/palette-kinds";
const URL = process.env.ROWKERY_DEV_URL ?? "http://localhost:1420/";
mkdirSync(OUT, { recursive: true });

function stubTauri() {
  const table = (name, rows, extra = {}) => ({
    name,
    columns: [
      { name: "id", type_name: "int8", nullable: false },
      { name: "note", type_name: "text", nullable: true },
    ],
    primary_key: ["id"],
    indexes: [],
    foreign_keys: [],
    row_estimate: { Approximate: rows },
    partition_of: null,
    table_bytes: 8192,
    index_bytes: 8192,
    ...extra,
  });
  const tables = [
    table("wallet_tx", 48_200),
    table("wallets", 12_400),
    table("events", 0),
    table("events_p0", 900, { partition_of: "events" }),
    table("wallet_balances", 0, { kind: "view" }),
  ];
  const catalog = { databases: [{ name: "wallet", schemas: [{ name: "public", tables }] }] };
  const connections = [
    { kind: "postgres", id: "pg", name: "wallet-local", host: "127.0.0.1", port: 54329, database: "wallet", username: "rowkery" },
  ];
  localStorage.setItem(
    "rowkery.history.pg",
    JSON.stringify([{ sql: "SELECT * FROM wallets;", at: Date.now() - 60e3 }]),
  );
  const small = { columns: [{ name: "x", type_name: "int4" }], rows: [[{ Int: 1 }]], row_count: 1, elapsed_ms: 1, error: null, cancelled: false };
  window.__ROWKERY_CALLS__ = [];
  window.__TAURI_INTERNALS__ = {
    metadata: { currentWindow: { label: "main" }, currentWebview: { label: "main" } },
    transformCallback: () => 0,
    invoke: async (cmd, args) => {
      window.__ROWKERY_CALLS__.push([cmd, args]);
      switch (cmd) {
        // ⌘K checks a typed SQLite path names a file before saving it.
        case "sqlite_file_exists":
          return args.path === "~/dev/app/dev.sqlite";
        case "list_connections":
          return { connections, active_connection_id: null };
        case "open_window":
          return { database: "wallet", catalog, elapsed_ms: 3, server_version: "PostgreSQL 16.4" };
        case "list_databases":
          return [];
        case "browse_table_sql":
          return `SELECT * FROM ${args.schema}.${args.table} LIMIT 100;`;
        case "run_query":
          return small;
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
const visible = '[data-testid="workspace"]:not([hidden])';
await page.waitForSelector('[data-testid="workspace"]:not([hidden])'); // Paper (2026-10-10): an empty window shows no connection chip (no tab row without a connection); wait for the window, then ⇧⌘O as before.
await page.keyboard.press("Control+Shift+O");
await page.waitForSelector('[data-testid="conn-popover"]');
await page.keyboard.press("Enter");
await page.waitForSelector(`${visible}[data-conn-state="connected"]`);
await page.waitForTimeout(300);

let failed = 0;
const check = (cond, msg) => {
  if (!cond) {
    failed++;
    console.error(`FAIL: ${msg}`);
  } else console.log(`ok: ${msg}`);
};
const shot = async (name) => {
  await page.waitForTimeout(150);
  await page.screenshot({ path: `${OUT}/${name}.png` });
  console.log(`${OUT}/${name}.png`);
};
const openPalette = async (text = "") => {
  // A closing palette plays its exit first.
  await page.waitForSelector('[data-closing] [data-testid="cp-panel"]', { state: "detached" });
  if (!(await page.$('[data-testid="cp-panel"]'))) await page.keyboard.press("Control+k");
  await page.waitForSelector('[data-testid="cp-panel"]');
  await page.fill('[data-testid="cp-search"] input', text);
  await page.waitForTimeout(50);
};
const closePalette = async () => {
  await page.keyboard.press("Escape");
  await page.keyboard.press("Escape");
  await page.waitForSelector('[data-testid="cp-panel"]', { state: "detached" });
};
const activeItem = () => page.$eval('[data-testid="cp-row"][aria-selected="true"]', (e) => e.dataset.item).catch(() => null);

// 1. Group headers print their scope prefix; Connections has none.
await openPalette("wal");
const headers = await page.$$eval('[data-testid="cp-group"]', (els) =>
  els.map((e) => [e.dataset.group, e.querySelector("[data-prefix]")?.dataset.prefix ?? null]),
);
const prefixOf = Object.fromEntries(headers);
check(prefixOf.tables === "t:", `Tables prints t: (${JSON.stringify(headers)})`);
check(prefixOf.queries === "q:", "Recent queries prints q:");
check(prefixOf.connections === null, "Connections prints no prefix");
const prefixTitle = await page.getAttribute('[data-testid="cp-group"][data-group="tables"] [data-prefix]', "title");
check(prefixTitle === "Type t: to search only tables", `prefix tooltip (${prefixTitle})`);
await openPalette(">tab");
check((await page.getAttribute('[data-testid="cp-group"][data-group="commands"] [data-prefix]', "data-prefix")) === ">", "Commands prints >");
// The table index was built on idle and is there when ⌘K opens.
await openPalette("wallet_tx");
check((await activeItem()) === "t:wallet.public.wallet_tx", `the idle-built table index answers (${await activeItem()})`);
await shot("1-prefixes");

// 2. Synonyms.
for (const [q, id] of [
  ["help", "cmd:keyboard-shortcuts"],
  ["demo", "cmd:open-sample"],
  ["bug", "cmd:report-issue"],
  ["catalog", "cmd:all-tables"],
  ["readonly", "cmd:change-safe-mode"],
]) {
  await openPalette(`>${q}`);
  check((await activeItem()) === id, `"${q}" finds ${id} (${await activeItem()})`);
}
await openPalette("help");
const marks = await page.$$eval('[data-testid="cp-row"][aria-selected="true"] mark', (els) => els.length);
check(marks === 0, "a synonym hit highlights nothing in the title");
await shot("2-synonym-help");

// 3. All tables as rows: the catalog as a result, in a tab of its own.
await openPalette(">all tables");
await page.keyboard.press("Enter");
await page.waitForSelector(`${visible} [data-header="partition of"]`);
const headerNames = await page.$$eval(`${visible} [data-header]`, (els) => els.map((e) => e.dataset.header));
check(
  JSON.stringify(headerNames) === JSON.stringify(["name", "schema", "kind", "≈ rows", "size", "columns", "partition of", "comment"]),
  `All tables has the catalog columns (${headerNames.join(", ")})`,
);
const tabTitles = await page.$$eval(`${visible} [data-testid="query-tab-title"]`, (els) => els.map((e) => e.textContent));
check(tabTitles.includes("All tables"), `opens a tab named All tables (${tabTitles.join(", ")})`);
const meta = await page.textContent(`${visible} [data-testid="card-meta"] b`);
check(meta === "5 rows", `one row per table, partition and view (${meta})`);
const sql = await page.inputValue(`${visible} textarea[data-testid="sql-editor"]`);
check(sql === "-- 5 tables and views in wallet, from the catalog", `the editor holds the catalog line (${sql})`);
await shot("3-all-tables");

// 4. Frequency: picks are counted and persisted; the most used lead the empty list.
await openPalette("");
const emptyBefore = await page.$$eval('[data-testid="cp-row"][data-item^="cmd:"]', (els) => els.map((e) => e.dataset.item));
check(emptyBefore[0] === "cmd:all-tables", `the one command picked so far leads the empty list (${emptyBefore.slice(0, 3).join(", ")})`);
for (let i = 0; i < 2; i++) {
  await openPalette(">sidebar");
  await page.keyboard.press("Enter");
  await page.waitForTimeout(100);
}
await openPalette("");
const emptyAfter = await page.$$eval('[data-testid="cp-row"][data-item^="cmd:"]', (els) => els.map((e) => e.dataset.item));
check(
  emptyAfter[0] === "cmd:toggle-sidebar" && emptyAfter[1] === "cmd:all-tables",
  `the most used lead (${emptyAfter.slice(0, 3).join(", ")})`,
);
await closePalette();
await page.waitForTimeout(1200); // persist flushes within a second
const uses = await page.evaluate(() => JSON.parse(localStorage.getItem("rowkery.commandUses") ?? "{}"));
check(uses["all-tables"] === 1 && uses["toggle-sidebar"] === 2, `uses are saved (${JSON.stringify(uses)})`);
const saved = await page.evaluate(() =>
  window.__ROWKERY_CALLS__.some(([c, a]) => c === "save_ui_state" && a?.ui?.keys?.["rowkery.commandUses"]),
);
check(saved, "uses go to config.json through save_ui_state");
await shot("4-frequency");

// 5. A pasted postgres:// URL is the first row; ↵ opens the sheet filled.
await openPalette("postgres://alice@db.internal:5432/ledger?sslmode=require");
const lead = await page.$(`[data-testid="cp-row"][data-row='0']`);
check((await lead?.getAttribute("data-pasted")) === "connection-url", "a pasted URL leads as New connection from URL");
check(((await lead?.textContent()) ?? "").includes("db.internal/ledger"), "the row names host/database");
await shot("5-pasted-url");
await page.keyboard.press("Enter");
await page.waitForSelector('[data-testid="nc-sheet"]');
const host = await page.inputValue('[data-testid="nc-sheet"] [data-field="host"] input');
check(host === "db.internal", `the sheet opens filled from the URL (host ${host})`);
await page.keyboard.press("Escape");
await page.waitForSelector('[data-testid="nc-sheet"]', { state: "detached" });

// 6. A pasted SQLite path: ↵ saves a connection for that file.
await openPalette("~/dev/app/dev.sqlite");
check((await page.getAttribute(`[data-testid="cp-row"][data-row='0']`, "data-pasted")) === "sqlite-path", "a pasted .sqlite path leads as Open SQLite file");
await shot("6-pasted-path");
await page.keyboard.press("Enter");
await page.waitForTimeout(300);
const savedFile = await page.evaluate(() =>
  window.__ROWKERY_CALLS__.find(([c, a]) => c === "save_connection" && a.connection.kind === "sqlite")?.[1].connection,
);
check(savedFile?.path === "~/dev/app/dev.sqlite" && savedFile?.name === "dev", `↵ opens the file as a connection (${JSON.stringify(savedFile)})`);
const sqliteSaves = () =>
  page.evaluate(() => window.__ROWKERY_CALLS__.filter(([c, a]) => c === "save_connection" && a.connection.kind === "sqlite").length);
await openPalette("~/dev/app/typo.sqlite");
await page.keyboard.press("Enter");
await page.waitForTimeout(300);
check((await sqliteSaves()) === 1, "a path with no file there saves nothing");

// 7. Ordinary text has no pasted row.
await openPalette("wallets");
check(!(await page.$('[data-testid="cp-row"][data-pasted]')), "a table name gets no pasted row");
await closePalette();

await browser.close();
console.log(failed ? `${failed} failed` : "all ok");
process.exitCode = failed ? 1 : 0;
