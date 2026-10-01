"""Bounded admission, settled cancellation and real MLX process teardown."""

from concurrent.futures import ThreadPoolExecutor
from threading import Event
from types import SimpleNamespace
from time import monotonic
from pathlib import Path
import json
import os
import sys
from unittest.mock import patch

import pytest
from fastapi import HTTPException
from fastapi.testclient import TestClient
from akousma import AkousmataStore
from server.job_runner import JobRunner, JobQueueFullError
from server.registry import storage, registry, job_runner
from server.routes._utils import run_provider_method, run_provider_method_with_existing_job
from server.schemas import GenerateRequest, GenerationResult
from server.main import app
from server.derivation import build
from test_derivation import request as derivation_request


def until(predicate):
    deadline = monotonic() + 3
    while not predicate():
        if monotonic() >= deadline:
            raise AssertionError("worker did not settle")
        Event().wait(0.01)


@pytest.fixture
def runner():
    instance = JobRunner(SimpleNamespace(job_workers=1), storage)
    yield instance
    instance.shutdown(wait=True)


def job():
    return storage.new_job(
        "text-to-audio", {"provider": "mock", "model": "mock-sine"}, status="queued"
    )


def test_capacity_cancelled_queue_slot_and_shutdown(runner):
    release, started = Event(), Event()

    def blocked(cancel_event):
        started.set()
        release.wait(3)

    ids = [job() for _ in range(8)]
    try:
        runner.submit(ids[0], blocked)
        assert started.wait(1)
        for identifier in ids[1:]:
            runner.submit(identifier, lambda cancel_event: None)
        with pytest.raises(JobQueueFullError):
            runner.submit(job(), blocked)
        with patch("server.registry.job_runner", runner):
            with pytest.raises(HTTPException) as exc:
                run_provider_method(GenerateRequest(), "text-to-audio", "generate")
            assert exc.value.status_code == 429
        assert runner.cancel(ids[1])["cancelled"]
        runner.submit(job(), lambda cancel_event: None)
        runner.shutdown(wait=False)
        assert runner.status()["accepting"] is False
        assert not runner.wait_for_settlement(0.01)
        with pytest.raises(RuntimeError):
            runner.submit(job(), blocked)
        with pytest.raises(RuntimeError, match="not settled"):
            runner.startup()
    finally:
        release.set()
        runner.shutdown(wait=True)
    assert runner.status()["outstanding"] == 0
    assert runner.wait_for_settlement(0.01)
    runner.startup()
    runner.submit(job(), lambda cancel_event: None).result(timeout=1)


def test_late_provider_cannot_revive_cancelled_job(runner):
    started, release = Event(), Event()
    identifier = job()

    def late(request):
        started.set()
        release.wait(3)
        result = GenerationResult(job_id=request.job_id, status="done", mode="text-to-audio")
        storage.record_result(result)
        return result

    with patch.object(registry.get("mock"), "generate", late):
        future = runner.submit(
            identifier,
            run_provider_method_with_existing_job,
            GenerateRequest(),
            job_id=identifier,
            mode="text-to-audio",
            method_name="generate",
        )
        try:
            assert started.wait(1)
            assert runner.cancel(identifier)["cancelled"]
            assert (
                storage.get_job(identifier).metrics["execution_state"] == "cancellation_requested"
            )
            assert runner.status()["outstanding"] == 1
        finally:
            release.set()
        assert future.result(timeout=2).status == "cancelled"
    until(lambda: runner.status()["outstanding"] == 0)
    retained = storage.get_job(identifier)
    assert retained.status == "cancelled"
    assert retained.metrics["execution_state"] == "settled"
    assert retained.metrics["late_provider_status"] == "done"


def test_completed_result_wins_late_cancel_and_escaped_failure_settles(runner):
    identifier = job()
    storage.record_result(GenerationResult(job_id=identifier, status="done"))
    assert not storage.request_job_cancellation(identifier)
    bad = job()

    def fail(cancel_event):
        raise RuntimeError("escaped worker failure")

    future = runner.submit(bad, fail)
    with pytest.raises(RuntimeError):
        future.result(timeout=1)
    until(lambda: runner.status()["outstanding"] == 0)
    assert storage.get_job(bad).status == "error"
    assert storage.get_job(bad).metrics["execution_state"] == "settled"


def test_queued_derivation_rechecks_sources_before_provider(runner, tmp_path, monkeypatch):
    monkeypatch.setenv("AKOUSMATA_PATH", str(tmp_path))
    record = json.loads((Path(__file__).parent / "fixtures/derivation-source.json").read_text())
    with AkousmataStore(tmp_path) as store:
        store.put(record)
        plan = build(store, derivation_request([record]))
        release, started = Event(), Event()

        def blocked(cancel_event):
            started.set()
            release.wait(3)

        runner.submit(job(), blocked)
        assert started.wait(1)
        request = GenerateRequest(**plan["generation_fields"])
        identifier = job()
        with patch.object(registry.get("mock"), "generate") as provider:
            future = runner.submit(
                identifier,
                run_provider_method_with_existing_job,
                request,
                job_id=identifier,
                mode="text-to-audio",
                method_name="generate",
            )
            try:
                record["provenance"]["consent_status"] = "restricted"
                store.put(record)
            finally:
                release.set()
            assert future.result(timeout=2).status == "error"
            provider.assert_not_called()


def test_app_lifecycle_closes_admission_and_can_restart():
    with TestClient(app) as client:
        assert client.get("/jobs/status").json()["accepting"]
    assert not job_runner.status()["accepting"]
    with TestClient(app) as client:
        assert client.get("/jobs/status").json()["accepting"]


def test_mlx_existing_process_group_cancellation(tmp_path, monkeypatch):
    provider = registry.get("stable_audio_mlx")
    monkeypatch.setattr(provider, "mlx_dir", lambda: tmp_path)
    identifier = job()
    cancelled = Event()
    provider.register_cancel_event(identifier, cancelled)
    marker = tmp_path / "started"
    code = (
        "import os,time; from pathlib import Path; Path("
        + repr(str(marker))
        + ").write_text(str(os.getpid())); time.sleep(30)"
    )
    try:
        with ThreadPoolExecutor(max_workers=1) as executor:
            future = executor.submit(
                provider._run_process, [sys.executable, "-c", code], job_id=identifier
            )
            try:
                until(marker.exists)
            finally:
                cancelled.set()
            result = future.result(timeout=5)
        assert result["cancelled"]
        with pytest.raises(ProcessLookupError):
            os.kill(int(marker.read_text()), 0)
    finally:
        provider.clear_cancel_event(identifier)


def test_cancelled_receipt_survives_runtime_job_eviction(runner):
    release, started = Event(), Event()

    def blocked(cancel_event):
        started.set()
        release.wait(3)

    first = job()
    runner.submit(first, blocked)
    assert started.wait(1)
    cancelled = job()
    try:
        runner.submit(cancelled, lambda cancel_event: None)
        assert runner.cancel(cancelled)["cancelled"]
        retained = storage.get_job(cancelled)
        path = storage.resolve_path(retained.metrics["lifecycle_receipt"])
        receipt = json.loads(path.read_text())
        assert receipt["status"] == "cancelled"
        assert receipt["metrics"]["execution_state"] == "settled"
        assert receipt["audio_files"] == [] and "request" not in receipt
        storage.jobs.pop(cancelled)
        assert json.loads(path.read_text())["job_id"] == cancelled
        with TestClient(app) as client:
            assert client.get(f"/jobs/{cancelled}/receipt").json()["status"] == "cancelled"
    finally:
        release.set()


def test_derivation_policy_rechecked_at_worker_admission(tmp_path, monkeypatch):
    from server.generation_workflow import admit_derivation

    monkeypatch.setenv("AKOUSMATA_PATH", str(tmp_path))
    record = json.loads((Path(__file__).parent / "fixtures/derivation-source.json").read_text())
    with AkousmataStore(tmp_path) as store:
        store.put(record)
        plan = build(store, derivation_request([record]))
    request = GenerateRequest(**plan["generation_fields"])
    request.duration = 100
    with pytest.raises(ValueError, match="exceeds"):
        admit_derivation(request)
    request.duration = 2
    request.parent_akousma_ids = []
    with pytest.raises(ValueError, match="parents"):
        admit_derivation(request)


def test_mlx_existing_timeout_stops_process(tmp_path, monkeypatch):
    provider = registry.get("stable_audio_mlx")
    monkeypatch.setattr(provider, "mlx_dir", lambda: tmp_path)
    monkeypatch.setattr(provider.settings, "provider_timeout_seconds", 0.1)
    marker = tmp_path / "started"
    code = (
        "import os,time; from pathlib import Path; Path("
        + repr(str(marker))
        + ").write_text(str(os.getpid())); time.sleep(30)"
    )
    result = provider._run_process([sys.executable, "-c", code])
    assert not result["cancelled"] and "timed out" in result["error"]
    with pytest.raises(ProcessLookupError):
        os.kill(int(marker.read_text()), 0)


def test_cancel_before_metadata_prevents_completed_companions(tmp_path, monkeypatch):
    from server.audio_io import write_sine_wav

    monkeypatch.setenv("AKOUSMATA_PATH", str(tmp_path))
    identifier = job()
    storage.request_job_cancellation(identifier)
    audio = storage.audio_dir / "cancel-boundary.wav"
    write_sine_wav(audio, duration=0.1)
    metadata = storage.write_metadata(
        metadata_path=storage.metadata_dir / "cancel-boundary.json",
        request=GenerateRequest(job_id=identifier, remember_to_akousmata=True),
        mode="text-to-audio",
        provider="mock",
        model="mock-sine",
        seed=42,
        output_audio_path=audio,
        sample_rate=44100,
        status="done",
    )
    assert metadata["status"] == "cancelled"
    assert metadata["masa"]["status"] == "not_recorded"
    assert metadata["akousmata"]["status"] == "not_recorded"
    assert metadata["generation_lifecycle"]["job_status_at_write"] == "cancelled"
    assert audio.is_file()
