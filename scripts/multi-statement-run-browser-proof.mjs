#!/usr/bin/env node
// Issue #183: a selection that holds several statements (a migration script
// with BEGIN … COMMIT) runs one statement at a time on the tab's session, as
// Run All does, instead of going to the server as one text (which Postgres
// refuses: "cannot insert multiple commands into a prepared statement").
// The stub refuses multi-statement text the same way. It stops at the first
// statement that fails, and that statement's error marks its own token.
// A caret run is still the statement under the caret.
//
//   cd apps/rowkery-tauri && npx vite --port 1420 &
//   node scripts/multi-statement-run-browser-proof.mjs [outDir]
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
const OUT = process.argv[2] ?? "/tmp/rowkery-proof/multi-statement-run";
const URL = process.env.ROWKERY_DEV_URL ?? "http://localhost:1420/";
const FRAMES_SHIM = new globalThis.URL("./lib/frames-shim.js", import.meta.url).pathname;
mkdirSync(OUT, { recursive: true });

function stubTauri() {
  localStorage.clear();
  window.__RUNS__ = [];
  const col = (name, type_name) => ({ name, type_name, nullable: false });
  const tables = [
    { name: "alembic_version", columns: [col("version_num", "varchar")], primary_key: ["version_num"], indexes: [], foreign_keys: [], row_estimate: { Approximate: 3 }, partition_of: null },
    { name: "invitations", columns: [col("id", "int8"), col("seat_ends_at", "timestamptz")], primary_key: ["id"], indexes: [], foreign_keys: [], row_estimate: { Approximate: 3 }, partition_of: null },
  ];
  const done = { columns: [], rows: [], row_count: 0, elapsed_ms: 1, error: null, cancelled: false };
  window.__TAURI_INTERNALS__ = {
    metadata: { currentWindow: { label: "main" }, currentWebview: { label: "main" } },
    transformCallback: () => 0,
    invoke: async (cmd, args) => {
      switch (cmd) {
        case "list_connections":
          return { connections: [{ kind: "postgres", id: "pg", name: "app", host: "127.0.0.1", port: 5432, database: "rowkery", username: "rowkery" }], active_connection_id: null };
        case "open_window":
          return { database: "rowkery", catalog: { databases: [{ name: "rowkery", schemas: [{ name: "public", tables }] }] }, elapsed_ms: 2, cached: false, open_seq: 1 };
        case "run_query": {
          const sql = args.sql;
          window.__RUNS__.push(sql);
          // Like Postgres' extended protocol: one statement per prepare.
          if (/;\s*\S/.test(sql)) return { ...done, error: "cannot insert multiple commands into a prepared statement", sqlstate: "42601" };
          if (/\bnmae\b/.test(sql)) return { ...done, error: 'column "nmae" does not exist', sqlstate: "42703", error_position: sql.indexOf("nmae") + 1 };
          if (/^select/i.test(sql)) return { ...done, columns: [{ name: "version_num", type_name: "varchar" }], rows: [[{ Text: "20261007_091850" }], [{ Text: "20261008_024235" }]], row_count: 2 };
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

// The script from the issue, selected whole, ⌘↵.
const script = `BEGIN;

ALTER TABLE invitations DROP COLUMN seat_ends_at;
ALTER TABLE invitations DROP COLUMN seat_length_days;

DELETE FROM alembic_version
WHERE version_num = '20261009_055350';

INSERT INTO alembic_version (version_num)
VALUES
  ('20261007_091850'),
  ('20261008_024235'),
  ('20261008_071555');

SELECT version_num FROM alembic_version ORDER BY version_num;

COMMIT;`;
await setSql(script);
await select(0, script.length);
await page.keyboard.press("Control+Enter");
await page.waitForFunction(() => window.__RUNS__.at(-1) === "COMMIT;");
await idle();
const ran = await runs();
check(ran.length === 7, `seven statements ran one by one (${ran.length})`);
check(ran[0] === "BEGIN;" && ran[1].startsWith("ALTER TABLE invitations DROP COLUMN seat_ends_at") && ran[5].startsWith("SELECT version_num"), "in order, each on its own");
check(ran.every((s) => !/;\s*\S/.test(s)), "no run carried more than one statement");
check((await page.$(`${ws} [data-query-error]`)) === null, "no error shown");
await page.screenshot({ path: `${OUT}/1-script-ran.png` });

// A failing statement in the middle stops the rest and marks its own token.
await clearRuns();
const bad = "SELECT 1;\nSELECT nmae FROM alembic_version;\nSELECT 2;";
await setSql(bad);
await select(0, bad.length);
await page.keyboard.press("Control+Enter");
await page.waitForSelector(`${ws} [data-query-error="42703"]`);
await page.waitForTimeout(150);
check((await runs()).join("|") === "SELECT 1;|SELECT nmae FROM alembic_version;", `stopped at the failing statement (${(await runs()).join("|")})`);
const at = bad.indexOf("nmae");
const mark = await page.getAttribute(`${ws} [data-mark]`, "data-mark").catch(() => null);
check(mark === `${at}-${at + 4}`, `the error marks its token in the editor (${mark})`);
await page.screenshot({ path: `${OUT}/2-stops-at-error.png` });

// A selection inside the text: offsets count from where it starts.
await clearRuns();
const lead = "-- notes\nSELECT 9;\n";
const tail = "SELECT 1;\nSELECT nmae FROM alembic_version;";
await setSql(lead + tail);
await select(lead.length, lead.length + tail.length);
await page.keyboard.press("Control+Enter");
await page.waitForSelector(`${ws} [data-query-error="42703"]`);
await page.waitForTimeout(150);
const at2 = lead.length + tail.indexOf("nmae");
const mark2 = await page.getAttribute(`${ws} [data-mark]`, "data-mark").catch(() => null);
check((await runs()).length === 2 && mark2 === `${at2}-${at2 + 4}`, `a partial selection runs its statements, error marked in place (${mark2})`);

// Caret, no selection: only the statement under it.
await clearRuns();
await setSql("SELECT 1;\nSELECT 2;");
await select(12, 12);
await page.keyboard.press("Control+Enter");
await page.waitForFunction(() => window.__RUNS__.length === 1);
await idle();
check((await runs()).join("|") === "SELECT 2;", "a caret run is still one statement");
await browser.close();
