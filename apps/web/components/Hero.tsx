import { DownloadButton } from "./Download";
import { DOCS_URL, RELEASE, RELEASE_NOTES_URL } from "@/lib/site";
import { Pg } from "./Pg";

/** The opening: the plain logo, the beta version and what's new, the one-line pitch and the two buttons. */
export function Hero() {
  return (
    <div className="hero wrap">
      <Pg tight className="mark" />
      <a className="pill" href={RELEASE_NOTES_URL}>
        <span className="tag">Beta</span>
        Version {RELEASE.version} is out
      </a>
      <h1>
        <span className="ln">A database app for</span> <span className="ln">you and your agent</span>
      </h1>
      <p className="lead">
        Postgres and SQLite on your Mac. Quick from the keyboard, and safe to hand to <b>Claude</b> or any other agent.
      </p>
      <div className="ctas">
        <DownloadButton />
        <a className="btn lg" href={DOCS_URL}>
          Read the docs
        </a>
      </div>
      <p className="fine">Free and open source · Apple silicon and Intel · No account</p>
    </div>
  );
}
