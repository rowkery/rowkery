// ⌘K scoring and grouping (`paletteIndex.ts`).
import { describe, expect, test } from "vitest";
import { availableCommands, type CommandState } from "../src/commands";
import {
  GROUP_ORDER,
  GROUP_PREFIX,
  MAX_PER_GROUP,
  idleBuild,
  item,
  matchMarks,
  parseScope,
  pastedItem,
  queryLabel,
  scoreMatch,
  searchPalette,
  sqlIdent,
  timeAgo,
  type PaletteGroup,
  type PaletteItem,
} from "../src/paletteIndex";

const tables = (...names: string[]) =>
  names.map((n) => item("tables", `t:${n}`, n, { kind: "command", id: n }));
const groups = (g: Partial<Record<PaletteGroup, PaletteItem[]>>) =>
  Object.fromEntries(GROUP_ORDER.map((k) => [k, g[k] ?? []])) as Record<PaletteGroup, PaletteItem[]>;

describe("scoreMatch", () => {
  test("whole last segment beats a longer name", () => {
    expect(scoreMatch("public.users", "users")).toBeGreaterThan(scoreMatch("public.users_old", "users"));
  });
  test("substring beats scattered characters", () => {
    expect(scoreMatch("public.failed_jobs", "fail")).toBeGreaterThan(scoreMatch("public.f_a_i_l", "fail"));
  });
  test("word-start initials match", () => {
    expect(scoreMatch("public.failed_jobs", "fj")).toBeGreaterThan(-Infinity);
    expect(matchMarks("public.failed_jobs", "fj")).toEqual([7, 14]);
  });
  test("a miss is -Infinity", () => {
    expect(scoreMatch("public.users", "zz")).toBe(-Infinity);
  });
});

describe("parseScope", () => {
  test("prefixes pick a group", () => {
    expect(parseScope("t: users")).toEqual({ scope: "tables", query: "users" });
    expect(parseScope("Q:select")).toEqual({ scope: "queries", query: "select" });
    expect(parseScope(">new tab")).toEqual({ scope: "commands", query: "new tab" });
  });
  test("no prefix searches everything", () => {
    expect(parseScope("  users ")).toEqual({ scope: null, query: "users" });
  });
});

describe("searchPalette", () => {
  test("keeps the best hits per group, best first", () => {
    const many = tables(...Array.from({ length: 20 }, (_, i) => `public.t${i}`), "public.users");
    const [sec] = searchPalette(groups({ tables: many }), "users", null, []);
    expect(sec.group).toBe("tables");
    expect(sec.hits[0].item.label).toBe("public.users");
    expect(sec.hits[0].marks).toEqual([7, 8, 9, 10, 11]);
    const all = searchPalette(groups({ tables: many }), "t", null, []);
    expect(all[0].hits).toHaveLength(MAX_PER_GROUP);
  });

  test("the group with the best hit leads", () => {
    const cmds = [item("commands", "c:new", "New query tab", { kind: "command", id: "new" })];
    const out = searchPalette(groups({ tables: tables("public.newsletters"), commands: cmds }), "new query", null, []);
    expect(out[0].group).toBe("commands");
  });

  test("empty query lists only the empty-state groups, unscored", () => {
    const out = searchPalette(groups({ tables: tables("a", "b"), queries: [] }), "", null, ["tables", "queries"]);
    expect(out.map((s) => s.group)).toEqual(["tables"]);
    expect(out[0].hits.map((h) => h.item.label)).toEqual(["a", "b"]);
  });

  test("a scope searches one group with a larger limit", () => {
    const many = tables(...Array.from({ length: 30 }, (_, i) => `public.t${i}`));
    const out = searchPalette(groups({ tables: many }), "t", "tables", []);
    expect(out).toHaveLength(1);
    expect(out[0].hits).toHaveLength(30);
  });
});

describe("helpers", () => {
  test("sqlIdent quotes only when needed", () => {
    expect(sqlIdent("users")).toBe("users");
    expect(sqlIdent("Users")).toBe('"Users"');
    expect(sqlIdent('we"ird')).toBe('"we""ird"');
  });
  test("queryLabel flattens and truncates", () => {
    expect(queryLabel("select\n  1")).toBe("select 1");
    expect(queryLabel("x".repeat(200))).toHaveLength(140);
  });
  test("timeAgo", () => {
    const now = 10_000_000;
    expect(timeAgo(now - 5_000, now)).toBe("just now");
    expect(timeAgo(now - 5 * 60_000, now)).toBe("5m ago");
    expect(timeAgo(now - 3 * 3_600_000, now)).toBe("3h ago");
  });
});

/** Every command runnable: the state that makes each `canRun` true somewhere. */
const anything: CommandState = {
  connected: true,
  busy: false,
  running: false,
  tableTab: false,
  tabCount: 2,
  hasSchema: true,
  sidebarHidden: false,
  hasConnectionId: true,
  connection: { postgres: true, environment: null, safeMode: "off" },
  windowCount: 2,
  hasResult: true,
  hasRows: true,
  hasActiveTable: true,
  resultsView: "data",
  failed: false,
  loadedRows: 10,
  moreRows: false,
  closedTabs: 1,
  historyBack: true,
  historyForward: true,
  hasSample: true,
};

const commandItems = (uses: Record<string, number> = {}) =>
  availableCommands(anything, true).map((c) =>
    item("commands", `cmd:${c.id}`, c.title, { kind: "command", id: c.id }, {
      syn: c.synonyms?.map((w) => w.toLowerCase()),
      uses: uses[c.id],
    }),
  );
const firstCommand = (q: string, uses: Record<string, number> = {}) =>
  searchPalette(groups({ commands: commandItems(uses) }), q, "commands", [])[0]?.hits[0]?.item.target;

describe("synonyms", () => {
  // docs/spec.md, Keys and learning: the words people type for a command.
  const table: [string, string][] = [
    ["help", "keyboard-shortcuts"],
    ["hotkeys", "keyboard-shortcuts"],
    ["demo", "open-sample"],
    ["tutorial", "open-sample"],
    ["reset sample", "reset-sample"],
    ["feedback", "report-issue"],
    ["bug", "report-issue"],
    ["closed", "reopen-closed-tab"],
    ["download", "export"],
    ["catalog", "all-tables"],
    ["tables as rows", "all-tables"],
    ["readonly", "change-safe-mode"],
  ];
  test.each(table)("%s finds %s", (q, id) => {
    expect(firstCommand(q)).toEqual({ kind: "command", id });
  });

  test("a synonym hit scores as a label hit and marks nothing", () => {
    const [sec] = searchPalette(groups({ commands: commandItems() }), "help", null, []);
    expect(sec.hits[0].marks).toEqual([]);
    const label = searchPalette(groups({ commands: commandItems() }), "keyboard", null, []);
    expect(label[0].hits[0].marks.length).toBeGreaterThan(0);
  });

  test("scattered letters of a synonym don't match", () => {
    const only = [item("commands", "c:x", "Zzz", { kind: "command", id: "x" }, { syn: ["hotkeys"] })];
    expect(searchPalette(groups({ commands: only }), "hks", null, [])).toEqual([]);
  });
});

describe("frequency ranking", () => {
  test("among near-ties the more used command wins", () => {
    // "copy" matches several Copy … commands about equally.
    const plain = firstCommand("copy");
    expect(plain).toEqual({ kind: "command", id: "copy-tsv" });
    expect(firstCommand("copy", { "copy-csv": 5 })).toEqual({ kind: "command", id: "copy-csv" });
  });

  test("use never lifts a clearly worse match", () => {
    expect(firstCommand("new query tab", { "new-window": 50 })).toEqual({ kind: "command", id: "new-tab" });
  });

  test("an empty query lists the eight most used first", () => {
    const out = searchPalette(groups({ commands: commandItems({ export: 3, "all-tables": 9 }) }), "", null, ["commands"]);
    expect(out[0].hits).toHaveLength(MAX_PER_GROUP);
    expect(out[0].hits.slice(0, 2).map((h) => h.item.id)).toEqual(["cmd:all-tables", "cmd:export"]);
  });
});

describe("scope prefixes and pasted rows", () => {
  test("every scoped group prints the prefix parseScope reads", () => {
    for (const g of GROUP_ORDER) {
      const p = GROUP_PREFIX[g];
      if (p) expect(parseScope(`${p}x`).scope).toBe(g);
    }
    expect(GROUP_PREFIX.connections).toBeNull();
  });

  test("a postgres URL becomes a New connection row", () => {
    const it = pastedItem("postgres://alice@db.internal:5432/wallet?sslmode=require");
    expect(it?.label).toBe("New connection from URL");
    expect(it?.detail).toBe("db.internal/wallet");
    expect(it?.target).toEqual({ kind: "connection-url", url: "postgres://alice@db.internal:5432/wallet?sslmode=require" });
    expect(pastedItem("DATABASE_URL=postgresql://db/app")?.target.kind).toBe("connection-url");
  });

  test("a SQLite path becomes an Open file row; quotes are dropped", () => {
    expect(pastedItem("~/dev/app/dev.sqlite")?.target).toEqual({ kind: "sqlite-path", path: "~/dev/app/dev.sqlite" });
    expect(pastedItem("'/tmp/My Data.db'")?.target).toEqual({ kind: "sqlite-path", path: "/tmp/My Data.db" });
    expect(pastedItem("C:\\data\\cache.sqlite3")?.target.kind).toBe("sqlite-path");
  });

  test("ordinary input is not a pasted row", () => {
    for (const q of ["users", "dev.sqlite", "t:/tmp/a.db", "host", "a=b", ""]) expect(pastedItem(q)).toBeNull();
    // Core expands only `~/` (expand_home), so `~\` would open a relative path named `~`.
    expect(pastedItem("~\\dev\\app.sqlite")).toBeNull();
  });
});

describe("idleBuild", () => {
  test("builds once, at once when asked first", () => {
    let n = 0;
    const b = idleBuild(() => ++n);
    expect(b.get()).toBe(1);
    expect(b.get()).toBe(1);
    b.cancel();
    expect(n).toBe(1);
  });
});
