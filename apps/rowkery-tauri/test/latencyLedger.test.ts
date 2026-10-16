// scripts/latency-ledger.mjs: ledger lines → budget metrics.
// @ts-nocheck -- plain .mjs module
import { expect, test } from "vitest";
import { metrics } from "../../../scripts/latency-ledger.mjs";

const w = { window: "w1", source: "webview" };
const lines = [
  { mark: "process-start", t: 0 },
  { mark: "webview-ready", t: 300 },
  { mark: "shell-painted", t: 380 },
  { mark: "socket-warm", t: 350, open_ms: 20, ...w },
  // Cold session.
  { mark: "run-sent", t: 400, tab: 1, ...w },
  { mark: "first-frame", t: 430, tab: 1, ...w },
  { mark: "all-rows", t: 430, tab: 1, rows: 1, elapsed_ms: 1, ...w },
  // Warm sessions; the second's painted mark lands before the first's.
  { mark: "run-sent", t: 500, tab: 1, ...w },
  { mark: "first-frame", t: 510, tab: 1, ...w },
  { mark: "run-sent", t: 600, tab: 1, ...w },
  { mark: "first-frame", t: 614, tab: 1, ...w },
  { mark: "first-frame-painted", t: 640, tab: 1, sent: 600, ...w },
  { mark: "first-frame-painted", t: 641, tab: 1, sent: 500, ...w },
  { mark: "browse-click", t: 700, ...w },
  { mark: "run-sent", t: 760, tab: 2, ...w },
  { mark: "first-frame", t: 770, tab: 2, ...w },
  { mark: "first-frame-painted", t: 790, tab: 2, sent: 760, ...w },
];

test("window, socket and per-query metrics", () => {
  const m = metrics(lines);
  expect(m.window_painted).toBe(380);
  expect(m.socket_warm_vs_webview_ready).toBe(50);
  expect(m.first_query_frame).toBe(30);
  // Median of the warm runs: 10, 14, 10.
  expect(m.first_frame).toBe(10);
  expect(m.queries.map((q) => q.first_frame_painted)).toEqual([null, 141, 40, 30]);
  expect(m.browse_click_to_sent).toBe(60);
  expect(m.sidebar_click_rows).toBe(90);
});

test("missing marks read as not measured", () => {
  const m = metrics([{ mark: "process-start", t: 0 }]);
  expect(m.window_painted).toBeNull();
  expect(m.first_frame).toBeNull();
  expect(m.sidebar_click_rows).toBeNull();
});

import { budgetOf, judge, judgeMetric } from "../../../scripts/lib/latency-judge.mjs";

test("a regression is 25% + 15 ms past the reference, or a budget the reference met", () => {
  // Within the slack: fine, even over budget when the reference was too.
  expect(judgeMetric(1100, 400, 1000).verdict).toBe("miss");
  expect(judgeMetric(1265, 400, 1000).verdict).toBe("miss");
  expect(judgeMetric(1266, 400, 1000).verdict).toBe("regressed");
  // The reference met the budget: missing it now is a regression.
  expect(judgeMetric(31, 30, 2).verdict).toBe("regressed");
  expect(judgeMetric(17, 30, 2).verdict).toBe("ok");
  // No reference: budget only, never a regression.
  expect(judgeMetric(900, 400, null).verdict).toBe("miss");
  expect(judgeMetric(null, 400, 10).verdict).toBe("ok");
});

test("judge covers the budgets of one source", () => {
  const budgets = {
    a: { warm_ms: 10, source: "app" },
    b: { warm_ms: 10, source: "browser" },
  };
  const rows = judge(budgets, "app", { a: 50 }, { a: 5 });
  expect(rows).toEqual([expect.objectContaining({ key: "a", value: 50, reference: 5, verdict: "regressed" })]);
});

test("remote budgets: remote_ms, or 1 RTT + 10 ms when null", () => {
  const b = { warm_ms: 50, remote_ms: null, source: "app" };
  expect(budgetOf(b)).toBe(50);
  expect(budgetOf(b, { remote: true, rttMs: 40 })).toBe(50);
  expect(budgetOf({ ...b, remote_ms: 400 }, { remote: true, rttMs: 40 })).toBe(400);
  const rows = judge({ a: b }, "app", { a: 30 }, null, { remote: true, rttMs: 5 });
  expect(rows).toEqual([expect.objectContaining({ key: "a", budget: 15, verdict: "miss" })]);
});
