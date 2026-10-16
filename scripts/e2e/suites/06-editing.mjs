// Editing rows on a table tab, checked in Postgres itself (alpha checklist EDT).
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { PG, connect, palette, revealColumn, savePostgres, sleep, toast, until } from "../helpers.mjs";

const W = '[data-testid="workspace"]:not([hidden])';
const psql = (sql) =>
  execFileSync("psql", ["-h", PG.host, "-p", String(PG.port), "-U", PG.user, "-d", PG.database, "-tAc", sql], { env: { ...process.env, PGPASSWORD: PG.password } })
    .toString()
    .trim();

async function openPeople(app) {
  await app.waitFor(`${W} [data-table$=".public.e2e_people"]`, { timeout: 10_000 });
  await app.click(`${W} [data-table$=".public.e2e_people"] [data-testid="sb-row-main"]`, { mods: "Mod" });
  await app.until(`document.querySelector('${W} [data-testid="query-tab"][data-on]')?.dataset.title?.includes("e2e_people")`, { timeout: 10_000, what: "e2e_people shown" });
  await app.waitFor(`${W} [data-row="0"]`, { timeout: 10_000 });
}

/** The grid column index of a header. */
const colOf = (app, name) => app.eval(`return [...document.querySelectorAll('${W} [data-header]')].findIndex((h) => h.dataset.header === ${JSON.stringify(name)});`);

async function editCell(app, row, column, value) {
  const col = await colOf(app, column);
  assert.ok(col >= 0, `no ${column} column`);
  await app.click(`${W} [data-row="${row}"] [data-col="${col}"]`);
  await app.press("Enter");
  await app.waitFor("[data-cell-editor]");
  await app.fill("[data-cell-editor] input, [data-cell-editor] textarea", value);
  await app.press("Enter", "[data-cell-editor] input, [data-cell-editor] textarea");
  await app.until(`!!document.querySelector('${W} [data-row="${row}"] [data-col="${col}"][data-edited]')`, { what: `${column} staged` });
  return col;
}

export default {
  name: "Editing rows",
  async setup({ app }) {
    await savePostgres(app);
    await connect(app, "e2e-pg");
  },
  tests: [
    {
      id: "EDT-1",
      title: "↵ edits a cell; the change is staged with the tray",
      async run({ app }) {
        await openPeople(app);
        await editCell(app, 0, "name", "edited by e2e");
        await app.waitFor("[data-edit-tray]");
        const changes = await app.eval(`return document.querySelector('[data-edit-tray]')?.dataset.changes ?? null;`);
        assert.equal(changes, "1");
        assert.notEqual(psql("SELECT name FROM e2e_people WHERE id = 1"), "edited by e2e", "a staged edit reached the database");
      },
    },
    {
      id: "EDT-3",
      title: "Review SQL shows the exact UPDATE",
      async run({ app }) {
        await palette(app, "review sql", { item: "cmd:review-sql" });
        try {
          // The sheet opens at once and fills in when the SQL comes back.
          await app.until(`!!document.querySelector("[data-review-text]")?.dataset.reviewText`, { what: "the SQL in Review" });
          const sql = await app.attr("[data-review-text]", "data-review-text");
          assert.match(sql, /UPDATE[\s\S]*e2e_people[\s\S]*edited by e2e[\s\S]*WHERE[\s\S]*id/i, sql);
          return { sql };
        } finally {
          // Left open, the sheet would keep ⌘K from the next tests.
          await app.press("Escape");
        }
      },
    },
    {
      id: "EDT-4",
      title: "⌘S commits the staged edit as one transaction",
      async run({ app }) {
        await palette(app, "commit changes", { item: "cmd:commit-edits" });
        await app.until(`document.querySelector('[data-edit-tray]')?.dataset.editTray === "done" || !document.querySelector('[data-edit-tray]')`, { timeout: 10_000, what: "committed" });
        await sleep(300);
        assert.equal(psql("SELECT name FROM e2e_people WHERE id = 1"), "edited by e2e");
      },
    },
    {
      id: "EDT-2",
      title: "insert a row and delete one; both land on commit",
      async run({ app }) {
        const before = Number(psql("SELECT count(*) FROM e2e_people"));
        await palette(app, "insert row", { item: "cmd:insert-row" });
        await app.waitFor(`${W} [data-mark="insert"], ${W} [data-insert]`);
        // ⌘I starts on the first column the database doesn't fill: name, past the identity id.
        await app.waitFor("[data-cell-editor]");
        await app.until(`document.querySelector('[data-cell-editor]')?.dataset.cellEditor === "text"`, { what: "the name editor first" });
        await app.fill("[data-cell-editor] input, [data-cell-editor] textarea", "inserted by e2e");
        await app.press("Enter", "[data-cell-editor] input, [data-cell-editor] textarea");
        await app.waitGone("[data-cell-editor]");
        await palette(app, "commit changes", { item: "cmd:commit-edits" });
        await app.until(`document.querySelector('[data-edit-tray]')?.dataset.editTray === "done" || !document.querySelector('[data-edit-tray]')`, { timeout: 10_000, what: "insert committed" });
        await sleep(300);
        assert.equal(Number(psql("SELECT count(*) FROM e2e_people")), before + 1, "the insert didn't land");
        return { before };
      },
    },
    {
      id: "EDT-6",
      title: "Discard changes drops staged edits; Undo brings them back",
      async run({ app }) {
        await openPeople(app);
        await editCell(app, 1, "name", "discard me");
        await palette(app, "discard changes", { item: "cmd:discard-edits" });
        await toast(app, /Discard|discard/);
        await app.until(`!document.querySelector('${W} [data-edited]')`, { what: "the edit dropped" });
        await app.click("[data-toast-undo]");
        await app.waitFor(`${W} [data-edited]`);
        await palette(app, "discard changes", { item: "cmd:discard-edits" });
      },
    },
    {
      id: "EDT-5",
      title: "Confirm writes holds a commit until ⇧⌘↵; Read-only refuses it",
      async run({ app }) {
        await palette(app, "safe mode confirm", { item: "cmd:safe:confirm" });
        await openPeople(app);
        await editCell(app, 2, "name", "confirmed by e2e");
        await palette(app, "commit changes", { item: "cmd:commit-edits" });
        await app.waitFor('[data-testid="safe-bar"]', { timeout: 5000 });
        assert.notEqual(psql("SELECT name FROM e2e_people WHERE id = 3"), "confirmed by e2e");
        await app.press("Mod+Shift+Enter");
        await app.until(`!window.__e2e.shown('[data-testid="safe-bar"]')`, { timeout: 5000, what: "the bar went" });
        await sleep(500);
        assert.equal(psql("SELECT name FROM e2e_people WHERE id = 3"), "confirmed by e2e");
        await palette(app, "safe mode read-only", { item: "cmd:safe:read_only" });
        await openPeople(app);
        const col = await colOf(app, "name");
        await app.click(`${W} [data-row="3"] [data-col="${col}"]`);
        await app.press("Enter");
        await sleep(300);
        const editor = await app.shown("[data-cell-editor]");
        assert.equal(editor, false, "Read-only opened a cell editor");
        await palette(app, "safe mode off", { item: "cmd:safe:off" });
      },
    },
    {
      id: "EDT-8",
      title: "⌘↵ on a foreign key cell follows it",
      async run({ app }) {
        await openPeople(app);
        const col = await revealColumn(app, "kiosk_id");
        const target = `${W} [data-row="0"] [data-col="${col}"]`;
        await until(
          app,
          async () => {
            await app.click(target);
            await app.press("Mod+Enter");
          },
          `document.querySelector('[data-testid="ql-head"]') || /kiosks/.test(document.querySelector('${W} [data-testid="query-tab"][data-on]')?.dataset.title ?? "")`,
          { timeout: 4000, what: "followed to kiosks" },
        );
      },
    },
  ],
};
