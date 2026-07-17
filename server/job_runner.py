from __future__ import annotations

from concurrent.futures import Future, ThreadPoolExecutor
from threading import BoundedSemaphore, Event, Lock
from typing import Any, Callable

from server.config import Settings
from server.storage import StorageManager


class JobQueueFullError(RuntimeError):
    """Raised when the bounded background job queue has no available slot."""


class JobRunner:
    def __init__(self, settings: Settings, storage: StorageManager) -> None:
        self.storage = storage
        self.executor = ThreadPoolExecutor(
            max_workers=settings.job_workers,
            thread_name_prefix="germ-job",
        )
        self._lock = Lock()
        self._futures: dict[str, Future[Any]] = {}
        self._cancel_events: dict[str, Event] = {}
        self._slots = BoundedSemaphore(max(settings.job_workers, settings.job_workers * 8))

    def submit(self, runner_job_id: str, fn: Callable[..., Any], *args: Any, **kwargs: Any) -> None:
        if not self._slots.acquire(blocking=False):
            raise JobQueueFullError("background job queue is full")
        cancel_event = Event()
        kwargs = {**kwargs, "cancel_event": cancel_event}
        try:
            future = self.executor.submit(fn, *args, **kwargs)
        except Exception:
            self._slots.release()
            raise
        with self._lock:
            self._futures[runner_job_id] = future
            self._cancel_events[runner_job_id] = cancel_event
        future.add_done_callback(lambda _future: self._forget(runner_job_id))

    def cancel(self, job_id: str) -> dict[str, str | bool]:
        with self._lock:
            future = self._futures.get(job_id)
            cancel_event = self._cancel_events.get(job_id)
        if future is None:
            job = self.storage.get_job(job_id)
            if job is None:
                return {"cancelled": False, "status": "missing"}
            return {"cancelled": False, "status": job.status}
        if future.done():
            self._forget(job_id)
            job = self.storage.get_job(job_id)
            return {"cancelled": False, "status": job.status if job else "missing"}
        if cancel_event:
            cancel_event.set()
        if future.cancel():
            self.storage.update_job(
                job_id,
                status="cancelled",
                error="job cancelled before execution",
            )
            self._forget(job_id)
            return {"cancelled": True, "status": "cancelled"}
        if future.done():
            self._forget(job_id)
            job = self.storage.get_job(job_id)
            return {"cancelled": False, "status": job.status if job else "missing"}
        self.storage.update_job(
            job_id,
            status="cancelled",
            error="job cancellation requested",
        )
        return {"cancelled": True, "status": "cancelled"}

    def _forget(self, job_id: str) -> None:
        with self._lock:
            future = self._futures.pop(job_id, None)
            self._cancel_events.pop(job_id, None)
        if future is not None:
            self._slots.release()
