// Profiles scrolling the built site (out/) in Chromium: wheels from the top to the foot at a
// steady pace and reports dropped frames, long tasks, and the main-thread layout, paint and
// style work per second, both while scrolling and while the page sits still (what the looping
// animations cost on their own). Fails if the page lays out or paints on its own while it sits
// still: every loop must move only transform and opacity. Chromium only: Safari's compositor
// is not measured, and headless frame pacing is a rough guide, not what a Mac shows.
//
//   npm run build && node scripts/scroll-profile.mjs
//
// Env: THROTTLE=4 slows the CPU (default 4, to stand in for a busy laptop); W, H for the window.
import { playwright, serveOut } from "./serve-out.mjs";

const { chromium } = playwright();
const THROTTLE = Number(process.env.THROTTLE ?? 4);
const W = Number(process.env.W ?? 1440), H = Number(process.env.H ?? 900);
const server = await serveOut();
const browser = await chromium.launch({ args: ["--enable-gpu-rasterization", "--ignore-gpu-blocklist"] });
const page = await browser.newPage({ viewport: { width: W, height: H }, deviceScaleFactor: 2 });
const cdp = await page.context().newCDPSession(page);
await page.goto(server.url, { waitUntil: "networkidle" });
await page.waitForTimeout(1500);
await cdp.send("Emulation.setCPUThrottlingRate", { rate: THROTTLE });

async function trace(fn) {
  const events = [];
  cdp.on("Tracing.dataCollected", (d) => events.push(...d.value));
  const done = new Promise((r) => cdp.once("Tracing.tracingComplete", r));
  await cdp.send("Tracing.start", { categories: "devtools.timeline,disabled-by-default-devtools.timeline.frame,blink.user_timing,benchmark,toplevel", transferMode: "ReportEvents" });
  const t0 = Date.now();
  await fn();
  const secs = (Date.now() - t0) / 1000;
  await cdp.send("Tracing.end");
  await done;
  cdp.removeAllListeners("Tracing.dataCollected");
  const main = events.find((e) => e.name === "thread_name" && e.args?.name === "CrRendererMain");
  const tid = main?.tid;
  const sum = (names) => events.filter((e) => e.tid === tid && names.includes(e.name) && e.dur).reduce((a, e) => a + e.dur / 1000, 0);
  const count = (names) => events.filter((e) => e.tid === tid && names.includes(e.name)).length;
  const tasks = events.filter((e) => e.tid === tid && e.name === "ThreadControllerImpl::RunTask" && e.dur);
  const busy = tasks.reduce((a, e) => a + e.dur / 1000, 0);
  const long = tasks.filter((e) => e.dur / 1000 > 50).length;
  const r = (x) => Math.round(x * 10) / 10;
  return {
    secs: r(secs),
    "main busy ms/s": r(busy / secs),
    "long tasks": long,
    "style ms/s": r(sum(["UpdateLayoutTree", "RecalculateStyles"]) / secs),
    "layout ms/s": r(sum(["Layout"]) / secs),
    "layouts/s": r(count(["Layout"]) / secs),
    "paint ms/s": r(sum(["Paint", "PrePaint"]) / secs),
    "paints/s": r(count(["Paint"]) / secs),
    "raster ms/s": r(events.filter((e) => /Raster/.test(e.name) && e.dur).reduce((a, e) => a + e.dur / 1000, 0) / secs),
  };
}

// Frame pacing from inside the page: the gaps between animation frames.
async function frames(fn) {
  await page.evaluate(() => {
    window.__gaps = [];
    let last = performance.now();
    const tick = (t) => { window.__gaps.push(t - last); last = t; window.__raf = requestAnimationFrame(tick); };
    window.__raf = requestAnimationFrame(tick);
  });
  await fn();
  const gaps = await page.evaluate(() => { cancelAnimationFrame(window.__raf); return window.__gaps.slice(1); });
  gaps.sort((a, b) => a - b);
  const p = (q) => Math.round(gaps[Math.floor(q * (gaps.length - 1))] * 10) / 10;
  return { frames: gaps.length, "p50 ms": p(0.5), "p95 ms": p(0.95), "p99 ms": p(0.99), "max ms": p(1), "over 25 ms": gaps.filter((g) => g > 25).length };
}

async function scrollDown() {
  await page.mouse.move(W / 2, H / 2);
  const total = await page.evaluate(() => document.documentElement.scrollHeight - innerHeight);
  // A trackpad-ish wheel: 40 px every 16 ms.
  for (let y = 0; y < total; y += 40) {
    await page.mouse.wheel(0, 40);
    await page.waitForTimeout(16);
  }
}

const idle = await trace(() => page.waitForTimeout(4000));
await page.evaluate(() => scrollTo(0, 0));
await page.waitForTimeout(500);
let scroll;
const pacing = await frames(async () => { scroll = await trace(scrollDown); });
// Sitting on the checkpoint card, where the loops play.
await page.evaluate(() => document.querySelector(".stage").scrollIntoView({ block: "center" }));
await page.waitForTimeout(500);
const onStage = await trace(() => page.waitForTimeout(4000));
console.log(JSON.stringify({ throttle: THROTTLE, idleAtTop: idle, idleOnCheckpoint: onStage, scrolling: scroll, scrollFramePacing: pacing }, null, 2));
await browser.close();
server.close();
const still = Object.entries({ "at the top": idle, "on the checkpoint": onStage }).filter(([, r]) => r["layouts/s"] > 0 || r["paints/s"] > 2);
for (const [where] of still) console.error(`The page lays out or paints by itself while it sits still ${where}: a loop is animating something other than transform or opacity.`);
process.exit(still.length ? 1 : 0);
