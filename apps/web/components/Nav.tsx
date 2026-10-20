import { DOCS_URL, REPO_URL } from "@/lib/site";
import { BUILD, DOWNLOAD_HREF } from "./Download";
import { GitHubIcon } from "./Icons";
import { Pg } from "./Pg";

/** The bar along the top: the penguin home, the build, the sections and the docs, the repository, and Download. */
export function Nav() {
  return (
    <header className="nav">
      <div className="nav-in">
        <a className="brand" href="#top" aria-label="Rowkery, top of the page">
          <Pg tight />
          Rowkery
        </a>
        <a className="ver" href="#get">
          {BUILD}
        </a>
        <nav className="links" aria-label="Site">
          <a href="#agents">With an agent</a>
          <a href="#security">Security</a>
          <a href="#keys">On your own</a>
          <a href="#faq">FAQ</a>
          <a href={DOCS_URL}>Docs</a>
        </nav>
        <div className="end">
          <a className="btn soft sm gh" href={REPO_URL}>
            <GitHubIcon />
            Star
          </a>
          <a className="btn ink sm" href={DOWNLOAD_HREF}>
            Download
          </a>
        </div>
      </div>
    </header>
  );
}
