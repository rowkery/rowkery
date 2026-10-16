import { CheckIcon } from "./Icons";

/**
 * The cards' small loops (2026-10-16: "each card, add some motion"), drawn in HTML so they
 * can move, in the app's own look. CSS only; each moves by transform and opacity alone.
 */

/** ⌘K (8 s): the keys go down, the search opens, "orders" is typed and the list narrows to it, ↵ opens it. */
export function PaletteMotion() {
  return (
    <div className="kp" role="img" aria-label="Pressing Command K opens the search. Typing orders narrows the tables to orders and order_items, and Return opens orders.">
      <div className="kp-keys" aria-hidden="true">
        <kbd className="k1">⌘</kbd>
        <kbd className="k1">K</kbd>
        <kbd className="k2">↵</kbd>
      </div>
      <div className="kp-box" aria-hidden="true">
        <div className="kp-in">
          <span className="kp-word">
            orders
            <i />
          </span>
          <span className="kp-ph">Search tables, commands</span>
        </div>
        <div className="kp-res">
          <i className="kp-sel" />
          {[
            ["orders", "84k rows", "a"],
            ["order_items", "310k rows", "a"],
            ["products", "2.4k rows", "b"],
            ["customers", "61k rows", "b"],
          ].map(([name, size, group]) => (
            <div className={`kp-row ${group}`} key={name}>
              <span>{name}</span>
              <span>{size}</span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

/** Space (8 s): the selection steps to order 84204, Space opens Quick Look beside the grid, then it closes. */
export function LookMotion() {
  const rows = ["84210", "84204", "84201", "84198"];
  return (
    <div className="ql" role="img" aria-label="The selection moves to order 84204, Space opens its full row beside the grid, with its customer linked.">
      <div className="ql-grid" aria-hidden="true">
        <i className="ql-sel" />
        {rows.map((id, i) => (
          <div className="ql-row" key={id}>
            <span>{id}</span>
            <span>{["paid", "pending", "paid", "shipped"][i]}</span>
            <span>{["12.00", "129.00", "204.71", "182.28"][i]}</span>
          </div>
        ))}
      </div>
      <kbd className="ql-key" aria-hidden="true">Space</kbd>
      <div className="ql-panel" aria-hidden="true">
        <b>orders · 84204</b>
        {[
          ["status", "pending"],
          ["total", "129.00"],
          ["customer_id", "3222 ↵"],
          ["placed_at", "2026-10-14"],
        ].map(([k, v]) => (
          <div key={k}>
            <span>{k}</span>
            <span>{v}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

const LOG: [what: string, verdict: string, ok: boolean][] = [
  ["query  select * from events where payload::text like …", "Refused · would scan 4.1M rows", false],
  ["search_schema  checkout", "Read · 2 tables", true],
  ["query  select status, count(*) from orders group by status", "Read · 5 rows", true],
  ["query  delete from orders where status = 'cancelled'", "Refused · DELETE isn’t allowed", false],
  ["describe_table  orders", "Read · 6 columns", true],
];

/** The activity log (10 s): a new request arrives on top every 2 s, pushing the rest down. */
export function LogMotion() {
  const list = [...LOG, ...LOG];
  return (
    <div className="lg" role="img" aria-label="The activity log: each request the agent made, newest first, with what came back or why it was refused.">
      <div className="lg-col" aria-hidden="true">
        {list.map(([what, verdict, ok], i) => (
          <div className="lg-row" key={i}>
            <code>{what}</code>
            <span className={ok ? "ok" : "no"}>{verdict}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

/** Choosing tables (9 s): orders, products and order_items get ticked one by one, and the count follows. */
export function TablesMotion() {
  const tables: [string, string, number][] = [
    ["api_keys", "140", 0],
    ["orders", "84k", 1],
    ["customers", "61k", 0],
    ["products", "2.4k", 2],
    ["order_items", "310k", 3],
    ["events", "4.1M", 0],
  ];
  return (
    <div className="tp" role="img" aria-label="Tables in shop: orders, products and order_items get ticked, 3 of 9.">
      <div className="tp-hd" aria-hidden="true">
        <span>Tables in shop</span>
        <span className="tp-n">
          {[0, 1, 2, 3].map((n) => (
            <b key={n} className={`n${n}`}>{`${n} of 9`}</b>
          ))}
        </span>
      </div>
      {tables.map(([name, rows, step]) => (
        <div className="tp-row" key={name} aria-hidden="true">
          <span className="tp-box">{step > 0 && <i className={`s${step}`}><CheckIcon /></i>}</span>
          <span>{name}</span>
          <span>{rows} rows</span>
        </div>
      ))}
    </div>
  );
}

/** Timed sharing (8 s): the choice slides from Until turned off to 1 hour, and the end time shows. */
export function ShareMotion() {
  return (
    <div className="sh" role="img" aria-label="storefront prd is shared with agents. Choosing 1 hour makes the sharing end at 12:31.">
      <div className="sh-hd" aria-hidden="true">
        <i className="dot" /> storefront <span className="env">prd</span>
        <span className="sw" />
      </div>
      <div className="sh-when" aria-hidden="true">
        <span className="a">Shared until you turn it off</span>
        <span className="b">Shared until 12:31</span>
      </div>
      <div className="sh-seg" aria-hidden="true">
        <i />
        <span>Until turned off</span>
        <span>1 hour</span>
        <span>Today</span>
      </div>
    </div>
  );
}

/** The masked host (6 s): what you see, then what your agent sees. */
export function HostMotion() {
  return (
    <div className="hm" role="img" aria-label="You see the host prd-db-01.shop.internal. Your agent sees prd***.shop.internal, read-only.">
      <div className="hm-who" aria-hidden="true">
        <span className="a">You see</span>
        <span className="b">Your agent sees</span>
      </div>
      <div className="hm-host" aria-hidden="true">
        <span className="a">prd-db-01.shop.internal</span>
        <span className="b">
          prd<b>***</b>.shop.internal
        </span>
        <em>Read-only</em>
      </div>
    </div>
  );
}
