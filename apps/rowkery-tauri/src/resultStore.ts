import { useSyncExternalStore } from "react";
import type { Value } from "./types";
import type { WireProfile } from "./columnProfile";

/**
 * A result's rows, column by column, outside React. Binary rows frames
 * (rowkery-core `frames.rs`) are decoded with one DataView pass into typed
 * arrays, one chunk per frame; JSON rows (tests, the frames shim) become a
 * chunk of values. Rows only ever append. Readers ask per cell (`text`,
 * `isNull`, `number`, `get`) and never see the wire layout.
 *
 * React reads it through `useResultRows` (useSyncExternalStore on `version`);
 * appends notify at most once per animation frame, so a result streaming
 * thousands of rows a second commits once per frame.
 */

export const MAGIC = 0x494e4c31; // "INL1"
export const HEADER_LEN = 28;
const FRAME_ROWS = 2;
const FLAG_LAST = 1;
/** The frame carries the result's column profiles after its rows. */
const FLAG_PROFILE = 2;
const PROFILE_BINS = 14;

export const enum WireKind {
  Bool = 1,
  Int32 = 2,
  Int64 = 3,
  F64 = 4,
  Numeric = 5,
  String = 6,
  Json = 7,
  Bytes = 8,
  Mixed = 9,
}

/** Largest integer a double holds exactly. */
const SAFE = Number.MAX_SAFE_INTEGER;
const BYTES_PREFIX = 16;
const decoder = new TextDecoder();

interface StringBlock {
  offsets: Uint32Array;
  bytes: Uint8Array;
  /** Decoded on first read; a scrolled-past cell is decoded once. */
  cache: (string | undefined)[];
}

interface BytesBlock {
  lengths: Uint32Array;
  prefixes: Uint8Array;
}

type Block =
  | { kind: WireKind.Bool; data: Uint8Array }
  | { kind: WireKind.Int32; data: Int32Array }
  | { kind: WireKind.F64; data: Float64Array }
  | { kind: WireKind.Int64 | WireKind.Numeric | WireKind.String | WireKind.Json; data: StringBlock }
  | { kind: WireKind.Bytes; data: BytesBlock }
  | { kind: WireKind.Mixed; tags: Uint8Array; index: Uint32Array; parts: (Block | null)[] };

interface ColumnBlock {
  nulls: Uint8Array;
  block: Block;
}

interface Chunk {
  start: number;
  length: number;
  /** Binary chunk: one block per column. */
  columns?: ColumnBlock[];
  /** JSON chunk: today's tagged rows. */
  values?: Value[][];
}

const NULL_CELL: Value = { Null: null };

class Reader {
  pos = 0;
  readonly view: DataView;
  readonly bytes: Uint8Array;
  constructor(readonly buf: ArrayBuffer) {
    this.view = new DataView(buf);
    this.bytes = new Uint8Array(buf);
  }
  u8() {
    return this.view.getUint8(this.pos++);
  }
  u16() {
    const v = this.view.getUint16(this.pos, true);
    this.pos += 2;
    return v;
  }
  u32() {
    const v = this.view.getUint32(this.pos, true);
    this.pos += 4;
    return v;
  }
  f64() {
    const v = this.view.getFloat64(this.pos, true);
    this.pos += 8;
    return v;
  }
  /** `n` bytes as a view, without copying. */
  take(n: number) {
    const v = this.bytes.subarray(this.pos, this.pos + n);
    this.pos += n;
    return v;
  }
  /** Typed arrays need aligned offsets; copy when the frame's offset isn't. */
  typed<T>(n: number, size: number, make: (buf: ArrayBuffer, off: number, len: number) => T): T {
    const off = this.pos;
    let out: T;
    if (off % size === 0) out = make(this.buf, off, n);
    else out = make(this.bytes.slice(this.pos, this.pos + n * size).buffer, 0, n);
    this.pos += n * size;
    return out;
  }
  strings(n: number): StringBlock {
    const offsets = this.typed(n + 1, 4, (b, o, l) => new Uint32Array(b, o, l));
    const bytes = this.take(offsets[n] ?? 0);
    return { offsets, bytes, cache: [] };
  }
  bytesBlock(n: number): BytesBlock {
    const lengths = new Uint32Array(n);
    const prefixes = new Uint8Array(n * BYTES_PREFIX);
    for (let i = 0; i < n; i++) {
      lengths[i] = this.u32();
      prefixes.set(this.take(BYTES_PREFIX), i * BYTES_PREFIX);
    }
    return { lengths, prefixes };
  }
  str() {
    return decoder.decode(this.take(this.u32()));
  }
  /** rowkery-core `profile::write`. */
  profiles(): WireProfile[] {
    const out: WireProfile[] = [];
    for (let n = this.u16(); n > 0; n--) {
      const kind = this.u8();
      const flags = this.u8();
      const sampleRows = this.u32();
      const nulls = this.u32();
      const distinct = this.u32();
      const min = this.f64();
      const max = this.f64();
      const bins: number[] = [];
      for (let b = 0; b < PROFILE_BINS; b++) bins.push(this.u32());
      const top: [string, number][] = [];
      for (let t = this.u8(); t > 0; t--) top.push([this.str(), this.u32()]);
      out.push({ kind, sampleRows, nulls, distinct, min, max, bins, wholeBins: (flags & 1) !== 0, top });
    }
    return out;
  }
  block(kind: number, n: number): Block {
    switch (kind) {
      case WireKind.Bool:
        return { kind, data: this.take(n) };
      case WireKind.Int32:
        return { kind, data: this.typed(n, 4, (b, o, l) => new Int32Array(b, o, l)) };
      case WireKind.F64:
        return { kind, data: this.typed(n, 8, (b, o, l) => new Float64Array(b, o, l)) };
      case WireKind.Int64:
      case WireKind.Numeric:
      case WireKind.String:
      case WireKind.Json:
        return { kind, data: this.strings(n) };
      case WireKind.Bytes:
        return { kind, data: this.bytesBlock(n) };
      case WireKind.Mixed: {
        const tags = this.take(n);
        const index = new Uint32Array(n);
        const seen = new Uint32Array(7);
        for (let i = 0; i < n; i++) index[i] = seen[tags[i]]++;
        // Tags 1–6 → int32, int64, f64, string, bytes, bool blocks.
        const tagKind = [0, WireKind.Int32, WireKind.Int64, WireKind.F64, WireKind.String, WireKind.Bytes, WireKind.Bool];
        const parts: (Block | null)[] = [null];
        for (let t = 1; t <= 6; t++) parts.push(this.block(tagKind[t], this.u32()));
        return { kind, tags, index, parts };
      }
      default:
        throw new Error(`unknown wire kind ${kind}`);
    }
  }
}

/** What a rows frame's header says. */
export interface FrameHeader {
  queryId: number;
  seq: number;
  last: boolean;
  sentAtMs: number;
  rows: number;
  /** The frame that completes the profile sample carries the profiles. */
  profiles?: WireProfile[];
}

function stringAt(s: StringBlock, i: number): string {
  let v = s.cache[i];
  if (v === undefined) {
    v = decoder.decode(s.bytes.subarray(s.offsets[i], s.offsets[i + 1]));
    s.cache[i] = v;
  }
  return v;
}

/** A cell of a block, as today's tagged value. */
function blockValue(b: Block, i: number): Value {
  switch (b.kind) {
    case WireKind.Bool:
      return { Bool: b.data[i] !== 0 };
    case WireKind.Int32:
      return { Int: b.data[i] };
    case WireKind.F64:
      return { Float: b.data[i] };
    case WireKind.Int64: {
      const s = stringAt(b.data, i);
      const n = Number(s);
      return Math.abs(n) <= SAFE ? { Int: n } : { BigInt: s };
    }
    case WireKind.Numeric:
    case WireKind.String:
    case WireKind.Json:
      return { Text: stringAt(b.data, i) };
    case WireKind.Bytes:
      return {
        Bytes: Array.from(b.data.prefixes.subarray(i * BYTES_PREFIX, i * BYTES_PREFIX + Math.min(BYTES_PREFIX, b.data.lengths[i]))),
        byteLength: b.data.lengths[i],
      };
    case WireKind.Mixed: {
      const part = b.parts[b.tags[i]];
      return part ? blockValue(part, b.index[i]) : NULL_CELL;
    }
  }
}

/** Display text of a block's cell: what `safeFormatCell` prints for its value. */
function blockText(b: Block, i: number): string {
  switch (b.kind) {
    case WireKind.Bool:
      return b.data[i] ? "true" : "false";
    case WireKind.Int32:
    case WireKind.F64:
      return String(b.data[i]);
    case WireKind.Int64:
    case WireKind.Numeric:
    case WireKind.String:
    case WireKind.Json:
      return stringAt(b.data, i);
    case WireKind.Bytes:
      return `<${b.data.lengths[i]} bytes>`;
    case WireKind.Mixed: {
      const part = b.parts[b.tags[i]];
      return part ? blockText(part, b.index[i]) : "";
    }
  }
}

export function valueText(v: Value | undefined): string {
  if (!v || typeof v !== "object" || "Null" in v) return "";
  if ("Bool" in v) return v.Bool ? "true" : "false";
  if ("Int" in v) return String(v.Int);
  if ("BigInt" in v) return v.BigInt;
  if ("Float" in v) return String(v.Float);
  if ("Text" in v) return v.Text;
  if ("Bytes" in v) return `<${v.byteLength ?? v.Bytes.length} bytes>`;
  return "";
}

export class ResultRows {
  /** Set by `concat`: these rows begin with all of that result's rows. */
  prefixOf: ResultRows | null = null;
  private chunks: Chunk[] = [];
  private last = 0;
  length = 0;
  /**
   * Column profiles of the first rows: from the frame that completed the
   * sample, from `summarizeRows` for rows built here, or the rows these were
   * sorted or paged from. Null until then.
   */
  profiles: WireProfile[] | null = null;
  /** Bumps on every append; `useResultRows` re-renders on it. */
  version = 0;
  private listeners = new Set<() => void>();
  private notifyScheduled = 0;

  /** Rows already decoded into tagged values (tests, JSON frames, proofs). */
  static fromValues(rows: Value[][]): ResultRows {
    const r = new ResultRows();
    r.appendValues(rows);
    return r;
  }

  /** Decodes a rows frame and appends it. Returns its header. */
  appendFrame(buf: ArrayBuffer): FrameHeader {
    const header = decodeFrame(buf, (n, columns) => this.push({ start: this.length, length: n, columns }));
    if (header.profiles) this.setProfiles(header.profiles);
    return header;
  }

  /** Set once; an empty last frame can carry them, so this notifies too. */
  setProfiles(profiles: WireProfile[]) {
    this.profiles = profiles;
    this.version++;
    this.scheduleNotify();
  }

  appendValues(rows: Value[][]) {
    if (rows.length === 0) return;
    this.push({ start: this.length, length: rows.length, values: rows });
  }

  /** `a`'s rows then `b`'s (a table tab's next page), sharing their chunks. */
  static concat(a: ResultRows, b: ResultRows): ResultRows {
    const r = new ResultRows();
    r.appendRows(a);
    r.appendRows(b);
    r.prefixOf = a;
    // The first page's profiles stand: nothing merges in the next one's.
    r.profiles = a.profiles;
    return r;
  }

  /** Appends another result's rows: chunks are shared, not copied. */
  appendRows(other: ResultRows) {
    for (const c of other.chunks) this.push({ ...c, start: this.length });
  }

  private push(chunk: Chunk) {
    if (chunk.length === 0) return;
    this.chunks.push(chunk);
    this.length += chunk.length;
    this.version++;
    this.scheduleNotify();
  }

  private chunkOf(row: number): Chunk | undefined {
    const cs = this.chunks;
    let c = cs[this.last];
    if (c && row >= c.start && row < c.start + c.length) return c;
    let lo = 0;
    let hi = cs.length - 1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      c = cs[mid];
      if (row < c.start) hi = mid - 1;
      else if (row >= c.start + c.length) lo = mid + 1;
      else {
        this.last = mid;
        return c;
      }
    }
    return undefined;
  }

  isNull(row: number, col: number): boolean {
    const c = this.chunkOf(row);
    if (!c) return true;
    const i = row - c.start;
    if (c.values) {
      const v = c.values[i]?.[col];
      return !v || (typeof v === "object" && "Null" in v);
    }
    const cb = c.columns?.[col];
    return !cb || (cb.nulls[i >> 3] & (1 << (i & 7))) !== 0;
  }

  /** The cell as a tagged value (one object per call; prefer `text` / `number` in loops). */
  get(row: number, col: number): Value {
    const c = this.chunkOf(row);
    if (!c) return NULL_CELL;
    const i = row - c.start;
    if (c.values) return c.values[i]?.[col] ?? NULL_CELL;
    if (this.isNull(row, col)) return NULL_CELL;
    const cb = c.columns?.[col];
    return cb ? blockValue(cb.block, i) : NULL_CELL;
  }

  /** Display text; "" for NULL (the grid draws its own NULL pill). */
  text(row: number, col: number): string {
    const c = this.chunkOf(row);
    if (!c) return "";
    const i = row - c.start;
    if (c.values) return valueText(c.values[i]?.[col]);
    if (this.isNull(row, col)) return "";
    const cb = c.columns?.[col];
    return cb ? blockText(cb.block, i) : "";
  }

  /** A numeric cell's value (int8 past 2^53 rounds; fine for profiles); null for NULL, undefined if not a number. */
  number(row: number, col: number): number | null | undefined {
    if (this.isNull(row, col)) return null;
    const v = this.get(row, col);
    if ("Int" in v) return v.Int;
    if ("Float" in v) return v.Float;
    if ("BigInt" in v) return Number(v.BigInt);
    return undefined;
  }

  isNumber(row: number, col: number): boolean {
    if (this.isNull(row, col)) return false;
    const v = this.get(row, col);
    return "Int" in v || "BigInt" in v || "Float" in v;
  }

  isBool(row: number, col: number): boolean {
    if (this.isNull(row, col)) return false;
    return "Bool" in this.get(row, col);
  }

  /** One row as tagged values (Quick Look, a copied row). */
  row(r: number, columns: number): Value[] {
    const out: Value[] = [];
    for (let c = 0; c < columns; c++) out.push(this.get(r, c));
    return out;
  }

  subscribe = (fn: () => void) => {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  };

  getVersion = () => this.version;

  private scheduleNotify() {
    if (this.notifyScheduled || this.listeners.size === 0) return;
    const run = () => {
      this.notifyScheduled = 0;
      for (const fn of this.listeners) fn();
    };
    this.notifyScheduled =
      typeof requestAnimationFrame === "function" ? requestAnimationFrame(run) : (setTimeout(run, 0) as unknown as number);
  }
}

/**
 * Decodes a rows frame; `onChunk` gets its row count and column blocks.
 * Throws on a frame that isn't one (bad magic, unknown kind).
 */
export function decodeFrame(buf: ArrayBuffer, onChunk: (rows: number, columns: ColumnBlock[]) => void): FrameHeader {
  const r = new Reader(buf);
  if (r.u32() !== MAGIC) throw new Error("not an INL1 frame");
  if (r.u8() !== FRAME_ROWS) throw new Error("not a rows frame");
  const flags = r.u8();
  const last = (flags & FLAG_LAST) !== 0;
  r.u16();
  const lo = r.u32();
  const hi = r.u32();
  const queryId = hi * 2 ** 32 + lo;
  const seq = r.u32();
  const sentAtMs = r.f64();
  const n = r.u32();
  const ncols = r.u16();
  const columns: ColumnBlock[] = [];
  for (let c = 0; c < ncols; c++) {
    const kind = r.u8();
    const nulls = r.take((n + 7) >> 3);
    columns.push({ nulls, block: r.block(kind, n) });
  }
  onChunk(n, columns);
  const header: FrameHeader = { queryId, seq, last, sentAtMs, rows: n };
  if (flags & FLAG_PROFILE) header.profiles = r.profiles();
  return header;
}

/** Re-renders when `rows` grow; returns how many there are now. */
export function useResultRows(rows: ResultRows): number {
  useSyncExternalStore(rows.subscribe, rows.getVersion, rows.getVersion);
  return rows.length;
}
