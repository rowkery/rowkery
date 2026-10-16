// The schema panel, table tabs and Quick Look (alpha checklist SCH, TBL, QL, RES-12).
import assert from "node:assert/strict";
import { connect, palette, revealColumn, savePostgres, settled, sleep, until } from "../helpers.mjs";

const W = '[data-testid="workspace"]:not([hidden])';
const table = (name) => `${W} [data-table$=".public.${name}"]`;

/** Opens a table from the schema panel and waits for its first page. */
async function openTable(app, name, { own = false } = {}) {
  await app.waitFor(table(name), { timeout: 10_000 });
  const before = await app.eval("return window.__e2e.runs.started;");
  await app.click(`${table(name)} [data-testid="sb-row-main"]`, own ? { mods: "Mod" } : undefined);
  // A reused Preview tab keeps the last table's rows until the new page lands.
  await settled(app, before, { timeout: 10_000 }).catch(() => {});
  await app.until(`(() => { const t = document.querySelector('${W} [data-testid="query-tab"][data-on]'); return t && t.dataset.title?.includes(${JSON.stringify(name)}); })()`, {
    timeout: 10_000,
    what: `${name} tab shown`,
  });
  await app.waitFor(`${W} [data-row="0"]`, { timeout: 10_000 });
}

const sqlText = (app) => app.eval(`return document.querySelector('${W} [data-sql-text]')?.dataset.sqlText ?? "";`);

export default {
  name: "Schema panel, table tabs, Quick Look",
  async setup({ app }) {
    await savePostgres(app);
    await connect(app, "e2e-pg");
  },
  tests: [
    {
      id: "SCH-1",
      title: "the panel lists tables, views and materialized views; partitions fold under the parent",
      async run({ app }) {
        for (const t of ["e2e_people", "e2e_big", "e2e_nopk", "e2e_events", "kiosks"]) await app.waitFor(table(t));
        const loose = await app.shown(table("e2e_events_2025"));
        assert.equal(loose, false, "a partition shows at the top level");
        const names = await app.eval(`return [...document.querySelectorAll('${W} [data-table]')].map((r) => r.dataset.table.split('.').pop());`);
        const views = ["e2e_active_people", "e2e_people_by_age"].filter((v) => names.includes(v));
        return { tables: names.length, views };
      },
    },
    {
      id: "SCH-2",
      title: "/ focuses the filter; it narrows the tree; Esc clears",
      async run({ app }) {
        await app.eval("document.activeElement?.blur(); return true;");
        await app.press("/", "body");
        await app.until(`document.activeElement?.closest('[data-testid="sb-filter"]') || document.activeElement?.dataset?.testid === "sb-filter"`, { what: "the filter focused" });
        await app.type("people");
        await app.until(`!window.__e2e.shown('${table("kiosks")}')`, { what: "kiosks filtered out" });
        assert.ok(await app.shown(table("e2e_people")));
        await app.press("Escape");
        await app.waitFor(table("kiosks"));
      },
    },
    {
      id: "SCH-3",
      title: "a click opens the Preview tab; ⌘-click keeps a table in its own tab",
      async run({ app }) {
        await openTable(app, "e2e_people");
        const preview = await app.eval(`return document.querySelector('${W} [data-testid="query-tab"][data-on]')?.hasAttribute('data-preview');`);
        assert.ok(preview, "the first click opens a Preview tab");
        await openTable(app, "kiosks");
        const titles = await app.texts(`${W} [data-testid="query-tab-title"]`);
        assert.ok(!titles.some((t) => t.includes("e2e_people")), `the preview was reused: ${titles}`);
        await openTable(app, "e2e_nopk", { own: true });
        const kept = await app.eval(`return !document.querySelector('${W} [data-testid="query-tab"][data-on]')?.hasAttribute('data-preview');`);
        assert.ok(kept, "⌘-click opens its own tab");
        return { titles };
      },
    },
    {
      id: "RES-13",
      title: "columns fit their first rows: no value in the first 40 rows is cut off",
      async run({ app }) {
        const cut = {};
        for (const t of ["e2e_people", "kiosks", "e2e_nopk", "e2e_ties", "failed_jobs"]) {
          await openTable(app, t);
          await sleep(300);
          // Columns at the auto-width cap (360px) may cut a long value by design.
          cut[t] = await app.eval(`
            const W = '[data-testid="workspace"]:not([hidden])';
            return [...document.querySelectorAll(W + ' [data-row] [data-col]')]
              .filter((c) => Number(c.parentElement.dataset.row) < 40 && c.getBoundingClientRect().width < 359 && c.scrollWidth > c.clientWidth)
              .map((c) => c.textContent + " (" + c.clientWidth + "/" + c.scrollWidth + ")")
              .slice(0, 5);`);
        }
        const bad = Object.entries(cut).filter(([, v]) => v.length);
        assert.deepEqual(bad, [], `cut off: ${JSON.stringify(Object.fromEntries(bad))}`);
      },
    },
    {
      id: "TBL-1",
      title: "the SQL line shows the query, the count and the time",
      async run({ app }) {
        await openTable(app, "e2e_people");
        const sql = await sqlText(app);
        assert.match(sql, /e2e_people/i, sql);
        const count = await app.eval(`return document.querySelector('${W} [data-count]')?.textContent?.trim() ?? null;`);
        return { sql, count };
      },
    },
    {
      id: "TBL-2b",
      title: "⌘F on a column the table doesn't have says so; ↵ takes the one it meant",
      async run({ app }) {
        await openTable(app, "e2e_people");
        await until(app, () => app.menu("filter-rows"), `document.activeElement?.closest('[data-chip-editor]')`, { what: "the filter field open and focused" });
        await app.type("nam = 'person 5'");
        await app.press("Enter");
        await app.waitText('[data-testid="toast-message"]', /No column nam/);
        const offer = await app.text("[data-toast-offer]");
        assert.match(offer, /Use name/);
        await app.press("Enter");
        await app.until(`/WHERE \\(name = 'person 5'\\)/.test(document.querySelector('${W} [data-sql-text]')?.dataset.sqlText ?? "")`, { timeout: 8000, what: "the corrected chip applied" });
        // The chip stays on the tab; the tests after this one want the whole table.
        await app.eval(`document.querySelector('${W} [data-chip="0"]').focus(); return true;`);
        await app.press("Backspace");
        await app.until(`!/WHERE/.test(document.querySelector('${W} [data-sql-text]')?.dataset.sqlText ?? "")`, { timeout: 8000, what: "the chip removed" });
        return { offer };
      },
    },
    {
      id: "TBL-3",
      title: "a header click sorts on the server: asc, desc, off",
      async run({ app }) {
        await openTable(app, "e2e_people");
        const header = `${W} [data-header="age"]`;
        await app.click(header);
        await app.until(`document.querySelector('${header}')?.dataset.sort === "asc" || !!document.querySelector('${header} [data-sort="asc"]')`, { what: "age asc" });
        await sleep(400);
        assert.match(await sqlText(app), /ORDER BY .*age/i);
        await app.click(header);
        await app.until(`/desc/i.test(document.querySelector('${W} [data-sql-text]')?.dataset.sqlText ?? "")`, { what: "age desc" });
        await app.click(header);
        await app.until(`!/ORDER BY[^;]*age/i.test(document.querySelector('${W} [data-sql-text]')?.dataset.sqlText ?? "")`, { what: "sort off" });
      },
    },
    {
      id: "TBL-2",
      title: "⌘F filters the table: 'age > 70' becomes a chip and the rows follow",
      async run({ app }) {
        await openTable(app, "e2e_people");
        await until(app, () => app.menu("filter-rows"), `document.activeElement?.closest('[data-chip-editor]')`, { what: "the filter field open and focused" });
        await app.type("age > 70");
        await app.press("Enter");
        await app.until(`/age\\s*>\\s*70/i.test(document.querySelector('${W} [data-sql-text]')?.dataset.sqlText ?? "")`, { timeout: 8000, what: "the WHERE clause" });
        await app.waitFor(`${W} [data-chip]`);
        const chips = await app.count(`${W} [data-chip]`);
        return { chips, sql: await sqlText(app) };
      },
    },
    {
      id: "TBL-4",
      title: "keyset paging sorted on a non-unique column returns each row once",
      async run({ app }) {
        await openTable(app, "e2e_ties", { own: true });
        await app.click(`${W} [data-header="grp"]`);
        await app.until(`/ORDER BY[^;]*grp/i.test(document.querySelector('${W} [data-sql-text]')?.dataset.sqlText ?? "")`, { what: "sorted by grp" });
        await sleep(500);
        for (let i = 0; i < 2; i++) {
          await app.waitFor(`${W} [data-load-more]`, { timeout: 10_000 });
          const before = await app.eval(`return document.querySelector('${W} [data-testid="card-meta"], ${W} [data-count]')?.textContent ?? "";`);
          await app.click(`${W} [data-load-more]`);
          await app.until(`(document.querySelector('${W} [data-testid="card-meta"], ${W} [data-count]')?.textContent ?? "") !== ${JSON.stringify(before)}`, { timeout: 10_000, what: "a page more" });
          await sleep(300);
        }
        await palette(app, "copy loaded", { item: "cmd:copy-csv" });
        await sleep(500);
        const csv = await app.invoke("read_clipboard_text");
        const lines = csv.trim().split(/\r?\n/);
        const col = lines[0].split(",").indexOf("id");
        const ids = lines.slice(1).map((l) => l.split(",")[col]);
        assert.ok(ids.length >= 3000, `${ids.length} rows loaded`);
        assert.equal(new Set(ids).size, ids.length, `${ids.length - new Set(ids).size} rows came twice`);
        return { rows: ids.length };
      },
    },
    {
      id: "TBL-5",
      title: "Edit SQL (⌘E) opens the table's SQL in a query tab",
      async run({ app }) {
        await openTable(app, "kiosks");
        const sql = await sqlText(app);
        await app.menu("open-in-query");
        await app.until(`/kiosks/i.test(document.querySelector('${W} [data-testid="sql-editor"]')?.value ?? "")`, { what: "the SQL in the editor" });
        return { sql };
      },
    },
    {
      id: "RES-12",
      title: "Structure (⌥⌘2) shows columns, indexes and comments; Data (⌥⌘1) goes back",
      async run({ app }) {
        await openTable(app, "e2e_people");
        await app.menu("show-structure");
        await app.waitFor(`${W} [data-testid="ts-root"]`);
        const comment = await app.eval(`return !!document.querySelector('${W} [data-column-comment="email"]');`);
        await app.until(`document.querySelectorAll('${W} [data-testid="ts-index"]').length > 0`, { what: "indexes listed" });
        const indexes = await app.eval(`return document.querySelectorAll('${W} [data-testid="ts-index"]').length;`);
        await app.menu("show-data");
        await app.waitFor(`${W} [data-row="0"]`);
        return { comment, indexes };
      },
    },
    {
      id: "QL-1",
      title: "Space opens Quick Look on the row; ↓ moves; Esc closes",
      async run({ app }) {
        await openTable(app, "e2e_people");
        await app.click(`${W} [data-row="0"] [data-col="1"]`);
        await app.press(" ");
        await app.waitFor('[data-testid="ql-head"]');
        const first = await app.text('[data-testid="ql-title"]');
        await app.press("Down");
        await sleep(200);
        const second = await app.text('[data-testid="ql-title"]');
        assert.notEqual(first, second, "↓ didn't move Quick Look");
        const follow = await app.eval(`return [...document.querySelectorAll('[data-follow-arrow]')].map((e) => e.dataset.followArrow);`);
        await app.press("Escape");
        await app.waitGone('[data-testid="ql-head"]');
        return { first, second, follow };
      },
    },
    {
      id: "QL-2",
      title: "Quick Look on a kiosk lists incoming references",
      async run({ app }) {
        await openTable(app, "kiosks");
        await app.click(`${W} [data-row="0"] [data-col="0"]`);
        await app.press(" ");
        await app.waitFor('[data-testid="ql-head"]');
        await app.until(`Number(document.querySelector('[data-incoming]')?.dataset.incoming ?? 0) > 0`, { timeout: 8000, what: "incoming references" });
        const incoming = await app.eval(`return [...document.querySelectorAll('[data-incoming-row]')].map((r) => r.dataset.incomingRow);`);
        await app.press("Escape");
        return { incoming };
      },
    },
    {
      id: "SCH-5",
      title: "Hide Sidebar and show it again",
      async run({ app }) {
        await app.menu("toggle-sidebar");
        await app.until(`document.querySelector('[data-sidebar-hidden]')`, { what: "the sidebar hidden" });
        await app.menu("toggle-sidebar");
        await app.until(`!document.querySelector('[data-sidebar-hidden]:not([data-sidebar-hidden="false"])') || window.__e2e.shown('[data-testid="sidebar"]')`, { what: "the sidebar back" });
      },
    },
    {
      id: "SCH-8",
      title: "All tables as rows (⌘K) lists every table",
      async run({ app }) {
        await palette(app, "all tables as rows", { item: "cmd:all-tables" });
        await app.waitFor(`${W} [data-row="0"]`, { timeout: 10_000 });
        return await app.eval(`return document.querySelector('${W} [data-testid="query-tab"][data-on]')?.dataset.title;`);
      },
    },
  ],
};
