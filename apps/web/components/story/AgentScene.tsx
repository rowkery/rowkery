import { ChatIcon, ShadesIcon } from "../Icons";
import { Pg } from "../Pg";
import { AGENT_SQL, CARDS } from "./data";
import { Side, Sql, Steps, Title, TitleBar, units } from "./parts";

/**
 * 01 · With your agent: the agent asks, Rowkery checks the query, the sensitive column comes
 * back as stand-ins, and a change the agent proposes waits for Commit. The markup is the
 * finished state; the engine plays it out as you scroll (engine.ts, sceneAgent).
 */
const TABLES: [string, string][] = [
  ["api_keys", "140"],
  ["customers", "61k"],
  ["events", "4.1M"],
  ["order_items", "310k"],
  ["orders", "84k"],
  ["products", "2.4k"],
];
const ROWS = [
  ["mia@hey.com", "$412.00"],
  ["raj@fastmail.com", "$388.50"],
  ["ana@proton.me", "$301.20"],
];
const CHECKS = [
  ["Table is shared", "orders"],
  ["One read-only statement", "SELECT"],
  ["Row limit", "1,000"],
  ["Time limit", "10 s"],
];

export function AgentScene() {
  return (
    <section className="scene" id="agent" style={units(6.6)} data-scene="agent">
      <div className="stage">
        <Title lines={["Let your AI agent", "read your database"]} />
        <Steps
          steps={[
            ["Your agent asks", "A SELECT goes to Rowkery, on your Mac."],
            ["Rowkery checks it first", "Shared tables only, read-only, 1,000 rows at most, 10 seconds."],
            ["Sensitive columns stay hidden", "The agent gets a stand-in instead of the value."],
            ["Changes wait for you", "See every row before and after, then press Commit."],
          ]}
        />
        <div className="obj" aria-hidden="true">
          <div className="sc">
            <div className="lift win a-win">
              <TitleBar env="prd">
                <span className="chip">
                  <i className="dot" />
                  MCP · shared
                </span>
              </TitleBar>
              <div className="body">
                <Side host="prd.shop.internal" env="prd" tables={TABLES} on="orders" />
                <div className="main">
                  <div className="a-query">
                    <div className="mhead">
                      <span className="who">
                        <i>
                          <ChatIcon />
                        </i>
                        Query from Claude
                      </span>
                      <span className="pill">read-only</span>
                    </div>
                    <Sql parts={AGENT_SQL} className="sql a-sql" />
                    <div className="grid-t a-grid">
                      <div className="r">
                        <span>email</span>
                        <span>card_number</span>
                        <span className="num">total</span>
                      </div>
                      {ROWS.map(([email, total], i) => (
                        <div className="r in" key={email}>
                          <span>{email}</span>
                          <span className="cc mask">{CARDS[i][1]}</span>
                          <span className="num">{total}</span>
                        </div>
                      ))}
                    </div>
                  </div>
                  <div className="panel a-review">
                    <div className="mhead">
                      <span className="who">
                        <i>
                          <ChatIcon />
                        </i>
                        Proposed by Claude
                      </span>
                      <span className="pill">waiting for you</span>
                    </div>
                    <div className="review">
                      <Sql parts={[["UPDATE"], " orders ", ["SET"], " status = 'refunded'\n", ["WHERE"], " id = 4120;"]} />
                      <div className="diff">
                        <span className="muted">status</span>
                        <span>
                          <s>paid</s> → <ins>refunded</ins>
                        </span>
                        <span className="muted">1 row</span>
                      </div>
                      <p className="why">“Customer asked for a refund on order 4120.”</p>
                      <div className="act">
                        <span className="btn soft">Discard</span>
                        <span className="btn ink a-commit">Commit</span>
                      </div>
                    </div>
                  </div>
                </div>
              </div>
            </div>
            <div className="lift lc a-ask">
              <div className="bubble">
                <span className="av">
                  <ChatIcon />
                </span>
                <div>
                  <b>You, to Claude</b>
                  <p>Who ordered something this week?</p>
                </div>
              </div>
            </div>
            <div className="lift lc checks a-checks">
              <div className="cap2">
                <span>checked by Rowkery</span>
                <span>before it runs</span>
              </div>
              {CHECKS.map(([what, v]) => (
                <div className="check done" key={what}>
                  {what} <code>{v}</code>
                  <span className="ok">✓ yes</span>
                </div>
              ))}
            </div>
            <div className="lift lc a-legend">
              <div className="legend">
                <span className="ic">
                  <ShadesIcon />
                </span>
                <p>
                  <b>card_number</b> is marked sensitive, so the agent gets a stand-in.
                </p>
              </div>
            </div>
            <div className="lift lc toast a-toast">
              <span className="ok">✓</span>Committed · 1 row changed
            </div>
            <div className="lift peek a-peek" data-pg="agent">
              <div className="hopper">
                <Pg props={["letter", "magnifier", "shades", "sign"]} prop="letter" />
              </div>
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}
