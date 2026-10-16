// The penguin: the mark stays frozen, PenguinMark draws it verbatim, and the
// placement rules never show it while a query runs or beside data.
import { describe, expect, test } from "vitest";
import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  emptyWindowPose,
  failedPanelPose,
  type PenguinContext,
  type WindowConnState,
} from "../src/penguinPlacement";

const read = (rel: string) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");
const SRC = fileURLToPath(new URL("../src/", import.meta.url));

describe("the mark", () => {
  // The original drawing (2026-10-13): never redrawn, only posed.
  test("brand/rowkery-mark-no-shadow.svg is unchanged", () => {
    const sum = createHash("sha256").update(read("../brand/rowkery-mark-no-shadow.svg")).digest("hex");
    expect(sum).toBe("4cb0028dde7423daa93915d40e4d7d717c7dc560499ea36bacb7bdffbbcba72a");
  });

  const markPaths = [...read("../brand/rowkery-mark-no-shadow.svg").matchAll(/ d="([^"]+)"/g)].map((m) => m[1]);

  test("PenguinMark and rowkery-poses.svg draw the mark's path verbatim", () => {
    expect(markPaths).toHaveLength(1);
    const penguin = read("../src/PenguinMark.tsx");
    const poses = read("../brand/rowkery-poses.svg");
    for (const d of markPaths) {
      expect(penguin).toContain(`"${d}"`);
      // Once per pose.
      expect(poses.split(`d="${d}"`).length - 1).toBe(2);
    }
    expect(poses).toContain("CC0");
    expect(poses).toContain("rotate(-10 ");
  });

  test("the website draws the same path, never orange", () => {
    const text = read("../../web/components/Mark.tsx");
    for (const d of markPaths) expect(text).toContain(`"${d}"`);
    expect(text).not.toMatch(/e8602c|--accent/i);
    expect(read("../../web/components/Penguin.tsx")).toContain("<MarkPaths />");
    // The website's CSS isn't minified: spaces allowed.
    expect(read("../../web/app/globals.css")).toMatch(/\.penguin\[data-pose="tilted"\] \.penguin-body\s*\{\s*transform:\s*rotate\(-10deg\);?\s*\}/);
  });

  test("Posture only: a transform on the body, no eyes, no motion, one colour", () => {
    const css = read("../src/PenguinMark.css");
    const tsx = read("../src/PenguinMark.tsx");
    expect(css).toMatch(/\.penguin-body\s*\{[^}]*transform-box: fill-box;[^}]*transform-origin: 50% 100%;/);
    expect(css).toMatch(/\[data-pose="tilted"\] \.penguin-body\s*\{\s*transform: rotate\(-10deg\);/);
    for (const banned of [/animation\s*:/, /transition\s*:/, /@keyframes/, /--accent/, /--env/]) {
      expect(css).not.toMatch(banned);
    }
    for (const banned of [/setTimeout|setInterval|requestAnimationFrame/, /--accent|--env/]) {
      expect(tsx).not.toMatch(banned);
    }
  });
});

describe("placements", () => {
  const states: WindowConnState[] = ["idle", "connecting", "connected", "error"];
  const contexts: (PenguinContext & { heldFromEmpty: boolean; retrying: boolean })[] = [];
  for (const connectionId of [null, "c1"])
    for (const state of states)
      for (const running of [false, true])
        for (const hasData of [false, true])
          for (const heldFromEmpty of [false, true])
            for (const retrying of [false, true])
              contexts.push({ connectionId, state, running, hasData, heldFromEmpty, retrying });

  test("never while a query runs or on a surface with data", () => {
    for (const c of contexts.filter((x) => x.running || x.hasData)) {
      expect(emptyWindowPose(c), JSON.stringify(c)).toBeNull();
      expect(failedPanelPose(c), JSON.stringify(c)).toBeNull();
    }
  });

  test("pose equals state: Ready with no connection, Tilted when it failed", () => {
    for (const c of contexts.filter((x) => !x.running && !x.hasData)) {
      const empty = emptyWindowPose(c);
      const failed = failedPanelPose(c);
      expect(empty === null || empty === "ready").toBe(true);
      expect(failed === null || failed === "tilted").toBe(true);
      if (!c.connectionId) expect(empty).toBe("ready");
      if (c.connectionId && c.state === "error") expect(failed).toBe("tilted");
      // Never both on one window, and never once it is connected.
      // (A failure ends the empty window's hold, so a Retry is never held.)
      if (!(c.heldFromEmpty && c.retrying)) expect(empty && failed).toBeFalsy();
      if (c.connectionId && c.state === "connected") expect(empty ?? failed).toBeNull();
      // A connect started elsewhere (a restored window) never shows Ready.
      if (c.connectionId && !c.heldFromEmpty) expect(empty).toBeNull();
      // Loading shows the penguin only through a connect from the empty window or a Retry.
      if (c.connectionId && c.state === "connecting" && !c.retrying) expect(failed).toBeNull();
    }
  });

  // Where <PenguinMark> may be rendered at all, and how: a pose only from the
  // placement rules, and the plain mark (< 64 px) anywhere else it is allowed.
  test("PenguinMark is rendered only in its placements", () => {
    const uses: Record<string, string[]> = {};
    for (const file of readdirSync(SRC).filter((f) => f.endsWith(".tsx") && f !== "PenguinMark.tsx")) {
      const tags = [...readFileSync(SRC + file, "utf8").matchAll(/<PenguinMark\b[^>]*\/>/g)].map((m) => m[0]);
      if (tags.length) uses[file] = tags;
    }
    // Paper (2026-10-10): Connect to start and Couldn't connect share one
    // column in EmptyWindow.tsx, the penguin 64 px beside the heading.
    // The title bar's empty-window pill draws the mark.
    expect(Object.keys(uses).sort()).toEqual(["EmptyWindow.tsx", "FatalError.tsx", "TitleBar.tsx"]);
    expect(uses["EmptyWindow.tsx"]).toEqual([
      '<PenguinMark pose="ready" size={64} className="ew-penguin" />',
      '<PenguinMark pose={failedPose} size={64} className="ew-penguin-tilted" />',
    ]);
    // The empty window's pill and the crash screen draw the plain mark: no pose below 64 px.
    for (const tag of [...uses["TitleBar.tsx"], ...uses["FatalError.tsx"]]) {
      expect(Number(/size=\{(\d+)\}/.exec(tag)?.[1])).toBeLessThan(64);
    }
    // The empty window mounts only from emptyWindowPose, the panel's penguin only from failedPanelPose.
    expect(read("../src/Workspace.tsx")).toMatch(/<Presence open=\{!!emptyPose\}>\s*<EmptyWindow/);
    expect(read("../src/EmptyWindow.tsx")).toMatch(/\{failedPose && <PenguinMark pose=\{failedPose\}/);
    expect(read("../src/EmptyWindow.tsx")).toMatch(/const pose = failedPanelPose\(/);
  });
});
