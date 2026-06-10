from __future__ import annotations

import base64
import io
import json
import math
import socket
import struct
import time
import wave
from datetime import datetime, timedelta, timezone
from pathlib import Path
from threading import Event

import pytest
from fastapi.testclient import TestClient

from server.audio_io import write_sine_wav
from server.main import app
from server.providers.stable_audio_mlx_provider import StableAudioMLXProvider
from server.providers.stable_audio_python_provider import StableAudioPythonProvider
from server.registry import control_registry, registry, settings, storage, strain_registry
from server.routes import audio_tools
from server.routes import micro as micro_routes
from server.routes.time_render import time_clock_summary
from server.schemas import GenerationResult, GenerateRequest, InpaintRequest, TimeClock, TimeRenderRequest
from server.storage import JOB_EVICTION_GRACE_SECONDS, MAX_TRACKED_JOBS


client = TestClient(app)


@pytest.fixture(autouse=True)
def restore_control_state_for_control_tests(request: pytest.FixtureRequest):
    if not request.node.name.startswith("test_control_"):
        yield
        return

    control_dir = settings.output_root / "control"
    control_dir.mkdir(parents=True, exist_ok=True)
    state_paths = [
        control_registry.events_path,
        control_registry.routes_path,
        control_registry.cv_profiles_path,
    ]
    original_state = {
        path: path.read_text(encoding="utf-8") if path.exists() else None
        for path in state_paths
    }
    original_events = control_registry.events()
    existing_files = set(control_dir.iterdir())

    yield

    for path in control_dir.iterdir():
        if path in existing_files or not path.name.startswith("pytest_"):
            continue
        path.unlink()
    for path, content in original_state.items():
        if content is None:
            if path.exists():
                path.unlink()
        else:
            path.write_text(content, encoding="utf-8")
    with control_registry._lock:
        control_registry._events.clear()
        control_registry._events.extend(original_events)


@pytest.fixture(autouse=True)
def restore_strain_and_micro_state(request: pytest.FixtureRequest):
    if not (
        request.node.name.startswith("test_strain_")
        or request.node.name.startswith("test_micro_")
    ):
        yield
        return

    strain_registry.strain_dir.mkdir(parents=True, exist_ok=True)
    micro_dir = settings.output_root / "micro"
    micro_dir.mkdir(parents=True, exist_ok=True)
    strain_content = (
        strain_registry.registry_path.read_text(encoding="utf-8")
        if strain_registry.registry_path.exists()
        else None
    )
    existing_micro_files = set(micro_dir.iterdir())

    yield

    for path in micro_dir.iterdir():
        if path in existing_micro_files or not path.name.startswith("pytest_"):
            continue
        path.unlink()
    if strain_content is None:
        if strain_registry.registry_path.exists():
            strain_registry.registry_path.unlink()
    else:
        strain_registry.registry_path.write_text(strain_content, encoding="utf-8")


def poll_job(status_url: str, timeout: float = 5.0) -> dict:
    deadline = time.monotonic() + timeout
    last: dict = {}
    while time.monotonic() < deadline:
        response = client.get(status_url)
        assert response.status_code == 200
        last = response.json()
        if last["status"] in {"done", "error", "cancelled"}:
            return last
        time.sleep(0.02)
    raise AssertionError(f"job did not finish before timeout: {last}")


def write_wavetable_stack(path: Path, *, frame_size: int = 512, frame_count: int = 4) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with wave.open(str(path), "wb") as wav:
        wav.setnchannels(1)
        wav.setsampwidth(2)
        wav.setframerate(44100)
        frames = bytearray()
        for frame_index in range(frame_count):
            harmonic = frame_index + 1
            for sample_index in range(frame_size):
                phase = (sample_index / frame_size) * harmonic * 2.0 * math.pi
                frames.extend(struct.pack("<h", int(18000 * math.sin(phase))))
        wav.writeframes(bytes(frames))


def test_health_returns_ok() -> None:
    response = client.get("/health")
    assert response.status_code == 200
    assert "x-process-time-ms" in response.headers
    body = response.json()
    assert body["status"] == "ok"
    assert body["server"] == "germ"


def test_models_returns_providers() -> None:
    response = client.get("/models")
    assert response.status_code == 200
    providers = {item["id"]: item for item in response.json()["providers"]}
    assert "mock" in providers
    assert "stable_audio_python" in providers
    assert "stable_audio_mlx" in providers
    assert "stability_api" in providers
    assert providers["mock"]["available"] is True


def test_diagnostics_reports_local_readiness() -> None:
    response = client.get("/diagnostics")
    assert response.status_code == 200
    body = response.json()
    assert "dependencies" in body
    assert "audio_processing" in body
    assert "providers" in body
    assert "install_commands" in body
    assert "rubberband_available" in body["audio_processing"]
    assert body["recommended_local_provider"] in {"stable_audio_mlx", "stable_audio_python"}


def test_performance_endpoint_reports_recent_requests() -> None:
    client.get("/health")
    response = client.get("/performance")
    assert response.status_code == 200
    body = response.json()
    assert body["count"] >= 1
    assert "summary" in body


def test_control_ports_and_routes_round_trip() -> None:
    ports_response = client.get("/control/ports")
    assert ports_response.status_code == 200
    ports = {item["id"]: item for item in ports_response.json()["ports"]}
    assert ports["mod:audio_to_control"]["kind"] == "control"
    assert ports["generation:seed_drift"]["direction"] == "input"
    assert ports["cv:export"]["metadata"]["hardware_output"] is False

    route_response = client.post(
        "/control/routes",
        json={
            "source_port_id": "mod:audio_to_control",
            "target_port_id": "generation:seed_drift",
            "source_kind": "control",
            "target_kind": "control",
            "label": "pytest audio control to seed drift",
            "transform": {"amount": 0.5, "smoothing_ms": 20},
        },
    )
    assert route_response.status_code == 200
    route = route_response.json()
    assert route["id"].startswith("route_")
    assert route["enabled"] is True
    assert route["lineage_role"] == "control-parent"

    disable_response = client.post(f"/control/routes/{route['id']}/enable", json={"enabled": False})
    assert disable_response.status_code == 200
    assert disable_response.json()["enabled"] is False
    delete_response = client.delete(f"/control/routes/{route['id']}")
    assert delete_response.status_code == 200

    rejected_response = client.post(
        "/control/routes",
        json={
            "source_port_id": "midi:input",
            "target_port_id": "app:arbitrary",
            "source_kind": "midi",
            "target_kind": "control",
        },
    )
    assert rejected_response.status_code == 422


def test_control_audio_analysis_and_cv_safe_render() -> None:
    audio_path = settings.audio_dir / "pytest_control_source.wav"
    write_sine_wav(audio_path, duration=0.2, amplitude=0.2)

    analysis_response = client.post(
        "/control/analyze-audio",
        json={
            "input_audio_path": storage.relative_path(audio_path),
            "features": [
                "envelope",
                "rms",
                "transient",
                "spectral_centroid",
                "pitch",
                "chroma",
                "onset_density",
                "tempo",
                "timbre",
            ],
            "window_ms": 20,
            "hop_ms": 10,
            "output_name": "pytest_control_analysis",
        },
    )
    assert analysis_response.status_code == 200
    analysis = analysis_response.json()
    assert analysis["status"] == "done"
    assert len(analysis["control_files"]) == 1
    control_path = Path(analysis["control_files"][0])
    assert control_path.exists()
    control_data = json.loads(control_path.read_text(encoding="utf-8"))
    assert control_data["type"] == "control_analysis"
    assert "envelope" in control_data["features"]
    assert "pitch" in control_data["features"]
    assert "timbre" in control_data["features"]
    assert control_data["lineage"]["operation"] == "control_analysis"

    cv_response = client.post(
        "/control/render-cv",
        json={
            "input_control_path": analysis["control_files"][0],
            "feature": "envelope",
            "duration": 0.2,
            "output_name": "pytest_cv_export",
            "mode": "cv",
            "range": "unipolar",
            "scale": 0.5,
            "slew_ms": 1,
        },
    )
    assert cv_response.status_code == 200
    cv = cv_response.json()
    assert cv["status"] == "done"
    assert cv["cv_safe"] is True
    assert cv["hardware_output"] is False
    assert Path(cv["audio_file"]).exists()
    assert Path(cv["metadata_file"]).exists()


def test_control_bridges_profiles_events_and_graph() -> None:
    event_response = client.post(
        "/control/events",
        json={"kind": "metadata", "source": "pytest", "value": {"action": "persist"}},
    )
    assert event_response.status_code == 200
    assert (settings.output_root / "control" / "events.json").exists()

    with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as udp:
        udp.bind(("127.0.0.1", 0))
        udp.settimeout(1.0)
        port = udp.getsockname()[1]
        osc_response = client.post(
            "/control/osc/send",
            json={
                "host": "127.0.0.1",
                "port": port,
                "address": "/germinator/pytest",
                "values": [0.75],
            },
        )
        assert osc_response.status_code == 200
        assert osc_response.json()["sent"] is True
        packet, _ = udp.recvfrom(1024)
        assert b"/germinator/pytest" in packet

    osc_receive = client.post(
        "/control/osc/receive",
        json={"address": "/germinator/in", "values": [1]},
    )
    assert osc_receive.status_code == 200
    assert osc_receive.json()["status"] == "recorded"

    midi_response = client.post(
        "/control/midi/send",
        json={"backend": "event", "type": "cc", "channel": 1, "cc": 11, "value": 64},
    )
    assert midi_response.status_code == 200
    assert midi_response.json()["status"] == "recorded"

    profile_response = client.post(
        "/control/cv/profiles",
        json={
            "name": "pytest cv output",
            "output_channel": 1,
            "calibrated": False,
            "speaker_protection": True,
        },
    )
    assert profile_response.status_code == 200
    profile_id = profile_response.json()["id"]
    arm_rejected = client.post(
        f"/control/cv/profiles/{profile_id}/arm",
        json={"armed": True, "confirm": True},
    )
    assert arm_rejected.status_code == 422

    calibrated_response = client.post(
        "/control/cv/profiles",
        json={
            "name": "pytest calibrated cv output",
            "output_channel": 2,
            "calibrated": True,
            "speaker_protection": True,
        },
    )
    assert calibrated_response.status_code == 200
    calibrated_id = calibrated_response.json()["id"]
    arm_response = client.post(
        f"/control/cv/profiles/{calibrated_id}/arm",
        json={"armed": True, "confirm": True},
    )
    assert arm_response.status_code == 200
    assert arm_response.json()["armed"] is True
    panic_response = client.post("/control/panic")
    assert panic_response.status_code == 200
    profiles = client.get("/control/cv/profiles").json()["profiles"]
    assert all(profile["armed"] is False for profile in profiles)

    status_response = client.get("/control/bridge/status")
    assert status_response.status_code == 200
    assert status_response.json()["cv_hardware_output"] is False

    graph_response = client.get("/control/genetic/control-graph")
    assert graph_response.status_code == 200
    assert "nodes" in graph_response.json()
    assert "edges" in graph_response.json()


def test_control_osc_send_rejects_invalid_host() -> None:
    response = client.post(
        "/control/osc/send",
        json={
            "host": "256.256.256.256",
            "port": 9000,
            "address": "/germinator/pytest",
            "values": [0.5],
        },
    )
    assert response.status_code == 422


def test_strain_registry_roundtrip_and_generation_metadata() -> None:
    save_response = client.post(
        "/strains",
        json={
            "name": "pytest dust strain",
            "path": "output/strains/pytest_dust.safetensors",
            "description": "Small noisy granular identity for tests.",
            "source_dataset": "pytest fixture",
            "license": "internal-test",
            "author": "pytest",
            "prompt_vocabulary": ["dust", "grain", "cell"],
            "recommended_modules": ["grain_culture", "microscope"],
            "tags": ["pytest", "micro"],
            "strength_min": 0.1,
            "strength_max": 1.2,
            "default_strength": 0.65,
            "provenance_notes": "created by test metadata only",
        },
    )
    assert save_response.status_code == 200
    strain = save_response.json()
    assert strain["id"].startswith("strain_")

    list_response = client.get("/strains")
    assert list_response.status_code == 200
    assert any(item["id"] == strain["id"] for item in list_response.json()["strains"])

    load_response = client.post(
        "/strains/load",
        json={"provider": "mock", "strain_ids": [strain["id"]]},
    )
    assert load_response.status_code == 200
    assert load_response.json()["status"] == "loaded"
    assert "output/strains/pytest_dust.safetensors" in load_response.json()["loaded_loras"]

    generate_response = client.post(
        "/generate",
        json={
            "provider": "mock",
            "model": "mock-sine",
            "prompt": "short dusty grain cell",
            "duration": 0.25,
            "output_name": "pytest_strain_generate",
            "lora": [
                {
                    "id": strain["id"],
                    "name": strain["name"],
                    "path": strain["path"],
                    "strength": strain["default_strength"],
                    "tags": strain["tags"],
                    "license": strain["license"],
                    "author": strain["author"],
                    "prompt_vocabulary": strain["prompt_vocabulary"],
                    "recommended_modules": strain["recommended_modules"],
                    "provenance_notes": strain["provenance_notes"],
                }
            ],
        },
    )
    assert generate_response.status_code == 200
    metadata = json.loads(Path(generate_response.json()["metadata_files"][0]).read_text(encoding="utf-8"))
    assert metadata["lora_strains"][0]["id"] == strain["id"]
    assert metadata["lora_strains"][0]["name"] == "pytest dust strain"
    assert metadata["lora_strains"][0]["prompt_vocabulary"] == ["dust", "grain", "cell"]
    assert metadata["strain_stack"] == metadata["lora_strains"]


def test_strain_get_delete_and_direct_lora_routes() -> None:
    save_response = client.post(
        "/strains",
        json={
            "name": "pytest disposable strain",
            "path": "output/strains/pytest_disposable.safetensors",
            "tags": ["pytest"],
        },
    )
    assert save_response.status_code == 200
    strain = save_response.json()

    get_response = client.get(f"/strains/{strain['id']}")
    assert get_response.status_code == 200
    assert get_response.json()["id"] == strain["id"]

    lora_load = client.post(
        "/lora/load",
        json={"provider": "mock", "paths": ["output/strains/pytest_direct.safetensors"]},
    )
    assert lora_load.status_code == 200
    assert lora_load.json()["status"] == "loaded"
    assert "output/strains/pytest_direct.safetensors" in lora_load.json()["loaded_loras"]

    lora_strength = client.post(
        "/lora/strength",
        json={"provider": "mock", "strength": 0.42, "lora_index": 0},
    )
    assert lora_strength.status_code == 200
    assert lora_strength.json()["status"] == "set"
    assert lora_strength.json()["strength"] == 0.42

    delete_response = client.delete(f"/strains/{strain['id']}")
    assert delete_response.status_code == 200
    assert delete_response.json()["status"] == "deleted"

    missing_response = client.get(f"/strains/{strain['id']}")
    assert missing_response.status_code == 404


def test_micro_matter_profile_and_graph_links() -> None:
    strain_response = client.post(
        "/strains",
        json={
            "name": "pytest graph strain",
            "path": "output/strains/pytest_graph.safetensors",
            "recommended_modules": ["spectral_tissue"],
            "default_strength": 0.7,
        },
    )
    assert strain_response.status_code == 200
    strain = strain_response.json()
    semantic_effect = {
        "id": "node_micro_pytest:semantic",
        "module_id": "node_micro_pytest",
        "fx_type": "grain_culture",
        "amount": 0.8,
        "prompt_layer": "granular cloud, dense cells",
    }
    generate_response = client.post(
        "/generate",
        json={
            "provider": "mock",
            "model": "mock-sine",
            "prompt": "short graph granular test",
            "duration": 0.25,
            "output_name": "pytest_micro_graph",
            "semantic_effects": [semantic_effect],
            "lora": [
                {
                    "id": strain["id"],
                    "name": strain["name"],
                    "path": strain["path"],
                    "strength": 0.7,
                    "recommended_modules": strain["recommended_modules"],
                }
            ],
        },
    )
    assert generate_response.status_code == 200
    generated = generate_response.json()
    metadata_path = Path(generated["metadata_files"][0])
    metadata = json.loads(metadata_path.read_text(encoding="utf-8"))

    profile_response = client.post(
        "/micro/matter-profile",
        json={
            "input_audio_path": generated["audio_files"][0],
            "metadata_path": generated["metadata_files"][0],
            "source_id": metadata["sound_id"],
            "module": "microscope",
            "window_ms": 20,
            "hop_ms": 10,
            "output_name": "pytest_micro_profile",
            "lineage": {"parents": [metadata["sound_id"]]},
        },
    )
    assert profile_response.status_code == 200
    profile = profile_response.json()
    assert profile["status"] == "done"
    assert profile["descriptors"]["cell_count"] >= 1
    profile_file = Path(profile["profile_file"])
    assert profile_file.exists()
    profile_data = json.loads(profile_file.read_text(encoding="utf-8"))
    assert profile_data["type"] == "micro_matter_profile"
    assert profile_data["lineage"]["operation"] == "micro_matter_profile"

    graph_response = client.get("/control/genetic/control-graph?limit=50")
    assert graph_response.status_code == 200
    graph = graph_response.json()
    node_types = {node["type"] for node in graph["nodes"]}
    edge_types = {edge["type"] for edge in graph["edges"]}
    assert "strain" in node_types
    assert "micro_module" in node_types
    assert "micro_profile" in node_types
    assert "strain-applied" in edge_types
    assert "micro-shape" in edge_types
    assert "micro-profiled" in edge_types


def test_micro_matter_profile_reuses_cached_analysis(monkeypatch: pytest.MonkeyPatch) -> None:
    source_path = settings.audio_dir / "pytest_micro_cache_source.wav"
    write_sine_wav(source_path, duration=0.25)
    with micro_routes._MATTER_PROFILE_ANALYSIS_CACHE_LOCK:
        micro_routes._MATTER_PROFILE_ANALYSIS_CACHE.clear()

    calls = 0
    original_analyze = micro_routes._analyze_features

    def counting_analyze(**kwargs):
        nonlocal calls
        calls += 1
        return original_analyze(**kwargs)

    monkeypatch.setattr(micro_routes, "_analyze_features", counting_analyze)
    payload = {
        "input_audio_path": storage.relative_path(source_path),
        "module": "microscope",
        "window_ms": 20,
        "hop_ms": 10,
        "output_name": "pytest_micro_cache_profile",
    }
    first = client.post("/micro/matter-profile", json=payload)
    second = client.post("/micro/matter-profile", json=payload)

    assert first.status_code == 200
    assert second.status_code == 200
    assert first.json()["descriptors"] == second.json()["descriptors"]
    assert calls == 1


def test_huggingface_status_reports_cli_auth_without_model_check() -> None:
    response = client.get("/huggingface/status?check_models=false")
    assert response.status_code == 200
    body = response.json()
    assert body["service"] == "huggingface"
    assert "auth" in body
    assert body["models_checked"] is False


def test_mock_generate_creates_wav_and_metadata() -> None:
    response = client.post(
        "/generate",
        json={
            "provider": "mock",
            "model": "mock-sine",
            "prompt": "short dry wood impact",
            "duration": 0.5,
            "output_name": "pytest_generate",
            "culture_id": "culture-pytest",
            "tags": ["SFX", "review"],
        },
    )
    assert response.status_code == 200
    body = response.json()
    assert body["status"] == "done"
    audio_path = Path(body["audio_files"][0])
    metadata_path = Path(body["metadata_files"][0])
    assert audio_path.exists()
    assert metadata_path.exists()
    metadata = json.loads(metadata_path.read_text(encoding="utf-8"))
    assert metadata["app"] == "germ"
    assert metadata["product"] == "germ"
    assert metadata["legacy_app"] == "Germinator"
    assert metadata["concept"] == "sound_matter"
    assert metadata["engine"] == "stable-audio-3"
    assert metadata["runtime"] == "mock"
    assert metadata["technical_mode"] == "text-to-audio"
    assert metadata["germinator_mode"] == "germinate"
    assert metadata["provider"] == "mock"
    assert metadata["status"] == "done"
    assert metadata["output_audio_path"] == body["audio_files"][0]
    assert metadata["culture_id"] == "culture-pytest"
    assert metadata["tags"] == ["SFX", "review"]


def test_wavetable_convert_list_detail_and_data_routes() -> None:
    source_path = settings.audio_dir / "pytest_wavetable_sine.wav"
    write_sine_wav(source_path, duration=0.35, frequency=130.8128, amplitude=0.4)

    response = client.post(
        "/wavetables/convert",
        json={
            "input_audio_path": storage.relative_path(source_path),
            "name": "pytest sine table",
            "frame_count": 8,
            "frame_size": 512,
            "root_note": "C3",
            "extraction_mode": "simple",
        },
    )

    assert response.status_code == 200
    wavetable = response.json()["wavetable"]
    assert wavetable["id"].startswith("wt_")
    assert wavetable["type"] == "germ_wavetable"
    assert wavetable["frame_count"] == 8
    assert wavetable["frame_size"] == 512
    assert wavetable["root_note"] == "C3"
    assert wavetable["operation"] == "audio_to_wavetable"
    assert Path(wavetable["metadata_path"]).exists()
    data_path = Path(wavetable["data_path"])
    assert data_path.exists()
    assert data_path.stat().st_size == 8 * 512 * 4

    list_response = client.get("/wavetables")
    assert list_response.status_code == 200
    assert any(item["id"] == wavetable["id"] for item in list_response.json())

    detail_response = client.get(f"/wavetables/{wavetable['id']}")
    assert detail_response.status_code == 200
    assert detail_response.json()["id"] == wavetable["id"]

    data_response = client.get(f"/wavetables/{wavetable['id']}/data")
    assert data_response.status_code == 200
    assert len(data_response.content) == 8 * 512 * 4


def test_wavetable_conversion_rejects_external_paths(tmp_path: Path) -> None:
    source_path = tmp_path / "external.wav"
    write_sine_wav(source_path, duration=0.1)
    response = client.post(
        "/wavetables/convert",
        json={
            "input_audio_path": str(source_path),
            "name": "external",
            "frame_count": 4,
            "frame_size": 512,
        },
    )
    assert response.status_code == 403


def test_wavetable_conversion_rejects_unsupported_frame_size() -> None:
    source_path = settings.audio_dir / "pytest_wavetable_bad_frame.wav"
    write_sine_wav(source_path, duration=0.1)
    response = client.post(
        "/wavetables/convert",
        json={
            "input_audio_path": storage.relative_path(source_path),
            "name": "bad frame",
            "frame_count": 4,
            "frame_size": 256,
        },
    )
    assert response.status_code == 422


def test_wavetable_render_creates_audio_and_metadata() -> None:
    source_path = settings.audio_dir / "pytest_wavetable_render_source.wav"
    write_sine_wav(source_path, duration=0.35, frequency=220.0, amplitude=0.35)
    convert_response = client.post(
        "/wavetables/convert",
        json={
            "input_audio_path": storage.relative_path(source_path),
            "name": "pytest render table",
            "frame_count": 6,
            "frame_size": 512,
        },
    )
    assert convert_response.status_code == 200
    wavetable = convert_response.json()["wavetable"]

    render_response = client.post(
        "/wavetables/render",
        json={
            "wavetable_id": wavetable["id"],
            "duration": 0.2,
            "root_note": "C3",
            "note": "C3",
            "scan_start": 0.0,
            "scan_end": 1.0,
            "gain": 0.5,
            "output_name": "pytest_rendered_table",
        },
    )

    assert render_response.status_code == 200
    body = render_response.json()
    audio_path = Path(body["audio_files"][0])
    metadata_path = Path(body["metadata_files"][0])
    assert audio_path.exists()
    assert metadata_path.exists()
    with wave.open(str(audio_path), "rb") as wav:
        assert wav.getnchannels() == 2
        assert wav.getframerate() == 44100
    metadata = json.loads(metadata_path.read_text(encoding="utf-8"))
    assert metadata["wavetable_id"] == wavetable["id"]
    assert metadata["lineage"]["operation"] == "wavetable-render"


def test_wavetable_import_and_exports() -> None:
    stack_path = settings.audio_dir / "pytest_wavetable_stack.wav"
    write_wavetable_stack(stack_path, frame_size=512, frame_count=4)
    import_response = client.post(
        "/wavetables/import",
        json={
            "input_audio_path": storage.relative_path(stack_path),
            "frame_size": 512,
            "name": "pytest imported stack",
        },
    )
    assert import_response.status_code == 200
    wavetable = import_response.json()["wavetable"]
    assert wavetable["frame_count"] == 4
    assert wavetable["operation"] == "import_wav_stack"

    metadata_export = client.get(f"/wavetables/{wavetable['id']}/export?format=metadata")
    assert metadata_export.status_code == 200
    assert metadata_export.json()["id"] == wavetable["id"]

    gwt_export = client.get(f"/wavetables/{wavetable['id']}/export?format=gwt")
    assert gwt_export.status_code == 200
    assert len(gwt_export.content) == 4 * 512 * 4

    stack_export = client.get(f"/wavetables/{wavetable['id']}/export?format=wav-stack")
    assert stack_export.status_code == 200
    with wave.open(io.BytesIO(stack_export.content), "rb") as wav:
        assert wav.getnchannels() == 1
        assert wav.getnframes() == 4 * 512

    single_cycle = client.get(f"/wavetables/{wavetable['id']}/export?format=single-cycle")
    assert single_cycle.status_code == 200
    with wave.open(io.BytesIO(single_cycle.content), "rb") as wav:
        assert wav.getnchannels() == 1
        assert wav.getnframes() == 512


def test_wavetable_prompt_route_wraps_prompt_and_creates_table() -> None:
    response = client.post(
        "/wavetables/prompt",
        json={
            "provider": "mock",
            "model": "mock-sine",
            "prompt": "glassy metallic vowel",
            "duration": 0.25,
            "root_note": "C3",
            "generation_mode": "glassy_metallic",
            "frame_count": 4,
            "frame_size": 512,
            "output_name": "pytest_prompt_table",
            "modulators": [{"target_path": "prompt", "final_value": "glassy metallic vowel with motion"}],
        },
    )

    assert response.status_code == 200
    body = response.json()
    wavetable = body["wavetable"]
    assert body["status"] == "done"
    assert Path(body["source_audio_files"][0]).exists()
    source_metadata = json.loads(Path(body["source_metadata_files"][0]).read_text(encoding="utf-8"))
    assert "Single sustained instrumental tone" in source_metadata["prompt"]
    assert "glassy metallic vowel" in source_metadata["prompt"]
    assert source_metadata["base_prompt"] == "glassy metallic vowel"
    assert "speech, vocals" in source_metadata["negative_prompt"]

    wavetable_metadata = json.loads(Path(wavetable["metadata_path"]).read_text(encoding="utf-8"))
    assert wavetable_metadata["operation"] == "prompt_to_wavetable"
    contract = wavetable_metadata["operation_params"]["prompt_contract"]
    assert contract["user_prompt"] == "glassy metallic vowel"
    assert "no rhythm" in contract["prompt"]
    assert wavetable_metadata["operation_params"]["modulators"][0]["target_path"] == "prompt"


def test_wavetable_mutation_creates_child_lineage() -> None:
    source_path = settings.audio_dir / "pytest_wavetable_parent.wav"
    write_sine_wav(source_path, duration=0.35, frequency=220.0, amplitude=0.35)
    parent_response = client.post(
        "/wavetables/convert",
        json={
            "input_audio_path": storage.relative_path(source_path),
            "name": "pytest parent table",
            "frame_count": 4,
            "frame_size": 512,
        },
    )
    assert parent_response.status_code == 200
    parent = parent_response.json()["wavetable"]

    mutation_response = client.post(
        "/wavetables/mutate",
        json={
            "wavetable_id": parent["id"],
            "provider": "mock",
            "model": "mock-sine",
            "prompt": "more brittle glass harmonics",
            "init_noise_level": 0.42,
            "render_duration": 0.2,
            "root_note": "C3",
            "frame_count": 4,
            "frame_size": 512,
            "modulators": [{"target_path": "mutationDepth", "final_value": 0.42}],
        },
    )

    assert mutation_response.status_code == 200
    body = mutation_response.json()
    child = body["wavetable"]
    assert child["id"] != parent["id"]
    assert Path(body["source_audio_files"][0]).exists()
    assert Path(body["audio_files"][0]).exists()

    child_metadata = json.loads(Path(child["metadata_path"]).read_text(encoding="utf-8"))
    assert child_metadata["operation"] == "wavetable_mutation"
    assert child_metadata["parent_wavetable_id"] == parent["id"]
    assert child_metadata["render_audio_id"]
    assert child_metadata["child_wavetable_id"] == child["id"]
    params = child_metadata["operation_params"]
    assert params["stable_audio_mode"] == "audio-to-audio"
    assert params["init_noise_level"] == 0.42
    assert params["prompt"] == "more brittle glass harmonics"
    assert params["child_wavetable_id"] == child["id"]
    assert params["modulators"][0]["target_path"] == "mutationDepth"

    parent_metadata = client.get(f"/wavetables/{parent['id']}").json()
    assert child["id"] in parent_metadata["children"]


def test_wavetable_variation_count_is_capped() -> None:
    response = client.post(
        "/wavetables/prompt",
        json={
            "provider": "mock",
            "model": "mock-sine",
            "prompt": "too many variations",
            "variation_count": 17,
        },
    )
    assert response.status_code == 422


def test_wavetable_quality_warnings_for_low_signal_prompt() -> None:
    response = client.post(
        "/wavetables/prompt",
        json={
            "provider": "mock",
            "model": "mock-silence",
            "prompt": "silent oscillator test",
            "duration": 0.2,
            "frame_count": 4,
            "frame_size": 512,
        },
    )
    assert response.status_code == 200
    wavetable = response.json()["wavetable"]
    assert "low_signal" in wavetable["warnings"]
    assert wavetable["table_classification"] == "glitch"


def test_library_lists_wavetable_assets_without_breaking_audio_items() -> None:
    audio_path = settings.audio_dir / "pytest_library_asset_audio.wav"
    write_sine_wav(audio_path, duration=0.25)
    convert_response = client.post(
        "/wavetables/convert",
        json={
            "input_audio_path": storage.relative_path(audio_path),
            "name": "pytest library table asset",
            "frame_count": 4,
            "frame_size": 512,
        },
    )
    assert convert_response.status_code == 200
    wavetable = convert_response.json()["wavetable"]

    response = client.get("/library?limit=0")
    assert response.status_code == 200
    items = response.json()["items"]
    table_items = [item for item in items if item.get("asset_type") == "wavetable"]
    audio_items = [item for item in items if item.get("audio_file") == storage.relative_path(audio_path)]
    assert any(item["wavetable_id"] == wavetable["id"] for item in table_items)
    assert audio_items
    assert all(item.get("asset_type") == "audio" for item in audio_items)


def test_wavetable_control_graph_includes_lineage_edges() -> None:
    prompt_response = client.post(
        "/wavetables/prompt",
        json={
            "provider": "mock",
            "model": "mock-sine",
            "prompt": "graph glass wavetable",
            "duration": 0.2,
            "frame_count": 4,
            "frame_size": 512,
            "output_name": "pytest_graph_table",
        },
    )
    assert prompt_response.status_code == 200
    parent = prompt_response.json()["wavetable"]

    render_response = client.post(
        "/wavetables/render",
        json={
            "wavetable_id": parent["id"],
            "duration": 0.2,
            "root_note": "C3",
            "note": "C3",
            "output_name": "pytest_graph_table_render",
        },
    )
    assert render_response.status_code == 200

    mutation_response = client.post(
        "/wavetables/mutate",
        json={
            "wavetable_id": parent["id"],
            "provider": "mock",
            "model": "mock-sine",
            "prompt": "graph child harmonics",
            "render_duration": 0.2,
            "frame_count": 4,
            "frame_size": 512,
        },
    )
    assert mutation_response.status_code == 200
    child = mutation_response.json()["wavetable"]

    graph_response = client.get("/control/genetic/control-graph?limit=1000")
    assert graph_response.status_code == 200
    graph = graph_response.json()
    nodes = graph["nodes"]
    edges = graph["edges"]
    assert any(node["id"] == parent["id"] and node["type"] == "wavetable" for node in nodes)
    assert any(node["id"] == child["id"] and node["type"] == "wavetable" for node in nodes)
    assert any(edge["to"] == parent["id"] and edge["type"] == "prompt-to-wavetable" for edge in edges)
    assert any(edge["from"] == parent["id"] and edge["type"] == "wavetable-render" for edge in edges)
    assert any(edge["from"] == parent["id"] and edge["to"] == child["id"] and edge["type"] == "wavetable-mutation" for edge in edges)
    assert not any(
        edge["type"] == "wavetable-child" and not str(edge["from"]).startswith("wt_")
        for edge in edges
    )
    assert not any(
        edge["type"] == "wavetable-mutation" and not str(edge["from"]).startswith("wt_")
        for edge in edges
    )


def test_mock_batch_generate_records_unique_metadata_seeds() -> None:
    response = client.post(
        "/generate",
        json={
            "provider": "mock",
            "model": "mock-sine",
            "prompt": "short dry batch clicks",
            "duration": 0.25,
            "batch_size": 3,
            "seed": -1,
            "output_name": "pytest_batch_seed",
        },
    )
    assert response.status_code == 200
    body = response.json()
    seeds = [
        json.loads(Path(path).read_text(encoding="utf-8"))["seed"]
        for path in body["metadata_files"]
    ]
    assert len(seeds) == 3
    assert seeds == list(range(seeds[0], seeds[0] + 3))


def test_mock_generate_records_modulation_metadata() -> None:
    response = client.post(
        "/generate",
        json={
            "provider": "mock",
            "model": "mock-sine",
            "prompt": "short brittle ceramic click",
            "negative_prompt": "speech, vocals",
            "base_prompt": "short metal click",
            "modulated_prompt": "short brittle ceramic click",
            "base_negative_prompt": "speech",
            "modulated_negative_prompt": "speech, vocals",
            "duration": 0.25,
            "output_name": "pytest_modulated_generate",
            "modulators": [
                {
                    "id": "route_prompt_mod",
                    "type": "prompt_modulator",
                    "mode": "adjectives_materials",
                    "base_value": "short metal click",
                    "final_value": "short brittle ceramic click",
                }
            ],
            "lineage": {
                "operation_params": {
                    "modulators": [
                        {
                            "id": "route_prompt_mod",
                            "type": "prompt_modulator",
                            "mode": "adjectives_materials",
                        }
                    ]
                }
            },
        },
    )
    assert response.status_code == 200
    body = response.json()
    metadata = json.loads(Path(body["metadata_files"][0]).read_text(encoding="utf-8"))
    assert metadata["base_prompt"] == "short metal click"
    assert metadata["modulated_prompt"] == "short brittle ceramic click"
    assert metadata["base_negative_prompt"] == "speech"
    assert metadata["modulated_negative_prompt"] == "speech, vocals"
    assert metadata["modulators"][0]["type"] == "prompt_modulator"
    assert metadata["operation_params"]["modulators"][0]["id"] == "route_prompt_mod"
    assert metadata["lineage"]["operation_params"]["modulated_prompt"] == "short brittle ceramic click"


def test_mock_generate_records_semantic_effect_metadata() -> None:
    semantic_layer = {
        "id": "fx_space_semantic",
        "source": "fx",
        "source_module_id": "node_space",
        "source_type": "space",
        "family": "space",
        "prompt_layer": "large metallic tunnel, long cold reflections, distant air",
        "generation": {"continuationDivergence": 0.12, "maskFeather": 0.05},
    }
    semantic_effect = {
        "id": "node_space:semantic",
        "module_id": "node_space",
        "fx_type": "space",
        "amount": 0.75,
        "prompt_layer": semantic_layer["prompt_layer"],
        "generation": semantic_layer["generation"],
    }
    response = client.post(
        "/generate",
        json={
            "provider": "mock",
            "model": "mock-sine",
            "prompt": "short metallic air burst",
            "duration": 0.25,
            "output_name": "pytest_semantic_effect_generate",
            "semantic_layers": [semantic_layer],
            "semantic_effects": [semantic_effect],
            "generation_context": {"semantic_fx_count": 1, "semantic_fx_ids": ["node_space"]},
            "lineage": {
                "operation_params": {
                    "semantic_layers": [semantic_layer],
                    "semantic_effects": [semantic_effect],
                    "generation_context": {"semantic_fx_count": 1},
                }
            },
        },
    )
    assert response.status_code == 200
    body = response.json()
    metadata = json.loads(Path(body["metadata_files"][0]).read_text(encoding="utf-8"))
    assert metadata["semantic_layers"][0]["source_type"] == "space"
    assert metadata["semantic_effects"][0]["fx_type"] == "space"
    assert metadata["generation_context"]["semantic_fx_ids"] == ["node_space"]
    assert metadata["operation_params"]["semantic_layers"][0]["prompt_layer"].startswith("large metallic tunnel")
    assert metadata["lineage"]["operation_params"]["generation_context"]["semantic_fx_count"] == 1


def test_mock_generate_records_genetic_metadata() -> None:
    genetic_identity = {
        "id": "identity_timbre_pytest",
        "module_id": "node_identity",
        "trait": "timbre",
        "label": "Timbre identity",
        "strength": 0.72,
        "confidence": 0.91,
        "prompt_identity": "tape-corroded ceramic grain",
    }
    sequence = {
        "id": "sequence_pytest",
        "module_id": "node_sequence",
        "mode": "mutation_chain",
        "steps": [
            {"index": 1, "enabled": True, "action": "mutate_light", "probability": 1.0},
            {"index": 2, "enabled": True, "action": "save_tray", "probability": 1.0},
        ],
    }
    response = client.post(
        "/generate",
        json={
            "provider": "mock",
            "model": "mock-sine",
            "prompt": "short genetic ceramic click",
            "duration": 0.25,
            "output_name": "pytest_genetic_generate",
            "genetic_identities": [genetic_identity],
            "generation_sequences": [sequence],
            "lineage": {
                "genetic": {
                    "genetic_identities": [genetic_identity],
                    "generation_sequences": [sequence],
                },
                "operation_params": {
                    "genetic_identities": [genetic_identity],
                    "generation_sequences": [sequence],
                },
            },
        },
    )
    assert response.status_code == 200
    body = response.json()
    metadata = json.loads(Path(body["metadata_files"][0]).read_text(encoding="utf-8"))
    assert metadata["genetic_identities"][0]["trait"] == "timbre"
    assert metadata["generation_sequences"][0]["mode"] == "mutation_chain"
    assert metadata["operation_params"]["genetic_identities"][0]["id"] == "identity_timbre_pytest"
    assert metadata["lineage"]["genetic"]["generation_sequences"][0]["id"] == "sequence_pytest"


def test_mock_generation_records_lineage_and_parent_children() -> None:
    parent_response = client.post(
        "/generate",
        json={
            "provider": "mock",
            "model": "mock-sine",
            "prompt": "dry metallic breathing loop",
            "duration": 0.25,
            "output_name": "pytest_lineage_parent",
        },
    )
    assert parent_response.status_code == 200
    parent = parent_response.json()
    parent_audio_path = parent["audio_files"][0]
    parent_metadata_path = Path(parent["metadata_files"][0])
    parent_metadata = json.loads(parent_metadata_path.read_text(encoding="utf-8"))
    parent_id = parent_metadata["sound_id"]

    child_response = client.post(
        "/audio-to-audio",
        json={
            "provider": "mock",
            "model": "mock-sine",
            "prompt": "dry metallic breathing loop, rougher edge",
            "duration": 0.25,
            "input_audio_path": parent_audio_path,
            "init_noise_level": 0.42,
            "output_name": "pytest_lineage_child",
            "lineage": {
                "parents": [parent_id],
                "parent_metadata_paths": [str(parent_metadata_path)],
                "operation": "mutate",
                "operation_params": {
                    "init_noise_level": 0.42,
                    "prompt": "dry metallic breathing loop",
                },
                "region": {"purpose": "full", "start_sec": 0, "end_sec": 0.25},
            },
        },
    )
    assert child_response.status_code == 200
    child = child_response.json()
    child_metadata_path = Path(child["metadata_files"][0])
    child_metadata = json.loads(child_metadata_path.read_text(encoding="utf-8"))
    assert child_metadata["parents"] == [parent_id]
    assert child_metadata["operation"] == "mutate"
    assert child_metadata["operation_params"]["init_noise_level"] == 0.42
    assert child_metadata["source_region"]["purpose"] == "full"
    assert child_metadata["lineage"]["parent_metadata_paths"] == [str(parent_metadata_path)]

    updated_parent = json.loads(parent_metadata_path.read_text(encoding="utf-8"))
    assert child_metadata["sound_id"] in updated_parent["children"]
    assert child_metadata["sound_id"] in updated_parent["lineage"]["children"]


def test_lineage_parent_update_ignores_metadata_outside_output(tmp_path: Path) -> None:
    external_metadata = tmp_path / "external_parent.json"
    external_metadata.write_text(json.dumps({"children": []}), encoding="utf-8")

    response = client.post(
        "/generate",
        json={
            "provider": "mock",
            "model": "mock-sine",
            "prompt": "short protected lineage click",
            "duration": 0.25,
            "output_name": "pytest_external_lineage_parent",
            "lineage": {
                "parents": ["external-parent"],
                "parent_metadata_paths": [str(external_metadata)],
            },
        },
    )

    assert response.status_code == 200
    assert json.loads(external_metadata.read_text(encoding="utf-8")) == {"children": []}


def test_time_clock_derives_loop_seconds() -> None:
    clock = TimeClock(bpm=120, beats_per_bar=4, beat_unit=4, bars=4)
    summary = time_clock_summary(clock)
    assert summary["total_beats"] == 16
    assert summary["loop_seconds"] == 8.0
    assert summary["loop_samples"] == 352800
    assert summary["ticks_per_bar"] == 3840
    assert summary["total_ticks"] == 15360


def test_time_render_request_accepts_next_phase_modules() -> None:
    for module_type in [
        "slicer",
        "melody_maker",
        "euclidean_colony",
        "clocked_looper",
        "probability_gate",
        "clock_divider",
        "humanizer",
        "polymeter",
        "render_bus",
        "render_macros",
    ]:
        request = TimeRenderRequest(
            module_type=module_type,
            module_id="time_node_pytest",
            sources=[{"id": "source_1", "audio_path": "output/audio/source.wav"}],
            events=[{"tick": 0, "source_id": "source_1"}],
        )
        assert request.module_type == module_type


def test_time_render_event_rejects_invalid_source_window() -> None:
    response = client.post(
        "/time/render",
        json={
            "module_type": "slicer",
            "module_id": "bad_window",
            "sources": [{"id": "source_1", "audio_path": "output/audio/source.wav"}],
            "events": [
                {
                    "tick": 0,
                    "source_id": "source_1",
                    "source_start_sec": 0.2,
                    "source_end_sec": 0.1,
                }
            ],
        },
    )
    assert response.status_code == 422


def test_time_render_rejects_oversized_clock_before_mixing() -> None:
    response = client.post(
        "/time/render",
        json={
            "module_type": "colony_sequencer",
            "module_id": "huge_clock",
            "clock": {
                "bpm": 20,
                "beats_per_bar": 16,
                "beat_unit": 4,
                "bars": 128,
                "sample_rate": 44100,
            },
            "sources": [{"id": "source_1", "audio_path": "output/audio/missing.wav"}],
            "events": [{"tick": 0, "source_id": "source_1"}],
        },
    )
    assert response.status_code == 422
    assert "380 seconds or less" in response.json()["detail"]


def test_time_render_rejects_negative_event_tick() -> None:
    response = client.post(
        "/time/render",
        json={
            "module_type": "trigger_pads",
            "module_id": "pads_pytest",
            "clock": {"sample_rate": 44100},
            "sources": [{"id": "pad_1", "audio_path": "output/audio/missing.wav"}],
            "events": [{"tick": -1, "source_id": "pad_1"}],
        },
    )
    assert response.status_code == 422
    assert "tick" in json.dumps(response.json()["detail"])


def test_time_render_mixes_wav_sources_and_metadata() -> None:
    first_response = client.post(
        "/generate",
        json={
            "provider": "mock",
            "model": "mock-sine",
            "prompt": "short clay click",
            "duration": 0.25,
            "output_name": "pytest_time_parent_a",
        },
    )
    second_response = client.post(
        "/generate",
        json={
            "provider": "mock",
            "model": "mock-sine",
            "prompt": "short metal click",
            "duration": 0.25,
            "output_name": "pytest_time_parent_b",
        },
    )
    assert first_response.status_code == 200
    assert second_response.status_code == 200
    first = first_response.json()
    second = second_response.json()
    first_metadata_path = Path(first["metadata_files"][0])
    second_metadata_path = Path(second["metadata_files"][0])
    first_metadata = json.loads(first_metadata_path.read_text(encoding="utf-8"))
    second_metadata = json.loads(second_metadata_path.read_text(encoding="utf-8"))

    response = client.post(
        "/time/render",
        json={
            "module_type": "colony_sequencer",
            "module_id": "time_node_pytest",
            "clock": {
                "enabled": True,
                "bpm": 120,
                "beats_per_bar": 4,
                "beat_unit": 4,
                "bars": 4,
                "ppq": 960,
                "sample_rate": 44100,
                "snap_division": "1/16",
            },
            "sources": [
                {
                    "id": "lane_1",
                    "audio_path": first["audio_files"][0],
                    "metadata_path": first["metadata_files"][0],
                    "label": "Clay",
                },
                {
                    "id": "lane_2",
                    "audio_path": second["audio_files"][0],
                    "metadata_path": second["metadata_files"][0],
                    "label": "Metal",
                    "pan": 0.25,
                },
            ],
            "events": [
                {
                    "tick": 0,
                    "source_id": "lane_1",
                    "lane": 0,
                    "velocity": 0.8,
                    "source_start_sec": 0.0,
                    "source_end_sec": 0.12,
                    "duration_ticks": 480,
                    "fade_out_ms": 12,
                },
                {
                    "tick": 960,
                    "source_id": "lane_2",
                    "lane": 1,
                    "velocity": 1.0,
                    "pitch_semitones": 7,
                },
            ],
            "output_name": "pytest_time_render",
            "culture_id": "culture-time-pytest",
            "tags": ["time", "harvest"],
            "modulators": [
                {
                    "id": "route_lfo_velocity",
                    "modulator_id": "node_lfo",
                    "type": "lfo_modulator",
                    "target_path": "events.velocity",
                    "base_value": 0.8,
                    "final_value": 0.92,
                }
            ],
            "lineage": {"operation_params": {"pattern": "pytest"}},
        },
    )
    assert response.status_code == 200
    body = response.json()
    assert body["status"] == "done"
    assert body["mode"] == "time-render"
    audio_path = Path(body["audio_files"][0])
    metadata_path = Path(body["metadata_files"][0])
    assert audio_path.exists()
    assert metadata_path.exists()
    metadata = json.loads(metadata_path.read_text(encoding="utf-8"))
    assert metadata["mode"] == "time-render"
    assert metadata["germinator_mode"] == "harvest"
    assert metadata["source_type"] == "time_render"
    assert metadata["provider"] == "local"
    assert metadata["model"] == "time-renderer"
    assert metadata["time_render"]["module_type"] == "colony_sequencer"
    assert metadata["time_render"]["clock"]["loop_seconds"] == 8.0
    assert metadata["time_render"]["output_format"] == "wav"
    assert metadata["time_render"]["output_channels"] == 2
    assert metadata["time_render"]["output_sample_rate"] == 44100
    assert len(metadata["time_render"]["events"]) == 2
    assert metadata["time_render"]["events"][0]["source_end_sec"] == 0.12
    assert metadata["time_render"]["events"][0]["fade_out_ms"] == 12.0
    assert metadata["time_render"]["events"][1]["pitch_semitones"] == 7.0
    assert metadata["time_render"]["pitch_event_count"] == 1
    assert metadata["time_render"]["pitch_engine"] in {"rubberband", "resample_fallback"}
    assert len(metadata["time_render"]["sources"]) == 2
    assert len(metadata["time_render"]["sources"][0]["sha256"]) == 64
    assert metadata["modulators"][0]["type"] == "lfo_modulator"
    assert metadata["time_render"]["modulators"][0]["target_path"] == "events.velocity"
    assert metadata["lineage"]["operation_params"]["modulators"][0]["id"] == "route_lfo_velocity"
    assert metadata["parents"] == [first_metadata["sound_id"], second_metadata["sound_id"]]
    assert metadata["lineage"]["parent_metadata_paths"] == [
        storage.relative_path(first_metadata_path),
        storage.relative_path(second_metadata_path),
    ]

    updated_first = json.loads(first_metadata_path.read_text(encoding="utf-8"))
    assert metadata["sound_id"] in updated_first["children"]
    assert metadata["sound_id"] in updated_first["lineage"]["children"]


def test_time_render_rejects_non_wav_source() -> None:
    source_path = settings.output_root / "audio" / "pytest_time_non_wav.webm"
    source_path.parent.mkdir(parents=True, exist_ok=True)
    source_path.write_bytes(b"not audio")
    response = client.post(
        "/time/render",
        json={
            "module_type": "trigger_pads",
            "module_id": "pads_pytest",
            "clock": {"sample_rate": 44100},
            "sources": [{"id": "pad_1", "audio_path": storage.relative_path(source_path)}],
            "events": [{"tick": 0, "source_id": "pad_1"}],
        },
    )
    assert response.status_code == 422
    assert "WAV" in response.json()["detail"]


def test_time_render_rejects_mismatched_sample_rate() -> None:
    source_path = settings.output_root / "audio" / "pytest_time_wrong_rate.wav"
    write_sine_wav(source_path, duration=0.25, sample_rate=22050)
    response = client.post(
        "/time/render",
        json={
            "module_type": "trigger_pads",
            "module_id": "pads_pytest",
            "clock": {"sample_rate": 44100},
            "sources": [{"id": "pad_1", "audio_path": storage.relative_path(source_path)}],
            "events": [{"tick": 0, "source_id": "pad_1"}],
        },
    )
    assert response.status_code == 422
    assert "sample rate" in response.json()["detail"]


def test_time_render_rejects_empty_events() -> None:
    source_path = settings.output_root / "audio" / "pytest_time_empty_events.wav"
    write_sine_wav(source_path, duration=0.25)
    response = client.post(
        "/time/render",
        json={
            "module_type": "trigger_pads",
            "module_id": "pads_pytest",
            "clock": {"sample_rate": 44100},
            "sources": [{"id": "pad_1", "audio_path": storage.relative_path(source_path)}],
            "events": [],
        },
    )
    assert response.status_code == 422


def test_audio_tools_extract_region_creates_sound_with_lineage() -> None:
    parent_response = client.post(
        "/generate",
        json={
            "provider": "mock",
            "model": "mock-sine",
            "prompt": "short slice source",
            "duration": 0.4,
            "output_name": "pytest_audio_tool_parent",
        },
    )
    assert parent_response.status_code == 200
    parent = parent_response.json()
    parent_metadata_path = Path(parent["metadata_files"][0])
    parent_metadata = json.loads(parent_metadata_path.read_text(encoding="utf-8"))

    tool_response = client.post(
        "/audio-tools/operate",
        json={
            "input_audio_path": parent["audio_files"][0],
            "metadata_path": parent["metadata_files"][0],
            "operation": "extract_region",
            "start_sec": 0.1,
            "end_sec": 0.2,
            "output_name": "pytest_audio_tool_extract",
            "lineage": {
                "parents": [parent_metadata["sound_id"]],
                "parent_metadata_paths": [parent["metadata_files"][0]],
                "operation": "slice",
                "region": {
                    "purpose": "extract",
                    "region_type": "seed",
                    "intent": "extract identity",
                    "start_sec": 0.1,
                    "end_sec": 0.2,
                },
            },
        },
    )
    assert tool_response.status_code == 200
    body = tool_response.json()
    assert body["status"] == "done"
    assert len(body["audio_files"]) == 1
    assert len(body["metadata_files"]) == 1
    assert abs(body["duration"] - 0.1) < 0.01
    metadata_path = Path(body["metadata_files"][0])
    metadata = json.loads(metadata_path.read_text(encoding="utf-8"))
    assert metadata["operation"] == "slice"
    assert metadata["source_region"]["purpose"] == "extract"
    assert metadata["source_region"]["region_type"] == "seed"
    assert metadata["source_region"]["intent"] == "extract identity"
    assert metadata["operation_params"]["operation"] == "extract_region"
    assert metadata["parents"] == [parent_metadata["sound_id"]]

    updated_parent = json.loads(parent_metadata_path.read_text(encoding="utf-8"))
    assert metadata["sound_id"] in updated_parent["children"]


def test_audio_tools_tail_extender_and_onset_splitter() -> None:
    source_response = client.post(
        "/generate",
        json={
            "provider": "mock",
            "model": "mock-sine",
            "prompt": "short audio tool source",
            "duration": 0.25,
            "output_name": "pytest_audio_tool_source_extra",
        },
    )
    assert source_response.status_code == 200
    source = source_response.json()

    tail_response = client.post(
        "/audio-tools/operate",
        json={
            "input_audio_path": source["audio_files"][0],
            "metadata_path": source["metadata_files"][0],
            "operation": "tail_extender",
            "tail_extension_sec": 0.2,
            "output_name": "pytest_tail_extender",
        },
    )
    assert tail_response.status_code == 200
    tail = tail_response.json()
    assert tail["duration"] > 0.25
    tail_metadata = json.loads(Path(tail["metadata_files"][0]).read_text(encoding="utf-8"))
    assert tail_metadata["operation_params"]["operation"] == "tail_extender"
    assert tail_metadata["operation_params"]["tail_extension_sec"] == 0.2

    onset_response = client.post(
        "/audio-tools/operate",
        json={
            "input_audio_path": source["audio_files"][0],
            "metadata_path": source["metadata_files"][0],
            "operation": "onset_splitter",
            "slice_count": 4,
            "output_name": "pytest_onset_splitter",
        },
    )
    assert onset_response.status_code == 200
    onset = onset_response.json()
    assert len(onset["audio_files"]) >= 1
    onset_metadata = json.loads(Path(onset["metadata_files"][0]).read_text(encoding="utf-8"))
    assert onset_metadata["operation"] == "onset_splitter"
    assert onset_metadata["source_region"]["intent"] == "split onset"


def test_audio_process_reports_missing_rubberband(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(audio_tools.shutil, "which", lambda _name: None)
    source_response = client.post(
        "/generate",
        json={
            "provider": "mock",
            "model": "mock-sine",
            "prompt": "short pitch source",
            "duration": 0.2,
            "output_name": "pytest_pitch_missing_source",
        },
    )
    assert source_response.status_code == 200
    source = source_response.json()
    response = client.post(
        "/audio/process",
        json={
            "input_audio_path": source["audio_files"][0],
            "metadata_path": source["metadata_files"][0],
            "pitch_semitones": 7,
            "stretch_ratio": 1.25,
            "output_name": "pytest_pitch_missing",
        },
    )
    assert response.status_code == 422
    assert "Rubber Band is not installed" in response.json()["detail"]


def test_audio_process_reports_missing_source_as_validation_error() -> None:
    response = client.post(
        "/audio/process",
        json={
            "input_audio_path": "/tmp/does-not-exist.wav",
            "pitch_semitones": 0,
            "stretch_ratio": 1,
            "output_name": "pytest_pitch_missing_source",
        },
    )
    assert response.status_code == 422
    assert "audio does not exist" in response.json()["detail"]


def test_submit_job_runs_mock_generate_and_records_status() -> None:
    response = client.post(
        "/jobs/submit",
        json={
            "mode": "text-to-audio",
            "request": {
                "provider": "mock",
                "model": "mock-sine",
                "prompt": "queued wood click",
                "duration": 0.25,
                "output_name": "pytest_queued",
            },
        },
    )
    assert response.status_code == 200
    body = response.json()
    assert body["status"] == "queued"
    job = poll_job(body["status_url"])
    assert job["status"] == "done"
    assert job["audio_files"]
    assert job["metadata_files"]
    assert job["metrics"]["elapsed_seconds"] >= 0


def test_cancel_missing_job_returns_404() -> None:
    response = client.post("/jobs/not-a-job/cancel")
    assert response.status_code == 404


def test_cancel_running_job_signals_provider(monkeypatch: pytest.MonkeyPatch) -> None:
    provider = registry.get("mock")
    started = Event()
    saw_cancel = Event()

    def slow_generate(request: GenerateRequest) -> GenerationResult:
        started.set()
        deadline = time.monotonic() + 3
        while time.monotonic() < deadline:
            if provider.is_job_cancelled(request.job_id):
                result = GenerationResult(
                    job_id=request.job_id or "",
                    status="cancelled",
                    error="job cancelled",
                    provider=provider.provider_id,
                    model=request.model,
                    mode="text-to-audio",
                )
                storage.record_result(result)
                saw_cancel.set()
                return result
            time.sleep(0.01)
        raise AssertionError("provider did not receive cancellation signal")

    monkeypatch.setattr(provider, "generate", slow_generate)
    response = client.post(
        "/jobs/submit",
        json={
            "mode": "text-to-audio",
            "request": {
                "provider": "mock",
                "model": "mock-sine",
                "prompt": "slow cancellation contract",
                "duration": 0.25,
            },
        },
    )
    assert response.status_code == 200
    job_id = response.json()["job_id"]
    assert started.wait(2)

    cancel_response = client.post(f"/jobs/{job_id}/cancel")
    assert cancel_response.status_code == 200
    assert cancel_response.json()["cancelled"] is True
    assert cancel_response.json()["status"] == "cancelled"
    assert saw_cancel.wait(2)

    job = poll_job(f"/jobs/{job_id}")
    assert job["status"] == "cancelled"
    assert job["error"] == "job cancelled"


def test_job_eviction_keeps_recent_terminal_jobs_during_grace_window() -> None:
    original_jobs = dict(storage.jobs)
    original_listeners = dict(storage.job_listeners)
    try:
        storage.jobs.clear()
        storage.job_listeners.clear()
        recent = datetime.now(timezone.utc).isoformat()
        for index in range(MAX_TRACKED_JOBS + 1):
            storage.jobs[f"recent-{index}"] = {
                "job_id": f"recent-{index}",
                "status": "done",
                "created_at": recent,
                "updated_at": recent,
            }

        storage._evict_old_jobs()
        assert len(storage.jobs) == MAX_TRACKED_JOBS + 1

        old = (
            datetime.now(timezone.utc)
            - timedelta(seconds=JOB_EVICTION_GRACE_SECONDS + 1)
        ).isoformat()
        for job in storage.jobs.values():
            job["created_at"] = old
            job["updated_at"] = old

        storage._evict_old_jobs()
        assert len(storage.jobs) == MAX_TRACKED_JOBS

        jobs_before_listener_pressure = set(storage.jobs)
        storage.jobs["old-active-listener"] = {
            "job_id": "old-active-listener",
            "status": "done",
            "created_at": old,
            "updated_at": old,
        }
        storage.job_listeners["old-active-listener"] = 1
        storage._evict_old_jobs()
        assert "old-active-listener" in storage.jobs
        assert len(storage.jobs) == MAX_TRACKED_JOBS
        assert len(jobs_before_listener_pressure - set(storage.jobs)) == 1

        storage.job_listeners.pop("old-active-listener", None)
        for job_id, job in storage.jobs.items():
            if job_id != "old-active-listener":
                job["status"] = "running"
        storage.jobs["running-pressure"] = {
            "job_id": "running-pressure",
            "status": "running",
            "created_at": old,
            "updated_at": old,
        }
        storage._evict_old_jobs()
        assert "old-active-listener" not in storage.jobs
        assert len(storage.jobs) == MAX_TRACKED_JOBS
    finally:
        storage.jobs.clear()
        storage.jobs.update(original_jobs)
        storage.job_listeners.clear()
        storage.job_listeners.update(original_listeners)


def test_mock_audio_to_audio_accepts_input_path() -> None:
    input_path = settings.upload_dir / "pytest_allowed_input.wav"
    write_sine_wav(input_path, duration=0.25)
    response = client.post(
        "/audio-to-audio",
        json={
            "provider": "mock",
            "model": "mock-sine",
            "prompt": "turn this into metallic resonance",
            "input_audio_path": str(input_path),
            "duration": 0.5,
            "init_noise_level": 0.45,
        },
    )
    assert response.status_code == 200
    body = response.json()
    assert body["status"] == "done"
    assert Path(body["audio_files"][0]).exists()


def test_continue_route_renders_from_input_path() -> None:
    input_path = settings.upload_dir / "pytest_continue_input.wav"
    write_sine_wav(input_path, duration=0.25)
    response = client.post(
        "/continue",
        json={
            "provider": "mock",
            "model": "mock-sine",
            "prompt": "continue this short texture",
            "input_audio_path": str(input_path),
            "source_duration": 0.25,
            "target_duration": 0.5,
            "output_name": "pytest_continue",
        },
    )
    assert response.status_code == 200
    body = response.json()
    assert body["status"] == "done"
    assert body["mode"] == "continuation"
    assert body["duration"] == 0.5
    assert Path(body["audio_files"][0]).exists()


def test_mock_audio_to_audio_rejects_external_input_path(tmp_path: Path) -> None:
    input_path = tmp_path / "input.wav"
    write_sine_wav(input_path, duration=0.25)
    response = client.post(
        "/audio-to-audio",
        json={
            "provider": "mock",
            "model": "mock-sine",
            "prompt": "turn this into metallic resonance",
            "input_audio_path": str(input_path),
            "duration": 0.5,
            "init_noise_level": 0.45,
        },
    )
    assert response.status_code == 200
    body = response.json()
    assert body["status"] == "error"
    assert "allowed input root" in body["error"]


def test_mock_audio_to_audio_accepts_project_relative_input_path() -> None:
    input_path = settings.audio_dir / "pytest_relative_input.wav"
    write_sine_wav(input_path, duration=0.25)
    response = client.post(
        "/audio-to-audio",
        json={
            "provider": "mock",
            "model": "mock-sine",
            "prompt": "turn this into metallic resonance",
            "input_audio_path": storage.relative_path(input_path),
            "duration": 0.5,
            "init_noise_level": 0.45,
        },
    )
    assert response.status_code == 200
    assert response.json()["status"] == "done"


def test_mock_inpaint_validates_ranges() -> None:
    input_path = settings.upload_dir / "pytest_inpaint_input.wav"
    write_sine_wav(input_path, duration=0.25)
    response = client.post(
        "/inpaint",
        json={
            "provider": "mock",
            "model": "mock-sine",
            "prompt": "replace the region",
            "input_audio_path": str(input_path),
            "inpaint_ranges": [[0.1, 0.2]],
            "duration": 0.5,
        },
    )
    assert response.status_code == 200
    assert response.json()["status"] == "done"

    invalid = client.post(
        "/inpaint",
        json={
            "provider": "mock",
            "model": "mock-sine",
            "prompt": "replace the region",
            "input_audio_path": str(input_path),
            "inpaint_ranges": [[0.2, 0.1]],
            "duration": 0.5,
        },
    )
    assert invalid.status_code == 422


def test_inpaint_preserves_wave_region_roles() -> None:
    input_path = settings.upload_dir / "pytest_region_roles_input.wav"
    write_sine_wav(input_path, duration=0.5)
    region_roles = [
        {
            "id": "region_mask",
            "purpose": "inpaint",
            "region_type": "texture",
            "role": "timbral_reference",
            "intent": "replace texture",
            "start_sec": 0.1,
            "end_sec": 0.2,
        },
        {
            "id": "region_preserve",
            "purpose": "preserve",
            "region_type": "preserve",
            "role": "protect",
            "intent": "preserve groove",
            "start_sec": 0.0,
            "end_sec": 0.08,
        },
    ]
    response = client.post(
        "/inpaint",
        json={
            "provider": "mock",
            "model": "mock-sine",
            "prompt": "replace texture but keep the groove",
            "input_audio_path": str(input_path),
            "inpaint_ranges": [[0.1, 0.2]],
            "region_roles": region_roles,
            "texture_ranges": [[0.1, 0.2]],
            "preserve_ranges": [[0.0, 0.08]],
            "duration": 0.5,
            "lineage": {
                "operation": "prune",
                "region": region_roles[0],
                "regions": region_roles,
            },
        },
    )
    assert response.status_code == 200
    metadata_path = Path(response.json()["metadata_files"][0])
    metadata = json.loads(metadata_path.read_text(encoding="utf-8"))
    assert metadata["region_roles"] == region_roles
    assert metadata["texture_ranges"] == [[0.1, 0.2]]
    assert metadata["preserve_ranges"] == [[0.0, 0.08]]
    assert metadata["source_region"]["region_type"] == "texture"
    assert metadata["lineage"]["regions"][1]["intent"] == "preserve groove"


def test_dashboard_static_app_serves() -> None:
    response = client.get("/dashboard")
    assert response.status_code == 200
    assert "germ" in response.text
    assert "/dashboard/assets/app.js" in response.text

    head_response = client.head("/dashboard")
    assert head_response.status_code == 200
    assert head_response.text == ""
    assert head_response.headers["content-type"].startswith("text/html")


def test_generated_output_can_be_played_from_files_route() -> None:
    response = client.post(
        "/generate",
        json={
            "provider": "mock",
            "model": "mock-sine",
            "prompt": "short dry click",
            "duration": 0.25,
            "output_name": "pytest_file_route",
        },
    )
    assert response.status_code == 200
    audio_file = response.json()["audio_files"][0]
    file_response = client.get(f"/files/{audio_file}")
    assert file_response.status_code == 200
    assert file_response.headers["content-type"].startswith("audio")


def test_submit_job_validation_errors_are_json_serializable() -> None:
    response = client.post(
        "/jobs/submit",
        json={
            "mode": "inpainting",
            "request": {
                "provider": "mock",
                "model": "mock-sine",
                "prompt": "bad inpaint job",
                "input_audio_path": "output/audio/missing.wav",
                "inpaint_ranges": [[0.2, 0.1]],
            },
        },
    )
    assert response.status_code == 422
    assert "ctx" not in json.dumps(response.json()["detail"])


def test_files_route_rejects_paths_outside_output() -> None:
    response = client.get("/files/pyproject.toml")
    assert response.status_code == 403

    reveal = client.post("/files/reveal", json={"path": "pyproject.toml"})
    assert reveal.status_code == 403


def test_files_route_refuses_to_serve_metadata_json() -> None:
    response = client.post(
        "/generate",
        json={
            "provider": "mock",
            "model": "mock-sine",
            "prompt": "servable extension guard",
            "duration": 0.25,
            "output_name": "pytest_servable_guard",
        },
    )
    assert response.status_code == 200
    audio_file = response.json()["audio_files"][0]
    metadata_file = response.json()["metadata_files"][0]
    # Audio is served, but the sibling metadata JSON is not exposed over GET.
    assert client.get(f"/files/{audio_file}").status_code == 200
    assert client.get(f"/files/{metadata_file}").status_code == 404


def test_audio_to_audio_invalid_json_returns_400() -> None:
    response = client.post(
        "/audio-to-audio",
        headers={"content-type": "application/json"},
        content="{",
    )
    assert response.status_code == 400


def test_unsafe_post_rejects_foreign_origin() -> None:
    response = client.post(
        "/generate",
        headers={"origin": "https://example.invalid"},
        json={
            "provider": "mock",
            "model": "mock-sine",
            "prompt": "cross origin attempt",
            "duration": 0.25,
        },
    )
    assert response.status_code == 403


def test_unsafe_post_allows_localhost_origin() -> None:
    response = client.post(
        "/generate",
        headers={"origin": "http://localhost:3000"},
        json={
            "provider": "mock",
            "model": "mock-sine",
            "prompt": "local dashboard request",
            "duration": 0.25,
        },
    )
    assert response.status_code == 200
    assert response.json()["status"] == "done"


def test_library_lists_generated_metadata() -> None:
    response = client.get("/library")
    assert response.status_code == 200
    body = response.json()
    assert "items" in body
    assert "audio_dir" in body


def test_library_etag_returns_not_modified_for_same_view() -> None:
    response = client.get("/library?limit=5&offset=0&fields=audio_file,metadata_file,status")
    assert response.status_code == 200
    etag = response.headers.get("etag")
    assert etag
    body = response.json()
    assert body["limit"] == 5
    assert body["offset"] == 0
    if body["items"]:
        assert set(body["items"][0]).issubset({"audio_file", "metadata_file", "status"})

    second = client.get(
        "/library?limit=5&offset=0&fields=audio_file,metadata_file,status",
        headers={"If-None-Match": etag},
    )
    assert second.status_code == 304
    assert second.content == b""
    assert second.headers.get("etag") == etag


def test_library_indexes_archive_audio_from_output_tree() -> None:
    archive_path = settings.output_root / "intermediate" / "pytest_library_archive.wav"
    write_sine_wav(archive_path, duration=0.25)

    response = client.get("/library?limit=0")
    assert response.status_code == 200
    items = response.json()["items"]
    assert any(item["audio_file"] == storage.relative_path(archive_path) for item in items)


def test_multipart_audio_to_audio_preserves_lora_metadata(tmp_path: Path) -> None:
    input_path = tmp_path / "upload.wav"
    write_sine_wav(input_path, duration=0.25)
    response = client.post(
        "/audio-to-audio",
        data={
            "provider": "mock",
            "model": "mock-sine",
            "prompt": "uploaded source",
            "duration": "0.5",
            "init_noise_level": "0.45",
            "lora": '[{"path": "/tmp/example.safetensors", "strength": 0.7}]',
        },
        files={"file": ("upload.wav", input_path.read_bytes(), "audio/wav")},
    )
    assert response.status_code == 200
    metadata_path = Path(response.json()["metadata_files"][0])
    metadata = json.loads(metadata_path.read_text(encoding="utf-8"))
    assert metadata["lora"] == [{"path": "/tmp/example.safetensors", "strength": 0.7}]


def test_multipart_audio_to_audio_transient_upload_is_cleaned_and_hidden(tmp_path: Path) -> None:
    input_path = tmp_path / "dish_breed.wav"
    write_sine_wav(input_path, duration=0.25)
    response = client.post(
        "/audio-to-audio",
        data={
            "provider": "mock",
            "model": "mock-sine",
            "prompt": "transient one-bit breed source",
            "duration": "0.5",
            "init_noise_level": "0.45",
            "transient_upload": "true",
            "output_name": "pytest_transient_breed",
            "lineage": json.dumps({"operation": "collision_breed", "source_type": "one_bit"}),
        },
        files={"file": ("dish_breed.wav", input_path.read_bytes(), "audio/wav")},
    )
    assert response.status_code == 200
    metadata_path = Path(response.json()["metadata_files"][0])
    metadata = json.loads(metadata_path.read_text(encoding="utf-8"))
    transient_path = Path(metadata["input_audio_path"])
    assert transient_path.parent == settings.scratch_dir
    assert not transient_path.exists()

    library_response = client.get("/library?limit=0")
    assert library_response.status_code == 200
    assert all(item.get("source_type") != "scratch" for item in library_response.json()["items"])


def test_multipart_inpaint_transient_upload_is_cleaned(tmp_path: Path) -> None:
    input_path = tmp_path / "pytest_transient_inpaint.wav"
    write_sine_wav(input_path, duration=0.25)
    response = client.post(
        "/inpaint",
        data={
            "provider": "mock",
            "model": "mock-sine",
            "prompt": "transient inpaint source",
            "duration": "0.5",
            "inpaint_ranges": "0.05,0.15",
            "transient_upload": "true",
            "output_name": "pytest_transient_inpaint",
        },
        files={"file": ("pytest_transient_inpaint.wav", input_path.read_bytes(), "audio/wav")},
    )
    assert response.status_code == 200
    metadata_path = Path(response.json()["metadata_files"][0])
    metadata = json.loads(metadata_path.read_text(encoding="utf-8"))
    transient_path = Path(metadata["input_audio_path"])
    assert transient_path.parent == settings.scratch_dir
    assert not transient_path.exists()


def test_multipart_inpaint_transient_upload_is_cleaned_on_validation_error(
    tmp_path: Path,
) -> None:
    input_path = tmp_path / "pytest_transient_bad_inpaint.wav"
    write_sine_wav(input_path, duration=0.25)
    response = client.post(
        "/inpaint",
        data={
            "provider": "mock",
            "model": "mock-sine",
            "prompt": "bad transient inpaint source",
            "duration": "0.5",
            "inpaint_ranges": "not-a-range",
            "transient_upload": "true",
        },
        files={"file": ("pytest_transient_bad_inpaint.wav", input_path.read_bytes(), "audio/wav")},
    )
    assert response.status_code == 422
    assert not list(settings.scratch_dir.glob("pytest_transient_bad_inpaint_*.wav"))


def test_multipart_inpaint_preserves_tags_and_ranges(tmp_path: Path) -> None:
    input_path = tmp_path / "upload.wav"
    write_sine_wav(input_path, duration=0.25)
    response = client.post(
        "/inpaint",
        data={
            "provider": "mock",
            "model": "mock-sine",
            "prompt": "replace uploaded region",
            "duration": "0.5",
            "inpaint_ranges": "0.05,0.15",
            "tags": '["petri", "inpaint"]',
        },
        files={"file": ("upload.wav", input_path.read_bytes(), "audio/wav")},
    )
    assert response.status_code == 200
    metadata_path = Path(response.json()["metadata_files"][0])
    metadata = json.loads(metadata_path.read_text(encoding="utf-8"))
    assert metadata["tags"] == ["petri", "inpaint"]
    assert metadata["inpaint_ranges"] == [[0.05, 0.15]]


def test_multipart_inpaint_invalid_range_returns_422(tmp_path: Path) -> None:
    input_path = tmp_path / "upload.wav"
    write_sine_wav(input_path, duration=0.25)
    response = client.post(
        "/inpaint",
        data={
            "provider": "mock",
            "model": "mock-sine",
            "prompt": "replace uploaded region",
            "duration": "0.5",
            "inpaint_ranges": "not-a-range",
        },
        files={"file": ("upload.wav", input_path.read_bytes(), "audio/wav")},
    )
    assert response.status_code == 422


def test_audio_import_handles_malformed_optional_numeric_metadata(tmp_path: Path) -> None:
    input_path = tmp_path / "upload.wav"
    write_sine_wav(input_path, duration=0.25)
    response = client.post(
        "/audio/import",
        data={
            "metadata": json.dumps(
                {
                    "duration": "not-a-duration",
                    "seed": "not-a-seed",
                    "steps": "not-steps",
                    "cfg_scale": "not-cfg",
                    "output_name": "pytest_bad_numeric_import",
                }
            )
        },
        files={"file": ("upload.wav", input_path.read_bytes(), "audio/wav")},
    )
    assert response.status_code == 200
    metadata = json.loads(Path(response.json()["metadata_files"][0]).read_text(encoding="utf-8"))
    assert metadata["duration"] == 0.1
    assert metadata["seed"] == -1
    assert metadata["steps"] == 1
    assert metadata["cfg_scale"] == 1.0


def test_audio_import_rejects_oversized_upload(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(settings, "max_upload_bytes", 4)
    response = client.post(
        "/audio/import",
        data={"metadata": "{}"},
        files={"file": ("too_large.wav", b"12345", "audio/wav")},
    )
    assert response.status_code == 413


def test_image_to_audio_rejects_invalid_mime_type() -> None:
    response = client.post(
        "/image-to-audio/analyze",
        json={
            "image_base64": base64.b64encode(b"image").decode("ascii"),
            "mime_type": "text/html",
        },
    )
    assert response.status_code == 422


def test_image_to_audio_rejects_oversized_inline_image(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(settings, "max_image_upload_bytes", 4)
    response = client.post(
        "/image-to-audio/analyze",
        json={
            "image_base64": base64.b64encode(b"image").decode("ascii"),
            "mime_type": "image/png",
        },
    )
    assert response.status_code == 413


def test_mlx_command_includes_steps_and_validates_model() -> None:
    provider = StableAudioMLXProvider(storage, settings)
    request = GenerateRequest(
        provider="stable_audio_mlx",
        model="sm-sfx",
        prompt="short click",
        duration=1.0,
        steps=12,
    )
    command = provider._build_command(request, Path("output/audio/test.wav"), seed=42)
    assert "--steps" in command
    assert command[command.index("--steps") + 1] == "12"

    invalid = request.model_copy(update={"model": "not-a-model"})
    try:
        provider._build_command(invalid, Path("output/audio/test.wav"), seed=42)
    except ValueError as exc:
        assert "unknown MLX model" in str(exc)
    else:
        raise AssertionError("invalid MLX model should raise ValueError")


def test_mlx_multi_range_inpaint_runs_sequentially(monkeypatch) -> None:
    input_path = settings.upload_dir / "pytest_mlx_multi_input.wav"
    write_sine_wav(input_path, duration=0.5)

    provider = StableAudioMLXProvider(storage, settings)
    monkeypatch.setattr(provider, "is_available", lambda: True)
    calls: list[list[str]] = []

    def fake_run_process(command: list[str], *, job_id: str | None = None) -> dict:
        calls.append(command)
        out_path = Path(command[command.index("--out") + 1])
        write_sine_wav(out_path, duration=0.5)
        return {
            "command": " ".join(command),
            "stdout": "ok",
            "stderr": "",
            "returncode": 0,
            "error": None,
        }

    monkeypatch.setattr(provider, "_run_process", fake_run_process)
    request = InpaintRequest(
        provider="stable_audio_mlx",
        model="sm-sfx",
        prompt="replace tiny regions",
        input_audio_path=str(input_path),
        inpaint_ranges=[(0.1, 0.2), (0.3, 0.4)],
        duration=0.5,
        output_name="pytest_mlx_multi_inpaint",
    )

    result = provider.inpaint(request)
    assert result.status == "done"
    assert len(calls) == 2
    assert calls[0][calls[0].index("--inpaint-range") + 1] == "0.1,0.2"
    assert calls[1][calls[1].index("--inpaint-range") + 1] == "0.3,0.4"
    metadata = json.loads(Path(result.metadata_files[0]).read_text(encoding="utf-8"))
    assert metadata["multi_range_strategy"] == "sequential_mlx_inpaint"
    assert len(metadata["commands"]) == 2


def test_mlx_multi_range_inpaint_cleans_intermediate_on_failure(monkeypatch) -> None:
    input_path = settings.upload_dir / "pytest_mlx_multi_fail_input.wav"
    write_sine_wav(input_path, duration=0.5)

    provider = StableAudioMLXProvider(storage, settings)
    monkeypatch.setattr(provider, "is_available", lambda: True)
    calls: list[list[str]] = []

    def fake_run_process(command: list[str], *, job_id: str | None = None) -> dict:
        calls.append(command)
        out_path = Path(command[command.index("--out") + 1])
        if len(calls) == 1:
            write_sine_wav(out_path, duration=0.5)
            return {
                "command": " ".join(command),
                "stdout": "ok",
                "stderr": "",
                "returncode": 0,
                "error": None,
            }
        return {
            "command": " ".join(command),
            "stdout": "",
            "stderr": "range failed",
            "returncode": 1,
            "error": None,
        }

    monkeypatch.setattr(provider, "_run_process", fake_run_process)
    request = InpaintRequest(
        provider="stable_audio_mlx",
        model="sm-sfx",
        prompt="replace tiny regions",
        input_audio_path=str(input_path),
        inpaint_ranges=[(0.1, 0.2), (0.3, 0.4)],
        duration=0.5,
        output_name="pytest_mlx_multi_fail",
    )

    result = provider.inpaint(request)
    assert result.status == "error"
    assert len(calls) == 2
    assert not list((settings.output_root / "intermediate").glob("pytest_mlx_multi_fail_*_range_*.wav"))


def test_python_lora_uses_stable_audio_model_methods() -> None:
    class DummyModel:
        def __init__(self) -> None:
            self.loaded: list[list[str]] = []
            self.strengths: list[tuple[float, int | None]] = []

        def load_lora(self, paths: list[str]) -> str:
            self.loaded.append(paths)
            return "ok"

        def set_lora_strength(self, strength: float, lora_index: int | None = None) -> None:
            self.strengths.append((strength, lora_index))

    lora_dir = settings.output_root / "lora"
    lora_dir.mkdir(parents=True, exist_ok=True)
    lora_path = lora_dir / "style.safetensors"
    lora_path.write_bytes(b"placeholder")

    provider = StableAudioPythonProvider(storage)
    dummy = DummyModel()
    provider.model = dummy
    result = provider.load_lora([str(lora_path)])
    provider.set_lora_strength(0.5, lora_index=0)

    resolved = str(lora_path.resolve())
    assert result["loaded_loras"] == [resolved]
    assert dummy.loaded == [[resolved]]
    assert dummy.strengths == [(0.5, 0)]


def test_python_lora_rejects_checkpoint_outside_allowed_roots(tmp_path: Path) -> None:
    lora_path = tmp_path / "style.safetensors"
    lora_path.write_bytes(b"placeholder")

    provider = StableAudioPythonProvider(storage)
    provider.model = object()
    try:
        provider.load_lora([str(lora_path)])
    except PermissionError as exc:
        assert "allowed model root" in str(exc)
    else:
        raise AssertionError("external LoRA checkpoint should be rejected")


def test_files_rename_endpoint() -> None:
    audio_path = settings.output_root / "audio" / "pytest_rename_test.wav"
    metadata_path = settings.output_root / "audio" / "pytest_rename_test.json"
    new_audio_path = settings.output_root / "audio" / "pytest_renamed_ok.wav"
    new_metadata_path = settings.output_root / "audio" / "pytest_renamed_ok.json"
    new_audio_path.unlink(missing_ok=True)
    new_metadata_path.unlink(missing_ok=True)
    audio_path.parent.mkdir(parents=True, exist_ok=True)
    write_sine_wav(audio_path, duration=0.25)
    
    # Create valid metadata JSON
    metadata = {
        "sound_id": "sound_pytest_rename_test",
        "output_audio_path": "output/audio/pytest_rename_test.wav",
        "absolute_output_audio_path": str(audio_path.resolve()),
        "metadata_path": "output/audio/pytest_rename_test.json",
        "absolute_metadata_path": str(metadata_path.resolve()),
        "prompt": "test renaming files",
        "tags": ["test"],
        "lineage": {
            "id": "sound_pytest_rename_test",
            "audio_path": "output/audio/pytest_rename_test.wav",
            "metadata_path": "output/audio/pytest_rename_test.json"
        }
    }
    metadata_path.write_text(json.dumps(metadata), encoding="utf-8")

    # Rename
    response = client.post(
        "/files/rename",
        json={
            "audio_path": storage.relative_path(audio_path),
            "metadata_path": storage.relative_path(metadata_path),
            "new_stem": "pytest_renamed_ok"
        }
    )
    assert response.status_code == 200
    assert response.json()["status"] == "ok"
    
    assert new_audio_path.exists()
    assert new_metadata_path.exists()
    assert not audio_path.exists()
    assert not metadata_path.exists()
    
    # Verify metadata updates
    updated_meta = json.loads(new_metadata_path.read_text(encoding="utf-8"))
    assert updated_meta["sound_id"] == "sound_pytest_renamed_ok"
    assert updated_meta["output_audio_path"] == storage.relative_path(new_audio_path)
    assert updated_meta["metadata_path"] == storage.relative_path(new_metadata_path)
    assert updated_meta["lineage"]["id"] == "sound_pytest_renamed_ok"
    assert updated_meta["lineage"]["audio_path"] == storage.relative_path(new_audio_path)
    assert updated_meta["lineage"]["metadata_path"] == storage.relative_path(new_metadata_path)


def test_files_rename_conflict_preserves_source() -> None:
    audio_path = settings.output_root / "audio" / "pytest_rename_conflict_source.wav"
    metadata_path = settings.output_root / "audio" / "pytest_rename_conflict_source.json"
    target_path = settings.output_root / "audio" / "pytest_rename_conflict_target.wav"
    target_metadata_path = settings.output_root / "audio" / "pytest_rename_conflict_target.json"
    audio_path.parent.mkdir(parents=True, exist_ok=True)
    for path in (audio_path, metadata_path, target_path, target_metadata_path):
        path.unlink(missing_ok=True)

    write_sine_wav(audio_path, duration=0.1)
    metadata_path.write_text(
        json.dumps({"output_audio_path": storage.relative_path(audio_path)}),
        encoding="utf-8",
    )
    target_path.write_bytes(b"existing-target")

    response = client.post(
        "/files/rename",
        json={
            "audio_path": storage.relative_path(audio_path),
            "metadata_path": storage.relative_path(metadata_path),
            "new_stem": "pytest_rename_conflict_target",
        },
    )
    assert response.status_code == 400
    assert audio_path.exists()
    assert metadata_path.exists()
    assert target_path.read_bytes() == b"existing-target"


def test_files_bulk_delete_endpoint() -> None:
    audio_path1 = settings.output_root / "audio" / "pytest_delete_1.wav"
    metadata_path1 = settings.output_root / "audio" / "pytest_delete_1.json"
    audio_path2 = settings.output_root / "audio" / "pytest_delete_2.wav"
    
    audio_path1.parent.mkdir(parents=True, exist_ok=True)
    write_sine_wav(audio_path1, duration=0.1)
    metadata_path1.write_text("{}", encoding="utf-8")
    write_sine_wav(audio_path2, duration=0.1)
    
    assert audio_path1.exists()
    assert metadata_path1.exists()
    assert audio_path2.exists()
    
    response = client.post(
        "/files/delete",
        json={
            "items": [
                {
                    "audio_path": storage.relative_path(audio_path1),
                    "metadata_path": storage.relative_path(metadata_path1)
                },
                {
                    "audio_path": storage.relative_path(audio_path2),
                    "metadata_path": None
                }
            ]
        }
    )
    assert response.status_code == 200
    assert response.json()["status"] == "ok"
    assert int(response.json()["deleted_count"]) == 2
    
    assert not audio_path1.exists()
    assert not metadata_path1.exists()
    assert not audio_path2.exists()


def test_files_bulk_delete_rejects_more_than_500_items() -> None:
    response = client.post(
        "/files/delete",
        json={
            "items": [
                {
                    "audio_path": "output/audio/does-not-exist.wav",
                    "metadata_path": None,
                }
                for _ in range(501)
            ]
        },
    )
    assert response.status_code == 400
    assert "max 500" in response.json()["detail"]
