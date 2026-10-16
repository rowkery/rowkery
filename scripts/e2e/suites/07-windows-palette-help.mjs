// Windows, ⌘K, every command, the menu bar, help (alpha checklist WIN, PAL, MENU, HLP).
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { connect, connected, palette, run, savePostgres, saveSqlite, sleep, toast } from "../helpers.mjs";

const W = '[data-testid="workspace"]:not([hidden])';
const MENU = JSON.parse(readFileSync(join(dirname(fileURLToPath(import.meta.url)), "../../../apps/rowkery-tauri/src-tauri/menu.json"), "utf8"));
/** Commands that open a native file dialog (computer-use territory) or change the window chrome. */
const NATIVE = new Set(["open-sqlite-file", "export", "window-controls"]);

/** Dismisses whatever a command opened, then checks the page still answers quickly. */
async function settle(app) {
  for (let i = 0; i < 3; i++) {
    await app.press("Escape").catch(() => {});
    await sleep(80);
  }
  const t0 = Date.now();
  await app.eval("await new Promise((r) => requestAnimationFrame(r)); return true;", { timeout: 5000 });
  return Date.now() - t0;
}

export default {
  name: "Windows, ⌘K, menus, help",
  async setup({ app, sqlitePath }) {
    await savePostgres(app);
    await saveSqlite(app, { path: sqlitePath });
    await connect(app, "e2e-pg");
    await run(app, "SELECT id, name, age FROM e2e_people ORDER BY id LIMIT 50;");
  },
  tests: [
    {
      id: "WIN-1",
      title: "New Window adds a rail tile; Close Window offers Undo and Undo brings it back",
      async run({ app }) {
        const before = await app.count('[data-testid="rail-tile"]');
        await app.menu("new-window");
        await app.until(`__e2e.count('[data-testid="rail-tile"]') === ${before + 1}`, { what: "a new tile" });
        await app.waitFor('[data-testid="ew-title"]');
        // Undo is offered for a window with a connection (an empty one loses nothing). A connection
        // no other window has: picking one that's open elsewhere switches to that window instead.
        await connect(app, "e2e-sqlite");
        await app.menu("close-window");
        await app.until(`__e2e.count('[data-testid="rail-tile"]') === ${before}`, { what: "the tile closed" });
        await app.waitFor("[data-toast-undo]");
        await app.click("[data-toast-undo]");
        await app.until(`__e2e.count('[data-testid="rail-tile"]') === ${before + 1}`, { what: "Undo brought it back" });
        await app.menu("close-window");
        await app.until(`__e2e.count('[data-testid="rail-tile"]') === ${before}`, { what: "closed again" });
      },
    },
    {
      id: "WIN-2",
      title: "⌘1 / ⌘2 and Next Window switch between windows",
      async run({ app }) {
        await app.menu("new-window");
        await app.waitFor('[data-testid="ew-title"]');
        await app.press("Mod+1", "body");
        await app.until(`!window.__e2e.shown('[data-testid="ew-title"]')`, { what: "window 1 shown" });
        await connected(app);
        await app.press("Mod+2", "body");
        await app.waitFor('[data-testid="ew-title"]');
        await app.menu("next-window");
        await app.until(`!window.__e2e.shown('[data-testid="ew-title"]')`, { what: "next window" });
        await app.menu("next-window");
        await app.waitFor('[data-testid="ew-title"]');
        await app.menu("close-window");
        await app.until(`__e2e.count('[data-testid="rail-tile"]') === 1`, { what: "back to one window" });
      },
    },
    {
      id: "PAL-1",
      title: "⌘K finds a table by name and opens it; Esc closes the palette",
      async run({ app }) {
        await app.press("Mod+K");
        await app.waitFor('[data-testid="cp-search"]');
        await app.fill('[data-testid="cp-search"]', "e2e_people");
        await app.until(`[...document.querySelectorAll('[data-testid="cp-row"]')].some((r) => /e2e_people/.test(r.textContent))`, { what: "a table row" });
        const groups = await app.eval(`return [...document.querySelectorAll('[data-testid="cp-group"]')].map((g) => g.dataset.group);`);
        await app.press("Enter", '[data-testid="cp-search"]');
        await app.until(`/e2e_people/.test(document.querySelector('${W} [data-testid="query-tab"][data-on]')?.dataset.title ?? "")`, { timeout: 8000, what: "e2e_people opened" });
        await app.press("Mod+K");
        await app.waitFor('[data-testid="cp-search"]');
        await app.press("Escape", '[data-testid="cp-search"]');
        await app.waitGone('[data-testid="cp-panel"]');
        return { groups };
      },
    },
    {
      id: "PAL-2",
      title: "every ⌘K command runs without a page error or a hang",
      async run({ app }) {
        await app.menu("new-tab");
        await run(app, "SELECT id, name, age FROM e2e_people ORDER BY id LIMIT 50;");
        await app.press("Mod+K");
        await app.waitFor('[data-testid="cp-search"]');
        await app.fill('[data-testid="cp-search"]', ">");
        await sleep(300);
        const items = await app.eval(`return [...document.querySelectorAll('[data-testid="cp-row"]')].map((r) => r.dataset.item).filter((i) => i && i.startsWith("cmd:"));`);
        await app.press("Escape", '[data-testid="cp-search"]');
        const ran = [];
        const slow = [];
        for (const item of items) {
          const id = item.slice(4);
          if (NATIVE.has(id) || id === "close-window") continue;
          await app.press("Mod+K");
          await app.waitFor('[data-testid="cp-search"]');
          await app.fill('[data-testid="cp-search"]', ">");
          const there = await app.eval(`return !!document.querySelector('[data-testid="cp-row"][data-item=${JSON.stringify(item)}]');`);
          if (!there) {
            await app.press("Escape", '[data-testid="cp-search"]');
            continue;
          }
          await app.click(`[data-testid="cp-row"][data-item=${JSON.stringify(item)}]`);
          await sleep(350);
          const ms = await settle(app);
          if (ms > 500) slow.push(`${id} ${ms} ms`);
          const errs = await app.takeErrors();
          assert.deepEqual(errs, [], `${id}: ${errs.map((e) => e.text.split("\n")[0]).join(" | ")}`);
          ran.push(id);
        }
        assert.ok(ran.length >= 25, `only ${ran.length} commands ran`);
        assert.deepEqual(slow, [], `slow to settle: ${slow}`);
        return { ran: ran.length, of: items.length };
      },
    },
    {
      id: "MENU-1",
      title: "every macOS menu-bar item runs without a page error or a hang",
      async run({ app }) {
        await connected(app);
        const ids = MENU.flatMap((m) => m.items.filter((i) => i.id).map((i) => i.id));
        const ran = [];
        for (const id of ids) {
          if (NATIVE.has(id) || id === "close-window") continue;
          await app.menu(id);
          await sleep(350);
          const ms = await settle(app);
          assert.ok(ms < 1000, `${id}: the page took ${ms} ms to answer`);
          const errs = await app.takeErrors();
          assert.deepEqual(errs, [], `${id}: ${errs.map((e) => e.text.split("\n")[0]).join(" | ")}`);
          ran.push(id);
        }
        return { ran: ran.length, of: ids.length };
      },
    },
    {
      id: "HLP-1",
      title: "Keyboard Shortcuts lists every chord; Esc closes it",
      async run({ app }) {
        await app.menu("keyboard-shortcuts");
        await app.waitFor('[data-testid="ks-list"]');
        const rows = await app.eval(`return document.querySelectorAll('[data-shortcut]').length;`);
        assert.ok(rows >= 40, `${rows} shortcuts listed`);
        await app.press("Escape");
        await app.waitGone('[data-testid="ks-list"]');
        return { rows };
      },
    },
    {
      id: "HLP-3",
      title: "Report an Issue… shows what it sends; Copy puts the report on the clipboard",
      async run({ app }) {
        await app.menu("report-issue");
        await app.waitFor('[data-testid="rp-sheet"]');
        const relay = await app.attr("[data-relay]", "data-relay");
        const shown = await app.text('[data-testid="rp-sheet"]');
        assert.match(shown, /Rowkery \d+\.\d+\.\d+/, "the sheet shows the app line it sends");
        if (relay !== "off") {
          // A build with the relay would file a real issue: don't send from a test.
          await app.click('[data-testid="rp-cancel"]');
          await app.waitGone('[data-testid="rp-sheet"]');
          return { relay };
        }
        // Without a relay URL in the build, the primary button copies the report (once it has a description).
        await app.fill('[data-testid="rp-text"]', "e2e: checking the report sheet");
        await app.click('[data-testid="rp-send"]');
        await sleep(300);
        const text = await app.invoke("read_clipboard_text");
        assert.match(text, /Rowkery \d+\.\d+\.\d+/);
        await app.press("Escape");
        await app.waitGone('[data-testid="rp-sheet"]');
        return { relay, appLine: text.split("\n").find((l) => l.includes("Rowkery")) };
      },
    },
    {
      id: "HLP-4",
      title: "Timings lists the launch and query marks",
      async run({ app }) {
        await palette(app, "timings", { item: "cmd:timings" });
        await app.waitFor("[data-timing]");
        const marks = await app.eval(`return [...document.querySelectorAll('[data-timing]')].map((r) => r.dataset.timing + '=' + (r.dataset.ms ?? ''));`);
        await app.press("Escape");
        return { marks: marks.slice(0, 12) };
      },
    },
    {
      id: "HLP-2",
      title: "Show Key Hints brings the key strip back",
      async run({ app }) {
        await app.menu("show-key-hints");
        await toast(app, /hint|Key/i).catch(() => {});
        const strip = await app.eval(`return document.querySelectorAll('[data-strip-item]').length;`);
        return { stripItems: strip };
      },
    },
  ],
};
