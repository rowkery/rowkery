// The editor's bounded colouring: a keystroke colours only near the caret (the
// highlighter stops at a line limit, the overlay keeps far blocks' older
// colours) and catches up after. After random edits, with random carets and
// limits: every line shows its own text at all times, the up-to-date lines
// match a full re-scan, and once caught up the overlay is exactly
// `highlightSqlLines(text)`.
import { describe, expect, test } from "vitest";
import { createSqlHighlighter, createSqlScan, highlightSqlLines } from "../src/sqlHighlight";
import {
  BLOCK,
  CATCH_UP_BLOCKS,
  NEAR_BLOCKS,
  linesNeeded,
  pickShownLines,
  type ShownLines,
} from "../src/sqlLineBlocks";

/** Small deterministic PRNG (mulberry32), so a failure replays. */
function rng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** The text a line's HTML shows. */
const plain = (html: string) =>
  html.replace(/<[^>]*>/g, "").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");

const TOKENS = [
  "'", "''", '"', "--", "/*", "*/", "$$", "$a$", ";", "\n", "\n", "\n\n", " ", "x", "select", "date", ".", "1e", "5", "(", "<&>",
];

/** ~600 lines: long enough for several blocks, short enough to re-scan per step. */
const BASE = Array.from(
  { length: 600 },
  (_, i) => `SELECT id, 'row ${i}' AS label FROM t_${i % 50} WHERE id > ${i}; -- line ${i}`,
).join("\n");

function edit(text: string, rand: () => number): string {
  const at = Math.floor(rand() * (text.length + 1));
  const roll = rand();
  if (roll < 0.6 || text.length === 0) return text.slice(0, at) + TOKENS[Math.floor(rand() * TOKENS.length)] + text.slice(at);
  if (roll < 0.9) return text.slice(0, at) + text.slice(at + 1 + Math.floor(rand() * 4));
  // A multi-line paste or cut.
  const a = Math.floor(rand() * text.length);
  const chunk = text.slice(a, a + Math.floor(rand() * 400));
  return roll < 0.95 ? text.slice(0, at) + chunk + text.slice(at) : text.slice(0, at) + text.slice(at + chunk.length);
}

describe("a highlighter with a line limit", () => {
  for (const seed of [1, 2, 3, 4, 5, 6]) {
    test(`agrees with a full re-scan where it says it does, seed ${seed}`, () => {
      const rand = rng(seed);
      const hl = createSqlHighlighter();
      let text = BASE;
      hl.update(text);
      for (let step = 0; step < 150; step++) {
        text = edit(text, rand);
        const limit = rand() < 0.2 ? Infinity : Math.floor(rand() * 700);
        const html = hl.update(text, undefined, undefined, limit);
        const full = highlightSqlLines(text);
        const lines = text.split("\n");
        expect(html.length).toBe(full.length);
        const valid = hl.valid();
        expect(html.slice(0, valid)).toEqual(full.slice(0, valid));
        expect(html.map(plain)).toEqual(lines);
        // Sometimes the same text again, further.
        if (rand() < 0.3) {
          hl.update(text, undefined, undefined, limit + Math.floor(rand() * 300));
          expect(hl.update(text).slice(0, hl.valid())).toEqual(full.slice(0, hl.valid()));
        }
      }
      expect(hl.update(text)).toEqual(highlightSqlLines(text));
      expect(hl.valid()).toBe(text.split("\n").length);
    });
  }
});

/** The editor's loop: scan with the needed limit, pick the blocks, commit, catch up. */
function editor() {
  const scan = createSqlScan();
  let shown: ShownLines | null = null;
  let caught = { value: "", blocks: new Set<number>() };
  const render = (value: string, caretLine: number) => {
    if (caught.value !== value) caught = { value, blocks: new Set() };
    const caretBlock = Math.floor(caretLine / BLOCK);
    const out = scan.update(value, linesNeeded(caretBlock, caught.blocks, shown !== null));
    const picked = pickShownLines(out.lines, out.valid, out.text, shown, caretBlock, (b) => caught.blocks.has(b));
    shown = { html: picked.html, text: out.text };
    return { ...picked, valid: out.valid };
  };
  /** One keystroke's render, then catch-up tasks until nothing is pending. */
  const type = (value: string, caretLine: number) => {
    const first = render(value, caretLine);
    let r = first;
    let tasks = 0;
    while (r.pending.length) {
      for (const b of r.pending.slice(0, CATCH_UP_BLOCKS)) caught.blocks.add(b);
      r = render(value, caretLine);
      expect(++tasks).toBeLessThan(1000);
    }
    return { first, final: r };
  };
  return { type };
}

describe("the overlay's blocks", () => {
  for (const seed of [11, 12, 13, 14, 15, 16]) {
    test(`always show the text and end up as a full re-scan, seed ${seed}`, () => {
      const rand = rng(seed);
      const ed = editor();
      let text = BASE;
      ed.type(text, 0);
      for (let step = 0; step < 120; step++) {
        text = edit(text, rand);
        const lines = text.split("\n");
        const caretLine = Math.floor(rand() * lines.length);
        const { first, final } = ed.type(text, caretLine);
        expect(first.html.map(plain)).toEqual(lines);
        expect(final.html).toEqual(highlightSqlLines(text));
      }
    });
  }

  test("a quote at the top of 5,000 lines re-colours only the caret's blocks at first", () => {
    const base = Array.from(
      { length: 5000 },
      (_, i) => `SELECT id, name, 'row ${i}' AS label FROM table_${i % 200} WHERE id > ${i}; -- line ${i}`,
    ).join("\n");
    const ed = editor();
    ed.type(base, 0);
    const at = base.indexOf("\n") + 8;
    let before = highlightSqlLines(base);
    for (const text of [base.slice(0, at) + "'" + base.slice(at), base, base.slice(0, at) + "/*" + base.slice(at), base]) {
      const { first, final } = ed.type(text, 1);
      const changed = first.html.filter((h, i) => h !== before[i]).length;
      expect(changed).toBeGreaterThan(0);
      expect(changed).toBeLessThanOrEqual((NEAR_BLOCKS + 1) * BLOCK);
      expect(first.valid).toBeLessThanOrEqual((NEAR_BLOCKS + 1) * BLOCK);
      expect(final.html).toEqual(highlightSqlLines(text));
      before = final.html;
    }
  });
});
