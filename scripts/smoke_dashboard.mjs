import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

const root = path.resolve(new URL("..", import.meta.url).pathname);
const dashboardDir = path.join(root, "dashboard", "static");

function read(relativePath) {
  return fs.readFileSync(path.join(root, relativePath), "utf8");
}

async function loadDashboardModule(filename) {
  return import(pathToFileURL(path.join(dashboardDir, filename)).href);
}

function checkJsSyntax() {
  for (const file of fs.readdirSync(dashboardDir).filter((item) => item.endsWith(".js"))) {
    execFileSync("node", ["--check", path.join(dashboardDir, file)], { stdio: "pipe" });
  }
}

function checkDuplicateIds() {
  const html = read("dashboard/static/index.html");
  const ids = [...html.matchAll(/\sid="([^"]+)"/g)].map((match) => match[1]);
  const counts = new Map();
  ids.forEach((id) => counts.set(id, (counts.get(id) || 0) + 1));
  const duplicates = [...counts.entries()].filter(([, count]) => count > 1);
  assert.equal(duplicates.length, 0, `duplicate ids: ${JSON.stringify(duplicates)}`);
  assert.ok(ids.length > 250, "dashboard should expose the expected app surface");
}

function checkCssVars() {
  const css = read("dashboard/static/styles.css");
  const refs = [...css.matchAll(/var\((--[A-Za-z0-9_-]+)/g)].map((match) => match[1]);
  const defs = new Set([...css.matchAll(/(^|[\s;{])(--[A-Za-z0-9_-]+)\s*:/gm)].map((match) => match[2]));
  const missing = [...new Set(refs.filter((name) => !defs.has(name)))];
  assert.equal(missing.length, 0, `missing CSS variables: ${missing.join(", ")}`);
  assert.ok(refs.length > 1000, "CSS variable scan should cover the full dashboard stylesheet");
}

function checkResponsiveAssetContracts() {
  const html = read("dashboard/static/index.html");
  const css = read("dashboard/static/styles.css");
  assert.match(
    html,
    /styles\.css\?v=20260730-cosmo-matter-p2/,
    "Dashboard should request the current stylesheet cache key",
  );
  assert.match(
    html,
    /app\.js\?v=20260731-audit-p1/,
    "Dashboard should request the current app script cache key",
  );
  const appSource = read("dashboard/static/app.js");
  assert.match(
    appSource,
    /api\("\/metadata\/read",/,
    "Dashboard metadata reads should use the origin-protected API route",
  );
  assert.match(
    appSource,
    /audio_engine\.js\?v=20260731-audit-p1/,
    "App should import the current audio engine cache key",
  );
  assert.match(
    appSource,
    /dish\.js\?v=20260706-engine-p1/,
    "App should import the current dish cache key",
  );
  assert.match(
    css,
    /@media \(max-width: 760px\)[\s\S]*body\.canvas-active #tab-petri\.active\s*{[\s\S]*bottom:\s*calc\(174px \+ env\(safe-area-inset-bottom\)\)/,
    "Mobile Petri panel should reserve clearance above the wrapped transport bar",
  );
}

function loadMicroRender() {
  const source = read("dashboard/static/micro_render.js").replaceAll("export ", "");
  return new Function(`${source}\nreturn { lodBucket, SpriteCache, createMicroRenderer, GERM_FORMS, MODULE_FORMS };`)();
}

function fakeCtx() {
  return {
    save() {},
    restore() {},
    translate() {},
    rotate() {},
    scale() {},
    clearRect() {},
    fillRect() {},
    beginPath() {},
    arc() {},
    fill() {},
    stroke() {},
    moveTo() {},
    lineTo() {},
    drawImage() {},
    setTransform() {},
  };
}

function checkMicroRenderer() {
  const { lodBucket, SpriteCache, createMicroRenderer, GERM_FORMS } = loadMicroRender();
  assert.equal(lodBucket(0.24).index, 0);
  assert.ok(lodBucket(2.6).index >= lodBucket(0.24).index);

  const surfaces = [];
  const cache = new SpriteCache({
    maxEntries: 2,
    createSurface: (w, h) => {
      const surface = { canvas: { width: w, height: h }, ctx: fakeCtx(), w, h };
      surfaces.push(surface);
      return surface;
    },
  });
  assert.ok(cache.get("a", 10, 10, () => {}));
  assert.ok(cache.get("a", 10, 10, () => {}));
  assert.equal(cache.hits, 1);
  assert.equal(cache.misses, 1);
  cache.get("b", 10, 10, () => {});
  cache.get("c", 10, 10, () => {});
  assert.equal(cache.map.size, 2);
  assert.equal(surfaces.length, 3);

  GERM_FORMS.pytest = (ctx) => {
    ctx.fillRect(0, 0, 1, 1);
  };
  const rendererCache = new SpriteCache({
    createSurface: (w, h) => ({ canvas: { width: w, height: h }, ctx: fakeCtx(), w, h }),
  });
  const renderer = createMicroRenderer({
    getCtx: () => fakeCtx(),
    getDpr: () => 1,
    getDark: () => false,
    cache: rendererCache,
  });
  renderer.beginFrame();
  assert.equal(renderer.blitForm(GERM_FORMS, "pytest", 12, 20, 20, { state: "living" }), true);
  assert.equal(renderer.blitForm(GERM_FORMS, "missing", 12, 20, 20, {}), false);
  const stats = renderer.cacheStats();
  assert.equal(stats.entries, 1);
  assert.equal(stats.frameDraws, 1);
}

function checkWavetableContracts() {
  const html = read("dashboard/static/index.html");
  const app = read("dashboard/static/app.js");
  const synth = read("dashboard/static/wavetable_synth.js");
  assert.match(html, /data-source="germ"/, "Germ source card should be present");
  assert.match(html, /data-source="wavetable_forge"/, "Wavetable Forge card should be present");
  assert.match(app, /type: "germ"/, "Germ node type should be normalized");
  assert.match(app, /type: "wavetable_forge"/, "Wavetable Forge node type should be normalized");
  assert.match(app, /wavetable-asset-use/, "Wavetable library should expose Use in Germ actions");
  assert.match(app, /mutationDepth/, "Germ mutation depth should be available as a modulation target");
  assert.match(app, /tablePosition/, "Germ table position should be available as a modulation target");
  assert.match(app, /wavetableExportUrl/, "Wavetable export links should use the configured API base URL");
  assert.doesNotMatch(app, /href="\/(?:wavetables|files)\//, "Asset hrefs should not assume same-origin API routes");
  assert.match(synth, /export function createGermSynthEngine/, "Wavetable synth engine export should exist");
  assert.match(synth, /createPeriodicWave/, "Preview synth should build PeriodicWave frames");
}

async function checkAudioEngineContracts() {
  const audio = await loadDashboardModule("audio_engine.js");
  assert.deepEqual(audio.equalPowerMix(0), { dry: 1, wet: 0 });
  assert.ok(Math.abs(audio.equalPowerMix(1).wet - 1) < 1e-12);
  const curve = audio.softClipCurve();
  assert.equal(curve.length, 4096);
  assert.ok([...curve].every(Number.isFinite));
  assert.ok(Math.max(...curve) <= 1 && Math.min(...curve) >= -1);

  const wav = audio.encodeWavBlob(
    [new Float32Array([0, 0.25, -0.25]), new Float32Array([0, -0.25, 0.25])],
    48_000,
    { dither: false },
  );
  const bytes = new Uint8Array(await wav.arrayBuffer());
  assert.equal(new TextDecoder().decode(bytes.slice(0, 4)), "RIFF");
  assert.equal(new TextDecoder().decode(bytes.slice(8, 12)), "WAVE");
  assert.equal(new DataView(bytes.buffer).getUint32(24, true), 48_000);
  assert.equal(bytes.length, 44 + (3 * 2 * 2));

  const source = read("dashboard/static/audio_engine.js");
  assert.match(source, /postMessage\(\{ type: "stopped" \}\)/, "Recorder worklet should acknowledge its flush boundary");
  assert.match(source, /\(!active && !stopping\)/, "Recorder should retain PCM arriving while stop is pending");
}

async function checkWavetableZeroGain() {
  const originalWindow = globalThis.window;
  const automation = [];
  const stopTimes = [];
  const destination = {};
  const context = {
    state: "running",
    currentTime: 0,
    destination,
    createPeriodicWave: () => ({}),
    createOscillator() {
      return {
        context,
        frequency: { value: 0 },
        setPeriodicWave() {},
        connect(node) { return node; },
        disconnect() {},
        start() {},
        stop(at) { stopTimes.push(at); },
        onended: null,
      };
    },
    createGain() {
      return {
        gain: {
          value: 0,
          cancelScheduledValues() {},
          setValueAtTime(value, at) { this.value = value; automation.push(["set", value, at]); },
          linearRampToValueAtTime(value, at) { this.value = value; automation.push(["ramp", value, at]); },
        },
        connect() { return destination; },
        disconnect() {},
      };
    },
  };
  globalThis.window = { setTimeout: (callback) => { callback(); return 1; } };
  try {
    const { createGermSynthEngine } = await loadDashboardModule("wavetable_synth.js");
    const engine = createGermSynthEngine({ getContext: () => context, getDestination: () => destination });
    await engine.loadWavetable({ frame_size: 8, frame_count: 1 }, new Float32Array([0, 1, 0, -1, 0, 1, 0, -1]));
    await engine.previewFrame({ gain: 0, duration: 0 });
    assert.ok(automation.every(([, value]) => value === 0), "Explicit zero gain should remain silent");
    assert.ok(stopTimes[0] <= 0.11, "Explicit zero duration should use the minimum preview duration");
    engine.stop();
  } finally {
    if (originalWindow === undefined) delete globalThis.window;
    else globalThis.window = originalWindow;
  }
}

async function checkCosmoauditionDataBoundary() {
  const cosmo = await loadDashboardModule("cosmoaudition.js");
  assert.equal(cosmo.finiteNumberOrNull(null), null);
  assert.equal(cosmo.finiteNumberOrNull(""), null);
  assert.equal(cosmo.finiteNumberOrNull("0"), 0);
  const signals = [
    { id: "zero", sphere: "cosmos", normalized: 0, confidence: "high" },
    { id: "missing", sphere: "cosmos", normalized: null, confidence: "stale" },
    { id: "failed", sphere: "cosmos", normalized: null, confidence: "error", error: "offline" },
    { id: "stream", sphere: "cosmos", normalized: 0.5, confidence: "high", temporalCharacter: "stream" },
    { id: "event", sphere: "cosmos", normalized: 0.75, confidence: "medium", temporalCharacter: "event" },
  ];
  assert.deepEqual(
    cosmo.cosmoauditionUsableSignals("cosmo_cosmic_field", signals).map((signal) => signal.id),
    ["zero", "stream", "event"],
  );
  assert.equal(
    cosmo.cosmoauditionSelectedSignal({ modulatorType: "cosmo_cosmic_field", config: { signalId: "missing" } }, signals),
    null,
  );
  const failed = cosmo.cosmoauditionSelectedSignal(
    { modulatorType: "cosmo_uncertainty_field", config: { signalId: "failed" } },
    signals,
  );
  assert.equal(cosmo.cosmoauditionUnitFor({ modulatorType: "cosmo_uncertainty_field" }, signals, failed), 1);
  const event = cosmo.cosmoauditionSelectedSignal(
    { modulatorType: "cosmo_event_pulsar", config: { signalId: "" } },
    signals.filter((signal) => signal.id !== "event"),
  );
  assert.equal(cosmo.cosmoauditionUnitFor({ modulatorType: "cosmo_event_pulsar" }, signals, event), null);
  assert.equal(cosmo.cosmoauditionMappingSignal(signals[1]).value, null);
  assert.equal(cosmo.cosmoauditionPreviousOutput({ config: { currentValue: 0.5, available: false } }), null);
  assert.equal(cosmo.cosmoauditionPreviousOutput({ config: { currentValue: 0, available: true } }), 0);
}

function checkPetriActionContracts() {
  const app = read("dashboard/static/app.js");
  assert.match(app, /metadata_missing/, "Petri playback should tolerate missing metadata files");
  assert.match(app, /metadata_error/, "Missing metadata details should be preserved for inspection");
  assert.match(
    app,
    /catch \(error\)[\s\S]*metadata_error: error\.message/,
    "Library item resolution should fall back to audio metadata when JSON metadata is stale",
  );
}

function checkTimelineContracts() {
  const html = read("dashboard/static/index.html");
  const app = read("dashboard/static/app.js");
  assert.match(html, /data-time="incubation_timeline"/, "Incubation Timeline card should be present");
  assert.match(app, /incubation_timeline/, "Incubation Timeline node type should be registered");
  assert.match(app, /canvasIncubationTimelineMarkup/, "Incubation Timeline markup should exist");
  assert.match(app, /time-incubation-add-selected/, "Timeline should place selected sources");
  assert.match(app, /timeline_event_id/, "Timeline events should carry lineage metadata");
}

function checkListenerContracts() {
  const html = read("dashboard/static/index.html");
  const app = read("dashboard/static/app.js");
  assert.match(html, /id="tab-listener"/, "Listener tab should be present");
  assert.match(html, /id="listenerEnhanceBtn"/, "Listener enhance action should be present");
  assert.match(html, /id="listenerRelistenBtn"/, "Oída re-listening action should be present");
  assert.match(app, /\/listener\/enhance/, "Listener enhance route should be wired");
  assert.match(app, /\/listener\/score/, "Listener score route should be wired");
  assert.match(app, /\/listener\/relisten/, "Oída re-listening route should be wired");
  assert.match(
    app,
    /germ\.akousma\.prompt-handoff/,
    "Structured Akousma prompt handoffs should reach the editable canvas",
  );
}

function checkMicrocosmosContracts() {
  const html = read("dashboard/static/index.html");
  const dish = read("dashboard/static/dish.js");
  assert.doesNotMatch(
    html,
    /class="transport-icon-button nav-item"[^>]+data-tab="onebit"/,
    "Toolbar should not expose the retired Open Microcosmos button",
  );
  assert.match(html, /id="dishBiomeBtn"/, "Microcosmos biome action should be present");
  assert.match(html, /id="dishSpectatorBtn"/, "Microcosmos spectator action should be present");
  assert.match(dish, /\/micro\/biomes/, "Microcosmos should call biome routes");
  assert.match(dish, /toggleSpectatorMode/, "Spectator mode should be wired");
}

function checkControlBridgeContracts() {
  const app = read("dashboard/static/app.js");
  assert.match(app, /control-norns-send/, "norns/Fates send action should be present");
  assert.match(app, /\/control\/osc\/norns\/send/, "norns/Fates route should be wired");
  assert.match(app, /sendNornsBridge/, "norns/Fates sender should be implemented");
}

function checkCosmoauditionAndMatterContracts() {
  const html = read("dashboard/static/index.html");
  const app = read("dashboard/static/app.js");
  const cosmo = read("dashboard/static/cosmoaudition.js");
  const modules = [
    "cosmo_observation",
    "cosmo_cosmic_field",
    "cosmo_earth_field",
    "cosmo_biosphere_field",
    "cosmo_human_machine_field",
    "cosmo_relational_index",
    "cosmo_event_pulsar",
    "cosmo_mapping_loom",
    "cosmo_semantic_field",
    "cosmo_uncertainty_field",
    "cosmo_observation_archive",
  ];
  assert.match(html, /data-tab="cosmoaudition"/, "Cosmoaudition category tab should be present");
  modules.forEach((moduleType) => {
    assert.match(html, new RegExp(`data-modulator="${moduleType}"`), `${moduleType} card should be present`);
    assert.match(cosmo, new RegExp(`"${moduleType}"`), `${moduleType} should be registered`);
  });
  assert.match(html, /data-fx="cosmo_matter_modulator"/, "Matter Modulator card should be present");
  assert.match(html, /data-fx="matter_analysis"/, "Matter Analysis card should be present");
  assert.match(app, /\/cosmoaudition\/snapshot/, "Cosmoaudition snapshot bridge should be wired");
  assert.match(app, /\/cosmoaudition\/map/, "Cosmoaudition mapping bridge should be wired");
  assert.match(app, /\/matter\/analyze/, "Matter Analysis route should be wired");
  assert.match(app, /cosmoaudition\.js\?v=20260731-audit-p1/, "App should use the audited Cosmoaudition data boundary");
  assert.match(cosmo, /finiteNumberOrNull/, "Cosmoaudition should distinguish unavailable values from zero");
  assert.match(
    app,
    /COSMOAUDITION_MODULATOR_TYPES\.has\(modulator\.modulatorType\)[\s\S]*available !== true\) return/,
    "Unavailable observatory values should not enter modulation routes",
  );
}

checkJsSyntax();
checkDuplicateIds();
checkCssVars();
checkResponsiveAssetContracts();
checkMicroRenderer();
checkWavetableContracts();
await checkAudioEngineContracts();
await checkWavetableZeroGain();
await checkCosmoauditionDataBoundary();
checkPetriActionContracts();
checkTimelineContracts();
checkListenerContracts();
checkMicrocosmosContracts();
checkControlBridgeContracts();
checkCosmoauditionAndMatterContracts();
console.log("dashboard smoke passed");
