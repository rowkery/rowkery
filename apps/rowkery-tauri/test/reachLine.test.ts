import { describe, expect, it } from "vitest";
import { reachLine } from "../src/reachLine";
import type { RowChange } from "../src/api";

const t = (table: string, deleted: number, inserted = 0, updated = 0) => ({ schema: "public", table, inserted, updated, deleted });
const del: RowChange = { op: "delete", key: [{ column: "id", value: { Int: 2 } as never }] };
const upd: RowChange = { op: "update", key: [], set: [] };

describe("reachLine", () => {
  it("names one deleted row's cascades", () => {
    expect(reachLine([del], { tables: [t("kiosk_sessions", 14), t("payouts", 37)], unnamed: 0 })).toBe(
      "deleting this row also deletes 14 kiosk_sessions and 37 payouts",
    );
  });

  it("says these changes for a batch, with trigger rows and rows it can't name", () => {
    expect(reachLine([upd, del], { tables: [t("audit_log", 0, 2), t("payouts", 1)], unnamed: 3 })).toBe(
      "these changes also delete 1 payouts, add 2 rows to audit_log and change 3 rows in tables Rowkery can't name",
    );
  });

  it("keeps to one and when deletes and other rows both show", () => {
    expect(reachLine([del], { tables: [t("audit_log", 0, 1), t("kiosk_sessions", 14), t("payouts", 37)], unnamed: 0 })).toBe(
      "deleting this row also deletes 14 kiosk_sessions, 37 payouts and adds 1 row to audit_log",
    );
  });

  it("an edit that changes rows elsewhere", () => {
    expect(reachLine([upd], { tables: [t("orders", 0, 0, 1)], unnamed: 0 })).toBe("this edit also changes 1 row in orders");
  });
});
