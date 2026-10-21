// Proves the 2026-10-21 story redesign on the built site in out/, at 1440x900 and 390x844, in
// Chromium:
//  1. titles are set in Gabarito and body text in IBM Plex Sans;
//  2. every word is in the page as served (captions, titles, the facts, the close, the FAQ), so
//     it shows without scripts and gets indexed, and no millisecond figure or offline claim;
//  3. the sections run hero, agent, security, keyboard, for everyone, the close, connect your
//     agent, the questions, the signup and the foot;
//  4. the hero: a mouse across it picks the penguin's job (a tap moves to the next), and See how
//     it works lands in the agent scene;
//  5. the keyboard: each step presses its own chord and the penguin rides the last key;
//  6. the white page: a disc jumps to its fact;
//  7. the close: the unquarantine command copies, and on a phone the dock is up in the story and
//     steps aside for the close;
//  8. connect your agent: each tab shows its own setup and Copy puts it on the clipboard; the
//     questions open and close;
//  9. typing "rookery" sends a parade across.
// Writes frames of each moment per size, and fails on any page error.
//
//   npm run build && node scripts/redesign-proof.mjs [outDir]
import { mkdir, readFile } from "node:fs/promises";
import { playwright, serveOut } from "./serve-out.mjs";
import { MOMENTS, goTo } from "./story.mjs";

const { chromium } = playwright();
const OUT = process.argv[2] ?? "/tmp/rowkery-proof/web-redesign";
const UNQUARANTINE = "xattr -dr com.apple.quarantine /Applications/Rowkery.app";
const at = (name) => MOMENTS.find((m) => m.name === name);

await mkdir(OUT, { recursive: true });
const server = await serveOut();
const browser = await chromium.launch();
const problems = [];

// 2. The words, in the HTML as served.
{
  const html = (await readFile(new URL("../out/index.html", import.meta.url), "utf8")).replace(/<!-- -->/g, "").replace(/&#x27;/g, "'").replace(/&quot;/g, '"').replace(/&amp;/g, "&");
  const text = html.replace(/<script[\s\S]*?<\/script>/g, "").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ");
  const WORDS = [
    "Meet", "Postgres and SQLite on your Mac,", "Let your AI agent", "read your database", "Your agent asks", "A SELECT goes to Rowkery, on your Mac.",
    "Shared tables only, read-only, 1,000 rows at most, 10 seconds.", "Changes wait for you", "Security first", "Only the tables you share",
    "Agents get a masked host, never the user or password.", "Built for the keyboard", "Jump anywhere", "Review, then Commit", "Free.", "Open source.",
    "No account.", "No paid tier", "Apache 2.0", "Nothing to sign up for", "Get", "Free for your Mac, on Apple silicon and Intel.", UNQUARANTINE,
    "Connect your agent", "claude mcp add --scope user rowkery", "Common questions", "Do I need an AI agent?", "No. Everything works on your own, from the keyboard.",
  ];
  for (const w of WORDS) if (!text.includes(w)) problems.push(`the served page is missing "${w}"`);
  if (/\b\d+\s?ms\b/.test(text)) problems.push(`the page quotes a millisecond figure: ${text.match(/.{30}\b\d+\s?ms\b.{10}/)?.[0]}`);
  if (/offline/i.test(text)) problems.push("the page claims something offline");
}

for (const [w, h] of [[1440, 900], [390, 844]]) {
  const tag = `${w}x${h}`;
  const bad = (s) => problems.push(`${tag}: ${s}`);
  const phone = w < 600;
  const ctx = await browser.newContext({ viewport: { width: w, height: h }, isMobile: phone, hasTouch: phone, permissions: ["clipboard-read", "clipboard-write"] });
  const page = await ctx.newPage();
  page.on("pageerror", (e) => bad(`page error: ${e.message}`));
  await page.goto(server.url, { waitUntil: "networkidle" });
  await page.evaluate(() => document.fonts.ready);
  await page.waitForTimeout(2600);
  const shot = (name) => page.screenshot({ path: `${OUT}/${tag}-${name}.png` });
  const clip = () => page.evaluate(() => navigator.clipboard.readText());
  const job = () => page.evaluate(() => [...document.querySelectorAll(".job")].find((j) => Number(getComputedStyle(j).opacity) > 0.9)?.textContent);

  // 1. Fonts: the file behind each element's first family (next/font renames the families,
  // but its files keep the source file's name before the hash).
  const fonts = await page.evaluate(() => {
    const faces = [...document.styleSheets].flatMap((s) => [...s.cssRules]).filter((r) => r instanceof CSSFontFaceRule);
    const file = (sel) => {
      const family = getComputedStyle(document.querySelector(sel)).fontFamily.split(",")[0].replace(/['"]/g, "").trim();
      return faces.find((f) => f.style.getPropertyValue("font-family").replace(/['"]/g, "").trim() === family)?.style.getPropertyValue("src") ?? "none";
    };
    return { title: file(".h-title"), scene: file(".title"), body: file(".cap p") };
  });
  if (!fonts.title.includes("gabarito") || !fonts.scene.includes("gabarito")) bad(`the titles aren't in Gabarito (${fonts.title})`);
  if (!fonts.body.includes("ibm_plex_sans")) bad(`body text isn't IBM Plex Sans (${fonts.body})`);

  // 3. The order of the sections.
  const order = await page.evaluate(() => ["#hero", "#agents", "#security", "#keys", "#free", "#get", "#connect", "#faq", "[data-follow]", "footer"].map((s) => document.querySelector(s)?.getBoundingClientRect().top ?? NaN));
  if (order.some((t, i) => Number.isNaN(t) || (i && t < order[i - 1]))) bad(`the sections are out of order (${order.map(Math.round)})`);

  // 4. The hero's jobs, and the way into the story.
  if (phone) {
    const before = await job();
    await page.tap(".hero .h-mid");
    await page.waitForTimeout(700);
    const after = await job();
    if (!after || after === before) bad(`a tap didn't move the penguin to its next job (${before} → ${after})`);
  } else {
    await page.mouse.move(w - 20, h / 2);
    await page.waitForTimeout(900);
    if ((await job()) !== "Free and open source") bad(`the mouse at the right didn't pick the last job (${await job()})`);
    await page.mouse.move(20, h / 2);
    await page.waitForTimeout(900);
    if ((await job()) !== "Taking your agent’s query") bad(`the mouse at the left didn't pick the first job (${await job()})`);
  }
  await shot("1-hero");
  await page.click("[data-jump]");
  await page.waitForTimeout(2500);
  const landed = await page.evaluate(() => {
    const r = document.querySelector("#agents").getBoundingClientRect();
    return r.top <= 1 && r.bottom >= innerHeight;
  });
  if (!landed) bad("See how it works didn't land in the agent scene");
  if (phone && !(await page.locator("[data-dock].on").count())) bad("the dock isn't up in the story");

  // 5. The keyboard: each step presses its chord.
  for (const [name, key, shift] of [["keys-jump", "K", false], ["keys-run", "↵", false], ["keys-review", "P", true]]) {
    await goTo(page, at(name));
    const k = await page.evaluate(() => ({
      key: document.querySelector(".k-last .kl").textContent,
      shift: getComputedStyle(document.querySelector(".k-shift")).display !== "none",
      pressed: /\bp[ab]\b/.test(document.querySelector(".keys").className),
      rides: !!document.querySelector(".k-last [data-pg=keys]"),
    }));
    if (k.key !== key || k.shift !== shift || !k.pressed || !k.rides) bad(`${name}: the keys show ${JSON.stringify(k)}`);
    await shot(`2-${name}`);
  }

  // 6. A disc jumps to its fact.
  await goTo(page, at("free"));
  await page.click('[data-disc="2"]');
  await page.waitForTimeout(2600);
  const fact = await page.evaluate(() => [...document.querySelectorAll(".big")].find((b) => [...b.querySelectorAll(".w")].every((w) => Number(getComputedStyle(w).opacity) > 0.9))?.textContent);
  if (fact !== "No account.") bad(`the No account disc showed "${fact}"`);
  await shot("3-disc");

  // 7. The close.
  await goTo(page, at("get"));
  await page.click('[data-get="mac"] [data-copy]');
  if ((await clip()) !== UNQUARANTINE) bad("the unquarantine command didn't copy");
  if (phone && (await page.locator("[data-dock].on").count())) bad("the dock didn't step aside for the close");
  await shot("4-get");

  // 8. Connect your agent, and the questions.
  await page.locator("#connect").scrollIntoViewIfNeeded();
  for (const [id, want] of [["code", "claude mcp add --scope user rowkery"], ["desktop", '"args": ["--mcp"]'], ["cursor", '"args": ["--mcp"]']]) {
    await page.click(`[data-client="${id}"]`);
    const text = await page.locator(".connect .code").innerText();
    if (!text.includes(want)) bad(`the ${id} tab doesn't show its setup`);
    if (id !== "code" && !text.includes(id === "desktop" ? "claude_desktop_config.json" : ".cursor/mcp.json")) bad(`the ${id} tab doesn't name its config file`);
    await page.click(".connect [data-copy]");
    if (!(await clip()).includes(want)) bad(`Copy on the ${id} tab didn't copy its setup`);
  }
  await page.click('[data-client="code"]');
  const open = () => page.evaluate(() => [...document.querySelectorAll("#faq details")].map((d) => d.open));
  if ((await open()).join() !== "true,false,false,false") bad("the first question isn't the one open");
  await page.locator("#faq summary").nth(2).click();
  if (!(await open())[2]) bad("a question didn't open");
  await shot("5-more");

  // 9. The parade.
  await page.keyboard.type("rookery");
  await page.waitForTimeout(1800);
  if ((await page.locator(".parade .marcher").count()) !== 11) bad("typing rookery didn't send the parade");
  await shot("6-parade");
  await ctx.close();
}

await browser.close();
server.close();
console.log(problems.length ? `Problems:\n${problems.join("\n")}` : `All good. Frames in ${OUT}`);
process.exitCode = problems.length ? 1 : 0;
