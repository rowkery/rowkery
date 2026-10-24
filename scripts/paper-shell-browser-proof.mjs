#!/usr/bin/env node
// Paper shell (stubbed `invoke`): the window is one opaque sheet in a light
// and a dark theme (2026-10-10). Proves that the theme follows the
// system's prefers-color-scheme on Auto (`data-theme` on <html>), that the
// schema column's Appearance button and ⌘K's Appearance commands override it, save it to
// config.json through core (`set_theme_preference`, AppConfig.theme, which
// also sets the native window's appearance) and that a reload applies it
// before the first render, from config.json alone (no paint copy) and from
// index.html's paint copy before the bundle runs; that the theme icon lands
// upright (a full turn per change); that the glide hover is one element per
// list that moves to the hovered row (its transform changes) and fades when
// the pointer leaves, in the schema list, ⌘K and the schema column's foot
// (whose buttons paint no hover fill of their own); that the "Search tables, commands" button
// opens ⌘K under itself; that toasts are 34 px ink capsules (--r-pill); that
// dark Run is ink on orange (≥ 4.5:1). Inset sheets (2026-10-24): the main
// column is a 14 px paper sheet 8 px from the window's right and bottom on
// the canvas, the selected query tab sits on a neutral pill (no orange), and
// grid body cells draw no vertical rule. Captures the connected window and
// the empty window in light and dark, ⌘K open, the connection picker open
// and a toast.
//
//   cd apps/rowkery-tauri && npx vite --port 1420 &
//   node scripts/paper-shell-browser-proof.mjs [outDir]
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
const OUT = process.argv[2] ?? "/tmp/rowkery-proof/paper-shell";
const URL = process.env.ROWKERY_DEV_URL ?? "http://localhost:1420/";
const FRAMES_SHIM = new globalThis.URL("./lib/frames-shim.js", import.meta.url).pathname;
mkdirSync(OUT, { recursive: true });

function stubTauri() {
  // A reload keeps config.json's theme (sessionStorage stands in for it);
  // the page's own storage (the paint copy) only when the proof says so.
  if (!sessionStorage.getItem("keep-paint")) localStorage.clear();
  window.__THEME__ = sessionStorage.getItem("paper-theme") ?? "auto";
  const conns = [
    { kind: "postgres", id: "pg", name: "arcade-prd", host: "db.arcade.internal", port: 5432, database: "arcade", username: "alice", environment: "prd", safe_mode: "confirm" },
    { kind: "postgres", id: "local", name: "arcade-local", host: "localhost", port: 5432, database: "arcade", username: "alice", environment: "local", safe_mode: "off" },
    { kind: "sqlite", id: "lite", name: "kiosk.sqlite", path: "/Users/me/data/kiosk.sqlite", environment: null, safe_mode: "off" },
  ];
  const col = (name, type_name, nullable = false) => ({ name, type_name, nullable });
  const table = (name, rows, columns) => ({ name, columns, primary_key: ["id"], indexes: [], foreign_keys: [], row_estimate: { Exact: rows }, partition_of: null });
  const tables = [
    table("players", 1412, [col("id", "int8"), col("handle", "text"), col("joined_at", "timestamptz")]),
    table("kiosks", 38, [col("id", "int8"), col("name", "text")]),
    table("kiosk_sessions", 20511, [col("id", "int8"), col("kiosk_id", "int8")]),
    table("orders", 9120, [col("id", "int8"), col("player_id", "int8"), col("total", "numeric")]),
    table("wallets", 1412, [col("id", "int8"), col("balance", "numeric")]),
    table("wallet_tx", 48210, [col("id", "int8"), col("amount", "numeric")]),
  ];
  window.__TAURI_INTERNALS__ = {
    metadata: { currentWindow: { label: "main" }, currentWebview: { label: "main" } },
    transformCallback: () => 0,
    invoke: async (cmd, args) => {
      switch (cmd) {
        case "get_theme_preference":
          return window.__THEME__;
        case "set_theme_preference":
          window.__WINDOW_THEME__ = args.theme;
          if (args.save) {
            window.__THEME__ = args.theme;
            sessionStorage.setItem("paper-theme", args.theme);
          }
          return null;
        case "list_connections":
          return { connections: conns.map((c) => ({ ...c })), active_connection_id: null };
        case "open_window":
          return { database: "arcade", catalog: { databases: [{ name: "arcade", schemas: [{ name: "public", tables }] }] }, elapsed_ms: 41, cached: false, open_seq: 1 };
        case "list_databases":
          return [{ name: "arcade", size_bytes: 52_000_000 }, { name: "arcade_audit", size_bytes: 9_000_000 }];
        case "run_query":
          return {
            columns: [col("id", "int8"), col("handle", "text"), col("total", "numeric")],
            rows: Array.from({ length: 24 }, (_, i) => [{ Int: 48210 - i }, { Text: ["mika", "jules", "ana", "tobi"][i % 4] }, { Text: (12.5 * (i + 1)).toFixed(2) }]),
            row_count: 24,
            elapsed_ms: 19,
            error: null,
            cancelled: false,
          };
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
await context.grantPermissions(["clipboard-read", "clipboard-write"], { origin: new globalThis.URL(URL).origin });
const page = await context.newPage();
const errors = [];
page.on("pageerror", (e) => errors.push(e.message));
await page.addInitScript({ path: FRAMES_SHIM });
await page.addInitScript(stubTauri);

const ws = '[data-testid="workspace"]:not([hidden])';
const theme = () => page.evaluate(() => document.documentElement.dataset.theme);
const shot = async (name) => {
  await page.waitForTimeout(350);
  await page.screenshot({ path: `${OUT}/${name}.png` });
  console.log(`${OUT}/${name}.png`);
};
const savedTheme = () => page.evaluate(() => window.__THEME__);
// The resolved value of a token on the page, for comparing computed colours.
const token = (name) =>
  page.evaluate((name) => {
    const probe = document.createElement("div");
    probe.style.background = `var(${name})`;
    document.body.append(probe);
    const bg = getComputedStyle(probe).backgroundColor;
    probe.remove();
    return bg;
  }, name);

await page.goto(URL);
await page.waitForSelector('[data-testid="workspace"]:not([hidden])'); // Paper (2026-10-10): an empty window shows no connection chip (no tab row without a connection); wait for the window, then ⇧⌘O as before.

// ---------- Auto follows the system ----------
check((await theme()) === "light", "Auto, system light: data-theme is light");
check((await page.evaluate(() => getComputedStyle(document.body).backgroundColor)) === "rgb(255, 255, 255)", "the sheet is white (#ffffff)");
await shot("empty");
await page.emulateMedia({ colorScheme: "dark" });
await page.waitForFunction(() => document.documentElement.dataset.theme === "dark");
check(true, "the system turns dark: so does the window, on Auto");
check((await page.evaluate(() => getComputedStyle(document.body).backgroundColor)) === "rgb(26, 26, 26)", "the dark sheet is #1a1a1a, a step greyer than the website");
await shot("empty-dark");
await page.emulateMedia({ colorScheme: "light" });
await page.waitForFunction(() => document.documentElement.dataset.theme === "light");

// ---------- Connect ----------
await page.keyboard.press("Control+Shift+O");
await page.waitForSelector('[data-testid="conn-popover"]');
await page.keyboard.press("Enter");
await page.waitForSelector(`${ws}[data-conn-state="connected"]`);
await page.click(`${ws} textarea[data-testid="sql-editor"]`);
await page.keyboard.press("ControlOrMeta+a");
await page.keyboard.type("-- Top spenders this week\nSELECT p.id, p.handle, sum(o.total) AS total\n  FROM players p\n  JOIN orders o ON o.player_id = p.id\n GROUP BY p.id\n ORDER BY total DESC\n LIMIT 24;");
await page.keyboard.press("Control+Enter");
await page.waitForSelector(`${ws} [data-row]`);
await page.mouse.move(700, 790);
await shot("desktop");

// ---------- Inset sheets (2026-10-24) ----------
const sheet = await page.$eval(`${ws} [data-testid="main"]`, (e) => {
  const r = e.getBoundingClientRect();
  const cs = getComputedStyle(e);
  return { radius: cs.borderTopLeftRadius, bg: cs.backgroundColor, right: Math.round(window.innerWidth - r.right), bottom: Math.round(window.innerHeight - r.bottom), frame: getComputedStyle(document.querySelector('[data-testid="app-frame"]')).backgroundColor };
});
check(sheet.radius === "14px" && sheet.right === 8 && sheet.bottom === 8, `the main column is a 14 px sheet, 8 px from the window's right and bottom (${JSON.stringify(sheet)})`);
check(sheet.bg === (await token("--bg")) && sheet.frame === (await token("--canvas")), `paper on the canvas (${sheet.bg} on ${sheet.frame})`);
const acc = await token("--acc");
const pill = await page.$eval(`${ws} [data-testid="query-tab-thumb"]`, (e) => {
  const cs = getComputedStyle(e);
  const b = getComputedStyle(e, "::before");
  return { shadow: cs.boxShadow, bg: cs.backgroundColor, pillBg: b.backgroundColor, pillShadow: b.boxShadow, h: b.height, r: b.borderTopLeftRadius };
});
check(pill.pillBg === (await token("--hover")) && pill.h === "28px" && pill.r === "8px", `the selected tab sits on a 28 px --hover pill, radius 8 (${JSON.stringify(pill)})`);
check(![pill.shadow, pill.bg, pill.pillBg, pill.pillShadow].some((v) => v.includes(acc)), "the selected tab's pill has no orange");
const ruled = await page.$$eval(`${ws} [data-row] [data-col]`, (cells) => cells.filter((c) => { const cs = getComputedStyle(c); return cs.boxShadow !== "none" || cs.borderRightWidth !== "0px"; }).length);
check(ruled === 0, `grid body cells draw no vertical rule (${ruled} do)`);

// ---------- Glide hover in the schema column ----------
const glide = `${ws} [data-testid="sb-scroll"] > [data-glide]`;
const glideState = () => page.$eval(glide, (g) => ({ t: g.style.transform, o: getComputedStyle(g).opacity, on: g.hasAttribute("data-glide-on") }));
check((await page.locator(`${ws} [data-testid="sb-scroll"] [data-glide]`).count()) === 1, "one glide element in the table list");
const row = (name) => `${ws} [data-table="arcade.public.${name}"] [data-testid="sb-row-main"]`;
await page.hover(row("kiosks"));
await page.waitForTimeout(250);
const first = await glideState();
check(first.on && first.o === "1", `the glide shows under the hovered row (${JSON.stringify(first)})`);
await page.hover(row("wallets"));
await page.waitForTimeout(60);
const mid = await page.$eval(glide, (g) => getComputedStyle(g).transform);
await page.waitForTimeout(250);
const second = await glideState();
check(second.t !== first.t, `hovering another row moves the same element (${first.t} → ${second.t})`);
const [gBox, rBox] = await page.evaluate(
  ([g, r]) => [document.querySelector(g), document.querySelector(r).closest(".sb-row")].map((e) => Math.round(e.getBoundingClientRect().top)),
  [glide, row("wallets")],
);
check(gBox === rBox, `it lands on that row (${gBox} vs ${rBox})`);
check(mid !== "none", "it glides there (a transition, not a jump)");
check((await page.$$eval(`${ws} .sb-row`, (rows) => rows.filter((r) => getComputedStyle(r).backgroundColor !== "rgba(0, 0, 0, 0)" && !r.classList.contains("selected")).length)) === 0, "rows paint no hover fill of their own");
await page.mouse.move(700, 400);
await page.waitForTimeout(220);
const gone = await glideState();
check(!gone.on && gone.o === "0", "it fades when the pointer leaves the list");

// ---------- The schema column's foot and the title bar glide too ----------
// The schema column's foot rows glide; the title bar's window pills don't
// (the shown one is raised on paper, so it takes no glide).
const footGlide = '[data-testid="sb-foot-rows"] > [data-glide]';
await page.hover('[data-testid="sb-agents"]');
await page.waitForTimeout(250);
const f1 = await page.$eval(footGlide, (g) => g.style.transform);
await page.hover('[data-testid="sb-settings"]');
await page.waitForTimeout(250);
const f2 = await page.$eval(footGlide, (g) => [g.style.transform, g.hasAttribute("data-glide-on")]);
check(f1 !== f2[0] && f2[1], `the foot rows share one glide (${f1} → ${f2[0]})`);
const tileFill = await page.$eval('[data-testid="sb-agents"]', (e) => getComputedStyle(e).backgroundColor);
check(tileFill === "rgba(0, 0, 0, 0)", `a hovered foot row paints no fill of its own (${tileFill})`);
await page.hover('[data-testid="win-add"]');
await page.waitForTimeout(250);
const tile = await page.evaluate(() => {
  const g = document.querySelector('[data-testid="win-tabs"] > [data-glide]');
  return { on: g?.hasAttribute("data-glide-on"), h: Math.round(g.getBoundingClientRect().height) };
});
check(tile.on && tile.h === 28, `the title bar's + hovers with the glide, 28 px (${JSON.stringify(tile)})`);
await page.mouse.move(700, 400);

// ---------- ⌘K in the middle of the window (2026-10-17) ----------
check(!(await page.$('[data-testid="search-cap"]')), "no Search button in the title bar");
await page.keyboard.press("Control+k");
await page.waitForSelector('[data-testid="cp-panel"]');
await page.waitForTimeout(250); // its pop entry scales from .98
const pb = await page.locator('[data-testid="cp-panel"]').boundingBox();
const vw = page.viewportSize().width;
check(Math.round(pb.width) === 640 && Math.abs(pb.x + pb.width / 2 - vw / 2) < 2 && pb.y > 48, `the palette is a 640 px card centred in the window (${JSON.stringify(pb)})`);
await page.keyboard.type("o");
await page.waitForSelector('[data-testid="cp-row"]');
const cpRows = page.locator('[data-testid="cp-row"]');
await cpRows.nth(2).hover();
await page.waitForTimeout(250);
const cp1 = await page.$eval('[data-testid="cp-panel"] [data-glide]', (g) => g.style.transform);
await cpRows.nth(4).hover();
await page.waitForTimeout(250);
const cp2 = await page.$eval('[data-testid="cp-panel"] [data-glide]', (g) => g.style.transform);
check(cp1 !== cp2 && (await page.locator('[data-testid="cp-panel"] [data-glide]').count()) === 1, "⌘K rows share one glide that moves with the pointer");
await page.mouse.move(400, 700);
await shot("palette");
await page.keyboard.press("Escape");
await page.keyboard.press("Escape");
await page.waitForFunction(() => !document.querySelector('[data-testid="cp-panel"]'));

// ---------- The connection picker ----------
await page.keyboard.press("Control+Shift+O"); // The head names the database; ⇧⌘O opens the connection picker.
await page.waitForSelector('[data-testid="conn-popover"]');
await page.locator('[data-testid="conn-popover"] [data-conn-id="local"]').hover();
await shot("picker");
await page.keyboard.press("Escape");
await page.waitForTimeout(200);

// ---------- A toast ----------
await page.locator(`${ws} [data-row]`).nth(1).locator('[data-col="1"]').click();
await page.keyboard.press("Control+KeyC");
await page.waitForSelector("[data-toast]");
const toastBox = await page.$eval("[data-toast]", (e) => {
  const cs = getComputedStyle(e);
  return { bg: cs.backgroundColor, h: Math.round(e.getBoundingClientRect().height), r: cs.borderRadius, anim: cs.animationName };
});
// The toast (2026-10-13): an ink capsule (2026-10-24, --r-pill).
check(toastBox.bg === (await token("--ink")) && toastBox.h === 34 && toastBox.r === "999px", `the toast is a 34 px ink capsule (${JSON.stringify(toastBox)})`);
check(toastBox.anim === "toast", "it plays Paper's 2.6 s toast keyframes");
await page.waitForTimeout(400);
await page.screenshot({ path: `${OUT}/toast.png` });
console.log(`${OUT}/toast.png`);
await page.waitForTimeout(2600);

// ---------- Settings > Appearance overrides the system, and is saved ----------
// The only theme control (2026-10-17) is Settings > Appearance; the foot
// no longer carries a theme button.
const settingsPage = '[data-testid="settings-page"]';
const themeCard = (v) => `${settingsPage} [data-st-group="theme"] [data-st-option="${v}"]`;
await page.click('[data-testid="sb-settings"]');
await page.waitForSelector(settingsPage);
await page.click(`${settingsPage} [data-st-section="appearance"]`);
await page.click(themeCard("light"));
check((await theme()) === "light", "Light pins light");
await page.click(themeCard("dark"));
check((await theme()) === "dark", "Dark turns the window dark while the system is light");
check((await savedTheme()) === "dark", "core saved theme = dark to config.json (set_theme_preference, save)");
check((await page.evaluate(() => window.__WINDOW_THEME__)) === "dark", "and gave the native window the dark appearance");
await page.keyboard.press("Escape");
await page.waitForSelector(settingsPage, { state: "detached" });
await page.waitForTimeout(400); // the theme cross-fades
const runDark = await page.$eval(`${ws} [data-testid="run-btn"]`, (e) => [getComputedStyle(e).color, getComputedStyle(e).backgroundColor]);
check(runDark[0] === "rgb(26, 26, 26)" && runDark[1] === "rgb(255, 138, 61)", `dark Run is ink #1a1a1a on #ff8a3d, 7.4:1 (${runDark.join(" on ")})`);
await page.emulateMedia({ colorScheme: "light" });
await page.waitForTimeout(100);
check((await theme()) === "dark", "a light system no longer changes it");
await page.mouse.move(700, 790);
await shot("dark");

await page.locator(`${ws} [data-table="arcade.public.orders"] [data-testid="sb-row-main"]`).hover();
await page.keyboard.press("Control+k");
await page.waitForSelector('[data-testid="cp-panel"]');
await page.keyboard.type("o");
await page.mouse.move(400, 700);
await shot("palette-dark");
await page.keyboard.press("Escape");
await page.keyboard.press("Escape");
await page.keyboard.press("Control+Shift+O"); // The head names the database; ⇧⌘O opens the connection picker.
await page.waitForSelector('[data-testid="conn-popover"]');
await page.locator('[data-testid="conn-popover"] [data-conn-id="local"]').hover();
await shot("picker-dark");
await page.keyboard.press("Escape");
await page.waitForTimeout(200);
await page.locator(`${ws} [data-row]`).nth(2).locator('[data-col="1"]').click();
await page.keyboard.press("Control+KeyC");
await page.waitForSelector("[data-toast]");
// In the dark the toast is the panel lifted by --pop, not near-white ink (2026-10-13).
check((await page.$eval("[data-toast]", (e) => getComputedStyle(e).backgroundColor)) === (await token("--panel")), "in dark the toast is the lifted panel");
await page.waitForTimeout(400);
await page.screenshot({ path: `${OUT}/toast-dark.png` });
console.log(`${OUT}/toast-dark.png`);

// ---------- A reload applies the saved theme before the first render ----------
await page.addInitScript(() => {
  document.addEventListener("DOMContentLoaded", () => {
    window.__FIRST_THEME__ = document.documentElement.dataset.theme;
  });
  new MutationObserver((_, obs) => {
    if (document.getElementById("root")?.firstChild) {
      window.__THEME_AT_RENDER__ = document.documentElement.dataset.theme;
      obs.disconnect();
    }
  }).observe(document, { childList: true, subtree: true });
});
await page.reload();
await page.waitForSelector('[data-testid="workspace"]:not([hidden])'); // Paper (2026-10-10): an empty window shows no connection chip (no tab row without a connection); wait for the window, then ⇧⌘O as before.
check((await page.evaluate(() => window.__THEME_AT_RENDER__)) === "dark", "after a reload with no paint copy (storage reset), config.json's Dark is on <html> before React's first render");
await page.evaluate(() => sessionStorage.setItem("keep-paint", "1"));
await page.reload();
await page.waitForSelector('[data-testid="workspace"]:not([hidden])'); // Paper (2026-10-10): an empty window shows no connection chip (no tab row without a connection); wait for the window, then ⇧⌘O as before.
check((await page.evaluate(() => window.__FIRST_THEME__)) === "dark", "with the paint copy, index.html paints Dark before the bundle runs");
await page.evaluate(() => sessionStorage.removeItem("keep-paint"));
check((await theme()) === "dark", "and stays on a light system");

// ---------- ⌘K Appearance commands ----------
await page.keyboard.press("Control+k");
await page.keyboard.type("appearance");
await page.waitForSelector('[data-testid="cp-row"][data-item="cmd:theme:auto"]');
const offered = await page.$$eval('[data-testid="cp-row"][data-item^="cmd:theme:"]', (els) => els.map((e) => e.dataset.item).sort());
check(offered.join() === "cmd:theme:auto,cmd:theme:light", `⌘K offers the two appearances not in use (${offered.join(", ")})`);
await page.click('[data-testid="cp-row"][data-item="cmd:theme:auto"]');
await page.waitForFunction(() => document.documentElement.dataset.theme === "light");
check(true, "Appearance: match the system goes back to Auto (the system is light)");
check((await savedTheme()) === "auto", "Auto is saved");
await page.emulateMedia({ colorScheme: "dark" });
await page.waitForFunction(() => document.documentElement.dataset.theme === "dark");
check(true, "and follows the system again");
await page.emulateMedia({ colorScheme: "light" });

// ---------- Reduce Motion: the glide appears at once ----------
await page.emulateMedia({ colorScheme: "light", reducedMotion: "reduce" });
await page.keyboard.press("Control+Shift+O");
await page.waitForSelector('[data-testid="conn-popover"]');
await page.keyboard.press("Enter");
await page.waitForSelector(`${ws}[data-conn-state="connected"]`);
await page.hover(row("kiosks"));
await page.hover(row("orders"));
const reduced = await page.$eval(glide, (g) => g.style.transition);
check(reduced === "none", `Reduce Motion: the glide moves without a transition (${reduced})`);

check(errors.length === 0, `no page errors${errors.length ? `: ${errors.join(" | ")}` : ""}`);
await browser.close();
