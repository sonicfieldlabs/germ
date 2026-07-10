# germ ↔ oída integration (akousma bridge)

**oída is generative ears; germ is generative voice.** They meet at the shared **akousma**
sonic-memory protocol (see `earworm/docs/akousma_spec_v1.md`) and the shared **akousmata** store
(`~/workspace/akousmata`, `$AKOUSMATA_PATH`).

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

On every transform/generation, germ writes a **new** akousma whose `lineage.parent_akousma_ids`
point at the source akousma(s), with `operation`, `prompt`, `model`, `params`. Use the Python
reference lib (installed the same way oída does it):

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

A panel inside germ that shows the `listening` block for any sound whose akousma carries one, plus
a **"listen with oída"** action (`POST {oida}/…` with the sound ref; the result attaches to the
same akousma's `listening`). The **lineage explorer** walks `store.parents()/children()/ancestors()`.

## Status

Backend bridge + shared store + protocol are **implemented and tested** (oída side, py-akousma).
Remaining germ-side UI work: the `/import` handler, the oída panel, and the lineage explorer view.

## Spec v1.1 + the akousmata navigator (2026-07-10)

The bridge now speaks akousma spec v1.1 (Earworm v0.2):

- **Skimmable summaries** — generation records carry `summary: "germ <operation>: <prompt>"`;
  prompt derivation prefers the record's own summary, then reads both raw
  (v1.0) and enveloped (v1.1 `{contract, created_at, summary, payload}`)
  listening entries. germ's own entries are pinned to `germ/v0.1`.
- **Kinship** — `POST /akousma/generation` accepts typed `relations`
  (`variant_of`, `series_with`, …), and re-registering the same audio content
  auto-links `same_source_as` to the previous holder.
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
