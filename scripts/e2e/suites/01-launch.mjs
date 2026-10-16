// Launch, first run, restore and quit (alpha checklist INS, UPD).
import assert from "node:assert/strict";
import { connected, finished, palette, run, setSql, toast } from "../helpers.mjs";

export default {
  name: "Launch and restore",
  tests: [
    {
      id: "INS-3",
      title: "first launch opens the Sample database with its first SELECT already run",
      async run({ app }) {
        await connected(app);
        const meta = await finished(app);
        assert.match(meta, /\d+ rows?/, `result header: ${meta}`);
        await app.waitFor('[data-row="0"] [data-col="0"]');
        const conn = await app.text('[data-testid="conn-chip-name"]');
        assert.match(conn, /sample/i);
        return meta;
      },
    },
    {
      id: "INS-5",
      title: "quit and relaunch bring back the tabs and their SQL",
      async run({ app, restart }) {
        await connected(app);
        await palette(app, "New query tab", { item: "cmd:new-tab" });
        await app.until(`__e2e.count('[data-testid="query-tab"][data-title]') >= 2`, { what: "a second tab" });
        await setSql(app, "SELECT 'restored' AS marker;");
        await run(app);
        // SQL is saved on blur / idle, never per keystroke.
        await app.eval("document.activeElement.blur(); return true;");
        await new Promise((r) => setTimeout(r, 1500));
        const tabs = await app.texts('[data-testid="query-tab-title"]');
        const again = await restart();
        await connected(again);
        await again.until(`__e2e.count('[data-testid="query-tab"][data-title]') === ${tabs.length}`, { what: `${tabs.length} tabs back` });
        const sql = await again.eval(`return document.querySelector('[data-testid="sql-editor"]').value;`);
        assert.match(sql, /restored/, `the shown tab's SQL after relaunch: ${sql}`);
        return { tabs };
      },
    },
    {
      id: "INS-6",
      title: "relaunch after a force quit mid-query opens cleanly",
      async run({ app, crashRestart }) {
        await connected(app);
        await setSql(app, "WITH RECURSIVE t(n) AS (SELECT 1 UNION ALL SELECT n + 1 FROM t WHERE n < 50000000) SELECT count(*) FROM t;");
        await app.press("Mod+Enter", '[data-testid="sql-editor"]');
        await app.waitFor('[data-testid="card-meta"][data-state="running"]');
        const again = await crashRestart();
        await connected(again);
        await again.waitFor('[data-testid="sql-editor"]');
      },
    },
    {
      id: "UPD-2",
      title: "Check for updates… is in ⌘K and answers (updates are off in e2e builds)",
      async run({ app }) {
        await connected(app);
        await palette(app, "check for updates", { item: "cmd:check-updates" });
        await toast(app, /doesn't update itself|up to date|Couldn't check/);
      },
    },
  ],
};
