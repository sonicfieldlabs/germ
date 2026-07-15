#!/usr/bin/env bash
set -euo pipefail

PROJECT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
HOST="${GERM_HOST:-${GERMINATOR_HOST:-127.0.0.1}}"
PORT="${GERM_PORT:-${GERMINATOR_PORT:-5178}}"

echo "Dashboard is served by the FastAPI sidecar:"
echo "  http://${HOST}:${PORT}/dashboard"
echo

exec "$PROJECT_ROOT/scripts/run_server.sh"
