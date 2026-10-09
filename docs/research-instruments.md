# Offline research instruments

P7 adds the optional `research` provider behind the existing queue, cancellation, resource admission and Library lineage. Instruments are provisioned separately; no inference-time download is permitted. The dedicated `/research/run` route admits one Library key and a bounded interval, then submits an ordinary GERM job.

- `rave-guitar`: Intelligent Instruments Lab guitar TorchScript, 48 kHz mono offline latent transformation. Explicit noncommercial research runtime and per-job profiles are required.
- `basic-pitch`: Spotify 0.4.0 ONNX, 22.05 kHz mono note hypotheses. Returns JSON/MIDI with no fabricated audio-files entry.

`GET /research/options` lists availability and the latest 30 retained research receipts. `GET /research/jobs/{id}` inspects a completed manifest. Artifact endpoints serve only the hash-verified, enumerated WAV/JSON/MIDI files. Hyphenated GERM UUIDs and compact IDs are accepted. Inference and failed/cancelled lifecycle receipts remain under the existing jobs API.

Receipts distinguish source, analysis view, neural transformation and symbolic hypotheses; neither tool performs separation or supplies a residual. Only WAV transformations enter the sound Library. Source records are not modified. Research parents require the research profile for another research operation and are rejected by the ordinary workspace render route to avoid dropping restrictions.

Admission uses `listening-stack/src/listening_stack/research.py`, `GERM_RESEARCH_CONFIG` and the optional `GERM_RESEARCH_PROFILE=noncommercial_research`. The manifest pins model, environment, worker and evaluation hashes. Missing or changed deployments fail closed while other providers continue working.

See `../listeningstackweb/docs/model-ecology-p7.md` for exact artifacts, upstream sources, local evidence and unresolved perceptual validation. Basic Pitch note amplitude is not a calibrated probability; RAVE output is not faithful reconstruction or independent environmental evidence.
