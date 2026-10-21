#!/usr/bin/env node
// The launch fixes (2026-10-13).
// Stubbed `invoke`, Linux keys, 1280 × 800. Proves, one block per fix:
//  1. The switch-connection and database pickers float above every column:
//     opened from the schema head with the Agents page up, the popover's
//     right edge is on top (not under the page), whole and in the window.
//  2. Holding Ctrl shows the key hints as 12 px mono keycaps; no two
//     [data-key-hint] rects intersect (8 px apart), with two windows open,
//     on a table tab and on the empty window.
//  3. The grid's and the editor's key strips stay while shown, focus or
//     not: 12.5 px, 50% opacity rising to 100% on hover, the grid's centred
//     at the grid's foot above the horizontal scrollbar; keys from the registry.
//  4. The chip editor's column list on a 40-column table stops at
//     min(420 px, the room) and scrolls itself; a wheel over it never moves
//     the grid, and a wheel elsewhere closes it without moving the grid.
//  5. A cell edited and then left by a click elsewhere keeps its value as a
//     pending edit (edited dot, the foot bar counts it); clicking away from
//     an unchanged value stages nothing; Esc inside the cell reverts it.
//  6. Every panel resizes by drag, with a 6 px col- / row-resize edge that
//     turns --acc while dragged, saves to config.json (persist.ts) and resets
//     on double-click: the schema column (240–360), the inspector column
//     (320 px to 60% of the window) and a query tab's editor / results
//     split (the editor keeps 80 px).
//  7. Esc on a selected cell only leaves the selection; Esc again with
//     pending edits, no cell open and nothing running, discards
//     them all with "Discarded N edits" and Undo, which brings them back;
//     Esc inside a cell only reverts that cell (checked in 5).
//  8. The schema head names the database in Plex with its chevron
//     opening the database switcher; the sub-line keeps host · latency · env;
//     the connection switcher still opens on ⇧⌘O.
//
//   cd apps/rowkery-tauri && npx vite --port 1420 &
//   node scripts/launch-fixes-browser-proof.mjs [outDir]
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
const OUT = process.argv[2] ?? "/tmp/rowkery-proof/launch-fixes";
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
    // A wide table: its column list is longer than the window.
    table("wide", [id, ...Array.from({ length: 40 }, (_, i) => col(`field_${String(i + 1).padStart(2, "0")}`, "text"))], 80),
  ];
  const wire = {
    kiosks: [
      { name: "id", type_name: "int8" },
      { name: "name", type_name: "text" },
      { name: "city", type_name: "text" },
      { name: "owner_id", type_name: "int8" },
    ],
    wide: [{ name: "id", type_name: "int8" }, ...Array.from({ length: 40 }, (_, i) => ({ name: `field_${String(i + 1).padStart(2, "0")}`, type_name: "text" }))],
    owners: [
      { name: "id", type_name: "int8" },
      { name: "name", type_name: "text" },
    ],
  };
  const CITIES = ["Petaling Jaya", "Kuala Lumpur", "Shah Alam", "Subang Jaya", "Klang"];
  const rowOf = (t, n) =>
    t === "wide"
      ? [{ Int: n }, ...Array.from({ length: 40 }, (_, i) => ({ Text: `v${n}.${i + 1}` }))]
      : t === "owners"
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
          const total = t === "owners" ? 40 : t === "wide" ? 80 : 120;
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

const connect = async () => {
  await page.keyboard.press("Control+Shift+O");
  await page.waitForSelector('[data-testid="conn-popover"]');
  await page.keyboard.press("Enter");
  await page.waitForSelector(`${ws}[data-conn-state="connected"]`);
  await page.click(`${ws} [data-table="rowkery.public.kiosks"] [data-testid="sb-row-main"]`);
  await page.waitForFunction((ws) => document.querySelector(`${ws} [data-testid="results-grid-wrap"]`)?.getAttribute("data-row-count") === "120", ws);
  await settle();
};
await fresh();
await connect();

// 1 · The pickers float above the Agents page.
await page.keyboard.press("Control+Shift+A");
await page.waitForSelector('[data-testid="agents-page"]');
await page.waitForTimeout(300);
await page.keyboard.press("Control+Shift+O");
await page.waitForSelector('[data-testid="conn-popover"]');
await page.waitForTimeout(250);
const onTop1 = await page.evaluate(() => {
  const pop = document.querySelector('[data-testid="conn-popover"]');
  const r = pop.getBoundingClientRect();
  const pts = [[r.right - 6, r.top + 20], [r.right - 6, r.bottom - 12], [r.left + 12, r.top + 20]];
  return { hits: pts.map(([x, y]) => pop.contains(document.elementFromPoint(x, y))), right: Math.round(r.right), w: Math.round(r.width), floating: !!pop.closest("[data-floating]") };
});
check(onTop1.hits.every(Boolean) && onTop1.right <= 1280 && onTop1.floating, `the connection picker floats above the Agents page, whole (${JSON.stringify(onTop1)})`);
await page.screenshot({ path: `${OUT}/1-picker-over-agents.png` });
await page.keyboard.press("Escape");
await page.waitForFunction(() => !document.querySelector('[data-testid="conn-popover"]'));
await page.keyboard.press("Control+Shift+A"); // back to the window
await page.waitForFunction(() => !document.querySelector('[data-testid="agents-page"]'));
// The database picker, over the Quick Look column.
await page.click(`${ws} [data-testid="rg-body"] [data-row="1"] [data-col="1"]`);
await page.keyboard.press("Space");
await page.waitForSelector(`${ws} [data-quicklook]`);
await page.keyboard.press("Control+Shift+D");
await page.waitForSelector('[data-testid="db-popover"]').catch(() => {});
const db1 = await page.evaluate(() => {
  const pop = document.querySelector('[data-testid="db-popover"]');
  if (!pop) return null;
  const r = pop.getBoundingClientRect();
  return { hit: pop.contains(document.elementFromPoint(r.right - 6, r.top + 20)), floating: !!pop.closest("[data-floating]") };
});
check(db1 && db1.hit && db1.floating, `the database picker floats too (${JSON.stringify(db1)})`);
await page.keyboard.press("Escape");
await page.keyboard.press("Escape");

// 2 · Key hints: each in its own place.
const hints = async (label) => {
  await page.mouse.move(640, 500);
  await page.keyboard.down("Control");
  await page.waitForSelector("[data-key-hint]");
  await page.waitForTimeout(250);
  const r = await page.$$eval("[data-key-hint]", (els) => {
    const rs = els.map((e) => ({ t: e.textContent, ...JSON.parse(JSON.stringify(e.getBoundingClientRect())) }));
    const bad = [];
    let minGap = Infinity;
    for (let i = 0; i < rs.length; i++)
      for (let j = i + 1; j < rs.length; j++) {
        const a = rs[i], b = rs[j];
        const gx = Math.max(b.left - a.right, a.left - b.right);
        const gy = Math.max(b.top - a.bottom, a.top - b.bottom);
        const gap = Math.max(gx, gy);
        minGap = Math.min(minGap, gap);
        if (gap < 0) bad.push(`${a.t}×${b.t}`);
      }
    const s = getComputedStyle(els[0]);
    return { n: rs.length, bad, at: bad.length ? rs.map((r) => `${r.t}@${Math.round(r.left)},${Math.round(r.top)}`).join(" ") : "", minGap: Math.round(minGap), font: `${s.fontSize} ${s.fontFamily.split(",")[0]}` };
  });
  await page.screenshot({ path: `${OUT}/2-hints-${label}.png` });
  await page.keyboard.up("Control");
  await page.waitForFunction(() => !document.querySelector("[data-key-hint]"), null, { timeout: 2000 }).catch(() => {});
  return r;
};
await page.keyboard.press("Escape"); // Quick Look
await page.keyboard.press("Control+t");
await page.waitForSelector("[data-empty-window]");
const h1 = await hints("empty");
check(h1.n >= 2 && h1.bad.length === 0, `empty window: ${h1.n} hints, none overlapping (min gap ${h1.minGap} px; ${h1.bad.join(", ")})`);
await page.keyboard.press("Control+1");
await page.waitForSelector(`${ws}[data-conn-state="connected"]`);
await page.waitForTimeout(300);
const h2 = await hints("table");
check(h2.n >= 6 && h2.bad.length === 0 && h2.minGap >= 8, `table tab: ${h2.n} hints, none overlapping, ≥ 8 px apart (min gap ${h2.minGap} px; ${h2.bad.join(", ")} ${h2.at})`);
check(/^12px/.test(h2.font) && /Mono/.test(h2.font), `12 px mono keycaps (${h2.font})`);

// 3 · Persistent key strips.
await page.keyboard.press("Escape"); // Quick Look, if open
await page.click(`${ws} [data-testid="sb-filter"] input`); // focus away from the grid
await page.keyboard.press("Escape");
await page.waitForTimeout(250);
const strip = `${ws} [data-key-strip="grid"]`;
const g3 = await page.evaluate((sel) => {
  const e = document.querySelector(sel);
  if (!e) return null;
  const r = e.getBoundingClientRect();
  const wrap = e.closest('[data-testid="results-card"]')?.querySelector('[data-testid="results-grid-wrap"]') ?? document.querySelector('[data-testid="workspace"]:not([hidden]) [data-testid="results-grid-wrap"]');
  const w = wrap.getBoundingClientRect();
  const s = getComputedStyle(e);
  return { size: s.fontSize, op: s.opacity, mid: Math.round(r.left + r.width / 2 - (w.left + w.width / 2)), gapBottom: Math.round(w.bottom - r.bottom), text: e.textContent };
}, strip);
check(g3 && g3.size === "12.5px" && g3.op === "0.5" && Math.abs(g3.mid) <= 2 && g3.gapBottom >= 12, `the grid's strip stays without focus: 12.5 px at 50%, centred, ${g3?.gapBottom} px above the grid's foot (${JSON.stringify(g3)})`);
check(/Ctrl\+F/.test(g3?.text ?? "") && /Ctrl\+C/.test(g3?.text ?? ""), "its keys come from the registry (Ctrl+F filter, Ctrl+C copy)");
await page.hover(strip);
await page.waitForTimeout(300);
check((await page.$eval(strip, (e) => getComputedStyle(e).opacity)) === "1", "hover lifts it to 100%");
await page.screenshot({ path: `${OUT}/3-grid-strip.png` });
await page.mouse.move(640, 300);
// The editor's, on a query tab.
await page.keyboard.press("Control+k");
await page.keyboard.type("New query tab");
await page.waitForTimeout(120);
await page.keyboard.press("Enter");
await page.waitForSelector(`${ws} [data-testid="sql-editor"]`);
await page.click(`${ws} [data-testid="sb-filter"] input`);
await page.keyboard.press("Escape");
await page.waitForTimeout(250);
const e3 = await page.$eval(`${ws} [data-key-strip="editor"]`, (e) => ({ size: getComputedStyle(e).fontSize, op: getComputedStyle(e).opacity })).catch(() => null);
check(e3 && e3.size === "12.5px" && e3.op === "0.5", `the editor's strip stays too (${JSON.stringify(e3)})`);

// 4 · The column list scrolls itself.
await page.click(`${ws} [data-table="rowkery.public.wide"] [data-testid="sb-row-main"]`);
await page.waitForFunction((ws) => document.querySelector(`${ws} [data-testid="results-grid-wrap"]`)?.getAttribute("data-row-count") === "80", ws);
await settle();
const gridScroll = () => page.$eval(`${ws} [data-testid="results-grid-wrap"]`, (e) => { const sc = e.querySelector("[data-testid='rg-body']")?.closest("[class*='scroll']") ?? e; return [...e.querySelectorAll("*")].concat(e).filter((n) => n.scrollHeight > n.clientHeight + 4 || n.scrollWidth > n.clientWidth + 4).map((n) => `${n.scrollTop},${n.scrollLeft}`).join("|"); });
await page.keyboard.press("Control+f");
await page.waitForSelector(`${line} [data-chip-editor]`);
await page.click(`${line} [data-chip-column]`);
await page.waitForSelector('[data-menu="chip-column"]');
await page.waitForTimeout(200);
const m4 = await page.$eval('[data-menu="chip-column"]', (e) => ({ h: Math.round(e.getBoundingClientRect().height), sh: e.scrollHeight, ch: e.clientHeight, bottom: Math.round(e.getBoundingClientRect().bottom), oy: getComputedStyle(e).overflowY }));
check(m4.h <= 420 && m4.sh > m4.ch && m4.bottom <= 800 - 8 && m4.oy === "auto", `the column list stops at ${m4.h} px and scrolls itself (${JSON.stringify(m4)})`);
const before4 = await gridScroll();
const box4 = await page.locator('[data-menu="chip-column"]').boundingBox();
await page.mouse.move(box4.x + box4.width / 2, box4.y + box4.height / 2);
for (let i = 0; i < 6; i++) await page.mouse.wheel(0, 400);
await page.waitForTimeout(250);
const menuTop = await page.$eval('[data-menu="chip-column"]', (e) => e.scrollTop).catch(() => -1);
check(menuTop > 0 && (await gridScroll()) === before4, `a wheel over it scrolls the list (${menuTop} px), not the grid`);
await page.screenshot({ path: `${OUT}/4-column-list.png` });
await page.mouse.move(900, 600);
await page.mouse.wheel(0, 400);
await page.waitForTimeout(300);
check(!(await page.$('[data-menu="chip-column"]:not([data-closing] *)')) && (await gridScroll()) === before4, "a wheel elsewhere closes it without moving the grid");
await page.keyboard.press("Escape");

// 5 · Clicking away keeps the edit.
await page.click(`${ws} [data-table="rowkery.public.kiosks"] [data-testid="sb-row-main"]`);
await page.waitForFunction((ws) => document.querySelector(`${ws} [data-testid="results-grid-wrap"]`)?.getAttribute("data-row-count") === "120", ws);
await settle();
const cell5 = (r, c) => `${ws} [data-testid="rg-body"] [data-row="${r}"] [data-col="${c}"]`;
const edit5 = async (r, c, text, leave) => {
  await page.click(cell5(r, c));
  await page.keyboard.press("Enter");
  await page.waitForSelector(`${ws} [data-cell-editor]`);
  await page.keyboard.press("ControlOrMeta+a");
  if (text !== null) await page.keyboard.type(text);
  await leave();
  await page.waitForFunction((ws) => !document.querySelector(`${ws} [data-cell-editor]`), ws);
  await page.waitForTimeout(150);
};
const clickAway = () => page.click(`${ws} [data-testid="sb-filter"] input`);
await edit5(3, 1, "Kiosk 004 (moved)", clickAway);
const after5 = await page.evaluate((ws) => ({
  mark: document.querySelector(`${ws} [data-testid="rg-body"] [data-row="3"]`)?.getAttribute("data-mark"),
  text: document.querySelector(`${ws} [data-testid="rg-body"] [data-row="3"] [data-col="1"]`)?.textContent,
  bar: document.querySelector(`${ws} [data-edit-tray]`)?.getAttribute("data-changes"),
  focus: document.activeElement?.getAttribute("aria-label"),
}), ws);
check(after5.text === "Kiosk 004 (moved)" && after5.bar === "1" && after5.focus === "Filter tables", `clicking away keeps it as a pending edit, focus where it went (${JSON.stringify(after5)})`);
await page.screenshot({ path: `${OUT}/5-blur-kept.png` });
await edit5(4, 1, "Kiosk 005", clickAway); // the same text it had
check((await page.getAttribute(`${ws} [data-edit-tray]`, "data-changes")) === "1", "an unchanged value stages nothing");
await edit5(5, 1, "Kiosk 006 typo", () => page.keyboard.press("Escape"));
const esc5 = await page.evaluate((ws) => ({ text: document.querySelector(`${ws} [data-testid="rg-body"] [data-row="5"] [data-col="1"]`)?.textContent, bar: document.querySelector(`${ws} [data-edit-tray]`)?.getAttribute("data-changes") }), ws);
check(esc5.text === "Kiosk 006" && esc5.bar === "1", `Esc in the cell reverts it (${JSON.stringify(esc5)})`);

// 6 · Resizers.
const saved = (k) => page.evaluate((k) => JSON.parse(localStorage.getItem(k) ?? "null"), k);
const drag6 = async (sel, dx, dy, during) => {
  const b = await page.locator(sel).first().boundingBox();
  const x = b.x + b.width / 2, y = b.y + b.height / 2;
  await page.mouse.move(x, y);
  await page.mouse.down();
  for (let i = 1; i <= 8; i++) await page.mouse.move(x + (dx * i) / 8, y + (dy * i) / 8);
  const mid = during ? await page.evaluate(during) : null;
  await page.mouse.up();
  await page.waitForTimeout(1300); // persist.ts writes within a second
  return mid;
};
// The schema column.
const edge = await page.$eval("[data-panel-resizer]", (e) => ({ w: e.getBoundingClientRect().width, c: getComputedStyle(e).cursor }));
const accLine = await tokenColor("--acc");
const panelMid = await drag6("[data-panel-resizer]", 60, 0, () => getComputedStyle(document.querySelector("[data-panel-resizer]"), "::after").backgroundColor);
const panelW = await page.$eval(`${ws} [data-testid="sidebar"]`, (e) => Math.round(e.getBoundingClientRect().width));
check(edge.w === 6 && edge.c === "col-resize" && panelMid === accLine && panelW === 324 && (await saved("rowkery.panelWidth")) === 324, `the schema column drags to ${panelW} px on a 6 px col-resize edge, orange while dragged, saved (${JSON.stringify(edge)}, ${panelMid})`);
await page.dblclick("[data-panel-resizer]");
await page.waitForTimeout(1300);
check((await page.$eval(`${ws} [data-testid="sidebar"]`, (e) => Math.round(e.getBoundingClientRect().width))) === 264 && (await saved("rowkery.panelWidth")) === 264, "double-click resets it to 264");
// The inspector column (Quick Look).
await page.click(cell5(8, 2));
await page.keyboard.press("Space");
await page.waitForSelector(`${ws} [data-quicklook]`);
await page.waitForTimeout(300);
const iedge = await page.$eval(`${ws} [data-testid="insp-resize"]`, (e) => ({ w: e.getBoundingClientRect().width, c: getComputedStyle(e).cursor }));
const inspMid = await drag6(`${ws} [data-testid="insp-resize"]`, -100, 0, () => getComputedStyle(document.querySelector('[data-testid="workspace"]:not([hidden]) [data-testid="insp-resize"]'), "::after").backgroundColor);
const qlW = () => page.$eval(`${ws} [data-quicklook]`, (e) => Math.round(e.getBoundingClientRect().width));
const gridEnd = await page.evaluate((ws) => Math.round(document.querySelector(`${ws} [data-testid="results-grid-wrap"]`).getBoundingClientRect().right), ws);
check(iedge.w === 6 && iedge.c === "col-resize" && inspMid === accLine && (await qlW()) === 440 && gridEnd === 1280 - 440 && (await saved("rowkery.inspectorWidth.quicklook")) === 440, `the inspector drags to ${await qlW()} px and the grid gives the room (ends at ${gridEnd}), saved`);
await drag6(`${ws} [data-testid="insp-resize"]`, 400, 0);
check((await qlW()) === 320, `it stops at 320 px (${await qlW()})`);
await drag6(`${ws} [data-testid="insp-resize"]`, -900, 0);
check((await qlW()) === 768, `and at 60% of the window, 768 px (${await qlW()})`);
await page.dblclick(`${ws} [data-testid="insp-resize"]`);
await page.waitForTimeout(1300);
check((await qlW()) === 340 && (await saved("rowkery.inspectorWidth.quicklook")) === null, `double-click resets it to 340 (${await qlW()})`);
await page.keyboard.press("Escape");
// The editor / results split on a query tab.
await page.click(`${ws} [data-testid="query-tab"]`);
await page.waitForSelector(`${ws} [data-testid="sql-editor"]`);
await page.click(`${ws} [data-testid="sql-editor"]`);
await page.keyboard.type("select 1;");
await page.keyboard.press("Control+Enter");
await settle();
const split = `${ws} [data-testid="pane-splitter"]`;
const sedge = await page.$eval(split, (e) => ({ h: e.getBoundingClientRect().height, c: getComputedStyle(e).cursor }));
const splitMid = await drag6(split, 0, -600, () => document.querySelector('[data-testid="workspace"]:not([hidden]) [data-testid="pane-splitter"]').hasAttribute("data-dragging"));
const edH = await page.$eval(`${ws} [data-testid="editor-card"]`, (e) => Math.round(e.getBoundingClientRect().height)).catch(async () => page.$eval(`${ws} .editor-card`, (e) => Math.round(e.getBoundingClientRect().height))); // Class fallback: the editor card's box.
check(sedge.h === 6 && sedge.c === "row-resize" && splitMid && edH >= 80 && edH <= 120 && typeof (await saved("rowkery.editorSplit")) === "number", `the split drags up until the editor keeps ${edH} px (≥ 80), saved (${JSON.stringify(sedge)})`);
await page.dblclick(split);
await page.waitForTimeout(1300);
check((await saved("rowkery.editorSplit")) === null, "double-click resets the split");
await page.screenshot({ path: `${OUT}/6-resized.png` });

// 7 · Esc discards pending edits, with Undo.
await page.click(`${ws} [data-testid="query-tab"][data-reorder-key]:has([data-testid="query-tab-title"]:text-is("kiosks")), ${ws} [data-testid="query-tab"]:has-text("kiosks")`).catch(() => {});
await page.waitForFunction((ws) => document.querySelector(`${ws} [data-testid="results-grid-wrap"]`)?.getAttribute("data-row-count") === "120", ws);
await settle();
const bar7 = () => page.getAttribute(`${ws} [data-edit-tray]`, "data-changes").catch(() => null);
await edit5(10, 1, "Kiosk 011 (moved)", () => page.keyboard.press("Enter"));
const n7 = await bar7();
await page.click(cell5(15, 3)); // a cell with nothing staged
await page.keyboard.press("Escape"); // leaves the selection only
await page.waitForTimeout(200);
const kept7 = await page.evaluate((ws) => !document.querySelector(`${ws} [data-testid="rg-body"] [data-active]`), ws);
check((await bar7()) === n7 && kept7, `the first Esc only leaves the selection; the ${await bar7()} edits stay`);
await page.keyboard.press("Escape");
await page.waitForSelector("[data-toast]");
const toast7 = await page.$eval("[data-toast]", (e) => e.textContent);
await page.waitForTimeout(200);
const gone7 = await page.evaluate((ws) => !document.querySelector(`${ws} [data-edit-tray]:not([data-closing] *)`) && !document.querySelector(`${ws} [data-testid="rg-body"] [data-mark]`), ws);
check(Number(n7) >= 2 && /^Discarded \d+ edits/.test(toast7) && toast7.includes(`Discarded ${n7} edits`) && gone7, `Esc discards the ${n7} pending edits ("${toast7}")`);
await page.screenshot({ path: `${OUT}/7-esc-discarded.png` });
await page.click("[data-toast-undo]");
await page.waitForTimeout(300);
check((await bar7()) === n7, `Undo brings them back (${await bar7()})`);

// 8 · The head names the database.
const h8 = await page.evaluate((ws) => {
  const head = document.querySelector(`${ws} [data-testid="sb-head-switch"]`);
  const chip = head.querySelector('[data-testid="db-chip"]');
  return { text: head.innerText.trim(), font: getComputedStyle(chip).fontFamily.split(",")[0], size: getComputedStyle(chip).fontSize, chevron: !!chip.querySelector("svg"), sub: document.querySelector(`${ws} [data-sb-sub]`).textContent };
}, ws);
check(h8.text === "rowkery" && /IBM Plex Sans/.test(h8.font) && h8.size === "17px" && h8.chevron && h8.sub === "prd.arcade.internal:5432", `the head: the database in Plex with its ▾, the host below (${JSON.stringify(h8)})`);
await page.click(`${ws} [data-testid="sb-head-switch"] [data-testid="db-chip"]`);
check(!!(await page.waitForSelector('[data-testid="db-popover"]', { timeout: 2000 }).catch(() => null)), "its chevron opens the database switcher");
await page.keyboard.press("Escape");
await page.waitForTimeout(200);
await page.keyboard.press("Control+Shift+O");
check(!!(await page.waitForSelector('[data-testid="conn-popover"]', { timeout: 2000 }).catch(() => null)), "⇧⌘O still opens the connection switcher");
await page.keyboard.press("Escape");
await page.screenshot({ path: `${OUT}/8-head.png` });

await browser.close();
console.log(failed ? `\n${failed} check(s) failed` : "\nall checks passed");
