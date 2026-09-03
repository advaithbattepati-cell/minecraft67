// ============================================================================
// atlas.js - The procedural texture atlas.
//
// Every pixel in minecraft67 is drawn here, with canvas 2D, from a seeded RNG.
// No image file is ever loaded. Because each texture gets an RNG seeded from
// its own name, the atlas is byte-identical on every run and across machines.
//
// Layout: one 1024x1024 canvas = 64x64 tiles of 16x16 pixels (4096 slots).
//
// NOTE (contract rule 5 / section 34): this module must be importable in Node
// with no DOM. `document` and `THREE` are therefore only touched inside
// buildAtlas() and inside the lazily-invoked per-texture draw callbacks.
// ============================================================================
import * as THREE from 'three';
import { RNG, hashString } from '../core/rng.js';
import { clamp, hsvToRgb } from '../core/util.js';

// ---------------------------------------------------------------------------
// Geometry
// ---------------------------------------------------------------------------
const TILE = 16;
const COLS = 64;
const ATLAS_SIZE = TILE * COLS;      // 1024
const MAX_TILES = COLS * COLS;       // 4096

// ---------------------------------------------------------------------------
// Colour helpers. Colours are plain 24-bit integers (0xRRGGBB) everywhere.
// ---------------------------------------------------------------------------
const c255 = (v) => (v < 0 ? 0 : v > 255 ? 255 : v | 0);
const rgb = (r, g, b) => (c255(r) << 16) | (c255(g) << 8) | c255(b);
const cr = (c) => (c >> 16) & 255;
const cg = (c) => (c >> 8) & 255;
const cb = (c) => c & 255;
const grey = (v) => rgb(v, v, v);

/** '#rrggbb' when opaque, 'rgba(...)' when not. */
function css(c, a = 1) {
  if (a >= 1) return '#' + ((c >>> 0) & 0xffffff).toString(16).padStart(6, '0');
  return 'rgba(' + cr(c) + ',' + cg(c) + ',' + cb(c) + ',' + a + ')';
}
const shade = (c, f) => rgb(cr(c) * f, cg(c) * f, cb(c) * f);
const mix = (a, b, t) => rgb(cr(a) + (cr(b) - cr(a)) * t, cg(a) + (cg(b) - cg(a)) * t, cb(a) + (cb(b) - cb(a)) * t);
const hsv = (h, s, v) => { const [r, g, b] = hsvToRgb(h, s, v); return rgb(r * 255, g * 255, b * 255); };
/** Random shade of c within +/- amt. */
const jit = (rng, c, amt) => shade(c, 1 + (rng.next() * 2 - 1) * amt);

// ---------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------
const REGISTRY = new Map();     // name -> entry (aliases share one entry)
const ENTRIES = [];             // unique entries, in tile-index order
export const TEXTURE_NAMES = [];
/** baseName -> { frames: [tileIndex, ...], fps } for UV-cycling animations. */
export const ANIMATED = {};

let nextIndex = 0;
let _built = false;
let _atlasCtx = null;
let _scratch = null;
let _scratchCtx = null;
const _uvCache = [];
const _tileCanvases = new Map();

/**
 * Registers a 16x16 texture generator.
 * @param {string} name  canonical texture name (see contract section 33)
 * @param {(ctx: CanvasRenderingContext2D, rng: RNG, size: number) => void} fn
 * @returns {number} the tile index it was given
 */
export function defineTexture(name, fn) {
  const existing = REGISTRY.get(name);
  if (existing) return existing.index;
  if (nextIndex >= MAX_TILES) {
    console.warn('[atlas] out of tiles, cannot register "' + name + '"');
    return 0;
  }
  const entry = { name, fn, index: nextIndex++ };
  REGISTRY.set(name, entry);
  ENTRIES.push(entry);
  TEXTURE_NAMES.push(name);
  if (_built) drawTile(entry, true);   // late registration (fallbacks)
  return entry.index;
}

/** Points a second name at an already-registered tile (no extra atlas space). */
function defineAlias(name, target) {
  const t = REGISTRY.get(target);
  if (!t) return defineTexture(name, fallbackFor(name));
  if (REGISTRY.has(name)) return REGISTRY.get(name).index;
  REGISTRY.set(name, t);
  TEXTURE_NAMES.push(name);
  return t.index;
}

/** Registers `name` only if nobody has yet; used by the family generators. */
function defineIfAbsent(name, fn) {
  if (REGISTRY.has(name)) return REGISTRY.get(name).index;
  return defineTexture(name, fn);
}

/** Look up an entry, auto-generating a deterministic fallback when unknown. */
function ensure(name) {
  let e = REGISTRY.get(name);
  if (e) return e;
  if (typeof name !== 'string' || name.length === 0) return REGISTRY.get('missing');
  defineTexture(name, fallbackFor(name));
  return REGISTRY.get(name) || REGISTRY.get('missing');
}

// ---------------------------------------------------------------------------
// Canvas plumbing (DOM only touched from here down, and only at call time)
// ---------------------------------------------------------------------------
function makeCanvas(w, h) {
  if (typeof document !== 'undefined' && document.createElement) {
    const c = document.createElement('canvas');
    c.width = w; c.height = h;
    return c;
  }
  if (typeof OffscreenCanvas !== 'undefined') return new OffscreenCanvas(w, h);
  throw new Error('[atlas] no canvas implementation available');
}

function context2d(canvas) {
  const g = canvas.getContext('2d', { willReadFrequently: true });
  g.imageSmoothingEnabled = false;
  return g;
}

function scratch() {
  if (!_scratchCtx) {
    _scratch = makeCanvas(TILE, TILE);
    _scratchCtx = context2d(_scratch);
  }
  return _scratchCtx;
}

let _drawDepth = 0;

/** Runs one texture's generator into a fresh 16x16 context. */
function renderEntry(entry, ctx) {
  ctx.clearRect(0, 0, TILE, TILE);
  ctx.save();
  ctx.globalAlpha = 1;
  ctx.globalCompositeOperation = 'source-over';
  try {
    entry.fn(ctx, new RNG((hashString(entry.name) ^ 0x9e3779b9) >>> 0), TILE);
  } catch (err) {
    console.error('[atlas] failed drawing "' + entry.name + '"', err);
    drawMissing(ctx);
  }
  ctx.restore();
}

/** Draws another registered texture into the current context (composition). */
function drawInto(ctx, name) {
  const e = REGISTRY.get(name);
  if (!e || _drawDepth > 4) return false;
  _drawDepth++;
  try { e.fn(ctx, new RNG((hashString(name) ^ 0x5bf03635) >>> 0), TILE); }
  catch (err) { /* composition failures must never break the atlas */ }
  finally { _drawDepth--; }
  return true;
}

function drawTile(entry, markDirty) {
  if (!_atlasCtx) return;
  const sc = scratch();
  renderEntry(entry, sc);
  const tx = (entry.index % COLS) * TILE;
  const ty = ((entry.index / COLS) | 0) * TILE;
  _atlasCtx.clearRect(tx, ty, TILE, TILE);
  _atlasCtx.drawImage(_scratch, tx, ty);
  if (markDirty && Atlas.texture) Atlas.texture.needsUpdate = true;
}

function uvIndex(i) {
  let u = _uvCache[i];
  if (u) return u;
  const col = i % COLS;
  const row = (i / COLS) | 0;
  const s = TILE / ATLAS_SIZE;
  const inset = 0.5 / ATLAS_SIZE;     // half-texel, kills neighbour bleed
  u = {
    u0: col * s + inset, v0: row * s + inset,
    u1: (col + 1) * s - inset, v1: (row + 1) * s - inset,
  };
  _uvCache[i] = u;
  return u;
}

/**
 * The atlas singleton. `index`/`uv` auto-register a deterministic fallback for
 * unknown names, so nothing in the game can ever crash on a missing texture.
 */
export const Atlas = {
  texture: null,
  canvas: null,
  size: ATLAS_SIZE,
  tile: TILE,
  cols: COLS,
  /** Tile index for a texture name (registers a fallback if unknown). */
  index(name) { return ensure(name).index; },
  /** Alias of index(), kept because game.js documents this spelling. */
  tileIndex(name) { return ensure(name).index; },
  /** { u0, v0, u1, v1 } with a half-texel inset. Cached, do not mutate. */
  uv(name) { return uvIndex(ensure(name).index); },
  /** Same, from a raw tile index. */
  uvIndex,
  /** A standalone 16x16 canvas for item icons and DOM UI. Cached. */
  tileCanvas(name) {
    let c = _tileCanvases.get(name);
    if (c) return c;
    const e = ensure(name);
    c = makeCanvas(TILE, TILE);
    renderEntry(e, context2d(c));
    _tileCanvases.set(name, c);
    return c;
  },
  has(name) { return REGISTRY.has(name); },
  /** Number of registered tiles (aliases not counted). */
  get count() { return ENTRIES.length; },
  get built() { return _built; },
  /** Animation table, same object as the ANIMATED export. */
  animated: ANIMATED,
};

/**
 * Builds the 1024x1024 atlas canvas and its THREE.Texture. Safe to call twice:
 * the second call is a no-op that returns the same Atlas.
 */
export function buildAtlas() {
  if (_built) return Atlas;
  const canvas = makeCanvas(ATLAS_SIZE, ATLAS_SIZE);
  const ctx = canvas.getContext('2d');
  ctx.imageSmoothingEnabled = false;
  ctx.clearRect(0, 0, ATLAS_SIZE, ATLAS_SIZE);
  Atlas.canvas = canvas;
  _atlasCtx = ctx;
  for (let i = 0; i < ENTRIES.length; i++) drawTile(ENTRIES[i], false);

  const tex = new THREE.CanvasTexture(canvas);
  tex.magFilter = THREE.NearestFilter;
  tex.minFilter = THREE.NearestFilter;
  tex.generateMipmaps = false;
  tex.wrapS = THREE.ClampToEdgeWrapping;
  tex.wrapT = THREE.ClampToEdgeWrapping;
  tex.flipY = false;
  tex.premultiplyAlpha = false;
  tex.anisotropy = 1;
  if (THREE.SRGBColorSpace) tex.colorSpace = THREE.SRGBColorSpace;
  tex.needsUpdate = true;
  Atlas.texture = tex;
  _built = true;
  return Atlas;
}

// ===========================================================================
// The drawing DSL. Everything below draws into a 16x16 context, coordinates
// 0..15, colours as 0xRRGGBB integers.
// ===========================================================================

function clear(ctx) { ctx.clearRect(0, 0, TILE, TILE); }

function fill(ctx, color, a = 1) {
  ctx.fillStyle = css(color, a);
  ctx.fillRect(0, 0, TILE, TILE);
}

function px(ctx, x, y, color, a = 1) {
  x |= 0; y |= 0;
  if (x < 0 || y < 0 || x >= TILE || y >= TILE) return;
  ctx.fillStyle = css(color, a);
  ctx.fillRect(x, y, 1, 1);
}

function rect(ctx, x, y, w, h, color, a = 1) {
  ctx.fillStyle = css(color, a);
  ctx.fillRect(x, y, w, h);
}

/** Per-pixel writer using ImageData - fast and exact. cb(x, y, out[4]). */
function perPixel(ctx, cb) {
  const img = ctx.createImageData(TILE, TILE);
  const d = img.data;
  const out = [0, 0, 0, 255];
  for (let y = 0; y < TILE; y++) {
    for (let x = 0; x < TILE; x++) {
      out[0] = 0; out[1] = 0; out[2] = 0; out[3] = 255;
      cb(x, y, out);
      const i = (y * TILE + x) * 4;
      d[i] = c255(out[0]); d[i + 1] = c255(out[1]); d[i + 2] = c255(out[2]); d[i + 3] = c255(out[3]);
    }
  }
  ctx.putImageData(img, 0, 0);
}

/**
 * Opaque value-jittered fill - the workhorse for stone/dirt/sand.
 * opts: { cell, fine, alt, altP, vgrad }
 */
function noise(ctx, rng, base, amount = 0.1, opts = {}) {
  const cell = opts.cell || 1;
  const fine = opts.fine || 0;
  const alt = opts.alt != null ? opts.alt : null;
  const altP = opts.altP != null ? opts.altP : 0;
  const vgrad = opts.vgrad || 0;
  const cells = Math.ceil(TILE / cell);
  const vals = new Float32Array(cells * cells);
  const altv = new Uint8Array(cells * cells);
  for (let i = 0; i < vals.length; i++) {
    vals[i] = 1 + (rng.next() * 2 - 1) * amount;
    altv[i] = altP > 0 && rng.next() < altP ? 1 : 0;
  }
  const fineVals = new Float32Array(TILE * TILE);
  if (fine > 0) for (let i = 0; i < fineVals.length; i++) fineVals[i] = 1 + (rng.next() * 2 - 1) * fine;
  perPixel(ctx, (x, y, out) => {
    const ci = ((y / cell) | 0) * cells + ((x / cell) | 0);
    let c = altv[ci] && alt != null ? alt : base;
    let v = vals[ci];
    if (fine > 0) v *= fineVals[y * TILE + x];
    if (vgrad) v *= 1 + vgrad * (0.5 - y / (TILE - 1));
    out[0] = cr(c) * v; out[1] = cg(c) * v; out[2] = cb(c) * v; out[3] = 255;
  });
}

/** Greyscale value noise, for textures the mesher will biome-tint. */
function tintNoise(ctx, rng, lo = 168, hi = 250, amount = 0.06) {
  perPixel(ctx, (x, y, out) => {
    const v = lo + rng.next() * (hi - lo);
    const w = v * (1 + (rng.next() * 2 - 1) * amount);
    out[0] = w; out[1] = w; out[2] = w; out[3] = 255;
  });
}

function speckle(ctx, rng, color, count, size = 1, a = 1) {
  for (let i = 0; i < count; i++) {
    const x = rng.int(TILE), y = rng.int(TILE);
    const s = size === 1 ? 1 : 1 + rng.int(size);
    rect(ctx, x, y, s, s, color, a);
  }
}

/** Scatters `amount` (0..1) of the tile's pixels with `color`. */
function dither(ctx, rng, color, amount, a = 1) {
  ctx.fillStyle = css(color, a);
  for (let y = 0; y < TILE; y++) {
    for (let x = 0; x < TILE; x++) if (rng.next() < amount) ctx.fillRect(x, y, 1, 1);
  }
}

function gradientV(ctx, top, bottom) {
  for (let y = 0; y < TILE; y++) rect(ctx, 0, y, TILE, 1, mix(top, bottom, y / (TILE - 1)));
}

function gradientH(ctx, left, right) {
  for (let x = 0; x < TILE; x++) rect(ctx, x, 0, 1, TILE, mix(left, right, x / (TILE - 1)));
}

function border(ctx, color, inset = 0, a = 1) {
  const i = inset, s = TILE - inset * 2;
  if (s <= 0) return;
  ctx.fillStyle = css(color, a);
  ctx.fillRect(i, i, s, 1);
  ctx.fillRect(i, i + s - 1, s, 1);
  ctx.fillRect(i, i, 1, s);
  ctx.fillRect(i + s - 1, i, 1, s);
}

function circle(ctx, cx, cy, r, color, a = 1) {
  const r2 = r * r;
  ctx.fillStyle = css(color, a);
  for (let y = 0; y < TILE; y++) {
    for (let x = 0; x < TILE; x++) {
      const dx = x + 0.5 - cx, dy = y + 0.5 - cy;
      if (dx * dx + dy * dy <= r2) ctx.fillRect(x, y, 1, 1);
    }
  }
}

function ring(ctx, cx, cy, r, color, thickness = 0.7, a = 1) {
  ctx.fillStyle = css(color, a);
  for (let y = 0; y < TILE; y++) {
    for (let x = 0; x < TILE; x++) {
      const dx = x + 0.5 - cx, dy = y + 0.5 - cy;
      if (Math.abs(Math.sqrt(dx * dx + dy * dy) - r) <= thickness) ctx.fillRect(x, y, 1, 1);
    }
  }
}

/** Random-walk streaks - marble veins, cracks, roots. */
function veins(ctx, rng, color, count, len, a = 1) {
  for (let i = 0; i < count; i++) {
    let x = rng.int(TILE), y = rng.int(TILE);
    let dx = rng.bool() ? 1 : -1, dy = rng.bool() ? 1 : -1;
    for (let s = 0; s < len; s++) {
      px(ctx, x, y, color, a);
      if (rng.next() < 0.4) dx = rng.int(3) - 1;
      if (rng.next() < 0.4) dy = rng.int(3) - 1;
      x = (x + dx + TILE) % TILE;
      y = (y + dy + TILE) % TILE;
    }
  }
}

/** Wood grain streaks. */
function grain(ctx, rng, color, vertical = false, count = 10, len = 6) {
  for (let i = 0; i < count; i++) {
    const a = rng.int(TILE), b = rng.int(TILE);
    const l = 2 + rng.int(len);
    const c = shade(color, rng.bool() ? 0.85 : 1.12);
    for (let k = 0; k < l; k++) {
      if (vertical) px(ctx, a, (b + k) % TILE, c);
      else px(ctx, (b + k) % TILE, a, c);
    }
  }
}

/** Horizontal (or vertical) plank rows with seams, grain and knots. */
function plank(ctx, rng, colorA, colorB, rows = 4, vertical = false) {
  const h = TILE / rows;
  for (let r = 0; r < rows; r++) {
    const c = mix(colorA, colorB, rng.next() * 0.85);
    const o = r * h;
    if (vertical) rect(ctx, o, 0, h, TILE, c); else rect(ctx, 0, o, TILE, h, c);
    const n = 4 + rng.int(4);
    for (let k = 0; k < n; k++) {
      const a = o + rng.int(h);
      const b = rng.int(TILE);
      const l = 2 + rng.int(7);
      const gc = shade(c, rng.bool() ? 0.87 : 1.1);
      for (let i = 0; i < l; i++) {
        if (vertical) px(ctx, a, (b + i) % TILE, gc); else px(ctx, (b + i) % TILE, a, gc);
      }
    }
    const seam = shade(colorA, 0.6);
    if (vertical) rect(ctx, o, 0, 1, TILE, seam); else rect(ctx, 0, o, TILE, 1, seam);
    // plank butt joint, one per row at a random offset
    const j = 1 + rng.int(TILE - 2);
    if (vertical) rect(ctx, o, j, h, 1, seam); else rect(ctx, j, o, 1, h, seam);
    if (rng.next() < 0.35) {
      const kx = 2 + rng.int(12), ky = o + 1 + rng.int(Math.max(1, h - 2));
      px(ctx, kx, ky, shade(c, 0.7));
    }
  }
}

/** Staggered brick courses. */
function brick(ctx, rng, mortar, brickColor, rows = 4, bw = 8) {
  fill(ctx, mortar);
  const h = TILE / rows;
  for (let r = 0; r < rows; r++) {
    const y = r * h;
    const off = (r % 2) ? bw / 2 : 0;
    for (let x = -bw; x < TILE + bw; x += bw) {
      const bx = x + off;
      const c = jit(rng, brickColor, 0.11);
      rect(ctx, bx, y, bw - 1, h - 1, c);
      for (let k = 0; k < 5; k++) px(ctx, bx + rng.int(bw - 1), y + rng.int(Math.max(1, h - 1)), jit(rng, c, 0.12));
      rect(ctx, bx, y, bw - 1, 1, shade(c, 1.1));
    }
  }
}

/** A square tile grid (deepslate tiles, quartz bricks, prismarine bricks). */
function tileGrid(ctx, rng, base, line, n = 2) {
  const s = TILE / n;
  for (let ty = 0; ty < n; ty++) {
    for (let tx = 0; tx < n; tx++) {
      const c = jit(rng, base, 0.08);
      rect(ctx, tx * s, ty * s, s, s, c);
      for (let k = 0; k < s * 2; k++) px(ctx, tx * s + rng.int(s), ty * s + rng.int(s), jit(rng, c, 0.1));
      rect(ctx, tx * s, ty * s, s, 1, shade(c, 1.08));
    }
  }
  for (let i = 0; i <= n; i++) {
    rect(ctx, 0, (i * s) % TILE, TILE, 1, line);
    rect(ctx, (i * s) % TILE, 0, 1, TILE, line);
  }
}

/** Irregular rounded cobbles over a dark mortar bed. */
function cobble(ctx, rng, base) {
  fill(ctx, shade(base, 0.5));
  const cells = [
    [0, 0, 7, 7], [7, 0, 9, 5], [0, 7, 5, 5], [5, 7, 6, 6],
    [11, 5, 5, 6], [0, 12, 8, 4], [8, 11, 8, 5], [11, 0, 5, 5],
  ];
  for (const [x, y, w, h] of cells) {
    const c = shade(base, 0.78 + rng.next() * 0.45);
    rect(ctx, x, y, w - 1, h - 1, c);
    const n = ((w * h) / 2) | 0;
    for (let k = 0; k < n; k++) px(ctx, x + rng.int(Math.max(1, w - 1)), y + rng.int(Math.max(1, h - 1)), jit(rng, c, 0.16));
    rect(ctx, x, y, w - 1, 1, shade(c, 1.16));
    rect(ctx, x, y + h - 2, w - 1, 1, shade(c, 0.82));
  }
}

/** Bark: vertical fibrous streaks. */
function logSide(ctx, rng, bark, dark) {
  noise(ctx, rng, bark, 0.08, { cell: 1, fine: 0.05 });
  for (let x = 0; x < TILE; x++) {
    if (rng.next() < 0.5) {
      const c = shade(bark, 0.72 + rng.next() * 0.2);
      const y0 = rng.int(5), y1 = TILE - rng.int(5);
      rect(ctx, x, y0, 1, y1 - y0, c);
    }
  }
  for (let k = 0; k < 3; k++) rect(ctx, 1 + rng.int(14), 0, 1, TILE, dark, 0.55);
  rect(ctx, 0, 0, 1, TILE, shade(bark, 1.1), 0.4);
}

/** End grain: bark rim plus concentric growth rings. */
function logTop(ctx, rng, wood, bark) {
  noise(ctx, rng, wood, 0.07, { cell: 1, fine: 0.05 });
  border(ctx, bark, 0);
  border(ctx, shade(bark, 0.86), 1);
  ring(ctx, 8, 8, 5.2, shade(wood, 0.84), 0.55);
  ring(ctx, 8, 8, 3.2, shade(wood, 0.88), 0.55);
  ring(ctx, 8, 8, 1.4, shade(wood, 0.78), 0.6);
  for (let k = 0; k < 6; k++) px(ctx, 2 + rng.int(12), 2 + rng.int(12), jit(rng, wood, 0.14));
}

/** Greyscale leaf mass with cutout holes - the mesher applies the biome tint. */
function leafMask(ctx, rng, holeChance = 0.14, lo = 130, hi = 252) {
  clear(ctx);
  const cellv = new Float32Array(64);
  for (let i = 0; i < 64; i++) cellv[i] = rng.next();
  for (let y = 0; y < TILE; y++) {
    for (let x = 0; x < TILE; x++) {
      if (rng.next() < holeChance) continue;
      const base = cellv[((y / 2) | 0) * 8 + ((x / 2) | 0)];
      let v = lo + (hi - lo) * (base * 0.65 + rng.next() * 0.35);
      px(ctx, x, y, grey(v));
    }
  }
  // a few dark clumps to break up the field
  for (let k = 0; k < 8; k++) {
    const x = rng.int(TILE), y = rng.int(TILE);
    px(ctx, x, y, grey(lo - 20 > 0 ? lo - 20 : 10));
    px(ctx, x + 1, y, grey(lo - 10 > 0 ? lo - 10 : 20));
  }
}

/** Ore blobs painted on top of a host stone texture. */
function oreOverlay(ctx, rng, baseTexName, gemColor, blobs = 5) {
  if (!drawInto(ctx, baseTexName)) noise(ctx, rng, 0x7a7a7a, 0.09, { fine: 0.05 });
  const dark = shade(gemColor, 0.6);
  const light = shade(gemColor, 1.3);
  for (let b = 0; b < blobs; b++) {
    const w = 2 + rng.int(3), h = 2 + rng.int(3);
    const x0 = rng.int(TILE - w), y0 = rng.int(TILE - h);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        if (rng.next() < 0.18) continue;
        px(ctx, x0 + x, y0 + y, gemColor);
      }
    }
    px(ctx, x0, y0, light);
    px(ctx, x0 + w - 1, y0 + h - 1, dark);
    px(ctx, x0 + 1, y0 + h - 1, dark);
  }
}

/** Draws mossy tufts over whatever is already in the tile. */
function mossOverlay(ctx, rng, amount = 0.3) {
  const mossA = 0x5d7c3f, mossB = 0x74915a, mossC = 0x415c2b;
  for (let y = 0; y < TILE; y++) {
    for (let x = 0; x < TILE; x++) {
      if (rng.next() > amount) continue;
      const r = rng.next();
      px(ctx, x, y, r < 0.4 ? mossA : r < 0.75 ? mossB : mossC);
    }
  }
}

/** Cracks for cracked_* variants. */
function crackOverlay(ctx, rng, color, count = 4) {
  for (let i = 0; i < count; i++) {
    let x = rng.int(TILE), y = rng.int(TILE);
    const steps = 5 + rng.int(7);
    for (let s = 0; s < steps; s++) {
      px(ctx, x, y, color);
      if (rng.bool()) x += rng.int(3) - 1; else y += rng.int(3) - 1;
      if (x < 0 || x > 15 || y < 0 || y > 15) break;
    }
  }
}

/** A carved/chiseled panel: inset frame plus a motif. */
function chiseled(ctx, rng, base, motif) {
  noise(ctx, rng, base, 0.05, { fine: 0.04 });
  border(ctx, shade(base, 0.66), 0);
  border(ctx, shade(base, 1.12), 1);
  rect(ctx, 3, 3, 10, 10, shade(base, 0.94));
  border(ctx, shade(base, 0.7), 3);
  if (motif === 'eye') {
    rect(ctx, 6, 6, 4, 4, shade(base, 0.6));
    rect(ctx, 7, 7, 2, 2, shade(base, 1.2));
  } else if (motif === 'cross') {
    rect(ctx, 7, 4, 2, 8, shade(base, 0.68));
    rect(ctx, 4, 7, 8, 2, shade(base, 0.68));
  } else if (motif === 'diamond') {
    for (let i = 0; i < 4; i++) {
      rect(ctx, 8 - i - 1, 8 - 4 + i, 2 + i * 2, 1, shade(base, 0.66));
      rect(ctx, 8 - i - 1, 8 + 3 - i, 2 + i * 2, 1, shade(base, 0.66));
    }
  } else {
    rect(ctx, 5, 5, 6, 6, shade(base, 0.72));
    rect(ctx, 6, 6, 4, 4, shade(base, 1.15));
  }
}

/** Adds a 1px dark outline around every opaque pixel (item sprites). */
function outline(ctx, color = 0x1a1108, a = 1) {
  const img = ctx.getImageData(0, 0, TILE, TILE);
  const d = img.data;
  const solid = new Uint8Array(TILE * TILE);
  for (let i = 0; i < TILE * TILE; i++) solid[i] = d[i * 4 + 3] > 8 ? 1 : 0;
  ctx.fillStyle = css(color, a);
  for (let y = 0; y < TILE; y++) {
    for (let x = 0; x < TILE; x++) {
      if (solid[y * TILE + x]) continue;
      const i = y * TILE + x;
      if ((x > 0 && solid[i - 1]) || (x < 15 && solid[i + 1]) ||
          (y > 0 && solid[i - TILE]) || (y < 15 && solid[i + TILE])) ctx.fillRect(x, y, 1, 1);
    }
  }
}

/**
 * The sprite-string painter: `rows` is up to 16 strings of 16 palette keys,
 * '.' and ' ' are transparent. This is how every item icon is drawn.
 */
function sprite(ctx, rows, palette) {
  for (let y = 0; y < rows.length && y < TILE; y++) {
    const row = rows[y];
    for (let x = 0; x < row.length && x < TILE; x++) {
      const k = row[x];
      if (k === '.' || k === ' ') continue;
      const c = palette[k];
      if (c == null) continue;
      if (Array.isArray(c)) px(ctx, x, y, c[0], c[1]);
      else px(ctx, x, y, c);
    }
  }
}

/** Convenience: sprite + outline, the standard item recipe. */
function item(rows, palette, outlineColor) {
  return (ctx) => {
    clear(ctx);
    sprite(ctx, rows, palette);
    if (outlineColor !== false) outline(ctx, outlineColor == null ? 0x21160c : outlineColor, 0.85);
  };
}

/** The literal 'missing' texture - the only magenta in the whole game. */
function drawMissing(ctx) {
  fill(ctx, 0x000000);
  ctx.fillStyle = css(0xf800f8);
  for (let y = 0; y < TILE; y += 8) for (let x = 0; x < TILE; x += 8) {
    if (((x / 8) + (y / 8)) % 2 === 0) ctx.fillRect(x, y, 8, 8);
  }
}

// ===========================================================================
// The automatic fallback generator (contract section 33).
//
// Any texture name nobody registered is derived deterministically: the name is
// hashed into a hue, a keyword in the name picks a pattern family, and a small
// dictionary of material words overrides the colour so that, for example,
// `weird_gold_thing_top` still comes out gold.
// ===========================================================================
const FALLBACK_WORDS = [
  ['deepslate', 0x4d4d51], ['blackstone', 0x2b2426], ['basalt', 0x50505a], ['obsidian', 0x14121f],
  ['netherrack', 0x703634], ['nether', 0x5b2a2a], ['end_stone', 0xdbdc9f], ['end', 0xdbdc9f],
  ['purpur', 0xaa7daa], ['prismarine', 0x63ae9a], ['quartz', 0xece5dd], ['sandstone', 0xdcd0a0],
  ['red_sand', 0xbf6b31], ['sand', 0xdbd3a0], ['gravel', 0x7f7c7a], ['clay', 0xa4a8b8],
  ['terracotta', 0x945b43], ['dirt', 0x866043], ['grass', 0xb9b9b9], ['podzol', 0x6a4d2b],
  ['mycelium', 0x6f6265], ['stone', 0x7a7a7a], ['cobble', 0x7f7f7f], ['brick', 0x976151],
  ['snow', 0xf0fafa], ['ice', 0xa8c6ff], ['glass', 0xd6f0f0], ['wool', 0xe9ecec],
  ['diamond', 0x4aedd9], ['emerald', 0x17dd62], ['gold', 0xfcee4b], ['golden', 0xfcee4b],
  ['iron', 0xd8d8d8], ['copper', 0xc16f4e], ['netherite', 0x4d4a4d], ['lapis', 0x2b53a8],
  ['redstone', 0xd42121], ['coal', 0x1b1b1b], ['amethyst', 0x8f66c4], ['bone', 0xe3e0d2],
  ['slime', 0x77c265], ['honey', 0xe09a2c], ['sculk', 0x0e191f], ['moss', 0x5b7c3c],
  ['mud', 0x3c3a3c], ['soul', 0x4e3a2e], ['magma', 0x8e3a13], ['glowstone', 0xf9d68f],
  ['crimson', 0x883a4c], ['warped', 0x2b6963], ['mushroom', 0xc0a487], ['leaves', 0xb4b4b4],
  ['oak', 0xb8945f], ['spruce', 0x785431], ['birch', 0xc8b184], ['jungle', 0xa0714a],
  ['acacia', 0xba6337], ['mangrove', 0x763228], ['cherry', 0xe3b3ab], ['bamboo', 0xc2ce5d],
  ['kelp', 0x4a7c2a], ['water', 0xc8c8c8], ['lava', 0xd45b12], ['fire', 0xe8a020],
  ['wood', 0xa07b4b], ['log', 0x6a532f], ['plank', 0xb8945f], ['stick', 0x8b6a3f],
  ['egg', 0xe0dccf], ['potion', 0xb04ad6], ['dye', 0xcf5aa5], ['banner', 0xc9c9c9],
  ['disc', 0x2a2a2a], ['book', 0xa0522d], ['paper', 0xf0f0e8], ['map', 0xe4d8ac],
  ['leather', 0xa06540], ['chainmail', 0xb0b0b0], ['turtle', 0x5eae4d], ['elytra', 0xb0a8b0],
];

function fallbackColor(name) {
  for (let i = 0; i < FALLBACK_WORDS.length; i++) {
    if (name.indexOf(FALLBACK_WORDS[i][0]) >= 0) return FALLBACK_WORDS[i][1];
  }
  const h = hashString(name);
  return hsv(((h >>> 8) % 360) / 360, 0.28 + ((h >>> 3) % 32) / 128, 0.45 + ((h >>> 17) % 40) / 100);
}

function fallbackFamily(name) {
  const has = (s) => name.indexOf(s) >= 0;
  if (has('_sword') || has('_pickaxe') || has('_axe') || has('_shovel') || has('_hoe')) return 'tool';
  if (has('_helmet') || has('_chestplate') || has('_leggings') || has('_boots')) return 'armor';
  if (has('spawn_egg')) return 'egg';
  if (has('_ingot') || has('_nugget') || has('_scrap')) return 'ingot';
  if (has('_dye')) return 'dye';
  if (has('_seeds') || has('_pod')) return 'seeds';
  if (has('_planks') || has('_plank')) return 'planks';
  if (has('_log') || has('_stem') || has('_wood') || has('_hyphae')) return name.endsWith('_top') ? 'logtop' : 'log';
  if (has('_ore')) return 'ore';
  if (has('_leaves')) return 'leaves';
  if (has('_wool') || has('_carpet')) return 'wool';
  if (has('glass')) return 'glass';
  if (has('_bricks') || has('_brick') || has('brick_')) return 'bricks';
  if (has('_tiles')) return 'tiles';
  if (has('chiseled') || has('carved')) return 'chiseled';
  if (has('_sapling') || has('_flower') || has('flower_') || has('_fungus') || has('_roots') ||
      has('_bush') || has('_grass') || has('_fern') || has('_vines') || has('_sprouts')) return 'plant';
  if (has('_stage')) return 'crop';
  if (has('_concrete')) return 'flat';
  if (has('_door') || has('_trapdoor')) return 'planks';
  if (has('cobble')) return 'cobble';
  if (has('_head') || has('_skull')) return 'chiseled';
  return 'noise';
}

/** Builds a deterministic draw function for an unregistered texture name. */
function fallbackFor(name) {
  const base = fallbackColor(name);
  const fam = fallbackFamily(name);
  return (ctx, rng) => {
    switch (fam) {
      case 'planks': plank(ctx, rng, base, shade(base, 0.82), 4); break;
      case 'log': logSide(ctx, rng, base, shade(base, 0.6)); break;
      case 'logtop': logTop(ctx, rng, shade(base, 1.2), shade(base, 0.7)); break;
      case 'ore': oreOverlay(ctx, rng, 'stone', base, 5); break;
      case 'leaves': leafMask(ctx, rng, 0.14); break;
      case 'wool': woolTex(ctx, rng, base); break;
      case 'glass': glassTex(ctx, rng, base, 0.32); break;
      case 'bricks': brick(ctx, rng, shade(base, 0.72), base, 4); break;
      case 'tiles': tileGrid(ctx, rng, base, shade(base, 0.65), 2); break;
      case 'chiseled': chiseled(ctx, rng, base, 'eye'); break;
      case 'cobble': cobble(ctx, rng, base); break;
      case 'flat': noise(ctx, rng, base, 0.03, { fine: 0.02 }); break;
      case 'plant': clear(ctx); drawTuft(ctx, rng, base, shade(base, 0.7), 6); break;
      case 'crop': clear(ctx); drawCropStalks(ctx, rng, base, 4); break;
      case 'tool': sprite(ctx, SPR.pickaxe, toolPalette(base)); outline(ctx, 0x21160c, 0.85); break;
      case 'armor': sprite(ctx, SPR.helmet, toolPalette(base)); outline(ctx, 0x21160c, 0.85); break;
      case 'ingot': sprite(ctx, SPR.ingot, { M: base, m: shade(base, 0.7), l: shade(base, 1.2) }); outline(ctx, 0x21160c, 0.85); break;
      case 'egg': drawSpawnEgg(ctx, rng, base, shade(base, 0.55)); break;
      case 'dye': drawDyePile(ctx, rng, base); break;
      case 'seeds': drawSeeds(ctx, rng, base); break;
      default: noise(ctx, rng, base, 0.11, { fine: 0.06 }); speckle(ctx, rng, shade(base, 0.8), 10); break;
    }
  };
}

// ===========================================================================
// Palettes
// ===========================================================================
const DYE = {
  white: 0xf9fffe, orange: 0xf9801d, magenta: 0xc74ebd, light_blue: 0x3ab3da,
  yellow: 0xfed83d, lime: 0x80c71f, pink: 0xf38baa, gray: 0x474f52,
  light_gray: 0x9d9d97, cyan: 0x169c9c, purple: 0x8932b8, blue: 0x3c44aa,
  brown: 0x835432, green: 0x5e7c16, red: 0xb02e26, black: 0x1d1d21,
};
const COLORS = Object.keys(DYE);

const WOOL_COLOR = {
  white: 0xe9ecec, orange: 0xf07613, magenta: 0xbd44b3, light_blue: 0x3aafd9,
  yellow: 0xf8c527, lime: 0x70b919, pink: 0xed8dac, gray: 0x3e4447,
  light_gray: 0x8e8e86, cyan: 0x158991, purple: 0x792ab3, blue: 0x35399d,
  brown: 0x724728, green: 0x546d1b, red: 0xa12722, black: 0x141519,
};
const CONCRETE_COLOR = {
  white: 0xcfd5d6, orange: 0xe06101, magenta: 0xa9309f, light_blue: 0x2489c7,
  yellow: 0xf1af15, lime: 0x5ea918, pink: 0xd5658f, gray: 0x36393d,
  light_gray: 0x7d7d73, cyan: 0x157788, purple: 0x64209c, blue: 0x2d2f8f,
  brown: 0x603c20, green: 0x495b24, red: 0x8e2121, black: 0x080a0f,
};
const TERRACOTTA_COLOR = {
  white: 0xd1b1a1, orange: 0xa15325, magenta: 0x95586c, light_blue: 0x706c8a,
  yellow: 0xba8523, lime: 0x677535, pink: 0xa14f4f, gray: 0x392a23,
  light_gray: 0x876a61, cyan: 0x575b5b, purple: 0x764656, blue: 0x4a3b5b,
  brown: 0x4d3323, green: 0x4c522a, red: 0x8e3c2e, black: 0x251610,
};

const STONE = 0x7a7a7a;
const DIRT = 0x866043;
const NETHERRACK = 0x703634;
const END_STONE = 0xdbdc9f;
const DEEPSLATE = 0x4d4d51;
const STICK_A = 0x8b6a3f, STICK_B = 0x6b4f2e;

const TOOL_MATERIAL = {
  wooden: [0xa07b4b, 0x6f5231, 0xbc9560],
  stone: [0x7d7d7d, 0x585858, 0x9b9b9b],
  iron: [0xd8d8d8, 0x9a9a9a, 0xf2f2f2],
  golden: [0xfcee4b, 0xc9a227, 0xfff9a8],
  diamond: [0x4aedd9, 0x2ba597, 0x9ffaef],
  netherite: [0x4d4a4d, 0x302d30, 0x6f6669],
  leather: [0xa06540, 0x6d4327, 0xc08a63],
  chainmail: [0xb0b0b0, 0x7a7a7a, 0xd8d8d8],
  turtle: [0x5eae4d, 0x3d7a33, 0x8fd07c],
};

function toolPalette(main) {
  const m = Array.isArray(main) ? main : [main, shade(main, 0.7), shade(main, 1.25)];
  return { M: m[0], m: m[1], l: m[2], H: STICK_A, h: STICK_B, G: m[1], P: m[2], W: 0xffffff };
}
