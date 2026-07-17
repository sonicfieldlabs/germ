/* ===================================================================
   Microcosmos — a scope-based generative world where sounds become living
   organisms ("germs"). A simplified experiential skin over the same engine:
   germs reference shared assets, play through the shared master bus, generate
   through the same Stable Audio pipeline, and harvest back into the library.

   This module is engine-agnostic: app.js passes a curated `engine` API into
   initOneBitDish(). Microcosmos keeps its own lightweight germ model, <canvas>
   renderer, physics, and scope camera — it does NOT touch canvasNodes.
   =================================================================== */

import { createMicroRenderer, GERM_FORMS, MODULE_FORMS } from "./micro_render.js?v=20260602-unicode-p1";
import { germRenderParams, moduleVesselParams, hydrateMicroIcons, MODULE_FRAMES } from "./micro_forms.js?v=20260602-unicode-p1";
import { unicodeFrame } from "./micro_unicode.js?v=20260602-unicode-p1";

function dishAccentColor() {
  return getComputedStyle(document.documentElement).getPropertyValue("--leaf").trim() || "#476f5d";
}

// ---- Word banks for the card-prompt game ---------------------------------
const WORD_BANKS = {
  recipe: {
    label: "What grows?",
    cards: [
      { word: "hit", recipe: "one-shot" },
      { word: "loop", recipe: "loop" },
      { word: "texture", recipe: "texture" },
      { word: "drone", recipe: "drone" },
      { word: "creature", recipe: "creature" },
    ],
  },
  body: {
    label: "Choose a body",
    cards: ["metal", "glass", "dust", "rubber", "water", "ceramic", "bone", "wire"],
  },
  action: {
    label: "Choose an action",
    cards: ["scrape", "pulse", "crackle", "breathe", "snap", "bloom", "fracture", "hum"],
  },
  texture: {
    label: "Choose a texture",
    cards: ["dry", "wet", "brittle", "granular", "soft", "corroded", "tiny", "deep"],
  },
  space: {
    label: "Choose a space",
    cards: ["close mic", "chamber", "underwater", "concrete", "inside metal", "wide field"],
  },
};

const RECIPE_TAILS = {
  "one-shot": "fast decay, no voice, no melody",
  loop: "short seamless loop, tactile rhythm, no voice, no full song",
  texture: "evolving texture bed, no voice, no melody",
  drone: "sustained drone, slow movement, no voice",
  creature: "organic creature-like gesture, no voice, no music",
};

const RECIPE_DURATION = { "one-shot": 1.5, loop: 4, texture: 8, drone: 10, creature: 3 };

// ---- Tunable physics / audio constants -----------------------------------
const WORLD = { w: 3200, h: 2200 };
const DISH = { x: WORLD.w / 2, y: WORLD.h / 2, radius: 960 };
const DEFAULT_ZOOM = 0.44;
const MAX_POPULATION = 32;
const MAX_AUDIBLE_VOICES = 24;
const TARGET_SAMPLE_RATE = 44100;
const GERM_MIN_R = 16;
const GERM_MAX_R = 46;
const BIRTH_FRAMES = 16;
const FRICTION = 0.992;
const ENERGY = { still: 0, slow: 0.05, living: 0.16, chaotic: 0.5 };
const GENERATION_MAX_CONCURRENT = 1;
const GENERATION_COOLDOWN_MS = 4500;
const MODULE_TRIGGER_COOLDOWN_MS = 42000;
const MICRO_SCOPE_ZOOM = DEFAULT_ZOOM;
const MICRO_WORLD_ZOOM = 0.82;
const MICRO_MIN_ZOOM = 0.24;
const MICRO_MAX_ZOOM = 2.6;

const MODULE_DEFS = {
  crystal: { label: "Crystal", detail: "Harmonic resonator that branches bright granular children.", radius: 165, canvasFx: "spectral_tissue" },
  membrane: { label: "Membrane", detail: "Filters germs passing through a porous boundary.", radius: 230, canvasFx: "membrane" },
  mutagen: { label: "Mutagen Pod", detail: "Introduces audio-to-audio variation.", radius: 170, canvasFx: "incubator" },
  incubator: { label: "Incubator", detail: "Spawns new lifeforms from dwelling germs.", radius: 185, canvasFx: "incubator" },
  harvester: { label: "Harvester", detail: "Charges nearby colonies for harvest.", radius: 175, canvasFx: "colony" },
  magnet: { label: "Magnet", detail: "Pulls nearby germs into an orbiting cluster.", radius: 210, canvasFx: "colony" },
  lens: { label: "Lens", detail: "Focuses interactions and microscope gain.", radius: 190, canvasFx: "microscope" },
  repeller: { label: "Repeller", detail: "Pushes nearby germs away from a field center.", radius: 190, canvasFx: "swarm" },
  quarantine: { label: "Quarantine", detail: "Slows unstable or infected germs.", radius: 190, canvasFx: "gate" },
  gate: { label: "Gate", detail: "Routes microbe flow through a directional passage.", radius: 170, canvasFx: "gate" },
  spore: { label: "Spore Duplicator", detail: "Splits compatible germs into spores.", radius: 160, canvasFx: "colony" },
  pipe: { label: "Pipe Port", detail: "Pipes selected life into the canvas workflow.", radius: 150, canvasFx: "microscope" },
};

const MODULE_CANVAS_FX = Object.fromEntries(Object.entries(MODULE_DEFS).map(([type, def]) => [type, def.canvasFx]));

const MICRO_GERM_ASSETS = {
  drifter: { category: "germ", states: ["dormant", "active", "moving", "colliding"], anchor: [0.5, 0.5], scale: 1, motif: "orb-tail" },
  pulse: { category: "germ", states: ["dormant", "active", "looping"], anchor: [0.5, 0.5], scale: 1.08, motif: "rings" },
  crawler: { category: "germ", states: ["active", "moving", "colliding"], anchor: [0.5, 0.5], scale: 0.96, motif: "legs" },
  wiggle: { category: "germ", states: ["active", "moving"], anchor: [0.5, 0.5], scale: 1, motif: "wave" },
  splitter: { category: "germ", states: ["active", "breeding", "harvested"], anchor: [0.5, 0.5], scale: 1, motif: "cluster" },
  glitch: { category: "germ", states: ["active", "infected", "mutating"], anchor: [0.5, 0.5], scale: 0.92, motif: "broken-ring" },
  tendril: { category: "germ", states: ["active", "moving", "mutating"], anchor: [0.5, 0.5], scale: 1.05, motif: "tendrils" },
  spore: { category: "germ", states: ["dormant", "spawn", "harvested"], anchor: [0.5, 0.5], scale: 0.88, motif: "seed" },
};

const MICRO_MODULE_ASSETS = Object.fromEntries(Object.entries(MODULE_DEFS).map(([id, def]) => [id, {
  id,
  category: "module",
  states: ["idle", "hovered", "active", "triggered", "cooldown", "overloaded"],
  anchor: [0.5, 0.5],
  scale: id === "membrane" ? 1.12 : 1,
  label: def.label,
}]));
const MICRO_GERM_TYPES = Object.keys(MICRO_GERM_ASSETS);

// ---- Module state --------------------------------------------------------
let E = null; // engine API
let dom = {};
let ctx2d = null;
let microRenderer = null;
let germs = [];
let modules = []; // Microcosmos field objects.
let camera = { x: WORLD.w / 2, y: WORLD.h / 2, zoom: DEFAULT_ZOOM };
let cameraTarget = { ...camera };
let microMode = "world"; // scope | world
let dpr = 1;
let running = false;
let rafHandle = null;
let lastFrame = 0;
let hudElapsed = 0;
let energyLevel = "living";
let chemistry = "bounce"; // bounce | infect | breed (what happens when germs touch)
let lastBreedAt = 0;
const BREED_COOLDOWN_MS = 5000;
const pairCooldown = new Map();
let generationActive = 0;
let generationTimer = null;
const generationQueue = [];
let generationEpoch = 0;
let gravity = 0.04;
let viscosity = FRICTION;
let harvestScope = "scope";
let spectatorMode = false;
let spectatorPhase = 0;
let pointer = { dragging: null, draggingModule: null, panning: false, lastX: 0, lastY: 0, downX: 0, downY: 0, moved: false };
let cardFlow = null; // active word-card session
let modulePalettePoint = null;
let effects = [];
let resetArmedUntil = 0;
let nextId = 1;
let _selectedModuleId = null;
let _hoveredGermId = null;
let _hoveredModuleId = null;
const STORAGE_KEY = "germinator-onebit-dish";

// ---- Static layer cache (petri frame + world texture) --------------------
let staticLayer = null;
let staticLayerKey = '';

// ---- Floating motes for atmospheric depth --------------------------------
const MOTE_COUNT = 18;
let floatingMotes = [];
function initMotes(vw, vh) {
  floatingMotes = [];
  for (let i = 0; i < MOTE_COUNT; i++) {
    floatingMotes.push({
      x: Math.random() * vw,
      y: Math.random() * vh,
      vx: (Math.random() - 0.5) * 0.3,
      vy: (Math.random() - 0.5) * 0.2,
      size: 0.6 + Math.random() * 1.4,
      alpha: 0.15 + Math.random() * 0.25,
    });
  }
}

function uid(prefix) {
  return `${prefix}_${(nextId++).toString(36)}${Math.random().toString(36).slice(2, 6)}`;
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function performanceNow() {
  return (typeof performance !== "undefined" && performance.now) ? performance.now() : Date.now();
}

function pushEffect(type, x, y, opts = {}) {
  effects.push({
    id: uid("fx"),
    type,
    x,
    y,
    age: 0,
    ttl: opts.ttl || 0.9,
    radius: opts.radius || 60,
    label: opts.label || "",
  });
  if (effects.length > 180) effects.splice(0, effects.length - 180);
}

// ---- Coordinate transforms (world <-> screen) ----------------------------
function viewSize() {
  const c = dom.canvas;
  return { w: c ? c.clientWidth : window.innerWidth, h: c ? c.clientHeight : window.innerHeight };
}
function worldToScreen(wx, wy) {
  const v = viewSize();
  return { x: (wx - camera.x) * camera.zoom + v.w / 2, y: (wy - camera.y) * camera.zoom + v.h / 2 };
}
function screenToWorld(sx, sy) {
  const v = viewSize();
  return { x: (sx - v.w / 2) / camera.zoom + camera.x, y: (sy - v.h / 2) / camera.zoom + camera.y };
}

function clampCamera(value = cameraTarget) {
  value.x = clamp(Number(value.x) || WORLD.w / 2, 0, WORLD.w);
  value.y = clamp(Number(value.y) || WORLD.h / 2, 0, WORLD.h);
  value.zoom = clamp(Number(value.zoom) || DEFAULT_ZOOM, MICRO_MIN_ZOOM, MICRO_MAX_ZOOM);
  return value;
}

function setCameraTarget(next) {
  cameraTarget = clampCamera({ ...cameraTarget, ...next });
}

function syncCameraTarget() {
  cameraTarget = clampCamera({ ...camera });
}

function updateCamera(dt) {
  const ease = 1 - Math.pow(0.0008, Math.min(0.08, dt));
  camera.x += (cameraTarget.x - camera.x) * ease;
  camera.y += (cameraTarget.y - camera.y) * ease;
  camera.zoom += (cameraTarget.zoom - camera.zoom) * ease;
  clampCamera(camera);
}

function updateSpectatorCamera(dt) {
  if (!spectatorMode) return;
  spectatorPhase += dt;
  const living = germs.filter((g) => g.state === "living" || g.state === "dormant");
  const focus = living.length ? living[Math.floor(spectatorPhase / 6) % living.length] : null;
  const orbit = spectatorPhase * 0.18;
  const center = focus ? { x: focus.x, y: focus.y } : DISH;
  setCameraTarget({
    x: center.x + Math.cos(orbit) * 180,
    y: center.y + Math.sin(orbit * 0.83) * 130,
    zoom: clamp(MICRO_WORLD_ZOOM + Math.sin(orbit * 0.7) * 0.12, MICRO_WORLD_ZOOM, 1.15),
  });
}

function toggleSpectatorMode() {
  spectatorMode = !spectatorMode;
  dom.panel?.classList.toggle("is-spectator", spectatorMode);
  dom.spectatorBtn?.classList.toggle("is-active", spectatorMode);
  if (spectatorMode) {
    setMicroMode("world", { announce: false });
    spectatorPhase = 0;
  }
  E.finishWork?.(spectatorMode ? "Spectator On" : "Spectator Off", "ok", spectatorMode ? "Auto camera enabled." : "Manual camera restored.");
}

function currentListeningRadius() {
  const v = viewSize();
  const visibleRadius = (Math.hypot(v.w, v.h) / 2) / Math.max(0.001, camera.zoom);
  return Math.round(visibleRadius * (microMode === "world" ? 0.72 : 1.08));
}

function setMicroMode(nextMode, opts = {}) {
  microMode = "world"; // Force always world mode
  const focus = opts.focus || selectedGerm() || selectedModule();
  const target = focus ? { x: focus.x, y: focus.y } : cameraTarget;
  setCameraTarget({
    x: target.x,
    y: target.y,
    zoom: microMode === "world" ? Math.max(cameraTarget.zoom, MICRO_WORLD_ZOOM) : MICRO_SCOPE_ZOOM,
  });
  dom.panel?.classList.toggle("is-deep", microMode === "world");
  updateHud();
  if (opts.announce !== false) {
    E?.finishWork?.(microMode === "world" ? "Entered Microcosmos World" : "Returned To Scope", "ok", microMode === "world" ? "Move the scope to listen through the world." : "Scope entry restored.");
  }
}

function toggleMicroMode() {
  setMicroMode(microMode === "world" ? "scope" : "world");
  saveDish();
}

// ---- Germ model ----------------------------------------------------------
function makeGerm({ assetId, x, y, genome, label, parents = [] }) {
  const visualTypes = MICRO_GERM_TYPES;
  return {
    id: uid("germ"),
    type: "sound", // lets the shared engine audio functions treat it as a sound node
    assetId,
    label: label || "germ",
    x, y,
    vx: (Math.random() - 0.5) * 0.4,
    vy: (Math.random() - 0.5) * 0.4,
    radius: GERM_MIN_R,
    state: "dormant", // spore | dormant | living | mutating | colliding | harvested
    loop: true,
    playbackRate: 1,
    volume: 0.85, // base gain before spatial falloff
    pan: 0,
    enabled: true,
    pulse: Math.random() * Math.PI * 2,
    visual: visualTypes[Math.floor(Math.random() * visualTypes.length)],
    trail: [],
    trailClock: 0,
    _mixGain: 0,
    _mixPan: 0,
    _audibility: 0,
    _visualAmp: 0,
    genome: genome || { words: [], traits: {} },
    parents,
    audio: null,
    audioGraph: null,
    _moduleDwell: {},
  };
}

function germTraitRadius(germ) {
  const t = germ.genome?.traits || {};
  const energy = Number(t.energy ?? t.amplitude_body ?? 0.4);
  return GERM_MIN_R + Math.max(0, Math.min(1, energy)) * (GERM_MAX_R - GERM_MIN_R);
}

function makeModule(type, x, y) {
  if (!MODULE_DEFS[type]) type = "magnet";
  const def = MODULE_DEFS[type];
  return {
    id: uid("module"),
    type,
    asset: MICRO_MODULE_ASSETS[type],
    x, y,
    radius: def.radius,
    state: "idle",
    pulse: Math.random() * Math.PI * 2,
    loop: true,
    params: {},
    cooldowns: {},
  };
}

function selectedModule() { return modules.find((m) => m.id === _selectedModuleId) || null; }

// ---- Audio: route germs through the shared engine / master bus -----------
function disconnectAudioGraph(graph) {
  (graph?.nodes || []).forEach((node) => {
    try { node.disconnect(); } catch {}
  });
}

function assetAudioUrl(asset) {
  return asset?.objectUrl || E.outputUrl(asset?.audioPath || asset?.storageUri);
}

function disposeGermAudio(germ) {
  if (!germ) return;
  try { germ.audio?.pause(); } catch {}
  disconnectAudioGraph(germ.audioGraph);
  germ.audioGraph = null;
  if (germ.audio) {
    germ.audio.src = "";
    germ.audio = null;
  }
}

function ensureGermAudio(germ) {
  if (!E || !germ?.assetId) return null;
  const context = E.playbackContext();
  const asset = E.assetById(germ.assetId);
  const sourceUrl = assetAudioUrl(asset);
  if (!context || !sourceUrl) return null;
  E.ensureMasterBus();
  if (germ.audioGraph?.context && germ.audioGraph.context !== context) disposeGermAudio(germ);
  if (germ.audio && germ.audio.dataset.sourceUrl !== sourceUrl) disposeGermAudio(germ);
  if (!germ.audio) {
    germ.audio = new Audio(sourceUrl);
    germ.audio.dataset.sourceUrl = sourceUrl;
    germ.audio.addEventListener("ended", () => {
      if (germ.loop && germ.state === "living") {
        germ.audio.currentTime = 0;
        attemptGermPlay(germ);
      }
    });
  }
  germ.audio.loop = Boolean(germ.loop);
  germ.audio.playbackRate = Number(germ.playbackRate) || 1;
  if (!germ.audioGraph) {
    try {
      const source = context.createMediaElementSource(germ.audio);
      const dry = context.createGain();
      const wet = context.createGain();
      const filter = context.createBiquadFilter();
      const gain = context.createGain();
      const panner = context.createStereoPanner ? context.createStereoPanner() : null;
      filter.type = "bandpass";
      filter.frequency.value = 1200;
      filter.Q.value = 0.9;
      dry.gain.value = 1;
      wet.gain.value = 0;
      source.connect(dry);
      source.connect(filter);
      filter.connect(wet);
      dry.connect(gain);
      wet.connect(gain);
      const busInput = E.masterBusInput?.() || E.ensureMasterBus()?.gain || context.destination;
      if (panner) {
        gain.connect(panner);
        panner.connect(busInput);
      } else {
        gain.connect(busInput);
      }
      germ.audioGraph = {
        context,
        source,
        dry,
        wet,
        filter,
        gain,
        panner,
        nodes: [source, dry, wet, filter, gain, panner].filter(Boolean),
      };
      germ.audio.volume = 1;
    } catch {
      germ.audioGraph = null;
    }
  }
  return germ.audio;
}

function applyGermFilter(germ, membrane) {
  const graph = germ.audioGraph;
  if (!graph?.filter || !graph?.wet || !graph?.dry) return;
  // Smoothed per-frame updates: germs drifting across a membrane sweep the
  // filter instead of stepping it (audible zipper before).
  const smooth = (param, value, tc = 0.045) => {
    if (E?.smoothSet) E.smoothSet(param, value, graph.context, tc);
    else param.value = value;
  };
  const amount = membrane?.amount || 0;
  smooth(graph.wet.gain, amount);
  smooth(graph.dry.gain, 1 - amount * 0.7);
  if (amount <= 0) return;
  const brightness = Math.max(0, Math.min(1, Number(germ.genome?.traits?.brightness ?? 0.5)));
  const density = Math.max(0, Math.min(1, Number(germ.genome?.traits?.density ?? 0.35)));
  const mode = membrane.mode || "bandpass";
  if (graph.filter.type !== mode) graph.filter.type = mode;
  smooth(graph.filter.frequency, membrane.frequency || (420 + brightness * 5200), 0.06);
  smooth(graph.filter.Q, membrane.q || (0.7 + density * 5), 0.06);
}

function attemptGermPlay(germ) {
  const audio = germ?.audio;
  if (!audio) return;
  const now = (typeof performance !== "undefined" && performance.now) ? performance.now() : Date.now();
  if (germ._playRetryAt && now < germ._playRetryAt) return;
  try {
    const play = audio.play();
    if (play?.catch) {
      play.catch(() => {
        germ._playRetryAt = now + 1500;
      });
    }
  } catch {
    germ._playRetryAt = now + 1500;
  }
}

async function setGermLiving(germ, living) {
  if (!E) return;
  if (living) {
    if (germ.state !== "living") germ._born = BIRTH_FRAMES; // bloom-in transition
    germ.state = "living";
    const context = E.playbackContext();
    if (context?.state === "suspended") {
      try { context.resume()?.catch?.(() => {}); } catch { /* gesture needed */ }
    }
    germ.loop = true; // Automatically loop when activated
    ensureGermAudio(germ);
    if (germ.audio) {
      germ.audio.loop = Boolean(germ.loop);
      if (germ.loop && (germ.audio.ended || germ.audio.currentTime >= germ.audio.duration - 0.05)) {
        germ.audio.currentTime = 0;
      }
      attemptGermPlay(germ);
    }
  } else {
    if (germ.audio) { try { germ.audio.pause(); } catch {} }
    germ.state = "dormant";
  }
}

// Per-frame spatial mix: distance from the microscope (camera centre) sets gain,
// horizontal offset sets pan, and only the nearest MAX_AUDIBLE_VOICES germs play.
function membraneForGerm(germ) {
  let best = null;
  for (const mod of modules) {
    if (mod.type !== "membrane") continue;
    const d = Math.hypot(germ.x - mod.x, germ.y - mod.y);
    if (d > mod.radius) continue;
    const amount = Math.max(0, Math.min(1, 1 - d / mod.radius));
    if (!best || amount > best.amount) {
      best = {
        amount: 0.25 + amount * 0.7,
        frequency: 360 + amount * 7600,
        q: 0.9 + amount * 6,
        mode: amount > 0.72 ? "bandpass" : "lowpass",
      };
    }
  }
  return best;
}

function harvestAllowsGerm(germ) {
  if (!harvestRec?.scope?.scoped) return true;
  return harvestRec.scope.germIds.has(germ.id);
}

function updateSpatialAudio(dt = 0.016) {
  if (!E) return;
  const v = viewSize();
  const audibleRadius = currentListeningRadius();
  const living = germs.filter((g) => g.state === "living");
  const scored = living.map((g) => {
    const dx = g.x - camera.x;
    const dy = g.y - camera.y;
    const dist = Math.hypot(dx, dy);
    const falloff = Math.max(0, 1 - dist / audibleRadius);
    const focus = Math.max(1, 1 + Number(g._lensFocus || 0) * 0.6);
    const scopeGain = harvestAllowsGerm(g) ? 1 : 0;
    return { g, dx, falloff, gain: g.volume * falloff * falloff * focus * scopeGain };
  });
  scored.sort((a, b) => b.gain - a.gain);
  const halfWorldW = (v.w / 2) / camera.zoom;
  const activeAudible = scored.filter((s, i) => i < MAX_AUDIBLE_VOICES && s.gain > 0.001).length;
  const compensation = activeAudible > 4 ? 1 / Math.sqrt(activeAudible / 4) : 1;
  const mixEase = 1 - Math.pow(0.0015, Math.min(0.08, dt));
  scored.forEach((s, i) => {
    const audible = i < MAX_AUDIBLE_VOICES && s.gain > 0.001;
    const g = s.g;
    const targetGain = audible ? s.gain * compensation : 0;
    const targetPan = clamp(s.dx / halfWorldW, -1, 1);
    g._mixGain = (g._mixGain ?? 0) + (targetGain - (g._mixGain ?? 0)) * mixEase;
    g._mixPan = (g._mixPan ?? 0) + (targetPan - (g._mixPan ?? 0)) * mixEase;
    g._audibility = audible ? s.falloff : Math.max(0, (g._audibility || 0) - dt * 2.2);
    const playhead = g.audio?.duration ? g.audio.currentTime / Math.max(0.001, g.audio.duration) : g.pulse * 0.05;
    const energy = Number(g.genome?.traits?.energy ?? 0.45);
    const pseudoAmp = audible ? (0.35 + 0.65 * Math.abs(Math.sin(playhead * Math.PI * 8 + g.pulse))) * energy : 0;
    g._visualAmp = (g._visualAmp ?? 0) + (pseudoAmp - (g._visualAmp ?? 0)) * mixEase;
    if (audible) {
      ensureGermAudio(g);
      if (g.audio) {
        if (g.loop && (g.audio.ended || g.audio.currentTime >= g.audio.duration - 0.05)) {
          g.audio.currentTime = 0;
        }
        if (g.audio.paused) attemptGermPlay(g);
      }
      if (g.audioGraph?.gain) {
        try { g.audioGraph.gain.gain.setTargetAtTime(g._mixGain, g.audioGraph.context.currentTime, 0.055); }
        catch { g.audioGraph.gain.gain.value = g._mixGain; }
      }
      if (g.audioGraph?.panner) {
        try { g.audioGraph.panner.pan.setTargetAtTime(g._mixPan, g.audioGraph.context.currentTime, 0.07); }
        catch { g.audioGraph.panner.pan.value = g._mixPan; }
      }
      applyGermFilter(g, membraneForGerm(g));
      g._audible = true;
    } else if (g._audible) {
      if (g.audioGraph?.gain) {
        try { g.audioGraph.gain.gain.setTargetAtTime(0, g.audioGraph.context.currentTime, 0.05); }
        catch { g.audioGraph.gain.gain.value = 0; }
      }
      applyGermFilter(g, null);
      // Cull: pause out-of-field voices to save CPU, but keep state "living".
      if (g._mixGain < 0.003) {
        if (g.audio && !g.audio.paused) { try { g.audio.pause(); } catch {} }
        g._audible = false;
      }
    }
  });
}

// ---- Physics -------------------------------------------------------------
function moduleForce(germ, mod) {
  const dx = mod.x - germ.x;
  const dy = mod.y - germ.y;
  const d = Math.hypot(dx, dy) || 0.001;
  if (d > mod.radius) return;
  const nx = dx / d;
  const ny = dy / d;
  const falloff = 1 - d / mod.radius;
  mod.state = falloff > 0.72 ? "active" : "triggered";
  if (mod.type === "magnet") {
    const pull = 0.08 * falloff;
    const orbit = 0.025 * falloff;
    germ.vx += nx * pull - ny * orbit;
    germ.vy += ny * pull + nx * orbit;
  } else if (mod.type === "repeller") {
    const push = 0.11 * falloff;
    germ.vx -= nx * push;
    germ.vy -= ny * push;
  } else if (mod.type === "membrane") {
    germ.vx *= 0.996 - falloff * 0.01;
    germ.vy *= 0.996 - falloff * 0.01;
  } else if (mod.type === "lens") {
    germ.vx += nx * 0.025 * falloff;
    germ.vy += ny * 0.025 * falloff;
    germ._lensFocus = Math.max(germ._lensFocus || 0, falloff);
  } else if (mod.type === "incubator" || mod.type === "harvester" || mod.type === "spore") {
    germ.vx *= 0.992 - falloff * 0.004;
    germ.vy *= 0.992 - falloff * 0.004;
  } else if (mod.type === "quarantine") {
    const damp = 0.988 - falloff * 0.02;
    germ.vx *= damp;
    germ.vy *= damp;
  } else if (mod.type === "gate") {
    germ.vx += 0.07 * falloff;
    germ.vy += Math.sin(germ.pulse) * 0.018 * falloff;
  } else if (mod.type === "pipe") {
    germ.vx += nx * 0.02 * falloff;
    germ.vy += ny * 0.02 * falloff;
  }
}

function handleModuleContact(germ, dt) {
  if (germ.state !== "living" || !germ.assetId) return;
  for (const mod of modules) {
    const d = Math.hypot(germ.x - mod.x, germ.y - mod.y);
    if (d > mod.radius) {
      if (germ._moduleDwell) germ._moduleDwell[mod.id] = 0;
      continue;
    }
    if (!["mutagen", "crystal", "incubator", "spore", "harvester", "pipe", "quarantine"].includes(mod.type)) continue;
    germ._moduleDwell = germ._moduleDwell || {};
    germ._moduleDwell[mod.id] = (germ._moduleDwell[mod.id] || 0) + dt;
    if (mod.type === "quarantine") {
      if (germ._infected > 0 || germ.state === "mutating") {
        germ.vx *= 0.9;
        germ.vy *= 0.9;
        germ._quarantined = 18;
      }
      continue;
    }
    if (germ._moduleDwell[mod.id] < 1.4) continue;
    germ._moduleDwell[mod.id] = 0;
    if ((mod.type === "mutagen" || mod.type === "crystal") && moduleTransformDepth(germ) < 1) {
      queueModuleTransform(germ, mod);
    } else if (mod.type === "incubator" || mod.type === "spore") {
      const key = `${mod.id}:${germ.id}:spore`;
      const now = performanceNow();
      if (now - (mod.cooldowns?.[key] || 0) > 11000 && germs.length < MAX_POPULATION) {
        mod.cooldowns[key] = now;
        sporeGerm(germ, { sourceModule: mod.type });
        pushEffect("spawn", germ.x, germ.y, { radius: germ.radius * 3, ttl: 0.8 });
      }
    } else if (mod.type === "harvester") {
      germ._harvested = 26;
      pushEffect("harvest", germ.x, germ.y, { radius: germ.radius * 2.4, ttl: 0.7 });
    } else if (mod.type === "pipe") {
      const key = `${mod.id}:${germ.id}:pipe`;
      const now = performanceNow();
      if (now - (mod.cooldowns?.[key] || 0) > 9000) {
        mod.cooldowns[key] = now;
        pipeGermToCanvas(germ, mod);
      }
    }
  }
}

function stepPhysics(dt) {
  const energy = ENERGY[energyLevel] ?? ENERGY.living;
  modules.forEach((mod) => {
    mod.state = "idle";
    if (mod.loop !== false) mod.pulse += dt * 1.8;
  });
  effects = effects
    .map((fx) => ({ ...fx, age: fx.age + dt }))
    .filter((fx) => fx.age < fx.ttl);
  for (const g of germs) {
    g.radius = germTraitRadius(g);
    g.pulse += dt * (g.state === "living" ? 2.2 : 0.6);
    g._lensFocus = 0;
    if (g === pointer.dragging) continue;
    if (g.state === "living") {
      g.vx += (Math.random() - 0.5) * energy * dt * 6;
      g.vy += (Math.random() - 0.5) * energy * dt * 6;
      if (gravity > 0) {
        g.vx += (WORLD.w / 2 - g.x) * gravity * dt * 0.003;
        g.vy += (WORLD.h / 2 - g.y) * gravity * dt * 0.003;
      }
      modules.forEach((mod) => moduleForce(g, mod));
    }
    g.vx *= viscosity;
    g.vy *= viscosity;
    g.x += g.vx * dt * 60;
    g.y += g.vy * dt * 60;
    // Soft wall bounce
    if (g.x < g.radius) { g.x = g.radius; g.vx = Math.abs(g.vx) * 0.6; }
    if (g.x > WORLD.w - g.radius) { g.x = WORLD.w - g.radius; g.vx = -Math.abs(g.vx) * 0.6; }
    if (g.y < g.radius) { g.y = g.radius; g.vy = Math.abs(g.vy) * 0.6; }
    if (g.y > WORLD.h - g.radius) { g.y = WORLD.h - g.radius; g.vy = -Math.abs(g.vy) * 0.6; }
    if (g.state === "living") {
      g.trailClock = (g.trailClock || 0) + dt;
      if (g.trailClock > 0.12) {
        g.trailClock = 0;
        g.trail = [...(g.trail || []), { x: g.x, y: g.y, age: 0 }].slice(-14);
      }
    }
    g.trail = (g.trail || []).map((p) => ({ ...p, age: p.age + dt })).filter((p) => p.age < 1.9);
    handleModuleContact(g, dt);
  }
  // Pairwise interactions: resonance (trait-similar germs drift together) + collisions.
  for (let i = 0; i < germs.length; i++) {
    for (let j = i + 1; j < germs.length; j++) {
      const a = germs[i], b = germs[j];
      const dx = b.x - a.x, dy = b.y - a.y;
      const d = Math.hypot(dx, dy) || 0.001;
      const nx = dx / d, ny = dy / d;
      const min = a.radius + b.radius;
      if (d < 320 && d > min) {
        const force = (traitSimilarity(a, b) - 0.5) * 0.02; // attract if similar, repel if not
        if (a !== pointer.dragging) { a.vx += nx * force; a.vy += ny * force; }
        if (b !== pointer.dragging) { b.vx -= nx * force; b.vy -= ny * force; }
      }
      if (d < min) {
        const push = (min - d) / min * 0.5;
        if (a !== pointer.dragging) { a.x -= nx * push; a.y -= ny * push; a.vx -= nx * 0.05; a.vy -= ny * 0.05; }
        if (b !== pointer.dragging) { b.x += nx * push; b.y += ny * push; b.vx += nx * 0.05; b.vy += ny * 0.05; }
        a._touch = b._touch = 6; // brief collide flash
        pushEffect("collision", (a.x + b.x) / 2, (a.y + b.y) / 2, { radius: min * 1.15, ttl: 0.7 });
        handleCollision(a, b);
      }
    }
  }
}

// ---- Phase 2: collision chemistry, resonance, breeding, spores -----------
function dedupeWords(words) { return [...new Set(words.filter(Boolean))]; }

function traitSimilarity(a, b) {
  const ta = a.genome?.traits || {}, tb = b.genome?.traits || {};
  const keys = ["brightness", "density", "energy"];
  let sum = 0;
  for (const k of keys) sum += Math.abs((ta[k] ?? 0.5) - (tb[k] ?? 0.5));
  return Math.max(0, 1 - sum / keys.length);
}

function moduleTransformDepth(germ) {
  const depth = Number(germ?.genome?.moduleDepth ?? 0);
  return Number.isFinite(depth) ? Math.max(0, depth) : 0;
}

function enqueueGeneration(label, work) {
  return new Promise((resolve, reject) => {
    generationQueue.push({ label, work, resolve, reject, epoch: generationEpoch });
    pumpGenerationQueue();
    updateHud();
  });
}

function pumpGenerationQueue() {
  if (generationActive >= GENERATION_MAX_CONCURRENT || !generationQueue.length) return;
  const now = performance.now();
  const wait = Math.max(0, GENERATION_COOLDOWN_MS - (now - lastBreedAt));
  if (wait > 0) {
    if (!generationTimer) {
      generationTimer = window.setTimeout(() => {
        generationTimer = null;
        pumpGenerationQueue();
      }, wait);
    }
    return;
  }
  const job = generationQueue.shift();
  if (!job) return;
  if (job.epoch !== generationEpoch) {
    job.resolve(null);
    pumpGenerationQueue();
    return;
  }
  generationActive += 1;
  lastBreedAt = performance.now();
  Promise.resolve()
    .then(() => (job.epoch === generationEpoch ? job.work(job.epoch) : null))
    .then(job.resolve, job.reject)
    .finally(() => {
      generationActive = Math.max(0, generationActive - 1);
      updateHud();
      pumpGenerationQueue();
    });
}

function isActiveGenerationChild(child, epoch) {
  return epoch === generationEpoch && germs.includes(child);
}

function handleCollision(a, b) {
  if (chemistry === "bounce") return;
  if (a.state !== "living" || b.state !== "living") return;
  const key = a.id < b.id ? `${a.id}|${b.id}` : `${b.id}|${a.id}`;
  const now = performance.now();
  const last = pairCooldown.get(key) || 0;
  if (pairCooldown.size > 512) {
    for (const [pair, at] of pairCooldown) {
      if (now - at > BREED_COOLDOWN_MS * 4) pairCooldown.delete(pair);
    }
  }
  if (chemistry === "infect") {
    if (now - last < 1500) return;
    pairCooldown.set(key, now);
    infect(a, b);
  } else if (chemistry === "breed") {
    if (now - last < BREED_COOLDOWN_MS || generationQueue.length > 3) return;
    pairCooldown.set(key, now);
    queueBreed(a, b);
  }
}

// Infection: germs exchange a prompt-genome word (no audio call — changes the
// next mutation/breed). Brief ripple marks the contamination.
function infect(a, b) {
  const aw = a.genome?.words || [], bw = b.genome?.words || [];
  if (!aw.length || !bw.length) return;
  const wa = aw[Math.floor(Math.random() * aw.length)];
  const wb = bw[Math.floor(Math.random() * bw.length)];
  a.genome.words = dedupeWords([...aw, wb]).slice(-6);
  b.genome.words = dedupeWords([...bw, wa]).slice(-6);
  a._touch = b._touch = 12;
  a._infected = b._infected = 18;
  pushEffect("infect", (a.x + b.x) / 2, (a.y + b.y) / 2, { radius: a.radius + b.radius + 36, ttl: 0.8 });
}

// Spore: duplicate a germ (same audio, inherited genome) — alt/option-click.
function sporeGerm(g, opts = {}) {
  if (!g.assetId) return;
  if (germs.length >= MAX_POPULATION) {
    E.finishWork("Microcosmos Full", "muted", `Population limit ${MAX_POPULATION}. Harvest or pipe sources before spawning more.`);
    return;
  }
  const child = makeGerm({
    assetId: g.assetId,
    x: g.x + g.radius * 2.2,
    y: g.y + (Math.random() - 0.5) * 30,
    label: g.label,
    genome: { ...g.genome, words: [...(g.genome?.words || [])], traits: { ...(g.genome?.traits || {}) } },
    parents: [g.assetId],
  });
  germs.push(child);
  child.state = "living";
  setGermLiving(child, true);
  pushEffect("spawn", child.x, child.y, { radius: child.radius * 2.5, ttl: 0.75 });
  if (opts.sourceModule) E.finishWork("Spore Split", "ok", MODULE_DEFS[opts.sourceModule]?.label || "Spore");
  saveDish();
}

// Breeding: mix two parents and run audio-to-audio into a child germ. Queued and
// cooldown-gated so collisions never trigger a generation storm.
async function queueBreed(a, b) {
  if (germs.length >= MAX_POPULATION) return;
  const child = makeGerm({
    assetId: null,
    x: (a.x + b.x) / 2,
    y: (a.y + b.y) / 2 + 12,
    label: "hybrid",
    genome: { words: dedupeWords([...(a.genome?.words || []), ...(b.genome?.words || [])]).slice(0, 6), traits: {} },
    parents: [a.assetId, b.assetId].filter(Boolean),
  });
  child.state = "mutating";
  germs.push(child);
  pushEffect("breed", child.x, child.y, { radius: (a.radius + b.radius) * 1.5 + 40, ttl: 1.1 });
  enqueueGeneration("breed", async (epoch) => {
    if (!isActiveGenerationChild(child, epoch)) return;
    try {
      await breedGerms(a, b, child, epoch);
      if (isActiveGenerationChild(child, epoch)) saveDish();
    } catch (error) {
      germs = germs.filter((g) => g !== child);
      E.finishWork("Breed Error", "bad", error.message);
    }
  });
}

async function breedGerms(a, b, child, epoch = generationEpoch) {
  const aAsset = E.assetById(a.assetId), bAsset = E.assetById(b.assetId);
  if (!aAsset || !bAsset) throw new Error("parent germs have no audio");
  const blob = await mixAssetsToWav([aAsset, bAsset]);
  if (!isActiveGenerationChild(child, epoch)) return;
  const words = child.genome.words;
  const prompt = `hybrid one-shot combining ${(a.genome?.words || []).join(" ")} with ${(b.genome?.words || []).join(" ")}, close microphone, controlled decay, no voice, no music`;
  // Curated payload (provider/model come from current settings). Audio-to-audio
  // validates a tighter schema than text generation, so we send only the fields
  // it needs rather than the Chamber's full generation payload.
  const base = E.buildPayload({});
  const payload = {
    provider: base.provider,
    model: base.model,
    prompt,
    negative_prompt: "voice, singing, melody, music",
    duration: 2,
    init_noise_level: 0.55,
      operation: "collision_breed",
      output_name: `microcosmos_hybrid_${words.slice(0, 3).join("_")}`,
    transient_upload: true,
    lineage: { operation: "collision_breed", source_type: "microcosmos", mode: "microcosmos", parents: child.parents, prompt_genome: words, microcosmos_position: { x: Math.round(child.x), y: Math.round(child.y) } },
  };
  const result = await E.api("/audio-to-audio", { method: "POST", body: payloadToForm(payload, blob, "microcosmos_breed.wav") });
  if (!isActiveGenerationChild(child, epoch)) return;
  const audioPath = result?.audio_files?.[0];
  if (!audioPath) throw new Error(result?.error || "breed returned no audio");
  const asset = E.createAsset({ audioPath, metadataPath: result.metadata_files?.[0], metadata: { prompt, mode: "microcosmos", operation: "collision_breed", parents: child.parents, microcosmos_position: { x: Math.round(child.x), y: Math.round(child.y) } }, origin: "microcosmos", parentAssetIds: child.parents });
  child.assetId = asset.id;
  child.state = "dormant";
  child.label = "hybrid";
  child.genome.traits = await profileTraits(audioPath, result.metadata_files?.[0]);
  if (!isActiveGenerationChild(child, epoch)) return;
  await setGermLiving(child, true);
  child.state = "living";
  E.finishWork("Bred", "ok", prompt);
}

function transformPrompt(germ, mod) {
  const words = (germ.genome?.words || []).join(" ") || germ.label || "microscopic sound matter";
  if (mod.type === "crystal") {
    return `granular crystalline branch of ${words}, tiny bright fragments, glassy resonant grains, close microphone, no voice, no music`;
  }
  return `mutated microscopic variation of ${words}, unstable organic texture, controlled decay, close microphone, no voice, no music`;
}

function queueModuleTransform(germ, mod) {
  if (germs.length >= MAX_POPULATION) return;
  const key = `${mod.id}:${germ.id}:${mod.type}`;
  const now = performance.now();
  mod.transformKeys = mod.transformKeys || new Set();
  if (mod.transformKeys.has(key)) return;
  if (now - (mod.cooldowns?.[key] || 0) < MODULE_TRIGGER_COOLDOWN_MS) return;
  if (generationQueue.length > 4) return;
  mod.cooldowns = mod.cooldowns || {};
  mod.cooldowns[key] = now;
  mod.transformKeys.add(key);
  const label = mod.type === "crystal" ? "crystal branch" : "mutant";
  const child = makeGerm({
    assetId: null,
    x: germ.x + (Math.random() - 0.5) * mod.radius * 0.35,
    y: germ.y + (Math.random() - 0.5) * mod.radius * 0.35,
    label,
    genome: {
      words: dedupeWords([...(germ.genome?.words || []), mod.type]).slice(-6),
      recipe: germ.genome?.recipe || "texture",
      traits: { ...(germ.genome?.traits || {}) },
      moduleDepth: moduleTransformDepth(germ) + 1,
    },
    parents: [germ.assetId].filter(Boolean),
  });
  child.state = "mutating";
  germs.push(child);
  enqueueGeneration(mod.type, async (epoch) => {
    if (!isActiveGenerationChild(child, epoch)) return;
    try {
      await transformGermWithModule(germ, mod, child, epoch);
      if (isActiveGenerationChild(child, epoch)) saveDish();
    } catch (error) {
      mod.transformKeys?.delete(key);
      germs = germs.filter((g) => g !== child);
      E.finishWork(`${MODULE_DEFS[mod.type]?.label || "Module"} Error`, "bad", error.message);
    }
  });
}

async function transformGermWithModule(germ, mod, child, epoch = generationEpoch) {
  const asset = E.assetById(germ.assetId);
  const inputPath = asset?.audioPath || asset?.storageUri;
  if (!inputPath || /^(blob:|data:|https?:\/\/)/i.test(inputPath)) {
    throw new Error("module transform needs a saved audio source");
  }
  const base = E.buildPayload({});
  const prompt = transformPrompt(germ, mod);
  const operation = mod.type === "crystal" ? "microcosmos_crystal" : "microcosmos_mutate";
  const payload = {
    provider: base.provider,
    model: base.model,
    prompt,
    negative_prompt: "voice, singing, melody, full song",
    input_audio_path: inputPath,
    duration: mod.type === "crystal" ? 2.5 : 3,
    init_noise_level: mod.type === "crystal" ? 0.68 : 0.5,
    operation,
    output_name: `microcosmos_${mod.type}_${(child.genome?.words || []).slice(0, 3).join("_")}`,
    lineage: {
      operation,
      source_type: "microcosmos",
      mode: "microcosmos",
      parents: child.parents,
      prompt_genome: child.genome?.words || [],
      microcosmos_position: { x: Math.round(child.x), y: Math.round(child.y) },
      module: { id: mod.id, type: mod.type },
    },
  };
  const result = await E.api("/audio-to-audio", { method: "POST", body: JSON.stringify(payload) });
  if (!isActiveGenerationChild(child, epoch)) return;
  const audioPath = result?.audio_files?.[0];
  if (!audioPath) throw new Error(result?.error || "module transform returned no audio");
  const newAsset = E.createAsset({ audioPath, metadataPath: result.metadata_files?.[0], metadata: { prompt, mode: "microcosmos", operation, parents: child.parents, microcosmos_position: { x: Math.round(child.x), y: Math.round(child.y) }, module: { id: mod.id, type: mod.type } }, origin: "microcosmos", parentAssetIds: child.parents });
  child.assetId = newAsset.id;
  child.state = "dormant";
  child.label = child.label || MODULE_DEFS[mod.type]?.label || "module child";
  child.genome.traits = await profileTraits(audioPath, result.metadata_files?.[0]);
  if (!isActiveGenerationChild(child, epoch)) return;
  await setGermLiving(child, true);
  child.state = "living";
  E.finishWork(MODULE_DEFS[mod.type]?.label || "Module", "ok", prompt);
}

function payloadToForm(payload, blob, filename) {
  const form = new FormData();
  // Reuse the Chamber's proven multipart encoder so complex fields (lineage,
  // lora, ranges, …) are encoded exactly as the server's coerce_form_value expects.
  E.appendPayloadToForm(form, payload);
  form.append("file", new File([blob], filename, { type: blob.type || "audio/wav" }));
  return form;
}

async function decodeAsset(asset) {
  const url = asset.objectUrl || E.outputUrl(asset.audioPath || asset.storageUri);
  const resp = await fetch(url);
  const buf = await resp.arrayBuffer();
  return E.playbackContext().decodeAudioData(buf);
}

async function mixAssetsToWav(assets) {
  const buffers = await Promise.all(assets.map(decodeAsset));
  const length = Math.max(...buffers.map((b) => Math.ceil(b.duration * TARGET_SAMPLE_RATE)));
  const offline = new OfflineAudioContext(2, length, TARGET_SAMPLE_RATE);
  for (const b of buffers) {
    const src = offline.createBufferSource();
    src.buffer = b;
    const g = offline.createGain();
    g.gain.value = 1 / assets.length;
    src.connect(g);
    g.connect(offline.destination);
    src.start(0);
  }
  return encodeWav(await offline.startRendering());
}

function encodeWav(audioBuffer) {
  const numCh = 2;
  const sr = audioBuffer.sampleRate;
  const frames = audioBuffer.length;
  const chans = [];
  for (let c = 0; c < numCh; c++) chans.push(audioBuffer.getChannelData(Math.min(c, audioBuffer.numberOfChannels - 1)));
  const blockAlign = numCh * 2;
  const dataSize = frames * blockAlign;
  const buffer = new ArrayBuffer(44 + dataSize);
  const view = new DataView(buffer);
  const writeStr = (off, s) => { for (let i = 0; i < s.length; i++) view.setUint8(off + i, s.charCodeAt(i)); };
  writeStr(0, "RIFF"); view.setUint32(4, 36 + dataSize, true); writeStr(8, "WAVE");
  writeStr(12, "fmt "); view.setUint32(16, 16, true); view.setUint16(20, 1, true);
  view.setUint16(22, numCh, true); view.setUint32(24, sr, true);
  view.setUint32(28, sr * blockAlign, true); view.setUint16(32, blockAlign, true); view.setUint16(34, 16, true);
  writeStr(36, "data"); view.setUint32(40, dataSize, true);
  let off = 44;
  for (let i = 0; i < frames; i++) {
    for (let c = 0; c < numCh; c++) {
      const s = Math.max(-1, Math.min(1, chans[c][i]));
      view.setInt16(off, s < 0 ? s * 0x8000 : s * 0x7fff, true);
      off += 2;
    }
  }
  return new Blob([view], { type: "audio/wav" });
}

// ---- Rendering -----------------------------------------------------------
function isDark() {
  return document.documentElement.getAttribute("data-theme") === "dark";
}
function resizeCanvas() {
  const c = dom.canvas;
  if (!c) return;
  dpr = Math.min(2, window.devicePixelRatio || 1);
  const w = c.clientWidth || window.innerWidth;
  const h = c.clientHeight || window.innerHeight;
  c.width = Math.round(w * dpr);
  c.height = Math.round(h * dpr);
  ctx2d = c.getContext("2d");
  microRenderer?.clear();
}

function drawCrosshair(x, y, len, color) {
  ctx2d.strokeStyle = color;
  ctx2d.lineWidth = 1;
  ctx2d.beginPath();
  ctx2d.moveTo(x - len, y); ctx2d.lineTo(x - len * 0.3, y);
  ctx2d.moveTo(x + len * 0.3, y); ctx2d.lineTo(x + len, y);
  ctx2d.moveTo(x, y - len); ctx2d.lineTo(x, y - len * 0.3);
  ctx2d.moveTo(x, y + len * 0.3); ctx2d.lineTo(x, y + len);
  ctx2d.stroke();
}

function unicodeTick(name, speed = 10, phase = 0) {
  const t = (microRenderer ? microRenderer.time : 0) * 0.001;
  return Math.floor(t * speed + phase);
}

function unicodeGlyph(name, speed = 10, phase = 0) {
  return unicodeFrame(name, unicodeTick(name, speed, phase));
}

function drawUnicodeText(text, x, y, opts = {}) {
  const ink = opts.ink ?? (isDark() ? 244 : 17);
  const alpha = opts.alpha ?? 1;
  const size = opts.size ?? 14;
  if (!text || alpha <= 0 || size <= 0) return;
  ctx2d.save();
  ctx2d.translate(x, y);
  if (opts.rotation) ctx2d.rotate(opts.rotation);
  ctx2d.globalAlpha *= alpha;
  ctx2d.fillStyle = `rgba(${ink},${ink},${ink},1)`;
  ctx2d.font = `${size}px "SF Mono", "Cascadia Mono", Menlo, Consolas, monospace`;
  ctx2d.textAlign = opts.align || "center";
  ctx2d.textBaseline = opts.baseline || "middle";
  ctx2d.fillText(String(text), 0, 0);
  ctx2d.restore();
}

function drawUnicodeRing(cx, cy, radius, animation, opts = {}) {
  const count = opts.count || 16;
  const ink = opts.ink ?? (isDark() ? 244 : 17);
  const size = opts.size || Math.max(8, Math.min(18, radius * 0.06));
  const alpha = opts.alpha ?? 0.5;
  const spin = opts.spin || 0;
  for (let i = 0; i < count; i++) {
    const a = spin + (Math.PI * 2 * i) / count;
    const glyph = unicodeFrame(animation, unicodeTick(animation, opts.speed || 8, i));
    drawUnicodeText(glyph, cx + Math.cos(a) * radius, cy + Math.sin(a) * radius, {
      ink,
      size,
      alpha: alpha * (0.7 + (i % 3) * 0.12),
      rotation: opts.rotateGlyphs ? a + Math.PI / 2 : 0,
    });
  }
}

// Graduated dial ticks just inside a ring — a measuring-instrument feel.
function drawDialTicks(cx, cy, rad, z, stroke) {
  const minor = 48, perMajor = 6;
  for (let i = 0; i < minor; i++) {
    const a = (Math.PI * 2 * i) / minor;
    const isMajor = i % perMajor === 0;
    const len = (isMajor ? 12 : 5) * z;
    ctx2d.strokeStyle = stroke(isMajor ? 0.7 : 0.32);
    ctx2d.lineWidth = isMajor ? Math.max(1, 1.4 * z) : 1;
    ctx2d.beginPath();
    ctx2d.moveTo(cx + Math.cos(a) * (rad - len), cy + Math.sin(a) * (rad - len));
    ctx2d.lineTo(cx + Math.cos(a) * rad, cy + Math.sin(a) * rad);
    ctx2d.stroke();
  }
}

// Camera-aperture corner brackets framing the whole viewport (screen space).
function drawApertureFrame(ink) {
  const v = viewSize();
  const m = 22, k = 26;
  const t = (microRenderer ? microRenderer.time : 0) * 0.001;
  const alphaPulse = 0.5 + Math.sin(t * 1.2) * 0.08;
  ctx2d.save();
  ctx2d.lineWidth = 1.5;
  const corners = [[m, m, 1, 1], [v.w - m, m, -1, 1], [m, v.h - m, 1, -1], [v.w - m, v.h - m, -1, -1]];
  // Faint connecting lines between adjacent brackets
  ctx2d.strokeStyle = `rgba(${ink},${ink},${ink},0.08)`;
  ctx2d.lineWidth = 1;
  ctx2d.beginPath();
  ctx2d.moveTo(m + k, m); ctx2d.lineTo(v.w - m - k, m);
  ctx2d.moveTo(v.w - m, m + k); ctx2d.lineTo(v.w - m, v.h - m - k);
  ctx2d.moveTo(v.w - m - k, v.h - m); ctx2d.lineTo(m + k, v.h - m);
  ctx2d.moveTo(m, v.h - m - k); ctx2d.lineTo(m, m + k);
  ctx2d.stroke();
  // Corner brackets with alpha pulse
  ctx2d.strokeStyle = `rgba(${ink},${ink},${ink},${alphaPulse})`;
  ctx2d.lineWidth = 1.5;
  for (const [x, y, dx, dy] of corners) {
    ctx2d.beginPath();
    ctx2d.moveTo(x, y + dy * k);
    ctx2d.lineTo(x, y);
    ctx2d.lineTo(x + dx * k, y);
    ctx2d.stroke();
    // Small perpendicular tick marks
    const tk = 5;
    ctx2d.beginPath();
    ctx2d.moveTo(x + dx * 6, y); ctx2d.lineTo(x + dx * 6, y + dy * tk);
    ctx2d.moveTo(x + dx * 12, y); ctx2d.lineTo(x + dx * 12, y + dy * tk);
    ctx2d.moveTo(x, y + dy * 6); ctx2d.lineTo(x + dx * tk, y + dy * 6);
    ctx2d.stroke();
  }
  ctx2d.restore();
}

function drawPetriFrame(dark) {
  const c = worldToScreen(DISH.x, DISH.y);
  const r = DISH.radius * camera.zoom;
  const ink = dark ? 244 : 17;
  const z = camera.zoom;
  const t = (microRenderer ? microRenderer.time : 0) * 0.001;
  const stroke = (a) => `rgba(${ink},${ink},${ink},${a})`;
  ctx2d.save();
  if (microMode === "scope") {
    const grad = ctx2d.createRadialGradient(c.x, c.y, Math.max(1, r * 0.1), c.x, c.y, Math.max(1, r * 1.04));
    grad.addColorStop(0, stroke(0.02));
    grad.addColorStop(0.82, stroke(0.035));
    grad.addColorStop(1, stroke(0.16));
    ctx2d.fillStyle = grad;
    ctx2d.beginPath();
    ctx2d.arc(c.x, c.y, r, 0, Math.PI * 2);
    ctx2d.fill();
    ctx2d.strokeStyle = stroke(0.88);
    ctx2d.lineWidth = Math.max(1.4, 3 * z);
    ctx2d.beginPath();
    ctx2d.arc(c.x, c.y, r, 0, Math.PI * 2);
    ctx2d.stroke();
    ctx2d.lineWidth = Math.max(1, 1.6 * z);
    ctx2d.beginPath();
    ctx2d.arc(c.x, c.y, r - 13 * z, 0, Math.PI * 2);
    ctx2d.stroke();
    // slowly rotating orbital ring
    ctx2d.setLineDash([2 * z, 12 * z]);
    ctx2d.lineDashOffset = -t * 18 * z;
    ctx2d.globalAlpha = 0.55;
    ctx2d.beginPath();
    ctx2d.arc(c.x, c.y, r - 58 * z, 0, Math.PI * 2);
    ctx2d.stroke();
    // second counter-rotating dashed orbital ring
    ctx2d.setLineDash([3 * z, 8 * z]);
    ctx2d.lineDashOffset = t * 14 * z;
    ctx2d.globalAlpha = 0.35;
    ctx2d.beginPath();
    ctx2d.arc(c.x, c.y, r * 0.72, 0, Math.PI * 2);
    ctx2d.stroke();
    ctx2d.setLineDash([]);
    ctx2d.globalAlpha = 1;
    // Cardinal tick clusters at N/E/S/W
    ctx2d.strokeStyle = stroke(0.5);
    ctx2d.lineWidth = Math.max(1, 1.2 * z);
    const tickR = r - 6 * z;
    for (let dir = 0; dir < 4; dir++) {
      const baseA = (Math.PI / 2) * dir;
      for (let j = -1; j <= 1; j++) {
        const a = baseA + j * 0.03;
        const len = (j === 0 ? 14 : 8) * z;
        ctx2d.beginPath();
        ctx2d.moveTo(c.x + Math.cos(a) * (tickR - len), c.y + Math.sin(a) * (tickR - len));
        ctx2d.lineTo(c.x + Math.cos(a) * tickR, c.y + Math.sin(a) * tickR);
        ctx2d.stroke();
      }
    }
    drawDialTicks(c.x, c.y, r - 6 * z, z, stroke);
    drawCrosshair(c.x, c.y, 9 * z, stroke(0.4));
    drawUnicodeRing(c.x, c.y, r - 34 * z, "orbit", {
      ink,
      alpha: 0.22,
      count: 32,
      size: Math.max(7, Math.min(14, 9 * z)),
      speed: 5,
      spin: t * 0.18,
      rotateGlyphs: true,
    });
    drawUnicodeRing(c.x, c.y, r * 0.72, "scanline", {
      ink,
      alpha: 0.16,
      count: 20,
      size: Math.max(6, Math.min(12, 7 * z)),
      speed: 4,
      spin: -t * 0.12,
    });
    // Subtle vignette: darker radial gradient from 0.7r outward
    const vig = ctx2d.createRadialGradient(c.x, c.y, Math.max(1, r * 0.7), c.x, c.y, Math.max(1, r));
    vig.addColorStop(0, 'rgba(0,0,0,0)');
    vig.addColorStop(1, 'rgba(0,0,0,0.15)');
    ctx2d.fillStyle = vig;
    ctx2d.beginPath();
    ctx2d.arc(c.x, c.y, r, 0, Math.PI * 2);
    ctx2d.fill();
  } else {
    const v = viewSize();
    const cx = v.w / 2;
    const cy = v.h / 2;
    const listening = currentListeningRadius() * camera.zoom;
    // Camera-center radial gradient (very faint focus point)
    const focGrad = ctx2d.createRadialGradient(cx, cy, 0, cx, cy, Math.max(1, listening));
    focGrad.addColorStop(0, stroke(0.06));
    focGrad.addColorStop(1, 'rgba(0,0,0,0)');
    ctx2d.fillStyle = focGrad;
    ctx2d.fillRect(0, 0, v.w, v.h);
    ctx2d.lineWidth = 1;
    ctx2d.setLineDash([2, 10]);
    for (let i = 1; i <= 3; i++) {
      const ringAlpha = 0.24 - i * 0.04;
      ctx2d.strokeStyle = stroke(ringAlpha);
      ctx2d.lineDashOffset = -t * 12 * (i % 2 === 0 ? -1 : 1);
      ctx2d.beginPath();
      ctx2d.arc(cx, cy, listening * (i / 3), 0, Math.PI * 2);
      ctx2d.stroke();
    }
    ctx2d.setLineDash([]);
    drawCrosshair(cx, cy, 18, stroke(0.56));
    drawUnicodeRing(cx, cy, listening * 0.75, "braillewave", {
      ink,
      alpha: 0.22,
      count: 18,
      size: 10,
      speed: 6,
      spin: t * 0.18,
      rotateGlyphs: true,
    });
  }
  ctx2d.restore();
}

function drawWorldTexture(dark) {
  const ink = dark ? 244 : 17;
  const v = viewSize();
  ctx2d.save();
  const unicodeParticleCount = camera.zoom < 0.35 ? 90 : 190;
  for (let i = 0; i < unicodeParticleCount; i++) {
    const x = (i * 487 + 211) % WORLD.w;
    const y = (i * 307 + 97) % WORLD.h;
    const s = worldToScreen(x, y);
    const d = Math.hypot(x - DISH.x, y - DISH.y);
    if (microMode === "scope" && d > DISH.radius + 120) continue;
    if (s.x < -20 || s.x > v.w + 20 || s.y < -20 || s.y > v.h + 20) continue;
    const isFg = (i % 4) === 0;
    const animation = i % 9 === 0 ? "rain" : i % 7 === 0 ? "sparkle" : i % 5 === 0 ? "scan" : "braille";
    const glyph = unicodeFrame(animation, unicodeTick(animation, isFg ? 4 : 2, i));
    drawUnicodeText(glyph, s.x, s.y, {
      ink,
      size: Math.max(5, ((i % 5) + 6) * (isFg ? 1.05 : 0.72)),
      alpha: isFg ? 0.42 : 0.2,
    });
  }
  ctx2d.restore();
}

const FX_ANIMATIONS = {
  spawn: "fillsweep",
  collision: "sparkle",
  infect: "rain",
  breed: "dna",
  harvest: "columns",
  module: "orbit",
  pipe: "braillewave",
  disperse: "cascade",
};

function drawEffect(fx, dark) {
  const p = clamp(fx.age / fx.ttl, 0, 1);
  const s = worldToScreen(fx.x, fx.y);
  const ink = dark ? 244 : 17;
  const z = camera.zoom;
  const baseR = fx.radius * z;
  const fade = 1 - p;
  const fxAnimation = FX_ANIMATIONS[fx.type] || "pulse";
  const centerGlyph = unicodeFrame(fxAnimation, Math.floor(p * 18 + unicodeTick(fxAnimation, 3)));
  const size = Math.max(9, Math.min(28, baseR * 0.26));
  drawUnicodeText(centerGlyph, s.x, s.y, { ink, size, alpha: Math.min(0.92, 0.22 + fade * 0.7) });
  drawUnicodeRing(s.x, s.y, baseR * (0.32 + p * 0.78), fxAnimation, {
    ink,
    alpha: 0.58 * fade,
    count: fx.type === "collision" || fx.type === "spawn" ? 12 : 8,
    size: Math.max(6, Math.min(18, baseR * 0.12)),
    speed: 14,
    spin: p * Math.PI * 2,
    rotateGlyphs: true,
  });
  if (fx.type === "breed" || fx.type === "infect" || fx.type === "harvest") {
    drawUnicodeRing(s.x, s.y, baseR * (0.18 + p * 0.46), fx.type === "breed" ? "helix" : "scanline", {
      ink,
      alpha: 0.36 * fade,
      count: 6,
      size: Math.max(6, Math.min(13, baseR * 0.09)),
      speed: 10,
      spin: -p * Math.PI,
    });
  }
}

const MODULE_FIELD_ANIMATIONS = {
  crystal: "sparkle",
  membrane: "checkerboard",
  mutagen: "rain",
  incubator: "breathe",
  harvester: "columns",
  magnet: "orbit",
  lens: "scan",
  repeller: "pulse",
  quarantine: "checkerboard",
  gate: "diagswipe",
  spore: "cascade",
  pipe: "braillewave",
};

// The module's field of influence: Unicode/Braille orbit rings from the
// unicode-animations pack, drawn directly because radius and zoom vary widely.
function drawModuleField(s, r, ink, mod, active, hovered) {
  const pulse = mod.pulse || 0;
  const animation = MODULE_FIELD_ANIMATIONS[mod.type] || "braille";
  const baseAlpha = active ? 0.24 : 0.11;
  const spin = pulse * (active ? 0.22 : 0.08);
  drawUnicodeRing(s.x, s.y, r, animation, {
    ink,
    alpha: baseAlpha,
    count: active ? 18 : 12,
    size: Math.max(6, Math.min(12, r * 0.04)),
    speed: active ? 10 : 5,
    spin,
    rotateGlyphs: true,
  });
  if (hovered) {
    drawUnicodeRing(s.x, s.y, r * 0.82, "scanline", {
      ink,
      alpha: 0.18,
      count: 8,
      size: Math.max(6, Math.min(10, r * 0.03)),
      speed: 12,
    });
  }
}

function drawModule(mod, dark) {
  const s = worldToScreen(mod.x, mod.y);
  const r = mod.radius * camera.zoom;
  const ink = dark ? 230 : 35;
  const hovered = mod.id === _hoveredModuleId;
  const selected = mod === selectedModule();
  const active = mod.state === "active" || mod.state === "triggered" || selected || hovered;
  const glyph = Math.max(14, Math.min(42, r * 0.2 * Number(mod.asset?.scale || 1)));
  ctx2d.save();

  // Field of influence (direct, animated).
  drawModuleField(s, r, ink, mod, active, hovered);

  // Detailed vessel/instrument — cached sprite (see micro_forms.js).
  // Compute animation frame from pulse, similar to germ frame cycling.
  const vp = moduleVesselParams(mod, glyph);
  const drew = microRenderer?.blitForm(MODULE_FORMS, mod.type, vp.halfPx, s.x, s.y, vp.params, { scale: vp.scale });
  if (!drew) {
    ctx2d.fillStyle = `rgba(${ink},${ink},${ink},${active ? 0.8 : 0.5})`;
    ctx2d.beginPath();
    ctx2d.arc(s.x, s.y, glyph * 0.5, 0, Math.PI * 2);
    ctx2d.fill();
  }

  if (selected) {
    drawUnicodeText(unicodeGlyph("scan", 8, mod.id.length), s.x, s.y - glyph * 1.7, {
      ink,
      alpha: 0.34,
      size: Math.max(8, Math.min(14, glyph * 0.42)),
    });
  }
  ctx2d.restore();
}

function drawGermSprite(g, dark) {
  const s = worldToScreen(g.x, g.y);
  const profile = MICRO_GERM_ASSETS[g.visual] || MICRO_GERM_ASSETS.drifter;
  const r = g.radius * camera.zoom * (profile.scale || 1);
  const living = g.state === "living";
  const mutating = g.state === "mutating";
  const ink = dark ? 244 : 17;
  const paper = dark ? 16 : 251;
  const amp = clamp(Number(g._visualAmp || 0), 0, 1);
  const audibility = clamp(Number(g._audibility || 0), 0, 1);
  const hovered = g.id === _hoveredGermId;
  const pulse = living ? 1 + Math.sin(g.pulse) * 0.045 + amp * 0.11 : 1;
  // Lifecycle polish: bloom-in on birth, brief squash on collision.
  let bodyScale = pulse;
  let birthGlow = 0;
  if (g._born > 0) {
    const bp = 1 - g._born / BIRTH_FRAMES;
    bodyScale *= 0.35 + 0.65 * (1 - Math.pow(1 - bp, 3));
    birthGlow = 1 - bp;
    g._born -= 1;
  }
  if (g._touch > 0) bodyScale *= 1 - 0.1 * (g._touch / 12);
  ctx2d.save();
  ctx2d.strokeStyle = `rgba(${ink},${ink},${ink},${living ? 0.86 : 0.54})`;
  ctx2d.fillStyle = living ? `rgba(${ink},${ink},${ink},${0.78 + amp * 0.2})` : `rgba(${paper},${paper},${paper},0.7)`;
  ctx2d.lineWidth = Math.max(1, 1.4 * camera.zoom);

  // Skip trail when camera zoom is very low (performance)
  if (g.trail?.length > 1 && camera.zoom >= 0.3) {
    ctx2d.save();
    ctx2d.setLineDash([2, 6]);
    ctx2d.strokeStyle = `rgba(${ink},${ink},${ink},0.32)`;
    ctx2d.beginPath();
    g.trail.forEach((p, index) => {
      const tp = worldToScreen(p.x, p.y);
      if (index === 0) ctx2d.moveTo(tp.x, tp.y);
      else ctx2d.lineTo(tp.x, tp.y);
    });
    ctx2d.stroke();
    ctx2d.restore();
  }

  if (living || g._audible || hovered) {
    ctx2d.save();
    ctx2d.setLineDash([3, 5]);
    ctx2d.globalAlpha = hovered ? 0.82 : living ? 0.32 + audibility * 0.26 + amp * 0.22 : 0.25;
    ctx2d.beginPath();
    ctx2d.arc(s.x, s.y, r * (1.5 + Math.sin(g.pulse) * 0.08 + amp * 0.34), 0, Math.PI * 2);
    ctx2d.stroke();
    ctx2d.restore();
  }

  // Detailed creature body — a cached sprite (see micro_forms.js) that breathes
  // via blit scale and gently rotates, so the heavy detail is rasterised once
  // and motion stays cheap. Live overlays (halo, voice, markers) draw around it.
  const rp = germRenderParams(g, r * bodyScale);
  const drewBody = microRenderer?.blitForm(GERM_FORMS, g.visual, rp.halfPx, s.x, s.y, rp.params, { scale: rp.scale, rotation: rp.rotation });
  if (!drewBody) {
    // Fallback to the original simple body if the renderer/form is unavailable.
    ctx2d.beginPath();
    ctx2d.arc(s.x, s.y, r * bodyScale, 0, Math.PI * 2);
    ctx2d.fill();
    ctx2d.stroke();
    ctx2d.fillStyle = living ? `rgba(${paper},${paper},${paper},0.96)` : `rgba(${ink},${ink},${ink},0.72)`;
    ctx2d.fillRect(s.x - Math.max(1, r * 0.12), s.y - Math.max(1, r * 0.12), Math.max(2, r * 0.24), Math.max(2, r * 0.24));
  }
  if (birthGlow > 0) {
    ctx2d.save();
    ctx2d.globalAlpha = birthGlow * 0.6;
    ctx2d.strokeStyle = `rgba(${ink},${ink},${ink},1)`;
    ctx2d.lineWidth = Math.max(1, 1.4 * camera.zoom);
    ctx2d.beginPath();
    ctx2d.arc(s.x, s.y, r * (1.4 + (1 - birthGlow) * 1.8), 0, Math.PI * 2);
    ctx2d.stroke();
    ctx2d.restore();
  }

  // Skip voice waveform when germ is too small on screen
  if (living && r > 5) {
    ctx2d.save();
    ctx2d.strokeStyle = `rgba(${living ? paper : ink},${living ? paper : ink},${living ? paper : ink},${0.5 + amp * 0.35})`;
    ctx2d.lineWidth = Math.max(1, 0.9 * camera.zoom);
    ctx2d.beginPath();
    const width = r * 1.3;
    for (let i = 0; i <= 8; i++) {
      const x = s.x - width / 2 + (width * i) / 8;
      const y = s.y + Math.sin(g.pulse * 1.7 + i * 0.95) * r * (0.12 + amp * 0.12);
      if (i === 0) ctx2d.moveTo(x, y);
      else ctx2d.lineTo(x, y);
    }
    ctx2d.stroke();
    ctx2d.restore();
  }

  if (mutating || g._harvested > 0 || g._quarantined > 0) {
    const amount = mutating ? 1 : Math.max(g._harvested || 0, g._quarantined || 0) / 28;
    ctx2d.save();
    ctx2d.setLineDash([3, 4]);
    ctx2d.globalAlpha = amount;
    ctx2d.beginPath();
    ctx2d.arc(s.x, s.y, r * (1.8 + Math.sin(g.pulse * 2) * 0.18), 0, Math.PI * 2);
    ctx2d.stroke();
    for (let i = 0; i < 6; i++) {
      const a = g.pulse * 0.8 + (Math.PI * 2 * i) / 6;
      ctx2d.fillRect(s.x + Math.cos(a) * r * 1.55 - 1, s.y + Math.sin(a) * r * 1.55 - 1, 2, 2);
    }
    ctx2d.restore();
    if (g._harvested > 0) g._harvested -= 1;
    if (g._quarantined > 0) g._quarantined -= 1;
  }

  if (g._touch > 0) {
    ctx2d.lineWidth = Math.max(1, 1.2 * camera.zoom);
    ctx2d.beginPath();
    ctx2d.arc(s.x, s.y, r * (1.8 + (6 - g._touch) * 0.25), 0, Math.PI * 2);
    ctx2d.strokeStyle = `rgba(${ink},${ink},${ink},${clamp(g._touch / 14, 0, 1)})`;
    ctx2d.stroke();
    g._touch -= 1;
  }
  if (g._infected > 0) {
    ctx2d.strokeStyle = `rgba(${ink},${ink},${ink},0.6)`;
    ctx2d.lineWidth = Math.max(1, 1.4 * camera.zoom);
    ctx2d.strokeRect(s.x - r * 1.18, s.y - r * 1.18, r * 2.36, r * 2.36);
    g._infected -= 1;
  }
  if (g === selectedGerm()) {
    ctx2d.setLineDash([8, 5]);
    ctx2d.beginPath();
    ctx2d.arc(s.x, s.y, r + 8, 0, Math.PI * 2);
    ctx2d.stroke();
    ctx2d.setLineDash([]);
  }
  ctx2d.restore();
}

// Draw floating motes (atmospheric depth particles — animated every frame, cheap)
function drawFloatingMotes(v, dark) {
  const ink = dark ? 244 : 17;
  if (!floatingMotes.length) initMotes(v.w, v.h);
  floatingMotes.forEach((m, index) => {
    m.x += m.vx;
    m.y += m.vy;
    // Wrap at viewport edges
    if (m.x < -10) m.x = v.w + 10;
    if (m.x > v.w + 10) m.x = -10;
    if (m.y < -10) m.y = v.h + 10;
    if (m.y > v.h + 10) m.y = -10;
    const glyph = unicodeFrame(index % 3 === 0 ? "sparkle" : "braille", unicodeTick("sparkle", 2, index));
    drawUnicodeText(glyph, Math.round(m.x), Math.round(m.y), {
      ink,
      size: Math.max(5, m.size * 4),
      alpha: m.alpha,
    });
  });
}

function draw() {
  if (!ctx2d) return;
  const v = viewSize();
  const dark = isDark();
  ctx2d.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx2d.clearRect(0, 0, v.w, v.h);
  ctx2d.fillStyle = dark ? "#141414" : "#FAFAFA";
  ctx2d.fillRect(0, 0, v.w, v.h);

  // Static layer caching: petri frame + world texture rendered to offscreen canvas.
  // Include quantized time so animated dashes in petri frame don't freeze.
  const t = (microRenderer ? microRenderer.time : 0) * 0.001;
  const tq = Math.floor(t * 2);   // ~2 updates/sec keeps dash animation alive
  const cacheKey = `${camera.x.toFixed(1)},${camera.y.toFixed(1)},${camera.zoom.toFixed(1)},${microMode},${v.w},${v.h},${tq}`;
  if (staticLayerKey === cacheKey && staticLayer) {
    ctx2d.drawImage(staticLayer, 0, 0, v.w, v.h);
  } else {
    // Render to offscreen canvas
    const offW = Math.round(v.w * dpr);
    const offH = Math.round(v.h * dpr);
    let offCanvas;
    if (staticLayer && staticLayer.width === offW && staticLayer.height === offH) {
      offCanvas = staticLayer;
    } else {
      offCanvas = (typeof OffscreenCanvas !== 'undefined')
        ? new OffscreenCanvas(offW, offH)
        : (() => { const c = document.createElement('canvas'); c.width = offW; c.height = offH; return c; })();
    }
    const offCtx = offCanvas.getContext('2d');
    offCtx.clearRect(0, 0, offW, offH);
    // Temporarily swap ctx2d to render petri+world onto offscreen
    const mainCtx = ctx2d;
    ctx2d = offCtx;
    ctx2d.setTransform(dpr, 0, 0, dpr, 0, 0);
    drawPetriFrame(dark);
    drawWorldTexture(dark);
    ctx2d = mainCtx;
    // Blit the offscreen layer
    ctx2d.drawImage(offCanvas, 0, 0, v.w, v.h);
    staticLayer = offCanvas;
    staticLayerKey = cacheKey;
  }

  // Aperture frame is screen-space (viewport corners) — draw AFTER cache blit,
  // directly to main canvas so it stays live on resize.
  drawApertureFrame(isDark() ? 244 : 17);

  // Floating motes draw AFTER cached layer (they animate every frame)
  drawFloatingMotes(v, dark);

  for (const fx of effects) drawEffect(fx, dark);

  for (const mod of modules) {
    const ms = worldToScreen(mod.x, mod.y);
    const mr = mod.radius * camera.zoom;
    if (ms.x < -mr || ms.x > v.w + mr || ms.y < -mr || ms.y > v.h + mr) continue;
    drawModule(mod, dark);
  }

  for (const g of germs) {
    const gs = worldToScreen(g.x, g.y);
    const gr = g.radius * camera.zoom;
    if (gs.x < -gr * 3 || gs.x > v.w + gr * 3 || gs.y < -gr * 3 || gs.y > v.h + gr * 3) continue;
    drawGermSprite(g, dark);
  }
}

let _selectedGermId = null;
function selectedGerm() { return germs.find((g) => g.id === _selectedGermId) || null; }

// ---- Main loop -----------------------------------------------------------
function frame(ts) {
  if (!running) return;
  const dt = Math.min(0.05, (ts - lastFrame) / 1000 || 0.016);
  lastFrame = ts;
  updateSpectatorCamera(dt);
  updateCamera(dt);
  stepPhysics(dt);
  updateSpatialAudio(dt);
  recordCameraPathPoint();
  microRenderer?.beginFrame(ts);
  microRenderer?.ensureFresh();
  draw();
  hudElapsed += dt;
  if (hudElapsed >= 0.12) {
    hudElapsed = 0;
    updateHud();
  }
  rafHandle = requestAnimationFrame(frame);
}

// ---- HUD / counts --------------------------------------------------------
function updateHud() {
  const living = germs.filter((g) => g.state === "living").length;
  const queued = generationQueue.length + generationActive;
  if (dom.count) {
    dom.count.textContent = `${germs.length} germ${germs.length === 1 ? "" : "s"} · ${living} living${modules.length ? ` · ${modules.length} modules` : ""}${queued ? ` · ${queued} pending` : ""}`;
  }
  const vitality = germs.length ? Math.round((living / Math.max(1, germs.length)) * 100) : 0;
  const listening = currentListeningRadius();
  const depth = microMode === "world" ? "World" : "Scope";
  if (dom.population) dom.population.textContent = `${germs.length} / ${MAX_POPULATION}`;
  if (dom.vitality) dom.vitality.textContent = `${vitality}%`;
  if (dom.nutrients) dom.nutrients.textContent = `${listening}u`;
  if (dom.temperature) dom.temperature.textContent = depth;
  if (dom.zoom) dom.zoom.textContent = `${Math.round((camera.zoom / DEFAULT_ZOOM) * 100)}%`;
  if (dom.empty) dom.empty.hidden = germs.length > 0;
  syncControls();
}

// ---- Hit testing ---------------------------------------------------------
function germAt(sx, sy) {
  for (let i = germs.length - 1; i >= 0; i--) {
    const g = germs[i];
    const s = worldToScreen(g.x, g.y);
    if (Math.hypot(sx - s.x, sy - s.y) <= g.radius * camera.zoom + 4) return g;
  }
  return null;
}

function moduleAt(sx, sy) {
  for (let i = modules.length - 1; i >= 0; i--) {
    const mod = modules[i];
    const s = worldToScreen(mod.x, mod.y);
    if (Math.hypot(sx - s.x, sy - s.y) <= Math.max(16, mod.radius * camera.zoom * 0.18)) return mod;
    if (Math.abs(Math.hypot(sx - s.x, sy - s.y) - mod.radius * camera.zoom) <= 8) return mod;
  }
  return null;
}

// ---- Generation: word cards -> prompt -> /generate -> germ ---------------
function buildPromptFromGenome(words, recipe) {
  const tail = RECIPE_TAILS[recipe] || "no voice, no melody";
  return `${words.join(" ")}, ${tail}`.replace(/\s+,/g, ",");
}

function openLeftClickMenu(worldPoint) {
  const host = dom.cards;
  if (!host) return;
  host.hidden = false;
  host.innerHTML = `
    <div class="dish-cards-inner">
      <span class="dish-cards-kicker">Spawn Sound Germ</span>
      <div class="dish-module-grid" style="grid-template-columns: repeat(2, minmax(200px, 1fr));">
        <button class="dish-module-card" type="button" data-source-type="custom-prompt">
          <span style="display: inline-grid; place-items: center; width: 22px; height: 22px;">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" style="width: 18px; height: 18px;"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>
          </span>
          <strong>Custom Prompt<span>Type prompt to generate</span></strong>
        </button>
        <button class="dish-module-card" type="button" data-source-type="word-selector">
          <span style="display: inline-grid; place-items: center; width: 22px; height: 22px;">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" style="width: 18px; height: 18px;"><rect x="3" y="3" width="18" height="18" rx="2" ry="2"/><line x1="9" y1="9" x2="15" y2="9"/><line x1="9" y1="13" x2="15" y2="13"/><line x1="9" y1="17" x2="13" y2="17"/></svg>
          </span>
          <strong>Word Selector<span>Assemble keywords step-by-step</span></strong>
        </button>
        <button class="dish-module-card" type="button" data-source-type="library">
          <span style="display: inline-grid; place-items: center; width: 22px; height: 22px;">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" style="width: 18px; height: 18px;"><path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20"/><path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z"/></svg>
          </span>
          <strong>Library Sound<span>Choose from generated files</span></strong>
        </button>
        <button class="dish-module-card" type="button" data-source-type="upload">
          <span style="display: inline-grid; place-items: center; width: 22px; height: 22px;">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" style="width: 18px; height: 18px;"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="17 8 12 3 7 8"/><line x1="12" y1="3" x2="12" y2="15"/></svg>
          </span>
          <strong>Upload File<span>Import local WAV/MP3 sound</span></strong>
        </button>
        <button class="dish-module-card" type="button" data-source-type="record" style="grid-column: span 2;">
          <span style="display: inline-grid; place-items: center; width: 22px; height: 22px;">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" style="width: 18px; height: 18px;"><path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z"/><path d="M19 10v2a7 7 0 0 1-14 0v-2"/><line x1="12" y1="19" x2="12" y2="23"/></svg>
          </span>
          <strong>Record Input<span>Capture live microphone audio</span></strong>
        </button>
      </div>
      <button class="dish-cards-cancel" type="button" data-card-cancel aria-label="Cancel">esc</button>
    </div>`;

  host.querySelectorAll("[data-source-type]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const type = btn.dataset.sourceType;
      if (type === "custom-prompt") {
        openCustomPromptDialog(worldPoint);
      } else if (type === "word-selector") {
        openCardFlow(worldPoint);
      } else if (type === "library") {
        openLibraryPicker(worldPoint);
      } else if (type === "upload") {
        uploadLocalAudioForGerm(worldPoint);
      } else if (type === "record") {
        startHardwareRecordingForGerm(worldPoint);
      }
    });
  });

  host.querySelector("[data-card-cancel]")?.addEventListener("click", () => {
    host.hidden = true;
  });
}

function openMicrocosmosSettings() {
  const host = dom.cards;
  if (!host) return;
  host.hidden = false;

  const providerSelect = document.getElementById("provider");
  const modelSelect = document.getElementById("model");
  const deviceSelect = document.getElementById("device");
  const serverUrlInput = document.getElementById("serverUrl");

  if (!providerSelect || !modelSelect || !deviceSelect || !serverUrlInput) {
    console.error("Could not find global settings inputs");
    return;
  }

  const optionMarkup = (opt, selectedValue) =>
    `<option value="${E.escapeHtml(opt.value)}" ${opt.value === selectedValue ? 'selected' : ''}>${E.escapeHtml(opt.text)}</option>`;

  const providersOptions = Array.from(providerSelect.options)
    .map((opt) => optionMarkup(opt, providerSelect.value))
    .join("");

  const modelsOptions = Array.from(modelSelect.options)
    .map((opt) => optionMarkup(opt, modelSelect.value))
    .join("");

  const devicesOptions = Array.from(deviceSelect.options)
    .map((opt) => optionMarkup(opt, deviceSelect.value))
    .join("");

  const serverUrlVal = serverUrlInput.value;

  host.innerHTML = `
    <div class="dish-cards-inner" style="max-width: 480px; width: 90%;">
      <span class="dish-cards-kicker">Generation Settings</span>
      
      <div class="dish-settings-form" style="display: grid; width: 100%; gap: 14px; margin: 12px 0; text-align: left; z-index: 1;">
        
        <div class="dish-form-field" style="display: grid; gap: 4px;">
          <label style="font-size: 10px; letter-spacing: 0.1em; text-transform: uppercase; color: var(--dish-soft); font-weight: bold;">Provider</label>
          <select id="dishProviderSelect" style="width: 100%; padding: 8px 10px; background: rgba(5, 6, 7, 0.65); color: var(--dish-ink); border: 1px solid var(--dish-line); font: inherit; font-size: 12px; border-radius: 4px; outline: none; cursor: pointer;">
            ${providersOptions}
          </select>
        </div>

        <div class="dish-form-field" style="display: grid; gap: 4px;">
          <label style="font-size: 10px; letter-spacing: 0.1em; text-transform: uppercase; color: var(--dish-soft); font-weight: bold;">Model</label>
          <select id="dishModelSelect" style="width: 100%; padding: 8px 10px; background: rgba(5, 6, 7, 0.65); color: var(--dish-ink); border: 1px solid var(--dish-line); font: inherit; font-size: 12px; border-radius: 4px; outline: none; cursor: pointer;">
            ${modelsOptions}
          </select>
        </div>

        <div class="dish-form-field" style="display: grid; gap: 4px;">
          <label style="font-size: 10px; letter-spacing: 0.1em; text-transform: uppercase; color: var(--dish-soft); font-weight: bold;">Device / Engine</label>
          <select id="dishDeviceSelect" style="width: 100%; padding: 8px 10px; background: rgba(5, 6, 7, 0.65); color: var(--dish-ink); border: 1px solid var(--dish-line); font: inherit; font-size: 12px; border-radius: 4px; outline: none; cursor: pointer;">
            ${devicesOptions}
          </select>
        </div>

        <div class="dish-form-field" style="display: grid; gap: 4px;">
          <label style="font-size: 10px; letter-spacing: 0.1em; text-transform: uppercase; color: var(--dish-soft); font-weight: bold;">Server URL</label>
          <input id="dishServerUrlInput" type="text" value="${E.escapeHtml(serverUrlVal)}" placeholder="http://127.0.0.1:5178" style="width: 100%; padding: 8px 10px; background: rgba(5, 6, 7, 0.65); color: var(--dish-ink); border: 1px solid var(--dish-line); font: inherit; font-size: 12px; border-radius: 4px; box-sizing: border-box; outline: none;" />
        </div>

        <div class="dish-settings-buttons" style="display: grid; grid-template-columns: 1fr 1fr; gap: 10px; margin-top: 6px;">
          <button id="dishRefreshBtn" class="dish-pixel-button" type="button" style="justify-content: center; min-height: 40px; min-width: unset; width: 100%;">
            <span data-icon="refresh" style="width: 16px; height: 16px;"></span>
            <strong>Refresh</strong>
          </button>
          <button id="dishLoadBtn" class="dish-pixel-button" type="button" style="justify-content: center; min-height: 40px; min-width: unset; width: 100%;">
            <span data-icon="spawn" style="width: 16px; height: 16px; transform: rotate(90deg);"></span>
            <strong>Load Model</strong>
          </button>
        </div>

      </div>

      <button class="dish-cards-cancel" type="button" data-card-cancel>esc</button>
    </div>
  `;

  // Hydrate custom SVGs (refresh, spawn icons inside buttons)
  hydrateMicroIcons(host);

  const dishProv = document.getElementById("dishProviderSelect");
  const dishModel = document.getElementById("dishModelSelect");
  const dishDev = document.getElementById("dishDeviceSelect");
  const dishServ = document.getElementById("dishServerUrlInput");

  dishProv.addEventListener("change", () => {
    providerSelect.value = dishProv.value;
    providerSelect.dispatchEvent(new Event("change", { bubbles: true }));
    // Wait for app.js to update modelSelect dropdown based on new provider,
    // then re-populate dishModel select list inside settings menu.
    setTimeout(() => {
      dishModel.innerHTML = Array.from(modelSelect.options)
        .map((opt) => optionMarkup(opt, modelSelect.value))
        .join("");
    }, 80);
  });

  dishModel.addEventListener("change", () => {
    modelSelect.value = dishModel.value;
    modelSelect.dispatchEvent(new Event("change", { bubbles: true }));
  });

  dishDev.addEventListener("change", () => {
    deviceSelect.value = dishDev.value;
    deviceSelect.dispatchEvent(new Event("change", { bubbles: true }));
  });

  dishServ.addEventListener("input", () => {
    serverUrlInput.value = dishServ.value;
    serverUrlInput.dispatchEvent(new Event("input", { bubbles: true }));
  });

  document.getElementById("dishRefreshBtn").addEventListener("click", async () => {
    if (typeof E.refreshAll === "function") {
      try {
        await E.refreshAll();
        // Update values in the settings menu
        dishProv.value = providerSelect.value;
        dishModel.innerHTML = Array.from(modelSelect.options)
          .map((opt) => optionMarkup(opt, modelSelect.value))
          .join("");
        dishDev.value = deviceSelect.value;
        dishServ.value = serverUrlInput.value;
      } catch (err) {
        E.finishWork("Refresh Failed", "bad", err.message);
      }
    }
  });

  document.getElementById("dishLoadBtn").addEventListener("click", async () => {
    if (typeof E.loadModel === "function") {
      try {
        await E.loadModel();
      } catch (err) {
        E.finishWork("Load Failed", "bad", err.message);
      }
    }
  });

  host.querySelector("[data-card-cancel]").addEventListener("click", () => {
    host.hidden = true;
  });
}

function openCustomPromptDialog(worldPoint) {
  const host = dom.cards;
  if (!host) return;
  host.hidden = false;
  host.innerHTML = `
    <div class="dish-cards-inner">
      <span class="dish-cards-kicker">Custom prompt germination</span>
      <div class="dish-prompt-input-container" style="display: grid; width: 100%; gap: 12px; z-index: 1;">
        <textarea id="dishCustomPromptInput" rows="3" placeholder="Describe the sound matter (e.g. dry wood crackle, close microphone)..." style="width: 100%; padding: 12px; background: rgba(5, 6, 7, 0.42); color: var(--dish-ink); border: 1px solid var(--dish-line); font: inherit; font-size: 13px; resize: vertical; box-sizing: border-box;"></textarea>
        <button id="dishCustomPromptBtn" class="dish-pixel-button" type="button" style="justify-self: center; min-width: 140px;">Germinate</button>
      </div>
      <button class="dish-cards-cancel" type="button" data-card-cancel>esc</button>
    </div>`;

  const inputEl = document.getElementById("dishCustomPromptInput");
  const btnEl = document.getElementById("dishCustomPromptBtn");

  btnEl.addEventListener("click", async () => {
    const prompt = inputEl.value.trim();
    if (!prompt) {
      E.finishWork("Invalid Prompt", "muted", "Please enter a prompt string first.");
      return;
    }
    host.hidden = true;
    if (germs.length >= MAX_POPULATION) {
      E.finishWork("Microcosmos Full", "muted", `Population limit ${MAX_POPULATION}.`);
      return;
    }
    const label = prompt.slice(0, 16) || "custom";
    const spore = makeGerm({ assetId: null, x: worldPoint.x, y: worldPoint.y, label, genome: { words: label.split(/\s+/), recipe: "creature", traits: {} } });
    spore.state = "mutating";
    germs.push(spore);
    
    try {
      const payload = E.buildPayload({
        prompt,
        negative_prompt: "voice, singing, melody, music",
        duration: 3,
        batch_size: 1,
        operation: "microcosmos_germinate",
        output_name: `microcosmos_${label.replace(/[^a-z0-9]/gi, "_").slice(0, 40)}`,
        lineage: {
          operation: "microcosmos_germinate",
          source_type: "microcosmos",
          mode: "microcosmos",
          source: "custom_prompt",
          prompt_genome: [label],
          cards: [label],
          microcosmos_position: { x: Math.round(worldPoint.x), y: Math.round(worldPoint.y) },
          visual_germ_type: spore.visual,
        },
      });
      const result = await E.api("/generate", { method: "POST", body: JSON.stringify(payload) });
      const audioPath = result?.audio_files?.[0];
      const metadataPath = result?.metadata_files?.[0];
      if (!audioPath) throw new Error(result?.error || "generation returned no audio");
      const asset = E.createAsset({
        audioPath,
        metadataPath,
        metadata: {
          prompt,
          duration: 3,
          mode: "microcosmos",
          operation: "microcosmos_germinate",
          source_type: "microcosmos",
          germinator_mode: "germinate",
          parents: [],
          lineage: { operation: "microcosmos_germinate", source_type: "microcosmos", mode: "microcosmos", parents: [] },
        },
        origin: "microcosmos",
      });
      spore.assetId = asset.id;
      spore.genome.traits = await profileTraits(audioPath, metadataPath);
      spore.state = "dormant";
      await setGermLiving(spore, true);
      pushEffect("spawn", spore.x, spore.y, { radius: spore.radius * 3, ttl: 0.9 });
      saveDish();
      E.finishWork("Germinated", "ok", prompt);
    } catch (error) {
      spore._touch = 6;
      germs = germs.filter((g) => g !== spore);
      E.finishWork("Germinate Error", "bad", error.message);
    }
  });

  host.querySelector("[data-card-cancel]")?.addEventListener("click", () => {
    host.hidden = true;
  });
}

function uploadLocalAudioForGerm(worldPoint) {
  const host = dom.cards;
  host.hidden = true;
  const input = document.createElement("input");
  input.type = "file";
  input.accept = "audio/*,.wav,.mp3,.ogg,.flac,.m4a,.aif,.aiff,.webm";
  input.addEventListener("change", async (event) => {
    const file = Array.from(event.target.files || [])[0];
    if (!file) return;
    E.finishWork("Importing Audio File", "ok", file.name);
    try {
      const metadata = {
        prompt: `Imported file: ${file.name}`,
        created_at: new Date().toISOString(),
        operation: "upload",
        source_type: "upload",
        microcosmos_position: { x: Math.round(worldPoint.x), y: Math.round(worldPoint.y) }
      };
      
      const form = new FormData();
      form.append("file", file);
      form.append("metadata", JSON.stringify(metadata));
      
      const result = await E.api("/audio/import", { method: "POST", body: form });
      const audioPath = result?.audio_files?.[0];
      const metadataPath = result?.metadata_files?.[0];
      if (!audioPath) throw new Error(result?.error || "Import returned no audio path");
      
      const asset = E.createAsset({
        audioPath,
        metadataPath,
        metadata,
        origin: "upload",
      });
      
      if (germs.length >= MAX_POPULATION) {
        E.finishWork("Microcosmos Full", "muted", `Population limit ${MAX_POPULATION}.`);
        return;
      }
      const label = file.name.slice(0, 16);
      const germ = makeGerm({
        assetId: asset.id,
        x: worldPoint.x,
        y: worldPoint.y,
        label,
        genome: { words: label.split(/\s+/), traits: { energy: 0.5 } },
      });
      germs.push(germ);
      pushEffect("spawn", germ.x, germ.y, { radius: germ.radius * 3, ttl: 0.9 });
      saveDish();
      updateHud();
      E.finishWork("Audio File Spawned", "ok", file.name);
    } catch (err) {
      E.finishWork("Import Error", "bad", err.message);
    }
  });
  input.click();
}

async function mediaStreamWithPermissionTimeout(requestPromise, label, timeoutMs = 20000) {
  let timedOut = false;
  let timeoutId = null;
  const guardedRequest = Promise.resolve(requestPromise).then((stream) => {
    if (timedOut) {
      stream?.getTracks?.().forEach((track) => track.stop());
      throw new Error(`${label} permission timed out.`);
    }
    return stream;
  });
  try {
    return await Promise.race([
      guardedRequest,
      new Promise((_, reject) => {
        timeoutId = window.setTimeout(() => {
          timedOut = true;
          reject(new Error(`${label} permission timed out.`));
        }, timeoutMs);
      }),
    ]);
  } finally {
    if (timeoutId) window.clearTimeout(timeoutId);
  }
}

async function startHardwareRecordingForGerm(worldPoint) {
  const host = dom.cards;
  if (!host) return;
  
  if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === "undefined") {
    E.finishWork("Recording Error", "bad", "Browser recording is not available.");
    return;
  }
  
  let stream;
  try {
    stream = await mediaStreamWithPermissionTimeout(
      navigator.mediaDevices.getUserMedia({ audio: true }),
      "Microphone",
    );
  } catch (err) {
    E.finishWork("Recording Error", "bad", err.message || "Microphone access denied.");
    return;
  }

  host.hidden = false;
  host.innerHTML = `
    <div class="dish-cards-inner">
      <span class="dish-cards-kicker">Microphone Recording</span>
      <div style="display: grid; place-items: center; gap: 16px; width: 100%; z-index: 1; padding: 20px 0;">
        <div class="dish-recording-indicator" style="width: 24px; height: 24px; border-radius: 50%; background: #b3453e; animation: dish-bit-pulse 1s infinite;"></div>
        <span style="font-size: 14px; font-weight: 800; color: #b3453e; letter-spacing: 0.05em;">RECORDING LIVE</span>
        <button id="dishStopRecordBtn" class="dish-pixel-button" type="button" style="min-width: 140px; background: #b3453e; border-color: #b3453e; color: var(--dish-paper);">Stop & Spawn</button>
      </div>
    </div>`;

  const recChunks = [];
  const recorder = new MediaRecorder(stream);
  recorder.addEventListener("dataavailable", (ev) => {
    if (ev.data?.size) recChunks.push(ev.data);
  });

  recorder.addEventListener("stop", async () => {
    stream.getTracks().forEach((track) => track.stop());
    const blob = new Blob(recChunks, { type: recorder.mimeType || "audio/webm" });
    if (!blob.size) {
      E.finishWork("Recording Empty", "bad", "No audio data was captured.");
      return;
    }
    
    E.finishWork("Importing Recording", "ok", "Saving to disk...");
    try {
      const filename = `recording_${Date.now()}.webm`;
      const metadata = {
        prompt: "Microphone recording from Microcosmos",
        created_at: new Date().toISOString(),
        operation: "recording",
        source_type: "recording",
        microcosmos_position: { x: Math.round(worldPoint.x), y: Math.round(worldPoint.y) }
      };
      
      const result = await E.importAudioBlob(blob, metadata, filename);
      const audioPath = result?.audio_files?.[0];
      const metadataPath = result?.metadata_files?.[0];
      if (!audioPath) throw new Error("Backend did not return audio path");
      
      const asset = E.createAsset({
        audioPath,
        metadataPath,
        metadata,
        origin: "recording"
      });
      
      if (germs.length >= MAX_POPULATION) {
        E.finishWork("Microcosmos Full", "muted", `Population limit ${MAX_POPULATION}.`);
        return;
      }
      
      const germ = makeGerm({
        assetId: asset.id,
        x: worldPoint.x,
        y: worldPoint.y,
        label: "mic_record",
        genome: { words: ["mic", "record"], traits: { energy: 0.5 } }
      });
      germs.push(germ);
      pushEffect("spawn", germ.x, germ.y, { radius: germ.radius * 3, ttl: 0.9 });
      saveDish();
      updateHud();
      E.finishWork("Recording Spawned", "ok", "mic_record");
    } catch (err) {
      E.finishWork("Import Error", "bad", err.message);
    }
  });

  document.getElementById("dishStopRecordBtn").addEventListener("click", () => {
    recorder.stop();
    host.hidden = true;
  });

  recorder.start();
}

function openCardFlow(worldPoint) {
  cardFlow = { step: 0, words: [], recipe: null, point: worldPoint, order: ["recipe", "body", "action", "texture", "space"] };
  renderCardFlow();
}
function renderCardFlow() {
  const host = dom.cards;
  if (!host || !cardFlow) return;
  if (cardFlow.step >= cardFlow.order.length) { host.hidden = true; finishCardFlow(); return; }
  const key = cardFlow.order[cardFlow.step];
  const bank = WORD_BANKS[key];
  const cards = bank.cards.map((c) => (typeof c === "string" ? { word: c } : c));
  host.hidden = false;
  host.innerHTML = `
    <div class="dish-cards-inner">
      <span class="dish-cards-kicker">${E.escapeHtml(bank.label)}</span>
      <div class="dish-cards-row">
        ${cards.map((c, i) => `<button class="dish-card" type="button" data-card-index="${i}">${E.escapeHtml(c.word)}</button>`).join("")}
      </div>
      <div class="dish-cards-trail">${E.escapeHtml(cardFlow.words.join(" · ") || "seed path")}</div>
      <button class="dish-cards-cancel" type="button" data-card-cancel aria-label="Cancel">esc</button>
    </div>`;
  host.querySelectorAll("[data-card-index]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const card = cards[Number(btn.dataset.cardIndex)];
      if (card.recipe) cardFlow.recipe = card.recipe;
      cardFlow.words.push(card.word);
      cardFlow.step += 1;
      renderCardFlow();
    });
  });
  host.querySelector("[data-card-cancel]")?.addEventListener("click", () => { host.hidden = true; cardFlow = null; });
}

function moduleIcon(type) {
  const icon = type === "spore" ? "spawn" : type;
  return `<span data-icon="${E.escapeHtml(icon)}"></span>`;
}

function placeModule(type, point = { x: camera.x, y: camera.y }) {
  if (!MODULE_DEFS[type]) type = "magnet";
  const spread = 58 + modules.length * 9;
  const mod = makeModule(type, clamp(point.x + (Math.random() - 0.5) * spread, 0, WORLD.w), clamp(point.y + (Math.random() - 0.5) * spread, 0, WORLD.h));
  modules.push(mod);
  _selectedModuleId = mod.id;
  _selectedGermId = null;
  pushEffect("module", mod.x, mod.y, { radius: mod.radius * 0.7, ttl: 0.7 });
  saveDish();
  updateHud();
  E.finishWork("Module Placed", "ok", MODULE_DEFS[type]?.label || type);
  return mod;
}

function openModulePalette(worldPoint) {
  const host = dom.cards;
  if (!host) return;
  modulePalettePoint = worldPoint;
  host.hidden = false;
  const entries = Object.entries(MODULE_DEFS);
  host.innerHTML = `
    <div class="dish-cards-inner">
      <span class="dish-cards-kicker">Field module</span>
      <div class="dish-module-grid">
        ${entries.map(([type, def]) => `<button class="dish-module-card" type="button" data-module-type="${type}">
          ${moduleIcon(type)}
          <strong>${E.escapeHtml(def.label)}<span>${E.escapeHtml(def.detail)}</span></strong>
        </button>`).join("")}
      </div>
      <button class="dish-cards-cancel" type="button" data-card-cancel aria-label="Cancel">esc</button>
    </div>`;
  hydrateMicroIcons(host);
  host.querySelectorAll("[data-module-type]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const type = btn.dataset.moduleType;
      const point = modulePalettePoint || { x: camera.x, y: camera.y };
      placeModule(type, point);
      host.hidden = true;
      modulePalettePoint = null;
    });
  });
  host.querySelector("[data-card-cancel]")?.addEventListener("click", () => { host.hidden = true; modulePalettePoint = null; });
}

function deleteModule(mod) {
  modules = modules.filter((item) => item !== mod);
  if (_selectedModuleId === mod.id) _selectedModuleId = null;
  saveDish();
  updateHud();
  E.finishWork("Module Deleted", "ok", MODULE_DEFS[mod.type]?.label || mod.type);
}

function openModuleAdvancedEditor(mod) {
  const host = dom.cards;
  if (!host || !mod) return;
  const def = MODULE_DEFS[mod.type] || { label: mod.type, detail: "" };
  host.hidden = false;
  host.innerHTML = `
    <div class="dish-cards-inner">
      <span class="dish-cards-kicker">Advanced Module: ${E.escapeHtml(def.label)}</span>
      <div class="dish-module-grid" style="grid-template-columns: repeat(2, minmax(150px, 1fr)); gap: 12px;">
        <label class="dish-module-card" style="cursor: default;">
          ${moduleIcon(mod.type)}
          <strong>Field Radius<span>${Math.round(mod.radius)} units</span></strong>
          <input type="range" min="90" max="320" value="${Math.round(mod.radius)}" data-module-radius style="grid-column: 1 / -1; width: 100%; accent-color: var(--dish-ink);" />
        </label>
        <button class="dish-module-card" type="button" data-action="loop">
          <span data-icon="refresh"></span>
          <strong>${mod.loop === false ? "Enable Loop" : "Disable Loop"}<span>animation cycle</span></strong>
        </button>
        <button class="dish-module-card" type="button" data-action="pipe">
          <span data-icon="pipe"></span>
          <strong>Pipe To Chamber<span>create field module</span></strong>
        </button>
        <button class="dish-module-card" type="button" data-action="delete" style="color: #b3453e; border-color: rgba(179, 69, 62, 0.35);">
          <span data-icon="clear"></span>
          <strong>Delete<span>remove module</span></strong>
        </button>
      </div>
      <button class="dish-cards-cancel" type="button" data-card-cancel aria-label="Back">back</button>
    </div>`;
  hydrateMicroIcons(host);
  host.querySelector("[data-module-radius]")?.addEventListener("input", (event) => {
    mod.radius = Number(event.target.value) || mod.radius;
    const label = event.target.closest(".dish-module-card")?.querySelector("strong span");
    if (label) label.textContent = `${Math.round(mod.radius)} units`;
    saveDish();
  });
  host.querySelectorAll("[data-action]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const action = btn.dataset.action;
      if (action === "loop") {
        mod.loop = mod.loop === false;
        saveDish();
        openModuleAdvancedEditor(mod);
        E.finishWork("Module Loop", "ok", mod.loop === false ? "Paused" : "Enabled");
      } else if (action === "pipe") {
        _selectedModuleId = mod.id;
        host.hidden = true;
        pipeSelectedToCanvas();
      } else if (action === "delete") {
        host.hidden = true;
        deleteModule(mod);
      }
    });
  });
  host.querySelector("[data-card-cancel]")?.addEventListener("click", () => openModuleContextMenu(mod));
}

function openModuleContextMenu(mod) {
  const host = dom.cards;
  if (!host || !mod) return;
  const def = MODULE_DEFS[mod.type] || { label: mod.type, detail: "" };
  _selectedModuleId = mod.id;
  _selectedGermId = null;
  host.hidden = false;
  host.innerHTML = `
    <div class="dish-cards-inner">
      <span class="dish-cards-kicker">Module Options: ${E.escapeHtml(def.label)}</span>
      <div class="dish-module-grid" style="grid-template-columns: repeat(3, minmax(140px, 1fr)); gap: 12px;">
        <button class="dish-module-card" type="button" data-action="loop" style="${mod.loop === false ? "" : "color: var(--ok, #3a8c5c);"}">
          <span data-icon="refresh"></span>
          <strong>${mod.loop === false ? "Enable Loop" : "Disable Loop"}<span>animation cycle</span></strong>
        </button>
        <button class="dish-module-card" type="button" data-action="advanced">
          ${moduleIcon(mod.type)}
          <strong>Advanced Editing<span>field controls</span></strong>
        </button>
        <button class="dish-module-card" type="button" data-action="delete" style="color: #b3453e; border-color: rgba(179, 69, 62, 0.35);">
          <span data-icon="clear"></span>
          <strong>Delete<span>remove module</span></strong>
        </button>
      </div>
      <button class="dish-cards-cancel" type="button" data-card-cancel aria-label="Cancel">esc</button>
    </div>`;
  hydrateMicroIcons(host);
  host.querySelectorAll("[data-action]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const action = btn.dataset.action;
      if (action === "loop") {
        mod.loop = mod.loop === false;
        saveDish();
        openModuleContextMenu(mod);
        E.finishWork("Module Loop", "ok", mod.loop === false ? "Paused" : "Enabled");
      } else if (action === "advanced") {
        openModuleAdvancedEditor(mod);
      } else if (action === "delete") {
        host.hidden = true;
        deleteModule(mod);
      }
    });
  });
  host.querySelector("[data-card-cancel]")?.addEventListener("click", () => { host.hidden = true; });
}

function openGermContextMenu(germ, worldPoint) {
  const host = dom.cards;
  if (!host) return;
  host.hidden = false;

  const loopLabel = germ.loop ? "Disable Loop" : "Enable Loop";
  const loopDetail = germ.loop ? "play once (no repeat)" : "repeat playback";
  const loopIconActive = germ.loop ? "color: var(--ok, #3a8c5c);" : "";

  host.innerHTML = `
    <div class="dish-cards-inner">
      <span class="dish-cards-kicker">Germ Options: ${E.escapeHtml(germ.label || "sound")}</span>
      <div class="dish-module-grid" style="grid-template-columns: repeat(2, minmax(150px, 1fr)); gap: 12px;">
        <button class="dish-module-card" type="button" data-action="loop" style="${loopIconActive}">
          <span style="display: inline-grid; place-items: center; width: 22px; height: 22px;">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" style="width: 18px; height: 18px;"><polyline points="17 1 21 5 17 9"/><path d="M3 11V9a4 4 0 014-4h14"/><polyline points="7 23 3 19 7 15"/><path d="M21 13v2a4 4 0 01-4 4H3"/></svg>
          </span>
          <strong>${E.escapeHtml(loopLabel)}<span>${E.escapeHtml(loopDetail)}</span></strong>
        </button>
        <button class="dish-module-card" type="button" data-action="advanced">
          <span style="display: inline-grid; place-items: center; width: 22px; height: 22px;">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" style="width: 18px; height: 18px;"><path d="M3 10h4V4h4v16h4V10h4"/></svg>
          </span>
          <strong>Advanced Control<span>waveform and editor tools</span></strong>
        </button>
        <button class="dish-module-card" type="button" data-action="duplicate">
          <span style="display: inline-grid; place-items: center; width: 22px; height: 22px;">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" style="width: 18px; height: 18px;"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>
          </span>
          <strong>Duplicate<span>copy germ & traits</span></strong>
        </button>
        <button class="dish-module-card" type="button" data-action="delete" style="color: #b3453e; border-color: rgba(179, 69, 62, 0.35);">
          <span style="display: inline-grid; place-items: center; width: 22px; height: 22px;">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" style="width: 18px; height: 18px;"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>
          </span>
          <strong>Delete<span>remove from dish</span></strong>
        </button>
      </div>
      <button class="dish-cards-cancel" type="button" data-card-cancel aria-label="Cancel">esc</button>
    </div>`;

  host.querySelectorAll("[data-action]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const action = btn.dataset.action;
      if (action === "loop") {
        germ.loop = !germ.loop;
        if (germ.audio) {
          germ.audio.loop = germ.loop;
        }
        saveDish();
        E.finishWork("Loop Status Toggled", "ok", `Germ loop: ${germ.loop}`);
      } else if (action === "advanced") {
        openGermAdvancedEditor(germ);
        return;
      } else if (action === "duplicate") {
        if (germs.length >= MAX_POPULATION) {
          E.finishWork("Microcosmos Full", "muted", `Population limit ${MAX_POPULATION}.`);
          host.hidden = true;
          return;
        }
        const dup = makeGerm({
          assetId: germ.assetId,
          x: Math.max(0, Math.min(WORLD.w, germ.x + 36)),
          y: Math.max(0, Math.min(WORLD.h, germ.y + 36)),
          label: germ.label,
          genome: JSON.parse(JSON.stringify(germ.genome || { words: [], traits: {} })),
          parents: [...(germ.parents || [])],
        });
        dup.loop = germ.loop;
        dup.playbackRate = germ.playbackRate;
        dup.volume = germ.volume;
        dup.visual = germ.visual;
        if (germ.state === "living") {
          dup.state = "living";
          setGermLiving(dup, true);
        }
        germs.push(dup);
        pushEffect("spawn", dup.x, dup.y, { radius: dup.radius * 3, ttl: 0.9 });
        saveDish();
        updateHud();
        E.finishWork("Germ Duplicated", "ok", dup.label);
      } else if (action === "delete") {
        disposeGermAudio(germ);
        germs = germs.filter((g) => g !== germ);
        if (_selectedGermId === germ.id) _selectedGermId = null;
        saveDish();
        updateHud();
        E.finishWork("Germ Deleted", "ok", germ.label);
      }
      host.hidden = true;
    });
  });
  host.querySelector("[data-card-cancel]")?.addEventListener("click", () => {
    host.hidden = true;
  });
}

let germEditorActive = false;

function drawGermWaveform(canvas, buffer, germ) {
  if (!canvas) return;
  const ctx = canvas.getContext("2d");
  const width = canvas.width;
  const height = canvas.height;
  const isDark = document.documentElement.getAttribute("data-theme") === "dark";
  ctx.clearRect(0, 0, width, height);
  ctx.fillStyle = isDark ? "#0c0d0e" : "#fbfbf9";
  ctx.fillRect(0, 0, width, height);

  if (!buffer) {
    ctx.fillStyle = isDark ? "#777" : "#999";
    ctx.font = "12px monospace";
    ctx.fillText("Loading waveform...", 24, height / 2);
    return;
  }

  // Draw waveform peaks
  const data = buffer.getChannelData(0);
  const step = Math.max(1, Math.floor(data.length / width));
  ctx.strokeStyle = dishAccentColor();
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  for (let x = 0; x < width; x++) {
    let min = 1;
    let max = -1;
    const offset = x * step;
    for (let i = 0; i < step && offset + i < data.length; i++) {
      min = Math.min(min, data[offset + i]);
      max = Math.max(max, data[offset + i]);
    }
    ctx.moveTo(x, ((1 - max) * height) / 2);
    ctx.lineTo(x, ((1 - min) * height) / 2);
  }
  ctx.stroke();

  // Draw playhead
  if (germ.audio && Number.isFinite(germ.audio.duration) && germ.audio.duration > 0) {
    const playheadX = (germ.audio.currentTime / germ.audio.duration) * width;
    ctx.strokeStyle = isDark ? "rgba(244,244,236,0.85)" : "rgba(12,13,14,0.85)";
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(playheadX, 0);
    ctx.lineTo(playheadX, height);
    ctx.stroke();
  }
}

function updateGermEditorPlayhead(canvas, getBuffer, germ) {
  if (!germEditorActive || !canvas) return;
  const buffer = typeof getBuffer === "function" ? getBuffer() : getBuffer;
  drawGermWaveform(canvas, buffer, germ);

  // Update time readout if present
  const timeEl = document.getElementById("dishGermTimeReadout");
  if (timeEl && germ.audio) {
    const cur = germ.audio.currentTime || 0;
    const dur = germ.audio.duration || 0;
    const formatTime = (secs) => {
      const m = Math.floor(secs / 60);
      const s = Math.floor(secs % 60).toString().padStart(2, '0');
      return `${m}:${s}`;
    };
    timeEl.textContent = `${formatTime(cur)} / ${formatTime(dur)}`;
  }

  requestAnimationFrame(() => updateGermEditorPlayhead(canvas, getBuffer, germ));
}

async function runGermAudioTool(germ, tool) {
  const asset = E.assetById(germ.assetId);
  if (!asset) return;

  E.finishWork(`Processing ${tool}`, "busy", germ.label);

  const operation = tool === "metadata_embedder" ? "metadata" : tool;
  const payload = {
    input_audio_path: asset.audioPath,
    metadata_path: asset.metadataPath || asset.metadata?.metadata_path || null,
    operation,
    output_name: `germ_${tool}_${germ.label || "sound"}`,
    fade_in_sec: 0.04,
    fade_out_sec: 0.04,
    crossfade_sec: 0.08,
    tail_extension_sec: 2,
    freeze_duration_sec: 8,
    silence_threshold: 0.012,
    onset_threshold: 0.34,
    slice_count: 4,
    tags: ["microcosmos", tool],
    prompt: asset.metadata?.prompt || "",
    negative_prompt: asset.metadata?.negative_prompt || "voice, singing, melody, music",
    seed: Number.isFinite(Number(asset.metadata?.seed)) ? Number(asset.metadata.seed) : null,
  };

  try {
    const result = await E.api("/audio-tools/operate", {
      method: "POST",
      body: JSON.stringify(payload),
    });

    const audioPath = result.audio_files?.[0];
    if (!audioPath) throw new Error("Operation returned no audio files.");

    const newAsset = E.createAsset({
      audioPath,
      metadataPath: result.metadata_files?.[0] || "",
      metadata: asset.metadata || {},
      origin: "microcosmos",
    });

    germ.assetId = newAsset.id;
    if (germ.audio) {
      const playing = !germ.audio.paused;
      germ.audio.src = E.outputUrl(audioPath);
      germ.audio.load();
      if (playing) attemptGermPlay(germ);
    }

    E.finishWork("Processed", "ok", tool);

    // Re-open/reload the advanced editor
    await openGermAdvancedEditor(germ);
  } catch (err) {
    E.finishWork("Process Failed", "bad", err.message);
  }
}

async function runGermTimePitch(germ) {
  const asset = E.assetById(germ.assetId);
  if (!asset) return;

  const pitchValue = window.prompt("Pitch semitones", "0");
  if (pitchValue === null) return;
  const stretchValue = window.prompt("Stretch ratio (1 keeps length)", "1");
  if (stretchValue === null) return;

  E.finishWork("Processing Pitch/Stretch", "busy", germ.label);

  const payload = {
    input_audio_path: asset.audioPath,
    metadata_path: asset.metadataPath || asset.metadata?.metadata_path || "",
    output_name: `germ_warp_${germ.label || "sound"}`,
    pitch_semitones: Number(pitchValue) || 0,
    stretch_ratio: Math.max(0.05, Number(stretchValue) || 1),
    quality: "fine",
    tags: ["microcosmos", "time-pitch"],
    notes: "Microcosmos time-stretch / pitch-shift processing.",
  };

  try {
    const result = await E.api("/audio/process", {
      method: "POST",
      body: JSON.stringify(payload),
    });

    const audioPath = result.audio_files?.[0];
    if (!audioPath) throw new Error("Operation returned no audio files.");

    const newAsset = E.createAsset({
      audioPath,
      metadataPath: result.metadata_files?.[0] || "",
      metadata: asset.metadata || {},
      origin: "microcosmos",
    });

    germ.assetId = newAsset.id;
    if (germ.audio) {
      const playing = !germ.audio.paused;
      germ.audio.src = E.outputUrl(audioPath);
      germ.audio.load();
      if (playing) attemptGermPlay(germ);
    }

    E.finishWork("Processed", "ok", "Warp/Pitch");

    // Re-open/reload the advanced editor
    await openGermAdvancedEditor(germ);
  } catch (err) {
    E.finishWork("Process Failed", "bad", err.message);
  }
}

async function openGermAdvancedEditor(germ) {
  ensureGermAudio(germ);
  const host = dom.cards;
  if (!host) return;
  host.hidden = false;
  germEditorActive = true;

  const asset = E.assetById(germ.assetId);
  const loopActive = germ.loop ? "color: var(--ok, #3a8c5c);" : "";

  host.innerHTML = `
    <div class="dish-cards-inner" style="max-width: 740px; width: 95%;">
      <span class="dish-cards-kicker">Advanced Germ Editor: ${E.escapeHtml(germ.label || "sound")}</span>
      
      <div style="width: 100%; display: grid; gap: 14px; z-index: 1;">
        <canvas id="dishGermWaveformCanvas" width="700" height="180" style="width: 100%; height: 180px; background: rgba(5, 6, 7, 0.65); border: 1px solid var(--dish-line); border-radius: 4px; display: block; cursor: pointer;"></canvas>
        
        <div style="display: flex; justify-content: space-between; align-items: center; font-size: 11px; color: var(--dish-soft);">
          <span id="dishGermTimeReadout">0:00 / 0:00</span>
          <span>Click waveform to seek</span>
        </div>

        <div class="dish-settings-buttons" style="display: flex; flex-wrap: wrap; gap: 8px; justify-content: center;">
          <button id="dishGermPlayBtn" class="dish-pixel-button" type="button" style="min-width: 90px;">
            <strong>Play / Pause</strong>
          </button>
          <button id="dishGermLoopBtn" class="dish-pixel-button" type="button" style="min-width: 90px; ${loopActive}">
            <strong>Loop</strong>
          </button>
          <button id="dishGermReverseBtn" class="dish-pixel-button" type="button" style="min-width: 90px;">
            <strong>Reverse</strong>
          </button>
        </div>

        <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 16px; margin: 6px 0;">
          <div style="display: grid; gap: 4px;">
            <label style="font-size: 10px; letter-spacing: 0.1em; text-transform: uppercase; color: var(--dish-soft); font-weight: bold;">Volume</label>
            <input type="range" id="dishGermVolumeSlider" min="0" max="100" value="${Math.round(germ.volume * 100)}" style="width: 100%; accent-color: var(--dish-ink);" />
          </div>
          <div style="display: grid; gap: 4px;">
            <label style="font-size: 10px; letter-spacing: 0.1em; text-transform: uppercase; color: var(--dish-soft); font-weight: bold;">Pan</label>
            <input type="range" id="dishGermPanSlider" min="-100" max="100" value="${Math.round(germ.pan * 100)}" style="width: 100%; accent-color: var(--dish-ink);" />
          </div>
        </div>

        <div style="border-top: 1px dashed var(--dish-line); margin: 6px 0; opacity: 0.4;"></div>

        <div class="dish-settings-buttons" style="display: flex; flex-wrap: wrap; gap: 8px; justify-content: center;">
          <button id="dishGermNormalizeBtn" class="dish-pixel-button" type="button" style="min-width: 110px;">
            <strong>Normalize</strong>
          </button>
          <button id="dishGermFadeBtn" class="dish-pixel-button" type="button" style="min-width: 110px;">
            <strong>Fade</strong>
          </button>
          <button id="dishGermWarpBtn" class="dish-pixel-button" type="button" style="min-width: 110px;">
            <strong>Warp / Pitch</strong>
          </button>
        </div>
      </div>

      <div style="display: flex; gap: 12px; margin-top: 12px; z-index: 1;">
        <button id="dishGermBackBtn" class="dish-pixel-button" type="button" style="min-width: 100px;">
          <strong>Back</strong>
        </button>
        <button id="dishGermSaveBtn" class="dish-pixel-button" type="button" style="min-width: 100px; background: var(--dish-ink); color: var(--dish-panel-strong);">
          <strong>Close</strong>
        </button>
      </div>
      <button class="dish-cards-cancel" type="button" data-card-cancel>esc</button>
    </div>
  `;

  const canvas = document.getElementById("dishGermWaveformCanvas");

  let buffer = null;
  decodeAsset(asset).then(b => {
    buffer = b;
  });

  updateGermEditorPlayhead(canvas, () => buffer, germ);

  canvas.addEventListener("click", (e) => {
    if (!germ.audio || !Number.isFinite(germ.audio.duration) || germ.audio.duration <= 0) return;
    const rect = canvas.getBoundingClientRect();
    const clickX = e.clientX - rect.left;
    const percent = clickX / rect.width;
    germ.audio.currentTime = percent * germ.audio.duration;
  });

  document.getElementById("dishGermPlayBtn").addEventListener("click", () => {
    if (germ.audio) {
      if (germ.audio.paused) {
        attemptGermPlay(germ);
      } else {
        try { germ.audio.pause(); } catch {}
      }
    }
  });

  document.getElementById("dishGermLoopBtn").addEventListener("click", () => {
    germ.loop = !germ.loop;
    if (germ.audio) {
      germ.audio.loop = germ.loop;
    }
    saveDish();
    document.getElementById("dishGermLoopBtn").style.color = germ.loop ? "var(--ok, #3a8c5c)" : "";
  });

  document.getElementById("dishGermReverseBtn").addEventListener("click", () => {
    runGermAudioTool(germ, "reverse");
  });

  document.getElementById("dishGermNormalizeBtn").addEventListener("click", () => {
    runGermAudioTool(germ, "normalize");
  });

  document.getElementById("dishGermFadeBtn").addEventListener("click", () => {
    runGermAudioTool(germ, "fade");
  });

  document.getElementById("dishGermWarpBtn").addEventListener("click", () => {
    runGermTimePitch(germ);
  });

  document.getElementById("dishGermVolumeSlider").addEventListener("input", (e) => {
    germ.volume = Number(e.target.value) / 100;
    saveDish();
  });

  document.getElementById("dishGermPanSlider").addEventListener("input", (e) => {
    germ.pan = Number(e.target.value) / 100;
    saveDish();
  });

  document.getElementById("dishGermBackBtn").addEventListener("click", () => {
    germEditorActive = false;
    openGermContextMenu(germ, { x: germ.x, y: germ.y });
  });

  const closeBtn = document.getElementById("dishGermSaveBtn");
  const cancelBtn = host.querySelector("[data-card-cancel]");

  const closeEditor = () => {
    germEditorActive = false;
    host.hidden = true;
  };

  closeBtn.addEventListener("click", closeEditor);
  cancelBtn.addEventListener("click", closeEditor);
}

async function finishCardFlow() {
  if (!cardFlow) return;
  const { words, recipe, point } = cardFlow;
  cardFlow = null;
  if (germs.length >= MAX_POPULATION) {
    E.finishWork("Microcosmos Full", "muted", `Population limit ${MAX_POPULATION}. Harvest or pipe sources before spawning more.`);
    return;
  }
  const prompt = buildPromptFromGenome(words, recipe);
  const duration = RECIPE_DURATION[recipe] || 3;
  // Optimistic "spore" germ that breathes while Stable Audio works.
  const spore = makeGerm({ assetId: null, x: point.x, y: point.y, label: words.join(" "), genome: { words, recipe, traits: {} } });
  spore.state = "mutating";
  germs.push(spore);
  try {
    const payload = E.buildPayload({
      prompt,
      negative_prompt: "voice, singing, melody, music",
      duration,
      batch_size: 1,
      operation: "microcosmos_germinate",
      output_name: `microcosmos_${words.join("_").slice(0, 40)}`,
      lineage: {
        operation: "microcosmos_germinate",
        source_type: "microcosmos",
        mode: "microcosmos",
        source: "word_cards",
        prompt_genome: words,
        cards: words,
        microcosmos_position: { x: Math.round(point.x), y: Math.round(point.y) },
        visual_germ_type: spore.visual,
      },
    });
    const result = await E.api("/generate", { method: "POST", body: JSON.stringify(payload) });
    const audioPath = result?.audio_files?.[0];
    const metadataPath = result?.metadata_files?.[0];
    if (!audioPath) throw new Error(result?.error || "generation returned no audio");
    const asset = E.createAsset({
      audioPath,
      metadataPath,
      metadata: {
        prompt,
        duration,
        mode: "microcosmos",
        source: "word_cards",
        cards: words,
        microcosmos_position: { x: Math.round(spore.x), y: Math.round(spore.y) },
        visual_germ_type: spore.visual,
      },
      origin: "microcosmos",
    });
    spore.assetId = asset.id;
    spore.genome.traits = await profileTraits(audioPath, metadataPath);
    spore.state = "dormant";
    spore.label = words.join(" ");
    await setGermLiving(spore, true);
    spore.state = "living";
    pushEffect("spawn", spore.x, spore.y, { radius: spore.radius * 3, ttl: 0.9 });
    saveDish();
    E.finishWork("Germinated", "ok", prompt);
  } catch (error) {
    spore._touch = 6;
    germs = germs.filter((g) => g !== spore);
    E.finishWork("Germinate Error", "bad", error.message);
  }
}

// Seed visual/physics traits from the existing micro/matter analyzer.
async function profileTraits(audioPath, metadataPath) {
  try {
    const profile = await E.api("/micro/matter-profile", {
      method: "POST",
      body: JSON.stringify({ input_audio_path: audioPath, metadata_path: metadataPath || undefined, module: "microscope" }),
    });
    const d = profile?.descriptors || {};
    return {
      brightness: Math.max(0, Math.min(1, d.spectral_tissue?.centroid_mean ?? 0.5)),
      density: Math.max(0, Math.min(1, d.grain_density ?? 0.3)),
      energy: Math.max(0, Math.min(1, d.amplitude_body ?? 0.4)),
    };
  } catch {
    return { brightness: 0.5, density: 0.3, energy: 0.45 };
  }
}

// ---- Library item -> germ ------------------------------------------------
function addLibraryGerm(item, worldPoint) {
  if (germs.length >= MAX_POPULATION) {
    E.finishWork("Microcosmos Full", "muted", `Population limit ${MAX_POPULATION}.`);
    return;
  }
  const audioPath = item.audio_file || item.audioPath;
  if (!audioPath) return;
  const asset = E.createAsset({
    audioPath,
    metadataPath: item.metadata_file || item.metadataPath || "",
    metadata: item,
    origin: "microcosmos",
  });
  const germ = makeGerm({
    assetId: asset.id,
    x: worldPoint.x,
    y: worldPoint.y,
    label: item.prompt || item.id || "germ",
    genome: { words: (item.prompt || "").split(/\s+/).slice(0, 5), traits: {} },
  });
  germs.push(germ);
  pushEffect("spawn", germ.x, germ.y, { radius: germ.radius * 3, ttl: 0.9 });
  profileTraits(audioPath, item.metadata_file).then((t) => { germ.genome.traits = t; });
  saveDish();
}

function openLibraryPicker(worldPoint) {
  const ITEMS_PER_PAGE = 12;
  const allItems = (E.libraryItems() || []).filter((it) => it.audio_file && it.audio_exists !== false);
  const host = dom.cards;
  if (!host) return;

  // Collect unique modes for the filter dropdown
  const modes = [...new Set(allItems.map((it) => it.germinator_mode || it.mode || "").filter(Boolean))].sort();

  let searchQuery = "";
  let sortBy = "date";     // name | duration | date | family
  let filterMode = "";     // "" = all
  let currentPage = 0;

  function formatDuration(dur) {
    if (dur == null || dur === "") return "—";
    const s = Number(dur);
    if (isNaN(s)) return "—";
    const m = Math.floor(s / 60);
    const sec = Math.round(s % 60);
    return m > 0 ? `${m}:${String(sec).padStart(2, "0")}` : `${sec}s`;
  }

  function getFiltered() {
    let list = allItems;
    if (searchQuery) {
      const q = searchQuery.toLowerCase();
      list = list.filter((it) => {
        const hay = [it.prompt, it.id, it.model, it.germinator_mode, it.mode, it.audio_file].join(" ").toLowerCase();
        return hay.includes(q);
      });
    }
    if (filterMode) {
      list = list.filter((it) => (it.germinator_mode || it.mode || "") === filterMode);
    }
    // Sort
    if (sortBy === "name") {
      list = [...list].sort((a, b) => (a.prompt || a.id || "").localeCompare(b.prompt || b.id || ""));
    } else if (sortBy === "duration") {
      list = [...list].sort((a, b) => (Number(a.duration) || 0) - (Number(b.duration) || 0));
    } else if (sortBy === "date") {
      list = [...list].sort((a, b) => String(b.created_at || "").localeCompare(String(a.created_at || "")));
    } else if (sortBy === "family") {
      list = [...list].sort((a, b) => (a.germinator_mode || a.mode || "").localeCompare(b.germinator_mode || b.mode || ""));
    }
    return list;
  }

  function render() {
    const filtered = getFiltered();
    const totalPages = Math.max(1, Math.ceil(filtered.length / ITEMS_PER_PAGE));
    if (currentPage >= totalPages) currentPage = totalPages - 1;
    const start = currentPage * ITEMS_PER_PAGE;
    const pageItems = filtered.slice(start, start + ITEMS_PER_PAGE);

    host.hidden = false;
    host.innerHTML = `
      <div class="dish-cards-inner dish-library-picker">
        <span class="dish-cards-kicker">Add from library</span>
        <div class="dish-library-toolbar">
          <input type="text" class="dish-lib-search" placeholder="Search sounds…" value="${E.escapeHtml(searchQuery)}" />
          <select class="dish-lib-sort">
            <option value="date"${sortBy === "date" ? " selected" : ""}>Date</option>
            <option value="name"${sortBy === "name" ? " selected" : ""}>Name</option>
            <option value="duration"${sortBy === "duration" ? " selected" : ""}>Duration</option>
            <option value="family"${sortBy === "family" ? " selected" : ""}>Family</option>
          </select>
          <select class="dish-lib-filter">
            <option value="">All</option>
            ${modes.map((m) => `<option value="${E.escapeHtml(m)}"${filterMode === m ? " selected" : ""}>${E.escapeHtml(m)}</option>`).join("")}
          </select>
        </div>
        <div class="dish-library-list">
          ${pageItems.length ? pageItems.map((it, i) => `<button class="dish-library-row" type="button" data-lib-abs-index="${start + i}">
              <span class="dish-library-name">${E.escapeHtml(it.prompt || it.id || "sound")}</span>
              <span class="dish-library-dur">${formatDuration(it.duration)}</span>
              <span class="dish-library-mode">${E.escapeHtml(it.germinator_mode || it.mode || "")}</span>
            </button>`).join("") : '<div class="dish-library-empty">No sounds match.</div>'}
        </div>
        ${totalPages > 1 ? `<div class="dish-library-pagination">
          <button type="button" data-lib-page="prev" aria-label="Previous library page" title="Previous page" ${currentPage === 0 ? "disabled" : ""}>&larr;</button>
          <span>${currentPage + 1} / ${totalPages}</span>
          <button type="button" data-lib-page="next" aria-label="Next library page" title="Next page" ${currentPage >= totalPages - 1 ? "disabled" : ""}>&rarr;</button>
        </div>` : ""}
        <button class="dish-cards-cancel" type="button" data-card-cancel>esc</button>
      </div>`;

    // Wire events
    host.querySelectorAll("[data-lib-abs-index]").forEach((btn) => {
      btn.addEventListener("click", () => {
        const filtered2 = getFiltered();
        const idx = Number(btn.dataset.libAbsIndex);
        host.hidden = true;
        addLibraryGerm(filtered2[idx], worldPoint);
      });
    });

    const searchEl = host.querySelector(".dish-lib-search");
    if (searchEl) {
      searchEl.addEventListener("input", (ev) => {
        searchQuery = ev.target.value;
        currentPage = 0;
        render();
        // Re-focus after re-render
        const newSearch = host.querySelector(".dish-lib-search");
        if (newSearch) { newSearch.focus(); newSearch.selectionStart = newSearch.selectionEnd = newSearch.value.length; }
      });
    }

    const sortEl = host.querySelector(".dish-lib-sort");
    if (sortEl) {
      sortEl.addEventListener("change", (ev) => {
        sortBy = ev.target.value;
        currentPage = 0;
        render();
      });
    }

    const filterEl = host.querySelector(".dish-lib-filter");
    if (filterEl) {
      filterEl.addEventListener("change", (ev) => {
        filterMode = ev.target.value;
        currentPage = 0;
        render();
      });
    }

    host.querySelectorAll("[data-lib-page]").forEach((btn) => {
      btn.addEventListener("click", () => {
        if (btn.dataset.libPage === "prev" && currentPage > 0) currentPage--;
        else if (btn.dataset.libPage === "next") currentPage++;
        render();
      });
    });

    host.querySelector("[data-card-cancel]")?.addEventListener("click", () => { host.hidden = true; });
  }

  render();
}

// ---- Promote germ -> Full Mode (Chamber) ---------------------------------
function promoteGerm(germ) {
  if (!germ?.assetId) return;
  const asset = E.assetById(germ.assetId);
  if (!asset) return;
  E.createSoundNode({ asset, label: germ.label || "germ", edgeType: "lineage" });
  E.finishWork("Sent to Chamber", "ok", germ.label || "germ");
  E.activateTab("chamber");
}

function canvasPositionForGerm(germ) {
  const normalizedX = clamp((germ.x - (DISH.x - DISH.radius)) / (DISH.radius * 2), 0, 1);
  const normalizedY = clamp((germ.y - (DISH.y - DISH.radius)) / (DISH.radius * 2), 0, 1);
  return {
    x: 96 + normalizedX * 980,
    y: 96 + normalizedY * 620,
  };
}

function pipeGermToCanvas(germ, sourceModule = null, { activate = false } = {}) {
  if (!germ?.assetId) return null;
  const asset = E.assetById(germ.assetId);
  if (!asset) return null;
  const point = canvasPositionForGerm(germ);
  const node = E.createSoundNode({
    asset,
    label: germ.label || "germ",
    edgeType: "one_bit_pipe",
    x: point.x,
    y: point.y,
    metadata: {
      mode: "microcosmos",
      source: "microcosmos",
      legacySource: "one_bit_dish",
      transfer: "pipe_port",
      sourceModuleId: sourceModule?.id || null,
      germId: germ.id,
      words: germ.genome?.words || [],
      traits: germ.genome?.traits || {},
      parents: germ.parents || [],
      microcosmos_position: { x: Math.round(germ.x), y: Math.round(germ.y) },
      dishPosition: { x: Math.round(germ.x), y: Math.round(germ.y) },
    },
  });
  if (node) {
    node.loop = Boolean(germ.loop);
    node.volume = Number(germ.volume ?? 0.85);
    node.pan = Number(germ.pan ?? 0);
    E.saveCanvasState?.();
    pushEffect("pipe", germ.x, germ.y, { radius: germ.radius * 4, ttl: 1.1 });
    E.finishWork("Piped To Full Mode", "ok", germ.label || "germ");
    if (activate) E.activateTab("chamber");
  }
  return node;
}

function pipeSelectedToCanvas() {
  const selected = selectedGerm();
  if (selected?.assetId) {
    pipeGermToCanvas(selected, null, { activate: false });
    return;
  }
  if (selected && !selected.assetId) {
    E.finishWork("Germ Pending", "muted", "Wait for generation to finish before piping.");
    return;
  }
  const soundGerms = germs.filter((g) => g.assetId && E.assetById(g.assetId));
  if (germs.length && !soundGerms.length) {
    E.finishWork("Germ Pending", "muted", "Wait for generation to finish before piping.");
    return;
  }
  if (soundGerms.length === 1 && !selectedModule()) {
    pipeGermToCanvas(soundGerms[0], null, { activate: false });
    return;
  }
  const selectedMod = selectedModule();
  let target = null;
  if (selectedMod) {
    let nearest = null;
    for (const germ of soundGerms) {
      const distance = Math.hypot(germ.x - selectedMod.x, germ.y - selectedMod.y);
      if (!nearest || distance < nearest.distance) nearest = { germ, distance };
    }
    target = nearest ? pipeGermToCanvas(nearest.germ, selectedMod, { activate: false }) : null;
  }
  if (target && selectedMod && E.createFxNode) {
    const fxType = MODULE_CANVAS_FX[selectedMod.type] || "microscope";
    E.createFxNode({
      type: fxType,
      targetNode: target,
      x: target.x + 340,
      y: target.y,
      label: `${MODULE_DEFS[selectedMod.type]?.label || selectedMod.type} field`,
      metadata: { mode: "microcosmos", source: "microcosmos", legacySource: "one_bit_dish", transfer: "pipe_port", moduleId: selectedMod.id, moduleType: selectedMod.type },
    });
    E.saveCanvasState?.();
    E.finishWork("Module Piped", "ok", MODULE_DEFS[selectedMod.type]?.label || selectedMod.type);
    return;
  }
  expandDishToCanvas({ activate: false, requireConfirm: false });
}

function clearQueuedGeneration() {
  generationEpoch += 1;
  generationQueue.length = 0;
  if (generationTimer) {
    window.clearTimeout(generationTimer);
    generationTimer = null;
  }
  generationActive = 0;
  pairCooldown.clear();
  lastBreedAt = 0;
  updateHud();
}

function resetDish() {
  const elementCount = germs.length + modules.length;
  const now = performanceNow();
  if (elementCount && now > resetArmedUntil) {
    resetArmedUntil = now + 3200;
    dom.resetBtn?.classList.add("is-armed");
    E.finishWork("Clear Armed", "muted", "Click Clear again to delete all Microcosmos elements.");
    window.setTimeout(() => {
      if (performanceNow() > resetArmedUntil) dom.resetBtn?.classList.remove("is-armed");
    }, 3300);
    return;
  }
  resetArmedUntil = 0;
  dom.resetBtn?.classList.remove("is-armed");
  stopHarvest();
  clearQueuedGeneration();
  const dispersing = germs.map((g) => ({ x: g.x, y: g.y, r: g.radius }));
  germs.forEach(disposeGermAudio);
  germs = [];
  modules = [];
  effects = [];
  dispersing.forEach((d) => pushEffect("disperse", d.x, d.y, { radius: d.r * 3, ttl: 0.9 }));
  _selectedGermId = null;
  _selectedModuleId = null;
  _hoveredGermId = null;
  _hoveredModuleId = null;
  pointer = { dragging: null, draggingModule: null, panning: false, lastX: 0, lastY: 0, downX: 0, downY: 0, moved: false };
  cardFlow = null;
  modulePalettePoint = null;
  camera = { x: WORLD.w / 2, y: WORLD.h / 2, zoom: DEFAULT_ZOOM };
  syncCameraTarget();
  microMode = "world";
  if (dom.cards) {
    dom.cards.hidden = true;
    dom.cards.innerHTML = "";
  }
  try { localStorage.removeItem(STORAGE_KEY); } catch { /* storage unavailable */ }
  syncControls();
  updateHud();
  draw();
  E.finishWork("Microcosmos Reset", "ok", "Generated files remain in the library.");
}

function nearestConvertedSound(module, converted) {
  let best = null;
  for (const item of converted) {
    const distance = Math.hypot(item.germ.x - module.x, item.germ.y - module.y);
    if (!best || distance < best.distance) best = { ...item, distance };
  }
  return best?.node || null;
}

function expandDishToCanvas({ activate = true, requireConfirm = false } = {}) {
  const soundGerms = germs.filter((g) => g.assetId && E.assetById(g.assetId));
  if (!soundGerms.length) {
    E.finishWork("Scope Empty", "muted", "No saved sound germs to expand.");
    return;
  }
  if (requireConfirm && !window.confirm("Expand this Microcosmos scope into the Chamber? Current germs and field modules will be added as editable canvas nodes.")) return;

  const sorted = [...soundGerms].sort((a, b) => (a.y - b.y) || (a.x - b.x));
  const columns = Math.min(3, Math.max(1, Math.ceil(Math.sqrt(sorted.length))));
  const startX = 96;
  const startY = 104;
  const colW = 404;
  const rowH = 312;
  const converted = [];
  sorted.forEach((germ, index) => {
    const asset = E.assetById(germ.assetId);
    const x = startX + (index % columns) * colW;
    const y = startY + Math.floor(index / columns) * rowH;
    const node = E.createSoundNode({
      asset,
      label: germ.label || "germ",
      edgeType: "one_bit_expand",
      x,
      y,
      metadata: {
        mode: "microcosmos",
        source: "microcosmos",
        legacySource: "one_bit_dish",
        germId: germ.id,
        words: germ.genome?.words || [],
        traits: germ.genome?.traits || {},
        parents: germ.parents || [],
        microcosmos_position: { x: Math.round(germ.x), y: Math.round(germ.y) },
        dishPosition: { x: Math.round(germ.x), y: Math.round(germ.y) },
      },
    });
    if (node) {
      node.loop = Boolean(germ.loop);
      node.volume = Number(germ.volume ?? 0.85);
      node.pan = Number(germ.pan ?? 0);
      converted.push({ germ, node });
    }
  });

  let convertedModules = 0;
  modules.forEach((module, index) => {
    const targetNode = nearestConvertedSound(module, converted);
    if (!targetNode || !E.createFxNode) return;
    const fxType = MODULE_CANVAS_FX[module.type] || "microscope";
    const def = MODULE_DEFS[module.type] || { label: module.type };
    const node = E.createFxNode({
      type: fxType,
      targetNode,
      x: targetNode.x + 398,
      y: targetNode.y + 18 + (index % 3) * 34,
      label: `${def.label} field`,
      metadata: {
        mode: "microcosmos",
        source: "microcosmos",
        legacySource: "one_bit_dish",
        moduleId: module.id,
        moduleType: module.type,
        radius: module.radius,
        microcosmos_position: { x: Math.round(module.x), y: Math.round(module.y) },
        dishPosition: { x: Math.round(module.x), y: Math.round(module.y) },
      },
    });
    if (node) convertedModules += 1;
  });

  E.saveCanvasState?.();
  if (activate) E.activateTab("chamber");
  E.finishWork(
    "Microcosmos Expanded",
    "ok",
    `${converted.length} sound ${converted.length === 1 ? "node" : "nodes"}${convertedModules ? ` · ${convertedModules} module ${convertedModules === 1 ? "node" : "nodes"}` : ""}`,
  );
}

// ---- Harvest: record Microcosmos (via master bus) into a new source ------
let harvestRec = null;
function livingGermSummaries(scope = null) {
  return germs
    .filter((g) => g.state === "living" && (!scope?.scoped || scope.germIds.has(g.id)))
    .map((g) => ({
      id: g.id,
      assetId: g.assetId,
      label: g.label,
      x: Math.round(g.x),
      y: Math.round(g.y),
      words: g.genome?.words || [],
    }));
}

function currentHarvestScope() {
  if (harvestScope !== "scope") return { scoped: false, germIds: new Set(germs.filter((g) => g.state === "living").map((g) => g.id)) };
  const selected = selectedGerm();
  const v = viewSize();
  const radius = Math.max(180, (Math.hypot(v.w, v.h) / 2) / camera.zoom * 0.62);
  const center = selected || camera;
  let scoped = germs.filter((g) => g.state === "living" && Math.hypot(g.x - center.x, g.y - center.y) <= radius);
  if (!scoped.length && selected) scoped = [selected];
  if (!scoped.length) scoped = germs.filter((g) => g.state === "living");
  return { scoped: true, radius, center: { x: center.x, y: center.y }, germIds: new Set(scoped.map((g) => g.id)) };
}

function recordCameraPathPoint() {
  if (!harvestRec?.cameraPath) return;
  const now = performance.now();
  if (now - (harvestRec.lastCameraAt || 0) < 180) return;
  harvestRec.lastCameraAt = now;
  harvestRec.cameraPath.push({
    t: Math.max(0, (now - harvestRec.startedAt) / 1000),
    x: Math.round(camera.x),
    y: Math.round(camera.y),
    zoom: Number(camera.zoom.toFixed(3)),
  });
}

async function toggleHarvest() {
  if (harvestRec) { stopHarvest(); return; }
  const context = E.playbackContext();
  if (!context) { E.finishWork("Harvest Error", "bad", "Recording unavailable."); return; }
  if (context.state === "suspended") { try { await context.resume(); } catch {} }
  const bus = E.ensureMasterBus();
  const scope = currentHarvestScope();
  const recordingState = { scope, cameraPath: [], startedAt: performance.now(), lastCameraAt: 0 };

  const commitHarvest = async (blob, extension) => {
    if (!blob?.size) { E.finishWork("Harvest Empty", "bad", "No audio captured."); return; }
    try {
      const meta = {
        mode: "microcosmos",
        operation: "microcosmos_harvest",
        source_type: "microcosmos",
        germinator_mode: "harvest",
        recording_format: extension === "wav" ? "wav-pcm16" : "webm-opus",
        harvest_type: scope.scoped ? "visible_scope" : "whole_world",
        germs: livingGermSummaries(scope),
        modules: modules.map((m) => ({ id: m.id, type: m.type, x: Math.round(m.x), y: Math.round(m.y), radius: m.radius })),
        harvest_scope: {
          scoped: scope.scoped,
          radius: scope.radius || null,
          center: scope.center || null,
        },
        camera_path: recordingState.cameraPath || [],
        lineage: { operation: "microcosmos_harvest", source_type: "microcosmos", mode: "microcosmos", parents: livingGermSummaries(scope).map((g) => g.assetId).filter(Boolean) },
      };
      const result = await E.importAudioBlob(blob, meta, `microcosmos_harvest_${Date.now()}.${extension}`);
      const audioPath = result?.audio_files?.[0];
      if (audioPath) {
        const asset = E.createAsset({ audioPath, metadataPath: result.metadata_files?.[0], metadata: meta, origin: "microcosmos" });
        const center = camera;
        germs.push(makeGerm({ assetId: asset.id, x: center.x + 60, y: center.y, label: "harvest", genome: { words: ["harvest"], traits: { energy: 0.6 } } }));
        saveDish();
      }
      E.finishWork("Harvested", "ok", "Microcosmos rendered into a new source.");
    } catch (error) {
      E.finishWork("Harvest Error", "bad", error.message);
    }
  };

  // Lossless-first: PCM tap on the master output → WAV. MediaRecorder
  // webm/opus remains the fallback when worklets are unavailable.
  const wavRecorder = E.createMasterWavRecorder ? await E.createMasterWavRecorder().catch(() => null) : null;
  if (wavRecorder) {
    recordingState.kind = "wav";
    recordingState.wavRecorder = wavRecorder;
    recordingState.commit = commitHarvest;
    wavRecorder.start();
  } else if (typeof MediaRecorder !== "undefined") {
    const dest = context.createMediaStreamDestination();
    (bus.output || bus.gain).connect(dest);
    const mime = MediaRecorder.isTypeSupported?.("audio/webm;codecs=opus") ? "audio/webm;codecs=opus" : "audio/webm";
    const recorder = new MediaRecorder(dest.stream, { mimeType: mime });
    const chunks = [];
    recorder.ondataavailable = (e) => { if (e.data?.size) chunks.push(e.data); };
    recorder.onstop = async () => {
      try { (bus.output || bus.gain).disconnect(dest); } catch {}
      await commitHarvest(new Blob(chunks, { type: mime }), "webm");
    };
    recorder.start(250);
    recordingState.kind = "webm";
    recordingState.recorder = recorder;
    recordingState.dest = dest;
  } else {
    E.finishWork("Harvest Error", "bad", "Recording unavailable.");
    return;
  }
  harvestRec = recordingState;
  dom.harvestBtn?.classList.add("is-active");
  recordCameraPathPoint();
  E.finishWork("Recording Microcosmos", "ok", scope.scoped ? "Scoped cluster capture active." : "Move the scope to perform. Click harvest again to stop.");
}
function stopHarvest() {
  if (!harvestRec) return;
  const rec = harvestRec;
  harvestRec = null;
  dom.harvestBtn?.classList.remove("is-active");
  if (rec.kind === "wav" && rec.wavRecorder) {
    rec.wavRecorder.stop()
      .then((captured) => rec.commit(captured?.blob, "wav"))
      .catch((error) => E.finishWork("Harvest Error", "bad", error.message));
    return;
  }
  try { if (rec.recorder && rec.recorder.state !== "inactive") rec.recorder.stop(); } catch {}
}

function toggleAllLiving() {
  const anyLiving = germs.some((g) => g.state === "living");
  germs.forEach((g) => {
    if (!g.assetId) return;
    setGermLiving(g, !anyLiving);
  });
  saveDish();
}

function randomizeDish() {
  germs.forEach((g) => {
    const a = Math.random() * Math.PI * 2;
    const rr = Math.sqrt(Math.random()) * DISH.radius * 0.82;
    g.x = clamp(DISH.x + Math.cos(a) * rr, 0, WORLD.w);
    g.y = clamp(DISH.y + Math.sin(a) * rr, 0, WORLD.h);
    g.vx = (Math.random() - 0.5) * 1.8;
    g.vy = (Math.random() - 0.5) * 1.8;
    g.trail = [];
  });
  modules.forEach((mod) => {
    const a = Math.random() * Math.PI * 2;
    const rr = Math.sqrt(Math.random()) * DISH.radius * 0.68;
    mod.x = clamp(DISH.x + Math.cos(a) * rr, 0, WORLD.w);
    mod.y = clamp(DISH.y + Math.sin(a) * rr, 0, WORLD.h);
  });
  pushEffect("module", camera.x, camera.y, { radius: 160, ttl: 0.75 });
  saveDish();
  E.finishWork("Microcosmos Randomized", "ok", "Germs and modules moved through the world.");
}

// ---- Persistence ---------------------------------------------------------
function dishSnapshotState() {
  return {
    version: 2,
    camera: { ...camera },
    microMode,
    energy: energyLevel,
    chemistry,
    harvestScope,
    gravity,
    viscosity,
    modules: modules.map((m) => ({
      id: m.id,
      type: m.type,
      x: m.x,
      y: m.y,
      radius: m.radius,
      loop: m.loop !== false,
      params: m.params || {},
    })),
    germs: germs.filter((g) => g.assetId).map((g) => ({
      id: g.id, assetId: g.assetId, x: g.x, y: g.y, label: g.label,
      state: g.state === "mutating" ? "dormant" : g.state, volume: g.volume,
      genome: g.genome, parents: g.parents,
    })),
  };
}

function saveDish() {
  try {
    const data = dishSnapshotState();
    localStorage.setItem(STORAGE_KEY, JSON.stringify(data));
  } catch { /* storage full / disabled */ }
}
function loadDish() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return;
    const data = JSON.parse(raw);
    if (data.camera) camera = { ...camera, ...data.camera };
    if (data.version !== 2 || !Number.isFinite(Number(camera.zoom))) camera.zoom = DEFAULT_ZOOM;
    syncCameraTarget();
    microMode = "world";
    if (data.energy) energyLevel = data.energy;
    if (data.chemistry) chemistry = data.chemistry;
    harvestScope = dom.harvestScopeSel?.value || "scope";
    if (Number.isFinite(Number(data.gravity))) gravity = Number(data.gravity);
    if (Number.isFinite(Number(data.viscosity))) viscosity = Number(data.viscosity);
    modules = (data.modules || []).filter((m) => MODULE_DEFS[m.type]).map((m) => ({
      ...makeModule(m.type, Number(m.x) || camera.x, Number(m.y) || camera.y),
      id: m.id || uid("module"),
      radius: Number(m.radius) || MODULE_DEFS[m.type].radius,
      loop: m.loop !== false,
      params: m.params || {},
      cooldowns: {},
    }));
    germs = (data.germs || []).filter((g) => g.assetId && E.assetById(g.assetId)).map((g) => ({
      ...makeGerm({ assetId: g.assetId, x: g.x, y: g.y, label: g.label, genome: g.genome, parents: g.parents }),
      id: g.id, volume: g.volume ?? 0.85, state: "dormant",
    }));
  } catch (error) {
    console.warn("Microcosmos: stored dish state was unreadable; starting fresh.", error);
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (raw) localStorage.setItem(`${STORAGE_KEY}-corrupt`, raw);
    } catch { /* storage unavailable */ }
    germs = [];
    showCorruptDishRecovery();
  }
}

async function saveBiome() {
  saveDish();
  const name = window.prompt("Biome name", `biome-${new Date().toISOString().slice(0, 10)}`);
  if (!name) return;
  const result = await E.api("/micro/biomes", {
    method: "POST",
    body: JSON.stringify({ name, state: dishSnapshotState() }),
  });
  E.finishWork?.("Biome Saved", "ok", result.biome?.name || name);
}

async function loadBiome(biomeId) {
  const result = await E.api(`/micro/biomes/${encodeURIComponent(biomeId)}`);
  stopHarvest();
  clearQueuedGeneration();
  germs.forEach(disposeGermAudio);
  germs = [];
  modules = [];
  effects = [];
  localStorage.setItem(STORAGE_KEY, JSON.stringify(result.state || {}));
  loadDish();
  syncControls();
  saveDish();
  E.finishWork?.("Biome Loaded", "ok", result.biome?.name || biomeId);
}

async function deleteBiome(biomeId) {
  if (!window.confirm(`Delete biome "${biomeId}"?`)) return;
  await E.api(`/micro/biomes/${encodeURIComponent(biomeId)}`, { method: "DELETE" });
  E.finishWork?.("Biome Deleted", "ok", biomeId);
  openBiomeLibrary();
}

async function openBiomeLibrary() {
  const host = dom.cards;
  if (!host) return;
  host.hidden = false;
  host.innerHTML = `
    <div class="dish-cards-inner" style="max-width: 680px; width: 94%;">
      <span class="dish-cards-kicker">Biomes</span>
      <div style="display: flex; gap: 10px; flex-wrap: wrap; justify-content: center;">
        <button id="dishSaveBiomeBtn" class="dish-pixel-button" type="button">Save Current</button>
      </div>
      <div id="dishBiomeList" class="dish-module-grid" style="width: 100%; grid-template-columns: repeat(auto-fit, minmax(180px, 1fr));"></div>
      <button class="dish-cards-cancel" type="button" data-card-cancel>esc</button>
    </div>`;
  host.querySelector("[data-card-cancel]")?.addEventListener("click", () => { host.hidden = true; });
  host.querySelector("#dishSaveBiomeBtn")?.addEventListener("click", () => {
    saveBiome().then(openBiomeLibrary).catch((error) => E.finishWork?.("Biome Error", "bad", error.message));
  });
  const list = host.querySelector("#dishBiomeList");
  try {
    const biomes = await E.api("/micro/biomes");
    list.innerHTML = (biomes || []).map((biome) => `
      <div class="dish-module-card" style="cursor: default;">
        <strong>${E.escapeHtml(biome.name)}<span>${biome.germ_count} germ(s) / ${biome.module_count} module(s)</span></strong>
        <div style="display: flex; gap: 6px; flex-wrap: wrap; grid-column: 1 / -1;">
          <button class="dish-pixel-button" type="button" data-biome-load="${E.escapeHtml(biome.id)}">Load</button>
          <button class="dish-pixel-button" type="button" data-biome-delete="${E.escapeHtml(biome.id)}">Delete</button>
        </div>
      </div>
    `).join("") || `<span class="dish-cards-trail">No saved biomes</span>`;
    list.querySelectorAll("[data-biome-load]").forEach((btn) => {
      btn.addEventListener("click", () => loadBiome(btn.dataset.biomeLoad).catch((error) => E.finishWork?.("Biome Error", "bad", error.message)));
    });
    list.querySelectorAll("[data-biome-delete]").forEach((btn) => {
      btn.addEventListener("click", () => deleteBiome(btn.dataset.biomeDelete).catch((error) => E.finishWork?.("Biome Error", "bad", error.message)));
    });
  } catch (error) {
    list.innerHTML = `<span class="dish-cards-trail">${E.escapeHtml(error.message)}</span>`;
  }
}

function showCorruptDishRecovery() {
  const host = dom.cards;
  if (!host) {
    E.finishWork?.("Microcosmos Reset", "bad", "Stored dish state was unreadable.");
    return;
  }
  host.hidden = false;
  host.innerHTML = `
    <div class="dish-cards-inner">
      <span class="dish-cards-kicker">Microcosmos Recovery</span>
      <h3 style="margin: 0; font-size: 18px;">Stored dish state could not be read</h3>
      <p style="margin: 0; color: var(--dish-soft); font-size: 13px; line-height: 1.45;">A raw backup was preserved locally. Restore it if you want to inspect it later, or discard it and continue with a clean dish.</p>
      <div style="display: flex; gap: 10px; flex-wrap: wrap;">
        <button id="dishRestoreCorruptBtn" class="dish-pixel-button" type="button">Restore Raw</button>
        <button id="dishDiscardCorruptBtn" class="dish-pixel-button" type="button">Discard</button>
      </div>
    </div>`;
  document.getElementById("dishRestoreCorruptBtn")?.addEventListener("click", () => {
    try {
      const raw = localStorage.getItem(`${STORAGE_KEY}-corrupt`);
      if (raw) localStorage.setItem(STORAGE_KEY, raw);
    } catch { /* storage unavailable */ }
    host.hidden = true;
    E.finishWork?.("Raw Backup Restored", "ok", "Reload Microcosmos to retry the saved state.");
  });
  document.getElementById("dishDiscardCorruptBtn")?.addEventListener("click", () => {
    try {
      localStorage.removeItem(STORAGE_KEY);
      localStorage.removeItem(`${STORAGE_KEY}-corrupt`);
    } catch { /* storage unavailable */ }
    host.hidden = true;
    E.finishWork?.("Corrupt Backup Discarded", "ok", "Microcosmos is using a clean state.");
  });
}

// ---- Pointer / interaction ----------------------------------------------
function bindPointer() {
  const c = dom.canvas;
  if (!c) return;
  c.addEventListener("pointerdown", (e) => {
    if (e.button !== 0) return;
    try { c.setPointerCapture?.(e.pointerId); } catch { /* synthetic / inactive pointer */ }
	    pointer.downX = e.clientX; pointer.downY = e.clientY; pointer.lastX = e.clientX; pointer.lastY = e.clientY; pointer.moved = false;
	    const rect = c.getBoundingClientRect();
	    const g = germAt(e.clientX - rect.left, e.clientY - rect.top);
	    const mod = g ? null : moduleAt(e.clientX - rect.left, e.clientY - rect.top);
	    if (g) { pointer.dragging = g; pointer.draggingModule = null; _selectedGermId = g.id; _selectedModuleId = null; }
	    else if (mod) { pointer.draggingModule = mod; pointer.dragging = null; _selectedModuleId = mod.id; _selectedGermId = null; }
	    else { pointer.panning = true; _selectedModuleId = null; }
	  });
	  c.addEventListener("pointermove", (e) => {
    const dx = e.clientX - pointer.lastX, dy = e.clientY - pointer.lastY;
    if (Math.abs(e.clientX - pointer.downX) + Math.abs(e.clientY - pointer.downY) > 4) pointer.moved = true;
    pointer.lastX = e.clientX; pointer.lastY = e.clientY;
    const rect = c.getBoundingClientRect();
	    if (pointer.dragging) {
	      pointer.dragging.x += dx / camera.zoom;
	      pointer.dragging.y += dy / camera.zoom;
	      pointer.dragging.vx = dx / camera.zoom * 0.2;
	      pointer.dragging.vy = dy / camera.zoom * 0.2;
	    } else if (pointer.draggingModule) {
	      pointer.draggingModule.x += dx / camera.zoom;
	      pointer.draggingModule.y += dy / camera.zoom;
	      pointer.draggingModule.x = Math.max(0, Math.min(WORLD.w, pointer.draggingModule.x));
	      pointer.draggingModule.y = Math.max(0, Math.min(WORLD.h, pointer.draggingModule.y));
	    } else if (pointer.panning) {
      setCameraTarget({
        x: cameraTarget.x - dx / camera.zoom,
        y: cameraTarget.y - dy / camera.zoom,
      });
    } else {
      const g = germAt(e.clientX - rect.left, e.clientY - rect.top);
      const mod = g ? null : moduleAt(e.clientX - rect.left, e.clientY - rect.top);
      _hoveredGermId = g?.id || null;
      _hoveredModuleId = mod?.id || null;
    }
  });
  c.addEventListener("pointerup", (e) => {
    if (e.button !== 0) return;
    const rect = c.getBoundingClientRect();
    if (!pointer.moved) {
      const g = germAt(e.clientX - rect.left, e.clientY - rect.top);
	      const mod = g ? null : moduleAt(e.clientX - rect.left, e.clientY - rect.top);
	      if (g) {
	        if (e.altKey) sporeGerm(g);
	        else setGermLiving(g, g.state !== "living");
	        saveDish();
	      } else if (mod) {
	        _selectedModuleId = mod.id;
	        if (e.altKey) {
	          modules = modules.filter((item) => item !== mod);
	          _selectedModuleId = null;
	          saveDish();
	          updateHud();
	        } else {
	          openModuleContextMenu(mod);
	        }
	      } else { openLeftClickMenu(screenToWorld(e.clientX - rect.left, e.clientY - rect.top)); }
	    } else if (pointer.dragging || pointer.draggingModule) { saveDish(); }
	    pointer.dragging = null; pointer.draggingModule = null; pointer.panning = false;
	  });
  c.addEventListener("dblclick", (e) => {
    if (e.button !== 0) return;
    const rect = c.getBoundingClientRect();
    const g = germAt(e.clientX - rect.left, e.clientY - rect.top);
    if (g) promoteGerm(g);
    else {
      setMicroMode("world", { focus: screenToWorld(e.clientX - rect.left, e.clientY - rect.top) });
      saveDish();
    }
  });
	  c.addEventListener("wheel", (e) => {
    e.preventDefault();
    const rect = c.getBoundingClientRect();
    const sx = e.clientX - rect.left;
    const sy = e.clientY - rect.top;
    const before = screenToWorld(sx, sy);
    const factor = Math.min(1.08, Math.max(0.92, Math.exp(-e.deltaY * 0.0015)));
    const nextZoom = clamp(cameraTarget.zoom * factor, MICRO_MIN_ZOOM, MICRO_MAX_ZOOM);
    const v = viewSize();
    const after = { x: (sx - v.w / 2) / nextZoom + cameraTarget.x, y: (sy - v.h / 2) / nextZoom + cameraTarget.y };
    setCameraTarget({
      zoom: nextZoom,
      x: cameraTarget.x + before.x - after.x,
      y: cameraTarget.y + before.y - after.y,
    });
	  }, { passive: false });
	  c.addEventListener("contextmenu", (e) => {
	    e.preventDefault();
	    const rect = c.getBoundingClientRect();
	    const localX = e.clientX - rect.left;
	    const localY = e.clientY - rect.top;
	    const g = germAt(localX, localY);
	    const mod = g ? null : moduleAt(localX, localY);
	    if (g && g.assetId) {
	      openGermContextMenu(g, screenToWorld(localX, localY));
	    } else if (mod) {
	      openModuleContextMenu(mod);
	    } else {
	      openModulePalette(screenToWorld(localX, localY));
	    }
	  });
  c.addEventListener("pointerleave", () => {
    _hoveredGermId = null;
    _hoveredModuleId = null;
  });
	  c.addEventListener("keydown", (e) => {
	    const panStep = 80 / camera.zoom;
	    if (e.key === "ArrowLeft") { setCameraTarget({ x: cameraTarget.x - panStep }); e.preventDefault(); }
	    else if (e.key === "ArrowRight") { setCameraTarget({ x: cameraTarget.x + panStep }); e.preventDefault(); }
	    else if (e.key === "ArrowUp") { setCameraTarget({ y: cameraTarget.y - panStep }); e.preventDefault(); }
	    else if (e.key === "ArrowDown") { setCameraTarget({ y: cameraTarget.y + panStep }); e.preventDefault(); }
	    else if (e.key === "+" || e.key === "=") { setCameraTarget({ zoom: cameraTarget.zoom * 1.08 }); e.preventDefault(); }
	    else if (e.key === "-" || e.key === "_") { setCameraTarget({ zoom: cameraTarget.zoom / 1.08 }); e.preventDefault(); }
	    else if (e.key === " ") {
	      const g = selectedGerm();
	      if (g) setGermLiving(g, g.state !== "living");
	      else toggleAllLiving();
	      e.preventDefault();
	    }
	    else if (e.key === "Backspace" || e.key === "Delete") {
	      if (selectedGerm()) {
	        const g = selectedGerm();
	        disposeGermAudio(g);
	        germs = germs.filter((item) => item !== g);
	        _selectedGermId = null;
	      } else if (selectedModule()) {
	        const mod = selectedModule();
	        modules = modules.filter((item) => item !== mod);
	        _selectedModuleId = null;
	      }
	      saveDish();
	      e.preventDefault();
	    } else if (e.key.toLowerCase() === "h") {
	      toggleHelp(true);
	      e.preventDefault();
	    } else if (e.key.toLowerCase() === "r") {
	      randomizeDish();
	      e.preventDefault();
	    } else if (e.key.toLowerCase() === "c") {
	      resetDish();
	      e.preventDefault();
	    } else if (e.key === "Tab") {
	      openModulePalette({ x: cameraTarget.x, y: cameraTarget.y });
	      e.preventDefault();
	    } else if (e.key === "1") {
	      openLibraryPicker({ x: cameraTarget.x, y: cameraTarget.y });
	      e.preventDefault();
	    } else if (e.key.toLowerCase() === "w" || e.key === "Enter") {
	      toggleMicroMode();
	      e.preventDefault();
	    }
	    clampCamera(cameraTarget);
	  });
	}

// ---- Lifecycle -----------------------------------------------------------
function syncControls() {
  dom.panel?.classList.toggle("is-deep", microMode === "world");
  if (dom.worldLabel) dom.worldLabel.textContent = microMode === "world" ? "Scope" : "World";
  if (dom.expandBtn) {
    dom.expandBtn.classList.toggle("is-active", microMode === "world");
    dom.expandBtn.setAttribute("aria-label", microMode === "world" ? "Return to Scope" : "Enter Microcosmos World");
    dom.expandBtn.title = microMode === "world" ? "Return to Scope" : "Enter Microcosmos World";
  }
  if (dom.harvestScopeSel) dom.harvestScopeSel.value = harvestScope;
  if (dom.gravityInput) dom.gravityInput.value = String(gravity);
  if (dom.viscosityInput) dom.viscosityInput.value = String(viscosity);
  (dom.chemistryButtons || []).forEach((btn) => {
    btn.classList.toggle("is-active", btn.dataset.dishChemistry === chemistry);
  });
  (dom.energyButtons || []).forEach((btn) => {
    btn.classList.toggle("is-active", btn.dataset.dishEnergy === energyLevel);
  });
  const modeText = {
    bounce: "collisions make short ripples",
    infect: "collisions exchange genome words",
    breed: "compatible collisions create children",
  }[chemistry] || "collisions make short ripples";
  if (dom.modeLabel) dom.modeLabel.textContent = modeText;
}

function toggleHelp(force) {
  if (!dom.help) return;
  const next = typeof force === "boolean" ? force : dom.help.hidden;
  dom.help.hidden = !next;
}

function enter() {
  if (running) return;
  resizeCanvas();
  if (!germs.length) loadDish();
  if (!cameraTarget) syncCameraTarget();
  syncControls();
  if (dom.help) dom.help.hidden = true;
  running = true;
  hudElapsed = 0.12;
  lastFrame = performance.now();
  rafHandle = requestAnimationFrame(frame);
}
function exit() {
  running = false;
  if (rafHandle) cancelAnimationFrame(rafHandle);
  rafHandle = null;
  stopHarvest();
  toggleHelp(false);
  // Pause germ audio when leaving Microcosmos.
  germs.forEach((g) => { if (g.audio && !g.audio.paused) { try { g.audio.pause(); } catch {} } });
}

export function initOneBitDish(engine) {
  E = engine;
  dom = {
    panel: document.getElementById("tab-onebit"),
    canvas: document.getElementById("dishCanvas"),
    cards: document.getElementById("dishCards"),
    count: document.getElementById("dishCount"),
    empty: document.getElementById("dishEmpty"),
    addBtn: document.getElementById("dishAddBtn"),
    libraryBtn: document.getElementById("dishLibraryBtn"),
    moduleBtn: document.getElementById("dishModuleBtn"),
    harvestBtn: document.getElementById("dishHarvestBtn"),
    expandBtn: document.getElementById("dishExpandBtn"),
    worldLabel: document.getElementById("dishWorldLabel"),
    pipeBtn: document.getElementById("dishPipeBtn"),
    biomeBtn: document.getElementById("dishBiomeBtn"),
    spectatorBtn: document.getElementById("dishSpectatorBtn"),
    resetBtn: document.getElementById("dishResetBtn"),
    settingsBtn: document.getElementById("dishSettingsBtn"),
    exitBtn: document.getElementById("dishExitBtn"),
    help: document.getElementById("dishHelp"),
    helpBtn: document.getElementById("dishHelpBtn"),
    helpClose: document.getElementById("dishHelpClose"),
    harvestScopeSel: document.getElementById("dishHarvestScope"),
    gravityInput: document.getElementById("dishGravity"),
    viscosityInput: document.getElementById("dishViscosity"),
    population: document.getElementById("dishPopulation"),
    vitality: document.getElementById("dishVitality"),
    nutrients: document.getElementById("dishNutrients"),
    temperature: document.getElementById("dishTemperature"),
    zoom: document.getElementById("dishZoom"),
    modeLabel: document.getElementById("dishModeLabel"),
  };
  if (!dom.canvas) return null;
  dom.chemistryButtons = [...document.querySelectorAll("[data-dish-chemistry]")];
  dom.energyButtons = [...document.querySelectorAll("[data-dish-energy]")];
  dom.moduleButtons = [...document.querySelectorAll("[data-dish-module]")];
  resizeCanvas();
  microRenderer = createMicroRenderer({ getCtx: () => ctx2d, getDpr: () => dpr, getDark: isDark });
  bindPointer();
  window.addEventListener("resize", () => { if (running) resizeCanvas(); });
  dom.addBtn?.addEventListener("click", () => openLeftClickMenu({ x: cameraTarget.x, y: cameraTarget.y }));
  dom.libraryBtn?.addEventListener("click", () => openLibraryPicker({ x: cameraTarget.x + 40, y: cameraTarget.y }));
  dom.moduleBtn?.addEventListener("click", () => openModulePalette({ x: cameraTarget.x - 40, y: cameraTarget.y }));
  dom.harvestBtn?.addEventListener("click", () => toggleHarvest());
  dom.expandBtn?.addEventListener("click", () => toggleMicroMode());
  dom.pipeBtn?.addEventListener("click", () => pipeSelectedToCanvas());
  dom.biomeBtn?.addEventListener("click", () => openBiomeLibrary().catch((error) => E.finishWork?.("Biome Error", "bad", error.message)));
  dom.spectatorBtn?.addEventListener("click", () => toggleSpectatorMode());
  dom.resetBtn?.addEventListener("click", () => resetDish());
  dom.settingsBtn?.addEventListener("click", () => openMicrocosmosSettings());
  dom.exitBtn?.addEventListener("click", () => E.activateTab("chamber"));
  dom.helpBtn?.addEventListener("click", () => toggleHelp(true));
  dom.helpClose?.addEventListener("click", () => toggleHelp(false));
  dom.chemistryButtons.forEach((btn) => {
    btn.addEventListener("click", () => {
      chemistry = btn.dataset.dishChemistry || "bounce";
      syncControls();
      saveDish();
    });
  });
  dom.energyButtons.forEach((btn) => {
    btn.addEventListener("click", () => {
      energyLevel = btn.dataset.dishEnergy || "living";
      syncControls();
      saveDish();
    });
  });
  dom.moduleButtons.forEach((btn) => {
    btn.addEventListener("click", () => placeModule(btn.dataset.dishModule, { x: cameraTarget.x, y: cameraTarget.y }));
  });
  dom.harvestScopeSel?.addEventListener("change", () => { harvestScope = dom.harvestScopeSel.value || "scope"; saveDish(); });
  dom.gravityInput?.addEventListener("input", () => { gravity = Math.max(0, Math.min(1, Number(dom.gravityInput.value) || 0)); saveDish(); });
  dom.viscosityInput?.addEventListener("input", () => { viscosity = Math.max(0.94, Math.min(0.998, Number(dom.viscosityInput.value) || FRICTION)); saveDish(); });
  window.addEventListener("keydown", (e) => {
    if (e.key === "Escape") {
      if (dom.cards && !dom.cards.hidden) { dom.cards.hidden = true; cardFlow = null; modulePalettePoint = null; }
      toggleHelp(false);
    }
  });
  const actionLabel = document.getElementById("dishActionLabel");
  if (actionLabel) {
    dom.panel?.querySelectorAll(".dish-action-btn").forEach((btn) => {
      btn.addEventListener("mouseenter", () => {
        actionLabel.textContent = btn.dataset.name || "";
        actionLabel.classList.add("has-text");
      });
      btn.addEventListener("mouseleave", () => {
        actionLabel.textContent = "";
        actionLabel.classList.remove("has-text");
      });
    });
  }

  hydrateMicroIcons(dom.panel);
  syncControls();

  // Expose to window for testing/automation
  Object.defineProperty(window, "germs", {
    get: () => germs,
    configurable: true
  });
  window.openGermContextMenu = openGermContextMenu;
  window.openGermAdvancedEditor = openGermAdvancedEditor;

  return { enter, exit };
}
