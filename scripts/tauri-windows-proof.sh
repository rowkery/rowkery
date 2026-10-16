#!/usr/bin/env bash
# Connection windows in the real app against Docker Postgres: connect, switch
# the window to the `orders` database with ⇧⌘D (Ctrl+Shift+D here), then open a
# second window with Ctrl+T and screenshot each step.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
MEDIA="${ROWKERY_PROOF_MEDIA:-/tmp/rowkery-proof/connection-windows}"
LOG="/tmp/rowkery-windows.log"
mkdir -p "$MEDIA"
PSQL=(psql -h 127.0.0.1 -p 54329 -U rowkery -d postgres -tA)
"${PSQL[@]}" -c "select 1 from pg_database where datname = 'orders'" | grep -q 1 \
  || "${PSQL[@]}" -c "create database orders"
psql -h 127.0.0.1 -p 54329 -U rowkery -d orders -q -c \
  "create table if not exists orders (id bigint primary key, status text); create table if not exists refunds (id bigint primary key)"

cd "$ROOT"
cargo build -p rowkery-tauri 2>&1 | tail -1

cd "$ROOT/apps/rowkery-tauri"
export VITE_ROWKERY_AUTO_PROOF=1
xvfb-run -a -s "-screen 0 1280x900x24" bash -c "
  npm run tauri dev > '$LOG' 2>&1 &
  DEV_PID=\$!
  for i in \$(seq 1 120); do
    grep -q Running '$LOG' 2>/dev/null && break
    sleep 2
  done
  sleep 8
  xdotool mousemove 780 700 click 1
  import -window root '$MEDIA/tauri-1-connected.png'
  xdotool key ctrl+shift+d
  sleep 1.5
  xdotool type --delay 40 orders
  xdotool key Return
  sleep 2
  import -window root '$MEDIA/tauri-2-orders.png'
  xdotool key ctrl+t
  sleep 0.8
  xdotool key Return
  sleep 3
  import -window root '$MEDIA/tauri-3-second-window.png'
  kill \$DEV_PID 2>/dev/null || true
  pkill -f '[t]arget/debug/rowkery-tauri' 2>/dev/null || true
  pkill -f '[n]ode.*vite' 2>/dev/null || true
"
echo "Screenshots: $MEDIA"
