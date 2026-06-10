# germ Micro / Matter Architecture

germ reframes the app as an open-source modular environment for generative
microsound, audio-to-control, and sound matter experimentation.

Germinator remains the legacy/internal engine name. The public product name and UI
language are `germ`.

## Concept

The old plant metaphor remains useful for compatibility terms like `germinator_mode`,
but the product model now centers on sound as living matter:

- grains as cells
- samples as cultures
- LoRAs as strains
- modules as organelles
- routing as metabolism
- modulation as signal exchange
- lineage as genetic memory
- CV/MIDI/OSC as external nervous systems

## Scales

| Scale | Unit | Current surfaces |
| --- | --- | --- |
| Micro | grain / cell / quanta | Grain Culture, Cell Splitter, Quanta, Microscope |
| Meso | colony / tissue / swarm | Particle Engine, Swarm, Colony, Spectral Tissue |
| Macro | organism / culture / graph | Canvas, Controllers, Genetic Matrix, Candidate Ecology |

## Implemented UI Modules

The Micro palette and Micro panel add these canvas modules through the existing FX
node system:

- Grain Culture
- Particle Engine
- Cell Splitter
- Swarm
- Colony
- Membrane
- Metabolism
- Spectral Tissue
- Quanta
- Microscope
- Incubator

These modules are intentionally additive. They reuse the existing canvas graph,
semantic FX metadata, realtime audition chain, modulation targets, and lineage
surfaces. They do not replace current generation, editing, library, control, or
metadata flows.

## Persisted Control Contracts

Two backend contracts now make the conceptual layer reusable outside the dashboard:

- Strain registry: `GET /strains`, `POST /strains`, `DELETE /strains/{id}`, and
  `POST /strains/load` persist LoRA-style strain cards in `output/strains/`.
- Micro/Matter profiles: `POST /micro/matter-profile` analyzes a saved WAV and
  writes a `micro_matter_profile` artifact under `output/micro/` with grain density,
  cell count, transient cells, quanta rate, spectral tissue, and module suggestions.

The control genetic graph reads these artifacts and links sounds to strain,
micro-module, and micro-profile nodes. That keeps the new layer integrated with
lineage instead of leaving it as disconnected UI state.

## Safety / Compatibility

- Existing launch scripts, environment variables, localStorage keys, and
  `germinator_mode` metadata remain stable for existing users and clients.
- New metadata uses `app: "germ"` plus `legacy_app: "Germinator"`.
- OSC defaults now use `/germ/...`, but old `/germinator/...` addresses are still
  valid user-provided addresses.
- Physical CV output remains disabled unless a future calibrated bridge explicitly
  opts in.

## Next DSP Phase

The current Micro modules are graph modules with semantic and lightweight realtime
audition behavior. A future native DSP phase can replace or extend them with:

- true grain-window scheduling
- corpus indexing and per-grain metadata
- transient/cell extraction caches
- spectral freeze/smear buffers
- spatial grain distribution
- hardware-synced CV/MIDI/OSC performance control
