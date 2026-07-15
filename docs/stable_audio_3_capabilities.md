# Stable Audio 3 Capabilities And germ Workflow Notes

This note maps the official Stable Audio 3 controls to the local germ sidecar and
the dashboard.

Official sources:

- Stable Audio 3 repo: https://github.com/Stability-AI/stable-audio-3
- Inference methods: https://github.com/Stability-AI/stable-audio-3/blob/main/docs/workflows/inference.md
- MLX implementation: https://github.com/Stability-AI/stable-audio-3/tree/main/optimized/mlx
- LoRA workflow: https://github.com/Stability-AI/stable-audio-3/blob/main/docs/workflows/lora.md
- Model overview: https://github.com/Stability-AI/stable-audio-3/blob/main/docs/guides/model-overview.md
- Stability Platform API: https://platform.stability.ai/docs/api-reference

## Supported In This Server

- Text-to-audio through `/generate`.
- Audio-to-audio through `/audio-to-audio` with `input_audio_path` and
  `init_noise_level`.
- Inpainting through `/inpaint` with one or more `[start, end]` ranges for the
  Python provider. The MLX wrapper supports multiple ranges by rendering one range
  at a time through the official CLI and feeding each intermediate result into the
  next range.
- Continuation through `/continue`, implemented as inpainting from
  `source_duration` to `target_duration`.
- Seeded variations through repeated requests or Python-provider `batch_size`.
- Runtime LoRA loading and strength control for the Python provider.
- Request-authoritative LoRA cultivation: Python disables loaded-but-unrequested
  adapters before each render; MLX accepts repeatable request-local adapters with
  strength and optional diffusion-step ranges.
- MLX local generation on Apple Silicon through the official `optimized/mlx/sa3`
  CLI.
- Hosted Stable Audio 3 generation through Stability's asynchronous API, including
  polling, local poll cancellation, text-to-audio, audio-to-audio, inpainting, and
  continuation. Cancelling polling does not revoke a request already accepted by the
  hosted service.
- Sequential multi-range inpainting for both MLX and hosted API routes, with every
  intermediate request represented in metadata.
- Metadata and library indexing for every generated WAV.
- Optional derived-memory registration in Akousmata, with sonic lineage, covenant,
  and parent Akousma ids preserved.
- Async job submission through `/jobs/submit` plus WebSocket snapshots at
  `/jobs/{job_id}/events`.

## Important Controls

`base_prompt` is the neutral, editable source text; `modulated_prompt` is the text
after explicitly connected prompt modulators run. Providers consume the effective
`prompt`, while metadata preserves both versions under `germ.prompt/v0.1` so a
lineage never loses what the listener or user originally supplied. The same rule
applies to negative prompts. Germ does not automatically inject track type, music,
voice, or SFX assumptions.

`duration` controls the final generated length, and shorter durations are faster and
easier to evaluate while testing. `steps=8` is the practical default for post-trained
checkpoints; base checkpoints may need more.

`seed=-1` means random. Any fixed seed should reproduce a run with the same model,
provider, prompt, and parameters. For loop or layer comparison, germ should keep
the prompt fixed and sweep seeds.

`init_noise_level` controls how much source audio survives in audio-to-audio. Low
values preserve more of the source; higher values move toward a full regeneration.
The MLX documentation calls `0.4-0.8` typical for variation.

Inpainting preserves audio outside the selected mask and regenerates only the
masked region. Continuation is the same mechanism with the mask starting at the
source clip end and ending at the desired target duration.

## Hosted Stability API Route

The hosted model id is `stable-audio-3`. Set `STABILITY_API_KEY`; the provider remains
unavailable without it and local routes continue to work. The current API accepts
1–380 second outputs, 4–8 steps, CFG 1–25, and WAV/MP3 edit sources between 6 and
380 seconds (maximum 100 MB). Editing requests use `batch_size=1`. Each hosted
multi-range inpaint is a sequence of billable requests; metadata records the estimated
26 credits per request and the actual seed returned by the service.

The hosted endpoint has no local LoRA input and no negative-prompt field. Germ rejects
LoRA for this provider and records an entered negative prompt as ignored, so the
provenance is honest. Local Python and MLX remain the routes for LoRA cultivation.

`chunked_decode` reduces peak decode memory for longer generations. It can cost
some speed and may introduce small boundary artifacts if overlap is too low, but
the official Python path defaults it on.

## Dashboard Additions

The current dashboard adds germ-facing workflow tools on top of the official model
controls:

- Sidebar navigation instead of horizontal tabs.
- A persistent generation state strip with provider, model, device, and elapsed
  time.
- A waveform preview player with copy/open/reveal actions.
- A layer stack for comparing several generated loops or edits.
- A variation tab that performs repeated `/generate` calls with sequential seeds
  when requested.
- A library tab backed by `GET /library`, scanning saved metadata and WAVs.

Loop variation is not a separate Stable Audio 3 primitive. It is a germ workflow:
repeat the same prompt and duration with different seeds, then compare the outputs
as layers.

## Expansion Targets

- Add waveform image peaks or cached preview data in metadata to make the library
  faster.
- Persist jobs to disk so `/jobs/{job_id}` survives server restarts.
- Expose advanced LoRA controls from the official Python workflow: per-LoRA
  conditioner/backbone strength, sigma interval, and layer filters.
- Add SAME encode/decode utilities for germ preview, caching, and future latent
  workflows.
- Add user-selectable prompt recipes for SFX, Foley, ambience, loop, and edit modes,
  stored as JSON and applied explicitly on top of the neutral prompt contract.
- Add richer async progress estimates from provider stdout once upstream exposes
  structured progress events.

## Local Model Testing Workflow

1. Test `mock` first to confirm the FastAPI server, dashboard, WAV writing, and
   metadata writing.
2. On Apple Silicon, use `stable_audio_mlx` first. Select `sm-sfx`, load it, then
   run a 1-second test from the dashboard Status page.
3. Test `sm-music` and `medium` the same way once their MLX bundles are installed.
4. Use the Python provider when CUDA/Python features are needed, especially LoRA
   workflows. If Hugging Face returns a gated-model error, accept the model terms
   and run `uv run hf auth login`.
5. A model is functioning locally when a non-mock provider returns `status: done`
   and writes both `output/audio/*.wav` and `output/metadata/*.json`.
