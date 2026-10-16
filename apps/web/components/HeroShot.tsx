"use client";

import { useEffect, useState } from "react";
import { vars } from "@/lib/vars";
import { AgentScene } from "./AgentScene";
import { Shot } from "./Shot";

type Mode = "agent" | "own";

/** On your own: three moments over the app window, 4 s apart on a 12 s loop. */
const MOMENTS = [
  { key: "⌘K", text: "orders", result: "Opened orders · 84k rows" },
  { key: "⌘↵", text: "select status, sum(total) from orders group by status", result: "5 rows" },
  { key: "⇧⌘P", text: "update orders set status = 'shipped' where id = 84204", result: "1 row changed after Commit" },
];

const LABELS: Record<Mode, string> = { agent: "With your AI agent", own: "On your own" };

/**
 * The hero's stage, with a switch over it: With your AI agent (first, 2026-10-16) plays the
 * agent, Rowkery and your database talking; On your own shows the app window with your own
 * moments. It turns over by itself after each 12 s loop until someone picks a side (or Reduce
 * Motion is on). Both stages stay mounted in one box and cross-fade, so nothing moves around.
 */
export function HeroShot() {
  const [mode, setMode] = useState<Mode>("agent");
  const [auto, setAuto] = useState(true);
  const [round, setRound] = useState(0);

  useEffect(() => {
    if (matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    // Every 12 s the stage starts over (its animations run once); unless someone picked a side, it turns too.
    const t = setInterval(() => {
      if (auto) setMode((m) => (m === "agent" ? "own" : "agent"));
      setRound((r) => r + 1);
    }, 12000);
    return () => clearInterval(t);
  }, [auto]);

  const pick = (m: Mode) => {
    setAuto(false);
    setMode(m);
    setRound((r) => r + 1);
  };

  return (
    <>
      <div className="modes" role="group" aria-label="How you use it" data-mode={mode}>
        <i className="thumb" aria-hidden="true" />
        {(["agent", "own"] as const).map((m) => (
          <button key={m} type="button" aria-pressed={mode === m} onClick={() => pick(m)}>
            {LABELS[m]}
          </button>
        ))}
      </div>
      <div className="shot" data-mode={mode}>
        <Shot name="window" eager alt="Rowkery showing the orders table of a production database, filtered to paid orders." />
        <div className="stage-own" aria-hidden={mode !== "own"}>
          {mode === "own" && (
            <div className="toasts" key={round}>
              {MOMENTS.map(({ key, text, result }, i) => (
                <div className="toast own" key={text} style={vars({ "--d": `${i * 4}s` })}>
                  <div className="hd">
                    <b>You</b>
                    <kbd>{key}</kbd>
                    <span className="env">prd</span>
                  </div>
                  <code>{text}</code>
                  <div className="res ok">{result}</div>
                </div>
              ))}
            </div>
          )}
        </div>
        <div className="stage-agent" aria-hidden={mode !== "agent"}>
          {mode === "agent" && <AgentScene key={round} />}
        </div>
      </div>
    </>
  );
}
