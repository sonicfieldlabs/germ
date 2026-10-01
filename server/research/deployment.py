import hashlib
import json
import os
from pathlib import Path

from server.deployment_validation import require_artifact, validate_manifest


def sha(path):
    value = hashlib.sha256()
    with Path(path).open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            value.update(chunk)
    return value.hexdigest()


def deployment(tool, verify=False):
    path = os.getenv("GERM_RESEARCH_CONFIG")
    if not path:
        raise ValueError("Research instruments are not provisioned")
    config = json.loads(Path(path).read_text())
    if not isinstance(config, dict) or not isinstance(config.get("tools"), dict):
        raise ValueError("Research deployment requires a tools object")
    if tool not in {"basic-pitch", "rave-guitar"} or tool not in config["tools"]:
        raise ValueError("Research tool is not admitted")
    entry = config["tools"][tool]
    validate_manifest(
        entry, worker=Path(__file__).with_name("worker.py"),
        adapter=Path(__file__).parents[1] / "providers/research_provider.py",
        limits=dict(max_seconds=30, max_job_seconds=180, concurrency=1, offline=True),
    )
    require_artifact(entry, "model_path")
    if not isinstance(entry.get("license"), str) or not entry["license"].strip():
        raise ValueError("Research deployment requires a license")
    if (
        entry.get("status") != "admitted"
        or entry.get("tool") != tool
        or not entry.get("files")
        or not entry.get("revision")
        or entry.get("limits", {}).get("max_seconds") != 30
        or entry.get("profile") not in {"general", "noncommercial_research"}
    ):
        raise ValueError("Research deployment has not passed admission")
    if (
        entry.get("profile") == "noncommercial_research"
        and os.getenv("GERM_RESEARCH_PROFILE", "general") != "noncommercial_research"
    ):
        raise ValueError("This instrument requires the noncommercial research profile")
    if tool == "rave-guitar" and entry["profile"] != "noncommercial_research":
        raise ValueError("RAVE requires the noncommercial research profile")
    if verify:
        for name, digest in entry["files"].items():
            if sha(name) != digest:
                raise ValueError("Research artifact changed after admission")
    return entry
