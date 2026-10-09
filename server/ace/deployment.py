"""Validate the local ACE-Step receipt without importing the model runtime."""

import hashlib
import json
import os
from pathlib import Path

from server.deployment_validation import validate_manifest


def sha(path):
    with Path(path).open("rb") as stream:
        digest = hashlib.sha256()
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(chunk)
        return digest.hexdigest()


def deployment(verify=False):
    filename = os.environ.get("GERM_ACE_CONFIG")
    if not filename:
        raise ValueError("ACE-Step has not been provisioned and evaluated locally")
    value = json.loads(Path(filename).read_text())
    validate_manifest(
        value, worker=Path(__file__).with_name("worker.py"),
        adapter=Path(__file__).parents[1] / "providers/ace_step_provider.py",
        limits=dict(max_duration=30, max_job_seconds=300, concurrency=1, planner=False),
    )
    if (
        value.get("status") != "admitted"
        or value.get("model") != "acestep-v15-turbo"
        or not value.get("revision")
        or not value.get("files")
    ):
        raise ValueError("ACE-Step deployment is not admitted")
    import re

    if any(not isinstance(value.get(key), str) or not re.fullmatch(r"[0-9a-f]{40}", value[key])
           for key in ("revision", "runtime_commit")):
        raise ValueError("ACE-Step requires exact source and runtime revisions")
    root = value.get("checkpoints")
    if not isinstance(root, str) or not Path(root).is_absolute():
        raise ValueError("ACE-Step requires an absolute checkpoints directory")
    for component in ("acestep-v15-turbo", "vae", "Qwen3-Embedding-0.6B"):
        directory = Path(root) / component
        if not directory.is_dir() or not any(
            Path(name).is_relative_to(directory) and Path(name).is_file() for name in value["files"]
        ):
            raise ValueError("ACE-Step checkpoint components must be present and bound")
    if verify and any(sha(path) != digest for path, digest in value["files"].items()):
        raise ValueError("ACE-Step artifact changed after evaluation")
    return value


def music_parameters(value):
    from pydantic import BaseModel, ConfigDict, Field
    from typing import Literal

    class Music(BaseModel):
        model_config = ConfigDict(extra="forbid", allow_inf_nan=False)
        bpm: float | None = Field(default=None, ge=30, le=300)
        key: str = Field(default="", max_length=20)
        meter: Literal["", "2", "3", "4", "6"] = ""
        lyrics: str = Field(default="", max_length=4096)
        language: str = Field(default="unknown", pattern=r"^(unknown|[a-z]{2})$")

    return Music.model_validate(value).model_dump(exclude_none=True)
