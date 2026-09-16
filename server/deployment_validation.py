"""Model-free validation of the fields consumed by isolated workers.

Structural admission is cheap enough to run before queue creation. Providers
still verify every artifact digest when executing; admission is not inference.
"""

import os
import re
from pathlib import Path


def validate_manifest(value, *, worker, adapter, limits):
    if not isinstance(value, dict):
        raise ValueError("Deployment must be an object")
    for field in ("revision", "python", "evaluation_sha256"):
        if not isinstance(value.get(field), str) or not value[field].strip():
            raise ValueError(f"Deployment requires {field}")
    files = value.get("files")
    if not isinstance(files, dict) or not files:
        raise ValueError("Deployment requires artifact hashes")
    for name, digest in files.items():
        if not isinstance(name, str) or not Path(name).is_absolute():
            raise ValueError("Deployment artifact paths must be absolute")
        if not isinstance(digest, str) or not re.fullmatch(r"[0-9a-f]{64}", digest):
            raise ValueError("Deployment artifact hashes must be SHA-256")
    evaluation = value["evaluation_sha256"]
    if not re.fullmatch(r"[0-9a-f]{64}", evaluation) or evaluation not in files.values():
        raise ValueError("Deployment evaluation must be bound to an artifact")
    if not any(digest == evaluation and Path(name).is_file() for name, digest in files.items()):
        raise ValueError("Deployment evaluation artifact is missing")
    python = Path(value["python"])
    if not python.is_absolute() or not python.is_file() or not os.access(python, os.X_OK):
        raise ValueError("Deployment requires an executable interpreter")
    for required in (python.resolve(), Path(worker).resolve(), Path(__file__).resolve(),
                     Path(worker).with_name("deployment.py").resolve(), Path(adapter).resolve()):
        if str(required) not in files:
            raise ValueError("Deployment must bind interpreter, worker, adapter and admission validators")
    actual = value.get("limits")
    if not isinstance(actual, dict) or any(
        type(actual.get(key)) is not type(expected) or actual[key] != expected
        for key, expected in limits.items()
    ):
        raise ValueError("Deployment limits differ from the admitted profile")


def require_artifact(value, field):
    name = value.get(field)
    if not isinstance(name, str) or not Path(name).is_absolute():
        raise ValueError(f"Deployment requires absolute {field}")
    if not Path(name).is_file() or name not in value["files"]:
        raise ValueError(f"Deployment must bind {field}")
