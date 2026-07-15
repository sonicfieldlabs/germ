#!/usr/bin/env bash
set -euo pipefail

PROJECT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$PROJECT_ROOT"

mkdir -p output/audio output/metadata output/uploads

UVICORN_ARGS=(
  server.main:app
  --host "${GERM_HOST:-${GERMINATOR_HOST:-127.0.0.1}}"
  --port "${GERM_PORT:-${GERMINATOR_PORT:-5178}}"
)
RELOAD_VALUE="${GERM_RELOAD:-${GERMINATOR_RELOAD:-0}}"
if [ "$RELOAD_VALUE" = "1" ] || [ "$RELOAD_VALUE" = "true" ]; then
  UVICORN_ARGS+=(--reload)
fi

exec uv run uvicorn "${UVICORN_ARGS[@]}"
