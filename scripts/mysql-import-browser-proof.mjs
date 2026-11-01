#!/usr/bin/env node
// Import CSV on a MySQL window (stubbed `invoke`; the import itself is
// proved against MySQL 8.0, 8.4 and MariaDB 10.11, 11.4 by `cargo test -p
// rowkery-core --features mysql-integration --test mysql_integration csv`).
// ⌘K "Import CSV…" opens the panel for the table the file fits, in the
// window's database; Import sends that database as the schema, and the
// toast says what went in.
//
//   cd apps/rowkery-tauri && npx vite --port 1420 &
//   node scripts/mysql-import-browser-proof.mjs [outDir] [light|dark]
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
const OUT = process.argv[2] ?? "/tmp/rowkery-proof/mysql-import";
const THEME = process.argv[3] ?? "light";
const URL = process.env.ROWKERY_DEV_URL ?? "http://localhost:1420/";
mkdirSync(OUT, { recursive: true });

function stubTauri(theme) {
  localStorage.clear();
  localStorage.setItem("rowkery.windows", JSON.stringify({ windows: [{ connectionId: "my", database: "shop" }], active: 0 }));
  const col = (name, type_name, extra = {}) => ({ name, type_name, nullable: true, ...extra });
  const orders = [
    col("id", "int", { nullable: false }),
    col("email", "varchar(80)"),
    col("status", "enum('pending','paid')", { default: "pending" }),
    col("total", "decimal(10,2)"),
  ];
  const table = (name, columns) => ({ name, kind: "table", columns, primary_key: ["id"], indexes: [], foreign_keys: [], row_estimate: { Approximate: 900 } });
  const catalog = { databases: [{ name: "def", schemas: [{ name: "shop", tables: [table("customers", [col("id", "int", { nullable: false }), col("name", "varchar(40)")]), table("orders", orders)] }] }], search_path: ["shop"], enums: [], functions: [] };
  const header = ["id", "email", "status", "total"];
  const fileRows = Array.from({ length: 6 }, (_, i) => [String(500 + i), `n${i}@mail.com`, i % 2 ? "" : "paid", (9.5 + i).toFixed(2)]);
  window.__CALLS__ = [];
  window.__TAURI_INTERNALS__ = {
    metadata: { currentWindow: { label: "main" }, currentWebview: { label: "main" } },
    transformCallback: () => 0,
    invoke: async (cmd, args) => {
      const { onFrame, onProgress, ...rest } = args ?? {};
      window.__CALLS__.push([cmd, rest]);
      switch (cmd) {
        case "get_theme":
        case "load_theme":
          return theme;
        case "list_connections":
          return { connections: [{ kind: "mysql", id: "my", name: "shop", host: "db", port: 3306, database: "shop", username: "app" }], active_connection_id: null };
        case "open_window":
          return { database: "shop", catalog, server_version: "11.4.3", server_flavor: "MariaDB", elapsed_ms: 2, cached: false, open_seq: 1 };
        case "choose_csv":
          return "/home/me/orders.csv";
        case "preview_csv":
          return { file_name: "orders.csv", delimiter: ",", rows: [header, ...fileRows], records: 7 };
        case "import_csv":
          onProgress.onmessage({ rows: 6 });
          return { status: "imported", inserted: 5, updated: 0, skipped: 1, elapsed_ms: 31 };
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
const page = await browser.newPage({ viewport: { width: 1180, height: 700 }, deviceScaleFactor: 2, colorScheme: THEME });
page.on("pageerror", (e) => {
  console.error("pageerror:", e.message);
  process.exitCode = 1;
});
await page.addInitScript({ path: LINUX_PLATFORM });
await page.addInitScript(stubTauri, THEME);
await page.goto(URL);
const ws = '[data-testid="workspace"]:not([hidden])';
await page.waitForSelector(`${ws}[data-conn-state="connected"]`);
await page.evaluate((t) => (document.documentElement.dataset.theme = t), THEME);
const panel = `${ws} [data-inspector="import"]`;
const chip = (name) => page.textContent(`${panel} [data-import-picker="${name}"]`).then((t) => t.trim());

await page.keyboard.press("Control+k");
await page.waitForSelector('[data-testid="cp-row"]');
await page.keyboard.type("import csv");
await page.click('[data-testid="cp-row"][data-item="cmd:import-csv"]');
await page.waitForSelector(panel);
check((await chip("table")) === "orders", `the file fits orders (${await chip("table")})`);
const matched = await page.getAttribute(`${panel} [data-import-matched]`, "data-import-matched");
check(matched === "4", `every column matched by name (${matched})`);
const preview = await page.$$eval(`${ws} [data-import-row="1"] [data-col]`, (els) => els.map((e) => e.textContent.trim()));
check(preview[2] === "default", `an empty status shows its default (${preview.join(" | ")})`);
await page.mouse.move(600, 650);
await page.screenshot({ path: `${OUT}/1-panel-${THEME}.png` });
await page.click(`${panel} [data-import-run]`);
await page.waitForSelector("[data-toast]");
const toast = (await page.$$eval("[data-toast] > span", (els) => els.map((e) => e.textContent.trim()).join(" "))).replace(/\s+/g, " ");
check(/5/.test(toast) && /orders/.test(toast), `the toast says what went in: ${toast}`);
const sent = await page.evaluate(() => window.__CALLS__.filter(([c]) => c === "import_csv").map(([, a]) => a).at(-1));
const spec = sent.spec ?? sent;
check(spec.schema === "shop" && spec.table === "orders", `Import goes to shop.orders (${spec.schema}.${spec.table})`);

await browser.close();
