/**
 * When the call that ran an import, a commit or a SQL file fails itself
 * (core stopped, the answer was lost), Rowkery can't tell whether the work
 * was saved: it says so plainly instead of claiming a rollback. Every other
 * error is a refusal (busy, read-only, nothing to commit…) and nothing ran.
 */

/** Core's `LOST_ANSWER`: the only error that means "outcome unknown". */
export const LOST_ANSWER = "Rowkery's core stopped before it answered";

/** The call's error says its answer was lost, not that it was refused. */
export function isLostAnswer(error: unknown): boolean {
  return String(error).startsWith(LOST_ANSWER);
}

/** The import panel's message, and the toast's when the panel is out of sight. */
export function importLost(table: string, error: string): { message: string; toast: string; detail: string } {
  return {
    message: `Rowkery lost track of this import; check ${table} (${error})`,
    toast: "Import outcome unknown",
    detail: `Rowkery lost track of it; check ${table}`,
  };
}

/** The foot edits bar's message (the error goes in its title): Retry could save the same edits twice. */
export function commitLost(error: string): { message: string; title: string } {
  return { message: "Rowkery lost track of this commit · check the table before Retry", title: error };
}
