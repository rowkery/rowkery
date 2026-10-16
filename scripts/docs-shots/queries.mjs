#!/usr/bin/env node
// Docs screens for the "Working with data" query pages (docs.rowkery.com /query-tabs/,
// /completion/, /query-plans/, /sessions/), from the running app (Vite) with the docs'
// stubbed storefront backend:
//  - query-tabs-overview: a query tab with two statements, the second run, its first
//    1,000 rows paged with Load more and the page-size menu, column profiles in the header;
//  - query-tabs-status: three query tabs (one done, one failed, one running) and the
//    running tab's Cancel turned into Force stop after a cancel the server didn't answer;
//  - query-tabs-error: a failed run: the underlined token, the server's sentence,
//    "Did you mean customer_id?" with Replace and run, and the raw text with its SQLSTATE;
//  - query-tabs-find: ⌘F finding a value in the loaded rows;
//  - completion-join: after JOIN, the tables linked by a foreign key first;
//  - completion-on: after ON, the whole join condition from the foreign key (⌃Space);
//  - completion-enum: inside a string compared with an enum column, its labels;
//  - completion-flow (clip): typing a join with completion from FROM to an enum value;
//  - query-plans-timed: Run with timings: the hint, the slowest step open, row guesses off;
//  - query-plans-estimate: ⌘E's estimate of the same statement;
//  - query-plans-held: a timed plan of a DELETE held by Confirm writes;
//  - sessions-list: the Sessions tab with a blocking chain and your own tab;
//  - sessions-detail: a picked session in the inspector;
//  - sessions-end: End session's Review SQL.
// Not a proof: it checks nothing beyond waiting for each screen.
//
//   cd apps/rowkery-tauri && npx vite --port 1420 &
//   node scripts/docs-shots/queries.mjs [outDir] [--write] [--only=completion,sessions]
import { openApp, shot, record, close, sizes, settle, hideKeyStrip, wanted, WS } from "./lib.mjs";

const MIN = 60_000;
const NOW = Date.parse("2026-10-14T11:45:00Z");

/** Recent queries (config.json), so completion ranks by them and ⌘K lists them. */
const SEED = {
  "rowkery.history.prd": [
    { sql: "SELECT o.id, o.total, c.email FROM orders o JOIN customers c ON c.id = o.customer_id WHERE o.status = 'refunded';", at: NOW - 30 * MIN },
    { sql: "SELECT status, count(*) FROM orders GROUP BY status ORDER BY 2 DESC;", at: NOW - 60 * MIN },
  ],
};

/** Runs in the page: what the screens need on top of the base stub. */
function more(seed) {
  const D = window.__DOCS__;
  // order_items and products, linked by foreign keys, for JOIN completion.
  const col = (name, type_name, extra = {}) => ({ name, type_name, nullable: true, ...extra });
  const fk = (columns, ref_table) => ({ name: `${ref_table}_fk`, columns, ref_schema: "public", ref_table, ref_columns: ["id"], on_delete: "NO ACTION" });
  const pub = D.catalog.databases[0].schemas[0].tables;
  const items = pub.find((t) => t.name === "order_items");
  items.columns = [col("id", "int8", { nullable: false }), col("order_id", "int8", { nullable: false }), col("product_id", "int8", { nullable: false }), col("quantity", "int4"), col("unit_price", "numeric")];
  items.foreign_keys = [fk(["order_id"], "orders"), fk(["product_id"], "products")];
  const products = pub.find((t) => t.name === "products");
  products.columns = [col("id", "int8", { nullable: false }), col("sku", "text"), col("name", "text"), col("price", "numeric")];

  const frameCell = (v) => (v === null ? null : typeof v === "number" ? { Int: v } : { Text: v });
  let qid = 1000;
  /** A paged read the way core sends it: columns, rows, done with `paged` / `more`. */
  const sendPaged = (onFrame, rows, more) => {
    const queryId = ++qid;
    setTimeout(() => {
      const f = (x) => onFrame.onmessage({ query_id: queryId, ...x });
      f({ t: "columns", columns: D.ORDER_COLS.map(([name, type_name]) => ({ name, type_name })) });
      for (let i = 0; i < rows.length; i += 250)
        f({ t: "rows", seq: i / 250, rows: rows.slice(i, i + 250).map((r) => D.ORDER_COLS.map(([n]) => frameCell(r[n]))) });
      f({ t: "done", status: "ok", row_count: rows.length, affected_rows: null, elapsed_ms: 38, first_row_ms: 6, frames: 4, error: null, sqlstate: null, error_position: null, hold: null, paged: true, more });
    }, 5);
    return queryId;
  };

  const pending = {};
  let cancels = 0;
  const step = (o) => ({ depth: 0, kind: "", schema: null, table: null, alias: null, index: null, note: null, expectedRows: null, actualRows: null, loops: null, ownMs: null, ownCost: null, miss: null, details: [], ...o });
  const hint = { text: "Seq scan on orders reads 84,000 rows to keep 61. orders.customer_id has no index.", sql: "CREATE INDEX ON public.orders (customer_id);", step: 2 };
  const timed = {
    timed: true, executionMs: 43.2, planningMs: 0.3, rows: 183, slowest: 2, hint,
    steps: [
      step({ kind: "Sort", note: "by o.placed_at DESC", expectedRows: 9, actualRows: 183, loops: 1, ownMs: 0.3, ownCost: 4, miss: 20.3, details: [{ label: "Sort", value: "quicksort, 37 kB" }] }),
      step({ depth: 1, kind: "Nested Loop", expectedRows: 9, actualRows: 183, loops: 1, ownMs: 0.2, ownCost: 2, miss: 20.3 }),
      step({ depth: 2, kind: "Seq Scan", schema: "public", table: "orders", alias: "o", expectedRows: 4, actualRows: 61, loops: 1, ownMs: 39.6, ownCost: 1890, details: [
        { label: "Filter", value: "o.customer_id = 3412" },
        { label: "Removed", value: "83,939 rows" },
        { label: "Read", value: "1,214 pages, 38% from disk" },
      ] }),
      step({ depth: 2, kind: "Index Scan", schema: "public", table: "order_items", alias: "i", index: "order_items_order_id_idx", expectedRows: 2, actualRows: 3, loops: 61, ownMs: 1.4, ownCost: 16.6, details: [{ label: "Index Cond", value: "i.order_id = o.id" }, { label: "Read", value: "244 pages" }] }),
    ],
  };
  const estimate = {
    ...timed, timed: false, executionMs: null, rows: null,
    hint: { ...hint, text: "Seq scan on orders reads about 84,000 rows to keep about 4. orders.customer_id has no index." },
    steps: timed.steps.map((s) => ({ ...s, actualRows: null, loops: null, ownMs: null, miss: null, details: s.details.filter((d) => d.label !== "Removed" && d.label !== "Read") })),
  };

  const deletePlan = {
    timed: false, executionMs: null, planningMs: null, rows: null, slowest: 1, hint: null,
    steps: [
      step({ kind: "Delete", schema: "public", table: "orders", expectedRows: 0, ownCost: 0 }),
      step({ depth: 1, kind: "Seq Scan", schema: "public", table: "orders", expectedRows: 1840, ownCost: 2310, details: [{ label: "Filter", value: "(orders.placed_at < (now() - '2 years'::interval)) AND (orders.status = 'cancelled'::order_status)" }] }),
    ],
  };

  // Sessions on the storefront database.
  const s = (pid, over) => ({ pid, user: "api", application: "checkout", client: "10.0.4.12", state: "active", wait: null, xact_secs: 1, query_secs: 1, state_secs: 1, query: "SELECT 1", blocked_by: [], can_stop: true, rowkery_tag: null, tab: null, ...over });
  const gone = new Set();
  const sessions = () => [
    s(48213, { user: "deploy", application: "migrate", query_secs: 252, xact_secs: 252, wait: "Lock: relation", blocked_by: [47102], query: "ALTER TABLE orders ADD COLUMN refund_id bigint" }),
    s(47102, { user: "app", application: "Rowkery 0a1b2c3d", rowkery_tag: "0a1b2c3d", client: "10.0.9.40", tab: { window_id: window.__WID__, tab_id: 1 }, state: "idle in transaction", xact_secs: 404, state_secs: 380, query: "UPDATE orders\n   SET status = 'refunded'\n WHERE id = 84190" }),
    s(48230, { query_secs: 38.2, wait: "Lock: relation", blocked_by: [48213], query: "SELECT o.id, o.total FROM orders o WHERE o.customer_id = 3412" }),
    s(48231, { query_secs: 37.9, wait: "Lock: relation", blocked_by: [48213], query: "SELECT o.id, o.total FROM orders o WHERE o.customer_id = 3519" }),
    s(48199, { user: "bi", application: "metabase", client: "10.0.7.3", query_secs: 65, wait: "IO: DataFileRead", query: "SELECT date_trunc('day', placed_at), count(*) FROM orders GROUP BY 1" }),
    s(48250, { user: "maya", application: "psql", client: "10.0.2.18", state: "idle in transaction", xact_secs: 12, query: "SELECT * FROM products WHERE sku = 'MUG-01'" }),
    s(48260, { user: "postgres", application: "", client: null, can_stop: false, query: null, query_secs: 3 }),
    s(48300, { state: "idle", state_secs: 120, query: "COMMIT" }),
    s(48301, { state: "idle", state_secs: 80, query: "COMMIT" }),
  ];

  window.__STUB_MORE__ = async (cmd, a) => {
    switch (cmd) {
      case "load_ui_state":
        return { version: 1, keys: structuredClone(seed) };
      case "open_window":
        window.__WID__ = a.windowId;
        return undefined;
      case "run_query": {
        const sql = a.sql ?? "";
        if (/custmer_id/.test(sql))
          return { columns: [], rows: [], row_count: 0, elapsed_ms: 2, error: 'column "custmer_id" does not exist', sqlstate: "42703", error_position: sql.indexOf("custmer_id") + 1, cancelled: false };
        if (/\bboom\b/.test(sql))
          return { columns: [], rows: [], row_count: 0, elapsed_ms: 3, error: 'column "boom" does not exist', sqlstate: "42703", error_position: sql.indexOf("boom") + 1, cancelled: false };
        if (/pg_sleep/.test(sql)) {
          const started = performance.now();
          await new Promise((resolve) => (pending[a.tabId] = resolve));
          return { columns: [], rows: [], row_count: 0, elapsed_ms: Math.round(performance.now() - started), error: "Query cancelled", cancelled: true };
        }
        if (/count\(\*\)/i.test(sql))
          return D.result([["status", "order_status"], ["count", "int8"]], [
            { status: "shipped", count: 41210 }, { status: "paid", count: 22408 }, { status: "pending", count: 9870 }, { status: "refunded", count: 6120 }, { status: "cancelled", count: 4392 },
          ]);
        if (/\bfrom\s+orders\b/i.test(sql) && !/\blimit\b/i.test(sql) && a.page && a.onFrame)
          return sendPaged(a.onFrame, D.ROWS.slice(0, Math.min(a.page, 1000)), true);
        return undefined;
      }
      case "cancel_query":
        // The first cancel goes unanswered, as on a dead connection; the second stops it.
        cancels++;
        if (cancels % 2 === 0) pending[a.tabId]?.();
        return null;
      case "stop_all_queries":
        for (const k of Object.keys(pending)) pending[k]();
        return null;
      case "explain_statement":
        if (/^delete/i.test(a.sql)) {
          if (a.timed && !a.confirmed)
            return { kind: "held", hold: { action: "confirm", mode: "confirm", statements: [{ kind: "write", verb: "DELETE", target: "orders", destructive: false, unlocks_writes: false }] } };
          return { kind: "plan", plan: deletePlan, elapsed_ms: 2 };
        }
        return { kind: "plan", plan: a.timed ? timed : estimate, elapsed_ms: a.timed ? 44 : 3 };
      case "list_sessions": {
        const rows = sessions().filter((r) => !gone.has(r.pid));
        for (const r of rows) r.blocked_by = r.blocked_by.filter((b) => !gone.has(b));
        return rows;
      }
      case "session_locks":
        return a.pid === 47102 ? [{ table: "public.orders", mode: "RowExclusiveLock" }] : [];
      case "stop_session":
        if (a.kind === "end" && !a.confirmed) return { status: "held", sql: `SELECT pg_terminate_backend(${a.pid})` };
        gone.add(a.pid);
        return { status: "stopped", gone: false };
      default:
        return undefined;
    }
  };
}
const MORE = { content: `(${more.toString()})(${JSON.stringify(SEED)});` };

const EDITOR = `${WS} textarea[data-testid="sql-editor"]`;
/** Puts `text` in the editor as if pasted, caret at `caret` (default: the end). */
async function setSql(page, text, caret = text.length) {
  await page.evaluate(([sel, text]) => {
    const ta = document.querySelector(sel);
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value").set.call(ta, text);
    ta.dispatchEvent(new Event("input", { bubbles: true }));
  }, [EDITOR, text]);
  await page.focus(EDITOR);
  await page.evaluate(([sel, o]) => document.querySelector(sel).setSelectionRange(o, o), [EDITOR, caret]);
}
const box = (page, sel) => page.locator(sel).first().boundingBox();
/** The main column from its tab row down to `bottom` (CSS px). */
async function mainClip(page, bottom) {
  const m = await box(page, `${WS} main`);
  return { x: m.x, y: m.y, width: m.width, height: (bottom ?? m.y + m.height) - m.y };
}
const fresh = (o = {}) => openApp({ table: null, more: MORE, ...o });

// ---------------------------------------------------------------- query tabs
if (wanted("query-tabs")) {
  const { page, context } = await fresh();
  const two = "SELECT status, count(*) FROM orders GROUP BY status;\n\nSELECT id, customer_id, status, total, currency, placed_at\n  FROM orders\n ORDER BY placed_at DESC;";
  await setSql(page, two, two.indexOf("FROM orders\n ORDER"));
  await page.keyboard.press("Meta+Enter");
  await page.waitForSelector(`${WS} [data-load-more]`);
  await settle(page);
  await page.focus(EDITOR);
  await shot(page, "query-tabs-overview");

  // ⌘F in the loaded rows.
  await page.keyboard.press("Meta+f");
  await page.waitForSelector(`${WS} [data-find-input]`);
  await page.keyboard.type("SEK");
  await page.waitForTimeout(200);
  const strip = await hideKeyStrip(page);
  {
    const card = await box(page, `${WS} [data-testid="results-card"]`);
    await shot(page, "query-tabs-find", { clip: { x: card.x, y: card.y, width: card.width, height: 560 } });
  }
  await strip.evaluate((e) => e.remove());
  await page.keyboard.press("Escape");

  // The error view.
  await setSql(page, "SELECT id, custmer_id, total\n  FROM orders\n WHERE status = 'paid';", 3);
  await page.keyboard.press("Meta+Enter");
  await page.waitForSelector(`${WS} [data-query-error="42703"]`);
  await page.waitForTimeout(150);
  {
    const err = await box(page, `${WS} .qe-actions`);
    await shot(page, "query-tabs-error", { clip: await mainClip(page, err.y + err.height + 20) });
  }

  // Three tabs: done, failed, running.
  await setSql(page, "SELECT status, count(*) FROM orders GROUP BY status;", 5);
  await page.keyboard.press("Meta+Enter");
  await settle(page);
  await page.click(`${WS} .query-tab-add`);
  await setSql(page, "SELECT boom FROM orders;", 3);
  await page.keyboard.press("Meta+Enter");
  await page.waitForSelector(`${WS} [data-query-error]`);
  await page.click(`${WS} .query-tab-add`);
  await setSql(page, "SELECT pg_sleep(30), count(*) FROM order_items;", 3);
  await page.keyboard.press("Meta+Enter");
  await page.waitForSelector(`${WS} [data-cancel="cancel"]`);
  await page.clock.setFixedTime(new Date(NOW + 4_200));
  await page.waitForTimeout(300);
  await page.keyboard.press("Escape");
  await page.waitForSelector(`${WS} [data-cancel="force"]`);
  await page.clock.setFixedTime(new Date(NOW + 7_600));
  await page.waitForTimeout(300);
  {
    const head = await box(page, `${WS} [data-testid="results-card"]`);
    await shot(page, "query-tabs-status", { clip: await mainClip(page, head.y + 120) });
  }
  await page.keyboard.press("Escape");
  await context.close();
}

// ---------------------------------------------------------------- completion
/** The editor card and the list under it. */
async function popupClip(page) {
  const ed = await box(page, `${WS} .editor-card`);
  const pop = await box(page, '[data-testid="ac-popup"]');
  const bottom = (pop ? pop.y + pop.height : ed.y + ed.height) + 14;
  const right = Math.max(ed.x + ed.width * 0.62, pop ? pop.x + pop.width + 16 : 0);
  return { x: ed.x, y: ed.y, width: Math.min(right, ed.x + ed.width) - ed.x, height: bottom - ed.y };
}
if (wanted("completion")) {
  const { page, context } = await fresh();
  await hideKeyStrip(page);
  await setSql(page, "SELECT o.id, o.total, c.email\n  FROM orders o\n  JOIN ");
  await page.keyboard.type("c", { delay: 40 });
  await page.waitForSelector('[data-testid="ac-popup"]');
  await shot(page, "completion-join", { clip: await popupClip(page), mouse: false });
  await page.keyboard.press("Enter");
  await page.keyboard.type(" c ON ", { delay: 40 });
  await page.keyboard.press("Control+Space");
  await page.waitForSelector('[data-testid="ac-popup"]');
  await shot(page, "completion-on", { clip: await popupClip(page), mouse: false });
  await page.keyboard.press("Tab");
  await page.keyboard.type("\n WHERE o.status = '", { delay: 40 });
  await page.waitForSelector('[data-testid="ac-popup"]');
  await shot(page, "completion-enum", { clip: await popupClip(page), mouse: false });
  await page.keyboard.press("Escape");
  await context.close();

  if (wanted("completion-flow")) {
    const { page: p, context: c2 } = await fresh({ w: 960, h: 560 });
    await hideKeyStrip(p);
    await setSql(p, "");
    await record(p, "completion-flow", async (pg) => {
      const type = (t) => pg.keyboard.type(t, { delay: 70 });
      await type("SELECT o.id, o.total, c.email\n  FROM ord");
      await pg.waitForTimeout(700);
      await pg.keyboard.press("Enter");
      await type(" o\n  JOIN c");
      await pg.waitForTimeout(1000);
      await pg.keyboard.press("Enter");
      await type(" c ON ");
      await pg.waitForTimeout(300);
      await pg.keyboard.press("Control+Space");
      await pg.waitForTimeout(1100);
      await pg.keyboard.press("Tab");
      await type("\n WHERE o.status = '");
      await pg.waitForTimeout(800);
      await pg.keyboard.press("ArrowDown");
      await pg.waitForTimeout(400);
      await pg.keyboard.press("Enter");
      await pg.waitForTimeout(400);
    });
    await c2.close();
  }
}

// ---------------------------------------------------------------- query plans
if (wanted("query-plans")) {
  const { page, context } = await fresh();
  const q = "SELECT o.id, o.placed_at, i.product_id, i.quantity\n  FROM orders o\n  JOIN order_items i ON i.order_id = o.id\n WHERE o.customer_id = 3412\n ORDER BY o.placed_at DESC;";
  await setSql(page, q, 3);
  await page.keyboard.press("Meta+e");
  await page.waitForSelector(`${WS} [data-plan]:not([data-timed])`);
  await page.waitForTimeout(200);
  const planClip = async () => {
    const card = await box(page, `${WS} [data-testid="results-card"]`);
    const steps = await page.locator(`${WS} [data-plan-step]`).last().boundingBox();
    return { x: card.x, y: card.y, width: card.width, height: steps.y + steps.height + 14 - card.y };
  };
  await shot(page, "query-plans-estimate", { clip: await planClip() });
  await page.click(`${WS} [data-plan-timed]`);
  await page.waitForSelector(`${WS} [data-plan][data-timed]`);
  await page.waitForTimeout(200);
  await shot(page, "query-plans-timed", { clip: await planClip() });

  await setSql(page, "DELETE FROM orders\n WHERE status = 'cancelled'\n   AND placed_at < now() - interval '2 years';", 3);
  await page.keyboard.press("Meta+e");
  await page.waitForSelector(`${WS} [data-plan]:not([data-timed])`);
  await page.click(`${WS} [data-plan-timed]`);
  await page.waitForSelector(`${WS} [data-testid="safe-bar"]`);
  await page.waitForTimeout(200);
  {
    const bar = await box(page, `${WS} [data-testid="safe-bar"]`);
    await shot(page, "query-plans-held", { clip: await mainClip(page, bar.y + bar.height + 2) });
  }
  await context.close();
}

// ---------------------------------------------------------------- sessions
if (wanted("sessions")) {
  const { page, context } = await fresh({ w: 1360, h: 560 });
  await page.keyboard.press("Meta+k");
  await page.waitForSelector('[data-testid="cp-panel"]');
  await page.keyboard.type("sessions");
  await page.waitForSelector('[data-item="cmd:show-sessions"]');
  await page.keyboard.press("Enter");
  await page.waitForSelector(`${WS} [data-session-row="47102"]`);
  await page.mouse.move(700, 30);
  await page.waitForTimeout(300);
  await shot(page, "sessions-list");
  await page.click(`${WS} [data-session-row="47102"]`);
  await page.waitForSelector(`${WS} [data-session-detail="47102"]`);
  await page.mouse.move(700, 30);
  await page.waitForTimeout(300);
  await shot(page, "sessions-detail");
  await page.click(`${WS} [data-session-stop="end"]`);
  await page.waitForSelector(`${WS} [data-session-confirm="end"]`);
  {
    const insp = await box(page, `${WS} aside.inspector`);
    await shot(page, "sessions-end", { clip: { x: insp.x, y: insp.y, width: insp.width, height: insp.height } });
  }
  await context.close();
}

await close();
sizes();
