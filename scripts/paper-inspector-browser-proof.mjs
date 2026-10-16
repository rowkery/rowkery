#!/usr/bin/env node
// The Paper inspector (2026-10-10):
// Quick Look, New connection and Review SQL open in one column at the main
// column's right, beside the data. Stubbed `invoke`, Linux keys, 1280 × 800, light and dark.
// Proves:
//  1. Quick Look slides in (slideIn) as a 340 px column on the panel's
//     ground; the grid ends where it begins and its columns keep their
//     widths; ⌘K steps left with it. The head reads ROW + `kiosks · 3 of n`,
//     the title is the row's name with the key icon; the grid's row under it
//     carries the looked wash.
//  2. ↓ / ↑ (the head's buttons and the keys) move the row and the grid's
//     active row follows; → follows the focused foreign key into owners and
//     Quick Look stays open on that row; ⌫ marks the row (badge, struck
//     values, Restore row) and again restores it; Esc closes the column.
//  3. Review SQL ⇧⌘P lists one card per statement with the right badge
//     (UPDATE ink, DELETE red), a summary and the SQL in token colours; its
//     Commit sends exactly the text it showed and the edits are committed.
//  4. While Confirm writes holds a commit, the edits bar's Commit is
//     disabled and its count says the write waits for confirmation.
//  5. A filter matching nothing offers + Add row, which stages a new row.
//  6. New connection is a 380 px column: Save and connect is dim until the
//     form can connect, the probe line turns green with the server's
//     answer; SQLite's tab takes a chosen file and probes it; Esc closes.
//  7. The tab row folds by need, not because an inspector is open: Quick
//     Look at 1280 px keeps Data | Structure in words and ⌘K's label.
//  8. INCOMING reads `2 rows →`; a row with no name-like column is titled
//     `#<pk>`.
// Screenshots go to outDir, by default /tmp/rowkery-proof/paper-inspector:
// desktop / dark (Quick Look on a table tab), quicklook-incoming,
// quicklook-pk-title, review / review-dark, connect / connect-dark, sqlite,
// confirm-writes, empty-filter.
//
//   cd apps/rowkery-tauri && npx vite --port 1420 &
//   node scripts/paper-inspector-browser-proof.mjs [outDir]
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
const OUT = process.argv[2] ?? "/tmp/rowkery-proof/paper-inspector";
const URL = process.env.ROWKERY_DEV_URL ?? "http://localhost:1420/";
mkdirSync(OUT, { recursive: true });

function stubTauri() {
  localStorage.clear();
  const col = (name, type_name, extra = {}) => ({ name, type_name, nullable: true, ...extra });
  const id = col("id", "bigint", { nullable: false });
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
  const tables = [
    table("kiosks", [id, col("name", "text"), col("city", "text"), col("owner_id", "bigint")], 120, [
      { name: "kiosks_owner_id_fkey", columns: ["owner_id"], ref_schema: "public", ref_table: "owners", ref_columns: ["id"], on_delete: "NO ACTION" },
    ]),
    table("owners", [id, col("name", "text")], 40),
    // No name-like column: Quick Look titles its rows `#<pk>`. It references kiosks (Incoming).
    table("payments", [id, col("amount", "numeric"), col("status", "text"), col("kiosk_id", "bigint")], 60, [
      { name: "payments_kiosk_id_fkey", columns: ["kiosk_id"], ref_schema: "public", ref_table: "kiosks", ref_columns: ["id"], on_delete: "NO ACTION" },
    ]),
  ];
  const wire = {
    kiosks: [
      { name: "id", type_name: "int8" },
      { name: "name", type_name: "text" },
      { name: "city", type_name: "text" },
      { name: "owner_id", type_name: "int8" },
    ],
    owners: [
      { name: "id", type_name: "int8" },
      { name: "name", type_name: "text" },
    ],
    payments: [
      { name: "id", type_name: "int8" },
      { name: "amount", type_name: "numeric" },
      { name: "status", type_name: "text" },
      { name: "kiosk_id", type_name: "int8" },
    ],
  };
  const CITIES = ["Petaling Jaya", "Kuala Lumpur", "Shah Alam", "Subang Jaya", "Klang"];
  const rowOf = (t, n) =>
    t === "owners"
      ? [{ Int: n }, { Text: `Owner ${n}` }]
      : t === "payments"
        ? [{ Int: 4800 + n }, { Text: `${(n * 37) % 900}.50` }, { Text: n % 3 ? "settled" : "pending" }, { Int: (n % 120) + 1 }]
        : [{ Int: n }, { Text: `Kiosk ${String(n).padStart(3, "0")}` }, n % 7 === 6 ? { Null: null } : { Text: CITIES[n % 5] }, { Int: (n % 40) + 1 }];
  window.__CALLS__ = [];
  window.__SAVED__ = [];
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
        case "browse_table": {
          const t = rest.table;
          const filter = rest.filter?.trim() ?? "";
          const one = /^id = (\d+)$/.exec(filter);
          const total = /nowhere/.test(filter) ? 0 : t === "owners" ? 40 : t === "payments" ? 60 : 120;
          const ids = one ? [Number(one[1])] : Array.from({ length: total }, (_, i) => i + 1);
          const queryId = ++nextId;
          setTimeout(() => {
            const send = (f) => onFrame.onmessage({ query_id: queryId, ...f });
            send({ t: "columns", columns: wire[t] });
            if (ids.length) send({ t: "rows", seq: 0, rows: ids.map((n) => rowOf(t, n)) });
            send({ t: "done", status: "ok", row_count: ids.length, affected_rows: null, elapsed_ms: 3, first_row_ms: 1, frames: 1, error: null, sqlstate: null, error_position: null, hold: null });
          }, 5);
          return { query_id: queryId, sql: `SELECT * FROM public.${t}${filter ? ` WHERE ${filter}` : ""} LIMIT 1000;` };
        }
        case "follow_keys":
          return rest.lookups.map((l) => ({ columns: wire[l.table], row: rowOf(l.table, l.value.Int) }));
        case "count_incoming":
          return rest.lookups.map((l) => (l.table === "payments" ? 2 : 0));
        case "review_changes": {
          const stmts = rest.changes.map((c) =>
            c.op === "update"
              ? { verb: "update", sql: `UPDATE public.kiosks SET ${c.set[0].column} = '${c.set[0].value.Text}' WHERE id = ${c.key[0].value.Int};`, target: "public.kiosks", predicate: `id = ${c.key[0].value.Int}` }
              : c.op === "delete"
                ? { verb: "delete", sql: `DELETE FROM public.kiosks WHERE id = ${c.key[0].value.Int};`, target: "public.kiosks", predicate: `id = ${c.key[0].value.Int}` }
                : { verb: "insert", sql: "INSERT INTO public.kiosks DEFAULT VALUES;", target: "public.kiosks", predicate: null },
          );
          return { statements: stmts, sql: ["BEGIN;", ...stmts.map((s) => s.sql), "COMMIT;"].join("\n") };
        }
        case "apply_changes": {
          const n = (op) => rest.changes.filter((c) => c.op === op).length;
          if (!rest.confirmed && window.__APPLY__ === "confirm")
            return {
              status: "held",
              sql: "BEGIN;\nUPDATE public.kiosks SET city = 'Ipoh' WHERE id = 5;\nCOMMIT;",
              hold: { action: "confirm", mode: "confirm", statements: [{ kind: "write", verb: "UPDATE", target: "public.kiosks", destructive: false, unlocks_writes: false }] },
            };
          return { status: "committed", inserted: n("insert"), updated: n("update"), deleted: n("delete"), elapsed_ms: 24 };
        }
        case "probe_connection": {
          await new Promise((r) => setTimeout(r, 60));
          if (rest.connection.kind === "sqlite") return { ok: true, message: "SQLite 3.45.0", elapsed_ms: 4 };
          return { ok: true, message: "PostgreSQL 16.3", elapsed_ms: 41 };
        }
        case "choose_file":
          return rest.kind === "sqlite" ? "/Users/me/dev/app/dev.sqlite" : null;
        case "count_rows":
          return 120;
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
const ql = `${ws} [data-quicklook]:not([data-closing] *)`;
const shot = async (name, wait = 450) => {
  await page.waitForTimeout(wait);
  await page.mouse.move(1, 1);
  await page.screenshot({ path: `${OUT}/${name}.png` });
  console.log(`${OUT}/${name}.png`);
};
const setTheme = async (scheme) => {
  await page.emulateMedia({ colorScheme: scheme });
  await page.waitForFunction((s) => document.documentElement.dataset.theme === s, scheme);
};
const settle = () => page.waitForFunction((ws) => !document.querySelector(`${ws} [data-state="running"]`), ws);
const box = (sel) => page.locator(sel).first().boundingBox();
const cell = (row, col) => `${ws} [data-testid="rg-body"] [data-row="${row}"] [data-col="${col}"]`;
const text = (sel) => page.locator(sel).first().evaluate((e) => e.innerText.replace(/\s+/g, " ").trim());
const tokenColor = (token) =>
  page.evaluate((t) => {
    const p = document.createElement("i");
    p.style.color = `var(${t})`;
    document.body.append(p);
    const c = getComputedStyle(p).color;
    p.remove();
    return c;
  }, token);
const gone = (sel) => page.waitForFunction((s) => !document.querySelector(s), sel, { timeout: 1500 }).then(() => true, () => false);
const stageText = async (row, col, value) => {
  await page.click(cell(row, col));
  await page.keyboard.press("Enter");
  await page.keyboard.press("ControlOrMeta+a");
  await page.keyboard.type(value);
  await page.keyboard.press("Enter");
};

await page.waitForSelector('[data-testid="workspace"]:not([hidden])'); // Paper (2026-10-10): an empty window shows no connection chip (no tab row without a connection); wait for the window, then ⇧⌘O as before.
await page.keyboard.press("Control+Shift+O");
await page.waitForSelector('[data-testid="conn-popover"]');
await page.keyboard.press("Enter");
await page.waitForSelector(`${ws}[data-conn-state="connected"]`);
await page.click(`${ws} [data-table="rowkery.public.kiosks"] [data-testid="sb-row-main"]`);
await page.waitForFunction((ws) => document.querySelector(`${ws} [data-testid="results-grid-wrap"]`)?.getAttribute("data-row-count") === "120", ws);
await settle();
await page.waitForTimeout(300);

// 1 · Quick Look slides in as the inspector column.
const nameW0 = (await box(`${ws} [data-header="name"]`)).width;
const cap0 = await box('[data-testid="search-cap"]');
await page.click(cell(2, 3));
await page.keyboard.press("Space");
await page.waitForSelector(ql);
const entry = await page.$eval(ql, (e) => getComputedStyle(e).animationName);
check(entry === "slideIn", `it slides in (${entry})`);
await page.waitForTimeout(350);
const look = await page.$eval(ql, (e) => {
  const r = e.getBoundingClientRect();
  const g = e.closest('[data-testid="workspace"]').querySelector('[data-testid="results-grid-wrap"]').getBoundingClientRect();
  return { w: r.width, left: r.left, right: window.innerWidth - r.right, gridRight: g.right, bg: getComputedStyle(e).backgroundColor };
});
check(look.w === 340 && Math.round(look.right) === 0, `a 340 px column at the window's right (${look.w}, ${look.right})`);
check(look.bg === (await tokenColor("--panel")), `on the panel's ground (${look.bg})`);
check(Math.abs(look.gridRight - look.left) <= 1, `the grid ends where it begins (${look.gridRight} / ${look.left})`);
check(Math.abs((await box(`${ws} [data-header="name"]`)).width - nameW0) < 1, "the grid's columns keep their widths");
const cap1 = await box('[data-testid="search-cap"]');
// ⌘K is in the title bar, above the column; it stays put.
check(cap1.x === cap0.x && cap1.y + cap1.height <= 48, "⌘K stays in the title bar above the column");
const fold = await page.evaluate((ws) => {
  const shown = (sel) => [...document.querySelectorAll(sel)].some((e) => e.getBoundingClientRect().width > 0);
  return { words: shown(`${ws} [data-testid="view-switch"] .view-switch-label`), search: shown(".search-cap-label") }; // Classes on purpose: the folded labels are under test.
}, ws);
check(fold.words && fold.search, `the tab row folds by need: with room, Data | Structure keeps its words and ⌘K its label (${JSON.stringify(fold)})`);
check((await text(`${ql} [data-testid="ql-head"]`)).startsWith("ROW kiosks · 3 of 120"), `head: ${await text(`${ql} [data-testid="ql-head"]`)}`);
check((await text(`${ql} [data-testid="ql-title"]`)) === "Kiosk 003" && (await page.locator(`${ql} [data-testid="ql-title"] svg`).count()) === 1, "titled by the row's name, with the key icon");
const titleFont = await page.$eval(`${ql} [data-testid="ql-title"]`, (e) => getComputedStyle(e).fontSize);
check(titleFont === "24px", `title at 24 px (${titleFont})`);
check((await page.locator(`${ws} [data-testid="rg-body"] [data-row="2"][data-looked]`).count()) === 1, "the grid's row under it carries the looked wash");
await page.waitForSelector(`${ql} [data-incoming-row="payments"][data-count="2"]`);
check((await text(`${ql} [data-incoming-row="payments"]`)) === "payments 2 rows →", `INCOMING reads n rows → (${await text(`${ql} [data-incoming-row="payments"]`)})`);
await shot("desktop");
await shot("quicklook-incoming", 0);
await setTheme("dark");
await shot("dark");
await setTheme("light");

// 2 · ↑↓ move it; the grid's active row follows.
await page.click(`${ql} [data-ql-next]`);
await page.waitForFunction((s) => document.querySelector(s)?.textContent.includes("4 of 120"), `${ql} [data-testid="ql-head"]`);
check((await page.locator(`${ws} [data-testid="rg-body"] [data-row="3"][data-looked]`).count()) === 1, "the head's ↓ moves to row 4, the grid's row follows");
await page.keyboard.press("ArrowDown");
await page.waitForFunction((s) => document.querySelector(s)?.textContent.includes("5 of 120"), `${ql} [data-testid="ql-head"]`);
check((await page.locator(`${ws} [data-testid="rg-body"] [data-row="4"][data-looked]`).count()) === 1, "↓ moves to row 5, the grid's row follows");
await page.keyboard.press("ArrowUp");
await page.click(`${ql} [data-ql-prev]`);
await page.waitForFunction((s) => document.querySelector(s)?.textContent.includes("3 of 120"), `${ql} [data-testid="ql-head"]`);
check((await page.locator(`${ws} [data-testid="rg-body"] [data-row="2"][data-looked]`).count()) === 1, "↑ and the head's ↑ walk back to row 3");

// ⌫ marks the row; again restores it.
await page.keyboard.press("Backspace");
await page.waitForSelector(`${ql} [data-ql-deleted]`);
const struck = await page.$eval(`${ql} .ql-value`, (e) => getComputedStyle(e).textDecorationLine); // Class on purpose: the struck value is under test.
check(struck === "line-through" && (await text(`${ql} [data-ql-delete]`)).startsWith("Restore row"), `⌫ marks it: badge, struck values, Restore row (${struck})`);
await page.keyboard.press("Backspace");
await page.waitForFunction((s) => !document.querySelector(s), `${ql} [data-ql-deleted]`);
check((await text(`${ql} [data-ql-delete]`)).startsWith("Delete row"), "⌫ again restores it");

// → follows the focused foreign key; Quick Look stays open on that row.
await page.waitForSelector(`${ql} [data-follow="owner_id"]`);
await page.keyboard.press("ArrowRight");
await page.waitForFunction(() => document.querySelector('[data-testid="workspace"]:not([hidden]) [data-testid="query-tab"][aria-selected="true"]')?.textContent.includes("owners"));
await page.waitForFunction((s) => document.querySelector(s)?.textContent.trim() === "Owner 4", `${ql} [data-testid="ql-title"]`);
const browsed = await page.evaluate(() => window.__CALLS__.filter(([c]) => c === "browse_table").at(-1)[1]);
check(browsed.table === "owners" && browsed.filter === "id = 4", `→ follows owner_id into owners WHERE ${browsed.filter}, Quick Look on Owner 4`);
await page.keyboard.press("Escape");
check(await gone(`${ws} [data-quicklook]`), "Esc closes the column");
const mainRight = await page.$eval(`${ws} [data-testid="main"]`, (e) => window.innerWidth - e.getBoundingClientRect().right);
check(Math.round(mainRight) === 0, `the main column takes the room back (${mainRight})`);
await page.keyboard.press("Alt+ArrowLeft");
await page.waitForFunction(() => document.querySelector('[data-testid="workspace"]:not([hidden]) [data-testid="query-tab"][aria-selected="true"]')?.textContent.includes("kiosks"));
await page.waitForFunction((ws) => document.querySelector(`${ws} [data-testid="results-grid-wrap"]`)?.getAttribute("data-row-count") === "120", ws);
await settle();
await page.waitForTimeout(200);

// 3 · Review SQL: one card per statement, Commit sends what it showed.
await stageText(0, 2, "Puchong");
await page.click(`${ws} [data-testid="rg-body"] [data-row="1"] [data-testid="rg-gutter"]`);
await page.keyboard.press("Backspace");
await page.waitForFunction((ws) => document.querySelector(`${ws} [data-edit-tray]`)?.getAttribute("data-changes") === "2", ws);
// Quick Look open, then Review SQL: the same aside glides, it doesn't slide in again.
await page.click(cell(5, 1));
await page.keyboard.press("Space");
await page.waitForSelector(ql);
await page.waitForTimeout(300);
await page.$eval(ql, (e) => (e.__same = true));
await page.keyboard.press("Control+Shift+p");
await page.waitForSelector("[data-review-sql] [data-review-card]");
check(await page.$eval("[data-review-sql]", (e) => e.__same === true && !document.querySelector("[data-quicklook]")), "Review SQL takes the same aside from Quick Look (no second slide-in)");
const cards = await page.$$eval("[data-review-sql] [data-review-card]", (els) => els.map((e) => `${e.dataset.reviewCard}:${e.querySelector("[data-review-badge]").textContent}`));
check(cards.join(",") === "update:UPDATE,delete:DELETE", `one card per statement with its badge (${cards.join(", ")})`);
check((await text("[data-review-sql] [data-review-meta]")) === "2 statements · one transaction", "head: 2 statements · one transaction");
const badges = await page.$$eval("[data-review-sql] [data-review-badge]", (els) => els.map((e) => getComputedStyle(e).backgroundColor));
check(badges[0] === (await tokenColor("--ink")) && badges[1] === (await tokenColor("--del")), `UPDATE in ink, DELETE in red (${badges.join(", ")})`);
const summary = await text("[data-review-sql] [data-review-card=update] .rv-summary"); // Class on purpose: the summary line is under test.
check(summary === "kiosks · id 1 · city Kuala Lumpur → Puchong", `the summary names the change (${summary})`);
// Class on purpose: .k is the keyword colour under test.
check((await page.locator("[data-review-sql] [data-review-card] .k").count()) >= 2, "the SQL in token colours");
const rvW = await page.$eval("[data-review-sql]", (e) => e.offsetWidth);
check(rvW === 340, `a 340 px column (${rvW})`);
await shot("review");
await setTheme("dark");
await shot("review-dark");
await setTheme("light");
const shown = await page.getAttribute("[data-review-sql] [data-review-text]", "data-review-text");
await page.click("[data-review-sql] [data-review-commit]");
await page.waitForSelector(`${ws} [data-edit-tray="done"]`);
const applied = await page.evaluate(() => window.__CALLS__.filter(([c]) => c === "apply_changes").at(-1)[1]);
check(applied.confirmed === shown, "Commit sends exactly the reviewed text");
check(await gone("[data-review-sql]"), "and the column closes");

// 4 · Confirm writes holds the commit: the bar's Commit waits.
await page.evaluate(() => (window.__APPLY__ = "confirm"));
await page.waitForTimeout(1800);
await stageText(4, 2, "Ipoh");
await page.keyboard.press("Control+s");
await page.waitForSelector(`${ws} [data-held-edits]`);
const bar = await page.$eval(`${ws} [data-edit-tray]`, (e) => ({ held: e.hasAttribute("data-held"), text: e.innerText.replace(/\s+/g, " ") }));
const barCommit = await page.$eval(`${ws} [data-edit-tray] [data-commit]`, (e) => e.disabled);
check(bar.held && barCommit && bar.text.includes("waiting for confirmation"), `the bar's Commit is disabled and says it waits (${bar.text})`);
await shot("confirm-writes");
await page.keyboard.press("Control+Shift+Enter");
await page.waitForSelector(`${ws} [data-edit-tray="done"]`);
check(true, "⇧⌘↵ in the strip commits it");
await page.evaluate(() => (window.__APPLY__ = "ok"));

// 5 · A filter matching nothing offers + Add row.
await page.keyboard.press("Control+f");
await page.waitForSelector(`${ws} [data-chip-editor] [data-testid="sql-editor"]`);
await page.keyboard.type("name = 'nowhere'");
await page.keyboard.press("Enter");
await page.waitForSelector(`${ws} [data-empty-filter] [data-add-row]`);
check((await text(`${ws} [data-empty-filter]`)).startsWith("No rows match. Clear filters"), "No rows match. Clear filters");
await shot("empty-filter");
await page.click(`${ws} [data-empty-filter] [data-add-row]`);
await page.waitForSelector(`${ws} [data-insert]`);
// The bar may still read the last commit's "done" for 1.6 s.
check(await page.waitForSelector(`${ws} [data-tray-count="inserted"]`, { timeout: 3000 }).then(() => true, () => false), "+ Add row stages a new row");
await page.keyboard.press("Escape");
await page.click(`${ws} [data-discard]`);

// 6 · New connection: a 380 px column; Save is dim until the form can connect.
await page.keyboard.press("Control+n");
await page.waitForSelector('[data-testid="nc-sheet"]');
await page.waitForTimeout(300);
const nc = await page.$eval('[data-testid="nc-sheet"]', (e) => ({ w: e.getBoundingClientRect().width, right: window.innerWidth - e.getBoundingClientRect().right }));
check(nc.w === 380 && Math.round(nc.right) === 0, `a 380 px column at the right (${nc.w})`);
const mcpRow = await box("[data-mcp-switch]");
const foot = await box("[data-save]");
check(mcpRow.y + mcpRow.height <= foot.y && foot.y + foot.height <= 800, `the MCP row and the foot fit in 800 px (MCP at ${Math.round(mcpRow.y)}, Save at ${Math.round(foot.y)})`);
const tabsRow = await box(`${ws} [data-testid="query-tabs"]`);
const firstTab = await box(`${ws} [data-testid="query-tab"]`);
const capW = (await box('[data-testid="search-cap"]')).width;
check(firstTab.x >= tabsRow.x - 0.5, `the first tab stays in view (tab at ${firstTab.x}, row at ${tabsRow.x}; ⌘K ${capW} px in the title bar)`);
const mainRightNc = await page.$eval(`${ws} [data-testid="main"]`, (e) => window.innerWidth - e.getBoundingClientRect().right);
check(Math.round(mainRightNc) === 380, `the window stays in view beside it (${mainRightNc})`);
const saveOpacity = () => page.$eval("[data-save]", (e) => getComputedStyle(e).opacity);
check((await saveOpacity()) === "0.5", "Save and connect is dim on an empty form");
const fill = async (field, value) => {
  await page.fill(`[data-field="${field}"] input`, value);
};
await fill("name", "kiosk-stg");
await fill("host", "stg.kiosk.internal");
check((await saveOpacity()) === "0.5", "still dim with Name and Host only (Database and User are required)");
await fill("database", "kiosk");
await fill("username", "alice");
await fill("password", "secret");
await page.waitForSelector('[data-probe="ok"]');
check((await saveOpacity()) === "1", "full once the form can connect");
await page.waitForTimeout(400); // the line's colour eases in over .3 s
const probe = await text("[data-probe]");
const probeColor = await page.$eval("[data-probe] .nc-status", (e) => getComputedStyle(e).color);
check(probe === "Connected in 41 ms · PostgreSQL 16.3" && probeColor === (await tokenColor("--ok")), `the probe line in green: ${probe}`);
await page.click("[data-env-choice=stg]");
await page.click("[data-safe-choice=confirm]");
await page.focus('[data-field="host"] input');
await shot("connect");
await setTheme("dark");
await shot("connect-dark");
await setTheme("light");

// SQLite: the tab, a chosen file, its probe.
await page.click("[data-engine-tab=sqlite]");
await page.click("[data-choose-file]");
await page.waitForSelector('[data-probe="ok"]');
check((await text("[data-probe]")).startsWith("Opened in"), `SQLite: the chosen file opens (${await text("[data-probe]")})`);
await shot("sqlite");
await page.keyboard.press("Escape");
check(await gone('[data-testid="nc-overlay"]'), "Esc closes New connection");

// A row with no name-like column is titled by its key; the head names the table.
await page.click(`${ws} [data-table="rowkery.public.payments"] [data-testid="sb-row-main"]`);
await page.waitForFunction((ws) => document.querySelector(`${ws} [data-testid="results-grid-wrap"]`)?.getAttribute("data-row-count") === "60", ws);
await settle();
await page.click(cell(0, 1));
await page.keyboard.press("Space");
await page.waitForSelector(ql);
check((await text(`${ql} [data-testid="ql-title"]`)) === "#4801" && (await text(`${ql} [data-testid="ql-head"]`)).startsWith("ROW payments · 1 of 60"), `no name-like column: titled #<pk> (${await text(`${ql} [data-testid="ql-title"]`)})`);
await shot("quicklook-pk-title");
await page.keyboard.press("Escape");

check(errors.length === 0, `no page errors${errors.length ? `: ${errors.join(" | ")}` : ""}`);
await browser.close();
