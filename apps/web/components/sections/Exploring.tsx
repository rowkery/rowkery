import { MORE_ENGINES } from "@/lib/engines";
import { DISCUSSIONS_URL } from "@/lib/site";
import { BulbIcon, ChatIcon, CloudIcon, EnginesIcon, UserIcon, WindowIcon } from "../Icons";

/** Ideas being looked at (2026-10-16): no dates, no promises. */
const IDEAS = [
  [EnginesIcon, "More databases", "Postgres and SQLite are the start. We’d like to add as many as we can, from MySQL and SQL Server to MongoDB and ClickHouse."],
  [CloudIcon, "Cloud agents you turn on yourself", "Agents running in the cloud could reach a connection you choose, once you turn that on."],
  [BulbIcon, "Better queries and indexes", "Your agent could look at a slow query and suggest a faster version, or an index to add."],
  [WindowIcon, "Windows and Linux", "Rowkery on more computers than the Mac."],
  [UserIcon, "A separate login for agents", "A read-only database user that only your agent’s queries run as."],
] as const;

/**
 * The databases we'd like to add, gliding past in a band (CSS, a 50 s loop). The list is drawn
 * twice, so sliding the track by half its width lands it where it began; only transform moves.
 */
function Marquee() {
  const list = (copy: boolean) =>
    MORE_ENGINES.map(([name, d, crop]) => (
      <li key={`${name}${copy ? "-copy" : ""}`} data-copy={copy ? "" : undefined} aria-hidden={copy || undefined}>
        <svg width={30} height={30} viewBox={crop?.viewBox ?? "0 0 24 24"} aria-hidden="true">
          <path d={d} fill="currentColor" clipPath={crop ? `url(#crop-${name})` : undefined} />
        </svg>
        {name}
      </li>
    ));
  return (
    <div className="marquee reveal">
      <svg width={0} height={0} style={{ position: "absolute" }} aria-hidden="true">
        <defs>
          {MORE_ENGINES.filter(([, , crop]) => crop).map(([name, , crop]) => (
            <clipPath id={`crop-${name}`} key={name}>
              <path d={crop!.clip} />
            </clipPath>
          ))}
        </defs>
      </svg>
      <ul className="track" aria-label="Databases we’d like to add">
        {list(false)}
        {list(true)}
      </ul>
    </div>
  );
}

/** What might come next, and where to say what you'd use. */
export function Exploring() {
  return (
    <section className="sec" id="exploring">
      <div className="wrap">
        <h2 className="h2 reveal">What we’re exploring</h2>
        <p className="lead reveal">Ideas we’re looking into. None of them has a date yet.</p>
      </div>
      <Marquee />
      <div className="wrap">
        <div className="grid three">
          {IDEAS.map(([Icon, title, text]) => (
            <article className="card mini reveal" key={title}>
              <div className="ic">
                <Icon />
              </div>
              <h3>{title}</h3>
              <p>{text}</p>
            </article>
          ))}
          <article className="card mini reveal" data-card="discuss">
            <div className="ic">
              <ChatIcon />
            </div>
            <h3>Tell us what you’d use</h3>
            <p>Ideas and votes go in GitHub Discussions.</p>
            <a className="btn grey" href={DISCUSSIONS_URL}>
              Open Discussions
            </a>
          </article>
        </div>
      </div>
    </section>
  );
}
