// Proves the story on the built site (out/) at 1440x900 and 390x844, in Chromium: scrolls to
// each named moment (scripts/story.mjs), waits for the scene to settle, photographs it, and
// checks what should show there: the chapter in the nav, the lit caption, the title, the big
// word on the white page, the close in full view below the nav, and the phone's dock stepping
// aside once the close is in view. Then a contact sheet per size. Fails on any page error.
//
//   npm run build && node scripts/story-proof.mjs [outDir]
import { mkdir, readFile } from "node:fs/promises";
import { playwright, serveOut } from "./serve-out.mjs";
import { MOMENTS, goTo } from "./story.mjs";

const { chromium } = playwright();
const OUT = process.argv[2] ?? "/tmp/rowkery-proof/web-story";
const CHAPTERS = { agent: "With your agent", security: "Security", keys: "On your own", free: "For everyone" };

await mkdir(OUT, { recursive: true });
const server = await serveOut();
const browser = await chromium.launch();
const problems = [];

for (const [w, h] of [[1440, 900], [390, 844]]) {
  const tag = `${w}x${h}`;
  const bad = (s) => problems.push(`${tag}: ${s}`);
  const phone = w < 600;
  const page = await browser.newPage({ viewport: { width: w, height: h }, isMobile: phone, hasTouch: phone });
  page.on("pageerror", (e) => bad(`page error: ${e.message}`));
  await page.goto(server.url, { waitUntil: "networkidle" });
  await page.evaluate(() => document.fonts.ready);
  await page.waitForTimeout(2200);
  const shots = [];
  for (const [i, m] of MOMENTS.entries()) {
    await goTo(page, m);
    const file = `${OUT}/${tag}-${String(i + 1).padStart(2, "0")}-${m.name}.png`;
    await page.screenshot({ path: file });
    shots.push([m.name, file]);
    const seen = await page.evaluate(() => {
      const onScreen = (e) => { const r = e.getBoundingClientRect(); return r.bottom > 0 && r.top < innerHeight; };
      const shown = (e) => e && e.getClientRects().length && onScreen(e) && getComputedStyle(e).visibility !== "hidden" && Number(getComputedStyle(e).opacity) > 0.9;
      const on = [...document.querySelectorAll(".cap.on")].filter(shown);
      const whole = (t) => [...t.querySelectorAll(".w")].every((w) => Number(getComputedStyle(w).opacity) > 0.9);
      const title = [...document.querySelectorAll(".title")].find((t) => onScreen(t) && [...t.querySelectorAll(".w")].some((w) => Number(getComputedStyle(w).opacity) > 0.1));
      const big = [...document.querySelectorAll(".big")].find((t) => onScreen(t) && whole(t));
      const nav = document.querySelector("[data-nav]").getBoundingClientRect();
      const close = document.querySelector("#get .c-mid").getBoundingClientRect();
      const dock = document.querySelector("[data-dock]");
      return {
        caps: on.map((c) => c.querySelector("h3").textContent),
        chapter: document.querySelector(".chapter.on .ch-t")?.textContent ?? "",
        title: title ? title.textContent.replace(/\s+/g, " ").trim() : "",
        titleWhole: title ? whole(title) : false,
        big: big ? big.textContent.trim() : "",
        closeTop: close.top - nav.bottom,
        closeBottom: innerHeight - close.bottom,
        dock: getComputedStyle(dock).display !== "none" && dock.classList.contains("on"),
      };
    });
    if (m.scene && seen.chapter !== CHAPTERS[m.scene]) bad(`${m.name}: the nav says "${seen.chapter}", not "${CHAPTERS[m.scene]}"`);
    if (m.cap && (seen.caps.length !== 1 || seen.caps[0] !== m.cap)) bad(`${m.name}: the lit caption is ${JSON.stringify(seen.caps)}, not "${m.cap}"`);
    if (m.title && (seen.title !== m.title || !seen.titleWhole)) bad(`${m.name}: the title shows "${seen.title}" (whole: ${seen.titleWhole})`);
    if (m.word && seen.big !== m.word) bad(`${m.name}: the white page says "${seen.big}", not "${m.word}"`);
    if (m.name === "get") {
      if (seen.closeTop < 0) bad(`get: the close starts ${-seen.closeTop}px under the nav`);
      if (seen.closeBottom < 0) bad(`get: the close runs ${-seen.closeBottom}px past the foot of the screen`);
      if (seen.dock) bad("get: the dock is still up with the close in view");
    }
    if (phone && m.name === "agent-asks" && !seen.dock) bad("agent-asks: the phone's dock isn't up");
  }
  const sheet = await browser.newPage({ viewport: { width: 1800, height: 1000 } });
  const imgs = await Promise.all(shots.map(async ([n, f]) => [n, (await readFile(f)).toString("base64")]));
  await sheet.setContent(`<body style="margin:0;background:#666;font:14px sans-serif;color:#fff"><div style="display:grid;grid-template-columns:repeat(${phone ? 7 : 4},1fr);gap:8px;padding:8px">${imgs.map(([n, b]) => `<figure style="margin:0"><img src="data:image/png;base64,${b}" style="width:100%;display:block"><figcaption>${n}</figcaption></figure>`).join("")}</div></body>`);
  await sheet.screenshot({ path: `${OUT}/sheet-${tag}.png`, fullPage: true });
  await sheet.close();
  await page.close();
  console.log(`${tag}: ${MOMENTS.length} moments`);
}

await browser.close();
server.close();
console.log(problems.length ? `Problems:\n${problems.join("\n")}` : `All good. Frames in ${OUT}`);
process.exitCode = problems.length ? 1 : 0;
