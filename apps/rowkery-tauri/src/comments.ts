import type { TableNode } from "./types";

/**
 * Postgres COMMENTs (`obj_description` / `col_description`, introspected with
 * the catalog; SQLite has none). The UI prints a comment's first line and
 * keeps the whole text for tooltips.
 */

/** The first non-blank line, trimmed; "" for none. */
export function firstLine(text: string | null | undefined): string {
  if (!text) return "";
  for (const line of text.split(/\r?\n/)) {
    const t = line.trim();
    if (t) return t;
  }
  return "";
}

/** Column name → comment, for the columns that have one; null when none do. */
export function columnComments(table: TableNode | undefined): ReadonlyMap<string, string> | null {
  const map = new Map<string, string>();
  for (const c of table?.columns ?? []) {
    if (c.comment?.trim()) map.set(c.name, c.comment.trim());
  }
  return map.size ? map : null;
}
