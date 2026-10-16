#!/usr/bin/env node
// Quick Look pretty-prints json / jsonb values (issue #146), stubbed `invoke`.
// 1. A jsonb field shows indented over several lines (white-space: pre-wrap).
// 2. A jsonb holding a number past 2^53 stays exactly as stored.
// 3. A text column that happens to hold JSON is left alone.
// 4. The grid cell stays one line.
//
//   cd apps/rowkery-tauri && npx vite --port 1420 &
//   node scripts/quick-look-json-browser-proof.mjs [outDir]   (ROWKERY_DEV_URL for another port)
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
const OUT = process.argv[2] ?? "/tmp/rowkery-proof/quick-look-json";
const URL = process.env.ROWKERY_DEV_URL ?? "http://localhost:1420/";
mkdirSync(OUT, { recursive: true });

function stubTauri() {
  if (!sessionStorage.getItem("seeded")) {
    localStorage.clear();
    localStorage.setItem("rowkery.windows", JSON.stringify({ windows: [{ connectionId: "pg", database: "wallet" }], active: 0 }));
    sessionStorage.setItem("seeded", "1");
  }
  const col = (name, type_name = "int8") => ({ name, type_name, nullable: true });
  const fk = (c, ref_table) => ({ name: `${c}_fk`, columns: [c], ref_schema: "public", ref_table, ref_columns: ["id"], on_delete: "NO ACTION" });
  const table = (name, columns, foreign_keys = []) => ({ name, kind: "table", columns, primary_key: ["id"], indexes: [], foreign_keys, row_estimate: { Approximate: 100 }, partition_of: null });
  const tables = [table("events", [col("id"), col("payload", "jsonb"), col("big", "jsonb"), col("note", "text")])];
  const rowsOf = {
    events: [[{ Int: 1 }, { Text: '{"a":{"b":[1,2.5,"x"]},"ok":true}' }, { Text: '{"n":12345678901234567890}' }, { Text: '{"not":"json type"}' }]],
  };
  window.__CALLS__ = [];
  let nextId = 0;
  const conn = { kind: "postgres", id: "pg", name: "wallet-dev", host: "db.internal", port: 5432, database: "wallet", username: "app" };
  window.__TAURI_INTERNALS__ = {
    metadata: { currentWindow: { label: "main" }, currentWebview: { label: "main" } },
    transformCallback: () => 0,
    invoke: async (cmd, args) => {
      window.__CALLS__.push({ cmd, args: cmd === "follow_keys" ? args.lookups : cmd === "browse_table" ? { table: args.table, filter: args.filter } : null });
      switch (cmd) {
        case "list_connections":
          return { connections: [conn], active_connection_id: null };
        case "open_window":
          return { database: "wallet", catalog: { databases: [{ name: "wallet", schemas: [{ name: "public", tables }] }] }, elapsed_ms: 2, cached: false, open_seq: 1 };
        case "list_databases":
          return [];
        case "browse_table": {
          const queryId = ++nextId;
          const t = tables.find((x) => x.name === args.table);
          // `id = 7`-style filters pick rows by their key column's value.
          const m = /^"?(\w+)"? = (\d+)$/.exec(args.filter ?? "");
          const ci = m ? t.columns.findIndex((c) => c.name === m[1]) : -1;
          const rows = rowsOf[args.table].filter((r) => ci < 0 || String(r[ci].Int) === m[2]);
          setTimeout(() => {
            const send = (f) => args.onFrame.onmessage({ query_id: queryId, ...f });
            send({ t: "columns", columns: t.columns.map(({ name, type_name }) => ({ name, type_name })) });
            send({ t: "rows", seq: 0, rows });
            send({ t: "done", status: "ok", row_count: rows.length, affected_rows: null, elapsed_ms: 2, first_row_ms: 1, frames: 1, error: null, sqlstate: null, error_position: null, hold: null });
          }, 5);
          const where = args.filter ? ` WHERE ${args.filter}` : "";
          return { query_id: queryId, sql: `SELECT * FROM public.${args.table}${where} ORDER BY id LIMIT ${args.limit}` };
        }
        case "follow_keys":
          return args.lookups.map(() => null);
        case "count_incoming":
          return args.lookups.map(() => 0);
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
await page.click(`${ws} [data-table="wallet.public.events"] [data-testid="sb-row-main"]`);
await page.waitForSelector(`${ws} [data-row="0"] [data-col="1"]`);
await page.waitForTimeout(200);
const cellText = await page.$eval(`${ws} [data-row="0"] [data-col="1"]`, (e) => e.innerText);
check(!cellText.includes("\n"), `grid cell stays one line (${JSON.stringify(cellText)})`);
await page.click(`${ws} [data-row="0"] [data-col="1"]`);
await page.keyboard.press("Space");
await page.waitForSelector(`${ws} [data-quicklook]`);
await page.waitForTimeout(300);
const dd = (i) => page.$$eval(`${ws} [data-quicklook] .ql-field dd`, (els, i) => els[i].textContent, i);
const pretty = await dd(1);
check(pretty === '{\n  "a": {\n    "b": [\n      1,\n      2.5,\n      "x"\n    ]\n  },\n  "ok": true\n}', `jsonb is indented: ${JSON.stringify(pretty)}`);
const h = await page.$$eval(`${ws} [data-quicklook] .ql-field dd`, (els) => els[1].getBoundingClientRect().height);
check(h > 100, `and takes several lines (${Math.round(h)} px)`);
check((await dd(2)) === '{"n":12345678901234567890}', "a number past 2^53 is left exactly as stored");
check((await dd(3)) === '{"not":"json type"}', "a text column holding JSON is not reformatted");
await page.screenshot({ path: `${OUT}/1-json.png` });
await browser.close();
