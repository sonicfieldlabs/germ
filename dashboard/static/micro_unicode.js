/* ===================================================================
   Microcosmos Unicode animation adapter.

   This file is the app-local boundary around unicode-animations@1.0.3.
   Microcosmos forms consume these helpers so the renderer uses the package's
   real Unicode/Braille frame data rather than hand-recreated spinner glyphs.
   =================================================================== */

import { spinners, gridToBraille, makeGrid } from "./vendor/unicode-animations/braille.js";

export const UNICODE_ANIMATIONS_PACKAGE = "unicode-animations@1.0.3";
export const UNICODE_ANIMATION_NAMES = Object.freeze(Object.keys(spinners));

export function unicodeSpinner(name) {
  return spinners[name] || spinners.braille;
}

export function unicodeFrame(name, frame = 0, phase = 0) {
  const spinner = unicodeSpinner(name);
  const frames = spinner.frames || [];
  if (!frames.length) return "";
  const index = Math.abs(Math.floor(Number(frame) || 0) + Math.floor(Number(phase) || 0)) % frames.length;
  return frames[index] || "";
}

export function unicodeFrameCount(name) {
  return unicodeSpinner(name).frames?.length || 1;
}

export function unicodeInterval(name) {
  return unicodeSpinner(name).interval || 100;
}

export function normalizeUnicodeLines(lines) {
  const rows = (Array.isArray(lines) ? lines : [String(lines || "")]).map((line) => String(line || ""));
  const width = rows.reduce((max, line) => Math.max(max, Array.from(line).length), 0);
  return rows.map((line) => {
    const chars = Array.from(line);
    while (chars.length < width) chars.push(" ");
    return chars.join("");
  });
}

export { gridToBraille, makeGrid, spinners };
