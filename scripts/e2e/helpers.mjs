// Shared steps for the end-to-end suites: saved connections, connecting a
// window, running SQL and reading the grid. Selectors follow scripts/lib/README.md.
import assert from "node:assert/strict";

export const PG = {
  host: "127.0.0.1",
  port: Number(process.env.ROWKERY_PG_PORT ?? 54329),
  user: "rowkery",
  password: "rowkery",
  database: "rowkery_e2e",
};

/** Saves a Postgres connection through the app's own command, then reloads the page to list it. */
export async function savePostgres(app, { id = "e2e-pg", name = "e2e", database = PG.database, env = null, safe = "off", password = PG.password } = {}) {
  await app.invoke("save_connection", {
    connection: {
      kind: "postgres",
      id,
      name,
      host: PG.host,
      port: PG.port,
      database,
      username: PG.user,
      ssl_mode: "disable",
      environment: env,
      safe_mode: safe,
    },
    secrets: { db_password: password },
  });
  await app.reload();
  return id;
}

export async function saveSqlite(app, { id = "e2e-sqlite", name = "fixture", path }) {
  await app.invoke("save_connection", { connection: { kind: "sqlite", id, name, path, safe_mode: "off" }, secrets: {} });
  await app.reload();
  return id;
}

/** Switches the shown window to a saved connection with ⇧⌘O and waits for it to connect. */
export async function connect(app, id, { timeout = 15_000 } = {}) {
  await app.menu("switch-connection");
  const row = `[data-conn-id="${id}"]`;
  await app.waitFor(row);
  const name = await app.text(`${row} [data-testid="conn-option-name"]`);
  await app.click(row);
  await connected(app, { timeout, name });
}

/** Waits until the shown window is connected (to the connection called `name`, when given). */
export async function connected(app, { timeout = 15_000, name } = {}) {
  await app.until(
    `(() => {
      const s = document.querySelector('[data-testid="sb-status"]');
      const chip = document.querySelector('[data-testid="conn-chip-name"]');
      return s && s.dataset.state === "connected" && (${JSON.stringify(name ?? null)} === null || (chip && chip.textContent.trim() === ${JSON.stringify(name ?? "")}));
    })()`,
    { timeout, what: name ? `connected to ${name}` : "the window connected" },
  );
}

/** Replaces the shown query tab's SQL. */
export async function setSql(app, sql) {
  // A tab that was just opened may still be rendering its editor: fill until the shown one holds the text.
  for (let i = 0; i < 5; i++) {
    await app.fill('[data-testid="sql-editor"]', sql);
    const ok = await app.eval(`return window.__e2e.first('[data-testid="sql-editor"]')?.value === ${JSON.stringify(sql)};`);
    if (ok) return;
    await sleep(120);
  }
  throw new Error("the editor never took the SQL");
}

/** Runs the editor's statement at the caret (⌘↵) and waits for it to finish. */
export async function run(app, sql, { timeout = 20_000 } = {}) {
  if (sql != null) await setSql(app, sql);
  const before = await app.eval("return window.__e2e.runs.started;");
  await app.press("Mod+Enter", '[data-testid="sql-editor"]');
  await settled(app, before, { timeout });
  return outcome(app);
}

/** The shown tab's result header, or the results card's text when a statement returned no rows. */
export function outcome(app) {
  return app.eval(`
    const m = document.querySelector('[data-testid="card-meta"]');
    if (m && window.__e2e.visible(m)) return m.textContent.replace(/\\s+/g, " ").trim();
    const card = document.querySelector('[data-testid="results-card"]');
    return card ? card.textContent.replace(/\\s+/g, " ").trim().slice(0, 200) : "";
  `);
}

/** Waits for a run started after `before` (an `__e2e.runs.started` count) and everything in flight to settle. */
export async function settled(app, before, { timeout = 20_000 } = {}) {
  await app.until(`__e2e.runs.started > ${before} && __e2e.runs.done >= __e2e.runs.started`, { timeout, what: "the run settled" });
}

/** Waits until the shown tab has a result header that isn't running; returns its text. */
export async function finished(app, { timeout = 20_000 } = {}) {
  return app.until(
    `(() => { const m = document.querySelector('[data-testid="card-meta"]'); return m && m.dataset.state !== "running" && window.__e2e.visible(m) && m.textContent.replace(/\\s+/g, " ").trim(); })()`,
    { timeout, what: "the query finished" },
  );
}

/** The grid's cell text at (row, col) as shown. */
export function cell(app, row, col) {
  return app.text(`[data-testid="workspace"]:not([hidden]) [data-row="${row}"] [data-col="${col}"]`);
}

/** Header names, in order. */
export function headers(app) {
  return app.eval(
    `return [...document.querySelectorAll('[data-header]')].filter(window.__e2e.visible).map((h) => h.getAttribute('data-header'));`,
  );
}

/** Asserts the page logged no errors since the last call. */
export async function noPageErrors(app) {
  const errors = await app.takeErrors();
  assert.deepEqual(errors, [], `page errors: ${errors.map((e) => `${e.kind}: ${e.text.split("\n")[0]}`).join(" | ")}`);
}

/** Opens ⌘K, types `text`, waits for a row and picks the first one (or the row `item`). */
export async function palette(app, text, { item } = {}) {
  await app.press("Mod+K");
  await app.waitFor('[data-testid="cp-search"]');
  await app.fill('[data-testid="cp-search"]', text);
  const sel = item ? `[data-testid="cp-row"][data-item="${item}"]` : '[data-testid="cp-row"]';
  await app.waitFor(sel);
  if (item) await app.click(sel);
  else await app.press("Enter", '[data-testid="cp-search"]');
}

export async function toast(app, re, { timeout = 5000 } = {}) {
  return app.waitText('[data-testid="toast-message"]', re, { timeout });
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Scrolls the shown grid sideways until the column `name` is rendered (columns are virtualized); returns its index. */
export async function revealColumn(app, name) {
  return app.eval(`
    const W = '[data-testid="workspace"]:not([hidden])';
    const find = () => [...document.querySelectorAll(W + ' [data-header]')].find((h) => h.dataset.header === ${JSON.stringify(name)});
    const wrap = document.querySelector(W + ' [data-testid="results-grid-wrap"]');
    let scroller = null;
    for (const el of [wrap, ...wrap.querySelectorAll('*')]) if (el.scrollWidth > el.clientWidth + 4) { scroller = el; break; }
    for (let i = 0; i < 80 && !find() && scroller; i++) {
      scroller.scrollLeft += 240;
      await new Promise((r) => requestAnimationFrame(r));
      await new Promise((r) => requestAnimationFrame(r));
    }
    const h = find();
    if (!h) throw new Error("no column ${name}");
    h.scrollIntoView({ inline: "center", block: "nearest" });
    await new Promise((r) => requestAnimationFrame(r));
    return Number(h.closest('[data-col]')?.dataset.col ?? [...document.querySelectorAll(W + ' [data-header]')].indexOf(h));
  `);
}

/** Runs `step` until `done` (a page predicate) holds, up to `times` tries: for openers that race a run still settling. */
export async function until(app, step, done, { times = 3, timeout = 2500, what = done } = {}) {
  let last;
  for (let i = 0; i < times; i++) {
    await step();
    try {
      return await app.until(done, { timeout, what });
    } catch (e) {
      last = e;
    }
  }
  throw last;
}

