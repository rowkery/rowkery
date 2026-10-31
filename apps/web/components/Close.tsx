import { DOCS_URL } from "@/lib/site";
import { DownloadButton } from "./Download";
import { Pg } from "./Pg";

/** Get Rowkery: the plain logo, Download and the docs. */
export function Close() {
  return (
    <div className="wrap" id="get">
      <div className="close rv">
        <Pg tight className="mark" />
        <h2>Get Rowkery</h2>
        <p className="sub">Free for your Mac, with no account to make.</p>
        <div className="ctas">
          <DownloadButton />
          <a className="btn lg" href={DOCS_URL}>
            Read the docs
          </a>
        </div>
      </div>
    </div>
  );
}
