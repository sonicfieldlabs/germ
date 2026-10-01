"""Offline research inference in an isolated dependency environment."""

import json
import sys
import time
import hashlib
from pathlib import Path
import numpy as np
import soundfile as sf


def main(request_path):
    request = json.loads(Path(request_path).read_text())
    out = Path(request["output"])
    out.mkdir(exist_ok=True)
    begun = time.monotonic()
    source = request["input"]
    info = sf.info(source)
    start = round(request["start_seconds"] * info.samplerate)
    count = round(request["seconds"] * info.samplerate)
    samples, rate = sf.read(source, start=start, frames=count, always_2d=True, dtype="float32")
    if len(samples) != count or not np.isfinite(samples).all():
        raise ValueError("Incomplete or nonfinite input")
    mono = samples.mean(axis=1)
    import librosa

    target = 48000 if request["tool"] == "rave-guitar" else 22050
    view = librosa.resample(mono, orig_sr=rate, target_sr=target)
    artifacts = []
    details = {}
    if request["tool"] == "rave-guitar":
        import torch

        torch.set_num_threads(2)
        torch.manual_seed(request["seed"])
        model = torch.jit.load(request["model_path"], map_location="cpu").eval()
        block = 2048
        frames = []
        with torch.inference_mode():
            # Exported causal models own convolution state; each job gets a fresh instance.
            for offset in range(0, len(view), block):
                chunk = np.pad(
                    view[offset : offset + block],
                    (0, max(0, block - len(view[offset : offset + block]))),
                )
                z = model.encode(torch.from_numpy(chunk).reshape(1, 1, -1))
                z = z * request["latent_scale"] + request["latent_bias"]
                frames.append(model.decode(z).reshape(-1).numpy())
        rendered = np.concatenate(frames)[: len(view)]
        if len(rendered) != len(view) or not np.isfinite(rendered).all():
            raise ValueError("Invalid RAVE output")
        peak = float(np.max(np.abs(rendered)))
        gain = min(1.0, 0.98 / max(peak, 1e-9))
        rendered *= gain
        sf.write(out / "transform.wav", rendered, target, subtype="PCM_24")
        artifacts = [dict(file="transform.wav", kind="neural_transform", media_type="audio/wav")]
        details = dict(
            raw_peak=peak,
            output_gain=gain,
            latent_scale=request["latent_scale"],
            latent_bias=request["latent_bias"],
            block_size=block,
            limitation="Domain-conditioned timbre transformation, not source separation or faithful reconstruction; causal startup is retained.",
        )
    else:
        from basic_pitch.inference import predict

        sf.write(out / "analysis-view.wav", view, target, subtype="FLOAT")
        _, midi, notes = predict(
            out / "analysis-view.wav", model_or_model_path=request["model_path"]
        )
        if len(notes) > 10000:
            raise ValueError("Symbolic output exceeds note bound")
        rows = [
            dict(
                start_seconds=float(n[0]),
                end_seconds=float(n[1]),
                midi_pitch=int(n[2]),
                amplitude=float(n[3]),
                pitch_bends=[int(b) for b in n[4]] if len(n) > 4 and n[4] is not None else [],
            )
            for n in notes
        ]
        (out / "notes.json").write_text(
            json.dumps(
                dict(kind="pitch_hypotheses", time_origin="selected_interval", notes=rows),
                allow_nan=False,
            )
        )
        midi.write(str(out / "notes.mid"))
        (out / "analysis-view.wav").unlink()
        artifacts = [
            dict(file="notes.json", kind="pitch_hypotheses", media_type="application/json"),
            dict(file="notes.mid", kind="symbolic_transcription", media_type="audio/midi"),
        ]
        details = dict(
            note_count=len(rows),
            limitation="Note hypotheses, best for isolated pitched material; not a verified score or full-mixture transcription.",
        )
    for item in artifacts:
        p = out / item["file"]
        item.update(sha256=hashlib.sha256(p.read_bytes()).hexdigest(), bytes=p.stat().st_size)
    result = dict(
        artifacts=artifacts,
        details=details,
        seconds=time.monotonic() - begun,
        analysis_view=dict(
            original_sample_rate=rate,
            original_channels=info.channels,
            sample_rate=target,
            channels=1,
            downmix="arithmetic_mean",
            start_seconds=request["start_seconds"],
            seconds=request["seconds"],
        ),
    )
    (out / "result.json").write_text(json.dumps(result, allow_nan=False))


if __name__ == "__main__":
    main(sys.argv[1])
