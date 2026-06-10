/* ===================================================================
   Microcosmos Unicode forms.

   Germs, modules, and Microcosmos-only chrome now draw from the real
   unicode-animations package via micro_unicode.js. The shared app shell,
   Chamber canvas modules, transport, sidebars, and engine wiring stay outside
   this file's scope.
   =================================================================== */

import { GERM_FORMS, MODULE_FORMS } from "./micro_render.js?v=20260602-unicode-p1";
import { unicodeFrame, unicodeFrameCount, UNICODE_ANIMATIONS_PACKAGE } from "./micro_unicode.js?v=20260602-unicode-p1";

const TAU = Math.PI * 2;

export const GERM_SPRITE_R = 64;
export const GERM_FRAMES = 16;
export const MODULE_FRAMES = 16;
export const MODULE_SPRITE_R = 52;

export const GERM_BODY_RATIO = {
  drifter: 0.64,
  pulse: 0.62,
  crawler: 0.66,
  wiggle: 0.66,
  splitter: 0.64,
  glitch: 0.66,
  tendril: 0.62,
  spore: 0.7,
};

const GERM_ANIMATED = new Set(Object.keys(GERM_BODY_RATIO));
export const MODULE_ANIMATED = new Set([
  "crystal", "membrane", "mutagen", "incubator", "harvester", "magnet",
  "lens", "repeller", "quarantine", "gate", "spore", "pipe",
]);

const GERM_SPEC = {
  drifter: { spinner: "orbit", accent: "braillewave", sigil: "·", shell: ["╭───╮", "│{a}│", "╰─{b}╯"] },
  pulse: { spinner: "pulse", accent: "breathe", sigil: "◎", shell: ["╔═{b}═╗", "║ {a} ║", "╚═{c}═╝"] },
  crawler: { spinner: "snake", accent: "scanline", sigil: "≋", shell: ["╭╴{b}╶╮", "┤{a}├", "╰╴{c}╶╯"] },
  wiggle: { spinner: "waverows", accent: "scan", sigil: "~", shell: ["╭{b}╮", "│{a}│", "╰{c}╯"] },
  splitter: { spinner: "cascade", accent: "columns", sigil: "∷", shell: ["┌{b}┐", "│{a}│", "└{c}┘"] },
  glitch: { spinner: "checkerboard", accent: "diagswipe", sigil: "▒", shell: ["╓{b}╖", "║{a}║", "╙{c}╜"] },
  tendril: { spinner: "helix", accent: "dna", sigil: "⟲", shell: ["╭{b}╮", "┊{a}┊", "╰{c}╯"] },
  spore: { spinner: "fillsweep", accent: "breathe", sigil: "◌", shell: ["╭─{b}─╮", "│ {a} │", "╰─{c}─╯"] },
};

const MODULE_SPEC = {
  crystal: { spinner: "sparkle", accent: "pulse", sigil: "◇", shell: [" {b} ", " {a} ", " {c} "] },
  membrane: { spinner: "checkerboard", accent: "scanline", sigil: "▦", shell: [" {b} ", " {a} ", " {c} "] },
  mutagen: { spinner: "rain", accent: "cascade", sigil: "∴", shell: [" {b} ", " {a} ", " {c} "] },
  incubator: { spinner: "breathe", accent: "fillsweep", sigil: "◉", shell: [" {b} ", " {a} ", " {c} "] },
  harvester: { spinner: "columns", accent: "scan", sigil: "▥", shell: [" {b} ", " {a} ", " {c} "] },
  magnet: { spinner: "orbit", accent: "helix", sigil: "∩", shell: [" {b} ", " {a} ", " {c} "] },
  lens: { spinner: "scan", accent: "pulse", sigil: "⊙", shell: [" {b} ", " {a} ", " {c} "] },
  repeller: { spinner: "pulse", accent: "orbit", sigil: "⊕", shell: [" {b} ", " {a} ", " {c} "] },
  quarantine: { spinner: "checkerboard", accent: "diagswipe", sigil: "▣", shell: [" {b} ", " {a} ", " {c} "] },
  gate: { spinner: "diagswipe", accent: "braillewave", sigil: "⇥", shell: [" {b} ", " {a} ", " {c} "] },
  spore: { spinner: "cascade", accent: "dna", sigil: "⁘", shell: [" {b} ", " {a} ", " {c} "] },
  pipe: { spinner: "braillewave", accent: "scan", sigil: "→", shell: [" {b} ", " {a} ", " {c} "] },
};

function tone(dark) {
  const v = dark ? 244 : 20;
  return (a) => `rgba(${v},${v},${v},${a})`;
}

function intensity(state, kind) {
  const active = state === "living" || state === "active";
  const mutating = state === "mutating";
  if (mutating) return { main: 0.62, dim: 0.26, fill: 0.06, glow: 0.3 };
  if (active) return { main: kind === "module" ? 0.98 : 0.93, dim: 0.46, fill: 0.13, glow: 0.55 };
  return { main: 0.7, dim: 0.28, fill: 0.07, glow: 0.24 };
}

function padFrame(value, width) {
  const chars = Array.from(String(value || ""));
  if (chars.length > width) return chars.slice(0, width).join("");
  const left = Math.floor((width - chars.length) / 2);
  const right = width - chars.length - left;
  return `${" ".repeat(left)}${chars.join("")}${" ".repeat(right)}`;
}

function frameFragment(name, frame, width, phase = 0) {
  return padFrame(unicodeFrame(name, frame, phase), width);
}

function composeLines(spec, frame, width) {
  const a = frameFragment(spec.spinner, frame, width, 0);
  const b = frameFragment(spec.accent, frame, Math.max(1, Math.min(width, 4)), 2);
  const c = frameFragment(spec.accent, frame, Math.max(1, Math.min(width, 4)), 6);
  const rows = spec.shell.map((line) => line
    .replaceAll("{a}", a)
    .replaceAll("{b}", b)
    .replaceAll("{c}", c));
  const max = rows.reduce((m, row) => Math.max(m, Array.from(row).length), 0);
  return rows.map((row) => {
    const chars = Array.from(row);
    while (chars.length < max) chars.push(" ");
    return chars.join("");
  });
}

function drawTextRows(ctx, rows, r, ink, I, opts = {}) {
  const rowCount = rows.length || 1;
  const colCount = rows.reduce((m, row) => Math.max(m, Array.from(row).length), 1);
  const fontSize = Math.max(8, Math.min(r * 0.5, (r * 1.7) / rowCount, (r * 2.05) / (colCount * 0.62)));
  const cellW = fontSize * 0.62;
  const lineH = fontSize * 1.05;
  const width = colCount * cellW;
  const height = rowCount * lineH;

  ctx.save();
  ctx.font = `${fontSize}px "SF Mono", "Cascadia Mono", Menlo, Consolas, monospace`;
  ctx.textBaseline = "top";
  ctx.textAlign = "left";
  ctx.fillStyle = ink(I.main);
  ctx.strokeStyle = ink(I.dim);
  ctx.lineWidth = Math.max(1, fontSize * 0.04);

  const glow = opts.glow ?? I.glow;
  if (glow > 0) {
    ctx.globalAlpha = glow;
    ctx.fillStyle = ink(0.12);
    ctx.fillRect(-width * 0.54, -height * 0.54, width * 1.08, height * 1.1);
    ctx.globalAlpha = 1;
  }

  const startX = -width / 2;
  const startY = -height / 2;
  rows.forEach((row, y) => {
    Array.from(row).forEach((ch, x) => {
      if (ch === " ") return;
      const isFrame = "╭╮╰╯╔╗╚╝┌┐└┘╓╖╙╜╒╕╘╛┏┓┗┛│║┃┊┤├╞╡─═┬┴╱╲╶╴".includes(ch);
      const alpha = isFrame ? I.dim : I.main;
      ctx.fillStyle = ink(alpha);
      ctx.fillText(ch, startX + x * cellW, startY + y * lineH);
    });
  });

  if (opts.sigil) {
    ctx.font = `${Math.max(8, fontSize * 0.78)}px "SF Mono", Menlo, Consolas, monospace`;
    ctx.fillStyle = ink(I.main * 0.75);
    ctx.textAlign = "center";
    ctx.fillText(opts.sigil, 0, startY + height + fontSize * 0.02);
  }
  ctx.restore();
}

function drawUnicodeForm(ctx, spec, { r, state, frame = 0, dark, kind, width = 4 }) {
  const ink = tone(dark);
  const I = intensity(state, kind);
  const rows = composeLines(spec, frame, width);
  drawTextRows(ctx, rows, r, ink, I, { sigil: spec.sigil, glow: kind === "module" ? 0 : undefined });

  if (kind === "module") return;

  ctx.save();
  ctx.strokeStyle = ink(I.dim * 0.38);
  ctx.lineWidth = Math.max(1, r * 0.018);
  ctx.setLineDash([Math.max(2, r * 0.05), Math.max(2, r * 0.09)]);
  ctx.beginPath();
  ctx.arc(0, 0, r * 0.84, 0, TAU);
  ctx.stroke();
  ctx.setLineDash([]);
  ctx.restore();
}

for (const [type, spec] of Object.entries(GERM_SPEC)) {
  GERM_FORMS[type] = (ctx, params) => {
    const count = unicodeFrameCount(spec.spinner);
    const frame = (params.frame || 0) % Math.max(1, count);
    drawUnicodeForm(ctx, spec, { ...params, frame, kind: "germ", width: type === "pulse" || type === "spore" ? 3 : 4 });
  };
}

for (const [type, spec] of Object.entries(MODULE_SPEC)) {
  MODULE_FORMS[type] = (ctx, params) => {
    const count = unicodeFrameCount(spec.spinner);
    const frame = (params.frame || 0) % Math.max(1, count);
    drawUnicodeForm(ctx, spec, { ...params, frame, kind: "module", width: type === "incubator" || type === "spore" ? 3 : 4 });
  };
}

export function germRenderParams(g, bodyRcss) {
  const type = GERM_BODY_RATIO[g.visual] ? g.visual : "drifter";
  const stateCat = g.state === "living" ? "living" : g.state === "mutating" ? "mutating" : "dormant";
  const ratio = GERM_BODY_RATIO[type] || 0.64;
  const spriteHalfCss = Math.max(1, bodyRcss / ratio);
  const scale = spriteHalfCss / GERM_SPRITE_R;
  let frame = 0;
  if (GERM_ANIMATED.has(type)) {
    frame = Math.floor((g.pulse / TAU) * GERM_FRAMES) % GERM_FRAMES;
    if (frame < 0) frame += GERM_FRAMES;
  }
  let rotation = 0;
  if (type === "drifter" || type === "wiggle") rotation = Math.atan2(g.vy || 0, g.vx || 0) * 0.12;
  else if (type === "tendril" || type === "crawler") rotation = Math.sin(g.pulse * 0.35) * 0.08;
  return {
    halfPx: GERM_SPRITE_R,
    scale,
    rotation,
    params: { kind: "germ", state: stateCat, frame, variant: `${UNICODE_ANIMATIONS_PACKAGE}:${type}` },
  };
}

const MODULE_VESSEL_SCALE = 1.6;

export function moduleVesselParams(mod, glyphCss) {
  const on = mod.state === "active" || mod.state === "triggered" || mod.state === "overloaded";
  const onScreenHalf = Math.max(7, glyphCss * MODULE_VESSEL_SCALE);
  let frame = 0;
  if (MODULE_ANIMATED.has(mod.type)) {
    const pulse = mod.pulse || 0;
    frame = Math.floor((pulse / TAU) * MODULE_FRAMES) % MODULE_FRAMES;
    if (frame < 0) frame += MODULE_FRAMES;
  }
  return {
    halfPx: MODULE_SPRITE_R,
    scale: onScreenHalf / MODULE_SPRITE_R,
    params: { kind: "mod", state: on ? "active" : "idle", frame, variant: `${UNICODE_ANIMATIONS_PACKAGE}:${mod.type}` },
  };
}

const MICRO_ICON_TEXT = {
  crystal: "◇",
  membrane: "▦",
  mutagen: "∴",
  incubator: "◉",
  harvester: "▥",
  magnet: "∩",
  lens: "⊙",
  repeller: "⊕",
  quarantine: "▣",
  gate: "⇥",
  spore: "⁘",
  pipe: "→",
  spawn: "⊹",
  library: "▤",
  module: "▦",
  harvest: "⇣",
  expand: "⌗",
  clear: "×",
  help: "?",
  back: "←",
  settings: "⚙",
  refresh: "↻",
};

export function microIconSvg(name) {
  const glyph = MICRO_ICON_TEXT[name];
  if (!glyph) return "";
  const escaped = glyph.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
  return `<span class="micro-unicode-icon" aria-hidden="true">${escaped}</span>`;
}

export function hydrateMicroIcons(root) {
  const scope = root && root.querySelectorAll ? root : (typeof document !== "undefined" ? document : null);
  if (!scope) return;
  scope.querySelectorAll("[data-icon]").forEach((el) => {
    const name = el.getAttribute("data-icon");
    if (!name || el.getAttribute("data-icon-hydrated") === name) return;
    const icon = microIconSvg(name);
    if (!icon) return;
    el.innerHTML = icon;
    el.setAttribute("data-icon-hydrated", name);
  });
}

export { GERM_FORMS, MODULE_FORMS };
