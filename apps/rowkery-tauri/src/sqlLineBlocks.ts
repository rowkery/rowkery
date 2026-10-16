/**
 * What the editor's coloured overlay shows after an edit, a block of lines at
 * a time. A quote or comment opened near the top re-colours every line after
 * it; putting all of that in the DOM at once (5,000 lines' HTML parsed and
 * laid out again) took the keystroke 0.5-2 s. So a keystroke takes the new
 * colours only near the caret, and in blocks whose text changed; a far block
 * whose text is the same keeps the colours it shows (same text, same boxes:
 * the colours differ, the geometry doesn't) and catches up a few blocks per
 * task after the key. Once nothing is pending the overlay is exactly
 * `highlightSqlLines(text)` (test/sqlLineBlocks.test.ts).
 */

/** Lines per block: the overlay's unit of re-rendering (`SqlLineBlock`). */
export const BLOCK = 64;

/** Blocks either side of the caret's that always take the new colours. */
export const NEAR_BLOCKS = 1;

/** Far blocks brought up to date per task after a keystroke. */
export const CATCH_UP_BLOCKS = 4;

/** What the overlay shows: each line's HTML, and the text it was coloured from. */
export interface ShownLines {
  html: string[];
  text: string[];
}

/**
 * Each line's HTML to render now, and the far blocks left showing older
 * colours (nearest the caret first). `fresh` is the highlighter's HTML for
 * `text`, up to date for its first `valid` lines (the highlighter stops past
 * the blocks that need it: `linesNeeded`); `shown` what the overlay shows now
 * (null: nothing yet, take all); `current(b)` says block `b` must be up to
 * date (near the caret, or caught up).
 */
export function pickShownLines(
  fresh: string[],
  valid: number,
  text: string[],
  shown: ShownLines | null,
  caretBlock: number,
  current: (block: number) => boolean,
): { html: string[]; pending: number[] } {
  if (!shown) return { html: fresh, pending: [] };
  let html: string[] | null = null;
  const pending: number[] = [];
  for (let from = 0, b = 0; from < fresh.length; from += BLOCK, b++) {
    const to = Math.min(fresh.length, from + BLOCK);
    if (Math.abs(b - caretBlock) <= NEAR_BLOCKS || current(b)) continue;
    // Past `valid` the highlighter's lines hold the right text with older
    // colours: the block shows them (or keeps what it shows) and catches up.
    const upToDate = to <= valid;
    let same = upToDate && to <= shown.html.length;
    let sameText = to <= shown.text.length;
    for (let i = from; i < to && (same || sameText); i++) {
      if (fresh[i] !== shown.html[i]) same = false;
      if (text[i] !== shown.text[i]) sameText = false;
    }
    if (same) continue;
    if (sameText) {
      html ??= fresh.slice();
      for (let i = from; i < to; i++) html[i] = shown.html[i];
      pending.push(b);
    } else if (!upToDate) {
      pending.push(b);
    }
  }
  pending.sort((a, b) => Math.abs(a - caretBlock) - Math.abs(b - caretBlock) || a - b);
  return { html: html ?? fresh, pending };
}

/**
 * Lines the highlighter must have up to date: through the blocks near the
 * caret and the caught-up ones (`Infinity` while nothing shows yet).
 */
export function linesNeeded(caretBlock: number, caught: Iterable<number>, hasShown: boolean): number {
  if (!hasShown) return Infinity;
  let last = caretBlock + NEAR_BLOCKS;
  for (const b of caught) last = Math.max(last, b);
  return (last + 1) * BLOCK;
}
