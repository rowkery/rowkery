/** The main site, the repository and the latest release; the same values as apps/web/lib/site.ts. */
export const SITE_URL = "https://rowkery.com";
export const REPO_URL = "https://github.com/rowkery/rowkery";
export const RELEASES_URL = `${REPO_URL}/releases/latest`;
/** Where "Edit this page" points: the docs' own folder on the default branch. */
export const EDIT_BASE = `${REPO_URL}/edit/main/apps/docs/app`;

/** The command that lets macOS open the app while it isn't signed. */
export const UNQUARANTINE = "xattr -dr com.apple.quarantine /Applications/Rowkery.app";
