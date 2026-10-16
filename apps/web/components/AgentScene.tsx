import { DatabaseIcon } from "./Icons";
import { Mark } from "./Mark";

/** The rows the agent's question finds, lit as the query reads them. */
const ROWS: [id: string, status: string, age: string][] = [
  ["84117", "pending", "4 days"],
  ["84121", "pending", "4 days"],
  ["84160", "pending", "3 days"],
  ["84173", "shipped", "1 day"],
  ["84188", "paid", "today"],
];

/**
 * With your AI agent, in the hero (CSS only, a 12 s loop): you ask your agent a question; its
 * query goes to Rowkery on your Mac, which checks it and passes it to your database; the rows come
 * back. Then the agent proposes a change, which stops at Rowkery to wait for your Commit, and it
 * answers you. Dots ride lanes between the three (a lane spans its gap, so translating it moves
 * the dot across); everything moves by transform and opacity only.
 */
export function AgentScene() {
  return (
    <div className="scene" role="img" aria-label="You ask your AI agent which orders are stuck. Its read-only query passes through Rowkery to your database and three rows come back. The agent then proposes cancelling them, and Rowkery holds that change until you press Commit.">
      <div className="sc-agent">
        <div className="sc-hd">Your AI agent</div>
        <p className="sc-l you">Which orders are stuck in pending?</p>
        <p className="sc-l t1">
          <b>query</b> select id, status from orders where status = &apos;pending&apos;
        </p>
        <p className="sc-l t2 ok">Read · 3 rows</p>
        <p className="sc-l t3">
          <b>propose_change</b> update orders set status = &apos;cancelled&apos; …
        </p>
        <p className="sc-l t4 wait">Waiting for your Commit</p>
        <p className="sc-l t5 say">Three orders have been pending for over 3 days. I’ve proposed cancelling them for you to review.</p>
      </div>
      <div className="sc-gap g1" aria-hidden="true">
        <i className="sc-dot d-q" />
        <i className="sc-dot d-r" />
        <i className="sc-dot d-w" />
      </div>
      <div className="sc-gate">
        <i className="sc-ring ok" />
        <i className="sc-ring hold" />
        <div className="sc-mark">
          <Mark width={34} height={36} />
        </div>
        <b>Rowkery</b>
        <span>on your Mac</span>
        <em className="sc-tag ok">Read-only ✓</em>
        <em className="sc-tag hold">Held for you</em>
      </div>
      <div className="sc-gap g2" aria-hidden="true">
        <i className="sc-dot d-q2" />
        <i className="sc-dot d-r2" />
      </div>
      <div className="sc-db">
        <div className="sc-hd">
          <DatabaseIcon />
          orders
        </div>
        {ROWS.map(([id, status, age]) => (
          <div className={`sc-row${status === "pending" ? " hit" : ""}`} key={id}>
            <span>{id}</span>
            <span>{status}</span>
            <span>{age}</span>
          </div>
        ))}
      </div>
    </div>
  );
}
