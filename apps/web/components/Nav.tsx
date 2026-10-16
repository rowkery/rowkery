import { DOCS_URL, REPO_URL } from "@/lib/site";
import { Mark } from "./Mark";
import { DOWNLOAD_HREF } from "./Download";
import { GitHubIcon } from "./Icons";

/** The bar along the top: the mark home, the sections and the docs, the repository, and Download. */
export function Nav() {
  return (
    <header className="nav">
      <div className="wrap nav-in">
        <a className="brand" href="#top" aria-label="Rowkery, top of the page">
          <Mark />
          Rowkery
        </a>
        <nav className="links" aria-label="Site">
          <a href="#agents">With an agent</a>
          <a href="#security">Security</a>
          <a href="#keys">On your own</a>
          <a href="#exploring">Exploring</a>
          <a href={DOCS_URL}>Docs</a>
        </nav>
        <div className="btns">
          <a className="btn grey" href={REPO_URL} aria-label="Rowkery on GitHub">
            <GitHubIcon />
            GitHub
          </a>
          <a className="btn white" href={DOWNLOAD_HREF}>
            Download
          </a>
        </div>
      </div>
    </header>
  );
}
