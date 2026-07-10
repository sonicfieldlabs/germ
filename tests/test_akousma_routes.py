"""The oída→germ akousma bridge: /import modes + /akousma JSON surface.

Runs against an isolated temp akousmata store (AKOUSMATA_PATH) so the real shared
store is never touched, mirroring conftest's output isolation.
"""
from __future__ import annotations

import io
import wave

import akousma
import pytest
from fastapi.testclient import TestClient

from server.main import app


def _wav_bytes(seconds: float = 0.05, rate: int = 8000) -> bytes:
    buf = io.BytesIO()
    with wave.open(buf, "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(rate)
        w.writeframes(b"\x00\x00" * int(seconds * rate))
    return buf.getvalue()


@pytest.fixture()
def store_path(tmp_path, monkeypatch):
    path = tmp_path / "akousmata"
    monkeypatch.setenv("AKOUSMATA_PATH", str(path))
    return path


@pytest.fixture()
def seeded(store_path):
    """One oída listen record with real audio in the isolated store."""
    with akousma.AkousmataStore(store_path) as store:
        uri = store.put_audio(_wav_bytes(), ext="wav")
        record = akousma.new_akousma(
            audio={"asset_id": "cap_1", "uri": uri, "duration_seconds": 0.05},
            originating_app="oida",
            source_type="recorded",
            origin="live-input",
            listening={
                "oida.signal": {"class": "tonal", "caption": "steady low hum"},
                "akouo.describe": {"summary": "warm synthesizer drone"},
            },
            tags=["drone"],
        )
        store.put(record)
    return record


@pytest.fixture()
def client():
    return TestClient(app)


def test_record_endpoint_roundtrip(client, seeded):
    response = client.get(f"/akousma/record/{seeded['akousma_id']}")
    assert response.status_code == 200
    assert response.json()["akousma_id"] == seeded["akousma_id"]


def test_record_404(client, store_path):
    assert client.get("/akousma/record/akm_missing").status_code == 404


def test_import_rejects_unknown_mode(client, seeded):
    response = client.get(f"/import?akousma={seeded['akousma_id']}&mode=bogus")
    assert response.status_code == 400


def test_import_as_prompt_derives_from_listening(client, seeded):
    response = client.get(f"/import?akousma={seeded['akousma_id']}&mode=prompt&format=json")
    assert response.status_code == 200
    prompt = response.json()["prompt"]
    assert "warm synthesizer drone" in prompt  # preferred akouo.describe namespace

    page = client.get(f"/import?akousma={seeded['akousma_id']}&mode=prompt")
    assert page.status_code == 200
    assert "opened as prompt" in page.text


def test_import_as_sound_lands_in_germ_library(client, seeded, store_path):
    response = client.get(f"/import?akousma={seeded['akousma_id']}&mode=sound&format=json")
    assert response.status_code == 200
    payload = response.json()
    assert payload["status"] == "done"
    assert payload["audio_files"], "import should produce a germ library file"

    # The shared record now carries the germ.import extension.
    with akousma.AkousmataStore(store_path) as store:
        updated = store.get(seeded["akousma_id"])
    assert updated["extensions"]["germ.import"]["job_id"] == payload["job_id"]


def test_generation_writes_child_and_lineage_resolves(client, seeded, store_path, tmp_path):
    generated = tmp_path / "generated.wav"
    generated.write_bytes(_wav_bytes())

    response = client.post(
        "/akousma/generation",
        json={
            "audio_path": str(generated),
            "prompt": "make it metallic",
            "model": "stable-audio-3",
            "operation": "audio-to-audio",
            "parent_akousma_ids": [seeded["akousma_id"]],
            "tags": ["metallic"],
        },
    )
    assert response.status_code == 200
    child_id = response.json()["akousma_id"]
    child = response.json()["record"]
    assert child["provenance"]["originating_app"] == "germ"
    assert child["lineage"]["parent_akousma_ids"] == [seeded["akousma_id"]]

    lineage = client.get(f"/akousma/lineage/{child_id}").json()
    assert [p["akousma_id"] for p in lineage["parents"]] == [seeded["akousma_id"]]
    assert lineage["ancestor_ids"] == [seeded["akousma_id"]]

    parent_lineage = client.get(f"/akousma/lineage/{seeded['akousma_id']}").json()
    assert [c["akousma_id"] for c in parent_lineage["children"]] == [child_id]

    explorer = client.get(f"/import?akousma={child_id}&mode=lineage")
    assert explorer.status_code == 200
    assert "lineage explorer" in explorer.text
    assert seeded["akousma_id"] in explorer.text


def test_generation_rejects_unknown_parent(client, store_path, tmp_path):
    generated = tmp_path / "generated.wav"
    generated.write_bytes(_wav_bytes())
    response = client.post(
        "/akousma/generation",
        json={"audio_path": str(generated), "parent_akousma_ids": ["akm_missing"]},
    )
    assert response.status_code == 404


# ── spec v1.1: envelopes, summaries, kinship, and the SA lineage bridge ──────


def test_prompt_derivation_reads_v11_envelopes(client, store_path):
    with akousma.AkousmataStore(store_path) as store:
        record = akousma.new_akousma(
            audio={"asset_id": "cap_env"},
            originating_app="oida",
            summary="harbor at dusk, machinery keynote",
            listening={
                "oida.signal": {
                    "created_at": "2026-07-10T00:00:00Z",
                    "payload": {"caption": "low machinery tone"},
                }
            },
        )
        store.put(record)
    response = client.get(f"/import?akousma={record['akousma_id']}&mode=prompt&format=json")
    assert response.status_code == 200
    # the record's own skimmable summary leads the prompt
    assert response.json()["prompt"].startswith("harbor at dusk")

    with akousma.AkousmataStore(store_path) as store:
        stored = store.get(record["akousma_id"])
        stored.pop("summary")
        store.put(stored)
    response = client.get(f"/import?akousma={record['akousma_id']}&mode=prompt&format=json")
    assert "low machinery tone" in response.json()["prompt"]


def test_generation_writes_v11_record_with_sa_lineage_bridge(client, seeded, store_path, tmp_path):
    audio_file = tmp_path / "organism.wav"
    audio_file.write_bytes(_wav_bytes())
    organism_metadata = {
        "sound_id": "organism_007",
        "lineage": {"operation": "mutate", "parents": ["organism_003"]},
        "model": "stable-audio-3",
        "provider": "stable_audio_mlx",
        "seed": 42,
        "operation_params": {"strength": 0.6},
        "latents": {"path": "somewhere"},
    }
    from server.akousma_store import organism_lineage_extension

    response = client.post("/akousma/generation", json={
        "audio_path": str(audio_file),
        "prompt": "metallic harbor bloom",
        "model": "stable-audio-3",
        "operation": "mutate",
        "parent_akousma_ids": [seeded["akousma_id"]],
        "listening": {"germ.listen": {"notes": "brighter than its parent"}},
        "tags": ["cultivated"],
        "summary": "metallic harbor bloom",
        "session_id": "sess_organism_007",
        "germ_lineage": organism_lineage_extension(organism_metadata),
    })
    assert response.status_code == 200, response.text
    record = response.json()["record"]

    # skimmable summary + earworm session link
    assert record["summary"] == "germ mutate: metallic harbor bloom"
    assert record["session_id"] == "sess_organism_007"

    # akousma lineage carries id-level genealogy only
    assert record["lineage"]["parent_akousma_ids"] == [seeded["akousma_id"]]

    # the SA cultivation detail lives ONCE in the extension (non-redundant)
    sa = record["extensions"]["germ.lineage"]
    assert sa["organism_id"] == "organism_007"
    assert sa["organism_parents"] == ["organism_003"]
    assert sa["operation"] == "mutate"
    assert sa["generation_index"] == 2
    assert sa["seed"] == 42
    assert sa["has_latents"] is True

    # listening entries arrive enveloped with the germ contract pin
    entry = record["listening"]["germ.listen"]
    assert entry["contract"] == "germ/v0.1"
    assert entry["payload"] == {"notes": "brighter than its parent"}
    assert entry["summary"] == "brighter than its parent"


def test_generation_recurrence_links_same_source(client, seeded, store_path, tmp_path):
    audio_file = tmp_path / "same.wav"
    audio_file.write_bytes(_wav_bytes(seconds=0.07))
    first = client.post("/akousma/generation", json={
        "audio_path": str(audio_file), "prompt": "first pass", "summary": "first pass",
    }).json()["record"]
    second = client.post("/akousma/generation", json={
        "audio_path": str(audio_file), "prompt": "second pass", "summary": "second pass",
    }).json()["record"]
    relations = second["lineage"].get("relations") or []
    assert any(
        rel["type"] == "same_source_as" and rel["target_akousma_id"] == first["akousma_id"]
        for rel in relations
    )


def test_generation_accepts_explicit_relations(client, seeded, store_path, tmp_path):
    audio_file = tmp_path / "variant.wav"
    audio_file.write_bytes(_wav_bytes(seconds=0.09))
    response = client.post("/akousma/generation", json={
        "audio_path": str(audio_file),
        "prompt": "a sibling take",
        "relations": [{"type": "variant_of", "target_akousma_id": seeded["akousma_id"]}],
    })
    assert response.status_code == 200, response.text
    record = response.json()["record"]
    assert {"type": "variant_of", "target_akousma_id": seeded["akousma_id"]} in record["lineage"]["relations"]
    with akousma.AkousmataStore(store_path) as store:
        incoming = store.related(seeded["akousma_id"])
    assert any(link["akousma_id"] == record["akousma_id"] for link in incoming)
