"use client";

import { useEffect, useRef, useState } from "react";
import { Pg } from "../Pg";
import { SearchIcon } from "../Icons";
import "./keys.css";

/**
 * On your own: six shortcuts (the app's own chords, src/commands.ts), each playing in a small
 * window for a few seconds before the next; a click picks one, and hovering holds it. The
 * penguin hops onto a big keycap that shows the chord.
 */
const CHORDS = [
  ["⌘K", "Jump anywhere"],
  ["Space", "See a full row"],
  ["⌘F", "Filter rows"],
  ["⌘↵", "Run a query"],
  ["⌘E", "Read the plan"],
  ["⇧⌘P", "Review, then Commit"],
] as const;

const ORDERS: [id: number, email: string, status: string, total: string][] = [
  [4118, "lee@duck.com", "paid", "$64.00"],
  [4119, "mia@hey.com", "paid", "$412.00"],
  [4120, "raj@fastmail.com", "paid", "$388.50"],
  [4121, "ana@proton.me", "shipped", "$301.20"],
  [4122, "tom@pm.me", "paid", "$18.90"],
];

export function Keys() {
  const [shown, setShown] = useState(0);
  const [held, setHeld] = useState(false);
  // The demo plays only while it's on screen: off screen, each chord's end would still re-render.
  const [seen, setSeen] = useState(false);
  const kb = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const io = new IntersectionObserver(([e]) => setSeen(e.isIntersecting));
    io.observe(kb.current!);
    return () => io.disconnect();
  }, []);
  const [cap, setCap] = useState(0);
  const [pressed, setPressed] = useState(false);
  const pg = useRef<HTMLSpanElement>(null);
  // The penguin jumps, and the keycap changes as it lands.
  useEffect(() => {
    const el = pg.current;
    if (!el || shown === cap) return;
    el.classList.remove("jump");
    void el.offsetWidth;
    el.classList.add("jump");
    const land = setTimeout(() => {
      setCap(shown);
      setPressed(true);
    }, 560);
    const up = setTimeout(() => setPressed(false), 720);
    return () => {
      clearTimeout(land);
      clearTimeout(up);
    };
  }, [shown, cap]);
  return (
    <section className="band" id="keys">
      <div className="head art-head">
        <div>
          <span className="eyebrow">
            <i />
            On your own
          </span>
          <h2 className="h2">Built for the keyboard</h2>
          <p className="lead">Every action has a shortcut, with or without an agent.</p>
        </div>
        <div className="art keyscene" aria-hidden="true">
          <div className={`bigkey${pressed ? " press" : ""}`}>{CHORDS[cap][0]}</div>
          <span className="keypg" ref={pg}>
            <Pg />
          </span>
        </div>
      </div>
      <div className={`kb${held || !seen ? " held" : ""}`} ref={kb} onMouseEnter={() => setHeld(true)} onMouseLeave={() => setHeld(false)}>
        <div className="chords" role="tablist" aria-label="Shortcuts">
          {CHORDS.map(([keys, what], i) => (
            <button
              key={keys}
              type="button"
              className="chord"
              role="tab"
              aria-selected={i === shown}
              onClick={() => setShown(i)}
              onAnimationEnd={() => setShown((i + 1) % CHORDS.length)}
              data-chord={i}
            >
              <kbd>{keys}</kbd>
              {what}
            </button>
          ))}
        </div>
        <div className="win" aria-hidden="true">
          <div className="win-bar">
            <span className="lights">
              <i />
              <i />
              <i />
            </span>
            storefront <span className="env">prd</span>
            <span className="win-tab">orders</span>
          </div>
          <div className="win-body">
            <View on={shown === 0}>
              <div className="palette">
                <div className="q">
                  <SearchIcon />
                  <span>
                    <span className="typed">ord</span>
                    <span className="caret" />
                  </span>
                </div>
                <div className="r hit">
                  orders<span>table · 48,210 rows</span>
                </div>
                <div className="r">
                  order_items<span>table</span>
                </div>
                <div className="r miss">
                  customers<span>table</span>
                </div>
                <div className="r miss">
                  Connect an agent<span>command</span>
                </div>
                <div className="r">
                  Open it in its own tab<span>⌘-click</span>
                </div>
              </div>
            </View>
            <View on={shown === 1}>
              <div className="split">
                <Grid rows={ORDERS} selected={4119} />
                <div className="look">
                  <div>Order 4119</div>
                  <div>
                    email<span>mia@hey.com</span>
                  </div>
                  <div>
                    status<span>paid</span>
                  </div>
                  <div>
                    customer_id<span className="fk">c_2281 ↵</span>
                  </div>
                  <div>
                    created_at<span>Oct 18 09:41</span>
                  </div>
                  <div>
                    total<span>$412.00</span>
                  </div>
                </div>
              </div>
            </View>
            <View on={shown === 2}>
              <div className="chips">
                <span className="chip">status = paid</span>
                <span className="chip">total &gt; 100</span>
              </div>
              <Grid rows={[...ORDERS, [4130, "kai@icloud.com", "paid", "$146.75"]]} gone={[4118, 4121, 4122]} />
            </View>
            <View on={shown === 3}>
              <div className="editor">
                <span className="bar" />
                <span className="k">SELECT</span> customer_id, <span className="k">sum</span>(total){"\n"}
                <span className="k">FROM</span> orders <span className="k">GROUP BY</span> 1 <span className="k">ORDER BY</span> 2 <span className="k">DESC</span>;
              </div>
              <div className="grid-mock stream">
                <div>
                  <span>#</span>
                  <span>customer_id</span>
                  <span className="num">sum</span>
                </div>
                {[
                  ["c_2281", "$9,412.00"],
                  ["c_0917", "$7,388.50"],
                  ["c_4410", "$6,301.20"],
                  ["c_1006", "$5,018.90"],
                ].map(([c, sum], i) => (
                  <div key={c}>
                    <span>{i + 1}</span>
                    <span>{c}</span>
                    <span className="num">{sum}</span>
                  </div>
                ))}
              </div>
            </View>
            <View on={shown === 4}>
              <div className="plan">
                {(
                  [
                    ["Seq Scan on orders", 82],
                    ["Hash Join", 12],
                    ["Sort", 6],
                  ] as const
                ).map(([step, share], i) => (
                  <div className={`s${i ? "" : " hot"}`} key={step}>
                    <span>{step}</span>
                    <span className="b">
                      <i style={{ transform: `scaleX(${share / 100})` }} />
                    </span>
                    <b>{share}%</b>
                  </div>
                ))}
              </div>
              <div className="hint">
                <Pg tight />
                <span>
                  <b>Most of the time goes to reading all of orders.</b> An index on orders.customer_id would let Postgres skip most of it.
                </span>
              </div>
            </View>
            <View on={shown === 5}>
              <div className="review">
                <span className="k">BEGIN</span>;{"\n"}
                <span className="k">UPDATE</span> orders <span className="k">SET</span> status = &apos;shipped&apos; <span className="k">WHERE</span> id = 4119;{"\n"}
                <span className="k">UPDATE</span> orders <span className="k">SET</span> status = &apos;shipped&apos; <span className="k">WHERE</span> id = 4120;{"\n"}
                <span className="k">COMMIT</span>;
              </div>
              <div className="editsbar">
                <span className="count">2 staged edits</span>
                <span className="btn soft sm">Discard</span>
                <span className="btn ink sm">Commit</span>
              </div>
            </View>
          </div>
        </div>
      </div>
    </section>
  );
}

function View({ on, children }: { on: boolean; children: React.ReactNode }) {
  return <div className={`view${on ? " on" : ""}`}>{children}</div>;
}

/** A few rows of orders, one of them selected, or some of them filtered away. */
function Grid({ rows, selected, gone = [] }: { rows: typeof ORDERS; selected?: number; gone?: number[] }) {
  return (
    <div className="grid-mock">
      <div>
        <span>id</span>
        <span>email</span>
        <span>status</span>
        <span className="num">total</span>
      </div>
      {rows.map(([id, email, status, total]) => (
        <div key={id} className={id === selected ? "sel" : gone.includes(id) ? "gone" : undefined}>
          <span>{id}</span>
          <span>{email}</span>
          <span>{status}</span>
          <span className="num">{total}</span>
        </div>
      ))}
    </div>
  );
}
