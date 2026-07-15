import { escapeHtml, iconSvg } from "./ui_utils.js";
import { initOneBitDish } from "./dish.js?v=20260706-engine-p1";
import { createGermSynthEngine } from "./wavetable_synth.js?v=20260706-engine-p1";
import {
  SMOOTH_FAST,
  SMOOTH_UI,
  SMOOTH_GLIDE,
  smoothSet,
  equalPowerMix,
  createReverbImpulse,
  softClipCurve,
  encodeWavBlob,
  ensureWorklets,
  createGranularNode,
  createGateNode,
  createWavRecorder,
  createVoicePool,
} from "./audio_engine.js?v=20260706-engine-p1";

/* Theme toggle */
(function initTheme() {
  const saved = localStorage.getItem("germinator-theme");
  if (saved) document.documentElement.setAttribute("data-theme", saved);

  function updateIcons(theme) {
    const moon = document.getElementById("themeIconMoon");
    const sun = document.getElementById("themeIconSun");
    if (moon) moon.style.display = theme === "dark" ? "none" : "block";
    if (sun) sun.style.display = theme === "dark" ? "block" : "none";
  }

  document.addEventListener("DOMContentLoaded", () => {
    updateIcons(document.documentElement.getAttribute("data-theme") || "light");
    const btn = document.getElementById("themeToggle");
    if (btn) {
      btn.addEventListener("click", () => {
        const current = document.documentElement.getAttribute("data-theme");
        const next = current === "dark" ? "light" : "dark";
        document.documentElement.setAttribute("data-theme", next);
        localStorage.setItem("germinator-theme", next);
        updateIcons(next);
        if (typeof drawCanvasWaveforms === "function") drawCanvasWaveforms();
      });
    }
  });
})();

const $ = (id) => document.getElementById(id);

const providerModels = {
  mock: ["mock-sine", "mock-silence", "small-music", "small-sfx", "medium"],
  stable_audio_mlx: ["sm-sfx", "sm-music", "medium", "medium-mlx"],
  stable_audio_python: [
    "small-sfx",
    "small-music",
    "medium",
    "small-sfx-base",
    "small-music-base",
    "medium-base",
  ],
  stability_api: ["stable-audio-3"],
};

const LIBRARY_REFRESH_COALESCE_MS = 350;
const PETRI_STATE_STORAGE_KEY = "germinator-petri-state";
const SNAPSHOT_LIMIT = 48;

let initialized = false;
let generateInFlight = false;
let lastResult = null;
let libraryItems = [];
let wavetableItems = [];
let wavetableRefreshPromise = null;
let germSynthEngine = null;
let libraryEtag = null;
let libraryRefreshPromise = null;
let libraryRefreshTimer = null;
let layers = [];
let selectedLayerId = null;
let currentTrack = null;
let workTimer = null;
let workStartedAt = null;
let promptMonitorTimer = null;
let savedSeeds = [];
let strainStack = [];
let strainRegistry = [];
let microMatterProfile = null;
let providerStatusById = {};
let activeAkousmaPromptHandoff = null;
let petriState = loadPetriState();
let petriPage = 0;
const PETRI_PAGE_SIZE = 9;
const PETRI_QUICK_PICKER_LIMIT = 96;
let listenerNotes = [];
let manualCultureCandidateIds = [];
let canvasAssets = [];
let canvasNodes = [];
let canvasEdges = [];
let canvasCandidates = [];
let selectedCanvasNodeId = null;
let canvasLastSelectedSoundNodeId = null;
let canvasDrag = null;
let canvasRegionDrag = null;
let canvasFxCurveDrag = null;
let canvasGroupSelection = new Set();
let savedGroups = [];
let petriLibraryView = "sounds";
let canvasPendingSourcePosition = null;
let canvasConnectionDraft = null;
let canvasToolsAnchor = null;
let rackSelectedKeys = new Set();
const CANVAS_SOURCE_MENU_TABS = new Set(["core", "time", "micro", "fx", "modulators", "genetic"]);
let canvasSourceMenuTab = CANVAS_SOURCE_MENU_TABS.has(localStorage.getItem("germinator-source-menu-tab"))
  ? localStorage.getItem("germinator-source-menu-tab")
  : "core";
let canvasSourceMenuView = localStorage.getItem("germinator-source-menu-view") === "compact" ? "compact" : "full";
let canvasTransportSync = true;
let canvasGlobalLoop = false;
/* ── Undo / Redo ───────────────────────────────────────────────────── */
const UNDO_MAX = 40;
let undoStack = [];
let redoStack = [];
let canvasTransportFrame = null;
let canvasVisualMode = localStorage.getItem("germinator-canvas-visual-mode") || "waveform";
let canvasPanDrag = null;
let canvasZoom = 1;
let canvasZoomLocked = true;
let helpModeEnabled = localStorage.getItem("germinator-help-mode") !== "off";
const CONTROL_TABS = new Set(["routing", "modulation", "io", "midi", "osc", "cv", "genetics", "monitor"]);
let controlState = {
  tab: CONTROL_TABS.has(localStorage.getItem("germinator-control-tab"))
    ? localStorage.getItem("germinator-control-tab")
    : "routing",
  ports: [],
  routes: [],
  events: [],
  analysis: null,
  cvRender: null,
  bridgeStatus: null,
  cvProfiles: [],
  geneticGraph: null,
  midiStatus: "idle",
  midiInputs: [],
  midiOutputs: [],
};
const DEFAULT_TIME_STATE = {
  enabled: false,
  bpm: 120,
  timeSignature: { beatsPerBar: 4, beatUnit: 4 },
  bars: 4,
  ppq: 960,
  sampleRate: 44100,
  snapDivision: "1/16",
  swing: 0,
  loopStartTick: 0,
  loopEndTick: null,
};
const TIME_ONE_SHOT_DURATION = 0.75;
const TIME_PAD_KEYS = ["1", "2", "3", "4", "5", "6", "7", "8"];
const TIME_SNAP_TICKS = {
  "1/4": 960,
  "1/8": 480,
  "1/16": 240,
  "1/32": 120,
  triplet: 320,
};
const TIME_SCALE_INTERVALS = {
  chromatic: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11],
  major: [0, 2, 4, 5, 7, 9, 11],
  minor: [0, 2, 3, 5, 7, 8, 10],
  pentatonic: [0, 2, 4, 7, 9],
};
const TIME_NOTE_NAMES = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"];
const MODULATOR_TYPES = new Set([
  "mod_matrix",
  "prompt_morph",
  "prompt_modulator",
  "mutation_modulator",
  "lfo_modulator",
  "random_modulator",
  "random_walk_modulator",
  "brownian_modulator",
  "step_sequencer_modulator",
  "noise_modulator",
  "sample_hold_modulator",
  "probability_modulator",
  "envelope_modulator",
  "envelope_follower",
  "transient_detector",
  "spectral_follower",
  "semantic_follower",
  "region_envelope",
  "audio_to_control",
  "gesture_recorder",
  "macro_modulator",
]);
const PROMPT_MODULATOR_TYPES = new Set(["prompt_modulator", "prompt_morph"]);
const GENERATION_VALUE_MODULATOR_TYPES = new Set([
  "mutation_modulator",
  "random_modulator",
  "random_walk_modulator",
  "brownian_modulator",
  "step_sequencer_modulator",
  "sample_hold_modulator",
  "probability_modulator",
  "macro_modulator",
  "lfo_modulator",
  "noise_modulator",
  "envelope_modulator",
  "envelope_follower",
  "transient_detector",
  "spectral_follower",
  "semantic_follower",
  "region_envelope",
  "audio_to_control",
  "gesture_recorder",
]);
const REALTIME_VALUE_MODULATOR_TYPES = new Set([
  "lfo_modulator",
  "noise_modulator",
  "sample_hold_modulator",
  "envelope_modulator",
  "macro_modulator",
  "random_modulator",
  "random_walk_modulator",
  "brownian_modulator",
  "step_sequencer_modulator",
  "envelope_follower",
  "spectral_follower",
  "audio_to_control",
  "gesture_recorder",
]);
const CLOCKED_VALUE_MODULATOR_TYPES = new Set([
  "lfo_modulator",
  "random_modulator",
  "noise_modulator",
  "sample_hold_modulator",
  "probability_modulator",
  "envelope_modulator",
  "macro_modulator",
  "random_walk_modulator",
  "brownian_modulator",
  "step_sequencer_modulator",
  "transient_detector",
  "region_envelope",
  "audio_to_control",
  "gesture_recorder",
]);
const PROMPT_STACK_LAYERS = [
  { key: "material", label: "Material" },
  { key: "movement", label: "Movement" },
  { key: "space", label: "Space" },
  { key: "affect", label: "Affect" },
  { key: "technical", label: "Technical" },
];
const WAVE_REGION_TYPES = {
  mask: {
    label: "Mask",
    short: "MSK",
    purpose: "inpaint",
    role: "replace",
    behavior: "Replace this section",
    intent: "replace section",
    multi: true,
    inpaint: true,
  },
  preserve: {
    label: "Preserve",
    short: "PRS",
    purpose: "preserve",
    role: "protect",
    behavior: "Never alter this",
    intent: "preserve groove",
    multi: true,
    locked: true,
  },
  variation: {
    label: "Variation",
    short: "VAR",
    purpose: "inpaint",
    role: "alternate",
    behavior: "Generate alternatives here",
    intent: "variation region",
    multi: true,
    inpaint: true,
  },
  loop: {
    label: "Loop",
    short: "LOP",
    purpose: "loop",
    role: "loop_material",
    behavior: "Treat as loop material",
    intent: "loop material",
    multi: false,
  },
  accent: {
    label: "Accent",
    short: "ACC",
    purpose: "accent",
    role: "transient_anchor",
    behavior: "Keep transient impact",
    intent: "preserve transient impact",
    multi: true,
    locked: true,
  },
  texture: {
    label: "Texture",
    short: "TEX",
    purpose: "texture",
    role: "timbral_reference",
    behavior: "Use as timbral reference",
    intent: "replace texture",
    multi: true,
    inpaint: true,
  },
  silence: {
    label: "Silence",
    short: "SIL",
    purpose: "inpaint",
    role: "insertion_space",
    behavior: "Allow insertion",
    intent: "insert into silence",
    multi: true,
    inpaint: true,
  },
  bridge: {
    label: "Bridge",
    short: "BRG",
    purpose: "inpaint",
    role: "transition",
    behavior: "Smooth transition",
    intent: "continue space",
    multi: true,
    inpaint: true,
  },
  seed: {
    label: "Seed",
    short: "DNA",
    purpose: "extract",
    role: "identity_source",
    behavior: "Use as identity source",
    intent: "extract identity",
    multi: true,
  },
  forbidden: {
    label: "Forbidden",
    short: "OFF",
    purpose: "forbidden",
    role: "exclude",
    behavior: "Exclude from analysis",
    intent: "exclude region",
    multi: true,
    locked: true,
  },
  continuation: {
    label: "Continuation",
    short: "CNT",
    purpose: "continuation",
    role: "extension",
    behavior: "Generated extension area",
    intent: "continue source",
    multi: false,
  },
  annotation: {
    label: "Note",
    short: "ANN",
    purpose: "annotation",
    role: "reference",
    behavior: "Reference annotation",
    intent: "annotated region",
    multi: true,
  },
};
const WAVE_REGION_TYPE_ORDER = [
  "mask",
  "preserve",
  "variation",
  "loop",
  "accent",
  "texture",
  "silence",
  "bridge",
  "seed",
  "forbidden",
];
const WAVE_REGION_TYPE_ALIASES = {
  inpaint: "mask",
  extract: "seed",
  seed_region: "seed",
  forbidden_region: "forbidden",
  preserve_region: "preserve",
};
const WAVE_REGION_MASK_TYPES = new Set(["mask", "variation", "texture", "silence", "bridge"]);
const WAVE_REGION_PROTECT_TYPES = new Set(["preserve", "accent"]);
const GENETIC_MODULE_TYPES = new Set(["identity_extractor", "generation_sequencer"]);
const GENETIC_IDENTITY_TRAITS = {
  rhythm: {
    label: "Rhythm identity",
    short: "RHY",
    use: "Apply groove to another generation",
    words: ["groove", "pulse shape", "syncopation", "microtiming"],
    destination: "timing",
  },
  timbre: {
    label: "Timbre identity",
    short: "TMB",
    use: "Transfer material character",
    words: ["material grain", "coloration", "surface noise", "texture"],
    destination: "prompt",
  },
  space: {
    label: "Space identity",
    short: "SPC",
    use: "Recreate ambience and reverb feeling",
    words: ["room tone", "distance", "wetness", "reverb tail"],
    destination: "space",
  },
  density: {
    label: "Density identity",
    short: "DNS",
    use: "Match activity level",
    words: ["event density", "activity", "busy texture", "rests"],
    destination: "inpaint_density",
  },
  gesture: {
    label: "Gesture identity",
    short: "GST",
    use: "Preserve attack and decay contour",
    words: ["attack contour", "decay slope", "gesture", "motion"],
    destination: "envelope",
  },
  spectral: {
    label: "Spectral identity",
    short: "SPK",
    use: "Match brightness and noise profile",
    words: ["brightness", "noise profile", "spectral tilt", "air"],
    destination: "brightness",
  },
  prompt: {
    label: "Prompt identity",
    short: "PRM",
    use: "Generate reusable textual DNA",
    words: ["semantic tags", "material language", "movement language", "negative traits"],
    destination: "prompt_stack",
  },
  latent: {
    label: "Latent identity",
    short: "LAT",
    use: "Use internal representation as generation condition",
    words: ["latent fingerprint", "SAME embedding", "identity condition", "deferred latent"],
    destination: "latents",
  },
};
const GENETIC_SEQUENCER_ACTIONS = {
  mutate_light: "mutate lightly",
  continue_4s: "continue 4s",
  inpaint_middle: "inpaint middle",
  prompt_variation: "prompt variation",
  graft_texture: "graft texture",
  render_candidate: "render candidate",
  reject_loud_tonal: "reject tonal",
  save_tray: "save to tray",
};
const GENETIC_SEQUENCER_MODES = {
  seed_garden: "Seed Garden",
  mutation_chain: "Mutation Chain",
  loop_breeder: "Loop Breeder",
  texture_weather: "Texture Weather",
  beat_infection: "Beat Infection",
  sfx_colony: "SFX Colony",
};
const GENETIC_DEFAULT_SEQUENCE = [
  { action: "mutate_light", probability: 1 },
  { action: "continue_4s", probability: 0.75 },
  { action: "inpaint_middle", probability: 0.4 },
  { action: "prompt_variation", probability: 0.55 },
  { action: "graft_texture", probability: 0.2 },
  { action: "render_candidate", probability: 1 },
  { action: "reject_loud_tonal", probability: 0.35 },
  { action: "save_tray", probability: 1 },
];
const PROMPT_MODULATOR_MODES = {
  adjectives_materials: "Adjectives + Materials",
  full: "Full Prompt",
  nouns: "Nouns",
  adjectives: "Adjectives",
  actions: "Actions",
  materials: "Materials",
  space: "Space / Mic",
  negative: "Negative",
  genetic: "Genetic",
};
const PROMPT_MODULATOR_OUTPUT_MODES = ["append", "prepend", "replace", "inject", "substitute", "blend"];
const MUTATION_DISTRIBUTIONS = ["uniform", "stepped"];
const LFO_SHAPES = {
  sine: "Sine",
  triangle: "Triangle",
  square: "Square",
  ramp: "Ramp",
  random_smooth: "Smooth random",
};
const MODULATOR_REFRESHES = {
  every_trigger: "Trigger",
  every_step: "Step",
  every_bar: "Bar",
  every_generation: "Generation",
  locked: "Locked",
};
const MODULATOR_DIVISIONS = ["1/4", "1/8", "1/16", "1/32", "triplet"];
const AUDIO_TO_CONTROL_FEATURES = {
  envelope: "Envelope",
  transient: "Transient",
  spectral: "Spectral",
  rhythm: "Rhythm",
};
const MATRIX_SOURCE_TYPES = {
  lfo_modulator: "LFO",
  random_walk_modulator: "Random walk",
  brownian_modulator: "Brownian",
  step_sequencer_modulator: "Steps",
  sample_hold_modulator: "S&H",
  probability_modulator: "Probability",
  envelope_follower: "Envelope",
  transient_detector: "Transients",
  spectral_follower: "Spectral",
  audio_to_control: "Audio-to-Control",
  gesture_recorder: "Gesture",
  macro_modulator: "Macro",
};
const MODULATOR_WORD_BANKS = {
  nouns: ["click", "tick", "pulse", "snap", "rattle", "drip", "scrape", "impact", "tone", "grain", "spark", "thud"],
  adjectives: ["dry", "wet", "brittle", "granular", "hollow", "rubbery", "metallic", "porous", "compressed", "dusty", "fragile", "viscous", "sharp", "muted", "warm", "cold", "corroded", "tactile"],
  actions: ["scrape", "snap", "drip", "burst", "rattle", "pulse", "fracture", "flutter", "crackle", "throb", "swell", "collapse", "strike", "tap", "shiver"],
  materials: ["ceramic", "glass", "paper", "stone", "metal", "wood", "rubber", "fabric", "plastic", "water", "sand", "wire", "dust", "clay", "concrete"],
  spaces: ["close microphone", "dry room", "small chamber", "large concrete hall", "inside a metal box", "contact microphone", "distant perspective", "narrow stereo image", "wide stereo field"],
  decay: ["fast decay", "tight tail", "controlled decay", "short attack", "medium decay"],
  negative: ["speech", "vocals", "singing", "melody", "chord progression", "full song", "long reverb", "digital artifact", "harsh clipping", "ambient bed"],
};
const GENERATION_DESTINATIONS = {
  promptWeight: { path: "generation.promptWeight", label: "Prompt weight", min: 0, max: 2, defaultValue: 1 },
  negativePromptWeight: { path: "generation.negativePromptWeight", label: "Negative prompt weight", min: 0, max: 2, defaultValue: 1 },
  mutation: { path: "generation.mutation", label: "Mutation amount", min: 0, max: 1, defaultValue: 0.5 },
  inpaintDensity: { path: "generation.inpaintDensity", label: "Inpaint density", min: 0, max: 1, defaultValue: 0.5 },
  continuationDivergence: { path: "generation.continuationDivergence", label: "Continuation divergence", min: 0, max: 1.5, defaultValue: 0.5 },
  seedDrift: { path: "generation.seedDrift", label: "Seed drift", min: 0, max: 1, defaultValue: 0 },
  durationSec: { path: "generation.durationSec", label: "Duration", min: 0.5, max: 60, defaultValue: 4 },
  modelRouteIndex: { path: "generation.modelRouteIndex", label: "Model route", min: 0, max: 6, defaultValue: 0 },
  loraStrength: { path: "generation.loraStrength", label: "LoRA strength", min: 0, max: 2, defaultValue: 1 },
  cfgScale: { path: "generation.cfgScale", label: "CFG guidance", min: 0, max: 20, defaultValue: 1 },
  batchSpread: { path: "generation.batchSpread", label: "Batch spread", min: 0, max: 1, defaultValue: 0 },
  maskFeather: { path: "generation.maskFeather", label: "Mask feather", min: 0, max: 1, defaultValue: 0.15 },
  brightnessLanguage: { path: "generation.brightnessLanguage", label: "Brightness language", min: -1, max: 1, defaultValue: 0 },
};
let timeState = createDefaultTimeState();
const canvasAudioCache = new Map();
const canvasReverseAudioCache = new Map();
const wavetableCache = new Map();
// Decoded AudioBuffers hold raw PCM (~3.5 MB per 10 s stereo take), so the cache
// is kept as an insertion-ordered LRU instead of growing for the whole session.
const CANVAS_AUDIO_CACHE_MAX = 32;
const CANVAS_REVERSE_AUDIO_CACHE_MAX = 32;
let canvasMasterRecordDestination = null;
let canvasMasterRecorder = null;
let canvasMasterRecording = null;
let canvasMasterRecordTimer = null;
let canvasPendingImagePosition = null;
let canvasPendingImageMode = "vision";
let canvasPendingImageNodeId = null;
let activeCulture = {
  id: `culture-${new Date().toISOString().slice(0, 10)}`,
  name: "Metallic friction loops",
  description: "Low dry loop culture. Favor close gesture, avoid voice leakage.",
  seedIds: [],
  candidateIds: [],
  layerIds: [],
  strainIds: [],
  groups: [],
  notes: [],
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
};

const modeAliases = {
  "text-to-audio": "germinate",
  "audio-to-audio": "mutate",
  inpainting: "prune",
  continuation: "propagate",
};
const petriAudioCache = new Map();
const PETRI_AUDIO_CACHE_LIMIT = 80;
let petriCanvasObserver = null;
let decodeAudioContext = null;
let canvasPlaybackAudioContext = null;
let canvasMasterBus = null;
// True once the germ AudioWorklet module is registered on the playback
// context; granular/gate FX and WAV recording upgrade themselves then.
let canvasWorkletsReady = false;
let canvasTriggerPool = null;
let activeCanvasSurface = "chamber";
let oneBitDish = null;
let canvasRealtimeModulationRaf = null;
const MUTATION_PRESETS = [
  { value: 0.1, key: "clone", label: "Clone", detail: "closest parent" },
  { value: 0.25, key: "nudge", label: "Nudge", detail: "small drift" },
  { value: 0.5, key: "hybrid", label: "Hybrid", detail: "halfway" },
  { value: 0.75, key: "mutation", label: "Mutation", detail: "distant" },
  { value: 1.0, key: "new_gen", label: "New Gen", detail: "most distant" },
];
const FX_MODULES = {
  gain: { label: "Gain", description: "Potentiometer gain control" },
  pan: { label: "Pan", description: "Pan current signal" },
  pitch: { label: "Pitch", description: "Realtime pitch/speed control" },
  filter: { label: "Filter", description: "Drawable spectral curve" },
  granular: { label: "Granular", description: "Grain texture and prompt extraction" },
  grain_culture: { label: "Grain Culture", description: "Build a corpus of cells from source material" },
  particle_engine: { label: "Particle Engine", description: "Real-time particle playback and resynthesis scaffold" },
  cell_splitter: { label: "Cell Splitter", description: "Slice audio into micro-events and transient cells" },
  swarm: { label: "Swarm", description: "Scatter grains into clouds, streams, and sprays" },
  colony: { label: "Colony", description: "Group related grains into families" },
  membrane: { label: "Membrane", description: "Filter what passes between source and output" },
  metabolism: { label: "Metabolism", description: "Convert sound matter into control behavior" },
  spectral_tissue: { label: "Spectral Tissue", description: "Freeze, smear, mask, and reorganize spectra" },
  quanta: { label: "Quanta", description: "Gabor-style micro-event generator" },
  microscope: { label: "Microscope", description: "Inspect transients, partials, density, and grain behavior" },
  incubator: { label: "Incubator", description: "Slowly evolve a sound population over time" },
  loop_doctor: { label: "Loop Doctor", description: "Loop detection, seam repair, and cyclic export" },
  space: { label: "Space", description: "Simple reverb modes" },
  echo: { label: "Echo", description: "Delay modes and feedback" },
  saturation: { label: "Saturation", description: "Soft to hard distortion" },
  gate: { label: "Noise Gate", description: "Basic threshold gate" },
};
const MICRO_FX_TYPES = new Set([
  "grain_culture",
  "particle_engine",
  "cell_splitter",
  "swarm",
  "colony",
  "membrane",
  "metabolism",
  "spectral_tissue",
  "quanta",
  "microscope",
  "incubator",
]);
const MICRO_FX_DEFAULTS = {
  grain_culture: { grainSizeMs: 35, density: 0.62, selection: 0.7, mix: 0.45 },
  particle_engine: { grainSizeMs: 42, density: 0.7, spray: 0.34, jitter: 0.28, mix: 0.5 },
  cell_splitter: { threshold: 0.45, minCellMs: 25, preserveTransients: true, mix: 0.4 },
  swarm: { density: 0.76, spread: 0.62, jitter: 0.48, mix: 0.52 },
  colony: { families: 4, affinity: 0.58, drift: 0.25, mix: 0.45 },
  membrane: { permeability: 0.46, cutoff: 0.62, reject: 0.22, mix: 0.35 },
  metabolism: { sensitivity: 0.58, smoothingMs: 80, output: 0.62, mix: 0.4 },
  spectral_tissue: { smear: 0.52, freeze: 0.42, mask: 0.34, mix: 0.5 },
  quanta: { rateHz: 18, durationMs: 28, frequencyScatter: 0.35, mix: 0.45 },
  microscope: { zoom: 0.64, transientFocus: 0.6, partialFocus: 0.45, mix: 0.3 },
  incubator: { generation: 0.5, mutation: 0.38, timeScale: 0.55, mix: 0.48 },
};
const MICRO_FX_CONTROL_META = {
  grainSizeMs: { label: "Size", min: 8, max: 240, step: 1 },
  density: { label: "Density", min: 0, max: 1, step: 0.01 },
  selection: { label: "Selection", min: 0, max: 1, step: 0.01 },
  spray: { label: "Spray", min: 0, max: 1, step: 0.01 },
  jitter: { label: "Jitter", min: 0, max: 1, step: 0.01 },
  threshold: { label: "Thresh", min: 0, max: 1, step: 0.01 },
  minCellMs: { label: "Min cell", min: 5, max: 160, step: 1 },
  preserveTransients: { label: "Keep attacks", type: "checkbox" },
  spread: { label: "Spread", min: 0, max: 1, step: 0.01 },
  families: { label: "Families", min: 1, max: 12, step: 1 },
  affinity: { label: "Affinity", min: 0, max: 1, step: 0.01 },
  drift: { label: "Drift", min: 0, max: 1, step: 0.01 },
  permeability: { label: "Permeability", min: 0, max: 1, step: 0.01 },
  cutoff: { label: "Cutoff", min: 0, max: 1, step: 0.01 },
  reject: { label: "Reject", min: 0, max: 1, step: 0.01 },
  sensitivity: { label: "Sense", min: 0, max: 1, step: 0.01 },
  smoothingMs: { label: "Smooth", min: 0, max: 400, step: 1 },
  output: { label: "Output", min: 0, max: 1, step: 0.01 },
  smear: { label: "Smear", min: 0, max: 1, step: 0.01 },
  freeze: { label: "Freeze", min: 0, max: 1, step: 0.01 },
  mask: { label: "Mask", min: 0, max: 1, step: 0.01 },
  rateHz: { label: "Rate", min: 1, max: 80, step: 1 },
  durationMs: { label: "Duration", min: 5, max: 180, step: 1 },
  frequencyScatter: { label: "Scatter", min: 0, max: 1, step: 0.01 },
  zoom: { label: "Zoom", min: 0, max: 1, step: 0.01 },
  transientFocus: { label: "Transient", min: 0, max: 1, step: 0.01 },
  partialFocus: { label: "Partials", min: 0, max: 1, step: 0.01 },
  generation: { label: "Generation", min: 0, max: 1, step: 0.01 },
  mutation: { label: "Mutation", min: 0, max: 1, step: 0.01 },
  timeScale: { label: "Time", min: 0, max: 1, step: 0.01 },
  mix: { label: "Mix", min: 0, max: 1, step: 0.01 },
};
const FX_SEMANTIC_PROFILES = {
  gain: {
    family: "dynamics",
    prompt: ({ params }) => Number(params.amount ?? 1) > 1.08 ? "forward, present, compressed body" : "quiet, restrained, distant detail",
    generation: ({ params, amount }) => ({ inpaintDensity: (Number(params.amount ?? 1) - 1) * 0.08 * amount }),
  },
  pan: {
    family: "stereo",
    prompt: ({ params }) => Math.abs(Number(params.pan ?? 0)) > 0.25 ? "asymmetric stereo placement, lateral motion" : "centered close microphone image",
    generation: ({ params, amount }) => ({ maskFeather: Math.abs(Number(params.pan ?? 0)) * 0.08 * amount }),
  },
  pitch: {
    family: "motion",
    prompt: ({ params }) => {
      const semitones = Number(params.semitones ?? 0);
      if (semitones > 1) return "lifted pitch, smaller body, brighter gesture";
      if (semitones < -1) return "lowered pitch, heavier body, slowed material";
      return "stable pitch identity";
    },
    generation: ({ params, amount }) => ({ continuationDivergence: Math.min(0.18, Math.abs(Number(params.semitones ?? 0)) / 24) * amount }),
  },
  filter: {
    family: "spectral",
    prompt: ({ params, openness }) => {
      const mode = params.mode || "lowpass";
      if (mode === "highpass") return "thin exposed high frequencies, sharp edges, air and grit";
      if (mode === "bandpass") return "narrow resonant band, focused spectral window";
      return openness < 0.42
        ? "dark, muffled, underwater, closed spectral surface"
        : "bright, sharp, exposed, metallic spectral edge";
    },
    negative: ({ openness }) => openness < 0.42 ? "piercing highs, brittle fizz" : "muddy dull low-pass blanket",
    generation: ({ openness, amount }) => ({ brightnessLanguage: (openness - 0.5) * 1.35 * amount }),
  },
  granular: {
    family: "texture",
    prompt: ({ params }) => {
      const density = Number(params.density ?? 0.58);
      const jitter = Number(params.jitter ?? 0.35);
      const sizeMs = Number(params.sizeMs ?? 70);
      const scale = density > 0.7 ? "dense" : density < 0.35 ? "sparse" : "balanced";
      const motion = jitter > 0.55 ? "unstable scattered" : "precise microscopic";
      const size = sizeMs < 45 ? "tiny grains" : sizeMs > 120 ? "large drifting grains" : "granular fragments";
      return `${scale} ${motion} ${size}, fragmented, shimmering, particulate`;
    },
    negative: () => "smooth unbroken pad, polished clean sustain",
    generation: ({ params, amount }) => ({
      inpaintDensity: Number(params.density ?? 0.58) * 0.22 * amount,
      batchSpread: Number(params.jitter ?? 0.35) * 0.18 * amount,
      seedDrift: Number(params.jitter ?? 0.35) * 0.12 * amount,
    }),
  },
  grain_culture: {
    family: "micro",
    prompt: ({ params }) => `grain corpus, ${Number(params.grainSizeMs ?? 35)} ms cells, curated micro-events, source material under microscope`,
    negative: () => "single flat sample, unsegmented waveform",
    generation: ({ params, amount }) => ({
      inpaintDensity: Number(params.density ?? 0.62) * 0.18 * amount,
      batchSpread: Number(params.selection ?? 0.7) * 0.12 * amount,
    }),
  },
  particle_engine: {
    family: "micro",
    prompt: ({ params }) => `particle stream, ${Number(params.density ?? 0.7) > 0.65 ? "dense" : "sparse"} grain cloud, performable microsound resynthesis`,
    negative: () => "static loop, fixed pad",
    generation: ({ params, amount }) => ({
      inpaintDensity: Number(params.density ?? 0.7) * 0.2 * amount,
      seedDrift: Number(params.jitter ?? 0.28) * 0.18 * amount,
      batchSpread: Number(params.spray ?? 0.34) * 0.14 * amount,
    }),
  },
  cell_splitter: {
    family: "micro",
    prompt: ({ params }) => `micro-event cells, sharp onset separation, ${Number(params.minCellMs ?? 25)} ms minimum fragments`,
    negative: () => "smeared attacks, blurred transients",
    generation: ({ params, amount }) => ({
      inpaintDensity: Number(params.threshold ?? 0.45) * 0.18 * amount,
      maskFeather: Number(params.minCellMs ?? 25) / 1000 * amount,
    }),
  },
  swarm: {
    family: "micro",
    prompt: ({ params }) => `${Number(params.spread ?? 0.62) > 0.55 ? "wide" : "tight"} swarm of grains, scattered streams and sprays`,
    negative: () => "single centered event, plain repetition",
    generation: ({ params, amount }) => ({
      batchSpread: Number(params.spread ?? 0.62) * 0.2 * amount,
      seedDrift: Number(params.jitter ?? 0.48) * 0.18 * amount,
    }),
  },
  colony: {
    family: "micro",
    prompt: ({ params }) => `${Number(params.families ?? 4)} related grain families, clustered colony behavior, shared material identity`,
    negative: () => "unrelated random fragments",
    generation: ({ params, amount }) => ({
      batchSpread: Math.min(1, Number(params.families ?? 4) / 12) * 0.18 * amount,
      seedDrift: Number(params.drift ?? 0.25) * 0.14 * amount,
    }),
  },
  membrane: {
    family: "micro",
    prompt: ({ params }) => `selective membrane, filtered passage, ${Number(params.permeability ?? 0.46) > 0.5 ? "porous" : "tight"} sound boundary`,
    negative: () => "everything passes unfiltered",
    generation: ({ params, amount }) => ({
      brightnessLanguage: (Number(params.cutoff ?? 0.62) - 0.5) * amount,
      inpaintDensity: Number(params.reject ?? 0.22) * 0.16 * amount,
    }),
  },
  metabolism: {
    family: "control",
    prompt: ({ params }) => `audio features become movement, metabolic control signal, smoothed response ${Number(params.smoothingMs ?? 80)} ms`,
    negative: () => "uncontrolled static behavior",
    generation: ({ params, amount }) => ({
      seedDrift: Number(params.sensitivity ?? 0.58) * 0.16 * amount,
      batchSpread: Number(params.output ?? 0.62) * 0.12 * amount,
    }),
  },
  spectral_tissue: {
    family: "spectral",
    prompt: ({ params }) => `spectral tissue, ${Number(params.freeze ?? 0.42) > 0.5 ? "frozen" : "elastic"} partials, smeared frequency matter`,
    negative: () => "plain dry waveform, no spectral transformation",
    generation: ({ params, amount }) => ({
      brightnessLanguage: (Number(params.mask ?? 0.34) - 0.4) * amount,
      continuationDivergence: Number(params.smear ?? 0.52) * 0.24 * amount,
    }),
  },
  quanta: {
    family: "micro",
    prompt: ({ params }) => `Gabor-like quanta, ${Number(params.rateHz ?? 18)} Hz micro-event rate, short time-frequency particles`,
    negative: () => "long continuous tone, no particle detail",
    generation: ({ params, amount }) => ({
      inpaintDensity: Math.min(1, Number(params.rateHz ?? 18) / 80) * 0.2 * amount,
      seedDrift: Number(params.frequencyScatter ?? 0.35) * 0.16 * amount,
    }),
  },
  microscope: {
    family: "analysis",
    prompt: ({ params }) => `microscope analysis, transient focus, partial focus, density map, zoom ${Number(params.zoom ?? 0.64).toFixed(2)}`,
    negative: () => "undifferentiated sound mass",
    generation: ({ params, amount }) => ({
      inpaintDensity: Number(params.transientFocus ?? 0.6) * 0.12 * amount,
      brightnessLanguage: (Number(params.partialFocus ?? 0.45) - 0.5) * amount,
    }),
  },
  incubator: {
    family: "evolution",
    prompt: ({ params }) => `slow incubated evolution, sound population changing over time, mutation ${Number(params.mutation ?? 0.38).toFixed(2)}`,
    negative: () => "one-shot static render",
    generation: ({ params, amount }) => ({
      seedDrift: Number(params.mutation ?? 0.38) * 0.2 * amount,
      continuationDivergence: Number(params.timeScale ?? 0.55) * 0.18 * amount,
      batchSpread: Number(params.generation ?? 0.5) * 0.16 * amount,
    }),
  },
  loop_doctor: {
    family: "loop repair",
    prompt: ({ params }) => {
      const mode = params.mode || "seam";
      if (mode === "loop_points") return "clean cyclic loop, stable groove boundary, repeatable phrase";
      if (mode === "variation") return "loopable variation, repaired seam, related cyclic material";
      return "seamless cyclic material, healed loop boundary, click-free transition";
    },
    negative: () => "clicks, pops, hard cuts, broken loop seam",
    generation: ({ params, amount }) => ({
      maskFeather: Number(params.crossfadeSec ?? 0.12) * 1.1 * amount,
      inpaintDensity: Number(params.variationStrength ?? 0.28) * 0.18 * amount,
      batchSpread: Number(params.variationStrength ?? 0.28) * 0.12 * amount,
    }),
  },
  space: {
    family: "space",
    prompt: ({ params }) => ({
      room: "small room reflections, close damp air, early reflection detail",
      plate: "large metallic plate, long cold reflections, polished shimmer",
      hall: "large metallic tunnel, long cold reflections, distant air",
    }[params.mode || "room"] || "reverberant space, reflective air"),
    negative: ({ params }) => Number(params.mix ?? 0.28) > 0.55 ? "dry close dead room" : "",
    generation: ({ params, amount }) => ({
      continuationDivergence: Number(params.mix ?? 0.28) * 0.28 * amount,
      maskFeather: Number(params.mix ?? 0.28) * 0.18 * amount,
    }),
  },
  echo: {
    family: "time",
    prompt: ({ params }) => ({
      slap: "short slapback reflection, tight repeated edge",
      tape: "tape delay repeats, unstable timing, softened feedback",
      dub: "wide dub echo, long feedback trails, rhythmic space",
    }[params.mode || "tape"] || "echo repeats and delayed motion"),
    generation: ({ params, amount }) => ({
      continuationDivergence: Number(params.feedback ?? 0.32) * 0.24 * amount,
      seedDrift: Number(params.time ?? 0.28) * 0.08 * amount,
    }),
  },
  saturation: {
    family: "material",
    prompt: ({ params }) => ({
      subtle: "subtle harmonic warmth, rounded edges",
      warm: "warm saturated body, tactile harmonic grain",
      hard: "hard clipped texture, aggressive harmonic grit",
    }[params.mode || "warm"] || "saturated harmonic texture"),
    negative: ({ params }) => Number(params.drive ?? 0.28) > 0.62 ? "clean sterile digital tone" : "",
    generation: ({ params, amount }) => ({ brightnessLanguage: (Number(params.drive ?? 0.28) - 0.35) * 0.45 * amount }),
  },
  gate: {
    family: "rhythm",
    prompt: ({ params }) => Number(params.threshold ?? 0.18) > 0.45
      ? "hard gated silence, clipped decay, sparse stop-start rhythm"
      : "controlled noise floor, clean separation, preserved attacks",
    generation: ({ params, amount }) => ({
      inpaintDensity: -Number(params.threshold ?? 0.18) * 0.12 * amount,
      maskFeather: Number(params.release ?? 0.22) * 0.12 * amount,
    }),
  },
};

function baseUrl() {
  const raw = ($("serverUrl").value.trim() || window.location.origin).replace(/\/$/, "");
  return /^https?:\/\//i.test(raw) ? raw : `${window.location.protocol}//${raw}`;
}

function classForState(variant) {
  if (variant === "bad") return "state-pill bad";
  if (variant === "ok") return "state-pill";
  return "state-pill muted";
}

function simplifyStatusTitle(title) {
  const cleaned = String(title || "Idle")
    .replace(/\b(?:Chamber|Petri)\s+/gi, "")
    .replace(/\s+to\s+Chamber\b/gi, "")
    .replace(/\s+/g, " ")
    .trim();
  return (cleaned || "Idle").replace(/\b[a-z]/g, (char) => char.toUpperCase());
}

function updateElapsed() {
  const elapsed = $("elapsedTime");
  if (!elapsed) return;
  if (!workStartedAt) {
    elapsed.textContent = "0.0s";
    return;
  }
  const seconds = (Date.now() - workStartedAt) / 1000;
  elapsed.textContent = `${seconds.toFixed(1)}s`;
}

function setState(title, variant = "muted", detail = "") {
  const statusTitle = simplifyStatusTitle(title);
  const statusNode = $("statusTitle");
  if (statusNode) statusNode.textContent = statusTitle;
  const statusDetail = $("statusDetail");
  if (statusDetail) statusDetail.textContent = detail || "Waiting.";
  const healthPill = $("healthPill");
  if (healthPill) {
    healthPill.textContent = variant === "bad" ? "error" : statusTitle.toLowerCase().split(" ")[0] || "ok";
    healthPill.className = classForState(variant);
  }
  const topbar = $("topbar");
  if (topbar) topbar.classList.toggle("busy", variant === "busy");
  const pill = $("statusTitle");
  if (pill) pill.className = "topbar-state-pill " + (variant || "");
  const activityMeter = $("activityMeter");
  if (activityMeter) activityMeter.style.width = variant === "ok" ? "100%" : variant === "bad" ? "100%" : "0";
}

function beginWork(title, detail = "") {
  workStartedAt = Date.now();
  updateElapsed();
  if (workTimer) window.clearInterval(workTimer);
  workTimer = window.setInterval(updateElapsed, 120);
  setState(title, "busy", detail);
  setBusy(true);
}

function finishWork(title, variant = "ok", detail = "") {
  if (workTimer) window.clearInterval(workTimer);
  workTimer = null;
  updateElapsed();
  setState(title, variant, detail);
  setBusy(false);
}

function setBusy(isBusy) {
  [
    "generateBtn",
    "testBtn",
    "hfCheckBtn",
    "loadBtn",
    "refreshBtn",
    "refreshLibraryBtn",
    "seedGerminateBtn",
    "listenerEnhanceBtn",
    "listenerScoreBtn",
    "listenerRelistenBtn",

  ].forEach((id) => {
    if ($(id)) $(id).disabled = isBusy;
  });
}

function showJson(target, value) {
  target.textContent = JSON.stringify(value, null, 2);
}

function parseTags(value) {
  return String(value || "")
    .split(",")
    .map((tag) => tag.trim())
    .filter(Boolean);
}

function activeRuntime() {
  return {
    stable_audio_python: "python",
    stable_audio_mlx: "mlx",
    stability_api: "api",
    mock: "mock",
  }[$("provider").value] || $("provider").value;
}

function activeLoraCount() {
  return loraPayload().length || strainStack.filter((strain) => strain.enabled).length;
}

function updateHomeReadouts() {
  if ($("homeMedium")) $("homeMedium").textContent = activeRuntime();
  if ($("homeModel")) $("homeModel").textContent = $("model").value || "-";
  if ($("homeStrains")) $("homeStrains").textContent = String(activeLoraCount());
  if ($("homeLibrary")) $("homeLibrary").textContent = String(libraryItems.length);
  if ($("homeLayers")) $("homeLayers").textContent = String(layers.length);
  if ($("homeSeeds")) $("homeSeeds").textContent = String(savedSeeds.length);
  if ($("homeOutput")) $("homeOutput").textContent = currentTrack ? "selected" : "ready";
  if ($("cultureCandidateCount")) $("cultureCandidateCount").textContent = String(libraryItems.length);
  if ($("cultureLayerCount")) $("cultureLayerCount").textContent = String(layers.length);
  if ($("cultureStrainCount")) $("cultureStrainCount").textContent = String(activeLoraCount());
}

async function api(path, options = {}) {
  const headers =
    options.body instanceof FormData
      ? options.headers || {}
      : {
          "content-type": "application/json",
          ...(options.headers || {}),
        };
  const response = await fetch(`${baseUrl()}${path}`, {
    headers,
    ...options,
  });
  const text = await response.text();
  let body = null;
  try {
    body = text ? JSON.parse(text) : {};
  } catch {
    body = { raw: text };
  }
  if (!response.ok) {
    const detail = body.detail || body.error || response.statusText;
    throw new Error(typeof detail === "string" ? detail : JSON.stringify(detail));
  }
  return body;
}

async function refreshWavetables({ force = false } = {}) {
  if (wavetableRefreshPromise && !force) return wavetableRefreshPromise;
  wavetableRefreshPromise = api("/wavetables")
    .then((items) => {
      wavetableItems = Array.isArray(items) ? items : [];
      if (canvasNodes.some((node) => node.type === "germ" || node.type === "wavetable_forge")) {
        renderCanvas();
      }
      if (petriLibraryView === "wavetables") renderHerbarium();
      renderRack();
      return wavetableItems;
    })
    .finally(() => {
      wavetableRefreshPromise = null;
    });
  return wavetableRefreshPromise;
}

function wavetableById(id) {
  return wavetableItems.find((item) => item.id === id) || null;
}

async function fetchWavetableData(id) {
  if (!id) return null;
  if (wavetableCache.has(id)) return wavetableCache.get(id);
  const response = await fetch(`${baseUrl()}/wavetables/${encodeURIComponent(id)}/data`);
  if (!response.ok) throw new Error(`Could not load wavetable data (${response.status})`);
  const buffer = await response.arrayBuffer();
  const data = new Float32Array(buffer);
  wavetableCache.set(id, data);
  return data;
}

function renderGermWavetableOptions(selectedId = "") {
  if (!wavetableItems.length) return '<option value="">No tables yet</option>';
  return wavetableItems
    .map((item) => `<option value="${escapeHtml(item.id)}"${item.id === selectedId ? " selected" : ""}>${escapeHtml(item.name || item.id)}</option>`)
    .join("");
}

function drawWavetableMiniScope(canvas, wavetable, frames = null, position = 0) {
  if (!canvas) return;
  const ratio = Math.max(1, window.devicePixelRatio || 1);
  const width = Math.max(1, Math.round((canvas.clientWidth || canvas.width || 120) * ratio));
  const height = Math.max(1, Math.round((canvas.clientHeight || canvas.height || 44) * ratio));
  if (canvas.width !== width) canvas.width = width;
  if (canvas.height !== height) canvas.height = height;
  const ctx = canvas.getContext("2d");
  ctx.clearRect(0, 0, width, height);
  ctx.fillStyle = document.documentElement.getAttribute("data-theme") === "dark" ? "#151817" : "#fbfbf9";
  ctx.fillRect(0, 0, width, height);
  const frameSize = Number(wavetable?.frame_size || 0);
  const frameCount = Number(wavetable?.frame_count || 0);
  if (!frames || !frameSize || !frameCount) {
    ctx.strokeStyle = "rgba(71,111,93,0.35)";
    ctx.beginPath();
    ctx.moveTo(0, height / 2);
    ctx.lineTo(width, height / 2);
    ctx.stroke();
    return;
  }
  const frameIndex = Math.max(0, Math.min(frameCount - 1, Math.round((Number(position) || 0) * (frameCount - 1))));
  const start = frameIndex * frameSize;
  ctx.strokeStyle = "#476f5d";
  ctx.lineWidth = Math.max(1, ratio);
  ctx.beginPath();
  for (let x = 0; x < width; x += 1) {
    const idx = start + Math.min(frameSize - 1, Math.floor((x / Math.max(1, width - 1)) * frameSize));
    const y = ((1 - (frames[idx] || 0)) * height) / 2;
    if (x === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  }
  ctx.stroke();
}

function drawWavetableFrameStrip(canvas, wavetable, frames = null) {
  if (!canvas) return;
  const ratio = Math.max(1, window.devicePixelRatio || 1);
  const width = Math.max(1, Math.round((canvas.clientWidth || canvas.width || 180) * ratio));
  const height = Math.max(1, Math.round((canvas.clientHeight || canvas.height || 38) * ratio));
  if (canvas.width !== width) canvas.width = width;
  if (canvas.height !== height) canvas.height = height;
  const ctx = canvas.getContext("2d");
  ctx.clearRect(0, 0, width, height);
  const frameSize = Number(wavetable?.frame_size || 0);
  const frameCount = Number(wavetable?.frame_count || 0);
  if (!frames || !frameSize || !frameCount) return;
  const barWidth = Math.max(1, width / frameCount);
  for (let i = 0; i < frameCount; i += 1) {
    let energy = 0;
    const start = i * frameSize;
    for (let j = 0; j < frameSize; j += Math.max(1, Math.floor(frameSize / 64))) {
      energy += Math.abs(frames[start + j] || 0);
    }
    energy = Math.min(1, energy / 64);
    ctx.fillStyle = `rgba(71,111,93,${0.18 + energy * 0.72})`;
    ctx.fillRect(i * barWidth, height * (1 - energy), Math.max(1, barWidth - 1), height * energy);
  }
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

function controlPortById(id) {
  return controlState.ports.find((port) => port.id === id) || null;
}

function controlPortLabel(id) {
  return controlPortById(id)?.label || id || "-";
}

function controlPortKind(id, fallback = "control") {
  return controlPortById(id)?.kind || fallback;
}

function controlPortsFor(direction) {
  return controlState.ports.filter((port) => port.direction === direction);
}

function controlPortOptions(direction, selectedId = "") {
  const ports = controlPortsFor(direction);
  if (!ports.length) return `<option value="">Loading ports</option>`;
  return ports.map((port) => {
    const selected = port.id === selectedId ? " selected" : "";
    return `<option value="${escapeHtml(port.id)}"${selected}>${escapeHtml(port.label)} (${escapeHtml(port.kind)})</option>`;
  }).join("");
}

function controlSelectedAsset() {
  const node = canvasSelectedNode();
  if (node?.type === "sound") return canvasAssetById(node.assetId);
  return currentTrack || layers.find((layer) => layer.id === selectedLayerId) || null;
}

function controlCanvasRoutes() {
  const routeRecords = [];
  canvasModulatorNodes().map(normalizeModulatorNode).forEach((modulator) => {
    const routes = modulator.modulatorType === "mod_matrix"
      ? modulator.config?.matrixRoutes || []
      : modulator.routes || [];
    routes.forEach((route) => {
      const target = modulationTargetForRoute(route);
      if (!target) return;
      routeRecords.push({
        id: route.id,
        source_node_id: modulator.id,
        source_label: modulator.label || modulatorLabel(modulator.modulatorType),
        source_type: modulator.modulatorType,
        source_kind: PROMPT_MODULATOR_TYPES.has(modulator.modulatorType) ? "prompt" : "control",
        target_node_id: target.nodeId,
        target_path: target.path,
        target_label: target.label,
        target_kind: target.type === "prompt" ? "prompt" : "control",
        target_scope: target.targetScope || target.modulationRate || "generation",
        enabled: route.enabled !== false,
        transform: {
          amount: Number(route.amount ?? route.config?.amount ?? 1),
          curve: route.curve || "linear",
          min: route.config?.min,
          max: route.config?.max,
          smoothing_ms: Number(route.config?.smoothingMs || route.config?.smooth || 0),
        },
        lineage_role: PROMPT_MODULATOR_TYPES.has(modulator.modulatorType) ? "prompt-parent" : "control-parent",
      });
    });
  });
  return routeRecords;
}

function controlSnapshotPayload(extra = {}) {
  return {
    id: `canvas_control_${Date.now()}`,
    captured_at: new Date().toISOString(),
    routes: controlCanvasRoutes(),
    events: [],
    metadata: {
      source: "dashboard_canvas",
      selected_node_id: selectedCanvasNodeId,
      canvas_node_count: canvasNodes.length,
      ...extra,
    },
  };
}

function controlMetadataPayload() {
  const snapshot = controlSnapshotPayload();
  return {
    control_routes: snapshot.routes,
    control_snapshots: [snapshot],
    control_sources: snapshot.routes.map((route) => ({
      id: route.id,
      role: route.lineage_role,
      source_node_id: route.source_node_id,
      source_type: route.source_type,
      target_path: route.target_path,
    })),
  };
}

async function refreshControlLayer({ render = true } = {}) {
  try {
    const [ports, routes, events, bridge, profiles, graph] = await Promise.all([
      api("/control/ports"),
      api("/control/routes"),
      api("/control/events"),
      api("/control/bridge/status"),
      api("/control/cv/profiles"),
      api("/control/genetic/control-graph"),
    ]);
    controlState.ports = ports.ports || [];
    controlState.routes = routes.routes || [];
    controlState.events = events.events || [];
    controlState.bridgeStatus = bridge || null;
    controlState.cvProfiles = profiles.profiles || [];
    controlState.geneticGraph = graph || null;
    if (render) renderControlPanel();
  } catch (error) {
    controlState.events = [
      {
        id: "control_refresh_error",
        timestamp: new Date().toISOString(),
        source: "dashboard",
        kind: "event",
        value: { error: error.message },
      },
      ...(controlState.events || []),
    ];
    if (render) renderControlPanel();
    throw error;
  }
}

function controlSetTab(tab) {
  controlState.tab = CONTROL_TABS.has(tab) ? tab : "routing";
  localStorage.setItem("germinator-control-tab", controlState.tab);
  renderControlPanel();
}

function controlTabsMarkup() {
  const tabs = [
    ["routing", "Routing"],
    ["modulation", "Modulation"],
    ["io", "I/O"],
    ["midi", "MIDI"],
    ["osc", "OSC"],
    ["cv", "CV"],
    ["genetics", "Genetics"],
    ["monitor", "Monitor"],
  ];
  return `
    <div class="control-tabs" role="tablist" aria-label="Controller sections">
      ${tabs.map(([id, label]) => `<button class="control-tab${controlState.tab === id ? " active" : ""}" type="button" role="tab" data-action="control-tab" data-control-tab="${id}">${label}</button>`).join("")}
    </div>
  `;
}

function controlRouteRowsMarkup() {
  if (!controlState.routes.length) return `<div class="control-empty">No persisted control routes.</div>`;
  return controlState.routes.map((route) => `
    <article class="control-route-row">
      <div>
        <strong>${escapeHtml(route.label || route.id)}</strong>
        <span>${escapeHtml(controlPortLabel(route.source_port_id))} -> ${escapeHtml(controlPortLabel(route.target_port_id))}</span>
      </div>
      <div class="control-route-meta">
        <span>${escapeHtml(route.source_kind)} -> ${escapeHtml(route.target_kind)}</span>
        <span>${Math.round(Number(route.transform?.amount ?? 1) * 100)}%</span>
        <button class="secondary" type="button" data-action="control-toggle-route" data-route-id="${escapeHtml(route.id)}" data-enabled="${route.enabled ? "false" : "true"}">${route.enabled ? "Disable" : "Enable"}</button>
      </div>
    </article>
  `).join("");
}

function controlRoutingMarkup() {
  const firstSource = controlPortsFor("output")[0]?.id || "";
  const firstTarget = controlPortsFor("input")[0]?.id || "";
  const canRoute = Boolean(firstSource && firstTarget);
  return `
    <div class="control-layout">
      <section class="control-panel-card">
        <h3>Route Builder</h3>
        <div class="control-form-grid">
          <label>Source
            <select id="controlRouteSource">${controlPortOptions("output", firstSource)}</select>
          </label>
          <label>Destination
            <select id="controlRouteTarget">${controlPortOptions("input", firstTarget)}</select>
          </label>
          <label>Amount <input id="controlRouteAmount" type="range" min="0" max="2" step="0.01" value="1" /></label>
          <label>Smoothing <input id="controlRouteSmoothing" type="number" min="0" max="60000" step="1" value="20" /></label>
          <label>Curve
            <select id="controlRouteCurve">
              <option value="linear">linear</option>
              <option value="exponential">exponential</option>
              <option value="log">log</option>
              <option value="s_curve">s-curve</option>
              <option value="stepped">stepped</option>
            </select>
          </label>
          <label>Label <input id="controlRouteLabel" value="Control route" /></label>
        </div>
        <button type="button" data-action="control-save-route" ${canRoute ? "" : "disabled"}>Save Route</button>
      </section>
      <section class="control-panel-card">
        <h3>Persisted Routes</h3>
        <div class="control-route-list">${controlRouteRowsMarkup()}</div>
      </section>
    </div>
  `;
}

function controlModulationMarkup() {
  const routes = controlCanvasRoutes();
  const rows = routes.length
    ? routes.map((route) => `
      <article class="control-route-row">
        <div>
          <strong>${escapeHtml(route.source_label)}</strong>
          <span>${escapeHtml(route.target_label)}</span>
        </div>
        <div class="control-route-meta">
          <span>${escapeHtml(route.source_type)}</span>
          <span>${route.enabled ? "active" : "off"}</span>
        </div>
      </article>
    `).join("")
    : `<div class="control-empty">No canvas modulation routes yet.</div>`;
  return `
    <div class="control-layout">
      <section class="control-panel-card">
        <h3>Canvas Modulation</h3>
        <div class="control-route-list">${rows}</div>
      </section>
      <section class="control-panel-card">
        <h3>Snapshot</h3>
        <pre class="log slim">${escapeHtml(JSON.stringify(controlSnapshotPayload(), null, 2))}</pre>
      </section>
    </div>
  `;
}

function controlIoMarkup() {
  const asset = controlSelectedAsset();
  const audioPath = asset?.audioPath || asset?.storageUri || asset?.output_audio_path || "";
  const selectedLabel = audioPath ? displayNameFromPath(audioPath) : "No selected audio";
  const featureOptions = [
    ["all", "all features"],
    ["envelope", "envelope"],
    ["rms", "rms"],
    ["transient", "transient"],
    ["spectral_centroid", "spectral centroid"],
    ["pitch", "pitch"],
    ["chroma", "chroma"],
    ["onset_density", "onset density"],
    ["tempo", "tempo"],
    ["timbre", "timbre"],
  ];
  return `
    <div class="control-layout">
      <section class="control-panel-card">
        <h3>Audio-To-Control</h3>
        <p class="control-readout">${escapeHtml(selectedLabel)}</p>
        <div class="control-form-grid">
          <label>Feature
            <select id="controlAnalysisFeature">
              ${featureOptions.map(([value, label]) => `<option value="${value}">${label}</option>`).join("")}
            </select>
          </label>
          <label>Window ms <input id="controlAnalysisWindow" type="number" min="5" max="1000" step="1" value="40" /></label>
          <label>Hop ms <input id="controlAnalysisHop" type="number" min="5" max="1000" step="1" value="20" /></label>
          <label>Smooth <input id="controlAnalysisSmooth" type="range" min="0" max="1" step="0.01" value="0.15" /></label>
        </div>
        <button type="button" data-action="control-analyze-selected" ${audioPath ? "" : "disabled"}>Use as Control</button>
      </section>
      <section class="control-panel-card">
        <h3>Last Analysis</h3>
        <pre class="log slim">${escapeHtml(JSON.stringify(controlState.analysis || {}, null, 2))}</pre>
      </section>
    </div>
  `;
}

function controlMidiMarkup() {
  const nativeAvailable = Boolean(controlState.bridgeStatus?.midi_native);
  return `
    <div class="control-layout">
      <section class="control-panel-card">
        <h3>Web MIDI</h3>
        <p class="control-readout">${escapeHtml(controlState.midiStatus)}</p>
        <button type="button" data-action="control-midi-scan">Scan MIDI</button>
        <div class="control-form-grid compact">
          <label>Channel <input id="controlMidiChannel" type="number" min="1" max="16" value="1" /></label>
          <label>CC <input id="controlMidiCc" type="number" min="0" max="127" value="1" /></label>
          <label>Value <input id="controlMidiValue" type="number" min="0" max="127" value="64" /></label>
          <label>Backend
            <select id="controlMidiBackend">
              <option value="event">record intent</option>
              <option value="browser">browser Web MIDI</option>
              <option value="native_optional">native optional${nativeAvailable ? "" : " unavailable"}</option>
            </select>
          </label>
        </div>
        <button type="button" data-action="control-midi-send">Log / Send MIDI CC</button>
      </section>
      <section class="control-panel-card">
        <h3>Devices</h3>
        <div class="control-device-grid">
          <div><strong>Inputs</strong>${(controlState.midiInputs || []).map((item) => `<span>${escapeHtml(item)}</span>`).join("") || "<span>None</span>"}</div>
          <div><strong>Outputs</strong>${(controlState.midiOutputs || []).map((item) => `<span>${escapeHtml(item)}</span>`).join("") || "<span>None</span>"}</div>
        </div>
        <p class="control-readout">${escapeHtml(controlState.bridgeStatus?.detail?.midi_native || "")}</p>
      </section>
    </div>
  `;
}

function controlOscMarkup() {
  return `
    <div class="control-layout">
      <section class="control-panel-card">
        <h3>OSC Bridge</h3>
        <div class="control-form-grid">
          <label>Host <input id="controlOscHost" value="127.0.0.1" /></label>
          <label>Port <input id="controlOscPort" type="number" min="1" max="65535" value="9000" /></label>
          <label>Address <input id="controlOscAddress" value="/germ/mutation" /></label>
          <label>Value <input id="controlOscValue" type="number" step="0.01" value="0.5" /></label>
        </div>
        <div class="button-row">
          <button type="button" data-action="control-osc-send">Send UDP</button>
          <button class="secondary" type="button" data-action="control-osc-receive">Record Receive</button>
        </div>
      </section>
      <section class="control-panel-card">
        <h3>Bridge State</h3>
        <p class="control-readout">UDP send is restricted to loopback, private, or link-local targets. Receive is explicit bridge ingestion; the server does not open a background UDP listener.</p>
        <pre class="log slim">${escapeHtml(JSON.stringify(controlState.bridgeStatus || {}, null, 2))}</pre>
      </section>
      <section class="control-panel-card">
        <h3>norns / Fates</h3>
        <div class="control-form-grid compact">
          <label>Host <input id="controlNornsHost" value="127.0.0.1" /></label>
          <label>Port <input id="controlNornsPort" type="number" min="1" max="65535" value="10111" /></label>
          <label>Gravity <input id="controlNornsGravity" type="range" min="0" max="1" step="0.01" value="0.04" /></label>
          <label>Viscosity <input id="controlNornsViscosity" type="range" min="0" max="1" step="0.01" value="0.92" /></label>
          <label>Energy <input id="controlNornsEnergy" type="range" min="0" max="1" step="0.01" value="0.5" /></label>
        </div>
        <div class="button-row">
          <button type="button" data-action="control-norns-send">Send Fates State</button>
          <button class="secondary" type="button" data-action="control-norns-spawn">Spawn Pulse</button>
        </div>
      </section>
    </div>
  `;
}

function controlCvMarkup() {
  const cvFeatures = ["envelope", "rms", "transient", "spectral_centroid", "pitch", "chroma", "onset_density", "tempo", "timbre"];
  const profileRows = (controlState.cvProfiles || []).map((profile) => `
    <article class="control-route-row">
      <div>
        <strong>${escapeHtml(profile.name || profile.id)}</strong>
        <span>out ${escapeHtml(profile.output_channel)} · ${escapeHtml(profile.mode)} · ${profile.calibrated ? "calibrated" : "uncalibrated"}</span>
      </div>
      <div class="control-route-meta">
        <span>${profile.armed ? "armed" : "safe"}</span>
        <button class="secondary" type="button" data-action="control-cv-arm" data-profile-id="${escapeHtml(profile.id)}" data-armed="${profile.armed ? "false" : "true"}">${profile.armed ? "Disarm" : "Arm"}</button>
      </div>
    </article>
  `).join("") || `<div class="control-empty">No CV profiles.</div>`;
  return `
    <div class="control-layout">
      <section class="control-panel-card">
        <h3>CV-Safe Export</h3>
        <div class="control-form-grid">
          <label>Feature
            <select id="controlCvFeature">
              ${cvFeatures.map((feature) => `<option value="${feature}">${feature.replace(/_/g, " ")}</option>`).join("")}
            </select>
          </label>
          <label>Mode
            <select id="controlCvMode">
              <option value="cv">cv</option>
              <option value="gate">gate</option>
              <option value="clock">clock</option>
              <option value="pitch">pitch</option>
            </select>
          </label>
          <label>Range
            <select id="controlCvRange">
              <option value="unipolar">unipolar</option>
              <option value="bipolar">bipolar</option>
            </select>
          </label>
          <label>Scale <input id="controlCvScale" type="range" min="0" max="1" step="0.01" value="0.5" /></label>
          <label>Slew ms <input id="controlCvSlew" type="number" min="0" max="60000" step="1" value="5" /></label>
        </div>
        <button type="button" data-action="control-render-cv" ${controlState.analysis?.control_files?.[0] ? "" : "disabled"}>Render CV WAV</button>
      </section>
      <section class="control-panel-card">
        <h3>Calibration Profiles</h3>
        <div class="control-form-grid">
          <label>Name <input id="controlCvProfileName" value="CV Output 1" /></label>
          <label>Output <input id="controlCvProfileOutput" type="number" min="1" max="256" value="1" /></label>
          <label>Clamp min V <input id="controlCvClampMin" type="number" min="-10" max="10" step="0.1" value="0" /></label>
          <label>Clamp max V <input id="controlCvClampMax" type="number" min="-10" max="10" step="0.1" value="5" /></label>
          <label class="modulator-inline-check"><input id="controlCvCalibrated" type="checkbox" /> Calibrated</label>
          <label class="modulator-inline-check"><input id="controlCvSpeakerSafe" type="checkbox" checked /> Speaker safe</label>
        </div>
        <button type="button" data-action="control-cv-save-profile">Save Profile</button>
        <div class="control-route-list">${profileRows}</div>
        <h3>Last CV Render</h3>
        <pre class="log slim">${escapeHtml(JSON.stringify(controlState.cvRender || {}, null, 2))}</pre>
      </section>
    </div>
  `;
}

function controlMonitorMarkup() {
  const rows = (controlState.events || []).slice(-24).reverse().map((event) => `
    <article class="control-event-row">
      <strong>${escapeHtml(event.source || "control")}</strong>
      <span>${escapeHtml(event.kind || "event")}</span>
      <code>${escapeHtml(JSON.stringify(event.value ?? {}))}</code>
    </article>
  `).join("") || `<div class="control-empty">No monitor events.</div>`;
  return `
    <div class="control-layout single">
      <section class="control-panel-card">
        <h3>Monitor</h3>
        <div class="control-event-list">${rows}</div>
      </section>
    </div>
  `;
}

function controlGeneticsMarkup() {
  const graph = controlState.geneticGraph || { nodes: [], edges: [], source: {} };
  const controlNodes = (graph.nodes || []).filter((node) => String(node.type || "").startsWith("control")).slice(0, 80);
  const soundNodes = (graph.nodes || []).filter((node) => node.type === "sound").slice(0, 80);
  const edgeRows = (graph.edges || []).slice(0, 120).map((edge) => `
    <article class="control-event-row">
      <strong>${escapeHtml(edge.type || "edge")}</strong>
      <span>${escapeHtml(edge.from || "")}</span>
      <code>${escapeHtml(edge.to || "")}</code>
    </article>
  `).join("") || `<div class="control-empty">No control ancestry edges yet.</div>`;
  return `
    <div class="control-layout">
      <section class="control-panel-card">
        <h3>Control Ancestry</h3>
        <div class="control-genetic-stats">
          <span>${(graph.nodes || []).length} nodes</span>
          <span>${(graph.edges || []).length} edges</span>
          <span>${controlNodes.length} controls shown</span>
        </div>
        <div class="control-genetic-grid">
          <div>
            <strong>Control nodes</strong>
            ${controlNodes.map((node) => `<span>${escapeHtml(node.label || node.id)} <small>${escapeHtml(node.type || "")}</small></span>`).join("") || "<span>None</span>"}
          </div>
          <div>
            <strong>Sound nodes</strong>
            ${soundNodes.map((node) => `<span>${escapeHtml(node.label || node.id)} <small>${escapeHtml(node.mode || "")}</small></span>`).join("") || "<span>None</span>"}
          </div>
        </div>
      </section>
      <section class="control-panel-card">
        <h3>Relations</h3>
        <div class="control-event-list">${edgeRows}</div>
      </section>
    </div>
  `;
}

function renderControlPanel() {
  const body = $("controlPanelBody");
  if (!body) return;
  const view = {
    routing: controlRoutingMarkup,
    modulation: controlModulationMarkup,
    io: controlIoMarkup,
    midi: controlMidiMarkup,
    osc: controlOscMarkup,
    cv: controlCvMarkup,
    genetics: controlGeneticsMarkup,
    monitor: controlMonitorMarkup,
  }[controlState.tab] || controlRoutingMarkup;
  body.innerHTML = `${controlTabsMarkup()}${view()}`;
  syncAllRangeFills(body);
}

async function saveControlRouteFromPanel() {
  const source = $("controlRouteSource")?.value || "";
  const target = $("controlRouteTarget")?.value || "";
  const route = {
    source_port_id: source,
    target_port_id: target,
    source_kind: controlPortKind(source),
    target_kind: controlPortKind(target),
    label: $("controlRouteLabel")?.value || "Control route",
    enabled: true,
    transform: {
      amount: Number($("controlRouteAmount")?.value || 1),
      smoothing_ms: Number($("controlRouteSmoothing")?.value || 0),
      curve: $("controlRouteCurve")?.value || "linear",
    },
    lineage_role: "control-parent",
  };
  const saved = await api("/control/routes", { method: "POST", body: JSON.stringify(route) });
  await refreshControlLayer({ render: true });
  setState("Control Route Saved", "ok", saved.label || saved.id);
}

async function toggleControlRoute(routeId, enabled) {
  await api(`/control/routes/${encodeURIComponent(routeId)}/enable`, {
    method: "POST",
    body: JSON.stringify({ enabled }),
  });
  await refreshControlLayer({ render: true });
}

async function postControlSnapshot() {
  const snapshot = controlSnapshotPayload();
  await api("/control/events", {
    method: "POST",
    body: JSON.stringify({
      kind: "metadata",
      source: "dashboard_canvas",
      value: { action: "snapshot", route_count: snapshot.routes.length },
      metadata: snapshot,
    }),
  });
  await refreshControlLayer({ render: true });
  setState("Control Snapshot", "ok", `${snapshot.routes.length} route(s)`);
}

async function panicControlLayer() {
  await api("/control/panic", { method: "POST", body: JSON.stringify({}) });
  await refreshControlLayer({ render: true });
  setState("Control Panic", "ok", "Local panic-zero event posted.");
}

async function analyzeSelectedAsControl() {
  const asset = controlSelectedAsset();
  const audioPath = asset?.audioPath || asset?.storageUri || asset?.output_audio_path || "";
  if (!audioPath) throw new Error("Select a saved sound first.");
  const feature = $("controlAnalysisFeature")?.value || "all";
  const features = feature === "all"
    ? ["envelope", "rms", "transient", "spectral_centroid", "pitch", "chroma", "onset_density", "tempo", "timbre"]
    : [feature];
  beginWork("Control Analysis", displayNameFromPath(audioPath));
  const result = await api("/control/analyze-audio", {
    method: "POST",
    body: JSON.stringify({
      input_audio_path: audioPath,
      metadata_path: asset?.metadataPath || "",
      source_id: asset?.id || selectedCanvasNodeId || "",
      features,
      window_ms: Number($("controlAnalysisWindow")?.value || 40),
      hop_ms: Number($("controlAnalysisHop")?.value || 20),
      smooth: Number($("controlAnalysisSmooth")?.value || 0.15),
      output_name: safeOutputName(`control_${displayNameFromPath(audioPath)}`),
      lineage: {
        parents: asset ? [lineageSoundIdFromAsset(asset)].filter(Boolean) : [],
      },
    }),
  });
  controlState.analysis = result;
  await refreshControlLayer({ render: true });
  finishWork("Control Ready", "ok", `${result.features?.length || 0} feature(s)`);
}

async function renderControlCv() {
  const controlPath = controlState.analysis?.control_files?.[0];
  if (!controlPath) throw new Error("Analyze selected audio first.");
  const result = await api("/control/render-cv", {
    method: "POST",
    body: JSON.stringify({
      input_control_path: controlPath,
      feature: $("controlCvFeature")?.value || "envelope",
      duration: Math.max(0.1, Number(controlState.analysis?.duration || 4)),
      output_name: safeOutputName(`cv_${controlState.analysis?.id || "control"}`),
      mode: $("controlCvMode")?.value || "cv",
      range: $("controlCvRange")?.value || "unipolar",
      scale: Number($("controlCvScale")?.value || 0.5),
      slew_ms: Number($("controlCvSlew")?.value || 5),
    }),
  });
  controlState.cvRender = result;
  await refreshControlLayer({ render: true });
  setState("CV Export Ready", "ok", result.audio_file || "control wav");
}

async function scanMidiDevices() {
  if (!navigator.requestMIDIAccess) {
    controlState.midiStatus = "Web MIDI is unavailable in this browser.";
    renderControlPanel();
    return;
  }
  const access = await navigator.requestMIDIAccess({ sysex: false });
  controlState.midiInputs = Array.from(access.inputs.values()).map((input) => input.name || input.id);
  controlState.midiOutputs = Array.from(access.outputs.values()).map((output) => output.name || output.id);
  controlState.midiStatus = `${controlState.midiInputs.length} input(s), ${controlState.midiOutputs.length} output(s)`;
  await api("/control/events", {
    method: "POST",
    body: JSON.stringify({
      kind: "midi",
      source: "browser_web_midi",
      value: { inputs: controlState.midiInputs.length, outputs: controlState.midiOutputs.length },
      metadata: { input_names: controlState.midiInputs, output_names: controlState.midiOutputs },
    }),
  });
  await refreshControlLayer({ render: true });
}

async function sendMidiMessage() {
  const result = await api("/control/midi/send", {
    method: "POST",
    body: JSON.stringify({
      backend: $("controlMidiBackend")?.value || "event",
      channel: Number($("controlMidiChannel")?.value || 1),
      type: "cc",
      cc: Number($("controlMidiCc")?.value || 1),
      value: Number($("controlMidiValue")?.value || 64),
    }),
  });
  await refreshControlLayer({ render: true });
  setState("MIDI", result.sent ? "ok" : "muted", result.detail || result.status);
}

function controlOscPayload() {
  const value = Number($("controlOscValue")?.value || 0);
  return {
    host: $("controlOscHost")?.value || "127.0.0.1",
    port: Number($("controlOscPort")?.value || 9000),
    address: $("controlOscAddress")?.value || "/germ/value",
    values: [value],
  };
}

async function sendOscMessage() {
  const result = await api("/control/osc/send", {
    method: "POST",
    body: JSON.stringify(controlOscPayload()),
  });
  await refreshControlLayer({ render: true });
  setState("OSC Sent", result.sent ? "ok" : "bad", result.address || "");
}

async function receiveOscMessage() {
  const result = await api("/control/osc/receive", {
    method: "POST",
    body: JSON.stringify(controlOscPayload()),
  });
  await refreshControlLayer({ render: true });
  setState("OSC Receive", "ok", result.address || "");
}

async function sendNornsBridge(spawn = false) {
  const result = await api("/control/osc/norns/send", {
    method: "POST",
    body: JSON.stringify({
      host: $("controlNornsHost")?.value || $("controlOscHost")?.value || "127.0.0.1",
      port: Number($("controlNornsPort")?.value || 10111),
      profile: "fates",
      gravity: Number($("controlNornsGravity")?.value || 0),
      viscosity: Number($("controlNornsViscosity")?.value || 0),
      energy: Number($("controlNornsEnergy")?.value || 0),
      spawn,
      metadata: { source: "dashboard" },
    }),
  });
  await refreshControlLayer({ render: true });
  setState("Fates Bridge", result.sent ? "ok" : "bad", `${result.messages?.length || 0} OSC message(s)`);
}

async function saveCvProfile() {
  const profile = await api("/control/cv/profiles", {
    method: "POST",
    body: JSON.stringify({
      name: $("controlCvProfileName")?.value || "CV Output",
      output_channel: Number($("controlCvProfileOutput")?.value || 1),
      clamp_min_volts: Number($("controlCvClampMin")?.value || 0),
      clamp_max_volts: Number($("controlCvClampMax")?.value || 5),
      calibrated: Boolean($("controlCvCalibrated")?.checked),
      speaker_protection: Boolean($("controlCvSpeakerSafe")?.checked),
      armed: false,
    }),
  });
  await refreshControlLayer({ render: true });
  setState("CV Profile Saved", "ok", profile.name || profile.id);
}

async function armCvProfile(profileId, armed) {
  const profile = await api(`/control/cv/profiles/${encodeURIComponent(profileId)}/arm`, {
    method: "POST",
    body: JSON.stringify({ armed, confirm: armed }),
  });
  await refreshControlLayer({ render: true });
  setState(armed ? "CV Armed" : "CV Disarmed", armed ? "busy" : "ok", profile.name || profile.id);
}

function providerIsAvailable(providerId) {
  const status = providerStatusById[providerId];
  return !status || status.available !== false;
}

function firstAvailableProvider() {
  return Object.keys(providerModels).find((providerId) => providerIsAvailable(providerId)) || "";
}

function syncProviderOptions() {
  const providerSelect = $("provider");
  if (!providerSelect) return;
  Array.from(providerSelect.options).forEach((option) => {
    const status = providerStatusById[option.value];
    const unavailable = status && status.available === false;
    option.disabled = Boolean(unavailable);
    option.textContent = unavailable ? `${option.value} (unavailable)` : option.value;
    option.title = unavailable ? status.detail || "Provider unavailable" : "";
  });
  if (!providerIsAvailable(providerSelect.value)) {
    const fallback = firstAvailableProvider();
    if (fallback) providerSelect.value = fallback;
  }
}

function updateModels(preserve = true) {
  syncProviderOptions();
  const provider = $("provider").value;
  const previous = $("model").value;
  const models = providerModels[provider] || [];
  $("model").innerHTML = models.map((model) => `<option value="${model}">${model}</option>`).join("");
  if (preserve && models.includes(previous)) $("model").value = previous;
  $("activeProvider").textContent = provider;
  $("activeModel").textContent = $("model").value || "-";
  updateHomeReadouts();
}

function parseRanges(value) {
  return value
    .split(/[;\n]/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const parts = line.split(",").map((part) => Number(part.trim()));
      if (parts.length !== 2 || !Number.isFinite(parts[0]) || !Number.isFinite(parts[1])) {
        throw new Error(`Invalid inpaint range: ${line}`);
      }
      if (parts[1] <= parts[0]) {
        throw new Error(`Invalid inpaint range, end must be greater than start: ${line}`);
      }
      return parts;
    });
}

function loraPayload() {
  const textStrength = Number.isFinite(Number($("loraStrength")?.value)) ? Number($("loraStrength").value) : null;
  const manual = $("loraPaths")
    .value.split("\n")
    .map((path) => path.trim())
    .filter(Boolean)
    .map((path) => ({
      path,
      strength: textStrength,
    }));
  const registered = strainStack
    .filter((strain) => strain?.enabled !== false && strain?.path)
    .map((strain) => ({
      id: strain.id || null,
      name: strain.name || null,
      path: strain.path,
      strength: Number.isFinite(Number(strain.default_strength)) ? Number(strain.default_strength) : textStrength,
      tags: Array.isArray(strain.tags) ? strain.tags : [],
      author: strain.author || null,
      license: strain.license || null,
      source_dataset: strain.source_dataset || null,
      prompt_vocabulary: Array.isArray(strain.prompt_vocabulary) ? strain.prompt_vocabulary : [],
      recommended_modules: Array.isArray(strain.recommended_modules) ? strain.recommended_modules : [],
      provenance_notes: strain.provenance_notes || null,
    }));
  const seen = new Set();
  return [...manual, ...registered].filter((item) => {
    const key = item.id || item.path;
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function promptBridgeFields({ handoff = null, relisten = null } = {}) {
  if (handoff && typeof handoff === "object") {
    const source = handoff.source && typeof handoff.source === "object" ? handoff.source : {};
    const evidence = Array.isArray(handoff.evidence) ? handoff.evidence.slice(0, 8) : [];
    return {
      base_prompt: typeof handoff.base_prompt === "string" ? handoff.base_prompt : handoff.prompt || "",
      base_negative_prompt: typeof handoff.base_negative_prompt === "string" ? handoff.base_negative_prompt : "",
      source: { ...source, prompt_handoff_contract: handoff.contract || "oida-germ.prompt/v0.1" },
      parent_akousma_ids: Array.isArray(handoff.parent_akousma_ids) ? handoff.parent_akousma_ids : [],
      remember_to_akousmata: handoff.remember_to_akousmata !== false,
      covenant: handoff.covenant && typeof handoff.covenant === "object" ? handoff.covenant : {},
      akousma_summary: String(handoff.prompt || "").slice(0, 500) || null,
      listening_context: {
        prompt_handoff: {
          contract: handoff.contract || "oida-germ.prompt/v0.1",
          source,
          evidence,
        },
      },
      generation_context: {
        prompt_handoff: {
          contract: handoff.contract || "oida-germ.prompt/v0.1",
          source,
          evidence,
          ...(handoff.generation_context || {}),
        },
      },
    };
  }
  if (relisten && typeof relisten === "object") {
    const akousmaId = String(relisten.akousma_id || "");
    const compact = {
      contract: relisten.contract || "germ.oida-relisten/v0.1",
      provider: "oida",
      listening_event_id: relisten.listening_event_id || null,
      generation_id: relisten.generation_id || null,
      source_generation_id: relisten.source_generation_id || null,
      relisten_mode: relisten.relisten_mode || "gateway_listen",
      route_preset: relisten.route_preset || "generative",
      source_summary: relisten.source_summary || "",
      listening_result: relisten.listening_result || {},
      route_comparison: relisten.route_comparison || {},
    };
    return {
      source: { kind: "oida-relisten", akousma_id: akousmaId || null, event_id: relisten.listening_event_id || null },
      parent_akousma_ids: akousmaId ? [akousmaId] : [],
      remember_to_akousmata: Boolean(relisten.remembered && akousmaId),
      listening_context: { oida_relisten: compact },
      generation_context: { oida_relisten: compact },
    };
  }
  return {};
}

function applyPromptBridgeFields(payload, context = {}) {
  const fields = promptBridgeFields(context);
  if (!Object.keys(fields).length) return payload;
  const parentIds = [...new Set([
    ...(fields.parent_akousma_ids || []),
    ...(Array.isArray(payload.parent_akousma_ids) ? payload.parent_akousma_ids : []),
  ].filter(Boolean))];
  return {
    ...fields,
    ...payload,
    source: { ...(fields.source || {}), ...(payload.source || {}) },
    parent_akousma_ids: parentIds,
    covenant: { ...(fields.covenant || {}), ...(payload.covenant || {}) },
    listening_context: { ...(fields.listening_context || {}), ...(payload.listening_context || {}) },
    generation_context: { ...(fields.generation_context || {}), ...(payload.generation_context || {}) },
    remember_to_akousmata: payload.remember_to_akousmata ?? fields.remember_to_akousmata,
  };
}

function payloadBase(overrides = {}) {
  const payload = {
    provider: $("provider").value,
    model: $("model").value,
    prompt: $("prompt").value,
    negative_prompt: $("negativePrompt").value,
    duration: Number($("duration").value),
    steps: Number($("steps").value),
    cfg_scale: Number($("cfgScale").value),
    seed: Number($("seed").value),
    batch_size: Number($("batchSize").value),
    output_name: $("outputName").value || null,
    culture_id: activeCulture.id,
    tags: parseTags(document.getElementById("seedTags")?.value || ""),
    chunked_decode: $("chunkedDecode").checked,
    lora: loraPayload(),
    ...controlMetadataPayload(),
    ...overrides,
  };
  const skipActive = Boolean(payload._skipActivePromptContext);
  delete payload._skipActivePromptContext;
  return skipActive
    ? payload
    : applyPromptBridgeFields(payload, { handoff: activeAkousmaPromptHandoff });
}

function appendPayloadToForm(form, payload) {
  const jsonFormKeys = new Set([
    "lora",
    "tags",
    "lineage",
    "source",
    "latents",
    "ratings",
    "modulators",
    "semantic_layers",
    "semantic_effects",
    "generation_context",
    "control_routes",
    "control_snapshots",
    "control_sources",
    "region_roles",
    "preserve_ranges",
    "accent_ranges",
    "forbidden_ranges",
    "seed_ranges",
    "texture_ranges",
    "variation_ranges",
    "bridge_ranges",
    "silence_ranges",
    "genetic_identities",
    "generation_sequences",
    "parent_akousma_ids",
    "akousma_relations",
    "listening_context",
    "covenant",
  ]);
  for (const [key, value] of Object.entries(payload)) {
    if (value === null || value === undefined) continue;
    if (jsonFormKeys.has(key)) {
      form.append(key, JSON.stringify(value));
    } else if (key === "inpaint_ranges") {
      const ranges = Array.isArray(value)
        ? value.map((range) => Array.isArray(range) ? range.join(",") : String(range)).join(";")
        : String(value);
      form.append(key, ranges);
    } else if (Array.isArray(value)) {
      form.append(key, value.join(","));
    } else {
      form.append(key, String(value));
    }
  }
  return form;
}

function outputUrl(path) {
  if (!path) return "";
  if (/^(blob:|data:|https?:\/\/)/i.test(path)) return path;
  const safePath = path.startsWith("/") ? path.replace(/^\//, "") : path;
  return `${baseUrl()}/files/${safePath}`;
}

function wavetableExportUrl(id, format = "gwt") {
  if (!id) return "#";
  return `${baseUrl()}/wavetables/${encodeURIComponent(id)}/export?format=${encodeURIComponent(format)}`;
}

function audioContextForDecode() {
  const AudioContextClass = window.AudioContext || window.webkitAudioContext;
  if (!AudioContextClass) throw new Error("Audio decoding is not available in this browser.");
  if (!decodeAudioContext || decodeAudioContext.state === "closed") {
    decodeAudioContext = new AudioContextClass();
  }
  return decodeAudioContext;
}

async function decodeAudioArrayBuffer(buffer) {
  return audioContextForDecode().decodeAudioData(buffer.slice(0));
}

async function loadMetadata(path) {
  if (!path) return null;
  const response = await fetch(outputUrl(path));
  if (!response.ok) throw new Error(`Metadata not found: ${path}`);
  return response.json();
}

function displayNameFromPath(path) {
  if (!path) return "untitled";
  return path.split("/").pop().replace(/\.[^.]+$/, "");
}

function formatTime(seconds) {
  if (!Number.isFinite(seconds)) return "0:00";
  const whole = Math.max(0, Math.floor(seconds));
  const minutes = Math.floor(whole / 60);
  const rest = String(whole % 60).padStart(2, "0");
  return `${minutes}:${rest}`;
}

function formatPreciseTime(seconds) {
  const value = Number(seconds);
  if (!Number.isFinite(value)) return "0:00.00";
  const clamped = Math.max(0, value);
  const minutes = Math.floor(clamped / 60);
  const rest = (clamped - minutes * 60).toFixed(2).padStart(5, "0");
  return `${minutes}:${rest}`;
}

function metadataSummary(metadata) {
  if (!metadata) return "No metadata loaded.";
  const mode = metadata.germinator_mode || modeAliases[metadata.mode] || metadata.mode;
  const pieces = [
    mode,
    metadata.provider,
    metadata.model,
    `seed ${metadata.seed}`,
    `${metadata.duration}s`,
  ];
  return pieces.filter(Boolean).join(" | ");
}

function trackChips(metadata) {
  if (!metadata) return "<span>provider -</span><span>model -</span><span>seed -</span>";
  const mode = metadata.germinator_mode || modeAliases[metadata.mode] || metadata.mode;
  return [
    `provider ${metadata.provider || "-"}`,
    `model ${metadata.model || "-"}`,
    `mode ${mode || "-"}`,
    `runtime ${metadata.runtime || activeRuntime()}`,
    `seed ${metadata.seed ?? "-"}`,
    `cfg ${metadata.cfg_scale ?? "-"}`,
    `steps ${metadata.steps ?? "-"}`,
  ]
    .map((item) => `<span>${escapeHtml(item)}</span>`)
    .join("");
}

async function setCurrentTrack(audioPath, metadataPath, metadata = null) {
  if (!audioPath) return;
  let loadedMetadata = metadata || null;
  if (!loadedMetadata && metadataPath) {
    try {
      loadedMetadata = await loadMetadata(metadataPath);
    } catch (error) {
      loadedMetadata = {
        app: "germ",
        status: "metadata_missing",
        output_audio_path: audioPath,
        metadata_path: metadataPath,
        metadata_error: error.message,
      };
    }
  }
  currentTrack = { audioPath, metadataPath, metadata: loadedMetadata };
  $("trackTitle").textContent = displayNameFromPath(audioPath);
  $("audioPath").value = audioPath;
  $("metadataPath").value = metadataPath || loadedMetadata?.metadata_path || "";
  $("trackMeta").innerHTML = trackChips(loadedMetadata);
  $("audioPlayer").src = outputUrl(audioPath);
  $("playPauseBtn").disabled = false;
  $("playhead").disabled = false;
  showJson($("metadataJson"), loadedMetadata || currentTrack);
  updateHomeReadouts();
  await drawWaveform(audioPath);
}

async function drawWaveform(audioPath) {
  const canvas = $("waveform");
  if (!canvas) return;
  const ctx = canvas.getContext("2d");
  const width = canvas.width;
  const height = canvas.height;
  ctx.clearRect(0, 0, width, height);
  const isDark = document.documentElement.getAttribute("data-theme") === "dark";
  ctx.fillStyle = isDark ? "#1e1e1e" : "#F8F8F8";
  ctx.fillRect(0, 0, width, height);
  ctx.strokeStyle = isDark ? "rgba(255,255,255,0.05)" : "rgba(0,0,0,0.04)";
  ctx.lineWidth = 1;
  for (let x = 0; x < width; x += 45) {
    ctx.beginPath();
    ctx.moveTo(x, 0);
    ctx.lineTo(x, height);
    ctx.stroke();
  }

  try {
    const audioBuffer = await fetchAudioBuffer(audioPath);
    if (!audioBuffer) throw new Error("Waveform audio could not be decoded.");
    const data = audioBuffer.getChannelData(0);
    const step = Math.max(1, Math.floor(data.length / width));
    ctx.strokeStyle = isDark ? "#888" : "#5d5d5d";
    ctx.lineWidth = 2;
    ctx.beginPath();
    for (let x = 0; x < width; x += 1) {
      let min = 1;
      let max = -1;
      const offset = x * step;
      for (let i = 0; i < step && offset + i < data.length; i += 1) {
        const sample = data[offset + i];
        min = Math.min(min, sample);
        max = Math.max(max, sample);
      }
      const y1 = ((1 - max) * height) / 2;
      const y2 = ((1 - min) * height) / 2;
      ctx.moveTo(x, y1);
      ctx.lineTo(x, y2);
    }
    ctx.stroke();
  } catch {
    ctx.fillStyle = isDark ? "#666" : "#A3A09A";
    ctx.font = "14px system-ui, sans-serif";
    ctx.fillText("Waveform unavailable", 24, height / 2);
  }
}

async function renderOutput(result, { addToLayers = true } = {}) {
  lastResult = result;
  showJson($("statusJson"), result);
  const audioFiles = result.audio_files || [];
  const metadataFiles = result.metadata_files || [];
  if (!audioFiles.length) {
    if (metadataFiles[0]) {
      const metadata = await loadMetadata(metadataFiles[0]);
      showJson($("metadataJson"), metadata);
    }
    return;
  }

  for (let index = 0; index < audioFiles.length; index += 1) {
    const audioPath = audioFiles[index];
    const metadataPath = metadataFiles[index] || "";
    const metadata = metadataPath ? await loadMetadata(metadataPath) : null;
    if (addToLayers) {
      addLayer({ audioPath, metadataPath, metadata, select: index === 0 });
    } else if (index === 0) {
      await setCurrentTrack(audioPath, metadataPath, metadata);
    }
  }
  await refreshLibrary(false);
}

function addLayer({ audioPath, metadataPath, metadata, select = true }) {
  const id = audioPath || metadataPath || crypto.randomUUID();
  const existing = layers.findIndex((item) => item.id === id);
  const layer = {
    id,
    audioPath,
    metadataPath,
    metadata,
    createdAt: metadata?.created_at || new Date().toISOString(),
  };
  if (existing >= 0) layers.splice(existing, 1);
  layers.unshift(layer);
  if (layers.length > 24) layers = layers.slice(0, 24);
  if (select) {
    selectedLayerId = layer.id;
    setCurrentTrack(audioPath, metadataPath, metadata).catch((error) => {
      finishWork("Preview Error", "bad", error.message);
    });
  }
  renderLayers();
}

function removeLayer(id) {
  layers = layers.filter((item) => item.id !== id);
  if (selectedLayerId === id) selectedLayerId = layers[0]?.id || null;
  renderLayers();
}

function layerCard(layer, compact = false) {
  const metadata = layer.metadata || {};
  const title = displayNameFromPath(layer.audioPath || layer.metadataPath);
  const prompt = metadata.prompt || "No prompt";
  const selected = layer.id === selectedLayerId ? " selected" : "";
  return `
    <article class="layer-card${selected}" data-layer-id="${escapeHtml(layer.id)}">
      <strong>${escapeHtml(title)}</strong>
      <small>${escapeHtml(metadataSummary(metadata))}</small>
      ${compact ? "" : `<small>${escapeHtml(prompt)}</small>`}
      <div class="layer-actions">
        <button class="secondary" type="button" data-action="play-layer" data-layer-id="${escapeHtml(layer.id)}">Play</button>
        <button class="secondary" type="button" data-action="source-layer" data-layer-id="${escapeHtml(layer.id)}">Add</button>
        <button class="secondary" type="button" data-action="copy-layer" data-layer-id="${escapeHtml(layer.id)}">Copy</button>
        <button class="danger" type="button" data-action="remove-layer" data-layer-id="${escapeHtml(layer.id)}">Remove</button>
      </div>
    </article>
  `;
}

function renderLayers() {
  $("layerCount").textContent = `${layers.length} layer${layers.length === 1 ? "" : "s"}`;
  activeCulture.layerIds = layers.map((layer) => layer.id);
  activeCulture.updatedAt = new Date().toISOString();
  updateHomeReadouts();
  if (!layers.length) {
    $("layerStackCompact").className = "layer-stack empty";
    $("layerStackCompact").textContent = "No layers yet.";
    $("layerStackLarge").className = "layer-grid empty";
    $("layerStackLarge").textContent = "No layers yet.";
    return;
  }
  $("layerStackCompact").className = "layer-stack";
  $("layerStackLarge").className = "layer-grid";
  $("layerStackCompact").innerHTML = layers.slice(0, 6).map((layer) => layerCard(layer, true)).join("");
  $("layerStackLarge").innerHTML = layers.map((layer) => layerCard(layer, false)).join("");
}

function seedFromForm() {
  return {
    seed_id: crypto.randomUUID(),
    type: $("seedType").value,
    prompt: $("seedPrompt").value,
    negative_prompt: $("seedNegative").value,
    source_audio_path: $("seedSourcePath").value || null,
    random_seed: Number($("seedRandom").value),
    model: $("seedLockModel").checked ? $("model").value : null,
    runtime: $("seedLockModel").checked ? activeRuntime() : null,
    tags: parseTags($("seedTags").value),
    created_at: new Date().toISOString(),
  };
}

function seedPresets() {
  return [
    {
      seed_id: "preset-metal-breath",
      type: "prompt",
      prompt: "TrackType: SFX, dry metal breathing loop, close microphone, granular surface texture",
      negative_prompt: "speech, vocals, melody, long reverb",
      source_audio_path: null,
      random_seed: -1,
      model: $("model").value,
      runtime: activeRuntime(),
      tags: ["SFX", "loop", "texture"],
      created_at: "preset",
    },
    {
      seed_id: "preset-porous-drone",
      type: "prompt",
      prompt: "TrackType: SFX, porous low drone, unstable air pressure, subtle particulate movement",
      negative_prompt: "voice, beat, chord progression, bright melody",
      source_audio_path: null,
      random_seed: -1,
      model: $("model").value,
      runtime: activeRuntime(),
      tags: ["drone", "ambience"],
      created_at: "preset",
    },
  ];
}

function visibleSeeds() {
  return savedSeeds.length ? savedSeeds : seedPresets();
}

function renderSeeds() {
  $("seedCards").innerHTML = visibleSeeds()
    .map(
      (seed) => `
        <article>
          <strong>${escapeHtml(seed.type)} seed</strong>
          <span>${escapeHtml(seed.prompt || seed.source_audio_path || "random seed")}</span>
          <div class="petri-meta">${(seed.tags || []).map((tag) => `<span>${escapeHtml(tag)}</span>`).join("")}</div>
          <div class="candidate-actions">
            <button class="secondary" type="button" data-action="apply-seed" data-seed-id="${escapeHtml(seed.seed_id)}">Use</button>
          </div>
        </article>
      `,
    )
    .join("");
}

function saveSeed() {
  const seed = seedFromForm();
  savedSeeds.unshift(seed);
  activeCulture.seedIds.unshift(seed.seed_id);
  renderSeeds();
  renderCulture();
}

function seedById(id) {
  return [...savedSeeds, ...seedPresets()].find((seed) => seed.seed_id === id) || null;
}

function applySeed(seed = seedFromForm()) {
  $("prompt").value = seed.prompt || "";
  $("negativePrompt").value = seed.negative_prompt || "";
  $("seed").value = String(seed.random_seed ?? -1);
  $("outputName").value = safeOutputName(seed.tags?.[0] || "seed_germination");
  if (seed.model && providerModels[$("provider").value]?.includes(seed.model)) {
    $("model").value = seed.model;
  }
  if (seed.source_audio_path) {
    const sourceField = $("seedSourcePath");
    if (sourceField) sourceField.value = seed.source_audio_path;
  }
  updateModels();
}

async function germinateFromSeed() {
  const seed = seedFromForm();
  if (!savedSeeds.some((item) => item.seed_id === seed.seed_id)) {
    savedSeeds.unshift(seed);
    activeCulture.seedIds.unshift(seed.seed_id);
  }
  applySeed(seed);
  await generate();
  renderSeeds();
  renderCulture();
}

function safeOutputName(value) {
  return String(value || "germ")
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 48) || "germ";
}

function mutationPresetForValue(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return MUTATION_PRESETS[2];
  return MUTATION_PRESETS.reduce((closest, preset) => (
    Math.abs(preset.value - numeric) < Math.abs(closest.value - numeric) ? preset : closest
  ), MUTATION_PRESETS[0]);
}

function mutationPresetOptions(value) {
  const active = mutationPresetForValue(value);
  return MUTATION_PRESETS
    .map((preset) => {
      const label = `${preset.value.toFixed(2)} ${preset.label}`;
      return `<option value="${preset.value}"${preset.key === active.key ? " selected" : ""}>${escapeHtml(label)}</option>`;
    })
    .join("");
}

function canvasMutationValueForNode(node, promptPayload) {
  const explicit = Number(node?.variationMutation);
  if (Number.isFinite(explicit)) return mutationPresetForValue(explicit).value;
  return mutationPresetForValue(promptPayload?.mutation).value;
}

function loadSavedGroups() {
  try {
    savedGroups = JSON.parse(localStorage.getItem("germinator-saved-groups") || "[]")
      .filter((group) => group && Array.isArray(group.items));
  } catch {
    savedGroups = [];
  }
  activeCulture.groups = savedGroups;
}

function saveSavedGroups() {
  activeCulture.groups = savedGroups;
  try {
    localStorage.setItem("germinator-saved-groups", JSON.stringify(savedGroups.slice(0, 80)));
  } catch {
    // Groups remain available in memory if local storage is unavailable.
  }
  renderCulture();
}

function loadPetriState() {
  try {
    const stored = JSON.parse(localStorage.getItem(PETRI_STATE_STORAGE_KEY) || "{}");
    return stored && typeof stored === "object" && !Array.isArray(stored) ? stored : {};
  } catch {
    return {};
  }
}

function savePetriState() {
  try {
    localStorage.setItem(PETRI_STATE_STORAGE_KEY, JSON.stringify(petriState));
  } catch {
    // Petri state remains available in memory if local storage is unavailable.
  }
}

function petriStateTime(value) {
  const parsed = Date.parse(value || "");
  return Number.isFinite(parsed) ? parsed : 0;
}

function syncPetriStateFromMetadata(items = libraryItems) {
  let changed = false;
  items.forEach((item) => {
    const key = petriItemKey(item);
    const ratings = item?.ratings && typeof item.ratings === "object" ? item.ratings : null;
    if (!key || !ratings) return;
    const state = petriState[key] || {};
    const metadataTime = petriStateTime(ratings.updated_at || ratings.updatedAt);
    const localTime = petriStateTime(state.updatedAt);
    if (metadataTime < localTime) return;
    const next = { ...state };
    if (typeof ratings.favorite === "boolean") next.favorite = ratings.favorite;
    if (ratings.rating !== undefined) next.rating = Number(ratings.rating) || 0;
    if (ratings.play_count !== undefined) next.playCount = Number(ratings.play_count) || 0;
    if (ratings.use_count !== undefined) next.useCount = Number(ratings.use_count) || 0;
    if (ratings.harvest_count !== undefined) next.harvestCount = Number(ratings.harvest_count) || 0;
    if (ratings.listener_score !== undefined) next.listenerScore = Number(ratings.listener_score) || 0;
    if (ratings.updated_at || ratings.updatedAt) next.updatedAt = ratings.updated_at || ratings.updatedAt;
    if (JSON.stringify(next) !== JSON.stringify(state)) {
      petriState[key] = next;
      changed = true;
    }
  });
  if (changed) savePetriState();
}

function prunePetriState(items = libraryItems) {
  syncPetriStateFromMetadata(items);
  const liveKeys = new Set(items.map(petriItemKey).filter(Boolean));
  let changed = false;
  for (const key of Object.keys(petriState)) {
    if (!liveKeys.has(key)) {
      delete petriState[key];
      changed = true;
    }
  }
  if (changed) savePetriState();
}

function updatePetriState(key, nextState) {
  if (!key) return;
  petriState[key] = {
    ...(petriState[key] || {}),
    ...nextState,
    updatedAt: nextState.updatedAt || new Date().toISOString(),
  };
  savePetriState();
  return petriState[key];
}

function petriItemKey(item) {
  return item.metadata_file || item.audio_file || item.id;
}

function petriFitnessForItem(item) {
  const state = petriState[petriItemKey(item)] || {};
  let score = 1;
  if (state.favorite) score += 4;
  score += Math.min(5, Number(state.rating || 0));
  score += Math.min(3, Number(state.playCount || 0) * 0.35);
  score += Math.min(3, Number(state.useCount || 0) * 0.75);
  score += Math.min(2, Number(state.harvestCount || 0));
  score += Math.min(2, Number(state.listenerScore || 0) * 2);
  if (state.rejected) score -= 4;
  return Math.max(0, score);
}

function petriRatingsPayload(key) {
  const state = petriState[key] || {};
  return {
    favorite: Boolean(state.favorite),
    rating: Number(state.rating || 0),
    play_count: Number(state.playCount || 0),
    use_count: Number(state.useCount || 0),
    harvest_count: Number(state.harvestCount || 0),
    listener_score: Number(state.listenerScore || 0),
    fitness: Number(petriFitnessForItem(rackItemByKey(key) || {}).toFixed(3)),
    updated_at: state.updatedAt || new Date().toISOString(),
    source: "petri",
  };
}

async function persistPetriRatings(key) {
  const item = rackItemByKey(key);
  if (!item?.audio_file) return;
  await rackUpdateItemMetadata(item, { ratings: petriRatingsPayload(key) });
}

function recordPetriSignal(key, signal) {
  const current = petriState[key] || {};
  const countField = `${signal}Count`;
  updatePetriState(key, {
    [countField]: Number(current[countField] || 0) + 1,
    [`last${signal[0].toUpperCase()}${signal.slice(1)}At`]: new Date().toISOString(),
  });
  persistPetriRatings(key).catch((error) => setState("Petri Sync", "muted", error.message));
}

function modeValuesForItem(item) {
  const technicalMode = item.technical_mode || item.mode || "";
  const germinatorMode = item.germinator_mode || modeAliases[technicalMode] || modeAliases[item.mode] || "";
  return new Set(
    [item.mode, item.technical_mode, technicalMode, item.germinator_mode, germinatorMode]
      .filter(Boolean),
  );
}

function strainNamesForItem(item) {
  const strains = item.strain_stack || item.lora_strains || item.lora || [];
  if (!Array.isArray(strains)) return [];
  return strains
    .map((strain) => strain?.name || strain?.path || strain?.id || "")
    .map((name) => String(name).split("/").pop().replace(/\.(safetensors|pt|ckpt)$/i, ""))
    .filter(Boolean);
}

function sourceTypeForItem(item) {
  return item.source_type || item.source?.type || (typeof item.source === "string" ? item.source : "") || item.runtime || item.lineage?.source_type || "library";
}

function isWavetableItem(item) {
  return item?.asset_type === "wavetable" || Boolean(item?.wavetable_id || item?.data_file);
}

function libraryAssetTitle(item) {
  if (isWavetableItem(item)) return item.name || item.wavetable_id || item.id || displayNameFromPath(item.metadata_file);
  return displayNameFromPath(item.audio_file || item.metadata_file);
}

function wavetableLibraryItems() {
  const byId = new Map();
  libraryItems.filter(isWavetableItem).forEach((item) => {
    const id = item.wavetable_id || item.id;
    if (id) byId.set(id, item);
  });
  wavetableItems.forEach((item) => {
    if (!byId.has(item.id)) {
      byId.set(item.id, {
        asset_type: "wavetable",
        id: item.id,
        wavetable_id: item.id,
        name: item.name,
        frame_count: item.frame_count,
        frame_size: item.frame_size,
        root_note: item.root_note,
        prompt: item.source_prompt,
        tags: item.tags || [],
        metadata_file: item.metadata_path,
        data_file: item.data_path,
        operation: item.operation,
        created_at: item.created_at,
        table_classification: item.table_classification,
        warnings: item.warnings || [],
      });
    }
  });
  return [...byId.values()];
}

function ratingForItem(item) {
  const state = petriState[petriItemKey(item)] || {};
  return Number(state.rating ?? item.ratings?.rating ?? item.rating ?? 0) || 0;
}

function populateSelectOptions(selectId, values, fallbackLabel) {
  const select = $(selectId);
  if (!select) return;
  const current = select.value;
  const unique = [...new Set(values.filter(Boolean).map(String))].sort((a, b) => a.localeCompare(b));
  select.innerHTML = [`<option value="">${escapeHtml(fallbackLabel)}</option>`, ...unique.map((value) => `<option value="${escapeHtml(value)}">${escapeHtml(value)}</option>`)].join("");
  if (unique.includes(current)) select.value = current;
}

function updatePetriFilterOptions() {
  populateSelectOptions("libModel", libraryItems.map((item) => item.model), "all models");
  populateSelectOptions("libSourceType", libraryItems.map(sourceTypeForItem), "all sources");
  populateSelectOptions("libStrain", libraryItems.flatMap(strainNamesForItem), "all strains");
  populateSelectOptions("libTag", libraryItems.flatMap((item) => item.tags || []), "all tags");
}

function petriMatches(item) {
  if (!item.audio_file || item.audio_exists === false) return false;
  const query = ($("libSearch")?.value || "").trim().toLowerCase();
  const mode = $("libMode")?.value || "";
  const model = $("libModel")?.value || "";
  const sourceType = $("libSourceType")?.value || "";
  const strain = $("libStrain")?.value || "";
  const durationFilter = $("libDuration")?.value || "";
  const ratingFilter = $("libRating")?.value || "";
  const tag = $("libTag")?.value || "";
  const modeValues = modeValuesForItem(item);
  const germinatorMode = item.germinator_mode || modeAliases[item.mode] || item.mode || "";
  if (mode && !modeValues.has(mode)) return false;
  if (model && item.model !== model) return false;
  if (sourceType && sourceTypeForItem(item) !== sourceType) return false;
  if (strain && !strainNamesForItem(item).includes(strain)) return false;
  if (tag && !(item.tags || []).includes(tag)) return false;
  const duration = Number(item.duration) || 0;
  if (durationFilter === "short" && duration >= 5) return false;
  if (durationFilter === "medium" && (duration < 5 || duration > 20)) return false;
  if (durationFilter === "long" && duration <= 20) return false;
  if (ratingFilter === "favorite" && !petriState[petriItemKey(item)]?.favorite) return false;
  if (ratingFilter === "rated" && ratingForItem(item) <= 0) return false;
  if (!query) return true;
  return [
    item.prompt,
    item.negative_prompt,
    item.notes,
    item.model,
    item.provider,
    item.runtime,
    item.mode,
    germinatorMode,
    item.operation,
    item.seed,
    sourceTypeForItem(item),
    item.audio_file,
    item.metadata_file,
    ...strainNamesForItem(item),
    ...(item.tags || []),
  ]
    .join(" ")
    .toLowerCase()
    .includes(query);
}

function sortedPetriItems() {
  const sort = $("libSort")?.value || "date";
  const items = libraryItems.filter(petriMatches);
  return items.sort((a, b) => {
    if (sort === "fitness") return petriFitnessForItem(b) - petriFitnessForItem(a);
    if (sort === "model") return String(a.model || "").localeCompare(String(b.model || ""));
    if (sort === "seed") return (Number(b.seed) || 0) - (Number(a.seed) || 0);
    if (sort === "duration") return (b.duration || 0) - (a.duration || 0);
    return String(b.created_at || "").localeCompare(String(a.created_at || ""));
  });
}

function renderPetri() {
  renderHerbarium();
}

function candidateCard(item, scope = "petri") {
  const key = petriItemKey(item);
  const state = petriState[key] || {};
  const title = displayNameFromPath(item.audio_file || item.metadata_file);
  const metadataPath = item.metadata_file || "";
  const audioPath = item.audio_file || "";
  const classes = ["petri-card"];
  if (state.favorite) classes.push("favorite");
  if (state.rejected) classes.push("rejected");
  const favoriteLabel = state.favorite ? "Unfavorite" : "Favorite";
  return `
    <article class="${classes.join(" ")}" data-candidate-key="${escapeHtml(key)}">
      <div class="petri-wave-shell">
        <canvas class="petri-canvas" width="300" height="300" data-audio="${escapeHtml(item.audio_file || "")}"></canvas>
        <div class="petri-wave-actions">
          <button class="petri-wave-action action-favorite${state.favorite ? " active" : ""}" type="button" data-action="petri-favorite" data-key="${escapeHtml(key)}" aria-label="${favoriteLabel}" title="${favoriteLabel}" data-help="Mark this sound as a favorite.">${iconSvg("favorite")}</button>
          <button class="petri-wave-action action-play" type="button" data-action="petri-preview" data-metadata="${escapeHtml(metadataPath)}" data-audio="${escapeHtml(audioPath)}" aria-label="Play" title="Play" data-help="Audition this sound.">${iconSvg("play")}</button>
          <button class="petri-wave-action action-lineage" type="button" data-action="petri-lineage" data-metadata="${escapeHtml(metadataPath)}" data-audio="${escapeHtml(audioPath)}" aria-label="Open lineage" title="Lineage" data-help="View parents, branches, mutations, and descendants.">${iconSvg("lineage")}</button>
          <button class="petri-wave-action action-source" type="button" data-action="petri-source" data-metadata="${escapeHtml(metadataPath)}" data-audio="${escapeHtml(audioPath)}" aria-label="Use source" title="Use source" data-help="Place this sound on the canvas.">${iconSvg("source")}</button>
        </div>
      </div>
      <strong>${escapeHtml(title)}</strong>
      <small>${escapeHtml(item.prompt || sourceTypeForItem(item) || item.error || "No prompt")}</small>
    </article>
  `;
}

function wavetableMatchesLibrary(item) {
  const query = ($("libSearch")?.value || "").trim().toLowerCase();
  const tag = $("libTag")?.value || "";
  const ratingFilter = $("libRating")?.value || "";
  if (tag && !(item.tags || []).includes(tag)) return false;
  if (ratingFilter === "favorite" && !petriState[petriItemKey(item)]?.favorite) return false;
  if (ratingFilter === "rated" && ratingForItem(item) <= 0) return false;
  if (!query) return true;
  return [
    item.name,
    item.wavetable_id,
    item.id,
    item.prompt,
    item.operation,
    item.metadata_file,
    item.data_file,
    item.root_note,
    item.table_classification,
    ...(item.tags || []),
    ...(item.warnings || []),
  ].join(" ").toLowerCase().includes(query);
}

function sortedWavetableLibraryItems() {
  return wavetableLibraryItems()
    .filter(wavetableMatchesLibrary)
    .sort((a, b) => String(b.created_at || "").localeCompare(String(a.created_at || "")));
}

function wavetableCard(item) {
  const key = petriItemKey(item);
  const state = petriState[key] || {};
  const id = item.wavetable_id || item.id || "";
  const favoriteLabel = state.favorite ? "Unfavorite" : "Favorite";
  const exportHref = wavetableExportUrl(id);
  const frameText = `${item.frame_count || "-"} x ${item.frame_size || "-"} · ${item.root_note || "-"}`;
  return `
    <article class="petri-card ${state.favorite ? "favorite" : ""}" data-candidate-key="${escapeHtml(key)}">
      <div class="petri-wave-shell">
        <canvas class="petri-wavetable-strip" width="300" height="300" data-wavetable-id="${escapeHtml(id)}"></canvas>
        <div class="petri-wave-actions">
          <button class="petri-wave-action action-favorite${state.favorite ? " active" : ""}" type="button" data-action="petri-favorite" data-key="${escapeHtml(key)}" aria-label="${favoriteLabel}" title="${favoriteLabel}">${iconSvg("favorite")}</button>
          <button class="petri-wave-action action-source" type="button" data-action="wavetable-asset-use" data-wavetable-id="${escapeHtml(id)}" aria-label="Use in Germ" title="Use in Germ">${iconSvg("source")}</button>
          <button class="petri-wave-action action-play" type="button" data-action="wavetable-asset-render" data-wavetable-id="${escapeHtml(id)}" aria-label="Render" title="Render">${iconSvg("render")}</button>
          <a class="petri-wave-action action-lineage" href="${escapeHtml(exportHref)}" download title="Export GWT" aria-label="Export GWT">${iconSvg("download")}</a>
        </div>
      </div>
      <strong>${escapeHtml(libraryAssetTitle(item))}</strong>
      <small>${escapeHtml(frameText)}</small>
    </article>
  `;
}

function renderWavetableHerbarium() {
  const target = $("herbariumList");
  if (!target) return;
  const total = wavetableLibraryItems().length;
  if ($("libTotal")) $("libTotal").textContent = String(total);
  if ($("libDone")) $("libDone").textContent = String(total);
  if ($("libError")) $("libError").textContent = "0";
  if ($("libFavorites")) $("libFavorites").textContent = String(wavetableLibraryItems().filter(i => petriState[petriItemKey(i)]?.favorite).length);
  if (!total) {
    target.className = "petri-disc-grid empty";
    target.textContent = "No wavetables found.";
    updatePetriPagination(0, 0);
    return;
  }
  const items = sortedWavetableLibraryItems();
  if (!items.length) {
    target.className = "petri-disc-grid empty";
    target.textContent = "No wavetables match the current filters.";
    updatePetriPagination(0, 0);
    return;
  }
  const totalPages = Math.ceil(items.length / PETRI_PAGE_SIZE);
  petriPage = Math.max(0, Math.min(petriPage, totalPages - 1));
  const start = petriPage * PETRI_PAGE_SIZE;
  const pageItems = items.slice(start, start + PETRI_PAGE_SIZE);
  target.className = "petri-disc-grid";
  target.innerHTML = pageItems.map(wavetableCard).join("");
  updatePetriPagination(petriPage, totalPages);
  requestAnimationFrame(() => drawWavetableLibraryCanvases(target));
}

function drawWavetableLibraryCanvases(root = document) {
  root.querySelectorAll(".petri-wavetable-strip[data-wavetable-id]").forEach((canvas) => {
    const id = canvas.dataset.wavetableId || "";
    const table = wavetableById(id) || wavetableLibraryItems().find((item) => (item.wavetable_id || item.id) === id);
    drawWavetableFrameStrip(canvas, table, null);
    fetchWavetableData(id)
      .then((frames) => drawWavetableFrameStrip(canvas, table, frames))
      .catch(() => drawWavetableMiniScope(canvas, table, null));
  });
}

function groupCard(group) {
  const items = group.items || [];
  const dots = items.slice(0, 8).map((item, index) => {
    const angle = (Math.PI * 2 * index) / Math.max(1, Math.min(items.length, 8)) - Math.PI / 2;
    const x = 28 + Math.cos(angle) * 20;
    const y = 28 + Math.sin(angle) * 20;
    return `<span style="left:${x.toFixed(1)}px;top:${y.toFixed(1)}px"></span>`;
  }).join("");
  return `
    <article class="petri-group-card">
      <div class="petri-group-map">
        ${dots}
      </div>
      <div class="petri-group-info">
        <strong>${escapeHtml(group.name || "Saved group")}</strong>
        <small>${items.length} sound${items.length === 1 ? "" : "s"} · ${escapeHtml(new Date(group.updatedAt || group.createdAt || Date.now()).toLocaleDateString())}</small>
        <div class="petri-group-tags">${items.slice(0, 4).map((item) => `<span>${escapeHtml(item.label || displayNameFromPath(item.audioPath))}</span>`).join("")}</div>
      </div>
      <button class="secondary" type="button" data-action="petri-load-group" data-group-id="${escapeHtml(group.id)}">Load</button>
    </article>
  `;
}

function renderPetriGroups() {
  const target = $("herbariumList");
  if (!target) return;
  const query = ($("libSearch")?.value || "").trim().toLowerCase();
  const groups = savedGroups.filter((group) => {
    if (!query) return true;
    return [
      group.name,
      group.id,
      ...(group.items || []).flatMap((item) => [item.label, item.audioPath, item.metadataPath]),
    ].join(" ").toLowerCase().includes(query);
  });
  if (!groups.length) {
    target.className = "petri-groups-list empty";
    target.textContent = savedGroups.length
      ? "No groups match the current filters."
      : "No saved groups yet. Select sounds on the canvas, then create a mixer.";
    updatePetriPagination(0, 0);
    return;
  }
  target.className = "petri-groups-list";
  target.innerHTML = groups.map(groupCard).join("");
  updatePetriPagination(0, 0);
}

function renderHerbarium() {
  const target = $("herbariumList");
  if (!target) return;
  document.querySelectorAll(".petri-tab").forEach((button) => button.classList.toggle("active", button.dataset.view === petriLibraryView));
  if (petriLibraryView === "groups") {
    renderPetriGroups();
    return;
  }
  if (petriLibraryView === "wavetables") {
    renderWavetableHerbarium();
    return;
  }

  // Update stats
  const playableTotal = libraryItems.filter((item) => item.audio_file && item.audio_exists !== false).length;
  const total = playableTotal;
  const done = libraryItems.filter(i => i.audio_file && i.audio_exists !== false && (i.status || "done") === "done").length;
  const errors = libraryItems.filter(i => i.status === "error").length;
  const favorites = libraryItems.filter(i => petriState[petriItemKey(i)]?.favorite).length;
  if ($("libTotal")) $("libTotal").textContent = String(total);
  if ($("libDone")) $("libDone").textContent = String(done);
  if ($("libError")) $("libError").textContent = String(errors);
  if ($("libFavorites")) $("libFavorites").textContent = String(favorites);

  if (!total) {
    target.className = "petri-disc-grid empty";
    target.textContent = "No sounds found. Generate audio to populate the library.";
    updatePetriPagination(0, 0);
    return;
  }

  const items = sortedPetriItems();

  if (!items.length) {
    target.className = "petri-disc-grid empty";
    target.textContent = "No sounds match the current filters.";
    updatePetriPagination(0, 0);
    return;
  }

  // Pagination: show PETRI_PAGE_SIZE items per page
  const totalPages = Math.ceil(items.length / PETRI_PAGE_SIZE);
  petriPage = Math.max(0, Math.min(petriPage, totalPages - 1));
  const start = petriPage * PETRI_PAGE_SIZE;
  const pageItems = items.slice(start, start + PETRI_PAGE_SIZE);

  target.className = "petri-disc-grid";
  target.innerHTML = pageItems.map((item) => candidateCard(item, "herbarium")).join("");
  updatePetriPagination(petriPage, totalPages);
  requestAnimationFrame(() => renderPetriCanvases());
}

function getFilenameStem(path) {
  if (!path) return "";
  const name = path.split("/").pop();
  const idx = name.lastIndexOf(".");
  return idx !== -1 ? name.slice(0, idx) : name;
}

function getFilenameExtension(path) {
  if (!path) return "";
  const name = path.split("/").pop();
  const idx = name.lastIndexOf(".");
  return idx !== -1 ? name.slice(idx) : "";
}

function formatFileSize(bytes) {
  if (bytes === null || bytes === undefined) return "-";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1048576) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1048576).toFixed(1)} MB`;
}

function rackSearchMatches(item) {
  if (!isWavetableItem(item) && (!item.audio_file || item.audio_exists === false)) return false;

  const filterMode = $("rackFilterMode")?.value;
  if (filterMode) {
    if (filterMode === "wavetable") return isWavetableItem(item);
    if (isWavetableItem(item)) return false;
    const itemMode = item.germinator_mode || item.mode || "";
    if (filterMode === "archive") {
      if (itemMode !== "archive" && itemMode !== "file") return false;
    } else {
      if (itemMode !== filterMode) return false;
    }
  }
  
  const filterFav = $("rackFilterFav")?.value;
  if (filterFav === "favorite") {
    const key = petriItemKey(item);
    if (!petriState[key]?.favorite) return false;
  }

  const query = ($("rackSearch")?.value || "").trim().toLowerCase();
  if (!query) return true;
  return [
    libraryAssetTitle(item),
    item.prompt,
    item.name,
    item.notes,
    item.model,
    item.provider,
    item.mode,
    item.germinator_mode,
    item.operation,
    item.seed,
    item.audio_file,
    item.metadata_file,
    item.data_file,
    item.wavetable_id,
    ...(item.tags || []),
  ].join(" ").toLowerCase().includes(query);
}

function rackGroupValue(item, groupBy) {
  if (isWavetableItem(item)) {
    if (groupBy === "mode") return "wavetable";
    if (groupBy === "model") return item.runtime || "wavetable";
    if (groupBy === "tag") return (item.tags || [])[0] || "wavetable";
  }
  if (groupBy === "mode") return item.germinator_mode || item.mode || "archive";
  if (groupBy === "model") return item.model || "unknown";
  if (groupBy === "tag") return (item.tags || [])[0] || "untagged";
  return String(item.created_at || "").slice(0, 10) || "undated";
}

function rackItems() {
  const groupBy = $("rackGroup")?.value || "date";
  const sortVal = $("rackSort")?.value || "date_desc";
  
  const filtered = libraryItems.filter(rackSearchMatches);
  
  let sortFn;
  if (sortVal === "date_desc") {
    sortFn = (a, b) => String(b.created_at || "").localeCompare(String(a.created_at || ""));
  } else if (sortVal === "date_asc") {
    sortFn = (a, b) => String(a.created_at || "").localeCompare(String(b.created_at || ""));
  } else if (sortVal === "name_asc") {
    sortFn = (a, b) => libraryAssetTitle(a).localeCompare(libraryAssetTitle(b));
  } else if (sortVal === "duration_desc") {
    sortFn = (a, b) => (b.duration || 0) - (a.duration || 0);
  } else if (sortVal === "size_desc") {
    sortFn = (a, b) => (b.file_size || 0) - (a.file_size || 0);
  } else {
    sortFn = (a, b) => String(b.created_at || "").localeCompare(String(a.created_at || ""));
  }
  
  if (groupBy === "none") {
    return filtered.sort(sortFn);
  }
  
  return filtered.sort((a, b) => {
    const groupCompare = rackGroupValue(a, groupBy).localeCompare(rackGroupValue(b, groupBy));
    if (groupCompare) return groupCompare;
    return sortFn(a, b);
  });
}

function renderRack() {
  const body = $("rackTableBody");
  if (!body) return;
  const items = rackItems();
  
  rackSelectedKeys = new Set([...rackSelectedKeys].filter((key) => items.some((item) => petriItemKey(item) === key)));
  
  let selectedDuration = 0;
  let selectedSize = 0;
  items.forEach(item => {
    if (rackSelectedKeys.has(petriItemKey(item))) {
      selectedDuration += item.duration || 0;
      selectedSize += item.file_size || 0;
    }
  });
  
  const statsLabel = $("rackStats");
  if (statsLabel) {
    const tableCount = items.filter(isWavetableItem).length;
    const soundCount = items.length - tableCount;
    statsLabel.textContent = `Total: ${items.length} assets · ${soundCount} sounds · ${tableCount} tables · Selected: ${rackSelectedKeys.size} (${selectedDuration.toFixed(1)}s, ${formatFileSize(selectedSize)})`;
  }
  
  const bulkDeleteBtn = $("rackBulkDeleteBtn");
  if (bulkDeleteBtn) {
    bulkDeleteBtn.disabled = rackSelectedKeys.size === 0;
  }
  
  const selectAllCheckbox = $("rackSelectAll");
  if (selectAllCheckbox) {
    selectAllCheckbox.checked = items.length > 0 && items.every(item => rackSelectedKeys.has(petriItemKey(item)));
  }

  if (!items.length) {
    body.innerHTML = `<tr><td colspan="8" class="rack-empty">No sounds found.</td></tr>`;
    return;
  }
  
  let currentGroup = "";
  const rows = [];
  const groupBy = $("rackGroup")?.value || "date";
  
  items.forEach((item) => {
    const key = petriItemKey(item);
    const group = rackGroupValue(item, groupBy);
    if (groupBy !== "none" && group !== currentGroup) {
      currentGroup = group;
      rows.push(`<tr class="rack-group-row"><td colspan="8">${escapeHtml(group)}</td></tr>`);
    }
    
    const selected = rackSelectedKeys.has(key) ? " checked" : "";
    if (isWavetableItem(item)) {
      const id = item.wavetable_id || item.id || "";
      const title = libraryAssetTitle(item);
      const tags = (item.tags || []).join(", ");
      const frameText = `${item.frame_count || "-"} frames · ${item.frame_size || "-"} samples · ${item.root_note || "-"}`;
      const classification = item.table_classification || item.operation || "wavetable";
      rows.push(`
        <tr class="rack-row" data-key="${escapeHtml(key)}">
          <td><input class="rack-select-row" type="checkbox" data-action="rack-select" data-key="${escapeHtml(key)}"${selected} aria-label="Select ${escapeHtml(title)}" /></td>
          <td>
            <div class="rack-filename-wrapper">
              <input class="rack-filename-input" data-key="${escapeHtml(key)}" value="${escapeHtml(title)}" aria-label="Wavetable name" title="Wavetable name" readonly />
              <span class="rack-filename-ext">.gwt</span>
            </div>
          </td>
          <td>
            <input class="rack-prompt-input" data-key="${escapeHtml(key)}" value="${escapeHtml(item.prompt || "")}" aria-label="Prompt text" title="Prompt description" readonly />
          </td>
          <td>
            <input class="rack-tags-input" data-key="${escapeHtml(key)}" value="${escapeHtml(tags)}" aria-label="Tags" title="Tags" readonly />
          </td>
          <td>wavetable</td>
          <td>${escapeHtml(item.runtime || "-")}</td>
          <td class="rack-stats-cell">${escapeHtml(`${frameText} · ${classification}`)}</td>
          <td>
            <div class="rack-actions">
              <button type="button" data-action="wavetable-asset-use" data-wavetable-id="${escapeHtml(id)}" aria-label="Use in Germ" title="Use in Germ">${iconSvg("source")}</button>
              <button type="button" data-action="wavetable-asset-render" data-wavetable-id="${escapeHtml(id)}" aria-label="Render as source" title="Render as source">${iconSvg("render")}</button>
              <button type="button" data-action="wavetable-asset-mutate" data-wavetable-id="${escapeHtml(id)}" aria-label="Mutate table" title="Mutate">${iconSvg("lineage")}</button>
              <a href="${escapeHtml(wavetableExportUrl(id))}" download class="rack-button" style="display: grid; place-items: center; width: 28px; height: 28px; border: 1px solid var(--line); border-radius: 7px; background: var(--panel); color: var(--ink); padding: 0;" title="Export GWT">${iconSvg("download")}</a>
              <button type="button" data-action="rack-lineage" data-metadata="${escapeHtml(item.metadata_file || "")}" data-audio="" aria-label="Lineage" title="Lineage">${iconSvg("lineage")}</button>
              <button type="button" data-action="rack-copy-path" data-path="${escapeHtml(item.metadata_file || "")}" aria-label="Copy metadata path" title="Copy metadata path">${iconSvg("copy")}</button>
            </div>
          </td>
        </tr>
      `);
      return;
    }
    const stem = getFilenameStem(item.audio_file);
    const ext = getFilenameExtension(item.audio_file);
    const prompt = item.prompt || "";
    const tags = (item.tags || []).join(", ");
    
    const durStr = item.duration ? `${item.duration.toFixed(1)}s` : "-";
    const srStr = item.sample_rate ? `${(item.sample_rate / 1000).toFixed(0)}k` : "-";
    const sizeStr = formatFileSize(item.file_size);
    const statsCell = `${durStr} · ${srStr} · ${sizeStr}`;
    
    rows.push(`
      <tr class="rack-row" data-key="${escapeHtml(key)}">
        <td><input class="rack-select-row" type="checkbox" data-action="rack-select" data-key="${escapeHtml(key)}"${selected} aria-label="Select ${escapeHtml(stem)}" /></td>
        <td>
          <div class="rack-filename-wrapper">
            <input class="rack-filename-input" data-key="${escapeHtml(key)}" value="${escapeHtml(stem)}" aria-label="Filename stem" title="Edit filename on disk" />
            <span class="rack-filename-ext">${escapeHtml(ext)}</span>
          </div>
        </td>
        <td>
          <input class="rack-prompt-input" data-key="${escapeHtml(key)}" value="${escapeHtml(prompt)}" aria-label="Prompt text" title="Edit prompt description" />
        </td>
        <td>
          <input class="rack-tags-input" data-key="${escapeHtml(key)}" value="${escapeHtml(tags)}" aria-label="Tags" title="Edit tags (comma separated)" />
        </td>
        <td>${escapeHtml(item.germinator_mode || item.mode || "-")}</td>
        <td>${escapeHtml(item.model || "-")}</td>
        <td class="rack-stats-cell">${escapeHtml(statsCell)}</td>
        <td>
          <div class="rack-actions">
            <button type="button" data-action="rack-play" data-metadata="${escapeHtml(item.metadata_file || "")}" data-audio="${escapeHtml(item.audio_file || "")}" aria-label="Play" title="Audition">${iconSvg("play")}</button>
            <button type="button" data-action="rack-source" data-metadata="${escapeHtml(item.metadata_file || "")}" data-audio="${escapeHtml(item.audio_file || "")}" aria-label="Use source" title="Use source">${iconSvg("source")}</button>
            <button type="button" data-action="rack-lineage" data-metadata="${escapeHtml(item.metadata_file || "")}" data-audio="${escapeHtml(item.audio_file || "")}" aria-label="Lineage" title="Lineage">${iconSvg("lineage")}</button>
            <button type="button" data-action="rack-reveal" data-audio="${escapeHtml(item.audio_file || "")}" aria-label="Reveal in Finder" title="Reveal">${iconSvg("reveal")}</button>
            <a href="${escapeHtml(outputUrl(item.audio_file))}" download="${escapeHtml(stem + ext)}" class="rack-button" style="display: grid; place-items: center; width: 28px; height: 28px; border: 1px solid var(--line); border-radius: 7px; background: var(--panel); color: var(--ink); padding: 0;" title="Download">${iconSvg("download")}</a>
            <button type="button" data-action="rack-copy-path" data-path="${escapeHtml(item.audio_file)}" aria-label="Copy relative path" title="Copy relative path">${iconSvg("copy")}</button>
            <button type="button" data-action="rack-delete" data-metadata="${escapeHtml(item.metadata_file || "")}" data-audio="${escapeHtml(item.audio_file || "")}" aria-label="Delete" title="Delete from disk">${iconSvg("delete")}</button>
          </div>
        </td>
      </tr>
    `);
  });
  body.innerHTML = rows.join("");
}

function rackItemByKey(key) {
  return libraryItems.find((item) => petriItemKey(item) === key) || null;
}

async function rackUpdateItemMetadata(item, edits) {
  if (!item?.audio_file) return null;
  const metadata = item.metadata_file ? await loadMetadata(item.metadata_file).catch(() => ({})) : {};
  const result = await api("/audio-tools/operate", {
    method: "POST",
    body: JSON.stringify({
      input_audio_path: item.audio_file,
      metadata_path: item.metadata_file || metadata.metadata_path || "",
      operation: "metadata",
      prompt: edits.prompt ?? item.prompt ?? metadata.prompt ?? "",
      tags: edits.appendTags
        ? [...new Set([...(item.tags || []), ...edits.appendTags])]
        : (edits.tags ?? item.tags ?? metadata.tags ?? []),
      notes: edits.notes ?? item.notes ?? metadata.notes ?? "",
      ratings: edits.ratings ?? item.ratings ?? metadata.ratings ?? {},
    }),
  });
  return result;
}

async function rackUpdateSelected(edits) {
  const items = [...rackSelectedKeys].map(rackItemByKey).filter(Boolean);
  if (!items.length) return;
  beginWork("Updating Rack", `${items.length} selected`);
  let updated = 0;
  for (const item of items) {
    await rackUpdateItemMetadata(item, edits);
    updated += 1;
  }
  await refreshLibrary(false);
  finishWork("Rack Updated", "ok", `${updated} sound${updated === 1 ? "" : "s"}`);
}

async function renameFile(audioPath, metadataPath, newStem) {
  beginWork("Renaming File", newStem);
  try {
    const result = await api("/files/rename", {
      method: "POST",
      body: JSON.stringify({
        audio_path: audioPath,
        metadata_path: metadataPath || null,
        new_stem: newStem,
      }),
    });
    if (result.status === "ok") {
      await refreshLibrary(false);
      finishWork("Renamed successfully", "ok");
    } else {
      throw new Error(result.detail || "Rename failed");
    }
  } catch (error) {
    finishWork("Rename Error", "bad", error.message);
  }
}

async function deleteSelectedFiles() {
  const items = [...rackSelectedKeys].map(rackItemByKey).filter(Boolean);
  if (!items.length) return;
  if (!confirm(`Permanently delete ${items.length} selected sound file(s) from disk? This cannot be undone.`)) return;
  
  beginWork("Deleting Files", `${items.length} items`);
  try {
    const result = await api("/files/delete", {
      method: "POST",
      body: JSON.stringify({
        items: items.map(item => ({
          audio_path: item.audio_file,
          metadata_path: item.metadata_file || null
        }))
      })
    });
    if (result.status === "ok") {
      rackSelectedKeys.clear();
      await refreshLibrary(false);
      finishWork("Deleted successfully", "ok", `${items.length} items removed`);
    } else {
      throw new Error(result.detail || "Deletion failed");
    }
  } catch (error) {
    finishWork("Delete Error", "bad", error.message);
  }
}

async function deleteSingleFile(audioPath, metadataPath) {
  const filename = audioPath.split("/").pop();
  if (!confirm(`Permanently delete "${filename}" from disk? This cannot be undone.`)) return;
  
  beginWork("Deleting File", filename);
  try {
    const result = await api("/files/delete", {
      method: "POST",
      body: JSON.stringify({
        items: [{
          audio_path: audioPath,
          metadata_path: metadataPath || null
        }]
      })
    });
    if (result.status === "ok") {
      await refreshLibrary(false);
      finishWork("Deleted successfully", "ok");
    } else {
      throw new Error(result.detail || "Deletion failed");
    }
  } catch (error) {
    finishWork("Delete Error", "bad", error.message);
  }
}

function exportSelectedToCsv() {
  const items = [...rackSelectedKeys].map(rackItemByKey).filter(Boolean);
  if (!items.length) {
    alert("Select at least one sound item to export.");
    return;
  }
  
  let csv = "Filename,Prompt,Tags,Mode,Model,Seed,Duration,SampleRate,Size,Notes,CreatedAt\n";
  items.forEach(item => {
    const filename = item.audio_file ? item.audio_file.split("/").pop() : "";
    const prompt = (item.prompt || "").replace(/"/g, '""');
    const tags = (item.tags || []).join(";");
    const mode = item.germinator_mode || item.mode || "archive";
    const model = item.model || "";
    const seed = item.seed !== null ? item.seed : "";
    const duration = item.duration || "";
    const sr = item.sample_rate || "";
    const size = item.file_size || "";
    const notes = (item.notes || "").replace(/"/g, '""');
    const created = item.created_at || "";
    
    csv += `"${filename}","${prompt}","${tags}","${mode}","${model}",${seed},${duration},${sr},${size},"${notes}","${created}"\n`;
  });
  
  const blob = new Blob([csv], { type: "text/csv;charset=utf-8;" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.setAttribute("href", url);
  link.setAttribute("download", `germ_librarian_export_${Date.now()}.csv`);
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
}

function updatePetriPagination(page, totalPages) {
  const pagination = $("petriPagination");
  if (!pagination) return;
  if (totalPages <= 1) {
    pagination.hidden = true;
    return;
  }
  pagination.hidden = false;
  if ($("petriPageReadout")) $("petriPageReadout").textContent = `${page + 1} / ${totalPages}`;
  if ($("petriPrevBtn")) $("petriPrevBtn").disabled = page <= 0;
  if ($("petriNextBtn")) $("petriNextBtn").disabled = page >= totalPages - 1;
}

/* ===================================================================
   Chamber — lineage-aware generative graph
   =================================================================== */

const canvasLegacyStarterPrompt = "granular metallic insect texture, close mic, dry, irregular transient clusters";
const canvasLegacyStarterNegative = "speech, vocals, melody, clipping, harsh artifact";

function canvasId(prefix) {
  return `${prefix}-${crypto.randomUUID().slice(0, 8)}`;
}

function createDefaultTimeState() {
  return {
    ...DEFAULT_TIME_STATE,
    timeSignature: { ...DEFAULT_TIME_STATE.timeSignature },
  };
}

function normalizeTimeState(raw = {}) {
  const defaults = createDefaultTimeState();
  const signature = raw?.timeSignature || {};
  const beatsPerBar = Math.min(16, Math.max(1, Math.round(Number(signature.beatsPerBar ?? raw?.beats_per_bar ?? defaults.timeSignature.beatsPerBar))));
  const beatUnit = [1, 2, 4, 8, 16, 32].includes(Number(signature.beatUnit ?? raw?.beat_unit))
    ? Number(signature.beatUnit ?? raw?.beat_unit)
    : defaults.timeSignature.beatUnit;
  const bpm = Math.min(300, Math.max(20, Number(raw?.bpm) || defaults.bpm));
  const bars = Math.min(128, Math.max(1, Math.round(Number(raw?.bars) || defaults.bars)));
  const ppq = Math.min(3840, Math.max(24, Math.round(Number(raw?.ppq) || defaults.ppq)));
  const sampleRate = Math.round(Number(raw?.sampleRate ?? raw?.sample_rate) || defaults.sampleRate);
  const snapDivision = ["1/4", "1/8", "1/16", "1/32", "triplet"].includes(raw?.snapDivision ?? raw?.snap_division)
    ? (raw.snapDivision ?? raw.snap_division)
    : defaults.snapDivision;
  return {
    ...defaults,
    enabled: Boolean(raw?.enabled),
    bpm,
    timeSignature: { beatsPerBar, beatUnit },
    bars,
    ppq,
    sampleRate,
    snapDivision,
    swing: Math.min(1, Math.max(0, Number(raw?.swing) || 0)),
    loopStartTick: Math.max(0, Math.round(Number(raw?.loopStartTick ?? raw?.loop_start_tick) || 0)),
    loopEndTick: raw?.loopEndTick ?? raw?.loop_end_tick ?? null,
  };
}

function timeClockDerived(clock = timeState) {
  const normalized = normalizeTimeState(clock);
  const secondsPerBeat = 60 / normalized.bpm;
  const totalBeats = normalized.bars * normalized.timeSignature.beatsPerBar;
  const loopSeconds = totalBeats * secondsPerBeat;
  const ticksPerBar = normalized.timeSignature.beatsPerBar * normalized.ppq;
  const totalTicks = normalized.bars * ticksPerBar;
  return {
    secondsPerBeat,
    totalBeats,
    loopSeconds,
    loopSamples: Math.round(loopSeconds * normalized.sampleRate),
    ticksPerBar,
    totalTicks,
    loopStartTick: normalized.loopStartTick,
    loopEndTick: normalized.loopEndTick || totalTicks,
  };
}

function timeStateApiClock() {
  return {
    enabled: Boolean(timeState.enabled),
    bpm: Number(timeState.bpm),
    beats_per_bar: Number(timeState.timeSignature.beatsPerBar),
    beat_unit: Number(timeState.timeSignature.beatUnit),
    bars: Number(timeState.bars),
    ppq: Number(timeState.ppq),
    sample_rate: Number(timeState.sampleRate),
    snap_division: timeState.snapDivision,
    swing: Number(timeState.swing) || 0,
    loop_start_tick: Number(timeState.loopStartTick) || 0,
    loop_end_tick: timeState.loopEndTick || null,
  };
}

function timeSignatureLabel(clock = timeState) {
  const normalized = normalizeTimeState(clock);
  return `${normalized.timeSignature.beatsPerBar}/${normalized.timeSignature.beatUnit}`;
}

function canvasTimeNodes() {
  return canvasNodes.filter((node) => node.type === "time");
}

function setTimeMode(enabled, detail = "") {
  timeState = normalizeTimeState({ ...timeState, enabled });
  if (!enabled) stopAllTimePadRecordings();
  updateTimeTransportUi();
  canvasSaveState();
  setState(enabled ? "Clock On" : "Clock Off", "muted", detail || (enabled ? "Time Mode enabled." : "Clocked preview stopped; time modules remain on the canvas."));
}

function enableTimeMode(detail = "Time module added.") {
  if (!timeState.enabled) setTimeMode(true, detail);
  else {
    timeState = normalizeTimeState(timeState);
    updateTimeTransportUi();
    canvasSaveState();
  }
}

function selectedTimeNode() {
  const node = canvasSelectedNode();
  return node?.type === "time" ? node : null;
}

function updateTimeTransportUi() {
  const toggle = $("timeModeToggle");
  const controls = $("timeTransportControls");
  const enabled = Boolean(timeState.enabled);
  if (toggle) {
    toggle.classList.toggle("active", enabled);
    toggle.title = enabled ? "Clock on" : "Clock off";
    toggle.setAttribute("aria-label", enabled ? "Turn Time Mode off" : "Turn Time Mode on");
  }
  if (controls) controls.hidden = !enabled;
  const values = {
    timeBpm: Math.round(Number(timeState.bpm) || 120),
    timeBars: Math.round(Number(timeState.bars) || 4),
    timeSignature: timeSignatureLabel(timeState),
    timeSnapDivision: timeState.snapDivision || "1/16",
  };
  Object.entries(values).forEach(([id, value]) => {
    const field = $(id);
    if (field && document.activeElement !== field) field.value = String(value);
  });
  const renderBtn = $("timeRenderSelectedBtn");
  if (renderBtn) {
    const node = selectedTimeNode();
    const status = timeNodeRenderStatus(node);
    renderBtn.disabled = !enabled || !status.canRender;
    renderBtn.textContent = node?.timeType === "trigger_pads" ? "Render Pads" : "Harvest";
    renderBtn.title = status.reason || "Render selected time module to a new source";
  }
}

function updateTimeStateFromTransport() {
  const [beatsPerBar, beatUnit] = String($("timeSignature")?.value || "4/4").split("/").map((part) => Number(part));
  timeState = normalizeTimeState({
    ...timeState,
    bpm: Number($("timeBpm")?.value) || timeState.bpm,
    bars: Number($("timeBars")?.value) || timeState.bars,
    timeSignature: {
      beatsPerBar: beatsPerBar || timeState.timeSignature.beatsPerBar,
      beatUnit: beatUnit || timeState.timeSignature.beatUnit,
    },
    snapDivision: $("timeSnapDivision")?.value || timeState.snapDivision,
  });
  updateTimeTransportUi();
  canvasSaveState();
}

function modulatorLabel(modulatorType) {
  return {
    mod_matrix: "Mod Matrix",
    prompt_morph: "Prompt Morph",
    prompt_modulator: "Prompt Modulator",
    mutation_modulator: "Mutation Modulator",
    lfo_modulator: "LFO",
    random_modulator: "Random",
    random_walk_modulator: "Random Walk",
    brownian_modulator: "Brownian",
    step_sequencer_modulator: "Step Sequencer",
    noise_modulator: "Noise",
    sample_hold_modulator: "Sample & Hold",
    probability_modulator: "Probability",
    envelope_modulator: "Envelope",
    envelope_follower: "Envelope Follower",
    transient_detector: "Transient Detector",
    spectral_follower: "Spectral Follower",
    semantic_follower: "Semantic Follower",
    region_envelope: "Region Envelope",
    audio_to_control: "Audio-to-Control",
    gesture_recorder: "Gesture Recorder",
    macro_modulator: "Macro",
  }[modulatorType] || "Modulator";
}

function normalizeModulatorType(modulatorType) {
  return MODULATOR_TYPES.has(modulatorType) ? modulatorType : "prompt_modulator";
}

function canvasModulatorNodes() {
  return canvasNodes.filter((node) => node.type === "modulator");
}

function objectPathParts(path = "") {
  return String(path || "").split(".").filter(Boolean).map((part) => (/^\d+$/.test(part) ? Number(part) : part));
}

function objectGetPath(target, path = "") {
  return objectPathParts(path).reduce((value, part) => (value == null ? undefined : value[part]), target);
}

function objectSetPath(target, path = "", value = "") {
  const parts = objectPathParts(path);
  if (!target || !parts.length) return false;
  let cursor = target;
  for (let index = 0; index < parts.length - 1; index++) {
    cursor = cursor?.[parts[index]];
    if (cursor == null) return false;
  }
  cursor[parts[parts.length - 1]] = value;
  return true;
}

function timePromptPathForKind(kind, index = 0) {
  if (kind === "pad") return `pads.${index}.prompt`;
  if (kind === "melody_root") return "root.prompt";
  if (kind?.startsWith?.("polymeter_lane_")) return `lanes.${Number(index) || Number(kind.split("_").pop()) || 0}.prompt`;
  if (kind === "lane") return `lanes.${index}.prompt`;
  return "source.prompt";
}

function timeDurationPathForKind(kind, index = 0) {
  return timePromptPathForKind(kind, index).replace(/\.prompt$/, ".shotDurationSec");
}

function modulationTargetValue(node, path) {
  return objectGetPath(node, path);
}

function modulationSetTargetValue(node, path, value) {
  return objectSetPath(node, path, value);
}

function modulationPromptTarget(node, path, label, extra = {}) {
  return {
    id: `${node.id}:${path}`,
    nodeId: node.id,
    nodeLabel: node.label || node.type,
    path,
    label,
    type: "prompt",
    param: "prompt",
    modulationRate: "generation",
    defaultValue: modulationTargetValue(node, path) || "",
    ...extra,
  };
}

function modulationNumberTarget(node, path, label, param, min, max, extra = {}) {
  const current = Number(modulationTargetValue(node, path));
  return {
    id: `${node.id}:${path}`,
    nodeId: node.id,
    nodeLabel: node.label || node.type,
    path,
    label,
    type: "number",
    param,
    min,
    max,
    defaultValue: Number.isFinite(current) ? current : Number(extra.defaultValue ?? min ?? 0),
    modulationRate: extra.modulationRate || "generation",
    ...extra,
  };
}

function modulationGenerationTarget(node, key, labelPrefix = "") {
  const destination = GENERATION_DESTINATIONS[key];
  if (!destination) return null;
  const labelBase = labelPrefix || node.label || (node.type === "sound" ? "Sound" : "Prompt");
  return modulationNumberTarget(node, destination.path, `${labelBase} / ${destination.label}`, key, destination.min, destination.max, {
    defaultValue: destination.defaultValue,
    modulationRate: "generation",
    targetScope: "generation",
    generationDestination: key,
  });
}

function modulationPromptStackWeightTarget(node, layerKey, labelPrefix = "") {
  const layer = PROMPT_STACK_LAYERS.find((item) => item.key === layerKey);
  if (!layer) return null;
  const labelBase = labelPrefix || node.label || "Prompt";
  return modulationNumberTarget(node, `promptStackWeights.${layerKey}`, `${labelBase} / ${layer.label} layer weight`, `promptStack.${layerKey}`, 0, 2, {
    defaultValue: 1,
    modulationRate: "generation",
    targetScope: "prompt_stack",
    promptStackLayer: layerKey,
  });
}

function modulationTimeEventTargets(node, label) {
  return [
    modulationNumberTarget(node, "events.velocity", `${label} / event velocity`, "eventVelocity", 0, 2, { modulationRate: "clocked", defaultValue: 1, targetScope: "time_events" }),
    modulationNumberTarget(node, "events.gain", `${label} / event gain`, "eventGain", 0, 2, { modulationRate: "clocked", defaultValue: 1, targetScope: "time_events" }),
    modulationNumberTarget(node, "events.pan", `${label} / event pan`, "eventPan", -1, 1, { modulationRate: "clocked", defaultValue: 0, targetScope: "time_events" }),
    modulationNumberTarget(node, "events.probability", `${label} / event probability`, "eventProbability", 0, 1, { modulationRate: "clocked", defaultValue: 1, targetScope: "time_events" }),
    modulationNumberTarget(node, "events.microtiming", `${label} / event microtiming`, "eventMicrotiming", -240, 240, { modulationRate: "clocked", defaultValue: 0, targetScope: "time_events", unit: "ticks" }),
  ];
}

function modulationFxTargetsForNode(node) {
  const fx = FX_MODULES[node.fxType] || FX_MODULES.gain;
  const label = node.label || fx.label || "FX";
  const target = (path, suffix, param, min, max, defaultValue = min) =>
    modulationNumberTarget(node, path, `${label} / ${suffix}`, param, min, max, {
      modulationRate: "realtime",
      defaultValue,
      targetScope: "fx_params",
    });
  const semanticTarget = modulationNumberTarget(node, "semantic.amount", `${label} / semantic amount`, "semanticAmount", 0, 1, {
    modulationRate: "generation",
    defaultValue: canvasNormalizeFxSemantic(node).amount,
    targetScope: "semantic_bridge",
  });
  const params = node.params || canvasDefaultFxParams(node.fxType);
  if (node.fxType === "gain") return [target("params.amount", "amount", "fxAmount", 0, 2, params.amount ?? 1), semanticTarget];
  if (node.fxType === "pan") return [target("params.pan", "pan", "fxPan", -1, 1, params.pan ?? 0), semanticTarget];
  if (node.fxType === "pitch") return [target("params.semitones", "semitones", "fxSemitones", -24, 24, params.semitones ?? 0), semanticTarget];
  if (node.fxType === "space") return [target("params.mix", "mix", "fxMix", 0, 1, params.mix ?? 0.28), semanticTarget];
  if (node.fxType === "echo") {
    return [
      target("params.time", "time", "fxTime", 0.04, 1.2, params.time ?? 0.28),
      target("params.feedback", "feedback", "fxFeedback", 0, 0.85, params.feedback ?? 0.32),
      target("params.mix", "mix", "fxMix", 0, 1, params.mix ?? 0.25),
      semanticTarget,
    ];
  }
  if (node.fxType === "granular") {
    return [
      target("params.density", "density", "fxDensity", 0, 1, params.density ?? 0.58),
      target("params.jitter", "jitter", "fxJitter", 0, 1, params.jitter ?? 0.35),
      target("params.mix", "mix", "fxMix", 0, 1, params.mix ?? 0.32),
      semanticTarget,
    ];
  }
  if (MICRO_FX_TYPES.has(node.fxType)) {
    const entries = Object.entries(params)
      .filter(([, value]) => typeof value === "number")
      .slice(0, 4)
      .map(([param, value]) => {
        const meta = MICRO_FX_CONTROL_META[param] || { label: param, min: 0, max: 1, step: 0.01 };
        return target(`params.${param}`, meta.label.toLowerCase(), `micro${param}`, meta.min ?? 0, meta.max ?? 1, value);
      });
    return [...entries, semanticTarget];
  }
  if (node.fxType === "loop_doctor") {
    return [
      target("params.crossfadeSec", "crossfade", "fxCrossfade", 0.01, 0.5, params.crossfadeSec ?? 0.12),
      target("params.variationStrength", "variation", "fxVariation", 0, 1, params.variationStrength ?? 0.28),
      semanticTarget,
    ];
  }
  if (node.fxType === "saturation") return [target("params.drive", "drive", "fxDrive", 0, 1, params.drive ?? 0.28), semanticTarget];
  if (node.fxType === "gate") {
    return [
      target("params.threshold", "threshold", "fxThreshold", 0, 1, params.threshold ?? 0.18),
      target("params.release", "release", "fxRelease", 0.02, 1, params.release ?? 0.22),
      semanticTarget,
    ];
  }
  return [semanticTarget];
}

function modulationTargetsForNode(node) {
  if (!node || node.type === "modulator") return [];
  if (node.type === "germ") {
    const germ = normalizeGermNode(node);
    const label = germ.label || "Germ";
    return [
      modulationPromptTarget(germ, "prompt", `${label} / prompt`),
      { ...modulationPromptTarget(germ, "negativePrompt", `${label} / avoid`), type: "negative", param: "negativePrompt" },
      modulationNumberTarget(germ, "tablePosition", `${label} / table position`, "tablePosition", 0, 1, { modulationRate: "realtime", defaultValue: germ.tablePosition }),
      modulationNumberTarget(germ, "scanSpeed", `${label} / scan speed`, "scanSpeed", -1, 1, { modulationRate: "realtime", defaultValue: germ.scanSpeed }),
      modulationNumberTarget(germ, "pitch", `${label} / pitch`, "pitch", -24, 24, { modulationRate: "realtime", defaultValue: germ.pitch }),
      modulationNumberTarget(germ, "fineTune", `${label} / fine tune`, "fineTune", -100, 100, { modulationRate: "realtime", defaultValue: germ.fineTune }),
      modulationNumberTarget(germ, "unisonDetune", `${label} / unison detune`, "unisonDetune", 0, 48, { modulationRate: "realtime", defaultValue: germ.unisonDetune }),
      modulationNumberTarget(germ, "ampAttack", `${label} / amp attack`, "ampAttack", 0.001, 5, { modulationRate: "realtime", defaultValue: germ.ampAttack }),
      modulationNumberTarget(germ, "ampDecay", `${label} / amp decay`, "ampDecay", 0.001, 5, { modulationRate: "realtime", defaultValue: germ.ampDecay }),
      modulationNumberTarget(germ, "ampSustain", `${label} / amp sustain`, "ampSustain", 0, 1, { modulationRate: "realtime", defaultValue: germ.ampSustain }),
      modulationNumberTarget(germ, "ampRelease", `${label} / amp release`, "ampRelease", 0.001, 8, { modulationRate: "realtime", defaultValue: germ.ampRelease }),
      modulationNumberTarget(germ, "filterCutoff", `${label} / filter cutoff`, "filterCutoff", 20, 20000, { modulationRate: "realtime", defaultValue: germ.filterCutoff }),
      modulationNumberTarget(germ, "filterResonance", `${label} / filter resonance`, "filterResonance", 0.1, 20, { modulationRate: "realtime", defaultValue: germ.filterResonance }),
      modulationNumberTarget(germ, "filterEnvAmount", `${label} / filter env`, "filterEnvAmount", -1, 1, { modulationRate: "realtime", defaultValue: germ.filterEnvAmount }),
      modulationNumberTarget(germ, "wavetableIndex", `${label} / table index`, "wavetableIndex", 0, 512, { modulationRate: "realtime", defaultValue: germ.wavetableIndex }),
      modulationNumberTarget(germ, "durationSec", `${label} / duration`, "durationSec", 1, 8, { modulationRate: "generation", defaultValue: germ.durationSec }),
      modulationNumberTarget(germ, "mutationDepth", `${label} / mutation depth`, "mutationDepth", 0, 1, { modulationRate: "generation", defaultValue: germ.mutationDepth }),
      modulationNumberTarget(germ, "frameCount", `${label} / frame count`, "frameCount", 1, 512, { modulationRate: "generation", defaultValue: germ.frameCount }),
      modulationNumberTarget(germ, "frameSize", `${label} / frame size`, "frameSize", 512, 4096, { modulationRate: "generation", defaultValue: germ.frameSize }),
      modulationNumberTarget(germ, "variationCount", `${label} / variations`, "variationCount", 1, 16, { modulationRate: "generation", defaultValue: germ.variationCount }),
    ].filter(Boolean);
  }
  if (node.type === "sound") {
    const label = node.label || "Sound";
    return [
      modulationNumberTarget(node, "volume", `${label} / playback gain`, "volume", 0, 2, { modulationRate: "realtime", defaultValue: Number(node.volume ?? 1) }),
      modulationNumberTarget(node, "pan", `${label} / playback pan`, "pan", -1, 1, { modulationRate: "realtime", defaultValue: Number(node.pan ?? 0) }),
      modulationNumberTarget(node, "playbackRate", `${label} / playback speed`, "playbackRate", 0.25, 4, { modulationRate: "realtime", defaultValue: Number(node.playbackRate ?? 1) }),
      modulationGenerationTarget(node, "promptWeight", label),
      modulationGenerationTarget(node, "negativePromptWeight", label),
      modulationGenerationTarget(node, "mutation", label),
      modulationGenerationTarget(node, "inpaintDensity", label),
      modulationGenerationTarget(node, "continuationDivergence", label),
      modulationGenerationTarget(node, "seedDrift", label),
      modulationGenerationTarget(node, "durationSec", label),
      modulationGenerationTarget(node, "cfgScale", label),
      modulationGenerationTarget(node, "batchSpread", label),
      modulationGenerationTarget(node, "maskFeather", label),
      modulationGenerationTarget(node, "loraStrength", label),
      modulationGenerationTarget(node, "brightnessLanguage", label),
    ].filter(Boolean);
  }
  if (node.type === "prompt") {
    const label = node.label || "Prompt";
    return [
      modulationPromptTarget(node, "prompt", `${label} / prompt`),
      { ...modulationPromptTarget(node, "negativePrompt", `${label} / avoid`), type: "negative", param: "negativePrompt" },
      modulationNumberTarget(node, "durationSec", `${label} / length`, "durationSec", 0.5, 60),
      modulationNumberTarget(node, "seed", `${label} / seed`, "seed", -1, 999999),
      modulationNumberTarget(node, "mutation", `${label} / mutation`, "mutation", 0, 1),
      modulationNumberTarget(node, "batchSize", `${label} / batch`, "batchSize", 1, 8),
      modulationNumberTarget(node, "colonyCandidates", `${label} / colony count`, "colonyCandidates", 1, 16),
      modulationGenerationTarget(node, "promptWeight", label),
      modulationGenerationTarget(node, "negativePromptWeight", label),
      modulationGenerationTarget(node, "seedDrift", label),
      modulationGenerationTarget(node, "cfgScale", label),
      modulationGenerationTarget(node, "batchSpread", label),
      modulationGenerationTarget(node, "modelRouteIndex", label),
      modulationGenerationTarget(node, "loraStrength", label),
      modulationGenerationTarget(node, "brightnessLanguage", label),
      ...PROMPT_STACK_LAYERS.map((layer) => modulationPromptStackWeightTarget(node, layer.key, label)),
    ].filter(Boolean);
  }
  if (node.type === "fx") return modulationFxTargetsForNode(node);
  if (node.type !== "time") return [];
  const label = node.label || timeModuleLabel(node.timeType);
  const eventTargets = modulationTimeEventTargets(node, label);
  if (node.timeType === "trigger_pads") {
    return [
      ...(node.pads || []).flatMap((pad, index) => [
      modulationPromptTarget(node, `pads.${index}.prompt`, `${label} / pad ${index + 1} prompt`, { slotKind: "pad", slotIndex: index }),
      modulationNumberTarget(node, `pads.${index}.shotDurationSec`, `${label} / pad ${index + 1} duration`, "durationSec", 0.2, 2, { slotKind: "pad", slotIndex: index }),
      ]),
      ...eventTargets,
    ];
  }
  if (node.timeType === "melody_maker") {
    return [
      modulationPromptTarget(node, "root.prompt", `${label} / root prompt`, { slotKind: "melody_root", slotIndex: 0 }),
      modulationNumberTarget(node, "root.shotDurationSec", `${label} / root duration`, "durationSec", 0.3, 3, { slotKind: "melody_root", slotIndex: 0 }),
      ...eventTargets,
    ];
  }
  if (node.timeType === "polymeter") {
    return [
      ...(node.lanes || []).flatMap((lane, index) => [
      modulationPromptTarget(node, `lanes.${index}.prompt`, `${label} / lane ${index + 1} prompt`, { slotKind: `polymeter_lane_${index}`, slotIndex: index }),
      modulationNumberTarget(node, `lanes.${index}.shotDurationSec`, `${label} / lane ${index + 1} duration`, "durationSec", 0.2, 2, { slotKind: `polymeter_lane_${index}`, slotIndex: index }),
      ]),
      ...eventTargets,
    ];
  }
  if (["euclidean_colony", "probability_gate", "clock_divider", "humanizer"].includes(node.timeType)) {
    return [
      modulationPromptTarget(node, "source.prompt", `${label} / source prompt`, { slotKind: `${node.timeType.replace(/^(euclidean_colony)$/, "euclidean")}_source`, slotIndex: 0 }),
      modulationNumberTarget(node, "source.shotDurationSec", `${label} / source duration`, "durationSec", 0.2, 2, { slotIndex: 0 }),
      ...eventTargets,
    ];
  }
  if (node.timeType === "colony_sequencer") {
    return [
      ...(node.lanes || []).flatMap((lane, index) => [
      modulationPromptTarget(node, `lanes.${index}.prompt`, `${label} / lane ${index + 1} prompt`, { slotKind: "lane", slotIndex: index }),
      modulationNumberTarget(node, `lanes.${index}.shotDurationSec`, `${label} / lane ${index + 1} duration`, "durationSec", 0.2, 2, { slotKind: "lane", slotIndex: index }),
      ]),
      ...eventTargets,
    ];
  }
  return eventTargets;
}

function modulationTargets() {
  return canvasNodes.flatMap(modulationTargetsForNode);
}

function modulationTargetForRoute(route = {}) {
  return modulationTargets().find((target) => target.nodeId === route.targetNodeId && target.path === route.targetPath) || null;
}

function modulatorAcceptsTarget(modulatorType, target) {
  if (!target) return false;
  if (PROMPT_MODULATOR_TYPES.has(modulatorType)) return ["prompt", "negative"].includes(target.type);
  if (modulatorType === "mutation_modulator") return target.type === "number" && target.modulationRate === "generation";
  if (modulatorType === "random_modulator") return target.type === "number" && ["generation", "clocked", "realtime"].includes(target.modulationRate);
  if (modulatorType === "probability_modulator") return target.type === "number" && ["eventProbability", "eventVelocity", "batchSize", "colonyCandidates", "batchSpread", "inpaintDensity"].includes(target.param);
  if (["lfo_modulator", "noise_modulator", "envelope_modulator", "random_walk_modulator", "brownian_modulator", "step_sequencer_modulator", "envelope_follower", "spectral_follower", "semantic_follower", "region_envelope", "audio_to_control", "gesture_recorder"].includes(modulatorType)) {
    return target.type === "number" && ["generation", "realtime", "clocked"].includes(target.modulationRate);
  }
  if (["sample_hold_modulator", "macro_modulator", "transient_detector"].includes(modulatorType)) return target.type === "number";
  return target.type === "number";
}

function modulationDefaultRangeFor(modulatorType, target = {}) {
  const base = Number.isFinite(Number(target.defaultValue)) ? Number(target.defaultValue) : Number(target.min ?? 0);
  if (target.param === "semanticAmount") return { min: 0, max: 1 };
  if (modulatorType === "mutation_modulator") return { min: target.min ?? 0, max: target.max ?? 1 };
  if (target.param === "volume") return { min: Math.max(0, Number((base * 0.6).toFixed(3))), max: Math.min(2, Number((Math.max(0.2, base) * 1.25).toFixed(3))) };
  if (target.param === "pan") return { min: Math.max(-1, base - 0.45), max: Math.min(1, base + 0.45) };
  if (target.param === "playbackRate") return { min: Math.max(0.25, base * 0.85), max: Math.min(4, base * 1.15) };
  if (target.param === "eventVelocity" || target.param === "eventGain") return { min: 0.55, max: 1.15 };
  if (target.param === "eventPan") return { min: -0.5, max: 0.5 };
  if (target.param === "eventProbability") return { min: 0.6, max: 1 };
  if (target.param === "eventMicrotiming") return { min: -80, max: 80 };
  if (target.param === "durationSec") return { min: Math.max(0.1, base * 0.75), max: Math.max(0.2, base * 1.25) };
  if (target.param === "promptWeight" || target.param === "negativePromptWeight" || target.param === "loraStrength") return { min: 0.25, max: 1.5 };
  if (target.param === "seedDrift" || target.param === "batchSpread" || target.param === "inpaintDensity" || target.param === "maskFeather") return { min: 0, max: 1 };
  if (target.param === "continuationDivergence") return { min: 0.2, max: 1.2 };
  if (target.param === "cfgScale") return { min: Math.max(0, base * 0.7), max: Math.min(20, Math.max(1, base) * 1.5) };
  if (target.param === "brightnessLanguage") return { min: -0.85, max: 0.85 };
  if (String(target.param || "").startsWith("promptStack.")) return { min: 0, max: 1.5 };
  return { min: target.min ?? 0, max: target.max ?? 1 };
}

function modulationTargetOptions(modulatorType, selectedRoute = {}) {
  const targets = modulationTargets().filter((target) => modulatorAcceptsTarget(modulatorType, target));
  if (!targets.length) return `<option value="">No targets</option>`;
  return targets.map((target) => {
    const value = `${target.nodeId}|${target.path}`;
    const selected = target.nodeId === selectedRoute.targetNodeId && target.path === selectedRoute.targetPath ? " selected" : "";
    return `<option value="${escapeHtml(value)}"${selected}>${escapeHtml(target.label)}</option>`;
  }).join("");
}

function modulationDefaultRoute(modulatorType = "prompt_modulator", preferredNodeId = selectedCanvasNodeId) {
  const wantsPrompt = PROMPT_MODULATOR_TYPES.has(modulatorType);
  const targets = modulationTargets().filter((target) => modulatorAcceptsTarget(modulatorType, target));
  const target = targets.find((item) => item.nodeId === preferredNodeId) || targets[0] || null;
  const range = modulationDefaultRangeFor(modulatorType, target || {});
  return {
    id: canvasId("route"),
    targetNodeId: target?.nodeId || "",
    targetPath: target?.path || "",
    mode: wantsPrompt ? "append" : "replace",
    enabled: true,
    config: wantsPrompt
      ? { outputMode: "append" }
      : { distribution: "uniform", min: range.min, max: range.max, steppedValues: "", seed: 1 },
  };
}

function modulationDefaultMatrixRoute(preferredNodeId = selectedCanvasNodeId) {
  const targets = modulationTargets()
    .filter((target) => target.type === "number" && target.modulationRate === "generation" && target.targetScope !== "semantic_bridge");
  const target = targets.find((item) => item.nodeId === preferredNodeId) || targets[0] || null;
  return {
    id: canvasId("matrix"),
    sourceType: "lfo_modulator",
    targetNodeId: target?.nodeId || "",
    targetPath: target?.path || "",
    amount: 0.35,
    curve: "linear",
    enabled: true,
    config: { min: target?.min ?? 0, max: target?.max ?? 1, seed: 1 },
  };
}

function normalizeModulatorNode(node) {
  if (!node || node.type !== "modulator") return node;
  const modulatorType = normalizeModulatorType(node.modulatorType);
  const configDefaults = {
    mod_matrix: {
      matrixRoutes: [modulationDefaultMatrixRoute()],
    },
    prompt_morph: {
      stateA: "dry wooden percussion",
      stateB: "metallic underwater machine rhythm",
      stateC: "soft tape-warped ambient choir",
      morph: 0.5,
      seed: 1,
    },
    prompt_modulator: {
      promptMode: "adjectives_materials",
      intensity: 25,
      conservation: 80,
      contamination: 10,
      seed: 1,
    },
    mutation_modulator: {
      distribution: "uniform",
      min: 0,
      max: 1,
      steppedValues: "",
      seed: 1,
    },
    lfo_modulator: {
      shape: "sine",
      rateHz: 0.25,
      sync: false,
      division: "1/4",
      phase: 0,
      seed: 1,
    },
    random_modulator: {
      distribution: "uniform",
      refresh: "every_trigger",
      steppedValues: "",
      seed: 1,
    },
    random_walk_modulator: {
      rateHz: 0.2,
      drift: 0.22,
      seed: 1,
    },
    brownian_modulator: {
      rateHz: 0.08,
      drift: 0.12,
      seed: 1,
    },
    step_sequencer_modulator: {
      steps: "0, 0.25, 0.75, 1",
      division: "1/8",
      seed: 1,
    },
    noise_modulator: {
      rateHz: 0.7,
      smooth: 0.35,
      seed: 1,
    },
    sample_hold_modulator: {
      division: "1/8",
      seed: 1,
    },
    probability_modulator: {
      chance: 75,
      seed: 1,
    },
    envelope_modulator: {
      attack: 0.08,
      decay: 0.2,
      sustain: 0.65,
      release: 0.28,
      cycleSeconds: 2,
    },
    envelope_follower: {
      sensitivity: 0.6,
      smooth: 0.35,
      seed: 1,
    },
    transient_detector: {
      sensitivity: 0.75,
      seed: 1,
    },
    spectral_follower: {
      band: "centroid",
      sensitivity: 0.65,
      seed: 1,
    },
    semantic_follower: {
      source: "tags",
      sensitivity: 0.7,
      seed: 1,
    },
    region_envelope: {
      sensitivity: 0.6,
      seed: 1,
    },
    audio_to_control: {
      feature: "spectral",
      sensitivity: 0.65,
      smooth: 0.35,
      seed: 1,
    },
    gesture_recorder: {
      gestureValue: 0.5,
      durationSec: 4,
      loop: true,
      recording: false,
      points: [
        { t: 0, value: 0.2 },
        { t: 0.5, value: 0.8 },
        { t: 1, value: 0.45 },
      ],
    },
    macro_modulator: {
      amount: 50,
    },
  };
  const defaults = configDefaults[modulatorType] || configDefaults.macro_modulator;
  const routes = modulatorType === "mod_matrix"
    ? []
    : Array.isArray(node.routes) && node.routes.length
    ? node.routes
    : [modulationDefaultRoute(modulatorType)];
  const matrixRoutes = Array.isArray(node.config?.matrixRoutes) && node.config.matrixRoutes.length
    ? node.config.matrixRoutes
    : defaults.matrixRoutes || [];
  const gesturePoints = Array.isArray(node.config?.points) && node.config.points.length
    ? node.config.points
    : defaults.points || [];
  return {
    ...node,
    modulatorType,
    label: node.label || modulatorLabel(modulatorType),
    config: {
      ...defaults,
      ...(node.config || {}),
      ...(modulatorType === "mod_matrix" ? {
        matrixRoutes: matrixRoutes.map((route) => ({
          id: route.id || canvasId("matrix"),
          sourceType: route.sourceType || "lfo_modulator",
          targetNodeId: route.targetNodeId || "",
          targetPath: route.targetPath || "",
          amount: Math.min(1, Math.max(0, Number(route.amount ?? 0.35))),
          curve: route.curve || "linear",
          enabled: route.enabled !== false,
          config: { seed: 1, ...(route.config || {}) },
        })),
      } : {}),
      ...(modulatorType === "gesture_recorder" ? {
        points: gesturePoints
          .map((point) => ({
            t: Math.min(1, Math.max(0, Number(point.t ?? 0))),
            value: Math.min(1, Math.max(0, Number(point.value ?? 0.5))),
          }))
          .sort((a, b) => a.t - b.t),
      } : {}),
    },
    routes: routes.map((route) => ({
      id: route.id || canvasId("route"),
      targetNodeId: route.targetNodeId || "",
      targetPath: route.targetPath || "",
      mode: route.mode || (PROMPT_MODULATOR_TYPES.has(modulatorType) ? "append" : "replace"),
      enabled: route.enabled !== false,
      config: { ...(PROMPT_MODULATOR_TYPES.has(modulatorType) ? { outputMode: route.mode || "append" } : { distribution: "uniform", min: 0, max: 1, steppedValues: "", seed: 1 }), ...(route.config || {}) },
    })),
  };
}

function modulationIntensityCount(intensity = 25) {
  const value = Number(intensity) || 25;
  if (value >= 75) return 3;
  if (value >= 45) return 2;
  return 1;
}

function modulationPick(list = [], count = 1, seed = "") {
  const values = [...new Set((list || []).filter(Boolean))];
  if (!values.length) return [];
  const picks = [];
  let cursor = 0;
  while (picks.length < Math.min(count, values.length) && cursor < values.length * 3) {
    const index = Math.floor(deterministicUnit(`${seed}:${cursor}`) * values.length) % values.length;
    const value = values[index];
    if (!picks.includes(value)) picks.push(value);
    cursor += 1;
  }
  return picks;
}

function modulationTextCorpus() {
  const texts = [];
  canvasNodes.forEach((node) => {
    if (node?.prompt) texts.push(node.prompt);
    if (node?.negativePrompt) texts.push(node.negativePrompt);
    if (node?.label) texts.push(node.label);
    if (node?.type === "time") {
      modulationTargetsForNode(node).forEach((target) => {
        if (["prompt", "negative"].includes(target.type)) {
          const value = modulationTargetValue(node, target.path);
          if (value) texts.push(String(value));
        }
      });
    }
  });
  canvasAssets.forEach((asset) => {
    const metadata = asset?.metadata || {};
    [metadata.prompt, metadata.negative_prompt, metadata.notes, metadata.operation].forEach((value) => {
      if (value) texts.push(String(value));
    });
    (metadata.tags || []).forEach((tag) => texts.push(String(tag)));
  });
  libraryItems.forEach((item) => {
    [item.prompt, item.negative_prompt, item.notes, item.operation].forEach((value) => {
      if (value) texts.push(String(value));
    });
    (item.tags || []).forEach((tag) => texts.push(String(tag)));
  });
  return texts.join(" ").toLowerCase();
}

function modulationFamilyGenome() {
  const corpus = modulationTextCorpus();
  const genome = {};
  Object.entries(MODULATOR_WORD_BANKS).forEach(([category, terms]) => {
    genome[category] = terms.filter((term) => corpus.includes(term.toLowerCase()));
  });
  return genome;
}

function modulationBank(category, node) {
  const genome = node?.config?.promptMode === "genetic" ? modulationFamilyGenome() : {};
  const conservation = Math.min(100, Math.max(0, Number(node?.config?.conservation ?? 80)));
  const contamination = Math.min(100, Math.max(0, Number(node?.config?.contamination ?? 10)));
  const family = genome[category] || [];
  const global = MODULATOR_WORD_BANKS[category] || [];
  if (!family.length) return global;
  const familyWeight = Math.max(1, Math.round(conservation / 20));
  const contaminationWeight = Math.max(0, Math.round(contamination / 25));
  return [
    ...Array.from({ length: familyWeight }).flatMap(() => family),
    ...Array.from({ length: contaminationWeight }).flatMap(() => global),
  ];
}

function modulationPromptFragment(node, route, baseText = "") {
  if (node?.modulatorType === "prompt_morph") return modulationPromptMorphFragment(node, route, baseText);
  const mode = node?.config?.promptMode || "adjectives_materials";
  const count = modulationIntensityCount(node?.config?.intensity);
  const seed = `${node?.id}:${route?.id}:${node?.config?.seed}:${baseText}:${mode}`;
  const adjectives = modulationPick(modulationBank("adjectives", node), count, `${seed}:adjectives`);
  const materials = modulationPick(modulationBank("materials", node), count, `${seed}:materials`);
  const nouns = modulationPick(modulationBank("nouns", node), Math.max(1, count - 1), `${seed}:nouns`);
  const actions = modulationPick(modulationBank("actions", node), count, `${seed}:actions`);
  const spaces = modulationPick(modulationBank("spaces", node), 1, `${seed}:spaces`);
  const decay = modulationPick(MODULATOR_WORD_BANKS.decay, 1, `${seed}:decay`);
  if (mode === "negative") return modulationPick(modulationBank("negative", node), count + 1, `${seed}:negative`).join(", ");
  if (mode === "full") {
    return `TrackType: SFX, short one-shot ${materials[0] || "metal"} ${actions[0] || nouns[0] || "click"}, ${adjectives.join(" ") || "dry"}, ${spaces[0] || "close microphone"}, ${decay[0] || "fast decay"}, no music, no voice.`;
  }
  if (mode === "nouns") return nouns.join(" ");
  if (mode === "adjectives") return adjectives.join(" ");
  if (mode === "actions") return actions.join(" and ");
  if (mode === "materials") return materials.join(" and ");
  if (mode === "space") return spaces.join(", ");
  if (mode === "genetic") {
    return [...adjectives, ...materials, ...actions, ...spaces].filter(Boolean).join(" ");
  }
  return [...adjectives, ...materials].filter(Boolean).join(" ");
}

function modulationPromptMorphFragment(node, route, baseText = "") {
  const states = [
    node?.config?.stateA || "dry wooden percussion",
    node?.config?.stateB || "metallic underwater machine rhythm",
    node?.config?.stateC || "soft tape-warped ambient choir",
  ].map((item) => String(item || "").trim()).filter(Boolean);
  if (!states.length) return "";
  const morph = Math.min(1, Math.max(0, Number(node?.config?.morph ?? 0.5)));
  const scaled = morph * Math.max(1, states.length - 1);
  const leftIndex = Math.min(states.length - 1, Math.floor(scaled));
  const rightIndex = Math.min(states.length - 1, leftIndex + 1);
  const blend = scaled - leftIndex;
  const left = states[leftIndex] || "";
  const right = states[rightIndex] || left;
  if (left === right || blend < 0.12) return left;
  if (blend > 0.88) return right;
  const mode = route?.mode || route?.config?.outputMode || "blend";
  if (mode === "replace") return `${left}, ${right}`;
  return `morphing between ${left} and ${right}`;
}

function modulationComposeText(baseText = "", fragment = "", mode = "append") {
  const base = String(baseText || "").trim();
  const text = String(fragment || "").trim();
  if (!text) return base;
  if (!base || mode === "replace") return text;
  if (mode === "prepend") return `${text}, ${base}`;
  if (mode === "inject") {
    const parts = base.split(/\s+/);
    if (parts.length <= 2) return `${text} ${base}`;
    parts.splice(Math.max(1, parts.length - 1), 0, text);
    return parts.join(" ");
  }
  if (mode === "substitute") {
    const knownTerms = [...MODULATOR_WORD_BANKS.materials, ...MODULATOR_WORD_BANKS.adjectives, ...MODULATOR_WORD_BANKS.nouns];
    const match = knownTerms.find((term) => new RegExp(`\\b${term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "i").test(base));
    return match ? base.replace(new RegExp(`\\b${match.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "i"), text.split(/\s+/)[0]) : `${base}, ${text}`;
  }
  if (mode === "blend") return `${base}, blended with ${text}`;
  return `${base}, ${text}`;
}

function modulationMutationValue(node, route, target, baseValue) {
  const defaults = {
    min: Number.isFinite(Number(target?.min)) ? Number(target.min) : 0,
    max: Number.isFinite(Number(target?.max)) ? Number(target.max) : 1,
    distribution: node?.config?.distribution || "uniform",
    seed: Number(node?.config?.seed ?? 1),
    steppedValues: node?.config?.steppedValues || "",
    ...(route?.config || {}),
  };
  const seed = `${node?.id}:${route?.id}:${defaults.seed}:${target?.path}:${baseValue}`;
  let value;
  if (defaults.distribution === "stepped") {
    const values = String(defaults.steppedValues || "")
      .split(",")
      .map((item) => Number(item.trim()))
      .filter((item) => Number.isFinite(item));
    const pool = values.length ? values : [defaults.min, defaults.max];
    value = pool[Math.floor(deterministicUnit(seed) * pool.length) % pool.length];
  } else {
    const min = Number(defaults.min);
    const max = Number(defaults.max);
    value = min + deterministicUnit(seed) * (max - min);
  }
  if (target?.param === "seed" || target?.param === "batchSize" || target?.param === "colonyCandidates") return Math.round(value);
  return Number(Number(value).toFixed(3));
}

function modulationSteppedValues(value = "") {
  return String(value || "")
    .split(",")
    .map((item) => Number(item.trim()))
    .filter((item) => Number.isFinite(item));
}

function modulationRouteRange(route = {}, target = {}) {
  const fallback = modulationDefaultRangeFor("macro_modulator", target);
  const min = Number(route.config?.min);
  const max = Number(route.config?.max);
  return {
    min: Number.isFinite(min) ? min : fallback.min,
    max: Number.isFinite(max) ? max : fallback.max,
  };
}

function modulationShapeUnit(shape = "sine", phase = 0, seed = "") {
  const wrapped = ((Number(phase) || 0) % 1 + 1) % 1;
  if (shape === "triangle") return wrapped < 0.5 ? wrapped * 2 : (1 - wrapped) * 2;
  if (shape === "square") return wrapped < 0.5 ? 1 : 0;
  if (shape === "ramp") return wrapped;
  if (shape === "random_smooth") {
    const left = deterministicUnit(`${seed}:${Math.floor(phase)}`);
    const right = deterministicUnit(`${seed}:${Math.floor(phase) + 1}`);
    const t = wrapped * wrapped * (3 - 2 * wrapped);
    return left + (right - left) * t;
  }
  return 0.5 + Math.sin(wrapped * Math.PI * 2) * 0.5;
}

function modulationClockPhase(modulator, context = {}) {
  if (context.rate === "clocked" && Number.isFinite(Number(context.tick))) {
    const derived = timeClockDerived();
    const totalTicks = Math.max(1, derived.totalTicks || 1);
    if (modulator?.config?.sync && modulator.config.division) {
      return Number(context.tick) / Math.max(1, timeDivisionTicks(modulator.config.division));
    }
    return Number(context.tick) / totalTicks;
  }
  const startedAt = window.__germinatorModStart || (window.__germinatorModStart = performance.now());
  const elapsed = Math.max(0, (performance.now() - startedAt) / 1000);
  const rate = Math.max(0.001, Number(modulator?.config?.rateHz) || 0.25);
  return elapsed * rate;
}

function modulationContextText(target = {}, context = {}) {
  const node = canvasNodes.find((item) => item.id === (context.targetNodeId || target.nodeId));
  const asset = node?.assetId ? canvasAssetById(node.assetId) : null;
  const metadata = asset?.metadata || {};
  return [
    node?.label,
    node?.prompt,
    node?.negativePrompt,
    metadata.prompt,
    metadata.negative_prompt,
    metadata.notes,
    metadata.operation,
    ...(metadata.tags || []),
    ...(metadata.lora_strains || []).map((item) => item.name || item.path || ""),
  ].filter(Boolean).join(" ").toLowerCase();
}

function modulationLexicalUnit(text = "", positive = [], negative = []) {
  const corpus = String(text || "").toLowerCase();
  const score = positive.reduce((sum, word) => sum + (corpus.includes(word) ? 1 : 0), 0)
    - negative.reduce((sum, word) => sum + (corpus.includes(word) ? 1 : 0), 0);
  return Math.min(1, Math.max(0, 0.5 + score / Math.max(4, positive.length + negative.length)));
}

function modulationAnalysisUnit(modulator, target, context = {}) {
  const text = modulationContextText(target, context);
  const type = modulator?.modulatorType;
  if (type === "spectral_follower") {
    return modulationLexicalUnit(text, ["bright", "crisp", "glass", "metal", "sharp", "air", "spark", "high"], ["dark", "muffled", "muddy", "low", "soft", "dull"]);
  }
  if (type === "transient_detector") {
    return modulationLexicalUnit(text, ["click", "snap", "hit", "impact", "pluck", "transient", "percussion", "tick"], ["pad", "drone", "ambient", "sustain", "smooth"]);
  }
  if (type === "semantic_follower") {
    return modulationLexicalUnit(text, modulationBank("materials", modulator), modulationBank("negative", modulator));
  }
  if (type === "envelope_follower") {
    return modulationLexicalUnit(text, ["loud", "impact", "burst", "attack", "dense", "compressed"], ["quiet", "soft", "distant", "thin"]);
  }
  if (type === "region_envelope") {
    const node = canvasNodes.find((item) => item.id === target.nodeId);
    const regions = node?.regions || [];
    return regions.length ? Math.min(1, regions.length / 6) : 0.35;
  }
  if (type === "audio_to_control") {
    const feature = modulator?.config?.feature || "spectral";
    if (feature === "envelope") return modulationLexicalUnit(text, ["loud", "impact", "burst", "attack", "dense", "compressed"], ["quiet", "soft", "distant", "thin"]);
    if (feature === "transient") return modulationLexicalUnit(text, ["click", "snap", "hit", "impact", "pluck", "transient", "percussion", "tick"], ["pad", "drone", "ambient", "sustain", "smooth"]);
    if (feature === "rhythm") return modulationLexicalUnit(text, ["loop", "pulse", "groove", "rhythm", "syncopated", "pattern"], ["drone", "static", "unmetered", "wash"]);
    return modulationLexicalUnit(text, ["bright", "crisp", "glass", "metal", "sharp", "air", "spark", "high"], ["dark", "muffled", "muddy", "low", "soft", "dull"]);
  }
  return 0.5;
}

function modulationGestureUnit(modulator, context = {}) {
  const points = Array.isArray(modulator?.config?.points) && modulator.config.points.length
    ? modulator.config.points
    : [{ t: 0, value: Number(modulator?.config?.gestureValue ?? 0.5) }];
  const duration = Math.max(0.1, Number(modulator?.config?.durationSec) || 4);
  let t = 0;
  if (context.rate === "clocked" && Number.isFinite(Number(context.tick))) {
    const derived = timeClockDerived();
    t = Number(context.tick) / Math.max(1, derived.totalTicks || 1);
  } else {
    const startedAt = window.__germinatorGestureStart || (window.__germinatorGestureStart = performance.now());
    t = ((performance.now() - startedAt) / 1000) / duration;
  }
  if (modulator?.config?.loop !== false) t = ((t % 1) + 1) % 1;
  else t = Math.min(1, Math.max(0, t));
  const sorted = points
    .map((point) => ({ t: Math.min(1, Math.max(0, Number(point.t ?? 0))), value: Math.min(1, Math.max(0, Number(point.value ?? 0.5))) }))
    .sort((a, b) => a.t - b.t);
  if (!sorted.length) return Math.min(1, Math.max(0, Number(modulator?.config?.gestureValue ?? 0.5)));
  const rightIndex = sorted.findIndex((point) => point.t >= t);
  if (rightIndex <= 0) return sorted[rightIndex]?.value ?? sorted[0].value;
  const left = sorted[rightIndex - 1];
  const right = sorted[rightIndex] || sorted[sorted.length - 1];
  const span = Math.max(0.0001, right.t - left.t);
  const mix = Math.min(1, Math.max(0, (t - left.t) / span));
  return left.value + (right.value - left.value) * mix;
}

function modulationNumericUnit(modulator, route, target, baseValue, context = {}) {
  const type = modulator?.modulatorType || "macro_modulator";
  const seed = `${modulator?.id}:${route?.id}:${modulator?.config?.seed ?? route?.config?.seed ?? 1}:${target?.path}:${context.eventIndex ?? ""}:${context.tick ?? ""}:${baseValue ?? ""}`;
  if (type === "macro_modulator") return Math.min(1, Math.max(0, Number(modulator.config?.amount ?? 50) / 100));
  if (type === "probability_modulator") {
    const chance = Math.min(1, Math.max(0, Number(modulator.config?.chance ?? 75) / 100));
    return deterministicUnit(seed) <= chance ? 1 : 0;
  }
  if (type === "lfo_modulator") {
    const phase = modulationClockPhase(modulator, context) + (Number(modulator.config?.phase) || 0) / 360;
    return modulationShapeUnit(modulator.config?.shape || "sine", phase, seed);
  }
  if (type === "noise_modulator") {
    const phase = modulationClockPhase(modulator, context);
    const bucket = Math.floor(phase);
    const smooth = Math.min(1, Math.max(0, Number(modulator.config?.smooth ?? 0.35)));
    const a = deterministicUnit(`${seed}:noise:${bucket}`);
    const b = deterministicUnit(`${seed}:noise:${bucket + 1}`);
    const t = (phase - bucket) * smooth;
    return a + (b - a) * t;
  }
  if (type === "sample_hold_modulator") {
    const bucket = context.rate === "clocked" && Number.isFinite(Number(context.tick))
      ? Math.floor(Number(context.tick) / Math.max(1, timeDivisionTicks(modulator.config?.division || "1/8")))
      : Math.floor(modulationClockPhase({ ...modulator, config: { ...(modulator.config || {}), rateHz: 1 } }, context));
    return deterministicUnit(`${seed}:hold:${bucket}`);
  }
  if (type === "random_walk_modulator" || type === "brownian_modulator") {
    const phase = modulationClockPhase(modulator, context);
    const steps = Math.max(1, Math.min(96, Math.floor(phase) + 1));
    let value = 0.5;
    const drift = Math.min(0.48, Math.max(0.01, Number(modulator.config?.drift ?? (type === "brownian_modulator" ? 0.12 : 0.22))));
    for (let index = 0; index < steps; index += 1) {
      const delta = (deterministicUnit(`${seed}:walk:${index}`) - 0.5) * drift;
      value = Math.min(1, Math.max(0, value + delta));
    }
    return type === "brownian_modulator" ? value * value * (3 - 2 * value) : value;
  }
  if (type === "step_sequencer_modulator") {
    const values = modulationSteppedValues(modulator.config?.steps || "0, 1, 0.25, 0.75");
    const pool = values.length ? values : [0, 1, 0.25, 0.75];
    const phase = context.rate === "clocked" && Number.isFinite(Number(context.tick))
      ? Number(context.tick) / Math.max(1, timeDivisionTicks(modulator.config?.division || "1/8"))
      : modulationClockPhase(modulator, context);
    const index = Math.floor(phase) % pool.length;
    return Math.min(1, Math.max(0, Number(pool[index]) || 0));
  }
  if (["envelope_follower", "transient_detector", "spectral_follower", "semantic_follower", "region_envelope", "audio_to_control"].includes(type)) {
    return modulationAnalysisUnit(modulator, target, context);
  }
  if (type === "gesture_recorder") return modulationGestureUnit(modulator, context);
  if (type === "envelope_modulator") {
    const cycle = Math.max(0.05, Number(modulator.config?.cycleSeconds) || 2);
    const phaseSeconds = (modulationClockPhase({ ...modulator, config: { rateHz: 1 / cycle } }, context) % 1) * cycle;
    const attack = Math.max(0.001, Number(modulator.config?.attack) || 0.08);
    const decay = Math.max(0.001, Number(modulator.config?.decay) || 0.2);
    const sustain = Math.min(1, Math.max(0, Number(modulator.config?.sustain ?? 0.65)));
    const release = Math.max(0.001, Number(modulator.config?.release) || 0.28);
    const holdEnd = Math.max(attack + decay, cycle - release);
    if (phaseSeconds <= attack) return phaseSeconds / attack;
    if (phaseSeconds <= attack + decay) {
      const t = (phaseSeconds - attack) / decay;
      return 1 + (sustain - 1) * t;
    }
    if (phaseSeconds <= holdEnd) return sustain;
    return Math.max(0, sustain * (1 - (phaseSeconds - holdEnd) / release));
  }
  if (type === "random_modulator" || type === "mutation_modulator") {
    const values = modulationSteppedValues(route?.config?.steppedValues || modulator.config?.steppedValues);
    if ((route?.config?.distribution || modulator.config?.distribution) === "stepped" && values.length) {
      const value = values[Math.floor(deterministicUnit(seed) * values.length) % values.length];
      const range = modulationRouteRange(route, target);
      return range.max === range.min ? 0 : (value - range.min) / (range.max - range.min);
    }
    return deterministicUnit(seed);
  }
  return 0;
}

function modulationNumericValue(modulator, route, target, baseValue, context = {}) {
  const range = modulationRouteRange(route, target);
  let value = range.min + modulationNumericUnit(modulator, route, target, baseValue, context) * (range.max - range.min);
  if (Number.isFinite(Number(target?.min))) value = Math.max(Number(target.min), value);
  if (Number.isFinite(Number(target?.max))) value = Math.min(Number(target.max), value);
  if (["seed", "batchSize", "colonyCandidates"].includes(target?.param)) return Math.round(value);
  return Number(Number(value).toFixed(3));
}

function modulationMatrixSourceUnit(route = {}, target = {}, baseValue = 0, context = {}) {
  const sourceType = route.sourceType || "lfo_modulator";
  const virtualModulator = normalizeModulatorNode({
    id: `matrix-${sourceType}`,
    type: "modulator",
    modulatorType: sourceType,
    config: {
      seed: route.config?.seed ?? 1,
      amount: Number(route.amount ?? 0.35) * 100,
      feature: route.config?.feature || "spectral",
      shape: route.config?.shape || "sine",
      rateHz: route.config?.rateHz ?? 0.2,
      division: route.config?.division || "1/8",
      steps: route.config?.steps || "0, 0.25, 0.75, 1",
      gestureValue: route.config?.gestureValue ?? 0.5,
      durationSec: route.config?.durationSec ?? 4,
      points: route.config?.points,
    },
    routes: [],
  });
  const virtualRoute = {
    id: route.id || "matrix_route",
    config: {
      min: 0,
      max: 1,
      seed: route.config?.seed ?? 1,
      steppedValues: route.config?.steppedValues || "",
      distribution: route.config?.distribution || "uniform",
    },
  };
  return modulationNumericUnit(virtualModulator, virtualRoute, target, baseValue, {
    ...context,
    rate: "generation",
  });
}

function canvasApplyMatrixModulators(result, context = {}) {
  canvasModulatorNodes()
    .map(normalizeModulatorNode)
    .filter((modulator) => modulator.modulatorType === "mod_matrix")
    .forEach((matrix) => {
      (matrix.config?.matrixRoutes || []).forEach((route) => {
        if (!route.enabled || !route.targetNodeId || !route.targetPath) return;
        if (!modulationRouteMatches(route, context)) return;
        const target = modulationTargetForRoute(route);
        if (!target || target.type !== "number" || target.modulationRate !== "generation") return;
        const param = target.param;
        const baseValue = result[param] ?? modulationTargetValue(canvasNodes.find((node) => node.id === target.nodeId), target.path) ?? target.defaultValue ?? 0;
        const unit = modulationMatrixSourceUnit(route, target, baseValue, context);
        const amount = Math.min(1, Math.max(0, Number(route.amount ?? 0.35)));
        const span = Math.max(0.0001, Number(target.max ?? 1) - Number(target.min ?? 0));
        const finalValue = canvasGenerationValueClamp(param, Number(baseValue) + (unit - 0.5) * span * amount);
        if (String(param || "").startsWith("promptStack.")) {
          const layerKey = String(param).split(".")[1];
          result.promptStackWeights[layerKey] = finalValue;
          const promptNode = result.promptNode || canvasActivePromptNode(context.sourceNodeId);
          const compiled = canvasCompilePromptStack(promptNode || {}, result.promptStackWeights);
          result.prompt = compiled.prompt || result.prompt;
          result.negativePrompt = compiled.negativePrompt || result.negativePrompt;
        } else if (target.targetScope === "semantic_bridge") {
          result.semanticBridgeOverrides[target.nodeId] = {
            ...(result.semanticBridgeOverrides[target.nodeId] || {}),
            semanticAmount: finalValue,
          };
        } else {
          result[param] = finalValue;
        }
        result.modulationRecords.push({
          id: route.id,
          modulator_id: matrix.id,
          type: "mod_matrix",
          source_type: route.sourceType,
          mode: route.curve || "linear",
          target_node_id: target.nodeId,
          target_path: target.path,
          target_label: target.label,
          amount,
          base_value: baseValue,
          unit: Number(unit.toFixed(3)),
          final_value: finalValue,
        });
      });
    });
  return result;
}

function modulationRouteMatches(route, context = {}) {
  if (!route?.enabled || !route.targetNodeId || !route.targetPath) return false;
  const targetIds = new Set([context.targetNodeId, context.sourceNodeId, context.promptNodeId, ...(context.semanticNodeIds || [])].filter(Boolean));
  if (!targetIds.has(route.targetNodeId)) return false;
  const targetPaths = Array.isArray(context.targetPaths) ? context.targetPaths : [];
  if (targetPaths.length) return targetPaths.includes(route.targetPath);
  return true;
}

function canvasApplyGenerationModulators(base = {}, context = {}) {
  const result = {
    ...base,
    basePrompt: base.prompt || "",
    baseNegativePrompt: base.negativePrompt || "",
    prompt: base.prompt || "",
    negativePrompt: base.negativePrompt || "",
    durationSec: Number(base.durationSec) || 4,
    seed: Number.isFinite(Number(base.seed)) ? Math.round(Number(base.seed)) : -1,
    batchSize: Math.max(1, Math.round(Number(base.batchSize) || 1)),
    colonyCandidates: Math.max(1, Math.round(Number(base.colonyCandidates) || 4)),
    mutation: Number.isFinite(Number(base.mutation)) ? Number(base.mutation) : 0.5,
    promptWeight: 1,
    negativePromptWeight: 1,
    seedDrift: 0,
    cfgScale: Number(base.cfgScale ?? $("cfgScale")?.value ?? 1) || 1,
    batchSpread: 0,
    inpaintDensity: 0.5,
    maskFeather: 0.15,
    continuationDivergence: 0.5,
    loraStrength: 1,
    modelRouteIndex: 0,
    brightnessLanguage: 0,
    promptStackWeights: {},
    semanticBridgeOverrides: {},
    semanticLayers: [],
    semanticFxLayers: [],
    generationContext: {},
    modulationRecords: [],
  };
  canvasModulatorNodes().map(normalizeModulatorNode).forEach((modulator) => {
    if (modulator.modulatorType === "mod_matrix") return;
    (modulator.routes || []).forEach((route) => {
      if (!modulationRouteMatches(route, context)) return;
      const target = modulationTargetForRoute(route);
      if (!target) return;
      const record = {
        id: route.id,
        modulator_id: modulator.id,
        type: modulator.modulatorType,
        mode: modulator.modulatorType === "prompt_modulator" ? modulator.config.promptMode : route.config?.distribution || modulator.config.distribution || modulator.config.shape || modulator.modulatorType,
        target_node_id: target.nodeId,
        target_path: target.path,
        target_label: target.label,
        seed: modulator.config.seed ?? route.config?.seed ?? null,
      };
      if (PROMPT_MODULATOR_TYPES.has(modulator.modulatorType) && ["prompt", "negative"].includes(target.type)) {
        const baseValue = target.type === "negative" ? result.negativePrompt : result.prompt;
        const fragment = modulationPromptFragment(modulator, route, baseValue);
        const outputMode = route.mode || route.config?.outputMode || "append";
        const finalValue = modulationComposeText(baseValue, fragment, outputMode);
        if (target.type === "negative") result.negativePrompt = finalValue;
        else result.prompt = finalValue;
        result.modulationRecords.push({
          ...record,
          output_mode: outputMode,
          base_value: baseValue,
          final_value: finalValue,
          output: { fragment, final_prompt: result.prompt, final_negative_prompt: result.negativePrompt },
        });
      }
      if (GENERATION_VALUE_MODULATOR_TYPES.has(modulator.modulatorType) && target.type === "number" && target.modulationRate === "generation") {
        const param = target.param;
        const baseValue = result[param] ?? modulationTargetValue(canvasNodes.find((node) => node.id === target.nodeId), target.path);
        const finalValue = modulator.modulatorType === "mutation_modulator"
          ? modulationMutationValue(modulator, route, target, baseValue)
          : modulationNumericValue(modulator, route, target, baseValue, { rate: "generation", operation: context.operation });
        if (target.targetScope === "semantic_bridge") {
          result.semanticBridgeOverrides[target.nodeId] = {
            ...(result.semanticBridgeOverrides[target.nodeId] || {}),
            semanticAmount: finalValue,
          };
        } else if (String(param || "").startsWith("promptStack.")) {
          const layerKey = String(param).split(".")[1];
          result.promptStackWeights[layerKey] = finalValue;
          const promptNode = result.promptNode || canvasActivePromptNode(context.sourceNodeId);
          const compiled = canvasCompilePromptStack(promptNode || {}, result.promptStackWeights);
          result.prompt = compiled.prompt || result.prompt;
          result.negativePrompt = compiled.negativePrompt || result.negativePrompt;
        } else {
          result[param] = finalValue;
        }
        result.modulationRecords.push({
          ...record,
          distribution: route.config?.distribution || modulator.config.distribution,
          base_value: baseValue,
          final_value: finalValue,
        });
      }
    });
  });
  canvasApplyMatrixModulators(result, context);
  canvasApplySemanticFxLayers(result, context);
  result.prompt = canvasPhraseWeightText(result.prompt, result.promptWeight) || result.prompt;
  result.negativePrompt = canvasPhraseWeightText(result.negativePrompt, result.negativePromptWeight) || result.negativePrompt;
  result.prompt = canvasApplySemanticBrightness(result.prompt, result.brightnessLanguage);
  if (Number(result.seedDrift) > 0) {
    const seedBase = result.seed >= 0 ? result.seed : Math.floor(deterministicUnit(`${result.prompt}:${result.negativePrompt}:seed-base`) * 999999);
    const drift = Math.round((deterministicUnit(`${seedBase}:${context.operation}:seed-drift`) - 0.5) * 999999 * Math.min(1, Number(result.seedDrift)));
    result.seed = Math.max(0, seedBase + drift);
  }
  if (Number(result.batchSpread) > 0 && context.operation === "generate") {
    result.batchSize = Math.max(result.batchSize, Math.min(8, Math.round(1 + Number(result.batchSpread) * 7)));
  }
  const models = providerModels[$("provider")?.value] || [];
  if (models.length && Number(result.modelRouteIndex) > 0) {
    const index = Math.min(models.length - 1, Math.max(0, Math.round(Number(result.modelRouteIndex))));
    result.model = models[index];
  } else {
    result.model = $("model")?.value || "";
  }
  result.lora = loraPayload().map((item) => ({
    ...item,
    strength: Number.isFinite(Number(item.strength)) ? Number((Number(item.strength) * Number(result.loraStrength || 1)).toFixed(3)) : item.strength,
  }));
  return result;
}

function canvasResolveGenerationSettings(sourceNodeId = null, overrides = {}, modulationContext = {}) {
  const promptPayload = canvasPromptPayload(sourceNodeId || null);
  const contextNodeIds = {
    sourceNodeId,
    promptNodeId: promptPayload.promptNode?.id || null,
    targetNodeId: modulationContext.targetNodeId || sourceNodeId || promptPayload.promptNode?.id || null,
  };
  const semanticNodeIds = canvasSemanticFxNodesForContext(contextNodeIds).map((node) => node.id);
  const hasOwn = (key) => Object.prototype.hasOwnProperty.call(overrides, key);
  const base = {
    promptNode: promptPayload.promptNode,
    prompt: hasOwn("prompt") ? overrides.prompt : promptPayload.prompt || $("prompt")?.value || "",
    negativePrompt: hasOwn("negative_prompt") ? overrides.negative_prompt : promptPayload.negativePrompt || $("negativePrompt")?.value || "",
    durationSec: hasOwn("duration") ? Number(overrides.duration) : promptPayload.durationSec || Number($("duration")?.value) || 4,
    seed: hasOwn("seed") ? Number(overrides.seed) : promptPayload.seed,
    batchSize: hasOwn("batch_size") ? Number(overrides.batch_size) : promptPayload.batchSize,
    mutation: hasOwn("init_noise_level") ? Number(overrides.init_noise_level) : promptPayload.mutation,
    cfgScale: hasOwn("cfg_scale") ? Number(overrides.cfg_scale) : Number($("cfgScale")?.value) || 1,
    colonyCandidates: promptPayload.promptNode?.colonyCandidates || 4,
  };
  if (overrides.skip_modulation) {
    return {
      ...base,
      basePrompt: overrides.base_prompt ?? base.prompt,
      baseNegativePrompt: overrides.base_negative_prompt ?? base.negativePrompt,
      modulationRecords: Array.isArray(overrides.modulators) ? overrides.modulators : [],
    };
  }
  return canvasApplyGenerationModulators(base, {
    operation: overrides.operation || modulationContext.operation || "generate",
    ...contextNodeIds,
    semanticNodeIds,
    targetPaths: modulationContext.targetPaths || [],
  });
}

function canvasLineageWithModulation(lineage = {}, resolved = {}) {
  const records = resolved.modulationRecords || [];
  const semanticLayers = resolved.semanticLayers || [];
  const semanticFxLayers = resolved.semanticFxLayers || [];
  const controls = controlMetadataPayload();
  if (!records.length && !semanticLayers.length && !semanticFxLayers.length && !controls.control_routes.length) return lineage;
  const operationParams = lineage.operation_params && typeof lineage.operation_params === "object" ? lineage.operation_params : {};
  return {
    ...lineage,
    control_routes: controls.control_routes,
    control_snapshots: controls.control_snapshots,
    control_sources: controls.control_sources,
    operation_params: {
      ...operationParams,
      base_prompt: resolved.basePrompt,
      modulated_prompt: resolved.prompt,
      base_negative_prompt: resolved.baseNegativePrompt,
      modulated_negative_prompt: resolved.negativePrompt,
      cfg_scale: resolved.cfgScale,
      batch_spread: resolved.batchSpread,
      inpaint_density: resolved.inpaintDensity,
      mask_feather: resolved.maskFeather,
      continuation_divergence: resolved.continuationDivergence,
      prompt_weight: resolved.promptWeight,
      negative_prompt_weight: resolved.negativePromptWeight,
      seed_drift: resolved.seedDrift,
      brightness_language: resolved.brightnessLanguage,
      model_route: resolved.model,
      lora_strength: resolved.loraStrength,
      modulators: records,
      semantic_layers: semanticLayers,
      semantic_effects: semanticFxLayers,
      generation_context: resolved.generationContext || {},
      control_routes: controls.control_routes,
      control_snapshots: controls.control_snapshots,
      control_sources: controls.control_sources,
    },
  };
}

function modulationResolvedOverrides(resolved = {}) {
  return {
    prompt: resolved.prompt,
    negative_prompt: resolved.negativePrompt,
    duration: resolved.durationSec,
    seed: resolved.seed,
    batch_size: resolved.batchSize,
    cfg_scale: resolved.cfgScale,
    model: resolved.model,
    lora: resolved.lora,
    skip_modulation: true,
    base_prompt: resolved.basePrompt,
    modulated_prompt: resolved.prompt,
    base_negative_prompt: resolved.baseNegativePrompt,
    modulated_negative_prompt: resolved.negativePrompt,
    modulators: resolved.modulationRecords || [],
    semantic_layers: resolved.semanticLayers || [],
    semantic_effects: resolved.semanticFxLayers || [],
    generation_context: resolved.generationContext || {},
    ...controlMetadataPayload(),
  };
}

function canvasAssetById(id) {
  return canvasAssets.find((asset) => asset.id === id) || null;
}

function canvasSelectedNode() {
  return canvasNodes.find((node) => node.id === selectedCanvasNodeId) || null;
}

function canvasSelectedAsset() {
  const node = canvasSelectedNode();
  return node ? canvasAssetById(node.assetId) : null;
}

function canvasSoundNodes() {
  return canvasNodes.filter((node) => node.type === "sound");
}

function canvasPromptNodes() {
  return canvasNodes.filter((node) => node.type === "prompt");
}

function canvasActivePromptNode(sourceNodeId = null) {
  if (sourceNodeId) {
    const explicit = canvasNodes.find((node) => node.id === sourceNodeId);
    if (explicit?.type === "prompt") return explicit;
    const promptEdge = canvasEdges.find((edge) => edge.toNodeId === sourceNodeId && canvasNodes.find((node) => node.id === edge.fromNodeId)?.type === "prompt");
    const edgePrompt = promptEdge ? canvasNodes.find((node) => node.id === promptEdge.fromNodeId) : null;
    if (edgePrompt) return edgePrompt;
  }
  const selected = canvasSelectedNode();
  if (selected?.type === "prompt") return selected;
  return canvasPromptNodes()[0] || null;
}

function canvasNormalizePromptSettings(node = {}) {
  const durationSec = Number(node.durationSec);
  const batchSize = Number(node.batchSize);
  const seed = Number(node.seed);
  const mutation = Number(node.mutation);
  return {
    durationSec: Math.min(60, Math.max(0.5, Number.isFinite(durationSec) ? durationSec : 4)),
    batchSize: Math.min(8, Math.max(1, Math.round(Number.isFinite(batchSize) ? batchSize : 1))),
    seed: Number.isFinite(seed) ? Math.round(seed) : -1,
    mutation: mutationPresetForValue(Number.isFinite(mutation) ? mutation : 0.5).value,
  };
}

function canvasNormalizePromptStack(node = {}) {
  const stack = node.promptStack && typeof node.promptStack === "object" ? node.promptStack : {};
  return {
    material: stack.material || "",
    movement: stack.movement || "",
    space: stack.space || "",
    affect: stack.affect || "",
    technical: stack.technical || "",
  };
}

function canvasPhraseWeightText(text = "", weight = 1) {
  const phrase = String(text || "").trim();
  const amount = Number(weight);
  if (!phrase || amount <= 0.05) return "";
  if (amount >= 1.65) return `${phrase}, strongly ${phrase}`;
  if (amount >= 1.25) return `${phrase}, emphasized`;
  if (amount <= 0.45) return `subtle ${phrase}`;
  return phrase;
}

function canvasApplySemanticBrightness(prompt = "", brightness = 0) {
  const amount = Number(brightness) || 0;
  if (Math.abs(amount) < 0.08) return prompt;
  const bright = "bright, crisp, airy, sharp transients, high detail";
  const dark = "dark, muffled, low, rounded, shadowed texture";
  return modulationComposeText(prompt, amount > 0 ? bright : dark, "append");
}

function canvasCompilePromptStack(node = {}, layerWeights = {}) {
  const stack = canvasNormalizePromptStack(node);
  const promptParts = [String(node.prompt || "").trim()];
  PROMPT_STACK_LAYERS.forEach((layer) => {
    const weighted = canvasPhraseWeightText(stack[layer.key], Number(layerWeights[layer.key] ?? 1));
    if (weighted) promptParts.push(weighted);
  });
  return {
    prompt: promptParts.filter(Boolean).join(", "),
    negativePrompt: String(node.negativePrompt || "").trim(),
    stack,
  };
}

function canvasPromptPayload(sourceNodeId = null) {
  const promptNode = canvasActivePromptNode(sourceNodeId);
  const settings = canvasNormalizePromptSettings(promptNode || {});
  const stackPayload = canvasCompilePromptStack(promptNode || {});
  return {
    promptNode,
    prompt: stackPayload.prompt,
    negativePrompt: stackPayload.negativePrompt,
    promptStack: stackPayload.stack,
    durationSec: settings.durationSec,
    batchSize: settings.batchSize,
    seed: settings.seed,
    mutation: settings.mutation,
  };
}

function lineageOperationName(operation) {
  return {
    generate: "germinate",
    mutate: "mutate",
    inpaint: "prune",
    heal: "prune",
    "heal-full": "prune",
    continue: "continuation",
    branch: "branch",
    upload: "upload",
    recording: "recording",
    archive: "archive",
    extract_region: "slice",
    normalize: "normalize",
    seam_healer: "seam_healer",
    loop_doctor: "loop_doctor",
    transient_keeper: "transient_keeper",
    tail_extender: "tail_extender",
    texture_flatten: "texture_flatten",
    silence_cleaner: "silence_cleaner",
    spectral_freeze: "spectral_freeze",
    onset_splitter: "onset_splitter",
    region_quantizer: "region_quantizer",
    loudness_match: "loudness_match",
    phase_mono_check: "phase_mono_check",
    stem_extract_prep: "stem_extract_prep",
    metadata_embedder: "metadata_embedder",
    fade: "fade",
    crossfade_loop: "crossfade_loop",
    reverse: "reverse",
    duplicate: "duplicate",
    slice: "slice",
    metadata: "metadata",
    image_to_audio: "image",
    image_spectrogram: "image",
    organism_recording: "organism",
    breed: "breed",
    family: "family",
  }[operation] || operation || "archive";
}

function lineageSoundIdFromMetadata(metadata = {}, fallback = "") {
  return metadata.sound_id
    || metadata.lineage?.id
    || metadata.output_audio_path
    || metadata.audio_path
    || metadata.metadata_path
    || fallback
    || "";
}

function lineageSoundIdFromAsset(asset) {
  if (!asset) return "";
  return lineageSoundIdFromMetadata(asset.metadata || {}, asset.audioPath || asset.metadataPath || asset.storageUri || asset.id);
}

function lineageRegionPayload(region) {
  if (!region) return null;
  const config = canvasRegionConfig(region);
  const type = canvasRegionType(region);
  const bounds = canvasRegionBounds(region);
  if (!bounds) return null;
  return {
    id: region.id || null,
    purpose: region.purpose || config.purpose || null,
    region_type: type,
    label: config.label,
    role: region.role || config.role,
    behavior: region.behavior || config.behavior,
    intent: region.intent || config.intent,
    locked: Boolean(region.locked ?? config.locked),
    start_sec: Number(bounds.start.toFixed(3)),
    end_sec: Number(bounds.end.toFixed(3)),
    node_id: region.nodeId || region.node_id || null,
  };
}

function canvasLineagePayload(operation, { sourceNode = null, sourceAsset = null, region = null, extraParams = {}, colonyId = null } = {}) {
  const promptPayload = canvasPromptPayload(sourceNode?.id || null);
  const geneticPayload = canvasGeneticPayloadForTarget(sourceNode);
  const op = lineageOperationName(operation);
  const parentId = lineageSoundIdFromAsset(sourceAsset);
  const parentMetadataPaths = sourceAsset?.metadataPath ? [sourceAsset.metadataPath] : [];
  const parentBranch = sourceNode
    ? {
        node_id: sourceNode.id,
        label: sourceNode.label || sourceNode.type || "source",
        branch_parent_node_id: sourceNode.snapParentNodeId || null,
        branch_operation: sourceNode.snapOperation || null,
      }
    : null;
  return {
    parents: parentId ? [parentId] : [],
    parent_metadata_paths: parentMetadataPaths,
    operation: op,
    source_type: sourceNode?.type || (sourceAsset ? "sound" : "prompt"),
    source_node_id: sourceNode?.id || null,
    source_audio_path: sourceAsset?.audioPath || null,
    prompt_node_id: promptPayload.promptNode?.id || null,
    parent_branch: parentBranch,
    region: lineageRegionPayload(region),
    regions: canvasRegionRolesPayload(sourceNode),
    genetic: geneticPayload,
    colony_id: colonyId || null,
    operation_params: {
      prompt: promptPayload.prompt || $("prompt")?.value || "",
      negative_prompt: promptPayload.negativePrompt || $("negativePrompt")?.value || "",
      seed: promptPayload.seed,
      model: $("model")?.value || "",
      provider: $("provider")?.value || "",
      duration: promptPayload.durationSec || Number($("duration")?.value) || null,
      lora: loraPayload(),
      genetic_identities: geneticPayload.genetic_identities,
      generation_sequences: geneticPayload.generation_sequences,
      ...extraParams,
    },
  };
}

function formatPromptRunElapsed(ms = 0) {
  return `${(Math.max(0, Number(ms) || 0) / 1000).toFixed(1)}s`;
}

function canvasPromptRunElapsed(run = {}) {
  if (run.active && run.startedAt) return Date.now() - Number(run.startedAt);
  return Number(run.elapsedMs) || 0;
}

function canvasPromptRunState(node) {
  const run = node?.promptRun || {};
  const label = run.label || "Idle";
  const variant = run.variant || "muted";
  return {
    label,
    variant,
    detail: run.detail || "",
    elapsed: formatPromptRunElapsed(canvasPromptRunElapsed(run)),
  };
}

function canvasPromptMonitorMarkup(node) {
  const state = canvasPromptRunState(node);
  return `
    <div class="canvas-prompt-monitor" data-node-id="${escapeHtml(node.id)}" data-help="Prompt generation state and elapsed time.">
      <span class="canvas-prompt-state ${escapeHtml(state.variant)}" title="${escapeHtml(state.detail || state.label)}">${escapeHtml(state.label)}</span>
      <span class="canvas-prompt-time" aria-label="Prompt generation elapsed time">${escapeHtml(state.elapsed)}</span>
    </div>
  `;
}

function updateCanvasPromptMonitor(node) {
  const monitor = node ? document.querySelector(`.canvas-prompt-monitor[data-node-id="${CSS.escape(node.id)}"]`) : null;
  if (!monitor) return;
  const state = canvasPromptRunState(node);
  const stateEl = monitor.querySelector(".canvas-prompt-state");
  const timeEl = monitor.querySelector(".canvas-prompt-time");
  if (stateEl) {
    stateEl.textContent = state.label;
    stateEl.className = `canvas-prompt-state ${state.variant || "muted"}`;
    stateEl.title = state.detail || state.label;
  }
  if (timeEl) timeEl.textContent = state.elapsed;
}

function updateCanvasPromptMonitors() {
  canvasPromptNodes().forEach(updateCanvasPromptMonitor);
  if (!canvasPromptNodes().some((node) => node.promptRun?.active) && promptMonitorTimer) {
    window.clearInterval(promptMonitorTimer);
    promptMonitorTimer = null;
  }
}

function ensureCanvasPromptMonitorTimer() {
  if (!promptMonitorTimer) promptMonitorTimer = window.setInterval(updateCanvasPromptMonitors, 120);
}

function canvasPromptRunStart(node, label = "Generating", detail = "") {
  if (!node) return;
  node.promptRun = {
    label,
    detail,
    variant: "busy",
    startedAt: Date.now(),
    elapsedMs: 0,
    active: true,
  };
  updateCanvasPromptMonitor(node);
  ensureCanvasPromptMonitorTimer();
  canvasSaveState();
}

function canvasPromptRunUpdate(node, label, detail = "", variant = "busy") {
  if (!node) return;
  const previous = node.promptRun || {};
  node.promptRun = {
    ...previous,
    label,
    detail,
    variant,
    startedAt: previous.startedAt || Date.now(),
    active: variant === "busy",
  };
  node.promptRun.elapsedMs = canvasPromptRunElapsed(node.promptRun);
  updateCanvasPromptMonitor(node);
  if (node.promptRun.active) ensureCanvasPromptMonitorTimer();
  canvasSaveState();
}

function canvasPromptRunFinish(node, label, variant = "ok", detail = "") {
  if (!node) return;
  const previous = node.promptRun || {};
  const finishedAt = Date.now();
  node.promptRun = {
    ...previous,
    label,
    detail,
    variant,
    active: false,
    finishedAt,
    elapsedMs: previous.startedAt ? finishedAt - Number(previous.startedAt) : Number(previous.elapsedMs) || 0,
  };
  updateCanvasPromptMonitor(node);
  updateCanvasPromptMonitors();
  canvasSaveState();
}

function canvasRegionType(region = {}) {
  const rawType = String(region.regionType || region.region_type || "").trim();
  const purpose = String(region.purpose || "").trim();
  const normalized = WAVE_REGION_TYPE_ALIASES[rawType] || rawType || WAVE_REGION_TYPE_ALIASES[purpose] || purpose;
  return WAVE_REGION_TYPES[normalized] ? normalized : "mask";
}

function canvasRegionConfig(regionOrType = {}) {
  const type = typeof regionOrType === "string" ? (WAVE_REGION_TYPE_ALIASES[regionOrType] || regionOrType) : canvasRegionType(regionOrType);
  return WAVE_REGION_TYPES[type] || WAVE_REGION_TYPES.mask;
}

function canvasRegionBounds(region) {
  if (!region) return null;
  const start = Math.min(Number(region.startSec ?? region.start_sec ?? 0), Number(region.endSec ?? region.end_sec ?? 0));
  const end = Math.max(Number(region.startSec ?? region.start_sec ?? 0), Number(region.endSec ?? region.end_sec ?? 0));
  if (!Number.isFinite(start) || !Number.isFinite(end) || end - start < 0.04) return null;
  return { start, end };
}

function canvasRegionIsGenerativeMask(region) {
  const type = canvasRegionType(region);
  return WAVE_REGION_MASK_TYPES.has(type) || canvasRegionConfig(type).inpaint === true;
}

function canvasRegionIsProtected(region) {
  const type = canvasRegionType(region);
  return WAVE_REGION_PROTECT_TYPES.has(type) || canvasRegionConfig(type).locked === true;
}

function canvasRegionForPurpose(node, purpose) {
  return (node?.regions || []).find((region) => {
    if (region.purpose === purpose) return true;
    if (purpose === "inpaint" && canvasRegionIsGenerativeMask(region)) return true;
    return canvasRegionType(region) === purpose;
  }) || null;
}

function canvasLoopRegion(node) {
  const region = canvasRegionForPurpose(node, "loop");
  return canvasRegionBounds(region) ? region : null;
}

function canvasInpaintRegion(node) {
  const region = canvasRegionForPurpose(node, "inpaint");
  return canvasRegionBounds(region) ? region : null;
}

function canvasAllInpaintRegions(node) {
  return (node?.regions || []).filter((region) => canvasRegionIsGenerativeMask(region) && canvasRegionBounds(region));
}

function canvasRegionsForTypes(node, types = []) {
  const typeSet = new Set(types);
  return (node?.regions || []).filter((region) => typeSet.has(canvasRegionType(region)) && canvasRegionBounds(region));
}

function canvasRegionRangesForTypes(node, types = []) {
  return canvasRegionsForTypes(node, types)
    .map((region) => {
      const bounds = canvasRegionBounds(region);
      return bounds ? [Number(bounds.start.toFixed(3)), Number(bounds.end.toFixed(3))] : null;
    })
    .filter(Boolean);
}

function canvasRegionRolesPayload(node) {
  return (node?.regions || [])
    .map(lineageRegionPayload)
    .filter(Boolean);
}

function canvasRegionPayloadFields(node) {
  if (!node || node.type !== "sound") return {};
  const regionRoles = canvasRegionRolesPayload(node);
  return {
    region_roles: regionRoles,
    preserve_ranges: canvasRegionRangesForTypes(node, ["preserve"]),
    accent_ranges: canvasRegionRangesForTypes(node, ["accent"]),
    forbidden_ranges: canvasRegionRangesForTypes(node, ["forbidden"]),
    seed_ranges: canvasRegionRangesForTypes(node, ["seed"]),
    texture_ranges: canvasRegionRangesForTypes(node, ["texture"]),
    variation_ranges: canvasRegionRangesForTypes(node, ["variation"]),
    bridge_ranges: canvasRegionRangesForTypes(node, ["bridge"]),
    silence_ranges: canvasRegionRangesForTypes(node, ["silence"]),
  };
}

function canvasActiveEditableRegion(node) {
  if (!node) return null;
  const ids = Array.isArray(node.selectedRegionIds) ? node.selectedRegionIds : [];
  const selected = ids
    .map((id) => (node.regions || []).find((region) => region.id === id))
    .find((region) => canvasRegionBounds(region));
  if (selected) return selected;
  const latest = [...(node.regions || [])].reverse().find((region) => canvasRegionBounds(region));
  return latest || null;
}

function canvasRegionSummary(region) {
  if (!region) return "Draw a region, then assign a role.";
  const config = canvasRegionConfig(region);
  const bounds = canvasRegionBounds(region);
  if (!bounds) return `${config.label} selection`;
  return `${config.label} ${formatPreciseTime(bounds.start)}-${formatPreciseTime(bounds.end)}`;
}

function canvasMarkRegion(node, region, regionType, intent = "") {
  if (!node || !region) return null;
  const normalizedType = WAVE_REGION_TYPES[regionType] ? regionType : "mask";
  const config = canvasRegionConfig(normalizedType);
  if (config.multi === false) {
    node.regions = (node.regions || []).filter((item) => item.id === region.id || canvasRegionType(item) !== normalizedType);
  }
  region.regionType = normalizedType;
  region.region_type = normalizedType;
  region.purpose = config.purpose || region.purpose || "inpaint";
  region.role = config.role;
  region.behavior = config.behavior;
  region.intent = intent || region.intent || config.intent;
  region.locked = Boolean(config.locked);
  region.updatedAt = new Date().toISOString();
  node.selectedRegionIds = [region.id];
  return region;
}

function canvasEnsureRegionForType(node, regionType, intent = "", placement = "full") {
  if (!node) return null;
  const current = canvasActiveEditableRegion(node);
  if (current) return canvasMarkRegion(node, current, regionType, intent);
  const config = canvasRegionConfig(regionType);
  const viewStart = canvasNodePlaybackStart(node);
  const viewEnd = Math.max(viewStart + 0.05, canvasNodePlaybackEnd(node));
  const duration = Math.max(0.05, viewEnd - viewStart);
  let start = viewStart;
  let end = viewEnd;
  if (placement === "tail") start = Math.max(viewStart, viewEnd - duration * 0.35);
  if (placement === "center") {
    start = viewStart + duration * 0.25;
    end = viewStart + duration * 0.75;
  }
  return canvasSetRegion(node, config.purpose || "inpaint", start, end, { regionType, intent });
}

function canvasModulatedInpaintRanges(regions = [], duration = 0, resolved = {}) {
  const total = Math.max(0.05, Number(duration) || 0);
  const density = Math.min(1, Math.max(0.04, Number(resolved.inpaintDensity ?? 1)));
  const feather = Math.min(1, Math.max(0, Number(resolved.maskFeather ?? 0)));
  return regions
    .map((region) => {
      const start = Math.max(0, Math.min(Number(region.startSec) || 0, Number(region.endSec) || 0));
      const end = Math.min(total, Math.max(Number(region.startSec) || 0, Number(region.endSec) || 0));
      const length = Math.max(0.04, end - start);
      const center = start + length / 2;
      const denseHalf = Math.max(0.02, (length * density) / 2);
      const featherSeconds = length * feather * 0.25;
      let nextStart = Math.max(0, center - denseHalf - featherSeconds);
      let nextEnd = Math.min(total, center + denseHalf + featherSeconds);
      if (nextEnd - nextStart < 0.04) {
        const pad = (0.04 - (nextEnd - nextStart)) / 2;
        nextStart = Math.max(0, nextStart - pad);
        nextEnd = Math.min(total, nextEnd + pad);
      }
      return [Number(nextStart.toFixed(3)), Number(nextEnd.toFixed(3))];
    })
    .filter(([start, end]) => end > start);
}

function canvasRegionAtPointer(event, node, purpose) {
  const point = canvasRegionFromPointer(event, node);
  return [...(node?.regions || [])].reverse().find((region) => {
    if (region.purpose !== purpose && canvasRegionType(region) !== purpose && !(purpose === "inpaint" && canvasRegionIsGenerativeMask(region))) return false;
    const bounds = canvasRegionBounds(region);
    if (!bounds) return false;
    const { start, end } = bounds;
    return end - start >= 0.04 && point >= start && point <= end;
  }) || null;
}

function canvasSetRegion(node, purpose, startSec, endSec, extra = {}) {
  if (!node) return null;
  node.regions = node.regions || [];
  const regionType = extra.regionType || extra.region_type || WAVE_REGION_TYPE_ALIASES[purpose] || purpose || "mask";
  const config = canvasRegionConfig(regionType);
  if (config.inpaint || purpose === "inpaint") {
    const existing = node.regions.filter((region) => canvasRegionIsGenerativeMask(region));
    if (existing.length >= 8) {
      const oldest = existing[0];
      node.regions = node.regions.filter((r) => r.id !== oldest.id);
    }
  } else if (config.multi === false) {
    node.regions = node.regions.filter((region) => region.purpose !== purpose && canvasRegionType(region) !== canvasRegionType({ regionType }));
  }
  const region = {
    id: canvasId("region"),
    nodeId: node.id,
    startSec,
    endSec,
    purpose: config.purpose || purpose,
    regionType: canvasRegionType({ regionType }),
    region_type: canvasRegionType({ regionType }),
    role: config.role,
    behavior: config.behavior,
    intent: extra.intent || config.intent,
    locked: Boolean(config.locked),
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  node.regions.push(region);
  node.selectedRegionIds = [region.id];
  if (region.purpose === "loop" || canvasRegionType(region) === "loop") {
    node.loop = true;
    if (node.audio) node.audio.loop = false;
  }
  return region;
}

function canvasRemoveRegion(node, regionId) {
  if (!node || !regionId) return;
  const removed = (node.regions || []).find((region) => region.id === regionId);
  const removedLoop = removed && (removed.purpose === "loop" || canvasRegionType(removed) === "loop");
  node.regions = (node.regions || []).filter((region) => region.id !== regionId);
  node.selectedRegionIds = (node.selectedRegionIds || []).filter((id) => id !== regionId);
  if (removedLoop && !canvasLoopRegion(node)) {
    node.loop = false;
    if (node.audio) node.audio.loop = false;
  }
}

function canvasNodePlaybackStart(node) {
  return Math.max(0, Number(node?.playbackStartSec) || 0);
}

function canvasNodePlaybackEnd(node) {
  const explicit = Number(node?.playbackEndSec);
  if (Number.isFinite(explicit) && explicit > canvasNodePlaybackStart(node)) return explicit;
  const asset = canvasAssetById(node?.assetId);
  return Number(asset?.durationSec) || Number(node?.futureDuration) || 4;
}

function canvasNodeViewDuration(node) {
  return Math.max(0.01, canvasNodePlaybackEnd(node) - canvasNodePlaybackStart(node));
}

function canvasNodeSourceDuration(node) {
  const asset = canvasAssetById(node?.assetId);
  return Math.max(0.01, Number(asset?.durationSec) || Number(node?.futureDuration) || canvasNodePlaybackEnd(node) || 4);
}

function canvasClampNodeTime(node, seconds) {
  const duration = canvasNodeSourceDuration(node);
  const numeric = Number(seconds);
  if (!Number.isFinite(numeric)) return 0;
  return Math.min(duration, Math.max(0, numeric));
}

function canvasForwardTimeToAudioTime(node, forwardSec) {
  const forward = canvasClampNodeTime(node, forwardSec);
  if (!node?.reversePlayback) return forward;
  return canvasClampNodeTime(node, canvasNodeSourceDuration(node) - forward);
}

function canvasAudioTimeToForwardTime(node, audioSec = node?.audio?.currentTime) {
  const audioTime = canvasClampNodeTime(node, audioSec);
  if (!node?.reversePlayback) return audioTime;
  return canvasClampNodeTime(node, canvasNodeSourceDuration(node) - audioTime);
}

function canvasNodePlaybackRange(node) {
  const loopBounds = node?.loop ? canvasRegionBounds(canvasLoopRegion(node)) : null;
  const start = loopBounds ? loopBounds.start : canvasNodePlaybackStart(node);
  const end = loopBounds ? loopBounds.end : canvasNodePlaybackEnd(node);
  return {
    start: canvasClampNodeTime(node, Math.min(start, end)),
    end: canvasClampNodeTime(node, Math.max(start, end)),
  };
}

function canvasAudioStartTimeForRange(node, startSec, endSec) {
  return canvasForwardTimeToAudioTime(node, node?.reversePlayback ? endSec : startSec);
}

function canvasPlaybackResetTime(node) {
  const range = canvasNodePlaybackRange(node);
  return canvasAudioStartTimeForRange(node, range.start, range.end);
}

function canvasCurrentForwardPlaybackTime(node) {
  if (!node?.audio) return canvasNodePlaybackStart(node);
  return canvasAudioTimeToForwardTime(node, node.audio.currentTime);
}

function canvasPlaybackElapsedTime(node) {
  if (!node?.audio) return 0;
  const range = canvasNodePlaybackRange(node);
  const forward = canvasCurrentForwardPlaybackTime(node);
  const elapsed = node.reversePlayback ? range.end - forward : forward - range.start;
  return Math.max(0, Math.min(Math.max(0.01, range.end - range.start), elapsed));
}

function canvasOriginFromItem(item) {
  const mode = item?.germinator_mode || modeAliases[item?.mode] || item?.mode || "library";
  if (mode === "germinate" || mode === "text-to-audio") return "prompt";
  if (mode === "mutate" || mode === "audio-to-audio") return "audio_to_audio";
  if (mode === "prune" || mode === "inpainting") return "inpaint";
  if (mode === "propagate" || mode === "continuation") return "continuation";
  if (mode === "harvest" || mode === "time-render" || item?.source_type === "time_render") return "time_render";
  if (mode === "archive") return item?.runtime === "upload" ? "upload" : "library";
  return "library";
}

function canvasCreateAsset({ audioPath = "", objectUrl = "", file = null, metadataPath = "", metadata = null, origin = "library", parentAssetIds = [] }) {
  const storageUri = objectUrl || audioPath;
  const existing = canvasAssets.find((asset) => asset.storageUri === storageUri && !asset.localOnly);
  if (existing) return existing;
  const asset = {
    id: canvasId("asset"),
    projectId: activeCulture.id,
    storageUri,
    audioPath,
    objectUrl,
    file,
    metadataPath,
    durationSec: Number(metadata?.duration) || null,
    sampleRate: Number(metadata?.sample_rate) || null,
    channels: metadata?.channels || null,
    origin,
    parentAssetIds,
    createdAt: metadata?.created_at || new Date().toISOString(),
    metadata: metadata || {},
    localOnly: Boolean(file || objectUrl),
  };
  canvasAssets.push(asset);
  return asset;
}

function canvasBoardDefaultPoint() {
  const board = $("canvasBoard");
  if (!board) return { x: 80, y: 88 };
  const rect = board.getBoundingClientRect();
  const visibleWidth = Math.max(320, Math.min(board.clientWidth, window.innerWidth - rect.left - 24));
  const visibleHeight = Math.max(360, Math.min(board.clientHeight, window.innerHeight - rect.top - 170));
  if (!canvasNodes.length) {
    return {
      x: (board.scrollLeft + Math.max(36, visibleWidth / 2 - 166)) / canvasZoom,
      y: (board.scrollTop + Math.max(56, visibleHeight / 2 - 176)) / canvasZoom,
    };
  }
  return {
    x: (board.scrollLeft + 40) / canvasZoom,
    y: (board.scrollTop + 40) / canvasZoom,
  };
}

function canvasPointFromEvent(event) {
  const board = $("canvasBoard");
  if (!board) return canvasBoardDefaultPoint();
  const rect = board.getBoundingClientRect();
  return {
    x: (event.clientX - rect.left + board.scrollLeft) / canvasZoom,
    y: (event.clientY - rect.top + board.scrollTop) / canvasZoom,
  };
}

function canvasClampMenuPoint(point, metrics = {}) {
  const board = $("canvasBoard");
  if (!board) return point;
  const boardRect = board.getBoundingClientRect();
  const transportRect = $("canvasTransportModule")?.getBoundingClientRect();
  const safeViewportBottom = transportRect ? transportRect.top - 12 : boardRect.bottom;
  const fallbackMenuHeight = Math.min(560, Math.max(236, window.innerHeight - 160));
  const menuWidth = metrics.width || 240;
  const menuHeight = metrics.height || fallbackMenuHeight;
  const minX = board.scrollLeft / canvasZoom + 12;
  const minY = board.scrollTop / canvasZoom + 12;
  const maxX = Math.max(minX, (board.scrollLeft + board.clientWidth) / canvasZoom - menuWidth - 12);
  const safeBottom = Math.min(boardRect.bottom, safeViewportBottom);
  const maxY = Math.max(minY, (safeBottom - boardRect.top + board.scrollTop) / canvasZoom - menuHeight - 12);
  return {
    x: Math.min(Math.max(point.x, minX), maxX),
    y: Math.min(Math.max(point.y, minY), maxY),
  };
}

function canvasReclampSourceMenu() {
  const menu = $("canvasSourceMenu");
  if (!menu || menu.hidden || !canvasPendingSourcePosition) return;
  canvasPendingSourcePosition = canvasClampMenuPoint(canvasPendingSourcePosition, {
    width: menu.offsetWidth,
    height: menu.offsetHeight,
  });
  menu.style.left = `${canvasPendingSourcePosition.x}px`;
  menu.style.top = `${canvasPendingSourcePosition.y}px`;
}

function canvasUpdateSourceMenuState() {
  const menu = $("canvasSourceMenu");
  if (!menu) return;
  const compact = canvasSourceMenuView === "compact";
  menu.dataset.view = canvasSourceMenuView;
  menu.classList.toggle("is-compact", compact);
  menu.classList.toggle("is-full", !compact);
  menu.querySelectorAll("[data-source-panel]").forEach((panel) => {
    const active = panel.dataset.sourcePanel === canvasSourceMenuTab;
    panel.hidden = !active;
    panel.classList.toggle("is-active", active);
  });
  menu.querySelectorAll('[data-action="canvas-source-tab"]').forEach((tabButton) => {
    const active = tabButton.dataset.tab === canvasSourceMenuTab;
    tabButton.classList.toggle("is-active", active);
    tabButton.setAttribute("aria-selected", active ? "true" : "false");
  });
  const viewToggle = $("canvasSourceViewToggle");
  if (viewToggle) {
    viewToggle.setAttribute("aria-pressed", compact ? "true" : "false");
    viewToggle.title = compact ? "Switch to full source toolbox" : "Switch to compact source toolbox";
    viewToggle.setAttribute("aria-label", viewToggle.title);
    const label = viewToggle.querySelector("[data-view-label]");
    if (label) label.textContent = compact ? "Full" : "Compact";
  }
  if (canvasSourceMenuTab === "micro") {
    renderMicroMatterProfile();
  }
}

function canvasSetSourceMenuTab(tab) {
  if (!CANVAS_SOURCE_MENU_TABS.has(tab)) return;
  canvasSourceMenuTab = tab;
  localStorage.setItem("germinator-source-menu-tab", canvasSourceMenuTab);
  canvasUpdateSourceMenuState();
  canvasReclampSourceMenu();
  if (canvasSourceMenuTab === "micro") {
    renderMicroMatterProfile();
  }
}

function canvasToggleSourceMenuView() {
  canvasSourceMenuView = canvasSourceMenuView === "compact" ? "full" : "compact";
  localStorage.setItem("germinator-source-menu-view", canvasSourceMenuView);
  canvasUpdateSourceMenuState();
  canvasReclampSourceMenu();
}

function openCanvasSourceMenu(point = null) {
  const menu = $("canvasSourceMenu");
  if (!menu) return;
  $("canvasSpace")?.classList.add("source-menu-open");
  canvasUpdateSourceMenuState();
  const requestedPoint = point || canvasBoardDefaultPoint();
  menu.hidden = false;
  menu.style.visibility = "hidden";
  menu.style.left = `${requestedPoint.x}px`;
  menu.style.top = `${requestedPoint.y}px`;
  canvasPendingSourcePosition = canvasClampMenuPoint(requestedPoint, {
    width: menu.offsetWidth,
    height: menu.offsetHeight,
  });
  menu.style.left = `${canvasPendingSourcePosition.x}px`;
  menu.style.top = `${canvasPendingSourcePosition.y}px`;
  menu.style.visibility = "";
}

/* ── Toolbox drag-to-move ──────────────────────────────────────────── */
(function initToolboxDrag() {
  let dragging = false;
  let startX = 0;
  let startY = 0;
  let origLeft = 0;
  let origTop = 0;

  function onPointerDown(e) {
    const menu = $("canvasSourceMenu");
    if (!menu || menu.hidden) return;
    /* Only start drag from the title bar area, not from buttons inside it */
    if (e.target.closest("button, input, select, textarea, a")) return;
    dragging = true;
    startX = e.clientX;
    startY = e.clientY;
    origLeft = parseFloat(menu.style.left) || 0;
    origTop = parseFloat(menu.style.top) || 0;
    menu.style.cursor = "grabbing";
    e.preventDefault();
  }

  function onPointerMove(e) {
    if (!dragging) return;
    const menu = $("canvasSourceMenu");
    if (!menu) { dragging = false; return; }
    const dx = (e.clientX - startX) / canvasZoom;
    const dy = (e.clientY - startY) / canvasZoom;
    menu.style.left = `${origLeft + dx}px`;
    menu.style.top = `${origTop + dy}px`;
  }

  function onPointerUp() {
    if (!dragging) return;
    dragging = false;
    const menu = $("canvasSourceMenu");
    if (menu) {
      menu.style.cursor = "";
      canvasPendingSourcePosition = {
        x: parseFloat(menu.style.left) || 0,
        y: parseFloat(menu.style.top) || 0,
      };
    }
  }

  document.addEventListener("DOMContentLoaded", () => {
    const header = document.querySelector(".canvas-source-menu-top");
    if (header) {
      header.style.cursor = "grab";
      header.addEventListener("pointerdown", onPointerDown);
    }
    window.addEventListener("pointermove", onPointerMove);
    window.addEventListener("pointerup", onPointerUp);
  });
})();

function closeCanvasSourceMenu({ keepPosition = false } = {}) {
  const menu = $("canvasSourceMenu");
  if (menu) menu.hidden = true;
  $("canvasSpace")?.classList.remove("source-menu-open");
  if (!keepPosition) canvasPendingSourcePosition = null;
}

function closeCanvasConnectMenu() {
  const menu = $("canvasConnectMenu");
  if (menu) {
    menu.hidden = true;
    menu.innerHTML = "";
    menu.removeAttribute("style");
  }
  document.querySelectorAll(".canvas-io-port.connecting").forEach((port) => port.classList.remove("connecting"));
}

function canvasConnectPointFor(sourceNode, offset = {}) {
  const size = canvasNodeVisualSize(sourceNode);
  return {
    x: Math.max(8, sourceNode.x + size.width + (offset.x ?? 42)),
    y: Math.max(8, sourceNode.y + (offset.y ?? 0)),
  };
}

function canvasNodeBoundsFor(node, point = null, size = null) {
  const visualSize = size || canvasNodeVisualSize(node);
  return {
    x: point?.x ?? Number(node?.x) ?? 0,
    y: point?.y ?? Number(node?.y) ?? 0,
    width: visualSize.width,
    height: visualSize.height,
  };
}

function canvasBoundsOverlap(a, b, padding = 24) {
  return !(
    a.x + a.width + padding < b.x ||
    b.x + b.width + padding < a.x ||
    a.y + a.height + padding < b.y ||
    b.y + b.height + padding < a.y
  );
}

function canvasClampNodePoint(point, size) {
  const board = $("canvasBoard");
  if (!board) return { x: Math.max(8, point.x), y: Math.max(8, point.y) };
  const minX = board.scrollLeft / canvasZoom + 8;
  const minY = board.scrollTop / canvasZoom + 8;
  const maxX = Math.max(minX, (board.scrollLeft + board.clientWidth) / canvasZoom - size.width - 16);
  const maxY = Math.max(minY, (board.scrollTop + board.clientHeight) / canvasZoom - size.height - 96);
  return {
    x: Math.min(Math.max(point.x, minX), maxX),
    y: Math.min(Math.max(point.y, minY), maxY),
  };
}

function canvasFindOpenPoint(initialPoint, size, { anchorNode = null, excludeNodeIds = [] } = {}) {
  const excluded = new Set(excludeNodeIds.filter(Boolean));
  const anchorSize = anchorNode ? canvasNodeVisualSize(anchorNode) : null;
  const candidates = [
    initialPoint,
    anchorNode && anchorSize ? { x: anchorNode.x, y: anchorNode.y + anchorSize.height + 34 } : null,
    { x: initialPoint.x, y: initialPoint.y + size.height + 34 },
    { x: initialPoint.x + size.width + 44, y: initialPoint.y },
    anchorNode ? { x: Math.max(8, anchorNode.x - size.width - 44), y: anchorNode.y } : null,
  ].filter(Boolean).map((point) => canvasClampNodePoint(point, size));
  const collides = (point) => {
    const rect = canvasNodeBoundsFor(null, point, size);
    return canvasNodes.some((node) => !excluded.has(node.id) && canvasBoundsOverlap(rect, canvasNodeBoundsFor(node)));
  };
  const openCandidate = candidates.find((point) => !collides(point));
  if (openCandidate) return openCandidate;
  let point = candidates[1] || initialPoint;
  for (let index = 0; index < 8; index += 1) {
    const next = canvasClampNodePoint({ x: point.x, y: point.y + (size.height + 34) * (index + 1) }, size);
    if (!collides(next)) return next;
  }
  return canvasClampNodePoint(initialPoint, size);
}

function canvasConnectSoundTarget(node) {
  if (node?.type === "sound") return node;
  if (node?.type === "fx") return canvasNodes.find((item) => item.id === node.targetNodeId && item.type === "sound") || canvasSelectedSoundNode();
  return canvasSelectedSoundNode() || canvasSoundNodes().at(-1) || null;
}

function canvasConnectChoices(node, port) {
  if (!node) return [];
  if (port === "input") {
    if (!canvasConnectionDraft?.nodeId) {
      return [{ kind: "note", label: "Pick an output dot first", detail: "Then connect it here." }];
    }
    return [{ kind: "connect-input", label: "Connect here", detail: node.label || node.type }];
  }
  if (node.type === "prompt") {
    return [
      { kind: "generate", label: "Generate sound", detail: "Use this prompt now." },
      { kind: "genetic", value: "identity_extractor", trait: "prompt", label: "Prompt identity", detail: "Extract reusable textual DNA." },
      { kind: "genetic", value: "generation_sequencer", label: "Generation sequencer", detail: "Build a procedural generation chain." },
      { kind: "modulator", value: "prompt_morph", label: "Prompt morph", detail: "Blend prompt states." },
      { kind: "modulator", value: "prompt_modulator", label: "Prompt modulator", detail: "Route language changes." },
      { kind: "modulator", value: "random_walk_modulator", label: "Seed walk", detail: "Organic generation drift." },
      { kind: "modulator", value: "mutation_modulator", label: "Mutation modulator", detail: "Drive seed and mutation." },
    ];
  }
  if (node.type === "fx") {
    return [
      { kind: "modulator", value: "lfo_modulator", label: "LFO route", detail: "Move this effect." },
      { kind: "modulator", value: "macro_modulator", label: "Macro route", detail: "Manual effect control." },
      { kind: "fx", value: "gain", label: "Gain", detail: "Level control." },
      { kind: "fx", value: "pan", label: "Pan", detail: "Stereo placement." },
      { kind: "fx", value: "filter", label: "Filter", detail: "Spectral contour." },
      { kind: "fx", value: "granular", label: "Granular", detail: "Grain prompt extractor." },
    ];
  }
  if (node.type === "sound") {
    return [
      { kind: "genetic", value: "identity_extractor", trait: "timbre", label: "Timbre identity", detail: "Extract material DNA." },
      { kind: "genetic", value: "identity_extractor", trait: "rhythm", label: "Rhythm identity", detail: "Extract groove and timing." },
      { kind: "genetic", value: "identity_extractor", trait: "space", label: "Space identity", detail: "Extract ambience behavior." },
      { kind: "genetic", value: "generation_sequencer", label: "Generation sequencer", detail: "Procedural sampling chain." },
      { kind: "modulator", value: "spectral_follower", label: "Spectral follower", detail: "Route brightness to generation." },
      { kind: "modulator", value: "random_walk_modulator", label: "Seed walk", detail: "Organic generation drift." },
      { kind: "fx", value: "gain", label: "Gain", detail: "Level control." },
      { kind: "fx", value: "pan", label: "Pan", detail: "Stereo placement." },
      { kind: "fx", value: "pitch", label: "Pitch", detail: "Speed and pitch." },
      { kind: "fx", value: "filter", label: "Filter", detail: "Spectral contour." },
      { kind: "fx", value: "granular", label: "Granular", detail: "Semantic grain bridge." },
      { kind: "fx", value: "echo", label: "Echo", detail: "Delay and feedback." },
      { kind: "fx", value: "space", label: "Space", detail: "Compact reverb." },
      { kind: "fx", value: "saturation", label: "Saturation", detail: "Harmonic drive." },
      { kind: "op", value: "continue", label: "Continue", detail: "Propagate the sound." },
      { kind: "time", value: "slicer", label: "Slicer", detail: "Create a clocked slicer." },
    ];
  }
  if (node.type === "time") {
    return [
      { kind: "time", value: "render_bus", label: "Render bus", detail: "Harvest time modules." },
      { kind: "modulator", value: "random_modulator", label: "Random route", detail: "Clocked values." },
    ];
  }
  if (node.type === "modulator") {
    return [
      { kind: "modulator-route", label: "Add route", detail: "Route to selected module." },
      { kind: "modulator", value: "macro_modulator", label: "Macro", detail: "Manual control." },
    ];
  }
  if (node.type === "genetic") {
    return [
      { kind: "genetic-route-selected", label: "Route to selected", detail: "Send this identity or sequence to a target." },
      ...(node.geneticType === "identity_extractor"
        ? [{ kind: "genetic", value: "generation_sequencer", label: "Generation sequencer", detail: "Drive a procedural chain from this DNA." }]
        : []),
    ];
  }
  return [];
}

function openCanvasConnectMenu(nodeId, port, anchor) {
  const node = canvasNodes.find((item) => item.id === nodeId);
  const menu = $("canvasConnectMenu");
  const space = $("canvasSpace");
  if (!node || !menu || !space) return;
  closeCanvasSourceMenu();
  document.querySelectorAll(".canvas-io-port.connecting").forEach((item) => item.classList.remove("connecting"));
  anchor?.classList?.add("connecting");
  canvasConnectionDraft = port === "output" ? { nodeId, port } : canvasConnectionDraft;
  const choices = canvasConnectChoices(node, port);
  menu.innerHTML = `
    <div class="canvas-connect-head">
      <strong>${escapeHtml(port === "output" ? "Create connection" : "Audio input")}</strong>
      <span>${escapeHtml(node.label || node.type)}</span>
    </div>
    <div class="canvas-connect-options">
      ${choices.map((choice) => choice.kind === "note"
        ? `<div class="canvas-connect-note"><strong>${escapeHtml(choice.label)}</strong><span>${escapeHtml(choice.detail || "")}</span></div>`
        : `<button type="button" data-action="canvas-connect-choice" data-node-id="${escapeHtml(node.id)}" data-kind="${escapeHtml(choice.kind)}" data-value="${escapeHtml(choice.value || "")}" data-trait="${escapeHtml(choice.trait || "")}">
            <strong>${escapeHtml(choice.label)}</strong>
            <span>${escapeHtml(choice.detail || "")}</span>
          </button>`).join("")}
    </div>
  `;
  const rect = anchor?.getBoundingClientRect?.() || space.getBoundingClientRect();
  const spaceRect = space.getBoundingClientRect();
  menu.hidden = false;
  menu.style.visibility = "hidden";
  const desiredLeft = (rect.left + rect.width / 2 - spaceRect.left) / canvasZoom + 14;
  const desiredTop = (rect.top + rect.height / 2 - spaceRect.top) / canvasZoom - 20;
  const menuWidth = menu.offsetWidth || 220;
  const menuHeight = menu.offsetHeight || 260;
  const left = Math.max(8, Math.min((space.offsetWidth || 1800) - menuWidth - 8, desiredLeft));
  const top = Math.max(8, Math.min((space.offsetHeight || 1200) - menuHeight - 8, desiredTop));
  menu.style.left = `${left}px`;
  menu.style.top = `${top}px`;
  menu.style.visibility = "";
}

async function runCanvasConnectChoice(button) {
  pushUndo();
  const node = canvasNodes.find((item) => item.id === button.dataset.nodeId);
  if (!node) return;
  const kind = button.dataset.kind;
  const value = button.dataset.value;
  const point = canvasConnectPointFor(node);
  const target = canvasConnectSoundTarget(node);
  if (kind === "fx") {
    canvasCreateFxNode(value || "gain", { x: point.x, y: point.y, targetNode: target });
  } else if (kind === "time") {
    canvasCreateTimeNode(value || "slicer", { x: point.x, y: point.y });
  } else if (kind === "modulator") {
    const modulatorType = value || "macro_modulator";
    const modulatorSize = canvasModulatorNodeSize(modulatorType);
    const modulatorPoint = canvasFindOpenPoint(point, modulatorSize, { anchorNode: node });
    const modulator = canvasCreateModulatorNode(modulatorType, { x: modulatorPoint.x, y: modulatorPoint.y });
    if (modulator?.routes?.length && node.type !== "modulator") {
      const preferredTarget = modulationTargetsForNode(node).find((item) => {
        if (modulator.modulatorType === "prompt_morph" || modulator.modulatorType === "prompt_modulator") return item.path === "prompt";
        if (modulator.modulatorType === "spectral_follower") return item.path === GENERATION_DESTINATIONS.brightnessLanguage.path;
        if (modulator.modulatorType === "random_walk_modulator") return item.path === GENERATION_DESTINATIONS.seedDrift.path;
        if (modulator.modulatorType === "mutation_modulator") return item.path === GENERATION_DESTINATIONS.mutation.path;
        return modulatorAcceptsTarget(modulator, item);
      }) || modulationTargetsForNode(node).find((item) => modulatorAcceptsTarget(modulator, item));
      if (preferredTarget) {
        const route = modulationDefaultRoute(modulator.modulatorType, preferredTarget.nodeId);
        modulator.routes[0] = {
          ...route,
          targetNodeId: preferredTarget.nodeId,
          targetPath: preferredTarget.path,
          config: {
            ...(route.config || {}),
            ...modulationDefaultRangeFor(modulator.modulatorType, preferredTarget),
          },
        };
      }
      canvasSaveState();
      renderCanvas();
    }
  } else if (kind === "genetic") {
    const geneticType = value || "identity_extractor";
    const geneticSize = canvasGeneticNodeSize(geneticType);
    const geneticPoint = canvasFindOpenPoint(point, geneticSize, { anchorNode: node });
    const sourceNode = ["sound", "prompt", "image", "genetic"].includes(node.type) ? node : null;
    const genetic = canvasCreateGeneticNode(geneticType, {
      x: geneticPoint.x,
      y: geneticPoint.y,
      trait: button.dataset.trait || "timbre",
      sourceNode,
    });
    if (node.type === "genetic" && genetic?.geneticType === "generation_sequencer") {
      canvasRouteGeneticNodeToTarget(node, genetic);
      selectedCanvasNodeId = genetic.id;
    }
  } else if (kind === "generate" && node.type === "prompt") {
    await runCanvasGenerate(node.id);
  } else if (kind === "op" && target) {
    selectedCanvasNodeId = target.id;
    await runCanvasOperation(value || "continue");
  } else if (kind === "modulator-route" && node.type === "modulator") {
    const normalized = normalizeModulatorNode(node);
    normalized.routes = [...(normalized.routes || []), modulationDefaultRoute(normalized.modulatorType, selectedCanvasNodeId)];
    canvasNodes[canvasNodes.findIndex((item) => item.id === node.id)] = normalized;
    selectedCanvasNodeId = node.id;
    canvasSaveState();
    renderCanvas();
  } else if (kind === "genetic-route-selected" && node.type === "genetic") {
    canvasRouteGeneticNodeToTarget(node);
  } else if (kind === "connect-input" && canvasConnectionDraft?.nodeId) {
    const source = canvasNodes.find((item) => item.id === canvasConnectionDraft.nodeId);
    const sourceSound = canvasConnectSoundTarget(source);
    if (node.type === "fx" && sourceSound) {
      node.targetNodeId = sourceSound.id;
      if (!canvasEdges.some((edge) => edge.fromNodeId === sourceSound.id && edge.toNodeId === node.id)) {
        canvasEdges.push({ id: canvasId("edge"), projectId: activeCulture.id, fromNodeId: sourceSound.id, toNodeId: node.id, type: "fx", metadata: { fxType: node.fxType } });
      }
      applyFxNodeToTarget(node);
      selectedCanvasNodeId = node.id;
      canvasSaveState();
      renderCanvas();
    }
    if (node.type === "genetic" && source) {
      const edgeType = source.type === "genetic" ? "genetic_identity" : "genetic_source";
      node.sourceNodeId = source.id;
      if (edgeType === "genetic_identity" && source.geneticType === "identity_extractor" && node.geneticType === "generation_sequencer") {
        source.targetNodeId = node.id;
      }
      if (!canvasEdges.some((edge) => edge.fromNodeId === source.id && edge.toNodeId === node.id && edge.type === edgeType)) {
        canvasEdges.push({
          id: canvasId("edge"),
          projectId: activeCulture.id,
          fromNodeId: source.id,
          toNodeId: node.id,
          type: edgeType,
          metadata: source.type === "genetic"
            ? { identity: source.identity || canvasBuildIdentityPayload(source) }
            : { geneticType: node.geneticType, trait: node.trait || null },
        });
      }
      selectedCanvasNodeId = node.id;
      canvasSaveState();
      renderCanvas();
    }
  }
  closeCanvasConnectMenu();
}

function canvasSourcePosition(offset = {}) {
  const base = canvasPendingSourcePosition || canvasBoardDefaultPoint();
  return {
    x: Math.max(8, base.x + (offset.x || 0)),
    y: Math.max(8, base.y + (offset.y || 0)),
  };
}

function canvasSetZoom(nextZoom, focus = null) {
  if (canvasZoomLocked) return;
  const board = $("canvasBoard");
  const previous = canvasZoom;
  canvasZoom = Math.min(2.5, Math.max(0.3, Number(nextZoom) || 1));
  if (board && focus) {
    const rect = board.getBoundingClientRect();
    const focusX = focus.clientX - rect.left;
    const focusY = focus.clientY - rect.top;
    const worldX = (board.scrollLeft + focusX) / previous;
    const worldY = (board.scrollTop + focusY) / previous;
    board.scrollLeft = worldX * canvasZoom - focusX;
    board.scrollTop = worldY * canvasZoom - focusY;
  }
  applyCanvasViewport();
  requestAnimationFrame(() => drawCanvasWaveforms());
}

function canvasResetView() {
  const board = $("canvasBoard");
  const space = $("canvasSpace");
  canvasZoom = 1;
  applyCanvasViewport();
  if (board) {
    const bounds = canvasNodes.length
      ? canvasNodes.reduce((box, node) => ({
          minX: Math.min(box.minX, node.x),
          minY: Math.min(box.minY, node.y),
          maxX: Math.max(box.maxX, node.x + node.width),
          maxY: Math.max(box.maxY, node.y + node.height),
        }), { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity })
      : null;
    const centerX = bounds ? (bounds.minX + bounds.maxX) / 2 : (space?.offsetWidth || 1800) / 2;
    const centerY = bounds ? (bounds.minY + bounds.maxY) / 2 : (space?.offsetHeight || 1200) / 2;
    board.scrollLeft = Math.max(0, centerX - board.clientWidth / 2);
    board.scrollTop = Math.max(0, centerY - board.clientHeight / 2);
  }
  requestAnimationFrame(() => drawCanvasWaveforms());
  setState("View Reset", "ok", "Zoom restored to 100% and graph centered.");
}

function canvasSetPointerCapture(element, pointerId) {
  try {
    element?.setPointerCapture?.(pointerId);
  } catch {}
}

function canvasReleasePointerCapture(element, pointerId) {
  try {
    element?.releasePointerCapture?.(pointerId);
  } catch {}
}

function applyCanvasViewport() {
  const space = $("canvasSpace");
  const board = $("canvasBoard");
  if (space) space.style.transform = `scale(${canvasZoom})`;
  if (board) board.style.setProperty("--canvas-zoom-label", `"${Math.round(canvasZoom * 100)}%"`);
  if ($("canvasZoomReadout")) $("canvasZoomReadout").textContent = `${Math.round(canvasZoom * 100)}%`;
}

function canvasIsLegacyStarterNode(node) {
  return Boolean(
    node?.type === "prompt"
    && (node.prompt === canvasLegacyStarterPrompt || !node.prompt)
    && (node.negativePrompt === canvasLegacyStarterNegative || !node.negativePrompt)
    && !canvasAssets.length
    && !canvasEdges.length,
  );
}

function canvasCreatePromptNode({ text = "", negative = "", x = 80, y = 88, handoff = null, relisten = null } = {}) {
  pushUndo();
  const node = {
    id: canvasId("node"),
    projectId: activeCulture.id,
    type: "prompt",
    x,
    y,
    width: 332,
    height: 410,
    label: "Prompt source",
    prompt: text,
    negativePrompt: negative,
    promptStack: canvasNormalizePromptStack({}),
    activePanel: "main",
    durationSec: 4,
    batchSize: 1,
    seed: -1,
    mutation: 0.5,
    selectedRegionIds: [],
    akousmaHandoff: handoff && typeof handoff === "object" ? handoff : null,
    oidaRelisten: relisten && typeof relisten === "object" ? relisten : null,
  };
  canvasNodes.push(node);
  selectedCanvasNodeId = node.id;
  renderCanvas();
  return node;
}

function consumeAkousmaPromptHandoff() {
  const storageKey = "germ.akousma.prompt-handoff";
  const raw = localStorage.getItem(storageKey);
  const legacyPrompt = localStorage.getItem("germ.akousma.prompt");
  if (!raw && !legacyPrompt) return false;
  let handoff;
  try {
    handoff = raw
      ? JSON.parse(raw)
      : {
          contract: "oida-germ.prompt/v0.1",
          editable: true,
          prompt: legacyPrompt || "",
          base_prompt: legacyPrompt || "",
          negative_prompt: "",
          source: { kind: "akousma-legacy-handoff" },
          parent_akousma_ids: [],
          remember_to_akousmata: false,
        };
  } catch {
    localStorage.removeItem(storageKey);
    setState("Prompt Handoff", "bad", "The saved Akousma prompt handoff was invalid JSON.");
    return false;
  }
  localStorage.removeItem(storageKey);
  localStorage.removeItem("germ.akousma.prompt");
  if (!handoff || typeof handoff !== "object" || typeof handoff.prompt !== "string") {
    setState("Prompt Handoff", "bad", "The Akousma handoff did not contain an editable prompt.");
    return false;
  }
  activeAkousmaPromptHandoff = handoff;
  const prompt = handoff.prompt;
  const negative = typeof handoff.negative_prompt === "string" ? handoff.negative_prompt : "";
  if ($("prompt")) $("prompt").value = prompt;
  if ($("negativePrompt")) $("negativePrompt").value = negative;
  if ($("listenerPrompt")) $("listenerPrompt").value = prompt;
  if ($("listenerNegative")) $("listenerNegative").value = negative;
  const point = canvasBoardDefaultPoint();
  const node = canvasCreatePromptNode({
    text: prompt,
    negative,
    x: point.x,
    y: point.y,
    handoff,
  });
  node.label = "Oída listening prompt";
  canvasSaveState();
  renderCanvas();
  const akousmaId = handoff.source?.akousma_id || "Akousma";
  setState("Prompt Received", "ok", `${akousmaId} · editable and lineage-aware`);
  return true;
}

function canvasCreateImageNode({ file = null, dataUrl = "", mode = "vision", x = 92, y = 96 } = {}) {
  pushUndo();
  const node = {
    id: canvasId("node"),
    projectId: activeCulture.id,
    type: "image",
    x,
    y,
    width: 332,
    height: 338,
    label: file?.name || (mode === "spectrogram" ? "Spectrogram image" : "Image source"),
    imageName: file?.name || "",
    imageType: file?.type || "image/png",
    imageDataUrl: dataUrl,
    imageMode: mode === "spectrogram" ? "spectrogram" : "vision",
    interpretationMode: "cinematic",
    durationSec: 6,
    imagePrompt: "",
    selectedRegionIds: [],
  };
  canvasNodes.push(node);
  selectedCanvasNodeId = node.id;
  renderCanvas();
  return node;
}

function canvasCreateSoundNode({ asset, label = "", x = 210, y = 124, width = 352, parentNodeId = null, edgeType = "lineage", region = null } = {}) {
  pushUndo();
  if (!asset) return null;
  const node = {
    id: canvasId("node"),
    projectId: activeCulture.id,
    assetId: asset.id,
    type: "sound",
    x,
    y,
    width,
    height: 262,
    label: label || displayNameFromPath(asset.audioPath || asset.storageUri),
    selectedRegionIds: [],
    regions: region ? [{ ...region, id: canvasId("region") }] : [],
    futureDuration: asset.durationSec || null,
    versions: [asset.id],
    loop: false,
    playbackRate: 1,
  };
  canvasNodes.push(node);
  if (parentNodeId) {
    canvasEdges.push({
      id: canvasId("edge"),
      projectId: activeCulture.id,
      fromNodeId: parentNodeId,
      toNodeId: node.id,
      type: edgeType,
      metadata: region ? { region } : {},
    });
  }
  selectedCanvasNodeId = node.id;
  canvasLastSelectedSoundNodeId = node.id;
  renderCanvas();
  return node;
}

function canvasCreateRecordNode({ x = 80, y = 88 } = {}) {
  pushUndo();
  const node = {
    id: canvasId("node"),
    projectId: activeCulture.id,
    type: "record",
    x,
    y,
    width: 300,
    height: 194,
    label: "Hardware input",
    selectedRegionIds: [],
    recording: false,
    recordedChunks: [],
  };
  canvasNodes.push(node);
  selectedCanvasNodeId = node.id;
  renderCanvas();
  return node;
}

function canvasCreateAudioSnapshotNode({ x = 80, y = 88 } = {}) {
  pushUndo();
  const node = {
    id: canvasId("node"),
    projectId: activeCulture.id,
    type: "audio_snapshot",
    x,
    y,
    width: 348,
    height: 246,
    label: "Audio Snapshot",
    selectedRegionIds: [],
    captureSeconds: 10,
    autoTrim: true,
    trimStartSec: 0,
    trimEndSec: 0,
    recording: false,
    recordedChunks: [],
    status: "Ready",
    detail: "Capture system, tab, or window audio.",
  };
  canvasNodes.push(node);
  selectedCanvasNodeId = node.id;
  renderCanvas();
  return node;
}

function normalizeGermNode(node = {}) {
  const normalized = {
    id: node.id || canvasId("node"),
    projectId: node.projectId || activeCulture.id,
    type: "germ",
    x: Number(node.x) || 80,
    y: Number(node.y) || 88,
    width: Number(node.width) || 384,
    height: Number(node.height) || 440,
    label: node.label || "Germ",
    activePanel: node.activePanel || "germinate",
    prompt: node.prompt || "glassy metallic vowel",
    negativePrompt: node.negativePrompt || "",
    provider: node.provider || "",
    model: node.model || "",
    durationSec: Number(node.durationSec) || 2,
    rootNote: node.rootNote || "C3",
    note: node.note || "C3",
    generationMode: node.generationMode || "glassy_metallic",
    extractionMode: node.extractionMode || "simple",
    frameCount: Number(node.frameCount) || 64,
    frameSize: Number(node.frameSize) || 2048,
    wavetableId: node.wavetableId || "",
    tablePosition: Number(node.tablePosition) || 0,
    scanSpeed: Number(node.scanSpeed) || 0,
    pitch: Number(node.pitch) || 0,
    fineTune: Number(node.fineTune) || 0,
    unisonDetune: Number(node.unisonDetune) || 0,
    ampAttack: Number(node.ampAttack) || 0.01,
    ampDecay: Number(node.ampDecay) || 0.12,
    ampSustain: Number.isFinite(Number(node.ampSustain)) ? Number(node.ampSustain) : 0.8,
    ampRelease: Number(node.ampRelease) || 0.18,
    filterCutoff: Number(node.filterCutoff) || 8000,
    filterResonance: Number(node.filterResonance) || 0.7,
    filterEnvAmount: Number(node.filterEnvAmount) || 0,
    wavetableIndex: Number(node.wavetableIndex) || 0,
    gain: Number(node.gain) || 0.7,
    mutationPrompt: node.mutationPrompt || "more brittle glass harmonics",
    mutationDepth: Number(node.mutationDepth) || 0.42,
    variationCount: Number(node.variationCount) || 1,
  };
  normalized.tablePosition = Math.max(0, Math.min(1, normalized.tablePosition));
  normalized.variationCount = Math.max(1, Math.min(16, Math.round(normalized.variationCount)));
  return normalized;
}

function normalizeWavetableForgeNode(node = {}) {
  return {
    id: node.id || canvasId("node"),
    projectId: node.projectId || activeCulture.id,
    type: "wavetable_forge",
    x: Number(node.x) || 92,
    y: Number(node.y) || 96,
    width: Number(node.width) || 392,
    height: Number(node.height) || 450,
    label: node.label || "Wavetable Forge",
    activePanel: node.activePanel || "generate",
    prompt: node.prompt || "single glass oscillator",
    negativePrompt: node.negativePrompt || "",
    durationSec: Number(node.durationSec) || 2,
    rootNote: node.rootNote || "C3",
    generationMode: node.generationMode || "single_cycle_tone",
    extractionMode: node.extractionMode || "simple",
    frameCount: Number(node.frameCount) || 64,
    frameSize: Number(node.frameSize) || 2048,
    wavetableId: node.wavetableId || "",
    selectedAudioPath: node.selectedAudioPath || "",
    mutationPrompt: node.mutationPrompt || "more harmonic motion",
    mutationDepth: Number(node.mutationDepth) || 0.42,
    variationCount: Number(node.variationCount) || 1,
    exportFormat: node.exportFormat || "gwt",
  };
}

function canvasCreateGermNode({ x = 80, y = 88 } = {}) {
  pushUndo();
  const node = normalizeGermNode({ x, y });
  canvasNodes.push(node);
  selectedCanvasNodeId = node.id;
  renderCanvas();
  return node;
}

function canvasCreateWavetableForgeNode({ x = 92, y = 96 } = {}) {
  pushUndo();
  const node = normalizeWavetableForgeNode({ x, y });
  canvasNodes.push(node);
  selectedCanvasNodeId = node.id;
  renderCanvas();
  return node;
}

function wavetableModeOptions(selected) {
  const modes = {
    single_cycle_tone: "Single cycle tone",
    evolving_timbre: "Evolving timbre",
    bass_oscillator: "Bass oscillator",
    glassy_metallic: "Glassy metallic",
    soft_pad_source: "Soft pad source",
    formant_no_voice: "Formant no voice",
    noisy_oscillator: "Noisy oscillator",
    organic_reed: "Organic reed",
  };
  return Object.entries(modes)
    .map(([value, label]) => `<option value="${escapeHtml(value)}"${selected === value ? " selected" : ""}>${escapeHtml(label)}</option>`)
    .join("");
}

function wavetableAudioOptions(selected = "") {
  const items = libraryItems.filter((item) => item.audio_file && item.audio_exists !== false).slice(0, 200);
  if (!items.length) return '<option value="">No audio sources</option>';
  return items.map((item) => `<option value="${escapeHtml(item.audio_file)}"${item.audio_file === selected ? " selected" : ""}>${escapeHtml(displayNameFromPath(item.audio_file))}</option>`).join("");
}

function wavetableNodeTabs(node, tabs) {
  return `<div class="canvas-node-tabs">${tabs.map(([id, label]) => `
    <button class="canvas-node-tab${node.activePanel === id ? " active" : ""}" type="button" data-action="wavetable-node-tab" data-node-id="${escapeHtml(node.id)}" data-tab="${escapeHtml(id)}">${escapeHtml(label)}</button>
  `).join("")}</div>`;
}

function canvasGermNodeMarkup(node, selected, style) {
  node = normalizeGermNode(node);
  const table = wavetableById(node.wavetableId) || wavetableItems[0] || null;
  const selectedId = node.wavetableId || table?.id || "";
  const active = node.activePanel || "germinate";
  return `
    <article class="canvas-node time-node germ-node${selected}" data-node-id="${escapeHtml(node.id)}" style="${style}" data-help="Prompt-grown wavetable organism.">
      ${canvasIoPortsMarkup(node.id, { output: true })}
      <div class="time-head">
        <div>
          <span>Prompt-grown wavetable organism</span>
          <strong>Germ</strong>
          <small>${escapeHtml(table?.name || "No wavetable")} | ${escapeHtml(node.rootNote)} | ${Math.round(node.tablePosition * 100)}%</small>
        </div>
        <div class="time-node-actions">
          <button class="time-action" type="button" data-action="wavetable-preview" data-node-id="${escapeHtml(node.id)}">Play</button>
          <button class="time-action" type="button" data-action="wavetable-hold" data-node-id="${escapeHtml(node.id)}">Hold</button>
          <button class="time-action primary" type="button" data-action="wavetable-render-source" data-node-id="${escapeHtml(node.id)}">Render</button>
          <button class="prompt-node-icon delete" type="button" data-action="canvas-delete-node" data-node-id="${escapeHtml(node.id)}" title="Delete" aria-label="Delete"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M18 6 6 18"/><path d="M6 6l12 12"/></svg></button>
        </div>
      </div>
      <div class="time-node-body">
        <canvas class="wavetable-mini-scope" data-node-id="${escapeHtml(node.id)}" width="280" height="54"></canvas>
        ${wavetableNodeTabs(node, [["germinate", "Germinate"], ["table", "Table"], ["synth", "Synth"]])}
        ${active === "germinate" ? `
          <label class="canvas-prompt-label">Prompt
            <textarea class="wavetable-node-text" data-node-id="${escapeHtml(node.id)}" data-field="prompt" rows="3">${escapeHtml(node.prompt)}</textarea>
          </label>
          <label class="canvas-prompt-label">Avoid
            <textarea class="wavetable-node-text" data-node-id="${escapeHtml(node.id)}" data-field="negativePrompt" rows="2">${escapeHtml(node.negativePrompt)}</textarea>
          </label>
          <div class="time-control-row">
            <label>Mode <select class="wavetable-node-setting" data-node-id="${escapeHtml(node.id)}" data-field="generationMode">${wavetableModeOptions(node.generationMode)}</select></label>
            <label>Len <input class="wavetable-node-setting" data-node-id="${escapeHtml(node.id)}" data-field="durationSec" type="number" min="1" max="8" step="0.5" value="${escapeHtml(node.durationSec)}" /></label>
            <label>Frames <input class="wavetable-node-setting" data-node-id="${escapeHtml(node.id)}" data-field="frameCount" type="number" min="1" max="512" step="1" value="${escapeHtml(node.frameCount)}" /></label>
            <label>Size <select class="wavetable-node-setting" data-node-id="${escapeHtml(node.id)}" data-field="frameSize"><option${node.frameSize === 512 ? " selected" : ""}>512</option><option${node.frameSize === 1024 ? " selected" : ""}>1024</option><option${node.frameSize === 2048 ? " selected" : ""}>2048</option><option${node.frameSize === 4096 ? " selected" : ""}>4096</option></select></label>
          </div>
          <div class="time-node-actions">
            <button class="time-action" type="button" data-action="wavetable-generate-audio" data-node-id="${escapeHtml(node.id)}">Generate Audio</button>
            <button class="time-action primary" type="button" data-action="wavetable-prompt" data-node-id="${escapeHtml(node.id)}">Generate + Convert</button>
          </div>
        ` : ""}
        ${active === "table" ? `
          <div class="time-control-row">
            <label>Table <select class="wavetable-node-setting" data-node-id="${escapeHtml(node.id)}" data-field="wavetableId">${renderGermWavetableOptions(selectedId)}</select></label>
            <label>Scan <input class="wavetable-node-setting" data-node-id="${escapeHtml(node.id)}" data-field="tablePosition" type="range" min="0" max="1" step="0.01" value="${escapeHtml(node.tablePosition)}" /></label>
          </div>
          <canvas class="wavetable-frame-strip" data-node-id="${escapeHtml(node.id)}" width="280" height="42"></canvas>
          <div class="time-node-actions">
            <button class="time-action" type="button" data-action="wavetable-mutate" data-node-id="${escapeHtml(node.id)}">Mutate</button>
            <a class="time-action" href="${escapeHtml(wavetableExportUrl(selectedId))}">Export</a>
          </div>
        ` : ""}
        ${active === "synth" ? `
          <div class="time-control-row">
            <label>Table <select class="wavetable-node-setting" data-node-id="${escapeHtml(node.id)}" data-field="wavetableId">${renderGermWavetableOptions(selectedId)}</select></label>
            <label>Root <input class="wavetable-node-setting" data-node-id="${escapeHtml(node.id)}" data-field="rootNote" value="${escapeHtml(node.rootNote)}" /></label>
            <label>Note <input class="wavetable-node-setting" data-node-id="${escapeHtml(node.id)}" data-field="note" value="${escapeHtml(node.note)}" /></label>
            <label>Gain <input class="wavetable-node-setting" data-node-id="${escapeHtml(node.id)}" data-field="gain" type="range" min="0" max="1" step="0.01" value="${escapeHtml(node.gain)}" /></label>
          </div>
          <div class="time-node-actions">
            <button class="time-action" type="button" data-action="wavetable-preview" data-node-id="${escapeHtml(node.id)}">Preview</button>
            <button class="time-action" type="button" data-action="wavetable-stop" data-node-id="${escapeHtml(node.id)}">Stop</button>
            <button class="time-action primary" type="button" data-action="wavetable-render-source" data-node-id="${escapeHtml(node.id)}">Render as Source</button>
          </div>
        ` : ""}
      </div>
    </article>
  `;
}

function canvasWavetableForgeNodeMarkup(node, selected, style) {
  node = normalizeWavetableForgeNode(node);
  const selectedId = node.wavetableId || wavetableItems[0]?.id || "";
  const active = node.activePanel || "generate";
  return `
    <article class="canvas-node time-node wavetable-forge-node${selected}" data-node-id="${escapeHtml(node.id)}" style="${style}" data-help="Convert, mutate, render, import, export wavetables.">
      <div class="time-head">
        <div>
          <span>Utility / FX tools</span>
          <strong>Wavetable Forge</strong>
          <small>${escapeHtml(wavetableById(selectedId)?.name || "No table selected")}</small>
        </div>
        <div class="time-node-actions">
          <button class="time-action" type="button" data-action="refresh-wavetables">Refresh</button>
          <button class="prompt-node-icon delete" type="button" data-action="canvas-delete-node" data-node-id="${escapeHtml(node.id)}" title="Delete" aria-label="Delete"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M18 6 6 18"/><path d="M6 6l12 12"/></svg></button>
        </div>
      </div>
      <div class="time-node-body">
        ${wavetableNodeTabs(node, [["generate", "Generate"], ["convert", "Convert"], ["mutate", "Mutate"], ["export", "Export"]])}
        ${active === "generate" ? `
          <label class="canvas-prompt-label">Prompt <textarea class="wavetable-node-text" data-node-id="${escapeHtml(node.id)}" data-field="prompt" rows="3">${escapeHtml(node.prompt)}</textarea></label>
          <div class="time-control-row">
            <label>Mode <select class="wavetable-node-setting" data-node-id="${escapeHtml(node.id)}" data-field="generationMode">${wavetableModeOptions(node.generationMode)}</select></label>
            <label>Len <input class="wavetable-node-setting" data-node-id="${escapeHtml(node.id)}" data-field="durationSec" type="number" min="1" max="8" step="0.5" value="${escapeHtml(node.durationSec)}" /></label>
            <label>Frames <input class="wavetable-node-setting" data-node-id="${escapeHtml(node.id)}" data-field="frameCount" type="number" min="1" max="512" step="1" value="${escapeHtml(node.frameCount)}" /></label>
          </div>
          <button class="time-action primary" type="button" data-action="forge-generate-table" data-node-id="${escapeHtml(node.id)}">Generate Table</button>
        ` : ""}
        ${active === "convert" ? `
          <div class="time-control-row">
            <label>Audio <select class="wavetable-node-setting" data-node-id="${escapeHtml(node.id)}" data-field="selectedAudioPath">${wavetableAudioOptions(node.selectedAudioPath)}</select></label>
            <label>Size <select class="wavetable-node-setting" data-node-id="${escapeHtml(node.id)}" data-field="frameSize"><option${node.frameSize === 512 ? " selected" : ""}>512</option><option${node.frameSize === 1024 ? " selected" : ""}>1024</option><option${node.frameSize === 2048 ? " selected" : ""}>2048</option><option${node.frameSize === 4096 ? " selected" : ""}>4096</option></select></label>
          </div>
          <button class="time-action primary" type="button" data-action="forge-convert-audio" data-node-id="${escapeHtml(node.id)}">Convert Selected Audio</button>
        ` : ""}
        ${active === "mutate" ? `
          <div class="time-control-row">
            <label>Table <select class="wavetable-node-setting" data-node-id="${escapeHtml(node.id)}" data-field="wavetableId">${renderGermWavetableOptions(selectedId)}</select></label>
            <label>Depth <input class="wavetable-node-setting" data-node-id="${escapeHtml(node.id)}" data-field="mutationDepth" type="range" min="0" max="1" step="0.01" value="${escapeHtml(node.mutationDepth)}" /></label>
            <label>Vars <input class="wavetable-node-setting" data-node-id="${escapeHtml(node.id)}" data-field="variationCount" type="number" min="1" max="16" step="1" value="${escapeHtml(node.variationCount)}" /></label>
          </div>
          <textarea class="wavetable-node-text" data-node-id="${escapeHtml(node.id)}" data-field="mutationPrompt" rows="2">${escapeHtml(node.mutationPrompt)}</textarea>
          <button class="time-action primary" type="button" data-action="forge-mutate-table" data-node-id="${escapeHtml(node.id)}">Mutate</button>
        ` : ""}
        ${active === "export" ? `
          <div class="time-control-row">
            <label>Table <select class="wavetable-node-setting" data-node-id="${escapeHtml(node.id)}" data-field="wavetableId">${renderGermWavetableOptions(selectedId)}</select></label>
            <label>Format <select class="wavetable-node-setting" data-node-id="${escapeHtml(node.id)}" data-field="exportFormat"><option value="gwt"${node.exportFormat === "gwt" ? " selected" : ""}>gwt</option><option value="wav-stack"${node.exportFormat === "wav-stack" ? " selected" : ""}>wav-stack</option><option value="single-cycle"${node.exportFormat === "single-cycle" ? " selected" : ""}>single-cycle</option><option value="metadata"${node.exportFormat === "metadata" ? " selected" : ""}>metadata</option></select></label>
          </div>
          <a class="time-action primary" href="${escapeHtml(wavetableExportUrl(selectedId, node.exportFormat))}">Export</a>
        ` : ""}
      </div>
    </article>
  `;
}

function geneticModuleLabel(geneticType) {
  return {
    identity_extractor: "Identity Extractor",
    generation_sequencer: "Generation Sequencer",
  }[geneticType] || "Genetic Module";
}

function normalizeGeneticType(geneticType) {
  return GENETIC_MODULE_TYPES.has(geneticType) ? geneticType : "identity_extractor";
}

function normalizeGeneticTrait(trait) {
  return Object.prototype.hasOwnProperty.call(GENETIC_IDENTITY_TRAITS, trait) ? trait : "timbre";
}

function canvasDefaultGeneticSteps() {
  return GENETIC_DEFAULT_SEQUENCE.map((step, index) => ({
    id: `genetic_step_${index + 1}`,
    enabled: true,
    action: step.action,
    probability: step.probability,
  }));
}

function canvasGeneticNodeSize(geneticType = "identity_extractor") {
  return normalizeGeneticType(geneticType) === "generation_sequencer"
    ? { width: 520, height: 398 }
    : { width: 430, height: 314 };
}

function normalizeGeneticNode(node) {
  if (!node || node.type !== "genetic") return node;
  const normalized = { ...node };
  normalized.geneticType = normalizeGeneticType(normalized.geneticType);
  normalized.label = normalized.label || geneticModuleLabel(normalized.geneticType);
  normalized.strength = Math.min(1, Math.max(0, Number(normalized.strength ?? 0.72)));
  normalized.confidence = Math.min(1, Math.max(0, Number(normalized.confidence ?? 0)));
  normalized.sourceNodeId = normalized.sourceNodeId || "";
  normalized.targetNodeId = normalized.targetNodeId || "";
  normalized.selectedStep = Math.min(7, Math.max(0, Math.round(Number(normalized.selectedStep) || 0)));
  if (normalized.geneticType === "identity_extractor") {
    normalized.trait = normalizeGeneticTrait(normalized.trait);
    normalized.locked = normalized.locked !== false;
    normalized.identity = normalized.identity && typeof normalized.identity === "object" ? normalized.identity : null;
  } else {
    normalized.mode = Object.prototype.hasOwnProperty.call(GENETIC_SEQUENCER_MODES, normalized.mode) ? normalized.mode : "seed_garden";
    const steps = Array.isArray(normalized.steps) ? normalized.steps : [];
    normalized.steps = canvasDefaultGeneticSteps().map((fallback, index) => ({
      ...fallback,
      ...(steps[index] || {}),
      enabled: steps[index]?.enabled !== false,
      action: Object.prototype.hasOwnProperty.call(GENETIC_SEQUENCER_ACTIONS, steps[index]?.action) ? steps[index].action : fallback.action,
      probability: Math.min(1, Math.max(0, Number(steps[index]?.probability ?? fallback.probability))),
    }));
    normalized.identityMode = normalized.identityMode || "incoming";
  }
  return normalized;
}

function canvasCreateGeneticNode(geneticType = "identity_extractor", { x = null, y = null, trait = "timbre", sourceNode = null } = {}) {
  const normalizedType = normalizeGeneticType(geneticType);
  const point = sourceNode ? canvasConnectPointFor(sourceNode) : canvasBoardDefaultPoint();
  const size = canvasGeneticNodeSize(normalizedType);
  const node = normalizeGeneticNode({
    id: canvasId("node"),
    projectId: activeCulture.id,
    type: "genetic",
    geneticType: normalizedType,
    trait: normalizeGeneticTrait(trait),
    x: x ?? point.x,
    y: y ?? point.y,
    width: size.width,
    height: size.height,
    label: geneticModuleLabel(normalizedType),
    sourceNodeId: sourceNode?.id || "",
    selectedRegionIds: [],
  });
  canvasNodes.push(node);
  if (sourceNode) {
    const edgeType = sourceNode.type === "genetic" ? "genetic_identity" : "genetic_source";
    canvasEdges.push({
      id: canvasId("edge"),
      projectId: activeCulture.id,
      fromNodeId: sourceNode.id,
      toNodeId: node.id,
      type: edgeType,
      metadata: sourceNode.type === "genetic"
        ? { identity: sourceNode.identity || canvasBuildIdentityPayload(sourceNode) }
        : { geneticType: normalizedType, trait: node.trait || null },
    });
  }
  selectedCanvasNodeId = node.id;
  renderCanvas();
  setState("Genetic Module Added", "ok", node.label);
  return node;
}

function canvasGeneticSourceNode(node) {
  if (!node || node.type !== "genetic") return null;
  const direct = canvasNodes.find((item) => item.id === node.sourceNodeId) || null;
  if (direct) return direct;
  const edge = canvasEdges.find((item) => item.toNodeId === node.id && item.type === "genetic_source");
  return edge ? canvasNodes.find((item) => item.id === edge.fromNodeId) || null : null;
}

function canvasGeneticTargetNode(node) {
  if (!node || node.type !== "genetic") return null;
  const direct = canvasNodes.find((item) => item.id === node.targetNodeId) || null;
  if (direct) return direct;
  const edge = canvasEdges.find((item) => item.fromNodeId === node.id && item.type?.startsWith?.("genetic"));
  return edge ? canvasNodes.find((item) => item.id === edge.toNodeId) || null : null;
}

function canvasGeneticSourceAsset(node) {
  const source = canvasGeneticSourceNode(node);
  return source?.type === "sound" ? canvasAssetById(source.assetId) : null;
}

function canvasGeneticSourceSummary(node) {
  const source = canvasGeneticSourceNode(node);
  if (!source) return "No source";
  if (source.type === "sound") {
    const asset = canvasAssetById(source.assetId);
    return source.label || displayNameFromPath(asset?.audioPath || "");
  }
  return source.label || source.type;
}

function canvasIdentityPromptText(node, source, asset) {
  const trait = normalizeGeneticTrait(node.trait);
  const config = GENETIC_IDENTITY_TRAITS[trait];
  const metadata = asset?.metadata || {};
  const sourcePrompt = metadata.prompt || source?.prompt || "";
  const words = config.words.join(", ");
  if (trait === "prompt") return [sourcePrompt, words].filter(Boolean).join(", ");
  if (trait === "latent") return `latent identity from ${source?.label || "source"}, ${words}`;
  return `${config.label.toLowerCase()}, ${words}${sourcePrompt ? `, derived from ${sourcePrompt}` : ""}`;
}

function canvasBuildIdentityPayload(node) {
  const normalized = normalizeGeneticNode(node);
  if (!normalized || normalized.type !== "genetic" || normalized.geneticType !== "identity_extractor") return null;
  const source = canvasGeneticSourceNode(normalized);
  const asset = canvasGeneticSourceAsset(normalized);
  const trait = normalizeGeneticTrait(normalized.trait);
  const config = GENETIC_IDENTITY_TRAITS[trait];
  const audioPath = asset?.audioPath || asset?.storageUri || "";
  const regions = source?.type === "sound" ? canvasRegionRolesPayload(source) : [];
  const seedText = `${normalized.id}:${trait}:${audioPath}:${source?.id || ""}:${regions.length}`;
  const confidence = Number((0.58 + deterministicUnit(seedText) * 0.37).toFixed(3));
  return {
    id: normalized.identity?.id || canvasId("identity"),
    module_id: normalized.id,
    trait,
    label: config.label,
    use: config.use,
    destination: config.destination,
    strength: Number(Number(normalized.strength ?? 0.72).toFixed(3)),
    confidence,
    source_node_id: source?.id || null,
    source_type: source?.type || null,
    source_audio_path: audioPath || null,
    source_metadata_path: asset?.metadataPath || asset?.metadata?.metadata_path || null,
    prompt_identity: canvasIdentityPromptText(normalized, source, asset),
    lexical_dna: config.words,
    region_roles: regions,
    latent_identity: trait === "latent" ? {
      status: "deferred",
      encoder: "SAME",
      source_audio_path: audioPath || null,
    } : null,
    created_at: new Date().toISOString(),
  };
}

function canvasIncomingGeneticNodes(targetNode) {
  if (!targetNode) return [];
  return canvasEdges
    .filter((edge) => edge.toNodeId === targetNode.id && edge.type?.startsWith?.("genetic"))
    .map((edge) => canvasNodes.find((node) => node.id === edge.fromNodeId))
    .filter((node) => node?.type === "genetic")
    .map(normalizeGeneticNode);
}

function canvasGeneticPayloadForTarget(targetNode) {
  const geneticNodes = canvasIncomingGeneticNodes(targetNode);
  const directIdentities = geneticNodes
    .filter((node) => node.geneticType === "identity_extractor")
    .map((node) => node.identity || canvasBuildIdentityPayload(node))
    .filter(Boolean);
  const sequencers = geneticNodes
    .filter((node) => node.geneticType === "generation_sequencer")
    .map((node) => canvasGenerationSequencePayload(node))
    .filter(Boolean);
  const identitiesById = new Map();
  [...directIdentities, ...sequencers.flatMap((sequence) => sequence.identities || [])].forEach((identity) => {
    identitiesById.set(identity.id || `${identity.module_id}:${identity.trait}`, identity);
  });
  return {
    genetic_identities: Array.from(identitiesById.values()),
    generation_sequences: sequencers,
  };
}

function canvasGenerationSequencePayload(node) {
  const normalized = normalizeGeneticNode(node);
  if (!normalized || normalized.type !== "genetic" || normalized.geneticType !== "generation_sequencer") return null;
  const source = canvasGeneticSourceNode(normalized);
  const target = canvasGeneticTargetNode(normalized);
  const incomingIdentities = canvasIncomingGeneticNodes(normalized)
    .filter((node) => node.geneticType === "identity_extractor")
    .map((node) => node.identity || canvasBuildIdentityPayload(node))
    .filter(Boolean);
  return {
    id: normalized.sequenceId || normalized.id,
    module_id: normalized.id,
    mode: normalized.mode,
    mode_label: GENETIC_SEQUENCER_MODES[normalized.mode] || "Seed Garden",
    source_node_id: source?.id || null,
    target_node_id: target?.id || null,
    identity_mode: normalized.identityMode || "incoming",
    identities: incomingIdentities,
    steps: (normalized.steps || []).map((step, index) => ({
      index: index + 1,
      enabled: step.enabled !== false,
      action: step.action,
      label: GENETIC_SEQUENCER_ACTIONS[step.action] || step.action,
      probability: Number(Number(step.probability ?? 1).toFixed(3)),
    })),
  };
}

function canvasGeneticRouteTarget(node) {
  const selected = canvasNodes.find((item) => item.id === selectedCanvasNodeId && item.id !== node?.id);
  if (selected && ["sound", "prompt"].includes(selected.type)) return selected;
  return canvasSelectedSoundNode()
    || (canvasLastSelectedSoundNodeId ? canvasNodes.find((item) => item.id === canvasLastSelectedSoundNodeId) : null)
    || canvasNodes.find((item) => item.type === "prompt")
    || null;
}

function canvasRouteGeneticNodeToTarget(node, target = null) {
  if (!node || node.type !== "genetic") return null;
  const routeTarget = target || canvasGeneticRouteTarget(node);
  if (!routeTarget || routeTarget.id === node.id) throw new Error("Select a prompt, sound, or genetic target first.");
  node.targetNodeId = routeTarget.id;
  const routeType = node.geneticType === "generation_sequencer" ? "genetic_sequence" : "genetic_identity";
  if (!canvasEdges.some((edge) => edge.fromNodeId === node.id && edge.toNodeId === routeTarget.id && edge.type === routeType)) {
    canvasEdges.push({
      id: canvasId("edge"),
      projectId: activeCulture.id,
      fromNodeId: node.id,
      toNodeId: routeTarget.id,
      type: routeType,
      metadata: node.geneticType === "generation_sequencer"
        ? { sequence: canvasGenerationSequencePayload(node) }
        : { identity: node.identity || canvasBuildIdentityPayload(node) },
    });
  }
  selectedCanvasNodeId = routeTarget.id;
  canvasSaveState();
  renderCanvas();
  setState("Genetic Route Added", "ok", `${node.label || geneticModuleLabel(node.geneticType)} -> ${routeTarget.label || routeTarget.type}`);
  return routeTarget;
}

function timeModuleLabel(timeType) {
  return {
    colony_sequencer: "Colony Sequencer",
    trigger_pads: "Trigger Pads",
    slicer: "Slicer",
    melody_maker: "Melody Maker",
    euclidean_colony: "Euclidean Colony",
    clocked_looper: "Clocked Looper",
    probability_gate: "Probability Gate",
    clock_divider: "Clock Divider",
    humanizer: "Humanizer",
    polymeter: "Polymeter",
    incubation_timeline: "Incubation Timeline",
    render_bus: "Render Bus",
    render_macros: "Render Macros",
  }[timeType] || "Time Module";
}

function timeAssetLabel(asset) {
  return asset?.metadata?.prompt
    || asset?.metadata?.source?.label
    || displayNameFromPath(asset?.audioPath || asset?.storageUri || "")
    || "Empty";
}

function canvasDefaultColonyLane(index) {
  const names = ["Kick organism", "Ceramic clicks", "Granular metal", "Soft noise hit"];
  return {
    id: `lane_${index + 1}`,
    label: names[index] || `Lane ${index + 1}`,
    prompt: "",
    assetId: "",
    mute: false,
    solo: false,
    volume: 1,
    pan: 0,
    steps: Array.from({ length: 16 }, () => ({ enabled: false, velocity: 1 })),
  };
}

function canvasDefaultColonyLanes() {
  return Array.from({ length: 4 }, (_, index) => canvasDefaultColonyLane(index));
}

function canvasDefaultPads() {
  return TIME_PAD_KEYS.map((key, index) => ({
    id: `pad_${index + 1}`,
    key,
    label: `Pad ${index + 1}`,
    prompt: "",
    assetId: "",
    volume: 1,
    pan: 0,
    chokeGroup: "",
  }));
}

function canvasDefaultSlicerSlices(count = 16) {
  return Array.from({ length: count }, (_, index) => ({
    id: `slice_${index + 1}`,
    enabled: true,
    velocity: 1,
    reverse: false,
  }));
}

function canvasDefaultMelodySteps() {
  return Array.from({ length: 16 }, (_, index) => ({
    enabled: index % 4 === 0,
    degree: [0, 2, 4, 5][Math.floor(index / 4)] || 0,
    octave: 0,
    velocity: 0.9,
    durationSteps: 1,
  }));
}

function canvasDefaultTimeSource(id = "source_1") {
  return {
    id,
    label: "Source",
    prompt: "",
    assetId: "",
    volume: 1,
    pan: 0,
  };
}

function canvasDefaultIncubationSource(asset = null, index = 0) {
  return {
    id: canvasId("timeline_src"),
    label: asset ? timeAssetLabel(asset) : `Source ${index + 1}`,
    prompt: "",
    assetId: asset?.id || "",
    volume: 1,
    pan: 0,
  };
}

function canvasDefaultIncubationEvent(sourceId = "", index = 0) {
  return {
    id: canvasId("timeline_evt"),
    label: `Event ${index + 1}`,
    sourceId,
    startBeat: index,
    durationBeats: 1,
    gain: 1,
    pan: 0,
    pitchSemitones: 0,
    reverse: false,
    sourceStartSec: null,
    sourceEndSec: null,
  };
}

function normalizeIncubationSource(source = {}, index = 0) {
  const fallback = canvasDefaultIncubationSource(null, index);
  return {
    ...fallback,
    ...source,
    id: source.id || fallback.id,
    label: String(source.label || fallback.label),
    assetId: source.assetId || "",
    volume: Math.min(2, Math.max(0, Number(source.volume ?? fallback.volume))),
    pan: Math.min(1, Math.max(-1, Number(source.pan ?? fallback.pan))),
  };
}

function nullableSeconds(value) {
  if (value === "" || value === null || value === undefined) return null;
  const number = Number(value);
  return Number.isFinite(number) ? Math.max(0, number) : null;
}

function normalizeIncubationEvent(event = {}, index = 0, sourceIds = []) {
  const totalBeats = Math.max(1, timeClockDerived().totalBeats || 16);
  const fallback = canvasDefaultIncubationEvent(sourceIds[0] || "", index);
  const sourceId = sourceIds.includes(event.sourceId) ? event.sourceId : fallback.sourceId;
  return {
    ...fallback,
    ...event,
    id: event.id || fallback.id,
    label: String(event.label || fallback.label),
    sourceId,
    startBeat: Math.min(totalBeats, Math.max(0, Number(event.startBeat ?? fallback.startBeat) || 0)),
    durationBeats: Math.min(totalBeats, Math.max(0.0625, Number(event.durationBeats ?? fallback.durationBeats) || 1)),
    gain: Math.min(2, Math.max(0, Number(event.gain ?? fallback.gain))),
    pan: Math.min(1, Math.max(-1, Number(event.pan ?? fallback.pan))),
    pitchSemitones: Math.min(48, Math.max(-48, Number(event.pitchSemitones ?? fallback.pitchSemitones) || 0)),
    reverse: Boolean(event.reverse),
    sourceStartSec: nullableSeconds(event.sourceStartSec),
    sourceEndSec: nullableSeconds(event.sourceEndSec),
  };
}

function canvasDefaultPolymeterLanes() {
  return [
    { ...canvasDefaultTimeSource("poly_lane_a"), label: "Lane A", steps: 5, pulses: 3, rotation: 0, velocity: 1, prompt: "" },
    { ...canvasDefaultTimeSource("poly_lane_b"), label: "Lane B", steps: 7, pulses: 4, rotation: 1, velocity: 0.9, prompt: "" },
  ];
}

function normalizedTimeType(timeType) {
  return [
    "colony_sequencer",
    "trigger_pads",
    "slicer",
    "melody_maker",
    "euclidean_colony",
    "clocked_looper",
    "probability_gate",
    "clock_divider",
    "humanizer",
    "polymeter",
    "incubation_timeline",
    "render_bus",
    "render_macros",
  ].includes(timeType) ? timeType : "colony_sequencer";
}

function normalizeTimeNode(node) {
  if (!node || node.type !== "time") return node;
  const normalized = { ...node };
  normalized.timeType = normalizedTimeType(normalized.timeType);
  normalized.label = normalized.label || timeModuleLabel(normalized.timeType);
  normalized.clockOverride = normalized.clockOverride || null;
  if (normalized.timeType === "trigger_pads") {
    const pads = Array.isArray(normalized.pads) ? normalized.pads : [];
    normalized.pads = canvasDefaultPads().map((fallback, index) => ({
      ...fallback,
      ...(pads[index] || {}),
      key: TIME_PAD_KEYS[index],
      volume: Math.min(2, Math.max(0, Number(pads[index]?.volume ?? fallback.volume))),
      pan: Math.min(1, Math.max(-1, Number(pads[index]?.pan ?? fallback.pan))),
    }));
    normalized.recording = Boolean(normalized.recording);
    normalized.recordStartMs = normalized.recordStartMs || null;
    normalized.recordedEvents = Array.isArray(normalized.recordedEvents) ? normalized.recordedEvents : [];
  } else if (normalized.timeType === "slicer") {
    const sliceCount = Math.min(64, Math.max(2, Math.round(Number(normalized.sliceCount) || 16)));
    const existingSlices = Array.isArray(normalized.slices) ? normalized.slices : [];
    normalized.source = { ...canvasDefaultTimeSource("slicer_source"), ...(normalized.source || {}) };
    normalized.sliceCount = sliceCount;
    normalized.slices = canvasDefaultSlicerSlices(sliceCount).map((fallback, index) => ({
      ...fallback,
      ...(existingSlices[index] || {}),
      enabled: existingSlices[index]?.enabled !== false,
      velocity: Math.min(2, Math.max(0, Number(existingSlices[index]?.velocity ?? fallback.velocity))),
      reverse: Boolean(existingSlices[index]?.reverse),
    }));
    normalized.selectedSlice = Math.min(sliceCount - 1, Math.max(0, Math.round(Number(normalized.selectedSlice) || 0)));
    normalized.playMode = ["original", "reverse", "skip"].includes(normalized.playMode) ? normalized.playMode : "original";
  } else if (normalized.timeType === "melody_maker") {
    normalized.root = { ...canvasDefaultTimeSource("melody_root"), label: "Root note", ...(normalized.root || {}) };
    normalized.rootNote = /^[A-G]#?\d$/.test(String(normalized.rootNote || "")) ? normalized.rootNote : "C3";
    normalized.scale = Object.prototype.hasOwnProperty.call(TIME_SCALE_INTERVALS, normalized.scale) ? normalized.scale : "minor";
    normalized.steps = canvasDefaultMelodySteps().map((fallback, index) => ({
      ...fallback,
      ...((normalized.steps || [])[index] || {}),
      enabled: Boolean((normalized.steps || [])[index]?.enabled ?? fallback.enabled),
      degree: Math.max(0, Math.round(Number((normalized.steps || [])[index]?.degree ?? fallback.degree))),
      octave: Math.min(3, Math.max(-2, Math.round(Number((normalized.steps || [])[index]?.octave ?? fallback.octave)))),
      velocity: Math.min(2, Math.max(0, Number((normalized.steps || [])[index]?.velocity ?? fallback.velocity))),
      durationSteps: Math.min(4, Math.max(1, Math.round(Number((normalized.steps || [])[index]?.durationSteps ?? fallback.durationSteps)))),
    }));
    normalized.selectedStep = Math.min(15, Math.max(0, Math.round(Number(normalized.selectedStep) || 0)));
  } else if (normalized.timeType === "euclidean_colony") {
    normalized.source = { ...canvasDefaultTimeSource("euclidean_source"), label: "Pulse organism", ...(normalized.source || {}) };
    normalized.prompt = normalized.prompt || "";
    normalized.steps = Math.min(64, Math.max(1, Math.round(Number(normalized.steps) || 16)));
    normalized.pulses = Math.min(normalized.steps, Math.max(0, Math.round(Number(normalized.pulses) || 5)));
    normalized.rotation = Math.max(0, Math.round(Number(normalized.rotation) || 0));
    normalized.probability = Math.min(1, Math.max(0, Number(normalized.probability ?? 1)));
    normalized.velocity = Math.min(2, Math.max(0, Number(normalized.velocity ?? 1)));
  } else if (normalized.timeType === "clocked_looper") {
    normalized.source = { ...canvasDefaultTimeSource("looper_source"), label: "Loop source", ...(normalized.source || {}) };
    normalized.targetBars = Math.min(128, Math.max(1, Math.round(Number(normalized.targetBars) || Math.min(4, timeState.bars || 4))));
    normalized.mode = ["repeat", "crop"].includes(normalized.mode) ? normalized.mode : "repeat";
    normalized.repairBoundary = Boolean(normalized.repairBoundary);
  } else if (normalized.timeType === "probability_gate") {
    normalized.source = { ...canvasDefaultTimeSource("probability_source"), label: "Gate source", ...(normalized.source || {}) };
    normalized.prompt = normalized.prompt || "";
    normalized.steps = Math.min(64, Math.max(1, Math.round(Number(normalized.steps) || 16)));
    normalized.probability = Math.min(1, Math.max(0, Number(normalized.probability ?? 0.65)));
    normalized.velocity = Math.min(2, Math.max(0, Number(normalized.velocity ?? 1)));
    normalized.seed = Math.round(Number(normalized.seed) || 1);
  } else if (normalized.timeType === "clock_divider") {
    normalized.source = { ...canvasDefaultTimeSource("divider_source"), label: "Divider source", ...(normalized.source || {}) };
    normalized.prompt = normalized.prompt || "";
    normalized.division = ["1/4", "1/8", "1/16", "1/32", "triplet"].includes(normalized.division) ? normalized.division : "1/8";
    normalized.skipEvery = Math.min(16, Math.max(0, Math.round(Number(normalized.skipEvery) || 0)));
    normalized.velocity = Math.min(2, Math.max(0, Number(normalized.velocity ?? 1)));
  } else if (normalized.timeType === "humanizer") {
    normalized.source = { ...canvasDefaultTimeSource("humanizer_source"), label: "Humanized source", ...(normalized.source || {}) };
    normalized.prompt = normalized.prompt || "";
    normalized.steps = Math.min(64, Math.max(1, Math.round(Number(normalized.steps) || 16)));
    normalized.density = Math.min(1, Math.max(0, Number(normalized.density ?? 1)));
    normalized.timing = Math.min(0.5, Math.max(0, Number(normalized.timing ?? 0.08)));
    normalized.velocitySpread = Math.min(1, Math.max(0, Number(normalized.velocitySpread ?? 0.18)));
    normalized.seed = Math.round(Number(normalized.seed) || 7);
  } else if (normalized.timeType === "polymeter") {
    const lanes = Array.isArray(normalized.lanes) ? normalized.lanes : [];
    normalized.lanes = canvasDefaultPolymeterLanes().map((fallback, index) => {
      const lane = lanes[index] || {};
      return {
        ...fallback,
        ...lane,
        steps: Math.min(32, Math.max(1, Math.round(Number(lane.steps ?? fallback.steps)))),
        pulses: Math.min(Math.round(Number(lane.steps ?? fallback.steps)), Math.max(0, Math.round(Number(lane.pulses ?? fallback.pulses)))),
        rotation: Math.max(0, Math.round(Number(lane.rotation ?? fallback.rotation))),
        velocity: Math.min(2, Math.max(0, Number(lane.velocity ?? fallback.velocity))),
        volume: Math.min(2, Math.max(0, Number(lane.volume ?? fallback.volume))),
        pan: Math.min(1, Math.max(-1, Number(lane.pan ?? fallback.pan))),
      };
    });
  } else if (normalized.timeType === "incubation_timeline") {
    normalized.label = normalized.label || "Incubation Timeline";
    normalized.timelineSources = (Array.isArray(normalized.timelineSources) ? normalized.timelineSources : [])
      .slice(0, 16)
      .map(normalizeIncubationSource);
    const sourceIds = normalized.timelineSources.map((source) => source.id);
    normalized.timelineEvents = (Array.isArray(normalized.timelineEvents) ? normalized.timelineEvents : [])
      .slice(0, 128)
      .map((event, index) => normalizeIncubationEvent(event, index, sourceIds))
      .filter((event) => !sourceIds.length || sourceIds.includes(event.sourceId));
    normalized.selectedEventId = normalized.timelineEvents.some((event) => event.id === normalized.selectedEventId)
      ? normalized.selectedEventId
      : normalized.timelineEvents[0]?.id || "";
    normalized.timelineZoom = Math.min(3, Math.max(0.5, Number(normalized.timelineZoom) || 1));
  } else if (normalized.timeType === "render_bus") {
    normalized.includeMode = normalized.includeMode === "selected" ? "selected" : "all";
    normalized.moduleIds = Array.isArray(normalized.moduleIds) ? normalized.moduleIds : [];
    normalized.label = normalized.label || "Render Bus";
  } else if (normalized.timeType === "render_macros") {
    normalized.macroSet = ["repair", "evolve", "ecology"].includes(normalized.macroSet) ? normalized.macroSet : "evolve";
    normalized.label = normalized.label || "Render Macros";
  } else {
    const lanes = Array.isArray(normalized.lanes) ? normalized.lanes : [];
    normalized.lanes = canvasDefaultColonyLanes().map((fallback, laneIndex) => {
      const lane = lanes[laneIndex] || {};
      const steps = Array.isArray(lane.steps) ? lane.steps : [];
      return {
        ...fallback,
        ...lane,
        volume: Math.min(2, Math.max(0, Number(lane.volume ?? fallback.volume))),
        pan: Math.min(1, Math.max(-1, Number(lane.pan ?? fallback.pan))),
        steps: fallback.steps.map((stepFallback, stepIndex) => ({
          ...stepFallback,
          ...(steps[stepIndex] || {}),
          enabled: Boolean(steps[stepIndex]?.enabled),
          velocity: Math.min(2, Math.max(0, Number(steps[stepIndex]?.velocity ?? stepFallback.velocity))),
        })),
      };
    });
    normalized.selectedStep = normalized.selectedStep || { lane: 0, step: 0 };
  }
  return normalized;
}

function canvasCreateTimeNode(timeType = "colony_sequencer", { x = null, y = null } = {}) {
  enableTimeMode("Adding a time module turns on the Chamber clock.");
  const point = canvasBoardDefaultPoint();
  const normalizedType = normalizedTimeType(timeType);
  const node = normalizeTimeNode({
    id: canvasId("node"),
    projectId: activeCulture.id,
    type: "time",
    timeType: normalizedType,
    x: x ?? point.x,
    y: y ?? point.y,
    width: {
      trigger_pads: 430,
      slicer: 500,
      melody_maker: 520,
      euclidean_colony: 430,
      clocked_looper: 390,
      probability_gate: 430,
      clock_divider: 430,
      humanizer: 430,
      polymeter: 520,
      incubation_timeline: 720,
      render_bus: 420,
      render_macros: 420,
    }[normalizedType] || 520,
    height: {
      trigger_pads: 410,
      slicer: 360,
      melody_maker: 390,
      euclidean_colony: 260,
      clocked_looper: 230,
      probability_gate: 260,
      clock_divider: 260,
      humanizer: 280,
      polymeter: 360,
      incubation_timeline: 430,
      render_bus: 220,
      render_macros: 260,
    }[normalizedType] || 470,
    label: timeModuleLabel(normalizedType),
    selectedRegionIds: [],
  });
  canvasNodes.push(node);
  selectedCanvasNodeId = node.id;
  renderCanvas();
  setState("Time Module Added", "ok", node.label);
  return node;
}

function canvasDefaultFxParams(type, targetNode = null) {
  if (MICRO_FX_TYPES.has(type)) return { ...MICRO_FX_DEFAULTS[type] };
  return {
    gain: { amount: 1 },
    pan: { pan: 0 },
    pitch: { semitones: 0, basePlaybackRate: Math.min(4, Math.max(0.25, Number(targetNode?.playbackRate ?? 1) || 1)) },
    filter: { mode: "lowpass", curve: [0.82, 0.76, 0.62, 0.4, 0.22] },
    granular: { density: 0.58, sizeMs: 70, jitter: 0.35, mix: 0.32 },
    loop_doctor: { mode: "seam", crossfadeSec: 0.12, variationStrength: 0.28, inpaintSeam: true },
    space: { mode: "room", mix: 0.28 },
    echo: { mode: "tape", time: 0.28, feedback: 0.32, mix: 0.25 },
    saturation: { drive: 0.28, tone: 0.55 },
    gate: { threshold: 0.18, release: 0.22 },
  }[type] || {};
}

function canvasSelectedSoundNode() {
  const node = canvasSelectedNode();
  return node?.type === "sound" ? node : null;
}

function canvasCreateFxNode(type = "gain", { x = null, y = null, targetNode = null } = {}) {
  const fx = FX_MODULES[type] || FX_MODULES.gain;
  const target = targetNode || canvasSelectedSoundNode();
  const point = target ? canvasSnappedRightPoint(target) : canvasBoardDefaultPoint();
  const isMicroFx = MICRO_FX_TYPES.has(type);
  const node = {
    id: canvasId("node"),
    projectId: activeCulture.id,
    type: "fx",
    fxType: type,
    x: x ?? point.x + (target ? 16 : 0),
    y: y ?? point.y,
    width: type === "filter" ? 300 : type === "granular" || type === "loop_doctor" || isMicroFx ? 284 : 236,
    height: type === "filter" ? 226 : type === "granular" || type === "loop_doctor" || isMicroFx ? 226 : 178,
    label: fx.label,
    params: canvasDefaultFxParams(type, target),
    semantic: { enabled: true, amount: 1 },
    targetNodeId: target?.id || null,
  };
  canvasNodes.push(node);
  if (target) {
    canvasEdges.push({
      id: canvasId("edge"),
      projectId: activeCulture.id,
      fromNodeId: target.id,
      toNodeId: node.id,
      type: "fx",
      metadata: { fxType: type },
    });
    applyFxNodeToTarget(node);
  }
  selectedCanvasNodeId = node.id;
  renderCanvas();
  setState(isMicroFx ? "Micro Module Added" : "FX Added", "ok", fx.label);
  return node;
}

function canvasNormalizeFxSemantic(node) {
  const current = node?.semantic && typeof node.semantic === "object" ? node.semantic : {};
  const params = node?.params || {};
  return {
    enabled: current.enabled !== false && params.semanticEnabled !== false,
    amount: Math.min(1, Math.max(0, Number(current.amount ?? params.semanticAmount ?? 1) || 0)),
  };
}

function canvasFilterSemanticOpenness(fxNode) {
  const params = fxNode?.params || {};
  const curve = Array.isArray(params.curve) && params.curve.length
    ? params.curve.map((value) => canvasClamp01(value, 0.5))
    : canvasDefaultFxParams("filter").curve;
  const mode = params.mode || "lowpass";
  if (mode === "highpass") return Math.min(1, Math.max(0, 0.62 + (1 - curve[curve.length - 1]) * 0.38));
  if (mode === "bandpass") return Math.min(1, Math.max(0, curve.reduce((sum, value) => sum + value, 0) / curve.length));
  return Math.min(1, Math.max(0, curve[0] ?? 0.5));
}

function canvasFxSemanticLayer(fxNode, { targetNode = null, overrides = {} } = {}) {
  if (!fxNode || fxNode.type !== "fx") return null;
  const profile = FX_SEMANTIC_PROFILES[fxNode.fxType];
  if (!profile) return null;
  const semantic = canvasNormalizeFxSemantic(fxNode);
  const amount = Math.min(1, Math.max(0, Number(overrides.semanticAmount ?? semantic.amount) || 0));
  if (!semantic.enabled || amount <= 0.03) return null;
  const params = fxNode.params || {};
  const context = {
    fxNode,
    params,
    targetNode,
    amount,
    openness: fxNode.fxType === "filter" ? canvasFilterSemanticOpenness(fxNode) : 0.5,
  };
  const promptLayer = typeof profile.prompt === "function" ? profile.prompt(context) : profile.prompt;
  const negativeLayer = typeof profile.negative === "function" ? profile.negative(context) : profile.negative;
  const rawGeneration = typeof profile.generation === "function" ? profile.generation(context) : profile.generation;
  const generation = Object.fromEntries(
    Object.entries(rawGeneration || {})
      .map(([key, value]) => [key, Number(value)])
      .filter(([, value]) => Number.isFinite(value) && Math.abs(value) >= 0.001),
  );
  return {
    id: `${fxNode.id}:semantic`,
    module_id: fxNode.id,
    target_node_id: fxNode.targetNodeId || targetNode?.id || null,
    module_type: "fx",
    fx_type: fxNode.fxType,
    family: profile.family || fxNode.fxType,
    label: fxNode.label || FX_MODULES[fxNode.fxType]?.label || "FX",
    amount: Number(amount.toFixed(3)),
    prompt_layer: String(promptLayer || "").trim(),
    negative_prompt_layer: String(negativeLayer || "").trim(),
    generation,
    params: { ...params },
  };
}

function canvasSemanticFxNodesForContext(context = {}) {
  const ids = [context.targetNodeId, context.sourceNodeId, context.promptNodeId].filter(Boolean);
  const targets = ids
    .map((id) => canvasNodes.find((node) => node.id === id))
    .filter((node) => node?.type === "sound");
  const targetIds = new Set(targets.map((node) => node.id));
  return canvasNodes
    .filter((node) => node.type === "fx" && targetIds.has(node.targetNodeId))
    .filter((node) => canvasNormalizeFxSemantic(node).enabled);
}

function canvasGenerationValueClamp(key, value) {
  const destination = GENERATION_DESTINATIONS[key];
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return value;
  if (!destination) return Number(numeric.toFixed(3));
  return Number(Math.min(destination.max, Math.max(destination.min, numeric)).toFixed(3));
}

function canvasApplySemanticFxLayers(result, context = {}) {
  const semanticFxNodes = canvasSemanticFxNodesForContext(context);
  if (!semanticFxNodes.length) return result;
  const overrides = result.semanticBridgeOverrides || {};
  const layers = semanticFxNodes
    .map((fxNode) => canvasFxSemanticLayer(fxNode, {
      targetNode: canvasNodes.find((node) => node.id === fxNode.targetNodeId) || null,
      overrides: overrides[fxNode.id] || {},
    }))
    .filter(Boolean);
  if (!layers.length) return result;
  layers.forEach((layer) => {
    if (layer.prompt_layer) result.prompt = modulationComposeText(result.prompt, layer.prompt_layer, "append");
    if (layer.negative_prompt_layer) result.negativePrompt = modulationComposeText(result.negativePrompt, layer.negative_prompt_layer, "append");
    Object.entries(layer.generation || {}).forEach(([key, value]) => {
      const base = Number(result[key] ?? GENERATION_DESTINATIONS[key]?.defaultValue ?? 0);
      result[key] = canvasGenerationValueClamp(key, base + Number(value));
    });
  });
  result.semanticFxLayers = layers;
  result.semanticLayers = [
    ...(result.semanticLayers || []),
    ...layers.map((layer) => ({
      id: layer.id,
      source: "fx",
      source_module_id: layer.module_id,
      source_type: layer.fx_type,
      family: layer.family,
      label: layer.label,
      amount: layer.amount,
      prompt_layer: layer.prompt_layer,
      negative_prompt_layer: layer.negative_prompt_layer,
      generation: layer.generation,
    })),
  ];
  result.generationContext = {
    ...(result.generationContext || {}),
    semantic_fx_count: layers.length,
    semantic_fx_ids: layers.map((layer) => layer.module_id),
  };
  return result;
}

function canvasModulatorNodeSize(modulatorType = "prompt_modulator") {
  const normalizedType = normalizeModulatorType(modulatorType);
  const wide = ["mod_matrix", "prompt_modulator", "prompt_morph", "lfo_modulator", "envelope_modulator", "step_sequencer_modulator", "gesture_recorder"].includes(normalizedType);
  return {
    width: wide ? 430 : 390,
    height: normalizedType === "prompt_morph" ? 540 : normalizedType === "mod_matrix" ? 390 : normalizedType === "prompt_modulator" ? 420 : normalizedType === "gesture_recorder" ? 390 : wide ? 360 : 320,
  };
}

function canvasCreateModulatorNode(modulatorType = "prompt_modulator", { x = null, y = null } = {}) {
  const normalizedType = normalizeModulatorType(modulatorType);
  const point = canvasBoardDefaultPoint();
  const size = canvasModulatorNodeSize(normalizedType);
  const node = normalizeModulatorNode({
    id: canvasId("node"),
    projectId: activeCulture.id,
    type: "modulator",
    modulatorType: normalizedType,
    x: x ?? point.x,
    y: y ?? point.y,
    width: size.width,
    height: size.height,
    label: modulatorLabel(normalizedType),
    selectedRegionIds: [],
  });
  canvasNodes.push(node);
  selectedCanvasNodeId = node.id;
  renderCanvas();
  setState("Modulator Added", "ok", node.label);
  return node;
}

function canvasModulatorRouteById(node, routeId) {
  return (node?.routes || []).find((route) => route.id === routeId) || null;
}

function canvasApplyPromptModulator(nodeId) {
  const node = normalizeModulatorNode(canvasNodes.find((item) => item.id === nodeId));
  if (!node || node.type !== "modulator" || !PROMPT_MODULATOR_TYPES.has(node.modulatorType)) return;
  let applied = 0;
  (node.routes || []).forEach((route) => {
    if (route.enabled === false) return;
    const target = modulationTargetForRoute(route);
    const targetNode = target ? canvasNodes.find((item) => item.id === target.nodeId) : null;
    if (!target || !targetNode || !["prompt", "negative"].includes(target.type)) return;
    const preview = modulationPreview(node, route);
    if (modulationSetTargetValue(targetNode, target.path, preview.final)) applied += 1;
  });
  const index = canvasNodes.findIndex((item) => item.id === node.id);
  if (index >= 0) canvasNodes[index] = node;
  canvasSaveState();
  renderCanvas();
  setState(applied ? "Prompt Applied" : "No Route Applied", applied ? "ok" : "muted", `${applied} prompt target(s) updated`);
}

function canvasGroupItemsFromSelection(ids = [...canvasGroupSelection]) {
  return ids
    .map((id) => canvasNodes.find((node) => node.id === id))
    .filter((node) => node?.type === "sound")
    .map((node) => {
      const asset = canvasAssetById(node.assetId);
      return {
        nodeId: node.id,
        label: node.label || displayNameFromPath(asset?.audioPath || asset?.storageUri),
        audioPath: asset?.audioPath || "",
        metadataPath: asset?.metadataPath || "",
        assetId: asset?.id || "",
        volume: Number(node.volume ?? 1),
        pan: Number(node.pan ?? 0),
      };
    });
}

function canvasCreateMixerNode({ group = null, x = null, y = null } = {}) {
  const items = group?.items || canvasGroupItemsFromSelection();
  if (items.length < 2) {
    setState("Select Sounds", "muted", "Pick at least two sound modules for a mixer.");
    return null;
  }
  const anchor = canvasNodes.find((node) => node.id === items[0]?.nodeId) || canvasSelectedSoundNode();
  const point = anchor ? canvasSnappedRightPoint(anchor) : canvasBoardDefaultPoint();
  const groupRecord = group || {
    id: `group-${crypto.randomUUID().slice(0, 8)}`,
    name: `Group ${savedGroups.length + 1}`,
    items,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  const savedIndex = savedGroups.findIndex((item) => item.id === groupRecord.id);
  if (savedIndex >= 0) {
    savedGroups[savedIndex] = groupRecord;
    saveSavedGroups();
  } else {
    savedGroups.unshift(groupRecord);
    saveSavedGroups();
  }
  const node = {
    id: canvasId("node"),
    projectId: activeCulture.id,
    type: "mixer",
    x: x ?? point.x + 24,
    y: y ?? point.y,
    width: 420,
    height: 160 + items.length * 48,
    label: groupRecord.name,
    groupId: groupRecord.id,
    groupName: groupRecord.name,
    groupItems: items,
  };
  canvasNodes.push(node);
  items.forEach((item) => {
    if (!item.nodeId) return;
    canvasEdges.push({
      id: canvasId("edge"),
      projectId: activeCulture.id,
      fromNodeId: item.nodeId,
      toNodeId: node.id,
      type: "mix",
      metadata: { groupId: groupRecord.id },
    });
  });
  canvasGroupSelection = new Set();
  selectedCanvasNodeId = node.id;
  renderCanvas();
  setState("Mixer Created", "ok", `${items.length} sound(s)`);
  return node;
}

async function canvasLoadSavedGroup(group) {
  if (!group?.items?.length) return null;
  const base = canvasBoardDefaultPoint();
  const created = [];
  for (let index = 0; index < group.items.length; index += 1) {
    const item = group.items[index];
    if (!item.audioPath) continue;
    let metadata = null;
    try {
      metadata = item.metadataPath ? await loadMetadata(item.metadataPath) : null;
    } catch {
      metadata = null;
    }
    const node = canvasAddAudioReference({
      audioPath: item.audioPath,
      metadataPath: item.metadataPath || "",
      metadata,
      origin: canvasOriginFromItem(metadata || {}),
      label: item.label || displayNameFromPath(item.audioPath),
    }, { x: base.x, y: base.y + index * 238 });
    if (node) {
      node.volume = Number(item.volume ?? 1);
      node.pan = Number(item.pan ?? 0);
      created.push(node);
    }
  }
  const loadedGroup = {
    ...group,
    items: created.map((node, index) => ({
      ...(group.items[index] || {}),
      nodeId: node.id,
      assetId: node.assetId,
    })),
    updatedAt: new Date().toISOString(),
  };
  canvasGroupSelection = new Set(loadedGroup.items.map((item) => item.nodeId).filter(Boolean));
  canvasCreateMixerNode({ group: loadedGroup });
  setState("Group Loaded", "ok", group.name || "Saved group");
  return created;
}

function applyFxNodeToTarget(fxNode) {
  const target = canvasNodes.find((node) => node.id === fxNode?.targetNodeId);
  if (!target || target.type !== "sound") return;
  const params = fxNode.params || {};
  if (fxNode.fxType === "gain") {
    target.volume = Math.min(2, Math.max(0, Number(params.amount) || 0));
  }
  if (fxNode.fxType === "pan") {
    target.pan = Math.min(1, Math.max(-1, Number(params.pan) || 0));
  }
  if (fxNode.fxType === "pitch") {
    const semitones = Math.min(24, Math.max(-24, Number(params.semitones) || 0));
    const basePlaybackRate = Math.min(4, Math.max(0.25, Number(params.basePlaybackRate ?? 1) || 1));
    target.playbackRate = Math.min(4, Math.max(0.25, Number((basePlaybackRate * Math.pow(2, semitones / 12)).toFixed(4))));
  }
  if (["gain", "pan", "pitch"].includes(fxNode.fxType)) {
    const audio = canvasEnsureNodeAudio(target);
    if (audio) canvasApplyNodeAudioParams(target);
  } else if (target.audio) {
    // Chain FX (filter/space/echo/granular/…): live in-place update, no rebuild.
    canvasApplyFxNodeParams(fxNode);
  }
  canvasSaveState();
}

function applyMixerSoloMute() {
  canvasSoundNodes().forEach((node) => {
    // Only touch modules that already have live audio; creating elements for
    // every silent node here wasted memory, and params apply at ensure-time
    // anyway.
    if (node.audio) canvasApplyNodeAudioParams(node);
  });
  canvasSaveState();
}

async function canvasAddLibraryItem(item, position = {}) {
  if (!item?.audio_file) return null;
  const ref = await libraryItemByReference(item.metadata_file || "", item.audio_file || "");
  if (!ref?.audioPath) return null;
  return canvasAddAudioReference({
    audioPath: ref.audioPath,
    metadataPath: ref.metadataPath,
    metadata: ref.metadata,
    origin: canvasOriginFromItem(item),
    label: displayNameFromPath(ref.audioPath),
  }, position);
}

function canvasAddAudioReference({ audioPath = "", metadataPath = "", metadata = null, origin = "library", label = "" } = {}, position = {}) {
  if (!audioPath) return null;
  const asset = canvasCreateAsset({
    audioPath,
    metadataPath,
    metadata,
    origin,
  });
  const count = canvasSoundNodes().length;
  const mode = metadata?.mode || metadata?.germinator_mode;
  return canvasCreateSoundNode({
    asset,
    label: label || displayNameFromPath(audioPath),
    x: position.x ?? 210 + (count % 2) * 24,
    y: position.y ?? 118 + count * 250,
    parentNodeId: canvasNodes.find((node) => node.type === "prompt")?.id || null,
    edgeType: mode === "continuation" || mode === "propagate" ? "continuation" : "lineage",
  });
}

async function canvasAddUploadFiles(files, position = null) {
  Array.from(files || [])
    .filter((file) => file.type.startsWith("audio/") || /\.(wav|mp3|ogg|flac|m4a|aif|aiff|webm)$/i.test(file.name))
    .forEach((file, index) => {
      const objectUrl = URL.createObjectURL(file);
      const asset = canvasCreateAsset({
        objectUrl,
        file,
        metadata: {
          prompt: "Local upload",
          output_audio_path: objectUrl,
          created_at: new Date().toISOString(),
          sound_id: `upload:${file.name}:${crypto.randomUUID().slice(0, 8)}`,
          parents: [],
          children: [],
          operation: "upload",
          operation_params: { filename: file.name, size: file.size, type: file.type || "audio" },
          lineage: canvasLineagePayload("upload", {
            extraParams: { filename: file.name, size: file.size, type: file.type || "audio" },
          }),
        },
        origin: "upload",
      });
      const point = position || canvasSourcePosition({ x: index * 34, y: index * 34 });
      canvasCreateSoundNode({
        asset,
        label: file.name,
        x: point.x + (index % 2) * 30,
        y: point.y + index * 236,
        edgeType: "audio_context",
      });
    });
  renderCanvas();
}

function canvasSerializableGraph() {
  const serializableAssets = canvasAssets
    .map(({ file, objectUrl, ...asset }) => asset);
  const serializableNodes = canvasNodes
    .map(({ audio, audioGraph, recorder, wavRecorder, stream, recordingStream, recordedChunks, meterLevel, reverseObjectUrl, audioMode, captureTimeout, _recAnalyser, _recAudioCtx, _recFrame, _recSource, _stopTimer, _waveLayer, ...node }) => ({
      ...node,
      recording: false,
    }));
  const validNodeIds = new Set(serializableNodes.map((node) => node.id));
  const serializableEdges = canvasEdges.filter((edge) => validNodeIds.has(edge.fromNodeId) && validNodeIds.has(edge.toNodeId));
  return {
    version: 1,
    createdAt: new Date().toISOString(),
    cultureId: activeCulture.id,
    zoom: canvasZoom,
    assets: serializableAssets,
    nodes: serializableNodes,
    edges: serializableEdges,
    candidates: canvasCandidates.map((candidate) => ({ ...candidate })),
    timeState: normalizeTimeState(timeState),
    selectedNodeId: validNodeIds.has(selectedCanvasNodeId) ? selectedCanvasNodeId : null,
  };
}

/* ── Undo / Redo ───────────────────────────────────────────────────── */
function pushUndo() {
  try {
    undoStack.push(JSON.stringify(canvasSerializableGraph()));
    if (undoStack.length > UNDO_MAX) undoStack.shift();
    redoStack.length = 0;
    syncUndoRedoButtons();
  } catch (_) { /* serialisation failure — skip */ }
}

function canvasUndo() {
  if (!undoStack.length) return;
  try {
    redoStack.push(JSON.stringify(canvasSerializableGraph()));
  } catch (_) { /* skip */ }
  const state = undoStack.pop();
  try {
    canvasHydrateGraph(JSON.parse(state));
    renderCanvas();
  } catch (_) { /* skip */ }
  syncUndoRedoButtons();
}

function canvasRedo() {
  if (!redoStack.length) return;
  try {
    undoStack.push(JSON.stringify(canvasSerializableGraph()));
  } catch (_) { /* skip */ }
  const state = redoStack.pop();
  try {
    canvasHydrateGraph(JSON.parse(state));
    renderCanvas();
  } catch (_) { /* skip */ }
  syncUndoRedoButtons();
}

function syncUndoRedoButtons() {
  const undoBtn = $("canvasUndoBtn");
  const redoBtn = $("canvasRedoBtn");
  if (undoBtn) undoBtn.disabled = undoStack.length === 0;
  if (redoBtn) redoBtn.disabled = redoStack.length === 0;
}

let _canvasLocalSaveTimer = null;
let _canvasLocalSavePending = false;

function _canvasFlushLocalSave() {
  if (!_canvasLocalSavePending) return;
  _canvasLocalSavePending = false;
  if (_canvasLocalSaveTimer) {
    clearTimeout(_canvasLocalSaveTimer);
    _canvasLocalSaveTimer = null;
  }
  try {
    localStorage.setItem("germinator-canvas-graph", JSON.stringify(canvasSerializableGraph()));
  } catch {
    // Quota exceeded or storage unavailable — keep working in memory.
  }
}

function canvasSaveState() {
  try {
    const payload = JSON.stringify(canvasSerializableGraph());
    sessionStorage.setItem("germinator-canvas-current-session", payload);
  } catch {
    // Storage can be full or unavailable in private windows; the graph still works in memory.
  }
  // Persistent (across browser restarts) save is debounced so rapid edits do
  // not hammer localStorage. pagehide/beforeunload flush below catch close.
  _canvasLocalSavePending = true;
  if (_canvasLocalSaveTimer) clearTimeout(_canvasLocalSaveTimer);
  _canvasLocalSaveTimer = setTimeout(() => {
    _canvasLocalSaveTimer = null;
    _canvasFlushLocalSave();
  }, 600);
  // The daemon mirrors the live graph so any surface (browser tab, macOS
  // shell) can pick up exactly this session.
  scheduleCurrentSessionSync();
}

window.addEventListener("pagehide", _canvasFlushLocalSave);
window.addEventListener("beforeunload", _canvasFlushLocalSave);

function canvasSaveSnapshot() {
  const snapshot = canvasSerializableGraph();
  const snapshots = getSnapshotRecords();
  const name = `canvas_snapshot_${snapshot.createdAt.replace(/[:.]/g, "-")}`;
  const record = { id: canvasId("snapshot"), name, ...snapshot };
  snapshots.unshift(record);
  const trimmed = trimSnapshotRecords(snapshots);
  localStorage.setItem("germinator-canvas-snapshots", JSON.stringify(trimmed.records));
  const blob = new Blob([JSON.stringify(record, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = `${name}.json`;
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 500);
  setState(
    "Snapshot Saved",
    "ok",
    `${record.nodes.length} node(s), ${record.edges.length} edge(s)${
      trimmed.dropped ? `, pruned ${trimmed.dropped} old snapshot(s)` : ""
    }`,
  );
}

/* ── Snapshot Library ─────────────────────────────────────────────── */

function getSnapshotRecords() {
  try { return JSON.parse(localStorage.getItem("germinator-canvas-snapshots") || "[]"); }
  catch { return []; }
}

function trimSnapshotRecords(records) {
  const validRecords = Array.isArray(records) ? records : [];
  return {
    records: validRecords.slice(0, SNAPSHOT_LIMIT),
    dropped: Math.max(0, validRecords.length - SNAPSHOT_LIMIT),
  };
}

function saveSnapshotRecords(records) {
  localStorage.setItem("germinator-canvas-snapshots", JSON.stringify(trimSnapshotRecords(records).records));
}

function openSnapshotLibrary() {
  const modal = $("snapshotLibraryModal");
  if (!modal) return;
  renderSnapshotLibrary();
  renderSessionLibrary();
  refreshCanvasSessions();
  modal.hidden = false;
}

function closeSnapshotLibrary() {
  const modal = $("snapshotLibraryModal");
  if (modal) modal.hidden = true;
}

function renderSnapshotLibrary() {
  const list = $("snapshotLibraryList");
  if (!list) return;
  const records = getSnapshotRecords();
  if (!records.length) {
    list.innerHTML = `<div class="snapshot-library-empty">No saved snapshots yet. Use the save button to create one.</div>`;
    return;
  }
  const favSet = new Set(JSON.parse(localStorage.getItem("germinator-snapshot-favorites") || "[]"));
  const sorted = [...records].sort((a, b) => {
    const af = favSet.has(a.id) ? 1 : 0;
    const bf = favSet.has(b.id) ? 1 : 0;
    return bf - af;
  });
  list.innerHTML = sorted.map((record) => {
    const isFav = favSet.has(record.id);
    const nodeCount = record.nodes?.length || 0;
    const edgeCount = record.edges?.length || 0;
    const date = record.createdAt ? new Date(record.createdAt).toLocaleString() : "—";
    return `<div class="snapshot-card" data-snapshot-id="${record.id}">
      <button class="snapshot-card-fav${isFav ? " is-fav" : ""}" data-action="snapshot-toggle-fav" data-snapshot-id="${record.id}" title="${isFav ? "Unfavorite" : "Favorite"}" type="button">
        <svg viewBox="0 0 24 24" width="14" height="14" fill="${isFav ? "currentColor" : "none"}" stroke="currentColor" stroke-width="2"><path d="M12 2l3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14 2 9.27l6.91-1.01z"/></svg>
      </button>
      <div class="snapshot-card-info" data-action="snapshot-load" data-snapshot-id="${record.id}">
        <div class="snapshot-card-name">${escapeHtml(record.name || record.id)}</div>
        <div class="snapshot-card-meta">${nodeCount} nodes · ${edgeCount} edges · ${date}</div>
      </div>
      <div class="snapshot-card-actions">
        <button data-action="snapshot-rename" data-snapshot-id="${record.id}" title="Rename" type="button">
          <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2"><path d="M11 4H4a2 2 0 00-2 2v14a2 2 0 002 2h14a2 2 0 002-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 013 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>
        </button>
        <button class="snapshot-delete" data-action="snapshot-delete" data-snapshot-id="${record.id}" title="Delete" type="button">
          <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 6h18"/><path d="M19 6v14a2 2 0 01-2 2H7a2 2 0 01-2-2V6m3 0V4a2 2 0 012-2h4a2 2 0 012 2v2"/></svg>
        </button>
      </div>
    </div>`;
  }).join("");
}

function loadSnapshot(snapshotId) {
  const records = getSnapshotRecords();
  const record = records.find((r) => r.id === snapshotId);
  if (!record) { setState("Snapshot Error", "bad", "Snapshot not found."); return; }
  if (canvasNodes.length && !window.confirm("Load this snapshot? The current graph will be replaced.")) return;
  canvasClearGraphInMemory();
  canvasResetAutoState();
  if (canvasHydrateGraph(record)) {
    renderCanvas();
    drawCanvasWaveforms();
    canvasSaveState();
    setState("Snapshot Loaded", "ok", record.name || record.id);
  } else {
    setState("Snapshot Error", "bad", "Could not hydrate snapshot data.");
  }
  closeSnapshotLibrary();
}

function renameSnapshot(snapshotId) {
  const records = getSnapshotRecords();
  const record = records.find((r) => r.id === snapshotId);
  if (!record) return;
  const newName = window.prompt("Rename snapshot:", record.name || "");
  if (newName === null) return;
  record.name = newName.trim() || record.name;
  saveSnapshotRecords(records);
  renderSnapshotLibrary();
}

function deleteSnapshot(snapshotId) {
  if (!window.confirm("Delete this snapshot?")) return;
  const records = getSnapshotRecords().filter((r) => r.id !== snapshotId);
  saveSnapshotRecords(records);
  // Remove from favorites too
  const favs = JSON.parse(localStorage.getItem("germinator-snapshot-favorites") || "[]").filter((id) => id !== snapshotId);
  localStorage.setItem("germinator-snapshot-favorites", JSON.stringify(favs));
  renderSnapshotLibrary();
  setState("Snapshot Deleted", "ok");
}

function toggleSnapshotFavorite(snapshotId) {
  const favs = new Set(JSON.parse(localStorage.getItem("germinator-snapshot-favorites") || "[]"));
  if (favs.has(snapshotId)) favs.delete(snapshotId);
  else favs.add(snapshotId);
  localStorage.setItem("germinator-snapshot-favorites", JSON.stringify([...favs]));
  renderSnapshotLibrary();
}

/* ── Sessions (server-side) ───────────────────────────────────────────
   Named sessions and the autosaved "current" graph live on the daemon
   (output/sessions/), not in localStorage — that is what lets the
   browser dashboard and the native macOS shell open the exact same
   modules, connections, and clock state from either surface.          */

let canvasSessions = [];
let _sessionSyncTimer = null;
let _sessionSyncLastPayload = "";

const SESSION_CLIENT_ID = (() => {
  try {
    let id = localStorage.getItem("germ-client-id");
    if (!id) {
      id = `client_${Math.random().toString(36).slice(2, 10)}`;
      localStorage.setItem("germ-client-id", id);
    }
    return id;
  } catch {
    return "client_anon";
  }
})();

async function refreshCanvasSessions({ render = true } = {}) {
  try {
    canvasSessions = await api("/sessions");
  } catch {
    canvasSessions = [];
  }
  if (render) renderSessionLibrary();
  return canvasSessions;
}

function renderSessionLibrary() {
  const list = $("sessionLibraryList");
  if (!list) return;
  if (!canvasSessions.length) {
    list.innerHTML = `<div class="snapshot-library-empty">No server sessions yet. Save one to share the graph between the browser and the mac app.</div>`;
    return;
  }
  list.innerHTML = canvasSessions.map((session) => {
    const date = session.updated_at ? new Date(session.updated_at).toLocaleString() : "—";
    return `<div class="snapshot-card" data-session-id="${escapeHtml(session.id)}">
      <div class="snapshot-card-info" data-action="session-load" data-session-id="${escapeHtml(session.id)}">
        <div class="snapshot-card-name">${escapeHtml(session.name || session.id)}</div>
        <div class="snapshot-card-meta">${session.node_count} nodes · ${session.edge_count} edges · ${date}</div>
      </div>
      <div class="snapshot-card-actions">
        <button class="snapshot-delete" data-action="session-delete" data-session-id="${escapeHtml(session.id)}" title="Delete session" aria-label="Delete session" type="button">
          <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 6h18"/><path d="M19 6v14a2 2 0 01-2 2H7a2 2 0 01-2-2V6m3 0V4a2 2 0 012-2h4a2 2 0 012 2v2"/></svg>
        </button>
      </div>
    </div>`;
  }).join("");
}

async function canvasSaveSessionAs() {
  const suggested = canvasSessions[0]?.name || "";
  const name = window.prompt("Session name:", suggested);
  if (name === null) return;
  const trimmed = name.trim();
  if (!trimmed) { setState("Session Error", "bad", "A session needs a name."); return; }
  try {
    const result = await api("/sessions", {
      method: "POST",
      body: JSON.stringify({ name: trimmed, graph: canvasSerializableGraph() }),
    });
    await refreshCanvasSessions();
    setState("Session Saved", "ok", `${result.session?.node_count ?? canvasNodes.length} module(s) → ${trimmed}`);
  } catch (error) {
    setState("Session Error", "bad", error.message);
  }
}

async function canvasLoadSession(sessionId) {
  try {
    const result = await api(`/sessions/${encodeURIComponent(sessionId)}`);
    const graph = result?.graph;
    if (!graph || typeof graph !== "object") throw new Error("Session graph is empty.");
    if (canvasNodes.length && !window.confirm("Load this session? The current graph will be replaced.")) return;
    canvasClearGraphInMemory();
    canvasResetAutoState();
    if (canvasHydrateGraph(graph)) {
      renderCanvas();
      drawCanvasWaveforms();
      canvasSaveState();
      setState("Session Loaded", "ok", result.session?.name || sessionId);
    } else {
      setState("Session Error", "bad", "Could not hydrate session data.");
    }
    closeSnapshotLibrary();
  } catch (error) {
    setState("Session Error", "bad", error.message);
  }
}

async function canvasDeleteSession(sessionId) {
  if (!window.confirm("Delete this server session?")) return;
  try {
    await api(`/sessions/${encodeURIComponent(sessionId)}`, { method: "DELETE" });
    await refreshCanvasSessions();
    setState("Session Deleted", "ok");
  } catch (error) {
    setState("Session Error", "bad", error.message);
  }
}

// Debounced autosave of the live graph to the daemon. Fire-and-forget: a
// missing/offline server must never interrupt patching.
function scheduleCurrentSessionSync() {
  if (_sessionSyncTimer) clearTimeout(_sessionSyncTimer);
  _sessionSyncTimer = setTimeout(() => {
    _sessionSyncTimer = null;
    pushCurrentSession();
  }, 1500);
}

async function pushCurrentSession() {
  try {
    const graph = canvasSerializableGraph();
    const payload = JSON.stringify({ nodes: graph.nodes, edges: graph.edges, assets: graph.assets, timeState: graph.timeState });
    if (payload === _sessionSyncLastPayload) return;
    _sessionSyncLastPayload = payload;
    await api("/sessions/current", {
      method: "PUT",
      body: JSON.stringify({ graph, client_id: SESSION_CLIENT_ID }),
    });
  } catch {
    // Server unreachable — the local graph still works; retry on next edit.
    _sessionSyncLastPayload = "";
  }
}

async function canvasRestoreCurrentSessionFromServer() {
  try {
    const result = await api("/sessions/current");
    const graph = result?.graph;
    if (result?.status !== "done" || !Array.isArray(graph?.nodes) || !graph.nodes.length) return false;
    if (canvasNodes.length) return false;
    if (!canvasHydrateGraph(graph)) return false;
    _sessionSyncLastPayload = "";
    renderCanvas();
    drawCanvasWaveforms();
    setState(
      "Session Restored",
      "ok",
      `${graph.nodes.length} module(s) from the shared current session. Reset the graph to start empty.`,
    );
    return true;
  } catch {
    return false;
  }
}

async function canvasClearCurrentSessionOnServer() {
  _sessionSyncLastPayload = "";
  try { await api("/sessions/current", { method: "DELETE" }); } catch {}
}

function canvasClearGraphInMemory() {
  pushUndo();
  canvasAssets.forEach((asset) => {
    if (asset.objectUrl) URL.revokeObjectURL(asset.objectUrl);
  });
  canvasAssets = [];
  canvasNodes = [];
  canvasEdges = [];
  canvasCandidates = [];
  selectedCanvasNodeId = null;
  canvasLastSelectedSoundNodeId = null;
  timeState = createDefaultTimeState();
  stopAllTimePadRecordings();
}

function canvasResetAutoState() {
  localStorage.removeItem("germinator-canvas-graph");
  sessionStorage.removeItem("germinator-canvas-current-session");
}

function canvasHydrateGraph(graph) {
  if (!graph || typeof graph !== "object") return false;
  const assets = Array.isArray(graph.assets) ? graph.assets : [];
  const usableAssets = assets
    .filter((asset) => asset && typeof asset === "object")
    .filter((asset) => asset.audioPath || (!asset.localOnly && asset.storageUri))
    .map((asset) => ({ ...asset, file: null, objectUrl: "" }));
  const assetIds = new Set(usableAssets.map((asset) => asset.id));
  const nodes = (Array.isArray(graph.nodes) ? graph.nodes : [])
    .filter((node) => node && typeof node === "object")
    .filter((node) => node.type !== "sound" || assetIds.has(node.assetId))
    .map(({ audio, recorder, wavRecorder, stream, recordingStream, recordedChunks, captureTimeout, _recAnalyser, _recAudioCtx, _recFrame, _recSource, _stopTimer, _waveLayer, ...node }) => {
      const hydrated = {
        ...node,
        recording: false,
        recordedChunks: [],
      };
      if (hydrated.promptRun?.active) {
        hydrated.promptRun = {
          ...hydrated.promptRun,
          label: "Interrupted",
          detail: "Generation state was restored after a reload.",
          variant: "muted",
          active: false,
          elapsedMs: canvasPromptRunElapsed(hydrated.promptRun),
        };
      }
      if (hydrated.type === "time") return normalizeTimeNode(hydrated);
      if (hydrated.type === "modulator") return normalizeModulatorNode(hydrated);
      if (hydrated.type === "germ") return normalizeGermNode(hydrated);
      if (hydrated.type === "wavetable_forge") return normalizeWavetableForgeNode(hydrated);
      return hydrated;
    });
  const nodeIds = new Set(nodes.map((node) => node.id));
  canvasAssets = usableAssets;
  canvasNodes = nodes;
  canvasEdges = (Array.isArray(graph.edges) ? graph.edges : [])
    .filter((edge) => edge && nodeIds.has(edge.fromNodeId) && nodeIds.has(edge.toNodeId));
  canvasCandidates = (Array.isArray(graph.candidates) ? graph.candidates : [])
    .filter((candidate) => candidate && assetIds.has(candidate.assetId))
    .map(normalizeCanvasCandidate)
    .filter(Boolean)
    .slice(0, 24);
  selectedCanvasNodeId = nodeIds.has(graph.selectedNodeId) ? graph.selectedNodeId : canvasNodes[0]?.id || null;
  canvasLastSelectedSoundNodeId = canvasNodes.find((node) => node.id === selectedCanvasNodeId && node.type === "sound")?.id
    || canvasNodes.find((node) => node.type === "sound")?.id
    || null;
  canvasZoom = Math.min(2.5, Math.max(0.3, Number(graph.zoom) || 1));
  timeState = normalizeTimeState(graph.timeState);
  return Boolean(canvasAssets.length || canvasNodes.length || canvasEdges.length || canvasCandidates.length);
}

function canvasLoadState() {
  canvasClearGraphInMemory();
  const restoreMode = new URLSearchParams(window.location.search).get("restore");
  if (restoreMode !== "canvas") {
    canvasResetAutoState();
    renderCanvas();
    // Cross-surface continuity: if the daemon holds a live current session
    // (saved by this browser earlier, another tab, or the macOS shell),
    // restore it so every surface opens the same modules and connections.
    canvasRestoreCurrentSessionFromServer();
    return;
  }
  const keys = ["germinator-canvas-current-session", "germinator-canvas-graph"];
  for (const key of keys) {
    try {
      const stored = key === "germinator-canvas-current-session"
        ? sessionStorage.getItem(key)
        : localStorage.getItem(key);
      if (stored && canvasHydrateGraph(JSON.parse(stored))) break;
    } catch {
      if (key === "germinator-canvas-current-session") sessionStorage.removeItem(key);
      else localStorage.removeItem(key);
    }
  }
  renderCanvas();
  if (!canvasNodes.length) canvasRestoreCurrentSessionFromServer();
}

function canvasResetGraph() {
  if (canvasNodes.length && !window.confirm("Reset the graph? Generated files remain in the library.")) return;
  canvasClearGraphInMemory();
  canvasResetAutoState();
  // An explicit reset also clears the shared current session, so the other
  // surface does not resurrect what the user just discarded.
  canvasClearCurrentSessionOnServer();
  closeCanvasSourceMenu();
  renderCanvas();
}

function canvasNodeOriginClass(origin) {
  return {
    prompt: "origin-prompt",
    upload: "origin-upload",
    library: "origin-library",
    recording: "origin-recording",
    audio_snapshot: "origin-recording",
    continuation: "origin-continuation",
    inpaint: "origin-inpaint",
    audio_to_audio: "origin-mutate",
    mixdown: "origin-mix",
    extract: "origin-extract",
    audio_tool: "origin-extract",
    time_pitch: "origin-extract",
    time_render: "origin-mix",
    time_one_shot: "origin-prompt",
  }[origin] || "origin-library";
}

function fxModeButton(node, mode, label) {
  const active = node.params?.mode === mode ? " active" : "";
  return `<button class="fx-mode${active}" type="button" data-action="canvas-fx-mode" data-node-id="${escapeHtml(node.id)}" data-mode="${escapeHtml(mode)}">${escapeHtml(label)}</button>`;
}

function canvasFxSemanticControlsMarkup(node) {
  const semantic = canvasNormalizeFxSemantic(node);
  const layer = canvasFxSemanticLayer(node);
  const label = layer?.family || "context";
  return `
    <div class="fx-semantic-row">
      <label class="fx-semantic-toggle" title="Let this effect contribute generation context.">
        <input class="canvas-fx-semantic-param" data-node-id="${escapeHtml(node.id)}" data-field="enabled" type="checkbox" ${semantic.enabled ? "checked" : ""} />
        <span>Gen</span>
      </label>
      <input class="canvas-fx-semantic-param" data-node-id="${escapeHtml(node.id)}" data-field="amount" type="range" min="0" max="1" step="0.01" value="${escapeHtml(semantic.amount)}" aria-label="Semantic amount" />
      <span>${escapeHtml(label)}</span>
    </div>
  `;
}

function canvasMicroFxControlsMarkup(node) {
  const params = node.params || canvasDefaultFxParams(node.fxType);
  return Object.entries(params)
    .map(([param, value]) => {
      const meta = MICRO_FX_CONTROL_META[param] || { label: param, min: 0, max: 1, step: 0.01 };
      if (meta.type === "checkbox" || typeof value === "boolean") {
        return `<label class="modulator-inline-check fx-inline-check"><input class="canvas-fx-param" data-node-id="${escapeHtml(node.id)}" data-param="${escapeHtml(param)}" type="checkbox" ${value !== false ? "checked" : ""} /> ${escapeHtml(meta.label)}</label>`;
      }
      const numeric = Number(value);
      return `
        <div class="fx-mini-slider">
          <span>${escapeHtml(meta.label)}</span>
          <input class="canvas-fx-param" data-node-id="${escapeHtml(node.id)}" data-param="${escapeHtml(param)}" type="range" min="${escapeHtml(meta.min ?? 0)}" max="${escapeHtml(meta.max ?? 1)}" step="${escapeHtml(meta.step ?? 0.01)}" value="${escapeHtml(Number.isFinite(numeric) ? numeric : 0)}" />
        </div>
      `;
    })
    .join("");
}

function canvasFxControlsMarkup(node) {
  const params = node.params || canvasDefaultFxParams(node.fxType);
  if (node.fxType === "gain") {
    const amount = Number(params.amount ?? 1);
    const deg = Math.round(35 + amount * 145);
    return `
      <div class="fx-pot" style="--pot-angle:${deg}deg">
        <input class="canvas-fx-param" data-node-id="${escapeHtml(node.id)}" data-param="amount" type="range" min="0" max="2" step="0.01" value="${escapeHtml(amount)}" aria-label="Gain amount" />
        <span>${escapeHtml(amount.toFixed(2))}x</span>
      </div>
    `;
  }
  if (node.fxType === "pan") {
    const pan = Number(params.pan ?? 0);
    return `
      <div class="fx-pan-control">
        <span>L</span>
        <input class="canvas-fx-param" data-node-id="${escapeHtml(node.id)}" data-param="pan" type="range" min="-1" max="1" step="0.01" value="${escapeHtml(pan)}" aria-label="Pan" />
        <span>R</span>
      </div>
    `;
  }
  if (node.fxType === "pitch") {
    const semitones = Number(params.semitones ?? 0);
    return `
      <div class="fx-mini-slider"><span>Pitch</span><input class="canvas-fx-param" data-node-id="${escapeHtml(node.id)}" data-param="semitones" type="range" min="-24" max="24" step="0.01" value="${escapeHtml(semitones)}" /></div>
      <div class="fx-readout">${escapeHtml(semitones.toFixed(2))} st | realtime audition</div>
    `;
  }
  if (node.fxType === "filter") {
    return `
      <div class="fx-mode-row">
        ${fxModeButton(node, "lowpass", "Low")}
        ${fxModeButton(node, "bandpass", "Band")}
        ${fxModeButton(node, "highpass", "High")}
      </div>
      <canvas class="fx-filter-canvas" data-node-id="${escapeHtml(node.id)}" width="520" height="190" aria-label="Drawable filter curve"></canvas>
    `;
  }
  if (node.fxType === "space") {
    return `
      <div class="fx-mode-row">
        ${fxModeButton(node, "room", "Room")}
        ${fxModeButton(node, "plate", "Plate")}
        ${fxModeButton(node, "hall", "Hall")}
      </div>
      <div class="fx-mini-slider"><span>Mix</span><input class="canvas-fx-param" data-node-id="${escapeHtml(node.id)}" data-param="mix" type="range" min="0" max="1" step="0.01" value="${escapeHtml(params.mix ?? 0.28)}" /></div>
    `;
  }
  if (node.fxType === "echo") {
    return `
      <div class="fx-mode-row">
        ${fxModeButton(node, "slap", "Slap")}
        ${fxModeButton(node, "tape", "Tape")}
        ${fxModeButton(node, "dub", "Dub")}
      </div>
      <div class="fx-mini-slider"><span>Time</span><input class="canvas-fx-param" data-node-id="${escapeHtml(node.id)}" data-param="time" type="range" min="0.04" max="1.2" step="0.01" value="${escapeHtml(params.time ?? 0.28)}" /></div>
      <div class="fx-mini-slider"><span>Feed</span><input class="canvas-fx-param" data-node-id="${escapeHtml(node.id)}" data-param="feedback" type="range" min="0" max="0.85" step="0.01" value="${escapeHtml(params.feedback ?? 0.32)}" /></div>
    `;
  }
  if (node.fxType === "granular") {
    return `
      <div class="fx-mini-slider"><span>Density</span><input class="canvas-fx-param" data-node-id="${escapeHtml(node.id)}" data-param="density" type="range" min="0" max="1" step="0.01" value="${escapeHtml(params.density ?? 0.58)}" /></div>
      <div class="fx-mini-slider"><span>Size</span><input class="canvas-fx-param" data-node-id="${escapeHtml(node.id)}" data-param="sizeMs" type="range" min="15" max="220" step="1" value="${escapeHtml(params.sizeMs ?? 70)}" /></div>
      <div class="fx-mini-slider"><span>Jitter</span><input class="canvas-fx-param" data-node-id="${escapeHtml(node.id)}" data-param="jitter" type="range" min="0" max="1" step="0.01" value="${escapeHtml(params.jitter ?? 0.35)}" /></div>
      <div class="fx-mini-slider"><span>Mix</span><input class="canvas-fx-param" data-node-id="${escapeHtml(node.id)}" data-param="mix" type="range" min="0" max="1" step="0.01" value="${escapeHtml(params.mix ?? 0.32)}" /></div>
    `;
  }
  if (MICRO_FX_TYPES.has(node.fxType)) return canvasMicroFxControlsMarkup(node);
  if (node.fxType === "loop_doctor") {
    return `
      <div class="fx-mode-row">
        ${fxModeButton(node, "seam", "Seam")}
        ${fxModeButton(node, "loop_points", "Points")}
        ${fxModeButton(node, "variation", "Variant")}
      </div>
      <div class="fx-mini-slider"><span>Cross</span><input class="canvas-fx-param" data-node-id="${escapeHtml(node.id)}" data-param="crossfadeSec" type="range" min="0.01" max="0.5" step="0.01" value="${escapeHtml(params.crossfadeSec ?? 0.12)}" /></div>
      <div class="fx-mini-slider"><span>Var</span><input class="canvas-fx-param" data-node-id="${escapeHtml(node.id)}" data-param="variationStrength" type="range" min="0" max="1" step="0.01" value="${escapeHtml(params.variationStrength ?? 0.28)}" /></div>
      <label class="modulator-inline-check fx-inline-check"><input class="canvas-fx-param" data-node-id="${escapeHtml(node.id)}" data-param="inpaintSeam" type="checkbox" ${params.inpaintSeam !== false ? "checked" : ""} /> Inpaint seam</label>
    `;
  }
  if (node.fxType === "saturation") {
    return `
      <div class="fx-mode-row">
        ${fxModeButton(node, "subtle", "Subtle")}
        ${fxModeButton(node, "warm", "Warm")}
        ${fxModeButton(node, "hard", "Hard")}
      </div>
      <div class="fx-mini-slider"><span>Drive</span><input class="canvas-fx-param" data-node-id="${escapeHtml(node.id)}" data-param="drive" type="range" min="0" max="1" step="0.01" value="${escapeHtml(params.drive ?? 0.28)}" /></div>
    `;
  }
  return `
    <div class="fx-mini-slider"><span>Gate</span><input class="canvas-fx-param" data-node-id="${escapeHtml(node.id)}" data-param="threshold" type="range" min="0" max="1" step="0.01" value="${escapeHtml(params.threshold ?? 0.18)}" /></div>
    <div class="fx-mini-slider"><span>Rel</span><input class="canvas-fx-param" data-node-id="${escapeHtml(node.id)}" data-param="release" type="range" min="0.02" max="1" step="0.01" value="${escapeHtml(params.release ?? 0.22)}" /></div>
  `;
}

function canvasFxNodeMarkup(node, selected, style) {
  const fx = FX_MODULES[node.fxType] || FX_MODULES.gain;
  const renderPitchButton = node.fxType === "pitch"
    ? `<button class="time-action" type="button" data-action="canvas-fx-render-pitch" data-node-id="${escapeHtml(node.id)}">Render</button>`
    : "";
  const renderLoopDoctorButton = node.fxType === "loop_doctor"
    ? `<button class="time-action primary" type="button" data-action="canvas-fx-loop-doctor" data-node-id="${escapeHtml(node.id)}">Repair</button>`
    : "";
  return canvasInjectModuleTabs(`
    <article class="canvas-node fx-node${selected}" data-node-id="${escapeHtml(node.id)}" style="${style}" data-help="${escapeHtml(fx.description || fx.label)}">
      ${canvasIoPortsMarkup(node.id, { input: true, output: true })}
      <div class="fx-node-head">
        <div><strong>${escapeHtml(fx.label)}</strong></div>
        <div class="time-node-actions">
          ${renderLoopDoctorButton}
          ${renderPitchButton}
          <button class="prompt-node-icon delete" type="button" data-action="canvas-delete-node" data-node-id="${escapeHtml(node.id)}" title="Delete" aria-label="Delete"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M18 6 6 18"/><path d="M6 6l12 12"/></svg></button>
        </div>
      </div>
      <div class="fx-node-body">${canvasFxControlsMarkup(node)}${canvasFxSemanticControlsMarkup(node)}</div>
    </article>
  `, node, { bodyClass: "fx-node-body" });
}

function canvasIoPortsMarkup(nodeId, { input = false, output = false } = {}) {
  const id = escapeHtml(nodeId);
  const parts = [];
  if (input) {
    parts.push(`<button class="canvas-io-port io-input" type="button" data-action="canvas-io-port" data-port="input" data-node-id="${id}" title="Audio in" aria-label="Audio input"></button>`);
  }
  if (output) {
    parts.push(`<button class="canvas-io-port io-output" type="button" data-action="canvas-io-port" data-port="output" data-node-id="${id}" title="Audio out" aria-label="Audio output"></button>`);
  }
  return parts.join("");
}

function canvasMixerNodeMarkup(node, selected, style) {
  const items = node.groupItems || [];
  return `
    <article class="canvas-node mixer-node${selected}" data-node-id="${escapeHtml(node.id)}" style="${style}" data-help="Mixer module — combines selected sounds.">
      ${canvasIoPortsMarkup(node.id, { input: true, output: true })}
      <div class="mixer-head">
        <div><strong>${escapeHtml(node.groupName || node.label || "Group")}</strong></div>
        <button class="prompt-node-icon delete" type="button" data-action="canvas-delete-node" data-node-id="${escapeHtml(node.id)}" title="Delete" aria-label="Delete"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M18 6 6 18"/><path d="M6 6l12 12"/></svg></button>
      </div>
      <div class="mixer-rows">
        ${items.map((item) => {
          const target = canvasNodes.find((sound) => sound.id === item.nodeId);
          const volume = Number(target?.volume ?? item.volume ?? 1);
          const pan = Number(target?.pan ?? item.pan ?? 0);
          return `
            <div class="mixer-row" data-mixer-node-id="${escapeHtml(node.id)}" data-target-node-id="${escapeHtml(item.nodeId)}">
              <span class="mixer-name">${escapeHtml(item.label || item.nodeId)}</span>
              <button class="mixer-toggle${target?.solo ? " active" : ""}" type="button" data-action="canvas-mixer-toggle" data-toggle="solo" data-target-node-id="${escapeHtml(item.nodeId)}">S</button>
              <button class="mixer-toggle${target?.muted ? " active" : ""}" type="button" data-action="canvas-mixer-toggle" data-toggle="muted" data-target-node-id="${escapeHtml(item.nodeId)}">M</button>
              <input class="canvas-mixer-param" data-target-node-id="${escapeHtml(item.nodeId)}" data-param="volume" type="range" min="0" max="1.5" step="0.01" value="${escapeHtml(volume)}" aria-label="Level" />
              <input class="canvas-mixer-param pan" data-target-node-id="${escapeHtml(item.nodeId)}" data-param="pan" type="range" min="-1" max="1" step="0.01" value="${escapeHtml(pan)}" aria-label="Pan" />
              <span class="mixer-meter"><i style="height:${Math.round((target?.meterLevel || 0) * 100)}%"></i></span>
            </div>
          `;
        }).join("")}
      </div>
    </article>
  `;
}

function midiFromNoteName(noteName = "C3") {
  const match = String(noteName).trim().match(/^([A-G])(#?)(-?\d)$/);
  if (!match) return 48;
  const noteIndex = TIME_NOTE_NAMES.indexOf(`${match[1]}${match[2] || ""}`);
  const octave = Number(match[3]);
  return (octave + 1) * 12 + Math.max(0, noteIndex);
}

function noteNameFromMidi(midi = 48) {
  const note = Math.round(Number(midi) || 48);
  const name = TIME_NOTE_NAMES[((note % 12) + 12) % 12];
  const octave = Math.floor(note / 12) - 1;
  return `${name}${octave}`;
}

function euclideanPattern(steps = 16, pulses = 5, rotation = 0) {
  const count = Math.max(1, Math.round(Number(steps) || 16));
  const hits = Math.min(count, Math.max(0, Math.round(Number(pulses) || 0)));
  const pattern = Array.from({ length: count }, (_, index) => Math.floor((index * hits) % count) < hits);
  const rotate = ((Math.round(Number(rotation) || 0) % count) + count) % count;
  return pattern.map((_, index) => pattern[(index - rotate + count) % count]);
}

function deterministicUnit(seed) {
  let hash = 2166136261;
  for (const char of String(seed)) {
    hash ^= char.charCodeAt(0);
    hash = Math.imul(hash, 16777619);
  }
  return ((hash >>> 0) % 10000) / 10000;
}

function probabilityGatePattern(node) {
  const steps = Math.max(1, Math.round(Number(node?.steps) || 16));
  const probability = Math.min(1, Math.max(0, Number(node?.probability ?? 1)));
  const seed = Number(node?.seed) || 1;
  return Array.from({ length: steps }, (_, index) => deterministicUnit(`${node.id}:${seed}:gate:${index}`) <= probability);
}

function renderBusTargetNodes(busNode) {
  if (!busNode || busNode.type !== "time" || busNode.timeType !== "render_bus") return [];
  const targetIds = new Set(busNode.moduleIds || []);
  return canvasTimeNodes()
    .filter((node) => node.id !== busNode.id && node.timeType !== "render_bus")
    .filter((node) => busNode.includeMode !== "selected" || targetIds.has(node.id))
    .filter((node) => timeNodeRenderStatus(node).canRender);
}

function canvasTimeClockReadout() {
  const derived = timeClockDerived();
  return `${Math.round(timeState.bpm)} BPM | ${timeSignatureLabel()} | ${timeState.bars} bars | ${derived.loopSeconds.toFixed(1)}s`;
}

function canvasTimeStepVelocityMarkup(node) {
  const selected = node.selectedStep || { lane: 0, step: 0 };
  const lane = node.lanes?.[selected.lane];
  const step = lane?.steps?.[selected.step];
  if (!lane || !step) return "";
  return `
    <label class="time-step-velocity">Velocity
      <input class="time-step-velocity-input" data-node-id="${escapeHtml(node.id)}" type="range" min="0" max="2" step="0.01" value="${escapeHtml(step.velocity ?? 1)}" />
      <span>${escapeHtml(Number(step.velocity ?? 1).toFixed(2))}</span>
    </label>
  `;
}

function canvasColonySequencerMarkup(node, selected, style) {
  node = normalizeTimeNode(node);
  return `
    <article class="canvas-node time-node${selected}" data-node-id="${escapeHtml(node.id)}" style="${style}">
      <div class="time-head">
        <div>
          <span>Clocked cultivation</span>
          <strong>${escapeHtml(node.label || "Colony Sequencer")}</strong>
          <small class="time-clock-readout">${escapeHtml(canvasTimeClockReadout())}</small>
        </div>
        <div class="time-node-actions">
          <button class="time-action primary" type="button" data-action="time-render-node" data-node-id="${escapeHtml(node.id)}">Harvest</button>
          <button class="prompt-node-icon delete" type="button" data-action="canvas-delete-node" data-node-id="${escapeHtml(node.id)}" title="Delete" aria-label="Delete"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M18 6 6 18"/><path d="M6 6l12 12"/></svg></button>
        </div>
      </div>
      <div class="time-node-body">
        ${(node.lanes || []).map((lane, laneIndex) => {
          const asset = canvasAssetById(lane.assetId);
          const selectedStep = node.selectedStep || { lane: 0, step: 0 };
          return `
            <section class="time-lane">
              <div class="time-row-head">
                <div>
                  <span class="time-lane-name">${escapeHtml(lane.label || `Lane ${laneIndex + 1}`)}</span>
                  <small class="time-clock-readout">${escapeHtml(timeAssetLabel(asset))}</small>
                </div>
                <div class="time-row-tools">
                  <button class="time-mini-toggle${lane.solo ? " active" : ""}" type="button" data-action="time-lane-toggle" data-toggle="solo" data-node-id="${escapeHtml(node.id)}" data-lane-index="${laneIndex}">S</button>
                  <button class="time-mini-toggle${lane.mute ? " active" : ""}" type="button" data-action="time-lane-toggle" data-toggle="mute" data-node-id="${escapeHtml(node.id)}" data-lane-index="${laneIndex}">M</button>
                  <button class="time-action" type="button" data-action="time-assign-selected" data-kind="lane" data-node-id="${escapeHtml(node.id)}" data-index="${laneIndex}">Assign</button>
                  <button class="time-action" type="button" data-action="time-generate-shot" data-kind="lane" data-node-id="${escapeHtml(node.id)}" data-index="${laneIndex}">Generate</button>
                </div>
              </div>
              <input class="time-prompt-input time-lane-prompt" data-node-id="${escapeHtml(node.id)}" data-lane-index="${laneIndex}" value="${escapeHtml(lane.prompt || "")}" placeholder="one-shot prompt" />
              <div class="time-grid">
                ${(lane.steps || []).map((step, stepIndex) => `
                  <button class="time-step${step.enabled ? " active" : ""}${selectedStep.lane === laneIndex && selectedStep.step === stepIndex ? " selected" : ""}" type="button" data-action="time-toggle-step" data-node-id="${escapeHtml(node.id)}" data-lane-index="${laneIndex}" data-step-index="${stepIndex}" title="Step ${stepIndex + 1} velocity ${Number(step.velocity ?? 1).toFixed(2)}"></button>
                `).join("")}
              </div>
              <div class="time-lane-mix">
                <label>Vol <input class="time-lane-param" data-node-id="${escapeHtml(node.id)}" data-lane-index="${laneIndex}" data-param="volume" type="range" min="0" max="2" step="0.01" value="${escapeHtml(lane.volume ?? 1)}" /></label>
                <label>Pan <input class="time-lane-param" data-node-id="${escapeHtml(node.id)}" data-lane-index="${laneIndex}" data-param="pan" type="range" min="-1" max="1" step="0.01" value="${escapeHtml(lane.pan ?? 0)}" /></label>
              </div>
            </section>
          `;
        }).join("")}
        ${canvasTimeStepVelocityMarkup(node)}
      </div>
    </article>
  `;
}

function canvasTriggerPadsMarkup(node, selected, style) {
  node = normalizeTimeNode(node);
  const eventCount = (node.recordedEvents || []).length;
  return `
    <article class="canvas-node time-node${selected}" data-node-id="${escapeHtml(node.id)}" style="${style}">
      <div class="time-head">
        <div>
          <span>Clocked performance</span>
          <strong>${escapeHtml(node.label || "Trigger Pads")}</strong>
          <small class="time-clock-readout">${escapeHtml(canvasTimeClockReadout())} | ${eventCount} event(s)</small>
        </div>
        <div class="time-node-actions">
          <button class="time-action${node.recording ? " active" : ""}" type="button" data-action="time-pad-record-toggle" data-node-id="${escapeHtml(node.id)}">${node.recording ? "Stop Rec" : "Record"}</button>
          <button class="time-action" type="button" data-action="time-pad-clear" data-node-id="${escapeHtml(node.id)}">Clear</button>
          <button class="time-action primary" type="button" data-action="time-render-node" data-node-id="${escapeHtml(node.id)}">Render</button>
          <button class="prompt-node-icon delete" type="button" data-action="canvas-delete-node" data-node-id="${escapeHtml(node.id)}" title="Delete" aria-label="Delete"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M18 6 6 18"/><path d="M6 6l12 12"/></svg></button>
        </div>
      </div>
      <div class="time-pads-grid">
        ${(node.pads || []).map((pad, index) => {
          const asset = canvasAssetById(pad.assetId);
          return `
            <section class="time-pad">
              <button class="time-pad-trigger${asset ? " loaded" : ""}${node.recording ? " time-pad-recording" : ""}" type="button" data-action="time-trigger-pad" data-node-id="${escapeHtml(node.id)}" data-pad-index="${index}" title="${escapeHtml(timeAssetLabel(asset))}">${escapeHtml(pad.key || index + 1)}</button>
              <div class="time-pad-meta">
                <span class="time-pad-label">${escapeHtml(timeAssetLabel(asset))}</span>
                <span class="time-pad-key">${escapeHtml(pad.key || index + 1)}</span>
              </div>
              <input class="time-prompt-input time-pad-prompt" data-node-id="${escapeHtml(node.id)}" data-pad-index="${index}" value="${escapeHtml(pad.prompt || "")}" placeholder="pad prompt" />
              <div class="time-row-tools">
                <button class="time-action" type="button" data-action="time-assign-selected" data-kind="pad" data-node-id="${escapeHtml(node.id)}" data-index="${index}">Assign</button>
                <button class="time-action" type="button" data-action="time-generate-shot" data-kind="pad" data-node-id="${escapeHtml(node.id)}" data-index="${index}">Generate</button>
              </div>
              <div class="time-pad-mix">
                <label>Vol <input class="time-pad-param" data-node-id="${escapeHtml(node.id)}" data-pad-index="${index}" data-param="volume" type="range" min="0" max="2" step="0.01" value="${escapeHtml(pad.volume ?? 1)}" /></label>
                <label>Pan <input class="time-pad-param" data-node-id="${escapeHtml(node.id)}" data-pad-index="${index}" data-param="pan" type="range" min="-1" max="1" step="0.01" value="${escapeHtml(pad.pan ?? 0)}" /></label>
              </div>
            </section>
          `;
        }).join("")}
      </div>
    </article>
  `;
}

function timeSourceControlsMarkup(node, slot, kind, index = 0, { prompt = false, generate = false } = {}) {
  const asset = canvasAssetById(slot?.assetId);
  return `
    <section class="time-lane">
      <div class="time-row-head">
        <div>
          <span class="time-lane-name">${escapeHtml(slot?.label || "Source")}</span>
          <small class="time-clock-readout">${escapeHtml(timeAssetLabel(asset))}</small>
        </div>
        <div class="time-row-tools">
          <button class="time-action" type="button" data-action="time-assign-selected" data-kind="${escapeHtml(kind)}" data-node-id="${escapeHtml(node.id)}" data-index="${index}">Assign</button>
          ${generate ? `<button class="time-action" type="button" data-action="time-generate-shot" data-kind="${escapeHtml(kind)}" data-node-id="${escapeHtml(node.id)}" data-index="${index}">Generate</button>` : ""}
        </div>
      </div>
      ${prompt ? `<input class="time-prompt-input time-source-prompt" data-node-id="${escapeHtml(node.id)}" data-kind="${escapeHtml(kind)}" value="${escapeHtml(slot?.prompt || node.prompt || "")}" placeholder="one-shot prompt" />` : ""}
      <div class="time-lane-mix">
        <label>Vol <input class="time-source-param" data-node-id="${escapeHtml(node.id)}" data-kind="${escapeHtml(kind)}" data-param="volume" type="range" min="0" max="2" step="0.01" value="${escapeHtml(slot?.volume ?? 1)}" /></label>
        <label>Pan <input class="time-source-param" data-node-id="${escapeHtml(node.id)}" data-kind="${escapeHtml(kind)}" data-param="pan" type="range" min="-1" max="1" step="0.01" value="${escapeHtml(slot?.pan ?? 0)}" /></label>
      </div>
    </section>
  `;
}

function canvasSlicerMarkup(node, selected, style) {
  node = normalizeTimeNode(node);
  const selectedSlice = node.slices?.[node.selectedSlice || 0];
  const selectedSliceAsset = canvasAssetById(selectedSlice?.assetId);
  return `
    <article class="canvas-node time-node${selected}" data-node-id="${escapeHtml(node.id)}" style="${style}">
      <div class="time-head">
        <div>
          <span>Clocked dissection</span>
          <strong>${escapeHtml(node.label || "Slicer")}</strong>
          <small class="time-clock-readout">${escapeHtml(canvasTimeClockReadout())} | ${node.sliceCount} slices</small>
        </div>
        <div class="time-node-actions">
          <button class="time-action primary" type="button" data-action="time-render-node" data-node-id="${escapeHtml(node.id)}">Render</button>
          <button class="prompt-node-icon delete" type="button" data-action="canvas-delete-node" data-node-id="${escapeHtml(node.id)}" title="Delete" aria-label="Delete"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M18 6 6 18"/><path d="M6 6l12 12"/></svg></button>
        </div>
      </div>
      <div class="time-node-body">
        ${timeSourceControlsMarkup(node, node.source, "slicer_source")}
        <div class="time-control-row">
          <label>Slices <input class="time-node-setting" data-node-id="${escapeHtml(node.id)}" data-field="sliceCount" type="number" min="2" max="64" step="1" value="${escapeHtml(node.sliceCount)}" /></label>
          <label>Order
            <select class="time-node-setting" data-node-id="${escapeHtml(node.id)}" data-field="playMode">
              <option value="original"${node.playMode === "original" ? " selected" : ""}>Original</option>
              <option value="reverse"${node.playMode === "reverse" ? " selected" : ""}>Reverse</option>
              <option value="skip"${node.playMode === "skip" ? " selected" : ""}>Skip odd</option>
            </select>
          </label>
        </div>
        <div class="time-grid">
          ${(node.slices || []).map((slice, index) => `
            <button class="time-step${slice.enabled ? " active" : ""}${node.selectedSlice === index ? " selected" : ""}" type="button" data-action="time-toggle-slice" data-node-id="${escapeHtml(node.id)}" data-slice-index="${index}" title="Slice ${index + 1}"></button>
          `).join("")}
        </div>
        <div class="time-control-row">
          <label>Velocity <input class="time-slice-param" data-node-id="${escapeHtml(node.id)}" data-param="velocity" type="range" min="0" max="2" step="0.01" value="${escapeHtml(selectedSlice?.velocity ?? 1)}" /></label>
          <button class="time-action${selectedSlice?.reverse ? " active" : ""}" type="button" data-action="time-slice-reverse" data-node-id="${escapeHtml(node.id)}">Reverse Slice</button>
          <button class="time-action" type="button" data-action="time-mutate-slice" data-node-id="${escapeHtml(node.id)}">Mutate Slice</button>
        </div>
        <small class="time-clock-readout">${selectedSliceAsset ? `Replacement: ${escapeHtml(timeAssetLabel(selectedSliceAsset))}` : "Selected slice uses source window"}</small>
      </div>
    </article>
  `;
}

function melodyStepNote(node, step) {
  const rootMidi = midiFromNoteName(node.rootNote || "C3");
  const scale = TIME_SCALE_INTERVALS[node.scale] || TIME_SCALE_INTERVALS.minor;
  const degree = Math.max(0, Math.round(Number(step?.degree) || 0));
  const octave = Math.round(Number(step?.octave) || 0);
  const semitone = scale[degree % scale.length] + 12 * (Math.floor(degree / scale.length) + octave);
  return noteNameFromMidi(rootMidi + semitone);
}

function melodyDegreeOptions(node, selectedDegree) {
  const scale = TIME_SCALE_INTERVALS[node.scale] || TIME_SCALE_INTERVALS.minor;
  return Array.from({ length: Math.min(14, scale.length * 2) }, (_, degree) => {
    const label = melodyStepNote(node, { degree, octave: 0 });
    return `<option value="${degree}"${Number(selectedDegree) === degree ? " selected" : ""}>${escapeHtml(label)}</option>`;
  }).join("");
}

function canvasMelodyMakerMarkup(node, selected, style) {
  node = normalizeTimeNode(node);
  const selectedStep = node.steps?.[node.selectedStep || 0] || node.steps?.[0];
  return `
    <article class="canvas-node time-node${selected}" data-node-id="${escapeHtml(node.id)}" style="${style}">
      <div class="time-head">
        <div>
          <span>Clocked cultivar</span>
          <strong>${escapeHtml(node.label || "Melody Maker")}</strong>
          <small class="time-clock-readout">${escapeHtml(canvasTimeClockReadout())} | ${escapeHtml(node.rootNote)} ${escapeHtml(node.scale)}</small>
        </div>
        <div class="time-node-actions">
          <button class="time-action primary" type="button" data-action="time-render-node" data-node-id="${escapeHtml(node.id)}">Render</button>
          <button class="prompt-node-icon delete" type="button" data-action="canvas-delete-node" data-node-id="${escapeHtml(node.id)}" title="Delete" aria-label="Delete"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M18 6 6 18"/><path d="M6 6l12 12"/></svg></button>
        </div>
      </div>
      <div class="time-node-body">
        ${timeSourceControlsMarkup(node, node.root, "melody_root", 0, { prompt: true, generate: true })}
        <div class="time-control-row">
          <label>Root <input class="time-node-setting" data-node-id="${escapeHtml(node.id)}" data-field="rootNote" value="${escapeHtml(node.rootNote)}" /></label>
          <label>Scale
            <select class="time-node-setting" data-node-id="${escapeHtml(node.id)}" data-field="scale">
              ${Object.keys(TIME_SCALE_INTERVALS).map((scale) => `<option value="${scale}"${node.scale === scale ? " selected" : ""}>${escapeHtml(scale)}</option>`).join("")}
            </select>
          </label>
        </div>
        <div class="time-grid">
          ${(node.steps || []).map((step, index) => `
            <button class="time-step${step.enabled ? " active" : ""}${node.selectedStep === index ? " selected" : ""}" type="button" data-action="time-toggle-melody-step" data-node-id="${escapeHtml(node.id)}" data-step-index="${index}" title="${escapeHtml(melodyStepNote(node, step))}"></button>
          `).join("")}
        </div>
        <div class="time-control-row">
          <label>Note
            <select class="time-melody-step-param" data-node-id="${escapeHtml(node.id)}" data-param="degree">${melodyDegreeOptions(node, selectedStep?.degree || 0)}</select>
          </label>
          <label>Oct <input class="time-melody-step-param" data-node-id="${escapeHtml(node.id)}" data-param="octave" type="number" min="-2" max="3" step="1" value="${escapeHtml(selectedStep?.octave ?? 0)}" /></label>
          <label>Dur <input class="time-melody-step-param" data-node-id="${escapeHtml(node.id)}" data-param="durationSteps" type="number" min="1" max="4" step="1" value="${escapeHtml(selectedStep?.durationSteps ?? 1)}" /></label>
          <label>Vel <input class="time-melody-step-param" data-node-id="${escapeHtml(node.id)}" data-param="velocity" type="range" min="0" max="2" step="0.01" value="${escapeHtml(selectedStep?.velocity ?? 1)}" /></label>
        </div>
      </div>
    </article>
  `;
}

function canvasEuclideanColonyMarkup(node, selected, style) {
  node = normalizeTimeNode(node);
  return `
    <article class="canvas-node time-node${selected}" data-node-id="${escapeHtml(node.id)}" style="${style}">
      <div class="time-head">
        <div>
          <span>Generative rhythm</span>
          <strong>${escapeHtml(node.label || "Euclidean Colony")}</strong>
          <small class="time-clock-readout">${escapeHtml(canvasTimeClockReadout())} | ${node.pulses}/${node.steps}</small>
        </div>
        <div class="time-node-actions">
          <button class="time-action primary" type="button" data-action="time-render-node" data-node-id="${escapeHtml(node.id)}">Render</button>
          <button class="prompt-node-icon delete" type="button" data-action="canvas-delete-node" data-node-id="${escapeHtml(node.id)}" title="Delete" aria-label="Delete"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M18 6 6 18"/><path d="M6 6l12 12"/></svg></button>
        </div>
      </div>
      <div class="time-node-body">
        ${timeSourceControlsMarkup(node, node.source, "euclidean_source", 0, { prompt: true, generate: true })}
        <div class="time-control-row">
          <label>Steps <input class="time-node-setting" data-node-id="${escapeHtml(node.id)}" data-field="steps" type="number" min="1" max="64" step="1" value="${escapeHtml(node.steps)}" /></label>
          <label>Pulses <input class="time-node-setting" data-node-id="${escapeHtml(node.id)}" data-field="pulses" type="number" min="0" max="64" step="1" value="${escapeHtml(node.pulses)}" /></label>
          <label>Rotate <input class="time-node-setting" data-node-id="${escapeHtml(node.id)}" data-field="rotation" type="number" min="0" max="64" step="1" value="${escapeHtml(node.rotation)}" /></label>
          <label>Prob <input class="time-node-setting" data-node-id="${escapeHtml(node.id)}" data-field="probability" type="range" min="0" max="1" step="0.01" value="${escapeHtml(node.probability)}" /></label>
        </div>
        <div class="time-grid">
          ${euclideanPattern(node.steps, node.pulses, node.rotation).map((active, index) => `<span class="time-step${active ? " active" : ""}" title="Pulse ${index + 1}"></span>`).join("")}
        </div>
      </div>
    </article>
  `;
}

function canvasClockedLooperMarkup(node, selected, style) {
  node = normalizeTimeNode(node);
  return `
    <article class="canvas-node time-node${selected}" data-node-id="${escapeHtml(node.id)}" style="${style}">
      <div class="time-head">
        <div>
          <span>Clocked propagation</span>
          <strong>${escapeHtml(node.label || "Clocked Looper")}</strong>
          <small class="time-clock-readout">${escapeHtml(canvasTimeClockReadout())} | ${node.targetBars} bar segment</small>
        </div>
        <div class="time-node-actions">
          <button class="time-action" type="button" data-action="time-fit-bars" data-node-id="${escapeHtml(node.id)}">Fit Bars</button>
          <button class="time-action primary" type="button" data-action="time-render-node" data-node-id="${escapeHtml(node.id)}">Render</button>
          <button class="prompt-node-icon delete" type="button" data-action="canvas-delete-node" data-node-id="${escapeHtml(node.id)}" title="Delete" aria-label="Delete"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M18 6 6 18"/><path d="M6 6l12 12"/></svg></button>
        </div>
      </div>
      <div class="time-node-body">
        ${timeSourceControlsMarkup(node, node.source, "looper_source")}
        <div class="time-control-row">
          <label>Bars <input class="time-node-setting" data-node-id="${escapeHtml(node.id)}" data-field="targetBars" type="number" min="1" max="128" step="1" value="${escapeHtml(node.targetBars)}" /></label>
          <label>Mode
            <select class="time-node-setting" data-node-id="${escapeHtml(node.id)}" data-field="mode">
              <option value="repeat"${node.mode === "repeat" ? " selected" : ""}>Repeat</option>
              <option value="crop"${node.mode === "crop" ? " selected" : ""}>Crop</option>
            </select>
          </label>
        </div>
      </div>
    </article>
  `;
}

function canvasProbabilityGateMarkup(node, selected, style) {
  node = normalizeTimeNode(node);
  return `
    <article class="canvas-node time-node${selected}" data-node-id="${escapeHtml(node.id)}" style="${style}">
      <div class="time-head">
        <div>
          <span>Clocked probability</span>
          <strong>${escapeHtml(node.label || "Probability Gate")}</strong>
          <small class="time-clock-readout">${escapeHtml(canvasTimeClockReadout())} | ${Math.round(node.probability * 100)}%</small>
        </div>
        <div class="time-node-actions">
          <button class="time-action primary" type="button" data-action="time-render-node" data-node-id="${escapeHtml(node.id)}">Render</button>
          <button class="prompt-node-icon delete" type="button" data-action="canvas-delete-node" data-node-id="${escapeHtml(node.id)}" title="Delete" aria-label="Delete"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M18 6 6 18"/><path d="M6 6l12 12"/></svg></button>
        </div>
      </div>
      <div class="time-node-body">
        ${timeSourceControlsMarkup(node, node.source, "probability_source", 0, { prompt: true, generate: true })}
        <div class="time-control-row">
          <label>Steps <input class="time-node-setting" data-node-id="${escapeHtml(node.id)}" data-field="steps" type="number" min="1" max="64" step="1" value="${escapeHtml(node.steps)}" /></label>
          <label>Prob <input class="time-node-setting" data-node-id="${escapeHtml(node.id)}" data-field="probability" type="range" min="0" max="1" step="0.01" value="${escapeHtml(node.probability)}" /></label>
          <label>Vel <input class="time-node-setting" data-node-id="${escapeHtml(node.id)}" data-field="velocity" type="range" min="0" max="2" step="0.01" value="${escapeHtml(node.velocity)}" /></label>
          <label>Seed <input class="time-node-setting" data-node-id="${escapeHtml(node.id)}" data-field="seed" type="number" step="1" value="${escapeHtml(node.seed)}" /></label>
        </div>
        <div class="time-grid">
          ${probabilityGatePattern(node).map((active, index) => `<span class="time-step${active ? " active" : ""}" title="Gate ${index + 1}"></span>`).join("")}
        </div>
      </div>
    </article>
  `;
}

function canvasClockDividerMarkup(node, selected, style) {
  node = normalizeTimeNode(node);
  return `
    <article class="canvas-node time-node${selected}" data-node-id="${escapeHtml(node.id)}" style="${style}">
      <div class="time-head">
        <div>
          <span>Timing utility</span>
          <strong>${escapeHtml(node.label || "Clock Divider")}</strong>
          <small class="time-clock-readout">${escapeHtml(canvasTimeClockReadout())} | ${escapeHtml(node.division)}</small>
        </div>
        <div class="time-node-actions">
          <button class="time-action primary" type="button" data-action="time-render-node" data-node-id="${escapeHtml(node.id)}">Render</button>
          <button class="prompt-node-icon delete" type="button" data-action="canvas-delete-node" data-node-id="${escapeHtml(node.id)}" title="Delete" aria-label="Delete"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M18 6 6 18"/><path d="M6 6l12 12"/></svg></button>
        </div>
      </div>
      <div class="time-node-body">
        ${timeSourceControlsMarkup(node, node.source, "divider_source", 0, { prompt: true, generate: true })}
        <div class="time-control-row">
          <label>Division
            <select class="time-node-setting" data-node-id="${escapeHtml(node.id)}" data-field="division">
              ${Object.keys(TIME_SNAP_TICKS).map((division) => `<option value="${division}"${node.division === division ? " selected" : ""}>${escapeHtml(division)}</option>`).join("")}
            </select>
          </label>
          <label>Skip <input class="time-node-setting" data-node-id="${escapeHtml(node.id)}" data-field="skipEvery" type="number" min="0" max="16" step="1" value="${escapeHtml(node.skipEvery)}" /></label>
          <label>Vel <input class="time-node-setting" data-node-id="${escapeHtml(node.id)}" data-field="velocity" type="range" min="0" max="2" step="0.01" value="${escapeHtml(node.velocity)}" /></label>
        </div>
      </div>
    </article>
  `;
}

function canvasHumanizerMarkup(node, selected, style) {
  node = normalizeTimeNode(node);
  return `
    <article class="canvas-node time-node${selected}" data-node-id="${escapeHtml(node.id)}" style="${style}">
      <div class="time-head">
        <div>
          <span>Clocked humanizer</span>
          <strong>${escapeHtml(node.label || "Humanizer")}</strong>
          <small class="time-clock-readout">${escapeHtml(canvasTimeClockReadout())} | ${node.steps} steps</small>
        </div>
        <div class="time-node-actions">
          <button class="time-action primary" type="button" data-action="time-render-node" data-node-id="${escapeHtml(node.id)}">Render</button>
          <button class="prompt-node-icon delete" type="button" data-action="canvas-delete-node" data-node-id="${escapeHtml(node.id)}" title="Delete" aria-label="Delete"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M18 6 6 18"/><path d="M6 6l12 12"/></svg></button>
        </div>
      </div>
      <div class="time-node-body">
        ${timeSourceControlsMarkup(node, node.source, "humanizer_source", 0, { prompt: true, generate: true })}
        <div class="time-control-row">
          <label>Steps <input class="time-node-setting" data-node-id="${escapeHtml(node.id)}" data-field="steps" type="number" min="1" max="64" step="1" value="${escapeHtml(node.steps)}" /></label>
          <label>Density <input class="time-node-setting" data-node-id="${escapeHtml(node.id)}" data-field="density" type="range" min="0" max="1" step="0.01" value="${escapeHtml(node.density)}" /></label>
          <label>Timing <input class="time-node-setting" data-node-id="${escapeHtml(node.id)}" data-field="timing" type="range" min="0" max="0.5" step="0.01" value="${escapeHtml(node.timing)}" /></label>
          <label>Vel Var <input class="time-node-setting" data-node-id="${escapeHtml(node.id)}" data-field="velocitySpread" type="range" min="0" max="1" step="0.01" value="${escapeHtml(node.velocitySpread)}" /></label>
        </div>
      </div>
    </article>
  `;
}

function canvasPolymeterMarkup(node, selected, style) {
  node = normalizeTimeNode(node);
  return `
    <article class="canvas-node time-node${selected}" data-node-id="${escapeHtml(node.id)}" style="${style}">
      <div class="time-head">
        <div>
          <span>Polymeter utility</span>
          <strong>${escapeHtml(node.label || "Polymeter")}</strong>
          <small class="time-clock-readout">${escapeHtml(canvasTimeClockReadout())}</small>
        </div>
        <div class="time-node-actions">
          <button class="time-action primary" type="button" data-action="time-render-node" data-node-id="${escapeHtml(node.id)}">Render</button>
          <button class="prompt-node-icon delete" type="button" data-action="canvas-delete-node" data-node-id="${escapeHtml(node.id)}" title="Delete" aria-label="Delete"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M18 6 6 18"/><path d="M6 6l12 12"/></svg></button>
        </div>
      </div>
      <div class="time-node-body">
        ${(node.lanes || []).map((lane, index) => `
          ${timeSourceControlsMarkup(node, lane, `polymeter_lane_${index}`, index, { prompt: true, generate: true })}
          <div class="time-control-row">
            <label>Steps <input class="time-poly-param" data-node-id="${escapeHtml(node.id)}" data-lane-index="${index}" data-param="steps" type="number" min="1" max="32" step="1" value="${escapeHtml(lane.steps)}" /></label>
            <label>Pulses <input class="time-poly-param" data-node-id="${escapeHtml(node.id)}" data-lane-index="${index}" data-param="pulses" type="number" min="0" max="32" step="1" value="${escapeHtml(lane.pulses)}" /></label>
            <label>Rotate <input class="time-poly-param" data-node-id="${escapeHtml(node.id)}" data-lane-index="${index}" data-param="rotation" type="number" min="0" max="32" step="1" value="${escapeHtml(lane.rotation)}" /></label>
          </div>
        `).join("")}
      </div>
    </article>
  `;
}

function canvasIncubationTimelineMarkup(node, selected, style) {
  node = normalizeTimeNode(node);
  const derived = timeClockDerived();
  const totalBeats = Math.max(1, derived.totalBeats || 16);
  const sources = node.timelineSources || [];
  const events = node.timelineEvents || [];
  const sourceOptions = sources.map((source) => {
    const asset = canvasAssetById(source.assetId);
    const label = source.label || timeAssetLabel(asset);
    return `<option value="${escapeHtml(source.id)}">${escapeHtml(label)}</option>`;
  }).join("");
  const beatMarkers = Array.from({ length: Math.min(33, Math.round(totalBeats) + 1) }, (_, index) => {
    const beat = index * Math.max(1, Math.ceil(totalBeats / 32));
    if (beat > totalBeats) return "";
    return `<span style="left:${(beat / totalBeats) * 100}%">${beat + 1}</span>`;
  }).join("");
  const bars = events.map((event, index) => {
    const source = sources.find((item) => item.id === event.sourceId);
    const left = Math.max(0, Math.min(100, (event.startBeat / totalBeats) * 100));
    const width = Math.max(3, Math.min(100 - left, (event.durationBeats / totalBeats) * 100));
    const top = 12 + (index % 4) * 28;
    const active = event.id === node.selectedEventId ? " active" : "";
    return `<button class="incubation-event-bar${active}" type="button" data-action="time-incubation-select-event" data-node-id="${escapeHtml(node.id)}" data-event-id="${escapeHtml(event.id)}" style="left:${left}%;width:${width}%;top:${top}px" title="${escapeHtml(event.label)}">${escapeHtml(source?.label || event.label)}</button>`;
  }).join("");
  return `
    <article class="canvas-node time-node incubation-node${selected}" data-node-id="${escapeHtml(node.id)}" style="${style}">
      <div class="time-head">
        <div>
          <span>Timeline</span>
          <strong>${escapeHtml(node.label || "Incubation Timeline")}</strong>
          <small class="time-clock-readout">${escapeHtml(canvasTimeClockReadout())} | ${events.length} event(s)</small>
        </div>
        <div class="time-node-actions">
          <button class="time-action" type="button" data-action="time-incubation-add-selected" data-node-id="${escapeHtml(node.id)}">Place Selected</button>
          <button class="time-action" type="button" data-action="time-incubation-add-event" data-node-id="${escapeHtml(node.id)}">Add Event</button>
          <button class="time-action primary" type="button" data-action="time-render-node" data-node-id="${escapeHtml(node.id)}">Render</button>
          <button class="prompt-node-icon delete" type="button" data-action="canvas-delete-node" data-node-id="${escapeHtml(node.id)}" title="Delete" aria-label="Delete"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M18 6 6 18"/><path d="M6 6l12 12"/></svg></button>
        </div>
      </div>
      <div class="time-node-body incubation-body">
        <div class="incubation-timeline-strip" style="min-height:${Math.max(132, 36 + Math.min(4, Math.max(1, events.length)) * 28)}px">
          <div class="incubation-beat-markers">${beatMarkers}</div>
          ${bars || `<span class="incubation-empty">No events</span>`}
        </div>
        <div class="incubation-source-list">
          ${sources.map((source, index) => {
            const asset = canvasAssetById(source.assetId);
            return `
              <div class="incubation-source-row">
                <strong>${escapeHtml(source.label || timeAssetLabel(asset))}</strong>
                <label>Gain <input class="time-incubation-source-param" data-node-id="${escapeHtml(node.id)}" data-source-id="${escapeHtml(source.id)}" data-param="volume" type="range" min="0" max="2" step="0.01" value="${escapeHtml(source.volume)}" /></label>
                <label>Pan <input class="time-incubation-source-param" data-node-id="${escapeHtml(node.id)}" data-source-id="${escapeHtml(source.id)}" data-param="pan" type="range" min="-1" max="1" step="0.01" value="${escapeHtml(source.pan)}" /></label>
                <button class="time-mini-toggle" type="button" data-action="time-incubation-remove-source" data-node-id="${escapeHtml(node.id)}" data-source-id="${escapeHtml(source.id)}">Remove</button>
                <small>${escapeHtml(asset?.audioPath || "unassigned")}</small>
              </div>
            `;
          }).join("") || `<span class="incubation-empty">Select a sound and place it.</span>`}
        </div>
        <div class="incubation-event-list">
          ${events.map((event) => `
            <div class="incubation-event-row${event.id === node.selectedEventId ? " active" : ""}">
              <input class="time-incubation-event-param" data-node-id="${escapeHtml(node.id)}" data-event-id="${escapeHtml(event.id)}" data-param="label" value="${escapeHtml(event.label)}" />
              <select class="time-incubation-event-param" data-node-id="${escapeHtml(node.id)}" data-event-id="${escapeHtml(event.id)}" data-param="sourceId">${sourceOptions.replace(`value="${escapeHtml(event.sourceId)}"`, `value="${escapeHtml(event.sourceId)}" selected`)}</select>
              <label>Beat <input class="time-incubation-event-param" data-node-id="${escapeHtml(node.id)}" data-event-id="${escapeHtml(event.id)}" data-param="startBeat" type="number" min="0" max="${escapeHtml(totalBeats)}" step="0.25" value="${escapeHtml(event.startBeat)}" /></label>
              <label>Len <input class="time-incubation-event-param" data-node-id="${escapeHtml(node.id)}" data-event-id="${escapeHtml(event.id)}" data-param="durationBeats" type="number" min="0.25" max="${escapeHtml(totalBeats)}" step="0.25" value="${escapeHtml(event.durationBeats)}" /></label>
              <label>Gain <input class="time-incubation-event-param" data-node-id="${escapeHtml(node.id)}" data-event-id="${escapeHtml(event.id)}" data-param="gain" type="range" min="0" max="2" step="0.01" value="${escapeHtml(event.gain)}" /></label>
              <label>Pan <input class="time-incubation-event-param" data-node-id="${escapeHtml(node.id)}" data-event-id="${escapeHtml(event.id)}" data-param="pan" type="range" min="-1" max="1" step="0.01" value="${escapeHtml(event.pan)}" /></label>
              <label>Pitch <input class="time-incubation-event-param" data-node-id="${escapeHtml(node.id)}" data-event-id="${escapeHtml(event.id)}" data-param="pitchSemitones" type="number" min="-48" max="48" step="0.1" value="${escapeHtml(event.pitchSemitones)}" /></label>
              <label>In <input class="time-incubation-event-param" data-node-id="${escapeHtml(node.id)}" data-event-id="${escapeHtml(event.id)}" data-param="sourceStartSec" type="number" min="0" step="0.01" value="${escapeHtml(event.sourceStartSec ?? "")}" /></label>
              <label>Out <input class="time-incubation-event-param" data-node-id="${escapeHtml(node.id)}" data-event-id="${escapeHtml(event.id)}" data-param="sourceEndSec" type="number" min="0" step="0.01" value="${escapeHtml(event.sourceEndSec ?? "")}" /></label>
              <button class="time-mini-toggle${event.reverse ? " active" : ""}" type="button" data-action="time-incubation-toggle-reverse" data-node-id="${escapeHtml(node.id)}" data-event-id="${escapeHtml(event.id)}">Rev</button>
              <button class="time-mini-toggle" type="button" data-action="time-incubation-duplicate-event" data-node-id="${escapeHtml(node.id)}" data-event-id="${escapeHtml(event.id)}">Dup</button>
              <button class="time-mini-toggle" type="button" data-action="time-incubation-delete-event" data-node-id="${escapeHtml(node.id)}" data-event-id="${escapeHtml(event.id)}">Del</button>
            </div>
          `).join("")}
        </div>
      </div>
    </article>
  `;
}

function canvasRenderBusMarkup(node, selected, style) {
  node = normalizeTimeNode(node);
  const modules = renderBusTargetNodes(node);
  const allModules = canvasTimeNodes().filter((item) => item.id !== node.id && item.timeType !== "render_bus");
  const selectedIds = new Set(node.moduleIds || []);
  return `
    <article class="canvas-node time-node${selected}" data-node-id="${escapeHtml(node.id)}" style="${style}">
      <div class="time-head">
        <div>
          <span>Harvest bus</span>
          <strong>${escapeHtml(node.label || "Render Bus")}</strong>
          <small class="time-clock-readout">${escapeHtml(canvasTimeClockReadout())} | ${modules.length} module(s)</small>
        </div>
        <div class="time-node-actions">
          <button class="time-action primary" type="button" data-action="time-render-node" data-node-id="${escapeHtml(node.id)}">Render Bus</button>
          <button class="prompt-node-icon delete" type="button" data-action="canvas-delete-node" data-node-id="${escapeHtml(node.id)}" title="Delete" aria-label="Delete"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M18 6 6 18"/><path d="M6 6l12 12"/></svg></button>
        </div>
      </div>
      <div class="time-node-body">
        <div class="time-control-row">
          <label>Mode
            <select class="time-node-setting" data-node-id="${escapeHtml(node.id)}" data-field="includeMode">
              <option value="all"${node.includeMode === "all" ? " selected" : ""}>All time modules</option>
              <option value="selected"${node.includeMode === "selected" ? " selected" : ""}>Selected list</option>
            </select>
          </label>
        </div>
        <div class="time-bus-list">
          ${(node.includeMode === "selected" ? allModules : modules).map((item) => `
            ${node.includeMode === "selected"
              ? `<button class="time-mini-toggle${selectedIds.has(item.id) ? " active" : ""}" type="button" data-action="time-bus-toggle-target" data-node-id="${escapeHtml(node.id)}" data-target-node-id="${escapeHtml(item.id)}" title="${escapeHtml(item.label || timeModuleLabel(item.timeType))}">${escapeHtml((item.label || timeModuleLabel(item.timeType)).slice(0, 10))}</button>`
              : `<span>${escapeHtml(item.label || timeModuleLabel(item.timeType))}</span>`}
          `).join("") || "<span>No renderable modules</span>"}
        </div>
      </div>
    </article>
  `;
}

function canvasRenderMacrosMarkup(node, selected, style) {
  node = normalizeTimeNode(node);
  const selectedSound = canvasSelectedSoundNode() || (canvasLastSelectedSoundNodeId ? canvasNodes.find((item) => item.id === canvasLastSelectedSoundNodeId) : null);
  const soundLabel = selectedSound?.label || "selected source";
  const candidateCount = canvasCandidates.filter((candidate) => candidate.rating !== "reject").length;
  const macros = [
    ["loop_doctor", "Loop Doctor", "repair seams"],
    ["mutate_selected", "Mutate", "variation from source"],
    ["continue_selected", "Continue", "extend current sound"],
    ["heal_region", "Heal Region", "inpaint selected mask"],
    ["breed_selected", "Breed", "selected candidates"],
    ["make_family", "Family", "loopable variants"],
    ["cull_similar", "Cull", "remove duplicates"],
    ["find_loopable", "Loopable", "spotlight best loop"],
  ];
  return `
    <article class="canvas-node time-node render-macros-node${selected}" data-node-id="${escapeHtml(node.id)}" style="${style}" data-help="One-click macro actions built from module chains.">
      <div class="time-head">
        <div>
          <span>Render macros</span>
          <strong>${escapeHtml(node.label || "Render Macros")}</strong>
          <small class="time-clock-readout">${escapeHtml(soundLabel)} | ${candidateCount} candidate(s)</small>
        </div>
        <div class="time-node-actions">
          <button class="prompt-node-icon delete" type="button" data-action="canvas-delete-node" data-node-id="${escapeHtml(node.id)}" title="Delete" aria-label="Delete"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M18 6 6 18"/><path d="M6 6l12 12"/></svg></button>
        </div>
      </div>
      <div class="time-node-body">
        <div class="render-macro-grid">
          ${macros.map(([macro, label, detail]) => `
            <button class="render-macro-button" type="button" data-action="canvas-render-macro" data-macro="${escapeHtml(macro)}" data-node-id="${escapeHtml(node.id)}">
              <strong>${escapeHtml(label)}</strong>
              <span>${escapeHtml(detail)}</span>
            </button>
          `).join("")}
        </div>
      </div>
    </article>
  `;
}

function canvasTimeNodeMarkup(node, selected, style) {
  let markup = "";
  if (node.timeType === "trigger_pads") markup = canvasTriggerPadsMarkup(node, selected, style);
  else if (node.timeType === "slicer") markup = canvasSlicerMarkup(node, selected, style);
  else if (node.timeType === "melody_maker") markup = canvasMelodyMakerMarkup(node, selected, style);
  else if (node.timeType === "euclidean_colony") markup = canvasEuclideanColonyMarkup(node, selected, style);
  else if (node.timeType === "clocked_looper") markup = canvasClockedLooperMarkup(node, selected, style);
  else if (node.timeType === "probability_gate") markup = canvasProbabilityGateMarkup(node, selected, style);
  else if (node.timeType === "clock_divider") markup = canvasClockDividerMarkup(node, selected, style);
  else if (node.timeType === "humanizer") markup = canvasHumanizerMarkup(node, selected, style);
  else if (node.timeType === "polymeter") markup = canvasPolymeterMarkup(node, selected, style);
  else if (node.timeType === "incubation_timeline") markup = canvasIncubationTimelineMarkup(node, selected, style);
  else if (node.timeType === "render_bus") markup = canvasRenderBusMarkup(node, selected, style);
  else if (node.timeType === "render_macros") markup = canvasRenderMacrosMarkup(node, selected, style);
  else markup = canvasColonySequencerMarkup(node, selected, style);
  return canvasInjectModuleTabs(markup, node, { bodyClass: node.timeType === "trigger_pads" ? "time-pads-grid" : "time-node-body" });
}

function geneticTraitOptionsMarkup(selected) {
  return Object.entries(GENETIC_IDENTITY_TRAITS)
    .map(([value, config]) => `<option value="${escapeHtml(value)}"${selected === value ? " selected" : ""}>${escapeHtml(config.label)}</option>`)
    .join("");
}

function geneticModeOptionsMarkup(selected) {
  return Object.entries(GENETIC_SEQUENCER_MODES)
    .map(([value, label]) => `<option value="${escapeHtml(value)}"${selected === value ? " selected" : ""}>${escapeHtml(label)}</option>`)
    .join("");
}

function geneticActionOptionsMarkup(selected) {
  return Object.entries(GENETIC_SEQUENCER_ACTIONS)
    .map(([value, label]) => `<option value="${escapeHtml(value)}"${selected === value ? " selected" : ""}>${escapeHtml(label)}</option>`)
    .join("");
}

function canvasIdentityExtractorMarkup(node, selected, style) {
  node = normalizeGeneticNode(node);
  const trait = GENETIC_IDENTITY_TRAITS[node.trait] || GENETIC_IDENTITY_TRAITS.timbre;
  const sourceSummary = canvasGeneticSourceSummary(node);
  const identity = node.identity || null;
  const confidence = identity?.confidence ?? node.confidence ?? 0;
  return `
    <article class="canvas-node time-node genetic-node identity-node${selected}" data-node-id="${escapeHtml(node.id)}" style="${style}" data-help="Extract reusable identity traits from a source.">
      ${canvasIoPortsMarkup(node.id, { input: true, output: true })}
      <div class="time-head">
        <div>
          <span>Genetic identity</span>
          <strong>${escapeHtml(node.label || "Identity Extractor")}</strong>
          <small class="time-clock-readout">${escapeHtml(trait.label)} | ${escapeHtml(sourceSummary)}</small>
        </div>
        <div class="time-node-actions">
          <button class="time-action" type="button" data-action="canvas-genetic-route-selected" data-node-id="${escapeHtml(node.id)}">Route</button>
          <button class="time-action primary" type="button" data-action="canvas-genetic-extract" data-node-id="${escapeHtml(node.id)}">Extract</button>
          <button class="prompt-node-icon delete" type="button" data-action="canvas-delete-node" data-node-id="${escapeHtml(node.id)}" title="Delete" aria-label="Delete"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M18 6 6 18"/><path d="M6 6l12 12"/></svg></button>
        </div>
      </div>
      <div class="time-node-body genetic-node-body">
        <div class="time-control-row">
          <label>Trait
            <select class="genetic-node-setting" data-node-id="${escapeHtml(node.id)}" data-field="trait">
              ${geneticTraitOptionsMarkup(node.trait)}
            </select>
          </label>
          <label>Strength <input class="genetic-node-setting" data-node-id="${escapeHtml(node.id)}" data-field="strength" type="range" min="0" max="1" step="0.01" value="${escapeHtml(node.strength)}" /></label>
        </div>
        <div class="genetic-trait-card">
          <span>${escapeHtml(trait.short)}</span>
          <strong>${escapeHtml(trait.use)}</strong>
          <small>${escapeHtml(trait.words.join(" / "))}</small>
        </div>
        <div class="genetic-meter-row">
          <span>Confidence</span>
          <div class="genetic-meter"><i style="width:${Math.round(Number(confidence) * 100)}%"></i></div>
          <strong>${Math.round(Number(confidence) * 100)}%</strong>
        </div>
        <div class="genetic-dna-readout">
          ${identity ? escapeHtml(identity.prompt_identity || `${identity.label} extracted`) : "Connect or select a source, then extract DNA."}
        </div>
      </div>
    </article>
  `;
}

function canvasGenerationSequencerMarkup(node, selected, style) {
  node = normalizeGeneticNode(node);
  const selectedStep = node.steps?.[node.selectedStep || 0] || node.steps?.[0];
  const sourceSummary = canvasGeneticSourceSummary(node);
  const incomingCount = canvasIncomingGeneticNodes(node).length;
  return `
    <article class="canvas-node time-node genetic-node generation-sequencer-node${selected}" data-node-id="${escapeHtml(node.id)}" style="${style}" data-help="Procedural sampling machine for generation operations.">
      ${canvasIoPortsMarkup(node.id, { input: true, output: true })}
      <div class="time-head">
        <div>
          <span>Genetic sequencer</span>
          <strong>${escapeHtml(node.label || "Generation Sequencer")}</strong>
          <small class="time-clock-readout">${escapeHtml(GENETIC_SEQUENCER_MODES[node.mode] || "Seed Garden")} | ${escapeHtml(sourceSummary)} | ${incomingCount} identity input(s)</small>
        </div>
        <div class="time-node-actions">
          <button class="time-action" type="button" data-action="canvas-genetic-route-selected" data-node-id="${escapeHtml(node.id)}">Route</button>
          <button class="time-action primary" type="button" data-action="canvas-genetic-run-sequence" data-node-id="${escapeHtml(node.id)}">Run</button>
          <button class="prompt-node-icon delete" type="button" data-action="canvas-delete-node" data-node-id="${escapeHtml(node.id)}" title="Delete" aria-label="Delete"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M18 6 6 18"/><path d="M6 6l12 12"/></svg></button>
        </div>
      </div>
      <div class="time-node-body genetic-node-body">
        <div class="time-control-row">
          <label>Mode
            <select class="genetic-node-setting" data-node-id="${escapeHtml(node.id)}" data-field="mode">
              ${geneticModeOptionsMarkup(node.mode)}
            </select>
          </label>
          <label>Identity
            <select class="genetic-node-setting" data-node-id="${escapeHtml(node.id)}" data-field="identityMode">
              <option value="incoming"${node.identityMode === "incoming" ? " selected" : ""}>Incoming</option>
              <option value="source"${node.identityMode === "source" ? " selected" : ""}>Source</option>
              <option value="hybrid"${node.identityMode === "hybrid" ? " selected" : ""}>Hybrid</option>
            </select>
          </label>
        </div>
        <div class="genetic-step-grid">
          ${(node.steps || []).map((step, index) => `
            <button class="genetic-step${step.enabled !== false ? " active" : ""}${node.selectedStep === index ? " selected" : ""}" type="button" data-action="canvas-genetic-select-step" data-node-id="${escapeHtml(node.id)}" data-step-index="${index}" title="${escapeHtml(GENETIC_SEQUENCER_ACTIONS[step.action] || step.action)}">
              <span>${index + 1}</span>
              <strong>${Math.round(Number(step.probability ?? 1) * 100)}%</strong>
            </button>
          `).join("")}
        </div>
        <div class="time-control-row">
          <label>Action
            <select class="genetic-step-setting" data-node-id="${escapeHtml(node.id)}" data-step-index="${escapeHtml(node.selectedStep || 0)}" data-field="action">
              ${geneticActionOptionsMarkup(selectedStep?.action || "mutate_light")}
            </select>
          </label>
          <label>Chance <input class="genetic-step-setting" data-node-id="${escapeHtml(node.id)}" data-step-index="${escapeHtml(node.selectedStep || 0)}" data-field="probability" type="range" min="0" max="1" step="0.01" value="${escapeHtml(selectedStep?.probability ?? 1)}" /></label>
          <button class="time-mini-toggle${selectedStep?.enabled !== false ? " active" : ""}" type="button" data-action="canvas-genetic-toggle-step" data-node-id="${escapeHtml(node.id)}" data-step-index="${escapeHtml(node.selectedStep || 0)}">Step</button>
        </div>
        <div class="genetic-dna-readout">${escapeHtml(canvasGenerationSequencePayload(node)?.steps?.map((step) => `${step.index}:${step.label}@${Math.round(step.probability * 100)}%`).join("  ") || "")}</div>
      </div>
    </article>
  `;
}

function canvasGeneticNodeMarkup(node, selected, style) {
  node = normalizeGeneticNode(node);
  if (node.geneticType === "generation_sequencer") return canvasGenerationSequencerMarkup(node, selected, style);
  return canvasIdentityExtractorMarkup(node, selected, style);
}

function modulationOptionsMarkup(options, selected) {
  return Object.entries(options)
    .map(([value, label]) => `<option value="${escapeHtml(value)}"${String(selected) === value ? " selected" : ""}>${escapeHtml(label)}</option>`)
    .join("");
}

function modulationArrayOptionsMarkup(options, selected) {
  return options
    .map((value) => `<option value="${escapeHtml(value)}"${String(selected) === value ? " selected" : ""}>${escapeHtml(value)}</option>`)
    .join("");
}

function modulationPreview(node, route) {
  const target = modulationTargetForRoute(route);
  const targetNode = target ? canvasNodes.find((item) => item.id === target.nodeId) : null;
  if (!target || !targetNode) return { base: "", final: "Choose a target.", detail: "" };
  const base = modulationTargetValue(targetNode, target.path);
  if (PROMPT_MODULATOR_TYPES.has(node.modulatorType)) {
    const fragment = modulationPromptFragment(node, route, String(base || ""));
    const final = modulationComposeText(String(base || ""), fragment, route.mode || "append");
    return { base: String(base || ""), final, detail: fragment };
  }
  const final = node.modulatorType === "mutation_modulator"
    ? modulationMutationValue(node, route, target, base)
    : modulationNumericValue(node, route, target, base, { rate: target.modulationRate || "generation", tick: 0, eventIndex: 0 });
  return { base: String(base ?? ""), final: String(final), detail: `${target.label}: ${base ?? "-"} -> ${final}` };
}

function canvasModulatorRouteMarkup(node, route, index) {
  const preview = modulationPreview(node, route);
  const routeLabel = PROMPT_MODULATOR_TYPES.has(node.modulatorType) ? "Text route" : "Value route";
  return `
    <section class="modulator-route">
      <div class="modulator-route-head">
        <label class="modulator-route-enabled">
          <input class="modulator-route-setting" data-node-id="${escapeHtml(node.id)}" data-route-id="${escapeHtml(route.id)}" data-field="enabled" type="checkbox" ${route.enabled !== false ? "checked" : ""} />
          <span>${routeLabel} ${index + 1}</span>
        </label>
        ${(node.routes || []).length > 1 ? `<button class="time-action" type="button" data-action="canvas-modulator-remove-route" data-node-id="${escapeHtml(node.id)}" data-route-id="${escapeHtml(route.id)}">Remove</button>` : ""}
      </div>
      <label>Target
        <select class="modulator-route-target" data-node-id="${escapeHtml(node.id)}" data-route-id="${escapeHtml(route.id)}">
          ${modulationTargetOptions(node.modulatorType, route)}
        </select>
      </label>
      ${PROMPT_MODULATOR_TYPES.has(node.modulatorType) ? `
        <label>Apply
          <select class="modulator-route-setting" data-node-id="${escapeHtml(node.id)}" data-route-id="${escapeHtml(route.id)}" data-field="mode">
            ${modulationArrayOptionsMarkup(PROMPT_MODULATOR_OUTPUT_MODES, route.mode || "append")}
          </select>
        </label>
      ` : `
        <div class="modulator-range-grid">
          <label>Min <input class="modulator-route-setting" data-node-id="${escapeHtml(node.id)}" data-route-id="${escapeHtml(route.id)}" data-field="min" type="number" step="0.01" value="${escapeHtml(route.config?.min ?? "")}" /></label>
          <label>Max <input class="modulator-route-setting" data-node-id="${escapeHtml(node.id)}" data-route-id="${escapeHtml(route.id)}" data-field="max" type="number" step="0.01" value="${escapeHtml(route.config?.max ?? "")}" /></label>
        </div>
        <label>Values <input class="modulator-route-setting" data-node-id="${escapeHtml(node.id)}" data-route-id="${escapeHtml(route.id)}" data-field="steppedValues" value="${escapeHtml(route.config?.steppedValues || "")}" placeholder="0.25, 0.5, 1" /></label>
      `}
      <div class="modulator-preview">
        <span>${escapeHtml(preview.base || "Base empty")}</span>
        <strong>${escapeHtml(preview.final || "No output")}</strong>
      </div>
    </section>
  `;
}

function modulationMatrixSourceOptions(selected) {
  return Object.entries(MATRIX_SOURCE_TYPES)
    .map(([value, label]) => `<option value="${escapeHtml(value)}"${selected === value ? " selected" : ""}>${escapeHtml(label)}</option>`)
    .join("");
}

function modulationMatrixTargetOptions(route = {}) {
  const targets = modulationTargets()
    .filter((target) => target.type === "number" && target.modulationRate === "generation");
  if (!targets.length) return `<option value="">No generation targets</option>`;
  return targets.map((target) => {
    const value = `${target.nodeId}|${target.path}`;
    const selected = target.nodeId === route.targetNodeId && target.path === route.targetPath ? " selected" : "";
    return `<option value="${escapeHtml(value)}"${selected}>${escapeHtml(target.label)}</option>`;
  }).join("");
}

function canvasModMatrixMarkup(node) {
  const routes = node.config?.matrixRoutes || [];
  return `
    <div class="mod-matrix-grid">
      ${routes.map((route, index) => {
        const target = modulationTargetForRoute(route);
        return `
          <section class="mod-matrix-route">
            <div class="modulator-route-head">
              <label class="modulator-route-enabled">
                <input class="modulator-matrix-setting" data-node-id="${escapeHtml(node.id)}" data-route-id="${escapeHtml(route.id)}" data-field="enabled" type="checkbox" ${route.enabled !== false ? "checked" : ""} />
                <span>Route ${index + 1}</span>
              </label>
              ${routes.length > 1 ? `<button class="time-action" type="button" data-action="canvas-modulator-remove-matrix-route" data-node-id="${escapeHtml(node.id)}" data-route-id="${escapeHtml(route.id)}">Remove</button>` : ""}
            </div>
            <label>Source
              <select class="modulator-matrix-setting" data-node-id="${escapeHtml(node.id)}" data-route-id="${escapeHtml(route.id)}" data-field="sourceType">
                ${modulationMatrixSourceOptions(route.sourceType || "lfo_modulator")}
              </select>
            </label>
            <label>Destination
              <select class="modulator-matrix-target" data-node-id="${escapeHtml(node.id)}" data-route-id="${escapeHtml(route.id)}">
                ${modulationMatrixTargetOptions(route)}
              </select>
            </label>
            <label>Amount <input class="modulator-matrix-setting" data-node-id="${escapeHtml(node.id)}" data-route-id="${escapeHtml(route.id)}" data-field="amount" type="range" min="0" max="1" step="0.01" value="${escapeHtml(route.amount ?? 0.35)}" /></label>
            <div class="modulator-preview">
              <span>${escapeHtml(MATRIX_SOURCE_TYPES[route.sourceType] || route.sourceType || "source")}</span>
              <strong>${escapeHtml(target ? modulationShortTargetLabel(target) : "Choose destination")}</strong>
            </div>
          </section>
        `;
      }).join("")}
    </div>
  `;
}

function canvasModulatorConfigMarkup(node) {
  if (node.modulatorType === "mod_matrix") return canvasModMatrixMarkup(node);
  if (node.modulatorType === "prompt_morph") {
    return `
      <div class="prompt-morph-fields">
        <label>A <textarea class="modulator-setting" data-node-id="${escapeHtml(node.id)}" data-field="stateA" rows="2">${escapeHtml(node.config.stateA || "")}</textarea></label>
        <label>B <textarea class="modulator-setting" data-node-id="${escapeHtml(node.id)}" data-field="stateB" rows="2">${escapeHtml(node.config.stateB || "")}</textarea></label>
        <label>C <textarea class="modulator-setting" data-node-id="${escapeHtml(node.id)}" data-field="stateC" rows="2">${escapeHtml(node.config.stateC || "")}</textarea></label>
      </div>
      <div class="time-control-row">
        <label>Morph <input class="modulator-setting" data-node-id="${escapeHtml(node.id)}" data-field="morph" type="range" min="0" max="1" step="0.01" value="${escapeHtml(node.config.morph ?? 0.5)}" /></label>
        <label>Seed <input class="modulator-setting" data-node-id="${escapeHtml(node.id)}" data-field="seed" type="number" step="1" value="${escapeHtml(node.config.seed ?? 1)}" /></label>
      </div>
    `;
  }
  if (node.modulatorType === "prompt_modulator") {
    return `
      <div class="time-control-row">
        <label>Mode
          <select class="modulator-setting" data-node-id="${escapeHtml(node.id)}" data-field="promptMode">
            ${modulationOptionsMarkup(PROMPT_MODULATOR_MODES, node.config.promptMode)}
          </select>
        </label>
        <label>Seed <input class="modulator-setting" data-node-id="${escapeHtml(node.id)}" data-field="seed" type="number" step="1" value="${escapeHtml(node.config.seed ?? 1)}" /></label>
      </div>
      <div class="time-control-row">
        <label>Intensity <input class="modulator-setting" data-node-id="${escapeHtml(node.id)}" data-field="intensity" type="range" min="0" max="100" step="1" value="${escapeHtml(node.config.intensity ?? 25)}" /></label>
        <label>Conserve <input class="modulator-setting" data-node-id="${escapeHtml(node.id)}" data-field="conservation" type="range" min="0" max="100" step="1" value="${escapeHtml(node.config.conservation ?? 80)}" /></label>
        <label>Contam <input class="modulator-setting" data-node-id="${escapeHtml(node.id)}" data-field="contamination" type="range" min="0" max="100" step="1" value="${escapeHtml(node.config.contamination ?? 10)}" /></label>
      </div>
    `;
  }
  if (node.modulatorType === "mutation_modulator" || node.modulatorType === "random_modulator") {
    return `
      <div class="time-control-row">
        <label>Distribution
          <select class="modulator-setting" data-node-id="${escapeHtml(node.id)}" data-field="distribution">
            ${modulationArrayOptionsMarkup(MUTATION_DISTRIBUTIONS, node.config.distribution || "uniform")}
          </select>
        </label>
        <label>Refresh
          <select class="modulator-setting" data-node-id="${escapeHtml(node.id)}" data-field="refresh">
            ${modulationOptionsMarkup(MODULATOR_REFRESHES, node.config.refresh || "every_trigger")}
          </select>
        </label>
        <label>Seed <input class="modulator-setting" data-node-id="${escapeHtml(node.id)}" data-field="seed" type="number" step="1" value="${escapeHtml(node.config.seed ?? 1)}" /></label>
      </div>
    `;
  }
  if (node.modulatorType === "random_walk_modulator" || node.modulatorType === "brownian_modulator") {
    return `
      <div class="time-control-row">
        <label>Rate <input class="modulator-setting" data-node-id="${escapeHtml(node.id)}" data-field="rateHz" type="number" min="0.001" max="10" step="0.001" value="${escapeHtml(node.config.rateHz ?? 0.2)}" /></label>
        <label>Drift <input class="modulator-setting" data-node-id="${escapeHtml(node.id)}" data-field="drift" type="range" min="0.01" max="0.48" step="0.01" value="${escapeHtml(node.config.drift ?? 0.18)}" /></label>
        <label>Seed <input class="modulator-setting" data-node-id="${escapeHtml(node.id)}" data-field="seed" type="number" step="1" value="${escapeHtml(node.config.seed ?? 1)}" /></label>
      </div>
    `;
  }
  if (node.modulatorType === "step_sequencer_modulator") {
    return `
      <div class="time-control-row">
        <label>Steps <input class="modulator-setting" data-node-id="${escapeHtml(node.id)}" data-field="steps" type="text" value="${escapeHtml(node.config.steps || "0, 0.25, 0.75, 1")}" /></label>
        <label>Division
          <select class="modulator-setting" data-node-id="${escapeHtml(node.id)}" data-field="division">
            ${modulationArrayOptionsMarkup(MODULATOR_DIVISIONS, node.config.division || "1/8")}
          </select>
        </label>
        <label>Seed <input class="modulator-setting" data-node-id="${escapeHtml(node.id)}" data-field="seed" type="number" step="1" value="${escapeHtml(node.config.seed ?? 1)}" /></label>
      </div>
    `;
  }
  if (node.modulatorType === "lfo_modulator") {
    return `
      <div class="time-control-row">
        <label>Shape
          <select class="modulator-setting" data-node-id="${escapeHtml(node.id)}" data-field="shape">
            ${modulationOptionsMarkup(LFO_SHAPES, node.config.shape || "sine")}
          </select>
        </label>
        <label>Rate <input class="modulator-setting" data-node-id="${escapeHtml(node.id)}" data-field="rateHz" type="number" min="0.001" max="30" step="0.001" value="${escapeHtml(node.config.rateHz ?? 0.25)}" /></label>
        <label>Phase <input class="modulator-setting" data-node-id="${escapeHtml(node.id)}" data-field="phase" type="number" min="0" max="360" step="1" value="${escapeHtml(node.config.phase ?? 0)}" /></label>
      </div>
      <div class="time-control-row">
        <label class="modulator-inline-check"><input class="modulator-setting" data-node-id="${escapeHtml(node.id)}" data-field="sync" type="checkbox" ${node.config.sync ? "checked" : ""} /> Clock sync</label>
        <label>Division
          <select class="modulator-setting" data-node-id="${escapeHtml(node.id)}" data-field="division">
            ${modulationArrayOptionsMarkup(MODULATOR_DIVISIONS, node.config.division || "1/4")}
          </select>
        </label>
        <label>Seed <input class="modulator-setting" data-node-id="${escapeHtml(node.id)}" data-field="seed" type="number" step="1" value="${escapeHtml(node.config.seed ?? 1)}" /></label>
      </div>
    `;
  }
  if (node.modulatorType === "noise_modulator") {
    return `
      <div class="time-control-row">
        <label>Rate <input class="modulator-setting" data-node-id="${escapeHtml(node.id)}" data-field="rateHz" type="number" min="0.001" max="30" step="0.001" value="${escapeHtml(node.config.rateHz ?? 0.7)}" /></label>
        <label>Smooth <input class="modulator-setting" data-node-id="${escapeHtml(node.id)}" data-field="smooth" type="range" min="0" max="1" step="0.01" value="${escapeHtml(node.config.smooth ?? 0.35)}" /></label>
        <label>Seed <input class="modulator-setting" data-node-id="${escapeHtml(node.id)}" data-field="seed" type="number" step="1" value="${escapeHtml(node.config.seed ?? 1)}" /></label>
      </div>
    `;
  }
  if (node.modulatorType === "sample_hold_modulator") {
    return `
      <div class="time-control-row">
        <label>Division
          <select class="modulator-setting" data-node-id="${escapeHtml(node.id)}" data-field="division">
            ${modulationArrayOptionsMarkup(MODULATOR_DIVISIONS, node.config.division || "1/8")}
          </select>
        </label>
        <label>Seed <input class="modulator-setting" data-node-id="${escapeHtml(node.id)}" data-field="seed" type="number" step="1" value="${escapeHtml(node.config.seed ?? 1)}" /></label>
      </div>
    `;
  }
  if (node.modulatorType === "probability_modulator") {
    return `
      <div class="time-control-row">
        <label>Chance <input class="modulator-setting" data-node-id="${escapeHtml(node.id)}" data-field="chance" type="range" min="0" max="100" step="1" value="${escapeHtml(node.config.chance ?? 75)}" /></label>
        <label>Seed <input class="modulator-setting" data-node-id="${escapeHtml(node.id)}" data-field="seed" type="number" step="1" value="${escapeHtml(node.config.seed ?? 1)}" /></label>
      </div>
    `;
  }
  if (node.modulatorType === "envelope_modulator") {
    return `
      <div class="time-control-row">
        <label>Attack <input class="modulator-setting" data-node-id="${escapeHtml(node.id)}" data-field="attack" type="number" min="0.001" max="5" step="0.001" value="${escapeHtml(node.config.attack ?? 0.08)}" /></label>
        <label>Decay <input class="modulator-setting" data-node-id="${escapeHtml(node.id)}" data-field="decay" type="number" min="0.001" max="5" step="0.001" value="${escapeHtml(node.config.decay ?? 0.2)}" /></label>
        <label>Sustain <input class="modulator-setting" data-node-id="${escapeHtml(node.id)}" data-field="sustain" type="range" min="0" max="1" step="0.01" value="${escapeHtml(node.config.sustain ?? 0.65)}" /></label>
      </div>
      <div class="time-control-row">
        <label>Release <input class="modulator-setting" data-node-id="${escapeHtml(node.id)}" data-field="release" type="number" min="0.001" max="5" step="0.001" value="${escapeHtml(node.config.release ?? 0.28)}" /></label>
        <label>Cycle <input class="modulator-setting" data-node-id="${escapeHtml(node.id)}" data-field="cycleSeconds" type="number" min="0.05" max="60" step="0.01" value="${escapeHtml(node.config.cycleSeconds ?? 2)}" /></label>
      </div>
    `;
  }
  if (node.modulatorType === "audio_to_control") {
    return `
      <div class="time-control-row">
        <label>Feature
          <select class="modulator-setting" data-node-id="${escapeHtml(node.id)}" data-field="feature">
            ${modulationOptionsMarkup(AUDIO_TO_CONTROL_FEATURES, node.config.feature || "spectral")}
          </select>
        </label>
        <label>Sense <input class="modulator-setting" data-node-id="${escapeHtml(node.id)}" data-field="sensitivity" type="range" min="0" max="1" step="0.01" value="${escapeHtml(node.config.sensitivity ?? 0.65)}" /></label>
      </div>
      <div class="time-control-row">
        <label>Smooth <input class="modulator-setting" data-node-id="${escapeHtml(node.id)}" data-field="smooth" type="range" min="0" max="1" step="0.01" value="${escapeHtml(node.config.smooth ?? 0.35)}" /></label>
        <label>Seed <input class="modulator-setting" data-node-id="${escapeHtml(node.id)}" data-field="seed" type="number" step="1" value="${escapeHtml(node.config.seed ?? 1)}" /></label>
      </div>
    `;
  }
  if (node.modulatorType === "gesture_recorder") {
    const points = Array.isArray(node.config.points) ? node.config.points : [];
    return `
      <div class="time-control-row">
        <label>Touch <input class="modulator-setting gesture-recorder-touch" data-node-id="${escapeHtml(node.id)}" data-field="gestureValue" type="range" min="0" max="1" step="0.01" value="${escapeHtml(node.config.gestureValue ?? 0.5)}" /></label>
        <label>Length <input class="modulator-setting" data-node-id="${escapeHtml(node.id)}" data-field="durationSec" type="number" min="0.25" max="60" step="0.25" value="${escapeHtml(node.config.durationSec ?? 4)}" /></label>
      </div>
      <div class="time-control-row">
        <label class="modulator-inline-check"><input class="modulator-setting" data-node-id="${escapeHtml(node.id)}" data-field="loop" type="checkbox" ${node.config.loop !== false ? "checked" : ""} /> Loop</label>
        <button class="time-action${node.config.recording ? " active" : ""}" type="button" data-action="canvas-gesture-record-toggle" data-node-id="${escapeHtml(node.id)}">${node.config.recording ? "Stop" : "Record"}</button>
        <button class="time-action" type="button" data-action="canvas-gesture-clear" data-node-id="${escapeHtml(node.id)}">Clear</button>
      </div>
      <div class="gesture-point-strip" style="--point-count:${points.length || 1}">
        ${points.map((point) => `<i style="left:${Math.round(Number(point.t || 0) * 100)}%;height:${Math.max(8, Math.round(Number(point.value || 0) * 100))}%"></i>`).join("")}
      </div>
    `;
  }
  if (["envelope_follower", "transient_detector", "spectral_follower", "semantic_follower", "region_envelope"].includes(node.modulatorType)) {
    return `
      <div class="time-control-row">
        <label>Sense <input class="modulator-setting" data-node-id="${escapeHtml(node.id)}" data-field="sensitivity" type="range" min="0" max="1" step="0.01" value="${escapeHtml(node.config.sensitivity ?? 0.65)}" /></label>
        <label>Seed <input class="modulator-setting" data-node-id="${escapeHtml(node.id)}" data-field="seed" type="number" step="1" value="${escapeHtml(node.config.seed ?? 1)}" /></label>
      </div>
    `;
  }
  return `
    <div class="time-control-row">
      <label>Amount <input class="modulator-setting" data-node-id="${escapeHtml(node.id)}" data-field="amount" type="range" min="0" max="100" step="1" value="${escapeHtml(node.config.amount ?? 50)}" /></label>
    </div>
  `;
}

function canvasModulatorNodeMarkup(node, selected, style) {
  node = normalizeModulatorNode(node);
  const isPrompt = PROMPT_MODULATOR_TYPES.has(node.modulatorType);
  const routeList = node.modulatorType === "mod_matrix" ? (node.config?.matrixRoutes || []) : (node.routes || []);
  const activeRoutes = routeList.filter((route) => route.enabled !== false && route.targetNodeId).length;
  const helpDescription = {
    mod_matrix: "Global source to destination modulation router.",
    prompt_morph: "Crossfades structured prompt states.",
    prompt_modulator: "Mutagenic prompt system.",
    mutation_modulator: "Generation randomizer.",
    lfo_modulator: "Realtime and clocked oscillator.",
    random_modulator: "Seeded value picker.",
    random_walk_modulator: "Organic drifting values.",
    brownian_modulator: "Slow wandering identity.",
    step_sequencer_modulator: "Rhythmic parameter sequence.",
    noise_modulator: "Smooth drift source.",
    sample_hold_modulator: "Clocked stepped random.",
    probability_modulator: "Event and generation gate.",
    envelope_modulator: "Cyclic ADSR contour.",
    envelope_follower: "Audio dynamics to generation.",
    transient_detector: "Onset language to generation.",
    spectral_follower: "Brightness to generation.",
    semantic_follower: "Tags and metadata to generation.",
    region_envelope: "Selected regions to automation.",
    audio_to_control: "Audio features become generation controls.",
    gesture_recorder: "Recorded movement for generation values.",
    macro_modulator: "Manual control source.",
  }[node.modulatorType] || "Modulator.";
  return `
    <article class="canvas-node modulator-node${selected}" data-node-id="${escapeHtml(node.id)}" style="${style}" data-help="${escapeHtml(helpDescription)}">
      <div class="time-head">
        <div>
          <strong>${escapeHtml(node.label || modulatorLabel(node.modulatorType))}</strong>
          <small class="time-clock-readout">${activeRoutes} active route${activeRoutes === 1 ? "" : "s"}</small>
        </div>
        <div class="time-node-actions">
          <button class="time-action" type="button" data-action="canvas-modulator-add-route" data-node-id="${escapeHtml(node.id)}" title="Add route" aria-label="Add route">+</button>
          <button class="time-action" type="button" data-action="canvas-modulator-apply" data-node-id="${escapeHtml(node.id)}" ${isPrompt ? "" : "disabled"} title="Apply" aria-label="Apply">Apply</button>
          <button class="prompt-node-icon delete" type="button" data-action="canvas-delete-node" data-node-id="${escapeHtml(node.id)}" title="Delete" aria-label="Delete"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M18 6 6 18"/><path d="M6 6l12 12"/></svg></button>
        </div>
      </div>
      <div class="time-node-body modulator-body">
        ${canvasModulatorConfigMarkup(node)}
        ${(node.routes || []).map((route, index) => canvasModulatorRouteMarkup(node, route, index)).join("")}
      </div>
    </article>
  `;
}

function canvasWaveRegionButtonMarkup(node, regionType) {
  const config = canvasRegionConfig(regionType);
  const activeRegion = canvasActiveEditableRegion(node);
  const active = activeRegion && canvasRegionType(activeRegion) === regionType ? " active" : "";
  return `
    <button class="wave-region-opt${active}" type="button" data-action="canvas-region-mark" data-node-id="${escapeHtml(node.id)}" data-region-type="${escapeHtml(regionType)}" title="${escapeHtml(config.behavior)}" data-help="${escapeHtml(config.behavior)}">
      <span class="wave-region-code">${escapeHtml(config.short)}</span>
      <span>${escapeHtml(config.label)}</span>
    </button>
  `;
}

function canvasWaveRegionOptionsMarkup(node) {
  const summary = canvasRegionSummary(canvasActiveEditableRegion(node));
  return `
    <div class="wave-region-panel" data-node-id="${escapeHtml(node.id)}">
      <div class="wave-region-head">
        <span>Region role</span>
        <strong>${escapeHtml(summary)}</strong>
      </div>
      <div class="wave-region-grid" role="group" aria-label="Waveform region roles">
        ${WAVE_REGION_TYPE_ORDER.map((type) => canvasWaveRegionButtonMarkup(node, type)).join("")}
      </div>
      <div class="wave-region-command-grid" role="group" aria-label="Expanded region actions">
        <button class="wave-region-command" type="button" data-action="canvas-region-command" data-command="preserve_groove" data-node-id="${escapeHtml(node.id)}" title="Mark selected material as protected groove.">
          <span>Preserve</span><strong>groove</strong>
        </button>
        <button class="wave-region-command" type="button" data-action="canvas-region-command" data-command="replace_texture" data-node-id="${escapeHtml(node.id)}" title="Use the selection as a texture-focused inpaint area.">
          <span>Replace</span><strong>texture</strong>
        </button>
        <button class="wave-region-command" type="button" data-action="canvas-region-command" data-command="continue_space" data-node-id="${escapeHtml(node.id)}" title="Mark transition material and continue the source.">
          <span>Continue</span><strong>space</strong>
        </button>
        <button class="wave-region-command" type="button" data-action="canvas-region-command" data-command="mutate_tail" data-node-id="${escapeHtml(node.id)}" title="Generate alternatives over the selected tail or region.">
          <span>Mutate</span><strong>tail</strong>
        </button>
        <button class="wave-region-command" type="button" data-action="canvas-region-command" data-command="extract_identity" data-node-id="${escapeHtml(node.id)}" title="Extract this selection as an identity source.">
          <span>Extract</span><strong>identity</strong>
        </button>
      </div>
    </div>
  `;
}

function canvasNodeTabsMarkup(node, tabs = ["main", "mod"]) {
  const active = node.activePanel || (tabs.includes("main") ? "main" : tabs[0]);
  const labels = { main: "Main", stack: "Stack", mod: "Mod", wave: "Wave" };
  return `
    <div class="canvas-node-tabs" role="tablist">
      ${tabs.map((tab) => `
        <button class="${active === tab ? "active" : ""}" type="button" data-action="canvas-node-tab" data-node-id="${escapeHtml(node.id)}" data-panel="${escapeHtml(tab)}" role="tab" aria-selected="${active === tab ? "true" : "false"}">${escapeHtml(labels[tab] || tab)}</button>
      `).join("")}
    </div>
  `;
}

function canvasInjectModuleTabs(markup, node, { bodyClass = "time-node-body", tabs = ["main", "mod"] } = {}) {
  const bodyNeedle = `<div class="${bodyClass}">`;
  const bodyStart = markup.indexOf(bodyNeedle);
  if (bodyStart < 0) return markup;
  const active = tabs.includes(node.activePanel) ? node.activePanel : (tabs.includes("main") ? "main" : tabs[0]);
  const tabsMarkup = canvasNodeTabsMarkup({ ...node, activePanel: active }, tabs);
  if (active !== "mod") return `${markup.slice(0, bodyStart)}${tabsMarkup}${markup.slice(bodyStart)}`;
  const articleClose = markup.lastIndexOf("</article>");
  const bodyClose = markup.lastIndexOf("</div>", articleClose);
  if (bodyClose < bodyStart) return `${markup.slice(0, bodyStart)}${tabsMarkup}${markup.slice(bodyStart)}`;
  return `${markup.slice(0, bodyStart)}${tabsMarkup}<div class="${bodyClass} module-mod-body">${canvasNodeModPanelMarkup(node)}</div>${markup.slice(bodyClose + 6)}`;
}

function canvasIncomingGenerationRoutes(nodeId) {
  return canvasModulatorNodes()
    .map(normalizeModulatorNode)
    .flatMap((modulator) => (modulator.routes || []).map((route) => ({ modulator, route })))
    .filter(({ route }) => route.enabled !== false && route.targetNodeId === nodeId)
    .map(({ modulator, route }) => ({ modulator, route, target: modulationTargetForRoute(route) }))
    .filter(({ target }) => Boolean(target));
}

function modulationShortTargetLabel(target) {
  const label = String(target?.label || "Target");
  return label.includes(" / ") ? label.split(" / ").pop() : label;
}

function canvasNodeModPanelMarkup(node) {
  const routes = canvasIncomingGenerationRoutes(node.id);
  const targets = modulationTargetsForNode(node);
  const firstPrompt = targets.find((target) => ["prompt", "negative"].includes(target.type));
  const firstRealtime = targets.find((target) => target.modulationRate === "realtime");
  const firstClocked = targets.find((target) => target.modulationRate === "clocked");
  const semanticTarget = targets.find((target) => target.targetScope === "semantic_bridge");
  const semanticLayers = node.type === "fx"
    ? [canvasFxSemanticLayer(node)].filter(Boolean)
    : node.type === "sound"
      ? canvasFxNodesForTarget(node).map((fxNode) => canvasFxSemanticLayer(fxNode, { targetNode: node })).filter(Boolean)
      : [];
  const timeProbability = targets.find((target) => target.path === "events.probability") || firstClocked;
  const quickTargets = [
    ...(node.type === "sound" ? [
      ["lfo_modulator", GENERATION_DESTINATIONS.mutation.path, "LFO -> mutation"],
      ["random_walk_modulator", GENERATION_DESTINATIONS.seedDrift.path, "Walk -> seed"],
      ["spectral_follower", GENERATION_DESTINATIONS.brightnessLanguage.path, "Spectral -> bright"],
    ] : []),
    ...(node.type === "prompt" ? [
      ["prompt_morph", "prompt", "Morph prompt"],
      ["lfo_modulator", GENERATION_DESTINATIONS.mutation.path, "LFO -> mutation"],
      ["random_walk_modulator", GENERATION_DESTINATIONS.seedDrift.path, "Walk -> seed"],
    ] : []),
    ...(node.type === "fx" ? [
      firstRealtime ? ["lfo_modulator", firstRealtime.path, "LFO -> FX"] : null,
      firstRealtime ? ["macro_modulator", firstRealtime.path, "Macro -> FX"] : null,
      semanticTarget ? ["macro_modulator", semanticTarget.path, "Macro -> context"] : null,
    ] : []),
    ...(node.type === "time" ? [
      firstPrompt ? ["prompt_morph", firstPrompt.path, "Morph prompt"] : null,
      timeProbability ? ["probability_modulator", timeProbability.path, "Prob -> events"] : null,
      firstClocked ? ["step_sequencer_modulator", firstClocked.path, "Steps -> events"] : null,
    ] : []),
  ].filter(Boolean);
  return `
    <div class="canvas-node-mod-panel">
      <div class="node-mod-quick">
        ${quickTargets.length ? quickTargets.map(([modulator, targetPath, label]) => `
          <button type="button" data-action="canvas-quick-mod" data-node-id="${escapeHtml(node.id)}" data-modulator="${escapeHtml(modulator)}" data-target-path="${escapeHtml(targetPath)}">${escapeHtml(label)}</button>
        `).join("") : `<span class="node-mod-empty">No direct modulation targets.</span>`}
      </div>
      <div class="node-mod-routes${routes.length ? "" : " empty"}">
        ${routes.length ? routes.map(({ modulator, target }) => `
          <span><strong>${escapeHtml(modulatorLabel(modulator.modulatorType))}</strong>${escapeHtml(modulationShortTargetLabel(target))}</span>
        `).join("") : "No generation routes yet."}
      </div>
      ${semanticLayers.length ? `
        <div class="node-mod-semantic">
          ${semanticLayers.map((layer) => `
            <span><strong>${escapeHtml(layer.label)}</strong>${escapeHtml(layer.prompt_layer || layer.family || "semantic context")}</span>
          `).join("")}
        </div>
      ` : ""}
    </div>
  `;
}

function canvasCreateQuickMod(nodeId, modulatorType, targetPath) {
  const targetNode = canvasNodes.find((item) => item.id === nodeId);
  if (!targetNode) return null;
  const modulatorSize = canvasModulatorNodeSize(modulatorType);
  const point = canvasFindOpenPoint(canvasConnectPointFor(targetNode, { x: 72, y: 0 }), modulatorSize, { anchorNode: targetNode });
  const modulator = canvasCreateModulatorNode(modulatorType, { x: point.x, y: point.y });
  const normalized = normalizeModulatorNode(modulator);
  const target = modulationTargetsForNode(targetNode).find((item) => item.path === targetPath) || modulationTargetsForNode(targetNode)[0];
  if (target) {
    const route = modulationDefaultRoute(normalized.modulatorType, nodeId);
    normalized.routes = [{
      ...route,
      targetNodeId: target.nodeId,
      targetPath: target.path,
      config: {
        ...(route.config || {}),
        ...modulationDefaultRangeFor(normalized.modulatorType, target),
      },
    }];
  }
  canvasNodes[canvasNodes.findIndex((item) => item.id === normalized.id)] = normalized;
  selectedCanvasNodeId = normalized.id;
  canvasSaveState();
  renderCanvas();
  setState("Mod Route Added", "ok", `${modulatorLabel(normalized.modulatorType)} -> ${target?.label || "target"}`);
  return normalized;
}

function canvasPromptStackMarkup(node) {
  const stack = canvasNormalizePromptStack(node);
  return `
    <div class="canvas-prompt-stack">
      ${PROMPT_STACK_LAYERS.map((layer) => `
        <label>${escapeHtml(layer.label)}
          <input class="canvas-prompt-stack-field" data-node-id="${escapeHtml(node.id)}" data-field="${escapeHtml(layer.key)}" value="${escapeHtml(stack[layer.key] || "")}" />
        </label>
      `).join("")}
    </div>
  `;
}

function canvasNodeMarkup(node) {
  const selected = node.id === selectedCanvasNodeId ? " selected" : "";
  const style = `left:${node.x}px;top:${node.y}px;width:${node.width}px;`;
  if (node.type === "fx") return canvasFxNodeMarkup(node, selected, style);
  if (node.type === "mixer") return canvasMixerNodeMarkup(node, selected, style);
  if (node.type === "time") return canvasTimeNodeMarkup(node, selected, style);
  if (node.type === "modulator") return canvasModulatorNodeMarkup(node, selected, style);
  if (node.type === "genetic") return canvasGeneticNodeMarkup(node, selected, style);
  if (node.type === "germ") return canvasGermNodeMarkup(node, selected, style);
  if (node.type === "wavetable_forge") return canvasWavetableForgeNodeMarkup(node, selected, style);
  if (node.type === "prompt") {
    const settings = canvasNormalizePromptSettings(node);
    const activePanel = node.activePanel || "main";
    return `
      <article class="canvas-node prompt-node${selected}" data-node-id="${escapeHtml(node.id)}" style="${style}" data-help="Prompt source.">
        ${canvasIoPortsMarkup(node.id, { output: true })}
        ${canvasPromptMonitorMarkup(node)}
        <div class="prompt-node-actions prompt-node-actions-top">
          <button class="prompt-node-icon generate" type="button" data-action="canvas-generate-from-node" data-node-id="${escapeHtml(node.id)}" title="Generate" aria-label="Generate" data-help="Run generation from this prompt source."><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="5 3 19 12 5 21 5 3"/></svg></button>
          <button class="prompt-node-icon delete" type="button" data-action="canvas-delete-node" data-node-id="${escapeHtml(node.id)}" title="Delete" aria-label="Delete" data-help="Remove this prompt module from the graph."><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M18 6 6 18"/><path d="M6 6l12 12"/></svg></button>
        </div>
        ${canvasNodeTabsMarkup(node, ["main", "stack", "mod"])}
        ${activePanel === "main" ? `
          <label class="canvas-prompt-label">Description
            <textarea class="canvas-prompt-edit" data-node-id="${escapeHtml(node.id)}" data-field="prompt" rows="4" placeholder="Describe the sound source" data-help="Describe the sound you want to generate.">${escapeHtml(node.prompt || "")}</textarea>
          </label>
          <label class="canvas-prompt-label">Avoid
            <textarea class="canvas-prompt-edit canvas-prompt-edit-sm" data-node-id="${escapeHtml(node.id)}" data-field="negativePrompt" rows="2" placeholder="Speech, clipping, unwanted artifacts" data-help="List unwanted traits to steer the model away from.">${escapeHtml(node.negativePrompt || "")}</textarea>
          </label>
          <div class="canvas-prompt-rail">
            <label class="prompt-rail-field prompt-rail-length" data-help="Output duration in seconds.">
              <span>Len</span>
              <input class="canvas-prompt-setting" data-node-id="${escapeHtml(node.id)}" data-field="durationSec" type="number" min="0.5" max="60" step="0.5" value="${escapeHtml(settings.durationSec)}" />
            </label>
            <label class="prompt-rail-field prompt-rail-seed" data-help="Random seed. Use -1 for random.">
              <span>Seed</span>
              <input class="canvas-prompt-setting" data-node-id="${escapeHtml(node.id)}" data-field="seed" type="number" step="1" value="${escapeHtml(settings.seed)}" />
            </label>
            <label class="prompt-rail-field prompt-rail-mutation" data-help="Creative mutation distance. The API still receives init_noise_level.">
              <span>Mut</span>
              <select class="canvas-prompt-setting" data-node-id="${escapeHtml(node.id)}" data-field="mutation">${mutationPresetOptions(settings.mutation)}</select>
            </label>
            <label class="prompt-rail-colony${node.colonyEnabled ? " active" : ""}" data-help="Generate multiple candidates in one run.">
              <input type="checkbox" class="canvas-colony-checkbox" data-node-id="${escapeHtml(node.id)}" ${node.colonyEnabled ? "checked" : ""} />
              <span>Colony</span>
            </label>
          </div>
          <div class="canvas-colony-section${node.colonyEnabled ? "" : " hidden"}">
            <div class="canvas-colony-counts">
              <button class="canvas-colony-count${(node.colonyCandidates || 4) === 4 ? " active" : ""}" type="button" data-node-id="${escapeHtml(node.id)}" data-count="4">4</button>
              <button class="canvas-colony-count${(node.colonyCandidates || 4) === 8 ? " active" : ""}" type="button" data-node-id="${escapeHtml(node.id)}" data-count="8">8</button>
              <button class="canvas-colony-count${(node.colonyCandidates || 4) === 16 ? " active" : ""}" type="button" data-node-id="${escapeHtml(node.id)}" data-count="16">16</button>
            </div>
            <select class="canvas-colony-seed-mode canvas-prompt-setting" data-node-id="${escapeHtml(node.id)}" data-field="colonySeedMode" data-help="Seed strategy for colony generation.">
              <option value="random"${(node.colonySeedMode || "random") === "random" ? " selected" : ""}>Random</option>
              <option value="locked"${node.colonySeedMode === "locked" ? " selected" : ""}>Locked</option>
              <option value="sequential"${node.colonySeedMode === "sequential" ? " selected" : ""}>Sequential</option>
              <option value="nearby"${node.colonySeedMode === "nearby" ? " selected" : ""}>Nearby</option>
            </select>
          </div>
        ` : ""}
        ${activePanel === "stack" ? canvasPromptStackMarkup(node) : ""}
        ${activePanel === "mod" ? canvasNodeModPanelMarkup(node) : ""}
      </article>
    `;
  }

  if (node.type === "image") {
    const mode = node.imageMode === "spectrogram" ? "spectrogram" : "vision";
    const preview = node.imageDataUrl
      ? `<img src="${escapeHtml(node.imageDataUrl)}" alt="" />`
      : `<span>${mode === "spectrogram" ? "Drop or choose a spectrogram image" : "Choose an image"}</span>`;
    return `
      <article class="canvas-node image-node${selected}" data-node-id="${escapeHtml(node.id)}" style="${style}" data-help="Image source.">
        ${canvasIoPortsMarkup(node.id, { output: true })}
        <div class="image-node-head">
          <div>
            <span class="eyebrow">${mode === "spectrogram" ? "Spectrogram source" : "Image source"}</span>
            <strong>${escapeHtml(node.label || "Image source")}</strong>
          </div>
          <button class="prompt-node-icon delete" type="button" data-action="canvas-delete-node" data-node-id="${escapeHtml(node.id)}" title="Delete" aria-label="Delete" data-help="Remove this image module."><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M18 6 6 18"/><path d="M6 6l12 12"/></svg></button>
        </div>
        <div class="image-node-preview">${preview}</div>
        <div class="image-node-controls">
          <label data-help="Vision mode translates image content into a prompt. Spectrogram mode resynthesizes pixels as sound.">Mode
            <select class="canvas-image-setting" data-node-id="${escapeHtml(node.id)}" data-field="imageMode">
              <option value="vision"${mode === "vision" ? " selected" : ""}>Vision prompt (cloud opt-in)</option>
              <option value="spectrogram"${mode === "spectrogram" ? " selected" : ""}>Spectrogram</option>
            </select>
          </label>
          <label data-help="Output duration in seconds.">Length
            <input class="canvas-image-setting" data-node-id="${escapeHtml(node.id)}" data-field="durationSec" type="number" min="0.5" max="60" step="0.5" value="${escapeHtml(node.durationSec || 6)}" />
          </label>
        </div>
        <textarea class="canvas-image-prompt" data-node-id="${escapeHtml(node.id)}" rows="3" placeholder="Optional prompt override">${escapeHtml(node.imagePrompt || "")}</textarea>
        <div class="image-node-actions">
          <button class="secondary" type="button" data-action="canvas-image-pick" data-node-id="${escapeHtml(node.id)}">Replace</button>
          <button class="primary" type="button" data-action="canvas-image-generate" data-node-id="${escapeHtml(node.id)}">Generate</button>
        </div>
      </article>
    `;
  }

  if (node.type === "audio_snapshot") {
    const isRecording = !!node.recording;
    const activeClass = isRecording ? " rec-active" : "";
    const nodeClass = isRecording ? " rec-recording" : "";
    const durationOptions = [5, 10, 30].map((seconds) => `
      <button class="snapshot-duration${Number(node.captureSeconds) === seconds ? " active" : ""}" type="button" data-action="audio-snapshot-duration" data-node-id="${escapeHtml(node.id)}" data-seconds="${seconds}">${seconds}s</button>
    `).join("");
    return `
      <article class="canvas-node record-node audio-snapshot-node${selected}${nodeClass}" data-node-id="${escapeHtml(node.id)}" style="${style}" data-help="System audio snapshot source.">
        ${canvasIoPortsMarkup(node.id, { output: true })}
        <div class="snapshot-head">
          <div>
            <span>System audio germ</span>
            <strong>${escapeHtml(node.label || "Audio Snapshot")}</strong>
          </div>
          <button class="rec-icon rec-delete" type="button" data-action="canvas-delete-node" data-node-id="${escapeHtml(node.id)}" title="Delete" aria-label="Delete" data-help="Remove this snapshot module."><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M18 6 6 18"/><path d="M6 6l12 12"/></svg></button>
        </div>
        <div class="snapshot-body">
          <div class="snapshot-duration-row">${durationOptions}</div>
          <div class="snapshot-main-row">
            <button class="rec-icon snapshot-capture${activeClass}" type="button" data-action="${isRecording ? "audio-snapshot-stop" : "audio-snapshot-start"}" data-node-id="${escapeHtml(node.id)}" title="${isRecording ? "Stop" : "Capture"}" aria-label="${isRecording ? "Stop" : "Capture"}" data-help="${isRecording ? "Stop capture" : "Capture system or tab audio"}">
              ${isRecording ? `<svg viewBox="0 0 24 24" fill="currentColor" stroke="none"><rect x="6" y="6" width="12" height="12" rx="2"/></svg>` : `<svg viewBox="0 0 24 24" fill="currentColor" stroke="none"><circle cx="12" cy="12" r="7"/></svg>`}
            </button>
            <div>
              <strong>${escapeHtml(node.status || "Ready")}</strong>
              <span>${escapeHtml(node.detail || "Capture computer audio into the Chamber.")}</span>
            </div>
          </div>
          ${isRecording ? `<canvas class="rec-live-wave snapshot-live-wave" data-node-id="${escapeHtml(node.id)}" width="280" height="42"></canvas>` : ""}
          <label class="snapshot-check"><input class="audio-snapshot-setting" data-node-id="${escapeHtml(node.id)}" data-field="autoTrim" type="checkbox" ${node.autoTrim !== false ? "checked" : ""} /> Auto-detect useful region</label>
          <div class="snapshot-trim-row">
            <label>Start <input class="audio-snapshot-setting" data-node-id="${escapeHtml(node.id)}" data-field="trimStartSec" type="number" min="0" step="0.01" value="${escapeHtml(node.trimStartSec || 0)}" /></label>
            <label>End <input class="audio-snapshot-setting" data-node-id="${escapeHtml(node.id)}" data-field="trimEndSec" type="number" min="0" step="0.01" value="${escapeHtml(node.trimEndSec || 0)}" /></label>
          </div>
        </div>
      </article>
    `;
  }

  if (node.type === "record") {
    const isRecording = !!node.recording;
    const recAction = isRecording ? "canvas-record-stop" : "canvas-record-start";
    const recLabel = isRecording ? "Stop" : "Record";
    const recIcon = isRecording
      ? `<svg viewBox="0 0 24 24" fill="currentColor" stroke="none"><rect x="6" y="6" width="12" height="12" rx="2"/></svg>`
      : `<svg viewBox="0 0 24 24" fill="currentColor" stroke="none"><circle cx="12" cy="12" r="7"/></svg>`;
    const recClass = isRecording ? " rec-active" : "";
    const recNodeClass = isRecording ? " rec-recording" : "";
    return `
      <article class="canvas-node record-node${selected}${recNodeClass}" data-node-id="${escapeHtml(node.id)}" style="${style}" data-help="Recorder source.">
        <div class="rec-icons">
          <button class="rec-icon${recClass}" type="button" data-action="${recAction}" data-node-id="${escapeHtml(node.id)}" title="${recLabel}" aria-label="${recLabel}" data-help="${recLabel} audio from the microphone.">${recIcon}</button>
          <button class="rec-icon rec-delete" type="button" data-action="canvas-delete-node" data-node-id="${escapeHtml(node.id)}" title="Delete" aria-label="Delete" data-help="Remove this record module."><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M18 6 6 18"/><path d="M6 6l12 12"/></svg></button>
          ${isRecording ? `<canvas class="rec-live-wave" data-node-id="${escapeHtml(node.id)}" width="200" height="32"></canvas>` : ""}
        </div>
      </article>
    `;
  }

  const asset = canvasAssetById(node.assetId);
  const duration = canvasNodeDuration(node);
  const loopShellActive = node.loop ? " loop-active" : "";
  const reverseActive = node.reversePlayback ? " active" : "";
  const stateActive = node.enabled === false ? "" : " active";
  const soloActive = node.solo ? " solo" : "";
  const isPlaying = node.audio && !node.audio.paused;
  const modPanelOpen = node.activePanel === "mod";
  const playIcon = isPlaying
    ? `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><rect x="6" y="4" width="4" height="16"/><rect x="14" y="4" width="4" height="16"/></svg>`
    : `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><polygon points="5 3 19 12 5 21 5 3"/></svg>`;
  const playAction = isPlaying ? "canvas-stop-node" : "canvas-play-node";
  const playLabel = isPlaying ? "Pause" : "Play";
  const reverseLabel = node.reversePlayback ? "Normal playback" : "Reverse playback";
  const reverseIcon = node.reversePlayback
    ? `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M13 5l7 7-7 7"/><path d="M4 5l7 7-7 7"/></svg>`
    : `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M11 19 4 12l7-7"/><path d="M20 19 13 12l7-7"/></svg>`;
  const modActive = modPanelOpen ? " active" : "";
  return `
    <article class="canvas-node sound-node${selected}${node.enabled === false ? " source-disabled" : ""}${node.solo ? " source-solo" : ""}" data-node-id="${escapeHtml(node.id)}" style="${style}" data-help="Sound module.">
      ${canvasIoPortsMarkup(node.id, { output: true })}
      <div class="wave-shell${loopShellActive}">
        <canvas class="canvas-node-waveform wave-move-handle" data-node-id="${escapeHtml(node.id)}" width="760" height="320" aria-label="Waveform for ${escapeHtml(node.label || "sound node")}"></canvas>
        <div class="wave-corner-group wave-corner-tl">
          <button class="wave-zone wave-edge-play" type="button" data-action="${playAction}" data-node-id="${escapeHtml(node.id)}" title="${playLabel}" aria-label="${playLabel}" data-help="${playLabel}">${playIcon}</button>
          <button class="wave-zone${reverseActive}" type="button" data-action="canvas-toggle-reverse" data-node-id="${escapeHtml(node.id)}" title="${reverseLabel}" aria-label="${reverseLabel}" data-help="${reverseLabel}">${reverseIcon}</button>
          <button class="wave-zone wave-source-state${stateActive}${soloActive}" type="button" data-action="canvas-toggle-source-state" data-node-id="${escapeHtml(node.id)}" title="Active / solo" aria-label="Active / solo" data-help="Left click activates source. Right click solos."><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 2v10"/><path d="M18.4 6.6a9 9 0 11-12.8 0"/></svg></button>
        </div>
        <div class="wave-corner-group wave-corner-tr">
          <button class="wave-zone" type="button" data-action="canvas-open-source-info" data-node-id="${escapeHtml(node.id)}" title="Info" aria-label="Info" data-help="Metadata and lineage"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><path d="M12 11v5"/><path d="M12 8h.01"/></svg></button>
          <button class="wave-zone" type="button" data-action="canvas-download-node" data-node-id="${escapeHtml(node.id)}" title="Download" aria-label="Download" data-help="Download"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg></button>
          <button class="wave-zone" type="button" data-action="canvas-delete-node" data-node-id="${escapeHtml(node.id)}" title="Delete" aria-label="Delete" data-help="Delete"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M18 6 6 18"/><path d="M6 6l12 12"/></svg></button>
        </div>
        <div class="wave-corner-group wave-corner-bl">
          <div class="wave-zone wave-knob-control" data-help="Volume">
            <button class="wave-knob-btn" type="button" data-knob="volume" data-node-id="${escapeHtml(node.id)}" title="Volume" aria-label="Volume"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"/><path d="M15.54 8.46a5 5 0 010 7.07"/></svg></button>
            <div class="wave-knob-popup wave-knob-vertical">
              <input type="range" class="wave-knob-slider" data-param="volume" data-node-id="${escapeHtml(node.id)}" min="0" max="100" value="${Math.round((node.volume ?? 1) * 100)}" orient="vertical" />
            </div>
          </div>
          <div class="wave-zone wave-knob-control" data-help="Pan">
            <button class="wave-knob-btn" type="button" data-knob="pan" data-node-id="${escapeHtml(node.id)}" title="Pan" aria-label="Pan"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M18 8l4 4-4 4"/><path d="M6 8l-4 4 4 4"/><line x1="2" y1="12" x2="22" y2="12"/></svg></button>
            <div class="wave-knob-popup wave-knob-horizontal">
              <input type="range" class="wave-knob-slider" data-param="pan" data-node-id="${escapeHtml(node.id)}" min="-100" max="100" value="${Math.round((node.pan ?? 0) * 100)}" />
            </div>
          </div>
          <button class="wave-zone wave-mod-toggle${modActive}" type="button" data-action="canvas-toggle-node-mod" data-node-id="${escapeHtml(node.id)}" title="Modulation" aria-label="Modulation" data-help="Modulation"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M4 7h10"/><path d="M18 7h2"/><circle cx="16" cy="7" r="2"/><path d="M4 17h2"/><path d="M10 17h10"/><circle cx="8" cy="17" r="2"/></svg></button>
        </div>
        <div class="wave-corner-group wave-corner-br">
          <div class="wave-variations-control">
            <button class="wave-zone wave-variations-btn" type="button" data-node-id="${escapeHtml(node.id)}" title="Variations" aria-label="Variations" data-help="Variations"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="7" height="7"/><rect x="14" y="3" width="7" height="7"/><rect x="14" y="14" width="7" height="7"/><rect x="3" y="14" width="7" height="7"/></svg></button>
            <div class="wave-variations-popover wave-var-menu" hidden>
              <div class="wave-var-row">
                <span class="wave-var-label">Full variation</span>
                <div class="wave-var-spinner">
                  <button class="wave-var-spin-btn" type="button" data-spin="-1" data-node-id="${escapeHtml(node.id)}">−</button>
                  <span class="wave-var-spin-val" data-node-id="${escapeHtml(node.id)}">1</span>
                  <button class="wave-var-spin-btn" type="button" data-spin="1" data-node-id="${escapeHtml(node.id)}">+</button>
                </div>
                <button class="wave-var-go" type="button" data-action="canvas-variations" data-node-id="${escapeHtml(node.id)}" title="Generate">Go</button>
              </div>
              <select class="wave-var-mutation" data-node-id="${escapeHtml(node.id)}" aria-label="Variation mutation distance" data-help="Select the init_noise_level preset for this variation.">
                ${mutationPresetOptions(node.variationMutation ?? canvasPromptPayload(node.id).mutation)}
              </select>
              ${canvasWaveRegionOptionsMarkup(node)}
              <div class="wave-region-legacy-row">
                <button class="wave-var-menu-opt" type="button" data-action="canvas-op" data-op="inpaint" data-node-id="${escapeHtml(node.id)}">Selection variation</button>
                <button class="wave-var-menu-opt" type="button" data-action="canvas-op" data-op="heal" data-node-id="${escapeHtml(node.id)}">Heal selection</button>
                <button class="wave-var-menu-opt" type="button" data-action="canvas-op" data-op="heal-full" data-node-id="${escapeHtml(node.id)}">Full heal</button>
              </div>
            </div>
          </div>
          <button class="wave-zone" type="button" data-action="canvas-op" data-op="continue" data-node-id="${escapeHtml(node.id)}" title="Continue" aria-label="Continue" data-help="Continue"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12h11"/><path d="M12 6l6 6-6 6"/><path d="M5 7v10"/></svg></button>
          <button class="wave-zone wave-tools-button" type="button" data-action="canvas-open-node-tools" data-node-id="${escapeHtml(node.id)}" title="Tools" aria-label="Tools" data-help="Audio tools"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M14.7 6.3a4 4 0 00-5 5L4 17v3h3l5.7-5.7a4 4 0 005-5l-3 3-2.9-2.9z"/></svg></button>
        </div>
      </div>
      <div class="wave-info-row">
        <span class="wave-help-readout canvas-node-help" data-node-id="${escapeHtml(node.id)}"></span>
        <span class="wave-time-readout canvas-node-time" data-node-id="${escapeHtml(node.id)}">0:00.00 / ${escapeHtml(formatPreciseTime(duration))}</span>
      </div>
      ${modPanelOpen ? canvasNodeModPanelMarkup(node) : ""}
    </article>
  `;
}

function renderCanvasEdges() {
  const svg = $("canvasEdges");
  const board = $("canvasBoard");
  if (!svg || !board) return;
  const maxNodeX = canvasNodes.reduce((max, node) => Math.max(max, node.x + node.width + 80), 0);
  const maxNodeY = canvasNodes.reduce((max, node) => Math.max(max, node.y + node.height + 80), 0);
  const width = Math.max(board.clientWidth / canvasZoom, maxNodeX, 1800);
  const height = Math.max(board.clientHeight / canvasZoom, maxNodeY, 1200);
  const space = $("canvasSpace");
  if (space) {
    space.style.width = `${width}px`;
    space.style.height = `${height}px`;
  }
  svg.style.width = `${width}px`;
  svg.style.height = `${height}px`;
  svg.setAttribute("viewBox", `0 0 ${width} ${height}`);
  svg.innerHTML = canvasEdges
    .map((edge) => {
      const from = canvasNodes.find((node) => node.id === edge.fromNodeId);
      const to = canvasNodes.find((node) => node.id === edge.toNodeId);
      if (!from || !to) return "";
      const fromSize = canvasNodeVisualSize(from);
      const toSize = canvasNodeVisualSize(to);
      const x1 = from.x + fromSize.width;
      const y1 = from.y + fromSize.height / 2;
      const x2 = to.x;
      const y2 = to.y + toSize.height / 2;
      const mid = Math.max(60, Math.abs(x2 - x1) / 2);
      const path = `M ${x1} ${y1} C ${x1 + mid} ${y1}, ${x2 - mid} ${y2}, ${x2} ${y2}`;
      return `<path class="canvas-edge edge-${escapeHtml(edge.type)}" d="${path}" />`;
    })
    .join("");
  applyCanvasViewport();
}

function renderCanvasChainControls() {
  const target = $("canvasChainControls");
  if (!target) return;
  const controls = canvasSoundNodes()
    .filter((node) => node.attachedToNodeId && canvasNodes.some((item) => item.id === node.attachedToNodeId))
    .map((node) => {
      const source = canvasNodes.find((item) => item.id === node.attachedToNodeId);
      const left = Math.min(source.x + source.width - 56, node.x + 16);
      const top = Math.max(8, Math.min(source.y, node.y) - 36);
      const active = node.linkedPlayback ? " active" : "";
      const label = node.linkedPlayback ? "Linked playback" : "Link playback";
      return `<button class="canvas-chain-link${active}" type="button" data-action="canvas-toggle-chain" data-node-id="${escapeHtml(node.id)}" style="left:${left}px;top:${top}px;">${label}</button>`;
    })
    .join("");
  target.innerHTML = controls;
}

// Sync the --fill-pct (or --pan-pct for pan sliders) CSS variable on a single
// range input so the unified app-slider track paints proportionally.
function syncRangeFill(input) {
  if (!input || input.type !== "range") return;
  const min = parseFloat(input.min);
  const max = parseFloat(input.max);
  const value = parseFloat(input.value);
  if (!Number.isFinite(min) || !Number.isFinite(max) || !Number.isFinite(value) || max === min) return;
  if (input.dataset.param === "pan") {
    // Map symmetric range to a signed % offset from centre. Most pan inputs
    // use -1..1, but mixer/knob variants may use -100..100; treat the actual
    // [min, max] as the symmetric span so any range works.
    const half = (max - min) / 2;
    const offset = ((value - (min + half)) / half) * 50;
    input.style.setProperty("--pan-pct", offset.toFixed(2) + "%");
  } else {
    const pct = ((value - min) / (max - min)) * 100;
    input.style.setProperty("--fill-pct", pct.toFixed(2) + "%");
  }
}

function syncAllRangeFills(root) {
  const scope = root && typeof root.querySelectorAll === "function" ? root : document;
  scope.querySelectorAll('input[type="range"]').forEach(syncRangeFill);
}

// Delegated listener: any range input mutation re-syncs its own fill.
document.addEventListener("input", (event) => {
  if (event.target instanceof HTMLInputElement && event.target.type === "range") {
    syncRangeFill(event.target);
  }
}, true);

function renderCanvas() {
  const nodes = $("canvasNodes");
  if (!nodes) return;
  canvasNodes = canvasNodes.map((node) => {
    if (node?.type === "time") return normalizeTimeNode(node);
    if (node?.type === "modulator") return normalizeModulatorNode(node);
    if (node?.type === "germ") return normalizeGermNode(node);
    if (node?.type === "wavetable_forge") return normalizeWavetableForgeNode(node);
    return node;
  });
  nodes.innerHTML = canvasNodes.map(canvasNodeMarkup).join("");
  const emptyState = $("canvasEmptyState");
  if (emptyState) emptyState.hidden = Boolean(canvasNodes.length);
  updateCanvasMixerButton();
  renderCanvasEdges();
  renderCanvasChainControls();
  renderCanvasLibraryList();
  renderCanvasCandidates();
  updateCanvasInspector();
  updateCanvasPromptMonitors();
  updateTimeTransportUi();
  canvasEnsureRealtimeModulationLoop();
  syncAllRangeFills(nodes);
  requestAnimationFrame(() => {
    drawCanvasWaveforms();
    drawCanvasFxFilters();
    drawGermWavetableCanvases();
  });
  canvasSaveState();
}

async function drawGermWavetableCanvases() {
  const canvases = document.querySelectorAll(".wavetable-mini-scope[data-node-id], .wavetable-frame-strip[data-node-id]");
  for (const canvas of canvases) {
    const node = canvasNodes.find((item) => item.id === canvas.dataset.nodeId);
    if (!node || !["germ", "wavetable_forge"].includes(node.type)) continue;
    const tableId = node.wavetableId || wavetableItems[0]?.id || "";
    const table = wavetableById(tableId);
    let frames = tableId && wavetableCache.has(tableId) ? wavetableCache.get(tableId) : null;
    if (tableId && !frames) {
      try {
        frames = await fetchWavetableData(tableId);
      } catch {
        frames = null;
      }
    }
    if (canvas.classList.contains("wavetable-frame-strip")) drawWavetableFrameStrip(canvas, table, frames);
    else drawWavetableMiniScope(canvas, table, frames, node.tablePosition || 0);
  }
}

function wavetableProviderModel(node) {
  return {
    provider: node.provider || $("provider")?.value || "mock",
    model: node.model || $("model")?.value || "mock-sine",
  };
}

async function ensureNodeWavetable(node) {
  await refreshWavetables();
  let table = wavetableById(node.wavetableId);
  if (!table && wavetableItems.length) {
    table = wavetableItems[0];
    node.wavetableId = table.id;
  }
  if (!table) throw new Error("No wavetable available.");
  const frames = await fetchWavetableData(table.id);
  if (!germSynthEngine) {
    // Wavetable voices share the Chamber's context and master bus so they
    // obey master volume, limiting, and recording instead of bypassing them.
    germSynthEngine = createGermSynthEngine({
      getContext: () => canvasPlaybackContext(),
      getDestination: () => canvasMasterBusInput(),
    });
  }
  await germSynthEngine.loadWavetable(table, frames);
  return { table, frames };
}

async function canvasPreviewWavetableNode(nodeId, mode = "preview") {
  const node = canvasNodes.find((item) => item.id === nodeId);
  if (!node || !["germ", "wavetable_forge"].includes(node.type)) return;
  try {
    const normalized = node.type === "germ" ? normalizeGermNode(node) : normalizeWavetableForgeNode(node);
    await ensureNodeWavetable(normalized);
    if (mode === "hold") {
      await germSynthEngine.holdNote({
        position: normalized.tablePosition || 0,
        note: normalized.note || normalized.rootNote || "C3",
        gain: normalized.gain || 0.5,
      });
      setState("Holding Wavetable", "ok", wavetableById(normalized.wavetableId)?.name || normalized.wavetableId);
    } else {
      await germSynthEngine.previewFrame({
        position: normalized.tablePosition || 0,
        note: normalized.note || normalized.rootNote || "C3",
        gain: normalized.gain || 0.5,
      });
      setState("Previewing Wavetable", "ok", wavetableById(normalized.wavetableId)?.name || normalized.wavetableId);
    }
  } catch (error) {
    finishWork("Wavetable Preview Error", "bad", error.message);
  }
}

function canvasStopWavetablePreview() {
  germSynthEngine?.stop();
  setState("Wavetable Stopped", "ok", "Preview stopped.");
}

async function canvasCreateSoundNodesFromAudioResult(result, parentNodeId, edgeType = "wavetable-render") {
  const created = [];
  const audioFiles = result.audio_files || [];
  const metadataFiles = result.metadata_files || [];
  for (let index = 0; index < audioFiles.length; index += 1) {
    const audioPath = audioFiles[index];
    const metadataPath = metadataFiles[index] || "";
    const asset = canvasCreateAsset({
      audioPath,
      metadataPath,
      metadata: { duration: result.duration, sample_rate: result.sample_rate },
      origin: edgeType,
    });
    const point = canvasFindOpenPoint(canvasBoardDefaultPoint(), { width: 352, height: 262 });
    created.push(canvasCreateSoundNode({
      asset,
      label: displayNameFromPath(audioPath),
      x: point.x,
      y: point.y,
      parentNodeId,
      edgeType,
    }));
  }
  await refreshLibrary(false);
  return created;
}

function frontendWavetablePrompt(prompt, generationMode) {
  const modeText = {
    single_cycle_tone: "stable single-cycle oscillator tone",
    evolving_timbre: "slowly evolving oscillator timbre with stable pitch",
    bass_oscillator: "solid bass oscillator source with strong fundamental",
    glassy_metallic: "glassy metallic vowel timbre with clear harmonic focus",
    soft_pad_source: "soft pad oscillator source with smooth harmonic motion",
    formant_no_voice: "formant-like instrumental vowel color without voice or speech",
    noisy_oscillator: "controlled noisy oscillator texture with stable tonal center",
    organic_reed: "organic reed-like oscillator tone with steady pitch",
  }[generationMode] || "stable oscillator tone";
  return `Single sustained instrumental tone, ${modeText}, ${prompt}, clear tonal center, stable pitch, no rhythm, no drums, no voice, no melody phrase, no long ambience.`;
}

function wavetableFrameSize(value, fallback = 2048) {
  const allowed = [512, 1024, 2048, 4096];
  const numeric = Math.round(Number(value));
  if (allowed.includes(numeric)) return numeric;
  return allowed.includes(Number(fallback)) ? Number(fallback) : 2048;
}

async function canvasGenerateWavetableAudio(nodeId) {
  const original = canvasNodes.find((item) => item.id === nodeId);
  if (!original) return;
  const node = normalizeGermNode(original);
  const { provider, model } = wavetableProviderModel(node);
  beginWork("Generating Audio", node.prompt);
  const result = await api("/generate", {
    method: "POST",
    body: JSON.stringify({
      provider,
      model,
      prompt: frontendWavetablePrompt(node.prompt, node.generationMode),
      negative_prompt: node.negativePrompt,
      base_prompt: node.prompt,
      duration: node.durationSec,
      output_name: safeOutputName(`${node.label || "germ"}_source`),
      tags: ["wavetable-source"],
    }),
  });
  await canvasCreateSoundNodesFromAudioResult(result, node.id, "wavetable-source");
  finishWork("Audio Ready", result.status === "done" ? "ok" : "bad", result.error || node.prompt);
}

async function canvasPromptWavetableNode(nodeId) {
  const original = canvasNodes.find((item) => item.id === nodeId);
  if (!original) return;
  const node = normalizeGermNode(original);
  const { provider, model } = wavetableProviderModel(node);
  const resolved = canvasResolveGenerationSettings(
    node.id,
    {
      prompt: node.prompt,
      negative_prompt: node.negativePrompt,
      duration: node.durationSec,
      operation: "wavetable_prompt",
    },
    {
      targetNodeId: node.id,
      operation: "wavetable_prompt",
      targetPaths: ["prompt", "negativePrompt", "durationSec", "frameCount", "frameSize", "variationCount"],
    },
  );
  const frameCount = Math.max(1, Math.min(512, Math.round(Number(resolved.frameCount ?? node.frameCount) || node.frameCount)));
  const frameSize = wavetableFrameSize(resolved.frameSize, node.frameSize);
  const variationCount = Math.max(1, Math.min(16, Math.round(Number(resolved.variationCount ?? 1) || 1)));
  beginWork("Germinating Table", resolved.prompt);
  const result = await api("/wavetables/prompt", {
    method: "POST",
    body: JSON.stringify({
      provider,
      model,
      prompt: resolved.prompt,
      negative_prompt: resolved.negativePrompt,
      duration: resolved.durationSec,
      root_note: node.rootNote,
      generation_mode: node.generationMode,
      extraction_mode: node.extractionMode,
      frame_count: frameCount,
      frame_size: frameSize,
      output_name: safeOutputName(resolved.prompt || "germ_table"),
      tags: ["wavetable", "germ"],
      variation_count: variationCount,
      modulators: resolved.modulationRecords || [],
      lineage: {
        operation_params: {
          base_prompt: resolved.basePrompt,
          modulated_prompt: resolved.prompt,
          base_negative_prompt: resolved.baseNegativePrompt,
          modulated_negative_prompt: resolved.negativePrompt,
          modulators: resolved.modulationRecords || [],
          generation_context: resolved.generationContext || {},
        },
      },
    }),
  });
  await refreshWavetables({ force: true });
  if (result.wavetable?.id) {
    node.wavetableId = result.wavetable.id;
    canvasNodes[canvasNodes.findIndex((item) => item.id === node.id)] = normalizeGermNode(node);
  }
  renderCanvas();
  finishWork("Wavetable Ready", "ok", result.wavetable?.name || node.prompt);
}

async function canvasRenderWavetableNodeToSource(nodeId) {
  const original = canvasNodes.find((item) => item.id === nodeId);
  if (!original) return;
  const node = normalizeGermNode(original);
  if (!node.wavetableId && wavetableItems[0]) node.wavetableId = wavetableItems[0].id;
  if (!node.wavetableId) throw new Error("Select a wavetable first.");
  beginWork("Rendering Table", wavetableById(node.wavetableId)?.name || node.wavetableId);
  const result = await api("/wavetables/render", {
    method: "POST",
    body: JSON.stringify({
      wavetable_id: node.wavetableId,
      duration: node.durationSec || 2,
      root_note: node.rootNote,
      note: node.note || node.rootNote,
      scan_start: 0,
      scan_end: node.tablePosition || 1,
      gain: node.gain || 0.7,
      output_name: safeOutputName(`${node.label || "germ"}_render`),
    }),
  });
  await canvasCreateSoundNodesFromAudioResult(result, node.id, "wavetable-render");
  renderCanvas();
  finishWork("Rendered Source Ready", "ok", result.audio_files?.[0] || "");
}

async function canvasMutateWavetableNode(nodeId) {
  const original = canvasNodes.find((item) => item.id === nodeId);
  if (!original) return;
  const node = normalizeGermNode(original);
  if (!node.wavetableId) throw new Error("Select a wavetable first.");
  const { provider, model } = wavetableProviderModel(node);
  const resolved = canvasResolveGenerationSettings(
    node.id,
    {
      prompt: node.mutationPrompt,
      negative_prompt: node.negativePrompt,
      duration: node.durationSec,
      init_noise_level: node.mutationDepth,
      operation: "wavetable_mutation",
    },
    {
      targetNodeId: node.id,
      operation: "wavetable_mutation",
      targetPaths: ["durationSec", "mutationDepth", "frameCount", "frameSize", "variationCount"],
    },
  );
  const mutationDepth = Math.max(0, Math.min(1, Number(resolved.mutationDepth ?? resolved.mutation ?? node.mutationDepth)));
  const frameCount = Math.max(1, Math.min(512, Math.round(Number(resolved.frameCount ?? node.frameCount) || node.frameCount)));
  const frameSize = wavetableFrameSize(resolved.frameSize, node.frameSize);
  const variationCount = Math.max(1, Math.min(16, Math.round(Number(resolved.variationCount ?? 1) || 1)));
  beginWork("Mutating Table", node.mutationPrompt);
  const result = await api("/wavetables/mutate", {
    method: "POST",
    body: JSON.stringify({
      wavetable_id: node.wavetableId,
      provider,
      model,
      prompt: node.mutationPrompt,
      negative_prompt: node.negativePrompt,
      init_noise_level: mutationDepth,
      render_duration: resolved.durationSec || node.durationSec || 2,
      root_note: node.rootNote,
      extraction_mode: node.extractionMode,
      frame_count: frameCount,
      frame_size: frameSize,
      variation_count: variationCount,
      modulators: resolved.modulationRecords || [],
      lineage: {
        operation_params: {
          mutation_depth: mutationDepth,
          base_prompt: node.mutationPrompt,
          modulated_prompt: node.mutationPrompt,
          base_negative_prompt: node.negativePrompt,
          modulated_negative_prompt: node.negativePrompt,
          modulators: resolved.modulationRecords || [],
          generation_context: resolved.generationContext || {},
        },
      },
    }),
  });
  await refreshWavetables({ force: true });
  if (result.wavetable?.id) {
    node.wavetableId = result.wavetable.id;
    canvasNodes[canvasNodes.findIndex((item) => item.id === node.id)] = normalizeGermNode(node);
  }
  renderCanvas();
  finishWork("Mutation Ready", "ok", result.wavetable?.name || "");
}

async function forgeGenerateTable(nodeId) {
  const original = canvasNodes.find((item) => item.id === nodeId);
  if (!original) return;
  const node = normalizeWavetableForgeNode(original);
  const { provider, model } = wavetableProviderModel(node);
  const result = await api("/wavetables/prompt", {
    method: "POST",
    body: JSON.stringify({
      provider,
      model,
      prompt: node.prompt,
      negative_prompt: node.negativePrompt,
      duration: node.durationSec,
      root_note: node.rootNote,
      generation_mode: node.generationMode,
      extraction_mode: node.extractionMode,
      frame_count: node.frameCount,
      frame_size: node.frameSize,
      output_name: safeOutputName(node.prompt || "forge_table"),
      tags: ["wavetable", "forge"],
    }),
  });
  await refreshWavetables({ force: true });
  if (result.wavetable?.id) node.wavetableId = result.wavetable.id;
  canvasNodes[canvasNodes.findIndex((item) => item.id === node.id)] = normalizeWavetableForgeNode(node);
  renderCanvas();
  finishWork("Forge Table Ready", "ok", result.wavetable?.name || "");
}

async function forgeConvertAudio(nodeId) {
  const original = canvasNodes.find((item) => item.id === nodeId);
  if (!original) return;
  const node = normalizeWavetableForgeNode(original);
  if (!node.selectedAudioPath) throw new Error("Select an audio source first.");
  const result = await api("/wavetables/convert", {
    method: "POST",
    body: JSON.stringify({
      input_audio_path: node.selectedAudioPath,
      name: displayNameFromPath(node.selectedAudioPath),
      frame_count: node.frameCount,
      frame_size: node.frameSize,
      root_note: node.rootNote,
      extraction_mode: node.extractionMode,
      tags: ["wavetable", "forge"],
    }),
  });
  await refreshWavetables({ force: true });
  if (result.wavetable?.id) node.wavetableId = result.wavetable.id;
  canvasNodes[canvasNodes.findIndex((item) => item.id === node.id)] = normalizeWavetableForgeNode(node);
  renderCanvas();
  finishWork("Audio Converted", "ok", result.wavetable?.name || "");
}

async function forgeMutateTable(nodeId) {
  const original = canvasNodes.find((item) => item.id === nodeId);
  if (!original) return;
  const node = normalizeWavetableForgeNode(original);
  if (!node.wavetableId) throw new Error("Select a wavetable first.");
  const { provider, model } = wavetableProviderModel(node);
  const result = await api("/wavetables/mutate", {
    method: "POST",
    body: JSON.stringify({
      wavetable_id: node.wavetableId,
      provider,
      model,
      prompt: node.mutationPrompt,
      negative_prompt: node.negativePrompt,
      init_noise_level: node.mutationDepth,
      render_duration: node.durationSec,
      root_note: node.rootNote,
      extraction_mode: node.extractionMode,
      frame_count: node.frameCount,
      frame_size: node.frameSize,
      variation_count: Math.max(1, Math.min(16, node.variationCount || 1)),
    }),
  });
  await refreshWavetables({ force: true });
  if (result.wavetable?.id) node.wavetableId = result.wavetable.id;
  canvasNodes[canvasNodes.findIndex((item) => item.id === node.id)] = normalizeWavetableForgeNode(node);
  renderCanvas();
  finishWork("Forge Mutation Ready", "ok", `${result.wavetables?.length || 1} table(s)`);
}

function wavetableAssetById(id) {
  return wavetableById(id) || wavetableLibraryItems().find((item) => (item.wavetable_id || item.id) === id) || null;
}

function canvasUseWavetableInGerm(wavetableId) {
  const table = wavetableAssetById(wavetableId);
  if (!table) throw new Error("Wavetable not found.");
  const point = canvasBoardDefaultPoint();
  const node = canvasCreateGermNode({ x: point.x, y: point.y });
  const index = canvasNodes.findIndex((item) => item.id === node.id);
  const next = normalizeGermNode({
    ...node,
    activePanel: "table",
    wavetableId,
    prompt: table.prompt || table.name || node.prompt,
    rootNote: table.root_note || node.rootNote,
    frameCount: table.frame_count || node.frameCount,
    frameSize: table.frame_size || node.frameSize,
  });
  canvasNodes[index] = next;
  selectedCanvasNodeId = next.id;
  canvasSaveState();
  renderCanvas();
  activateTab("chamber");
  setState("Germ Loaded", "ok", table.name || wavetableId);
}

async function renderWavetableAssetToSource(wavetableId) {
  const table = wavetableAssetById(wavetableId);
  if (!table) throw new Error("Wavetable not found.");
  beginWork("Rendering Table", table.name || wavetableId);
  const result = await api("/wavetables/render", {
    method: "POST",
    body: JSON.stringify({
      wavetable_id: wavetableId,
      duration: 2,
      root_note: table.root_note || "C3",
      note: table.root_note || "C3",
      scan_start: 0,
      scan_end: 1,
      gain: 0.7,
      output_name: safeOutputName(`${table.name || wavetableId}_render`),
      tags: ["wavetable-render"],
    }),
  });
  await refreshLibrary(false, { force: true });
  await refreshWavetables({ force: true });
  finishWork("Rendered Source Ready", "ok", result.audio_files?.[0] || "");
}

async function mutateWavetableAsset(wavetableId) {
  const table = wavetableAssetById(wavetableId);
  if (!table) throw new Error("Wavetable not found.");
  const provider = $("provider")?.value || "mock";
  const model = $("model")?.value || "mock-sine";
  beginWork("Mutating Table", table.name || wavetableId);
  const result = await api("/wavetables/mutate", {
    method: "POST",
    body: JSON.stringify({
      wavetable_id: wavetableId,
      provider,
      model,
      prompt: "subtle living harmonic variation",
      negative_prompt: "",
      init_noise_level: 0.35,
      render_duration: 2,
      root_note: table.root_note || "C3",
      extraction_mode: "simple",
      frame_count: Math.max(1, Math.min(512, Math.round(Number(table.frame_count) || 64))),
      frame_size: wavetableFrameSize(table.frame_size, 2048),
      variation_count: 1,
    }),
  });
  await refreshWavetables({ force: true });
  await refreshLibrary(false, { force: true });
  renderHerbarium();
  renderRack();
  finishWork("Mutation Ready", "ok", result.wavetable?.name || "");
}

function updateCanvasMixerButton() {
  const button = $("canvasMixerBtn");
  if (!button) return;
  const count = [...canvasGroupSelection].filter((id) => canvasNodes.some((node) => node.id === id && node.type === "sound")).length;
  button.hidden = count < 2;
  button.classList.toggle("mixer-hidden", count < 2);
  button.title = count >= 2 ? `Create mixer for ${count} sounds` : "Create mixer";
}

const CANVAS_LIBRARY_PAGE_SIZE = 3;
let canvasLibraryPage = 0;
let canvasLibrarySearchQuery = "";

function canvasLibraryFilteredItems() {
  const query = canvasLibrarySearchQuery.trim().toLowerCase();
  const all = libraryItems
    .filter((item) => item.audio_file && item.audio_exists !== false)
    .slice(0, PETRI_QUICK_PICKER_LIMIT);
  if (!query) return all;
  return all.filter((item) => {
    const haystack = [
      item.audio_file,
      item.prompt,
      item.model,
      item.mode,
      item.germinator_mode,
      String(item.seed ?? ""),
      ...(item.tags || []),
    ].filter(Boolean).join(" ").toLowerCase();
    return haystack.includes(query);
  });
}

function renderCanvasLibraryList() {
  const target = $("canvasLibraryList");
  if (!target) return;
  const items = canvasLibraryFilteredItems();
  const prevBtn = $("canvasLibraryPrev");
  const nextBtn = $("canvasLibraryNext");
  const readout = $("canvasLibraryPageReadout");
  if (!items.length) {
    target.className = "canvas-library-list empty";
    target.textContent = canvasLibrarySearchQuery
      ? "No sounds match this search."
      : "No output sounds loaded yet.";
    if (readout) readout.textContent = "0 / 0";
    if (prevBtn) prevBtn.disabled = true;
    if (nextBtn) nextBtn.disabled = true;
    return;
  }
  const totalPages = Math.max(1, Math.ceil(items.length / CANVAS_LIBRARY_PAGE_SIZE));
  canvasLibraryPage = Math.max(0, Math.min(canvasLibraryPage, totalPages - 1));
  const start = canvasLibraryPage * CANVAS_LIBRARY_PAGE_SIZE;
  const pageItems = items.slice(start, start + CANVAS_LIBRARY_PAGE_SIZE);
  target.className = "canvas-library-list";
  target.innerHTML = pageItems
    .map((item, indexOnPage) => {
      const absoluteIndex = start + indexOnPage;
      const mode = item.germinator_mode || modeAliases[item.mode] || item.mode || "library";
      const title = displayNameFromPath(item.audio_file);
      return `
        <article class="petri-card" data-action="canvas-add-library" data-index="${absoluteIndex}" title="${escapeHtml(title)}">
          <div class="petri-wave-shell">
            <canvas class="petri-canvas" width="220" height="220" data-audio="${escapeHtml(item.audio_file || "")}"></canvas>
          </div>
          <strong>${escapeHtml(title)}</strong>
          <small>${escapeHtml(mode)} · ${escapeHtml(item.duration ?? "?")}s</small>
        </article>
      `;
    })
    .join("");
  if (readout) readout.textContent = `${canvasLibraryPage + 1} / ${totalPages}`;
  if (prevBtn) prevBtn.disabled = canvasLibraryPage === 0;
  if (nextBtn) nextBtn.disabled = canvasLibraryPage >= totalPages - 1;
  requestAnimationFrame(() => {
    target.querySelectorAll(".petri-canvas[data-audio]").forEach(drawPetriCanvas);
  });
}

function canvasLibraryAddByIndex(absoluteIndex) {
  const items = canvasLibraryFilteredItems();
  const item = items[absoluteIndex];
  if (!item) return null;
  return item;
}

function openCanvasLibraryModal() {
  const modal = $("canvasLibraryModal");
  if (!modal) return;
  renderCanvasLibraryList();
  modal.hidden = false;
}

function closeCanvasLibraryModal({ keepPosition = false } = {}) {
  const modal = $("canvasLibraryModal");
  if (modal) modal.hidden = true;
  if (!keepPosition) canvasPendingSourcePosition = null;
}

function openCanvasModal(modalId) {
  const modal = $(modalId);
  if (!modal) return;
  closeCanvasSourceMenu();
  modal.hidden = false;
  document.body.classList.add("canvas-modal-open");
  if (modalId === "canvasCandidateModal") requestAnimationFrame(() => drawCanvasCandidateWaveforms());
}

function closeCanvasModal(modalId) {
  const modal = $(modalId);
  if (modal) modal.hidden = true;
  if (!document.querySelector(".canvas-modal:not([hidden])")) {
    document.body.classList.remove("canvas-modal-open");
  }
}

function candidateMetricBar(label, value, title = "") {
  const percent = ecologyPercent(value);
  return `
    <span class="candidate-eco-meter" title="${escapeHtml(title || `${label} ${percent}%`)}">
      <em>${escapeHtml(label)}</em>
      <i style="width:${percent}%"></i>
      <strong>${percent}</strong>
    </span>
  `;
}

function candidateRatingButtons(candidate) {
  return ["favorite", "maybe", "reject"].map((rating) => `
    <button class="candidate-rate${candidate.rating === rating ? " active" : ""}" type="button" data-action="canvas-rate-candidate" data-rating="${escapeHtml(rating)}" data-candidate-id="${escapeHtml(candidate.id)}">${escapeHtml(rating)}</button>
  `).join("");
}

function candidateEcologyStatsMarkup() {
  if (!canvasCandidates.length) return "population empty";
  const selectedCount = canvasCandidates.filter((candidate) => candidate.selected).length;
  const favoriteCount = canvasCandidates.filter((candidate) => candidate.rating === "favorite").length;
  const weirdest = canvasBestCandidateFor("novelty");
  const loopable = canvasBestCandidateFor("loopability");
  return `${canvasCandidates.length} organism${canvasCandidates.length === 1 ? "" : "s"} · ${selectedCount} selected · ${favoriteCount} favorite${favoriteCount === 1 ? "" : "s"} · weird ${ecologyPercent(weirdest?.ecology?.novelty)} · loop ${ecologyPercent(loopable?.ecology?.loopability)}`;
}

function renderCanvasCandidates() {
  const target = $("canvasCandidateList");
  if (!target) return;
  canvasCandidates = canvasCandidates.map(normalizeCanvasCandidate).filter(Boolean);
  if ($("canvasCandidateTitle")) {
    $("canvasCandidateTitle").textContent = canvasCandidates.length
      ? `${canvasCandidates.length} sound organism${canvasCandidates.length === 1 ? "" : "s"}`
      : "No generation candidates yet";
  }
  if ($("canvasCandidateMeta")) {
    const op = canvasCandidates[0]?.operation || "waiting";
    $("canvasCandidateMeta").textContent = canvasCandidates.length ? `population · ${op}` : op;
  }
  if ($("canvasCandidateEcologyStats")) {
    $("canvasCandidateEcologyStats").textContent = candidateEcologyStatsMarkup();
  }
  if (!canvasCandidates.length) {
    target.className = "canvas-candidate-list empty";
    target.textContent = "Run Generate, Continue, Inpaint, or Mutate to create auditionable candidates.";
    return;
  }
  target.className = "canvas-candidate-list";
  target.innerHTML = canvasCandidates
    .map((candidate) => {
      const ecology = candidate.ecology || canvasCandidateEcology(candidate);
      return `
      <article class="canvas-candidate${candidate.selected ? " selected" : ""}${candidate.rating === "favorite" ? " favorite" : ""}${candidate.rating === "reject" ? " rejected" : ""}${candidate.spotlight ? " spotlight" : ""}" data-candidate-id="${escapeHtml(candidate.id)}">
        <canvas class="canvas-candidate-wave" data-candidate-id="${escapeHtml(candidate.id)}" width="260" height="52"></canvas>
        <div class="canvas-candidate-body">
          <div class="canvas-candidate-title-row">
            <label class="candidate-select">
              <input type="checkbox" data-action="canvas-candidate-select" data-candidate-id="${escapeHtml(candidate.id)}" ${candidate.selected ? "checked" : ""} />
              <span></span>
            </label>
            <strong>${escapeHtml(candidate.label || displayNameFromPath(candidate.audioPath))}</strong>
          </div>
          <small>parent ${escapeHtml(ecology.parent)} · ${escapeHtml(candidate.operation)} · seed ${escapeHtml(candidate.seed ?? "-")} · ${escapeHtml(candidate.model || $("model").value || "-")}</small>
          <div class="candidate-eco-tags">
            ${(ecology.tags || []).map((tag) => `<span>${escapeHtml(tag)}</span>`).join("")}
          </div>
          <div class="candidate-eco-grid">
            ${candidateMetricBar("mut", ecology.mutationDistance, "Mutation distance")}
            ${candidateMetricBar("prm", ecology.promptSimilarity, "Prompt similarity")}
            ${candidateMetricBar("aud", ecology.audioSimilarity, "Audio similarity")}
            ${candidateMetricBar("brt", ecology.spectralBrightness, "Spectral brightness")}
            ${candidateMetricBar("dns", ecology.density, "Density")}
            ${candidateMetricBar("lop", ecology.loopability, "Loopability")}
            ${candidateMetricBar("trn", ecology.transientStrength, "Transient strength")}
            ${candidateMetricBar("nov", ecology.novelty, "Novelty")}
          </div>
        </div>
        <div class="canvas-candidate-actions">
          <div class="candidate-rating-row">${candidateRatingButtons(candidate)}</div>
          <button class="secondary" type="button" data-action="canvas-preview-candidate" data-candidate-id="${escapeHtml(candidate.id)}">Play</button>
          <button class="secondary" type="button" data-action="canvas-accept-candidate" data-accept="replace_region" data-candidate-id="${escapeHtml(candidate.id)}">Replace region</button>
          <button class="secondary" type="button" data-action="canvas-accept-candidate" data-accept="replace_source" data-candidate-id="${escapeHtml(candidate.id)}">Replace source</button>
          <button class="secondary" type="button" data-action="canvas-accept-candidate" data-accept="branch" data-candidate-id="${escapeHtml(candidate.id)}">Branch</button>
          <button class="secondary" type="button" data-action="canvas-save-candidate" data-candidate-id="${escapeHtml(candidate.id)}">Save</button>
          <button class="danger" type="button" data-action="canvas-discard-candidate" data-candidate-id="${escapeHtml(candidate.id)}" aria-label="Discard candidate" title="Discard candidate">&times;</button>
        </div>
      </article>
    `;
    })
    .join("");
  requestAnimationFrame(() => drawCanvasCandidateWaveforms());
}

function updateCanvasInspector(operation = "") {
  const node = canvasSelectedNode();
  if ($("canvasNodeCount")) $("canvasNodeCount").textContent = `${canvasNodes.length} node${canvasNodes.length === 1 ? "" : "s"}`;
  if ($("canvasEdgeCount")) $("canvasEdgeCount").textContent = `${canvasEdges.length} edge${canvasEdges.length === 1 ? "" : "s"}`;
  const regionCount = canvasNodes.reduce((sum, item) => sum + (item.regions?.length || 0), 0);
  if ($("canvasRegionCount")) $("canvasRegionCount").textContent = `${regionCount} region${regionCount === 1 ? "" : "s"}`;
  updateCanvasCompilerPreview(operation);
}

function updateCanvasCompilerPreview(operation = "") {
  const preview = $("canvasCompilerPreview");
  if (!preview) return;
  const node = canvasSelectedNode();
  if (!node) {
    preview.textContent = "No selected operation.";
    return;
  }
  if (node.type === "modulator") {
    const normalized = normalizeModulatorNode(node);
    preview.textContent = JSON.stringify({
      mode: "modulator",
      nodeId: normalized.id,
      modulatorType: normalized.modulatorType,
      config: normalized.config,
      routes: (normalized.routes || []).map((route) => ({
        ...route,
        target: modulationTargetForRoute(route)?.label || null,
        preview: modulationPreview(normalized, route),
      })),
    }, null, 2);
    return;
  }
  const asset = canvasAssetById(node.assetId);
  const region = operation === "continue"
    ? canvasRegionForPurpose(node, "continuation")
    : canvasInpaintRegion(node);
  const loopRegion = canvasLoopRegion(node);
  const mode = operation || (region ? "inpaint" : node.type === "sound" ? "audio_context" : "text_to_audio");
  const promptPayload = canvasPromptPayload(node.id);
  const resolved = canvasResolveGenerationSettings(node.id, { operation: mode }, { targetNodeId: node.id });
  const duration = Number(asset?.durationSec) || resolved.durationSec || promptPayload.durationSec || 4;
  const compiled = {
    mode,
    sourceAssetId: asset?.id || null,
    sourceNodeId: node.id,
    promptNodeId: promptPayload.promptNode?.id || null,
    prompt: resolved.prompt,
    negativePrompt: resolved.negativePrompt,
    basePrompt: resolved.basePrompt,
    baseNegativePrompt: resolved.baseNegativePrompt,
    durationSec: mode === "continue" ? duration + resolved.durationSec : duration,
    batchSize: resolved.batchSize,
    seed: resolved.seed,
    masks: region ? [{ startSec: Number(region.startSec.toFixed(3)), endSec: Number(region.endSec.toFixed(3)) }] : [],
    loop: loopRegion ? { startSec: Number(loopRegion.startSec.toFixed(3)), endSec: Number(loopRegion.endSec.toFixed(3)) } : null,
    initNoiseLevel: mode === "mutate" ? resolved.mutation : undefined,
    modulators: resolved.modulationRecords || [],
    semanticLayers: resolved.semanticLayers || [],
    semanticEffects: resolved.semanticFxLayers || [],
    generationContext: resolved.generationContext || {},
    provider: $("provider")?.value,
    model: $("model")?.value,
  };
  preview.textContent = JSON.stringify(compiled, null, 2);
}

async function fetchCanvasAudioBuffer(asset) {
  if (!asset) return null;
  if (canvasAudioCache.has(asset.id)) {
    const cached = canvasAudioCache.get(asset.id);
    canvasAudioCache.delete(asset.id);
    canvasAudioCache.set(asset.id, cached);
    return cached;
  }
  try {
    const source = asset.file
      ? await asset.file.arrayBuffer()
      : await fetch(asset.objectUrl || outputUrl(asset.audioPath || asset.storageUri)).then((response) => {
          if (!response.ok) throw new Error(`HTTP ${response.status}`);
          return response.arrayBuffer();
        });
    const decoded = await decodeAudioArrayBuffer(source);
    asset.durationSec = asset.durationSec || decoded.duration;
    asset.sampleRate = asset.sampleRate || decoded.sampleRate;
    asset.channels = asset.channels || decoded.numberOfChannels;
    canvasAudioCache.set(asset.id, decoded);
    while (canvasAudioCache.size > CANVAS_AUDIO_CACHE_MAX) {
      canvasAudioCache.delete(canvasAudioCache.keys().next().value);
    }
    return decoded;
  } catch (error) {
    console.warn("Canvas audio decode failed:", asset.audioPath || asset.id, error);
    return null;
  }
}

function canvasPrepareWaveformCanvas(canvas) {
  const zoomBoost = canvas.closest("#canvasSpace") ? Math.max(1, canvasZoom) : 1;
  const ratio = Math.min(4, Math.max(1, (window.devicePixelRatio || 1) * zoomBoost));
  const width = Math.max(1, Math.round((canvas.clientWidth || canvas.width || 1) * ratio));
  const height = Math.max(1, Math.round((canvas.clientHeight || canvas.height || 1) * ratio));
  if (canvas.width !== width || canvas.height !== height) {
    canvas.width = width;
    canvas.height = height;
  }
}

function canvasRegionDrawStyle(region, isDark = false) {
  const type = canvasRegionType(region);
  const fillBase = isDark ? "255,255,255" : "41,41,41";
  const green = isDark ? "122,165,143" : "71,111,93";
  const stroke = isDark ? "rgba(255,255,255,0.38)" : "rgba(68,68,68,0.42)";
  const styles = {
    mask: { fill: `rgba(${fillBase},0.12)`, stroke, dash: [] },
    variation: { fill: `rgba(${green},0.14)`, stroke, dash: [5, 4] },
    texture: { fill: `rgba(${fillBase},0.10)`, stroke, dash: [2, 4], hatch: true },
    silence: { fill: `rgba(${fillBase},0.07)`, stroke, dash: [8, 6] },
    bridge: { fill: `rgba(${fillBase},0.10)`, stroke, dash: [10, 5] },
    loop: { fill: `rgba(${green},0.13)`, stroke, dash: [] },
    preserve: { fill: `rgba(${green},0.11)`, stroke, dash: [1, 5] },
    accent: { fill: `rgba(${green},0.10)`, stroke, dash: [3, 3] },
    seed: { fill: `rgba(${green},0.15)`, stroke, dash: [] },
    forbidden: { fill: `rgba(${fillBase},0.16)`, stroke, dash: [2, 3] },
    continuation: { fill: `rgba(${fillBase},0.09)`, stroke, dash: [6, 5] },
    annotation: { fill: `rgba(${fillBase},0.08)`, stroke, dash: [4, 4] },
  };
  return styles[type] || styles.mask;
}

function drawCanvasRegionOverlay(ctx, region, rect, { isDark = false, vertical = false, lineWidth = 2 } = {}) {
  const config = canvasRegionConfig(region);
  const style = canvasRegionDrawStyle(region, isDark);
  const x = Number(rect.x) || 0;
  const y = Number(rect.y) || 0;
  const width = Math.max(2, Number(rect.width) || 0);
  const height = Math.max(2, Number(rect.height) || 0);
  ctx.save();
  ctx.fillStyle = style.fill;
  ctx.strokeStyle = style.stroke;
  ctx.lineWidth = lineWidth;
  if (style.dash?.length) ctx.setLineDash(style.dash.map((value) => Math.max(1, value * Math.max(1, lineWidth / 2))));
  ctx.fillRect(x, y, width, height);
  ctx.strokeRect(x, y, width, height);
  ctx.setLineDash([]);
  if (style.hatch) {
    ctx.strokeStyle = isDark ? "rgba(255,255,255,0.16)" : "rgba(68,68,68,0.12)";
    ctx.lineWidth = Math.max(1, lineWidth * 0.55);
    const gap = Math.max(9, lineWidth * 5);
    for (let offset = -height; offset < width + height; offset += gap) {
      ctx.beginPath();
      ctx.moveTo(x + offset, y + height);
      ctx.lineTo(x + offset + height, y);
      ctx.stroke();
    }
  }
  const canLabel = vertical ? height > 36 && width > 26 : width > 36 && height > 22;
  if (canLabel) {
    const label = config.short || config.label;
    ctx.font = `${Math.max(10, Math.min(12, Math.round((vertical ? width : height) / 12)))}px system-ui, sans-serif`;
    ctx.textBaseline = "middle";
    ctx.fillStyle = isDark ? "rgba(255,255,255,0.86)" : "rgba(24,24,24,0.76)";
    if (vertical) {
      ctx.save();
      ctx.translate(x + width / 2, y + Math.min(height - 10, 16));
      ctx.rotate(-Math.PI / 2);
      ctx.textAlign = "center";
      ctx.fillText(label, 0, 0);
      ctx.restore();
    } else {
      ctx.textAlign = "left";
      ctx.fillText(label, x + 7, y + 15);
    }
  }
  ctx.restore();
}

function drawCanvasBuffer(canvas, buffer, node, asset) {
  canvasPrepareWaveformCanvas(canvas);
  const ctx = canvas.getContext("2d");
  const width = canvas.width;
  const height = canvas.height;
  const isDark = document.documentElement.getAttribute("data-theme") === "dark";
  const isVertical = document.body.classList.contains("canvas-vertical");
  const fullDuration = Number(asset?.durationSec) || buffer?.duration || Number(node?.futureDuration) || 4;
  const viewStart = Math.min(canvasNodePlaybackStart(node), Math.max(0, fullDuration - 0.01));
  const viewEnd = Math.min(Math.max(canvasNodePlaybackEnd(node), viewStart + 0.01), Math.max(fullDuration, viewStart + 0.01));
  const viewDuration = Math.max(0.01, viewEnd - viewStart);
  const sourceDuration = node?.playbackEndSec ? viewDuration : fullDuration;
  const totalDuration = Math.max(sourceDuration, Number(node?.futureDuration) || sourceDuration);
  const metrics = { width, height, isDark, isVertical, viewStart, viewEnd, totalDuration, sourceDuration };

  // Static content (waveform or spectrogram plus regions) renders once into
  // an offscreen layer that is blitted per frame; only the playhead is drawn
  // per tick. The old path rescanned every visible sample of the buffer at
  // 60 fps for each playing module — the main Chamber frame-loop cost.
  const key = [
    asset?.id || "none", buffer ? buffer.length : 0, canvasVisualMode,
    width, height, isDark ? 1 : 0, isVertical ? 1 : 0,
    viewStart.toFixed(4), viewEnd.toFixed(4), totalDuration.toFixed(4), sourceDuration.toFixed(4),
    asset?.localOnly ? 1 : 0,
    JSON.stringify(node?.regions || []),
  ].join("|");
  let layer = node?._waveLayer;
  if (!layer || layer.key !== key) {
    const surface = document.createElement("canvas");
    surface.width = width;
    surface.height = height;
    const layerCtx = surface.getContext("2d");
    layerCtx.fillStyle = isDark ? "#151817" : "#fbfbf9";
    layerCtx.fillRect(0, 0, width, height);
    if (canvasVisualMode === "spectrogram") {
      drawCanvasSpectrogramView(layerCtx, buffer, node, asset, metrics);
    } else {
      canvasPaintWaveformLayer(layerCtx, buffer, node, asset, metrics);
    }
    layer = { key, surface };
    if (node) node._waveLayer = layer;
  }
  ctx.clearRect(0, 0, width, height);
  ctx.drawImage(layer.surface, 0, 0);

  if (node?.audio && totalDuration > 0) {
    const localTime = Math.max(0, canvasCurrentForwardPlaybackTime(node) - viewStart);
    ctx.strokeStyle = isDark ? "rgba(232,232,232,0.72)" : "rgba(68,68,68,0.58)";
    ctx.beginPath();
    if (isVertical && canvasVisualMode !== "spectrogram") {
      const playheadY = Math.max(0, Math.min(height, height - (localTime / totalDuration) * height));
      ctx.lineWidth = Math.max(1, height / 520);
      ctx.moveTo(0, playheadY);
      ctx.lineTo(width, playheadY);
    } else {
      const playheadX = Math.min(width, Math.max(0, (localTime / totalDuration) * width));
      ctx.lineWidth = Math.max(1, width / 760);
      ctx.moveTo(playheadX, 0);
      ctx.lineTo(playheadX, height);
    }
    ctx.stroke();
  }
}

function canvasPaintWaveformLayer(ctx, buffer, node, asset, metrics) {
  const { width, height, isDark, isVertical, viewStart, viewEnd, totalDuration, sourceDuration } = metrics;
  if (isVertical) {
    // === VERTICAL MODE: bottom-to-top ===
    const sourceHeight = Math.max(1, (sourceDuration / totalDuration) * height);
    if (totalDuration > sourceDuration) {
      ctx.fillStyle = isDark ? "rgba(255,255,255,0.06)" : "rgba(0,0,0,0.055)";
      ctx.fillRect(0, 0, width, height - sourceHeight);
      ctx.strokeStyle = isDark ? "rgba(255,255,255,0.18)" : "rgba(80,80,80,0.2)";
      ctx.setLineDash([6, 5]);
      ctx.beginPath();
      ctx.moveTo(0, height - sourceHeight);
      ctx.lineTo(width, height - sourceHeight);
      ctx.stroke();
      ctx.setLineDash([]);
    }
    if (!buffer) {
      ctx.fillStyle = isDark ? "#777" : "#999";
      ctx.font = "12px system-ui";
      ctx.save();
      ctx.translate(width / 2, height / 2);
      ctx.rotate(-Math.PI / 2);
      ctx.fillText(asset?.localOnly ? "Local audio pending decode" : "Waveform unavailable", -60, 4);
      ctx.restore();
      return;
    }
    const data = buffer.getChannelData(0);
    const sampleStart = Math.max(0, Math.floor((viewStart / Math.max(buffer.duration, 0.01)) * data.length));
    const sampleEnd = Math.min(data.length, Math.max(sampleStart + 1, Math.ceil((viewEnd / Math.max(buffer.duration, 0.01)) * data.length)));
    const drawableHeight = Math.max(1, Math.floor(sourceHeight));
    const step = Math.max(1, Math.floor((sampleEnd - sampleStart) / drawableHeight));
    ctx.strokeStyle = isDark ? "#7aa58f" : "#476f5d";
    ctx.lineWidth = Math.max(1.2, height / Math.max(760, height));
    ctx.beginPath();
    for (let y = 0; y < drawableHeight; y += 1) {
      let min = 1, max = -1;
      const offset = sampleStart + y * step;
      for (let i = 0; i < step && offset + i < sampleEnd; i += 1) {
        min = Math.min(min, data[offset + i]);
        max = Math.max(max, data[offset + i]);
      }
      const plotY = height - 1 - y; // bottom to top
      const x1 = ((1 - max) * width) / 2;
      const x2 = ((1 - min) * width) / 2;
      ctx.moveTo(x1, plotY);
      ctx.lineTo(x2, plotY);
    }
    ctx.stroke();
    // Regions
    (node?.regions || []).forEach((region) => {
      const bounds = canvasRegionBounds(region);
      if (!bounds) return;
      const regionViewEnd = node?.playbackEndSec ? viewEnd : viewStart + totalDuration;
      const regionStart = Math.max(viewStart, bounds.start);
      const regionEnd = Math.min(regionViewEnd, bounds.end);
      if (regionEnd <= regionStart) return;
      const startY = height - ((regionStart - viewStart) / totalDuration) * height;
      const endY = height - ((regionEnd - viewStart) / totalDuration) * height;
      drawCanvasRegionOverlay(ctx, region, {
        x: 0,
        y: endY,
        width,
        height: Math.max(2, startY - endY),
      }, { isDark, vertical: true, lineWidth: Math.max(2, height / 760) });
    });
  } else {
    // === HORIZONTAL MODE (default) ===
    const sourceWidth = Math.max(1, (sourceDuration / totalDuration) * width);
    if (totalDuration > sourceDuration) {
      ctx.fillStyle = isDark ? "rgba(255,255,255,0.06)" : "rgba(0,0,0,0.055)";
      ctx.fillRect(sourceWidth, 0, width - sourceWidth, height);
      ctx.strokeStyle = isDark ? "rgba(255,255,255,0.18)" : "rgba(80,80,80,0.2)";
      ctx.setLineDash([6, 5]);
      ctx.beginPath();
      ctx.moveTo(sourceWidth, 0);
      ctx.lineTo(sourceWidth, height);
      ctx.stroke();
      ctx.setLineDash([]);
    }
    if (!buffer) {
      ctx.fillStyle = isDark ? "#777" : "#999";
      ctx.font = "12px system-ui";
      ctx.fillText(asset?.localOnly ? "Local audio pending decode" : "Waveform unavailable", 12, height / 2);
      return;
    }
    const data = buffer.getChannelData(0);
    const sampleStart = Math.max(0, Math.floor((viewStart / Math.max(buffer.duration, 0.01)) * data.length));
    const sampleEnd = Math.min(data.length, Math.max(sampleStart + 1, Math.ceil((viewEnd / Math.max(buffer.duration, 0.01)) * data.length)));
    const drawableWidth = Math.max(1, Math.floor(sourceWidth));
    const step = Math.max(1, Math.floor((sampleEnd - sampleStart) / drawableWidth));
    ctx.strokeStyle = isDark ? "#7aa58f" : "#476f5d";
    ctx.lineWidth = Math.max(1.2, width / Math.max(760, width));
    ctx.beginPath();
    for (let x = 0; x < drawableWidth; x += 1) {
      let min = 1;
      let max = -1;
      const offset = sampleStart + x * step;
      for (let i = 0; i < step && offset + i < sampleEnd; i += 1) {
        min = Math.min(min, data[offset + i]);
        max = Math.max(max, data[offset + i]);
      }
      ctx.moveTo(x, ((1 - max) * height) / 2);
      ctx.lineTo(x, ((1 - min) * height) / 2);
    }
    ctx.stroke();
    (node?.regions || []).forEach((region) => {
      const bounds = canvasRegionBounds(region);
      if (!bounds) return;
      const regionViewEnd = node?.playbackEndSec ? viewEnd : viewStart + totalDuration;
      const regionStart = Math.max(viewStart, bounds.start);
      const regionEnd = Math.min(regionViewEnd, bounds.end);
      if (regionEnd <= regionStart) return;
      const startX = ((regionStart - viewStart) / totalDuration) * width;
      const endX = ((regionEnd - viewStart) / totalDuration) * width;
      drawCanvasRegionOverlay(ctx, region, {
        x: startX,
        y: 0,
        width: Math.max(2, endX - startX),
        height,
      }, { isDark, vertical: false, lineWidth: Math.max(2, width / 760) });
    });
  }
}

async function drawCanvasWaveforms({ activeOnly = false } = {}) {
  const canvases = document.querySelectorAll(".canvas-node-waveform[data-node-id]");
  for (const canvas of canvases) {
    const node = canvasNodes.find((item) => item.id === canvas.dataset.nodeId);
    if (activeOnly && !(node?.audio && !node.audio.paused)) continue;
    const asset = canvasAssetById(node?.assetId);
    const buffer = await fetchCanvasAudioBuffer(asset);
    drawCanvasBuffer(canvas, buffer, node, asset);
  }
}

function drawCanvasFxFilters() {
  document.querySelectorAll(".fx-filter-canvas[data-node-id]").forEach((canvas) => {
    const node = canvasNodes.find((item) => item.id === canvas.dataset.nodeId);
    if (!node) return;
    canvasPrepareWaveformCanvas(canvas);
    const ctx = canvas.getContext("2d");
    const width = canvas.width;
    const height = canvas.height;
    const isDark = document.documentElement.getAttribute("data-theme") === "dark";
    const curve = Array.isArray(node.params?.curve) && node.params.curve.length >= 2 ? node.params.curve : canvasDefaultFxParams("filter").curve;
    ctx.clearRect(0, 0, width, height);
    ctx.fillStyle = isDark ? "#151817" : "#fbfbf9";
    ctx.fillRect(0, 0, width, height);
    ctx.strokeStyle = isDark ? "rgba(255,255,255,0.08)" : "rgba(41,41,41,0.08)";
    ctx.lineWidth = 1;
    for (let i = 1; i < 5; i += 1) {
      const x = (width / 5) * i;
      const y = (height / 5) * i;
      ctx.beginPath();
      ctx.moveTo(x, 0);
      ctx.lineTo(x, height);
      ctx.moveTo(0, y);
      ctx.lineTo(width, y);
      ctx.stroke();
    }
    const gradient = ctx.createLinearGradient(0, 0, width, 0);
    gradient.addColorStop(0, "rgba(215,168,23,0.15)");
    gradient.addColorStop(0.5, "rgba(71,111,93,0.22)");
    gradient.addColorStop(1, "rgba(18,95,209,0.13)");
    ctx.beginPath();
    curve.forEach((value, index) => {
      const x = (index / Math.max(1, curve.length - 1)) * width;
      const y = (1 - Math.min(1, Math.max(0, Number(value)))) * height;
      if (index === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    });
    ctx.lineTo(width, height);
    ctx.lineTo(0, height);
    ctx.closePath();
    ctx.fillStyle = gradient;
    ctx.fill();
    ctx.beginPath();
    curve.forEach((value, index) => {
      const x = (index / Math.max(1, curve.length - 1)) * width;
      const y = (1 - Math.min(1, Math.max(0, Number(value)))) * height;
      if (index === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    });
    ctx.strokeStyle = isDark ? "#d7a817" : "#476f5d";
    ctx.lineWidth = Math.max(2, width / 220);
    ctx.stroke();
  });
}

function canvasUpdateFilterCurveFromPointer(event, canvas, node) {
  const rect = canvas.getBoundingClientRect();
  const x = Math.min(Math.max(event.clientX - rect.left, 0), Math.max(rect.width, 1));
  const y = Math.min(Math.max(event.clientY - rect.top, 0), Math.max(rect.height, 1));
  const curve = Array.isArray(node.params?.curve) ? [...node.params.curve] : [...canvasDefaultFxParams("filter").curve];
  const index = Math.min(curve.length - 1, Math.max(0, Math.round((x / Math.max(rect.width, 1)) * (curve.length - 1))));
  curve[index] = Number((1 - y / Math.max(rect.height, 1)).toFixed(3));
  node.params = { ...(node.params || {}), curve };
  drawCanvasFxFilters();
  applyFxNodeToTarget(node);
  canvasSaveState();
}

function drawCanvasSpectrogramView(ctx, audioBuffer, node, asset, metrics) {
  const { width: w, height: h, isDark, viewStart, viewEnd, totalDuration, sourceDuration } = metrics;
  ctx.clearRect(0, 0, w, h);
  ctx.fillStyle = isDark ? "#151817" : "#fbfbf9";
  ctx.fillRect(0, 0, w, h);
  if (!audioBuffer) {
    ctx.fillStyle = isDark ? "#777" : "#999";
    ctx.font = "12px system-ui";
    ctx.fillText(asset?.localOnly ? "Local audio pending decode" : "Spectrogram unavailable", 12, h / 2);
    return;
  }
  const source = audioBuffer.getChannelData(0);
  const sampleStart = Math.max(0, Math.floor((viewStart / Math.max(audioBuffer.duration, 0.01)) * source.length));
  const sampleEnd = Math.min(source.length, Math.max(sampleStart + 1, Math.ceil((viewEnd / Math.max(audioBuffer.duration, 0.01)) * source.length)));
  const data = source.subarray(sampleStart, sampleEnd);
  const fftSize = Math.max(64, Math.min(512, 2 ** Math.floor(Math.log2(Math.max(64, data.length)))));
  const bins = fftSize / 2;
  const cols = Math.max(1, Math.min(360, Math.floor(w), Math.floor(data.length / Math.max(1, fftSize / 5))));
  const hopSize = cols > 1 ? Math.max(1, Math.floor((data.length - fftSize) / (cols - 1))) : fftSize;
  const img = ctx.createImageData(cols, bins);
  const rowEnergy = new Float32Array(bins);
  const re = new Float32Array(fftSize);
  const im = new Float32Array(fftSize);

  function fftFrame(offset) {
    re.fill(0);
    im.fill(0);
    for (let i = 0; i < fftSize; i += 1) {
      const sample = data[offset + i] || 0;
      re[i] = sample * (0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (fftSize - 1)));
    }
    for (let i = 1, j = 0; i < fftSize; i += 1) {
      let bit = fftSize >> 1;
      for (; j & bit; bit >>= 1) j ^= bit;
      j ^= bit;
      if (i < j) {
        const tr = re[i];
        re[i] = re[j];
        re[j] = tr;
      }
    }
    for (let len = 2; len <= fftSize; len <<= 1) {
      const angle = (-2 * Math.PI) / len;
      const wLenR = Math.cos(angle);
      const wLenI = Math.sin(angle);
      for (let i = 0; i < fftSize; i += len) {
        let wr = 1;
        let wi = 0;
        const half = len >> 1;
        for (let j = 0; j < half; j += 1) {
          const uR = re[i + j];
          const uI = im[i + j];
          const vR = re[i + j + half] * wr - im[i + j + half] * wi;
          const vI = re[i + j + half] * wi + im[i + j + half] * wr;
          re[i + j] = uR + vR;
          im[i + j] = uI + vI;
          re[i + j + half] = uR - vR;
          im[i + j + half] = uI - vI;
          const nextWr = wr * wLenR - wi * wLenI;
          wi = wr * wLenI + wi * wLenR;
          wr = nextWr;
        }
      }
    }
  }

  for (let col = 0; col < cols; col += 1) {
    const offset = Math.max(0, Math.min(Math.max(0, data.length - fftSize), col * hopSize));
    fftFrame(offset);
    for (let row = 0; row < bins; row += 1) {
      const normalized = 1 - row / Math.max(1, bins - 1);
      const bin = Math.min(bins - 1, Math.floor((bins - 1) * normalized * normalized));
      const mag = Math.sqrt(re[bin] * re[bin] + im[bin] * im[bin]) / fftSize;
      const energy = Math.max(0, Math.min(1, (20 * Math.log10(mag + 1e-7) + 84) / 56));
      const v = Math.pow(energy, 0.68);
      const idx = (row * cols + col) * 4;
      rowEnergy[row] = Math.max(rowEnergy[row], energy);
      if (isDark) {
        img.data[idx] = Math.round(18 + 118 * v);
        img.data[idx + 1] = Math.round(24 + 154 * v);
        img.data[idx + 2] = Math.round(22 + 114 * v);
      } else {
        img.data[idx] = Math.round(250 - 176 * v);
        img.data[idx + 1] = Math.round(250 - 92 * v);
        img.data[idx + 2] = Math.round(246 - 160 * v);
      }
      img.data[idx + 3] = 255;
    }
  }
  const tmpCanvas = document.createElement("canvas");
  tmpCanvas.width = cols;
  tmpCanvas.height = bins;
  tmpCanvas.getContext("2d").putImageData(img, 0, 0);
  const maxEnergy = Math.max(...rowEnergy);
  let cropTop = 0;
  let cropBottom = bins - 1;
  if (maxEnergy > 0.04) {
    const threshold = Math.max(0.035, maxEnergy * 0.14);
    while (cropTop < cropBottom && rowEnergy[cropTop] < threshold) cropTop += 1;
    while (cropBottom > cropTop && rowEnergy[cropBottom] < threshold) cropBottom -= 1;
    const pad = Math.max(4, Math.round((cropBottom - cropTop + 1) * 0.18));
    cropTop = Math.max(0, cropTop - pad);
    cropBottom = Math.min(bins - 1, cropBottom + pad);
  }
  const sourceWidth = Math.max(1, (sourceDuration / totalDuration) * w);
  ctx.imageSmoothingEnabled = true;
  ctx.drawImage(tmpCanvas, 0, cropTop, cols, Math.max(1, cropBottom - cropTop + 1), 0, 0, sourceWidth, h);
  if (totalDuration > sourceDuration) {
    ctx.fillStyle = isDark ? "rgba(255,255,255,0.06)" : "rgba(0,0,0,0.055)";
    ctx.fillRect(sourceWidth, 0, w - sourceWidth, h);
    ctx.strokeStyle = isDark ? "rgba(255,255,255,0.18)" : "rgba(80,80,80,0.2)";
    ctx.setLineDash([6, 5]);
    ctx.beginPath();
    ctx.moveTo(sourceWidth, 0);
    ctx.lineTo(sourceWidth, h);
    ctx.stroke();
    ctx.setLineDash([]);
  }
  (node?.regions || []).forEach((region) => {
    const bounds = canvasRegionBounds(region);
    if (!bounds) return;
    const regionViewEnd = node?.playbackEndSec ? viewEnd : viewStart + totalDuration;
    const regionStart = Math.max(viewStart, bounds.start);
    const regionEnd = Math.min(regionViewEnd, bounds.end);
    if (regionEnd <= regionStart) return;
    const startX = ((regionStart - viewStart) / totalDuration) * w;
    const endX = ((regionEnd - viewStart) / totalDuration) * w;
    drawCanvasRegionOverlay(ctx, region, {
      x: startX,
      y: 0,
      width: Math.max(2, endX - startX),
      height: h,
    }, { isDark, vertical: false, lineWidth: Math.max(1.4, w / 760) });
  });
}

async function drawCanvasCandidateWaveforms() {
  const canvases = document.querySelectorAll(".canvas-candidate-wave[data-candidate-id]");
  for (const canvas of canvases) {
    const candidate = canvasCandidates.find((item) => item.id === canvas.dataset.candidateId);
    const asset = candidate ? canvasAssetById(candidate.assetId) : null;
    const buffer = await fetchCanvasAudioBuffer(asset);
    drawCanvasBuffer(canvas, buffer, { regions: [] }, asset);
  }
}

function canvasRegionFromPointer(event, node) {
  const canvas = event.currentTarget?.classList?.contains("canvas-node-waveform")
    ? event.currentTarget
    : event.target?.closest?.(".canvas-node-waveform") || canvasRegionDrag?.canvas;
  if (!canvas) return 0;
  const rect = canvas.getBoundingClientRect();
  const asset = canvasAssetById(node.assetId);
  const viewStart = canvasNodePlaybackStart(node);
  const duration = canvasNodeViewDuration(node) || Math.max(Number(asset?.durationSec) || Number(node.futureDuration) || 4, 0.01);
  if (document.body.classList.contains("canvas-vertical")) {
    const height = Math.max(rect.height, 1);
    const y = Math.min(Math.max(event.clientY - rect.top, 0), height);
    return viewStart + ((height - y) / height) * duration;
  }
  const width = Math.max(rect.width, 1);
  const x = Math.min(Math.max(event.clientX - rect.left, 0), width);
  return viewStart + (x / width) * duration;
}

function canvasNodeDuration(node) {
  if (node?.playbackEndSec) return canvasNodeViewDuration(node);
  const asset = canvasAssetById(node?.assetId);
  return Number(asset?.durationSec) || Number(node?.futureDuration) || 4;
}

function audioBufferToWavBlob(buffer, { reverse = false } = {}) {
  const channels = Math.min(2, Math.max(1, buffer.numberOfChannels || 1));
  const frameCount = buffer.length;
  const bytesPerSample = 2;
  const blockAlign = channels * bytesPerSample;
  const dataSize = frameCount * blockAlign;
  const arrayBuffer = new ArrayBuffer(44 + dataSize);
  const view = new DataView(arrayBuffer);

  function writeString(offset, value) {
    for (let i = 0; i < value.length; i += 1) view.setUint8(offset + i, value.charCodeAt(i));
  }

  writeString(0, "RIFF");
  view.setUint32(4, 36 + dataSize, true);
  writeString(8, "WAVE");
  writeString(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, channels, true);
  view.setUint32(24, buffer.sampleRate, true);
  view.setUint32(28, buffer.sampleRate * blockAlign, true);
  view.setUint16(32, blockAlign, true);
  view.setUint16(34, 16, true);
  writeString(36, "data");
  view.setUint32(40, dataSize, true);

  const channelData = Array.from({ length: channels }, (_, index) => buffer.getChannelData(Math.min(index, buffer.numberOfChannels - 1)));
  let offset = 44;
  for (let frame = 0; frame < frameCount; frame += 1) {
    const sourceFrame = reverse ? frameCount - frame - 1 : frame;
    for (let channel = 0; channel < channels; channel += 1) {
      const sample = Math.max(-1, Math.min(1, channelData[channel][sourceFrame] || 0));
      view.setInt16(offset, sample < 0 ? sample * 0x8000 : sample * 0x7fff, true);
      offset += 2;
    }
  }
  return new Blob([arrayBuffer], { type: "audio/wav" });
}

function canvasDisposeNodeAudio(node) {
  if (!node?.audio) return;
  try { node.audio.pause(); } catch {}
  canvasDisconnectAudioGraph(node.audioGraph);
  node.audioGraph = null;
  node.audio.src = "";
  node.audio = null;
}

async function canvasPrepareReverseAudio(node) {
  if (!node?.reversePlayback || node.reverseObjectUrl) return;
  const asset = canvasAssetById(node.assetId);
  if (!asset) return;
  const cachedUrl = canvasReverseAudioCache.get(asset?.id);
  if (cachedUrl) {
    canvasReverseAudioCache.delete(asset.id);
    canvasReverseAudioCache.set(asset.id, cachedUrl);
    node.reverseObjectUrl = cachedUrl;
    return;
  }
  const buffer = await fetchCanvasAudioBuffer(asset);
  if (!buffer) return;
  const blob = audioBufferToWavBlob(buffer, { reverse: true });
  node.reverseObjectUrl = URL.createObjectURL(blob);
  canvasReverseAudioCache.set(asset.id, node.reverseObjectUrl);
  trimCanvasReverseAudioCache();
}

function trimCanvasReverseAudioCache() {
  while (canvasReverseAudioCache.size > CANVAS_REVERSE_AUDIO_CACHE_MAX) {
    const entry = canvasReverseAudioCache.entries().next().value;
    if (!entry) return;
    const [assetId, objectUrl] = entry;
    const isInUse = canvasNodes.some((node) => node.reverseObjectUrl === objectUrl);
    if (isInUse) {
      canvasReverseAudioCache.delete(assetId);
      canvasReverseAudioCache.set(assetId, objectUrl);
      if ([...canvasReverseAudioCache.values()].every((url) => canvasNodes.some((node) => node.reverseObjectUrl === url))) {
        return;
      }
      continue;
    }
    canvasReverseAudioCache.delete(assetId);
    URL.revokeObjectURL(objectUrl);
  }
}

async function canvasEnsurePlaybackAudio(node) {
  if (node?.reversePlayback) await canvasPrepareReverseAudio(node);
  return canvasEnsureNodeAudio(node);
}

// The media element may only loop natively when no loop region and no
// playback chain is involved — one helper so every call site agrees.
function canvasNativeLoopFlag(node, loop = node?.loop) {
  return Boolean(
    loop
    && !canvasLoopRegion(node)
    && !canvasLinkedContinuationForSource(node)
    && !canvasLinkedSourceForContinuation(node),
  );
}

function canvasEnsureNodeAudio(node) {
  const asset = canvasAssetById(node?.assetId);
  if (!node || node.type !== "sound" || !asset) return null;
  const mode = node.reversePlayback && node.reverseObjectUrl ? "reverse" : "forward";
  const sourceUrl = mode === "reverse"
    ? node.reverseObjectUrl
    : (asset.objectUrl || outputUrl(asset.audioPath || asset.storageUri));
  if (node.audio && node.audioMode !== mode) {
    canvasDisposeNodeAudio(node);
  }
  if (!node.audio) {
    node.audio = new Audio(sourceUrl);
    node.audioMode = mode;
    node.audio.addEventListener("ended", async () => {
      await canvasHandlePlaybackRangeEnd(node);
      if (!node.loop) {
        drawCanvasWaveforms();
        updateCanvasTimeReadouts();
      }
    });
  }
  node.audio.loop = canvasNativeLoopFlag(node);
  node.audio.playbackRate = Number(node.playbackRate) || 1;
  canvasEnsureNodeAudioGraph(node);
  canvasApplyNodeAudioParams(node);
  return node.audio;
}

function canvasPlaybackContext() {
  const AudioContextClass = window.AudioContext || window.webkitAudioContext;
  if (!AudioContextClass) return null;
  if (!canvasPlaybackAudioContext || canvasPlaybackAudioContext.state === "closed") {
    canvasPlaybackAudioContext = new AudioContextClass();
    canvasMasterBus = null;
    canvasWorkletsReady = false;
    canvasTriggerPool = null;
    const context = canvasPlaybackAudioContext;
    ensureWorklets(context).then((ready) => {
      if (!ready || context !== canvasPlaybackAudioContext) return;
      canvasWorkletsReady = true;
      // Live FX chains upgrade in place (granular/gate move onto worklets).
      canvasRebuildActiveAudioGraphs();
    });
  }
  return canvasPlaybackAudioContext;
}

// Shared master bus: every voice (Chamber nodes AND Microcosmos germs) routes
// through one smoothed gain stage, an automatic voice-count headroom trim, a
// glue compressor, and a soft-clip safety stage before the speakers. One tap
// point (bus.output) feeds master recording and dish harvest, so what you
// record is exactly what you hear.
function canvasEnsureMasterBus() {
  const context = canvasPlaybackContext();
  if (!context) return null;
  if (canvasMasterBus && canvasMasterBus.context === context) return canvasMasterBus;
  const gain = context.createGain();
  gain.gain.value = germinatorMasterVolume();
  const headroom = context.createGain();
  headroom.gain.value = 1;
  let limiter = null;
  if (context.createDynamicsCompressor) {
    limiter = context.createDynamicsCompressor();
    limiter.threshold.value = -3;
    limiter.knee.value = 1.5;
    limiter.ratio.value = 12;
    limiter.attack.value = 0.002;
    limiter.release.value = 0.15;
  }
  const clip = context.createWaveShaper();
  clip.curve = softClipCurve();
  clip.oversample = "2x";
  gain.connect(headroom);
  if (limiter) {
    headroom.connect(limiter);
    limiter.connect(clip);
  } else {
    headroom.connect(clip);
  }
  clip.connect(context.destination);
  canvasMasterBus = { context, gain, headroom, limiter, clip, output: clip };
  return canvasMasterBus;
}

// Gentle master headroom: as simultaneous voices stack up, trim the bus by
// 1/sqrt(n/3) so the compressor glues instead of pumping. Slow smoothing keeps
// the move inaudible.
function canvasUpdateMasterHeadroom() {
  if (!canvasMasterBus?.headroom) return;
  const playing = canvasSoundNodes().filter((node) => node.audio && !node.audio.paused).length
    + (canvasTriggerPool?.activeCount || 0);
  const target = playing > 3 ? 1 / Math.sqrt(playing / 3) : 1;
  smoothSet(canvasMasterBus.headroom.gain, target, canvasMasterBus.context, 0.25);
}

function canvasEnsureTriggerPool() {
  const context = canvasPlaybackContext();
  if (!context) return null;
  if (!canvasTriggerPool || canvasTriggerPool.context !== context) {
    const pool = createVoicePool(context, canvasMasterBusInput() || context.destination, { maxVoices: 32 });
    pool.context = context;
    canvasTriggerPool = pool;
  }
  return canvasTriggerPool;
}

function canvasMasterBusInput() {
  const bus = canvasEnsureMasterBus();
  return bus ? bus.gain : (canvasPlaybackContext()?.destination ?? null);
}

function canvasFxNodesForTarget(node) {
  if (!node?.id) return [];
  return canvasNodes.filter((item) => item.type === "fx" && item.targetNodeId === node.id);
}

// Structural signature only: the chain rebuilds when FX modules are added,
// removed, or reordered — parameter values apply in place through each unit's
// apply() with smoothing, so a moving slider can never glitch the audio.
function canvasAudioGraphSignature(node) {
  return JSON.stringify({
    workletsReady: canvasWorkletsReady,
    fx: canvasFxNodesForTarget(node).map((fxNode) => ({
      id: fxNode.id,
      type: fxNode.fxType,
    })),
  });
}

function canvasRealtimeRoutesForTarget(node, path) {
  if (!node?.id) return [];
  return canvasModulatorNodes()
    .map(normalizeModulatorNode)
    .flatMap((modulator) => (modulator.routes || []).map((route) => ({ modulator, route })))
    .filter(({ modulator, route }) => {
      if (route?.enabled === false || route.targetNodeId !== node.id || route.targetPath !== path) return false;
      const target = modulationTargetForRoute(route);
      return target?.modulationRate === "realtime" && REALTIME_VALUE_MODULATOR_TYPES.has(modulator.modulatorType);
    });
}

function canvasRealtimeModulatedValue(node, path, baseValue) {
  const target = modulationTargetsForNode(node).find((item) => item.path === path);
  if (!target) return baseValue;
  return canvasRealtimeRoutesForTarget(node, path).reduce((value, { modulator, route }) =>
    modulationNumericValue(modulator, route, target, value, { rate: "realtime", targetNodeId: node.id }), baseValue);
}

function canvasHasRealtimeModulationRoutes() {
  return canvasModulatorNodes().some((node) => {
    const modulator = normalizeModulatorNode(node);
    if (!REALTIME_VALUE_MODULATOR_TYPES.has(modulator.modulatorType)) return false;
    return (modulator.routes || []).some((route) => {
      const target = modulationTargetForRoute(route);
      return route.enabled !== false && target?.modulationRate === "realtime";
    });
  });
}

function canvasRealtimeModulationFrame() {
  canvasRealtimeModulationRaf = null;
  if (!canvasHasRealtimeModulationRoutes()) return;
  canvasSoundNodes().forEach((node) => {
    if (node.audio) canvasApplyNodeAudioParams(node);
  });
  canvasRealtimeModulationRaf = requestAnimationFrame(canvasRealtimeModulationFrame);
}

function canvasEnsureRealtimeModulationLoop() {
  if (!canvasHasRealtimeModulationRoutes()) {
    if (canvasRealtimeModulationRaf) {
      cancelAnimationFrame(canvasRealtimeModulationRaf);
      canvasRealtimeModulationRaf = null;
    }
    return;
  }
  if (!canvasRealtimeModulationRaf) canvasRealtimeModulationRaf = requestAnimationFrame(canvasRealtimeModulationFrame);
}

function canvasClamp01(value, fallback = 0) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return fallback;
  return Math.min(1, Math.max(0, numeric));
}

function canvasLogFrequency(normalized) {
  const min = 36;
  const max = 18000;
  return min * Math.pow(max / min, canvasClamp01(normalized, 0.5));
}

function canvasFilterFrequency(fxNode) {
  const curve = Array.isArray(fxNode.params?.curve) && fxNode.params.curve.length
    ? fxNode.params.curve.map((value) => canvasClamp01(value, 0.5))
    : canvasDefaultFxParams("filter").curve;
  const mode = fxNode.params?.mode || "lowpass";
  if (mode === "highpass") return canvasLogFrequency(Math.min(0.62, Math.max(0.08, 1 - curve[curve.length - 1])));
  if (mode === "bandpass") {
    const weighted = curve.reduce((sum, value, index) => sum + value * (index / Math.max(1, curve.length - 1)), 0);
    const total = curve.reduce((sum, value) => sum + value, 0) || 1;
    return canvasLogFrequency(Math.min(0.78, Math.max(0.18, weighted / total)));
  }
  return canvasLogFrequency(Math.min(0.92, Math.max(0.32, curve[0])));
}

function canvasDistortionCurve(drive = 0.25, mode = "warm") {
  const samples = 1024;
  const curve = new Float32Array(samples);
  const modeGain = { subtle: 80, warm: 220, hard: 520 }[mode] || 220;
  const k = Math.max(1, canvasClamp01(drive, 0.25) * modeGain);
  for (let i = 0; i < samples; i += 1) {
    const x = (i * 2) / samples - 1;
    curve[i] = ((1 + k) * x) / (1 + k * Math.abs(x));
  }
  return curve;
}

function canvasGateCurve(threshold = 0.18, release = 0.22) {
  const samples = 1024;
  const curve = new Float32Array(samples);
  const gate = canvasClamp01(threshold, 0.18) * 0.45;
  const softness = Math.max(0.02, canvasClamp01(release, 0.22) * 0.3);
  for (let i = 0; i < samples; i += 1) {
    const x = (i * 2) / samples - 1;
    const abs = Math.abs(x);
    const amount = abs <= gate ? 0 : Math.min(1, (abs - gate) / softness);
    curve[i] = x * amount;
  }
  return curve;
}

// Equal-power wet/dry with a live setMix, so mix sweeps hold perceived level
// and never rebuild the chain.
function canvasWetDryUnit(context, processor, mix = 0.5, extraNodes = []) {
  const input = context.createGain();
  const dry = context.createGain();
  const wet = context.createGain();
  const output = context.createGain();
  const levels = equalPowerMix(canvasClamp01(mix, 0.5));
  dry.gain.value = levels.dry;
  wet.gain.value = levels.wet;
  input.connect(dry);
  input.connect(processor);
  processor.connect(wet);
  dry.connect(output);
  wet.connect(output);
  const unit = {
    input,
    output,
    dry,
    wet,
    nodes: [input, dry, wet, processor, output, ...extraNodes],
    setMix(nextMix, timeConstant = SMOOTH_UI) {
      const next = equalPowerMix(canvasClamp01(nextMix, 0.5));
      smoothSet(dry.gain, next.dry, context, timeConstant);
      smoothSet(wet.gain, next.wet, context, timeConstant);
    },
  };
  return unit;
}

function canvasGranularWorkletParams(fxNode) {
  const params = fxNode.params || {};
  const density = canvasClamp01(
    params.density ?? params.generation ?? (Number.isFinite(Number(params.rateHz)) ? Number(params.rateHz) / 80 : 0.58),
    0.58,
  );
  const jitter = canvasClamp01(params.jitter ?? params.drift ?? params.mutation ?? 0.35, 0.35);
  const scatter = canvasClamp01(params.frequencyScatter ?? params.spray ?? params.smear ?? jitter * 0.7, 0.25);
  const spray = canvasClamp01(params.spray ?? params.spread ?? 0.4, 0.4);
  const sizeMs = Number(params.sizeMs ?? params.grainSizeMs ?? params.durationMs ?? params.minCellMs ?? 70);
  return { density, sizeMs, jitter, scatter, spray };
}

// Every FX unit exposes apply(params): live, smoothed, in-place parameter
// updates. The audio graph itself is only rebuilt on structural changes
// (adding/removing FX modules), never while a slider moves.
function canvasBuildFxUnit(context, fxNode) {
  const params = fxNode.params || {};
  if (fxNode.fxType === "filter") {
    const filter = context.createBiquadFilter();
    filter.type = params.mode || "lowpass";
    filter.frequency.value = canvasFilterFrequency(fxNode);
    filter.Q.value = filter.type === "bandpass" ? 1.4 : 0.75;
    return {
      input: filter,
      output: filter,
      nodes: [filter],
      apply(nextParams) {
        const mode = nextParams.mode || "lowpass";
        if (filter.type !== mode) filter.type = mode;
        smoothSet(filter.frequency, canvasFilterFrequency({ ...fxNode, params: nextParams }), context, 0.02);
        smoothSet(filter.Q, mode === "bandpass" ? 1.4 : 0.75, context, 0.02);
      },
    };
  }
  if (fxNode.fxType === "space") {
    const convolver = context.createConvolver();
    let currentMode = params.mode || "room";
    convolver.buffer = createReverbImpulse(context, currentMode);
    const unit = canvasWetDryUnit(context, convolver, params.mix ?? 0.28);
    unit.apply = (nextParams) => {
      const mode = nextParams.mode || "room";
      if (mode !== currentMode) {
        currentMode = mode;
        convolver.buffer = createReverbImpulse(context, mode);
      }
      unit.setMix(nextParams.mix ?? 0.28);
    };
    return unit;
  }
  if (fxNode.fxType === "echo") {
    const input = context.createGain();
    const output = context.createGain();
    const dry = context.createGain();
    const wet = context.createGain();
    const delay = context.createDelay(1.5);
    const feedback = context.createGain();
    // Damping in the feedback loop: repeats darken like tape instead of
    // building into a metallic ring; the soft clip keeps high feedback
    // settings from running away.
    const damp = context.createBiquadFilter();
    damp.type = "lowpass";
    damp.frequency.value = 3400;
    damp.Q.value = 0.5;
    const loopClip = context.createWaveShaper();
    loopClip.curve = softClipCurve();
    const mixLevels = equalPowerMix(canvasClamp01(params.mix ?? 0.25, 0.25));
    delay.delayTime.value = Math.min(1.2, Math.max(0.04, Number(params.time) || 0.28));
    feedback.gain.value = Math.min(0.85, Math.max(0, Number(params.feedback) || 0.32));
    dry.gain.value = mixLevels.dry;
    wet.gain.value = mixLevels.wet;
    input.connect(dry);
    input.connect(delay);
    delay.connect(damp);
    damp.connect(loopClip);
    loopClip.connect(feedback);
    feedback.connect(delay);
    damp.connect(wet);
    dry.connect(output);
    wet.connect(output);
    return {
      input,
      output,
      nodes: [input, output, dry, wet, delay, feedback, damp, loopClip],
      apply(nextParams) {
        smoothSet(delay.delayTime, Math.min(1.2, Math.max(0.04, Number(nextParams.time) || 0.28)), context, SMOOTH_GLIDE);
        smoothSet(feedback.gain, Math.min(0.85, Math.max(0, Number(nextParams.feedback) || 0.32)), context, SMOOTH_UI);
        const next = equalPowerMix(canvasClamp01(nextParams.mix ?? 0.25, 0.25));
        smoothSet(dry.gain, next.dry, context, SMOOTH_UI);
        smoothSet(wet.gain, next.wet, context, SMOOTH_UI);
      },
    };
  }
  if (fxNode.fxType === "granular" || MICRO_FX_TYPES.has(fxNode.fxType)) {
    // True grain scheduling on the worklet when available; the legacy
    // comb+bandpass texture remains as the fallback audition voice.
    if (canvasWorkletsReady) {
      const granular = createGranularNode(context, canvasGranularWorkletParams(fxNode));
      if (granular) {
        const unit = canvasWetDryUnit(context, granular, params.mix ?? 0.32);
        unit.apply = (nextParams) => {
          try { granular.port.postMessage(canvasGranularWorkletParams({ ...fxNode, params: nextParams })); } catch {}
          unit.setMix(nextParams.mix ?? 0.32);
        };
        return unit;
      }
    }
    const input = context.createGain();
    const output = context.createGain();
    const dry = context.createGain();
    const wet = context.createGain();
    const delay = context.createDelay(0.35);
    const feedback = context.createGain();
    const filter = context.createBiquadFilter();
    const applyLegacy = (nextParams, timeConstant = SMOOTH_UI) => {
      const density = canvasClamp01(
        nextParams.density ?? nextParams.generation ?? (Number.isFinite(Number(nextParams.rateHz)) ? Number(nextParams.rateHz) / 80 : 0.58),
        0.58,
      );
      const jitter = canvasClamp01(nextParams.jitter ?? nextParams.drift ?? nextParams.frequencyScatter ?? nextParams.mutation ?? 0.35, 0.35);
      const sizeMs = Number(nextParams.sizeMs ?? nextParams.grainSizeMs ?? nextParams.durationMs ?? nextParams.minCellMs ?? 70);
      smoothSet(delay.delayTime, Math.min(0.32, Math.max(0.012, (sizeMs / 1000) * (0.65 + jitter))), context, SMOOTH_GLIDE);
      smoothSet(feedback.gain, Math.min(0.48, Math.max(0.02, density * 0.34 + jitter * 0.12)), context, timeConstant);
      smoothSet(filter.frequency, 1200 + density * 4200, context, timeConstant);
      smoothSet(filter.Q, 0.8 + jitter * 4, context, timeConstant);
      const next = equalPowerMix(canvasClamp01(nextParams.mix ?? 0.32, 0.32));
      smoothSet(dry.gain, next.dry, context, timeConstant);
      smoothSet(wet.gain, next.wet, context, timeConstant);
    };
    filter.type = "bandpass";
    input.connect(dry);
    input.connect(delay);
    delay.connect(feedback);
    feedback.connect(delay);
    delay.connect(filter);
    filter.connect(wet);
    dry.connect(output);
    wet.connect(output);
    applyLegacy(params, 0.001);
    return { input, output, nodes: [input, output, dry, wet, delay, feedback, filter], apply: applyLegacy };
  }
  if (fxNode.fxType === "saturation") {
    const shaper = context.createWaveShaper();
    shaper.curve = canvasDistortionCurve(params.drive ?? 0.28, params.mode || "warm");
    shaper.oversample = "4x";
    // Tone stage after the shaper: dark (2.2 kHz) to open (18 kHz). The
    // `tone` default existed but was never wired to anything.
    const tone = context.createBiquadFilter();
    tone.type = "lowpass";
    tone.Q.value = 0.6;
    const toneFrequency = (value) => 2200 * Math.pow(18000 / 2200, canvasClamp01(value, 0.55));
    tone.frequency.value = toneFrequency(params.tone ?? 0.55);
    shaper.connect(tone);
    let lastCurveKey = `${params.drive ?? 0.28}:${params.mode || "warm"}`;
    let lastCurveAt = 0;
    return {
      input: shaper,
      output: tone,
      nodes: [shaper, tone],
      apply(nextParams) {
        const curveKey = `${nextParams.drive ?? 0.28}:${nextParams.mode || "warm"}`;
        const now = performance.now();
        if (curveKey !== lastCurveKey && now - lastCurveAt > 30) {
          shaper.curve = canvasDistortionCurve(nextParams.drive ?? 0.28, nextParams.mode || "warm");
          lastCurveKey = curveKey;
          lastCurveAt = now;
        }
        smoothSet(tone.frequency, toneFrequency(nextParams.tone ?? 0.55), context, SMOOTH_UI);
      },
    };
  }
  if (fxNode.fxType === "gate") {
    // Envelope-follower gate on the worklet (attack/hold/release). The old
    // waveshaper "gate" stays only as the no-worklet fallback: it distorts
    // rather than gates, because it has no time behavior.
    if (canvasWorkletsReady) {
      const gate = createGateNode(context, {
        threshold: canvasClamp01(params.threshold ?? 0.18, 0.18),
        release: Math.max(0.02, Number(params.release) || 0.22),
      });
      if (gate) {
        return {
          input: gate,
          output: gate,
          nodes: [gate],
          apply(nextParams) {
            try {
              gate.port.postMessage({
                threshold: canvasClamp01(nextParams.threshold ?? 0.18, 0.18),
                release: Math.max(0.02, Number(nextParams.release) || 0.22),
              });
            } catch {}
          },
        };
      }
    }
    const shaper = context.createWaveShaper();
    shaper.curve = canvasGateCurve(params.threshold ?? 0.18, params.release ?? 0.22);
    return {
      input: shaper,
      output: shaper,
      nodes: [shaper],
      apply(nextParams) {
        shaper.curve = canvasGateCurve(nextParams.threshold ?? 0.18, nextParams.release ?? 0.22);
      },
    };
  }
  return null;
}

function canvasDisconnectAudioGraph(graph) {
  (graph?.nodes || []).forEach((audioNode) => {
    try { audioNode.disconnect(); } catch {}
  });
}

function canvasEnsureNodeAudioGraph(node) {
  if (!node?.audio) return null;
  const signature = canvasAudioGraphSignature(node);
  if (node.audioGraph?.signature === signature) return node.audioGraph;
  try {
    const context = canvasPlaybackContext();
    if (!context) return null;
    const source = node.audioGraph?.source || context.createMediaElementSource(node.audio);
    canvasDisconnectAudioGraph(node.audioGraph);
    const fxUnits = [];
    const fxUnitsById = new Map();
    let current = source;
    canvasFxNodesForTarget(node).forEach((fxNode) => {
      const unit = canvasBuildFxUnit(context, fxNode);
      if (!unit) return;
      current.connect(unit.input);
      current = unit.output;
      fxUnits.push(unit);
      fxUnitsById.set(fxNode.id, unit);
    });
    const gain = context.createGain();
    // Real level metering: a small analyser after the voice gain feeds the
    // mixer meters (the old meters animated a sine function).
    const analyser = context.createAnalyser();
    analyser.fftSize = 256;
    analyser.smoothingTimeConstant = 0.55;
    const panner = context.createStereoPanner ? context.createStereoPanner() : null;
    const busInput = canvasMasterBusInput() || context.destination;
    current.connect(gain);
    gain.connect(analyser);
    if (panner) {
      analyser.connect(panner);
      panner.connect(busInput);
    } else {
      analyser.connect(busInput);
    }
    node.audioGraph = {
      context,
      source,
      gain,
      analyser,
      meterData: new Uint8Array(analyser.frequencyBinCount),
      panner,
      fxUnits,
      fxUnitsById,
      nodes: [source, ...fxUnits.flatMap((unit) => unit.nodes || []), gain, analyser, panner].filter(Boolean),
      signature,
    };
    node.audio.volume = 1;
  } catch {
    node.audioGraph = null;
  }
  return node.audioGraph;
}

// Live FX parameter path: find the running unit for this FX module and apply
// values in place. Only falls back to a structural rebuild when the unit does
// not exist yet.
function canvasApplyFxNodeParams(fxNode) {
  const target = canvasNodes.find((item) => item.id === fxNode?.targetNodeId);
  if (!target?.audio || !target.audioGraph) return;
  const unit = target.audioGraph.fxUnitsById?.get(fxNode.id);
  if (unit?.apply) {
    try { unit.apply(fxNode.params || {}); } catch {}
    return;
  }
  canvasEnsureNodeAudioGraph(target);
}

function canvasRebuildActiveAudioGraphs() {
  canvasSoundNodes().forEach((node) => {
    if (!node.audio) return;
    node.audioGraph = { ...(node.audioGraph || {}), signature: "" };
    canvasEnsureNodeAudioGraph(node);
    canvasApplyNodeAudioParams(node);
  });
}

function canvasApplyNodeAudioParams(node) {
  if (!node?.audio) return;
  const soloed = canvasSoundNodes().some((item) => item.solo);
  const disabled = node.enabled === false;
  const baseVolume = disabled || node.muted || (soloed && !node.solo) ? 0 : Math.max(0, Number(node.volume ?? 1));
  const volume = disabled || node.muted || (soloed && !node.solo) ? 0 : Math.max(0, canvasRealtimeModulatedValue(node, "volume", baseVolume));
  const pan = Math.min(1, Math.max(-1, canvasRealtimeModulatedValue(node, "pan", Number(node.pan ?? 0))));
  const playbackRate = Math.min(4, Math.max(0.25, canvasRealtimeModulatedValue(node, "playbackRate", Number(node.playbackRate ?? 1))));
  if (node.audioGraph?.gain) {
    node.audio.volume = 1;
    // Smoothed level/pan: mute, solo, mixer moves, and rAF modulation all land
    // as short exponential ramps instead of stepping the AudioParam (zipper).
    smoothSet(node.audioGraph.gain.gain, volume, node.audioGraph.context, SMOOTH_FAST);
    if (node.audioGraph.panner) smoothSet(node.audioGraph.panner.pan, pan, node.audioGraph.context, SMOOTH_FAST);
  } else {
    node.audio.volume = Math.min(1, volume);
  }
  if (Number.isFinite(playbackRate)) node.audio.playbackRate = playbackRate;
}

async function canvasImportAudioBlob(blob, metadata, filename) {
  if (!blob?.size) throw new Error("No audio data to import.");
  const form = new FormData();
  const safeName = filename || `germ_import_${Date.now()}.wav`;
  form.append("file", new File([blob], safeName, { type: blob.type || "audio/wav" }));
  form.append("metadata", JSON.stringify(metadata || {}));
  return api("/audio/import", { method: "POST", body: form });
}

function canvasSoundMetadataSummary(node) {
  const asset = node?.type === "sound" ? canvasAssetById(node.assetId) : null;
  const metadata = asset?.metadata || {};
  const lineage = metadata.lineage || {};
  return {
    nodeId: node?.id || null,
    label: node?.label || "",
    assetId: asset?.id || null,
    audioPath: asset?.audioPath || asset?.storageUri || "",
    metadataPath: asset?.metadataPath || metadata.metadata_path || "",
    soundId: lineageSoundIdFromAsset(asset),
    prompt: metadata.prompt || lineage.prompt || metadata.operation_params?.prompt || "",
    operation: metadata.operation || lineage.operation || metadata.germinator_mode || "archive",
    parents: metadata.parents || lineage.parents || [],
    children: metadata.children || lineage.children || [],
    sourceType: metadata.source_type || metadata.source?.type || asset?.origin || "sound",
    strainStack: metadata.strain_stack || metadata.lora_strains || metadata.lora || [],
    latents: metadata.latents || {},
    latentFile: metadata.latent_file || metadata.latents?.file || "",
    latentFingerprint: metadata.latent_fingerprint || metadata.latents?.fingerprint || "",
  };
}

function canvasToggleSourceEnabled(nodeId) {
  const node = canvasNodes.find((item) => item.id === nodeId);
  if (node?.type !== "sound") return;
  node.enabled = node.enabled === false;
  selectedCanvasNodeId = node.id;
  if (node.audio) canvasApplyNodeAudioParams(node);
  canvasSaveState();
  renderCanvas();
  setState(node.enabled === false ? "Source Muted" : "Source Active", "ok", node.label || "Sound");
}

function canvasToggleSourceSolo(nodeId) {
  const node = canvasNodes.find((item) => item.id === nodeId);
  if (node?.type !== "sound") return;
  node.solo = !node.solo;
  selectedCanvasNodeId = node.id;
  applyMixerSoloMute();
  renderCanvas();
  setState(node.solo ? "Solo Active" : "Solo Off", "ok", node.label || "Sound");
}

function soundInfoFact(label, value) {
  if (value === null || value === undefined || value === "" || (Array.isArray(value) && !value.length)) return "";
  return `<span><strong>${escapeHtml(label)}</strong>${escapeHtml(Array.isArray(value) ? value.join(", ") : value)}</span>`;
}

async function openSoundInfoModal(nodeId) {
  const node = canvasNodes.find((item) => item.id === nodeId);
  const asset = node ? canvasAssetById(node.assetId) : null;
  const body = $("soundInfoBody");
  if (!node || !asset || !body) return;
  if (asset.metadataPath && (!asset.metadata || !Object.keys(asset.metadata).length)) {
    asset.metadata = await loadMetadata(asset.metadataPath).catch(() => asset.metadata || {});
  }
  const metadata = asset.metadata || {};
  const summary = canvasSoundMetadataSummary(node);
  const lineage = metadata.lineage || {};
  const parents = summary.parents || lineage.parents || [];
  const children = summary.children || lineage.children || [];
  body.className = "sound-info-body";
  body.innerHTML = `
    <div class="sound-info-grid">
      ${soundInfoFact("Node", node.label || node.id)}
      ${soundInfoFact("Operation", summary.operation)}
      ${soundInfoFact("Source", summary.sourceType)}
      ${soundInfoFact("Seed", metadata.seed ?? metadata.operation_params?.seed)}
      ${soundInfoFact("Model", metadata.model)}
      ${soundInfoFact("Duration", metadata.duration ? `${Number(metadata.duration).toFixed(2)}s` : "")}
      ${soundInfoFact("Regions", node.regions?.length ? `${node.regions.length}` : "")}
      ${soundInfoFact("Parents", parents)}
      ${soundInfoFact("Children", children)}
      ${soundInfoFact("Latent", summary.latentFingerprint || summary.latentFile)}
      ${soundInfoFact("Tags", metadata.tags || [])}
    </div>
    <div class="sound-info-actions">
      <button type="button" data-action="canvas-info-lineage" data-node-id="${escapeHtml(node.id)}">${iconSvg("lineage")}<span>Lineage</span></button>
      <button type="button" data-action="canvas-info-edit-metadata" data-node-id="${escapeHtml(node.id)}"><span>Edit Metadata</span></button>
      <button type="button" data-action="canvas-info-copy-path" data-node-id="${escapeHtml(node.id)}"><span>Copy Path</span></button>
    </div>
    <div class="sound-info-prompt">${escapeHtml(summary.prompt || metadata.notes || "No prompt metadata.")}</div>
    <details class="sound-info-raw" open>
      <summary>Genetic system</summary>
      <pre>${escapeHtml(JSON.stringify({
        sound: summary,
        lineage,
        regions: canvasRegionRolesPayload(node),
        operation_params: metadata.operation_params || {},
        source: metadata.source || {},
        latents: metadata.latents || {},
        lora: metadata.lora || metadata.lora_strains || [],
      }, null, 2))}</pre>
    </details>
  `;
  openCanvasModal("soundInfoModal");
}

function canvasMasterRecordElapsedSeconds() {
  if (!canvasMasterRecording?.startedAt) return 0;
  return Math.max(0, (performance.now() - canvasMasterRecording.startedAt) / 1000);
}

function canvasUpdateMasterRecordTime() {
  const time = $("masterRecordTime");
  if (!time) return;
  const active = Boolean(canvasMasterRecording);
  time.hidden = !active;
  if (active) time.textContent = `REC ${canvasMasterRecordElapsedSeconds().toFixed(1)}s`;
}

function canvasSetMasterRecordingUi(active) {
  $("canvasMasterRecordBtn")?.classList.toggle("recording", Boolean(active));
  const button = $("canvasMasterRecordBtn");
  if (button) {
    button.title = active ? "Stop master recording" : "Record master";
    button.setAttribute("aria-label", active ? "Stop master recording" : "Record master output");
  }
  canvasUpdateMasterRecordTime();
}

function canvasMasterRecordingParticipants(recording = canvasMasterRecording) {
  const ids = [...(recording?.nodeIds || new Set())];
  return ids
    .map((id) => canvasNodes.find((node) => node.id === id))
    .filter((node) => node?.type === "sound")
    .map(canvasSoundMetadataSummary);
}

async function canvasStartMasterRecording() {
  if (canvasMasterRecording) return;
  const context = canvasPlaybackContext();
  if (!context) throw new Error("Audio graph recording is not available in this browser.");
  try {
    if (context.state === "suspended") await context.resume();
    const masterBus = canvasEnsureMasterBus();
    canvasSoundNodes().forEach((node) => canvasEnsureNodeAudio(node));
    canvasRebuildActiveAudioGraphs();
    const activeNodes = canvasSoundNodes().filter((node) => node.audio && !node.audio.paused).map((node) => node.id);
    // Preferred path: lossless PCM tap on the master output → dithered WAV.
    // The webm/opus MediaRecorder remains only as the no-worklet fallback,
    // because an opus master defeats the point of a quality chain.
    const wavRecorder = masterBus?.output ? await createWavRecorder(context, masterBus.output) : null;
    if (wavRecorder) {
      canvasMasterRecording = {
        kind: "wav",
        startedAt: performance.now(),
        startedAtIso: new Date().toISOString(),
        nodeIds: new Set(activeNodes),
        wavRecorder,
      };
      wavRecorder.start();
    } else {
      if (typeof MediaRecorder === "undefined" || !context.createMediaStreamDestination) {
        throw new Error("Master recording is not available in this browser.");
      }
      canvasMasterRecordDestination = context.createMediaStreamDestination();
      if (masterBus?.output) masterBus.output.connect(canvasMasterRecordDestination);
      const mimeType = MediaRecorder.isTypeSupported?.("audio/webm;codecs=opus")
        ? "audio/webm;codecs=opus"
        : "audio/webm";
      const recorder = new MediaRecorder(canvasMasterRecordDestination.stream, { mimeType });
      canvasMasterRecording = {
        kind: "webm",
        startedAt: performance.now(),
        startedAtIso: new Date().toISOString(),
        chunks: [],
        nodeIds: new Set(activeNodes),
        mimeType,
      };
      canvasMasterRecorder = recorder;
      recorder.addEventListener("dataavailable", (event) => {
        if (event.data?.size && canvasMasterRecording) canvasMasterRecording.chunks.push(event.data);
      });
      recorder.addEventListener("stop", () => {
        canvasCommitMasterRecording().catch((error) => finishWork("Record Error", "bad", error.message));
      });
      recorder.start(250);
    }
    canvasMasterRecordTimer = window.setInterval(canvasUpdateMasterRecordTime, 100);
    canvasSetMasterRecordingUi(true);
    setState("Recording", "busy", canvasMasterRecording.kind === "wav" ? "Capturing master output (lossless WAV)." : "Capturing master output.");
  } catch (error) {
    if (canvasMasterBus?.output && canvasMasterRecordDestination) {
      try { canvasMasterBus.output.disconnect(canvasMasterRecordDestination); } catch {}
    }
    canvasMasterRecordDestination = null;
    canvasMasterRecording = null;
    canvasMasterRecorder = null;
    if (canvasMasterRecordTimer) {
      clearInterval(canvasMasterRecordTimer);
      canvasMasterRecordTimer = null;
    }
    canvasSetMasterRecordingUi(false);
    throw error;
  }
}

function canvasStopMasterRecording() {
  if (!canvasMasterRecording) return;
  if (canvasMasterRecording.kind === "wav") {
    canvasCommitMasterRecording().catch((error) => finishWork("Record Error", "bad", error.message));
    return;
  }
  if (!canvasMasterRecorder) return;
  try {
    if (canvasMasterRecorder.state !== "inactive") canvasMasterRecorder.stop();
  } catch (error) {
    finishWork("Record Error", "bad", error.message);
  }
}

async function canvasCommitMasterRecording() {
  const recording = canvasMasterRecording;
  if (!recording) return;
  if (canvasMasterRecordTimer) {
    clearInterval(canvasMasterRecordTimer);
    canvasMasterRecordTimer = null;
  }
  canvasMasterRecording = null;
  canvasMasterRecorder = null;
  const duration = Math.max(0.1, (performance.now() - recording.startedAt) / 1000);
  if (canvasMasterBus?.output && canvasMasterRecordDestination) {
    try { canvasMasterBus.output.disconnect(canvasMasterRecordDestination); } catch {}
  }
  canvasMasterRecordDestination = null;
  canvasRebuildActiveAudioGraphs();
  canvasSetMasterRecordingUi(false);
  let blob = null;
  let extension = "webm";
  if (recording.kind === "wav") {
    const captured = await recording.wavRecorder.stop().catch(() => null);
    if (captured?.blob?.size) {
      blob = captured.blob;
      extension = "wav";
    }
  } else {
    const chunks = recording.chunks || [];
    if (chunks.length) blob = new Blob(chunks, { type: recording.mimeType || "audio/webm" });
  }
  if (!blob?.size) {
    setState("Recording Empty", "bad", "No master audio was captured.");
    return;
  }
  const participants = canvasMasterRecordingParticipants(recording);
  const parentIds = participants.map((item) => item.soundId).filter(Boolean);
  const parentMetadataPaths = participants.map((item) => item.metadataPath).filter(Boolean);
  const name = `organism_${recording.startedAtIso.replace(/[:.]/g, "-")}.${extension}`;
  const metadata = {
    provider: "mock",
    model: "browser-master-recorder",
    recording_format: extension === "wav" ? "wav-pcm16" : "webm-opus",
    prompt: "Master output organism recording",
    negative_prompt: "",
    duration,
    seed: -1,
    output_name: name.replace(/\.[^.]+$/, ""),
    culture_id: activeCulture.id,
    tags: ["organism", "master-output", "recording"],
    notes: `Master output recording with ${participants.length} participating sound module(s).`,
    source_type: "organism",
    source: { type: "organism", participants },
    organism: {
      recorded_at: recording.startedAtIso,
      duration,
      participant_count: participants.length,
      participants,
      canvas_snapshot: canvasSerializableGraph(),
    },
    lineage: {
      parents: parentIds,
      parent_metadata_paths: parentMetadataPaths,
      operation: "organism_recording",
      source_type: "organism",
      operation_params: {
        recorded_at: recording.startedAtIso,
        duration,
        participants,
      },
    },
  };
  let result;
  try {
    result = await canvasImportAudioBlob(blob, metadata, name);
  } catch (error) {
    // A failed import must not lose the take: hand the blob to the browser as a
    // local download before surfacing the error.
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = name;
    document.body.appendChild(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    throw new Error(`${error.message} The recording was saved to your downloads as ${name}.`);
  }
  const metadataPath = result.metadata_files?.[0] || "";
  const audioPath = result.audio_files?.[0] || "";
  const importedMetadata = metadataPath ? await loadMetadata(metadataPath) : metadata;
  const asset = canvasCreateAsset({
    audioPath,
    metadataPath,
    metadata: importedMetadata,
    origin: "organism",
    parentAssetIds: participants.map((item) => item.assetId).filter(Boolean),
  });
  canvasCreateSoundNode({
    asset,
    label: "Master organism",
    x: canvasBoardDefaultPoint().x,
    y: canvasBoardDefaultPoint().y,
    edgeType: "mix",
  });
  await refreshLibrary(false);
  renderCanvas();
  setState("Organism Recorded", "ok", `${duration.toFixed(1)}s master output`);
}

async function canvasToggleMasterRecording() {
  if (canvasMasterRecording) {
    canvasStopMasterRecording();
    return;
  }
  await canvasStartMasterRecording();
}

function fileToDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.addEventListener("load", () => resolve(String(reader.result || "")));
    reader.addEventListener("error", () => reject(reader.error || new Error("Could not read file.")));
    reader.readAsDataURL(file);
  });
}

function loadImageElement(src) {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.addEventListener("load", () => resolve(image));
    image.addEventListener("error", () => reject(new Error("Could not load image.")));
    image.src = src;
  });
}

function dataUrlBase64(dataUrl = "") {
  const comma = dataUrl.indexOf(",");
  return comma >= 0 ? dataUrl.slice(comma + 1) : dataUrl;
}

function canvasImageLatentFingerprint(dataUrl = "") {
  let hash = 2166136261;
  const sample = dataUrl.slice(-4096);
  for (let index = 0; index < sample.length; index += 1) {
    hash ^= sample.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return `image-fnv1a-${(hash >>> 0).toString(16).padStart(8, "0")}`;
}

async function canvasAddImageFile(file, { position = null, mode = "vision", nodeId = null } = {}) {
  if (!file || !file.type.startsWith("image/")) throw new Error("Choose a PNG, JPEG, or WebP image.");
  const dataUrl = await fileToDataUrl(file);
  const existing = nodeId ? canvasNodes.find((node) => node.id === nodeId) : null;
  if (existing?.type === "image") {
    existing.imageDataUrl = dataUrl;
    existing.imageName = file.name;
    existing.imageType = file.type || "image/png";
    existing.label = file.name;
    existing.imageMode = mode || existing.imageMode || "vision";
    selectedCanvasNodeId = existing.id;
    renderCanvas();
    canvasSaveState();
    return existing;
  }
  const point = position || canvasBoardDefaultPoint();
  const node = canvasCreateImageNode({ file, dataUrl, mode, x: point.x, y: point.y });
  canvasSaveState();
  setState("Image Source", "ok", file.name);
  return node;
}

async function canvasSynthesizeImageSpectrogram(node) {
  if (!node?.imageDataUrl) throw new Error("Choose an image first.");
  const image = await loadImageElement(node.imageDataUrl);
  const cols = 112;
  const bins = 36;
  const scratch = document.createElement("canvas");
  scratch.width = cols;
  scratch.height = bins;
  const ctx = scratch.getContext("2d", { willReadFrequently: true });
  ctx.drawImage(image, 0, 0, cols, bins);
  const pixels = ctx.getImageData(0, 0, cols, bins).data;
  const sampleRate = 44100;
  const duration = Math.min(60, Math.max(0.5, Number(node.durationSec) || 6));
  const frameCount = Math.max(1, Math.floor(sampleRate * duration));
  const context = audioContextForDecode();
  const buffer = context.createBuffer(1, frameCount, sampleRate);
  const output = buffer.getChannelData(0);
  const phases = new Float64Array(bins);
  const freqMin = 48;
  const freqMax = 12000;
  const segment = Math.ceil(frameCount / cols);
  for (let col = 0; col < cols; col += 1) {
    const start = col * segment;
    const end = Math.min(frameCount, start + segment);
    for (let frame = start; frame < end; frame += 1) {
      let sample = 0;
      const local = (frame - start) / Math.max(1, end - start);
      const env = Math.sin(Math.PI * local);
      for (let bin = 0; bin < bins; bin += 1) {
        const y = bins - bin - 1;
        const idx = (y * cols + col) * 4;
        const lum = (pixels[idx] + pixels[idx + 1] + pixels[idx + 2]) / 765;
        const amp = Math.max(0, lum - 0.08) ** 1.9;
        if (amp <= 0.002) continue;
        const freq = freqMin * Math.pow(freqMax / freqMin, bin / Math.max(1, bins - 1));
        phases[bin] += (2 * Math.PI * freq) / sampleRate;
        sample += Math.sin(phases[bin]) * amp * env;
      }
      output[frame] = sample / 9;
    }
  }
  let peak = 0;
  for (let i = 0; i < output.length; i += 1) peak = Math.max(peak, Math.abs(output[i]));
  if (peak > 0.001) {
    const gain = Math.min(1, 0.82 / peak);
    for (let i = 0; i < output.length; i += 1) output[i] *= gain;
  }
  return buffer;
}

function canvasImageGeneratedPoint(node) {
  if (!node) return canvasBoardDefaultPoint();
  return {
    x: node.x + (node.width || 332) + 72,
    y: node.y,
  };
}

async function runCanvasImageToAudio(nodeId) {
  const node = canvasNodes.find((item) => item.id === nodeId);
  if (!node || node.type !== "image") return;
  if (!node.imageDataUrl) throw new Error("Choose an image before generating.");
  selectedCanvasNodeId = node.id;
  renderCanvas();
  const duration = Math.min(60, Math.max(0.5, Number(node.durationSec) || 6));
  const fingerprint = canvasImageLatentFingerprint(node.imageDataUrl);
  if (node.imageMode === "spectrogram") {
    beginWork("Image Spectrogram", node.label || "image");
    const buffer = await canvasSynthesizeImageSpectrogram(node);
    const blob = audioBufferToWavBlob(buffer);
    const filename = `image_spectrogram_${new Date().toISOString().replace(/[:.]/g, "-")}.wav`;
    const metadata = {
      provider: "mock",
      model: "browser-image-spectrogram",
      prompt: node.imagePrompt || "Image interpreted as a spectrogram.",
      duration,
      seed: -1,
      output_name: filename.replace(/\.[^.]+$/, ""),
      culture_id: activeCulture.id,
      tags: ["image", "spectrogram"],
      source_type: "image",
      source: { type: "image", mode: "spectrogram", image_name: node.imageName },
      latents: { fingerprint, type: "image-spectrogram-fingerprint" },
      latent_fingerprint: fingerprint,
      image: {
        name: node.imageName,
        mime_type: node.imageType,
        mode: "spectrogram",
        fingerprint,
      },
      lineage: {
        parents: [],
        operation: "image_spectrogram",
        source_type: "image",
        source_node_id: node.id,
        operation_params: {
          image_name: node.imageName,
          image_mode: "spectrogram",
          duration,
          latent_fingerprint: fingerprint,
        },
      },
    };
    const result = await canvasImportAudioBlob(blob, metadata, filename);
    const metadataPath = result.metadata_files?.[0] || "";
    const audioPath = result.audio_files?.[0] || "";
    const importedMetadata = metadataPath ? await loadMetadata(metadataPath) : metadata;
    const asset = canvasCreateAsset({ audioPath, metadataPath, metadata: importedMetadata, origin: "image" });
    const point = canvasImageGeneratedPoint(node);
    canvasCreateSoundNode({ asset, label: displayNameFromPath(audioPath), x: point.x, y: point.y, parentNodeId: node.id, edgeType: "audio_context" });
    await refreshLibrary(false);
    finishWork("Image Sound Ready", "ok", audioPath);
    return;
  }

  beginWork("Image Analysis", node.label || "image");
  const analysis = await api("/image-to-audio/analyze", {
    method: "POST",
    body: JSON.stringify({
      image_base64: dataUrlBase64(node.imageDataUrl),
      mime_type: node.imageType || "image/png",
      mode: "vision",
      interpretation_mode: node.interpretationMode || "cinematic",
      use_case: "sound_design",
    }),
  });
  const prompt = node.imagePrompt?.trim() || analysis.prompt || analysis.soundCards?.[0]?.prompt || "";
  node.imagePrompt = prompt;
  const result = await api("/generate", {
    method: "POST",
    body: JSON.stringify(
      canvasBuildPayload({
        operation: "image_to_audio",
        prompt,
        duration: Math.min(60, Math.max(0.5, Number(analysis.duration) || duration)),
        batch_size: 1,
        output_name: safeOutputName(`image_${node.label || "source"}`),
        source: {
          type: "image",
          mode: "vision",
          image_name: node.imageName,
          analysis_provider: analysis.analysis_provider || "local_fallback",
          cloud_vision: Boolean(analysis.cloud_vision),
        },
        generation_context: {
          image_analysis: {
            provider: analysis.analysis_provider || "local_fallback",
            cloud_vision: Boolean(analysis.cloud_vision),
            cloud_vision_enabled: Boolean(analysis.cloud_vision_enabled),
            image_summary: analysis.imageSummary || "",
            visual_elements: analysis.visualElements || [],
            acoustic_space: analysis.acousticSpace || "",
            material_textures: analysis.materialTextures || [],
            mood: analysis.mood || {},
          },
        },
        latents: { fingerprint, type: "image-identity-fingerprint" },
        latent_fingerprint: fingerprint,
        lineage: canvasLineagePayload("image_to_audio", {
          sourceNode: node,
          extraParams: {
            prompt,
            image_name: node.imageName,
            image_mode: "vision",
            image_summary: analysis.imageSummary || "",
            analysis_provider: analysis.analysis_provider || "local_fallback",
            cloud_vision: Boolean(analysis.cloud_vision),
            latent_fingerprint: fingerprint,
          },
        }),
      }),
    ),
  });
  await canvasCreateCandidatesFromResult(result, { operation: "image_to_audio", sourceNodeId: node.id });
  node.imageAnalysis = analysis;
  renderCanvas();
  finishWork("Image Sound Ready", result.status === "done" ? "ok" : "bad", result.error || prompt.slice(0, 80));
}

function canvasLinkedContinuationForSource(node) {
  if (!node) return null;
  return canvasSoundNodes().find((item) => item.attachedToNodeId === node.id && item.linkedPlayback) || null;
}

function canvasLinkedSourceForContinuation(node) {
  if (!node?.attachedToNodeId || !node.linkedPlayback) return null;
  const source = canvasNodes.find((item) => item.id === node.attachedToNodeId);
  return source?.type === "sound" ? source : null;
}

// Anti-click envelopes around HTMLMediaElement voices: a ~12 ms ramp-in on
// play and a ~15 ms ramp-out before pause. Media elements themselves cut the
// waveform mid-sample on play()/pause(), which is audible as a tick.
function canvasFadeInNode(node) {
  if (node?._stopTimer) {
    // A pending fade-out pause must not kill the playback we are starting.
    clearTimeout(node._stopTimer);
    node._stopTimer = null;
  }
  const graph = node?.audioGraph;
  if (!graph?.gain) return;
  try {
    graph.gain.gain.cancelScheduledValues(graph.context.currentTime);
    graph.gain.gain.setValueAtTime(0, graph.context.currentTime);
  } catch {}
  canvasApplyNodeAudioParams(node);
}

async function canvasPlayNodeFromStart(node, startSec = null) {
  const audio = await canvasEnsurePlaybackAudio(node);
  if (!audio) return;
  if (node.audioGraph?.context?.state === "suspended") await node.audioGraph.context.resume();
  const range = canvasNodePlaybackRange(node);
  audio.currentTime = canvasAudioStartTimeForRange(node, startSec ?? range.start, range.end);
  canvasFadeInNode(node);
  await audio.play();
  if (canvasMasterRecording) canvasMasterRecording.nodeIds.add(node.id);
  canvasUpdateMasterHeadroom();
  startCanvasPlaybackFrame();
}

function canvasStopNodeAudio(node, { immediate = false } = {}) {
  if (!node?.audio) return;
  if (node._stopTimer) {
    clearTimeout(node._stopTimer);
    node._stopTimer = null;
  }
  const graph = node.audioGraph;
  if (!immediate && graph?.gain && !node.audio.paused) {
    const now = graph.context.currentTime;
    try {
      graph.gain.gain.cancelScheduledValues(now);
      graph.gain.gain.setValueAtTime(graph.gain.gain.value, now);
      graph.gain.gain.linearRampToValueAtTime(0, now + 0.015);
    } catch {}
    node._stopTimer = window.setTimeout(() => {
      node._stopTimer = null;
      node.audio?.pause();
      if (node.audio) node.audio.currentTime = canvasPlaybackResetTime(node);
      canvasUpdateMasterHeadroom();
    }, 26);
    return;
  }
  node.audio.pause();
  node.audio.currentTime = canvasPlaybackResetTime(node);
  canvasUpdateMasterHeadroom();
}

async function canvasHandlePlaybackRangeEnd(node) {
  if (!node?.audio || node.audio.paused) return;
  const continuation = canvasLinkedContinuationForSource(node);
  if (continuation) {
    canvasStopNodeAudio(node, { immediate: true });
    await canvasPlayNodeFromStart(continuation);
    return;
  }
  const source = canvasLinkedSourceForContinuation(node);
  if (source) {
    canvasStopNodeAudio(node, { immediate: true });
    await canvasPlayNodeFromStart(source, 0);
    return;
  }
  const loopRegion = canvasLoopRegion(node);
  if (node.loop && loopRegion) {
    const bounds = canvasRegionBounds(loopRegion);
    if (bounds) node.audio.currentTime = canvasAudioStartTimeForRange(node, bounds.start, bounds.end);
    return;
  }
  if (node.playbackEndSec) {
    canvasStopNodeAudio(node);
  }
}

function canvasApplyLoopRegionsAndChains(soundNodes) {
  (soundNodes || canvasSoundNodes()).forEach((node) => {
    const audio = node.audio;
    if (!audio || audio.paused) return;
    const loopRegion = canvasLoopRegion(node);
    const forwardTime = canvasAudioTimeToForwardTime(node, audio.currentTime);
    const loopBounds = canvasRegionBounds(loopRegion);
    if (node.loop && loopBounds) {
      const outOfLoop = node.reversePlayback
        ? forwardTime <= loopBounds.start || forwardTime > loopBounds.end
        : forwardTime < loopBounds.start || forwardTime >= loopBounds.end;
      if (outOfLoop) {
        audio.currentTime = canvasAudioStartTimeForRange(node, loopBounds.start, loopBounds.end);
        return;
      }
    }
    const start = canvasNodePlaybackStart(node);
    const end = canvasNodePlaybackEnd(node);
    const outOfRange = node.reversePlayback ? forwardTime <= start : forwardTime >= end;
    if (node.playbackEndSec && outOfRange) {
      canvasHandlePlaybackRangeEnd(node);
      return;
    }
  });
}

function updateCanvasTimeReadouts(soundNodes) {
  (soundNodes || canvasSoundNodes()).forEach((node) => {
    const target = document.querySelector(`.canvas-node-time[data-node-id="${CSS.escape(node.id)}"]`);
    if (!target) return;
    const current = canvasPlaybackElapsedTime(node);
    target.textContent = `${formatPreciseTime(current)} / ${formatPreciseTime(canvasNodeDuration(node))}`;
  });
  updateCanvasPlayPauseIcons(soundNodes);
}

function updateCanvasPlayPauseIcons(soundNodes) {
  (soundNodes || canvasSoundNodes()).forEach((node) => {
    const btn = document.querySelector(`.wave-edge-play[data-node-id="${CSS.escape(node.id)}"][data-action="canvas-play-node"], .wave-edge-play[data-node-id="${CSS.escape(node.id)}"][data-action="canvas-stop-node"]`);
    if (!btn) return;
    const playing = node.audio && !node.audio.paused;
    const action = playing ? "canvas-stop-node" : "canvas-play-node";
    const label = playing ? "Pause" : "Play";
    if (btn.dataset.action !== action) {
      btn.dataset.action = action;
      btn.title = label;
      btn.setAttribute("aria-label", label);
      btn.innerHTML = playing
        ? '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><rect x="6" y="4" width="4" height="16"/><rect x="14" y="4" width="4" height="16"/></svg>'
        : '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><polygon points="5 3 19 12 5 21 5 3"/></svg>';
    }
  });
}

function updateCanvasMixerMeters(soundNodes = canvasSoundNodes()) {
  soundNodes.forEach((node) => {
    const playing = node.audio && !node.audio.paused;
    let level = 0;
    const graph = node.audioGraph;
    if (playing && graph?.analyser && graph.meterData) {
      // Real level from the per-voice analyser (peak of the time-domain
      // block) — the previous meters animated a sine function.
      graph.analyser.getByteTimeDomainData(graph.meterData);
      let peak = 0;
      for (let i = 0; i < graph.meterData.length; i += 1) {
        const deviation = Math.abs(graph.meterData[i] - 128);
        if (deviation > peak) peak = deviation;
      }
      level = Math.min(1, (peak / 128) * 1.35);
    }
    node.meterLevel = level;
    document.querySelectorAll(`.mixer-row[data-target-node-id="${CSS.escape(node.id)}"] .mixer-meter i`).forEach((bar) => {
      bar.style.height = `${Math.round(node.meterLevel * 100)}%`;
    });
  });
}

function canvasAnyAudioPlaying(soundNodes) {
  return (soundNodes || canvasSoundNodes()).some((node) => node.audio && !node.audio.paused);
}

let canvasHeadroomTickCounter = 0;

function canvasPlaybackTick() {
  canvasTransportFrame = null;
  const sn = canvasSoundNodes();
  canvasApplyLoopRegionsAndChains(sn);
  drawCanvasWaveforms({ activeOnly: true });
  updateCanvasTimeReadouts(sn);
  updateCanvasMixerMeters(sn);
  canvasHeadroomTickCounter = (canvasHeadroomTickCounter + 1) % 30;
  if (canvasHeadroomTickCounter === 0) canvasUpdateMasterHeadroom();
  if (canvasAnyAudioPlaying(sn)) {
    canvasTransportFrame = requestAnimationFrame(canvasPlaybackTick);
  }
}

function startCanvasPlaybackFrame() {
  if (!canvasTransportFrame) canvasTransportFrame = requestAnimationFrame(canvasPlaybackTick);
}

async function canvasPlayNode(nodeId) {
  const node = canvasNodes.find((item) => item.id === nodeId);
  const audio = await canvasEnsurePlaybackAudio(node);
  if (!node || !audio) return;
  if (node.type === "sound") canvasLastSelectedSoundNodeId = node.id;
  const source = canvasLinkedSourceForContinuation(node);
  if (source) canvasStopNodeAudio(source);
  const continuation = canvasLinkedContinuationForSource(node);
  if (continuation) canvasStopNodeAudio(continuation);
  const range = canvasNodePlaybackRange(node);
  const forwardTime = canvasAudioTimeToForwardTime(node, audio.currentTime);
  const outOfRange = node.reversePlayback
    ? forwardTime <= range.start || forwardTime > range.end
    : forwardTime < range.start || forwardTime >= range.end;
  if (audio.ended || outOfRange) audio.currentTime = canvasAudioStartTimeForRange(node, range.start, range.end);
  if (node.audioGraph?.context?.state === "suspended") await node.audioGraph.context.resume();
  canvasFadeInNode(node);
  await audio.play();
  if (canvasMasterRecording) canvasMasterRecording.nodeIds.add(node.id);
  canvasUpdateMasterHeadroom();
  startCanvasPlaybackFrame();
}

function canvasStopNode(nodeId) {
  const node = canvasNodes.find((item) => item.id === nodeId);
  canvasStopNodeAudio(node);
  const continuation = canvasLinkedContinuationForSource(node);
  if (continuation) canvasStopNodeAudio(continuation);
  const source = canvasLinkedSourceForContinuation(node);
  if (source) canvasStopNodeAudio(source);
  if (!canvasAnyAudioPlaying() && canvasTransportFrame) {
    cancelAnimationFrame(canvasTransportFrame);
    canvasTransportFrame = null;
  }
  drawCanvasWaveforms();
  updateCanvasTimeReadouts();
}

function canvasToggleLoop(nodeId) {
  const node = canvasNodes.find((item) => item.id === nodeId);
  if (!node || node.type !== "sound") return;
  node.loop = !node.loop;
  if (node.loop && !canvasGlobalLoop) canvasToggleGlobalLoop();
  const audio = canvasEnsureNodeAudio(node);
  if (audio) audio.loop = canvasNativeLoopFlag(node);
  renderCanvas();
  setState(node.loop ? "Loop On" : "Loop Off", "ok", canvasLoopRegion(node) ? "Looping the green section." : node.label || node.id);
}

async function canvasToggleReverse(nodeId) {
  const node = canvasNodes.find((item) => item.id === nodeId);
  if (!node || node.type !== "sound") return;
  const wasPlaying = node.audio && !node.audio.paused;
  const currentForwardTime = node.audio
    ? canvasAudioTimeToForwardTime(node, node.audio.currentTime)
    : canvasNodePlaybackRange(node).end;
  node.reversePlayback = !node.reversePlayback;
  canvasDisposeNodeAudio(node);
  if (node.reversePlayback) await canvasPrepareReverseAudio(node);
  if (wasPlaying) {
    const audio = await canvasEnsurePlaybackAudio(node);
    if (audio) {
      audio.currentTime = canvasForwardTimeToAudioTime(node, currentForwardTime);
      if (node.audioGraph?.context?.state === "suspended") await node.audioGraph.context.resume();
      await audio.play();
    }
  }
  renderCanvas();
  canvasSaveState();
  setState(node.reversePlayback ? "Reverse On" : "Reverse Off", "ok", node.label || node.id);
}

function canvasSetPlaybackRate(nodeId, value) {
  const node = canvasNodes.find((item) => item.id === nodeId);
  if (!node || node.type !== "sound") return;
  const rate = Math.min(4, Math.max(0.25, Number(value) || 1));
  node.playbackRate = rate;
  const audio = canvasEnsureNodeAudio(node);
  if (audio) audio.playbackRate = rate;
  canvasSaveState();
}

async function canvasGlobalPlay() {
  const nodes = canvasSoundNodes().filter((node) => !canvasLinkedSourceForContinuation(node));
  if (!nodes.length) {
    setState("No Sounds", "muted", "Add or generate a sound module before using the transport.");
    return;
  }
  const startedAt = canvasTransportSync ? 0 : null;
  await Promise.allSettled(nodes.map(async (node) => {
    const audio = await canvasEnsurePlaybackAudio(node);
    if (!audio) return;
    if (startedAt !== null) audio.currentTime = canvasPlaybackResetTime(node);
    if (node.audioGraph?.context?.state === "suspended") await node.audioGraph.context.resume();
    await audio.play();
    if (canvasMasterRecording) canvasMasterRecording.nodeIds.add(node.id);
  }));
  startCanvasPlaybackFrame();
  setState(canvasTransportSync ? "Sync Playing" : "Playing", "ok", `${nodes.length} sound module(s)`);
}

function canvasGlobalStop() {
  canvasSoundNodes().forEach((node) => canvasStopNode(node.id));
  if (canvasTransportFrame) {
    cancelAnimationFrame(canvasTransportFrame);
    canvasTransportFrame = null;
  }
  setState("Stopped", "ok", "All sound modules stopped.");
  canvasIsPlaying = false;
  const playBtn = $("canvasGlobalPlayBtn");
  if (playBtn) { playBtn.innerHTML = '<svg class="button-icon" viewBox="0 0 24 24" fill="currentColor" stroke="none" aria-hidden="true"><polygon points="6,4 20,12 6,20"/></svg>'; playBtn.title = "Play"; playBtn.setAttribute("aria-label", "Play all sound modules"); }
}

let canvasIsPlaying = false;

function canvasTogglePlayStop() {
  if (canvasIsPlaying) {
    canvasGlobalStop();
  } else {
    canvasGlobalPlay();
    canvasIsPlaying = true;
    const btn = $("canvasGlobalPlayBtn");
    if (btn) { btn.innerHTML = '<svg class="button-icon" viewBox="0 0 24 24" fill="currentColor" stroke="none" aria-hidden="true"><rect x="5" y="4" width="14" height="16" rx="1"/></svg>'; btn.title = "Stop"; btn.setAttribute("aria-label", "Stop all sound modules"); }
  }
}

function canvasToggleGlobalSync() {
  canvasTransportSync = !canvasTransportSync;
  const button = $("canvasGlobalSyncBtn");
  if (button) {
    button.title = canvasTransportSync ? "Global sync on" : "Global sync off";
    button.setAttribute("aria-label", canvasTransportSync ? "Turn global sync off" : "Turn global sync on");
    button.classList.toggle("active", canvasTransportSync);
  }
  setState(canvasTransportSync ? "Sync On" : "Sync Off", "muted", canvasTransportSync ? "Global play resets all sound modules to zero." : "Global play resumes each module from its own position.");
}

function canvasToggleGlobalLoop() {
  canvasGlobalLoop = !canvasGlobalLoop;
  canvasSoundNodes().forEach((node) => {
    node.loop = canvasGlobalLoop;
    const audio = canvasEnsureNodeAudio(node);
    if (audio) audio.loop = canvasNativeLoopFlag(node, canvasGlobalLoop);
  });
  const button = $("canvasGlobalLoopBtn");
  if (button) {
    button.title = canvasGlobalLoop ? "Global loop on" : "Global loop off";
    button.setAttribute("aria-label", canvasGlobalLoop ? "Turn global loop off" : "Turn global loop on");
    button.classList.toggle("active", canvasGlobalLoop);
  }
  renderCanvas();
  setState(canvasGlobalLoop ? "Loop On" : "Loop Off", "ok", canvasGlobalLoop ? "All sound modules loop during playback." : "Global looping disabled.");
}

function canvasToggleChain(nodeId) {
  const node = canvasNodes.find((item) => item.id === nodeId);
  if (!node || node.type !== "sound" || !node.attachedToNodeId) return;
  node.linkedPlayback = !node.linkedPlayback;
  const source = canvasNodes.find((item) => item.id === node.attachedToNodeId);
  [node, source].forEach((item) => {
    const audio = canvasEnsureNodeAudio(item);
    if (audio) audio.loop = false;
  });
  renderCanvas();
  setState(node.linkedPlayback ? "Playback Linked" : "Playback Unlinked", "ok", node.linkedPlayback ? "Source plays into continuation and loops as a chain." : node.label || node.id);
}

function canvasDeleteNode(nodeId) {
  pushUndo();
  const node = canvasNodes.find((item) => item.id === nodeId);
  if (!node) return;
  const fxTargetId = node.type === "fx" ? node.targetNodeId : null;
  if (node.audio) {
    canvasDisconnectAudioGraph(node.audioGraph);
    node.audio.pause();
    node.audio.src = "";
  }
  if (node.reverseObjectUrl) {
    if (!canvasNodes.some((item) => item !== node && item.reverseObjectUrl === node.reverseObjectUrl)) {
      const cachedEntry = [...canvasReverseAudioCache.entries()].find(([, url]) => url === node.reverseObjectUrl);
      if (cachedEntry) {
        canvasReverseAudioCache.delete(cachedEntry[0]);
      }
      URL.revokeObjectURL(node.reverseObjectUrl);
    }
    node.reverseObjectUrl = null;
  }
  if (node.recorder && node.recording) {
    try { node.recorder.stop(); } catch {}
  }
  if (node.wavRecorder) {
    // Deleting a module mid-take discards the capture.
    try { node.wavRecorder.stop(); } catch {}
    node.wavRecorder = null;
  }
  if (node._recSource) { try { node._recSource.disconnect(); } catch {} node._recSource = null; }
  if (node._recAnalyser) { try { node._recAnalyser.disconnect(); } catch {} node._recAnalyser = null; }
  if (node.type === "audio_snapshot") snapshotStopRuntime(node);
  if (node.recordingStream) {
    node.recordingStream.getTracks().forEach((track) => track.stop());
  }
  if (node.stream) {
    node.stream.getTracks().forEach((track) => track.stop());
  }
  canvasEdges = canvasEdges.filter((edge) => edge.fromNodeId !== nodeId && edge.toNodeId !== nodeId);
  canvasCandidates = canvasCandidates.filter((candidate) => candidate.sourceNodeId !== nodeId && candidate.canvasNodeId !== nodeId);
  canvasGroupSelection.delete(nodeId);
  canvasNodes = canvasNodes.filter((item) => item.id !== nodeId);
  if (node.type === "sound" && !canvasNodes.some((item) => item.assetId === node.assetId)) {
    const asset = canvasAssetById(node.assetId);
    if (asset?.objectUrl) URL.revokeObjectURL(asset.objectUrl);
    canvasAssets = canvasAssets.filter((item) => item.id !== node.assetId);
    canvasAudioCache.delete(node.assetId);
  }
  if (fxTargetId) {
    const target = canvasNodes.find((item) => item.id === fxTargetId);
    const remainingFx = canvasNodes.filter((item) => item.type === "fx" && item.targetNodeId === fxTargetId);
    if (node.fxType === "pitch" && target?.type === "sound" && !remainingFx.some((item) => item.fxType === "pitch")) {
      target.playbackRate = Math.min(4, Math.max(0.25, Number(node.params?.basePlaybackRate ?? 1) || 1));
    }
    remainingFx.forEach((fxNode) => applyFxNodeToTarget(fxNode));
    if (target?.audio) {
      canvasEnsureNodeAudioGraph(target);
      canvasApplyNodeAudioParams(target);
    }
  }
  selectedCanvasNodeId = canvasNodes[0]?.id || null;
  renderCanvas();
  setState("Module Deleted", "ok", node.label || node.type);
}

async function canvasStartRecording(nodeId) {
  const node = canvasNodes.find((item) => item.id === nodeId);
  if (!node || node.type !== "record") return;
  if (!navigator.mediaDevices?.getUserMedia) {
    throw new Error("Browser recording is not available in this environment.");
  }
  const stream = await mediaStreamWithPermissionTimeout(
    navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false },
    }),
    "Microphone",
  );
  node.stream = stream;
  node.recordedChunks = [];
  node.recording = true;
  // Lossless path: tap the mic through the shared context and keep raw PCM,
  // committing a WAV. MediaRecorder webm/opus is only the no-worklet fallback
  // — hardware takes shouldn't be born lossy.
  const context = canvasPlaybackContext();
  let wavRecorder = null;
  let micSource = null;
  if (context) {
    if (context.state === "suspended") await context.resume().catch(() => {});
    try {
      micSource = context.createMediaStreamSource(stream);
      wavRecorder = await createWavRecorder(context, micSource);
    } catch {
      micSource = null;
      wavRecorder = null;
    }
  }
  if (wavRecorder) {
    node.wavRecorder = wavRecorder;
    node.recorder = null;
    node._recSource = micSource;
    wavRecorder.start();
  } else {
    if (typeof MediaRecorder === "undefined") {
      stream.getTracks().forEach((track) => track.stop());
      node.stream = null;
      node.recording = false;
      throw new Error("Browser recording is not available in this environment.");
    }
    const recorder = new MediaRecorder(stream);
    node.recorder = recorder;
    recorder.addEventListener("dataavailable", (event) => {
      if (event.data?.size) node.recordedChunks.push(event.data);
    });
    recorder.addEventListener("stop", () => canvasCommitRecording(node.id));
    recorder.start();
  }
  renderCanvas();
  setState("Recording", "busy", node.wavRecorder ? "Capturing hardware input (lossless WAV)." : "Capturing hardware input.");

  // Live waveform visualisation — reuses the shared playback context instead
  // of spinning up a dedicated AudioContext per take.
  try {
    const audioCtx = context || new (window.AudioContext || window.webkitAudioContext)();
    const source = node._recSource || audioCtx.createMediaStreamSource(stream);
    node._recSource = source;
    const analyser = audioCtx.createAnalyser();
    analyser.fftSize = 256;
    source.connect(analyser);
    node._recAnalyser = analyser;
    node._recAudioCtx = audioCtx === canvasPlaybackAudioContext ? null : audioCtx;
    const bufLen = analyser.frequencyBinCount;
    const dataArray = new Uint8Array(bufLen);
    function drawRecWave() {
      if (!node.recording) return;
      const canvas = document.querySelector(`.rec-live-wave[data-node-id="${CSS.escape(node.id)}"]`);
      if (!canvas) { node._recFrame = requestAnimationFrame(drawRecWave); return; }
      const ctx = canvas.getContext("2d");
      const w = canvas.width;
      const h = canvas.height;
      analyser.getByteTimeDomainData(dataArray);
      ctx.clearRect(0, 0, w, h);
      ctx.beginPath();
      ctx.strokeStyle = "rgba(218, 52, 58, 0.8)";
      ctx.lineWidth = 1.5;
      const sliceW = w / bufLen;
      let x = 0;
      for (let i = 0; i < bufLen; i++) {
        const v = dataArray[i] / 128.0;
        const y = (v * h) / 2;
        if (i === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
        x += sliceW;
      }
      ctx.stroke();
      node._recFrame = requestAnimationFrame(drawRecWave);
    }
    node._recFrame = requestAnimationFrame(drawRecWave);
  } catch (_) { /* audio context unavailable — skip visualisation */ }
}

function canvasStopRecording(nodeId) {
  const node = canvasNodes.find((item) => item.id === nodeId);
  if (!node || node.type !== "record" || !node.recording) return;
  if (node.wavRecorder) {
    const recorder = node.wavRecorder;
    node.wavRecorder = null;
    recorder.stop()
      .then((captured) => canvasCommitRecording(node.id, captured))
      .catch((error) => finishWork("Record Error", "bad", error.message));
  } else if (node.recorder) {
    node.recorder.stop();
  }
  if (node._recFrame) { cancelAnimationFrame(node._recFrame); node._recFrame = null; }
  if (node._recSource) { try { node._recSource.disconnect(); } catch {} node._recSource = null; }
  if (node._recAnalyser) { try { node._recAnalyser.disconnect(); } catch {} node._recAnalyser = null; }
  if (node._recAudioCtx) { node._recAudioCtx.close().catch(() => {}); node._recAudioCtx = null; }
}

function snapshotMimeType() {
  if (MediaRecorder.isTypeSupported?.("audio/webm;codecs=opus")) return "audio/webm;codecs=opus";
  if (MediaRecorder.isTypeSupported?.("audio/webm")) return "audio/webm";
  return "";
}

function audioBufferUsefulRegion(buffer, threshold = 0.012, marginSec = 0.05) {
  const channels = Math.max(1, buffer.numberOfChannels || 1);
  const frameCount = buffer.length;
  const channelData = Array.from({ length: channels }, (_, channel) => buffer.getChannelData(channel));
  let start = 0;
  let end = frameCount - 1;
  const isUseful = (frame) => {
    for (let channel = 0; channel < channels; channel += 1) {
      if (Math.abs(channelData[channel][frame] || 0) >= threshold) return true;
    }
    return false;
  };
  while (start < frameCount - 1 && !isUseful(start)) start += 1;
  while (end > start && !isUseful(end)) end -= 1;
  if (end <= start) return { startSec: 0, endSec: buffer.duration, trimmed: false };
  const marginFrames = Math.round(marginSec * buffer.sampleRate);
  start = Math.max(0, start - marginFrames);
  end = Math.min(frameCount - 1, end + marginFrames);
  return {
    startSec: start / buffer.sampleRate,
    endSec: Math.max((end + 1) / buffer.sampleRate, (start + 1) / buffer.sampleRate),
    trimmed: start > 0 || end < frameCount - 1,
  };
}

function audioBufferSlice(buffer, startSec = 0, endSec = buffer.duration) {
  const startFrame = Math.max(0, Math.min(buffer.length - 1, Math.floor(startSec * buffer.sampleRate)));
  const endFrame = Math.max(startFrame + 1, Math.min(buffer.length, Math.ceil(endSec * buffer.sampleRate)));
  const channels = Math.max(1, buffer.numberOfChannels || 1);
  const context = audioContextForDecode();
  const output = context.createBuffer(channels, endFrame - startFrame, buffer.sampleRate);
  for (let channel = 0; channel < channels; channel += 1) {
    output.copyToChannel(buffer.getChannelData(channel).slice(startFrame, endFrame), channel);
  }
  return output;
}

function snapshotStopRuntime(node) {
  if (node.captureTimeout) clearTimeout(node.captureTimeout);
  node.captureTimeout = null;
  if (node._recFrame) cancelAnimationFrame(node._recFrame);
  node._recFrame = null;
  if (node._recAudioCtx) node._recAudioCtx.close().catch(() => {});
  node._recAudioCtx = null;
  node._recAnalyser = null;
}

async function canvasStartAudioSnapshot(nodeId, seconds = null) {
  const node = canvasNodes.find((item) => item.id === nodeId);
  if (!node || node.type !== "audio_snapshot") return;
  if (!navigator.mediaDevices?.getDisplayMedia || typeof MediaRecorder === "undefined") {
    throw new Error("System audio capture requires browser display-audio capture support.");
  }
  const duration = Math.max(1, Number(seconds || node.captureSeconds || 10));
  const stream = await mediaStreamWithPermissionTimeout(
    navigator.mediaDevices.getDisplayMedia({
      video: true,
      audio: {
        echoCancellation: false,
        noiseSuppression: false,
        autoGainControl: false,
      },
    }),
    "System audio capture",
  );
  if (!stream.getAudioTracks().length) {
    stream.getTracks().forEach((track) => track.stop());
    throw new Error("No system/tab audio track was shared.");
  }
  const audioTracks = stream.getAudioTracks();
  const audioOnlyStream = new MediaStream(audioTracks);
  const mimeType = snapshotMimeType();
  const recorder = new MediaRecorder(audioOnlyStream, mimeType ? { mimeType } : undefined);
  node.stream = stream;
  node.recordingStream = audioOnlyStream;
  node.recorder = recorder;
  node.recordedChunks = [];
  node.recording = true;
  node.captureStartedAt = performance.now();
  node.captureStartedAtIso = new Date().toISOString();
  node.captureSeconds = duration;
  node.status = "Capturing";
  node.detail = `${duration}s system audio snapshot`;
  recorder.addEventListener("dataavailable", (event) => {
    if (event.data?.size) node.recordedChunks.push(event.data);
  });
  recorder.addEventListener("stop", () => {
    canvasCommitAudioSnapshot(node.id).catch((error) => finishWork("Snapshot Error", "bad", error.message));
  });
  recorder.start(250);
  node.captureTimeout = setTimeout(() => canvasStopAudioSnapshot(node.id), duration * 1000);
  renderCanvas();
  setState("Snapshot Capture", "busy", "Capturing shared computer audio.");

  try {
    const audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    const source = audioCtx.createMediaStreamSource(audioOnlyStream);
    const analyser = audioCtx.createAnalyser();
    analyser.fftSize = 256;
    source.connect(analyser);
    node._recAnalyser = analyser;
    node._recAudioCtx = audioCtx;
    const dataArray = new Uint8Array(analyser.frequencyBinCount);
    function drawSnapshotWave() {
      if (!node.recording) return;
      const canvas = document.querySelector(`.snapshot-live-wave[data-node-id="${CSS.escape(node.id)}"]`);
      if (!canvas) {
        node._recFrame = requestAnimationFrame(drawSnapshotWave);
        return;
      }
      const ctx = canvas.getContext("2d");
      const w = canvas.width;
      const h = canvas.height;
      analyser.getByteTimeDomainData(dataArray);
      ctx.clearRect(0, 0, w, h);
      ctx.beginPath();
      ctx.strokeStyle = "rgba(71, 111, 93, 0.82)";
      ctx.lineWidth = 1.5;
      dataArray.forEach((value, index) => {
        const x = (index / Math.max(1, dataArray.length - 1)) * w;
        const y = (value / 255) * h;
        if (index === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      });
      ctx.stroke();
      node._recFrame = requestAnimationFrame(drawSnapshotWave);
    }
    node._recFrame = requestAnimationFrame(drawSnapshotWave);
  } catch {}
}

function canvasStopAudioSnapshot(nodeId) {
  const node = canvasNodes.find((item) => item.id === nodeId);
  if (!node || node.type !== "audio_snapshot" || !node.recorder || !node.recording) return;
  snapshotStopRuntime(node);
  node.recorder.stop();
}

async function canvasCommitAudioSnapshot(nodeId) {
  const node = canvasNodes.find((item) => item.id === nodeId);
  if (!node || node.type !== "audio_snapshot") return;
  const blob = new Blob(node.recordedChunks || [], { type: node.recorder?.mimeType || "audio/webm" });
  node.recordingStream?.getTracks().forEach((track) => track.stop());
  node.stream?.getTracks().forEach((track) => track.stop());
  snapshotStopRuntime(node);
  node.recording = false;
  node.recorder = null;
  node.stream = null;
  node.recordingStream = null;
  node.recordedChunks = [];
  if (!blob.size) {
    node.status = "Empty";
    node.detail = "No audio data was captured.";
    renderCanvas();
    setState("Snapshot Empty", "bad", node.detail);
    return;
  }
  const rawBuffer = await decodeAudioArrayBuffer(await blob.arrayBuffer());
  let region = {
    startSec: Math.max(0, Number(node.trimStartSec) || 0),
    endSec: Math.min(rawBuffer.duration, Number(node.trimEndSec) || rawBuffer.duration),
    trimmed: false,
  };
  if (node.autoTrim !== false) region = audioBufferUsefulRegion(rawBuffer);
  if (region.endSec <= region.startSec) region = { startSec: 0, endSec: rawBuffer.duration, trimmed: false };
  const trimmedBuffer = audioBufferSlice(rawBuffer, region.startSec, region.endSec);
  const wavBlob = audioBufferToWavBlob(trimmedBuffer);
  const now = new Date().toISOString();
  const filename = `audio_snapshot_${now.replace(/[:.]/g, "-")}.wav`;
  const duration = Math.max(0.01, trimmedBuffer.duration);
  const metadata = {
    provider: "mock",
    model: "browser-audio-snapshot",
    prompt: "Audio Snapshot germ",
    duration,
    output_name: filename.replace(/\.wav$/i, ""),
    culture_id: activeCulture.id,
    tags: ["audio-snapshot", "system-audio", "germ"],
    notes: "System, tab, or window audio captured into the Chamber.",
    source_type: "audio_snapshot",
    source: {
      type: "audio_snapshot",
      capture_mode: "display_audio",
      requested_seconds: node.captureSeconds,
      raw_duration: rawBuffer.duration,
      trim_start_sec: region.startSec,
      trim_end_sec: region.endSec,
      auto_trim: node.autoTrim !== false,
    },
    organism: {
      type: "audio_snapshot",
      captured_at: node.captureStartedAtIso || now,
      environment: "computer_audio",
    },
    lineage: canvasLineagePayload("audio_snapshot", {
      sourceNode: node,
      extraParams: {
        capture_mode: "display_audio",
        requested_seconds: node.captureSeconds,
        raw_duration: rawBuffer.duration,
        duration,
        trim_start_sec: region.startSec,
        trim_end_sec: region.endSec,
        auto_trim: node.autoTrim !== false,
      },
    }),
  };
  beginWork("Register Snapshot", `${duration.toFixed(2)}s germ`);
  const result = await canvasImportAudioBlob(wavBlob, metadata, filename);
  const metadataPath = result.metadata_files?.[0] || "";
  const importedMetadata = metadataPath ? await loadMetadata(metadataPath) : metadata;
  const audioPath = result.audio_files?.[0] || "";
  const asset = canvasCreateAsset({
    audioPath,
    metadataPath,
    metadata: importedMetadata,
    origin: "audio_snapshot",
  });
  canvasCreateSoundNode({
    asset,
    label: "Audio Snapshot",
    x: node.x + node.width + 80,
    y: node.y,
    parentNodeId: node.id,
    edgeType: "audio_context",
  });
  node.status = "Registered";
  node.detail = `${duration.toFixed(2)}s source ready to grow`;
  await refreshLibrary(false);
  renderCanvas();
  finishWork("Snapshot Registered", "ok", `${duration.toFixed(2)}s audio germ`);
}

function canvasCommitRecording(nodeId, captured = null) {
  const node = canvasNodes.find((item) => item.id === nodeId);
  if (!node || node.type !== "record") return;
  const blob = captured?.blob?.size
    ? captured.blob
    : new Blob(node.recordedChunks || [], { type: node.recorder?.mimeType || "audio/webm" });
  const extension = captured?.blob?.size ? "wav" : "webm";
  node.stream?.getTracks().forEach((track) => track.stop());
  node.recording = false;
  node.recorder = null;
  node.wavRecorder = null;
  node.stream = null;
  node.recordedChunks = [];
  if (!blob.size) {
    renderCanvas();
    setState("Recording Empty", "bad", "No audio data was captured.");
    return;
  }
  const objectUrl = URL.createObjectURL(blob);
  const name = `recording_${new Date().toISOString().replace(/[:.]/g, "-")}.${extension}`;
  const file = new File([blob], name, { type: blob.type || (extension === "wav" ? "audio/wav" : "audio/webm") });
  const asset = canvasCreateAsset({
    objectUrl,
    file,
    metadata: {
      prompt: "Hardware recording",
      output_audio_path: objectUrl,
      created_at: new Date().toISOString(),
      sound_id: `recording:${name}`,
      parents: [],
      children: [],
      operation: "recording",
      operation_params: { filename: name, type: file.type || "audio/webm" },
      lineage: canvasLineagePayload("recording", {
        sourceNode: node,
        extraParams: { filename: name, type: file.type || "audio/webm" },
      }),
    },
    origin: "recording",
    parentAssetIds: [],
  });
  canvasCreateSoundNode({
    asset,
    label: displayNameFromPath(name),
    x: node.x + node.width + 80,
    y: node.y,
    parentNodeId: node.id,
    edgeType: "audio_context",
  });
  setState("Recording Captured", "ok", name);
}

function canvasBuildPayload(overrides = {}) {
  const { sourcePromptNodeId, modulationContext = {}, resolvedSettings = null, ...rest } = overrides;
  const resolved = resolvedSettings || canvasResolveGenerationSettings(sourcePromptNodeId || null, rest, modulationContext);
  const hasModulation = (resolved.modulationRecords || []).length > 0;
  const hasSemanticContext = (resolved.semanticLayers || []).length > 0 || (resolved.semanticFxLayers || []).length > 0;
  const lineage = canvasLineageWithModulation(rest.lineage || {}, resolved);
  const sourceNode = canvasNodes.find((item) => item.id === sourcePromptNodeId) || null;
  const sourceRegionNode = canvasNodes.find((item) => item.id === sourcePromptNodeId && item.type === "sound") || null;
  const geneticPayload = canvasGeneticPayloadForTarget(sourceNode);
  const payload = payloadBase({
    _skipActivePromptContext: true,
    ...rest,
    prompt: resolved.prompt || $("prompt")?.value || "",
    negative_prompt: resolved.negativePrompt || $("negativePrompt")?.value || "",
    duration: resolved.durationSec || Number($("duration")?.value) || 4,
    seed: resolved.seed,
    batch_size: resolved.batchSize,
    cfg_scale: resolved.cfgScale,
    batch_spread: resolved.batchSpread,
    inpaint_density: resolved.inpaintDensity,
    mask_feather: resolved.maskFeather,
    continuation_divergence: resolved.continuationDivergence,
    prompt_weight: resolved.promptWeight,
    negative_prompt_weight: resolved.negativePromptWeight,
    seed_drift: resolved.seedDrift,
    brightness_language: resolved.brightnessLanguage,
    lora_strength: resolved.loraStrength,
    model: resolved.model || rest.model || $("model")?.value || "",
    lora: resolved.lora || rest.lora || loraPayload(),
    output_name: rest.output_name || safeOutputName(`canvas_${overrides.operation || "generation"}`),
    tags: rest.tags || ["canvas", ...(overrides.operation ? [overrides.operation] : []), ...parseTags($("seedTags")?.value || "")],
    ...canvasRegionPayloadFields(sourceRegionNode),
    ...geneticPayload,
    lineage,
    ...(hasModulation || hasSemanticContext ? {
      base_prompt: resolved.basePrompt,
      modulated_prompt: resolved.prompt,
      base_negative_prompt: resolved.baseNegativePrompt,
      modulated_negative_prompt: resolved.negativePrompt,
      modulators: resolved.modulationRecords,
      semantic_layers: resolved.semanticLayers || [],
      semantic_effects: resolved.semanticFxLayers || [],
      generation_context: resolved.generationContext || {},
    } : {}),
  });
  if (Object.prototype.hasOwnProperty.call(rest, "init_noise_level")) payload.init_noise_level = resolved.mutation;
  delete payload.skip_modulation;
  return applyPromptBridgeFields(payload, {
    handoff: resolved.promptNode?.akousmaHandoff || null,
    relisten: resolved.promptNode?.oidaRelisten || null,
  });
}

function canvasEdgeTypeForOperation(operation) {
  if (operation === "generate") return "prompt_condition";
  if (operation === "continue") return "continuation";
  if (operation === "inpaint") return "replacement";
  if (operation === "mutate") return "lineage";
  return "lineage";
}

function canvasNodeVisualSize(node) {
  const fallbackWidth = Number(node?.width) || (node?.type === "sound" ? 352 : node?.type === "prompt" ? 332 : 380);
  const fallbackHeight = node?.type === "sound"
    ? (document.body.classList.contains("canvas-vertical") ? 378 : 214)
    : Number(node?.height) || 306;
  const element = node?.id ? document.querySelector(`.canvas-node[data-node-id="${CSS.escape(node.id)}"]`) : null;
  return {
    width: element?.offsetWidth || fallbackWidth,
    height: element?.offsetHeight || fallbackHeight,
  };
}

function canvasStackedBelowPoint(sourceNode) {
  if (!sourceNode) return canvasBoardDefaultPoint();
  const children = canvasNodes
    .filter((node) => node.snapParentNodeId === sourceNode.id && node.snapAxis === "below")
    .sort((a, b) => a.y - b.y);
  const anchor = children[children.length - 1] || sourceNode;
  const anchorSize = canvasNodeVisualSize(anchor);
  return {
    x: sourceNode.x,
    y: anchor.y + anchorSize.height,
  };
}

function canvasSnappedRightPoint(sourceNode) {
  if (!sourceNode) return canvasBoardDefaultPoint();
  const sourceSize = canvasNodeVisualSize(sourceNode);
  return {
    x: sourceNode.x + sourceSize.width,
    y: sourceNode.y,
  };
}

function canvasCandidateMetadata(candidate) {
  const asset = candidate ? canvasAssetById(candidate.assetId) : null;
  return asset?.metadata || {};
}

function ecologyClamp(value, fallback = 0.5) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return fallback;
  return Math.min(1, Math.max(0, numeric));
}

function ecologyPercent(value) {
  return Math.round(ecologyClamp(value) * 100);
}

function ecologyWords(value = "") {
  return new Set(String(value).toLowerCase().match(/[a-z0-9]+/g) || []);
}

function ecologyJaccard(a = "", b = "") {
  const left = ecologyWords(a);
  const right = ecologyWords(b);
  if (!left.size || !right.size) return 0.5;
  const intersection = [...left].filter((word) => right.has(word)).length;
  const union = new Set([...left, ...right]).size || 1;
  return ecologyClamp(intersection / union);
}

function ecologyPromptScore(prompt = "", positiveWords = [], negativeWords = [], fallbackSeed = "") {
  const words = ecologyWords(prompt);
  let score = 0.5 + (deterministicUnit(fallbackSeed) - 0.5) * 0.22;
  positiveWords.forEach((word) => {
    if (words.has(word)) score += 0.12;
  });
  negativeWords.forEach((word) => {
    if (words.has(word)) score -= 0.12;
  });
  return ecologyClamp(score);
}

function canvasCandidateSourceNode(candidate) {
  return canvasNodes.find((node) => node.id === candidate?.sourceNodeId)
    || canvasNodes.find((node) => node.id === candidate?.canvasNodeId)
    || null;
}

function canvasCandidateParentLabel(candidate) {
  const sourceNode = canvasCandidateSourceNode(candidate);
  if (sourceNode) return sourceNode.label || sourceNode.type || "node";
  const metadata = canvasCandidateMetadata(candidate);
  return metadata.source?.label || metadata.parent_branch?.label || metadata.source_type || "unknown";
}

function canvasCandidatePromptText(candidate) {
  const metadata = canvasCandidateMetadata(candidate);
  const sourceNode = canvasCandidateSourceNode(candidate);
  const sourcePrompt = sourceNode?.type === "prompt" ? canvasPromptPayload(sourceNode.id).prompt : "";
  return metadata.modulated_prompt
    || metadata.prompt
    || metadata.operation_params?.modulated_prompt
    || metadata.operation_params?.prompt
    || sourcePrompt
    || "";
}

function canvasCandidateSourcePromptText(candidate) {
  const sourceNode = canvasCandidateSourceNode(candidate);
  if (sourceNode?.type === "prompt") return canvasPromptPayload(sourceNode.id).prompt;
  if (sourceNode?.type === "sound") return canvasPromptPayload(sourceNode.id).prompt;
  const metadata = canvasCandidateMetadata(candidate);
  return metadata.source?.prompt || metadata.lineage?.operation_params?.prompt || "";
}

function canvasCandidateMutationDistance(candidate) {
  const metadata = canvasCandidateMetadata(candidate);
  const params = metadata.operation_params || metadata.lineage?.operation_params || {};
  const explicit = params.init_noise_level ?? metadata.init_noise_level ?? params.mutation_amount ?? metadata.seed_drift;
  if (Number.isFinite(Number(explicit))) return ecologyClamp(explicit);
  if (candidate?.operation === "mutate") return 0.5;
  if (candidate?.operation === "inpaint") return ecologyClamp(params.inpaint_density ?? metadata.inpaint_density ?? 0.38);
  if (candidate?.operation === "continue") return ecologyClamp((params.continuation_divergence ?? metadata.continuation_divergence ?? 0.55) / 1.5);
  if (candidate?.operation === "breed") return 0.66;
  if (candidate?.operation === "family") return 0.34;
  return ecologyClamp((deterministicUnit(`${candidate?.id}:mutation`) * 0.42) + 0.18);
}

function canvasCandidateEcology(candidate) {
  const metadata = canvasCandidateMetadata(candidate);
  const params = metadata.operation_params || metadata.lineage?.operation_params || {};
  const prompt = canvasCandidatePromptText(candidate);
  const sourcePrompt = canvasCandidateSourcePromptText(candidate);
  const mutationDistance = canvasCandidateMutationDistance(candidate);
  const promptSimilarity = ecologyJaccard(prompt, sourcePrompt);
  const audioSimilarity = ecologyClamp(1 - mutationDistance * 0.78 + (candidate?.operation === "continue" ? 0.12 : 0));
  const seed = `${candidate?.id}:${candidate?.audioPath}:${candidate?.seed}:${prompt}`;
  const spectralBrightness = ecologyClamp(
    Number(params.brightness_language ?? metadata.brightness_language),
    ecologyPromptScore(prompt, ["bright", "air", "glass", "metallic", "sharp", "click", "spark"], ["dark", "muddy", "low", "warm", "muffled"], `${seed}:bright`),
  );
  const density = ecologyClamp(
    Number(params.inpaint_density ?? metadata.inpaint_density),
    ecologyPromptScore(prompt, ["dense", "busy", "swarm", "granular", "rhythm", "loop", "many"], ["sparse", "single", "minimal", "quiet", "rest"], `${seed}:density`),
  );
  const duration = Number(metadata.duration ?? candidate?.durationSec ?? canvasAssetById(candidate?.assetId)?.durationSec ?? 0);
  const loopWords = ecologyWords(prompt);
  const loopHint = ["loop", "groove", "pulse", "rhythm", "pattern", "cycle"].some((word) => loopWords.has(word));
  const loopability = ecologyClamp((loopHint ? 0.32 : 0) + (duration && duration <= 12 ? 0.18 : 0) + (1 - Math.abs((duration || 4) - Math.round(duration || 4)) * 0.25) * 0.26 + deterministicUnit(`${seed}:loop`) * 0.24);
  const transientStrength = ecologyPromptScore(prompt, ["hit", "impact", "click", "tap", "transient", "snap", "kick", "strike", "sfx"], ["pad", "drone", "ambient", "sustain", "wash"], `${seed}:transient`);
  const novelty = ecologyClamp((mutationDistance * 0.42) + ((1 - promptSimilarity) * 0.28) + ((1 - audioSimilarity) * 0.2) + deterministicUnit(`${seed}:novel`) * 0.1);
  const cleanest = ecologyClamp((1 - density) * 0.24 + audioSimilarity * 0.24 + promptSimilarity * 0.18 + (1 - transientStrength * 0.35) * 0.18 + (1 - mutationDistance) * 0.16);
  return {
    parent: canvasCandidateParentLabel(candidate),
    mutationDistance,
    promptSimilarity,
    audioSimilarity,
    spectralBrightness,
    density,
    loopability,
    transientStrength,
    novelty,
    cleanest,
    rating: candidate?.rating || "maybe",
    tags: [
      spectralBrightness > 0.66 ? "bright" : spectralBrightness < 0.34 ? "dark" : "balanced",
      density > 0.66 ? "dense" : density < 0.34 ? "sparse" : "medium",
      loopability > 0.68 ? "loopable" : transientStrength > 0.68 ? "transient" : "texture",
      novelty > 0.7 ? "weird" : cleanest > 0.7 ? "clean" : "candidate",
    ],
  };
}

function normalizeCanvasCandidate(candidate) {
  if (!candidate || typeof candidate !== "object") return null;
  const normalized = {
    selected: false,
    rating: "maybe",
    ...candidate,
  };
  if (!["favorite", "maybe", "reject"].includes(normalized.rating)) normalized.rating = "maybe";
  normalized.ecology = {
    ...(candidate.ecology || {}),
    ...canvasCandidateEcology(normalized),
  };
  return normalized;
}

function canvasSelectedCandidates({ includeFavorites = false } = {}) {
  const selected = canvasCandidates.filter((candidate) => candidate.selected && candidate.rating !== "reject");
  if (selected.length || !includeFavorites) return selected;
  return canvasCandidates.filter((candidate) => candidate.rating === "favorite");
}

function canvasBestCandidateFor(metric, candidates = canvasCandidates) {
  return [...candidates]
    .filter((candidate) => candidate.rating !== "reject")
    .sort((a, b) => ecologyClamp(b.ecology?.[metric]) - ecologyClamp(a.ecology?.[metric]))[0] || null;
}

function canvasPlaceGeneratedNode(candidate, context, index) {
  const sourceNode = canvasNodes.find((node) => node.id === context.sourceNodeId);
  const asset = canvasAssetById(candidate.assetId);
  if (!asset) return null;
  const isContinuation = context.operation === "continue" && sourceNode?.type === "sound";
  const isVariation = context.operation === "mutate" && sourceNode?.type === "sound";
  const snapAxis = isContinuation ? "right" : isVariation ? "below" : null;
  const promptStep = (sourceNode?.type === "prompt" || sourceNode?.type === "image")
    ? (sourceNode.width || 290) + 90
    : 68;
  const basePoint = sourceNode
    ? isContinuation
      ? canvasSnappedRightPoint(sourceNode)
      : isVariation
        ? canvasStackedBelowPoint(sourceNode)
        : { x: sourceNode.x + promptStep, y: sourceNode.y + index * 258 }
    : canvasBoardDefaultPoint();
  const node = canvasCreateSoundNode({
    asset,
    label: isContinuation ? `${sourceNode.label || "source"} continuation` : candidate.label,
    x: basePoint.x,
    y: basePoint.y,
    parentNodeId: sourceNode?.id || null,
    edgeType: canvasEdgeTypeForOperation(context.operation),
    region: candidate.region ? { ...candidate.region, purpose: "annotation" } : null,
  });
  if (node && snapAxis) {
    node.snapParentNodeId = sourceNode.id;
    node.snapAxis = snapAxis;
    node.snapOperation = context.operation;
  }
  if (node && isContinuation) {
    node.attachedToNodeId = sourceNode.id;
    node.playbackStartSec = Number(context.sourceDuration) || 0;
    node.playbackEndSec = Number(context.targetDuration) || Number(asset.durationSec) || node.playbackStartSec + canvasNodeDuration(node);
    node.linkedPlayback = false;
    node.originLabel = "continuation tail";
  }
  if (node) candidate.canvasNodeId = node.id;
  return node;
}

async function canvasCreateCandidatesFromResult(result, context) {
  const audioFiles = result.audio_files || [];
  const metadataFiles = result.metadata_files || [];
  const created = [];
  for (let index = 0; index < audioFiles.length; index += 1) {
    const audioPath = audioFiles[index];
    const metadataPath = metadataFiles[index] || "";
    const metadata = metadataPath ? await loadMetadata(metadataPath) : {};
    const asset = canvasCreateAsset({
      audioPath,
      metadataPath,
      metadata,
      origin: context.operation === "mutate" ? "audio_to_audio" : context.operation === "generate" ? "prompt" : context.operation,
      parentAssetIds: context.sourceAssetId ? [context.sourceAssetId] : [],
    });
    created.push(normalizeCanvasCandidate({
      id: canvasId("candidate"),
      jobId: result.job_id,
      assetId: asset.id,
      audioPath,
      metadataPath,
      operation: context.operation,
      sourceNodeId: context.sourceNodeId || null,
      seed: metadata.seed ?? result.seed,
      model: metadata.model || result.model,
      region: context.region || null,
      label: displayNameFromPath(audioPath),
      createdAt: new Date().toISOString(),
      durationSec: metadata.duration || asset.durationSec || null,
      batchIndex: index,
      colonyId: context.colonyId || null,
    }));
  }
  created.forEach((candidate, index) => canvasPlaceGeneratedNode(candidate, context, index));
  canvasCandidates = [...created, ...canvasCandidates.map(normalizeCanvasCandidate).filter(Boolean)].slice(0, 24);
  await refreshLibrary(false);
  renderCanvas();
  return created;
}

function timeActiveColonyLanes(node) {
  const lanes = node?.lanes || [];
  const soloed = lanes.some((lane) => lane.solo);
  return lanes.filter((lane) => lane.assetId && (soloed ? lane.solo : !lane.mute));
}

function timeAssetForSlot(slot) {
  return slot?.assetId ? canvasAssetById(slot.assetId) : null;
}

function timeEnsureWavAsset(asset) {
  if (!asset?.audioPath) throw new Error("Time render v1 needs saved WAV sources.");
  if (!/\.wav$/i.test(asset.audioPath)) throw new Error("Time render v1 only supports WAV sources.");
  return asset;
}

function canvasAssetForRenderSource(node, source) {
  const slot = timeNodeSourceSlots(node).find((item) => item.id === source.id || `${node.id}__${item.id}` === source.id);
  if (slot?.assetId) return canvasAssetById(slot.assetId);
  return canvasAssets.find((asset) =>
    (source.audio_path && asset.audioPath === source.audio_path)
    || (source.metadata_path && asset.metadataPath === source.metadata_path),
  ) || null;
}

function timeSourceToRenderSource(slot) {
  const asset = timeEnsureWavAsset(timeAssetForSlot(slot));
  return {
    id: slot.id,
    audio_path: asset.audioPath,
    metadata_path: asset.metadataPath || asset.metadata?.metadata_path || null,
    label: timeAssetLabel(asset),
    gain: Math.min(2, Math.max(0, Number(slot.volume ?? 1))),
    pan: Math.min(1, Math.max(-1, Number(slot.pan ?? 0))),
  };
}

function timeNodeSourceSlots(node) {
  if (!node || node.type !== "time") return [];
  if (node.timeType === "trigger_pads") return (node.pads || []).filter((pad) => pad.assetId);
  if (node.timeType === "slicer") {
    const sourceSlots = node.source?.assetId ? [node.source] : [];
    const overrideSlots = (node.slices || [])
      .filter((slice) => slice.assetId)
      .map((slice) => ({
        id: slice.id,
        label: `Slice ${Number(String(slice.id).split("_").pop()) || ""}`.trim(),
        assetId: slice.assetId,
        volume: node.source?.volume ?? 1,
        pan: node.source?.pan ?? 0,
      }));
    return [...sourceSlots, ...overrideSlots];
  }
  if (node.timeType === "melody_maker") return node.root?.assetId ? [node.root] : [];
  if (node.timeType === "euclidean_colony") return node.source?.assetId ? [node.source] : [];
  if (node.timeType === "clocked_looper") return node.source?.assetId ? [node.source] : [];
  if (node.timeType === "probability_gate") return node.source?.assetId ? [node.source] : [];
  if (node.timeType === "clock_divider") return node.source?.assetId ? [node.source] : [];
  if (node.timeType === "humanizer") return node.source?.assetId ? [node.source] : [];
  if (node.timeType === "polymeter") return (node.lanes || []).filter((lane) => lane.assetId);
  if (node.timeType === "incubation_timeline") return (node.timelineSources || []).filter((source) => source.assetId);
  if (node.timeType === "render_bus") {
    return renderBusTargetNodes(node).flatMap((target) =>
      timeNodeSources(target).map((source) => ({
        id: `${target.id}__${source.id}`,
        label: `${target.label || timeModuleLabel(target.timeType)} / ${source.label || source.id}`,
        assetId: canvasAssetForRenderSource(target, source)?.id || "",
        volume: source.gain,
        pan: source.pan,
      })),
    ).filter((slot) => slot.assetId);
  }
  return timeActiveColonyLanes(node);
}

function timeNodeSources(node) {
  if (!node || node.type !== "time") return [];
  return timeNodeSourceSlots(node).map(timeSourceToRenderSource);
}

function timeQuantizeTick(tick) {
  const division = TIME_SNAP_TICKS[timeState.snapDivision] || TIME_SNAP_TICKS["1/16"];
  return Math.max(0, Math.round((Number(tick) || 0) / division) * division);
}

function timeDivisionTicks(division = "1/16") {
  return TIME_SNAP_TICKS[division] || TIME_SNAP_TICKS["1/16"];
}

function timeBaseNodeEvents(node) {
  if (!node || node.type !== "time") return [];
  const derived = timeClockDerived();
  if (node.timeType === "trigger_pads") {
    return (node.recordedEvents || [])
      .map((event) => {
        const pad = node.pads?.[Number(event.padIndex)];
        if (!pad?.assetId) return null;
        return {
          tick: timeQuantizeTick(event.tick),
          source_id: pad.id,
          pad: Number(event.padIndex),
          velocity: Math.min(2, Math.max(0, Number(event.velocity ?? 1))),
          gain: 1,
          pan: 0,
          metadata: {
            key: pad.key,
            recorded_at_ms: event.recordedAtMs,
          },
        };
      })
      .filter(Boolean);
  }
  if (node.timeType === "slicer") {
    const asset = timeAssetForSlot(node.source);
    const sourceDuration = Number(asset?.durationSec || asset?.metadata?.duration || 0);
    if (!node.source?.assetId || sourceDuration <= 0) return [];
    const sliceCount = Math.max(1, Number(node.sliceCount) || 16);
    const sliceSeconds = sourceDuration / sliceCount;
    const stepTicks = derived.totalTicks / sliceCount;
    const ordered = (node.slices || []).map((slice, index) => ({ slice, index }));
    if (node.playMode === "reverse") ordered.reverse();
    return ordered
      .filter(({ slice, index }) => slice.enabled && !(node.playMode === "skip" && index % 2 === 1))
      .map(({ slice, index }, orderIndex) => ({
        tick: Math.round(orderIndex * stepTicks),
        source_id: slice.assetId ? slice.id : node.source.id,
        velocity: Math.min(2, Math.max(0, Number(slice.velocity ?? 1))),
        gain: 1,
        pan: 0,
        reverse: Boolean(slice.reverse),
        source_start_sec: slice.assetId ? null : Number((index * sliceSeconds).toFixed(4)),
        source_end_sec: slice.assetId ? null : Number(((index + 1) * sliceSeconds).toFixed(4)),
        duration_ticks: Math.max(1, Math.round(stepTicks)),
        metadata: {
          slice_index: index,
          slice_count: sliceCount,
          replacement_slice: Boolean(slice.assetId),
        },
      }));
  }
  if (node.timeType === "melody_maker") {
    if (!node.root?.assetId) return [];
    const rootMidi = midiFromNoteName(node.rootNote || "C3");
    const scale = TIME_SCALE_INTERVALS[node.scale] || TIME_SCALE_INTERVALS.minor;
    const stepTicks = derived.totalTicks / 16;
    return (node.steps || [])
      .map((step, stepIndex) => {
        if (!step.enabled) return null;
        const degree = Math.max(0, Math.round(Number(step.degree) || 0));
        const octave = Math.round(Number(step.octave) || 0);
        const pitch = scale[degree % scale.length] + 12 * (Math.floor(degree / scale.length) + octave);
        return {
          tick: Math.round(stepIndex * stepTicks),
          source_id: node.root.id,
          velocity: Math.min(2, Math.max(0, Number(step.velocity ?? 1))),
          gain: 1,
          pan: 0,
          pitch_semitones: pitch,
          duration_ticks: Math.max(1, Math.round(stepTicks * Math.max(1, Number(step.durationSteps) || 1))),
          metadata: {
            note: noteNameFromMidi(rootMidi + pitch),
            degree,
            octave,
            step: stepIndex,
          },
        };
      })
      .filter(Boolean);
  }
  if (node.timeType === "euclidean_colony") {
    if (!node.source?.assetId) return [];
    const steps = Math.max(1, Number(node.steps) || 16);
    const stepTicks = derived.totalTicks / steps;
    return euclideanPattern(steps, node.pulses, node.rotation)
      .map((active, index) => {
        if (!active) return null;
        if (deterministicUnit(`${node.id}:${index}:${node.pulses}:${node.rotation}`) > Number(node.probability ?? 1)) return null;
        return {
          tick: Math.round(index * stepTicks),
          source_id: node.source.id,
          velocity: Math.min(2, Math.max(0, Number(node.velocity ?? 1))),
          gain: 1,
          pan: 0,
          metadata: {
            step: index,
            pulses: node.pulses,
            rotation: node.rotation,
            probability: node.probability,
          },
        };
      })
      .filter(Boolean);
  }
  if (node.timeType === "clocked_looper") {
    if (!node.source?.assetId) return [];
    const segmentTicks = Math.max(1, Math.min(derived.totalTicks, Math.round((Number(node.targetBars) || 1) * derived.ticksPerBar)));
    const starts = node.mode === "crop"
      ? [0]
      : Array.from({ length: Math.ceil(derived.totalTicks / segmentTicks) }, (_, index) => index * segmentTicks).filter((tick) => tick < derived.totalTicks);
    return starts.map((tick, index) => ({
      tick,
      source_id: node.source.id,
      velocity: 1,
      gain: 1,
      pan: 0,
      duration_ticks: segmentTicks,
      metadata: {
        repeat_index: index,
        target_bars: node.targetBars,
        mode: node.mode,
      },
    }));
  }
  if (node.timeType === "probability_gate") {
    if (!node.source?.assetId) return [];
    const steps = Math.max(1, Number(node.steps) || 16);
    const stepTicks = derived.totalTicks / steps;
    return probabilityGatePattern(node)
      .map((active, index) => {
        if (!active) return null;
        return {
          tick: Math.round(index * stepTicks),
          source_id: node.source.id,
          velocity: Math.min(2, Math.max(0, Number(node.velocity ?? 1))),
          gain: 1,
          pan: 0,
          metadata: {
            step: index,
            probability: node.probability,
            seed: node.seed,
          },
        };
      })
      .filter(Boolean);
  }
  if (node.timeType === "clock_divider") {
    if (!node.source?.assetId) return [];
    const divisionTicks = timeDivisionTicks(node.division);
    const count = Math.max(1, Math.floor(derived.totalTicks / divisionTicks));
    return Array.from({ length: count }, (_, index) => {
      if (node.skipEvery > 0 && (index + 1) % node.skipEvery === 0) return null;
      return {
        tick: index * divisionTicks,
        source_id: node.source.id,
        velocity: Math.min(2, Math.max(0, Number(node.velocity ?? 1))),
        gain: 1,
        pan: 0,
        metadata: {
          division: node.division,
          division_index: index,
          skip_every: node.skipEvery,
        },
      };
    }).filter(Boolean);
  }
  if (node.timeType === "humanizer") {
    if (!node.source?.assetId) return [];
    const steps = Math.max(1, Number(node.steps) || 16);
    const stepTicks = derived.totalTicks / steps;
    const maxShift = Math.round(stepTicks * Math.min(0.5, Math.max(0, Number(node.timing) || 0)));
    return Array.from({ length: steps }, (_, index) => {
      if (deterministicUnit(`${node.id}:${node.seed}:density:${index}`) > Number(node.density ?? 1)) return null;
      const shift = Math.round((deterministicUnit(`${node.id}:${node.seed}:timing:${index}`) * 2 - 1) * maxShift);
      const velocityDelta = (deterministicUnit(`${node.id}:${node.seed}:velocity:${index}`) * 2 - 1) * Number(node.velocitySpread ?? 0);
      return {
        tick: Math.max(0, Math.min(derived.totalTicks - 1, Math.round(index * stepTicks + shift))),
        source_id: node.source.id,
        velocity: Math.min(2, Math.max(0, 1 + velocityDelta)),
        gain: 1,
        pan: 0,
        metadata: {
          step: index,
          timing_shift_ticks: shift,
          velocity_spread: node.velocitySpread,
          density: node.density,
          seed: node.seed,
        },
      };
    }).filter(Boolean);
  }
  if (node.timeType === "polymeter") {
    return (node.lanes || []).flatMap((lane, laneIndex) => {
      if (!lane.assetId) return [];
      const steps = Math.max(1, Number(lane.steps) || 1);
      const stepTicks = derived.totalTicks / steps;
      return euclideanPattern(steps, lane.pulses, lane.rotation).map((active, index) => {
        if (!active) return null;
        return {
          tick: Math.round(index * stepTicks),
          source_id: lane.id,
          lane: laneIndex,
          velocity: Math.min(2, Math.max(0, Number(lane.velocity ?? 1))),
          gain: 1,
          pan: 0,
          metadata: {
            lane_label: lane.label,
            step: index,
            steps: lane.steps,
            pulses: lane.pulses,
            rotation: lane.rotation,
          },
        };
      }).filter(Boolean);
    });
  }
  if (node.timeType === "incubation_timeline") {
    const sources = new Set((node.timelineSources || []).filter((source) => source.assetId).map((source) => source.id));
    return (node.timelineEvents || [])
      .filter((event) => sources.has(event.sourceId))
      .map((event, index) => ({
        tick: timeQuantizeTick(Number(event.startBeat || 0) * timeState.ppq),
        source_id: event.sourceId,
        lane: index,
        velocity: 1,
        gain: Math.min(2, Math.max(0, Number(event.gain ?? 1))),
        pan: Math.min(1, Math.max(-1, Number(event.pan ?? 0))),
        pitch_semitones: Math.min(48, Math.max(-48, Number(event.pitchSemitones ?? 0))),
        source_start_sec: event.sourceStartSec,
        source_end_sec: event.sourceEndSec,
        duration_ticks: Math.max(1, Math.round(Number(event.durationBeats || 1) * timeState.ppq)),
        reverse: Boolean(event.reverse),
        fade_in_ms: 3,
        fade_out_ms: 8,
        metadata: {
          timeline_event_id: event.id,
          label: event.label,
          start_beat: event.startBeat,
          duration_beats: event.durationBeats,
        },
      }));
  }
  if (node.timeType === "render_bus") {
    return renderBusTargetNodes(node).flatMap((target) =>
      timeNodeEvents(target).map((event) => ({
        ...event,
        source_id: `${target.id}__${event.source_id}`,
        metadata: {
          ...(event.metadata || {}),
          bus_source_module_id: target.id,
          bus_source_module_type: target.timeType,
        },
      })),
    );
  }
  const stepCount = 16;
  const stepTicks = derived.totalTicks / stepCount;
  return timeActiveColonyLanes(node).flatMap((lane, laneIndex) =>
    (lane.steps || []).map((step, stepIndex) => {
      if (!step.enabled) return null;
      return {
        tick: Math.round(stepIndex * stepTicks),
        source_id: lane.id,
        lane: laneIndex,
        velocity: Math.min(2, Math.max(0, Number(step.velocity ?? 1))),
        gain: 1,
        pan: 0,
        metadata: {
          lane_label: lane.label || `Lane ${laneIndex + 1}`,
          step: stepIndex,
        },
      };
    }).filter(Boolean),
  );
}

function timeEventModulationRoutes(node) {
  if (!node?.id) return [];
  return canvasModulatorNodes()
    .map(normalizeModulatorNode)
    .flatMap((modulator) => (modulator.routes || []).map((route) => ({ modulator, route })))
    .filter(({ modulator, route }) => {
      if (!route?.enabled || route.targetNodeId !== node.id) return false;
      const target = modulationTargetForRoute(route);
      return target?.targetScope === "time_events" && CLOCKED_VALUE_MODULATOR_TYPES.has(modulator.modulatorType);
    });
}

function timeApplyEventModulators(node, events = []) {
  const routes = timeEventModulationRoutes(node);
  if (!routes.length) return events;
  const derived = timeClockDerived();
  return events.map((event, eventIndex) => {
    let next = { ...event, metadata: { ...(event.metadata || {}) } };
    const records = [];
    routes.forEach(({ modulator, route }) => {
      if (!next) return;
      const target = modulationTargetForRoute(route);
      if (!target) return;
      const baseValue = target.param === "eventVelocity"
        ? Number(next.velocity ?? 1)
        : target.param === "eventGain"
          ? Number(next.gain ?? 1)
          : target.param === "eventPan"
            ? Number(next.pan ?? 0)
            : target.param === "eventProbability"
              ? 1
              : 0;
      const finalValue = modulationNumericValue(modulator, route, target, baseValue, {
        rate: "clocked",
        tick: Number(next.tick) || 0,
        eventIndex,
        totalTicks: derived.totalTicks,
      });
      if (target.param === "eventProbability") {
        const gateSeed = `${modulator.id}:${route.id}:${modulator.config?.seed ?? 1}:${eventIndex}:${next.tick}`;
        if (deterministicUnit(gateSeed) > finalValue) next = null;
      } else if (target.param === "eventVelocity") {
        next.velocity = finalValue;
      } else if (target.param === "eventGain") {
        next.gain = finalValue;
      } else if (target.param === "eventPan") {
        next.pan = finalValue;
      } else if (target.param === "eventMicrotiming") {
        next.tick = Math.max(0, Math.min(derived.totalTicks - 1, Math.round((Number(next.tick) || 0) + finalValue)));
      }
      records.push({
        id: route.id,
        modulator_id: modulator.id,
        type: modulator.modulatorType,
        mode: modulator.config?.shape || modulator.config?.refresh || modulator.modulatorType,
        target_node_id: node.id,
        target_path: target.path,
        target_label: target.label,
        base_value: baseValue,
        final_value: finalValue,
        tick: event.tick,
      });
    });
    if (!next) return null;
    next.metadata.modulators = [...(next.metadata.modulators || []), ...records];
    return next;
  }).filter(Boolean).sort((a, b) => (a.tick || 0) - (b.tick || 0));
}

function timeNodeEvents(node) {
  return timeApplyEventModulators(node, timeBaseNodeEvents(node));
}

function timeNodeRenderStatus(node) {
  if (!node || node.type !== "time") return { canRender: false, reason: "Select a time module to render." };
  try {
    const sources = timeNodeSources(node);
    const events = timeNodeEvents(node);
    if (!sources.length) return { canRender: false, reason: "Assign or generate at least one WAV source." };
    if (!events.length) return { canRender: false, reason: "Add steps or record pad events first." };
    return { canRender: true, reason: `${events.length} event(s), ${sources.length} source(s)` };
  } catch (error) {
    return { canRender: false, reason: error.message };
  }
}

function timeNodeLineage(node, sources, events) {
  const sourceAssets = sources
    .map((source) => {
      const slot = timeNodeSourceSlots(node).find((item) => item.id === source.id);
      return canvasAssetById(slot?.assetId);
    })
    .filter(Boolean);
  const parents = sourceAssets.map(lineageSoundIdFromAsset).filter(Boolean);
  const parentMetadataPaths = sourceAssets.map((asset) => asset.metadataPath).filter(Boolean);
  const modulators = events.flatMap((event) => event.metadata?.modulators || []);
  const controls = controlMetadataPayload();
  return {
    parents,
    parent_metadata_paths: parentMetadataPaths,
    control_routes: controls.control_routes,
    control_snapshots: controls.control_snapshots,
    control_sources: controls.control_sources,
    operation: "time_render",
    source_type: "time_render",
    source_node_id: node.id,
    operation_params: {
      module_type: node.timeType,
      module_id: node.id,
      event_count: events.length,
      source_count: sources.length,
      clock: timeStateApiClock(),
      modulators,
      control_routes: controls.control_routes,
      control_snapshots: controls.control_snapshots,
      control_sources: controls.control_sources,
    },
  };
}

function timeRenderPayload(node) {
  const sources = timeNodeSources(node);
  const events = timeNodeEvents(node);
  const modulators = events.flatMap((event) => event.metadata?.modulators || []);
  const controls = controlMetadataPayload();
  return {
    module_type: node.timeType,
    module_id: node.id,
    clock: timeStateApiClock(),
    sources,
    events,
    output_name: safeOutputName(`time_${node.timeType}_${node.label || "harvest"}`),
    culture_id: activeCulture.id,
    tags: ["time", "clocked", node.timeType, ...parseTags($("seedTags")?.value || "")],
    notes: `Rendered from ${timeModuleLabel(node.timeType)} in Chamber Time Mode.`,
    modulators,
    control_routes: controls.control_routes,
    control_snapshots: controls.control_snapshots,
    control_sources: controls.control_sources,
    lineage: timeNodeLineage(node, sources, events),
  };
}

async function renderTimeNode(nodeId = selectedCanvasNodeId) {
  const node = canvasNodes.find((item) => item.id === nodeId);
  if (!node || node.type !== "time") throw new Error("Select a time module first.");
  enableTimeMode("Rendering uses the Chamber clock.");
  const status = timeNodeRenderStatus(node);
  if (!status.canRender) throw new Error(status.reason);
  beginWork("Time Render", status.reason);
  const result = await api("/time/render", {
    method: "POST",
    body: JSON.stringify(timeRenderPayload(node)),
  });
  await canvasCreateCandidatesFromResult(result, {
    operation: "time_render",
    sourceNodeId: node.id,
  });
  finishWork(result.status === "done" ? "Harvest Ready" : "Harvest Error", result.status === "done" ? "ok" : "bad", result.error || `${result.audio_files?.length || 0} rendered source(s)`);
}

function timeOneShotContract(kind, userPrompt) {
  const prompt = String(userPrompt || "").trim() || (kind === "pad" ? "dry trigger hit" : "short percussive organism");
  if (kind === "melody_root") {
    return {
      prompt: `TrackType: Instrument, one-shot pitched note, ${prompt}, clear tonal center, short attack, medium decay, single note only, no melody phrase, no chord progression, no voice, no drums.`,
      negative: "vocals, speech, drums, full melody, chord progression, noisy ambience, long phrase, full song",
    };
  }
  if (kind === "euclidean_source") {
    return {
      prompt: `TrackType: SFX, short one-shot pulse sample, clean transient, controlled decay, ${prompt}, triggerable, no music, no speech, no ambience bed.`,
      negative: "speech, vocals, singing, melody phrase, sustained ambience, long reverb, full song, loop",
    };
  }
  if (["probability_source", "divider_source", "humanizer_source", "polymeter_lane_0", "polymeter_lane_1"].includes(kind)) {
    return {
      prompt: `TrackType: SFX, short one-shot utility pulse, clean transient, controlled decay, ${prompt}, triggerable, no music, no speech, no ambience bed.`,
      negative: "speech, vocals, singing, melody phrase, sustained ambience, long reverb, full song, loop",
    };
  }
  if (kind === "pad") {
    return {
      prompt: `TrackType: SFX, short triggerable one-shot sample, clean attack, controlled decay, ${prompt}, no full phrase, no ambience bed, no music, no speech.`,
      negative: "speech, vocals, singing, melody phrase, long ambience, ambience bed, long reverb, full song, loop",
    };
  }
  return {
    prompt: `TrackType: SFX, short one-shot sound, clean transient, fast decay, ${prompt}, close microphone, no loop, no music, no speech, no long reverb.`,
    negative: "speech, vocals, singing, melody, long phrase, sustained ambience, long reverb, full song, loop",
  };
}

function timeSlotFor(node, kind, index) {
  if (!node || node.type !== "time") return null;
  if (kind === "pad") return node.pads?.[index] || null;
  if (kind === "slicer_source") return node.source || null;
  if (kind === "melody_root") return node.root || null;
  if (kind === "euclidean_source") return node.source || null;
  if (kind === "looper_source") return node.source || null;
  if (kind === "probability_source") return node.source || null;
  if (kind === "divider_source") return node.source || null;
  if (kind === "humanizer_source") return node.source || null;
  if (kind?.startsWith?.("polymeter_lane_")) return node.lanes?.[Number(index)] || node.lanes?.[Number(kind.split("_").pop())] || null;
  return node.lanes?.[index] || null;
}

function timeAssignAssetToSlot(node, kind, index, asset) {
  const slot = timeSlotFor(node, kind, index);
  if (!slot || !asset) return;
  slot.assetId = asset.id;
  slot.label = slot.label || timeAssetLabel(asset);
}

async function generateTimeShot(nodeId, kind, index) {
  const node = canvasNodes.find((item) => item.id === nodeId);
  const slot = timeSlotFor(node, kind, Number(index));
  if (!node || !slot) throw new Error("Time slot not found.");
  enableTimeMode("Generating a time one-shot uses the Chamber clock.");
  const targetIndex = Number(index);
  const promptPath = timePromptPathForKind(kind, targetIndex);
  const durationPath = timeDurationPathForKind(kind, targetIndex);
  const resolvedSlot = canvasApplyGenerationModulators({
    prompt: slot.prompt || "",
    negativePrompt: "",
    durationSec: Number(slot.shotDurationSec) || TIME_ONE_SHOT_DURATION,
    seed: -1,
    batchSize: 1,
    mutation: 0.5,
  }, {
    operation: "time_one_shot",
    targetNodeId: node.id,
    targetPaths: [promptPath, durationPath],
  });
  const contract = timeOneShotContract(kind, resolvedSlot.prompt || slot.prompt);
  const negativePrompt = [contract.negative, resolvedSlot.negativePrompt].filter(Boolean).join(", ");
  beginWork("One-shot Generate", slot.prompt || timeModuleLabel(node.timeType));
  const result = await api("/generate", {
    method: "POST",
    body: JSON.stringify(
      canvasBuildPayload({
        operation: "time_one_shot",
        prompt: contract.prompt,
        negative_prompt: negativePrompt,
        duration: resolvedSlot.durationSec || TIME_ONE_SHOT_DURATION,
        batch_size: 1,
        seed: resolvedSlot.seed,
        skip_modulation: true,
        base_prompt: resolvedSlot.basePrompt,
        modulated_prompt: contract.prompt,
        base_negative_prompt: resolvedSlot.baseNegativePrompt,
        modulated_negative_prompt: negativePrompt,
        modulators: resolvedSlot.modulationRecords,
        output_name: safeOutputName(`time_${kind}_${slot.prompt || slot.label || "shot"}`),
        tags: ["time", "one-shot", kind, node.timeType],
        lineage: canvasLineagePayload("generate", {
          sourceNode: node,
          extraParams: {
            module_type: node.timeType,
            module_id: node.id,
            slot_kind: kind,
            slot_index: Number(index),
            prompt_contract: contract.prompt,
            base_duration: Number(slot.shotDurationSec) || TIME_ONE_SHOT_DURATION,
          },
        }),
      }),
    ),
  });
  const audioPath = result.audio_files?.[0];
  const metadataPath = result.metadata_files?.[0] || "";
  if (!audioPath) throw new Error(result.error || "Generation did not return audio.");
  const metadata = metadataPath ? await loadMetadata(metadataPath) : {};
  const asset = canvasCreateAsset({
    audioPath,
    metadataPath,
    metadata,
    origin: "time_one_shot",
  });
  timeAssignAssetToSlot(node, kind, Number(index), asset);
  await refreshLibrary(false);
  renderCanvas();
  finishWork("One-shot Ready", "ok", timeAssetLabel(asset));
}

function assignSelectedSoundToTimeSlot(nodeId, kind, index) {
  const node = canvasNodes.find((item) => item.id === nodeId);
  const selectedSound = canvasSelectedSoundNode() || canvasNodes.find((item) => item.id === canvasLastSelectedSoundNodeId && item.type === "sound");
  const asset = selectedSound ? canvasAssetById(selectedSound.assetId) : null;
  if (!node || !asset) {
    setState("Select Source", "muted", "Select a sound module before assigning it to a time slot.");
    return;
  }
  timeEnsureWavAsset(asset);
  timeAssignAssetToSlot(node, kind, Number(index), asset);
  selectedCanvasNodeId = node.id;
  renderCanvas();
  setState("Source Assigned", "ok", timeAssetLabel(asset));
}

function selectedAudioAssetForTimeline() {
  const selectedSound = canvasSelectedSoundNode() || canvasNodes.find((item) => item.id === canvasLastSelectedSoundNodeId && item.type === "sound");
  const nodeAsset = selectedSound ? canvasAssetById(selectedSound.assetId) : null;
  if (nodeAsset) return nodeAsset;
  if (currentTrack?.audioPath) {
    return canvasCreateAsset({
      audioPath: currentTrack.audioPath,
      metadataPath: currentTrack.metadataPath || currentTrack.metadata?.metadata_path || "",
      metadata: currentTrack.metadata || {},
      origin: "library",
    });
  }
  return null;
}

function listenerPromptValue() {
  return $("listenerPrompt")?.value || $("prompt")?.value || $("seedPrompt")?.value || "";
}

function listenerNegativeValue() {
  return $("listenerNegative")?.value || $("negativePrompt")?.value || "";
}

function renderListenerSummary(result) {
  const host = $("listenerSummary");
  if (!host) return;
  const chips = [];
  if (result.rating) chips.push(`rating ${result.rating}`);
  if (typeof result.score === "number") chips.push(`score ${Math.round(result.score * 100)}%`);
  if (result.provider) chips.push(`provider ${result.provider}`);
  (result.warnings || []).slice(0, 4).forEach((warning) => chips.push(warning));
  host.innerHTML = chips.map((chip) => `<span>${escapeHtml(chip)}</span>`).join("");
}

async function runListenerEnhance() {
  beginWork("Listener", "Enhancing prompt");
  const result = await api("/listener/enhance", {
    method: "POST",
    body: JSON.stringify({
      provider: $("listenerProvider")?.value || "neutral",
      model: $("listenerModel")?.value || "neutral-compiler",
      prompt: listenerPromptValue(),
      negative_prompt: listenerNegativeValue(),
    }),
  });
  if ($("listenerPrompt")) $("listenerPrompt").value = result.enhanced_prompt || result.prompt || "";
  if ($("listenerNegative")) $("listenerNegative").value = result.negative_prompt || "";
  if ($("prompt")) $("prompt").value = result.enhanced_prompt || result.prompt || "";
  if ($("negativePrompt")) $("negativePrompt").value = result.negative_prompt || "";
  renderListenerSummary(result);
  if ($("listenerResult")) showJson($("listenerResult"), result);
  finishWork("Listener Ready", "ok", `${result.suggestions?.length || 0} suggestion(s)`);
}

async function runListenerScoreSelected() {
  const asset = selectedAudioAssetForTimeline();
  if (!asset?.audioPath) throw new Error("Select a saved WAV source first.");
  timeEnsureWavAsset(asset);
  beginWork("Listener", timeAssetLabel(asset));
  const result = await api("/listener/score", {
    method: "POST",
    body: JSON.stringify({
      provider: $("listenerProvider")?.value || "neutral",
      model: "local-signal-check",
      prompt: listenerPromptValue(),
      audio_path: asset.audioPath,
      metadata_path: asset.metadataPath || "",
    }),
  });
  renderListenerSummary(result);
  if ($("listenerResult")) showJson($("listenerResult"), result);
  const key = asset.metadataPath || asset.audioPath || asset.id;
  if (key) {
    updatePetriState(key, { listenerScore: Number(result.score || 0) });
    persistPetriRatings(key).catch((error) => setState("Petri Sync", "muted", error.message));
    renderHerbarium();
  }
  finishWork("Listener Score", result.score >= 0.42 ? "ok" : "muted", result.rating);
}

async function runListenerRelistenSelected() {
  const asset = selectedAudioAssetForTimeline();
  if (!asset?.audioPath) throw new Error("Select a saved generated sound first.");
  timeEnsureWavAsset(asset);
  beginWork("Oída Re-listen", timeAssetLabel(asset));
  const result = await api("/listener/relisten", {
    method: "POST",
    body: JSON.stringify({
      audio_path: asset.audioPath,
      metadata_path: asset.metadataPath || null,
      route_preset: $("listenerRoutePreset")?.value || "generative",
      intent: "variation",
      privacy_mode: "session",
      remember: Boolean($("listenerRemember")?.checked),
    }),
  });
  if ($("listenerPrompt")) $("listenerPrompt").value = result.prompt || "";
  if ($("listenerNegative")) $("listenerNegative").value = result.negative_prompt || "";
  if ($("prompt")) $("prompt").value = result.prompt || "";
  if ($("negativePrompt")) $("negativePrompt").value = result.negative_prompt || "";
  renderListenerSummary({ ...result, provider: "oida" });
  if ($("listenerResult")) showJson($("listenerResult"), result);

  const sourceNode = canvasSelectedSoundNode()
    || canvasNodes.find((node) => node.id === canvasLastSelectedSoundNodeId && node.type === "sound")
    || null;
  const point = sourceNode ? canvasConnectPointFor(sourceNode, { x: 56, y: 8 }) : canvasBoardDefaultPoint();
  const promptNode = canvasCreatePromptNode({
    text: result.prompt || "",
    negative: result.negative_prompt || "",
    x: point.x,
    y: point.y,
    relisten: result,
  });
  promptNode.label = "Oída re-listening prompt";
  if (sourceNode) {
    canvasEdges.push({
      id: canvasId("edge"),
      projectId: activeCulture.id,
      fromNodeId: sourceNode.id,
      toNodeId: promptNode.id,
      type: "listening_prompt",
      metadata: {
        provider: "oida",
        event_id: result.listening_event_id,
        generation_id: result.generation_id,
        route_preset: result.route_preset,
      },
    });
  }
  canvasSaveState();
  renderCanvas();
  finishWork(
    "Oída Heard It",
    "ok",
    `${result.route_preset} · next prompt ready${result.remembered ? " · remembered" : ""}`,
  );
}

function saveIncubationTimelineNode(node) {
  const index = canvasNodes.findIndex((item) => item.id === node?.id);
  if (index === -1) return null;
  canvasNodes[index] = normalizeTimeNode(node);
  selectedCanvasNodeId = canvasNodes[index].id;
  canvasSaveState();
  updateTimeTransportUi();
  renderCanvas();
  return canvasNodes[index];
}

function addSelectedSoundToIncubationTimeline(nodeId) {
  const node = canvasNodes.find((item) => item.id === nodeId);
  if (!node || node.type !== "time" || node.timeType !== "incubation_timeline") return;
  const asset = selectedAudioAssetForTimeline();
  if (!asset) {
    setState("Select Source", "muted", "Select a saved WAV source first.");
    return;
  }
  try {
    timeEnsureWavAsset(asset);
  } catch (error) {
    setState("Timeline Source", "bad", error.message);
    return;
  }
  let source = (node.timelineSources || []).find((item) => item.assetId === asset.id);
  if (!source) {
    source = canvasDefaultIncubationSource(asset, (node.timelineSources || []).length);
    node.timelineSources = [...(node.timelineSources || []), source];
  }
  const derived = timeClockDerived();
  const lastEvent = [...(node.timelineEvents || [])].sort((a, b) => (a.startBeat || 0) - (b.startBeat || 0)).at(-1);
  const startBeat = Math.min(Math.max(0, derived.totalBeats - 0.25), Number(lastEvent?.startBeat || 0) + Number(lastEvent?.durationBeats || 0));
  const sourceBeats = asset.durationSec ? Math.max(0.25, Math.min(derived.totalBeats, asset.durationSec / derived.secondsPerBeat)) : 1;
  const event = {
    ...canvasDefaultIncubationEvent(source.id, (node.timelineEvents || []).length),
    label: timeAssetLabel(asset),
    startBeat,
    durationBeats: Math.min(derived.totalBeats, Math.max(0.25, Math.min(sourceBeats, 4))),
  };
  node.timelineEvents = [...(node.timelineEvents || []), event];
  node.selectedEventId = event.id;
  saveIncubationTimelineNode(node);
  setState("Placed On Timeline", "ok", timeAssetLabel(asset));
}

function addIncubationTimelineEvent(nodeId) {
  const node = canvasNodes.find((item) => item.id === nodeId);
  if (!node || node.type !== "time" || node.timeType !== "incubation_timeline") return;
  const source = node.timelineSources?.[0];
  if (!source) {
    addSelectedSoundToIncubationTimeline(nodeId);
    return;
  }
  const event = canvasDefaultIncubationEvent(source.id, (node.timelineEvents || []).length);
  node.timelineEvents = [...(node.timelineEvents || []), event];
  node.selectedEventId = event.id;
  saveIncubationTimelineNode(node);
}

function updateIncubationTimelineParam(target) {
  const node = canvasNodes.find((item) => item.id === target.dataset.nodeId);
  if (!node || node.type !== "time" || node.timeType !== "incubation_timeline") return false;
  const event = (node.timelineEvents || []).find((item) => item.id === target.dataset.eventId);
  if (!event) return false;
  const param = target.dataset.param;
  if (param === "label" || param === "sourceId") event[param] = target.value;
  else if (param === "sourceStartSec" || param === "sourceEndSec") event[param] = nullableSeconds(target.value);
  else event[param] = Number(target.value);
  node.selectedEventId = event.id;
  saveIncubationTimelineNode(node);
  return true;
}

function updateIncubationSourceParam(target) {
  const node = canvasNodes.find((item) => item.id === target.dataset.nodeId);
  if (!node || node.type !== "time" || node.timeType !== "incubation_timeline") return false;
  const source = (node.timelineSources || []).find((item) => item.id === target.dataset.sourceId);
  if (!source) return false;
  source[target.dataset.param] = Number(target.value);
  saveIncubationTimelineNode(node);
  return true;
}

async function triggerTimePad(nodeId, padIndex, { fromKeyboard = false } = {}) {
  const node = canvasNodes.find((item) => item.id === nodeId);
  const pad = node?.pads?.[padIndex];
  const asset = pad ? canvasAssetById(pad.assetId) : null;
  if (!node || !pad || !asset?.audioPath) {
    if (!fromKeyboard) setState("Empty Pad", "muted", "Assign or generate a pad sound first.");
    return;
  }
  // Pads fire as pooled AudioBufferSource voices: low-latency, polyphonic
  // with voice stealing, anti-click envelopes, honoring the pad's volume AND
  // pan, and routed through the master bus (FX-safe, limiter-safe, captured
  // by master recording). The old path spawned a raw `new Audio()` per hit
  // that bypassed all of that — and ignored the pan slider entirely.
  const pool = canvasEnsureTriggerPool();
  const context = canvasPlaybackContext();
  if (pool && context) {
    if (context.state === "suspended") await context.resume().catch(() => {});
    const buffer = await fetchCanvasAudioBuffer(asset);
    if (buffer) {
      pool.trigger(buffer, {
        gain: Math.min(2, Math.max(0, Number(pad.volume ?? 1))),
        pan: Math.min(1, Math.max(-1, Number(pad.pan ?? 0))),
      });
      canvasUpdateMasterHeadroom();
      if (node.recording) recordTimePadEvent(node, padIndex);
      return;
    }
  }
  // Decode failed or Web Audio unavailable: keep the sound alive the old way.
  const audio = new Audio(outputUrl(asset.audioPath));
  audio.volume = Math.min(1, Math.max(0, Number(pad.volume ?? 1)));
  await audio.play();
  if (node.recording) recordTimePadEvent(node, padIndex);
}

function recordTimePadEvent(node, padIndex) {
  if (!node?.recording) return;
  const elapsedMs = Date.now() - Number(node.recordStartMs || Date.now());
  const rawTick = (elapsedMs / 1000 / timeClockDerived().secondsPerBeat) * timeState.ppq;
  const tick = Math.min(timeClockDerived().totalTicks - 1, timeQuantizeTick(rawTick));
  node.recordedEvents = [
    ...(node.recordedEvents || []),
    {
      padIndex,
      tick,
      velocity: 1,
      recordedAtMs: elapsedMs,
    },
  ];
  canvasSaveState();
  renderCanvas();
}

function toggleTimePadRecording(nodeId) {
  const node = canvasNodes.find((item) => item.id === nodeId);
  if (!node || node.type !== "time" || node.timeType !== "trigger_pads") return;
  enableTimeMode("Pad recording uses the Chamber clock.");
  node.recording = !node.recording;
  if (node.recording) {
    node.recordStartMs = Date.now();
    node.recordedEvents = [];
  } else {
    node.recordStartMs = null;
  }
  renderCanvas();
  setState(node.recording ? "Pad Recording" : "Pad Recorded", node.recording ? "busy" : "ok", `${(node.recordedEvents || []).length} event(s)`);
}

function slicerSelectedWindow(node) {
  const sourceAsset = timeAssetForSlot(node.source);
  const sourceDuration = Number(sourceAsset?.durationSec || sourceAsset?.metadata?.duration || 0);
  const sliceCount = Math.max(1, Number(node.sliceCount) || 16);
  const index = Math.min(sliceCount - 1, Math.max(0, Number(node.selectedSlice) || 0));
  if (sourceDuration <= 0) throw new Error("Slicer needs source duration metadata before mutating a slice.");
  return {
    index,
    startSec: (sourceDuration / sliceCount) * index,
    endSec: (sourceDuration / sliceCount) * (index + 1),
  };
}

async function mutateSelectedSlicerSlice(nodeId) {
  const node = canvasNodes.find((item) => item.id === nodeId);
  if (!node || node.type !== "time" || node.timeType !== "slicer") throw new Error("Select a Slicer module first.");
  const slice = node.slices?.[node.selectedSlice || 0];
  if (!slice) throw new Error("Select a slice first.");
  const sourceAsset = timeEnsureWavAsset(slice.assetId ? canvasAssetById(slice.assetId) : timeAssetForSlot(node.source));
  const windowInfo = slice.assetId
    ? { index: Number(node.selectedSlice) || 0, startSec: 0, endSec: Number(sourceAsset.durationSec || sourceAsset.metadata?.duration || 0.25) }
    : slicerSelectedWindow(node);

  beginWork("Mutate Slice", `Slice ${windowInfo.index + 1}`);
  let inputAudioPath = sourceAsset.audioPath;
  let parentMetadataPath = sourceAsset.metadataPath || sourceAsset.metadata?.metadata_path || "";
  let parentMetadata = sourceAsset.metadata || {};
  if (!slice.assetId) {
    const extractResult = await api("/audio-tools/operate", {
      method: "POST",
      body: JSON.stringify({
        input_audio_path: sourceAsset.audioPath,
        metadata_path: parentMetadataPath || null,
        operation: "extract_region",
        start_sec: Number(windowInfo.startSec.toFixed(4)),
        end_sec: Number(windowInfo.endSec.toFixed(4)),
        output_name: safeOutputName(`slicer_slice_${windowInfo.index + 1}`),
        lineage: {
          parents: [lineageSoundIdFromAsset(sourceAsset)].filter(Boolean),
          parent_metadata_paths: parentMetadataPath ? [parentMetadataPath] : [],
          operation: "slice",
          source_type: "slicer",
          source_node_id: node.id,
          operation_params: {
            slice_index: windowInfo.index,
            slice_count: node.sliceCount,
            start_sec: windowInfo.startSec,
            end_sec: windowInfo.endSec,
          },
        },
      }),
    });
    inputAudioPath = extractResult.audio_files?.[0] || "";
    parentMetadataPath = extractResult.metadata_files?.[0] || "";
    parentMetadata = parentMetadataPath ? await loadMetadata(parentMetadataPath) : {};
  }

  const promptPayload = canvasPromptPayload(node.id);
  const baseMutationValue = promptPayload.mutation || 0.5;
  const resolved = canvasResolveGenerationSettings(node.id, {
    operation: "mutate_slice",
    prompt: promptPayload.prompt || `mutated slice ${windowInfo.index + 1}`,
    negative_prompt: promptPayload.negativePrompt || $("negativePrompt")?.value || "",
    duration: Math.max(0.05, windowInfo.endSec - windowInfo.startSec),
    init_noise_level: baseMutationValue,
    batch_size: 1,
  }, { targetNodeId: node.id });
  const mutationValue = resolved.mutation || baseMutationValue;
  const result = await api("/audio-to-audio", {
    method: "POST",
    body: JSON.stringify(
      canvasBuildPayload({
        operation: "mutate_slice",
        ...modulationResolvedOverrides(resolved),
        input_audio_path: inputAudioPath,
        init_noise_level: mutationValue,
        output_name: safeOutputName(`slicer_mutated_slice_${windowInfo.index + 1}`),
        tags: ["time", "slicer", "mutated-slice"],
        lineage: {
          parents: [lineageSoundIdFromMetadata(parentMetadata, inputAudioPath)].filter(Boolean),
          parent_metadata_paths: parentMetadataPath ? [parentMetadataPath] : [],
          operation: "mutate_slice",
          source_type: "slicer",
          source_node_id: node.id,
          operation_params: {
            slice_index: windowInfo.index,
            init_noise_level: mutationValue,
            source_start_sec: windowInfo.startSec,
            source_end_sec: windowInfo.endSec,
          },
        },
      }),
    ),
  });
  const audioPath = result.audio_files?.[0];
  const metadataPath = result.metadata_files?.[0] || "";
  if (!audioPath) throw new Error(result.error || "Slice mutation did not return audio.");
  const metadata = metadataPath ? await loadMetadata(metadataPath) : {};
  const asset = canvasCreateAsset({
    audioPath,
    metadataPath,
    metadata,
    origin: "time_one_shot",
  });
  slice.assetId = asset.id;
  await refreshLibrary(false);
  renderCanvas();
  finishWork("Slice Mutated", "ok", timeAssetLabel(asset));
}

function stopAllTimePadRecordings() {
  canvasNodes.forEach((node) => {
    if (node?.type === "time" && node.timeType === "trigger_pads") {
      node.recording = false;
      node.recordStartMs = null;
    }
  });
}

async function runCanvasGenerate(sourceNodeId = null) {
  const basePromptPayload = canvasPromptPayload(sourceNodeId);
  const promptNode = basePromptPayload.promptNode;
  if (!promptNode) throw new Error("Add a prompt source before generating.");
  const resolved = canvasResolveGenerationSettings(promptNode.id, { operation: "generate" }, { targetNodeId: promptNode.id });
  const prompt = resolved.prompt || "";
  const negativePrompt = resolved.negativePrompt || "";
  if (!prompt.trim()) {
    canvasPromptRunFinish(promptNode, "Prompt empty", "bad", "Write a prompt before generating.");
    throw new Error("Write a prompt inside the prompt module before generating.");
  }

  const providerModel = `${$("provider").value} / ${$("model").value}`;
  try {
    // Colony mode
    if (promptNode.colonyEnabled) {
      const totalCandidates = Math.min(16, Math.max(1, Math.round(Number(resolved.colonyCandidates || promptNode.colonyCandidates || 4))));
      const seedMode = promptNode.colonySeedMode || "random";
      const baseSeed = Number(resolved.seed) || -1;
      const colonyId = crypto.randomUUID();
      const seedFamily = baseSeed === -1 ? Math.floor(Math.random() * 999999) : baseSeed;
      const colony = {
        colony_id: colonyId,
        parent_source_id: promptNode.id,
        mode: "germinate",
        prompt,
        negative_prompt: negativePrompt,
        model: $("model")?.value || "-",
        runtime: $("provider")?.value || "-",
        seed_family: seedFamily,
        candidates: [],
      };

      canvasPromptRunStart(promptNode, "Colony", `${totalCandidates} candidates · ${seedMode}`);
      beginWork("Colony Generate", `${totalCandidates} candidates · ${seedMode} seed`);
      const batchSize = Math.max(1, Math.round(Number(resolved.batchSize) || Number(promptNode.batchSize) || 1));
      const runs = Math.ceil(totalCandidates / batchSize);

      for (let i = 0; i < runs; i++) {
        const remaining = totalCandidates - i * batchSize;
        const thisBatch = Math.min(batchSize, remaining);
        let seed = -1;
        if (seedMode === "locked") seed = seedFamily;
        else if (seedMode === "sequential") seed = seedFamily + i;
        else if (seedMode === "nearby") seed = seedFamily + Math.floor((Math.random() - 0.5) * 20);

        canvasPromptRunUpdate(promptNode, `Batch ${i + 1}/${runs}`, `${colony.candidates.length}/${totalCandidates} ready`);
        const result = await api("/generate", {
          method: "POST",
          body: JSON.stringify(
            canvasBuildPayload({
              operation: "generate",
              prompt,
              negative_prompt: negativePrompt,
              duration: resolved.durationSec,
              sourcePromptNodeId: promptNode.id,
              batch_size: thisBatch,
              seed,
              skip_modulation: true,
              base_prompt: resolved.basePrompt,
              modulated_prompt: resolved.prompt,
              base_negative_prompt: resolved.baseNegativePrompt,
              modulated_negative_prompt: resolved.negativePrompt,
              modulators: resolved.modulationRecords,
              lineage: canvasLineagePayload("generate", {
                sourceNode: promptNode,
                colonyId,
                extraParams: {
                  batch_size: thisBatch,
                  seed,
                  seed_family: seedFamily,
                  seed_mode: seedMode,
                },
              }),
            }),
          ),
        });
        colony.candidates.push(...(result.audio_files || []));
        await canvasCreateCandidatesFromResult(result, { operation: "generate", sourceNodeId: promptNode.id, colonyId });
        setState(`Colony ${i + 1}/${runs}`, "ok", `${colony.candidates.length}/${totalCandidates} candidates`);
        canvasPromptRunUpdate(promptNode, `Colony ${i + 1}/${runs}`, `${colony.candidates.length}/${totalCandidates} ready`);
      }

      promptNode.lastColony = colony;
      canvasPromptRunFinish(promptNode, "Ready", "ok", `${colony.candidates.length} candidate(s) in colony ${colonyId.slice(0, 8)}`);
      finishWork("Colony Ready", "ok", `${colony.candidates.length} candidate(s) in colony ${colonyId.slice(0, 8)}`);
      return;
    }

    // Normal single generation
    canvasPromptRunStart(promptNode, "Generating", providerModel);
    beginWork("Generating", providerModel);
    const result = await api("/generate", {
      method: "POST",
      body: JSON.stringify(
        canvasBuildPayload({
          operation: "generate",
          prompt,
          negative_prompt: negativePrompt,
          duration: resolved.durationSec,
          sourcePromptNodeId: promptNode.id,
          batch_size: 1,
          seed: resolved.seed,
          skip_modulation: true,
          base_prompt: resolved.basePrompt,
          modulated_prompt: resolved.prompt,
          base_negative_prompt: resolved.baseNegativePrompt,
          modulated_negative_prompt: resolved.negativePrompt,
          modulators: resolved.modulationRecords,
          lineage: canvasLineagePayload("generate", {
            sourceNode: promptNode,
            extraParams: { batch_size: 1 },
          }),
        }),
      ),
    });
    await canvasCreateCandidatesFromResult(result, { operation: "generate", sourceNodeId: promptNode?.id || null });
    const ok = result.status === "done";
    canvasPromptRunFinish(promptNode, ok ? "Ready" : "Error", ok ? "ok" : "bad", result.error || `${result.audio_files?.length || 0} candidate(s)`);
    finishWork(ok ? "Candidates Ready" : "Generate Error", ok ? "ok" : "bad", result.error || `${result.audio_files?.length || 0} candidate(s)`);
  } catch (error) {
    canvasPromptRunFinish(promptNode, "Error", "bad", error.message);
    throw error;
  }
}

function canvasSourcePayloadBase(operation) {
  const node = canvasSelectedNode();
  const asset = canvasSelectedAsset();
  if (!node || node.type !== "sound" || !asset) throw new Error("Select a sound node first.");
  const duration = operation === "inpaint" ? canvasNodePlaybackEnd(node) : canvasNodeDuration(node);
  const region = canvasInpaintRegion(node);
  updateCanvasCompilerPreview(operation);
  return { node, asset, duration, region };
}

async function canvasRunRegionCommand(nodeId, command) {
  const node = canvasNodes.find((item) => item.id === nodeId);
  if (!node || node.type !== "sound") throw new Error("Select a source waveform first.");
  selectedCanvasNodeId = node.id;
  canvasLastSelectedSoundNodeId = node.id;
  const commandConfig = {
    preserve_groove: { type: "preserve", intent: "preserve groove", state: "Groove Preserved" },
    replace_texture: { type: "texture", intent: "replace texture", operation: "inpaint", state: "Texture Region" },
    continue_space: { type: "bridge", intent: "continue space", operation: "continue", state: "Bridge Region" },
    mutate_tail: { type: "variation", intent: "mutate tail", operation: "inpaint", placement: "tail", state: "Tail Variation" },
    extract_identity: { type: "seed", intent: "extract identity", extract: true, state: "Identity Region" },
  }[command];
  if (!commandConfig) throw new Error(`Unsupported region command: ${command}`);
  const region = canvasEnsureRegionForType(node, commandConfig.type, commandConfig.intent, commandConfig.placement || "full");
  if (!region) throw new Error("Could not create region.");
  canvasSaveState();
  renderCanvas();
  drawCanvasWaveforms();
  setState(commandConfig.state, "ok", canvasRegionSummary(region));
  if (commandConfig.extract) {
    await canvasExtractRegionFromNode(node, region);
    return;
  }
  if (commandConfig.operation) await runCanvasOperation(commandConfig.operation);
}

function canvasGeneticExecutionSource(node) {
  if (!node || node.type !== "genetic") return null;
  const directSource = canvasGeneticSourceNode(node);
  if (directSource?.type === "genetic") {
    return canvasGeneticSourceNode(directSource) || canvasGeneticTargetNode(directSource) || null;
  }
  if (directSource && ["sound", "prompt"].includes(directSource.type)) return directSource;
  const directTarget = canvasGeneticTargetNode(node);
  if (directTarget && ["sound", "prompt"].includes(directTarget.type)) return directTarget;
  return canvasSelectedSoundNode() || canvasNodes.find((item) => item.type === "prompt") || null;
}

async function canvasRunGenerationSequencer(nodeId) {
  const original = canvasNodes.find((item) => item.id === nodeId);
  if (!original || original.type !== "genetic" || original.geneticType !== "generation_sequencer") throw new Error("Select a generation sequencer first.");
  const node = normalizeGeneticNode(original);
  const source = canvasGeneticExecutionSource(node);
  if (!source) throw new Error("Connect a prompt or sound source to the sequencer first.");
  const events = [];
  node.lastRun = {
    startedAt: new Date().toISOString(),
    status: "running",
    source_node_id: source.id,
    sequence: canvasGenerationSequencePayload(node),
    events,
  };
  canvasNodes[canvasNodes.findIndex((item) => item.id === node.id)] = node;
  selectedCanvasNodeId = node.id;
  canvasSaveState();
  renderCanvas();
  beginWork("Generation Sequence", GENETIC_SEQUENCER_MODES[node.mode] || "Genetic sequencer");

  const runSoundOperation = async (operation, step) => {
    if (source.type !== "sound") {
      events.push({ step: step.index + 1, action: step.action, status: "skipped", reason: "needs sound source" });
      return;
    }
    selectedCanvasNodeId = source.id;
    canvasLastSelectedSoundNodeId = source.id;
    await runCanvasOperation(operation);
    events.push({ step: step.index + 1, action: step.action, status: "done", operation });
  };

  try {
    for (const [index, step] of (node.steps || []).entries()) {
      if (step.enabled === false) {
        events.push({ step: index + 1, action: step.action, status: "disabled" });
        continue;
      }
      const probability = Math.min(1, Math.max(0, Number(step.probability ?? 1)));
      const roll = Math.random();
      if (roll > probability) {
        events.push({ step: index + 1, action: step.action, status: "skipped", probability, roll: Number(roll.toFixed(3)) });
        continue;
      }
      const runStep = { ...step, index };
      if (step.action === "mutate_light") {
        if (source.type === "sound") source.variationMutation = 0.25;
        await runSoundOperation("mutate", runStep);
      } else if (step.action === "continue_4s") {
        await runSoundOperation("continue", runStep);
      } else if (step.action === "inpaint_middle") {
        if (source.type === "sound" && !canvasAllInpaintRegions(source).length) {
          canvasEnsureRegionForType(source, "variation", "sequencer inpaint middle", "center");
        }
        await runSoundOperation("inpaint", runStep);
      } else if (step.action === "prompt_variation") {
        if (source.type === "prompt") {
          await runCanvasGenerate(source.id);
          events.push({ step: index + 1, action: step.action, status: "done", operation: "generate" });
        } else {
          events.push({ step: index + 1, action: step.action, status: "skipped", reason: "needs prompt source" });
        }
      } else if (step.action === "graft_texture") {
        if (source.type === "sound") {
          canvasEnsureRegionForType(source, "texture", "graft texture", "center");
          await runSoundOperation("inpaint", runStep);
        } else {
          events.push({ step: index + 1, action: step.action, status: "skipped", reason: "needs sound source" });
        }
      } else {
        events.push({ step: index + 1, action: step.action, status: "noted" });
      }
    }
    node.lastRun = {
      ...node.lastRun,
      status: "done",
      finishedAt: new Date().toISOString(),
      events,
    };
    selectedCanvasNodeId = node.id;
    canvasSaveState();
    renderCanvas();
    finishWork("Sequence Complete", "ok", `${events.filter((item) => item.status === "done").length} operation(s) executed`);
  } catch (error) {
    node.lastRun = {
      ...node.lastRun,
      status: "error",
      error: error.message,
      finishedAt: new Date().toISOString(),
      events,
    };
    selectedCanvasNodeId = node.id;
    canvasSaveState();
    renderCanvas();
    finishWork("Sequence Error", "bad", error.message);
    throw error;
  }
}

async function runCanvasOperation(operation) {
  const { node, asset, duration, region } = canvasSourcePayloadBase(operation);
  let endpoint = "/generate";
  let payload = {};
  let body = null;

  if (operation === "mutate") {
    endpoint = "/audio-to-audio";
    const promptPayload = canvasPromptPayload(node.id);
    const baseMutationValue = canvasMutationValueForNode(node, promptPayload);
    const resolved = canvasResolveGenerationSettings(node.id, {
      operation,
      duration,
      init_noise_level: baseMutationValue,
      batch_size: promptPayload.batchSize,
    }, { targetNodeId: node.id });
    const mutationValue = resolved.mutation;
    payload = canvasBuildPayload({
      operation,
      resolvedSettings: resolved,
      sourcePromptNodeId: node.id,
      input_audio_path: asset.audioPath || "",
      init_noise_level: mutationValue,
      output_name: safeOutputName(`canvas_mutation_${node.label || "node"}`),
      lineage: canvasLineagePayload(operation, {
        sourceNode: node,
        sourceAsset: asset,
        extraParams: {
          init_noise_level: mutationValue,
          mutation_preset: mutationPresetForValue(mutationValue).label,
          batch_size: resolved.batchSize,
        },
      }),
    });
  } else if (operation === "inpaint") {
    const allRegions = canvasAllInpaintRegions(node);
    if (allRegions.length === 0) throw new Error("Create a waveform region, then mark it as Mask, Variation, Texture, Silence, or Bridge.");
    const promptPayload = canvasPromptPayload(node.id);
    const resolved = canvasResolveGenerationSettings(node.id, {
      operation,
      duration,
      batch_size: promptPayload.batchSize,
    }, { targetNodeId: node.id });
    const inpaintRanges = canvasModulatedInpaintRanges(allRegions, duration, resolved);
    endpoint = "/inpaint";
    payload = canvasBuildPayload({
      operation,
      resolvedSettings: resolved,
      sourcePromptNodeId: node.id,
      input_audio_path: asset.audioPath || "",
      inpaint_ranges: inpaintRanges,
      duration,
      batch_size: resolved.batchSize,
      output_name: safeOutputName(`canvas_inpaint_${node.label || "node"}`),
      lineage: canvasLineagePayload(operation, {
        sourceNode: node,
        sourceAsset: asset,
        region: allRegions.length === 1 ? allRegions[0] : null,
        extraParams: {
          inpaint_ranges: inpaintRanges,
          batch_size: resolved.batchSize,
        },
      }),
    });
  } else if (operation === "heal") {
    const allRegions = canvasAllInpaintRegions(node);
    if (allRegions.length === 0) throw new Error("Create a waveform region, then mark it as Mask, Variation, Texture, Silence, or Bridge.");
    const resolved = canvasResolveGenerationSettings(node.id, {
      operation,
      duration,
      batch_size: 1,
    }, { targetNodeId: node.id });
    const inpaintRanges = canvasModulatedInpaintRanges(allRegions, duration, resolved);
    endpoint = "/inpaint";
    payload = canvasBuildPayload({
      operation: "inpaint",
      heal_mode: true,
      resolvedSettings: resolved,
      sourcePromptNodeId: node.id,
      input_audio_path: asset.audioPath || "",
      inpaint_ranges: inpaintRanges,
      duration,
      batch_size: resolved.batchSize,
      output_name: safeOutputName(`canvas_heal_${node.label || "node"}`),
      lineage: canvasLineagePayload(operation, {
        sourceNode: node,
        sourceAsset: asset,
        region: allRegions.length === 1 ? allRegions[0] : null,
        extraParams: {
          inpaint_ranges: inpaintRanges,
          heal_mode: true,
        },
      }),
    });
  } else if (operation === "heal-full") {
    endpoint = "/inpaint";
    const resolved = canvasResolveGenerationSettings(node.id, {
      operation,
      duration,
      batch_size: 1,
    }, { targetNodeId: node.id });
    const inpaintRanges = canvasModulatedInpaintRanges([{ startSec: 0, endSec: duration }], duration, resolved);
    payload = canvasBuildPayload({
      operation: "inpaint",
      heal_mode: true,
      resolvedSettings: resolved,
      sourcePromptNodeId: node.id,
      input_audio_path: asset.audioPath || "",
      inpaint_ranges: inpaintRanges,
      duration,
      batch_size: resolved.batchSize,
      output_name: safeOutputName(`canvas_healfull_${node.label || "node"}`),
      lineage: canvasLineagePayload(operation, {
        sourceNode: node,
        sourceAsset: asset,
        region: { id: "full", purpose: "inpaint", startSec: 0, endSec: duration, nodeId: node.id },
        extraParams: {
          inpaint_ranges: inpaintRanges,
          heal_mode: true,
        },
      }),
    });
  } else if (operation === "continue") {
    endpoint = "/continue";
    const promptPayload = canvasPromptPayload(node.id);
    const resolved = canvasResolveGenerationSettings(node.id, {
      operation,
      duration: promptPayload.durationSec,
      batch_size: promptPayload.batchSize,
    }, { targetNodeId: node.id });
    const divergence = Math.min(1.5, Math.max(0, Number(resolved.continuationDivergence ?? 0.5)));
    const targetDuration = Math.max(duration + 0.5, duration + resolved.durationSec * (0.5 + divergence));
    node.futureDuration = targetDuration;
    canvasSetRegion(node, "continuation", duration, targetDuration);
    const continuationResolved = { ...resolved, durationSec: targetDuration };
    payload = canvasBuildPayload({
      operation,
      resolvedSettings: continuationResolved,
      sourcePromptNodeId: node.id,
      input_audio_path: asset.audioPath || "",
      source_duration: duration,
      target_duration: targetDuration,
      output_name: safeOutputName(`canvas_continuation_${node.label || "node"}`),
      lineage: canvasLineagePayload(operation, {
        sourceNode: node,
        sourceAsset: asset,
        region: canvasRegionForPurpose(node, "continuation"),
        extraParams: {
          source_duration: duration,
          target_duration: targetDuration,
          continuation_divergence: divergence,
          batch_size: resolved.batchSize,
        },
      }),
    });
  } else {
    throw new Error(`Unsupported operation: ${operation}`);
  }

  if (asset.file) {
    const form = new FormData();
    appendPayloadToForm(form, payload);
    form.append("file", asset.file);
    body = form;
  } else {
    body = JSON.stringify(payload);
  }

  beginWork(operation, `${$("provider").value} / ${$("model").value}`);
  const result = await api(endpoint, { method: "POST", body });
  await canvasCreateCandidatesFromResult(result, {
    operation,
    sourceNodeId: node.id,
    sourceAssetId: asset.id,
    region: operation === "continue" ? canvasRegionForPurpose(node, "continuation") : region,
    sourceDuration: duration,
    targetDuration: operation === "continue" ? payload.target_duration : null,
  });
  finishWork(result.status === "done" ? `${operation} ready` : `${operation} error`, result.status === "done" ? "ok" : "bad", result.error || `${result.audio_files?.length || 0} candidate(s)`);
}

function canvasAudioToolLabel(tool) {
  return {
    extract_region: "Region Extract",
    normalize: "Normalize",
    seam_healer: "Seam Healer",
    loop_doctor: "Loop Doctor",
    transient_keeper: "Transient Keeper",
    tail_extender: "Tail Extender",
    texture_flatten: "Texture Flatten",
    silence_cleaner: "Silence Cleaner",
    spectral_freeze: "Spectral Freeze",
    onset_splitter: "Onset Splitter",
    region_quantizer: "Region Quantizer",
    loudness_match: "Loudness Match",
    phase_mono_check: "Phase / Mono Check",
    stem_extract_prep: "Stem Extract Prep",
    metadata_embedder: "Metadata Embedder",
    fade: "Fade",
    crossfade_loop: "Crossfade Loop",
    reverse: "Reverse",
    duplicate: "Duplicate",
    time_pitch: "Time/Pitch",
    slice: "Slice",
    metadata: "Metadata",
  }[tool] || tool;
}

function canvasAudioToolBackendOperation(tool) {
  if (tool === "metadata_embedder") return "metadata";
  if (tool === "loudness_match") return "loudness_match";
  return tool;
}

function canvasSelectedSoundContext() {
  const node = canvasSelectedNode();
  const asset = canvasSelectedAsset();
  if (!node || node.type !== "sound" || !asset) throw new Error("Select a sound module first.");
  if (!asset.audioPath) throw new Error("Audio tools need a saved library file. Local browser-only audio cannot be edited yet.");
  return { node, asset };
}

function canvasNormalizedRegion(region) {
  if (!region) return null;
  const bounds = canvasRegionBounds(region);
  if (!bounds) return null;
  const config = canvasRegionConfig(region);
  const type = canvasRegionType(region);
  return {
    id: region.id || null,
    purpose: region.purpose || config.purpose || "extract",
    regionType: type,
    region_type: type,
    role: region.role || config.role,
    behavior: region.behavior || config.behavior,
    intent: region.intent || config.intent,
    locked: Boolean(region.locked ?? config.locked),
    startSec: bounds.start,
    endSec: bounds.end,
    nodeId: region.nodeId || region.node_id || null,
  };
}

function canvasAudioToolPayload(tool, { node, asset, region = null, metadataEdits = null } = {}) {
  const operation = canvasAudioToolBackendOperation(tool);
  const normalizedRegion = canvasNormalizedRegion(region);
  const promptPayload = canvasPromptPayload(node.id);
  const operationParams = {
    tool_operation: tool,
    backend_operation: operation,
  };
  if (normalizedRegion) {
    operationParams.start_sec = Number(normalizedRegion.startSec.toFixed(3));
    operationParams.end_sec = Number(normalizedRegion.endSec.toFixed(3));
  }
  const payload = {
    input_audio_path: asset.audioPath,
    metadata_path: asset.metadataPath || asset.metadata?.metadata_path || null,
    operation,
    output_name: safeOutputName(`canvas_${tool}_${node.label || "sound"}`),
    culture_id: activeCulture.id,
    tags: ["canvas", tool, ...parseTags($("seedTags")?.value || "")],
    prompt: asset.metadata?.prompt || promptPayload.prompt || "",
    negative_prompt: asset.metadata?.negative_prompt || promptPayload.negativePrompt || "",
    seed: Number.isFinite(Number(asset.metadata?.seed)) ? Number(asset.metadata.seed) : null,
    fade_in_sec: 0.04,
    fade_out_sec: 0.04,
    crossfade_sec: 0.08,
    tail_extension_sec: 2,
    freeze_duration_sec: 8,
    silence_threshold: 0.012,
    onset_threshold: 0.34,
    slice_count: 4,
    ...canvasRegionPayloadFields(node),
    lineage: canvasLineagePayload(tool, {
      sourceNode: node,
      sourceAsset: asset,
      region: normalizedRegion,
      extraParams: operationParams,
    }),
  };
  if (normalizedRegion) {
    payload.start_sec = Number(normalizedRegion.startSec.toFixed(3));
    payload.end_sec = Number(normalizedRegion.endSec.toFixed(3));
  }
  if (tool === "slice") {
    const sliceRegions = canvasAllInpaintRegions(node)
      .map(canvasNormalizedRegion)
      .filter(Boolean)
      .map((item) => ({
        id: item.id,
        purpose: "slice",
        region_type: item.region_type || item.regionType || "mask",
        role: item.role || null,
        behavior: item.behavior || null,
        intent: item.intent || null,
        locked: Boolean(item.locked),
        start_sec: Number(item.startSec.toFixed(3)),
        end_sec: Number(item.endSec.toFixed(3)),
      }));
    if (sliceRegions.length) payload.regions = sliceRegions;
  }
  if (tool === "seam_healer") {
    payload.crossfade_sec = 0.035;
    payload.fade_in_sec = 0.01;
    payload.fade_out_sec = 0.01;
  }
  if (tool === "loop_doctor") {
    payload.crossfade_sec = 0.12;
    payload.fade_in_sec = 0.015;
    payload.fade_out_sec = 0.015;
  }
  if (tool === "tail_extender") {
    payload.tail_extension_sec = Math.min(12, Math.max(0.25, Number(asset.metadata?.duration || canvasNodeDuration(node)) * 0.5));
  }
  if (tool === "spectral_freeze") {
    payload.freeze_duration_sec = Math.min(30, Math.max(4, Number(canvasNodeViewDuration(node)) || 8));
    payload.crossfade_sec = 0.06;
  }
  if (tool === "onset_splitter") {
    payload.slice_count = 12;
    payload.onset_threshold = 0.32;
  }
  if (tool === "stem_extract_prep") {
    payload.fade_in_sec = 0.015;
    payload.fade_out_sec = 0.015;
    payload.silence_threshold = 0.01;
  }
  if (tool === "metadata_embedder") {
    payload.notes = [
      asset.metadata?.notes || "",
      "Embedded prompt, seed, model, lineage, region roles, and source-module context for export.",
    ].filter(Boolean).join("\n");
    payload.tags = Array.from(new Set([...(Array.isArray(asset.metadata?.tags) ? asset.metadata.tags : []), "lineage", "embedded"]));
  }
  if (metadataEdits) Object.assign(payload, metadataEdits);
  return payload;
}

async function canvasRunAudioToolRequest(tool, context, metadataEdits = null) {
  return api("/audio-tools/operate", {
    method: "POST",
    body: JSON.stringify(canvasAudioToolPayload(tool, { ...context, metadataEdits })),
  });
}

async function canvasRunTimePitchRequest(context, options = {}) {
  const { node, asset } = context;
  const metadata = asset.metadata || {};
  return api("/audio/process", {
    method: "POST",
    body: JSON.stringify({
      input_audio_path: asset.audioPath,
      metadata_path: asset.metadataPath || metadata.metadata_path || "",
      output_name: options.outputName || safeOutputName(`time_pitch_${node.label || displayNameFromPath(asset.audioPath)}`),
      pitch_semitones: Number(options.pitchSemitones ?? 0),
      stretch_ratio: options.stretchRatio ?? null,
      target_duration_sec: options.targetDurationSec ?? null,
      quality: options.quality || "fine",
      culture_id: activeCulture.id,
      tags: ["time-pitch", ...(options.tags || [])],
      notes: options.notes || "Rubber Band time-stretch / pitch-shift processing.",
      lineage: canvasLineagePayload("time_pitch_process", {
        sourceNode: node,
        sourceAsset: asset,
        extraParams: {
          pitch_semitones: Number(options.pitchSemitones ?? 0),
          stretch_ratio: options.stretchRatio ?? null,
          target_duration_sec: options.targetDurationSec ?? null,
          quality: options.quality || "fine",
        },
      }),
    }),
  });
}

async function canvasCreateAudioToolNodes(result, { tool, sourceNode, sourceAsset, region = null } = {}) {
  const audioFiles = result.audio_files || [];
  const metadataFiles = result.metadata_files || [];
  const created = [];
  for (let index = 0; index < audioFiles.length; index += 1) {
    const audioPath = audioFiles[index];
    const metadataPath = metadataFiles[index] || "";
    let metadata = {};
    try {
      metadata = metadataPath ? await loadMetadata(metadataPath) : {};
    } catch {
      metadata = {};
    }
    const asset = canvasCreateAsset({
      audioPath,
      metadataPath,
      metadata,
      origin: tool === "time_pitch" ? "time_pitch" : tool === "extract_region" || tool === "slice" ? "extract" : "audio_tool",
      parentAssetIds: sourceAsset?.id ? [sourceAsset.id] : [],
    });
    const point = canvasStackedBelowPoint(sourceNode);
    const labelSuffix = audioFiles.length > 1 ? ` ${index + 1}` : "";
    const node = canvasCreateSoundNode({
      asset,
      label: `${sourceNode?.label || "sound"} ${canvasAudioToolLabel(tool).toLowerCase()}${labelSuffix}`,
      x: point.x,
      y: point.y,
      width: sourceNode?.width || 352,
      parentNodeId: sourceNode?.id || null,
      edgeType: "lineage",
      region: region ? { ...region, purpose: "annotation" } : null,
    });
    if (node && sourceNode) {
      node.snapParentNodeId = sourceNode.id;
      node.snapAxis = "below";
      node.snapOperation = tool;
    }
    created.push(node);
  }
  if (created.length) {
    await refreshLibrary(false);
    renderCanvas();
  }
  return created;
}

async function canvasExtractRegionFromNode(node, region) {
  const asset = node ? canvasAssetById(node.assetId) : null;
  const normalizedRegion = canvasNormalizedRegion(region);
  if (!node || !asset || !normalizedRegion) return [];
  if (!asset.audioPath) throw new Error("Region extraction needs a saved library file.");
  beginWork("Extracting", `${formatPreciseTime(normalizedRegion.startSec)} - ${formatPreciseTime(normalizedRegion.endSec)}`);
  const result = await canvasRunAudioToolRequest("extract_region", { node, asset, region: normalizedRegion });
  const created = await canvasCreateAudioToolNodes(result, {
    tool: "extract_region",
    sourceNode: node,
    sourceAsset: asset,
    region: normalizedRegion,
  });
  finishWork("Region Extracted", "ok", `${created.length || result.audio_files?.length || 0} sound`);
  return created;
}

async function runCanvasAudioTool(tool) {
  const { node, asset } = canvasSelectedSoundContext();
  if (tool === "transient_keeper") {
    const region = canvasEnsureRegionForType(node, "accent", "protect transient during mutation", "center");
    if (!region) throw new Error("Could not create a transient protection region.");
    node.protectedTransient = true;
    node.variationMutation = Math.min(0.5, Number(node.variationMutation ?? 0.5));
    canvasSaveState();
    renderCanvas();
    drawCanvasWaveforms();
    setState("Transient Keeper", "ok", canvasRegionSummary(region));
    return;
  }
  if (tool === "region_quantizer") {
    const region = canvasActiveEditableRegion(node);
    const bounds = canvasRegionBounds(region);
    if (!region || !bounds) throw new Error("Draw or select a waveform region before quantizing it.");
    const viewStart = canvasNodePlaybackStart(node);
    const duration = canvasNodeViewDuration(node);
    const grid = Math.max(0.025, duration / 16);
    const quantize = (value) => viewStart + Math.round((value - viewStart) / grid) * grid;
    const start = Math.max(viewStart, quantize(bounds.start));
    const end = Math.min(canvasNodePlaybackEnd(node), Math.max(start + grid, quantize(bounds.end)));
    region.startSec = Number(start.toFixed(3));
    region.endSec = Number(end.toFixed(3));
    region.updatedAt = new Date().toISOString();
    canvasSaveState();
    renderCanvas();
    drawCanvasWaveforms();
    setState("Region Quantized", "ok", canvasRegionSummary(region));
    return;
  }
  if (tool === "metadata_embedder") {
    beginWork("Embedding Metadata", node.label || asset.audioPath);
    const result = await canvasRunAudioToolRequest("metadata_embedder", { node, asset }, {
      notes: [
        asset.metadata?.notes || "",
        "Export metadata refreshed from source-module lineage, region roles, prompt, seed, model, and genetic context.",
      ].filter(Boolean).join("\n"),
    });
    const metadataPath = result.metadata_files?.[0] || asset.metadataPath;
    let metadata = asset.metadata || {};
    try {
      metadata = metadataPath ? await loadMetadata(metadataPath) : metadata;
    } catch {}
    asset.metadataPath = metadataPath;
    asset.metadata = metadata;
    await refreshLibrary(false);
    renderCanvas();
    finishWork("Metadata Embedded", "ok", displayNameFromPath(asset.audioPath));
    return;
  }
  if (tool === "metadata") {
    const currentTags = Array.isArray(asset.metadata?.tags) ? asset.metadata.tags.join(", ") : "";
    const tagsValue = window.prompt("Tags", currentTags);
    if (tagsValue === null) return;
    const promptValue = window.prompt("Prompt", asset.metadata?.prompt || "");
    if (promptValue === null) return;
    const notesValue = window.prompt("Notes", asset.metadata?.notes || "");
    if (notesValue === null) return;
    beginWork("Updating Metadata", node.label || asset.audioPath);
    const result = await canvasRunAudioToolRequest("metadata", { node, asset }, {
      tags: parseTags(tagsValue),
      prompt: promptValue,
      notes: notesValue,
    });
    const metadataPath = result.metadata_files?.[0] || asset.metadataPath;
    let metadata = asset.metadata || {};
    try {
      metadata = metadataPath ? await loadMetadata(metadataPath) : metadata;
    } catch {
      metadata = { ...metadata, tags: parseTags(tagsValue), prompt: promptValue, notes: notesValue };
    }
    asset.metadataPath = metadataPath;
    asset.metadata = metadata;
    await refreshLibrary(false);
    renderCanvas();
    finishWork("Metadata Updated", "ok", displayNameFromPath(asset.audioPath));
    return;
  }

  const region = ["extract_region", "spectral_freeze"].includes(tool)
    ? canvasNormalizedRegion(canvasActiveEditableRegion(node) || canvasRegionForPurpose(node, "extract"))
    : null;
  if (tool === "spectral_freeze" && !region) {
    const freezeRegion = canvasEnsureRegionForType(node, "texture", "freeze spectral texture", "center");
    canvasSaveState();
    renderCanvas();
    drawCanvasWaveforms();
    return runCanvasAudioTool(tool);
  }
  beginWork(canvasAudioToolLabel(tool), node.label || asset.audioPath);
  const result = await canvasRunAudioToolRequest(tool, { node, asset, region });
  const created = await canvasCreateAudioToolNodes(result, {
    tool,
    sourceNode: node,
    sourceAsset: asset,
    region,
  });
  finishWork(`${canvasAudioToolLabel(tool)} Ready`, "ok", `${created.length || result.audio_files?.length || 0} sound(s)`);
}

async function canvasProcessSelectedTimePitch(options = {}) {
  const { node, asset } = canvasSelectedSoundContext();
  beginWork("Time/Pitch", node.label || asset.audioPath);
  const result = await canvasRunTimePitchRequest({ node, asset }, options);
  const created = await canvasCreateAudioToolNodes(result, {
    tool: "time_pitch",
    sourceNode: node,
    sourceAsset: asset,
  });
  finishWork("Time/Pitch Ready", "ok", `${created.length || result.audio_files?.length || 0} sound(s)`);
  return created;
}

async function canvasRenderPitchFx(fxNodeId) {
  const fxNode = canvasNodes.find((item) => item.id === fxNodeId);
  if (!fxNode || fxNode.type !== "fx" || fxNode.fxType !== "pitch") return [];
  const sourceNode = canvasNodes.find((item) => item.id === fxNode.targetNodeId);
  const asset = sourceNode ? canvasAssetById(sourceNode.assetId) : null;
  if (!sourceNode || sourceNode.type !== "sound" || !asset?.audioPath) {
    throw new Error("Pitch render needs a saved sound target.");
  }
  const semitones = Number(fxNode.params?.semitones) || 0;
  beginWork("Render Pitch", `${semitones.toFixed(2)} st`);
  const result = await canvasRunTimePitchRequest({ node: sourceNode, asset }, {
    pitchSemitones: semitones,
    stretchRatio: 1,
    quality: "fine",
    tags: ["pitch-fx", "rubberband"],
    notes: "Rendered from Pitch FX with Rubber Band.",
    outputName: safeOutputName(`pitch_${semitones.toFixed(2)}_${sourceNode.label || "source"}`),
  });
  const created = await canvasCreateAudioToolNodes(result, {
    tool: "time_pitch",
    sourceNode,
    sourceAsset: asset,
  });
  finishWork("Pitch Rendered", "ok", `${created.length || result.audio_files?.length || 0} sound(s)`);
  return created;
}

async function canvasRenderLoopDoctorFx(fxNodeId) {
  const fxNode = canvasNodes.find((item) => item.id === fxNodeId);
  if (!fxNode || fxNode.type !== "fx" || fxNode.fxType !== "loop_doctor") return [];
  const sourceNode = canvasNodes.find((item) => item.id === fxNode.targetNodeId);
  const asset = sourceNode ? canvasAssetById(sourceNode.assetId) : null;
  if (!sourceNode || sourceNode.type !== "sound" || !asset?.audioPath) {
    throw new Error("Loop Doctor needs a saved sound target.");
  }
  const params = { ...canvasDefaultFxParams("loop_doctor"), ...(fxNode.params || {}) };
  const region = params.inpaintSeam !== false
    ? canvasNormalizedRegion(canvasActiveEditableRegion(sourceNode) || canvasRegionForPurpose(sourceNode, "loop") || canvasRegionForPurpose(sourceNode, "mask"))
    : null;
  beginWork("Loop Doctor", `${sourceNode.label || "sound"} / ${params.mode || "seam"}`);
  const result = await canvasRunAudioToolRequest("loop_doctor", { node: sourceNode, asset, region }, {
    crossfade_sec: Math.min(0.5, Math.max(0.01, Number(params.crossfadeSec) || 0.12)),
    notes: `Rendered from Loop Doctor FX in ${params.mode || "seam"} mode.`,
    tags: ["canvas", "loop_doctor", "fx", params.mode || "seam"],
  });
  const created = await canvasCreateAudioToolNodes(result, {
    tool: "loop_doctor",
    sourceNode,
    sourceAsset: asset,
    region,
  });
  finishWork("Loop Doctor Ready", "ok", `${created.length || result.audio_files?.length || 0} sound(s)`);
  return created;
}

async function processClockedLooperToBars(nodeId) {
  const node = canvasNodes.find((item) => item.id === nodeId);
  if (!node || node.type !== "time" || node.timeType !== "clocked_looper") return [];
  const asset = timeAssetForSlot(node.source);
  if (!asset?.audioPath) throw new Error("Assign a saved WAV source before fitting to bars.");
  timeEnsureWavAsset(asset);
  const sourceNode = canvasNodes.find((item) => item.type === "sound" && item.assetId === asset.id) || canvasCreateSoundNode({
    asset,
    label: timeAssetLabel(asset),
    x: node.x + node.width + 80,
    y: node.y,
    parentNodeId: node.id,
    edgeType: "audio_context",
  });
  const targetSeconds = Math.max(0.05, (Number(node.targetBars) || 1) * timeClockDerived().beatsPerBar * (60 / timeState.bpm));
  beginWork("Fit To Bars", `${node.targetBars} bar(s) | ${targetSeconds.toFixed(2)}s`);
  const result = await canvasRunTimePitchRequest({ node: sourceNode, asset }, {
    targetDurationSec: targetSeconds,
    pitchSemitones: 0,
    quality: "fine",
    tags: ["clocked-looper", "fit-bars"],
    notes: `Fit source to ${node.targetBars} bar(s) at ${timeState.bpm} BPM with Rubber Band.`,
    outputName: safeOutputName(`fit_${node.targetBars}_bars_${node.label || "clocked_loop"}`),
  });
  const created = await canvasCreateAudioToolNodes(result, {
    tool: "time_pitch",
    sourceNode,
    sourceAsset: asset,
  });
  const fitted = created[0] ? canvasAssetById(created[0].assetId) : null;
  if (fitted) timeAssignAssetToSlot(node, "looper_source", 0, fitted);
  renderCanvas();
  finishWork("Fit Ready", "ok", fitted ? timeAssetLabel(fitted) : "No fitted source");
  return created;
}

function canvasBranchNode(nodeId = selectedCanvasNodeId) {
  const node = canvasNodes.find((item) => item.id === nodeId);
  if (!node || node.type !== "sound") return;
  const asset = canvasAssetById(node.assetId);
  const point = canvasStackedBelowPoint(node);
  const branch = canvasCreateSoundNode({
    asset,
    label: `${node.label || "sound"} branch`,
    x: point.x,
    y: Math.max(0, point.y),
    width: node.width,
    parentNodeId: node.id,
    edgeType: "lineage",
    region: node.regions?.[0] ? { ...node.regions[0], purpose: "extract" } : null,
  });
  if (branch) {
    branch.snapParentNodeId = node.id;
    branch.snapAxis = "below";
    branch.snapOperation = "branch";
  }
  if (branch) setState("Branch Created", "ok", branch.label);
}

async function canvasPreviewCandidate(candidateId) {
  const candidate = canvasCandidates.find((item) => item.id === candidateId);
  const asset = candidate ? canvasAssetById(candidate.assetId) : null;
  if (!candidate || !asset) return;
  const audio = new Audio(asset.objectUrl || outputUrl(candidate.audioPath));
  await audio.play();
}

function canvasToggleCandidateSelection(candidateId, selected) {
  const candidate = canvasCandidates.find((item) => item.id === candidateId);
  if (!candidate) return;
  candidate.selected = Boolean(selected);
  candidate.spotlight = "";
  canvasSaveState();
  renderCanvasCandidates();
}

function canvasRateCandidate(candidateId, rating) {
  const candidate = canvasCandidates.find((item) => item.id === candidateId);
  if (!candidate) return;
  candidate.rating = ["favorite", "maybe", "reject"].includes(rating) ? rating : "maybe";
  candidate.selected = candidate.rating === "reject" ? false : candidate.selected;
  candidate.ecology = canvasCandidateEcology(candidate);
  canvasSaveState();
  renderCanvasCandidates();
}

function canvasCandidateSourceNodeForEvolution(candidate, operationLabel = "evolution source") {
  const existing = canvasNodes.find((node) => node.id === candidate?.canvasNodeId && node.type === "sound");
  if (existing) return existing;
  const asset = candidate ? canvasAssetById(candidate.assetId) : null;
  if (!candidate || !asset) return null;
  const parent = canvasCandidateSourceNode(candidate);
  const basePoint = parent
    ? canvasFindOpenPoint(canvasConnectPointFor(parent, { x: 90, y: 120 }), { width: parent.width || 352, height: 262 }, { anchorNode: parent })
    : canvasBoardDefaultPoint();
  const node = canvasCreateSoundNode({
    asset,
    label: `${candidate.label || displayNameFromPath(candidate.audioPath)} ${operationLabel}`,
    x: basePoint.x,
    y: basePoint.y,
    width: parent?.width || 352,
    parentNodeId: parent?.id || null,
    edgeType: "lineage",
    region: candidate.region ? { ...candidate.region, purpose: "annotation" } : null,
  });
  if (node && parent) {
    node.snapParentNodeId = parent.id;
    node.snapAxis = "below";
    node.snapOperation = operationLabel;
  }
  candidate.canvasNodeId = node?.id || candidate.canvasNodeId;
  return node;
}

function canvasCandidateBlendPrompt(candidates) {
  const prompts = candidates
    .map(canvasCandidatePromptText)
    .filter(Boolean);
  const tags = candidates
    .flatMap((candidate) => candidate.ecology?.tags || [])
    .filter(Boolean);
  return [
    "hybrid sound organism bred from selected candidates",
    ...prompts.slice(0, 4),
    tags.length ? `shared traits: ${Array.from(new Set(tags)).slice(0, 8).join(", ")}` : "",
  ].filter(Boolean).join(", ");
}

async function canvasBreedCandidates(candidates) {
  const breedingPool = candidates.length >= 2
    ? candidates
    : canvasCandidates.filter((candidate) => candidate.rating === "favorite").slice(0, 4);
  if (breedingPool.length < 2) throw new Error("Select or favorite at least two candidates to breed.");
  const sourceNode = breedingPool
    .map(canvasCandidateSourceNode)
    .find((node) => node?.type === "prompt")
    || canvasNodes.find((node) => node.type === "prompt")
    || canvasCandidateSourceNode(breedingPool[0])
    || null;
  const avgDuration = breedingPool.reduce((sum, candidate) => {
    const metadata = canvasCandidateMetadata(candidate);
    const asset = canvasAssetById(candidate.assetId);
    return sum + (Number(metadata.duration ?? asset?.durationSec) || 4);
  }, 0) / breedingPool.length;
  beginWork("Breed Selected", `${breedingPool.length} candidate parents`);
  const result = await api("/generate", {
    method: "POST",
    body: JSON.stringify(canvasBuildPayload({
      operation: "breed",
      prompt: canvasCandidateBlendPrompt(breedingPool),
      negative_prompt: $("negativePrompt")?.value || "speech, vocals, clipping",
      duration: Math.min(60, Math.max(0.5, avgDuration || 4)),
      sourcePromptNodeId: sourceNode?.id || null,
      batch_size: Math.min(4, Math.max(2, breedingPool.length)),
      seed: -1,
      tags: ["canvas", "breed", "candidate_ecology"],
      lineage: canvasLineagePayload("breed", {
        sourceNode,
        extraParams: {
          candidate_ids: breedingPool.map((candidate) => candidate.id),
          parent_audio_paths: breedingPool.map((candidate) => candidate.audioPath),
          ecology: breedingPool.map((candidate) => candidate.ecology),
        },
      }),
    })),
  });
  await canvasCreateCandidatesFromResult(result, { operation: "breed", sourceNodeId: sourceNode?.id || null });
  finishWork(result.status === "done" ? "Breed Ready" : "Breed Error", result.status === "done" ? "ok" : "bad", result.error || `${result.audio_files?.length || 0} candidate(s)`);
}

async function canvasMutateCandidate(candidate) {
  const node = canvasCandidateSourceNodeForEvolution(candidate, "mutation parent");
  if (!node) throw new Error("Could not create a mutation parent from the candidate.");
  node.variationMutation = Math.max(0.25, Math.min(0.75, Number(candidate.ecology?.mutationDistance ?? 0.45) + 0.12));
  selectedCanvasNodeId = node.id;
  canvasLastSelectedSoundNodeId = node.id;
  await runCanvasOperation("mutate");
}

async function canvasMakeCandidateFamily(candidate) {
  const node = canvasCandidateSourceNodeForEvolution(candidate, "family parent");
  if (!node) throw new Error("Could not create a family parent from the candidate.");
  node.variationMutation = 0.25;
  selectedCanvasNodeId = node.id;
  canvasLastSelectedSoundNodeId = node.id;
  beginWork("Make Family", candidate.label || "candidate");
  for (let index = 0; index < 4; index += 1) {
    selectedCanvasNodeId = node.id;
    await runCanvasOperation("mutate");
  }
  finishWork("Family Ready", "ok", "4 related mutations created.");
}

function canvasCullSimilarCandidates() {
  const seen = new Set();
  const before = canvasCandidates.length;
  canvasCandidates = canvasCandidates.filter((candidate) => {
    const ecology = candidate.ecology || canvasCandidateEcology(candidate);
    if (candidate.selected || candidate.rating === "favorite") return true;
    if (candidate.rating === "reject") return false;
    if (ecology.novelty < 0.24 && ecology.audioSimilarity > 0.7) return false;
    const key = [
      candidate.sourceNodeId || "none",
      candidate.operation,
      Math.round(ecology.promptSimilarity * 8),
      Math.round(ecology.spectralBrightness * 5),
      Math.round(ecology.density * 5),
    ].join(":");
    if (seen.has(key) && ecology.audioSimilarity > 0.78) return false;
    seen.add(key);
    return true;
  });
  const removed = before - canvasCandidates.length;
  canvasSaveState();
  renderCanvasCandidates();
  setState("Cull Similar", removed ? "ok" : "muted", `${removed} removed`);
}

function canvasSpotlightCandidate(metric, label) {
  const candidate = canvasBestCandidateFor(metric);
  if (!candidate) throw new Error("No candidate population yet.");
  canvasCandidates.forEach((item) => {
    item.spotlight = item.id === candidate.id ? label : "";
    item.selected = item.id === candidate.id;
  });
  canvasCandidates = [
    candidate,
    ...canvasCandidates.filter((item) => item.id !== candidate.id),
  ];
  canvasSaveState();
  renderCanvasCandidates();
  setState(label, "ok", candidate.label || displayNameFromPath(candidate.audioPath));
}

async function canvasRunEcologyAction(command) {
  const selected = canvasSelectedCandidates({ includeFavorites: true });
  if (command === "breed_selected") {
    await canvasBreedCandidates(selected);
    return;
  }
  if (command === "mutate_favorite") {
    const candidate = selected.find((item) => item.rating === "favorite") || selected[0] || canvasBestCandidateFor("cleanest");
    if (!candidate) throw new Error("Favorite or select a candidate first.");
    await canvasMutateCandidate(candidate);
    return;
  }
  if (command === "make_family") {
    const candidate = selected[0] || canvasBestCandidateFor("loopability") || canvasCandidates[0];
    if (!candidate) throw new Error("Select a candidate first.");
    await canvasMakeCandidateFamily(candidate);
    return;
  }
  if (command === "cull_similar") {
    canvasCullSimilarCandidates();
    return;
  }
  if (command === "find_weirdest") {
    canvasSpotlightCandidate("novelty", "Weirdest Found");
    return;
  }
  if (command === "find_cleanest") {
    canvasSpotlightCandidate("cleanest", "Cleanest Found");
    return;
  }
  if (command === "find_loopable") {
    canvasSpotlightCandidate("loopability", "Loopable Found");
    return;
  }
}

async function canvasRunRenderMacro(macro) {
  const selectedSound = canvasSelectedSoundNode() || (canvasLastSelectedSoundNodeId ? canvasNodes.find((item) => item.id === canvasLastSelectedSoundNodeId) : null);
  if (["loop_doctor", "mutate_selected", "continue_selected", "heal_region"].includes(macro)) {
    if (!selectedSound) throw new Error("Select a sound module before running this macro.");
    selectedCanvasNodeId = selectedSound.id;
    canvasLastSelectedSoundNodeId = selectedSound.id;
  }
  if (macro === "loop_doctor") {
    await runCanvasAudioTool("loop_doctor");
    return;
  }
  if (macro === "mutate_selected") {
    await runCanvasOperation("mutate");
    return;
  }
  if (macro === "continue_selected") {
    await runCanvasOperation("continue");
    return;
  }
  if (macro === "heal_region") {
    await runCanvasOperation(canvasAllInpaintRegions(selectedSound).length ? "heal" : "heal-full");
    return;
  }
  await canvasRunEcologyAction(macro);
}

async function canvasAcceptCandidate(candidateId, acceptAs) {
  const candidate = canvasCandidates.find((item) => item.id === candidateId);
  const candidateAsset = candidate ? canvasAssetById(candidate.assetId) : null;
  if (!candidate || !candidateAsset) return;
  const sourceNode = canvasNodes.find((node) => node.id === candidate.sourceNodeId) || canvasSelectedNode();
  if (acceptAs === "branch" || !sourceNode || sourceNode.type !== "sound") {
    const sourceEl = sourceNode ? document.querySelector(`.canvas-node[data-node-id="${sourceNode.id}"]`) : null;
    const sourceH = sourceEl ? sourceEl.offsetHeight : (sourceNode?.height || 262);
    let newX = (sourceNode?.x || 210) + 48;
    let newY = (sourceNode?.y || 110) + 260;
    let snapAxis = null;

    if (sourceNode && candidate.operation === "inpaint") {
      newX = sourceNode.x;
      newY = sourceNode.y + sourceH;
      snapAxis = "below";
    } else if (sourceNode && candidate.operation === "mutate") {
      const point = canvasStackedBelowPoint(sourceNode);
      newX = point.x;
      newY = point.y;
      snapAxis = "below";
    } else if (sourceNode && candidate.operation === "continue") {
      const point = canvasSnappedRightPoint(sourceNode);
      newX = point.x;
      newY = point.y;
      snapAxis = "right";
    }

    const branchNode = canvasCreateSoundNode({
      asset: candidateAsset,
      label: candidate.label,
      x: newX,
      y: Math.max(0, newY),
      width: sourceNode?.width || 352,
      parentNodeId: sourceNode?.id || null,
      edgeType: candidate.operation === "continue" ? "continuation" : "lineage",
      region: candidate.region ? { ...candidate.region, purpose: "annotation" } : null,
    });
    if (branchNode && sourceNode && snapAxis) {
      branchNode.snapParentNodeId = sourceNode.id;
      branchNode.snapAxis = snapAxis;
      branchNode.snapOperation = candidate.operation;
      if (candidate.operation === "continue") {
        branchNode.attachedToNodeId = sourceNode.id;
        branchNode.linkedPlayback = false;
      }
    }
  } else {
    const previousAssetId = sourceNode.assetId;
    sourceNode.assetId = candidateAsset.id;
    sourceNode.label = acceptAs === "replace_region"
      ? `${sourceNode.label || "sound"} region v${sourceNode.versions.length + 1}`
      : candidate.label;
    sourceNode.versions = [...(sourceNode.versions || []), candidateAsset.id];
    sourceNode.futureDuration = candidateAsset.durationSec || sourceNode.futureDuration;
    canvasEdges.push({
      id: canvasId("edge"),
      projectId: activeCulture.id,
      fromNodeId: candidate.sourceNodeId || sourceNode.id,
      toNodeId: sourceNode.id,
      type: acceptAs === "replace_region" ? "replacement" : "lineage",
      metadata: {
        acceptAs,
        previousAssetId,
        candidateId,
        region: candidate.region,
        note: acceptAs === "replace_region"
          ? "Accepted as a non-destructive region replacement version. Original asset remains in versions."
          : "Accepted as a non-destructive source replacement version.",
      },
    });
  }
  canvasCandidates = canvasCandidates.filter((item) => item.id !== candidateId);
  canvasSaveState();
  renderCanvas();
  setState("Candidate Accepted", "ok", acceptAs.replaceAll("_", " "));
}

function canvasSaveCandidate(candidateId) {
  const candidate = canvasCandidates.find((item) => item.id === candidateId);
  const asset = candidate ? canvasAssetById(candidate.assetId) : null;
  if (!candidate || !asset) return;
  setCurrentTrack(candidate.audioPath, candidate.metadataPath, asset.metadata).catch((error) => {
    finishWork("Candidate Preview Error", "bad", error.message);
  });
  setState("Candidate Saved", "ok", candidate.audioPath);
}

function canvasDiscardCandidate(candidateId) {
  canvasCandidates = canvasCandidates.filter((item) => item.id !== candidateId);
  canvasSaveState();
  renderCanvasCandidates();
}

function renderCulture() {
  activeCulture.name = $("cultureName")?.value || activeCulture.name;
  activeCulture.description = $("cultureNotes")?.value || activeCulture.description;
  const discoveredCandidateIds = libraryItems
    .map((item) => item.metadata_file || item.audio_file || item.id)
    .filter(Boolean);
  activeCulture.candidateIds = Array.from(
    new Set([...manualCultureCandidateIds, ...discoveredCandidateIds]),
  );
  activeCulture.layerIds = layers.map((layer) => layer.id);
  activeCulture.strainIds = strainStack.map((strain) => strain.id);
  activeCulture.groups = savedGroups;
  activeCulture.notes = listenerNotes;
  activeCulture.updatedAt = new Date().toISOString();
  if ($("cultureId")) $("cultureId").textContent = activeCulture.id;
  if ($("cultureJson")) showJson($("cultureJson"), activeCulture);
  updateHomeReadouts();
}

function createCulture() {
  const now = new Date().toISOString();
  activeCulture = {
    id: `culture-${crypto.randomUUID().slice(0, 8)}`,
    name: $("cultureName")?.value || "Untitled culture",
    description: $("cultureNotes")?.value || "",
    seedIds: [],
    candidateIds: [],
    layerIds: [],
    strainIds: [],
    groups: [],
    notes: [],
    createdAt: now,
    updatedAt: now,
  };
  manualCultureCandidateIds = [];
  renderCulture();
}

function diagnosticsText(report) {
  const deps = report.dependencies || {};
  const hf = report.huggingface || {};
  const audio = report.audio_processing || {};
  const missing = report.missing_for_real_local_models || [];
  return [
    `recommended: ${report.recommended_local_provider}`,
    `active: ${report.active_provider}`,
    `machine: ${report.machine}`,
    `uv: ${report.uv || "missing"}`,
    "",
    "dependencies:",
    ...Object.entries(deps).map(([name, ok]) => `  ${name}: ${ok ? "ok" : "missing"}`),
    "",
    "audio processing:",
    `  rubberband: ${audio.rubberband_cli || "missing"}`,
    `  time/pitch: ${audio.time_pitch_available ? "available" : "install Rubber Band"}`,
    "",
    "huggingface:",
    `  hf cli: ${hf.hf_cli || "missing"}`,
    `  huggingface-cli: ${hf.huggingface_cli || "missing"}`,
    `  token env: ${hf.hf_token_env_present ? "present" : "not set"}`,
    "",
    "provider workflow:",
    ...(report.test_workflow || []).map((item) => `  ${item}`),
    "",
    "missing:",
    ...(missing.length ? missing.map((item) => `  ${item}`) : ["  none"]),
  ].join("\n");
}

function renderReadiness(report) {
  const providers = report.providers || [];
  $("readinessCards").innerHTML = providers
    .map((provider) => {
      const cls = provider.available ? "ok" : "bad";
      const detail = provider.detail ? provider.detail : provider.device;
      return `<div class="status-card ${cls}"><strong>${escapeHtml(provider.id)}</strong><span>${escapeHtml(detail || "")}</span></div>`;
    })
    .join("");
}

async function refreshAll() {
  try {
    const [health, models, diagnostics] = await Promise.all([
      api("/health"),
      api("/models"),
      api("/diagnostics"),
    ]);
    for (const provider of models.providers || []) {
      providerModels[provider.id] = provider.models;
    }
    providerStatusById = Object.fromEntries((models.providers || []).map((provider) => [provider.id, provider]));
    syncProviderOptions();

    if (!initialized) {
      const recommended = diagnostics.recommended_local_provider;
      const recommendedStatus = (models.providers || []).find((item) => item.id === recommended);
      const preferredProvider =
        health.active_provider === "mock" && recommendedStatus?.available ? recommended : health.active_provider;
      if (preferredProvider && providerModels[preferredProvider] && providerIsAvailable(preferredProvider)) {
        $("provider").value = preferredProvider;
      } else {
        const fallback = firstAvailableProvider();
        if (fallback) $("provider").value = fallback;
      }
      initialized = true;
    }

    updateModels();
    const loaded = health.models_loaded?.[0]?.split(":")[1];
    if (loaded && providerModels[$("provider").value]?.includes(loaded)) $("model").value = loaded;
    const selectedStatus = (models.providers || []).find((item) => item.id === $("provider").value);
    $("activeProvider").textContent = $("provider").value;
    $("activeModel").textContent = $("model").value || "-";
    $("activeDevice").textContent =
      health.device && health.device !== "unknown" ? health.device : selectedStatus?.device || "unknown";
    showJson($("statusJson"), { health, models });
    $("diagnosticsText").textContent = diagnosticsText(diagnostics);
    renderReadiness(diagnostics);
    await refreshLibrary(false);
    await refreshWavetables({ force: true });
    await refreshStrains({ render: false });
    finishWork("Ready", "ok", `${$("provider").value} / ${$("model").value || "-"}`);
  } catch (error) {
    finishWork("Connection Error", "bad", error.message);
  }
}

async function loadModel() {
  beginWork("Loading Model", `${$("provider").value} / ${$("model").value}`);
  const result = await api("/models/load", {
    method: "POST",
    body: JSON.stringify({
      provider: $("provider").value,
      model: $("model").value,
      device: $("device").value,
    }),
  });
  showJson($("statusJson"), result);
  $("activeProvider").textContent = result.provider;
  $("activeModel").textContent = result.model;
  $("activeDevice").textContent = result.device;
  finishWork(result.status === "error" ? "Load Error" : "Model Ready", result.status === "error" ? "bad" : "ok", result.detail || "");
}

async function generate() {
  if (generateInFlight) return;
  generateInFlight = true;
  try {
    beginWork("Generating", `${$("provider").value} / ${$("model").value}`);
    const result = await api("/generate", {
      method: "POST",
      body: JSON.stringify(payloadBase()),
    });
    await renderOutput(result);
    finishWork(result.status === "done" ? "Generation Done" : "Generation Error", result.status === "done" ? "ok" : "bad", result.error || metadataSummary(currentTrack?.metadata));
  } finally {
    generateInFlight = false;
  }
}

async function runModelTest() {
  beginWork("Running Model Test", `${$("provider").value} / ${$("model").value}`);
  await loadModel();
  const original = {
    prompt: $("prompt").value,
    duration: $("duration").value,
    outputName: $("outputName").value,
    batchSize: $("batchSize").value,
  };
  $("prompt").value = $("testPrompt").value || "short dry wood impact, close microphone";
  $("duration").value = "1";
  $("batchSize").value = "1";
  $("outputName").value = `model_test_${$("provider").value}_${$("model").value}`;
  try {
    const result = await api("/generate", {
      method: "POST",
      body: JSON.stringify(payloadBase()),
    });
    await renderOutput(result);
    finishWork(result.status === "done" ? "Model Test Passed" : "Model Test Failed", result.status === "done" ? "ok" : "bad", result.error || metadataSummary(currentTrack?.metadata));
  } finally {
    $("prompt").value = original.prompt;
    $("duration").value = original.duration;
    $("outputName").value = original.outputName;
    $("batchSize").value = original.batchSize;
  }
}

async function checkHuggingFace() {
  beginWork("Checking Hugging Face", "CLI auth and Stable Audio 3 model access");
  const result = await api("/huggingface/status?check_models=true");
  showJson($("statusJson"), result);
  const lines = [
    `hf cli: ${result.auth?.hf_cli || "missing"}`,
    `logged in: ${result.auth?.logged_in ? "yes" : "no"}`,
    `token env: ${result.auth?.token_env_present ? "present" : "not set"}`,
    "",
    "models:",
    ...(result.models || []).map((item) => `  ${item.model}: ${item.status}`),
    "",
    "next:",
    ...((result.next_steps || []).length ? result.next_steps.map((item) => `  ${item}`) : ["  none"]),
  ];
  $("diagnosticsText").textContent = lines.join("\n");
  finishWork(
    result.ready_for_python_provider_downloads ? "HF Ready" : "HF Needs Setup",
    result.ready_for_python_provider_downloads ? "ok" : "bad",
    result.next_steps?.[0] || "Stable Audio model access is available.",
  );
}

async function loadLora() {
  beginWork("Loading LoRA", $("provider").value);
  const paths = $("loraPaths")
    .value.split("\n")
    .map((path) => path.trim())
    .filter(Boolean);
  const result = await api("/lora/load", {
    method: "POST",
    body: JSON.stringify({ provider: $("provider").value, paths }),
  });
  showJson($("loraResult"), result);
  updateHomeReadouts();
  finishWork(result.status === "error" ? "LoRA Error" : "LoRA Loaded", result.status === "error" ? "bad" : "ok", result.detail || "");
}

async function setLoraStrength() {
  beginWork("Setting LoRA", $("provider").value);
  const index = Number($("loraIndex").value);
  const result = await api("/lora/strength", {
    method: "POST",
    body: JSON.stringify({
      provider: $("provider").value,
      strength: Number($("loraStrength").value),
      lora_index: index < 0 ? null : index,
    }),
  });
  showJson($("loraResult"), result);
  updateHomeReadouts();
  finishWork(result.status === "error" ? "LoRA Error" : "LoRA Strength Set", result.status === "error" ? "bad" : "ok");
}

function renderStrainRegistry() {
  const root = $("strainRegistryList");
  if (!root) return;
  const activeKeys = new Set(strainStack.map((strain) => strain.id || strain.path).filter(Boolean));
  if (!strainRegistry.length) {
    root.innerHTML = `<div class="strain-empty">No strains saved.</div>`;
    return;
  }
  root.innerHTML = strainRegistry
    .map((strain) => {
      const key = strain.id || strain.path || "";
      const active = activeKeys.has(key);
      const tags = Array.isArray(strain.tags) ? strain.tags : [];
      const modules = Array.isArray(strain.recommended_modules) ? strain.recommended_modules : [];
      return `
        <article class="strain-card ${active ? "active" : ""}">
          <header>
            <strong>${escapeHtml(strain.name || "Untitled strain")}</strong>
            <span>${escapeHtml(strain.default_strength ?? "-")}</span>
          </header>
          <p>${escapeHtml(strain.description || strain.path || "No adapter path.")}</p>
          <div class="strain-meta">
            ${tags.slice(0, 4).map((tag) => `<span>${escapeHtml(tag)}</span>`).join("")}
            ${modules.slice(0, 3).map((module) => `<span>${escapeHtml(module.replaceAll("_", " "))}</span>`).join("")}
          </div>
          <div class="button-row">
            <button class="secondary" type="button" data-action="strain-use" data-strain-id="${escapeHtml(strain.id || "")}">${active ? "Using" : "Use"}</button>
            <button class="secondary" type="button" data-action="strain-load" data-strain-id="${escapeHtml(strain.id || "")}">Load</button>
            <button class="secondary danger-soft" type="button" data-action="strain-delete" data-strain-id="${escapeHtml(strain.id || "")}">Delete</button>
          </div>
        </article>
      `;
    })
    .join("");
}

async function refreshStrains({ render = true } = {}) {
  const result = await api("/strains");
  strainRegistry = result.strains || [];
  if (render) renderStrainRegistry();
  updateHomeReadouts();
  return strainRegistry;
}

function strainFormPayload() {
  const name = $("strainName")?.value?.trim() || "";
  if (!name) throw new Error("Give the strain a name first.");
  return {
    name,
    path: $("strainPath")?.value?.trim() || null,
    description: $("strainDescription")?.value?.trim() || null,
    tags: parseTags($("strainTags")?.value || ""),
    prompt_vocabulary: parseTags($("strainVocabulary")?.value || ""),
    recommended_modules: parseTags($("strainModules")?.value || ""),
    license: $("strainLicense")?.value?.trim() || null,
    author: $("strainAuthor")?.value?.trim() || null,
    source_dataset: $("strainDataset")?.value?.trim() || null,
    strength_min: Number($("strainMinStrength")?.value || 0),
    strength_max: Number($("strainMaxStrength")?.value || 1.5),
    default_strength: Number($("strainDefaultStrength")?.value || $("loraStrength")?.value || 0.7),
    provenance_notes: $("strainProvenance")?.value?.trim() || null,
  };
}

async function saveStrainFromPanel() {
  beginWork("Saving Strain", $("strainName")?.value || "registry");
  const strain = await api("/strains", {
    method: "POST",
    body: JSON.stringify(strainFormPayload()),
  });
  showJson($("loraResult"), strain);
  await refreshStrains({ render: true });
  finishWork("Strain Saved", "ok", strain.name);
}

function useStrainInStack(strainId) {
  const strain = strainRegistry.find((item) => item.id === strainId);
  if (!strain) throw new Error("Strain is not in the registry.");
  if (strain.path) {
    const textarea = $("loraPaths");
    const paths = textarea.value.split("\n").map((path) => path.trim()).filter(Boolean);
    if (!paths.includes(strain.path)) textarea.value = [...paths, strain.path].join("\n");
  }
  strainStack = [
    ...strainStack.filter((item) => (item.id || item.path) !== (strain.id || strain.path)),
    { ...strain, enabled: true },
  ];
  renderStrainRegistry();
  updateHomeReadouts();
  setState("Strain Selected", "ok", strain.name);
}

async function loadStrainFromRegistry(strainId) {
  const strain = strainRegistry.find((item) => item.id === strainId);
  if (!strain) throw new Error("Strain is not in the registry.");
  useStrainInStack(strainId);
  beginWork("Loading Strain", strain.name);
  const result = await api("/strains/load", {
    method: "POST",
    body: JSON.stringify({ provider: $("provider").value, strain_ids: [strainId] }),
  });
  showJson($("loraResult"), result);
  finishWork(result.status === "error" ? "Strain Error" : "Strain Loaded", result.status === "error" ? "bad" : "ok", strain.name);
}

async function deleteStrainFromRegistry(strainId) {
  const strain = strainRegistry.find((item) => item.id === strainId);
  if (!strain) return;
  beginWork("Deleting Strain", strain.name);
  await api(`/strains/${encodeURIComponent(strainId)}`, { method: "DELETE" });
  strainStack = strainStack.filter((item) => item.id !== strainId);
  await refreshStrains({ render: true });
  finishWork("Strain Deleted", "ok", strain.name);
}

function renderMicroMatterProfile() {
  const root = $("microProfileSummary");
  const output = $("microProfileResult");
  if (!root) return;
  if (!microMatterProfile) {
    root.innerHTML = `<div class="micro-profile-empty">Select a saved sound, then profile its grain and tissue behavior.</div>`;
    if (output) output.textContent = "";
    return;
  }
  const descriptors = microMatterProfile.descriptors || {};
  const spectral = descriptors.spectral_tissue || {};
  root.innerHTML = `
    <div class="micro-profile-grid">
      <span><b>${escapeHtml(descriptors.cell_count ?? "-")}</b> cells</span>
      <span><b>${escapeHtml(descriptors.grain_density ?? "-")}</b> density</span>
      <span><b>${escapeHtml(descriptors.quanta_rate ?? "-")}</b> quanta/sec</span>
      <span><b>${escapeHtml(spectral.centroid_peak ?? "-")}</b> spectral peak</span>
    </div>
    <div class="micro-suggestion-row">
      ${(microMatterProfile.module_suggestions || []).slice(0, 5).map((item) => `<span>${escapeHtml(item.module || "")}</span>`).join("")}
    </div>
  `;
  if (output) showJson(output, microMatterProfile);
}

async function profileSelectedAsMicroMatter() {
  const asset = controlSelectedAsset();
  const audioPath = asset?.audioPath || asset?.storageUri || asset?.output_audio_path || "";
  if (!audioPath) throw new Error("Select a saved sound first.");
  beginWork("Micro Profile", displayNameFromPath(audioPath));
  const result = await api("/micro/matter-profile", {
    method: "POST",
    body: JSON.stringify({
      input_audio_path: audioPath,
      metadata_path: asset?.metadataPath || "",
      source_id: asset?.id || selectedCanvasNodeId || "",
      module: $("microProfileModule")?.value || "microscope",
      window_ms: Number($("microProfileWindow")?.value || 20),
      hop_ms: Number($("microProfileHop")?.value || 10),
      output_name: safeOutputName(`micro_${displayNameFromPath(audioPath)}`),
      lineage: {
        parents: asset ? [lineageSoundIdFromAsset(asset)].filter(Boolean) : [],
      },
    }),
  });
  microMatterProfile = result;
  renderMicroMatterProfile();
  await refreshControlLayer({ render: false }).catch(() => null);
  finishWork("Micro Profile Ready", "ok", result.profile_file || "");
}

async function runLibraryRefresh(showState = true, { force = false } = {}) {
  if (showState) beginWork("Refreshing Library");
  const headers = {};
  if (libraryEtag && !force) headers["If-None-Match"] = libraryEtag;
  const response = await fetch(`${baseUrl()}/library?limit=0`, { headers });
  const nextEtag = response.headers.get("ETag");
  if (response.status === 304) {
    if (nextEtag) libraryEtag = nextEtag;
    const soundCount = libraryItems.filter((item) => item.audio_file && item.audio_exists !== false).length;
    if (showState) finishWork("Library Ready", "ok", `${soundCount} sounds (unchanged)`);
    return { unchanged: true, count: libraryItems.length };
  }
  const text = await response.text();
  let result = {};
  try {
    result = text ? JSON.parse(text) : {};
  } catch {
    result = { raw: text };
  }
  if (!response.ok) {
    const detail = result.detail || result.error || response.statusText;
    throw new Error(typeof detail === "string" ? detail : JSON.stringify(detail));
  }
  if (nextEtag) libraryEtag = nextEtag;
  libraryItems = result.items || [];
  prunePetriState(libraryItems);
  updatePetriFilterOptions();
  renderLibrary();
  renderPetri();
  renderRack();
  renderCanvasLibraryList();
  renderCulture();
  const soundCount = libraryItems.filter((item) => item.audio_file && item.audio_exists !== false).length;
  if (showState) finishWork("Library Ready", "ok", `${soundCount} sounds`);
  return result;
}

function refreshLibrary(showState = true, options = {}) {
  if (libraryRefreshPromise) return libraryRefreshPromise;
  const startRefresh = () => runLibraryRefresh(showState, options);
  if (showState || options.force) {
    libraryRefreshPromise = startRefresh().finally(() => {
      libraryRefreshPromise = null;
    });
    return libraryRefreshPromise;
  }
  libraryRefreshPromise = new Promise((resolve, reject) => {
    libraryRefreshTimer = setTimeout(() => {
      libraryRefreshTimer = null;
      startRefresh()
        .then(resolve, reject)
        .finally(() => {
          libraryRefreshPromise = null;
        });
    }, LIBRARY_REFRESH_COALESCE_MS);
  });
  return libraryRefreshPromise;
}

function libraryMatches(item) {
  if (isWavetableItem(item)) return false;
  const query = ($("librarySearch")?.value || "").trim().toLowerCase();
  const mode = $("libraryMode")?.value || "";
  const status = $("libraryStatus")?.value || "";
  if (mode && item.mode !== mode) return false;
  if (status && item.status !== status) return false;
  if (!query) return true;
  const haystack = [
    item.prompt,
    item.model,
    item.provider,
    item.mode,
    item.seed,
    item.audio_file,
    item.metadata_file,
  ]
    .join(" ")
    .toLowerCase();
  return haystack.includes(query);
}

function renderLibrary() {
  const el = $("libraryList");
  if (!el) return;
  const items = libraryItems.filter(libraryMatches);
  if (!items.length) {
    el.className = "library-list empty";
    el.textContent = "No generated sounds found.";
    return;
  }
  el.className = "library-list";
  el.innerHTML = items
    .map((item) => {
      const title = displayNameFromPath(item.audio_file || item.metadata_file);
      return `
        <article class="library-item">
          <div>
            <strong>${escapeHtml(title)}</strong>
            <small>${escapeHtml(item.prompt || item.error || "No prompt")}</small>
            <div class="library-meta">
              <span>${escapeHtml(item.status || "-")}</span>
              <span>${escapeHtml(item.provider || "-")}</span>
              <span>${escapeHtml(item.model || "-")}</span>
              <span>${escapeHtml(item.mode || "-")}</span>
              <span>seed ${escapeHtml(item.seed ?? "-")}</span>
            </div>
          </div>
          <div class="layer-actions">
            <button class="secondary" type="button" data-action="preview-library" data-metadata="${escapeHtml(item.metadata_file || "")}" data-audio="${escapeHtml(item.audio_file || "")}">Preview</button>
            <button class="secondary" type="button" data-action="add-library" data-metadata="${escapeHtml(item.metadata_file || "")}" data-audio="${escapeHtml(item.audio_file || "")}">Layer</button>
          </div>
        </article>
      `;
    })
    .join("");
}

async function libraryItemByMetadata(path) {
  return libraryItemByReference(path, "");
}

async function libraryItemByReference(metadataPath = "", audioPath = "") {
  const item = libraryItems.find(
    (entry) =>
      (metadataPath && entry.metadata_file === metadataPath) ||
      (audioPath && entry.audio_file === audioPath),
  );
  if (!item) return null;
  let metadata = null;
  if (isWavetableItem(item)) {
    const wavetableId = item.wavetable_id || item.id;
    metadata = wavetableId ? await api(`/wavetables/${encodeURIComponent(wavetableId)}`) : item;
  } else if (item.metadata_file) {
    try {
      metadata = await loadMetadata(item.metadata_file);
    } catch (error) {
      metadata = {
        app: item.app || "germ",
        provider: item.provider,
        runtime: item.runtime,
        model: item.model,
        mode: item.mode,
        germinator_mode: item.germinator_mode,
        prompt: item.prompt,
        duration: item.duration,
        seed: item.seed,
        status: item.status || "metadata_missing",
        tags: item.tags || [],
        ratings: item.ratings || {},
        created_at: item.created_at,
        output_audio_path: item.audio_file,
        metadata_path: item.metadata_file,
        metadata_error: error.message,
      };
    }
  } else {
    metadata = {
      app: item.app || "germ",
      provider: item.provider,
      runtime: item.runtime,
      model: item.model,
      mode: item.mode,
      germinator_mode: item.germinator_mode,
      prompt: item.prompt,
      duration: item.duration,
      seed: item.seed,
      status: item.status,
      tags: item.tags || [],
      created_at: item.created_at,
      output_audio_path: item.audio_file,
      metadata_path: null,
    };
  }
  return {
    audioPath: item.audio_file || metadata.output_audio_path,
    metadataPath: item.metadata_file || "",
    metadata,
  };
}

function libraryItemForReference(metadataPath = "", audioPath = "") {
  return libraryItems.find(
    (entry) =>
      (metadataPath && entry.metadata_file === metadataPath) ||
      (audioPath && entry.audio_file === audioPath),
  ) || null;
}

function lineageList(value) {
  return Array.isArray(value) ? value.filter((item) => item !== null && item !== undefined && item !== "").map(String) : [];
}

function lineageDataFrom(item = {}, metadata = {}) {
  const lineage = metadata.lineage || item.lineage || {};
  const id = item.sound_id
    || metadata.sound_id
    || lineage.id
    || item.audio_file
    || metadata.output_audio_path
    || item.metadata_file
    || metadata.metadata_path
    || item.id
    || "";
  const operation = item.operation
    || metadata.operation
    || lineage.operation
    || item.germinator_mode
    || metadata.germinator_mode
    || "archive";
  const params = metadata.operation_params || item.operation_params || lineage.operation_params || {};
  const region = metadata.source_region || item.source_region || lineage.region || null;
  const lora = metadata.lora_strains || metadata.lora || item.lora_strains || item.lora || lineage.lora_strains || [];
  const source = metadata.source || item.source || {};
  const latents = metadata.latents || item.latents || lineage.latents || params.latents || {};
  const latentFile = metadata.latent_file || item.latent_file || lineage.latent_file || params.latent_file || latents.file || "";
  const latentFingerprint = metadata.latent_fingerprint || item.latent_fingerprint || lineage.latent_fingerprint || params.latent_fingerprint || latents.fingerprint || "";
  const aliases = [
    id,
    item.id,
    item.audio_file,
    item.metadata_file,
    metadata.output_audio_path,
    metadata.metadata_path,
    lineage.audio_path,
    lineage.metadata_path,
  ].filter(Boolean).map(String);
  return {
    id: String(id || "unknown"),
    aliases: [...new Set(aliases)],
    title: displayNameFromPath(item.audio_file || metadata.output_audio_path || item.metadata_file || metadata.metadata_path || id),
    audioFile: item.audio_file || metadata.output_audio_path || lineage.audio_path || "",
    metadataFile: item.metadata_file || metadata.metadata_path || lineage.metadata_path || "",
    prompt: metadata.prompt || item.prompt || lineage.prompt || params.prompt || "",
    model: metadata.model || item.model || lineage.model || params.model || "-",
    provider: metadata.provider || item.provider || lineage.provider || params.provider || "-",
    seed: metadata.seed ?? item.seed ?? lineage.seed ?? params.seed ?? "-",
    operation: lineageOperationName(operation),
    operationParams: params,
    parents: lineageList(metadata.parents || item.parents || lineage.parents),
    children: lineageList(metadata.children || item.children || lineage.children),
    lora,
    source,
    sourceType: metadata.source_type || item.source_type || source.type || lineage.source_type || "-",
    latents,
    latentFile,
    latentFingerprint,
    tags: metadata.tags || item.tags || [],
    notes: metadata.notes || item.notes || "",
    duration: metadata.duration ?? item.duration ?? params.duration ?? null,
    runtime: metadata.runtime || item.runtime || params.provider || "-",
    region,
    parentBranch: metadata.parent_branch || item.parent_branch || lineage.parent_branch || null,
    createdAt: metadata.created_at || item.created_at || "",
  };
}

function buildLineageIndex(selectedSummary = null) {
  const summaries = libraryItems.map((item) => lineageDataFrom(item, item));
  if (selectedSummary) summaries.push(selectedSummary);
  const byAlias = new Map();
  const byId = new Map();
  const childIndex = new Map();
  summaries.forEach((summary) => {
    if (!summary.id) return;
    byId.set(summary.id, { ...(byId.get(summary.id) || {}), ...summary });
  });
  byId.forEach((summary) => {
    summary.aliases.forEach((alias) => byAlias.set(alias, summary));
    byAlias.set(summary.id, summary);
  });
  byId.forEach((summary) => {
    summary.parents.forEach((parentRef) => {
      const parent = byAlias.get(parentRef);
      const key = parent?.id || parentRef;
      if (!childIndex.has(key)) childIndex.set(key, []);
      if (!childIndex.get(key).some((item) => item.id === summary.id)) childIndex.get(key).push(summary);
    });
    summary.children.forEach((childRef) => {
      const child = byAlias.get(childRef);
      if (!child) return;
      if (!childIndex.has(summary.id)) childIndex.set(summary.id, []);
      if (!childIndex.get(summary.id).some((item) => item.id === child.id)) childIndex.get(summary.id).push(child);
    });
  });
  return { byAlias, byId, childIndex };
}

function lineageKnownParents(summary, index) {
  return summary.parents.map((parentRef) => index.byAlias.get(parentRef) || {
    id: parentRef,
    aliases: [parentRef],
    title: displayNameFromPath(parentRef),
    operation: "source",
    parents: [],
    children: [summary.id],
    prompt: "",
    model: "-",
    provider: "-",
    seed: "-",
    lora: [],
  });
}

function lineageRoots(summary, index, seen = new Set()) {
  if (!summary || seen.has(summary.id)) return [];
  seen.add(summary.id);
  const parents = lineageKnownParents(summary, index);
  if (!parents.length) return [summary];
  const roots = parents.flatMap((parent) => lineageRoots(parent, index, new Set(seen)));
  return roots.length ? roots : parents;
}

function lineageChildren(summary, index) {
  const children = index.childIndex.get(summary.id) || [];
  return children.sort((a, b) => String(a.createdAt || "").localeCompare(String(b.createdAt || "")));
}

function lineageFact(label, value) {
  if (value === null || value === undefined || value === "" || (Array.isArray(value) && !value.length)) return "";
  return `<span><strong>${escapeHtml(label)}</strong>${escapeHtml(Array.isArray(value) ? value.join(", ") : value)}</span>`;
}

function lineageValueText(value) {
  if (value === null || value === undefined || value === "") return "";
  if (Array.isArray(value)) return value.length ? value.map((item) => typeof item === "object" ? JSON.stringify(item) : String(item)).join(", ") : "";
  if (typeof value === "object") return Object.keys(value).length ? JSON.stringify(value, null, 2) : "";
  return String(value);
}

function lineageDetailRow(label, value) {
  const text = lineageValueText(value);
  if (!text) return "";
  return `<div class="lineage-detail-row"><span>${escapeHtml(label)}</span><code>${escapeHtml(text)}</code></div>`;
}

function lineagePanel(title, rows) {
  const content = rows.filter(Boolean).join("");
  if (!content) return "";
  return `<section class="lineage-panel"><strong>${escapeHtml(title)}</strong>${content}</section>`;
}

function lineageLoraNames(value) {
  if (!Array.isArray(value)) return [];
  return value
    .map((item) => typeof item === "string" ? item : item?.path)
    .filter(Boolean)
    .map(displayNameFromPath);
}

function lineageNodeMarkup(summary, index, selectedId, seen = new Set(), depth = 0) {
  if (!summary || seen.has(summary.id) || depth > 7) return "";
  const nextSeen = new Set(seen);
  nextSeen.add(summary.id);
  const children = lineageChildren(summary, index);
  const current = summary.id === selectedId;
  const loraNames = lineageLoraNames(summary.lora);
  return `
    <li class="${current ? "current" : ""}">
      <div class="lineage-node-card">
        <span class="lineage-op">${escapeHtml(summary.operation || "source")}</span>
        <strong>${escapeHtml(summary.title || summary.id)}</strong>
        <div class="lineage-node-facts">
          ${lineageFact("seed", summary.seed)}
          ${lineageFact("model", summary.model)}
          ${lineageFact("source", summary.sourceType)}
          ${lineageFact("lora", loraNames)}
          ${lineageFact("latent", summary.latentFingerprint)}
        </div>
      </div>
      ${children.length ? `<ul>${children.map((child) => lineageNodeMarkup(child, index, selectedId, nextSeen, depth + 1)).join("")}</ul>` : ""}
    </li>
  `;
}

function lineageRegionText(region) {
  if (!region) return "";
  const start = Number(region.start_sec ?? region.startSec);
  const end = Number(region.end_sec ?? region.endSec);
  const type = region.region_type || region.regionType || region.purpose || "region";
  const intent = region.intent ? `: ${region.intent}` : "";
  if (Number.isFinite(start) && Number.isFinite(end)) return `${type}${intent} ${start.toFixed(2)}s-${end.toFixed(2)}s`;
  return `${type}${intent}` || region.id || "region";
}

function renderLineageModal(summary, index) {
  const title = $("lineageTitle");
  const meta = $("lineageMeta");
  const body = $("lineageBody");
  if (title) title.textContent = summary.title || "Sound lineage";
  const descendants = lineageChildren(summary, index);
  if (meta) meta.textContent = `${summary.parents.length} parent${summary.parents.length === 1 ? "" : "s"} · ${descendants.length} child${descendants.length === 1 ? "" : "ren"}`;
  if (!body) return;
  const roots = lineageRoots(summary, index);
  const branch = summary.parentBranch;
  const branchText = branch?.label || branch?.node_id || "";
  const loraNames = lineageLoraNames(summary.lora);
  const params = summary.operationParams || {};
  const detailPanels = [
    lineagePanel("Relations", [
      lineageDetailRow("parents", summary.parents),
      lineageDetailRow("children", summary.children),
      lineageDetailRow("parent branch", summary.parentBranch),
    ]),
    lineagePanel("Latents", [
      lineageDetailRow("fingerprint", summary.latentFingerprint),
      lineageDetailRow("file", summary.latentFile),
      lineageDetailRow("metadata", summary.latents),
    ]),
    lineagePanel("Source", [
      lineageDetailRow("type", summary.sourceType),
      lineageDetailRow("audio", summary.audioFile),
      lineageDetailRow("metadata", summary.metadataFile),
      lineageDetailRow("source", summary.source),
    ]),
    lineagePanel("Operation Params", [
      lineageDetailRow("params", params),
      lineageDetailRow("tags", summary.tags),
      lineageDetailRow("notes", summary.notes),
    ]),
  ].filter(Boolean).join("");
  body.className = "lineage-body";
  body.innerHTML = `
    <section class="lineage-summary">
      <div>
        <span class="eyebrow">Current sound</span>
        <strong>${escapeHtml(summary.title)}</strong>
        <p>${escapeHtml(summary.prompt || "No prompt stored.")}</p>
      </div>
      <div class="lineage-facts">
        ${lineageFact("operation", summary.operation)}
        ${lineageFact("source", summary.sourceType)}
        ${lineageFact("seed", summary.seed)}
        ${lineageFact("model", summary.model)}
        ${lineageFact("provider", summary.provider)}
        ${lineageFact("runtime", summary.runtime)}
        ${lineageFact("duration", summary.duration ? `${Number(summary.duration).toFixed(2)}s` : "")}
        ${lineageFact("region", lineageRegionText(summary.region))}
        ${lineageFact("branch", branchText)}
        ${lineageFact("lora", loraNames)}
        ${lineageFact("latent", summary.latentFingerprint)}
        ${lineageFact("noise", params.init_noise_level)}
      </div>
    </section>
    <section class="lineage-detail-grid">
      ${detailPanels || `<section class="lineage-panel"><strong>Metadata</strong><p>No extended metadata stored for this sound.</p></section>`}
    </section>
    <section class="lineage-graph" aria-label="Genealogy graph">
      <ul>
        ${roots.map((root) => lineageNodeMarkup(root, index, summary.id)).join("")}
      </ul>
    </section>
  `;
}

async function openPetriLineage(metadataPath = "", audioPath = "") {
  const item = libraryItemForReference(metadataPath, audioPath);
  const ref = await libraryItemByReference(metadataPath, audioPath);
  const metadata = ref?.metadata || {};
  const summary = lineageDataFrom(item || { audio_file: audioPath, metadata_file: metadataPath }, metadata);
  const index = buildLineageIndex(summary);
  renderLineageModal(summary, index);
  openCanvasModal("lineageModal");
}

async function copyText(value) {
  if (!value) return false;
  try {
    if (navigator.clipboard?.writeText && window.isSecureContext) {
      await navigator.clipboard.writeText(value);
      return true;
    }
  } catch {
    // Fall through to the legacy copy path when browser permissions block Clipboard API.
  }

  const textarea = document.createElement("textarea");
  textarea.value = value;
  textarea.setAttribute("readonly", "");
  textarea.style.position = "fixed";
  textarea.style.left = "-9999px";
  textarea.style.top = "0";
  document.body.appendChild(textarea);
  textarea.select();
  let copied = false;
  try {
    copied = document.execCommand("copy");
  } finally {
    textarea.remove();
  }
  if (!copied) showJson($("statusJson"), { copy: "manual", value });
  return copied;
}

async function revealAudio() {
  const path = $("audioPath").value;
  if (!path) return;
  await api("/files/reveal", {
    method: "POST",
    body: JSON.stringify({ path }),
  });
}

function useSelectedAsSource() {
  const selected = layers.find((layer) => layer.id === selectedLayerId);
  if (!selected?.audioPath) return;
  canvasAddAudioReference({
    audioPath: selected.audioPath,
    metadataPath: selected.metadataPath || "",
    metadata: selected.metadata || {},
    origin: "library",
    label: displayNameFromPath(selected.audioPath),
  }, canvasBoardDefaultPoint());
  activateTab("chamber");
  setState("Source Added", "ok", selected.audioPath);
}

function bind(id, event, handler) {
  const element = $(id);
  if (!element) return;
  element.addEventListener(event, async () => {
    try {
      await handler();
    } catch (error) {
      finishWork("Error", "bad", error.message);
      showJson($("statusJson"), { error: error.message });
    }
  });
}

function closeFloatingPanel() {
  activeCanvasSurface = "chamber";
  document.querySelectorAll(".tab-panel:not(.canvas-panel)").forEach((item) => item.classList.remove("active"));
  $("tab-onebit")?.classList.remove("active");
  $("tab-chamber")?.classList.add("active");
  document.querySelectorAll(".nav-item").forEach((item) => item.classList.toggle("active", item.dataset.tab === "chamber"));
  document.body.classList.remove("petri-panel-active");
  document.body.classList.remove("onebit-active");
  oneBitDish?.exit();
  requestAnimationFrame(() => {
    renderCanvas();
    drawCanvasWaveforms();
  });
}

function setHelpMode(enabled) {
  helpModeEnabled = Boolean(enabled);
  document.body.classList.toggle("help-mode-off", !helpModeEnabled);
  document.body.classList.toggle("help-mode-on", helpModeEnabled);
  localStorage.setItem("germinator-help-mode", helpModeEnabled ? "on" : "off");
  const button = $("helpModeToggle");
  if (button) {
    button.classList.toggle("active", helpModeEnabled);
    button.setAttribute("aria-pressed", String(helpModeEnabled));
    button.title = helpModeEnabled ? "Help mode on" : "Help mode off";
  }
}

function toggleHelpMode() {
  setHelpMode(!helpModeEnabled);
}

function positionSettingsMenu() {
  const menu = $("topbarSettingsMenu");
  const button = $("transportSettingsBtn");
  const head = menu?.closest(".canvas-head");
  if (!menu || !button || !head || menu.hidden) return;
  const buttonRect = button.getBoundingClientRect();
  const statusRect = document.querySelector(".transport-status-strip")?.getBoundingClientRect();
  const margin = 12;
  const gap = 8;
  const menuWidth = Math.min(menu.offsetWidth || 280, window.innerWidth - margin * 2);
  const left = Math.min(window.innerWidth - menuWidth - margin, Math.max(margin, buttonRect.right - menuWidth));
  const anchorTop = statusRect?.top ?? buttonRect.top;
  const bottom = Math.max(margin, window.innerHeight - anchorTop + gap);
  head.style.left = `${left}px`;
  head.style.right = "auto";
  head.style.top = "auto";
  head.style.bottom = `${bottom}px`;
  head.style.transform = "none";
}

function setSettingsMenuOpen(open) {
  const menu = $("topbarSettingsMenu");
  const button = $("transportSettingsBtn");
  const head = menu?.closest(".canvas-head");
  if (!menu) return;
  menu.hidden = !open;
  document.body.classList.toggle("settings-menu-open", Boolean(open));
  if (button) {
    button.classList.toggle("active", Boolean(open));
    button.setAttribute("aria-expanded", String(Boolean(open)));
  }
  if (open) {
    setCanvasToolsMenuOpen(false);
    positionSettingsMenu();
  } else if (head) {
    head.removeAttribute("style");
  }
}

function toggleSettingsMenu() {
  const menu = $("topbarSettingsMenu");
  setSettingsMenuOpen(Boolean(menu?.hidden));
}

function handleCanvasModulatorControl(event) {
  const setting = event.target.closest?.(".modulator-setting[data-node-id][data-field]");
  if (setting) {
    const node = canvasNodes.find((item) => item.id === setting.dataset.nodeId);
    if (node?.type !== "modulator") return true;
    const normalized = normalizeModulatorNode(node);
    const field = setting.dataset.field;
    const numericFields = new Set(["intensity", "conservation", "contamination", "seed", "min", "max", "rateHz", "phase", "smooth", "chance", "attack", "decay", "sustain", "release", "cycleSeconds", "durationSec", "gestureValue", "amount", "morph", "drift", "sensitivity"]);
    if (field === "sync" || field === "loop") normalized.config[field] = Boolean(setting.checked);
    else normalized.config[field] = numericFields.has(field) ? Number(setting.value) : setting.value;
    if (normalized.modulatorType === "gesture_recorder" && field === "gestureValue" && normalized.config.recording) {
      const started = Number(normalized.config.recordingStartedAt || Date.now());
      const durationMs = Math.max(250, Number(normalized.config.durationSec || 4) * 1000);
      const t = Math.min(1, Math.max(0, (Date.now() - started) / durationMs));
      normalized.config.points = [
        ...(normalized.config.points || []),
        { t: Number(t.toFixed(3)), value: Math.min(1, Math.max(0, Number(setting.value) || 0)) },
      ].slice(-48);
    }
    canvasNodes[canvasNodes.findIndex((item) => item.id === node.id)] = normalized;
    selectedCanvasNodeId = node.id;
    canvasSaveState();
    if (event.type === "input" && (setting.tagName === "TEXTAREA" || setting.type === "text" || field === "gestureValue")) updateCanvasInspector();
    else renderCanvas();
    return true;
  }
  const matrixTarget = event.target.closest?.(".modulator-matrix-target[data-node-id][data-route-id]");
  if (matrixTarget) {
    const node = canvasNodes.find((item) => item.id === matrixTarget.dataset.nodeId);
    const normalized = normalizeModulatorNode(node);
    const route = (normalized.config?.matrixRoutes || []).find((item) => item.id === matrixTarget.dataset.routeId);
    if (!route) return true;
    const [targetNodeId, targetPath] = String(matrixTarget.value || "").split("|");
    route.targetNodeId = targetNodeId || "";
    route.targetPath = targetPath || "";
    const target = modulationTargetForRoute(route);
    if (target) route.config = { ...(route.config || {}), ...modulationDefaultRangeFor(route.sourceType || "lfo_modulator", target) };
    canvasNodes[canvasNodes.findIndex((item) => item.id === normalized.id)] = normalized;
    selectedCanvasNodeId = normalized.id;
    canvasSaveState();
    renderCanvas();
    return true;
  }
  const matrixSetting = event.target.closest?.(".modulator-matrix-setting[data-node-id][data-route-id][data-field]");
  if (matrixSetting) {
    const node = canvasNodes.find((item) => item.id === matrixSetting.dataset.nodeId);
    const normalized = normalizeModulatorNode(node);
    const route = (normalized.config?.matrixRoutes || []).find((item) => item.id === matrixSetting.dataset.routeId);
    if (!route) return true;
    const field = matrixSetting.dataset.field;
    if (field === "enabled") route.enabled = Boolean(matrixSetting.checked);
    else if (field === "amount") route.amount = Math.min(1, Math.max(0, Number(matrixSetting.value) || 0));
    else route[field] = matrixSetting.value;
    canvasNodes[canvasNodes.findIndex((item) => item.id === normalized.id)] = normalized;
    selectedCanvasNodeId = normalized.id;
    canvasSaveState();
    if (event.type === "input" && field === "amount") updateCanvasInspector();
    else renderCanvas();
    return true;
  }
  const routeTarget = event.target.closest?.(".modulator-route-target[data-node-id][data-route-id]");
  if (routeTarget) {
    const node = canvasNodes.find((item) => item.id === routeTarget.dataset.nodeId);
    const normalized = normalizeModulatorNode(node);
    const route = canvasModulatorRouteById(normalized, routeTarget.dataset.routeId);
    if (!route) return true;
    const [targetNodeId, targetPath] = String(routeTarget.value || "").split("|");
    route.targetNodeId = targetNodeId || "";
    route.targetPath = targetPath || "";
    const target = modulationTargetForRoute(route);
    if (!PROMPT_MODULATOR_TYPES.has(normalized.modulatorType) && target) {
      const range = modulationDefaultRangeFor(normalized.modulatorType, target);
      route.config = {
        ...route.config,
        min: range.min,
        max: range.max,
      };
    }
    canvasNodes[canvasNodes.findIndex((item) => item.id === normalized.id)] = normalized;
    selectedCanvasNodeId = normalized.id;
    canvasSaveState();
    renderCanvas();
    return true;
  }
  const routeSetting = event.target.closest?.(".modulator-route-setting[data-node-id][data-route-id][data-field]");
  if (routeSetting) {
    const node = canvasNodes.find((item) => item.id === routeSetting.dataset.nodeId);
    const normalized = normalizeModulatorNode(node);
    const route = canvasModulatorRouteById(normalized, routeSetting.dataset.routeId);
    if (!route) return true;
    const field = routeSetting.dataset.field;
    if (field === "enabled") route.enabled = Boolean(routeSetting.checked);
    else if (field === "mode") route.mode = routeSetting.value;
    else if (["min", "max", "seed"].includes(field)) route.config[field] = Number(routeSetting.value);
    else route.config[field] = routeSetting.value;
    canvasNodes[canvasNodes.findIndex((item) => item.id === normalized.id)] = normalized;
    selectedCanvasNodeId = normalized.id;
    canvasSaveState();
    if (event.type === "input" && routeSetting.type === "text") updateCanvasInspector();
    else renderCanvas();
    return true;
  }
  return false;
}

function handleCanvasGeneticControl(event) {
  const setting = event.target.closest?.(".genetic-node-setting[data-node-id][data-field]");
  if (setting) {
    const node = canvasNodes.find((item) => item.id === setting.dataset.nodeId);
    if (node?.type !== "genetic") return true;
    const normalized = normalizeGeneticNode(node);
    const field = setting.dataset.field;
    if (field === "strength") {
      normalized.strength = Math.min(1, Math.max(0, Number(setting.value) || 0));
      normalized.identity = null;
      normalized.confidence = 0;
    } else if (field === "trait") {
      normalized.trait = normalizeGeneticTrait(setting.value);
      normalized.identity = null;
      normalized.confidence = 0;
    } else if (field === "mode") {
      normalized.mode = Object.prototype.hasOwnProperty.call(GENETIC_SEQUENCER_MODES, setting.value) ? setting.value : "seed_garden";
    } else if (field === "identityMode") {
      normalized.identityMode = ["incoming", "source", "hybrid"].includes(setting.value) ? setting.value : "incoming";
    }
    canvasNodes[canvasNodes.findIndex((item) => item.id === node.id)] = normalizeGeneticNode(normalized);
    selectedCanvasNodeId = node.id;
    canvasSaveState();
    renderCanvas();
    return true;
  }
  const stepSetting = event.target.closest?.(".genetic-step-setting[data-node-id][data-step-index][data-field]");
  if (stepSetting) {
    const node = canvasNodes.find((item) => item.id === stepSetting.dataset.nodeId);
    if (node?.type !== "genetic" || node.geneticType !== "generation_sequencer") return true;
    const normalized = normalizeGeneticNode(node);
    const index = Math.min((normalized.steps || []).length - 1, Math.max(0, Number(stepSetting.dataset.stepIndex) || 0));
    const step = normalized.steps?.[index];
    if (step) {
      if (stepSetting.dataset.field === "probability") {
        step.probability = Math.min(1, Math.max(0, Number(stepSetting.value) || 0));
      } else if (stepSetting.dataset.field === "action") {
        step.action = Object.prototype.hasOwnProperty.call(GENETIC_SEQUENCER_ACTIONS, stepSetting.value)
          ? stepSetting.value
          : step.action;
      }
      normalized.selectedStep = index;
      canvasNodes[canvasNodes.findIndex((item) => item.id === node.id)] = normalizeGeneticNode(normalized);
      selectedCanvasNodeId = normalized.id;
      canvasSaveState();
      renderCanvas();
    }
    return true;
  }
  return false;
}

function handleAudioSnapshotControl(event) {
  const setting = event.target.closest?.(".audio-snapshot-setting[data-node-id][data-field]");
  if (!setting) return false;
  const node = canvasNodes.find((item) => item.id === setting.dataset.nodeId);
  if (node?.type !== "audio_snapshot") return true;
  const field = setting.dataset.field;
  if (field === "autoTrim") node[field] = Boolean(setting.checked);
  else node[field] = Number(setting.value) || 0;
  selectedCanvasNodeId = node.id;
  canvasSaveState();
  updateCanvasInspector();
  return true;
}

function renderCanvasToolsMenuState() {
  const menu = $("canvasToolsMenu");
  if (!menu) return;
  const hasSound = Boolean(canvasSelectedNode()?.type === "sound" && canvasSelectedAsset()?.audioPath);
  menu.querySelectorAll("button[data-tool], button[data-action='canvas-audio-time-pitch']").forEach((button) => {
    button.disabled = !hasSound;
    button.title = hasSound ? "" : "Select a saved sound module first.";
  });
}

function positionCanvasToolsMenu(anchor = canvasToolsAnchor) {
  const menu = $("canvasToolsMenu");
  const button = anchor || $("canvasToolsMenuBtn");
  if (!menu || !button || menu.hidden) return;
  const buttonRect = button.getBoundingClientRect();
  const margin = 12;
  const gap = 8;
  const menuWidth = Math.min(menu.offsetWidth || 218, window.innerWidth - margin * 2);
  const menuHeight = Math.min(menu.offsetHeight || 420, window.innerHeight - margin * 2);
  const left = Math.min(window.innerWidth - menuWidth - margin, Math.max(margin, buttonRect.right - menuWidth));
  const desiredBottom = anchor
    ? Math.max(margin, window.innerHeight - buttonRect.bottom + gap)
    : Math.max(margin, window.innerHeight - buttonRect.top + gap);
  const bottom = Math.max(margin, Math.min(desiredBottom, window.innerHeight - menuHeight - margin));
  menu.style.left = `${left}px`;
  menu.style.right = "auto";
  menu.style.top = "auto";
  menu.style.bottom = `${bottom}px`;
}

function setCanvasToolsMenuOpen(open, anchor = null) {
  const menu = $("canvasToolsMenu");
  const button = $("canvasToolsMenuBtn");
  if (!menu) return;
  canvasToolsAnchor = open ? anchor : null;
  menu.hidden = !open;
  if (button) {
    button.classList.toggle("active", Boolean(open));
    button.setAttribute("aria-expanded", String(Boolean(open)));
  }
  if (open) {
    setSettingsMenuOpen(false);
    renderCanvasToolsMenuState();
    positionCanvasToolsMenu(anchor);
  } else {
    menu.removeAttribute("style");
  }
}

function toggleCanvasToolsMenu() {
  const menu = $("canvasToolsMenu");
  setCanvasToolsMenuOpen(Boolean(menu?.hidden));
}

function setRightSidebarCollapsed(collapsed) {
  document.body.classList.toggle("right-sidebar-collapsed", Boolean(collapsed));
  const button = $("rightSidebarToggle");
  if (button) {
    button.setAttribute("aria-expanded", String(!collapsed));
    button.title = collapsed ? "Expand controls" : "Collapse controls";
  }
}

function bindModuleHelp(rootId, hintId, fallbackText) {
  const root = $(rootId);
  const hint = $(hintId);
  if (!root || !hint) return;
  const setText = (text) => {
    if (!helpModeEnabled) return;
    hint.textContent = text || fallbackText;
  };
  root.addEventListener("mouseover", (event) => {
    const target = event.target.closest?.("[data-help]");
    if (target && root.contains(target)) setText(target.dataset.help);
  });
  root.addEventListener("focusin", (event) => {
    const target = event.target.closest?.("[data-help]");
    if (target && root.contains(target)) setText(target.dataset.help);
  });
  root.addEventListener("mouseout", (event) => {
    if (!root.contains(event.relatedTarget)) setText(fallbackText);
  });
  root.addEventListener("focusout", (event) => {
    if (!root.contains(event.relatedTarget)) setText(fallbackText);
  });
}

function normalizeTabName(tabName) {
  if (!tabName || tabName === "home") return "chamber";
  if (tabName === "canvas") return "chamber";
  if (tabName === "herbarium") return "petri";
  if (tabName === "lora") return "thermostat";
  if (tabName === "microcosmos" || tabName === "scope") return "onebit";
  if (["seeds", "mutations", "pruning", "propagation", "strains", "variations", "lab"].includes(tabName)) return "chamber";
  return tabName;
}

function activateTab(tabName) {
  const normalizedTab = normalizeTabName(tabName);
  const panel = $(`tab-${normalizedTab}`);
  if (!panel) return;
  closeCanvasSourceMenu();
  closeCanvasConnectMenu();
  const isOnebit = normalizedTab === "onebit";
  const isCanvasSurface = normalizedTab === "chamber" || isOnebit;
  activeCanvasSurface = isOnebit ? "onebit" : "chamber";
  document.querySelectorAll(".nav-item").forEach((item) => item.classList.toggle("active", item.dataset.tab === normalizedTab));
  document.querySelectorAll(".tab-panel:not(.canvas-panel)").forEach((item) => item.classList.remove("active"));
  $("tab-chamber")?.classList.toggle("active", !isOnebit);
  $("tab-onebit")?.classList.toggle("active", isOnebit);
  if (!isCanvasSurface) panel.classList.add("active");
  document.body.classList.add("canvas-active");
  document.body.classList.toggle("onebit-active", isOnebit);
  document.body.classList.toggle("petri-panel-active", normalizedTab === "petri");
  requestAnimationFrame(() => {
    renderCanvas();
    drawCanvasWaveforms();
  });
  if (normalizedTab === "petri") {
    renderHerbarium();
    requestAnimationFrame(() => renderPetriCanvases());
  }
  if (normalizedTab === "rack") renderRack();
  if (normalizedTab === "controllers") {
    renderControlPanel();
    refreshControlLayer({ render: true }).catch((error) => finishWork("Control Error", "bad", error.message));
  }
  if (normalizedTab === "thermostat") {
    refreshStrains({ render: true }).catch((error) => finishWork("Strain Error", "bad", error.message));
  }
  if (normalizedTab === "micro") renderMicroMatterProfile();
  if (isOnebit) oneBitDish?.enter();
  else oneBitDish?.exit();
}

document.querySelectorAll(".nav-item").forEach((tab) => {
  tab.addEventListener("click", () => {
    const normalizedTab = normalizeTabName(tab.dataset.tab);
    const inSettingsMenu = tab.closest("#topbarSettingsMenu");
    if (inSettingsMenu) setSettingsMenuOpen(false);
    if (normalizedTab === "chamber") {
      closeFloatingPanel();
      return;
    }
    if (normalizedTab === "onebit") {
      activateTab("onebit");
      return;
    }
    const panel = $(`tab-${normalizedTab}`);
    if (panel?.classList.contains("active")) {
      closeFloatingPanel();
      return;
    }
    activateTab(normalizedTab);
  });
});

// 3-card Petri picker: search toggle + live filter
(() => {
  const toggle = document.getElementById("canvasLibrarySearchToggle");
  const input = document.getElementById("canvasLibrarySearch");
  if (!toggle || !input) return;
  toggle.addEventListener("click", () => {
    if (input.hidden) {
      input.hidden = false;
      requestAnimationFrame(() => input.focus());
    } else {
      input.hidden = true;
      input.value = "";
      canvasLibrarySearchQuery = "";
      canvasLibraryPage = 0;
      renderCanvasLibraryList();
    }
  });
  input.addEventListener("input", () => {
    canvasLibrarySearchQuery = input.value || "";
    canvasLibraryPage = 0;
    renderCanvasLibraryList();
  });
  input.addEventListener("keydown", (event) => {
    if (event.key === "Escape") {
      toggle.click();
    }
  });
})();

document.addEventListener("click", async (event) => {
  if (event.target.classList?.contains("canvas-modal")) {
    closeCanvasModal(event.target.id);
    return;
  }
  if (event.target.classList?.contains("snapshot-library-overlay")) {
    closeSnapshotLibrary();
    return;
  }
  const button = event.target.closest("[data-action]");
  if (!button) return;
  const action = button.dataset.action;
  const layerId = button.dataset.layerId;
  try {
    if (action === "floating-panel-close") {
      closeFloatingPanel();
      return;
    }
    if (action === "close-snapshot-library") {
      closeSnapshotLibrary();
      return;
    }
    if (action === "snapshot-load") {
      loadSnapshot(button.dataset.snapshotId);
      return;
    }
    if (action === "snapshot-rename") {
      renameSnapshot(button.dataset.snapshotId);
      return;
    }
    if (action === "snapshot-delete") {
      deleteSnapshot(button.dataset.snapshotId);
      return;
    }
    if (action === "snapshot-toggle-fav") {
      toggleSnapshotFavorite(button.dataset.snapshotId);
      return;
    }
    if (action === "session-save-as") {
      await canvasSaveSessionAs();
      return;
    }
    if (action === "session-load") {
      await canvasLoadSession(button.dataset.sessionId);
      return;
    }
    if (action === "session-delete") {
      await canvasDeleteSession(button.dataset.sessionId);
      return;
    }
    if (action === "session-refresh") {
      await refreshCanvasSessions();
      setState("Sessions Refreshed", "ok", `${canvasSessions.length} saved`);
      return;
    }
    if (action.startsWith("strain-")) {
      if (action === "strain-refresh") {
        await refreshStrains({ render: true });
        setState("Strains Refreshed", "ok", `${strainRegistry.length} saved`);
        return;
      }
      if (action === "strain-save") {
        await saveStrainFromPanel();
        return;
      }
      if (action === "strain-use") {
        useStrainInStack(button.dataset.strainId || "");
        return;
      }
      if (action === "strain-load") {
        await loadStrainFromRegistry(button.dataset.strainId || "");
        return;
      }
      if (action === "strain-delete") {
        await deleteStrainFromRegistry(button.dataset.strainId || "");
        return;
      }
    }
    if (action.startsWith("micro-")) {
      if (action === "micro-profile-selected") {
        await profileSelectedAsMicroMatter();
        return;
      }
    }
    if (action.startsWith("control-")) {
      if (action === "control-tab") {
        controlSetTab(button.dataset.controlTab || "routing");
        return;
      }
      if (action === "control-refresh") {
        await refreshControlLayer({ render: true });
        setState("Controllers Refreshed", "ok", `${controlState.routes.length} route(s)`);
        return;
      }
      if (action === "control-save-route") {
        await saveControlRouteFromPanel();
        return;
      }
      if (action === "control-toggle-route") {
        await toggleControlRoute(button.dataset.routeId, button.dataset.enabled === "true");
        return;
      }
      if (action === "control-snapshot") {
        await postControlSnapshot();
        return;
      }
      if (action === "control-panic") {
        await panicControlLayer();
        return;
      }
      if (action === "control-analyze-selected") {
        await analyzeSelectedAsControl();
        return;
      }
      if (action === "control-render-cv") {
        await renderControlCv();
        return;
      }
      if (action === "control-midi-scan") {
        await scanMidiDevices();
        return;
      }
      if (action === "control-midi-send") {
        await sendMidiMessage();
        return;
      }
      if (action === "control-osc-send") {
        await sendOscMessage();
        return;
      }
      if (action === "control-osc-receive") {
        await receiveOscMessage();
        return;
      }
      if (action === "control-norns-send") {
        await sendNornsBridge(false);
        return;
      }
      if (action === "control-norns-spawn") {
        await sendNornsBridge(true);
        return;
      }
      if (action === "control-cv-save-profile") {
        await saveCvProfile();
        return;
      }
      if (action === "control-cv-arm") {
        await armCvProfile(button.dataset.profileId, button.dataset.armed === "true");
        return;
      }
    }
    if (action.startsWith("canvas-")) {
      if (action === "canvas-open-source-menu") {
        openCanvasSourceMenu();
      }
      if (action === "canvas-io-port") {
        event.stopPropagation();
        openCanvasConnectMenu(button.dataset.nodeId, button.dataset.port || "output", button);
        return;
      }
      if (action === "canvas-connect-choice") {
        await runCanvasConnectChoice(button);
        return;
      }
      if (action === "canvas-source-tab") {
        canvasSetSourceMenuTab(button.dataset.tab || "core");
        return;
      }
      if (action === "canvas-source-toggle-view") {
        canvasToggleSourceMenuView();
        return;
      }
      if (action === "canvas-node-tab") {
        const node = canvasNodes.find((item) => item.id === button.dataset.nodeId);
        if (node) {
          node.activePanel = button.dataset.panel || "main";
          selectedCanvasNodeId = node.id;
          canvasSaveState();
          renderCanvas();
        }
        return;
      }
      if (action === "canvas-toggle-node-mod") {
        const node = canvasNodes.find((item) => item.id === button.dataset.nodeId);
        if (node) {
          node.activePanel = node.activePanel === "mod" ? "wave" : "mod";
          selectedCanvasNodeId = node.id;
          canvasSaveState();
          renderCanvas();
        }
        return;
      }
      if (action === "canvas-quick-mod") {
        canvasCreateQuickMod(button.dataset.nodeId, button.dataset.modulator || "macro_modulator", button.dataset.targetPath || "");
        return;
      }
      if (action === "canvas-toggle-chain") {
        canvasToggleChain(button.dataset.nodeId);
      }
      if (action === "canvas-toggle-group-selection") {
        const nodeId = button.dataset.nodeId;
        if (canvasGroupSelection.has(nodeId)) canvasGroupSelection.delete(nodeId);
        else canvasGroupSelection.add(nodeId);
        updateCanvasMixerButton();
        renderCanvas();
        setState("Group Selection", "muted", `${canvasGroupSelection.size} selected`);
      }
      if (action === "canvas-fx-mode") {
        const node = canvasNodes.find((item) => item.id === button.dataset.nodeId);
        if (node?.type === "fx") {
          node.params = { ...(node.params || {}), mode: button.dataset.mode };
          applyFxNodeToTarget(node);
          selectedCanvasNodeId = node.id;
          canvasSaveState();
          renderCanvas();
        }
      }
      if (action === "canvas-fx-render-pitch") {
        await canvasRenderPitchFx(button.dataset.nodeId);
      }
      if (action === "canvas-fx-loop-doctor") {
        await canvasRenderLoopDoctorFx(button.dataset.nodeId);
      }
      if (action === "canvas-mixer-toggle") {
        const target = canvasNodes.find((item) => item.id === button.dataset.targetNodeId);
        if (target?.type === "sound") {
          target[button.dataset.toggle] = !target[button.dataset.toggle];
          applyMixerSoloMute();
          renderCanvas();
        }
      }
      if (action === "canvas-source-option") {
        const source = button.dataset.source;
        const point = canvasSourcePosition();
        if (source === "prompt") {
          canvasCreatePromptNode({ x: point.x, y: point.y });
          closeCanvasSourceMenu();
        }
        if (source === "germ") {
          closeCanvasSourceMenu();
          canvasCreateGermNode({ x: point.x, y: point.y });
          setState("Germ Created", "ok", "Prompt-grown wavetable organism.");
        }
        if (source === "wavetable_forge") {
          closeCanvasSourceMenu();
          canvasCreateWavetableForgeNode({ x: point.x, y: point.y });
          setState("Wavetable Forge", "ok", "Utility module ready.");
        }
        if (source === "upload") {
          closeCanvasSourceMenu({ keepPosition: true });
          $("canvasUploadInput")?.click();
        }
        if (source === "petri") {
          closeCanvasSourceMenu();
          canvasPendingSourcePosition = canvasPendingSourcePosition || point;
          canvasLibraryPage = 0;
          openCanvasLibraryModal();
        }
        if (source === "candidate_ecology") {
          closeCanvasSourceMenu();
          renderCanvasCandidates();
          openCanvasModal("canvasCandidateModal");
        }
        if (source === "hardware") {
          closeCanvasSourceMenu();
          canvasCreateRecordNode({ x: point.x, y: point.y });
          setState("Source Created", "ok", "Use REC to capture audio into this module.");
        }
        if (source === "audio_snapshot") {
          closeCanvasSourceMenu();
          canvasCreateAudioSnapshotNode({ x: point.x, y: point.y });
          setState("Audio Snapshot", "ok", "Capture computer audio into a source germ.");
        }
        if (source === "image") {
          canvasPendingImagePosition = { ...point };
          canvasPendingImageMode = "vision";
          closeCanvasSourceMenu({ keepPosition: true });
          $("canvasImageInput")?.click();
        }
        if (source === "fx") {
          closeCanvasSourceMenu();
          canvasCreateFxNode(button.dataset.fx || "gain", { x: point.x, y: point.y });
        }
        if (source === "loop_doctor") {
          closeCanvasSourceMenu();
          await runCanvasAudioTool("loop_doctor");
        }
        if (source === "time") {
          closeCanvasSourceMenu();
          canvasCreateTimeNode(button.dataset.time || "colony_sequencer", { x: point.x, y: point.y });
        }
        if (source === "modulator") {
          closeCanvasSourceMenu();
          canvasCreateModulatorNode(button.dataset.modulator || "prompt_modulator", { x: point.x, y: point.y });
        }
        if (source === "genetic") {
          closeCanvasSourceMenu();
          const selected = canvasSelectedNode();
          const sourceNode = selected && ["sound", "prompt", "image"].includes(selected.type) ? selected : null;
          const geneticSize = canvasGeneticNodeSize(button.dataset.genetic || "identity_extractor");
          const geneticPoint = canvasFindOpenPoint(point, geneticSize, { anchorNode: sourceNode });
          canvasCreateGeneticNode(button.dataset.genetic || "identity_extractor", {
            x: geneticPoint.x,
            y: geneticPoint.y,
            trait: button.dataset.trait || "timbre",
            sourceNode,
          });
        }
      }
      if (action === "wavetable-node-tab") {
        const node = canvasNodes.find((item) => item.id === button.dataset.nodeId);
        if (node && ["germ", "wavetable_forge"].includes(node.type)) {
          node.activePanel = button.dataset.tab || node.activePanel;
          selectedCanvasNodeId = node.id;
          renderCanvas();
        }
      }
      if (action === "refresh-wavetables") {
        await refreshWavetables({ force: true });
        renderCanvas();
        setState("Wavetables Ready", "ok", `${wavetableItems.length} table(s)`);
      }
      if (action === "wavetable-preview") await canvasPreviewWavetableNode(button.dataset.nodeId, "preview");
      if (action === "wavetable-hold") await canvasPreviewWavetableNode(button.dataset.nodeId, "hold");
      if (action === "wavetable-stop") canvasStopWavetablePreview();
      if (action === "wavetable-generate-audio") await canvasGenerateWavetableAudio(button.dataset.nodeId);
      if (action === "wavetable-prompt") await canvasPromptWavetableNode(button.dataset.nodeId);
      if (action === "wavetable-render-source") await canvasRenderWavetableNodeToSource(button.dataset.nodeId);
      if (action === "wavetable-mutate") await canvasMutateWavetableNode(button.dataset.nodeId);
      if (action === "forge-generate-table") await forgeGenerateTable(button.dataset.nodeId);
      if (action === "forge-convert-audio") await forgeConvertAudio(button.dataset.nodeId);
      if (action === "forge-mutate-table") await forgeMutateTable(button.dataset.nodeId);
      if (action === "canvas-modulator-add-route") {
        const node = canvasNodes.find((item) => item.id === button.dataset.nodeId);
        if (node?.type === "modulator") {
          const normalized = normalizeModulatorNode(node);
          if (normalized.modulatorType === "mod_matrix") {
            normalized.config.matrixRoutes = [...(normalized.config.matrixRoutes || []), modulationDefaultMatrixRoute(selectedCanvasNodeId)];
          } else {
            normalized.routes = [...(normalized.routes || []), modulationDefaultRoute(normalized.modulatorType)];
          }
          canvasNodes[canvasNodes.findIndex((item) => item.id === node.id)] = normalized;
          selectedCanvasNodeId = node.id;
          canvasSaveState();
          renderCanvas();
        }
      }
      if (action === "canvas-modulator-remove-matrix-route") {
        const node = canvasNodes.find((item) => item.id === button.dataset.nodeId);
        if (node?.type === "modulator") {
          const normalized = normalizeModulatorNode(node);
          normalized.config.matrixRoutes = (normalized.config.matrixRoutes || []).filter((route) => route.id !== button.dataset.routeId);
          if (!normalized.config.matrixRoutes.length) normalized.config.matrixRoutes = [modulationDefaultMatrixRoute(selectedCanvasNodeId)];
          canvasNodes[canvasNodes.findIndex((item) => item.id === node.id)] = normalized;
          selectedCanvasNodeId = node.id;
          canvasSaveState();
          renderCanvas();
        }
      }
      if (action === "canvas-modulator-remove-route") {
        const node = canvasNodes.find((item) => item.id === button.dataset.nodeId);
        if (node?.type === "modulator") {
          const normalized = normalizeModulatorNode(node);
          normalized.routes = normalized.routes.filter((route) => route.id !== button.dataset.routeId);
          if (!normalized.routes.length) normalized.routes = [modulationDefaultRoute(normalized.modulatorType)];
          canvasNodes[canvasNodes.findIndex((item) => item.id === node.id)] = normalized;
          selectedCanvasNodeId = node.id;
          canvasSaveState();
          renderCanvas();
        }
      }
      if (action === "canvas-modulator-apply") {
        canvasApplyPromptModulator(button.dataset.nodeId);
      }
      if (action === "canvas-gesture-record-toggle") {
        const node = canvasNodes.find((item) => item.id === button.dataset.nodeId);
        if (node?.type === "modulator" && node.modulatorType === "gesture_recorder") {
          const normalized = normalizeModulatorNode(node);
          normalized.config.recording = !normalized.config.recording;
          normalized.config.recordingStartedAt = normalized.config.recording ? Date.now() : null;
          if (normalized.config.recording) normalized.config.points = [{ t: 0, value: Number(normalized.config.gestureValue ?? 0.5) }];
          canvasNodes[canvasNodes.findIndex((item) => item.id === node.id)] = normalized;
          selectedCanvasNodeId = normalized.id;
          canvasSaveState();
          renderCanvas();
          setState(normalized.config.recording ? "Gesture Recording" : "Gesture Recorded", "ok", `${(normalized.config.points || []).length} point(s)`);
        }
      }
      if (action === "canvas-gesture-clear") {
        const node = canvasNodes.find((item) => item.id === button.dataset.nodeId);
        if (node?.type === "modulator" && node.modulatorType === "gesture_recorder") {
          const normalized = normalizeModulatorNode(node);
          normalized.config.points = [];
          normalized.config.recording = false;
          normalized.config.recordingStartedAt = null;
          canvasNodes[canvasNodes.findIndex((item) => item.id === node.id)] = normalized;
          selectedCanvasNodeId = normalized.id;
          canvasSaveState();
          renderCanvas();
        }
      }
      if (action === "canvas-genetic-extract") {
        const node = canvasNodes.find((item) => item.id === button.dataset.nodeId);
        if (node?.type === "genetic" && node.geneticType === "identity_extractor") {
          const normalized = normalizeGeneticNode(node);
          const identity = canvasBuildIdentityPayload(normalized);
          normalized.identity = identity;
          normalized.confidence = identity?.confidence ?? normalized.confidence;
          canvasNodes[canvasNodes.findIndex((item) => item.id === node.id)] = normalized;
          selectedCanvasNodeId = normalized.id;
          canvasSaveState();
          renderCanvas();
          setState("Identity Extracted", "ok", identity?.label || "Genetic identity");
        }
      }
      if (action === "canvas-genetic-route-selected") {
        const node = canvasNodes.find((item) => item.id === button.dataset.nodeId);
        if (node?.type === "genetic") canvasRouteGeneticNodeToTarget(node);
      }
      if (action === "canvas-genetic-select-step") {
        const node = canvasNodes.find((item) => item.id === button.dataset.nodeId);
        if (node?.type === "genetic" && node.geneticType === "generation_sequencer") {
          const normalized = normalizeGeneticNode(node);
          normalized.selectedStep = Math.min((normalized.steps || []).length - 1, Math.max(0, Number(button.dataset.stepIndex) || 0));
          canvasNodes[canvasNodes.findIndex((item) => item.id === node.id)] = normalized;
          selectedCanvasNodeId = normalized.id;
          canvasSaveState();
          renderCanvas();
        }
      }
      if (action === "canvas-genetic-toggle-step") {
        const node = canvasNodes.find((item) => item.id === button.dataset.nodeId);
        if (node?.type === "genetic" && node.geneticType === "generation_sequencer") {
          const normalized = normalizeGeneticNode(node);
          const step = normalized.steps?.[Number(button.dataset.stepIndex)];
          if (step) {
            step.enabled = step.enabled === false;
            canvasNodes[canvasNodes.findIndex((item) => item.id === node.id)] = normalized;
            selectedCanvasNodeId = normalized.id;
            canvasSaveState();
            renderCanvas();
          }
        }
      }
      if (action === "canvas-genetic-run-sequence") {
        await canvasRunGenerationSequencer(button.dataset.nodeId);
      }
      if (action === "time-toggle-step") {
        const node = canvasNodes.find((item) => item.id === button.dataset.nodeId);
        const lane = node?.lanes?.[Number(button.dataset.laneIndex)];
        const step = lane?.steps?.[Number(button.dataset.stepIndex)];
        if (node?.type === "time" && step) {
          step.enabled = !step.enabled;
          node.selectedStep = { lane: Number(button.dataset.laneIndex), step: Number(button.dataset.stepIndex) };
          selectedCanvasNodeId = node.id;
          renderCanvas();
        }
      }
      if (action === "time-lane-toggle") {
        const node = canvasNodes.find((item) => item.id === button.dataset.nodeId);
        const lane = node?.lanes?.[Number(button.dataset.laneIndex)];
        if (node?.type === "time" && lane) {
          lane[button.dataset.toggle] = !lane[button.dataset.toggle];
          selectedCanvasNodeId = node.id;
          renderCanvas();
        }
      }
      if (action === "time-toggle-slice") {
        const node = canvasNodes.find((item) => item.id === button.dataset.nodeId);
        const slice = node?.slices?.[Number(button.dataset.sliceIndex)];
        if (node?.type === "time" && slice) {
          slice.enabled = !slice.enabled;
          node.selectedSlice = Number(button.dataset.sliceIndex);
          selectedCanvasNodeId = node.id;
          renderCanvas();
        }
      }
      if (action === "time-slice-reverse") {
        const node = canvasNodes.find((item) => item.id === button.dataset.nodeId);
        const slice = node?.slices?.[node.selectedSlice || 0];
        if (node?.type === "time" && slice) {
          slice.reverse = !slice.reverse;
          selectedCanvasNodeId = node.id;
          renderCanvas();
        }
      }
      if (action === "time-mutate-slice") {
        selectedCanvasNodeId = button.dataset.nodeId;
        await mutateSelectedSlicerSlice(button.dataset.nodeId);
      }
      if (action === "time-toggle-melody-step") {
        const node = canvasNodes.find((item) => item.id === button.dataset.nodeId);
        const step = node?.steps?.[Number(button.dataset.stepIndex)];
        if (node?.type === "time" && step) {
          step.enabled = !step.enabled;
          node.selectedStep = Number(button.dataset.stepIndex);
          selectedCanvasNodeId = node.id;
          renderCanvas();
        }
      }
      if (action === "time-bus-toggle-target") {
        const node = canvasNodes.find((item) => item.id === button.dataset.nodeId);
        if (node?.type === "time" && node.timeType === "render_bus") {
          const ids = new Set(node.moduleIds || []);
          if (ids.has(button.dataset.targetNodeId)) ids.delete(button.dataset.targetNodeId);
          else ids.add(button.dataset.targetNodeId);
          node.moduleIds = [...ids];
          selectedCanvasNodeId = node.id;
          renderCanvas();
        }
      }
      if (action === "time-incubation-add-selected") {
        addSelectedSoundToIncubationTimeline(button.dataset.nodeId);
      }
      if (action === "time-incubation-add-event") {
        addIncubationTimelineEvent(button.dataset.nodeId);
      }
      if (action === "time-incubation-select-event") {
        const node = canvasNodes.find((item) => item.id === button.dataset.nodeId);
        if (node?.type === "time" && node.timeType === "incubation_timeline") {
          node.selectedEventId = button.dataset.eventId;
          saveIncubationTimelineNode(node);
        }
      }
      if (action === "time-incubation-toggle-reverse") {
        const node = canvasNodes.find((item) => item.id === button.dataset.nodeId);
        const eventItem = node?.timelineEvents?.find((item) => item.id === button.dataset.eventId);
        if (node?.type === "time" && eventItem) {
          eventItem.reverse = !eventItem.reverse;
          node.selectedEventId = eventItem.id;
          saveIncubationTimelineNode(node);
        }
      }
      if (action === "time-incubation-duplicate-event") {
        const node = canvasNodes.find((item) => item.id === button.dataset.nodeId);
        const eventItem = node?.timelineEvents?.find((item) => item.id === button.dataset.eventId);
        if (node?.type === "time" && eventItem) {
          const copy = {
            ...eventItem,
            id: canvasId("timeline_evt"),
            label: `${eventItem.label || "Event"} copy`,
            startBeat: Math.min(timeClockDerived().totalBeats, Number(eventItem.startBeat || 0) + Number(eventItem.durationBeats || 1)),
          };
          node.timelineEvents = [...(node.timelineEvents || []), copy];
          node.selectedEventId = copy.id;
          saveIncubationTimelineNode(node);
        }
      }
      if (action === "time-incubation-delete-event") {
        const node = canvasNodes.find((item) => item.id === button.dataset.nodeId);
        if (node?.type === "time") {
          node.timelineEvents = (node.timelineEvents || []).filter((item) => item.id !== button.dataset.eventId);
          node.selectedEventId = node.timelineEvents[0]?.id || "";
          saveIncubationTimelineNode(node);
        }
      }
      if (action === "time-incubation-remove-source") {
        const node = canvasNodes.find((item) => item.id === button.dataset.nodeId);
        if (node?.type === "time") {
          node.timelineSources = (node.timelineSources || []).filter((item) => item.id !== button.dataset.sourceId);
          node.timelineEvents = (node.timelineEvents || []).filter((item) => item.sourceId !== button.dataset.sourceId);
          node.selectedEventId = node.timelineEvents[0]?.id || "";
          saveIncubationTimelineNode(node);
        }
      }
      if (action === "time-generate-shot") {
        await generateTimeShot(button.dataset.nodeId, button.dataset.kind, Number(button.dataset.index));
      }
      if (action === "time-assign-selected") {
        assignSelectedSoundToTimeSlot(button.dataset.nodeId, button.dataset.kind, Number(button.dataset.index));
      }
      if (action === "time-render-node") {
        selectedCanvasNodeId = button.dataset.nodeId;
        await renderTimeNode(button.dataset.nodeId);
      }
      if (action === "time-fit-bars") {
        selectedCanvasNodeId = button.dataset.nodeId;
        await processClockedLooperToBars(button.dataset.nodeId);
      }
      if (action === "time-trigger-pad") {
        selectedCanvasNodeId = button.dataset.nodeId;
        await triggerTimePad(button.dataset.nodeId, Number(button.dataset.padIndex));
      }
      if (action === "time-pad-record-toggle") {
        selectedCanvasNodeId = button.dataset.nodeId;
        toggleTimePadRecording(button.dataset.nodeId);
      }
      if (action === "time-pad-clear") {
        const node = canvasNodes.find((item) => item.id === button.dataset.nodeId);
        if (node?.type === "time" && node.timeType === "trigger_pads") {
          node.recordedEvents = [];
          node.recording = false;
          node.recordStartMs = null;
          selectedCanvasNodeId = node.id;
          renderCanvas();
          setState("Pads Cleared", "ok", "Recorded pad events removed.");
        }
      }
      if (action === "canvas-add-library") {
        const item = canvasLibraryAddByIndex(Number(button.dataset.index));
        if (item) {
          const position = canvasPendingSourcePosition ? { ...canvasPendingSourcePosition } : {};
          await canvasAddLibraryItem(item, position);
        }
        closeCanvasLibraryModal();
      }
      if (action === "canvas-preview-library") {
        const item = canvasLibraryAddByIndex(Number(button.dataset.index));
        if (item?.audio_file) {
          const audio = new Audio(outputUrl(item.audio_file));
          audio.dataset.ownVolume = "1";
          audio.volume = germinatorMasterVolume();
          await audio.play();
        }
      }
      if (action === "canvas-library-prev") {
        canvasLibraryPage = Math.max(0, canvasLibraryPage - 1);
        renderCanvasLibraryList();
      }
      if (action === "canvas-library-next") {
        canvasLibraryPage += 1;
        renderCanvasLibraryList();
      }
      if (action === "canvas-close-library") {
        closeCanvasLibraryModal();
      }
      if (action === "canvas-close-modal") {
        closeCanvasModal(button.dataset.modalId);
      }
      if (action === "canvas-audio-tool") {
        setCanvasToolsMenuOpen(false);
        await runCanvasAudioTool(button.dataset.tool);
      }
      if (action === "canvas-audio-time-pitch") {
        setCanvasToolsMenuOpen(false);
        const pitchValue = window.prompt("Pitch semitones", "0");
        if (pitchValue === null) return;
        const stretchValue = window.prompt("Stretch ratio (1 keeps length)", "1");
        if (stretchValue === null) return;
        await canvasProcessSelectedTimePitch({
          pitchSemitones: Number(pitchValue) || 0,
          stretchRatio: Math.max(0.05, Number(stretchValue) || 1),
          notes: "Rack tool warp / pitch process.",
        });
      }
      if (action === "canvas-open-node-tools") {
        selectedCanvasNodeId = button.dataset.nodeId;
        renderCanvasToolsMenuState();
        setCanvasToolsMenuOpen(true, button);
        return;
      }
      if (action === "canvas-toggle-source-state") {
        canvasToggleSourceEnabled(button.dataset.nodeId);
        return;
      }
      if (action === "canvas-open-source-info") {
        await openSoundInfoModal(button.dataset.nodeId);
        return;
      }
      if (action === "canvas-info-lineage") {
        const node = canvasNodes.find((item) => item.id === button.dataset.nodeId);
        const asset = node ? canvasAssetById(node.assetId) : null;
        if (asset) await openPetriLineage(asset.metadataPath || asset.metadata?.metadata_path || "", asset.audioPath || "");
        return;
      }
      if (action === "canvas-info-edit-metadata") {
        selectedCanvasNodeId = button.dataset.nodeId;
        closeCanvasModal("soundInfoModal");
        await runCanvasAudioTool("metadata");
        return;
      }
      if (action === "canvas-info-copy-path") {
        const node = canvasNodes.find((item) => item.id === button.dataset.nodeId);
        const asset = node ? canvasAssetById(node.assetId) : null;
        if (asset?.audioPath) {
          await navigator.clipboard?.writeText(asset.audioPath);
          setState("Path Copied", "ok", asset.audioPath);
        }
        return;
      }
      if (action === "canvas-generate-from-node") {
        selectedCanvasNodeId = button.dataset.nodeId;
        await runCanvasGenerate(button.dataset.nodeId);
      }
      if (action === "canvas-play-node") await canvasPlayNode(button.dataset.nodeId);
      if (action === "canvas-stop-node") canvasStopNode(button.dataset.nodeId);
      if (action === "canvas-toggle-loop") canvasToggleLoop(button.dataset.nodeId);
      if (action === "canvas-toggle-reverse") await canvasToggleReverse(button.dataset.nodeId);
      if (action === "canvas-delete-node") canvasDeleteNode(button.dataset.nodeId);
      if (action === "canvas-record-start") await canvasStartRecording(button.dataset.nodeId);
      if (action === "canvas-record-stop") canvasStopRecording(button.dataset.nodeId);
      if (action === "audio-snapshot-start") await canvasStartAudioSnapshot(button.dataset.nodeId);
      if (action === "audio-snapshot-stop") canvasStopAudioSnapshot(button.dataset.nodeId);
      if (action === "audio-snapshot-duration") {
        const node = canvasNodes.find((item) => item.id === button.dataset.nodeId);
        if (node?.type === "audio_snapshot") {
          node.captureSeconds = Number(button.dataset.seconds) || node.captureSeconds || 10;
          selectedCanvasNodeId = node.id;
          canvasSaveState();
          renderCanvas();
        }
      }
      if (action === "canvas-image-pick") {
        const node = canvasNodes.find((item) => item.id === button.dataset.nodeId);
        canvasPendingImagePosition = node ? { x: node.x, y: node.y } : canvasBoardDefaultPoint();
        canvasPendingImageMode = node?.imageMode || "vision";
        canvasPendingImageNodeId = button.dataset.nodeId;
        $("canvasImageInput")?.click();
      }
      if (action === "canvas-image-generate") {
        await runCanvasImageToAudio(button.dataset.nodeId);
      }
      if (action === "canvas-region-mark") {
        const node = canvasNodes.find((item) => item.id === button.dataset.nodeId);
        if (node?.type === "sound") {
          const region = canvasEnsureRegionForType(node, button.dataset.regionType || "mask");
          selectedCanvasNodeId = node.id;
          canvasSaveState();
          renderCanvas();
          drawCanvasWaveforms();
          setState("Region Marked", "ok", canvasRegionSummary(region));
        }
        return;
      }
      if (action === "canvas-region-command") {
        document.querySelectorAll(".wave-variations-popover").forEach((popover) => {
          popover.hidden = true;
        });
        await canvasRunRegionCommand(button.dataset.nodeId, button.dataset.command);
        return;
      }
      if (action === "canvas-op") {
        selectedCanvasNodeId = button.dataset.nodeId;
        renderCanvas();
        await runCanvasOperation(button.dataset.op);
      }
      if (action === "canvas-branch-node") {
        selectedCanvasNodeId = button.dataset.nodeId;
        renderCanvas();
        await runCanvasOperation("mutate");
      }
      if (action === "canvas-download-node") {
        const node = canvasNodes.find(n => n.id === button.dataset.nodeId);
        const asset = node ? canvasAssetById(node.assetId) : null;
        if (asset?.audioPath) {
          const resp = await fetch(outputUrl(asset.audioPath));
          if (resp.ok) {
            const blob = await resp.blob();
            const url = URL.createObjectURL(blob);
            const a = document.createElement("a");
            a.href = url;
            a.download = asset.audioPath.split("/").pop() || "sound.wav";
            document.body.appendChild(a);
            a.click();
            a.remove();
            URL.revokeObjectURL(url);
          }
        }
      }
      if (action === "canvas-variations") {
        const sourceNodeId = button.dataset.nodeId;
        selectedCanvasNodeId = sourceNodeId;
        const sourceNode = canvasNodes.find((node) => node.id === sourceNodeId);
        const mutationSelect = document.querySelector(`.wave-var-mutation[data-node-id="${CSS.escape(sourceNodeId)}"]`);
        if (sourceNode && mutationSelect) sourceNode.variationMutation = Number(mutationSelect.value);
        const count = parseInt(button.dataset.count, 10) || 1;
        renderCanvas();
        // Close any open variations popover
        document.querySelectorAll(".wave-variations-popover").forEach(p => p.hidden = true);
        for (let i = 0; i < count; i++) {
          selectedCanvasNodeId = sourceNodeId;
          await runCanvasOperation("mutate");
        }
      }
      if (action === "canvas-preview-candidate") await canvasPreviewCandidate(button.dataset.candidateId);
      if (action === "canvas-accept-candidate") await canvasAcceptCandidate(button.dataset.candidateId, button.dataset.accept);
      if (action === "canvas-save-candidate") canvasSaveCandidate(button.dataset.candidateId);
      if (action === "canvas-discard-candidate") canvasDiscardCandidate(button.dataset.candidateId);
      if (action === "canvas-candidate-select") canvasToggleCandidateSelection(button.dataset.candidateId, button.checked);
      if (action === "canvas-rate-candidate") canvasRateCandidate(button.dataset.candidateId, button.dataset.rating);
      if (action === "canvas-ecology-action") await canvasRunEcologyAction(button.dataset.command);
      if (action === "canvas-render-macro") await canvasRunRenderMacro(button.dataset.macro);
      return;
    }
    if (action === "play-layer") {
      const layer = layers.find((item) => item.id === layerId);
      if (layer) {
        selectedLayerId = layer.id;
        await setCurrentTrack(layer.audioPath, layer.metadataPath, layer.metadata);
        $("audioPlayer").play();
        renderLayers();
      }
    }
    if (action === "source-layer") {
      const layer = layers.find((item) => item.id === layerId);
      if (layer?.audioPath) {
        selectedLayerId = layer.id;
        canvasAddAudioReference({
          audioPath: layer.audioPath,
          metadataPath: layer.metadataPath || "",
          metadata: layer.metadata || {},
          origin: "library",
          label: displayNameFromPath(layer.audioPath),
        }, canvasBoardDefaultPoint());
        activateTab("chamber");
        setState("Layer Added", "ok", layer.audioPath);
        renderLayers();
      }
    }
    if (action === "copy-layer") {
      const layer = layers.find((item) => item.id === layerId);
      await copyText(layer?.audioPath || "");
    }
    if (action === "remove-layer") {
      if (window.confirm("Remove this layer from the compare stack?")) removeLayer(layerId);
    }
    if (action === "preview-library" || action === "add-library") {
      const item = await libraryItemByReference(button.dataset.metadata, button.dataset.audio);
      if (item?.audioPath) addLayer({ ...item, select: true });
    }
    if (action === "apply-seed") {
      const seed = seedById(button.dataset.seedId);
      if (seed) {
        applySeed(seed);
        activateTab("seeds");
      }
    }
    if (action.startsWith("wavetable-asset-")) {
      const wavetableId = button.dataset.wavetableId || "";
      if (action === "wavetable-asset-use") {
        canvasUseWavetableInGerm(wavetableId);
        return;
      }
      if (action === "wavetable-asset-render") {
        await renderWavetableAssetToSource(wavetableId);
        return;
      }
      if (action === "wavetable-asset-mutate") {
        await mutateWavetableAsset(wavetableId);
        return;
      }
    }
    if (action.startsWith("rack-")) {
      if (action === "rack-select") {
        const key = button.dataset.key;
        if (button.checked) rackSelectedKeys.add(key);
        else rackSelectedKeys.delete(key);
        renderRack();
        return;
      }
      if (action === "rack-play") {
        const item = await libraryItemByReference(button.dataset.metadata, button.dataset.audio);
        if (item?.audioPath) {
          await setCurrentTrack(item.audioPath, item.metadataPath, item.metadata);
          await $("audioPlayer")?.play?.();
          recordPetriSignal(petriItemKey(item), "play");
        }
        return;
      }
      if (action === "rack-source") {
        const item = await libraryItemByReference(button.dataset.metadata, button.dataset.audio);
        if (item?.audioPath) {
          canvasAddAudioReference({
            audioPath: item.audioPath,
            metadataPath: item.metadataPath || "",
            metadata: item.metadata || {},
            origin: canvasOriginFromItem(item.metadata || {}),
            label: displayNameFromPath(item.audioPath),
          }, canvasBoardDefaultPoint());
          recordPetriSignal(petriItemKey(item), "use");
          activateTab("chamber");
          setState("Source Added", "ok", item.audioPath);
        }
        return;
      }
      if (action === "rack-lineage") {
        await openPetriLineage(button.dataset.metadata || "", button.dataset.audio || "");
        return;
      }
      if (action === "rack-reveal") {
        const audioPath = button.dataset.audio;
        if (audioPath) {
          api("/files/reveal", {
            method: "POST",
            body: JSON.stringify({ path: audioPath })
          }).then(res => {
            if (res.status === "ok") {
              setState("File Revealed", "ok", res.path);
            } else {
              throw new Error(res.detail || "Reveal failed");
            }
          }).catch(err => {
            finishWork("Reveal Error", "bad", err.message);
          });
        }
        return;
      }
      if (action === "rack-copy-path") {
        const path = button.dataset.path;
        if (path) {
          navigator.clipboard.writeText(path).then(() => {
            finishWork("Path Copied", "ok", path);
          }).catch(err => {
            finishWork("Copy Error", "bad", err.message);
          });
        }
        return;
      }
      if (action === "rack-delete") {
        const audio = button.dataset.audio;
        const metadata = button.dataset.metadata;
        if (audio) {
          deleteSingleFile(audio, metadata).catch(err => {
            finishWork("Delete Error", "bad", err.message);
          });
        }
        return;
      }
    }
    if (action.startsWith("petri-")) {
      if (action === "petri-view") {
        petriLibraryView = button.dataset.view || "sounds";
        petriPage = 0;
        renderHerbarium();
        return;
      }
      if (action === "petri-load-group") {
        const group = savedGroups.find((item) => item.id === button.dataset.groupId);
        if (group) {
          await canvasLoadSavedGroup(group);
          activateTab("chamber");
        }
        return;
      }
      if (action === "petri-favorite") {
        const key = button.dataset.key;
        const nextFavorite = !petriState[key]?.favorite;
        updatePetriState(key, {
          favorite: nextFavorite,
          rejected: false,
          rating: nextFavorite ? 5 : 0,
        });
        persistPetriRatings(key).catch((error) => setState("Petri Sync", "muted", error.message));
        renderPetri();
        renderHerbarium();
        return;
      }
      if (action === "petri-lineage") {
        await openPetriLineage(button.dataset.metadata || "", button.dataset.audio || "");
        return;
      }
      const item = await libraryItemByReference(button.dataset.metadata, button.dataset.audio);
      if (!item?.audioPath) return;
      if (action === "petri-preview") {
        const audio = $("audioPlayer");
        const isPlayingThis = !audio.paused && audio.src && audio.src.includes(encodeURIComponent(item.audioPath.split("/").pop()));
        if (isPlayingThis) {
          audio.pause();
          audio.currentTime = 0;
          button.innerHTML = iconSvg("play");
          button.title = "Play";
          button.setAttribute("aria-label", "Play");
          // Remove playing state and stop animation
          stopPetriWaveformAnim();
          const card = button.closest(".petri-card");
          if (card) {
            card.classList.remove("playing");
            const cv = card.querySelector(".petri-canvas");
            if (cv && cv._audioBuf) drawMiniWaveform(cv, cv._audioBuf);
          }
        } else {
          // Reset all petri play buttons and playing states
          stopPetriWaveformAnim();
          document.querySelectorAll(".petri-card.playing").forEach(c => {
            c.classList.remove("playing");
            const cv = c.querySelector(".petri-canvas");
            if (cv && cv._audioBuf) drawMiniWaveform(cv, cv._audioBuf);
          });
          document.querySelectorAll(".action-play").forEach(btn => {
            btn.innerHTML = iconSvg("play");
            btn.title = "Play";
            btn.setAttribute("aria-label", "Play");
          });
          await setCurrentTrack(item.audioPath, item.metadataPath, item.metadata);
          await audio?.play?.();
          recordPetriSignal(petriItemKey(item), "play");
          button.innerHTML = iconSvg("stop");
          button.title = "Stop";
          button.setAttribute("aria-label", "Stop");
          // Add playing state and start waveform animation
          const card = button.closest(".petri-card");
          if (card) {
            card.classList.add("playing");
            const cv = card.querySelector(".petri-canvas");
            if (cv && cv._audioBuf) startPetriWaveformAnim(cv, cv._audioBuf, audio);
          }
        }
      }
      if (action === "petri-source") {
        // Stop any playing preview
        const audio = $("audioPlayer");
        if (!audio.paused) {
          audio.pause();
          audio.currentTime = 0;
        }
        stopPetriWaveformAnim();
        document.querySelectorAll(".petri-card.playing").forEach(c => {
          c.classList.remove("playing");
          const cv = c.querySelector(".petri-canvas");
          if (cv && cv._audioBuf) drawMiniWaveform(cv, cv._audioBuf);
        });
        document.querySelectorAll(".action-play").forEach(btn => {
          btn.innerHTML = iconSvg("play");
          btn.title = "Play";
          btn.setAttribute("aria-label", "Play");
        });
        canvasAddAudioReference({
          audioPath: item.audioPath,
          metadataPath: item.metadataPath || "",
          metadata: item.metadata || {},
          origin: canvasOriginFromItem(item.metadata || {}),
          label: displayNameFromPath(item.audioPath),
        }, canvasBoardDefaultPoint());
        recordPetriSignal(petriItemKey(item), "use");
        activateTab("chamber");
        setState("Source Added", "ok", item.audioPath);
      }
    }
  } catch (error) {
    finishWork("Error", "bad", error.message);
  }
});

$("provider").addEventListener("change", () => updateModels(false));
$("model").addEventListener("change", () => {
  $("activeModel").textContent = $("model").value || "-";
  updateHomeReadouts();
});
// Text search rebuilds the full filtered list; debounce keystrokes so typing in
// a large library does not re-render per character.
function debounceRender(fn, delayMs = 220) {
  let timer = null;
  return () => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      fn();
    }, delayMs);
  };
}
if ($("librarySearch")) $("librarySearch").addEventListener("input", debounceRender(renderLibrary));
if ($("libraryMode")) $("libraryMode").addEventListener("change", renderLibrary);
if ($("libraryStatus")) $("libraryStatus").addEventListener("change", renderLibrary);
if ($("rackSearch")) $("rackSearch").addEventListener("input", debounceRender(renderRack));
if ($("rackGroup")) $("rackGroup").addEventListener("change", renderRack);
if ($("rackFilterMode")) $("rackFilterMode").addEventListener("change", renderRack);
if ($("rackFilterFav")) $("rackFilterFav").addEventListener("change", renderRack);
if ($("rackSort")) $("rackSort").addEventListener("change", renderRack);
if ($("rackBatchTagBtn")) $("rackBatchTagBtn").addEventListener("click", () => {
  const tags = parseTags($("rackBatchTags")?.value || "");
  rackUpdateSelected({ appendTags: tags }).catch((error) => finishWork("Rack Error", "bad", error.message));
});
if ($("rackBatchNotesBtn")) $("rackBatchNotesBtn").addEventListener("click", () => {
  const notes = $("rackBatchNotes")?.value || "";
  rackUpdateSelected({ notes }).catch((error) => finishWork("Rack Error", "bad", error.message));
});
if ($("rackBatchClearTagsBtn")) $("rackBatchClearTagsBtn").addEventListener("click", () => {
  rackUpdateSelected({ tags: [] }).catch((error) => finishWork("Rack Error", "bad", error.message));
});
if ($("rackClearSelectionBtn")) $("rackClearSelectionBtn").addEventListener("click", () => {
  rackSelectedKeys.clear();
  renderRack();
});
if ($("rackBulkDeleteBtn")) $("rackBulkDeleteBtn").addEventListener("click", deleteSelectedFiles);
if ($("rackExportCsvBtn")) $("rackExportCsvBtn").addEventListener("click", exportSelectedToCsv);
if ($("rackSelectAll")) {
  $("rackSelectAll").addEventListener("change", (e) => {
    const checked = e.target.checked;
    const items = rackItems();
    items.forEach((item) => {
      const key = petriItemKey(item);
      if (checked) rackSelectedKeys.add(key);
      else rackSelectedKeys.delete(key);
    });
    renderRack();
  });
}
if ($("cultureName")) $("cultureName").addEventListener("input", renderCulture);
if ($("cultureNotes")) $("cultureNotes").addEventListener("input", renderCulture);

bind("refreshBtn", "click", refreshAll);
bind("loadBtn", "click", loadModel);
bind("generateBtn", "click", generate);
bind("saveSeedBtn", "click", saveSeed);
bind("seedGerminateBtn", "click", germinateFromSeed);
bind("refreshPetriBtn", "click", () => refreshLibrary(true));
bind("diagnosticsBtn", "click", refreshAll);
bind("hfCheckBtn", "click", checkHuggingFace);
bind("testBtn", "click", runModelTest);
bind("loadLoraBtn", "click", loadLora);
bind("setLoraBtn", "click", setLoraStrength);
bind("refreshLibraryBtn", "click", () => refreshLibrary(true));
bind("canvasGlobalPlayBtn", "click", canvasTogglePlayStop);
if ($("canvasGlobalSyncBtn")) $("canvasGlobalSyncBtn").addEventListener("click", canvasToggleGlobalSync);
if ($("canvasGlobalLoopBtn")) $("canvasGlobalLoopBtn").addEventListener("click", canvasToggleGlobalLoop);
if ($("timeModeToggle")) $("timeModeToggle").addEventListener("click", () => setTimeMode(!timeState.enabled));
["timeBpm", "timeBars"].forEach((id) => {
  if ($(id)) $(id).addEventListener("input", updateTimeStateFromTransport);
});
["timeSignature", "timeSnapDivision"].forEach((id) => {
  if ($(id)) $(id).addEventListener("change", updateTimeStateFromTransport);
});
if ($("timeRenderSelectedBtn")) $("timeRenderSelectedBtn").addEventListener("click", () => {
  renderTimeNode().catch((error) => finishWork("Harvest Error", "bad", error.message));
});
if ($("listenerPrompt") && $("prompt")) $("listenerPrompt").value = $("prompt").value;
if ($("listenerNegative") && $("negativePrompt")) $("listenerNegative").value = $("negativePrompt").value;
if ($("listenerEnhanceBtn")) $("listenerEnhanceBtn").addEventListener("click", () => {
  runListenerEnhance().catch((error) => finishWork("Listener Error", "bad", error.message));
});
if ($("listenerScoreBtn")) $("listenerScoreBtn").addEventListener("click", () => {
  runListenerScoreSelected().catch((error) => finishWork("Listener Error", "bad", error.message));
});
if ($("listenerRelistenBtn")) $("listenerRelistenBtn").addEventListener("click", () => {
  runListenerRelistenSelected().catch((error) => finishWork("Oída Error", "bad", error.message));
});
if ($("canvasMasterRecordBtn")) $("canvasMasterRecordBtn").addEventListener("click", () => {
  canvasToggleMasterRecording().catch((error) => finishWork("Record Error", "bad", error.message));
});
if ($("canvasResetViewBtn")) $("canvasResetViewBtn").addEventListener("click", canvasResetView);
if ($("canvasLoadSnapshotBtn")) $("canvasLoadSnapshotBtn").addEventListener("click", openSnapshotLibrary);
if ($("canvasSnapshotBtn")) $("canvasSnapshotBtn").addEventListener("click", canvasSaveSnapshot);
if ($("canvasCandidateModalBtn")) $("canvasCandidateModalBtn").addEventListener("click", () => openCanvasModal("canvasCandidateModal"));
if ($("canvasCompilerModalBtn")) $("canvasCompilerModalBtn").addEventListener("click", () => openCanvasModal("canvasCompilerModal"));
if ($("aboutAppModalBtn")) $("aboutAppModalBtn").addEventListener("click", () => {
  setSettingsMenuOpen(false);
  openCanvasModal("aboutAppModal");
});
if ($("helpModeToggle")) $("helpModeToggle").addEventListener("click", toggleHelpMode);
if ($("transportSettingsBtn")) $("transportSettingsBtn").addEventListener("click", (event) => {
  event.stopPropagation();
  toggleSettingsMenu();
});
if ($("canvasToolsMenuBtn")) $("canvasToolsMenuBtn").addEventListener("click", (event) => {
  event.stopPropagation();
  toggleCanvasToolsMenu();
});
if ($("canvasMixerBtn")) $("canvasMixerBtn").addEventListener("click", (event) => {
  event.stopPropagation();
  canvasCreateMixerNode();
});

if ($("rightSidebarToggle")) $("rightSidebarToggle").addEventListener("click", () => {
  setRightSidebarCollapsed(!document.body.classList.contains("right-sidebar-collapsed"));
});

document.addEventListener("click", (event) => {
  const connectMenu = $("canvasConnectMenu");
  if (connectMenu && !connectMenu.hidden && !event.target.closest?.("#canvasConnectMenu") && !event.target.closest?.(".canvas-io-port")) {
    closeCanvasConnectMenu();
  }
  const toolsMenu = $("canvasToolsMenu");
  if (toolsMenu && !toolsMenu.hidden && !event.target.closest?.("#canvasToolsMenu") && !event.target.closest?.("#canvasToolsMenuBtn") && !event.target.closest?.(".wave-tools-button")) {
    setCanvasToolsMenuOpen(false);
  }
  const menu = $("topbarSettingsMenu");
  if (!menu || menu.hidden) return;
  if (event.target.closest?.("#topbarSettingsMenu") || event.target.closest?.("#transportSettingsBtn")) return;
  setSettingsMenuOpen(false);
});

document.addEventListener("keydown", (event) => {
  if (event.key === "Enter") {
    const input = event.target.closest?.(".rack-filename-input, .rack-prompt-input, .rack-tags-input");
    if (input) {
      input.blur();
    }
  }
  if (!event.target.closest?.("input, textarea, select, [contenteditable='true']")) {
    const node = selectedTimeNode();
    const padIndex = node?.timeType === "trigger_pads" ? TIME_PAD_KEYS.indexOf(event.key) : -1;
    if (timeState.enabled && padIndex >= 0) {
      event.preventDefault();
      triggerTimePad(node.id, padIndex, { fromKeyboard: true }).catch((error) => finishWork("Pad Error", "bad", error.message));
      return;
    }
  }
  if (event.key === "Escape") {
    setSettingsMenuOpen(false);
    setCanvasToolsMenuOpen(false);
    closeCanvasConnectMenu();
  }
  // Undo / Redo
  if ((event.ctrlKey || event.metaKey) && event.key === "z" && !event.shiftKey) {
    event.preventDefault();
    canvasUndo();
    return;
  }
  if ((event.ctrlKey || event.metaKey) && (event.key === "Z" || event.key === "y")) {
    event.preventDefault();
    canvasRedo();
    return;
  }
  // Spacebar play
  if (event.code === "Space" && !(event.target instanceof HTMLInputElement) && !(event.target instanceof HTMLTextAreaElement) && !(event.target instanceof HTMLSelectElement)) {
    event.preventDefault();
    if (selectedCanvasNodeId) {
      const node = canvasNodes.find(n => n.id === selectedCanvasNodeId);
      if (node && (node.type === "sound" || node.type === "record" || node.type === "audio-snapshot")) {
        canvasPlayNode(node.id);
      } else {
        canvasTogglePlayStop();
      }
    } else {
      canvasTogglePlayStop();
    }
    return;
  }
});
window.addEventListener("resize", () => {
  if (!$("topbarSettingsMenu")?.hidden) positionSettingsMenu();
  if (!$("canvasToolsMenu")?.hidden) positionCanvasToolsMenu(canvasToolsAnchor);
});
bindModuleHelp("topbar", "topbarHint", "Hover a control for a short description.");
bindModuleHelp("canvasTransportModule", "transportHint", "Transport controls.");
bindModuleHelp("tab-petri", "petriHint", "Hover an action for details.");
bindModuleHelp("tab-controllers", "controlHint", "Hover a Controllers action for details.");
bindModuleHelp("tab-micro", "microHint", "Add modules that treat sound as grains, cells, tissue, and control matter.");
bindModuleHelp("tab-thermostat", "thermostatHint", "Hover an action for details.");
bindModuleHelp("tab-diagnostics", "statusHint", "Hover an action for details.");
if ($("canvasUploadInput")) $("canvasUploadInput").addEventListener("change", async (event) => {
  const position = canvasPendingSourcePosition ? { ...canvasPendingSourcePosition } : null;
  try {
    await canvasAddUploadFiles(event.target.files, position);
  } catch (error) {
    finishWork("Upload Error", "bad", error.message);
  } finally {
    canvasPendingSourcePosition = null;
    event.target.value = "";
  }
});
if ($("canvasImageInput")) $("canvasImageInput").addEventListener("change", async (event) => {
  try {
    const file = Array.from(event.target.files || [])[0];
    if (file) {
      await canvasAddImageFile(file, {
        position: canvasPendingImagePosition || canvasPendingSourcePosition || canvasBoardDefaultPoint(),
        mode: canvasPendingImageMode || "vision",
        nodeId: canvasPendingImageNodeId,
      });
    }
  } catch (error) {
    finishWork("Image Error", "bad", error.message);
  } finally {
    canvasPendingImagePosition = null;
    canvasPendingImageMode = "vision";
    canvasPendingImageNodeId = null;
    canvasPendingSourcePosition = null;
    event.target.value = "";
  }
});
if ($("canvasResetBtn")) $("canvasResetBtn").addEventListener("click", canvasResetGraph);
if ($("canvasUndoBtn")) $("canvasUndoBtn").addEventListener("click", canvasUndo);
if ($("canvasRedoBtn")) $("canvasRedoBtn").addEventListener("click", canvasRedo);
document.addEventListener("input", (event) => {
  if (handleCanvasModulatorControl(event)) return;
  if (handleCanvasGeneticControl(event)) return;
  if (handleAudioSnapshotControl(event)) return;
  const wavetableText = event.target.closest?.(".wavetable-node-text[data-node-id][data-field]");
  if (wavetableText) {
    const node = canvasNodes.find((item) => item.id === wavetableText.dataset.nodeId);
    if (!node || !["germ", "wavetable_forge"].includes(node.type)) return;
    node[wavetableText.dataset.field] = wavetableText.value;
    selectedCanvasNodeId = node.id;
    canvasSaveState();
    updateCanvasInspector();
    return;
  }
  const wavetableSetting = event.target.closest?.(".wavetable-node-setting[data-node-id][data-field]");
  if (wavetableSetting) {
    const node = canvasNodes.find((item) => item.id === wavetableSetting.dataset.nodeId);
    if (!node || !["germ", "wavetable_forge"].includes(node.type)) return;
    const field = wavetableSetting.dataset.field;
    const numericFields = new Set(["durationSec", "frameCount", "frameSize", "tablePosition", "gain", "mutationDepth", "variationCount"]);
    node[field] = numericFields.has(field) ? Number(wavetableSetting.value) : wavetableSetting.value;
    selectedCanvasNodeId = node.id;
    if (node.type === "germ") canvasNodes[canvasNodes.findIndex((item) => item.id === node.id)] = normalizeGermNode(node);
    if (node.type === "wavetable_forge") canvasNodes[canvasNodes.findIndex((item) => item.id === node.id)] = normalizeWavetableForgeNode(node);
    canvasSaveState();
    if (field === "tablePosition" || field === "wavetableId") requestAnimationFrame(drawGermWavetableCanvases);
    return;
  }
  const field = event.target.closest?.(".canvas-prompt-edit[data-node-id][data-field]");
  if (field) {
    const node = canvasNodes.find((item) => item.id === field.dataset.nodeId);
    if (!node || node.type !== "prompt") return;
    node[field.dataset.field] = field.value;
    selectedCanvasNodeId = node.id;
    canvasSaveState();
    updateCanvasInspector();
    return;
  }
  const promptSetting = event.target.closest?.(".canvas-prompt-setting[data-node-id][data-field]");
  if (promptSetting) {
    const node = canvasNodes.find((item) => item.id === promptSetting.dataset.nodeId);
    if (!node || node.type !== "prompt") return;
    const numericValue = Number(promptSetting.value);
    const previous = canvasNormalizePromptSettings(node);
    node[promptSetting.dataset.field] = Number.isFinite(numericValue) ? numericValue : previous[promptSetting.dataset.field];
    Object.assign(node, canvasNormalizePromptSettings(node));
    selectedCanvasNodeId = node.id;
    canvasSaveState();
    updateCanvasInspector();
    return;
  }
  const stackField = event.target.closest?.(".canvas-prompt-stack-field[data-node-id][data-field]");
  if (stackField) {
    const node = canvasNodes.find((item) => item.id === stackField.dataset.nodeId);
    if (!node || node.type !== "prompt") return;
    node.promptStack = canvasNormalizePromptStack(node);
    node.promptStack[stackField.dataset.field] = stackField.value;
    selectedCanvasNodeId = node.id;
    canvasSaveState();
    updateCanvasInspector();
    return;
  }
  const imagePrompt = event.target.closest?.(".canvas-image-prompt[data-node-id]");
  if (imagePrompt) {
    const node = canvasNodes.find((item) => item.id === imagePrompt.dataset.nodeId);
    if (!node || node.type !== "image") return;
    node.imagePrompt = imagePrompt.value;
    selectedCanvasNodeId = node.id;
    canvasSaveState();
    return;
  }
  const imageSetting = event.target.closest?.(".canvas-image-setting[data-node-id][data-field]");
  if (imageSetting) {
    const node = canvasNodes.find((item) => item.id === imageSetting.dataset.nodeId);
    if (!node || node.type !== "image") return;
    if (imageSetting.dataset.field === "durationSec") {
      node.durationSec = Math.min(60, Math.max(0.5, Number(imageSetting.value) || 6));
    } else {
      node[imageSetting.dataset.field] = imageSetting.value;
    }
    selectedCanvasNodeId = node.id;
    canvasSaveState();
    return;
  }
  const lanePrompt = event.target.closest?.(".time-lane-prompt[data-node-id][data-lane-index]");
  if (lanePrompt) {
    const node = canvasNodes.find((item) => item.id === lanePrompt.dataset.nodeId);
    const lane = node?.lanes?.[Number(lanePrompt.dataset.laneIndex)];
    if (node?.type === "time" && lane) {
      lane.prompt = lanePrompt.value;
      selectedCanvasNodeId = node.id;
      canvasSaveState();
    }
    return;
  }
  const padPrompt = event.target.closest?.(".time-pad-prompt[data-node-id][data-pad-index]");
  if (padPrompt) {
    const node = canvasNodes.find((item) => item.id === padPrompt.dataset.nodeId);
    const pad = node?.pads?.[Number(padPrompt.dataset.padIndex)];
    if (node?.type === "time" && pad) {
      pad.prompt = padPrompt.value;
      selectedCanvasNodeId = node.id;
      canvasSaveState();
    }
    return;
  }
  const sourcePrompt = event.target.closest?.(".time-source-prompt[data-node-id][data-kind]");
  if (sourcePrompt) {
    const node = canvasNodes.find((item) => item.id === sourcePrompt.dataset.nodeId);
    const slot = timeSlotFor(node, sourcePrompt.dataset.kind, 0);
    if (node?.type === "time" && slot) {
      slot.prompt = sourcePrompt.value;
      if (node.timeType === "euclidean_colony") node.prompt = sourcePrompt.value;
      selectedCanvasNodeId = node.id;
      canvasSaveState();
    }
    return;
  }
  const laneParam = event.target.closest?.(".time-lane-param[data-node-id][data-lane-index][data-param]");
  if (laneParam) {
    const node = canvasNodes.find((item) => item.id === laneParam.dataset.nodeId);
    const lane = node?.lanes?.[Number(laneParam.dataset.laneIndex)];
    if (node?.type === "time" && lane) {
      lane[laneParam.dataset.param] = Number(laneParam.value);
      selectedCanvasNodeId = node.id;
      canvasSaveState();
      updateTimeTransportUi();
    }
    return;
  }
  const padParam = event.target.closest?.(".time-pad-param[data-node-id][data-pad-index][data-param]");
  if (padParam) {
    const node = canvasNodes.find((item) => item.id === padParam.dataset.nodeId);
    const pad = node?.pads?.[Number(padParam.dataset.padIndex)];
    if (node?.type === "time" && pad) {
      pad[padParam.dataset.param] = Number(padParam.value);
      selectedCanvasNodeId = node.id;
      canvasSaveState();
      updateTimeTransportUi();
    }
    return;
  }
  const sourceParam = event.target.closest?.(".time-source-param[data-node-id][data-kind][data-param]");
  if (sourceParam) {
    const node = canvasNodes.find((item) => item.id === sourceParam.dataset.nodeId);
    const slot = timeSlotFor(node, sourceParam.dataset.kind, 0);
    if (node?.type === "time" && slot) {
      slot[sourceParam.dataset.param] = Number(sourceParam.value);
      selectedCanvasNodeId = node.id;
      canvasSaveState();
      updateTimeTransportUi();
    }
    return;
  }
  const nodeSetting = event.target.closest?.(".time-node-setting[data-node-id][data-field]");
  if (nodeSetting) {
    const node = canvasNodes.find((item) => item.id === nodeSetting.dataset.nodeId);
    if (node?.type === "time") {
      const field = nodeSetting.dataset.field;
      const numericFields = new Set([
        "sliceCount",
        "steps",
        "pulses",
        "rotation",
        "probability",
        "targetBars",
        "velocity",
        "skipEvery",
        "seed",
        "density",
        "timing",
        "velocitySpread",
      ]);
      node[field] = numericFields.has(field) ? Number(nodeSetting.value) : nodeSetting.value;
      const index = canvasNodes.findIndex((item) => item.id === node.id);
      canvasNodes[index] = normalizeTimeNode(node);
      selectedCanvasNodeId = node.id;
      canvasSaveState();
      renderCanvas();
    }
    return;
  }
  const incubationEventParam = event.target.closest?.(".time-incubation-event-param[data-node-id][data-event-id][data-param]");
  if (incubationEventParam) {
    updateIncubationTimelineParam(incubationEventParam);
    return;
  }
  const incubationSourceParam = event.target.closest?.(".time-incubation-source-param[data-node-id][data-source-id][data-param]");
  if (incubationSourceParam) {
    updateIncubationSourceParam(incubationSourceParam);
    return;
  }
  const sliceParam = event.target.closest?.(".time-slice-param[data-node-id][data-param]");
  if (sliceParam) {
    const node = canvasNodes.find((item) => item.id === sliceParam.dataset.nodeId);
    const slice = node?.slices?.[node.selectedSlice || 0];
    if (node?.type === "time" && slice) {
      slice[sliceParam.dataset.param] = Number(sliceParam.value);
      selectedCanvasNodeId = node.id;
      canvasSaveState();
    }
    return;
  }
  const melodyStepParam = event.target.closest?.(".time-melody-step-param[data-node-id][data-param]");
  if (melodyStepParam) {
    const node = canvasNodes.find((item) => item.id === melodyStepParam.dataset.nodeId);
    const step = node?.steps?.[node.selectedStep || 0];
    if (node?.type === "time" && step) {
      const field = melodyStepParam.dataset.param;
      step[field] = Number(melodyStepParam.value);
      selectedCanvasNodeId = node.id;
      canvasSaveState();
      renderCanvas();
    }
    return;
  }
  const polyParam = event.target.closest?.(".time-poly-param[data-node-id][data-lane-index][data-param]");
  if (polyParam) {
    const node = canvasNodes.find((item) => item.id === polyParam.dataset.nodeId);
    const lane = node?.lanes?.[Number(polyParam.dataset.laneIndex)];
    if (node?.type === "time" && lane) {
      lane[polyParam.dataset.param] = Number(polyParam.value);
      const index = canvasNodes.findIndex((item) => item.id === node.id);
      canvasNodes[index] = normalizeTimeNode(node);
      selectedCanvasNodeId = node.id;
      canvasSaveState();
      renderCanvas();
    }
    return;
  }
  const stepVelocity = event.target.closest?.(".time-step-velocity-input[data-node-id]");
  if (stepVelocity) {
    const node = canvasNodes.find((item) => item.id === stepVelocity.dataset.nodeId);
    const selected = node?.selectedStep || { lane: 0, step: 0 };
    const step = node?.lanes?.[selected.lane]?.steps?.[selected.step];
    if (node?.type === "time" && step) {
      step.velocity = Math.min(2, Math.max(0, Number(stepVelocity.value)));
      step.enabled = step.velocity > 0 ? step.enabled : false;
      selectedCanvasNodeId = node.id;
      canvasSaveState();
      renderCanvas();
    }
    return;
  }
  const speed = event.target.closest?.(".canvas-speed-input[data-node-id]");
  if (speed) {
    canvasSetPlaybackRate(speed.dataset.nodeId, speed.value);
  }
  const fxParam = event.target.closest?.(".canvas-fx-param[data-node-id][data-param]");
  if (fxParam) {
    const node = canvasNodes.find((item) => item.id === fxParam.dataset.nodeId);
    if (node?.type === "fx") {
      const value = fxParam.type === "checkbox" ? Boolean(fxParam.checked) : Number(fxParam.value);
      node.params = { ...(node.params || {}), [fxParam.dataset.param]: value };
      applyFxNodeToTarget(node);
      if (node.fxType === "pitch" && fxParam.dataset.param === "semitones") {
        const readout = document.querySelector(`.canvas-node[data-node-id="${CSS.escape(node.id)}"] .fx-readout`);
        if (readout) readout.textContent = `${Number(node.params.semitones || 0).toFixed(2)} st | realtime audition`;
      }
      if (node.fxType === "filter") drawCanvasFxFilters();
      selectedCanvasNodeId = node.id;
      canvasSaveState();
      if (event.type === "change" && fxParam.type === "checkbox") renderCanvas();
    }
    return;
  }
  const fxSemanticParam = event.target.closest?.(".canvas-fx-semantic-param[data-node-id][data-field]");
  if (fxSemanticParam) {
    const node = canvasNodes.find((item) => item.id === fxSemanticParam.dataset.nodeId);
    if (node?.type === "fx") {
      const current = canvasNormalizeFxSemantic(node);
      node.semantic = {
        ...current,
        [fxSemanticParam.dataset.field]: fxSemanticParam.dataset.field === "enabled"
          ? Boolean(fxSemanticParam.checked)
          : Math.min(1, Math.max(0, Number(fxSemanticParam.value) || 0)),
      };
      selectedCanvasNodeId = node.id;
      canvasSaveState();
      if (event.type === "input") updateCanvasInspector();
      else renderCanvas();
    }
    return;
  }
  const mixerParam = event.target.closest?.(".canvas-mixer-param[data-target-node-id][data-param]");
  if (mixerParam) {
    const node = canvasNodes.find((item) => item.id === mixerParam.dataset.targetNodeId);
    if (node?.type === "sound") {
      node[mixerParam.dataset.param] = Number(mixerParam.value);
      applyMixerSoloMute();
      savedGroups.forEach((group) => {
        (group.items || []).forEach((item) => {
          if (item.nodeId === node.id) item[mixerParam.dataset.param] = node[mixerParam.dataset.param];
        });
        group.updatedAt = new Date().toISOString();
      });
      saveSavedGroups();
    }
  }
});
// Library filters
["libSearch", "libMode", "libSort", "libModel", "libSourceType", "libStrain", "libDuration", "libRating", "libTag"].forEach(id => {
  const el = $(id);
  if (el) el.addEventListener(el.tagName === "INPUT" ? "input" : "change", () => {
    petriPage = 0;
    renderHerbarium();
  });
});

// Petri pagination
if ($("petriPrevBtn")) $("petriPrevBtn").addEventListener("click", () => {
  if (petriPage <= 0) return;
  petriPage -= 1;
  renderHerbarium();
});
if ($("petriNextBtn")) $("petriNextBtn").addEventListener("click", () => {
  petriPage += 1;
  renderHerbarium();
});
bind("revealAudioBtn", "click", revealAudio);

if ($("clearLayersBtn")) $("clearLayersBtn").addEventListener("click", () => {
  if (layers.length && !window.confirm("Clear all layers from the compare stack?")) return;
  layers = [];
  selectedLayerId = null;
  renderLayers();
});
if ($("useAsSourceBtn")) $("useAsSourceBtn").addEventListener("click", useSelectedAsSource);
if ($("exportPetriSelectedBtn")) $("exportPetriSelectedBtn").addEventListener("click", () => {
  const selected = libraryItems.filter((item) => petriState[petriItemKey(item)]?.favorite);
  copyText(JSON.stringify(selected.length ? selected : sortedPetriItems(), null, 2));
  setState("Selection Copied", "ok", `${selected.length || sortedPetriItems().length} candidates`);
});
if ($("newCultureBtn")) $("newCultureBtn").addEventListener("click", createCulture);
if ($("exportCultureBtn")) $("exportCultureBtn").addEventListener("click", () => {
  renderCulture();
  copyText(JSON.stringify(activeCulture, null, 2));
  setState("Culture Metadata Copied", "ok", activeCulture.name);
});
$("copyResultBtn").addEventListener("click", () => copyText(JSON.stringify(lastResult || currentTrack || {}, null, 2)));
$("copyAudioPathBtn").addEventListener("click", () => copyText($("audioPath").value));
$("openAudioBtn").addEventListener("click", () => {
  const path = $("audioPath").value;
  if (path) window.open(outputUrl(path), "_blank");
});

if ($("canvasBoard")) {
  $("canvasBoard").addEventListener("contextmenu", (event) => {
    const sourceState = event.target.closest(".wave-source-state[data-node-id]");
    if (sourceState) {
      event.preventDefault();
      canvasToggleSourceSolo(sourceState.dataset.nodeId);
      return;
    }
    if (event.target.closest(".canvas-node-waveform")) {
      event.preventDefault();
      return;
    }
    if (event.target.closest(".canvas-node, .canvas-source-menu, .canvas-library-modal, button, input, textarea")) return;
    event.preventDefault();
    openCanvasSourceMenu(canvasPointFromEvent(event));
  });
  $("canvasBoard").addEventListener("wheel", (event) => {
    if (event.target.closest(".canvas-library-modal")) return;
    event.preventDefault();
    const factor = Math.min(1.06, Math.max(0.94, Math.exp(-event.deltaY * 0.0015)));
    canvasSetZoom(canvasZoom * factor, event);
  }, { passive: false });
}

document.addEventListener("pointerdown", (event) => {
  const filterCanvas = event.target.closest?.(".fx-filter-canvas[data-node-id]");
  if (filterCanvas && event.button === 0) {
    const node = canvasNodes.find((item) => item.id === filterCanvas.dataset.nodeId);
    if (node?.type === "fx") {
      selectedCanvasNodeId = node.id;
      canvasFxCurveDrag = { nodeId: node.id, canvas: filterCanvas, pointerId: event.pointerId };
      canvasSetPointerCapture(filterCanvas, event.pointerId);
      canvasUpdateFilterCurveFromPointer(event, filterCanvas, node);
      event.preventDefault();
      return;
    }
  }

  const boardTarget = event.target.closest?.("#canvasBoard");
  if (
    boardTarget
    && event.button === 0
    && !event.target.closest(".canvas-node, .canvas-source-menu, .canvas-library-modal, button, input, textarea")
  ) {
    closeCanvasSourceMenu();
    const board = $("canvasBoard");
    canvasPanDrag = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      scrollLeft: board.scrollLeft,
      scrollTop: board.scrollTop,
    };
    canvasSetPointerCapture(board, event.pointerId);
    event.preventDefault();
    return;
  }

  const wave = event.target.closest?.(".canvas-node-waveform[data-node-id]");
  if (wave) {
    const node = canvasNodes.find((item) => item.id === wave.dataset.nodeId);
    if (!node || node.type !== "sound") return;
    closeCanvasSourceMenu();
    selectedCanvasNodeId = node.id;
    canvasLastSelectedSoundNodeId = node.id;

    // Ctrl/Cmd + right-click -> extract region into a new sound file
    if (event.button === 2 && (event.ctrlKey || event.metaKey)) {
      const start = canvasRegionFromPointer(event, node);
      const region = canvasSetRegion(node, "extract", start, start);
      canvasRegionDrag = { nodeId: node.id, regionId: region.id, start, purpose: "extract", canvas: wave, pointerId: event.pointerId };
      canvasSetPointerCapture(wave, event.pointerId);
      event.preventDefault();
      updateCanvasInspector("extract");
      drawCanvasWaveforms();
      return;
    }

    // Right-click → inpaint region
    if (event.button === 2) {
      const existingRegion = canvasRegionAtPointer(event, node, "inpaint");
      if (existingRegion) {
        canvasRemoveRegion(node, existingRegion.id);
        event.preventDefault();
        updateCanvasInspector("inpaint");
        drawCanvasWaveforms();
        canvasSaveState();
        return;
      }
      const start = canvasRegionFromPointer(event, node);
      const region = canvasSetRegion(node, "inpaint", start, start);
      canvasRegionDrag = { nodeId: node.id, regionId: region.id, start, purpose: "inpaint", canvas: wave, pointerId: event.pointerId };
      canvasSetPointerCapture(wave, event.pointerId);
      event.preventDefault();
      updateCanvasInspector("inpaint");
      drawCanvasWaveforms();
      return;
    }

    // Ctrl + left-click → move node
    if (event.button === 0 && (event.ctrlKey || event.metaKey)) {
      const point = canvasPointFromEvent(event);
      canvasDrag = {
        nodeId: node.id,
        offsetX: point.x - node.x,
        offsetY: point.y - node.y,
      };
      canvasSetPointerCapture(wave, event.pointerId);
      event.preventDefault();
      renderCanvas();
      return;
    }

    // Plain left-click → loop region
    if (event.button === 0) {
      const start = canvasRegionFromPointer(event, node);
      const region = canvasSetRegion(node, "loop", start, start);
      canvasRegionDrag = { nodeId: node.id, regionId: region.id, start, purpose: "loop", canvas: wave, pointerId: event.pointerId };
      canvasSetPointerCapture(wave, event.pointerId);
      event.preventDefault();
      updateCanvasInspector("loop");
      drawCanvasWaveforms();
      return;
    }
    return;
  }

  const nodeEl = event.target.closest?.(".canvas-node[data-node-id]");
  if (!nodeEl || event.target.closest("button, input, textarea, .canvas-source-menu")) return;
  const node = canvasNodes.find((item) => item.id === nodeEl.dataset.nodeId);
  if (!node) return;
  closeCanvasSourceMenu();
  selectedCanvasNodeId = node.id;
  if (node.type === "sound") canvasLastSelectedSoundNodeId = node.id;
  const point = canvasPointFromEvent(event);
  canvasDrag = {
    nodeId: node.id,
    offsetX: point.x - node.x,
    offsetY: point.y - node.y,
  };
  canvasSetPointerCapture(nodeEl, event.pointerId);
  event.preventDefault();
  renderCanvas();
});

document.addEventListener("pointermove", (event) => {
  if (canvasFxCurveDrag) {
    const node = canvasNodes.find((item) => item.id === canvasFxCurveDrag.nodeId);
    if (node) canvasUpdateFilterCurveFromPointer(event, canvasFxCurveDrag.canvas, node);
    event.preventDefault();
    return;
  }

  if (canvasPanDrag) {
    const board = $("canvasBoard");
    if (!board) return;
    board.scrollLeft = canvasPanDrag.scrollLeft - (event.clientX - canvasPanDrag.startX);
    board.scrollTop = canvasPanDrag.scrollTop - (event.clientY - canvasPanDrag.startY);
    event.preventDefault();
    return;
  }

  if (canvasRegionDrag) {
    const node = canvasNodes.find((item) => item.id === canvasRegionDrag.nodeId);
    if (!node) return;
    const current = canvasRegionFromPointer(event, node);
    const start = Math.min(canvasRegionDrag.start, current);
    const end = Math.max(canvasRegionDrag.start, current);
    const region = (node.regions || []).find((item) => item.id === canvasRegionDrag.regionId);
    if (region) {
      region.startSec = start;
      region.endSec = end;
    }
    drawCanvasWaveforms();
    updateCanvasInspector(canvasRegionDrag.purpose);
    event.preventDefault();
    return;
  }

  if (!canvasDrag) return;
  const node = canvasNodes.find((item) => item.id === canvasDrag.nodeId);
  const nodeEl = document.querySelector(`.canvas-node[data-node-id="${CSS.escape(canvasDrag.nodeId)}"]`);
  const board = $("canvasBoard");
  if (!node || !nodeEl || !board) return;
  const maxX = Math.max(0, Math.max(board.scrollWidth / canvasZoom, 1800) - node.width - 8);
  const maxY = Math.max(0, Math.max(board.scrollHeight / canvasZoom, 1200) - node.height - 8);
  const point = canvasPointFromEvent(event);
  node.x = Math.min(Math.max(point.x - canvasDrag.offsetX, 8), maxX);
  node.y = Math.min(Math.max(point.y - canvasDrag.offsetY, 8), maxY);
  nodeEl.style.left = `${node.x}px`;
  nodeEl.style.top = `${node.y}px`;
  renderCanvasEdges();
  renderCanvasChainControls();
  event.preventDefault();
});

document.addEventListener("pointerup", async (event) => {
  if (canvasFxCurveDrag) {
    canvasReleasePointerCapture(canvasFxCurveDrag.canvas, canvasFxCurveDrag.pointerId);
    canvasFxCurveDrag = null;
    event.preventDefault();
  }
  if (canvasPanDrag) {
    canvasReleasePointerCapture($("canvasBoard"), canvasPanDrag.pointerId);
    canvasPanDrag = null;
  }
  if (canvasRegionDrag) {
    const drag = canvasRegionDrag;
    const node = canvasNodes.find((item) => item.id === canvasRegionDrag.nodeId);
    const region = (node?.regions || []).find((item) => item.id === canvasRegionDrag.regionId);
    const normalizedRegion = canvasNormalizedRegion(region);
    if (region && !normalizedRegion) canvasRemoveRegion(node, region.id);
    canvasReleasePointerCapture(drag.canvas, drag.pointerId);
    canvasRegionDrag = null;
    if (drag.purpose === "extract" && node && normalizedRegion) {
      try {
        await canvasExtractRegionFromNode(node, normalizedRegion);
      } catch (error) {
        finishWork("Extract Error", "bad", error.message);
      } finally {
        canvasRemoveRegion(node, normalizedRegion.id || region?.id);
      }
    }
    renderCanvas();
    event.preventDefault();
  }
  if (canvasDrag) {
    canvasSaveState();
    canvasDrag = null;
  }
});

$("playPauseBtn").addEventListener("click", async () => {
  const audio = $("audioPlayer");
  if (audio.paused) {
    await audio.play();
  } else {
    audio.pause();
  }
});

$("audioPlayer").addEventListener("play", () => {
  $("playPauseBtn").innerHTML = iconSvg("pause");
});
$("audioPlayer").addEventListener("pause", () => {
  $("playPauseBtn").innerHTML = iconSvg("play");
  document.querySelectorAll(".action-play").forEach(btn => {
    btn.innerHTML = iconSvg("play");
    btn.title = "Play";
    btn.setAttribute("aria-label", "Play");
  });
  // Reset petri playing states, stop animation, redraw waveforms
  stopPetriWaveformAnim();
  document.querySelectorAll(".petri-card.playing").forEach(c => {
    c.classList.remove("playing");
    const cv = c.querySelector(".petri-canvas");
    if (cv && cv._audioBuf) drawMiniWaveform(cv, cv._audioBuf);
  });
});
$("audioPlayer").addEventListener("loadedmetadata", () => {
  $("timeReadout").textContent = `0:00 / ${formatTime($("audioPlayer").duration)}`;
});
$("audioPlayer").addEventListener("timeupdate", () => {
  const audio = $("audioPlayer");
  if (Number.isFinite(audio.duration) && audio.duration > 0) {
    const playhead = $("playhead");
    playhead.value = String(Math.round((audio.currentTime / audio.duration) * 1000));
    syncRangeFill(playhead);
    $("timeReadout").textContent = `${formatTime(audio.currentTime)} / ${formatTime(audio.duration)}`;
  }
});
$("playhead").addEventListener("input", () => {
  const audio = $("audioPlayer");
  if (Number.isFinite(audio.duration) && audio.duration > 0) {
    audio.currentTime = (Number($("playhead").value) / 1000) * audio.duration;
  }
});

if (!$("serverUrl").value) $("serverUrl").value = window.location.origin;
setHelpMode(helpModeEnabled);
localStorage.removeItem("germinator-left-sidebar");
localStorage.removeItem("germinator-right-sidebar");
if (typeof setLeftSidebarCollapsed === "function") setLeftSidebarCollapsed(false);
setRightSidebarCollapsed(false);
canvasLoadState();
consumeAkousmaPromptHandoff();
// Microcosmos: hand the scope/world layer a curated slice of the shared engine so germs
// reuse the same assets, audio graph, master bus, generation, harvest, and
// lineage as the Chamber (see docs/one_bit_dish_plan.md).
oneBitDish = initOneBitDish({
  api,
  buildPayload: canvasBuildPayload,
  appendPayloadToForm,
  createAsset: canvasCreateAsset,
  assetById: canvasAssetById,
  outputUrl,
  ensureGermAudio: canvasEnsureNodeAudio,
  applyGermAudio: canvasApplyNodeAudioParams,
  disposeGermAudio: canvasDisposeNodeAudio,
  playbackContext: canvasPlaybackContext,
  ensureMasterBus: canvasEnsureMasterBus,
  masterBusInput: canvasMasterBusInput,
  importAudioBlob: canvasImportAudioBlob,
  smoothSet,
  // Lossless harvest: the dish records the master output as PCM → WAV when
  // the worklet tap is available (null → dish falls back to MediaRecorder).
  createMasterWavRecorder: async () => {
    const context = canvasPlaybackContext();
    const bus = canvasEnsureMasterBus();
    if (!context || !bus?.output) return null;
    return createWavRecorder(context, bus.output);
  },
  createSoundNode: ({ asset, label, edgeType, x, y, width, parentNodeId, region, metadata }) => {
    const node = canvasCreateSoundNode({ asset, label, edgeType, x, y, width, parentNodeId, region });
    if (node && metadata) {
      node.oneBit = metadata;
      renderCanvas();
    }
    return node;
  },
  createFxNode: ({ type, x, y, targetNode, label, params, metadata }) => {
    const node = canvasCreateFxNode(type, { x, y, targetNode });
    if (node) {
      if (label) node.label = label;
      if (params && typeof params === "object") node.params = { ...(node.params || {}), ...params };
      if (metadata) node.oneBit = metadata;
      renderCanvas();
    }
    return node;
  },
  saveCanvasState: canvasSaveState,
  activateTab,
  libraryItems: () => libraryItems,
  finishWork,
  escapeHtml,
  iconSvg,
  refreshAll,
  loadModel,
  updateModels,
});
loadSavedGroups();
const initialTab = new URLSearchParams(window.location.search).get("tab");
activateTab(initialTab || "chamber");
updateModels(false);
renderLayers();
renderCulture();
syncAllRangeFills(document);

let _germinatorMasterVolume = 1;
function applyMasterVolume(percent) {
  _germinatorMasterVolume = Math.max(0, Math.min(1, Number(percent) / 100));
  if (canvasMasterBus?.gain) smoothSet(canvasMasterBus.gain.gain, _germinatorMasterVolume, canvasMasterBus.context, SMOOTH_UI);
  document.querySelectorAll("audio").forEach((el) => {
    const own = el.dataset.ownVolume != null ? Number(el.dataset.ownVolume) : 1;
    el.volume = Math.max(0, Math.min(1, own * _germinatorMasterVolume));
  });
}
function germinatorMasterVolume() {
  return _germinatorMasterVolume;
}

// --- Master volume (hover popover with sticky-close so the user has time to
//     move from the icon to the slider) -----------------------------------
(() => {
  const control = document.getElementById("masterVolumeControl");
  const button = document.getElementById("masterVolumeBtn");
  const popover = document.getElementById("masterVolumePopover");
  const slider = document.getElementById("masterVolumeSlider");
  const readout = document.getElementById("masterVolumeReadout");
  if (!control || !button || !popover || !slider) return;
  const storedRaw = localStorage.getItem("germinator-master-volume");
  const stored = storedRaw == null || storedRaw === "" ? NaN : Number(storedRaw);
  const initial = Number.isFinite(stored) ? Math.max(0, Math.min(100, stored)) : 100;
  slider.value = String(initial);
  if (readout) readout.textContent = `${initial}%`;
  syncRangeFill(slider);
  applyMasterVolume(initial);

  let hideTimer = null;
  function show() {
    if (hideTimer) { clearTimeout(hideTimer); hideTimer = null; }
    popover.hidden = false;
    button.setAttribute("aria-expanded", "true");
  }
  function scheduleHide(delay = 1600) {
    if (hideTimer) clearTimeout(hideTimer);
    hideTimer = setTimeout(() => {
      popover.hidden = true;
      button.setAttribute("aria-expanded", "false");
      hideTimer = null;
    }, delay);
  }
  control.addEventListener("mouseenter", show);
  control.addEventListener("focusin", show);
  control.addEventListener("mouseleave", () => scheduleHide(1600));
  control.addEventListener("focusout", (event) => {
    if (!control.contains(event.relatedTarget)) scheduleHide(1600);
  });
  button.addEventListener("click", () => { show(); scheduleHide(2800); });
  slider.addEventListener("input", () => {
    const value = Math.max(0, Math.min(100, Number(slider.value) || 0));
    if (readout) readout.textContent = `${value}%`;
    applyMasterVolume(value);
    localStorage.setItem("germinator-master-volume", String(value));
    // Keep the popover up while the user is interacting.
    show(); scheduleHide(2200);
  });
})();
refreshAll();

/* Scroll-entry animations via IntersectionObserver */
(function initScrollEntry() {
  const targets = '.culture-board article, .petri-card, .layer-card, .library-item, .status-card';

  function applyScrollEntryClass() {
    document.querySelectorAll(targets).forEach((el) => {
      if (!el.classList.contains('scroll-entry') && !el.classList.contains('visible')) {
        el.classList.add('scroll-entry');
      }
    });
  }

  const observer = new IntersectionObserver(
    (entries) => {
      entries.forEach((entry) => {
        if (entry.isIntersecting) {
          entry.target.classList.add('visible');
          observer.unobserve(entry.target);
        }
      });
    },
    { threshold: 0.1, rootMargin: '0px 0px -40px 0px' },
  );

  function observeNew() {
    applyScrollEntryClass();
    document.querySelectorAll('.scroll-entry:not(.visible)').forEach((el) => observer.observe(el));
  }

  let observeFrame = null;
  function scheduleObserveNew() {
    if (observeFrame) return;
    observeFrame = requestAnimationFrame(() => {
      observeFrame = null;
      observeNew();
    });
  }

  /* Initial pass */
  observeNew();

  /* Re-observe when dynamic content is rendered */
  const workspace = document.querySelector('.workspace');
  if (workspace) {
    const mutationObs = new MutationObserver(scheduleObserveNew);
    mutationObs.observe(workspace, { childList: true, subtree: true });
  }
})();

/* ===================================================================
   Petri visualization — waveform + spectrogram per card
   =================================================================== */
async function fetchAudioBuffer(audioPath) {
  if (!audioPath) return null;
  if (petriAudioCache.has(audioPath)) return petriAudioCache.get(audioPath);
  const pending = fetch(outputUrl(audioPath))
    .then((resp) => {
      if (!resp.ok) throw new Error(`Audio not found: ${audioPath}`);
      return resp.arrayBuffer();
    })
    .then((buf) => decodeAudioArrayBuffer(buf));
  petriAudioCache.set(audioPath, pending);
  try {
    const decoded = await pending;
    petriAudioCache.delete(audioPath);
    petriAudioCache.set(audioPath, decoded);
    while (petriAudioCache.size > PETRI_AUDIO_CACHE_LIMIT) {
      petriAudioCache.delete(petriAudioCache.keys().next().value);
    }
    return decoded;
  } catch {
    petriAudioCache.delete(audioPath);
    return null;
  }
}

function resizeMiniCanvas(canvas) {
  const rect = canvas.getBoundingClientRect();
  const pixelRatio = Math.min(2, window.devicePixelRatio || 1);
  const rawW = rect.width || canvas.clientWidth || 300;
  const rawH = rect.height || canvas.clientHeight || 300;
  const isSquare = Math.abs(rawW - rawH) < 4;
  const dim = isSquare ? Math.max(rawW, rawH) : 0;
  const width = Math.max(100, Math.floor((dim || rawW) * pixelRatio));
  const height = Math.max(48, Math.floor((dim || rawH) * pixelRatio));
  if (canvas.width !== width) canvas.width = width;
  if (canvas.height !== height) canvas.height = height;
}

// --- Petri waveform playback animation ---
let _petriWaveformRAF = null;
let _petriWaveformCanvas = null;

function startPetriWaveformAnim(canvas, audioBuf, audioEl) {
  stopPetriWaveformAnim();
  _petriWaveformCanvas = canvas;
  function tick() {
    if (audioEl.paused || audioEl.ended) {
      stopPetriWaveformAnim();
      return;
    }
    const progress = audioEl.duration ? audioEl.currentTime / audioEl.duration : 0;
    drawMiniWaveform(canvas, audioBuf, "No audio", null, progress);
    _petriWaveformRAF = requestAnimationFrame(tick);
  }
  _petriWaveformRAF = requestAnimationFrame(tick);
}

function stopPetriWaveformAnim() {
  if (_petriWaveformRAF) {
    cancelAnimationFrame(_petriWaveformRAF);
    _petriWaveformRAF = null;
  }
  _petriWaveformCanvas = null;
}

// Cache the static (grey / green) waveform render per audio buffer so the
// playback animation only does cheap drawImage + clipped overlay calls
// instead of recomputing every column on every frame (eliminates jitter).
const _waveformRenderCache = new WeakMap();

function _renderWaveformLayer(audioBuffer, w, h, color, isDark) {
  const off = document.createElement("canvas");
  off.width = w;
  off.height = h;
  const ctx = off.getContext("2d");
  ctx.fillStyle = isDark ? "#1e1e1e" : "#f8f8f8";
  ctx.fillRect(0, 0, w, h);
  ctx.strokeStyle = isDark ? "rgba(255,255,255,0.06)" : "rgba(40,40,40,0.05)";
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(0, h / 2);
  ctx.lineTo(w, h / 2);
  ctx.stroke();
  const data = audioBuffer.getChannelData(0);
  const cols = Math.max(24, Math.min(220, Math.floor(w / 2)));
  const step = Math.max(1, Math.floor(data.length / cols));
  let peak = 0;
  const points = [];
  for (let col = 0; col < cols; col += 1) {
    const offset = col * step;
    let mn = 1;
    let mx = -1;
    for (let i = 0; i < step && offset + i < data.length; i++) {
      const sample = data[offset + i];
      mn = Math.min(mn, sample);
      mx = Math.max(mx, sample);
      peak = Math.max(peak, Math.abs(sample));
    }
    points.push({ min: mn === 1 ? 0 : mn, max: mx === -1 ? 0 : mx });
  }
  const amp = peak > 0.001 ? Math.min(2.2, 0.82 / peak) : 1;
  const pad = h * 0.18;
  const usable = h - pad * 2;
  const mid = h / 2;
  const xFor = (index) => (index / Math.max(1, cols - 1)) * w;
  const topFor = (point) => pad + ((1 - point.max * amp) * usable) / 2;
  const bottomFor = (point) => pad + ((1 - point.min * amp) * usable) / 2;
  const drawSmooth = (selector, reverse = false) => {
    const indexes = [...points.keys()];
    if (reverse) indexes.reverse();
    indexes.forEach((pointIndex, orderIndex) => {
      const x = xFor(pointIndex);
      const y = selector(points[pointIndex]);
      if (orderIndex === 0) ctx.lineTo(x, y);
      else {
        const prevIndex = indexes[orderIndex - 1];
        const prevX = xFor(prevIndex);
        const prevY = selector(points[prevIndex]);
        ctx.quadraticCurveTo(prevX, prevY, (prevX + x) / 2, (prevY + y) / 2);
      }
    });
  };
  ctx.fillStyle = color;
  ctx.globalAlpha = 0.13;
  ctx.beginPath();
  ctx.moveTo(0, mid);
  drawSmooth(topFor);
  drawSmooth(bottomFor, true);
  ctx.closePath();
  ctx.fill();
  ctx.globalAlpha = 1;
  ctx.strokeStyle = color;
  ctx.lineWidth = 1.35;
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  ctx.beginPath();
  ctx.moveTo(0, topFor(points[0]));
  drawSmooth(topFor);
  ctx.stroke();
  ctx.beginPath();
  ctx.moveTo(0, bottomFor(points[0]));
  drawSmooth(bottomFor);
  ctx.stroke();
  return off;
}

function _getWaveformLayers(audioBuffer, w, h, isDark, strokeColor) {
  const key = `${w}x${h}x${isDark ? 1 : 0}x${strokeColor || ""}`;
  const cached = _waveformRenderCache.get(audioBuffer);
  if (cached && cached.key === key) return cached;
  const defaultColor = strokeColor || (isDark ? "rgba(160, 160, 160, 0.78)" : "rgba(88, 96, 88, 0.70)");
  const greenColor = isDark ? "#7ac47a" : "#3a6b3a";
  const entry = {
    key,
    base: _renderWaveformLayer(audioBuffer, w, h, defaultColor, isDark),
    progress: _renderWaveformLayer(audioBuffer, w, h, greenColor, isDark),
  };
  _waveformRenderCache.set(audioBuffer, entry);
  return entry;
}

function drawMiniWaveform(canvas, audioBuffer, emptyLabel = "No audio", strokeColor = null, progress = -1) {
  resizeMiniCanvas(canvas);
  const ctx = canvas.getContext("2d");
  const w = canvas.width;
  const h = canvas.height;
  const isDark = document.documentElement.getAttribute("data-theme") === "dark";
  ctx.clearRect(0, 0, w, h);
  if (!audioBuffer) {
    ctx.fillStyle = isDark ? "#1e1e1e" : "#f8f8f8";
    ctx.fillRect(0, 0, w, h);
    ctx.fillStyle = isDark ? "#555" : "#bbb";
    ctx.font = "11px system-ui";
    ctx.textAlign = "center";
    ctx.fillText(emptyLabel, w / 2, h / 2 + 3);
    ctx.textAlign = "start";
    return;
  }
  const layers = _getWaveformLayers(audioBuffer, w, h, isDark, strokeColor);
  ctx.drawImage(layers.base, 0, 0);
  if (progress >= 0) {
    const splitX = Math.max(0, Math.min(w, Math.floor(progress * w)));
    if (splitX > 0) {
      ctx.save();
      ctx.beginPath();
      ctx.rect(0, 0, splitX, h);
      ctx.clip();
      ctx.drawImage(layers.progress, 0, 0);
      ctx.restore();
    }
  }
}

function drawMiniSpectrogram(canvas, audioBuffer, emptyLabel = "No audio") {
  resizeMiniCanvas(canvas);
  const ctx = canvas.getContext("2d");
  const w = canvas.width;
  const h = canvas.height;
  const isDark = document.documentElement.getAttribute("data-theme") === "dark";
  ctx.clearRect(0, 0, w, h);
  ctx.fillStyle = isDark ? "#1e1e1e" : "#f8f8f8";
  ctx.fillRect(0, 0, w, h);
  if (!audioBuffer) {
    ctx.fillStyle = isDark ? "#555" : "#bbb";
    ctx.font = "11px system-ui";
    ctx.textAlign = "center";
    ctx.fillText(emptyLabel, w / 2, h / 2 + 3);
    ctx.textAlign = "start";
    return;
  }
  const data = audioBuffer.getChannelData(0);
  const fftSize = Math.max(64, Math.min(256, 2 ** Math.floor(Math.log2(Math.max(64, data.length)))));
  const bins = fftSize / 2;
  const cols = Math.max(1, Math.min(220, Math.floor(w), Math.floor(data.length / Math.max(1, fftSize / 4))));
  const hopSize = cols > 1 ? Math.max(1, Math.floor((data.length - fftSize) / (cols - 1))) : fftSize;
  const img = ctx.createImageData(cols, bins);
  const rowEnergy = new Float32Array(bins);
  const re = new Float32Array(fftSize);
  const im = new Float32Array(fftSize);

  function fftFrame(offset) {
    re.fill(0);
    im.fill(0);
    for (let i = 0; i < fftSize; i += 1) {
      const sample = data[offset + i] || 0;
      re[i] = sample * (0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (fftSize - 1)));
    }
    for (let i = 1, j = 0; i < fftSize; i += 1) {
      let bit = fftSize >> 1;
      for (; j & bit; bit >>= 1) j ^= bit;
      j ^= bit;
      if (i < j) {
        const tr = re[i];
        re[i] = re[j];
        re[j] = tr;
      }
    }
    for (let len = 2; len <= fftSize; len <<= 1) {
      const angle = (-2 * Math.PI) / len;
      const wLenR = Math.cos(angle);
      const wLenI = Math.sin(angle);
      for (let i = 0; i < fftSize; i += len) {
        let wr = 1;
        let wi = 0;
        const half = len >> 1;
        for (let j = 0; j < half; j += 1) {
          const uR = re[i + j];
          const uI = im[i + j];
          const vR = re[i + j + half] * wr - im[i + j + half] * wi;
          const vI = re[i + j + half] * wi + im[i + j + half] * wr;
          re[i + j] = uR + vR;
          im[i + j] = uI + vI;
          re[i + j + half] = uR - vR;
          im[i + j + half] = uI - vI;
          const nextWr = wr * wLenR - wi * wLenI;
          wi = wr * wLenI + wi * wLenR;
          wr = nextWr;
        }
      }
    }
  }

  function paintPixel(idx, value) {
    const v = Math.pow(Math.max(0, Math.min(1, value)), 0.72);
    if (isDark) {
      img.data[idx] = Math.round(18 + 110 * v);
      img.data[idx + 1] = Math.round(22 + 166 * v);
      img.data[idx + 2] = Math.round(20 + 124 * v);
    } else {
      img.data[idx] = Math.round(248 - 178 * v + 34 * Math.max(0, v - 0.76));
      img.data[idx + 1] = Math.round(248 - 86 * v);
      img.data[idx + 2] = Math.round(244 - 164 * v);
    }
    img.data[idx + 3] = 255;
  }

  for (let col = 0; col < cols; col++) {
    const offset = Math.max(0, Math.min(data.length - fftSize, col * hopSize));
    fftFrame(offset);
    for (let row = 0; row < bins; row += 1) {
      const normalized = 1 - row / Math.max(1, bins - 1);
      const bin = Math.min(bins - 1, Math.floor((bins - 1) * normalized * normalized));
      const mag = Math.sqrt(re[bin] * re[bin] + im[bin] * im[bin]) / fftSize;
      const energy = (20 * Math.log10(mag + 1e-7) + 84) / 58;
      rowEnergy[row] = Math.max(rowEnergy[row], energy);
      paintPixel((row * cols + col) * 4, energy);
    }
  }
  const tmpCanvas = document.createElement("canvas");
  tmpCanvas.width = cols;
  tmpCanvas.height = bins;
  tmpCanvas.getContext("2d").putImageData(img, 0, 0);
  ctx.imageSmoothingEnabled = true;
  const maxEnergy = Math.max(...rowEnergy);
  let cropTop = 0;
  let cropBottom = bins - 1;
  if (maxEnergy > 0.04) {
    const threshold = Math.max(0.035, maxEnergy * 0.16);
    while (cropTop < cropBottom && rowEnergy[cropTop] < threshold) cropTop += 1;
    while (cropBottom > cropTop && rowEnergy[cropBottom] < threshold) cropBottom -= 1;
    const pad = Math.max(4, Math.round((cropBottom - cropTop + 1) * 0.22));
    cropTop = Math.max(0, cropTop - pad);
    cropBottom = Math.min(bins - 1, cropBottom + pad);
  } else {
    cropTop = Math.round(bins * 0.08);
    cropBottom = Math.round(bins * 0.84);
  }
  const cropHeight = Math.max(1, cropBottom - cropTop + 1);
  ctx.drawImage(tmpCanvas, 0, cropTop, cols, cropHeight, 0, 0, w, h);
}

async function drawPetriCanvas(canvas) {
  const mode = $("petriViz")?.value || "waveform";
  const audioPath = canvas.dataset.audio;
  if (canvas.dataset.renderedAudio === audioPath && canvas.dataset.renderedMode === mode) return;
  if (!audioPath) {
    drawMiniWaveform(canvas, null);
    canvas.dataset.renderedAudio = "";
    canvas.dataset.renderedMode = mode;
    return;
  }
  const buf = await fetchAudioBuffer(audioPath);
  canvas._audioBuf = buf; // cache for re-drawing with different colors
  const emptyLabel = audioPath ? "Unavailable" : "No audio";
  if (mode === "spectrogram") drawMiniSpectrogram(canvas, buf, emptyLabel);
  else drawMiniWaveform(canvas, buf, emptyLabel);
  canvas.dataset.renderedAudio = audioPath;
  canvas.dataset.renderedMode = mode;
}

function ensurePetriCanvasObserver() {
  if (petriCanvasObserver || typeof IntersectionObserver === "undefined") return petriCanvasObserver;
  petriCanvasObserver = new IntersectionObserver(
    (entries) => {
      for (const entry of entries) {
        if (!entry.isIntersecting) continue;
        petriCanvasObserver.unobserve(entry.target);
        drawPetriCanvas(entry.target);
      }
    },
    { rootMargin: "220px 0px", threshold: 0.01 },
  );
  return petriCanvasObserver;
}

function renderPetriCanvases() {
  const activePanel = document.querySelector("#tab-petri.active") || document.querySelector(".tab-panel.active:not(.canvas-panel)");
  const canvases = activePanel
    ? activePanel.querySelectorAll(".petri-canvas[data-audio]")
    : document.querySelectorAll(".petri-canvas[data-audio]");
  if (petriCanvasObserver) petriCanvasObserver.disconnect();
  const observer = ensurePetriCanvasObserver();
  for (const canvas of canvases) {
    if (canvas.offsetParent === null) continue;
    const mode = $("petriViz")?.value || "waveform";
    if (canvas.dataset.renderedAudio !== canvas.dataset.audio || canvas.dataset.renderedMode !== mode) {
      drawMiniWaveform(canvas, null, "Loading…");
    }
    if (observer) observer.observe(canvas);
    else drawPetriCanvas(canvas);
  }
}

if ($("petriViz")) {
  $("petriViz").addEventListener("change", () => {
    document.querySelectorAll(".petri-canvas").forEach((canvas) => {
      canvas.dataset.renderedMode = "";
    });
    renderPetriCanvases();
  });
}

// View toggle button (waveform ↔ spectrogram)
if ($("petriVizToggle")) {
  $("petriVizToggle").addEventListener("click", () => {
    const sel = $("petriViz");
    if (!sel) return;
    const isWave = sel.value === "waveform";
    sel.value = isWave ? "spectrogram" : "waveform";
    $("petriVizIconWave").style.display = isWave ? "none" : "";
    $("petriVizIconSpec").style.display = isWave ? "" : "none";
    sel.dispatchEvent(new Event("change"));
  });
}

// Search popover toggle
if ($("petriSearchToggle")) {
  $("petriSearchToggle").addEventListener("click", (e) => {
    e.stopPropagation();
    const pop = $("petriSearchPopover");
    if (!pop) return;
    const show = pop.hidden;
    pop.hidden = !show;
    if (show) {
      requestAnimationFrame(() => $("libSearch")?.focus());
    }
  });
  document.addEventListener("click", (e) => {
    const pop = $("petriSearchPopover");
    if (!pop || pop.hidden) return;
    if (!e.target.closest(".petri-search-control")) {
      pop.hidden = true;
    }
  });
}

/* renderPetri / renderHerbarium already schedule their own canvas redraws. */

/* ===================================================================
   Variations popover toggle + spinner
   =================================================================== */
document.addEventListener("click", (e) => {
  // Spinner +/- buttons
  const spinBtn = e.target.closest(".wave-var-spin-btn");
  if (spinBtn) {
    e.stopPropagation();
    const spinner = spinBtn.closest(".wave-var-spinner");
    const valEl = spinner?.querySelector(".wave-var-spin-val");
    if (valEl) {
      const cur = Number(valEl.textContent) || 1;
      const delta = Number(spinBtn.dataset.spin) || 0;
      valEl.textContent = Math.max(1, Math.min(5, cur + delta));
    }
    return;
  }
  // "Go" button — reads spinner val and fires canvas-variations
  const goBtn = e.target.closest(".wave-var-go");
  if (goBtn) {
    const spinner = goBtn.closest(".wave-var-row")?.querySelector(".wave-var-spin-val");
    const count = Number(spinner?.textContent) || 1;
    goBtn.dataset.count = count;
    goBtn.closest(".wave-variations-popover")?.setAttribute("hidden", "");
    // Don't stop propagation — let the delegated data-action handler fire
  }
  // Menu option clicks — close popover, let data-action bubble
  const menuOpt = e.target.closest(".wave-var-menu-opt");
  if (menuOpt) {
    menuOpt.closest(".wave-variations-popover")?.setAttribute("hidden", "");
  }
  const regionOpt = e.target.closest(".wave-region-opt, .wave-region-command");
  if (regionOpt) {
    regionOpt.closest(".wave-variations-popover")?.setAttribute("hidden", "");
  }
  const varBtn = e.target.closest(".wave-variations-btn");
  if (varBtn) {
    e.stopPropagation();
    const pop = varBtn.nextElementSibling;
    if (pop && pop.classList.contains("wave-variations-popover")) {
      document.querySelectorAll(".wave-variations-popover").forEach(p => {
        if (p !== pop) p.hidden = true;
      });
      pop.hidden = !pop.hidden;
    }
    return;
  }
  const knobBtn = e.target.closest(".wave-knob-btn");
  if (knobBtn) {
    e.stopPropagation();
    return;
  }
  // Close all popups when clicking elsewhere
  if (!e.target.closest(".wave-variations-popover, .wave-knob-popup")) {
    document.querySelectorAll(".wave-variations-popover").forEach(p => p.hidden = true);
  }
});

/* ===================================================================
   Colony UI handlers
   =================================================================== */
document.addEventListener("change", (e) => {
  const rackFilename = e.target.closest(".rack-filename-input[data-key]");
  if (rackFilename) {
    const item = rackItemByKey(rackFilename.dataset.key);
    if (item) {
      const currentStem = getFilenameStem(item.audio_file);
      const newStem = rackFilename.value.trim();
      if (newStem && newStem !== currentStem) {
        renameFile(item.audio_file, item.metadata_file, newStem)
          .catch((error) => finishWork("Rack Error", "bad", error.message));
      } else {
        rackFilename.value = currentStem;
      }
    }
    return;
  }
  const rackPrompt = e.target.closest(".rack-prompt-input[data-key]");
  if (rackPrompt) {
    const item = rackItemByKey(rackPrompt.dataset.key);
    if (item) {
      rackUpdateItemMetadata(item, { prompt: rackPrompt.value })
        .then(() => refreshLibrary(false))
        .catch((error) => finishWork("Rack Error", "bad", error.message));
    }
    return;
  }
  const rackTags = e.target.closest(".rack-tags-input[data-key]");
  if (rackTags) {
    const item = rackItemByKey(rackTags.dataset.key);
    if (item) {
      rackUpdateItemMetadata(item, { tags: parseTags(rackTags.value) })
        .then(() => refreshLibrary(false))
        .catch((error) => finishWork("Rack Error", "bad", error.message));
    }
    return;
  }
  if (handleCanvasModulatorControl(e)) return;
  if (handleCanvasGeneticControl(e)) return;
  if (handleAudioSnapshotControl(e)) return;
  const incubationEventParam = e.target.closest(".time-incubation-event-param[data-node-id][data-event-id][data-param]");
  if (incubationEventParam) {
    updateIncubationTimelineParam(incubationEventParam);
    return;
  }
  const incubationSourceParam = e.target.closest(".time-incubation-source-param[data-node-id][data-source-id][data-param]");
  if (incubationSourceParam) {
    updateIncubationSourceParam(incubationSourceParam);
    return;
  }
  const timeSetting = e.target.closest(".time-node-setting[data-node-id][data-field]");
  if (timeSetting) {
    const node = canvasNodes.find((item) => item.id === timeSetting.dataset.nodeId);
    if (node?.type === "time") {
      const field = timeSetting.dataset.field;
      const numericFields = new Set([
        "sliceCount",
        "steps",
        "pulses",
        "rotation",
        "probability",
        "targetBars",
        "velocity",
        "skipEvery",
        "seed",
        "density",
        "timing",
        "velocitySpread",
      ]);
      node[field] = numericFields.has(field) ? Number(timeSetting.value) : timeSetting.value;
      const index = canvasNodes.findIndex((item) => item.id === node.id);
      canvasNodes[index] = normalizeTimeNode(node);
      selectedCanvasNodeId = node.id;
      renderCanvas();
      return;
    }
  }
  const promptSelect = e.target.closest(".canvas-prompt-setting[data-node-id][data-field]");
  if (promptSelect) {
    const node = canvasNodes.find((item) => item.id === promptSelect.dataset.nodeId);
    if (node?.type === "prompt") {
      const field = promptSelect.dataset.field;
      const numericValue = Number(promptSelect.value);
      node[field] = ["durationSec", "seed", "mutation"].includes(field) && Number.isFinite(numericValue)
        ? numericValue
        : promptSelect.value;
      Object.assign(node, canvasNormalizePromptSettings(node));
      selectedCanvasNodeId = node.id;
      canvasSaveState();
      renderCanvas();
    }
  }
  const variationMutation = e.target.closest(".wave-var-mutation[data-node-id]");
  if (variationMutation) {
    const node = canvasNodes.find((item) => item.id === variationMutation.dataset.nodeId);
    if (node) {
      node.variationMutation = mutationPresetForValue(Number(variationMutation.value)).value;
      canvasSaveState();
    }
  }
  const cb = e.target.closest(".canvas-colony-checkbox");
  if (cb) {
    const node = canvasNodes.find((n) => n.id === cb.dataset.nodeId);
    if (node) {
      node.colonyEnabled = cb.checked;
      selectedCanvasNodeId = node.id;
      canvasSaveState();
      renderCanvas();
    }
  }
});

document.addEventListener("click", (e) => {
  const countBtn = e.target.closest(".canvas-colony-count");
  if (countBtn) {
    const node = canvasNodes.find((n) => n.id === countBtn.dataset.nodeId);
    if (node) {
      node.colonyCandidates = Number(countBtn.dataset.count);
      selectedCanvasNodeId = node.id;
      canvasSaveState();
      renderCanvas();
    }
  }
});


/* ===================================================================
   Knob slider input handler (volume & pan)
   =================================================================== */
document.addEventListener("input", (e) => {
  const slider = e.target.closest(".wave-knob-slider");
  if (!slider) return;
  const nodeId = slider.dataset.nodeId;
  const param = slider.dataset.param;
  const node = canvasNodes.find((n) => n.id === nodeId);
  if (!node) return;
  if (param === "volume") {
    node.volume = Number(slider.value) / 100;
    canvasApplyNodeAudioParams(node);
  } else if (param === "pan") {
    node.pan = Number(slider.value) / 100;
    canvasApplyNodeAudioParams(node);
  }
  canvasSaveState();
});

/* ===================================================================
   Canvas node help-mode hover text
   =================================================================== */
document.addEventListener("mouseover", (e) => {
  if (!helpModeEnabled) return;
  const helpEl = e.target.closest?.("[data-help]");
  const nodeEl = e.target.closest?.(".canvas-node.sound-node");
  if (helpEl && nodeEl) {
    const nodeId = nodeEl.dataset.nodeId;
    const readout = nodeEl.querySelector(".canvas-node-help");
    if (readout) readout.textContent = helpEl.dataset.help;
  }
});

document.addEventListener("mouseout", (e) => {
  const nodeEl = e.target.closest?.(".canvas-node.sound-node");
  if (nodeEl && !nodeEl.contains(e.relatedTarget)) {
    const readout = nodeEl.querySelector(".canvas-node-help");
    if (readout) readout.textContent = "";
  }
});

/* ===================================================================
   Ctrl-held cursor feedback (move mode indicator)
   =================================================================== */
document.addEventListener("keydown", (e) => {
  if (e.key === "Control" || e.key === "Meta") {
    document.body.classList.add("ctrl-held");
  }
});
document.addEventListener("keyup", (e) => {
  if (e.key === "Control" || e.key === "Meta") {
    document.body.classList.remove("ctrl-held");
  }
});
window.addEventListener("blur", () => {
  document.body.classList.remove("ctrl-held");
});

/* ===================================================================
   Lock zoom toggle
   =================================================================== */
if ($("canvasLockZoomBtn")) {
  $("canvasLockZoomBtn").addEventListener("click", () => {
    canvasZoomLocked = !canvasZoomLocked;
    $("lockZoomUnlocked").style.display = canvasZoomLocked ? "none" : "";
    $("lockZoomLocked").style.display = canvasZoomLocked ? "" : "none";
    $("canvasLockZoomBtn").title = canvasZoomLocked ? "Unlock zoom" : "Lock zoom";
    $("canvasLockZoomBtn").classList.toggle("active", canvasZoomLocked);
  });
}

/* ===================================================================
   Orientation toggle (horizontal ↔ vertical waveforms)
   =================================================================== */
if ($("orientationToggle")) {
  // Restore saved orientation
  const savedOrient = localStorage.getItem("germinator-orientation");
  if (savedOrient === "vertical") {
    document.body.classList.add("canvas-vertical");
    $("orientIconH").style.display = "none";
    $("orientIconV").style.display = "";
    $("orientationToggle").title = "Vertical mode";
  }

  $("orientationToggle").addEventListener("click", () => {
    const isVertical = document.body.classList.toggle("canvas-vertical");
    $("orientIconH").style.display = isVertical ? "none" : "";
    $("orientIconV").style.display = isVertical ? "" : "none";
    $("orientationToggle").title = isVertical ? "Vertical mode" : "Horizontal mode";
    localStorage.setItem("germinator-orientation", isVertical ? "vertical" : "horizontal");
    // Redraw all chamber waveforms with new orientation after CSS settles
    requestAnimationFrame(() => {
      if (typeof drawCanvasWaveforms === "function") drawCanvasWaveforms();
    });
  });
}

/* ===================================================================
   Shape toggle (square ↔ circular modules)
   =================================================================== */
if ($("canvasShapeToggle")) {
  const savedShape = localStorage.getItem("germinator-shape");
  if (savedShape === "circular") {
    document.body.classList.add("canvas-circular-mode");
    $("shapeIconSquare").style.display = "none";
    $("shapeIconCircle").style.display = "";
    $("canvasShapeToggle").title = "Circular modules";
  }

  $("canvasShapeToggle").addEventListener("click", () => {
    const isCircular = document.body.classList.toggle("canvas-circular-mode");
    $("shapeIconSquare").style.display = isCircular ? "none" : "";
    $("shapeIconCircle").style.display = isCircular ? "" : "none";
    $("canvasShapeToggle").title = isCircular ? "Circular modules" : "Square modules";
    localStorage.setItem("germinator-shape", isCircular ? "circular" : "square");
    requestAnimationFrame(() => {
      if (typeof drawCanvasWaveforms === "function") drawCanvasWaveforms();
    });
  });
}

function updateCanvasVisualModeButton() {
  const isSpec = canvasVisualMode === "spectrogram";
  const button = $("canvasSpectrogramToggle");
  if ($("canvasVizIconWave")) $("canvasVizIconWave").style.display = isSpec ? "none" : "";
  if ($("canvasVizIconSpec")) $("canvasVizIconSpec").style.display = isSpec ? "" : "none";
  if (button) {
    button.title = isSpec ? "Spectrogram view" : "Waveform view";
    button.classList.toggle("active", isSpec);
  }
}

updateCanvasVisualModeButton();
if ($("canvasSpectrogramToggle")) {
  $("canvasSpectrogramToggle").addEventListener("click", () => {
    canvasVisualMode = canvasVisualMode === "spectrogram" ? "waveform" : "spectrogram";
    localStorage.setItem("germinator-canvas-visual-mode", canvasVisualMode);
    updateCanvasVisualModeButton();
    document.querySelectorAll(".canvas-node-waveform").forEach((canvas) => {
      canvas.dataset.renderedMode = "";
    });
    drawCanvasWaveforms();
  });
}

/* ===================================================================
   Bottom player — loop, download, send-to, metadata drawer
   =================================================================== */
if ($("loopToggle")) {
  $("loopToggle").addEventListener("click", () => {
    const audio = $("audioPlayer");
    audio.loop = !audio.loop;
    $("loopToggle").classList.toggle("active", audio.loop);
  });
}

if ($("downloadBtn")) {
  $("downloadBtn").addEventListener("click", () => {
    const path = $("audioPath")?.value;
    if (!path) return;
    const a = document.createElement("a");
    a.href = outputUrl(path);
    a.download = path.split("/").pop() || "download.wav";
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
  });
}

if ($("sendToMenu")) {
  $("sendToMenu").addEventListener("click", (e) => {
    e.stopPropagation();
    const dd = $("sendToDropdown");
    dd.style.display = dd.style.display === "none" ? "block" : "none";
  });
}

document.addEventListener("click", () => {
  const dd = $("sendToDropdown");
  if (dd) dd.style.display = "none";
});

if ($("sendToDropdown")) {
  $("sendToDropdown").addEventListener("click", (e) => {
    const btn = e.target.closest("[data-send]");
    if (!btn) return;
    e.stopPropagation();
    const target = btn.dataset.send;
    const audioPath = $("audioPath")?.value;
    if (!audioPath) return;
    if (target === "chamber") {
      canvasAddAudioReference({
        audioPath,
        metadataPath: $("metadataPath")?.value || "",
        metadata: currentTrack?.metadata || {},
        origin: canvasOriginFromItem(currentTrack?.metadata || {}),
        label: displayNameFromPath(audioPath),
      }, canvasBoardDefaultPoint());
      activateTab("chamber");
      setState("Track Added", "ok", audioPath);
    } else if (target === "culture") {
      if (audioPath) manualCultureCandidateIds.push(audioPath);
      renderCulture();
      activateTab("petri");
    } else if (target === "petri") {
      refreshLibrary(false);
      activateTab("petri");
    }
    $("sendToDropdown").style.display = "none";
  });
}

if ($("metadataToggle")) {
  $("metadataToggle").addEventListener("click", () => {
    const panel = $("metadataPanel");
    panel.style.display = panel.style.display === "none" ? "block" : "none";
  });
}

/* ESC to close floating panels and source menu */
document.addEventListener("keydown", (event) => {
  if (event.key !== "Escape") return;
  const openPanel = document.querySelector(".tab-panel:not(.canvas-panel).active");
  if (openPanel) {
    closeFloatingPanel();
    event.preventDefault();
    return;
  }
  const snapModal = $("snapshotLibraryModal");
  if (snapModal && !snapModal.hidden) {
    closeSnapshotLibrary();
    event.preventDefault();
    return;
  }
  const sourceMenu = $("canvasSourceMenu");
  if (sourceMenu && !sourceMenu.hidden) {
    closeCanvasSourceMenu();
    event.preventDefault();
    return;
  }
  const modal = document.querySelector(".canvas-modal:not([hidden])");
  if (modal) {
    modal.hidden = true;
    event.preventDefault();
  }
});
