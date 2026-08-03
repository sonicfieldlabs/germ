# Changelog

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
