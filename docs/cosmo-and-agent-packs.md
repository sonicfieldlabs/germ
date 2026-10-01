# Cosmo generation and agent assets (D5, unreleased)

`POST /cosmoaudition/generate` reuses the configured loopback Cosmo bridge and
existing generation runner. Supply `mode` (fixture/live), a normal generation
`request`, and `selection` with `mapping_ids`, `intermodulation` (replace/add/
multiply), `accept_held` and `accept_uncertainty`. The producer owns frames;
client-supplied output evidence is not accepted by this route.

Three declared assignments map carbon intensity to duration (0.1–30 s), quake
count to integer steps (1–250), and coal proportion to CFG (0–25). Select 1–3
unique assignments and targets. All resulting values must remain within those
bounds. Held and uncertain values require explicit opt-in and retain their
status; skipped/refused values never become generation parameters. A request
with no usable assignment refuses before generation. Attributed frames, source
and capture clocks, evidence mode, frame hash, intermodulation and consumer
outcomes travel through source metadata into the MASA generation receipt.
Scheduling a control establishes neither capture nor hearing.

`POST /akousma/agent-sounds` accepts `metadata_files` (1–16 settled generated
outputs) and explicit `recipient_requirements`. It checks owned audio bytes and
completed generation metadata/MASA hash bindings, then writes a bounded private
`earworm/agent-sounds/v1` ZIP. Total audio is at most 32 MiB. Each member retains
its actual hash, encoding, sample rate, channels, generation receipt and declared
covenants. Sampled spectral content stays unknown unless separately evidenced;
Nyquist is labelled a sampling limit. Human access is unknown and no optional
human rendering is fabricated. This is not a claim of categorical inaudibility.
Canonical memory export remains owned by Akousmata. All work stays local.
