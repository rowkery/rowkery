// Proves the 2026-10-20 redesign (the omlx.ai / deno.com mock, Gabarito headings) on the built
// site in out/, at 1440x900 and 390x844, in Chromium:
//  1. headings are set in Gabarito and body text in IBM Plex Sans, with no side rails;
//  2. the sections run agent, security, keyboard (2026-10-16: agent first), then databases,
//     FAQ, get started and the rookery;
//  3. the connect card: each agent tab shows its own setup (Claude Code's command, Claude
//     Desktop's and Cursor's config entry) and Copy puts it on the clipboard; tapping the
//     penguin gives its bubble a new line;
//  4. the agent scene: scrolling each step to the middle of the screen shows its panel (the
//     query typed in full, the checks ending on a sensitive column, masked stand-ins, the change waiting for
//     Commit);
//  5. the keyboard: clicking a chord shows its view and the keycap takes its label; left alone,
//     the next chord plays by itself;
//  6. the close: the unquarantine command copies; typing "rookery" sends a parade across.
// Writes frames of each moment per size, and fails on any page error.
//
//   npm run build && node scripts/redesign-proof.mjs [outDir]
import { mkdir } from "node:fs/promises";
import { playwright, serveOut } from "./serve-out.mjs";

const { chromium } = playwright();
const OUT = process.argv[2] ?? "/tmp/rowkery-proof/web-redesign";
const UNQUARANTINE = "xattr -dr com.apple.quarantine /Applications/Rowkery.app";

await mkdir(OUT, { recursive: true });
const server = await serveOut();
const browser = await chromium.launch();
const problems = [];

for (const [w, h] of [[1440, 900], [390, 844]]) {
  const tag = `${w}x${h}`;
  const bad = (s) => problems.push(`${tag}: ${s}`);
  const ctx = await browser.newContext({ viewport: { width: w, height: h }, permissions: ["clipboard-read", "clipboard-write"] });
  const page = await ctx.newPage();
  page.on("pageerror", (e) => bad(`page error: ${e.message}`));
  await page.goto(server.url, { waitUntil: "networkidle" });
  await page.evaluate(() => document.fonts.ready);
  await page.waitForTimeout(2600);
  const shot = (name) => page.screenshot({ path: `${OUT}/${tag}-${name}.png` });
  const to = (sel, off = 0) => page.evaluate(([s, o]) => scrollTo({ top: document.querySelector(s).getBoundingClientRect().top + scrollY + o, behavior: "instant" }), [sel, off]);
  const clip = () => page.evaluate(() => navigator.clipboard.readText());

  // 1. Fonts: the file behind each element's first family (next/font renames the families,
  // but its files keep the source file's name before the hash), and no side rails.
  const fonts = await page.evaluate(() => {
    const faces = [...document.styleSheets].flatMap((s) => [...s.cssRules]).filter((r) => r instanceof CSSFontFaceRule);
    const file = (sel) => {
      const family = getComputedStyle(document.querySelector(sel)).fontFamily.split(",")[0].replace(/['"]/g, "").trim();
      const face = faces.find((f) => f.style.getPropertyValue("font-family").replace(/['"]/g, "").trim() === family);
      return face?.style.getPropertyValue("src") ?? "none";
    };
    return { h1: file(".h1"), h2: file(".h2"), body: file(".lead"), rails: getComputedStyle(document.querySelector(".sheet")).borderLeftWidth };
  });
  if (!fonts.h1.includes("gabarito") || !fonts.h2.includes("gabarito")) bad(`the headings aren't in Gabarito (${fonts.h1})`);
  if (!fonts.body.includes("ibm_plex_sans")) bad(`body text isn't IBM Plex Sans (${fonts.body})`);
  if (fonts.rails !== "0px") bad("the sheet has side rails");
  await shot("1-hero");

  // 2. The order of the sections.
  const order = await page.evaluate(() => ["#agents", "#security", "#keys", "#databases", "#faq", "#get", ".rookery"].map((s) => document.querySelector(s).getBoundingClientRect().top));
  if (order.some((t, i) => i && t <= order[i - 1])) bad("the sections are out of order");

  // 3. The connect card.
  for (const [id, want] of [["code", "claude mcp add --scope user rowkery"], ["desktop", '"args": ["--mcp"]'], ["cursor", '"args": ["--mcp"]']]) {
    await page.click(`[data-client="${id}"]`);
    const text = await page.locator(".connect .code").innerText();
    if (!text.includes(want)) bad(`the ${id} tab doesn't show its setup`);
    if (id !== "code" && !text.includes(id === "desktop" ? "claude_desktop_config.json" : ".cursor/mcp.json")) bad(`the ${id} tab doesn't name its config file`);
    await page.click(".connect [data-copy]");
    if (!(await clip()).includes(want)) bad(`Copy on the ${id} tab didn't copy its setup`);
  }
  await page.click('[data-client="code"]');
  // The line showing: the bubbles are stacked and take turns.
  const said = () => page.evaluate(() => [...document.querySelectorAll(".bubble")].find((b) => Number(getComputedStyle(b).opacity) > 0.5)?.textContent);
  const before = await said();
  await page.click("[data-peek]");
  await page.waitForTimeout(500);
  const after = await said();
  if (!after || after === before) bad(`tapping the penguin didn't change its line (${before} → ${after})`);
  await shot("2-connect");

  // 4. The agent scene, step by step.
  const PANELS = ["SELECT", "stand-in", "masked:", "Commit"];
  for (let i = 0; i < 4; i++) {
    await page.evaluate((i) => {
      const s = document.querySelector(`.step[data-step="${i}"]`);
      const r = s.getBoundingClientRect();
      scrollTo({ top: r.top + scrollY + r.height / 2 - innerHeight / 2, behavior: "instant" });
    }, i);
    await page.waitForTimeout(2200);
    const on = await page.locator(".panel.on").innerText();
    // The agent's SQL types out in full.
    if (i === 0 && (await page.locator(".typing").evaluate((e) => e.scrollWidth > e.clientWidth + 1))) bad("the agent's SQL stops typing before its end");
    if (!on.includes(PANELS[i])) bad(`step ${i + 1} doesn't show its panel (${on.slice(0, 40)})`);
    if ((await page.locator(".step.on").getAttribute("data-step")) !== String(i)) bad(`step ${i + 1} isn't the lit one`);
    await shot(`3-agents-step${i + 1}`);
  }

  // 5. The keyboard.
  await to("#keys", -80);
  await page.waitForTimeout(600);
  await page.click('[data-chord="4"]');
  await page.waitForTimeout(1200);
  if (!(await page.locator(".view.on").innerText()).includes("Seq Scan")) bad("⌘E didn't show the plan");
  if ((await page.locator(".bigkey").innerText()) !== "⌘E") bad("the keycap didn't take ⌘E");
  await shot("4-keys-plan");
  await page.mouse.move(1, 1);
  await page.waitForTimeout(4200);
  if ((await page.locator('.chord[aria-selected="true"]').getAttribute("data-chord")) !== "5") bad("the next chord didn't play by itself");

  // 6. The close.
  await to("#get", -80);
  await page.click('[data-get="mac"] [data-copy]');
  if ((await clip()) !== UNQUARANTINE) bad("the unquarantine command didn't copy");
  await shot("5-get");
  await to(".rookery", -60);
  await page.keyboard.type("rookery");
  await page.waitForTimeout(1800);
  if ((await page.locator(".parade .marcher").count()) !== 11) bad("typing rookery didn't send the parade");
  await shot("6-rookery-parade");
  await ctx.close();
}

await browser.close();
server.close();
console.log(problems.length ? `Problems:\n${problems.join("\n")}` : `All good. Frames in ${OUT}`);
process.exitCode = problems.length ? 1 : 0;
