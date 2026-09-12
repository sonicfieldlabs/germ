# Retained subsequent-listening decisions (G8, unreleased)

`POST /akousma/generation/decision` records one explicit bounded decision using
AKOUO A13 and Earworm E16. Supply exactly `workflow` (the negotiated
`akouo/record-workflow/v0.1` decision request) and `metadata_file` (existing GERM
output metadata). The host uses policy `germ:subsequent-listening`, revision `1`.
The request declares its actor, per-record permissions, reason, selected action
and references. These declarations are local owner instructions, not signed
credentials; do not expose the owner application as untrusted public intake.

The host resolves all evidence itself:

1. A settled `done` job lifecycle receipt must name the metadata file.
2. The actual audio bytes must match the saved MASA output hash, representation,
   completed operation receipt and job binding.
3. The generated Akousmata record must resolve to those same audio bytes.
4. Each selected subsequent account must be separately retained, resolve to those
   same bytes, and name a real attributable listening in its canonical auditum.
   The existing bridge must also have retained that account ID and an output
   hash checked before/after the pass in the metadata re-listening history.
5. A13/E16 validate negotiation, permission scope, attribution, generation →
   listening → decision chronology, and permitted next-job/stop combinations.

The owner selects 2–32 records. Request size is at most 256 KiB and source
contracts bound each selected record to 2 MiB. Use canonical UTC timestamps
`YYYY-MM-DDTHH:mm:ss[.SSS]Z`. Output evidence supplied in the request is refused.
Inputs are re-resolved immediately before storage. This is a local consistency
check, not a transaction across filesystem audio and the shared SQLite store;
external changes after the check require another decision/revision.

Reuse `/listener/relisten` with `remember: true` to perform and retain an actual
Oida pass, or select a previously retained account still bound in that metadata
history. The existing history holds the latest 12 passes; an evicted binding
requires a new explicit pass. Legacy metadata without hashes cannot certify a
decision merely because its record has the same audio. The existing
linked-generation `relisten` option alone does not promise canonical retention.
A missing bridge, failed retention, missing listening, changed audio, restricted
source, cancelled/unsettled generation or missing receipt cannot become a valid
decision. No placeholder account is created. Synthetic accounts in tests are
labelled fixtures, not evidence of a live listener.

The workflow's `output_ref` is the MASA output representation ID and its
`decision.generation_ref` is the generated Akousmata ID, both available from the
linked-generation response. `subsequent_listenings` names each retained
`record_ref` and its `listening_ref`. Each requires an explicit entry in
`source_refs`, `decision.input_refs` and the per-record permissions.

A `keep` or `discard` decision has `next_job: {"status":"none","reason":"…"}`
and an appropriate stop outcome. A `revise` or `variation` decision may describe
`next_job: {"status":"planned","job_ref":"…"}` under the E16 continue rules.
The canonical contract also checks deferred/stopped outcomes. Execution remains
`not_requested`: a decision neither deletes an asset nor schedules a follow-up.
A later owner-authorized generation goes through the existing bounded queue.
There is no recursive self-generation loop or second scheduler.

Storage adds a fresh `generation_decision` record with a `decision_on` relation;
producer generation/listening records remain unchanged. An identical request
using the same record identity returns the retained record (`reused: true`). A
changed request with that identity is refused. Existing records are not silently
rewritten. The result includes `quality_improvement: "not_established"`: a selected
action and decision trace cannot establish an improvement in sound quality.

The local suite exercises actual synthesis → parent-linked generation → retained
synthetic later account → decision, source preservation, identical retries,
identity conflicts, missing/tampered evidence and route-level planned variations
without new jobs. The suite does not execute a live Oida model or human listening.

## Listening Stack workspace

`/workspace/render` is a bounded adapter to the existing `/jobs/submit` workflow.
The dashboard selects a local Stable Audio MLX model and prompt, whole-memory or
library-audio conditioning. It does not create a second generation engine or
sound store. Memory conditioning reuses `derive_prompt_contract`; full source
hashes and exact excerpts stay in `generation_context.memory_influences` and the
existing lineage operation parameters. Original records are never written.

`GET /workspace/library` projects Petri's cached library, preserving sound IDs
and deriving reverse child links from parent edges. `GERM_LIBRARY_AUDIO_ROOTS`
adds explicit read-only trees, including another GERM output library with its
existing metadata. `/library/audio/{key}` and `/resolve` resolve opaque keys only
against that index. Writable output and input/model allowlists remain separate.
For external audio to condition a render, its root also belongs in
`GERM_ALLOWED_INPUT_ROOTS`. Do not use broad filesystem roots for either setting.

`POST /models/reboot` resets the local MLX provider while idle. Job admission and
model controls share a lock; outstanding work is preserved. MLX weights load in
the render subprocess, so model preparation does not assert resident weights.

The legacy Petri editor's `/library` listing retains its writable-output scope.
Registered external roots appear in the read-only workspace projection, so the
legacy `/files` editing and playback controls never receive unsupported paths.
Both views reuse the same cached index; no separate sound database is created.
