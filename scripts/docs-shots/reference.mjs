#!/usr/bin/env node
// Docs screens for the Help and Reference pages (docs.rowkery.com/troubleshooting/), from the
// running app (Vite, the stubbed Tauri `invoke` of ./lib.mjs), drawn as a Mac draws it, dark:
//  - troubleshooting-couldnt-connect: a window whose connection the server refused (wrong
//    password): the tilted penguin, core's cause line, the raw error, Retry · Edit… · Report…;
//  - troubleshooting-report: Report… from there opens Report an issue, with the error included
//    and the user masked, as a release build shows it. A release build has the report relay's
//    URL built in (VITE_ROWKERY_REPORT_URL); the dev server here has none, so the page's
//    report.ts is served with a stand-in URL (nothing is sent: the sheet is only shown).
//
//   cd apps/rowkery-tauri && npx vite --port 1420 &
//   node scripts/docs-shots/reference.mjs [outDir] [--write] [--only=report]
import { openApp, shot, close, sizes, WS } from "./lib.mjs";

/** The stored password is wrong: every connect fails the way Postgres says so. */
function more() {
  window.__STUB_MORE__ = async (cmd) => {
    switch (cmd) {
      case "open_window":
        throw 'password authentication failed for user "app"';
      case "explain_connect_error":
        return { class: "auth", cause: "The server rejected the password for app.", field: "password" };
      case "app_info":
        return { version: "0.1.0", os: "macos", os_version: "15.5", arch: "aarch64" };
      default:
        return undefined;
    }
  };
}

const { context, page } = await openApp({ w: 1280, h: 800, connect: false, more });

// As a release build: the relay URL is set at build time.
await page.route(/\/src\/report\.ts(\?.*)?$/, async (route) => {
  const res = await route.fetch();
  const body = (await res.text()).replace(
    "import.meta.env.VITE_ROWKERY_REPORT_URL",
    JSON.stringify("https://report-relay.invalid/report"),
  );
  await route.fulfill({ response: res, body });
});
await page.reload();
await page.waitForSelector(WS);
await page.evaluate(() => document.fonts.ready);

await page.keyboard.press("Meta+Shift+O");
await page.waitForSelector('[data-testid="conn-popover"]');
await page.click('[data-conn-id="prd"]');
await page.waitForSelector(`${WS} [data-connect-error] [data-cause]`);
await page.waitForTimeout(300);

// From the penguin to the buttons, without the empty column below them.
const block = await page.locator(`${WS} [data-connect-error] .ew-block`).boundingBox();
const actions = await page.locator(`${WS} [data-connect-error] .ew-error-actions`).boundingBox();
const pad = 28;
await shot(page, "troubleshooting-couldnt-connect", {
  clip: { x: block.x - pad, y: block.y - pad, width: Math.ceil(block.width + pad * 2), height: Math.ceil(actions.y + actions.height - block.y + pad * 2) },
});

await page.click(`${WS} [data-testid="sb-report"]`);
await page.waitForSelector('[data-testid="rp-sheet"][data-relay="on"]');
await page.keyboard.type("Rowkery says the password is wrong, but the same password works in psql.", { delay: 0 });
await shot(page, "troubleshooting-report", { el: '[data-testid="rp-sheet"]', pad: 0 });

await context.close();
await close();
sizes();
