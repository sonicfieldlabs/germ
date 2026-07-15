/* ===================================================================
   Microcosmos render toolkit — procedural-form sprite cache + LOD.

   This is the rendering engine the Microcosmos visual overhaul draws
   through the Micro/Matter module contract. Detailed germ and
   module forms are authored as vector paths, rasterised ONCE into an
   offscreen sprite cache, then blitted each frame with cheap transforms.
   That keeps the one-bit canvas crisp at every zoom (0.24x-2.6x) while
   holding framerate at full population.

   PHASE 0 wires this in INERTLY: nothing is routed through blitForm yet,
   so the Microcosmos renders byte-for-byte identically. Phase 1 (germs)
   and Phase 2 (modules) populate GERM_FORMS / MODULE_FORMS and flip the
   draw* bodies in dish.js onto blitForm().

   The module is engine-agnostic and DOM-optional: SpriteCache accepts an
   injected surface factory so its logic is testable headlessly.
   =================================================================== */

// ---- Form registries -----------------------------------------------------
// Phase 1/2 populate these. A form draws a single shape centred at (0,0) in
// the offscreen ctx, at the given device-pixel radius. Shape:
//   GERM_FORMS[type]   = (ctx, { r, traits, state, frame, dark }) => void
//   MODULE_FORMS[type] = (ctx, { r, state, frame, dark }) => void
export const GERM_FORMS = {};
export const MODULE_FORMS = {};

// ---- Offscreen surface ---------------------------------------------------
// Device-pixel drawing surface. Prefers OffscreenCanvas, falls back to a
// detached <canvas>, returns null in a headless context with no canvas
// (tests inject their own factory instead).
export function makeOffscreen(wPx, hPx) {
  const w = Math.max(1, Math.ceil(wPx));
  const h = Math.max(1, Math.ceil(hPx));
  let canvas = null;
  if (typeof OffscreenCanvas !== "undefined") {
    canvas = new OffscreenCanvas(w, h);
  } else if (typeof document !== "undefined") {
    canvas = document.createElement("canvas");
    canvas.width = w;
    canvas.height = h;
  } else {
    return null;
  }
  const ctx = canvas.getContext("2d");
  if (!ctx) return null;
  return { canvas, ctx, w, h };
}

// ---- Level of detail -----------------------------------------------------
// Discretise a continuous zoom into a few geometric tiers, so a form
// re-rasterises only when it crosses a tier rather than every frame.
export function lodBucket(zoom, { min = 0.24, max = 2.6, tiers = 4 } = {}) {
  const span = Math.log(max / min) || 1;
  const z = Math.max(min, Math.min(max, Number(zoom) || min));
  const t = Math.log(z / min) / span; // 0..1
  const index = Math.max(0, Math.min(tiers - 1, Math.round(t * (tiers - 1))));
  const refZoom = tiers > 1 ? min * Math.pow(max / min, index / (tiers - 1)) : min;
  return { index, refZoom };
}

// ---- Sprite cache --------------------------------------------------------
// LRU-ish memoised offscreen sprites keyed by an opaque string. The draw
// callback runs once per key; later gets return the cached surface.
export class SpriteCache {
  constructor({ maxEntries = 256, createSurface = makeOffscreen } = {}) {
    this.maxEntries = maxEntries;
    this.createSurface = createSurface;
    this.map = new Map();
    this.hits = 0;
    this.misses = 0;
  }

  get(key, wPx, hPx, drawForm) {
    const hit = this.map.get(key);
    if (hit) {
      this.hits += 1;
      this.map.delete(key);
      this.map.set(key, hit); // refresh recency
      return hit;
    }
    this.misses += 1;
    const surface = this.createSurface(wPx, hPx);
    if (!surface) return null;
    try {
      drawForm(surface.ctx, surface.w, surface.h);
    } catch {
      /* a bad form must never kill the frame */
    }
    this.map.set(key, surface);
    while (this.map.size > this.maxEntries) {
      const oldest = this.map.keys().next().value;
      this.map.delete(oldest);
    }
    return surface;
  }

  has(key) { return this.map.has(key); }
  clear() { this.map.clear(); this.hits = 0; this.misses = 0; }
  get size() { return this.map.size; }
}

// ---- Renderer facade -----------------------------------------------------
// The instance dish.js holds. getCtx/getDpr/getDark are read live so a
// single renderer survives canvas resizes and theme toggles.
export function createMicroRenderer({ getCtx, getDpr = () => 1, getDark = () => true, cache } = {}) {
  const sprites = cache || new SpriteCache();
  let frameTime = 0;
  let frameDraws = 0;
  let lastDpr = null;
  let lastDark = null;

  // Drop cached sprites when device pixel ratio or theme changes — both alter
  // every rasterised form. Cheap to call each frame; early-outs when stable.
  function ensureFresh() {
    const dpr = getDpr() || 1;
    const dark = !!getDark();
    if (dpr !== lastDpr || dark !== lastDark) {
      sprites.clear();
      lastDpr = dpr;
      lastDark = dark;
    }
  }

  function beginFrame(timeMs) {
    if (Number.isFinite(timeMs)) frameTime = timeMs;
    frameDraws = 0;
  }

  // Render `drawForm` once into a square sprite (radius halfPx, device res),
  // then blit it centred at (xCss, yCss) in the live ctx. dish.js's ctx
  // carries a scale(dpr) transform, so a device-res sprite drawn at CSS size
  // maps 1:1 onto device pixels and stays crisp.
  function blitCached(keyBase, halfPx, drawForm, xCss, yCss, opts = {}) {
    const ctx = getCtx();
    if (!ctx || !(halfPx > 0)) return false;
    const dpr = getDpr() || 1;
    const sidePx = Math.max(2, Math.ceil(halfPx * 2 * dpr));
    const surface = sprites.get(`${keyBase}@${sidePx}`, sidePx, sidePx, (octx, w, h) => {
      octx.clearRect(0, 0, w, h);
      octx.save();
      octx.translate(w / 2, h / 2);
      drawForm(octx, halfPx * dpr); // centred, device px, radius = halfPx*dpr
      octx.restore();
    });
    if (!surface) return false;
    const { rotation = 0, alpha = 1, scale = 1 } = opts;
    const drawSide = (surface.w / dpr) * scale; // CSS px
    ctx.save();
    if (alpha !== 1) ctx.globalAlpha *= Math.max(0, alpha);
    ctx.translate(xCss, yCss);
    if (rotation) ctx.rotate(rotation);
    ctx.drawImage(surface.canvas, -drawSide / 2, -drawSide / 2, drawSide, drawSide);
    ctx.restore();
    frameDraws += 1;
    return true;
  }

  // Convenience: blit a registered form by registry+type, building the cache
  // key from variant params (type/state/frame/variant/theme). Phase 1/2 call
  // this from dish.js's draw* functions.
  function blitForm(registry, type, halfPx, xCss, yCss, params = {}, opts = {}) {
    const form = registry?.[type];
    if (!form) return false;
    const dark = !!getDark();
    const key = `${params.kind || "f"}:${type}:${params.state || "_"}:${params.frame ?? 0}:${params.variant ?? ""}:${dark ? "d" : "l"}`;
    return blitCached(key, halfPx, (octx, r) => form(octx, { r, dark, ...params }), xCss, yCss, opts);
  }

  return {
    beginFrame,
    ensureFresh,
    blitCached,
    blitForm,
    clear: () => sprites.clear(),
    get time() { return frameTime; },
    cacheStats: () => ({ entries: sprites.size, hits: sprites.hits, misses: sprites.misses, frameDraws }),
    sprites,
  };
}
