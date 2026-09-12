# Local granulation execution (unreleased)

GERM can execute a bounded subset of MASA 0.2.0 `matter.granulate` requests through
`server.processing_adapter.execute` or its owner CLI. It reuses the dashboard's
`GermGranularProcessor` and PCM WAV encoder from `audio_engine.js` in an isolated
Node process. MASA supplies the offline request, receipt and record validator;
GERM performs the DSP. Existing Micro request-building endpoints still describe
intentions and do not automatically run them.

## Supported execution contract

| Request | Support |
| --- | --- |
| Operation | `matter.granulate`; one source representation |
| Source | Uncompressed 16-bit PCM WAV, mono/stereo, 8–96 kHz, up to 30 s and 12 MiB |
| Grain duration | Fixed `min == max`, 8–400 ms; source must exceed grain duration plus 50 ms |
| Envelope | `gaussian` (sigma 0.18 of normalized grain phase) or `triangular` |
| Emission | `synchronous`, 4–120 grains/s; scheduling is quantized to 128-frame processing blocks |
| Selection | `random`, using the existing rolling three-second buffer and fixed jitter setting 0.35 |
| Scatter | Pitch 0–700 cents, pan 0–1; amplitude scatter must be absent or zero |
| Output | One `texture`, role `derivative`, PCM WAV at the input rate/channels and exact input frame count |
| Determinism | `require-seeded` with unsigned 32-bit `extensions["germ:micro"].seed`, or `accept-nondeterministic` (generated seed retained) |

The density × grain-duration budget is at most 40 simultaneous grain durations;
the existing engine also bounds its active list to 48. Startup may defer emission
while history fills. Source selection is from recent ring history, not uniformly
from the complete source. Output ends at the source duration, so remaining grain
tails are truncated. These are the offline rendering semantics of this adapter.
PCM export clamps samples to digital full scale and disables dither for seeded
reruns. The receipt records the actual engine parameters and render quantum.

Variable grain durations, asynchronous/quasi-synchronous emission, `totalGrains`,
region selection, fragment sets, unsupported envelopes and extra parameter fields
are refused. `require-deterministic` is refused because selection uses a seeded
random process. A known requested engine must be `germ:granular-worklet`; unknown
engine declarations can be bound by this adapter. No request is silently downgraded.
Byte-repeatability is scoped to the recorded engine/DSP hashes and Node runtime;
it is not asserted across arbitrary platforms or versions.

## Owner authority and invocation

The adapter is a local owner tool, with no new network endpoint. It requires a
separate host-authored authority JSON document. This document records an already
made policy decision; it is **not a signed credential or a policy evaluator**.
Only a trusted owner/host may supply it. An application integrating this callable
must evaluate its current permissions before constructing the authority; never
accept the authority document from an untrusted request body.

The authority contains:

- `requestSha256` and `recordSha256`, calculated with
  `server.processing_adapter.digest` (sorted compact JSON, finite values only).
- `sourceSha256`, the SHA-256 of the exact source file bytes.
- `expiresAt`, an aware ISO timestamp.
- A MASA `policyEvaluation`: `action: "matter.granulate"`, exact input `targets`,
  exact request `policyRefs`, `result: "permitted"`, `evaluatedAt`, an `evaluator`
  in the record's actors, nonempty `authorityRefs`, and reasons.

The source's policies must match the request and be active in the supplied record.
The request and record must agree on identity and use embedded history. Changes
to a request, record or source invalidate the associated hashes. Expiry is checked
before DSP and again after it. These checks bind the host's decision to the run;
they do not replace the host's review of policy rules, duties and revocations.

Use an installed, locally selected MASA 0.2.0 validator module; the adapter does
not download schemas or dereference URLs:

```sh
python -m server.processing_adapter \
  --request request.json \
  --record source.masa.json \
  --source source.wav \
  --authority owner-authority.json \
  --output ./processing-output \
  --validator /path/to/masa-validator/dist/index.js
```

Run from the GERM source distribution with its existing Python dependencies and
Node available. The adapter uses the repository's shared dashboard and script
assets, also included in the current wheel. Python callers pass
the same six values to `execute`, optionally with a `threading.Event` for
cancellation and a timeout of at most 30 seconds. The child has a 128 MiB Node
heap limit. Only one child is created by each invocation; hosts must bound the
number of concurrent invocations using their existing job controls.

## Receipts, lineage and recovery

A successful run publishes a new unique directory containing `output.wav`, the
unchanged request JSON and `record.masa.json`. The latter is a new revision,
preserving source entities and prior history while appending a validated receipt,
a distinct descendant and its `masa:granulated-from` relation. The descendant
carries a new GERM `soundId`; the original `sound_id` remains the parent's canonical
identity. Available parent sound identity is retained in the lineage extension.
No audio is automatically added to the application library by this CLI.

Receipts retain request identity/hash, source/output hashes, named engine/version,
engine and DSP source hashes, Node version, parameters, seed and output format.
Source declarations are retained; the new output does not inherit source apparatus,
physical capture claims or human listening claims. Unknown extensions on the
original record survive. A fresh output ID does not assert new physical evidence.

Valid unsupported or unauthorized requests produce a `refused` receipt. Engine,
codec or timeout failures produce `failed`; owner cancellation produces
`cancelled`. These outcomes publish no new audio or descendant. Malformed MASA
input or invalid host-policy shape fails before execution. No result is published
if final canonical validation fails. Temporary PCM and rendered audio are removed
on handled failure/cancellation. SIGINT/SIGTERM request cancellation; the supervisor
terminates and reaps the child. Forced host termination or power loss may leave a
hidden `.processing-*` temporary directory for owner cleanup; startup recovery and
a shared runtime journal belong to later application lifecycle integration.

Publication moves a completed directory into place atomically on the same
filesystem. It does not mutate the source record or promise crash-durable disk
flushes. Retrying produces a separate receipt and new descendant IDs; it does not
silently deduplicate executions. Application job retry/idempotency remains a host
responsibility.

## Verification

Set `GERM_TEST_MASA_VALIDATOR` to the local validator entry point and run:

```sh
python -m pytest -q tests/test_processing_adapter.py
```

The suite executes the shared DSP on synthetic WAV fixtures, checks seeded byte
repeatability, stereo/high-rate output, canonical receipt/record validation,
source preservation, unsupported parameters, authority/hash/expiry refusal,
resource bounds, backend failure, corrupt output, child timeout, active
cancellation and cancellation before publication. No model listening or physical
microphone evidence is inferred from these fixtures.

G7 also exposes the same granular DSP through the bounded `synthesis` provider
for application generation/library/lifecycle integration. That path records a
negotiated generation receipt; it does not accept or replace this owner-only
MASA processing authority contract. See [synthesis-adapters.md](synthesis-adapters.md).

Optional `matter.derive` shoebox simulation and its effective recipe are documented in [Simulated fields](simulated-fields.md).
