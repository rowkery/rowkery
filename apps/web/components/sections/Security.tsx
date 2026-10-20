import { Pg } from "../Pg";
import "./security.css";

/**
 * Security first: what an agent sees, what it can run, and what gets written, as three cards
 * of plain facts, with a penguin peeking out of an igloo. Safe mode is the connection's own
 * choice (docs/spec.md: neither it nor the environment is preselected), so the third card
 * names the modes rather than tying them to an environment.
 */
const LAYERS: [title: string, rows: [what: string, value: string, tone?: "on"][]][] = [
  [
    "What your agent sees",
    [
      ["Tables you pick", "3 of 41"],
      ["Sensitive columns", "stand-in"],
      ["Host and password", "masked"],
    ],
  ],
  [
    "What it can run",
    [
      ["Statements", "one SELECT"],
      ["Rows per query", "1,000 at most"],
      ["Time per query", "10 s"],
    ],
  ],
  [
    "What gets written",
    [
      ["Safe mode", "Confirm writes"],
      ["Or, stricter", "Read-only"],
      ["Before Commit", "exact SQL shown", "on"],
    ],
  ],
];

export function Security() {
  return (
    <section className="band" id="security">
      <div className="head art-head">
        <div>
          <span className="eyebrow">
            <i />
            Security
          </span>
          <h2 className="h2">Security first</h2>
          <p className="lead">Your data never passes through a server of ours.</p>
        </div>
        <div className="art" aria-hidden="true">
          <Igloo />
        </div>
      </div>
      <div className="layers">
        {LAYERS.map(([title, rows]) => (
          <article className="layer" key={title}>
            <h3>{title}</h3>
            {rows.map(([what, value, tone]) => (
              <div className="flag" key={what}>
                {what}
                <code className={tone}>{value}</code>
              </div>
            ))}
          </article>
        ))}
      </div>
      <p className="also">No account · Passwords in your Keychain · SSH tunnels and TLS</p>
    </section>
  );
}

/**
 * An igloo of blocks, with the penguin popping out of its door now and then. The door is a box
 * of its own over the drawing, so the penguin moves on the compositor (moving a shape inside an
 * SVG repaints it every frame).
 */
function Igloo() {
  return (
    <div className="igloo">
      <svg viewBox="0 0 260 156">
        <defs>
          <clipPath id="igloo-dome">
            <path d="M10 150 A120 120 0 0 1 250 150 Z" />
          </clipPath>
        </defs>
        <path d="M10 150 A120 120 0 0 1 250 150 Z" fill="var(--card2)" />
        <g clipPath="url(#igloo-dome)" stroke="var(--bg)" strokeWidth="3" fill="none">
          <path d="M0 120 H260 M0 90 H260 M0 60 H260" />
          <path d="M60 150 V120 M120 150 V120 M90 120 V90 M150 120 V90 M210 120 V90 M60 90 V60 M120 90 V60 M180 90 V60 M100 60 V30 M160 60 V30" />
        </g>
        <path d="M138 150 V116 A37 37 0 0 1 212 116 V150 Z" fill="var(--card2)" stroke="var(--bg)" strokeWidth="3" />
        <path d="M144 150 V118 A31 31 0 0 1 206 118 V150 Z" fill="var(--bg)" />
        <path d="M0 150 H260" stroke="var(--line2)" strokeWidth="2" />
      </svg>
      <span className="door">
        <Pg tight />
      </span>
    </div>
  );
}
