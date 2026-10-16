// The Sessions tab's rows: order, the idle filter, ages and labels.
import { describe, expect, test } from "vitest";
import type { ServerSessionRow } from "../src/api";
import {
  applicationName,
  blockedChain,
  formatAge,
  sessionAge,
  shownSessions,
  whoLabel,
} from "../src/sessionRows";

const row = (pid: number, over: Partial<ServerSessionRow> = {}): ServerSessionRow => ({
  pid,
  user: "app",
  application: "api",
  client: null,
  state: "active",
  wait: null,
  xact_secs: 1,
  query_secs: 1,
  state_secs: 1,
  query: "SELECT 1",
  blocked_by: [],
  can_stop: true,
  rowkery_tag: null,
  tab: null,
  ...over,
});

describe("sessions", () => {
  test("blockers first, then waiters, then the longest running; idle hidden", () => {
    const rows = [
      row(1, { query_secs: 900 }),
      row(2, { state: "idle in transaction", xact_secs: 400 }),
      row(3, { blocked_by: [2], wait: "Lock: relation", query_secs: 5 }),
      row(4, { blocked_by: [3], wait: "Lock: relation", query_secs: 3 }),
      row(5, { state: "idle", state_secs: 9999 }),
    ];
    expect(shownSessions(rows, false).map((r) => r.pid)).toEqual([2, 3, 4, 1]);
    expect(shownSessions(rows, true).map((r) => r.pid)).toContain(5);
    expect(blockedChain(rows, 2)).toEqual([3, 4]);
  });

  test("age follows the state", () => {
    expect(sessionAge(row(1, { query_secs: 3, xact_secs: 50 }))).toBe(3);
    expect(sessionAge(row(1, { state: "idle in transaction", xact_secs: 50 }), 2)).toBe(52);
    expect(sessionAge(row(1, { state: "idle", state_secs: 7 }))).toBe(7);
    expect([0.42, 38.2, 252, 7380].map(formatAge)).toEqual(["0.4s", "38.2s", "4m 12s", "2h 03m"]);
    expect(formatAge(null)).toBe("");
  });

  test("Rowkery's tag stays out of the label", () => {
    const ours = row(1, { application: "Rowkery 0a1b2c3d", rowkery_tag: "0a1b2c3d", user: "alice" });
    expect(applicationName(ours)).toBe("Rowkery");
    expect(whoLabel(ours)).toBe("alice · Rowkery");
    expect(whoLabel(row(2, { user: null, application: "" }))).toBe("");
  });
});
