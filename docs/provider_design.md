# Provider Design

The server exposes one stable API over several backends:

```text
germ / macOS app / plugin / Max / local client
  -> FastAPI sidecar
  -> AudioGenerationProvider
  -> Stable Audio Python / MLX / Stability API / mock
  -> WAV + metadata JSON
```

`AudioGenerationProvider` is the only interface used by routes. Provider-specific
code stays in `server/providers`.

Required methods:

```python
def is_available(self) -> bool: ...
def list_models(self) -> list[str]: ...
def load_model(self, model_id: str, device: str = "auto") -> dict: ...
def generate(self, request: GenerateRequest) -> GenerationResult: ...
def audio_to_audio(self, request: AudioToAudioRequest) -> GenerationResult: ...
def inpaint(self, request: InpaintRequest) -> GenerationResult: ...
def continue_audio(self, request: ContinueRequest) -> GenerationResult: ...
def load_lora(self, paths: list[str]) -> dict: ...
def set_lora_strength(self, strength: float, lora_index: int | None = None) -> dict: ...
```

## Mock Provider

The mock provider always reports available and writes stereo 44.1 kHz WAV files.
It supports all endpoints so dashboard and germ clients can be tested without model
downloads.

## Stable Audio Python Provider

The Python provider imports:

```python
from stable_audio_3 import StableAudioModel
```

It loads models lazily with:

```python
StableAudioModel.from_pretrained(model_id, device=device)
```

For input audio, `torchaudio.load()` returns `(waveform, sample_rate)`. The provider
converts this to `(sample_rate, waveform)` before passing it into Stable Audio.

Continuation is implemented as inpainting from the end of the source clip to the
target duration.

LoRA loading is implemented through the official package helpers when present. If
the installed package changes those helper names, the endpoint returns a clear error
rather than failing silently.

## Stable Audio MLX Provider

The MLX provider is a subprocess wrapper over the official `optimized/mlx/sa3` CLI.
It does not run install scripts from a generation request. Installation must happen
through `scripts/install_mlx_provider.sh`.

Supported command shape:

```bash
./sa3 --prompt "footsteps on gravel" --dit sm-sfx --decoder same-s --seconds 4 --out output/audio/steps.wav
./sa3 --prompt "ambient drone" --cfg 3.0 --negative-prompt "drums, vocals" --dit sm-music --decoder same-s --out output/audio/drone.wav
./sa3 --prompt "jazz fusion with electric piano" --dit sm-music --decoder same-s --init-audio input.wav --init-noise-level 0.7 --out output/audio/out.wav
./sa3 --prompt "explosive drum break" --dit sm-music --decoder same-s --init-audio input.wav --inpaint-range "4,7" --out output/audio/inpaint.wav
```

The wrapper captures stdout, stderr, command, and return code in metadata.
It also forwards the request `steps` value to the MLX CLI and honors
`GERMINATOR_PROVIDER_TIMEOUT_SECONDS` so a stuck subprocess returns error metadata
instead of hanging indefinitely.

The official MLX CLI accepts one `--inpaint-range` per call. The wrapper supports
multi-region inpainting by running ranges sequentially: range 1 writes an
intermediate file, range 2 uses that file as its source, and the final range writes
the requested output. Metadata records `multi_range_strategy`,
`intermediate_files`, commands, return codes, and per-range seeds.

## Stability API Provider

The API provider is a stub. It reports `large` as a future model but does not require
an API key for local workflows.
