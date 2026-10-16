// Judges a latency run against the budgets and against a reference run of
// the same platform (scripts/baselines/reference-<platform>-<kind>.json).
// From phase 2 on a run fails the gate when a metric regressed: more than
// 25% + 15 ms slower than the reference, or over a budget the reference met.
// Budget misses the reference already had are reported, not failed: they
// are the work of later phases, not regressions.
//
// Per-release gates (the WebView2 workflow) judge the remote budgets and fail
// on any miss: LATENCY_BUDGETS=remote reads `remote_ms` (null = 1 RTT + 10 ms,
// with the RTT from LATENCY_RTT_MS, default 0), LATENCY_FAIL_ON_MISS=1 fails
// on a miss as well as on a regression.
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import os from "node:os";

export const SLACK_RATIO = 1.25;
export const SLACK_MS = 15;

/** One metric's verdict: "ok", "miss" (over budget, as in the reference) or "regressed". */
export function judgeMetric(value, budget, reference) {
  if (value == null) return { verdict: "ok", why: "not measured" };
  const over = budget != null && value > budget;
  if (reference == null) return over ? { verdict: "miss", why: `over ${budget} ms` } : { verdict: "ok" };
  const limit = Math.round((reference * SLACK_RATIO + SLACK_MS) * 10) / 10;
  if (value > limit) return { verdict: "regressed", why: `${value} > ${limit} (reference ${reference} × ${SLACK_RATIO} + ${SLACK_MS})` };
  if (over && reference <= budget) return { verdict: "regressed", why: `over ${budget} ms, which the reference (${reference}) met` };
  return over ? { verdict: "miss", why: `over ${budget} ms (reference ${reference})` } : { verdict: "ok" };
}

/** The budget a run is held to: warm (local) or remote, where null is 1 RTT + 10 ms. */
export function budgetOf(b, { remote = false, rttMs = 0 } = {}) {
  if (!remote) return b.warm_ms;
  return b.remote_ms ?? Math.round((rttMs + 10) * 10) / 10;
}

/** The budget options from the environment (LATENCY_BUDGETS, LATENCY_RTT_MS). */
export const envBudgetOptions = () => ({
  remote: process.env.LATENCY_BUDGETS === "remote",
  rttMs: Number(process.env.LATENCY_RTT_MS ?? 0) || 0,
});

/** Every budget of `source` judged; `values` and `reference` map metric → ms. */
export function judge(budgets, source, values, reference, options = {}) {
  const rows = [];
  for (const [key, b] of Object.entries(budgets)) {
    if (b.source !== source) continue;
    const budget = budgetOf(b, options);
    rows.push({ key, value: values[key] ?? null, budget, reference: reference?.[key] ?? null, ...judgeMetric(values[key] ?? null, budget, reference?.[key] ?? null) });
  }
  return rows;
}

export const platform = () => `${os.platform()}-${os.arch()}`;

export function referencePath(dir, kind) {
  return join(dir, "baselines", `reference-${platform()}-${kind}.json`);
}

/** The reference's metric values, or null when this platform has none. */
export function loadReference(dir, kind, pick) {
  const file = referencePath(dir, kind);
  if (!existsSync(file)) return null;
  return pick(JSON.parse(readFileSync(file, "utf8")));
}

/**
 * Prints the verdicts and exits like the gate wants: 1 on a regression
 * unless LATENCY_ENFORCE=0; writes the reference with
 * LATENCY_UPDATE_REFERENCE=1 (after a deliberate change, reviewed in the PR).
 */
export function finish(rows, { dir, kind, record, hasReference }) {
  const regressed = rows.filter((r) => r.verdict === "regressed");
  const missed = rows.filter((r) => r.verdict === "miss");
  for (const r of [...regressed, ...missed]) console.log(`${r.verdict === "regressed" ? "REGRESSED" : "miss"}: ${r.key} ${r.why}`);
  if (process.env.LATENCY_UPDATE_REFERENCE === "1") {
    writeFileSync(referencePath(dir, kind), `${JSON.stringify(record, null, 2)}\n`);
    console.log(`reference updated: ${referencePath(dir, kind)}`);
    return;
  }
  if (!hasReference) console.log(`no reference for ${platform()}: recorded only (LATENCY_UPDATE_REFERENCE=1 makes this run the reference)`);
  if (regressed.length && process.env.LATENCY_ENFORCE !== "0") {
    console.log(`${regressed.length} regression(s): failing (LATENCY_ENFORCE=0 records only)`);
    process.exit(1);
  }
  if (missed.length && process.env.LATENCY_FAIL_ON_MISS === "1") {
    console.log(`${missed.length} budget miss(es): failing (LATENCY_FAIL_ON_MISS=1)`);
    process.exit(1);
  }
}
