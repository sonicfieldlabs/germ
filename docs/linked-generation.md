# Linked generation (G1/G3)

`POST /akousma/derivation/generate` extends the G6/G4 planning endpoint with execution
through GERM's existing provider runner. It creates no second queue or model adapter.
The route is synchronous and returns the ordinary job result plus explicit output links
and gaps. A repeated request starts another generation; there is no retry deduplication.

Wrap a [derivation request](derivation.md) in this body:

```json
{
  "derivation": {"template": "structured", "workflow": {}, "parameters": {"duration": 2}},
  "execution": {
    "provider": "mock",
    "model": "mock-sine",
    "seed": 42,
    "record_contract": "earworm/akousma/v1.6",
    "masa_contracts": ["masa/0.2.0"],
    "relisten": false
  }
}
```

Replace the empty workflow with the complete attributed source/permission/policy
request described in the derivation documentation. The example provider creates
synthetic PCM; choose the desired configured provider/model explicitly for model output.
Plans keep the existing duration/parameter bounds and batch size one. Requesting
another output schema or an unsupported MASA contract fails before provider execution.
Source records may be 1.6 or 1.7; the existing generation writer produces a 1.6 record.
Causal parents are preserved, and any recurrence relation uses Earworm's existing
validated `same_source_as` kind. No unsupported relation type is invented.

The host rebuilds the plan from current selected records and checks source fingerprints
before dispatch. Before shared generation retention it checks them again, including
missing and restricted sources. These are admission checks, not a transaction spanning
a long provider execution. If a source changes during generation, the committed audio
remains available but canonical retention fails explicitly and linkage is incomplete.
Permission references remain owner declarations, not authenticated external grants.

## Output and MASA account

Each successful link includes the metadata path, audio path and SHA-256, causal parent
IDs, generated Akousma ID, MASA record/representation/receipt IDs, and sidecar path.
The existing MASA sidecar writer now hashes the actual local output bytes. Its Generation
profile keeps the job identity and the attributed derivation in namespaced extensions.
Report references are not falsely described as audio ancestors. The output representation
and completed operation receipt share the exact representation ID.

The route rechecks output bytes against the retained sidecar hash before returning a
complete link. Missing companions, changed bytes or failed canonical retention are
reported in `gaps`; they do not delete the rendered audio. Provider failure returns
its existing error result and no completed output link. Hashes attest to bytes at the
recorded check, not permanent immutability of editable local files.

Ordinary generation requests default to the local `masa/0.2.0` contract. An explicit
empty or incompatible `masa_contracts` list yields `not_negotiated` companion status
while preserving the generated sound. The linked endpoint requires the explicit shared
contract and enabled owner sidecars. Runtime JSON checks and recorded offline MASA
reference-validator tests are separate from provider competence or policy verification.

## Optional later listening

`relisten: true` invokes GERM's existing Oída re-listening bridge after a verified
output link exists. The returned pass is bound to the generated Akousma ID and output
hash. Failure remains a separate subsequent-listening error; generation stays complete.
The bridge records its existing GERM metadata context; this route requests no canonical
listening retention and creates no decision record. G8 owns retained decisions, and
G5 now supplies the shared bounded runner and [lifecycle controls](job-lifecycle.md). No inherited hearing or improvement
in sound quality follows merely from a returned interpretation.

Local tests use real mock-provider PCM and the MASA offline reference validator. Oída
success/failure tests use attributed stubs and prove bridge wiring, not live model
listening. No production provider, deployment or physical listening claim is made.

For procedural CPU adapters choose `execution.provider: "synthesis"`, an explicit
adapter model and optional `execution.synthesis` parameters. See
[synthesis-adapters.md](synthesis-adapters.md). After a separately retained later
account, [generation-decisions.md](generation-decisions.md) describes the additive
A13/E16 decision route and its actual-byte/receipt binding gates.
