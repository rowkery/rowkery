// A run whose answer never came (core stopped) says its outcome is unknown,
// never that it rolled back or wrote nothing; a refusal (nothing ran) keeps
// its plain wording. An Automatic update's restart waits for imports, SQL
// file runs and commits as well as open transactions.
import { test } from "vitest";
import assert from "node:assert/strict";
import { endedText, failedRun } from "../src/SqlFilePanel";
import { LOST_ANSWER, commitLost, importLost, isLostAnswer } from "../src/runOutcome";
import { losesNothing } from "../src/updates";

const REFUSALS = [
  "A SQL file is already running in this window.",
  "Nothing to commit",
  "Rowkery is busy; nothing was saved",
  "Read-only connection: refused",
  "Not connected",
  "An import is already running in this window",
];

test("only a lost answer counts as lost", () => {
  assert.equal(isLostAnswer(LOST_ANSWER), true);
  assert.equal(isLostAnswer(`${LOST_ANSWER} (task panicked)`), true);
  for (const refusal of REFUSALS) assert.equal(isLostAnswer(refusal), false, refusal);
});

test("a SQL file run that lost its answer doesn't claim a rollback", () => {
  const report = failedRun(LOST_ANSWER, 1200);
  assert.equal(report.rolled_back, false);
  assert.equal(report.unknown, true);
  for (const wholeFile of [true, false]) {
    const text = endedText(report, wholeFile);
    assert.equal(text.title, "Outcome unknown");
    assert.equal(text.kept, "Rowkery lost track of this run; check the tables it touches.");
    assert.doesNotMatch(text.kept, /Nothing was kept/);
  }
});

test("a refused SQL file run says it stopped and nothing was kept", () => {
  for (const refusal of REFUSALS) {
    const report = failedRun(refusal, 3);
    assert.equal(report.unknown, undefined, refusal);
    assert.equal(report.rolled_back, true);
    assert.equal(report.failed?.message, refusal);
    assert.deepEqual(endedText(report, true), { title: "Stopped on an error", kind: "failed", kept: "Nothing was kept." });
  }
});

test("a run core answered keeps its own wording", () => {
  const rolledBack = { ...failedRun("x", 0), cancelled: true };
  assert.deepEqual(endedText(rolledBack, true), { title: "Cancelled", kind: "cancelled", kept: "Nothing was kept." });
});

test("an import or a commit that lost its answer says so", () => {
  const lost = importLost("orders", LOST_ANSWER);
  assert.equal(lost.toast, "Import outcome unknown");
  assert.match(lost.message, /^Rowkery lost track of this import; check orders/);
  assert.doesNotMatch(`${lost.message} ${lost.detail}`, /nothing was written/i);
  const commit = commitLost(LOST_ANSWER);
  assert.equal(commit.message, "Rowkery lost track of this commit · check the table before Retry");
  assert.equal(commit.title, LOST_ANSWER);
});

test("an Automatic restart waits for anything a restart would cut short", () => {
  const idle = { unknown: false, transactions: 0, writes: 0, commits: 0, imports: 0, sql_files: 0 };
  assert.equal(losesNothing(idle), true);
  assert.equal(losesNothing(null), false, "not knowing counts as busy");
  for (const busy of [
    { unknown: true },
    { transactions: 1 },
    { writes: 1 },
    { commits: 1 },
    { imports: 1 },
    { sql_files: 1 },
  ]) {
    assert.equal(losesNothing({ ...idle, ...busy }), false, JSON.stringify(busy));
  }
});
