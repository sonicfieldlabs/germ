"""Bounded CPU synthesis through the existing generation and lifecycle services."""

from __future__ import annotations

import array
import hashlib
import io
import math
import random
import sys
import subprocess
import tempfile
import threading
import time
import wave
from pathlib import Path

from server.providers.base import AudioGenerationProvider
from server.schemas import GenerationResult
from server.storage import utc_now_iso


class SynthesisProvider(AudioGenerationProvider):
    provider_id = "synthesis"
    sample_rate = 44100

    def is_available(self):
        return True

    def list_models(self):
        return [
            "audification",
            "additive",
            "chirp",
            "band-noise",
            "fm",
            "pulse",
            "physical-string",
            "sample",
            "wavetable",
            "granular",
        ]

    def load_model(self, model_id, device="auto"):
        if model_id not in self.list_models():
            raise ValueError("Unknown synthesis adapter")
        self.loaded_model_id, self.current_device = model_id, "cpu"
        return dict(provider=self.provider_id, model=model_id, device="cpu", status="loaded")

    def audio_to_audio(self, request):
        raise ValueError("Use an explicit synthesis source; audio-to-audio is unsupported")

    inpaint = audio_to_audio
    continue_audio = audio_to_audio

    def generate(self, request):
        from server.wavetable import load_wavetable, _sample_frame

        self.load_model(request.model)
        if not 0.1 <= request.duration <= 30 or request.batch_size != 1:
            raise ValueError("Synthesis requires one output of 0.1–30 seconds")
        from server.spectral_synthesis import MODELS

        if request.model in MODELS or request.model == "audification":
            return self._generate_spectral(request)
        p = request.source.get("synthesis", {})
        allowed = {
            "frequency",
            "gain",
            "partials",
            "decay",
            "input_audio_path",
            "source_sha256",
            "wavetable_id",
            "table_sha256",
            "position",
            "parameters",
        }
        specific = {
            "granular": {"input_audio_path", "source_sha256", "parameters"},
            "additive": {"partials", "frequency", "gain"},
            "physical-string": {"decay", "frequency", "gain"},
            "sample": {"input_audio_path", "source_sha256", "gain"},
            "wavetable": {"wavetable_id", "table_sha256", "position", "frequency", "gain"},
        }
        if not isinstance(p, dict) or set(p) - allowed or set(p) - specific[request.model]:
            raise ValueError("Unsupported synthesis parameter")

        def number(key, default, low, high):
            value = p.get(key, default)
            if (
                type(value) not in (int, float)
                or not math.isfinite(value)
                or not low <= value <= high
            ):
                raise ValueError("Synthesis parameter outside bounds: " + key)
            return value

        frequency = number("frequency", 220, 40, 4000)
        gain = number("gain", 0.2, 0, 1)
        decay = number("decay", 0.98, 0.8, 0.999)
        position = number("position", 0, 0, 1)
        partials = p.get("partials", [1])
        if (
            not isinstance(partials, list)
            or not 1 <= len(partials) <= 32
            or any(
                type(v) not in (float, int) or not math.isfinite(v) or not 0 <= v <= 1
                for v in partials
            )
        ):
            raise ValueError("Supply 1–32 finite partial amplitudes in [0,1]")
        if request.model == "additive" and len(partials) * frequency >= self.sample_rate / 2:
            raise ValueError("Requested partial exceeds the sampled Nyquist limit")
        source_path = None
        source_hash = None
        samples = None
        table = None
        resampling = None
        if request.model in {"sample", "granular"}:
            source_path = self.storage.resolve_existing_input_audio_path(
                p.get("input_audio_path", "")
            )
            if source_path.stat().st_size > 12 * 1024 * 1024:
                raise ValueError("Sample exceeds 12 MiB")
            source_bytes = source_path.read_bytes()
            source_hash = hashlib.sha256(source_bytes).hexdigest()
            if p.get("source_sha256") != source_hash:
                raise ValueError("Sample hash mismatch")
            with wave.open(io.BytesIO(source_bytes), "rb") as wav:
                if (
                    wav.getsampwidth() != 2
                    or wav.getnchannels() not in (1, 2)
                    or not 8000 <= wav.getframerate() <= 192000
                    or not 0 < wav.getnframes() <= wav.getframerate() * 30
                ):
                    raise ValueError("Sample must be bounded mono/stereo PCM16 WAV")
                source_rate, channels = wav.getframerate(), wav.getnchannels()
                samples = array.array("h", wav.readframes(wav.getnframes()))
                if sys.byteorder != "little":
                    samples.byteswap()
                if len(samples) != wav.getnframes() * channels:
                    raise ValueError("Truncated source PCM")
        if request.model == "sample" and source_rate != self.sample_rate:
            import numpy as np
            from server.rate_conversion import filtered_convert

            mono = np.asarray(samples, dtype=np.float64).reshape(-1, channels).mean(axis=1) / 32768
            converted, resampling = filtered_convert(mono, source_rate, self.sample_rate)
            samples = array.array("h", np.rint(converted * 32767).astype(np.int16))
            source_rate, channels = self.sample_rate, 1
        if request.model == "wavetable":
            from server.processing_adapter import digest

            table = load_wavetable(p.get("wavetable_id", ""))
            source_hash = digest({"metadata": table["metadata"], "frames": table["frames"]})
            if source_hash != p.get("table_sha256"):
                raise ValueError("Wavetable hash mismatch")
            if len(table["frames"]) > 1_000_000 or any(
                not math.isfinite(v) for v in table["frames"]
            ):
                raise ValueError("Invalid or oversized wavetable")
        job_id = request.job_id
        if not job_id:
            raise ValueError("Submit synthesis through the existing job service")
        seed = request.seed if request.seed >= 0 else self.storage.random_seed()
        rng = random.Random(seed)
        delay = [rng.uniform(-1, 1) for _ in range(round(self.sample_rate / frequency))]
        total = int(request.duration * self.sample_rate)
        pcm = array.array("h")
        deadline = time.monotonic() + 30
        if request.model == "granular":
            from server.processing_adapter import ENGINE, engine_parameters, render

            granular_host_hash = hashlib.sha256(ENGINE.read_bytes()).hexdigest()
            node_runtime = subprocess.check_output(
                ["node", "--version"], text=True, timeout=2
            ).strip()
            from server.masa_bridge import build_processing_request

            intent = build_processing_request(
                module_id="grain_culture",
                source_id="local-sample",
                created_at=utc_now_iso(),
                seed=seed,
                parameters=p.get("parameters", {}),
            )
            params, seed = engine_parameters(intent)
            if len(samples) / channels / source_rate < params["sizeMs"] / 1000 + 0.05:
                raise ValueError("Source too short for granulator history")
            if abs(request.duration - len(samples) / channels / source_rate) > 1 / source_rate:
                raise ValueError("Granular output duration must equal source duration")
            with tempfile.TemporaryDirectory(prefix="germ-synthesis-") as temp_name:
                temp = Path(temp_name)
                raw = array.array("h", samples)
                if sys.byteorder != "little":
                    raw.byteswap()
                (temp / "input.pcm").write_bytes(raw.tobytes())
                with self._cancel_lock:
                    cancel = self._cancel_events.get(job_id, threading.Event())
                render(
                    dict(
                        input=str(temp / "input.pcm"),
                        output=str(temp / "output.wav"),
                        sampleRate=source_rate,
                        channels=channels,
                        params=params,
                        seed=seed,
                    ),
                    temp,
                    cancel,
                    30,
                )
                rendered = (temp / "output.wav").read_bytes()
        for i in range(0 if request.model == "granular" else total):
            if i % 1024 == 0:
                if self.is_job_cancelled(job_id):
                    result = GenerationResult(
                        job_id=job_id,
                        status="cancelled",
                        provider=self.provider_id,
                        model=request.model,
                        mode="text-to-audio",
                        seed=seed,
                        duration=request.duration,
                        sample_rate=self.sample_rate,
                    )
                    self.storage.record_result(result)
                    return result
                if time.monotonic() > deadline:
                    raise TimeoutError("Synthesis exceeded 30 seconds")
            if request.model == "additive":
                value = sum(
                    a * math.sin(2 * math.pi * (h + 1) * frequency * i / self.sample_rate)
                    for h, a in enumerate(partials)
                ) / max(1, sum(partials))
            elif request.model == "physical-string":
                slot = i % len(delay)
                value = delay[slot]
                delay[slot] = decay * (value + delay[(slot + 1) % len(delay)]) / 2
            elif request.model == "sample":
                # Linear rate conversion, no looping: silence after the source ends.
                pos = i * source_rate / self.sample_rate
                lo = int(pos)
                count = len(samples) // channels
                value = (
                    0
                    if lo >= count
                    else sum(
                        (
                            samples[lo * channels + c] * (1 - (pos - lo))
                            + samples[min(lo + 1, count - 1) * channels + c] * (pos - lo)
                        )
                        for c in range(channels)
                    )
                    / (channels * 32768)
                )
            else:
                meta = table["metadata"]
                frame = position * (meta["frame_count"] - 1)
                lo = int(frame)
                hi = min(lo + 1, meta["frame_count"] - 1)
                phase = (i * frequency / self.sample_rate) % 1
                value = _sample_frame(table["frames"], lo, phase, meta["frame_size"]) * (
                    1 - (frame - lo)
                ) + _sample_frame(table["frames"], hi, phase, meta["frame_size"]) * (frame - lo)
            envelope = min(1, i / 265, (total - 1 - i) / 1985)
            pcm.append(round(max(-1, min(1, value * gain * envelope)) * 32767))
        if source_path and hashlib.sha256(source_path.read_bytes()).hexdigest() != source_hash:
            raise ValueError("Sample changed during synthesis")
        if (
            table
            and digest(
                {
                    k: v
                    for k, v in load_wavetable(p["wavetable_id"]).items()
                    if k in {"metadata", "frames"}
                }
            )
            != source_hash
        ):
            raise ValueError("Wavetable changed during synthesis")
        audio, metadata = self.storage.reserve_paths(
            request=request, mode="text-to-audio", job_id=job_id, count=1
        )[0]
        try:
            if sys.byteorder != "little":
                pcm.byteswap()
            if request.model == "granular":
                audio.write_bytes(rendered)
            else:
                with wave.open(str(audio), "wb") as wav:
                    wav.setparams((1, 2, self.sample_rate, 0, "NONE", "not compressed"))
                    wav.writeframes(pcm.tobytes())
            self.storage.write_metadata(
                metadata_path=metadata,
                request=request,
                mode="text-to-audio",
                provider=self.provider_id,
                model=request.model,
                seed=seed,
                output_audio_path=audio,
                sample_rate=source_rate if request.model == "granular" else self.sample_rate,
                status="done",
                extra={
                    "synthesis": {
                        "parameters": p,
                        "source_sha256": source_hash,
                        "resampling": resampling,
                        "engine_sha256": hashlib.sha256(Path(__file__).read_bytes()).hexdigest(),
                        "runtime": sys.version,
                        "node_runtime": node_runtime if request.model == "granular" else None,
                        "granular_host_sha256": granular_host_hash
                        if request.model == "granular"
                        else None,
                        "seed": seed,
                        "effective_parameters": params
                        if request.model == "granular"
                        else {
                            "frequency": frequency,
                            "gain": gain,
                            "partials": partials,
                            "decay": decay,
                            "position": position,
                        },
                        "granular_dsp_sha256": hashlib.sha256(
                            (
                                Path(__file__).parents[2] / "dashboard/static/audio_engine.js"
                            ).read_bytes()
                        ).hexdigest()
                        if request.model == "granular"
                        else None,
                        "semantics": "Digital synthesis; no physical capture or new listening",
                        "wavetable_interpolator_sha256": hashlib.sha256(
                            Path(sys.modules["server.wavetable"].__file__).read_bytes()
                        ).hexdigest(),
                    }
                },
            )
        except Exception:
            if not metadata.exists():
                audio.unlink(missing_ok=True)
            raise
        result = GenerationResult(
            job_id=job_id,
            status="done",
            provider=self.provider_id,
            model=request.model,
            mode="text-to-audio",
            seed=seed,
            duration=request.duration,
            sample_rate=source_rate if request.model == "granular" else self.sample_rate,
            audio_files=[self.storage.relative_path(audio)],
            metadata_files=[self.storage.relative_path(metadata)],
        )

        self.storage.record_result(result)
        return result

    def _generate_spectral(self, request):
        from server.spectral_synthesis import render

        if not request.job_id:
            raise ValueError("Submit synthesis through the existing job service")
        seed = request.seed if request.seed >= 0 else self.storage.random_seed()
        if request.source.get("simulated") and (
            request.source["simulated"] != {"contract": "germ/simulated-source/v1"}
            or request.model not in {"additive", "chirp", "band-noise"}
            or set(request.source) != {"simulated", "synthesis"}
        ):
            raise ValueError("Designed sources require an independent oscillator recipe")
        parameters = dict(request.source.get("synthesis", {}))
        brief = audification = None
        if request.source.get("spectral_frame"):
            from server.spectral_brief import extract

            if request.model != "additive":
                raise ValueError("Spectral frames require the additive oscillator")
            components, brief = extract(request.source["spectral_frame"])
            parameters.update(components)
        try:
            if request.model == "audification":
                from server import audify

                if set(parameters) - {"sample_rate", "gain"}:
                    raise ValueError("Audification accepts only output rate and gain")
                pcm, spectral, audification = audify.render(
                    request.source.get("audification"),
                    parameters.get("sample_rate", 44100),
                    request.duration,
                    parameters.get("gain", 0.2),
                    lambda: self.is_job_cancelled(request.job_id),
                )
            else:
                pcm, spectral = render(
                    request.model,
                    parameters,
                    request.duration,
                    seed,
                    lambda: self.is_job_cancelled(request.job_id),
                )
        except InterruptedError:
            result = GenerationResult(
                job_id=request.job_id,
                status="cancelled",
                provider=self.provider_id,
                model=request.model,
                mode="text-to-audio",
                seed=seed,
                duration=request.duration,
                sample_rate=parameters.get("sample_rate", 44100),
            )
            self.storage.record_result(result)
            return result
        if brief and extract(request.source["spectral_frame"])[1] != brief:
            raise ValueError("Spectral source retention or lineage changed during synthesis")
        if audification:
            current, source, _ = audify.resolve(request.source["audification"])
            if (
                audify.digest(current) != audification["source_series_sha256"]
                or audify.digest(source) != audification["source_record_sha256"]
            ):
                raise ValueError("Observation source changed during synthesis")
        if self.is_job_cancelled(request.job_id):
            raise RuntimeError("Synthesis cancelled before publication")
        rate = spectral["sample_rate_hz"]
        audio, metadata = self.storage.reserve_paths(
            request=request, mode="text-to-audio", job_id=request.job_id, count=1
        )[0]
        try:
            with wave.open(str(audio), "wb") as wav:
                wav.setparams((1, 2, rate, 0, "NONE", "not compressed"))
                wav.writeframes(pcm.astype("<i2").tobytes())
            synthesis = dict(
                parameters=parameters,
                effective_parameters=spectral["effective_parameters"],
                spectral=spectral,
                seed=seed,
                runtime=sys.version,
                engine_sha256=hashlib.sha256(
                    (Path(__file__).parents[1] / "spectral_synthesis.py").read_bytes()
                ).hexdigest(),
                semantics="Digital synthesis; no physical capture or new listening",
            )
            if request.source.get("simulated"):
                if request.source["simulated"] != {"contract": "germ/simulated-source/v1"}:
                    raise ValueError("Invalid simulated source contract")
                synthesis["simulated"] = dict(
                    contract="germ/simulated-source/v1",
                    source_type="designed",
                    source_sha256=hashlib.sha256(audio.read_bytes()).hexdigest(),
                    seed=seed,
                    model=request.model,
                    duration=request.duration,
                    parameters=spectral["effective_parameters"],
                    clock="Digital sample index; clock_ppm perturbs oscillator time only",
                    gaps="Sample intervals replaced with zero; not missing observations",
                )
            if brief:
                synthesis["spectral_frame"] = brief
            if audification:
                synthesis["audification"] = audification
            self.storage.write_metadata(
                metadata_path=metadata,
                request=request,
                mode="text-to-audio",
                provider=self.provider_id,
                model=request.model,
                seed=seed,
                output_audio_path=audio,
                sample_rate=rate,
                status="done",
                extra={"synthesis": synthesis},
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
            mode="text-to-audio",
            seed=seed,
            duration=request.duration,
            sample_rate=rate,
            audio_files=[self.storage.relative_path(audio)],
            metadata_files=[self.storage.relative_path(metadata)],
        )
        self.storage.record_result(result)
        return result
