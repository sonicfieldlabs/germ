export function createGermSynthEngine() {
  let context = null;
  let currentSource = null;
  let currentGain = null;
  let currentTable = null;
  let holdActive = false;

  function ensureContext() {
    if (!context) {
      const AudioContextCtor = window.AudioContext || window.webkitAudioContext;
      if (!AudioContextCtor) throw new Error("Web Audio is not available.");
      context = new AudioContextCtor();
    }
    return context;
  }

  function stop() {
    if (currentSource) {
      try { currentSource.stop(); } catch {}
      try { currentSource.disconnect(); } catch {}
    }
    if (currentGain) {
      try { currentGain.disconnect(); } catch {}
    }
    currentSource = null;
    currentGain = null;
    holdActive = false;
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
    gainNode.gain.value = Math.max(0, Math.min(1, Number(gain) || 0.45));
    oscillator.connect(gainNode).connect(ctx.destination);
    currentSource = oscillator;
    currentGain = gainNode;
    oscillator.start();
    oscillator.stop(ctx.currentTime + Math.max(0.05, Number(duration) || 0.7));
    oscillator.onended = () => {
      if (currentSource === oscillator) stop();
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
    gainNode.gain.value = Math.max(0, Math.min(1, Number(gain) || 0.35));
    oscillator.connect(gainNode).connect(ctx.destination);
    currentSource = oscillator;
    currentGain = gainNode;
    holdActive = true;
    oscillator.start();
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
