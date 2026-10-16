// Auto-closing quotes for the SQL editor: typing ' or " adds the closing one
// with the caret between; typing the closing quote steps over it; Backspace in
// an empty pair removes both. Brackets are not paired.

export type QuoteEdit =
  | { kind: "insert"; text: string; caret: number }
  | { kind: "wrap"; from: number; to: number; text: string }
  | { kind: "skip"; caret: number }
  | { kind: "delete"; from: number; to: number };

const WORD = /[\p{L}\p{N}_$]/u;

type Scan = "code" | "'" | '"' | "line" | "block";

/** What the text before the caret is inside: code, a quoted run, or a comment. */
function stateAt(text: string, caret: number): Scan {
  let s: Scan = "code";
  for (let i = 0; i < caret; i++) {
    const c = text[i];
    if (s === "code") {
      if (c === "'" || c === '"') s = c;
      else if (c === "-" && text[i + 1] === "-") (s = "line"), i++;
      else if (c === "/" && text[i + 1] === "*") (s = "block"), i++;
    } else if (s === "line") {
      if (c === "\n") s = "code";
    } else if (s === "block") {
      if (c === "*" && text[i + 1] === "/") (s = "code"), i++;
    } else if (c === s) {
      // A doubled quote is an escaped one and stays inside the run.
      if (text[i + 1] === s && i + 1 < caret) i++;
      else s = "code";
    }
  }
  return s;
}

/** The edit for typing `key` at the selection, or null to let the browser type it. */
export function quoteTyped(text: string, start: number, end: number, key: string): QuoteEdit | null {
  if (key !== "'" && key !== '"') return null;
  if (start !== end) return { kind: "wrap", from: start, to: end, text: key + text.slice(start, end) + key };
  const state = stateAt(text, start);
  if (state === "line" || state === "block") return null;
  if (state === key) {
    // Inside this kind of quote: the same key closes it, stepping over a closer already there.
    return text[start] === key ? { kind: "skip", caret: start + 1 } : null;
  }
  if (state !== "code") return null;
  // Mid-word (don't, O'Brien) or before a word: a lone quote.
  if (start > 0 && WORD.test(text[start - 1])) return null;
  if (start < text.length && WORD.test(text[start])) return null;
  return { kind: "insert", text: key + key, caret: start + 1 };
}

/** Backspace between an empty pair of quotes removes both. */
export function quoteBackspace(text: string, start: number, end: number): QuoteEdit | null {
  if (start !== end || start === 0) return null;
  const a = text[start - 1];
  if ((a !== "'" && a !== '"') || text[start] !== a) return null;
  return { kind: "delete", from: start - 1, to: start + 1 };
}
