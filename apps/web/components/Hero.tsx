import { RELEASE, RELEASE_NOTES_URL, REPO_URL } from "@/lib/site";
import { ConnectCard } from "./ConnectCard";
import { DownloadButton } from "./Download";

/** The top of the page: the build, the line, Download and GitHub, and connecting your agent beside them. */
export function Hero() {
  return (
    <section className="band hero">
      <div>
        <a className="badge" href={RELEASE_NOTES_URL}>
          <span className="dot" />
          <b>v{RELEASE.version}</b> <span className="go">What’s new →</span>
        </a>
        <h1 className="h1">
          <span className="ln">Postgres and SQLite</span>
          <span className="ln">on your Mac</span>
          <span className="ln em">with or without AI</span>
        </h1>
        <p className="lead">Free and open source. Nothing changes until you press Commit.</p>
        <div className="ctas">
          <DownloadButton />
          <a className="btn soft" href={REPO_URL}>
            View on GitHub →
          </a>
        </div>
        <p className="trust">Apache 2.0 · Apple silicon and Intel · No account</p>
      </div>
      <ConnectCard />
    </section>
  );
}
