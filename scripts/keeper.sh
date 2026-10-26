#!/usr/bin/env bash
# PayPhone keeper — sandbox self-healing loop.
# Probes the actual ports; starts whatever is missing. No PID bookkeeping.
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
LOG="$ROOT/.keeper.log"

probe() { curl -s -o /dev/null --max-time 2 "http://127.0.0.1:$1$2" 2>/dev/null; }

while true; do
  if ! probe 8080 /health; then
    ( cd "$ROOT/engine" && PAYPHONE_ORACLE_URL=http://127.0.0.1:8001 setsid nohup ./target/release/payphone-engine >> "$ROOT/.engine.log" 2>&1 < /dev/null & )
    echo "$(date '+%H:%M:%S') started engine" >> "$LOG"
    sleep 2
  fi
  if ! probe 8001 /health; then
    ( cd "$ROOT/services/oracle-py" && setsid nohup python3 main.py >> "$ROOT/.oracle.log" 2>&1 < /dev/null & )
    echo "$(date '+%H:%M:%S') started oracle" >> "$LOG"
    sleep 2
  fi
  if ! probe 3000 /; then
    ( cd "$ROOT/scripts" && setsid nohup python3 preview_server.py >> "$ROOT/.web.log" 2>&1 < /dev/null & )
    echo "$(date '+%H:%M:%S') started web" >> "$LOG"
    sleep 2
  fi
  if ! probe 9099 /payphone/; then
    ( cd "$ROOT/scripts/pageserve" && setsid nohup python3 serve.py >> "$ROOT/.pageserve.log" 2>&1 < /dev/null & )
    echo "$(date '+%H:%M:%S') started pageserve" >> "$LOG"
    sleep 2
  fi
  sleep 5
done
