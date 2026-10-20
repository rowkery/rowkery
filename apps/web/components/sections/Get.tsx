import { BUILD_FROM_SOURCE_URL, REPO_URL, UNQUARANTINE } from "@/lib/site";
import { CopyButton } from "../CopyButton";
import { BUILD, DownloadButton } from "../Download";
import { Pg } from "../Pg";
import "./get.css";

/** Try Rowkery: the Mac app (and the command its first launch needs while it isn't signed), or build it from source. */
const FROM_SOURCE = [`git clone ${REPO_URL}`, "cd rowkery/apps/rowkery-tauri", "npm install", "npm run tauri dev"];

export function Get() {
  return (
    <section className="band" id="get">
      <div className="head">
        <span className="eyebrow">
          <i />
          Get started
        </span>
        <h2 className="h2">Try Rowkery</h2>
      </div>
      <div className="get">
        <div>
          <Pg prop="arrow" className="peek2" />
          <div className="card" data-get="mac">
            <div className="top">
              <h3>Mac app</h3>
              <span className="rec">Recommended</span>
            </div>
            <p className="meta">Apple silicon and Intel · {BUILD}</p>
            <p>Not signed yet, so run this before the first launch:</p>
            <div className="code">
              <CopyButton text={UNQUARANTINE} />
              {UNQUARANTINE}
            </div>
            <div className="row">
              <DownloadButton />
            </div>
          </div>
        </div>
        <div>
          <Pg prop="hardhat" className="peek2" />
          <div className="card" data-get="source">
            <div className="top">
              <h3>From source</h3>
            </div>
            <p className="meta">Needs Rust, Node and Xcode’s command line tools</p>
            <div className="code">
              <CopyButton text={FROM_SOURCE.join("\n")} />
              <span className="c"># get the code{"\n"}</span>
              {`${FROM_SOURCE[0]}\n${FROM_SOURCE[1]}\n\n`}
              <span className="c"># run it with hot reload{"\n"}</span>
              {`${FROM_SOURCE[2]}\n${FROM_SOURCE[3]}`}
            </div>
            <div className="row">
              <a className="btn soft" href={BUILD_FROM_SOURCE_URL}>
                Build steps on GitHub →
              </a>
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}
