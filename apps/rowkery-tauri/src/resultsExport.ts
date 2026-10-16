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

/** A block of cells as CSV: rows `r0..r1`, columns `c0..c1` (inclusive). */
export function cellsToCsv(
  result: QueryResultDto,
  r0: number,
  r1: number,
  c0: number,
  c1: number,
  withHeader: boolean,
  /** A cell's text; the grid passes its staged edits over the loaded rows. */
  text: (row: number, col: number) => string = (r, c) => result.rows.text(r, c),
): string {
  const lines: string[] = [];
  if (withHeader) {
    lines.push(
      result.columns
        .slice(c0, c1 + 1)
        .map((c) => csvField(c.name))
        .join(","),
    );
  }
  for (let r = r0; r <= r1; r++) {
    const fields: string[] = [];
    for (let c = c0; c <= c1; c++) fields.push(csvField(text(r, c)));
    lines.push(fields.join(","));
  }
  return lines.join("\n");
}
