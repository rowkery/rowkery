import Link from "next/link";
import { RELEASES_URL, REPO_URL, SITE_URL } from "@/lib/site";
import type { SearchEntry } from "@/lib/search-index";
import { Mark } from "./Mark";
import { MenuButton } from "./MenuButton";
import { Search } from "./Search";

/** The bar along the top, as on rowkery.com: the mark home, search, the site, GitHub and Download. */
export function Nav({ index }: { index: SearchEntry[] }) {
  return (
    <header className="tb">
      <MenuButton />
      <Link className="brand" href="/" aria-label="Rowkery Docs, introduction">
        <Mark />
        Rowkery <span>Docs</span>
      </Link>
      <Search index={index} />
      <nav className="links" aria-label="Rowkery">
        <a className="ghost hide-sm" href={SITE_URL}>
          rowkery.com
        </a>
        <a className="grey hide-sm" href={REPO_URL}>
          <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
            <path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38v-1.33c-2.23.48-2.7-1.07-2.7-1.07-.36-.92-.89-1.17-.89-1.17-.73-.5.06-.49.06-.49.8.06 1.23.83 1.23.83.72 1.22 1.87.87 2.33.66.07-.52.28-.87.5-1.07-1.78-.2-3.65-.89-3.65-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82a7.6 7.6 0 0 1 4 0c1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48v2.2c0 .21.15.46.55.38A8.01 8.01 0 0 0 16 8c0-4.42-3.58-8-8-8Z" />
          </svg>
          GitHub
        </a>
        <a className="white" href={RELEASES_URL}>
          Download
        </a>
      </nav>
    </header>
  );
}
