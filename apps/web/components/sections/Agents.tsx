import { Checkpoint } from "../Checkpoint";
import { CommitDemo } from "../CommitDemo";
import { MaskDemo } from "../MaskDemo";
import { Mark } from "../Mark";
import { HostMotion, LogMotion, ShareMotion, TablesMotion } from "../CardMotion";

/**
 * Your agent and your database, first on the page (2026-10-16: agent, then security,
 * then the keyboard): local read-only access with no account, changes that wait for your
 * Commit, sensitive columns; then the log, the limits, the tables it can see, timed sharing and
 * the masked host.
 */
export function Agents() {
  return (
    <section className="sec" id="agents">
      <div className="wrap">
        <h2 className="h2 reveal">
          <span className="ln">Let your AI agent read your database</span> <span className="ln">while you keep full control</span>
        </h2>
        <p className="lead reveal">
          Connect Claude, Cursor or any MCP client. It reads only what you let it see, and anything it wants to change waits for you.
        </p>
        <div className="grid">
          <article className="card wide mascot reveal">
            <h3>Read-only, on your Mac</h3>
            <p>Your agent can run SELECT queries through the app on your Mac. There’s no account to make, and your data doesn’t go through a server of ours.</p>
            <Mark className="pengu" />
          </article>

          <article className="card reveal" data-card="proposals">
            <h3>Nothing changes until you press Commit</h3>
            <p>Your agent can send an INSERT, UPDATE or DELETE with its reason. You see every row before and after, then commit it or send it back.</p>
            <CommitDemo />
          </article>

          <article className="card reveal" data-card="sensitive">
            <h3>Sensitive columns stay hidden</h3>
            <p>Mark a column and agents only ever get a stand-in for its values. Turn on Presenting when you share your screen, and they show as dots.</p>
            <MaskDemo />
          </article>

          <article className="card reveal">
            <h3>A log of every query</h3>
            <p>What the agent asked, what it got back, and why anything was blocked.</p>
            <LogMotion />
          </article>

          <article className="card reveal">
            <h3>Limits on every query</h3>
            <p>Read-only, up to 1,000 rows, and stopped after 10 seconds.</p>
            <Checkpoint />
          </article>

          <article className="card reveal" data-card="tables">
            <h3>Choose which tables it can see</h3>
            <p>Views and joins that touch other tables are blocked.</p>
            <TablesMotion />
          </article>

          <article className="card reveal">
            <h3>Sharing that ends when you choose</h3>
            <p>Share for an hour or for the rest of the day.</p>
            <ShareMotion />
          </article>

          <article className="card wide reveal" style={{ minHeight: 0 }}>
            <h3>Your agent never sees your password</h3>
            <p>It stays in your Mac’s Keychain, and the agent only sees a masked host. Claude Desktop and Claude Code connect in one click.</p>
            <HostMotion />
          </article>
        </div>
      </div>
    </section>
  );
}
