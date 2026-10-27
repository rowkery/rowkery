#!/usr/bin/env node
// The Paper table browser (2026-10-10), stubbed `invoke`, in light and dark.
// Proves: the table tab's head is two rows, QUERY (pill, highlighted SQL,
// Edit SQL) over WHERE (chips, + Filter, count at the right); Data |
// Structure sits at the tab row's right; three chips wrap onto more lines at
// 900 px instead of scrolling, each reading col / op / value in the SQL
// colours on the accent wash; the chip editor is the inline pill with Add ↵
// and ×, its operator picker opens; the grid's header is 46 px and its rows
// 30 px, NULL is the small chip (--r-xs), chips are pills (--r-pill), a
// timestamp's date is dimmed; an edited, a deleted and a new row carry their
// gutter dots (ink / red / green) and washes; the edits bar, a 48 px capsule
// docked 8 px inside the grid's foot (2026-10-24), counts them (2 changes · ● 1
// edited ● 1 deleted ● 1 new), shows committing / failed + Retry / refused /
// done, Confirm writes holds it in the Paper strip and Commit still commits;
// there is no foot + Add row (⌘I and the results … add one); Structure is the
// ruled Column / Type / Nullable / Key table with PRIMARY and → table; a
// filter matching nothing reads "No rows match. Clear filters" and the link
// clears it. Screenshots (light and dark) go to outDir, by default
// /tmp/rowkery-proof/paper-table: desktop / dark (a filtered table tab),
// chip-editor, operator-picker, structure, editing, edits-bar(-committing /
// -failed / -refused / -done), confirm-writes, empty-filter.
//
//   cd apps/rowkery-tauri && npx vite --port 1420 &
//   node scripts/paper-table-browser-proof.mjs [outDir]
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
const OUT = process.argv[2] ?? "/tmp/rowkery-proof/paper-table";
const URL = process.env.ROWKERY_DEV_URL ?? "http://localhost:1420/";
mkdirSync(OUT, { recursive: true });

function stubTauri() {
  localStorage.clear();
  const col = (name, type_name, extra = {}) => ({ name, type_name, nullable: true, ...extra });
  const table = (name, columns, rows, foreign_keys = []) => ({
    name,
    kind: "table",
    columns,
    primary_key: ["id"],
    indexes: [{ name: `${name}_pkey`, columns: ["id"], unique: true, primary: true }],
    foreign_keys,
    row_estimate: { Approximate: rows },
    partition_of: null,
  });
  const id = col("id", "bigint", { nullable: false, default: "nextval('kiosks_id_seq'::regclass)" });
  const tables = [
    table(
      "kiosks",
      [id, col("name", "text"), col("city", "text"), col("price", "numeric"), col("opened_at", "timestamp with time zone"), col("owner_id", "bigint")],
      36152,
      [{ name: "kiosks_owner_id_fkey", columns: ["owner_id"], ref_schema: "public", ref_table: "owners", ref_columns: ["id"], on_delete: "NO ACTION" }],
    ),
    table("owners", [id, col("name", "text")], 40),
  ];
  const wire = {
    kiosks: [
      { name: "id", type_name: "int8" },
      { name: "name", type_name: "text" },
      { name: "city", type_name: "text" },
      { name: "price", type_name: "numeric" },
      { name: "opened_at", type_name: "timestamptz" },
      { name: "owner_id", type_name: "int8" },
    ],
    owners: [
      { name: "id", type_name: "int8" },
      { name: "name", type_name: "text" },
    ],
  };
  const CITIES = ["Petaling Jaya", "Kuala Lumpur", "Shah Alam", "Subang Jaya", "Klang"];
  const rowOf = (t, n) =>
    t === "owners"
      ? [{ Int: n }, { Text: `owner ${n}` }]
      : [
          { Int: n },
          { Text: `Kiosk ${String(n).padStart(3, "0")}` },
          n % 5 === 3 ? { Null: null } : { Text: CITIES[n % 5] },
          { Text: `${(n * 37) % 900}.50` },
          { Text: `2026-0${(n % 9) + 1}-1${n % 10} 0${n % 10}:${String((n * 7) % 60).padStart(2, "0")}:00+08` },
          n % 4 === 0 ? { Null: null } : { Int: (n % 40) + 1 },
        ];
  window.__CALLS__ = [];
  let nextId = 0;
  window.__TAURI_INTERNALS__ = {
    metadata: { currentWindow: { label: "main" }, currentWebview: { label: "main" } },
    transformCallback: () => 0,
    invoke: async (cmd, args) => {
      const { onFrame, ...rest } = args ?? {};
      window.__CALLS__.push([cmd, rest]);
      switch (cmd) {
        case "list_connections":
          return { connections: [{ kind: "postgres", id: "pg", name: "kiosk-prd", host: "db", port: 5432, database: "rowkery", username: "rowkery" }], active_connection_id: null };
        case "open_window":
          return { database: "rowkery", catalog: { databases: [{ name: "rowkery", schemas: [{ name: "public", tables }] }] }, elapsed_ms: 2, cached: false, open_seq: 1 };
        case "apply_changes": {
          // `__APPLY__` picks the answer: ok, rolled_back, refuse (Read-only) or confirm (Confirm writes).
          await new Promise((r) => setTimeout(r, window.__APPLY_DELAY__ ?? 0));
          const n = (op) => rest.changes.filter((c) => c.op === op).length;
          const mode = rest.confirmed ? "ok" : (window.__APPLY__ ?? "ok");
          const sql = "BEGIN;\nUPDATE public.kiosks SET name = 'Kiosk 001 (renamed)' WHERE id = 1;\nDELETE FROM public.kiosks WHERE id = 2;\nINSERT INTO public.kiosks DEFAULT VALUES;\nCOMMIT;";
          if (mode === "rolled_back") return { status: "rolled_back", message: "DELETE FROM public.kiosks WHERE id = 2 changed 0 rows" };
          if (mode === "refuse") return { status: "held", hold: { action: "refuse", mode: "read_only", statements: [] }, sql };
          if (mode === "confirm")
            return {
              status: "held",
              sql,
              hold: { action: "confirm", mode: "confirm", statements: [{ kind: "write", verb: "UPDATE", target: "public.kiosks", destructive: false, unlocks_writes: false }] },
            };
          return { status: "committed", inserted: n("insert"), updated: n("update"), deleted: n("delete"), elapsed_ms: 24 };
        }
        case "browse_table": {
          const t = rest.table;
          const filter = rest.filter?.trim() ?? "";
          // A filter naming "nowhere" matches nothing; any other keeps 312 rows.
          const total = /nowhere/.test(filter) || window.__proofEmpty ? 0 : filter ? 312 : t === "owners" ? 40 : 36152;
          const from = rest.key?.length && rest.after ? rest.after.id.Int : (rest.offset ?? 0);
          const n = Math.max(0, Math.min(rest.limit === 0 ? Infinity : rest.limit, total - from));
          const queryId = ++nextId;
          setTimeout(() => {
            const send = (f) => onFrame.onmessage({ query_id: queryId, ...f });
            send({ t: "columns", columns: wire[t] });
            for (let i = 0; i < n; i += 500) {
              send({ t: "rows", seq: i / 500, rows: Array.from({ length: Math.min(500, n - i) }, (_, j) => rowOf(t, from + i + j + 1)) });
            }
            send({ t: "done", status: "ok", row_count: n, affected_rows: null, elapsed_ms: 3, first_row_ms: 1, frames: 1, error: null, sqlstate: null, error_position: null, hold: null });
          }, 5);
          let sql = `SELECT * FROM public.${t}`;
          if (filter) sql += `\nWHERE (${filter})`;
          const order = [...(rest.order ?? []).map((o) => `${o.column}${o.desc ? " DESC" : ""} NULLS LAST`), ...(rest.key ?? []).filter((k) => !(rest.order ?? []).some((o) => o.column === k))];
          if (order.length) sql += `\nORDER BY ${order.join(", ")}`;
          if (rest.limit) sql += `\nLIMIT ${rest.limit}`;
          return { query_id: queryId, sql: `${sql};` };
        }
        case "count_rows":
          return 36152;
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
const context = await browser.newContext({ viewport: { width: 1280, height: 800 }, deviceScaleFactor: 2, colorScheme: "light" });
const page = await context.newPage();
const errors = [];
page.on("pageerror", (e) => errors.push(e.message));
await page.addInitScript({ path: LINUX_PLATFORM });
await page.addInitScript(stubTauri);
await page.goto(URL);

const ws = '[data-testid="workspace"]:not([hidden])';
const line = `${ws} [data-sql-line]`;
const shot = async (name, clip, wait = 400) => {
  await page.waitForTimeout(wait);
  await page.mouse.move(1, 1);
  await page.screenshot({ path: `${OUT}/${name}.png`, ...(clip ? { clip } : {}) });
  console.log(`${OUT}/${name}.png`);
};
const setTheme = async (scheme) => {
  await page.emulateMedia({ colorScheme: scheme });
  await page.waitForFunction((s) => document.documentElement.dataset.theme === s, scheme);
};
const settle = () => page.waitForFunction((ws) => !document.querySelector(`${ws} [data-state="running"]`), ws);
const rowCount = () => page.getAttribute(`${ws} [data-testid="results-grid-wrap"]`, "data-row-count").then(Number);
const box = (sel) => page.locator(sel).first().boundingBox();
const addChip = async (text) => {
  await page.keyboard.press("Control+f");
  await page.waitForSelector(`${line} [data-chip-editor] [data-testid="sql-editor"]`);
  await page.keyboard.type(text);
  await page.keyboard.press("Enter");
  await page.waitForFunction((t) => [...document.querySelectorAll('[data-testid="workspace"]:not([hidden]) [data-chip-sql]')].some((c) => c.getAttribute("data-chip-sql") === t), text);
  await settle();
};

await page.waitForSelector('[data-testid="workspace"]:not([hidden])'); // Paper (2026-10-10): an empty window shows no connection chip (no tab row without a connection); wait for the window, then ⇧⌘O as before.
await page.keyboard.press("Control+Shift+O");
await page.waitForSelector('[data-testid="conn-popover"]');
await page.keyboard.press("Enter");
await page.waitForSelector(`${ws}[data-conn-state="connected"]`);
await page.click(`${ws} [data-table="rowkery.public.kiosks"] [data-testid="sb-row-main"]`);
await page.waitForFunction((ws) => document.querySelector(`${ws} [data-testid="results-grid-wrap"]`)?.getAttribute("data-row-count") === "1000", ws);
await settle();

// 1. The head: QUERY over WHERE; Data | Structure at the tab row's right.
const q = await box(`${line} [data-sql-query]`);
const w = await box(`${line} [data-testid="sql-line-where"]`);
check(!!q && !!w && w.y >= q.y + q.height, `QUERY row (y ${q?.y}) over the WHERE row (y ${w?.y})`);
// Text on purpose: the pill's word is the spec.
check((await page.textContent(`${line} [data-sql-query]`)).startsWith("QUERY"), "the QUERY pill leads the SQL");
// Class on purpose: .k is the keyword colour under test.
check((await page.locator(`${line} [data-sql-text] .k`).count()) > 0, "the SQL is highlighted with the token colours");
check((await page.locator(`${ws} [data-testid="editor-header"] [data-testid="view-switch"]`).count()) === 1, "Data | Structure sits in the tab row");
const sw = await box(`${ws} [data-testid="editor-header"] [data-testid="view-switch"]`);
const tabsBox = await box(`${ws} [data-testid="query-tabs"]`);
check(!!sw && !!tabsBox && sw.x > tabsBox.x + tabsBox.width - 1, "… at the tab row's right, after the tabs");
const thumbBg = await page.$eval(`${ws} [data-testid="view-switch"] .view-switch-thumb`, (e) => getComputedStyle(e).backgroundColor); // Class on purpose: the thumb is under test.
const pageBg = await page.evaluate(() => getComputedStyle(document.body).backgroundColor);
check(thumbBg !== "rgba(0, 0, 0, 0)", `the thumb is a raised paper fill (${thumbBg} on ${pageBg})`);

// 2. The grid: 46 px header, 30 px rows, NULL chip, dimmed timestamp date.
const header = await box(`${ws} [data-testid="rg-header"]`);
check(header && Math.round(header.height) === 46, `46 px header (${header?.height})`);
const r0 = await box(`${ws} [data-testid="rg-body"] [data-row="0"]`);
check(r0 && Math.round(r0.height) === 30, `30 px rows (${r0?.height})`);
const nullChip = page.locator(`${ws} [data-testid="rg-body"] [data-row="2"] [data-col="2"] [data-testid="rg-null"]`);
check((await nullChip.count()) === 1 && (await nullChip.textContent()) === "NULL", "NULL reads as the small chip (row 3's city)");
const nullStyle = await nullChip.evaluate((e) => {
  const s = getComputedStyle(e);
  return { size: s.fontSize, weight: s.fontWeight, radius: s.borderRadius, bg: s.backgroundColor };
});
check(nullStyle.size === "9.5px" && nullStyle.weight === "600" && nullStyle.radius === "4px" && nullStyle.bg !== "rgba(0, 0, 0, 0)", `NULL chip: 600 9.5 px on a fill, radius 4 (${JSON.stringify(nullStyle)})`);
// Class on purpose: the dimmed date is the style under test.
check((await page.locator(`${ws} [data-testid="rg-body"] [data-row="0"] [data-col="4"] .rg-ts-date`).count()) === 1, "a timestamp's date is set apart from its time");
const tsTones = await page.evaluate((ws) => {
  const c = (sel) => getComputedStyle(document.querySelector(`${ws} [data-testid="rg-body"] [data-row="0"] [data-col="4"] ${sel}`)).color;
  const p = document.createElement("i");
  p.style.color = "var(--dim)";
  document.body.append(p);
  const dim = getComputedStyle(p).color;
  p.remove();
  // Class on purpose: the date and zone colours are under test.
  return { date: c(".rg-ts-date"), zone: c(".rg-ts-rest"), dim };
}, ws);
check(tsTones.date === tsTones.dim && tsTones.zone === tsTones.dim, `the date and the zone both in --dim (${JSON.stringify(tsTones)})`);
const gutter = await box(`${ws} [data-testid="rg-body"] [data-row="0"] [data-testid="rg-gutter"]`);
check(gutter && Math.round(gutter.width) >= 44, `a 44 px gutter (${gutter?.width})`);

// 3. Three chips: col / op / value in the SQL colours on the accent wash.
await addChip("opened_at >= '2026-03-01 00:00:00+08'");
await addChip("price BETWEEN 100 AND 900");
await addChip("city = 'Klang'");
check((await page.locator(`${line} [data-chip]`).count()) === 3, "three chips");
check((await page.locator(`${line} [data-testid="sql-chip-and"]`).count()) === 2, "joined by a dim AND");
const chipLook = await page.$eval(`${line} [data-chip="0"]`, (e) => {
  const s = getComputedStyle(e);
  return { h: e.getBoundingClientRect().height, radius: s.borderRadius, bg: s.backgroundColor, font: s.fontFamily };
});
check(Math.round(chipLook.h) === 26 && chipLook.radius === "999px" && chipLook.bg !== "rgba(0, 0, 0, 0)" && /Mono/.test(chipLook.font), `a chip: a 26 px pill, accent wash, mono (${JSON.stringify(chipLook)})`);
const tones = await page.$eval(`${line} [data-chip="0"]`, (e) => {
  const c = (sel) => {
    const el = e.querySelector(sel);
    return el ? getComputedStyle(el).color : null;
  };
  // Class on purpose: the token colours inside the chip are under test.
  return { op: c(".p"), val: c(".s") };
});
const kw = await page.evaluate(() => {
  const p = document.createElement("i");
  p.style.color = "var(--kw)";
  document.body.append(p);
  const k = getComputedStyle(p).color;
  p.style.color = "var(--num)";
  const n = getComputedStyle(p).color;
  p.remove();
  return { k, n };
});
check(tones.op === kw.k && tones.val === kw.n, `op in --kw, value in --num (${JSON.stringify(tones)} vs ${JSON.stringify(kw)})`);
await page.waitForFunction((sel) => document.querySelector(sel)?.textContent.includes("312"), `${line} [data-line-end]`);
check((await page.textContent(`${line} [data-line-end]`)).includes("312 of 312 rows"), `the count at the WHERE row's right: ${await page.textContent(`${line} [data-count]`)}`);
check((await page.getAttribute(`${line} [data-sql-text]`, "data-sql-text")).includes("WHERE (opened_at >= '2026-03-01 00:00:00+08' AND price BETWEEN 100 AND 900 AND city = 'Klang')"), "the QUERY row shows the whole WHERE");
const addBox = await page.$eval(`${line} [data-add-filter]`, (e) => {
  const p = document.createElement("span");
  p.style.color = "var(--fill)";
  document.body.append(p);
  const fill = getComputedStyle(p).color;
  p.remove();
  return { bg: getComputedStyle(e).backgroundColor, fill };
});
check(addBox.bg === addBox.fill, `+ Filter is the filled pill (${addBox.bg})`);
// Class on purpose: no wash box may sit in the QUERY row's WHERE text.
check((await page.locator(`${line} [data-sql-query] .sql-line-where-sql.sql-wash, ${line} [data-sql-query] .sql-line-where-sql [data-wash]`).count()) === 0, "the QUERY row's WHERE is plain tokens (no wash box)");
const rules = await page.evaluate((ws) => {
  const head = document.querySelector(`${ws} [data-sql-line]`);
  const split = document.querySelector(`${ws} [data-testid="pane-splitter"]`);
  return { head: getComputedStyle(head).borderBottomWidth, split: getComputedStyle(split).backgroundImage };
}, ws);
check(rules.head === "1px" && rules.split === "none", `one 1 px rule under the head, none from the splitter (${JSON.stringify(rules)})`);
await shot("desktop");

// Chips wrap at 900 px: more than one line, no sideways scroll, nothing cut.
await page.setViewportSize({ width: 900, height: 800 });
await page.waitForTimeout(150);
const wrap = await page.evaluate((sel) => {
  const row = document.querySelector(`${sel} [data-testid="sql-line-where"]`);
  const chips = [...row.querySelectorAll("[data-chip]")].map((c) => c.getBoundingClientRect());
  const top = chips[0].top;
  return {
    lines: new Set(chips.map((c) => Math.round(c.top))).size,
    below: chips.filter((c) => c.top > top + 10).length,
    overflow: row.scrollWidth - row.clientWidth,
    cut: chips.some((c) => c.right > row.getBoundingClientRect().right + 1),
  };
}, line);
check(wrap.below >= 2 && wrap.overflow <= 0 && !wrap.cut, `chips wrap at 900 px: ${wrap.below} chips on a later line, ${wrap.lines} lines, no scroll (${wrap.overflow}), none cut`);
// The tab row at 900 px: the switch never covers a tab.
const row900 = await page.evaluate((ws) => {
  const r = (sel) => document.querySelector(sel).getBoundingClientRect();
  const tabs = r(`${ws} [data-testid="query-tabs"]`);
  const on = r(`${ws} [data-testid="query-tab"][data-on]`);
  const sw = r(`${ws} [data-testid="editor-header"] [data-testid="view-switch"]`);
  const labels = [...document.querySelectorAll(`${ws} [data-testid="view-switch"] [role="tab"]`)].map((b) => b.getAttribute("aria-label"));
  return { tabIn: on.left >= tabs.left - 0.5 && on.right <= tabs.right + 0.5, clear: sw.left >= on.right, labels };
}, ws);
check(row900.tabIn && row900.clear, `900 px: the active tab is whole and clear of the switch (${JSON.stringify(row900)})`);
check(row900.labels.join("|") === "Data|Structure|Map", "the switch's buttons keep their names (aria-label)");
await shot("wrap-900");
await page.setViewportSize({ width: 1280, height: 800 });

// 4. The chip editor: the inline pill (selects, value, Add ↵, ×) and the operator picker.
await page.keyboard.press("Control+f");
await page.waitForSelector(`${line} [data-chip-editor="new"]`);
await page.waitForTimeout(250); // the pop entry (.18 s) scales it
const ed = await page.$eval(`${line} [data-chip-editor]`, (e) => {
  const s = getComputedStyle(e);
  return { h: e.getBoundingClientRect().height, shadow: s.boxShadow };
});
check(Math.round(ed.h) === 28 && /inset/.test(ed.shadow), `the editor pill: 28 px with an inset accent ring (${JSON.stringify(ed)})`);
const valueBox = await page.evaluate((sel) => {
  const wrap = document.querySelector(`${sel} [data-chip-editor] .sql-editor-wrap`);
  const band = document.querySelector(`${sel} [data-chip-editor] .sql-highlight .ln`);
  // Class on purpose: the value field's fill is under test.
  return { wrap: getComputedStyle(wrap).backgroundColor, band: band ? getComputedStyle(band).backgroundColor : "rgba(0, 0, 0, 0)" };
}, line);
check(valueBox.wrap === "rgba(0, 0, 0, 0)" && valueBox.band === "rgba(0, 0, 0, 0)", `the value field is transparent in the pill (${JSON.stringify(valueBox)})`);
check((await page.locator(`${line} [data-chip-editor] [data-chip-apply]`).count()) === 1 && (await page.locator(`${line} [data-chip-editor] [data-chip-cancel]`).count()) === 1, "Add ↵ and × in the pill");
await page.click(`${line} [data-chip-column]`);
await page.click('[data-menu="chip-column"] [data-item="name"]');
await page.keyboard.type("Kiosk 01");
await shot("chip-editor");
await page.click(`${line} [data-chip-op]`);
await page.waitForSelector('[data-menu="chip-op"]');
check((await page.locator('[data-menu="chip-op"] [data-item]').count()) >= 4, "the operator picker opens with its rows");
await shot("operator-picker");
await page.keyboard.press("Escape");
await page.click(`${line} [data-chip-cancel]`);
await page.waitForFunction((sel) => !document.querySelector(`${sel} [data-chip-editor]`), line);
check((await page.locator(`${line} [data-chip]`).count()) === 3, "× cancels the draft, the chips stay");

// Dark: the same filtered tab.
await setTheme("dark");
await shot("dark");
await setTheme("light");

// 5. Structure: the ruled table, PRIMARY, → owners.
await page.click(`${ws} [data-testid="view-switch"] [data-view="structure"]`);
await page.waitForSelector(`${ws} [data-testid="ts-root"]`);
const heads = await page.$$eval(`${ws} [data-testid="ts-root"] [role="columnheader"]`, (els) => els.map((e) => e.textContent));
check(heads.join("|") === "Column|Type|Nullable|Key", `Structure's header: ${heads.join(" / ")}`);
const rowH = await box(`${ws} [data-testid="ts-root"] [data-column="name"]`);
check(rowH && Math.round(rowH.height) === 34, `34 px column rows (${rowH?.height})`);
// Text on purpose: the badge's word is the spec.
check((await page.textContent(`${ws} [data-column="id"]`)).includes("PRIMARY"), "id carries PRIMARY");
check((await page.textContent(`${ws} [data-column="owner_id"] [data-fk]`)) === "→ owners", "owner_id links → owners");
await shot("structure");
await setTheme("dark");
await shot("structure-dark");
await setTheme("light");
await page.click(`${ws} [data-testid="view-switch"] [data-view="data"]`);
await page.waitForSelector(`${ws} [data-testid="rg-body"] [data-row="0"]`);

// 6. Edits: one edited, one deleted, one new; dots, washes and the bar.
const cell = (row, c) => page.locator(`${ws} [data-testid="rg-body"] [data-row="${row}"] [data-col="${c}"]`);
await cell(0, 1).click();
await page.keyboard.press("Enter");
await page.keyboard.press("ControlOrMeta+a");
await page.keyboard.type("Kiosk 001 (renamed)");
await page.keyboard.press("Enter");
await page.click(`${ws} [data-testid="rg-body"] [data-row="1"] [data-testid="rg-gutter"]`);
await page.keyboard.press("Backspace");
await page.waitForFunction((ws) => document.querySelector(`${ws} [data-testid="rg-body"] [data-row="1"]`)?.getAttribute("data-mark") === "delete", ws);
// Fix batch (2026-10-10): no foot + Add row (table tabs page as you scroll,
// so the foot moves); a new row comes from ⌘I or the results `…`.
check((await page.locator(`${ws} [data-add-row]`).count()) === 0, "no + Add row at the grid's foot");
await page.click(`${line} [data-testid="zone-menu"][data-zone="results"]`);
await page.waitForSelector('[data-menu="zone-results"] [data-item="insert-row"]');
check(true, "the results … offers Insert row");
await page.click('[data-menu="zone-results"] [data-item="insert-row"]');
await page.waitForSelector(`${ws} [data-insert]`);
await page.keyboard.press("Escape");
await page.waitForTimeout(100);
await page.mouse.click(700, 120);
const bar = `${ws} [data-edit-tray]`;
await page.waitForSelector(`${bar}[data-changes="3"]`);
const counts = await page.$$eval(`${bar} [data-tray-count]`, (els) => els.map((e) => `${e.dataset.trayCount}:${e.dataset.n}`));
check(counts.join(",") === "edited:1,deleted:1,inserted:1", `the bar counts them: ${counts.join(", ")}`);
// Text on purpose: the summary words are the spec.
check((await page.textContent(`${bar} .edit-tray-count`)) === "3 changes", "3 changes"); // Class on purpose: the count's element.
const barBox = await box(bar);
const cardBox = await box(`${ws} [data-testid="results-card"]`);
check(
  barBox && Math.round(barBox.height) === 48 && Math.abs(barBox.y + barBox.height + 8 - (cardBox.y + cardBox.height)) <= 1 && Math.abs(barBox.x - 8 - cardBox.x) <= 1 && Math.abs(barBox.x + barBox.width + 8 - (cardBox.x + cardBox.width)) <= 1,
  `a 48 px bar docked 8 px inside the grid's foot (${barBox?.height} px, bottom ${barBox && barBox.y + barBox.height} / ${cardBox.y + cardBox.height})`,
);
const barLook = await page.$eval(bar, (e) => getComputedStyle(e).borderTopLeftRadius);
const lastRow = await page.$$eval(`${ws} [data-row]`, (rows) => Math.max(...rows.map((r) => r.getBoundingClientRect().bottom)));
const scroller = await box(`${ws} [data-testid="results-grid-wrap"]`);
check(barLook === "12px" && scroller.y + scroller.height <= barBox.y + 1, `a 12 px capsule below the grid, never over a row (${barLook}, grid ends ${scroller.y + scroller.height} / bar ${barBox.y}, last row ${lastRow})`);
const dot = (sel) => page.$eval(sel, (e) => getComputedStyle(e).backgroundColor).catch(() => null);
const [dEdit, dDel, dNew] = await Promise.all([
  dot(`${ws} [data-testid="rg-body"] [data-row="0"] .rg-mark-dot`), // Class on purpose: the gutter dot is under test.
  dot(`${ws} [data-testid="rg-body"] [data-row="1"] .rg-mark-dot`),
  dot(`${ws} [data-insert] .rg-mark-dot`),
]);
check(!!dEdit && !!dDel && !!dNew && new Set([dEdit, dDel, dNew]).size === 3, `three gutter dots, three colours (${dEdit} / ${dDel} / ${dNew})`);
const washes = await page.evaluate((ws) => {
  const bg = (sel) => getComputedStyle(document.querySelector(sel)).backgroundColor;
  return { del: bg(`${ws} [data-testid="rg-body"] [data-row="1"]`), ins: bg(`${ws} [data-insert]`), deco: getComputedStyle(document.querySelector(`${ws} [data-testid="rg-body"] [data-row="1"] [data-col="1"]`)).textDecorationLine };
}, ws);
check(washes.del !== "rgba(0, 0, 0, 0)" && washes.ins !== "rgba(0, 0, 0, 0)" && washes.deco === "line-through", `deleted row washed and struck, new row washed (${JSON.stringify(washes)})`);
const editedCell = await cell(0, 1).evaluate((e) => ({ w: getComputedStyle(e).fontWeight, edited: e.hasAttribute("data-edited") }));
check(editedCell.edited && editedCell.w === "500", `the edited cell: weight 500 with its ink bar (${JSON.stringify(editedCell)})`);
await shot("editing");
await shot("edits-bar", { x: 348, y: 800 - 46 - 120, width: 932, height: 166 });
await setTheme("dark");
await shot("editing-dark");
await shot("edits-bar-dark", { x: 348, y: 800 - 46 - 120, width: 932, height: 166 });
await setTheme("light");

// The bar's states, light and dark: committing, failed (+ Retry), refused, the
// Confirm writes strip, then done.
const BAR = { x: 348, y: 800 - 46 - 120, width: 932, height: 166 };
const both = async (name, clip, wait) => {
  await shot(name, clip, wait);
  await setTheme("dark");
  await shot(`${name}-dark`, clip, wait);
  await setTheme("light");
};
await page.evaluate(() => {
  window.__APPLY__ = "rolled_back";
  window.__APPLY_DELAY__ = 6000;
});
await page.click(`${bar} [data-commit]`);
await page.waitForSelector(`${bar}[data-edit-tray="committing"]`);
check((await page.textContent(`${bar} [data-commit]`)).startsWith("Committing…") && (await page.isDisabled(`${bar} [data-commit]`)), "committing: Commit reads Committing… and waits");
await both("edits-bar-committing", BAR, 200);
await page.waitForSelector(`${bar}[data-edit-tray="failed"]`, { timeout: 8000 });
check((await page.textContent(`${bar} [data-tray-error]`)).startsWith("Nothing changed · DELETE FROM public.kiosks WHERE id = 2 changed 0 rows"), "failed: Nothing changed names the row");
check((await page.textContent(`${bar} [data-commit]`)).startsWith("Retry"), "… and Commit becomes Retry");
await both("edits-bar-failed", BAR);
await page.evaluate(() => {
  window.__APPLY__ = "refuse";
  window.__APPLY_DELAY__ = 0;
});
await page.click(`${bar} [data-commit]`);
await page.waitForSelector(`${bar}[data-edit-tray="refused"]`);
check((await page.locator(`${bar} button`).textContent()) === "Change safe mode…", "refused: the reason and the Change safe mode… link");
await both("edits-bar-refused", BAR, 150);
await page.waitForSelector(`${bar}[data-edit-tray="refused"]`, { state: "detached", timeout: 6000 });
await page.evaluate(() => (window.__APPLY__ = "confirm"));
await page.click(`${bar} [data-commit]`);
await page.waitForSelector(`${ws} [data-held-edits]`);
const strip = await page.$eval(`${ws} [data-held-edits]`, (e) => {
  const s = getComputedStyle(e);
  return { bg: s.backgroundColor, rule: s.borderBottomWidth };
});
check(strip.bg !== "rgba(0, 0, 0, 0)" && strip.rule === "1px", `Confirm writes: the Paper strip, a wash on a 1 px rule (${JSON.stringify(strip)})`);
await both("confirm-writes");

// Commit still commits (⇧⌘↵ in the strip sends back the SQL it showed).
await page.click(`${ws} [data-commit-held]`);
await page.waitForSelector(`${bar}[data-edit-tray="done"]`);
const sent = await page.evaluate(() => window.__CALLS__.filter(([c]) => c === "apply_changes").at(-1)[1]);
check(sent.changes.map((c) => c.op).sort().join(",") === "delete,insert,update" && !!sent.confirmed, `Commit sends one transaction: ${sent.changes.map((c) => c.op).sort().join(",")}`);
check((await page.textContent(bar)).includes("Updated 1 · Inserted 1 · Deleted 1 · 24 ms"), `done: ${await page.textContent(bar)}`);
await shot("edits-bar-done", BAR, 100);
await setTheme("dark");
await shot("edits-bar-done-dark", BAR, 100);
await setTheme("light");
await page.waitForSelector(bar, { state: "detached", timeout: 4000 });
check(true, "… for a moment, then the bar leaves");

// 7. A filter matching nothing: "No rows match. Clear filters".
await addChip("name = 'nowhere'");
await page.waitForSelector(`${ws} [data-empty-filter]`);
check((await rowCount()) === 0, "no rows");
// Text on purpose: the empty state's words are the spec.
check((await page.textContent(`${ws} [data-empty-filter]`)).startsWith("No rows match."), "No rows match. Clear filters");
await shot("empty-filter");
await setTheme("dark");
await shot("empty-filter-dark");
await setTheme("light");
// 8. An empty table (no filter): "No records", not a grid that looks like it's still loading.
await page.evaluate(() => (window.__proofEmpty = true));
await page.click(`${ws} [data-clear-filters]`);
await page.waitForSelector(`${ws} [data-empty-rows]`);
check((await page.textContent(`${ws} [data-empty-rows]`)) === "No records", "an empty table says No records");
check(!(await page.$(`${ws} [data-clear-filters]`)), "… with no Clear filters, as nothing is filtered");
await shot("empty-table");
await page.evaluate(() => (window.__proofEmpty = false));
await addChip("name = 'nowhere'");
await page.waitForSelector(`${ws} [data-clear-filters]`);
await page.click(`${ws} [data-clear-filters]`);
await page.waitForFunction((ws) => document.querySelector(`${ws} [data-testid="results-grid-wrap"]`)?.getAttribute("data-row-count") === "1000", ws);
check((await page.locator(`${line} [data-chip]`).count()) === 0, "Clear filters removes every chip and the rows come back");

check(errors.length === 0, `no page errors${errors.length ? `: ${errors.join(" | ")}` : ""}`);
await browser.close();
