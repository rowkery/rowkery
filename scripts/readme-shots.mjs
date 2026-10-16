#!/usr/bin/env node
// Captures the app screens the README and the website show, from the running app (Vite, a
// stubbed Tauri `invoke` with a demo storefront database), as a Mac would draw them:
//  - docs/readme/banner-{light,dark}.png: 1280x640 at 2x, the website's hero line on the left
//    and the app window (orders filtered to paid) on the right, with an agent's SELECT answered
//    and its DELETE refused over it;
//  - docs/readme/k-palette-{light,dark}.webp: ⌘K finding the orders tables (760x540 at 2x);
//  - docs/readme/log-{light,dark}.webp: the Agents page log with a refusal, a search and an
//    opened query with its access, request and response (860x589 at 2x);
//  - apps/web/assets/img/window-dark.webp: the whole window in dark (1280x800 at 2x), with the
//    toast of an agent's refused full read.
// The platform is pinned to macOS (⌘ labels, keys pressed with Meta). Writes PNGs to outDir
// (default /tmp/rowkery-proof/readme-shots); with --write it also converts them (Python's Pillow)
// into the repo paths above. Not a proof: it
// checks nothing beyond waiting for each screen.
//
//   cd apps/rowkery-tauri && npx vite --port 1420 &
//   node scripts/readme-shots.mjs [outDir] [--write]
import { createRequire } from "node:module";
import { mkdirSync, readFileSync } from "node:fs";
import { execSync, execFileSync } from "node:child_process";

const FRAMES_SHIM = new globalThis.URL("./lib/frames-shim.js", import.meta.url).pathname;
const ROOT = new globalThis.URL("../", import.meta.url).pathname;

const require = createRequire(import.meta.url);
let playwright;
try {
  playwright = require("playwright");
} catch {
  playwright = require(`${execSync("npm root -g").toString().trim()}/playwright`);
}
const args = process.argv.slice(2);
const WRITE = args.includes("--write");
const OUT = args.find((a) => !a.startsWith("--")) ?? "/tmp/rowkery-proof/readme-shots";
const URL = process.env.ROWKERY_DEV_URL ?? "http://localhost:1420/";
mkdirSync(OUT, { recursive: true });

// After the frames shim's Linux pin: a Mac.
function macPlatform() {
  const mac = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko)";
  for (const [prop, value] of [["platform", "MacIntel"], ["userAgent", mac]]) {
    Object.defineProperty(Navigator.prototype, prop, { get: () => value, configurable: true });
  }
}

function stubTauri() {
  localStorage.clear();
  const col = (name, type_name, extra = {}) => ({ name, type_name, nullable: true, ...extra });
  const id = col("id", "bigint", { nullable: false });
  const table = (name, rows, columns = [id], kind = "table", foreign_keys = []) => ({
    name,
    kind,
    columns,
    primary_key: kind === "table" ? ["id"] : [],
    indexes: kind === "table" ? [{ name: `${name}_pkey`, columns: ["id"], unique: true, primary: true }] : [],
    foreign_keys,
    row_estimate: { Approximate: rows },
    partition_of: null,
  });
  const ORDER_COLS = [
    ["id", "int8"],
    ["customer_id", "int8"],
    ["status", "order_status"],
    ["total", "numeric"],
    ["currency", "text"],
    ["placed_at", "timestamptz"],
  ];
  const orders = table(
    "orders",
    84000,
    ORDER_COLS.map(([n, t]) => col(n, t, { nullable: n !== "id" ? true : false })),
    "table",
    [{ name: "orders_customer_id_fkey", columns: ["customer_id"], ref_schema: "public", ref_table: "customers", ref_columns: ["id"], on_delete: "NO ACTION" }],
  );
  const catalog = {
    databases: [
      {
        name: "shop",
        schemas: [
          {
            name: "public",
            tables: [
              table("api_keys", 140),
              table("categories", 38),
              table("customers", 61000),
              table("events", 4100000),
              table("order_items", 310000),
              orders,
              table("products", 2400),
            ],
          },
          { name: "audit", tables: [table("changes", 2000000), table("daily_totals", 400, [col("day", "date")], "view")] },
        ],
      },
    ],
  };
  // The demo orders, newest first: one every 37 minutes.
  const PAID = new Set([0, 1, 3, 6, 9, 12, 13, 15, 18, 21, 24, 25, 27, 30, 33, 36, 37, 39, 42, 45]);
  const OTHER = ["shipped", "pending", "shipped", "refunded", "shipped", "cancelled"];
  const TOTALS = { 0: "12.00", 1: "91.19", 2: "170.38", 3: "249.57", 4: "68.76", 5: "147.95", 6: "227.14", 7: "46.33", 8: "125.52", 9: "204.71", 10: "23.90", 12: "182.28", 13: "261.47", 15: "159.85", 18: "137.42", 21: "114.99", 24: "92.56", 25: "171.75", 27: "70.13", 30: "47.70", 33: "25.27", 36: "262.84", 37: "82.03", 39: "240.41", 42: "218.00", 45: "195.55" };
  const CUR = ["EUR", "EUR", "GBP", "USD", "EUR", "SEK", "USD", "EUR", "EUR", "EUR", "GBP", "SEK", "EUR", "SEK", "USD", "EUR", "GBP", "SEK", "GBP", "SEK"];
  const CUR_AT = { 0: "EUR", 1: "EUR", 2: "GBP", 3: "USD", 4: "EUR", 5: "SEK", 6: "USD", 7: "EUR", 8: "EUR", 9: "EUR", 10: "GBP", 12: "EUR", 13: "SEK", 15: "EUR", 18: "GBP", 21: "SEK", 24: "EUR", 25: "EUR", 27: "USD", 30: "USD", 33: "EUR", 36: "EUR", 37: "SEK", 39: "EUR", 42: "SEK", 45: "SEK" };
  const base = Date.UTC(2026, 9, 14, 9, 41);
  const pad = (n) => String(n).padStart(2, "0");
  const ts = (ms) => {
    const d = new Date(ms);
    return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:00+00`;
  };
  const ROWS = Array.from({ length: 1200 }, (_, k) => {
    const paid = k <= 45 ? PAID.has(k) : k % 3 === 0 && k < 490;
    return {
      id: 84210 - k,
      customer_id: 3000 + ((37 * k) % 900),
      status: paid ? "paid" : OTHER[k % OTHER.length],
      total: TOTALS[k] ?? `${(((k * 7919) % 26000) / 100 + 10).toFixed(2)}`,
      currency: CUR_AT[k] ?? CUR[k % CUR.length],
      placed_at: ts(base - k * 37 * 60_000),
    };
  });
  const browseSql = (a) => {
    let sql = `SELECT * FROM ${a.schema}.${a.table}`;
    if (a.filter?.trim()) sql += ` WHERE (${a.filter.trim()})`;
    sql += " ORDER BY id DESC";
    if (a.limit) sql += ` LIMIT ${a.limit}`;
    return sql + ";";
  };
  const cell = (v) => (v === null ? "Null" : typeof v === "number" ? { Int: v } : { Text: v });

  const host = "prd.shop.internal";
  const scope = { databases: 1, mode: "picked", tables: 3, timeout_s: 10, max_rows: 200 };
  const conn = (cid, environment, h) => ({
    kind: "postgres",
    id: cid,
    name: "storefront",
    host: h,
    port: 5432,
    database: "shop",
    username: "app",
    environment,
    safe_mode: "confirm",
    allow_mcp: true,
    mcp_access: { shop: { mode: "picked", tables: ["public.orders", "public.order_items", "public.customers"] } },
  });
  const connections = [conn("prd", "prd", host), conn("stg", "stg", "stg.shop.internal")];
  // The page's clock is held at 11:45 (UTC), so the log reads 11:37 … 11:39.
  const clock = (h, m, s) => Date.UTC(2026, 9, 14, h, m, s);
  const session = clock(11, 30, 0);
  const answered = "select status, count(*) as orders, sum(total) as revenue from orders where placed_at > now() - interval '7 days' group by status order by orders desc";
  const log = [
    {
      session,
      client: "claude-code",
      ts: clock(11, 37, 19),
      tool: "query",
      connection: "prd",
      database: "shop",
      sql: answered,
      rows: 5,
      ms: 41,
      verdict: "ok",
      args: { connection: "storefront", database: "shop", sql: answered, max_rows: 200 },
      scope,
      bytes: 486,
    },
    { session, client: "claude-code", ts: clock(11, 38, 39), tool: "search_schema", connection: "stg", database: "shop", target: "checkout", verdict: "ok", bytes: 377, scope },
    {
      session,
      client: "claude-code",
      ts: clock(11, 39, 37),
      tool: "query",
      connection: "stg",
      database: "shop",
      sql: "select * from events where payload::text like '%checkout_failed%'",
      verdict: "Refused: the plan reads public.events (~4100000 rows) end to end.",
      scope,
    },
  ];
  window.__MCP_NEXT__ = [];
  let offset = 0;
  window.__TAURI_INTERNALS__ = {
    metadata: { currentWindow: { label: "main" }, currentWebview: { label: "main" } },
    transformCallback: () => 0,
    invoke: async (cmd, a) => {
      switch (cmd) {
        case "list_connections":
          return { connections: structuredClone(connections), active_connection_id: null };
        case "open_window":
          return { database: "shop", catalog: structuredClone(catalog), elapsed_ms: 28, cached: false, open_seq: 1 };
        case "browse_table_sql":
          return browseSql(a);
        case "count_rows":
          return /paid/.test(a?.filter ?? "") ? 168 : 84000;
        case "run_query": {
          const paid = /status = 'paid'/.test(a.sql);
          const rows = ROWS.filter((r) => !paid || r.status === "paid").slice(0, 1000);
          return {
            columns: ORDER_COLS.map(([name, type_name]) => ({ name, type_name })),
            rows: rows.map((r) => ORDER_COLS.map(([n]) => cell(r[n]))),
            row_count: rows.length,
            elapsed_ms: 4,
            error: null,
            cancelled: false,
          };
        }
        case "mcp_activity": {
          if (a.since == null || a.since > offset) {
            offset = log.length;
            return { entries: structuredClone(log), offset, reset: true };
          }
          const next = window.__MCP_NEXT__.splice(0);
          log.push(...next);
          offset = log.length;
          return { entries: next, offset, reset: false };
        }
        case "mcp_sample": {
          const e = log.find((x) => x.ts === a.ts);
          if (e?.sql !== answered) return null;
          return {
            session: e.session,
            ts: e.ts,
            text: '{"columns":["status","orders","revenue"],"rows":[["paid",1240,"86412.50"],["shipped",988,"70218.10"],["pending",212,"14930.00"],["refunded",31,"2210.40"],["cancelled",9,"612.00"]],"row_count":5,"more":false,"elapsed_ms":41,"types":["order_status","int8","numeric"]}',
            bytes: 486,
          };
        }
        case "probe_connection":
          return { ok: true, message: "PostgreSQL 16.4", elapsed_ms: 28 };
        default:
          return null;
      }
    },
  };
}

const browser = await playwright.chromium.launch({ executablePath: process.env.CHROMIUM_PATH ?? "/opt/pw-browsers/chromium" });
const ws = '[data-testid="workspace"]:not([hidden])';
const settle = (page) => page.waitForFunction((ws) => !document.querySelector(`${ws} [data-state="running"]`), ws);

// macOS draws the traffic lights over the title bar (trafficLightPosition 18, 24); a browser
// has none, so they are drawn where the native ones sit.
function trafficLights() {
  const add = () => {
    if (document.getElementById("shot-lights")) return;
    const box = document.createElement("div");
    box.id = "shot-lights";
    box.style.cssText = "position:fixed;left:18px;top:18px;display:flex;gap:8px;z-index:99999;pointer-events:none";
    for (const c of ["#ff5f57", "#febc2e", "#28c840"]) {
      const dot = document.createElement("i");
      dot.style.cssText = `display:block;width:12px;height:12px;border-radius:50%;background:${c};box-shadow:inset 0 0 0 0.5px rgba(0,0,0,0.18)`;
      box.append(dot);
    }
    document.body.append(box);
  };
  if (document.body) add();
  else document.addEventListener("DOMContentLoaded", add);
}

/** A fresh window at w x h, connected to storefront (prd), on the orders table. */
async function openApp(scheme, w, h, { filter = true } = {}) {
  const context = await browser.newContext({ viewport: { width: w, height: h }, deviceScaleFactor: 2, colorScheme: scheme, reducedMotion: "reduce", timezoneId: "UTC" });
  const page = await context.newPage();
  page.on("pageerror", (e) => console.error("pageerror:", e.message));
  await page.clock.setFixedTime(new Date("2026-10-14T11:45:00Z"));
  await page.addInitScript({ path: FRAMES_SHIM });
  await page.addInitScript(macPlatform);
  await page.addInitScript(stubTauri);
  await page.addInitScript(trafficLights);
  await page.goto(URL);
  await page.waitForFunction((s) => document.documentElement.dataset.theme === s, scheme);
  await page.waitForSelector(ws);
  await page.keyboard.press("Meta+Shift+O");
  await page.waitForSelector('[data-testid="conn-popover"]');
  await page.click('[data-conn-id="prd"]');
  await page.waitForSelector(`${ws}[data-conn-state="connected"]`);
  await page.click(`${ws} [data-table="shop.public.orders"] [data-testid="sb-row-main"]`);
  await page.waitForSelector(`${ws} [data-testid="results-grid-wrap"][data-row-count="1000"]`);
  await settle(page);
  if (filter) {
    await page.keyboard.press("Meta+f");
    await page.waitForSelector(`${ws} [data-sql-line] [data-chip-editor] [data-testid="sql-editor"]`);
    await page.keyboard.type("status = 'paid'");
    await page.keyboard.press("Enter");
    await page.waitForSelector(`${ws} [data-testid="results-grid-wrap"][data-row-count="168"]`);
    await settle(page);
  }
  await page.evaluate(() => document.fonts.ready);
  return { context, page };
}

const shot = async (page, name, clip) => {
  await page.mouse.move(640, 1);
  await page.waitForTimeout(600);
  const path = `${OUT}/${name}.png`;
  await page.screenshot({ path, ...(clip ? { clip } : {}) });
  console.log(path);
  return path;
};
const hideKeyStrip = (page) => page.addStyleTag({ content: '[data-testid="key-strip"], [data-testid="cmd-hints"] { visibility: hidden !important; }' });

const made = {};
for (const scheme of ["light", "dark"]) {
  // 1. The whole window (the banner's app; in dark, with the refusal toast, the website's hero).
  {
    const { context, page } = await openApp(scheme, 1280, 800);
    await hideKeyStrip(page);
    made[`window-${scheme}`] = await shot(page, `window-${scheme}`);
    if (scheme === "dark") {
      await page.evaluate(() => {
        window.__MCP_NEXT__.push({
          ts: Date.UTC(2026, 9, 14, 11, 43, 50),
          session: Date.UTC(2026, 9, 14, 11, 30, 0),
          client: "claude-code",
          tool: "query",
          connection: "prd",
          database: "shop",
          sql: "select * from events where payload::text like '%refund%'",
          verdict: "Refused: the plan reads public.events (~4100000 rows) end to end.",
        });
      });
      await page.waitForSelector("[data-toast-offer]", { timeout: 8000 });
      made["window-dark-toast"] = await shot(page, "window-dark-toast");
    }
    await context.close();
  }
  // 2. ⌘K finding the orders tables, in a narrow window with the sidebar hidden (⌘B).
  {
    const { context, page } = await openApp(scheme, 760, 540, { filter: false });
    await page.keyboard.press("Meta+b");
    await page.waitForSelector('[data-sidebar-hidden]');
    await page.keyboard.press("Meta+k");
    await page.waitForSelector('[data-testid="cp-panel"]');
    await page.keyboard.type("orders");
    await page.waitForTimeout(300);
    made[`k-palette-${scheme}`] = await shot(page, `k-palette-${scheme}`);
    await context.close();
  }
  // 3. The Agents page log, the prd query opened.
  {
    const { context, page } = await openApp(scheme, 1280, 1000, { filter: false });
    await page.click('[data-testid="sb-agents"]');
    await page.waitForSelector('[data-testid="agents-page"] [data-mcp-entry="2"]');
    await page.click('[data-mcp-entry="2"]');
    await page.waitForSelector('[data-mcp-entry="2"] [data-mcp-box="response"] .mcp-json'); // Class on purpose: the sample is drawn.
    await page.waitForTimeout(300);
    const boxes = await page.$$eval("[data-mcp-entry]", (els) => els.map((e) => e.getBoundingClientRect().toJSON()));
    const x = Math.min(...boxes.map((b) => b.x)) - 6;
    const y = Math.min(...boxes.map((b) => b.y)) - 6;
    const r = Math.max(...boxes.map((b) => b.right)) + 6;
    const bottom = Math.max(...boxes.map((b) => b.bottom)) + 6;
    console.log(`log clip ${Math.round(r - x)}x${Math.round(bottom - y)}`);
    made[`log-${scheme}`] = await shot(page, `log-${scheme}`, { x, y, width: Math.ceil(r - x), height: Math.ceil(bottom - y) });
    await context.close();
  }
}

// 4. The banner: the website's hero line beside the window, an agent's two calls over it.
const font = (f) => readFileSync(`${ROOT}apps/web/app/fonts/${f}`).toString("base64");
const engines = readFileSync(`${ROOT}apps/rowkery-tauri/src/engines.tsx`, "utf8");
const logo = (k) => new RegExp(`${k}: \\{[\\s\\S]*?logo: "([^"]+)"`).exec(engines)[1];
const markSrc = readFileSync(`${ROOT}apps/web/components/Mark.tsx`, "utf8");
const MARK = /MARK_D =\s*"([^"]+)"/.exec(markSrc)[1];
const MARK_BOX = /MARK_VIEW_BOX = "([^"]+)"/.exec(markSrc)[1];
const THEMES = {
  light: { bg: "#ffffff", fg: "#0a0a0a", grey: "#6b7076", copy: "#2b2e33", line: "#e4e4e7", card: "#ffffff", ok: "#16794a", no: "#c42b2b", tagBg: "#fde4e4", tagFg: "#b42318", shadow: "0 18px 50px rgba(0,0,0,0.10), 0 2px 8px rgba(0,0,0,0.05)" },
  dark: { bg: "#0a0a0a", fg: "#ffffff", grey: "#8b9097", copy: "#c9cdd2", line: "#2a2a2a", card: "#161616", ok: "#4cc38a", no: "#ff6b6b", tagBg: "rgba(255,107,107,0.16)", tagFg: "#ff8a8a", shadow: "0 18px 50px rgba(0,0,0,0.55)" },
};
const bannerHtml = (t, windowPng) => `<!doctype html><html><head><meta charset="utf-8"><style>
@font-face { font-family: Plex; src: url(data:font/woff2;base64,${font("ibm-plex-sans-latin-400-normal.woff2")}); font-weight: 400; }
@font-face { font-family: Plex; src: url(data:font/woff2;base64,${font("ibm-plex-sans-latin-500-normal.woff2")}); font-weight: 500; }
@font-face { font-family: Plex; src: url(data:font/woff2;base64,${font("ibm-plex-sans-latin-600-normal.woff2")}); font-weight: 600; }
@font-face { font-family: PlexMono; src: url(data:font/woff2;base64,${font("ibm-plex-mono-latin-400-normal.woff2")}); font-weight: 400; }
html, body { margin: 0; width: 1280px; height: 640px; overflow: hidden; background: ${t.bg}; color: ${t.fg}; font-family: Plex, sans-serif; -webkit-font-smoothing: antialiased; }
.copy { position: absolute; left: 72px; top: 152px; width: 410px; }
.brand { display: flex; align-items: center; gap: 16px; font-weight: 500; font-size: 34px; letter-spacing: -0.01em; }
.brand svg { width: 44px; height: 47px; color: ${t.fg}; }
h1 { margin: 34px 0 0; font-weight: 500; font-size: 52px; line-height: 1.04; letter-spacing: -0.025em; }
h1 span { display: block; color: ${t.grey}; }
p { margin: 26px 0 0; font-size: 19px; line-height: 1.45; color: ${t.copy}; }
.eng { margin-top: 30px; display: flex; align-items: center; gap: 18px; font-size: 16px; color: ${t.grey}; }
.eng span { display: flex; align-items: center; gap: 8px; }
.eng svg { width: 16px; height: 16px; fill: currentColor; }
.eng i { width: 1px; height: 16px; background: ${t.line}; }
.win { position: absolute; left: 576px; top: 124px; width: 640px; height: 400px; border-radius: 10px; overflow: hidden; border: 1px solid ${t.line}; box-shadow: ${t.shadow}; }
.win img { display: block; width: 640px; height: 400px; }
.card { position: absolute; background: ${t.card}; border: 1px solid ${t.line}; border-radius: 10px; box-shadow: ${t.shadow}; padding: 14px 16px 14px; }
.head { display: flex; align-items: center; gap: 8px; font-size: 15px; }
.head b { font-weight: 600; }
.head em { font-style: normal; color: ${t.grey}; }
.tag { font-size: 13px; padding: 1px 7px; border-radius: 4px; background: ${t.tagBg}; color: ${t.tagFg}; font-weight: 500; }
pre { margin: 10px 0 0; font-family: PlexMono, monospace; font-size: 14px; line-height: 1.36; white-space: pre-wrap; }
.v { margin-top: 10px; font-size: 15px; display: flex; align-items: center; gap: 9px; font-weight: 500; }
.ok { color: ${t.ok}; } .no { color: ${t.no}; }
</style></head><body>
<div class="copy">
  <div class="brand"><svg viewBox="${MARK_BOX}"><path d="${MARK}" fill="currentColor" fill-rule="evenodd"/></svg>Rowkery</div>
  <h1>Query it yourself.<span>Or ask your agent.</span></h1>
  <p>A fast Mac app for Postgres and SQLite. Your agent can read through it. Only you can change your data.</p>
  <div class="eng"><span><svg viewBox="0 0 24 24"><path d="${logo("postgres")}"/></svg>PostgreSQL</span><i></i><span><svg viewBox="0 0 24 24"><path d="${logo("sqlite")}"/></svg>SQLite</span><i></i><span>macOS</span></div>
</div>
<div class="win"><img src="data:image/png;base64,${readFileSync(windowPng).toString("base64")}"></div>
<div class="card" style="left:880px;top:64px;width:282px">
  <div class="head"><b>Agent</b><em>query</em><span class="tag">prd</span></div>
  <pre>select status, sum(total) from orders group by status</pre>
  <div class="v ok">✓ 5 rows · 41 ms</div>
</div>
<div class="card" style="left:800px;top:452px;width:282px">
  <div class="head"><b>Agent</b><em>query</em><span class="tag">prd</span></div>
  <pre>delete from orders where status = 'cancelled'</pre>
  <div class="v no">✕ Refused: DELETE is not a read</div>
</div>
</body></html>`;
for (const scheme of ["light", "dark"]) {
  const context = await browser.newContext({ viewport: { width: 1280, height: 640 }, deviceScaleFactor: 2, colorScheme: scheme });
  const page = await context.newPage();
  await page.setContent(bannerHtml(THEMES[scheme], made[`window-${scheme}`]));
  await page.evaluate(() => document.fonts.ready);
  made[`banner-${scheme}`] = await shot(page, `banner-${scheme}`);
  await context.close();
}
await browser.close();

// 5. Into the repo (Python's Pillow converts): WebP at quality 86, the banners as optimised
// lossless PNG (about 300 KB each).
if (WRITE) {
  const PY = `import sys
from PIL import Image
src, dest = sys.argv[1], sys.argv[2]
im = Image.open(src).convert("RGB")
if dest.endswith(".webp"):
    im.save(dest, "WEBP", quality=86, method=6)
else:
    im.save(dest, optimize=True)`;
  const convert = (src, dest) => execFileSync("python3", ["-I", "-c", PY, src, `${ROOT}${dest}`]);
  for (const s of ["light", "dark"]) {
    convert(made[`banner-${s}`], `docs/readme/banner-${s}.png`);
    convert(made[`k-palette-${s}`], `docs/readme/k-palette-${s}.webp`);
    convert(made[`log-${s}`], `docs/readme/log-${s}.webp`);
  }
  convert(made["window-dark-toast"], "apps/web/assets/img/window-dark.webp");
  console.log("wrote docs/readme/* and apps/web/assets/img/window-dark.webp");
}
