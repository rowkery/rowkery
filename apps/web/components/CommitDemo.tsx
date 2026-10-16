/** One change an agent sent: each changed cell, what the table holds now and what it would hold. */
const CHANGE: [column: string, before: string, after: string][] = [
  ["status", "pending", "shipped"],
  ["shipped_at", "null", "2026-10-16 09:12"],
];

/**
 * Nothing changes until you press Commit (CSS only, an 8 s loop): the agent's new values wait,
 * faint, beside the ones the table holds; a pointer comes in and presses Commit, and only then
 * are the old values struck out and the new ones lit. Then it quietly starts over.
 * Every loop moves only transform and opacity.
 */
export function CommitDemo() {
  return (
    <div className="commit" role="img" aria-label="An agent's change to order 84204 waits beside the current values. When Commit is pressed, status changes from pending to shipped and shipped_at is filled in.">
      <div className="rows">
        <div className="rows-hd">
          <span>orders · 84204</span>
          <span className="state">
            <span className="wait">Waiting for you</span>
            <span className="done ok">Committed</span>
          </span>
        </div>
        {CHANGE.map(([column, before, after]) => (
          <div className="row" key={column}>
            <span>{column}</span>
            <span className="cell">
              <span className="was">
                {before}
                <i aria-hidden="true" />
              </span>
              <span className="next">{after}</span>
            </span>
          </div>
        ))}
      </div>
      <div className="cbar">
        <span>1 change from your agent</span>
        <span className="cb grey">Send back</span>
        <span className="cb white press">Commit</span>
      </div>
      <svg className="pointer" width="20" height="24" viewBox="0 0 20 24" aria-hidden="true">
        <path d="M2 2v17l4.6-4.3 3.1 7.2 3-1.3-3.1-7h6.4z" fill="#fff" stroke="#0a0a0a" strokeWidth="1.4" strokeLinejoin="round" />
      </svg>
    </div>
  );
}
