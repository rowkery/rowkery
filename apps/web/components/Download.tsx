import { DOWNLOAD_URL, RELEASE } from "@/lib/site";
import { DownloadIcon } from "./Icons";

/** Where every Download button goes: the DMG once DOWNLOAD_URL is set, the closing section until then. */
export const DOWNLOAD_HREF = DOWNLOAD_URL || "#get";

/** The build the page describes, as "0.1.0 alpha". */
export const BUILD = `${RELEASE.version} ${RELEASE.stage}`;

export function DownloadButton() {
  return (
    <a className="btn white big" href={DOWNLOAD_HREF}>
      <DownloadIcon />
      Download for macOS
    </a>
  );
}
