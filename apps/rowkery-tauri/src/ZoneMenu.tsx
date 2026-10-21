import { useState } from "react";
import { GridMenu } from "./GridMenu";
import { commandById, commandTitle, type CommandState } from "./commands";
import { MoreIcon } from "./icons";
import type { MenuRow } from "./contextMenus";

/** The three zones that carry a `…`: what each one lists, in order, from the registry. */
export type MenuZone = "results" | "editor" | "panel";

const ZONE_COMMANDS: Record<MenuZone, string[]> = {
  // Insert row: a table tab's way to a new row besides ⌘I (no foot button: the grid pages as it scrolls).
  results: ["insert-row", "find-results", "copy-csv", "copy-tsv", "copy-all-csv", "copy-all-tsv", "export", "clear-results", "timings"],
  editor: ["run-all", "format-sql", "cancel", "stop-all-queries", "reopen-closed-tab", "clear-results", "timings"],
  panel: ["refresh-schema", "reconnect", "edit-connection", "switch-database", "switch-connection", "all-tables", "agents"],
};

const LABEL: Record<MenuZone, string> = {
  results: "More for these results",
  editor: "More for this query",
  panel: "More for this connection",
};

/** The zone's commands that can run now, as menu rows (each prints its key). */
export function zoneRows(zone: MenuZone, state: CommandState): MenuRow[] {
  const rows: MenuRow[] = [];
  // The results zone exists once there is a result; Timings alone is not a reason for a `…` there.
  if (zone === "results" && !state.hasResult) return rows;
  for (const id of ZONE_COMMANDS[zone]) {
    const c = commandById(id);
    if (!c || !c.canRun(state)) continue;
    rows.push({ id, label: commandTitle(c, state), command: id });
  }
  return rows;
}

/**
 * One quiet `…` per zone (results head, editor foot, schema panel head)
 * that lists the zone's commands with their keys, so nothing that can run
 * here is ⌘K-only. Reads the same registry and state as ⌘K; it never
 * advertises a command that cannot run now, and goes away when none can.
 */
export function ZoneMenu({ zone, state, onRun }: { zone: MenuZone; state: CommandState; onRun: (id: string) => void }) {
  const [at, setAt] = useState<{ x: number; y: number } | null>(null);
  const rows = zoneRows(zone, state);
  if (rows.length === 0) return null;
  return (
    <>
      <button
        type="button"
        className="zone-menu-btn"
        data-testid="zone-menu"
        data-zone={zone}
        aria-label={LABEL[zone]}
        aria-haspopup="menu"
        aria-expanded={at !== null}
        title={LABEL[zone]}
        onClick={(e) => {
          const r = e.currentTarget.getBoundingClientRect();
          setAt({ x: r.right, y: r.bottom + 6 });
        }}
      >
        <MoreIcon size={14} />
      </button>
      <GridMenu name={`zone-${zone}`} label={LABEL[zone]} at={at} items={rows} onPick={onRun} onClose={() => setAt(null)} />
    </>
  );
}
