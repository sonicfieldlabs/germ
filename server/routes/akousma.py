"""The oída → germ receiving side of the akousma bridge.

oída hands sounds to germ via deep links (see germ/docs/oida-integration.md):

    /import?akousma=<akousma_id>&mode=sound|prompt|lineage

- ``sound``   — pull the audio out of the shared akousmata store and import it into
  germ's library through the standard audio-import flow (same lineage metadata).
- ``prompt``  — turn the record's listening block into a generation prompt.
- ``lineage`` — the lineage explorer: the record, its parents, children, ancestry.

JSON surface for the dashboard and agents:

    GET  /akousma/record/{id}     the raw record
    GET  /akousma/lineage/{id}    record + resolved parents/children + ancestor ids
    POST /akousma/generation      write a germ generation as a new akousma
"""
from __future__ import annotations

import html
import json
import os
from io import BytesIO
from typing import Any

from fastapi import APIRouter, HTTPException, UploadFile
from fastapi.responses import HTMLResponse, JSONResponse
from pydantic import BaseModel, Field

from server.akousma_store import (
    AkousmaUnavailable,
    derive_prompt,
    open_store,
    record_generation,
    resolve_audio_path,
)
from server.routes.import_audio import import_audio
from server.storage import utc_now_iso

router = APIRouter()

MODES = ("sound", "prompt", "lineage")


def _store():
    try:
        return open_store()
    except AkousmaUnavailable as exc:
        raise HTTPException(status_code=503, detail=str(exc)) from exc


def _get_record(store, akousma_id: str) -> dict[str, Any]:
    record = store.get(akousma_id)
    if record is None:
        raise HTTPException(status_code=404, detail=f"akousma not found: {akousma_id}")
    return record


def _oida_url() -> str:
    return os.getenv("GERM_OIDA_URL", "http://127.0.0.1:8765").rstrip("/")


# ── /import — the three buttons ────────────────────────────────────────────────


@router.get("/import", include_in_schema=True)
async def import_akousma(akousma: str, mode: str = "sound", format: str = "html"):
    if mode not in MODES:
        raise HTTPException(status_code=400, detail=f"mode must be one of {MODES}")

    store = _store()
    try:
        record = _get_record(store, akousma)

        if mode == "sound":
            payload = await _import_as_sound(store, record)
            if format == "json":
                return JSONResponse(payload)
            return HTMLResponse(_page_imported(record, payload))

        if mode == "prompt":
            prompt = derive_prompt(record)
            if format == "json":
                return JSONResponse({"akousma_id": record["akousma_id"], "prompt": prompt})
            return HTMLResponse(_page_prompt(record, prompt))

        payload = _lineage_payload(store, record)
        if format == "json":
            return JSONResponse(payload)
        return HTMLResponse(_page_lineage(record, payload))
    finally:
        store.close()


async def _import_as_sound(store, record: dict[str, Any]) -> dict[str, Any]:
    path = resolve_audio_path(store, record)
    if path is None:
        raise HTTPException(
            status_code=409,
            detail="akousma record has no resolvable audio (audio.uri missing or file absent)",
        )

    data = path.read_bytes()
    lineage = record.get("lineage") or {}
    metadata = {
        "prompt": derive_prompt(record),
        "output_name": record["akousma_id"].lower(),
        "tags": [str(t) for t in record.get("tags") or []],
        "source_type": "oida-akousma",
        "source": {"type": "oida-akousma", "akousma_id": record["akousma_id"]},
        "lineage": {
            "operation": "oida-import",
            "akousma_id": record["akousma_id"],
            "parents": list(lineage.get("parent_akousma_ids") or []),
        },
    }
    upload = UploadFile(file=BytesIO(data), filename=path.name, size=len(data))
    result = await import_audio(file=upload, metadata=json.dumps(metadata))

    record.setdefault("extensions", {})["germ.import"] = {
        "job_id": result.job_id,
        "audio_files": result.audio_files,
        "imported_at": utc_now_iso(),
    }
    store.put(record)

    return {
        "akousma_id": record["akousma_id"],
        "job_id": result.job_id,
        "audio_files": result.audio_files,
        "metadata_files": result.metadata_files,
        "status": result.status,
    }


# ── JSON surface ───────────────────────────────────────────────────────────────


@router.get("/akousma/record/{akousma_id}")
def get_akousma_record(akousma_id: str) -> dict[str, Any]:
    store = _store()
    try:
        return _get_record(store, akousma_id)
    finally:
        store.close()


def _lineage_payload(store, record: dict[str, Any]) -> dict[str, Any]:
    akousma_id = record["akousma_id"]
    parents = [store.get(pid) or {"akousma_id": pid} for pid in store.parents(akousma_id)]
    children = [store.get(cid) or {"akousma_id": cid} for cid in store.children(akousma_id)]
    return {
        "record": record,
        "parents": parents,
        "children": children,
        "ancestor_ids": store.ancestors(akousma_id),
    }


@router.get("/akousma/lineage/{akousma_id}")
def get_akousma_lineage(akousma_id: str) -> dict[str, Any]:
    store = _store()
    try:
        return _lineage_payload(store, _get_record(store, akousma_id))
    finally:
        store.close()


class GenerationAkousmaRequest(BaseModel):
    audio_path: str
    prompt: str = ""
    model: str = ""
    operation: str = "generate"
    params: dict[str, Any] = Field(default_factory=dict)
    parent_akousma_ids: list[str] = Field(default_factory=list)
    listening: dict[str, Any] = Field(default_factory=dict)
    tags: list[str] = Field(default_factory=list)


@router.post("/akousma/generation")
def write_generation_akousma(request: GenerationAkousmaRequest) -> dict[str, Any]:
    store = _store()
    try:
        for pid in request.parent_akousma_ids:
            _get_record(store, pid)
        try:
            record = record_generation(
                audio_path=request.audio_path,
                prompt=request.prompt,
                model=request.model,
                operation=request.operation,
                params=request.params,
                parent_akousma_ids=request.parent_akousma_ids,
                listening=request.listening,
                tags=request.tags,
                store=store,
            )
        except FileNotFoundError as exc:
            raise HTTPException(status_code=400, detail=f"audio_path does not exist: {exc}") from exc
        return {"akousma_id": record["akousma_id"], "record": record}
    finally:
        store.close()


# ── Minimal self-contained pages (germ-adjacent, no dashboard surgery) ─────────

_PAGE_CSS = """
:root { color-scheme: dark; }
body { margin: 0; padding: 40px 20px; background: #101210; color: #d8e0d4;
       font: 14px/1.6 -apple-system, "SF Mono", Menlo, monospace; display: flex; justify-content: center; }
main { max-width: 720px; width: 100%; }
h1 { font-size: 18px; margin: 0 0 4px; color: #eef3ea; }
.eyebrow { font-size: 11px; letter-spacing: .08em; text-transform: uppercase; color: #7d8a76; }
.card { background: #161a15; border: 1px solid #2a2f27; border-radius: 6px; padding: 16px 18px; margin: 14px 0; }
.k { color: #7d8a76; font-size: 11px; text-transform: uppercase; letter-spacing: .06em; }
.v { color: #cfd8c9; word-break: break-word; }
a { color: #9fd48a; text-decoration: none; } a:hover { text-decoration: underline; }
textarea { width: 100%; min-height: 90px; background: #0c0e0b; color: #d8e0d4; border: 1px solid #2a2f27;
           border-radius: 4px; padding: 10px; font: inherit; box-sizing: border-box; }
.row { display: flex; gap: 14px; flex-wrap: wrap; margin-top: 10px; }
button { background: #223321; color: #cfe8c2; border: 1px solid #3d5438; border-radius: 4px;
         padding: 7px 14px; font: inherit; cursor: pointer; }
button:hover { background: #2b402a; }
pre { white-space: pre-wrap; word-break: break-word; background: #0c0e0b; border: 1px solid #2a2f27;
      border-radius: 4px; padding: 10px; font-size: 12px; }
ul { padding-left: 18px; } li { margin: 4px 0; }
"""


def _shell(title: str, body: str) -> str:
    return (
        "<!doctype html><html><head><meta charset='utf-8'>"
        f"<meta name='viewport' content='width=device-width, initial-scale=1'><title>{html.escape(title)}</title>"
        f"<style>{_PAGE_CSS}</style></head><body><main>"
        f"<div class='eyebrow'>germ · akousma bridge</div>{body}</main></body></html>"
    )


def _record_summary_html(record: dict[str, Any]) -> str:
    prov = record.get("provenance") or {}
    listening = record.get("listening") or {}
    songid = (record.get("extensions") or {}).get("songid") or {}
    rows = [
        ("akousma", record.get("akousma_id", "")),
        ("origin", f"{prov.get('originating_app','?')} · {prov.get('origin','?')} · {prov.get('source_type','?')}"),
        ("created", record.get("created_at", "")),
        ("tags", ", ".join(str(t) for t in record.get("tags") or []) or "—"),
    ]
    if songid.get("matched"):
        rows.append(("song id", f"{songid.get('title','?')} — {songid.get('artist','?')}"))
    cells = "".join(
        f"<div><span class='k'>{html.escape(k)}</span><br><span class='v'>{html.escape(str(v))}</span></div>"
        for k, v in rows
    )
    listening_html = (
        f"<pre>{html.escape(json.dumps(listening, indent=2, ensure_ascii=False))}</pre>" if listening else ""
    )
    return f"<div class='card'><div class='row'>{cells}</div>{listening_html}</div>"


def _page_imported(record: dict[str, Any], payload: dict[str, Any]) -> str:
    files = "".join(f"<li class='v'>{html.escape(f)}</li>" for f in payload.get("audio_files", []))
    body = (
        f"<h1>opened as sound</h1>{_record_summary_html(record)}"
        f"<div class='card'><span class='k'>imported into germ</span><ul>{files}</ul>"
        f"<span class='k'>job</span> <span class='v'>{html.escape(payload.get('job_id',''))}</span></div>"
        f"<div class='row'><a href='/dashboard'>open the germ dashboard →</a>"
        f"<a href='/import?akousma={html.escape(record['akousma_id'])}&mode=lineage'>explore lineage →</a></div>"
    )
    return _shell("germ — opened as sound", body)


def _page_prompt(record: dict[str, Any], prompt: str) -> str:
    body = (
        f"<h1>opened as prompt</h1>{_record_summary_html(record)}"
        f"<div class='card'><span class='k'>generation prompt (from the listening result)</span>"
        f"<textarea id='p' readonly>{html.escape(prompt)}</textarea>"
        "<div class='row'><button onclick=\"navigator.clipboard.writeText(document.getElementById('p').value);"
        "localStorage.setItem('germ.akousma.prompt', document.getElementById('p').value);"
        "this.textContent='copied'\">copy prompt</button>"
        "<a href='/dashboard'>open the germ dashboard →</a></div></div>"
        f"<div class='row'><a href='/import?akousma={html.escape(record['akousma_id'])}&mode=sound'>also open as sound →</a>"
        f"<a href='/import?akousma={html.escape(record['akousma_id'])}&mode=lineage'>explore lineage →</a></div>"
    )
    return _shell("germ — opened as prompt", body)


def _lineage_list(title: str, records: list[dict[str, Any]]) -> str:
    if not records:
        return f"<div class='card'><span class='k'>{html.escape(title)}</span><br><span class='v'>—</span></div>"
    items = "".join(
        f"<li><a href='/import?akousma={html.escape(r.get('akousma_id',''))}&mode=lineage'>"
        f"{html.escape(r.get('akousma_id',''))}</a>"
        f" <span class='k'>{html.escape(((r.get('provenance') or {}).get('originating_app') or '?'))}"
        f" · {html.escape(((r.get('lineage') or {}).get('operation') or ''))}</span></li>"
        for r in records
    )
    return f"<div class='card'><span class='k'>{html.escape(title)}</span><ul>{items}</ul></div>"


def _page_lineage(record: dict[str, Any], payload: dict[str, Any]) -> str:
    lineage = record.get("lineage") or {}
    op = " · ".join(
        str(v) for v in (lineage.get("operation"), lineage.get("model"), lineage.get("prompt")) if v
    )
    body = (
        f"<h1>lineage explorer</h1>{_record_summary_html(record)}"
        + (f"<div class='card'><span class='k'>this sound came from</span><br><span class='v'>{html.escape(op)}</span></div>" if op else "")
        + _lineage_list(f"parents ({len(payload['parents'])})", payload["parents"])
        + _lineage_list(f"children ({len(payload['children'])})", payload["children"])
        + f"<div class='card'><span class='k'>ancestors</span><br><span class='v'>{len(payload['ancestor_ids'])} in chain</span></div>"
        f"<div class='row'>"
        f"<a href='/import?akousma={html.escape(record['akousma_id'])}&mode=sound'>open as sound →</a>"
        f"<a href='/import?akousma={html.escape(record['akousma_id'])}&mode=prompt'>open as prompt →</a>"
        f"<a href='{html.escape(_oida_url())}'>listen with oída →</a>"
        f"<a href='/dashboard'>germ dashboard →</a></div>"
    )
    return _shell("germ — lineage explorer", body)
