import { ENGINES, MORE_ENGINES } from "@/lib/engines";
import { DISCUSSIONS_URL } from "@/lib/site";
import { Pg } from "../Pg";
import "./databases.css";

/**
 * The databases: the two Rowkery works with today, then two lanes of the ones we'd like to add
 * (2026-10-16: "as many as possible"; no dates, no promises) gliding past in opposite
 * directions, a penguin riding a floe in each. Each lane is drawn twice, so sliding it by half
 * its width lands it where it began.
 */
export function Databases() {
  return (
    <section className="band flush" id="databases">
      <div className="head">
        <span className="eyebrow">
          <i />
          Databases
        </span>
        <h2 className="h2">Postgres and SQLite today</h2>
      </div>
      <div className="now">
        {ENGINES.map(([name, d]) => (
          <span className="eng" key={name}>
            <svg viewBox="0 0 24 24" aria-hidden="true">
              <path d={d} fill="currentColor" />
            </svg>
            {name}
          </span>
        ))}
      </div>
      <svg width={0} height={0} style={{ position: "absolute" }} aria-hidden="true">
        <defs>
          {MORE_ENGINES.filter(([, , crop]) => crop).map(([name, , crop]) => (
            <clipPath id={`crop-${name}`} key={name}>
              <path d={crop!.clip} />
            </clipPath>
          ))}
        </defs>
      </svg>
      <div className="lanes" aria-label="Databases we’d like to add">
        <Lane engines={MORE_ENGINES.slice(0, 8)} />
        <Lane engines={MORE_ENGINES.slice(8)} reverse />
      </div>
      <p className="eng-cap">
        Which one should be next? <a href={DISCUSSIONS_URL}>Tell us on GitHub</a>.
      </p>
    </section>
  );
}

function Lane({ engines, reverse }: { engines: typeof MORE_ENGINES; reverse?: boolean }) {
  const list = (copy: boolean) => {
    const spans = engines.map(([name, d, crop]) => (
      <span key={name + copy} aria-hidden={copy || undefined}>
        <svg viewBox={crop?.viewBox ?? "0 0 24 24"} aria-hidden="true">
          <path d={d} fill="currentColor" clipPath={crop ? `url(#crop-${name})` : undefined} />
        </svg>
        {name}
      </span>
    ));
    spans.splice(3, 0, <Pg floe className="floe" key={`floe${copy}`} />);
    return spans;
  };
  return (
    <div className={`lane${reverse ? " rev" : ""}`}>
      <div className="lane-in">
        {list(false)}
        {list(true)}
      </div>
    </div>
  );
}
