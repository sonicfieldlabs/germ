#!/usr/bin/env bash
set -euo pipefail

PROJECT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SA3_REPO_DIR="${GERMINATOR_MLX_REPO_DIR:-$PROJECT_ROOT/vendor/stable-audio-3}"

if [ "$(uname -m)" != "arm64" ]; then
  echo "The MLX provider requires Apple Silicon (arm64)." >&2
  exit 1
fi

if ! command -v uv >/dev/null 2>&1; then
  echo "uv is required. Install it from https://docs.astral.sh/uv/ and rerun this script." >&2
  exit 1
fi

mkdir -p "$(dirname "$SA3_REPO_DIR")"
if [ ! -d "$SA3_REPO_DIR/.git" ]; then
  git clone https://github.com/Stability-AI/stable-audio-3 "$SA3_REPO_DIR"
else
  echo "Using existing Stable Audio 3 repo at $SA3_REPO_DIR"
fi

cd "$SA3_REPO_DIR/optimized/mlx"
./install.sh

mkdir -p output
./sa3 \
  --prompt "short dry wood impact" \
  --dit sm-sfx \
  --decoder same-s \
  --seconds 2 \
  --out output/test.wav

cat <<EOF

MLX provider setup complete.

Set GERMINATOR_MLX_REPO_DIR if the repo is not under this project:
  export GERMINATOR_MLX_REPO_DIR="$SA3_REPO_DIR"

Run:
  cd "$PROJECT_ROOT"
  ./scripts/run_server.sh
EOF

