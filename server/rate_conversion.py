"""Bounded FFT rate conversion for finite digital excerpts, with explicit losses."""

import numpy as np


def filtered_convert(samples, input_rate, output_rate):
    values = np.asarray(samples, dtype=np.float64)
    if values.ndim != 1 or not 1 <= len(values) <= 5760000 or not np.isfinite(values).all():
        raise ValueError("Rate conversion requires a bounded finite mono excerpt")
    if input_rate <= 0 or output_rate <= 0 or input_rate > 192000 or output_rate > 192000:
        raise ValueError("Rate conversion clock outside bounds")
    count = int(len(values) * output_rate / input_rate)
    if not 1 <= count <= 5760000:
        raise ValueError("Converted frame count outside bounds")
    # Periodic FFT boundary is softened explicitly, not passed off as preserved source samples.
    ramp = min(len(values) // 2, max(1, int(input_rate * 0.01)))
    values = values.copy()
    edge = 0.5 - 0.5 * np.cos(np.linspace(0, np.pi, ramp))
    values[:ramp] *= edge
    values[-ramp:] *= edge[::-1]
    spectrum = np.fft.rfft(values)
    frequencies = np.fft.rfftfreq(len(values), 1 / input_rate)
    limit = min(input_rate, output_rate) / 2
    response = np.clip((limit - frequencies) / (0.1 * limit), 0, 1)
    spectrum *= 0.5 - 0.5 * np.cos(np.pi * response)
    if count % 2 == 0 and count // 2 < len(spectrum):
        spectrum[count // 2] = 0
    result = np.fft.irfft(spectrum[: count // 2 + 1], n=count) * count / len(values)
    peak = float(np.max(abs(result)))
    normalization = max(1, peak)
    result /= normalization
    return result, dict(
        contract="germ/filtered-rate-conversion/v1",
        input_rate_hz=input_rate,
        output_rate_hz=output_rate,
        input_frames=len(values),
        output_frames=count,
        method="finite FFT low-pass resampling",
        transition_band_hz=[0.9 * limit, limit],
        boundary="10 ms raised-cosine edges, shortened for short excerpts",
        peak_normalization=normalization,
        numpy_version=np.__version__,
        losses="Frequencies at/above output Nyquist removed; transitions and edge samples changed. No physical or perceptual preservation claim.",
    )
