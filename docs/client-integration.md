# Client integration

Base URL:

```text
http://127.0.0.1:5178
```

The FastAPI server is the stable integration layer. Plugins, Max patches,
Ableton tools, and the dashboard should call this API rather than Gradio internals.
Rendering must run outside the realtime audio thread.

This document is an example client contract for GERM hosts. The
complete route list lives in `docs/api_reference.md`.

## Use cases

- Generate new layer: call `POST /generate`.
- Morph selected audio: call `POST /audio-to-audio` with an exported clip path.
- Inpaint selected region: call `POST /inpaint` with clip path and region ranges.
- Continue selected clip: call `POST /continue` with source and target durations.
- Create variations: repeat a request with fixed prompt and different seeds.
- Apply LoRA style: call `POST /lora/load`, then generate with LoRA metadata.
- Track long renders: call `POST /jobs/submit`, then poll `GET /jobs/{job_id}` or
  subscribe to `WS /jobs/{job_id}/events`.
- Browse generated sounds: call `GET /library`.
- Score and repair candidate WAVs: call `POST /listener/score`.
- Convert and mutate oscillator material: call `/wavetables/*`.
- Save Microcosmos states: call `/micro/biomes`.
- Export lineage to Earworm: call `POST /earworm/export` with a metadata path.
- Export generated audio back into a host: attach returned WAV and JSON metadata to the layer.

## Suggested layer schema extension

```json
{
  "layer_id": "uuid",
  "source": "stable_audio_3",
  "provider": "stable_audio_python",
  "model": "small-sfx",
  "mode": "audio-to-audio",
  "prompt": "metallic granular drone",
  "negative_prompt": "voice, speech, melody",
  "duration": 12.0,
  "seed": 44821,
  "steps": 8,
  "cfg_scale": 1.0,
  "init_noise_level": 0.45,
  "input_audio_path": "inputs/source.wav",
  "output_audio_path": "output/generated.wav",
  "metadata_path": "output/generated.json",
  "lora": [
    {
      "path": "models/your_style.safetensors",
      "strength": 0.7
    }
  ],
  "created_at": "ISO-8601 timestamp"
}
```

## Calls

Health:

```bash
curl http://127.0.0.1:5178/health
```

Models:

```bash
curl http://127.0.0.1:5178/models
```

Hugging Face access check for Python-provider weights:

```bash
curl "http://127.0.0.1:5178/huggingface/status?check_models=true"
```

Generate a new layer:

```bash
curl -X POST http://127.0.0.1:5178/generate \
  -H "content-type: application/json" \
  -d '{
    "provider": "mock",
    "model": "mock-sine",
    "prompt": "short dry ceramic impact, close microphone, no music",
    "negative_prompt": "voice, speech, melody",
    "duration": 3.0,
    "steps": 8,
    "cfg_scale": 1.0,
    "seed": -1,
    "output_name": "ceramic_impact"
  }'
```

Morph selected audio:

```bash
curl -X POST http://127.0.0.1:5178/audio-to-audio \
  -H "content-type: application/json" \
  -d '{
    "provider": "stable_audio_python",
    "model": "medium",
    "prompt": "turn this recording into a metallic resonant drone with low granular movement",
    "input_audio_path": "/path/to/source.wav",
    "init_noise_level": 0.45,
    "duration": 20.0,
    "steps": 8,
    "seed": -1
  }'
```

Inpaint selected regions:

```bash
curl -X POST http://127.0.0.1:5178/inpaint \
  -H "content-type: application/json" \
  -d '{
    "provider": "stable_audio_python",
    "model": "medium",
    "prompt": "replace this region with a punchy metallic impact and short room tail",
    "input_audio_path": "/path/to/source.wav",
    "inpaint_ranges": [[4.0, 6.0], [12.5, 13.2]],
    "duration": 20.0,
    "steps": 8,
    "seed": -1
  }'
```

Continue a clip:

```bash
curl -X POST http://127.0.0.1:5178/continue \
  -H "content-type: application/json" \
  -d '{
    "provider": "stable_audio_python",
    "model": "medium",
    "prompt": "continue this ambient texture with subtle low-frequency movement and no beat",
    "input_audio_path": "/path/to/source.wav",
    "source_duration": 12.0,
    "target_duration": 40.0,
    "steps": 8,
    "seed": -1
  }'
```

Submit an async render job:

```bash
curl -X POST http://127.0.0.1:5178/jobs/submit \
  -H "content-type: application/json" \
  -d '{
    "mode": "text-to-audio",
    "request": {
      "provider": "mock",
      "model": "mock-sine",
      "prompt": "short dry ceramic impact",
      "duration": 1.0,
      "output_name": "ceramic_async"
    }
  }'
```

Load and control LoRA:

```bash
curl -X POST http://127.0.0.1:5178/lora/load \
  -H "content-type: application/json" \
  -d '{
    "provider": "stable_audio_python",
    "paths": ["/path/to/your_style.safetensors"]
  }'

curl -X POST http://127.0.0.1:5178/lora/strength \
  -H "content-type: application/json" \
  -d '{
    "provider": "stable_audio_python",
    "strength": 0.7,
    "lora_index": 0
  }'
```

Job lookup:

```bash
curl http://127.0.0.1:5178/jobs/JOB_ID
```

Job event stream:

```text
ws://127.0.0.1:5178/jobs/JOB_ID/events
```

Generated library:

```bash
curl http://127.0.0.1:5178/library
```

Reveal a generated file in Finder on macOS:

```bash
curl -X POST http://127.0.0.1:5178/files/reveal \
  -H "content-type: application/json" \
  -d '{"path":"output/audio/ceramic_impact.wav"}'
```

## File Handoff

The host should export source clips to stable local paths before calling edit endpoints.
The server returns project-relative paths and stores absolute paths inside metadata.
The host can import the returned WAV into its layer system and attach the metadata JSON
as provenance.

Recommended folder convention:

```text
host project render/cache clip -> /audio-to-audio or /inpaint
GERM output/audio/*.wav -> generated layer asset
GERM output/metadata/*.json -> layer metadata/provenance
```
