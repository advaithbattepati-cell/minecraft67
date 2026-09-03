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

// ===========================================================================
// Shared procedural item/plant helpers
// ===========================================================================
function woolTex(ctx, rng, color) {
  noise(ctx, rng, color, 0.055, { cell: 1, fine: 0.04 });
  for (let i = 0; i < 26; i++) {
    const x = rng.int(TILE), y = rng.int(TILE);
    px(ctx, x, y, shade(color, 1.12));
    px(ctx, x + 1, y + 1, shade(color, 0.88));
  }
}

function glassTex(ctx, rng, color, alpha = 0.22) {
  clear(ctx);
  rect(ctx, 0, 0, TILE, TILE, color, alpha);
  border(ctx, shade(color, 1.15), 0, Math.min(1, alpha + 0.5));
  rect(ctx, 2, 2, 4, 1, 0xffffff, 0.5);
  rect(ctx, 2, 2, 1, 4, 0xffffff, 0.36);
  rect(ctx, 10, 11, 4, 1, 0xffffff, 0.22);
  for (let i = 0; i < 6; i++) px(ctx, 1 + rng.int(14), 1 + rng.int(14), 0xffffff, 0.15);
}

/** Blades of grass / small plants growing up from `baseY`. */
function drawTuft(ctx, rng, a, b, blades = 7, baseY = 15, height = 10) {
  for (let i = 0; i < blades; i++) {
    let cx = 1 + rng.int(14);
    const h = 3 + rng.int(height);
    const c = rng.bool() ? a : b;
    for (let k = 0; k < h; k++) {
      px(ctx, cx, baseY - k, k > h - 3 ? shade(c, 1.18) : c);
      if (rng.next() < 0.28) cx += rng.bool() ? 1 : -1;
    }
  }
}

/** Evenly spaced crop stalks - the basis of every *_stageN texture. */
function drawCropStalks(ctx, rng, color, height, seedColor) {
  clear(ctx);
  const cols = [2, 6, 9, 13];
  for (let i = 0; i < cols.length; i++) {
    const x = cols[i];
    const h = height + (rng.next() < 0.4 ? 1 : 0);
    for (let k = 0; k < h; k++) {
      px(ctx, x, 15 - k, k === h - 1 ? shade(color, 1.2) : color);
      if (k > 1 && k % 3 === 0) {
        px(ctx, x - 1, 15 - k, shade(color, 0.85));
        px(ctx, x + 1, 15 - k, shade(color, 0.85));
      }
    }
    if (seedColor != null && h > 3) {
      px(ctx, x, 15 - h, seedColor);
      px(ctx, x, 14 - h, seedColor);
    }
  }
}

function drawSeeds(ctx, rng, color) {
  clear(ctx);
  const spots = [[4, 5], [8, 4], [11, 7], [5, 9], [9, 10], [7, 7], [3, 11], [12, 11]];
  for (const [x, y] of spots) {
    px(ctx, x, y, color);
    px(ctx, x + 1, y, shade(color, 0.82));
    px(ctx, x, y + 1, shade(color, 0.92));
  }
  outline(ctx, 0x2a2314, 0.7);
}

function drawDyePile(ctx, rng, color) {
  clear(ctx);
  const rows = [
    [6, 6, 4], [5, 7, 6], [4, 8, 8], [3, 9, 10], [3, 10, 10], [4, 11, 8],
  ];
  for (const [x, y, w] of rows) rect(ctx, x, y, w, 1, jit(rng, color, 0.1));
  for (let i = 0; i < 10; i++) px(ctx, 3 + rng.int(10), 6 + rng.int(6), shade(color, 1.2));
  px(ctx, 7, 5, shade(color, 1.25));
  px(ctx, 10, 6, shade(color, 0.8));
  outline(ctx, 0x22190f, 0.7);
}

function drawSpawnEgg(ctx, rng, base, spot) {
  clear(ctx);
  sprite(ctx, SPR.egg, { B: base });
  const spots = [[6, 4], [9, 6], [5, 7], [8, 9], [11, 10], [6, 11], [9, 12], [4, 9], [10, 3]];
  for (const [x, y] of spots) {
    px(ctx, x, y, spot);
    px(ctx, x + 1, y, spot);
    px(ctx, x, y + 1, spot);
  }
  // highlight + shading
  px(ctx, 6, 3, shade(base, 1.3));
  px(ctx, 7, 3, shade(base, 1.3));
  for (let y = 10; y < 14; y++) px(ctx, 11, y, shade(base, 0.75), 0.5);
  outline(ctx, 0x1c1c1c, 0.85);
}

/** A vinyl record for the music discs. */
function drawDisc(ctx, rng, ringColor) {
  clear(ctx);
  circle(ctx, 8, 8, 7.2, 0x1d1d21);
  ring(ctx, 8, 8, 6.0, 0x2f2f33, 0.6);
  ring(ctx, 8, 8, 4.6, 0x2f2f33, 0.6);
  circle(ctx, 8, 8, 2.6, ringColor);
  circle(ctx, 8, 8, 0.9, 0x1d1d21);
  px(ctx, 5, 4, 0x50505a);
  px(ctx, 6, 3, 0x50505a);
  outline(ctx, 0x101014, 0.9);
}

/** Cloth banner on a stick, used for the 16 banner items. */
function drawBanner(ctx, rng, color) {
  clear(ctx);
  rect(ctx, 2, 1, 12, 1, 0x6b4f2e);
  rect(ctx, 3, 2, 10, 9, color);
  for (let i = 0; i < 8; i++) px(ctx, 3 + rng.int(10), 2 + rng.int(9), shade(color, 1.12));
  rect(ctx, 3, 11, 2, 1, color);
  rect(ctx, 7, 11, 2, 1, color);
  rect(ctx, 11, 11, 2, 1, color);
  rect(ctx, 7, 12, 2, 3, 0x8b6a3f);
  outline(ctx, 0x241a10, 0.8);
}

// ===========================================================================
// Sprite templates (16 rows of 16 palette keys, '.' = transparent).
// Keys: M main, m dark, l light, H handle, h handle-dark, G guard, P pommel,
//       W white highlight, plus per-sprite extras.
// ===========================================================================
const SPR = {
  sword: [
    '................', '.............MM.', '............MMm.', '...........MMm..',
    '..........MMm...', '.........MMm....', '........MMm.....', '.......MMm......',
    '......MMm.......', '....GGMm........', '...GGGm.........', '...GG...........',
    '..HH............', '.HH.............', '.P..............', '................',
  ],
  pickaxe: [
    '................', '.....MMMMMM.....', '....MmmmmmmM....', '...MM..HH..mM...',
    '...M...HH...M...', '.......HH.......', '......HH........', '......HH........',
    '.....HH.........', '.....HH.........', '....HH..........', '....HH..........',
    '...HH...........', '...HH...........', '..HH............', '................',
  ],
  axe: [
    '................', '......MMM.......', '.....MMMMM......', '....MMmmMMM.....',
    '....MMmmHHM.....', '....MMmmH.M.....', '.....MMMH.......', '......MHH.......',
    '......HH........', '.....HH.........', '.....HH.........', '....HH..........',
    '....HH..........', '...HH...........', '...HH...........', '................',
  ],
  shovel: [
    '................', '.......MMM......', '......MmmmM.....', '......MmmmM.....',
    '......MmmmM.....', '.......MMM......', '.......HH.......', '.......HH.......',
    '......HH........', '......HH........', '.....HH.........', '.....HH.........',
    '....HH..........', '....HH..........', '...HH...........', '................',
  ],
  hoe: [
    '................', '....MMMMM.......', '....MmmmM.......', '....MM..MM......',
    '........HH......', '.......HH.......', '.......HH.......', '......HH........',
    '......HH........', '.....HH.........', '.....HH.........', '....HH..........',
    '....HH..........', '...HH...........', '...HH...........', '................',
  ],
  helmet: [
    '................', '................', '................', '....MMMMMMMM....',
    '...MMMMMMMMMM...', '...MMMMMMMMMM...', '...MMM....MMM...', '...MM......MM...',
    '...MM......MM...', '...MMM....MMM...', '...MMM....MMM...', '................',
    '................', '................', '................', '................',
  ],
  chestplate: [
    '................', '................', '..MM........MM..', '.MMMMMMMMMMMMMM.',
    '.MMMMMMMMMMMMMM.', '.MMmMMMMMMMMmMM.', '.MMMMMMMMMMMMMM.', '..MMMMMMMMMMMM..',
    '..MMMMMMMMMMMM..', '..MMMMMMMMMMMM..', '..MMMMMMMMMMMM..', '..MMMM....MMMM..',
    '..MMM......MMM..', '................', '................', '................',
  ],
  leggings: [
    '................', '................', '..MMMMMMMMMMMM..', '..MMMMMMMMMMMM..',
    '..MMMMMMMMMMMM..', '..MMmMMMMMMmMM..', '..MMMM....MMMM..', '..MMMM....MMMM..',
    '..MMMM....MMMM..', '..MMMM....MMMM..', '..MMM......MMM..', '..MMM......MMM..',
    '..MMM......MMM..', '................', '................', '................',
  ],
  boots: [
    '................', '................', '................', '................',
    '................', '................', '..MMMM....MMMM..', '..MMMM....MMMM..',
    '..MMMM....MMMM..', '..MMMM....MMMM..', '..MMMMM..MMMMM..', '..mMMMM..MMMMm..',
    '................', '................', '................', '................',
  ],
  ingot: [
    '................', '................', '................', '................',
    '.....llllll.....', '....MMMMMMMM....', '...MMMMMMMMMM...', '...MMMMMMMMMM...',
    '...mMMMMMMMMm...', '...mmmmmmmmmm...', '................', '................',
    '................', '................', '................', '................',
  ],
  nugget: [
    '................', '................', '................', '................',
    '................', '......ll........', '.....MMMM.......', '....MMMMMM......',
    '....MMMMMM......', '.....mMMm.......', '......mm........', '................',
    '................', '................', '................', '................',
  ],
  gem: [
    '................', '................', '................', '......MMMM......',
    '.....MMMMMM.....', '....MMMWMMMM....', '...MMMWWMMMMM...', '...MMMWMMMMMM...',
    '...mMMMMMMMMm...', '....mMMMMMMm....', '.....mMMMMm.....', '......mmmm......',
    '................', '................', '................', '................',
  ],
  rod: [
    '................', '.............MM.', '............MM..', '...........MM...',
    '..........MM....', '.........MM.....', '........MM......', '.......MM.......',
    '......MM........', '.....MM.........', '....MM..........', '...MM...........',
    '..MM............', '.MM.............', '................', '................',
  ],
  apple: [
    '................', '................', '.......h........', '......h.LL......',
    '.....MMMLL......', '....MMMMMMM.....', '...MMMMMMMMM....', '...MWMMMMMMM....',
    '...MMMMMMMMM....', '...MMMMMMMMM....', '....MMMMMMM.....', '.....MMMMM......',
    '......MMM.......', '................', '................', '................',
  ],
  bread: [
    '................', '................', '................', '....MMMMMMM.....',
    '...MllMMlMMM....', '..MMMMMMMMMMMM..', '..MlMMMlMMMlMM..', '..MMMMMMMMMMMM..',
    '...MMMMMMMMMM...', '....mmmmmmmm....', '................', '................',
    '................', '................', '................', '................',
  ],
  meat: [
    '................', '................', '......MMMM......', '.....MMMMMM.....',
    '....MMlMMMMM....', '...MMMMMMMMMM...', '...MMMmMMMMMM...', '..MMMMMMMMMMM...',
    '..MMMMMMMMmMM...', '...MMMMMMMMM....', '....MMMMMMM.....', '.....MMMM.......',
    '................', '................', '................', '................',
  ],
  fish: [
    '................', '................', '..............M.', '.....MMMM....MM.',
    '...MMMMMMMM.MMM.', '..MMMMMMMMMMMM..', '.MMlMMMMMMMMM...', '.MMWMMMMMMMMMM..',
    '.MMMMMMMMMMMMM..', '..MMMMMMMMMMM...', '...MMMMMMM.MMM..', '.....MMMM...MM..',
    '.............M..', '................', '................', '................',
  ],
  carrot: [
    '................', '.........LL.....', '........LLL.L...', '.......L.LLL....',
    '.......MMLL.....', '......MMMM......', '......MMM.......', '.....MMM........',
    '.....MM.........', '....MMM.........', '....MM..........', '...MM...........',
    '...M............', '..M.............', '................', '................',
  ],
  potato: [
    '................', '................', '.....MMMMM......', '....MMMMMMM.....',
    '...MMmMMMMMM....', '...MMMMMMMMM....', '...MMMMMmMMM....', '...MMMMMMMMM....',
    '....MMMMMMM.....', '.....MMMMM......', '................', '................',
    '................', '................', '................', '................',
  ],
  bowl: [
    '................', '................', '................', '................',
    '..SSSSSSSSSSSS..', '..SSSSSSSSSSSS..', '..BBBBBBBBBBBB..', '..BBBBBBBBBBBB..',
    '...BBBBBBBBBB...', '....BBBBBBBB....', '.....BBBBBB.....', '................',
    '................', '................', '................', '................',
  ],
  bottle: [
    '................', '.......CC.......', '.......CC.......', '......CCCC......',
    '......C..C......', '.....C....C.....', '.....CLLLLC.....', '....CLLLLLLC....',
    '....CLLLLLLC....', '....CLLLLLLC....', '....CLLLLLLC....', '.....CLLLLC.....',
    '......CCCC......', '................', '................', '................',
  ],
  bucket: [
    '................', '................', '...M........M...', '...MM......MM...',
    '...MMMMMMMMMM...', '...MMMMMMMMMM...', '...MFFFFFFFFM...', '...MFFFFFFFFM...',
    '...MFFFFFFFFM...', '....MFFFFFFM....', '....MFFFFFFM....', '.....MMMMMM.....',
    '................', '................', '................', '................',
  ],
  book: [
    '................', '................', '..MMMMMMMMMMMM..', '..MPPPPPPPPPPM..',
    '..MPWWWWWWWWPM..', '..MPPPPPPPPPPM..', '..MPWWWWWWWWPM..', '..MPPPPPPPPPPM..',
    '..MPWWWWWWWWPM..', '..MPPPPPPPPPPM..', '..MMMMMMMMMMMM..', '................',
    '................', '................', '................', '................',
  ],
  paper: [
    '................', '................', '...WWWWWWWWWW...', '...WWWWWWWWWW...',
    '...WWggWWggWW...', '...WWWWWWWWWW...', '...WWggWWggWW...', '...WWWWWWWWWW...',
    '...WWWWWWWWWW...', '...WWWWWWWWWW...', '................', '................',
    '................', '................', '................', '................',
  ],
  arrow: [
    '................', '.............TT.', '............TTT.', '...........TTs..',
    '..........ss....', '.........ss.....', '........ss......', '.......ss.......',
    '......ss........', '.....ss.........', '....FFs.........', '...FFFF.........',
    '..FF.FF.........', '.FF..F..........', '.F..............', '................',
  ],
  bow: [
    '................', '..........MMM...', '........MM...M..', '.......M....SM..',
    '......M....S..M.', '.....M....S...M.', '....M....S....M.', '....M...S.....M.',
    '....M..S......M.', '.....M.S.....M..', '......MS....M...', '.......S...M....',
    '.......S.MM.....', '.......S........', '................', '................',
  ],
  egg: [
    '................', '................', '......BBBB......', '.....BBBBBB.....',
    '....BBBBBBBB....', '....BBBBBBBB....', '...BBBBBBBBBB...', '...BBBBBBBBBB...',
    '...BBBBBBBBBB...', '...BBBBBBBBBB...', '....BBBBBBBB....', '....BBBBBBBB....',
    '.....BBBBBB.....', '......BBBB......', '................', '................',
  ],
  bone: [
    '................', '.............MM.', '............MMMM', '............MMMM',
    '...........MMMM.', '..........MM....', '.........MM.....', '........MM......',
    '.......MM.......', '......MM........', '.....MM.........', '.MMMM...........',
    'MMMM............', 'MMMM............', '.MM.............', '................',
  ],
  feather: [
    '................', '..........MMM...', '.........MMWMM..', '........MMWWM...',
    '.......MMWWM....', '......MMWWM.....', '.....MMWWM......', '....MMWWM.......',
    '...MMWM.........', '..MMWM..........', '..MWM...........', '..MM............',
    '..M.............', '.M..............', '................', '................',
  ],
  stickspr: [
    '................', '............MM..', '...........MM...', '..........Mm....',
    '.........Mm.....', '........Mm......', '.......Mm.......', '......Mm........',
    '.....Mm.........', '....Mm..........', '...Mm...........', '..MM............',
    '..M.............', '................', '................', '................',
  ],
  pearl: [
    '................', '................', '......MMMM......', '.....MWMMMM.....',
    '....MWMMMMMM....', '...MWMMMMMMMM...', '...MMMMMMMMMM...', '...MMMMMMMMMM...',
    '...MMMMMMMMMM...', '...MMMMMMMMMm...', '....MMMMMMMm....', '.....MMMMMm.....',
    '......MMMM......', '................', '................', '................',
  ],
  shears: [
    '................', '..M..........M..', '..MM........MM..', '...MM......MM...',
    '....MM....MM....', '.....MM..MM.....', '......MMMM......', '.......GG.......',
    '......HGGH......', '.....HH..HH.....', '....HH....HH....', '...HH......HH...',
    '..HH........HH..', '..H..........H..', '................', '................',
  ],
  compass: [
    '................', '................', '.....MMMMMM.....', '....MSSSSSSM....',
    '...MSSSSSSSSM...', '...MSSSRRSSSM...', '...MSSSRRSSSM...', '...MSSWWSSSSM...',
    '...MSSWWSSSSM...', '...MSSSSSSSSM...', '....MSSSSSSM....', '.....MMMMMM.....',
    '................', '................', '................', '................',
  ],
  clock: [
    '................', '................', '.....MMMMMM.....', '....MWWWWWWM....',
    '...MWWWWWWWWM...', '...MWWWmWWWWM...', '...MWWWmWWWWM...', '...MWWmmmWWWM...',
    '...MWWWWWWWWM...', '...MWWWWWWWWM...', '....MWWWWWWM....', '.....MMMMMM.....',
    '................', '................', '................', '................',
  ],
  saddle: [
    '................', '................', '................', '....MMMMMMMM....',
    '...MMMMMMMMMM...', '..MMMmmmmmmMMM..', '.MMMMmmmmmmMMMM.', 'MMMMMmmmmmmMMMMM',
    'MMMMMMMMMMMMMMMM', '.MMMMMMMMMMMMMM.', '..MMMMMMMMMMMM..', '....MM....MM....',
    '....MM....MM....', '................', '................', '................',
  ],
  shield: [
    '................', '...MMMMMMMMMM...', '...MSSSSSSSSM...', '...MSWWWWWWSM...',
    '...MSWWWWWWSM...', '...MSWWWWWWSM...', '...MSWWWWWWSM...', '...MSSSSSSSSM...',
    '...MSSSSSSSSM...', '....MSSSSSSM....', '.....MSSSSM.....', '......MSSM......',
    '.......MM.......', '................', '................', '................',
  ],
  trident: [
    '................', '..M.........M...', '..MM.......MM...', '..MM..MMM..MM...',
    '..MM..MMM..MM...', '..MMMMMMMMMMM...', '...MMMMMMMMM....', '.....MMHMM......',
    '.......H........', '.......H........', '......H.........', '......H.........',
    '.....H..........', '.....H..........', '....H...........', '................',
  ],
  totem: [
    '................', '.....MMMMMM.....', '....MMMMMMMM....', '....MmMMMMmM....',
    '....MMMMMMMM....', '....MMmmmmMM....', '.....MMMMMM.....', '...MMMMMMMMMM...',
    '..MMMMMMMMMMMM..', '..MMMMMMMMMMMM..', '...MMMMMMMMMM...', '.....MMMMMM.....',
    '.....MM..MM.....', '.....MM..MM.....', '................', '................',
  ],
  spyglass: [
    '................', '.............MM.', '............MMM.', '...........MMM..',
    '..........MMM...', '.........MMM....', '........MMM.....', '.......MMM......',
    '......MMM.......', '.....MMM........', '....MMM.........', '...MMM..........',
    '..CCC...........', '..CC............', '................', '................',
  ],
  nametag: [
    '................', '................', '................', '....MMMMMMMMMM..',
    '...MMMMMMMMMMMM.', '..MMmmmmmmmmMMM.', '..MmMMMMMMMMmMM.', '..MmMMMMMMMMmMM.',
    '..MMmmmmmmmmMMM.', '...MMMMMMMMMMMM.', '....MMMMMMMMMM..', '................',
    '................', '................', '................', '................',
  ],
  star: [
    '................', '................', '.......M........', '.......MM.......',
    '......MMM.......', '..MMMMMMMMMMM...', '...MMMMMMMMM....', '....MMMMMMM.....',
    '....MMMMMMM.....', '...MMMM.MMMM....', '..MMM.....MMM...', '..M.........M...',
    '................', '................', '................', '................',
  ],
  minecart: [
    '................', '................', '..M..........M..', '..M..........M..',
    '..M..........M..', '..MMMMMMMMMMMM..', '..MMMMMMMMMMMM..', '..MMMMMMMMMMMM..',
    '...MMMMMMMMMM...', '....mmmmmmmm....', '...M..M..M..M...', '..MMM.MMMM.MMM..',
    '...M..M..M..M...', '................', '................', '................',
  ],
  boat: [
    '................', '................', '................', '..M..........M..',
    '..M..........M..', '..M...HHHH...M..', '..M...HHHH...M..', '..MM........MM..',
    '..MMMMMMMMMMMM..', '...MMMMMMMMMM...', '....MMMMMMMM....', '................',
    '................', '................', '................', '................',
  ],
  elytra: [
    '................', '..MMM......MMM..', '.MMMMM....MMMMM.', 'MMMMMMM..MMMMMMM',
    'MMMMMMMmmMMMMMMM', 'MMMMMMMmmMMMMMMM', '.MMMMMMmmMMMMMM.', '.MMMMMMmmMMMMMM.',
    '..MMMMMmmMMMMM..', '..MMMMMmmMMMMM..', '...MMMMmmMMMM...', '....MMMmmMMM....',
    '.....MMmmMM.....', '................', '................', '................',
  ],
  horsearmor: [
    '................', '................', '...MMMM..MMMM...', '..MMMMMMMMMMMM..',
    '..MmMMMMMMMMmM..', '..MMMMMMMMMMMM..', '..MMMMMMMMMMMM..', '...MMMMMMMMMM...',
    '...MMMMMMMMMM...', '....MMM..MMM....', '....MMM..MMM....', '.....M....M.....',
    '................', '................', '................', '................',
  ],
  map: [
    '................', '.MMMMMMMMMMMMMM.', '.MWWWWWWWWWWWWM.', '.MWWggWWWWggWWM.',
    '.MWgggWWWWgggWM.', '.MWWggWWggWWWWM.', '.MWWWWWgggWWWWM.', '.MWWggWWggWWWWM.',
    '.MWgggWWWWWggWM.', '.MWWggWWWWgggWM.', '.MWWWWWWWWWWWWM.', '.MMMMMMMMMMMMMM.',
    '................', '................', '................', '................',
  ],
  brushspr: [
    '................', '............MMM.', '...........MMM..', '..........MMM...',
    '.........CCC....', '........CCC.....', '.......CCC......', '......HHH.......',
    '.....HHH........', '....WWW.........', '...WWW..........', '..WWW...........',
    '..WW............', '................', '................', '................',
  ],
  sherd: [
    '................', '................', '.....MMMMMM.....', '....MMMMMMMM....',
    '...MMMmMMMmMM...', '...MMMMMMMMMM...', '..MMMMMMMMMMMM..', '..MMMMmMMMMMMM..',
    '..MMMMMMMMMMMM..', '...MMMMMMMMMM...', '....MMMMMMMM....', '.....MMMMMM.....',
    '................', '................', '................', '................',
  ],
  horn: [
    '................', '................', '............MMM.', '..........MMMMM.',
    '........MMMM....', '......MMMM......', '....MMMM........', '...MMM..........',
    '..MMM...........', '..MM............', '..MMM...........', '...MMMM.........',
    '.....MMM........', '................', '................', '................',
  ],
  shard: [
    '................', '................', '.........MM.....', '........MMMM....',
    '.......MMMMM....', '......MMMMMM....', '.....MMMMMm.....', '....MMMMMm......',
    '...MMMMMm.......', '...MMMMm........', '....MMm.........', '.....m..........',
    '................', '................', '................', '................',
  ],
  crossbow: [
    '................', '..M..........M..', '..MM........MM..', '...MM......MM...',
    '....MMSSSSMM....', '.....MSSSSM.....', '.....HHHHHH.....', '....HHHHHHHH....',
    '...HH..HH..HH...', '..HH...HH...HH..', '.......HH.......', '.......HH.......',
    '................', '................', '................', '................',
  ],
  fishingrod: [
    '................', '..............MM', '.............MM.', '............MM..',
    '...........MM.S.', '..........MM..S.', '.........MM...S.', '........MM....S.',
    '.......MM.....S.', '......MM......S.', '.....MM.......S.', '....MM........S.',
    '...MM.........W.', '..MM..........W.', '................', '................',
  ],
  flintsteel: [
    '................', '................', '.........MMMM...', '........MMMMMM..',
    '.......MM....MM.', '......MM......M.', '.....MM.....MM..', '....MM....MMM...',
    '...GG..GGGG.....', '..GGGGGGG.......', '.GGGGGG.........', '.GGGG...........',
    '..GG............', '................', '................', '................',
  ],
};

// ===========================================================================
// TEXTURE REGISTRATION
// Nothing below draws anything at import time - every call just stores a
// closure. `missing` must be registered first so it lands on tile index 0.
// ===========================================================================
const def = defineTexture;

def('missing', (ctx) => drawMissing(ctx));

// --- generic generators ----------------------------------------------------
const stoneTex = (base, amt = 0.11, sp = 14) => (ctx, rng) => {
  noise(ctx, rng, base, amt, { fine: 0.05 });
  speckle(ctx, rng, shade(base, 0.8), sp);
  speckle(ctx, rng, shade(base, 1.16), (sp / 2) | 0);
};
const smoothTex = (base, amt = 0.035) => (ctx, rng) => noise(ctx, rng, base, amt, { fine: 0.025 });
const polishedTex = (base) => (ctx, rng) => {
  noise(ctx, rng, base, 0.04, { fine: 0.03 });
  border(ctx, shade(base, 1.1), 0, 0.55);
  border(ctx, shade(base, 0.85), 1, 0.45);
  rect(ctx, 0, 15, TILE, 1, shade(base, 0.78), 0.5);
};
const brickTex = (mortar, col, rows = 4, bw = 8) => (ctx, rng) => brick(ctx, rng, mortar, col, rows, bw);
const tilesTex = (base, line, n = 2) => (ctx, rng) => tileGrid(ctx, rng, base, line, n);
const cobbleTex = (base) => (ctx, rng) => cobble(ctx, rng, base);
const mossyOf = (baseName, amount = 0.34) => (ctx, rng) => { drawInto(ctx, baseName); mossOverlay(ctx, rng, amount); };
const crackedOf = (baseName, color, n = 5) => (ctx, rng) => { drawInto(ctx, baseName); crackOverlay(ctx, rng, color, n); };
const oreTex = (host, gem, blobs = 5) => (ctx, rng) => oreOverlay(ctx, rng, host, gem, blobs);

// --- stone -----------------------------------------------------------------
def('stone', stoneTex(0x7a7a7a, 0.1, 16));
def('granite', stoneTex(0x9a6659, 0.1, 18));
def('polished_granite', polishedTex(0x9c6c5e));
def('diorite', stoneTex(0xcdcdcd, 0.09, 20));
def('polished_diorite', polishedTex(0xd0d3d4));
def('andesite', stoneTex(0x8f9192, 0.09, 18));
def('polished_andesite', polishedTex(0x999b99));
def('cobblestone', cobbleTex(0x8c8c8c));
def('mossy_cobblestone', mossyOf('cobblestone', 0.32));
def('smooth_stone', (ctx, rng) => { noise(ctx, rng, 0x9f9f9f, 0.04, { fine: 0.03 }); rect(ctx, 0, 0, TILE, 1, 0x8a8a8a); rect(ctx, 0, 15, TILE, 1, 0x8a8a8a); });
def('smooth_stone_slab_side', (ctx, rng) => { noise(ctx, rng, 0x9f9f9f, 0.04); rect(ctx, 0, 0, TILE, 2, 0xb0b0b0); rect(ctx, 0, 14, TILE, 2, 0x8a8a8a); });
def('stone_bricks', brickTex(0x5f5f5f, 0x7b7b7b, 2, 8));
def('mossy_stone_bricks', mossyOf('stone_bricks', 0.3));
def('cracked_stone_bricks', crackedOf('stone_bricks', 0x4a4a4a, 6));
def('chiseled_stone_bricks', (ctx, rng) => chiseled(ctx, rng, 0x7b7b7b, 'eye'));
def('bedrock', (ctx, rng) => { noise(ctx, rng, 0x565656, 0.28, { cell: 2, fine: 0.12 }); speckle(ctx, rng, 0x2a2a2a, 22, 2); speckle(ctx, rng, 0x8a8a8a, 10, 2); });
def('obsidian', (ctx, rng) => { noise(ctx, rng, 0x14121f, 0.22, { cell: 2, fine: 0.1 }); speckle(ctx, rng, 0x2b2545, 14); speckle(ctx, rng, 0x5b4a8a, 5); });
def('crying_obsidian', (ctx, rng) => { drawInto(ctx, 'obsidian'); for (let i = 0; i < 7; i++) { const x = rng.int(TILE), y = rng.int(10); rect(ctx, x, y, 1, 2 + rng.int(4), 0x6a24c6); px(ctx, x, y, 0xb26bff); } });

// --- deepslate -------------------------------------------------------------
def('deepslate', (ctx, rng) => { noise(ctx, rng, DEEPSLATE, 0.13, { fine: 0.06 }); for (let i = 0; i < 5; i++) rect(ctx, 0, rng.int(TILE), TILE, 1, shade(DEEPSLATE, 0.8), 0.6); speckle(ctx, rng, 0x63636a, 10); });
def('deepslate_top', stoneTex(0x50505a, 0.12, 16));
def('cobbled_deepslate', cobbleTex(0x53535a));
def('polished_deepslate', polishedTex(0x48484c));
def('deepslate_bricks', brickTex(0x33333a, 0x4a4a50, 2, 8));
def('cracked_deepslate_bricks', crackedOf('deepslate_bricks', 0x24242a, 6));
def('deepslate_tiles', tilesTex(0x38383e, 0x232328, 2));
def('cracked_deepslate_tiles', crackedOf('deepslate_tiles', 0x1d1d22, 6));
def('chiseled_deepslate', (ctx, rng) => chiseled(ctx, rng, 0x39393f, 'cross'));
def('reinforced_deepslate_top', (ctx, rng) => { drawInto(ctx, 'deepslate_top'); border(ctx, 0x2b2f2b, 1); rect(ctx, 5, 5, 6, 6, 0x1e2b1e); });
def('reinforced_deepslate_side', (ctx, rng) => { drawInto(ctx, 'deepslate'); border(ctx, 0x2b2f2b, 1); });
def('reinforced_deepslate_bottom', stoneTex(0x3a3a40, 0.1, 12));

// --- other rock ------------------------------------------------------------
def('tuff', stoneTex(0x6d6f65, 0.13, 20));
def('calcite', stoneTex(0xdfdedb, 0.05, 12));
def('dripstone_block', (ctx, rng) => { noise(ctx, rng, 0x8b6c5c, 0.12, { fine: 0.06 }); for (let x = 0; x < TILE; x += 2) rect(ctx, x, 0, 1, TILE, shade(0x8b6c5c, 0.85), 0.5); speckle(ctx, rng, 0x6e5145, 12); });
for (const p of ['tip', 'frustum', 'middle', 'base']) {
  for (const d of ['up', 'down']) {
    def('pointed_dripstone_' + d + '_' + p, (ctx, rng) => {
      clear(ctx);
      const w = p === 'tip' ? 2 : p === 'frustum' ? 4 : p === 'middle' ? 6 : 8;
      for (let y = 0; y < TILE; y++) {
        const t = d === 'up' ? y / 15 : 1 - y / 15;
        const half = Math.max(1, (w * (0.35 + t * 0.65)) / 2) | 0;
        for (let x = 8 - half; x < 8 + half; x++) px(ctx, x, y, jit(rng, 0x8b6c5c, 0.14));
      }
    });
  }
}
def('blackstone', stoneTex(0x2b2426, 0.16, 14));
def('blackstone_top', stoneTex(0x312a2d, 0.15, 14));
def('polished_blackstone', polishedTex(0x38333c));
def('polished_blackstone_bricks', brickTex(0x241f26, 0x322c33, 2, 8));
def('cracked_polished_blackstone_bricks', crackedOf('polished_blackstone_bricks', 0x171317, 6));
def('chiseled_polished_blackstone', (ctx, rng) => chiseled(ctx, rng, 0x35303a, 'diamond'));
def('gilded_blackstone', (ctx, rng) => oreOverlay(ctx, rng, 'blackstone', 0xfcee4b, 4));
def('basalt_top', (ctx, rng) => { noise(ctx, rng, 0x50505a, 0.1, { fine: 0.05 }); ring(ctx, 8, 8, 5, 0x3d3d47, 0.7); ring(ctx, 8, 8, 2.5, 0x3d3d47, 0.7); });
def('basalt_side', (ctx, rng) => { noise(ctx, rng, 0x50505a, 0.09); for (let x = 0; x < TILE; x++) if (rng.next() < 0.55) rect(ctx, x, 0, 1, TILE, shade(0x50505a, 0.78 + rng.next() * 0.3)); });
def('polished_basalt_top', (ctx, rng) => { noise(ctx, rng, 0x5d5d67, 0.06); ring(ctx, 8, 8, 4.5, 0x494952, 0.6); });
def('polished_basalt_side', (ctx, rng) => { noise(ctx, rng, 0x5d5d67, 0.05); for (let x = 1; x < TILE; x += 2) rect(ctx, x, 0, 1, TILE, 0x4d4d56, 0.65); });
def('smooth_basalt', smoothTex(0x48484f, 0.06));

// --- nether / end ----------------------------------------------------------
def('netherrack', (ctx, rng) => { noise(ctx, rng, NETHERRACK, 0.16, { fine: 0.09 }); speckle(ctx, rng, 0x5a2626, 16); speckle(ctx, rng, 0x8b4a44, 10); veins(ctx, rng, 0x4d2020, 3, 10, 0.6); });
def('nether_bricks', brickTex(0x1d1114, 0x2e181b, 4, 8));
def('red_nether_bricks', brickTex(0x230507, 0x460709, 4, 8));
def('cracked_nether_bricks', crackedOf('nether_bricks', 0x120a0c, 6));
def('chiseled_nether_bricks', (ctx, rng) => chiseled(ctx, rng, 0x2e181b, 'eye'));
def('nether_wart_block', (ctx, rng) => { noise(ctx, rng, 0x730302, 0.2, { cell: 2, fine: 0.1 }); speckle(ctx, rng, 0x4b0000, 20, 2); speckle(ctx, rng, 0x9c1512, 12, 2); });
def('warped_wart_block', (ctx, rng) => { noise(ctx, rng, 0x167e86, 0.2, { cell: 2, fine: 0.1 }); speckle(ctx, rng, 0x0d5057, 20, 2); speckle(ctx, rng, 0x2ba2ac, 12, 2); });
def('soul_sand', (ctx, rng) => { noise(ctx, rng, 0x51413a, 0.11, { fine: 0.06 }); circle(ctx, 5, 6, 2.2, 0x3a2d28); circle(ctx, 11, 10, 2.4, 0x3a2d28); px(ctx, 4, 5, 0x2a201c); px(ctx, 10, 9, 0x2a201c); speckle(ctx, rng, 0x63504a, 10); });
def('soul_soil', (ctx, rng) => { noise(ctx, rng, 0x4b3a30, 0.13, { fine: 0.07 }); speckle(ctx, rng, 0x362a22, 18); speckle(ctx, rng, 0x5f4c3f, 10); });
def('glowstone', (ctx, rng) => { noise(ctx, rng, 0xa07a3a, 0.1); for (let i = 0; i < 14; i++) { const x = rng.int(14), y = rng.int(14); rect(ctx, x, y, 2, 2, 0xf9d68f); px(ctx, x, y, 0xfff3c8); } speckle(ctx, rng, 0xffeebb, 8); });
def('shroomlight', (ctx, rng) => { noise(ctx, rng, 0xf07b2e, 0.12); speckle(ctx, rng, 0xffd08a, 16, 2); speckle(ctx, rng, 0xa8420f, 10); });
def('end_stone', (ctx, rng) => { noise(ctx, rng, END_STONE, 0.08, { fine: 0.05 }); speckle(ctx, rng, 0xc0c184, 16); speckle(ctx, rng, 0xf2f3bb, 8); });
def('end_stone_bricks', brickTex(0xb7b884, 0xdbdc9f, 2, 8));
def('purpur_block', (ctx, rng) => { noise(ctx, rng, 0xaa7daa, 0.07, { fine: 0.05 }); speckle(ctx, rng, 0x8f668f, 14); speckle(ctx, rng, 0xc39ec3, 8); });
def('purpur_pillar', (ctx, rng) => { noise(ctx, rng, 0xaa7daa, 0.06); rect(ctx, 0, 0, TILE, 2, 0x8f668f); rect(ctx, 0, 14, TILE, 2, 0x8f668f); rect(ctx, 0, 2, TILE, 1, 0xc39ec3); });
def('purpur_pillar_top', (ctx, rng) => { noise(ctx, rng, 0xaa7daa, 0.06); border(ctx, 0x8f668f, 0); border(ctx, 0xc39ec3, 2); });
def('end_portal_frame_top', (ctx, rng) => { noise(ctx, rng, 0xd1d194, 0.06); border(ctx, 0x9fa06d, 0); rect(ctx, 4, 4, 8, 8, 0x2f5b4a); });
def('end_portal_frame_side', (ctx, rng) => { noise(ctx, rng, 0xc7c78c, 0.07); rect(ctx, 0, 0, TILE, 5, 0x37624f); rect(ctx, 0, 5, TILE, 1, 0x24402f); });
def('end_portal_frame_eye', (ctx, rng) => { clear(ctx); circle(ctx, 8, 8, 5.5, 0x1c9c6c); circle(ctx, 8, 8, 3.5, 0x2fd18d); speckle(ctx, rng, 0x9df7cf, 8); });
def('dragon_egg', (ctx, rng) => { noise(ctx, rng, 0x0d0b12, 0.25, { cell: 2 }); speckle(ctx, rng, 0x2a1a3a, 16, 2); speckle(ctx, rng, 0x6a3fa0, 6); });

// --- prismarine / quartz ---------------------------------------------------
def('prismarine_bricks', brickTex(0x4f8d7f, 0x63aa9a, 2, 8));
def('dark_prismarine', (ctx, rng) => { noise(ctx, rng, 0x33705a, 0.08); tileGrid(ctx, rng, 0x33705a, 0x27543f, 4); });
def('quartz_block_top', smoothTex(0xece5dd, 0.045));
def('quartz_block_bottom', smoothTex(0xe6dfd6, 0.045));
def('quartz_block_side', (ctx, rng) => { noise(ctx, rng, 0xece5dd, 0.05, { fine: 0.03 }); for (let i = 0; i < 6; i++) rect(ctx, 0, rng.int(TILE), TILE, 1, 0xd8d0c6, 0.5); });
def('chiseled_quartz_block', (ctx, rng) => chiseled(ctx, rng, 0xe8e1d8, 'cross'));
def('chiseled_quartz_block_top', smoothTex(0xe8e1d8, 0.04));
def('quartz_pillar', (ctx, rng) => { noise(ctx, rng, 0xece5dd, 0.04); rect(ctx, 0, 0, TILE, 2, 0xd5cdc2); rect(ctx, 0, 14, TILE, 2, 0xd5cdc2); });
def('quartz_pillar_top', (ctx, rng) => { noise(ctx, rng, 0xece5dd, 0.04); border(ctx, 0xd5cdc2, 0); ring(ctx, 8, 8, 4, 0xd5cdc2, 0.6); });
def('quartz_bricks', brickTex(0xd2cabe, 0xece5dd, 2, 8));
def('smooth_quartz', smoothTex(0xeee7e0, 0.03));

// --- amethyst / moss / mud -------------------------------------------------
def('amethyst_block', (ctx, rng) => { noise(ctx, rng, 0x8f66c4, 0.1); for (let i = 0; i < 8; i++) { const x = rng.int(12), y = rng.int(12); rect(ctx, x, y, 3, 3, jit(rng, 0xa07ad2, 0.14)); px(ctx, x, y, 0xd0b8f0); } });
def('budding_amethyst', (ctx, rng) => { drawInto(ctx, 'amethyst_block'); circle(ctx, 8, 8, 3.4, 0x6f47a6); circle(ctx, 8, 8, 2.0, 0xb492e8); });
for (const [n, r] of [['small_amethyst_bud', 2], ['medium_amethyst_bud', 3.2], ['large_amethyst_bud', 4.4], ['amethyst_cluster', 6]]) {
  def(n, (ctx, rng) => {
    clear(ctx);
    const spikes = n === 'amethyst_cluster' ? 5 : 3;
    for (let i = 0; i < spikes; i++) {
      const x = 3 + rng.int(10), h = (r + rng.int(3)) | 0;
      for (let k = 0; k < h; k++) {
        px(ctx, x, 15 - k, k > h - 2 ? 0xe0cbff : 0x9b6fd6);
        if (k < h - 2) px(ctx, x + 1, 15 - k, 0x7c52b5);
      }
    }
  });
}
def('moss_block', (ctx, rng) => { noise(ctx, rng, 0x59772f, 0.16, { fine: 0.1 }); speckle(ctx, rng, 0x435c22, 20); speckle(ctx, rng, 0x76984a, 14); });
def('mud', (ctx, rng) => { noise(ctx, rng, 0x3c3a3c, 0.13, { fine: 0.07 }); speckle(ctx, rng, 0x2b2a2c, 16); speckle(ctx, rng, 0x504c4d, 8); });
def('packed_mud', (ctx, rng) => { noise(ctx, rng, 0x8c6c4c, 0.11, { fine: 0.06 }); speckle(ctx, rng, 0x6c5238, 14); speckle(ctx, rng, 0xa2825f, 8); });
def('mud_bricks', brickTex(0x6b5137, 0x8a6a4b, 4, 8));
def('mangrove_roots_top', (ctx, rng) => { noise(ctx, rng, 0x5c4028, 0.12); veins(ctx, rng, 0x3d2a19, 6, 12); });
def('mangrove_roots_side', (ctx, rng) => { clear(ctx); for (let i = 0; i < 8; i++) { let x = rng.int(TILE); for (let y = 0; y < TILE; y++) { px(ctx, x, y, jit(rng, 0x5c4028, 0.16)); if (rng.next() < 0.25) x += rng.bool() ? 1 : -1; } } });
def('muddy_mangrove_roots_top', (ctx, rng) => { drawInto(ctx, 'mangrove_roots_top'); dither(ctx, rng, 0x3c3a3c, 0.45); });
def('muddy_mangrove_roots_side', (ctx, rng) => { drawInto(ctx, 'mud'); veins(ctx, rng, 0x5c4028, 5, 14); });

// --- dirt / ground ---------------------------------------------------------
def('dirt', (ctx, rng) => { noise(ctx, rng, DIRT, 0.13, { fine: 0.07 }); speckle(ctx, rng, 0x6b4c34, 18); speckle(ctx, rng, 0x9c7350, 10); });
def('coarse_dirt', (ctx, rng) => { drawInto(ctx, 'dirt'); speckle(ctx, rng, 0x584029, 26); speckle(ctx, rng, 0xa8845c, 10); });
def('rooted_dirt', (ctx, rng) => { drawInto(ctx, 'dirt'); veins(ctx, rng, 0xb99b6a, 5, 12, 0.85); });
def('grass_block_top', (ctx, rng) => { tintNoise(ctx, rng, 176, 250, 0.05); speckle(ctx, rng, grey(150), 14); speckle(ctx, rng, grey(255), 8); });
def('grass_block_side_overlay', (ctx, rng) => {
  clear(ctx);
  for (let x = 0; x < TILE; x++) {
    const h = 3 + rng.int(3);
    for (let y = 0; y < h; y++) px(ctx, x, y, grey(180 + rng.int(70)));
  }
});
def('grass_block_side', (ctx, rng) => {
  drawInto(ctx, 'dirt');
  const g = 0x76b24a;
  for (let x = 0; x < TILE; x++) {
    const h = 3 + rng.int(3);
    for (let y = 0; y < h; y++) px(ctx, x, y, jit(rng, y === h - 1 ? shade(g, 0.8) : g, 0.12));
  }
});
def('grass_block_snow', (ctx, rng) => { drawInto(ctx, 'dirt'); for (let x = 0; x < TILE; x++) { const h = 4 + rng.int(3); for (let y = 0; y < h; y++) px(ctx, x, y, jit(rng, 0xf0fafa, 0.05)); } });
def('podzol_top', (ctx, rng) => { noise(ctx, rng, 0x6a4d2b, 0.14, { fine: 0.08 }); speckle(ctx, rng, 0x8f6a34, 16); speckle(ctx, rng, 0x4a3519, 12); });
def('podzol_side', (ctx, rng) => { drawInto(ctx, 'dirt'); for (let x = 0; x < TILE; x++) { const h = 3 + rng.int(3); for (let y = 0; y < h; y++) px(ctx, x, y, jit(rng, 0x6a4d2b, 0.15)); } });
def('mycelium_top', (ctx, rng) => { noise(ctx, rng, 0x6f6265, 0.12, { fine: 0.07 }); speckle(ctx, rng, 0x8c6b7d, 18); speckle(ctx, rng, 0x51454a, 12); });
def('mycelium_side', (ctx, rng) => { drawInto(ctx, 'dirt'); for (let x = 0; x < TILE; x++) { const h = 3 + rng.int(3); for (let y = 0; y < h; y++) px(ctx, x, y, jit(rng, 0x6f6265, 0.14)); } });
def('farmland', (ctx, rng) => { noise(ctx, rng, 0x6f4d2b, 0.1); for (let y = 1; y < TILE; y += 4) rect(ctx, 0, y, TILE, 2, 0x53381c, 0.55); speckle(ctx, rng, 0x86603a, 12); });
def('farmland_moist', (ctx, rng) => { noise(ctx, rng, 0x4a3117, 0.1); for (let y = 1; y < TILE; y += 4) rect(ctx, 0, y, TILE, 2, 0x33200e, 0.6); speckle(ctx, rng, 0x5c3f1e, 12); });
def('dirt_path_top', (ctx, rng) => { noise(ctx, rng, 0x977c48, 0.11, { fine: 0.06 }); border(ctx, 0x7d6538, 0, 0.6); speckle(ctx, rng, 0x86703f, 14); });
def('dirt_path_side', (ctx, rng) => { drawInto(ctx, 'dirt'); rect(ctx, 0, 0, TILE, 2, 0x977c48); rect(ctx, 0, 2, TILE, 1, 0x7d6538); });
def('sand', (ctx, rng) => { noise(ctx, rng, 0xdbd3a0, 0.07, { fine: 0.05 }); speckle(ctx, rng, 0xc4bb86, 16); speckle(ctx, rng, 0xf0e9bc, 10); });
def('red_sand', (ctx, rng) => { noise(ctx, rng, 0xbf6b31, 0.07, { fine: 0.05 }); speckle(ctx, rng, 0xa55925, 16); speckle(ctx, rng, 0xd88b4f, 10); });
def('gravel', (ctx, rng) => { noise(ctx, rng, 0x7f7c7a, 0.2, { cell: 2, fine: 0.09 }); speckle(ctx, rng, 0x5c5a58, 20, 2); speckle(ctx, rng, 0xa09d9a, 14, 2); });
def('clay', (ctx, rng) => { noise(ctx, rng, 0xa4a8b8, 0.07, { fine: 0.05 }); speckle(ctx, rng, 0x8f94a5, 14); });
def('sandstone_top', smoothTex(0xe0d8ac, 0.05));
def('sandstone_bottom', smoothTex(0xd6cca0, 0.05));
def('sandstone', (ctx, rng) => { noise(ctx, rng, 0xdcd0a0, 0.06, { fine: 0.04 }); rect(ctx, 0, 0, TILE, 4, shade(0xdcd0a0, 1.06)); rect(ctx, 0, 4, TILE, 1, shade(0xdcd0a0, 0.82)); for (let i = 0; i < 5; i++) rect(ctx, 0, 5 + rng.int(11), TILE, 1, shade(0xdcd0a0, 0.9), 0.5); });
def('chiseled_sandstone', (ctx, rng) => chiseled(ctx, rng, 0xdcd0a0, 'eye'));
def('cut_sandstone', (ctx, rng) => { noise(ctx, rng, 0xdcd0a0, 0.045); border(ctx, shade(0xdcd0a0, 0.8), 1); border(ctx, shade(0xdcd0a0, 1.08), 2); });
def('smooth_sandstone', smoothTex(0xe2daae, 0.035));
def('red_sandstone_top', smoothTex(0xbf6b31, 0.05));
def('red_sandstone_bottom', smoothTex(0xb0602b, 0.05));
def('red_sandstone', (ctx, rng) => { noise(ctx, rng, 0xb4682e, 0.06); rect(ctx, 0, 0, TILE, 4, shade(0xb4682e, 1.07)); rect(ctx, 0, 4, TILE, 1, shade(0xb4682e, 0.8)); for (let i = 0; i < 5; i++) rect(ctx, 0, 5 + rng.int(11), TILE, 1, shade(0xb4682e, 0.88), 0.5); });
def('chiseled_red_sandstone', (ctx, rng) => chiseled(ctx, rng, 0xb4682e, 'eye'));
def('cut_red_sandstone', (ctx, rng) => { noise(ctx, rng, 0xb4682e, 0.045); border(ctx, shade(0xb4682e, 0.8), 1); border(ctx, shade(0xb4682e, 1.08), 2); });
def('smooth_red_sandstone', smoothTex(0xbb6d31, 0.035));
def('snow', (ctx, rng) => { noise(ctx, rng, 0xf0fafa, 0.035, { fine: 0.03 }); speckle(ctx, rng, 0xffffff, 12); });
defineAlias('snow_block', 'snow');
def('powder_snow', (ctx, rng) => { noise(ctx, rng, 0xf7fdfd, 0.04); speckle(ctx, rng, 0xdfeef2, 14); });
def('ice', (ctx, rng) => { clear(ctx); rect(ctx, 0, 0, TILE, TILE, 0xa8c6ff, 0.82); for (let i = 0; i < 7; i++) { const x = rng.int(TILE), y = rng.int(TILE), l = 3 + rng.int(7); for (let k = 0; k < l; k++) px(ctx, (x + k) % TILE, (y + ((k / 2) | 0)) % TILE, 0xd6e6ff, 0.7); } });
def('packed_ice', (ctx, rng) => { noise(ctx, rng, 0x9dbcf0, 0.07); for (let i = 0; i < 6; i++) rect(ctx, rng.int(TILE), 0, 1, TILE, 0xbcd5ff, 0.5); });
def('blue_ice', (ctx, rng) => { noise(ctx, rng, 0x74a8f7, 0.06); for (let i = 0; i < 6; i++) rect(ctx, 0, rng.int(TILE), TILE, 1, 0x9dc6ff, 0.5); });
for (let i = 0; i < 4; i++) def('frosted_ice_' + i, (ctx, rng) => { clear(ctx); rect(ctx, 0, 0, TILE, TILE, 0xa8c6ff, 0.8); crackOverlay(ctx, rng, 0x6f95d6, 2 + i * 2); });

// --- wood families ---------------------------------------------------------
const WOODS = [
  { name: 'oak', bark: 0x6a532f, barkDark: 0x4b3a20, inner: 0xb0885a, planks: 0xb8945f, planksDark: 0x96754a },
  { name: 'spruce', bark: 0x4a3319, barkDark: 0x33230f, inner: 0x9a7440, planks: 0x785431, planksDark: 0x5c3f24 },
  { name: 'birch', bark: 0xd7cdc0, barkDark: 0x5a5a52, inner: 0xd2c496, planks: 0xc8b184, planksDark: 0xa89264, streak: true },
  { name: 'jungle', bark: 0x554419, barkDark: 0x3b2f11, inner: 0xa6825a, planks: 0xa0714a, planksDark: 0x7d5638 },
  { name: 'acacia', bark: 0x696259, barkDark: 0x46403a, inner: 0xad5d32, planks: 0xba6337, planksDark: 0x94472a },
  { name: 'dark_oak', bark: 0x3b2c18, barkDark: 0x241a0d, inner: 0x4d3924, planks: 0x40301d, planksDark: 0x2d2113 },
  { name: 'mangrove', bark: 0x5c2f28, barkDark: 0x3d1f1a, inner: 0x773934, planks: 0x763228, planksDark: 0x5a251d },
  { name: 'cherry', bark: 0x35242a, barkDark: 0x241819, inner: 0xd9a3a0, planks: 0xe3b3ab, planksDark: 0xc08d85 },
  { name: 'bamboo', bark: 0x8f9d2e, barkDark: 0x5f6b1c, inner: 0xc2ce5d, planks: 0xc0ab54, planksDark: 0x9c8940 },
  { name: 'crimson', bark: 0x6a344b, barkDark: 0x4b2337, inner: 0x86586f, planks: 0x6a344b, planksDark: 0x4e2839, stem: true },
  { name: 'warped', bark: 0x3a8e8c, barkDark: 0x235453, inner: 0x3a8e8c, planks: 0x2b6963, planksDark: 0x1e4c48, stem: true },
];

const SAPLING_LEAF = {
  oak: 0x4f7b31, spruce: 0x3f5e37, birch: 0x7fa85c, jungle: 0x2f7318, acacia: 0x7a9642,
  dark_oak: 0x365c1f, mangrove: 0x4c7f3e, cherry: 0xe5a3c8, bamboo: 0x83a832,
  crimson: 0x8b3a4e, warped: 0x1f9c95,
};

/** Registers the ~13 textures every wood type needs. */
function defineWoodSet(w) {
  const n = w.name;
  const logN = w.stem ? n + '_stem' : n + '_log';
  const woodN = w.stem ? n + '_hyphae' : n + '_wood';
  def(logN, (ctx, rng) => {
    logSide(ctx, rng, w.bark, w.barkDark);
    if (w.streak) for (let i = 0; i < 4; i++) { const y = rng.int(13); rect(ctx, rng.int(12), y, 2 + rng.int(3), 1 + rng.int(2), w.barkDark); }
  });
  def(logN + '_top', (ctx, rng) => logTop(ctx, rng, w.inner, w.bark));
  def('stripped_' + logN, (ctx, rng) => { logSide(ctx, rng, w.inner, shade(w.inner, 0.72)); grain(ctx, rng, w.inner, true, 12, 9); });
  def('stripped_' + logN + '_top', (ctx, rng) => logTop(ctx, rng, w.inner, shade(w.inner, 0.78)));
  defineAlias(woodN, logN);
  defineAlias('stripped_' + woodN, 'stripped_' + logN);
  def(n + '_planks', (ctx, rng) => plank(ctx, rng, w.planks, w.planksDark, 4));
  def(n + '_door_top', (ctx, rng) => {
    plank(ctx, rng, w.planks, w.planksDark, 3, true);
    rect(ctx, 3, 2, 10, 6, shade(w.planksDark, 0.8));
    rect(ctx, 4, 3, 8, 4, 0xc8e0ea, 0.55);
    border(ctx, shade(w.planksDark, 0.7), 0);
    px(ctx, 12, 12, 0x5a5a5a); px(ctx, 12, 13, 0x3a3a3a);
  });
  def(n + '_door_bottom', (ctx, rng) => {
    plank(ctx, rng, w.planks, w.planksDark, 3, true);
    border(ctx, shade(w.planksDark, 0.7), 0);
    rect(ctx, 3, 3, 10, 10, shade(w.planks, 0.92));
    border(ctx, shade(w.planksDark, 0.75), 3);
    px(ctx, 12, 2, 0x5a5a5a); px(ctx, 12, 3, 0x3a3a3a);
  });
  def(n + '_trapdoor', (ctx, rng) => {
    clear(ctx);
    rect(ctx, 0, 0, TILE, 3, w.planks); rect(ctx, 0, 13, TILE, 3, w.planks);
    rect(ctx, 0, 3, 3, 10, w.planks); rect(ctx, 13, 3, 3, 10, w.planks);
    rect(ctx, 3, 6, 10, 2, w.planksDark); rect(ctx, 3, 9, 10, 2, w.planksDark);
    grain(ctx, rng, w.planks, false, 8, 5);
    border(ctx, shade(w.planksDark, 0.7), 0);
    px(ctx, 2, 7, 0x4a4a4a); px(ctx, 13, 7, 0x4a4a4a);
  });
  def(n + '_leaves', (ctx, rng) => leafMask(ctx, rng, n === 'spruce' || n === 'dark_oak' ? 0.1 : 0.15));
  def(n + '_sign', (ctx, rng) => { plank(ctx, rng, w.planks, w.planksDark, 4); border(ctx, shade(w.planksDark, 0.7), 0); });
  defineAlias(n + '_hanging_sign', n + '_sign');
  const leaf = SAPLING_LEAF[n] || 0x4f7b31;
  const saplingName = w.stem ? n + '_fungus' : n + '_sapling';
  def(saplingName, (ctx, rng) => {
    clear(ctx);
    rect(ctx, 7, 9, 2, 6, 0x6b5030);
    if (w.stem) {
      circle(ctx, 8, 6, 4, leaf);
      circle(ctx, 8, 7, 3.2, shade(leaf, 1.15));
      speckle(ctx, rng, shade(leaf, 0.7), 6);
    } else {
      for (let i = 0; i < 26; i++) {
        const x = 3 + rng.int(10), y = 2 + rng.int(8);
        px(ctx, x, y, jit(rng, leaf, 0.18));
      }
      rect(ctx, 6, 4, 4, 4, leaf);
      rect(ctx, 7, 2, 2, 2, shade(leaf, 1.15));
    }
  });
}
for (const w of WOODS) defineWoodSet(w);

def('azalea_leaves', (ctx, rng) => leafMask(ctx, rng, 0.13));
def('flowering_azalea_leaves', (ctx, rng) => { leafMask(ctx, rng, 0.13); for (let i = 0; i < 6; i++) { const x = rng.int(14), y = rng.int(14); rect(ctx, x, y, 2, 2, 0xd77bd4); px(ctx, x, y, 0xffd7f4); } });
def('azalea_top', (ctx, rng) => { noise(ctx, rng, 0x5b8a3d, 0.14); speckle(ctx, rng, 0x3f6b28, 16); });
def('azalea_side', (ctx, rng) => { noise(ctx, rng, 0x4d6f30, 0.14); rect(ctx, 0, 10, TILE, 6, 0x6a5230); });
def('flowering_azalea_top', (ctx, rng) => { drawInto(ctx, 'azalea_top'); for (let i = 0; i < 8; i++) { const x = rng.int(14), y = rng.int(14); rect(ctx, x, y, 2, 2, 0xd77bd4); } });
def('flowering_azalea_side', (ctx, rng) => { drawInto(ctx, 'azalea_side'); for (let i = 0; i < 6; i++) { const x = rng.int(14), y = rng.int(10); rect(ctx, x, y, 2, 2, 0xd77bd4); } });
def('crimson_nylium', (ctx, rng) => { noise(ctx, rng, 0x854242, 0.15, { fine: 0.08 }); speckle(ctx, rng, 0xbd3030, 16); speckle(ctx, rng, 0x5f2a2a, 12); });
def('crimson_nylium_side', (ctx, rng) => { drawInto(ctx, 'netherrack'); for (let x = 0; x < TILE; x++) { const h = 2 + rng.int(4); for (let y = 0; y < h; y++) px(ctx, x, y, jit(rng, 0x9d3f3f, 0.16)); } });
def('warped_nylium', (ctx, rng) => { noise(ctx, rng, 0x2c6a5f, 0.15, { fine: 0.08 }); speckle(ctx, rng, 0x1c8b7a, 16); speckle(ctx, rng, 0x164b43, 12); });
def('warped_nylium_side', (ctx, rng) => { drawInto(ctx, 'netherrack'); for (let x = 0; x < TILE; x++) { const h = 2 + rng.int(4); for (let y = 0; y < h; y++) px(ctx, x, y, jit(rng, 0x2c6a5f, 0.16)); } });

// --- ores ------------------------------------------------------------------
const ORE_GEMS = {
  coal: 0x1b1b1b, iron: 0xd6a17a, copper: 0xc16f4e, gold: 0xfcee4b,
  redstone: 0xd42121, lapis: 0x2b53a8, diamond: 0x4aedd9, emerald: 0x17dd62,
};
for (const k of Object.keys(ORE_GEMS)) {
  def(k + '_ore', oreTex('stone', ORE_GEMS[k], k === 'diamond' || k === 'emerald' ? 4 : 5));
  def('deepslate_' + k + '_ore', oreTex('deepslate', ORE_GEMS[k], k === 'diamond' || k === 'emerald' ? 4 : 5));
}
def('nether_quartz_ore', oreTex('netherrack', 0xe8e0d8, 5));
def('nether_gold_ore', oreTex('netherrack', 0xfcee4b, 6));
def('ancient_debris_top', (ctx, rng) => { noise(ctx, rng, 0x5e4038, 0.13); for (let i = 0; i < 4; i++) { const x = rng.int(11), y = rng.int(11); rect(ctx, x, y, 4, 4, 0x3f3436); rect(ctx, x + 1, y + 1, 2, 2, 0x6a5c58); } });
def('ancient_debris_side', (ctx, rng) => { noise(ctx, rng, 0x5e4038, 0.13); for (let i = 0; i < 3; i++) { const x = rng.int(11), y = rng.int(11); rect(ctx, x, y, 5, 4, 0x3f3436); rect(ctx, x + 1, y + 1, 3, 2, 0x6a5c58); } });

// --- mineral blocks --------------------------------------------------------
const metalBlock = (base, style) => (ctx, rng) => {
  noise(ctx, rng, base, 0.05, { fine: 0.03 });
  if (style === 'gem') {
    for (let ty = 0; ty < 2; ty++) for (let tx = 0; tx < 2; tx++) {
      const cx = tx * 8 + 4, cy = ty * 8 + 4;
      circle(ctx, cx, cy, 2.6, shade(base, 1.2));
      circle(ctx, cx, cy, 1.4, shade(base, 0.8));
    }
    border(ctx, shade(base, 0.75), 0);
  } else if (style === 'dust') {
    speckle(ctx, rng, shade(base, 0.72), 18);
    speckle(ctx, rng, shade(base, 1.25), 12);
  } else {
    border(ctx, shade(base, 1.18), 1, 0.7);
    border(ctx, shade(base, 0.72), 0, 0.7);
    for (let i = 0; i < 5; i++) px(ctx, 2 + rng.int(12), 2 + rng.int(12), shade(base, 1.2));
  }
};
def('coal_block', (ctx, rng) => { noise(ctx, rng, 0x121212, 0.3, { cell: 2 }); speckle(ctx, rng, 0x2c2c2c, 16, 2); speckle(ctx, rng, 0x000000, 10, 2); });
def('iron_block', metalBlock(0xd8d8d8, 'metal'));
def('gold_block', metalBlock(0xfcee4b, 'metal'));
def('diamond_block', metalBlock(0x4aedd9, 'gem'));
def('emerald_block', metalBlock(0x17dd62, 'gem'));
def('lapis_block', (ctx, rng) => { noise(ctx, rng, 0x2b53a8, 0.14); speckle(ctx, rng, 0x1a3a80, 16); speckle(ctx, rng, 0x4d7fd6, 12); });
def('redstone_block', (ctx, rng) => { noise(ctx, rng, 0xa71414, 0.16); speckle(ctx, rng, 0xd42121, 20); speckle(ctx, rng, 0x6d0a0a, 12); });
def('netherite_block', (ctx, rng) => { noise(ctx, rng, 0x443f43, 0.1); speckle(ctx, rng, 0x2e2a2e, 16, 2); speckle(ctx, rng, 0x6b5f64, 10, 2); border(ctx, 0x2e2a2e, 0, 0.6); });
def('copper_block', metalBlock(0xc16f4e, 'metal'));
def('exposed_copper', metalBlock(0xa87b64, 'metal'));
def('weathered_copper', metalBlock(0x6f9a76, 'metal'));
def('oxidized_copper', metalBlock(0x4fab90, 'metal'));
for (const [n, c] of [['copper', 0xc16f4e], ['exposed_copper', 0xa87b64], ['weathered_copper', 0x6f9a76], ['oxidized_copper', 0x4fab90]]) {
  const cut = n === 'copper' ? 'cut_copper' : 'cut_' + n;
  def(cut, (ctx, rng) => { noise(ctx, rng, c, 0.05); tileGrid(ctx, rng, c, shade(c, 0.72), 2); });
  def(n === 'copper' ? 'copper_grate' : n.replace('_copper', '') + '_copper_grate', (ctx, rng) => { clear(ctx); rect(ctx, 0, 0, TILE, TILE, c, 1); for (let y = 2; y < TILE; y += 4) for (let x = 2; x < TILE; x += 4) ctx.clearRect(x, y, 2, 2); });
  def(n === 'copper' ? 'chiseled_copper' : 'chiseled_' + n, (ctx, rng) => chiseled(ctx, rng, c, 'diamond'));
}
def('raw_iron_block', (ctx, rng) => { noise(ctx, rng, 0xa9714b, 0.13); speckle(ctx, rng, 0x8a5636, 16, 2); speckle(ctx, rng, 0xd6a17a, 10, 2); });
def('raw_copper_block', (ctx, rng) => { noise(ctx, rng, 0x9a5b3d, 0.13); speckle(ctx, rng, 0x7c452b, 16, 2); speckle(ctx, rng, 0xc98a63, 10, 2); });
def('raw_gold_block', (ctx, rng) => { noise(ctx, rng, 0xdda92b, 0.13); speckle(ctx, rng, 0xb08417, 16, 2); speckle(ctx, rng, 0xfce27a, 10, 2); });
def('bone_block_top', (ctx, rng) => { noise(ctx, rng, 0xe3e0d2, 0.06); ring(ctx, 8, 8, 5, 0xc6c2b0, 0.7); circle(ctx, 8, 8, 2, 0xa9a593); });
def('bone_block_side', (ctx, rng) => { noise(ctx, rng, 0xe3e0d2, 0.06); rect(ctx, 0, 0, TILE, 3, 0xd2cfc0); rect(ctx, 0, 13, TILE, 3, 0xd2cfc0); for (let x = 2; x < TILE; x += 4) rect(ctx, x, 3, 1, 10, 0xc6c2b0); });

// --- the sixteen-colour families -------------------------------------------
def('terracotta', (ctx, rng) => { noise(ctx, rng, 0x945b43, 0.07, { fine: 0.04 }); speckle(ctx, rng, 0x7d4a35, 12); speckle(ctx, rng, 0xa87058, 8); });

for (const c of COLORS) {
  const wool = WOOL_COLOR[c];
  const conc = CONCRETE_COLOR[c];
  const terra = TERRACOTTA_COLOR[c];
  const dye = DYE[c];

  def(c + '_wool', (ctx, rng) => woolTex(ctx, rng, wool));
  defineAlias(c + '_carpet', c + '_wool');
  def(c + '_concrete', (ctx, rng) => noise(ctx, rng, conc, 0.03, { fine: 0.02 }));
  def(c + '_concrete_powder', (ctx, rng) => { noise(ctx, rng, shade(conc, 1.12), 0.09, { fine: 0.06 }); speckle(ctx, rng, shade(conc, 0.85), 14); });
  def(c + '_terracotta', (ctx, rng) => { noise(ctx, rng, terra, 0.07, { fine: 0.04 }); speckle(ctx, rng, shade(terra, 0.85), 12); speckle(ctx, rng, shade(terra, 1.15), 8); });
  def(c + '_glazed_terracotta', (ctx, rng) => {
    const a = shade(dye, 1.05), b = mix(dye, 0xffffff, 0.62), d = shade(dye, 0.6);
    fill(ctx, b);
    rect(ctx, 0, 0, 8, 8, a); rect(ctx, 8, 8, 8, 8, a);
    for (let i = 0; i < 8; i++) { px(ctx, i, 7 - i, d); px(ctx, 15 - i, 8 + i, d); }
    rect(ctx, 2, 2, 4, 4, b); rect(ctx, 10, 10, 4, 4, b);
    rect(ctx, 3, 3, 2, 2, d); rect(ctx, 11, 11, 2, 2, d);
    border(ctx, d, 0, 0.7);
  });
  def(c + '_stained_glass', (ctx, rng) => glassTex(ctx, rng, dye, 0.42));
  def(c + '_stained_glass_pane_top', (ctx, rng) => { clear(ctx); rect(ctx, 0, 0, TILE, 2, shade(dye, 1.15), 0.85); });
  def(c + '_shulker_box', (ctx, rng) => {
    noise(ctx, rng, shade(wool, 0.9), 0.06);
    rect(ctx, 0, 0, TILE, 5, shade(wool, 1.12));
    rect(ctx, 0, 5, TILE, 1, shade(wool, 0.65));
    rect(ctx, 5, 6, 6, 3, shade(wool, 0.75));
    border(ctx, shade(wool, 0.6), 0, 0.7);
    speckle(ctx, rng, shade(wool, 1.2), 6);
  });
  def(c + '_candle', (ctx, rng) => { clear(ctx); rect(ctx, 6, 6, 4, 9, wool); rect(ctx, 6, 6, 1, 9, shade(wool, 1.2)); rect(ctx, 9, 6, 1, 9, shade(wool, 0.8)); rect(ctx, 7, 4, 1, 2, 0x6b6b6b); });
  def(c + '_candle_lit', (ctx, rng) => { drawInto(ctx, c + '_candle'); rect(ctx, 7, 1, 1, 3, 0xffe08a); px(ctx, 7, 0, 0xfff6cf); px(ctx, 8, 2, 0xffa53c); });
  def(c + '_bed_head_top', (ctx, rng) => { noise(ctx, rng, wool, 0.05); rect(ctx, 2, 2, 12, 6, 0xe9ecec); border(ctx, shade(wool, 0.7), 0, 0.6); });
  def(c + '_bed_head_side', (ctx, rng) => { noise(ctx, rng, wool, 0.05); rect(ctx, 0, 9, TILE, 7, 0xdcdcdc); rect(ctx, 0, 14, TILE, 2, 0x6b4f2e); });
  def(c + '_bed_head_end', (ctx, rng) => { noise(ctx, rng, wool, 0.05); rect(ctx, 0, 3, TILE, 9, 0xe9ecec); rect(ctx, 0, 14, TILE, 2, 0x6b4f2e); });
  def(c + '_bed_foot_top', (ctx, rng) => { noise(ctx, rng, wool, 0.05); border(ctx, shade(wool, 0.7), 0, 0.6); rect(ctx, 3, 3, 10, 10, shade(wool, 1.08)); });
  def(c + '_bed_foot_side', (ctx, rng) => { noise(ctx, rng, wool, 0.05); rect(ctx, 0, 14, TILE, 2, 0x6b4f2e); });
  def(c + '_bed_foot_end', (ctx, rng) => { noise(ctx, rng, wool, 0.05); rect(ctx, 0, 14, TILE, 2, 0x6b4f2e); rect(ctx, 0, 0, TILE, 1, shade(wool, 0.7)); });
}
def('shulker_box', (ctx, rng) => { noise(ctx, rng, 0x8c6d8c, 0.06); rect(ctx, 0, 0, TILE, 5, 0xa585a5); rect(ctx, 0, 5, TILE, 1, 0x5e4a5e); rect(ctx, 5, 6, 6, 3, 0x6f586f); border(ctx, 0x5e4a5e, 0, 0.7); });

// --- glass, ice, misc transparent -----------------------------------------
def('glass', (ctx, rng) => glassTex(ctx, rng, 0xd6f0f0, 0.14));
def('glass_pane_top', (ctx) => { clear(ctx); rect(ctx, 0, 0, TILE, 2, 0xe4f4f4, 0.8); });
def('tinted_glass', (ctx, rng) => glassTex(ctx, rng, 0x2b2430, 0.62));
def('iron_bars', (ctx) => { clear(ctx); rect(ctx, 6, 0, 4, TILE, 0xa8a8a8); rect(ctx, 6, 0, 1, TILE, 0xd0d0d0); rect(ctx, 9, 0, 1, TILE, 0x707070); });
def('honey_block_top', (ctx, rng) => { clear(ctx); rect(ctx, 0, 0, TILE, TILE, 0xe09a2c, 0.85); speckle(ctx, rng, 0xffc65e, 10); });
def('honey_block_side', (ctx, rng) => { clear(ctx); rect(ctx, 0, 0, TILE, TILE, 0xd4881f, 0.85); rect(ctx, 0, 0, TILE, 2, 0xf3b957, 0.9); speckle(ctx, rng, 0xffc65e, 8); });
def('honey_block_bottom', (ctx, rng) => { clear(ctx); rect(ctx, 0, 0, TILE, TILE, 0xc47c1a, 0.85); });
def('slime_block', (ctx, rng) => { clear(ctx); rect(ctx, 0, 0, TILE, TILE, 0x77c265, 0.72); border(ctx, 0x59a349, 0, 0.85); border(ctx, 0x9ee08c, 2, 0.5); speckle(ctx, rng, 0x4b8c3d, 8, 1, 0.6); });
def('cobweb', (ctx, rng) => {
  clear(ctx);
  const c = 0xf0f0f0;
  for (let i = 0; i < 8; i++) { const a = (i / 8) * Math.PI * 2; for (let r = 0; r < 8; r++) px(ctx, 8 + Math.cos(a) * r, 8 + Math.sin(a) * r, c, 0.9); }
  for (const r of [3, 5, 7]) ring(ctx, 8, 8, r, c, 0.5, 0.8);
});
def('chain', (ctx) => { clear(ctx); for (let y = 0; y < TILE; y += 4) { rect(ctx, 7, y, 2, 3, 0x4c4c56); px(ctx, 6, y + 1, 0x6a6a78); px(ctx, 9, y + 1, 0x33333a); } });
def('sponge', (ctx, rng) => { noise(ctx, rng, 0xc7c34f, 0.12); for (let i = 0; i < 16; i++) px(ctx, rng.int(TILE), rng.int(TILE), 0x8f8b2e); });
def('wet_sponge', (ctx, rng) => { noise(ctx, rng, 0x9aa03c, 0.12); for (let i = 0; i < 16; i++) px(ctx, rng.int(TILE), rng.int(TILE), 0x63682a); speckle(ctx, rng, 0x4a7a8a, 6); });
def('barrier', (ctx) => { clear(ctx); rect(ctx, 2, 2, 12, 2, 0xd02020); rect(ctx, 2, 2, 2, 12, 0xd02020); rect(ctx, 12, 2, 2, 12, 0xd02020); rect(ctx, 2, 12, 12, 2, 0xd02020); for (let i = 0; i < 12; i++) px(ctx, 2 + i, 2 + i, 0xd02020); });
def('structure_void', (ctx) => { clear(ctx); rect(ctx, 4, 4, 8, 8, 0xd02090, 0.4); });
def('light_block', (ctx) => { clear(ctx); circle(ctx, 8, 8, 5, 0xffe97a, 0.35); ring(ctx, 8, 8, 5.5, 0xfff3c0, 0.6, 0.6); });

// --- plants ----------------------------------------------------------------
// Grass, ferns and vines are drawn GREYSCALE: the mesher multiplies them by
// the biome foliage tint.
const GA = grey(190), GB = grey(238), GC = grey(150);

def('short_grass', (ctx, rng) => { clear(ctx); drawTuft(ctx, rng, GA, GB, 9, 15, 10); });
defineAlias('grass', 'short_grass');
def('tall_grass_bottom', (ctx, rng) => { clear(ctx); drawTuft(ctx, rng, GA, GC, 8, 15, 12); });
def('tall_grass_top', (ctx, rng) => { clear(ctx); drawTuft(ctx, rng, GB, GA, 7, 15, 9); for (let x = 4; x < 12; x++) px(ctx, x, 15, GA); });
def('fern', (ctx, rng) => {
  clear(ctx);
  rect(ctx, 7, 6, 1, 10, GC);
  for (let y = 6; y < 15; y += 2) { const w = 1 + ((15 - y) / 2) | 0; for (let i = 1; i <= w; i++) { px(ctx, 7 - i, y, GA); px(ctx, 8 + i - 1, y + 1, GB); } }
});
def('large_fern_bottom', (ctx, rng) => { drawInto(ctx, 'fern'); drawTuft(ctx, rng, GA, GC, 4, 15, 8); });
def('large_fern_top', (ctx, rng) => { clear(ctx); rect(ctx, 7, 2, 1, 14, GC); for (let y = 3; y < 15; y += 2) { const w = 1 + ((15 - y) / 3) | 0; for (let i = 1; i <= w; i++) { px(ctx, 7 - i, y, GB); px(ctx, 8 + i - 1, y + 1, GA); } } });
def('dead_bush', (ctx, rng) => { clear(ctx); drawTuft(ctx, rng, 0x6a4b2a, 0x8a6636, 9, 15, 11); });
def('seagrass', (ctx, rng) => { clear(ctx); drawTuft(ctx, rng, GA, GB, 6, 15, 12); });
def('tall_seagrass_bottom', (ctx, rng) => { clear(ctx); drawTuft(ctx, rng, GA, GC, 5, 15, 14); });
def('tall_seagrass_top', (ctx, rng) => { clear(ctx); drawTuft(ctx, rng, GB, GA, 5, 15, 14); });
def('kelp', (ctx, rng) => { clear(ctx); rect(ctx, 7, 0, 2, TILE, 0x4a7c2a); for (let y = 1; y < TILE; y += 3) { px(ctx, 5 + rng.int(2), y, 0x63a03a); px(ctx, 9 + rng.int(2), y + 1, 0x3c6a20); } });
def('kelp_plant', (ctx, rng) => { clear(ctx); rect(ctx, 7, 0, 2, TILE, 0x40701f); for (let y = 0; y < TILE; y += 4) { px(ctx, 6, y, 0x58913a); px(ctx, 9, y + 2, 0x2f5a17); } });
def('vine', (ctx, rng) => {
  clear(ctx);
  for (let x = 0; x < TILE; x += 3) {
    const h = 6 + rng.int(10);
    for (let y = 0; y < h; y++) px(ctx, x + (rng.next() < 0.2 ? 1 : 0), y, y % 3 === 0 ? GB : GA);
  }
  for (let i = 0; i < 10; i++) px(ctx, rng.int(TILE), rng.int(TILE), GC);
});
def('glow_lichen', (ctx, rng) => { clear(ctx); for (let i = 0; i < 40; i++) { const x = rng.int(TILE), y = rng.int(TILE); px(ctx, x, y, 0x7fa695); if (rng.next() < 0.3) px(ctx, x + 1, y, 0xa8d4bf); } });
def('lily_pad', (ctx, rng) => { clear(ctx); circle(ctx, 8, 8, 7, GA); circle(ctx, 8, 8, 6, GB); for (let i = 0; i < 7; i++) px(ctx, 8 + rng.int(5) - 2, 8 + rng.int(5) - 2, GC); ctx.clearRect(8, 9, 1, 7); });
def('moss_carpet', (ctx, rng) => { drawInto(ctx, 'moss_block'); });
def('pink_petals', (ctx, rng) => { clear(ctx); for (let i = 0; i < 9; i++) { const x = rng.int(14), y = rng.int(14); rect(ctx, x, y, 2, 2, 0xf0a8cf); px(ctx, x, y, 0xffd0e8); } });
def('hanging_roots', (ctx, rng) => { clear(ctx); for (let x = 1; x < TILE; x += 2) { const h = 4 + rng.int(9); for (let y = 0; y < h; y++) px(ctx, x, y, jit(rng, 0xc7a97a, 0.12)); } });
def('spore_blossom', (ctx, rng) => { clear(ctx); circle(ctx, 8, 8, 6, 0xd4629d); circle(ctx, 8, 8, 4, 0xe98cba); circle(ctx, 8, 8, 1.6, 0xf5c0da); speckle(ctx, rng, 0xb84a80, 8); });
def('spore_blossom_base', (ctx, rng) => { clear(ctx); circle(ctx, 8, 8, 4, 0x4f7a37); speckle(ctx, rng, 0x3a5c26, 6); });
def('big_dripleaf_top', (ctx, rng) => { noise(ctx, rng, 0x5c8a3c, 0.12); border(ctx, 0x42682a, 0, 0.7); veins(ctx, rng, 0x74a34c, 4, 10); });
def('big_dripleaf_side', (ctx, rng) => { clear(ctx); rect(ctx, 0, 6, TILE, 4, 0x5c8a3c); rect(ctx, 6, 9, 3, 7, 0x74a34c); });
def('big_dripleaf_stem', (ctx, rng) => { clear(ctx); rect(ctx, 7, 0, 2, TILE, 0x6a9143); px(ctx, 6, 5, 0x4c6f2e); px(ctx, 9, 10, 0x4c6f2e); });
def('small_dripleaf_top', (ctx, rng) => { clear(ctx); circle(ctx, 8, 7, 5, 0x63944a); circle(ctx, 8, 7, 3, 0x7cb060); rect(ctx, 7, 10, 2, 6, 0x4c6f2e); });
def('small_dripleaf_side', (ctx, rng) => { clear(ctx); rect(ctx, 2, 4, 12, 4, 0x63944a); rect(ctx, 7, 8, 2, 8, 0x4c6f2e); });
def('small_dripleaf_stem_top', (ctx) => { clear(ctx); rect(ctx, 7, 0, 2, TILE, 0x4c6f2e); });
def('small_dripleaf_stem_bottom', (ctx) => { clear(ctx); rect(ctx, 7, 0, 2, TILE, 0x3f5c26); });
def('cave_vines', (ctx, rng) => { clear(ctx); rect(ctx, 7, 0, 2, TILE, 0x4c6f2e); for (let y = 2; y < TILE; y += 5) { px(ctx, 5, y, 0x63944a); px(ctx, 10, y + 2, 0x63944a); } });
defineAlias('cave_vines_plant', 'cave_vines');
def('cave_vines_lit', (ctx, rng) => { drawInto(ctx, 'cave_vines'); for (let i = 0; i < 4; i++) { const x = 4 + rng.int(8), y = 2 + rng.int(11); rect(ctx, x, y, 2, 2, 0xffa726); px(ctx, x, y, 0xffe08a); } });
defineAlias('cave_vines_plant_lit', 'cave_vines_lit');

const FLOWERS = {
  dandelion: [0xffec4f, 0xd4b800], poppy: [0xdb3b26, 0x2b1c10], blue_orchid: [0x2ebfe8, 0xf0f0a0],
  allium: [0xb571e8, 0xe0c2f5], azure_bluet: [0xf0f0f0, 0xf5d63c], red_tulip: [0xd32f2f, 0x2f6b1f],
  orange_tulip: [0xe8811d, 0x2f6b1f], white_tulip: [0xf2f2f2, 0x2f6b1f], pink_tulip: [0xefadd4, 0x2f6b1f],
  oxeye_daisy: [0xf5f5f5, 0xffd83c], cornflower: [0x4b6de8, 0x2b3b8a], lily_of_the_valley: [0xf7f7f7, 0xd8d8b0],
  wither_rose: [0x241a24, 0x0d0a0d], torchflower: [0xe86b2c, 0xffd050],
};
function drawFlower(ctx, rng, petal, center, tall) {
  clear(ctx);
  const stem = 0x4a7a2c;
  const cy = tall ? 4 : 6;
  rect(ctx, 7, cy + 2, 2, 14 - cy, stem);
  rect(ctx, 4, 10, 3, 1, shade(stem, 1.12));
  rect(ctx, 9, 12, 3, 1, shade(stem, 1.12));
  px(ctx, 4, 9, shade(stem, 0.85)); px(ctx, 11, 11, shade(stem, 0.85));
  rect(ctx, 6, cy - 2, 4, 4, petal);
  rect(ctx, 5, cy - 1, 6, 2, petal);
  rect(ctx, 6, cy - 3, 4, 1, petal);
  rect(ctx, 7, cy - 1, 2, 2, center);
  px(ctx, 5, cy - 2, shade(petal, 1.15));
  px(ctx, 10, cy + 1, shade(petal, 0.82));
}
for (const k of Object.keys(FLOWERS)) {
  const [p, c] = FLOWERS[k];
  def(k, (ctx, rng) => drawFlower(ctx, rng, p, c, false));
}
def('sunflower_bottom', (ctx, rng) => { clear(ctx); rect(ctx, 7, 0, 2, TILE, 0x4a7a2c); rect(ctx, 4, 6, 3, 1, 0x59923a); rect(ctx, 9, 10, 3, 1, 0x59923a); });
def('sunflower_top', (ctx, rng) => { clear(ctx); rect(ctx, 7, 8, 2, 8, 0x4a7a2c); rect(ctx, 3, 4, 3, 2, 0x59923a); });
def('sunflower_front', (ctx, rng) => { clear(ctx); circle(ctx, 8, 8, 7, 0xffd23c); circle(ctx, 8, 8, 4.5, 0xd8a01c); circle(ctx, 8, 8, 3, 0x6b4a1c); speckle(ctx, rng, 0x4a3212, 8); });
def('sunflower_back', (ctx, rng) => { clear(ctx); circle(ctx, 8, 8, 7, 0xe0b52c); circle(ctx, 8, 8, 4, 0x4a7a2c); });
for (const [n, top, bot] of [['lilac', 0xc79bd6, 0x9a6fb0], ['rose_bush', 0xd8464a, 0xa32c30], ['peony', 0xe8b7dd, 0xb27fa8]]) {
  def(n + '_top', (ctx, rng) => { clear(ctx); drawTuft(ctx, rng, 0x4a7a2c, 0x59923a, 6, 15, 9); for (let i = 0; i < 16; i++) { const x = 2 + rng.int(12), y = 1 + rng.int(8); px(ctx, x, y, rng.bool() ? top : bot); px(ctx, x + 1, y, top); } });
  def(n + '_bottom', (ctx, rng) => { clear(ctx); drawTuft(ctx, rng, 0x3f6a24, 0x4a7a2c, 8, 15, 12); for (let i = 0; i < 5; i++) px(ctx, 3 + rng.int(10), rng.int(5), bot); });
}
def('sugar_cane', (ctx, rng) => { clear(ctx); for (let x = 5; x < 11; x++) for (let y = 0; y < TILE; y++) px(ctx, x, y, jit(rng, y % 6 === 0 ? 0x7fa85c : 0x94c46a, 0.08)); rect(ctx, 5, 0, 1, TILE, 0x6b8f4a); });
def('bamboo_stalk', (ctx, rng) => { clear(ctx); rect(ctx, 6, 0, 4, TILE, 0x88a02c); rect(ctx, 6, 0, 1, TILE, 0xa8c246); rect(ctx, 9, 0, 1, TILE, 0x5f7318); for (let y = 3; y < TILE; y += 6) rect(ctx, 6, y, 4, 1, 0x4e5f14); });
def('bamboo_small_leaves', (ctx, rng) => { clear(ctx); drawTuft(ctx, rng, 0x5b8a2a, 0x76a83c, 5, 14, 8); });
def('bamboo_large_leaves', (ctx, rng) => { clear(ctx); drawTuft(ctx, rng, 0x4f7a24, 0x6b9c34, 8, 15, 12); });
def('bamboo_singleleaf', (ctx, rng) => { clear(ctx); drawTuft(ctx, rng, 0x5b8a2a, 0x76a83c, 3, 14, 10); });
def('bamboo_block', (ctx, rng) => { noise(ctx, rng, 0xa2b03c, 0.07); for (let x = 2; x < TILE; x += 4) rect(ctx, x, 0, 1, TILE, 0x7e8c26); rect(ctx, 0, 5, TILE, 1, 0x66701c); });
def('bamboo_block_top', (ctx, rng) => { noise(ctx, rng, 0xc2ce5d, 0.06); ring(ctx, 8, 8, 5, 0x8e9a30, 0.7); circle(ctx, 8, 8, 2.4, 0x6f7a22); });
def('stripped_bamboo_block', (ctx, rng) => { noise(ctx, rng, 0xc0ab54, 0.07); grain(ctx, rng, 0xc0ab54, true, 10, 8); });
def('stripped_bamboo_block_top', (ctx, rng) => logTop(ctx, rng, 0xc0ab54, 0x9c8940));
def('bamboo_mosaic', (ctx, rng) => { plank(ctx, rng, 0xc0ab54, 0x9c8940, 4); for (let i = 0; i < 4; i++) rect(ctx, i * 4, 0, 1, TILE, 0x8b7836, 0.6); });
def('cactus_top', (ctx, rng) => { noise(ctx, rng, 0x5b8f39, 0.07); border(ctx, 0x466f2a, 0); circle(ctx, 8, 8, 3, 0x6ea546); });
def('cactus_side', (ctx, rng) => { noise(ctx, rng, 0x4f7f31, 0.07); rect(ctx, 0, 0, 1, TILE, 0x3c6224); rect(ctx, 15, 0, 1, TILE, 0x3c6224); for (let y = 1; y < TILE; y += 4) { px(ctx, 4, y, 0xd8dfc0); px(ctx, 11, y + 2, 0xd8dfc0); } });
def('cactus_bottom', (ctx, rng) => { noise(ctx, rng, 0x8b6a3f, 0.08); border(ctx, 0x466f2a, 0); });
def('red_mushroom', (ctx, rng) => { clear(ctx); rect(ctx, 7, 9, 2, 6, 0xd8d0c0); circle(ctx, 8, 7, 5, 0xc73c31); px(ctx, 5, 5, 0xf0f0f0); px(ctx, 10, 6, 0xf0f0f0); px(ctx, 8, 4, 0xf0f0f0); });
def('brown_mushroom', (ctx, rng) => { clear(ctx); rect(ctx, 7, 9, 2, 6, 0xd8d0c0); circle(ctx, 8, 7, 5, 0x9a6a45); px(ctx, 6, 5, 0xb98a63); px(ctx, 10, 7, 0x7c5334); });
def('red_mushroom_block', (ctx, rng) => { noise(ctx, rng, 0xc73c31, 0.06); for (const [x, y] of [[1, 1], [9, 2], [4, 8], [11, 10]]) rect(ctx, x, y, 4, 4, 0xf0f0f0); });
def('brown_mushroom_block', (ctx, rng) => { noise(ctx, rng, 0x9a6a45, 0.08); speckle(ctx, rng, 0x7c5334, 14); });
def('mushroom_stem', (ctx, rng) => { noise(ctx, rng, 0xd0c7b0, 0.06); for (let x = 2; x < TILE; x += 5) rect(ctx, x, 0, 1, TILE, 0xb8ad96, 0.6); });
def('mushroom_block_inside', (ctx, rng) => { noise(ctx, rng, 0xc0a487, 0.08); speckle(ctx, rng, 0xa08a6c, 12); });
def('crimson_roots', (ctx, rng) => { clear(ctx); drawTuft(ctx, rng, 0x9a2b45, 0xbd3b58, 8, 15, 8); });
def('warped_roots', (ctx, rng) => { clear(ctx); drawTuft(ctx, rng, 0x14b485, 0x0f8a66, 8, 15, 8); });
def('nether_sprouts', (ctx, rng) => { clear(ctx); drawTuft(ctx, rng, 0x1fa88a, 0x2ec4a2, 9, 15, 6); });
def('weeping_vines', (ctx, rng) => { clear(ctx); for (let x = 1; x < TILE; x += 3) { const h = 6 + rng.int(10); for (let y = 0; y < h; y++) px(ctx, x, y, jit(rng, 0xa8232b, 0.15)); } });
defineAlias('weeping_vines_plant', 'weeping_vines');
def('twisting_vines', (ctx, rng) => { clear(ctx); for (let x = 1; x < TILE; x += 3) { const h = 6 + rng.int(10); for (let y = 0; y < h; y++) px(ctx, x, 15 - y, jit(rng, 0x14a897, 0.15)); } });
defineAlias('twisting_vines_plant', 'twisting_vines');
def('nether_wart_stage0', (ctx, rng) => { clear(ctx); drawCropStalks(ctx, rng, 0x7a1418, 5, 0xa02024); });
def('nether_wart_stage1', (ctx, rng) => { clear(ctx); drawCropStalks(ctx, rng, 0x8e181d, 9, 0xb82a2f); });
def('nether_wart_stage2', (ctx, rng) => { clear(ctx); drawCropStalks(ctx, rng, 0xa02024, 13, 0xd03038); });

// --- sculk -----------------------------------------------------------------
def('sculk', (ctx, rng) => { noise(ctx, rng, 0x0e191f, 0.18, { fine: 0.1 }); for (let i = 0; i < 12; i++) { const x = rng.int(TILE), y = rng.int(TILE); px(ctx, x, y, 0x18d0c0); px(ctx, x + 1, y, 0x0f6f68); } speckle(ctx, rng, 0x1b2f38, 14); });
def('sculk_vein', (ctx, rng) => { clear(ctx); for (let i = 0; i < 46; i++) { const x = rng.int(TILE), y = rng.int(TILE); px(ctx, x, y, rng.next() < 0.25 ? 0x1ec4b8 : 0x143038); } });
def('sculk_catalyst_top', (ctx, rng) => { noise(ctx, rng, 0x1a2b33, 0.12); circle(ctx, 8, 8, 4, 0x0d1a20); speckle(ctx, rng, 0x2fe0d0, 8); });
def('sculk_catalyst_bottom', (ctx, rng) => { drawInto(ctx, 'sculk'); });
def('sculk_catalyst_side', (ctx, rng) => { noise(ctx, rng, 0x16242b, 0.12); rect(ctx, 0, 0, TILE, 4, 0x243740); speckle(ctx, rng, 0x2fe0d0, 8); });
def('sculk_catalyst_top_bloom', (ctx, rng) => { drawInto(ctx, 'sculk_catalyst_top'); speckle(ctx, rng, 0x6ffff0, 14); });
def('sculk_shrieker_top', (ctx, rng) => { noise(ctx, rng, 0x1a2b33, 0.1); ring(ctx, 8, 8, 5, 0x0b161b, 1); ring(ctx, 8, 8, 3, 0xd8c98a, 0.9); circle(ctx, 8, 8, 1.6, 0x0b161b); });
def('sculk_shrieker_bottom', (ctx, rng) => { noise(ctx, rng, 0x14222a, 0.1); });
def('sculk_shrieker_side', (ctx, rng) => { noise(ctx, rng, 0x16242b, 0.11); rect(ctx, 0, 2, TILE, 2, 0xd8c98a, 0.7); });
def('sculk_shrieker_inner_top', (ctx, rng) => { circle(ctx, 8, 8, 7, 0x0b161b); circle(ctx, 8, 8, 4, 0x2fe0d0); });
def('sculk_sensor_top', (ctx, rng) => { noise(ctx, rng, 0x14222a, 0.1); for (let i = 0; i < 3; i++) { const a = i * 2.1; rect(ctx, 8 + Math.cos(a) * 4, 8 + Math.sin(a) * 4, 2, 2, 0x2fe0d0); } circle(ctx, 8, 8, 2, 0x0b161b); });
def('sculk_sensor_bottom', (ctx, rng) => { noise(ctx, rng, 0x14222a, 0.1); });
def('sculk_sensor_side', (ctx, rng) => { noise(ctx, rng, 0x16242b, 0.11); rect(ctx, 0, 0, TILE, 3, 0x1d3d46); speckle(ctx, rng, 0x2fe0d0, 6); });
defineAlias('calibrated_sculk_sensor_top', 'sculk_sensor_top');
defineAlias('calibrated_sculk_sensor_side', 'sculk_sensor_side');
def('calibrated_sculk_sensor_input_side', (ctx, rng) => { drawInto(ctx, 'sculk_sensor_side'); rect(ctx, 5, 6, 6, 5, 0x0d6f68); });

// --- crops -----------------------------------------------------------------
for (let s = 0; s < 8; s++) {
  def('wheat_stage' + s, (ctx, rng) => {
    const t = s / 7;
    const col = mix(0x4f7a2c, 0xd8c25a, t);
    drawCropStalks(ctx, rng, col, 3 + Math.round(t * 11), s >= 6 ? 0xe8d67a : null);
  });
}
for (let s = 0; s < 4; s++) {
  def('carrots_stage' + s, (ctx, rng) => { drawCropStalks(ctx, rng, mix(0x3f6a24, 0x63a83a, s / 3), 4 + s * 3, s === 3 ? 0xe8801d : null); });
  def('potatoes_stage' + s, (ctx, rng) => { drawCropStalks(ctx, rng, mix(0x3f6a24, 0x5d9c34, s / 3), 4 + s * 3, s === 3 ? 0xd8c470 : null); });
  def('beetroots_stage' + s, (ctx, rng) => { drawCropStalks(ctx, rng, mix(0x3f6a24, 0x5d9c34, s / 3), 3 + s * 3, s >= 2 ? 0xa82a3c : null); });
}
def('melon_top', (ctx, rng) => { noise(ctx, rng, 0x5e8f2c, 0.1); for (let i = 0; i < 5; i++) ring(ctx, 8, 8, 2 + i * 1.5, 0x3f6a1c, 0.5); });
def('melon_side', (ctx, rng) => { noise(ctx, rng, 0x6ea033, 0.09); for (let x = 1; x < TILE; x += 3) rect(ctx, x, 0, 1, TILE, 0x3f6a1c, 0.75); speckle(ctx, rng, 0x8bbf4a, 10); });
def('melon_stem', (ctx, rng) => { clear(ctx); drawCropStalks(ctx, rng, 0x5d9c34, 8, null); });
def('attached_melon_stem', (ctx, rng) => { clear(ctx); rect(ctx, 7, 6, 2, 10, 0x8d9c34); rect(ctx, 9, 6, 5, 2, 0x8d9c34); });
def('pumpkin_top', (ctx, rng) => { noise(ctx, rng, 0xc07615, 0.08); ring(ctx, 8, 8, 6, 0x9a5b0e, 0.6); rect(ctx, 6, 6, 4, 4, 0x6b4a20); });
def('pumpkin_side', (ctx, rng) => { noise(ctx, rng, 0xc07615, 0.08); for (let x = 1; x < TILE; x += 4) rect(ctx, x, 0, 1, TILE, 0x9a5b0e, 0.75); rect(ctx, 0, 0, TILE, 2, 0x8b6a3f); });
def('pumpkin_bottom', (ctx, rng) => { noise(ctx, rng, 0xa96410, 0.08); });
def('carved_pumpkin', (ctx, rng) => {
  drawInto(ctx, 'pumpkin_side');
  const d = 0x3a2308;
  rect(ctx, 3, 5, 3, 2, d); rect(ctx, 10, 5, 3, 2, d);
  rect(ctx, 4, 7, 1, 1, d); rect(ctx, 11, 7, 1, 1, d);
  rect(ctx, 5, 10, 6, 2, d); rect(ctx, 6, 9, 1, 1, d); rect(ctx, 9, 9, 1, 1, d);
});
def('jack_o_lantern', (ctx, rng) => {
  drawInto(ctx, 'pumpkin_side');
  const d = 0xffd257;
  rect(ctx, 3, 5, 3, 2, d); rect(ctx, 10, 5, 3, 2, d);
  rect(ctx, 4, 7, 1, 1, d); rect(ctx, 11, 7, 1, 1, d);
  rect(ctx, 5, 10, 6, 2, d); rect(ctx, 6, 9, 1, 1, d); rect(ctx, 9, 9, 1, 1, d);
});
def('pumpkin_stem', (ctx, rng) => { clear(ctx); drawCropStalks(ctx, rng, 0x5d9c34, 8, null); });
def('attached_pumpkin_stem', (ctx, rng) => { clear(ctx); rect(ctx, 7, 6, 2, 10, 0x8d9c34); rect(ctx, 9, 6, 5, 2, 0x8d9c34); });
for (let s = 0; s < 3; s++) {
  def('cocoa_stage' + s, (ctx, rng) => {
    clear(ctx);
    const r = 2 + s * 1.6;
    rect(ctx, 7, 0, 2, 4, 0x6b5030);
    circle(ctx, 8, 5 + r, r, mix(0x8b9a3a, 0xa2551d, s / 2));
    px(ctx, 7, 5, 0xc07b3a);
  });
}
for (let s = 0; s < 4; s++) {
  def('sweet_berry_bush_stage' + s, (ctx, rng) => {
    clear(ctx);
    drawTuft(ctx, rng, 0x3f6a24, 0x557f30, 5 + s * 2, 15, 6 + s * 2);
    if (s >= 2) for (let i = 0; i < s * 2; i++) px(ctx, 2 + rng.int(12), 6 + rng.int(8), 0xd0323c);
  });
}
def('chorus_flower', (ctx, rng) => { noise(ctx, rng, 0xd6c2d6, 0.07); border(ctx, 0xa287a2, 0); rect(ctx, 5, 5, 6, 6, 0xbfa5bf); rect(ctx, 6, 6, 4, 4, 0xe8dbe8); });
def('chorus_flower_dead', (ctx, rng) => { noise(ctx, rng, 0x8b7d8b, 0.07); border(ctx, 0x6a5f6a, 0); rect(ctx, 5, 5, 6, 6, 0x7a6d7a); });
def('chorus_plant', (ctx, rng) => { noise(ctx, rng, 0x785479, 0.1); speckle(ctx, rng, 0x5c3f5d, 12); speckle(ctx, rng, 0x9a72a0, 8); });
def('sea_pickle', (ctx, rng) => { clear(ctx); for (const [x, y] of [[4, 9], [8, 7], [11, 10]]) { rect(ctx, x, y, 3, 6, 0x6b8f2e); rect(ctx, x, y, 3, 1, 0xcfe08a); } });
def('pitcher_plant_top', (ctx, rng) => { clear(ctx); circle(ctx, 8, 8, 6, 0xa04a8f); circle(ctx, 8, 8, 3.4, 0xd07ac0); });
def('pitcher_plant_bottom', (ctx, rng) => { clear(ctx); rect(ctx, 5, 2, 6, 13, 0x4a7a2c); rect(ctx, 6, 2, 4, 6, 0x8b3f7d); });
for (let s = 0; s < 5; s++) def('pitcher_crop_stage' + s, (ctx, rng) => { clear(ctx); drawCropStalks(ctx, rng, mix(0x3f6a24, 0x8b3f7d, s / 4), 3 + s * 3, s >= 3 ? 0xd07ac0 : null); });
for (let s = 0; s < 2; s++) def('torchflower_crop_stage' + s, (ctx, rng) => { clear(ctx); drawCropStalks(ctx, rng, 0x4f7a2c, 5 + s * 5, s === 1 ? 0xe86b2c : null); });

// --- utility / machine blocks ---------------------------------------------
const OAK_P = 0xb8945f, OAK_D = 0x96754a;
const woodBase = (ctx, rng, a = OAK_P, b = OAK_D) => plank(ctx, rng, a, b, 4);

def('crafting_table_top', (ctx, rng) => { woodBase(ctx, rng, 0x8a6a3f, 0x6d5230); border(ctx, 0x4e3b22, 0); rect(ctx, 2, 2, 5, 5, 0xa07b4b); rect(ctx, 9, 2, 5, 5, 0xa07b4b); rect(ctx, 2, 9, 5, 5, 0xa07b4b); rect(ctx, 9, 9, 5, 5, 0xa07b4b); });
def('crafting_table_front', (ctx, rng) => { woodBase(ctx, rng); rect(ctx, 1, 4, 6, 5, 0x6d5230); rect(ctx, 9, 4, 6, 5, 0x6d5230); rect(ctx, 2, 5, 4, 3, 0x4e3b22); rect(ctx, 10, 5, 4, 3, 0x4e3b22); });
def('crafting_table_side', (ctx, rng) => { woodBase(ctx, rng); rect(ctx, 2, 3, 12, 4, 0x6d5230); rect(ctx, 3, 9, 10, 4, 0x8a6a3f); });
defineAlias('crafting_table_bottom', 'oak_planks');

const machineTop = (base) => (ctx, rng) => { noise(ctx, rng, base, 0.08); border(ctx, shade(base, 0.75), 0); rect(ctx, 4, 4, 8, 8, shade(base, 0.88)); border(ctx, shade(base, 1.1), 4, 0.6); };
const machineSide = (base) => (ctx, rng) => { noise(ctx, rng, base, 0.09); border(ctx, shade(base, 0.75), 0); };
def('furnace_top', machineTop(0x707070));
def('furnace_side', machineSide(0x707070));
def('furnace_front', (ctx, rng) => { noise(ctx, rng, 0x707070, 0.09); border(ctx, 0x525252, 0); rect(ctx, 3, 6, 10, 7, 0x2b2b2b); rect(ctx, 3, 4, 10, 2, 0x8a8a8a); rect(ctx, 4, 7, 8, 5, 0x1c1c1c); });
def('furnace_front_on', (ctx, rng) => { drawInto(ctx, 'furnace_front'); rect(ctx, 4, 9, 8, 3, 0xd8721c); rect(ctx, 5, 8, 6, 1, 0xffb03c); speckle(ctx, rng, 0xffe08a, 6); });
def('blast_furnace_top', machineTop(0x4a4a52));
def('blast_furnace_side', machineSide(0x4a4a52));
def('blast_furnace_front', (ctx, rng) => { noise(ctx, rng, 0x4a4a52, 0.09); border(ctx, 0x33333a, 0); rect(ctx, 3, 5, 10, 8, 0x1e1e22); for (let x = 4; x < 12; x += 2) rect(ctx, x, 5, 1, 3, 0x6a6a72); rect(ctx, 4, 8, 8, 4, 0x141418); });
def('blast_furnace_front_on', (ctx, rng) => { drawInto(ctx, 'blast_furnace_front'); rect(ctx, 4, 9, 8, 3, 0x3ac8ff); rect(ctx, 5, 8, 6, 1, 0xa8e8ff); });
def('smoker_top', (ctx, rng) => { logTop(ctx, rng, 0x6a5030, 0x3b2c18); });
def('smoker_side', (ctx, rng) => { logSide(ctx, rng, 0x3b2c18, 0x241a0d); rect(ctx, 0, 6, TILE, 4, 0x5a5a5a); });
def('smoker_bottom', (ctx, rng) => noise(ctx, rng, 0x4a4a4a, 0.08));
def('smoker_front', (ctx, rng) => { logSide(ctx, rng, 0x3b2c18, 0x241a0d); rect(ctx, 3, 5, 10, 8, 0x2b2b2b); rect(ctx, 4, 6, 8, 6, 0x171717); for (let x = 4; x < 12; x += 3) rect(ctx, x, 5, 1, 2, 0x6a5030); });
def('smoker_front_on', (ctx, rng) => { drawInto(ctx, 'smoker_front'); rect(ctx, 4, 9, 8, 3, 0xd8721c); rect(ctx, 5, 8, 6, 1, 0xffb03c); });

def('chest_top', (ctx, rng) => { woodBase(ctx, rng, 0x8a6a3f, 0x6d5230); border(ctx, 0x4e3b22, 0); });
def('chest_side', (ctx, rng) => { woodBase(ctx, rng, 0x8a6a3f, 0x6d5230); rect(ctx, 0, 4, TILE, 1, 0x4e3b22); border(ctx, 0x4e3b22, 0); });
def('chest_front', (ctx, rng) => { woodBase(ctx, rng, 0x8a6a3f, 0x6d5230); rect(ctx, 0, 4, TILE, 1, 0x4e3b22); border(ctx, 0x4e3b22, 0); rect(ctx, 6, 3, 4, 4, 0x6b6b6b); rect(ctx, 7, 4, 2, 2, 0x3a3a3a); px(ctx, 7, 5, 0xd8d8d8); });
defineAlias('trapped_chest_top', 'chest_top');
defineAlias('trapped_chest_side', 'chest_side');
def('trapped_chest_front', (ctx, rng) => { drawInto(ctx, 'chest_front'); rect(ctx, 0, 0, TILE, 1, 0xc02020); });
def('ender_chest_top', (ctx, rng) => { noise(ctx, rng, 0x1b2b30, 0.12); border(ctx, 0x0d1518, 0); speckle(ctx, rng, 0x2f5f6a, 8); });
def('ender_chest_side', (ctx, rng) => { noise(ctx, rng, 0x1b2b30, 0.12); rect(ctx, 0, 4, TILE, 1, 0x0d1518); border(ctx, 0x0d1518, 0); });
def('ender_chest_front', (ctx, rng) => { drawInto(ctx, 'ender_chest_side'); rect(ctx, 6, 3, 4, 4, 0x2fd18d); rect(ctx, 7, 4, 2, 2, 0x0d1518); });
def('barrel_top', (ctx, rng) => { woodBase(ctx, rng, 0x8a6a3f, 0x6d5230); border(ctx, 0x4e3b22, 0); rect(ctx, 4, 4, 8, 8, 0x6a6a6a); rect(ctx, 6, 6, 4, 4, 0x4a4a4a); });
def('barrel_top_open', (ctx, rng) => { woodBase(ctx, rng, 0x5a4526, 0x40301b); border(ctx, 0x2e2313, 0); rect(ctx, 3, 3, 10, 10, 0x241b0e); });
def('barrel_side', (ctx, rng) => { woodBase(ctx, rng, 0x8a6a3f, 0x6d5230); rect(ctx, 0, 2, TILE, 2, 0x50505a); rect(ctx, 0, 12, TILE, 2, 0x50505a); });
def('barrel_bottom', (ctx, rng) => { woodBase(ctx, rng, 0x7a5c35, 0x5d472a); });
def('hopper_top', (ctx, rng) => { noise(ctx, rng, 0x4a4a4a, 0.09); border(ctx, 0x2b2b2b, 0); rect(ctx, 2, 2, 12, 12, 0x2b2b2b); rect(ctx, 3, 3, 10, 10, 0x1c1c1c); });
def('hopper_outside', (ctx, rng) => { noise(ctx, rng, 0x4a4a4a, 0.09); rect(ctx, 0, 0, TILE, 4, 0x3a3a3a); border(ctx, 0x2b2b2b, 0); });
def('hopper_inside', (ctx, rng) => { noise(ctx, rng, 0x2b2b2b, 0.08); });
def('dispenser_front', (ctx, rng) => { noise(ctx, rng, 0x707070, 0.09); border(ctx, 0x525252, 0); rect(ctx, 4, 4, 8, 8, 0x2b2b2b); rect(ctx, 5, 5, 6, 6, 0x151515); rect(ctx, 6, 6, 4, 4, 0x3a3a3a); });
def('dispenser_front_vertical', (ctx, rng) => { drawInto(ctx, 'dispenser_front'); rect(ctx, 6, 6, 4, 4, 0x1c1c1c); });
def('dropper_front', (ctx, rng) => { noise(ctx, rng, 0x707070, 0.09); border(ctx, 0x525252, 0); rect(ctx, 5, 5, 6, 6, 0x2b2b2b); rect(ctx, 6, 6, 4, 4, 0x151515); });
def('dropper_front_vertical', (ctx, rng) => { drawInto(ctx, 'dropper_front'); });
def('observer_top', (ctx, rng) => { noise(ctx, rng, 0x6a6a6a, 0.09); rect(ctx, 0, 6, TILE, 4, 0x4a4a4a); });
def('observer_bottom', (ctx, rng) => { noise(ctx, rng, 0x6a6a6a, 0.09); rect(ctx, 6, 0, 4, TILE, 0x4a4a4a); });
def('observer_side', (ctx, rng) => { noise(ctx, rng, 0x6a6a6a, 0.09); rect(ctx, 0, 0, TILE, 3, 0x4a4a4a); rect(ctx, 0, 13, TILE, 3, 0x4a4a4a); });
def('observer_front', (ctx, rng) => { noise(ctx, rng, 0x5a5a5a, 0.09); border(ctx, 0x3a3a3a, 0); rect(ctx, 4, 4, 8, 8, 0x2b2b2b); rect(ctx, 5, 5, 6, 6, 0x8a8a8a); });
def('observer_back', (ctx, rng) => { noise(ctx, rng, 0x5a5a5a, 0.09); border(ctx, 0x3a3a3a, 0); circle(ctx, 8, 8, 3.4, 0x2b2b2b); circle(ctx, 8, 8, 2, 0x6a6a6a); });
def('observer_back_on', (ctx, rng) => { drawInto(ctx, 'observer_back'); circle(ctx, 8, 8, 2, 0xff2020); });
def('piston_top', (ctx, rng) => { woodBase(ctx, rng, 0xc2a26a, 0x9d8050); border(ctx, 0x6a5030, 0); });
def('piston_top_sticky', (ctx, rng) => { drawInto(ctx, 'piston_top'); rect(ctx, 3, 3, 10, 10, 0x83a83c); rect(ctx, 5, 5, 6, 6, 0x9fc45a); });
def('piston_bottom', (ctx, rng) => { woodBase(ctx, rng, 0x8a6a3f, 0x6d5230); border(ctx, 0x4e3b22, 0); });
def('piston_side', (ctx, rng) => { woodBase(ctx, rng, 0x8a6a3f, 0x6d5230); rect(ctx, 0, 0, TILE, 4, 0xa8a8a8); rect(ctx, 0, 4, TILE, 1, 0x6a6a6a); });
def('piston_inner', (ctx, rng) => { noise(ctx, rng, 0x8a6a3f, 0.09); border(ctx, 0x4e3b22, 0); });
def('note_block', (ctx, rng) => { woodBase(ctx, rng, 0x5c4527, 0x43321b); border(ctx, 0x2e2213, 0); rect(ctx, 6, 5, 2, 6, 0x2e2213); rect(ctx, 5, 10, 4, 2, 0x2e2213); });
def('jukebox_top', (ctx, rng) => { woodBase(ctx, rng, 0x5c4527, 0x43321b); border(ctx, 0x2e2213, 0); rect(ctx, 4, 4, 8, 8, 0x2b2b2b); circle(ctx, 8, 8, 3, 0x1d1d21); px(ctx, 8, 8, 0xc0c0c0); });
def('jukebox_side', (ctx, rng) => { woodBase(ctx, rng, 0x5c4527, 0x43321b); border(ctx, 0x2e2213, 0); rect(ctx, 0, 6, TILE, 4, 0x6c5330); });
def('bookshelf', (ctx, rng) => {
  woodBase(ctx, rng);
  rect(ctx, 0, 1, TILE, 6, 0x5c4527); rect(ctx, 0, 9, TILE, 6, 0x5c4527);
  const cols = [0xa02c2c, 0x2c5aa0, 0xd0a83c, 0x2c8a4a, 0x8a3ca0, 0xc06a2c];
  for (let s = 0; s < 2; s++) {
    let x = 0;
    while (x < TILE) {
      const w = 1 + rng.int(2);
      rect(ctx, x, s ? 9 : 1, w, 6, cols[rng.int(cols.length)]);
      x += w + 1;
    }
  }
});
def('chiseled_bookshelf_top', (ctx, rng) => woodBase(ctx, rng, 0x8a6a3f, 0x6d5230));
def('chiseled_bookshelf_side', (ctx, rng) => woodBase(ctx, rng, 0x8a6a3f, 0x6d5230));
def('chiseled_bookshelf_empty', (ctx, rng) => { woodBase(ctx, rng, 0x8a6a3f, 0x6d5230); rect(ctx, 1, 1, 6, 14, 0x3a2b18); rect(ctx, 9, 1, 6, 14, 0x3a2b18); });
def('chiseled_bookshelf_occupied', (ctx, rng) => { drawInto(ctx, 'chiseled_bookshelf_empty'); rect(ctx, 2, 2, 2, 12, 0xa02c2c); rect(ctx, 4, 2, 2, 12, 0x2c5aa0); rect(ctx, 10, 2, 2, 12, 0xd0a83c); rect(ctx, 12, 2, 2, 12, 0x2c8a4a); });
def('lectern_top', (ctx, rng) => { woodBase(ctx, rng, 0x8a6a3f, 0x6d5230); rect(ctx, 2, 2, 12, 12, 0xd8d0b8); rect(ctx, 7, 2, 2, 12, 0x8a6a3f); });
def('lectern_sides', (ctx, rng) => { woodBase(ctx, rng, 0x8a6a3f, 0x6d5230); rect(ctx, 0, 0, TILE, 4, 0x6d5230); });
def('lectern_front', (ctx, rng) => { woodBase(ctx, rng, 0x8a6a3f, 0x6d5230); rect(ctx, 3, 3, 10, 6, 0x6d5230); });
def('lectern_base', (ctx, rng) => woodBase(ctx, rng, 0x7a5c35, 0x5d472a));
def('enchanting_table_top', (ctx, rng) => { noise(ctx, rng, 0x9c2b2b, 0.1); border(ctx, 0x3a1010, 0); rect(ctx, 3, 3, 10, 10, 0x1c1220); speckle(ctx, rng, 0x6a3fa0, 8); });
def('enchanting_table_side', (ctx, rng) => { noise(ctx, rng, 0x1c1220, 0.12); rect(ctx, 0, 0, TILE, 4, 0x9c2b2b); rect(ctx, 0, 4, TILE, 1, 0x3a1010); speckle(ctx, rng, 0x6a3fa0, 8); });
def('enchanting_table_bottom', (ctx, rng) => noise(ctx, rng, 0x14121f, 0.14));
def('anvil', (ctx, rng) => { noise(ctx, rng, 0x484848, 0.09); rect(ctx, 0, 0, TILE, 4, 0x5c5c5c); rect(ctx, 3, 4, 10, 5, 0x3a3a3a); rect(ctx, 1, 12, 14, 4, 0x5c5c5c); border(ctx, 0x2b2b2b, 0, 0.7); });
def('anvil_top', (ctx, rng) => { noise(ctx, rng, 0x545454, 0.08); border(ctx, 0x2b2b2b, 0); rect(ctx, 2, 4, 12, 8, 0x686868); });
def('chipped_anvil_top', (ctx, rng) => { drawInto(ctx, 'anvil_top'); crackOverlay(ctx, rng, 0x2b2b2b, 3); });
def('damaged_anvil_top', (ctx, rng) => { drawInto(ctx, 'anvil_top'); crackOverlay(ctx, rng, 0x1e1e1e, 7); });
def('brewing_stand', (ctx, rng) => { clear(ctx); rect(ctx, 7, 1, 2, 12, 0xc0c0c0); rect(ctx, 4, 6, 8, 1, 0x9a9a9a); rect(ctx, 5, 12, 6, 3, 0x8a8a8a); px(ctx, 8, 0, 0xffe08a); });
def('brewing_stand_base', (ctx, rng) => { noise(ctx, rng, 0x6a6a6a, 0.09); rect(ctx, 3, 3, 10, 10, 0x4a4a4a); rect(ctx, 5, 5, 6, 6, 0x8a6a3f); });
def('cauldron_top', (ctx, rng) => { noise(ctx, rng, 0x4a4a4a, 0.09); border(ctx, 0x2b2b2b, 0); rect(ctx, 2, 2, 12, 12, 0x1e1e1e); });
def('cauldron_side', (ctx, rng) => { noise(ctx, rng, 0x4a4a4a, 0.09); rect(ctx, 0, 0, TILE, 3, 0x5c5c5c); rect(ctx, 0, 13, TILE, 3, 0x333333); border(ctx, 0x2b2b2b, 0, 0.8); });
def('cauldron_bottom', (ctx, rng) => noise(ctx, rng, 0x3a3a3a, 0.09));
def('cauldron_inner', (ctx, rng) => noise(ctx, rng, 0x2b2b2b, 0.08));
def('beacon', (ctx, rng) => { noise(ctx, rng, 0x60d2d2, 0.08); border(ctx, 0x1c3a3a, 0); rect(ctx, 3, 3, 10, 10, 0x1c1220); rect(ctx, 5, 5, 6, 6, 0x9ff0f0); rect(ctx, 6, 6, 4, 4, 0xffffff); });
def('conduit', (ctx, rng) => { noise(ctx, rng, 0x9c8a6a, 0.1); border(ctx, 0x5c4f3a, 0); circle(ctx, 8, 8, 3.2, 0x2b3f4a); circle(ctx, 8, 8, 1.6, 0xf0e8b0); });
def('lodestone_top', (ctx, rng) => { noise(ctx, rng, 0x8a8a90, 0.08); border(ctx, 0x5a5a60, 0); ring(ctx, 8, 8, 4, 0x3a3a40, 0.7); circle(ctx, 8, 8, 1.4, 0xc0c0c8); });
def('lodestone_side', (ctx, rng) => { noise(ctx, rng, 0x7a7a80, 0.09); rect(ctx, 0, 0, TILE, 2, 0x5a5a60); rect(ctx, 0, 14, TILE, 2, 0x5a5a60); for (let x = 3; x < TILE; x += 5) rect(ctx, x, 2, 1, 12, 0x5a5a60); });
def('respawn_anchor_top', (ctx, rng) => { noise(ctx, rng, 0x2b2426, 0.12); rect(ctx, 3, 3, 10, 10, 0x6a3fa0); speckle(ctx, rng, 0xb26bff, 8); });
def('respawn_anchor_top_off', (ctx, rng) => { noise(ctx, rng, 0x2b2426, 0.12); rect(ctx, 3, 3, 10, 10, 0x1c1220); });
def('respawn_anchor_bottom', (ctx, rng) => noise(ctx, rng, 0x2b2426, 0.12));
for (let i = 0; i < 5; i++) def('respawn_anchor_side' + i, (ctx, rng) => { noise(ctx, rng, 0x2b2426, 0.12); const h = i * 3; if (h) rect(ctx, 2, 14 - h, 12, h, 0x6a3fa0); if (h) speckle(ctx, rng, 0xb26bff, 6); });
def('loom_top', (ctx, rng) => { woodBase(ctx, rng, 0x8a6a3f, 0x6d5230); rect(ctx, 3, 3, 10, 10, 0xd8d0b8); });
def('loom_side', (ctx, rng) => { woodBase(ctx, rng, 0x8a6a3f, 0x6d5230); rect(ctx, 0, 6, TILE, 2, 0xd8d0b8); });
def('loom_front', (ctx, rng) => { woodBase(ctx, rng, 0x8a6a3f, 0x6d5230); rect(ctx, 3, 2, 10, 9, 0xd8d0b8); for (let x = 4; x < 12; x += 2) rect(ctx, x, 3, 1, 7, 0xb0a68c); });
def('loom_bottom', (ctx, rng) => woodBase(ctx, rng, 0x7a5c35, 0x5d472a));
def('smithing_table_top', (ctx, rng) => { noise(ctx, rng, 0x3a3134, 0.09); border(ctx, 0x241e20, 0); rect(ctx, 3, 3, 10, 10, 0x4a4046); });
def('smithing_table_side', (ctx, rng) => { woodBase(ctx, rng, 0x4a3a2a, 0x362a1e); rect(ctx, 0, 0, TILE, 5, 0x3a3134); });
def('smithing_table_front', (ctx, rng) => { woodBase(ctx, rng, 0x4a3a2a, 0x362a1e); rect(ctx, 0, 0, TILE, 5, 0x3a3134); rect(ctx, 4, 7, 8, 5, 0x2b2426); rect(ctx, 5, 8, 6, 3, 0x8a8a8a); });
def('smithing_table_bottom', (ctx, rng) => woodBase(ctx, rng, 0x4a3a2a, 0x362a1e));
def('stonecutter_top', (ctx, rng) => { noise(ctx, rng, 0x6a6a6a, 0.09); border(ctx, 0x4a4a4a, 0); rect(ctx, 7, 1, 2, 14, 0xd0d0d0); });
def('stonecutter_side', (ctx, rng) => { noise(ctx, rng, 0x6a6a6a, 0.09); rect(ctx, 0, 0, TILE, 3, 0x8a8a8a); rect(ctx, 0, 13, TILE, 3, 0x4a4a4a); });
def('stonecutter_bottom', (ctx, rng) => noise(ctx, rng, 0x5a5a5a, 0.09));
def('stonecutter_saw', (ctx, rng) => { clear(ctx); circle(ctx, 8, 10, 6, 0xc0c0c0); circle(ctx, 8, 10, 4, 0x8a8a8a); for (let i = 0; i < 12; i++) { const a = (i / 12) * Math.PI * 2; px(ctx, 8 + Math.cos(a) * 7, 10 + Math.sin(a) * 7, 0xe8e8e8); } });
def('grindstone_side', (ctx, rng) => { noise(ctx, rng, 0x8a6a3f, 0.09); rect(ctx, 2, 2, 12, 12, 0x9a9a9a); circle(ctx, 8, 8, 5, 0x707070); });
def('grindstone_round', (ctx, rng) => { clear(ctx); circle(ctx, 8, 8, 7, 0x9a9a9a); circle(ctx, 8, 8, 5.4, 0x777777); circle(ctx, 8, 8, 2, 0x4a4a4a); });
def('grindstone_pivot', (ctx, rng) => { noise(ctx, rng, 0x7a5c35, 0.1); border(ctx, 0x4e3b22, 0); });
def('cartography_table_top', (ctx, rng) => { woodBase(ctx, rng, 0x6a5030, 0x4e3b22); rect(ctx, 2, 2, 11, 11, 0xe4d8ac); rect(ctx, 4, 4, 7, 7, 0xc2b688); });
def('cartography_table_side1', (ctx, rng) => { woodBase(ctx, rng, 0x6a5030, 0x4e3b22); rect(ctx, 1, 3, 6, 5, 0xe4d8ac); });
def('cartography_table_side2', (ctx, rng) => { woodBase(ctx, rng, 0x6a5030, 0x4e3b22); rect(ctx, 8, 5, 7, 6, 0xe4d8ac); });
def('cartography_table_side3', (ctx, rng) => { woodBase(ctx, rng, 0x6a5030, 0x4e3b22); rect(ctx, 3, 7, 10, 5, 0xd8cca0); });
def('fletching_table_top', (ctx, rng) => { woodBase(ctx, rng, 0xc8b184, 0xa89264); for (let i = 0; i < 6; i++) veins(ctx, rng, 0x6a5a3a, 1, 8, 0.7); });
def('fletching_table_side', (ctx, rng) => { woodBase(ctx, rng, 0xc8b184, 0xa89264); rect(ctx, 2, 3, 3, 10, 0x6a5a3a); rect(ctx, 11, 3, 3, 10, 0x6a5a3a); });
def('fletching_table_front', (ctx, rng) => { woodBase(ctx, rng, 0xc8b184, 0xa89264); rect(ctx, 4, 2, 2, 12, 0x8a7a5a); rect(ctx, 10, 2, 2, 12, 0x8a7a5a); });
def('composter_top', (ctx, rng) => { woodBase(ctx, rng, 0x6a5030, 0x4e3b22); rect(ctx, 2, 2, 12, 12, 0x3a2b18); });
def('composter_side', (ctx, rng) => { woodBase(ctx, rng, 0x6a5030, 0x4e3b22, 3); for (let x = 0; x < TILE; x += 5) rect(ctx, x, 0, 1, TILE, 0x4e3b22); });
def('composter_bottom', (ctx, rng) => woodBase(ctx, rng, 0x5d472a, 0x40301b));
def('composter_compost', (ctx, rng) => { noise(ctx, rng, 0x5c7a2c, 0.16); speckle(ctx, rng, 0x8a6a3f, 14); speckle(ctx, rng, 0x3f5a1c, 12); });
def('composter_ready', (ctx, rng) => { noise(ctx, rng, 0x7a9a34, 0.14); speckle(ctx, rng, 0xc2d84a, 16); });
def('bell_top', (ctx, rng) => { noise(ctx, rng, 0x8a6a3f, 0.09); rect(ctx, 5, 5, 6, 6, 0xd8b02c); });
def('bell_side', (ctx, rng) => { clear(ctx); rect(ctx, 5, 2, 6, 9, 0xe0b62c); rect(ctx, 3, 11, 10, 3, 0xc2971c); rect(ctx, 6, 3, 2, 7, 0xf8dc7a); });
def('bell_bottom', (ctx, rng) => { clear(ctx); circle(ctx, 8, 8, 6, 0xc2971c); circle(ctx, 8, 8, 3, 0x8a6a12); });
def('campfire_log', (ctx, rng) => { logSide(ctx, rng, 0x6a532f, 0x4b3a20); rect(ctx, 0, 6, TILE, 4, 0x3a2b18, 0.5); });
def('campfire_log_lit', (ctx, rng) => { drawInto(ctx, 'campfire_log'); speckle(ctx, rng, 0xd8721c, 12); });
def('campfire_fire', (ctx, rng) => { clear(ctx); for (let x = 2; x < 14; x++) { const h = 5 + rng.int(9); for (let y = 0; y < h; y++) px(ctx, x, 15 - y, y > h - 3 ? 0xffe08a : y > h - 6 ? 0xff9a2c : 0xd8461c); } });
def('soul_campfire_fire', (ctx, rng) => { clear(ctx); for (let x = 2; x < 14; x++) { const h = 5 + rng.int(9); for (let y = 0; y < h; y++) px(ctx, x, 15 - y, y > h - 3 ? 0xd8fbff : y > h - 6 ? 0x5ee0e8 : 0x1c9aa8); } });
def('scaffolding_top', (ctx, rng) => { clear(ctx); rect(ctx, 0, 0, TILE, 2, 0xc2a26a); rect(ctx, 0, 14, TILE, 2, 0xc2a26a); rect(ctx, 0, 0, 2, TILE, 0xc2a26a); rect(ctx, 14, 0, 2, TILE, 0xc2a26a); rect(ctx, 7, 0, 2, TILE, 0xa8874d); rect(ctx, 0, 7, TILE, 2, 0xa8874d); });
def('scaffolding_side', (ctx, rng) => { clear(ctx); rect(ctx, 1, 0, 3, TILE, 0xc2a26a); rect(ctx, 12, 0, 3, TILE, 0xc2a26a); rect(ctx, 1, 6, 14, 2, 0xa8874d); });
def('scaffolding_bottom', (ctx, rng) => { clear(ctx); rect(ctx, 1, 1, 14, 14, 0xa8874d); ctx.clearRect(4, 4, 8, 8); });
def('ladder', (ctx, rng) => { clear(ctx); rect(ctx, 2, 0, 2, TILE, 0x8b6a3f); rect(ctx, 12, 0, 2, TILE, 0x8b6a3f); for (let y = 2; y < TILE; y += 4) rect(ctx, 2, y, 12, 2, 0xa07b4b); });
def('torch', (ctx, rng) => { clear(ctx); rect(ctx, 7, 8, 2, 8, 0x8b6a3f); px(ctx, 7, 8, 0x6b4f2e); rect(ctx, 7, 6, 2, 2, 0xffcf5a); px(ctx, 7, 5, 0xfff3c0); px(ctx, 8, 5, 0xffb03c); });
def('soul_torch', (ctx, rng) => { clear(ctx); rect(ctx, 7, 8, 2, 8, 0x8b6a3f); rect(ctx, 7, 6, 2, 2, 0x5ee0e8); px(ctx, 7, 5, 0xd8fbff); px(ctx, 8, 5, 0x1c9aa8); });
def('redstone_torch', (ctx, rng) => { clear(ctx); rect(ctx, 7, 8, 2, 8, 0x8b6a3f); rect(ctx, 7, 5, 2, 3, 0xff2020); px(ctx, 7, 4, 0xff8080); px(ctx, 8, 6, 0xc00000); });
def('redstone_torch_off', (ctx, rng) => { clear(ctx); rect(ctx, 7, 8, 2, 8, 0x8b6a3f); rect(ctx, 7, 5, 2, 3, 0x6e1a1a); });
def('lantern', (ctx, rng) => { clear(ctx); rect(ctx, 6, 2, 4, 2, 0x6a6a6a); rect(ctx, 5, 4, 6, 7, 0x8a8a8a); rect(ctx, 6, 5, 4, 5, 0xffd257); rect(ctx, 5, 11, 6, 2, 0x6a6a6a); rect(ctx, 7, 0, 2, 2, 0x6a6a6a); });
def('soul_lantern', (ctx, rng) => { clear(ctx); rect(ctx, 6, 2, 4, 2, 0x6a6a6a); rect(ctx, 5, 4, 6, 7, 0x8a8a8a); rect(ctx, 6, 5, 4, 5, 0x5ee0e8); rect(ctx, 5, 11, 6, 2, 0x6a6a6a); rect(ctx, 7, 0, 2, 2, 0x6a6a6a); });
def('end_rod', (ctx, rng) => { clear(ctx); rect(ctx, 7, 0, 2, TILE, 0xe8e0d0); rect(ctx, 6, 11, 4, 5, 0xc8a8e0); px(ctx, 7, 0, 0xffffff); });
def('tnt_top', (ctx, rng) => { noise(ctx, rng, 0xc02020, 0.07); border(ctx, 0x8a1414, 0); rect(ctx, 5, 5, 6, 6, 0x3a3a3a); rect(ctx, 6, 6, 4, 4, 0x8a8a8a); });
def('tnt_bottom', (ctx, rng) => noise(ctx, rng, 0x6a4a2a, 0.08));
def('tnt_side', (ctx, rng) => { noise(ctx, rng, 0xc02020, 0.07); rect(ctx, 0, 4, TILE, 6, 0xf0f0f0); rect(ctx, 0, 4, TILE, 1, 0xa8a8a8); rect(ctx, 0, 9, TILE, 1, 0xa8a8a8); rect(ctx, 2, 5, 3, 4, 0x2a2a2a); rect(ctx, 6, 5, 4, 4, 0x2a2a2a); rect(ctx, 11, 5, 3, 4, 0x2a2a2a); });
def('spawner', (ctx, rng) => { clear(ctx); rect(ctx, 0, 0, TILE, TILE, 0x2b2b2b, 0.92); for (let y = 0; y < TILE; y += 4) for (let x = 0; x < TILE; x += 4) { ctx.clearRect(x + 1, y + 1, 2, 2); } border(ctx, 0x1c1c1c, 0); });
def('beehive_end', (ctx, rng) => { woodBase(ctx, rng, 0xb08a4a, 0x8f6f38); });
def('beehive_side', (ctx, rng) => { woodBase(ctx, rng, 0xb08a4a, 0x8f6f38); rect(ctx, 0, 5, TILE, 6, 0xc8a24a); });
def('beehive_front', (ctx, rng) => { drawInto(ctx, 'beehive_side'); rect(ctx, 5, 10, 6, 3, 0x3a2b18); });
def('beehive_front_honey', (ctx, rng) => { drawInto(ctx, 'beehive_side'); rect(ctx, 5, 10, 6, 3, 0xe09a2c); });
def('bee_nest_top', (ctx, rng) => { noise(ctx, rng, 0xa07a3a, 0.1); speckle(ctx, rng, 0xc2a24a, 12); });
def('bee_nest_bottom', (ctx, rng) => noise(ctx, rng, 0x8a6a3a, 0.1));
def('bee_nest_side', (ctx, rng) => { noise(ctx, rng, 0xb08a4a, 0.09); rect(ctx, 0, 6, TILE, 6, 0xd8a83c); for (let x = 0; x < TILE; x += 4) rect(ctx, x, 6, 1, 6, 0xa07a2c); });
def('bee_nest_front', (ctx, rng) => { drawInto(ctx, 'bee_nest_side'); rect(ctx, 5, 11, 6, 3, 0x3a2b18); });
def('bee_nest_front_honey', (ctx, rng) => { drawInto(ctx, 'bee_nest_side'); rect(ctx, 5, 11, 6, 3, 0xe09a2c); });
def('honeycomb_block', (ctx, rng) => { noise(ctx, rng, 0xe0a92c, 0.07); for (let y = 0; y < TILE; y += 5) for (let x = (y % 10 ? 0 : 3); x < TILE; x += 6) rect(ctx, x, y, 4, 4, 0xc48a1c); });
def('target_top', (ctx, rng) => { noise(ctx, rng, 0xe8e0d0, 0.06); ring(ctx, 8, 8, 6, 0xd02020, 1); ring(ctx, 8, 8, 3, 0xd02020, 1); circle(ctx, 8, 8, 1.4, 0xd02020); });
defineAlias('target_side', 'target_top');
def('lightning_rod', (ctx, rng) => { clear(ctx); rect(ctx, 6, 2, 4, 14, 0xc16f4e); rect(ctx, 6, 2, 1, 14, 0xd88f6e); rect(ctx, 9, 2, 1, 14, 0x94502f); rect(ctx, 5, 0, 6, 3, 0xa85c3c); });
def('lightning_rod_on', (ctx, rng) => { drawInto(ctx, 'lightning_rod'); rect(ctx, 6, 2, 4, 4, 0xffe08a); });
def('flower_pot', (ctx, rng) => { clear(ctx); rect(ctx, 4, 6, 8, 9, 0xa8542e); rect(ctx, 3, 5, 10, 2, 0xc06a3a); rect(ctx, 5, 7, 6, 3, 0x6a4020); });
def('cake_top', (ctx, rng) => { noise(ctx, rng, 0xf0f0f0, 0.05); speckle(ctx, rng, 0xd02040, 12); border(ctx, 0xc8b898, 0); });
def('cake_side', (ctx, rng) => { noise(ctx, rng, 0xc8a878, 0.06); rect(ctx, 0, 0, TILE, 3, 0xf0f0f0); rect(ctx, 0, 3, TILE, 1, 0xd02040); });
def('cake_bottom', (ctx, rng) => noise(ctx, rng, 0x9a7a4a, 0.06));
def('cake_inner', (ctx, rng) => { noise(ctx, rng, 0xe8d8b0, 0.06); rect(ctx, 0, 0, TILE, 3, 0xf0f0f0); });
def('dried_kelp_block_top', (ctx, rng) => { noise(ctx, rng, 0x35402a, 0.12); speckle(ctx, rng, 0x23301c, 12); });
def('dried_kelp_block_side', (ctx, rng) => { noise(ctx, rng, 0x2c3a24, 0.12); for (let y = 2; y < TILE; y += 4) rect(ctx, 0, y, TILE, 1, 0x1c2618); });
def('hay_block_top', (ctx, rng) => { noise(ctx, rng, 0xc2a02c, 0.1); ring(ctx, 8, 8, 5, 0x9a7c1c, 0.7); });
def('hay_block_side', (ctx, rng) => { noise(ctx, rng, 0xb89a2c, 0.11); for (let y = 0; y < TILE; y += 3) rect(ctx, 0, y, TILE, 1, 0x8f7418, 0.7); rect(ctx, 0, 0, TILE, 1, 0x6a5610); });
for (const [n, c] of [['ochre_froglight', 0xd8c47a], ['verdant_froglight', 0x9ac47a], ['pearlescent_froglight', 0xd8b8d0]]) {
  def(n + '_top', (ctx, rng) => { noise(ctx, rng, c, 0.07); circle(ctx, 8, 8, 4, shade(c, 1.2)); });
  def(n + '_side', (ctx, rng) => { noise(ctx, rng, shade(c, 0.92), 0.08); rect(ctx, 0, 0, TILE, 2, shade(c, 1.15)); rect(ctx, 0, 14, TILE, 2, shade(c, 1.15)); });
}
def('decorated_pot_side', (ctx, rng) => { noise(ctx, rng, 0xa8542e, 0.08); border(ctx, 0x7c3a1e, 0); rect(ctx, 4, 4, 8, 8, 0xc06a3a); });
def('decorated_pot_base', (ctx, rng) => { noise(ctx, rng, 0x8f4626, 0.08); });
def('suspicious_sand_0', (ctx, rng) => { drawInto(ctx, 'sand'); crackOverlay(ctx, rng, 0xb8ae7e, 3); });
for (let i = 1; i < 4; i++) def('suspicious_sand_' + i, (ctx, rng) => { drawInto(ctx, 'sand'); crackOverlay(ctx, rng, 0x9c9366, 3 + i * 2); });
for (let i = 0; i < 4; i++) def('suspicious_gravel_' + i, (ctx, rng) => { drawInto(ctx, 'gravel'); crackOverlay(ctx, rng, 0x4a4846, 3 + i * 2); });
def('structure_block', (ctx, rng) => { noise(ctx, rng, 0x5c4a5c, 0.1); border(ctx, 0x3a2e3a, 0); rect(ctx, 4, 6, 8, 4, 0xc8b0c8); });
def('jigsaw_top', (ctx, rng) => { noise(ctx, rng, 0x4a3a4a, 0.1); rect(ctx, 5, 5, 6, 6, 0xc8b0c8); });
def('jigsaw_side', (ctx, rng) => { noise(ctx, rng, 0x3a2e3a, 0.1); rect(ctx, 2, 2, 12, 12, 0x5c4a5c); });
def('jigsaw_bottom', (ctx, rng) => noise(ctx, rng, 0x2e242e, 0.1));
def('command_block_front', (ctx, rng) => { noise(ctx, rng, 0xbb8a5a, 0.09); circle(ctx, 8, 8, 4, 0x8a5c34); rect(ctx, 6, 7, 5, 2, 0xe8d0a8); });
def('command_block_back', (ctx, rng) => { noise(ctx, rng, 0xbb8a5a, 0.09); circle(ctx, 8, 8, 3, 0x8a5c34); });
def('command_block_side', (ctx, rng) => { noise(ctx, rng, 0xa87a4a, 0.09); border(ctx, 0x7c5630, 0); });
def('command_block_conditional', (ctx, rng) => { drawInto(ctx, 'command_block_side'); rect(ctx, 5, 5, 6, 6, 0x8a5c34); });

// --- skulls / heads --------------------------------------------------------
def('skeleton_skull', (ctx, rng) => { noise(ctx, rng, 0xc6c6c6, 0.07); rect(ctx, 3, 5, 3, 3, 0x2a2a2a); rect(ctx, 10, 5, 3, 3, 0x2a2a2a); rect(ctx, 5, 11, 6, 2, 0x8a8a8a); });
def('wither_skeleton_skull', (ctx, rng) => { noise(ctx, rng, 0x3a3a3a, 0.09); rect(ctx, 3, 5, 3, 3, 0x101010); rect(ctx, 10, 5, 3, 3, 0x101010); rect(ctx, 5, 11, 6, 2, 0x1c1c1c); });
def('zombie_head', (ctx, rng) => { noise(ctx, rng, 0x4c7a3a, 0.09); rect(ctx, 3, 5, 3, 2, 0x1c2b18); rect(ctx, 10, 5, 3, 2, 0x1c2b18); rect(ctx, 5, 11, 6, 1, 0x2f4a24); });
def('creeper_head', (ctx, rng) => { noise(ctx, rng, 0x4c9a3a, 0.11); rect(ctx, 3, 5, 3, 3, 0x101010); rect(ctx, 10, 5, 3, 3, 0x101010); rect(ctx, 6, 8, 4, 5, 0x101010); rect(ctx, 5, 9, 2, 3, 0x101010); rect(ctx, 9, 9, 2, 3, 0x101010); });
def('player_head', (ctx, rng) => { noise(ctx, rng, 0xb58a63, 0.07); rect(ctx, 2, 2, 12, 3, 0x3f2d1c); rect(ctx, 4, 6, 2, 2, 0x2a2a5a); rect(ctx, 10, 6, 2, 2, 0x2a2a5a); rect(ctx, 6, 10, 4, 1, 0x8a5c40); });
def('dragon_head', (ctx, rng) => { noise(ctx, rng, 0x1c1420, 0.12); rect(ctx, 3, 5, 3, 2, 0xc02090); rect(ctx, 10, 5, 3, 2, 0xc02090); rect(ctx, 4, 10, 8, 2, 0x2e2436); });
def('piglin_head', (ctx, rng) => { noise(ctx, rng, 0xd8a882, 0.07); rect(ctx, 3, 5, 3, 2, 0x2a2a2a); rect(ctx, 10, 5, 3, 2, 0x2a2a2a); rect(ctx, 5, 9, 6, 4, 0xc08a68); });

// --- redstone --------------------------------------------------------------
// Dust is greyscale: the mesher multiplies by a power-level tint.
def('redstone_dust_dot', (ctx) => { clear(ctx); rect(ctx, 6, 6, 4, 4, grey(235)); rect(ctx, 7, 7, 2, 2, grey(255)); });
def('redstone_dust_line0', (ctx, rng) => { clear(ctx); rect(ctx, 6, 0, 4, TILE, grey(225)); for (let y = 0; y < TILE; y++) px(ctx, 7 + rng.int(2), y, grey(255)); });
def('redstone_dust_line1', (ctx, rng) => { clear(ctx); rect(ctx, 0, 6, TILE, 4, grey(225)); for (let x = 0; x < TILE; x++) px(ctx, x, 7 + rng.int(2), grey(255)); });
def('redstone_dust_overlay', (ctx) => { clear(ctx); rect(ctx, 6, 6, 4, 4, grey(255), 0.7); });
def('repeater', (ctx, rng) => { noise(ctx, rng, 0xa8a8a8, 0.06); border(ctx, 0x8a8a8a, 0, 0.6); rect(ctx, 0, 7, TILE, 2, 0x6e1a1a); rect(ctx, 6, 3, 2, 3, 0x6e1a1a); rect(ctx, 6, 10, 2, 3, 0x6e1a1a); px(ctx, 6, 2, 0x8a2a2a); });
def('repeater_on', (ctx, rng) => { noise(ctx, rng, 0xb0a0a0, 0.06); border(ctx, 0x8a8a8a, 0, 0.6); rect(ctx, 0, 7, TILE, 2, 0xff2020); rect(ctx, 6, 3, 2, 3, 0xff2020); rect(ctx, 6, 10, 2, 3, 0xff2020); px(ctx, 6, 2, 0xff8080); });
def('comparator', (ctx, rng) => { noise(ctx, rng, 0xa8a8a8, 0.06); border(ctx, 0x8a8a8a, 0, 0.6); rect(ctx, 4, 3, 2, 3, 0x6e1a1a); rect(ctx, 10, 3, 2, 3, 0x6e1a1a); rect(ctx, 7, 10, 2, 3, 0x6e1a1a); rect(ctx, 0, 7, TILE, 2, 0x6e1a1a, 0.5); });
def('comparator_on', (ctx, rng) => { noise(ctx, rng, 0xb0a0a0, 0.06); border(ctx, 0x8a8a8a, 0, 0.6); rect(ctx, 4, 3, 2, 3, 0xff2020); rect(ctx, 10, 3, 2, 3, 0xff2020); rect(ctx, 7, 10, 2, 3, 0xff2020); rect(ctx, 0, 7, TILE, 2, 0xff2020, 0.5); });
def('lever', (ctx, rng) => { clear(ctx); rect(ctx, 5, 11, 6, 4, 0x7a7a7a); rect(ctx, 7, 4, 2, 8, 0x8b6a3f); rect(ctx, 6, 2, 4, 3, 0xa8a8a8); });
def('daylight_detector_top', (ctx, rng) => { noise(ctx, rng, 0x2b2b33, 0.08); border(ctx, 0x6a5030, 0); rect(ctx, 2, 2, 12, 12, 0x1c2b3a); for (let i = 0; i < 12; i++) px(ctx, 3 + rng.int(10), 3 + rng.int(10), 0x4a8ad8); });
def('daylight_detector_inverted_top', (ctx, rng) => { drawInto(ctx, 'daylight_detector_top'); rect(ctx, 2, 2, 12, 12, 0x0d1620, 0.6); });
def('daylight_detector_side', (ctx, rng) => { noise(ctx, rng, 0x6a5030, 0.09); rect(ctx, 0, 0, TILE, 4, 0x2b2b33); });
def('tripwire', (ctx) => { clear(ctx); rect(ctx, 0, 7, TILE, 1, 0xd8d8d8); });
def('tripwire_hook', (ctx) => { clear(ctx); rect(ctx, 6, 2, 4, 3, 0x8a8a8a); rect(ctx, 7, 5, 2, 5, 0x8b6a3f); rect(ctx, 5, 10, 6, 2, 0xa8a8a8); });
def('redstone_lamp', (ctx, rng) => { noise(ctx, rng, 0x5c4526, 0.09); for (let i = 0; i < 10; i++) px(ctx, 2 + rng.int(12), 2 + rng.int(12), 0x8a6a3a); border(ctx, 0x3a2b18, 0, 0.6); });
def('redstone_lamp_on', (ctx, rng) => { noise(ctx, rng, 0xd8a24a, 0.09); for (let i = 0; i < 12; i++) px(ctx, 2 + rng.int(12), 2 + rng.int(12), 0xffe08a); border(ctx, 0xa8752c, 0, 0.6); });
def('rail', (ctx) => {
  clear(ctx);
  rect(ctx, 3, 0, 2, TILE, 0xa8a8a8); rect(ctx, 11, 0, 2, TILE, 0xa8a8a8);
  for (let y = 1; y < TILE; y += 4) rect(ctx, 1, y, 14, 2, 0x6b4f2e);
});
def('rail_corner', (ctx) => {
  clear(ctx);
  rect(ctx, 3, 0, 2, 13, 0xa8a8a8); rect(ctx, 3, 11, 13, 2, 0xa8a8a8);
  for (let y = 1; y < 11; y += 4) rect(ctx, 1, y, 8, 2, 0x6b4f2e);
  for (let x = 5; x < TILE; x += 4) rect(ctx, x, 9, 2, 6, 0x6b4f2e);
});
def('powered_rail', (ctx) => { drawInto(ctx, 'rail'); rect(ctx, 6, 0, 4, TILE, 0x8a6a2a, 0.9); });
def('powered_rail_on', (ctx) => { drawInto(ctx, 'rail'); rect(ctx, 6, 0, 4, TILE, 0xd8a02a, 0.95); rect(ctx, 7, 0, 2, TILE, 0xff2020, 0.6); });
def('detector_rail', (ctx) => { drawInto(ctx, 'rail'); rect(ctx, 6, 3, 4, 10, 0x6a6a6a); });
def('detector_rail_on', (ctx) => { drawInto(ctx, 'rail'); rect(ctx, 6, 3, 4, 10, 0xff2020); });
def('activator_rail', (ctx) => { drawInto(ctx, 'rail'); rect(ctx, 5, 1, 6, 2, 0x4a4a4a); rect(ctx, 5, 12, 6, 2, 0x4a4a4a); });
def('activator_rail_on', (ctx) => { drawInto(ctx, 'rail'); rect(ctx, 5, 1, 6, 2, 0xff2020); rect(ctx, 5, 12, 6, 2, 0xff2020); });
def('iron_door_top', (ctx, rng) => { noise(ctx, rng, 0xc0c0c0, 0.05); border(ctx, 0x8a8a8a, 0); rect(ctx, 3, 2, 10, 6, 0x9a9a9a); rect(ctx, 4, 3, 8, 4, 0xc8e0ea, 0.5); px(ctx, 12, 12, 0x6a6a6a); });
def('iron_door_bottom', (ctx, rng) => { noise(ctx, rng, 0xc0c0c0, 0.05); border(ctx, 0x8a8a8a, 0); rect(ctx, 3, 3, 10, 10, 0xb0b0b0); border(ctx, 0x8a8a8a, 3); px(ctx, 12, 3, 0x6a6a6a); });
def('iron_trapdoor', (ctx, rng) => { clear(ctx); rect(ctx, 0, 0, TILE, 3, 0xc0c0c0); rect(ctx, 0, 13, TILE, 3, 0xc0c0c0); rect(ctx, 0, 3, 3, 10, 0xc0c0c0); rect(ctx, 13, 3, 3, 10, 0xc0c0c0); rect(ctx, 3, 6, 10, 2, 0xa0a0a0); rect(ctx, 3, 9, 10, 2, 0xa0a0a0); border(ctx, 0x8a8a8a, 0); });

// --- animated textures -----------------------------------------------------
/** Registers `frames` numbered tiles plus an ANIMATED entry and a base alias. */
function defineAnimated(base, frames, fps, drawFrame) {
  const idx = [];
  for (let f = 0; f < frames; f++) {
    idx.push(def(base + '_' + f, (ctx, rng, s) => drawFrame(ctx, rng, f / frames, f, s)));
  }
  ANIMATED[base] = { frames: idx, fps };
  defineAlias(base, base + '_0');
  return idx;
}

defineAnimated('water_still', 16, 12, (ctx, rng, t) => {
  perPixel(ctx, (x, y, out) => {
    const w = Math.sin((x / TILE + t) * Math.PI * 2) * 0.5
            + Math.sin((y / TILE * 2 - t * 1.7) * Math.PI * 2) * 0.3
            + Math.sin(((x + y) / TILE - t * 2.3) * Math.PI * 2) * 0.2;
    const v = 206 + w * 36;
    out[0] = v; out[1] = v; out[2] = v; out[3] = 210;
  });
});
defineAnimated('water_flow', 16, 16, (ctx, rng, t) => {
  perPixel(ctx, (x, y, out) => {
    const s = (y / TILE + t * 2) % 1;
    const w = Math.sin((x / TILE * 3 + s * 4) * Math.PI * 2) * 0.4 + Math.sin(s * Math.PI * 2) * 0.35;
    const v = 200 + w * 44;
    out[0] = v; out[1] = v; out[2] = v; out[3] = 214;
  });
});
defineAnimated('lava_still', 16, 6, (ctx, rng, t) => {
  perPixel(ctx, (x, y, out) => {
    const w = Math.sin((x / TILE * 1.5 + t) * Math.PI * 2) * 0.5
            + Math.sin((y / TILE * 1.7 - t * 1.3) * Math.PI * 2) * 0.4
            + Math.sin(((x * 0.7 + y * 1.3) / TILE + t * 0.8) * Math.PI * 2) * 0.3;
    const k = clamp(0.5 + w * 0.45, 0, 1);
    const c = k < 0.45 ? mix(0x8f2b06, 0xd45b12, k / 0.45) : mix(0xd45b12, 0xffd046, (k - 0.45) / 0.55);
    out[0] = cr(c); out[1] = cg(c); out[2] = cb(c); out[3] = 255;
  });
});
defineAnimated('lava_flow', 16, 8, (ctx, rng, t) => {
  perPixel(ctx, (x, y, out) => {
    const s = (y / TILE + t * 2) % 1;
    const w = Math.sin((x / TILE * 2 + s * 3) * Math.PI * 2) * 0.5 + Math.sin(s * Math.PI * 4) * 0.3;
    const k = clamp(0.5 + w * 0.5, 0, 1);
    const c = k < 0.5 ? mix(0x7c2405, 0xd45b12, k / 0.5) : mix(0xd45b12, 0xffc23c, (k - 0.5) / 0.5);
    out[0] = cr(c); out[1] = cg(c); out[2] = cb(c); out[3] = 255;
  });
});
const fireFrame = (hot, mid, cool) => (ctx, rng, t) => {
  clear(ctx);
  for (let x = 0; x < TILE; x++) {
    const phase = (x / TILE) * Math.PI * 2;
    const h = 7 + Math.round(Math.sin(phase * 2 + t * Math.PI * 2) * 3 + Math.sin(phase * 5 - t * Math.PI * 4) * 2);
    for (let y = 0; y < h; y++) {
      const k = y / Math.max(1, h - 1);
      px(ctx, x, 15 - y, k < 0.35 ? hot : k < 0.7 ? mid : cool, k > 0.85 ? 0.6 : 1);
    }
  }
};
defineAnimated('fire_0', 16, 15, fireFrame(0xffd257, 0xf08a1c, 0xd0401c));
defineAnimated('fire_1', 16, 15, fireFrame(0xffe08a, 0xffa02c, 0xc0301c));
defineAnimated('soul_fire_0', 16, 15, fireFrame(0xd8fbff, 0x5ee0e8, 0x1c6f9a));
defineAnimated('soul_fire_1', 16, 15, fireFrame(0xeaffff, 0x7cf0f8, 0x1c5f8a));
defineAnimated('nether_portal', 16, 10, (ctx, rng, t) => {
  perPixel(ctx, (x, y, out) => {
    const dx = x - 7.5, dy = y - 7.5;
    const r = Math.sqrt(dx * dx + dy * dy) / 11;
    const a = Math.atan2(dy, dx);
    const w = Math.sin((r * 6 - t * Math.PI * 2 + a * 2)) * 0.5 + 0.5;
    const c = mix(0x3b1263, 0xb46fe8, w);
    out[0] = cr(c); out[1] = cg(c); out[2] = cb(c);
    out[3] = 150 + w * 90;
  });
});
defineAnimated('end_portal', 8, 6, (ctx, rng, t) => {
  perPixel(ctx, (x, y, out) => { out[0] = 4; out[1] = 2; out[2] = 12; out[3] = 255; });
  for (let i = 0; i < 26; i++) {
    const x = rng.int(TILE), y = rng.int(TILE);
    px(ctx, x, y, rng.next() < 0.3 ? 0x9fe8d8 : 0x5a3f8a, 0.5 + rng.next() * 0.5);
  }
});
defineAnimated('prismarine', 8, 4, (ctx, rng, t) => {
  perPixel(ctx, (x, y, out) => {
    const w = Math.sin((x / TILE * 2 + t) * Math.PI * 2) * 0.5 + Math.sin((y / TILE * 2 - t) * Math.PI * 2) * 0.5;
    const c = mix(0x5a9c8c, 0x7ec4ae, clamp(0.5 + w * 0.35, 0, 1));
    out[0] = cr(c); out[1] = cg(c); out[2] = cb(c); out[3] = 255;
  });
});
defineAnimated('sea_lantern', 6, 4, (ctx, rng, t) => {
  noise(ctx, rng, 0xafd8cd, 0.05);
  for (let ty = 0; ty < 2; ty++) for (let tx = 0; tx < 2; tx++) {
    const b = 0.6 + 0.4 * Math.sin((t + (tx + ty) * 0.25) * Math.PI * 2);
    rect(ctx, tx * 8 + 1, ty * 8 + 1, 6, 6, mix(0x9dc6ba, 0xf4ffff, b));
  }
  border(ctx, 0x7fb0a3, 0, 0.7);
});
defineAnimated('magma', 8, 5, (ctx, rng, t) => {
  noise(ctx, rng, 0x30160c, 0.14);
  for (let i = 0; i < 22; i++) {
    const x = rng.int(TILE), y = rng.int(TILE);
    const b = 0.5 + 0.5 * Math.sin((t + i * 0.13) * Math.PI * 2);
    rect(ctx, x, y, 2, 2, mix(0x8e3a13, 0xffb03c, b));
  }
});

// --- block breaking overlay ------------------------------------------------
for (let s = 0; s < 10; s++) {
  def('destroy_stage_' + s, (ctx, rng) => {
    clear(ctx);
    crackOverlay(ctx, rng, 0x000000, 1 + s * 2);
    if (s > 4) crackOverlay(ctx, rng, 0x1a1a1a, s);
  });
}

// ===========================================================================
// ITEMS
// ===========================================================================
const TOOL_KINDS = ['sword', 'pickaxe', 'axe', 'shovel', 'hoe'];
for (const mat of ['wooden', 'stone', 'iron', 'golden', 'diamond', 'netherite']) {
  const pal = toolPalette(TOOL_MATERIAL[mat]);
  for (const k of TOOL_KINDS) def(mat + '_' + k, item(SPR[k], pal));
}
for (const mat of ['leather', 'chainmail', 'iron', 'golden', 'diamond', 'netherite']) {
  const pal = toolPalette(TOOL_MATERIAL[mat]);
  def(mat + '_helmet', item(SPR.helmet, pal));
  def(mat + '_chestplate', item(SPR.chestplate, pal));
  def(mat + '_leggings', item(SPR.leggings, pal));
  def(mat + '_boots', item(SPR.boots, pal));
}
def('turtle_helmet', item(SPR.helmet, toolPalette(TOOL_MATERIAL.turtle)));
def('turtle_scute', item(SPR.gem, { M: 0x5eae4d, m: 0x3d7a33, W: 0x8fd07c }));
defineAlias('scute', 'turtle_scute');
def('elytra', item(SPR.elytra, { M: 0xb0a8b0, m: 0x7c7480 }));

// --- generic lump / powder items -------------------------------------------
const lumpItem = (c, blobs = 4) => (ctx, rng) => {
  clear(ctx);
  const spots = [[4, 4, 5, 5], [8, 6, 5, 6], [3, 9, 5, 5], [9, 3, 4, 4], [6, 10, 5, 4]];
  for (let i = 0; i < blobs; i++) {
    const [x, y, w, h] = spots[i % spots.length];
    rect(ctx, x, y, w, h, jit(rng, c, 0.13));
    px(ctx, x, y, shade(c, 1.3));
    px(ctx, x + w - 1, y + h - 1, shade(c, 0.7));
  }
  outline(ctx, 0x1c1710, 0.9);
};
const gemItem = (c) => item(SPR.gem, { M: c, m: shade(c, 0.68), W: mix(c, 0xffffff, 0.65) });
const ingotItem = (c) => item(SPR.ingot, { M: c, m: shade(c, 0.68), l: mix(c, 0xffffff, 0.5) });
const nuggetItem = (c) => item(SPR.nugget, { M: c, m: shade(c, 0.68), l: mix(c, 0xffffff, 0.5) });

def('iron_ingot', ingotItem(0xd8d8d8));
def('gold_ingot', ingotItem(0xfcee4b));
def('copper_ingot', ingotItem(0xc16f4e));
def('netherite_ingot', ingotItem(0x594f57));
def('netherite_scrap', lumpItem(0x6b5c56, 4));
def('iron_nugget', nuggetItem(0xd8d8d8));
def('gold_nugget', nuggetItem(0xfcee4b));
def('diamond', gemItem(0x4aedd9));
def('emerald', gemItem(0x17dd62));
def('lapis_lazuli', gemItem(0x2b53a8));
def('quartz', gemItem(0xece5dd));
def('amethyst_shard', item(SPR.shard, { M: 0x9b6fd6, m: 0x6f47a6 }));
def('prismarine_shard', item(SPR.shard, { M: 0x9ad2c0, m: 0x63a08e }));
def('prismarine_crystals', item(SPR.shard, { M: 0xd4f0e0, m: 0x8fc0ad }));
def('echo_shard', item(SPR.shard, { M: 0x2f7f8a, m: 0x14434c }));
def('nether_star', item(SPR.star, { M: 0xf5f5d0 }, 0x8a8a6a));
def('coal', lumpItem(0x1b1b1b, 4));
def('charcoal', lumpItem(0x2e2620, 4));
def('raw_iron', lumpItem(0xd6a17a, 4));
def('raw_gold', lumpItem(0xf0c542, 4));
def('raw_copper', lumpItem(0xc98a63, 4));
def('flint', item(SPR.gem, { M: 0x4a4a4a, m: 0x2b2b2b, W: 0x7a7a7a }));
def('clay_ball', lumpItem(0xa4a8b8, 3));
def('brick', (ctx, rng) => { clear(ctx); rect(ctx, 2, 5, 12, 6, 0x9a5b4a); for (let i = 0; i < 8; i++) px(ctx, 3 + rng.int(10), 6 + rng.int(4), jit(rng, 0x9a5b4a, 0.16)); outline(ctx, 0x2a1a14, 0.9); });
def('nether_brick', (ctx, rng) => { clear(ctx); rect(ctx, 2, 5, 12, 6, 0x3d2124); for (let i = 0; i < 8; i++) px(ctx, 3 + rng.int(10), 6 + rng.int(4), jit(rng, 0x3d2124, 0.16)); outline(ctx, 0x160b0d, 0.9); });
def('gunpowder', (ctx, rng) => drawDyePile(ctx, rng, 0x6b6b6b));
def('redstone', (ctx, rng) => drawDyePile(ctx, rng, 0xd42121));
def('glowstone_dust', (ctx, rng) => drawDyePile(ctx, rng, 0xf9d68f));
def('sugar', (ctx, rng) => drawDyePile(ctx, rng, 0xf5f5f5));
def('blaze_powder', (ctx, rng) => drawDyePile(ctx, rng, 0xf0a020));
def('bone_meal', (ctx, rng) => drawDyePile(ctx, rng, 0xe8e8dc));
def('blaze_rod', item(SPR.rod, { M: 0xf0c020, m: 0xc08a10 }));
def('breeze_rod', item(SPR.rod, { M: 0x9cc4e0, m: 0x5f86a8 }));
def('stick', item(SPR.stickspr, { M: STICK_A, m: STICK_B }));
def('bone', item(SPR.bone, { M: 0xe3e0d2 }, 0x8a887c));
def('string', (ctx, rng) => { clear(ctx); for (let i = 0; i < 3; i++) { let x = 2 + i * 4, y = 2; for (let k = 0; k < 12; k++) { px(ctx, x, y + k, 0xe8e8e8); if (rng.next() < 0.4) x += rng.bool() ? 1 : -1; } } });
def('feather', item(SPR.feather, { M: 0xd8d8d8, W: 0xffffff }));
def('leather', (ctx, rng) => { clear(ctx); rect(ctx, 2, 3, 12, 10, 0xa06540); for (let i = 0; i < 10; i++) px(ctx, 3 + rng.int(10), 4 + rng.int(8), jit(rng, 0xa06540, 0.16)); rect(ctx, 4, 5, 8, 6, 0xb87a53); outline(ctx, 0x3a2415, 0.9); });
def('rabbit_hide', (ctx, rng) => { clear(ctx); rect(ctx, 2, 4, 12, 8, 0xd8b898); for (let i = 0; i < 8; i++) px(ctx, 3 + rng.int(10), 5 + rng.int(6), 0xc0a080); outline(ctx, 0x4a3a2a, 0.9); });
def('rabbit_foot', (ctx, rng) => { clear(ctx); rect(ctx, 6, 2, 4, 8, 0xc4a484); rect(ctx, 4, 9, 8, 5, 0xd8bda0); px(ctx, 5, 13, 0xa88c70); outline(ctx, 0x3a2c1e, 0.9); });
def('phantom_membrane', (ctx, rng) => { clear(ctx); for (let y = 3; y < 13; y++) rect(ctx, 3 + ((y - 3) >> 1), y, 10 - (y - 3), 1, 0xd8cfc0); outline(ctx, 0x5a5348, 0.9); });
def('nautilus_shell', (ctx, rng) => { clear(ctx); circle(ctx, 8, 8, 6, 0xe8dcc8); for (let i = 0; i < 5; i++) ring(ctx, 8, 8, 1.5 + i * 1.2, 0xb89a78, 0.5); outline(ctx, 0x4a4034, 0.9); });
def('heart_of_the_sea', (ctx, rng) => { clear(ctx); circle(ctx, 8, 8, 6, 0x2f6f7a); circle(ctx, 8, 8, 4, 0x4fa8b8); circle(ctx, 8, 8, 2, 0xa8e8f0); outline(ctx, 0x143038, 0.9); });
def('shulker_shell', (ctx, rng) => { clear(ctx); rect(ctx, 3, 4, 10, 8, 0x9a6f9a); rect(ctx, 4, 3, 8, 2, 0xb98cb9); rect(ctx, 5, 7, 6, 3, 0x6f4f6f); outline(ctx, 0x2e202e, 0.9); });
def('honeycomb', (ctx, rng) => { clear(ctx); for (let y = 3; y < 13; y += 4) for (let x = 3 + ((y & 4) ? 2 : 0); x < 13; x += 5) rect(ctx, x, y, 4, 3, 0xe0a92c); outline(ctx, 0x6a4a10, 0.9); });
def('ink_sac', lumpItem(0x1d1d21, 3));
def('glow_ink_sac', lumpItem(0x1f8f9c, 3));
def('slime_ball', (ctx, rng) => { clear(ctx); circle(ctx, 8, 8, 6, 0x77c265); circle(ctx, 8, 8, 4, 0x93d67f); px(ctx, 6, 5, 0xc8f0b8); outline(ctx, 0x3d6a33, 0.9); });
def('snowball', (ctx, rng) => { clear(ctx); circle(ctx, 8, 8, 5.5, 0xf0fafa); circle(ctx, 7, 7, 3, 0xffffff); outline(ctx, 0x8fa8b0, 0.9); });
def('egg', (ctx, rng) => { clear(ctx); sprite(ctx, SPR.egg, { B: 0xe8e0d0 }); speckle(ctx, rng, 0xc8bda8, 6); outline(ctx, 0x6a6050, 0.9); });
def('ender_pearl', item(SPR.pearl, { M: 0x1c6f66, W: 0x7fe0cf, m: 0x0f4a44 }));
def('ender_eye', item(SPR.pearl, { M: 0x18a06a, W: 0xd0f0a8, m: 0x0c6a44 }));
def('ghast_tear', item(SPR.pearl, { M: 0xd8e8e8, W: 0xffffff, m: 0xa8c0c0 }));
def('magma_cream', item(SPR.pearl, { M: 0xd06a1c, W: 0xffc25a, m: 0x8a3d0c }));
def('spider_eye', (ctx, rng) => { clear(ctx); circle(ctx, 8, 8, 5.5, 0x8a2020); circle(ctx, 8, 8, 3, 0xd03030); circle(ctx, 8, 8, 1.4, 0x2a0a0a); outline(ctx, 0x3a0f0f, 0.9); });
def('fermented_spider_eye', (ctx, rng) => { clear(ctx); circle(ctx, 8, 8, 5.5, 0x5a7a3a); circle(ctx, 8, 8, 3, 0x8aa050); circle(ctx, 8, 8, 1.4, 0x2a2a10); outline(ctx, 0x243015, 0.9); });
def('rotten_flesh', item(SPR.meat, { M: 0x7a5a4a, m: 0x543c30, l: 0x9c7860 }));
def('wheat', (ctx, rng) => { clear(ctx); for (const x of [3, 7, 11]) { rect(ctx, x, 4, 1, 11, 0xd8c25a); for (let y = 4; y < 12; y += 2) { px(ctx, x - 1, y, 0xe8d67a); px(ctx, x + 1, y + 1, 0xbfa840); } } outline(ctx, 0x6a5c22, 0.85); });
def('wheat_seeds', (ctx, rng) => drawSeeds(ctx, rng, 0x8a9a3a));
def('melon_seeds', (ctx, rng) => drawSeeds(ctx, rng, 0xd8d0a8));
def('pumpkin_seeds', (ctx, rng) => drawSeeds(ctx, rng, 0xe0d8b0));
def('beetroot_seeds', (ctx, rng) => drawSeeds(ctx, rng, 0x9a4a5a));
def('torchflower_seeds', (ctx, rng) => drawSeeds(ctx, rng, 0xd08a3a));
def('pitcher_pod', (ctx, rng) => drawSeeds(ctx, rng, 0xa04a8f));
def('nether_wart', (ctx, rng) => { clear(ctx); circle(ctx, 8, 9, 5, 0x9a1a20); circle(ctx, 8, 9, 3, 0xc02a30); speckle(ctx, rng, 0x6a0c10, 6); outline(ctx, 0x3a0708, 0.9); });
def('disc_fragment_5', (ctx, rng) => { clear(ctx); sprite(ctx, SPR.shard, { M: 0x2a2a2a, m: 0x141414 }); outline(ctx, 0x0a0a0a, 0.9); });

// --- foods -----------------------------------------------------------------
const meatItem = (m, dark, light) => item(SPR.meat, { M: m, m: dark, l: light });
def('apple', item(SPR.apple, { M: 0xd32f2f, W: 0xf08080, L: 0x4f8f2c, h: 0x6b4f2e }));
def('golden_apple', item(SPR.apple, { M: 0xfcd94b, W: 0xfff3a8, L: 0x4f8f2c, h: 0x6b4f2e }));
def('enchanted_golden_apple', (ctx, rng) => { clear(ctx); sprite(ctx, SPR.apple, { M: 0xfcd94b, W: 0xfff3a8, L: 0x4f8f2c, h: 0x6b4f2e }); speckle(ctx, rng, 0xd0a8ff, 8, 1, 0.75); outline(ctx, 0x5a4a10, 0.9); });
def('bread', item(SPR.bread, { M: 0xc08a3c, m: 0x8f6320, l: 0xe0b060 }));
def('cookie', (ctx, rng) => { clear(ctx); circle(ctx, 8, 8, 6, 0xc08a4a); for (const [x, y] of [[5, 6], [9, 5], [7, 9], [11, 9], [4, 10]]) px(ctx, x, y, 0x4a2c14); outline(ctx, 0x5c3a18, 0.9); });
def('pumpkin_pie', (ctx, rng) => { clear(ctx); rect(ctx, 2, 5, 12, 8, 0xd8a03c); rect(ctx, 3, 4, 10, 2, 0xe8c070); speckle(ctx, rng, 0xa86a20, 8); outline(ctx, 0x5c3f10, 0.9); });
def('cake', (ctx, rng) => { clear(ctx); rect(ctx, 2, 6, 12, 7, 0xd8b878); rect(ctx, 2, 4, 12, 3, 0xf0f0f0); for (const x of [4, 8, 12]) px(ctx, x, 5, 0xd02040); outline(ctx, 0x6a5030, 0.9); });
def('porkchop', meatItem(0xf0a0a0, 0xc06060, 0xffc8c8));
def('cooked_porkchop', meatItem(0xd08a4a, 0x9a5a2c, 0xe8b070));
def('beef', meatItem(0xc04040, 0x8a2424, 0xdc6a6a));
def('cooked_beef', meatItem(0x9a5a2c, 0x6b3a18, 0xbf8048));
def('chicken', meatItem(0xf0c0a0, 0xc08a68, 0xffdcc0));
def('cooked_chicken', meatItem(0xd0a04a, 0xa06f28, 0xe8c070));
def('mutton', meatItem(0xd06060, 0x9a3838, 0xe89090));
def('cooked_mutton', meatItem(0xa06030, 0x743d18, 0xc08048));
def('rabbit', meatItem(0xd07070, 0x9a4444, 0xe8a0a0));
def('cooked_rabbit', meatItem(0xb07040, 0x804820, 0xd09858));
def('cod', item(SPR.fish, { M: 0xc0b090, m: 0x8f8168, l: 0xdfd2b4, W: 0x2a2a2a }));
def('cooked_cod', item(SPR.fish, { M: 0xd8a86a, m: 0xa87c44, l: 0xf0cc94, W: 0x2a2a2a }));
def('salmon', item(SPR.fish, { M: 0xd06a4a, m: 0x9a462c, l: 0xef9070, W: 0x2a2a2a }));
def('cooked_salmon', item(SPR.fish, { M: 0xe08a4a, m: 0xa85e28, l: 0xf6b078, W: 0x2a2a2a }));
def('tropical_fish', item(SPR.fish, { M: 0xf0a020, m: 0xd04020, l: 0xffe060, W: 0x2a2a2a }));
def('pufferfish', (ctx, rng) => { clear(ctx); circle(ctx, 8, 8, 6, 0xf0c020); circle(ctx, 8, 8, 4, 0xffe060); for (let i = 0; i < 10; i++) { const a = (i / 10) * Math.PI * 2; px(ctx, 8 + Math.cos(a) * 7, 8 + Math.sin(a) * 7, 0xc08010); } px(ctx, 6, 6, 0x2a2a2a); px(ctx, 10, 6, 0x2a2a2a); outline(ctx, 0x6a5210, 0.9); });
def('carrot', item(SPR.carrot, { M: 0xe8811d, L: 0x4f8f2c }));
def('golden_carrot', item(SPR.carrot, { M: 0xfcd94b, L: 0x4f8f2c }));
def('potato', item(SPR.potato, { M: 0xd8c470, m: 0xa89840 }));
def('baked_potato', item(SPR.potato, { M: 0xc08a3c, m: 0x8f6320 }));
def('poisonous_potato', item(SPR.potato, { M: 0xa8c470, m: 0x6f8840 }));
def('beetroot', (ctx, rng) => { clear(ctx); circle(ctx, 8, 10, 4.5, 0xa02a3c); rect(ctx, 7, 2, 2, 5, 0x4f8f2c); rect(ctx, 5, 2, 6, 2, 0x62a838); outline(ctx, 0x3a1018, 0.9); });
def('melon_slice', (ctx, rng) => { clear(ctx); for (let y = 3; y < 14; y++) { const w = 12 - Math.abs(y - 8); rect(ctx, 8 - (w >> 1), y, w, 1, y < 5 ? 0x4f8f2c : 0xd8404a); } rect(ctx, 3, 3, 10, 2, 0x4f8f2c); speckle(ctx, rng, 0x2a2a2a, 5); outline(ctx, 0x2a3a14, 0.9); });
def('glistering_melon_slice', (ctx, rng) => { drawInto(ctx, 'melon_slice'); speckle(ctx, rng, 0xfcee4b, 10); });
def('sweet_berries', (ctx, rng) => { clear(ctx); for (const [x, y] of [[4, 6], [9, 5], [6, 10]]) { circle(ctx, x + 2, y + 2, 2.6, 0xd0323c); px(ctx, x + 1, y + 1, 0xf07078); } outline(ctx, 0x4a1018, 0.9); });
def('glow_berries', (ctx, rng) => { clear(ctx); for (const [x, y] of [[4, 6], [9, 5], [6, 10]]) { circle(ctx, x + 2, y + 2, 2.6, 0xffa726); px(ctx, x + 1, y + 1, 0xffe08a); } outline(ctx, 0x6a4210, 0.9); });
def('dried_kelp', (ctx, rng) => { clear(ctx); rect(ctx, 3, 3, 10, 10, 0x35402a); for (let i = 0; i < 10; i++) px(ctx, 4 + rng.int(8), 4 + rng.int(8), 0x23301c); outline(ctx, 0x141a10, 0.9); });
def('chorus_fruit', (ctx, rng) => { clear(ctx); circle(ctx, 8, 8, 5.5, 0x8b5d8b); circle(ctx, 7, 7, 3, 0xb27fb2); outline(ctx, 0x3a223a, 0.9); });
def('popped_chorus_fruit', (ctx, rng) => { clear(ctx); circle(ctx, 8, 8, 5, 0xc08a5a); speckle(ctx, rng, 0x8f6338, 8); outline(ctx, 0x4a3018, 0.9); });
const bowlPal = (soup) => ({ S: soup, B: 0xa0663a });
def('bowl', item(SPR.bowl, { S: 0xa0663a, B: 0xa0663a }));
def('mushroom_stew', item(SPR.bowl, bowlPal(0xb08a5a)));
def('rabbit_stew', item(SPR.bowl, bowlPal(0xa8582c)));
def('beetroot_soup', item(SPR.bowl, bowlPal(0xa02a3c)));
def('suspicious_stew', item(SPR.bowl, bowlPal(0xc08a4a)));
def('milk_bucket', item(SPR.bucket, { M: 0xc4c4c4, F: 0xf8f8f8 }));
def('bucket', item(SPR.bucket, { M: 0xc4c4c4, F: 0xdcdcdc }));
def('water_bucket', item(SPR.bucket, { M: 0xc4c4c4, F: 0x3f76e4 }));
def('lava_bucket', item(SPR.bucket, { M: 0xc4c4c4, F: 0xd45b12 }));
def('powder_snow_bucket', item(SPR.bucket, { M: 0xc4c4c4, F: 0xf0fafa }));
def('cod_bucket', item(SPR.bucket, { M: 0xc4c4c4, F: 0x6a9ad8 }));
def('salmon_bucket', item(SPR.bucket, { M: 0xc4c4c4, F: 0xd06a4a }));
def('tropical_fish_bucket', item(SPR.bucket, { M: 0xc4c4c4, F: 0xf0a020 }));
def('pufferfish_bucket', item(SPR.bucket, { M: 0xc4c4c4, F: 0xf0c020 }));
def('axolotl_bucket', item(SPR.bucket, { M: 0xc4c4c4, F: 0xf0a8d0 }));
def('tadpole_bucket', item(SPR.bucket, { M: 0xc4c4c4, F: 0x5c4a3a }));

// --- bottles & potions ------------------------------------------------------
def('glass_bottle', item(SPR.bottle, { C: 0xc8dcdc, L: 0xdcefef }));
def('potion', item(SPR.bottle, { C: 0xc8dcdc, L: 0xb04ad6 }));
def('splash_potion', item(SPR.bottle, { C: 0xa8c0c0, L: 0xb04ad6 }));
def('lingering_potion', item(SPR.bottle, { C: 0x8fa8a8, L: 0xb04ad6 }));
def('potion_overlay', (ctx) => { clear(ctx); sprite(ctx, SPR.bottle, { L: 0xffffff, C: null }); });
def('dragon_breath', item(SPR.bottle, { C: 0xc8dcdc, L: 0xd04ad6 }));
def('experience_bottle', item(SPR.bottle, { C: 0xc8dcdc, L: 0x9fe83c }));
def('honey_bottle', item(SPR.bottle, { C: 0xc8dcdc, L: 0xe09a2c }));
def('ominous_bottle', item(SPR.bottle, { C: 0x8a7f9a, L: 0x3a2f4a }));

// --- tools, gadgets, transport ---------------------------------------------
def('shears', item(SPR.shears, { M: 0xd8d8d8, G: 0xa0a0a0, H: 0x6a6a6a }));
def('flint_and_steel', item(SPR.flintsteel, { M: 0xd8d8d8, G: 0x8a8a8a }));
def('fishing_rod', item(SPR.fishingrod, { M: 0x8b6a3f, S: 0xe8e8e8, W: 0xd8d8d8 }));
def('carrot_on_a_stick', (ctx, rng) => { clear(ctx); sprite(ctx, SPR.fishingrod, { M: 0x8b6a3f, S: 0xe8e8e8, W: 0xe8811d }); outline(ctx, 0x21160c, 0.85); });
def('warped_fungus_on_a_stick', (ctx, rng) => { clear(ctx); sprite(ctx, SPR.fishingrod, { M: 0x8b6a3f, S: 0xe8e8e8, W: 0x1f9c95 }); outline(ctx, 0x21160c, 0.85); });
def('bow', item(SPR.bow, { M: 0x8b6a3f, S: 0xe8e8e8 }));
def('crossbow', item(SPR.crossbow, { M: 0x8b6a3f, S: 0xe8e8e8, H: 0x6b4f2e }));
def('arrow', item(SPR.arrow, { T: 0x9a9a9a, s: 0x8b6a3f, F: 0xf0f0f0 }));
def('spectral_arrow', item(SPR.arrow, { T: 0xfcd94b, s: 0xd8b83c, F: 0xfff3a8 }));
def('tipped_arrow', item(SPR.arrow, { T: 0x9a9a9a, s: 0x8b6a3f, F: 0xd07adf }));
def('trident', item(SPR.trident, { M: 0x3f7a7a, H: 0x2a5a5a }));
def('shield', item(SPR.shield, { M: 0x8b6a3f, S: 0xc0c0c0, W: 0xd8d8d8 }));
def('totem_of_undying', item(SPR.totem, { M: 0xdfc02c, m: 0x8f6a10 }));
def('spyglass', item(SPR.spyglass, { M: 0xb8b8b8, C: 0xc16f4e }));
def('name_tag', item(SPR.nametag, { M: 0xd8c8a8, m: 0x9a8a6a }));
def('lead', (ctx, rng) => { clear(ctx); for (let i = 0; i < 14; i++) px(ctx, 3 + ((i * 7) % 9), 1 + i, 0xa08050); rect(ctx, 9, 2, 4, 4, 0x8a6a3f); outline(ctx, 0x3a2c18, 0.85); });
def('saddle', item(SPR.saddle, { M: 0x8a5a2c, m: 0x5c3a18 }));
def('compass', item(SPR.compass, { M: 0xc0c0c0, S: 0x2a3a5a, R: 0xd02020, W: 0xf0f0f0 }));
def('recovery_compass', item(SPR.compass, { M: 0x2f5f6a, S: 0x14232a, R: 0x2fd1c0, W: 0xa8f0e8 }));
def('clock', item(SPR.clock, { M: 0xfcd94b, W: 0x3f76e4, m: 0x1a1a2a }));
def('map', item(SPR.map, { M: 0xa0783c, W: 0xe4d8ac, g: 0x9aa860 }));
def('filled_map', item(SPR.map, { M: 0xa0783c, W: 0xe4d8ac, g: 0x6a9ad8 }));
def('book', item(SPR.book, { M: 0x9a4a2c, P: 0xe8e0c8, W: 0xf8f4e4 }));
def('writable_book', item(SPR.book, { M: 0x3f6a9a, P: 0xe8e0c8, W: 0xf8f4e4 }));
def('written_book', item(SPR.book, { M: 0x2c4a9a, P: 0xe8e0c8, W: 0xf8f4e4 }));
def('knowledge_book', item(SPR.book, { M: 0x2c8a4a, P: 0xe8e0c8, W: 0xf8f4e4 }));
def('enchanted_book', (ctx, rng) => { clear(ctx); sprite(ctx, SPR.book, { M: 0xc02c8a, P: 0xf0e8d0, W: 0xfff8e8 }); speckle(ctx, rng, 0xd0a8ff, 10, 1, 0.7); outline(ctx, 0x2a1020, 0.9); });
def('paper', item(SPR.paper, { W: 0xf0f0e8, g: 0xc8c8c0 }));
def('brush', item(SPR.brushspr, { M: 0xc16f4e, C: 0xd8d8d8, H: 0x8b6a3f, W: 0xf0e8d0 }));
def('goat_horn', item(SPR.horn, { M: 0xe8e0cc }, 0x8a8272));
def('firework_rocket', (ctx, rng) => { clear(ctx); rect(ctx, 6, 3, 4, 9, 0xd8d8d8); rect(ctx, 6, 3, 4, 3, 0xd02020); rect(ctx, 7, 12, 2, 4, 0x8b6a3f); px(ctx, 8, 1, 0xfcd94b); outline(ctx, 0x2a2a2a, 0.9); });
def('firework_star', (ctx, rng) => { clear(ctx); circle(ctx, 8, 8, 5, 0xd8d8d8); for (let i = 0; i < 8; i++) { const a = (i / 8) * Math.PI * 2; px(ctx, 8 + Math.cos(a) * 6.5, 8 + Math.sin(a) * 6.5, 0xfcd94b); } circle(ctx, 8, 8, 2, 0xd02020); outline(ctx, 0x3a3a3a, 0.9); });
def('end_crystal', (ctx, rng) => { clear(ctx); for (let y = 2; y < 14; y++) { const w = 10 - Math.abs(y - 8); rect(ctx, 8 - (w >> 1), y, w, 1, 0xd8b0f0, 0.85); } circle(ctx, 8, 8, 2, 0xf0e0ff); outline(ctx, 0x5a3a70, 0.85); });
def('armor_stand', (ctx, rng) => { clear(ctx); rect(ctx, 7, 2, 2, 10, 0xc2a26a); rect(ctx, 3, 5, 10, 2, 0xc2a26a); rect(ctx, 4, 12, 8, 2, 0x9d8050); rect(ctx, 6, 0, 4, 2, 0x9d8050); outline(ctx, 0x4e3b22, 0.85); });
def('item_frame', (ctx, rng) => { clear(ctx); border(ctx, 0x8b6a3f, 1); border(ctx, 0xa07b4b, 2); rect(ctx, 4, 4, 8, 8, 0xd8c8a8); });
def('glow_item_frame', (ctx, rng) => { clear(ctx); border(ctx, 0x2f8f8a, 1); border(ctx, 0x49c4bd, 2); rect(ctx, 4, 4, 8, 8, 0xa8f0e8); });
def('painting', (ctx, rng) => { clear(ctx); border(ctx, 0x8b6a3f, 1); border(ctx, 0x6b4f2e, 2); rect(ctx, 4, 4, 8, 8, 0x3f6a9a); rect(ctx, 5, 8, 6, 3, 0x4f8f2c); });
for (const [n, c] of [['iron_horse_armor', 0xd8d8d8], ['golden_horse_armor', 0xfcee4b], ['diamond_horse_armor', 0x4aedd9], ['leather_horse_armor', 0xa06540]]) {
  def(n, item(SPR.horsearmor, { M: c, m: shade(c, 0.7) }));
}
for (const w of ['oak', 'spruce', 'birch', 'jungle', 'acacia', 'dark_oak', 'mangrove', 'cherry']) {
  const cfg = WOODS.find((x) => x.name === w);
  def(w + '_boat', item(SPR.boat, { M: cfg.planks, H: cfg.planksDark }));
  def(w + '_chest_boat', (ctx) => { clear(ctx); sprite(ctx, SPR.boat, { M: cfg.planks, H: 0x8a6a3f }); rect(ctx, 6, 4, 5, 4, 0x8a6a3f); px(ctx, 8, 6, 0xd8d8d8); outline(ctx, 0x21160c, 0.85); });
}
def('bamboo_raft', item(SPR.boat, { M: 0xc0ab54, H: 0x9c8940 }));
def('bamboo_chest_raft', (ctx) => { clear(ctx); sprite(ctx, SPR.boat, { M: 0xc0ab54, H: 0x8a6a3f }); rect(ctx, 6, 4, 5, 4, 0x8a6a3f); outline(ctx, 0x21160c, 0.85); });
def('minecart', item(SPR.minecart, { M: 0xa8a8a8, m: 0x6a6a6a }));
def('chest_minecart', (ctx) => { clear(ctx); sprite(ctx, SPR.minecart, { M: 0xa8a8a8, m: 0x6a6a6a }); rect(ctx, 5, 3, 6, 4, 0x8a6a3f); outline(ctx, 0x21160c, 0.85); });
def('furnace_minecart', (ctx) => { clear(ctx); sprite(ctx, SPR.minecart, { M: 0xa8a8a8, m: 0x6a6a6a }); rect(ctx, 5, 3, 6, 4, 0x707070); rect(ctx, 6, 4, 4, 2, 0x2b2b2b); outline(ctx, 0x21160c, 0.85); });
def('hopper_minecart', (ctx) => { clear(ctx); sprite(ctx, SPR.minecart, { M: 0xa8a8a8, m: 0x6a6a6a }); rect(ctx, 4, 2, 8, 3, 0x4a4a4a); outline(ctx, 0x21160c, 0.85); });
def('tnt_minecart', (ctx) => { clear(ctx); sprite(ctx, SPR.minecart, { M: 0xa8a8a8, m: 0x6a6a6a }); rect(ctx, 5, 2, 6, 5, 0xc02020); rect(ctx, 5, 4, 6, 1, 0xf0f0f0); outline(ctx, 0x21160c, 0.85); });
def('command_block_minecart', (ctx) => { clear(ctx); sprite(ctx, SPR.minecart, { M: 0xa8a8a8, m: 0x6a6a6a }); rect(ctx, 5, 2, 6, 5, 0xbb8a5a); outline(ctx, 0x21160c, 0.85); });

// --- dyes, banners, discs, patterns ----------------------------------------
for (const c of COLORS) {
  def(c + '_dye', (ctx, rng) => drawDyePile(ctx, rng, DYE[c]));
  def(c + '_banner', (ctx, rng) => drawBanner(ctx, rng, WOOL_COLOR[c]));
}
defineAlias('cocoa_beans', 'brown_dye');
const DISCS = {
  '13': 0x5a7a2c, cat: 0x2c8a4a, blocks: 0xd0a83c, chirp: 0xd04a2c, far: 0x4a8ad0,
  mall: 0x2c4a9a, mellohi: 0xb02c8a, stal: 0x8a8a8a, strad: 0xd0c02c, ward: 0x2c8a8a,
  '11': 0x3a3a3a, wait: 0x2ca0a0, otherside: 0x8a4ad0, '5': 0x6a6a8a, pigstep: 0xd0708a, relic: 0xc08a3c,
};
for (const k of Object.keys(DISCS)) def('music_disc_' + k, (ctx, rng) => drawDisc(ctx, rng, DISCS[k]));
for (const p of ['creeper', 'skull', 'mojang', 'flower', 'globe', 'piglin']) {
  def(p + '_banner_pattern', (ctx, rng) => { clear(ctx); rect(ctx, 3, 2, 10, 12, 0xe0d8c0); rect(ctx, 4, 3, 8, 10, 0xc8bfa4); rect(ctx, 5, 5, 6, 6, 0x4a4a4a); outline(ctx, 0x5a5040, 0.9); });
}
const TRIMS = ['coast', 'dune', 'eye', 'host', 'raiser', 'rib', 'sentry', 'shaper', 'silence', 'snout', 'spire', 'tide', 'vex', 'ward', 'wayfinder', 'wild'];
for (const t of TRIMS) {
  def(t + '_armor_trim_smithing_template', (ctx, rng) => { clear(ctx); rect(ctx, 2, 2, 12, 12, 0xd8cfc0); border(ctx, 0x9a917f, 2); rect(ctx, 5, 5, 6, 6, 0x8a8172); rect(ctx, 6, 6, 4, 4, 0xe8e0d0); outline(ctx, 0x4a4238, 0.9); });
}
def('netherite_upgrade_smithing_template', (ctx, rng) => { clear(ctx); rect(ctx, 2, 2, 12, 12, 0xd8cfc0); border(ctx, 0x9a917f, 2); rect(ctx, 5, 5, 6, 6, 0x4d4a4d); rect(ctx, 6, 6, 4, 4, 0x8a7a82); outline(ctx, 0x4a4238, 0.9); });
const SHERDS = ['angler', 'archer', 'arms_up', 'blade', 'brewer', 'burn', 'danger', 'explorer', 'friend',
  'heart', 'heartbreak', 'howl', 'miner', 'mourner', 'plenty', 'prize', 'sheaf', 'shelter', 'skull', 'snort'];
for (const s of SHERDS) def(s + '_pottery_sherd', item(SPR.sherd, { M: 0xb8724a, m: 0x8a4f2e }));

// --- spawn eggs ------------------------------------------------------------
const EGG_COLORS = {
  allay: [0x00daff, 0x00adff], armadillo: [0x9c5a3c, 0xd8b48c], axolotl: [0xfbc1e3, 0xa62d74],
  bat: [0x4c3e30, 0x0f0f0f], bee: [0xedc343, 0x43241b], blaze: [0xf6b201, 0xfff87e],
  bogged: [0x8a9a5b, 0x5c6b3c], breeze: [0xc0a8ff, 0x6a4fc0], camel: [0xfcc369, 0xcdab7c],
  cat: [0xefc88e, 0x957256], cave_spider: [0x0c424e, 0xa80e0e], chicken: [0xa1a1a1, 0xff0000],
  cod: [0xc1c1c1, 0xe5c48b], cow: [0x443626, 0xa1a1a1], creaking: [0x5a4a3a, 0xd67a3a],
  creeper: [0x0da70b, 0x000000], dolphin: [0x223b4d, 0xf9f9f9], donkey: [0x534539, 0x867566],
  drowned: [0x8ff1d7, 0x799c65], elder_guardian: [0xceccba, 0x747693],
  ender_dragon: [0x1c1c1c, 0xc030c0], enderman: [0x161616, 0x000000], endermite: [0x161616, 0x6d6d6d],
  evoker: [0x959b9b, 0x1e1c1a], fox: [0xd5b69f, 0xcc6a18], frog: [0x4a8a3c, 0xd6a24a],
  ghast: [0xf9f9f9, 0xbcbcbc], glow_squid: [0x095656, 0x88ffd6], goat: [0xa5947c, 0x54503f],
  guardian: [0x5a8272, 0xf17d31], hoglin: [0xc66e55, 0x5f6464], horse: [0xc09e7d, 0xeee500],
  husk: [0x7a7a7a, 0xdbc9a4], illusioner: [0x9a9c9c, 0x2a3d6a], iron_golem: [0xdbcdc0, 0x9a8b7a],
  llama: [0xc09e7d, 0x995f40], magma_cube: [0x340000, 0xfcfc00], mooshroom: [0xa00f10, 0xb7b7b7],
  mule: [0x1b0200, 0x51331d], ocelot: [0xefde7d, 0x564434], panda: [0xe7e7e7, 0x1b1b21],
  parrot: [0x0da70b, 0xff0000], phantom: [0x43518a, 0x88ff6c], pig: [0xf0a5a2, 0xdb635f],
  piglin: [0x995f40, 0xf9f0a3], piglin_brute: [0x592a10, 0xf9f0a3], pillager: [0x532f36, 0x9a9c9c],
  polar_bear: [0xf2f2f2, 0x959590], pufferfish: [0xf6b201, 0x51d3d5], rabbit: [0x995f40, 0x734831],
  ravager: [0x757470, 0x5b5049], salmon: [0xa00f10, 0x0e8474], sheep: [0xe7e7e7, 0xffb5b5],
  shulker: [0x946a94, 0x4d3852], silverfish: [0x6e6e6e, 0x303030], skeleton: [0xc1c1c1, 0x494949],
  skeleton_horse: [0x68684f, 0xe5e5d8], slime: [0x51a03e, 0x7ebf6e], sniffer: [0xa63a3a, 0xe3ac8c],
  snow_golem: [0xf2f2f2, 0xd8842c], spider: [0x342d27, 0xa80e0e], squid: [0x223b4d, 0x708899],
  stray: [0x617677, 0xdddfe0], strider: [0x9c3436, 0x4d494d], tadpole: [0x6d5c43, 0x291f13],
  trader_llama: [0xeaa430, 0x995f40], tropical_fish: [0xef6915, 0xf9ffff], turtle: [0xe7e7e7, 0x00afaf],
  vex: [0x7a90a4, 0xe8edf1], villager: [0x563c33, 0xbd8b72], vindicator: [0x9a9c9c, 0x275e61],
  wandering_trader: [0x456296, 0xe5c185], warden: [0x0f4649, 0x39d6e0], witch: [0x340000, 0x51a03e],
  wither: [0x141414, 0x4c4c4c], wither_skeleton: [0x141414, 0x474d4d], wolf: [0xd7d3d3, 0xceaf96],
  zoglin: [0xc66e55, 0xe6e6e6], zombie: [0x00afaf, 0x799c65], zombie_horse: [0x315231, 0x9abb8f],
  zombie_villager: [0x563c33, 0x799c65], zombified_piglin: [0xea9393, 0x4c7129],
  fireball: [0xd45b12, 0xffc23c], mooshroom_brown: [0x8a5a30, 0xb7b7b7],
};
for (const m of Object.keys(EGG_COLORS)) {
  const [a, b] = EGG_COLORS[m];
  def(m + '_spawn_egg', (ctx, rng) => drawSpawnEgg(ctx, rng, a, b));
}

// --- particles -------------------------------------------------------------
for (let i = 0; i < 8; i++) {
  def('particle_generic_' + i, (ctx) => { clear(ctx); const s = 8 - i; const o = (16 - s) >> 1; rect(ctx, o, o, s, s, 0xffffff); });
}
def('particle_flame', (ctx, rng) => { clear(ctx); circle(ctx, 8, 9, 5, 0xd8461c); circle(ctx, 8, 8, 3.4, 0xffa02c); circle(ctx, 8, 7, 1.8, 0xffe08a); });
def('particle_smoke', (ctx, rng) => { clear(ctx); circle(ctx, 8, 8, 5.5, 0x4a4a4a, 0.85); circle(ctx, 7, 7, 3, 0x6a6a6a, 0.9); });
def('particle_cloud', (ctx, rng) => { clear(ctx); circle(ctx, 8, 8, 6, 0xe8e8e8, 0.75); circle(ctx, 6, 7, 3, 0xffffff, 0.8); });
def('particle_bubble', (ctx) => { clear(ctx); ring(ctx, 8, 8, 5, 0xd8f0ff, 1, 0.9); px(ctx, 6, 5, 0xffffff); });
def('particle_splash', (ctx, rng) => { clear(ctx); for (let i = 0; i < 12; i++) px(ctx, 2 + rng.int(12), 2 + rng.int(12), 0xc8e4ff, 0.9); });
def('particle_heart', (ctx) => { clear(ctx); circle(ctx, 5.5, 6, 3, 0xff3050); circle(ctx, 10.5, 6, 3, 0xff3050); for (let y = 6; y < 14; y++) { const w = 12 - (y - 6) * 1.6; rect(ctx, 8 - w / 2, y, w, 1, 0xff3050); } });
def('particle_angry', (ctx) => { clear(ctx); rect(ctx, 6, 2, 4, 8, 0x8a2a2a); rect(ctx, 6, 11, 4, 3, 0x8a2a2a); });
def('particle_note', (ctx) => { clear(ctx); circle(ctx, 6, 11, 3, 0xffffff); rect(ctx, 8, 3, 2, 9, 0xffffff); rect(ctx, 9, 3, 4, 2, 0xffffff); });
def('particle_critical_hit', (ctx) => { clear(ctx); rect(ctx, 3, 7, 10, 2, 0xd8c04a); rect(ctx, 7, 3, 2, 10, 0xd8c04a); });
def('particle_enchanted_hit', (ctx) => { clear(ctx); rect(ctx, 3, 7, 10, 2, 0x9fd8ff); rect(ctx, 7, 3, 2, 10, 0x9fd8ff); });
def('particle_glint', (ctx, rng) => { clear(ctx); for (let i = 0; i < 10; i++) px(ctx, rng.int(TILE), rng.int(TILE), 0xd0a8ff, 0.9); });
def('particle_spell', (ctx, rng) => { clear(ctx); circle(ctx, 8, 8, 5, 0xffffff, 0.8); circle(ctx, 8, 8, 2.5, 0xffffff); });
def('particle_soul', (ctx, rng) => { clear(ctx); circle(ctx, 8, 9, 5, 0x1c6f9a, 0.85); circle(ctx, 8, 7, 3, 0xd8fbff, 0.9); });
def('particle_flash', (ctx) => { clear(ctx); circle(ctx, 8, 8, 7, 0xffffff, 0.55); circle(ctx, 8, 8, 4, 0xffffff); });
def('particle_glow', (ctx) => { clear(ctx); circle(ctx, 8, 8, 6, 0x8ff0d0, 0.4); circle(ctx, 8, 8, 3, 0xd8fff0, 0.85); });
def('particle_drip_hang', (ctx) => { clear(ctx); rect(ctx, 7, 4, 2, 6, 0xffffff); rect(ctx, 6, 8, 4, 4, 0xffffff); });
def('particle_drip_fall', (ctx) => { clear(ctx); rect(ctx, 7, 5, 2, 6, 0xffffff); });
def('particle_drip_land', (ctx) => { clear(ctx); rect(ctx, 5, 8, 6, 2, 0xffffff); });
def('particle_snowflake', (ctx) => { clear(ctx); rect(ctx, 7, 2, 2, 12, 0xffffff); rect(ctx, 2, 7, 12, 2, 0xffffff); for (let i = 0; i < 5; i++) { px(ctx, 4 + i, 4 + i, 0xffffff); px(ctx, 11 - i, 4 + i, 0xffffff); } });
def('particle_cherry', (ctx) => { clear(ctx); circle(ctx, 8, 8, 5, 0xf0a8c8); circle(ctx, 7, 7, 2.5, 0xffd0e4); });
def('particle_spore', (ctx) => { clear(ctx); circle(ctx, 8, 8, 4, 0xd4629d, 0.85); });
def('particle_sculk_charge', (ctx, rng) => { clear(ctx); for (let i = 0; i < 14; i++) px(ctx, rng.int(TILE), rng.int(TILE), 0x2fe0d0, 0.85); });
def('particle_totem', (ctx, rng) => { clear(ctx); circle(ctx, 8, 8, 5, 0x2ca04a, 0.8); circle(ctx, 8, 8, 2.5, 0xdfc02c); });
def('particle_damage', (ctx) => { clear(ctx); circle(ctx, 8, 8, 5, 0x8a1010, 0.9); });
def('particle_end_rod', (ctx) => { clear(ctx); circle(ctx, 8, 8, 4, 0xe8e0f8, 0.9); circle(ctx, 8, 8, 2, 0xffffff); });
def('particle_firework', (ctx) => { clear(ctx); circle(ctx, 8, 8, 3, 0xffffff); ring(ctx, 8, 8, 6, 0xffffff, 0.6, 0.6); });
def('particle_portal', (ctx, rng) => { clear(ctx); for (let i = 0; i < 12; i++) px(ctx, 2 + rng.int(12), 2 + rng.int(12), 0xb46fe8, 0.9); });
def('particle_lava', (ctx, rng) => { clear(ctx); circle(ctx, 8, 8, 5, 0xd45b12); circle(ctx, 8, 8, 2.5, 0xffc23c); });
def('particle_dust', (ctx, rng) => { clear(ctx); rect(ctx, 5, 5, 6, 6, 0xffffff); });
def('particle_sweep', (ctx, rng) => { clear(ctx); for (let i = 0; i < 16; i++) { const a = (i / 16) * Math.PI; px(ctx, 8 + Math.cos(a) * 7, 8 + Math.sin(a) * 7, 0xffffff, 0.8); } ring(ctx, 8, 8, 5, 0xffffff, 0.5, 0.5); });
def('particle_slime', (ctx) => { clear(ctx); circle(ctx, 8, 8, 5, 0x77c265, 0.9); });
def('particle_rain', (ctx) => { clear(ctx); rect(ctx, 7, 0, 2, TILE, 0xa8c8f0, 0.75); });
def('particle_explosion', (ctx, rng) => { clear(ctx); circle(ctx, 8, 8, 7, 0xd8b090, 0.55); circle(ctx, 8, 8, 4.5, 0xf0e0c0, 0.85); circle(ctx, 8, 8, 2, 0xffffff); });

// --- UI helper tiles -------------------------------------------------------
def('ui_slot', (ctx) => { fill(ctx, 0x8b8b8b); rect(ctx, 0, 0, TILE, 1, 0x373737); rect(ctx, 0, 0, 1, TILE, 0x373737); rect(ctx, 0, 15, TILE, 1, 0xffffff); rect(ctx, 15, 0, 1, TILE, 0xffffff); });
def('ui_slot_hover', (ctx) => { fill(ctx, 0xb0b0b0); border(ctx, 0xffffff, 0, 0.7); });
def('ui_panel', (ctx) => { fill(ctx, 0xc6c6c6); rect(ctx, 0, 0, TILE, 1, 0xffffff); rect(ctx, 0, 0, 1, TILE, 0xffffff); rect(ctx, 0, 15, TILE, 1, 0x555555); rect(ctx, 15, 0, 1, TILE, 0x555555); });
def('ui_panel_dark', (ctx) => { fill(ctx, 0x2b2b2b); border(ctx, 0x101010, 0); });
def('ui_button', (ctx) => { gradientV(ctx, 0x8b8b8b, 0x6a6a6a); rect(ctx, 0, 0, TILE, 1, 0xc6c6c6); rect(ctx, 0, 15, TILE, 1, 0x303030); });
def('ui_button_hover', (ctx) => { gradientV(ctx, 0xa8b0d8, 0x7a83b0); rect(ctx, 0, 0, TILE, 1, 0xd8dcf0); rect(ctx, 0, 15, TILE, 1, 0x404868); });
def('ui_button_disabled', (ctx) => { gradientV(ctx, 0x6a6a6a, 0x4a4a4a); });
def('ui_crosshair', (ctx) => { clear(ctx); rect(ctx, 7, 2, 2, 5, 0xffffff); rect(ctx, 7, 9, 2, 5, 0xffffff); rect(ctx, 2, 7, 5, 2, 0xffffff); rect(ctx, 9, 7, 5, 2, 0xffffff); });
def('ui_hotbar_slot', (ctx) => { clear(ctx); rect(ctx, 0, 0, TILE, TILE, 0x000000, 0.45); border(ctx, 0x8b8b8b, 0, 0.8); });
def('ui_hotbar_selected', (ctx) => { clear(ctx); border(ctx, 0xffffff, 0); border(ctx, 0xd0d0d0, 1); });
const heart = (fillFrac, color) => (ctx) => {
  clear(ctx);
  const rows = [
    '..MM...MM..', '.MMMM.MMMM.', 'MMMMMMMMMMM', 'MMMMMMMMMMM',
    'MMMMMMMMMMM', '.MMMMMMMMM.', '..MMMMMMM..', '...MMMMM...', '....MMM....', '.....M.....',
  ];
  for (let y = 0; y < rows.length; y++) {
    for (let x = 0; x < rows[y].length; x++) {
      if (rows[y][x] !== 'M') continue;
      if (fillFrac < 1 && x / 11 > fillFrac) continue;
      px(ctx, x + 2, y + 3, color);
    }
  }
  outline(ctx, 0x1a0000, 0.85);
};
def('ui_heart_full', heart(1, 0xd82020));
def('ui_heart_half', heart(0.5, 0xd82020));
def('ui_heart_empty', heart(1, 0x3a1010));
def('ui_heart_absorb', heart(1, 0xd8c020));
def('ui_heart_poison', heart(1, 0x6a9a20));
def('ui_heart_wither', heart(1, 0x2a2a2a));
const drumstick = (frac, color) => (ctx) => {
  clear(ctx);
  circle(ctx, 6, 6, 4, color);
  rect(ctx, 7, 8, 3, 6, color);
  rect(ctx, 9, 12, 4, 2, color);
  if (frac < 1) ctx.clearRect(8, 0, 8, 16);
  outline(ctx, 0x241000, 0.85);
};
def('ui_hunger_full', drumstick(1, 0xc06a2c));
def('ui_hunger_half', drumstick(0.5, 0xc06a2c));
def('ui_hunger_empty', drumstick(1, 0x3a2410));
const armorIcon = (frac, color) => (ctx) => {
  clear(ctx);
  const rows = ['..MMMMM..', '.MMMMMMM.', 'MMMMMMMMM', 'MMM...MMM', 'MM.....MM', 'MM.....MM', '.M.....M.'];
  for (let y = 0; y < rows.length; y++) for (let x = 0; x < rows[y].length; x++) {
    if (rows[y][x] !== 'M') continue;
    if (frac < 1 && x / 9 > frac) continue;
    px(ctx, x + 3, y + 4, color);
  }
  outline(ctx, 0x101010, 0.85);
};
def('ui_armor_full', armorIcon(1, 0xd8d8d8));
def('ui_armor_half', armorIcon(0.5, 0xd8d8d8));
def('ui_armor_empty', armorIcon(1, 0x3a3a3a));
def('ui_bubble_full', (ctx) => { clear(ctx); circle(ctx, 8, 8, 6, 0xffffff); circle(ctx, 8, 8, 4, 0x2a4a8a); px(ctx, 6, 5, 0xffffff); });
def('ui_bubble_pop', (ctx) => { clear(ctx); ring(ctx, 8, 8, 5, 0xffffff, 1, 0.8); });
def('ui_xp_bar_bg', (ctx) => { fill(ctx, 0x2b2b2b); rect(ctx, 0, 0, TILE, 1, 0x101010); });
def('ui_xp_bar_fill', (ctx) => { gradientV(ctx, 0x9fe83c, 0x5aa016); });
def('ui_boss_bar_bg', (ctx) => { fill(ctx, 0x1a1a2a); border(ctx, 0x000000, 0, 0.6); });
def('ui_boss_bar_fill', (ctx) => { gradientV(ctx, 0xd04a9a, 0x8a1a5a); });
def('ui_arrow_left', (ctx) => { clear(ctx); for (let i = 0; i < 6; i++) rect(ctx, 5 + i, 8 - i, 2, 1 + i * 2, 0xe0e0e0); });
def('ui_arrow_right', (ctx) => { clear(ctx); for (let i = 0; i < 6; i++) rect(ctx, 10 - i, 8 - i, 2, 1 + i * 2, 0xe0e0e0); });
def('ui_arrow_up', (ctx) => { clear(ctx); for (let i = 0; i < 6; i++) rect(ctx, 8 - i, 10 - i, 1 + i * 2, 2, 0xe0e0e0); });
def('ui_arrow_down', (ctx) => { clear(ctx); for (let i = 0; i < 6; i++) rect(ctx, 8 - i, 5 + i, 1 + i * 2, 2, 0xe0e0e0); });
def('ui_progress_arrow', (ctx) => { clear(ctx); rect(ctx, 2, 6, 9, 4, 0xd0d0d0); for (let i = 0; i < 5; i++) rect(ctx, 11 + 0, 8 - i, 1, 1 + i * 2, 0xd0d0d0); });
def('ui_flame', (ctx) => { clear(ctx); circle(ctx, 8, 10, 5, 0xd8721c); circle(ctx, 8, 9, 3, 0xffb03c); circle(ctx, 8, 7, 1.5, 0xffe08a); });
def('ui_check', (ctx) => { clear(ctx); for (let i = 0; i < 4; i++) px(ctx, 3 + i, 8 + i, 0x50d050); for (let i = 0; i < 7; i++) px(ctx, 7 + i, 11 - i, 0x50d050); });
def('ui_cross', (ctx) => { clear(ctx); for (let i = 0; i < 10; i++) { px(ctx, 3 + i, 3 + i, 0xd05050); px(ctx, 12 - i, 3 + i, 0xd05050); } });
def('ui_scroll_thumb', (ctx) => { fill(ctx, 0xc6c6c6); rect(ctx, 0, 15, TILE, 1, 0x555555); rect(ctx, 15, 0, 1, TILE, 0x555555); });
def('ui_scroll_track', (ctx) => { fill(ctx, 0x2b2b2b); });
def('ui_frame_corner', (ctx) => { clear(ctx); rect(ctx, 0, 0, TILE, 2, 0xc6c6c6); rect(ctx, 0, 0, 2, TILE, 0xc6c6c6); });
def('ui_shadow', (ctx) => { clear(ctx); rect(ctx, 0, 0, TILE, TILE, 0x000000, 0.55); });
def('ui_highlight', (ctx) => { clear(ctx); rect(ctx, 0, 0, TILE, TILE, 0xffffff, 0.3); });

// --- late additions: names other modules are likely to ask for -------------
def('bricks', brickTex(0x9a8177, 0x9a5b4a, 4, 8));
defineAlias('magma_block', 'magma_0');
defineAlias('grass_path_top', 'dirt_path_top');
defineAlias('grass_path_side', 'dirt_path_side');
defineAlias('sea_lantern_still', 'sea_lantern_0');
for (const n of ['copper_block', 'cut_copper', 'exposed_copper', 'cut_exposed_copper', 'weathered_copper',
  'cut_weathered_copper', 'oxidized_copper', 'cut_oxidized_copper', 'chiseled_copper']) {
  defineAlias('waxed_' + n, REGISTRY.has(n) ? n : 'copper_block');
}
const CORALS = { tube: 0x3057c4, brain: 0xc55fb1, bubble: 0xa11cc4, fire: 0xa4222b, horn: 0xdcd757 };
for (const k of Object.keys(CORALS)) {
  const c = CORALS[k];
  def(k + '_coral_block', (ctx, rng) => { noise(ctx, rng, c, 0.12); speckle(ctx, rng, shade(c, 1.25), 14); speckle(ctx, rng, shade(c, 0.72), 10); });
  def(k + '_coral', (ctx, rng) => { clear(ctx); drawTuft(ctx, rng, c, shade(c, 1.25), 7, 15, 11); });
  def(k + '_coral_fan', (ctx, rng) => { clear(ctx); for (let i = 0; i < 9; i++) { const a = (i / 8) * Math.PI; let x = 8, y = 14; for (let s = 0; s < 8; s++) { px(ctx, x, y, s > 5 ? shade(c, 1.3) : c); x += Math.cos(a - Math.PI) * -1.1; y -= 1; } } });
  defineAlias(k + '_coral_wall_fan', k + '_coral_fan');
  const dead = mix(c, 0x8a8a8a, 0.82);
  def('dead_' + k + '_coral_block', (ctx, rng) => { noise(ctx, rng, dead, 0.12); speckle(ctx, rng, shade(dead, 0.75), 12); });
  def('dead_' + k + '_coral', (ctx, rng) => { clear(ctx); drawTuft(ctx, rng, dead, shade(dead, 1.2), 7, 15, 11); });
  def('dead_' + k + '_coral_fan', (ctx, rng) => { clear(ctx); for (let i = 0; i < 9; i++) { let x = 8, y = 14; const a = (i / 8) * Math.PI; for (let s = 0; s < 8; s++) { px(ctx, x, y, dead); x += Math.cos(a - Math.PI) * -1.1; y -= 1; } } });
  defineAlias('dead_' + k + '_coral_wall_fan', 'dead_' + k + '_coral_fan');
}
def('turtle_egg', (ctx, rng) => { clear(ctx); circle(ctx, 5, 11, 3, 0xe4dfc0); circle(ctx, 11, 10, 3.4, 0xe4dfc0); speckle(ctx, rng, 0xc0b894, 6); });
def('slightly_cracked_turtle_egg', (ctx, rng) => { drawInto(ctx, 'turtle_egg'); crackOverlay(ctx, rng, 0x8a8266, 2); });
def('very_cracked_turtle_egg', (ctx, rng) => { drawInto(ctx, 'turtle_egg'); crackOverlay(ctx, rng, 0x6a6248, 5); });
def('sniffer_egg_top', (ctx, rng) => { noise(ctx, rng, 0x6a4a3a, 0.12); speckle(ctx, rng, 0xd8a83c, 10, 2); });
def('sniffer_egg_side', (ctx, rng) => { noise(ctx, rng, 0x5c3f32, 0.12); speckle(ctx, rng, 0xd8a83c, 12, 2); });
def('sniffer_egg_bottom', (ctx, rng) => noise(ctx, rng, 0x4a3228, 0.12));
def('frogspawn', (ctx, rng) => { clear(ctx); for (let i = 0; i < 9; i++) { const x = rng.int(13), y = rng.int(13); circle(ctx, x + 1.5, y + 1.5, 2, 0x5c4a3a, 0.85); px(ctx, x + 1, y + 1, 0x1a1410); } });
def('candle', (ctx, rng) => { clear(ctx); rect(ctx, 6, 6, 4, 9, 0xe8dcc0); rect(ctx, 6, 6, 1, 9, 0xf8f0dc); rect(ctx, 9, 6, 1, 9, 0xc0b498); rect(ctx, 7, 4, 1, 2, 0x6b6b6b); });
def('candle_lit', (ctx, rng) => { drawInto(ctx, 'candle'); rect(ctx, 7, 1, 1, 3, 0xffe08a); px(ctx, 7, 0, 0xfff6cf); });
def('bundle', (ctx, rng) => { clear(ctx); rect(ctx, 3, 5, 10, 9, 0xa06540); rect(ctx, 4, 3, 8, 3, 0xc08a63); rect(ctx, 5, 8, 6, 3, 0x6d4327); outline(ctx, 0x3a2415, 0.9); });
def('infested_stone', (ctx, rng) => { drawInto(ctx, 'stone'); speckle(ctx, rng, 0x5a5a5a, 8); });
def('vault_top', (ctx, rng) => { noise(ctx, rng, 0x3a4048, 0.1); border(ctx, 0x22262c, 0); });
def('glow_item_frame_pane', (ctx) => { clear(ctx); border(ctx, 0x49c4bd, 2); });
