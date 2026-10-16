import {
  COMMANDS,
  GESTURES,
  chordFor,
  commandById,
  eventMatches,
  type CommandState,
  type SheetSection,
} from "./commands";
import { KEYMAP_CHORDS, activeKeymap, type KeymapId } from "./keymaps";
import { isMacPlatform } from "./platform";
import { noteUsed } from "./usedKeys";

/**
 * One capture-phase keydown listener that sees every shortcut before the
 * window's handlers do:
 *
 * - Under a TablePlus or DataGrip keymap, a swapped chord runs its command
 *   (`rowkery:command`, like a menu pick) and goes no further, so ⌘T opens a
 *   tab rather than also a window. Its auto-repeats are swallowed too: held,
 *   the key runs its command once and never reaches the old handler.
 * - A registry chord that something handled (the event's default prevented
 *   once dispatch is over) counts as a use of that command; a command that
 *   acts in one zone (the grid's ↵, a chip's ⌫, the panel's ⌥↵) counts only
 *   when pressed there, and a gesture key (the grid's ⌘C, the panel's ↵)
 *   counts when pressed in its zone. usedKeys.ts keeps the counts for the
 *   shortcut sheet and the key strip.
 * - On macOS a menu accelerator (⌘W) never reaches the page as a keydown;
 *   the menu pick it makes counts when ⌘ is held (`noteMenuCommand`).
 *
 * Keys inside an overlay (⌘K, a picker, a sheet) are the overlay's own.
 */

let shown: CommandState | null = null;

/** The shown window's command state (Workspace, beside syncMenu). */
export function setShownState(s: CommandState) {
  shown = s;
}

const OVERLAY = '[role="dialog"], .cp-panel, .conn-popover, .grid-menu';
const GRID = ".results-grid-wrap";
const PANEL = ".sidebar";
const ZONE: Partial<Record<SheetSection, string>> = {
  Grid: GRID,
  "Schema panel": PANEL,
  Editor: ".sql-editor",
};

/**
 * Commands that act on what has focus in one zone, by the element they act
 * in. Their chord elsewhere is another command's or nothing (↵ on a chip
 * edits the chip, not a cell). Window-wide keys (⌘S, ⌘I, ⇧⌘↵) aren't here.
 */
export const COMMAND_ZONE: Record<string, string> = {
  "copy-cells": GRID,
  "copy-cells-with-headers": GRID,
  "quick-look": GRID,
  "edit-cell": GRID,
  "set-null": GRID,
  "delete-row": GRID,
  "follow-key": GRID,
  "remove-filter": ".sql-chip",
  "insert-name": PANEL,
};

/** What a keydown is a use of. */
export type KeyUse =
  /** A keymap-swapped chord: runs its command, goes no further. */
  | { kind: "swap"; id: string }
  /** A registry chord: counts once something handled it. */
  | { kind: "command"; id: string }
  /** A gesture key in its zone: counts at once. */
  | { kind: "gesture"; id: string };

/** Where the key was pressed, as keyUse needs it (pure, for tests). */
export interface KeyPlace {
  /** Whether the target sits in an element matching `selector`. */
  within: (selector: string) => boolean;
  /** The target is a text field (input, textarea, contenteditable). */
  textField: boolean;
}

/**
 * The command or gesture a keydown stands for under the keymap: of the
 * commands on that chord that can run now, the first whose zone (if it has
 * one) holds the target; else a gesture in its zone.
 */
export function keyUse(
  e: Parameters<typeof eventMatches>[0] & { key: string },
  s: CommandState,
  place: KeyPlace,
  mac: boolean,
  keymap: KeymapId = activeKeymap(),
): KeyUse | null {
  for (const c of COMMANDS) {
    const chord = chordFor(c, keymap);
    if (!chord || !eventMatches(e, chord, mac) || !c.canRun(s)) continue;
    const zone = COMMAND_ZONE[c.id];
    if (zone && (place.textField || !place.within(zone))) continue;
    return { kind: KEYMAP_CHORDS[keymap][c.id] ? "swap" : "command", id: c.id };
  }
  // ? in the grid or a panel row opens the sheet (App.tsx); it has no chord.
  if (e.key === "?" && !place.textField && (place.within(GRID) || place.within(PANEL))) {
    return { kind: "gesture", id: "shortcuts-here" };
  }
  for (const g of GESTURES) {
    if (!g.chord || !eventMatches(e, g.chord, mac)) continue;
    const zone = ZONE[g.section];
    if (!zone || !place.within(zone)) continue;
    // The panel's ↵ is a row's, not its filter box's.
    if (g.section !== "Editor" && place.textField) continue;
    return { kind: "gesture", id: g.id };
  }
  return null;
}

function isTextField(el: Element): boolean {
  return el instanceof HTMLTextAreaElement || el instanceof HTMLInputElement || (el as HTMLElement).isContentEditable;
}

/** The last use counted from a keydown, so a menu pick it also makes isn't counted twice. */
let lastNoted: { id: string; at: number } | null = null;
function note(id: string) {
  lastNoted = { id, at: Date.now() };
  noteUsed(id);
}

/** ⌘ is held (macOS): a menu pick arriving now came from its accelerator. */
let metaHeld = false;

function onKeyDown(e: KeyboardEvent) {
  if (e.key === "Meta") metaHeld = true;
  if (!shown) return;
  const target = e.target instanceof Element ? e.target : null;
  if (target?.closest(OVERLAY)) return;
  const use = keyUse(
    e,
    shown,
    { within: (sel) => !!target?.closest(sel), textField: !!target && isTextField(target) },
    isMacPlatform(),
  );
  if (!use) return;
  if (use.kind === "swap") {
    // Held down, the repeats stop here as well: none reaches the chord's old handler.
    e.preventDefault();
    e.stopPropagation();
    if (e.repeat) return;
    note(use.id);
    window.dispatchEvent(new CustomEvent("rowkery:command", { detail: use.id }));
    return;
  }
  if (e.repeat) return;
  if (use.kind === "gesture") {
    note(use.id);
    return;
  }
  const id = use.id;
  setTimeout(() => {
    if (e.defaultPrevented) note(id);
  }, 0);
}

function onKeyUp(e: KeyboardEvent) {
  if (e.key === "Meta") metaHeld = false;
}

/**
 * A macOS menu bar pick (main.tsx). Its accelerator never reached the page
 * as a keydown, so with ⌘ held it counts as a use of the command's key; a
 * pick with the pointer doesn't.
 */
export function noteMenuCommand(id: string, held = metaHeld) {
  if (!held) return;
  const c = commandById(id);
  if (!c || !chordFor(c)?.mac.includes("Mod")) return;
  if (lastNoted?.id === id && Date.now() - lastNoted.at < 500) return;
  note(id);
}

let installed = false;

/** Starts listening (once). */
export function installKeyTracker() {
  if (installed || typeof window === "undefined") return;
  installed = true;
  window.addEventListener("keydown", onKeyDown, true);
  window.addEventListener("keyup", onKeyUp, true);
  window.addEventListener("blur", () => {
    metaHeld = false;
  });
}
