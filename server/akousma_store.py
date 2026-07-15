"""germ ↔ akousmata: access to the shared sonic-memory store.

The akousma protocol (earworm/docs/akousma_spec_v1.md) gives every sound one memory
record; the shared platform-data store (or ``$AKOUSMATA_PATH``) spans
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
from urllib.parse import urlsplit
from urllib.request import url2pathname


class AkousmaUnavailable(RuntimeError):
    """The akousma reference package is not installed."""


def _akousma():
    try:
        import akousma
    except ModuleNotFoundError as exc:  # pragma: no cover - environment-dependent
        raise AkousmaUnavailable(
            "the 'akousma' package is not installed; "
            "reinstall germ with its declared dependencies"
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
        return path if path and path.is_file() else None
    if uri.startswith("file://"):
        parsed = urlsplit(uri)
        if parsed.netloc and parsed.netloc.lower() != "localhost":
            return None
        path = Path(url2pathname(parsed.path))
        return path if path.is_file() else None
    path = Path(uri).expanduser()
    return path if path.is_absolute() and path.is_file() else None


_PROMPT_KEYS = (
    "generative_prompt",
    "transformation_prompt",
    "prompt",
    "main_reading",
    "brief",
    "summary",
    "short_summary",
    "detailed_summary",
    "caption",
    "description",
    "notes",
    "text",
)
_NESTED_PROMPT_KEYS = (
    "akouo_output",
    "generative",
    "aggregate",
    "structured",
    "output",
    "result",
)
_PREFERRED_NAMESPACES = (
    "akouo.generative",
    "akouo.describe",
    "oida.generative",
    "oida.listen",
    "oida.moss",
    "oida.signal",
    "human.note",
)

GERM_CONTRACT = "germ/v0.1"
AKOUO_CONTRACT = "akouo/v0.7"
PROMPT_HANDOFF_CONTRACT = "oida-germ.prompt/v0.1"


def _is_listening_envelope(block: Any) -> bool:
    return (
        isinstance(block, dict)
        and "payload" in block
        and ("created_at" in block or "contract" in block)
    )


def _entry_payload(block: dict[str, Any]) -> Any:
    """Unwrap the akousma spec v1.1 listening envelope
    (``{contract?, created_at, summary?, payload}``); raw entries pass through."""
    if _is_listening_envelope(block):
        return block["payload"]
    return block


def _prompt_text(value: Any, *, depth: int = 0) -> str | None:
    if depth > 4:
        return None
    if isinstance(value, str) and value.strip():
        return value.strip()
    if not isinstance(value, dict):
        return None
    envelope_summary = value.get("summary")
    if isinstance(envelope_summary, str) and envelope_summary.strip() and "payload" in value:
        return envelope_summary.strip()
    payload = _entry_payload(value)
    if isinstance(payload, str) and payload.strip():
        return payload.strip()
    if not isinstance(payload, dict):
        return None
    for key in _PROMPT_KEYS:
        text = payload.get(key)
        if isinstance(text, str) and text.strip():
            return text.strip()
    for key in _NESTED_PROMPT_KEYS:
        text = _prompt_text(payload.get(key), depth=depth + 1)
        if text:
            return text
    return None


def derive_prompt_contract(record: dict[str, Any]) -> dict[str, Any]:
    """Build the editable, provenance-preserving Oída → Germ prompt handoff."""
    evidence: list[dict[str, Any]] = []
    listening = record.get("listening") or {}
    record_summary = record.get("summary")

    # A producer may use versioned/dynamic AKOÚŌ namespace names. Prefer an
    # explicit generative/transformation result over a general record summary,
    # then retain the summary as supporting evidence.
    generative_namespaces = [
        str(namespace)
        for namespace in listening
        if any(
            token in str(namespace).casefold() for token in ("generative", "transform", "prompt")
        )
    ]
    for namespace in generative_namespaces:
        block = listening.get(namespace)
        text = _prompt_text(block)
        if text:
            item: dict[str, Any] = {"namespace": namespace, "text": text}
            if isinstance(block, dict) and block.get("contract"):
                item["contract"] = block["contract"]
            evidence.append(item)
    if not evidence and isinstance(record_summary, str) and record_summary.strip():
        evidence.append({"namespace": "record.summary", "text": record_summary.strip()})

    for namespace in _PREFERRED_NAMESPACES:
        if namespace in generative_namespaces:
            continue
        block = listening.get(namespace)
        text = _prompt_text(block)
        if text:
            item: dict[str, Any] = {"namespace": namespace, "text": text}
            if isinstance(block, dict) and block.get("contract"):
                item["contract"] = block["contract"]
            evidence.append(item)
    if (
        evidence
        and generative_namespaces
        and isinstance(record_summary, str)
        and record_summary.strip()
    ):
        evidence.append({"namespace": "record.summary", "text": record_summary.strip()})
    if not evidence:
        for namespace, value in listening.items():
            text = _prompt_text(value)
            if text:
                evidence.append({"namespace": str(namespace), "text": text})
                break

    if not evidence:
        tags = [str(t) for t in record.get("tags") or []]
        if tags:
            evidence.append({"namespace": "record.tags", "text": ", ".join(tags)})

    seen: set[str] = set()
    unique_evidence = []
    for item in evidence:
        normalized = " ".join(str(item["text"]).split())
        key = normalized.casefold()
        if not normalized or key in seen:
            continue
        seen.add(key)
        unique_evidence.append({**item, "text": normalized})
    prompt = ". ".join(item["text"] for item in unique_evidence[:3])[:10_000]

    provenance = record.get("provenance") if isinstance(record.get("provenance"), dict) else {}
    lineage = record.get("lineage") if isinstance(record.get("lineage"), dict) else {}
    source_id = str(record.get("akousma_id") or "")
    source = {
        "kind": "akousma",
        "akousma_id": source_id,
        "schema_version": record.get("schema_version"),
        "originating_app": provenance.get("originating_app"),
        "source_type": provenance.get("source_type"),
        "origin": provenance.get("origin"),
        "session_id": record.get("session_id"),
    }
    source = {key: value for key, value in source.items() if value not in (None, "")}
    covenant = record.get("covenant") if isinstance(record.get("covenant"), dict) else {}
    safe_covenant = {
        key: covenant.get(key)
        for key in (
            "id",
            "name",
            "version",
            "contract",
            "sha256",
            "extends",
            "rules_applied",
            "withheld",
            "commitments",
            "note",
        )
        if covenant.get(key) not in (None, "", [], {})
    }
    return {
        "contract": PROMPT_HANDOFF_CONTRACT,
        "editable": True,
        "source": source,
        "base_prompt": prompt,
        "prompt": prompt,
        "negative_prompt": "",
        "evidence": unique_evidence[:8],
        "generation_context": {
            "bridge": "oida-hears-germ-cultivates",
            "source_operation": lineage.get("operation"),
            "source_model": lineage.get("model"),
            "listening_namespaces": [item["namespace"] for item in unique_evidence[:8]],
        },
        "parent_akousma_ids": [source_id] if source_id else [],
        "remember_to_akousmata": True,
        "covenant": safe_covenant,
    }


def derive_prompt(record: dict[str, Any]) -> str:
    """Compatibility helper returning only the editable prompt text."""
    return str(derive_prompt_contract(record)["prompt"])


def _envelope_listening(listening: dict[str, Any]) -> dict[str, Any]:
    """Envelope listening output without rewriting foreign producer blocks.

    germ-authored entries receive the germ contract and raw AKOÚŌ output receives
    the installed v0.7 contract pin. Existing envelopes and other producers'
    entries pass through unchanged, preserving the additive ownership rule.
    """
    from server.storage import utc_now_iso

    wrapped: dict[str, Any] = {}
    for namespace, value in (listening or {}).items():
        if _is_listening_envelope(value):
            wrapped[namespace] = value
            continue

        if namespace.startswith("germ."):
            contract = GERM_CONTRACT
        elif namespace.startswith("akouo."):
            contract = AKOUO_CONTRACT
        else:
            wrapped[namespace] = value
            continue

        entry: dict[str, Any] = {"created_at": utc_now_iso(), "payload": value}
        entry["contract"] = contract
        if isinstance(value, dict):
            for key in ("summary", "caption", "brief", "main_reading", "notes", "description"):
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
        "operation": str(
            lineage.get("operation")
            or metadata.get("operation")
            or metadata.get("mode")
            or "generate"
        ),
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
    the most recent holder (spec v1.1 relations)."""
    akousma = _akousma()
    content_hash = str(record.get("audio", {}).get("content_hash") or "")
    if not content_hash:
        return
    matches = [
        candidate
        for candidate in store.find_by_hash(content_hash)
        if candidate.get("akousma_id") != record.get("akousma_id")
    ]
    if not matches:
        return
    relations = record.setdefault("lineage", {}).setdefault("relations", [])
    newest = matches[0]
    if not any(
        relation.get("type") == "same_source_as"
        and relation.get("target_akousma_id") == newest["akousma_id"]
        for relation in relations
    ):
        relations.append(
            akousma.relation(
                "same_source_as",
                newest["akousma_id"],
                note="Same audio content hash already in the akousmata.",
            )
        )


_COVENANT_FIELDS = {
    "id",
    "name",
    "version",
    "contract",
    "sha256",
    "extends",
    "rules_applied",
    "withheld",
    "commitments",
    "note",
}


def _normalize_covenant(value: dict[str, Any] | None) -> dict[str, Any] | None:
    """Validate known v1.3 fields while preserving future covenant vocabulary."""
    if not value:
        return None
    covenant_id = value.get("id")
    if not isinstance(covenant_id, str) or not covenant_id.strip():
        raise ValueError("covenant.id must be a non-empty string")

    akousma = _akousma()
    normalized = akousma.covenant(
        covenant_id.strip(),
        name=value.get("name"),
        version=value.get("version"),
        contract=value.get("contract") or AKOUO_CONTRACT,
        sha256_hex=value.get("sha256"),
        extends=value.get("extends"),
        rules_applied=value.get("rules_applied"),
        withheld=value.get("withheld"),
        commitments=value.get("commitments"),
        note=value.get("note"),
    )
    extras = {key: item for key, item in value.items() if key not in _COVENANT_FIELDS}
    return {**extras, **normalized}


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
    covenant: dict[str, Any] | None = None,
    store=None,
) -> dict[str, Any]:
    """Write a germ generation into the shared store as a new akousma
    (spec v1.3).

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
    path = Path(audio_path).expanduser().resolve(strict=True)
    if not path.is_file():
        raise ValueError(f"audio_path must point to a file: {audio_path}")
    data = path.read_bytes()

    all_extensions = dict(extensions or {})
    if germ_lineage:
        all_extensions.setdefault("germ.lineage", dict(germ_lineage))

    record_summary = (summary or "").strip() or (prompt or "").strip()
    if record_summary:
        record_summary = f"germ {operation}: {record_summary}"[:200]
    normalized_covenant = _normalize_covenant(covenant)

    owns_store = store is None
    store = store or open_store()
    try:
        missing_parents = [
            parent_id for parent_id in (parent_akousma_ids or []) if store.get(parent_id) is None
        ]
        if missing_parents:
            raise ValueError(
                "unknown parent akousma id(s): " + ", ".join(sorted(set(missing_parents)))
            )
        record = akousma.new_akousma(
            audio={
                "asset_id": path.stem,
                "type": "generation",
                "uri": path.as_uri(),
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
            relations=relations or None,
            tags=tags,
            extensions=all_extensions,
            session_id=session_id,
            summary=record_summary or None,
            covenant=normalized_covenant,
        )
        _maybe_link_recurrence(store, record)
        store.put(record)
        return record
    finally:
        if owns_store:
            store.close()
