import { selectionStats, type SelectionStats } from "./selectionStats";
import {
  memo,
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
} from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { firstLine } from "./comments";
import { CloseIcon, EyeOffIcon, KeyIcon, LinkIcon } from "./icons";
import { HIDDEN_TEXT } from "./presenting";
import type { Column, QueryResultDto, Value } from "./types";
import { CellEditor, type EditMove } from "./CellEditor";
import { commandById, eventMatches } from "./commands";
import { isMacPlatform } from "./platform";
import { showToast, toastPreview } from "./notify";
import { cellsToTsv, pastedCells, rememberCopy } from "./resultsExport";
import { GridMenu, type GridMenuItem } from "./GridMenu";
import { cellMenu, headerMenu as headerMenuRows } from "./contextMenus";
import type { CommandState } from "./commands";
import { noteTrigger, useTip } from "./Tips";
import { rowToJson, type QuickLookLinks } from "./QuickLook";
import { binEdge, columnProfiles, profileCaption, profileSample } from "./columnProfile";
import { chipLiteral, readsAsNull } from "./filterChips";
import { ResultRows, useResultRows, valueText } from "./resultStore";
import type { SortKey } from "./tableSort";
import { ProfileBar } from "./GridProfileBar";
import { Row, type ColumnLooks } from "./GridRow";
import { COL_DEFAULT, COL_MIN_WIDTH, ROW_HEIGHT, WIDTH_SAMPLE_ROWS, columnWindow, initialWidths } from "./gridLayout";
import { selRect, single, type CellPos, type Selection } from "./gridSelection";
import type { EditTarget, GridEditing, GridFilterOp, KeyColumns, QuickLookView } from "./gridTypes";
import "./ResultsGrid.css";

const EMPTY_ROWS = new ResultRows();
const EMPTY_COLUMNS: Column[] = [];
const NO_INSERTS: GridEditing["inserts"] = [];
const NO_PREVIEW: (Value | null | undefined)[][] = [];

const NUMERIC_TYPE =
  /^(int|integer|bigint|smallint|tinyint|mediumint|real|double|float|numeric|decimal|money|oid|serial|bigserial)/i;
const JSON_TYPE = /^jsonb?$/i;
const TIMESTAMP_TYPE = /^timestamp/i;

/**
 * Esc presses that only left the grid's selection: they never cancel the query
 * or discard the tab's edits (the next Esc does). The window still sees them,
 * so Review SQL or a held write closes on the same press, as before.
 */
export const escLeftSelection = new WeakSet<Event>();

/** Results of a fresh run, waiting to cascade in the first time they show. */
const pendingReveal = new WeakSet<object>();

/** Rows cascade in and profiles grow the first time this result is shown. */
export function markReveal(result: QueryResultDto) {
  pendingReveal.add(result);
}

/** How long the cascade runs before the class comes off (last row's delay + its animation; REVEAL_ROWS in GridRow.tsx caps the delay). */
const REVEAL_MS = 900;
/** Find reads up to this many cells in one go; a bigger result in slices between frames. */
const FIND_SYNC_CELLS = 100_000;
/** One slice of a big Find: well inside a frame. */
const FIND_SLICE_MS = 8;
const NO_MATCHES: CellPos[] = [];

/** Find's matches in rows [from, to): every shown cell containing `q` (lowercase). */
function findIn(
  shown: { isNull: (r: number, c: number) => boolean; text: (r: number, c: number) => string },
  q: string,
  from: number,
  to: number,
  hidden: boolean[],
  out: CellPos[],
) {
  const ncols = hidden.length;
  for (let r = from; r < to; r++) {
    for (let c = 0; c < ncols; c++) {
      if (hidden[c]) continue;
      if (!shown.isNull(r, c) && shown.text(r, c).toLowerCase().includes(q)) out.push({ row: r, col: c });
    }
  }
}

interface Props {
  result: QueryResultDto | null;
  /** Staged edits and the editors (table tabs); null where rows can't be edited at all. */
  editing?: GridEditing | null;
  /**
   * Import CSV's preview: the file's first rows as cells per result column
   * (undefined: DEFAULT), tinted above the table's rows. Not editable.
   */
  importRows?: (Value | null | undefined)[][] | null;
  /** Widths the user dragged, keyed by column name, for this result's columns */
  columnWidths?: Record<string, number>;
  onColumnWidthsChange?: (widths: Record<string, number>) => void;
  /** Marks key columns in the header when the result is a browsed table. */
  keyColumns?: KeyColumns | null;
  /** COMMENT ON COLUMN, by column name: the header tooltip and Quick Look print it. */
  columnComments?: ReadonlyMap<string, string> | null;
  /** Sort keys, primary first, and what a header click asks for (⇧-click: `secondary`). */
  sort?: SortKey[];
  /** A table tab sorts on the server (solid arrow); a query tab its loaded rows (hollow). */
  sortMode?: "server" | "client";
  onSort?: (column: string, secondary: boolean) => void;
  /** Header menu: one column's direction, or null to clear it. */
  onSortColumn?: (column: string, desc: boolean | null) => void;
  /** Header menu: Hide column (table tabs). */
  onHideColumn?: (column: string) => void;
  /** Hidden columns' places: a 6 px grip in the header before shown column `before`. */
  hiddenGrips?: { before: number; names: string[] }[];
  /** A grip's menu: show one hidden column again, or all of them ("*"). */
  onShowColumn?: (column: string) => void;
  /** Cell menu on a query result that reads one table: open it in a table tab. */
  onOpenAsTable?: () => void;
  /** Quick Look: the browsed table's name, and how to label a foreign key's row. */
  tableName?: string;
  /** Quick Look's keys to follow and Incoming; ⌘↵ follows the selected cell's key. */
  quickLookLinks?: QuickLookLinks | null;
  /** Bumped to open Quick Look (⌘K, a follow landing): on the selected row, else the first. */
  quickLookAsk?: number;
  /**
   * Quick Look's row, or null when it closes: Workspace shows it in the
   * inspector column (Paper, 2026-10-10). The grid keeps Space, Esc, ↑↓, ⌘C
   * and ⌫ for it.
   */
  onQuickLook?: (view: QuickLookView | null) => void;
  /** One cell selected (null otherwise): its row's values, for speculative key labels. */
  onCellSelect?: (cell: { row: number; column: string; values: unknown[] } | null) => void;
  /** Scrolled into the last rows: a table tab loads its next page. */
  onNearEnd?: () => void;
  /** A new value (another tab, a new run) scrolls back to the top; appended pages keep it. */
  scrollKey?: string;
  /** No rows on a filtered table tab: "No rows match. Clear filters". */
  emptyNote?: React.ReactNode;
  /** A block of two or more cells is selected: count · sum · avg (null otherwise). */
  onSelectionStats?: (stats: SelectionStats | null) => void;
  /** A table tab filters from the grid: the cell menu, profile segments, histogram drags. */
  onFilter?: (column: string, op: GridFilterOp, value?: string, value2?: string) => void;
  /** A printable key on a selected cell (type-to-filter); ? # / and Space are never sent. */
  onTypeKey?: (column: string, key: string) => void;
  /** Find in the loaded rows: cells containing `query` are marked; `index` is the current match. */
  find?: { query: string; index: number } | null;
  /** Find's match count; null while a big result's scan is still running. */
  onFindCount?: (matches: number | null) => void;
  /** What can run now (commands.ts): the cell menu prints ↵ edit and ⌘↵ follow only where they can. */
  commandState?: CommandState;
  /** Header menu: Filter by this column (table tabs) and Structure (a table's result). */
  onFilterColumn?: (column: string) => void;
  onStructure?: () => void;
  /** Sensitive columns of this result, by name: an eye in the header, and the menu says Unmark. */
  markedColumns?: ReadonlySet<string> | null;
  /** Presenting: these columns' cells show dots (Copy still copies the value). */
  hiddenColumns?: ReadonlySet<string> | null;
  /** Header menu: Mark as sensitive / Unmark sensitive. */
  onMarkColumn?: (column: string, marked: boolean) => void;
}

/** Keys that keep their own meaning on a selected cell instead of starting a filter. */
const RESERVED_KEYS = new Set([" ", "?", "#", "/"]);

/** Pointer this close to the sheet's edge while dragging scrolls it. */
const AUTOSCROLL_EDGE = 24;
const HEADER_HEIGHT = 46;

/** Without a window's state (tests, a bare grid) only copying and Quick Look are offered. */
const NO_COMMAND_STATE = { hasRows: true } as CommandState;

/**
 * ⌥⇧N and the cell menu's Set NULL: the column takes NULL and the row isn't
 * marked for delete (useRowEdits' `cellNullable` greys the command the same way).
 */
function canSetNull(editing: GridEditing, row: number, col: number): boolean {
  return !editing.refusal && !!editing.editors[col]?.nullable && editing.rowState(row)?.mark !== "delete";
}

/** ⌥⇧N (Ctrl+Alt+N), matched by code. */
function isSetNull(e: { code: string; metaKey: boolean; ctrlKey: boolean; altKey: boolean; shiftKey: boolean }) {
  const chord = commandById("set-null")?.chord;
  return !!chord && eventMatches(e, chord, isMacPlatform());
}

async function copyText(text: string) {
  try {
    await navigator.clipboard.writeText(text);
    showToast("Copied", toastPreview(text) || "empty");
  } catch {
    // Clipboard can be unavailable (permissions, headless proof runs).
    showToast("Couldn't copy", undefined, "error");
  }
}

const NULL_VALUE: Value = { Null: null };
/** Quick Look's value for a column Presenting hides. */
const HIDDEN_VALUE: Value = { Text: HIDDEN_TEXT };

/** `result` is `before` with rows added: still streaming (the same rows), or the next page of them. */
function isAppend(before: QueryResultDto | null, result: QueryResultDto | null): boolean {
  return (
    !!before &&
    !!result &&
    before.columns === result.columns &&
    (result.rows === before.rows || result.rows.prefixOf === before.rows) &&
    before.rows.length > 0
  );
}

/** Memoized: a parent re-render with the same props (a tick, a keystroke elsewhere) skips the grid. */
export const ResultsGrid = memo(ResultsGridView);

function ResultsGridView({
  result,
  editing,
  importRows,
  columnWidths,
  onColumnWidthsChange,
  keyColumns,
  columnComments,
  sort,
  sortMode = "server",
  onSort,
  onSortColumn,
  onHideColumn,
  hiddenGrips,
  onShowColumn,
  onOpenAsTable,
  tableName,
  quickLookLinks,
  quickLookAsk,
  onQuickLook,
  onCellSelect,
  onNearEnd,
  scrollKey,
  emptyNote,
  onSelectionStats,
  onFilter,
  onTypeKey,
  find,
  onFindCount,
  commandState,
  onFilterColumn,
  onStructure,
  markedColumns,
  hiddenColumns,
  onMarkColumn,
}: Props) {
  const parentRef = useRef<HTMLDivElement>(null);
  const columns: Column[] = result?.columns ?? EMPTY_COLUMNS;
  const rows = result?.rows ?? EMPTY_ROWS;
  // Rows stream in after the result is shown: re-render as they grow.
  const rowCount = useResultRows(rows);
  const error = result?.error;

  const columnNamesKey = useMemo(
    () => columns.map((c) => c.name).join("\0"),
    [columns],
  );

  const [widths, setWidths] = useState<number[]>(() =>
    initialWidths(columns, rows, columnWidths, keyColumns),
  );
  /** How many rows the widths were sized from (streamed results size again as rows arrive). */
  const sizedFrom = useRef(Math.min(rows.length, WIDTH_SAMPLE_ROWS));
  // What a cell shows: its staged edit, else the loaded value. Copy, the
  // selection's stats, find and Quick Look read through it.
  const editVersion = editing?.version;
  const shown = useMemo(() => {
    const staged = (r: number, c: number) => editing?.rowState(r)?.cells.get(c);
    return {
      isNull: (r: number, c: number) => {
        const st = staged(r, c);
        return st ? !st.value || "Null" in st.value : rows.isNull(r, c);
      },
      get: (r: number, c: number): Value => {
        const st = staged(r, c);
        return st ? (st.value ?? NULL_VALUE) : rows.get(r, c);
      },
      text: (r: number, c: number) => {
        const st = staged(r, c);
        return st ? valueText(st.value ?? undefined) : rows.text(r, c);
      },
      row: (r: number, n: number) => Array.from({ length: n }, (_, c) => (staged(r, c) ? (staged(r, c)!.value ?? NULL_VALUE) : rows.get(r, c))),
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rows, editing, editVersion]);
  const [sel, setSel] = useState<Selection | null>(null);
  const rect = useMemo(() => (sel ? selRect(sel) : null), [sel]);
  const selected = sel?.active ?? null;
  const multi = !!rect && (rect.r0 !== rect.r1 || rect.c0 !== rect.c1);
  // The SQL line shows what a selected block adds up to.
  useEffect(() => {
    if (!onSelectionStats) return;
    onSelectionStats(
      multi && rect && !columns.slice(rect.c0, rect.c1 + 1).some((c) => hiddenColumns?.has(c.name))
        ? selectionStats(
            { ...rect, r1: Math.min(rect.r1, rows.length - 1) },
            shown.get,
            columns.map((c) => c.type_name),
          )
        : null,
    );
  }, [onSelectionStats, multi, rect, rows, shown, columns, rowCount, hiddenColumns]);
  const bodyRef = useRef<HTMLDivElement>(null);
  /** Ends a drag in progress (unmount, new result). */
  const dragCleanup = useRef<(() => void) | null>(null);

  useEffect(() => {
    setWidths(initialWidths(columns, rows, columnWidths, keyColumns));
    sizedFrom.current = Math.min(rows.length, WIDTH_SAMPLE_ROWS);
    // Size once per result shape, not on every row batch.
  }, [columnNamesKey, columnWidths, keyColumns]);
  // A result that streams in arrives in small first frames: until
  // WIDTH_SAMPLE_ROWS rows are in, each batch may widen a column to fit them
  // (never narrow one, so nothing being read shifts left; a dragged width is
  // the saved one and stays).
  useEffect(() => {
    if (sizedFrom.current >= WIDTH_SAMPLE_ROWS || rowCount <= sizedFrom.current) return;
    sizedFrom.current = Math.min(rowCount, WIDTH_SAMPLE_ROWS);
    const fit = initialWidths(columns, rows, columnWidths, keyColumns);
    setWidths((w) => (w.length === fit.length ? w.map((x, i) => Math.max(x, fit[i])) : fit));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rowCount]);

  const [menuAt, setMenuAt] = useState<{ x: number; y: number } | null>(null);
  const closeMenu = useCallback(() => setMenuAt(null), []);
  // Right-click a header: sort, hide, copy its name. A hidden-column grip: show them.
  const [headerMenu, setHeaderMenu] = useState<{ x: number; y: number; column: string } | null>(null);
  const closeHeaderMenu = useCallback(() => setHeaderMenu(null), []);
  const [gripMenu, setGripMenu] = useState<{ x: number; y: number; names: string[] } | null>(null);
  const closeGripMenu = useCallback(() => setGripMenu(null), []);
  // A table tab's cell menu adds the three filter rows for the cell under the ring.
  const filterCell =
    onFilter && sel && !multi && sel.active.row < rows.length && columns[sel.active.col]
      ? {
          column: columns[sel.active.col],
          isNull: rows.isNull(sel.active.row, sel.active.col),
          text: rows.isNull(sel.active.row, sel.active.col) ? "" : rows.text(sel.active.row, sel.active.col),
        }
      : null;
  const followColumn = sel && !multi ? columns[sel.active.col]?.name : undefined;
  const menuItems = useMemo<GridMenuItem[]>(() => {
    const filter = filterCell && {
      column: filterCell.column.name,
      isNull: filterCell.isNull,
      nullable: !keyColumns?.notNull?.has(filterCell.column.name),
      shown: (() => {
        const lit = chipLiteral(filterCell.text, filterCell.column.type_name, undefined, readsAsNull(filterCell.text));
        return lit.length > 28 ? `${lit.slice(0, 26)}…'` : lit;
      })(),
    };
    return cellMenu({
      state: commandState ?? NO_COMMAND_STATE,
      filter,
      followColumn: followColumn && keyColumns?.fk.has(followColumn) ? followColumn : null,
      // A query result that reads one table offers that table in a table tab.
      openAsTable: !filterCell && !!onOpenAsTable,
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filterCell?.column, filterCell?.isNull, filterCell?.text, onOpenAsTable, commandState, followColumn, keyColumns]);
  const pickMenu = (id: string) => {
    if (id === "open-table") {
      onOpenAsTable?.();
      return;
    }
    if (id.startsWith("f-") && filterCell && onFilter) {
      const name = filterCell.column.name;
      if (id === "f-only") onFilter(name, "=", filterCell.text);
      // Hiding one value keeps the rows where the column is NULL: IS DISTINCT FROM, not <>.
      else if (id === "f-hide") onFilter(name, "IS DISTINCT FROM", filterCell.text);
      else if (id === "f-null") onFilter(name, "IS NULL");
      else onFilter(name, "IS NOT NULL");
      return;
    }
    if (id === "quick-look") {
      setQuickLook(true);
      return;
    }
    if (id === "follow-key") {
      followSelected();
      return;
    }
    if (editing && sel) {
      const { row, col } = sel.active;
      const picked = rect ? Array.from({ length: Math.min(rect.r1, rows.length - 1) - rect.r0 + 1 }, (_, i) => rect.r0 + i) : [row];
      if (id === "edit-cell") return openEditor({ row }, col);
      if (id === "set-null") return canSetNull(editing, row, col) ? editing.stage({ row }, col, null) : undefined;
      if (id === "insert-row") return editing.insertRow();
      if (id === "duplicate-row") return editing.duplicate(picked);
      if (id === "delete-row") return editing.toggleDelete(picked);
    }
    if (id === "csv" || id === "csv-header") copySelection(id === "csv-header");
  };

  // Load more appends rows to the same array of rows: the selection stays.
  const shownRef = useRef<QueryResultDto | null>(null);
  useEffect(() => {
    const before = shownRef.current;
    shownRef.current = result;
    if (isAppend(before, result)) return;
    setSel(null);
    setMenuAt(null);
    dragCleanup.current?.();
  }, [result]);

  useEffect(() => () => dragCleanup.current?.(), []);

  const [quickLook, setQuickLook] = useState(false);
  useEffect(() => {
    if (!selected) setQuickLook(false);
  }, [selected]);

  // The open cell editor (↵, F2, double-click), over a loaded row or a new one.
  const [editor, setEditor] = useState<{ target: EditTarget; col: number } | null>(null);
  const inserts = editing?.inserts ?? NO_INSERTS;
  const preview = importRows ?? NO_PREVIEW;
  // New rows sit above the loaded ones: the import's preview, then pending inserts.
  const insertsHeight = (preview.length + inserts.length) * ROW_HEIGHT;
  // A new result closes it; a page appended below (Load more, scrolling) doesn't.
  const editorResult = useRef<QueryResultDto | null>(null);
  useEffect(() => {
    const before = editorResult.current;
    editorResult.current = result;
    if (!isAppend(before, result)) setEditor(null);
  }, [result]);
  useEffect(() => setEditor(null), [editing?.refusal]);
  const openEditor = useCallback(
    (target: EditTarget, col: number) => {
      if (!editing) return;
      if (editing.refusal) {
        editing.onRefused();
        return;
      }
      if (!editing.editors[col]) return;
      if (hiddenColumns?.has(columns[col]?.name ?? "")) {
        showToast("Hidden while presenting");
        return;
      }
      if ("row" in target) {
        if (target.row >= rows.length || editing.rowState(target.row)?.mark === "delete") return;
        // A value core couldn't decode (`<tsvector>`) is never written back.
        if (!rows.isNull(target.row, col) && rows.text(target.row, col) === `<${columns[col]?.type_name}>`) return;
      }
      setQuickLook(false);
      // A new row's cell: the loaded row selected before isn't what ⌫ or ⌘D act on now.
      if ("insert" in target) setSel(null);
      setEditor({ target, col });
    },
    [editing, rows, columns, hiddenColumns],
  );
  // Which rows ⌘D and ⌫ act on.
  const onSelection = editing?.onSelection;
  useEffect(() => {
    if (!onSelection) return;
    if (!rect) return onSelection([], -1);
    const last = Math.min(rect.r1, rows.length - 1);
    const picked = Array.from({ length: Math.max(0, last - rect.r0 + 1) }, (_, i) => rect.r0 + i);
    onSelection(picked, multi ? -1 : (sel?.active.col ?? -1));
  }, [onSelection, sel, rect, rows, multi]);
  // ⌘I: the new row's first column with an editor opens.
  const askedInsert = useRef(editing?.focusInsert);
  useEffect(() => {
    const id = editing?.focusInsert;
    if (id === undefined || id === askedInsert.current) return;
    askedInsert.current = id;
    // Not a column the database fills (a serial key): its first one to type.
    const editors = editing?.editors ?? [];
    const shows = (c: number) => !hiddenColumns?.has(columns[c]?.name ?? "");
    let col = editors.findIndex((e, c) => !!e && !e.default && shows(c));
    if (col < 0) col = editors.findIndex((e, c) => !!e && shows(c));
    if (col >= 0) setEditor({ target: { insert: id }, col });
  }, [editing?.focusInsert, editing?.editors]);

  // The selected cell's row goes up for its keys' labels (Workspace debounces).
  const oneCell = selected && !multi && selected.row < rowCount ? selected : null;
  useEffect(() => {
    if (!onCellSelect) return;
    const col = oneCell ? columns[oneCell.col] : undefined;
    onCellSelect(
      oneCell && col ? { row: oneCell.row, column: col.name, values: rows.row(oneCell.row, columns.length) } : null,
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [onCellSelect, oneCell?.row, oneCell?.col, rows, columns]);

  /** ⌘↵ and the cell menu: follow the selected cell's foreign key. */
  const followSelected = () => {
    if (!oneCell || !quickLookLinks || rows.isNull(oneCell.row, oneCell.col)) return;
    const target = quickLookLinks.outgoing.get(columns[oneCell.col]?.name ?? "");
    if (target) quickLookLinks.follow(target, rows.get(oneCell.row, oneCell.col), false);
  };

  // ⌘K Quick Look, or a follow landing: open it on the selected row, else the first.
  const askSeen = useRef(quickLookAsk);
  useEffect(() => {
    if (quickLookAsk === askSeen.current || rowCount === 0 || columns.length === 0) return;
    askSeen.current = quickLookAsk;
    setSel((cur) => cur ?? single({ row: 0, col: 0 }));
    setQuickLook(true);
    parentRef.current?.focus({ preventScroll: true });
  }, [quickLookAsk, rowCount, columns.length]);

  const [revealing, setRevealing] = useState(false);
  useEffect(() => {
    if (!result || !pendingReveal.has(result)) return;
    setRevealing(true);
    // Cleared once played, so a result cut short (tab switched) plays when next shown.
    const t = window.setTimeout(() => {
      pendingReveal.delete(result);
      setRevealing(false);
    }, REVEAL_MS);
    return () => {
      window.clearTimeout(t);
      setRevealing(false);
    };
  }, [result]);

  const looks = useMemo<ColumnLooks>(
    () => ({
      numeric: columns.map((c) => NUMERIC_TYPE.test(c.type_name)),
      json: columns.map((c) => JSON_TYPE.test(c.type_name)),
      timestamp: columns.map((c) => TIMESTAMP_TYPE.test(c.type_name)),
      hidden: columns.map((c) => !!hiddenColumns?.has(c.name)),
    }),
    [columns, hiddenColumns],
  );
  const numericCols = looks.numeric;

  // Core profiled the first 5,000 rows once (`profile.rs`); they arrive with
  // the frame that completed the sample. Nothing here scans rows.
  const wireProfiles = rows.profiles;
  const profiles = useMemo(
    // A hidden column's shape would show its common values: none while presenting.
    () => columnProfiles(columns, rows).map((p, i) => (looks.hidden[i] ? null : p)),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [columns, rows, wireProfiles, looks],
  );
  const sampleNote = profileSample(rows);

  // Find: every loaded cell that contains the query (case-insensitive). A
  // small result is read at once; a big one in slices between frames, so
  // typing in Find never holds the page ("Searching…" until the scan ends).
  const findQuery = find?.query.toLowerCase() ?? "";
  const findAtOnce = rowCount * columns.length <= FIND_SYNC_CELLS;
  const syncMatches = useMemo(() => {
    if (!findQuery || !findAtOnce) return NO_MATCHES;
    const out: CellPos[] = [];
    findIn(shown, findQuery, 0, rowCount, looks.hidden, out);
    return out;
  }, [findQuery, findAtOnce, shown, rowCount, looks]);
  const [sliced, setSliced] = useState<{ key: unknown[]; matches: CellPos[] } | null>(null);
  const slicedKey = [findQuery, shown, rowCount, looks];
  useEffect(() => {
    // A new scan (or none) drops the last one's matches and the rows they held.
    setSliced((prev) => (prev ? null : prev));
    if (!findQuery || findAtOnce) return;
    const key = [findQuery, shown, rowCount, looks];
    const out: CellPos[] = [];
    let row = 0;
    let timer = 0;
    const step = () => {
      const end = performance.now() + FIND_SLICE_MS;
      while (row < rowCount && performance.now() < end) {
        const to = Math.min(rowCount, row + 64);
        findIn(shown, findQuery, row, to, looks.hidden, out);
        row = to;
      }
      if (row < rowCount) timer = window.setTimeout(step, 0);
      else setSliced({ key, matches: out });
    };
    timer = window.setTimeout(step, 0);
    return () => window.clearTimeout(timer);
  }, [findQuery, findAtOnce, shown, rowCount, looks]);
  const slicedDone = !!sliced && sliced.key.every((k, i) => k === slicedKey[i]);
  const findScanning = !!findQuery && !findAtOnce && !slicedDone;
  const findMatches = findAtOnce ? syncMatches : slicedDone ? sliced!.matches : NO_MATCHES;
  const findSet = useMemo(() => new Set(findMatches.map((m) => `${m.row}:${m.col}`)), [findMatches]);
  const findCurrent =
    find && findMatches.length
      ? findMatches[((find.index % findMatches.length) + findMatches.length) % findMatches.length]
      : null;
  useEffect(
    () => onFindCount?.(findScanning ? null : findMatches.length),
    [onFindCount, findScanning, findMatches.length],
  );
  /** The selection when Find was last asked (a query typed, ↵ / ⇧↵): a scan that ends later moves it only if it's still that. */
  const selWhenAsked = useRef<Selection | null>(null);

  const gutterWidth = useMemo(
    () => Math.max(44, String(rowCount).length * 8 + 20),
    [rowCount],
  );

  const colOffsets = useMemo(() => {
    const out: number[] = [];
    let x = gutterWidth;
    for (const w of widths) {
      out.push(x);
      x += w;
    }
    return out;
  }, [widths, gutterWidth]);

  const totalWidth = useMemo(
    () => widths.reduce((a, b) => a + b, gutterWidth),
    [widths, gutterWidth],
  );

  // Column virtualization: the window moves on sideways scrolls and resizes,
  // and re-renders only when a column comes into or leaves it.
  const [colWin, setColWin] = useState<[number, number] | null>(null);
  const updateColWin = useCallback(() => {
    const el = parentRef.current;
    const next = columnWindow(colOffsets, widths, gutterWidth, el?.scrollLeft ?? 0, el?.clientWidth || window.innerWidth);
    setColWin((prev) => (prev && prev[0] === next[0] && prev[1] === next[1] ? prev : next));
  }, [colOffsets, widths, gutterWidth]);
  useLayoutEffect(updateColWin, [updateColWin]);
  useEffect(() => {
    const el = parentRef.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(updateColWin);
    ro.observe(el);
    return () => ro.disconnect();
  }, [updateColWin, result]);
  const [c0, c1] = useMemo((): [number, number] => {
    const [a, b] = colWin ?? columnWindow(colOffsets, widths, gutterWidth, 0, window.innerWidth);
    const last = columns.length - 1;
    return [Math.min(a, Math.max(0, last)), Math.min(b, last)];
  }, [colWin, colOffsets, widths, gutterWidth, columns.length]);
  const colPad = c0 > 0 ? (colOffsets[c0] ?? gutterWidth) - gutterWidth : 0;

  const rowVirtualizer = useVirtualizer({
    count: rowCount,
    getScrollElement: () => parentRef.current,
    estimateSize: () => ROW_HEIGHT,
    overscan: 6,
    // New rows sit above the loaded ones.
    scrollMargin: insertsHeight,
    // A resize mid-scroll would otherwise re-render with flushSync inside the
    // ResizeObserver callback (WebKit's "ResizeObserver loop" notice).
    useAnimationFrameWithResizeObserver: true,
  });
  // The last rows (10 plus the overscan) are rendered: ask for more. A new
  // result starts at the top instead, before it can count as scrolled down.
  const virtualRows = rowVirtualizer.getVirtualItems();
  const slots = virtualRows.length + (virtualRows.length % 2);
  const lastShown = virtualRows.length ? virtualRows[virtualRows.length - 1].index : -1;
  // VoiceOver follows the ring through aria-activedescendant (focus stays on
  // the grid); only a rendered cell can be pointed at.
  const activeId = `${useId()}-active`;
  const activeShown =
    !!selected && selected.col >= c0 && selected.col <= c1 && virtualRows.some((v) => v.index === selected.row);
  const scrolledFor = useRef(scrollKey);
  useEffect(() => {
    if (scrolledFor.current !== scrollKey) {
      scrolledFor.current = scrollKey;
      if (parentRef.current) parentRef.current.scrollTop = 0;
      return;
    }
    if (onNearEnd && rowCount > 0 && lastShown >= rowCount - 10) onNearEnd();
  }, [scrollKey, onNearEnd, rowCount, lastShown]);

  const startColResize = useCallback(
    (colIndex: number, startX: number, startWidth: number) => {
      const onMove = (e: MouseEvent) => {
        const next = Math.max(COL_MIN_WIDTH, startWidth + (e.clientX - startX));
        setWidths((prev) => {
          const copy = [...prev];
          copy[colIndex] = next;
          return copy;
        });
      };
      const onUp = (e: MouseEvent) => {
        window.removeEventListener("mousemove", onMove);
        window.removeEventListener("mouseup", onUp);
        const name = columns[colIndex]?.name;
        // The second drag of one column in this result shape: its width is kept.
        if (name !== undefined && e.clientX !== startX)
          noteTrigger("widths-remembered", { key: `${columnNamesKey}\0${name}`, anchor: name });
        // Only the dragged column is saved; the rest keep sizing to content.
        setWidths((prev) => {
          if (name !== undefined)
            onColumnWidthsChange?.({
              ...columnWidths,
              [name]: prev[colIndex] ?? COL_DEFAULT,
            });
          return prev;
        });
      };
      window.addEventListener("mousemove", onMove);
      window.addEventListener("mouseup", onUp);
    },
    [columns, columnWidths, onColumnWidthsChange, columnNamesKey],
  );
  const widthTip = useTip("grid-header");
  const widthTipCol = widthTip ? columns.findIndex((c) => c.name === widthTip.anchor) : -1;

  const revealCell = useCallback(
    (pos: CellPos) => {
      rowVirtualizer.scrollToIndex(pos.row, { align: "auto" });
      const el = parentRef.current;
      if (!el) return;
      const left = colOffsets[pos.col] ?? 0;
      const right = left + (widths[pos.col] ?? 0);
      if (left - gutterWidth < el.scrollLeft) {
        el.scrollLeft = left - gutterWidth;
      } else if (right > el.scrollLeft + el.clientWidth) {
        el.scrollLeft = right - el.clientWidth;
      }
    },
    [rowVirtualizer, colOffsets, widths, gutterWidth],
  );

  /** Cell under a viewport point, clamped to the grid (the pointer can leave it mid-drag). */
  const cellAt = useCallback(
    (x: number, y: number): CellPos => {
      const box = bodyRef.current?.getBoundingClientRect();
      if (!box) return { row: 0, col: 0 };
      const row = Math.floor((y - box.top) / ROW_HEIGHT);
      const cx = x - box.left;
      let col = 0;
      while (col < colOffsets.length - 1 && (colOffsets[col + 1] ?? Infinity) <= cx) col++;
      return {
        row: Math.max(0, Math.min(rowCount - 1, row)),
        col,
      };
    },
    [colOffsets, rowCount],
  );

  const onBodyMouseDown = useCallback(
    (e: ReactMouseEvent<HTMLDivElement>) => {
      if (e.button !== 0) return;
      const target = e.target as HTMLElement;
      const rowEl = target.closest<HTMLElement>("[data-row]");
      if (!rowEl || rowCount === 0 || columns.length === 0) return;
      // No text selection in the grid: a drag selects cells instead.
      e.preventDefault();
      parentRef.current?.focus({ preventScroll: true });
      const lastCol = columns.length - 1;
      // The row number selects whole rows; dragging down it adds rows.
      const wholeRows = !!target.closest(".rg-gutter");
      const hit = wholeRows
        ? { row: Number(rowEl.dataset.row), col: 0 }
        : cellAt(e.clientX, e.clientY);
      const toFocus = (p: CellPos): CellPos => (wholeRows ? { row: p.row, col: lastCol } : p);

      let anchor: CellPos;
      if (e.shiftKey && sel) {
        anchor = wholeRows ? { row: sel.anchor.row, col: 0 } : sel.anchor;
        setSel({ active: anchor, anchor, focus: toFocus(hit), rows: wholeRows });
      } else {
        anchor = hit;
        setSel({ active: hit, anchor: hit, focus: toFocus(hit), rows: wholeRows });
      }

      dragCleanup.current?.();
      let px = e.clientX;
      let py = e.clientY;
      let frame = 0;
      const extend = () => {
        const focus = toFocus(cellAt(px, py));
        setSel((cur) =>
          cur && (cur.focus.row !== focus.row || cur.focus.col !== focus.col)
            ? { ...cur, focus }
            : cur,
        );
      };
      // Past an edge of the sheet, keep scrolling and extending each frame.
      const tick = () => {
        frame = 0;
        const el = parentRef.current;
        if (!el) return;
        const box = el.getBoundingClientRect();
        let dx = 0;
        let dy = 0;
        if (py < box.top + HEADER_HEIGHT + AUTOSCROLL_EDGE / 2) dy = py - (box.top + HEADER_HEIGHT);
        else if (py > box.bottom - AUTOSCROLL_EDGE) dy = py - (box.bottom - AUTOSCROLL_EDGE);
        if (!wholeRows) {
          if (px < box.left + gutterWidth) dx = px - (box.left + gutterWidth);
          else if (px > box.right - AUTOSCROLL_EDGE) dx = px - (box.right - AUTOSCROLL_EDGE);
        }
        if (dx === 0 && dy === 0) return;
        const clamp = (d: number) => Math.sign(d) * Math.min(40, Math.max(2, Math.abs(d) / 2));
        if (dy) el.scrollTop += clamp(dy);
        if (dx) el.scrollLeft += clamp(dx);
        extend();
        frame = requestAnimationFrame(tick);
      };
      const onMove = (ev: MouseEvent) => {
        px = ev.clientX;
        py = ev.clientY;
        extend();
        if (!frame) frame = requestAnimationFrame(tick);
      };
      const stop = () => {
        window.removeEventListener("mousemove", onMove);
        window.removeEventListener("mouseup", stop);
        if (frame) cancelAnimationFrame(frame);
        frame = 0;
        dragCleanup.current = null;
      };
      window.addEventListener("mousemove", onMove);
      window.addEventListener("mouseup", stop);
      dragCleanup.current = stop;
    },
    [rowCount, columns.length, cellAt, sel, gutterWidth],
  );

  const copySelection = useCallback(
    (withHeader: boolean) => {
      if (!result || !rect || !sel) return;
      const { r0, r1, c0, c1 } = rect;
      if (!multi && !withHeader) {
        // One cell copies its value as is, unquoted.
        const { row, col } = sel.active;
        const nul = shown.isNull(row, col);
        const text = nul ? "NULL" : shown.text(row, col);
        rememberCopy({ text, width: 1, nulls: new Set(nul ? [0] : []) });
        void copyText(text);
        return;
      }
      const nRows = r1 - r0 + 1;
      const nCols = c1 - c0 + 1;
      const label =
        nCols === columns.length
          ? `Copied ${nRows.toLocaleString()} ${nRows === 1 ? "row" : "rows"}`
          : `Copied ${(nRows * nCols).toLocaleString()} ${nRows * nCols === 1 ? "cell" : "cells"}`;
      const detail = withHeader ? "TSV with header" : "TSV";
      const copy = cellsToTsv(result, r0, r1, c0, c1, withHeader, shown.text, shown.isNull);
      rememberCopy(copy);
      navigator.clipboard
        .writeText(copy.text)
        .then(
          () => showToast(label, detail),
          // Clipboard can be unavailable (permissions, headless proof runs).
          () => showToast("Couldn't copy", undefined, "error"),
        );
    },
    [result, rect, sel, multi, shown, columns.length],
  );

  /** Right-click inside the selection keeps it; elsewhere it selects that cell (or row) first. */
  const onContextMenu = useCallback(
    (e: ReactMouseEvent<HTMLDivElement>) => {
      e.preventDefault();
      const target = e.target as HTMLElement;
      const rowEl = target.closest<HTMLElement>("[data-row]");
      if (!rowEl || rowCount === 0 || columns.length === 0) return;
      parentRef.current?.focus({ preventScroll: true });
      const wholeRow = !!target.closest(".rg-gutter");
      const hit = wholeRow
        ? { row: Number(rowEl.dataset.row), col: 0 }
        : cellAt(e.clientX, e.clientY);
      const inside =
        !!rect &&
        hit.row >= rect.r0 &&
        hit.row <= rect.r1 &&
        (wholeRow ? rect.c0 === 0 && rect.c1 === columns.length - 1 : hit.col >= rect.c0 && hit.col <= rect.c1);
      if (!inside) {
        setSel(
          wholeRow
            ? { active: hit, anchor: hit, focus: { row: hit.row, col: columns.length - 1 }, rows: true }
            : single(hit),
        );
      }
      setMenuAt({ x: e.clientX, y: e.clientY });
    },
    [rowCount, columns.length, cellAt, rect],
  );

  /** ⌘C with Quick Look open, and its Copy JSON: the row as JSON. */
  const copyRowJson = (r: number) => {
    if (r >= rowCount) return;
    navigator.clipboard.writeText(rowToJson(columns, shown.row(r, columns.length))).then(
      () => showToast("Copied row", "JSON"),
      () => showToast("Couldn't copy", undefined, "error"),
    );
  };
  const copyRowJsonRef = useRef(copyRowJson);
  copyRowJsonRef.current = copyRowJson;

  const onKeyDown = useCallback(
    (e: ReactKeyboardEvent<HTMLDivElement>) => {
      if (rowCount === 0 || columns.length === 0) return;
      const mod = e.metaKey || e.ctrlKey;
      const lastRow = rowCount - 1;
      const lastCol = columns.length - 1;
      const key = e.key.toLowerCase();
      // ⌘A selects the whole table (never the page's text).
      if (mod && !e.shiftKey && !e.altKey && key === "a") {
        e.preventDefault();
        setSel((cur) => ({
          active: cur?.active ?? { row: 0, col: 0 },
          anchor: { row: 0, col: 0 },
          focus: { row: lastRow, col: lastCol },
        }));
        return;
      }
      if (!sel) return;
      if (editing && isSetNull(e)) {
        const { row, col } = sel.active;
        e.preventDefault();
        if (editing.refusal) editing.onRefused();
        else if (canSetNull(editing, row, col)) editing.stage({ row }, col, null);
        return;
      }
      // ⌘D in the grid duplicates the rows under the selection as it is now.
      if (editing && mod && !e.shiftKey && !e.altKey && key === "d" && !editing.refusal) {
        e.preventDefault();
        const r1 = Math.min(rect?.r1 ?? sel.active.row, lastRow);
        const r0 = rect?.r0 ?? sel.active.row;
        editing.duplicate(Array.from({ length: r1 - r0 + 1 }, (_, i) => r0 + i));
        return;
      }
      // ⌫ with Quick Look open marks its row for delete; again restores it.
      if (editing && quickLook && !mod && !e.altKey && (e.key === "Backspace" || e.key === "Delete") && sel.active.row < rowCount) {
        e.preventDefault();
        if (editing.refusal) editing.onRefused();
        else editing.toggleDelete([sel.active.row]);
        return;
      }
      if (editing && !mod) {
        const { row, col } = sel.active;
        if ((e.key === "Enter" && !e.altKey && !e.shiftKey) || e.key === "F2") {
          e.preventDefault();
          openEditor({ row }, col);
          return;
        }
        // ⌫ marks the rows under the selection (a cell is its row) for delete; again unmarks.
        if ((e.key === "Backspace" || e.key === "Delete") && rect && rect.r0 <= lastRow) {
          e.preventDefault();
          if (editing.refusal) editing.onRefused();
          else editing.toggleDelete(Array.from({ length: Math.min(rect.r1, lastRow) - rect.r0 + 1 }, (_, i) => rect.r0 + i));
          return;
        }
        if (e.key === "Escape" && !quickLook && editing.rowState(row)?.cells.has(col)) {
          e.preventDefault();
          e.stopPropagation();
          editing.revert({ row }, col);
          return;
        }
      }
      // Space opens Quick Look on the ring's row, like Finder; Space or Esc closes it.
      if (e.key === " " && !mod && !e.altKey) {
        e.preventDefault();
        setQuickLook((open) => !open);
        return;
      }
      if (quickLook && e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        setQuickLook(false);
        return;
      }
      if (quickLook && mod && !e.altKey && !e.shiftKey && key === "c") {
        e.preventDefault();
        copyRowJson(sel.active.row);
        return;
      }
      // ⌘↵ follows the selected cell's foreign key (a table tab; ⌘↵ runs elsewhere).
      if (mod && !e.shiftKey && !e.altKey && e.key === "Enter" && commandState?.cellFollowable) {
        e.preventDefault();
        followSelected();
        return;
      }
      // ⌘C copies the selected cells, ⇧⌘C adds their column names on top.
      if (mod && !e.altKey && key === "c") {
        e.preventDefault();
        copySelection(e.shiftKey);
        return;
      }
      if (e.key === "Escape") {
        escLeftSelection.add(e.nativeEvent);
        setSel(null);
        return;
      }
      // Type-to-filter: a printable key starts a chip on this column.
      if (onTypeKey && e.key.length === 1 && !mod && !e.altKey && !RESERVED_KEYS.has(e.key)) {
        const col = columns[sel.active.col];
        if (col) {
          e.preventDefault();
          onTypeKey(col.name, e.key);
        }
        return;
      }
      const page = Math.max(1, Math.floor((parentRef.current?.clientHeight ?? 0) / ROW_HEIGHT) - 2);
      // ⇧ moves the far corner of the block; otherwise the ring moves and the block collapses.
      const from = e.shiftKey ? sel.focus : sel.active;
      let { row, col } = from;
      switch (e.key) {
        case "ArrowUp":
          row = mod ? 0 : Math.max(0, row - 1);
          break;
        case "ArrowDown":
          row = mod ? lastRow : Math.min(lastRow, row + 1);
          break;
        case "ArrowLeft":
          col = mod ? 0 : Math.max(0, col - 1);
          break;
        case "ArrowRight":
          col = mod ? lastCol : Math.min(lastCol, col + 1);
          break;
        case "PageUp":
          row = Math.max(0, row - page);
          break;
        case "PageDown":
          row = Math.min(lastRow, row + page);
          break;
        case "Home":
          col = 0;
          break;
        case "End":
          col = lastCol;
          break;
        default:
          return;
      }
      e.preventDefault();
      const next = { row, col };
      setSel(e.shiftKey ? { ...sel, focus: next } : single(next));
      revealCell(next);
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [sel, rect, rows, shown, columns, revealCell, copySelection, quickLook, onTypeKey, commandState, quickLookLinks, editing, openEditor],
  );

  /** A staged value: the ring moves on (↵ down, Tab across); a new row's Tab edits its next column. */
  const stageEdit = (value: Value | null, move: EditMove) => moveEdit(move, value);
  /** ↵ on an untouched value: the ring moves on, nothing is staged. */
  const keepEdit = (move: EditMove) => moveEdit(move);
  const moveEdit = (move: EditMove, ...staged: [Value | null] | []) => {
    if (!editor || !editing) return;
    const { target, col } = editor;
    if (staged.length) editing.stage(target, col, staged[0]);
    setEditor(null);
    parentRef.current?.focus({ preventScroll: true });
    const step = move === "right" ? 1 : move === "left" ? -1 : 0;
    if ("row" in target) {
      const next = {
        row: move === "down" ? Math.min(rowCount - 1, target.row + 1) : target.row,
        col: Math.max(0, Math.min(columns.length - 1, col + step)),
      };
      setSel(single(next));
      revealCell(next);
    } else if (step) {
      let c = col + step;
      while (c >= 0 && c < columns.length && !editing.editors[c]) c += step;
      if (c >= 0 && c < columns.length) setEditor({ target, col: c });
    }
  };
  /** Focus left the editor: stage a changed value, never take focus back. */
  const blurEdit = (value: Value | null | undefined) => {
    if (!editor || !editing) return;
    if (value !== undefined) editing.stage(editor.target, editor.col, value);
    setEditor(null);
  };
  const closeEditor = useCallback(() => {
    setEditor(null);
    parentRef.current?.focus({ preventScroll: true });
  }, []);
  const editorCol = editor?.col ?? -1;
  const searchKey = useMemo(
    () => (editing?.searchKey && editorCol >= 0 && editing.editors[editorCol]?.fk ? (q: string) => editing.searchKey!(editorCol, q) : undefined),
    [editing, editorCol],
  );
  const renderEditor = (top: number) => {
    if (!editor || !editing) return null;
    const ed = editing.editors[editor.col];
    if (!ed) return null;
    let initial: Value | null = null;
    if ("row" in editor.target) {
      const r = editor.target.row;
      const staged = editing.rowState(r)?.cells.get(editor.col);
      initial = staged ? staged.value : rows.isNull(r, editor.col) ? null : rows.get(r, editor.col);
    } else {
      const id = editor.target.insert;
      initial = inserts.find((x) => x.id === id)?.cells[editor.col] ?? null;
    }
    return (
      <CellEditor
        key={`${JSON.stringify(editor.target)}:${editor.col}`}
        editor={ed}
        initial={initial}
        style={{ left: colOffsets[editor.col], top, width: Math.max(widths[editor.col] ?? COL_DEFAULT, 120) }}
        onStage={stageEdit}
        onKeep={keepEdit}
        onCancel={closeEditor}
        onBlurDone={blurEdit}
        searchKey={searchKey}
      />
    );
  };

  // Before the jump below: what was selected when Find was asked.
  useEffect(() => {
    selWhenAsked.current = sel;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [findQuery, find?.index]);
  // ↵ / ⇧↵ in the find field: the ring moves to the current match. A big
  // scan's first match doesn't take the selection from a cell picked since.
  useEffect(() => {
    if (!findCurrent) return;
    if (!findAtOnce && sel !== selWhenAsked.current) return;
    setSel(single(findCurrent));
    revealCell(findCurrent);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [findCurrent?.row, findCurrent?.col, find?.index]);

  const qlRow = useMemo(
    () =>
      quickLook && selected && selected.row < rowCount
        ? shown.row(selected.row, columns.length).map((v, c) => (looks.hidden[c] ? HIDDEN_VALUE : v))
        : undefined,
    [quickLook, selected, shown, rowCount, columns.length, looks],
  );

  // Quick Look goes up to the inspector; its buttons act here.
  const onQuickLookRef = useRef(onQuickLook);
  onQuickLookRef.current = onQuickLook;
  const qlMove = useRef((_step: number) => {});
  qlMove.current = (step: number) => {
    if (!selected) return;
    const next = { row: Math.max(0, Math.min(rowCount - 1, selected.row + step)), col: selected.col };
    setSel(single(next));
    revealCell(next);
  };
  useEffect(() => {
    const report = onQuickLookRef.current;
    if (!report) return;
    if (!qlRow || !selected) return report(null);
    const r = selected.row;
    report({
      columns,
      row: qlRow,
      rowIndex: r,
      rowCount,
      column: columns[selected.col]?.name,
      edit: editing?.rowState(r),
      prev: () => qlMove.current(-1),
      next: () => qlMove.current(1),
      close: () => {
        setQuickLook(false);
        parentRef.current?.focus({ preventScroll: true });
      },
      copyJson: () => copyRowJsonRef.current(r),
      toggleDelete: editing
        ? () => (editing.refusal ? editing.onRefused() : editing.toggleDelete([r]))
        : undefined,
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [qlRow, selected?.row, selected?.col, rowCount, columns, editing]);
  useEffect(() => () => onQuickLookRef.current?.(null), []);

  if (result?.cancelled) {
    // Rows that streamed in before the cancel still show; the header says it was cancelled.
    if (rowCount === 0) {
      return <div className="results-empty">Query cancelled</div>;
    }
  } else if (error) {
    return <div className="results-error">{error}</div>;
  }

  if (!result) {
    return <div className="results-empty">Run a query to see results</div>;
  }

  if (columns.length === 0 && rowCount === 0) {
    const changed = result.affected_rows ?? 0;
    return (
      <div className="results-empty">
        {changed > 0
          ? `${changed.toLocaleString()} ${changed === 1 ? "row" : "rows"} changed`
          : "Query finished with no result set"}
        {/* The server's warning: a COMMIT with nothing to commit says so only here. */}
        {result.warning && (
          <div className="results-warning" data-warning>
            Warning: {result.warning}
          </div>
        )}
      </div>
    );
  }

  return (
    <>
      {/* A RAISE WARNING from a query that returns rows, above them. */}
      {result.warning && (
        <div className="results-warning results-warning-bar" data-warning>
          Warning: {result.warning}
        </div>
      )}
      <div
        data-testid="results-grid-wrap"
        className={`results-grid-wrap${revealing ? " rg-reveal" : ""}`}
        ref={parentRef}
        tabIndex={0}
        role="grid"
        aria-label={tableName ? `${tableName} rows` : "Results"}
        aria-multiselectable
        // The header row and the row-number column count too.
        aria-rowcount={rowCount + preview.length + inserts.length + 1}
        data-row-count={rowCount}
        aria-colcount={columns.length + 1}
        data-col-count={columns.length}
        aria-activedescendant={activeShown ? activeId : undefined}
        onKeyDown={onKeyDown}
        onContextMenu={onContextMenu}
        onScroll={updateColWin}
        onPaste={(e) => {
          // A copied block over editable cells stages them, cell by cell.
          if (!editing || !sel || editor) return;
          e.preventDefault();
          if (editing.refusal) editing.onRefused();
          else {
            editing.paste(sel.active.row, sel.active.col, pastedCells(e.clipboardData.getData("text/plain")));
          }
        }}
      >
        <GridMenu at={menuAt} items={menuItems} name="grid" label="Cell" onPick={pickMenu} onClose={closeMenu} />
        <GridMenu
          at={headerMenu}
          name="header"
          label="Column"
          items={headerMenuRows({
            column: headerMenu?.column,
            sortable: !!onSort,
            hideable: !!onHideColumn,
            sort,
            filterable: !!onFilterColumn,
            structure: !!onStructure,
            marked: onMarkColumn ? !!headerMenu && !!markedColumns?.has(headerMenu.column) : undefined,
          })}
          onPick={(id) => {
            const column = headerMenu?.column;
            if (column === undefined) return;
            if (id === "asc" || id === "desc") onSortColumn?.(column, id === "desc");
            else if (id === "clear") onSortColumn?.(column, null);
            else if (id === "secondary") onSort?.(column, true);
            else if (id === "hide") onHideColumn?.(column);
            else if (id === "copy-name") void copyText(column);
            else if (id === "filter") onFilterColumn?.(column);
            else if (id === "structure") onStructure?.();
            else if (id === "mark") onMarkColumn?.(column, !markedColumns?.has(column));
          }}
          onClose={closeHeaderMenu}
        />
        <GridMenu
          at={gripMenu}
          name="hidden-columns"
          label="Hidden columns"
          items={[
            ...(gripMenu?.names ?? []).map((n) => ({ id: n, label: `Show ${n}` })),
            ...((hiddenGrips?.reduce((a, g) => a + g.names.length, 0) ?? 0) > (gripMenu?.names.length ?? 0)
              ? [{ id: "*", label: "Show all hidden columns" }]
              : []),
          ]}
          onPick={(id) => onShowColumn?.(id)}
          onClose={closeGripMenu}
        />
        <div className="rg-inner" role="none" style={{ width: totalWidth }}>
          <div data-testid="rg-header" className="rg-header" role="row" aria-rowindex={1} style={{ width: totalWidth }}>
            <div
              data-testid="rg-gutter"
              className="rg-gutter rg-gutter-head"
              role="columnheader"
              aria-colindex={1}
              aria-label="Row"
              style={{ width: gutterWidth }}
            />
            {hiddenGrips?.map((g) => (
              <button
                key={`grip-${g.before}`}
                type="button"
                className="rg-hidden-grip"
                data-hidden-grip={g.names.join(",")}
                aria-label={`Hidden: ${g.names.join(", ")}`}
                title={`Hidden: ${g.names.join(", ")} · click to show`}
                style={{ left: (g.before < columns.length ? (colOffsets[g.before] ?? totalWidth) : totalWidth) - 3 }}
                onClick={(e) => {
                  e.stopPropagation();
                  setGripMenu({ x: e.clientX, y: e.clientY, names: g.names });
                }}
              />
            ))}
            {colPad > 0 && <span className="rg-colpad" aria-hidden style={{ width: colPad }} />}
            {columns.slice(c0, c1 + 1).map((col, j) => {
              const i = c0 + j;
              const rank = sort ? sort.findIndex((k) => k.column === col.name) : -1;
              const key = rank >= 0 ? sort![rank] : undefined;
              const shiftClick = isMacPlatform() ? "⇧-click" : "Shift-click";
              const hint =
                sortMode === "client"
                  ? `click sorts the loaded rows · ${shiftClick} adds a secondary sort`
                  : `Click sorts by this column · ${shiftClick} adds a secondary sort`;
              return (
              <div
                key={`${i}:${col.name}`}
                className={`rg-header-cell${numericCols[i] ? " rg-num" : ""}${
                  onSort ? " rg-sortable" : ""
                }${
                  selected?.col === i ? " rg-col-active" : ""
                }${multi && rect && i >= rect.c0 && i <= rect.c1 ? " rg-col-sel" : ""}`}
                data-header={col.name}
                role="columnheader"
                aria-colindex={i + 2}
                aria-sort={rank === 0 ? (key!.desc ? "descending" : "ascending") : undefined}
                aria-label={`${col.name}, ${col.type_name}`}
                data-selected={multi && rect && i >= rect.c0 && i <= rect.c1 ? "" : undefined}
                data-sort={key ? (key.desc ? "desc" : "asc") : undefined}
                data-sort-rank={key ? rank + 1 : undefined}
                data-sort-mode={key ? sortMode : undefined}
                style={{ width: widths[i] }}
                data-comment={columnComments?.has(col.name) ? "" : undefined}
                title={[
                  firstLine(columnComments?.get(col.name)),
                  [col.name, col.type_name, profiles[i] && profileCaption(profiles[i]), profiles[i] && sampleNote]
                    .filter(Boolean)
                    .join(" · "),
                  onSort ? hint : "",
                ]
                  .filter(Boolean)
                  .join("\n")}
                onMouseDown={(e) => {
                  // ⇧-click adds a sort key; it must not select the page's text.
                  if (e.shiftKey) e.preventDefault();
                }}
                onClick={onSort ? (e) => onSort(col.name, e.shiftKey) : undefined}
                onContextMenu={(e) => {
                  e.preventDefault();
                  e.stopPropagation();
                  setHeaderMenu({ x: e.clientX, y: e.clientY, column: col.name });
                }}
              >
                <span className="rg-header-name">
                  {keyColumns?.pk.has(col.name) && (
                    <KeyIcon size={11} data-testid="rg-key-pk" className="rg-key-pk" />
                  )}
                  {keyColumns?.fk.has(col.name) && (
                    <LinkIcon size={11} data-testid="rg-key-fk" className="rg-key-fk" />
                  )}
                  {markedColumns?.has(col.name) && (
                    <span className="rg-marked" data-marked title="Sensitive: agents see a stand-in">
                      <EyeOffIcon size={11} />
                    </span>
                  )}
                  <span className="rg-header-label">{col.name}</span>
                  <span className="rg-header-type">{col.type_name}</span>
                  {key && (
                    <span
                      data-testid="rg-sort"
                      className={`rg-sort${sortMode === "client" ? " rg-sort-client" : ""}`}
                      aria-label={`${key.desc ? "Descending" : "Ascending"}${rank > 0 ? `, sort key ${rank + 1}` : ""}${
                        sortMode === "client" ? " (loaded rows)" : ""
                      }`}
                    >
                      {/* Solid for a server sort; hollow when only the loaded rows are sorted. */}
                      {sortMode === "client" ? (key.desc ? "⇩" : "⇧") : key.desc ? "▼" : "▲"}
                      {rank > 0 && <span data-testid="rg-sort-rank" className="rg-sort-rank">{rank + 1}</span>}
                    </span>
                  )}
                </span>
                <ProfileBar
                  profile={profiles[i]}
                  onSeg={
                    onFilter
                      ? (value) => (value === null ? onFilter(col.name, "IS NULL") : onFilter(col.name, "=", value))
                      : undefined
                  }
                  onRange={
                    onFilter
                      ? (lo, hi) => {
                          const p = profiles[i];
                          if (p?.kind !== "hist") return;
                          onFilter(col.name, "BETWEEN", binEdge(p.ranges[lo][0], p.time, "low"), binEdge(p.ranges[hi][1], p.time, "high"));
                        }
                      : undefined
                  }
                />
                <span
                  data-testid="col-resize-handle"
                  className="col-resize-handle"
                  role="separator"
                  aria-orientation="vertical"
                  onClick={(e) => e.stopPropagation()}
                  onMouseDown={(e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    startColResize(i, e.clientX, widths[i] ?? COL_DEFAULT);
                  }}
                />
              </div>
              );
            })}
            {/* Last, so header cells keep their places (proofs count them with nth-of-type). */}
            {widthTip && widthTipCol >= 0 && (
              <div className="tip-line rg-tip" data-tip={widthTip.id} role="status" style={{ left: colOffsets[widthTipCol] }}>
                {widthTip.text}
              </div>
            )}
          </div>
          {insertsHeight > 0 && (
            <div data-testid="rg-inserts" className="rg-inserts" role="rowgroup" style={{ height: insertsHeight, width: totalWidth }}>
              {preview.map((cells, i) => (
                <div
                  key={`import:${i}`}
                  role="row"
                  aria-rowindex={i + 2}
                  data-import-row={i}
                  data-mark="import"
                  className="rg-row rg-row-insert"
                  style={{ transform: `translateY(${i * ROW_HEIGHT}px)`, width: totalWidth }}
                >
                  <div data-testid="rg-gutter" className="rg-gutter" role="rowheader" aria-colindex={1} aria-label="Row from the file" style={{ width: gutterWidth }}>
                    <i className="rg-mark-dot" />
                  </div>
                  {colPad > 0 && <span className="rg-colpad" aria-hidden style={{ width: colPad }} />}
                  {columns.slice(c0, c1 + 1).map((col, j) => {
                    const ci = c0 + j;
                    const v = cells[ci];
                    const isDefault = v === undefined;
                    return (
                      <div
                        key={`${ci}:${col.name}`}
                        data-col={ci}
                        role="gridcell"
                        aria-colindex={ci + 2}
                        data-default={isDefault ? "" : undefined}
                        // Preview cells can't be selected or opened: a cut-off value reads on hover.
                        title={!looks.hidden[ci] && v && !("Null" in v) ? valueText(v) : undefined}
                        className={`rg-cell${isDefault ? " rg-cell-default" : ""}`}
                        style={{ width: widths[ci] }}
                      >
                        {looks.hidden[ci] ? HIDDEN_TEXT : isDefault ? "default" : !v || "Null" in v ? <span data-testid="rg-null" className="rg-null">NULL</span> : valueText(v)}
                      </div>
                    );
                  })}
                </div>
              ))}
              {inserts.map((ins, k) => {
                const i = preview.length + k;
                return (
                <div
                  key={ins.id}
                  role="row"
                  aria-rowindex={i + 2}
                  data-insert={ins.id}
                  data-mark="insert"
                  className="rg-row rg-row-insert"
                  style={{ transform: `translateY(${i * ROW_HEIGHT}px)`, width: totalWidth }}
                >
                  <div data-testid="rg-gutter" className="rg-gutter" role="rowheader" aria-colindex={1} aria-label="New row" style={{ width: gutterWidth }}>
                    <i className="rg-mark-dot" />
                    <button
                      type="button"
                      className="rg-insert-remove"
                      aria-label="Remove this new row"
                      title="Remove this new row"
                      data-remove-insert
                      onClick={() => editing?.removeInsert(ins.id)}
                    >
                      <CloseIcon size={9} />
                    </button>
                  </div>
                  {colPad > 0 && <span className="rg-colpad" aria-hidden style={{ width: colPad }} />}
                  {columns.slice(c0, c1 + 1).map((col, j) => {
                    const ci = c0 + j;
                    const v = ins.cells[ci];
                    const isDefault = v === undefined;
                    const hidden = looks.hidden[ci];
                    return (
                      <div
                        key={`${ci}:${col.name}`}
                        data-col={ci}
                        role="gridcell"
                        aria-colindex={ci + 2}
                        data-default={isDefault ? "" : undefined}
                        className={`rg-cell${isDefault ? " rg-cell-default" : " rg-cell-edited"}`}
                        style={{ width: widths[ci] }}
                        title={isDefault ? "Sent as DEFAULT" : undefined}
                        onMouseDown={(e) => {
                          e.preventDefault();
                          openEditor({ insert: ins.id }, ci);
                        }}
                      >
                        {hidden ? HIDDEN_TEXT : isDefault ? "default" : !v || "Null" in v ? <span data-testid="rg-null" className="rg-null">NULL</span> : valueText(v)}
                      </div>
                    );
                  })}
                </div>
                );
              })}
              {editor &&
                "insert" in editor.target &&
                renderEditor((preview.length + inserts.findIndex((x) => "insert" in editor.target && x.id === editor.target.insert)) * ROW_HEIGHT)}
            </div>
          )}
          <div
            ref={bodyRef}
            data-testid="rg-body"
            className="rg-body"
            role="rowgroup"
            style={{ height: rowVirtualizer.getTotalSize(), width: totalWidth }}
            onMouseDown={onBodyMouseDown}
            onDoubleClick={(e) => {
              if (!editing || (e.target as HTMLElement).closest(".rg-gutter, .rg-editor")) return;
              const hit = cellAt(e.clientX, e.clientY);
              openEditor({ row: hit.row }, hit.col);
            }}
          >
            {/* Keyed and ordered by slot, not by row: a row scrolled into view
                takes the element of one scrolled out, in place (a moved node is
                restyled whole), and its cells keep their nodes. An even count
                keeps each slot on odd or even rows (the zebra tint is
                inherited: flipping it would restyle every cell). */}
            {[...virtualRows].sort((a, b) => (a.index % slots) - (b.index % slots)).map((vRow) => {
              const r = vRow.index;
              const inBlock = multi && !!rect && r >= rect.r0 && r <= rect.r1;
              return (
                <Row
                  key={r % slots}
                  index={r}
                  start={vRow.start - insertsHeight}
                  rows={rows}
                  columns={columns}
                  c0={c0}
                  c1={c1}
                  pad={colPad}
                  widths={widths}
                  gutterWidth={gutterWidth}
                  totalWidth={totalWidth}
                  looks={looks}
                  activeCol={selected?.row === r ? selected.col : -1}
                  multi={multi}
                  selC0={inBlock ? rect!.c0 : -1}
                  selC1={inBlock ? rect!.c1 : -1}
                  findSet={findSet}
                  findCol={findCurrent?.row === r ? findCurrent.col : -1}
                  edit={editing?.rowState(r)}
                  editVersion={editing?.version}
                  ariaRow0={preview.length + inserts.length + 2}
                  activeId={selected?.row === r ? activeId : undefined}
                  looked={!!qlRow && selected?.row === r}
                />
              );
            })}
            {editor && "row" in editor.target && renderEditor(editor.target.row * ROW_HEIGHT)}
          </div>
          {rowCount === 0 && emptyNote && (
            <div className="rg-empty" data-empty-filter>
              {emptyNote}
            </div>
          )}
        </div>
      </div>
    </>
  );
}
