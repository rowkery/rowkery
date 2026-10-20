import { DISCUSSIONS_URL, DOCS_URL, ISSUES_URL, MAKER_URL, RELEASE_NOTES_URL, REPO_URL, SPONSOR_URL } from "@/lib/site";
import { DOWNLOAD_HREF } from "./Download";
import { Pg } from "./Pg";
import { Walkway } from "./Ticker";

/** The foot: what Rowkery is, the links, and a penguin pacing the last line. */
export function Footer() {
  return (
    <footer>
      <div className="band foot">
        <div className="about">
          <a className="brand" href="#top">
            <Pg tight />
            Rowkery
          </a>
          <p>Postgres and SQLite for the Mac, with or without your AI agent.</p>
        </div>
        <div>
          <h4>Product</h4>
          <ul>
            <li><a href={DOWNLOAD_HREF}>Download</a></li>
            <li><a href={DOCS_URL}>Docs</a></li>
            <li><a href={RELEASE_NOTES_URL}>Release notes</a></li>
            <li><a href="#faq">FAQ</a></li>
          </ul>
        </div>
        <div>
          <h4>Open source</h4>
          <ul>
            <li><a href={REPO_URL}>GitHub</a></li>
            <li><a href={ISSUES_URL}>Issues</a></li>
            <li><a href={DISCUSSIONS_URL}>Discussions</a></li>
            <li><a href={SPONSOR_URL}>Sponsor</a></li>
          </ul>
        </div>
        <div>
          <h4>Made by</h4>
          <ul>
            <li><a href={MAKER_URL}>Lucas Sim</a></li>
          </ul>
        </div>
      </div>
      <div className="legal">
        <Walkway />
        <span>© Rowkery · Apache 2.0</span>
        <span>Psst, type “rookery”</span>
      </div>
    </footer>
  );
}
