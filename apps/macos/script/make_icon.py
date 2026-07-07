#!/usr/bin/env python3
"""Generate AppIcon.icns for the germ macOS shell.

Stdlib only (struct + zlib + iconutil): draws the germ motif — a petri dish
with a small culture of germs in the dashboard palette — supersampled for
anti-aliasing, writes the .iconset PNGs, and packs them with iconutil.

Run from anywhere:  python3 apps/macos/script/make_icon.py
"""
from __future__ import annotations

import math
import struct
import subprocess
import sys
import tempfile
import zlib
from pathlib import Path

# Dashboard palette
PAPER = (251, 251, 249)
RIM = (68, 68, 68)
GREEN = (71, 111, 93)
GREEN_SOFT = (122, 165, 143)
GOLD = (215, 168, 23)

SS = 4  # supersample factor


def write_png(path: Path, size: int, pixels: bytearray) -> None:
    def chunk(tag: bytes, payload: bytes) -> bytes:
        return (
            struct.pack(">I", len(payload))
            + tag
            + payload
            + struct.pack(">I", zlib.crc32(tag + payload) & 0xFFFFFFFF)
        )

    raw = bytearray()
    stride = size * 4
    for y in range(size):
        raw.append(0)
        raw.extend(pixels[y * stride:(y + 1) * stride])
    header = struct.pack(">IIBBBBB", size, size, 8, 6, 0, 0, 0)
    path.write_bytes(
        b"\x89PNG\r\n\x1a\n"
        + chunk(b"IHDR", header)
        + chunk(b"IDAT", zlib.compress(bytes(raw), 9))
        + chunk(b"IEND", b"")
    )


def render(size: int) -> bytearray:
    n = size * SS
    buf = [[(0, 0, 0, 0)] * n for _ in range(n)]

    def blend(x: int, y: int, color: tuple[int, int, int], alpha: float) -> None:
        if alpha <= 0 or not (0 <= x < n and 0 <= y < n):
            return
        r0, g0, b0, a0 = buf[y][x]
        a = alpha + (a0 / 255) * (1 - alpha)
        if a <= 0:
            return
        r = (color[0] * alpha + r0 * (a0 / 255) * (1 - alpha)) / a
        g = (color[1] * alpha + g0 * (a0 / 255) * (1 - alpha)) / a
        b = (color[2] * alpha + b0 * (a0 / 255) * (1 - alpha)) / a
        buf[y][x] = (int(r), int(g), int(b), int(a * 255))

    def rounded_rect(cx0: float, cy0: float, cx1: float, cy1: float, radius: float, color: tuple[int, int, int]) -> None:
        for y in range(n):
            for x in range(n):
                px = min(max(x + 0.5, cx0 + radius), cx1 - radius)
                py = min(max(y + 0.5, cy0 + radius), cy1 - radius)
                d = math.hypot(x + 0.5 - px, y + 0.5 - py)
                alpha = min(1.0, max(0.0, radius - d + 0.5))
                blend(x, y, color, alpha)

    def circle(cx: float, cy: float, radius: float, color: tuple[int, int, int], *, width: float | None = None, opacity: float = 1.0) -> None:
        x0 = max(0, int(cx - radius - 2))
        x1 = min(n, int(cx + radius + 3))
        y0 = max(0, int(cy - radius - 2))
        y1 = min(n, int(cy + radius + 3))
        for y in range(y0, y1):
            for x in range(x0, x1):
                d = math.hypot(x + 0.5 - cx, y + 0.5 - cy)
                if width is None:
                    alpha = min(1.0, max(0.0, radius - d + 0.5))
                else:
                    alpha = min(1.0, max(0.0, width / 2 - abs(d - radius) + 0.5))
                blend(x, y, color, alpha * opacity)

    # Big Sur-style rounded square canvas with a soft inset.
    margin = n * 0.055
    rounded_rect(margin, margin, n - margin, n - margin, n * 0.205, PAPER)

    cx = n / 2
    cy = n / 2
    dish_r = n * 0.315
    # Dish body + rim
    circle(cx, cy, dish_r, GREEN_SOFT, opacity=0.16)
    circle(cx, cy, dish_r, RIM, width=n * 0.012, opacity=0.55)
    circle(cx, cy, dish_r * 0.985, GREEN, width=n * 0.004, opacity=0.25)

    # Germ culture: an organic cluster (fixed layout, no randomness).
    germs = [
        (-0.10, -0.08, 0.085, GREEN, 1.0),
        (0.09, 0.02, 0.065, GREEN, 0.92),
        (-0.02, 0.12, 0.052, GREEN, 0.85),
        (0.03, -0.14, 0.042, GREEN_SOFT, 0.95),
        (0.15, -0.09, 0.034, GREEN_SOFT, 0.9),
        (-0.16, 0.05, 0.030, GREEN_SOFT, 0.88),
        (0.12, 0.14, 0.026, GOLD, 0.95),
    ]
    for gx, gy, gr, color, opacity in germs:
        circle(cx + gx * n, cy + gy * n, gr * n, color, opacity=opacity)
        # nucleus
        circle(cx + gx * n - gr * n * 0.22, cy + gy * n - gr * n * 0.22, gr * n * 0.34, PAPER, opacity=0.5 * opacity)

    # Downsample SS×SS → size×size
    out = bytearray(size * size * 4)
    for y in range(size):
        for x in range(size):
            r = g = b = a = 0
            for sy in range(SS):
                for sx in range(SS):
                    pr, pg, pb, pa = buf[y * SS + sy][x * SS + sx]
                    r += pr * pa
                    g += pg * pa
                    b += pb * pa
                    a += pa
            count = SS * SS
            if a:
                out[(y * size + x) * 4 + 0] = r // a
                out[(y * size + x) * 4 + 1] = g // a
                out[(y * size + x) * 4 + 2] = b // a
            out[(y * size + x) * 4 + 3] = a // count
    return out


def main() -> int:
    resources = Path(__file__).resolve().parents[1] / "Resources"
    resources.mkdir(parents=True, exist_ok=True)
    target = resources / "AppIcon.icns"
    entries = [
        ("icon_16x16.png", 16),
        ("icon_16x16@2x.png", 32),
        ("icon_32x32.png", 32),
        ("icon_32x32@2x.png", 64),
        ("icon_128x128.png", 128),
        ("icon_128x128@2x.png", 256),
        ("icon_256x256.png", 256),
        ("icon_256x256@2x.png", 512),
        ("icon_512x512.png", 512),
        ("icon_512x512@2x.png", 1024),
    ]
    rendered: dict[int, bytearray] = {}
    with tempfile.TemporaryDirectory() as tmp:
        iconset = Path(tmp) / "AppIcon.iconset"
        iconset.mkdir()
        for name, size in entries:
            if size not in rendered:
                print(f"  rendering {size}×{size}")
                rendered[size] = render(size)
            write_png(iconset / name, size, rendered[size])
        subprocess.run(["iconutil", "-c", "icns", str(iconset), "-o", str(target)], check=True)
    print(f"wrote {target}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
