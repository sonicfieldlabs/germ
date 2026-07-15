from __future__ import annotations

import mimetypes
import time
import wave
from pathlib import Path
from typing import Any

import httpx

from server.config import Settings
from server.providers.base import AudioGenerationProvider
from server.schemas import (
    AudioToAudioRequest,
    ContinueRequest,
    GenerateRequest,
    GenerationResult,
    InpaintRequest,
)


class StabilityAPIError(RuntimeError):
    pass


class StabilityAPICancelled(StabilityAPIError):
    pass


class StabilityAPIProvider(AudioGenerationProvider):
    """Stable Audio 3 Large through Stability's asynchronous v2beta API."""

    provider_id = "stability_api"
    api_model = "stable-audio-3"
    sample_rate = 44_100
    credit_cost_per_request = 26
    _model_aliases = {"large": api_model, "stable-audio-3": api_model}

    def __init__(self, storage, settings: Settings) -> None:
        super().__init__(storage)
        self.settings = settings
        self.current_device = "api"

    def is_available(self) -> bool:
        if not self.settings.stability_api_key.strip():
            self.last_error = "STABILITY_API_KEY is not configured."
            return False
        self.last_error = None
        return True

    def list_models(self) -> list[str]:
        return [self.api_model]

    def load_model(self, model_id: str, device: str = "auto") -> dict[str, Any]:
        model = self._resolve_model(model_id)
        if not self.is_available():
            return {
                "provider": self.provider_id,
                "model": model,
                "device": "api",
                "status": "error",
                "detail": self.last_error,
            }
        self.loaded_model_id = model
        self.current_device = "api"
        return {
            "provider": self.provider_id,
            "model": model,
            "device": self.current_device,
            "status": "ready",
            "detail": "Stable Audio 3 API requests are submitted asynchronously.",
        }

    def generate(self, request: GenerateRequest) -> GenerationResult:
        return self._run(request, "text-to-audio")

    def audio_to_audio(self, request: AudioToAudioRequest) -> GenerationResult:
        return self._run(request, "audio-to-audio")

    def inpaint(self, request: InpaintRequest) -> GenerationResult:
        return self._run(request, "inpainting")

    def continue_audio(self, request: ContinueRequest) -> GenerationResult:
        inpaint_request = InpaintRequest(
            **request.model_dump(
                exclude={"source_duration", "target_duration", "duration", "job_id"}
            ),
            inpaint_ranges=[(request.source_duration, request.target_duration)],
            duration=request.target_duration,
            job_id=request.job_id,
        )
        return self._run(inpaint_request, "continuation")

    def _run(self, request: Any, mode: str) -> GenerationResult:
        job_id = request.job_id or self.storage.new_job(
            mode,
            request.model_dump(exclude={"job_id"}),
        )
        try:
            self._validate_request(request, mode)
        except (ValueError, FileNotFoundError, PermissionError) as exc:
            return self.storage.write_error_metadata(
                request=request,
                mode=mode,
                job_id=job_id,
                error=str(exc),
                provider=self.provider_id,
                model=self.api_model,
            )
        if not self.is_available():
            return self.storage.write_error_metadata(
                request=request,
                mode=mode,
                job_id=job_id,
                error=self.last_error or "Stability API is unavailable",
                provider=self.provider_id,
                model=self.api_model,
            )

        if isinstance(request, InpaintRequest) and len(request.inpaint_ranges) > 1:
            return self._run_multi_range_inpaint(request, mode, job_id)

        count = request.batch_size if mode == "text-to-audio" else 1
        paths = self.storage.reserve_paths(
            request=request,
            mode=mode,
            job_id=job_id,
            count=count,
            extension=".wav",
        )
        audio_files: list[str] = []
        metadata_files: list[str] = []
        first_seed: int | None = None
        headers = self._headers()
        timeout = httpx.Timeout(self.settings.provider_timeout_seconds, connect=30.0)

        try:
            with httpx.Client(headers=headers, timeout=timeout) as client:
                for index, (audio_path, metadata_path) in enumerate(paths):
                    seed = self._seed_for_index(request.seed, index)
                    audio, generation_id, actual_seed = self._submit_and_poll(
                        client,
                        request,
                        seed=seed,
                        job_id=job_id,
                    )
                    recorded_seed = actual_seed if actual_seed is not None else seed
                    if first_seed is None:
                        first_seed = recorded_seed
                    self._write_audio_atomic(audio_path, audio)
                    self.storage.write_metadata(
                        metadata_path=metadata_path,
                        request=request,
                        mode=mode,
                        provider=self.provider_id,
                        model=self.api_model,
                        seed=recorded_seed,
                        output_audio_path=audio_path,
                        sample_rate=self.sample_rate,
                        status="done",
                        extra={
                            "batch_index": index,
                            "api_generation_id": generation_id,
                            "api_model": self.api_model,
                            "api_credit_estimate": self.credit_cost_per_request,
                            "api_ignored_controls": self._ignored_controls(request),
                        },
                    )
                    audio_files.append(self.storage.relative_path(audio_path))
                    metadata_files.append(self.storage.relative_path(metadata_path))
        except (StabilityAPIError, httpx.HTTPError, OSError) as exc:
            cancelled = isinstance(exc, StabilityAPICancelled)
            failed_path = paths[min(len(metadata_files), len(paths) - 1)]
            return self._failure_result(
                request=request,
                mode=mode,
                job_id=job_id,
                paths=failed_path,
                seed=first_seed,
                error=str(exc),
                cancelled=cancelled,
                audio_files=audio_files,
                metadata_files=metadata_files,
            )

        result = GenerationResult(
            job_id=job_id,
            status="done",
            audio_files=audio_files,
            metadata_files=metadata_files,
            seed=first_seed,
            duration=request.duration,
            sample_rate=self.sample_rate,
            provider=self.provider_id,
            model=self.api_model,
            mode=mode,
        )
        self.storage.record_result(result)
        return result

    def _run_multi_range_inpaint(
        self,
        request: InpaintRequest,
        mode: str,
        job_id: str,
    ) -> GenerationResult:
        audio_path, metadata_path = self.storage.reserve_paths(
            request=request,
            mode=mode,
            job_id=job_id,
            extension=".wav",
        )[0]
        scratch_dir = self.settings.scratch_dir / "stability-api-inpaint"
        scratch_dir.mkdir(parents=True, exist_ok=True)
        current_source = str(
            self.storage.resolve_existing_input_audio_path(
                request.input_audio_path,
                label="input audio",
            )
        )
        intermediates: list[Path] = []
        generation_ids: list[str] = []
        range_seeds: list[int] = []
        first_seed: int | None = None
        timeout = httpx.Timeout(self.settings.provider_timeout_seconds, connect=30.0)

        try:
            with httpx.Client(headers=self._headers(), timeout=timeout) as client:
                for index, inpaint_range in enumerate(request.inpaint_ranges):
                    seed = self._seed_for_index(request.seed, index)
                    single = request.model_copy(
                        update={
                            "input_audio_path": current_source,
                            "inpaint_ranges": [inpaint_range],
                        }
                    )
                    audio, generation_id, actual_seed = self._submit_and_poll(
                        client,
                        single,
                        seed=seed,
                        job_id=job_id,
                    )
                    recorded_seed = actual_seed if actual_seed is not None else seed
                    if first_seed is None:
                        first_seed = recorded_seed
                    range_seeds.append(recorded_seed)
                    generation_ids.append(generation_id)
                    is_last = index == len(request.inpaint_ranges) - 1
                    target = (
                        audio_path
                        if is_last
                        else scratch_dir / f"{audio_path.stem}_range_{index + 1:02d}.wav"
                    )
                    self._write_audio_atomic(target, audio)
                    if not is_last:
                        intermediates.append(target)
                        current_source = str(target.resolve())
        except (StabilityAPIError, httpx.HTTPError, OSError) as exc:
            self._cleanup(intermediates)
            return self._failure_result(
                request=request,
                mode=mode,
                job_id=job_id,
                paths=(audio_path, metadata_path),
                seed=first_seed,
                error=str(exc),
                cancelled=isinstance(exc, StabilityAPICancelled),
                extra={
                    "multi_range_strategy": "sequential_stability_api_inpaint",
                    "api_generation_ids": generation_ids,
                    "range_seeds": range_seeds,
                },
            )

        self._cleanup(intermediates)
        self.storage.write_metadata(
            metadata_path=metadata_path,
            request=request,
            mode=mode,
            provider=self.provider_id,
            model=self.api_model,
            seed=first_seed,
            output_audio_path=audio_path,
            sample_rate=self.sample_rate,
            status="done",
            extra={
                "multi_range_strategy": "sequential_stability_api_inpaint",
                "api_generation_ids": generation_ids,
                "range_seeds": range_seeds,
                "api_model": self.api_model,
                "api_credit_estimate": self.credit_cost_per_request * len(generation_ids),
                "api_ignored_controls": self._ignored_controls(request),
                "intermediate_files_cleaned": True,
            },
        )
        result = GenerationResult(
            job_id=job_id,
            status="done",
            audio_files=[self.storage.relative_path(audio_path)],
            metadata_files=[self.storage.relative_path(metadata_path)],
            seed=first_seed,
            duration=request.duration,
            sample_rate=self.sample_rate,
            provider=self.provider_id,
            model=self.api_model,
            mode=mode,
        )
        self.storage.record_result(result)
        return result

    def _submit_and_poll(
        self,
        client: httpx.Client,
        request: Any,
        *,
        seed: int,
        job_id: str,
    ) -> tuple[bytes, str, int | None]:
        endpoint, data, input_path = self._request_parts(request, seed)
        if input_path is None:
            response = client.post(endpoint, data=data, files={"none": ("", b"")})
        else:
            mime = mimetypes.guess_type(input_path.name)[0] or "application/octet-stream"
            with input_path.open("rb") as handle:
                response = client.post(
                    endpoint,
                    data=data,
                    files={"audio": (input_path.name, handle, mime)},
                )
        if response.status_code != 202:
            raise StabilityAPIError(self._response_error(response, "submission"))
        try:
            generation_id = str(response.json()["id"])
        except (KeyError, TypeError, ValueError) as exc:
            raise StabilityAPIError("Stability API returned no generation id") from exc
        deadline = time.monotonic() + self.settings.provider_timeout_seconds
        result_url = f"{self.settings.stability_api_url}/v2beta/audio/results/{generation_id}"
        while True:
            if self.is_job_cancelled(job_id):
                raise StabilityAPICancelled("Stable Audio 3 API polling cancelled.")
            result = client.get(result_url)
            if result.status_code == 200:
                if not result.content:
                    raise StabilityAPIError("Stability API returned an empty audio result")
                actual_seed = self._header_seed(result.headers.get("seed"))
                return result.content, generation_id, actual_seed
            if result.status_code != 202:
                raise StabilityAPIError(self._response_error(result, "result polling"))
            if time.monotonic() >= deadline:
                raise StabilityAPIError(
                    f"Stable Audio 3 API timed out after {self.settings.provider_timeout_seconds:.0f} seconds."
                )
            self._wait_for_poll(job_id, deadline)

    def _request_parts(self, request: Any, seed: int) -> tuple[str, dict[str, str], Path | None]:
        common = {
            "prompt": request.prompt,
            "model": self.api_model,
            "duration": str(request.duration),
            "seed": str(seed),
            "steps": str(request.steps),
            "cfg_scale": str(request.cfg_scale),
            "output_format": "wav",
        }
        root = f"{self.settings.stability_api_url}/v2beta/audio/stable-audio"
        if isinstance(request, AudioToAudioRequest):
            path = self._resolve_api_audio(request.input_audio_path)
            return (
                f"{root}/audio-to-audio",
                {**common, "strength": str(request.init_noise_level)},
                path,
            )
        if isinstance(request, InpaintRequest):
            path = self._resolve_api_audio(request.input_audio_path)
            start, end = request.inpaint_ranges[0]
            return (
                f"{root}/inpaint",
                {**common, "mask_start": str(start), "mask_end": str(end)},
                path,
            )
        return f"{root}/text-to-audio", common, None

    def _validate_request(self, request: Any, mode: str) -> None:
        self._resolve_model(request.model)
        if request.duration < 1 or request.duration > 380:
            raise ValueError("Stability API duration must be between 1 and 380 seconds")
        if request.steps < 4 or request.steps > 8:
            raise ValueError("Stability API steps must be between 4 and 8")
        if request.cfg_scale < 1 or request.cfg_scale > 25:
            raise ValueError("Stability API cfg_scale must be between 1 and 25")
        if request.seed < -1 or request.seed > 4_294_967_294:
            raise ValueError("Stability API seed must be -1 or between 0 and 4294967294")
        if any(lora.enabled for lora in request.lora):
            raise ValueError("The Stability API does not accept local LoRA adapters")
        if mode != "text-to-audio" and request.batch_size != 1:
            raise ValueError("Stability API editing modes currently require batch_size=1")
        if isinstance(request, (AudioToAudioRequest, InpaintRequest)):
            self._resolve_api_audio(request.input_audio_path)
        if isinstance(request, InpaintRequest):
            if len(request.inpaint_ranges) > 1 and request.duration < 6:
                raise ValueError(
                    "sequential Stability API inpainting requires duration >= 6 seconds "
                    "so each intermediate remains a valid edit source"
                )
            for start, end in request.inpaint_ranges:
                if end > request.duration:
                    raise ValueError("inpaint range end cannot exceed duration")

    def _resolve_api_audio(self, raw_path: str) -> Path:
        path = self.storage.resolve_existing_input_audio_path(raw_path, label="input audio")
        if path.suffix.lower() not in {".mp3", ".wav"}:
            raise ValueError("Stability API editing accepts WAV or MP3 input")
        if path.stat().st_size > 100 * 1024 * 1024:
            raise ValueError("Stability API input audio must be 100 MB or smaller")
        if path.suffix.lower() == ".wav":
            try:
                with wave.open(str(path), "rb") as source:
                    duration = source.getnframes() / float(source.getframerate())
            except (wave.Error, ZeroDivisionError) as exc:
                raise ValueError("Stability API input must be a readable PCM WAV or MP3") from exc
            if duration < 6 or duration > 380:
                raise ValueError("Stability API input audio must be between 6 and 380 seconds")
        return path

    def _wait_for_poll(self, job_id: str, deadline: float) -> None:
        wait_until = min(deadline, time.monotonic() + self.settings.stability_poll_seconds)
        while time.monotonic() < wait_until:
            if self.is_job_cancelled(job_id):
                raise StabilityAPICancelled("Stable Audio 3 API polling cancelled.")
            time.sleep(min(0.25, max(0.0, wait_until - time.monotonic())))

    def _failure_result(
        self,
        *,
        request: Any,
        mode: str,
        job_id: str,
        paths: tuple[Path, Path],
        seed: int | None,
        error: str,
        cancelled: bool,
        audio_files: list[str] | None = None,
        metadata_files: list[str] | None = None,
        extra: dict[str, Any] | None = None,
    ) -> GenerationResult:
        audio_path, metadata_path = paths
        status = "cancelled" if cancelled else "error"
        self.storage.write_metadata(
            metadata_path=metadata_path,
            request=request,
            mode=mode,
            provider=self.provider_id,
            model=self.api_model,
            seed=seed,
            output_audio_path=audio_path if audio_path.exists() else None,
            sample_rate=self.sample_rate if audio_path.exists() else None,
            status=status,
            error=error,
            extra={"api_model": self.api_model, **(extra or {})},
        )
        result = GenerationResult(
            job_id=job_id,
            status=status,
            audio_files=audio_files or [],
            metadata_files=[*(metadata_files or []), self.storage.relative_path(metadata_path)],
            seed=seed,
            duration=request.duration,
            sample_rate=self.sample_rate,
            error=error,
            provider=self.provider_id,
            model=self.api_model,
            mode=mode,
        )
        self.storage.record_result(result)
        return result

    def _headers(self) -> dict[str, str]:
        return {
            "authorization": f"Bearer {self.settings.stability_api_key.strip()}",
            "accept": "audio/*",
            "stability-client-id": "germ",
            "stability-client-version": "0.1.0",
        }

    def _resolve_model(self, model_id: str) -> str:
        model = self._model_aliases.get(str(model_id).strip())
        if model is None:
            raise ValueError(f"unknown Stability API model: {model_id}; expected {self.api_model}")
        return model

    def _seed_for_index(self, requested_seed: int, index: int) -> int:
        if requested_seed == 0:
            return 0  # Stability defines zero as server-random.
        if requested_seed > 0:
            seed = requested_seed + index
            if seed > 4_294_967_294:
                raise StabilityAPIError("batch seed exceeds Stability API maximum")
            return seed
        return min(self.storage.random_seed(), 4_294_967_294)

    @staticmethod
    def _header_seed(value: str | None) -> int | None:
        try:
            return int(value) if value is not None else None
        except (TypeError, ValueError):
            return None

    @staticmethod
    def _write_audio_atomic(path: Path, audio: bytes) -> None:
        if not audio:
            raise OSError("refusing to write an empty audio response")
        if len(audio) < 12 or audio[:4] != b"RIFF" or audio[8:12] != b"WAVE":
            raise OSError("Stability API returned a non-WAV response")
        temp = path.with_name(f".{path.name}.tmp")
        temp.write_bytes(audio)
        temp.replace(path)

    @staticmethod
    def _cleanup(paths: list[Path]) -> None:
        for path in paths:
            try:
                path.unlink(missing_ok=True)
            except OSError:
                pass

    @staticmethod
    def _response_error(response: httpx.Response, action: str) -> str:
        request_id = response.headers.get("x-request-id") or response.headers.get("request-id")
        try:
            body = response.json()
            if isinstance(body, dict):
                errors = body.get("errors") or body.get("message") or body.get("name")
                detail = (
                    "; ".join(str(item) for item in errors)
                    if isinstance(errors, list)
                    else str(errors)
                )
            else:
                detail = str(body)
        except ValueError:
            detail = response.text[:500]
        suffix = f" (request {request_id})" if request_id else ""
        return f"Stability API {action} failed with HTTP {response.status_code}{suffix}: {detail}"

    @staticmethod
    def _ignored_controls(request: Any) -> list[str]:
        ignored = []
        if request.negative_prompt:
            ignored.append("negative_prompt")
        if not request.chunked_decode:
            ignored.append("chunked_decode")
        return ignored
