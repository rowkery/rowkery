// Dropped connections, an interrupted commit, and a soak of random work (alpha checklist RSL).
// The soak runs E2E_SOAK_MINUTES (default 2; use 30 before a release).
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { PG, cell, connect, outcome, palette, run, savePostgres, saveSqlite, sleep } from "../helpers.mjs";

const W = '[data-testid="workspace"]:not([hidden])';
const psql = (sql) =>
  execFileSync("psql", ["-h", PG.host, "-p", String(PG.port), "-U", PG.user, "-d", PG.database, "-tAc", sql], { env: { ...process.env, PGPASSWORD: PG.password } })
    .toString()
    .trim();
/** Ends every session the app has on the e2e database, as a server restart would. */
const dropSessions = () => psql(`SELECT count(pg_terminate_backend(pid)) FROM pg_stat_activity WHERE datname = '${PG.database}' AND pid <> pg_backend_pid()`);

export default {
  name: "Resilience and soak",
  async setup({ app, sqlitePath }) {
    await savePostgres(app);
    await saveSqlite(app, { path: sqlitePath });
    await connect(app, "e2e-pg");
  },
  tests: [
    {
      id: "RSL-3",
      title: "the server drops every session: the next query reconnects or says so, and the one after works",
      async run({ app }) {
        await run(app, "SELECT 1 AS before;");
        const dropped = dropSessions();
        await sleep(300);
        const first = await run(app, "SELECT 2 AS after_drop;", { timeout: 15_000 });
        const second = await run(app, "SELECT 3 AS again;", { timeout: 15_000 });
        assert.equal(await cell(app, 0, 0), "3", `after a dropped session: first ${first}, then ${second}`);
        return { dropped, first, second };
      },
    },
    {
      id: "RSL-4",
      title: "a commit whose connection drops mid-way is reported, not retried",
      async run({ app }) {
        await app.waitFor(`${W} [data-table$=".public.e2e_people"]`);
        await app.click(`${W} [data-table$=".public.e2e_people"] [data-testid="sb-row-main"]`, { mods: "Mod" });
        await app.until(`/e2e_people/.test(document.querySelector('${W} [data-testid="query-tab"][data-on]')?.dataset.title ?? "")`, { what: "e2e_people" });
        await app.waitFor(`${W} [data-row="4"]`, { timeout: 10_000 });
        const name = await app.eval(`return [...document.querySelectorAll('${W} [data-header]')].findIndex((h) => h.dataset.header === "name");`);
        const was = psql("SELECT name FROM e2e_people WHERE id = 5");
        // Another session holds the row, so the app's UPDATE waits on its lock.
        const holder = spawn("psql", ["-h", PG.host, "-p", String(PG.port), "-U", PG.user, "-d", PG.database, "-c", "BEGIN; SELECT * FROM e2e_people WHERE id = 5 FOR UPDATE; SELECT pg_sleep(6); ROLLBACK;"], {
          env: { ...process.env, PGPASSWORD: PG.password, PGAPPNAME: "e2e-holder" },
          stdio: "ignore",
        });
        await sleep(500);
        await app.click(`${W} [data-row="4"] [data-col="${name}"]`);
        await app.press("Enter");
        await app.waitFor("[data-cell-editor]");
        await app.fill("[data-cell-editor] input, [data-cell-editor] textarea", "never committed");
        await app.press("Enter", "[data-cell-editor] input, [data-cell-editor] textarea");
        await palette(app, "commit changes", { item: "cmd:commit-edits" });
        let waiting = "0";
        for (let i = 0; i < 20 && waiting === "0"; i++) {
          await sleep(150);
          waiting = psql(`SELECT count(*) FROM pg_stat_activity WHERE datname = '${PG.database}' AND wait_event_type = 'Lock'`);
        }
        assert.notEqual(waiting, "0", "the commit never waited on the lock");
        psql(`SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = '${PG.database}' AND wait_event_type = 'Lock'`);
        await app.until(`document.querySelector('[data-edit-tray]')?.dataset.editTray === "failed"`, { timeout: 10_000, what: "the tray reports the failed commit" });
        const tray = await app.eval(`const t = document.querySelector('[data-edit-tray]'); return t ? { state: t.dataset.editTray, text: t.textContent.replace(/\\s+/g, " ").trim() } : null;`);
        await new Promise((r) => holder.on("exit", r));
        await sleep(500);
        assert.equal(psql("SELECT name FROM e2e_people WHERE id = 5"), was, "the dropped commit was applied (retried?)");
        return { tray };
      },
    },
    {
      id: "RSL-6",
      title: "soak: random work for a while without a crash, a hang, a page error or growing memory",
      async run({ app }) {
        const minutes = Number(process.env.E2E_SOAK_MINUTES ?? 2);
        const until = Date.now() + minutes * 60_000;
        const startRss = app.rssMb();
        const startWeb = app.webContentRssMb();
        const queries = [
          "SELECT * FROM e2e_people ORDER BY id;",
          "SELECT * FROM e2e_big ORDER BY id LIMIT 3000;",
          "SELECT g, md5(g::text) FROM generate_series(1, 200000) AS g;",
          "SELECT k.code, count(*) FROM kiosk_sessions s JOIN kiosks k ON k.id = s.kiosk_id GROUP BY 1 ORDER BY 2 DESC;",
          "SELECT * FROM no_such_table;",
          "SELECT pg_sleep(0.3), now();",
        ];
        const tables = ["e2e_people", "e2e_big", "kiosks", "kiosk_sessions", "e2e_nopk", "e2e_ties"];
        const pick = (a) => a[Math.floor(Math.random() * a.length)];
        const actions = {
          query: async () => {
            const before = await app.eval(`return document.querySelector('${W} [data-testid="query-tab"][data-on]')?.dataset.title ?? "";`);
            await app.menu("new-tab");
            await app.until(`(document.querySelector('${W} [data-testid="query-tab"][data-on]')?.dataset.title ?? "") !== ${JSON.stringify(before)}`, { what: "the new tab shown" });
            await run(app, pick(queries), { timeout: 20_000 });
          },
          table: async () => {
            const t = pick(tables);
            await app.click(`${W} [data-table$=".public.${t}"] [data-testid="sb-row-main"]`);
            await sleep(400);
          },
          scroll: async () => {
            await app.eval(`const wrap = document.querySelector('${W} [data-testid="results-grid-wrap"]'); if (wrap) { for (const el of [wrap, ...wrap.querySelectorAll('*')]) if (el.scrollHeight > el.clientHeight + 4) { el.scrollTop += 2000; break; } } return true;`);
          },
          quickLook: async () => {
            // The grid may be mid-render after the last action: no row is fine here.
            const ok = await app.eval(`const c = document.querySelector('${W} [data-row="0"] [data-col="0"]'); if (!c) return false; window.__e2e.click(c); return true;`);
            if (!ok) return;
            await app.press(" ");
            await sleep(200);
            await app.press("Escape");
          },
          closeTab: async () => app.menu("close-tab"),
          switchTab: async () => app.menu(pick(["next-tab", "prev-tab"])),
          palette: async () => {
            await app.press("Mod+K");
            await sleep(150);
            await app.press("Escape");
          },
          sqlite: async () => {
            await connect(app, "e2e-sqlite");
            await run(app, "SELECT * FROM notes;");
            await connect(app, "e2e-pg");
          },
        };
        const weights = ["query", "query", "table", "table", "scroll", "quickLook", "closeTab", "switchTab", "palette", "sqlite"];
        let steps = 0;
        const samples = [];
        const trail = [];
        while (Date.now() < until) {
          const name = pick(weights);
          trail.push(name);
          try {
            await actions[name]();
          } catch (e) {
            const state = await app.eval(`const m = document.querySelector('${W} [data-testid="card-meta"]'); return { tab: document.querySelector('${W} [data-testid="query-tab"][data-on]')?.dataset.title, meta: m?.textContent, state: m?.dataset.state, conn: document.querySelector('[data-testid="conn-chip-name"]')?.textContent, sql: document.querySelector('${W} [data-testid="sql-editor"]')?.value?.slice(0, 80) };`).catch(() => null);
            e.message = `${e.message} · after ${trail.slice(-8).join(" → ")} · ${JSON.stringify(state)}`;
            throw e;
          }
          await app.press("Escape").catch(() => {});
          const errs = await app.takeErrors();
          assert.deepEqual(errs, [], `after ${name}: ${errs.map((e) => e.text.split("\n")[0]).join(" | ")}`);
          steps++;
          if (steps % 20 === 0) samples.push([app.rssMb(), app.webContentRssMb()]);
        }
        const endRss = app.rssMb();
        const endWeb = app.webContentRssMb();
        const benign = await app.eval("return window.__e2e.benign;");
        // Fixed (the tab row's sliding thumb re-triggered its own observer; the grid's virtualizer
        // re-rendered with flushSync inside its observer when resized mid-scroll): it must not come back.
        assert.equal(benign.resizeObserverLoop, 0, `ResizeObserver loop notices during the soak (callbacks in that frame: ${JSON.stringify(benign.sites)})`);
        return { minutes, steps, app: [startRss, endRss], webContent: [startWeb, endWeb], samples, benign, last: await outcome(app) };
      },
    },
  ],
};
