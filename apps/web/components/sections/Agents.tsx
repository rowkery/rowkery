"use client";

import { useEffect, useRef, useState } from "react";
import { ChatIcon, DatabaseIcon } from "../Icons";
import { Pg, type PgProp } from "../Pg";
import "./agents.css";

/**
 * With your agent: four steps down the right, and a stage that stays in view on the left
 * showing each one as it reaches the middle of the screen: the query, Rowkery's checks, the
 * rows with a sensitive column swapped for its stand-in, and a change waiting for Commit. The
 * penguin above the stage holds what fits the step. On a phone the stage sticks under the nav
 * and the steps scroll beneath it. Without scripts the first step simply shows.
 */
const STEPS: { title: string; text: string; prop: PgProp }[] = [
  { title: "Your agent asks", text: "A SELECT goes to Rowkery, on your Mac.", prop: "letter" },
  { title: "Rowkery checks it", text: "Shared tables only, read-only, 1,000 rows at most, 10 seconds.", prop: "magnifier" },
  { title: "Sensitive columns stay hidden", text: "The agent gets a stand-in, never the value.", prop: "shades" },
  { title: "Changes wait for you", text: "See every row before and after, then press Commit.", prop: "sign" },
];
const CHECKS: [what: string, value: string, ok: boolean][] = [
  ["Table is shared", "orders", true],
  ["One read-only statement", "SELECT", true],
  ["Row limit", "1,000", true],
  ["Time limit", "10 s", true],
  ["Joins a table you didn’t share", "payments", false],
];

export function Agents() {
  const [step, setStep] = useState(0);
  const steps = useRef<HTMLDivElement>(null);
  const pg = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const io = new IntersectionObserver(
      (entries) => {
        for (const e of entries) if (e.isIntersecting) setStep(Number((e.target as HTMLElement).dataset.step));
      },
      { rootMargin: "-48% 0px -48% 0px" },
    );
    steps.current!.querySelectorAll(".step").forEach((s) => io.observe(s));
    return () => io.disconnect();
  }, []);
  // The penguin hops as it picks up the next prop.
  useEffect(() => {
    const el = pg.current;
    if (!step || !el) return;
    el.classList.remove("jump");
    void el.offsetWidth;
    el.classList.add("jump");
  }, [step]);
  const on = (n: number) => (step === n ? " on" : "");
  return (
    <section className="band" id="agents">
      <div className="head">
        <span className="eyebrow">
          <i />
          With your agent
        </span>
        <h2 className="h2">Let your AI agent read your database</h2>
      </div>
      <div className="scene">
        <div className="stage-wrap">
          <div className="stage" data-step={step}>
            <div className="stage-pg" ref={pg} aria-hidden="true">
              <Pg prop={STEPS[step].prop} />
            </div>
            <div className="card">
              <div className="route" aria-hidden="true">
                <div className="node lit">
                  <div className="box">
                    <ChatIcon />
                  </div>
                  Agent
                </div>
                <div className="wire">
                  <i />
                </div>
                <div className="node rowkery lit">
                  <div className="box">
                    <Pg tight />
                  </div>
                  Rowkery
                </div>
                <div className={`wire two${step === 1 || step === 3 ? " stops" : ""}`}>
                  <i />
                </div>
                <div className={`node${step === 0 || step === 2 ? " lit" : ""}`}>
                  <div className="box">
                    <DatabaseIcon />
                  </div>
                  storefront
                </div>
              </div>
              <div className="panels">
                <div className={`panel${on(0)}`}>
                  <div className="panel-cap">
                    <span>query · from Claude</span>
                    <span>read-only</span>
                  </div>
                  <div className="sql">
                    <span className="k">SELECT</span> email, total{"\n"}
                    <span className="k">FROM</span> orders{"\n"}
                    <span className="k">WHERE</span> <span className="typing">created_at &gt; now() - interval &apos;7 days&apos;</span>
                    <span className="caret" />
                  </div>
                  <p className="why">“Which customers spent the most this week?”</p>
                </div>
                <div className={`panel${on(1)}`}>
                  <div className="panel-cap">
                    <span>checked by Rowkery</span>
                    <span>before it runs</span>
                  </div>
                  <div className="checks">
                    {CHECKS.map(([what, value, ok]) => (
                      <div className="check" key={what}>
                        {what} <code>{value}</code>
                        <span className={`ok${ok ? "" : " no"}`}>{ok ? "✓ yes" : "✕ blocked"}</span>
                      </div>
                    ))}
                  </div>
                </div>
                <div className={`panel${on(2)}`}>
                  <div className="panel-cap">
                    <span>what the agent gets back</span>
                    <span>3 rows</span>
                  </div>
                  <div className="rows">
                    <div>
                      <span>email</span>
                      <span>card_number</span>
                      <span>total</span>
                    </div>
                    {[
                      ["mia@hey.com", "masked:7f3a9e01b2", "$412.00"],
                      ["raj@fastmail.com", "masked:1b06d2c4e8", "$388.50"],
                      ["ana@proton.me", "masked:e94c1150a3", "$301.20"],
                    ].map(([email, card, total]) => (
                      <div key={email}>
                        <span>{email}</span>
                        <span className="masked">{card}</span>
                        <span>{total}</span>
                      </div>
                    ))}
                  </div>
                  <p className="why">card_number is marked sensitive, so the agent only ever sees a stand-in.</p>
                </div>
                <div className={`panel${on(3)}`}>
                  <div className="panel-cap">
                    <span>proposed by Claude</span>
                    <span>waiting for you</span>
                  </div>
                  <div className="sql">
                    <span className="k">UPDATE</span> orders <span className="k">SET</span> status = &apos;refunded&apos;{"\n"}
                    <span className="k">WHERE</span> id = 4120
                  </div>
                  <div className="diff">
                    <span className="muted">status</span>
                    <span>
                      <s>paid</s> → <ins>refunded</ins>
                    </span>
                    <span className="muted">1 row</span>
                  </div>
                  <p className="why">“Customer asked for a refund on order 4120.”</p>
                  <div className="act">
                    <span className="btn ink sm">Commit</span>
                    <span className="btn soft sm">Discard</span>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </div>
        <div className="steps" ref={steps}>
          {STEPS.map((s, i) => (
            <div className={`step${on(i)}`} data-step={i} key={s.title}>
              <span className="num">0{i + 1}</span>
              <h3>{s.title}</h3>
              <p>{s.text}</p>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}
