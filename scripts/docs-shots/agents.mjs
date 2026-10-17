#!/usr/bin/env node
// Docs screens for the Agents group (docs.rowkery.com): Choosing what to share, Proposed changes,
// and Sensitive columns and Presenting. From the running app (Vite) with the stubbed Tauri
// `invoke` of ./lib.mjs, extended here with an agent's activity log, the Edit access picker,
// a proposed change with its plan and dry run, and saves that stick:
//  - choosing-what-to-share-page: the Agents page, connection cards beside the activity log;
//  - choosing-what-to-share-call: a picked call opened (Access, Request, Response);
//  - choosing-what-to-share-edit-access: Edit access, databases then tables;
//  - choosing-what-to-share-can-do: the What can the agent do sheet;
//  - choosing-what-to-share-mcp-menu: the title bar's MCP button and menu, the pill's MCP tag;
//  - choosing-what-to-share-refusal-toast: the toast for a refusal that arrives while you work;
//  - proposed-changes-arrival: the arrival toast and the count on the Agents button;
//  - proposed-changes-review: the review before the dry run (SQL, reason, triggers);
//  - proposed-changes-dry-run: after the dry run (old values over new, counts);
//  - proposed-changes-list: three waiting, the list of cards beside the oldest;
//  - proposed-changes-review.mp4 (clip): a proposal arrives, Review, Dry run, Commit;
//  - sensitive-columns-and-presenting-header-menu: a header's Mark as sensitive;
//  - sensitive-columns-and-presenting-columns: Edit access's column list with a masked column;
//  - sensitive-columns-and-presenting-on: Presenting on, the marked column as dots.
// Not a proof: it checks nothing beyond waiting for each screen.
//
//   cd apps/rowkery-tauri && npx vite --port 1420 &
//   node scripts/docs-shots/agents.mjs [outDir] [--write] [--only=name,…]
import { openApp, shot, record, close, sizes, hideKeyStrip as hideHints, wanted, WS } from "./lib.mjs";

/** lib's hideKeyStrip, plus the key strips as the app marks them now (`data-key-strip`). */
async function hideKeyStrip(page) {
  await hideHints(page);
  await page.addStyleTag({ content: "[data-key-strip], [data-key-strip-glyph] { visibility: hidden !important; }" });
}

/** The stub additions every scene here uses (runs in the page, after the base stub). */
function agentsMore() {
  const D = window.__DOCS__;
  const T = (h, m, s = 0) => Date.UTC(2026, 9, 14, h, m, s);
  const [prd, stg] = D.connections;
  // prd shared for an hour from 11:30; stg not shared; a local SQLite file, not shared.
  prd.mcp_until = T(12, 30);
  stg.allow_mcp = false;
  stg.mcp_access = null;
  D.connections.push({ kind: "sqlite", id: "arcade", name: "arcade", path: "~/data/arcade.sqlite", environment: "local", safe_mode: "off", allow_mcp: false });

  const session = T(11, 30);
  const base = { session, client: "claude-code", connection: "prd", database: "shop" };
  const scope = { databases: 1, mode: "picked", tables: 3, timeout_s: 10 };
  const revenue = "select status, count(*) as orders, sum(total) as revenue\nfrom orders\nwhere placed_at > now() - interval '7 days'\ngroup by status\norder by orders desc";
  const items = "select product_id, sum(quantity) as sold from order_items group by product_id order by sold desc limit 10";
  const events = "select kind, count(*) from audit.changes where at > now() - interval '1 day' group by kind";
  const log = [
    { session, client: "claude-code", ts: T(11, 31, 2), tool: "list_connections", rows: 1, verdict: "ok", args: {}, bytes: 168 },
    { ...base, ts: T(11, 31, 6), tool: "list_tables", verdict: "ok", args: { connection: "storefront" }, scope, bytes: 214 },
    { ...base, ts: T(11, 31, 11), tool: "describe_table", target: "orders", verdict: "ok", args: { connection: "storefront", table: "orders" }, scope, bytes: 1288 },
    { ...base, ts: T(11, 32, 40), tool: "query", sql: revenue, rows: 5, ms: 41, verdict: "ok", args: { connection: "storefront", sql: revenue }, scope: { ...scope, max_rows: 200 }, bytes: 265 },
    { ...base, ts: T(11, 33, 15), tool: "explain", sql: items, verdict: "would refuse", args: { connection: "storefront", sql: items }, scope, bytes: 702 },
    {
      ...base,
      ts: T(11, 34, 2),
      tool: "query",
      sql: events,
      verdict: "Refused: this reads a table the user hasn't shared with agents in Rowkery. A view or join needs every table it reads shared. Leave it out of the query, or ask the user to share it.",
      args: { connection: "storefront", sql: events },
      scope: { ...scope, max_rows: 200 },
    },
    {
      ...base,
      ts: T(11, 44, 30),
      tool: "query",
      sql: items,
      verdict: "Refused: the plan reads public.order_items (~310000 rows; indexed: (id)) end to end. Filter on an indexed column, or aggregate a narrower range.",
      args: { connection: "storefront", sql: items },
      scope: { ...scope, max_rows: 200 },
    },
  ];
  window.__MCP_NEXT__ = [];
  window.__QUEUE__ = [];
  let offset = 0;
  const pickCols = (t) => t.columns.map((c) => ({ name: c.name, type: c.type_name }));
  const pickTables = () =>
    D.catalog.databases[0].schemas.flatMap((s) =>
      s.tables.map((t) => {
        const rows = t.row_estimate.Approximate;
        return { schema: s.name, name: t.name, kind: t.kind, rows, big: rows > 100_000, columns: pickCols(t) };
      }),
    );
  window.__STUB_MORE__ = async (cmd, a) => {
    switch (cmd) {
      case "mcp_activity": {
        if (window.__NO_LOG__) return { entries: [], offset: 0, reset: true };
        if (a.since == null || a.since > offset) {
          offset = log.length;
          return { entries: structuredClone(log), offset, reset: true };
        }
        const next = window.__MCP_NEXT__.splice(0);
        log.push(...next);
        offset = log.length;
        return { entries: next, offset, reset: false };
      }
      case "mcp_sample": {
        const e = log.find((x) => x.ts === a.ts);
        if (e?.sql !== revenue) return null;
        const text = '{"columns":["status","orders","revenue"],"rows":[["paid",1240,"86412.50"],["shipped",988,"70218.10"],["pending",212,"14930.00"],["refunded",31,"2210.40"],["cancelled",9,"612.00"]],"row_count":5,"more":false,"elapsed_ms":41,"types":["order_status","int8","numeric"]}';
        return { session: e.session, ts: e.ts, text, bytes: text.length };
      }
      case "save_connection": {
        const i = D.connections.findIndex((c) => c.id === a.connection.id);
        if (i >= 0) D.connections[i] = a.connection;
        return null;
      }
      case "mcp_pick_databases":
        return [
          { name: "postgres", size_bytes: 8 * 1024 ** 2 },
          { name: "shop", size_bytes: 1.2 * 1024 ** 3 },
          { name: "shop_archive", size_bytes: 4.8 * 1024 ** 3 },
        ];
      case "mcp_pick_tables":
        return a.database === "shop" ? pickTables() : [];
      case "mcp_pick_close":
        return null;
      case "proposals_waiting":
        return structuredClone(window.__QUEUE__);
      case "proposal_plan":
        return structuredClone(window.__PLANS__[a.id] ?? window.__PLAN__);
      case "proposal_dry_run":
        await new Promise((r) => setTimeout(r, 450));
        return structuredClone(window.__DRY__);
      case "proposal_commit":
        window.__QUEUE__ = window.__QUEUE__.filter((p) => p.id !== a.id);
        return { outcome: "committed", rows: a.rows };
      case "proposal_reject":
        window.__QUEUE__ = window.__QUEUE__.filter((p) => p.id !== a.id);
        return null;
      default:
        return undefined;
    }
  };

  // A proposed change: two double-charged orders marked refunded.
  const sql = "UPDATE orders SET status = 'refunded' WHERE id IN (84207, 84204)";
  window.__PROPOSAL__ = {
    id: "p_3f9a1c07b2e4",
    ts: T(11, 44, 52),
    connection: "prd",
    database: "shop",
    sql,
    reason: "Orders 84207 and 84204 were charged twice (Stripe charges ch_8812 and ch_8820 were refunded this morning), but both still say paid.",
    expect_rows: 2,
    client: "claude-code",
  };
  window.__PLAN__ = {
    connection_name: "storefront",
    statements: [{ verb: "UPDATE", target: "orders", sql, destructive: false, triggers: [{ name: "orders_audit", event: "UPDATE" }] }],
  };
  // Two more, older, for the list: one waiting at a time never shows it.
  const lower = "UPDATE customers SET email = lower(email) WHERE email <> lower(email)";
  const carts = "DELETE FROM carts WHERE updated_at < now() - interval '90 days'";
  window.__OLDER__ = [
    { id: "p_8b21d4e09a77", ts: T(11, 30, 4), connection: "prd", database: "shop", sql: lower, reason: "Twelve customers signed up with upper-case emails, so logging in by email misses them.", expect_rows: 12, client: "cursor" },
    { id: "p_c04e6f1d3358", ts: T(11, 38, 40), connection: "prd", database: "shop", sql: carts, reason: "Carts nobody touched in 90 days are still kept and slow the abandoned-cart job.", client: "claude-ai" },
  ];
  window.__PLANS__ = {
    p_8b21d4e09a77: { connection_name: "storefront", statements: [{ verb: "UPDATE", target: "customers", sql: lower, destructive: false, triggers: [] }] },
    p_c04e6f1d3358: { connection_name: "storefront", statements: [{ verb: "DELETE", target: "carts", sql: carts, destructive: false, triggers: [] }] },
  };
  const cols = D.ORDER_COLS.map(([n]) => n);
  const row = (id) => {
    const r = D.ROWS.find((x) => x.id === id);
    return cols.map((c) => (c === "id" || c === "customer_id" ? r[c] : r[c]));
  };
  const after = (id) => row(id).map((v, i) => (cols[i] === "status" ? "refunded" : v));
  window.__DRY__ = {
    proposal: window.__PROPOSAL__,
    connection_name: "storefront",
    statements: [
      {
        verb: "UPDATE",
        target: "orders",
        sql,
        destructive: false,
        rows: 2,
        columns: cols,
        key: ["id"],
        changed: ["status"],
        shown: [84207, 84204].map((id) => ({ before: row(id), after: after(id) })),
        triggers: ["orders_audit"],
      },
    ],
  };
}


const tick = (page) => page.evaluate(() => document.dispatchEvent(new Event("visibilitychange")));
const agents = '[data-testid="agents-page"]';

// 1. Choosing what to share.
if (wanted("choosing-what-to-share")) {
  const { context, page } = await openApp({ more: agentsMore });
  await hideKeyStrip(page);

  // The title bar: the pill's MCP tag (a read 30 s ago) and the MCP menu.
  await page.waitForSelector('[data-testid="win-mcp"]');
  await page.click("button[data-mcp]");
  await page.waitForSelector('[data-menu="mcp"]');
  await shot(page, "choosing-what-to-share-mcp-menu", { clip: { x: 0, y: 0, width: 1280, height: 190 } });
  await page.keyboard.press("Escape");

  // A refusal arriving while you work: the toast with View.
  await page.evaluate(() => {
    const T = (h, m, s = 0) => Date.UTC(2026, 9, 14, h, m, s);
    window.__MCP_NEXT__.push({
      session: T(11, 30),
      client: "claude-code",
      connection: "prd",
      database: "shop",
      ts: T(11, 44, 58),
      tool: "query",
      sql: "select * from order_items where quantity > 20",
      verdict: "Refused: the plan reads public.order_items (~310000 rows; indexed: (id)) end to end. Filter on an indexed column, or aggregate a narrower range.",
    });
  });
  await tick(page);
  await page.waitForSelector("[data-toast-offer]");
  await shot(page, "choosing-what-to-share-refusal-toast", { el: "[data-toast]", pad: 8 });
  await page.click("[data-toast-offer]");

  // The Agents page, with the newest call picked.
  await page.waitForSelector(`${agents} [data-mcp-entry="0"]`);
  await page.waitForTimeout(400);
  await shot(page, "choosing-what-to-share-page");

  // A call opened: what was shared then, the request, the response kept.
  await page.click('[data-mcp-entry="4"]');
  await page.waitForSelector('[data-mcp-entry="4"] [data-mcp-box="response"] pre');
  await page.locator('[data-mcp-entry="4"]').scrollIntoViewIfNeeded();
  await shot(page, "choosing-what-to-share-call", { el: '[data-mcp-entry="4"]', pad: 8 });

  // What can the agent do.
  await page.click("[data-ag-can-do]");
  await page.waitForSelector('[data-testid="ag-can-do"] [role="dialog"]');
  await shot(page, "choosing-what-to-share-can-do", { el: '[data-testid="ag-can-do"] [role="dialog"]', pad: 0 });
  await page.keyboard.press("Escape");

  // Edit access: a click on the shared card.
  await page.click('[data-mcp-edit="prd"]');
  await page.waitForSelector('[data-mcp-editor="prd"] [data-ag-table="public.orders"]');
  await page.waitForTimeout(300);
  await shot(page, "choosing-what-to-share-edit-access", { clip: { x: 0, y: 0, width: 1280, height: 600 } });
  await context.close();
}

// 2. Proposed changes.
if (wanted("proposed-changes")) {
  // The arrival, then the review before and after the dry run.
  {
    const { context, page } = await openApp({ w: 1100, h: 620, more: agentsMore, init: () => (window.__NO_LOG__ = true) });
    await hideKeyStrip(page);
    await page.waitForTimeout(400);
    await page.evaluate(() => window.__QUEUE__.push(window.__PROPOSAL__));
    await tick(page);
    await page.waitForSelector('[data-testid="sb-proposals"]');
    await page.waitForSelector("[data-toast-offer]");
    await shot(page, "proposed-changes-arrival", { clip: { x: 0, y: 520, width: 1100, height: 100 } });
    await page.click("[data-toast-offer]");
    await page.waitForSelector('[data-testid="proposal-page"] [data-testid="pp-triggers"]');
    await shot(page, "proposed-changes-review");
    await page.click('[data-testid="pp-dry-run"]');
    await page.waitForSelector('[data-testid="pp-dry"][data-state="done"]');
    await shot(page, "proposed-changes-dry-run");
    await context.close();
  }
  // Three waiting: the list of cards, the oldest shown.
  {
    const { context, page } = await openApp({ w: 1100, h: 620, more: agentsMore, init: () => (window.__NO_LOG__ = true) });
    await hideKeyStrip(page);
    await page.waitForTimeout(400);
    await page.evaluate(() => window.__QUEUE__.push(...window.__OLDER__, window.__PROPOSAL__));
    await tick(page);
    await page.waitForSelector("[data-toast-offer]");
    await page.click("[data-toast-offer]");
    await page.waitForSelector('[data-testid="pp-list"] [data-proposal-id="p_3f9a1c07b2e4"]');
    await page.waitForSelector('[data-testid="proposal-page"] [data-testid="pp-sql"]');
    await shot(page, "proposed-changes-list");
    await context.close();
  }
  // The clip: arrival, Review, Dry run, Commit.
  {
    const { context, page } = await openApp({ w: 1180, h: 700, more: agentsMore, init: () => (window.__NO_LOG__ = true) });
    await hideKeyStrip(page);
    await page.waitForTimeout(400);
    await record(page, "proposed-changes-review", async (p) => {
      await p.waitForTimeout(600);
      await p.evaluate(() => window.__QUEUE__.push(window.__PROPOSAL__));
      await tick(p);
      await p.waitForSelector("[data-toast-offer]");
      await p.waitForTimeout(1400);
      const offer = await p.locator("[data-toast-offer]").boundingBox();
      await p.mouse.move(offer.x + offer.width / 2, offer.y + offer.height / 2, { steps: 12 });
      await p.waitForTimeout(250);
      await p.mouse.click(offer.x + offer.width / 2, offer.y + offer.height / 2);
      await p.waitForSelector('[data-testid="proposal-page"] [data-testid="pp-triggers"]');
      await p.waitForTimeout(1800);
      const dry = await p.locator('[data-testid="pp-dry-run"]').boundingBox();
      await p.mouse.move(dry.x + dry.width / 2, dry.y + dry.height / 2, { steps: 14 });
      await p.waitForTimeout(250);
      await p.mouse.click(dry.x + dry.width / 2, dry.y + dry.height / 2);
      await p.waitForSelector('[data-testid="pp-dry"][data-state="done"]');
      await p.waitForTimeout(2200);
      const commit = await p.locator('[data-testid="pp-commit"]').boundingBox();
      await p.mouse.move(commit.x + commit.width / 2, commit.y + commit.height / 2, { steps: 14 });
      await p.waitForTimeout(400);
      await p.mouse.click(commit.x + commit.width / 2, commit.y + commit.height / 2);
      await p.waitForSelector('[data-testid="proposal-page"]', { state: "detached" });
      await p.waitForTimeout(1200);
    });
    await context.close();
  }
}

// 3. Sensitive columns and Presenting.
if (wanted("sensitive-columns-and-presenting")) {
  // The header menu on a table tab, then Presenting with the column marked.
  {
    const { context, page } = await openApp({ table: "customers", more: agentsMore, init: () => (window.__NO_LOG__ = true) });
    await hideKeyStrip(page);
    await page.click(`${WS} [data-header="email"]`, { button: "right" });
    await page.waitForSelector('[data-item="mark"]');
    await page.hover('[data-item="mark"]');
    const menu = await page.locator("[data-menu]").first().boundingBox();
    const head = await page.locator(`${WS} [data-header="email"]`).boundingBox();
    const x = Math.max(0, Math.min(head.x, menu.x) - 16);
    const y = head.y - 16;
    await shot(page, "sensitive-columns-and-presenting-header-menu", {
      mouse: false,
      clip: { x, y, width: Math.ceil(Math.max(head.x + head.width, menu.x + menu.width) - x + 16), height: Math.ceil(menu.y + menu.height - y + 16) },
    });
    await page.click('[data-item="mark"]');
    await page.waitForSelector(`${WS} [data-header="email"] [data-marked]`);
    await page.click('[data-testid="sb-presenting"]');
    await page.waitForSelector('[data-testid="sb-presenting"][data-on]');
    // Let the "Marked as sensitive" toast go before the screen.
    await page.waitForFunction(() => !document.querySelector("[data-toast]"), null, { timeout: 15000 });
    await shot(page, "sensitive-columns-and-presenting-on");
    await context.close();
  }
  // Edit access's columns for customers, email masked by a click.
  {
    const { context, page } = await openApp({ more: agentsMore, init: () => (window.__NO_LOG__ = true) });
    await hideKeyStrip(page);
    await page.keyboard.press("Meta+Shift+A");
    await page.waitForSelector(agents);
    await page.click('[data-mcp-edit="prd"]');
    await page.waitForSelector('[data-mcp-editor="prd"] [data-ag-columns="public.customers"]');
    await page.click('[data-ag-columns="public.customers"]');
    await page.waitForSelector('[data-testid="ag-columns"] [data-ag-col="email"]');
    await page.click('[data-ag-col="email"]');
    await page.waitForSelector('[data-ag-col="email"][data-masked]');
    await page.waitForTimeout(300);
    const ed = await page.locator('[data-testid="mcp-editor"]').boundingBox();
    await shot(page, "sensitive-columns-and-presenting-columns", { clip: { x: ed.x, y: ed.y, width: Math.ceil(ed.width), height: 500 } });
    await context.close();
  }
}

await close();
sizes();
