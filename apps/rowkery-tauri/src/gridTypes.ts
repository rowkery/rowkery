import type { KeyChoice } from "./CellEditor";
import type { ColumnEditor, GridCopyCell } from "./editBuffer";
import type { Column, Value } from "./types";

/** Primary and foreign key columns of the table a result came from. */
export interface KeyColumns {
  pk: ReadonlySet<string>;
  fk: ReadonlySet<string>;
  /** NOT NULL columns of the table the result reads. */
  notNull?: ReadonlySet<string>;
}

/** A loaded row's staged state: a delete mark, or its edited cells. */
export interface RowEditState {
  mark: "edit" | "delete";
  /** Edited cells by column index: the staged value and what it was. */
  cells: Map<number, { value: Value | null; was: Value | null }>;
}

/** What the inspector shows of Quick Look, and what its buttons do. */
export interface QuickLookView {
  columns: Column[];
  row: unknown[];
  /** 0-based. */
  rowIndex: number;
  rowCount: number;
  column?: string;
  edit?: RowEditState;
  prev: () => void;
  next: () => void;
  close: () => void;
  copyJson: () => void;
  /** Absent where the rows can't be edited. */
  toggleDelete?: () => void;
}

/** A cell an edit goes to: a loaded row, or a pending insert. */
export type EditTarget = { row: number } | { insert: number };

/**
 * A table tab's editing (Workspace and editBuffer.ts). Nothing here writes:
 * every call stages into the tab's buffer, and the tray commits it.
 */
export interface GridEditing {
  /** Why nothing can be edited (↵ shows it in the tray), or null when it can. */
  refusal: string | null;
  onRefused: () => void;
  /** Per result column: its editor, or null where the column isn't edited. */
  editors: (ColumnEditor | null)[];
  /** Pending inserts, newest first, as cells per result column (undefined: DEFAULT). */
  inserts: { id: number; cells: (Value | null | undefined)[] }[];
  rowState: (row: number) => RowEditState | undefined;
  /** Changes whenever the buffer does, so rows redraw their marks. */
  version: number;
  stage: (target: EditTarget, col: number, value: Value | null) => void;
  revert: (target: EditTarget, col: number) => void;
  insertRow: () => void;
  removeInsert: (id: number) => void;
  duplicate: (rows: number[]) => void;
  toggleDelete: (rows: number[]) => void;
  paste: (row: number, col: number, block: string[][], typed?: GridCopyCell[][] | null) => void;
  /** The foreign key picker's search of the referenced table. */
  searchKey?: (col: number, query: string) => Promise<KeyChoice[]>;
  /** A new row ⌘I just added: its first column's editor opens. */
  focusInsert?: number;
  /** The selected loaded rows (⌘D duplicates them), and whether they are whole rows (⌫). */
  onSelection?: (rows: number[], wholeRows: boolean, col: number) => void;
}

export type GridFilterOp = "=" | "IS DISTINCT FROM" | "IS NULL" | "IS NOT NULL" | "BETWEEN";
