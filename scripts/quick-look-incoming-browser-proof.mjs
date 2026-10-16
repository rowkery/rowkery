#!/usr/bin/env node
// Quick Look with Incoming and follow (stubbed `invoke` that counts calls,
// Linux keys).
//
// 1. Selecting a cell fetches its row's key labels 80 ms later in one
//    follow_keys call, so Space opens with every label already in the card
//    (checked before the first paint after the key, with no new call).
// 2. Quick Look is the inspector column at the window's right
//    (2026-10-10, replacing the floating card):
//    340 px, the panel's opaque ground, no backdrop blur, and the grid ends
//    where it begins (nothing covered).
// 3. Incoming lists the tables referencing the row with bounded counts
//    (dash first, then `2`, `0` dim with no arrow, `100+`), counted on demand
//    (one count_incoming call when the card opens, none on selection).
// 4. → follows the focused key into the Preview tab (`kiosks WHERE id = 7`),
//    pushing history; Quick Look opens again on the followed row; Alt+←
//    comes back. ⇥ moves focus to Incoming and → opens its rows there.
// 5. Ctrl+↵ in the grid follows the selected key cell; the cell menu prints
//    "Follow kiosk_id Ctrl+↵", the strip "Ctrl+↵ follow", and ⌘K lists
//    Quick Look, which opens the card.
//
//   cd apps/rowkery-tauri && npx vite --port 1420 &
//   node scripts/quick-look-incoming-browser-proof.mjs [outDir]   (ROWKERY_DEV_URL for another port)
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
const OUT = process.argv[2] ?? "/tmp/rowkery-proof/quick-look-incoming";
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
page.on("pageerror", (e) => console.error("pageerror:", e.message));
await page.addInitScript({ path: LINUX_PLATFORM });
await page.addInitScript(stubTauri);
await page.goto(URL);
const ws = '[data-testid="workspace"]:not([hidden])';
await page.waitForSelector(`${ws}[data-conn-state="connected"]`);
await page.waitForTimeout(300);
const calls = (cmd) => page.evaluate((cmd) => window.__CALLS__.filter((c) => c.cmd === cmd), cmd);
const card = `${ws} [data-quicklook]:not([data-closing] *)`;
const tabTitle = () => page.$eval(`${ws} [data-testid="query-tab"][aria-selected="true"]`, (e) => e.textContent.trim());

await page.click(`${ws} [data-table="wallet.public.wallet_tx"] [data-testid="sb-row-main"]`);
await page.waitForSelector(`${ws} [data-row="0"] [data-col="2"]`);
await page.waitForTimeout(200);

// 1 · Selecting a cell: one follow_keys for the row's two keys, 80 ms later.
check((await calls("follow_keys")).length === 0, "nothing is fetched before a cell is selected");
await page.click(`${ws} [data-row="0"] [data-col="2"]`);
await page.waitForTimeout(30);
check((await calls("follow_keys")).length === 0, "not yet 30 ms after the click (debounced 80 ms)");
await page.waitForTimeout(200);
let follows = await calls("follow_keys");
check(follows.length === 1 && follows[0].args.length === 2, `then one follow_keys for both keys (${follows.length} calls, ${follows[0]?.args.length} lookups)`);
check((await calls("count_incoming")).length === 0, "Incoming is never counted speculatively");

// Space: the labels are in the card before the first paint after the key.
const atOpen = await page.evaluate(async () => {
  const grid = document.querySelector('[data-testid="workspace"]:not([hidden]) [data-testid="results-grid-wrap"]');
  const before = window.__CALLS__.filter((c) => c.cmd === "follow_keys").length;
  grid.dispatchEvent(new KeyboardEvent("keydown", { key: " ", code: "Space", bubbles: true, cancelable: true }));
  // React commits a key's update before the next frame paints.
  await new Promise((r) => requestAnimationFrame(r));
  const labels = [...document.querySelectorAll('[data-testid="workspace"]:not([hidden]) [data-quicklook] [data-follow]')].map((e) => `${e.dataset.follow}=${e.textContent}`);
  const counts = [...document.querySelectorAll('[data-testid="workspace"]:not([hidden]) [data-quicklook] [data-incoming-row]')].map((e) => e.dataset.count);
  return { labels, counts, calls: window.__CALLS__.filter((c) => c.cmd === "follow_keys").length - before };
});
check(atOpen.labels.join(",") === "wallet_id=Ahmad R.,kiosk_id=Kiosk Bangsar", `Space opens with labels present (0 ms): ${atOpen.labels.join(", ")}`);
check(atOpen.calls === 0, "and asks follow_keys nothing more");
check(atOpen.counts.length === 3 && atOpen.counts.every((c) => c === ""), "Incoming counts start as a dash");
check((await page.getAttribute(`${card} [data-focused]`, "data-key-line")) === "kiosk_id", "focus starts on the selected cell's key");

// 2 · The inspector column (2026-10-10): docked right, opaque, the grid beside it.
await page.waitForTimeout(300);
const look = await page.$eval(card, (e) => {
  const s = getComputedStyle(e);
  const r = e.getBoundingClientRect();
  const g = e.closest('[data-testid="workspace"]').querySelector('[data-testid="results-grid-wrap"]').getBoundingClientRect();
  const probe = document.createElement("i");
  probe.style.color = "var(--panel)";
  document.body.append(probe);
  const panel = getComputedStyle(probe).color;
  probe.remove();
  return { width: r.width, right: window.innerWidth - r.right, bg: s.backgroundColor, panel, blur: s.backdropFilter, gridRight: g.right, left: r.left };
});
check(look.width === 340 && Math.round(look.right) === 0, `docked at the right, 340 px (${look.width}, ${look.right})`);
check(look.bg === look.panel && (look.blur === "none" || look.blur === ""), `the panel's opaque ground, no glass (${look.bg}, ${look.blur})`);
check(Math.abs(look.gridRight - look.left) <= 1, `the grid ends where it begins (${look.gridRight} / ${look.left})`);

// 3 · Incoming: a dash, then bounded counts.
await page.waitForSelector(`${card} [data-incoming-row="refunds"][data-count="0"]`);
const incoming = await page.$$eval(`${card} [data-incoming-row]`, (els) => els.map((e) => e.innerText.replace(/\s+/g, " ").trim()));
// The inspector's Incoming reads "n rows" as the prototype does (Paper, 2026-10-10).
check(incoming.join(" | ") === "disputes 100+ rows → | ledger_entries 2 rows → | refunds 0 rows", `Incoming: ${incoming.join(" | ")}`);
const counted = await calls("count_incoming");
check(counted.length === 1 && counted[0].args.map((l) => `${l.table}.${l.column}=${l.value.Int}`).join() === "disputes.tx_id=48207,ledger_entries.tx_id=48207,refunds.tx_id=48207", "one count_incoming call when the card opened");
const foot = await page.$eval(`${card} [data-testid="ql-foot"]`, (e) => e.innerText.replace(/\s+/g, " ").trim());
// The copy key is the registry's, as this platform prints it (Ctrl+C here).
// The inspector's foot (2026-10-10): Copy JSON and Delete row, each with the registry's key.
check(foot === "Copy JSON Ctrl+C Delete row Backspace", `foot: ${foot}`);
await page.screenshot({ path: `${OUT}/1-open.png` });

// 4 · → follows the focused key into the Preview tab and pushes history.
await page.keyboard.press("ArrowRight");
await page.waitForFunction(() => document.querySelector('[data-testid="workspace"]:not([hidden]) [data-testid="query-tab"][aria-selected="true"]')?.textContent.includes("kiosks"));
await page.waitForSelector(`${card} [data-quicklook], ${card}`);
await page.waitForTimeout(250);
const browses = await calls("browse_table");
check(browses.at(-1).args.table === "kiosks" && browses.at(-1).args.filter === "id = 7", `browsed kiosks WHERE ${browses.at(-1).args.filter}`);
check((await page.$$(`${ws} [data-testid="query-tab"][data-reorder-key]`)).length >= 1 && (await page.$$(`${ws} [data-testid="query-tab"][data-preview]`)).length === 1, "the one Preview tab retargeted");
check((await page.getAttribute(`${ws} [data-history]`, "data-history")) === "2/2", "a history step was pushed");
check(!!(await page.$(card)) && (await page.$eval(`${card} [data-testid="ql-title"]`, (e) => e.textContent.trim())) === "Kiosk Bangsar", "Quick Look stays open on the followed row, titled by its name");
await page.screenshot({ path: `${OUT}/2-followed.png` });
await page.keyboard.press("Escape");
await page.waitForTimeout(200);
await page.keyboard.press("Alt+ArrowLeft");
await page.waitForFunction(() => document.querySelector('[data-testid="workspace"]:not([hidden]) [data-testid="query-tab"][aria-selected="true"]')?.textContent.includes("wallet_tx"));
check((await page.getAttribute(`${ws} [data-history]`, "data-history")) === "1/2", "Alt+← comes back to wallet_tx");

// ⇥ to Incoming, → opens its rows.
await page.waitForSelector(`${ws} [data-row="0"] [data-col="0"]`);
await page.waitForTimeout(150);
await page.click(`${ws} [data-row="0"] [data-col="0"]`);
await page.keyboard.press("Space");
await page.waitForSelector(card);
await page.keyboard.press("Tab");
await page.keyboard.press("Tab");
await page.keyboard.press("Tab");
check((await page.getAttribute(`${card} [data-focused]`, "data-incoming-row")) === "ledger_entries", "⇥ moves focus through the keys, then Incoming");
await page.screenshot({ path: `${OUT}/3-incoming-focus.png` });
await page.keyboard.press("ArrowRight");
await page.waitForFunction(() => document.querySelector('[data-testid="workspace"]:not([hidden]) [data-testid="query-tab"][aria-selected="true"]')?.textContent.includes("ledger_entries"));
check((await calls("browse_table")).at(-1).args.filter === "tx_id = 48207", "→ on Incoming opens ledger_entries WHERE tx_id = 48207");
await page.keyboard.press("Escape");
await page.keyboard.press("Alt+ArrowLeft");
await page.waitForFunction(() => document.querySelector('[data-testid="workspace"]:not([hidden]) [data-testid="query-tab"][aria-selected="true"]')?.textContent.includes("wallet_tx"));

// 5 · Ctrl+↵ in the grid, the cell menu, the strip, ⌘K.
await page.waitForSelector(`${ws} [data-row="0"] [data-col="1"]`);
await page.waitForTimeout(150);
await page.click(`${ws} [data-row="0"] [data-col="1"]`);
await page.waitForTimeout(150);
const strip = await page.$$eval(`${ws} [data-key-strip="grid"] [data-strip-item]`, (els) => els.map((i) => `${i.dataset.keys} ${i.textContent.replace(/^·/, "").trim().split(" ").pop()}`).join(" · "));
check(strip.includes("Ctrl+↵ follow"), `the strip offers it: ${strip}`);
await page.click(`${ws} [data-row="0"] [data-col="1"]`, { button: "right" });
await page.waitForSelector("[data-menu]");
const menu = await page.$$eval("[data-menu] [data-item]", (els) => els.map((e) => `${e.dataset.item}=${e.querySelector('[data-testid="grid-menu-label"]').textContent.trim()}:${e.dataset.keys ?? ""}`));
// The staging rows (↵ edit, Set NULL, …) sit between them on a table that can be edited.
const looked = menu.filter((r) => !/^(edit-cell|set-null|insert-row|duplicate-row|delete-row)=/.test(r));
check(looked.slice(0, 2).join("|") === "quick-look=Quick Look:Space|follow-key=Follow wallet_id:Ctrl+↵", `cell menu: ${looked.slice(0, 2).join(" · ")}`);
await page.screenshot({ path: `${OUT}/4-cell-menu.png` });
await page.keyboard.press("Escape");
await page.waitForTimeout(150);
check(await page.evaluate(() => !!document.activeElement?.closest('[data-testid="results-grid-wrap"]')), "closing the menu gives the grid its keys back");
await page.keyboard.press("Control+Enter");
await page.waitForFunction(() => document.querySelector('[data-testid="workspace"]:not([hidden]) [data-testid="query-tab"][aria-selected="true"]')?.textContent.includes("wallets"));
check((await calls("browse_table")).at(-1).args.filter === "id = 1012", "Ctrl+↵ follows wallet_id into wallets WHERE id = 1012");
await page.waitForSelector(card);
await page.keyboard.press("Escape");
await page.waitForTimeout(200);
check(!(await page.$(card)), "Esc closes only Quick Look");
await page.keyboard.press("Control+k");
await page.waitForSelector('[data-testid="cp-panel"]');
await page.keyboard.type("quick look");
await page.waitForTimeout(150);
const first = await page.$eval('[data-testid="cp-panel"] [data-testid="cp-row"][aria-selected="true"]', (e) => e.innerText.replace(/\s+/g, " ").trim()).catch(() => "");
check(/^Quick Look/.test(first), `⌘K lists Quick Look (${first})`);
await page.keyboard.press("Enter");
await page.waitForSelector(card);
check(true, "and ↵ opens it");

// The inspector column narrows to 280 px under 1100 px.
await page.setViewportSize({ width: 1040, height: 820 });
// The column's width glides (.22 s) since it became one aside across kinds (2026-10-10).
await page.waitForTimeout(350);
const narrow = await page.$eval(card, (e) => e.offsetWidth);
check(narrow === 280, `280 px under 1100 px (${narrow})`);
await page.screenshot({ path: `${OUT}/5-narrow.png` });
await browser.close();
