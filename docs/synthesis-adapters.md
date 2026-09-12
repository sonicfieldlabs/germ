# Local synthesis adapters (G7, unreleased)

The `synthesis` provider uses the same `/generate`, `/jobs/submit`, cancellation,
shutdown, metadata, library, Akousmata retention and negotiated MASA generation
sidecars as the existing providers. It runs local CPU DSP without model weights.
Its prompt is an attributed description, not a text-conditioning model input.
Choose an explicit adapter as `model` and supply its parameters in
`source.synthesis`. Linked `/akousma/derivation/generate` also accepts
`execution.synthesis` when `execution.provider` is `synthesis`.

All adapters require one output, duration 0.1–30 seconds, and finish or time out
within a 30-second render budget. Python rendering checks cancellation every
1,024 samples; the existing Node granular supervisor checks every 10 ms. These
are cooperative checks, not real-time guarantees. The common queue bounds
concurrency. A cancelled job cannot later become completed; settled lifecycle
receipts survive runtime eviction and restart. Interrupted uncompleted jobs are
not replayed automatically. The owner can inspect retained artifacts and submit
a new explicit job. Forced process termination can still leave incomplete files.

| Adapter | Declared parameters and semantics |
| --- | --- |
| `additive` | `frequency` 40–4,000 Hz (default 220), `gain` 0–1 (0.2), `partials` 1–32 amplitudes each 0–1 (default `[1]`). Sum normalized by at least 1; requested harmonics reaching Nyquist are refused. |
| `physical-string` | `frequency` and `gain` as above; `decay` 0.8–0.999 (0.98). New minimal Karplus–Strong delay-string adapter, seeded noise excitation and neighboring-sample averaging. Rounded delay length means frequency is approximate. This is a digital physical model, not measured physical-source evidence. |
| `sample` | Owned/allowlisted PCM16 WAV `input_audio_path` plus matching `source_sha256`, optional `gain`. At most 12 MiB/30 seconds, mono or stereo, 8–96 kHz. Stereo averaged to mono, linear conversion to 44.1 kHz, silence after source end, truncation at requested duration. Conversion is not a band-limited resampler and does not claim spectral preservation. |
| `wavetable` | Existing `wavetable_id`, `table_sha256`, `position` 0–1 (0), `frequency`, `gain`. Reuses the server's existing `_sample_frame` interpolator and table loader; interpolation between adjacent frames. The browser's PeriodicWave preview remains its own playback realization. No duplicate browser synthesizer or claim of identical browser PCM. |
| `granular` | Same WAV locator/hash limits, plus `parameters` in the existing Micro granulation grammar. Uses `build_processing_request`, the existing parameter adapter, Node host and shared `GermGranularProcessor`. Output duration must match the source; its rate and channel count are preserved. See the supported fixed-grain, synchronous, random-history subset in [processing-adapter.md](processing-adapter.md). Unsupported emission/selection/envelope variants remain refused. |

Non-granular output is mono PCM16 at 44.1 kHz, with a 6 ms attack and 45 ms
release (overlapping on short outputs), clamped to digital full scale. Wavetable
interpolation does not remove aliased harmonics. No adapter claims access beyond
its sampled representation, calibrated human playback, or a new listening pass.

Only the adapter-specific fields in the table are accepted in `source.synthesis`;
unknown fields are refused. Core generation request fields retain their existing
roles; diffusion steps and CFG do not control these procedural DSP algorithms.
The new physical-string and additive calculations fill missing server functions;
sample decoding uses the existing format/path restrictions, and table and grain
processing reuse the existing DSP paths.

A wavetable hash is `server.processing_adapter.digest` of
`{"metadata": table["metadata"], "frames": table["frames"]}`, where `table` comes
from `server.wavetable.load_wavetable`. Filesystem Path objects returned by that
loader are excluded. Sources are checked again before output publication. Sample
rendering uses the same byte snapshot that was hashed.

Example through the existing endpoint:

```json
{
  "provider": "synthesis", "model": "additive",
  "prompt": "A synthetic two-partial tone", "duration": 1,
  "seed": 42, "batch_size": 1,
  "source": {"synthesis": {"frequency": 330, "partials": [1, 0.3]}},
  "masa_contracts": ["masa/0.2.0"], "remember_to_akousmata": true
}
```

Existing owner settings govern sidecar/record retention. `germ:synthesis` in the
MASA generation receipt retains requested/effective parameters, the actual seed,
source hash, engine source hash, relevant shared DSP hash and Python runtime.
Source locators are retained in requested parameters; declared canonical parents
continue through the existing derivation/record paths. This generation receipt
does not pretend to execute a separately supplied MASA processing authorization.
For that contract use the existing owner-only [processing adapter](processing-adapter.md).
Seeded byte repeatability is scoped to the recorded runtime and engine versions.

Validation uses actual synthetic WAV rendering, actual retained table conversion,
seeded reruns, canonical offline MASA validation, source/bounds refusal and active
cancellation. It establishes local DSP and record behavior, not aesthetic quality,
model listening, native-window behavior or physical-device playback.
