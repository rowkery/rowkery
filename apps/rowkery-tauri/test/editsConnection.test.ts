// Staged edits stay with the connection they were staged on (rowkery/reports#8),
// ⌘S reviews a big or select-all delete first, and Esc spares edits meant for a run.
import { afterEach, describe, expect, test, vi } from "vitest";
import {
  bindEdits,
  commitNeedsReview,
  emptyBuffer,
  escMayDiscard,
  ESC_AFTER_RUN_MS,
  legacyEditCount,
  parkedCount,
  pruneParked,
  REVIEW_DELETES_OVER,
  savedBuffer,
  savedParked,
  stageCell,
  toggleDeletes,
  withoutCommitted,
  withoutCommittedTab,
} from "../src/editBuffer";
import {
  commitPending,
  hasPendingUndo,
  LASTING_UNDO_MS,
  onToast,
  resumeLastingUndo,
  settlePending,
  showOfferToast,
  showToast,
  showUndoToast,
  undoPending,
} from "../src/notify";

const key = (id: number) => [{ column: "id", value: { Int: id } }];
const staged = (connectionId: string) =>
  stageCell(emptyBuffer("main.main.users", connectionId), key(1), "name", { Text: "new" }, { Text: "old" });

describe("edits belong to their connection", () => {
  test("another connection's buffer is parked, and comes back on switching back", () => {
    const onStaging = staged("staging");
    const toProd = bindEdits({ edits: onStaging }, "prod");
    expect(toProd.edits).toBeUndefined();
    expect(toProd.parked).toEqual({ staging: onStaging });
    expect(toProd.parkedNow).toBe(onStaging);
    expect(toProd.same).toBe(false);
    // Still on prod: nothing moves.
    expect(bindEdits(toProd, "prod").same).toBe(true);
    const back = bindEdits(toProd, "staging");
    expect(back.edits).toBe(onStaging);
    expect(back.parked).toBeUndefined();
    expect(back.restored).toBe(onStaging);
  });

  test("each connection keeps its own buffer for the same table", () => {
    const a = staged("a");
    const b = staged("b");
    const onB = bindEdits(bindEdits({ edits: a }, "b"), "b");
    // On b, a's stays parked while b's is staged.
    const withB = { edits: b, parked: onB.parked };
    const onA = bindEdits(withB, "a");
    expect(onA.edits).toBe(a);
    expect(onA.parked).toEqual({ b });
  });

  test("a commit's leftovers never cross connections", () => {
    const sent = staged("staging");
    const other = staged("prod");
    expect(withoutCommitted(other, sent)).toBe(other);
  });

  test("a commit that ran over a switch trims the parked copy too", () => {
    const sent = staged("staging");
    // Staged while it ran: a second cell, which stays.
    const more = stageCell(sent, key(2), "name", { Text: "later" }, { Text: "was" });
    const tab = withoutCommittedTab({ parked: { staging: more, prod: staged("prod") } }, sent);
    expect(Object.keys(tab.parked ?? {}).sort()).toEqual(["prod", "staging"]);
    expect(Object.keys(tab.parked?.staging?.updates ?? {})).toHaveLength(1);
    expect(tab.parked?.prod).toEqual(staged("prod"));
    // Exactly what was sent, parked: nothing comes back on switching back.
    expect(withoutCommittedTab({ parked: { staging: sent } }, sent).parked).toBeUndefined();
    expect(withoutCommittedTab({ edits: sent }, sent).edits).toBeUndefined();
  });

  test("parked edits count as the tab's, and a deleted connection's go", () => {
    const tab = { edits: staged("a"), parked: { b: staged("b"), gone: toggleDeletes(staged("gone"), [key(5)]) } };
    expect(parkedCount(tab)).toBe(3);
    const live = new Set(["a", "b"]);
    expect(pruneParked(tab.parked, live)).toEqual({ b: staged("b") });
    expect(pruneParked({ b: staged("b") }, new Set(["a"]))).toBeUndefined();
    const all = { b: staged("b") };
    expect(pruneParked(all, live)).toBe(all);
  });

  test("a buffer saved without a connection is dropped, and counted for the toast", () => {
    const { connectionId: _old, ...legacy } = toggleDeletes(staged("x"), [key(5)]);
    const raw = JSON.parse(JSON.stringify(legacy));
    // Never bound to the window's saved connection: that was the old bug's state.
    expect(savedBuffer(raw)).toBeUndefined();
    expect(legacyEditCount(raw)).toBe(2);
    expect(legacyEditCount(JSON.parse(JSON.stringify(staged("staging"))))).toBe(0);
    expect(legacyEditCount(undefined)).toBe(0);
    expect(savedBuffer(JSON.parse(JSON.stringify(staged("staging"))))?.connectionId).toBe("staging");
    // Parked buffers come back only under their own connection's id.
    const parked = JSON.parse(JSON.stringify({ staging: staged("staging"), prod: staged("other"), junk: 3 }));
    expect(Object.keys(savedParked(parked) ?? {})).toEqual(["staging"]);
    expect(savedParked({})).toBeUndefined();
  });
});

describe("⌘S reviews a big delete first", () => {
  const withDeletes = (n: number) =>
    toggleDeletes(emptyBuffer("t", "c"), Array.from({ length: n }, (_, i) => key(i + 1)));

  test("more than 50 deletes", () => {
    expect(commitNeedsReview(withDeletes(REVIEW_DELETES_OVER), 500, REVIEW_DELETES_OVER)).toBe(false);
    expect(commitNeedsReview(withDeletes(REVIEW_DELETES_OVER + 1), 500, REVIEW_DELETES_OVER + 1)).toBe(true);
  });

  test("every loaded row marked (⌘A then ⌫)", () => {
    expect(commitNeedsReview(withDeletes(3), 3, 3)).toBe(true);
    expect(commitNeedsReview(withDeletes(3), 10, 3)).toBe(false);
    // One row of a one-row result is not a select-all.
    expect(commitNeedsReview(withDeletes(1), 1, 1)).toBe(false);
    // Edits without deletes commit as they did.
    expect(commitNeedsReview(staged("c"), 1, 0)).toBe(false);
    expect(commitNeedsReview(null, 3, 3)).toBe(false);
  });
});

describe("Esc spares edits meant for a run", () => {
  test("not while a query runs, nor just after one ended", () => {
    expect(escMayDiscard(true, null, 10_000)).toBe(false);
    expect(escMayDiscard(false, 10_000, 10_000 + ESC_AFTER_RUN_MS - 1)).toBe(false);
    expect(escMayDiscard(false, 10_000, 10_000 + ESC_AFTER_RUN_MS)).toBe(true);
    expect(escMayDiscard(false, null, 0)).toBe(true);
  });
});

describe("Discard's Undo outlasts other toasts", () => {
  // notify.ts dispatches on `window`; a bare EventTarget stands in for it.
  vi.stubGlobal("window", new EventTarget());
  vi.stubGlobal("CustomEvent", class<T> extends Event {
    detail: T;
    constructor(type: string, init: { detail: T }) {
      super(type);
      this.detail = init.detail;
    }
  });
  afterEach(() => commitPending());

  test("a plain toast or an offer leaves it pending, and its toast comes back", () => {
    const undo = vi.fn();
    showUndoToast("Discarded 3 edits", undefined, { undo, lasting: true });
    showToast("Copied");
    showOfferToast("Looks like a URL", "Connect", undefined, { run: () => {} });
    expect(hasPendingUndo()).toBe(true);
    const seen: string[] = [];
    const off = onToast((t) => seen.push(`${t.message}${t.undoable ? " · Undo" : ""}`));
    expect(resumeLastingUndo()).toBe(true);
    off();
    expect(seen).toEqual(["Discarded 3 edits · Undo"]);
    expect(undoPending()).toBe(true);
    expect(undo).toHaveBeenCalledOnce();
  });

  test("another Undo, or the next edit, ends it", () => {
    const action = { undo: vi.fn(), lasting: true };
    showUndoToast("Discarded 3 edits", undefined, action);
    showUndoToast("Closed Query 2", undefined, { undo: () => {} });
    expect(resumeLastingUndo()).toBe(false);
    showUndoToast("Discarded 1 edit", undefined, action);
    settlePending(action);
    expect(hasPendingUndo()).toBe(false);
    expect(action.undo).not.toHaveBeenCalled();
  });

  test("it ends on its own after LASTING_UNDO_MS, without undoing", () => {
    vi.useFakeTimers();
    try {
      const action = { undo: vi.fn(), commit: vi.fn(), lasting: true };
      showUndoToast("Discarded 3 edits", undefined, action);
      showToast("Copied");
      vi.advanceTimersByTime(LASTING_UNDO_MS - 1);
      expect(hasPendingUndo()).toBe(true);
      vi.advanceTimersByTime(1);
      expect(hasPendingUndo()).toBe(false);
      expect(action.commit).toHaveBeenCalledOnce();
      // Nothing left for ⌥⌘Z, nor a toast to show again.
      expect(undoPending()).toBe(false);
      expect(resumeLastingUndo()).toBe(false);
      expect(action.undo).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  test("past its limit it is final even when the timer hasn't fired", () => {
    vi.useFakeTimers();
    try {
      const action = { undo: vi.fn(), lasting: true };
      showUndoToast("Discarded 3 edits", undefined, action);
      // The clock moves on, timers don't (a throttled window).
      vi.setSystemTime(Date.now() + LASTING_UNDO_MS);
      expect(resumeLastingUndo()).toBe(false);
      expect(undoPending()).toBe(false);
      expect(action.undo).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  test("an ordinary Undo still ends at the next toast", () => {
    showUndoToast("Closed Query 2", undefined, { undo: () => {} });
    showToast("Copied");
    expect(hasPendingUndo()).toBe(false);
    expect(resumeLastingUndo()).toBe(false);
  });
});
