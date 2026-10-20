// Proves the email signup under Try Rowkery on the built site in out/, at 1440x900 and
// 390x844, in Chromium, with Kit stubbed (no real signup is sent):
//  1. the card sits right after the get-started section, and its penguin covers no text;
//  2. Subscribe posts the address to the Kit form as email_address, and the card then says to
//     confirm by email;
//  3. when Kit refuses, the card says so and keeps the address to fix.
// Needs KIT_FORM_ID in lib/site.ts (the card isn't shown without it). Writes a frame of each
// state per size, and fails on any page error.
//
//   npm run build && node scripts/follow-proof.mjs [outDir]
import { mkdir } from "node:fs/promises";
import { playwright, serveOut } from "./serve-out.mjs";

const { chromium } = playwright();
const OUT = process.argv[2] ?? "/tmp/rowkery-proof/web-follow";
const EMAIL = "ada@example.com";

await mkdir(OUT, { recursive: true });
const server = await serveOut();
const browser = await chromium.launch();
const problems = [];

for (const [w, h] of [[1440, 900], [390, 844]]) {
  const tag = `${w}x${h}`;
  const bad = (s) => problems.push(`${tag}: ${s}`);
  const page = await (await browser.newContext({ viewport: { width: w, height: h }, reducedMotion: "reduce" })).newPage();
  page.on("pageerror", (e) => bad(`page error: ${e.message}`));
  let kit = "ok";
  const posted = [];
  await page.route(/app\.kit\.com\/forms\/\d+\/subscriptions/, (route) => {
    posted.push(route.request().postData() ?? "");
    const ok = kit === "ok";
    return route.fulfill({ status: ok ? 200 : 422, contentType: "application/json", headers: { "access-control-allow-origin": "*" }, body: JSON.stringify(ok ? { status: "success" } : { status: "failed", errors: { messages: ["Email address is invalid"] } }) });
  });
  await page.goto(server.url, { waitUntil: "networkidle" });
  await page.evaluate(() => document.fonts.ready);

  // 1. Placement, and the penguin clear of the text.
  const place = await page.evaluate(() => {
    const card = document.querySelector("[data-follow]"), get = document.querySelector("#get");
    if (!card) return { missing: true };
    const R = (e) => e.getBoundingClientRect(), over = (a, b) => a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom;
    const pg = R(card.querySelector(".peek2"));
    return { after: get.nextElementSibling === card, covered: [...card.querySelectorAll("h3, p"), ...get.querySelectorAll("h3, p")].filter((t) => over(pg, R(t))).map((t) => t.textContent.slice(0, 30)) };
  });
  if (place.missing) { bad("the signup card isn't on the page (is KIT_FORM_ID set?)"); continue; }
  if (!place.after) bad("the signup card isn't right after Try Rowkery");
  for (const t of place.covered) bad(`the letter penguin covers "${t}"`);
  const card = page.locator("[data-follow]");
  await card.scrollIntoViewIfNeeded();
  await card.screenshot({ path: `${OUT}/${tag}-1-card.png` });

  // 3. Kit refuses: the error shows and the address stays.
  kit = "fail";
  await page.fill("[data-follow] input", EMAIL);
  await page.click("[data-follow] button");
  await page.waitForSelector('[data-follow-state="failed"]', { timeout: 3000 }).catch(() => bad("no error after Kit refused"));
  if ((await page.inputValue("[data-follow] input")) !== EMAIL) bad("the address was lost after Kit refused");
  await card.screenshot({ path: `${OUT}/${tag}-2-failed.png` });

  // 2. Kit accepts: the address went as email_address, and the card says to confirm.
  kit = "ok";
  await page.click("[data-follow] button");
  await page.waitForSelector('[data-follow-state="sent"]', { timeout: 3000 }).catch(() => bad("no confirm message after Subscribe"));
  if (!posted.at(-1)?.includes(EMAIL) || !posted.at(-1)?.includes('name="email_address"')) bad(`Kit didn't get email_address (${posted.at(-1)?.slice(0, 120)})`);
  await card.screenshot({ path: `${OUT}/${tag}-3-sent.png` });
}

await browser.close();
server.close();
console.log(problems.length ? `Problems:\n${problems.join("\n")}` : `All good. Frames in ${OUT}`);
process.exitCode = problems.length ? 1 : 0;
