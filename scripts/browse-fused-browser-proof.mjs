#!/usr/bin/env node
// One call per browse, one per Quick Look (stubbed `invoke` that counts
// calls): a sidebar click runs `browse_table` once (no `browse_table_sql`,
// no `run_query`), and Space on a row
// with three foreign keys asks `follow_keys` once for all three, then labels
// each from its row. Asserts on data-* attributes.
//
//   cd apps/rowkery-tauri && npx vite --port 1420 &
//   node scripts/browse-fused-browser-proof.mjs [outDir]
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
const OUT = process.argv[2] ?? "/tmp/rowkery-proof/browse-fused";
const URL = process.env.ROWKERY_DEV_URL ?? "http://localhost:1420/";
mkdirSync(OUT, { recursive: true });

function stubTauri() {
  localStorage.clear();
  const col = (name, type_name) => ({ name, type_name, nullable: true });
  const fk = (c, ref_table) => ({ name: `${c}_fk`, columns: [c], ref_schema: "public", ref_table, ref_columns: ["id"], on_delete: "NO ACTION" });
  const named = (name) => ({ name, columns: [col("id", "int8"), col("name", "text")], primary_key: ["id"], indexes: [], foreign_keys: [], row_estimate: { Approximate: 10 }, partition_of: null });
  const tables = [
    {
      name: "sessions",
      columns: [col("id", "int8"), col("kiosk_id", "int8"), col("player_id", "int8"), col("game_id", "int8")],
      primary_key: ["id"],
      indexes: [],
      foreign_keys: [fk("kiosk_id", "kiosks"), fk("player_id", "players"), fk("game_id", "games")],
      row_estimate: { Approximate: 250 },
      partition_of: null,
    },
    named("kiosks"),
    named("players"),
    named("games"),
  ];
  window.__CALLS__ = [];
  let nextId = 0;
  window.__TAURI_INTERNALS__ = {
    metadata: { currentWindow: { label: "main" }, currentWebview: { label: "main" } },
    transformCallback: () => 0,
    invoke: async (cmd, args) => {
      window.__CALLS__.push({ cmd, args: cmd === "follow_keys" ? args.lookups : cmd === "browse_table" ? { table: args.table, offset: args.offset } : null });
      switch (cmd) {
        case "list_connections":
          return { connections: [{ kind: "postgres", id: "pg", name: "arcade", host: "127.0.0.1", port: 54329, database: "rowkery", username: "rowkery" }], active_connection_id: null };
        case "open_window":
          return { database: "rowkery", catalog: { databases: [{ name: "rowkery", schemas: [{ name: "public", tables }] }] }, elapsed_ms: 2 };
        case "browse_table": {
          const queryId = ++nextId;
          const offset = args.offset ?? 0;
          const n = offset === 0 ? args.limit : 50;
          setTimeout(() => {
            const send = (f) => args.onFrame.onmessage({ query_id: queryId, ...f });
            send({ t: "columns", columns: tables[0].columns.map(({ name, type_name }) => ({ name, type_name })) });
            send({ t: "rows", seq: 0, rows: Array.from({ length: n }, (_, i) => [{ Int: offset + i + 1 }, { Int: 7 }, { Int: 8 }, { Int: 9 }]) });
            send({ t: "done", status: "ok", row_count: n, affected_rows: null, elapsed_ms: 2, first_row_ms: 1, frames: 1, error: null, sqlstate: null, error_position: null, hold: null });
          }, 5);
          return { query_id: queryId, sql: `SELECT * FROM public.${args.table} LIMIT ${args.limit} OFFSET ${offset}` };
        }
        case "follow_keys":
          return args.lookups.map((l) => ({ columns: [{ name: "id", type_name: "int8" }, { name: "name", type_name: "text" }], row: [l.value, { Text: `${l.table} #${l.value.Int}` }] }));
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
const page = await browser.newPage({ viewport: { width: 1280, height: 800 }, deviceScaleFactor: 2 });
page.on("pageerror", (e) => console.error("pageerror:", e.message));
await page.addInitScript({ path: LINUX_PLATFORM });
await page.addInitScript(stubTauri);
await page.goto(URL);
const visible = '[data-testid="workspace"]:not([hidden])';
await page.waitForSelector('[data-testid="workspace"]:not([hidden])'); // Paper (2026-10-10): an empty window shows no connection chip (no tab row without a connection); wait for the window, then ⇧⌘O as before.
await page.keyboard.press("Control+Shift+O");
await page.waitForSelector('[data-testid="conn-popover"]');
await page.keyboard.press("Enter");
await page.waitForSelector(`${visible}[data-conn-state="connected"]`);
const calls = (cmd) => page.evaluate((cmd) => window.__CALLS__.filter((c) => c.cmd === cmd), cmd);

await page.click(`${visible} [data-table="rowkery.public.sessions"] [data-testid="sb-row-main"]`);
await page.waitForSelector(`${visible} [data-row="0"]`);
await page.waitForTimeout(300);
check((await calls("browse_table")).length === 1, "a sidebar click is one browse_table call");
check((await calls("browse_table_sql")).length === 0 && (await calls("run_query")).length === 0, "and no browse_table_sql or run_query");

// Space on a row: one follow_keys for its three keys, each labelled.
await page.click(`${visible} [data-row="0"] [data-col="0"]`);
await page.keyboard.press("Space");
await page.waitForSelector(`${visible} [data-quicklook] [data-follow="game_id"]`);
const follows = await calls("follow_keys");
check(follows.length === 1 && follows[0].args.length === 3, `three keys, one follow_keys call (${follows.length} calls, ${follows[0]?.args.length} lookups)`);
const labels = await page.$$eval(`${visible} [data-follow]`, (els) => els.map((e) => `${e.dataset.follow}=${e.textContent}`));
check(labels.join(",") === "kiosk_id=kiosks #7,player_id=players #8,game_id=games #9", `each key labelled from its row (${labels.join(", ")})`);
await page.screenshot({ path: `${OUT}/1-quick-look.png` });

// The next row's keys are the same values: answered from the cache.
await page.keyboard.press("ArrowDown");
await page.waitForTimeout(300);
check((await calls("follow_keys")).length === 1, "same keys on the next row: no new call");
await browser.close();
