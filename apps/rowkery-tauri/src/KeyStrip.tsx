import type { CommandState } from "./commands";
import { useKeymap } from "./keymaps";
import { showKeyHints, stripItems, useFocusZone, useRetire, useStripState, type StripZone } from "./keyHints";
import { KeyboardIcon } from "./icons";
import { isMacPlatform } from "./platform";
import { useUsedKeys } from "./usedKeys";
import "./KeyStrip.css";
import { Keys } from "./Keys";

/**
 * One line of keys at the foot of a zone. The grid's and the editor's are
 * persistent (2026-10-13): 12.5 px, always there while the grid or
 * the editor is shown, at half strength until the pointer is on them. The
 * panel's shows only while the panel has focus and until it retires
 * (keyHints.ts). Once retired, the editor's
 * and the panel's strips leave a keyboard glyph in their place: a click
 * shows every zone's keys again (⌘K Show key hints does the same).
 */
export function KeyStrip({ zone, state }: { zone: StripZone; state: CommandState }) {
  useKeymap();
  const focused = useFocusZone() === zone;
  const strip = useStripState();
  const used = useUsedKeys();
  const mac = isMacPlatform();
  const items = stripItems(zone, state, mac);
  const persistent = zone === "grid" || zone === "editor";
  const retired = strip.retired.includes(zone);
  // Only the panel's strip retires; the grid's and the editor's stay.
  useRetire(zone, focused && !persistent ? items : [], used, strip);

  if (items.length === 0) return null;
  // The grid's strip belongs to a grid on screen: none before the first result.
  if (zone === "grid" && !state.hasResult) return null;
  if (persistent)
    return (
      <div className="key-strip" data-key-strip={zone} data-persistent aria-hidden>
        {items.map((i, n) => (
          <span key={i.id} className="key-strip-item" data-strip-item={i.id} data-keys={i.keys}>
            {n > 0 && <span className="key-strip-sep">·</span>}
            <kbd><Keys text={i.keys} /></kbd> {i.label}
          </span>
        ))}
      </div>
    );
  if (retired) {
    return (
      <button
        type="button"
        className="key-strip-glyph"
        data-key-strip-glyph={zone}
        aria-label="Show key hints"
        title="Show key hints"
        onClick={showKeyHints}
      >
        <KeyboardIcon size={14} />
      </button>
    );
  }
  // The panel's strip sits in the flow: until it retires its line stays
  // reserved, so focusing a row (the mousedown of a click) never shifts the
  // list under the pointer.
  if (!focused) return zone === "panel" ? <div className="key-strip" data-key-strip-slot aria-hidden /> : null;
  return (
    <div className="key-strip" data-key-strip={zone} aria-hidden>
      {items.map((i, n) => (
        <span key={i.id} className="key-strip-item" data-strip-item={i.id} data-keys={i.keys}>
          {n > 0 && <span className="key-strip-sep">·</span>}
          <kbd><Keys text={i.keys} /></kbd> {i.label}
        </span>
      ))}
    </div>
  );
}
