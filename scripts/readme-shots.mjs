#!/usr/bin/env node
// Captures the app screens the README shows, from the running app (Vite, the docs' stubbed Tauri
// `invoke` with its demo storefront database), as a Mac would draw them, in both schemes:
//  - docs/readme/banner-{light,dark}.png: 1280x640 at 2x, the website's hero line on the left
//    and the app window (orders filtered to paid) on the right, with an agent's SELECT answered
//    and its DELETE refused over it;
//  - docs/readme/k-palette-{light,dark}.webp: ⌘K finding the orders tables (760x540 at 2x);
//  - docs/readme/agents-{light,dark}.webp: the Agents inbox, a proposed change opened with its
//    dry run done, the activity log under it;
//  - docs/readme/health-{light,dark}.webp: the Health tab with a finding opened beside it.
// Writes PNGs to outDir (default /tmp/rowkery-proof/docs-shots); with --commit it also converts
// them (Python's Pillow) into the repo paths above (--write is the docs' flag and is refused here). Not a proof: it checks nothing beyond waiting
// for each screen.
//
//   cd apps/rowkery-tauri && npx vite --port 1420 &
//   node scripts/readme-shots.mjs [outDir] [--commit]
import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { openApp, shot, close, launch, filter, hideKeyStrip, WS, OUT, ROOT } from "./docs-shots/lib.mjs";

const COMMIT = process.argv.includes("--commit");
if (process.argv.includes("--write")) throw new Error("--write would write the docs' images; use --commit for docs/readme");

/** What the README's screens need on top of the base stub (runs in the page). */
function more() {
  const D = window.__DOCS__;
  const T = (h, m, s = 0) => Date.UTC(2026, 9, 14, h, m, s);
  const [prd] = D.connections;
  prd.mcp_until = T(12, 30);

  // The log: a morning's calls from Claude Code, newest first on screen.
  const session = T(11, 30);
  const base = { session, client: "claude-code", connection: "prd", database: "shop" };
  const scope = { databases: 1, mode: "picked", tables: 3, timeout_s: 10 };
  const revenue = "select status, count(*) as orders, sum(total) as revenue from orders where placed_at > now() - interval '7 days' group by status order by orders desc";
  const items = "select product_id, sum(quantity) as sold from order_items group by product_id order by sold desc limit 10";
  const log = [
    { session, client: "claude-code", ts: T(11, 31, 2), tool: "list_connections", rows: 1, verdict: "ok", args: {}, bytes: 168 },
    { ...base, ts: T(11, 31, 11), tool: "describe_table", target: "orders", verdict: "ok", args: { connection: "storefront", table: "orders" }, scope, bytes: 1288 },
    { ...base, ts: T(11, 32, 40), tool: "query", sql: revenue, rows: 5, ms: 41, verdict: "ok", args: { connection: "storefront", sql: revenue }, scope: { ...scope, max_rows: 200 }, bytes: 265 },
    {
      ...base,
      ts: T(11, 39, 37),
      tool: "query",
      sql: items,
      verdict: "Refused: the plan reads public.order_items (~310000 rows; indexed: (id)) end to end. Filter on an indexed column, or aggregate a narrower range.",
      args: { connection: "storefront", sql: items },
      scope: { ...scope, max_rows: 200 },
    },
    { ...base, ts: T(11, 44, 52), tool: "propose_change", target: "orders", verdict: "ok", args: { connection: "storefront", statements: ["UPDATE orders SET status = 'refunded' WHERE id IN (84207, 84204)"] }, scope, bytes: 96 },
  ];
  let offset = 0;

  // A proposed change: two double-charged orders marked refunded.
  const sql = "UPDATE orders SET status = 'refunded' WHERE id IN (84207, 84204)";
  const proposal = {
    id: "p_3f9a1c07b2e4",
    ts: T(11, 44, 52),
    connection: "prd",
    database: "shop",
    sql,
    reason: "Orders 84207 and 84204 were charged twice (Stripe charges ch_8812 and ch_8820 were refunded this morning), but both still say paid.",
    expect_rows: 2,
    client: "claude-code",
  };
  const plan = { connection_name: "storefront", statements: [{ verb: "UPDATE", target: "orders", sql, destructive: false, triggers: [{ name: "orders_audit", event: "UPDATE" }] }] };
  const cols = D.ORDER_COLS.map(([n]) => n);
  const row = (id) => {
    const r = D.ROWS.find((x) => x.id === id);
    return cols.map((c) => r[c]);
  };
  const after = (id) => row(id).map((v, i) => (cols[i] === "status" ? "refunded" : v));
  const dry = {
    proposal,
    connection_name: "storefront",
    statements: [{ verb: "UPDATE", target: "orders", sql, destructive: false, rows: 2, columns: cols, key: ["id"], changed: ["status"], shown: [84207, 84204].map((id) => ({ before: row(id), after: after(id) })), triggers: ["orders_audit"] }],
  };

  // The Health tab's report, only while __HEALTH__ is set (the once-a-day toast stays out of the
  // other screens); the proposal only while __PROPOSALS__ is (its badge stays off the banner).
  const GB = 1024 ** 3;
  const item = (over) => ({ schema: "public", table: "orders", name: null, bytes: null, fix: null, ...over });
  const found = (check, severity, trust, items) => ({ check, severity, trust, state: "found", items });
  const fine = (check, severity) => ({ check, severity, trust: "", state: "fine" });
  const health = () => ({
    database: "shop",
    server: "Postgres 16.4",
    size: { total_bytes: 48.2 * GB, table_bytes: 31 * GB, index_bytes: 17 * GB },
    cache_hit: 0.994,
    connections: { used: 42, max: 100, active: 6 },
    stats_since: Math.floor(Date.now() / 1000) - 49 * 86_400,
    transaction_age: 0.12,
    checks: [
      found("ids_running_out", "soon", "The date assumes inserts keep the pace seen since the statistics were last reset.", [
        item({ name: "id", detail: { kind: "ids_running_out", type_name: "integer", used: 1_739_461_754, max: 2_147_483_647, days_left: 36 }, fix: "ALTER TABLE public.orders ALTER COLUMN id TYPE bigint;\nALTER SEQUENCE public.orders_id_seq AS bigint;" }),
      ]),
      found("unused_indexes", "waste", "Usage counts come from this server only.", [
        item({ name: "orders_status_idx", bytes: 2.6 * GB, detail: { kind: "unused_index" }, fix: "DROP INDEX CONCURRENTLY public.orders_status_idx;" }),
        item({ table: "events", name: "events_kind_created_idx", bytes: 1.3 * GB, detail: { kind: "unused_index" }, fix: "DROP INDEX CONCURRENTLY public.events_kind_created_idx;" }),
      ]),
      fine("transaction_age", "soon"),
      fine("replication_slots", "soon"),
      found("foreign_keys_without_index", "slow", "The row count is the planner's estimate.", [
        item({ table: "order_items", name: "order_items_order_id_fkey", detail: { kind: "foreign_key_without_index", constraint: "order_items_order_id_fkey", columns: ["order_id"], parent_schema: "public", parent_table: "orders", rows: 310_000 }, fix: "CREATE INDEX CONCURRENTLY ON public.order_items (order_id);" }),
      ]),
      found("dead_rows", "upkeep", "Row counts are estimates kept by the statistics collector.", [
        item({ table: "events", bytes: 12.6 * GB, detail: { kind: "dead_rows", dead: 1_100_000, live: 3_000_000, vacuumed_secs_ago: 9 * 86_400 }, fix: "VACUUM (ANALYZE) public.events;" }),
      ]),
      fine("duplicate_indexes", "tidy"),
      fine("never_analyzed", "upkeep"),
      fine("long_transactions", "upkeep"),
    ],
    slow_queries: {
      state: "ranked",
      partial: false,
      queries: [
        { query: "SELECT * FROM orders WHERE customer_id = $1 ORDER BY placed_at DESC", user: "app", calls: 84_000, total_ms: 17_808_000, mean_ms: 212, rows: 840_000, share: 0.62 },
        { query: "UPDATE events SET seen = true WHERE user_id = $1 AND seen = false", user: "app", calls: 310_000, total_ms: 14_880_000, mean_ms: 48, rows: 310_000, share: 0.21 },
        { query: "SELECT count(*) FROM order_items WHERE order_id = $1", user: "app", calls: 96_000, total_ms: 2_976_000, mean_ms: 31, rows: 96_000, share: 0.04 },
      ],
    },
  });

  window.__STUB_MORE__ = async (cmd, a) => {
    switch (cmd) {
      case "mcp_activity": {
        if (a.since == null || a.since > offset) {
          offset = log.length;
          return { entries: structuredClone(log), offset, reset: true };
        }
        return { entries: [], offset, reset: false };
      }
      case "mcp_sample": {
        const e = log.find((x) => x.ts === a.ts);
        if (e?.sql !== revenue) return null;
        const text = '{"columns":["status","orders","revenue"],"rows":[["paid",1240,"86412.50"],["shipped",988,"70218.10"],["pending",212,"14930.00"],["refunded",31,"2210.40"],["cancelled",9,"612.00"]],"row_count":5,"more":false,"elapsed_ms":41,"types":["order_status","int8","numeric"]}';
        return { session: e.session, ts: e.ts, text, bytes: text.length };
      }
      case "proposals_waiting":
        return window.__PROPOSALS__ ? [structuredClone(proposal)] : [];
      case "proposal_plan":
        return structuredClone(plan);
      case "proposal_dry_run":
        await new Promise((r) => setTimeout(r, 300));
        return structuredClone(dry);
      case "database_health":
        return window.__HEALTH__ ? health() : null;
      default:
        return undefined;
    }
  };
}

const made = {};
const take = async (page, name) => {
  await shot(page, name);
  made[name] = `${OUT}/${name}.png`;
};

for (const scheme of ["light", "dark"]) {
  // 1. The whole window (the banner's app): orders filtered to paid.
  {
    const { context, page } = await openApp({ w: 1280, h: 800, more, scheme });
    await filter(page, "status = 'paid'", 168);
    await hideKeyStrip(page);
    await take(page, `window-${scheme}`);
    await context.close();
  }
  // 2. ⌘K finding the orders tables, in a narrow window with the sidebar hidden (⌘B).
  {
    const { context, page } = await openApp({ w: 760, h: 540, more, scheme });
    await page.keyboard.press("Meta+b");
    await page.waitForSelector("[data-sidebar-hidden]");
    await page.keyboard.press("Meta+k");
    await page.waitForSelector('[data-testid="cp-panel"]');
    await page.keyboard.type("orders");
    await page.waitForTimeout(300);
    await take(page, `k-palette-${scheme}`);
    await context.close();
  }
  // 3. The Agents inbox: the proposal opened, its dry run done, the log under it.
  {
    const { context, page } = await openApp({ w: 1280, h: 720, more, scheme, init: () => (window.__PROPOSALS__ = true) });
    await hideKeyStrip(page);
    await page.click('[data-testid="sb-agents"]');
    await page.waitForSelector('[data-testid="agents-page"] [data-proposal-id="p_3f9a1c07b2e4"]');
    await page.click('[data-proposal-id="p_3f9a1c07b2e4"]');
    await page.waitForSelector('[data-testid="pp-dry-run"]');
    await page.click('[data-testid="pp-dry-run"]');
    await page.waitForSelector('[data-testid="pp-dry"][data-state="done"]');
    await page.waitForTimeout(300);
    await take(page, `agents-${scheme}`);
    await context.close();
  }
  // 4. The Health tab, the IDs finding opened beside it.
  {
    const { context, page } = await openApp({ w: 1280, h: 840, more, scheme, init: () => (window.__HEALTH__ = true) });
    await hideKeyStrip(page);
    await page.addStyleTag({ content: "[data-toast] { display: none !important; }" });
    await page.keyboard.press("Meta+k");
    await page.waitForSelector('[data-testid="cp-panel"]');
    await page.keyboard.type("Show health");
    await page.keyboard.press("Enter");
    await page.waitForSelector(`${WS} [data-health-check="ids_running_out"]`);
    await page.click(`${WS} [data-health-check="ids_running_out"]`);
    await page.waitForSelector(`${WS} [data-health-check="ids_running_out"][data-health-picked]`);
    await page.waitForTimeout(400);
    await take(page, `health-${scheme}`);
    await context.close();
  }
}

// 5. The banner: the website's hero line beside the window, an agent's two calls over it.
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
.copy { position: absolute; left: 72px; top: 152px; width: 430px; }
.brand { display: flex; align-items: center; gap: 16px; font-weight: 500; font-size: 34px; letter-spacing: -0.01em; }
.brand svg { width: 44px; height: 47px; color: ${t.fg}; }
h1 { margin: 34px 0 0; font-weight: 500; font-size: 50px; line-height: 1.06; letter-spacing: -0.025em; }
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
  <h1>A database app for<span>you and your agent</span></h1>
  <p>Postgres and SQLite on your Mac. Quick from the keyboard, and safe to hand to Claude or any other agent.</p>
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
const browser = await launch();
for (const scheme of ["light", "dark"]) {
  const context = await browser.newContext({ viewport: { width: 1280, height: 640 }, deviceScaleFactor: 2, colorScheme: scheme });
  const page = await context.newPage();
  await page.setContent(bannerHtml(THEMES[scheme], made[`window-${scheme}`]));
  await page.evaluate(() => document.fonts.ready);
  await take(page, `banner-${scheme}`);
  await context.close();
}
await close();

// 6. Into the repo (Python's Pillow converts): WebP at quality 86, the banners as optimised
// lossless PNG (about 300 KB each).
if (COMMIT) {
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
    for (const n of ["k-palette", "agents", "health"]) convert(made[`${n}-${s}`], `docs/readme/${n}-${s}.webp`);
  }
  console.log("wrote docs/readme/*");
}
