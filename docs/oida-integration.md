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
