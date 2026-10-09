"""Offline single-job ACE-Step Turbo inference; called only by the GERM owner."""

import json
import os
from pathlib import Path
import resource
import shutil
import sys
import time


def main():
    request = json.loads(Path(sys.argv[1]).read_text())
    os.environ["HF_HUB_OFFLINE"] = "1"
    os.environ["TRANSFORMERS_OFFLINE"] = "1"
    os.environ["ACESTEP_CHECKPOINTS_DIR"] = request["checkpoints"]
    from acestep.handler import AceStepHandler
    from acestep.inference import GenerationParams, GenerationConfig, generate_music
    from acestep.llm_inference import LLMHandler

    started = time.monotonic()
    handler = AceStepHandler()

    def local_only(**kwargs):
        for component in ("acestep-v15-turbo", "vae", "Qwen3-Embedding-0.6B"):
            if not (Path(request["checkpoints"]) / component).is_dir():
                return "Required local component missing", False
        return None

    handler._ensure_models_present = local_only
    # Provisioning reconciles pinned upstream model code before hashing admission.
    handler._sync_model_code_if_needed = lambda *args: None
    message, ok = handler.initialize_service(
        project_root=str(Path(request["checkpoints"]).parent),
        config_path="acestep-v15-turbo",
        device="mps",
        use_mlx_dit=True,
        offload_to_cpu=True,
        offload_dit_to_cpu=False,
    )
    if not ok:
        raise RuntimeError(message)

    class BoundedTokenizer:
        def __init__(self, inner):
            self.inner = inner

        def __getattr__(self, name):
            return getattr(self.inner, name)

        def __call__(self, text, *args, **kwargs):
            limit = kwargs.get("max_length")
            if kwargs.get("truncation") and limit:
                raw = self.inner(
                    text,
                    add_special_tokens=kwargs.get("add_special_tokens", True),
                    truncation=False,
                )
                ids = raw["input_ids"]
                count = max(map(len, ids)) if ids and isinstance(ids[0], list) else len(ids)
                if count > limit:
                    raise ValueError(
                        "Conditioning exceeds the encoder token limit; shorten the context"
                    )
            return self.inner(text, *args, **kwargs)

    handler.text_tokenizer = BoundedTokenizer(handler.text_tokenizer)
    fields = request["request"]
    music = fields.get("source", {}).get("music", {})
    mode = request["mode"]
    task = {"text-to-audio": "text2music", "audio-to-audio": "cover", "inpainting": "repaint"}[mode]
    params = GenerationParams(
        task_type=task,
        caption=fields["prompt"],
        lyrics=music.get("lyrics") or "[Instrumental]",
        instrumental=not bool(music.get("lyrics")),
        duration=fields["duration"],
        inference_steps=8,
        seed=fields["seed"],
        thinking=False,
        use_cot_metas=False,
        use_cot_caption=False,
        use_cot_language=False,
        bpm=music.get("bpm"),
        keyscale=music.get("key", ""),
        timesignature=music.get("meter", ""),
        vocal_language=music.get("language", "unknown"),
        src_audio=fields.get("input_audio_path"),
        audio_cover_strength=1 - fields.get("init_noise_level", 0.45),
        shift=3.0,
    )
    if mode == "inpainting":
        params.repainting_start, params.repainting_end = fields["inpaint_ranges"][0]
    result = generate_music(
        handler,
        LLMHandler(),
        params,
        GenerationConfig(
            batch_size=1, use_random_seed=False, seeds=[fields["seed"]], audio_format="wav"
        ),
        save_dir=str(Path(request["output"]).parent / "raw"),
    )
    if not result.success or len(result.audios) != 1:
        raise RuntimeError(result.error or "ACE-Step produced no single result")
    shutil.copyfile(result.audios[0]["path"], request["output"])
    import soundfile as sf
    import numpy as np

    samples, rate = sf.read(request["output"], always_2d=True)
    if not np.isfinite(samples).all():
        raise ValueError("Non-finite generation output")
    expected = round(fields["duration"] * rate)
    if abs(len(samples) - expected) > rate * 0.1:
        raise ValueError("Generation duration outside admitted tolerance")
    samples = samples[:expected]
    if len(samples) < expected:
        samples = np.pad(samples, ((0, expected - len(samples)), (0, 0)))
    sf.write(request["output"], samples, rate, subtype="PCM_16")
    receipt = dict(
        seconds=time.monotonic() - started,
        sample_rate=rate,
        channels=samples.shape[1],
        duration=len(samples) / rate,
        peak=float(np.max(np.abs(samples))),
        rms=float(np.sqrt(np.mean(samples**2))),
        peak_process_mib=resource.getrusage(resource.RUSAGE_SELF).ru_maxrss / 1024**2,
        task=task,
        planner=False,
        seed=fields["seed"],
    )
    import mlx.core as mx
    import torch

    receipt.update(
        metal_peak_mib=mx.get_peak_memory() / 1024**2,
        mps_driver_mib=torch.mps.driver_allocated_memory() / 1024**2,
    )
    Path(sys.argv[2]).write_text(json.dumps(receipt))


if __name__ == "__main__":
    main()
