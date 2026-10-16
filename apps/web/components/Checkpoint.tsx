import { vars } from "@/lib/vars";
import { DatabaseIcon, PromptIcon } from "./Icons";
import { Mark } from "./Mark";

/**
 * Four tool calls, 3 s apart on a 12 s loop. Reads pass Rowkery's gate and come back as rows;
 * refusals are stamped and sent back. The letters name each call for the Reduce Motion rules.
 */
const CALLS: [id: string, tool: string, arg: string, verdict: string, ok: boolean][] = [
  ["a", "query", "select status, count(*) as orders, sum(total) from orders where placed_at > now() - interval '7 days' group by status", "Read · 5 rows", true],
  ["b", "query", "delete from orders where status = 'cancelled'", "Refused · DELETE isn’t allowed", false],
  ["c", "describe_table", "orders", "Read · 6 columns", true],
  ["d", "query", "select * from events where payload::text like '%checkout_failed%'", "Refused · would scan 4.1M rows", false],
];

/** What comes back to the agent from each read, as it leaves the database. */
const RETURNS: [what: string, delay: string][] = [
  ["5 rows", "0s"],
  ["6 columns", "6s"],
];

/**
 * The checkpoint rail (CSS only): your agent, Rowkery's gate, your database, and the calls between them.
 * Each call and return rides a lane as wide as the stage, so it moves by transform (a percentage of
 * the stage) and never makes the page lay out or repaint while it plays.
 */
export function Checkpoint() {
  return (
    <div
      className="stage"
      role="img"
      aria-label="Tool calls travel from your agent to the Rowkery gate. Reads pass through to the database and come back with rows. A DELETE and a full scan are stamped refused and sent back."
    >
      <div className="rail" />
      <div className="flow" />
      <div className="st agent">
        <div className="box">
          <PromptIcon />
        </div>
        <b>Your agent</b>
      </div>
      <div className="st gate">
        <i className="ring ok" />
        <i className="ring no" />
        <div className="box">
          <Mark width={32} height={34} />
        </div>
        <b>Rowkery</b>
      </div>
      <div className="st db">
        <div className="box">
          <DatabaseIcon />
        </div>
        <b>Your database</b>
      </div>
      {CALLS.map(([id, tool, arg, verdict, ok], i) => (
        <div className={`lane ${id}${ok ? "" : " no"}`} key={id} style={vars({ "--d": `${i * 3}s` })}>
          <div className="pk">
            <code>
              <b>{tool}</b>
              {arg}
            </code>
            <span className={`vd ${ok ? "ok" : "no"}`}>{verdict}</span>
          </div>
        </div>
      ))}
      {RETURNS.map(([what, delay]) => (
        <div className="lane back" key={what} style={vars({ "--d": delay })}>
          <div className="rt">{what}</div>
        </div>
      ))}
    </div>
  );
}
