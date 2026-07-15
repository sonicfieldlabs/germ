# API Reference

Default base URL:

```text
http://127.0.0.1:5178
```

## GET /health

Returns server status, active provider, device, loaded models, and output directory.

## GET /models

Returns provider availability and model lists.

## GET /diagnostics

Returns local runtime readiness, importable dependencies, provider status, provider
paths, missing pieces for real local models, and install commands.

## GET /performance

Returns recent request timings recorded by the in-process performance middleware
(per-route durations, status codes, and a summary).

## POST /earworm/export

Exports one generated metadata JSON file into an Earworm 0.4-compatible session with prompt,
generation request, optional expanded-sensorium metadata packet, generated-audio,
analysis, render, provenance, and retention records.

```json
{
  "metadata_path": "output/metadata/example.json",
  "persist": true
}
```

When `persist=true`, the session JSON is written under `output/metadata/` and the
response includes `session_file` plus the inline `session` object.

## GET /import

The oída→germ handoff (the three buttons). Query params: `akousma` (record id in the
shared akousmata store), `mode` (`sound` | `prompt` | `lineage`), `format`
(`html` default, or `json`). `sound` imports the record's audio into germ's library
via the standard audio-import flow and stamps `extensions["germ.import"]` back onto
the shared record; `prompt` derives a structured `oida-germ.prompt/v0.1` handoff from
the record's listening block (editable prompt, provenance, evidence, covenant, and
parent id); `lineage` opens the lineage explorer (parents, children, ancestry). The
HTML prompt handoff places that structure in browser storage and opens the main prompt
canvas, where the text remains editable before cultivation.

## GET /akousma/record/{akousma_id}

Returns the raw akousma record from the shared store (404 if unknown, 503 if the
`akousma` package is not installed).

## GET /akousma/lineage/{akousma_id}

Returns `{record, parents, children, ancestor_ids}` with parent/child records
resolved from the shared store — the data behind the lineage explorer.

## POST /akousma/generation

Writes a germ generation into the shared store as a new akousma whose
`lineage.parent_akousma_ids` point at its sources.

```json
{
  "audio_path": "output/audio/example.wav",
  "prompt": "make it metallic",
  "model": "stable-audio-3",
  "operation": "audio-to-audio",
  "parent_akousma_ids": ["akm_..."],
  "tags": ["metallic"]
}
```

Unknown parent ids are rejected with 404; the response returns `akousma_id` plus the
full record. The audio stays in place (referenced by `file://` uri + content hash).

## GET /huggingface/status

Checks Hugging Face CLI auth for the gated Stable Audio 3 Python-provider weights.
Use `check_models=true` to run dry-run download checks for Small SFX, Small Music,
and Medium:

```bash
curl "http://127.0.0.1:5178/huggingface/status?check_models=true"
```

Response includes `auth.logged_in`, per-model `status`, and `next_steps`. The route
never returns or logs token values.

## POST /models/load

```json
{
  "provider": "stable_audio_python",
  "model": "small-sfx",
  "device": "auto"
}
```

Loads a provider/model lazily. The MLX provider records the selected model because
the CLI loads weights in its subprocess.

For hosted generation use provider `stability_api`, model `stable-audio-3`, and set
`STABILITY_API_KEY`. The hosted route accepts 1–380 second outputs, 4–8 steps, CFG
1–25, and uses asynchronous submit/poll. Its editing modes accept WAV or MP3 sources
between 6 and 380 seconds (maximum 100 MB) and require `batch_size=1`. Local LoRA is
rejected for this provider; a supplied negative prompt is retained in metadata as an
ignored control because the hosted endpoint has no negative-prompt field.

## POST /generate

```json
{
  "provider": "stable_audio_python",
  "model": "small-sfx",
  "prompt": "close microphone recording of dry gravel footsteps",
  "negative_prompt": "",
  "duration": 4.0,
  "steps": 8,
  "cfg_scale": 1.0,
  "seed": -1,
  "batch_size": 1,
  "lora": [],
  "output_name": "gravel_footsteps"
}
```

All four generation routes also accept the neutral/effective prompt fields
`base_prompt`, `modulated_prompt`, `base_negative_prompt`, and
`modulated_negative_prompt`. Providers receive the effective text; metadata preserves
both versions and the applied modulators under `germ.prompt/v0.1`.

To register a successful derived sound in Akousmata in the same workflow, add:

```json
{
  "remember_to_akousmata": true,
  "parent_akousma_ids": ["akm_..."],
  "akousma_relations": [],
  "listening_context": {},
  "covenant": {},
  "akousma_summary": "optional concise memory summary"
}
```

Retention is opt-in. The created Akousma id and state are written into generation
metadata. If memory registration fails, the audio generation remains successful and
the failure is reported under its Akousmata metadata block.

## POST /audio-to-audio

Accepts JSON with `input_audio_path` or multipart form data with an uploaded audio
file. JSON request:

```json
{
  "provider": "stable_audio_python",
  "model": "medium",
  "prompt": "turn this recording into a metallic resonant drone",
  "input_audio_path": "/path/to/input.wav",
  "init_noise_level": 0.45,
  "duration": 20.0,
  "steps": 8,
  "seed": -1
}
```

## POST /inpaint

```json
{
  "provider": "stable_audio_python",
  "model": "medium",
  "prompt": "replace this region with a punchy metallic impact",
  "input_audio_path": "/path/to/input.wav",
  "inpaint_ranges": [[4.0, 6.0], [12.5, 13.2]],
  "duration": 20.0,
  "steps": 8,
  "seed": -1
}
```

## POST /continue

```json
{
  "provider": "stable_audio_python",
  "model": "medium",
  "prompt": "continue this ambient texture",
  "input_audio_path": "/path/to/input.wav",
  "source_duration": 12.0,
  "target_duration": 40.0,
  "steps": 8,
  "seed": -1
}
```

## POST /audio/import

Multipart upload of an external audio file plus optional metadata fields. The file is
stored under `output/uploads/`, indexed into the library as an archive item, and capped
by `GERM_MAX_UPLOAD_MB` (`GERMINATOR_MAX_UPLOAD_MB` remains a legacy fallback).

## POST /audio/process

Time-stretch / pitch-shift an existing output file through the Rubber Band CLI
(`audio-time-pitch` job). Requires a `rubberband` binary on PATH; returns 422/504 when
processing fails or times out.

## POST /audio-tools/operate

Region operations over existing output audio (for example extracting a region into a
new library item). Results carry lineage back to the source sound.

## POST /image-to-audio/analyze

Analyzes an inline base64 image (capped by `GERM_MAX_IMAGE_MB`) into prompt material
for germination. Vision mode is local fallback by default; Gemini cloud vision is
used only when `GERM_ENABLE_CLOUD_VISION=1` and a `GEMINI_API_KEY` or
`GOOGLE_API_KEY` is present. Spectrogram mode stays in-browser/local.

## POST /time/render

Offline timeline mixdown: mixes WAV sources placed on a PPQ tick clock into one stereo
WAV, with per-event gain, pan, reverse, and pitch shift (Rubber Band when available,
resample fallback otherwise). Returns the rendered file plus metadata with event lineage.

## POST /lora/load

```json
{
  "provider": "stable_audio_python",
  "paths": ["/path/to/your_style.safetensors"]
}
```

This primes a Python model with reusable adapter weights. A generation's `lora` array
is still authoritative: loaded adapters absent from that request are set to strength
zero for that render. Include the adapters and strengths you want in every generation
request. MLX accepts request-local `.safetensors` paths plus optional `step_range`;
the Python provider rejects step-gated ranges.

## POST /lora/strength

```json
{
  "provider": "stable_audio_python",
  "strength": 0.7,
  "lora_index": 0
}
```

## GET /strains

Returns persisted strain cards from `output/strains/strains.json`.

## POST /strains

```json
{
  "name": "dust colony",
  "path": "output/strains/dust_colony.safetensors",
  "tags": ["granular", "brittle"],
  "prompt_vocabulary": ["dust", "grain", "cell"],
  "recommended_modules": ["grain_culture", "microscope"],
  "strength_min": 0.0,
  "strength_max": 1.5,
  "default_strength": 0.7
}
```

Saves or updates a strain card. The registry can track metadata before an adapter
file is available; provider loading still validates real model paths where required.

## POST /strains/load

```json
{
  "provider": "stable_audio_python",
  "strain_ids": ["strain_dust_colony_ab12cd34"]
}
```

Resolves strain IDs to adapter paths and delegates to the provider LoRA loader.

## GET /strains/{strain_id}

Returns one strain card.

## DELETE /strains/{strain_id}

Removes a strain card from the registry.

## GET /jobs/{job_id}

Returns in-memory job status, request parameters, output files, metadata files, and
errors. Job state is not yet persisted across server restarts; metadata files are
persisted.

## POST /jobs/submit

Submits a generation job and returns immediately with status and event URLs. This
uses the same provider methods as `/generate`, `/audio-to-audio`, `/inpaint`, and
`/continue`.

```json
{
  "mode": "text-to-audio",
  "request": {
    "provider": "mock",
    "model": "mock-sine",
    "prompt": "short dry ceramic click",
    "duration": 1.0
  }
}
```

Response:

```json
{
  "job_id": "uuid",
  "status": "queued",
  "mode": "text-to-audio",
  "provider": "mock",
  "model": "mock-sine",
  "status_url": "/jobs/uuid",
  "events_url": "/jobs/uuid/events"
}
```

## WS /jobs/{job_id}/events

Streams JSON snapshots of the in-memory job status until the job reaches `done` or
`error`. This is intended for germ/macOS/plugin progress UI while renders are
running outside the realtime audio path.

## POST /jobs/{job_id}/cancel

Cancels a queued or running dashboard job. Queued jobs are removed before execution;
running jobs receive a provider cancellation signal. The MLX provider terminates its
child process group when that signal is observed. The Python provider uses the
in-process Stable Audio API and may finish normally if it is already inside the
model call.

## GET /control/ports

Returns the allowlisted typed control ports. The first implementation includes
internal audio/control/event/metadata ports plus MIDI, OSC, and CV-safe export
intent ports. It does not open hardware outputs.

## GET /control/routes

Returns persisted source-to-destination control routes from `output/control/routes.json`.

## POST /control/routes

```json
{
  "source_port_id": "mod:audio_to_control",
  "target_port_id": "generation:seed_drift",
  "source_kind": "control",
  "target_kind": "control",
  "label": "Envelope to seed drift",
  "transform": {
    "amount": 0.5,
    "smoothing_ms": 20,
    "curve": "linear"
  }
}
```

Routes are restricted to known ports so MIDI/OSC input cannot target arbitrary app
state.

## POST /control/routes/{route_id}/enable

Enables or disables an existing route:

```json
{
  "enabled": false
}
```

## DELETE /control/routes/{route_id}

Deletes a persisted control route.

## GET /control/bridge/status

Returns bridge availability and safety state. OSC UDP send is available for
loopback/private/link-local targets. Native MIDI is reported as available only when
an optional local backend is importable. CV hardware output remains disabled by
default.

## GET /control/events

Returns recent persisted control monitor events.

## GET /control/monitor

Alias for `/control/events`. It is intentionally read-only and does not open any
hardware listener or background UDP/MIDI process.

## POST /control/events

Records a typed local monitor event. The dashboard uses this for MIDI scan results,
OSC bridge events, and canvas control snapshots.

## POST /control/panic

Disarms all CV profiles and records a `panic_zero` control event. This is a local
safety action only: MIDI output is not enabled and CV hardware output remains gated by
profile calibration, speaker-protection, and explicit arm confirmation.

## POST /control/osc/send

Sends one OSC UDP packet to a loopback/private/link-local target and records a
control event. Public-network targets are rejected.

```json
{
  "host": "127.0.0.1",
  "port": 9000,
  "address": "/germ/mutation",
  "values": [0.5]
}
```

## POST /control/osc/receive

Records an OSC message delivered by an explicit local bridge. This endpoint does not
open a background UDP listener.

## GET /control/osc/norns/profile

Returns the norns/Fates bridge profile with OSC address mappings for germ dish
gravity, viscosity, energy, and spawn pulses.

## POST /control/osc/norns/send

Sends the norns/Fates bridge messages through the same private/loopback OSC safety
gate as `/control/osc/send`.

## POST /control/midi/send

Records MIDI output intent, delegates live output to browser Web MIDI, or uses an
optional native `mido` backend when installed and configured.

## GET /control/cv/profiles

Lists CV calibration/arming profiles. Profiles are safety metadata; they do not route
audio to hardware.

## POST /control/cv/profiles

Saves a CV profile with channel, mode, voltage range, clamps, slew, gate voltage,
calibration status, and speaker-protection state.

## POST /control/cv/profiles/{profile_id}/arm

Arms or disarms a calibrated CV profile. Arming requires `confirm=true`,
`calibrated=true`, and `speaker_protection=true`.

## POST /control/analyze-audio

```json
{
  "input_audio_path": "output/audio/example.wav",
  "features": ["envelope", "rms", "transient", "spectral_centroid"],
  "window_ms": 40,
  "hop_ms": 20,
  "smooth": 0.15
}
```

Writes a reusable control-analysis JSON artifact under `output/control/`. Supported
features are `envelope`, `rms`, `transient`, `spectral_centroid`, `pitch`, `chroma`,
`onset_density`, `tempo`, and `timbre`.

## POST /control/render-cv

```json
{
  "input_control_path": "output/control/example_control.json",
  "feature": "envelope",
  "duration": 4.0,
  "mode": "cv",
  "range": "unipolar",
  "scale": 0.5,
  "slew_ms": 5
}
```

Writes a mono 44.1 kHz control WAV under `output/control/`. The response and metadata
are always marked `hardware_output: false`.

## GET /control/genetic/control-graph

Builds a control ancestry graph from recent metadata files plus persisted control
events. Nodes include sounds, strains, micro modules, micro profiles, control routes,
control sources, and control events; edges include parent, strain-applied,
micro-shape, micro-profiled, control-parent, controlled-result, and emitted-event
relations.

## POST /micro/matter-profile

```json
{
  "input_audio_path": "output/audio/example.wav",
  "metadata_path": "output/metadata/example.json",
  "source_id": "sound_example",
  "module": "microscope",
  "window_ms": 20,
  "hop_ms": 10
}
```

Writes a `micro_matter_profile` JSON artifact under `output/micro/`. The response
contains descriptors such as `grain_density`, `cell_count`, `transient_cells`,
`quanta_rate`, `swarm_spread`, and `spectral_tissue`, plus module suggestions for
the Micro palette.

## GET /micro/matter-profiles

Lists recent persisted Micro/Matter profile artifacts.

## GET /micro/biomes

Lists saved Microcosmos biome states under `output/micro/biomes/`.

## POST /micro/biomes

Saves a bounded biome state:

```json
{
  "name": "mist biome",
  "state": {
    "germs": [],
    "modules": []
  }
}
```

## GET /micro/biomes/{biome_id}

Loads one biome state.

## DELETE /micro/biomes/{biome_id}

Deletes one saved biome state.

## GET /sessions

Lists named Chamber sessions saved under `output/sessions/`. A session is the
full serializable module graph (assets, modules, connections, candidates, and
clock state). Because sessions live on the daemon, the browser dashboard and
the native macOS shell share one list.

## POST /sessions

Saves (or updates, by name) a named session:

```json
{
  "name": "evening drone patch",
  "graph": {
    "version": 1,
    "assets": [],
    "nodes": [],
    "edges": [],
    "timeState": {}
  }
}
```

Graphs are capped at 4 MB and 128 named sessions.

## GET /sessions/current

Returns the autosaved live graph (`status: "empty"` when none exists). The
dashboard pushes the current graph here on a debounce so any surface can
restore exactly where the last one left off.

## PUT /sessions/current

Replaces the autosaved live graph. Accepts an optional `client_id` marking
which surface wrote last.

## DELETE /sessions/current

Clears the autosaved live graph (the dashboard calls this on graph reset).

## GET /sessions/{session_id}

Loads one named session with its full graph.

## DELETE /sessions/{session_id}

Deletes one named session.

## GET /listener/providers

Describes the integration boundary: Germ's neutral prompt compiler, its measured
local signal check, and the Oída-owned re-listening bridge. Germ does not load an
audio-understanding model.

## POST /listener/enhance

Normalizes an editable prompt and returns non-destructive suggestions. It never
injects SFX/music/voice assumptions or silently expands the negative prompt.

## POST /listener/score

Scores a WAV file inside `GERM_ALLOWED_INPUT_ROOTS` using bounded local DSP
features and returns measured warnings and repair proposals. This endpoint is a
signal check, not semantic listening.

## POST /listener/relisten

Uses Oída's `/generation/relisten` route when the sound metadata carries an earlier
Oída generation id, preserving Oída's source/output route comparison. Otherwise it
starts with `/gateway/listen`. It then asks the prompt-only generation bridge for the
next editable prompt. Germ stores a compact derived result under
`extensions["germ.relisten"]`; all audio understanding remains owned by Oída.
`remember=true` calls Oída's explicit `/memory/remember` route and returns its shared
Akousma id. Without that opt-in, germ does not append the result to shared Akousmata.

```json
{
  "audio_path": "output/audio/cultivated.wav",
  "metadata_path": "output/metadata/cultivated.json",
  "route_preset": "generative",
  "intent": "variation",
  "remember": false
}
```

## GET /wavetables

Lists wavetable assets from `output/wavetables/`.

## GET /wavetables/{wavetable_id}

Returns one wavetable metadata record.

## GET /wavetables/{wavetable_id}/data

Returns the raw float wavetable data.

## POST /wavetables/convert

Converts an allowed source WAV into a `germ_wavetable` metadata/data pair.

## POST /wavetables/prompt

Builds a wavetable-focused prompt contract, generates source audio, and converts it
into one or more wavetable assets.

## POST /wavetables/mutate

Renders a parent wavetable, mutates the render through audio-to-audio, and converts
the result into child wavetable assets with lineage.

## POST /wavetables/render

Renders a wavetable to a stereo WAV source for use in germ.

## POST /wavetables/import

Imports a WAV stack as a wavetable.

## GET /wavetables/{wavetable_id}/export

Exports a wavetable as `gwt`, `wav-stack`, `single-cycle`, or `metadata` using the
`format` query parameter.

## GET /library

Scans persisted metadata files and returns a compact browser/index for generated
sounds:

```json
{
  "count": 2,
  "items": [
    {
      "id": "gravel_footsteps_1234abcd",
      "provider": "stable_audio_mlx",
      "model": "sm-sfx",
      "mode": "text-to-audio",
      "prompt": "dry gravel footsteps",
      "duration": 4.0,
      "seed": 12345,
      "status": "done",
      "audio_file": "output/audio/gravel_footsteps_1234abcd.wav",
      "metadata_file": "output/metadata/gravel_footsteps_1234abcd.json",
      "audio_exists": true
    }
  ],
  "audio_dir": "output/audio",
  "metadata_dir": "output/metadata"
}
```

## Result Shape

```json
{
  "job_id": "uuid",
  "status": "done",
  "audio_files": ["output/audio/example.wav"],
  "metadata_files": ["output/metadata/example.json"],
  "seed": 12345,
  "duration": 4.0,
  "sample_rate": 44100
}
```

## GET /files/{file_path}

Serves generated media files (audio and images) under `output/` so the local dashboard
can preview them. Only media extensions are served — metadata JSON and other files are
not exposed over GET. Requests outside the configured output directory are rejected.

## POST /files/reveal

macOS-only helper for the local dashboard:

```json
{
  "path": "output/audio/example.wav"
}
```

The server only reveals files inside the configured output directory.

## POST /files/rename

```json
{
  "audio_path": "output/audio/example.wav",
  "metadata_path": "output/metadata/example.json",
  "new_stem": "renamed_example"
}
```

Renames the audio file (and metadata file, when given) to a sanitized stem and rewrites
the path/id fields inside the metadata JSON, rolling back on failure.

## POST /files/delete

```json
{
  "items": [
    {
      "audio_path": "output/audio/example.wav",
      "metadata_path": "output/metadata/example.json"
    }
  ]
}
```

Best-effort bulk delete of output files (max 500 items per request).
