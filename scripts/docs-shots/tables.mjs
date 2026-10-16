#!/usr/bin/env node
// Docs screens for the "Working with data" pages about tables, from the running app (Vite, a
// stubbed Tauri `invoke` with the demo storefront database of lib.mjs), drawn as a Mac draws it:
//  - table-tabs-and-filters-*: the orders table tab (QUERY and WHERE lines, chips, sort), the
//    chip editor with its operator picker, the cell menu's filter rows, Structure, and the clip
//    table-tabs-and-filters-filter.mp4 (⌘F, a filter typed, then a second one from a cell);
//  - quick-look-*: Quick Look on an order (customer followed to a label, Incoming order_items)
//    and on a customer;
//  - editing-rows-*: the enum editor, staged edits with the edits bar, Review SQL in the
//    inspector, Confirm writes holding a commit, and the clip editing-rows-commit.mp4;
//  - exporting-and-copying-*: a selected block with its sum, the results … menu, an export
//    in progress.
// The stub (`more`) builds each browse's SQL the way core does (columns, WHERE (…), ORDER BY
// the sort then the key, LIMIT), answers it from the demo rows, builds the statements Review
// SQL shows, holds a commit under Confirm writes and applies a confirmed one to the rows.
// Writes PNGs to outDir; with --write, WebP into apps/docs/public/img and clips into
// apps/docs/public/clips. Not a proof: it checks nothing beyond waiting for each screen.
//
//   cd apps/rowkery-tauri && npx vite --port 1420 &
//   node scripts/docs-shots/tables.mjs [outDir] [--write] [--only=quick-look,editing]
import { openApp, shot, record, close, sizes, settle, WS } from "./lib.mjs";

// lib's hideKeyStrip names test ids the key strip doesn't carry; it is `data-key-strip`.
const hideKeyStrip = (page) => page.addStyleTag({ content: "[data-key-strip], [data-key-strip-glyph] { visibility: hidden !important; }" });

/** Runs in the page: answers browses, counts, Quick Look lookups, edits and exports. */
function more() {
  const D = window.__DOCS__;
  // order_items points at orders, so Quick Look has Incoming rows.
  const col = (name, type_name, nullable = true) => ({ name, type_name, nullable });
  const ITEM_COLS = [
    ["id", "int8"],
    ["order_id", "int8"],
    ["product", "text"],
    ["quantity", "int4"],
    ["unit_price", "numeric"],
  ];
  const schema = D.catalog.databases[0].schemas[0];
  const items = schema.tables.find((t) => t.name === "order_items");
  items.columns = ITEM_COLS.map(([n, t]) => col(n, t, n !== "id"));
  items.foreign_keys = [
    { name: "order_items_order_id_fkey", columns: ["order_id"], ref_schema: "public", ref_table: "orders", ref_columns: ["id"], on_delete: "CASCADE" },
  ];
  const orders = schema.tables.find((t) => t.name === "orders");
  orders.columns.find((c) => c.name === "placed_at").default = "now()";
  orders.columns.find((c) => c.name === "status").default = "'pending'::order_status";
  orders.columns.find((c) => c.name === "id").default = "nextval('orders_id_seq'::regclass)";
  orders.columns.find((c) => c.name === "status").nullable = false;
  // Sizes and index stats, as Postgres reports them, for Structure.
  orders.table_bytes = 14_200_000;
  orders.index_bytes = 5_100_000;
  orders.comment = "One row per checkout.";
  orders.indexes[0] = { ...orders.indexes[0], method: "btree", size_bytes: 1_900_000, scans: 482_113 };
  orders.indexes[1] = { ...orders.indexes[1], method: "btree", size_bytes: 3_200_000, scans: 9_874 };
  const PRODUCTS = ["Desk lamp", "Notebook", "Fountain pen", "Ink, blue", "Paper tray", "Stapler"];
  const ITEMS = [];
  for (const o of D.ROWS.slice(0, 300)) {
    const n = 1 + (o.id % 4);
    for (let i = 0; i < n; i++)
      ITEMS.push({ id: 500000 + ITEMS.length, order_id: o.id, product: PRODUCTS[(o.id + i) % 6], quantity: 1 + ((o.id + i) % 3), unit_price: `${(9 + ((o.id * (i + 3)) % 60)).toFixed(2)}` });
  }
  const TABLES = {
    orders: { cols: D.ORDER_COLS, rows: D.ROWS },
    customers: { cols: D.CUSTOMER_COLS, rows: D.CUSTOMERS },
    order_items: { cols: ITEM_COLS, rows: ITEMS },
  };
  const KEY = ["id"];
  const ident = (c) => (/^[a-z_][a-z0-9_]*$/.test(c) ? c : `"${c.replace(/"/g, '""')}"`);

  // core's table_browse_query, first page: SELECT … FROM … WHERE (…) ORDER BY … LIMIT n;
  const browseSql = (a) => {
    const list = a.columns?.length ? a.columns.map(ident).join(", ") : "*";
    let sql = `SELECT ${list} FROM ${a.schema}.${a.table}`;
    const filter = (a.filter ?? "").trim().replace(/[;\s]+$/, "");
    if (filter) sql += `\nWHERE (${filter})`;
    const order = [...(a.order ?? [])];
    for (const k of a.key ?? []) if (!order.some((o) => o.column === k)) order.push({ column: k, desc: false });
    if (order.length)
      sql += `\nORDER BY ${order
        .map((o) => `${ident(o.column)}${o.desc ? " DESC" : ""}${a.key?.length && !a.key.includes(o.column) ? " NULLS LAST" : ""}`)
        .join(", ")}`;
    if (a.limit) sql += `\nLIMIT ${a.limit}${a.offset && !a.key?.length ? ` OFFSET ${a.offset}` : ""}`;
    return `${sql};`;
  };

  // A filter as the chips write it: terms joined by AND, each `col op literal` (or an OR group).
  const unq = (s) => s.trim().replace(/^"(.*)"$/, "$1");
  const lit = (s) => {
    s = s.trim();
    if (/^'.*'$/s.test(s)) return s.slice(1, -1).replace(/''/g, "'");
    if (/^null$/i.test(s)) return null;
    return s;
  };
  const num = (v) => (v !== null && v !== "" && !isNaN(Number(v)) ? Number(v) : null);
  const cmp = (a, b) => {
    const x = num(a);
    const y = num(b);
    return x !== null && y !== null ? x - y : String(a).localeCompare(String(b));
  };
  const splitTop = (s, word) => {
    const out = [];
    let depth = 0;
    let q = false;
    let cur = "";
    const re = new RegExp(`^\\s+${word}\\s+`, "i");
    for (let i = 0; i < s.length; i++) {
      const ch = s[i];
      if (ch === "'") q = !q;
      if (!q && ch === "(") depth++;
      if (!q && ch === ")") depth--;
      if (!q && depth === 0) {
        const m = re.exec(s.slice(i));
        if (m) {
          out.push(cur);
          cur = "";
          i += m[0].length - 1;
          continue;
        }
      }
      cur += ch;
    }
    out.push(cur);
    return out.map((x) => x.trim()).filter(Boolean);
  };
  const term = (t) => {
    t = t.trim();
    if (/^\(.*\)$/s.test(t)) {
      const inner = t.slice(1, -1);
      const ors = splitTop(inner, "OR");
      if (ors.length > 1) return (r) => ors.some((o) => term(o)(r));
      return term(inner);
    }
    let m = /^("[^"]+"|\w+)\s+IS\s+(NOT\s+)?NULL$/i.exec(t);
    if (m) return (r) => (r[unq(m[1])] == null) !== !!m[2];
    m = /^("[^"]+"|\w+)\s+IS\s+DISTINCT\s+FROM\s+(.+)$/i.exec(t);
    if (m) return (r) => String(r[unq(m[1])]) !== String(lit(m[2]));
    m = /^("[^"]+"|\w+)\s+I?LIKE\s+'%(.*)%'(\s+ESCAPE.*)?$/i.exec(t);
    if (m) return (r) => r[unq(m[1])] != null && String(r[unq(m[1])]).toLowerCase().includes(m[2].replace(/\\(.)/g, "$1").toLowerCase());
    m = /^("[^"]+"|\w+)\s+IN\s+\((.*)\)$/i.exec(t);
    if (m) {
      const set = m[2].split(",").map(lit).map(String);
      return (r) => set.includes(String(r[unq(m[1])]));
    }
    m = /^("[^"]+"|\w+)\s*(=|<>|>=|<=|>|<)\s*(.+)$/.exec(t);
    if (m) {
      const v = lit(m[3]);
      return (r) => {
        const c = r[unq(m[1])];
        if (c == null) return false;
        const d = cmp(c, v);
        return { "=": d === 0, "<>": d !== 0, ">": d > 0, "<": d < 0, ">=": d >= 0, "<=": d <= 0 }[m[2]];
      };
    }
    return () => true;
  };
  const matches = (filter) => {
    const f = (filter ?? "").trim();
    if (!f) return () => true;
    const terms = splitTop(f, "AND").map(term);
    return (r) => terms.every((fn) => fn(r));
  };
  const pick = (a) => {
    const t = TABLES[a.table];
    let rows = t.rows.filter(matches(a.filter));
    const order = [...(a.order ?? [])];
    for (const k of a.key ?? KEY) if (!order.some((o) => o.column === k)) order.push({ column: k, desc: false });
    rows = rows.slice().sort((x, y) => {
      for (const o of order) {
        const d = cmp(x[o.column], y[o.column]);
        if (d) return o.desc ? -d : d;
      }
      return 0;
    });
    const from = a.offset ?? 0;
    rows = a.limit ? rows.slice(from, from + a.limit) : rows.slice(from);
    const cols = a.columns?.length ? t.cols.filter(([n]) => a.columns.includes(n)) : t.cols;
    return { cols, rows };
  };

  const browses = new Map();
  const sqlLit = (v, type) => {
    if (v == null || "Null" in v) return "NULL";
    if ("Int" in v) return String(v.Int);
    if ("BigInt" in v) return v.BigInt;
    if ("Bool" in v) return v.Bool ? "TRUE" : "FALSE";
    const s = String(v.Text);
    if (/^(int|numeric|float|real|double)/.test(type) && /^-?\d+(\.\d+)?$/.test(s)) return s;
    return `'${s.replace(/'/g, "''")}'`;
  };
  const statementsOf = (table, changes) => {
    const target = `${table.schema}.${table.table}`;
    const typeOf = (c) => table.columns.find((x) => x.name === c)?.type_name ?? "text";
    const pred = (key) => key.map((k) => `${ident(k.column)} = ${sqlLit(k.value, typeOf(k.column))}`).join(" AND ");
    return changes.map((c) => {
      if (c.op === "insert") {
        const sql = c.values.length
          ? `INSERT INTO ${target} (${c.values.map((v) => ident(v.column)).join(", ")}) VALUES (${c.values.map((v) => sqlLit(v.value, typeOf(v.column))).join(", ")})`
          : `INSERT INTO ${target} DEFAULT VALUES`;
        return { verb: "insert", sql, target, predicate: null };
      }
      if (c.op === "update")
        return {
          verb: "update",
          sql: `UPDATE ${target} SET ${c.set.map((v) => `${ident(v.column)} = ${sqlLit(v.value, typeOf(v.column))}`).join(", ")} WHERE ${pred(c.key)}`,
          target,
          predicate: pred(c.key),
        };
      return { verb: "delete", sql: `DELETE FROM ${target} WHERE ${pred(c.key)}`, target, predicate: pred(c.key) };
    });
  };
  const txn = (st) => `BEGIN;\n${st.map((s) => `${s.sql};\n`).join("")}COMMIT;`;
  const plain = (v) => (v == null || "Null" in v ? null : "Int" in v ? v.Int : "BigInt" in v ? Number(v.BigInt) : "Bool" in v ? v.Bool : v.Text);

  window.__EXPORT_MS__ = 2600;
  window.__STUB_MORE__ = async (cmd, a, base) => {
    switch (cmd) {
      case "browse_table_sql": {
        const sql = browseSql(a);
        browses.set(sql, a);
        return sql;
      }
      case "run_query": {
        const b = browses.get(a.sql);
        if (!b || !TABLES[b.table]) return undefined;
        const { cols, rows } = pick(b);
        return D.result(cols, rows);
      }
      case "count_rows":
        if (!(a.filter ?? "").trim()) return { orders: 84000, customers: 61000 }[a.table] ?? TABLES[a.table]?.rows.length ?? 0;
        return TABLES[a.table]?.rows.filter(matches(a.filter)).length ?? 0;
      case "count_incoming":
        await new Promise((r) => setTimeout(r, 60));
        return a.lookups.map((l) => TABLES[l.table]?.rows.filter((r) => String(r[l.column]) === String(plain(l.value))).length ?? null);
      case "review_changes": {
        const statements = statementsOf(a.table, a.changes);
        return { statements, sql: txn(statements) };
      }
      case "apply_changes": {
        const statements = statementsOf(a.table, a.changes);
        const sql = txn(statements);
        const conn = D.connections.find((c) => c.id === "prd");
        if (!a.confirmed && conn.safe_mode === "confirm")
          return {
            status: "held",
            sql,
            hold: {
              action: "confirm",
              mode: "confirm",
              statements: statements.map((s) => ({ kind: "write", verb: s.verb.toUpperCase(), target: s.target, destructive: false, unlocks_writes: false })),
            },
          };
        await new Promise((r) => setTimeout(r, 300));
        const rows = TABLES[a.table.table].rows;
        let inserted = 0;
        let updated = 0;
        let deleted = 0;
        for (const c of a.changes) {
          const at = c.key ? rows.findIndex((r) => r.id === plain(c.key[0].value)) : -1;
          if (c.op === "update" && at >= 0) {
            for (const v of c.set) rows[at][v.column] = plain(v.value);
            updated++;
          } else if (c.op === "delete" && at >= 0) {
            rows.splice(at, 1);
            deleted++;
          } else if (c.op === "insert") inserted++;
        }
        return { status: "committed", inserted, updated, deleted, elapsed_ms: 24 };
      }
      case "export_results":
      case "copy_all_results": {
        const ch = a.onFrame;
        const total = 84000;
        // The page's clock is fixed (lib.mjs), so progress counts its own steps of 150 ms.
        let step = 0;
        const tick = () => {
          step++;
          const rows = Math.min(total, Math.round(((step * 150) / window.__EXPORT_MS__) * total / 1000) * 1000);
          if (rows < total) {
            ch.onmessage({ t: "progress", rows });
            setTimeout(tick, 150);
          } else ch.onmessage({ t: "done", rows: total, error: null, cancelled: false, path: cmd === "export_results" ? "/Users/maya/Desktop/orders.csv" : null });
        };
        setTimeout(tick, 150);
        return 7;
      }
      case "cancel_query":
      case "cancel_count":
      case "close_query_tab":
      case "cancel_prefetch":
        return null;
      default:
        return undefined;
    }
  };
}

const cell = (row, col) => `${WS} [data-testid="rg-body"] [data-row="${row}"] [data-col="${col}"]`;
const ORDER = { id: 0, customer_id: 1, status: 2, total: 3, currency: 4, placed_at: 5 };
const rows = (page, n) => page.waitForSelector(`${WS} [data-testid="results-grid-wrap"][data-row-count="${n}"]`);
const menu = (page, name) => page.waitForSelector(`[data-menu="${name}"]`);
const pause = (page, ms) => page.waitForTimeout(ms);
/** Sorts by placed_at, newest first (two header clicks). */
async function newestFirst(page) {
  for (let i = 0; i < 2; i++) {
    await page.click(`${WS} [data-header="placed_at"] .rg-header-label`);
    await settle(page);
  }
  await page.waitForSelector(`${WS} [data-header="placed_at"][data-sort="desc"]`);
  await settle(page);
}
async function typeFilter(page, text, delay = 0) {
  await page.keyboard.press("Meta+f");
  await page.waitForSelector(`${WS} [data-sql-line] [data-chip-editor] [data-testid="sql-editor"]`);
  await page.keyboard.type(text, { delay });
  await page.keyboard.press("Enter");
  await page.waitForFunction((ws) => !document.querySelector(`${ws} [data-chip-editor]`), WS);
  await settle(page);
}

// ---- Table tabs and filters --------------------------------------------------------------

{
  const { page } = await openApp({ more });
  await hideKeyStrip(page);
  await newestFirst(page);
  await typeFilter(page, "status = paid");
  await rows(page, 168);
  await shot(page, "table-tabs-and-filters-window");

  // A second chip from a cell, then the head alone.
  await page.click(cell(1, ORDER.currency), { button: "right" });
  await menu(page, "grid");
  await shot(page, "table-tabs-and-filters-cell-menu", { clip: await menuClip(page, "grid", 280, 40) });
  await page.click('[data-menu="grid"] [data-item="f-only"]');
  await settle(page);
  await page.waitForSelector(`${WS} [data-chip="1"]`);
  await shot(page, "table-tabs-and-filters-sql-line", { el: `${WS} [data-sql-line]` });

  // The chip editor with its operator picker.
  await page.keyboard.press("Meta+f");
  await page.waitForSelector(`${WS} [data-chip-editor="new"]`);
  await page.click(`${WS} [data-chip-editor] [data-chip-column]`);
  await menu(page, "chip-column");
  await page.click('[data-menu="chip-column"] [data-item="total"]');
  await page.click(`${WS} [data-chip-editor] [data-chip-op]`);
  await menu(page, "chip-op");
  await shot(page, "table-tabs-and-filters-chip-editor", { clip: await unionClip(page, [`${WS} [data-sql-line]`, '[data-menu="chip-op"]'], 8) });
  await page.keyboard.press("Escape");
  await page.keyboard.press("Escape");

  // Structure.
  await page.keyboard.press("Meta+Alt+2");
  await page.waitForSelector(`${WS} [data-testid="ts-root"]`);
  await shot(page, "table-tabs-and-filters-structure");
  await page.context().close();
}

{
  const { page } = await openApp({ more, w: 1100, h: 640 });
  await hideKeyStrip(page);
  await record(page, "table-tabs-and-filters-filter", async (p) => {
    await pause(p, 600);
    await typeFilter(p, "status = paid", 70);
    await rows(p, 168);
    await pause(p, 1100);
    await p.mouse.move(560, 420, { steps: 8 });
    await p.click(cell(1, ORDER.currency), { button: "right" });
    await menu(p, "grid");
    await pause(p, 900);
    await p.hover('[data-menu="grid"] [data-item="f-only"]');
    await pause(p, 500);
    await p.click('[data-menu="grid"] [data-item="f-only"]');
    await settle(p);
    await p.waitForSelector(`${WS} [data-chip="1"]`);
    await p.mouse.move(1098, 1, { steps: 6 });
  });
  await page.context().close();
}

// ---- Quick Look ----------------------------------------------------------------------------

const QL = `${WS} [data-quicklook]`;
async function quickLook(page, row, col) {
  await page.click(cell(row, col));
  await page.keyboard.press("Space");
  await page.waitForSelector(QL);
  await page.waitForFunction((ql) => [...document.querySelectorAll(`${ql} [data-incoming-row]`)].every((r) => r.dataset.count !== ""), QL);
}

{
  const { page } = await openApp({ more });
  await hideKeyStrip(page);
  await newestFirst(page);
  await quickLook(page, 2, ORDER.total);
  await page.waitForSelector(`${QL} [data-follow-state="label"]`);
  await shot(page, "quick-look-order");
  await shot(page, "quick-look-panel", { el: QL });

  // Follow the customer: the customers row, its own Quick Look with Incoming orders.
  await page.keyboard.press("Escape");
  await page.waitForFunction((ql) => !document.querySelector(ql), QL);
  await page.click(cell(2, ORDER.customer_id));
  await page.keyboard.press("Meta+Enter");
  await page.waitForSelector(`${WS} [data-header="name"]`);
  await settle(page);
  await page.waitForSelector(QL);
  await page.waitForFunction((ql) => [...document.querySelectorAll(`${ql} [data-incoming-row]`)].some((r) => r.dataset.count !== ""), QL);
  await shot(page, "quick-look-customer", { el: QL });
  await page.context().close();
}

// ---- Editing rows ---------------------------------------------------------------------------

async function stage(page, row, col, text) {
  await page.click(cell(row, col));
  await page.keyboard.press("Enter");
  await page.waitForSelector(`${WS} [data-cell-editor]`);
  await page.keyboard.press("Meta+a");
  await page.keyboard.type(text);
  await page.keyboard.press("Enter");
  await page.waitForFunction((ws) => !document.querySelector(`${ws} [data-cell-editor]`), WS);
}

{
  const { page } = await openApp({ more });
  await hideKeyStrip(page);
  await newestFirst(page);
  // The enum editor: the type's labels, filtered as you type.
  await page.click(cell(0, ORDER.status));
  await page.keyboard.press("Enter");
  await page.waitForSelector(`${WS} [data-cell-editor] [data-editor-list]`);
  await page.keyboard.type("re");
  await pause(page, 200);
  await shot(page, "editing-rows-enum-editor", { clip: await unionClip(page, [`${WS} [data-cell-editor]`, `${WS} [data-editor-list]`, `${WS} [data-testid="rg-body"] [data-row="0"] [data-testid="rg-gutter"]`, cell(2, ORDER.total)], 12) });
  // One label left: ↵ takes it.
  await page.keyboard.press("Enter");
  await page.waitForFunction((ws) => !document.querySelector(`${ws} [data-cell-editor]`), WS);
  await stage(page, 1, ORDER.total, "199.00");
  await page.click(`${WS} [data-testid="rg-body"] [data-row="3"] [data-testid="rg-gutter"]`);
  await page.keyboard.press("Backspace");
  await page.click(cell(4, ORDER.total));
  await page.keyboard.press("Meta+i");
  await page.waitForSelector(`${WS} [data-cell-editor]`);
  await page.keyboard.type("3001");
  await page.keyboard.press("Enter");
  await page.waitForFunction((ws) => !document.querySelector(`${ws} [data-cell-editor]`), WS);
  await page.click(cell(6, ORDER.currency));
  await page.waitForSelector(`${WS} [data-edit-tray]`);
  await shot(page, "editing-rows-staged");
  await shot(page, "editing-rows-edits-bar", { el: `${WS} [data-edit-tray]`, pad: 8 });

  await page.keyboard.press("Meta+Shift+p");
  await page.waitForSelector(`${WS} [data-review-card]`);
  await shot(page, "editing-rows-review-sql");

  await page.keyboard.press("Escape");
  await page.waitForFunction((ws) => !document.querySelector(`${ws} [data-review-sql]`), WS);
  await page.keyboard.press("Meta+s");
  await page.waitForSelector(`${WS} [data-testid="safe-bar"]`);
  await shot(page, "editing-rows-confirm-writes", { el: `${WS} [data-testid="safe-bar"]`, pad: 2 });
  await page.context().close();
}

{
  const { page } = await openApp({ more, w: 1100, h: 640 });
  await hideKeyStrip(page);
  await newestFirst(page);
  await record(page, "editing-rows-commit", async (p) => {
    await pause(p, 500);
    await p.click(cell(0, ORDER.status));
    await pause(p, 300);
    await p.keyboard.press("Enter");
    await p.waitForSelector(`${WS} [data-cell-editor] [data-editor-list]`);
    await pause(p, 500);
    await p.keyboard.type("refunded", { delay: 70 });
    await pause(p, 300);
    await p.keyboard.press("Enter");
    await pause(p, 400);
    await p.click(cell(0, ORDER.total));
    await p.keyboard.press("Enter");
    await p.keyboard.press("Meta+a");
    await p.keyboard.type("0.00", { delay: 80 });
    await p.keyboard.press("Enter");
    await pause(p, 900);
    await p.keyboard.press("Meta+Shift+p");
    await p.waitForSelector(`${WS} [data-review-card]`);
    await pause(p, 1600);
    await p.hover(`${WS} [data-review-commit]`);
    await pause(p, 400);
    await p.click(`${WS} [data-review-commit]`);
    await p.waitForSelector(`${WS} [data-edit-tray="done"]`);
    await pause(p, 1000);
    await p.mouse.move(1098, 1, { steps: 6 });
    await settle(p);
  });
  await page.context().close();
}

// ---- Exporting and copying ----------------------------------------------------------------

{
  const { page } = await openApp({ more });
  await hideKeyStrip(page);
  await newestFirst(page);
  // A block: its sum and average on the WHERE line.
  await page.click(cell(0, ORDER.total));
  await page.click(cell(5, ORDER.total), { modifiers: ["Shift"] });
  await pause(page, 200);
  const grid = await page.locator(`${WS} [data-testid="rg-body"] [data-row="7"]`).boundingBox();
  const line = await page.locator(`${WS} [data-sql-line]`).boundingBox();
  await shot(page, "exporting-and-copying-selection", { clip: { x: line.x, y: line.y, width: line.width, height: Math.round(grid.y - line.y) } });

  await page.click(`${WS} [data-testid="zone-menu"][data-zone="results"]`);
  await menu(page, "zone-results");
  await shot(page, "exporting-and-copying-results-menu", { clip: await menuClip(page, "zone-results", 360, 60) });
  await page.keyboard.press("Escape");

  await page.click(cell(2, ORDER.currency));
  await page.keyboard.press("Meta+Shift+e");
  await page.waitForFunction((ws) => Number(document.querySelector(`${ws} [data-exporting]`)?.dataset.exporting) >= 20000, WS);
  await shot(page, "exporting-and-copying-exporting", { el: `${WS} [data-sql-line]` });
  await page.waitForSelector("[data-toast]");
  await pause(page, 300);
  await shot(page, "exporting-and-copying-toast", { el: "[data-toast]", pad: 10 });
  await page.waitForFunction(() => !document.querySelector("[data-toast]"), null, { timeout: 15000 }).catch(() => {});

  // ⌘K: the copy commands while more rows remain than are loaded.
  await page.keyboard.press("Meta+k");
  await page.waitForSelector('[data-testid="cp-panel"]');
  await page.keyboard.type("copy");
  await pause(page, 200);
  await shot(page, "exporting-and-copying-palette", { el: '[data-testid="cp-panel"]', pad: 12 });
  await page.context().close();
}

// ---- helpers for clips of a menu with what it belongs to ----------------------------------

async function menuClip(page, name, extraLeft = 0, extraTop = 0) {
  const b = await page.locator(`[data-menu="${name}"]`).boundingBox();
  const vp = page.viewportSize();
  const x = Math.max(0, b.x - extraLeft);
  const y = Math.max(0, b.y - extraTop);
  return { x, y, width: Math.min(vp.width - x, b.width + extraLeft + 24), height: Math.min(vp.height - y, b.height + extraTop + 24) };
}
async function unionClip(page, sels, pad = 0) {
  const boxes = [];
  for (const s of sels) boxes.push(await page.locator(s).first().boundingBox());
  const vp = page.viewportSize();
  const x0 = Math.max(0, Math.min(...boxes.map((b) => b.x)) - pad);
  const y0 = Math.max(0, Math.min(...boxes.map((b) => b.y)) - pad);
  const x1 = Math.min(vp.width, Math.max(...boxes.map((b) => b.x + b.width)) + pad);
  const y1 = Math.min(vp.height, Math.max(...boxes.map((b) => b.y + b.height)) + pad);
  return { x: x0, y: y0, width: Math.round(x1 - x0), height: Math.round(y1 - y0) };
}

await close();
sizes();
