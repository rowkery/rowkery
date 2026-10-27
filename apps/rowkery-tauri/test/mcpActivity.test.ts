// What ⌘K MCP activity reads from the MCP server's log (`mcpActivity.ts`):
// verdicts, per-connection counts, the window pills' recent set and masked hosts.
import { test } from "vitest";
import assert from "node:assert/strict";
import { dayLabel, dayStart, maskHost, mcpStats, mcpTagLive, recentConnections, verdictOf, type McpEntry } from "../src/mcpActivity";

const now = new Date(2026, 9, 8, 13, 10, 0).getTime();
const at = (min: number) => now - min * 60_000;
const e = (over: Partial<McpEntry>): McpEntry => ({ ts: now, tool: "query", ...over });

test("verdicts: ok, refused by a guard, flagged by explain, failed", () => {
  assert.equal(verdictOf(e({})), "ok");
  assert.equal(verdictOf(e({ verdict: "ok" })), "ok");
  assert.equal(verdictOf(e({ verdict: "Refused: the plan reads big end to end." })), "refused");
  assert.equal(verdictOf(e({ verdict: "would refuse" })), "flagged");
  assert.equal(verdictOf(e({ verdict: "relation \"nope\" does not exist" })), "error");
});

test("stats count today's calls for one connection", () => {
  const list = [
    e({ connection: "pg", ts: at(60 * 20) }), // yesterday
    e({ connection: "pg", ts: at(5), verdict: "Refused: x" }),
    e({ connection: "pg", ts: at(1) }),
    e({ connection: "other", ts: at(0) }),
  ];
  assert.deepEqual(mcpStats(list, "pg", now), { today: 2, refused: 1, last: at(1) });
  assert.deepEqual(mcpStats(list, "none", now), { today: 0, refused: 0, last: null });
});

test("recent: connections called in the last minute", () => {
  const list = [e({ connection: "old", ts: at(3) }), e({ connection: "pg", ts: at(0.5) }), e({ ts: at(0.2) })];
  assert.deepEqual([...recentConnections(list, now)], ["pg"]);
});

test("the tag's timer lives only while the newest entry is under a minute old", () => {
  assert.equal(mcpTagLive([], now), false);
  const list = [e({ connection: "pg", ts: at(3) }), e({ ts: at(0.5) })];
  assert.equal(mcpTagLive(list, now), true);
  // The tick at which it stops is the one that clears the tag.
  assert.equal(mcpTagLive(list, at(0.5) + 60_000), true);
  assert.equal(mcpTagLive(list, at(0.5) + 60_001), false);
  assert.deepEqual([...recentConnections(list, at(0.5) + 60_001)], []);
  // A new entry brings it back.
  assert.equal(mcpTagLive([...list, e({ connection: "pg", ts: now + 120_000 })], now + 120_000), true);
});

test("hosts are masked as the agent sees them", () => {
  assert.equal(maskHost("localhost"), "localhost");
  assert.equal(maskHost("10.0.12.7"), "10.0.*.*");
  assert.equal(maskHost("warehouse"), "war***");
  assert.equal(maskHost("wallet-prd.db.internal"), "wal***.db.internal");
});

test("a share counts until its time runs out", async () => {
  const { mcpShared, shareUntil } = await import("../src/mcpActivity");
  assert.equal(mcpShared({ allow_mcp: true }, now), true);
  assert.equal(mcpShared({ allow_mcp: false, mcp_until: now + 1000 }, now), false);
  assert.equal(mcpShared({ allow_mcp: true, mcp_until: now + 1000 }, now), true);
  assert.equal(mcpShared({ allow_mcp: true, mcp_until: now }, now), false);
  assert.equal(shareUntil("hour", now), now + 3_600_000);
  assert.equal(shareUntil("today", now), new Date(2026, 9, 9).getTime());
});

test("a share's duration button reads back from its end time", async () => {
  const { shareDuration, shareUntil } = await import("../src/mcpActivity");
  assert.equal(shareDuration(null), "off");
  assert.equal(shareDuration(undefined), "off");
  assert.equal(shareDuration(shareUntil("hour", now)), "hour");
  assert.equal(shareDuration(shareUntil("today", now)), "today");
});

test("Activity's day headers name today, yesterday, then the date", () => {
  const now = new Date(2026, 9, 27, 0, 30).getTime();
  assert.equal(dayLabel(new Date(2026, 9, 27, 0, 1).getTime(), now), "Today");
  assert.equal(dayLabel(new Date(2026, 9, 26, 23, 59).getTime(), now), "Yesterday");
  assert.equal(dayLabel(new Date(2026, 9, 25, 12).getTime(), now), "Sun 25 Oct");
  assert.equal(dayLabel(new Date(2025, 11, 31, 12).getTime(), now), "Wed 31 Dec 2025");
  // Across the new year, yesterday is still yesterday.
  assert.equal(dayLabel(new Date(2025, 11, 31, 23).getTime(), new Date(2026, 0, 1, 8).getTime()), "Yesterday");
  assert.equal(dayStart(new Date(2026, 9, 27, 18).getTime()), new Date(2026, 9, 27).getTime());
});
