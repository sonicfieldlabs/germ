"""Designed test signals, rendered by the existing bounded GERM job service."""

import hashlib
import re

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, ConfigDict, Field

from server.routes.jobs import submit_job
from server.routes.library import library_items, library_key, resolve_library_audio
from server.schemas import JobSubmitRequest
from server.spectral_synthesis import admit

router = APIRouter(prefix="/workspace/simulated")


class DesignedSignal(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True, allow_inf_nan=False)
    model: str = "additive"
    parameters: dict = Field(default_factory=dict)
    duration: float = Field(default=1, ge=0.1, le=30)
    seed: int = Field(default=42, ge=0, le=4294967294)


@router.post("/render")
def render(request: DesignedSignal):
    if request.model not in {"additive", "chirp", "band-noise"}:
        raise HTTPException(422, "Choose partials, chirp or seeded noise band")
    try:
        parameters, _ = admit(request.model, request.parameters, request.duration)
    except ValueError as exc:
        raise HTTPException(422, str(exc)) from exc
    return submit_job(
        JobSubmitRequest(
            mode="text-to-audio",
            request=dict(
                provider="synthesis",
                model=request.model,
                duration=request.duration,
                seed=request.seed,
                prompt="Designed aperture test signal; simulation, no physical capture",
                remember_to_akousmata=True,
                source={
                    "simulated": {"contract": "germ/simulated-source/v1"},
                    "synthesis": parameters,
                },
            ),
        )
    )


def designed(item):
    receipt = item.get("generation_receipt") or {}
    return receipt.get("simulated", {}).get("contract") == "germ/simulated-source/v1"


@router.get("/sources")
def sources():
    rows = [
        dict(
            key=library_key(i),
            sound_id=i["sound_id"],
            label=i.get("prompt") or "Designed test signal",
            duration=i.get("duration"),
            receipt=i["generation_receipt"],
        )
        for i in library_items()
        if i.get("audio_exists") and designed(i)
    ]
    return {"sources": rows[:100], "total": len(rows)}


@router.get("/sources/{key}/resolve")
def resolve(key: str):
    if not re.fullmatch(r"[a-f0-9]{64}", key):
        raise HTTPException(422, "Invalid designed source")
    item, path = resolve_library_audio(key)
    if not designed(item):
        raise HTTPException(409, "Sound has no designed-source receipt")
    receipt = item["generation_receipt"]
    with path.open("rb") as stream:
        digest = hashlib.sha256()
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(chunk)
        actual = digest.hexdigest()
    if actual != receipt["simulated"]["source_sha256"]:
        raise HTTPException(409, "Designed source changed since rendering")
    return {
        "path": str(path),
        "sound_id": item["sound_id"],
        "sha256": actual,
        "provenance": {"source_type": "designed"},
        "receipt": receipt,
    }
