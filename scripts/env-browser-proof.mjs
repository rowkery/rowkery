#!/usr/bin/env node
// Connection environment proof without a Tauri webview or Postgres: serves the
// Vite frontend with a stubbed Tauri `invoke`, then checks the environment on
// the shown window pill's dot (`.win-tab[data-env]`) and the panel head's
// `[data-testid="env-tag"]`, the switcher list's tags, the New Connection picker and the ⌘K
// "Set environment" command.
//
//   cd apps/rowkery-tauri && npx vite --port 1420 &
//   node scripts/env-browser-proof.mjs [outDir]
import { createRequire } from "node:module";
import { mkdirSync } from "node:fs";
import { execSync } from "node:child_process";

const LINUX_PLATFORM = new globalThis.URL("./lib/linux-platform.js", import.meta.url).pathname;

const require = createRequire(import.meta.url);
let playwright;
try {
  playwright = require("playwright");
} catch {
  const root = execSync("npm root -g").toString().trim();
  playwright = require(`${root}/playwright`);
}

const OUT = process.argv[2] ?? "/tmp/rowkery-proof/connection-env";
const URL = process.env.ROWKERY_DEV_URL ?? "http://localhost:1420/";
mkdirSync(OUT, { recursive: true });

function stubTauri() {
  const tables = ["api_keys", "kiosk_sessions", "payouts", "failed_jobs", "webhooks"].map(
    (name, i) => ({
      name,
      columns: [
        { name: "id", type_name: "int8", nullable: false },
        { name: "created_at", type_name: "timestamptz", nullable: true },
      ],
      primary_key: ["id"],
      indexes: [],
      row_estimate: { Approximate: 1200 * (i + 1) },
      partition_of: null,
    }),
  );
  const catalog = { databases: [{ name: "wallet", schemas: [{ name: "public", tables }] }] };
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
    pg("dev", "wallet", "wallet-dev.db.internal", "dev"),
    { ...pg("local", "Docker Postgres", "127.0.0.1", "local"), port: 54329 },
    { kind: "sqlite", id: "cache", name: "analytics-cache", path: "~/cache.db" },
  ];
  window.__ROWKERY_CALLS__ = [];
  window.__TAURI_INTERNALS__ = {
    metadata: { currentWindow: { label: "main" }, currentWebview: { label: "main" } },
    transformCallback: () => 0,
    invoke: async (cmd, args) => {
      window.__ROWKERY_CALLS__.push([cmd, args]);
      switch (cmd) {
        case "list_connections":
          return { connections: structuredClone(connections), active_connection_id: null };
        case "save_connection": {
          const i = connections.findIndex((c) => c.id === args.connection.id);
          if (i >= 0) connections[i] = args.connection;
          else connections.push(args.connection);
          return null;
        }
        case "open_window":
          return { database: args.database ?? "wallet", catalog, elapsed_ms: 9 };
        case "list_databases":
          return [];
        case "probe_connection":
          return { ok: true, message: "PostgreSQL 16.3", elapsed_ms: 41 };
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
await page.addInitScript({ path: LINUX_PLATFORM });
await page.addInitScript(stubTauri);
await page.goto(URL);
await page.waitForSelector('[data-testid="workspace"]:not([hidden])'); // Paper (2026-10-10): an empty window shows no connection chip (no tab row without a connection); wait for the window, then ⇧⌘O as before.

const shot = async (name, clip) => {
  await page.waitForTimeout(250);
  await page.screenshot({ path: `${OUT}/${name}.png`, clip });
  console.log(`${OUT}/${name}.png`);
};
const check = (cond, msg) => {
  if (!cond) {
    console.error(`FAIL: ${msg}`);
    process.exitCode = 1;
  } else console.log(`ok: ${msg}`);
};
const top = { x: 0, y: 0, width: 760, height: 360 };
const ws = '[data-testid="workspace"]:not([hidden])';
const headTag = () => page.textContent(`${ws} [data-testid="env-tag"]`).then((t) => t?.trim()).catch(() => null);
const tileEnv = () => page.getAttribute('[data-testid="win-tab"][data-on]', "data-env");
// Switch this window's connection to the n-th saved one (⇧⌘O, arrows, Enter).
const pickConnection = async (n) => {
  await page.keyboard.press("Control+Shift+O");
  await page.waitForSelector('[data-testid="conn-popover"]');
  await page.keyboard.press("Home");
  for (let i = 0; i < 6; i++) await page.keyboard.press("ArrowUp");
  for (let i = 1; i < n; i++) await page.keyboard.press("ArrowDown");
  await page.keyboard.press("Enter");
  await page.waitForTimeout(200);
};

// 1. Production connected: filled red tag after the name.
await pickConnection(1);
await page.waitForSelector(`${ws}[data-conn-state="connected"]`);
check((await tileEnv()) === "prd", "active rail tile's dot is prd");
check((await headTag()) === "prd", "panel head shows the prd tag");
await shot("1-chip-prd", { x: 0, y: 0, width: 760, height: 120 });

// 2. Switcher lists every env.
await page.keyboard.press("Control+Shift+O");
await page.waitForSelector('[data-testid="conn-popover"]');
check((await page.locator('[data-testid="conn-popover"] [data-testid="env-tag"]').count()) === 4, "switcher shows 4 env tags");
await shot("2-switcher", top);
await page.keyboard.press("Escape");

// 3. Staging and dev on the chip.
await pickConnection(2);
check((await tileEnv()) === "stg" && (await headTag()) === "stg", "switching to staging: tile dot and tag read stg");
await shot("3-chip-stg", { x: 0, y: 0, width: 760, height: 120 });
await pickConnection(3);
check((await tileEnv()) === "dev" && (await headTag()) === "dev", "switching to dev: tile dot and tag read dev");
await shot("3-chip-dev", { x: 0, y: 0, width: 760, height: 120 });

// 4. New Connection: pasting a prod URL suggests prd. Saving opens it in a
// new window, since this one already has a connection.
await page.keyboard.press("Control+n");
await page.waitForSelector('[data-testid="nc-sheet"]');
await page.fill('[data-testid="nc-sheet"] input[data-testid="nc-input"]', "postgres://app:pw@orders-prod.internal:5432/orders");
const selected = () => page.getAttribute('[data-testid="nc-env"] button[aria-checked="true"]', "data-env-choice");
check((await selected()) === "prd", "prod URL suggests prd");
await shot("4-sheet-suggested-prd");
await page.click('[data-testid="nc-env"] button[data-env-choice="stg"]');
check((await selected()) === "stg", "clicking stg overrides the suggestion");
await page.keyboard.press("Control+Enter");
await page.waitForTimeout(300);
const saved = await page.evaluate(() =>
  window.__ROWKERY_CALLS__.filter(([c]) => c === "save_connection").map(([, a]) => a.connection),
);
check(saved.at(-1)?.environment === "stg", "saved record carries environment stg");
check((await page.locator('[data-testid="win-tab"]').count()) === 2, "new connection opened in a second window");
check((await tileEnv()) === "stg", "the new window's tile is stg");
await shot("5-new-stg-connected", { x: 0, y: 0, width: 760, height: 120 });

// 6. ⌘K: change the active connection's environment.
await page.keyboard.press("Control+k");
await page.waitForSelector('.cp-input, [data-testid="cp-panel"], [role=dialog]');
await page.keyboard.type("> environment");
await shot("6-palette-env");
await page.keyboard.type(" dev");
await page.waitForTimeout(150);
await page.keyboard.press("Enter");
await page.waitForTimeout(300);

const envNow = await tileEnv();
check(envNow === "dev", `palette set env to dev (got ${envNow})`);
check((await headTag()) === "dev", "panel head tag follows to dev");

await browser.close();
