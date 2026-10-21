import { LockIcon } from "../Icons";
import { Pg } from "../Pg";
import { SEC, type SecKey } from "./data";
import { Steps, Title, units } from "./parts";

/**
 * 02 · Security: a big penguin beside a card (on top of it on a phone) that shows, in turn,
 * the tables you share, a row as the agent gets it, and the connection as the agent sees it.
 * The markup is the finished state; engine.ts (sceneSecurity) plays it out.
 */
const TABLES = ["orders", "products", "customers", "api_keys", "events", "sessions"];
const SHARED = 3;

/** A value as the agent ends up with it; the engine morphs it from the real one. */
const Masked = ({ k }: { k: SecKey }) => (
  <span className="v m" data-sec={k}>
    {SEC[k][1]}
  </span>
);

export function SecurityScene() {
  return (
    <section className="scene" id="security" style={units(5.2)} data-scene="security">
      <div className="stage">
        <Title lines={["Security first"]} />
        <Steps
          steps={[
            ["Only the tables you share", "Your agent sees the tables you switch on. Here, 3 of 41."],
            ["Sensitive columns get a stand‑in", "Mark a column sensitive and the agent only ever gets a masked value."],
            ["Your password stays with you", "Agents get a masked host, never the user or password. Passwords are kept in your Mac’s Keychain."],
          ]}
        />
        <div className="obj" aria-hidden="true">
          <div className="sc">
            <div className="lift gpg" data-pg="security">
              <div className="hopper">
                <Pg props={["magnifier", "shades", "key"]} prop="key" />
              </div>
            </div>
            <div className="lift lc scard">
              <div className="box">
                <div className="spane">
                  <h4>Shared with agents</h4>
                  <div className="sub">3 of 41 tables</div>
                  {TABLES.map((t, i) => (
                    <div className={`tl${i < SHARED ? " on" : ""}`} key={t}>
                      {t}
                      <span className="sw" />
                    </div>
                  ))}
                </div>
                <div className="spane">
                  <h4>customers</h4>
                  <div className="sub">one row, as your agent gets it</div>
                  <div className="kv">
                    <span>name</span>
                    <span className="v">Mia Chen</span>
                  </div>
                  <div className="kv">
                    <span>email</span>
                    <span className="v">mia@hey.com</span>
                  </div>
                  <div className="kv">
                    <span>card_number</span>
                    <Masked k="card" />
                  </div>
                  <div className="kv">
                    <span>phone</span>
                    <Masked k="phone" />
                  </div>
                  <div className="kv">
                    <span>created_at</span>
                    <span className="v">2026-10-14 09:41</span>
                  </div>
                  <span className="beam" />
                </div>
                <div className="spane">
                  <h4>storefront</h4>
                  <div className="sub">the connection, as your agent sees it</div>
                  <div className="kv">
                    <span>name</span>
                    <span className="v">storefront</span>
                  </div>
                  <div className="kv">
                    <span>host</span>
                    <Masked k="host" />
                  </div>
                  <div className="kv">
                    <span>user</span>
                    <Masked k="user" />
                  </div>
                  <div className="kv">
                    <span>password</span>
                    <Masked k="password" />
                  </div>
                  <div className="kc">
                    <LockIcon />
                    <span>
                      Saved in your <b>Mac’s Keychain</b>
                    </span>
                  </div>
                  <span className="beam" />
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}
