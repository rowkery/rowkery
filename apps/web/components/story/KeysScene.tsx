import { SearchIcon, TableIcon } from "../Icons";
import { Pg } from "../Pg";
import { Side, Sql, Steps, Title, TitleBar, units } from "./parts";

/**
 * 03 · On your own: three of the app's chords (apps/rowkery-tauri/src/commands.ts) on big
 * keycaps leaning toward the pointer, a penguin standing on the last key, and a window behind
 * that shows what each one does. The markup is the finished state; engine.ts (sceneKeys) plays
 * it out.
 */
const TABLES: [string, string][] = [
  ["customers", "61k"],
  ["events", "4.1M"],
  ["order_items", "310k"],
  ["orders", "84k"],
  ["products", "2.4k"],
];
const RESULTS: [label: string, note: string, table: boolean][] = [
  ["orders", "table · 84,210 rows", true],
  ["order_items", "table", true],
  ["Show structure", "⌥⌘2", false],
  ["customers", "table", true],
  ["Filter rows", "⌘F", false],
];
const ROWS = [
  ["84210", "lee@duck.com", "$64.00"],
  ["84209", "mia@hey.com", "$412.00"],
  ["84207", "raj@fastmail.com", "$388.50"],
  ["84204", "ana@proton.me", "$301.20"],
];
const STAGED = [
  ["UPDATE", " orders ", "SET", " status = 'shipped' ", "WHERE", " id = 84207;"],
  ["UPDATE", " orders ", "SET", " total = 18.90 ", "WHERE", " id = 84122;"],
];

export function KeysScene() {
  return (
    <section className="scene" id="keys" style={units(4.1)} data-scene="keys">
      <div className="stage">
        <Title lines={["Built for the keyboard"]} />
        <Steps
          steps={[
            ["Jump anywhere", "⌘K, then a few letters. Tables, queries and commands are all there."],
            ["Run a query", "⌘↵ runs the statement under the cursor. The rows come back in the same tab."],
            ["Review, then Commit", "⇧⌘P shows the exact SQL your edits will run. Nothing changes until you press Commit."],
          ]}
        />
        <div className="obj" aria-hidden="true">
          <div className="sc">
            <div className="lift win k-win">
              <TitleBar env="local">
                <span className="chip">
                  <SearchIcon size={14} />
                  Search tables, commands <span className="muted">⌘K</span>
                </span>
              </TitleBar>
              <div className="body">
                <Side host="localhost" env="local" tables={TABLES} />
                <div className="main">
                  <div className="panel on">
                    <div className="mhead">
                      <span className="who">Query 1</span>
                    </div>
                    <div className="pal">
                      <div className="q">
                        <SearchIcon />
                        <span className="k-typed">ord</span>
                        <span className="pcaret" />
                      </div>
                      {RESULTS.map(([label, note, table], i) => (
                        <div className={`res${i === 0 ? " sel" : ""}${i >= 3 ? " hide" : ""}`} key={label}>
                          {table && <TableIcon />}
                          {label}
                          <small>{note}</small>
                        </div>
                      ))}
                    </div>
                  </div>
                  <div className="panel on">
                    <div className="mhead">
                      <span className="who">orders</span>
                      <span className="pill">⌘↵ ran it</span>
                    </div>
                    <Sql parts={[["SELECT"], " id, email, total ", ["FROM"], " orders\n", ["WHERE"], " status = 'paid';"]} />
                    <div className="grid-t">
                      <div className="r">
                        <span>id</span>
                        <span>email</span>
                        <span className="num">total</span>
                      </div>
                      {ROWS.map(([id, email, total]) => (
                        <div className="r in k-row" key={id}>
                          <span>{id}</span>
                          <span>{email}</span>
                          <span className="num">{total}</span>
                        </div>
                      ))}
                    </div>
                  </div>
                  <div className="panel on">
                    <div className="mhead">
                      <span className="who">Review SQL</span>
                      <span className="pill">2 changes</span>
                    </div>
                    <div className="staged">
                      {STAGED.map((parts) => (
                        <div className="row" key={parts[5]}>
                          <span>
                            {parts.map((p, i) => (i % 2 ? p : <b key={i}>{p}</b>))}
                          </span>
                          <span className="muted">1 row</span>
                        </div>
                      ))}
                      <div className="act">
                        <span className="btn soft">Discard</span>
                        <span className="btn ink k-commit">Commit</span>
                      </div>
                    </div>
                  </div>
                </div>
              </div>
            </div>
            <div className="lift keys">
              <span className="key k-shift gone">⇧</span>
              <span className="key">⌘</span>
              <span className="key k-last">
                <b className="kl">K</b>
                <span className="kpg" data-pg="keys">
                  <span className="hopper">
                    <Pg tight />
                  </span>
                </span>
              </span>
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}
