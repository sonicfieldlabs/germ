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
- Matter Analysis
- Cosmoaudition Matter Modulator

These modules are intentionally additive. They reuse the existing canvas graph,
semantic FX metadata, realtime audition chain, modulation targets, and lineage
surfaces. They do not replace current generation, editing, library, control, or
metadata flows.

Matter Analysis is deliberately adjacent to Microscope rather than a
replacement for it. Microscope remains a compositional Micro module. Matter
Analysis writes a reusable research artifact with explicit epistemic states:

- `measured` for bounded PCM-derived descriptors
- `inferred` for reversible morphology labels derived from measurements
- `unavailable` when the source or method cannot support a value

It does not create heard claims; those remain in Oída's listening boundary.

## Cosmoaudition category

The dashboard has a dedicated Cosmoaudition category. Its modules are additive
to the existing Sources, Genetic, Time, Effects, Modulators, and Microsound
categories:

| Module | Role |
| --- | --- |
| Observation Source | Reads one bounded local snapshot. |
| Cosmic Field | Selects `cosmos` observations. |
| Earth Field | Selects atmospheric and geological observations. |
| Biosphere Field | Selects biosphere observations. |
| Human–Machine Field | Selects human and machine observations. |
| Relational Index | Composes available normalized relations. |
| Event Pulsar | Projects attributed event observations into trigger values. |
| Mapping Loom | Executes an authored mapping and explicit missing-data policy. |
| Semantic Field | Relates a normalized value to attributed descriptive context. |
| Uncertainty Field | Makes confidence, staleness, and source error available as control. |
| Observation Archive | Replays a bounded local observation with provenance. |
| Matter Modulator | Applies observation-routed control to granular and spectral matter parameters. |

GERM connects only to the separate Cosmoaudition System on an explicit HTTP
loopback URL. It accepts no redirects, proxies only allowlisted routes, ignores
environment proxies, and caps the response body. The allowlist covers
`/health`, `/api/sources`, `/api/snapshot`, `/api/snapshot/masa`,
`/api/modulation`, and `/api/frame`. `/api/stream` is deliberately excluded:
it is Server-Sent Events, and this bridge is a bounded request/response client
that reads a complete body and closes.

A modulation frame is verified against the contract it claims —
`cosmo/modulation/v0.1` — before it is read. `GET /cosmoaudition/frame`
resolves one frame into GERM routes using its `controls`, never the bare
`values` map that exists for transports carrying only numbers. Using that map
would turn a skipped route into a real zero. Withheld routes and emitted
absences travel in the response instead of disappearing from it. Provider credentials and
astronomical, geological, weather, biosphere, human, or machine APIs remain on
the Cosmoaudition side of the boundary.

An observation is not active control until it has been fetched and marked
available. Unavailable observations are skipped in generation, realtime, and
clocked routes. Mapping receipts retain signal, source, confidence,
epistemic status, temporal character, mapping status, and the statement that
the relation is authored rather than a source-identity claim.

## MASA processing layer

MASA 0.1.0 carries the granular and spectral vocabulary as a protocol layer, so
a Micro module can state what it wants done to matter without naming a DSP
engine. Each module declares one operation:

| Module | MASA operation |
| --- | --- |
| Grain Culture, Particle Engine, Quanta | `matter.granulate` |
| Cell Splitter, Colony | `matter.fragment` |
| Spectral Tissue, Membrane | `matter.extract` |
| Microscope | `matter.reduce` |
| Metabolism | `matter.timestretch` |
| Swarm | `matter.pitchshift` |

The parameters are the module's own character rather than one shared default.
Quanta works between one and ten milliseconds, where a grain stops being a
small note and becomes a particle and the envelope dominates what is heard;
Grain Culture cultivates at the perceptible grain with quasi-synchronous
emission; Particle Engine is dense asynchronous emission. Spectral Tissue reads
strata rather than a single band.

`GET /micro/processing-operations` reports the mapping. `POST
/micro/processing-request` builds a portable `masa-processing-request`, merging
operation floor, module character, and authored parameters in that order so a
partial override cannot drop a sibling the contract still requires.

A processing request is an intention, not a receipt. It carries no `$schema`
member, because the request schema declares none and forbids what it does not
declare. It asserts nothing about what was rendered, and nothing about what was
heard — audition remains outside this boundary.

## Persisted Control Contracts

Two backend contracts now make the conceptual layer reusable outside the dashboard:

- Strain registry: `GET /strains`, `POST /strains`, `DELETE /strains/{id}`, and
  `POST /strains/load` persist LoRA-style strain cards in `output/strains/`.
- Micro/Matter profiles: `POST /micro/matter-profile` analyzes a saved WAV and
  writes a `micro_matter_profile` artifact under `output/micro/` with grain density,
  cell count, transient cells, quanta rate, spectral tissue, and module suggestions.
- Matter Analysis: `POST /matter/analyze` (also
  `POST /micro/matter-analysis`) writes a `matter_analysis` artifact under
  `output/micro/` and an optional MASA analysis sidecar under `output/masa/`.
- Cosmoaudition bridge: `/cosmoaudition/*` exposes bounded status, source,
  snapshot, mapping, and local archive contracts without copying provider
  acquisition into GERM.
- MASA sidecars: every successful committed generation can write a MASA 0.1
  interoperability record under `output/masa/`. Sidecar failure is annotated
  but cannot invalidate audio, metadata, Sonic Lineage, Oída, or Akousmata.

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
