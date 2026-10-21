// viewMemory.ts: the last table view and the map's reach per database, in config.json.
import { beforeEach, describe, expect, test } from "vitest";
import { readKey, resetPersistForTests } from "../src/persist";
import { depthKey, lastTableView, mapDepthFor, setLastTableView, setMapDepth } from "../src/viewMemory";

beforeEach(() => resetPersistForTests());

describe("viewMemory", () => {
  test("the last view is kept; Data is the default and not stored", () => {
    expect(lastTableView()).toBe("data");
    setLastTableView("structure");
    expect(lastTableView()).toBe("structure");
    expect(readKey("rowkery.tableView")).toBe("structure");
    setLastTableView("data");
    expect(readKey("rowkery.tableView")).toBeUndefined();
  });

  test("the map's reach is one per database", () => {
    const shop = depthKey("c1", "shop");
    const blog = depthKey("c1", "blog");
    expect(mapDepthFor(shop)).toBe(1);
    setMapDepth(shop, "all");
    setMapDepth(blog, 2);
    expect(mapDepthFor(shop)).toBe("all");
    expect(mapDepthFor(blog)).toBe(2);
    expect(mapDepthFor(depthKey("c2", "shop"))).toBe(1);
    setMapDepth(shop, 1);
    expect(readKey("rowkery.mapDepth")).toEqual({ [blog]: 2 });
  });

  test("bad saved values read as the defaults", () => {
    resetPersistForTests({ "rowkery.tableView": "grid", "rowkery.mapDepth": { a: 7, b: "all" } });
    expect(lastTableView()).toBe("data");
    expect(mapDepthFor("a")).toBe(1);
    expect(mapDepthFor("b")).toBe("all");
  });
});
