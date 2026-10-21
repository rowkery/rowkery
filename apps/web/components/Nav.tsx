import { REPO_URL } from "@/lib/site";
import { DOWNLOAD_HREF } from "./Download";
import { GitHubIcon } from "./Icons";
import { Pg } from "./Pg";

/**
 * The floating bar along the top: the penguin home (the hero's penguin flies into it as you
 * scroll), the chapter you're reading with how far along the story you are, the repository and
 * Download. The story engine fills in the chapter; it means nothing to a screen reader.
 */
export function Nav() {
  return (
    <header className="nav" data-nav>
      <a className="brand" href="#top" aria-label="Rowkery, top of the page">
        <span className="mk">
          <Pg tight />
        </span>
        Rowkery
      </a>
      <div className="chapter" aria-hidden="true">
        <div className="ch-in">
          <span className="ch-n" />
          <span className="ch-t" />
        </div>
        <span className="ch-bar">
          <i />
        </span>
      </div>
      <div className="end">
        <a className="btn soft sm gh" href={REPO_URL}>
          <GitHubIcon />
          Star
        </a>
        <a className="btn ink sm dl" href={DOWNLOAD_HREF}>
          Download
        </a>
      </div>
    </header>
  );
}

/** On a phone, Download in a dock at the foot of the screen; it steps aside once the close is in view. */
export function Dock() {
  return (
    <nav className="dock" aria-label="Download" data-dock>
      <a className="brand" href="#top">
        <span className="mk">
          <Pg tight />
        </span>
        Rowkery
      </a>
      <a className="btn ink sm" href={DOWNLOAD_HREF}>
        Download
      </a>
    </nav>
  );
}
