# Security Policy

## Supported Versions

Security fixes target the current `main` branch and the latest tagged minor
release. Older release lines receive fixes only when explicitly announced.

## Reporting a Vulnerability

Please report security issues privately to Sonic Field Labs before public
disclosure. Include the affected commit, local configuration, reproduction
steps, and whether generated audio, model files, or listening records can be
exposed.

## Local-First Boundary

GERM is a local sidecar. Its optional Python provider loads model and LoRA files
only through configured model roots. Treat every model artifact as executable
input: use the official Safetensors releases, verify provenance, and do not load
untrusted pickle-based checkpoints.

The default server binds to `127.0.0.1`, validates Host headers, and rejects
foreign browser origins for state-changing requests. Audio and metadata routes
normalize paths and require resolved files to remain inside their configured
input, output, metadata, model, upload, or scratch roots before filesystem
access. Upload writes are confined to managed upload or scratch directories.

## Temporary upstream PyTorch exceptions

The optional local runtime retains Torch and Torchaudio 2.10.0. Updating this
pair requires separate model, dependency and accelerator qualification; this
review does not claim new GPU/MPS or model-inference evidence.

The machine-readable policy is [advisory-exceptions.json](advisory-exceptions.json).
The repository CODEOWNER, **@emeisazam**, owns follow-up. Reviewed **26 September
2026**; exceptions expire **10 October 2026**, or earlier if the affected API,
model trust boundary or runtime version changes. Review again before enabling
an optional runtime. CI refuses an expired policy or a widened advisory set
before invoking pip-audit; it suppresses exactly these two advisory identities.

| Advisory | Current upstream evidence | Scoped repository review |
| --- | --- | --- |
| `PYSEC-2026-139` / `CVE-2026-4538` | [.pt2 deserialization advisory](https://github.com/advisories/GHSA-33x2-ppm4-v46v); no patched version is listed by the current audit feed. | No direct `torch.export.load` call or .pt2 model intake found in owner source. |
| `CVE-2025-3000` / `GHSA-rrmf-rvhw-rf47` | [TorchScript advisory](https://github.com/advisories/GHSA-rrmf-rvhw-rf47); fixed in 2.13.0. | No direct `torch.jit.script` call found in owner source. |

This is a bounded source review, not a transitive execution trace or permission
to load untrusted model artifacts. GERM does use `torch.jit.load` for operator-selected research exports; that distinct API and its model trust requirements remain explicit. The reviewed optional runtime remains conditional on its existing operational
qualification requirements.

The September review also found two AnyIO advisories in the locked 4.13.0:
[TLS hostname handling](https://github.com/advisories/GHSA-82r6-8w77-94w6) and
[process-pool stderr handling](https://github.com/advisories/GHSA-5p39-cfhj-2xmp).
Both have fixes in 4.14.2. The dependency floor now excludes older versions;
these findings are not suppressed. New audit findings continue to fail CI.

### Git dependency audit coverage

`pip-audit --disable-pip` cannot process the Stable Audio Git requirement. The
audit wrapper therefore records its exact reviewed source separately and audits
all exported registry dependencies, including its transitive dependencies. It
refuses unknown/changed source requirements or expired source reviews. The
[upstream advisory page](https://github.com/Stability-AI/stable-audio-3/security/advisories)
and public API returned no published advisories on 26 September; the checked
commit is recorded in `advisory-exceptions.json`. This is not a source-code
vulnerability scan. The audit emits a separate `.source-coverage.json` receipt
so this limit is visible even when the registry audit passes.

### Local review, 2026-09-13

Repository call-site inspection found no new use of the excepted APIs. The
all-extras dependency audit passes with exactly the same two exceptions; no
additional advisory was suppressed. HTTPX2/HTTPCore2 were updated to 2.12.0,
and the affected optional dependency bounds were refreshed. These software
checks do not validate GPU/MPS inference with the new resolved dependencies.
Keep optional model execution conditional on that validation and review the
exceptions again before enabling it, or by the deadline above.
