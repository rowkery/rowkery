// starAsk.ts: the GitHub star card shows after five different days of use and never after Star or ×.
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { readKey, resetPersistForTests, writeKey } from "../src/persist";
import { STAR_AFTER_DAYS, endStarAsk, noteUseDay, starAskDue } from "../src/starAsk";

const DAY = 24 * 60 * 60 * 1000;
const nextDay = () => vi.setSystemTime(Date.now() + DAY);

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date(2026, 10, 8, 10));
  resetPersistForTests();
});
afterEach(() => vi.useRealTimers());

describe("star card", () => {
  test("a fresh install never sees it, however many queries run on day one", () => {
    for (let i = 0; i < 50; i++) noteUseDay();
    expect(starAskDue()).toBe(false);
    expect(readKey("rowkery.starAsk")).toEqual({ days: 1, lastDay: "2026-11-08" });
  });

  test("shows on the fifth different day of use, not before", () => {
    for (let d = 1; d < STAR_AFTER_DAYS; d++) {
      noteUseDay();
      noteUseDay();
      expect(starAskDue()).toBe(false);
      nextDay();
    }
    noteUseDay();
    expect(starAskDue()).toBe(true);
  });

  test("days without a query don't count", () => {
    noteUseDay();
    for (let i = 0; i < 10; i++) nextDay();
    noteUseDay();
    expect(starAskDue()).toBe(false);
    expect((readKey("rowkery.starAsk") as { days: number }).days).toBe(2);
  });

  test("Star or × ends it for good", () => {
    writeKey("rowkery.starAsk", { days: STAR_AFTER_DAYS, lastDay: "2026-11-01" });
    expect(starAskDue()).toBe(true);
    endStarAsk();
    expect(starAskDue()).toBe(false);
    nextDay();
    noteUseDay();
    expect(starAskDue()).toBe(false);
    expect(readKey("rowkery.starAsk")).toMatchObject({ done: true });
  });

  test("a damaged saved value starts over instead of throwing", () => {
    writeKey("rowkery.starAsk", { days: "lots", done: "yes" });
    expect(starAskDue()).toBe(false);
    noteUseDay();
    expect(readKey("rowkery.starAsk")).toEqual({ days: 1, lastDay: "2026-11-08" });
  });
});
