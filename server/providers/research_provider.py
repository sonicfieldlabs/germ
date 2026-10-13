"""Research artifacts use the existing GERM queue and lifecycle receipts."""

import json
import os
import shutil
import signal
import subprocess
import tempfile
import time
from pathlib import Path

from akousma.resource_admission import admitted

from server.providers.base import AudioGenerationProvider, admission_checkpoint
from server.research.deployment import deployment, sha
from server.schemas import GenerationResult


class ResearchProvider(AudioGenerationProvider):
    provider_id = "research"

    def list_models(self):
        result = []
        for tool in ["rave-guitar", "basic-pitch"]:
            try:
                deployment(tool)
                result.append(tool)
            except (OSError, ValueError, KeyError):
                pass
        return result

    def is_available(self):
        return bool(self.list_models())

    def load_model(self, model_id, device="cpu"):
        deployment(model_id, verify=True)
        self.loaded_model_id = model_id
        self.current_device = "cpu"
        return dict(status="loaded", model=model_id, provider=self.provider_id, device="cpu")

    def generate(self, request):
        raise ValueError("Research instruments require a Library source")

    inpaint = generate
    continue_audio = generate

    @admitted("germ", checkpoint=admission_checkpoint)
    def audio_to_audio(self, request):
        import soundfile as sf

        from server.research.requests import Controls

        config = deployment(request.model, verify=True)
        control = Controls.model_validate(request.source.get("research", {}))
        if (
            config["profile"] == "noncommercial_research"
            and control.profile != "noncommercial_research"
        ):
            raise ValueError("This checkpoint is restricted to the noncommercial research profile")
        if request.batch_size != 1 or not 0 < request.duration <= 30 or not request.job_id:
            raise ValueError("Research requires one bounded job of at most 30 seconds")
        if request.model == "basic-pitch" and (
            control.latent_scale != 1 or control.latent_bias != 0
        ):
            raise ValueError("Basic Pitch does not support latent controls")
        source = self.storage.resolve_existing_input_audio_path(request.input_audio_path)
        info = sf.info(source)
        if (
            source.stat().st_size > 512 * 1024 * 1024
            or info.channels > 8
            or control.start_seconds + request.duration > info.duration + 1 / info.samplerate
        ):
            raise ValueError("Research source or interval exceeds bounds")
        digest = sha(source)
        if request.source.get("sha256") != digest:
            raise ValueError("Research source changed before admission")
        from server.routes.library import resolve_library_audio

        item, canonical = resolve_library_audio(request.source.get("key", ""))
        if canonical.resolve() != source.resolve() or item["sound_id"] != request.source.get(
            "sound_id"
        ):
            raise ValueError("Research lineage does not match the Library source")
        if (
            item.get("generation_receipt", {}).get("profile") == "noncommercial_research"
            and control.profile != "noncommercial_research"
        ):
            raise ValueError("Parent requires the noncommercial research profile")
        parent = request.source.get("sound_id")
        target = self.storage.metadata_dir / "research" / request.job_id
        target.parent.mkdir(parents=True, exist_ok=True)
        if target.exists():
            raise ValueError("Research output already exists")
        worker = Path(__file__).parents[1] / "research/worker.py"
        if str(worker) not in config["files"]:
            raise ValueError("Worker is not part of the admitted deployment")

        def check():
            if self.is_job_cancelled(request.job_id):
                raise InterruptedError("Research job cancelled")

        with tempfile.TemporaryDirectory(prefix="germ-research-") as tmp:
            tmp = Path(tmp)
            work = tmp / "artifacts"
            work.mkdir()
            req = dict(
                input=str(source),
                output=str(work),
                tool=request.model,
                model_path=config["model_path"],
                start_seconds=control.start_seconds,
                seconds=request.duration,
                seed=max(request.seed, 0),
                latent_scale=control.latent_scale,
                latent_bias=control.latent_bias,
            )
            (tmp / "request.json").write_text(json.dumps(req))
            with (tmp / "worker.log").open("w") as log:
                process = subprocess.Popen(
                    [config["python"], str(worker), str(tmp / "request.json")],
                    env={k: v for k, v in os.environ.items() if k in {"PATH", "HOME", "TMPDIR"}},
                    stdout=log,
                    stderr=log,
                    start_new_session=True,
                )
                try:
                    deadline = time.monotonic() + 180
                    while process.poll() is None:
                        check()
                        if time.monotonic() > deadline:
                            raise TimeoutError("Research worker exceeded 180 seconds")
                        time.sleep(0.1)
                    check()
                    if process.returncode:
                        raise ValueError("Research worker failed; no artifact admitted")
                    result_path = work / "result.json"
                    if result_path.is_symlink() or result_path.stat().st_size > 1024 * 1024:
                        raise ValueError("Research result manifest exceeds bounds")
                    result = json.loads(result_path.read_text())
                finally:
                    if process.poll() is None:
                        os.killpg(process.pid, signal.SIGTERM)
                        try:
                            process.wait(3)
                        except subprocess.TimeoutExpired:
                            os.killpg(process.pid, signal.SIGKILL)
                            process.wait()
            if sha(source) != digest:
                raise ValueError("Research source changed during processing")
            expected = (
                {"transform.wav"} if request.model == "rave-guitar" else {"notes.json", "notes.mid"}
            )
            if {a["file"] for a in result["artifacts"]} != expected or len(
                result["artifacts"]
            ) != len(expected):
                raise ValueError("Research artifact set is incomplete")
            for artifact in result["artifacts"]:
                path = work / artifact["file"]
                if (
                    path.parent != work
                    or path.suffix not in {".wav", ".mid", ".json"}
                    or path.is_symlink()
                    or not path.is_file()
                    or path.stat().st_size > 32 * 1024 * 1024
                    or sha(path) != artifact["sha256"]
                ):
                    raise ValueError("Invalid research artifact")
            receipt = dict(
                contract="centaur.research/v1",
                job_id=request.job_id,
                tool=request.model,
                status="done",
                source_sound_id=parent,
                source_key=request.source.get("key"),
                source_sha256=digest,
                profile=control.profile,
                license=config["license"],
                model_revision=config["revision"],
                worker_sha256=config["files"][str(worker)],
                evaluation_sha256=config["evaluation_sha256"],
                independent_corroboration=False,
                **result,
            )
            check()
            try:
                shutil.copytree(work, target)
            except Exception:
                shutil.rmtree(target, ignore_errors=True)
                raise
        audio = metadata = None
        try:
            audio_files = []
            metadata_files = [self.storage.relative_path(target / "manifest.json")]
            if request.model == "rave-guitar":
                audio, metadata = self.storage.reserve_paths(
                    request=request, mode="audio-to-audio", job_id=request.job_id, count=1
                )[0]
                shutil.copy2(target / "transform.wav", audio)
                self.storage.write_metadata(
                    metadata_path=metadata,
                    request=request,
                    mode="audio-to-audio",
                    provider=self.provider_id,
                    model=request.model,
                    seed=req["seed"],
                    output_audio_path=audio,
                    sample_rate=48000,
                    status="done",
                    extra={"research": receipt},
                )
                audio_files = [self.storage.relative_path(audio)]
                metadata_files.append(self.storage.relative_path(metadata))
            value = GenerationResult(
                job_id=request.job_id,
                status="done",
                provider=self.provider_id,
                model=request.model,
                mode="audio-to-audio",
                audio_files=audio_files,
                metadata_files=metadata_files,
                duration=request.duration,
            )
            check()
            staging = target / "manifest.pending"
            staging.write_text(json.dumps(receipt, allow_nan=False))
            staging.replace(target / "manifest.json")
            self.storage.record_result(value)
            return value
        except Exception:
            for path in (audio, metadata):
                if path is not None:
                    path.unlink(missing_ok=True)
            shutil.rmtree(target, ignore_errors=True)
            raise
