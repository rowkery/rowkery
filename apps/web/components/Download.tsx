import { DOWNLOAD_URL } from "@/lib/site";
import { AppleIcon } from "./Icons";

/** Where every Download button goes: the DMG once DOWNLOAD_URL is set, the closing section until then. */
export const DOWNLOAD_HREF = DOWNLOAD_URL || "#get";

export function DownloadButton() {
  return (
    <a className="btn ink lg" href={DOWNLOAD_HREF}>
      <AppleIcon />
      Download for Mac
    </a>
  );
}
