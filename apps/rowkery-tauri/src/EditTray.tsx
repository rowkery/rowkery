import { commandTip, keysFor } from "./commands";
import { isMacPlatform } from "./platform";
import "./EditTray.css";
import { Keys } from "./Keys";

/** What the bar says besides the count. */
export type TrayState =
  | { kind: "pending" }
  | { kind: "committing" }
  /**
   * Rolled back: `message` names the row ("UPDATE kiosks WHERE id = 3 changed 2 rows").
   * `unknown`: the commit's answer never came, so it may have been saved.
   */
  | { kind: "failed"; message: string; unknown?: boolean }
  /** "Updated 1 · Inserted 1 · Deleted 1 · 24 ms", for 1.6 s after a commit. */
  | { kind: "done"; text: string }
  /** ↵ where nothing can be edited, for 4 s. */
  | { kind: "refused"; reason: string };

/** The staged changes by kind, for the dots. */
export interface TrayCounts {
  edited: number;
  deleted: number;
  inserted: number;
}

/**
 * The edits bar at the grid's foot while edits wait (Paper, 2026-10-10; it
 * replaced the floating capsule): "3 changes · ● 2 edited ● 1 new", then
 * Review SQL, Discard and Commit in ink. After a rolled-back commit it names
 * the row and offers Retry; where nothing can be edited it says why.
 */
export function EditTray({
  count,
  counts,
  state,
  onReview,
  onDiscard,
  onCommit,
  onChangeMode,
  held,
}: {
  count: number;
  counts?: TrayCounts;
  state: TrayState;
  onReview: () => void;
  onDiscard: () => void;
  onCommit: () => void;
  onChangeMode: () => void;
  /**
   * Confirm writes holds the commit in the strip above the grid: the strip's
   * Commit is the one to press, so this one waits (one Commit on screen).
   */
  held?: boolean;
}) {
  const mac = isMacPlatform();
  const review = keysFor("review-sql", mac);
  const commit = keysFor("commit-edits", mac);
  if (state.kind === "refused") {
    const [what, action] = state.reason.split(" · ");
    return (
      <div className="edit-tray" role="status" data-edit-tray="refused">
        <span className="edit-tray-text">{what}</span>
        {action === "Change safe mode…" ? (
          <button type="button" className="edit-tray-link" onClick={onChangeMode}>
            {action}
          </button>
        ) : (
          action && <span className="edit-tray-dim">{action}</span>
        )}
      </div>
    );
  }
  if (state.kind === "done") {
    return (
      <div className="edit-tray" role="status" data-edit-tray="done">
        <span className="edit-tray-done-dot" aria-hidden />
        <span className="edit-tray-text">{state.text}</span>
      </div>
    );
  }
  const n = `${count} ${count === 1 ? "change" : "changes"}${held ? " · waiting for confirmation" : ""}`;
  const failed = state.kind === "failed";
  const dot = (kind: keyof TrayCounts, label: string) =>
    counts && counts[kind] > 0 ? (
      <span className="edit-tray-dot" data-tray-count={kind} data-n={counts[kind]}>
        <i data-kind={kind} aria-hidden />
        {counts[kind]} {label}
      </span>
    ) : null;
  return (
    <div
      className={`edit-tray${failed ? " failed" : ""}`}
      role="status"
      data-edit-tray={state.kind}
      data-changes={count}
      data-held={held ? "" : undefined}
    >
      <b className="edit-tray-count">{n}</b>
      {failed ? (
        <span className="edit-tray-error" data-tray-error title={state.message}>
          {state.unknown ? "Outcome unknown" : "Nothing changed"} · {state.message}
        </span>
      ) : (
        <span className="edit-tray-dots">
          {dot("edited", "edited")}
          {dot("deleted", "deleted")}
          {dot("inserted", "new")}
        </span>
      )}
      <span className="edit-tray-gap" />
      <button type="button" className="edit-tray-review" data-review title={commandTip("review-sql", "Review SQL", mac)} onClick={onReview}>
        Review SQL <kbd className="edit-tray-keys"><Keys text={review} /></kbd>
      </button>
      <button type="button" className="edit-tray-discard" data-discard onClick={onDiscard}>
        Discard
      </button>
      <button
        type="button"
        className="edit-commit"
        data-commit
        disabled={state.kind === "committing" || held}
        title={held ? "Confirm the write in the strip above" : undefined}
        onClick={onCommit}
      >
        {failed ? "Retry" : state.kind === "committing" ? "Committing…" : "Commit"} <kbd><Keys text={commit} /></kbd>
      </button>
    </div>
  );
}
