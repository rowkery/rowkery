import { DOCS_URL, MAKER_URL, RELEASE_NOTES_URL, REPO_URL, SPONSOR_URL } from "@/lib/site";
import { Pg } from "./Pg";

/** The foot: the penguin home, the links, and the hint about the parade. */
export function Footer() {
  return (
    <footer className="foot">
      <a className="brand" href="#top">
        <span className="mk">
          <Pg tight />
        </span>
        Rowkery
      </a>
      <nav aria-label="Links">
        <a href={DOCS_URL}>Docs</a>
        <a href={REPO_URL}>GitHub</a>
        <a href={RELEASE_NOTES_URL}>Release notes</a>
        <a href={SPONSOR_URL}>Sponsor</a>
        <a href={MAKER_URL}>Made by Lucas Sim</a>
      </nav>
      <div className="legal">
        <span>© Rowkery · Apache 2.0</span>
        <span>Psst, type “rookery”</span>
      </div>
    </footer>
  );
}
