import { AGENTS } from "@/lib/agents";
import { APP_EXE } from "@/lib/site";
import { CopyButton } from "./CopyButton";

/** Claude Code's own command for adding Rowkery (what the app's Connect an agent runs for it). */
const COMMAND = `claude mcp add --scope user rowkery -- ${APP_EXE} --mcp`;

/** The agents Rowkery works with, and the one line that connects Claude Code. */
export function Agents() {
  return (
    <section className="sec wrap" id="agents">
      <div className="narrow">
        <h2 className="rv">Works with the agents you already use</h2>
        <ul className="chips rv" aria-label="Agents">
          {AGENTS.map((a) => (
            <li className="chip" key={a.id}>
              <svg viewBox="0 0 24 24" aria-hidden="true" style={a.tint ? { fill: a.tint } : undefined}>
                <path d={a.d} />
              </svg>
              {a.name}
            </li>
          ))}
        </ul>
        <div className="rv">
          <p className="label">Connect Claude Code</p>
          <div className="box">
            <CopyButton text={COMMAND} />
            <code>
              <span className="p">$ </span>
              {COMMAND}
            </code>
          </div>
          <p className="hint">
            Or press <kbd>⌘K</kbd> and pick Connect an agent in the app.
          </p>
        </div>
      </div>
    </section>
  );
}
