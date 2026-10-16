#!/usr/bin/env node
// Safe mode proof without a Tauri webview or Postgres (stubbed `invoke`; the
// stub stands in for the core's check, which `cargo test -p rowkery-core safety`
// and `-p rowkery-bridge safe_mode` cover). Confirm writes holds a DELETE in the
// results card until ⇧⌘↵, Esc drops it, an UPDATE with no WHERE gets the red
// warning with the table's row count, Read-only refuses a write even on
// ⇧⌘↵, the panel head's shield (`data-shield`) shows each window's mode,
// "Change safe mode…" on a refusal opens the shield's menu, ⌘K switches the
// mode, a connection with safe mode off runs writes at once, and new
// connections start Off. A refusal's Change leads to the shield's menu.
//
//   cd apps/rowkery-tauri && npx vite --port 1420 &
//   node scripts/safe-mode-browser-proof.mjs [outDir]
import { createRequire } from "node:module";
import { mkdirSync, readFileSync } from "node:fs";
import { execSync } from "node:child_process";

// run_query answers stream as frames (src-tauri `Frame`); the stub keeps returning results.
const FRAMES_SHIM = new globalThis.URL("./lib/frames-shim.js", import.meta.url).pathname;

const require = createRequire(import.meta.url);
let playwright;
try {
  playwright = require("playwright");
} catch {
  const root = execSync("npm root -g").toString().trim();
  playwright = require(`${root}/playwright`);
}

const OUT = process.argv[2] ?? "/tmp/rowkery-proof/safe-mode";
const URL = process.env.ROWKERY_DEV_URL ?? "http://localhost:1420/";
const FONTS = process.env.ROWKERY_PROOF_FONTS;
mkdirSync(OUT, { recursive: true });

function stubTauri({ mac }) {
  if (mac) Object.defineProperty(Navigator.prototype, "platform", { get: () => "MacIntel" });

  const col = (name, type_name, nullable = false, def = null) => ({
    name,
    type_name,
    nullable,
    default: def,
  });
  const idx = (name, columns, o = {}) => ({
    name,
    columns,
    unique: o.unique ?? false,
    primary: o.primary ?? false,
    method: o.method ?? "btree",
    size_bytes: o.size ?? 16_384,
    scans: o.scans ?? 1_204,
  });
  const fk = (name, columns, ref_table, on_delete = "NO ACTION") => ({
    name,
    columns,
    ref_schema: "public",
    ref_table,
    ref_columns: ["id"],
    on_delete,
  });
  const table = (name, rows, extra = {}) => ({
    name,
    columns: [
      col("id", "bigint", false, `nextval('${name}_id_seq'::regclass)`),
      col("created_at", "timestamp with time zone", false, "now()"),
    ],
    primary_key: ["id"],
    indexes: [idx(`${name}_pkey`, ["id"], { unique: true, primary: true })],
    row_estimate: { Approximate: rows },
    partition_of: null,
    foreign_keys: [],
    table_bytes: rows * 120 + 8_192,
    index_bytes: rows * 24 + 8_192,
    ...extra,
  });
  const view = (name, columns, extra = {}) => ({
    name,
    kind: "view",
    columns,
    primary_key: [],
    indexes: [],
    row_estimate: "Unknown",
    partition_of: null,
    foreign_keys: [],
    table_bytes: null,
    index_bytes: null,
    ...extra,
  });
  const walletTx = table("wallet_tx", 48_210, {
    columns: [
      col("id", "bigint", false, "nextval('wallet_tx_id_seq'::regclass)"),
      col("wallet_id", "uuid"),
      col("kiosk_id", "bigint", true),
      col("amount", "numeric(12,2)"),
      col("currency", "text", false, "'MYR'::text"),
      col("status", "text"),
      col("settled", "boolean", false, "false"),
      col("metadata", "jsonb", false, "'{}'::jsonb"),
      col("created_at", "timestamp with time zone", false, "now()"),
      col("note", "text", true),
    ],
    indexes: [
      idx("wallet_tx_pkey", ["id"], { unique: true, primary: true, size: 1_081_344, scans: 48_112 }),
      idx("wallet_tx_wallet_id_idx", ["wallet_id"], { size: 2_170_880, scans: 9_204 }),
      idx("wallet_tx_created_at_idx", ["created_at"], { size: 1_089_536, scans: 0 }),
      idx("wallet_tx_metadata_idx", ["metadata"], { method: "gin", size: 3_252_224, scans: 311 }),
    ],
    foreign_keys: [
      fk("wallet_tx_wallet_id_fkey", ["wallet_id"], "wallets", "CASCADE"),
      fk("wallet_tx_kiosk_id_fkey", ["kiosk_id"], "kiosks", "SET NULL"),
    ],
    table_bytes: 9_830_400,
    index_bytes: 7_593_984,
  });
  const walletTables = (k) => [
    table("active_players", 2 * k),
    table("api_keys", 2),
    table("failed_jobs", 120 * k),
    table("game_wallet_transactions", 50 * k),
    table("kiosk_sessions", 3 * k, {
      foreign_keys: [fk("kiosk_sessions_kiosk_id_fkey", ["kiosk_id"], "kiosks")],
    }),
    table("kiosks", 2),
    table("ledger_entries", 0),
    table("ledger_entries_2026_08", 812_400 * k, { partition_of: "ledger_entries" }),
    table("ledger_entries_2026_09", 1_204_900 * k, { partition_of: "ledger_entries" }),
    { ...walletTx, row_estimate: { Approximate: 48_210 * k } },
    table("wallets", 12_400 * k),
    view("daily_settlements", [col("day", "date"), col("kiosk_id", "bigint"), col("volume", "numeric")], {
      kind: "materialized_view",
      row_estimate: { Approximate: 365 * k },
      table_bytes: 49_152,
    }),
    view("pending_payouts", [col("wallet_id", "uuid"), col("amount", "numeric(12,2)")]),
  ];
  const TABLES = {
    wallet: walletTables(1),
    rowkery: [
      table("events", 0),
      table("events_p0", 250_000, { partition_of: "events" }),
      table("events_p1", 250_000, { partition_of: "events" }),
      table("kiosk_sessions", 3),
      table("kiosks", 2),
      table("orders", 9_120),
      table("players", 1_450),
    ],
    main: [table("daily_active", 365), table("events_cache", 88_000)],
  };
  const catalogFor = (db) => ({
    databases: [{ name: db, schemas: [{ name: "public", tables: TABLES[db] ?? [] }] }],
  });

  const pg = (id, name, host, environment, database, extra = {}) => ({
    kind: "postgres",
    id,
    name,
    host,
    port: 5432,
    database,
    username: "app",
    environment,
    ...extra,
  });
  const ssh = { host: "bastion.internal", port: 22, username: "alice", auth_method: "keyfile" };
  const connections = [
    pg("prd", "wallet", "wallet-prd.db.internal", "prd", "wallet", { ssh }),
    pg("stg", "wallet", "wallet-stg.db.internal", "stg", "wallet"),
    { ...pg("local", "Docker Postgres", "127.0.0.1", "local", "rowkery"), port: 54329 },
    { kind: "sqlite", id: "cache", name: "analytics-cache", path: "~/cache.db", environment: "dev" },
    pg("replica", "billing-replica", "billing-ro.db.internal", "dev", "billing"),
    pg("payments", "payments", "payments-prd.db.internal", "prd", "wallet"),
  ];
  const openMs = { prd: 212, stg: 96, local: 18, cache: 4, payments: 188 };

  const T = (Text) => ({ Text });
  const NULL = { Null: null };
  let seed = 0x2f6b;
  const rand = () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
  const hex = (len) =>
    Array.from({ length: len }, () => Math.floor(rand() * 16).toString(16)).join("");
  const uuid = () => `${hex(8)}-${hex(4)}-4${hex(3)}-${"89ab"[Math.floor(rand() * 4)]}${hex(3)}-${hex(12)}`;
  const walletRows = () =>
    Array.from({ length: 100 }, (_, i) => {
      const n = 48_210 - i;
      const status = ["settled", "settled", "pending", "settled", "reversed"][i % 5];
      const channel = ["kiosk", "app", "web"][i % 3];
      const mins = 59 - (i % 60);
      const secs = (i * 37) % 60;
      return [
        { Int: n },
        T(uuid()),
        channel === "kiosk" ? { Int: 2041 + (i % 7) } : NULL,
        T(((i * 7_919) % 50_000 / 100 + 5).toFixed(2)),
        T(i % 4 === 3 ? "SGD" : "MYR"),
        T(status),
        { Bool: status === "settled" },
        T(`{"channel": "${channel}", "ref": "${channel.slice(0, 1).toUpperCase()}-${2041 + i}"}`),
        T(`2026-09-27 ${String(14 - Math.floor(i / 60)).padStart(2, "0")}:${String(mins).padStart(2, "0")}:${String(secs).padStart(2, "0")}.${String((i * 137) % 1000).padStart(3, "0")}+08`),
        i % 6 === 2 ? T("manual top-up") : NULL,
      ];
    });
  const results = {
    wallet_tx: {
      columns: [
        ["id", "int8"],
        ["wallet_id", "uuid"],
        ["kiosk_id", "int8"],
        ["amount", "numeric"],
        ["currency", "text"],
        ["status", "text"],
        ["settled", "bool"],
        ["metadata", "jsonb"],
        ["created_at", "timestamptz"],
        ["note", "text"],
      ],
      rows: walletRows,
    },
    kiosks: {
      columns: [
        ["id", "int8"],
        ["name", "text"],
      ],
      rows: () => Array.from({ length: 5 }, (_, i) => [{ Int: i + 1 }, T(`kiosk ${i + 1}`)]),
    },
    players: {
      columns: [
        ["id", "int8"],
        ["handle", "text"],
        ["country", "text"],
        ["balance", "numeric"],
        ["verified", "bool"],
        ["created_at", "timestamptz"],
      ],
      rows: () =>
        Array.from({ length: 100 }, (_, i) => [
          { Int: i + 1 },
          T(["neon_fox", "kitsune", "baozi", "mochi", "lapis", "rook"][i % 6] + (i + 7)),
          T(["MY", "SG", "ID", "TH"][i % 4]),
          T(((i * 3_571) % 90_000 / 100).toFixed(2)),
          { Bool: i % 3 !== 1 },
          T(`2026-09-${String(27 - (i % 27)).padStart(2, "0")} 09:${String((i * 7) % 60).padStart(2, "0")}:12.20${i % 10}+08`),
        ]),
    },
  };

  const windows = {};
  window.__ROWKERY_CALLS__ = [];
  window.__TAURI_INTERNALS__ = {
    metadata: { currentWindow: { label: "main" }, currentWebview: { label: "main" } },
    transformCallback: () => 0,
    invoke: async (cmd, args) => {
      window.__ROWKERY_CALLS__.push([cmd, args]);
      switch (cmd) {
        case "list_connections":
          return { connections: structuredClone(connections), active_connection_id: null };
        case "open_window": {
          const c = connections.find((x) => x.id === args.connectionId);
          await new Promise((r) => setTimeout(r, 60));
          if (c.id === "replica") {
            throw "error connecting to server: Connection refused (os error 61)";
          }
          const database = c.kind === "sqlite" ? "main" : (args.database ?? c.database);
          windows[args.windowId] = { conn: c, database };
          return {
            database,
            catalog: catalogFor(database),
            server_version: c.kind === "sqlite" ? "3.46.0" : "16.4",
            elapsed_ms: openMs[c.id] ?? 50,
          };
        }
        case "close_window":
          delete windows[args.windowId];
          return null;
        case "list_databases":
          return [
            { name: "billing", size_bytes: 2_147_483_648 },
            { name: "rowkery", size_bytes: 402_653_184 },
            { name: "wallet", size_bytes: 901_775_360 },
          ];
        case "run_query": {
          const name = Object.keys(results).find((t) => args.sql.includes(t));
          const r = results[name] ?? {
            columns: [["?column?", "int4"]],
            rows: () => [[{ Int: 1 }]],
          };
          await new Promise((res) => setTimeout(res, 20));
          const rows = r.rows();
          return {
            columns: r.columns.map(([name, type_name]) => ({ name, type_name })),
            rows,
            row_count: rows.length,
            elapsed_ms: 19,
            error: null,
            cancelled: false,
          };
        }
        case "browse_table_sql":
          return `SELECT * FROM ${args.schema}.${args.table} LIMIT 100;`;
        default:
          return null;
      }
    },
  };
}

const WALLS = {
  dark: "radial-gradient(80% 110% at 12% 0%, #2d2629 0%, transparent 62%), radial-gradient(70% 90% at 100% 100%, #241d2a 0%, transparent 60%), linear-gradient(160deg, #1a1619, #131115)",
  colour:
    "radial-gradient(55% 75% at 6% 6%, #3a6ae3 0%, transparent 62%), radial-gradient(60% 70% at 0% 100%, #ea5a2c 0%, transparent 62%), radial-gradient(60% 75% at 100% 100%, #8036cf 0%, transparent 62%), radial-gradient(45% 55% at 88% 4%, #1e3c95 0%, transparent 70%), linear-gradient(135deg, #1a2154, #2c1647)",
};
const MAC_MARGIN = 40;

/** A desktop behind the page, the native material and the traffic lights. */
async function fakeMacWindow(page, wall) {
  await page.addStyleTag({
    content: `
      html.platform-mac { background: ${WALLS[wall]} !important; }
      html.platform-mac body { padding: ${MAC_MARGIN}px !important; }
      html.platform-mac #root {
        border-radius: 12px;
        background: rgba(30, 30, 34, 0.5) !important;
        -webkit-backdrop-filter: blur(46px) saturate(1.7);
        backdrop-filter: blur(46px) saturate(1.7);
        box-shadow: inset 0 0 0 0.5px rgba(255, 255, 255, 0.13), 0 0 0 0.5px rgba(0, 0, 0, 0.7),
          0 34px 80px rgba(0, 0, 0, 0.55), 0 10px 24px rgba(0, 0, 0, 0.35);
      }
      .proof-lights { position: fixed; z-index: 99; top: ${MAC_MARGIN + 18.5}px; left: ${MAC_MARGIN + 18}px; display: flex; gap: 9px; pointer-events: none; }
      .proof-lights i { width: 14px; height: 14px; border-radius: 50%; box-shadow: inset 0 0 0 0.5px rgba(0, 0, 0, 0.28); }
    `,
  });
  await page.evaluate(() => {
    if (document.querySelector(".proof-lights")) return;
    const lights = document.createElement("div");
    lights.className = "proof-lights";
    for (const c of ["#ff5f57", "#febc2e", "#28c840"]) {
      const i = document.createElement("i");
      i.style.background = c;
      lights.append(i);
    }
    document.body.append(lights);
  });
}

async function useProofFonts(page) {
  if (!FONTS) return;
  await page.route(/fonts\.(googleapis|gstatic)\.com/, (route) => {
    const u = route.request().url();
    if (u.includes("googleapis")) {
      return route.fulfill({ contentType: "text/css", body: readFileSync(`${FONTS}/css2.css`, "utf8") });
    }
    const file = `${FONTS}/${u.replace("https://fonts.gstatic.com/", "").replace(/\//g, "_")}`;
    return route.fulfill({
      contentType: "font/woff2",
      body: readFileSync(file),
      headers: { "access-control-allow-origin": "*" },
    });
  });
}

async function applyProofFonts(page) {
  if (!FONTS) return;
  await page.addStyleTag({ url: "https://fonts.googleapis.com/css2?family=Geist:wght@400..700&family=Geist+Mono:wght@400..600&display=swap" });
  await page.addStyleTag({
    content: `:root { --sans: "Geist", system-ui, sans-serif !important; --mono: "Geist Mono", monospace !important; }
      button, input, textarea, select { font-family: inherit; }`,
  });
  await page.evaluate(() => document.fonts.ready);
}

const pageErrors = [];
const check = (cond, msg) => {
  if (!cond) {
    console.error(`FAIL: ${msg}`);
    process.exitCode = 1;
  } else console.log(`ok: ${msg}`);
};

async function openApp(browser, { mac, windows, active = 0, pins = {}, wall = "dark" }) {
  const margin = mac ? MAC_MARGIN * 2 : 0;
  const page = await browser.newPage({
    viewport: { width: 1280 + margin, height: 800 + margin },
    deviceScaleFactor: 2,
  });
  page.on("pageerror", (e) => pageErrors.push(e.message));
  await useProofFonts(page);
  await page.addInitScript({ path: FRAMES_SHIM });
  await page.addInitScript(stubTauri, { mac });
  await page.addInitScript(
    ({ windows, active, pins }) => {
      if (sessionStorage.getItem("proof-seeded")) return;
      sessionStorage.setItem("proof-seeded", "1");
      localStorage.clear();
      localStorage.setItem("rowkery.windows", JSON.stringify({ windows, active }));
      for (const [conn, keys] of Object.entries(pins)) {
        localStorage.setItem(`rowkery.pins.${conn}`, JSON.stringify(keys));
      }
    },
    { windows, active, pins },
  );
  await page.goto(URL);
  await applyProofFonts(page);
  if (mac) await fakeMacWindow(page, wall);
  return page;
}

const visible = '[data-testid="workspace"]:not([hidden])';
const shot = async (page, name, clip) => {
  await page.waitForTimeout(350);
  await page.screenshot({ path: `${OUT}/${name}.png`, clip });
  console.log(`${OUT}/${name}.png`);
};
const text = (page, sel) => page.textContent(sel).then((t) => t?.trim());
// The core's safe mode check, reduced to what this proof runs.
function stubSafeMode() {
  const modes = { prd: "confirm", stg: "read_only" };
  const windowConn = {};
  window.__SAFE_CALLS__ = [];
  const inner = window.__TAURI_INTERNALS__.invoke;
  const check = (sql) => {
    const body = sql.replace(/--[^\n]*\n?/g, " ").trim();
    const verb = /^(\w+)/.exec(body)?.[1]?.toUpperCase() ?? "";
    if (!["INSERT", "UPDATE", "DELETE", "DROP", "TRUNCATE", "CREATE", "ALTER"].includes(verb)) return null;
    const target = /^(?:\w+)\s+(?:FROM\s+|INTO\s+|TABLE\s+)?([\w.]+)/i.exec(body)?.[1] ?? null;
    return {
      kind: ["DROP", "TRUNCATE", "CREATE", "ALTER"].includes(verb) ? "schema" : "write",
      verb,
      target,
      destructive: ["DROP", "TRUNCATE"].includes(verb) || (["DELETE", "UPDATE"].includes(verb) && !/\bWHERE\b/i.test(body)),
      unlocks_writes: false,
    };
  };
  // Reassigned whole (not `.invoke =`) so the frames shim wraps this invoke too.
  const invoke = async (cmd, args) => {
    if (cmd === "open_window") windowConn[args.windowId] = args.connectionId;
    if (cmd === "list_connections") {
      const list = await inner(cmd, args);
      list.connections = list.connections.map((c) => ({ ...c, safe_mode: modes[c.id] ?? "off" }));
      return list;
    }
    if (cmd === "save_connection") {
      modes[args.connection.id] = args.connection.safe_mode ?? "off";
      return null;
    }
    if (cmd === "run_query") {
      const mode = modes[windowConn[args.windowId]] ?? "off";
      window.__SAFE_CALLS__.push({ sql: args.sql, confirmed: !!args.confirmed, mode });
      const s = check(args.sql);
      if (s && (mode === "read_only" || (mode === "confirm" && !args.confirmed))) {
        return {
          columns: [], rows: [], row_count: 0, elapsed_ms: 0, error: null, cancelled: false,
          hold: { action: mode === "read_only" ? "refuse" : "confirm", mode, statements: [s] },
        };
      }
      if (s) {
        return { columns: [], rows: [], row_count: 0, elapsed_ms: 7, error: null, cancelled: false };
      }
    }
    return inner(cmd, args);
  };
  window.__TAURI_INTERNALS__ = { ...window.__TAURI_INTERNALS__, __framesShim: false, invoke };
}

const browser = await playwright.chromium.launch({
  executablePath: process.env.CHROMIUM_PATH ?? "/opt/pw-browsers/chromium",
});
const page = await openApp(browser, {
  mac: true,
  windows: [
    { connectionId: "prd", database: "wallet" },
    { connectionId: "stg", database: "wallet" },
    { connectionId: "local", database: "rowkery" },
  ],
  pins: { prd: ["wallet.public.wallets", "wallet.public.wallet_tx"] },
});
// openApp has already loaded the page: add the safe mode stub and reload.
await page.addInitScript(stubSafeMode);
await page.reload();
await applyProofFonts(page);
await fakeMacWindow(page, "dark");
const calls = () => page.evaluate(() => window.__SAFE_CALLS__);
const bar = `${visible} [data-testid="safe-bar"]`;
const connected = `${visible}[data-conn-state="connected"]`;
// The shown window's shield sits in the title bar.
const shield = '[data-testid="titlebar"] [data-shield]';
const menu = '[data-menu="safe-mode"]';
const type = async (sql) => {
  await page.fill(`${visible} [data-testid="sql-editor"]`, sql);
  await page.focus(`${visible} [data-testid="sql-editor"]`);
  await page.keyboard.press("Control+End");
};

await page.waitForSelector(connected);
check((await page.getAttribute(shield, "data-shield")) === "confirm", "prd window's panel head shows the Confirm writes shield");
// Results to fade under the bar. In Query 1: a browse tab's editor is now a WHERE filter line.
await type("SELECT * FROM wallet_tx LIMIT 100;");
await page.keyboard.press("Meta+Enter");
await page.waitForSelector(`${visible} [data-col]`);

// 1. Confirm writes: a DELETE waits in the results card.
await type("-- Clear stale unsettled transactions\nDELETE FROM wallet_tx\nWHERE settled = false\n  AND created_at < now() - interval '30 days';");
await page.keyboard.press("Meta+Enter");
await page.waitForSelector(bar);
check((await text(page, `${bar} b`)) === "DELETE on wallet_tx isn't run yet", "bar names the statement and table");
check((await text(page, `${bar} [data-testid="safe-btn"][data-tone="go"]`)).startsWith("Run"), "plain write: orange Run");
check((await text(page, `${visible} [data-testid="results-card"] [data-testid="card-meta"]`)) === "Not run", "results header says Not run");
check((await page.locator(`${visible} [data-testid="results-card"][data-held] [data-row]`).count()) > 0, "last results stay, faded");
check((await calls()).every((c) => !c.confirmed), "nothing confirmed yet");
await shot(page, "1-confirm-bar");

// 2. Esc drops it; nothing runs.
await page.keyboard.press("Escape");
check((await page.locator(bar).count()) === 0, "Esc drops the held write");
check((await calls()).every((c) => !c.confirmed), "Esc ran nothing");

// 3. ⇧⌘↵ runs exactly the held SQL, once.
await page.focus(`${visible} [data-testid="sql-editor"]`);
await page.keyboard.press("Meta+Enter");
await page.waitForSelector(bar);
await page.keyboard.press("Meta+Shift+Enter");
await page.waitForSelector(bar, { state: "detached" });
const confirmed = (await calls()).filter((c) => c.confirmed);
const heldSql = (await calls()).filter((c) => !c.confirmed).at(-1).sql;
check(
  confirmed.length === 1 && confirmed[0].sql === heldSql && heldSql.includes("DELETE FROM wallet_tx"),
  `⇧⌘↵ ran the held DELETE once (${confirmed.length})`,
);
check((await page.locator(`${visible} [data-testid="results-card"][data-held]`).count()) === 0, "results un-fade after the run");

// 4. UPDATE with no WHERE: red warning with the table's row count.
await type("-- Reset test balances\nUPDATE wallets\nSET balance = 0;");
await page.keyboard.press("Meta+Enter");
await page.waitForSelector(`${bar}[data-tone="danger"]`);
const warn = await text(page, `${bar} [data-testid="safe-bar-warn"]`);
check(/^No WHERE: this changes every row in wallets \(about [\d,]+\)\.$/.test(warn), `destructive warning with row count (${warn})`);
check((await text(page, `${bar} [data-testid="safe-btn"][data-tone="danger"]`)).startsWith("Update all rows"), "button says Update all rows");
await shot(page, "2-destructive");
await page.keyboard.press("Escape");

// 5. Read-only: refused, and ⇧⌘↵ can't push it through.
await page.keyboard.press("Meta+2");
await page.waitForSelector(connected);
check((await page.getAttribute(shield, "data-shield")) === "read_only", "stg window's shield says Read-only");
await type("UPDATE wallets\nSET balance = 0\nWHERE id = 1042;");
await page.keyboard.press("Meta+Enter");
await page.waitForSelector(`${visible} [data-testid="safe-refuse"]`);
const before = (await calls()).length;
await page.keyboard.press("Meta+Shift+Enter");
await page.waitForTimeout(150);
check((await calls()).length === before, "⇧⌘↵ does nothing on a read-only connection");
check((await text(page, `${visible} [data-testid="safe-refuse"] p`)).startsWith("UPDATE on wallets wasn't run."), "refusal names what wasn't run");
await shot(page, "3-read-only-refused");

// 6. Change safe mode… opens the shield's menu on the current mode (no sheet).
await page.click(`${visible} [data-testid="safe-refuse"] [data-testid="safe-btn"]`);
await page.waitForSelector(menu);
check((await page.getAttribute(`${menu} [data-item="read_only"]`, "aria-checked")) === "true", "menu shows Read-only checked");
check((await page.$('[data-testid="nc-sheet"]')) === null, "no sheet opens");
await shot(page, "4-safe-mode-menu");
await page.keyboard.press("Escape");
await page.waitForSelector(menu, { state: "detached" });

// 7. ⌘K turns safe mode off; the same UPDATE now runs at once.
await page.keyboard.press("Meta+k");
await page.keyboard.type(">safe mode off");
await page.waitForSelector('[data-testid="cp-row"][data-item="cmd:safe:off"]');
await page.keyboard.press("Enter");
await page.waitForFunction((s) => document.querySelector(s)?.dataset.shield === "off", shield);
await page.waitForSelector("[data-toast]");
const toast = await page.$$eval("[data-toast] > span", (els) => els.map((e) => e.textContent.trim()).join(" · "));
check(toast === "Safe mode: Off · wallet", `toast: ${toast}`);
check((await page.getAttribute(shield, "data-shield")) === "off", "the shield is back to Off");
await page.focus(`${visible} [data-testid="sql-editor"]`);
await page.keyboard.press("Meta+Enter");
await page.waitForTimeout(150);
check((await page.locator(`${visible} [data-testid="safe-refuse"], ${bar}`).count()) === 0, "off: the write runs straight away");
check((await calls()).at(-1).mode === "off", "and ran on the off connection");

// 8. New connections start Off.
await page.keyboard.press("Meta+n");
await page.waitForSelector('[data-testid="nc-sheet"] [data-safe-choice]');
check((await page.getAttribute('[data-testid="nc-sheet"] [data-safe-choice="off"]', "aria-checked")) === "true", "new connection defaults to Off");
await page.keyboard.press("Escape");

// 9. Reduce Motion: the bar appears without animation.
await page.emulateMedia({ reducedMotion: "reduce" });
await page.keyboard.press("Meta+1");
await page.waitForSelector(connected);
await type("DELETE FROM wallet_tx WHERE id = 1;");
await page.keyboard.press("Meta+Enter");
await page.waitForSelector(bar);
check((await page.$eval(bar, (e) => getComputedStyle(e).animationName)) === "none", "Reduce Motion: no bar animation");

await browser.close();
if (pageErrors.length) {
  console.error("page errors:", pageErrors);
  process.exitCode = 1;
}
