import type { ReactNode } from "react";

/**
 * What every change is timed on (scripts/budgets.json). No numbers here until the known
 * slowdown when switching windows is fixed (2026-10-16): the section says what is
 * measured, and the timings come back once they can be backed.
 */
const TIMED: ReactNode[] = [
  <>
    From <kbd>⌘↵</kbd> to rows on screen
  </>,
  "From clicking a table to seeing its rows",
  "Scrolling through a thousand rows",
  "From opening the app to its window",
];

export function Speed() {
  return (
    <section className="sec" id="speed">
      <div className="wrap">
        <h2 className="h2 reveal">
          <span className="ln">Quick to open</span> <span className="ln">and quick to query</span>
        </h2>
        <p className="lead reveal">Changes to Rowkery are timed in the packaged app against a local Postgres, and each of these steps has a time it has to stay under.</p>
        <div className="grid">
          <article className="card wide reveal" style={{ minHeight: 0 }} data-card="timed">
            <h3>What gets timed</h3>
            <ul className="timed">
              {TIMED.map((what, i) => (
                <li key={i}>
                  <span>{what}</span>
                </li>
              ))}
            </ul>
          </article>
        </div>
      </div>
    </section>
  );
}
