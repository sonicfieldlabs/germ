import json
import wave
from hashlib import sha256

import pytest
from server.registry import storage
from server.routes._utils import run_provider_method
from server.schemas import GenerateRequest
from server.audio_io import write_sine_wav


def run(model, parameters=None, **kw):
    return run_provider_method(
        GenerateRequest(
            provider="synthesis",
            model=model,
            prompt="Explicit synthetic test",
            duration=kw.pop("duration", 0.1),
            seed=42,
            source={"synthesis": parameters or {}},
            **kw,
        ),
        "text-to-audio",
        "generate",
    )


@pytest.mark.parametrize(
    "model", ["additive", "physical-string", "sample", "granular", "wavetable"]
)
def test_real_pcm_repeatability_and_receipts(model, monkeypatch, tmp_path):
    monkeypatch.setenv("AKOUSMATA_PATH", str(tmp_path / "store"))
    p, duration = {}, 0.1
    if model in {"sample", "granular"}:
        path = storage.settings.output_root / "synthesis-test.wav"
        write_sine_wav(
            path, duration=0.6, sample_rate=16000, channels=2, frequency=440, amplitude=0.2
        )
        p = dict(input_audio_path=str(path), source_sha256=sha256(path.read_bytes()).hexdigest())
        if model == "granular":
            duration = 0.6
            p["parameters"] = {
                "grain": {"durationMs": {"min": 30, "max": 30}, "envelope": "gaussian"},
                "emission": {"mode": "synchronous", "grainsPerSecond": 40},
                "selection": {"order": "random"},
            }
    if model == "wavetable":
        from server import wavetable
        from server.processing_adapter import digest
        from server.schemas import WavetableConvertRequest

        path = storage.settings.output_root / "wavetable-source.wav"
        write_sine_wav(
            path, duration=0.6, sample_rate=16000, channels=1, frequency=440, amplitude=0.2
        )
        metadata = wavetable.convert_audio_to_wavetable(
            WavetableConvertRequest(input_audio_path=str(path), frame_count=2, frame_size=512)
        )
        table = wavetable.load_wavetable(metadata["id"])
        p = dict(
            wavetable_id=metadata["id"],
            table_sha256=digest({k: table[k] for k in ("metadata", "frames")}),
        )
    outputs = [
        run(model, p, duration=duration, masa_contracts=["masa/0.2.0"], remember_to_akousmata=True)
        for _ in range(2)
    ]
    for result in outputs:
        assert result.status == "done", result
        metadata = json.loads(storage.resolve_path(result.metadata_files[0]).read_text())
        assert metadata["synthesis"]["engine_sha256"]
        assert metadata["masa"]["status"] == "written"
        sidecar = json.loads(storage.resolve_path(metadata["masa"]["sidecar_path"]).read_text())
        assert (
            sidecar["history"]["events"][-1]["extensions"]["germ:synthesis"]
            == metadata["synthesis"]
        )
        import os
        from pathlib import Path
        from server.processing_adapter import validate

        if os.environ.get("GERM_TEST_MASA_VALIDATOR"):
            validate("record", sidecar, Path(os.environ["GERM_TEST_MASA_VALIDATOR"]), tmp_path)
        receipt = storage.read_job_receipt(result.job_id)
        assert receipt["status"] == "done"
        with wave.open(str(storage.resolve_path(result.audio_files[0]))) as wav:
            assert wav.getnframes() == int(duration * result.sample_rate)
            assert any(wav.readframes(wav.getnframes()))
    assert (
        storage.resolve_path(outputs[0].audio_files[0]).read_bytes()
        == storage.resolve_path(outputs[1].audio_files[0]).read_bytes()
    )


@pytest.mark.parametrize(
    "model,p,kw",
    [
        ("additive", {"frequency": 4000, "partials": [1] * 32}, {}),
        ("additive", {"decay": 0.9}, {}),
        ("physical-string", {"decay": 1}, {}),
        ("sample", {"input_audio_path": "/etc/passwd", "source_sha256": "0" * 64}, {}),
        ("additive", {}, {"duration": 31}),
        ("additive", {}, {"batch_size": 2}),
    ],
)
def test_refusal(model, p, kw):
    result = run(model, p, **kw)
    assert result.status == "error"
    assert not result.audio_files


def test_active_cancellation(monkeypatch):
    from server.registry import registry

    provider = registry.get("synthesis")
    calls = []

    def cancelled(_):
        calls.append(1)
        return len(calls) > 2

    monkeypatch.setattr(provider, "is_job_cancelled", cancelled)
    result = run("additive", {"partials": [1] * 16}, duration=2)
    assert result.status == "cancelled"
    assert not result.audio_files


def test_sample_change_and_wrong_hash_refused(monkeypatch):
    from server.registry import registry

    path = storage.settings.output_root / "changing-sample.wav"
    write_sine_wav(path, duration=0.2, sample_rate=44100, frequency=440, amplitude=0.2, channels=1)
    p = dict(input_audio_path=str(path), source_sha256=sha256(path.read_bytes()).hexdigest())
    assert run("sample", {**p, "source_sha256": "0" * 64}).status == "error"

    def change(_):
        path.write_bytes(b"changed by another local process")
        return False

    monkeypatch.setattr(registry.get("synthesis"), "is_job_cancelled", change)
    result = run("sample", p)
    assert result.status == "error"
    assert not result.audio_files
