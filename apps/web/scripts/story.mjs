// The story's named moments, shared by the checks: where each one sits on the page (a scene's
// top plus s scroll units, the unit read back from the layout, as engine.ts does), and what
// should show there. `cap` is the caption that should be lit, `word` the big word on the white page.
export const MOMENTS = [
  { name: "hero", at: "top" },
  { name: "agent-title", scene: "agent", s: 0.3, title: "Let your AI agent read your database" },
  { name: "agent-asks", scene: "agent", s: 1.95, cap: "Your agent asks" },
  { name: "agent-checks", scene: "agent", s: 2.9, cap: "Rowkery checks it first" },
  { name: "agent-hidden", scene: "agent", s: 3.97, cap: "Sensitive columns stay hidden" },
  { name: "agent-commit", scene: "agent", s: 5.15, cap: "Changes wait for you" },
  { name: "security-tables", scene: "security", s: 1.9, cap: "Only the tables you share" },
  { name: "security-stand-in", scene: "security", s: 2.97, cap: "Sensitive columns get a stand‑in" },
  { name: "security-keychain", scene: "security", s: 3.97, cap: "Your password stays with you" },
  { name: "keys-jump", scene: "keys", s: 1.95, cap: "Jump anywhere" },
  { name: "keys-run", scene: "keys", s: 2.9, cap: "Run a query" },
  { name: "keys-review", scene: "keys", s: 3.95, cap: "Review, then Commit" },
  { name: "page-turns", scene: "free", s: -0.05 },
  { name: "free", scene: "free", s: 1.2, word: "Free." },
  { name: "open-source", scene: "free", s: 2.5, word: "Open source." },
  { name: "no-account", scene: "free", s: 3.8, word: "No account." },
  { name: "get", at: "get" },
  { name: "end", at: "end" },
];

/** Scrolls to a moment and waits for the damped scenes to settle. */
export async function goTo(page, m, settle = 1500) {
  const y = await page.evaluate((m) => {
    if (m.at === "top") return 0;
    if (m.at === "end") return document.documentElement.scrollHeight - innerHeight;
    if (m.at === "get") return document.getElementById("get").offsetTop;
    const el = document.querySelector(`[data-scene="${m.scene}"]`), stage = el.querySelector(".stage");
    const n = parseFloat(el.style.getPropertyValue("--n"));
    return el.offsetTop + m.s * ((el.offsetHeight - stage.offsetHeight) / n);
  }, m);
  await page.evaluate((v) => scrollTo({ top: v, behavior: "instant" }), Math.round(y));
  await page.waitForTimeout(settle);
  // Then let any entrance still playing (a transition, a hop) finish; the endless loops keep going.
  await page.waitForFunction(() => !document.getAnimations().some((a) => a.playState === "running" && a.effect.getComputedTiming().iterations !== Infinity), null, { timeout: 4000 }).catch(() => {});
}
