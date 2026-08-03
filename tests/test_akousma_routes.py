"""The oída→germ akousma bridge: /import modes + /akousma JSON surface.

Runs against an isolated temp akousmata store (AKOUSMATA_PATH) so the real shared
store is never touched, mirroring conftest's output isolation.
"""

from __future__ import annotations

import io
import json
import wave
from pathlib import Path

import akousma
import pytest
from fastapi.testclient import TestClient

from server.akousma_store import resolve_audio_path
from server.main import app
from server.registry import settings


def _wav_bytes(seconds: float = 0.05, rate: int = 8000) -> bytes:
    buf = io.BytesIO()
    with wave.open(buf, "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(rate)
        w.writeframes(b"\x00\x00" * int(seconds * rate))
    return buf.getvalue()


def _allowed_audio(name: str, *, seconds: float = 0.05) -> Path:
    settings.audio_dir.mkdir(parents=True, exist_ok=True)
    path = settings.audio_dir / name
    path.write_bytes(_wav_bytes(seconds=seconds))
    return path


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
            covenant=akousma.covenant(
                "river-covenant/2",
                contract="akouo/v0.7",
                withheld=[{"rule": "do_not_reveal", "subject": "transcript", "count": 1}],
            ),
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
    body = response.json()
    prompt = body["prompt"]
    assert "warm synthesizer drone" in prompt  # preferred akouo.describe namespace
    handoff = body["handoff"]
    assert handoff["contract"] == "oida-germ.prompt/v0.1"
    assert handoff["editable"] is True
    assert handoff["parent_akousma_ids"] == [seeded["akousma_id"]]
    assert handoff["remember_to_akousmata"] is True
    assert handoff["source"]["originating_app"] == "oida"
    assert handoff["covenant"]["id"] == "river-covenant/2"

    page = client.get(f"/import?akousma={seeded['akousma_id']}&mode=prompt")
    assert page.status_code == 200
    assert "opened as prompt" in page.text
    assert "germ.akousma.prompt-handoff" in page.text
    assert "readonly" not in page.text


def test_import_as_sound_lands_in_germ_library(client, seeded, store_path):
    response = client.get(f"/import?akousma={seeded['akousma_id']}&mode=sound&format=json")
    assert response.status_code == 200
    payload = response.json()
    assert payload["status"] == "done"
    assert payload["audio_files"], "import should produce a germ library file"
    metadata = json.loads(Path(payload["metadata_files"][0]).read_text(encoding="utf-8"))
    assert metadata["source_type"] == "imported"
    assert metadata["source"]["kind"] == "akousma"
    assert metadata["source"]["originating_app"] == "oida"
    assert metadata["source"]["covenant"]["id"] == "river-covenant/2"
    assert "location" not in metadata["source"]
    assert metadata["lineage"]["operation"] == "akousma-import"

    # The shared record now carries the germ.import extension.
    with akousma.AkousmataStore(store_path) as store:
        updated = store.get(seeded["akousma_id"])
    assert updated["extensions"]["germ.import"]["job_id"] == payload["job_id"]


def test_generation_writes_child_and_lineage_resolves(client, seeded, store_path):
    generated = _allowed_audio("akousma-generated.wav")

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


def test_generation_can_automatically_remember_cultivated_child(
    client,
    seeded,
    store_path,
):
    response = client.post(
        "/generate",
        json={
            "provider": "mock",
            "model": "mock-sine",
            "prompt": "cultivated warm drone with metallic flecks",
            "duration": 0.1,
            "output_name": "akousma-auto-child",
            "source": {
                "kind": "akousma",
                "akousma_id": seeded["akousma_id"],
                "originating_app": "oida",
            },
            "parent_akousma_ids": [seeded["akousma_id"]],
            "remember_to_akousmata": True,
            "listening_context": {
                "prompt_handoff": {
                    "contract": "oida-germ.prompt/v0.1",
                    "evidence": [{"namespace": "akouo.describe", "text": "warm drone"}],
                }
            },
            "covenant": seeded["covenant"],
        },
    )

    assert response.status_code == 200
    result = response.json()
    assert result["status"] == "done"
    metadata = json.loads(Path(result["metadata_files"][0]).read_text(encoding="utf-8"))
    assert metadata["akousmata"]["status"] == "remembered"
    child_id = metadata["akousma_id"]
    with akousma.AkousmataStore(store_path) as store:
        child = store.get(child_id)
    assert child["provenance"]["originating_app"] == "germ"
    assert child["lineage"]["parent_akousma_ids"] == [seeded["akousma_id"]]
    assert child["covenant"]["id"] == "river-covenant/2"
    assert "germ.prompt-source" in child["listening"]
    assert "oida.signal" not in child["listening"]
    assert child["extensions"]["germ.lineage"]["organism_id"] == metadata["sound_id"]


def test_unremembered_relisten_stays_in_germ_metadata(seeded, store_path):
    from server.listener import _persist_relisten_context

    metadata_path = settings.metadata_dir / "unremembered-relisten.json"
    metadata_path.write_text(
        json.dumps({"akousma_id": seeded["akousma_id"], "extensions": {}}),
        encoding="utf-8",
    )
    warnings: list[str] = []

    existing_id = _persist_relisten_context(
        metadata_path,
        {"contract": "germ.oida-relisten/v0.1", "event_id": "evt_private"},
        warnings,
    )

    assert existing_id == seeded["akousma_id"]
    assert not warnings
    germ_metadata = json.loads(metadata_path.read_text(encoding="utf-8"))
    assert germ_metadata["extensions"]["germ.relisten"]["latest"]["event_id"] == "evt_private"
    with akousma.AkousmataStore(store_path) as store:
        shared = store.get(seeded["akousma_id"])
    assert "germ.relisten" not in shared.get("extensions", {})


def test_generation_rejects_unknown_parent(client, store_path):
    generated = _allowed_audio("akousma-missing-parent.wav")
    response = client.post(
        "/akousma/generation",
        json={"audio_path": str(generated), "parent_akousma_ids": ["akm_missing"]},
    )
    assert response.status_code == 404


def test_automatic_memory_reports_unknown_parent_without_losing_audio(client, store_path):
    response = client.post(
        "/generate",
        json={
            "provider": "mock",
            "model": "mock-sine",
            "prompt": "child of missing memory",
            "duration": 0.1,
            "remember_to_akousmata": True,
            "parent_akousma_ids": ["akm_missing"],
        },
    )

    assert response.status_code == 200
    result = response.json()
    assert result["status"] == "done"
    assert Path(result["audio_files"][0]).is_file()
    metadata = json.loads(Path(result["metadata_files"][0]).read_text(encoding="utf-8"))
    assert metadata["akousmata"]["status"] == "error"
    assert "unknown parent akousma" in metadata["akousmata"]["error"]


# ── current contract: envelopes, sovereignty, kinship, and SA lineage ────────


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


def test_prompt_derivation_reads_nested_oida_generative_output(client, store_path):
    with akousma.AkousmataStore(store_path) as store:
        record = akousma.new_akousma(
            audio={"asset_id": "cap_nested"},
            originating_app="oida",
            listening={
                "oida.generative": {
                    "created_at": "2026-07-14T00:00:00Z",
                    "payload": {
                        "skill_id": "generative-bridge",
                        "akouo_output": {
                            "generative_prompt": "sparse ceramic pulses growing into a granular cloud"
                        },
                    },
                }
            },
        )
        store.put(record)

    response = client.get(f"/import?akousma={record['akousma_id']}&mode=prompt&format=json")

    assert response.status_code == 200
    body = response.json()
    assert body["prompt"] == "sparse ceramic pulses growing into a granular cloud"
    assert body["handoff"]["evidence"][0]["namespace"] == "oida.generative"


def test_prompt_derivation_prioritizes_dynamic_generative_namespace(client, store_path):
    with akousma.AkousmataStore(store_path) as store:
        record = akousma.new_akousma(
            audio={"asset_id": "cap_dynamic_generative"},
            originating_app="oida",
            summary="a broad general listening summary",
            listening={
                "akouo.generative-listening": {
                    "contract": "akouo/v0.7",
                    "created_at": "2026-07-14T00:00:00Z",
                    "payload": {
                        "transformation_prompt": "derive brittle harmonics from the soft pulse"
                    },
                },
                "oida.signal": {"caption": "soft pulse"},
            },
        )
        store.put(record)

    response = client.get(f"/import?akousma={record['akousma_id']}&mode=prompt&format=json")

    assert response.status_code == 200
    body = response.json()
    assert body["prompt"].startswith("derive brittle harmonics")
    assert body["handoff"]["evidence"][0]["namespace"] == "akouo.generative-listening"


def test_generation_writes_v15_record_with_sa_lineage_bridge(client, seeded, store_path):
    audio_file = _allowed_audio("organism with spaces.wav")
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

    response = client.post(
        "/akousma/generation",
        json={
            "audio_path": str(audio_file),
            "prompt": "metallic harbor bloom",
            "model": "stable-audio-3",
            "operation": "mutate",
            "parent_akousma_ids": [seeded["akousma_id"]],
            "listening": {
                "germ.listen": {"notes": "brighter than its parent"},
                "akouo.memory-lineage": {
                    "main_reading": "a metallic recurrence with a verified parent",
                },
                "akouo.describe": {
                    "contract": "akouo/v0.6",
                    "created_at": "2026-07-10T00:00:00Z",
                    "payload": {"main_reading": "pre-enveloped reading"},
                    "producer_metadata": {"future": True},
                },
                "oida.signal": {"class": "tonal"},
            },
            "tags": ["cultivated"],
            "summary": "metallic harbor bloom",
            "session_id": "sess_organism_007",
            "germ_lineage": organism_lineage_extension(organism_metadata),
            "covenant": {
                "id": "river-covenant/2",
                "withheld": [
                    {"rule": "do_not_reveal", "subject": "transcript", "count": 1},
                ],
                "commitments": 1,
                "future_policy": {"retention": "ephemeral"},
            },
        },
    )
    assert response.status_code == 200, response.text
    record = response.json()["record"]
    assert record["schema_version"] == "1.5.0"
    assert "%20" in record["audio"]["uri"]

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

    # Current AKOÚŌ output is pinned; existing and foreign producer blocks are
    # preserved instead of being rewritten by germ.
    assert record["listening"]["akouo.memory-lineage"]["contract"] == "akouo/v0.9"
    assert record["listening"]["akouo.describe"]["producer_metadata"] == {"future": True}
    assert record["listening"]["akouo.describe"]["payload"] == {
        "main_reading": "pre-enveloped reading"
    }
    assert record["listening"]["oida.signal"] == {"class": "tonal"}

    covenant = record["covenant"]
    assert covenant["id"] == "river-covenant/2"
    assert covenant["contract"] == "akouo/v0.9"
    assert covenant["withheld"][0]["subject"] == "transcript"
    assert covenant["future_policy"] == {"retention": "ephemeral"}

    with akousma.AkousmataStore(store_path) as store:
        assert resolve_audio_path(store, record) == audio_file.resolve()

    explorer = client.get(f"/import?akousma={record['akousma_id']}&mode=lineage")
    assert explorer.status_code == 200
    assert "river-covenant/2" in explorer.text
    assert "transcript × 1" in explorer.text


def test_generation_recurrence_links_same_source(client, seeded, store_path):
    audio_file = _allowed_audio("akousma-same.wav", seconds=0.07)
    first = client.post(
        "/akousma/generation",
        json={
            "audio_path": str(audio_file),
            "prompt": "first pass",
            "summary": "first pass",
        },
    ).json()["record"]
    second = client.post(
        "/akousma/generation",
        json={
            "audio_path": str(audio_file),
            "prompt": "second pass",
            "summary": "second pass",
            "relations": [{"type": "variant_of", "target_akousma_id": first["akousma_id"]}],
        },
    ).json()["record"]
    relations = second["lineage"].get("relations") or []
    assert any(
        rel["type"] == "same_source_as" and rel["target_akousma_id"] == first["akousma_id"]
        for rel in relations
    )
    assert any(
        rel["type"] == "variant_of" and rel["target_akousma_id"] == first["akousma_id"]
        for rel in relations
    )

    lineage = client.get(f"/akousma/lineage/{second['akousma_id']}").json()
    assert {
        (relation["type"], relation["akousma_id"], relation["direction"])
        for relation in lineage["related"]
    } >= {
        ("same_source_as", first["akousma_id"], "outgoing"),
        ("variant_of", first["akousma_id"], "outgoing"),
    }


def test_generation_accepts_explicit_relations(client, seeded, store_path):
    audio_file = _allowed_audio("akousma-variant.wav", seconds=0.09)
    response = client.post(
        "/akousma/generation",
        json={
            "audio_path": str(audio_file),
            "prompt": "a sibling take",
            "relations": [{"type": "variant_of", "target_akousma_id": seeded["akousma_id"]}],
        },
    )
    assert response.status_code == 200, response.text
    record = response.json()["record"]
    assert {"type": "variant_of", "target_akousma_id": seeded["akousma_id"]} in record["lineage"][
        "relations"
    ]
    with akousma.AkousmataStore(store_path) as store:
        incoming = store.related(seeded["akousma_id"])
    assert any(link["akousma_id"] == record["akousma_id"] for link in incoming)


def test_generation_rejects_audio_outside_allowed_roots(client, store_path, tmp_path):
    outside = tmp_path / "outside.wav"
    outside.write_bytes(_wav_bytes())

    response = client.post("/akousma/generation", json={"audio_path": str(outside)})

    assert response.status_code == 422
    assert "allowed input root" in response.json()["detail"]


def test_generation_reports_invalid_relation_and_covenant_as_client_errors(client, store_path):
    audio_file = _allowed_audio("akousma-invalid-contract.wav")

    relation_response = client.post(
        "/akousma/generation",
        json={
            "audio_path": str(audio_file),
            "relations": [{"type": "not-a-relation", "target_akousma_id": "akm_missing"}],
        },
    )
    assert relation_response.status_code == 400
    assert "not-a-relation" in relation_response.json()["detail"]

    covenant_response = client.post(
        "/akousma/generation",
        json={"audio_path": str(audio_file), "covenant": {"id": ""}},
    )
    assert covenant_response.status_code == 400
    assert "covenant.id" in covenant_response.json()["detail"]


def test_resolve_audio_path_handles_encoded_local_file_uris(store_path):
    audio_file = _allowed_audio("encoded local source.wav")
    local_uri = audio_file.resolve().as_uri().replace("file:///", "file://localhost/", 1)

    with akousma.AkousmataStore(store_path) as store:
        assert resolve_audio_path(store, {"audio": {"uri": local_uri}}) == audio_file.resolve()
        assert (
            resolve_audio_path(
                store,
                {"audio": {"uri": "file://remote.example/private/audio.wav"}},
            )
            is None
        )
        assert resolve_audio_path(store, {"audio": {"uri": settings.audio_dir.as_uri()}}) is None
