# GERM Roadmap

GERM 0.2.5 is a public alpha and open research release. This roadmap names the
work in view without promising dates or production stability.

## Working Now

- A model-free mock route for installation, interface, metadata, and lineage
  testing.
- Stable Audio 3 Python, Apple Silicon MLX, and opt-in Stability API provider
  surfaces.
- Modular Micro/Matter graph, realtime Chamber, library, Herbarium, strains,
  wavetables, controls, sessions, and generation lineage.
- Oída import and re-listening with explicit Akousmata memory writes.
- A shared browser dashboard and native macOS shell over one server-owned
  state.

## Next Research Priorities

- Expand provider contract fixtures for readiness, progress, cancellation,
  timeouts, metadata, and failure recovery.
- Strengthen round-trip lineage tests across Oída, GERM, Earworm, and
  Akousmata.
- Improve keyboard, screen-reader, reduced-motion, and low-vision access to the
  modular graph and Chamber.
- Publish reproducible performance and memory reports for verified provider,
  checkpoint, and hardware combinations.
- Make provider, model, LoRA, license, and source-listening attribution easier
  to inspect and export.
- Test durable job recovery designs without hiding partial or failed renders.

## Toward a Stable Contract

- Stabilize import, generation, job, and lineage schemas from public use.
- Document migrations for sessions, graph state, strains, and metadata.
- Broaden reproducible packaging beyond the source-based macOS shell.
- Clarify which controller outputs are active, simulated, browser-routed, or
  intentionally disabled.

## Non-Goals

GERM is not intended to hide model provenance, treat every generation as an
original without ancestry, infer rights from a prompt, or enable uncalibrated
physical CV output. Local-first is a technical boundary, not an automatic
claim of ethical or ecological adequacy.

See [CONTRIBUTING.md](CONTRIBUTING.md) for scoped ways to participate.
