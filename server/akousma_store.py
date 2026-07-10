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


_PROMPT_KEYS = ("summary", "caption", "description", "text", "prompt", "main_reading", "notes")
_PREFERRED_NAMESPACES = ("akouo.describe", "oida.moss", "oida.signal", "human.note")

GERM_CONTRACT = "germ/v0.1"


def _entry_payload(block: dict[str, Any]) -> dict[str, Any]:
    """Unwrap the akousma spec v1.1 listening envelope
    (``{contract?, created_at, summary?, payload}``); raw entries pass through."""
    payload = block.get("payload")
    if isinstance(payload, dict) and ("created_at" in block or "contract" in block):
        return payload
    return block


def derive_prompt(record: dict[str, Any]) -> str:
    """Turn a record's memory into a generation prompt for germ. Prefers the
    record's own skimmable summary (spec v1.1), then listening entries (both
    raw v1.0 and enveloped v1.1 shapes)."""
    fragments: list[str] = []
    record_summary = record.get("summary")
    if isinstance(record_summary, str) and record_summary.strip():
        fragments.append(record_summary.strip())

    listening = record.get("listening") or {}

    def collect(block: Any) -> None:
        if isinstance(block, str) and block.strip():
            fragments.append(block.strip())
        elif isinstance(block, dict):
            envelope_summary = block.get("summary")
            if isinstance(envelope_summary, str) and envelope_summary.strip() and "payload" in block:
                fragments.append(envelope_summary.strip())
                return
            payload = _entry_payload(block)
            for key in _PROMPT_KEYS:
                value = payload.get(key)
                if isinstance(value, str) and value.strip():
                    fragments.append(value.strip())
                    return

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


def _envelope_listening(listening: dict[str, Any]) -> dict[str, Any]:
    """Wrap raw producer payloads in the spec v1.1 envelope; germ.* entries get
    the germ contract pin. Pre-enveloped entries pass through untouched."""
    from server.storage import utc_now_iso

    wrapped: dict[str, Any] = {}
    for namespace, value in (listening or {}).items():
        if isinstance(value, dict) and "payload" in value and set(value) <= {"contract", "created_at", "summary", "payload"}:
            wrapped[namespace] = value
            continue
        entry: dict[str, Any] = {"created_at": utc_now_iso(), "payload": value}
        if namespace.startswith("germ."):
            entry["contract"] = GERM_CONTRACT
        if isinstance(value, dict):
            for key in ("summary", "caption", "notes", "main_reading"):
                text = value.get(key)
                if isinstance(text, str) and text.strip():
                    entry["summary"] = text.strip()
                    break
        wrapped[namespace] = entry
    return wrapped


def organism_lineage_extension(metadata: dict[str, Any]) -> dict[str, Any]:
    """The Stable Audio cultivation lineage, recorded ONCE per akousma.

    germ's organism metadata carries the SA-side lineage (organism parents by
    ``sound_id``, operation, generation context, latents); the akousma carries
    only the id-level genealogy in ``lineage.parent_akousma_ids``. This
    extension holds the SA detail so neither system duplicates the other:
    organism ids stay canonical inside germ, akousma ids stay canonical in
    the store, and the earworm event chain is reachable via ``session_id``
    (``sess_<sound_id>``, the same id ``metadata_to_earworm_session`` emits).
    """
    lineage = metadata.get("lineage") if isinstance(metadata.get("lineage"), dict) else {}
    parents = lineage.get("parents") or metadata.get("parents") or []
    extension: dict[str, Any] = {
        "organism_id": str(metadata.get("sound_id") or metadata.get("id") or ""),
        "operation": str(lineage.get("operation") or metadata.get("operation") or metadata.get("mode") or "generate"),
        "organism_parents": [str(p) for p in parents if p],
        "generation_index": len(parents) + 1 if isinstance(parents, list) else 1,
    }
    for key in ("model", "provider", "seed", "germinator_mode"):
        if metadata.get(key) not in (None, ""):
            extension[key] = metadata[key]
    if isinstance(metadata.get("operation_params"), dict) and metadata["operation_params"]:
        extension["operation_params"] = metadata["operation_params"]
    if metadata.get("latents") not in (None, "", {}, []):
        extension["has_latents"] = True
    return extension


def _maybe_link_recurrence(store, record: dict[str, Any]) -> None:
    """Same audio content already in the store → ``same_source_as`` kinship to
    the most recent holder (spec v1.1 relations). Best-effort."""
    try:
        akousma = _akousma()
        content_hash = str(record.get("audio", {}).get("content_hash") or "")
        if not content_hash or not hasattr(store, "find_by_hash") or not hasattr(akousma, "relation"):
            return
        matches = [r for r in store.find_by_hash(content_hash) if r.get("akousma_id") != record.get("akousma_id")]
        if not matches:
            return
        relations = record.setdefault("lineage", {}).setdefault("relations", [])
        newest = matches[0]
        if not any(rel.get("target_akousma_id") == newest["akousma_id"] for rel in relations):
            relations.append(akousma.relation("same_source_as", newest["akousma_id"], note="Same audio content hash already in the akousmata."))
    except Exception:
        pass


def record_generation(
    *,
    audio_path: str | Path,
    prompt: str = "",
    model: str = "",
    operation: str = "generate",
    params: dict[str, Any] | None = None,
    parent_akousma_ids: list[str] | None = None,
    relations: list[dict[str, Any]] | None = None,
    listening: dict[str, Any] | None = None,
    tags: list[str] | None = None,
    extensions: dict[str, Any] | None = None,
    summary: str | None = None,
    session_id: str | None = None,
    germ_lineage: dict[str, Any] | None = None,
    store=None,
) -> dict[str, Any]:
    """Write a germ generation into the shared store as a new akousma
    (spec v1.1).

    The audio stays where germ wrote it (referenced by ``file://`` uri +
    content hash); ``lineage.parent_akousma_ids`` points at the source
    akousmata; the Stable Audio cultivation detail goes ONCE into
    ``extensions["germ.lineage"]`` (see ``organism_lineage_extension``);
    ``session_id`` links the record to the earworm event chain germ emits for
    the same organism (``sess_<sound_id>``). Listening entries are wrapped in
    the v1.1 envelope, records carry a skimmable summary, and a recurrence of
    the same audio content links back as ``same_source_as`` kinship.
    """
    akousma = _akousma()
    path = Path(audio_path).expanduser().resolve()
    data = path.read_bytes()

    all_extensions = dict(extensions or {})
    if germ_lineage:
        all_extensions.setdefault("germ.lineage", dict(germ_lineage))

    record_summary = (summary or "").strip() or (prompt or "").strip()
    if record_summary:
        record_summary = f"germ {operation}: {record_summary}"[:200]

    owns_store = store is None
    store = store or open_store()
    try:
        kwargs: dict[str, Any] = {}
        if record_summary:
            kwargs["summary"] = record_summary
        if relations:
            kwargs["relations"] = relations
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
                listening=_envelope_listening(listening or {}),
                parent_akousma_ids=parent_akousma_ids or [],
                operation=operation,
                prompt=prompt or None,
                model=model or None,
                params=params,
                tags=tags,
                extensions=all_extensions,
                session_id=session_id,
                **kwargs,
            )
        except TypeError:
            # pre-v0.2 py-akousma without summary/relations keywords
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
                extensions=all_extensions,
                session_id=session_id,
            )
        _maybe_link_recurrence(store, record)
        store.put(record)
        return record
    finally:
        if owns_store:
            store.close()
