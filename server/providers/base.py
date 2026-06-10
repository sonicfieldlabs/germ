from __future__ import annotations

from abc import ABC, abstractmethod
from threading import Event, RLock

from server.schemas import (
    AudioToAudioRequest,
    ContinueRequest,
    GenerateRequest,
    GenerationResult,
    InpaintRequest,
)
from server.storage import StorageManager


class AudioGenerationProvider(ABC):
    provider_id: str

    def __init__(self, storage: StorageManager) -> None:
        self.storage = storage
        self.loaded_model_id: str | None = None
        self.current_device = "unknown"
        self.last_error: str | None = None
        self.loaded_loras: list[str] = []
        self._cancel_lock = RLock()
        self._cancel_events: dict[str, Event] = {}

    @abstractmethod
    def is_available(self) -> bool:
        ...

    @abstractmethod
    def list_models(self) -> list[str]:
        ...

    @abstractmethod
    def load_model(self, model_id: str, device: str = "auto") -> dict:
        ...

    @abstractmethod
    def generate(self, request: GenerateRequest) -> GenerationResult:
        ...

    @abstractmethod
    def audio_to_audio(self, request: AudioToAudioRequest) -> GenerationResult:
        ...

    @abstractmethod
    def inpaint(self, request: InpaintRequest) -> GenerationResult:
        ...

    @abstractmethod
    def continue_audio(self, request: ContinueRequest) -> GenerationResult:
        ...

    def load_lora(self, paths: list[str]) -> dict:
        self.last_error = "LoRA loading is not implemented for this provider."
        return {"status": "error", "error": self.last_error, "loaded_loras": self.loaded_loras}

    def set_lora_strength(self, strength: float, lora_index: int | None = None) -> dict:
        self.last_error = "LoRA strength control is not implemented for this provider."
        return {"status": "error", "error": self.last_error, "loaded_loras": self.loaded_loras}

    def status_detail(self) -> str | None:
        return self.last_error

    def register_cancel_event(self, job_id: str, cancel_event: Event) -> None:
        with self._cancel_lock:
            self._cancel_events[job_id] = cancel_event

    def clear_cancel_event(self, job_id: str) -> None:
        with self._cancel_lock:
            self._cancel_events.pop(job_id, None)

    def is_job_cancelled(self, job_id: str | None) -> bool:
        if not job_id:
            return False
        with self._cancel_lock:
            event = self._cancel_events.get(job_id)
        if event and event.is_set():
            return True
        job = self.storage.get_job(job_id)
        return bool(job and job.status == "cancelled")
