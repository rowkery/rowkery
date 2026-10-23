import { useCallback, useMemo, useRef, useState } from "react";
import { browseTable } from "./api";
import type { KeyChoice } from "./CellEditor";
import {
  addInserts,
  changeCount,
  columnEditor,
  commitNeedsReview,
  editRefusal,
  emptyBuffer,
  parseInput,
  removeInsert,
  revertCell,
  rowKey,
  setInsertCell,
  stageCell,
  toggleDeletes,
  type ColumnEditor,
  type EditBuffer,
  type KeyCells,
} from "./editBuffer";
import { showToast } from "./notify";
import { followLabel } from "./QuickLook";
import { ResultRows, useResultRows } from "./resultStore";
import type { EditTarget, GridEditing, RowEditState } from "./gridTypes";
import type { EnumNode, QueryResultDto, SafeMode, TableNode, Value } from "./types";

const NO_ROWS = new ResultRows();

/** The foreign key picker reads on its own session, never the tab's (its transaction, its cursor). */
const PICKER_TAB = 1_000_000;

/** New rows' ids: unique across relaunches, since buffers are saved. */
let nextInsertId = Date.now();

const isNullValue = (v: Value | null | undefined) => !v || "Null" in v;

interface Options {
  windowId: string;
  /** The connection the window is on: only a buffer staged on it shows, and new edits stage on it. */
  connectionId: string | null;
  /** The shown tab: a table tab's id, table and buffer. */
  tab: { id: number; kind: string; tableKey?: string; schema?: string; edits?: EditBuffer } | undefined;
  setEdits: (tabId: number, edits: EditBuffer | undefined) => void;
  result: QueryResultDto | null;
  table: TableNode | undefined;
  /** Another table of the catalog (the foreign key picker's). */
  findTable: (schema: string, table: string) => TableNode | undefined;
  engine: "postgres" | "sqlite";
  safeMode: SafeMode;
  enums: EnumNode[];
  /** The Data view of a finished result is shown. */
  shown: boolean;
  /** ↵ where nothing can be edited: the tray says why. */
  onRefused: (reason: string) => void;
}

/**
 * A table tab's staged edits as the grid sees them: which cells have an
 * editor, each loaded row's marks (found by its primary key), the new rows,
 * and the calls that stage into the tab's buffer. Nothing here writes.
 */
export function useRowEdits(o: Options) {
  const { tab, result, table, engine } = o;
  const tableTab = tab?.kind === "table" && !!tab.tableKey && !!result && !result.error && result.columns.length > 0;
  const buffer =
    tableTab && tab?.edits?.tableKey === tab?.tableKey && tab?.edits?.connectionId === o.connectionId
      ? (tab?.edits ?? null)
      : null;
  const columns = useMemo(() => result?.columns ?? [], [result?.columns]);
  const rows = result?.rows ?? NO_ROWS;
  const rowCount = useResultRows(rows);
  const names = useMemo(() => columns.map((c) => c.name), [columns]);
  const refusal = tableTab ? editRefusal(table, o.safeMode, names) : null;
  const pk = useMemo(() => table?.primary_key ?? [], [table]);
  const optsRef = useRef(o);
  optsRef.current = o;
  const [focusInsert, setFocusInsert] = useState<number>();
  const [selection, setSelection] = useState<{ rows: number[]; whole: boolean; col: number }>({ rows: [], whole: false, col: -1 });

  const editors = useMemo((): (ColumnEditor | null)[] => {
    const byName = new Map((table?.columns ?? []).map((c) => [c.name, c]));
    const fks = new Map(
      (table?.foreign_keys ?? [])
        .filter((f) => f.columns.length === 1)
        .map((f) => [f.columns[0], { schema: f.ref_schema, table: f.ref_table, column: f.ref_columns[0] }]),
    );
    return columns.map((c) => {
      const col = byName.get(c.name);
      const ed = col ? columnEditor(col, engine, o.enums) : null;
      const fk = fks.get(c.name);
      return ed && fk ? { ...ed, fk } : ed;
    });
  }, [columns, table, engine, o.enums]);

  /** A loaded row's key, or null when it can't name the row (a key cell missing, NULL or bytes). */
  const keyOf = useCallback(
    (r: number): KeyCells | null => {
      const key: KeyCells = [];
      for (const column of pk) {
        const ci = names.indexOf(column);
        if (ci < 0 || r >= rows.length || rows.isNull(r, ci)) return null;
        const value = rows.get(r, ci);
        if ("Bytes" in value) return null;
        key.push({ column, value });
      }
      return key.length ? key : null;
    },
    [pk, names, rows],
  );

  // Loaded rows by key, only while rows are edited or marked.
  const marked = !!buffer && (Object.keys(buffer.updates).length > 0 || Object.keys(buffer.deletes).length > 0);
  const states = useMemo(() => {
    const out = new Map<number, RowEditState>();
    if (!buffer || !marked) return out;
    const want = new Set([...Object.keys(buffer.updates), ...Object.keys(buffer.deletes)]);
    for (let r = 0; r < rowCount && want.size; r++) {
      const key = keyOf(r);
      const k = key && rowKey(key);
      if (!k || !want.has(k)) continue;
      want.delete(k);
      const cells = new Map<number, { value: Value | null; was: Value | null }>();
      const u = buffer.updates[k];
      if (u) for (const [name, value] of Object.entries(u.set)) cells.set(names.indexOf(name), { value, was: u.was[name] ?? null });
      out.set(r, { mark: k in buffer.deletes ? "delete" : "edit", cells });
    }
    return out;
  }, [buffer, marked, rowCount, keyOf, names]);

  const update = useCallback((next: (b: EditBuffer) => EditBuffer) => {
    const { tab: t, setEdits, connectionId } = optsRef.current;
    if (!t?.tableKey || !connectionId) return;
    // Another connection's buffer is on its way to being parked: never staged over.
    if (t.edits && t.edits.connectionId !== connectionId) return;
    const cur = t.edits?.tableKey === t.tableKey ? t.edits : emptyBuffer(t.tableKey, connectionId);
    const b = next(cur);
    setEdits(t.id, changeCount(b) ? b : undefined);
  }, []);

  const stage = useCallback(
    (target: EditTarget, col: number, value: Value | null) => {
      const name = names[col];
      if (name === undefined) return;
      if ("insert" in target) return update((b) => setInsertCell(b, target.insert, name, value));
      const key = keyOf(target.row);
      if (!key) return optsRef.current.onRefused("This row's key can't name it");
      const was = rows.isNull(target.row, col) ? null : rows.get(target.row, col);
      update((b) => stageCell(b, key, name, value, was, editors[col]?.kind));
    },
    [names, keyOf, rows, update, editors],
  );

  const insertRow = useCallback(() => {
    const id = ++nextInsertId;
    update((b) => addInserts(b, [{ id, values: {} }]));
    setFocusInsert(id);
  }, [update]);

  /** Copies of loaded rows as new rows: a key column with a default (serial, identity) is left to it. */
  const duplicate = useCallback(
    (picked: number[]) => {
      const defaults = new Set((table?.columns ?? []).filter((c) => c.default).map((c) => c.name));
      const copies = picked
        .filter((r) => r < rows.length)
        .map((r) => {
          const values: Record<string, Value | null> = {};
          columns.forEach((c, ci) => {
            if ((pk.includes(c.name) && defaults.has(c.name)) || !editors[ci]) return;
            const v = rows.get(r, ci);
            // Bytes arrive cut short and undecoded types as `<name>`: never copied.
            if ("Bytes" in v || ("Text" in v && v.Text === `<${c.type_name}>`)) return;
            values[c.name] = isNullValue(v) ? null : v;
          });
          return { id: ++nextInsertId, values };
        });
      if (copies.length) update((b) => addInserts(b, copies.reverse()));
    },
    [table, rows, columns, pk, editors, update],
  );

  const toggleDelete = useCallback(
    (picked: number[]) => {
      const keys = picked.map(keyOf);
      if (!keys.length || keys.some((k) => !k)) return optsRef.current.onRefused("These rows' keys can't name them");
      update((b) => toggleDeletes(b, keys as KeyCells[]));
    },
    [keyOf, update],
  );

  /** A pasted block, cell by cell from the ring; what falls outside, or doesn't parse, is left. */
  const paste = useCallback(
    (row: number, col: number, block: (string | null)[][]) => {
      let total = 0;
      let staged = 0;
      update((b) => {
        let next = b;
        block.forEach((line, i) =>
          line.forEach((text, j) => {
            total++;
            const r = row + i;
            const c = col + j;
            const ed = editors[c];
            const key = r < rows.length ? keyOf(r) : null;
            if (!ed || !key || states.get(r)?.mark === "delete") return;
            // In a text column only the grid's own copy (`null`) is NULL; "NULL" and "" stay text.
            const asNull = text === null || (ed.kind !== "text" && (text === "" || text === "NULL"));
            const parsed = asNull ? { value: null } : parseInput(ed.kind, text);
            if ("error" in parsed) return;
            next = stageCell(next, key, names[c], parsed.value, rows.isNull(r, c) ? null : rows.get(r, c), ed.kind);
            staged++;
          }),
        );
        return next;
      });
      if (staged < total) showToast(`Pasted ${staged} of ${total} cells · the rest fell outside the table`);
      else showToast(`Pasted ${staged} ${staged === 1 ? "cell" : "cells"}`);
    },
    [editors, rows, keyOf, names, states, update],
  );

  /** The picker: rows of the referenced table whose key or text columns hold the query. */
  const searchKey = useCallback(async (col: number, query: string): Promise<KeyChoice[]> => {
    const { windowId, findTable, engine: eng, tab: t } = optsRef.current;
    const fk = editors[col]?.fk;
    if (!fk || !t) return [];
    const ref = findTable(fk.schema, fk.table);
    const quote = (n: string) => `"${n.replace(/"/g, '""')}"`;
    const searched = [fk.column, ...(ref?.columns ?? []).filter((c) => /char|text|clob/i.test(c.type_name)).map((c) => c.name)]
      .filter((c, i, all) => all.indexOf(c) === i)
      .slice(0, 4);
    const q = query.trim().replace(/'/g, "''");
    const like = eng === "postgres" ? "ILIKE" : "LIKE";
    const filter = q ? searched.map((c) => `CAST(${quote(c)} AS TEXT) ${like} '%${q}%'`).join(" OR ") : undefined;
    const res = await browseTable(windowId, PICKER_TAB + t.id, {
      engine: eng,
      schema: fk.schema,
      table: fk.table,
      filter,
      limit: 8,
    });
    if (res.error) return [];
    const at = res.columns.findIndex((c) => c.name === fk.column);
    if (at < 0) return [];
    const out: KeyChoice[] = [];
    for (let r = 0; r < res.rows.length; r++) {
      const row = res.rows.row(r, res.columns.length);
      const label = followLabel({ columns: res.columns, row }, fk.column);
      out.push({ value: row[at], label: label ? `${res.rows.text(r, at)} · ${label}` : res.rows.text(r, at) });
    }
    return out;
  }, [editors]);

  // Bumps with every new buffer: rows redraw their marks.
  const versions = useRef<{ buffer: EditBuffer | null; n: number }>({ buffer: null, n: 0 });
  if (versions.current.buffer !== buffer) versions.current = { buffer, n: versions.current.n + 1 };
  const version = versions.current.n;
  const editing = useMemo((): GridEditing | null => {
    if (!tableTab || !o.shown) return null;
    return {
      refusal,
      onRefused: () => refusal && optsRef.current.onRefused(refusal),
      editors,
      inserts: (buffer?.inserts ?? []).map((ins) => ({
        id: ins.id,
        cells: names.map((n) => (n in ins.values ? ins.values[n] : undefined)),
      })),
      rowState: (r) => states.get(r),
      version,
      stage,
      revert: (target, col) => {
        if ("insert" in target) return update((b) => setInsertCell(b, target.insert, names[col], undefined));
        const key = keyOf(target.row);
        if (key) update((b) => revertCell(b, key, names[col]));
      },
      insertRow,
      removeInsert: (id) => update((b) => removeInsert(b, id)),
      duplicate,
      toggleDelete,
      paste,
      searchKey,
      focusInsert,
      onSelection: (picked, whole, col) => setSelection({ rows: picked, whole, col }),
    };
  }, [tableTab, o.shown, refusal, editors, buffer, version, names, states, stage, update, keyOf, insertRow, duplicate, toggleDelete, paste, searchKey, focusInsert]);

  const rowsEditable = !!editing && !refusal;
  const cellEditable = rowsEditable && selection.col >= 0 && !!editors[selection.col];
  const oneRow = selection.rows.length === 1 ? selection.rows[0] : undefined;
  let loadedDeleted = 0;
  for (const s of states.values()) if (s.mark === "delete") loadedDeleted++;
  return {
    editing,
    buffer,
    count: changeCount(buffer),
    /** ⌘S shows Review SQL first: many deletes, or every loaded row marked (⌘A ⌫). */
    reviewFirst: commitNeedsReview(buffer, rowCount, loadedDeleted),
    refusal: tableTab ? refusal : null,
    rowsEditable,
    cellEditable,
    /** Set NULL can run: the column takes NULL and the row isn't marked for delete (as the grid's ⌥⇧N checks). */
    cellNullable:
      cellEditable && !!editors[selection.col]?.nullable && (oneRow === undefined || states.get(oneRow)?.mark !== "delete"),
    rowsSelected: rowsEditable && selection.whole && selection.rows.length > 0,
    insertRow,
    duplicateSelected: () => duplicate(selection.rows),
  };
}
