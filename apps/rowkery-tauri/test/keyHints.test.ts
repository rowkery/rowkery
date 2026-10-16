// The key strip: built from canRun, at most five keys (six in the editor), retiring per zone.
import { beforeEach, describe, expect, test } from "vitest";
import { COMMANDS, type CommandState } from "../src/commands";
import {
  RETIRE_AFTER,
  STRIP_ZONES,
  retireZone,
  resetKeyStripForTests,
  shouldRetire,
  showKeyHints,
  stripItems,
  stripState,
} from "../src/keyHints";
import { readKey, resetPersistForTests } from "../src/persist";
import { noteUsed, resetUsedKeysForTests, usedKeys } from "../src/usedKeys";

const base: CommandState = {
  connected: true,
  busy: false,
  running: false,
  tableTab: false,
  tabCount: 1,
  hasSchema: true,
  sidebarHidden: false,
  hasConnectionId: true,
  connection: { postgres: true, environment: null, safeMode: "off" },
  windowCount: 1,
  hasResult: true,
  hasRows: true,
  hasActiveTable: false,
  resultsView: "data",
  failed: false,
  loadedRows: 12,
  moreRows: false,
  closedTabs: 0,
  historyBack: false,
  historyForward: false,
  hasSample: true,
  hintsRetired: false,
};
const strip = (zone: (typeof STRIP_ZONES)[number], s: Partial<CommandState> = {}, mac = true) =>
  stripItems(zone, { ...base, ...s }, mac)
    .map((i) => `${i.keys} ${i.label}`)
    .join(" · ");

beforeEach(() => {
  resetPersistForTests();
  resetUsedKeysForTests();
  resetKeyStripForTests();
});

describe("what each zone shows", () => {
  test("editor, idle and running (the spec's copy)", () => {
    expect(strip("editor")).toBe("⌘↵ run · ⌘E plan · ⌃Space complete · ⌘K search · ⌘N connect · ⇧⌘/ keys");
    expect(strip("editor", { running: true })).toBe("⌘. cancel · ⌃Space complete · ⌘K search · ⌘N connect · ⇧⌘/ keys");
    expect(strip("editor", {}, false)).toBe("Ctrl+↵ run · Ctrl+E plan · Ctrl+Space complete · Ctrl+K search · Ctrl+N connect · Ctrl+Shift+/ keys");
  });

  test("grid: find on a query tab, filter on a table tab; never ↵ edit", () => {
    expect(strip("grid")).toBe("Space look · ⌘F find · ⌘C copy · ? keys");
    expect(strip("grid", { tableTab: true })).toBe("Space look · ⌘F filter · ⌘C copy · ? keys");
    expect(strip("grid", { hasRows: false })).toBe("? keys");
    for (const tableTab of [false, true]) {
      expect(strip("grid", { tableTab })).not.toMatch(/edit/);
    }
  });

  test("grid: ⌘↵ follow on a table tab's key cell only", () => {
    expect(strip("grid", { tableTab: true, cellFollowable: true })).toBe("Space look · ⌘↵ follow · ⌘F filter · ⌘C copy · ? keys");
    expect(strip("grid", { cellFollowable: true })).not.toMatch(/follow/);
  });

  test("panel", () => {
    expect(strip("panel")).toBe("/ filter · ↵ open · ⌘B hide · ? keys");
    expect(strip("panel", { hasSchema: false })).toBe("⌘B hide · ? keys");
  });

  test("never a key whose canRun is false, never more than five (six in the editor)", () => {
    const byId = new Map(COMMANDS.map((c) => [c.id, c]));
    const flags = ["connected", "busy", "running", "tableTab", "hasSchema", "hasRows", "failed"] as const;
    for (let mask = 0; mask < 1 << flags.length; mask++) {
      const s: CommandState = { ...base };
      flags.forEach((f, i) => ((s as unknown as Record<string, boolean>)[f] = !!(mask & (1 << i))));
      for (const zone of STRIP_ZONES) {
        const items = stripItems(zone, s, true);
        expect(items.length).toBeLessThanOrEqual(zone === "editor" ? 6 : 5);
        for (const i of items) {
          const c = byId.get(i.id);
          if (c) expect(c.canRun(s), `${zone} ${i.id} in ${JSON.stringify(s)}`).toBe(true);
        }
        if (!s.tableTab && zone === "grid") expect(items.map((i) => i.label)).not.toContain("edit");
      }
    }
  });
});

describe("retiring", () => {
  test("a zone retires once every key it shows was pressed three times", () => {
    const items = stripItems("panel", base, true);
    for (const i of items) for (let n = 0; n < RETIRE_AFTER - 1; n++) noteUsed(i.id);
    expect(shouldRetire(items, usedKeys(), {})).toBe(false);
    for (const i of items.slice(1)) noteUsed(i.id);
    expect(shouldRetire(items, usedKeys(), {})).toBe(false);
    noteUsed(items[0].id);
    expect(shouldRetire(items, usedKeys(), {})).toBe(true);
  });

  test("retired zones persist; Show key hints brings them back and counts from now", () => {
    retireZone("editor");
    retireZone("grid");
    expect(stripState().retired).toEqual(["editor", "grid"]);
    expect(readKey("rowkery.keyStrip")).toMatchObject({ retired: ["editor", "grid"] });
    for (let n = 0; n < 3; n++) noteUsed("run");
    showKeyHints();
    expect(stripState().retired).toEqual([]);
    expect(stripState().baseline.run).toBe(3);
    const items = [{ id: "run", keys: "⌘↵", label: "run" }];
    expect(shouldRetire(items, usedKeys(), stripState().baseline)).toBe(false);
    for (let n = 0; n < 3; n++) noteUsed("run");
    expect(shouldRetire(items, usedKeys(), stripState().baseline)).toBe(true);
  });
});
