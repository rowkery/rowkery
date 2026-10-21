// Proves the hero's flight on the built site (out/), in Chromium. The hero holds its screen
// while the logo flies into the brand in the nav, so nothing has to make up for the scroll:
//  1. scrolling through the flight in twentieths, the held screen's top stays at 0;
//  2. just before it hides, the logo's body lands on the body of the brand's mark, in place and
//     size, within 1 px (the mark's box, `.nav .brand .mk`, is the mark's view box, with a little
//     room around the body, so against the box it is printed, not judged);
//  3. the logo is the plain mark: no props drawn and no hop on it;
//  4. the held screen sits above the nav (so the logo lands on it) but lets the pointer through:
//     the nav's links and the hero's own buttons still take a click.
//  5. one logo at a time: the brand's own mark shows at rest, fades out while the logo flies,
//     and is there at full strength in the very frame the logo lands and hides.
// At 390x844, 375x667 and 1440x900; frames at progress 0, 0.25, 0.5, 0.75, 0.95 and 1 at
// 390x844 and 1440x900. Fails on any page error.
//
//   npm run build && node scripts/flight-proof.mjs [outDir]
import { mkdir } from "node:fs/promises";
import { playwright, serveOut } from "./serve-out.mjs";
import { COUNT_FRAMES, settle } from "./story.mjs";

const { chromium } = playwright();
const OUT = process.argv[2] ?? "/tmp/rowkery-proof/web-flight";
await mkdir(OUT, { recursive: true });
const server = await serveOut();
const browser = await chromium.launch();
const problems = [];

for (const [w, h] of [[390, 844], [375, 667], [1440, 900]]) {
  const tag = `${w}x${h}`;
  const bad = (s) => problems.push(`${tag}: ${s}`);
  const phone = w < 600;
  const page = await browser.newPage({ viewport: { width: w, height: h }, isMobile: phone, hasTouch: phone });
  page.on("pageerror", (e) => bad(`page error: ${e.message}`));
  await page.addInitScript(COUNT_FRAMES);
  await page.goto(server.url, { waitUntil: "networkidle" });
  await page.evaluate(() => document.fonts.ready);
  await page.waitForTimeout(2200);
  const FLY = await page.evaluate(() => document.querySelector("[data-hero]").offsetHeight - document.querySelector(".h-pin").offsetHeight);
  const to = (y) => page.evaluate((y) => scrollTo({ top: y, behavior: "instant" }), Math.round(y));

  // 1. The screen holds.
  const tops = [];
  for (let i = 0; i <= 20; i++) {
    await to((FLY * i) / 20);
    tops.push(await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => r(document.querySelector(".h-pin").getBoundingClientRect().top)))));
  }
  if (tops.some((t) => Math.abs(t) > 0.5)) bad(`the hero's screen moved during the flight: tops ${tops.map(Math.round).join(", ")}`);

  // 3. The plain mark.
  const plain = await page.evaluate(() => {
    const hpg = document.querySelector(".hpg");
    return { props: hpg.querySelectorAll(".prop, [data-p], .hp").length, hops: hpg.querySelectorAll(".hopper").length };
  });
  if (plain.props || plain.hops) bad(`the hero's logo isn't the plain mark (${JSON.stringify(plain)})`);

  // 4. The pointer reaches the nav and the hero's buttons.
  await to(0);
  await settle(page);
  const hits = await page.evaluate(() =>
    [".nav .brand", ...(innerWidth > 860 ? [".nav .dl"] : []), ".hero .ctas .btn"].map((sel) => {
      const el = document.querySelector(sel), r = el.getBoundingClientRect();
      return [sel, el.contains(document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2))];
    }),
  );
  for (const [sel, ok] of hits) if (!ok) bad(`${sel} doesn't take a click with the hero held`);

  // 2. The landing, a pixel of scroll before the end.
  await to(FLY - 1);
  await settle(page);
  const land = await page.evaluate(() => {
    const box = (e) => e.getBoundingClientRect();
    const hpg = document.querySelector(".hpg"), body = box(hpg.querySelector("path")), mark = box(document.querySelector(".nav .brand .mk path")), mk = box(document.querySelector(".nav .brand .mk"));
    const off = (a, b) => Math.max(Math.abs(a.left - b.left), Math.abs(a.top - b.top), Math.abs(a.width - b.width), Math.abs(a.height - b.height));
    return { shows: getComputedStyle(hpg).visibility === "visible", onMark: off(body, mark), onBox: off(body, mk), body: [body.left, body.top, body.width, body.height].map((v) => +v.toFixed(2)) };
  });
  if (!land.shows) bad("the logo hid before it landed");
  if (land.onMark > 1) bad(`the logo lands ${land.onMark.toFixed(2)} px off the brand's mark (${land.body})`);
  console.log(`${tag}: screen held at ${tops.length} steps (max ${Math.max(...tops.map(Math.abs)).toFixed(2)} px), lands ${land.onMark.toFixed(2)} px off the brand's mark (its box .nav .brand .mk, view box and all: ${land.onBox.toFixed(2)} px)`);

  // 5. One logo at a time.
  for (const [p, want] of [[0, true], [0.5, false], [(FLY - 1) / FLY, false], [1, true]]) {
    await to(FLY * p);
    await settle(page);
    const o = await page.evaluate(() => +getComputedStyle(document.querySelector(".nav .brand .mk")).opacity);
    if (want ? o < 0.99 : o > 0.01) bad(`the brand's mark is at opacity ${o} at ${p.toFixed(3)} of the flight`);
  }
  await to(FLY - 1);
  await settle(page);
  await to(FLY);
  const swap = await page.evaluate(
    () =>
      new Promise((done) => {
        const hpg = document.querySelector(".hpg"), mk = document.querySelector(".nav .brand .mk");
        const look = () => (getComputedStyle(hpg).visibility === "hidden" ? done(+getComputedStyle(mk).opacity) : requestAnimationFrame(look));
        look();
      }),
  );
  if (swap < 0.99) bad(`the brand's mark fades in after the landing (opacity ${swap} as the logo hides)`);

  // Frames of the flight.
  if (h !== 667)
    for (const p of [0, 0.25, 0.5, 0.75, 0.95, 1]) {
      await to(FLY * p);
      await settle(page);
      await page.screenshot({ path: `${OUT}/${tag}-${String(p).replace(".", "")}.png` });
    }
  await page.close();
}

await browser.close();
server.close();
console.log(problems.length ? `Problems:\n${problems.join("\n")}` : `All good. Frames in ${OUT}`);
process.exitCode = problems.length ? 1 : 0;
