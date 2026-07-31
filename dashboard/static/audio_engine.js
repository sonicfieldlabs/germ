/* ===================================================================
   germ audio engine core
   Shared DSP layer for the Chamber and the Microcosmos: quality impulse
   responses, an AudioWorklet granulator / envelope gate / lossless PCM
   recorder, a polyphonic trigger-voice pool, a dithered WAV encoder, and
   the smoothing + equal-power helpers every surface routes through.
   Everything degrades gracefully: callers must treat worklet-backed
   features as optional and keep their legacy paths as fallbacks.
   =================================================================== */

export const SMOOTH_FAST = 0.012;   // mute/solo, click-free level moves
export const SMOOTH_UI = 0.03;      // slider-driven parameter moves
export const SMOOTH_GLIDE = 0.06;   // delay-time style glides

/* ── Parameter smoothing ─────────────────────────────────────────── */

export function smoothSet(param, value, context, timeConstant = SMOOTH_UI) {
  if (!param) return;
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return;
  try {
    param.setTargetAtTime(numeric, context.currentTime, Math.max(0.001, timeConstant));
  } catch {
    param.value = numeric;
  }
}

/* Equal-power wet/dry: constant perceived level across the mix sweep. */
export function equalPowerMix(mix) {
  const clamped = Math.min(1, Math.max(0, Number(mix) || 0));
  return {
    dry: Math.cos(clamped * Math.PI * 0.5),
    wet: Math.sin(clamped * Math.PI * 0.5),
  };
}

/* ── Impulse responses ───────────────────────────────────────────────
   Deterministic per (context, mode): pre-delay, sparse early
   reflections, and an exponentially decaying noise tail whose highs
   darken over time (one-pole lowpass with a closing coefficient), so
   rooms breathe instead of hissing. Cached — the old engine regenerated
   a raw random burst on every graph rebuild.                          */

const IR_SETTINGS = {
  room: { seconds: 0.7, decay: 3.4, preDelay: 0.008, dampStart: 0.32, dampEnd: 0.62, early: 5, earlySpan: 0.045 },
  plate: { seconds: 1.5, decay: 2.6, preDelay: 0.012, dampStart: 0.18, dampEnd: 0.4, early: 3, earlySpan: 0.03 },
  hall: { seconds: 2.9, decay: 2.2, preDelay: 0.024, dampStart: 0.24, dampEnd: 0.7, early: 7, earlySpan: 0.08 },
};

const irCache = new WeakMap();

function mulberry32(seed) {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function createReverbImpulse(context, mode = "room") {
  const settings = IR_SETTINGS[mode] || IR_SETTINGS.room;
  let perContext = irCache.get(context);
  if (!perContext) {
    perContext = new Map();
    irCache.set(context, perContext);
  }
  const key = `${mode}:${context.sampleRate}`;
  if (perContext.has(key)) return perContext.get(key);

  const rate = context.sampleRate;
  const preFrames = Math.floor(settings.preDelay * rate);
  const tailFrames = Math.max(1, Math.floor(settings.seconds * rate));
  const total = preFrames + tailFrames;
  const impulse = context.createBuffer(2, total, rate);

  for (let channel = 0; channel < 2; channel += 1) {
    const data = impulse.getChannelData(channel);
    const rand = mulberry32(0x9e3779b9 ^ (channel * 0x85ebca6b) ^ settings.early);
    // Early reflections: sparse signed taps inside the first span.
    for (let i = 0; i < settings.early; i += 1) {
      const at = preFrames + Math.floor(rand() * settings.earlySpan * rate);
      const sign = rand() > 0.5 ? 1 : -1;
      if (at < total) data[at] += sign * (0.5 - i * (0.35 / settings.early));
    }
    // Late tail: decaying noise through a progressively closing one-pole.
    let lp = 0;
    for (let i = 0; i < tailFrames; i += 1) {
      const progress = i / tailFrames;
      const envelope = Math.pow(1 - progress, settings.decay);
      const damp = settings.dampStart + (settings.dampEnd - settings.dampStart) * progress;
      const noise = rand() * 2 - 1;
      lp += (noise - lp) * (1 - damp);
      data[preFrames + i] += lp * envelope;
    }
    // Normalize each channel to a consistent tail energy.
    let peak = 0;
    for (let i = 0; i < total; i += 1) peak = Math.max(peak, Math.abs(data[i]));
    if (peak > 0) {
      const scale = 0.86 / peak;
      for (let i = 0; i < total; i += 1) data[i] *= scale;
    }
  }
  perContext.set(key, impulse);
  return impulse;
}

/* ── Soft clip ────────────────────────────────────────────────────────
   Master-bus safety stage: unity below ~-1 dBFS, then a tanh knee, so
   inter-voice pileups round off instead of hard-clipping the DAC.     */

let softClipCurveCache = null;

export function softClipCurve() {
  if (softClipCurveCache) return softClipCurveCache;
  const samples = 4096;
  const curve = new Float32Array(samples);
  const knee = 0.891; // ≈ -1 dBFS
  for (let i = 0; i < samples; i += 1) {
    const x = (i * 2) / (samples - 1) - 1;
    const abs = Math.abs(x);
    curve[i] = abs <= knee
      ? x
      : Math.sign(x) * (knee + (1 - knee) * Math.tanh((abs - knee) / (1 - knee)));
  }
  softClipCurveCache = curve;
  return curve;
}

/* ── WAV encoding (16/24-bit PCM, TPDF dither on 16) ─────────────── */

export function encodeWavBlob(channelData, sampleRate, { bitDepth = 16, dither = true } = {}) {
  const channels = Math.min(2, Math.max(1, channelData.length));
  const frames = channelData[0]?.length || 0;
  const bytesPerSample = bitDepth === 24 ? 3 : 2;
  const blockAlign = channels * bytesPerSample;
  const dataSize = frames * blockAlign;
  const buffer = new ArrayBuffer(44 + dataSize);
  const view = new DataView(buffer);
  const writeString = (offset, value) => {
    for (let i = 0; i < value.length; i += 1) view.setUint8(offset + i, value.charCodeAt(i));
  };
  writeString(0, "RIFF");
  view.setUint32(4, 36 + dataSize, true);
  writeString(8, "WAVE");
  writeString(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, channels, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * blockAlign, true);
  view.setUint16(32, blockAlign, true);
  view.setUint16(34, bitDepth === 24 ? 24 : 16, true);
  writeString(36, "data");
  view.setUint32(40, dataSize, true);
  let offset = 44;
  for (let frame = 0; frame < frames; frame += 1) {
    for (let channel = 0; channel < channels; channel += 1) {
      const raw = channelData[Math.min(channel, channelData.length - 1)][frame] || 0;
      if (bitDepth === 24) {
        const clamped = Math.max(-1, Math.min(1, raw));
        const value = Math.round(clamped * 8388607);
        view.setUint8(offset, value & 0xff);
        view.setUint8(offset + 1, (value >> 8) & 0xff);
        view.setUint8(offset + 2, (value >> 16) & 0xff);
        offset += 3;
      } else {
        // TPDF dither at ±1 LSB keeps quiet tails from truncation buzz.
        const noise = dither ? (Math.random() - Math.random()) / 32768 : 0;
        const clamped = Math.max(-1, Math.min(1, raw + noise));
        view.setInt16(offset, clamped < 0 ? clamped * 0x8000 : clamped * 0x7fff, true);
        offset += 2;
      }
    }
  }
  return new Blob([buffer], { type: "audio/wav" });
}

/* ── AudioWorklet processors ─────────────────────────────────────────
   One module, three processors:
   - germ-granular: ring-buffer granulator (true grain scheduling with
     Hann windows, jitter, pitch scatter, stereo spray) — replaces the
     comb-filter placeholder behind the granular/micro FX family.
   - germ-gate: envelope-follower gate with attack/hold/release — the
     old gate was a memoryless waveshaper that distorted instead of
     gating.
   - germ-recorder: lossless PCM tap for WAV master recording, harvest,
     and hardware capture.                                             */

const WORKLET_SOURCE = `
class GermGranularProcessor extends AudioWorkletProcessor {
  constructor(options) {
    super();
    const seconds = 3;
    this.ringSize = Math.max(1, Math.floor(seconds * sampleRate));
    this.ring = [new Float32Array(this.ringSize), new Float32Array(this.ringSize)];
    this.writeIndex = 0;
    this.filled = 0;
    this.grains = [];
    this.spawnDebt = 0;
    this.params = {
      density: 0.58, sizeMs: 70, jitter: 0.35, scatter: 0.25, spray: 0.4,
    };
    this.setParams((options && options.processorOptions) || {});
    this.port.onmessage = (event) => this.setParams(event.data || {});
  }
  setParams(next) {
    const p = this.params;
    if (Number.isFinite(next.density)) p.density = Math.min(1, Math.max(0, next.density));
    if (Number.isFinite(next.sizeMs)) p.sizeMs = Math.min(400, Math.max(8, next.sizeMs));
    if (Number.isFinite(next.jitter)) p.jitter = Math.min(1, Math.max(0, next.jitter));
    if (Number.isFinite(next.scatter)) p.scatter = Math.min(1, Math.max(0, next.scatter));
    if (Number.isFinite(next.spray)) p.spray = Math.min(1, Math.max(0, next.spray));
  }
  spawnGrain() {
    if (this.grains.length >= 48 || this.filled < sampleRate * 0.05) return;
    const p = this.params;
    const total = Math.max(64, Math.floor((p.sizeMs / 1000) * sampleRate));
    const back = 0.012 + p.jitter * 0.45;
    const maxBack = Math.min(this.filled - total - 8, back * sampleRate);
    if (maxBack <= 0) return;
    const offset = 8 + Math.random() * maxBack;
    const semis = (Math.random() * 2 - 1) * p.scatter * 7;
    const step = Math.pow(2, semis / 12);
    const pan = (Math.random() * 2 - 1) * p.spray;
    this.grains.push({
      pos: this.writeIndex - offset,
      step,
      i: 0,
      total,
      ampL: Math.SQRT1_2 * Math.cos((pan + 1) * Math.PI / 4) * 1.35,
      ampR: Math.SQRT1_2 * Math.sin((pan + 1) * Math.PI / 4) * 1.35,
    });
  }
  process(inputs, outputs) {
    const input = inputs[0];
    const output = outputs[0];
    if (!output || !output[0]) return true;
    const frames = output[0].length;
    const inL = input && input[0] ? input[0] : null;
    const inR = input && input[1] ? input[1] : inL;
    for (let i = 0; i < frames; i += 1) {
      this.ring[0][this.writeIndex % this.ringSize] = inL ? inL[i] : 0;
      this.ring[1][this.writeIndex % this.ringSize] = inR ? inR[i] : 0;
      this.writeIndex += 1;
    }
    this.filled = Math.min(this.ringSize, this.filled + frames);
    const perSecond = 4 + this.params.density * 116;
    this.spawnDebt += (frames / sampleRate) * perSecond;
    while (this.spawnDebt >= 1) {
      this.spawnDebt -= 1;
      this.spawnGrain();
    }
    const outL = output[0];
    const outR = output[1] || output[0];
    outL.fill(0);
    if (outR !== outL) outR.fill(0);
    const twoPi = Math.PI * 2;
    for (let g = this.grains.length - 1; g >= 0; g -= 1) {
      const grain = this.grains[g];
      const remaining = Math.min(frames, grain.total - grain.i);
      for (let i = 0; i < remaining; i += 1) {
        const window = 0.5 - 0.5 * Math.cos((twoPi * (grain.i + i)) / grain.total);
        const readPos = grain.pos + (grain.i + i) * grain.step;
        const base = Math.floor(readPos);
        const frac = readPos - base;
        const idx0 = ((base % this.ringSize) + this.ringSize) % this.ringSize;
        const idx1 = (idx0 + 1) % this.ringSize;
        const sampleL = this.ring[0][idx0] * (1 - frac) + this.ring[0][idx1] * frac;
        const sampleR = this.ring[1][idx0] * (1 - frac) + this.ring[1][idx1] * frac;
        outL[i] += sampleL * window * grain.ampL;
        if (outR !== outL) outR[i] += sampleR * window * grain.ampR;
      }
      grain.i += remaining;
      if (grain.i >= grain.total) this.grains.splice(g, 1);
    }
    return true;
  }
}

class GermGateProcessor extends AudioWorkletProcessor {
  constructor(options) {
    super();
    this.env = 0;
    this.gain = 1;
    this.holdFrames = 0;
    this.params = { threshold: 0.18, release: 0.22 };
    this.setParams((options && options.processorOptions) || {});
    this.port.onmessage = (event) => this.setParams(event.data || {});
  }
  setParams(next) {
    if (Number.isFinite(next.threshold)) this.params.threshold = Math.min(1, Math.max(0, next.threshold));
    if (Number.isFinite(next.release)) this.params.release = Math.min(2, Math.max(0.02, next.release));
  }
  process(inputs, outputs) {
    const input = inputs[0];
    const output = outputs[0];
    if (!output || !output[0]) return true;
    if (!input || !input[0]) {
      output.forEach((channel) => channel.fill(0));
      return true;
    }
    const frames = output[0].length;
    const channels = Math.min(input.length, output.length);
    const attackCoef = Math.exp(-1 / (0.0018 * sampleRate));
    const envReleaseCoef = Math.exp(-1 / (0.04 * sampleRate));
    const gateOpenCoef = Math.exp(-1 / (0.0022 * sampleRate));
    const gateCloseCoef = Math.exp(-1 / (this.params.release * sampleRate));
    const threshold = this.params.threshold * 0.5;
    const holdTotal = Math.floor(0.03 * sampleRate);
    for (let i = 0; i < frames; i += 1) {
      let peak = 0;
      for (let channel = 0; channel < channels; channel += 1) {
        const value = Math.abs(input[channel][i] || 0);
        if (value > peak) peak = value;
      }
      this.env = peak > this.env
        ? peak + (this.env - peak) * attackCoef
        : peak + (this.env - peak) * envReleaseCoef;
      let target;
      if (this.env >= threshold) {
        target = 1;
        this.holdFrames = holdTotal;
      } else if (this.holdFrames > 0) {
        this.holdFrames -= 1;
        target = 1;
      } else {
        target = 0;
      }
      const coef = target > this.gain ? gateOpenCoef : gateCloseCoef;
      this.gain = target + (this.gain - target) * coef;
      for (let channel = 0; channel < channels; channel += 1) {
        output[channel][i] = (input[channel][i] || 0) * this.gain;
      }
    }
    return true;
  }
}

class GermRecorderProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.recording = true;
    this.port.onmessage = (event) => {
      if (event.data === "stop") {
        this.recording = false;
        // Messages sent through one MessagePort are ordered. The main thread
        // can therefore treat this acknowledgment as a flush boundary after
        // every PCM block posted by earlier process() calls.
        this.port.postMessage({ type: "stopped" });
      }
    };
  }
  process(inputs) {
    if (!this.recording) return false;
    const input = inputs[0];
    if (input && input[0] && input[0].length) {
      const left = new Float32Array(input[0]);
      const right = input[1] ? new Float32Array(input[1]) : left.slice();
      this.port.postMessage({ left, right }, [left.buffer, right.buffer]);
    }
    return true;
  }
}

registerProcessor("germ-granular", GermGranularProcessor);
registerProcessor("germ-gate", GermGateProcessor);
registerProcessor("germ-recorder", GermRecorderProcessor);
`;

const workletReady = new WeakMap();

export async function ensureWorklets(context) {
  if (!context?.audioWorklet?.addModule) return false;
  if (workletReady.has(context)) return workletReady.get(context);
  const promise = (async () => {
    const url = URL.createObjectURL(new Blob([WORKLET_SOURCE], { type: "application/javascript" }));
    try {
      await context.audioWorklet.addModule(url);
      return true;
    } catch (error) {
      console.warn("germ audio worklets unavailable:", error?.message || error);
      return false;
    } finally {
      URL.revokeObjectURL(url);
    }
  })();
  workletReady.set(context, promise);
  return promise;
}

export function createGranularNode(context, params = {}) {
  try {
    const node = new AudioWorkletNode(context, "germ-granular", {
      numberOfInputs: 1,
      numberOfOutputs: 1,
      outputChannelCount: [2],
      processorOptions: params,
    });
    return node;
  } catch {
    return null;
  }
}

export function createGateNode(context, params = {}) {
  try {
    return new AudioWorkletNode(context, "germ-gate", {
      numberOfInputs: 1,
      numberOfOutputs: 1,
      outputChannelCount: [2],
      processorOptions: params,
    });
  } catch {
    return null;
  }
}

/* ── Lossless PCM recorder ────────────────────────────────────────────
   Taps any node through germ-recorder and returns a dithered 16-bit WAV
   on stop. Callers keep their MediaRecorder/webm path as the fallback
   when worklets are unavailable.                                      */

export async function createWavRecorder(context, sourceNode) {
  const ready = await ensureWorklets(context);
  if (!ready) return null;
  let tap;
  try {
    tap = new AudioWorkletNode(context, "germ-recorder", {
      numberOfInputs: 1,
      numberOfOutputs: 0,
      channelCount: 2,
      channelCountMode: "explicit",
      channelInterpretation: "speakers",
    });
  } catch {
    return null;
  }
  const left = [];
  const right = [];
  let frames = 0;
  let active = false;
  let stopping = false;
  let stopPromise = null;
  let resolveStopAck = null;
  tap.port.onmessage = (event) => {
    if (event.data?.type === "stopped") {
      resolveStopAck?.();
      return;
    }
    if ((!active && !stopping) || !event.data?.left) return;
    left.push(event.data.left);
    right.push(event.data.right || event.data.left);
    frames += event.data.left.length;
  };
  return {
    start() {
      if (active) return;
      active = true;
      sourceNode.connect(tap);
    },
    async stop() {
      if (stopPromise) return stopPromise;
      if (!active) return null;
      active = false;
      stopping = true;
      stopPromise = (async () => {
        await new Promise((resolve) => {
          const timeout = window.setTimeout(resolve, 120);
          resolveStopAck = () => {
            window.clearTimeout(timeout);
            resolve();
          };
          try { tap.port.postMessage("stop"); } catch { resolveStopAck(); }
        });
        stopping = false;
        resolveStopAck = null;
        try { sourceNode.disconnect(tap); } catch {}
        try { tap.disconnect(); } catch {}
        const mergedLeft = new Float32Array(frames);
        const mergedRight = new Float32Array(frames);
        let offset = 0;
        for (let i = 0; i < left.length; i += 1) {
          mergedLeft.set(left[i], offset);
          mergedRight.set(right[i], offset);
          offset += left[i].length;
        }
        left.length = 0;
        right.length = 0;
        const blob = encodeWavBlob([mergedLeft, mergedRight], context.sampleRate, { bitDepth: 16, dither: true });
        return { blob, duration: frames / context.sampleRate, sampleRate: context.sampleRate };
      })();
      return stopPromise;
    },
    get recording() { return active; },
  };
}

/* ── Trigger voice pool ───────────────────────────────────────────────
   Sample-accurate polyphonic one-shots for pads and clocked triggers:
   AudioBufferSource voices with anti-click envelopes, per-voice gain and
   pan, and oldest-voice stealing — replacing the raw new Audio() per
   hit that bypassed the master bus entirely.                          */

export function createVoicePool(context, destination, { maxVoices = 32 } = {}) {
  const voices = new Set();
  function stealOldest() {
    let oldest = null;
    voices.forEach((voice) => {
      if (!oldest || voice.startedAt < oldest.startedAt) oldest = voice;
    });
    if (oldest) release(oldest, 0.012);
  }
  function release(voice, fadeSeconds = 0.01) {
    if (!voices.has(voice)) return;
    voices.delete(voice);
    const now = context.currentTime;
    try {
      voice.gain.gain.cancelScheduledValues(now);
      voice.gain.gain.setValueAtTime(voice.gain.gain.value, now);
      voice.gain.gain.linearRampToValueAtTime(0, now + fadeSeconds);
      voice.source.stop(now + fadeSeconds + 0.005);
    } catch {}
    window.setTimeout(() => {
      try { voice.source.disconnect(); } catch {}
      try { voice.gain.disconnect(); } catch {}
      try { voice.panner?.disconnect(); } catch {}
    }, (fadeSeconds + 0.03) * 1000);
  }
  return {
    trigger(buffer, { gain = 1, pan = 0, rate = 1, when = 0 } = {}) {
      if (!buffer) return null;
      if (voices.size >= maxVoices) stealOldest();
      const source = context.createBufferSource();
      source.buffer = buffer;
      source.playbackRate.value = Math.min(4, Math.max(0.25, Number(rate) || 1));
      const gainNode = context.createGain();
      const panner = context.createStereoPanner ? context.createStereoPanner() : null;
      const level = Math.min(2, Math.max(0, Number(gain) || 0));
      const startAt = context.currentTime + Math.max(0, when);
      gainNode.gain.setValueAtTime(0, startAt);
      gainNode.gain.linearRampToValueAtTime(level, startAt + 0.003);
      source.connect(gainNode);
      if (panner) {
        panner.pan.value = Math.min(1, Math.max(-1, Number(pan) || 0));
        gainNode.connect(panner);
        panner.connect(destination);
      } else {
        gainNode.connect(destination);
      }
      const voice = { source, gain: gainNode, panner, startedAt: performance.now() };
      voices.add(voice);
      source.addEventListener("ended", () => {
        voices.delete(voice);
        try { source.disconnect(); } catch {}
        try { gainNode.disconnect(); } catch {}
        try { panner?.disconnect(); } catch {}
      });
      source.start(startAt);
      return voice;
    },
    stopAll(fadeSeconds = 0.015) {
      [...voices].forEach((voice) => release(voice, fadeSeconds));
    },
    get activeCount() { return voices.size; },
  };
}
