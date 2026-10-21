import { REPO_URL, UNQUARANTINE } from "@/lib/site";
import { CopyButton } from "./CopyButton";
import { BUILD, DownloadButton } from "./Download";
import { Pg } from "./Pg";
import { Colony } from "./Colony";

/**
 * The close: the opening move once more (Get, the penguin in a party hat, Rowkery.), the
 * Download, the command the unsigned alpha needs before its first launch, and the colony on
 * the ice at the foot of the same screen.
 */
export function Close() {
  return (
    <section className="close" id="get" data-close>
      <div className="c-mid">
        <h2 className="h-title">
          <span className="ht ht-l">
            <span>Get</span>
          </span>{" "}
          <span className="h-slot" aria-hidden="true">
            <span className="hpg2" data-pg="close">
              <span className="intro">
                <span className="back" />
                <span className="hopper">
                  <Pg prop="hat" />
                </span>
              </span>
            </span>
          </span>{" "}
          <span className="ht ht-r">
            <span>Rowkery.</span>
          </span>
        </h2>
        <div className="h-foot">
          <p className="h-sub">Free for your Mac, on Apple silicon and Intel.</p>
          <div className="ctas">
            <DownloadButton />
            <a className="btn soft" href={REPO_URL}>
              View on GitHub
            </a>
          </div>
          <div className="unsigned" data-get="mac">
            <span>The {BUILD} isn’t signed by Apple yet. Run this once before the first launch:</span>
            <span className="cmd">
              <CopyButton text={UNQUARANTINE} />
              <code>{UNQUARANTINE}</code>
            </span>
          </div>
        </div>
      </div>
      <Colony />
    </section>
  );
}
