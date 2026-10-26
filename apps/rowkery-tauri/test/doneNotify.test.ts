import { describe, expect, it } from "vitest";
import { bannerTime, exportBanner, importBanner, proposalBanner, queryBanner, sqlFileBanner } from "../src/doneNotify";

const at = { windowId: "w1", tabId: 3 };

describe("done banners", () => {
  it("reads times short and steady", () => {
    expect(bannerTime(48_200)).toBe("48.2 s");
    expect(bannerTime(72_000)).toBe("1:12");
    expect(bannerTime(3_725_000)).toBe("1:02:05");
  });

  it("says where and how a query went, never what it ran", () => {
    expect(queryBanner({ connection: "shop-prd", tab: "Monthly revenue", ms: 48_200, rows: 37, failed: false }, at)).toEqual({
      title: "Query finished · shop-prd",
      body: "Monthly revenue · 37 rows in 48.2 s",
      target: at,
    });
    const failed = queryBanner({ connection: "shop-prd", tab: "Backfill totals", ms: 72_000, rows: null, failed: true }, at);
    expect(failed.title).toBe("Query failed · shop-prd");
    expect(failed.body).toBe("Backfill totals · stopped after 1:12");
    const all = queryBanner({ connection: "c", tab: "Q", ms: 12_000, rows: null, statements: 3, failed: true }, at);
    expect(all.body).toBe("Q · stopped at statement 3 after 12.0 s");
    expect(queryBanner({ connection: "c", tab: "Q", ms: 12_000, rows: null, plan: true, failed: false }, at).title).toBe(
      "Timed plan finished · c",
    );
  });

  it("names the table or file a job wrote", () => {
    expect(importBanner({ connection: "shop-stg", ms: 161_000, rows: 120_000, table: "orders", failed: false }, at).body).toBe(
      "120,000 rows into orders in 2:41",
    );
    expect(sqlFileBanner({ connection: "c", file: "seed.sql", ms: 30_000, statements: 1, failed: true, line: 1204 }, at).body).toBe(
      "seed.sql · stopped at line 1,204 after 30.0 s",
    );
    expect(sqlFileBanner({ connection: "c", file: "seed.sql", ms: 30_000, statements: 9, errors: 2, failed: false }, at).body).toBe(
      "seed.sql · 9 statements, 2 failed in 30.0 s",
    );
    expect(exportBanner({ connection: "c", tab: "Q", ms: 12_000, rows: 1, copy: false, file: "r.csv", failed: false }, at).body).toBe(
      "Q · 1 row to r.csv in 12.0 s",
    );
    expect(exportBanner({ connection: "c", tab: "Q", ms: 12_000, rows: 2, copy: true, failed: false }, at).title).toBe("Copy finished · c");
  });

  it("opens a proposal's review", () => {
    const b = proposalBanner({ connection: "shop-prd", client: "Claude Code", table: "orders", rows: 29, count: 1 }, "p1");
    expect(b).toEqual({
      title: "Change to review · shop-prd",
      body: "Claude Code wants to change 29 rows in orders",
      target: { proposal: "p1" },
    });
  });
});
