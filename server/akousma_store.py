"""germ ↔ akousmata: access to the shared sonic-memory store.

The akousma protocol (earworm/docs/akousma_spec_v1.md) gives every sound one memory
record; the shared store (``~/workspace/akousmata``, ``$AKOUSMATA_PATH``) spans
oída, germ, and algophony. germ reads records handed over by oída ("open as sound /
prompt / explore lineage") and writes a new akousma for material it generates, with
``lineage.parent_akousma_ids`` pointing at the sources.

The ``akousma`` package is the Python reference implementation that lives in the
earworm repo (``earworm/packages/py-akousma``). It is imported lazily so the server
still boots without it; the routes degrade to 503.
"""
from __future__ import annotations

from hashlib import sha256
from pathlib import Path
from typing import Any


class AkousmaUnavailable(RuntimeError):
    """The akousma reference package is not installed."""


def _akousma():
    try:
        import akousma
    except ModuleNotFoundError as exc:  # pragma: no cover - environment-dependent
        raise AkousmaUnavailable(
            "the 'akousma' package is not installed; "
            "pip install -e <SFL>/earworm/packages/py-akousma"
        ) from exc
    return akousma


def open_store():
    """Open the shared akousmata store (honors AKOUSMATA_PATH at call time)."""
    akousma = _akousma()
    return akousma.AkousmataStore()


def resolve_audio_path(store, record: dict[str, Any]) -> Path | None:
    """Resolve a record's audio to a local file path (store object or file uri)."""
    audio = record.get("audio") or {}
    uri = str(audio.get("uri") or "")
    if not uri:
        return None
    if uri.startswith("akousmata://"):
        path = store.resolve_uri(uri)
        return path if path and path.exists() else None
    if uri.startswith("file://"):
        path = Path(uri[len("file://"):])
        return path if path.exists() else None
    path = Path(uri).expanduser()
    return path if path.is_absolute() and path.exists() else None


_PROMPT_KEYS = ("summary", "caption", "description", "text", "prompt")
_PREFERRED_NAMESPACES = ("akouo.describe", "oida.moss", "oida.signal")


def derive_prompt(record: dict[str, Any]) -> str:
    """Turn a record's listening block into a generation prompt for germ."""
    listening = record.get("listening") or {}
    fragments: list[str] = []

    def collect(block: Any) -> None:
        if isinstance(block, str) and block.strip():
            fragments.append(block.strip())
        elif isinstance(block, dict):
            for key in _PROMPT_KEYS:
                value = block.get(key)
                if isinstance(value, str) and value.strip():
                    fragments.append(value.strip())

    for namespace in _PREFERRED_NAMESPACES:
        collect(listening.get(namespace))
    if not fragments:
        for value in listening.values():
            collect(value)
            if fragments:
                break

    if not fragments:
        tags = [str(t) for t in record.get("tags") or []]
        if tags:
            fragments.append(", ".join(tags))

    seen: set[str] = set()
    unique = [f for f in fragments if not (f in seen or seen.add(f))]
    return ". ".join(unique[:2])


def record_generation(
    *,
    audio_path: str | Path,
    prompt: str = "",
    model: str = "",
    operation: str = "generate",
    params: dict[str, Any] | None = None,
    parent_akousma_ids: list[str] | None = None,
    listening: dict[str, Any] | None = None,
    tags: list[str] | None = None,
    extensions: dict[str, Any] | None = None,
    store=None,
) -> dict[str, Any]:
    """Write a germ generation into the shared store as a new akousma.

    The audio stays where germ wrote it (referenced by ``file://`` uri +
    content hash); lineage points at the source akousmata.
    """
    akousma = _akousma()
    path = Path(audio_path).expanduser().resolve()
    data = path.read_bytes()

    owns_store = store is None
    store = store or open_store()
    try:
        record = akousma.new_akousma(
            audio={
                "asset_id": path.stem,
                "type": "generation",
                "uri": f"file://{path}",
                "content_hash": f"sha256:{sha256(data).hexdigest()}",
            },
            originating_app="germ",
            source_type="generated",
            origin="generated",
            listening=listening,
            parent_akousma_ids=parent_akousma_ids or [],
            operation=operation,
            prompt=prompt or None,
            model=model or None,
            params=params,
            tags=tags,
            extensions=extensions,
        )
        store.put(record)
        return record
    finally:
        if owns_store:
            store.close()
