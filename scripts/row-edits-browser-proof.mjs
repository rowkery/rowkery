#!/usr/bin/env node
// Row edits proof without a Tauri webview or Postgres (stubbed `invoke`; core's
// statements and their one-row invariant are covered by `cargo test -p
// rowkery-core edits` and `-p rowkery-bridge apply_changes`). On a table tab with
// a primary key: ↵ opens the typed editor (text, number, Space-toggled
// boolean, the enum's labels, the foreign key picker searching the
// referenced table, JSON in its own pane), ↵ stages, Esc reverts, ⌥⇧N
// (Ctrl+Alt+N here) stages NULL, ⌘I inserts a row with its defaults, ⌘D
// duplicates, ⌫ on whole rows marks them, a pasted block stages cell by
// cell. Marks are data attributes: `data-edited` on a cell (the 2 px bar),
// `data-mark` on a row (the gutter dot). A table without a primary key and a
// Read-only connection open no editor and say why. Staged edits are saved
// with the tab and come back with Reopen closed tab. The tray counts them;
// Review SQL (⇧⌘P) shows core's BEGIN … COMMIT; Commit (⌘S) on Off runs at
// once, and a 2-row match (a duplicate the stub says a dropped unique index
// let in) rolls everything back with the tray naming the row; Confirm writes
// shows the statements in the SafetyBar and sends back exactly that SQL on
// ⇧⌘↵; Discard has Undo.
//
//   cd apps/rowkery-tauri && npx vite --port 1420 &
//   node scripts/row-edits-browser-proof.mjs [outDir]
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
  playwright = require(`${execSync("npm root -g").toString().trim()}/playwright`);
}

const OUT = process.argv[2] ?? "/tmp/rowkery-proof/row-edits";
const URL = process.env.ROWKERY_DEV_URL ?? "http://localhost:1420/";
mkdirSync(OUT, { recursive: true });

function stubTauri() {
  const col = (name, type_name, extra = {}) => ({ name, type_name, nullable: true, ...extra });
  const id = col("id", "bigint", { nullable: false, default: "nextval('kiosks_id_seq'::regclass)" });
  const kioskCols = [
    id,
    col("name", "text", { nullable: false }),
    col("city", "text"),
    col("active", "boolean", { nullable: false, default: "true" }),
    col("status", "kiosk_status"),
    col("region_id", "bigint"),
    col("meta", "jsonb"),
    col("opened_at", "timestamp with time zone", { default: "now()" }),
  ];
  const table = (name, columns, extra = {}) => ({
    name,
    kind: "table",
    columns,
    primary_key: ["id"],
    indexes: [],
    row_estimate: { Approximate: 40 },
    foreign_keys: [],
    partition_of: null,
    ...extra,
  });
  const catalog = {
    databases: [
      {
        name: "wallet",
        schemas: [
          {
            name: "public",
            tables: [
              table("audit_log", [col("at", "timestamp with time zone"), col("note", "text")], { primary_key: [] }),
              table("kiosks", kioskCols, {
                foreign_keys: [
                  { name: "kiosks_region_fkey", columns: ["region_id"], ref_schema: "public", ref_table: "regions", ref_columns: ["id"], on_delete: "NO ACTION" },
                ],
              }),
              table("regions", [col("id", "bigint", { nullable: false }), col("name", "text")]),
            ],
          },
        ],
      },
    ],
    enums: [{ schema: "public", name: "kiosk_status", labels: ["open", "closed", "maintenance"] }],
  };
  const conns = [
    { kind: "postgres", id: "off", name: "wallet-dev", host: "127.0.0.1", port: 54329, database: "wallet", username: "rowkery", environment: "dev" },
    { kind: "postgres", id: "ro", name: "wallet-ro", host: "127.0.0.1", port: 54329, database: "wallet", username: "rowkery", safe_mode: "read_only" },
    { kind: "postgres", id: "cw", name: "wallet-prd", host: "127.0.0.1", port: 54329, database: "wallet", username: "rowkery", environment: "prd", safe_mode: "confirm" },
  ];
  const windows = {};
  // Like core's build_row_changes, for the stub's needs (one-column key `id`).
  const lit = (v) => (v === null || "Null" in v ? "NULL" : "Int" in v ? String(v.Int) : "Bool" in v ? String(v.Bool).toUpperCase() : `'${String(v.Text).replace(/'/g, "''")}'`);
  const sqlFor = (changes) =>
    `BEGIN;\n${changes
      .map((c) =>
        c.op === "insert"
          ? `INSERT INTO public.kiosks (${c.values.map((v) => v.column).join(", ")}) VALUES (${c.values.map((v) => lit(v.value)).join(", ")})`
          : c.op === "update"
            ? `UPDATE public.kiosks SET ${c.set.map((v) => `${v.column} = ${lit(v.value)}`).join(", ")} WHERE id = ${lit(c.key[0].value)}`
            : `DELETE FROM public.kiosks WHERE id = ${lit(c.key[0].value)}`,
      )
      .map((l) => `${l};\n`)
      .join("")}COMMIT;`;
  const T = (Text) => ({ Text });
  const CITIES = ["KL", "Petaling Jaya", "Shah Alam", "Klang"];
  const REGIONS = ["Klang Valley", "Penang", "Johor", "Sabah"];
  const rowsOf = (from) => {
    if (from === "kiosks")
      return Array.from({ length: 12 }, (_, i) => [
        { Int: i + 1 },
        T(`Kiosk ${i + 1}`),
        T(CITIES[i % 4]),
        { Bool: i % 3 !== 0 },
        T(["open", "closed", "maintenance"][i % 3]),
        { Int: (i % 4) + 1 },
        T(`{"floor": ${i % 5}}`),
        T(`2025-0${(i % 9) + 1}-12 09:30:00+00`),
      ]);
    if (from === "regions") return REGIONS.map((n, i) => [{ Int: i + 1 }, T(n)]);
    return [[T("2026-10-01 10:00:00+00"), T("login")], [T("2026-10-01 10:05:00+00"), T("logout")]];
  };
  const colsOf = (from) => {
    const t = catalog.databases[0].schemas[0].tables.find((x) => x.name === from);
    const wire = { bigint: "int8", text: "text", boolean: "bool", jsonb: "jsonb", "timestamp with time zone": "timestamptz" };
    return t.columns.map((c) => ({ name: c.name, type_name: wire[c.type_name] ?? c.type_name }));
  };
  window.__CALLS__ = [];
  window.__TAURI_INTERNALS__ = {
    metadata: { currentWindow: { label: "main" }, currentWebview: { label: "main" } },
    transformCallback: () => 0,
    invoke: async (cmd, args) => {
      window.__CALLS__.push([cmd, args]);
      switch (cmd) {
        case "list_connections":
          return { connections: conns, active_connection_id: null };
        case "open_window":
          windows[args.windowId] = conns.find((c) => c.id === args.connectionId);
          return { database: "wallet", catalog, elapsed_ms: 5 };
        case "review_changes":
          return { statements: [], sql: sqlFor(args.changes) };
        case "apply_changes": {
          const sql = sqlFor(args.changes);
          const mode = windows[args.windowId]?.safe_mode ?? "off";
          if (mode === "read_only")
            return { status: "held", hold: { action: "refuse", mode, statements: [] }, sql };
          if (mode === "confirm" && args.confirmed !== sql)
            return {
              status: "held",
              hold: { action: "confirm", mode, statements: [{ kind: "write", verb: "UPDATE", target: "public.kiosks", destructive: false, unlocks_writes: false }] },
              sql,
            };
          // Two rows have id 2 (the unique index was dropped): its UPDATE changes 2.
          const bad = args.changes.findIndex((c) => c.op !== "insert" && c.key[0].value.Int === 2);
          if (bad >= 0)
            return { status: "rolled_back", index: bad, statement: "UPDATE public.kiosks WHERE id = 2", rows: 2, message: "UPDATE public.kiosks WHERE id = 2 changed 2 rows", elapsed_ms: 4 };
          const n = (op) => args.changes.filter((c) => c.op === op).length;
          return { status: "committed", inserted: n("insert"), updated: n("update"), deleted: n("delete"), elapsed_ms: 24 };
        }
        case "browse_table_sql": {
          let sql = `SELECT * FROM public.${args.table}`;
          if (args.filter) sql += `\nWHERE (${args.filter})`;
          return `${sql}\nLIMIT ${args.limit ?? 1000};`;
        }
        case "run_query": {
          const from = /FROM\s+public\.(\w+)/i.exec(args.sql)?.[1] ?? "kiosks";
          let rows = rowsOf(from);
          // The picker's search: text that holds the query.
          const q = /ILIKE '%(.*?)%'/.exec(args.sql)?.[1];
          if (q) rows = rows.filter((r) => r.some((c) => String(c.Text ?? c.Int ?? "").toLowerCase().includes(q.toLowerCase())));
          return { columns: colsOf(from), rows, row_count: rows.length, elapsed_ms: 3, error: null, cancelled: false };
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
const ws = '[data-testid="workspace"]:not([hidden])';
/** A fresh window on `connectionId`. */
const launch = async (connectionId) => {
  const p = await browser.newPage({ viewport: { width: 1360, height: 820 }, deviceScaleFactor: 2 });
  p.on("pageerror", (e) => {
    console.error("pageerror:", e.message);
    process.exitCode = 1;
  });
  await p.addInitScript({ path: FRAMES_SHIM });
  await p.addInitScript(stubTauri);
  await p.addInitScript((id) => {
    if (sessionStorage.getItem("seeded")) return;
    sessionStorage.setItem("seeded", "1");
    localStorage.clear();
    localStorage.setItem("rowkery.windows", JSON.stringify({ windows: [{ connectionId: id, database: "wallet" }], active: 0 }));
  }, connectionId);
  await p.goto(URL);
  await p.waitForSelector(`${ws}[data-conn-state="connected"]`);
  return p;
};
let page = await launch("off");

const shot = (name) => page.screenshot({ path: `${OUT}/${name}.png` });
const openTable = async (name) => {
  await page.locator(`${ws} [data-testid="sb-row-main"][title="public.${name}"]`).last().dblclick();
  await page.waitForFunction((ws) => document.querySelectorAll(`${ws} [data-testid="rg-body"] [data-row]`).length > 0, ws);
};
const COLS = ["id", "name", "city", "active", "status", "region_id", "meta", "opened_at"];
const cell = (row, column) => page.locator(`${ws} [data-testid="rg-body"] [data-row="${row}"] [data-col="${COLS.indexOf(column)}"]`);
const cellText = async (row, column) => (await cell(row, column).textContent()).trim();
const pick = async (row, column) => {
  await cell(row, column).click();
};
const editorKind = () => page.locator(`${ws} [data-cell-editor]`).getAttribute("data-cell-editor", { timeout: 1500 }).catch(() => null);
const noEditor = async () => (await page.locator(`${ws} [data-cell-editor]`).count()) === 0;
const rowMark = (row) => page.locator(`${ws} [data-testid="rg-body"] [data-row="${row}"]`).getAttribute("data-mark");
const toastText = () => page.$$eval("[data-toast] > span", (els) => els.map((e) => e.textContent.trim()).join(" · ")).catch(() => "");

// 1. A table with a primary key: ↵ edits text; ↵ stages and selects the cell below.
await openTable("kiosks");
// Every row loaded with no filter: the sidebar counts 12 over the catalog's estimate of 40.
const sidebarRows = (t) => page.locator(`${ws} [data-table="wallet.public.${t}"] [data-rows]`).first().getAttribute("data-rows", { timeout: 2000 }).catch(() => null);
await page.waitForFunction((ws) => document.querySelector(`${ws} [data-table="wallet.public.kiosks"] [data-rows]`)?.getAttribute("data-rows") === "12", ws, { timeout: 3000 }).catch(() => {});
check((await sidebarRows("kiosks")) === "12", `the sidebar counts the rows loaded: ${await sidebarRows("kiosks")}`);
await pick(2, "city");
await page.keyboard.press("Enter");
check((await editorKind()) === "text", "↵ opens the text editor on city");
await page.keyboard.press("ControlOrMeta+a");
await page.keyboard.type("Petaling Jaya Selatan");
await shot("1-text-editor");
await page.keyboard.press("Enter");
check(await noEditor(), "↵ stages and closes the editor");
check((await cellText(2, "city")) === "Petaling Jaya Selatan", "the staged value shows in the cell");
check((await cell(2, "city").getAttribute("data-edited")) === "" && (await rowMark(2)) === "edit", "edited cell bar (data-edited) and row dot (data-mark=edit)");
check((await cell(2, "city").getAttribute("title")).startsWith("Was Shah Alam · Esc reverts"), "tooltip names the old value");
check((await page.locator(`${ws} [data-col][data-active]`).getAttribute("data-col")) === String(COLS.indexOf("city")), "the ring moved down one row");

// Esc on an edited cell reverts it.
await pick(2, "city");
await page.keyboard.press("Escape");
check((await cellText(2, "city")) === "Shah Alam" && (await rowMark(2)) === null, "Esc reverts the cell and its mark");

// 2. Number: non-numbers are refused in place.
await pick(0, "region_id");
await page.keyboard.press("F2");
check((await editorKind()) === "fk", "F2 opens region_id's foreign key picker");
await page.keyboard.press("ControlOrMeta+a");
await page.keyboard.type("pen");
await page.waitForSelector(`${ws} [data-editor-list] [role="option"]`);
const options = await page.locator(`${ws} [data-editor-list] [role="option"]`).allTextContents();
check(options.join("|") === "2 · Penang", `picker searches regions: ${options.join("|")}`);
await shot("2-fk-picker");
await page.keyboard.press("ArrowDown");
await page.keyboard.press("Enter");
check((await cellText(0, "region_id")) === "2", "↵ picks the key");
const searched = await page.evaluate(() => window.__CALLS__.filter(([c, a]) => c === "browse_table_sql" && a.table === "regions").map(([, a]) => a.filter));
check(searched.some((f) => /ILIKE '%pen%'/.test(f ?? "")), "the picker searched regions by text");

// 3. Boolean: Space toggles, ↵ stages.
await pick(1, "active");
await page.keyboard.press("Enter");
check((await editorKind()) === "bool", "boolean editor");
await page.keyboard.press("Space");
check((await page.locator(`${ws} [data-cell-editor="bool"]`).getAttribute("data-value")) === "false", "Space toggles true → false");
await page.keyboard.press("Enter");
check((await cellText(1, "active")) === "false", "staged false");

// 4. Enum: the catalog's labels, filtered as you type.
await pick(3, "status");
await page.keyboard.press("Enter");
check((await editorKind()) === "enum", "enum editor");
check((await page.locator(`${ws} [data-editor-list] [role="option"]`).allTextContents()).join("|") === "open|closed|maintenance", "lists kiosk_status labels");
await page.keyboard.press("ControlOrMeta+a");
await page.keyboard.type("main");
await shot("3-enum");
await page.keyboard.press("Enter");
check((await cellText(3, "status")) === "maintenance", "the one match stages on ↵");

// 5. JSON in its own pane: invalid JSON is refused, ⌘↵ (Ctrl+↵) stages.
await pick(4, "meta");
await page.keyboard.press("Enter");
check((await editorKind()) === "json", "JSON pane");
await page.keyboard.press("ControlOrMeta+a");
await page.keyboard.type('{"floor": 2, oops}');
await page.keyboard.press("Control+Enter");
check((await page.locator(`${ws} [data-cell-editor="json"] textarea`).getAttribute("data-editor-error")) === "Not valid JSON", "invalid JSON is refused");
await page.keyboard.press("ControlOrMeta+a");
await page.keyboard.type('{"floor": 2, "kiosk": "it\'s"}');
await shot("4-json");
await page.keyboard.press("Control+Enter");
check((await cellText(4, "meta")) === '{"floor": 2, "kiosk": "it\'s"}', "JSON staged");

// 6. ⌥⇧N (Ctrl+Alt+N): NULL, on a selected cell or in an editor.
await pick(5, "city");
await page.keyboard.press("Control+Alt+n");
check((await cell(5, "city").locator('[data-testid="rg-null"]').count()) === 1 && (await rowMark(5)) === "edit", "Ctrl+Alt+N stages NULL");
await pick(6, "name");
await page.keyboard.press("Control+Alt+n");
check((await cell(6, "name").getAttribute("data-edited")) === null, "a NOT NULL column keeps its value");

// 7. ⌘I (Ctrl+I): a new row at the top, defaults dim, its first column to type opens.
await pick(0, "name");
await page.keyboard.press("Control+i");
await page.waitForSelector(`${ws} [data-testid="rg-inserts"] [data-mark="insert"]`);
check((await editorKind()) === "text", "the new row's name editor opens");
await page.keyboard.type("Kiosk Puchong");
await page.keyboard.press("Tab");
check((await editorKind()) === "text", "Tab moves to city");
await page.keyboard.type("KL");
await page.keyboard.press("Enter");
const insertCells = await page.locator(`${ws} [data-testid="rg-inserts"] [data-col]`).allTextContents();
check(insertCells[0] === "default" && insertCells[1] === "Kiosk Puchong" && insertCells[2] === "KL" && insertCells[3] === "default", `new row: ${insertCells.join("|")}`);
check((await page.locator(`${ws} [data-testid="rg-inserts"] [data-col][data-default]`).first().getAttribute("title")) === "Sent as DEFAULT", "⌂ default cells say they're sent as DEFAULT");

// 8. ⌘D (Ctrl+D): the selected row again, its serial key left to the database.
await pick(7, "name");
await page.keyboard.press("Control+d");
check((await page.locator(`${ws} [data-testid="rg-inserts"] [data-mark="insert"]`).count()) === 2, "Ctrl+D duplicates the row");
const dup = await page.locator(`${ws} [data-testid="rg-inserts"] [data-mark="insert"]`).first().locator("[data-col]").allTextContents();
check(dup[0] === "default" && dup[1] === "Kiosk 8", `duplicate keeps values, id is DEFAULT: ${dup.slice(0, 3).join("|")}`);

// 9. ⌫ on whole rows (row numbers) marks them for delete; again unmarks.
await page.locator(`${ws} [data-testid="rg-body"] [data-row="9"] [data-testid="rg-gutter"]`).click();
await page.keyboard.press("Backspace");
check((await rowMark(9)) === "delete", "⌫ marks the row for delete");
const struck = await cell(9, "name").evaluate((el) => getComputedStyle(el).textDecorationLine);
check(struck === "line-through", "its text is struck through");
await page.locator(`${ws} [data-testid="rg-body"] [data-row="10"] [data-testid="rg-gutter"]`).click();
await page.keyboard.press("Backspace");
await page.keyboard.press("Backspace");
check((await rowMark(10)) === null, "⌫ again unmarks");
await pick(9, "city");
await page.keyboard.press("Enter");
check(await noEditor(), "a row marked for delete isn't edited");

// 10. Paste-to-edit: a TSV block from the ring, cell by cell.
await pick(10, "city");
await page.evaluate((ws) => {
  const dt = new DataTransfer();
  dt.setData("text/plain", "Ipoh\ttrue\nSeremban\tnope");
  document.querySelector(`${ws} [data-testid="results-grid-wrap"]`).dispatchEvent(new ClipboardEvent("paste", { clipboardData: dt, bubbles: true }));
}, ws);
await page.waitForTimeout(100);
check((await cellText(10, "city")) === "Ipoh" && (await cellText(11, "city")) === "Seremban" && (await cellText(10, "active")) === "true", "pasted cells staged");
check((await cell(11, "active").getAttribute("data-edited")) === null, "a value its column can't take is left");
check((await toastText()).startsWith("Pasted 3 of 4 cells"), `paste toast: ${await toastText()}`);
const pasteText = (text) =>
  page.evaluate(
    ([ws, text]) => {
      const dt = new DataTransfer();
      dt.setData("text/plain", text);
      document.querySelector(`${ws} [data-testid="results-grid-wrap"]`).dispatchEvent(new ClipboardEvent("paste", { clipboardData: dt, bubbles: true }));
    },
    [ws, text],
  );
// A quoted value keeps its line break in one cell; the text NULL from elsewhere stays text.
await pick(10, "city");
await pasteText('"Kuala\nLumpur"\nNULL\n');
await page.waitForTimeout(100);
check((await cell(10, "city").textContent()) === "Kuala\nLumpur", `a quoted line break stays in one cell: ${JSON.stringify(await cell(10, "city").textContent())}`);
check((await cellText(11, "city")) === "NULL" && (await cell(11, "city").locator('[data-testid="rg-null"]').count()) === 0, "pasted text NULL stays text");
check((await toastText()).startsWith("Pasted 2 cells"), `quoted paste toast: ${await toastText()}`);
// A copy made elsewhere after the grid's forgets its NULLs: "NULL" stays text.
await pick(5, "city");
await page.keyboard.press("Control+c");
await page.evaluate(() => document.dispatchEvent(new Event("copy")));
await pick(11, "city");
await pasteText("NULL");
await page.waitForTimeout(100);
check((await cellText(11, "city")) === "NULL" && (await cell(11, "city").locator('[data-testid="rg-null"]').count()) === 0, "after another copy, pasted NULL stays text");
// The grid's own copy of a NULL cell pastes back as NULL.
await pick(5, "city");
await page.keyboard.press("Control+c");
await pick(11, "city");
await pasteText("NULL");
await page.waitForTimeout(100);
check((await cell(11, "city").locator('[data-testid="rg-null"]').count()) === 1, "a copied NULL pastes as NULL");
await shot("5-marks");

// 11. The marks are saved with the tab, and come back with it.
await page.waitForTimeout(1500);
const saved = await page.evaluate(() => JSON.parse(localStorage.getItem("rowkery.windows") ?? "{}"));
const savedEdits = saved.windows?.[0]?.tabs?.find((t) => t.kind === "table")?.edits;
check(savedEdits && savedEdits.inserts.length === 2 && Object.keys(savedEdits.deletes).length === 1, "edits are saved with the tab");
await page.keyboard.press("Control+w");
await page.waitForFunction(() => [...document.querySelectorAll("[data-toast] > span")].some((e) => e.textContent.includes("Closed kiosks")));
check((await toastText()).startsWith("Closed kiosks with 10 unsaved changes"), `close toast: ${await toastText()}`);
await page.keyboard.press("Control+Shift+t");
await page.waitForSelector(`${ws} [data-testid="rg-inserts"] [data-mark="insert"]`);
check((await rowMark(9)) === "delete" && (await cellText(4, "meta")).includes("kiosk"), "Reopen closed tab brings the edits back");

// 12. No primary key: no editor, and it says why.
await openTable("audit_log");
await page.locator(`${ws} [data-testid="rg-body"] [data-row="0"] [data-col="1"]`).click();
await page.keyboard.press("Enter");
check(await noEditor(), "a table without a primary key opens no editor");
await page.waitForSelector(`${ws} [data-edit-tray="refused"]`);
check((await page.locator(`${ws} [data-edit-tray]`).textContent()) === "No primary keyrows here can't be edited", "the tray says: No primary key · rows here can't be edited");
await shot("6-no-key");

// 13. Read-only: no editor either.
await page.keyboard.press("Control+Shift+o");
await page.waitForSelector('[data-testid="conn-popover"]');
await page.keyboard.type("wallet-ro");
await page.keyboard.press("Enter");
await page.waitForFunction((ws) => document.querySelector(`${ws}`)?.getAttribute("data-conn-state") === "connected", ws);
await openTable("kiosks");
await pick(1, "name");
await page.keyboard.press("Enter");
check(await noEditor(), "Read-only opens no editor");
await page.waitForSelector(`${ws} [data-edit-tray="refused"]`);
check((await page.locator(`${ws} [data-edit-tray]`).textContent()) === "Read-only connectionChange safe mode…", "the tray says: Read-only connection · Change safe mode…");
check((await page.locator(`${ws} [data-cell-editor], ${ws} [data-edit-tray="pending"]`).count()) === 0, "Read-only shows no editor and no pending tray");
await shot("7-read-only");

// 14. The tray, Review SQL and Commit on Off.
page = await launch("off");
const tray = () => page.locator(`${ws} [data-edit-tray]`);
const trayState = () => tray().getAttribute("data-edit-tray", { timeout: 1500 }).catch(() => null);
const applied = () => page.evaluate(() => window.__CALLS__.filter(([c]) => c === "apply_changes").map(([, a]) => a));
const stageText = async (row, column, text) => {
  await pick(row, column);
  await page.keyboard.press("Enter");
  await page.keyboard.press("ControlOrMeta+a");
  await page.keyboard.type(text);
  await page.keyboard.press("Enter");
};
await openTable("kiosks");
check((await tray().count()) === 0, "no tray without edits");
await stageText(0, "city", "Puchong");
check((await trayState()) === "pending" && (await tray().getAttribute("data-changes")) === "1", "the tray slides up: 1 change");
const trayText = (await tray().evaluate((el) => el.innerText)).replace(/\s+/g, " ").trim();
// Paper (2026-10-10): the edits bar at the grid's foot counts by kind; Commit is ink.
check(trayText === "1 change 1 edited Review SQL Ctrl+Shift+P Discard Commit Ctrl+S", `tray: ${trayText}`);
const commitInk = await page.locator(`${ws} [data-commit]`).evaluate((el) => {
  const p = document.createElement("i");
  p.style.color = "var(--ink)";
  document.body.append(p);
  const ink = getComputedStyle(p).color;
  p.remove();
  return { bg: getComputedStyle(el).backgroundColor, ink };
});
check(commitInk.bg === commitInk.ink, `Commit is ink (${JSON.stringify(commitInk)})`);
await shot("8-tray");
await page.keyboard.press("Control+Shift+p");
await page.waitForSelector("[data-review-sql] [data-review-text*='BEGIN']");
const reviewed = await page.locator("[data-review-sql] [data-review-text]").getAttribute("data-review-text");
check(reviewed === "BEGIN;\nUPDATE public.kiosks SET city = 'Puchong' WHERE id = 1;\nCOMMIT;", `Review SQL shows core's transaction: ${JSON.stringify(reviewed)}`);
// Review SQL is the inspector column since 2026-10-10: a "Review SQL" head and one card per statement.
check(
  (await page.locator("[data-review-sql] h2").textContent()) === "Review SQL" &&
    (await page.locator("[data-review-sql] [data-review-meta]").textContent()) === "1 statement · one transaction" &&
    (await page.locator("[data-review-sql] [data-review-card=update]").count()) === 1,
  "Review SQL head: 1 statement · one transaction, one UPDATE card",
);
await shot("9-review-sql");
await page.keyboard.press("Escape");
// The column plays its exit before it unmounts.
await page.waitForFunction(() => !document.querySelector("[data-review-sql]"), null, { timeout: 1000 }).catch(() => {});
check((await page.locator("[data-review-sql]").count()) === 0 && (await applied()).length === 0, "Esc closes Review SQL; nothing ran");

// The duplicate row: its UPDATE matches 2 rows, so nothing is kept and the tray names it.
await stageText(1, "name", "Kiosk Two");
check((await tray().getAttribute("data-changes")) === "2", "2 changes");
await page.keyboard.press("Control+s");
await page.waitForSelector(`${ws} [data-edit-tray="failed"]`);
check(
  (await page.locator(`${ws} [data-tray-error]`).textContent()) === "Nothing changed · UPDATE public.kiosks WHERE id = 2 changed 2 rows",
  `rolled back, the tray names the row: ${await page.locator(`${ws} [data-tray-error]`).textContent()}`,
);
check((await rowMark(0)) === "edit" && (await rowMark(1)) === "edit", "the edits stay pending");
check((await page.locator(`${ws} [data-commit]`).textContent()).startsWith("Retry"), "Commit reads Retry");
await shot("10-rolled-back");
await pick(1, "name");
await page.keyboard.press("Escape");
check((await trayState()) === "pending" && (await tray().getAttribute("data-changes")) === "1", "reverting the row clears the failure");
await page.locator(`${ws} [data-commit]`).click();
await page.waitForSelector(`${ws} [data-edit-tray="done"]`);
check((await tray().textContent()) === "Updated 1 · 24 ms", `committed: ${await tray().textContent()}`);
const last = (await applied()).at(-1);
check(last.changes.length === 1 && last.changes[0].op === "update" && last.table.key.join() === "id" && last.confirmed === null, "apply_changes got the update on the whole key");
check((await rowMark(0)) === null, "the marks are gone");
await page.waitForFunction((ws) => !document.querySelector(`${ws} [data-edit-tray]`), ws, { timeout: 3000 });
check(true, "the tray leaves after 1.6 s");

// Discard, then Undo (the toast's button) puts the edits back.
await stageText(3, "city", "Ipoh");
await page.locator(`${ws} [data-discard]`).click();
check((await rowMark(3)) === null && (await toastText()) === "Discarded 1 edit", `discarded (2026-10-13: "edits"): ${await toastText()}`);
await page.click("[data-toast-undo]");
await page.waitForFunction((ws) => document.querySelector(`${ws} [data-row="3"]`)?.getAttribute("data-mark") === "edit", ws);
check((await cellText(3, "city")) === "Ipoh", "Undo restores the edit");

// Commit from Review SQL: ⇧⌘↵ (Ctrl+Shift+Enter) sends the text it showed.
await page.keyboard.press("Control+Shift+p");
await page.waitForSelector("[data-review-sql] [data-review-text*='Ipoh']");
await page.keyboard.press("Control+Shift+Enter");
await page.waitForSelector(`${ws} [data-edit-tray="done"]`);
check((await applied()).at(-1).confirmed.includes("SET city = 'Ipoh' WHERE id = 4"), "Review SQL's Commit sends its SQL");

// 15. Confirm writes: the SafetyBar shows the statements; ⇧⌘↵ commits exactly them.
page = await launch("cw");
await openTable("kiosks");
await stageText(4, "city", "Seremban");
await page.keyboard.press("Control+s");
await page.waitForSelector(`${ws} [data-held-edits]`);
const held = await page.locator(`${ws} [data-held-sql]`).textContent();
check(held === "BEGIN;\nUPDATE public.kiosks SET city = 'Seremban' WHERE id = 5;\nCOMMIT;", `held statements: ${JSON.stringify(held)}`);
check((await page.locator(`${ws} [data-held-edits]`).textContent()).includes("1 statement on public.kiosks: UPDATE 1"), "the bar counts the statements");
check((await applied()).length === 1 && (await applied())[0].confirmed === null, "nothing confirmed yet");
await shot("11-confirm-writes");
await page.keyboard.press("Escape");
check((await page.locator(`${ws} [data-held-edits]`).count()) === 0 && (await rowMark(4)) === "edit", "Esc keeps the edits pending");
await page.keyboard.press("Control+s");
await page.waitForSelector(`${ws} [data-held-edits]`);
await page.keyboard.press("Control+Shift+Enter");
await page.waitForSelector(`${ws} [data-edit-tray="done"]`);
check((await applied()).at(-1).confirmed === held, "⇧⌘↵ sends back exactly the SQL shown");
check((await page.locator(`${ws} [data-held-edits]`).count()) === 0 && (await rowMark(4)) === null, "committed: bar and marks gone");
await browser.close();
