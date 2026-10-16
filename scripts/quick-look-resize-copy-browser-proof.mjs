#!/usr/bin/env node
// Quick Look resize and copy (stubbed `invoke`, Linux keys; issue #159).
//
// 1. Each field has a copy button in front of its value (hidden until the
//    line is hovered); clicking copies exactly that value ("NULL" for a null)
//    and shows the "Copied" toast.
// 2. Dragging the inspector's left edge leftwards widens it (right edge stays
//    put, min 280 px, never past the grid). It is a full-height column since
//    the 2026-10-10 inspector decision, so there is no bottom edge. The
//    width is kept when Quick Look is closed and opened again.
//
//   cd apps/rowkery-tauri && npx vite --port 1420 &
//   node scripts/quick-look-resize-copy-browser-proof.mjs [outDir]   (ROWKERY_DEV_URL for another port)
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
const OUT = process.argv[2] ?? "/tmp/rowkery-proof/quick-look-resize-copy";
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
  const tables = [
    table("wallet_tx", [col("id"), col("wallet_id"), col("kiosk_id"), col("amount", "numeric"), col("status", "text")], [fk("wallet_id", "wallets"), fk("kiosk_id", "kiosks")]),
    table("wallets", [col("id"), col("name", "text")]),
    table("kiosks", [col("id"), col("name", "text")]),
    table("ledger_entries", [col("id"), col("tx_id")], [fk("tx_id", "wallet_tx")]),
    table("refunds", [col("id"), col("tx_id")], [fk("tx_id", "wallet_tx")]),
    table("disputes", [col("id"), col("tx_id")], [fk("tx_id", "wallet_tx")]),
  ];
  const rowsOf = {
    wallet_tx: [
      [{ Int: 48207 }, { Int: 1012 }, { Int: 7 }, { Text: "920.00" }, { Text: "pending" }],
      [{ Int: 48190 }, { Int: 1012 }, { Int: 3 }, { Text: "410.50" }, { Text: "pending" }],
    ],
    kiosks: [
      [{ Int: 3 }, { Text: "Kiosk Mont Kiara" }],
      [{ Int: 7 }, { Text: "Kiosk Bangsar" }],
    ],
    wallets: [[{ Int: 1012 }, { Text: "Ahmad R." }]],
    ledger_entries: [
      [{ Int: 1 }, { Int: 48207 }],
      [{ Int: 2 }, { Int: 48207 }],
    ],
    refunds: [],
    disputes: [],
  };
  const COUNTS = { ledger_entries: 2, refunds: 0, disputes: 101 };
  window.__CALLS__ = [];
  let nextId = 0;
  const conn = { kind: "postgres", id: "pg", name: "wallet-dev", host: "db.internal", port: 5432, database: "wallet", username: "app" };
  window.__TAURI_INTERNALS__ = {
    metadata: { currentWindow: { label: "main" }, currentWebview: { label: "main" } },
    transformCallback: () => 0,
    invoke: async (cmd, args) => {
      window.__CALLS__.push({ cmd, args: cmd === "follow_keys" || cmd === "count_incoming" ? args.lookups : cmd === "browse_table" ? { table: args.table, filter: args.filter } : null });
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
          return args.lookups.map((l) => {
            const row = rowsOf[l.table].find((r) => r[0].Int === l.value.Int);
            return row ? { columns: [{ name: "id", type_name: "int8" }, { name: "name", type_name: "text" }], row } : null;
          });
        case "count_incoming":
          // Answers after a beat, so the dash placeholder shows first.
          await new Promise((r) => setTimeout(r, 150));
          return args.lookups.map((l) => COUNTS[l.table] ?? 0);
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
await page.context().grantPermissions(["clipboard-read", "clipboard-write"]);
page.on("pageerror", (e) => console.error("pageerror:", e.message));
await page.addInitScript({ path: LINUX_PLATFORM });
await page.addInitScript(stubTauri);
await page.goto(URL);
const ws = '[data-testid="workspace"]:not([hidden])';
await page.waitForSelector(`${ws}[data-conn-state="connected"]`);
await page.waitForTimeout(300);
const card = `${ws} [data-quicklook]:not([data-closing] *)`;

await page.click(`${ws} [data-table="wallet.public.wallet_tx"] [data-testid="sb-row-main"]`);
await page.waitForSelector(`${ws} [data-row="0"] [data-col="2"]`);
await page.waitForTimeout(200);
await page.click(`${ws} [data-row="0"] [data-col="2"]`);
await page.keyboard.press("Space");
await page.waitForSelector(card);
await page.waitForTimeout(350);

// 1 · Copy buttons.
const btn = (c) => `${card} [data-copy-value="${c}"]`;
check((await page.$$(`${card} [data-copy-value]`)).length === 5, "one copy button per field");
check((await page.$eval(btn("amount"), (e) => getComputedStyle(e).opacity)) === "0", "hidden until the line is hovered");
const order = await page.$eval(`${card} .ql-field`, (f) => [...f.children].map((c) => c.tagName).join());
check(order === "DT,BUTTON,DD", `the button sits before the value (${order})`);
await page.hover(`${card} [data-key-line="kiosk_id"]`);
await page.waitForTimeout(200);
check((await page.$eval(btn("kiosk_id"), (e) => getComputedStyle(e).opacity)) === "1", "shown on hover");
await page.screenshot({ path: `${OUT}/1-copy-hover.png` });
await page.click(btn("amount"));
await page.waitForTimeout(150);
check((await page.evaluate(() => navigator.clipboard.readText())) === "920.00", "clicking copies amount = 920.00");
check(/Copied/.test(await page.evaluate(() => document.body.innerText)), "the Copied toast shows");
await page.click(btn("kiosk_id"));
check((await page.evaluate(() => navigator.clipboard.readText())) === "7", "kiosk_id copies 7, not its label");
check(!!(await page.$(card)), "copying leaves Quick Look open");

// 2 · Resize (2026-10-13: the inspector's own left edge, insp-resize, 320 px
//     to 60% of the window, for every inspector kind).
const box = () => page.$eval(card, (e) => { const r = e.getBoundingClientRect(); return { w: r.width, h: r.height, right: r.right, top: r.top }; });
const b0 = await box();
const edge = await (await page.$(`${card} [data-testid="insp-resize"]`)).boundingBox();
await page.mouse.move(edge.x + 3, edge.y + edge.height / 2);
await page.mouse.down();
await page.mouse.move(edge.x - 117, edge.y + edge.height / 2, { steps: 6 });
await page.mouse.up();
const b1 = await box();
check(Math.abs(b1.w - (b0.w + 120)) <= 1 && Math.abs(b1.right - b0.right) <= 1, `left edge +120 px widens it (${b0.w} → ${b1.w}), right edge fixed`);
const edge2 = await (await page.$(`${card} [data-testid="insp-resize"]`)).boundingBox();
await page.mouse.move(edge2.x + 3, edge2.y + 60);
await page.mouse.down();
await page.mouse.move(edge2.x + 800, edge2.y + 60, { steps: 4 });
await page.mouse.up();
check((await box()).w === 320, `dragged far right stops at the 320 px minimum (${(await box()).w})`);
const edge3 = await (await page.$(`${card} [data-testid="insp-resize"]`)).boundingBox();
await page.mouse.move(edge3.x + 3, edge3.y + 60);
await page.mouse.down();
await page.mouse.move(edge3.x - 3000, edge3.y + 60, { steps: 4 });
await page.mouse.up();
const wide = await box();
check(wide.w === Math.round(1280 * 0.6), `dragged far left stops at 60% of the window (${wide.w})`);
// The bottom edge is gone: Quick Look is a full-height column (2026-10-10).
check((await page.$(`${card} [data-testid="ql-resize-h"]`)) === null, "no bottom edge: the inspector is full height");
await page.screenshot({ path: `${OUT}/2-resized.png` });

// Kept across close and open.
await page.keyboard.press("Escape");
await page.waitForTimeout(250);
await page.keyboard.press("Space");
await page.waitForSelector(card);
await page.waitForTimeout(350);
const again = await box();
check(again.w === wide.w, `the size is kept on reopen (${again.w})`);
await browser.close();
