import type { ReactNode } from "react";
import { CodeIcon, HeartIcon, NoUserIcon } from "../Icons";
import { Title, units } from "./parts";

/**
 * 04 · For everyone: the page turns white and says three plain facts, very big, each with a
 * card. The discs at the foot jump to each one. engine.ts (sceneFree) plays it out; without it
 * the three stand one under another on the white page.
 */
const FACTS: [word: string, icon: ReactNode, title: string, text: string][] = [
  ["Free.", <HeartIcon key="h" />, "No paid tier", "Download it and use all of it. Sponsors on GitHub help fund the work."],
  ["Open source.", <CodeIcon key="c" />, "Apache 2.0", "Read the code, build it yourself, or open an issue on GitHub."],
  ["No account.", <NoUserIcon key="n" />, "Nothing to sign up for", "Open the app and connect. Rowkery talks straight to your database."],
];

export function FreeScene() {
  return (
    <section className="scene free" id="free" style={units(5.4)} data-scene="free">
      <div className="stage">
        <div className="flood" />
        {FACTS.map(([word, icon, title, text]) => (
          <div className="fact" key={word}>
            <Title lines={[word]} className="big" />
            <div className="fcard">
              <span className="ic">{icon}</span>
              <div>
                <b>{title}</b>
                <p>{text}</p>
              </div>
            </div>
          </div>
        ))}
        <div className="discs">
          {FACTS.map(([word, icon], i) => (
            <button type="button" aria-label={word.replace(".", "")} data-disc={i} key={word}>
              {icon}
            </button>
          ))}
        </div>
      </div>
    </section>
  );
}
