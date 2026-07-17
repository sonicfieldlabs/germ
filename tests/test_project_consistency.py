from __future__ import annotations

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
    assert '"akousma>=0.4.0"' in project
    assert 'tag = "v0.4.0"' in project
    assert 'subdirectory = "packages/py-akousma"' in project
    assert 'path = "../earworm' not in project


def test_release_version_is_consistent_across_runtime_and_packaging() -> None:
    assert __version__ == "0.2.5"
    assert 'version = "0.2.5"' in _read("pyproject.toml")
    assert 'Current release: `0.2.5`.' in _read("README.md")
    assert 'version: "0.2.5"' in _read("CITATION.cff")
    assert 'MARKETING_VERSION="0.2.5"' in _read("apps/macos/script/build_and_run.sh")
