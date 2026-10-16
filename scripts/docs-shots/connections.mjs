#!/usr/bin/env node
// Docs screens for the Connections pages (docs.rowkery.com /windows-and-switching/,
// /environments-and-safe-mode/), from the running app (Vite) with the docs' stubbed storefront
// backend plus four more saved connections and five restored windows:
//  - windows-and-switching-pills: the title bar with a window per connection (prd, stg, dev,
//    local), an empty window's penguin pill, +, then Safe mode, MCP and Search;
//  - windows-and-switching-connection-switcher: ⇧⌘O with a pinned connection on top;
//  - windows-and-switching-database-switcher: ⇧⌘D listing the server's databases;
//  - windows-and-switching-failed: Couldn't connect, with Retry and Edit…;
//  - windows-and-switching-foot: the schema column's foot (Agents, Appearance, Presenting, Help);
//  - environments-and-safe-mode-menu: the Safe mode menu open in the title bar;
//  - environments-and-safe-mode-held: Confirm writes holding a DELETE over the last results;
//  - environments-and-safe-mode-destructive: an UPDATE with no WHERE, held with its warning;
//  - environments-and-safe-mode-refused: a Read-only connection refusing an UPDATE;
//  - environments-and-safe-mode-form: the connection form's Environment (suggested) and Safe mode.
// The stub's safe mode check stands in for core's (`safety.rs`), as in safe-mode-browser-proof.
// Not a proof: it checks nothing beyond waiting for each screen.
//
//   cd apps/rowkery-tauri && npx vite --port 1420 &
//   node scripts/docs-shots/connections.mjs [outDir] [--write] [--only=pills,held]
import { openApp, shot, close, sizes, settle, hideKeyStrip, wanted, WS } from "./lib.mjs";

/** Runs in the page after the base stub: more connections, saved windows, safe mode, databases. */
function more(seed) {
  const D = window.__DOCS__;
  const pg = (id, name, host, environment, database, extra = {}) => ({
    kind: "postgres",
    id,
    name,
    host,
    port: 5432,
    database,
    username: "app",
    environment,
    safe_mode: "off",
    ...extra,
  });
  D.connections.find((c) => c.id === "stg").safe_mode = "read_only";
  D.connections.push(
    pg("dev", "analytics", "analytics.dev.internal", "dev", "analytics"),
    pg("local", "Docker Postgres", "127.0.0.1", "local", "shop", { port: 54329 }),
    pg("replica", "billing-replica", "billing-ro.example.com", null, "billing"),
    { kind: "sqlite", id: "sample", name: "Sample database", path: "~/Library/Application Support/Rowkery/sample.sqlite", sample: true },
  );
  // The core's safe mode check, reduced to what these screens run.
  const check = (sql) => {
    const body = sql.replace(/--[^\n]*\n?/g, " ").trim();
    const verb = /^(\w+)/.exec(body)?.[1]?.toUpperCase() ?? "";
    if (!["INSERT", "UPDATE", "DELETE", "DROP", "TRUNCATE", "CREATE", "ALTER"].includes(verb)) return null;
    const target = /^(?:\w+)\s+(?:FROM\s+|INTO\s+|TABLE\s+)?([\w.]+)/i.exec(body)?.[1] ?? null;
    return {
      kind: ["DROP", "TRUNCATE", "CREATE", "ALTER"].includes(verb) ? "schema" : "write",
      verb,
      target,
      destructive: ["DROP", "TRUNCATE"].includes(verb) || (["DELETE", "UPDATE"].includes(verb) && !/\bWHERE\b/i.test(body)),
      unlocks_writes: false,
    };
  };
  const windowConn = {};
  window.__STUB_MORE__ = async (cmd, a) => {
    switch (cmd) {
      case "load_ui_state":
        return { version: 1, keys: structuredClone(seed) };
      case "open_window": {
        windowConn[a.windowId] = a.connectionId;
        if (a.connectionId === "replica") {
          await new Promise((r) => setTimeout(r, 80));
          throw "error connecting to server: timed out";
        }
        const conn = D.connections.find((c) => c.id === a.connectionId);
        const database = a.database ?? conn?.database ?? "shop";
        return { database, catalog: { ...structuredClone(D.catalog), databases: [{ ...D.catalog.databases[0], name: database }] }, server_version: "16.4", elapsed_ms: 28, cached: false, open_seq: 1 };
      }
      case "explain_connect_error":
        return { class: "timeout", cause: `${a.host}:${a.port} did not answer in 10 s.`, field: "host" };
      case "list_databases":
        return [
          { name: "analytics", size_bytes: 3_221_225_472 },
          { name: "postgres", size_bytes: 8_912_896 },
          { name: "shop", size_bytes: 12_884_901_888 },
          { name: "shop_archive", size_bytes: 41_875_931_136 },
          { name: "shop_staging_copy", size_bytes: 6_442_450_944 },
        ];
      case "save_connection": {
        const i = D.connections.findIndex((c) => c.id === a.connection.id);
        if (i >= 0) D.connections[i] = { ...D.connections[i], ...a.connection };
        return null;
      }
      case "run_query": {
        const conn = D.connections.find((c) => c.id === windowConn[a.windowId]);
        const mode = conn?.safe_mode ?? "off";
        const s = check(a.sql ?? "");
        if (s && (mode === "read_only" || (mode === "confirm" && !a.confirmed))) {
          return {
            columns: [], rows: [], row_count: 0, elapsed_ms: 0, error: null, cancelled: false,
            hold: { action: mode === "read_only" ? "refuse" : "confirm", mode, statements: [s] },
          };
        }
        if (s) return { columns: [], rows: [], row_count: 0, elapsed_ms: 7, error: null, cancelled: false };
        return undefined;
      }
      default:
        return undefined;
    }
  };
}

const query = (sql) => ({ tabs: [{ kind: "query", title: "Query 1", sql }], activeTab: 0 });
const SEED = {
  "rowkery.windows": {
    windows: [
      { connectionId: "prd", database: "shop", ...query("SELECT * FROM orders\nORDER BY placed_at DESC;") },
      { connectionId: "stg", database: "shop", ...query("SELECT * FROM orders ORDER BY placed_at DESC;") },
      { connectionId: "dev", database: "analytics" },
      { connectionId: "local", database: "shop" },
      { connectionId: null, database: null },
    ],
    active: 0,
  },
  "rowkery.pinnedConnections": ["prd"],
};

async function app(o = {}, seed = SEED) {
  const src = `(${more.toString()})(${JSON.stringify(seed)});`;
  const { page, context } = await openApp({ connect: false, more: { content: src }, ...o });
  return { page, context };
}
const connected = `${WS}[data-conn-state="connected"]`;
const editor = `${WS} [data-testid="sql-editor"]`;
const run = async (page, sql) => {
  await page.fill(editor, sql);
  await page.focus(editor);
  await page.keyboard.press("Meta+Enter");
};

// Windows: the title bar, the two switchers, the schema column's foot.
{
  const { page, context } = await app();
  await page.waitForSelector(connected);
  await hideKeyStrip(page);
  await settle(page);
  if (wanted("windows-and-switching-connection-switcher")) {
    await page.keyboard.press("Meta+Shift+O");
    await page.waitForSelector('[data-testid="conn-popover"]');
    await shot(page, "windows-and-switching-connection-switcher", { el: '[data-testid="conn-popover"]', pad: 14 });
    await page.keyboard.press("Escape");
  }
  if (wanted("windows-and-switching-database-switcher")) {
    await page.keyboard.press("Meta+Shift+D");
    await page.waitForSelector('[data-testid="db-option"]');
    await shot(page, "windows-and-switching-database-switcher", { el: '[data-testid="db-popover"]', pad: 14 });
    await page.keyboard.press("Escape");
  }
  if (wanted("windows-and-switching-foot")) {
    const b = await page.locator(`${WS} [data-testid="sb-foot-rows"]`).boundingBox();
    await shot(page, "windows-and-switching-foot", { clip: { x: 0, y: b.y - 10, width: 264, height: b.height + 20 } });
  }
  // Safe mode menu, held writes and the Read-only refusal (prd: Confirm writes, stg: Read-only).
  if (wanted("environments-and-safe-mode-menu")) {
    await page.click('[data-testid="titlebar"] [data-shield]');
    await page.waitForSelector('[data-menu="safe-mode"]');
    const m = await page.locator('[data-menu="safe-mode"]').boundingBox();
    const s = await page.locator('[data-testid="titlebar"] [data-shield]').boundingBox();
    const x = Math.floor(s.x - 16);
    await shot(page, "environments-and-safe-mode-menu", { clip: { x, y: 0, width: 1280 - x, height: Math.ceil(m.y + m.height + 16) }, mouse: false });
    await page.keyboard.press("Escape");
  }
  if (wanted("environments-and-safe-mode-held") || wanted("environments-and-safe-mode-destructive")) {
    await page.focus(editor);
    await page.keyboard.press("Meta+Enter");
    await page.waitForSelector(`${WS} [data-testid="results-grid-wrap"][data-row-count]`);
    await settle(page);
    await run(page, "-- Drop abandoned carts\nDELETE FROM orders\nWHERE status = 'pending'\n  AND placed_at < now() - interval '30 days';");
    await page.waitForSelector(`${WS} [data-testid="safe-bar"]`);
    await shot(page, "environments-and-safe-mode-held", { clip: { x: 264, y: 48, width: 1016, height: 560 } });
    await page.keyboard.press("Escape");
    await run(page, "UPDATE orders\nSET status = 'cancelled';");
    await page.waitForSelector(`${WS} [data-testid="safe-bar"][data-tone="danger"]`);
    const bar = await page.locator(`${WS} [data-testid="safe-bar"]`).boundingBox();
    await shot(page, "environments-and-safe-mode-destructive", { clip: { x: bar.x - 12, y: bar.y - 12, width: bar.width + 24, height: bar.height + 24 } });
    await page.keyboard.press("Escape");
  }
  if (wanted("environments-and-safe-mode-refused")) {
    await page.keyboard.press("Meta+2");
    await page.waitForSelector(connected);
    await settle(page);
    await run(page, "UPDATE orders\nSET status = 'refunded'\nWHERE id = 84210;");
    await page.waitForSelector(`${WS} [data-testid="safe-refuse"]`);
    await shot(page, "environments-and-safe-mode-refused", { clip: { x: 264, y: 48, width: 1016, height: 660 } });
  }
  await context.close();
}

// The title bar, wide enough for five windows' names.
if (wanted("windows-and-switching-pills")) {
  const { page, context } = await app({ w: 1600 });
  await page.waitForSelector(connected);
  await settle(page);
  await shot(page, "windows-and-switching-pills", { clip: { x: 0, y: 0, width: 1600, height: 48 } });
  await context.close();
}

// Couldn't connect: a restored window whose server doesn't answer.
if (wanted("windows-and-switching-failed")) {
  const seed = { ...SEED, "rowkery.windows": { windows: [{ connectionId: "replica", database: "billing" }], active: 0 } };
  const { page, context } = await app({}, seed);
  await page.waitForSelector(`${WS} [data-connect-error] [data-cause]`);
  await shot(page, "windows-and-switching-failed", { clip: { x: 264, y: 48, width: 1016, height: 480 } });
  await context.close();
}

// The connection form's labels: Environment suggested from the name and host, Safe mode.
if (wanted("environments-and-safe-mode-form")) {
  const { page, context } = await app();
  await page.waitForSelector(connected);
  await page.keyboard.press("Meta+n");
  await page.waitForSelector('[data-field="name"] input');
  await page.fill('[data-field="name"] input', "orders-prod");
  await page.fill('[data-field="host"] input', "orders.db.example.com");
  await page.waitForSelector('[data-section="labels"] [data-suggested]');
  const env = await page.locator('[data-section="labels"]').boundingBox();
  const safe = await page.locator('[data-section="labels"] .nc-safe').boundingBox();
  await shot(page, "environments-and-safe-mode-form", { clip: { x: env.x - 12, y: env.y - 12, width: env.width + 24, height: Math.ceil(safe.y + safe.height - env.y + 24) } });
  await context.close();
}

await close();
sizes();
