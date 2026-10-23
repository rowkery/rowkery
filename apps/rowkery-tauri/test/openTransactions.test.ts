// A switch or a new safe mode would roll back a tab's open transaction
// (`openTransactions.ts`): the refusal's toast names the tab, and a COMMIT
// with nothing open shows the server's warning.
import { test } from "vitest";
import assert from "node:assert/strict";
import { refusalToast } from "../src/openTransactions";
import { statementOutcome } from "../src/StatementList";
import { ResultRows } from "../src/resultStore";

const titles: Record<number, string> = { 2: "Query 2", 5: "Orders" };
const title = (t: { tab_id: number }) => titles[t.tab_id];

test("nothing open, nothing in the way", () => {
  assert.equal(refusalToast([], title), null);
});

test("the toast names the tab and what to do", () => {
  assert.deepEqual(refusalToast([{ window_id: "w1", tab_id: 2 }], title), {
    message: "A transaction is open in “Query 2”",
    detail: "COMMIT or ROLLBACK it first",
  });
});

test("more tabs are counted, and a tab without a known title still reads", () => {
  const held = [
    { window_id: "w1", tab_id: 5 },
    { window_id: "w1", tab_id: 2 },
    { window_id: "w2", tab_id: 9 },
  ];
  assert.equal(refusalToast(held, title)?.message, "A transaction is open in “Orders” and 2 more tabs");
  assert.equal(
    refusalToast([{ window_id: "w1", tab_id: 9 }], title)?.message,
    "A transaction is open in a query tab",
  );
});

test("a statement that warned says so in the list of a run", () => {
  const result = (warning: string | null) => ({
    columns: [],
    rows: new ResultRows(),
    row_count: 0,
    elapsed_ms: 1,
    error: null,
    cancelled: false,
    warning,
  });
  assert.equal(statementOutcome({ result: result("there is no transaction in progress"), tableKey: null, ranSql: "COMMIT" }), "Warning");
  assert.equal(statementOutcome({ result: result(null), tableKey: null, ranSql: "COMMIT" }), "Done");
});
