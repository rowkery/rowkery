/**
 * A failed statement, read for the person who wrote it: where the server
 * pointed (its 1-based character position), the token there, the name the
 * user probably meant, and the raw text as psql would print it.
 */

/** The server's position (1-based characters) as a UTF-16 offset into `sql`. */
export function positionToOffset(sql: string, position: number): number {
  let chars = 0;
  let i = 0;
  while (i < sql.length && chars < position - 1) {
    const code = sql.charCodeAt(i);
    i += code >= 0xd800 && code <= 0xdbff ? 2 : 1;
    chars++;
  }
  return Math.min(i, sql.length);
}

/** The token at `offset`: a word, or a double-quoted identifier. */
export function tokenAt(sql: string, offset: number): { start: number; end: number } {
  if (sql[offset] === '"') {
    const close = sql.indexOf('"', offset + 1);
    return { start: offset, end: close < 0 ? sql.length : close + 1 };
  }
  const word = /[\p{L}\p{N}_$]/u;
  let start = offset;
  let end = offset;
  while (start > 0 && word.test(sql[start - 1])) start--;
  while (end < sql.length && word.test(sql[end])) end++;
  // Nothing word-like there (an operator, a parenthesis): one character.
  if (end === start) end = Math.min(sql.length, start + 1);
  return { start, end };
}

/** `column "nmae" does not exist` → `nmae`. */
export function quotedName(message: string): string | null {
  const m = /"([^"]+)"/.exec(message);
  if (!m) return null;
  // `relation "public.kiosk"`: the name after the last dot.
  return m[1].split(".").pop() ?? null;
}

export function levenshtein(a: string, b: string): number {
  const prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    let diag = prev[0];
    prev[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const up = prev[j];
      prev[j] = Math.min(prev[j] + 1, prev[j - 1] + 1, diag + (a[i - 1] === b[j - 1] ? 0 : 1));
      diag = up;
    }
  }
  return prev[b.length];
}

/** The candidate nearest to `name` within `max` edits (case-insensitive), else null. */
export function nearestName(name: string, candidates: Iterable<string>, max = 2): string | null {
  const want = name.toLowerCase();
  let best: string | null = null;
  let bestD = max + 1;
  for (const c of candidates) {
    const d = levenshtein(want, c.toLowerCase());
    if (d === 0) continue;
    if (d < bestD) {
      best = c;
      bestD = d;
    }
  }
  return best;
}

/** psql's shape: `ERROR:  msg`, then `LINE n: …` and a caret under the position. */
export function rawErrorLines(message: string, sql: string | null, position: number | null): string[] {
  const out = [`ERROR:  ${message}`];
  if (!sql || !position) return out;
  const at = positionToOffset(sql, position);
  const lineStart = sql.lastIndexOf("\n", at - 1) + 1;
  const lineEnd = sql.indexOf("\n", at);
  const line = sql.slice(lineStart, lineEnd < 0 ? sql.length : lineEnd);
  const n = sql.slice(0, lineStart).split("\n").length;
  const prefix = `LINE ${n}: `;
  out.push(prefix + line);
  out.push(" ".repeat(prefix.length + [...sql.slice(lineStart, at)].length) + "^");
  return out;
}
