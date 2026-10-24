// A render error stays in its region and clears on the next tab or run; a
// stray rejection toasts once, not once per failure.
import { describe, expect, test, vi } from "vitest";

vi.stubGlobal("window", new EventTarget());
vi.spyOn(console, "error").mockImplementation(() => {});
const { onToast, showUndoToast, toastStrayError, undoPending } = await import("../src/notify");
const { RenderErrorBoundary } = await import("../src/ErrorBoundary");

describe("toastStrayError", () => {
  test("one toast, then quiet for a while", () => {
    const seen: string[] = [];
    const off = onToast((t) => seen.push(`${t.tone}: ${t.message} / ${t.detail}`));
    expect(toastStrayError(new Error("socket closed"), 1_000)).toBe(true);
    for (let i = 0; i < 50; i++) expect(toastStrayError(new Error("again"), 1_000 + i * 100)).toBe(false);
    expect(seen).toEqual(["error: Something went wrong / socket closed"]);
    expect(toastStrayError("later", 20_000)).toBe(true);
    expect(seen).toHaveLength(2);
    off();
  });

  test("never takes a live Undo off the screen", () => {
    let committed = 0;
    let undone = 0;
    showUndoToast("Deleted Orders", undefined, { undo: () => undone++, commit: () => committed++ });
    expect(toastStrayError(new Error("while undo is up"), 100_000)).toBe(false);
    expect(committed).toBe(0);
    expect(undoPending()).toBe(true);
    expect(undone).toBe(1);
    // With the Undo gone, the next one toasts (its quiet window didn't start).
    expect(toastStrayError(new Error("after"), 100_001)).toBe(true);
  });
});

describe("RenderErrorBoundary", () => {
  const props = (resetKeys: unknown[]) => ({ children: null, fallback: () => null, resetKeys });
  const caught = { error: new Error("boom"), keys: [1, "r1"] };

  test("keeps the error while the tab and run are the same", () => {
    expect(RenderErrorBoundary.getDerivedStateFromProps(props([1, "r1"]), caught)).toEqual({ keys: [1, "r1"] });
  });

  test("clears it on a new tab or a new run", () => {
    expect(RenderErrorBoundary.getDerivedStateFromProps(props([2, "r1"]), caught)).toMatchObject({ error: null });
    expect(RenderErrorBoundary.getDerivedStateFromProps(props([1, "r2"]), caught)).toMatchObject({ error: null });
  });
});
