# Stable Audio integration

germ should treat this project as a local sidecar service. The macOS app or plugin
bridge starts or discovers the server, exports selected clips to disk, calls HTTP
endpoints, then imports returned WAV files into layers.

The built-in dashboard is only a local control surface over the same API. Clients should
call the FastAPI endpoints directly, not dashboard internals.

## Runtime Boundary

Do not run Stable Audio inference in the realtime DSP callback. Use async jobs or
background tasks in the app/plugin bridge.

## Modes

- Generate: `/generate`
- Morph: `/audio-to-audio`
- Replace selection: `/inpaint`
- Continue clip: `/continue`
- Variations: repeated `/generate` or edit calls with seed changes
- LoRA style: `/lora/load` and `/lora/strength`
- Async render: `/jobs/submit` then `/jobs/{job_id}` or `/jobs/{job_id}/events`
- Library browser: `/library`
- Control layer: `/control/ports`, `/control/routes`, `/control/events`
- Audio-to-control: `/control/analyze-audio`
- CV-safe control WAV export: `/control/render-cv`
- Safe bridge status and profiles: `/control/bridge/status`, `/control/cv/profiles`
- OSC bridge: `/control/osc/send`, `/control/osc/receive`
- Control ancestry graph: `/control/genetic/control-graph`
- Micro/Matter modules: dashboard canvas modules for grain culture, particle engine,
  cell splitter, swarm, colony, membrane, metabolism, spectral tissue, quanta,
  microscope, and incubator.

## Layer Metadata

Attach the metadata JSON returned by the server to each generated layer. It records
provider, model, prompt, seed, duration, input path, output path, and LoRA settings.

## Suggested Flow

1. App checks `GET /health`.
2. App checks `GET /models`.
3. User chooses provider/model/mode.
4. germ exports selected source audio if needed.
5. germ calls one generation endpoint for short tasks, or `/jobs/submit` for long
   local renders.
6. germ watches `/jobs/{job_id}` or the WebSocket event stream if submitted async.
7. germ imports `audio_files[0]`.
8. germ attaches `metadata_files[0]` to the layer.
9. germ stores the returned `job_id`.

## Loop And Layer Comparison

Stable Audio 3 does not expose a separate "loop variation" endpoint. germ should
create loop candidates by repeating the same request with a fixed duration and
different seeds. Each returned WAV becomes a candidate layer with its metadata
attached. The dashboard's Variations and Layers sections use this same pattern.

## Generated Library

`GET /library` scans saved metadata and returns generated assets that still exist
on disk. germ can use it to reconnect projects to previous renders, rebuild layer
provenance, or offer a searchable generated-sound browser.

## Micro / Matter Layer

The Micro/Matter layer is the conceptual bridge between generated audio and control.
It does not replace Stable Audio endpoints. It adds canvas modules that describe and
shape sound below the normal musical-object scale:

- Grain Culture and Particle Engine: grain corpus and particle playback scaffolds.
- Cell Splitter, Quanta, and Microscope: micro-event extraction and analysis.
- Swarm, Colony, and Incubator: population behavior and slow mutation.
- Membrane, Metabolism, and Spectral Tissue: filtering, control conversion, and
  spectral transformation.

These modules are safe additions to the existing graph. They contribute realtime
audition parameters where possible and semantic generation context through the same
metadata and lineage surfaces used by existing FX modules.

The backend now persists the control layer behind those concepts:

- `output/strains/strains.json` stores strain cards for LoRA adapters, strength
  ranges, prompt vocabulary, tags, recommended modules, licensing, and provenance.
- `output/micro/*.json` stores Micro/Matter profiles generated from saved WAV files.
- `/control/genetic/control-graph` links sounds to strain, micro-module, and
  micro-profile nodes so the dashboard can display culture ancestry without
  relying on transient browser state.

## Job Events

`POST /jobs/submit` returns immediately and schedules the same provider call used by
the direct endpoints. `WS /jobs/{job_id}/events` streams status snapshots until
`done` or `error`. Jobs are in-memory for now, while WAV and metadata outputs remain
persisted on disk.

## Control Layer

The control layer is a typed local patch contract over the existing API. It does not
open hardware outputs by itself. Clients can discover allowlisted ports with
`GET /control/ports`, persist source-to-destination routes with `POST /control/routes`,
and post monitor events with `POST /control/events`.

The first supported signal graph is conservative:

- Internal outputs: selected audio, selected region, audio-to-control, macro, gesture,
  clock, lineage metadata, browser MIDI input, OSC intent.
- Internal destinations: generation controls, time event controls, MIDI CC intent,
  OSC intent, and CV-safe render export.

Generated and time-render requests can include `control_routes`, `control_snapshots`,
and `control_sources`. These fields are stored in metadata and lineage so future
Genetic Matrix views can show control parentage without breaking existing payloads.

`POST /control/analyze-audio` converts an existing output WAV into reusable control
features: envelope, RMS, transient, spectral-centroid proxy, pitch, chroma,
onset-density, tempo, and timbre proxy. The artifact is saved under `output/control/`.

`POST /control/render-cv` writes a mono 44.1 kHz WAV control artifact under
`output/control/`. It is explicitly metadata-marked as `hardware_output: false`; any
future DC-coupled CV hardware bridge must add opt-in arming, calibration, clamping,
slew limiting, panic zero, and speaker protection before routing to physical outputs.

CV calibration profiles are available through `/control/cv/profiles`. A profile can
only be armed when it is marked calibrated, speaker-protected, and the arming request
includes explicit confirmation. `/control/panic` disarms all profiles.

OSC UDP send is implemented for local/private/link-local targets only. OSC receive is
an explicit ingestion endpoint for an external bridge, not a background listener.
