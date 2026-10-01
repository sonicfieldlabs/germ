"""ACE-Step behind GERM's existing bounded queue, cancellation and lineage writer."""

import json
import os
from pathlib import Path
import subprocess
import tempfile
import time
from akousma.resource_admission import admitted
from server.providers.base import AudioGenerationProvider, admission_checkpoint
from server.schemas import GenerationResult
from server.ace.deployment import deployment, music_parameters, sha


class ACEStepProvider(AudioGenerationProvider):
    provider_id = "ace_step"

    def is_available(self):
        try:
            deployment()
            self.last_error = None
            return True
        except (ValueError, OSError, KeyError) as exc:
            self.last_error = str(exc)
            return False

    def list_models(self):
        return ["acestep-v15-turbo"] if self.is_available() else []

    def load_model(self, model_id, device="auto"):
        if model_id != "acestep-v15-turbo":
            raise ValueError("Unknown ACE-Step checkpoint")
        deployment(verify=True)
        self.loaded_model_id = model_id
        self.current_device = "mlx/mps"
        return dict(
            provider=self.provider_id,
            model=model_id,
            device=self.current_device,
            status="loaded",
            detail="Prepared isolated Turbo worker; weights load per job",
        )

    def generate(self, request):
        return self._run(request, "text-to-audio")

    def audio_to_audio(self, request):
        return self._run(request, "audio-to-audio")

    def inpaint(self, request):
        return self._run(request, "inpainting")

    def continue_audio(self, request):
        raise ValueError("Turbo continuation is not admitted; select Stable Audio")

    @admitted("germ", checkpoint=admission_checkpoint)
    def _run(self, request, mode):
        config = deployment(verify=True)
        if (
            request.model != "acestep-v15-turbo"
            or request.batch_size != 1
            or not 10 <= request.duration <= 30
        ):
            raise ValueError(
                "Admitted ACE-Step requests require Turbo, one output and 10–30 seconds"
            )
        if request.steps != 8 or request.cfg_scale != 1 or request.negative_prompt or request.lora:
            raise ValueError("Admitted Turbo uses 8 steps, no CFG, negative prompt or LoRA")
        if mode == "inpainting" and len(request.inpaint_ranges) != 1:
            raise ValueError("Admitted Turbo inpainting requires one interval")
        music_parameters(request.source.get("music", {}))
        if len(request.prompt) > 512:
            raise ValueError("ACE-Step caption exceeds 512 characters")
        if not request.job_id:
            raise ValueError("Submit through the GERM job service")
        fields = request.model_dump()
        seed = request.seed if request.seed >= 0 else self.storage.random_seed()
        fields["seed"] = seed
        source_path = None
        source_hash = None
        if mode != "text-to-audio":
            import soundfile as sf

            source_path = self.storage.resolve_existing_input_audio_path(request.input_audio_path)
            info = sf.info(source_path)
            if (
                source_path.stat().st_size > 32 * 1024 * 1024
                or not 0 < info.duration <= 30
                or info.channels not in (1, 2)
            ):
                raise ValueError("ACE-Step source exceeds admitted audio bounds")
            source_hash = sha(source_path)
            if request.source.get("sha256") not in (None, source_hash):
                raise ValueError("Source changed before generation")
            if mode == "inpainting" and (
                abs(info.duration - request.duration) > 1 / info.samplerate
                or any(not 0 <= a < b <= info.duration for a, b in request.inpaint_ranges)
            ):
                raise ValueError("Inpaint interval or duration exceeds source")
            fields["input_audio_path"] = str(source_path)
        worker = Path(__file__).parents[1] / "ace/worker.py"
        if str(worker) not in config["files"]:
            raise ValueError("Worker missing from admission")
        audio, metadata = self.storage.reserve_paths(
            request=request, mode=mode, job_id=request.job_id, count=1
        )[0]

        def check():
            if self.is_job_cancelled(request.job_id):
                raise RuntimeError("ACE-Step job cancelled")

        try:
            with tempfile.TemporaryDirectory(prefix="germ-ace-") as directory:
                root = Path(directory)
                req = root / "request.json"
                receipt = root / "receipt.json"
                output = root / "output.wav"
                req.write_text(
                    json.dumps(
                        dict(
                            checkpoints=config["checkpoints"],
                            output=str(output),
                            mode=mode,
                            request=fields,
                        )
                    )
                )
                with (root / "worker.log").open("w") as log:
                    process = subprocess.Popen(
                        [config["python"], str(worker), str(req), str(receipt)],
                        env={
                            **{
                                k: os.environ[k]
                                for k in ("PATH", "HOME", "TMPDIR")
                                if k in os.environ
                            },
                            "HF_HUB_OFFLINE": "1",
                            "PYTHONDONTWRITEBYTECODE": "1",
                        },
                        stdout=log,
                        stderr=log,
                        start_new_session=True,
                    )
                    try:
                        deadline = time.monotonic() + 300
                        while process.poll() is None:
                            check()
                            if time.monotonic() > deadline:
                                raise TimeoutError("ACE-Step exceeded its 300-second deadline")
                            time.sleep(0.1)
                        check()
                        if process.returncode:
                            detail = (root / "worker.log").read_text(errors="replace")[-4000:]
                            raise ValueError(
                                "Conditioning exceeds the encoder token limit; shorten the context"
                                if "Conditioning exceeds the encoder token limit" in detail
                                else "ACE-Step generation failed; no output admitted"
                            )
                        value = json.loads(receipt.read_text())
                        import soundfile as sf
                        import numpy as np

                        samples, rate = sf.read(output, always_2d=True)
                        if (
                            not np.isfinite(samples).all()
                            or samples.shape[1] != 2
                            or abs(len(samples) / rate - request.duration) > 0.001
                            or np.max(np.abs(samples)) > 1
                        ):
                            raise ValueError("Invalid ACE-Step audio output")
                        output.replace(audio)
                    finally:
                        if process.poll() is None:
                            process.terminate()
                            try:
                                process.wait(timeout=3)
                            except subprocess.TimeoutExpired:
                                process.kill()
                                process.wait()
                if source_path and sha(source_path) != source_hash:
                    raise ValueError("Source changed during generation")
                self.storage.write_metadata(
                    metadata_path=metadata,
                    request=request,
                    mode=mode,
                    provider=self.provider_id,
                    model=request.model,
                    seed=seed,
                    output_audio_path=audio,
                    sample_rate=rate,
                    status="done",
                    extra={
                        "ace_step": {
                            **value,
                            "revision": config["revision"],
                            "runtime_commit": config["runtime_commit"],
                            "evaluation_sha256": config["evaluation_sha256"],
                            "worker_sha256": config["files"][str(worker)],
                            "input_sha256": source_hash,
                            "semantics": "Generated music; not new evidence about the source environment",
                        }
                    },
                )
        except Exception:
            if not metadata.exists():
                audio.unlink(missing_ok=True)
            raise
        result = GenerationResult(
            job_id=request.job_id,
            status="done",
            provider=self.provider_id,
            model=request.model,
            mode=mode,
            seed=seed,
            duration=request.duration,
            sample_rate=rate,
            audio_files=[self.storage.relative_path(audio)],
            metadata_files=[self.storage.relative_path(metadata)],
        )
        self.storage.record_result(result)
        return result
