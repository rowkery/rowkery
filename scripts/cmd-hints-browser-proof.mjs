#!/usr/bin/env node
// Shortcut hints while ⌘ is held (stubbed `invoke`, macOS keys; #158, the layout
// chosen on 2026-10-08).
//
// 1. ⌘ pressed and released quickly (a ⌘C-style tap) shows nothing.
// 2. ⌘ held ~400 ms shows a pill under each control that has a command:
//    window 1, new window, help, sidebar, connection, database, refresh, new
//    tab; the keys come from the registry (⌘T, ⌘B, ⇧⌘O …). Disabled
//    back / forward get none, and the pills take no pointer events.
// 3. Releasing ⌘, or pressing any other key while it's held, removes them.
//
//   cd apps/rowkery-tauri && npx vite --port 1420 &
//   node scripts/cmd-hints-browser-proof.mjs [outDir]   (ROWKERY_DEV_URL for another port)
import { createRequire } from "node:module";
import { mkdirSync } from "node:fs";
import { execSync } from "node:child_process";

const require = createRequire(import.meta.url);
let playwright;
try {
  playwright = require("playwright");
} catch {
  playwright = require(`${execSync("npm root -g").toString().trim()}/playwright`);
}
const OUT = process.argv[2] ?? "/tmp/rowkery-proof/cmd-hints";
const URL = process.env.ROWKERY_DEV_URL ?? "http://localhost:1420/";
const FRAMES_SHIM = new globalThis.URL("./lib/frames-shim.js", import.meta.url).pathname;
mkdirSync(OUT, { recursive: true });

function stubTauri() {
  if (!sessionStorage.getItem("seeded")) {
    localStorage.clear();
    localStorage.setItem("rowkery.windows", JSON.stringify({ windows: [{ connectionId: "pg", database: "wallet" }], active: 0 }));
    sessionStorage.setItem("seeded", "1");
  }
  window.__CALLS__ = [];
  const col = (name, type_name = "int8") => ({ name, type_name, nullable: false });
  const tables = [
    { name: "kiosks", kind: "table", columns: [col("id"), col("city", "text")], primary_key: ["id"], indexes: [], foreign_keys: [], row_estimate: { Exact: 2 }, partition_of: null },
  ];
  const conn = { kind: "postgres", id: "pg", name: "wallet-dev", host: "db.internal", port: 5432, database: "wallet", username: "app" };
  window.__TAURI_INTERNALS__ = {
    metadata: { currentWindow: { label: "main" }, currentWebview: { label: "main" } },
    transformCallback: () => 0,
    invoke: async (cmd, args) => {
      window.__CALLS__.push([cmd, args]);
      switch (cmd) {
        case "list_connections":
          return { connections: [conn], active_connection_id: null };
        case "open_window":
          return { database: "wallet", catalog: { databases: [{ name: "wallet", schemas: [{ name: "public", tables }] }] }, elapsed_ms: 2, cached: false, open_seq: 1 };
        case "list_databases":
          return [];
        case "browse_table_sql":
          return `SELECT * FROM ${args.table} LIMIT 1000`;
        case "run_query": {
          if (args.sql.includes("pg_sleep")) {
            await new Promise((resolve) => (window.__PENDING__ = resolve));
            return { columns: [], rows: [], row_count: 0, elapsed_ms: 5, error: null, cancelled: true };
          }
          return {
            columns: [{ name: "id", type_name: "int8" }, { name: "city", type_name: "text" }],
            rows: [[{ Int: 1 }, { Text: "KL" }], [{ Int: 2 }, { Text: "Penang" }]],
            row_count: 2,
            elapsed_ms: 1,
            error: null,
            cancelled: false,
          };
        }
        case "cancel_query":
          window.__PENDING__?.();
          return null;
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
const page = await browser.newPage({ viewport: { width: 1280, height: 860 }, deviceScaleFactor: 2 });
page.on("pageerror", (e) => console.error("pageerror:", e.message));
await page.addInitScript({ path: FRAMES_SHIM });
await page.addInitScript(stubTauri);
await page.addInitScript(() => Object.defineProperty(Navigator.prototype, "platform", { get: () => "MacIntel", configurable: true }));
await page.goto(URL);
const ws = '[data-testid="workspace"]:not([hidden])';
const connected = () => page.waitForSelector(`${ws}[data-conn-state="connected"]`);
await connected();
await page.waitForTimeout(300);
const hints = () => page.$$eval('[data-testid="cmd-hints"] kbd', (ks) => ks.map((k) => k.textContent));
await page.evaluate(() => document.activeElement?.blur());

// 1 · A tap shows nothing.
await page.keyboard.down("Meta");
await page.waitForTimeout(120);
await page.keyboard.up("Meta");
await page.waitForTimeout(450);
check((await hints()).length === 0, "a quick ⌘ tap shows no hints");

// 2 · Held.
await page.keyboard.down("Meta");
await page.waitForSelector('[data-testid="cmd-hints"][data-on]', { timeout: 2000 });
await page.waitForTimeout(200);
const shown = await hints();
// ⌘B has no button (the key stays); ⇧⌘D rides the schema head's database name.
// ⇧⌘O has no chip in the head (it names the database); the key is in the `…` menu.
for (const k of ["⌘1", "⌘T", "⇧⌘/", "⇧⌘D", "⌘R", "⇧⌘A"]) check(shown.includes(k), `held: ${k} shown (${shown.join(" ")})`);
check(await page.$eval('[data-testid="cmd-hints"]', (e) => getComputedStyle(e).pointerEvents === "none"), "hints take no pointer events");
// 2026-10-13: overlapping badges are a bug.
const clash = await page.$$eval("[data-key-hint]", (els) => {
  const rs = els.map((e) => e.getBoundingClientRect());
  return rs.flatMap((a, i) => rs.slice(i + 1).filter((b) => a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom).map(() => i));
});
check(clash.length === 0, `no two key hints intersect (${clash.length} clashes)`);
const back = await page.$('[data-history-back]');
check(await back.isDisabled(), "back is disabled");
check(!shown.includes("⌘["), "no hint for the disabled back button");
await page.screenshot({ path: `${OUT}/1-held.png` });

// 3 · Another key hides them.
await page.keyboard.press("k");
await page.waitForTimeout(250);
check((await hints()).length === 0, "another key while ⌘ is held hides them");
await page.keyboard.up("Meta");
await page.keyboard.press("Escape");
await page.keyboard.down("Meta");
await page.waitForSelector('[data-testid="cmd-hints"][data-on]');
await page.keyboard.up("Meta");
await page.waitForTimeout(250);
check((await hints()).length === 0, "releasing ⌘ removes them");
await browser.close();
