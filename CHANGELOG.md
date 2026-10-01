# Changelog

## Unreleased — Cosmoaudition freshness admission

- Package 0.6.2 with receiving-time freshness, repaired owner packages and the immutable Stable Audio source revision.
- Reevaluate source clocks and age limits when receiving generation frames, modulation routes and direct mappings. Expired, future, archive and unknown live evidence cannot select parameter values, including when held/uncertainty acceptance is enabled.
- Preserve the original frame and add receiving freshness to decisions; keep canonical `sound_id` and optional MASA sidecars unchanged. Explicit fixtures remain simulation evidence.

## 0.6.0 — Bounded spectral generation

- Additive, chirp, finite-band multisine noise, truncated FM and pulse oscillators at 44.1, 48, 96 and 192 kHz, with explicit Nyquist/resource admission, cancellation and digital spectral receipts.
- Sonification from retained Cosmo observation series and additive reconstruction from currently authorized complex STFT frames; preserve source, mapping, clock and loss receipts.
- Session-only playback opt-in across audio-serving routes and dashboard playback; native digital listening stays separate.
- Filtered finite-excerpt sample rate conversion, replacing unfiltered linear downsampling.
- Package the CPU runtime/dashboard for isolated candidates; qualify SoundFile 0.14 alongside the existing 0.13 support.
- Optional `spectral` extra uses Akousmata's derivative authorization on Python 3.11+; the qualified Station candidate uses Python 3.13.


## 0.5.0 — Normalized observation and accountable-memory alignment

- Upgraded the Sonic Matter Framework boundary to MASA 0.2.0 and
  `masa-processing-request` 0.2.0 while retaining GERM's canonical `sound_id`
  and optional, non-fatal sidecar behavior.
- Added preferred `cosmo/modulation/v0.2` support with explicit v0.1 frame
  compatibility. V0.2 frames must carry a local `cosmo/signal-catalog/v0.2`
  reference and complete signal metadata, finite normalization ranges, a
  `[0, 1]` output, clamp behavior, and a stated basis before GERM routes them.
- Added the bounded `/api/signals` bridge and public
  `GET /cosmoaudition/signals` endpoint, preserving source filtering while
  keeping all provider acquisition and credentials inside Cosmoaudition.
- Added a distinct Hydrosphere Field to the backend manifest, dashboard,
  provenance, and smoke coverage so marine signals are not folded into
  atmospheric or geological observations.
- Preserved catalog normalization through mapping receipts and dashboard
  provenance. The Mapping Loom now declares its second-stage normalized
  projection instead of leaving source-range metadata attached to a `[0, 1]`
  value.
- Raised the Akousma dependency to Earworm 0.7.0 / schema 1.6 and documented
  Oída 0.10.0, gateway v0.6, Akousmata 0.7.0, and AKOÚŌ 0.9.2. GERM-created
  sounds remain cultivation records: accountable auditum data is preserved
  when supplied, never fabricated as a listening report.

## 0.4.1 — Sonic Matter Framework contract corrections

- Fixed the Cosmoaudition frame bridge to consume the published
  `outputValue` field, expose an explicit GERM `value`, and retain the control's
  status, mapping parameters, confidence, and epistemic note. Real applied,
  held, and uncertainty routes are no longer silently withheld.
- Kept canonical `sound_id`, Sonic Lineage, and Earworm identifiers stable
  when filenames change; refreshed written MASA sidecars after path changes and
  refused renames that would break an immutable Akousmata file locator. Rename
  companion writes are transactional, and matching deferred-latent locators
  follow their audio without changing identity.
- Restricted bulk file deletion's primary path to supported audio formats,
  required the actual metadata companion, preserved Akousmata locators, and
  removed only verified written MASA sidecars under explicit companion-delete
  semantics.
- Preserved Cosmoaudition frame-level signals and sources beside resolved
  routes, and withheld malformed or out-of-range executable controls with an
  explicit bridge reason.
- Accepted finite JavaScript wire numbers whose integer spelling exceeds a
  signed 64-bit persistence value, so high-magnitude observations such as the
  Bitcoin hashrate cannot invalidate an otherwise valid modulation frame.
- Aligned active project language to **Sonic Matter Framework**: MASA
  describes, Cosmoaudition observes and modulates, and GERM cultivates. The
  projects remain distinct.

## 0.4.0 — Sonic Matter Stack alignment

- **Fixed a MASA protocol break.** Every sidecar cited
  `smo.sonicfield.org`, a pre-release identifier root. `$schema` is a protocol
  constant rather than a hint, so the published MASA 0.1.0 validator rejected
  every record GERM had ever written. Records now cite
  `masa.sonicfield.org` and validate against the released reference
  implementation.
- **Fixed a silent modulation bug.** A zero mapping amount was scaled through
  instead of read as the operator turning a route off. On a reversed output
  range such as `(760, 180)` that emits `outputRange[0]` — the strongest value
  the mapping can produce — reported as `applied`. Silence requested, maximum
  delivered. A zero amount is now `skipped` / `route-disabled`, matching
  Cosmoaudition's own engine.
- Added the MASA processing layer to the Micro modules. Each declares a
  granular or spectral operation in MASA's engine-neutral terms and can emit a
  portable `masa-processing-request` via `POST /micro/processing-request`;
  `GET /micro/processing-operations` reports the mapping. GERM states the
  intention and binds no DSP library.
- Added the Cosmoaudition modulation framework. The bridge allowlist now covers
  `/api/modulation`, `/api/frame`, and `/api/snapshot/masa`, and
  `GET /cosmoaudition/frame` resolves one verified `cosmo/modulation/v0.1`
  frame into GERM routes. It reads the frame's `controls`, never the bare
  `values` map, so a value never travels without the decision that produced it;
  withheld routes and emitted absences are reported rather than dropped.
  `/api/stream` stays unbridged because Server-Sent Events cannot be read by a
  bounded request/response client.
- Added `uncertaintyOutput` to Cosmoaudition mappings, so a `map-uncertainty`
  policy emits its declared value under an `uncertainty` status instead of
  degrading silently to `skip`. Declaring the policy without the value is now
  refused at the schema boundary.
- Named GERM's place in the **Sonic Matter Stack** alongside the Listening
  Stack, and retired the earlier "Observatory" naming across the server,
  dashboard, documentation, and module labels.

## 0.3.3 — Additive cultivation lineage

- Raised the Earworm/Akousma floor to 0.6.1 so remembered generations cannot
  silently replace an earlier listening account.
- Clarified that a generated child is a new cultivated object with causal
  lineage, not evidence that a claim about its parent was true.
- Aligned public stack versions and expanded environment-file ignore coverage.

## 0.3.2 — Cosmoaudition status privacy

- Keep Cosmoaudition health-check failures in local logs while returning only
  a stable public error at the loopback API boundary.
- Add a regression test proving low-level backend details cannot enter the
  status payload.

## 0.3.1 — Security and stack alignment

- Overrode Stable Audio 3's upstream Torch 2.7.1 constraint with the locally
  validated Torch and Torchaudio 2.10 pair, removing every fixable advisory
  from the optional Python-provider dependency graph.
- Added an all-extras dependency audit and a dated security exception for the
  two remaining upstream PyTorch findings in APIs GERM does not call directly.
- Updated Setuptools to 83.0.0 to close its Unicode-normalization sdist issue.
- Removed unsafe DOM-to-HTML and DOM-to-download flows, bounded note parsing,
  kept backend exception details out of API payloads, and confined upload
  writes to managed roots.
- Updated the embedded Earworm/Akousma package from 0.4.0 to 0.6.0 and aligned
  the documented Listening Stack versions with the canonical public releases.

## 0.3.0 — Cosmoaudition, Matter Analysis, and audio reliability

- Added the loopback-only Cosmoaudition bridge, explicit observation mappings,
  archives, module palette, Matter Analysis, and optional MASA 0.1 sidecars.
- Kept unavailable, errored, stale, and zero-valued observations distinct;
  missing Mapping Loom inputs now execute their declared policy without a
  fabricated neutral value.
- Streamed bounded spectral aggregation with cached FFT windows, validated
  Matter lineage shapes, and exposed the final MASA companion state in API and
  dashboard results.
- Flushed queued AudioWorklet PCM before recorder shutdown, preserved explicit
  zero-gain wavetable previews, removed confirmed dead dashboard helpers, and
  expanded backend, audio, and browser regression coverage.

## 0.2.5 — Backend integrity and integration hardening

- Hardened request, persisted JSON, path, upload, WAV, and provider artifact
  validation across generation, editing, control, listener, session, Micro,
  wavetable, library, and file workflows.
- Made provider execution, cancellation, job retention, caches, metadata,
  lineage, Akousmata companion writes, and multi-step render transactions
  bounded and failure-safe.
- Updated Stability and Gemini integrations to their current contracts,
  strengthened Python and MLX provider output checks, and aligned the test
  client dependency with Starlette's `httpx2` backend.
- Improved dashboard data escaping, native macOS daemon lifecycle handling,
  launch scripts, and regression coverage for integration boundaries.

## 0.2.0 — Listening-informed cultivation

- Added OÍDA re-listening, prompt derivation, immutable evidence summaries,
  covenant-aware retention, and Akousmata lineage updates.
- Aligned generated records with Earworm 0.4 / akousma spec v1.3 and
  `akouo/v0.7`.
- Added the native macOS shell, daemon supervision, server-owned sessions,
  improved provider diagnostics, and a streamlined dashboard toolbar.
- Expanded Stable Audio API and MLX provider behavior, Micro/Matter state,
  file operations, tests, and release validation.

## 0.1.0 — Initial modular lab

- Published the local FastAPI server, browser dashboard, generation/edit
  routes, providers, Micro/Matter modules, control layer, Wavetable Forge,
  Strains, library, and Earworm export.
