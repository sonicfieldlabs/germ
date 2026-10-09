import copy
import hashlib
from threading import Event

from fastapi.testclient import TestClient
from server.main import app
from server.registry import settings, registry, job_runner, storage
from server.routes import library, workspace
from server.audio_io import write_sine_wav

client = TestClient(app)


def test_memory_replay_index_is_bounded_exact_and_invalidated(monkeypatch):
    revision = [1]
    builds = []
    rows = [
        {"sound_id": "one", "title": "Retained", "audio_exists": True, "audio_file": "tone.wav", "memory_ids": ["akm_one"]},
        {"sound_id": "bad", "audio_exists": True, "audio_file": "bad.wav", "memory_ids": "akm_other"},
        {"sound_id": "gone", "audio_exists": False, "audio_file": "gone.wav", "memory_ids": ["akm_gone"]},
    ]
    monkeypatch.setattr(library, "_library_cache", {"built_signature": None, "items": None})
    monkeypatch.setattr(library, "_cached_output_signature_unlocked", lambda: revision[0])

    def build():
        builds.append(True)
        return list(rows)

    monkeypatch.setattr(library, "_build_library_items", build)
    result = client.get("/workspace/library/by-memory/akm_one").json()
    assert result == {"items": [{"key": library.library_key(rows[0]), "title": "Retained", "memory_ids": ["akm_one"], "duration": None}], "count": 1}
    for identifier in ("akm_on", "akm_other", "akm_gone"):
        assert client.get("/workspace/library/by-memory/" + identifier).json()["items"] == []
    assert len(builds) == 1
    assert client.get("/workspace/library/by-memory/bad.id").status_code == 422
    rows.clear()
    revision[0] += 1
    assert client.get("/workspace/library/by-memory/akm_one").json()["items"] == []
    assert len(builds) == 2


def external_audio(monkeypatch, tmp_path):
    root = tmp_path / "library"
    root.mkdir()
    path = root / "rain.wav"
    write_sine_wav(path, duration=1, frequency=330)
    monkeypatch.setattr(settings, "library_audio_roots", [root])
    monkeypatch.setattr(settings, "allowed_input_roots", [*settings.allowed_input_roots, root])
    item = next(i for i in library.library_items() if i.get("title") == "rain")
    return root, path, library.library_key(item), item


def test_shared_library_is_stable_read_only_and_blocks_escaped_audio(monkeypatch, tmp_path):
    root, path, key, item = external_audio(monkeypatch, tmp_path)
    editable = client.get("/library").json()["items"]
    assert all(row.get("sound_id") != item["sound_id"] for row in editable)
    assert any(row["key"] == key for row in client.get("/workspace/library").json()["items"])
    before = path.read_bytes()
    assert (
        client.post("/playback-session", headers={"origin": "http://testserver"}).status_code == 200
    )
    assert client.get(f"/library/audio/{key}").content == before
    resolved = client.get(f"/library/audio/{key}/resolve").json()
    assert resolved["sound_id"] == item["sound_id"]
    assert resolved["sha256"] == hashlib.sha256(before).hexdigest()
    assert resolved["duration"] == 1.0
    outside = tmp_path / "outside.wav"
    write_sine_wav(outside, duration=1, frequency=330)
    (root / "escape.wav").symlink_to(outside)
    assert all(i.get("title") != "escape" for i in library.library_items())
    assert path.read_bytes() == before
    path.unlink()
    assert client.get(f"/library/audio/{key}").status_code == 404


def test_audio_variation_reuses_parent_sound_and_hash(monkeypatch, tmp_path):
    _, path, key, item = external_audio(monkeypatch, tmp_path)
    monkeypatch.setattr(registry.get("stable_audio_mlx"), "is_available", lambda: True)
    admitted = []

    def submit(job):
        admitted.append(job)

        class Ticket:
            def model_dump(self):
                return {"job_id": "test", "status": "queued"}

        return Ticket()

    monkeypatch.setattr(workspace, "submit_job", submit)
    r = client.post(
        "/workspace/render",
        json={"mode": "audio", "sound_keys": [key], "mutation": 0.7, "duration": 5},
    )
    assert r.status_code == 200, r.text
    req = admitted[0].request
    assert req["lineage"]["parents"] == [item["sound_id"]]
    assert req["input_audio_path"] == str(path)
    assert len(req["source"]["sha256"]) == 64
    assert req["init_noise_level"] == 0.7
    assert not req["remember_to_akousmata"]
    assert (
        client.post(
            "/workspace/render", json={"mode": "audio", "sound_keys": [key, key]}
        ).status_code
        == 422
    )
    assert len(admitted) == 1


def test_all_eligible_memories_contribute_without_writes(monkeypatch):
    records = [
        {
            "akousma_id": "akm_" + str(i),
            "summary": "Rain texture " + str(i),
            "auditum": {},
            "provenance": {},
        }
        for i in range(5)
    ]
    before = copy.deepcopy(records)

    class Store:
        def query(self, **kwargs):
            assert kwargs["has_auditum"] is True
            return records

        def close(self):
            pass

    monkeypatch.setattr(workspace, "open_store", Store)
    context = workspace.memory_context()
    assert len(context["memory_influences"]) == 5
    assert all(r["summary"] in context["prompt"] for r in records)
    assert records == before
    assert [i["sha256"] for i in context["memory_influences"]] == [
        workspace.digest(r) for r in records
    ]
    records[0]["provenance"]["consent_status"] = "restricted"
    context = workspace.memory_context()
    assert len(context["memory_influences"]) == 4
    assert context["excluded"][0]["record_id"] == "akm_0"


def test_reboot_refuses_outstanding_job_and_preserves_it():
    release = Event()

    def work(*, cancel_event):
        release.wait(3)

    identifier = storage.new_job("text-to-audio", {}, status="queued")
    future = job_runner.submit(identifier, work)
    try:
        response = client.post(
            "/models/reboot", json={"provider": "stable_audio_mlx", "model": "sm-sfx"}
        )
        assert response.status_code == 409
        assert not future.cancelled()
    finally:
        release.set()
        future.result(timeout=5)


def test_model_bounds_reject_before_admission():
    assert (
        client.post(
            "/workspace/render", json={"mode": "prompt", "prompt": "Rain", "duration": 121}
        ).status_code
        == 422
    )
    assert (
        client.post(
            "/workspace/render", json={"mode": "prompt", "input_audio_path": "/etc/passwd"}
        ).status_code
        == 422
    )


def test_non_audio_memory_contributes_as_attributed_compositional_context():
    from server.akousma_store import derive_prompt_contract

    record = {
        "akousma_id": "akm_observation",
        "record_kind": "observation_account",
        "listening": {
            "akouo.observation": {
                "contract": "akouo/masa-observation-report/v0.1",
                "payload": {
                    "report": {
                        "features": [
                            {
                                "name": "solar_wind_speed",
                                "value": {"status": "known", "value": 468, "unit": "km/s"},
                            }
                        ]
                    }
                },
            }
        },
    }
    before = copy.deepcopy(record)
    prompt = derive_prompt_contract(record)["prompt"]
    assert "solar_wind_speed: 468 km/s" in prompt
    assert "non-audio observation" in prompt
    assert record == before


def test_library_projects_existing_lineage_with_reverse_links(monkeypatch):
    parent = {
        "id": "parent",
        "sound_id": "sound_parent",
        "audio_file": "p.wav",
        "audio_exists": True,
        "parents": [],
    }
    child = {
        "id": "child",
        "sound_id": "sound_child",
        "audio_file": "c.wav",
        "audio_exists": True,
        "parents": ["sound_parent"],
        "lineage": {
            "operation_params": {
                "generation_context": {
                    "workspace_mode": "memory",
                    "memory_influences": [{"record_id": "akm_one", "sha256": "a" * 64}],
                }
            }
        },
    }
    original = copy.deepcopy([parent, child])
    monkeypatch.setattr(workspace, "library_items", lambda: [parent, child])
    rows = workspace.sounds()["items"]
    assert rows[0]["children"] == ["sound_child"]
    assert rows[1]["parents"] == ["sound_parent"]
    assert rows[1]["title"] == "Memory composition · 1 records"
    assert rows[1]["memory_influences"][0]["record_id"] == "akm_one"
    assert [parent, child] == original


def test_discovered_excerpt_preserves_import_identity_and_provenance():
    import io
    import wave
    import json
    import hashlib

    buffer = io.BytesIO()
    with wave.open(buffer, "wb") as wav:
        wav.setnchannels(1)
        wav.setsampwidth(2)
        wav.setframerate(8000)
        wav.writeframes(b"\x00\x00" * 8000)
    sid = "discovery_test_excerpt"
    metadata = {
        "provider": "mock",
        "model": "public-audio-excerpt",
        "source_type": "discovery",
        "prompt": "Open stream excerpt",
        "lineage": {"id": sid},
        "source": {
            "type": "discovery",
            "page_url": "https://example.org/stream",
            "license": "Source terms",
            "seed_records": [{"record_id": "ak_seed", "sha256": "a" * 64}],
        },
    }
    response = client.post(
        "/audio/import",
        files={"file": ("excerpt.wav", buffer.getvalue(), "audio/wav")},
        data={"metadata": json.dumps(metadata)},
    )
    assert response.status_code == 200, response.text
    row = next(i for i in client.get("/workspace/library").json()["items"] if i["sound_id"] == sid)
    assert row["key"] == hashlib.sha256(sid.encode()).hexdigest()
    assert row["kind"] == "discovery"  # Imported sound is never labelled a mock generation.
    assert row["source"]["seed_records"][0]["record_id"] == "ak_seed"
    assert row["duration"] == 1


def test_selected_memory_context_preserves_identity_and_guidance(monkeypatch):
    selected = {
        "akousma_id": "akm_selected",
        "summary": "Raindrops",
        "auditum": {},
        "provenance": {},
    }

    class Store:
        def get(self, rid):
            return copy.deepcopy(selected) if rid == "akm_selected" else None

        def query(self, **kwargs):
            raise AssertionError("Must not expand into all memory")

        def close(self):
            pass

    monkeypatch.setattr(workspace, "open_store", Store)
    monkeypatch.setattr(registry.get("stable_audio_mlx"), "is_available", lambda: True)
    jobs = []

    class Ticket:
        def model_dump(self):
            return {"job_id": "selected", "status": "queued"}

    monkeypatch.setattr(workspace, "submit_job", lambda job: jobs.append(job) or Ticket())
    result = client.post(
        "/workspace/render",
        json={
            "mode": "memory",
            "record_ids": ["akm_selected"],
            "prompt": "Sparse texture",
            "reasoning_session_id": "conv_one",
            "reasoning_summary": "Roof resonance",
        },
    )
    assert result.status_code == 200, result.text
    fields = jobs[0].request
    context = fields["generation_context"]
    assert context["memory_influences"][0]["record_id"] == "akm_selected"
    assert context["memory_influences"][0]["sha256"] == workspace.digest(selected)
    assert "Sparse texture" in fields["prompt"] and "Roof resonance" in fields["prompt"]
    assert context["reasoning_session_id"] == "conv_one"
    decision = client.post(
        "/workspace/render",
        json={
            "mode": "memory",
            "record_ids": ["akm_selected"],
            "reasoning_decision_id": "decision_one",
            "reasoning_summary": "A temporal gap",
        },
    )
    assert decision.status_code == 200, decision.text
    assert jobs[-1].request["generation_context"]["reasoning_decision_id"] == "decision_one"
    assert jobs[-1].request["generation_context"]["reasoning_session_id"] is None
    assert (
        client.post(
            "/workspace/render", json={"mode": "memory", "record_ids": ["akm_missing"]}
        ).status_code
        == 404
    )
    assert (
        client.post(
            "/workspace/render",
            json={"mode": "prompt", "prompt": "test", "record_ids": ["akm_selected"]},
        ).status_code
        == 422
    )


def test_job_sounds_matches_explicit_outputs_only(monkeypatch, tmp_path):
    _, path, key, item = external_audio(monkeypatch, tmp_path)
    from server.schemas import JobStatus

    job = JobStatus(
        job_id="test",
        status="done",
        mode="text-to-audio",
        created_at="2026-09-09",
        updated_at="2026-09-09",
        audio_files=[str(path)],
    )
    monkeypatch.setattr(storage, "get_job", lambda id: job)
    values = client.get("/workspace/jobs/test/sounds").json()["items"]
    assert len(values) == 1 and values[0]["key"] == key


def test_workspace_editing_checks_real_duration_and_keeps_source(monkeypatch, tmp_path):
    _, path, key, item = external_audio(monkeypatch, tmp_path)
    before = path.read_bytes()
    admitted = []
    monkeypatch.setattr(registry.get("stable_audio_mlx"), "is_available", lambda: True)

    def submit(job):
        admitted.append(job)

        class Ticket:
            def model_dump(self):
                return {"job_id": "edit-test", "status": "queued"}

        return Ticket()

    monkeypatch.setattr(workspace, "submit_job", submit)
    r = client.post(
        "/workspace/render",
        json={
            "mode": "audio",
            "sound_keys": [key],
            "edit": "inpaint",
            "inpaint_ranges": [[0.2, 0.5]],
            "duration": 1,
        },
    )
    assert r.status_code == 200, r.text
    assert admitted[-1].mode == "inpainting"
    assert admitted[-1].request["lineage"]["parents"] == [item["sound_id"]]
    r = client.post(
        "/workspace/render",
        json={"mode": "audio", "sound_keys": [key], "edit": "continue", "duration": 2},
    )
    assert r.status_code == 200, r.text
    assert admitted[-1].request["source_duration"] == 1
    assert admitted[-1].request["target_duration"] == 2
    assert path.read_bytes() == before
    for body in [
        {"edit": "continue", "duration": 0.5},
        {"edit": "inpaint", "duration": 1, "inpaint_ranges": [[0.2, 2]]},
        {"model": "synth-additive", "duration": 1},
    ]:
        assert (
            client.post(
                "/workspace/render", json={"mode": "audio", "sound_keys": [key], **body}
            ).status_code
            == 422
        )
    assert len(admitted) == 2


def test_cpu_workspace_uses_existing_synthesizer_and_rejects_unknown_controls():
    r = client.post(
        "/workspace/render",
        json={
            "mode": "prompt",
            "model": "synth-additive",
            "duration": 0.2,
            "synthesis": {"frequency": 330, "gain": 0.1},
        },
    )
    assert r.status_code == 200, r.text
    assert r.json()["jobs"][0]["provider"] == "synthesis"
    assert (
        client.post(
            "/workspace/render",
            json={"mode": "prompt", "model": "synth-additive", "synthesis": {"shell": "no"}},
        ).status_code
        == 422
    )
    assert (
        client.post(
            "/workspace/render", json={"mode": "prompt", "model": "ace-turbo", "edit": "continue"}
        ).status_code
        == 422
    )


def test_memory_replay_checks_the_named_item_as_the_full_listing_would(monkeypatch):
    rows = [
        {
            "sound_id": "conditioned",
            "title": "Conditioned",
            "audio_exists": True,
            "audio_file": "tone.wav",
            "memory_ids": ["akm_one"],
            "generation_context": {"memory_influences": [{"record_id": "akm_x", "sha256": "0" * 64}]},
        },
    ]
    monkeypatch.setattr(library, "_library_cache", {"built_signature": None, "items": None})
    monkeypatch.setattr(library, "_cached_output_signature_unlocked", lambda: 1)
    monkeypatch.setattr(library, "_build_library_items", lambda: list(rows))
    import server.memory_policy as policy
    from fastapi import HTTPException

    def refuse(context, session=None):
        if context.get("memory_influences"):
            raise HTTPException(423, "withheld")

    monkeypatch.setattr(policy, "validate_context", refuse)
    assert client.get("/workspace/library/by-memory/akm_one").json()["items"] == []
    assert all(item["sound_id"] != "conditioned" for item in library.library_items())
