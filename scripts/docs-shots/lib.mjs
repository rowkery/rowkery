// Shared helpers for the docs screens (scripts/docs-shots/*.mjs): the running app (Vite) with a
// stubbed Tauri `invoke` and a demo storefront database, drawn as a Mac draws it (⌘ labels, keys
// pressed with Meta, traffic lights) in the dark scheme the docs use.
//
// A scene file adds what its screens need on top of the base stub with `more`: a function run in
// the page that sets `window.__STUB_MORE__ = async (cmd, args, base) => …`. It answers the
// commands it knows and returns `undefined` for the rest, which fall through to the base stub
// (`base(cmd, args)` calls the base directly).
//
// `shot()` saves a PNG to OUT and, with --write, a WebP into apps/docs/public/img; `record()`
// films a flow (CDP screencast) into an MP4 plus a WebP poster in apps/docs/public/clips.
// Not a proof: nothing here checks the app beyond waiting for each screen.
import { createRequire } from "node:module";
import { mkdirSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { execSync, execFileSync } from "node:child_process";

export const ROOT = new globalThis.URL("../../", import.meta.url).pathname;
const FRAMES_SHIM = `${ROOT}scripts/lib/frames-shim.js`;

const require = createRequire(import.meta.url);
export function playwright() {
  try {
    return require("playwright");
  } catch {
    return require(`${execSync("npm root -g").toString().trim()}/playwright`);
  }
}

const args = process.argv.slice(2);
export const WRITE = args.includes("--write");
/** Only the screens whose name contains one of these (`--only=quick-look,edit`). */
const ONLY = (args.find((a) => a.startsWith("--only="))?.slice(7) ?? "").split(",").filter(Boolean);
export const OUT = args.find((a) => !a.startsWith("--")) ?? "/tmp/rowkery-proof/docs-shots";
const URL = process.env.ROWKERY_DEV_URL ?? "http://localhost:1420/";
mkdirSync(OUT, { recursive: true });
export const wanted = (name) => !ONLY.length || ONLY.some((o) => name.includes(o));

// After the frames shim's Linux pin: a Mac.
function macPlatform() {
  const mac = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko)";
  for (const [prop, value] of [["platform", "MacIntel"], ["userAgent", mac]]) {
    Object.defineProperty(Navigator.prototype, prop, { get: () => value, configurable: true });
  }
}

/** The base stub: two saved connections to a storefront database (prd and stg), the orders table. */
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
  const CUSTOMER_COLS = [
    ["id", "int8"],
    ["name", "text"],
    ["email", "text"],
    ["country", "text"],
    ["created_at", "timestamptz"],
  ];
  const orders = table(
    "orders",
    84000,
    ORDER_COLS.map(([n, t]) => col(n, t, { nullable: n !== "id" })),
    "table",
    [{ name: "orders_customer_id_fkey", columns: ["customer_id"], ref_schema: "public", ref_table: "customers", ref_columns: ["id"], on_delete: "NO ACTION" }],
  );
  orders.indexes.push({ name: "orders_status_placed_at_idx", columns: ["status", "placed_at"], unique: false, primary: false });
  const customers = table("customers", 61000, CUSTOMER_COLS.map(([n, t]) => col(n, t, { nullable: n !== "id" })));
  const catalog = {
    search_path: ["public"],
    enums: [{ schema: "public", name: "order_status", labels: ["pending", "paid", "shipped", "refunded", "cancelled"] }],
    databases: [
      {
        name: "shop",
        schemas: [
          {
            name: "public",
            tables: [
              table("api_keys", 140),
              table("categories", 38),
              customers,
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
  const CUR = ["EUR", "EUR", "GBP", "USD", "EUR", "SEK", "USD", "EUR", "EUR", "EUR", "GBP", "SEK", "EUR", "SEK", "USD", "EUR", "GBP", "SEK", "GBP", "SEK"];
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
      total: `${(((k * 7919) % 26000) / 100 + 10).toFixed(2)}`,
      currency: CUR[k % CUR.length],
      placed_at: ts(base - k * 37 * 60_000),
    };
  });
  const FIRST = ["Ada", "Linus", "Grace", "Ken", "Barbara", "Edsger", "Frances", "Dennis", "Margaret", "Donald", "Radia", "Niklaus"];
  const LAST = ["Lovelace", "Torvalds", "Hopper", "Thompson", "Liskov", "Dijkstra", "Allen", "Ritchie", "Hamilton", "Knuth", "Perlman", "Wirth"];
  const COUNTRY = ["GB", "FI", "US", "US", "US", "NL", "US", "US", "US", "US", "US", "CH"];
  const CUSTOMERS = Array.from({ length: 900 }, (_, k) => ({
    id: 3000 + k,
    name: `${FIRST[k % 12]} ${LAST[(k * 5) % 12]}`,
    email: `${FIRST[k % 12].toLowerCase()}.${LAST[(k * 5) % 12].toLowerCase()}${k}@example.com`,
    country: COUNTRY[k % 12],
    created_at: ts(base - (900 - k) * 26 * 3600_000),
  }));
  const browseSql = (a) => {
    let sql = `SELECT * FROM ${a.schema}.${a.table}`;
    if (a.filter?.trim()) sql += ` WHERE (${a.filter.trim()})`;
    sql += " ORDER BY id DESC";
    if (a.limit) sql += ` LIMIT ${a.limit}`;
    return sql + ";";
  };
  const cell = (v) => (v === null ? "Null" : typeof v === "number" ? { Int: v } : { Text: v });
  const result = (cols, rows) => ({
    columns: cols.map(([name, type_name]) => ({ name, type_name })),
    rows: rows.map((r) => cols.map(([n]) => cell(r[n]))),
    row_count: rows.length,
    elapsed_ms: 4,
    error: null,
    cancelled: false,
  });
  const conn = (cid, environment, h, extra = {}) => ({
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
    ...extra,
  });
  const connections = [conn("prd", "prd", "prd.shop.internal"), conn("stg", "stg", "stg.shop.internal")];
  window.__DOCS__ = { catalog, connections, ROWS, CUSTOMERS, ORDER_COLS, CUSTOMER_COLS, result, cell, browseSql, ts };
  const baseInvoke = async (cmd, a) => {
    switch (cmd) {
      case "list_connections":
        return { connections: structuredClone(connections), active_connection_id: null };
      case "open_window":
        return { database: "shop", catalog: structuredClone(catalog), elapsed_ms: 28, cached: false, open_seq: 1 };
      case "browse_table_sql":
        return browseSql(a);
      case "count_rows":
        return /paid/.test(a?.filter ?? "") ? 168 : a?.table === "customers" ? 61000 : 84000;
      case "run_query": {
        const sql = a.sql ?? "";
        if (/\bcustomers\b/i.test(sql) && !/\borders\b/i.test(sql)) {
          const m = /\bid\s*=\s*(\d+)/i.exec(sql);
          const rows = m ? CUSTOMERS.filter((c) => c.id === Number(m[1])) : CUSTOMERS.slice().reverse();
          return result(CUSTOMER_COLS, rows.slice(0, 1000));
        }
        const paid = /status = 'paid'/.test(sql);
        const rows = ROWS.filter((r) => !paid || r.status === "paid").slice(0, 1000);
        return result(ORDER_COLS, rows);
      }
      case "mcp_activity":
        return { entries: [], offset: 0, reset: true };
      case "probe_connection":
        return { ok: true, message: "PostgreSQL 16.4", elapsed_ms: 28 };
      default:
        return null;
    }
  };
  window.__TAURI_INTERNALS__ = {
    metadata: { currentWindow: { label: "main" }, currentWebview: { label: "main" } },
    transformCallback: () => 0,
    invoke: async (cmd, a) => {
      if (window.__STUB_MORE__) {
        const got = await window.__STUB_MORE__(cmd, a, baseInvoke);
        if (got !== undefined) return got;
      }
      return baseInvoke(cmd, a);
    },
  };
}

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

let browser;
export async function launch() {
  browser ??= await playwright().chromium.launch({ executablePath: process.env.CHROMIUM_PATH ?? "/opt/pw-browsers/chromium" });
  return browser;
}
export async function close() {
  await browser?.close();
}

export const WS = '[data-testid="workspace"]:not([hidden])';
export const settle = (page) => page.waitForFunction((ws) => !document.querySelector(`${ws} [data-state="running"]`), WS);

/**
 * A fresh window at w x h. `connect` (default "prd") picks a saved connection, `table` (default
 * "orders") opens it; `connect: false` stops at the empty window. `more` extends the stub,
 * `init` runs in the page before the app (e.g. seeding config).
 */
export async function openApp({ w = 1280, h = 800, connect = "prd", table = "orders", more, init, scheme = "dark" } = {}) {
  await launch();
  const context = await browser.newContext({ viewport: { width: w, height: h }, deviceScaleFactor: 2, colorScheme: scheme, reducedMotion: "reduce", timezoneId: "UTC" });
  const page = await context.newPage();
  page.on("pageerror", (e) => console.error("pageerror:", e.message));
  await page.clock.setFixedTime(new Date("2026-10-14T11:45:00Z"));
  await page.addInitScript({ path: FRAMES_SHIM });
  await page.addInitScript(macPlatform);
  if (init) await page.addInitScript(init);
  await page.addInitScript(stubTauri);
  if (more) await page.addInitScript(more);
  await page.addInitScript(trafficLights);
  await page.goto(URL);
  await page.waitForFunction((s) => document.documentElement.dataset.theme === s, scheme);
  await page.waitForSelector(WS);
  if (connect) {
    await page.keyboard.press("Meta+Shift+O");
    await page.waitForSelector('[data-testid="conn-popover"]');
    await page.click(`[data-conn-id="${connect}"]`);
    await page.waitForSelector(`${WS}[data-conn-state="connected"]`);
    if (table) {
      await page.click(`${WS} [data-table="shop.public.${table}"] [data-testid="sb-row-main"]`);
      await page.waitForSelector(`${WS} [data-testid="results-grid-wrap"][data-row-count]`);
      await settle(page);
    }
  }
  await page.evaluate(() => document.fonts.ready);
  return { context, page };
}

/** Types a filter into the table tab's WHERE line (⌘F) and waits for the rows. */
export async function filter(page, text, rows) {
  await page.keyboard.press("Meta+f");
  await page.waitForSelector(`${WS} [data-sql-line] [data-chip-editor] [data-testid="sql-editor"]`);
  await page.keyboard.type(text);
  await page.keyboard.press("Enter");
  if (rows != null) await page.waitForSelector(`${WS} [data-testid="results-grid-wrap"][data-row-count="${rows}"]`);
  await settle(page);
}

export const hideKeyStrip = (page) => page.addStyleTag({ content: '[data-key-strip], [data-key-strip-glyph], [data-testid="cmd-hints"] { visibility: hidden !important; }' });

const PY = `import sys
from PIL import Image
src, dest = sys.argv[1], sys.argv[2]
im = Image.open(src).convert("RGB")
im.save(dest, "WEBP", quality=86, method=6)`;
const made = [];

/**
 * Saves the page (or `clip`, a box in CSS px, or `el`, a selector padded by `pad`) as
 * OUT/name.png, and with --write as apps/docs/public/img/name.webp. Returns the CSS size, which
 * is what the page's <Shot> takes as width / height (the file is 2x).
 */
export async function shot(page, name, { clip, el, pad = 0, mouse = true } = {}) {
  if (!wanted(name)) return null;
  if (mouse) await page.mouse.move(640, 1);
  await page.waitForTimeout(500);
  if (el) {
    const b = await page.locator(el).first().boundingBox();
    clip = { x: Math.max(0, b.x - pad), y: Math.max(0, b.y - pad), width: Math.ceil(b.width + pad * 2), height: Math.ceil(b.height + pad * 2) };
  }
  const path = `${OUT}/${name}.png`;
  await page.screenshot({ path, ...(clip ? { clip } : {}) });
  const size = clip ? { width: Math.round(clip.width), height: Math.round(clip.height) } : page.viewportSize();
  made.push({ name, ...size });
  if (WRITE) execFileSync("python3", ["-I", "-c", PY, path, `${ROOT}apps/docs/public/img/${name}.webp`]);
  console.log(`${path}  ${size.width}x${size.height}`);
  return size;
}

/**
 * Films `fn(page)` as OUT/name.mp4 (and with --write apps/docs/public/clips/name.mp4 plus a
 * name.webp poster, its last frame). Frames come from the CDP screencast at the page's 2x, held
 * for as long as they were on screen; `hold` keeps the last frame that many ms so the loop
 * pauses on the result.
 */
export async function record(page, name, fn, { hold = 1600 } = {}) {
  if (!wanted(name)) return null;
  const dir = `${OUT}/${name}-frames`;
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  const cdp = await page.context().newCDPSession(page);
  const vp = page.viewportSize();
  const frames = [];
  cdp.on("Page.screencastFrame", async (f) => {
    const file = `${dir}/${String(frames.length).padStart(5, "0")}.png`;
    writeFileSync(file, Buffer.from(f.data, "base64"));
    frames.push({ file, t: f.metadata.timestamp });
    await cdp.send("Page.screencastFrameAck", { sessionId: f.sessionId }).catch(() => {});
  });
  await page.mouse.move(vp.width - 2, 1);
  await cdp.send("Page.startScreencast", { format: "png", maxWidth: vp.width * 2, maxHeight: vp.height * 2, everyNthFrame: 1 });
  await page.waitForTimeout(700);
  await fn(page);
  await page.waitForTimeout(300);
  await cdp.send("Page.stopScreencast");
  await page.waitForTimeout(200);
  if (!frames.length) throw new Error(`${name}: no frames`);
  // ffmpeg's concat list: each frame held until the next one arrived.
  const list = frames
    .map((f, i) => {
      const next = frames[i + 1]?.t ?? f.t + hold / 1000;
      return `file '${f.file}'\nduration ${Math.max(0.016, next - f.t).toFixed(3)}`;
    })
    .join("\n");
  writeFileSync(`${dir}/list.txt`, `${list}\nfile '${frames.at(-1).file}'\n`);
  const mp4 = `${OUT}/${name}.mp4`;
  execFileSync("ffmpeg", ["-y", "-loglevel", "error", "-f", "concat", "-safe", "0", "-i", `${dir}/list.txt`, "-vf", `fps=30,scale=${vp.width * 2}:${vp.height * 2}:flags=lanczos,format=yuv420p`, "-c:v", "libx264", "-preset", "slow", "-crf", "20", "-movflags", "+faststart", "-an", mp4]);
  console.log(`${mp4}  ${vp.width}x${vp.height}, ${frames.length} frames`);
  if (WRITE) {
    mkdirSync(`${ROOT}apps/docs/public/clips`, { recursive: true });
    execFileSync("cp", [mp4, `${ROOT}apps/docs/public/clips/${name}.mp4`]);
    execFileSync("python3", ["-I", "-c", PY, frames.at(-1).file, `${ROOT}apps/docs/public/clips/${name}.webp`]);
  }
  return vp;
}

/** Prints each screen's CSS size once a scene file is done, for the pages' width / height. */
export function sizes() {
  for (const m of made) console.log(`${m.name}: width={${m.width}} height={${m.height}}`);
  return existsSync(OUT);
}
