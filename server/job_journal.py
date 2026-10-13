"""Bounded private job admission/state journal. Restart never redispatches work."""

from __future__ import annotations

import hashlib
import json
import os
import sqlite3
import threading
from contextlib import contextmanager
from pathlib import Path

MAX_ROWS = 10000
MAX_JOB_BYTES = 256 * 1024
MAX_DATABASE_BYTES = 256 * 1024**2
_LEASES: dict[str, object] = {}
_LEASE_LOCK = threading.Lock()


class JobConflict(ValueError):
    pass


class JobJournal:
    def __init__(self, root: Path):
        self.directory = Path(root).resolve() / "job-journal"
        self.directory.mkdir(mode=0o700, exist_ok=True)
        if self.directory.is_symlink() or self.directory.stat().st_mode & 0o077:
            raise ValueError("Job journal requires a private regular directory")
        self.path = self.directory / "jobs.sqlite3"
        self._lease()
        descriptor = os.open(self.path, os.O_CREAT | os.O_RDWR | os.O_NOFOLLOW, 0o600)
        os.close(descriptor)
        if self.path.stat().st_mode & 0o077:
            raise ValueError("Job journal requires owner-only database permissions")
        with self.connection() as db:
            db.execute(
                "CREATE TABLE IF NOT EXISTS jobs (id TEXT PRIMARY KEY, request_key TEXT UNIQUE NOT NULL, digest TEXT NOT NULL, binding TEXT NOT NULL, state TEXT NOT NULL, body TEXT NOT NULL)"
            )
        self.binding = json.dumps(
            [
                os.getenv("LISTENINGSTACK_WORKSPACE_ID"),
                os.getenv("LISTENINGSTACK_WORKSPACE_GENERATION"),
                str(Path(root).resolve()),
            ],
            separators=(",", ":"),
        )

    def _lease(self):
        import fcntl

        key = str(self.directory)
        with _LEASE_LOCK:
            if key in _LEASES:
                return
            descriptor = os.open(
                self.directory / "writer.lock", os.O_CREAT | os.O_RDWR | os.O_NOFOLLOW, 0o600
            )
            stream = os.fdopen(descriptor, "rb+")
            try:
                fcntl.flock(stream, fcntl.LOCK_EX | fcntl.LOCK_NB)
            except OSError:
                stream.close()
                raise RuntimeError("Another GERM process owns this job journal") from None
            _LEASES[key] = stream  # Process lifetime lease; crash releases the OS lock.

    @contextmanager
    def connection(self):
        if self.path.is_symlink():
            raise ValueError("Symlink job journal refused")
        db = sqlite3.connect(self.path, timeout=5)
        try:
            db.execute("PRAGMA synchronous=FULL")
            db.execute("PRAGMA max_page_count=65536")
            with db:
                yield db
        finally:
            db.close()

    @staticmethod
    def encode(job):
        body = json.dumps(job, sort_keys=True, separators=(",", ":"), allow_nan=False)
        if len(body.encode()) > MAX_JOB_BYTES:
            raise ValueError("Job journal record exceeds its byte budget")
        return body

    def admit(self, job, request_id=None):
        if request_id is not None and (
            not isinstance(request_id, str)
            or not 1 <= len(request_id) <= 128
            or any(
                c not in "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789:_-."
                for c in request_id
            )
        ):
            raise ValueError("Invalid caller job request ID")
        key = hashlib.sha256(
            json.dumps(
                ["caller" if request_id else "generated", request_id or job["job_id"]]
            ).encode()
        ).hexdigest()
        digest = hashlib.sha256(
            json.dumps(
                [job["mode"], job["request"], self.binding],
                sort_keys=True,
                separators=(",", ":"),
                allow_nan=False,
            ).encode()
        ).hexdigest()
        job["metrics"] = {
            **job.get("metrics", {}),
            "admission_contract": "germ/job-admission/v1",
            "request_sha256": digest,
            "workspace_binding_sha256": hashlib.sha256(self.binding.encode()).hexdigest(),
        }
        body = self.encode(job)
        with self.connection() as db:
            db.execute("BEGIN IMMEDIATE")
            previous = db.execute(
                "SELECT digest,binding,body FROM jobs WHERE request_key=?", (key,)
            ).fetchone()
            if previous:
                if previous[0] != digest or previous[1] != self.binding:
                    raise JobConflict(
                        "Job request ID conflicts with retained request or workspace generation"
                    )
                return json.loads(previous[2]), False
            if (
                db.execute("SELECT COUNT(*) FROM jobs").fetchone()[0] >= MAX_ROWS
                or self.path.stat().st_size >= MAX_DATABASE_BYTES
            ):
                raise ValueError("Job journal capacity reached; explicit retention action required")
            db.execute(
                "INSERT INTO jobs VALUES (?,?,?,?,?,?)",
                (
                    job["job_id"],
                    key,
                    digest,
                    self.binding,
                    job.get("metrics", {}).get("execution_state", "created"),
                    body,
                ),
            )
        return job, True

    def save(self, job):
        body = self.encode(job)
        with self.connection() as db:
            db.execute("BEGIN IMMEDIATE")
            changed = db.execute(
                "UPDATE jobs SET state=?,body=? WHERE id=?",
                (job.get("metrics", {}).get("execution_state", "created"), body, job["job_id"]),
            ).rowcount
            if changed != 1:
                raise ValueError("Job state has no durable admission")

    def lookup_request(self, request_id):
        key = hashlib.sha256(json.dumps(["caller", request_id]).encode()).hexdigest()
        with self.connection() as db:
            row = db.execute("SELECT binding,body FROM jobs WHERE request_key=?", (key,)).fetchone()
        if row and row[0] != self.binding:
            raise JobConflict("Retained request belongs to another workspace generation")
        return json.loads(row[1]) if row else None

    def get(self, identifier):
        with self.connection() as db:
            row = db.execute("SELECT body FROM jobs WHERE id=?", (identifier,)).fetchone()
        return json.loads(row[0]) if row else None

    def reconcile(self, timestamp):
        recovered = []
        with self.connection() as db:
            db.execute("BEGIN IMMEDIATE")
            rows = db.execute(
                "SELECT id,body,state FROM jobs WHERE state IN ('created','admitted','running','cancellation_requested') LIMIT ?",
                (MAX_ROWS + 1,),
            ).fetchall()
            if len(rows) > MAX_ROWS:
                raise ValueError("Job recovery capacity exceeded")
            for identifier, body, state in rows:
                job = json.loads(body)
                if job["status"] not in {"done", "error", "cancelled"}:
                    job.update(
                        status="error",
                        error="Owner process interrupted; execution outcome unknown; work was not replayed",
                    )
                job["updated_at"] = timestamp
                job["metrics"] = {
                    **job.get("metrics", {}),
                    "execution_state": "interrupted",
                    "recovery_state": "execution_unknown"
                    if state in {"running", "cancellation_requested"}
                    else "interrupted_before_dispatch",
                    "automatic_replay": False,
                    "receipt_ready": False,
                }
                db.execute(
                    "UPDATE jobs SET state='interrupted',body=? WHERE id=?",
                    (self.encode(job), identifier),
                )
                recovered.append(job)
        return recovered
