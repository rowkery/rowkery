import { SPONSOR_URL } from "@/lib/site";
import { HeartIcon } from "../Icons";
import { Pg } from "../Pg";
import "./faq.css";

/** A note from Lucas, who makes Rowkery, with hearts rising from a penguin; then the common questions. */
export function Note() {
  return (
    <section className="band">
      <div className="note">
        <div className="note-art" aria-hidden="true">
          <Pg />
          <HeartIcon />
          <HeartIcon />
          <HeartIcon />
        </div>
        <div>
          <blockquote>“I build Rowkery in my free time, around what I needed every day as an engineer working with databases.”</blockquote>
          <div className="by">
            <span>Lucas Sim, who makes Rowkery</span>
            <a className="btn soft sm" href={SPONSOR_URL}>
              <HeartIcon />
              Sponsor on GitHub
            </a>
          </div>
        </div>
      </div>
    </section>
  );
}

const QUESTIONS = [
  ["Do I need an AI agent?", "No. Everything works on your own, from the keyboard."],
  ["Does my data go through your servers?", "No. Rowkery connects straight from your Mac to your database."],
  ["Which agents work with it?", "Claude Code and Claude Desktop in one click. Cursor and other MCP clients with a short config entry."],
  ["Why does macOS warn me the first time?", "The alpha isn’t signed by Apple yet. Choose Open Anyway in Privacy & Security."],
];

export function Faq() {
  return (
    <section className="band" id="faq">
      <div className="faq">
        <div className="head">
          <span className="eyebrow">
            <i />
            FAQ
          </span>
          <h2 className="h2">Common questions</h2>
          <Pg prop="question" tilted className="faq-art" />
        </div>
        <div>
          {QUESTIONS.map(([q, a], i) => (
            <details key={q} open={i === 0}>
              <summary>
                {q}
                <span className="pm" aria-hidden="true">
                  +
                </span>
              </summary>
              <p>{a}</p>
            </details>
          ))}
        </div>
      </div>
    </section>
  );
}
