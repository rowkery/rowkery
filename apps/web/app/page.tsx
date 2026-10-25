import { Nav } from "@/components/Nav";
import { Hero } from "@/components/Hero";
import { How } from "@/components/How";
import { Agents } from "@/components/Agents";
import { Clip } from "@/components/Clip";
import { Faq } from "@/components/Faq";
import { Close } from "@/components/Close";
import { Footer } from "@/components/Footer";
import { Motion } from "@/components/Motion";

/** What keeps your data safe, in three cards. */
const FACTS = [
  ["Read-only for agents", "Agents can read your data. Any change they suggest waits for your yes."],
  ["Stays on your Mac", "No account and no cloud. Rowkery connects straight to your database."],
  ["Free and open source", "Apache 2.0 on GitHub. Sponsor it if it helps your work."],
];

/**
 * The page (2026-10-25, the quiet redesign): one calm column on a light page, each section a
 * heading, a line and one thing to look at. How it works plays three steps (your agent asks,
 * you say yes to a change, ⌘K on your own), so the order stays agent, security, keyboard; the
 * clips are the real app, filmed in its light theme.
 */
export default function Home() {
  return (
    <>
      <a className="skip btn ink" href="#top">
        Skip to content
      </a>
      <Nav />
      <main id="top">
        <Hero />
        <How />
        <Agents />

        <section className="sec wrap" id="safe">
          <div className="col">
            <h2 className="rv">Safe, private and free</h2>
            <div className="facts rv">
              {FACTS.map(([title, text]) => (
                <div className="fact" key={title}>
                  <b>{title}</b>
                  <p>{text}</p>
                </div>
              ))}
            </div>
          </div>
        </section>

        <section className="sec wrap" id="keys">
          <div className="col">
            <h2 className="rv">Quick from the keyboard</h2>
            <div className="duo rv">
              <div className="card">
                <Clip name="autocomplete" w={960} h={560} label="Typing a join while autocomplete fills in the tables, the join condition and an enum value" />
                <b>Autocomplete that knows your tables</b>
                <span>Joins, columns and enum values as you type.</span>
              </div>
              <div className="card">
                <Clip name="edit-commit" w={1100} h={640} label="Editing two cells in orders, reviewing the SQL and committing" />
                <b>Edit rows, then commit them together</b>
                <span>Change cells in the grid and check the SQL first.</span>
              </div>
            </div>
          </div>
        </section>

        <Faq />
        <Close />
      </main>
      <Footer />
      <Motion />
    </>
  );
}
