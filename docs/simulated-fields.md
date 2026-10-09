# Designed signals and optional room processing

GERM 0.6.1 renders designed aperture-test signals through the existing synthesis
job lifecycle. `POST /workspace/simulated/render` accepts `model` (`additive`,
`chirp`, `band-noise`), `parameters`, `duration` (0.1–30 s) and unsigned `seed`.
The request retains a WAV and a companion akousma with
`provenance.source_type: designed` and `extensions["germ.simulated"]`.
Generation metadata contains the same design, effective oscillator parameters,
engine hash, runtime, NumPy version and source-byte hash. Memory-write failure
remains visible separately from a completed waveform render.

Example request:

```json
{"model":"additive","duration":1,"seed":42,"parameters":{"sample_rate":192000,"frequencies":[1000,40000],"partials":[1,1],"gain":0.2,"gaps":[],"clock_ppm":0}}
```

Noise bands use seeded finite random multisines, not ideal stochastic band limits.
Gaps replace up to 32 sample intervals with zero; they do not represent unavailable
measurements. `clock_ppm` (−1000 to 1000) perturbs oscillator time against the
unchanged sample clock; it does not simulate a calibrated drifting microphone.
Every oscillator component must remain below Nyquist after perturbation. The
normal 6 ms attack / 45 ms release can be overridden with `envelope_seconds`;
`[0,0]` is useful for periodic benchmarks. Discontinuities and PCM16 quantization
can introduce out-of-band energy. `GET /workspace/simulated/sources` lists up to
100 retained designs; its `/sources/{key}/resolve` route verifies current bytes
against the design receipt before exposing a local path.

## Room processing

Install the optional `germ[room]` extra in an isolated host environment.
It pins pyroomacoustics 0.10.0; ordinary GERM startup and oscillators do not import
or require it. The existing [owner-invoked processing adapter](processing-adapter.md)
now admits MASA 0.2.0 `matter.derive` with engine `germ:pyroomacoustics`.
Use the Phase 8 MASA validator, which adds generic derivation to processing
requests and enforces descendant lineage. Older validators reject this request.

Keep the normal request envelope, one source representation and output contract
(`roles: ["derivative"]`, `mediaTypes: ["audio/wav"]`, `maxOutputs: 1`). Set:

```json
{
  "operationType": "matter.derive",
  "engine": {"state":"known","value":"germ:pyroomacoustics"},
  "determinism": "require-deterministic",
  "parameters": {
    "dimensions_m": [4,5,3], "source_m": [1,1,1], "receiver_m": [3,2,1.5],
    "absorption": 0.4, "max_order": 3, "seed": 42,
    "directivity": "omnidirectional", "normalization": "peak_0.95",
    "rir_method": "shoebox_image_source"
  }
}
```

This fragment is not a permission or a complete request. The host must supply
its independent, expiring authorization bound to the full request, source bytes
and source MASA record; its policy action is `matter.derive`. Existing rules,
duties, revocations and retention conditions remain the host's responsibility.
Do not obtain authority by copying an example's `permitted` decision.
The source record and WAV remain unchanged; publication creates a new revision,
new representation/sound identity, `masa:derived-from` relation and operation
receipt. The CLI does not automatically ingest this descendant into Petri or
Akousmata. Its output MASA record is the lineage-bearing retained result.

The source must be mono PCM16, 16/44.1/48/96 kHz, at most 30 s / 12 MiB.
Shoebox dimensions are 1–30 m; points are interior and separated by at least
0.1 m. Uniform wall energy absorption is 0.05–1 and image order 0–8. One
omnidirectional source and receiver are supported. Sound speed is fixed at
343 m/s; air absorption, ray tracing and randomized ISM are off. Full finite-RIR
convolution is retained, with a five-second RIR / 35-second output ceiling,
global peak normalization to 0.95 and PCM16 quantization without dither.
These are assumptions, not estimates of a real room.

The child process has a 30-second deadline and is terminated/reaped on cancellation
or timeout. Failure, refusal, changed source, expired authority and cancellation
publish receipts without descendants. Hosts bound concurrent CLI invocations.
The completed receipt records dependency versions, engine hash, coordinates,
material/directivity assumptions, rate, seed (unused by deterministic ISM), RIR
method/order/hash, normalization scale and retained tail. To reproduce, recover
`parameters` from `extensions["germ:processing"].room`, use the same source hash,
engine/dependency versions and a fresh host authorization. Run the normal CLI
again into a new output directory and compare WAV hashes; receipt identifiers
and timestamps are intentionally new.

This implementation follows the official
[pyroomacoustics room API](https://pyroomacoustics.readthedocs.io/en/stable/pyroomacoustics.room.html).
All results are simulated fields. They validate neither physical capture nor
room geometry, ultrasonic emission, human audibility or listening semantics.
No learned RIR model is involved.
