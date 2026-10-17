#!/usr/bin/env node
// Settings and the reordered schema-column foot (2026-10-17) proof with a
// stubbed Tauri `invoke`. The foot reads Agents · Presenting on the left and
// Settings on the right (Appearance and Keyboard shortcuts left it for
// Settings on 2026-10-17). Ctrl+, (⌘, on a
// Mac), the gear or ⌘K "Settings" opens Settings as a page in place of the
// window (the schema column hides, as for Agents), with Updates, Appearance,
// Keyboard and Agents down the left, and a back button naming the window
// first in its head. Updates: the version line, Check now, and the
// four update choices as radio cards (Download only by default). With Notify
// only, Check now finds 0.1.2 without downloading it: the line offers
// Download, Updates gets an orange dot, and back in the window the foot shows
// the orange round update button. That button opens Settings > Updates,
// Download fetches the release, and the line offers Restart. Appearance and
// Keyboard apply at once. Esc, or the head's back button, goes back. Light and dark. Hovers fade,
// presses give, categories rise in; Reduce Motion stops it.
// What a download, restart and Automatic's idle restart do on the Mac is
// covered by `cargo test -p rowkery-tauri` and updates.test.ts, not here.
//
//   cd apps/rowkery-tauri && npx vite --port 1420 &
//   node scripts/settings-browser-proof.mjs [outDir]
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
const OUT = process.argv[2] ?? "/tmp/rowkery-proof/settings";
const URL = process.env.ROWKERY_DEV_URL ?? "http://localhost:1420/";
const FRAMES_SHIM = new globalThis.URL("./lib/frames-shim.js", import.meta.url).pathname;
mkdirSync(OUT, { recursive: true });

function stubTauri() {
  localStorage.clear();
  window.__CALLS__ = [];
  const connections = [
    {
      kind: "postgres",
      id: "pg",
      name: "shop-prd",
      host: "shop-db.c9x.rds.amazonaws.com",
      port: 5432,
      database: "shop",
      username: "app",
      environment: "prd",
    },
  ];
  const col = (name, type_name, nullable = false) => ({ name, type_name, nullable });
  const CUSTOMERS = [col("id", "int8"), col("full_name", "text"), col("email", "text"), col("phone", "text", true), col("country", "text")];
  const table = (name, columns) => ({
    name,
    kind: "table",
    columns,
    primary_key: ["id"],
    indexes: [],
    foreign_keys: [],
    row_estimate: { Approximate: 12 },
    partition_of: null,
  });
  const tables = [table("customers", CUSTOMERS)];
  const people = ["Aisha Rahman", "Ben Okafor", "Chen Wei", "Dana Cruz", "Eli Novak", "Farah Lim", "Gus Patel", "Hana Sato"];
  const rowOf = (i) => [
    { Int: i + 1 },
    { Text: people[i % people.length] },
    { Text: `${people[i % people.length].split(" ")[0].toLowerCase()}@example.com` },
    { Text: `+60 12-${String(3000000 + i * 1111).slice(0, 3)} ${String(4000 + i)}` },
    { Text: ["MY", "SG", "ID"][i % 3] },
  ];
  window.__TAURI_INTERNALS__ = {
    metadata: { currentWindow: { label: "main" }, currentWebview: { label: "main" } },
    transformCallback: () => 0,
    invoke: async (cmd, args) => {
      window.__CALLS__.push([cmd, args]);
      switch (cmd) {
        case "list_connections":
          return { connections: structuredClone(connections), active_connection_id: null };
        case "save_connection": {
          const i = connections.findIndex((c) => c.id === args.connection.id);
          if (i >= 0) connections[i] = args.connection;
          return null;
        }
        case "open_window":
          return { database: "shop", catalog: { databases: [{ name: "shop", schemas: [{ name: "public", tables }] }] }, elapsed_ms: 2, cached: false, open_seq: 1 };
        case "browse_table_sql":
          return `SELECT * FROM ${args.schema}.${args.table}\nORDER BY id${args.limit ? `\nLIMIT ${args.limit}` : ""};`;
        case "run_query": {
          const n = 8;
          const picked = /select email, full_name/i.test(args.sql) ? [2, 1] : [0, 1, 2, 3, 4];
          return {
            columns: picked.map((i) => ({ name: CUSTOMERS[i].name, type_name: CUSTOMERS[i].type_name })),
            rows: Array.from({ length: n }, (_, r) => picked.map((i) => rowOf(r)[i])),
            row_count: n,
            elapsed_ms: 3,
            error: null,
            cancelled: false,
          };
        }
        case "app_info":
          return { version: "0.1.1", os: "linux", os_version: null, arch: "x86_64" };
        case "check_for_update":
          // A newer release is out; Notify only asks for it without the download.
          return args?.download === false
            ? { status: "available", version: "0.1.2", notes: "Faster grid scrolling.\nSettings page." }
            : { status: "ready", version: "0.1.2", notes: "Faster grid scrolling.\nSettings page." };
        case "download_update":
          await new Promise((r) => setTimeout(r, 400));
          return { status: "ready", version: "0.1.2", notes: "Faster grid scrolling.\nSettings page." };
        case "holds_open_transaction":
          return false;
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
const context = await browser.newContext({ viewport: { width: 1280, height: 800 }, deviceScaleFactor: 2 });
const page = await context.newPage();
page.on("pageerror", (e) => console.error("pageerror:", e.message));
await page.addInitScript({ path: FRAMES_SHIM });
await page.addInitScript(stubTauri);
await page.goto(URL);
const ws = '[data-testid="workspace"]:not([hidden])';
const foot = `${ws} [data-testid="sb-foot-rows"]`;
const settings = '[data-testid="settings-page"]';
const card = (group, value) => `${settings} [data-st-group="${group}"] [data-st-option="${value}"]`;
const checked = async (group, value) => (await page.getAttribute(card(group, value), "aria-checked")) === "true";
const token = (name) =>
  page.evaluate((name) => {
    const p = document.createElement("span");
    p.style.color = `var(${name})`;
    document.body.append(p);
    const c = getComputedStyle(p).color;
    p.remove();
    return c;
  }, name);

await page.waitForSelector(ws);
await page.keyboard.press("Control+Shift+O");
await page.waitForSelector('[data-testid="conn-popover"]');
await page.keyboard.press("Enter");
await page.waitForSelector(`${ws}[data-conn-state="connected"]`);

// 1. The foot: Agents · Presenting | Settings.
const order = await page.$$eval(`${foot} > *`, (els) => els.filter((e) => !e.hasAttribute("data-glide")).map((e) => e.getAttribute("data-testid") ?? e.className));
check(
  JSON.stringify(order) === JSON.stringify(["sb-agents", "sb-presenting", "sb-foot-gap", "sb-settings"]),
  `the foot's order (${order.join(", ")})`,
);
const [presentBox, gearBox] = await Promise.all(
  ["sb-presenting", "sb-settings"].map((id) => page.locator(`${foot} [data-testid="${id}"]`).boundingBox()),
);
const footBox = await page.locator(foot).boundingBox();
check(gearBox.x - (presentBox.x + presentBox.width) > 60, "a gap parts the left pair from Settings");
check(footBox.x + footBox.width - (gearBox.x + gearBox.width) <= 16, "Settings sits at the right end");
check(!(await page.$(`${foot} [data-testid="sb-update"]`)), "no update button while nothing waits");
await page.screenshot({ path: `${OUT}/1-foot.png`, clip: { x: footBox.x, y: footBox.y - 4, width: footBox.width, height: footBox.height + 8 } });

// 2. Ctrl+, opens Settings on Updates, in place of the window.
await page.keyboard.press("Control+,");
await page.waitForSelector(settings);
check((await page.getAttribute('[data-testid="app-frame"]', "data-page")) === "settings", "the frame says a page is up");
check(!(await page.locator(`${ws} .sidebar-clip`).isVisible().catch(() => false)), "the schema column hides under the page");
check((await page.getAttribute(settings, "data-section")) === "updates", "it opens on Updates");
const sections = await page.$$eval(`${settings} [data-st-section]`, (els) => els.map((e) => e.getAttribute("data-st-section")));
check(JSON.stringify(sections) === JSON.stringify(["updates", "appearance", "keyboard", "agents"]), `Updates, Appearance, Keyboard and Agents down the left (${sections})`);
// Text on purpose: the back button names the window it returns to.
check((await page.textContent(`${settings} [data-testid="page-back"]`)).includes("shop-prd"), "the head's back button names the window");
await page.waitForFunction(() => /Rowkery 0\.1\.1/.test(document.querySelector('[data-testid="st-update-status"]')?.textContent ?? ""));
check(true, "the version line names this build");
check(await checked("update-pref", "download"), "Download only is picked by default");
const prefs = await page.$$eval(`${settings} [data-st-group="update-pref"] [data-st-option]`, (els) => els.map((e) => e.getAttribute("data-st-option")));
check(JSON.stringify(prefs) === JSON.stringify(["auto", "download", "notify", "off"]), `four choices, most automatic first (${prefs})`);
await page.screenshot({ path: `${OUT}/2-updates.png` });

// 3. Notify only, then Check now: 0.1.2 is out and not downloaded.
await page.click(card("update-pref", "notify"));
check(await checked("update-pref", "notify"), "picking Notify only rings it");
await page.click(`${settings} [data-st-check]`);
await page.waitForSelector(`${settings} [data-st-download]`);
const calls = await page.evaluate(() => window.__CALLS__.filter(([c]) => c === "check_for_update").map(([, a]) => a));
check(calls.at(-1)?.download === false, "Notify only asks without the download");
check(/Rowkery 0\.1\.2 is out/.test(await page.textContent('[data-testid="st-update-status"]')), "the line says 0.1.2 is out, with Download");
check(!!(await page.$(`${settings} [data-testid="st-update-dot"]`)), "Updates wears the orange dot");
check(!!(await page.$('[data-testid="st-notes"]')), "the release notes show");
await page.screenshot({ path: `${OUT}/3-available.png` });

// 4. Esc goes back; the foot shows the orange round update button.
await page.keyboard.press("Escape");
await page.waitForFunction((sel) => !document.querySelector(sel), settings);
const update = `${foot} [data-testid="sb-update"]`;
await page.waitForSelector(update);
await page.mouse.move(700, 400);
await page.waitForTimeout(300);
const btn = await page.$eval(update, (e) => {
  const s = getComputedStyle(e);
  return { bg: s.backgroundColor, radius: s.borderRadius, w: e.getBoundingClientRect().width, h: e.getBoundingClientRect().height };
});
check(btn.bg === (await token("--acc")), `the update button is orange (${btn.bg})`);
check(btn.radius === "50%" && Math.round(btn.w) === 28 && Math.round(btn.h) === 28, `round, the foot's 28 px (${btn.w}x${btn.h}, ${btn.radius})`);
const order2 = await page.$$eval(`${foot} > *`, (els) => els.filter((e) => !e.hasAttribute("data-glide")).map((e) => e.getAttribute("data-testid") ?? e.className));
check(order2.indexOf("sb-update") === order2.indexOf("sb-settings") - 1, "it sits just left of Settings");
await page.screenshot({ path: `${OUT}/4-update-button.png` });

// 5. The button opens Updates; Download fetches it, then Restart is offered.
await page.click(update);
await page.waitForSelector(settings);
check((await page.getAttribute(settings, "data-section")) === "updates", "the update button opens Settings > Updates");
await page.click(`${settings} [data-st-download]`);
await page.waitForSelector(`${settings} [data-testid="st-update-status"][data-phase="downloading"]`);
check(true, "Download shows the download under way");
await page.waitForSelector(`${settings} [data-st-restart]`);
check(/0\.1\.2 is ready/.test(await page.textContent('[data-testid="st-update-status"]')), "then it is ready, with Restart");
await page.screenshot({ path: `${OUT}/5-ready.png` });

// 6. Appearance and Keyboard apply at once.
await page.click(`${settings} [data-st-section="appearance"]`);
await page.click(card("theme", "dark"));
await page.waitForFunction(() => document.documentElement.getAttribute("data-theme") === "dark");
check(await checked("theme", "dark"), "Dark applies at once");
await page.screenshot({ path: `${OUT}/6-appearance-dark.png` });
await page.click(`${settings} [data-st-section="keyboard"]`);
await page.click(card("keymap", "tableplus"));
check(await checked("keymap", "tableplus"), "TablePlus keys apply at once");
await page.click(card("keymap", "rowkery"));
await page.click(`${settings} [data-st-section="updates"]`);
await page.waitForTimeout(300);
await page.screenshot({ path: `${OUT}/7-ready-dark.png` });

// 7. Esc goes back; ⌘K finds Settings and the gear opens it too.
await page.keyboard.press("Escape");
await page.waitForFunction((sel) => !document.querySelector(sel), settings);
check(await page.locator(`${ws} .sidebar-clip`).isVisible(), "the schema column is back");
await page.keyboard.press("Control+K");
await page.waitForSelector('[data-testid="cp-panel"]');
await page.keyboard.type("settings");
await page.waitForTimeout(150);
check(!!(await page.$('[data-item="cmd:settings"]')), "⌘K finds Settings");
await page.keyboard.press("Escape");
await page.keyboard.press("Escape");
await page.waitForFunction(() => !document.querySelector('[data-testid="cp-scrim"]'));
await page.click(`${foot} [data-testid="sb-settings"]`);
await page.waitForSelector(settings);
check(true, "the gear opens Settings");
await page.click(`${settings} [data-testid="page-back"]`);
await page.waitForFunction((sel) => !document.querySelector(sel), settings);
check(true, "the head's back button goes back");

// 8. Motion: hovers fade, presses give, a picked category rises in, and the
// foot's buttons give under a press; Reduce Motion turns all of it off.
await page.click(`${foot} [data-testid="sb-settings"]`);
await page.waitForSelector(settings);
const style = (sel, prop) => page.$eval(sel, (el, p) => getComputedStyle(el)[p], prop);
const cardSel = card("update-pref", "auto");
check(/background-color/.test(await style(cardSel, "transitionProperty")), "a card's fill fades on hover");
const restFill = await style(cardSel, "backgroundColor");
await page.hover(cardSel);
await page.waitForTimeout(300);
check((await style(cardSel, "backgroundColor")) !== restFill, "and hover changes it");
await page.mouse.down();
await page.waitForTimeout(200);
check(/matrix\(0\.98/.test(await style(cardSel, "transform")), "a pressed card shrinks a little");
await page.mouse.up();
check(/box-shadow/.test(await style(`${cardSel} .st-radio`, "transitionProperty")), "the radio's dot grows in");
check(/color/.test(await style(`${settings} .st-nav-row`, "transitionProperty")), "category rows fade on hover");
check((await style(`${settings} .st-status .mcp-btn`, "transitionProperty")).includes("transform"), "buttons give under a press");
await page.click(`${settings} [data-st-section="appearance"]`);
check((await style(`${settings} .st-pane`, "animationName")) === "rise", "a picked category's settings rise in");
await page.click(`${settings} [data-testid="page-back"]`);
await page.waitForFunction((sel) => !document.querySelector(sel), settings);
check(/transform/.test(await style(`${foot} [data-testid="sb-settings"]`, "transitionProperty")), "foot buttons give under a press");
await page.emulateMedia({ reducedMotion: "reduce" });
await page.click(`${foot} [data-testid="sb-settings"]`);
await page.waitForSelector(settings);
check(
  (await style(cardSel, "transitionDuration")).split(",").every((d) => parseFloat(d) === 0) &&
    (await style(`${settings} .st-pane`, "animationName")) === "none",
  "Reduce Motion turns it off",
);

await browser.close();
