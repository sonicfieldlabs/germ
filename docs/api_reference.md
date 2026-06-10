# API Reference

Default base URL:

```text
http://127.0.0.1:8765
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

## GET /huggingface/status

Checks Hugging Face CLI auth for the gated Stable Audio 3 Python-provider weights.
Use `check_models=true` to run dry-run download checks for Small SFX, Small Music,
and Medium:

```bash
curl "http://127.0.0.1:8765/huggingface/status?check_models=true"
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

## POST /generate

```json
{
  "provider": "stable_audio_python",
  "model": "small-sfx",
  "prompt": "TrackType: SFX, close microphone recording of dry gravel footsteps",
  "negative_prompt": "music, vocals, speech, melody",
  "duration": 4.0,
  "steps": 8,
  "cfg_scale": 1.0,
  "seed": -1,
  "batch_size": 1,
  "lora": [],
  "output_name": "gravel_footsteps"
}
```

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
by `GERMINATOR_MAX_UPLOAD_MB`.

## POST /audio/process

Time-stretch / pitch-shift an existing output file through the Rubber Band CLI
(`audio-time-pitch` job). Requires a `rubberband` binary on PATH; returns 422/504 when
processing fails or times out.

## POST /audio-tools/operate

Region operations over existing output audio (for example extracting a region into a
new library item). Results carry lineage back to the source sound.

## POST /image-to-audio/analyze

Analyzes an inline base64 image (capped by `GERMINATOR_MAX_IMAGE_MB`) into prompt
material for germination.

## POST /time/render

Offline timeline mixdown: mixes WAV sources placed on a PPQ tick clock into one stereo
WAV, with per-event gain, pan, reverse, and pitch shift (Rubber Band when available,
resample fallback otherwise). Returns the rendered file plus metadata with event lineage.

## POST /lora/load

```json
{
  "provider": "stable_audio_python",
  "paths": ["/path/to/momoto_signature.safetensors"]
}
```

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
child process group when that signal is observed.

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
