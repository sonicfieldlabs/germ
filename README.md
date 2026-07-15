# GERM

GERM is a local-first modular laboratory for generative microsound. It treats
sound as matter that can be generated, granulated, mutated, routed, listened
to, cultivated, and traced through lineage.

Current release: `0.2.0`.

GERM is an independent Sonic Field Labs project. It can use Stable Audio 3
providers, but it is not an official Stability AI product.

## What works

- Text-to-audio generation, seed/batch variation, audio-to-audio grafting,
  inpainting, continuation, layer comparison, and source handoff.
- Mock, Stable Audio 3 Python, Stable Audio 3 MLX, and Stability API provider
  routes with readiness diagnostics and cancellable jobs.
- A browser dashboard and native macOS shell over the same FastAPI server and
  server-owned session graph.
- Realtime Chamber audio with granular and envelope-follower AudioWorklets,
  pooled trigger voices, smoothed master gain/FX updates, headroom management,
  compression, soft clipping, and WAV recording.
- Micro/Matter modules for grains, cells, swarms, membranes, spectral tissue,
  quanta, microscope analysis, saved matter profiles, biomes, and incubated
  evolution.
- Wavetable Forge conversion, prompt, mutation, render, import/export, and
  audition routes.
- LoRA loading and a persistent Strain registry for adapter identity,
  intensity, tags, licensing, and provenance.
- Audio-to-control analysis, bounded OSC, MIDI intent, CV-safe exports, and a
  norns/Fates bridge.
- Local library, Herbarium, waveform player, metadata preview, path-safe file
  operations, and generation lineage.
- OÍDA re-listening and prompt derivation. GERM performs bounded local signal
  checks; OÍDA owns machine listening and audio understanding.

## Scales

| Scale | Unit | Representative modules |
| --- | --- | --- |
| Micro | grain, cell, quanta | Grain Culture, Cell Splitter, Quanta, Microscope |
| Meso | colony, tissue, swarm | Particle Engine, Swarm, Colony, Spectral Tissue |
| Macro | organism, culture, graph | Chamber, Genetic Matrix, controllers, performance |

All three scales use the same module graph, semantic FX bridge, sessions,
library, and lineage model.

## Listening Stack integration

| Component | Version / contract | GERM integration |
| --- | --- | --- |
| [OÍDA](https://github.com/sonicfieldlabs/oida) | 0.6.0 / `oida/gateway/v0.2` | Re-listen to generated sound, derive editable prompts, and retain a listening only when requested. |
| [Earworm](https://github.com/sonicfieldlabs/earworm) | 0.4.0 / akousma spec v1.3 | Export generation context and preserve provenance, lineage, location/capture, and covenants. |
| [Akousmata](https://github.com/sonicfieldlabs/akousmata) | 0.4.0 | Import remembered sound, prompt, or lineage; write successful generations back as child akousmata. |
| [AKOÚŌ](https://github.com/sonicfieldlabs/akouo) | `akouo/v0.7` | Keeps listening claims, evidence permissions, apparatus, and covenants consistent across the stack. |
| [Algophony](https://github.com/sonicfieldlabs/algophony) | 0.5.0 | Can evaluate lineage-bearing generation batches without changing GERM's generation state. |
| [ORAM](https://github.com/sonicfieldlabs/oram) | 0.4.0 | Uses the local GERM-compatible generation surface for constrained sound summoning and transformation. |

The core handoff is:

```text
OÍDA listens → Akousmata remembers → GERM cultivates
       ^                                  |
       +----------- listen again --------+
```

## Install

Requirements: Python 3.10+ and `uv`.

```bash
uv sync --extra dev
```

Install a local Stable Audio provider only when needed:

```bash
uv sync --extra python-provider
./scripts/install_mlx_provider.sh       # Apple Silicon route
```

Provider model repositories and weights remain outside Git. See
[local setup](docs/local_setup.md) and
[provider design](docs/provider_design.md).

## Run

```bash
./launch_germ.command
```

Open `http://127.0.0.1:5178/dashboard`.

Server only:

```bash
./scripts/run_server.sh
```

Native macOS shell:

```bash
apps/macos/script/build_and_run.sh
```

The shell embeds the same dashboard and supervises the same daemon. It does
not maintain a second session or generation state.

Health and diagnostics:

```bash
curl http://127.0.0.1:5178/health
curl http://127.0.0.1:5178/diagnostics
```

## Core API

The complete request and response contract is in
[docs/api_reference.md](docs/api_reference.md). Principal route groups:

| Group | Routes |
| --- | --- |
| Generation | `/generate`, `/audio-to-audio`, `/inpaint`, `/continue`, `/jobs/*` |
| Models | `/models`, `/models/load`, `/diagnostics`, `/huggingface/status` |
| Listening | `/listener/enhance`, `/listener/score`, `/listener/relisten` |
| Memory | `/earworm/export`, `/import`, `/akousma/*` |
| Micro/Matter | `/micro/matter-profile`, `/micro/biomes/*` |
| Strains | `/strains/*`, `/lora/load`, `/lora/strength` |
| Wavetables | `/wavetables/*` |
| Control | `/control/*` |
| Sessions | `/sessions`, `/sessions/current`, `/sessions/{id}` |
| Files/library | `/library`, `/files/*` |

Example mock generation:

```bash
curl -X POST http://127.0.0.1:5178/generate \
  -H "content-type: application/json" \
  -d '{
    "provider": "mock",
    "model": "mock-sine",
    "prompt": "dry close-microphone loop of metallic friction",
    "negative_prompt": "speech, vocals, melody, long reverb",
    "duration": 3.0,
    "steps": 8,
    "cfg_scale": 1.0,
    "seed": -1,
    "output_name": "metal_friction_sprout",
    "tags": ["SFX", "loop", "texture"]
  }'
```

## Provider and data boundaries

- The default provider is `mock`; no model or weight is downloaded
  implicitly.
- Local input, output, model, upload, and duration limits are configured in
  `.env.example`.
- Hosted generation and cloud vision remain opt-in. Credentials are read from
  the process environment and are never stored in generation metadata.
- The server binds to loopback and validates Host/Origin headers by default.
- Generated audio, metadata, uploads, sessions, strains, model weights, build
  products, and local app state are ignored by Git.
- A generation written to Akousmata records only portable identifiers and
  relative/protocol-safe provenance. Machine-specific paths stay local.

## Development

```bash
uv run pytest -q
uv run ruff check server tests
node --check dashboard/static/app.js
node --check dashboard/static/dish.js
node scripts/smoke_dashboard.mjs
```

## Documentation

- [API reference](docs/api_reference.md)
- [Architecture of Micro/Matter](docs/germ_micro_architecture.md)
- [Stable Audio integration](docs/stable-audio-integration.md)
- [OÍDA and Akousmata integration](docs/oida-integration.md)
- [Provider design](docs/provider_design.md)
- [Local setup](docs/local_setup.md)
- [Native macOS shell](docs/macos-shell.md)
- [Troubleshooting](docs/troubleshooting.md)
- [Changelog](CHANGELOG.md)

## License

MPL-2.0. See [LICENSE](LICENSE).
