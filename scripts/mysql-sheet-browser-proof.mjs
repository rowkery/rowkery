#!/usr/bin/env node
// MySQL and MariaDB in the New Connection sheet (stubbed `invoke`): the
// engine dropdown (Postgres, MySQL · MariaDB, SQLite) by mouse and keys; MySQL
// takes port 3306, hides Cloud SQL and agent sharing, and probes without a
// database; a server that says MariaDB turns the chip into MariaDB's seal and
// saves `mariadb: true`; a mysql:// URL pasted on Postgres switches the engine
// and fills the form; the saved connection shows its seal in the list.
//
//   cd apps/rowkery-tauri && npx vite --port 1420 &
//   node scripts/mysql-sheet-browser-proof.mjs [outDir] [light|dark]
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
const OUT = process.argv[2] ?? "/tmp/rowkery-proof/mysql-sheet";
const THEME = process.argv[3] ?? "light";
const URL = process.env.ROWKERY_DEV_URL ?? "http://localhost:1420/";
const FRAMES_SHIM = new globalThis.URL("./lib/frames-shim.js", import.meta.url).pathname;
mkdirSync(OUT, { recursive: true });

function stubTauri(theme) {
  localStorage.clear();
  window.__PROBES__ = [];
  window.__SAVED__ = [];
  window.__TAURI_INTERNALS__ = {
    metadata: { currentWindow: { label: "main" }, currentWebview: { label: "main" } },
    transformCallback: () => 0,
    invoke: async (cmd, args) => {
      switch (cmd) {
        case "get_theme":
        case "load_theme":
          return theme;
        case "list_connections":
          return { connections: [{ kind: "postgres", id: "pg", name: "arcade", host: "127.0.0.1", port: 5432, database: "rowkery", username: "rowkery" }, ...window.__SAVED__], active_connection_id: null };
        case "probe_connection": {
          const { connection: c, secrets } = args;
          window.__PROBES__.push({ ...c, password: secrets.db_password ?? "" });
          await new Promise((r) => setTimeout(r, 60));
          if (c.kind === "mysql") return { ok: true, message: c.host === "maria.internal" ? "MariaDB 11.4.3" : "MySQL 8.4.3", elapsed_ms: 38 };
          return { ok: true, message: "PostgreSQL 16.4", elapsed_ms: 40 };
        }
        case "explain_connect_error":
          return { class: "unknown", cause: null, field: null };
        case "open_window": {
          const col = (name, type_name) => ({ name, type_name, nullable: false });
          const tables = [{ name: "orders", columns: [col("id", "int"), col("order", "int")], primary_key: ["id"], indexes: [], foreign_keys: [], row_estimate: { Approximate: 3 } }];
          return {
            database: "",
            catalog: { databases: [{ name: "def", schemas: [{ name: "shop", tables }] }], search_path: ["shop"], enums: [], functions: [] },
            server_version: "11.4.3",
            server_flavor: "MariaDB",
            elapsed_ms: 2,
            cached: false,
            open_seq: 1,
          };
        }
        case "save_connection":
          window.__SAVED__.push(args.connection);
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
const page = await browser.newPage({ viewport: { width: 1180, height: 760 }, deviceScaleFactor: 2, colorScheme: THEME });
page.on("pageerror", (e) => console.error("pageerror:", e.message));
page.on("console", (m) => m.type() === "error" && console.error("console:", m.text().slice(0, 400)));
await page.addInitScript({ path: FRAMES_SHIM });
await page.addInitScript(stubTauri, THEME);
await page.goto(URL);
await page.waitForSelector('[data-testid="workspace"]:not([hidden])');
await page.evaluate((t) => (document.documentElement.dataset.theme = t), THEME);
const field = (name) => `[data-testid="nc-sheet"] [data-field="${name}"] input`;
const chip = "[data-engine-pick]";
const shot = (name) => page.screenshot({ path: `${OUT}/${name}-${THEME}.png` });

const cards = await page.$$eval(".ew-action, [data-ew-action], .ew-card", (els) => els.map((e) => e.textContent.replace(/\s+/g, " ").trim()));
check(cards.some((t) => t.includes("Postgres, MySQL or SQLite")), `Connect to start names MySQL (${cards.slice(0, 3).join(" | ")})`);

await page.mouse.click(400, 110);
await page.keyboard.press("Control+N");
await page.waitForSelector('[data-testid="nc-sheet"]');
check((await page.getAttribute(chip, "data-engine-pick")) === "postgres", "a new connection starts on Postgres");
await shot("1-postgres");

// The menu: three engines, Postgres ticked.
await page.click(chip);
await page.waitForSelector("[data-engine-option]");
const options = await page.$$eval("[data-engine-option]", (els) => els.map((e) => e.textContent.trim()));
check(options.join(" | ") === "PostgreSQL | MySQL · MariaDB | SQLite", `menu: ${options.join(" | ")}`);
check((await page.getAttribute('[data-engine-option="postgres"]', "aria-selected")) === "true", "Postgres is ticked");
await shot("2-menu");
// Esc closes the menu, not the sheet.
await page.keyboard.press("Escape");
check((await page.$("[data-engine-option]")) === null && (await page.$('[data-testid="nc-sheet"]')) !== null, "Esc closes the menu and keeps the sheet");

// Keys: ↓ opens, ↓ moves to MySQL, ↵ picks it.
await page.focus(chip);
await page.keyboard.press("ArrowDown");
await page.keyboard.press("ArrowDown");
await page.keyboard.press("Enter");
check((await page.getAttribute(chip, "data-engine-pick")) === "mysql", "↓ ↓ ↵ picks MySQL");
check((await page.inputValue(field("port"))) === "3306", "the port follows: 3306");
check((await page.$('[data-field="via"]')) === null, "no Cloud SQL choice for MySQL yet");
check((await page.$("[data-mcp-switch]")) === null, "no agent sharing for MySQL yet");
check((await page.getAttribute(field("url"), "placeholder")).startsWith("mysql://"), "the URL hint is mysql://");
check(!(await page.textContent('[data-field="database"] [data-testid="nc-label"]')).includes("*"), "Database isn't required on MySQL");

// It probes once Host and User are set, without a database.
await page.fill(field("host"), "maria.internal");
await page.fill(field("username"), "app");
await page.fill(field("password"), "secret");
await page.waitForSelector('[data-probe="ok"]', { timeout: 5000 });
const probe = await page.evaluate(() => window.__PROBES__.at(-1));
check(probe.kind === "mysql" && probe.port === 3306 && probe.database === "" && probe.allow_mcp === false, `probed as MySQL on 3306, no database (${JSON.stringify({ kind: probe.kind, port: probe.port, database: probe.database })})`);
check((await page.getAttribute(chip, "data-engine-pick")) === "mysql" && (await page.textContent(chip)).includes("MariaDB"), "the server said MariaDB: the chip shows MariaDB");
check((await page.textContent("[data-probe]")).includes("MariaDB 11.4.3"), "the probe line names MariaDB 11.4.3");
await page.fill(field("name"), "shop");
await shot("3-mariadb");

await page.keyboard.press("Control+Enter");
await page.waitForFunction(() => window.__SAVED__.length === 1);
const saved = await page.evaluate(() => window.__SAVED__[0]);
check(saved.kind === "mysql" && saved.mariadb === true && saved.allow_mcp === false && saved.name === "shop", `saved as MySQL, mariadb: true (${JSON.stringify({ kind: saved.kind, mariadb: saved.mariadb, name: saved.name })})`);

// A mysql:// URL pasted while Postgres is picked switches to MySQL.
await page.waitForSelector('[data-testid="nc-sheet"]', { state: "detached" }).catch(() => {});
await page.keyboard.press("Escape");
await page.keyboard.press("Control+N");
await page.waitForSelector('[data-testid="nc-sheet"]');
check((await page.getAttribute(chip, "data-engine-pick")) === "postgres", "the next new connection starts on Postgres again");
await page.focus(field("url"));
await page.evaluate(() => {
  const input = document.querySelector('[data-testid="nc-sheet"] [data-field="url"] input');
  const data = new DataTransfer();
  data.setData("text/plain", "mysql://reader:pa55@db.internal:3307/orders?ssl-mode=REQUIRED");
  input.dispatchEvent(new ClipboardEvent("paste", { clipboardData: data, bubbles: true, cancelable: true }));
});
await page.waitForTimeout(100);
check((await page.getAttribute(chip, "data-engine-pick")) === "mysql", "a pasted mysql:// URL switches to MySQL");
const filled = await page.$$eval(["host", "port", "database", "username", "password"].map(field).join(","), (els) => els.map((e) => e.value));
check(filled.join(",") === "db.internal,3307,orders,reader,pa55", `the URL filled the form: ${filled.join(",")}`);
check((await page.inputValue(field("url"))).includes("•••"), "the URL shows its password hidden");
await page.waitForSelector('[data-probe="ok"]', { timeout: 5000 });
check(!(await page.textContent(chip)).includes("MariaDB"), "a MySQL server keeps the MySQL chip");
await shot("4-mysql-url");
await page.keyboard.press("Escape");
check(await page.waitForSelector('[data-testid="nc-sheet"]', { state: "detached", timeout: 2000 }).then(() => true, () => false), "Esc closes the sheet");

// The saved MariaDB connection's window: its tab in MariaDB's colour, the
// status naming the server, its database in the sidebar.
await page.waitForSelector('[data-testid="sb-status"][data-state="connected"]', { timeout: 5000 });
const tabColour = await page.$eval('[data-testid="win-tab"]', (e) => e.style.getPropertyValue("--engine"));
check(tabColour === "#c49a6c", `the window tab takes MariaDB's colour (${tabColour})`);
const status = await page.getAttribute('[data-testid="sb-status"]', "title");
check(status === "MariaDB 11.4.3", `the status names the server: ${status}`);
check((await page.textContent("body")).includes("orders"), "the sidebar lists the shop database's table");
await shot("5-window");

await browser.close();
