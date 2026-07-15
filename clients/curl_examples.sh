#!/usr/bin/env bash
set -euo pipefail

BASE_URL="${BASE_URL:-http://127.0.0.1:5178}"
INPUT_AUDIO="${INPUT_AUDIO:-output/audio/example_input.wav}"

curl -sS "$BASE_URL/health"
echo

curl -sS "$BASE_URL/models"
echo

curl -sS "$BASE_URL/huggingface/status?check_models=false"
echo

curl -sS -X POST "$BASE_URL/generate" \
  -H "content-type: application/json" \
  -d '{
    "provider": "mock",
    "model": "mock-sine",
    "prompt": "TrackType: SFX, close dry gravel footsteps, short decay, no music, no voice",
    "negative_prompt": "music, vocals, speech, melody",
    "duration": 4.0,
    "steps": 8,
    "cfg_scale": 1.0,
    "seed": -1,
    "batch_size": 1,
    "output_name": "gravel_footsteps"
  }'
echo

curl -sS -X POST "$BASE_URL/audio-to-audio" \
  -H "content-type: application/json" \
  -d "{
    \"provider\": \"mock\",
    \"model\": \"mock-sine\",
    \"prompt\": \"turn this recording into a metallic resonant drone\",
    \"input_audio_path\": \"$INPUT_AUDIO\",
    \"init_noise_level\": 0.45,
    \"duration\": 8.0,
    \"steps\": 8,
    \"seed\": -1
  }"
echo

curl -sS -X POST "$BASE_URL/jobs/submit" \
  -H "content-type: application/json" \
  -d '{
    "mode": "text-to-audio",
    "request": {
      "provider": "mock",
      "model": "mock-sine",
      "prompt": "short dry async ceramic click",
      "duration": 1.0,
      "output_name": "async_ceramic_click"
    }
  }'
echo

curl -sS -X POST "$BASE_URL/inpaint" \
  -H "content-type: application/json" \
  -d "{
    \"provider\": \"mock\",
    \"model\": \"mock-sine\",
    \"prompt\": \"replace the region with a punchy metallic impact\",
    \"input_audio_path\": \"$INPUT_AUDIO\",
    \"inpaint_ranges\": [[1.0, 2.0]],
    \"duration\": 8.0,
    \"steps\": 8,
    \"seed\": -1
  }"
echo

curl -sS -X POST "$BASE_URL/continue" \
  -H "content-type: application/json" \
  -d "{
    \"provider\": \"mock\",
    \"model\": \"mock-sine\",
    \"prompt\": \"continue this ambient texture with subtle low-frequency movement\",
    \"input_audio_path\": \"$INPUT_AUDIO\",
    \"source_duration\": 4.0,
    \"target_duration\": 10.0,
    \"duration\": 10.0,
    \"steps\": 8,
    \"seed\": -1
  }"
echo
