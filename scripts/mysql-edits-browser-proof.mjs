#!/usr/bin/env node
// Grid edits on a MySQL table (stubbed `invoke`; core's statements, locks
// and cascade counts are proved against MySQL 8.0, 8.4 and MariaDB 10.11,
// 11.4 by `cargo test -p rowkery-core --features mysql-integration --test
// mysql_integration`). Each column type opens its editor (text, bool for
// tinyint(1), the enum's labels from COLUMN_TYPE, a date taking now(),
// none for a blob); a delete whose cascades are counted and whose
// trigger isn't stops before COMMIT, says both, and Commit all (no number:
// some rows aren't counted) sends that reach back and commits. A row keyed
// by a BINARY(16) column edits by that key (rowkery/reports#68); one keyed
// by 32 bytes, of which the grid holds 16, opens no editor and says why.
//
//   cd apps/rowkery-tauri && npx vite --port 1420 &
//   node scripts/mysql-edits-browser-proof.mjs [outDir] [light|dark]
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
const OUT = process.argv[2] ?? "/tmp/rowkery-proof/mysql-edits";
const THEME = process.argv[3] ?? "light";
const URL = process.env.ROWKERY_DEV_URL ?? "http://localhost:1420/";
const FRAMES_SHIM = new globalThis.URL("./lib/frames-shim.js", import.meta.url).pathname;
mkdirSync(OUT, { recursive: true });

function stubTauri(theme) {
  const col = (name, type_name, extra = {}) => ({ name, type_name, nullable: true, ...extra });
  const customers = [
    col("id", "int", { nullable: false }),
    col("name", "varchar(40)", { nullable: false }),
    col("active", "tinyint(1)", { nullable: false, default: "1" }),
    col("tier", "enum('free','pro','it''s')"),
    col("joined", "date"),
    col("avatar", "blob"),
  ];
  const table = (name, columns, extra = {}) => ({ name, kind: "table", columns, primary_key: ["id"], indexes: [], row_estimate: { Approximate: 4 }, foreign_keys: [], ...extra });
  const catalog = {
    databases: [
      {
        name: "def",
        schemas: [
          {
            name: "shop",
            tables: [
              table("customers", customers),
              table("sessions", [col("token", "binary(16)", { nullable: false }), col("device", "varchar(40)")], { primary_key: ["token"] }),
              table("files", [col("digest", "binary(32)", { nullable: false }), col("name", "varchar(40)")], { primary_key: ["digest"] }),
              table("orders", [col("id", "int", { nullable: false }), col("customer_id", "int")], {
                foreign_keys: [{ name: "orders_ibfk_1", columns: ["customer_id"], ref_schema: "shop", ref_table: "customers", ref_columns: ["id"], on_delete: "CASCADE" }],
              }),
            ],
          },
        ],
      },
    ],
    search_path: ["shop"],
    enums: [],
    functions: [],
  };
  const T = (Text) => ({ Text });
  const rows = Array.from({ length: 4 }, (_, i) => [{ Int: i + 1 }, T(`Customer ${i + 1}`), { Int: i % 2 }, T(["free", "pro"][i % 2]), T(`2026-0${i + 1}-15`), { Bytes: [0, 255] }]);
  window.__CALLS__ = [];
  localStorage.clear();
  localStorage.setItem("rowkery.windows", JSON.stringify({ windows: [{ connectionId: "my", database: "shop" }], active: 0 }));
  window.__TAURI_INTERNALS__ = {
    metadata: { currentWindow: { label: "main" }, currentWebview: { label: "main" } },
    transformCallback: () => 0,
    invoke: async (cmd, args) => {
      window.__CALLS__.push([cmd, args]);
      switch (cmd) {
        case "get_theme":
        case "load_theme":
          return theme;
        case "list_connections":
          return { connections: [{ kind: "mysql", id: "my", name: "shop", host: "127.0.0.1", port: 3306, database: "shop", username: "app", environment: "dev" }], active_connection_id: null };
        case "open_window":
          return { database: "shop", catalog, server_version: "8.4.3", server_flavor: "MySQL", elapsed_ms: 3, cached: false, open_seq: 1 };
        case "browse_table_sql":
          return `SELECT * FROM shop.${args.table}\nLIMIT ${args.limit ?? 1000};`;
        case "run_query": {
          // A frame carries 16 bytes of a binary cell and its whole length.
          const keyed = (key, bytes, label) => ({
            columns: [{ name: key, type_name: "binary" }, { name: label, type_name: "varchar" }],
            rows: [1, 2].map((n) => [{ Bytes: Array.from({ length: 16 }, (_, i) => n * 16 + i), byteLength: bytes }, T(`row ${n}`)]),
            row_count: 2,
            elapsed_ms: 2,
            error: null,
            cancelled: false,
          });
          if (String(args.sql).includes("shop.sessions")) return keyed("token", 16, "device");
          if (String(args.sql).includes("shop.files")) return keyed("digest", 32, "name");
          const cols = customers.map((c) => ({ name: c.name, type_name: c.type_name.split("(")[0] }));
          return { columns: cols, rows, row_count: rows.length, elapsed_ms: 2, error: null, cancelled: false };
        }
        case "review_changes":
          return { statements: [], sql: "BEGIN;\nDELETE FROM shop.customers WHERE id = 2;\nCOMMIT;" };
        case "apply_changes": {
          // Deleting customer 2: 3 orders cascade (counted, locked) and a
          // trigger on customers writes what it likes (named, not counted).
          if (args.changes.some((c) => c.op === "delete") && !args.reach)
            return {
              status: "rolled_back",
              index: null,
              statement: null,
              rows: null,
              message: "It also changes rows in other tables. Commit again to save them all.",
              reach: { tables: [{ schema: "shop", table: "orders", inserted: 0, updated: 0, deleted: 3 }], unnamed: 0, uncounted: ["triggers on shop.customers"] },
              elapsed_ms: 5,
            };
          const n = (op) => args.changes.filter((c) => c.op === op).length;
          return { status: "committed", inserted: n("insert"), updated: n("update"), deleted: n("delete"), elapsed_ms: 9 };
        }
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
const page = await browser.newPage({ viewport: { width: 1280, height: 760 }, deviceScaleFactor: 2, colorScheme: THEME });
page.on("pageerror", (e) => {
  console.error("pageerror:", e.message);
  process.exitCode = 1;
});
await page.addInitScript({ path: FRAMES_SHIM });
await page.addInitScript(stubTauri, THEME);
await page.goto(URL);
const ws = '[data-testid="workspace"]:not([hidden])';
await page.waitForSelector(`${ws}[data-conn-state="connected"]`);
await page.evaluate((t) => (document.documentElement.dataset.theme = t), THEME);
const shot = (name) => page.screenshot({ path: `${OUT}/${name}-${THEME}.png` });

await page.locator(`${ws} [data-testid="sb-row-main"][title="shop.customers"]`).last().dblclick();
await page.waitForFunction((ws) => document.querySelectorAll(`${ws} [data-testid="rg-body"] [data-row]`).length > 0, ws);
const COLS = ["id", "name", "active", "tier", "joined", "avatar"];
const cell = (row, column) => page.locator(`${ws} [data-testid="rg-body"] [data-row="${row}"] [data-col="${COLS.indexOf(column)}"]`);
const editorKind = () => page.locator(`${ws} [data-cell-editor]`).getAttribute("data-cell-editor", { timeout: 1500 }).catch(() => null);
const openOn = async (row, column) => {
  await cell(row, column).click();
  await page.keyboard.press("Enter");
  return editorKind();
};

check((await openOn(0, "name")) === "text", "varchar opens the text editor");
await page.keyboard.press("ControlOrMeta+a");
await page.keyboard.type("Ana's \\ shop");
await page.keyboard.press("Enter");
check((await cell(0, "name").textContent()).trim() === "Ana's \\ shop", "the text stages as typed");
check((await openOn(1, "active")) === "bool", "tinyint(1) opens the boolean editor");
await page.keyboard.press("Escape");
check((await openOn(2, "tier")) === "enum", "an enum opens its labels");
const labels = await page.locator(`${ws} [data-editor-list] [role="option"]`).allTextContents();
check(labels.join("|") === "free|pro|it's", `labels from COLUMN_TYPE: ${labels.join("|")}`);
await shot("1-enum");
await page.keyboard.press("Escape");
check((await openOn(3, "joined")) === "date", "a date opens the date editor");
const hint = await page.locator(`${ws} [data-cell-editor] input`).getAttribute("placeholder");
check(hint === "YYYY-MM-DD · now()", `its hint: ${hint}`);
await page.keyboard.press("Escape");
check((await openOn(3, "avatar")) === null, "a blob opens no editor");
await page.keyboard.press("Escape");

// Revert the name, then delete customer 2 and commit.
await cell(0, "name").click();
await page.keyboard.press("Escape");
await page.locator(`${ws} [data-testid="rg-body"] [data-row="1"] [data-testid="rg-gutter"]`).click();
await page.keyboard.press("Backspace");
await page.keyboard.press("Control+s");
await page.waitForSelector(`${ws} [data-edit-tray="reach"]`);
const reachText = (await page.locator(`${ws} [data-tray-reach]`).textContent()).replace(/\s+/g, " ").trim();
check(
  reachText === "Not saved yet · deleting this row also deletes 3 orders and writes rows Rowkery can't count (triggers on shop.customers)",
  `the bar: ${reachText}`,
);
const commitLabel = (await page.locator(`${ws} [data-commit]`).textContent()).trim();
check(commitLabel.startsWith("Commit all") && !/\d/.test(commitLabel.replace(/⌘|Ctrl|S/g, "")), `Commit all carries no number: ${commitLabel}`);
await shot("2-reach");
await page.keyboard.press("Control+s");
await page.waitForSelector(`${ws} [data-edit-tray="done"]`);
const applied = await page.evaluate(() => window.__CALLS__.filter(([c]) => c === "apply_changes").map(([, a]) => a));
const last = applied.at(-1);
check(last.table.schema === "shop" && last.table.table === "customers", "the edits go to shop.customers");
check(last.reach?.uncounted?.[0] === "triggers on shop.customers" && last.reach.tables[0].deleted === 3, "Commit all sends back the reach it showed");
check((await page.locator(`${ws} [data-edit-tray]`).textContent()).startsWith("Deleted 1"), `committed: ${await page.locator(`${ws} [data-edit-tray]`).textContent()}`);

// A BINARY(16) key names its row: the edit stages and commits by it.
const openTable = async (name) => {
  await page.locator(`${ws} [data-testid="sb-row-main"][title="shop.${name}"]`).last().dblclick();
  await page.waitForFunction(([ws, n]) => document.querySelectorAll(`${ws} [data-testid="rg-body"] [data-row]`).length === n, [ws, 2]);
};
const second = (row) => page.locator(`${ws} [data-testid="rg-body"] [data-row="${row}"] [data-col="1"]`);
await openTable("sessions");
await second(0).click();
await page.keyboard.press("Enter");
check((await editorKind()) === "text", "a row keyed by BINARY(16) opens its editor");
await page.keyboard.press("ControlOrMeta+a");
await page.keyboard.type("phone");
await page.keyboard.press("Enter");
check((await second(0).textContent()).trim() === "phone", "the edit stages");
await page.keyboard.press("Control+s");
await page.waitForSelector(`${ws} [data-edit-tray="done"]`);
const byKey = (await page.evaluate(() => window.__CALLS__.filter(([c]) => c === "apply_changes").map(([, a]) => a))).at(-1);
const sent = JSON.stringify(byKey.changes);
check(byKey.table.table === "sessions" && sent.includes(`"Bytes":[${Array.from({ length: 16 }, (_, i) => 16 + i).join(",")}]`), `it commits by the whole key: ${sent}`);
await shot("3-binary-key");

// A 32-byte key, 16 bytes loaded: no editor, and the tray says why.
await openTable("files");
await second(0).click();
await page.keyboard.press("Enter");
check((await editorKind()) === null, "a row whose binary key is cut opens no editor");
const why = (await page.locator(`${ws} [data-edit-tray="refused"]`).textContent()).trim();
check(why === "This row's binary key is over 16 bytes, so it can't be edited here", `the tray: ${why}`);
await shot("4-binary-key-too-long");

await browser.close();
