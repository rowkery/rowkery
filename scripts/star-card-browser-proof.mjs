#!/usr/bin/env node
// The GitHub star card (starAsk.ts) with a stubbed Tauri `invoke`, on the
// docs' stub (scripts/docs-shots/lib.mjs, clock pinned to 2026-10-14). A fresh
// install shows no card, nor does a fourth day of use; the first query on a
// fifth different day shows it above the schema column's foot. Presenting
// hides it and brings it back. Star on GitHub calls `open_repo_page` once and
// ends it for good (config saves `done`); × ends it without opening anything.
// ⌘K "Star Rowkery on GitHub" opens the page any time. Light, dark, and a
// short window (nothing clipped).
//
//   cd apps/rowkery-tauri && npx vite --port 1420 &
//   node scripts/star-card-browser-proof.mjs [outDir]
import { mkdirSync } from "node:fs";
import { openApp, close, WS } from "./docs-shots/lib.mjs";

const OUT = process.argv[2] ?? "/tmp/rowkery-proof/star-card";
mkdirSync(OUT, { recursive: true });

const CARD = `${WS} [data-testid="star-card"]`;
const check = (cond, msg) => {
  if (!cond) {
    console.error(`FAIL: ${msg}`);
    process.exitCode = 1;
  } else console.log(`ok: ${msg}`);
};

/** The stub's extension: config.json holds `star` (or nothing); records opens and saves. */
const more = (star) => `(() => {
  const star = ${JSON.stringify(star ?? null)};
  window.__OPENED__ = 0;
  window.__SAVED__ = null;
  window.__STUB_MORE__ = async (cmd, a) => {
    if (cmd === "load_ui_state") return { version: 1, keys: star ? { "rowkery.starAsk": star } : {} };
    if (cmd === "save_ui_state") { window.__SAVED__ = a.ui.keys["rowkery.starAsk"] ?? null; return null; }
    if (cmd === "open_repo_page") { window.__OPENED__++; return null; }
    return undefined;
  };
})()`;

async function open(star, o = {}) {
  const { page, context } = await openApp({ more: more(star), scheme: "light", ...o });
  await page.waitForTimeout(300);
  return { page, context };
}
const visible = (page) => page.locator(CARD).count().then((n) => n > 0);

// A fresh install: one query on day one is no reason to ask.
{
  const { page, context } = await open(null);
  check(!(await visible(page)), "fresh install: no card after the first query");
  await context.close();
}

// Already counted today as the fourth day: still nothing.
{
  const { page, context } = await open({ days: 4, lastDay: "2026-10-14" });
  check(!(await visible(page)), "fourth day of use: no card");
  await context.close();
}

// Four days counted before today: today's first query (opening orders) makes five.
{
  const { page, context } = await open({ days: 4, lastDay: "2026-10-13" });
  await page.waitForSelector(CARD);
  check(true, "fifth day: the card shows after the day's first query");
  const card = await page.locator(CARD).boundingBox();
  const foot = await page.locator(`${WS} [data-testid="sb-foot-rows"]`).boundingBox();
  check(card.y + card.height <= foot.y + 1, "the card sits above the foot's row");
  await page.mouse.move(640, 1);
  await page.screenshot({ path: `${OUT}/1-card-light.png` });

  // Presenting hides it (a shared screen); off brings it back.
  await page.click(`${WS} [data-testid="sb-presenting"]`);
  check(!(await visible(page)), "Presenting hides the card");
  await page.click(`${WS} [data-testid="sb-presenting"]`);
  check(await visible(page), "Presenting off: the card is back");

  await page.click(`${CARD} [data-testid="star-go"]`);
  check(!(await visible(page)), "Star on GitHub: the card goes");
  check((await page.evaluate(() => window.__OPENED__)) === 1, "Star on GitHub calls open_repo_page once");
  await page.waitForFunction(() => window.__SAVED__?.done === true, null, { timeout: 3000 });
  check(true, "config.json saves done");
  await context.close();
}

// × ends it without opening anything.
{
  const { page, context } = await open({ days: 5, lastDay: "2026-10-10" });
  await page.waitForSelector(CARD);
  await page.click(`${CARD} [data-testid="star-dismiss"]`);
  check(!(await visible(page)), "×: the card goes");
  check((await page.evaluate(() => window.__OPENED__)) === 0, "× opens nothing");
  await page.waitForFunction(() => window.__SAVED__?.done === true, null, { timeout: 3000 });
  check(true, "× saves done too");

  // ⌘K keeps a way to the page after the card is gone.
  await page.keyboard.press("Meta+k");
  await page.waitForSelector('[data-testid="cp-row"]');
  await page.keyboard.type("star rowkery");
  await page.waitForSelector('[data-item="cmd:star-on-github"]');
  await page.keyboard.press("Enter");
  await page.waitForFunction(() => window.__OPENED__ === 1, null, { timeout: 3000 });
  check(true, "⌘K Star Rowkery on GitHub opens the page");
  check(!(await visible(page)), "the card stays gone");
  await context.close();
}

// Done stays done.
{
  const { page, context } = await open({ days: 5, lastDay: "2026-10-10", done: true });
  check(!(await visible(page)), "a dismissed card never comes back");
  await context.close();
}

// Dark, and a short window.
{
  const { page, context } = await open({ days: 5, lastDay: "2026-10-10" }, { scheme: "dark" });
  await page.waitForSelector(CARD);
  await page.mouse.move(640, 1);
  await page.screenshot({ path: `${OUT}/2-card-dark.png` });
  await context.close();
}
{
  const { page, context } = await open({ days: 5, lastDay: "2026-10-10" }, { w: 900, h: 560 });
  await page.waitForSelector(CARD);
  const clipped = await page.$$eval(`${CARD} *`, (els) => els.some((e) => e.scrollWidth > e.clientWidth + 1));
  check(!clipped, "short window: nothing in the card is clipped");
  await page.mouse.move(640, 1);
  await page.screenshot({ path: `${OUT}/3-card-short-window.png` });
  await context.close();
}

await close();
