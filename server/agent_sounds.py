"""Private agent-addressed generated assets; shared record exports stay in Akousmata."""

import json
import secrets
import wave
import zipfile
from akousma.bundles import bundle_manifest_errors
from server.generation_decisions import _hash, _read
from server.registry import storage
from server.storage import utc_now_iso


def package(metadata_files, recipient_requirements):
    if (
        not isinstance(metadata_files, list)
        or not 1 <= len(metadata_files) <= 16
        or len(set(metadata_files)) != len(metadata_files)
    ):
        raise ValueError("Choose 1–16 distinct generated outputs")
    if (
        not isinstance(recipient_requirements, list)
        or not 1 <= len(recipient_requirements) <= 32
        or any(not isinstance(v, str) or not 1 <= len(v) <= 256 for v in recipient_requirements)
    ):
        raise ValueError("Declare bounded recipient capabilities")
    entries, assets = [], []
    for i, filename in enumerate(metadata_files):
        path = storage.resolve_existing_metadata_path(filename)
        metadata = json.loads(path.read_text())
        try:
            job = storage.read_job_receipt(metadata["generation_job_id"])
        except FileNotFoundError as exc:
            raise ValueError("Generation receipt is not settled; retry after completion") from exc
        if job.get("status") != "done" or not any(
            storage.resolve_existing_metadata_path(p) == path for p in job.get("metadata_files", [])
        ):
            raise ValueError("Generated asset needs a settled output receipt")
        masa = metadata.get("masa", {})
        audio = storage.resolve_existing_input_audio_path(metadata["output_audio_path"])
        if masa.get("status") != "written" or _hash(audio) != masa.get("output_sha256"):
            raise ValueError("Generated asset changed or has no negotiated receipt")
        sidecar_path = storage.resolve_existing_path(masa["sidecar_path"])
        if not storage.is_within(sidecar_path, storage.settings.output_root / "masa"):
            raise ValueError("MASA receipt must be in the owned sidecar directory")
        sidecar = _read(sidecar_path)
        event = next((e for e in sidecar.get("history", {}).get("events", []) if e.get("id") == masa.get("receipt_id")), None)
        rep = next((r for r in sidecar.get("representations", []) if r.get("id") == masa.get("representation_id")), None)
        if (not event or not rep or event.get("finalStatus") != "completed"
                or rep["id"] not in event.get("outputs", [])
                or rep.get("integrity", {}).get("value", {}).get("digest") != masa["output_sha256"]
                or event.get("extensions", {}).get("germ:execution", {}).get("jobId") != metadata["generation_job_id"]):
            raise ValueError("MASA representation and receipt do not bind this output")
        if audio.stat().st_size > 32 * 1024 * 1024:
            raise ValueError("Asset exceeds 32 MiB")
        with wave.open(str(audio)) as wav:
            representation = dict(
                encoding=f"PCM{wav.getsampwidth() * 8} WAV",
                sample_rate_hz=wav.getframerate(),
                channels=wav.getnchannels(),
                sampled_band_hz={
                    "status": "unknown",
                    "nyquist_limit_hz": wav.getframerate() / 2,
                    "reason": "A sampling limit does not establish retained spectral energy",
                },
                human_perceptual_access="unknown",
            )
        spectral = metadata.get("synthesis", {}).get("spectral")
        if spectral:
            if spectral.get("sample_rate_hz") != representation["sample_rate_hz"]:
                raise ValueError("Spectral receipt and WAV rate disagree")
            representation["sampled_band_hz"].update(
                intended_band_hz=spectral["intended_band_hz"], measured=spectral["measured"],
                scope=spectral["scope"], limitations=spectral["limitations"])
        entry = dict(
            id=masa["representation_id"],
            path=f"assets/{i:04d}.wav",
            sha256=masa["output_sha256"],
            source_sha256=masa["output_sha256"],
            schema_version="masa/0.2.0",
            kind="audio",
            evidence_class="generated",
            covenants=metadata.get("source", {}).get("derivation", {}).get("covenants", []),
            transforms=[{"generation_receipt": masa["receipt_id"]}],
            recipient_requirements=recipient_requirements,
            representation=representation,
        )
        entries.append(entry)
        assets.append(audio)
    if sum(p.stat().st_size for p in assets) > 32 * 1024 * 1024:
        raise ValueError("Pack exceeds 32 MiB")
    manifest = dict(
        contract="earworm/agent-sounds/v1",
        bundle_id="bundle:" + secrets.token_hex(16),
        created_at=utc_now_iso(),
        producer="germ",
        disclosure="private",
        entries=entries,
        human_rendering="none",
    )
    errors = bundle_manifest_errors(manifest)
    if errors:
        raise ValueError("; ".join(errors))
    root = storage.settings.output_root / "agent-sounds"
    root.mkdir(parents=True, exist_ok=True)
    path = root / (secrets.token_hex(16) + ".zip")
    try:
        with zipfile.ZipFile(path, "x", compression=zipfile.ZIP_DEFLATED) as archive:
            archive.writestr("manifest.json", json.dumps(manifest, allow_nan=False))
            for entry, asset in zip(entries, assets):
                data = asset.read_bytes()
                from hashlib import sha256

                if sha256(data).hexdigest() != entry["sha256"]:
                    raise ValueError("Asset changed while packaging")
                archive.writestr(entry["path"], data)
    except Exception:
        path.unlink(missing_ok=True)
        raise
    return dict(manifest=manifest, archive=storage.relative_path(path), sha256=_hash(path))
