#!/usr/bin/env node
// rowkery/reports#76: on a MySQL or MariaDB connection a query tab reads a
// `DELIMITER` script as the mysql client does, and a MariaDB compound
// statement (`BEGIN NOT ATOMIC … END`) as one statement. Stubbed `invoke`
// recording each `run_query`: the DELIMITER lines and the custom delimiter
// never reach the server, a routine's body goes whole with the `;` inside it,
// and the statements around it run one by one.
//
//   cd apps/rowkery-tauri && npx vite --port 1420 &
//   node scripts/mysql-delimiter-browser-proof.mjs [outDir]
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
const OUT = process.argv[2] ?? "/tmp/rowkery-proof/mysql-delimiter";
const URL = process.env.ROWKERY_DEV_URL ?? "http://localhost:1420/";
const FRAMES_SHIM = new globalThis.URL("./lib/frames-shim.js", import.meta.url).pathname;
mkdirSync(OUT, { recursive: true });

function stubTauri() {
  localStorage.clear();
  window.__RUNS__ = [];
  const col = (name, type_name) => ({ name, type_name, nullable: false });
  const tables = [{ name: "counters", columns: [col("id", "int"), col("n", "int")], primary_key: ["id"], indexes: [], foreign_keys: [], row_estimate: { Approximate: 3 }, partition_of: null }];
  const done = { columns: [], rows: [], row_count: 0, elapsed_ms: 1, error: null, cancelled: false };
  window.__TAURI_INTERNALS__ = {
    metadata: { currentWindow: { label: "main" }, currentWebview: { label: "main" } },
    transformCallback: () => 0,
    invoke: async (cmd, args) => {
      switch (cmd) {
        case "list_connections":
          return { connections: [{ kind: "mysql", id: "my", name: "shop", host: "127.0.0.1", port: 3306, database: "shop", username: "app" }], active_connection_id: null };
        case "open_window":
          return { database: "shop", catalog: { databases: [{ name: "shop", schemas: [{ name: "shop", tables }] }] }, elapsed_ms: 2, cached: false, open_seq: 1 };
        case "run_query": {
          const sql = args.sql;
          window.__RUNS__.push(sql);
          // As the server reads them: DELIMITER is the client's word, not SQL.
          if (/^\s*delimiter\b/i.test(sql) || /\/\/|\$\$/.test(sql)) return { ...done, error: "You have an error in your SQL syntax", sqlstate: "42000" };
          if (/^select/i.test(sql)) return { ...done, columns: [{ name: "n", type_name: "int" }], rows: [[{ Int: 2 }]], row_count: 1 };
          return done;
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
const page = await browser.newPage({ viewport: { width: 1280, height: 800 }, deviceScaleFactor: 2 });
page.on("pageerror", (e) => console.error("pageerror:", e.message));
await page.addInitScript({ path: FRAMES_SHIM });
await page.addInitScript(stubTauri);
await page.goto(URL);
const ws = '[data-testid="workspace"]:not([hidden])';
await page.waitForSelector(ws);
await page.keyboard.press("Control+Shift+O");
await page.waitForSelector('[data-testid="conn-popover"]');
await page.keyboard.press("Enter");
await page.waitForSelector(`${ws}[data-conn-state="connected"]`);

const editor = `${ws} textarea[data-testid="sql-editor"]`;
const setSql = (text) =>
  page.evaluate(([sel, text]) => {
    const ta = document.querySelector(sel);
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value").set.call(ta, text);
    ta.dispatchEvent(new Event("input", { bubbles: true }));
  }, [editor, text]);
const select = async (from, to) => {
  await page.focus(editor);
  await page.evaluate(([sel, a, b]) => document.querySelector(sel).setSelectionRange(a, b), [editor, from, to]);
};
const runs = () => page.evaluate(() => window.__RUNS__);
const clearRuns = () => page.evaluate(() => (window.__RUNS__ = []));
const idle = () => page.waitForFunction((ws) => !document.querySelector(`${ws} [data-testid="card-meta"][data-state="running"]`), ws);
const flat = (s) => s.replace(/\s+/g, " ").trim();

await page.click(`${ws} [data-testid="query-tab-add"]`);
await page.waitForSelector(editor);

// A script as the mysql client takes it, selected whole, ⌘↵.
const script = `DROP PROCEDURE IF EXISTS bump;
DELIMITER //
CREATE PROCEDURE bump()
BEGIN
  UPDATE counters SET n = n + 1;
  SELECT n FROM counters;
END//
DELIMITER ;
CALL bump();
SELECT n FROM counters;`;
await setSql(script);
await select(0, script.length);
await page.keyboard.press("Control+Enter");
await page.waitForFunction(() => window.__RUNS__.some((s) => /^SELECT n FROM counters;?$/.test(s.trim())));
await idle();
let ran = (await runs()).map(flat);
check(ran.length === 4, `four statements ran one by one (${ran.length}: ${ran.join(" | ")})`);
check(ran.every((s) => !/delimiter|\/\//i.test(s)), "no DELIMITER line and no // reached the server");
check(ran[1] === "CREATE PROCEDURE bump() BEGIN UPDATE counters SET n = n + 1; SELECT n FROM counters; END", `the routine went whole, its own ; inside (${ran[1]})`);
check(ran[0].startsWith("DROP PROCEDURE IF EXISTS bump") && ran[2].startsWith("CALL bump()") && ran[3].startsWith("SELECT n FROM counters"), "the statements around it ran in order");
check((await page.$(`${ws} [data-query-error]`)) === null, "no error shown");
await page.screenshot({ path: `${OUT}/1-delimiter-script.png` });

// The script alone in the tab, nothing selected: ⌘↵ still reads it as a script.
await clearRuns();
const only = "DELIMITER $$\nCREATE PROCEDURE one() BEGIN SELECT 1; END$$";
await setSql(only);
await select(only.length, only.length);
await page.keyboard.press("Control+Enter");
await page.waitForFunction(() => window.__RUNS__.length >= 1);
await idle();
ran = (await runs()).map(flat);
check(ran.length === 1 && ran[0] === "CREATE PROCEDURE one() BEGIN SELECT 1; END", `one statement, without its DELIMITER line or $$ (${ran.join(" | ")})`);

// MariaDB's compound statement outside a routine is one statement.
await clearRuns();
const block = "BEGIN NOT ATOMIC\n  UPDATE counters SET n = 0;\n  UPDATE counters SET n = n + 2;\nEND;\nSELECT n FROM counters;";
await setSql(block);
await select(0, block.length);
await page.keyboard.press("Control+Enter");
await page.waitForFunction(() => window.__RUNS__.length === 2);
await idle();
ran = (await runs()).map(flat);
check(ran[0].startsWith("BEGIN NOT ATOMIC UPDATE counters SET n = 0; UPDATE counters SET n = n + 2; END") && ran[1].startsWith("SELECT n FROM counters"), `BEGIN NOT ATOMIC … END ran whole, then the SELECT (${ran.join(" | ")})`);
check((await page.$(`${ws} [data-query-error]`)) === null, "no error shown");
await page.screenshot({ path: `${OUT}/2-begin-not-atomic.png` });
await browser.close();
