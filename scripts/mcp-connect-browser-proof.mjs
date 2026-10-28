#!/usr/bin/env node
// Connect an agent proof with a stubbed Tauri `invoke`: ⌘K "Connect Claude
// Code or Claude Desktop" checks both clients and opens on the one with
// something to do; it shows the exact `claude mcp add` line (Claude Code) or
// the config entry (Claude Desktop) before anything runs; Copy copies it;
// Run (↵) runs it and says to start a new session / reopen Claude Desktop;
// a missing client, Rowkery already added, another copy (Replace), a failed
// run and an unreadable Desktop config each say so; the connection sheet's
// Allow MCP offers it over the sheet without closing it.
// What Run really does (shell PATH, `claude` args, the JSON merge that keeps
// other keys) is proved by `cargo test -p rowkery-tauri mcp_connect`.
//
//   cd apps/rowkery-tauri && npx vite --port 1420 &
//   node scripts/mcp-connect-browser-proof.mjs [outDir]
import { createRequire } from "node:module";
import { mkdirSync } from "node:fs";
import { execSync } from "node:child_process";

const FRAMES_SHIM = new globalThis.URL("./lib/frames-shim.js", import.meta.url).pathname;

const require = createRequire(import.meta.url);
let playwright;
try {
  playwright = require("playwright");
} catch {
  const root = execSync("npm root -g").toString().trim();
  playwright = require(`${root}/playwright`);
}

const OUT = process.argv[2] ?? "/tmp/rowkery-proof/mcp-connect";
const URL = process.env.ROWKERY_DEV_URL ?? "http://localhost:1420/";
mkdirSync(OUT, { recursive: true });

function stubTauri() {
  const EXE = "/Applications/Rowkery.app/Contents/MacOS/Rowkery";
  const ADD = `claude mcp add --scope user rowkery -- ${EXE} --mcp`;
  const FILE = "~/Library/Application Support/Claude/claude_desktop_config.json";
  const ENTRY = `"rowkery": {\n  "command": "${EXE}",\n  "args": ["--mcp"]\n}`;
  const indented = ENTRY.split("\n").map((l) => `    ${l}`).join("\n");
  const checkFor = (client, state, extra = {}) =>
    client === "claude-code"
      ? {
          client,
          state,
          preview: state === "other" ? `claude mcp remove --scope user rowkery\n${ADD}` : ADD,
          copy: ADD,
          existing: null,
          config_file: null,
          problem: null,
          ...extra,
        }
      : {
          client,
          state,
          preview: `${FILE}\n  "mcpServers": {\n${indented}\n  }`,
          copy: `{\n  "mcpServers": {\n${indented}\n  }\n}`,
          existing: null,
          config_file: FILE,
          problem: null,
          ...extra,
        };
  // The proof sets what each client reports and what a run returns.
  window.__MC__ = {
    state: { "claude-code": ["ready"], "claude-desktop": ["ready"] },
    run: { "claude-code": null, "claude-desktop": null },
  };
  const connections = [
    {
      kind: "postgres",
      id: "local",
      name: "kioskuno-wallet",
      host: "localhost",
      port: 5432,
      database: "kioskuno-wallet",
      username: "app",
      environment: "local",
      allow_mcp: true,
    },
  ];
  window.__ROWKERY_CALLS__ = [];
  window.__TAURI_INTERNALS__ = {
    metadata: { currentWindow: { label: "main" }, currentWebview: { label: "main" } },
    transformCallback: () => 0,
    invoke: async (cmd, args) => {
      window.__ROWKERY_CALLS__.push([cmd, args]);
      switch (cmd) {
        case "list_connections":
          return { connections: structuredClone(connections), active_connection_id: null };
        case "mcp_activity":
          return { entries: [], offset: 0, reset: true };
        case "mcp_connect_check": {
          await new Promise((r) => setTimeout(r, 60));
          const [state, extra] = window.__MC__.state[args.client];
          return checkFor(args.client, state, extra);
        }
        case "mcp_connect_run": {
          await new Promise((r) => setTimeout(r, 400));
          const r = window.__MC__.run[args.client];
          const [state, extra] = r.after;
          return { ok: r.ok, output: r.output, check: checkFor(args.client, state, extra) };
        }
        default:
          return null;
      }
    },
  };
}

const browser = await playwright.chromium.launch({
  executablePath: process.env.CHROMIUM_PATH ?? "/opt/pw-browsers/chromium",
});
const context = await browser.newContext({ viewport: { width: 1280, height: 800 }, deviceScaleFactor: 2 });
await context.grantPermissions(["clipboard-read", "clipboard-write"], { origin: URL });
const page = await context.newPage();
page.on("pageerror", (e) => console.error("pageerror:", e.message));
await page.addInitScript({ path: FRAMES_SHIM });
await page.addInitScript(stubTauri);
await page.goto(URL);
await page.waitForSelector('[data-testid="workspace"]:not([hidden])'); // Paper (2026-10-10): an empty window shows no connection chip (no tab row without a connection); wait for the window, then ⇧⌘O as before.

let failed = 0;
const check = (ok, what) => {
  console.log(`${ok ? "ok  " : "FAIL"} ${what}`);
  if (!ok) failed++;
};
const shot = async (name) => {
  await page.waitForTimeout(200);
  await page.screenshot({ path: `${OUT}/${name}.png` });
  console.log(`${OUT}/${name}.png`);
};
const sheet = "[data-mc-sheet]";
const stateIs = (s) => page.waitForSelector(`${sheet}[data-mc-state="${s}"]`);
const term = () => page.textContent("[data-mc-term]");
const set = (fn) => page.evaluate(fn);
const runs = () => page.evaluate(() => window.__ROWKERY_CALLS__.filter(([c]) => c === "mcp_connect_run").map(([, a]) => a.client));
const open = async () => {
  await page.keyboard.press("Control+k");
  await page.waitForSelector('[data-testid="cp-panel"]');
  await page.keyboard.type("Connect Claude");
  await page.waitForTimeout(200);
  await page.keyboard.press("Enter");
  await page.waitForSelector(sheet);
};
const close = async () => {
  await page.keyboard.press("Escape");
  await page.waitForSelector(sheet, { state: "detached" });
};

// 1. Both ready: Claude Code first, the exact command, nothing run yet.
await open();
await stateIs("ready");
check((await page.getAttribute(sheet, "data-mc-sheet")) === "claude-code", "opens on Claude Code");
check(
  (await term()) === "$ claude mcp add --scope user rowkery -- /Applications/Rowkery.app/Contents/MacOS/Rowkery --mcp",
  "shows the exact claude mcp add line",
);
check((await runs()).length === 0, "nothing runs before Run");
await page.click("[data-mc-copy]");
await page.waitForTimeout(150);
check(
  (await page.evaluate(() => navigator.clipboard.readText())).startsWith("claude mcp add --scope user rowkery -- "),
  "Copy command copies the line",
);
await shot("1-code-confirm");

// 2. Claude Code: Run, running, added.
await set(() => {
  window.__MC__.run["claude-code"] = {
    ok: true,
    output:
      "Added stdio MCP server rowkery with command: /Applications/Rowkery.app/Contents/MacOS/Rowkery --mcp to user config\nFile modified: /Users/me/.claude.json",
    after: ["connected"],
  };
});
await page.keyboard.press("Enter");
await stateIs("running");
await shot("2-code-running");
await stateIs("added");
check((await runs()).join() === "claude-code", "↵ runs it for Claude Code");
// Text on purpose: the restart note is what this feature is for.
check(/Start a new Claude Code session/.test(await page.textContent('[data-mc-note="ok"]')), "says to start a new session");
check(/Added stdio MCP server/.test(await page.textContent("[data-mc-output]")), "shows Claude Code's output");
await shot("3-code-added");

// 3. Claude Desktop tab: the config entry, Run, reopen note.
await page.click('[data-mc-client="claude-desktop"]');
await stateIs("ready");
check(/claude_desktop_config\.json[\s\S]*"mcpServers"[\s\S]*"--mcp"/.test(await term()), "Desktop shows the file and entry");
await shot("4-desktop-confirm");
await set(() => {
  window.__MC__.run["claude-desktop"] = {
    ok: true,
    output: "Added rowkery in ~/Library/Application Support/Claude/claude_desktop_config.json",
    after: ["connected"],
  };
});
await page.click('[data-mc-primary="run"]');
await stateIs("added");
check((await runs()).at(-1) === "claude-desktop", "Run writes Claude Desktop's config");
// Text on purpose: Claude Desktop needs a restart, not a new session.
check(/Quit Claude Desktop/.test(await page.textContent('[data-mc-note="ok"]')), "says to reopen Claude Desktop");
await shot("5-desktop-added");
await page.keyboard.press("Enter");
await page.waitForSelector(sheet, { state: "detached" });
check(true, "↵ on Done closes");

// 4. Claude Code missing, Desktop already added: opens on Desktop.
await set(() => {
  window.__MC__.state = { "claude-code": ["missing"], "claude-desktop": ["connected"] };
});
await open();
await stateIs("connected");
check((await page.getAttribute(sheet, "data-mc-sheet")) === "claude-desktop", "opens on the installed client");
await shot("6-desktop-already");
await page.click('[data-mc-client="claude-code"]');
await stateIs("missing");
check(!(await page.$('[data-mc-primary="run"]')), "no Run when Claude Code is missing");
await shot("7-code-missing");
await close();

// 5. Another copy registered: Replace; the run fails and says why.
await set(() => {
  window.__MC__.state = {
    "claude-code": ["other", { existing: "/Users/me/Downloads/Rowkery.app/Contents/MacOS/Rowkery --mcp" }],
    "claude-desktop": ["unreadable", { problem: "claude_desktop_config.json isn't valid JSON (expected value at line 3 column 5)." }],
  };
  window.__MC__.run["claude-code"] = {
    ok: false,
    output: "Error: EACCES: permission denied, open '/Users/me/.claude.json'",
    after: ["other", { existing: "/Users/me/Downloads/Rowkery.app/Contents/MacOS/Rowkery --mcp" }],
  };
});
await open();
await stateIs("other");
check(/claude mcp remove --scope user rowkery/.test(await term()), "Replace shows the remove line first");
await shot("8-code-other");
await page.keyboard.press("Enter");
await stateIs("failed");
check(/EACCES/.test(await page.textContent("[data-mc-output]")), "shows the error");
await shot("9-code-failed");
await page.click('[data-mc-client="claude-desktop"]');
await stateIs("unreadable");
check(!(await page.$('[data-mc-primary="run"]')), "never offers to overwrite an unreadable config");
await shot("10-desktop-unreadable");
await close();

// 5b. rowkery/reports#33: run from the disk image, Run is refused; a stored
// command that's gone says so.
const DMG = "Rowkery is running from the disk image. Move it to Applications, open it from there, and try again.";
await page.evaluate((dmg) => {
  window.__MC__.state = {
    "claude-code": ["other", { existing: "/Volumes/Rowkery/Rowkery.app/Contents/MacOS/Rowkery --mcp", problem: "That copy of Rowkery isn't there any more, so the agent can't start it." }],
    "claude-desktop": ["misplaced", { problem: dmg }],
  };
}, DMG);
await open();
await stateIs("other");
check((await page.textContent(sheet)).includes("isn't there any more"), "a stored command that's gone says so, with Replace");
await page.click('[data-mc-client="claude-desktop"]');
await stateIs("misplaced");
check((await page.textContent(sheet)).includes(DMG) && !(await page.$('[data-mc-primary="run"]')), "from the disk image: why, and no Run");
await shot("10b-desktop-misplaced");
await close();

// 6. The connection sheet offers it over itself; Esc goes back to the sheet.
await set(() => {
  window.__MC__.state = { "claude-code": ["ready"], "claude-desktop": ["ready"] };
});
await page.keyboard.press("Control+n");
await page.waitForSelector('[data-testid="nc-sheet"]');
check(!(await page.$('[data-nc-mcp="connect"]')), "no connect button while Allow MCP is off");
await page.locator("[data-mcp-switch]").scrollIntoViewIfNeeded();
await page.locator("[data-mcp-switch]").check();
await page.locator('[data-nc-mcp="connect"]').scrollIntoViewIfNeeded();
await page.screenshot({
  path: `${OUT}/11-sheet-connect-button.png`,
  clip: await page.locator('[data-testid="nc-sheet"]').boundingBox(),
});
await page.click('[data-nc-mcp="connect"]');
await stateIs("ready");
check(!!(await page.$('[data-testid="nc-sheet"]')), "the connection sheet stays open under it");
await close();
check(!!(await page.$('[data-testid="nc-sheet"]')), "Esc closes only Connect an agent");

await browser.close();
if (failed) {
  console.error(`${failed} check(s) failed`);
  process.exit(1);
}
