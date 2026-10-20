// Connections: the sheet, switching, failures, labels and safety (alpha checklist CON).
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { PG, cell, connect, connected, palette, run, savePostgres, saveSqlite, sleep, toast } from "../helpers.mjs";

const field = (name) => `[data-testid="nc-sheet"] [data-field="${name}"] input`;
const psql = (sql, db = PG.database) =>
  execFileSync("psql", ["-h", PG.host, "-p", String(PG.port), "-U", PG.user, "-d", db, "-tAc", sql], { env: { ...process.env, PGPASSWORD: PG.password } })
    .toString()
    .trim();

async function openSheet(app) {
  await app.menu("new-connection");
  await app.waitFor('[data-testid="nc-sheet"]');
}

export default {
  name: "Connections",
  tests: [
    {
      id: "CON-1",
      title: "a new window shows Connect to start with its actions",
      async run({ app }) {
        await connected(app);
        await app.menu("new-window");
        await app.waitFor('[data-testid="ew-title"]');
        const rows = await app.eval(`return [...document.querySelectorAll('[data-empty-action]')].map((r) => r.dataset.emptyAction);`);
        assert.ok(rows.length >= 2, `empty window actions: ${rows}`);
        const found = await app.eval(`return [...document.querySelectorAll('[data-found]')].map((r) => r.dataset.found);`);
        await app.menu("close-window");
        return { actions: rows, foundOnThisMac: found };
      },
    },
    {
      id: "CON-3",
      title: "New Connection: fill the fields, Test, Save and connect",
      async run({ app }) {
        await connected(app);
        await openSheet(app);
        await app.fill(field("host"), PG.host);
        await app.fill(field("port"), String(PG.port));
        await app.fill(field("database"), PG.database);
        await app.fill(field("username"), PG.user);
        await app.fill(field("password"), PG.password);
        await app.click("[data-test-connection]");
        await app.until(`document.querySelector('[data-probe]')?.dataset.probe === "ok"`, { timeout: 10_000, what: "Test says ok" });
        await app.click("[data-save]");
        await app.waitGone('[data-testid="nc-sheet"]', { timeout: 10_000 });
        await connected(app, { timeout: 15_000 });
        const name = await app.text('[data-testid="conn-chip-name"]');
        assert.doesNotMatch(name, /sample/i, `still on ${name}`);
        await run(app, "SELECT current_database() AS db;");
        assert.equal(await cell(app, 0, 0), PG.database);
        return { savedAs: name };
      },
    },
    {
      id: "CON-4",
      title: "a postgres:// URL pasted into the sheet fills the fields",
      async run({ app }) {
        await connected(app);
        await openSheet(app);
        const url = `postgres://${PG.user}:${PG.password}@${PG.host}:${PG.port}/${PG.database}?sslmode=disable`;
        const hasUrl = await app.eval(`return !!document.querySelector('[data-testid="nc-sheet"] [data-field="url"] input');`);
        if (hasUrl) await app.fill('[data-testid="nc-sheet"] [data-field="url"] input', url);
        else {
          await app.eval(`
            const el = document.querySelector('[data-testid="nc-sheet"] [data-field="host"] input');
            el.focus();
            const dt = new DataTransfer();
            dt.setData("text/plain", ${JSON.stringify(url)});
            el.dispatchEvent(new ClipboardEvent("paste", { clipboardData: dt, bubbles: true, cancelable: true }));
            return true;`);
        }
        await app.until(`document.querySelector('${field("host")}')?.value === "${PG.host}"`, { what: "host filled from the URL" });
        const values = await app.eval(`return Object.fromEntries(["host", "port", "database", "username"].map((f) => [f, document.querySelector('[data-testid="nc-sheet"] [data-field="' + f + '"] input')?.value]));`);
        assert.equal(values.database, PG.database);
        assert.equal(values.username, PG.user);
        assert.equal(String(values.port), String(PG.port));
        await app.press("Escape");
        await app.waitGone('[data-testid="nc-sheet"]');
        return values;
      },
    },
    {
      id: "CON-8",
      title: "a wrong password shows Couldn't connect with the cause, and Retry",
      async run({ app }) {
        await savePostgres(app, { id: "e2e-badpw", name: "bad password", password: "wrong" });
        await app.menu("switch-connection");
        await app.waitFor('[data-conn-id="e2e-badpw"]');
        await app.click('[data-conn-id="e2e-badpw"]');
        await app.waitFor('[data-testid="sb-error-title"]', { timeout: 15_000 });
        const why = await app.text('[data-testid="sb-error-text"]');
        assert.match(why, /password|authentication/i, why);
        const actions = await app.eval(`return [...document.querySelectorAll('[data-testid="sb-error-btn"]')].map((b) => b.dataset.action || b.textContent.trim());`);
        await app.click('[data-testid="sb-error-btn"][data-action="retry"]');
        await app.waitFor('[data-testid="sb-error-title"]', { timeout: 15_000 });
        return { cause: why, actions };
      },
    },
    {
      id: "CON-11",
      title: "Switch connection moves the window between Postgres and SQLite",
      async run({ app, sqlitePath }) {
        await savePostgres(app);
        await saveSqlite(app, { path: sqlitePath });
        await connect(app, "e2e-pg");
        await run(app, "SELECT 'pg' AS engine;");
        assert.equal(await cell(app, 0, 0), "pg");
        await connect(app, "e2e-sqlite");
        await run(app, "SELECT count(*) AS n FROM notes;");
        assert.equal(await cell(app, 0, 0), "500");
      },
    },
    {
      id: "CON-12",
      title: "Switch database: type a name, ↵ switches to it (and back)",
      async run({ app }) {
        await savePostgres(app);
        await connect(app, "e2e-pg");
        const pick = async (name) => {
          await app.menu("switch-database");
          await app.waitFor('[data-testid="db-popover"]');
          await app.until(`document.activeElement?.closest('[data-testid="db-popover"]')`, { what: "the filter focused" });
          await app.type(name);
          // The option reads "rowkery_e2e_orders7.4 MB": the name, then the size.
          await app.until(`/^\\s*${name}(?![a-z_])/.test(document.querySelector('[role="option"][aria-selected="true"]')?.textContent ?? "")`, { what: `the cursor on ${name}` });
          await app.press("Enter");
          await app.until(`(document.querySelector('[data-testid="db-chip"]')?.textContent ?? "").trim().startsWith(${JSON.stringify(name)}) && !(${name === PG.database} && (document.querySelector('[data-testid="db-chip"]')?.textContent ?? "").includes("orders"))`, { timeout: 15_000, what: `on ${name}` });
          await connected(app);
        };
        const dbs = await (async () => {
          await app.menu("switch-database");
          await app.waitFor('[data-testid="db-popover"]');
          const list = await app.texts('[data-testid="db-option"]');
          await app.press("Escape");
          return list;
        })();
        await pick("rowkery_e2e_orders");
        await run(app, "SELECT count(*) FROM orders;");
        assert.equal(await cell(app, 0, 0), "10");
        // The exact name, though rowkery_e2e_orders (the current one) matches it too.
        await pick(PG.database);
        await run(app, "SELECT count(*) FROM e2e_people;");
        return { databases: dbs.length };
      },
    },
    {
      id: "CON-13",
      title: "Set environment from ⌘K: the rail dot and the word tag",
      async run({ app }) {
        await savePostgres(app);
        await connect(app, "e2e-pg");
        await palette(app, "set environment production", { item: "cmd:env:prd" });
        await toast(app, /Marked/);
        await app.until(`__e2e.texts('[data-testid="env-tag"]').includes("prd")`, { what: "a prd tag" });
        const tags = await app.texts('[data-testid="env-tag"]');
        const rail = await app.eval(`return document.querySelector('[data-testid="rail-tile"][data-on]')?.dataset.env ?? null;`);
        assert.equal(rail, "prd", `the rail dot: ${rail}`);
        await palette(app, "clear environment", { item: "cmd:env:none" });
        await app.until(`!__e2e.texts('[data-testid="env-tag"]').includes("prd")`, { what: "the prd tag gone" });
        return { tags, rail };
      },
    },
    {
      id: "CON-14",
      title: "safe mode: Read-only refuses a write; Confirm writes holds it with its SQL",
      async run({ app }) {
        await savePostgres(app);
        await connect(app, "e2e-pg");
        await palette(app, "safe mode read-only", { item: "cmd:safe:read_only" });
        await toast(app, /Safe mode/);
        await run(app, "UPDATE e2e_people SET age = age WHERE id = 1;");
        await app.waitFor('[data-testid="safe-refuse"]', { timeout: 5000 });
        await palette(app, "safe mode confirm", { item: "cmd:safe:confirm" });
        await app.press("Escape", '[data-testid="sql-editor"]');
        await app.waitGone('[data-testid="safe-refuse"]').catch(() => {});
        await app.fill('[data-testid="sql-editor"]', "UPDATE e2e_people SET name = 'held' WHERE id = 2;");
        await app.press("Mod+Enter", '[data-testid="sql-editor"]');
        await app.until(`/isn't run yet/.test(window.__e2e.first('[data-testid="safe-bar"]')?.textContent ?? "")`, { timeout: 5000, what: "the UPDATE held in the safety bar" });
        assert.notEqual(psql("SELECT name FROM e2e_people WHERE id = 2"), "held", "the held write ran before confirming");
        await app.press("Mod+Shift+Enter");
        await app.until(`!window.__e2e.shown('[data-testid="safe-bar"]')`, { timeout: 5000, what: "the safety bar went" });
        await sleep(500);
        assert.equal(psql("SELECT name FROM e2e_people WHERE id = 2"), "held", "the confirmed write didn't run");
        await palette(app, "safe mode off", { item: "cmd:safe:off" });
      },
    },
    {
      id: "CON-15",
      title: "a CREATE TABLE refreshes the schema panel on its own; ⌘R refreshes by hand",
      async run({ app }) {
        await savePostgres(app);
        await connect(app, "e2e-pg");
        await run(app, "CREATE TABLE e2e_ddl_probe (id int);");
        await app.waitFor('[data-table$="e2e_ddl_probe"]', { timeout: 10_000 });
        await run(app, "DROP TABLE e2e_ddl_probe;");
        await app.waitGone('[data-table$="e2e_ddl_probe"]', { timeout: 10_000 });
        await app.menu("refresh-schema");
        await toast(app, /Schema refreshed|refresh/i, { timeout: 10_000 });
      },
    },
    {
      id: "CON-9",
      title: "Edit connection: rename it and the window reconnects",
      async run({ app }) {
        await savePostgres(app);
        await connect(app, "e2e-pg");
        await app.menu("edit-connection");
        await app.waitFor('[data-testid="nc-sheet"]');
        await app.fill(field("name"), "e2e renamed");
        await app.click("[data-save]");
        await app.waitGone('[data-testid="nc-sheet"]', { timeout: 10_000 });
        await connected(app, { name: "e2e renamed" });
        await run(app, "SELECT 1;");
      },
    },
    {
      id: "CON-10",
      title: "Delete a connection: Undo brings it back",
      async run({ app }) {
        await savePostgres(app, { id: "e2e-del", name: "to delete" });
        await connect(app, "e2e-del");
        await app.menu("edit-connection");
        await app.waitFor("[data-delete]");
        await app.click("[data-delete]");
        await app.click("[data-delete-go]");
        await toast(app, /Deleted|Removed|to delete/i);
        await app.waitFor("[data-toast-undo]");
        await app.click("[data-toast-undo]");
        await app.menu("switch-connection");
        await app.waitFor('[data-conn-id="e2e-del"]');
        await app.press("Escape");
      },
    },
    {
      id: "CON-17",
      title: "Reset the sample database",
      async run({ app }) {
        await connected(app);
        await palette(app, "reset the sample", { item: "cmd:reset-sample" });
        await toast(app, /Sample database reset/, { timeout: 10_000 });
        await connected(app);
        const meta = await run(app, "SELECT count(*) FROM sqlite_master;");
        return meta;
      },
    },
  ],
};
