from __future__ import annotations

from pathlib import Path

from fastapi import APIRouter, HTTPException, Response
from fastapi.responses import FileResponse

from server.registry import storage
from server.routes._utils import run_provider_method
from server.schemas import (
    AudioToAudioRequest,
    GenerateRequest,
    WavetableConvertRequest,
    WavetableDetail,
    WavetableExportFormat,
    WavetableImportRequest,
    WavetableMutationRequest,
    WavetableOperationResult,
    WavetablePromptContract,
    WavetablePromptRequest,
    WavetableRenderRequest,
    WavetableSummary,
)
from server.storage import safe_stem
from server.wavetable import (
    append_wavetable_child,
    convert_audio_to_wavetable,
    export_wavetable,
    import_wav_stack,
    list_wavetables,
    load_wavetable,
    render_wavetable_to_wav,
    update_wavetable_metadata,
    wavetable_summary,
)


router = APIRouter(prefix="/wavetables", tags=["wavetables"])

DEFAULT_WAVETABLE_NEGATIVE = (
    "speech, vocals, singing, drums, beat, melody phrase, chord progression, full song, "
    "long ambience, noisy background"
)

GENERATION_MODE_TEXT = {
    "single_cycle_tone": "stable single-cycle oscillator tone",
    "evolving_timbre": "slowly evolving oscillator timbre with stable pitch",
    "bass_oscillator": "solid bass oscillator source with strong fundamental",
    "glassy_metallic": "glassy metallic vowel timbre with clear harmonic focus",
    "soft_pad_source": "soft pad oscillator source with smooth harmonic motion",
    "formant_no_voice": "formant-like instrumental vowel color without voice or speech",
    "noisy_oscillator": "controlled noisy oscillator texture with stable tonal center",
    "organic_reed": "organic reed-like oscillator tone with steady pitch",
}


@router.get("", response_model=list[WavetableSummary])
def get_wavetables(limit: int = 5000) -> list[dict]:
    return [wavetable_summary(item) for item in list_wavetables(limit=max(1, min(limit, 5000)))]


@router.get("/{wavetable_id}", response_model=WavetableDetail)
def get_wavetable(wavetable_id: str) -> dict:
    return _load_metadata_or_404(wavetable_id)


@router.get("/{wavetable_id}/data")
def get_wavetable_data(wavetable_id: str) -> Response:
    table = _load_table_or_404(wavetable_id)
    data_path = table["data_path"]
    return Response(
        content=data_path.read_bytes(),
        media_type="application/octet-stream",
        headers={
            "Content-Disposition": f'attachment; filename="{data_path.name}"',
        },
    )


@router.post("/convert", response_model=WavetableOperationResult)
def post_convert_wavetable(request: WavetableConvertRequest) -> WavetableOperationResult:
    try:
        metadata = convert_audio_to_wavetable(request)
    except PermissionError as exc:
        raise HTTPException(status_code=403, detail=str(exc)) from exc
    except FileNotFoundError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc
    return WavetableOperationResult(status="done", wavetable=WavetableDetail(**metadata))


@router.post("/prompt", response_model=WavetableOperationResult)
def post_prompt_wavetable(request: WavetablePromptRequest) -> WavetableOperationResult:
    contract = _build_prompt_contract(request)
    wavetables: list[WavetableDetail] = []
    source_audio_files: list[str] = []
    source_metadata_files: list[str] = []
    base_name = request.output_name or safe_stem(request.prompt, fallback="wavetable_prompt")
    for index in range(request.variation_count):
        suffix = "" if request.variation_count == 1 else f"_{index + 1:02d}"
        generation_request = GenerateRequest(
            provider=request.provider,
            model=request.model,
            prompt=contract.prompt,
            negative_prompt=contract.negative_prompt,
            base_prompt=request.prompt,
            base_negative_prompt=request.negative_prompt,
            duration=request.duration,
            steps=8,
            cfg_scale=1.0,
            seed=-1,
            batch_size=1,
            output_name=f"{base_name}{suffix}_source",
            tags=request.tags,
            modulators=request.modulators,
            generation_context={
                "wavetable_prompt_contract": contract.model_dump(mode="json"),
                "wavetable_generation_mode": request.generation_mode,
            },
            lineage={
                **request.lineage,
                "operation": "wavetable_prompt_source",
                "source_type": "prompt",
                "operation_params": {
                    **_lineage_operation_params(request.lineage),
                    "prompt_contract": contract.model_dump(mode="json"),
                    "frame_count": request.frame_count,
                    "frame_size": request.frame_size,
                    "modulators": request.modulators,
                },
            },
        )
        generation_result = run_provider_method(generation_request, "text-to-audio", "generate")
        if generation_result.status != "done":
            return WavetableOperationResult(
                status="error",
                source_audio_files=source_audio_files,
                source_metadata_files=source_metadata_files,
                error=generation_result.error or "wavetable source generation failed",
            )
        source_audio_files.extend(generation_result.audio_files)
        source_metadata_files.extend(generation_result.metadata_files)
        for audio_path, metadata_path in zip(
            generation_result.audio_files,
            generation_result.metadata_files,
            strict=False,
        ):
            converted = _convert_generated_audio_to_wavetable(
                audio_path=audio_path,
                metadata_path=metadata_path,
                name=request.output_name or request.prompt,
                root_note=request.root_note,
                frame_count=request.frame_count,
                frame_size=request.frame_size,
                extraction_mode=request.extraction_mode,
                tags=request.tags,
                operation="prompt_to_wavetable",
                operation_params={
                    **_lineage_operation_params(request.lineage),
                    "prompt_contract": contract.model_dump(mode="json"),
                    "provider": request.provider,
                    "model": request.model,
                    "duration": request.duration,
                    "generation_mode": request.generation_mode,
                    "source_audio_path": audio_path,
                    "source_metadata_path": metadata_path,
                    "modulators": request.modulators,
                },
                lineage={
                    **request.lineage,
                    "operation": "prompt_to_wavetable",
                    "source_type": "prompt",
                },
            )
            wavetables.append(WavetableDetail(**converted))
    return WavetableOperationResult(
        status="done",
        wavetable=wavetables[0] if wavetables else None,
        wavetables=wavetables,
        source_audio_files=source_audio_files,
        source_metadata_files=source_metadata_files,
    )


@router.post("/mutate", response_model=WavetableOperationResult)
def post_mutate_wavetable(request: WavetableMutationRequest) -> WavetableOperationResult:
    try:
        parent = load_wavetable(request.wavetable_id)["metadata"]
        render_audio_path, render_metadata_path, render_metadata = render_wavetable_to_wav(
            wavetable_id=request.wavetable_id,
            duration=request.render_duration,
            root_note=request.root_note,
            note=request.root_note,
            scan_start=0.0,
            scan_end=1.0,
            gain=0.8,
            output_name=f"{safe_stem(parent.get('name'), fallback=request.wavetable_id)}_mutation_source",
            tags=["wavetable-mutation-source"],
            lineage={
                "parents": [request.wavetable_id],
                "operation": "wavetable-mutation-render",
                "source_type": "wavetable",
            },
        )
    except PermissionError as exc:
        raise HTTPException(status_code=403, detail=str(exc)) from exc
    except FileNotFoundError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc

    wavetables: list[WavetableDetail] = []
    mutated_audio_files: list[str] = []
    mutated_metadata_files: list[str] = []
    render_audio = storage.relative_path(render_audio_path)
    render_metadata_file = storage.relative_path(render_metadata_path)
    render_audio_id = str(render_metadata.get("sound_id") or Path(render_audio).stem)
    for index in range(request.variation_count):
        suffix = "" if request.variation_count == 1 else f"_{index + 1:02d}"
        mutation_request = AudioToAudioRequest(
            provider=request.provider,
            model=request.model,
            prompt=request.prompt,
            negative_prompt=request.negative_prompt,
            duration=request.render_duration,
            steps=8,
            cfg_scale=1.0,
            seed=-1,
            batch_size=1,
            input_audio_path=render_audio,
            init_noise_level=request.init_noise_level,
            output_name=f"{safe_stem(parent.get('name'), fallback='wavetable')}_mutation{suffix}",
            tags=["wavetable-mutation"],
            modulators=request.modulators,
            generation_context={
                "wavetable_parent_id": request.wavetable_id,
                "wavetable_mutation": True,
            },
            lineage={
                **request.lineage,
                "parents": [request.wavetable_id, render_audio_id],
                "parent_metadata_paths": [render_metadata_file],
                "operation": "wavetable_mutation_audio",
                "source_type": "wavetable",
                "operation_params": {
                    **_lineage_operation_params(request.lineage),
                    "parent_wavetable_id": request.wavetable_id,
                    "render_audio_id": render_audio_id,
                    "init_noise_level": request.init_noise_level,
                    "prompt": request.prompt,
                    "modulators": request.modulators,
                },
            },
        )
        mutation_result = run_provider_method(mutation_request, "audio-to-audio", "audio_to_audio")
        if mutation_result.status != "done":
            return WavetableOperationResult(
                status="error",
                audio_files=mutated_audio_files,
                metadata_files=mutated_metadata_files,
                error=mutation_result.error or "wavetable mutation failed",
            )
        mutated_audio_files.extend(mutation_result.audio_files)
        mutated_metadata_files.extend(mutation_result.metadata_files)
        for audio_path, metadata_path in zip(
            mutation_result.audio_files,
            mutation_result.metadata_files,
            strict=False,
        ):
            converted = _convert_generated_audio_to_wavetable(
                audio_path=audio_path,
                metadata_path=metadata_path,
                name=f"{parent.get('name') or request.wavetable_id} mutation",
                root_note=request.root_note,
                frame_count=request.frame_count,
                frame_size=request.frame_size,
                extraction_mode=request.extraction_mode,
                tags=["wavetable", "germ", "mutation"],
                operation="wavetable_mutation",
                operation_params={
                    **_lineage_operation_params(request.lineage),
                    "operation": "wavetable_mutation",
                    "parent_wavetable_id": request.wavetable_id,
                    "render_audio_id": render_audio_id,
                    "render_audio_path": render_audio,
                    "render_metadata_path": render_metadata_file,
                    "mutated_audio_path": audio_path,
                    "mutated_metadata_path": metadata_path,
                    "stable_audio_mode": "audio-to-audio",
                    "init_noise_level": request.init_noise_level,
                    "prompt": request.prompt,
                    "modulators": request.modulators,
                },
                lineage={
                    **request.lineage,
                    "parents": [request.wavetable_id],
                    "operation": "wavetable_mutation",
                    "source_type": "wavetable",
                },
            )
            converted["parent_wavetable_id"] = request.wavetable_id
            converted["render_audio_id"] = render_audio_id
            converted["child_wavetable_id"] = converted["id"]
            converted = update_wavetable_metadata(
                converted["id"],
                {
                    "parent_wavetable_id": request.wavetable_id,
                    "render_audio_id": render_audio_id,
                    "child_wavetable_id": converted["id"],
                    "operation_params": {
                        **converted.get("operation_params", {}),
                        "child_wavetable_id": converted["id"],
                        "modulators": request.modulators,
                    },
                },
            )
            append_wavetable_child(request.wavetable_id, converted["id"])
            wavetables.append(WavetableDetail(**converted))
    return WavetableOperationResult(
        status="done",
        wavetable=wavetables[0] if wavetables else None,
        wavetables=wavetables,
        audio_files=mutated_audio_files,
        metadata_files=mutated_metadata_files,
        source_audio_files=[render_audio],
        source_metadata_files=[render_metadata_file],
    )


@router.post("/render", response_model=WavetableOperationResult)
def post_render_wavetable(request: WavetableRenderRequest) -> WavetableOperationResult:
    try:
        audio_path, metadata_path, _metadata = render_wavetable_to_wav(
            wavetable_id=request.wavetable_id,
            duration=request.duration,
            root_note=request.root_note,
            note=request.note,
            scan_start=request.scan_start,
            scan_end=request.scan_end,
            gain=request.gain,
            output_name=request.output_name,
            tags=request.tags,
            lineage=request.lineage,
        )
        wavetable = _load_metadata_or_404(request.wavetable_id)
    except PermissionError as exc:
        raise HTTPException(status_code=403, detail=str(exc)) from exc
    except FileNotFoundError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc
    return WavetableOperationResult(
        status="done",
        wavetable=WavetableDetail(**wavetable),
        audio_files=[storage.relative_path(audio_path)],
        metadata_files=[storage.relative_path(metadata_path)],
    )


@router.post("/import", response_model=WavetableOperationResult)
def post_import_wavetable(request: WavetableImportRequest) -> WavetableOperationResult:
    try:
        metadata = import_wav_stack(request)
    except PermissionError as exc:
        raise HTTPException(status_code=403, detail=str(exc)) from exc
    except FileNotFoundError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc
    return WavetableOperationResult(status="done", wavetable=WavetableDetail(**metadata))


@router.get("/{wavetable_id}/export")
def get_export_wavetable(wavetable_id: str, format: WavetableExportFormat = "gwt") -> FileResponse:
    try:
        path = export_wavetable(wavetable_id, format)
    except PermissionError as exc:
        raise HTTPException(status_code=403, detail=str(exc)) from exc
    except FileNotFoundError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc
    media_type = {
        "metadata": "application/json",
        "gwt": "application/octet-stream",
        "wav-stack": "audio/wav",
        "single-cycle": "audio/wav",
    }[format]
    return FileResponse(path, media_type=media_type, filename=path.name)


def _load_table_or_404(wavetable_id: str) -> dict:
    try:
        return load_wavetable(wavetable_id)
    except PermissionError as exc:
        raise HTTPException(status_code=403, detail=str(exc)) from exc
    except FileNotFoundError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc


def _load_metadata_or_404(wavetable_id: str) -> dict:
    return _load_table_or_404(wavetable_id)["metadata"]


def _build_prompt_contract(request: WavetablePromptRequest) -> WavetablePromptContract:
    user_prompt = request.prompt.strip()
    if not user_prompt:
        raise HTTPException(status_code=422, detail="prompt cannot be empty")
    mode_text = GENERATION_MODE_TEXT[request.generation_mode]
    prompt = (
        f"Single sustained instrumental tone, {mode_text}, {user_prompt}, clear tonal center, "
        "stable pitch, no rhythm, no drums, no voice, no melody phrase, no long ambience."
    )
    negative_parts = [DEFAULT_WAVETABLE_NEGATIVE]
    if request.negative_prompt.strip():
        negative_parts.append(request.negative_prompt.strip())
    return WavetablePromptContract(
        user_prompt=user_prompt,
        generation_mode=request.generation_mode,
        prompt=prompt,
        negative_prompt=", ".join(negative_parts),
    )


def _lineage_operation_params(lineage: dict) -> dict:
    params = lineage.get("operation_params") if isinstance(lineage.get("operation_params"), dict) else {}
    return dict(params)


def _convert_generated_audio_to_wavetable(
    *,
    audio_path: str,
    metadata_path: str,
    name: str,
    root_note: str,
    frame_count: int,
    frame_size: int,
    extraction_mode: str,
    tags: list[str],
    operation: str,
    operation_params: dict,
    lineage: dict,
) -> dict:
    try:
        metadata = convert_audio_to_wavetable(
            WavetableConvertRequest(
                input_audio_path=audio_path,
                metadata_path=metadata_path,
                name=name,
                frame_count=frame_count,
                frame_size=frame_size,
                root_note=root_note,
                extraction_mode=extraction_mode,
                tags=tags,
                operation_params=operation_params,
                lineage=lineage,
            )
        )
    except PermissionError as exc:
        raise HTTPException(status_code=403, detail=str(exc)) from exc
    except FileNotFoundError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc
    updates = {
        "operation": operation,
        "operation_params": operation_params,
        "lineage": {
            **(metadata.get("lineage") if isinstance(metadata.get("lineage"), dict) else {}),
            **lineage,
            "operation": operation,
        },
    }
    return update_wavetable_metadata(metadata["id"], updates)
