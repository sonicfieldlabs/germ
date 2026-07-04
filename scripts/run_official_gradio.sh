#!/usr/bin/env bash
set -euo pipefail

PROJECT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
MODEL="${1:-small-sfx}"
SA3_REPO_DIR="${GERM_OFFICIAL_REPO_DIR:-${GERMINATOR_OFFICIAL_REPO_DIR:-$PROJECT_ROOT/vendor/stable-audio-3}}"

if [ ! -f "$SA3_REPO_DIR/run_gradio.py" ]; then
  echo "Official Stable Audio 3 repo not found at $SA3_REPO_DIR." >&2
  echo "Run ./scripts/install_python_provider.sh first, or set GERM_OFFICIAL_REPO_DIR." >&2
  exit 1
fi

cd "$SA3_REPO_DIR"
uv run python run_gradio.py --model "$MODEL"
