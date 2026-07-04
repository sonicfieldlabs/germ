# germ

germ is an open-source modular lab for generative microsound. It treats sound as
living matter: grains, cells, cultures, strains, control signals, and lineages that
can be generated, granulated, mutated, routed, listened to, and traced.

Germinator remains the legacy/internal engine name for the prototype generation
system. The public environment is now `germ`.

germ belongs to the open/research/community side of Sonic Field Labs: a tool
for listening agents, public repositories, experimental frameworks, and emerging
audio technologies. It is not a commercial product shell and it is not just a model
loader.

germ is not an official Stability AI product. It is an independent open
exploration tool for working with Stable Audio 3 workflows.

## Stable Audio 3 Focus

The app exposes a local FastAPI server, a browser dashboard, generated WAV files,
metadata JSON, and provider switching across mock, Python, MLX, and future API
routes. It keeps technical Stable Audio controls visible while adding a germ workflow
layer for sound matter, micro modules, culture, strain, mutation, pruning,
propagation, listening, curation, and harvest.

Official Stable Audio references:

- https://github.com/Stability-AI/stable-audio-3
- https://github.com/Stability-AI/stable-audio-3/blob/main/docs/workflows/inference.md
- https://github.com/Stability-AI/stable-audio-3/tree/main/optimized/mlx
- https://github.com/Stability-AI/stable-audio-3/blob/main/docs/workflows/lora.md

## Current Capabilities

- Text-to-audio generation through `POST /generate`.
- Audio-to-audio mutation/grafting through `POST /audio-to-audio`.
- Region pruning/healing through `POST /inpaint`.
- Continuation/propagation through `POST /continue`.
- Batch and seed variations.
- Layer comparison and source handoff.
- Library and Herbarium-style archive views over generated metadata.
- Wavetable Forge routes for conversion, prompt generation, mutation, rendering,
  import, export, and Petri audition.
- LoRA loading, strength control, and a persistent Strain registry surfaced in
  Thermostat and Culture Mix workflows.
- Micro/Matter module family for grains, cells, swarms, membranes, spectral tissue,
  quanta, microscope analysis, persisted matter profiles, biome save/load, and
  incubated evolution.
- Control layer for audio-to-control, safe OSC, MIDI intent, CV-safe exports, and
  control ancestry, including the norns/Fates OSC bridge.
- Listener prompt enhancement and heuristic scoring through `/listener/enhance`
  and `/listener/score`, with optional local Ollama fallback.
- Earworm 0.1 export of generated metadata into local context-chain sessions.
- Shared audio player with waveform drawing, metadata preview, path copy, open, and
  Finder reveal.
- Diagnostics for provider readiness and Hugging Face access.

## Micro / Matter Architecture

germ works across three scales:

| Scale | Unit | Modules |
| --- | --- | --- |
| Micro | grain / cell / quanta | Grain Culture, Cell Splitter, Quanta, Microscope |
| Meso | colony / tissue / swarm | Particle Engine, Swarm, Colony, Spectral Tissue |
| Macro | organism / culture / graph | Canvas, Genetic Matrix, Controllers, Performance |

The Micro palette is additive. It uses the existing canvas module system and semantic
FX bridge, so the current generation, library, control, and lineage flows stay intact.

## Install

```bash
uv sync --extra dev --extra python-provider
```

Copy `.env.example` to `.env` if you want to override defaults.

## Run

Double-click in Finder or run:

```bash
./launch_germ.command
```

The dashboard opens at:

```text
http://127.0.0.1:8765/dashboard
```

Server-only launch:

```bash
./scripts/run_server.sh
```

private-network launch for another device in the same private-network:

```bash
./scripts/run_private-network.sh
```

Open the printed `http://<private-network-ip>:8765/dashboard` URL from the other device.
The script binds to the detected private-network IP by default and allowlists localhost,
the detected private-network IP, the local host name, and private-network MagicDNS host names
in `GERM_ALLOWED_HOSTS`.
`GERM_ALLOWED_HOSTS` is the preferred name; `GERMINATOR_ALLOWED_HOSTS` remains a
legacy fallback. The private-network launcher now fails closed if no private-network IP is
detected, instead of binding to all interfaces.

Health check:

```bash
curl http://127.0.0.1:8765/health
```

## Python And MLX Runtimes

The Python provider wraps the official `stable_audio_3` Python API. The MLX provider
wraps the official Apple Silicon `optimized/mlx/sa3` CLI.

Install the Python provider route:

```bash
./scripts/install_python_provider.sh
```

Install the Apple Silicon MLX route:

```bash
./scripts/install_mlx_provider.sh
```

Useful environment variables:

```text
GERM_HOST=127.0.0.1
GERM_PORT=8765
GERM_ACTIVE_PROVIDER=mock
GERM_OUTPUT_DIR=output
GERM_ALLOWED_INPUT_ROOTS=output
GERM_OFFICIAL_REPO_DIR=vendor/stable-audio-3
GERM_MLX_REPO_DIR=vendor/stable-audio-3
GERM_ALLOWED_MODEL_ROOTS=vendor/stable-audio-3,output
GERM_DEFAULT_MODEL=small-sfx
GERM_DEFAULT_DEVICE=auto
GERM_MLX_DECODER=same-s
GERM_PROVIDER_TIMEOUT_SECONDS=1800
GERM_JOB_WORKERS=1
GERM_MAX_UPLOAD_MB=100
GERM_MAX_IMAGE_MB=8
GERM_ENABLE_CLOUD_VISION=0
GERM_LISTENER_MAX_AUDIO_MB=50
GERM_LISTENER_MAX_DURATION_SECONDS=600
GERM_RELOAD=1            # launch_germ.command only: start uvicorn with --reload
GERM_private-network_IP=...    # scripts/run_private-network.sh only: override the auto-detected IP
OLLAMA_BASE_URL=http://127.0.0.1:11434
OLLAMA_MODEL=llama3.2
```

The older `GERMINATOR_*` names are still accepted as fallbacks for compatibility.

The Stable Audio 3 Python provider uses gated Hugging Face model repositories. Accept
the model terms and log in when needed:

```bash
uv run hf auth login
curl "http://127.0.0.1:8765/huggingface/status?check_models=true"
```

Cancellation note: queued jobs can always be cancelled. MLX jobs terminate the
`sa3` subprocess group on cancellation. The Python provider uses the in-process
Stable Audio API, which does not expose a reliable mid-render interrupt; a cancel
request is recorded, but a render already inside the model call may finish normally.

## germ Vocabulary

| germ term | Stable Audio meaning |
| --- | --- |
| Seed | Prompt, random seed, source audio, initial idea |
| Germinate | Text-to-audio generation |
| Sprout | First generated sound |
| Colony | Batch or group of generated candidates |
| Culture | Session/workspace/group of related sounds |
| Strain | LoRA adapter, style, sonic identity, or sound family |
| Grain / Cell | Micro-event, transient, short sound particle |
| Tissue | Spectral or textural layer built from grains |
| Metabolism | Audio feature flow converted into control behavior |
| Membrane | Filtering or gating boundary between source and output |
| Mutation | Variation or audio-to-audio transformation |
| Graft | Source-audio transformation with prompt guidance |
| Prune / Heal | Inpainting, repair, or region replacement |
| Propagate | Continuation or extension |
| Sterilize | Negative prompt |
| Petri | Candidate grid and audition board |
| Herbarium | Saved library/archive |
| Harvest | Export or final selection |
| Listener | Agentic listening, curation, and repair suggestions |

## Existing App Sections Preserved

- Generate
- Edit Source
- Variations
- Layers
- Library
- LoRA
- Status
- Model picker
- Python and MLX runtime support
- WAV output and current audio player

## Current Sections

- Home/About: germ overview and workflow map.
- Seeds: prompt/source/random seed presets and germination entry point.
- Petri: candidate colony grid over generated library metadata.
- Culture: local session metadata scaffold for grouped sound work.
- Micro: granular and microsound modules for sound matter work.
- Mutations: audio-to-audio workflow with Morph Depth.
- Pruning: inpainting workflow with numeric region controls.
- Propagation: continuation workflow for loops, tails, beds, and textures.
- Strains: creative LoRA palette and Culture Mix scaffold.
- Herbarium: archive view over saved outputs.
- Listener: prompt enhancer, heuristic scorer, repair proposals, and optional
  local Ollama prompt enhancement with no mandatory cloud key.
- Lab: placeholders for SAME latents, dataset prep, model comparison, benchmarks,
  and agent experiments.

## LoRA Strains

The existing LoRA manager is still present under Thermostat. Strain cards add a
creative control layer on top of adapter paths:

- LoRA = Strain
- LoRA Stack = Culture Mix
- LoRA Strength = Strain Intensity

Saved strain cards live in `output/strains/strains.json` and can carry adapter
paths, strength ranges, tags, prompt vocabulary, recommended Micro modules,
licensing, authorship, and provenance. Technical labels remain visible in tooltips
and metadata.

## Petri Candidate Explorer

Petri reuses generated library metadata and gives each candidate actions for preview,
favorite, use as source, mutate, prune, propagate, and harvest. It is experimental
and intentionally additive; it does not replace the existing Variations or Library
sections.

## Listener

Listener can enhance a rough idea into a Stable Audio prompt, merge a negative
prompt, score WAV files with bounded local DSP features, propose loop-seam repair
ranges, and fall back to local Ollama when available. It does not require a cloud
LLM API for the app to run.

## API

Core endpoints:

```text
GET  /health
GET  /models
GET  /diagnostics
GET  /performance
GET  /huggingface/status
POST /earworm/export
POST /models/load
POST /generate
POST /audio-to-audio
POST /inpaint
POST /continue
POST /audio/import
POST /audio/process
POST /audio-tools/operate
POST /image-to-audio/analyze
POST /time/render
POST /lora/load
POST /lora/strength
GET  /listener/providers
POST /listener/enhance
POST /listener/score
GET  /strains
POST /strains
GET  /strains/{strain_id}
DELETE /strains/{strain_id}
POST /strains/load
POST /micro/matter-profile
GET  /micro/matter-profiles
GET  /micro/biomes
POST /micro/biomes
GET  /micro/biomes/{biome_id}
DELETE /micro/biomes/{biome_id}
GET/POST /wavetables/... (list, detail, data, convert, prompt, mutate, render, import, export)
GET/POST /control/...  (ports, routes, enable/delete, events, OSC, norns/Fates, MIDI, CV profiles, analyze-audio, render-cv)
POST /jobs/submit
GET  /jobs/{job_id}
POST /jobs/{job_id}/cancel
WS   /jobs/{job_id}/events
GET  /library
GET  /files/{file_path}
POST /files/rename
POST /files/delete
POST /files/reveal
```

Example germination request:

```bash
curl -X POST http://127.0.0.1:8765/generate \
  -H "content-type: application/json" \
  -d '{
    "provider": "mock",
    "model": "mock-sine",
    "prompt": "TrackType: SFX, dry close-microphone loop of metallic friction",
    "negative_prompt": "speech, vocals, melody, long reverb",
    "duration": 3.0,
    "steps": 8,
    "cfg_scale": 1.0,
    "seed": -1,
    "output_name": "metal_friction_sprout",
    "tags": ["SFX", "loop", "texture"]
  }'
```

## Metadata

Generated metadata keeps existing compatibility fields and adds germ identity fields:

```json
{
  "app": "germ",
  "product": "germ",
  "legacy_app": "Germinator",
  "concept": "sound_matter",
  "engine": "stable-audio-3",
  "germinator_mode": "mutate",
  "technical_mode": "audio-to-audio",
  "runtime": "mlx",
  "model": "sm-sfx",
  "prompt": "...",
  "negative_prompt": "...",
  "seed": 12345,
  "duration": 8.0,
  "init_noise_level": 0.42,
  "morph_depth": 0.42,
  "source_audio_path": "...",
  "lora_strains": [],
  "culture_id": null,
  "tags": [],
  "created_at": "..."
}
```

Each generated metadata record also includes an `earworm` block with deterministic
session, asset, and provenance IDs. Use `POST /earworm/export` to write a local
Earworm 0.1 session JSON from a metadata path. The cross-stack fixture lives at
`tests/fixtures/germ-organism-mapping.session.json`.

## Development Notes

Run tests:

```bash
.venv/bin/pytest
```

Run the environment report:

```bash
.venv/bin/python scripts/check_environment.py
```

Current follow-up work is tracked in `germ-future.md`. The core review path now has
route tests, cache-aware library refreshes, cancellation propagation, Microcosmos
state recovery, and generated-output ignores in place; larger feature work should
start from the future plan rather than stale in-UI TODO labels.
