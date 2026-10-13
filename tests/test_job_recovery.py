"""Durable admission, restart and no-replay semantics use actual SQLite/HTTP."""

import json
import os
import subprocess
import sys
from pathlib import Path
from unittest.mock import patch

import pytest
from fastapi.testclient import TestClient

from server.config import Settings
from server.job_journal import JobConflict, JobJournal
from server.job_runner import JobRunner
from server.storage import StorageManager


def store(root, monkeypatch):
    monkeypatch.setenv("GERM_OUTPUT_DIR", str(root))
    return StorageManager(Settings())


def test_identical_retries_do_not_execute_and_conflicts_are_refused(tmp_path, monkeypatch):
    storage = store(tmp_path, monkeypatch)
    data = {"provider": "mock", "model": "mock-sine"}
    identifier, created = storage.admit_job("text-to-audio", data, request_id="request-1")
    assert created
    again, created = storage.admit_job(
        "text-to-audio", dict(reversed(list(data.items()))), request_id="request-1"
    )
    assert not created and again == identifier
    with pytest.raises(JobConflict):
        storage.admit_job("text-to-audio", {**data, "model": "changed"}, request_id="request-1")
    monkeypatch.setenv("LISTENINGSTACK_WORKSPACE_GENERATION", "changed")
    changed = store(tmp_path, monkeypatch)
    with pytest.raises(JobConflict):
        changed.admit_job("text-to-audio", data, request_id="request-1")


@pytest.mark.parametrize("state", ["created", "admitted", "running", "cancellation_requested"])
def test_restart_retains_zero_artifact_unknown_outcome_without_replay(tmp_path, monkeypatch, state):
    before = store(tmp_path, monkeypatch)
    identifier = before.new_job("text-to-audio", {"provider": "mock"}, status="queued")
    before.update_job(identifier, metrics={"execution_state": state})
    after = store(tmp_path, monkeypatch)
    runner = JobRunner(Settings(), after)
    try:
        retained = after.get_job(identifier)
        assert retained.status == "error" and retained.audio_files == []
        assert retained.metrics["execution_state"] == "interrupted"
        assert retained.metrics["automatic_replay"] is False
        assert runner.status()["outstanding"] == 0
        receipt = after.read_job_receipt(identifier)
        assert receipt["job_id"] == identifier and receipt["status"] == "error"
    finally:
        runner.shutdown(wait=True)


def test_crash_after_result_commit_preserves_artifacts_and_terminal_state(tmp_path, monkeypatch):
    from server.schemas import GenerationResult

    before = store(tmp_path, monkeypatch)
    identifier = before.new_job("text-to-audio", {}, status="queued")
    before.update_job(identifier, metrics={"execution_state": "running"})
    before.record_result(
        GenerationResult(job_id=identifier, status="done", audio_files=["audio/retained.wav"])
    )
    after = store(tmp_path, monkeypatch)
    after.reconcile_interrupted_jobs()
    retained = after.get_job(identifier)
    assert retained.status == "done" and retained.audio_files == ["audio/retained.wav"]
    assert after.read_job_receipt(identifier)["audio_files"] == retained.audio_files


def test_failed_durable_admission_creates_no_in_memory_job(tmp_path, monkeypatch):
    storage = store(tmp_path, monkeypatch)
    with patch.object(storage.job_journal, "admit", side_effect=OSError("fixture disk failure")):
        with pytest.raises(OSError):
            storage.new_job("text-to-audio", {})
    assert storage.jobs == {}


def test_http_lost_ack_retry_uses_retained_job_and_rechecks_source(tmp_path, monkeypatch):
    from server.main import app
    from server.routes import jobs

    storage = store(tmp_path, monkeypatch)
    runner = JobRunner(Settings(), storage)
    body = {
        "mode": "text-to-audio",
        "request_id": "http-retry",
        "request": {"provider": "mock", "model": "mock-sine"},
    }
    calls = []

    def work(request, *, job_id, mode, method_name, cancel_event):
        calls.append(job_id)
        storage.update_job(job_id, status="error", error="fixture terminal")

    with (
        patch.object(jobs, "storage", storage),
        patch.object(jobs, "job_runner", runner),
        patch.object(jobs, "run_provider_method_with_existing_job", work),
    ):
        client = TestClient(app)
        first = client.post("/jobs/submit", json=body)
        assert first.status_code == 200
        assert runner.wait_for_settlement(2)
        second = client.post("/jobs/submit", json=body)
        assert second.status_code == 200 and second.json()["job_id"] == first.json()["job_id"]
        assert calls == [first.json()["job_id"]]
        assert client.get(second.json()["status_url"]).status_code == 200
        assert client.get(second.json()["status_url"] + "/receipt").status_code == 200
        conflict = client.post(
            "/jobs/submit", json={**body, "request": {**body["request"], "seed": 5}}
        )
        assert conflict.status_code == 409
    runner.shutdown(wait=True)


@pytest.mark.parametrize("state", ["created", "admitted", "running", "cancellation_requested"])
def test_real_process_death_recovers_durable_admission(tmp_path, state):
    script = """from server.config import Settings
from server.storage import StorageManager
import os
s=StorageManager(Settings())
j=s.new_job('text-to-audio',{'provider':'mock'},status='queued')
s.update_job(j,metrics={'execution_state':os.environ['RECOVERY_FIXTURE_STATE']})
print(j,flush=True)
os._exit(23)
"""
    env = {
        **os.environ,
        "GERM_OUTPUT_DIR": str(tmp_path),
        "RECOVERY_FIXTURE_STATE": state,
        "PYTHONPATH": str(Path(__file__).parents[1]),
        "PYTHONDONTWRITEBYTECODE": "1",
    }
    result = subprocess.run(
        [sys.executable, "-c", script], env=env, capture_output=True, text=True, timeout=10
    )
    assert result.returncode == 23
    identifier = result.stdout.strip()
    journal = JobJournal(tmp_path)
    rows = journal.reconcile("2026-10-08T00:00:00Z")
    assert rows[0]["job_id"] == identifier and rows[0]["metrics"]["automatic_replay"] is False


def test_terminal_legacy_receipt_remains_readable_without_replay(tmp_path, monkeypatch):
    storage = store(tmp_path, monkeypatch)
    identifier = "legacy-terminal"
    path = storage.job_receipt_path(identifier)
    path.parent.mkdir()
    path.write_text(
        json.dumps(
            {
                "contract": "germ/job-lifecycle/v0.1",
                "job_id": identifier,
                "status": "done",
                "mode": "text-to-audio",
                "created_at": "2026-10-08T00:00:00Z",
                "recorded_at": "2026-10-08T00:00:01Z",
                "memory_conditioning": {},
                "audio_files": [],
            }
        )
    )
    assert storage.get_job(identifier).metrics["legacy_terminal_receipt"]
    assert storage.job_journal.get(identifier) is None


def test_public_request_identity_matches_lookup_bounds():
    from pydantic import ValidationError
    from server.schemas import JobSubmitRequest

    body = dict(mode="text-to-audio", request={"provider": "mock"})
    assert JobSubmitRequest(**body, request_id="a" * 100).request_id == "a" * 100
    for invalid in ("a" * 101, "colon:identity", "dot.identity", ""):
        with pytest.raises(ValidationError):
            JobSubmitRequest(**body, request_id=invalid)


def test_failed_settlement_write_does_not_leak_runner_capacity(tmp_path, monkeypatch):
    import threading

    storage = store(tmp_path, monkeypatch)
    runner = JobRunner(Settings(), storage)
    job = storage.new_job("text-to-audio", {})
    entered, release = threading.Event(), threading.Event()

    def work(cancel_event):
        entered.set()
        release.wait(2)

    runner.submit(job, work)
    assert entered.wait(1)
    with patch.object(storage, "update_job", side_effect=OSError("fixture disk failure")):
        release.set()
        assert runner.wait_for_settlement(2)
    assert runner.status()["outstanding"] == 0
    assert runner.status()["settlement_recording_failures"] == 1
    runner.shutdown(wait=True)
