# Changelog

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
