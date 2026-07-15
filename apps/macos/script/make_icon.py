#!/usr/bin/env python3
"""Generate the complete germ brand asset family with no Python packages.

The mark mirrors oída's outer listening arc exactly: one open circular membrane
with the same radius, sweep, stroke weight, and opacity, reflected so its gap
opens toward the lower right. Three larger organic cells occupy its center.

Outputs:
  apps/macos/Resources/AppIcon.icns
  docs/assets/germ-logo-{light,dark}.png (2048 px)
  dashboard/static/icons/germ-icon-{192,512}.png
  dashboard/static/icons/apple-touch-icon.png
"""
from __future__ import annotations

import math
import struct
import subprocess
import sys
import tempfile
import zlib
from pathlib import Path


LIGHT_BG = (246, 246, 244)
DARK_BG = (35, 35, 32)
LIGHT_INK = (29, 29, 27)
DARK_INK = (244, 243, 238)
TILE_TOP = (49, 48, 43)
TILE_BOTTOM = (35, 35, 32)
MARK_ARC_CENTER = (546.0, 540.0)
MARK_ARC_RADIUS = 374.0
MARK_ARC_WIDTH = 30.0
MARK_ARC_OPACITY_LIGHT = 0.45
MARK_ARC_OPACITY_DARK = 0.62
MARK_ARC_START_DEGREES = 125.0
MARK_ARC_SWEEP_DEGREES = 200.0
MARK_CELLS = (
    (546.0, 447.0, 80.0, 1.0),
    (426.0, 593.0, 51.0, 0.78),
    (670.0, 581.0, 44.0, 0.64),
)


def validate_mark_geometry() -> None:
    """Keep every organic cell visibly separated inside the membrane."""
    cx, cy = MARK_ARC_CENTER
    assert 180 < MARK_ARC_SWEEP_DEGREES < 240
    assert len({cell[2] for cell in MARK_CELLS}) == len(MARK_CELLS)

    inner_radius = MARK_ARC_RADIUS - MARK_ARC_WIDTH / 2
    for x, y, radius, _ in MARK_CELLS:
        assert math.hypot(x - cx, y - cy) + radius < inner_radius

    for index, first in enumerate(MARK_CELLS):
        for second in MARK_CELLS[index + 1 :]:
            separation = math.hypot(first[0] - second[0], first[1] - second[1])
            assert separation > first[2] + second[2]


def write_png(path: Path, size: int, pixels: bytearray) -> None:
    """Write an RGBA byte buffer as a standards-compliant PNG."""

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
        raw.extend(pixels[y * stride : (y + 1) * stride])
    header = struct.pack(">IIBBBBB", size, size, 8, 6, 0, 0, 0)
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(
        b"\x89PNG\r\n\x1a\n"
        + chunk(b"IHDR", header)
        + chunk(b"IDAT", zlib.compress(bytes(raw), 9))
        + chunk(b"IEND", b"")
    )


def blend(
    pixels: bytearray,
    size: int,
    x: int,
    y: int,
    color: tuple[int, int, int],
    alpha: float,
) -> None:
    if alpha <= 0 or x < 0 or y < 0 or x >= size or y >= size:
        return
    index = (y * size + x) * 4
    source_alpha = max(0.0, min(1.0, alpha))
    destination_alpha = pixels[index + 3] / 255
    output_alpha = source_alpha + destination_alpha * (1 - source_alpha)
    if output_alpha <= 0:
        return
    for channel in range(3):
        destination = pixels[index + channel]
        output = (
            color[channel] * source_alpha
            + destination * destination_alpha * (1 - source_alpha)
        ) / output_alpha
        pixels[index + channel] = max(0, min(255, round(output)))
    pixels[index + 3] = max(0, min(255, round(output_alpha * 255)))


def fill_background(pixels: bytearray, size: int, color: tuple[int, int, int]) -> None:
    pixels[:] = bytes((*color, 255)) * (size * size)


def fill_rounded_gradient(
    pixels: bytearray,
    size: int,
    top: tuple[int, int, int],
    bottom: tuple[int, int, int],
    radius: float,
) -> None:
    """Paint a transparent-corner rounded square with a vertical gradient."""
    for y in range(size):
        mix = y / max(1, size - 1)
        color = tuple(round(top[i] + (bottom[i] - top[i]) * mix) for i in range(3))
        for x in range(size):
            nearest_x = min(max(x + 0.5, radius), size - radius)
            nearest_y = min(max(y + 0.5, radius), size - radius)
            distance = math.hypot(x + 0.5 - nearest_x, y + 0.5 - nearest_y)
            coverage = max(0.0, min(1.0, radius - distance + 0.5))
            blend(pixels, size, x, y, color, coverage)


def fill_circle(
    pixels: bytearray,
    size: int,
    center: tuple[float, float],
    radius: float,
    color: tuple[int, int, int],
    opacity: float = 1,
) -> None:
    cx, cy = center
    x0 = max(0, math.floor(cx - radius - 1))
    x1 = min(size, math.ceil(cx + radius + 1))
    y0 = max(0, math.floor(cy - radius - 1))
    y1 = min(size, math.ceil(cy + radius + 1))
    for y in range(y0, y1):
        for x in range(x0, x1):
            distance = math.hypot(x + 0.5 - cx, y + 0.5 - cy)
            coverage = max(0.0, min(1.0, radius - distance + 0.5))
            blend(pixels, size, x, y, color, coverage * opacity)


def stroke_arc(
    pixels: bytearray,
    size: int,
    center: tuple[float, float],
    radius: float,
    width: float,
    color: tuple[int, int, int],
    opacity: float,
    start_degrees: float,
    sweep_degrees: float,
) -> None:
    """Rasterize a circular arc with antialiased round caps."""
    cx, cy = center
    half_width = width / 2
    start_angle = math.radians(start_degrees)
    sweep = math.radians(sweep_degrees)
    span = abs(sweep)
    direction = 1 if sweep >= 0 else -1
    end_angle = start_angle + sweep
    start = (
        cx + math.cos(start_angle) * radius,
        cy + math.sin(start_angle) * radius,
    )
    end = (
        cx + math.cos(end_angle) * radius,
        cy + math.sin(end_angle) * radius,
    )
    min_x = max(0, math.floor(cx - radius - half_width - 1))
    max_x = min(size, math.ceil(cx + radius + half_width + 1))
    min_y = max(0, math.floor(cy - radius - half_width - 1))
    max_y = min(size, math.ceil(cy + radius + half_width + 1))

    for y in range(min_y, max_y):
        py = y + 0.5
        for x in range(min_x, max_x):
            px = x + 0.5
            dx = px - cx
            dy = py - cy
            angle = math.atan2(dy, dx)
            if direction > 0:
                progress = (angle - start_angle) % math.tau
            else:
                progress = (start_angle - angle) % math.tau
            if progress <= span:
                distance = abs(math.hypot(dx, dy) - radius)
            else:
                distance = min(
                    math.hypot(px - start[0], py - start[1]),
                    math.hypot(px - end[0], py - end[1]),
                )
            coverage = max(0.0, min(1.0, half_width - distance + 0.5))
            if coverage:
                blend(pixels, size, x, y, color, coverage * opacity)


def draw_mark(
    pixels: bytearray,
    size: int,
    ink: tuple[int, int, int],
    arc_opacity: float,
) -> None:
    scale = size / 1024
    stroke_arc(
        pixels,
        size,
        tuple(value * scale for value in MARK_ARC_CENTER),
        MARK_ARC_RADIUS * scale,
        MARK_ARC_WIDTH * scale,
        ink,
        arc_opacity,
        MARK_ARC_START_DEGREES,
        MARK_ARC_SWEEP_DEGREES,
    )
    for x, y, radius, opacity in MARK_CELLS:
        fill_circle(
            pixels,
            size,
            (x * scale, y * scale),
            radius * scale,
            ink,
            opacity,
        )


def render_logo(size: int, *, dark: bool, app_tile: bool = False) -> bytearray:
    pixels = bytearray(size * size * 4)
    if app_tile:
        fill_rounded_gradient(pixels, size, TILE_TOP, TILE_BOTTOM, size * 0.225)
        ink = DARK_INK
    else:
        fill_background(pixels, size, DARK_BG if dark else LIGHT_BG)
        ink = DARK_INK if dark else LIGHT_INK
    draw_mark(
        pixels,
        size,
        ink,
        MARK_ARC_OPACITY_DARK if dark or app_tile else MARK_ARC_OPACITY_LIGHT,
    )
    return pixels


def main() -> int:
    validate_mark_geometry()
    script = Path(__file__).resolve()
    macos = script.parents[1]
    project = script.parents[3]
    resources = macos / "Resources"
    docs = project / "docs" / "assets"
    static_icons = project / "dashboard" / "static" / "icons"
    resources.mkdir(parents=True, exist_ok=True)
    docs.mkdir(parents=True, exist_ok=True)
    static_icons.mkdir(parents=True, exist_ok=True)

    print("rendering 2048×2048 light and dark brand PNGs")
    write_png(docs / "germ-logo-light.png", 2048, render_logo(2048, dark=False))
    write_png(docs / "germ-logo-dark.png", 2048, render_logo(2048, dark=True))

    for name, size in (
        ("germ-icon-192.png", 192),
        ("germ-icon-512.png", 512),
        ("apple-touch-icon.png", 180),
    ):
        print(f"rendering {name}")
        write_png(static_icons / name, size, render_logo(size, dark=True, app_tile=True))

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
    with tempfile.TemporaryDirectory() as temporary:
        iconset = Path(temporary) / "AppIcon.iconset"
        iconset.mkdir()
        for name, size in entries:
            if size not in rendered:
                print(f"rendering app icon {size}×{size}")
                rendered[size] = render_logo(size, dark=True, app_tile=True)
            write_png(iconset / name, size, rendered[size])
        subprocess.run(
            ["iconutil", "-c", "icns", str(iconset), "-o", str(target)],
            check=True,
        )

    print(f"wrote {target}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
