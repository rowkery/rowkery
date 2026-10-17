#!/usr/bin/env node
// Paper start surfaces (stubbed `invoke`; the Paper decision, 2026-10-10):
// Connect to start, Couldn't connect, the
// Agents page, the Paper sheets and the query tab's Results row.
//
// Proves that a window with no connection hides the schema column (the main
// column spans the window under the title bar) and shows the penguin beside the
// "Connect to start" heading, the four bordered cards with their registry
// keys, Your connections and Found on this Mac (macOS); that each card runs
// its command (New connection opens the form, ⌘O's file becomes a
// connection, the paste card fills the form from the clipboard, the sample
// opens); that a saved row connects the window and the schema column comes
// back; that a failed connect shows Couldn't connect in the same column with
// the penguin Tilted (in --del) and Retry · Edit… · Report…; that the Agents
// page renders in light and dark with its ruled columns; that Timings,
// Shortcuts and Connect an agent open as Paper sheets (radius 8, --pop
// shadow, the title, esc) and close with Esc; and that a query tab's
// Results row has the count and a bordered Export that runs the registry's
// export command (export_results).
//
// Screenshots (the review set): desktop.png (Connect to start, light),
// dark.png, failed.png, agents.png, agents-dark.png, timings.png,
// shortcuts.png, connect-agent.png, results-export.png.
//
//   cd apps/rowkery-tauri && npx vite --port 1420 &
//   node scripts/paper-start-browser-proof.mjs [outDir]
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
const OUT = process.argv[2] ?? "/tmp/rowkery-proof/paper-start";
const URL = process.env.ROWKERY_DEV_URL ?? "http://localhost:1420/";
const FRAMES_SHIM = new globalThis.URL("./lib/frames-shim.js", import.meta.url).pathname;
mkdirSync(OUT, { recursive: true });

function stubTauri(opts) {
  localStorage.clear();
  window.__CALLS__ = [];
  if (opts.mac) Object.defineProperty(navigator, "platform", { get: () => "MacIntel" });
  const sample = { kind: "sqlite", id: "sample", name: "Sample database", path: "/Users/me/Library/Application Support/Rowkery/sample.sqlite", sample: true };
  const pg = (id, name, host, environment, allow) => ({ kind: "postgres", id, name, host, port: 5432, database: name.split("-")[0], username: "alice", environment, allow_mcp: allow });
  window.__CONNS__ = [sample, pg("prd", "arcade-prd", "db.arcade.internal", "prd", true), pg("stg", "arcade-stg", "stg.arcade.internal", "stg", false), pg("dev", "wallet-dev", "10.0.12.7", "dev", true)];
  const col = (name, type_name = "int8") => ({ name, type_name, nullable: false });
  const tables = ["games", "kiosks", "players"].map((name, i) => ({
    name,
    kind: "table",
    columns: [col("id"), col("name", "text")],
    primary_key: ["id"],
    indexes: [],
    foreign_keys: [],
    row_estimate: { Exact: 120 * (i + 1) },
    partition_of: null,
  }));
  const t0 = Date.now();
  const base = { session: t0 - 150_000, client: "claude-code" };
  const log = [
    { ...base, ts: t0 - 140_000, tool: "list_connections", rows: 2, ms: 1, verdict: "ok" },
    { ...base, ts: t0 - 110_000, tool: "query", connection: "prd", database: "arcade", sql: "select status, count(*) from payouts group by status", rows: 4, ms: 61, verdict: "ok" },
    { ...base, ts: t0 - 80_000, tool: "query", connection: "dev", database: "wallet", sql: "select * from wallet_transactions where payload::text like '%failed%'", verdict: "Refused: the plan reads public.wallet_transactions (~412880 rows) end to end." },
    { ...base, ts: t0 - 20_000, tool: "query", connection: "dev", database: "wallet", sql: "select migration, batch from migrations order by batch", rows: 15, ms: 4, verdict: "ok" },
  ];
  window.__TAURI_INTERNALS__ = {
    metadata: { currentWindow: { label: "main" }, currentWebview: { label: "main" } },
    transformCallback: () => 0,
    invoke: async (cmd, args) => {
      if (cmd !== "mcp_activity") window.__CALLS__.push([cmd, args && { ...args, onFrame: undefined }]);
      switch (cmd) {
        case "list_connections":
          return { connections: structuredClone(window.__CONNS__), active_connection_id: null };
        case "open_window":
          if (opts.fail && args.connectionId === "prd") throw "Connection refused (os error 61)";
          return { database: "arcade", catalog: { databases: [{ name: "arcade", schemas: [{ name: "public", tables }] }] }, elapsed_ms: 12, cached: false, open_seq: 1 };
        case "explain_connect_error":
          return { class: "refused", cause: "Nothing is listening on db.arcade.internal:5432.", field: null };
        case "open_sample":
          return sample;
        case "save_connection":
          window.__CONNS__ = [...window.__CONNS__.filter((c) => c.id !== args.connection.id), args.connection];
          return null;
        case "choose_file":
          return "/Users/me/data/shop.db";
        case "read_clipboard_text":
          return "postgres://alice@stg.arcade.internal:5432/arcade";
        case "probe_local_servers":
          return [{ port: 5432, user: "alice" }];
        case "probe_connection":
          return { ok: true, message: "PostgreSQL 16.4", elapsed_ms: 3 };
        case "mcp_activity":
          return { entries: structuredClone(log), offset: log.length, reset: true };
        case "mcp_connect_check":
          return {
            client: args.client,
            state: "ready",
            preview: "claude mcp add --scope user rowkery -- /Applications/Rowkery.app/Contents/MacOS/Rowkery --mcp",
            copy: "claude mcp add --scope user rowkery -- /Applications/Rowkery.app/Contents/MacOS/Rowkery --mcp",
            existing: null,
            config_file: null,
            problem: null,
          };
        case "run_query":
          return {
            columns: [{ name: "name", type_name: "text" }, { name: "plays", type_name: "int8" }],
            rows: [["Pac-Man", 412], ["Galaga", 377], ["Tetris", 351], ["Asteroids", 290]].map(([n, p]) => [{ Text: n }, { Int: p }]),
            row_count: 4,
            elapsed_ms: 7,
            error: null,
            cancelled: false,
          };
        case "export_results":
          return null; // the save dialog, dismissed
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
let page;
const fresh = async (opts = {}) => {
  if (page) await page.close();
  page = await browser.newPage({ viewport: { width: 1280, height: 800 }, deviceScaleFactor: 2, colorScheme: opts.dark ? "dark" : "light" });
  page.on("pageerror", (e) => console.error("pageerror:", e.message));
  await page.addInitScript({ path: FRAMES_SHIM });
  await page.addInitScript(stubTauri, opts);
  await page.goto(URL);
  await page.waitForSelector(`${ws} [data-empty-window]`);
};
const calls = (cmd) => page.evaluate((c) => window.__CALLS__.filter(([x]) => x === c).map(([, a]) => a), cmd);
const visible = (sel) => page.isVisible(sel).catch(() => false);
const shot = async (name) => {
  await page.waitForTimeout(350);
  await page.screenshot({ path: `${OUT}/${name}.png` });
  console.log(`${OUT}/${name}.png`);
};
const box = (sel) => page.$eval(sel, (e) => e.getBoundingClientRect().toJSON());
const colorOf = (v) =>
  page.evaluate((v) => {
    const p = document.createElement("span");
    p.style.color = `var(${v})`;
    document.body.append(p);
    const c = getComputedStyle(p).color;
    p.remove();
    return c;
  }, v);

// 1 · Connect to start, light and dark: no schema column, the column, cards.
for (const dark of [false, true]) {
  await fresh({ mac: true, dark });
  await page.waitForSelector("[data-found-section]");
  await page.waitForTimeout(400); // the column's rise settles
  const theme = await page.evaluate(() => document.documentElement.dataset.theme);
  check(theme === (dark ? "dark" : "light"), `${theme}: the theme follows the system`);
  check(!(await visible(`${ws} [data-testid="sidebar"]`)), `${theme}: no schema column while the window has no connection`);
  // The main column spans the window under the title bar.
  check(await visible('[data-testid="titlebar"]'), `${theme}: the title bar stays`);
  const main = await box(`${ws} [data-testid="main"]`);
  check(main.left === 0 && main.right === 1280 && main.top === 48, `${theme}: the main column spans the window under the 48 px title bar (${main.left}–${main.right} at ${main.top})`);
  const col = await page.$eval(`${ws} [data-empty-window] .ew-block`, (e) => ({ w: e.getBoundingClientRect().width, top: e.getBoundingClientRect().top })); // Class on purpose: the 560 px column under test.
  check(col.w === 560 && Math.round(col.top) === 48 + 42 + 88, `${theme}: one 560 px column, 88 px under the tab row (${col.w} at ${col.top})`);
  const title = await page.$eval('[data-testid="ew-title"]', (e) => ({ t: e.textContent, f: getComputedStyle(e).fontFamily, s: getComputedStyle(e).fontSize, w: getComputedStyle(e).fontWeight }));
  check(title.t === "Connect to start" && /IBM Plex Sans/.test(title.f) && title.s === "30px" && title.w === "600", `${theme}: the Plex 30/600 heading (${title.s} ${title.w})`);
  check((await page.textContent('[data-testid="ew-sub"]')) === "Nothing connects until you choose.", `${theme}: its one line`);
  const penguin = await page.$eval(`${ws} [data-empty-window] svg[data-pose="ready"]`, (e) => ({ w: e.getBoundingClientRect().width, c: getComputedStyle(e).color }));
  check(penguin.w === 64 && penguin.c === (await colorOf("--mute")), `${theme}: the penguin stands Ready at 64 px in --mute`);
  const cards = await page.$$eval("[data-empty-action]", (els) =>
    els.map((e) => {
      const cs = getComputedStyle(e);
      return { id: e.dataset.emptyAction, sub: e.querySelector('[data-testid="ew-card-sub"]').textContent, key: e.querySelector("kbd").textContent, border: cs.borderTopWidth, radius: cs.borderTopLeftRadius, w: e.getBoundingClientRect().width };
    }),
  );
  const cardText = cards.map((c) => `${c.id}:${c.sub}:${c.key}`).join(" | ");
  check(cardText === "new:Postgres or SQLite:⌘N | file:or drop one anywhere:⌘O | paste:fills the form for you:⌘V | sample:six tables, one view:↵", `${theme}: four cards with sub-lines and registry keys (${cardText})`);
  check(cards.every((c) => c.border === "1px" && c.radius === "8px" && Math.abs(c.w - 275) < 1), `${theme}: bordered 1 px, radius 8, two by two`);
  const sections = await page.$$eval('[data-testid="ew-section"]', (els) => els.map((e) => e.textContent));
  check(sections.join() === "Your connections,Found on this Mac", `${theme}: Your connections, then Found on this Mac`);
  check((await page.$$("[data-saved-conn]")).length === 4 && (await page.textContent('[data-saved-conn="prd"]')).includes("Connect ↵"), `${theme}: saved rows print Connect ↵`);
  const savedH = await page.$eval('[data-saved-conn="prd"]', (e) => e.getBoundingClientRect().height);
  const foundH = await page.$eval('[data-found="5432"]', (e) => e.getBoundingClientRect().height);
  check(Math.round(savedH) === 44 && Math.round(foundH) === 36, `${theme}: 44 px saved rows, a 36 px found row (${savedH}, ${foundH})`);
  // The empty window has no tab row chrome: no chip, no ‹ ›, no search box (⌘K opens mid-window).
  check(!(await visible('[data-testid="conn-chip"]')) && !(await visible(`${ws} [data-history-back]`)) && !(await visible('[data-testid="search-cap"]')), `${theme}: no chip, ‹ › or search box in the tab row`);
  // Light contrast: the saved rows' sub-lines and Connect ↵ are --mute.
  const mute = await colorOf("--mute");
  const subs = await page.$eval('[data-saved-conn="prd"]', (e) => [getComputedStyle(e.querySelector('[data-testid="ew-saved-sub"]')).color, getComputedStyle(e.querySelector("kbd")).color]);
  check(subs.every((c) => c === mute), `${theme}: saved sub-line and Connect ↵ in --mute (${subs})`);
  await page.mouse.move(5, 790);
  await shot(dark ? "dark" : "desktop");
  // Hover: the card takes the accent border; a row gets the gliding highlight.
  await page.hover('[data-empty-action="sample"]');
  await page.waitForTimeout(250);
  const hov = await page.$eval('[data-empty-action="sample"]', (e) => getComputedStyle(e).borderTopColor);
  check(hov === (await colorOf("--acc")), `${theme}: a hovered card takes the accent border (${hov})`);
  await page.hover('[data-saved-conn="stg"]');
  await page.waitForTimeout(250);
  const glide = await page.evaluate(() => {
    const g = document.querySelector("[data-empty-window] [data-glide]");
    const row = document.querySelector('[data-saved-conn="stg"]');
    return { on: g?.hasAttribute("data-glide-on"), rowBg: getComputedStyle(row).backgroundColor, h: g?.getBoundingClientRect().height };
  });
  check(glide.on && Math.round(glide.h) === 44 && glide.rowBg === "rgba(0, 0, 0, 0)", `${theme}: the row's hover is the glide, not its own fill (${JSON.stringify(glide)})`);
  await page.mouse.move(5, 790);
}

// 2 · The four cards run their commands.
await fresh();
await page.click('[data-empty-action="new"]');
await page.waitForSelector('[data-testid="nc-sheet"]');
check(true, "New connection opens the form");
await page.keyboard.press("Escape");
await page.waitForFunction(() => !document.querySelector('[data-testid="nc-sheet"]'));
await page.click('[data-empty-action="paste"]');
await page.waitForSelector('[data-testid="nc-sheet"]');
check((await page.inputValue('[data-field="host"] input')) === "stg.arcade.internal", "the paste card fills the form from the clipboard");
await page.keyboard.press("Escape");
await page.waitForFunction(() => !document.querySelector('[data-testid="nc-sheet"]'));
await page.click('[data-empty-action="file"]');
await page.waitForSelector(`${ws}[data-conn-state="connected"]`);
check((await calls("save_connection")).at(-1)?.connection.path === "/Users/me/data/shop.db", "Open a SQLite file… saves the chosen file and connects");
await fresh();
await page.click('[data-empty-action="sample"]');
await page.waitForSelector(`${ws}[data-conn-state="connected"]`);
check((await calls("open_sample")).length === 1, "Open the sample database opens it");

// 3 · A saved row connects; the schema column comes back.
await fresh();
await page.click('[data-saved-conn="stg"]');
await page.waitForSelector(`${ws}[data-conn-state="connected"] [data-testid="sb-row-main"]`);
await page.waitForFunction(() => !document.querySelector("[data-empty-window]"));
check((await calls("open_window")).at(-1)?.connectionId === "stg", "a saved row connects this window");
check(await visible(`${ws} [data-testid="sidebar"]`), "connected: the schema column is back");
await page.waitForTimeout(300);
const mainAfter = await box(`${ws} [data-testid="main"]`);
check(mainAfter.left === 264, `and the main column starts after it (${mainAfter.left})`);

const sheetLook = (sel) =>
  page.$eval(sel, (e) => {
    const cs = getComputedStyle(e);
    const title = e.querySelector(".sheet-title"); // Class on purpose: the shared title under test.
    const head = e.querySelector(".sheet-head"); // Class on purpose: the shared 42 px head.
    return { radius: cs.borderTopLeftRadius, shadow: cs.boxShadow, font: title && getComputedStyle(title).fontFamily, head: head?.offsetHeight, esc: head?.lastElementChild?.textContent.trim() };
  });
const paperSheet = (l) => l.radius === "8px" && /32px -8px/.test(l.shadow) && /IBM Plex Sans/.test(l.font) && l.head === 42 && l.esc === "esc";

// 4 · The query tab's Results row: the count, then Export ahead of the ….
await page.click(`${ws} textarea[data-testid="sql-editor"]`);
await page.keyboard.press("ControlOrMeta+a");
await page.keyboard.type("SELECT name, plays FROM games");
await page.keyboard.press("Control+Enter");
await page.waitForSelector(`${ws} [data-testid="results-export"]`);
const meta = (await page.textContent(`${ws} [data-testid="card-meta"]`)).trim();
check(/^4 rows\s*7 ms$/.test(meta), `the count and ms at the right (${meta})`);
const exp = await page.$eval(`${ws} [data-testid="results-export"]`, (e) => {
  const cs = getComputedStyle(e);
  return { h: e.getBoundingClientRect().height, b: cs.borderTopWidth, title: e.title, menu: e.nextElementSibling?.getAttribute("aria-label") ?? e.nextElementSibling?.className };
});
check(exp.h === 26 && exp.b === "1px", `Export is a bordered 26 px button (${exp.h}, ${exp.b})`);
check(exp.title === "Export results  Ctrl+Shift+E", `its tooltip comes from the registry (${exp.title})`);
check(!!exp.menu, `ahead of the results … (${exp.menu})`);
await page.mouse.move(5, 790);
await shot("results-export");
await page.click(`${ws} [data-testid="results-export"]`);
await page.waitForTimeout(200);
check((await calls("export_results")).length === 1, "Export runs the export command (export_results)");

// 4b · A result that maps to no table: the row reads "Results" as its heading.
await page.click(`${ws} textarea[data-testid="sql-editor"]`);
await page.keyboard.press("ControlOrMeta+a");
await page.keyboard.type("SELECT 'Pac-Man' AS name, 412 AS plays");
await page.keyboard.press("Control+Enter");
await page.waitForSelector(`${ws} [data-testid="card-title"]`);
const rt = await page.$eval(`${ws} [data-testid="card-title"]`, (e) => ({ t: e.textContent, f: getComputedStyle(e).fontFamily, s: getComputedStyle(e).fontSize }));
check(rt.t === "Results" && /IBM Plex Sans/.test(rt.f) && rt.s === "15px", `no table behind it: the Plex 15 "Results" (${rt.f})`);
check(await visible(`${ws} [data-testid="results-export"]`), "with Export at the right");
await page.mouse.move(5, 790);
await shot("results-serif");

// 4c · Report an issue: the same Paper sheet.
await page.keyboard.press("Control+k");
await page.waitForSelector('[data-testid="cp-row"]');
await page.keyboard.type("report");
await page.waitForTimeout(100);
await page.keyboard.press("Enter");
await page.waitForSelector('[data-testid="rp-sheet"]');
const rpLook = await sheetLook('[data-testid="rp-sheet"]');
check(paperSheet(rpLook), `Report: the same Paper sheet (${JSON.stringify(rpLook)})`);
await shot("report");
await page.keyboard.press("Escape");
await page.waitForSelector('[data-testid="rp-sheet"]', { state: "detached" });
check(true, "Esc closes Report");

// 5 · Timings and Shortcuts: Paper sheets, Esc closes.
await page.keyboard.press("Control+k");
await page.waitForSelector('[data-testid="cp-row"]');
await page.keyboard.type("timings");
await page.waitForTimeout(100);
await page.keyboard.press("Enter");
await page.waitForSelector("[data-timings]");
let look = await sheetLook("[data-timings]");
check(paperSheet(look), `Timings: radius 8, --pop, title in a 42 px head with esc (${JSON.stringify(look)})`);
check(/Mono/.test(await page.$eval("[data-timing]", (e) => getComputedStyle(e).fontFamily)), "the marks are a mono table");
const copyBg = await page.$eval("[data-timings-copy]", (e) => getComputedStyle(e).backgroundColor);
check(copyBg === (await colorOf("--bg")), `Copy is bordered, not ink: it commits nothing (${copyBg})`);
await shot("timings");
await page.keyboard.press("Escape");
await page.waitForSelector("[data-timings]", { state: "detached" });
check(true, "Esc closes Timings");

await page.click(`${ws} [data-testid="results-grid-wrap"]`);
await page.keyboard.press("Control+Shift+Slash");
await page.waitForSelector("[data-shortcuts]");
look = await sheetLook("[data-shortcuts]");
check(paperSheet(look), `Shortcuts: the same Paper sheet (${JSON.stringify(look)})`);
const dots = await page.$$eval('[data-shortcut] [data-testid="ks-dot"]', (els) =>
  els.map((e) => ({ used: e.closest("[data-shortcut]").hasAttribute("data-used"), bg: getComputedStyle(e).backgroundColor, ring: getComputedStyle(e).boxShadow })),
);
const okC = await colorOf("--ok");
check(dots.some((d) => d.used) && dots.filter((d) => d.used).every((d) => d.bg === okC), "used rows: a filled --ok dot");
check(dots.filter((d) => !d.used).every((d) => d.bg === "rgba(0, 0, 0, 0)" && d.ring === "none"), `unused rows: no ring, nothing (${dots.filter((d) => !d.used).length} rows)`);
await shot("shortcuts");
await page.keyboard.press("Escape");
await page.waitForSelector("[data-shortcuts]", { state: "detached" });
check(true, "Esc closes Shortcuts");

// 6 · The Agents page (proposals and the log, 2026-10-17), light and dark;
// Settings › Agents with Connect an agent inline; Esc.
await page.click('[data-testid="sb-agents"]');
await page.waitForSelector('[data-testid="agents-page"] [data-mcp-entry]');
const ag = await page.$eval('[data-testid="agents-page"]', (e) => {
  const title = e.querySelector(".ag-title"); // Class on purpose: the title.
  const list = e.querySelector('[data-testid="pp-list"]');
  const label = e.querySelector(".ag-sec"); // Class on purpose: the section label's case.
  const row = e.querySelector("[data-mcp-entry]");
  return {
    font: getComputedStyle(title).fontFamily,
    size: getComputedStyle(title).fontSize,
    rule: getComputedStyle(list).boxShadow,
    upper: getComputedStyle(label).textTransform,
    row: [getComputedStyle(row).borderTopWidth, getComputedStyle(row).borderTopLeftRadius],
    back: getComputedStyle(e.querySelector('[data-testid="page-back"]')).borderTopWidth,
  };
});
check(/IBM Plex Sans/.test(ag.font) && ag.size === "15px", "Agents: the Plex 15 title");
check(/-1px 0px 0px 0px inset/.test(ag.rule), `a 1 px rule between the list and the picked item (${ag.rule})`);
check(ag.upper === "none", `sentence-case section labels, no uppercase (${ag.upper})`);
check(ag.row.join() === "0px,8px", `log rows are glide rows, radius 8, no border (${ag.row})`);
check(ag.back === "1px", "the way out is a bordered control");
const verdicts = await page.$$eval("[data-mcp-entry]", (els) => [...new Set(els.map((e) => e.dataset.verdict))].sort().join());
check(verdicts === "ok,refused", `verdicts in the log: ${verdicts}`);
await page.mouse.move(5, 790);
await shot("agents");
await page.emulateMedia({ colorScheme: "dark" });
await page.waitForFunction(() => document.documentElement.dataset.theme === "dark");
await shot("agents-dark");
await page.emulateMedia({ colorScheme: "light" });
await page.waitForFunction(() => document.documentElement.dataset.theme === "light");
await page.click("[data-ag-sharing]");
await page.waitForSelector('[data-testid="agents-sharing"]');
check((await page.$eval('[data-testid="agents-sharing"] [data-mcp-connect]', (b) => getComputedStyle(b).borderTopWidth)) === "1px", "Connect an agent is a bordered button");
await page.click('[data-testid="agents-sharing"] [data-mcp-connect]');
await page.waitForSelector('[data-testid="ag-connect"] [data-mc-term]');
check((await page.$$eval('[data-testid="settings-page"] *', (els) => els.filter((e) => e.textContent.trim() === "esc" && e.children.length === 0 && e.offsetParent && !e.closest('[data-testid="page-back"]')).length)) === 1, "one esc besides the back button while Connect an agent is open");
check(/ · /.test(await page.textContent('[data-testid="mc-facts"]')), "its facts are one line joined by ·");
const mc = await page.$eval('[data-testid="ag-connect"] [data-mc-term]', (e) => ({ f: getComputedStyle(e).fontFamily, r: getComputedStyle(e).borderTopLeftRadius, bg: getComputedStyle(e).backgroundColor }));
check(/Mono/.test(mc.f) && mc.r === "6px" && mc.bg === (await colorOf("--hover")), `Connect an agent: the command in mono on --hover, radius 6 (${mc.r})`);
const run = await page.$eval('[data-mc-primary="run"]', (e) => getComputedStyle(e).backgroundColor);
check(run === (await colorOf("--ink")), `Run is the ink primary (${run})`);
await page.mouse.move(5, 790);
await shot("connect-agent");
await page.keyboard.press("Escape");
await page.waitForSelector('[data-testid="ag-connect"]', { state: "detached" });
check(true, "Esc closes Connect an agent first");
await page.keyboard.press("Escape");
await page.waitForSelector('[data-testid="settings-page"]', { state: "detached" });
check(true, "then the page");

// 7 · Couldn't connect: the same column, the penguin Tilted in --del.
await fresh({ fail: true });
await page.click('[data-saved-conn="prd"]');
await page.waitForSelector(`${ws}[data-conn-state="error"] [data-connect-error] [data-cause]`);
await page.waitForFunction(() => !document.querySelector("[data-empty-window]"));
const del = await colorOf("--del");
const f = await page.$eval(`${ws} [data-connect-error]`, (e) => {
  const svg = e.querySelector('svg[data-pose="tilted"]');
  const t = e.querySelector('[data-testid="sb-error-title"]');
  return {
    w: e.firstElementChild.getBoundingClientRect().width,
    title: t.textContent,
    font: getComputedStyle(t).fontFamily,
    penguin: svg && getComputedStyle(svg).color,
    btns: [...e.querySelectorAll('[data-testid="sb-error-btn"], [data-testid="sb-report"]')].map((b) => b.textContent.trim()),
  };
});
check(f.w === 560 && f.title === "Couldn't connect" && /IBM Plex Sans/.test(f.font), `the 560 px column, the Plex Couldn't connect (${f.w})`);
check(f.penguin === del, `the penguin leans Tilted, in --del (${f.penguin})`);
check(f.btns.join(" · ") === "Retry Ctrl+R · Edit… Ctrl+E · Report…", `Retry · Edit… · Report… (${f.btns.join(" · ")})`);
check(!(await visible(`${ws} textarea[data-testid="sql-editor"]`)), "no editor while it couldn't connect");
check(
  !(await visible(`${ws} [data-testid="sb-filter"]`)) && !(await visible(`${ws} .sb-head-tools`)) && (await visible(`${ws} [data-testid="sb-head-switch"] [data-testid="db-chip"]`)), // Class on purpose: the head's tools row. The head names the database.
  "the schema column folds to its head: no filter, Safe mode or MCP over no schema",
);
// The head names the database the connection opens on.
check((await page.innerText(`${ws} [data-testid="sb-head-switch"]`)).trim() === "arcade", `the head keeps the database's name (${(await page.innerText(`${ws} [data-testid="sb-head-switch"]`)).trim()})`);
await page.mouse.move(5, 790);
await shot("failed");

await browser.close();
console.log(failed ? `${failed} failed` : "all passed");
