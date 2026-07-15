# germ ↔ oída integration (akousma bridge)

**oída is generative ears; germ is generative voice.** They meet at the shared **akousma**
sonic-memory protocol (see `earworm/docs/akousma_spec_v1.md`) and the shared
**Akousmata** store configured by `AKOUSMATA_PATH`.

## oída → germ: the three buttons

After a listen, oída persists an akousma to the shared store and opens germ with a deep link
(`oida/oida/akousma_bridge.py`; endpoints `POST /germ/handoff`, `GET /germ/link`):

```
{germ}/import?akousma=<akousma_id>&mode=sound|prompt|lineage
```

germ must implement `/import` to read the akousma from the shared store and act on `mode`:

| mode | germ behavior |
|---|---|
| `sound` | resolve `audio.uri` from the akousmata store, load it as an **audio source**. |
| `prompt` | render the akousma's `listening` result as a **generation prompt**. |
| `lineage` | open the **genetic-ancestry explorer** focused on this `akousma_id`. |

## germ → shared store: what germ writes

Generation remains local to germ by default. When `remember_to_akousmata=true`, germ writes a
**new** akousma after a successful render whose `lineage.parent_akousma_ids` point at the source
akousma(s), with operation, effective prompt, model, parameters, covenant, and the compact
`extensions["germ.lineage"]` bridge. This opt-in avoids silently retaining audio or listening
context. A failed memory write is recorded in generation metadata without hiding a successful
audio render.

```python
import akousma
store = akousma.AkousmataStore()
child = akousma.new_akousma(
    audio={"asset_id": out_id, "uri": store.put_audio(open(wav, "rb").read())},
    originating_app="germ", source_type="generated", origin="generated",
    parent_akousma_ids=[source_akousma_id],
    operation="audio-to-audio", prompt=prompt, model="stable-audio-3", params=params,
)
store.put(child)
```

## germ's oída module

`POST /listener/relisten` uses oída's `/generation/relisten` comparison route when the source
lineage carries an oída generation id, falling back to `/gateway/listen` for a first pass. It then
asks `/generation/prompt` for a new editable prompt. Germ keeps only a compact, provenance-aware
result under `extensions["germ.relisten"]`; when retention is requested, germ calls oída's explicit
`/memory/remember` route and receives the shared Akousma id. An unremembered result stays in local
germ metadata and is not appended to an existing shared record. Germ does not load an
audio-understanding model. The lineage explorer walks `store.parents()/children()/ancestors()`.

## Status

The shared-store bridge, `/import` handler, structured editable prompt handoff, JSON
record/lineage endpoints, prompt and sound handoffs, re-listening action, optional derived-memory
write, and the self-contained lineage explorer are **implemented and tested**.

## Current contract: spec v1.3 (Earworm v0.4, 2026-07-14)

The bridge consumes and writes the current Akousma spec v1.3 while retaining the
v1.0/v1.1 read compatibility required by existing memories:

- **Skimmable summaries** — generation records carry `summary: "germ <operation>: <prompt>"`;
  prompt derivation prefers the record's own summary, then reads both raw
  (v1.0) and enveloped (v1.1 `{contract, created_at, summary, payload}`)
  listening entries. germ's own entries are pinned to `germ/v0.1`; raw AKOÚŌ
  output is pinned to the current `akouo/v0.7` contract. Existing envelopes and
  foreign producer blocks are preserved rather than reshaped.
- **Kinship** — `POST /akousma/generation` accepts typed `relations`
  (`variant_of`, `series_with`, …), and re-registering the same audio content
  auto-links `same_source_as` to the previous holder. The lineage endpoint and
  explorer expose relations in both directions without confusing them with
  causal parents.
- **Sovereign listening** — generation registration accepts the optional v1.3
  `covenant` identity/honest-absence block and validates it through py-akousma.
  Sound imports carry that covenant context into germ source metadata, never
  reconstruct withheld content, and deliberately do not duplicate the
  consent-scoped v1.2 `location` block.
- **The Stable Audio ↔ akousma lineage bridge, non-redundant** — germ's
  organism metadata keeps the SA cultivation lineage canonical (organism
  parents by `sound_id`, operation, params, latents). When an organism is
  registered as an akousma: `lineage.parent_akousma_ids` carries only the
  id-level genealogy between akousmata; the SA detail goes ONCE into
  `extensions["germ.lineage"]` (built by
  `server.akousma_store.organism_lineage_extension(metadata)`: organism_id,
  organism_parents, operation, generation_index, model/provider/seed,
  operation_params, has_latents); and `session_id` (`sess_<sound_id>`) links
  the record to the earworm event chain `metadata_to_earworm_session` emits
  for the same organism. Neither system duplicates the other: organism ids
  stay canonical in germ, akousma ids stay canonical in the store, and the
  event chain is reachable by session id.
- **The akousmata navigator** — the shared store now has its own app
  (`github.com/sonicfieldlabs/akousmata`): library, graph, wiki, research.
  The lineage explorer links to it (`GERM_AKOUSMATA_URL`, default
  `http://127.0.0.1:5180`), and the navigator's germ buttons point back at
  `/import` — listened things become sounding things in one gesture.
