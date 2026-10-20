/** A pause this long starts a fresh search, as in a Mac menu. */
export const TYPE_SELECT_PAUSE_MS = 1000;

/**
 * Type-to-select in a menu, as in a native Mac menu: the row whose label
 * starts with what was typed. The same letter again steps to the next row
 * starting with it; more letters narrow, keeping the current row while it
 * still matches. No match keeps the cursor where it is.
 */
export function typeSelect(labels: string[], cursor: number, typed: string): number {
  const t = typed.toLowerCase();
  if (!t) return cursor;
  const repeat = [...t].every((ch) => ch === t[0]);
  const prefix = repeat ? t[0] : t;
  const start = repeat ? cursor + 1 : Math.max(cursor, 0);
  for (let i = 0; i < labels.length; i++) {
    const at = (start + i) % labels.length;
    if (labels[at].trimStart().toLowerCase().startsWith(prefix)) return at;
  }
  return cursor;
}
