import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const root = path.resolve(new URL("..", import.meta.url).pathname);
const dashboardDir = path.join(root, "dashboard", "static");

function read(relativePath) {
  return fs.readFileSync(path.join(root, relativePath), "utf8");
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
  assert.match(synth, /export function createGermSynthEngine/, "Wavetable synth engine export should exist");
  assert.match(synth, /createPeriodicWave/, "Preview synth should build PeriodicWave frames");
}

checkJsSyntax();
checkDuplicateIds();
checkCssVars();
checkMicroRenderer();
checkWavetableContracts();
console.log("dashboard smoke passed");
