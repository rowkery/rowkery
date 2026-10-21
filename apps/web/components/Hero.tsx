import type { CSSProperties } from "react";
import { DownloadButton } from "./Download";
import { Pg, PropArt, type PgProp } from "./Pg";

/**
 * Meet Rowkery: the two words with the penguin between them, a line under it naming the job
 * the penguin is doing (the jobs take turns on a CSS cycle; with a mouse, moving across the
 * hero picks one), then the one-line pitch and the buttons. Scrolling parts the words and the
 * penguin flies up into the brand in the nav (components/story/engine.ts).
 */
const JOBS: [PgProp, string][] = [
  ["letter", "Taking your agent’s query"],
  ["magnifier", "Checking it before it runs"],
  ["shades", "Hiding card_number"],
  ["sign", "Holding a change for you"],
  ["hat", "Free and open source"],
];

const turn = (i: number) => ({ "--i": i }) as CSSProperties;

export function Hero() {
  return (
    <section className="hero" id="hero" data-hero>
      <div className="h-mid">
        <h1 className="h-title">
          <span className="ht ht-l">
            <span>Meet</span>
          </span>{" "}
          <span className="h-slot" aria-hidden="true">
            <span className="hpg" data-pg="hero">
              <span className="look">
                <span className="intro">
                  <span className="back" />
                  <span className="hop1">
                    <span className="hopper">
                      <Pg />
                      <span className="props">
                        {JOBS.map(([p], i) => (
                          <span className="hp" style={turn(i)} key={p}>
                            <PropArt prop={p} />
                          </span>
                        ))}
                      </span>
                    </span>
                  </span>
                </span>
              </span>
            </span>
          </span>{" "}
          <span className="ht ht-r">
            <span>Rowkery.</span>
          </span>
        </h1>
        <div className="now-o" aria-hidden="true">
          <div className="now">
            <i />
            <span className="jobs">
              {JOBS.map(([p, job], i) => (
                <span className="job" style={turn(i)} key={p}>
                  {job}
                </span>
              ))}
            </span>
          </div>
        </div>
      </div>
      <div className="h-foot">
        <p className="h-sub">
          <span className="ln">Postgres and SQLite on your Mac,</span> <span className="ln">with or without AI.</span>
        </p>
        <div className="ctas">
          <DownloadButton />
          <a className="btn soft" href="#agent" data-jump>
            See how it works
          </a>
        </div>
        <p className="trust">Free and open source · Apple silicon and Intel · No account</p>
      </div>
      <div className="cue-o" aria-hidden="true">
        <div className="cue">
          <i />
          Scroll
        </div>
      </div>
    </section>
  );
}
