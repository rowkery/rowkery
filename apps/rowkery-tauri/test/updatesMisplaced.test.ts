// rowkery/reports#32: an update that can't be installed where Rowkery runs
// (the disk image, a translocated copy) says why, and a Restart that failed
// to install says so instead of doing nothing.
import { beforeEach, expect, test, vi } from "vitest";

const toasts: unknown[][] = [];
let listener: ((e: { payload: string }) => void) | null = null;
vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(async (cmd: string) =>
    cmd === "check_for_update"
      ? { status: "misplaced", version: "0.4.0", reason: "Rowkery is running from the disk image. Move it to Applications, open it from there, and try again." }
      : null,
  ),
}));
vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(async (_name: string, f: (e: { payload: string }) => void) => {
    listener = f;
    return () => {
      listener = null;
    };
  }),
}));
vi.mock("@tauri-apps/api/webviewWindow", () => ({ getCurrentWebviewWindow: () => ({ label: "main" }) }));
vi.mock("../src/notify", () => ({
  showToast: (...args: unknown[]) => toasts.push(args),
  showOfferToast: (...args: unknown[]) => toasts.push(["offer", ...args]),
}));

const { lookForUpdate, resetUpdatesForTests, updateState, watchInstallFailures } = await import("../src/updates");

beforeEach(() => {
  toasts.length = 0;
  resetUpdatesForTests();
});

test("the quiet check says once that the update can't be installed here", async () => {
  await lookForUpdate(false, () => 0);
  await lookForUpdate(false, () => 0);
  expect(toasts).toEqual([
    [
      "Rowkery 0.4.0 can't be installed here",
      "Rowkery is running from the disk image. Move it to Applications, open it from there, and try again.",
      "error",
    ],
  ]);
  expect(updateState()).toEqual({
    phase: "error",
    message: "Rowkery 0.4.0 is out. Rowkery is running from the disk image. Move it to Applications, open it from there, and try again.",
  });
});

test("a menu pick says it every time", async () => {
  await lookForUpdate(false, () => 0);
  await lookForUpdate(true, () => 0);
  expect(toasts.filter((t) => t[0] === "Rowkery 0.4.0 can't be installed here")).toHaveLength(2);
});

test("a Restart whose install failed says why", async () => {
  const stop = watchInstallFailures();
  await Promise.resolve();
  listener!({ payload: "Failed to move the new app into place" });
  expect(toasts).toEqual([["Couldn't install the update", "Failed to move the new app into place", "error"]]);
  stop();
});
