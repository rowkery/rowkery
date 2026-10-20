import { DOWNLOAD_URL, RELEASE } from "@/lib/site";
import { AppleIcon } from "./Icons";

/** Where every Download button goes: the DMG once DOWNLOAD_URL is set, the closing section until then. */
export const DOWNLOAD_HREF = DOWNLOAD_URL || "#get";

/** The build the page describes, as "v0.1.3 alpha". */
export const BUILD = `v${RELEASE.version} ${RELEASE.stage}`;

export function DownloadButton() {
  return (
    <a className="btn ink" href={DOWNLOAD_HREF}>
      <AppleIcon />
      Download for Mac
    </a>
  );
}
