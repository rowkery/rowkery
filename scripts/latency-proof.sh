#!/usr/bin/env bash
# Latency proof on the real app: builds the release binary with the latency
# proof steps (VITE_ROWKERY_AUTO_PROOF=latency), starts the Docker Postgres from
# docker-compose.test.yml with scripts/test-seed.sql, launches the app
# twice (cold, then warm) with ROWKERY_TIMINGS_OUT, and checks the marks against
# scripts/budgets.json via latency-ledger.mjs, which writes a baseline to
# scripts/baselines/. From phase 2 it fails on a regression against
# scripts/baselines/reference-<platform>-app.json (LATENCY_ENFORCE=0 records
# only; LATENCY_UPDATE_REFERENCE=1 rewrites the reference). On Linux it runs
# under xvfb-run when there is no display. On Windows (Git Bash, WebView2) it
# runs from .github/workflows/latency-webview2.yml with the remote budgets
# (LATENCY_BUDGETS=remote, LATENCY_FAIL_ON_MISS=1; see scripts/lib/latency-judge.mjs).
#
#   scripts/latency-proof.sh            # build, then measure
#   scripts/latency-proof.sh --no-build # reuse target/release/rowkery-tauri
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
OUT="${ROWKERY_LATENCY_OUT:-/tmp/rowkery-proof/latency}"
SQL="${ROWKERY_AUTO_RUN_SQL:-SELECT 1; SELECT * FROM failed_jobs LIMIT 100; SELECT * FROM kiosks; SELECT g, md5(g::text) FROM generate_series(1, 1000) g; SELECT now();}"
TABLE="${ROWKERY_AUTO_BROWSE_TABLE:-public.kiosk_sessions}"
mkdir -p "$OUT"

cd "$ROOT"
# Any Postgres already on :54329 with the rowkery user will do; else Docker's.
if ! pg_isready -h 127.0.0.1 -p 54329 -U rowkery -d rowkery >/dev/null 2>&1; then
  docker compose -f docker-compose.test.yml up -d postgres >/dev/null
fi
for _ in $(seq 1 30); do
  pg_isready -h 127.0.0.1 -p 54329 -U rowkery -d rowkery >/dev/null 2>&1 && break
  sleep 1
done
if ! PGPASSWORD=rowkery psql -h 127.0.0.1 -p 54329 -U rowkery -d rowkery -tAc "select to_regclass('public.kiosk_sessions')" | grep -q kiosk_sessions; then
  PGPASSWORD=rowkery psql -q -h 127.0.0.1 -p 54329 -U rowkery -d rowkery -f scripts/test-seed.sql >/dev/null
fi

if [ "${1:-}" != "--no-build" ]; then
  (cd apps/rowkery-tauri && VITE_ROWKERY_AUTO_PROOF=latency npm run tauri build -- --no-bundle 2>&1 | tail -3)
fi
BIN="$ROOT/target/release/rowkery-tauri"
[ -x "$BIN" ] || [ -x "$BIN.exe" ] || { echo "no $BIN; build first" >&2; exit 1; }
# Native Windows binaries want Windows paths in their environment.
native_path() { if command -v cygpath >/dev/null 2>&1; then cygpath -m "$1"; else echo "$1"; fi; }

# Own config dir: no keychain, and the proof saves the Docker connection there.
CONFIG="$(mktemp -d)"
trap 'rm -rf "$CONFIG"' EXIT

launch() {
  local name="$1" ledger="$OUT/$1.jsonl"
  rm -f "$ledger"
  local run=("$BIN")
  if [ "$(uname)" = Linux ] && [ -z "${DISPLAY:-}" ]; then
    run=(xvfb-run -a -s "-screen 0 1280x900x24" "$BIN")
  fi
  # Its own process group, so xvfb-run's X server goes with it (no setsid in Git Bash).
  local group=()
  command -v setsid >/dev/null 2>&1 && group=(setsid)
  ROWKERY_CONFIG_DIR="$(native_path "$CONFIG")" ROWKERY_TIMINGS_OUT="$(native_path "$ledger")" ROWKERY_AUTO_RUN_SQL="$SQL" \
    ROWKERY_AUTO_BROWSE_TABLE="$TABLE" ROWKERY_AUTO_QUIT_AFTER_MS=30000 ${group[@]+"${group[@]}"} "${run[@]}" >"$OUT/$name.log" 2>&1 &
  local pid=$!
  for _ in $(seq 1 300); do
    grep -q '"proof-done"' "$ledger" 2>/dev/null && break
    kill -0 "$pid" 2>/dev/null || break
    sleep 0.1
  done
  kill -- "-$pid" 2>/dev/null || kill "$pid" 2>/dev/null || true
  wait "$pid" 2>/dev/null || true
  if command -v taskkill >/dev/null 2>&1; then
    taskkill //F //IM rowkery-tauri.exe >/dev/null 2>&1 || true
  else
    pkill -f "[t]arget/release/rowkery-tauri" 2>/dev/null || true
  fi
  grep -q '"proof-done"' "$ledger" || { echo "FAIL: $name run never finished (see $OUT/$name.log)" >&2; exit 1; }
  echo "$name: $ledger"
}

launch cold
sleep 1
launch warm
node "$ROOT/scripts/latency-ledger.mjs" "$OUT/cold.jsonl" "$OUT/warm.jsonl"
