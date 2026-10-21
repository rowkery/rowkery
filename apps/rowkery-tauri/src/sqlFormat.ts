import { lineAtOffset, lineStartOffsets } from "./sqlHighlight";
import { sqlStatementRanges, statementRangeAtOffset, type CharRange } from "./sqlStatements";

/**
 * What ⌘I formats: every statement a selection touches, joined into one
 * range, or the statement under the caret (the one ⌘↵ would run). Null when
 * the selection touches no statement or the editor has no SQL.
 */
export function formatTarget(
  text: string,
  selectionStart: number,
  selectionEnd: number,
  ranges: CharRange[] = sqlStatementRanges(text),
): CharRange | null {
  const a = Math.min(selectionStart, selectionEnd);
  const b = Math.max(selectionStart, selectionEnd);
  if (a === b) return statementRangeAtOffset(text, a, ranges);
  const touched = ranges.filter((r) => r.start < b && r.end > a);
  if (!touched.length) return null;
  return { start: touched[0].start, end: touched[touched.length - 1].end };
}

export type FormatDialect = "postgresql" | "sqlite";

export type FormatResult = { ok: true; sql: string } | { ok: false; error: string };

/**
 * `text[range]` in the tabular layout, keywords upper case and functions
 * lower case. sql-formatter loads on the first call, so the editor doesn't
 * carry it until someone formats. Strings, quoted names, comments and `$$`
 * bodies come back as written. An error names the editor's line.
 */
export async function formatSql(text: string, range: CharRange, dialect: FormatDialect): Promise<FormatResult> {
  const f = await import("sql-formatter");
  try {
    const out = f.formatDialect(text.slice(range.start, range.end), {
      dialect: dialect === "sqlite" ? f.sqlite : f.postgresql,
      indentStyle: "tabularLeft",
      keywordCase: "upper",
      functionCase: "lower",
    });
    return { ok: true, sql: out };
  } catch (e) {
    const lineBase = lineAtOffset(lineStartOffsets(text), range.start);
    return { ok: false, error: formatError(e instanceof Error ? e.message : String(e), lineBase) };
  }
}

/**
 * sql-formatter's message cut to its first point: the token and the line.
 * The rest of it is the grammar's list of what it expected.
 */
function formatError(message: string, lineBase: number): string {
  const m = /^Parse error(?: at token)?: (.*?) at line (\d+) column \d+/.exec(message);
  if (!m) return message.split("\n")[0];
  const what = m[1].startsWith("Unexpected") ? m[1] : `Unexpected "${m[1]}"`;
  return `${what} on line ${Number(m[2]) + lineBase}`;
}
