// A run whose answer never came (the call itself failed) says its outcome
// is unknown, never that it rolled back or wrote nothing; and an Automatic
// update's restart waits for imports, SQL file runs and commits as well as
// open transactions.
import { test } from "vitest";
import assert from "node:assert/strict";
import { endedText, lostRun } from "../src/SqlFilePanel";
import { commitLost, importLost } from "../src/runOutcome";
import { losesNothing } from "../src/updates";

test("a SQL file run that lost its answer doesn't claim a rollback", () => {
  const report = lostRun("Rowkery's core stopped", 1200);
  assert.equal(report.rolled_back, false);
  assert.equal(report.unknown, true);
  for (const wholeFile of [true, false]) {
    const text = endedText(report, wholeFile);
    assert.equal(text.title, "Outcome unknown");
    assert.equal(text.kept, "Rowkery lost track of this run; check the tables it touches.");
    assert.doesNotMatch(text.kept, /Nothing was kept/);
  }
});

test("a run core answered keeps its own wording", () => {
  const rolledBack = { ...lostRun("x", 0), unknown: undefined, rolled_back: true, cancelled: true };
  assert.deepEqual(endedText(rolledBack, true), { title: "Cancelled", kind: "cancelled", kept: "Nothing was kept." });
});

test("an import or a commit that lost its answer says so", () => {
  const lost = importLost("orders", "IPC closed");
  assert.equal(lost.toast, "Import outcome unknown");
  assert.match(lost.message, /^Rowkery lost track of this import; check orders/);
  assert.doesNotMatch(`${lost.message} ${lost.detail}`, /nothing was written/i);
  assert.match(commitLost("IPC closed"), /^Rowkery lost track of this commit; check the table before Retry/);
});

test("an Automatic restart waits for anything a restart would cut short", () => {
  const idle = { transaction: false, writes: 0, commits: 0, imports: 0, sql_files: 0 };
  assert.equal(losesNothing(idle), true);
  assert.equal(losesNothing(null), false, "not knowing counts as busy");
  for (const busy of [
    { transaction: true },
    { writes: 1 },
    { commits: 1 },
    { imports: 1 },
    { sql_files: 1 },
  ]) {
    assert.equal(losesNothing({ ...idle, ...busy }), false, JSON.stringify(busy));
  }
});
