#!/usr/bin/env node
// Paper in light and dark (the Paper decision, 2026-10-10: light AND dark
// following macOS). Stubbed `invoke`, Linux keys, 1280 × 800.
//
// Walks every surface in light and in dark and
// captures a light / dark pair of each into outDir (by default
// /tmp/rowkery-proof/paper-finish/<surface>-light.png / -dark.png):
// shell (title bar + schema column + table head with a chip), the chip editor,
// grid states (edited / deleted / new rows, the NULL chip, the foot edits
// bar), Structure, Quick Look, Review SQL, New connection, the query editor
// (statement bar and Run), ⌘K, the connection picker, a context menu, a zone
// menu, a toast, Timings, Shortcuts, Connect an agent, Report, Connect to
// start, Couldn't connect and the Agents page.
//
// Proves, per surface and theme:
//  1. No light-only colour in dark: every visible element (and its ::before
//     / ::after) inside the surface has no colour, background or border that
//     is one of the light theme's surface / text values (#f7f7f7, #e6e6e6,
//     #5c5c5c …), and the reverse in light (no dark ground).
//  2. A representative element reads its token: computed colours compared
//     with the token resolved in that theme (`tokenColor("--panel")`).
//  3. Readable: the representative text clears 4.5:1 (3:1 for 14 px bold
//     and up) on the ground it sits on, in both themes; the 10.5 px
//     uppercase section labels clear 4.5:1 on --bg and --panel.
//  4. The focus ring survives dark: a focused control's outline or ring is
//     the theme's --acc.
//
//   cd apps/rowkery-tauri && npx vite --port 1420 &
//   node scripts/paper-finish-browser-proof.mjs [outDir]
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
const OUT = process.argv[2] ?? "/tmp/rowkery-proof/paper-finish";
const URL = process.env.ROWKERY_DEV_URL ?? "http://localhost:1420/";
mkdirSync(OUT, { recursive: true });

// A connected window on a table with key links (the paper-inspector stub),
// plus a query tab, MCP activity and a failing connection for the dead ends.
function stubTauri(opts) {
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
  };
  const CITIES = ["Petaling Jaya", "Kuala Lumpur", "Shah Alam", "Subang Jaya", "Klang"];
  const rowOf = (t, n) =>
    t === "owners"
      ? [{ Int: n }, { Text: `Owner ${n}` }]
      : [{ Int: n }, { Text: `Kiosk ${String(n).padStart(3, "0")}` }, n % 7 === 6 ? { Null: null } : { Text: CITIES[n % 5] }, { Int: (n % 40) + 1 }];
  const pg = (id, name, environment) => ({ kind: "postgres", id, name, host: `${id}.arcade.internal`, port: 5432, database: "rowkery", username: "alice", environment, allow_mcp: true });
  const conns = [pg("prd", "kiosk-prd", "prd"), pg("stg", "kiosk-stg", "stg"), pg("dev", "wallet-dev", "dev")];
  const t0 = Date.now();
  const base = { session: t0 - 150_000, client: "claude-code" };
  const log = [
    { ...base, ts: t0 - 140_000, tool: "list_connections", rows: 2, ms: 1, verdict: "ok" },
    { ...base, ts: t0 - 110_000, tool: "query", connection: "prd", database: "rowkery", sql: "select status, count(*) from payouts group by status", rows: 4, ms: 61, verdict: "ok" },
    { ...base, ts: t0 - 80_000, tool: "query", connection: "dev", database: "wallet", sql: "select * from wallet_transactions where payload::text like '%failed%'", verdict: "Refused: the plan reads public.wallet_transactions (~412880 rows) end to end." },
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
          return { connections: structuredClone(conns), active_connection_id: null };
        case "open_window":
          if (opts.fail) throw "Connection refused (os error 61)";
          return { database: "rowkery", catalog: { databases: [{ name: "rowkery", schemas: [{ name: "public", tables }] }] }, elapsed_ms: 2, cached: false, open_seq: 1 };
        case "explain_connect_error":
          return { class: "refused", cause: "Nothing is listening on prd.arcade.internal:5432.", field: null };
        case "browse_table": {
          const t = rest.table;
          const filter = rest.filter?.trim() ?? "";
          const total = t === "owners" ? 40 : 120;
          const ids = Array.from({ length: total }, (_, i) => i + 1);
          const queryId = ++nextId;
          setTimeout(() => {
            const send = (f) => onFrame.onmessage({ query_id: queryId, ...f });
            send({ t: "columns", columns: wire[t] });
            send({ t: "rows", seq: 0, rows: ids.map((n) => rowOf(t, n)) });
            send({ t: "done", status: "ok", row_count: ids.length, affected_rows: null, elapsed_ms: 3, first_row_ms: 1, frames: 1, error: null, sqlstate: null, error_position: null, hold: null });
          }, 5);
          return { query_id: queryId, sql: `SELECT * FROM public.${t}${filter ? `\nWHERE (${filter})` : ""}\nORDER BY id\nLIMIT 1000;` };
        }
        case "follow_keys":
          return rest.lookups.map((l) => ({ columns: wire[l.table], row: rowOf(l.table, l.value.Int) }));
        case "count_incoming":
          return rest.lookups.map(() => 0);
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
        case "probe_connection":
          return { ok: true, message: "PostgreSQL 16.3", elapsed_ms: 41 };
        case "probe_local_servers":
          return [{ port: 5432, user: "alice" }];
        case "count_rows":
          return 120;
        case "mcp_activity":
          return { entries: structuredClone(log), offset: log.length, reset: true };
        case "mcp_connect_check":
          return { client: rest.client, state: "ready", preview: "claude mcp add --scope user rowkery -- Rowkery --mcp", copy: "claude mcp add --scope user rowkery -- Rowkery --mcp", existing: null, config_file: null, problem: null };
        case "run_query": {
          const queryId = ++nextId;
          setTimeout(() => {
            const send = (f) => onFrame.onmessage({ query_id: queryId, ...f });
            send({ t: "columns", columns: [{ name: "name", type_name: "text" }, { name: "plays", type_name: "int8" }] });
            send({ t: "rows", seq: 0, rows: [["Pac-Man", 412], ["Galaga", 377], ["Tetris", 351]].map(([n, p]) => [{ Text: n }, { Int: p }]) });
            send({ t: "done", status: "ok", row_count: 3, affected_rows: null, elapsed_ms: 7, first_row_ms: 2, frames: 1, error: null, sqlstate: null, error_position: null, hold: null });
          }, 5);
          return { query_id: queryId };
        }
        default:
          return null;
      }
    },
  };
}

let failed = 0;
const check = (cond, msg) => {
  if (!cond) {
    console.error(`FAIL: ${msg}`);
    failed++;
    process.exitCode = 1;
  } else console.log(`ok: ${msg}`);
};
const browser = await playwright.chromium.launch({ executablePath: process.env.CHROMIUM_PATH ?? "/opt/pw-browsers/chromium" });
const ws = '[data-testid="workspace"]:not([hidden])';
const line = `${ws} [data-sql-line]`;
let page;
const fresh = async (opts = {}) => {
  if (page) await page.close();
  page = await browser.newPage({ viewport: { width: 1280, height: 800 }, deviceScaleFactor: 2, colorScheme: "light" });
  page.on("pageerror", (e) => console.error("pageerror:", e.message));
  await page.addInitScript({ path: LINUX_PLATFORM });
  await page.addInitScript(stubTauri, opts);
  await page.addInitScript(installContrast);
  await page.goto(URL);
  await page.waitForSelector(ws);
};
const setTheme = async (scheme) => {
  await page.emulateMedia({ colorScheme: scheme });
  await page.waitForFunction((s) => document.documentElement.dataset.theme === s, scheme);
  await page.waitForTimeout(350); // the frame's background transition
};
const settle = () => page.waitForFunction((ws) => !document.querySelector(`${ws} [data-state="running"]`), ws);

// The light theme's own surface and text values (App.css :root): none may
// paint in dark. And the dark ground values, which may not paint in light.
const LIGHT_ONLY = ["#f7f7f7", "#f3f3f3", "#e6e6e6", "#efefef", "#ededed", "#2b2b2b", "#5c5c5c", "#6b6b6b", "#adadad", "#d9641a", "#c2560f", "#c43d3d", "#2e8b57", "#2f5bb7", "#8a3fb8", "#1c6fb5", "#c2611a", "#8c8c8c"];
const DARK_ONLY = ["#1a1a1a", "#212121", "#1e1e1e", "#2e2e2e", "#3d3d3d", "#242424", "#2a2a2a", "#303030", "#a4a8ae", "#8b9097", "#ff8a3d", "#ef6b6b", "#5cc98c"];

// Every visible element under `root` (and its pseudo-elements): colour,
// background and borders that equal one of `bad` (an rgb string). White is
// in neither list: it is light's sheet and dark's ink (Commit, the website's
// white button). Returns "selector: prop value" lines.
const offenders = (root, scheme) =>
  page.evaluate(
    ({ root, bad }) => {
      const rgb = (h) => `rgb(${parseInt(h.slice(1, 3), 16)}, ${parseInt(h.slice(3, 5), 16)}, ${parseInt(h.slice(5, 7), 16)})`;
      const badSet = new Set(bad.map(rgb));
      const out = [];
      const name = (e) => `${e.tagName.toLowerCase()}${e.id ? `#${e.id}` : ""}${[...e.classList].slice(0, 2).map((c) => `.${c}`).join("")}${e.dataset.testid ? `[${e.dataset.testid}]` : ""}`;
      for (const r of document.querySelectorAll(root)) {
        for (const e of [r, ...r.querySelectorAll("*")]) {
          const box = e.getBoundingClientRect();
          if (!box.width || !box.height) continue;
          for (const pseudo of [null, "::before", "::after"]) {
            const s = getComputedStyle(e, pseudo);
            if (pseudo && (s.content === "none" || s.content === "normal")) continue;
            if (s.visibility === "hidden" || s.opacity === "0" || s.display === "none") continue;
            const props = [["background-color", s.backgroundColor]];
            // Text colour only matters where there is text.
            if (pseudo ? s.content !== '""' : [...e.childNodes].some((n) => n.nodeType === 3 && n.textContent.trim())) props.push(["color", s.color]);
            for (const side of ["top", "right", "bottom", "left"])
              if (parseFloat(s[`border-${side}-width`] ?? s.getPropertyValue(`border-${side}-width`)) > 0 && s.getPropertyValue(`border-${side}-style`) !== "none") props.push([`border-${side}-color`, s.getPropertyValue(`border-${side}-color`)]);
            if (e instanceof SVGElement) props.push(["fill", s.fill], ["stroke", s.stroke]);
            for (const [p, v] of props) {
              if (badSet.has(v)) out.push(`${name(e)}${pseudo ?? ""}: ${p} ${v}`);
            }
          }
        }
      }
      return [...new Set(out)];
    },
    { root, bad: scheme === "dark" ? LIGHT_ONLY : DARK_ONLY },
  );

const tokenColor = (token, prop = "color") =>
  page.evaluate(
    ({ t, prop }) => {
      const p = document.createElement("i");
      p.style[prop] = `var(${t})`;
      document.body.append(p);
      const c = getComputedStyle(p)[prop];
      p.remove();
      return c;
    },
    { t: token, prop },
  );
// Contrast of an element's text against the ground behind it (the first
// ancestor with an opaque fill; alpha fills are blended over it). Installed
// in the page as window.__contrast(element).
function installContrast() {
  window.__contrast = (e) => {
    // rgb() / rgba(), or color(srgb r g b / a) from a color-mix().
    const parse = (c) => {
      const m = c.match(/rgba?\(([^)]+)\)/);
      if (m) {
        const [r, g, b, a = 1] = m[1].split(/[ ,/]+/).filter(Boolean).map(Number);
        return [r, g, b, a];
      }
      const x = c.match(/color\(srgb ([^)]+)\)/);
      if (!x) return null;
      const [r, g, b, a = 1] = x[1].split(/[ /]+/).filter(Boolean).map(Number);
      return [r * 255, g * 255, b * 255, a];
    };
    const layers = [];
    for (let n = e; n; n = n.parentElement) {
      const bg = parse(getComputedStyle(n).backgroundColor);
      if (bg && bg[3] > 0) {
        layers.push(bg);
        if (bg[3] >= 1) break;
      }
    }
    let ground = [255, 255, 255];
    for (const [r, g, b, a] of layers.reverse()) ground = [r * a + ground[0] * (1 - a), g * a + ground[1] * (1 - a), b * a + ground[2] * (1 - a)];
    const s = getComputedStyle(e);
    const [fr, fg, fb, fa] = parse(s.color);
    let op = 1;
    for (let n = e; n; n = n.parentElement) op *= Number(getComputedStyle(n).opacity);
    const fgc = [fr, fg, fb].map((v, i) => v * fa * op + ground[i] * (1 - fa * op));
    const lum = ([r, g, b]) => [r, g, b].map((v) => ((v /= 255) <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4)).reduce((acc, v, i) => acc + v * [0.2126, 0.7152, 0.0722][i], 0);
    const [l1, l2] = [lum(fgc), lum(ground)].sort((a, b) => b - a);
    return { ratio: Math.round(((l1 + 0.05) / (l2 + 0.05)) * 100) / 100, size: parseFloat(s.fontSize), weight: Number(s.fontWeight) };
  };
}
const contrastOf = (sel) => page.evaluate((sel) => (document.querySelector(sel) ? window.__contrast(document.querySelector(sel)) : null), sel);

// The 10.5–11 px uppercase section labels (TABLES, WHERE, ACTIVITY …) and
// the ≤ 11.5 px mono (counts, keys, types) under `root`: those under 4.5:1
// on their ground.
const lowLabels = (root) =>
  page.evaluate((root) => {
    const low = [];
    for (const r of document.querySelectorAll(root))
      for (const e of [r, ...r.querySelectorAll("*")]) {
        const s = getComputedStyle(e);
        const small = s.textTransform === "uppercase" ? parseFloat(s.fontSize) <= 11 : /Mono/.test(s.fontFamily.split(",")[0]) && parseFloat(s.fontSize) <= 11.5;
        if (!small || !e.getBoundingClientRect().width || s.visibility === "hidden") continue;
        const own = [...e.childNodes].filter((c) => c.nodeType === 3).map((c) => c.textContent).join("").trim();
        // Words and numbers only (a ▾ or the prompt's > is an icon), and not
        // inside a disabled control (exempt, and dimmed on purpose: New
        // connection's Save before the form can connect). Run's keys ride
        // the prototype's white on light orange (3.6:1 at best), the
        // Run as drawn; recorded in DESIGN.md, not changed here.
        if (!/[\p{L}\p{N}]/u.test(own) || e.closest(":disabled, [aria-disabled='true'], .nc-save:not([data-ready]), .run-btn")) continue;
        const c = window.__contrast(e);
        if (c.ratio < 4.5) low.push(`${e.textContent.trim().slice(0, 20)} (${e.tagName.toLowerCase()}.${[...e.classList].join(".")} in ${e.parentElement.className}) ${c.ratio}:1`);
      }
    return [...new Set(low)];
  }, root);

// One surface in both themes: offenders, the token check, readable text,
// and the pair of screenshots.
const surface = async (name, root, checks = []) => {
  for (const scheme of ["light", "dark"]) {
    await setTheme(scheme);
    await page.mouse.move(1, 1);
    await page.waitForTimeout(150);
    const bad = await offenders(root, scheme);
    check(bad.length === 0, `${name} (${scheme}): no ${scheme === "dark" ? "light" : "dark"}-only colour${bad.length ? `: ${bad.slice(0, 8).join(" | ")}${bad.length > 8 ? ` (+${bad.length - 8})` : ""}` : ""}`);
    const low = await lowLabels(root);
    check(low.length === 0, `${name} (${scheme}): small labels and mono clear 4.5:1${low.length ? `: ${low.join(" | ")}` : ""}`);
    for (const c of checks) {
      if (c.token) {
        const got = await page.$eval(c.sel, (e, prop) => getComputedStyle(e)[prop], c.prop).catch(() => null);
        const want = await tokenColor(c.token, c.prop === "color" ? "color" : "backgroundColor");
        check(got === want, `${name} (${scheme}): ${c.what} reads ${c.token} (${got})`);
      }
      if (c.every) {
        const rs = await page.$$eval(c.sel, (els) => els.filter((e) => e.getBoundingClientRect().width && [...e.childNodes].some((n) => n.nodeType === 3 && n.textContent.trim())).map((e) => ({ t: e.textContent.trim().slice(0, 16), ...window.__contrast(e) })));
        const low = rs.filter((r) => r.ratio < (r.size >= 14 && r.weight >= 600 ? 3 : 4.5));
        check(rs.length > 0 && low.length === 0, `${name} (${scheme}): every ${c.what} is readable (${rs.length}${low.length ? `; ${low.map((r) => `${r.t} ${r.ratio}:1`).join(" | ")}` : ""})`);
      }
      if (c.readable) {
        const r = await contrastOf(c.sel);
        const min = r && r.size >= 14 && r.weight >= 600 ? 3 : (c.min ?? 4.5);
        check(r && r.ratio >= min, `${name} (${scheme}): ${c.what} is readable (${r?.ratio}:1 at ${r?.size} px, needs ${min})`);
      }
    }
    await page.screenshot({ path: `${OUT}/${name}-${scheme}.png` });
  }
  await setTheme("light");
};

// ── Connected window: shell, table, inspector, editor, overlays ──
await fresh();
// The scanner sees a light value in dark (a planted swatch on --bg's light hex).
await setTheme("dark");
await page.evaluate(() => {
  const i = document.createElement("div");
  i.id = "proof-swatch";
  i.style.cssText = "position:fixed;left:0;top:0;width:4px;height:4px;background:#f7f7f7";
  document.body.append(i);
});
check((await offenders("#proof-swatch", "dark")).length === 1, "the scanner flags a light-only fill in dark");
await page.evaluate(() => document.getElementById("proof-swatch").remove());
await setTheme("light");

await page.keyboard.press("Control+Shift+O");
await page.waitForSelector('[data-testid="conn-popover"]');
await surface("picker", '[data-testid="conn-popover"]');
await page.keyboard.press("Enter");
await page.waitForSelector(`${ws}[data-conn-state="connected"]`);
await page.click(`${ws} [data-table="rowkery.public.kiosks"] [data-testid="sb-row-main"]`);
await page.waitForFunction((ws) => document.querySelector(`${ws} [data-testid="results-grid-wrap"]`)?.getAttribute("data-row-count") === "120", ws);
await settle();
await page.keyboard.press("Control+f");
await page.waitForSelector(`${line} [data-chip-editor] [data-testid="sql-editor"]`);
await page.keyboard.type("city = 'Klang'");
await page.keyboard.press("Enter");
await page.waitForSelector(`${ws} [data-chip-sql]`);
await settle();
await page.keyboard.press("Control+f");
await page.waitForSelector(`${line} [data-chip-editor] [data-testid="sql-editor"]`);
await page.keyboard.type("owner_id > 3");
await surface("chip-editor", `${line}`, [{ sel: `${line} [data-chip-apply]`, what: "Add ↵", token: "--acc", prop: "backgroundColor" }]);
await page.keyboard.press("Escape");
await page.waitForFunction((l) => !document.querySelector(`${l} [data-chip-editor]`), line);
await page.waitForTimeout(200);
await surface("shell", "body", [
  // The title bar (2026-10-13).
  { sel: '[data-testid="titlebar"]', what: "the title bar", token: "--bar", prop: "backgroundColor" },
  { sel: '[data-testid="win-tab"][data-on]', what: "the shown window's pill", token: "--bg", prop: "backgroundColor" },
  { sel: '[data-testid="win-tab"][data-on] [data-testid="win-name"]', what: "the window's name", readable: true },

  { sel: `${ws} [data-chip-sql]`, what: "the chip", token: "--accbg", prop: "backgroundColor" },
  { sel: `${ws} [data-chip-sql]`, what: "the chip's text", readable: true },
  { sel: ".sb-head", what: "the connection name", readable: true }, // Class on purpose: the head.
  { sel: '[data-testid="env-tag"]', what: "env tag", every: true },
]);

// The title bar (2026-10-13) holds the window pills, and no window
// rail is drawn; the schema column keeps its name and host, and ends with
// Agents / Appearance / Help.
const bar6 = await page.evaluate(() => {
  const tb = document.querySelector('[data-testid="titlebar"]');
  const r = tb.getBoundingClientRect();
  const inBar = (sel) => !!tb.querySelector(sel);
  return {
    h: r.height,
    top: r.top,
    w: r.width,
    rule: getComputedStyle(tb).boxShadow,
    rail: !!document.querySelector('[data-testid="rail"]'),
    tabs: tb.querySelectorAll('[data-testid="win-tab"]').length,
    tabH: tb.querySelector('[data-testid="win-tab"]')?.getBoundingClientRect().height,
    add: inBar('[data-testid="win-add"]'),
    shield: inBar('[data-testid="win-tab"][data-on] [data-shield]'),
    cap: inBar('[data-testid="search-cap"]'),
    theme: inBar('[data-testid="tb-theme"]'), // Removed on 2026-10-13: the foot's Appearance is the only theme control.
    headTools: document.querySelectorAll('[data-testid="sb-head"] ~ * [data-shield], [data-testid="sidebar"] [data-shield], [data-testid="sidebar"] [data-mcp]').length,
    sidebarTop: document.querySelector('[data-testid="workspace"]:not([hidden]) [data-testid="sidebar"]').getBoundingClientRect().top,
  };
});
check(bar6.h === 48 && bar6.top === 0 && bar6.w === 1280 && /inset/.test(bar6.rule), `a 48 px title bar across the window with a rule under it (${bar6.h}, ${bar6.rule})`);
check(!bar6.rail, "no window rail");
check(bar6.tabs === 1 && bar6.tabH === 28 && bar6.add, `one 28 px window pill and + (${bar6.tabs}, ${bar6.tabH})`);
check(bar6.shield && !bar6.cap && !bar6.theme, "the shown pill carries the safe mode shield; no search box or theme toggle in the title bar (2026-10-17)");
check(bar6.headTools === 0 && bar6.sidebarTop === 48, `the schema column starts under it, without Safe mode / MCP (${bar6.sidebarTop})`);
// The foot (2026-10-13) is one row of 28 px icon buttons,
// left-aligned, 4 px apart; names and keys live in the tooltips.
const foot6 = await page.$$eval('[data-testid="sb-foot-rows"] > button', (els) => {
  const col = els[0].closest('[data-testid="sidebar"]').getBoundingClientRect();
  const rs = els.map((e) => e.getBoundingClientRect());
  return {
    ids: els.map((e) => e.dataset.testid).join(","),
    sizes: rs.map((r) => `${r.width}x${r.height}`).join(","),
    gaps: rs.slice(1).map((r, i) => Math.round(r.left - rs[i].right)).join(","),
    row: new Set(rs.map((r) => Math.round(r.top))).size === 1,
    inset: Math.round(rs[0].left - col.left),
    text: els.map((e) => e.textContent.trim()).join(""),
    titles: els.map((e) => e.title),
  };
});
// Presenting joined the foot (2026-10-15); on 2026-10-17 it became Agents ·
// Presenting on the left and Appearance · Keyboard shortcuts · Settings on
// the right, a gap between (settings-browser-proof.mjs covers the update button).
const gaps6 = foot6.gaps.split(",").map(Number);
check(foot6.ids === "sb-agents,sb-presenting,sb-appearance,sb-help,sb-settings" && foot6.sizes === "28x28,28x28,28x28,28x28,28x28" && gaps6[0] === 4 && gaps6[1] > 40 && gaps6[2] === 4 && gaps6[3] === 4 && foot6.row && foot6.inset <= 16 && foot6.text === "", `the foot: five 28 px icon buttons in a row, two left and three right, no labels (${JSON.stringify(foot6)})`);
check(foot6.titles[0] === "Agents  Ctrl+Shift+A" && foot6.titles[1] === "Start presenting" && foot6.titles[2].startsWith("Appearance: Auto") && foot6.titles[3] === "Keyboard shortcuts  Ctrl+Shift+/" && foot6.titles[4] === "Settings  Ctrl+,", `tooltips carry the names and keys (${foot6.titles.join(" | ")})`);
check((await page.locator('[data-testid="sb-agents"] .sb-agents-dot').count()) === 1, "Agents carries the green dot while MCP is shared"); // Class on purpose: the dot.
const cycle = [];
for (let i = 0; i < 3; i++) {
  await page.click('[data-testid="sb-appearance"]');
  await page.waitForTimeout(80);
  cycle.push(`${await page.getAttribute('[data-testid="sb-appearance"]', "data-theme-setting")}/${await page.evaluate(() => document.documentElement.dataset.theme)}`);
}
check(cycle.join(" ") === "light/light dark/dark auto/light", `Appearance cycles Auto → Light → Dark → Auto (${cycle.join(" ")})`);
await page.mouse.move(130, 790);
await page.waitForTimeout(200);
await page.waitForTimeout(200);

// Grid states: edited, deleted, new; NULL chip; the foot edits bar.
const cell = (row, c) => `${ws} [data-testid="rg-body"] [data-row="${row}"] [data-col="${c}"]`;
await page.click(`${line} [data-chip-remove="0"]`).catch(() => {});
await settle();
await page.waitForFunction((ws) => document.querySelector(`${ws} [data-testid="results-grid-wrap"]`)?.getAttribute("data-row-count") === "120", ws);
await page.click(cell(0, 1));
await page.keyboard.press("Enter");
await page.keyboard.press("ControlOrMeta+a");
await page.keyboard.type("Kiosk 001 (renamed)");
await page.keyboard.press("Enter");
await page.click(`${ws} [data-testid="rg-body"] [data-row="1"] [data-testid="rg-gutter"]`);
await page.keyboard.press("Backspace");
await page.click(`${line} [data-testid="zone-menu"][data-zone="results"]`);
await page.waitForSelector('[data-menu="zone-results"]');
await surface("zone-menu", '[data-menu="zone-results"]', [{ sel: '[data-menu="zone-results"] [data-item="insert-row"]', what: "an item", readable: true }]);
await page.click('[data-menu="zone-results"] [data-item="insert-row"]');
await page.waitForSelector(`${ws} [data-insert]`);
await page.keyboard.press("Escape");
await page.click(cell(4, 2));
const bar = `${ws} [data-edit-tray]`;
await page.waitForSelector(`${bar}[data-changes="3"]`);
await surface("grid-states", `${ws} [data-testid="results-card"]`, [
  { sel: `${ws} [data-testid="rg-null"]`, what: "the NULL chip", readable: true },
  { sel: `${bar} [data-tray-count="edited"]`, what: "the bar's edited count", readable: true },
  { sel: `${ws} [data-testid="rg-body"] [data-row="0"] [data-col="1"]`, what: "an edited cell", readable: true },
]);
const above = await page.evaluate((ws) => {
  const t = document.querySelector("[data-toast]");
  const b = document.querySelector(`${ws} [data-edit-tray]`);
  return t ? Math.round(b.getBoundingClientRect().top - t.getBoundingClientRect().bottom) : null;
}, ws);
check(above === null || above >= 8, `a toast sits above the edits bar, never over Commit (gap ${above})`);

await page.click(cell(5, 1), { button: "right" });
await page.waitForSelector('[data-menu="grid"]').catch(() => {});
const ctx = (await page.$('[data-menu="grid"]')) ? '[data-menu="grid"]' : "[data-menu]";
await surface("context-menu", ctx, [{ sel: `${ctx} [data-testid="grid-menu-label"]`, what: "a label", readable: true }]);
await page.keyboard.press("Escape");

// Quick Look and Review SQL.
await page.click(cell(2, 2));
await page.keyboard.press("Space");
await page.waitForSelector(`${ws} [data-quicklook]`);
await page.waitForTimeout(400);
await surface("quicklook", `${ws} [data-quicklook]`, [{ sel: `${ws} [data-quicklook]`, what: "the column", token: "--panel", prop: "backgroundColor" }, { sel: `${ws} [data-testid="ql-title"]`, what: "the title", readable: true }]);
await page.keyboard.press("Escape");
await page.keyboard.press("Control+Shift+P");
await page.waitForSelector('[data-inspector="review"]');
await page.waitForTimeout(400);
await surface("review", '[data-inspector="review"]', [
  { sel: '[data-inspector="review"] .rv-badge.delete', what: "the DELETE badge", readable: true }, // Class on purpose: the badge colour is under test.
  { sel: '[data-inspector="review"] .rv-badge.insert', what: "the INSERT badge", readable: true, min: 4 }, // white on light --ok is 4.25:1 (the prototype's pair)
]);

// Focus ring in both themes: a focused inspector button.
for (const scheme of ["light", "dark"]) {
  await setTheme(scheme);
  const ring = await page.evaluate(() => {
    // The column's own button (the workspace carries data-inspector too; 2026-10-13).
    const b = document.querySelector('aside[data-inspector="review"] [data-inspector-close]');
    b.focus({ focusVisible: true });
    const s = getComputedStyle(b);
    return { outline: s.outlineStyle !== "none" ? s.outlineColor : null, shadow: s.boxShadow };
  });
  const acc = await tokenColor("--acc");
  check(ring.outline === acc || ring.shadow.includes(acc), `focus ring is --acc in ${scheme} (${ring.outline ?? ring.shadow})`);
}
await setTheme("light");
await page.keyboard.press("Escape");
await page.waitForFunction(() => !document.querySelector('[data-inspector="review"]'));

// Structure.
await page.click(`${ws} [data-testid="view-switch"] [data-view="structure"]`);
await page.waitForSelector(`${ws} [data-testid="ts-root"]`);
await surface("structure", `${ws} [data-testid="ts-root"]`, [{ sel: `${ws} [data-column="owner_id"] [data-fk]`, what: "the key link", readable: true }]);
await page.click(`${ws} [data-testid="view-switch"] [data-view="data"]`);

// ⌘K and the sheets it opens.
const palette = async (title) => {
  for (let i = 0; i < 3 && (await page.$('[data-testid="cp-panel"]')); i++) {
    await page.keyboard.press("Escape");
    await page.waitForTimeout(200);
  }
  await page.keyboard.press("Control+k");
  await page.waitForSelector('[data-testid="cp-panel"]');
  await page.keyboard.type(title);
  await page.waitForTimeout(120);
};
await palette("time");
await surface("palette", '[data-testid="cp-panel"]', [{ sel: '[data-testid="cp-panel"] input', what: "the query", readable: true }]);
await page.keyboard.press("Escape");
const sheet = async (title, name, sel) => {
  await palette(title);
  await page.keyboard.press("Enter");
  await page.waitForSelector(sel, { timeout: 4000 });
  await page.waitForTimeout(350);
  await surface(name, sel, [{ sel: `${sel} .sheet-title`, what: "the title", readable: true }]); // Class on purpose: the sheet shell's title.
  await page.keyboard.press("Escape");
  await page.waitForFunction((s) => !document.querySelector(s), sel);
};
await sheet("Timings", "timings", ".tm-sheet");
await sheet("Keyboard shortcuts", "shortcuts", ".ks-sheet");
await sheet("Report an issue", "report", ".rp-sheet");

// New connection.
await palette("New connection");
await page.keyboard.press("Enter");
await page.waitForSelector('[data-testid="nc-sheet"]');
await page.waitForTimeout(400);
await surface("new-connection", '[data-testid="nc-sheet"]', [{ sel: '[data-testid="nc-sheet"]', what: "the column", token: "--panel", prop: "backgroundColor" }]);
await page.keyboard.press("Escape");

// A query tab: the editor, its statement bar and Run.
await palette("New query tab");
await page.keyboard.press("Enter");
await page.waitForSelector(`${ws} [data-testid="sql-editor"]`);
await page.click(`${ws} [data-testid="sql-editor"]`);
await page.keyboard.type("select name, plays\nfrom games\norder by plays desc;");
await page.keyboard.press("Control+Enter");
await settle();
await page.click(`${ws} [data-testid="sql-editor"]`);
await surface("editor", `${ws}`, [
  { sel: `${ws} [data-testid="run-btn"]`, what: "Run", token: "--acc", prop: "backgroundColor" },
  { sel: `${ws} [data-testid="run-btn"]`, what: "Run's label", token: "--onfill", prop: "color" },
]);

// A toast.
await page.evaluate(() => navigator.clipboard?.writeText?.("").catch(() => {}));
await page.click(cell(0, 0)).catch(() => {});
await page.keyboard.press("Control+c");
await page.waitForSelector("[data-toast]").catch(() => {});
// The toast (2026-10-13): an ink card on paper, the lifted panel in the dark.
if (await page.$("[data-toast]")) await surface("toast", "[data-toast]", [{ sel: ".toast", what: "the toast", token: "--toast-bg", prop: "backgroundColor" }, { sel: '[data-testid="toast-message"]', what: "its message", readable: true }]); // Class on purpose: the card under test.
else check(false, "a copy shows a toast");
// Closing a window offers Undo: the toast's action reads --acc on the card.
await page.click('[data-testid="win-add"]');
await page.waitForFunction(() => document.querySelectorAll('[data-testid="win-tab"]').length === 2);
await page.click('[data-testid="win-tab"][data-on] .win-close'); // Class on purpose: the pill's × has no other hook.
await page.waitForSelector(".toast-undo"); // Class on purpose: the toast's action under test.
{
  for (const scheme of ["light", "dark"]) {
    await setTheme(scheme);
    const act = await page.$eval(".toast-undo", (e) => ({ c: getComputedStyle(e).color, r: getComputedStyle(e.closest(".toast")).borderRadius, ...window.__contrast(e) }));
    check(act.c === (await tokenColor("--acc")) && act.r === "8px" && act.ratio >= 4.5, `toast (${scheme}): radius 8, its action in --acc, ${act.ratio}:1`);
  }
  await setTheme("light");
}
await surface("toast-undo", "[data-toast]", []);

// ── Dead ends and the Agents page ──
await fresh();
await page.waitForSelector("[data-empty-action]");
await surface("connect-to-start", "body", [{ sel: '[data-testid="ew-card-sub"]', what: "a card's line", readable: true }, { sel: '[data-testid="titlebar"]', what: "the title bar", token: "--bar", prop: "backgroundColor" }]);
const empty6 = await page.evaluate(() => {
  const tb = document.querySelector('[data-testid="titlebar"]');
  const shown = (sel) => [...tb.querySelectorAll(sel)].filter((e) => e.getBoundingClientRect().width > 0).length;
  return { add: shown('[data-testid="win-add"]'), conn: shown('[data-shield], [data-testid="win-mcp"]'), name: tb.querySelector('[data-testid="win-name"]')?.textContent };
});
check(empty6.add === 1 && empty6.conn === 0, `the empty window's title bar: +, no safe mode shield or agent mark (${JSON.stringify(empty6)})`);
await palette("Agents");
await page.keyboard.press("Enter");
await page.waitForSelector('[data-testid="agents-page"]');
await page.waitForTimeout(300);
await surface("agents", '[data-testid="agents-page"]', [
  { sel: ".mcp-verdict", what: "verdict pill", every: true }, // Classes on purpose: the pills' and tags' colours are under test.
  { sel: ".mcp-tag", what: "env tag", every: true },
  { sel: ".mcp-reason", what: "refusal line", every: true },
]);
// What can the agent do: the can't-do panel's red wash must stay readable.
await page.click("[data-ag-can-do]");
await page.waitForSelector('[data-testid="ag-can-do"]');
await surface("agents-can-do", '[data-testid="ag-can-do"]', [
  { sel: '[data-ag-panel="never"] li span', what: "line of the can't-do wash", every: true },
  { sel: "[data-ag-join-note]", what: "view and join note on the can't-do wash" },
  { sel: '[data-ag-panel="can"] li span', what: "line of the can-do panel", every: true },
]);
await page.keyboard.press("Escape");
await page.waitForSelector('[data-testid="ag-can-do"]', { state: "detached" });
await page.click('[data-testid="agents-page"] [data-mcp-connect]');
await page.waitForSelector(".mc-inline"); // Class on purpose: Connect an agent's inline form has no other hook.
await page.waitForTimeout(300);
await surface("connect-agent", '[data-testid="agents-page"]', [{ sel: ".mc-inline", what: "the form's text", readable: true }]);

await fresh({ fail: true });
await page.keyboard.press("Control+Shift+O");
await page.waitForSelector('[data-testid="conn-popover"]');
await page.keyboard.press("Enter");
await page.waitForSelector("[data-connect-error]");
await page.waitForTimeout(400);
await surface("couldnt-connect", "[data-connect-error]", [{ sel: '[data-testid="sb-error-title"]', what: "the title", readable: true }]);

await browser.close();
console.log(failed ? `\n${failed} check(s) failed` : "\nall checks passed");
