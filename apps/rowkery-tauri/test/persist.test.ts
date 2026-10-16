// persist.ts: UI state in config.json, imported once from localStorage.
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

const calls: { cmd: string; args: unknown }[] = [];
let saved: unknown = null;
vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(async (cmd: string, args: unknown) => {
    calls.push({ cmd, args });
    return cmd === "load_ui_state" ? saved : null;
  }),
}));

class MemoryStorage {
  data = new Map<string, string>();
  get length() {
    return this.data.size;
  }
  key(i: number) {
    return [...this.data.keys()][i] ?? null;
  }
  getItem(k: string) {
    return this.data.get(k) ?? null;
  }
  setItem(k: string, v: string) {
    this.data.set(k, v);
  }
  removeItem(k: string) {
    this.data.delete(k);
  }
}

let storage: MemoryStorage;
beforeEach(() => {
  vi.resetModules();
  vi.useFakeTimers();
  calls.length = 0;
  saved = null;
  storage = new MemoryStorage();
  vi.stubGlobal("localStorage", storage);
  vi.stubGlobal("window", { __TAURI_INTERNALS__: {}, addEventListener: () => {} });
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("persist", () => {
  test("first launch imports the old localStorage keys and writes them to config.json", async () => {
    storage.setItem("rowkery.windows", JSON.stringify({ windows: [{ connectionId: "a", database: null }], active: 0 }));
    storage.setItem("rowkery.history.a", JSON.stringify([{ sql: "select 1", at: 1 }]));
    storage.setItem("other.key", "x");
    const p = await import("../src/persist");
    await p.initPersist();
    expect(p.readKey("rowkery.windows")).toEqual({ windows: [{ connectionId: "a", database: null }], active: 0 });
    expect(p.readKey("other.key")).toBeUndefined();
    vi.advanceTimersByTime(1000);
    const save = calls.find((c) => c.cmd === "save_ui_state");
    expect(save?.args).toEqual({
      ui: {
        version: 1,
        keys: {
          "rowkery.windows": { windows: [{ connectionId: "a", database: null }], active: 0 },
          "rowkery.history.a": [{ sql: "select 1", at: 1 }],
        },
      },
    });
  });

  test("config.json wins over localStorage once it has state", async () => {
    storage.setItem("rowkery.sidebarHidden", "1");
    saved = { version: 1, keys: { "rowkery.sidebarHidden": 0 } };
    const p = await import("../src/persist");
    await p.initPersist();
    expect(p.readKey("rowkery.sidebarHidden")).toBe(0);
    vi.advanceTimersByTime(2000);
    expect(calls.filter((c) => c.cmd === "save_ui_state")).toHaveLength(0);
  });

  test("writes gather into one save a second after the last; the mirror follows", async () => {
    const p = await import("../src/persist");
    await p.initPersist();
    for (let i = 0; i < 20; i++) p.writeKey("rowkery.windows", { n: i }); // typing
    vi.advanceTimersByTime(999);
    expect(calls.filter((c) => c.cmd === "save_ui_state")).toHaveLength(0);
    vi.advanceTimersByTime(1);
    const saves = calls.filter((c) => c.cmd === "save_ui_state");
    expect(saves).toHaveLength(1);
    expect((saves[0].args as { ui: { keys: Record<string, unknown> } }).ui.keys["rowkery.windows"]).toEqual({ n: 19 });
    expect(JSON.parse(storage.getItem("rowkery.windows")!)).toEqual({ n: 19 });
    p.writeKey("rowkery.windows", undefined);
    p.flushPersist();
    expect(storage.getItem("rowkery.windows")).toBeNull();
  });
});
