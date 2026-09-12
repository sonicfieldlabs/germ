#!/usr/bin/env python3
"""Run uvicorn as a process group tied to the native app's lifetime."""

from __future__ import annotations

import argparse
import os
from pathlib import Path
import signal
import subprocess
import sys
import time


def process_exists(pid: int) -> bool:
    try:
        os.kill(pid, 0)
    except ProcessLookupError:
        return False
    except PermissionError:
        return True
    return True


def terminate_process_group(process: subprocess.Popen[bytes]) -> None:
    if process.poll() is not None:
        return
    try:
        os.killpg(process.pid, signal.SIGTERM)
    except ProcessLookupError:
        return

    try:
        # Allow the server's HTTP grace and bounded worker drain to complete.
        try:
            drain = min(60.0, max(0.0, float(os.environ.get("GERM_WORKER_SHUTDOWN_SECONDS", "7"))))
            grace = max(0.0, float(os.environ.get("GERM_SHUTDOWN_GRACE_SECONDS", "2")))
        except ValueError:
            drain, grace = 7.0, 2.0
        process.wait(timeout=max(12.0, drain + grace + 2.0))
        return
    except subprocess.TimeoutExpired:
        pass

    try:
        os.killpg(process.pid, signal.SIGKILL)
    except ProcessLookupError:
        return
    process.wait()


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("--parent-pid", type=int, required=True)
    parser.add_argument("app")
    parser.add_argument("uvicorn_args", nargs=argparse.REMAINDER)
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    stopping = False

    def request_stop(_signal_number: int, _frame: object) -> None:
        nonlocal stopping
        stopping = True

    signal.signal(signal.SIGTERM, request_stop)
    signal.signal(signal.SIGINT, request_stop)

    uvicorn_args = list(args.uvicorn_args)
    if not any(value.startswith("--timeout-graceful-shutdown") for value in uvicorn_args):
        uvicorn_args.extend(["--timeout-graceful-shutdown", os.environ.get("GERM_SHUTDOWN_GRACE_SECONDS", "2")])
    command = [sys.executable, "-m", "uvicorn", args.app, *uvicorn_args]
    child = subprocess.Popen(
        command,
        cwd=Path.cwd(),
        start_new_session=True,
    )

    try:
        while child.poll() is None:
            if stopping or not process_exists(args.parent_pid):
                break
            time.sleep(0.25)
        if child.poll() is None:
            terminate_process_group(child)
        return child.returncode or 0
    finally:
        terminate_process_group(child)


if __name__ == "__main__":
    raise SystemExit(main())
