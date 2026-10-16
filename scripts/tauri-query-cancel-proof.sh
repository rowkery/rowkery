#!/usr/bin/env bash
# Query cancel: run `SELECT pg_sleep(30)`, screenshot the running state, press Esc,
# screenshot the cancelled state, and check Postgres no longer runs the sleep.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
MEDIA="${ROWKERY_PROOF_MEDIA:-/tmp/rowkery-proof/query-cancel}"
LOG="/tmp/rowkery-query-cancel.log"
mkdir -p "$MEDIA"
PSQL=(psql -h 127.0.0.1 -p 54329 -U rowkery -d rowkery -tA)
# Clear sleeps left by an earlier run so the checks below only see this one.
"${PSQL[@]}" -c "select pg_terminate_backend(pid) from pg_stat_activity where query = 'SELECT pg_sleep(30);'" >/dev/null

cd "$ROOT"
cargo build -p rowkery-tauri 2>&1 | tail -2

cd "$ROOT/apps/rowkery-tauri"
export VITE_ROWKERY_AUTO_PROOF=query-cancel
xvfb-run -a -s "-screen 0 1280x900x24" bash -c "
  npm run tauri dev > '$LOG' 2>&1 &
  DEV_PID=\$!
  for i in \$(seq 1 120); do
    grep -q Running '$LOG' 2>/dev/null && break
    sleep 2
  done
  # Wait until the query has been running for a couple of seconds.
  for i in \$(seq 1 60); do
    psql -h 127.0.0.1 -p 54329 -U rowkery -d rowkery -tAc \
      \"select 1 from pg_stat_activity where query = 'SELECT pg_sleep(30);' and state = 'active'\" \
      2>/dev/null | grep -q 1 && break
    sleep 1
  done
  sleep 2
  import -window root '$MEDIA/01-running.png'
  # No window manager under Xvfb: click an empty spot in the results card to
  # focus the webview, then press Esc.
  xdotool mousemove 780 700 click 1
  sleep 0.3
  xdotool key Escape
  sleep 1.5
  import -window root '$MEDIA/02-cancelled.png'
  kill \$DEV_PID 2>/dev/null || true
  pkill -f '[t]arget/debug/rowkery-tauri' 2>/dev/null || true
  pkill -f '[n]ode.*vite' 2>/dev/null || true
"

still_running=$("${PSQL[@]}" -c \
  "select count(*) from pg_stat_activity where query = 'SELECT pg_sleep(30);' and state = 'active'")
echo "Screenshots: $MEDIA"
if [ "$still_running" != "0" ]; then
  echo "FAIL: pg_sleep still active on the server after Esc" >&2
  exit 1
fi
echo "ok: pg_sleep cancelled on the server"
