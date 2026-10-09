# Spectral generation · GERM 0.6.0

These are digital research renders. Their WAV rate, declared components and measured energy
are separate facts. None establishes capture support, physical ultrasonic emission, audibility,
perceptual quality or an improvement over a parent sound.

## CPU request contract

The existing `GenerateRequest.source.synthesis` object carries the controls. `sample_rate`
is request-local: 44100 (default), 48000, 96000 or 192000. The actual provider writes that rate
into WAV headers, output metadata, MASA audio declarations and agent-sounds manifests.
Other providers and the independent wavetable/clock contracts keep their native rates.
Submit through the existing job service; one mono PCM16 output, 0.1–30 seconds, gain 0–1.

| Model | Controls beyond frequency/gain/rate | Admission and declared recipe |
|---|---|---|
| additive | `partials` (1–32 amplitudes); optional matching `frequencies` | Harmonic multiples by default; explicit frequencies support retained-frame reconstruction. Amplitudes normalized by their absolute sum, never boosted above gain. |
| chirp | `end_frequency` | Linear instantaneous-frequency sweep. Both endpoints must be admitted. |
| band-noise | `low_frequency`, `high_frequency`, `components` (2–256) | Seeded random multisine with random phases; a finite-band noise approximation, not ideal continuous noise. |
| fm | `mod_frequency`, `mod_index` (0–8), `sidebands` (1–32) | Finite Bessel expansion. At least ceil(index)+8 sidebands; every declared component must remain positive and below Nyquist. This intentionally differs from an infinite-sideband FM oscillator. |
| pulse | `harmonics` (1–128), `duty` (0.01–0.99) | Finite Fourier pulse approximation with DC omitted; every harmonic admitted independently. |

Component frequencies span 0.1–90000 Hz, strictly below the chosen Nyquist limit. Finite
windows, modulation transitions and quantization can introduce other spectral energy. The
6 ms attack and 45 ms release use raised cosines. The maximum output is 5,760,000 frames
(11,520,000 PCM bytes), rendered in 8192-frame blocks with cancellation and a 30-second deadline.
Measurements report PCM peak/DC, silence, FFT peak and beyond-reference energy fraction over
an explicitly identified first-second (or shorter) window. Resolution and the number of
cycles at the declared low edge accompany the receipt; a fraction of a cycle cannot establish
an accurate low-frequency measurement. Results are repeatable within the recorded NumPy,
Python, engine source and serialization profile, not promised byte-identical across upgrades.

The legacy sample adapter now uses finite FFT low-pass conversion when rates differ. It
records input/output clocks, frame counts, its 90–100% Nyquist transition band, raised-cosine
edge changes and peak normalization. A 40 kHz component is removed in a declared 48 kHz
conversion; the converted file cannot claim to preserve that component.

## Retained observations and spectral frames

`GET /workspace/spectral/sources` returns bounded selections for the two existing-job routes:
`POST /workspace/spectral/audify` and `POST /workspace/spectral/frame`. Both take `selection`,
`sample_rate`, `duration`, `gain` and `seed`. The Station exposes these in Generation.

Audification resolves an observation account from Akousmata and a hash-matching
`cosmo/observation-series/v1` inside its retained MASA snapshot. Cosmo 0.3.0's Phase 5 candidate
adds `cosmo:observation-series` to that snapshot. Old accounts without the series remain
ineligible; retaining a new observation creates a new account rather than rewriting history.
Source identity, consent, retention and exact source/series hashes are rechecked before
publication. The output retains its parent account, original clock/intervals, units, quality,
normalization, interpolation, compression, mode, attribution and a MASA Mapping.

`parameter_mapping` maps an explicit clamped input range to oscillator frequency. It permits
a single snapshot, attributed as a parameter value. `direct_audification` requires at least
two ordered points and either uniform timestamps or explicit linear resampling. Missing,
nonfinite, stale and unavailable inputs are refused; no zeros or fixtures replace live gaps.
Without direct resampling the output frame count must equal the point count. Point-count
reduction is refused because this mapping does not implement a filtered series downsampler.
Source policy context is preserved verbatim in the receipt; top-level copies use GERM's local
record policy and explicitly reference the external source policies, without granting new rights.

A frame brief resolves a currently authorized `complex_stft` numeric object through Akousmata's
host grant, including expiration, revocation, forgetting, policy state and content hash. It
requires channel/frequency/time axes, Hz/s units and magnitude scaling. Local peaks exclude
DC/Nyquist; magnitude rank selects at most 32, with bin index breaking ties. The receipt carries
frame time, FFT resolution, source/bundle/view hashes and extraction code hash. Phase is lost,
amplitudes become relative, and temporal evolution is not reconstructed. SVGs are never inputs.
The optional `spectral` extra provides this host integration on Python 3.11+; the qualified
Station candidate uses Python 3.13. CPU oscillators remain usable on GERM's existing Python 3.10 floor.

## Playback and digital listening

All owner-served audio is locked by default, including unknown-scope assets, Library, History,
research audio and wavetable WAV exports. An explicit same-origin `POST /playback-session`
grants 15 minutes; DELETE, page reload or process restart revokes it. Cookies are session-only,
separate for GERM and Station; grants are never included in a preset, snapshot or imported pack.
The dashboards also gate cached media and Web Audio, and suspend playback on lock/expiry.
Enabling a session does not start audio. Browser/device resampling may alter a render.

Oída listen-back resolves digital bytes directly and does not enable browser or hardware
playback. The generated sound, its source observation/frame, mapping and subsequent listening
remain distinct records. Agent-sounds packs include the declared and measured scope while
keeping a strict retained band limit and human perceptual access unknown.

Not implemented: physical ultrasonic capture/emission qualification, arbitrary continuous
noise or infinite FM/pulse spectra, missing-data interpolation, direct downsampling of
observation series, and cross-version byte determinism. Phase 6 scheduling remains separate.

The local wheel now packages the `server` runtime, dashboard assets and CPU processing bridge.
Installed defaults use the user's data directory instead of writing output into site-packages;
set `GERM_OUTPUT_DIR` explicitly for candidate tests and operator deployments. It includes no
model weights or provider environments. The candidate doctor checks the installed GERM module
and every distribution's RECORD hashes.

### Native digital listen-back API

`POST /listener/relisten` accepts `route_preset: "agent-native"` with explicit
`native_options` matching Oída's native contract. GERM resolves the admitted input file
and binds its SHA-256; caller-supplied native paths or hashes are refused. For example:

```json
{"audio_path":"audio/generated.wav","route_preset":"agent-native",
 "native_options":{"permission_ref":"user:inspect-generated-output","mode":"beyond","memory":"none"}}
```

Station forwards this through `POST /api/owner/generation/native-relisten`.
No playback grant is required or issued. `remember` must match native memory selection;
retaining derivatives additionally requires Oída's explicit permission and expiry. Incognito
refuses persistence. Responses use `germ.oida-native-relisten/v1`, with a native outcome,
aperture and bounded report projection; ordinary listening-event and prompt fields are empty.
GERM metadata links the later native account and the exact inspected output hash without
rewriting the source generation or Oída's native account. Incognito skips that metadata write.
Full retained evidence remains owned by Oída/Akousmata.
