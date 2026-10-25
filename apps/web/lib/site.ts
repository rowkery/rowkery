// Every Download button links here: the DMG scripts/release.sh uploads to the
// latest GitHub release under a stable name. Empty, the buttons scroll to the
// closing section instead.
export const DOWNLOAD_URL = "https://github.com/rowkery/rowkery/releases/latest/download/Rowkery.dmg";

/** The build the page describes. */
export const RELEASE = { version: "0.3.0", stage: "alpha" };

/** The repository and the rowkery org's GitHub Sponsors page. */
export const REPO_URL = "https://github.com/rowkery/rowkery";
export const SPONSOR_URL = "https://github.com/sponsors/rowkery";

/** The documentation site, apps/docs. */
export const DOCS_URL = "https://docs.rowkery.com";

/** The command that lets macOS open the app while it isn't signed. */
export const UNQUARANTINE = "xattr -dr com.apple.quarantine /Applications/Rowkery.app";

/** The latest release's notes, and Lucas's own site (the footer's Made by). */
export const RELEASE_NOTES_URL = `${REPO_URL}/releases/latest`;
export const MAKER_URL = "https://lucascodes.dev";

/** The app's own binary, which an MCP client runs with --mcp (what Connect an agent sets up). */
export const APP_EXE = "/Applications/Rowkery.app/Contents/MacOS/Rowkery";

/**
 * The Kit form behind the email signup under the close (its id is the number in the form's
 * share link). Kit sends the confirm-your-email message. Empty, the signup card isn't shown.
 */
export const KIT_FORM_ID = "10071822";
export const KIT_FORM_URL = `https://app.kit.com/forms/${KIT_FORM_ID}/subscriptions`;
