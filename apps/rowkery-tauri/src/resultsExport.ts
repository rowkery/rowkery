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

/** A grid copy: the text for the clipboard and the cells it holds, NULL as `null`. */
export interface CopiedCells {
  text: string;
  cells: (string | null)[][];
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
  const cells: (string | null)[][] = [];
  if (withHeader) cells.push(result.columns.slice(c0, c1 + 1).map((c) => c.name));
  for (let r = r0; r <= r1; r++) {
    const line: (string | null)[] = [];
    for (let c = c0; c <= c1; c++) line.push(isNull(r, c) ? null : text(r, c));
    cells.push(line);
  }
  return { text: cells.map((l) => l.map((v) => tsvQuoted(v ?? "")).join("\t")).join("\n"), cells };
}

/**
 * The grid's last copy. Clipboard text can't tell NULL from the text "NULL" or an empty
 * string, and WKWebView doesn't carry custom clipboard formats, so a paste whose text is
 * exactly what the grid last wrote takes its cells from here.
 */
let lastCopy: CopiedCells | null = null;

export function rememberCopy(copy: CopiedCells): void {
  lastCopy = copy;
}

const sameText = (t: string) => t.replace(/\r\n?/g, "\n").replace(/\n$/, "");

/** The cells of the grid's last copy, when `text` is what it wrote. */
export function copiedCells(text: string): (string | null)[][] | null {
  return lastCopy && sameText(lastCopy.text) === sameText(text) ? lastCopy.cells : null;
}
