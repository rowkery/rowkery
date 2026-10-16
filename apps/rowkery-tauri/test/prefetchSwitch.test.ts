// Hover prefetch's switch: per connection, off by default, kept in config.json.
import { beforeEach, expect, test } from "vitest";
import { readKey, resetPersistForTests } from "../src/persist";
import { prefetchOn, setPrefetch } from "../src/prefetchSwitch";

beforeEach(() => resetPersistForTests());

test("off for every connection until turned on, one connection at a time", () => {
  expect(prefetchOn("pg")).toBe(false);
  expect(prefetchOn(null)).toBe(false);
  setPrefetch("pg", true);
  expect(prefetchOn("pg")).toBe(true);
  expect(prefetchOn("other")).toBe(false);
  expect(readKey("rowkery.prefetch")).toEqual({ pg: true });
  setPrefetch("pg", false);
  expect(prefetchOn("pg")).toBe(false);
  expect(readKey("rowkery.prefetch")).toBeUndefined();
});
