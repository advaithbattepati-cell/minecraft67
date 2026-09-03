// ============================================================================
// skins.js - Procedural entity skins (CONTRACT.md section 14).
//
// Every mob, the player, boats and minecarts get a 64x64 RGBA canvas that is
// drawn entirely from code. There are no image files anywhere in this project.
//
// Layout rules
// ------------
//  * Humanoid skins use the real Minecraft skin UV layout:
//      head 0,0 (8x8x8)      hat overlay 32,0
//      body 16,16 (8x12x4)   jacket 16,32
//      right arm 40,16       right sleeve 40,32
//      left  arm 32,48       left  sleeve 48,48
//      right leg 0,16        right pant   0,32
//      left  leg 16,48       left  pant   0,48
//    The six overlay rectangles are cleared to transparent so a model that
//    renders the outer layer does not end up wearing an opaque block.
//  * Animal skins first wash the WHOLE sheet with the animal's body colour and
//    only then paint the canonical vanilla part rectangles on top. models.js
//    declares its own uv offsets, so this guarantees that whatever region a
//    model samples it still gets a sensible colour, while models that use the
//    vanilla offsets get the proper face, snout, belly and hooves.
//
// Nothing here touches `document` or THREE at module-evaluation time, so the
// module imports cleanly in Node.
// ============================================================================
import * as THREE from 'three';
import { RNG, hashString } from '../core/rng.js';
import { clamp, mixHex } from '../core/util.js';

const SKIN_W = 64;
const SKIN_H = 64;

const SKIN_DEFS = new Map();   // name -> fn(ctx, rng, name)
const SKIN_CACHE = new Map();  // name -> HTMLCanvasElement
const TEX_CACHE = new Map();   // name -> THREE.Texture

/** Every registered skin name, in registration order. */
export const SKIN_NAMES = [];

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Registers a skin generator.
 * @param {string} name canonical entity name, e.g. 'zombie'
 * @param {(ctx: CanvasRenderingContext2D, rng: RNG, name: string) => void} fn
 * @returns {string} the name
 */
export function defineSkin(name, fn) {
  if (!SKIN_DEFS.has(name)) SKIN_NAMES.push(name);
  SKIN_DEFS.set(name, fn);
  SKIN_CACHE.delete(name);
  const tex = TEX_CACHE.get(name);
  if (tex) { tex.dispose(); TEX_CACHE.delete(name); }
  return name;
}

/**
 * Returns the 64x64 canvas holding a skin, drawing it on first use.
 * Unknown names are derived: `sheep_red` recolours `sheep`, anything else gets
 * a deterministic procedural humanoid so nothing ever renders as a missing
 * texture.
 * @param {string} name
 * @returns {HTMLCanvasElement}
 */
export function getSkin(name) {
  const key = String(name == null ? 'player' : name);
  const hit = SKIN_CACHE.get(key);
  if (hit) return hit;
  const fn = SKIN_DEFS.get(key);
  if (!fn) {
    const derived = deriveVariant(key);
    if (derived) { SKIN_CACHE.set(key, derived); return derived; }
  }
  const canvas = createCanvas(SKIN_W, SKIN_H);
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  ctx.imageSmoothingEnabled = false;
  const rng = new RNG(hashString('skin:' + key));
  try {
    (fn || fallbackSkin)(ctx, rng, key);
  } catch (err) {
    console.error('[skins] failed to draw "' + key + '"', err);
    ctx.clearRect(0, 0, SKIN_W, SKIN_H);
    fallbackSkin(ctx, new RNG(hashString(key)), key);
  }
  SKIN_CACHE.set(key, canvas);
  return canvas;
}

/**
 * Returns a cached THREE.Texture wrapping a skin canvas.
 * flipY is false, so texture v runs downward from the top-left of the sheet,
 * matching Minecraft's skin coordinates and render/atlas.js.
 * @param {string} name
 * @returns {THREE.Texture}
 */
export function getSkinTexture(name) {
  const key = String(name == null ? 'player' : name);
  let tex = TEX_CACHE.get(key);
  if (tex) return tex;
  tex = new THREE.CanvasTexture(getSkin(key));
  tex.magFilter = THREE.NearestFilter;
  tex.minFilter = THREE.NearestFilter;
  tex.generateMipmaps = false;
  tex.flipY = false;
  tex.wrapS = THREE.ClampToEdgeWrapping;
  tex.wrapT = THREE.ClampToEdgeWrapping;
  if (THREE.SRGBColorSpace) tex.colorSpace = THREE.SRGBColorSpace;
  tex.needsUpdate = true;
  TEX_CACHE.set(key, tex);
  return tex;
}

/**
 * Cached multiply-recolour of an existing skin - sheep wool, cat and horse
 * coats, llama fleece, tropical fish, wolf/cat collars, shulker shells.
 * The result is also cached under the key `base#rrggbb`, so
 * `getSkinTexture('sheep#a12722')` returns a texture for it.
 * @param {string} baseName
 * @param {number|string} colorHex
 * @returns {HTMLCanvasElement}
 */
export function tintedSkin(baseName, colorHex) {
  const hex = toHex(colorHex);
  const key = baseName + '#' + hex.toString(16).padStart(6, '0');
  const hit = SKIN_CACHE.get(key);
  if (hit) return hit;
  const base = getSkin(baseName);
  const out = createCanvas(base.width, base.height);
  const ctx = out.getContext('2d', { willReadFrequently: true });
  ctx.imageSmoothingEnabled = false;
  ctx.drawImage(base, 0, 0);
  const img = ctx.getImageData(0, 0, out.width, out.height);
  const d = img.data;
  const tr = ((hex >> 16) & 255) / 255;
  const tg = ((hex >> 8) & 255) / 255;
  const tb = (hex & 255) / 255;
  for (let i = 0; i < d.length; i += 4) {
    d[i] = d[i] * tr;
    d[i + 1] = d[i + 1] * tg;
    d[i + 2] = d[i + 2] * tb;
  }
  ctx.putImageData(img, 0, 0);
  SKIN_CACHE.set(key, out);
  return out;
}

/** `sheep_red` -> tint of `sheep`, `shulker_lime` -> tint of `shulker`, etc. */
function deriveVariant(key) {
  for (const dye in DYE_COLORS) {
    if (key.length > dye.length + 1 && key.endsWith('_' + dye)) {
      const base = key.slice(0, key.length - dye.length - 1);
      if (SKIN_DEFS.has(base)) return tintedSkin(base, DYE_COLORS[dye]);
    }
  }
  const cut = key.lastIndexOf('_');
  if (cut > 0 && SKIN_DEFS.has(key.slice(0, cut))) return getSkin(key.slice(0, cut));
  return null;
}

// ---------------------------------------------------------------------------
// Canvas + colour helpers
// ---------------------------------------------------------------------------

function createCanvas(w, h) {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  return c;
}

function toHex(c) {
  if (typeof c === 'number') return c >>> 0;
  if (typeof c === 'string') {
    const v = parseInt(c.charAt(0) === '#' ? c.slice(1) : c, 16);
    return Number.isFinite(v) ? v >>> 0 : 0;
  }
  return 0;
}

function css(color, alpha) {
  const h = toHex(color);
  const r = (h >> 16) & 255, g = (h >> 8) & 255, b = h & 255;
  if (alpha === undefined || alpha >= 1) return 'rgb(' + r + ',' + g + ',' + b + ')';
  return 'rgba(' + r + ',' + g + ',' + b + ',' + alpha + ')';
}

/** Multiplies a colour's brightness; f > 1 lightens, f < 1 darkens. */
function shadeHex(color, f) {
  const h = toHex(color);
  const r = clamp(Math.round(((h >> 16) & 255) * f), 0, 255);
  const g = clamp(Math.round(((h >> 8) & 255) * f), 0, 255);
  const b = clamp(Math.round((h & 255) * f), 0, 255);
  return (r << 16) | (g << 8) | b;
}

function mix(a, b, t) { return mixHex(toHex(a), toHex(b), t); }

// ---------------------------------------------------------------------------
// Pixel drawing primitives - one unit is one texel
// ---------------------------------------------------------------------------

function rect(ctx, x, y, w, h, color, alpha) {
  ctx.fillStyle = css(color, alpha);
  ctx.fillRect(x | 0, y | 0, w | 0, h | 0);
}

function px(ctx, x, y, color, alpha) { rect(ctx, x, y, 1, 1, color, alpha); }

function outline(ctx, x, y, w, h, color, alpha) {
  rect(ctx, x, y, w, 1, color, alpha);
  rect(ctx, x, y + h - 1, w, 1, color, alpha);
  rect(ctx, x, y, 1, h, color, alpha);
  rect(ctx, x + w - 1, y, 1, h, color, alpha);
}

/** Per-texel light/dark jitter laid over whatever is already drawn. */
function noise(ctx, x, y, w, h, rng, amount, density) {
  const amt = amount === undefined ? 0.12 : amount;
  const den = density === undefined ? 0.45 : density;
  if (amt <= 0) return;
  for (let j = 0; j < h; j++) {
    for (let i = 0; i < w; i++) {
      if (rng.next() > den) continue;
      const d = (rng.next() - 0.5) * 2 * amt;
      ctx.fillStyle = d < 0
        ? 'rgba(0,0,0,' + (-d).toFixed(3) + ')'
        : 'rgba(255,255,255,' + d.toFixed(3) + ')';
      ctx.fillRect(x + i, y + j, 1, 1);
    }
  }
}

/** Vertical darkening ramp; invert=true darkens the top instead of the bottom. */
function shadeV(ctx, x, y, w, h, strength, invert) {
  const s = strength === undefined ? 0.28 : strength;
  const n = Math.max(1, h - 1);
  for (let j = 0; j < h; j++) {
    const t = invert ? 1 - j / n : j / n;
    ctx.fillStyle = 'rgba(0,0,0,' + (t * s).toFixed(3) + ')';
    ctx.fillRect(x, y + j, w, 1);
  }
}

/** Random single-texel (or size x size) dots of a colour. */
function speckle(ctx, x, y, w, h, color, count, rng, size) {
  const s = size === undefined ? 1 : size;
  for (let i = 0; i < count; i++) {
    const sx = x + rng.int(Math.max(1, w - s + 1));
    const sy = y + rng.int(Math.max(1, h - s + 1));
    rect(ctx, sx, sy, s, s, color);
  }
}

/** Evenly spaced bands. */
function stripes(ctx, x, y, w, h, color, step, thickness, vertical) {
  const st = step === undefined ? 3 : step;
  const th = thickness === undefined ? 1 : thickness;
  if (vertical) { for (let i = 0; i < w; i += st) rect(ctx, x + i, y, th, h, color); }
  else { for (let j = 0; j < h; j += st) rect(ctx, x, y + j, w, th, color); }
}

/** Irregular blobs - cow spots, mooshroom mushrooms, mossy patches. */
function patches(ctx, x, y, w, h, color, rng, count, min, max) {
  const lo = min === undefined ? 2 : min;
  const hi = max === undefined ? 5 : max;
  for (let i = 0; i < count; i++) {
    const pw = rng.range(lo, hi), ph = rng.range(lo, hi);
    const sx = x + rng.int(Math.max(1, w - pw + 1));
    const sy = y + rng.int(Math.max(1, h - ph + 1));
    rect(ctx, sx, sy, pw, ph, color);
    if (rng.chance(0.5) && sy > y) px(ctx, sx + rng.int(pw), sy - 1, color);
    if (rng.chance(0.5) && sx > x) px(ctx, sx - 1, sy + rng.int(ph), color);
    if (rng.chance(0.5)) px(ctx, sx + pw, sy + rng.int(ph), color);
  }
}

/** A mirrored pair of eyes. `inner` adds a pupil texel to each. */
function eyes(ctx, x, y, w, h, gap, color, inner) {
  rect(ctx, x, y, w, h, color);
  rect(ctx, x + w + gap, y, w, h, color);
  if (inner !== undefined && inner !== null) {
    rect(ctx, x + w - 1, y + h - 1, 1, 1, inner);
    rect(ctx, x + w + gap, y + h - 1, 1, 1, inner);
  }
}

/**
 * Stamps a char-grid sprite. `rows` is an array of equal-length strings and
 * `map` maps each char to a colour (undefined chars are left untouched).
 */
function pattern(ctx, x, y, rows, map) {
  for (let j = 0; j < rows.length; j++) {
    const row = rows[j];
    for (let i = 0; i < row.length; i++) {
      const c = map[row.charAt(i)];
      if (c === undefined || c === null) continue;
      rect(ctx, x + i, y + j, 1, 1, c);
    }
  }
}

/** Fills the whole sheet, then jitters it. Keeps unknown uv offsets sane. */
function fillAll(ctx, color, rng, amount) {
  rect(ctx, 0, 0, SKIN_W, SKIN_H, color);
  noise(ctx, 0, 0, SKIN_W, SKIN_H, rng, amount === undefined ? 0.08 : amount, 0.4);
}

// ---------------------------------------------------------------------------
// Unwrapped-box helpers
//
// A Minecraft box of size w x h x d at uv origin (u, v) unwraps to:
//   top    (u+d,     v)     w x d      bottom (u+d+w,   v)     w x d
//   right  (u,       v+d)   d x h      front  (u+d,     v+d)   w x h
//   left   (u+d+w,   v+d)   d x h      back   (u+d+w+d, v+d)   w x h
// ---------------------------------------------------------------------------

function faceRect(u, v, w, h, d, face) {
  switch (face) {
    case 'top': return [u + d, v, w, d];
    case 'bottom': return [u + d + w, v, w, d];
    case 'right': return [u, v + d, d, h];
    case 'front': return [u + d, v + d, w, h];
    case 'left': return [u + d + w, v + d, d, h];
    case 'back': return [u + d + w + d, v + d, w, h];
    default: return [u, v, 2 * (w + d), d + h];
  }
}

function fillFace(ctx, u, v, w, h, d, face, color, alpha) {
  const r = faceRect(u, v, w, h, d, face);
  rect(ctx, r[0], r[1], r[2], r[3], color, alpha);
}

/** Paints the six faces of an unwrapped box. `colors` is a hex or a face map. */
function box(ctx, u, v, w, h, d, colors) {
  const c = (colors !== null && typeof colors === 'object') ? colors : { all: colors };
  const all = c.all !== undefined ? c.all : 0xffffff;
  const pick = (k) => (c[k] !== undefined ? c[k] : all);
  rect(ctx, u + d, v, w, d, pick('top'));
  rect(ctx, u + d + w, v, w, d, pick('bottom'));
  rect(ctx, u, v + d, d, h, pick('right'));
  rect(ctx, u + d, v + d, w, h, pick('front'));
  rect(ctx, u + d + w, v + d, d, h, pick('left'));
  rect(ctx, u + d + w + d, v + d, w, h, pick('back'));
}

/** Jitters the whole unwrapped footprint of a box. */
function boxNoise(ctx, u, v, w, h, d, rng, amount) {
  noise(ctx, u, v, 2 * (w + d), d + h, rng, amount === undefined ? 0.08 : amount, 0.4);
}

/** Colours the top `rows` texels of all four side faces plus the top face. */
function bandTop(ctx, u, v, w, h, d, rows, color) {
  rect(ctx, u, v + d, 2 * (w + d), rows, color);
  rect(ctx, u + d, v, w, d, color);
}

/** Colours the bottom `rows` texels of all four side faces plus the bottom face. */
function bandBottom(ctx, u, v, w, h, d, rows, color) {
  rect(ctx, u, v + d + h - rows, 2 * (w + d), rows, color);
  rect(ctx, u + d + w, v, w, d, color);
}

/** Colours a horizontal band across all four side faces of a box. */
function bandMid(ctx, u, v, w, h, d, offset, rows, color) {
  rect(ctx, u, v + d + offset, 2 * (w + d), rows, color);
}

// ---------------------------------------------------------------------------
// Shared layout constants
// ---------------------------------------------------------------------------

const ARM_SLOTS = [[40, 16], [32, 48]];
const LEG_SLOTS = [[0, 16], [16, 48]];
// hat, right pant, jacket, right sleeve, left pant, left sleeve
const OVERLAY_RECTS = [
  [32, 0, 32, 16], [0, 32, 16, 16], [16, 32, 24, 16],
  [40, 32, 16, 16], [0, 48, 16, 16], [48, 48, 16, 16],
];
// Head-front face of a humanoid head at uv (0,0): x 8..16, y 8..16.
const FX = 8, FY = 8;

/** Punches the outer skin layers back to transparent. Index 0 is the hat. */
function clearOverlays(ctx, keepHat) {
  for (let i = keepHat ? 1 : 0; i < OVERLAY_RECTS.length; i++) {
    const r = OVERLAY_RECTS[i];
    ctx.clearRect(r[0], r[1], r[2], r[3]);
  }
}

/** The 16 vanilla dye / wool colours, used for tinted variants. */
const DYE_COLORS = {
  white: 0xe9ecec, orange: 0xf07613, magenta: 0xbd44b3, light_blue: 0x3aafd9,
  yellow: 0xf8c627, lime: 0x70b919, pink: 0xed8dac, gray: 0x3e4447,
  light_gray: 0x8e8e86, cyan: 0x158991, purple: 0x792aac, blue: 0x35399d,
  brown: 0x724728, green: 0x546d1b, red: 0xa12722, black: 0x141519,
};

// ---------------------------------------------------------------------------
// Composers
// ---------------------------------------------------------------------------

/** Eyes / nose / mouth on the head-front face of a humanoid head. */
function humanoidFace(ctx, o) {
  o = o || {};
  const ey = o.eyeY !== undefined ? o.eyeY : FY + 3;
  const eh = o.eyeH !== undefined ? o.eyeH : 2;
  const sclera = o.sclera !== undefined ? o.sclera : 0xefefef;
  const pupil = o.pupil !== undefined ? o.pupil : 0x4a3628;
  if (o.brow !== undefined && o.brow !== null) rect(ctx, FX, ey - 1, 8, 1, o.brow);
  if (sclera !== null) eyes(ctx, FX + 1, ey, 2, eh, 2, sclera);
  rect(ctx, FX + 2, ey, 1, eh, pupil);
  rect(ctx, FX + 5, ey, 1, eh, pupil);
  if (o.nose !== undefined && o.nose !== null) rect(ctx, FX + 3, ey + eh, 2, 1, o.nose);
  if (o.mouth !== undefined && o.mouth !== null) {
    rect(ctx, FX + 2, ey + eh + 1, 4, o.mouthH !== undefined ? o.mouthH : 1, o.mouth);
  }
}

/**
 * Builds a draw function for a standard humanoid skin.
 * Options: skin, head, hair, hairRows, hairBack, shirt, arm, cuff, cuffRows,
 * hand, pants, boots, bootRows, belt, fill, grain, face, hat, extra, overlay.
 * `extra` paints the base layers; `overlay` runs after the outer layers have
 * been cleared, so it is the only place to draw jackets, sleeves or wings.
 */
function humanoidSkin(o) {
  return (ctx, rng) => {
    const skin = toHex(o.skin !== undefined ? o.skin : 0xc69c6d);
    const head = toHex(o.head !== undefined ? o.head : skin);
    const shirt = toHex(o.shirt !== undefined ? o.shirt : skin);
    const arm = toHex(o.arm !== undefined ? o.arm : skin);
    const pants = toHex(o.pants !== undefined ? o.pants : shadeHex(shirt, 0.62));
    const cuff = o.cuff !== undefined && o.cuff !== null ? toHex(o.cuff) : null;
    const cuffRows = o.cuffRows !== undefined ? o.cuffRows : 4;
    const hand = o.hand !== undefined && o.hand !== null ? toHex(o.hand) : null;
    const boots = o.boots !== undefined && o.boots !== null ? toHex(o.boots) : null;
    const bootRows = o.bootRows !== undefined ? o.bootRows : 3;

    fillAll(ctx, toHex(o.fill !== undefined ? o.fill : shirt), rng, o.grain !== undefined ? o.grain : 0.06);

    // head
    box(ctx, 0, 0, 8, 8, 8, {
      all: head, top: shadeHex(head, 1.05), bottom: shadeHex(head, 0.76),
      back: shadeHex(head, 0.9),
    });
    if (o.hair !== undefined && o.hair !== null) {
      const hair = toHex(o.hair);
      bandTop(ctx, 0, 0, 8, 8, 8, o.hairRows !== undefined ? o.hairRows : 3, hair);
      if (o.hairBack !== false) fillFace(ctx, 0, 0, 8, 8, 8, 'back', hair);
    }
    boxNoise(ctx, 0, 0, 8, 8, 8, rng, 0.07);

    // torso
    box(ctx, 16, 16, 8, 12, 4, {
      all: shirt, top: shadeHex(shirt, 1.1), bottom: shadeHex(shirt, 0.7),
      back: shadeHex(shirt, 0.92),
    });
    if (o.belt !== undefined && o.belt !== null) bandMid(ctx, 16, 16, 8, 12, 4, 8, 2, toHex(o.belt));
    boxNoise(ctx, 16, 16, 8, 12, 4, rng, 0.07);

    // arms
    for (let i = 0; i < ARM_SLOTS.length; i++) {
      const au = ARM_SLOTS[i][0], av = ARM_SLOTS[i][1];
      box(ctx, au, av, 4, 12, 4, { all: arm, top: shadeHex(arm, 1.1), bottom: shadeHex(arm, 0.72) });
      if (cuff !== null && cuffRows > 0) bandTop(ctx, au, av, 4, 12, 4, cuffRows, cuff);
      if (hand !== null) bandBottom(ctx, au, av, 4, 12, 4, 2, hand);
      boxNoise(ctx, au, av, 4, 12, 4, rng, 0.07);
    }

    // legs
    for (let i = 0; i < LEG_SLOTS.length; i++) {
      const lu = LEG_SLOTS[i][0], lv = LEG_SLOTS[i][1];
      box(ctx, lu, lv, 4, 12, 4, { all: pants, top: shadeHex(pants, 1.08), bottom: shadeHex(pants, 0.6) });
      if (boots !== null && bootRows > 0) bandBottom(ctx, lu, lv, 4, 12, 4, bootRows, boots);
      boxNoise(ctx, lu, lv, 4, 12, 4, rng, 0.07);
    }

    if (o.hat) {
      const hat = toHex(o.hat);
      box(ctx, 32, 0, 8, 8, 8, { all: hat, top: shadeHex(hat, 1.08), bottom: shadeHex(hat, 0.7) });
      boxNoise(ctx, 32, 0, 8, 8, 8, rng, 0.06);
    }

    if (typeof o.face === 'function') o.face(ctx, rng);
    else if (o.face !== false) humanoidFace(ctx, (o.face && typeof o.face === 'object') ? o.face : {});
    if (o.extra) o.extra(ctx, rng);
    clearOverlays(ctx, !!o.hat);
    if (o.overlay) o.overlay(ctx, rng);
  };
}

/** Eyes on the head-front face of an animal head at uv (0,0) 8x8x8. */
function animalFace(ctx, o) {
  const eye = toHex(o.eye !== undefined ? o.eye : 0x1a1210);
  const ey = o.eyeY !== undefined ? o.eyeY : FY + 2;
  if (o.sclera !== undefined && o.sclera !== null) {
    rect(ctx, FX + 1, ey, 2, 2, o.sclera);
    rect(ctx, FX + 5, ey, 2, 2, o.sclera);
    rect(ctx, FX + 2, ey, 1, 2, eye);
    rect(ctx, FX + 5, ey, 1, 2, eye);
  } else {
    rect(ctx, FX + 1, ey, 2, 2, eye);
    rect(ctx, FX + 5, ey, 2, 2, eye);
    px(ctx, FX + 1, ey, 0xffffff, 0.3);
    px(ctx, FX + 5, ey, 0xffffff, 0.3);
  }
  if (o.nostril !== undefined && o.nostril !== null) {
    px(ctx, FX + 2, FY + 6, o.nostril);
    px(ctx, FX + 5, FY + 6, o.nostril);
  }
  if (o.mouth !== undefined && o.mouth !== null) rect(ctx, FX + 2, FY + 7, 4, 1, o.mouth);
}

/**
 * Builds a draw function for a four-legged animal.
 * Canonical vanilla offsets: head (0,0) 8x8x8, body (28,8) 10x16x8,
 * legs (0,16) 4x12x4 (all four legs share one rectangle).
 */
function quadrupedSkin(o) {
  return (ctx, rng) => {
    const body = toHex(o.body);
    const head = toHex(o.head !== undefined ? o.head : body);
    const legs = toHex(o.legs !== undefined ? o.legs : shadeHex(body, 0.86));
    const hoof = o.hoof !== undefined && o.hoof !== null ? toHex(o.hoof) : shadeHex(legs, 0.55);

    fillAll(ctx, body, rng, o.grain !== undefined ? o.grain : 0.09);
    // body: front face is the animal's back, bottom face is its belly
    if (o.back !== undefined && o.back !== null) rect(ctx, 36, 16, 10, 16, toHex(o.back));
    if (o.belly !== undefined && o.belly !== null) rect(ctx, 46, 8, 10, 8, toHex(o.belly));
    if (o.pattern) o.pattern(ctx, rng);

    box(ctx, 0, 16, 4, 12, 4, { all: legs, top: shadeHex(legs, 1.1), bottom: hoof });
    bandBottom(ctx, 0, 16, 4, 12, 4, o.hoofRows !== undefined ? o.hoofRows : 2, hoof);
    boxNoise(ctx, 0, 16, 4, 12, 4, rng, 0.08);

    box(ctx, 0, 0, 8, 8, 8, { all: head, top: shadeHex(head, 1.06), bottom: shadeHex(head, 0.78) });
    boxNoise(ctx, 0, 0, 8, 8, 8, rng, 0.07);
    if (o.ears !== undefined && o.ears !== null) {
      rect(ctx, FX, FY, 2, 2, toHex(o.ears));
      rect(ctx, FX + 6, FY, 2, 2, toHex(o.ears));
    }
    if (o.snout !== undefined && o.snout !== null) rect(ctx, FX + 2, FY + 4, 4, 4, toHex(o.snout));
    if (o.face !== false) animalFace(ctx, o);
    if (o.extra) o.extra(ctx, rng);
  };
}

/** Slime / magma-cube style cube with a tiny face at the vanilla eye offsets. */
function blobSkin(o) {
  return (ctx, rng) => {
    const body = toHex(o.body);
    fillAll(ctx, body, rng, o.grain !== undefined ? o.grain : 0.14);
    // outer cube (0,0) 8x8x8 and inner core (0,16) 6x6x6
    box(ctx, 0, 0, 8, 8, 8, { all: body, top: shadeHex(body, 1.14), bottom: shadeHex(body, 0.66) });
    const core = toHex(o.core !== undefined ? o.core : shadeHex(body, 0.78));
    box(ctx, 0, 16, 6, 6, 6, { all: core, top: shadeHex(core, 1.12), bottom: shadeHex(core, 0.7) });
    if (o.crack) {
      for (let i = 0; i < 34; i++) {
        const x = rng.int(60), y = rng.int(60), len = rng.range(2, 5);
        rect(ctx, x, y, rng.bool() ? len : 1, rng.bool() ? 1 : len, toHex(o.crack));
      }
    }
    // eyes at (32,0) and (32,4), mouth at (32,8) - the vanilla slime layout
    const eye = toHex(o.eye !== undefined ? o.eye : 0x14100c);
    box(ctx, 32, 0, 2, 2, 1, { all: 0xffffff, front: 0xffffff });
    rect(ctx, 33, 1, 2, 2, eye);
    box(ctx, 32, 4, 2, 2, 1, { all: 0xffffff, front: 0xffffff });
    rect(ctx, 33, 5, 2, 2, eye);
    box(ctx, 32, 8, 1, 1, 1, { all: eye });
    // and a matching face on the outer cube front so any uv choice reads right
    rect(ctx, FX + 1, FY + 2, 2, 2, eye);
    rect(ctx, FX + 5, FY + 2, 2, 2, eye);
    px(ctx, FX + 3, FY + 5, eye);
    px(ctx, FX + 4, FY + 5, eye);
    if (o.extra) o.extra(ctx, rng);
  };
}

/** Fish / aquatic body: dark dorsal, pale belly, optional stripes. */
function fishSkin(o) {
  return (ctx, rng) => {
    const body = toHex(o.body);
    fillAll(ctx, body, rng, 0.1);
    const top = toHex(o.top !== undefined ? o.top : shadeHex(body, 0.68));
    const belly = toHex(o.belly !== undefined ? o.belly : shadeHex(body, 1.35));
    rect(ctx, 0, 0, 64, 12, top);
    rect(ctx, 0, 40, 64, 10, belly);
    if (o.stripe !== undefined && o.stripe !== null) {
      stripes(ctx, 0, 12, 64, 28, toHex(o.stripe), o.stripeStep || 6, o.stripeWidth || 2, true);
    }
    if (o.spots !== undefined && o.spots !== null) speckle(ctx, 0, 10, 64, 34, toHex(o.spots), 40, rng);
    noise(ctx, 0, 0, 64, 64, rng, 0.09, 0.35);
    // eye on the head end of the sheet
    rect(ctx, 4, 16, 3, 3, 0xf2f2f2);
    rect(ctx, 5, 17, 2, 2, 0x141414);
    if (o.extra) o.extra(ctx, rng);
  };
}

/** Wood-plank sheet used for boats, rafts, signs and the armour stand. */
function plankSkin(color, o) {
  o = o || {};
  return (ctx, rng) => {
    const c = toHex(color);
    fillAll(ctx, c, rng, 0.1);
    for (let y = 0; y < 64; y += 4) {
      rect(ctx, 0, y, 64, 1, shadeHex(c, 0.78));
      for (let x = rng.int(8); x < 64; x += rng.range(9, 18)) px(ctx, x, y + rng.range(1, 3), shadeHex(c, 0.86));
    }
    speckle(ctx, 0, 0, 64, 64, shadeHex(c, 1.12), 70, rng);
    shadeV(ctx, 0, 0, 64, 64, 0.14);
    if (o.extra) o.extra(ctx, rng);
  };
}

/**
 * Last-resort skin: a deterministic humanoid whose palette is hashed out of
 * the name, so an unregistered entity still renders as something plausible.
 */
function fallbackSkin(ctx, rng, name) {
  const h = hashString(String(name || 'entity'));
  const hue = (h % 360) / 360;
  const base = hsv(hue, 0.45, 0.72);
  const dark = shadeHex(base, 0.55);
  const light = shadeHex(base, 1.25);
  humanoidSkin({
    skin: light, head: light, hair: dark, shirt: base, arm: light, cuff: base,
    pants: dark, boots: shadeHex(dark, 0.7), grain: 0.1,
    face: { sclera: 0xf0f0f0, pupil: 0x2b2b2b, mouth: shadeHex(dark, 0.8) },
  })(ctx, rng);
}

function hsv(h, s, v) {
  const i = Math.floor(h * 6) % 6;
  const f = h * 6 - Math.floor(h * 6);
  const p = v * (1 - s), q = v * (1 - s * f), t = v * (1 - s * (1 - f));
  let r, g, b;
  if (i === 0) { r = v; g = t; b = p; }
  else if (i === 1) { r = q; g = v; b = p; }
  else if (i === 2) { r = p; g = v; b = t; }
  else if (i === 3) { r = p; g = q; b = v; }
  else if (i === 4) { r = t; g = p; b = v; }
  else { r = v; g = p; b = q; }
  return (Math.round(r * 255) << 16) | (Math.round(g * 255) << 8) | Math.round(b * 255);
}

// ===========================================================================
// Player
// ===========================================================================

const STEVE = humanoidSkin({
  skin: 0xc69c6d, head: 0xc69c6d, hair: 0x2f2013, hairRows: 3,
  shirt: 0x00afaf, arm: 0xc69c6d, cuff: 0x00afaf, cuffRows: 4,
  pants: 0x4a4aa0, boots: 0x585858, bootRows: 3, belt: 0x37375f,
  face: { sclera: 0xefefef, pupil: 0x4a3628, mouth: 0x8a5f42 },
  extra: (ctx) => {
    rect(ctx, FX, FY + 6, 8, 2, 0x6b4b33, 0.35);   // stubble
    rect(ctx, FX + 2, FY + 7, 4, 1, 0x50351f);     // mouth line
  },
});
defineSkin('steve', STEVE);
defineSkin('player', STEVE);
defineSkin('alex', humanoidSkin({
  skin: 0xf7c99c, head: 0xf7c99c, hair: 0xc9682e, hairRows: 4, hairBack: true,
  shirt: 0x6e9b3e, arm: 0xf7c99c, cuff: 0x6e9b3e, cuffRows: 5,
  pants: 0x6b4b2e, boots: 0x4a3a2a, belt: 0x8a6a3a,
  face: { sclera: 0xf2f2f2, pupil: 0x3d6b3d, mouth: 0xa9705a },
  extra: (ctx) => {
    rect(ctx, 24, 8, 8, 8, 0xc9682e);              // long hair down the back
    rect(ctx, 8, 8, 1, 5, 0xc9682e);
    rect(ctx, 15, 8, 1, 5, 0xc9682e);
  },
}));

// ===========================================================================
// Zombie family
// ===========================================================================

/** Sunken sockets, a torn brow and rotten blotches - shared by the undead. */
function rottenFace(sock, blotch, mouth) {
  return (ctx, rng) => {
    rect(ctx, FX, FY + 2, 8, 1, shadeHex(sock, 1.4), 0.5);
    rect(ctx, FX + 1, FY + 3, 2, 2, sock);
    rect(ctx, FX + 5, FY + 3, 2, 2, sock);
    rect(ctx, FX + 2, FY + 6, 4, 1, mouth);
    px(ctx, FX + 3, FY + 5, mouth);
    if (blotch !== null) {
      speckle(ctx, FX, FY, 8, 8, blotch, 5, rng);
      speckle(ctx, 16, 20, 24, 12, blotch, 22, rng);
      speckle(ctx, 40, 20, 16, 12, blotch, 10, rng);
      speckle(ctx, 32, 52, 16, 12, blotch, 10, rng);
    }
  };
}

defineSkin('zombie', humanoidSkin({
  skin: 0x00a21f, head: 0x00a21f, hair: 0x274d19, hairRows: 3,
  shirt: 0x00afaf, arm: 0x00a21f, cuff: 0x00afaf, cuffRows: 5,
  pants: 0x3f3f5f, boots: 0x2b2b3e, belt: 0x2f2f4a, grain: 0.11,
  face: false, extra: rottenFace(0x0c2610, 0x2f6b1e, 0x0a1c0c),
}));
defineSkin('husk', humanoidSkin({
  skin: 0x8d7a4f, head: 0x8d7a4f, hair: 0x5c4d2c, hairRows: 3,
  shirt: 0x77693f, arm: 0x8d7a4f, cuff: 0x77693f, cuffRows: 5,
  pants: 0x615437, boots: 0x463b25, grain: 0.13,
  face: false, extra: rottenFace(0x2b2313, 0xb8a874, 0x241d10),
}));
defineSkin('drowned', humanoidSkin({
  skin: 0x4e8b7c, head: 0x4e8b7c, hair: 0x2c5147, hairRows: 4,
  shirt: 0x3f7f8f, arm: 0x4e8b7c, cuff: 0x3f7f8f, cuffRows: 5,
  pants: 0x2f4f5f, boots: 0x24404c, grain: 0.12,
  face: false,
  extra: (ctx, rng) => {
    rect(ctx, FX + 1, FY + 3, 2, 2, 0x35d9c8);   // glowing eyes
    rect(ctx, FX + 5, FY + 3, 2, 2, 0x35d9c8);
    px(ctx, FX + 2, FY + 3, 0xaefff5); px(ctx, FX + 6, FY + 3, 0xaefff5);
    rect(ctx, FX + 2, FY + 6, 4, 1, 0x16332e);
    speckle(ctx, 0, 0, 64, 64, 0x2f7a52, 60, rng);   // seaweed clumps
    patches(ctx, 16, 18, 24, 14, 0x357a4f, rng, 4, 2, 4);
  },
}));
defineSkin('zombified_piglin', humanoidSkin({
  skin: 0x4f7a44, head: 0x4f7a44, hair: 0x2e4a26, hairRows: 2,
  shirt: 0x4f7a44, arm: 0x4f7a44, cuff: null, pants: 0x3b5c33, boots: 0x2e4a26,
  grain: 0.12, face: false,
  extra: (ctx, rng) => {
    rect(ctx, FX + 1, FY + 3, 2, 2, 0x101a0e);
    rect(ctx, FX + 5, FY + 3, 2, 2, 0x101a0e);
    rect(ctx, FX + 2, FY + 5, 4, 3, 0xc98d8d);       // rotting snout
    px(ctx, FX + 3, FY + 6, 0x5c3b3b); px(ctx, FX + 4, FY + 6, 0x5c3b3b);
    rect(ctx, FX - 1, FY + 2, 1, 3, 0xc98d8d);       // ears
    rect(ctx, FX + 8, FY + 2, 1, 3, 0xc98d8d);
    patches(ctx, 16, 20, 24, 12, 0xc98d8d, rng, 5, 2, 3);  // exposed flesh
    speckle(ctx, 16, 20, 24, 12, 0x8a9c6b, 14, rng);       // bare ribs
  },
}));

// ===========================================================================
// Skeleton family
// ===========================================================================

/** Skull sockets, nasal cavity and a row of teeth. */
function skullFace(bone, hollow) {
  return (ctx, rng) => {
    rect(ctx, FX + 1, FY + 2, 2, 3, hollow);
    rect(ctx, FX + 5, FY + 2, 2, 3, hollow);
    px(ctx, FX + 3, FY + 4, hollow);
    px(ctx, FX + 4, FY + 4, hollow);
    rect(ctx, FX + 1, FY + 6, 6, 2, shadeHex(bone, 1.12));
    for (let i = 0; i < 6; i += 2) rect(ctx, FX + 1 + i, FY + 6, 1, 2, hollow);
    speckle(ctx, FX, FY, 8, 8, shadeHex(bone, 0.82), 4, rng);
  };
}

function skeletonSkin(bone, hollow, o) {
  o = o || {};
  return humanoidSkin({
    skin: bone, head: bone, shirt: bone, arm: bone, pants: bone,
    hand: shadeHex(bone, 0.9), grain: 0.1, face: false,
    extra: (ctx, rng) => {
      skullFace(bone, hollow)(ctx, rng);
      // rib cage + spine on the torso
      const rib = shadeHex(bone, 0.72);
      for (let j = 0; j < 5; j++) rect(ctx, 20, 22 + j * 2, 8, 1, rib);
      rect(ctx, 23, 20, 2, 12, shadeHex(bone, 0.85));
      for (let j = 0; j < 5; j++) rect(ctx, 44, 22 + j * 2, 8, 1, rib);
      // thin limbs: darken the outer texels so 2-wide limb uvs still read bony
      for (let i = 0; i < ARM_SLOTS.length; i++) {
        rect(ctx, ARM_SLOTS[i][0], ARM_SLOTS[i][1] + 4, 16, 12, rib, 0.25);
      }
      for (let i = 0; i < LEG_SLOTS.length; i++) {
        rect(ctx, LEG_SLOTS[i][0], LEG_SLOTS[i][1] + 4, 16, 12, rib, 0.25);
      }
      if (o.extra) o.extra(ctx, rng);
    },
  });
}

defineSkin('skeleton', skeletonSkin(0xc8c8c8, 0x1a1a1a));
defineSkin('wither_skeleton', skeletonSkin(0x3a3a3a, 0x080808, {
  extra: (ctx, rng) => {
    speckle(ctx, 0, 0, 64, 64, 0x1c1c1c, 90, rng);
    rect(ctx, FX + 1, FY + 2, 2, 3, 0x050505);
    rect(ctx, FX + 5, FY + 2, 2, 3, 0x050505);
  },
}));
defineSkin('stray', skeletonSkin(0xc2cccc, 0x1a1a1a, {
  extra: (ctx, rng) => {
    // frozen tatters draped over the shoulders and skull
    patches(ctx, 16, 20, 24, 12, 0x546c72, rng, 7, 3, 6);
    patches(ctx, 8, 8, 8, 8, 0x546c72, rng, 2, 2, 3);
    speckle(ctx, 0, 0, 64, 64, 0x9fc6cf, 60, rng);
  },
}));
defineSkin('bogged', skeletonSkin(0xb9bcae, 0x151a12, {
  extra: (ctx, rng) => {
    patches(ctx, 16, 18, 24, 14, 0x4c6b3a, rng, 8, 2, 5);   // moss
    speckle(ctx, 0, 0, 64, 64, 0x6f8f4c, 60, rng);
    rect(ctx, 10, 8, 2, 2, 0x8b3a3a);                        // mushroom caps
    rect(ctx, 14, 9, 2, 2, 0x8b3a3a);
    px(ctx, 10, 10, 0xd8d0c0); px(ctx, 15, 11, 0xd8d0c0);
  },
}));

// ===========================================================================
// Creeper
// ===========================================================================

const CREEPER_FACE_ROWS = [
  '........',
  '........',
  '.##..##.',
  '.##..##.',
  '...##...',
  '..####..',
  '..#..#..',
  '........',
];

function creeperSkin(body, o) {
  o = o || {};
  return (ctx, rng) => {
    const dark = shadeHex(body, 0.74);
    const light = shadeHex(body, 1.18);
    fillAll(ctx, body, rng, 0.05);
    box(ctx, 0, 0, 8, 8, 8, { all: body, top: light, bottom: dark });
    box(ctx, 16, 16, 8, 12, 4, { all: body, top: light, bottom: dark });
    box(ctx, 0, 16, 4, 6, 4, { all: body, top: light, bottom: dark });   // feet
    // the mottled camouflage that makes a creeper a creeper
    for (let i = 0; i < 260; i++) {
      const x = rng.int(64), y = rng.int(64);
      const w = rng.range(1, 3), h = rng.range(1, 3);
      rect(ctx, x, y, w, h, rng.bool() ? dark : light, 0.75);
    }
    pattern(ctx, FX, FY, CREEPER_FACE_ROWS, { '#': o.face !== undefined ? o.face : 0x0b0b0b });
    if (o.extra) o.extra(ctx, rng);
    clearOverlays(ctx);
  };
}

defineSkin('creeper', creeperSkin(0x67b24e));
defineSkin('creeper_charged', creeperSkin(0x67b24e, {
  extra: (ctx, rng) => {
    speckle(ctx, 0, 0, 64, 64, 0x9fd8ff, 120, rng);
    rect(ctx, 0, 0, 64, 64, 0x64b0ff, 0.16);
  },
}));

// ===========================================================================
// Enderman / endermite
// ===========================================================================

defineSkin('enderman', humanoidSkin({
  skin: 0x161616, head: 0x141414, shirt: 0x161616, arm: 0x131313, pants: 0x131313,
  grain: 0.05, face: false,
  extra: (ctx, rng) => {
    rect(ctx, FX, FY + 3, 8, 2, 0x090909);              // dark eye band
    rect(ctx, FX + 1, FY + 3, 2, 2, 0xe079fb);
    rect(ctx, FX + 5, FY + 3, 2, 2, 0xe079fb);
    px(ctx, FX + 2, FY + 3, 0xffffff); px(ctx, FX + 6, FY + 3, 0xffffff);
    rect(ctx, FX + 2, FY + 6, 4, 1, 0x2a1030);
    speckle(ctx, 0, 0, 64, 64, 0x3a1f47, 70, rng);      // faint void shimmer
    speckle(ctx, 0, 0, 64, 64, 0x232323, 90, rng);
  },
}));
defineSkin('endermite', (ctx, rng) => {
  fillAll(ctx, 0x241733, rng, 0.16);
  box(ctx, 0, 0, 4, 4, 4, { all: 0x2c1c3e, top: 0x3a2652, bottom: 0x180f22 });
  stripes(ctx, 0, 0, 64, 64, 0x160e1f, 5, 1, false);
  speckle(ctx, 0, 0, 64, 64, 0x8b3fa8, 80, rng);
  speckle(ctx, 0, 0, 64, 64, 0xc060e0, 22, rng);
  rect(ctx, 5, 5, 1, 1, 0xe07af0); rect(ctx, 9, 5, 1, 1, 0xe07af0);
});
defineSkin('silverfish', (ctx, rng) => {
  fillAll(ctx, 0x6e6e6e, rng, 0.16);
  stripes(ctx, 0, 0, 64, 64, 0x3c3c3c, 4, 2, false);
  speckle(ctx, 0, 0, 64, 64, 0x9a9a9a, 90, rng);
  box(ctx, 0, 0, 4, 3, 3, { all: 0x555555, top: 0x707070, bottom: 0x333333 });
  px(ctx, 4, 4, 0x141414); px(ctx, 6, 4, 0x141414);
});

// ===========================================================================
// Villagers, illagers, witches, traders
// ===========================================================================

/**
 * Villager-family sheet: brown robe, big separate nose box at uv (24,0)
 * (2x4x2 - the vanilla villager nose) and a per-profession apron band.
 */
function villagerSkin(o) {
  return (ctx, rng) => {
    const skin = toHex(o.skin !== undefined ? o.skin : 0xbd8b72);
    const robe = toHex(o.robe !== undefined ? o.robe : 0x6b4a32);
    const apron = o.apron !== undefined && o.apron !== null ? toHex(o.apron) : null;
    const brow = toHex(o.brow !== undefined ? o.brow : 0x4a3225);

    fillAll(ctx, robe, rng, 0.07);
    // head
    box(ctx, 0, 0, 8, 8, 8, { all: skin, top: toHex(o.hair !== undefined ? o.hair : 0x3f2c1e), bottom: shadeHex(skin, 0.76) });
    bandTop(ctx, 0, 0, 8, 8, 8, 1, toHex(o.hair !== undefined ? o.hair : 0x3f2c1e));
    rect(ctx, FX, FY + 2, 8, 1, brow);                       // heavy unibrow
    rect(ctx, FX + 1, FY + 3, 2, 2, 0xe8e8e8);
    rect(ctx, FX + 5, FY + 3, 2, 2, 0xe8e8e8);
    rect(ctx, FX + 2, FY + 3, 1, 2, 0x3f2c1e);
    rect(ctx, FX + 5, FY + 3, 1, 2, 0x3f2c1e);
    rect(ctx, FX + 3, FY + 4, 2, 3, shadeHex(skin, 0.9));    // nose on the face
    rect(ctx, FX + 2, FY + 7, 4, 1, shadeHex(skin, 0.68));   // mouth
    boxNoise(ctx, 0, 0, 8, 8, 8, rng, 0.06);
    // separate nose box (vanilla uv 24,0 - 2x4x2)
    box(ctx, 24, 0, 2, 4, 2, { all: skin, top: shadeHex(skin, 1.06), bottom: shadeHex(skin, 0.7) });
    // torso: robe with a collar and, for professions, an apron band
    box(ctx, 16, 16, 8, 12, 4, { all: robe, top: shadeHex(robe, 1.12), bottom: shadeHex(robe, 0.68) });
    bandTop(ctx, 16, 16, 8, 12, 4, 2, shadeHex(robe, 1.25));
    if (apron !== null) {
      bandMid(ctx, 16, 16, 8, 12, 4, 3, 6, apron);
      rect(ctx, 20, 20, 8, 3, shadeHex(apron, 1.15));
    }
    boxNoise(ctx, 16, 16, 8, 12, 4, rng, 0.06);
    // arms: robe sleeves, bare hands
    for (let i = 0; i < ARM_SLOTS.length; i++) {
      const au = ARM_SLOTS[i][0], av = ARM_SLOTS[i][1];
      box(ctx, au, av, 4, 12, 4, { all: robe, top: shadeHex(robe, 1.1), bottom: skin });
      bandBottom(ctx, au, av, 4, 12, 4, 3, skin);
      boxNoise(ctx, au, av, 4, 12, 4, rng, 0.06);
    }
    // legs: dark robe hem
    const hem = toHex(o.hem !== undefined ? o.hem : shadeHex(robe, 0.66));
    for (let i = 0; i < LEG_SLOTS.length; i++) {
      const lu = LEG_SLOTS[i][0], lv = LEG_SLOTS[i][1];
      box(ctx, lu, lv, 4, 12, 4, { all: hem, top: shadeHex(hem, 1.1), bottom: shadeHex(hem, 0.6) });
      bandBottom(ctx, lu, lv, 4, 12, 4, 3, shadeHex(hem, 0.55));
      boxNoise(ctx, lu, lv, 4, 12, 4, rng, 0.06);
    }
    if (o.hat !== undefined && o.hat !== null) {
      const hat = toHex(o.hat);
      box(ctx, 32, 0, 8, 8, 8, { all: hat, top: shadeHex(hat, 1.1), bottom: shadeHex(hat, 0.66) });
      bandTop(ctx, 0, 0, 8, 8, 8, 2, hat);
    }
    if (o.extra) o.extra(ctx, rng);
    clearOverlays(ctx, o.hat !== undefined && o.hat !== null);
  };
}

/** Apron / badge colour per villager profession. */
const VILLAGER_PROFESSIONS = {
  unemployed: 0x9b7b54, armorer: 0x4c4c4c, butcher: 0xe4e4e4, cartographer: 0xf0ebdc,
  cleric: 0x7b4ca8, farmer: 0xc8a445, fisherman: 0x4e6f63, fletcher: 0x9aa45b,
  leatherworker: 0x8b5a2b, librarian: 0xe8e2d0, mason: 0xc9a063, nitwit: 0x6c9a44,
  shepherd: 0xd9d2c4, toolsmith: 0x5a5a5a, weaponsmith: 0x3e3e3e,
};
const VILLAGER_HATS = {
  farmer: 0xd8b45c, librarian: 0xd8d2c0, cartographer: 0xe8e3d2, cleric: 0x5c3a86,
};

defineSkin('villager', villagerSkin({}));
for (const prof in VILLAGER_PROFESSIONS) {
  defineSkin('villager_' + prof, villagerSkin({
    apron: VILLAGER_PROFESSIONS[prof],
    hat: VILLAGER_HATS[prof] !== undefined ? VILLAGER_HATS[prof] : null,
  }));
}
defineSkin('zombie_villager', villagerSkin({
  skin: 0x3f8a2f, robe: 0x5c6b3a, apron: 0x4a5c2c, brow: 0x1c3312, hair: 0x24401a,
  extra: (ctx, rng) => {
    rect(ctx, FX + 1, FY + 3, 2, 2, 0x0c2610);
    rect(ctx, FX + 5, FY + 3, 2, 2, 0x0c2610);
    speckle(ctx, 0, 0, 64, 64, 0x2f6b1e, 70, rng);
  },
}));
defineSkin('wandering_trader', villagerSkin({
  robe: 0x2b4c8c, apron: 0xe4e4e4, hem: 0x1f3a6b, hat: 0x21386b,
  extra: (ctx, rng) => {
    stripes(ctx, 16, 20, 24, 12, 0x4a6fbf, 4, 1, false);
    speckle(ctx, 40, 20, 16, 12, 0xd8d8d8, 10, rng);
  },
}));
defineSkin('witch', villagerSkin({
  skin: 0x8fa06b, robe: 0x45385a, apron: 0x2f2740, hem: 0x2b2438, hat: 0x2a2338,
  brow: 0x2e2418,
  extra: (ctx, rng) => {
    px(ctx, FX + 5, FY + 6, 0x3a2a1a);                     // wart on the chin
    px(ctx, FX + 2, FY + 5, 0x3a2a1a);
    speckle(ctx, 32, 0, 32, 16, 0x6a5b8a, 26, rng);        // hat highlights
    rect(ctx, 24, 0, 2, 4, 0x8fa06b);                      // long green nose box
  },
}));

/** Grey-skinned illager with a scowl and a coloured coat. */
function illagerSkin(coat, o) {
  o = o || {};
  return villagerSkin({
    skin: o.skin !== undefined ? o.skin : 0x9d9d9d,
    robe: coat, apron: o.apron !== undefined ? o.apron : null,
    hem: o.hem !== undefined ? o.hem : shadeHex(coat, 0.62),
    hair: o.hair !== undefined ? o.hair : 0x3a3a3a,
    brow: 0x2e2e2e, hat: o.hat !== undefined ? o.hat : null,
    extra: (ctx, rng) => {
      rect(ctx, FX, FY + 2, 8, 1, 0x1e1e1e);               // angry brow
      rect(ctx, FX + 1, FY + 3, 2, 1, 0xffffff);
      rect(ctx, FX + 5, FY + 3, 2, 1, 0xffffff);
      rect(ctx, FX + 2, FY + 3, 1, 1, 0x101010);
      rect(ctx, FX + 5, FY + 3, 1, 1, 0x101010);
      rect(ctx, FX + 2, FY + 7, 4, 1, 0x4a4a4a);
      if (o.sash !== undefined && o.sash !== null) {
        for (let i = 0; i < 8; i++) px(ctx, 20 + i, 20 + i, toHex(o.sash));
      }
      if (o.extra) o.extra(ctx, rng);
    },
  });
}

defineSkin('pillager', illagerSkin(0x5f6151, { apron: 0x43452f, sash: 0x8a7a4a }));
defineSkin('vindicator', illagerSkin(0x5c5c5c, { apron: 0x2f4a2f, sash: 0x3a3a3a }));
defineSkin('evoker', illagerSkin(0x4e4e4e, {
  apron: 0xd8c46a,
  extra: (ctx) => { rect(ctx, 22, 22, 4, 2, 0xf0d878); rect(ctx, 23, 24, 2, 2, 0xf0d878); },
}));
defineSkin('illusioner', illagerSkin(0x3b4c8c, { apron: 0x2a3a6b, hat: 0x2a3a6b, sash: 0x6a7fc0 }));
defineSkin('ravager', quadrupedSkin({
  body: 0x5b5148, head: 0x3e3831, legs: 0x4a4239, hoof: 0x241f1a, belly: 0x726657,
  grain: 0.13, eye: 0xd94b2a, sclera: 0xf0e6d8,
  extra: (ctx, rng) => {
    rect(ctx, FX + 1, FY + 6, 6, 2, 0x2a241f);            // gaping maw
    rect(ctx, FX + 1, FY + 6, 1, 2, 0xe6dfd0);            // tusks
    rect(ctx, FX + 6, FY + 6, 1, 2, 0xe6dfd0);
    rect(ctx, FX - 2, FY + 1, 2, 2, 0x8a7a63);            // horns
    rect(ctx, FX + 8, FY + 1, 2, 2, 0x8a7a63);
    patches(ctx, 28, 8, 36, 24, 0x6b6052, rng, 10, 3, 6);
    rect(ctx, 40, 18, 6, 4, 0x6b3f22);                    // saddle
  },
}));

// ===========================================================================
// Piglins and hoglins
// ===========================================================================

function piglinSkin(o) {
  return humanoidSkin({
    skin: toHex(o.skin), head: toHex(o.skin), shirt: toHex(o.tunic),
    arm: toHex(o.skin), cuff: toHex(o.tunic), cuffRows: 4,
    pants: toHex(o.pants), boots: shadeHex(toHex(o.pants), 0.7), grain: 0.09,
    face: false,
    extra: (ctx, rng) => {
      const skin = toHex(o.skin);
      rect(ctx, FX + 1, FY + 2, 2, 2, 0x2a1c18);          // small dark eyes
      rect(ctx, FX + 5, FY + 2, 2, 2, 0x2a1c18);
      rect(ctx, FX + 2, FY + 4, 4, 4, shadeHex(skin, 0.9));  // snout
      px(ctx, FX + 3, FY + 5, 0x4a2f2a); px(ctx, FX + 4, FY + 5, 0x4a2f2a);
      rect(ctx, FX + 2, FY + 7, 1, 1, 0xe8e0d0);          // tusks
      rect(ctx, FX + 5, FY + 7, 1, 1, 0xe8e0d0);
      rect(ctx, FX - 4, FY + 1, 4, 3, shadeHex(skin, 0.94));  // floppy ears
      rect(ctx, FX + 8, FY + 1, 4, 3, shadeHex(skin, 0.94));
      if (o.gold) {
        rect(ctx, 16, 20, 24, 2, 0xe9c557);               // gold shoulder plate
        rect(ctx, 20, 22, 8, 2, 0xc9a337);
        bandTop(ctx, 40, 16, 4, 12, 4, 2, 0xe9c557);
        bandTop(ctx, 32, 48, 4, 12, 4, 2, 0xe9c557);
      }
      speckle(ctx, 0, 0, 64, 64, shadeHex(skin, 0.86), 50, rng);
      if (o.extra) o.extra(ctx, rng);
    },
  });
}

defineSkin('piglin', piglinSkin({ skin: 0xefb2a0, tunic: 0x6b4a2f, pants: 0x4a3320, gold: true }));
defineSkin('piglin_brute', piglinSkin({
  skin: 0xd89a88, tunic: 0x3b2a1c, pants: 0x2b1e14, gold: true,
  extra: (ctx, rng) => { speckle(ctx, 16, 20, 24, 12, 0x2a2018, 24, rng); },
}));
defineSkin('hoglin', quadrupedSkin({
  body: 0xb06e48, head: 0x9c5f3d, legs: 0x8a5232, hoof: 0x3a2a1e, belly: 0xd09a72,
  snout: 0xd8a184, nostril: 0x5c3a2a, grain: 0.13, eye: 0x2a1a12,
  extra: (ctx, rng) => {
    speckle(ctx, 0, 0, 64, 64, 0x6b4530, 110, rng);        // coarse bristles
    rect(ctx, FX, FY + 6, 1, 2, 0xe8e0d0);
    rect(ctx, FX + 7, FY + 6, 1, 2, 0xe8e0d0);
    rect(ctx, 36, 16, 10, 3, 0x6b4530);                    // mane along the back
  },
}));
defineSkin('zoglin', quadrupedSkin({
  body: 0xa39280, head: 0x8f7f6d, legs: 0x8a7a68, hoof: 0x3a3128, belly: 0xc4b4a2,
  snout: 0xc8b09c, nostril: 0x4a3f34, grain: 0.14, eye: 0x1a1410,
  extra: (ctx, rng) => {
    speckle(ctx, 0, 0, 64, 64, 0x6f6252, 100, rng);
    patches(ctx, 28, 8, 36, 24, 0x7a8a5c, rng, 6, 2, 4);   // rot
    rect(ctx, FX, FY + 6, 1, 2, 0xe8e0d0);
    rect(ctx, FX + 7, FY + 6, 1, 2, 0xe8e0d0);
  },
}));

// ===========================================================================
// Golems
// ===========================================================================

defineSkin('iron_golem', humanoidSkin({
  skin: 0xd6d6d6, head: 0xdcdcdc, shirt: 0xc8c8c8, arm: 0xd0d0d0, pants: 0xb4b4b4,
  grain: 0.08, face: false,
  extra: (ctx, rng) => {
    rect(ctx, FX + 1, FY + 2, 2, 2, 0x3a3a3a);             // deep-set eyes
    rect(ctx, FX + 5, FY + 2, 2, 2, 0x3a3a3a);
    rect(ctx, FX + 3, FY + 3, 2, 4, 0xbdbdbd);             // long nose
    rect(ctx, FX + 3, FY + 6, 2, 1, 0x8a8a8a);
    rect(ctx, FX + 2, FY + 7, 4, 1, 0x707070);             // mouth
    // vines creeping across the plating
    for (let i = 0; i < 26; i++) {
      const x = rng.int(60), y = rng.int(60);
      rect(ctx, x, y, 1, rng.range(2, 5), 0x4c7a2c);
      if (rng.chance(0.5)) px(ctx, x + 1, y + 1, 0x5f8f37);
    }
    speckle(ctx, 0, 0, 64, 64, 0xa8a8a8, 80, rng);
    speckle(ctx, 0, 0, 64, 64, 0xb08050, 22, rng);         // rust
    rect(ctx, 16, 26, 24, 1, 0x9a9a9a);                    // plate seam
  },
}));
defineSkin('snow_golem', humanoidSkin({
  skin: 0xeff5f5, head: 0xc07615, shirt: 0xeff5f5, arm: 0x6b4a2c, pants: 0xeff5f5,
  grain: 0.07, face: false,
  extra: (ctx, rng) => {
    // carved pumpkin head
    stripes(ctx, 0, 0, 32, 16, 0xa85f10, 2, 1, true);
    rect(ctx, 8, 0, 8, 8, 0xa85f10);
    rect(ctx, 11, 1, 2, 2, 0x4c7a2c);                      // stem
    pattern(ctx, FX, FY, [
      '........',
      '.##..##.',
      '.##..##.',
      '........',
      '.######.',
      '.#.##.#.',
      '.######.',
      '........',
    ], { '#': 0x2a1608 });
    // snowy body with coal buttons
    rect(ctx, 16, 16, 24, 16, 0xeff5f5);
    speckle(ctx, 16, 20, 24, 12, 0xd8e4e8, 40, rng);
    rect(ctx, 22, 22, 2, 2, 0x1c1c1c);
    rect(ctx, 22, 27, 2, 2, 0x1c1c1c);
    speckle(ctx, 0, 32, 64, 32, 0xdfeaee, 60, rng);
  },
}));

// ===========================================================================
// Farm animals
// ===========================================================================

defineSkin('pig', quadrupedSkin({
  body: 0xf0a5a2, head: 0xefa19e, legs: 0xe08e8b, hoof: 0xb06a68,
  belly: 0xf6bcb9, snout: 0xd77e7e, nostril: 0x8f4f4f, ears: 0xd77e7e,
  eye: 0x141414, sclera: 0xffffff, grain: 0.08,
  extra: (ctx, rng) => {
    // vanilla pig snout box lives at uv (16,16) - 4x3x1
    box(ctx, 16, 16, 4, 3, 1, { all: 0xd77e7e, top: 0xe08e8b, bottom: 0xb06a68 });
    px(ctx, 18, 18, 0x8f4f4f); px(ctx, 20, 18, 0x8f4f4f);
    speckle(ctx, 0, 0, 64, 64, 0xf8bcb9, 60, rng);
  },
}));

/** Cow-family sheet: dark coat, white patches, horns and a pink muzzle. */
function cowSkin(o) {
  return quadrupedSkin({
    body: toHex(o.body), head: toHex(o.head !== undefined ? o.head : o.body),
    legs: toHex(o.legs !== undefined ? o.legs : shadeHex(toHex(o.body), 0.8)),
    hoof: 0x39332c, belly: toHex(o.belly !== undefined ? o.belly : 0xd8d2c4),
    eye: 0x141414, sclera: 0xffffff, grain: 0.1,
    pattern: (ctx, rng) => {
      if (o.spots !== undefined && o.spots !== null) {
        patches(ctx, 16, 4, 48, 32, toHex(o.spots), rng, 14, 3, 8);
        patches(ctx, 0, 40, 64, 24, toHex(o.spots), rng, 8, 3, 7);
      }
    },
    extra: (ctx, rng) => {
      if (o.spots !== undefined && o.spots !== null) {
        rect(ctx, FX + 2, FY, 4, 4, toHex(o.spots));       // blaze on the forehead
      }
      rect(ctx, FX + 2, FY + 5, 4, 3, toHex(o.muzzle !== undefined ? o.muzzle : 0xd8b0a8));
      px(ctx, FX + 3, FY + 6, 0x6b4a44); px(ctx, FX + 4, FY + 6, 0x6b4a44);
      // horns: vanilla uv (22,0), 1x3x1
      box(ctx, 22, 0, 1, 3, 1, { all: 0xded1b5, top: 0xf0e4c8, bottom: 0xb8a882 });
      box(ctx, 26, 0, 1, 3, 1, { all: 0xded1b5, top: 0xf0e4c8, bottom: 0xb8a882 });
      if (o.extra) o.extra(ctx, rng);
    },
  });
}

defineSkin('cow', cowSkin({ body: 0x443626, head: 0x3a2d20, legs: 0x2e2419, spots: 0xdcd3c4, muzzle: 0xd8b0a8 }));
defineSkin('mooshroom', cowSkin({
  body: 0xa11616, head: 0x8f1212, legs: 0x741010, spots: 0xdbd0c0, muzzle: 0xd8b0a8,
  extra: (ctx, rng) => {
    // red mushrooms sprouting from the hide
    for (let i = 0; i < 14; i++) {
      const x = 16 + rng.int(46), y = 4 + rng.int(52);
      rect(ctx, x, y, 3, 2, 0xc42b2b);
      px(ctx, x + 1, y + 2, 0xe0d8c8);
      px(ctx, x, y, 0xe8e0d0); px(ctx, x + 2, y + 1, 0xe8e0d0);
    }
  },
}));
defineSkin('brown_mooshroom', cowSkin({
  body: 0x8a5a2b, head: 0x7a4e24, legs: 0x63401d, spots: 0xd8cdb8, muzzle: 0xd8b0a8,
  extra: (ctx, rng) => {
    for (let i = 0; i < 14; i++) {
      const x = 16 + rng.int(46), y = 4 + rng.int(52);
      rect(ctx, x, y, 3, 2, 0xa06a3a);
      px(ctx, x + 1, y + 2, 0xd8cdb8);
    }
  },
}));

/** Sheep sheet: fleece everywhere plus a cream face and hooves. */
function sheepSkin(wool, o) {
  o = o || {};
  return (ctx, rng) => {
    const w = toHex(wool);
    const face = toHex(o.face !== undefined ? o.face : 0xd7d0c0);
    fillAll(ctx, w, rng, 0.11);
    // fluffy clumps over the whole fleece
    for (let i = 0; i < 130; i++) {
      const x = rng.int(62), y = rng.int(62);
      rect(ctx, x, y, 2, 2, rng.bool() ? shadeHex(w, 1.12) : shadeHex(w, 0.86), 0.7);
    }
    box(ctx, 0, 16, 4, 12, 4, {
      all: toHex(o.legs !== undefined ? o.legs : 0xb8b2a4),
      top: 0xc8c2b4, bottom: 0x4a443a,
    });
    bandBottom(ctx, 0, 16, 4, 12, 4, 2, 0x4a443a);
    box(ctx, 0, 0, 8, 8, 8, { all: face, top: shadeHex(face, 1.05), bottom: shadeHex(face, 0.78) });
    rect(ctx, FX + 1, FY + 2, 2, 2, 0x1a1410);
    rect(ctx, FX + 5, FY + 2, 2, 2, 0x1a1410);
    px(ctx, FX + 1, FY + 2, 0xffffff, 0.3); px(ctx, FX + 5, FY + 2, 0xffffff, 0.3);
    rect(ctx, FX + 2, FY + 5, 4, 3, shadeHex(face, 0.86));
    px(ctx, FX + 2, FY + 6, 0x584a3a); px(ctx, FX + 5, FY + 6, 0x584a3a);
    rect(ctx, FX - 1, FY + 2, 1, 2, shadeHex(face, 0.9));   // ears
    rect(ctx, FX + 8, FY + 2, 1, 2, shadeHex(face, 0.9));
    if (o.extra) o.extra(ctx, rng);
  };
}

defineSkin('sheep', sheepSkin(0xf0f0f0));
for (const dye in DYE_COLORS) defineSkin('sheep_' + dye, sheepSkin(DYE_COLORS[dye]));
defineSkin('sheep_sheared', (ctx, rng) => {
  fillAll(ctx, 0xd6a8a2, rng, 0.1);
  box(ctx, 0, 0, 8, 8, 8, { all: 0xd7d0c0, top: 0xe0d9c9, bottom: 0xa8a294 });
  rect(ctx, FX + 1, FY + 2, 2, 2, 0x1a1410);
  rect(ctx, FX + 5, FY + 2, 2, 2, 0x1a1410);
  rect(ctx, FX + 2, FY + 5, 4, 3, 0xc0b7a4);
  box(ctx, 0, 16, 4, 12, 4, { all: 0xb8b2a4, bottom: 0x4a443a });
  speckle(ctx, 16, 8, 48, 32, 0xe0b4ae, 70, rng);
});

defineSkin('chicken', (ctx, rng) => {
  const white = 0xe5e5e5;
  fillAll(ctx, white, rng, 0.09);
  // vanilla chicken layout
  box(ctx, 0, 9, 6, 8, 6, { all: white, top: 0xf2f2f2, bottom: 0xc4c4c4 });   // body
  box(ctx, 0, 0, 4, 6, 3, { all: white, top: 0xf2f2f2, bottom: 0xc4c4c4 });   // head
  box(ctx, 14, 0, 4, 2, 2, { all: 0xffc300, top: 0xffd84a, bottom: 0xd89a00 }); // beak
  box(ctx, 14, 4, 2, 2, 2, { all: 0xb02929, top: 0xd03a3a, bottom: 0x8a1c1c }); // wattle
  box(ctx, 26, 0, 3, 5, 3, { all: 0xffa000, top: 0xffbb3a, bottom: 0xc87a00 }); // legs
  box(ctx, 24, 13, 1, 4, 6, { all: white, top: 0xf6f6f6, bottom: 0xbdbdbd });   // wings
  // eyes on the head front face (uv 0,0 - 4x6x3 -> front at (3,3) 4x6)
  rect(ctx, 3, 4, 1, 2, 0x191919);
  rect(ctx, 6, 4, 1, 2, 0x191919);
  rect(ctx, 4, 1, 2, 2, 0xb02929);       // comb on top of the head
  speckle(ctx, 0, 0, 64, 64, 0xf4f4f4, 90, rng);
  speckle(ctx, 0, 0, 64, 64, 0xcfcfcf, 40, rng);
});

// ---- Rabbits ---------------------------------------------------------------

function rabbitSkin(coat, o) {
  o = o || {};
  return quadrupedSkin({
    body: toHex(coat), head: toHex(coat),
    legs: shadeHex(toHex(coat), 0.9), hoof: shadeHex(toHex(coat), 0.7),
    belly: toHex(o.belly !== undefined ? o.belly : shadeHex(toHex(coat), 1.25)),
    eye: o.eye !== undefined ? o.eye : 0x2a1c14, grain: 0.12,
    extra: (ctx, rng) => {
      rect(ctx, FX + 1, FY, 2, 3, shadeHex(toHex(coat), 1.1));   // ears
      rect(ctx, FX + 5, FY, 2, 3, shadeHex(toHex(coat), 1.1));
      rect(ctx, FX + 3, FY + 5, 2, 2, 0xdba7a2);                 // pink nose
      px(ctx, FX + 3, FY + 7, 0x8a6a62);
      if (o.splotch !== undefined && o.splotch !== null) {
        patches(ctx, 16, 8, 48, 30, toHex(o.splotch), rng, 9, 2, 5);
      }
      speckle(ctx, 0, 0, 64, 64, shadeHex(toHex(coat), 0.86), 70, rng);
    },
  });
}

defineSkin('rabbit', rabbitSkin(0x9b6a4a));
defineSkin('rabbit_brown', rabbitSkin(0x9b6a4a));
defineSkin('rabbit_white', rabbitSkin(0xe8e4dc, { eye: 0xb03a3a }));
defineSkin('rabbit_black', rabbitSkin(0x2e2822, { belly: 0x4a4238 }));
defineSkin('rabbit_white_splotched', rabbitSkin(0xe8e4dc, { splotch: 0x8a5a3a, eye: 0x8a3a3a }));
defineSkin('rabbit_gold', rabbitSkin(0xd8a94a));
defineSkin('rabbit_salt', rabbitSkin(0x6b625a, { splotch: 0xbdb4a8 }));
defineSkin('rabbit_evil', rabbitSkin(0xf0eee8, { eye: 0xd01818 }));

// ---- Horses, donkeys, llamas ----------------------------------------------

function horseSkin(coat, mane, o) {
  o = o || {};
  return quadrupedSkin({
    body: toHex(coat), head: toHex(coat), legs: shadeHex(toHex(coat), 0.9),
    hoof: 0x3a332a, belly: shadeHex(toHex(coat), 1.12), grain: 0.1,
    eye: o.eye !== undefined ? o.eye : 0x1e1610, sclera: o.sclera,
    extra: (ctx, rng) => {
      const m = toHex(mane);
      rect(ctx, FX + 1, FY, 6, 2, m);                    // forelock
      rect(ctx, FX, FY, 1, 3, m); rect(ctx, FX + 7, FY, 1, 3, m);
      rect(ctx, FX + 2, FY + 5, 4, 3, shadeHex(toHex(coat), 0.82));   // muzzle
      px(ctx, FX + 2, FY + 6, 0x2a1e16); px(ctx, FX + 5, FY + 6, 0x2a1e16);
      rect(ctx, FX - 1, FY - 1, 1, 2, m); rect(ctx, FX + 8, FY - 1, 1, 2, m);  // ears
      rect(ctx, 36, 16, 10, 2, m);                       // mane down the neck/back
      rect(ctx, 54, 16, 10, 3, m);                       // tail
      if (o.marks !== undefined && o.marks !== null) {
        patches(ctx, 16, 8, 48, 28, toHex(o.marks), rng, 9, 3, 6);
      }
      speckle(ctx, 0, 0, 64, 64, shadeHex(toHex(coat), 0.88), 70, rng);
      if (o.extra) o.extra(ctx, rng);
    },
  });
}

defineSkin('horse', horseSkin(0xc09153, 0x6b4a24));
defineSkin('horse_white', horseSkin(0xeeeadb, 0xd8d0c0));
defineSkin('horse_creamy', horseSkin(0xc09153, 0x6b4a24));
defineSkin('horse_chestnut', horseSkin(0x915b30, 0x4f2f19));
defineSkin('horse_brown', horseSkin(0x69422a, 0x2f1c11));
defineSkin('horse_black', horseSkin(0x2f261e, 0x171310));
defineSkin('horse_gray', horseSkin(0x9d9382, 0x6b6357));
defineSkin('horse_dark_brown', horseSkin(0x4a3122, 0x241811));
defineSkin('donkey', horseSkin(0x827466, 0x4a4038, {
  extra: (ctx) => { rect(ctx, FX - 1, FY - 3, 1, 4, 0x4a4038); rect(ctx, FX + 8, FY - 3, 1, 4, 0x4a4038); },
}));
defineSkin('mule', horseSkin(0x6b4f3a, 0x2f2118, {
  extra: (ctx) => { rect(ctx, FX - 1, FY - 3, 1, 4, 0x2f2118); rect(ctx, FX + 8, FY - 3, 1, 4, 0x2f2118); },
}));
defineSkin('skeleton_horse', horseSkin(0xc4c4c4, 0x9a9a9a, {
  eye: 0x151515,
  extra: (ctx, rng) => {
    stripes(ctx, 28, 12, 36, 20, 0x9a9a9a, 3, 1, false);   // ribs
    rect(ctx, FX + 1, FY + 2, 2, 3, 0x1a1a1a);
    rect(ctx, FX + 5, FY + 2, 2, 3, 0x1a1a1a);
    speckle(ctx, 0, 0, 64, 64, 0xa8a8a8, 60, rng);
  },
}));
defineSkin('zombie_horse', horseSkin(0x4a7a4a, 0x2c4a2c, {
  eye: 0x0f1f0f,
  extra: (ctx, rng) => { speckle(ctx, 0, 0, 64, 64, 0x2f6b1e, 90, rng); },
}));

function llamaSkin(fleece, o) {
  o = o || {};
  return quadrupedSkin({
    body: toHex(fleece), head: shadeHex(toHex(fleece), 1.05),
    legs: shadeHex(toHex(fleece), 0.88), hoof: 0x3a332a,
    belly: shadeHex(toHex(fleece), 1.15), grain: 0.13, eye: 0x1e1610,
    extra: (ctx, rng) => {
      rect(ctx, FX + 1, FY - 1, 2, 3, shadeHex(toHex(fleece), 0.9));  // tall ears
      rect(ctx, FX + 5, FY - 1, 2, 3, shadeHex(toHex(fleece), 0.9));
      rect(ctx, FX + 2, FY + 5, 4, 3, shadeHex(toHex(fleece), 1.12)); // muzzle
      px(ctx, FX + 2, FY + 6, 0x3a2e24); px(ctx, FX + 5, FY + 6, 0x3a2e24);
      for (let i = 0; i < 110; i++) {                                  // shaggy wool
        const x = rng.int(63), y = rng.int(63);
        rect(ctx, x, y, 1, 2, shadeHex(toHex(fleece), rng.bool() ? 1.14 : 0.85), 0.65);
      }
      if (o.carpet !== undefined && o.carpet !== null) {
        rect(ctx, 36, 18, 10, 5, toHex(o.carpet));                     // decor carpet
        rect(ctx, 36, 20, 10, 1, shadeHex(toHex(o.carpet), 1.3));
      }
    },
  });
}

defineSkin('llama', llamaSkin(0xd9c6a0));
defineSkin('llama_creamy', llamaSkin(0xd9c6a0));
defineSkin('llama_white', llamaSkin(0xe8e4da));
defineSkin('llama_brown', llamaSkin(0x8a6a46));
defineSkin('llama_gray', llamaSkin(0x9a958c));
defineSkin('trader_llama', llamaSkin(0xd9c6a0, { carpet: 0x35399d }));

// ---- Pets ------------------------------------------------------------------

function catSkin(coat, o) {
  o = o || {};
  return quadrupedSkin({
    body: toHex(coat), head: toHex(coat), legs: shadeHex(toHex(coat), 0.92),
    hoof: shadeHex(toHex(coat), 0.7),
    belly: toHex(o.belly !== undefined ? o.belly : shadeHex(toHex(coat), 1.25)),
    grain: 0.1, eye: o.eye !== undefined ? o.eye : 0x3fbf6f, sclera: 0xf4f0d8,
    pattern: (ctx, rng) => {
      if (o.stripe !== undefined && o.stripe !== null) {
        stripes(ctx, 16, 6, 48, 30, toHex(o.stripe), 5, 2, true);
      }
      if (o.blotch !== undefined && o.blotch !== null) {
        patches(ctx, 16, 6, 48, 30, toHex(o.blotch), rng, 10, 3, 6);
      }
    },
    extra: (ctx, rng) => {
      rect(ctx, FX, FY - 1, 2, 3, shadeHex(toHex(coat), 0.85));   // pointed ears
      rect(ctx, FX + 6, FY - 1, 2, 3, shadeHex(toHex(coat), 0.85));
      rect(ctx, FX + 3, FY + 5, 2, 2, 0xd8a0a0);                  // nose
      rect(ctx, FX + 2, FY + 7, 4, 1, shadeHex(toHex(coat), 0.6));
      if (o.collar !== undefined && o.collar !== null) rect(ctx, 16, 20, 24, 2, toHex(o.collar));
      speckle(ctx, 0, 0, 64, 64, shadeHex(toHex(coat), 0.88), 60, rng);
      if (o.extra) o.extra(ctx, rng);
    },
  });
}

defineSkin('cat', catSkin(0x8a7358, { stripe: 0x5f4c39 }));
defineSkin('cat_tabby', catSkin(0x8a7358, { stripe: 0x5f4c39 }));
defineSkin('cat_black', catSkin(0x24211d, { belly: 0x35312b, eye: 0xf0c840 }));
defineSkin('cat_all_black', catSkin(0x151412, { belly: 0x22201d, eye: 0xf0c840 }));
defineSkin('cat_red', catSkin(0xc27a3a, { stripe: 0x9a5a24 }));
defineSkin('cat_siamese', catSkin(0xd9cdb8, { blotch: 0x6b5a4a, eye: 0x5fa8d8 }));
defineSkin('cat_british_shorthair', catSkin(0x8f9aa0, { belly: 0xb8c0c4, eye: 0xf0a840 }));
defineSkin('cat_calico', catSkin(0xe4dcc8, { blotch: 0xc27a3a, stripe: 0x3a3128 }));
defineSkin('cat_persian', catSkin(0xd8b98a, { belly: 0xeddcc0, eye: 0x5fa8d8 }));
defineSkin('cat_ragdoll', catSkin(0xe8e2d6, { blotch: 0x8a7358, eye: 0x5fa8d8 }));
defineSkin('cat_white', catSkin(0xefece4, { eye: 0x5fa8d8 }));
defineSkin('cat_jellie', catSkin(0xdedad2, { blotch: 0x4a4640, stripe: 0x36332e }));
defineSkin('ocelot', catSkin(0xefc66e, {
  belly: 0xf6e0b0, eye: 0x2a7a3a,
  extra: (ctx, rng) => { speckle(ctx, 16, 6, 48, 30, 0x3a2a18, 70, rng, 2); },
}));

function wolfSkin(coat, o) {
  o = o || {};
  return quadrupedSkin({
    body: toHex(coat), head: shadeHex(toHex(coat), 1.04), legs: shadeHex(toHex(coat), 0.92),
    hoof: shadeHex(toHex(coat), 0.66),
    belly: toHex(o.belly !== undefined ? o.belly : shadeHex(toHex(coat), 1.2)),
    grain: 0.11, eye: o.eye !== undefined ? o.eye : 0xd8d0c4, sclera: null,
    extra: (ctx, rng) => {
      rect(ctx, FX + 1, FY + 2, 2, 2, o.eye !== undefined ? toHex(o.eye) : 0xdcd4c8);
      rect(ctx, FX + 5, FY + 2, 2, 2, o.eye !== undefined ? toHex(o.eye) : 0xdcd4c8);
      px(ctx, FX + 2, FY + 2, 0x1a1a1a); px(ctx, FX + 5, FY + 2, 0x1a1a1a);
      rect(ctx, FX, FY - 1, 2, 3, shadeHex(toHex(coat), 0.82));   // ears
      rect(ctx, FX + 6, FY - 1, 2, 3, shadeHex(toHex(coat), 0.82));
      rect(ctx, FX + 3, FY + 5, 2, 3, 0x1c1814);                  // black snout
      rect(ctx, FX + 2, FY + 7, 4, 1, 0x2a2420);
      if (o.collar !== undefined && o.collar !== null) {
        rect(ctx, 16, 20, 24, 2, toHex(o.collar));
        rect(ctx, 20, 21, 4, 1, shadeHex(toHex(o.collar), 1.3));
      }
      speckle(ctx, 0, 0, 64, 64, shadeHex(toHex(coat), 0.85), 80, rng);
      rect(ctx, 36, 16, 10, 2, shadeHex(toHex(coat), 0.8));       // darker spine
    },
  });
}

defineSkin('wolf', wolfSkin(0xd7d3d2));
defineSkin('wolf_tame', wolfSkin(0xd7d3d2, { collar: 0xa12722 }));
defineSkin('wolf_angry', wolfSkin(0xd7d3d2, { eye: 0xd01818 }));
defineSkin('fox', quadrupedSkin({
  body: 0xc86a2c, head: 0xd07a34, legs: 0x4a3428, hoof: 0x2e2018, belly: 0xead8c0,
  grain: 0.11, eye: 0x2a1c12, sclera: 0xf0e6d0,
  extra: (ctx, rng) => {
    rect(ctx, FX, FY - 1, 2, 3, 0x4a3428);                        // dark ear tips
    rect(ctx, FX + 6, FY - 1, 2, 3, 0x4a3428);
    rect(ctx, FX + 2, FY + 4, 4, 4, 0xf0e4d0);                    // white muzzle
    rect(ctx, FX + 3, FY + 5, 2, 2, 0x2a1c14);
    rect(ctx, 54, 16, 10, 4, 0xf0e6d8);                           // white tail tip
    speckle(ctx, 0, 0, 64, 64, 0xa8531f, 70, rng);
  },
}));
defineSkin('fox_snow', quadrupedSkin({
  body: 0xe9e4de, head: 0xf0ece6, legs: 0xbfb8b0, hoof: 0x8a837c, belly: 0xf6f3ee,
  grain: 0.1, eye: 0x2a2420, sclera: 0xf6f3ee,
  extra: (ctx, rng) => {
    rect(ctx, FX, FY - 1, 2, 3, 0xbfb8b0);
    rect(ctx, FX + 6, FY - 1, 2, 3, 0xbfb8b0);
    rect(ctx, FX + 3, FY + 5, 2, 2, 0x2a2420);
    speckle(ctx, 0, 0, 64, 64, 0xd4cec6, 70, rng);
  },
}));

function parrotSkin(body, wing, tail) {
  return (ctx, rng) => {
    fillAll(ctx, toHex(body), rng, 0.11);
    box(ctx, 2, 2, 2, 3, 2, { all: toHex(body), top: shadeHex(toHex(body), 1.12) });   // head
    box(ctx, 2, 8, 4, 5, 3, { all: toHex(body), top: shadeHex(toHex(body), 1.1) });    // torso
    rect(ctx, 22, 1, 8, 12, toHex(wing));                                              // wings
    rect(ctx, 22, 1, 8, 3, shadeHex(toHex(wing), 1.2));
    rect(ctx, 40, 4, 10, 14, toHex(tail));                                             // tail
    rect(ctx, 2, 20, 8, 6, 0xe8b024);                                                  // feet + beak block
    px(ctx, 4, 4, 0x141414); px(ctx, 7, 4, 0x141414);                                  // eyes
    rect(ctx, 5, 5, 2, 2, 0x3a3a3a);                                                   // beak
    speckle(ctx, 0, 0, 64, 64, shadeHex(toHex(body), 1.18), 60, rng);
  };
}

defineSkin('parrot', parrotSkin(0xd03434, 0x2b6ad0, 0x2fa04a));
defineSkin('parrot_red_blue', parrotSkin(0xd03434, 0x2b6ad0, 0x2fa04a));
defineSkin('parrot_blue', parrotSkin(0x2b6ad0, 0x1f4fa0, 0xe8b024));
defineSkin('parrot_green', parrotSkin(0x2fa04a, 0x1c7a34, 0xd03434));
defineSkin('parrot_yellow_blue', parrotSkin(0xe8c424, 0x2b6ad0, 0x2b6ad0));
defineSkin('parrot_gray', parrotSkin(0xa8a49c, 0x7a7670, 0xd03434));

// ===========================================================================
// Other overworld animals
// ===========================================================================

defineSkin('goat', quadrupedSkin({
  body: 0xe6e1d5, head: 0xefeae0, legs: 0xb9b2a4, hoof: 0x3a332a, belly: 0xf2eee6,
  grain: 0.11, eye: 0x2a241c, sclera: 0xf0ece2,
  extra: (ctx, rng) => {
    rect(ctx, FX + 1, FY - 3, 1, 4, 0x4a3a2e); rect(ctx, FX + 6, FY - 3, 1, 4, 0x4a3a2e); // horns
    rect(ctx, FX + 2, FY + 5, 4, 3, 0xd8d2c6);
    rect(ctx, FX + 3, FY + 7, 2, 1, 0x6b6053);                       // beard
    speckle(ctx, 0, 0, 64, 64, 0xcac4b6, 70, rng);
  },
}));
defineSkin('polar_bear', quadrupedSkin({
  body: 0xf2efe7, head: 0xf6f3ec, legs: 0xdcd8ce, hoof: 0x8a857c, belly: 0xfaf8f3,
  grain: 0.09, eye: 0x2e2a26,
  extra: (ctx, rng) => {
    rect(ctx, FX + 1, FY, 2, 2, 0xe0dcd2); rect(ctx, FX + 5, FY, 2, 2, 0xe0dcd2);
    rect(ctx, FX + 3, FY + 5, 2, 2, 0x2e2a26);
    speckle(ctx, 0, 0, 64, 64, 0xe4e0d6, 80, rng);
  },
}));
defineSkin('panda', quadrupedSkin({
  body: 0xe7e7e7, head: 0xefefef, legs: 0x2e2e2e, hoof: 0x1a1a1a, belly: 0xf4f4f4,
  grain: 0.08, eye: 0x141414,
  pattern: (ctx) => { rect(ctx, 36, 16, 10, 5, 0x2e2e2e); rect(ctx, 36, 28, 10, 4, 0x2e2e2e); },
  extra: (ctx, rng) => {
    rect(ctx, FX, FY - 1, 2, 3, 0x2e2e2e); rect(ctx, FX + 6, FY - 1, 2, 3, 0x2e2e2e);  // ears
    rect(ctx, FX, FY + 1, 3, 3, 0x2e2e2e); rect(ctx, FX + 5, FY + 1, 3, 3, 0x2e2e2e);  // eye patches
    px(ctx, FX + 1, FY + 2, 0xf0f0f0); px(ctx, FX + 6, FY + 2, 0xf0f0f0);
    rect(ctx, FX + 3, FY + 5, 2, 2, 0x1a1a1a);
    speckle(ctx, 0, 0, 64, 64, 0xdadada, 50, rng);
  },
}));
defineSkin('panda_brown', quadrupedSkin({
  body: 0xd8c9a8, head: 0xe0d2b4, legs: 0x6b4a2c, hoof: 0x4a3320, belly: 0xe8dcc4,
  grain: 0.09, eye: 0x141414,
  extra: (ctx) => {
    rect(ctx, FX, FY + 1, 3, 3, 0x6b4a2c); rect(ctx, FX + 5, FY + 1, 3, 3, 0x6b4a2c);
    rect(ctx, FX + 3, FY + 5, 2, 2, 0x3a2a18);
  },
}));
defineSkin('camel', quadrupedSkin({
  body: 0xe0b579, head: 0xe8c089, legs: 0xcfa268, hoof: 0x6b5237, belly: 0xefd3a4,
  grain: 0.11, eye: 0x2a2018, sclera: 0xf2e8d4,
  extra: (ctx, rng) => {
    rect(ctx, 36, 14, 10, 4, 0xc99a5c);                              // hump
    rect(ctx, FX + 2, FY + 5, 4, 3, 0xf0d8ac);
    px(ctx, FX + 2, FY + 6, 0x6b5237); px(ctx, FX + 5, FY + 6, 0x6b5237);
    rect(ctx, FX, FY, 1, 2, 0xcfa268); rect(ctx, FX + 7, FY, 1, 2, 0xcfa268);
    speckle(ctx, 0, 0, 64, 64, 0xd0a468, 70, rng);
  },
}));
defineSkin('sniffer', quadrupedSkin({
  body: 0x9e6b4e, head: 0xb07a5a, legs: 0x7a5138, hoof: 0x3f2a1c, belly: 0xc59473,
  grain: 0.12, eye: 0x241812,
  extra: (ctx, rng) => {
    rect(ctx, FX + 1, FY + 4, 6, 4, 0xd8a184);                       // huge nose
    px(ctx, FX + 2, FY + 6, 0x4a2f22); px(ctx, FX + 5, FY + 6, 0x4a2f22);
    rect(ctx, FX, FY + 1, 2, 4, 0x7a5138); rect(ctx, FX + 6, FY + 1, 2, 4, 0x7a5138); // ears
    rect(ctx, 36, 16, 10, 3, 0x6f4a34);
    speckle(ctx, 0, 0, 64, 64, 0x8a5c40, 80, rng);
  },
}));
defineSkin('armadillo', quadrupedSkin({
  body: 0x7a5b44, head: 0x8a6a50, legs: 0x5f4634, hoof: 0x33241a, belly: 0xc7a57f,
  grain: 0.13, eye: 0x1a1208,
  pattern: (ctx) => { stripes(ctx, 28, 8, 36, 24, 0x5c4433, 3, 1, false); },
  extra: (ctx, rng) => {
    rect(ctx, FX + 3, FY + 5, 2, 2, 0x33241a);
    rect(ctx, FX, FY, 2, 2, 0x5f4634); rect(ctx, FX + 6, FY, 2, 2, 0x5f4634);
    speckle(ctx, 0, 0, 64, 64, 0x93765c, 70, rng);
  },
}));
defineSkin('strider', quadrupedSkin({
  body: 0xa24c4c, head: 0xb05656, legs: 0x9a8ab8, hoof: 0x6b5f8a, belly: 0x8a3f3f,
  grain: 0.15, eye: 0xf0e0c0, sclera: null,
  extra: (ctx, rng) => {
    for (let i = 0; i < 120; i++) {                                  // fungal fuzz
      const x = rng.int(63), y = rng.int(62);
      rect(ctx, x, y, 1, 2, rng.bool() ? 0x8a3a3a : 0xc26a6a, 0.7);
    }
    rect(ctx, FX + 1, FY + 2, 2, 2, 0xf6ead2); rect(ctx, FX + 5, FY + 2, 2, 2, 0xf6ead2);
    px(ctx, FX + 2, FY + 2, 0x2a1818); px(ctx, FX + 5, FY + 2, 0x2a1818);
    rect(ctx, FX + 2, FY + 6, 4, 1, 0x3a1c1c);
  },
}));
defineSkin('strider_cold', quadrupedSkin({
  body: 0x6c57a2, head: 0x7a63b0, legs: 0x9a8ab8, hoof: 0x5a4f7a, belly: 0x5a4788,
  grain: 0.15, eye: 0xf0e0c0, sclera: null,
  extra: (ctx, rng) => { speckle(ctx, 0, 0, 64, 64, 0x8a76c0, 90, rng); },
}));
defineSkin('bee', (ctx, rng) => {
  fillAll(ctx, 0xf3be3c, rng, 0.1);
  box(ctx, 0, 0, 7, 7, 7, { all: 0xf3be3c, top: 0xf8d068, bottom: 0xc99a24 });   // body
  stripes(ctx, 0, 0, 64, 64, 0x3a2a14, 6, 3, false);                             // black bands
  rect(ctx, 0, 0, 28, 8, 0x4a3a20);                                              // dark head cap
  rect(ctx, 7, 7, 7, 7, 0xf3be3c);
  rect(ctx, 8, 9, 2, 2, 0x14100c); rect(ctx, 11, 9, 2, 2, 0x14100c);             // eyes
  rect(ctx, 9, 12, 3, 1, 0x3a2a14);
  rect(ctx, 40, 4, 12, 8, 0xd9eaf2, 0.85);                                       // wings
  rect(ctx, 40, 14, 12, 6, 0xd9eaf2, 0.7);
  rect(ctx, 56, 20, 3, 4, 0x2a2018);                                             // stinger
  speckle(ctx, 0, 0, 64, 64, 0xffd868, 60, rng);
});
defineSkin('turtle', quadrupedSkin({
  body: 0x3e7a2e, head: 0xa9cb7b, legs: 0x8fb469, hoof: 0x6b8a4c, belly: 0xe1e1b9,
  grain: 0.1, eye: 0x141414, sclera: 0xf0f0d8,
  pattern: (ctx, rng) => {
    for (let y = 8; y < 36; y += 5) for (let x = 28; x < 64; x += 6) {
      rect(ctx, x, y, 5, 4, rng.bool() ? 0x357026 : 0x4c8f38);
      outline(ctx, x, y, 5, 4, 0x2a5c1e);
    }
  },
  extra: (ctx) => { rect(ctx, FX + 2, FY + 5, 4, 2, 0x8fb469); rect(ctx, FX + 2, FY + 7, 4, 1, 0x5f7a44); },
}));
defineSkin('cod', fishSkin({ body: 0xc8b385, top: 0x6b5b3e, belly: 0xe4dcc0, stripe: 0x8a7a56 }));
defineSkin('salmon', fishSkin({ body: 0xa24040, top: 0x5a6470, belly: 0xd8b0a0, spots: 0x7a2a2a }));
defineSkin('tropical_fish', fishSkin({ body: 0xf0c020, top: 0xd85a20, belly: 0xf6e090, stripe: 0xffffff, stripeStep: 8 }));
defineSkin('pufferfish', (ctx, rng) => {
  fillAll(ctx, 0xf5c542, rng, 0.11);
  rect(ctx, 0, 0, 64, 14, 0xd89a10);
  rect(ctx, 0, 44, 64, 20, 0xf8e08a);
  for (let i = 0; i < 60; i++) {                                    // spines
    const x = rng.int(62), y = 6 + rng.int(46);
    rect(ctx, x, y, 2, 1, 0x8a6a10);
  }
  rect(ctx, 4, 16, 4, 4, 0xf6f6f6); rect(ctx, 5, 17, 3, 3, 0x141414);
  rect(ctx, 4, 26, 6, 2, 0x8a5a10);
});
defineSkin('squid', (ctx, rng) => {
  fillAll(ctx, 0x223c5a, rng, 0.1);
  box(ctx, 0, 0, 12, 16, 12, { all: 0x223c5a, top: 0x2e4f74, bottom: 0x162a40 });
  rect(ctx, 48, 0, 16, 32, 0x1b3049);                                // tentacles
  stripes(ctx, 48, 0, 16, 32, 0x2b4a6e, 4, 1, true);
  rect(ctx, 16, 16, 2, 2, 0xe8e8e8); rect(ctx, 22, 16, 2, 2, 0xe8e8e8);
  px(ctx, 17, 17, 0x101010); px(ctx, 22, 17, 0x101010);
  speckle(ctx, 0, 0, 64, 64, 0x2e5480, 70, rng);
});
defineSkin('glow_squid', (ctx, rng) => {
  fillAll(ctx, 0x0e4e5e, rng, 0.1);
  box(ctx, 0, 0, 12, 16, 12, { all: 0x0e4e5e, top: 0x146a7c, bottom: 0x083440 });
  rect(ctx, 48, 0, 16, 32, 0x0b3f4d);
  for (let i = 0; i < 70; i++) px(ctx, rng.int(64), rng.int(64), 0x55e0e0);
  rect(ctx, 16, 16, 2, 2, 0x9ff8f8); rect(ctx, 22, 16, 2, 2, 0x9ff8f8);
  rect(ctx, 12, 12, 12, 2, 0x2fd0d8, 0.6);
});
defineSkin('dolphin', fishSkin({
  body: 0x6d8296, top: 0x22364f, belly: 0xd8dee2,
  extra: (ctx) => { rect(ctx, 4, 16, 3, 3, 0xf2f2f2); rect(ctx, 5, 17, 2, 2, 0x101010); rect(ctx, 20, 2, 8, 8, 0x1b2c40); },
}));
defineSkin('tadpole', (ctx, rng) => {
  fillAll(ctx, 0x4b4239, rng, 0.13);
  box(ctx, 0, 0, 4, 4, 4, { all: 0x584e43, top: 0x6a5e50, bottom: 0x3a332c });
  rect(ctx, 24, 4, 20, 6, 0x3a332c, 0.8);                            // tail fin
  px(ctx, 5, 5, 0xf0f0f0); px(ctx, 8, 5, 0xf0f0f0);
  px(ctx, 5, 5, 0x141414); px(ctx, 8, 5, 0x141414);
});
defineSkin('bat', (ctx, rng) => {
  fillAll(ctx, 0x4c3824, rng, 0.13);
  box(ctx, 0, 0, 6, 6, 6, { all: 0x54402a, top: 0x66503a, bottom: 0x33261a });
  rect(ctx, 24, 0, 40, 28, 0x33261a);                                // wing membranes
  stripes(ctx, 24, 0, 40, 28, 0x241b12, 6, 1, true);
  rect(ctx, 6, 6, 2, 2, 0x1a1410); rect(ctx, 10, 6, 2, 2, 0x1a1410); // eyes
  px(ctx, 6, 6, 0xd05050); px(ctx, 11, 6, 0xd05050);
  rect(ctx, 6, 1, 2, 3, 0x3f2f1e); rect(ctx, 10, 1, 2, 3, 0x3f2f1e); // ears
  speckle(ctx, 0, 0, 64, 64, 0x63492e, 60, rng);
});

function axolotlSkin(body, gill) {
  return (ctx, rng) => {
    fillAll(ctx, toHex(body), rng, 0.1);
    box(ctx, 0, 0, 8, 5, 6, { all: toHex(body), top: shadeHex(toHex(body), 1.1), bottom: shadeHex(toHex(body), 0.82) });
    rect(ctx, 0, 24, 64, 12, shadeHex(toHex(body), 1.2));            // pale belly band
    rect(ctx, 36, 2, 12, 10, toHex(gill));                           // gill fronds
    rect(ctx, 50, 2, 12, 10, toHex(gill));
    rect(ctx, FX + 1, FY - 2, 1, 2, 0x141414);
    rect(ctx, 3, 7, 2, 2, 0x1a1a1a); rect(ctx, 9, 7, 2, 2, 0x1a1a1a);
    speckle(ctx, 0, 0, 64, 64, shadeHex(toHex(body), 1.14), 60, rng);
  };
}

defineSkin('axolotl', axolotlSkin(0xfbc2e0, 0xf58ac8));
defineSkin('axolotl_lucy', axolotlSkin(0xfbc2e0, 0xf58ac8));
defineSkin('axolotl_wild', axolotlSkin(0x9c6247, 0xc07a5a));
defineSkin('axolotl_gold', axolotlSkin(0xf0d05a, 0xe8b030));
defineSkin('axolotl_cyan', axolotlSkin(0xe8f0f0, 0xa8d8d8));
defineSkin('axolotl_blue', axolotlSkin(0x4a6fd0, 0x8aa8f0));

function frogSkin(body, belly, throat) {
  return (ctx, rng) => {
    fillAll(ctx, toHex(body), rng, 0.12);
    box(ctx, 0, 0, 8, 4, 8, { all: toHex(body), top: shadeHex(toHex(body), 1.12), bottom: toHex(belly) });
    rect(ctx, 0, 32, 64, 16, toHex(belly));
    rect(ctx, 24, 16, 12, 6, toHex(throat));                         // vocal sac
    rect(ctx, FX + 1, FY - 4, 2, 2, 0xf0e8c0); rect(ctx, FX + 5, FY - 4, 2, 2, 0xf0e8c0);
    px(ctx, FX + 2, FY - 4, 0x141414); px(ctx, FX + 5, FY - 4, 0x141414);
    speckle(ctx, 0, 0, 64, 64, shadeHex(toHex(body), 0.8), 70, rng);
  };
}

defineSkin('frog', frogSkin(0x6ea23f, 0xd8d0a8, 0xc8b84a));
defineSkin('frog_temperate', frogSkin(0x6ea23f, 0xd8d0a8, 0xc8b84a));
defineSkin('frog_warm', frogSkin(0xe39b4d, 0xf0d8b0, 0xd8703a));
defineSkin('frog_cold', frogSkin(0x5f8f8a, 0xcfe0da, 0x3f6f6a));

// ===========================================================================
// Arthropods, blobs and nether mobs
// ===========================================================================

function spiderSkin(body, o) {
  o = o || {};
  return (ctx, rng) => {
    const b = toHex(body);
    fillAll(ctx, b, rng, 0.13);
    // vanilla spider layout: head (32,4) 8x8x8, thorax (0,0) 6x6x6,
    // abdomen (0,12) 10x8x12, legs (18,0) 16x8x1
    rect(ctx, 18, 0, 34, 9, shadeHex(b, 0.7));                        // legs
    stripes(ctx, 18, 0, 34, 9, shadeHex(b, 0.5), 3, 1, false);
    box(ctx, 0, 0, 6, 6, 6, { all: b, top: shadeHex(b, 1.15), bottom: shadeHex(b, 0.7) });
    box(ctx, 0, 12, 10, 8, 12, { all: b, top: shadeHex(b, 1.1), bottom: shadeHex(b, 0.65) });
    box(ctx, 32, 4, 8, 8, 8, { all: shadeHex(b, 1.06), top: shadeHex(b, 1.18), bottom: shadeHex(b, 0.7) });
    for (let i = 0; i < 170; i++) {                                   // bristly hairs
      const x = rng.int(63), y = rng.int(62);
      rect(ctx, x, y, 1, 2, shadeHex(b, rng.bool() ? 1.25 : 0.7), 0.6);
    }
    // eight eyes on the head-front face at (40,12) 8x8
    const eye = toHex(o.eye !== undefined ? o.eye : 0xa80e0e);
    rect(ctx, 41, 15, 1, 1, eye); rect(ctx, 46, 15, 1, 1, eye);
    rect(ctx, 42, 16, 2, 2, eye); rect(ctx, 44, 16, 2, 2, eye);
    rect(ctx, 41, 18, 1, 1, eye); rect(ctx, 46, 18, 1, 1, eye);
    rect(ctx, 43, 18, 1, 1, eye); rect(ctx, 44, 18, 1, 1, eye);
    // a spare pair on the humanoid-ish face rect, for models with other uvs
    rect(ctx, FX + 1, FY + 2, 2, 2, eye); rect(ctx, FX + 5, FY + 2, 2, 2, eye);
    if (o.marks !== undefined && o.marks !== null) patches(ctx, 0, 12, 34, 20, toHex(o.marks), rng, 6, 2, 4);
  };
}

defineSkin('spider', spiderSkin(0x36271f, { marks: 0x1d1512 }));
defineSkin('cave_spider', spiderSkin(0x0e4a54, { marks: 0x0a353c }));
defineSkin('slime', blobSkin({ body: 0x6ec24f, core: 0x53a838, grain: 0.15 }));
defineSkin('magma_cube', blobSkin({
  body: 0x35100a, core: 0xd44a06, crack: 0xf56e00, eye: 0xffd050, grain: 0.16,
  extra: (ctx, rng) => { speckle(ctx, 0, 0, 64, 64, 0xff9020, 60, rng); },
}));
defineSkin('blaze', (ctx, rng) => {
  fillAll(ctx, 0xf6b201, rng, 0.14);
  box(ctx, 0, 0, 8, 8, 8, { all: 0xf6b201, top: 0xffd23a, bottom: 0xc78400 });   // head
  box(ctx, 0, 16, 2, 8, 2, { all: 0xffc21e, top: 0xffe070, bottom: 0xd08a00 });  // rods
  rect(ctx, FX + 1, FY + 2, 2, 2, 0x3a2a08); rect(ctx, FX + 5, FY + 2, 2, 2, 0x3a2a08);
  rect(ctx, FX + 2, FY + 5, 4, 2, 0x4a3408);
  for (let i = 0; i < 140; i++) {                                                // flame licks
    const x = rng.int(63), y = rng.int(62);
    rect(ctx, x, y, 1, 2, rng.bool() ? 0xffe070 : 0xe07a00, 0.7);
  }
});
defineSkin('ghast', (ctx, rng) => {
  fillAll(ctx, 0xe3e3e3, rng, 0.07);
  box(ctx, 0, 0, 16, 16, 16, { all: 0xe3e3e3, top: 0xf2f2f2, bottom: 0xbcbcbc }); // head
  rect(ctx, 0, 32, 64, 32, 0xc9c9c9);                                             // tentacles
  stripes(ctx, 0, 32, 64, 32, 0xb0b0b0, 6, 2, true);
  // crying face on the head front face at (16,16) 16x16
  rect(ctx, 20, 21, 3, 2, 0x2b2b2b); rect(ctx, 26, 21, 3, 2, 0x2b2b2b);
  rect(ctx, 20, 23, 3, 3, 0x8a2b2b, 0.55); rect(ctx, 26, 23, 3, 3, 0x8a2b2b, 0.55);
  rect(ctx, 21, 26, 1, 3, 0x9a3a3a); rect(ctx, 27, 26, 1, 3, 0x9a3a3a);           // tears
  rect(ctx, 21, 27, 7, 3, 0x1e1e1e);                                              // open mouth
  rect(ctx, 22, 28, 5, 1, 0x3a3a3a);
  speckle(ctx, 0, 0, 64, 64, 0xd0d0d0, 90, rng);
});

// ===========================================================================
// Aquatic hostiles, shulkers, phantoms
// ===========================================================================

function guardianSkin(body, spike, eye) {
  return (ctx, rng) => {
    const b = toHex(body);
    fillAll(ctx, b, rng, 0.12);
    box(ctx, 0, 0, 12, 12, 12, { all: b, top: shadeHex(b, 1.12), bottom: shadeHex(b, 0.72) });
    for (let i = 0; i < 60; i++) {                                    // spines
      const x = rng.int(60), y = rng.int(60);
      rect(ctx, x, y, 2, 2, toHex(spike));
      px(ctx, x, y, shadeHex(toHex(spike), 1.3));
    }
    rect(ctx, 40, 0, 24, 24, shadeHex(b, 0.8));                       // tail fin
    stripes(ctx, 40, 0, 24, 24, shadeHex(b, 0.62), 4, 1, false);
    // single eye on the body-front face at (12,12) 12x12
    rect(ctx, 15, 15, 6, 6, 0xf0ece0);
    rect(ctx, 17, 17, 3, 3, toHex(eye));
    px(ctx, 18, 18, 0x140a04);
    rect(ctx, FX + 2, FY + 2, 4, 4, 0xf0ece0);                        // spare eye
    rect(ctx, FX + 3, FY + 3, 2, 2, toHex(eye));
  };
}

defineSkin('guardian', guardianSkin(0x5f8f7d, 0x3f6b5c, 0xe08a3c));
defineSkin('elder_guardian', guardianSkin(0xb5b0a0, 0x8f8a78, 0xc0783c));
function shulkerSkin(shell) {
  return (ctx, rng) => {
    const s = toHex(shell);
    fillAll(ctx, s, rng, 0.1);
    box(ctx, 0, 0, 8, 8, 8, { all: s, top: shadeHex(s, 1.18), bottom: shadeHex(s, 0.7) });   // lid
    box(ctx, 0, 28, 8, 8, 8, { all: shadeHex(s, 0.8), top: shadeHex(s, 0.92) });             // base
    for (let y = 0; y < 64; y += 8) rect(ctx, 0, y, 64, 1, shadeHex(s, 0.62));               // plate seams
    for (let x = 0; x < 64; x += 8) rect(ctx, x, 0, 1, 64, shadeHex(s, 0.62));
    speckle(ctx, 0, 0, 64, 64, shadeHex(s, 1.2), 70, rng);
    rect(ctx, FX + 2, FY + 3, 4, 2, 0xf0e0a0);                                               // peeking eyes
    rect(ctx, FX + 2, FY + 3, 1, 2, 0x2a1a20); rect(ctx, FX + 5, FY + 3, 1, 2, 0x2a1a20);
  };
}

defineSkin('shulker', shulkerSkin(0x986c97));
for (const dye in DYE_COLORS) defineSkin('shulker_' + dye, shulkerSkin(mix(0x986c97, DYE_COLORS[dye], 0.75)));

defineSkin('phantom', (ctx, rng) => {
  fillAll(ctx, 0x43698b, rng, 0.11);
  box(ctx, 0, 0, 5, 3, 9, { all: 0x4c7398, top: 0x5c86ad, bottom: 0x2f4a63 });    // body
  rect(ctx, 24, 0, 40, 30, 0x37567a);                                             // wings
  stripes(ctx, 24, 0, 40, 30, 0x2b4360, 5, 1, true);
  rect(ctx, 2, 10, 2, 2, 0xb7f6ff); rect(ctx, 7, 10, 2, 2, 0xb7f6ff);
  rect(ctx, FX + 1, FY + 2, 2, 2, 0xb7f6ff); rect(ctx, FX + 5, FY + 2, 2, 2, 0xb7f6ff);
  speckle(ctx, 0, 0, 64, 64, 0x2f4a63, 80, rng);
});
defineSkin('vex', humanoidSkin({
  skin: 0xd4e4ee, head: 0xdcecf6, shirt: 0x585b60, arm: 0xd4e4ee, cuff: 0x585b60,
  pants: 0x44474c, boots: 0x2f3236, grain: 0.08, face: false,
  extra: (ctx, rng) => {
    rect(ctx, FX + 1, FY + 3, 2, 2, 0xd83a3a); rect(ctx, FX + 5, FY + 3, 2, 2, 0xd83a3a);
    rect(ctx, FX + 2, FY + 6, 4, 1, 0x50545a);
    speckle(ctx, 0, 0, 64, 64, 0xb8ccd8, 50, rng);
  },
  overlay: (ctx) => {
    rect(ctx, 40, 32, 16, 14, 0xdff0fa, 0.75);                                    // wings
    rect(ctx, 48, 48, 16, 14, 0xdff0fa, 0.75);
  },
}));
defineSkin('allay', humanoidSkin({
  skin: 0x4a7bd1, head: 0x5a8be1, shirt: 0x3f6cc0, arm: 0x4a7bd1, cuff: null,
  pants: 0x35599f, boots: 0x2b4886, grain: 0.09, face: false,
  extra: (ctx, rng) => {
    rect(ctx, FX + 1, FY + 3, 2, 2, 0xdff0ff); rect(ctx, FX + 5, FY + 3, 2, 2, 0xdff0ff);
    rect(ctx, 20, 22, 8, 6, 0xa2c8f0);                                            // glowing core
    rect(ctx, 22, 24, 4, 2, 0xf0f8ff);
    speckle(ctx, 0, 0, 64, 64, 0x8ab4ea, 60, rng);
  },
  overlay: (ctx) => {
    rect(ctx, 40, 32, 16, 14, 0xa2c8f0, 0.7);                                     // wings
    rect(ctx, 48, 48, 16, 14, 0xa2c8f0, 0.7);
  },
}));
defineSkin('warden', humanoidSkin({
  skin: 0x0f3c3c, head: 0x0c3434, shirt: 0x113f42, arm: 0x0f3c3c, cuff: null,
  pants: 0x0b3030, boots: 0x082626, grain: 0.1, face: false,
  extra: (ctx, rng) => {
    // no eyes - a dark head with sensory tendrils and a glowing ribcage
    rect(ctx, FX, FY + 1, 8, 3, 0x082626);
    rect(ctx, FX + 1, FY + 5, 6, 2, 0x0a2e2e);
    rect(ctx, FX + 2, FY, 4, 2, 0x1f7f74);
    rect(ctx, 20, 21, 8, 8, 0x0a2e30);                                            // chest cavity
    for (let j = 0; j < 4; j++) rect(ctx, 20, 22 + j * 2, 8, 1, 0x29e0c8);         // glowing ribs
    rect(ctx, 22, 24, 4, 3, 0x7ff8e8);
    rect(ctx, 44, 22, 8, 6, 0x1f8f80);
    speckle(ctx, 0, 0, 64, 64, 0x1a5c58, 90, rng);
    for (let i = 0; i < 26; i++) px(ctx, rng.int(64), rng.int(64), 0x29e0c8);
  },
}));
defineSkin('breeze', humanoidSkin({
  skin: 0x3e5aa8, head: 0x4a68bd, shirt: 0x34509c, arm: 0x3e5aa8, cuff: null,
  pants: 0x2b4489, boots: 0x213770, grain: 0.12, face: false,
  extra: (ctx, rng) => {
    rect(ctx, FX + 1, FY + 3, 2, 2, 0x84e8ff); rect(ctx, FX + 5, FY + 3, 2, 2, 0x84e8ff);
    for (let i = 0; i < 90; i++) {                                                // swirling wind
      const x = rng.int(62), y = rng.int(63);
      rect(ctx, x, y, rng.range(2, 4), 1, 0x84e8ff, 0.45);
    }
    rect(ctx, 16, 44, 24, 4, 0xa8f0ff, 0.5);
  },
}));
defineSkin('creaking', humanoidSkin({
  skin: 0x2b2620, head: 0x332d25, shirt: 0x241f1a, arm: 0x2b2620, cuff: null,
  pants: 0x1e1a16, boots: 0x151210, grain: 0.14, face: false,
  extra: (ctx, rng) => {
    rect(ctx, FX + 1, FY + 3, 2, 2, 0xe36b1e); rect(ctx, FX + 5, FY + 3, 2, 2, 0xe36b1e);
    px(ctx, FX + 2, FY + 3, 0xffc060); px(ctx, FX + 6, FY + 3, 0xffc060);
    for (let i = 0; i < 120; i++) {                                               // bark grain
      const x = rng.int(63), y = rng.int(60);
      rect(ctx, x, y, 1, rng.range(2, 4), rng.bool() ? 0x1a1713 : 0x3f382e, 0.7);
    }
    speckle(ctx, 0, 0, 64, 64, 0x4a4136, 40, rng);
  },
}));

// ===========================================================================
// Bosses
// ===========================================================================

defineSkin('ender_dragon', (ctx, rng) => {
  fillAll(ctx, 0x191019, rng, 0.09);
  box(ctx, 0, 0, 16, 16, 16, { all: 0x1c1220, top: 0x261832, bottom: 0x0e080f });   // head
  rect(ctx, 0, 32, 64, 32, 0x241c2a);                                               // wing membrane
  stripes(ctx, 0, 32, 64, 32, 0x140d18, 6, 2, true);
  rect(ctx, 20, 20, 3, 3, 0xe545e5); rect(ctx, 26, 20, 3, 3, 0xe545e5);             // eyes
  px(ctx, 21, 21, 0xffb0ff); px(ctx, 27, 21, 0xffb0ff);
  rect(ctx, FX + 1, FY + 2, 2, 2, 0xe545e5); rect(ctx, FX + 5, FY + 2, 2, 2, 0xe545e5);
  for (let i = 0; i < 40; i++) {                                                    // dorsal spines
    const x = rng.int(60), y = rng.int(30);
    rect(ctx, x, y, 1, 3, 0x3a2450);
  }
  speckle(ctx, 0, 0, 64, 64, 0x2b1b33, 90, rng);
});
defineSkin('wither', (ctx, rng) => {
  fillAll(ctx, 0x1a1a1a, rng, 0.1);
  // three heads: one big (0,0) 10x10x10 and two small (0,16) 6x6x6
  box(ctx, 0, 0, 10, 10, 10, { all: 0x4a4a4a, top: 0x5c5c5c, bottom: 0x2e2e2e });
  box(ctx, 0, 22, 6, 6, 6, { all: 0x3f3f3f, top: 0x505050, bottom: 0x282828 });
  box(ctx, 32, 22, 6, 6, 6, { all: 0x3f3f3f, top: 0x505050, bottom: 0x282828 });
  const skull = (x, y, s) => {
    rect(ctx, x + s, y + s, s, s * 2, 0x0a0a0a);
    rect(ctx, x + s * 3, y + s, s, s * 2, 0x0a0a0a);
    rect(ctx, x + s, y + s * 4, s * 3, s, 0x0a0a0a);
  };
  skull(11, 10, 2);   // big head front face at (10,10) 10x10
  skull(7, 29, 1);    // small head front faces
  skull(39, 29, 1);
  rect(ctx, 44, 0, 20, 20, 0x232323);                                               // ribcage / spine
  for (let j = 0; j < 6; j++) rect(ctx, 44, 2 + j * 3, 20, 1, 0x3c3c3c);
  speckle(ctx, 0, 0, 64, 64, 0x2b2b2b, 90, rng);
  for (let i = 0; i < 18; i++) px(ctx, rng.int(64), rng.int(64), 0x4a3a1a);
});

// ===========================================================================
// Non-mob entities
// ===========================================================================

const BOAT_WOODS = {
  oak: 0xb08c50, spruce: 0x6d4f2c, birch: 0xd7c185, jungle: 0xa9765a,
  acacia: 0xb05d33, dark_oak: 0x4a2f16, mangrove: 0x763234, cherry: 0xe0b4b4,
  bamboo: 0xc2a93e, crimson: 0x6a344b, warped: 0x2b6c68,
};
for (const wood in BOAT_WOODS) {
  defineSkin('boat_' + wood, plankSkin(BOAT_WOODS[wood]));
  defineSkin('chest_boat_' + wood, plankSkin(BOAT_WOODS[wood], {
    extra: (ctx) => {
      rect(ctx, 32, 32, 24, 20, 0x8a6134);
      rect(ctx, 32, 40, 24, 3, 0x5a3e20);
      rect(ctx, 42, 40, 4, 4, 0xd8c060);
    },
  }));
}
defineSkin('boat', plankSkin(BOAT_WOODS.oak));
defineSkin('raft', plankSkin(BOAT_WOODS.bamboo));
defineSkin('minecart', (ctx, rng) => {
  fillAll(ctx, 0x9c9c9c, rng, 0.1);
  for (let y = 0; y < 64; y += 8) rect(ctx, 0, y, 64, 1, 0x6f6f6f);
  for (let x = 0; x < 64; x += 8) rect(ctx, x, 0, 1, 64, 0x6f6f6f);
  speckle(ctx, 0, 0, 64, 64, 0xb8b8b8, 80, rng);
  speckle(ctx, 0, 0, 64, 64, 0x6a5a4a, 26, rng);
  rect(ctx, 0, 0, 64, 3, 0x7a7a7a);
});
defineSkin('armor_stand', plankSkin(0xc0a26e, {
  extra: (ctx) => {
    rect(ctx, 0, 48, 64, 16, 0x8a8a8a);          // stone base
    for (let x = 0; x < 64; x += 8) rect(ctx, x, 48, 1, 16, 0x6f6f6f);
    rect(ctx, 16, 16, 24, 2, 0x9a7f52);
  },
}));
defineSkin('item', (ctx, rng) => { fillAll(ctx, 0xb0b0b0, rng, 0.2); });
