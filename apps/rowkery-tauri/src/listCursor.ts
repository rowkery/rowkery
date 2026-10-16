import { useLayoutEffect, useRef, type MouseEvent, type RefObject } from "react";

/**
 * Keeps a keyboard cursor visible in a scrolling list: after each move the
 * row marked `aria-selected="true"` is scrolled just into view.
 */
export function useCursorIntoView(
  listRef: RefObject<HTMLElement | null>,
  cursor: number,
  rowCount: number,
) {
  useLayoutEffect(() => {
    listRef.current
      ?.querySelector<HTMLElement>('[aria-selected="true"]')
      ?.scrollIntoView({ block: "nearest" });
  }, [listRef, cursor, rowCount]);
}

/**
 * `onMouseMove` handler factory that only moves the cursor when the pointer
 * really moved. Scrolling a row under a still pointer fires mousemove too,
 * which would otherwise yank the cursor back while arrowing down.
 */
export function usePointerCursor(setCursor: (i: number) => void) {
  const last = useRef<{ x: number; y: number } | null>(null);
  return (i: number) => (e: MouseEvent) => {
    const p = last.current;
    last.current = { x: e.clientX, y: e.clientY };
    // The first event only records where the pointer rests.
    if (!p || (p.x === e.clientX && p.y === e.clientY)) return;
    setCursor(i);
  };
}
