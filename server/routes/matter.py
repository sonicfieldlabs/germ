from __future__ import annotations

from pathlib import Path
from typing import Any
from uuid import uuid4

from fastapi import APIRouter

from server.identity import LEGACY_ENGINE_NAME, PRODUCT_NAME, SOUND_MATTER_CONCEPT, SOUND_MATTER_SCALES
from server.masa_bridge import MASA_VERSION, build_analysis_record, sidecar_path_for
from server.matter_analysis import analyze_sound_matter
from server.registry import settings, storage
from server.routes.control import _read_pcm16_wav, _resolve_output_wav
from server.schemas import MatterAnalysisRequest, MatterAnalysisResult, validate_json_compatible
from server.storage import safe_stem, utc_now_iso


router = APIRouter(tags=["matter"])


def _masa_analysis_state(
    *,
    artifact: dict[str, Any],
    profile_path: Path,
) -> tuple[dict[str, Any], str | None]:
    if not settings.masa_sidecars_enabled:
        return {"status": "disabled", "requested": False}, None
    try:
        record = build_analysis_record(artifact)
        validate_json_compatible(record, label="Matter Analysis MASA sidecar")
        sidecar_path = sidecar_path_for(profile_path, settings.masa_dir)
        storage.write_json_atomic(sidecar_path, record, touch_library=False)
        relative = storage.relative_path(sidecar_path)
        return (
            {
                "status": "written",
                "requested": True,
                "version": MASA_VERSION,
                "record_id": record["id"],
                "sidecar_path": relative,
                "canonical_identity": "germ_analysis_id",
            },
            relative,
        )
    except Exception as exc:
        return (
            {
                "status": "error",
                "requested": True,
                "version": MASA_VERSION,
                "error": str(exc)[:2_000],
            },
            None,
        )


@router.post("/matter/analyze", response_model=MatterAnalysisResult)
@router.post("/micro/matter-analysis", response_model=MatterAnalysisResult)
def analyze_matter(request: MatterAnalysisRequest) -> MatterAnalysisResult:
    source_path = _resolve_output_wav(request.input_audio_path)
    samples, channels, sample_rate, frame_count = _read_pcm16_wav(source_path)
    duration = frame_count / float(sample_rate)
    analysis = analyze_sound_matter(
        samples=samples,
        channels=channels,
        sample_rate=sample_rate,
        frame_count=frame_count,
        fft_size=request.fft_size,
        max_frames=request.max_frames,
    )
    validate_json_compatible(analysis, label="Matter Analysis result")
    analysis_id = f"matter_{uuid4().hex[:12]}"
    base = safe_stem(request.output_name, fallback=f"{source_path.stem}_matter")
    profile_path = settings.output_root / "micro" / f"{base}_{analysis_id}.json"
    input_audio_path = storage.relative_path(source_path)
    parent_ids = [
        str(value).strip()
        for value in request.lineage.get("parents", [])
        if isinstance(value, (str, int))
        and not isinstance(value, bool)
        and str(value).strip()
    ]
    if request.source_id and request.source_id not in parent_ids:
        parent_ids.append(request.source_id)
    artifact: dict[str, Any] = {
        "app": PRODUCT_NAME,
        "product": PRODUCT_NAME,
        "legacy_app": LEGACY_ENGINE_NAME,
        "concept": SOUND_MATTER_CONCEPT,
        "sound_matter_scales": SOUND_MATTER_SCALES,
        "type": "matter_analysis",
        "module": "matter_analysis",
        "id": analysis_id,
        "created_at": utc_now_iso(),
        "input_audio_path": input_audio_path,
        "metadata_path": request.metadata_path,
        "source_id": request.source_id,
        "profile_file": storage.relative_path(profile_path),
        "sample_rate": sample_rate,
        "channels": channels,
        "duration": duration,
        "fft_size": request.fft_size,
        "max_frames": request.max_frames,
        "analysis": analysis,
        "lineage": {
            **request.lineage,
            "id": analysis_id,
            "parents": list(dict.fromkeys(parent_ids))[:128],
            "parent_metadata_paths": [request.metadata_path] if request.metadata_path else [],
            "operation": "matter_analysis",
            "source_type": "analysis",
            "operation_params": {
                "input_audio_path": input_audio_path,
                "fft_size": request.fft_size,
                "max_frames": request.max_frames,
                "epistemic_states": ["measured", "inferred", "unavailable"],
            },
        },
        "masa": {"status": "pending", "requested": settings.masa_sidecars_enabled},
    }
    storage.write_json_atomic(profile_path, artifact, touch_library=True)
    masa_state, sidecar_file = _masa_analysis_state(
        artifact=artifact,
        profile_path=profile_path,
    )
    artifact["masa"] = masa_state
    storage.write_json_atomic(profile_path, artifact, touch_library=False)
    return MatterAnalysisResult(
        id=analysis_id,
        status="done",
        input_audio_path=input_audio_path,
        profile_file=storage.relative_path(profile_path),
        metadata_file=storage.relative_path(profile_path),
        masa_sidecar_file=sidecar_file,
        sample_rate=sample_rate,
        channels=channels,
        duration=duration,
        analysis_state=str(analysis.get("analysisState") or "unknown"),
        analysis=analysis,
        masa=masa_state,
    )
