#!/usr/bin/env node
// Hover prefetch (stubbed `invoke` that counts calls, Linux keys).
//
// 1. Off by default: resting on a panel row asks nothing.
// 2. The connection sheet's Advanced section has the "Prefetch on hover"
//    switch, off; turning it on and saving keeps it for that connection.
// 3. With it on, 120 ms on a row sends one prefetch_table whose browse
//    arguments are exactly the ones the click then sends (so core's SQL, and
//    the cursor the click continues, match); passing over rows faster sends
//    nothing.
// 4. Never for a table with no primary key or unique index, a view, a
//    partitioned parent, or a table whose tab is already open.
// 5. One in flight: leaving the row cancels it (cancel_prefetch).
//
//   cd apps/rowkery-tauri && npx vite --port 1420 &
//   node scripts/prefetch-browser-proof.mjs [outDir]   (ROWKERY_DEV_URL for another port)
import { createRequire } from "node:module";
import { mkdirSync } from "node:fs";
import { execSync } from "node:child_process";

const LINUX_PLATFORM = new globalThis.URL("./lib/linux-platform.js", import.meta.url).pathname;

const require = createRequire(import.meta.url);
let playwright;
try {
  playwright = require("playwright");
} catch {
  playwright = require(`${execSync("npm root -g").toString().trim()}/playwright`);
}
const OUT = process.argv[2] ?? "/tmp/rowkery-proof/prefetch";
const URL = process.env.ROWKERY_DEV_URL ?? "http://localhost:1420/";
mkdirSync(OUT, { recursive: true });

function stubTauri() {
  if (!sessionStorage.getItem("seeded")) {
    localStorage.clear();
    localStorage.setItem("rowkery.windows", JSON.stringify({ windows: [{ connectionId: "pg", database: "arcade" }], active: 0 }));
    sessionStorage.setItem("seeded", "1");
  }
  const col = (name, type_name = "int8") => ({ name, type_name, nullable: true });
  const table = (name, extra = {}) => ({ name, kind: "table", columns: [col("id"), col("name", "text")], primary_key: ["id"], indexes: [], foreign_keys: [], row_estimate: { Approximate: 500 }, partition_of: null, ...extra });
  const tables = [
    table("players"),
    table("slow_scores"),
    table("events_log", { primary_key: [] }),
    table("codes", { primary_key: [], indexes: [{ name: "codes_name_key", columns: ["name"], unique: true }] }),
    table("leaderboard", { kind: "view", primary_key: [] }),
    table("events"),
    table("events_2026", { partition_of: "events" }),
  ];
  const connections = [{ kind: "postgres", id: "pg", name: "arcade", host: "db.internal", port: 5432, database: "arcade", username: "app" }];
  window.__CALLS__ = [];
  let nextId = 0;
  window.__TAURI_INTERNALS__ = {
    metadata: { currentWindow: { label: "main" }, currentWebview: { label: "main" } },
    transformCallback: () => 0,
    invoke: async (cmd, args) => {
      window.__CALLS__.push([cmd, args && JSON.parse(JSON.stringify({ ...args, onFrame: undefined }))]);
      switch (cmd) {
        case "list_connections":
          return { connections, active_connection_id: null };
        case "open_window":
          return { database: "arcade", catalog: { databases: [{ name: "arcade", schemas: [{ name: "public", tables }] }] }, elapsed_ms: 2, cached: false, open_seq: 1 };
        case "list_databases":
          return [];
        case "save_connection": {
          const i = connections.findIndex((c) => c.id === args.connection.id);
          if (i >= 0) connections[i] = args.connection;
          else connections.push(args.connection);
          return null;
        }
        case "probe_connection":
          return { ok: true, message: "PostgreSQL 16.4", elapsed_ms: 3 };
        case "prefetch_table":
          // A slow table stays in flight until the pointer leaves.
          if (args.table === "slow_scores") return new Promise((resolve) => (window.__PENDING_PREFETCH__ = resolve));
          return true;
        case "cancel_prefetch":
          window.__PENDING_PREFETCH__?.(false);
          return null;
        case "browse_table": {
          const queryId = ++nextId;
          setTimeout(() => {
            const send = (f) => args.onFrame.onmessage({ query_id: queryId, ...f });
            send({ t: "columns", columns: [{ name: "id", type_name: "int8" }, { name: "name", type_name: "text" }] });
            send({ t: "rows", seq: 0, rows: [[{ Int: 1 }, { Text: "Aisyah" }]] });
            send({ t: "done", status: "ok", row_count: 1, affected_rows: null, elapsed_ms: 1, first_row_ms: 1, frames: 1, error: null, sqlstate: null, error_position: null, hold: null });
          }, 5);
          return { query_id: queryId, sql: `SELECT * FROM public.${args.table} ORDER BY id LIMIT ${args.limit}` };
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
const page = await browser.newPage({ viewport: { width: 1280, height: 820 }, deviceScaleFactor: 2 });
page.on("pageerror", (e) => console.error("pageerror:", e.message));
await page.addInitScript({ path: LINUX_PLATFORM });
await page.addInitScript(stubTauri);
await page.goto(URL);
const ws = '[data-testid="workspace"]:not([hidden])';
await page.waitForSelector(`${ws}[data-conn-state="connected"]`);
await page.waitForTimeout(300);
const calls = (cmd) => page.evaluate((cmd) => window.__CALLS__.filter(([c]) => c === cmd).map(([, a]) => a), cmd);
const row = (name) => `${ws} [data-table="arcade.public.${name}"] [data-testid="sb-row-main"]`;
const rest = async (name, ms = 250) => {
  await page.hover(row(name));
  await page.waitForTimeout(ms);
};
const away = async () => {
  await page.mouse.move(900, 600);
  await page.waitForTimeout(80);
};

// 1 · Off by default.
await rest("players", 400);
await away();
check((await calls("prefetch_table")).length === 0, "switch off (the default): resting on a row asks nothing");

// 2 · The switch in the connection sheet's Advanced section.
await page.keyboard.press("Control+Shift+O");
await page.waitForSelector("[data-conn-id]");
await page.hover("[data-conn-id] >> nth=0");
await page.click('[data-conn-id] >> nth=0 >> [data-testid="conn-edit"]');
await page.waitForSelector('[data-testid="nc-sheet"]');
await page.click('[data-testid="nc-sheet"] [data-testid="nc-disclosure"]');
await page.waitForSelector('[data-testid="nc-sheet"] [data-prefetch-switch]');
check(!(await page.isChecked('[data-testid="nc-sheet"] [data-prefetch-switch]')), "Advanced has Prefetch on hover, off");
await page.click('[data-testid="nc-sheet"] [data-prefetch-switch]');
await page.screenshot({ path: `${OUT}/1-switch.png` });
await page.keyboard.press("Control+Enter");
await page.waitForSelector('[data-testid="nc-sheet"]', { state: "detached" });
const saved = await calls("save_connection");
check(saved.length === 1 && saved[0].connection.id === "pg", "saved with the connection");
await page.waitForTimeout(200);

// 3 · On: 120 ms on a row, one prefetch with the click's exact arguments.
await page.hover(row("players"));
await page.waitForTimeout(60);
check((await calls("prefetch_table")).length === 0, "not yet at 60 ms");
await page.waitForTimeout(200);
let pf = await calls("prefetch_table");
check(pf.length === 1 && pf[0].table === "players", `one prefetch_table after 120 ms (${pf.length})`);
check(pf[0].limit === 1000 && JSON.stringify(pf[0].key) === '["id"]' && !pf[0].filter, `the first page of the browse (limit ${pf[0].limit}, key ${JSON.stringify(pf[0].key)})`);
await page.click(row("players"));
await page.waitForSelector(`${ws} [data-row="0"]`);
const browse = (await calls("browse_table")).at(-1);
const same = ["engine", "schema", "table", "columns", "filter", "order", "limit", "key"].filter(
  (k) => JSON.stringify(browse[k] ?? null) !== JSON.stringify(pf[0][k] ?? null),
);
check(same.length === 0 && (browse.offset ?? 0) === 0 && browse.after == null, `the click browses the same SQL arguments${same.length ? ` (differs: ${same})` : ""}`);
await away();

// Passing over rows faster than 120 ms asks nothing.
const before = (await calls("prefetch_table")).length;
for (const name of ["events_log", "codes", "events", "slow_scores", "codes"]) {
  await page.hover(row(name));
  await page.waitForTimeout(40);
}
await away();
check((await calls("prefetch_table")).length === before, "sweeping across rows sends nothing");

// 4 · Never without a key, for a view, a partitioned parent, or an open tab.
for (const name of ["events_log", "leaderboard", "events", "players"]) await rest(name);
await away();
check((await calls("prefetch_table")).length === before, "no PK/unique, a view, a partitioned parent, an open tab: nothing");
await rest("codes");
await away();
check((await calls("prefetch_table")).at(-1)?.table === "codes", "a unique index is key enough");

// 5 · One in flight, cancelled when the pointer leaves.
const cancels = (await calls("cancel_prefetch")).length;
await rest("slow_scores", 300);
check((await calls("prefetch_table")).at(-1)?.table === "slow_scores", "a slow prefetch is in flight");
await page.screenshot({ path: `${OUT}/2-hover.png` });
await away();
check((await calls("cancel_prefetch")).length === cancels + 1, "leaving the row cancels it");
check(await page.evaluate(() => window.__PENDING_PREFETCH__ !== undefined), "the stub saw the cancel");
await browser.close();
