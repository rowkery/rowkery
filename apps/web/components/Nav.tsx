import { DOWNLOAD_HREF } from "./Download";
import { REPO_URL } from "@/lib/site";
import { GitHubIcon } from "./Icons";
import { Pg } from "./Pg";

/** The floating rounded bar along the top: the penguin home, the sections, the repository and Download. */
export function Nav() {
  return (
    <header className="nav wrap">
      <div className="bar">
        <a className="brand" href="#top" aria-label="Rowkery, top of the page">
          <Pg tight />
          Rowkery
        </a>
        <nav className="links" aria-label="Sections">
          <a href="#how">How it works</a>
          <a href="#agents">Agents</a>
          <a href="#safe">Security</a>
          <a href="#faq">FAQ</a>
        </nav>
        <div className="end">
          <a className="btn sm gh" href={REPO_URL}>
            <GitHubIcon />
            Star
          </a>
          <a className="btn sm ink" href={DOWNLOAD_HREF}>
            Download
          </a>
        </div>
      </div>
    </header>
  );
}
