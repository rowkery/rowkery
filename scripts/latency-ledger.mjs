#!/usr/bin/env node
// Turns ROWKERY_TIMINGS_OUT ledgers (JSON lines, see src-tauri/src/timings.rs
// and src/timings.ts) into budget metrics, prints them against
// scripts/budgets.json and the platform's reference run, and writes
// scripts/baselines/<date>-<platform>-app.json. From phase 2 a regression
// against the reference exits 1 (see scripts/lib/latency-judge.mjs);
// LATENCY_ENFORCE=0 records only, LATENCY_UPDATE_REFERENCE=1 rewrites the
// reference.
//
//   node scripts/latency-ledger.mjs cold.jsonl warm.jsonl
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import os from "node:os";
import { envBudgetOptions, finish, judge, loadReference } from "./lib/latency-judge.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const { budgets } = JSON.parse(readFileSync(join(here, "budgets.json"), "utf8"));

const median = (xs) => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};
const r1 = (x) => (x == null ? null : Math.round(x * 10) / 10);

export function metrics(lines) {
  const first = (name) => lines.find((l) => l.mark === name);
  const out = {};
  const shell = first("shell-painted");
  const webview = first("webview-ready");
  // Rust's mark is when the launch window's session was ready; the page's
  // (when its open_window reply came) is later by however long it took to ask.
  const socket = lines.find((l) => l.mark === "socket-warm" && l.source === "rust") ?? first("socket-warm");
  out.webview_ready = r1(webview?.t);
  out.window_painted = r1(shell?.t);
  out.socket_warm = r1(socket?.t);
  out.socket_open_ms = socket?.open_ms ?? null;
  out.socket_warm_vs_webview_ready = socket && webview ? r1(socket.t - webview.t) : null;

  // Queries: pair each run-sent with the next first-frame / first-frame-painted of its tab.
  const runs = [];
  lines.forEach((l, i) => {
    if (l.mark !== "run-sent") return;
    const same = (m) => (x) => x.mark === m && x.window === l.window && x.tab === l.tab;
    const rest = lines.slice(i + 1);
    const ff = rest.find(same("first-frame"));
    // Painted marks can land late and out of order; each names its run-sent.
    const painted = lines.find((x) => x.mark === "first-frame-painted" && x.sent === l.t && x.window === l.window);
    const all = rest.find(same("all-rows"));
    runs.push({
      t: l.t,
      first_frame: ff ? r1(ff.t - l.t) : null,
      first_frame_painted: painted ? r1(painted.t - l.t) : null,
      rows: all?.rows ?? null,
      db_ms: all?.elapsed_ms ?? null,
    });
  });
  const ok = runs.filter((r) => r.first_frame != null);
  out.queries = runs;
  // The first query opens the tab's session; the rest run on a warm one.
  out.first_query_frame = ok[0]?.first_frame ?? null;
  out.first_frame = r1(median(ok.slice(1).map((r) => r.first_frame)));
  out.first_frame_painted = r1(median(ok.slice(1).map((r) => r.first_frame_painted).filter((x) => x != null)));

  // Sidebar click → its browse's rows painted: the first run sent after the click.
  const click = first("browse-click");
  const browse = click && runs.find((r) => r.t >= click.t);
  out.browse_click_to_sent = browse ? r1(browse.t - click.t) : null;
  out.sidebar_click_rows =
    browse && browse.first_frame_painted != null ? r1(browse.t + browse.first_frame_painted - click.t) : null;
  out.rust_marks = Object.fromEntries(lines.filter((l) => l.source === "rust").map((l) => [l.mark, l.t]));
  return out;
}

function load(path) {
  return readFileSync(path, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l))
    .sort((a, b) => a.t - b.t);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const [coldPath, warmPath] = process.argv.slice(2);
  if (!coldPath) {
    console.error("usage: latency-ledger.mjs cold.jsonl [warm.jsonl]");
    process.exit(2);
  }
  const runs = { cold: metrics(load(coldPath)) };
  if (warmPath) runs.warm = metrics(load(warmPath));
  const judged = runs.warm ?? runs.cold;
  const reference = loadReference(here, "app", (r) => r.runs?.warm ?? r.runs?.cold ?? null);
  const rows = judge(budgets, "app", judged, reference, envBudgetOptions());
  console.log(`\n${"metric".padEnd(30)} ${"cold".padStart(8)} ${"warm".padStart(8)} ${"budget".padStart(8)} ${"ref".padStart(8)}`);
  const cell = (x) => (x == null ? "—" : String(x)).padStart(8);
  for (const r of rows) {
    const mark = r.verdict === "regressed" ? "  REGRESSED" : r.verdict === "miss" ? "  miss" : r.value == null ? "  (not measured yet)" : "";
    console.log(`${r.key.padEnd(30)} ${cell(runs.cold[r.key])} ${cell(runs.warm?.[r.key])} ${cell(r.budget)} ${cell(r.reference)}${mark}`);
  }
  const date = new Date().toISOString().slice(0, 10);
  const platform = `${os.platform()}-${os.arch()}`;
  const file = join(here, "baselines", `${date}-${platform}-app.json`);
  mkdirSync(dirname(file), { recursive: true });
  const record = { date, platform, host: os.cpus()[0]?.model ?? "", source: "latency-proof.sh", runs };
  writeFileSync(file, `${JSON.stringify(record, null, 2)}\n`);
  console.log(`\nbaseline: ${file}`);
  finish(rows, { dir: here, kind: "app", record, hasReference: reference != null });
}
