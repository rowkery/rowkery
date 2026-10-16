import { REPO_URL } from "@/lib/site";
import { BUILD, DownloadButton } from "./Download";
import { HeroShot } from "./HeroShot";
import { GitHubIcon } from "./Icons";
import { Mark } from "./Mark";

/**
 * Meet Rowkery: the build, then the name, which arrives as "Rookery" (a penguin colony, where
 * it comes from) and turns into Rowkery as its second o drops out and an orange w drops in,
 * "kery" making room for it, the penguin hopping as it does (CSS, once, on load). Then one line, the two ways in, and the real app
 * window, used on your own or with an agent.
 */
export function Hero() {
  return (
    <section className="hero">
      <div className="wrap">
        <span className="pill">
          <i aria-hidden="true" />
          {`${BUILD} · Apple silicon and Intel`}
        </span>
        <h1 className="h1" aria-label="Meet Rowkery">
          <span aria-hidden="true">Meet</span>
          <Mark className="hop" />
          <span className="name" aria-hidden="true">
            Ro
            <span className="swap">
              <span className="from">o</span>
              <span className="to">w</span>
              <span className="to lit">w</span>
            </span>
            <span className="rest">kery</span>
          </span>
        </h1>
        <p className="origin">The name comes from rookery, a colony of penguins.</p>
        <p className="sub">A Mac app for Postgres and SQLite. Use it on your own, or let your AI agent read your database through it. Nothing changes until you press Commit.</p>
        <div className="ctas">
          <DownloadButton />
          <a className="btn grey big" href={REPO_URL}>
            <GitHubIcon />
            View on GitHub
          </a>
        </div>
        <HeroShot />
      </div>
    </section>
  );
}
