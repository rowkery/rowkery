#!/usr/bin/env node
// Docs screens for the Keys pages (docs.rowkery.com /search/, /shortcuts-and-keymaps/,
// /undo-and-esc/), from the running app (Vite) with the docs' stubbed storefront backend:
//  - search-empty: ⌘K before anything is typed (recent queries, commands, connections);
//  - search-mixed: ⌘K finding "ord" across tables and recent queries;
//  - search-scoped: ⌘K limited to commands with the > prefix;
//  - search-paste: a postgres:// URL pasted into ⌘K, its "New connection from URL" row first;
//  - shortcuts-and-keymaps-sheet: the shortcut sheet with a few keys used;
//  - shortcuts-and-keymaps-keymap: the sheet's keymap picker open;
//  - shortcuts-and-keymaps-hints: the key hints while ⌘ is held;
//  - shortcuts-and-keymaps-strips: a query tab with the editor's and the grid's key strips;
//  - undo-and-esc-toast: the Undo toast after closing a query tab with SQL in it.
// Not a proof: it checks nothing beyond waiting for each screen.
//
//   cd apps/rowkery-tauri && npx vite --port 1420 &
//   node scripts/docs-shots/keys.mjs [outDir] [--write] [--only=search,undo]
import { openApp, shot, close, sizes, settle, hideKeyStrip, wanted, WS } from "./lib.mjs";

const MIN = 60_000;
const NOW = Date.parse("2026-10-14T11:45:00Z");

/** Saved state as config.json would hold it: recent queries, ⌘K picks and used keys. */
const more = (seed) => {
  const keys = seed;
  window.__STUB_MORE__ = async (cmd) => {
    if (cmd === "load_ui_state") return { version: 1, keys: structuredClone(keys) };
    return undefined;
  };
};

const SEED = {
  "rowkery.history.prd": [
    { sql: "SELECT status, count(*) FROM orders GROUP BY status ORDER BY 2 DESC;", at: NOW - 4 * MIN },
    { sql: "SELECT * FROM customers WHERE country = 'NL' ORDER BY created_at DESC;", at: NOW - 26 * MIN },
    { sql: "SELECT o.id, o.total, c.email FROM orders o JOIN customers c ON c.id = o.customer_id WHERE o.status = 'refunded';", at: NOW - 3 * 60 * MIN },
    { sql: "SELECT date_trunc('day', placed_at) AS day, sum(total) FROM orders GROUP BY 1 ORDER BY 1 DESC LIMIT 14;", at: NOW - 26 * 60 * MIN },
  ],
  "rowkery.commandUses": { "show-sessions": 4, "keyboard-shortcuts": 3, "export": 2 },
  "rowkery.usedKeys": {
    "command-palette": 40,
    run: 31,
    "run-all": 4,
    cancel: 2,
    "filter-rows": 9,
    "toggle-sidebar": 6,
    "new-window": 5,
    "switch-connection": 7,
    "refresh-schema": 3,
    "keyboard-shortcuts": 2,
    explain: 3,
    "open-in-query": 2,
  },
};

/** openApp with the saved state seeded (`load_ui_state`). */
async function seeded(o = {}) {
  const src = `(${more.toString()})(${JSON.stringify(SEED)});`;
  return openApp({ ...o, more: { content: src } });
}

const PANEL = '[data-testid="cp-panel"]';
const EDITOR = `${WS} .editor-card textarea.sql-editor`;
/** The key strips (lib's hideKeyStrip misses them: they carry data-key-strip, no test id). */
const hideStrips = (page) => page.addStyleTag({ content: "[data-key-strip], [data-key-strip-glyph] { visibility: hidden !important; }" });

// 1. ⌘K: empty, mixed, scoped, pasted.
if (wanted("search")) {
  const { context, page } = await seeded({});
  await hideKeyStrip(page);
  await hideStrips(page);
  await page.keyboard.press("Meta+k");
  await page.waitForSelector(PANEL);
  const tools = await page.locator('[data-testid="titlebar-conn"]').boundingBox();
  const box = await page.locator(PANEL).boundingBox();
  await shot(page, "search-empty", { clip: { x: tools.x - 12, y: 0, width: 1280 - (tools.x - 12), height: box.y + box.height + 14 } });

  await page.keyboard.type("ord", { delay: 40 });
  await page.waitForTimeout(250);
  await shot(page, "search-mixed", { el: PANEL });

  await page.keyboard.press("Escape");
  await page.keyboard.type(">safe", { delay: 40 });
  await page.waitForTimeout(250);
  await shot(page, "search-scoped", { el: PANEL });

  await page.keyboard.press("Escape");
  await page.keyboard.insertText("postgres://maya@db.arcade.internal:5432/arcade?sslmode=require");
  await page.waitForSelector(`${PANEL} [data-pasted]`);
  await shot(page, "search-paste", { el: PANEL });
  await context.close();
}

// 2. The shortcut sheet and its keymap picker.
if (wanted("shortcuts-and-keymaps-sheet") || wanted("shortcuts-and-keymaps-keymap")) {
  const { context, page } = await seeded({});
  await hideKeyStrip(page);
  await hideStrips(page);
  await page.keyboard.press("Meta+Shift+Slash");
  await page.waitForSelector("[data-shortcuts]");
  await shot(page, "shortcuts-and-keymaps-sheet", { el: ".ks-sheet" });
  await page.click("[data-keymap-picker]");
  await page.waitForSelector("[data-keymap-option]");
  await page.hover('[data-keymap-option="tableplus"]');
  const head = await page.locator(".ks-sheet").boundingBox();
  await shot(page, "shortcuts-and-keymaps-keymap", { clip: { x: head.x, y: head.y, width: head.width, height: 260 }, mouse: false });
  await context.close();
}

// 3. Holding ⌘.
if (wanted("shortcuts-and-keymaps-hints")) {
  const { context, page } = await seeded({});
  await page.mouse.move(640, 1);
  await page.keyboard.down("Meta");
  await page.waitForSelector('[data-testid="cmd-hints"][data-on]', { timeout: 3000 });
  await page.waitForTimeout(400);
  await shot(page, "shortcuts-and-keymaps-hints", { mouse: false });
  await page.keyboard.up("Meta");
  await context.close();
}

// 4. The key strips on a query tab with a result.
if (wanted("shortcuts-and-keymaps-strips")) {
  const { context, page } = await seeded({});
  await page.click(`${WS} [data-testid="query-tab-add"]`);
  await page.waitForTimeout(200);
  await page.click(EDITOR);
  await page.keyboard.type("SELECT * FROM orders WHERE status = 'paid';");
  await page.keyboard.press("Meta+Enter");
  await page.waitForSelector(`${WS} [data-testid="results-grid-wrap"][data-row-count]`);
  await settle(page);
  await page.click(EDITOR);
  await page.waitForSelector('[data-key-strip="editor"]');
  await shot(page, "shortcuts-and-keymaps-strips");
  await context.close();
}

// 5. Undo after closing a query tab.
if (wanted("undo")) {
  const { context, page } = await seeded({});
  await hideKeyStrip(page);
  await hideStrips(page);
  await page.click(`${WS} [data-testid="query-tab-add"]`);
  await page.waitForTimeout(200);
  await page.click(EDITOR);
  await page.keyboard.type("SELECT * FROM customers WHERE country = 'NL';");
  // ⌘W is a menu accelerator on the Mac (no keydown reaches the page), so close it from ⌘K.
  await page.keyboard.press("Meta+k");
  await page.waitForSelector(PANEL);
  await page.keyboard.type("close query tab");
  await page.keyboard.press("Enter");
  await page.waitForSelector("[data-toast-undo]");
  await page.waitForTimeout(300);
  // The foot of the main column, where the toast sits.
  await shot(page, "undo-and-esc-toast", { clip: { x: 264, y: 600, width: 1016, height: 200 } });
  await context.close();
}

await close();
sizes();
