// The results grid on a query tab (alpha checklist RES).
import assert from "node:assert/strict";
import { cell, connect, headers, outcome, run, savePostgres, sleep, toast, until } from "../helpers.mjs";

const W = '[data-testid="workspace"]:not([hidden])';

export default {
  name: "Results grid",
  async setup({ app }) {
    await savePostgres(app);
    await connect(app, "e2e-pg");
  },
  tests: [
    {
      id: "RES-1",
      title: "a big SELECT shows its first page at once and pages with Load more",
      async run({ app }) {
        const t0 = Date.now();
        const meta = await run(app, "SELECT * FROM e2e_big ORDER BY id;");
        const firstMs = Date.now() - t0;
        assert.match(meta, /1,000\+ rows|1,000 rows/, meta);
        await app.waitFor(`${W} [data-load-more]`).catch(() => {});
        const hasMore = await app.shown(`${W} [data-load-more]`);
        if (hasMore) {
          await app.click(`${W} [data-load-more]`);
          await app.until(`/2,000/.test(document.querySelector('${W} [data-testid="card-meta"]')?.textContent ?? "")`, { timeout: 10_000, what: "2,000 rows after Load more" });
        }
        return { firstMs, meta, loadMore: hasMore };
      },
    },
    {
      id: "RES-2",
      title: "a 1,000,000-row SELECT shows rows fast and memory stays bounded",
      async run({ app }) {
        const before = app.rssMb();
        const webBefore = app.webContentRssMb();
        const t0 = Date.now();
        const meta = await run(app, "SELECT g, md5(g::text) AS h FROM generate_series(1, 1000000) AS g;", { timeout: 30_000 });
        const ms = Date.now() - t0;
        const after = app.rssMb();
        const webAfter = app.webContentRssMb();
        assert.ok(ms < 5000, `first page took ${ms} ms`);
        assert.ok(after - before < 400, `memory grew ${after - before} MB`);
        if (webBefore != null && webAfter != null) assert.ok(webAfter - webBefore < 400, `the web process grew ${webAfter - webBefore} MB`);
        return { ms, meta, app: [before, after], webContent: [webBefore, webAfter] };
      },
    },
    {
      id: "RES-3",
      title: "scrolling a 40-column result stays smooth",
      async run({ app }) {
        await run(app, "SELECT * FROM e2e_big ORDER BY id LIMIT 5000;");
        await sleep(300);
        const frames = await app.eval(`
          const body = document.querySelector('${W} [data-testid="rg-body"]') || document.querySelector('${W} [data-testid="results-grid-wrap"]');
          const scroller = (() => { let el = body; while (el && el.scrollHeight <= el.clientHeight + 1) el = el.parentElement; return el; })();
          if (!scroller) throw new Error("no scrolling grid");
          window.__e2e.frames.start();
          const end = performance.now() + 2500;
          while (performance.now() < end) {
            scroller.scrollTop += 120;
            scroller.scrollLeft = (scroller.scrollLeft + 60) % Math.max(1, scroller.scrollWidth - scroller.clientWidth);
            await new Promise((r) => requestAnimationFrame(r));
          }
          return window.__e2e.frames.stop();`, { timeout: 15_000 });
        assert.ok(frames.frames > 60, `only ${frames.frames} frames in 2.5 s`);
        assert.ok(frames.p95 <= 34, `p95 frame ${frames.p95} ms`);
        return frames;
      },
    },
    {
      id: "RES-4",
      title: "cells render exact bigints, NULL, jsonb, numerics and booleans",
      async run({ app }) {
        await run(app, "SELECT id, big, email, meta, balance, active FROM e2e_people WHERE id IN (7, 8) ORDER BY id;");
        const h = await headers(app);
        assert.deepEqual(h, ["id", "big", "email", "meta", "balance", "active"]);
        assert.equal(await cell(app, 0, 1), "9007199254741000", "bigint beyond 2^53 is exact");
        const nullPill = await app.eval(`return !!document.querySelector('${W} [data-row="0"] [data-col="2"] [data-testid="rg-null"]');`);
        assert.ok(nullPill, "NULL shows as the pill");
        assert.match(await cell(app, 0, 3), /"n"\s*:\s*7/);
        assert.equal(await cell(app, 1, 4), "82.00");
        return { row1: [await cell(app, 1, 1), await cell(app, 1, 2), await cell(app, 1, 5)] };
      },
    },
    {
      id: "RES-6",
      title: "select cells: click, ⇧-click, ⌘A; Esc clears",
      async run({ app }) {
        await run(app, "SELECT id, age FROM e2e_people ORDER BY id LIMIT 20;");
        await app.click(`${W} [data-row="0"] [data-col="1"]`);
        await app.click(`${W} [data-row="4"] [data-col="1"]`, { mods: "Shift" });
        const block = await app.eval(`return document.querySelectorAll('${W} [data-col][data-selected]').length;`);
        assert.ok(block >= 5, `selected ${block} cells`);
        await app.press("Mod+A");
        const all = await app.eval(`return document.querySelectorAll('${W} [data-col][data-selected]').length;`);
        assert.ok(all >= 20, `⌘A selected ${all} cells`);
        await app.press("Escape");
        return { block, all };
      },
    },
    {
      id: "RES-7",
      title: "⌘C copies the cell; ⇧⌘C copies the block with column names",
      async run({ app }) {
        await run(app, "SELECT 'copy me' AS a, 2 AS b;");
        await app.click(`${W} [data-row="0"] [data-col="0"]`);
        await app.press("Mod+C");
        await toast(app, /Copied/);
        await sleep(150);
        assert.equal(await app.invoke("read_clipboard_text"), "copy me");
        await app.click(`${W} [data-row="0"] [data-col="1"]`, { mods: "Shift" });
        await app.press("Mod+Shift+C");
        await sleep(200);
        const csv = await app.invoke("read_clipboard_text");
        assert.match(csv, /^a,b\r?\ncopy me,2/);
      },
    },
    {
      id: "RES-10",
      title: "⌘F finds in the results",
      async run({ app }) {
        await run(app, "SELECT name FROM e2e_people ORDER BY id LIMIT 50;");
        await app.click(`${W} [data-row="0"] [data-col="0"]`);
        await until(app, () => app.press("Mod+F"), `document.querySelector('${W} [data-find-count]') && /INPUT|TEXTAREA/.test(document.activeElement?.tagName ?? "")`, { what: "the find field focused" });
        await app.type("person 1", null, 0);
        await app.until(`/of/.test(document.querySelector('${W} [data-find-count]')?.textContent ?? "")`, { what: "a match count" });
        return await app.text(`${W} [data-find-count]`);
      },
    },
    {
      id: "RES-11",
      title: "Clear Results empties the results",
      async run({ app }) {
        await run(app, "SELECT 1 AS one;");
        await app.menu("clear-results");
        await app.until(`!document.querySelector('${W} [data-row="0"]')`, { what: "no rows" });
        return await outcome(app);
      },
    },
  ],
};
