// Query tabs and the editor on Postgres (alpha checklist QRY).
import assert from "node:assert/strict";
import { PG, cell, connect, finished, noPageErrors, palette, run, savePostgres, setSql, settled, sleep } from "../helpers.mjs";

const psql = async (sql) => {
  const { execFileSync } = await import("node:child_process");
  return execFileSync("psql", ["-h", PG.host, "-p", String(PG.port), "-U", PG.user, "-d", PG.database, "-tAc", sql], {
    env: { ...process.env, PGPASSWORD: PG.password },
  })
    .toString()
    .trim();
};

export default {
  name: "Query tabs and editor",
  async setup({ app }) {
    await savePostgres(app);
    await connect(app, "e2e-pg");
  },
  tests: [
    {
      id: "QRY-3",
      title: "⌘↵ runs the statement at the caret",
      async run({ app }) {
        const meta = await run(app, "SELECT 41 + 1 AS answer;");
        assert.match(meta, /1 row/);
        assert.equal(await cell(app, 0, 0), "42");
      },
    },
    {
      id: "QRY-3b",
      title: "Run all statements runs every statement",
      async run({ app }) {
        await setSql(app, "SELECT 1 AS a;\nSELECT 2 AS b;\nSELECT 3 AS c;");
        const before = await app.eval("return window.__e2e.runs.started;");
        await palette(app, "run all", { item: "cmd:run-all" });
        // All three, one after another: the next test mustn't start while the last two still run.
        await app.until(`__e2e.runs.started >= ${before} + 3 && __e2e.runs.done >= __e2e.runs.started`, { timeout: 20_000, what: "all three statements ran" });
        const meta = await finished(app);
        assert.doesNotMatch(meta, /error/i);
        const shown = await cell(app, 0, 0);
        assert.equal(shown, "3", "the last statement's result is shown");
        return { shown, meta };
      },
    },
    {
      id: "QRY-3c",
      title: "⌥⌘↵ from the editor runs every statement",
      async run({ app }) {
        await setSql(app, "SELECT 1 AS a;\nSELECT 2 AS b;\nSELECT 3 AS c;");
        const before = await app.eval("return window.__e2e.runs.started;");
        await app.press("Alt+Mod+Enter", '[data-testid="sql-editor"]');
        await app.until(`__e2e.runs.started >= ${before} + 3 && __e2e.runs.done >= __e2e.runs.started`, { timeout: 10_000, what: "three runs" });
        assert.equal(await cell(app, 0, 0), "3");
      },
    },
    {
      id: "QRY-5",
      title: "Cancel Query (⌘.) and Esc cancel a running query on the server",
      async run({ app }) {
        for (const how of ["menu", "Escape"]) {
          await setSql(app, "SELECT pg_sleep(30);");
          await app.press("Mod+Enter", '[data-testid="sql-editor"]');
          await app.waitFor('[data-testid="card-meta"][data-state="running"]');
          await sleep(300);
          if (how === "menu") await app.menu("cancel");
          else await app.press("Escape", '[data-testid="sql-editor"]');
          await app.waitFor('[data-testid="card-meta"][data-state="cancelled"]', { timeout: 5000 }).catch(async (e) => {
            const meta = await app.eval(`const m = document.querySelector('[data-testid="workspace"]:not([hidden]) [data-testid="card-meta"]'); return m ? m.dataset.state + " · " + m.textContent : "no header";`);
            throw new Error(`${how}: ${e.message} (the header: ${meta})`);
          });
          await sleep(200);
          const left = await psql("SELECT count(*) FROM pg_stat_activity WHERE query = 'SELECT pg_sleep(30);' AND state = 'active'");
          assert.equal(left, "0", `${how}: the server is still running the cancelled query`);
        }
      },
    },
    {
      id: "QRY-4",
      title: "two tabs run at once on their own sessions",
      async run({ app }) {
        await setSql(app, "SELECT pg_sleep(1.5), 'one' AS tab;");
        await app.press("Mod+Enter", '[data-testid="sql-editor"]');
        await palette(app, "New query tab", { item: "cmd:new-tab" });
        await setSql(app, "SELECT pg_backend_pid() AS pid, 'two' AS tab;");
        const t0 = Date.now();
        await run(app);
        assert.ok(Date.now() - t0 < 1400, "the second tab waited for the first");
        await sleep(1600);
        await app.click('[data-testid="query-tab"][data-title]');
        const meta = await finished(app);
        assert.match(meta, /1 row/);
      },
    },
    {
      id: "QRY-8",
      title: "a query error shows the error view with the cause",
      async run({ app }) {
        await setSql(app, "SELECT * FROM no_such_table;");
        await app.press("Mod+Enter", '[data-testid="sql-editor"]');
        await app.waitFor('[data-testid="card-meta"][data-state="error"]');
        const sentence = await app.text('[data-testid="qe-sentence"], [data-testid="qe-raw"]');
        assert.match(sentence, /no_such_table/);
      },
    },
    {
      id: "QRY-11",
      title: "a user transaction spans runs: BEGIN, INSERT, ROLLBACK leaves nothing",
      async run({ app }) {
        await run(app, "BEGIN;");
        await run(app, "INSERT INTO e2e_nopk VALUES ('tx-probe', -1);");
        const inside = await run(app, "SELECT count(*) FROM e2e_nopk WHERE label = 'tx-probe';");
        assert.equal(await cell(app, 0, 0), "1", inside);
        await run(app, "ROLLBACK;");
        assert.equal(await psql("SELECT count(*) FROM e2e_nopk WHERE label = 'tx-probe'"), "0");
      },
    },
    {
      id: "QRY-12",
      title: "SELECT nextval() runs once per run",
      async run({ app }) {
        await run(app, "SELECT nextval('e2e_counter') AS n;");
        const first = Number(await cell(app, 0, 0));
        await run(app, "SELECT nextval('e2e_counter') AS n;");
        assert.equal(Number(await cell(app, 0, 0)), first + 1);
      },
    },
    {
      id: "QRY-1",
      title: "Close Tab (⌘W) closes the tab; Reopen Closed Tab (⇧⌘T) brings back its SQL",
      async run({ app }) {
        await palette(app, "New query tab", { item: "cmd:new-tab" });
        const title = await app.eval(`return document.querySelector('[data-testid="query-tab"][data-on]').dataset.title;`);
        await setSql(app, "SELECT 'closing me' AS x;");
        const tab = `[data-testid="query-tab"][data-title="${title}"]`;
        await app.menu("close-tab");
        await app.until(`!document.querySelector('${tab}')`, { what: `${title} closed` });
        await app.menu("reopen-closed-tab");
        await app.until(`document.querySelector('${tab}[data-on]')`, { what: `${title} back and shown` });
        const sql = await app.eval(`return document.querySelector('[data-testid="sql-editor"]').value;`);
        assert.match(sql, /closing me/);
      },
    },
    {
      id: "QRY-9",
      title: "typing into a 2,000-line script stays smooth",
      async run({ app }) {
        const script = Array.from({ length: 2000 }, (_, i) => `SELECT ${i} AS n, 'line ${i}' AS label FROM e2e_people WHERE id = ${i};`).join("\n");
        await setSql(app, script);
        // Let the fill's own highlighting settle; measure the typing only.
        await sleep(1500);
        await app.eval(`const t = document.querySelector('[data-testid="sql-editor"]'); t.focus(); t.setSelectionRange(t.value.length, t.value.length); window.__e2e.frames.start(); return true;`);
        const t0 = Date.now();
        await app.type("\nSELECT count(*) FROM e2e_people WHERE active AND age > 30;", null, 60);
        const typed = Date.now() - t0;
        await sleep(200);
        const frames = await app.eval("return window.__e2e.frames.stop();");
        assert.ok(frames.max < 120, `a frame took ${frames.max} ms while typing`);
        await noPageErrors(app);
        return { typedMs: typed, ...frames };
      },
    },
  ],
};
