// The story's named moments, shared by the checks: where each one sits on the page (a scene's
// top plus s scroll units, the unit read back from the layout, as engine.ts does), and what
// should show there. `cap` is the caption that should be lit, `word` the big word on the white page.
export const MOMENTS = [
  { name: "hero", at: "top" },
  { name: "agent-title", scene: "agent", s: 0, title: "Let your AI agent read your database" },
  { name: "agent-asks", scene: "agent", s: 1.35, cap: "Your agent asks" },
  { name: "agent-checks", scene: "agent", s: 2.3, cap: "Rowkery checks it first" },
  { name: "agent-hidden", scene: "agent", s: 3.5, cap: "Sensitive columns stay hidden" },
  { name: "agent-commit", scene: "agent", s: 4.55, cap: "Changes wait for you" },
  { name: "security-tables", scene: "security", s: 1.3, cap: "Only the tables you share" },
  { name: "security-stand-in", scene: "security", s: 2.37, cap: "Sensitive columns get a stand‑in" },
  { name: "security-keychain", scene: "security", s: 3.37, cap: "Your password stays with you" },
  { name: "keys-jump", scene: "keys", s: 1.35, cap: "Jump anywhere" },
  { name: "keys-run", scene: "keys", s: 2.3, cap: "Run a query" },
  { name: "keys-review", scene: "keys", s: 3.35, cap: "Review, then Commit" },
  { name: "page-turns", scene: "free", s: -0.1 },
  { name: "free", scene: "free", s: 0.95, word: "Free." },
  { name: "open-source", scene: "free", s: 2.15, word: "Open source." },
  { name: "no-account", scene: "free", s: 3.4, word: "No account." },
  { name: "get", at: "get" },
  { name: "end", at: "end" },
];

/** Where a moment is on the page, in scroll px. */
export function momentY(page, m) {
  return page.evaluate((m) => {
    if (m.at === "top") return 0;
    if (m.at === "end") return document.documentElement.scrollHeight - innerHeight;
    if (m.at === "get") return document.getElementById("get").offsetTop;
    const el = document.querySelector(`[data-scene="${m.scene}"]`), stage = el.querySelector(".stage");
    const n = parseFloat(el.style.getPropertyValue("--n"));
    return Math.round(el.offsetTop + m.s * ((el.offsetHeight - stage.offsetHeight) / n));
  }, m);
}

/** Scrolls to a moment and waits for the damped scenes to settle. */
export async function goTo(page, m, settle = 1500) {
  const y = await momentY(page, m);
  await page.evaluate((v) => scrollTo({ top: v, behavior: "instant" }), y);
  await page.waitForTimeout(settle);
  // Then let any entrance still playing (a transition, a hop) finish; the endless loops keep going.
  await page.waitForFunction(() => !document.getAnimations().some((a) => a.playState === "running" && a.effect.getComputedTiming().iterations !== Infinity), null, { timeout: 4000 }).catch(() => {});
}

// In the page (an init script): counts the frames the page asks for, so a check can wait until
// the story has settled rather than for a guessed time.
export const COUNT_FRAMES = `
  window.__frames = 0;
  const raf = window.requestAnimationFrame.bind(window);
  window.requestAnimationFrame = (cb) => (window.__frames++, raf(cb));
`;

// In the page (an init script): asks the engine for its test hook, window.__story.snap().
export const SNAP = "window.__storyTest = true;";

/**
 * Scrolls to y and shows where the story comes to rest there without waiting for it (needs SNAP):
 * the damped positions jump to their targets, and every entrance still playing (a transition, a
 * hop, a key press) skips to its end. The endless loops keep going.
 */
export function jump(page, y) {
  return page.evaluate(async (y) => {
    scrollTo({ top: y, behavior: "instant" });
    window.__story.snap();
    const frame = () => new Promise((r) => requestAnimationFrame(() => r()));
    // Twice at least: a frame draws the snapped story, and what it switches on (a class, an
    // intersection) can start an entrance a frame later.
    for (let i = 0; i < 8; i++) {
      await frame();
      await frame();
      const playing = document.getAnimations().filter((a) => a.playState === "running" && a.effect.getComputedTiming().iterations !== Infinity);
      if (!playing.length && i > 0) break;
      for (const a of playing) a.finish();
    }
  }, y);
}

/** Waits until the story stops asking for frames (needs COUNT_FRAMES), then for any entrance still playing. */
export async function settle(page) {
  let last = -1;
  for (let i = 0; i < 80; i++) {
    const n = await page.evaluate(() => window.__frames);
    if (n === last) break;
    last = n;
    await page.waitForTimeout(150);
  }
  await page.waitForFunction(() => !document.getAnimations().some((a) => a.playState === "running" && a.effect.getComputedTiming().iterations !== Infinity), null, { timeout: 4000 }).catch(() => {});
}
