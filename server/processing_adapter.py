"""Owner-invoked MASA processing adapter over GERM's existing AudioWorklet DSP.

This local callable/CLI takes a separately supplied host policy decision. It is
not a public intake route and does not derive permission from a processing request.
"""

from __future__ import annotations

import argparse
import copy
import hashlib
import json
import math
import os
import secrets
import shutil
import signal
import sys
import subprocess
import tempfile
import threading
import time
import wave
from datetime import datetime, timezone
from pathlib import Path
from uuid import uuid4

from server.identity import __version__
from server.storage import utc_now_iso

ENGINE = Path(__file__).resolve().parents[1] / "scripts/processing-engine.mjs"
MAX_BYTES = 12 * 1024 * 1024
MAX_SECONDS = 30


def digest(value):
    return hashlib.sha256(
        json.dumps(value, sort_keys=True, separators=(",", ":"), allow_nan=False).encode()
    ).hexdigest()


def file_digest(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def known(value):
    return {"state": "known", "value": value}


class Refused(ValueError):
    pass


class Cancelled(RuntimeError):
    pass


def check_cancel(cancel):
    if cancel.is_set():
        raise Cancelled("owner cancelled processing")


def validate(kind, value, validator, directory):
    config = directory / "validation.json"
    config.write_text(json.dumps(dict(kind=kind, value=value, validator=str(validator))))
    run = subprocess.run(
        ["node", "--max-old-space-size=128", str(ENGINE), "validate", str(config)],
        capture_output=True,
        timeout=15,
        check=False,
    )
    if run.returncode:
        raise ValueError("MASA validation failed: " + run.stdout.decode(errors="replace")[:3000])


def engine_parameters(request):
    p = request["parameters"]
    engine = request.get("engine", {})
    if engine.get("state") == "known" and engine.get("value") != "germ:granular-worklet":
        raise Refused("requested engine does not match this adapter")
    if request["operationType"] != "matter.granulate" or set(p) != {
        "grain",
        "emission",
        "selection",
        "output",
    }:
        raise Refused("adapter supports only the declared granulation parameter subset")
    grain, emission, selection = p["grain"], p["emission"], p["selection"]
    if set(grain) - {
        "durationMs",
        "envelope",
        "amplitudeScatter",
        "pitchScatterCents",
        "panScatter",
    }:
        raise Refused("unsupported grain field")
    size = grain["durationMs"]
    if set(size) != {"min", "max"} or any(
        type(v) not in (int, float) or not math.isfinite(v) for v in size.values()
    ):
        raise Refused("invalid grain duration")
    for key, maximum in (("amplitudeScatter", 0), ("pitchScatterCents", 700), ("panScatter", 1)):
        value = grain.get(key, 0)
        if type(value) not in (int, float) or not math.isfinite(value) or not 0 <= value <= maximum:
            raise Refused("unsupported grain scatter")
    if not (8 <= size["min"] == size["max"] <= 400):
        raise Refused("grain duration must be fixed between 8 and 400 ms")
    if grain["envelope"] not in {"gaussian", "triangular"}:
        raise Refused("supported request envelopes are gaussian and triangular")
    if grain.get("amplitudeScatter", 0) != 0 or grain.get("pitchScatterCents", 0) > 700:
        raise Refused("amplitude scatter is unsupported; pitch scatter is at most 700 cents")
    if set(emission) != {"mode", "grainsPerSecond"} or emission["mode"] != "synchronous":
        raise Refused("only synchronous block-quantized emission without totalGrains is supported")
    rate = emission["grainsPerSecond"]
    if (
        type(rate) not in (int, float)
        or not math.isfinite(rate)
        or not 4 <= rate <= 120
        or rate * size["min"] / 1000 > 40
    ):
        raise Refused("density or simultaneous grain budget exceeded")
    if selection != {"order": "random"} or p["output"] != {"kind": "texture"}:
        raise Refused("only random ring-buffer selection and texture output are supported")
    contract = request["outputContract"]
    if "derivative" not in contract["roles"] or "audio/wav" not in contract.get(
        "mediaTypes", ["audio/wav"]
    ):
        raise Refused("output contract must allow a derivative PCM WAV")
    seed = request["extensions"].get("germ:micro", {}).get("seed")
    if request["determinism"] == "require-deterministic":
        raise Refused("random grain selection offers seeded, not unseeded deterministic execution")
    if seed is None and request["determinism"] == "require-seeded":
        raise Refused("require-seeded needs germ:micro.seed")
    if seed is not None and (type(seed) is not int or not 0 <= seed <= 0xFFFFFFFF):
        raise Refused("seed must be an unsigned 32-bit integer")
    # Retain the generated seed too: accepted nondeterminism need not be irreproducible.
    seed = secrets.randbits(32) if seed is None else seed
    return dict(
        sizeMs=size["min"],
        density=(rate - 4) / 116,
        jitter=0.35,
        scatter=grain.get("pitchScatterCents", 0) / 700,
        spray=grain.get("panScatter", 0),
        envelope=grain["envelope"],
    ), seed


def render(config, directory, cancel, timeout):
    path = directory / "engine.json"
    path.write_text(json.dumps(config))
    process = subprocess.Popen(
        ["node", "--max-old-space-size=128", str(ENGINE), "render", str(path)],
        stdin=subprocess.DEVNULL,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
    )
    try:
        deadline = time.monotonic() + timeout
        while process.poll() is None:
            check_cancel(cancel)
            if time.monotonic() > deadline:
                raise TimeoutError("granulation exceeded execution deadline")
            cancel.wait(0.01)
        check_cancel(cancel)
        if process.returncode:
            raise RuntimeError("granulation engine failed")
    finally:
        if process.poll() is None:
            process.terminate()
            try:
                process.wait(timeout=2)
            except subprocess.TimeoutExpired:
                process.kill()
                process.wait(timeout=2)


def render_room(config, temp, cancel, timeout):
    config["receipt"] = str(temp / "room-receipt.json")
    path = temp / "room-config.json"
    path.write_text(json.dumps(config))
    process = subprocess.Popen(
        [sys.executable, str(Path(__file__).with_name("room_engine.py")), str(path)],
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
        env={**os.environ, "OMP_NUM_THREADS": "1", "OPENBLAS_NUM_THREADS": "1"},
    )
    try:
        deadline = time.monotonic() + timeout
        while process.poll() is None:
            check_cancel(cancel)
            if time.monotonic() > deadline:
                raise TimeoutError("room simulation exceeded execution deadline")
            cancel.wait(0.01)
        check_cancel(cancel)
        if process.returncode:
            raise RuntimeError(
                "Room engine failed; install GERM room support and check admitted input"
            )
    finally:
        if process.poll() is None:
            process.terminate()
            try:
                process.wait(timeout=2)
            except subprocess.TimeoutExpired:
                process.kill()
                process.wait(timeout=2)


def execute(
    request, record, source_path, authority, output_root, validator, *, cancel=None, timeout=30
):
    """Run under an owner-authored, hash-bound policy evaluation; persist a new revision.

    Invalid MASA documents fail before execution. Valid requests that the adapter
    cannot honor produce refused receipts. Only a validated successful run publishes
    a WAV; all other outcomes publish a receipt without a new descendant.
    """
    if not math.isfinite(timeout) or not 0 <= timeout <= 30:
        raise ValueError("execution timeout must be finite and at most 30 seconds")
    cancel = cancel or threading.Event()
    request, record, authority = map(copy.deepcopy, (request, record, authority))
    room = request.get("operationType") == "matter.derive"
    engine_id = "germ:pyroomacoustics" if room else "germ:granular-worklet"
    source_path, output_root, validator = map(Path, (source_path, output_root, validator))
    output_root.mkdir(parents=True, exist_ok=True)
    run_id = str(uuid4())
    destination = output_root / run_id
    with tempfile.TemporaryDirectory(prefix=".processing-", dir=output_root) as temporary:
        temp = Path(temporary)
        validate("request", request, validator, temp)
        validate("record", record, validator, temp)
        evaluation = copy.deepcopy(authority["policyEvaluation"])
        actor = evaluation["evaluator"]
        started = utc_now_iso()
        events = record["history"].get("events", [])
        receipt = dict(
            id="urn:uuid:" + str(uuid4()),
            type="masa:OperationReceipt",
            recordId=record["id"],
            sequence=max((e["sequence"] for e in events), default=-1) + 1,
            operationType=request["operationType"],
            effectClass="derive",
            finalStatus="refused",
            startedAt=started,
            endedAt=started,
            actors=[actor],
            inputs=request["inputs"],
            outputs=[],
            tool=known(
                dict(
                    id=engine_id,
                    name="GERM simulated shoebox" if room else "GERM granular AudioWorklet",
                    version=known(__version__),
                    kind="software",
                )
            ),
            parameters=request["parameters"],
            policyEvaluation=evaluation,
            reversibility="compensatable",
            determinism={"state": "undetermined"},
            warnings=[],
            errors=[],
            claimRefs=[],
            extensions={
                "germ:processing": dict(
                    requestId=request["id"],
                    requestSha256=digest(request),
                    engineSha256=file_digest(ENGINE),
                    dspSha256=file_digest(
                        ENGINE.parent.parent / "dashboard/static/audio_engine.js"
                    ),
                    nodeVersion=subprocess.check_output(["node", "--version"], text=True).strip(),
                )
            },
        )
        if room:
            extension = receipt["extensions"]["germ:processing"]
            extension["engineSha256"] = file_digest(Path(__file__).with_name("room_engine.py"))
            extension.pop("dspSha256", None)
            extension.pop("nodeVersion", None)
        # Validate the supplied policy shape before using it, including refusal paths.
        validate("receipt", receipt, validator, temp)
        result_record = copy.deepcopy(record)
        try:
            check_cancel(cancel)
            if (
                record["history"]["mode"] != "embedded"
                or request.get("recordRef", record["id"]) != record["id"]
            ):
                raise Refused("adapter requires the matching record with embedded history")
            if authority.get("requestSha256") != digest(request) or authority.get(
                "recordSha256"
            ) != digest(record):
                raise Refused("host authorization does not bind this request and record")
            expiry = datetime.fromisoformat(authority["expiresAt"].replace("Z", "+00:00"))
            if expiry.tzinfo is None or expiry <= datetime.now(timezone.utc):
                raise Refused("host authorization has expired")
            if len(request["inputs"]) != 1 or not request["policyRefs"]:
                raise Refused("one input and explicit policies are required")
            policies = {p["id"]: p for p in record["policies"]}
            if (
                evaluation["result"] != "permitted"
                or evaluation["action"] != request["operationType"]
                or evaluation["targets"] != request["inputs"]
                or evaluation["policyRefs"] != request["policyRefs"]
                or not evaluation["authorityRefs"]
                or actor not in {a["id"] for a in record["actors"]}
                or any(
                    p not in policies or policies[p]["status"] != "active"
                    for p in request["policyRefs"]
                )
            ):
                raise Refused("host policy evaluation does not authorize this operation")
            source = next(
                (r for r in record["representations"] if r["id"] == request["inputs"][0]), None
            )
            if source is None or source["policyRefs"] != request["policyRefs"]:
                raise Refused("source representation or policies do not match")
            if room:
                from server.room_engine import parameters as room_parameters

                params, seed = room_parameters(request)
            else:
                params, seed = engine_parameters(request)
            if source_path.stat().st_size > MAX_BYTES:
                raise Refused("source exceeds the 12 MiB byte limit")
            before = file_digest(source_path)
            if before != authority.get("sourceSha256"):
                raise Refused("source bytes do not match host authorization")
            with wave.open(str(source_path), "rb") as wav:
                channels, rate, frames = wav.getnchannels(), wav.getframerate(), wav.getnframes()
                if (
                    wav.getsampwidth() != 2
                    or wav.getcomptype() != "NONE"
                    or channels not in {1, 2}
                    or not 8000 <= rate <= 96000
                    or not 0 < frames <= rate * MAX_SECONDS
                ):
                    raise Refused("input must be bounded mono/stereo 16-bit PCM WAV at 8–96 kHz")
                if room and (channels != 1 or rate not in {16000, 44100, 48000, 96000}):
                    raise Refused("Room source must be mono PCM16 at 16, 44.1, 48 or 96 kHz")
                if not room and frames / rate < params["sizeMs"] / 1000 + 0.05:
                    raise Refused("source is too short to fill the granulator history")
                raw = wav.readframes(frames)
                if len(raw) != frames * channels * 2:
                    raise Refused("truncated source PCM")
            (temp / "input.pcm").write_bytes(raw)
            (render_room if room else render)(
                dict(
                    input=str(temp / "input.pcm"),
                    output=str(temp / "output.wav"),
                    sampleRate=rate,
                    channels=channels,
                    params=params,
                    seed=seed,
                ),
                temp,
                cancel,
                timeout,
            )
            if file_digest(source_path) != before:
                raise Refused("source changed during execution")
            check_cancel(cancel)
            if expiry <= datetime.now(timezone.utc):
                raise Refused("host authorization expired during execution")
            room_receipt = None
            if room:
                room_receipt = json.loads((temp / "room-receipt.json").read_text())
                frames = room_receipt["frames"]
                if type(frames) is not int or not 0 < frames <= rate * 35:
                    raise RuntimeError("Room output frame budget exceeded")
            with wave.open(str(temp / "output.wav"), "rb") as wav:
                if (
                    wav.getnchannels(),
                    wav.getframerate(),
                    wav.getnframes(),
                    wav.getsampwidth(),
                ) != (channels, rate, frames, 2):
                    raise RuntimeError("engine output format or duration mismatch")
                if len(wav.readframes(frames)) != frames * channels * 2:
                    raise RuntimeError("engine output PCM is truncated")
            sound_id = "sound_" + str(uuid4())
            descendant_id = "urn:uuid:" + str(uuid4())
            descendant = dict(
                type="masa:Representation", policyRefs=source["policyRefs"], disclosure="private"
            )
            descendant.update(
                id=descendant_id,
                role="derivative",
                mediaType="audio/wav",
                availability="available",
                format=known("16-bit PCM WAV"),
                locator=known(str(destination / "output.wav")),
                integrity=known(
                    dict(
                        algorithm="sha-256",
                        digest=file_digest(temp / "output.wav"),
                        byteLength=(temp / "output.wav").stat().st_size,
                        status="verified",
                    )
                ),
                extensions={
                    "germ:lineage": {"soundId": sound_id, "parentRepresentation": source["id"]}
                },
            )
            # Output is a new sampled representation; do not inherit source apparatus or claims.
            descendant["audio"] = dict(
                durationSeconds=known(frames / rate),
                channels=known(channels),
                sampleRateHz=known(rate),
                bitDepth=known(16),
                encoding=known("PCM signed integer little-endian"),
                spatialFormat=known("mono" if channels == 1 else "stereo"),
                levelContext={
                    "state": "unknown",
                    "reason": "Digital rendering; no calibrated playback chain.",
                    "reasonCode": "not_calibrated",
                },
            )
            parent_sound = source.get("extensions", {}).get("germ:lineage", {}).get("soundId")
            if parent_sound:
                descendant["extensions"]["germ:lineage"]["parentSoundId"] = parent_sound
            result_record["representations"].append(descendant)
            result_record["relations"].append(
                dict(
                    id="urn:uuid:" + str(uuid4()),
                    type="masa:Relation",
                    subject=descendant_id,
                    predicate="masa:derived-from" if room else "masa:granulated-from",
                    object=source["id"],
                    assertedBy=actor,
                    createdAt=utc_now_iso(),
                    basis=[{"ref": receipt["id"], "role": "operation"}],
                    operationRef=receipt["id"],
                    extensions={},
                )
            )
            receipt.update(
                finalStatus="completed",
                outputs=[descendant_id],
                determinism=dict(
                    state="deterministic" if room else "seeded",
                    seed=seed,
                    note="Same engine and dependency versions; dither disabled. Seed retained; room ISM uses no randomness."
                    if room
                    else "Same engine/DSP hashes and Node runtime; dither disabled.",
                ),
            )
            receipt["extensions"]["germ:processing"].update(
                sourceSha256=before,
                soundId=sound_id,
                outputSha256=descendant["integrity"]["value"]["digest"],
                sampleRate=rate,
                channels=channels,
                frames=frames,
                engineParameters=params,
                renderQuantum=128,
                tail="truncated at source duration",
            )
            if room:
                extension = receipt["extensions"]["germ:processing"]
                for key in ("dspSha256", "nodeVersion", "renderQuantum"):
                    extension.pop(key, None)
                extension.update(
                    engineSha256=file_digest(Path(__file__).with_name("room_engine.py")),
                    tail=room_receipt["tail"],
                    room=room_receipt,
                )
        except Cancelled as exc:
            receipt.update(finalStatus="cancelled", errors=[str(exc)])
        except Refused as exc:
            receipt.update(finalStatus="refused", errors=[str(exc)])
        except (
            OSError,
            ValueError,
            RuntimeError,
            TimeoutError,
            KeyError,
            EOFError,
            wave.Error,
        ) as exc:
            receipt.update(
                finalStatus="failed", errors=["processing failed: " + type(exc).__name__]
            )
        receipt["endedAt"] = utc_now_iso()
        if receipt["finalStatus"] != "completed":
            result_record = copy.deepcopy(record)
            (temp / "output.wav").unlink(missing_ok=True)
        result_record["revision"] += 1
        result_record["history"] = {"mode": "embedded", "events": [*events, receipt]}
        if "processing" not in result_record["profiles"]:
            result_record["profiles"].append("processing")
        validate("record", result_record, validator, temp)
        # Publication admission is rechecked after potentially slow offline validation.
        expired = receipt["finalStatus"] == "completed" and expiry <= datetime.now(timezone.utc)
        changed_source = (
            receipt["finalStatus"] == "completed" and file_digest(source_path) != before
        )
        if (cancel.is_set() or expired or changed_source) and receipt["finalStatus"] == "completed":
            receipt.update(
                finalStatus="cancelled" if cancel.is_set() else "refused",
                outputs=[],
                errors=[
                    "owner cancelled before publication"
                    if cancel.is_set()
                    else "source authorization expired or source changed before publication"
                ],
                determinism={"state": "undetermined"},
            )
            for key in ("soundId", "outputSha256", "room"):
                receipt["extensions"]["germ:processing"].pop(key, None)
            result_record = copy.deepcopy(record)
            result_record["revision"] += 1
            result_record["history"] = {"mode": "embedded", "events": [*events, receipt]}
            (temp / "output.wav").unlink(missing_ok=True)
            validate("record", result_record, validator, temp)
        publish = temp / "publish"
        publish.mkdir()
        if receipt["finalStatus"] == "completed":
            shutil.move(temp / "output.wav", publish / "output.wav")
        (publish / "record.masa.json").write_text(json.dumps(result_record, indent=2) + "\n")
        (publish / "request.json").write_text(json.dumps(request, indent=2) + "\n")
        os.rename(publish, destination)
        return dict(
            status=receipt["finalStatus"],
            directory=str(destination),
            record=result_record,
            receipt=receipt,
        )


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    for flag in ("request", "record", "source", "authority", "output", "validator"):
        parser.add_argument("--" + flag, type=Path, required=True)
    args = parser.parse_args()
    cancel = threading.Event()
    signal.signal(signal.SIGINT, lambda *_: cancel.set())
    signal.signal(signal.SIGTERM, lambda *_: cancel.set())

    def load(path):
        if path.stat().st_size > MAX_BYTES:
            raise ValueError("input JSON exceeds byte limit")
        return json.loads(path.read_text())

    result = execute(
        load(args.request),
        load(args.record),
        args.source,
        load(args.authority),
        args.output,
        args.validator,
        cancel=cancel,
    )
    print(json.dumps({k: result[k] for k in ("status", "directory")}))
    return 0 if result["status"] == "completed" else 1


if __name__ == "__main__":
    raise SystemExit(main())
