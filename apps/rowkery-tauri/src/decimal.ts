import type { Value } from "./types";

/**
 * Exact decimal numbers as text: Postgres `numeric` arrives as its digits
 * (`10.00`, `-3`, `123456789012345678901.5`), and a double would round it.
 * Numbers here are compared digit by digit, never through a float.
 */

/** A finite decimal: sign, integer digits without leading zeros, fraction digits without trailing zeros. */
export interface Decimal {
  neg: boolean;
  int: string;
  frac: string;
}

/** Postgres orders `-Infinity` < numbers < `Infinity` < `NaN`. */
export type DecimalLike = Decimal | "-inf" | "inf" | "nan";

const DECIMAL = /^([+-]?)(\d*)(?:\.(\d*))?(?:[eE]([+-]?\d+))?$/;

/** A number's text as a decimal, or null when it isn't one. */
export function parseDecimal(text: string): DecimalLike | null {
  const t = text.trim();
  if (/^[+]?(inf|infinity)$/i.test(t)) return "inf";
  if (/^-(inf|infinity)$/i.test(t)) return "-inf";
  if (/^[+-]?nan$/i.test(t)) return "nan";
  const m = DECIMAL.exec(t);
  if (!m || (!m[2] && !m[3])) return null;
  let int = m[2] ?? "";
  let frac = m[3] ?? "";
  const exp = m[4] ? Number(m[4]) : 0;
  // An exponent (a double's `1e+21`, `5e-7`) moves the point; huge ones aren't numbers we sort.
  if (!Number.isSafeInteger(exp) || Math.abs(exp) > 1000) return null;
  if (exp > 0) {
    const moved = frac.padEnd(exp, "0");
    int += moved.slice(0, exp);
    frac = moved.slice(exp);
  } else if (exp < 0) {
    const moved = int.padStart(-exp, "0");
    frac = moved.slice(moved.length + exp) + frac;
    int = moved.slice(0, moved.length + exp);
  }
  int = int.replace(/^0+/, "");
  frac = frac.replace(/0+$/, "");
  // -0 is 0.
  return { neg: m[1] === "-" && (int !== "" || frac !== ""), int, frac };
}

/** A cell as a decimal: Int, BigInt and Float exactly as they print, numeric text by its digits. */
export function decimalOf(v: Value): DecimalLike | null {
  if ("Int" in v) return parseDecimal(String(v.Int));
  if ("BigInt" in v) return parseDecimal(v.BigInt);
  if ("Float" in v) return Number.isNaN(v.Float) ? "nan" : parseDecimal(String(v.Float));
  if ("Text" in v) return parseDecimal(v.Text);
  return null;
}

const RANK = { "-inf": 0, inf: 2, nan: 3 } as const;

function magnitude(a: Decimal, b: Decimal): number {
  if (a.int.length !== b.int.length) return a.int.length < b.int.length ? -1 : 1;
  if (a.int !== b.int) return a.int < b.int ? -1 : 1;
  const n = Math.max(a.frac.length, b.frac.length);
  const fa = a.frac.padEnd(n, "0");
  const fb = b.frac.padEnd(n, "0");
  return fa === fb ? 0 : fa < fb ? -1 : 1;
}

/** Orders two decimals by value: sign, integer length, digits, fraction. */
export function compareDecimal(a: DecimalLike, b: DecimalLike): number {
  const ra = typeof a === "string" ? RANK[a] : 1;
  const rb = typeof b === "string" ? RANK[b] : 1;
  if (ra !== rb || typeof a === "string" || typeof b === "string") return Math.sign(ra - rb);
  if (a.neg !== b.neg) return a.neg ? -1 : 1;
  const m = magnitude(a, b);
  return a.neg ? -m : m;
}

/** One spelling per value: `10.00`, `10` and `1e1` give the same key. */
export function decimalKey(d: DecimalLike): string {
  if (typeof d === "string") return d;
  return `${d.neg ? "-" : ""}${d.int || "0"}${d.frac ? `.${d.frac}` : ""}`;
}
