export interface CellPos {
  row: number;
  col: number;
}

/**
 * Selected block: `anchor` and `focus` are opposite corners (drag, ⇧-click,
 * ⇧-arrows move `focus`); `active` carries the ring and is where arrows move from.
 */
export interface Selection {
  active: CellPos;
  anchor: CellPos;
  focus: CellPos;
  /** Picked by the row numbers (whole rows), even when the table has one column. */
  rows?: boolean;
}

export interface SelRect {
  r0: number;
  r1: number;
  c0: number;
  c1: number;
}

export function selRect(sel: Selection): SelRect {
  return {
    r0: Math.min(sel.anchor.row, sel.focus.row),
    r1: Math.max(sel.anchor.row, sel.focus.row),
    c0: Math.min(sel.anchor.col, sel.focus.col),
    c1: Math.max(sel.anchor.col, sel.focus.col),
  };
}

export function single(pos: CellPos): Selection {
  return { active: pos, anchor: pos, focus: pos };
}
