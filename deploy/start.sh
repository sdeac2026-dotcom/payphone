#!/usr/bin/env bash
# =============================================================================
# PayPhone — single-container production entrypoint.
#
# Boot order (mirrors docs/DEPLOYMENT.md):
#   1. Oracle (FastAPI)     127.0.0.1:${ORACLE_PORT:-8001}   — private
#   2. Engine (Rust)        127.0.0.1:${PAYPHONE_PORT:-8081} — private
#   3. Web console (Next.js standalone) 0.0.0.0:${PORT:-3000} — PUBLIC
#
# The web console is the only public surface: the browser talks to
# /api/v1/* which the Next.js gateway proxies to the engine. The engine
# and oracle never bind a public interface.
#
# Production mode is fail-closed: with PAYPHONE_ENV=production the engine
# refuses to boot without a real PAYPHONE_MASTER_KEY — this script surfaces
# that immediately instead of hanging.
# =============================================================================
set -euo pipefail

PORT="${PORT:-3000}"
ENGINE_PORT="${PAYPHONE_PORT:-8081}"
ORACLE_PORT="${ORACLE_PORT:-8001}"
# Resolved oracle URL — exported so BOTH the engine and the web console
# (/api/health aggregate probe) agree on where the oracle lives.
export PAYPHONE_ORACLE_URL="${PAYPHONE_ORACLE_URL:-http://127.0.0.1:${ORACLE_PORT}}"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

ENGINE_PID=""
ORACLE_PID=""
WEB_PID=""

shutdown() {
  trap - TERM INT
  [ -n "$WEB_PID" ]    && kill "$WEB_PID"    2>/dev/null || true
  [ -n "$ENGINE_PID" ] && kill "$ENGINE_PID" 2>/dev/null || true
  [ -n "$ORACLE_PID" ] && kill "$ORACLE_PID" 2>/dev/null || true
  wait 2>/dev/null || true
  exit 0
}
trap shutdown TERM INT

# ---------------------------------------------------------------- oracle ----
# Prefer the image venv; fall back to a system uvicorn (bare-metal runs).
if [ -x /opt/oracle-venv/bin/uvicorn ]; then
  ORACLE_CMD=(/opt/oracle-venv/bin/uvicorn)
else
  ORACLE_CMD=(python3 -m uvicorn)
fi
echo "[payphone] oracle  → 127.0.0.1:${ORACLE_PORT}"
(
  cd "${ROOT}/oracle"
  exec "${ORACLE_CMD[@]}" main:app --host 127.0.0.1 --port "${ORACLE_PORT}" --log-level warning
) &
ORACLE_PID=$!

# ---------------------------------------------------------------- engine ----
echo "[payphone] engine  → 127.0.0.1:${ENGINE_PORT} (oracle: ${PAYPHONE_ORACLE_URL})"
PAYPHONE_PORT="${ENGINE_PORT}" \
  "${ROOT}/bin/payphone-engine" &
ENGINE_PID=$!

# Fail fast if the engine refuses to boot (fail-closed config check).
sleep 1
if ! kill -0 "$ENGINE_PID" 2>/dev/null; then
  echo "[payphone] FATAL: engine exited during startup — check PAYPHONE_MASTER_KEY / secrets" >&2
  kill "$ORACLE_PID" 2>/dev/null || true
  exit 1
fi

for _ in $(seq 1 60); do
  if curl -fsS "http://127.0.0.1:${ENGINE_PORT}/health" >/dev/null 2>&1; then
    echo "[payphone] engine healthy"
    break
  fi
  if ! kill -0 "$ENGINE_PID" 2>/dev/null; then
    echo "[payphone] FATAL: engine exited while waiting for health" >&2
    kill "$ORACLE_PID" 2>/dev/null || true
    exit 1
  fi
  sleep 1
done

# ------------------------------------------------------------------- web ----
echo "[payphone] web     → 0.0.0.0:${PORT} (public)"
cd "${ROOT}/web"
node server.js &
WEB_PID=$!

echo "[payphone] stack up"
wait "$WEB_PID"
