// Every Download button links here: the DMG scripts/release.sh uploads to the
// latest GitHub release under a stable name. Empty, the buttons scroll to the
// closing section instead.
export const DOWNLOAD_URL = "https://github.com/rowkery/rowkery/releases/latest/download/Rowkery.dmg";

/** The build the page describes. */
export const RELEASE = { version: "0.1.0", stage: "alpha" };

/** The repository, its build steps and Discussions, and the rowkery org's GitHub Sponsors page. */
export const REPO_URL = "https://github.com/rowkery/rowkery";
export const BUILD_FROM_SOURCE_URL = `${REPO_URL}#build-from-source`;
export const DISCUSSIONS_URL = `${REPO_URL}/discussions`;
export const SPONSOR_URL = "https://github.com/sponsors/rowkery";

/** The documentation site, apps/docs. */
export const DOCS_URL = "https://docs.rowkery.com";

/** The command that lets macOS open the app while it isn't signed. */
export const UNQUARANTINE = "xattr -dr com.apple.quarantine /Applications/Rowkery.app";
