import { Fragment } from "react";

/** The Mac modifier glyphs, each its own key. */
const MOD = new Set(["⌘", "⇧", "⌥", "⌃"]);

/**
 * A chord's keycap text with a little air beside each modifier glyph, so
 * ⇧⌘A reads as three keys (2026-10-15: the glyphs ran together).
 * The gap is a margin, not a character: the text (copy, find, tests) stays
 * `⇧⌘A`, and words such as "drag row numbers" or `Ctrl+Shift+A` are untouched.
 */
export function Keys({ text }: { text: string }) {
  const chars = Array.from(text);
  if (!chars.some((c) => MOD.has(c))) return <>{text}</>;
  return (
    <>
      {chars.map((c, i) =>
        i > 0 && (MOD.has(c) || MOD.has(chars[i - 1])) ? (
          <span key={i} className="key-gap">
            {c}
          </span>
        ) : (
          <Fragment key={i}>{c}</Fragment>
        ),
      )}
    </>
  );
}

/** How many gaps `Keys` puts in `text` (the ⌘-hold badges size themselves by it). */
export function keyGaps(text: string): number {
  const chars = Array.from(text);
  return chars.filter((c, i) => i > 0 && (MOD.has(c) || MOD.has(chars[i - 1]))).length;
}
