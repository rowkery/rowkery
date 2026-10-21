import type { CSSProperties } from "react";
import { DownloadButton } from "./Download";
import { Pg } from "./Pg";

/**
 * Meet Rowkery: the two words with the logo between them, a line under it naming what Rowkery
 * is doing (the lines take turns on a CSS cycle; with a mouse, moving across the hero picks
 * one), then the one-line pitch and the buttons. The logo stays the plain mark here: no props,
 * no hops. With the story playing (components/story/engine.ts) the hero holds still while you
 * scroll the first stretch: the words part and the logo flies up into the brand in the nav.
 */
const JOBS = ["Taking your agent’s query", "Checking it before it runs", "Hiding card_number", "Holding a change for you", "Free and open source"];

const turn = (i: number) => ({ "--i": i }) as CSSProperties;

export function Hero() {
  return (
    <section className="hero" id="hero" data-hero>
      <div className="h-pin">
        <div className="h-mid">
          <h1 className="h-title">
            <span className="ht ht-l">
              <span>Meet</span>
            </span>{" "}
            <span className="h-slot" aria-hidden="true">
              <span className="hpg" data-pg="hero">
                <span className="look">
                  <span className="intro">
                    <Pg />
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
                {JOBS.map((job, i) => (
                  <span className="job" style={turn(i)} key={job}>
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
            <a className="btn soft" href="#agents" data-jump>
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
      </div>
    </section>
  );
}
