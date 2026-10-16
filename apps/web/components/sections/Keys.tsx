import { LookMotion, PaletteMotion } from "../CardMotion";

/** Querying it yourself, after the agent and security (2026-10-16): ⌘K, Quick Look, and review-then-commit with its keys. */
export function Keys() {
  return (
    <section className="sec" id="keys">
      <div className="wrap">
        <h2 className="h2 reveal">Built for the keyboard</h2>
        <p className="lead reveal">You don’t need an AI agent to use Rowkery. Every action has a shortcut, and you always see the SQL that runs.</p>
        <div className="grid">
          <article className="card reveal">
            <h3>⌘K to jump anywhere</h3>
            <p>Find any table or command.</p>
            <PaletteMotion />
          </article>
          <article className="card reveal">
            <h3>Space to see a full row</h3>
            <p>It opens next to the grid, so your data stays in view. Press ↵ on a foreign key to open the linked row.</p>
            <LookMotion />
          </article>
          <article className="card wide reveal" style={{ minHeight: 0 }}>
            <h3>Review, then commit</h3>
            <p>Your edits wait until you’ve checked the SQL and committed them, all in one transaction. Read-only mode blocks writes completely.</p>
            <ul className="keys press">
              <li>
                <kbd>⌘F</kbd>Filter rows
              </li>
              <li>
                <kbd>⌘↵</kbd>Run a query; Esc cancels it
              </li>
              <li>
                <kbd>⇧⌘P</kbd>Review SQL, then Commit
              </li>
            </ul>
          </article>
        </div>
      </div>
    </section>
  );
}
