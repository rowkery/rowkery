// Phase 5 teaching: the Timings report (`timingsReport.ts`), COMMENT helpers
// (`comments.ts`) and tooltips that take their keycaps from commands.ts.
import { describe, expect, test } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { COMMANDS, MAX_TIP, commandKeys, commandTip, formatChord } from "../src/commands";
import { columnComments, firstLine } from "../src/comments";
import type { LedgerLine, QueryTiming } from "../src/timings";
import { BUDGETS, formatMs, overBudget, timingsReport, timingsText } from "../src/timingsReport";
import type { TableNode } from "../src/types";

const SRC = fileURLToPath(new URL("../src/", import.meta.url));
const BUDGETS_JSON = fileURLToPath(new URL("../../../scripts/budgets.json", import.meta.url));

describe("timingsReport", () => {
  const ledger: LedgerLine[] = [
    { mark: "process-start", t: 0 },
    { mark: "webview-ready", t: 120 },
    { mark: "socket-warm", t: 110 },
    { mark: "shell-painted", t: 412.4 },
    { mark: "palette-open", t: 900, dur: 22, commit_ms: 6.25 },
  ];
  const query: QueryTiming = {
    window: "w1",
    tab: 3,
    sql: "SELECT 1",
    runSent: 1000,
    firstFrame: 1006,
    firstFramePainted: 1009,
    allRows: 1006,
    rows: 1000,
    elapsedMs: 4,
    firstRowMs: 2,
  };

  test("rows carry the measured value and the budget; missing stages are null", () => {
    const [launch, last] = timingsReport(ledger, [query], (t) => (t === 3 ? "Query 3" : undefined), true);
    const byLabel = Object.fromEntries(launch.rows.map((r) => [r.label, r]));
    expect(byLabel["process → window painted"]).toMatchObject({ ms: 412.4, budget: 400 });
    expect(overBudget(byLabel["process → window painted"])).toBe(true);
    expect(byLabel["socket warm, after webview ready"].ms).toBe(-10);
    expect(byLabel["⌘K open (last)"].ms).toBe(6.25);
    expect(byLabel["window switch (last)"].ms).toBeNull();
    expect(overBudget(byLabel["window switch (last)"])).toBe(false);
    expect(last.title).toBe("Last query · Query 3");
    expect(last.rows.map((r) => r.ms)).toEqual([6, 9, 2, 4]);
    expect(last.rows[3].note).toBe("1,000 rows");
  });

  test("socket warm reads Rust's mark (the session ready), not when the page heard", () => {
    const page: LedgerLine[] = [
      { mark: "process-start", t: 0 },
      { mark: "webview-ready", t: 120 },
      { mark: "shell-painted", t: 412.4 },
      { mark: "socket-warm", t: 520, open_ms: 2 },
    ];
    const row = (lines: LedgerLine[]) =>
      timingsReport(lines, [query], undefined, true)[0].rows.find((r) => r.label === "socket warm, after webview ready")?.ms;
    expect(row([{ mark: "socket-warm", t: 100, source: "rust" }, ...page])).toBe(-20);
    // Without it (an older build, nothing opened at launch) the page's mark stands.
    expect(row(page)).toBe(400);
  });

  test("the palette row prints the platform's key", () => {
    const label = (mac: boolean) => timingsReport(ledger, [query], undefined, mac)[0].rows.map((r) => r.label);
    expect(label(true)).toContain("⌘K open (last)");
    expect(label(false)).toContain("Ctrl+K open (last)");
    expect(label(false).join(" ")).not.toMatch(/[⌘⌥⌃⇧]/);
  });

  test("before any query the query rows read —", () => {
    const [, last] = timingsReport([], []);
    expect(last.title).toBe("Last query");
    expect(last.rows.every((r) => r.ms === null)).toBe(true);
    expect(formatMs(null)).toBe("—");
  });

  test("Copy is one plain line per row with its budget", () => {
    const text = timingsText(timingsReport(ledger, [query]), "Timings · wallet / rowkery");
    const lines = text.split("\n");
    expect(lines[0]).toBe("Timings · wallet / rowkery");
    expect(lines).toContain("process → window painted 412 ms (budget 400, over)");
    expect(lines).toContain("run → first frame 6.0 ms (budget 50)");
    expect(lines).toContain("database 4.0 ms · 1,000 rows");
    expect(lines).toContain("window switch (last) — (budget 16)");
  });

  test("budgets are scripts/budgets.json's warm budgets", () => {
    const { budgets } = JSON.parse(readFileSync(BUDGETS_JSON, "utf8"));
    for (const [key, ms] of Object.entries(BUDGETS)) expect(budgets[key]?.warm_ms, key).toBe(ms);
  });
});

describe("comments", () => {
  test("firstLine skips blank lines and trims", () => {
    expect(firstLine("\n  Ledger of wallet movements.  \nOne row per transaction.")).toBe("Ledger of wallet movements.");
    expect(firstLine(null)).toBe("");
    expect(firstLine("  \n ")).toBe("");
  });

  test("columnComments maps only commented columns", () => {
    const table = {
      name: "t",
      columns: [
        { name: "id", type_name: "int8", nullable: false },
        { name: "wallet_id", type_name: "int8", nullable: false, comment: "The wallet." },
        { name: "note", type_name: "text", nullable: true, comment: "  " },
      ],
    } as TableNode;
    expect([...(columnComments(table) ?? [])]).toEqual([["wallet_id", "The wallet."]]);
    expect(columnComments({ name: "t", columns: [] } as unknown as TableNode)).toBeNull();
    expect(columnComments(undefined)).toBeNull();
  });
});

describe("tooltips", () => {
  test("commandTip prints the registry's chord on both platforms", () => {
    expect(commandTip("switch-connection", "Switch connection", true)).toBe("Switch connection  ⇧⌘O");
    expect(commandTip("switch-connection", "Switch connection", false)).toBe("Switch connection  Ctrl+Shift+O");
    expect(commandTip("history-back", undefined, false)).toBe("Back  Alt+←");
    expect(commandTip("report-issue", "Report", true)).toBe("Report");
    expect(commandKeys("timings", true)).toBe("");
  });

  test("every command's own tooltip fits", () => {
    for (const c of COMMANDS) {
      for (const mac of [true, false]) expect(commandTip(c.id, undefined, mac).length, c.id).toBeLessThanOrEqual(MAX_TIP);
    }
  });

  // A tooltip that prints a registry chord must get it from commandTip /
  // commandKeys, so it can't drift. Chords that mean something else locally
  // (⌘E edits the highlighted picker row; ⌘↵ saves the sheet) are listed.
  const LOCAL: Record<string, string[]> = {
    "ConnectionSwitcher.tsx": ["⌘E"],
    // ⌘↵ saves and connects in the sheet.
    "NewConnectionSheet.tsx": ["↵"],
  };
  const chords = [...new Set(COMMANDS.flatMap((c) => (c.chord ? [formatChord(c.chord, true)] : [])))].filter(
    (k) => k !== "esc" && k !== "/",
  );
  const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

  test("no tooltip hard-codes a registry chord", () => {
    const bad: string[] = [];
    for (const file of readdirSync(SRC).filter((f) => f.endsWith(".tsx"))) {
      const lines = readFileSync(SRC + file, "utf8").split("\n");
      lines.forEach((line, n) => {
        if (!/title=/.test(line) || /command(Tip|Keys)\(/.test(line)) return;
        for (const k of chords) {
          if ((LOCAL[file] ?? []).includes(k)) continue;
          if (new RegExp(`(?<![⌃⌥⇧⌘])${esc(k)}(?![\\w\\[\\]])`).test(line)) bad.push(`${file}:${n + 1} ${k}`);
        }
      });
    }
    expect(bad).toEqual([]);
  });

  test("literal tooltips stay under the limit", () => {
    const long: string[] = [];
    for (const file of readdirSync(SRC).filter((f) => f.endsWith(".tsx"))) {
      for (const m of readFileSync(SRC + file, "utf8").matchAll(/title="([^"]+)"/g)) {
        if (m[1].length > MAX_TIP) long.push(`${file}: ${m[1]}`);
      }
    }
    expect(long).toEqual([]);
  });
});
