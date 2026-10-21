import { useEffect, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent, type MouseEvent } from "react";
import { allTables, type SidebarSchema } from "./schemaTree";
import { formatRowCount } from "./types";
import { isMacPlatform } from "./platform";
import { ArrowOutIcon, KeyIcon } from "./icons";
import {
  BOX_WIDTH,
  MAP_ALL_LIMIT,
  layoutSchemaMap,
  onDeleteLabel,
  rowY,
  stepFrom,
  type MapBox,
  type MapDepth,
  type MapEdge,
} from "./mapLayout";
import "./SchemaMap.css";

interface SchemaMapProps {
  schemas: SidebarSchema[];
  /** The table in the middle (the tab's own, or one clicked since). */
  centre: string;
  depth: MapDepth;
  onDepth: (depth: MapDepth) => void;
  onCentre: (key: string) => void;
  /** ↵ / double-click opens the table; ⌘↵ in a tab of its own. */
  onOpen: (key: string, newTab: boolean) => void;
  /** True when the user just asked for the map, so it takes the keys (once, on mount). */
  claimFocus: () => boolean;
}

const DEPTHS: { depth: MapDepth; label: string }[] = [
  { depth: 1, label: "1 step" },
  { depth: 2, label: "2 steps" },
  { depth: "all", label: "All" },
];

/** A self-reference's loop past the box's right edge. */
const BULGE = 44;

/** A second click this soon after the first opens the table the first one centred. */
const DOUBLE_MS = 500;

interface Drawn {
  edge: MapEdge;
  d: string;
  /** Where the "n" / "1" marks go, and which way they lean. */
  child: { x: number; y: number; left: boolean };
  parent: { x: number; y: number; left: boolean };
}

function draw(edge: MapEdge, boxes: Map<string, MapBox>): Drawn | null {
  const c = boxes.get(edge.from);
  const p = boxes.get(edge.to);
  if (!c || !p) return null;
  const cy = rowY(c, edge.fk.columns[0]);
  const py = rowY(p, edge.refColumns[0]);
  if (c === p) {
    // A self-reference: a loop out of the right side and back.
    const x = c.x + BOX_WIDTH;
    const reach = x + BULGE;
    return {
      edge,
      d: `M${x},${cy} C${reach},${cy} ${reach},${py} ${x},${py}`,
      child: { x, y: cy, left: false },
      parent: { x, y: py, left: false },
    };
  }
  const childLeft = c.x > p.x;
  const cx = childLeft ? c.x : c.x + BOX_WIDTH;
  const px = childLeft ? p.x + BOX_WIDTH : p.x;
  const mid = (cx + px) / 2;
  return {
    edge,
    d: `M${cx},${cy} C${mid},${cy} ${mid},${py} ${px},${py}`,
    child: { x: cx, y: cy, left: childLeft },
    parent: { x: px, y: py, left: !childLeft },
  };
}

/** "orders.customer_id", or "orders.(a, b)" for a composite key. */
function side(table: string, columns: string[]): string {
  return columns.length === 1 ? `${table}.${columns[0]}` : `${table}.(${columns.join(", ")})`;
}

export function SchemaMap({ schemas, centre, depth, onDepth, onCentre, onOpen, claimFocus }: SchemaMapProps) {
  const tooMany = useMemo(() => allTables(schemas).length > MAP_ALL_LIMIT, [schemas]);
  const shownDepth: MapDepth = depth === "all" && tooMany ? 2 : depth;
  const layout = useMemo(() => layoutSchemaMap(schemas, centre, shownDepth), [schemas, centre, shownDepth]);
  const boxes = useMemo(() => new Map(layout?.boxes.map((b) => [b.key, b]) ?? []), [layout]);
  const drawn = useMemo(
    () => (layout?.edges ?? []).map((e) => draw(e, boxes)).filter((d): d is Drawn => !!d),
    [layout, boxes],
  );

  const [picked, setSel] = useState(centre);
  // A box a depth change or a schema refresh took away hands the ring back to the centre.
  const sel = boxes.has(picked) ? picked : centre;
  const [hover, setHover] = useState<{ edge: MapEdge; x: number; y: number } | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLDivElement>(null);
  /** The box a first click re-centred on, and when: a quick second click opens it. */
  const clicked = useRef<{ key: string; at: number } | null>(null);

  useEffect(() => {
    if (claimFocus()) rootRef.current?.focus({ preventScroll: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  useEffect(() => {
    setSel(centre);
    setHover(null);
  }, [centre]);

  // Keep the selected box in view; a re-centred map scrolls to its middle.
  useLayoutEffect(() => {
    const box = boxes.get(sel);
    const scroller = scrollRef.current;
    const canvas = canvasRef.current;
    if (!box || !scroller || !canvas) return;
    const c = canvas.getBoundingClientRect();
    const sc = scroller.getBoundingClientRect();
    const left = c.left - sc.left + scroller.scrollLeft + box.x;
    const top = c.top - sc.top + scroller.scrollTop + box.y;
    if (sel === centre) {
      scroller.scrollLeft = left + BOX_WIDTH / 2 - scroller.clientWidth / 2;
      scroller.scrollTop = top + box.height / 2 - scroller.clientHeight / 2;
      return;
    }
    if (left < scroller.scrollLeft) scroller.scrollLeft = left - 16;
    else if (left + BOX_WIDTH > scroller.scrollLeft + scroller.clientWidth) scroller.scrollLeft = left + BOX_WIDTH - scroller.clientWidth + 16;
    if (top < scroller.scrollTop) scroller.scrollTop = top - 16;
    else if (top + box.height > scroller.scrollTop + scroller.clientHeight) scroller.scrollTop = top + box.height - scroller.clientHeight + 16;
  }, [sel, centre, boxes]);

  if (!layout) return null;
  const centreBox = boxes.get(centre)!;

  // Esc is the window's (Workspace): it closes what is open first, then leaves for Data.
  const onKey = (e: KeyboardEvent) => {
    // Keys on a depth button are that button's.
    if (e.target !== e.currentTarget || e.altKey || e.shiftKey) return;
    const mod = isMacPlatform() ? e.metaKey : e.ctrlKey;
    if (e.key === "Enter") {
      e.preventDefault();
      onOpen(sel, mod);
    } else if (mod || e.ctrlKey || e.metaKey) {
      return;
    } else if (e.key === "ArrowLeft" || e.key === "ArrowRight" || e.key === "ArrowUp" || e.key === "ArrowDown") {
      e.preventDefault();
      const next = stepFrom(layout.boxes, sel, e.key);
      if (next) setSel(next);
    } else if (e.key === " ") {
      e.preventDefault();
      if (sel !== centre) onCentre(sel);
    }
  };

  // The first click re-centres, so the second may land on whatever moved under
  // the pointer: a quick second click anywhere on the map opens the first box.
  const onClick = (e: MouseEvent) => {
    const first = clicked.current;
    clicked.current = null;
    const key = (e.target as Element).closest<HTMLElement>('[data-testid="sm-box"]')?.dataset.table;
    if (e.detail > 1 && first && e.timeStamp - first.at < DOUBLE_MS) return onOpen(first.key, false);
    if (!key) return;
    clicked.current = { key, at: e.timeStamp };
    setSel(key);
    if (key !== centre) onCentre(key);
  };

  const at = (e: MouseEvent) => {
    const r = canvasRef.current!.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  };

  const lit = new Set(hover ? [hover.edge.from, hover.edge.to] : []);
  const litColumns = (b: MapBox) =>
    new Set(
      hover
        ? [
            ...(hover.edge.from === b.key ? hover.edge.fk.columns : []),
            ...(hover.edge.to === b.key ? hover.edge.refColumns : []),
          ]
        : [],
    );
  const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;
  const tipRule = !hover ? null : hover.edge.guessed ? "guessed from the name, no foreign key" : onDeleteLabel(hover.edge.fk.on_delete);

  return (
    <div
      ref={rootRef}
      data-testid="schema-map"
      data-centre={centre}
      data-depth={shownDepth}
      className="sm-root"
      tabIndex={0}
      aria-label={`Map of ${centreBox.table.name}`}
      onKeyDown={onKey}
    >
      <header className="sm-header">
        <span data-testid="sm-summary" className="sm-summary">
          <span className="sm-summary-name">{centreBox.table.name}</span>
          {" · "}
          {plural(layout.pointsTo, "table it points to", "tables it points to")}
          {" · "}
          {plural(layout.pointedFrom, "points to it", "point to it")}
        </span>
        <div data-testid="sm-depths" className="sm-depths" role="radiogroup" aria-label="How far to reach">
          {DEPTHS.map((d) => {
            const off = d.depth === "all" && tooMany;
            return (
              <button
                key={d.label}
                type="button"
                role="radio"
                data-depth={d.depth}
                aria-checked={shownDepth === d.depth}
                disabled={off}
                title={off ? `More than ${MAP_ALL_LIMIT} tables` : undefined}
                onClick={() => {
                  onDepth(d.depth);
                  rootRef.current?.focus({ preventScroll: true });
                }}
              >
                {d.label}
              </button>
            );
          })}
        </div>
      </header>
      <div className="sm-scroll" ref={scrollRef} onClick={onClick}>
        <div ref={canvasRef} className="sm-canvas" style={{ width: layout.width + BULGE, height: layout.height }}>
          <svg data-testid="sm-lines" className="sm-lines" width={layout.width + BULGE} height={layout.height} aria-hidden>
            {drawn.map(({ edge, d, child, parent }) => {
              const far = (boxes.get(edge.from)?.dist ?? 0) > 1 || (boxes.get(edge.to)?.dist ?? 0) > 1;
              const on = hover?.edge.id === edge.id;
              const mark = (p: { x: number; y: number; left: boolean }, text: string) => (
                <text
                  data-end
                  className="sm-end"
                  x={p.left ? p.x - 6 : p.x + 6}
                  y={p.y - 5}
                  textAnchor={p.left ? "end" : "start"}
                >
                  {text}
                </text>
              );
              return (
                <g
                  key={edge.id}
                  data-testid="sm-edge"
                  data-edge={edge.id}
                  data-far={far ? "" : undefined}
                  data-guessed={edge.guessed ? "" : undefined}
                  data-on={on ? "" : undefined}
                >
                  <path data-line className="sm-line" d={d} />
                  {mark(child, edge.childEnd)}
                  {mark(parent, "1")}
                  <path
                    data-hit
                    className="sm-hit"
                    d={d}
                    onMouseEnter={(e) => setHover({ edge, ...at(e) })}
                    onMouseMove={(e) => setHover({ edge, ...at(e) })}
                    onMouseLeave={() => setHover(null)}
                  />
                </g>
              );
            })}
          </svg>
          {layout.boxes.map((b) => {
            const litCols = litColumns(b);
            return (
              <div
                key={b.key}
                data-testid="sm-box"
                data-table={b.key}
                data-centre={b.key === centre ? "" : undefined}
                data-sel={b.key === sel ? "" : undefined}
                data-far={b.dist > 1 ? "" : undefined}
                data-lit={lit.has(b.key) ? "" : undefined}
                className="sm-box"
                style={{ left: b.x, top: b.y, width: BOX_WIDTH, height: b.height }}
                title={`${b.table.schema}.${b.table.name}`}
              >
                <div className="sm-box-head">
                  <span className="sm-box-name">
                    {b.table.schema !== centreBox.table.schema && <span className="sm-box-schema">{b.table.schema}.</span>}
                    {b.table.name}
                  </span>
                  <span className="sm-box-rows">{formatRowCount(b.table.rows)}</span>
                </div>
                {b.columns.map((c) => (
                  <div
                    key={c.name}
                    className="sm-col"
                    data-column={c.name}
                    data-kind={c.kind}
                    data-lit={litCols.has(c.name) ? "" : undefined}
                  >
                    <span className="sm-col-icon">
                      {c.kind === "pk" ? <KeyIcon size={11} /> : c.kind === "fk" || c.kind === "guess" ? <ArrowOutIcon size={11} /> : null}
                    </span>
                    <span className="sm-col-name">{c.name}</span>
                    <span className="sm-col-type">{c.type}</span>
                  </div>
                ))}
              </div>
            );
          })}
          {hover && (
            <div data-testid="sm-tip" className="sm-tip" style={{ left: hover.x + 12, top: hover.y + 14 }}>
              {side(boxes.get(hover.edge.from)!.table.name, hover.edge.fk.columns)} →{" "}
              {side(boxes.get(hover.edge.to)!.table.name, hover.edge.refColumns)}
              {tipRule && <span className="sm-tip-rule"> · {tipRule}</span>}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
