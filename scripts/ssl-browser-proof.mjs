#!/usr/bin/env node
// SSL proof with a stubbed Tauri `invoke`: the New Connection sheet's
// Advanced section offers
// Off / Prefer / Require / Verify, Verify shows a CA certificate field, a
// pasted `sslmode=verify-full&sslrootcert=` URL fills both, and saving sends
// `ssl_mode: "verify"` with `ssl_root_cert`. The modes themselves are proved
// against real servers by scripts/pg-tls-proof.sh.
//
//   cd apps/rowkery-tauri && npx vite --port 1420 &
//   node scripts/ssl-browser-proof.mjs [outDir]
import { createRequire } from "node:module";
import { mkdirSync } from "node:fs";
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

const OUT = process.argv[2] ?? "/tmp/rowkery-proof/ssl";
const URL = process.env.ROWKERY_DEV_URL ?? "http://localhost:1420/";
mkdirSync(OUT, { recursive: true });

function stubTauri() {
  const TABLES = {
    wallet: ["api_keys", "ledger_entries", "wallets"],
    orders: ["order_items", "orders", "refunds", "shipments"],
    payments: ["charges", "payouts"],
    analytics: ["daily_active", "events"],
  };
  const catalogFor = (db) => ({
    databases: [
      {
        name: db,
        schemas: [
          {
            name: "public",
            tables: (TABLES[db] ?? ["t"]).map((name, i) => ({
              name,
              columns: [{ name: "id", type_name: "int8", nullable: false }],
              primary_key: ["id"],
              indexes: [],
              row_estimate: { Approximate: 4100 * (i + 1) },
              partition_of: null,
            })),
          },
        ],
      },
    ],
  });
  const pg = (id, name, host, environment) => ({
    kind: "postgres",
    id,
    name,
    host,
    port: 5432,
    database: "wallet",
    username: "app",
    environment,
  });
  const connections = [
    pg("prd", "wallet", "wallet-prd.db.internal", "prd"),
    pg("stg", "wallet", "wallet-stg.db.internal", "stg"),
    { ...pg("local", "Docker Postgres", "127.0.0.1", "local"), port: 54329, database: "rowkery" },
    { kind: "sqlite", id: "cache", name: "analytics-cache", path: "~/cache.db" },
  ];
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
          const database = c.kind === "sqlite" ? "main" : (args.database ?? c.database);
          windows[args.windowId] = { conn: c, database };
          await new Promise((r) => setTimeout(r, 60));
          return { database, catalog: catalogFor(database), elapsed_ms: 60 };
        }
        case "close_window":
          delete windows[args.windowId];
          return null;
        case "list_databases":
          return Array.from({ length: 30 }, (_, i) => ({
            name: `tenant_${String(i + 1).padStart(2, "0")}`,
            size_bytes: 1_000_000 * (i + 1),
          }));
        case "probe_connection":
          return { ok: true, message: "PostgreSQL 16.4", elapsed_ms: 12 };
        case "save_connection": {
          const i = connections.findIndex((c) => c.id === args.connection.id);
          if (i >= 0) connections[i] = args.connection;
          else connections.push(args.connection);
          return null;
        }
        case "delete_connection": {
          const i = connections.findIndex((c) => c.id === args.id);
          if (i >= 0) connections.splice(i, 1);
          return null;
        }
        case "run_query": {
          const w = windows[args.windowId];
          return {
            columns: [
              { name: "window", type_name: "text" },
              { name: "current_database", type_name: "text" },
            ],
            rows: [[{ Text: `${w.conn.name} (${w.conn.environment})` }, { Text: w.database }]],
            row_count: 1,
            elapsed_ms: 4,
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

const browser = await playwright.chromium.launch({
  executablePath: process.env.CHROMIUM_PATH ?? "/opt/pw-browsers/chromium",
});
const page = await browser.newPage({ viewport: { width: 1280, height: 800 }, deviceScaleFactor: 2 });
page.on("pageerror", (e) => console.error("pageerror:", e.message));
await page.addInitScript({ path: FRAMES_SHIM });
await page.addInitScript(stubTauri);
await page.goto(URL);
await page.evaluate(() => localStorage.clear());
await page.reload();
await page.waitForSelector('[data-testid="workspace"]:not([hidden])'); // Paper (2026-10-10): an empty window shows no connection chip (no tab row without a connection); wait for the window, then ⇧⌘O as before.

const shot = async (name) => {
  await page.waitForTimeout(300);
  await page.screenshot({ path: `${OUT}/${name}.png`, clip: await page.locator('[data-testid="nc-sheet"]').boundingBox() });
  console.log(`saved ${OUT}/${name}.png`);
};
let failed = 0;
const check = (ok, what) => {
  console.log(`${ok ? "ok  " : "FAIL"} ${what}`);
  if (!ok) failed++;
};

await page.keyboard.press("Control+n");
await page.waitForSelector('[data-testid="nc-sheet"]');
// SSL lives under Advanced.
await page.click('[data-testid="nc-disclosure"]');
const labels = await page.$$eval("[data-ssl-choice]", (b) => b.map((x) => x.textContent));
check(labels.join(",") === "Off,Prefer,Require,Verify", `SSL modes: ${labels.join(", ")}`);
check(!(await page.isVisible('[data-field="sslRootCert"]')), "no CA field outside Verify");
await shot("1-ssl-modes");

await page.fill(
  '[data-testid="nc-sheet"] [data-field="url"] input',
  "postgres://app@wallet-prd.abc123.eu-west-1.rds.amazonaws.com:5432/wallet?sslmode=verify-full&sslrootcert=~/certs/rds-global-bundle.pem",
);
await page.waitForSelector('[data-field="sslRootCert"]');
check(
  (await page.getAttribute('[data-ssl-choice="verify"]', "aria-checked")) === "true",
  "verify-full URL picks Verify",
);
const ca = page.locator('[data-field="sslRootCert"] input');
check((await ca.inputValue()) === "~/certs/rds-global-bundle.pem", "sslrootcert fills the CA field");
await shot("2-verify-ca");

await page.fill('[data-testid="nc-sheet"] [data-field="name"] input', "wallet prod");
await page.keyboard.press("Control+Enter");
await page.waitForSelector('[data-testid="nc-sheet"]', { state: "detached" });
const saved = await page.evaluate(
  () => window.__ROWKERY_CALLS__.find(([cmd]) => cmd === "save_connection")?.[1]?.connection,
);
check(saved?.ssl_mode === "verify", `saved ssl_mode ${saved?.ssl_mode}`);
check(saved?.ssl_root_cert === "~/certs/rds-global-bundle.pem", `saved ssl_root_cert ${saved?.ssl_root_cert}`);

// Require keeps no CA path.
await page.keyboard.press("Control+n");
await page.waitForSelector('[data-testid="nc-sheet"]');
await page.click('[data-testid="nc-disclosure"]');
await page.click('[data-ssl-choice="require"]');
check(!(await page.isVisible('[data-field="sslRootCert"]')), "Require hides the CA field");

await browser.close();
if (failed) {
  console.error(`${failed} check(s) failed`);
  process.exit(1);
}
