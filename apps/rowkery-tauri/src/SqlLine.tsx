import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { GridMenu, useContextMenu } from "./GridMenu";
import { chipMenu } from "./contextMenus";
import { showToast } from "./notify";
import { CloseIcon, RefreshIcon } from "./icons";
import { isMacPlatform } from "./platform";
import { commandKeys, commandTip } from "./commands";
import { COLLAPSE_COLUMNS, lineWithFilter, sqlLineParts, type SqlLineSegment } from "./sqlLineParts";
import { highlightSqlLines } from "./sqlHighlight";
import { formatStats, type SelectionStats } from "./selectionStats";
import { formatMs } from "./types";
import "./SqlLine.css";
import { keysFor } from "./commands";
import { Keys } from "./Keys";

interface SqlLineProps {
  /** The first page's SQL as core builds it; null until it's known. */
  sql: string | null;
  /** The WHERE text `sql` ran with, and the tab's now (its chips'). */
  ranFilter: string;
  filter: string;
  /** Each chip's SQL, in clause order (`chipFragments`), its kind, and its plain words. */
  chips: { sql: string; kind: string; words?: string }[];
  /** The chip editor (⌘F): in chip `editingChip`'s place, or after the last chip. */
  filterEditor?: ReactNode;
  editingChip?: number | null;
  onFilter: () => void;
  onChipEdit: (index: number) => void;
  onChipRemove: (index: number) => void;
  /** A chip's menu: Remove all filters. */
  onChipsClear: () => void;
  /** Rows shown, and what the count reads from. */
  rows: number | null;
  /** The catalog's estimate (≈), when the tab isn't filtered. */
  estimate: number | null;
  /** An exact count, once asked for. */
  exact: number | null;
  counting: boolean;
  onCount: () => void;
  onCancelCount: () => void;
  hasMore: boolean;
  elapsedMs: number | null;
  /** A selected block: count · sum · avg in place of the row count. */
  stats: SelectionStats | null;
  /** The right end while a page runs (Running · 1.2 s · Cancel). */
  running?: ReactNode;
  error: boolean;
  /** A flash message (copied, exported…) in the right end for a moment. */
  notice?: string | null;
  pageSize: number;
  onPageSize: (rows: number) => void;
  pageSizes: number[];
  onLoadMore: () => void;
  noKey: boolean;
  onEditSql: () => void;
  /** One tip at a time, 12 px, under the line (Tips.ts), and which (`data-tip`). */
  tip?: string | null;
  tipId?: string;
  /** ↻ / ⇧⌘R: the first page again. */
  onRefresh: () => void;
  /** The clause the last gesture changed: washed for 600 ms (`n` restarts it). */
  wash?: LineWash | null;
  /** The results zone's `…`, at the WHERE row's end. */
  menu?: ReactNode;
  /** The tab is sorted: a "Clear sort" link at the WHERE row's end. */
  sorted?: boolean;
  onClearSort?: () => void;
}

/** A gesture's changed clause: the ORDER BY, the SELECT list, the WHERE (chips) or the LIMIT. */
export interface LineWash {
  clause: "order" | "select" | "where" | "limit";
  n: number;
}

/** How long the neutral wash stays on a rewritten clause. */
const WASH_MS = 600;

/**
 * A table tab's head, two rows under the tab row (Paper, chosen on
 * 2026-10-10 over the one 36 px line). QUERY: the exact SQL that produced the
 * rows, coloured like the editor, LIMIT as the page-size control, and Edit
 * SQL. WHERE: the filters as orange chips joined by AND, wrapping onto more
 * lines rather than scrolling, the dashed + Filter, then the count and time,
 * ≈ exact count, Load more, Clear sort, ↻ and the results `…` at its end.
 */
export function SqlLine(p: SqlLineProps) {
  const mac = isMacPlatform();
  const parts = useMemo(
    () => (p.sql ? sqlLineParts(lineWithFilter(p.sql, p.ranFilter, p.filter), p.filter) : null),
    [p.sql, p.ranFilter, p.filter],
  );
  const chipHtml = useMemo(() => p.chips.map((c) => highlightSqlLines(c.sql)[0] ?? ""), [p.chips]);
  // The chips stand in for the WHERE text only when they are exactly it.
  const chipsShown = !!parts && (parts.where ?? "") === p.chips.map((c) => c.sql).join(" AND ");
  const textRef = useRef<HTMLDivElement>(null);
  const editing = !!p.filterEditor;
  useEffect(() => {
    if (editing) return;
    if (textRef.current) textRef.current.scrollLeft = 0;
  }, [editing, p.sql, p.filter]);
  const [limitMenu, setLimitMenu] = useState<{ x: number; y: number } | null>(null);
  // Right-click a chip: edit, remove, copy its SQL, add another, remove them all.
  const chipMenuAt = useContextMenu<number>();
  const pickChip = (id: string) => {
    const i = chipMenuAt.target;
    if (i === undefined) return;
    if (id === "edit") p.onChipEdit(i);
    else if (id === "remove") p.onChipRemove(i);
    else if (id === "add") p.onFilter();
    else if (id === "clear") p.onChipsClear();
    else if (id === "copy-sql") {
      const sql = p.chips[i]?.sql ?? "";
      navigator.clipboard.writeText(sql).then(
        () => showToast("Copied", sql),
        () => showToast("Couldn't copy", undefined, "error"),
      );
    }
  };
  const n = (v: number) => v.toLocaleString();
  // The wash lasts 600 ms from when the new SQL lands; a new gesture restarts it.
  const [washing, setWashing] = useState<LineWash | null>(null);
  const washed = useRef(0);
  useEffect(() => {
    // Each gesture washes once (not again when its tab is shown again).
    if (!p.wash || p.wash.n === washed.current) return;
    washed.current = p.wash.n;
    setWashing(p.wash);
  }, [p.wash]);
  useEffect(() => {
    if (!washing) return;
    // Only this wash ends: a timer already queued when the next gesture landed must not end that one.
    const t = window.setTimeout(() => setWashing((w) => (w === washing ? null : w)), WASH_MS);
    return () => window.clearTimeout(t);
  }, [washing]);
  // Only on the tab whose gesture it was.
  const washOn = (clause: LineWash["clause"]) => washing?.clause === clause && p.wash?.n === washing.n;
  /** A washed clause remounts (keyed on the gesture) so its animation restarts. */
  const clauseProps = (clause: LineWash["clause"]) =>
    washOn(clause) ? { className: "sql-wash", "data-wash": clause } : {};
  const wn = washing?.n ?? 0;
  /** The head or the rest, clause by clause: SELECT's list and ORDER BY can wash. */
  const segmentSpans = (segs: SqlLineSegment[], part: string) =>
    segs.map((seg, i) => {
      const key = `${part}-${seg.clause}-${i}-${wn}`;
      if (seg.clause === "select" && (seg.columns ?? 0) >= COLLAPSE_COLUMNS) {
        // Display only: the tooltip and Edit SQL keep the whole list.
        return (
          <span key={key} {...clauseProps("select")} data-clause="select" data-collapsed={seg.columns}>
            <span className="n">{seg.columns}</span> columns
          </span>
        );
      }
      if (seg.clause === "select" || seg.clause === "order") {
        return (
          <span key={key} {...clauseProps(seg.clause)} data-clause={seg.clause} dangerouslySetInnerHTML={{ __html: seg.html }} />
        );
      }
      return <span key={key} dangerouslySetInnerHTML={{ __html: seg.html }} />;
    });

  const count = (() => {
    if (p.stats) return <span data-stats>{formatStats(p.stats)}</span>;
    if (p.rows === null) return null;
    const shown = <b>{n(p.rows)}</b>;
    if (p.counting)
      return (
        <span data-count="counting">
          {shown} of Counting…{" "}
          <button type="button" className="sql-line-link" onClick={p.onCancelCount}>
            Cancel
          </button>
        </span>
      );
    if (p.exact !== null)
      return (
        <span data-count="exact">
          {shown} of {n(p.exact)} rows
        </span>
      );
    if (!p.hasMore)
      return (
        <span data-count="all">
          {shown} of {n(p.rows)} rows
        </span>
      );
    return (
      <span data-count="estimate">
        {shown} of{" "}
        <button
          type="button"
          className="sql-line-link"
          data-count-exact
          title={
            p.noKey
              ? "Count rows exactly (pages use OFFSET: no primary key)  #"
              : "Count rows exactly (this is the catalog's estimate)  #"
          }
          onClick={p.onCount}
        >
          {p.estimate !== null ? `≈${n(p.estimate)}` : "≈?"}
        </button>{" "}
        rows
      </span>
    );
  })();

  const addButton = (
    <button type="button" className="sql-line-add" data-add-filter onClick={p.onFilter}>
      + Filter <kbd><Keys text={keysFor("filter-rows", mac)} /></kbd>
    </button>
  );

  const showWhereText = parts?.where != null;
  const editingNew = !!p.filterEditor && (p.editingChip ?? null) === null;
  const whereHtml = showWhereText ? (highlightSqlLines(parts.where ?? "")[0] ?? "") : "";

  /** The WHERE row's filters: the chips (or the free text) joined by a dim AND; the editor in its place. */
  const whereInside = parts && (
    <span className="sql-line-chips" data-sql-where>
      {chipsShown
        ? p.chips.map((c, i) => (
            <span
              // A stable key: the chip editor may live inside (adding the class starts the wash).
              key={i}
              className={`sql-chip-wrap${washOn("where") ? " sql-wash" : ""}`}
              data-wash={washOn("where") ? "where" : undefined}
            >
              {i > 0 && <span data-testid="sql-chip-and" className="sql-chip-and">AND</span>}
              {p.filterEditor && p.editingChip === i ? (
                p.filterEditor
              ) : (
                <span
                  className="sql-chip"
                  data-chip={i}
                  data-chip-kind={c.kind}
                  data-chip-sql={c.sql}
                  role="button"
                  tabIndex={0}
                  title={`${c.words ?? c.sql} · click to edit · ${commandKeys("remove-filter")} removes`}
                  onClick={() => p.onChipEdit(i)}
                  onContextMenu={(e) => chipMenuAt.open(e, i)}
                  onKeyDown={(e) => {
                    if (e.key === "Backspace" || e.key === "Delete") {
                      e.preventDefault();
                      p.onChipRemove(i);
                    } else if (e.key === "Enter") {
                      e.preventDefault();
                      p.onChipEdit(i);
                    }
                  }}
                >
                  <span className="sql-chip-text" dangerouslySetInnerHTML={{ __html: chipHtml[i] }} />
                  <button
                    type="button"
                    className="sql-chip-x"
                    data-chip-remove={i}
                    aria-label="Remove filter"
                    tabIndex={-1}
                    onClick={(e) => {
                      e.stopPropagation();
                      p.onChipRemove(i);
                    }}
                  >
                    <CloseIcon size={8} />
                  </button>
                </span>
              )}
            </span>
          ))
        : showWhereText && (
            <span
              key={`where-${washOn("where") ? wn : 0}`}
              className={`sql-where-text${washOn("where") ? " sql-wash" : ""}`}
              data-wash={washOn("where") ? "where" : undefined}
              dangerouslySetInnerHTML={{ __html: whereHtml }}
            />
          )}
    </span>
  );

  const limitButton = (none: boolean) => (
    <button
      key={`${none ? "all" : "limit"}-${washOn("limit") ? wn : 0}`}
      type="button"
      className={`sql-limit${none ? " sql-limit-none" : ""}${washOn("limit") ? " sql-wash" : ""}`}
      data-wash={washOn("limit") ? "limit" : undefined}
      data-limit={none ? 0 : p.pageSize}
      title="Rows per page"
      onClick={(e) => {
        const r = e.currentTarget.getBoundingClientRect();
        setLimitMenu({ x: r.left, y: r.bottom + 6 });
      }}
    >
      {none ? (
        "all rows ▾"
      ) : (
        <>
          <span className="k">LIMIT</span> <span className="n">{parts?.limit?.replace(/^LIMIT /, "")}</span>
        </>
      )}
    </button>
  );

  return (
    <div className="sql-line" data-sql-line data-editing={p.filterEditor ? "" : undefined}>
      {/* QUERY: the SQL that ran, read-only, LIMIT the page-size control. */}
      <div className="sql-line-query" data-sql-query>
        <span className="sql-line-label sql-line-pill">QUERY</span>
        <div ref={textRef} className="sql-line-text" title={parts?.text} data-sql-text={parts?.text ?? ""}>
          {parts && (
            <>
              <span
                data-testid="sql-line-body"
                className="sql-line-head sql-line-body"
                // Room runs out: ORDER BY … gives way first, then this head.
                style={{ minWidth: `${Math.min(8, parts.headChars)}ch` }}
              >
                {segmentSpans(parts.headSegments, "head")}
              </span>
              {/* Plain tokens: the chips below carry the WHERE's wash. */}
              {showWhereText && (
                <span
                  data-testid="sql-line-body"
                  className="sql-line-where-sql sql-line-body"
                  dangerouslySetInnerHTML={{ __html: `${whereHtml}<span class="p">)</span>` }}
                />
              )}
              <span data-testid="sql-line-body" className="sql-line-rest sql-line-body">{segmentSpans(parts.tailSegments, "rest")}</span>
              {parts.limit && limitButton(false)}
              <span className="sql-line-tail" dangerouslySetInnerHTML={{ __html: parts.afterHtml }} />
              {/* All rows: no LIMIT in the SQL, but the page size still opens from here. */}
              {!parts.limit && limitButton(true)}
            </>
          )}
        </div>
        <button type="button" className="sql-line-edit" data-edit-sql title={commandTip("open-in-query", "Open this exact SQL in a query tab", mac)} onClick={p.onEditSql}>
          Edit SQL
        </button>
      </div>
      {/* WHERE: the chips, wrapping; + Filter; the count and the row's tools at its end. */}
      <div className="sql-line-where" data-testid="sql-line-where">
        <span className="sql-line-label">WHERE</span>
        {whereInside}
        {parts && (editingNew ? p.filterEditor : addButton)}
        <div className="sql-line-end" data-line-end>
          {p.running ?? (
            <>
              {p.notice ? (
                <span className="sql-line-notice">{p.notice}</span>
              ) : p.error ? (
                <span className="sql-line-error">
                  <span className="conn-dot error" /> Error
                </span>
              ) : (
                count && (
                  <span className="sql-line-count">
                    {count}
                    {p.elapsedMs !== null && !p.stats && <span className="sql-line-ms"> · {formatMs(p.elapsedMs)}</span>}
                  </span>
                )
              )}
              {p.hasMore && !p.stats && (
                <button type="button" className="sql-line-link" data-load-more onClick={p.onLoadMore}>
                  Load more
                </button>
              )}
              {p.sorted && p.onClearSort && (
                <button type="button" className="sql-line-link" data-clear-sort onClick={p.onClearSort}>
                  Clear sort
                </button>
              )}
            </>
          )}
          <button
            type="button"
            className="sql-line-refresh"
            data-refresh-rows
            aria-label="Refresh rows"
            title={commandTip("refresh-rows", "Run this table's query again", mac)}
            disabled={!!p.running}
            onClick={p.onRefresh}
          >
            <RefreshIcon size={12} />
          </button>
          {p.menu}
        </div>
      </div>
      {p.tip && (
        <div className="sql-line-tip" data-tip={p.tipId ?? ""} role="status">
          {p.tip}
        </div>
      )}
      <GridMenu
        name="chip"
        label="Filter"
        at={chipMenuAt.at}
        items={chipMenu({ chipCount: p.chips.length })}
        onPick={pickChip}
        onClose={chipMenuAt.close}
      />
      <GridMenu
        name="page-size"
        label="Page size"
        at={limitMenu}
        items={p.pageSizes.map((size) => ({
          id: String(size),
          label: size === 0 ? "All rows" : `${size} rows`,
          checked: size === p.pageSize,
        }))}
        onPick={(id) => {
          setLimitMenu(null);
          p.onPageSize(Number(id));
        }}
        onClose={() => setLimitMenu(null)}
      />
    </div>
  );
}
