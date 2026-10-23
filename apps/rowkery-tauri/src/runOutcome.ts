/**
 * When the call that ran an import or a commit fails itself (core stopped,
 * the answer was lost), Rowkery can't tell whether the work was saved: it
 * says so plainly instead of claiming a rollback.
 */

/** The import panel's message, and the toast's when the panel is out of sight. */
export function importLost(table: string, error: string): { message: string; toast: string; detail: string } {
  return {
    message: `Rowkery lost track of this import; check ${table} (${error})`,
    toast: "Import outcome unknown",
    detail: `Rowkery lost track of it; check ${table}`,
  };
}

/** The foot edits bar's message: Retry could save the same edits twice. */
export function commitLost(error: string): string {
  return `Rowkery lost track of this commit; check the table before Retry (${error})`;
}
