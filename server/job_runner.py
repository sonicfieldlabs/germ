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
        self._workers = settings.job_workers
        self._capacity = max(self._workers, self._workers * 8)
        self._lock = Lock()
        self._futures: dict[str, Future[Any]] = {}
        self._cancel_events: dict[str, Event] = {}
        self._accepting = False
        self._settlement_recording_failures = 0
        self._drained = Event()
        self._drained.set()
        self.startup()

    def startup(self) -> None:
        with self._lock:
            if self._accepting:
                return
            if self._futures:
                raise RuntimeError("Previous workers have not settled")
            self.storage.reconcile_interrupted_jobs()
            self.executor = ThreadPoolExecutor(
                max_workers=self._workers, thread_name_prefix="germ-job"
            )
            self._slots = BoundedSemaphore(self._capacity)
            self._accepting = True

    def status(self) -> dict:
        with self._lock:
            return dict(
                accepting=self._accepting,
                workers=self._workers,
                capacity=self._capacity,
                outstanding=len(self._futures),
                settlement_recording_failures=self._settlement_recording_failures,
            )

    def idle_control(self, action):
        """Serialize model controls with admission, without interrupting active jobs."""
        with self._lock:
            if self._futures:
                raise RuntimeError("Wait for queued and running generations before resetting the gateway")
            return action()

    def submit(
        self, runner_job_id: str, fn: Callable[..., Any], *args: Any, **kwargs: Any
    ) -> Future:
        ready = Event()
        cancel_event = Event()

        def invoke():
            ready.wait()
            return fn(*args, **kwargs, cancel_event=cancel_event)

        with self._lock:
            if not self._accepting:
                raise RuntimeError("background job runner is shutting down")
            if runner_job_id in self._futures:
                raise RuntimeError("job is already admitted")
            if not self._slots.acquire(blocking=False):
                raise JobQueueFullError("background job queue is full")
            try:
                self.storage.update_job(runner_job_id, metrics={"execution_state": "admitted"})
                future = self.executor.submit(invoke)
            except Exception:
                self._slots.release()
                raise
            self._drained.clear()
            self._futures[runner_job_id] = future
            self._cancel_events[runner_job_id] = cancel_event
        future.add_done_callback(lambda completed: self._forget(runner_job_id, completed))
        ready.set()
        return future

    def cancel(self, job_id: str) -> dict[str, str | bool]:
        with self._lock:
            future = self._futures.get(job_id)
            cancel_event = self._cancel_events.get(job_id)
        job = self.storage.get_job(job_id)
        if job is None:
            return {"cancelled": False, "status": "missing"}
        if future is None or future.done() or job.status in {"done", "error"}:
            return {"cancelled": False, "status": job.status}
        if not self.storage.request_job_cancellation(job_id):
            current = self.storage.get_job(job_id)
            return {"cancelled": False, "status": current.status if current else "missing"}
        if cancel_event:
            cancel_event.set()
        if future.cancel():
            self.storage.update_job(
                job_id,
                error="job cancelled before execution",
                metrics={"execution_state": "settled"},
            )
        return {"cancelled": True, "status": "cancelled"}

    def _forget(self, job_id: str, completed: Future) -> None:
        try:
            if not completed.cancelled():
                error = completed.exception()
                if error is not None:
                    self.storage.update_job(job_id, status="error", error=str(error)[:2000])
            current = self.storage.get_job(job_id)
            if current and current.status in {"running", "queued"}:
                self.storage.update_job(job_id, status="error", error="worker exited without a terminal result")
            self.storage.update_job(job_id, metrics={"execution_state": "settled"})
            self.storage.write_job_receipt(job_id)
            settled = self.storage.get_job(job_id)
            self.storage.update_job(job_id, metrics={"receipt_ready": bool(settled and not settled.metrics.get("lifecycle_receipt_error"))})
        except Exception:
            # A failed disk write must not leak capacity. Durable state remains unknown
            # and restart reconciliation exposes that uncertainty without replay.
            with self._lock:
                self._settlement_recording_failures += 1
        finally:
            with self._lock:
                future = self._futures.pop(job_id, None)
                self._cancel_events.pop(job_id, None)
                if future is not None:
                    self._slots.release()
                if not self._futures:
                    self._drained.set()

    def wait_for_settlement(self, timeout: float) -> bool:
        return self._drained.wait(timeout)

    def shutdown(self, *, wait: bool = False) -> None:
        with self._lock:
            self._accepting = False
            jobs = list(self._futures)
            executor = self.executor
        for job_id in jobs:
            self.cancel(job_id)
        executor.shutdown(wait=wait, cancel_futures=True)
