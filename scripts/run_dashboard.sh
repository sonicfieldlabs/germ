#!/usr/bin/env bash
set -euo pipefail

PROJECT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$PROJECT_ROOT"

echo "Dashboard is served by the FastAPI sidecar:"
echo "  http://127.0.0.1:8765/dashboard"
echo

RELOAD_FLAG=""
if [ "${GERMINATOR_RELOAD:-0}" = "1" ] || [ "${GERMINATOR_RELOAD:-0}" = "true" ]; then
  RELOAD_FLAG="--reload"
fi

uv run uvicorn server.main:app --host "${GERMINATOR_HOST:-127.0.0.1}" --port "${GERMINATOR_PORT:-8765}" ${RELOAD_FLAG}
