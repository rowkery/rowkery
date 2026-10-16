import { vars } from "@/lib/vars";

/** A plan as ⌘E shows it: each step's own share of the cost, the slowest one marked. */
const PLAN: [step: string, share: number][] = [
  ["Seq Scan on orders", 82],
  ["Hash Join", 12],
  ["Sort", 6],
];

/** Safe mode, set per connection, and what each does with the same UPDATE. */
const SAFE: [connection: string, mode: string, outcome: string, tone: string][] = [
  ["storefront prd", "Read-only", "Refuses the UPDATE", "no"],
  ["storefront stg", "Confirm writes", "Shows the SQL first", "wait"],
  ["fixtures.db", "Off", "Runs the UPDATE", ""],
];

/** The Sessions view: blockers first, then who waits on them. */
const SESSIONS: [pid: string, what: string, state: string, blocking: boolean][] = [
  ["4121", "billing-worker", "Blocks 2", true],
  ["4188", "You · orders", "Waits on 4121", false],
  ["4203", "api", "Waits on 4121", false],
];

/** When something is slow or stuck: query plans with a hint, safe mode, and the Sessions view. */
export function Tools() {
  return (
    <section className="sec" id="tools">
      <div className="wrap">
        <h2 className="h2 reveal">
          <span className="ln">See why a query is slow</span> <span className="ln">and what’s holding it up</span>
        </h2>
        <p className="lead reveal">Read the plan with one key, choose how careful each connection is, and see every session on the server.</p>
        <div className="grid">
          <article className="card wide reveal" style={{ minHeight: 0 }} data-card="plan">
            <div className="speed">
              <div>
                <h3>Query plans with a hint for the slowest step</h3>
                <p>
                  Press <kbd>⌘E</kbd> to see a query’s plan in place of its results. The slowest step is marked, with one hint, such as a missing index or out-of-date statistics.
                </p>
              </div>
              <div className="ruler" role="img" aria-label="A plan of three steps: a sequential scan on orders takes 82 percent of the cost, a hash join 12, a sort 6. Hint: add an index on orders (customer_id).">
                {PLAN.map(([step, share], i) => {
                  const w = `${share}%`;
                  return (
                    <div className={`rr${i === 0 ? " slow" : ""}`} key={step}>
                      <span>{step}</span>
                      <span className="trk">
                        <i style={vars({ "--w": w, "--d": `${i / 10}s` }, { width: w })} />
                      </span>
                      <span className="rv">{share}%</span>
                    </div>
                  );
                })}
                <p className="hint">
                  <b>Hint</b> Add an index on orders (customer_id)
                </p>
              </div>
            </div>
          </article>

          <article className="card reveal" data-card="safe">
            <h3>Safe mode for each connection</h3>
            <p>With Confirm writes, you see the exact SQL before anything is written. Read-only refuses every write.</p>
            <div className="rows safe">
              {SAFE.map(([connection, mode, outcome, tone]) => (
                <div className="row" key={connection}>
                  <span>{connection}</span>
                  <span className="flip">
                    <span className={mode === "Read-only" ? "ok" : undefined}>{mode}</span>
                    <span className={tone}>{outcome}</span>
                  </span>
                </div>
              ))}
            </div>
          </article>

          <article className="card reveal" data-card="sessions">
            <h3>What’s running, and who blocks whom</h3>
            <p>Sessions lists every session on the database, with the ones blocking others first. Cancel a query or end a session from there.</p>
            <div className="rows sess">
              {SESSIONS.map(([pid, what, state, blocking]) => (
                <div className="row" key={pid}>
                  <span>
                    {pid} <em>{what}</em>
                  </span>
                  <span className={`flip${blocking ? " end" : ""}`}>
                    <span className={blocking ? "no" : undefined}>{state}</span>
                    <span className={blocking ? undefined : "ok"}>{blocking ? "Ended" : "Running"}</span>
                  </span>
                </div>
              ))}
            </div>
          </article>
        </div>
      </div>
    </section>
  );
}
