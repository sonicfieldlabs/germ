# Retained-record derivation (G6 and G4)

GERM exposes three owner-local templates through its existing Akousma API. They
reuse AKOÚŌ's A12 `derivation_plan`, Earworm's canonical validators and GERM's existing
prompt handoff. They return editable proposals for a **new sound**, not a reconstruction
of source audio or a claim that a model has heard it. Neither endpoint starts a job.

- `GET /akousma/derivation/templates`: template IDs, defaults, parameter policy and mappings.
- `POST /akousma/derivation/plan`: resolve selected records and return an attributed plan.

`variation` and `combine` reuse the existing prompt extraction over one or several
retained records. `structured` consumes `akouo/agent-report/v0.1` payloads directly,
without requiring a summary or claim prose. Each report must bind to a retained
listening namespace, listener and pass, the record subject and its apparatus declaration.
These are retained declarations; the adapter does not authenticate apparatus or
independently validate a report's underlying measurements.

## Request

Supply 1–32 distinct local record IDs. The owner must declare an attributed actor,
a granted permission reference for each selected source, resolved references and
explicit negotiation of `akouo/record-workflow/v0.1` and policy `germ:derivation` revision
`1`. The request timestamp must not precede any source. Example, replacing IDs and time:

```json
{
  "template": "structured",
  "workflow": {
    "contract": "akouo/record-workflow/v0.1",
    "request_id": "request:my-derivation",
    "actor_ref": "actor:owner",
    "created_at": "2026-09-07T18:00:00Z",
    "source_refs": ["ak:source"],
    "permissions": [{"record_ref": "ak:source", "status": "granted", "permission_ref": "permission:owner"}],
    "supported_contracts": ["akouo/record-workflow/v0.1"],
    "resolved_refs": ["actor:owner", "permission:owner", "germ:derivation"],
    "policy_ref": "germ:derivation",
    "policy_revision": "1"
  },
  "parameters": {"duration": 8}
}
```

Post the saved JSON using `curl -H 'Content-Type: application/json' --data-binary
@request.json http://127.0.0.1:5178/akousma/derivation/plan`. Permission references are
owner declarations, not an external rights verification service. Restricted sources
are refused. Sources with retained withholding, applied covenant rules or commitments
require a dedicated policy and are conservatively refused by these initial templates.
Source records are never rewritten. Changed source fingerprints during planning return
409; malformed input, unresolved bindings or unsupported policies return 400.

## Exact mapping policy, revision 1

| Feature name | Required known value and unit | Proposed output |
| --- | --- | --- |
| `time_scale` | Number, 0.1–60 `s` | `duration`; maximum supported scale across selected reports |
| `frequency_band` | Ordered nonnegative numeric pair, `Hz` | An attributed band reference in the prompt |
| `texture`, `gesture`, `material` | Nonempty text up to 256 characters, `descriptor` | An attributed descriptor in the prompt |

Names and units are exact; unsupported names, units or shapes remain explicit omissions.
No synonym guessing or implicit unit conversion occurs. Earworm’s existing claim-validity
evaluator omits expired and not-yet-valid claims at the host evaluation time; unknown
validity remains labelled unknown in the speculative mapping. Unknown, withheld, unavailable,
not-applicable and undetermined features are omitted. If no usable feature remains,
the structured template refuses rather than inventing a derivation. Attributed categories
remain attached to mappings, while every proposed output is speculative. Band references
are compositional prompts, not claims about provider bandwidth, capture range, sampled
representation or human access. No frequency translation or audio reconstruction occurs.

Default numerical parameters are `duration=4`, `steps=8`, `cfg_scale=1`. Allowed ranges
are 0.1–60 seconds, integer 1–250 steps and CFG 0–25. Explicit overrides take precedence
and are retained separately from source mappings. A default duration after a missing
scale is a compositional default, not an estimated source duration. These planning
bounds do not replace the selected provider's own admission limits.

## Handoff and local setup

The result includes exact parent IDs, source/report SHA-256 fingerprints, permissions,
policy revision, mappings, omissions and `execution: not_requested`. `generation_fields`
validate against GERM's existing `GenerateRequest`; provenance travels in `source.derivation`.
The caller must choose a provider and model and recheck current source content,
permissions and cancellation before using the existing generation/queue endpoint.
A plan is not an output asset, execution receipt or independently attributed later listening.
The linked-generation endpoint provides G1/G3 linkage; G5 supplies shared lifecycle controls; G8 retains the remaining decision integration.

This local development revision adds `akouo-contract` and uses sibling AKOÚŌ and
Earworm checkouts in `tool.uv.sources`, with the lockfile updated. Their current
unreleased contracts are required; older published versions with the same package
version may lack them. In the complete local stack, use `uv sync --locked --extra dev --reinstall-package
akouo-contract --reinstall-package akousma`. Reinstalling prevents an older cached
build with the same version number from hiding the unreleased contract modules.
A standalone release must pin published contract revisions before removing the sibling
source overrides. No package version was incremented in this batch.

Tests use a synthetic fixture built with Oída's canonical report-account composer and
Earworm's synthetic apparatus declaration. They demonstrate binding, mapping, bounds,
source preservation and request compatibility, not live model output or listening quality.

G1/G3 now add the opt-in [linked execution endpoint](linked-generation.md), which
rebuilds the plan, runs the existing provider and returns output/record/MASA links.
The planning endpoint itself remains non-executing.
