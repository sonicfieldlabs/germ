#!/usr/bin/env bash
set -euo pipefail

PROJECT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$PROJECT_ROOT"

export GERM_HOST="${GERM_HOST:-${GERMINATOR_HOST:-127.0.0.1}}"
export GERM_PORT="${GERM_PORT:-${GERMINATOR_PORT:-5178}}"

API_URL="http://${GERM_HOST}:${GERM_PORT}"
DASHBOARD_URL="${API_URL}/dashboard"

if ! command -v uv >/dev/null 2>&1; then
  echo "uv is required but was not found."
  echo "Install uv from https://docs.astral.sh/uv/ and run this launcher again."
  read -r -p "Press Return to close..."
  exit 1
fi

mkdir -p output/audio output/metadata output/uploads

echo "Starting germ"
echo "API:       ${API_URL}"
echo "Dashboard: ${DASHBOARD_URL}"
echo
echo "Keep this Terminal window open while using the dashboard."
echo "Press Ctrl+C here to stop the server."
echo

if command -v open >/dev/null 2>&1; then
  (sleep 3 && open "${DASHBOARD_URL}") >/dev/null 2>&1 &
fi

RELOAD_FLAG=""
RELOAD_VALUE="${GERM_RELOAD:-${GERMINATOR_RELOAD:-0}}"
if [ "$RELOAD_VALUE" = "1" ] || [ "$RELOAD_VALUE" = "true" ]; then
  RELOAD_FLAG="--reload"
fi

uv run uvicorn server.main:app \
  --host "${GERM_HOST}" \
  --port "${GERM_PORT}" \
  ${RELOAD_FLAG}
