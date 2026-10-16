#!/usr/bin/env node
// Keycaps and menu rows proof (2026-10-15, the Agents row): with the app
// pinned to macOS, a menu row's label keeps its descenders (the g in Agents was
// cut off by a 1:1 line box under overflow: hidden), and a chord's glyphs get a
// little air (⇧ ⌘ A, not ⇧⌘A) in menus, ⌘K rows and the ⌘-hold badges, while
// the keycap's text stays `⇧⌘A`. Also sweeps every clipped text box on screen
// for a line box shorter than its font's descent.
//
//   cd apps/rowkery-tauri && npx vite --port 1420 &
//   node scripts/keycap-spacing-browser-proof.mjs [outDir]
import { createRequire } from "node:module";
import { mkdirSync } from "node:fs";
import { execSync } from "node:child_process";

const FRAMES_SHIM = new globalThis.URL("./lib/frames-shim.js", import.meta.url).pathname;

const require = createRequire(import.meta.url);
let playwright;
try {
  playwright = require("playwright");
} catch {
  const root = execSync("npm root -g").toString().trim();
  playwright = require(`${root}/playwright`);
}

const OUT = process.argv[2] ?? "/tmp/rowkery-proof/keycap-spacing";
const URL = process.env.ROWKERY_DEV_URL ?? "http://localhost:1420/";
mkdirSync(OUT, { recursive: true });

function stubTauri() {
  const COLUMNS = [
    { name: "id", type_name: "int8", nullable: false },
    { name: "amount", type_name: "numeric", nullable: false },
    { name: "status", type_name: "text", nullable: false },
  ];
  const catalog = {
    databases: [
      {
        name: "wallet",
        schemas: [
          {
            name: "public",
            tables: [
              {
                name: "wallet_tx",
                columns: COLUMNS,
                primary_key: ["id"],
                indexes: [],
                row_estimate: { Approximate: 36150 },
                partition_of: null,
              },
            ],
          },
        ],
      },
    ],
  };
  const connections = [
    { kind: "postgres", id: "pg", name: "wallet-prd", host: "db.internal", port: 5432, database: "wallet", username: "app", environment: "prd" },
  ];
  // A table tab's page, as core would build it (the line shows exactly this).
  const browseSql = (a) => {
    let sql = `SELECT * FROM ${a.schema}.${a.table}`;
    if (a.filter?.trim()) sql += `\nWHERE (${a.filter.trim()})`;
    const order = [...(a.order ?? []).map((o) => `${o.column}${o.desc ? " DESC" : ""} NULLS LAST`), ...(a.key ?? []).filter((k) => !(a.order ?? []).some((o) => o.column === k))];
    if (order.length) sql += `\nORDER BY ${order.join(", ")}`;
    if (a.limit) sql += `\nLIMIT ${a.limit}`;
    return sql + ";";
  };
  window.__ROWKERY_CALLS__ = [];
  window.__TAURI_INTERNALS__ = {
    metadata: { currentWindow: { label: "main" }, currentWebview: { label: "main" } },
    transformCallback: () => 0,
    invoke: async (cmd, args) => {
      window.__ROWKERY_CALLS__.push([cmd, args]);
      switch (cmd) {
        case "list_connections":
          return { connections: structuredClone(connections), active_connection_id: null };
        case "open_window":
          await new Promise((r) => setTimeout(r, 30));
          return { database: "wallet", catalog, elapsed_ms: 30 };
        case "close_window":
          return null;
        case "probe_connection":
          return { ok: true, message: "PostgreSQL 16.4", elapsed_ms: 3 };
        case "browse_table_sql":
          return browseSql(args);
        case "run_query": {
          const n = /WHERE/.test(args.sql) ? 312 : 1000;
          return {
            columns: COLUMNS.map((c) => ({ name: c.name, type_name: c.type_name })),
            rows: Array.from({ length: n }, (_, i) => [{ Int: 48207 - i }, { Text: "920.00" }, { Text: i % 4 ? "settled" : "pending" }]),
            row_count: n,
            elapsed_ms: 3,
            error: null,
            cancelled: false,
            // A table page: the SQL line shows exactly what ran.
            sql: args.sql,
          };
        }
        case "count_rows":
          return 36152;
        default:
          return null;
      }
    },
  };
}

const browser = await playwright.chromium.launch({
  executablePath: process.env.CHROMIUM_PATH ?? "/opt/pw-browsers/chromium",
});
let failed = 0;
const check = (ok, what) => {
  console.log(`${ok ? "ok  " : "FAIL"} ${what}`);
  if (!ok) failed++;
};

for (const scheme of ["dark", "light"]) {
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 }, deviceScaleFactor: 2, colorScheme: scheme });
  const page = await context.newPage();
  page.on("pageerror", (e) => console.error("pageerror:", e.message));
  await page.addInitScript({ path: FRAMES_SHIM });
  // A proof about macOS keys: pin the platform after the shim's Linux pin.
  await page.addInitScript(() => Object.defineProperty(Navigator.prototype, "platform", { get: () => "MacIntel", configurable: true }));
  await page.addInitScript(stubTauri);
  await page.goto(URL);
  await page.waitForSelector('[data-testid="workspace"]:not([hidden])');
  const ws = '[data-testid="workspace"]:not([hidden])';

  await page.keyboard.press("Meta+Shift+O");
  await page.waitForSelector('[data-testid="conn-popover"]');
  await page.click('[data-conn-id="pg"]');
  await page.waitForSelector(`${ws}[data-conn-state="connected"]`);

  // 1. The schema column's `…`: the Agents row.
  await page.click(`${ws} [data-testid="zone-menu"][data-zone="panel"]`);
  await page.waitForSelector('[data-menu="zone-panel"]');
  await page.hover('[data-menu="zone-panel"] [data-item="agents"]');
  await page.waitForTimeout(250);
  const row = await page.$eval('[data-menu="zone-panel"] [data-item="agents"]', (el) => {
    const label = el.querySelector('[data-testid="grid-menu-label"]');
    const kbd = el.querySelector("kbd");
    const cs = getComputedStyle(label);
    const size = parseFloat(cs.fontSize);
    const lh = parseFloat(cs.lineHeight) || size * 1.2;
    const range = document.createRange();
    range.selectNodeContents(kbd);
    const glyphs = [...kbd.childNodes].map((n) => {
      const r = document.createRange();
      r.selectNodeContents(n);
      return r.getBoundingClientRect();
    });
    const gaps = glyphs.slice(1).map((g, i) => g.left - glyphs[i].right);
    return { size, lh, text: kbd.textContent, gaps };
  });
  check(row.lh >= row.size * 1.25, `${scheme}: Agents label line box ${row.lh}px for ${row.size}px text (room for the g)`);
  check(row.text === "⇧⌘A", `${scheme}: the keycap's text is still ${row.text}`);
  check(row.gaps.length === 2 && row.gaps.every((g) => g >= 1.2), `${scheme}: gaps between ⇧ ⌘ A: ${row.gaps.map((g) => g.toFixed(2)).join(", ")} px`);
  const box = await page.$eval('[data-menu="zone-panel"]', (el) => {
    const r = el.getBoundingClientRect();
    return { x: r.x, y: r.y, width: r.width, height: r.height };
  });
  await page.screenshot({ path: `${OUT}/${scheme}-1-panel-menu.png`, clip: box });
  const agentsRow = await page.$eval('[data-menu="zone-panel"] [data-item="agents"]', (el) => {
    const r = el.getBoundingClientRect();
    return { x: r.x - 6, y: r.y - 6, width: r.width + 12, height: r.height + 12 };
  });
  await page.screenshot({ path: `${OUT}/${scheme}-2-agents-row.png`, clip: agentsRow });
  console.log(`${OUT}/${scheme}-2-agents-row.png`);

  // 2. Every clipped text box on screen (menu open): its line box holds the descent.
  const tight = await page.evaluate(() => {
    const out = [];
    for (const el of document.querySelectorAll("body *")) {
      const cs = getComputedStyle(el);
      if (cs.overflow === "visible" && cs.overflowY === "visible") continue;
      if (![...el.childNodes].some((n) => n.nodeType === 3 && /[gjpqy]/.test(n.textContent))) continue;
      if (!el.getClientRects().length) continue;
      const size = parseFloat(cs.fontSize);
      const lh = cs.lineHeight === "normal" ? size * 1.2 : parseFloat(cs.lineHeight);
      if (lh < size * 1.15 && el.clientHeight < size * 1.15) out.push(`${el.className || el.tagName} ${lh}/${size}`);
    }
    return out;
  });
  check(tight.length === 0, `${scheme}: no clipped text box cuts descenders${tight.length ? ": " + tight.join("; ") : ""}`);
  await page.keyboard.press("Escape");

  // 3. ⌘K: a command row's keys.
  await page.keyboard.press("Meta+K");
  await page.waitForSelector('[data-testid="cp-search"]');
  await page.keyboard.type(">agents");
  await page.waitForTimeout(200);
  const cp = await page.$$eval('[data-testid="cp-row"] kbd[data-keys]', (els) => els.map((e) => ({ text: e.textContent, gaps: e.querySelectorAll(".key-gap").length })));
  check(cp.length > 0 && cp.every((k) => !/[⌘⇧⌥⌃]/.test(k.text) || k.gaps > 0), `${scheme}: ⌘K keycaps spaced (${cp.map((k) => k.text).join(" ")})`);
  await page.screenshot({ path: `${OUT}/${scheme}-3-palette.png` });
  await page.keyboard.press("Escape");
  await page.waitForTimeout(200);

  // 4. Hold ⌘: each badge fits its spaced keys.
  await page.keyboard.down("Meta");
  await page.waitForSelector(".cmd-hints[data-on]"); // Class on purpose: the badge layer has no other hook.
  await page.waitForTimeout(250);
  const badges = await page.$$eval("[data-key-hint]", (els) => els.map((e) => ({ text: e.textContent, fits: e.scrollWidth <= e.clientWidth + 0.5, h: e.getBoundingClientRect() })));
  check(badges.length > 0 && badges.every((b) => b.fits), `${scheme}: ${badges.length} ⌘-hold badges fit their keys`);
  await page.screenshot({ path: `${OUT}/${scheme}-4-cmd-hold.png` });
  await page.keyboard.up("Meta");
  await context.close();
}

await browser.close();
console.log(failed ? `${failed} check(s) failed` : "all checks passed");
process.exit(failed ? 1 : 0);
