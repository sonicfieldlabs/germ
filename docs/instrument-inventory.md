# Instrument admission inventory

`/research/options` now includes `germ/instruments/v1`. Reading the catalog loads no model, installs no dependency and hashes no heavy checkpoint by default. `verify_deployments=True` is an explicit local verification call; executable job admission retains the original deployment/source/license checks.

The inventory distinguishes spectral-frame reconstruction, observation audification, optional shoebox-room simulation, Basic Pitch and RAVE guitar. Numerical/spectral tools remain source gated. Shoebox-room is unavailable when `pyroomacoustics` is absent; when present it remains policy gated, limited to thirty seconds plus five seconds of simulated tail. Neural instruments remain deployment unavailable or declared pending execution recheck. No unavailable dependency is silently installed.

Research cancellation and timeout now terminate the worker process group, including descendants, rather than only its immediate process. Admission refuses symlinked/oversized result manifests (1 MiB) and oversized individual artifacts (32 MiB) before retention/hashing. Existing source hashes, MASA receipt validation, license conditions, lineage and job states remain authoritative.

The regression suite and focused MASA validation establish local software behavior. Optional-engine skips do not qualify a room engine or neural checkpoint. Reconstruction is not source recovery; simulation is not a measured room; completed software output is not physical audibility or independent corroboration.
