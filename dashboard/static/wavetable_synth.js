// Options let the Chamber inject its shared playback context and master-bus
// destination so wavetable voices obey the master volume, limiter, and
// recording tap. Standalone use (no options) still works with an own context.
function finiteOption(value, fallback) {
  if (value === null || value === undefined) return fallback;
  if (typeof value === "string" && !value.trim()) return fallback;
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

export function createGermSynthEngine({ getContext = null, getDestination = null } = {}) {
  let ownContext = null;
  let currentSource = null;
  let currentGain = null;
  let currentTable = null;
  let holdActive = false;

  const ATTACK = 0.006;
  const RELEASE = 0.045;

  function ensureContext() {
    const shared = typeof getContext === "function" ? getContext() : null;
    if (shared) return shared;
    if (!ownContext) {
      const AudioContextCtor = window.AudioContext || window.webkitAudioContext;
      if (!AudioContextCtor) throw new Error("Web Audio is not available.");
      ownContext = new AudioContextCtor();
    }
    return ownContext;
  }

  function destinationFor(ctx) {
    const shared = typeof getDestination === "function" ? getDestination() : null;
    return shared || ctx.destination;
  }

  // Release-then-stop: every voice ends through a short gain ramp, never a
  // hard stop() — the old engine clicked on each preview and stop.
  function stop() {
    const source = currentSource;
    const gainNode = currentGain;
    currentSource = null;
    currentGain = null;
    holdActive = false;
    if (!source) return;
    const ctx = source.context;
    if (gainNode) {
      try {
        const now = ctx.currentTime;
        gainNode.gain.cancelScheduledValues(now);
        gainNode.gain.setValueAtTime(gainNode.gain.value, now);
        gainNode.gain.linearRampToValueAtTime(0, now + RELEASE);
      } catch {}
    }
    try { source.stop(ctx.currentTime + RELEASE + 0.01); } catch {}
    window.setTimeout(() => {
      try { source.disconnect(); } catch {}
      try { gainNode?.disconnect(); } catch {}
    }, (RELEASE + 0.05) * 1000);
  }

  async function loadWavetable(detail, frames) {
    currentTable = normalizeTable(detail, frames);
    return currentTable;
  }

  function periodicWaveForFrame(position = 0) {
    const ctx = ensureContext();
    if (!currentTable) throw new Error("Load a wavetable first.");
    const frame = frameAtPosition(currentTable, position);
    const size = frame.length;
    const harmonics = Math.min(64, Math.floor(size / 2));
    const real = new Float32Array(harmonics + 1);
    const imag = new Float32Array(harmonics + 1);
    for (let harmonic = 1; harmonic <= harmonics; harmonic += 1) {
      let re = 0;
      let im = 0;
      for (let n = 0; n < size; n += 1) {
        const phase = (2 * Math.PI * harmonic * n) / size;
        re += frame[n] * Math.cos(phase);
        im -= frame[n] * Math.sin(phase);
      }
      real[harmonic] = (2 * re) / size;
      imag[harmonic] = (2 * im) / size;
    }
    return ctx.createPeriodicWave(real, imag, { disableNormalization: false });
  }

  async function previewFrame({ position = 0, note = "C3", gain = 0.45, duration = 0.7 } = {}) {
    stop();
    const ctx = ensureContext();
    if (ctx.state === "suspended") await ctx.resume();
    const oscillator = ctx.createOscillator();
    const gainNode = ctx.createGain();
    oscillator.setPeriodicWave(periodicWaveForFrame(position));
    oscillator.frequency.value = noteToFrequency(note);
    const level = Math.max(0, Math.min(1, finiteOption(gain, 0.45)));
    const now = ctx.currentTime;
    const holdUntil = now + Math.max(0.05, finiteOption(duration, 0.7));
    gainNode.gain.setValueAtTime(0, now);
    gainNode.gain.linearRampToValueAtTime(level, now + ATTACK);
    gainNode.gain.setValueAtTime(level, holdUntil);
    gainNode.gain.linearRampToValueAtTime(0, holdUntil + RELEASE);
    oscillator.connect(gainNode).connect(destinationFor(ctx));
    currentSource = oscillator;
    currentGain = gainNode;
    oscillator.start(now);
    oscillator.stop(holdUntil + RELEASE + 0.01);
    oscillator.onended = () => {
      if (currentSource === oscillator) {
        currentSource = null;
        currentGain = null;
        try { oscillator.disconnect(); } catch {}
        try { gainNode.disconnect(); } catch {}
      }
    };
  }

  async function holdNote({ position = 0, note = "C3", gain = 0.35 } = {}) {
    stop();
    const ctx = ensureContext();
    if (ctx.state === "suspended") await ctx.resume();
    const oscillator = ctx.createOscillator();
    const gainNode = ctx.createGain();
    oscillator.setPeriodicWave(periodicWaveForFrame(position));
    oscillator.frequency.value = noteToFrequency(note);
    const level = Math.max(0, Math.min(1, finiteOption(gain, 0.35)));
    const now = ctx.currentTime;
    gainNode.gain.setValueAtTime(0, now);
    gainNode.gain.linearRampToValueAtTime(level, now + ATTACK + 0.002);
    oscillator.connect(gainNode).connect(destinationFor(ctx));
    currentSource = oscillator;
    currentGain = gainNode;
    holdActive = true;
    oscillator.start(now);
  }

  function renderPreviewBuffer({ position = 0, note = "C3", duration = 1, gain = 0.5 } = {}) {
    if (!currentTable) throw new Error("Load a wavetable first.");
    const sampleRate = 44100;
    const frameCount = Math.max(1, Math.floor(duration * sampleRate));
    const output = new Float32Array(frameCount);
    const frame = frameAtPosition(currentTable, position);
    const frequency = noteToFrequency(note);
    let phase = 0;
    for (let i = 0; i < frameCount; i += 1) {
      const sourcePos = phase * frame.length;
      const lo = Math.floor(sourcePos) % frame.length;
      const hi = (lo + 1) % frame.length;
      const frac = sourcePos - Math.floor(sourcePos);
      output[i] = ((frame[lo] * (1 - frac)) + (frame[hi] * frac)) * gain;
      phase = (phase + frequency / sampleRate) % 1;
    }
    return output;
  }

  return {
    loadWavetable,
    previewFrame,
    holdNote,
    stop,
    renderPreviewBuffer,
    get currentTable() { return currentTable; },
    get holdActive() { return holdActive; },
  };
}

export async function loadWavetable(detail, frames) {
  return normalizeTable(detail, frames);
}

export function previewFrame(table, position = 0) {
  return frameAtPosition(table, position);
}

export function holdNote(engine, options = {}) {
  return engine.holdNote(options);
}

export function stop(engine) {
  return engine.stop();
}

export function renderPreviewBuffer(engine, options = {}) {
  return engine.renderPreviewBuffer(options);
}

function normalizeTable(detail, frames) {
  const frameSize = Number(detail?.frame_size || detail?.frameSize || 2048);
  const frameCount = Number(detail?.frame_count || detail?.frameCount || Math.floor(frames.length / frameSize));
  return {
    detail,
    frameSize,
    frameCount,
    frames,
  };
}

function frameAtPosition(table, position = 0) {
  const frameIndex = Math.max(0, Math.min(table.frameCount - 1, Math.round((Number(position) || 0) * (table.frameCount - 1))));
  const start = frameIndex * table.frameSize;
  return table.frames.slice(start, start + table.frameSize);
}

function noteToFrequency(note) {
  const match = String(note || "C3").trim().match(/^([A-Ga-g])([#b]?)(-?\d+)$/);
  if (!match) return 130.8128;
  const [, rawName, accidental, rawOctave] = match;
  const base = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 }[rawName.toUpperCase()];
  const semitone = base + (accidental === "#" ? 1 : accidental === "b" ? -1 : 0);
  const midi = (Number(rawOctave) + 1) * 12 + semitone;
  return 440 * (2 ** ((midi - 69) / 12));
}
