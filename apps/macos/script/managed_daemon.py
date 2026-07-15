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
        process.wait(timeout=5)
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

    command = [sys.executable, "-m", "uvicorn", args.app, *args.uvicorn_args]
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
