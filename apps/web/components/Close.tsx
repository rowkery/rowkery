import { DOCS_URL, UNQUARANTINE } from "@/lib/site";
import { CopyButton } from "./CopyButton";
import { DownloadButton } from "./Download";
import { Pg } from "./Pg";

/** Get Rowkery: the plain logo, Download, and the one line the unsigned beta needs before its first launch. */
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
        <p className="label">Before the first launch</p>
        <div className="box">
          <CopyButton text={UNQUARANTINE} />
          <code>
            <span className="p">$ </span>
            {UNQUARANTINE}
          </code>
        </div>
      </div>
    </div>
  );
}
