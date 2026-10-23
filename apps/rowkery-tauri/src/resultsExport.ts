import { parsePaste } from "./editBuffer";
import type { QueryResultDto } from "./types";

function csvField(s: string): string {
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function tsvField(s: string): string {
  return s.replace(/[\t\r\n]+/g, " ");
}

/** Header plus every row; NULL becomes an empty field. */
export function resultsToText(
  result: QueryResultDto,
  format: "csv" | "tsv",
): string {
  const field = format === "csv" ? csvField : tsvField;
  const sep = format === "csv" ? "," : "\t";
  const lines = [result.columns.map((c) => field(c.name)).join(sep)];
  const { rows, columns } = result;
  for (let r = 0; r < rows.length; r++) {
    const fields: string[] = [];
    // NULL is an empty field (`text` is "" for it).
    for (let c = 0; c < columns.length; c++) fields.push(field(rows.text(r, c)));
    lines.push(fields.join(sep));
  }
  return lines.join("\n");
}

/** A grid copy: the text for the clipboard, and which cells of it were NULL (`row * width + col`). */
export interface CopiedCells {
  text: string;
  width: number;
  nulls: Set<number>;
}

/** Quoted the way spreadsheets quote TSV: a tab, line break or quote wraps the field in quotes. */
function tsvQuoted(s: string): string {
  return /[\t\r\n"]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/** A block of cells as TSV: rows `r0..r1`, columns `c0..c1` (inclusive); NULL is an empty field. */
export function cellsToTsv(
  result: QueryResultDto,
  r0: number,
  r1: number,
  c0: number,
  c1: number,
  withHeader: boolean,
  /** A cell's text; the grid passes its staged edits over the loaded rows. */
  text: (row: number, col: number) => string = (r, c) => result.rows.text(r, c),
  isNull: (row: number, col: number) => boolean = (r, c) => result.rows.isNull(r, c),
): CopiedCells {
  const width = c1 - c0 + 1;
  const nulls = new Set<number>();
  const lines: string[] = [];
  if (withHeader) lines.push(result.columns.slice(c0, c1 + 1).map((c) => tsvQuoted(c.name)).join("\t"));
  for (let r = r0; r <= r1; r++) {
    const fields: string[] = [];
    for (let c = c0; c <= c1; c++) {
      if (isNull(r, c)) nulls.add(lines.length * width + c - c0);
      fields.push(isNull(r, c) ? "" : tsvQuoted(text(r, c)));
    }
    lines.push(fields.join("\t"));
  }
  return { text: lines.join("\n"), width, nulls };
}

/**
 * The grid's last copy. Clipboard text can't tell NULL from the text "NULL" or an empty
 * string, and WKWebView doesn't carry custom clipboard formats, so a paste whose text is
 * exactly what the grid last wrote takes its NULLs from here. Any other copy, or leaving the
 * window (where another app may copy the same text), forgets it.
 */
let lastCopy: CopiedCells | null = null;

export function rememberCopy(copy: CopiedCells): void {
  lastCopy = copy;
}

// The grid's ⌘C prevents the native copy event, so any copy or cut event is someone else's.
if (typeof window !== "undefined") {
  const forget = () => (lastCopy = null);
  document.addEventListener("copy", forget, true);
  document.addEventListener("cut", forget, true);
  window.addEventListener("blur", forget);
  document.addEventListener("visibilitychange", forget);
}

const sameText = (t: string) => t.replace(/\r\n?/g, "\n").replace(/\n$/, "");

/** A pasted block's cells, with NULL (`null`) where the grid's last copy, when `text` is it, had one. */
export function pastedCells(text: string): (string | null)[][] {
  const block: (string | null)[][] = parsePaste(text);
  const copy = lastCopy;
  if (copy?.nulls.size && sameText(copy.text) === sameText(text)) {
    for (const i of copy.nulls) {
      const line = block[Math.floor(i / copy.width)];
      if (line) line[i % copy.width] = null;
    }
  }
  return block;
}
