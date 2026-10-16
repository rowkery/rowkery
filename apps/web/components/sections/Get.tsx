import { BUILD_FROM_SOURCE_URL, DOCS_URL, REPO_URL, SPONSOR_URL, UNQUARANTINE } from "@/lib/site";
import { CopyCommand } from "../CopyCommand";
import { BUILD, DownloadButton } from "../Download";
import { GitHubIcon, HeartIcon } from "../Icons";
import { Mark } from "../Mark";

/**
 * The close: Download, right under it the command that opens the unsigned app and Build from
 * source, then a note from Lucas on why sponsoring helps (2026-10-16: friendlier, an open
 * source project built in his free time); the footer, with the outline penguin behind them all.
 */
export function Get() {
  return (
    <section className="cta" id="get">
      <Mark className="outline" outline />
      <div className="wrap in">
        <h2 className="h2 reveal">Try Rowkery</h2>
        <p className="lead reveal">A Mac app for Postgres and SQLite. The source is on GitHub.</p>
        <div className="ctas reveal" style={{ animation: "none" }}>
          <DownloadButton />
        </div>
        <p className="meta">{`Apple silicon and Intel · ${BUILD}`}</p>
        <div className="first">
          <p>
            The first time, choose Open Anyway in Privacy &amp; Security, or run this in Terminal:
          </p>
          <CopyCommand command={UNQUARANTINE} />
        </div>
        <div className="ctas alt">
          <a className="btn grey" href={BUILD_FROM_SOURCE_URL}>
            Build from source
          </a>
        </div>
        <div className="sponsor reveal">
          <Mark className="sp-mark" />
          <div>
            <h3>Rowkery is open source</h3>
            <p>
              I build it in my free time, around what I needed every day as an engineer working with databases. Sponsors help it keep growing and pay the Apple developer fee, so the Mac app can be signed.
            </p>
            <a className="btn grey" href={SPONSOR_URL}>
              <HeartIcon />
              Sponsor on GitHub
            </a>
          </div>
        </div>
      </div>
      <footer className="foot">
        <div className="wrap foot-in">
          <span>Rowkery · Postgres and SQLite for the Mac</span>
          <span className="foot-links">
            <a href={REPO_URL}>
              <GitHubIcon />
              GitHub
            </a>
            <a href={DOCS_URL}>Docs</a>
            <a href={SPONSOR_URL}>Sponsor</a>
            <span>
              Made by <a href="https://lucascodes.dev">Lucas Sim</a>
            </span>
          </span>
        </div>
      </footer>
    </section>
  );
}
