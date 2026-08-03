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

## Temporary Upstream PyTorch Exceptions

Stable Audio 3 still pins PyTorch 2.7.1 upstream. GERM overrides that constraint
with Torch and Torchaudio 2.10.0, validated on macOS by the full GERM suite and
the upstream Stable Audio CLI suite. This removes every currently fixable
finding below PyTorch 2.10.

Two findings remain accepted temporarily for the optional local provider:

| Advisory | Affected API | GERM exposure | Review deadline |
| --- | --- | --- | --- |
| `PYSEC-2026-139` / `CVE-2026-4538` | `torch.export.load` of `.pt2` artifacts | GERM does not call this API or accept `.pt2` model artifacts. No patched PyTorch release is currently published. | 2026-09-02 |
| `GHSA-rrmf-rvhw-rf47` / `CVE-2025-3000` | TorchScript compilation | GERM does not compile user-supplied TorchScript. Moving to PyTorch 2.13 requires upstream Stable Audio and accelerator validation. | 2026-09-02 |

The exception ends immediately if GERM begins calling either API, if its model
trust boundary changes, or when a compatible upstream runtime is available.
The all-extras CI audit ignores only these identifiers and fails on any new
finding.
