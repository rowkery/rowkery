import { useEffect, useMemo, useRef, useState } from "react";
import { ChevronDownIcon, ChevronUpIcon, CopyIcon, KeyIcon } from "./icons";
import { InspectorButton, InspectorHead } from "./Inspector";
import { isMacPlatform } from "./platform";
import { showToast, toastPreview } from "./notify";
import { commandKeys, keysFor } from "./commands";
import { firstLine } from "./comments";
import { INCOMING_CAP, type FollowLookup } from "./api";
import type { KeyColumns, RowEditState } from "./gridTypes";
import type { Column, QueryResultDto, Value } from "./types";
import { safeFormatCell } from "./types";
import { jsonEditorText } from "./editBuffer";
import { Keys } from "./Keys";

/** Reads the row a foreign key points at, as a short label (`Kiosk Bangsar · KL`). */
export type FollowKey = (column: string, value: Value) => Promise<string | null>;

/** Where a key leads: rows of `schema.table` whose `column` holds the value. */
export interface KeyTarget {
  schema: string;
  table: string;
  column: string;
}

/** A table whose single-column foreign key points at this one. */
export interface IncomingRef extends KeyTarget {
  /** The column of ours it references. */
  refColumn: string;
}

/** What Quick Look follows and counts, from the catalog (Workspace builds it). */
export interface QuickLookLinks {
  /** Our single-column foreign keys, by column. */
  outgoing: ReadonlyMap<string, KeyTarget>;
  incoming: IncomingRef[];
  /**
   * A label already fetched (speculatively, when the row was selected): a
   * string, null when no row matched, undefined when not fetched yet. Read
   * during render, so Space opens with the labels in place.
   */
  peek: (column: string, value: Value) => string | null | undefined;
  /** Opens the target's matching rows in the Preview tab (`own`: a tab of their own). */
  follow: (target: KeyTarget, value: Value, own: boolean) => void;
  countIncoming: (lookups: FollowLookup[]) => Promise<(number | null)[]>;
}

/** Incoming lists this many tables; the rest are counted in a "more" line. */
const MAX_INCOMING = 8;

interface Props {
  columns: Column[];
  row: unknown[];
  /** 1-based, for the header. */
  rowNumber: number;
  rowCount: number;
  tableName?: string;
  keyColumns?: KeyColumns | null;
  /** COMMENT ON COLUMN by name, printed dim under the field name. */
  comments?: ReadonlyMap<string, string> | null;
  followKey?: FollowKey;
  links?: QuickLookLinks | null;
  /** The selected cell's column: its key line takes focus first. */
  column?: string;
  /** The row's staged state: edited values read in the accent, a delete mark strikes them. */
  edit?: RowEditState;
  /** ↑ / ↓ in the head: the grid's ring moves, and Quick Look with it. */
  onPrev?: () => void;
  onNext?: () => void;
  onClose: () => void;
  onCopyJson: () => void;
  /** Delete row ⌫ / Restore row; absent where the rows can't be edited. */
  onToggleDelete?: () => void;
}


async function copyValue(text: string) {
  try {
    await navigator.clipboard.writeText(text);
    showToast("Copied", toastPreview(text) || "empty");
  } catch {
    showToast("Couldn't copy", undefined, "error");
  }
}

function isNull(cell: unknown) {
  return cell == null || (typeof cell === "object" && "Null" in cell);
}

const TITLE_COLUMN = /^(name|title|label|display_name|full_name|username|email|code|slug)$|_name$/i;
const NOT_A_TITLE = /^(uuid|json|jsonb|timestamp|date|time|numeric|decimal|money|real|double|float|int|bigint|smallint|serial|bool)/i;

/**
 * The row's title: its first name-like text value (`Kiosk Bangsar`), else
 * `#48207` (its primary key: the head already names the table), else its
 * first text value, else `Row 12`.
 */
export function quickLookTitle(columns: Column[], row: unknown[], pkIndex: number, rowNumber: number): string {
  const texts = columns
    .map((c, i) => ({ c, v: row[i] as Record<string, unknown> | null }))
    .filter(({ c, v }) => v && typeof v === "object" && "Text" in v && String(v.Text).trim() !== "" && !NOT_A_TITLE.test(c.type_name));
  const named = texts.find(({ c }) => TITLE_COLUMN.test(c.name));
  if (named) return String(named.v!.Text);
  if (pkIndex >= 0 && !isNull(row[pkIndex])) return `#${safeFormatCell(row[pkIndex])}`;
  return texts[0] ? String(texts[0].v!.Text) : `Row ${rowNumber.toLocaleString()}`;
}

/** A focusable line: an outgoing key (by column) or an Incoming table (by index). */
type Line = { kind: "out"; column: string } | { kind: "in"; index: number };
const lineId = (l: Line) => (l.kind === "out" ? `out:${l.column}` : `in:${l.index}`);

/**
 * Quick Look (Space in the grid, like Finder), in the inspector column on the
 * right (Paper, 2026-10-10; it was a floating card): the selected row,
 * titled by its name, one field per line, foreign keys followed to a label of
 * the row they point at, and the tables whose rows point at this one
 * (Incoming). ↑↓ walk the rows; ⇥ moves between key lines, → follows the
 * focused one (⌘→ into a tab of its own); ⌘C copies the row as JSON, ⌫ marks
 * it for delete; Esc or Space closes.
 */
export function QuickLook({
  columns,
  row,
  rowNumber,
  rowCount,
  tableName,
  keyColumns,
  comments,
  followKey,
  links,
  column,
  edit,
  onPrev,
  onNext,
  onClose,
  onCopyJson,
  onToggleDelete,
}: Props) {
  const pkIndex = columns.findIndex((c) => keyColumns?.pk.has(c.name));
  const title = quickLookTitle(columns, row, pkIndex, rowNumber);
  const cellOf = (name: string) => row[columns.findIndex((c) => c.name === name)];
  const deleted = edit?.mark === "delete";

  // Labels fetched ahead of Space read from `peek`; any other lands as it answers.
  const [followed, setFollowed] = useState<Record<string, string | null>>({});
  useEffect(() => {
    setFollowed({});
    if (!followKey || !keyColumns?.fk.size) return;
    let live = true;
    columns.forEach((c, i) => {
      const cell = row[i];
      if (!keyColumns.fk.has(c.name) || isNull(cell)) return;
      if (links?.peek(c.name, cell as Value) !== undefined) return;
      followKey(c.name, cell as Value)
        .then((label) => {
          if (live) setFollowed((prev) => ({ ...prev, [c.name]: label }));
        })
        .catch(() => {});
    });
    return () => {
      live = false;
    };
  }, [row, columns, keyColumns, followKey, links]);
  const labelOf = (name: string, cell: unknown): string | null | undefined =>
    name in followed ? followed[name] : links?.peek(name, cell as Value);

  // Incoming: counted once the card shows a row (never speculatively), a
  // dash until the count lands.
  const incoming = useMemo(
    () => (links?.incoming ?? []).filter((r) => columns.some((c) => c.name === r.refColumn)),
    [links, columns],
  );
  const [counts, setCounts] = useState<(number | null)[] | null>(null);
  useEffect(() => {
    setCounts(null);
    if (!links || !incoming.length) return;
    let live = true;
    const shown = incoming.slice(0, MAX_INCOMING);
    // Walking rows with ↑↓ only counts the row it settles on.
    const t = window.setTimeout(() => {
      const lookups = shown.map((r) => {
        const value = row[columns.findIndex((c) => c.name === r.refColumn)];
        return { schema: r.schema, table: r.table, column: r.column, value: (isNull(value) ? null : value) as Value };
      });
      links
        .countIncoming(lookups)
        .then((n) => live && setCounts(n))
        .catch(() => live && setCounts(shown.map(() => null)));
    }, 80);
    return () => {
      live = false;
      window.clearTimeout(t);
    };
  }, [row, columns, incoming, links]);

  // One key line carries focus: the selected cell's column when it is a key,
  // else the first. ⇥ / ⇧⇥ move it through the keys, then Incoming.
  const lines = useMemo<Line[]>(() => {
    const out: Line[] = columns
      .filter((c, i) => links?.outgoing.has(c.name) && !isNull(row[i]))
      .map((c) => ({ kind: "out", column: c.name }));
    incoming.slice(0, MAX_INCOMING).forEach((_, index) => out.push({ kind: "in", index }));
    return out;
  }, [columns, row, links, incoming]);
  const [focusId, setFocusId] = useState<string | null>(null);
  const focus =
    lines.find((l) => lineId(l) === focusId) ??
    lines.find((l) => l.kind === "out" && l.column === column) ??
    lines[0];
  useEffect(() => setFocusId(null), [column, rowNumber]);

  const followLine = (l: Line, own: boolean) => {
    if (!links) return;
    if (l.kind === "out") {
      const target = links.outgoing.get(l.column);
      if (target) links.follow(target, cellOf(l.column) as Value, own);
      return;
    }
    const ref = incoming[l.index];
    // Nothing references this row there: nothing to open.
    if (!ref || counts?.[l.index] === 0) return;
    links.follow(ref, cellOf(ref.refColumn) as Value, own);
  };

  // The grid keeps the keyboard; Quick Look takes ⇥ and → from its own
  // window's grid while open.
  // The inspector's aside is Workspace's (one aside across Quick Look and
  // Review SQL, so switching glides its width): found from a marker in it.
  const edgeRef = useRef<HTMLSpanElement>(null);
  const asideRef = { get current() { return edgeRef.current?.closest<HTMLElement>(".inspector") ?? null; } };
  const keys = useRef({ lines, focus, followLine });
  keys.current = { lines, focus, followLine };
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const aside = asideRef.current;
      const grid = (e.target as Element | null)?.closest?.(".results-grid-wrap");
      // The copy Presence keeps while it fades out doesn't answer.
      if (!aside || !grid || aside.closest("[data-closing]") || !aside.closest(".workspace")?.contains(grid)) return;
      const { lines, focus, followLine } = keys.current;
      const mod = e.metaKey || e.ctrlKey;
      if (!lines.length || e.altKey) return;
      if (e.key === "Tab" && !mod) {
        e.preventDefault();
        e.stopPropagation();
        const at = focus ? lines.findIndex((l) => lineId(l) === lineId(focus)) : -1;
        setFocusId(lineId(lines[(at + (e.shiftKey ? -1 : 1) + lines.length) % lines.length]));
      } else if (e.key === "ArrowRight" && !e.shiftKey && focus) {
        e.preventDefault();
        e.stopPropagation();
        followLine(focus, mod);
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, []);

  const focused = focus ? lineId(focus) : null;
  const more = incoming.length - MAX_INCOMING;
  const mac = isMacPlatform();
  const meta = `${tableName ?? "Result"} · ${rowNumber.toLocaleString()} of ${rowCount.toLocaleString()}`;

  return (
    <>
      <span ref={edgeRef} hidden />
      <InspectorHead
        data-testid="ql-head"
        onClose={onClose}
        tools={
          <>
            <InspectorButton label="Previous row  ↑" ariaLabel="Previous row" data-ql-prev disabled={!onPrev || rowNumber <= 1} onClick={() => onPrev?.()}>
              <ChevronUpIcon size={12} />
            </InspectorButton>
            <InspectorButton label="Next row  ↓" ariaLabel="Next row" data-ql-next disabled={!onNext || rowNumber >= rowCount} onClick={() => onNext?.()}>
              <ChevronDownIcon size={12} />
            </InspectorButton>
          </>
        }
      >
        <span className="insp-label">Row</span>
        <small className="insp-meta" title={meta}>
          {meta}
        </small>
      </InspectorHead>
      <div className="ql-top">
        <div data-testid="ql-title" className="ql-title" title={title}>
          {pkIndex >= 0 && <KeyIcon size={14} />}
          <span>{title}</span>
        </div>
        {deleted && (
          <div className="ql-badge" data-ql-deleted>
            Marked for deletion
          </div>
        )}
      </div>
      <div className="ql-scroll">
        <dl className="ql-body">
          {columns.map((c, i) => {
            const cell = row[i];
            const nul = isNull(cell);
            const fk = keyColumns?.fk.has(c.name);
            const target = nul ? undefined : links?.outgoing.get(c.name);
            const label = fk && !nul ? labelOf(c.name, cell) : undefined;
            const line = `out:${c.name}`;
            const text = nul ? "NULL" : safeFormatCell(cell);
            const json = /^jsonb?$/i.test(c.type_name);
            const staged = edit?.cells.has(i);
            return (
              <div
                className={`ql-field${target ? " ql-key" : ""}${focused === line ? " ql-focus" : ""}`}
                key={`${i}:${c.name}`}
                data-key-line={target ? c.name : undefined}
                data-focused={focused === line ? "" : undefined}
                data-staged={staged ? "" : undefined}
              >
                {/* The type is drawn by CSS (data-type), so the name reads alone. */}
                <dt data-type={c.type_name}>
                  {c.name}
                  {comments?.has(c.name) && (
                    <small className="ql-comment" data-comment={c.name} title={comments.get(c.name)}>
                      {firstLine(comments.get(c.name))}
                    </small>
                  )}
                </dt>
                <button
                  type="button"
                  className="ql-copy"
                  data-copy-value={c.name}
                  title={`Copy ${c.name}`}
                  aria-label={`Copy ${c.name}`}
                  tabIndex={-1}
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={() => void copyValue(text)}
                >
                  <CopyIcon size={12} />
                </button>
                <dd className={nul || text === "" ? "ql-null" : json ? "ql-json" : undefined}>
                  <span className="ql-value">{nul ? "NULL" : json ? jsonEditorText(text) : text === "" ? "—" : text}</span>
                  {(label !== undefined || target) && (
                    <span className="ql-follow-line">
                      {target && label !== null && (
                        <button
                          type="button"
                          className="ql-arrow"
                          data-follow-arrow={c.name}
                          title={`Open ${target.table} where ${target.column} = ${text}`}
                          tabIndex={-1}
                          onMouseDown={(e) => e.preventDefault()}
                          onClick={(e) => followLine({ kind: "out", column: c.name }, e.metaKey || e.ctrlKey)}
                        >
                          → {target.table} #{text}
                        </button>
                      )}
                      <span
                        className={`ql-follow${label === null ? " ql-missing" : ""}`}
                        data-follow={label ? c.name : undefined}
                        data-follow-state={label ? "label" : label === null ? "missing" : "loading"}
                        title={label ?? undefined}
                      >
                        {label ?? (label === null && target ? `no matching ${target.table} row` : "")}
                      </span>
                    </span>
                  )}
                </dd>
              </div>
            );
          })}
        </dl>
        {incoming.length > 0 && (
          <section className="ql-incoming" aria-label="Incoming" data-incoming={incoming.length}>
            <h4>Incoming</h4>
            {incoming.slice(0, MAX_INCOMING).map((r, index) => {
              const n = counts?.[index];
              const line = `in:${index}`;
              const zero = n === 0;
              return (
                <div
                  key={`${r.schema}.${r.table}.${r.column}`}
                  className={`ql-in-row${zero ? " ql-zero" : ""}${focused === line ? " ql-focus" : ""}`}
                  data-incoming-row={r.table}
                  data-count={n == null ? "" : String(n)}
                  data-focused={focused === line ? "" : undefined}
                  title={`${r.table}.${r.column} → ${r.refColumn}`}
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={(e) => !zero && followLine({ kind: "in", index }, e.metaKey || e.ctrlKey)}
                >
                  <span className="ql-in-name">{r.table}</span>
                  <span className="ql-in-count">
                    {n == null ? "—" : `${n > INCOMING_CAP ? `${INCOMING_CAP}+` : n.toLocaleString()} ${n === 1 ? "row" : "rows"}`}
                  </span>
                  <span className="ql-in-arrow">{zero ? "" : "→"}</span>
                </div>
              );
            })}
            {more > 0 && <div className="ql-in-more">{more} more in Structure</div>}
          </section>
        )}
      </div>
      <footer data-testid="ql-foot" className="insp-foot ql-foot">
        <button
          type="button"
          className="insp-btn grow"
          data-ql-copy-json
          title={`Copy the row as JSON  ${commandKeys("copy-cells")}`}
          tabIndex={-1}
          onMouseDown={(e) => e.preventDefault()}
          onClick={onCopyJson}
        >
          Copy JSON <kbd><Keys text={commandKeys("copy-cells")} /></kbd>
        </button>
        {onToggleDelete && (
          <button
            type="button"
            className="insp-btn grow ql-delete"
            data-ql-delete={deleted ? "restore" : "delete"}
            tabIndex={-1}
            onMouseDown={(e) => e.preventDefault()}
            onClick={onToggleDelete}
          >
            {deleted ? "Restore row" : "Delete row"} <kbd><Keys text={keysFor("delete-row", mac)} /></kbd>
          </button>
        )}
      </footer>
    </>
  );
}

/** The row as a JSON object, column name to value (numbers stay numbers, exactly). */
export function rowToJson(columns: Column[], row: unknown[]): string {
  const out: Record<string, unknown> = {};
  // A BigInt goes in as a marked string and comes out as its bare digits.
  const big = "\u0000bigint:";
  // jsonb goes in as a marked index and comes out as its own text: parsing
  // it would round numbers past 2^53 and turn `1.0` into `1`.
  const json = "\u0000json:";
  const raw: string[] = [];
  columns.forEach((c, i) => {
    const cell = row[i] as Record<string, unknown> | undefined;
    if (!cell || typeof cell !== "object" || "Null" in cell) out[c.name] = null;
    else if ("Bool" in cell) out[c.name] = cell.Bool;
    else if ("Int" in cell) out[c.name] = cell.Int;
    else if ("BigInt" in cell) out[c.name] = big + String(cell.BigInt);
    else if ("Float" in cell) out[c.name] = cell.Float;
    else if ("Text" in cell) {
      const t = String(cell.Text);
      // jsonb comes back as text: keep it as an object, exactly as stored.
      if (/^json/i.test(c.type_name)) {
        try {
          JSON.parse(t);
          out[c.name] = json + raw.length;
          raw.push(t.trim());
          return;
        } catch {
          /* fall through */
        }
      }
      out[c.name] = t;
    } else out[c.name] = safeFormatCell(cell);
  });
  return JSON.stringify(out, null, 2)
    .replace(/"\\u0000bigint:(-?\d+)"/g, "$1")
    .replace(/"\\u0000json:(\d+)"/g, (_, i: string) => raw[Number(i)]);
}

/** Quotes an identifier the same way in Postgres and SQLite. */
export function quoteIdent(name: string): string {
  return `"${name.replace(/"/g, '""')}"`;
}

/** A cell as a SQL literal to match a key on; null when it can't be one. */
export function sqlLiteral(value: Value): string | null {
  const v = value as Record<string, unknown>;
  if ("BigInt" in v) return /^-?\d+$/.test(String(v.BigInt)) ? String(v.BigInt) : null;
  if ("Int" in v || "Float" in v) {
    const n = Number(v.Int ?? v.Float);
    return Number.isFinite(n) ? String(n) : null;
  }
  if ("Text" in v) return `'${String(v.Text).replace(/'/g, "''")}'`;
  if ("Bool" in v) return v.Bool ? "TRUE" : "FALSE";
  return null;
}

const LABEL_COLUMN = /^(name|title|label|display_name|full_name|username|email|code|slug)$/i;

/**
 * A short label for the row a key points at: its name-like columns first,
 * else the first couple of text columns (`Kiosk Bangsar · Kuala Lumpur`).
 */
export function rowLabel(res: QueryResultDto, keyColumn: string): string | null {
  if (res.rows.length === 0) return null;
  return followLabel({ columns: res.columns, row: res.rows.row(0, res.columns.length) }, keyColumn);
}

/** `rowLabel` for a row `follow_keys` found. */
export function followLabel(found: { columns: Column[]; row: unknown[] }, keyColumn: string): string | null {
  const { columns, row } = found;
  const texts = columns
    .map((c, i) => ({ c, v: row[i] as Record<string, unknown> }))
    .filter(({ c, v }) => c.name !== keyColumn && v && "Text" in v && String(v.Text).trim() !== "")
    .filter(({ c }) => !/^(uuid|json|jsonb|timestamp|date|time)/i.test(c.type_name));
  const named = texts.filter(({ c }) => LABEL_COLUMN.test(c.name) || /_name$/i.test(c.name));
  const picked = (named.length ? named : texts).slice(0, 2);
  if (!picked.length) return null;
  return picked.map(({ v }) => String(v.Text)).join(" · ");
}
