#!/usr/bin/env bash
set -euo pipefail

PROJECT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SA3_REPO_DIR="${GERM_OFFICIAL_REPO_DIR:-${GERMINATOR_OFFICIAL_REPO_DIR:-$PROJECT_ROOT/vendor/stable-audio-3}}"

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

echo "Installing this server with the optional Python provider dependency."
cd "$PROJECT_ROOT"
uv sync --extra python-provider --extra dev

echo "Installing the official Stable Audio 3 repo extras for Gradio and LoRA workflows."
cd "$SA3_REPO_DIR"
uv sync --extra ui --extra lora

cat <<EOF

Python provider setup complete.

Official Gradio examples:
  cd "$SA3_REPO_DIR"
  uv run python run_gradio.py --model small-sfx
  uv run python run_gradio.py --model small-music
  uv run python run_gradio.py --model medium

Note: Stable Audio 3 Medium may require CUDA and Flash Attention depending on platform.
If model loading fails with a gated Hugging Face access error:
  uv run hf auth login
  curl "http://127.0.0.1:8765/huggingface/status?check_models=true"

Run the germ sidecar from:
  cd "$PROJECT_ROOT"
  ./scripts/run_server.sh
EOF
