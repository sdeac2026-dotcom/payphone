#!/usr/bin/env bash
# PayPhone process supervisor — keeps the engine, oracle and web alive.
# Usage: ./scripts/supervise.sh   (run in background: setsid nohup ./scripts/supervise.sh &)
#
# Ports:
#   engine  8080  (Rust, release binary)
#   oracle  8001  (Python FastAPI)
#   web     3100  (Next.js standalone production server; the sandbox dev port
#                 3000 is managed by the platform itself)

set -u
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ORACLE_DIR="$ROOT/services/oracle-py"
ENGINE_BIN="$ROOT/engine/target/release/payphone-engine"
WEB_DIR="$ROOT/.next/standalone"
ORACLE_LOG="$ROOT/.oracle.log"
ENGINE_LOG="$ROOT/.engine.log"
WEB_LOG="$ROOT/.web.log"

export PAYPHONE_ORACLE_URL="${PAYPHONE_ORACLE_URL:-http://127.0.0.1:8001}"
export ORACLE_PORT="${ORACLE_PORT:-8001}"
export WEB_PORT="${WEB_PORT:-3000}"
export NODE_ENV=production

log() { echo "[$(date '+%H:%M:%S')] $*"; }

start_oracle() {
  ( cd "$ORACLE_DIR" && nohup python3 main.py >> "$ORACLE_LOG" 2>&1 & echo $! > "$ROOT/.oracle.pid" )
  log "oracle started (pid $(cat "$ROOT/.oracle.pid"))"
}

start_engine() {
  ( cd "$ROOT/engine" && nohup "$ENGINE_BIN" >> "$ENGINE_LOG" 2>&1 & echo $! > "$ROOT/.engine.pid" )
  log "engine started (pid $(cat "$ROOT/.engine.pid"))"
}

start_web() {
  ( cd "$WEB_DIR" && PORT="$WEB_PORT" nohup node server.js >> "$WEB_LOG" 2>&1 & echo $! > "$ROOT/.web.pid" )
  log "web started (pid $(cat "$ROOT/.web.pid"), port $WEB_PORT)"
}

alive() { [ -f "$1" ] && [ "$(cat "$1" 2>/dev/null || echo 0)" -gt 0 ] 2>/dev/null && kill -0 "$(cat "$1")" 2>/dev/null; }

log "PayPhone supervisor starting"
[ -x "$ENGINE_BIN" ] || log "WARN: engine binary missing — run: (cd engine && cargo build --release)"
[ -f "$WEB_DIR/server.js" ] || log "WARN: web build missing — run: bun run build"

alive "$ROOT/.oracle.pid" || start_oracle
sleep 1
alive "$ROOT/.engine.pid" || start_engine
sleep 1
alive "$ROOT/.web.pid" || start_web

while true; do
  sleep 5
  alive "$ROOT/.oracle.pid" || { log "oracle died — restarting"; start_oracle; }
  alive "$ROOT/.engine.pid" || { log "engine died — restarting"; start_engine; }
  alive "$ROOT/.web.pid" || { log "web died — restarting"; start_web; }
done
