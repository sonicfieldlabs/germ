import json
import re
from fastapi import APIRouter, HTTPException
from fastapi.responses import FileResponse
from server.registry import storage
from server.research.deployment import deployment, sha
from server.research.requests import ResearchRequest
from server.routes.library import resolve_library_audio
from server.routes.jobs import submit_job
from server.schemas import JobSubmitRequest

router = APIRouter(prefix="/research")


@router.get("/options")
def options():
    entries = []
    for tool, name, profile in [
        ("rave-guitar", "RAVE · IIL guitar", "noncommercial_research"),
        ("basic-pitch", "Basic Pitch · notes and MIDI", "general"),
    ]:
        try:
            config = deployment(tool)
            available = True
            reason = None
        except (ValueError, OSError, KeyError) as exc:
            config = {}
            available = False
            reason = str(exc)
        entries.append(
            dict(
                id=tool,
                name=name,
                profile=profile,
                available=available,
                reason=reason,
                license=config.get("license"),
            )
        )
    return dict(
        tools=entries,
        max_seconds=30,
        candidates=[
            dict(name=n, status="not_admitted")
            for n in ["Demucs separation", "Music Flamingo", "SheetSage2", "YuE2"]
        ],
        jobs=recent(),
    )


@router.post("/run")
def run(request: ResearchRequest):
    try:
        config = deployment(request.tool)
        if (
            config["profile"] == "noncommercial_research"
            and request.profile != "noncommercial_research"
        ):
            raise ValueError("Select the noncommercial research profile")
        item, path = resolve_library_audio(request.key)
        if path.stat().st_size > 512 * 1024 * 1024:
            raise ValueError("Research input exceeds 512 MiB")
        location = dict(path=str(path), sound_id=item["sound_id"])
        restrictions = item.get("generation_receipt", {}).get("profile")
        if restrictions == "noncommercial_research" and request.profile != "noncommercial_research":
            raise ValueError("Parent requires the noncommercial research profile")
        source = dict(
            key=request.key,
            sound_id=location["sound_id"],
            sha256=sha(location["path"]),
            research=request.model_dump(
                include={"profile", "start_seconds", "latent_scale", "latent_bias"}
            ),
        )
        return submit_job(
            JobSubmitRequest(
                mode="audio-to-audio",
                request=dict(
                    provider="research",
                    model=request.tool,
                    input_audio_path=location["path"],
                    duration=request.seconds,
                    seed=request.seed,
                    prompt="",
                    source=source,
                    lineage={"parents": [location["sound_id"]]},
                ),
            )
        ).model_dump()
    except (ValueError, OSError, KeyError) as exc:
        raise HTTPException(422, str(exc)) from exc


def manifest(identifier):
    if not re.fullmatch(
        r"(?:[a-f0-9]{32}|[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12})", identifier
    ):
        raise HTTPException(400, "Invalid research job")
    path = storage.metadata_dir / "research" / identifier / "manifest.json"
    if not path.is_file():
        raise HTTPException(404, "No completed research artifacts")
    return path, json.loads(path.read_text())


def recent():
    root = storage.metadata_dir / "research"
    return [
        json.loads(p.read_text())
        for p in sorted(
            root.glob("*/manifest.json"), key=lambda p: p.stat().st_mtime, reverse=True
        )[:30]
    ]


@router.get("/jobs/{identifier}")
def detail(identifier: str):
    return manifest(identifier)[1]


@router.get("/jobs/{identifier}/artifacts/{name}/resolve")
def resolve_artifact(identifier: str, name: str):
    path, value = manifest(identifier)
    item = next((a for a in value["artifacts"] if a["file"] == name), None)
    if not item or name not in {"transform.wav", "notes.json", "notes.mid"}:
        raise HTTPException(404)
    target = path.parent / name
    if target.is_symlink() or not target.is_file():
        raise HTTPException(404)
    if sha(target) != item["sha256"]:
        raise HTTPException(409, "Artifact changed since receipt")
    return dict(path=str(target.resolve()), media_type=item["media_type"], sha256=item["sha256"])


@router.get("/jobs/{identifier}/artifacts/{name}")
def artifact(identifier: str, name: str):
    value = resolve_artifact(identifier, name)
    return FileResponse(
        value["path"],
        media_type=value["media_type"],
        filename=name,
        headers={"Cache-Control": "private, no-store"},
    )
