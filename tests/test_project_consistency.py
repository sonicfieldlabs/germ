from __future__ import annotations

from collections import Counter
from pathlib import Path

from server.identity import __version__


PROJECT_ROOT = Path(__file__).resolve().parents[1]
CANONICAL_GERM_PORT = "5178"


def _read(relative_path: str) -> str:
    return (PROJECT_ROOT / relative_path).read_text(encoding="utf-8")


def test_runtime_entrypoints_share_the_canonical_germ_port() -> None:
    runtime_contracts = (
        ".env.example",
        "scripts/run_server.sh",
        "scripts/run_dashboard.sh",
        "launch_germ.command",
        "clients/curl_examples.sh",
        "dashboard/static/index.html",
        "dashboard/static/dish.js",
    )

    for relative_path in runtime_contracts:
        text = _read(relative_path)
        assert CANONICAL_GERM_PORT in text, f"{relative_path} lost the canonical Germ port"
        germ_entrypoint_text = "\n".join(
            line for line in text.splitlines() if not line.startswith("GERM_OIDA_URL=")
        )
        assert "8765" not in germ_entrypoint_text, f"{relative_path} still points at Oída's port"

    assert "GERM_OIDA_URL=http://127.0.0.1:8765" in _read(".env.example")


def test_akousma_dependency_matches_the_current_earworm_store_contract() -> None:
    project = _read("pyproject.toml")
    assert '"akousma>=0.8.3"' in project
    # Current policy APIs and object safety must survive an isolated wheel install.
    assert 'path = "vendor/akousma-0.8.3-py3-none-any.whl"' in project
    assert '"akouo-contract>=0.10.0"' in project
    assert 'path = "vendor/akouo_contract-0.10.0-py3-none-any.whl"' in project
    from akouo_contract.record_workflows import derivation_plan
    from akousma.record_evolution import next_record_errors
    from akousma.retained_policy import retained_covenant, blocks_untyped_prose
    assert callable(derivation_plan) and callable(next_record_errors)
    assert blocks_untyped_prose(retained_covenant({"provenance": {"consent_status": "restricted"}}))


def test_stable_audio_uses_the_audited_torch_override() -> None:
    project = _read("pyproject.toml")
    assert '"torch==2.10.0"' in project
    assert '"torchaudio==2.10.0"' in project


def test_release_version_is_consistent_across_runtime_and_packaging() -> None:
    assert __version__ == "0.6.1"
    assert 'version = "0.6.1"' in _read("pyproject.toml")
    assert "Current release: `0.6.1`." in _read("README.md")
    assert 'version: "0.6.1"' in _read("CITATION.cff")
    assert 'date-released: "2026-09-12"' in _read("CITATION.cff")
    assert 'MARKETING_VERSION="0.6.1"' in _read("apps/macos/script/build_and_run.sh")
    assert 'BUNDLE_VERSION="9"' in _read("apps/macos/script/build_and_run.sh")


def test_openapi_operation_ids_are_present_and_unique() -> None:
    from server.main import app

    methods = {"get", "post", "put", "patch", "delete", "options", "head", "trace"}
    operation_ids = [
        operation.get("operationId")
        for path_item in app.openapi()["paths"].values()
        for method, operation in path_item.items()
        if method.lower() in methods
    ]
    assert all(operation_ids)
    duplicates = {
        operation_id: count for operation_id, count in Counter(operation_ids).items() if count > 1
    }
    assert duplicates == {}
