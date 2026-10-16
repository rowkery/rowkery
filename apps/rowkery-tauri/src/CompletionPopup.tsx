import { useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import {
  ColumnIcon,
  DatabaseIcon,
  FunctionIcon,
  KeyIcon,
  LinkIcon,
  TableIcon,
  ViewIcon,
} from "./icons";
import type { Completion } from "./sqlComplete";
import "./CompletionPopup.css";

/** Rows the list shows before it scrolls. */
const VISIBLE = 9;
const ROW = 26;

interface Props {
  items: Completion[];
  cursor: number;
  /** The start of the word being completed, in viewport coordinates. */
  anchor: DOMRect;
  onPick: (index: number) => void;
  onHover: (index: number) => void;
  /** The listbox's id; row `i` is `${id}-${i}` (the editor's aria-activedescendant). */
  id: string;
}

function KindIcon({ item }: { item: Completion }) {
  switch (item.kind) {
    case "table":
    case "cte":
      return <TableIcon size={13} />;
    case "view":
    case "matview":
      return <ViewIcon size={13} />;
    case "schema":
      return <DatabaseIcon size={13} />;
    case "column":
      if (item.key === "pk") return <KeyIcon size={12} className="ac-pk" />;
      if (item.key === "fk") return <LinkIcon size={12} className="ac-fk" />;
      return <ColumnIcon size={13} />;
    case "join":
      return <LinkIcon size={12} className="ac-fk" />;
    case "function":
      return <FunctionIcon size={13} />;
    case "alias":
      return <TableIcon size={13} />;
    case "value":
      return <span className="ac-glyph">‘’</span>;
    default:
      return <span className="ac-glyph">↵</span>;
  }
}

function Label({ item }: { item: Completion }) {
  if (item.marks.length === 0) return <>{item.label}</>;
  const marked = new Set(item.marks);
  const out: React.ReactNode[] = [];
  let run = "";
  let runMarked = false;
  const flush = (key: number) => {
    if (!run) return;
    out.push(runMarked ? <mark key={key}>{run}</mark> : run);
    run = "";
  };
  for (let i = 0; i < item.label.length; i++) {
    const m = marked.has(i);
    if (m !== runMarked) {
      flush(i);
      runMarked = m;
    }
    run += item.label[i];
  }
  flush(item.label.length);
  return <>{out}</>;
}

/**
 * The editor's completion list, under the word being typed (above it when the
 * window runs out of room). Portalled to the body so the editor card's
 * rounded clip doesn't cut it off. Takes no focus: the editor keeps the keys.
 */
export function CompletionPopup({ items, cursor, anchor, onPick, onHover, id }: Props) {
  const listRef = useRef<HTMLDivElement>(null);
  const [above, setAbove] = useState(false);
  const height = Math.min(items.length, VISIBLE) * ROW + 8;

  useLayoutEffect(() => {
    setAbove(anchor.bottom + 4 + height > window.innerHeight - 8 && anchor.top - height - 4 > 8);
  }, [anchor, height]);

  // Keep the cursor row in view.
  useLayoutEffect(() => {
    const list = listRef.current;
    if (!list) return;
    const top = cursor * ROW;
    if (top < list.scrollTop) list.scrollTop = top;
    else if (top + ROW > list.scrollTop + list.clientHeight - 8)
      list.scrollTop = top + ROW - list.clientHeight + 8;
  }, [cursor]);

  const style: React.CSSProperties = {
    left: Math.max(8, Math.min(anchor.left - 30, window.innerWidth - 440)),
    ...(above
      ? { bottom: window.innerHeight - anchor.top + 4 }
      : { top: anchor.bottom + 4 }),
  };

  return createPortal(
    <div
      data-testid="ac-popup"
      className={`ac-popup${above ? " above" : ""}`}
      style={style}
      role="listbox"
      id={id}
      aria-label="Completions"
      // Clicking a row must not take focus from the editor.
      onMouseDown={(e) => e.preventDefault()}
    >
      <div className="ac-list" ref={listRef} style={{ maxHeight: VISIBLE * ROW + 8 }}>
        {items.map((item, i) => (
          <div
            key={`${item.kind}:${item.insert}`}
            data-testid="ac-row"
            className={`ac-row${i === cursor ? " active" : ""} ac-${item.kind}`}
            role="option"
            id={`${id}-${i}`}
            aria-selected={i === cursor}
            onMouseMove={() => i !== cursor && onHover(i)}
            onClick={() => onPick(i)}
          >
            <span className="ac-icon">
              <KindIcon item={item} />
            </span>
            <span data-testid="ac-label" className="ac-label">
              <Label item={item} />
            </span>
            {item.detail && <span className="ac-detail">{item.detail}</span>}
          </div>
        ))}
      </div>
    </div>,
    document.body,
  );
}
