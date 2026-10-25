import { DOCS_URL, MAKER_URL, RELEASE_NOTES_URL, REPO_URL, SPONSOR_URL } from "@/lib/site";
import { Pg } from "./Pg";

/** The foot: the penguin home and the links. */
export function Footer() {
  return (
    <footer className="foot wrap">
      <div className="foot-in">
        <a className="brand" href="#top">
          <Pg tight />
          Rowkery
        </a>
        <nav aria-label="Links">
          <a href={DOCS_URL}>Docs</a>
          <a href={REPO_URL}>GitHub</a>
          <a href={RELEASE_NOTES_URL}>Release notes</a>
          <a href={SPONSOR_URL}>Sponsor</a>
          <a href={MAKER_URL}>Made by Lucas Sim</a>
        </nav>
        <span className="legal">© Rowkery · Apache 2.0</span>
      </div>
    </footer>
  );
}
