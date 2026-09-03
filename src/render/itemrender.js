// ============================================================================
// itemrender.js - Item icons and the first-person held-item view.
// (CONTRACT.md section 17)
//
// Two very different jobs live here because they answer the same question -
// "what does this item stack look like?" - from two different angles:
//
//   1. `itemIcon(name)` bakes a 64x64 canvas for the DOM UI. Block items are
//      drawn as a real isometric cube: the top / left / right faces of the
//      block's atlas tiles are pushed through per-face affine transforms into
//      a rhombus and shaded 1.0 / 0.8 / 0.6, exactly like the vanilla GUI
//      block renderer. Slabs, stairs, fences, anvils and friends get their own
//      little box shapes; cross plants, rails and torches stay flat sprites.
//
//   2. `HeldItemView` builds a three.js view model parented to the camera:
//      a textured box for block items, a genuinely extruded mesh (front, back
//      and one side quad per exposed sprite edge) for item sprites, and the
//      player's arm when the hand is empty - plus swing, equip, eat/drink,
//      bow-charge, shield-block and walk-bob animation.
//
// Nothing here touches `document`, `THREE` or `Game.*` at module scope, so the
// module still imports cleanly in a DOM-less environment.
// ============================================================================
import * as THREE from 'three';
import {
  FACE_DOWN, FACE_UP, FACE_NORTH, FACE_SOUTH, FACE_WEST, FACE_EAST,
  WALK_SPEED, PLAYER_EYE,
} from '../core/constants.js';
import { clamp, prettyName, hsvToRgb } from '../core/util.js';
import { Game } from '../core/game.js';
import { blockByName, getTexture } from '../world/blocks.js';
import { getItem } from '../item/items.js';
import { Atlas } from './atlas.js';
import { isEnchanted, listEnchantments } from '../item/enchanting.js';
import { getSkinTexture } from './skins.js';

// ---------------------------------------------------------------------------
// Tunables
// ---------------------------------------------------------------------------

/** Baked icon resolution. 4x the 16px source, so it stays crisp up to 64 CSS px. */
const ICON = 64;
const TILE = 16;

/** Directional face shading, indexed by FACE_*. Same numbers as the mesher. */
const FACE_SHADE = [0.5, 1.0, 0.8, 0.8, 0.6, 0.6];

/** Constant stand-in colours for the biome tints, used by icons and the hand. */
const TINT_HEX = {
  grass: 0x7cbd6b,
  foliage: 0x59ae30,
  water: 0x3f76e4,
  redstone: 0x9c1010,
  birch: 0x80a755,
  spruce: 0x619961,
};

/** Rarity name -> vanilla tooltip colour (matches src/ui/style.css). */
const RARITY_COLOR = {
  common: '#ffffff', uncommon: '#ffff55', rare: '#55ffff', epic: '#ff55ff',
};

/** Same font stack as --mc-font in style.css. Never a webfont. */
const MC_FONT = "'Minecraft','Monocraft','Press Start 2P','Silkscreen',ui-monospace," +
  "'SFMono-Regular','Menlo','DejaVu Sans Mono','Liberation Mono','Consolas','Courier New',monospace";

/**
 * Block models that read better as a flat sprite than as a little 3D shape,
 * which is also what vanilla does for these item models.
 */
const FLAT_MODELS = new Set([
  'cross', 'crop', 'flat', 'rail', 'torch', 'vine', 'ladder', 'pane', 'lever', 'none',
]);

// ---------------------------------------------------------------------------
// Canvas plumbing
// ---------------------------------------------------------------------------

function makeCanvas(w, h) {
  if (typeof document !== 'undefined' && document.createElement) {
    const c = document.createElement('canvas');
    c.width = w; c.height = h;
    return c;
  }
  if (typeof OffscreenCanvas !== 'undefined') return new OffscreenCanvas(w, h);
  throw new Error('[itemrender] no canvas implementation available');
}

function ctx2d(canvas, readback) {
  const g = canvas.getContext('2d', readback ? { willReadFrequently: true } : undefined);
  g.imageSmoothingEnabled = false;
  return g;
}

const cssHex = (c) => '#' + ((c >>> 0) & 0xffffff).toString(16).padStart(6, '0');

// ---------------------------------------------------------------------------
// Tile cache: raw / tinted / composited-and-shaded 16x16 canvases
// ---------------------------------------------------------------------------

const _rawTiles = new Map();       // texture name -> 16x16 canvas
const _tintedTiles = new Map();    // 'name|hex'   -> 16x16 canvas
const _faceTiles = new Map();      // composite key -> 16x16 canvas
const _pixelCache = new Map();     // texture name -> Uint8ClampedArray rgba
const _iconCache = new Map();      // item name -> ICONxICON canvas
const _dataURLCache = new Map();   // item name -> data: url

/** Raw 16x16 tile for a texture name. Falls back to a magenta checker. */
function rawTile(name) {
  let c = _rawTiles.get(name);
  if (c) return c;
  try {
    c = Atlas.tileCanvas(name);
  } catch (err) {
    console.warn('[itemrender] missing texture "' + name + '"', err);
    c = null;
  }
  if (!c) {
    c = makeCanvas(TILE, TILE);
    const g = ctx2d(c);
    for (let y = 0; y < TILE; y += 8) {
      for (let x = 0; x < TILE; x += 8) {
        g.fillStyle = ((x ^ y) & 8) ? '#000000' : '#ff00ff';
        g.fillRect(x, y, 8, 8);
      }
    }
  }
  _rawTiles.set(name, c);
  return c;
}

/**
 * A tile multiplied by a colour, keeping the original alpha.
 * `multiply` then `destination-in` is the canvas way of doing a tint without
 * turning the transparent texels into solid colour.
 */
function tintedTile(name, hex) {
  if (!hex) return rawTile(name);
  const key = name + '|' + hex;
  let c = _tintedTiles.get(key);
  if (c) return c;
  const src = rawTile(name);
  c = makeCanvas(TILE, TILE);
  const g = ctx2d(c);
  g.drawImage(src, 0, 0);
  g.globalCompositeOperation = 'multiply';
  g.fillStyle = cssHex(hex);
  g.fillRect(0, 0, TILE, TILE);
  g.globalCompositeOperation = 'destination-in';
  g.drawImage(src, 0, 0);
  g.globalCompositeOperation = 'source-over';
  _tintedTiles.set(key, c);
  return c;
}

/**
 * One finished face tile: base (optionally tinted), an optional tinted overlay
 * decal on top (grass block sides), then a flat multiply by `shade`.
 * `source-atop` with black is a multiply that leaves the alpha channel alone.
 */
function faceTile(base, tint, overlay, overlayTint, shade) {
  const key = base + '|' + (tint || 0) + '|' + (overlay || '') + '|' + (overlayTint || 0) + '|' + shade;
  let c = _faceTiles.get(key);
  if (c) return c;
  c = makeCanvas(TILE, TILE);
  const g = ctx2d(c);
  g.drawImage(tintedTile(base, tint), 0, 0);
  if (overlay) g.drawImage(tintedTile(overlay, overlayTint), 0, 0);
  if (shade < 0.999) {
    g.globalCompositeOperation = 'source-atop';
    g.fillStyle = 'rgba(0,0,0,' + (1 - shade).toFixed(4) + ')';
    g.fillRect(0, 0, TILE, TILE);
    g.globalCompositeOperation = 'source-over';
  }
  _faceTiles.set(key, c);
  return c;
}

/** RGBA bytes of a 16x16 tile, used by the sprite extruder. */
function tilePixels(name) {
  let d = _pixelCache.get(name);
  if (d) return d;
  const c = makeCanvas(TILE, TILE);
  const g = ctx2d(c, true);
  g.drawImage(rawTile(name), 0, 0);
  try {
    d = g.getImageData(0, 0, TILE, TILE).data;
  } catch (err) {
    d = new Uint8ClampedArray(TILE * TILE * 4).fill(255);
  }
  _pixelCache.set(name, d);
  return d;
}

// ---------------------------------------------------------------------------
// Block shape table
//
// Every entry is a list of boxes in 0..1 block space, ordered BACK TO FRONT so
// a plain painter's pass over them lands the right way round. A box may carry
// `tex: { top, side }` to override the block's own face textures.
// ---------------------------------------------------------------------------

const FULL = [0, 0, 0, 1, 1, 1];
const p = (n) => n / 16;

const SHAPES = {
  cube: [FULL],
  column: [FULL],
  fluid: [FULL],
  cactus: [[p(1), 0, p(1), p(15), 1, p(15)]],
  farmland: [[0, 0, 0, 1, p(15), 1]],
  path: [[0, 0, 0, 1, p(15), 1]],
  piston: [FULL],
  piston_head: [[0, 0, 0, 1, p(4), 1]],
  slab: [[0, 0, 0, 1, 0.5, 1]],
  layer: [[0, 0, 0, 1, p(2), 1]],
  carpet: [[0, 0, 0, 1, p(1), 1]],
  trapdoor: [[0, 0, 0, 1, p(3), 1]],
  button: [[p(5), 0, p(6), p(11), p(2), p(10)]],
  // Far riser first, near tread second: the two boxes are disjoint so painting
  // far-to-near needs no depth buffer.
  stairs: [
    [0, 0, 0.5, 1, 1, 1],
    [0, 0, 0, 1, 0.5, 0.5],
  ],
  fence: [
    [0, p(6), p(7), 1, p(9), p(9)],
    [0, p(12), p(7), 1, p(15), p(9)],
    [p(6), 0, p(6), p(10), 1, p(10)],
  ],
  fence_gate: [
    [0, p(5), p(7), p(2), 1, p(9)],
    [p(14), p(5), p(7), 1, 1, p(9)],
    [0, p(6), p(7), 1, p(9), p(9)],
    [0, p(12), p(7), 1, p(15), p(9)],
  ],
  wall: [
    [p(4), 0, p(4), p(12), 1, p(12)],
  ],
  chest: [[p(1), 0, p(1), p(15), p(14), p(15)]],
  bed: [[0, 0, 0, 1, p(9), 1]],
  cake: [[p(1), 0, p(1), p(15), 0.5, p(15)]],
  cauldron: [FULL],
  anvil: [
    [p(2), 0, p(2), p(14), p(4), p(14)],
    [p(4), p(4), p(5), p(12), p(10), p(11)],
    [p(1), p(10), p(3), p(15), 1, p(13)],
  ],
  hopper: [
    [p(6), 0, p(6), p(10), p(4), p(10)],
    [p(4), p(4), p(4), p(12), p(10), p(12)],
    [0, p(10), 0, 1, 1, 1],
  ],
  lantern: [
    [p(5), 0, p(5), p(11), p(7), p(11)],
    [p(6), p(7), p(6), p(10), p(11), p(10)],
  ],
  end_rod: [[p(7), 0, p(7), p(9), 1, p(9)]],
  skull: [[p(4), 0, p(4), p(12), p(8), p(12)]],
  pot: [[p(5), 0, p(5), p(11), p(6), p(11)]],
  sign: [
    [p(7), 0, p(7), p(9), p(8), p(9)],
    [0, p(7), p(7), 1, 1, p(9)],
  ],
  wall_sign: [[0, p(4), p(7), 1, p(13), p(9)]],
};

/** Box list for a block definition, defaulting to a full cube. */
function shapeFor(def) {
  return SHAPES[def.model] || SHAPES.cube;
}

// ---------------------------------------------------------------------------
// Texture-name resolution
//
// blocks.js and atlas.js are written independently, so a block occasionally
// asks for a name the atlas spells slightly differently (`azalea` vs
// `azalea_top`, `white_shulker_box_top` vs `white_shulker_box`). The atlas will
// happily synthesise a fallback, but a real neighbouring texture always looks
// better, so try the obvious relatives first.
// ---------------------------------------------------------------------------

/** Suffixes worth appending, per face; index 6 is the flat-sprite order. */
const FACE_SUFFIX = [
  ['_bottom', '_end', '_top', '_side', '_front'],           // down
  ['_top', '_end', '_side', '_bottom', '_front'],           // up
  ['_side', '_front', '_north', '_end', '_top', '_bottom'], // north
  ['_side', '_back', '_south', '_end', '_top', '_bottom'],  // south
  ['_side', '_west', '_end', '_top', '_bottom', '_front'],  // west
  ['_side', '_east', '_end', '_top', '_bottom', '_front'],  // east
  ['_top', '_front', '_side', '_stalk', '_bottom', '_end'], // flat sprite
];

/** Suffixes worth stripping when the full name is unknown. */
const TEX_SUFFIXES = [
  '_top', '_bottom', '_side', '_front', '_back', '_end', '_inner', '_base',
  '_north', '_south', '_east', '_west', '_lower', '_upper', '_still', '_stem',
];

/**
 * Maps a requested texture name onto one the atlas actually has, by adding or
 * stripping a face suffix. Falls back to the original name, which lets the
 * atlas generate its deterministic stand-in rather than crashing.
 */
function resolveTexture(name, face) {
  if (typeof name !== 'string' || !name) return 'missing';
  if (Atlas.has(name)) return name;
  const add = FACE_SUFFIX[face] || FACE_SUFFIX[FACE_UP];
  for (let i = 0; i < add.length; i++) if (Atlas.has(name + add[i])) return name + add[i];
  for (let i = 0; i < TEX_SUFFIXES.length; i++) {
    const s = TEX_SUFFIXES[i];
    if (!name.endsWith(s)) continue;
    const stem = name.slice(0, -s.length);
    if (!stem) break;
    if (Atlas.has(stem)) return stem;
    for (let j = 0; j < add.length; j++) if (Atlas.has(stem + add[j])) return stem + add[j];
    break;
  }
  return name;
}

/** Resolved tint colour for one face of a block, 0 when untinted. */
function tintFor(def, face) {
  const t = def.tint;
  if (t === null || t === undefined) return 0;
  const hex = typeof t === 'number' ? t : (TINT_HEX[t] || 0);
  if (!hex) return 0;
  if (def.tintFaces && def.tintFaces.indexOf(face) < 0) return 0;
  return hex;
}

/** The block's tint colour ignoring `tintFaces` - overlays are always tinted. */
function baseTintOf(def) {
  const t = def.tint;
  if (t === null || t === undefined) return 0;
  return typeof t === 'number' ? t : (TINT_HEX[t] || 0);
}

/** Finished, shaded 16x16 canvas for one face of one box of a block. */
function blockFaceTile(def, meta, face, override) {
  const base = resolveTexture(override || getTexture(def.id, meta, face), face);
  const overlay = (def.overlay && face !== FACE_UP && face !== FACE_DOWN) ? def.overlay : null;
  return faceTile(base, tintFor(def, face), overlay, overlay ? baseTintOf(def) : 0, FACE_SHADE[face]);
}

// ---------------------------------------------------------------------------
// Isometric projection
//
// Camera sits in the +x, +y, -z octant, so the visible faces are the top, the
// north face (z = z0) on the left and the east face (x = x1) on the right.
// The unit cube then exactly fills a size x size square.
// ---------------------------------------------------------------------------

const ISO_K = 0.98;   // a hair of inset so the silhouette never clips the edge

function projX(x, z, S) { return S * 0.5 + (x - (1 - z)) * (S * 0.5) * ISO_K; }
function projY(x, y, z, S) { return S * 0.5 + (((1 - z) + x) * (S * 0.25) - y * (S * 0.5)) * ISO_K; }

/** Pushes each quad corner 0.5px away from its centre so faces never hairline. */
function expandQuad(q) {
  const cx = (q[0] + q[2] + q[4] + q[6]) * 0.25;
  const cy = (q[1] + q[3] + q[5] + q[7]) * 0.25;
  for (let i = 0; i < 8; i += 2) {
    const dx = q[i] - cx, dy = q[i + 1] - cy;
    const len = Math.hypot(dx, dy) || 1;
    q[i] = cx + dx * (1 + 0.55 / len);
    q[i + 1] = cy + dy * (1 + 0.55 / len);
  }
  return q;
}

/**
 * Draws one parallelogram face: clip to the (expanded) quad, then map the
 * texture sub-rectangle onto it with an affine transform.
 * p00/p10/p01 are the projected corners of texture (0,0), (1,0) and (0,1).
 */
function drawFace(ctx, tile, sx, sy, sw, sh, p00, p10, p01) {
  if (sw <= 0 || sh <= 0) return;
  const p11x = p10[0] + p01[0] - p00[0];
  const p11y = p10[1] + p01[1] - p00[1];
  const q = expandQuad([p00[0], p00[1], p10[0], p10[1], p11x, p11y, p01[0], p01[1]]);
  ctx.save();
  ctx.beginPath();
  ctx.moveTo(q[0], q[1]);
  ctx.lineTo(q[2], q[3]);
  ctx.lineTo(q[4], q[5]);
  ctx.lineTo(q[6], q[7]);
  ctx.closePath();
  ctx.clip();
  ctx.setTransform(
    (p10[0] - p00[0]) / sw, (p10[1] - p00[1]) / sw,
    (p01[0] - p00[0]) / sh, (p01[1] - p00[1]) / sh,
    p00[0], p00[1],
  );
  // A sliver of overdraw kills the seam between two adjacent faces.
  const b = 0.4;
  ctx.drawImage(tile, sx, sy, sw, sh, -b, -b, sw + b * 2, sh + b * 2);
  ctx.restore();
}

/** Top, left (north) and right (east) faces of one box, in that safe order. */
function drawIsoBox(ctx, S, box, tiles) {
  const [x0, y0, z0, x1, y1, z1] = box;

  // left: north face, z = z0, u <- x, v <- 1-y
  drawFace(ctx, tiles.north,
    x0 * TILE, (1 - y1) * TILE, (x1 - x0) * TILE, (y1 - y0) * TILE,
    [projX(x0, z0, S), projY(x0, y1, z0, S)],
    [projX(x1, z0, S), projY(x1, y1, z0, S)],
    [projX(x0, z0, S), projY(x0, y0, z0, S)]);

  // right: east face, x = x1, u <- z, v <- 1-y
  drawFace(ctx, tiles.east,
    z0 * TILE, (1 - y1) * TILE, (z1 - z0) * TILE, (y1 - y0) * TILE,
    [projX(x1, z0, S), projY(x1, y1, z0, S)],
    [projX(x1, z1, S), projY(x1, y1, z1, S)],
    [projX(x1, z0, S), projY(x1, y0, z0, S)]);

  // top: y = y1, u <- x, v <- z
  drawFace(ctx, tiles.up,
    x0 * TILE, z0 * TILE, (x1 - x0) * TILE, (z1 - z0) * TILE,
    [projX(x0, z0, S), projY(x0, y1, z0, S)],
    [projX(x1, z0, S), projY(x1, y1, z0, S)],
    [projX(x0, z1, S), projY(x0, y1, z1, S)]);
}

// ---------------------------------------------------------------------------
// Icon rendering
// ---------------------------------------------------------------------------

/** Bed items reuse the block's bed textures when the atlas has them. */
function bedTextures(blockName) {
  const color = blockName.slice(0, -4);   // strip '_bed'
  const top = color + '_bed_head_top';
  const side = color + '_bed_head_side';
  if (Atlas.has(top) && Atlas.has(side)) return { top, side };
  return null;
}

/** Draws a block item as a little isometric solid. */
function drawBlockIcon(ctx, S, def) {
  const meta = 0;
  const boxes = shapeFor(def);
  let override = null;
  if (def.model === 'bed') override = bedTextures(def.name);

  for (let i = 0; i < boxes.length; i++) {
    const box = boxes[i];
    const tiles = {
      up: blockFaceTile(def, meta, FACE_UP, override ? override.top : null),
      north: blockFaceTile(def, meta, FACE_NORTH, override ? override.side : null),
      east: blockFaceTile(def, meta, FACE_EAST, override ? override.side : null),
    };
    drawIsoBox(ctx, S, box, tiles);
  }
}

/**
 * Best flat texture for an item. The item's own name wins when the atlas has
 * art for it (spawn eggs, tools, flowers); otherwise fall back through the
 * block's side face and finally the declared texture name.
 */
function spriteTextureName(item, def) {
  const tries = [];
  if (item && item.name) tries.push(item.name);
  if (def) {
    // blocks.js spells door faces `_lower`/`_upper`; the atlas draws
    // `_bottom`/`_top`, so try the atlas spelling first.
    if (def.model === 'door' && typeof def.tex === 'string') tries.push(def.tex + '_bottom');
    tries.push(getTexture(def.id, 0, FACE_NORTH));
  }
  if (item && item.texture) tries.push(item.texture);
  for (let i = 0; i < tries.length; i++) {
    const t = tries[i];
    if (typeof t === 'string' && t && Atlas.has(t)) return t;
  }
  // Nothing matched exactly; let the suffix resolver find a relative.
  for (let i = 0; i < tries.length; i++) {
    const t = tries[i];
    if (typeof t !== 'string' || !t) continue;
    const r = resolveTexture(t, 6);
    if (Atlas.has(r)) return r;
  }
  for (let i = tries.length - 1; i >= 0; i--) {
    if (typeof tries[i] === 'string' && tries[i]) return tries[i];
  }
  return 'missing';
}

/** Doors are two tiles tall: draw them half width so the whole door fits. */
function drawDoorIcon(ctx, S, texBase) {
  const top = texBase + '_top';
  const bottom = texBase + '_bottom';
  if (!Atlas.has(top) || !Atlas.has(bottom)) return false;
  const w = S * 0.5, x = S * 0.25, h = S * 0.5;
  ctx.imageSmoothingEnabled = false;
  ctx.drawImage(rawTile(top), 0, 0, TILE, TILE, x, 0, w, h);
  ctx.drawImage(rawTile(bottom), 0, 0, TILE, TILE, x, h, w, h);
  return true;
}

/** Draws a plain 16x16 sprite scaled up, plus the potion / dyed-leather layers. */
function drawSpriteIcon(ctx, S, item, def) {
  ctx.imageSmoothingEnabled = false;
  const tint = def ? tintFor(def, FACE_NORTH) : 0;
  const name = spriteTextureName(item, def);
  const color = item ? item.color : null;

  // Potion bottles: white liquid decal tinted by the potion colour.
  const isPotionArt = item && item.potion &&
    (item.texture === 'potion' || item.texture === 'splash_potion' || item.texture === 'lingering_potion');
  if (isPotionArt && Atlas.has('potion_overlay')) {
    ctx.drawImage(rawTile(item.texture), 0, 0, TILE, TILE, 0, 0, S, S);
    ctx.drawImage(tintedTile('potion_overlay', color || 0x385dc6), 0, 0, TILE, TILE, 0, 0, S, S);
    return;
  }

  // Dyed leather armour and anything shipping an explicit `_overlay` tile.
  const overlayName = item ? item.name + '_overlay' : null;
  if (color != null && overlayName && Atlas.has(overlayName)) {
    ctx.drawImage(rawTile(name), 0, 0, TILE, TILE, 0, 0, S, S);
    ctx.drawImage(tintedTile(overlayName, color), 0, 0, TILE, TILE, 0, 0, S, S);
    return;
  }
  if (color != null && item && item.name.startsWith('leather_') && !Atlas.has(item.name)) {
    ctx.drawImage(tintedTile(name, color), 0, 0, TILE, TILE, 0, 0, S, S);
    return;
  }

  ctx.drawImage(tint ? tintedTile(name, tint) : rawTile(name), 0, 0, TILE, TILE, 0, 0, S, S);
}

/** Bakes one icon canvas. */
function renderIcon(itemName) {
  const canvas = makeCanvas(ICON, ICON);
  const ctx = ctx2d(canvas);
  // Air is a real registry entry but has to draw as nothing at all.
  if (itemName === 'air' || itemName === 'cave_air' || itemName === 'void_air') return canvas;
  const item = getItem(itemName);
  const def = item && item.block ? blockByName(item.block) : null;

  try {
    if (def && def.model === 'door') {
      if (!drawDoorIcon(ctx, ICON, typeof def.tex === 'string' ? def.tex : def.name)) {
        drawSpriteIcon(ctx, ICON, item, def);
      }
    } else if (def && def.id > 0 && !FLAT_MODELS.has(def.model)) {
      drawBlockIcon(ctx, ICON, def);
    } else {
      drawSpriteIcon(ctx, ICON, item, def);
    }
  } catch (err) {
    console.error('[itemrender] failed drawing icon for "' + itemName + '"', err);
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, ICON, ICON);
    const q = ICON / 2;
    for (let yy = 0; yy < 2; yy++) {
      for (let xx = 0; xx < 2; xx++) {
        ctx.fillStyle = ((xx ^ yy) & 1) ? '#000000' : '#ff00ff';
        ctx.fillRect(xx * q, yy * q, q, q);
      }
    }
  }
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  return canvas;
}

/**
 * A cached square canvas icon for an item name. Block items get an isometric
 * cube built from their atlas faces; everything else gets its sprite scaled up.
 * @param {string} itemName canonical item name, e.g. 'diamond_pickaxe'
 * @returns {HTMLCanvasElement} an ICONxICON canvas (never null)
 */
export function itemIcon(itemName) {
  const key = typeof itemName === 'string' && itemName ? itemName : 'air';
  let c = _iconCache.get(key);
  if (c) return c;
  c = renderIcon(key);
  _iconCache.set(key, c);
  return c;
}

/**
 * PNG data URL of an item icon, cached. Used by the creative search grid and
 * the recipe book, which want `background-image` rather than a live canvas.
 * @param {string} itemName
 * @returns {string} a `data:image/png;base64,...` URL ('' if unavailable)
 */
export function iconDataURL(itemName) {
  const key = typeof itemName === 'string' && itemName ? itemName : 'air';
  let url = _dataURLCache.get(key);
  if (url !== undefined) return url;
  try {
    const c = itemIcon(key);
    url = typeof c.toDataURL === 'function' ? c.toDataURL('image/png') : '';
  } catch (err) {
    url = '';
  }
  _dataURLCache.set(key, url);
  return url;
}

/**
 * Drops every baked icon and tile. Call after the atlas is rebuilt or after a
 * texture pack style change; icons are lazily re-baked on the next request.
 */
export function invalidateIconCache() {
  _iconCache.clear();
  _dataURLCache.clear();
  _rawTiles.clear();
  _tintedTiles.clear();
  _faceTiles.clear();
  _pixelCache.clear();
  _spriteGeoCache.forEach((g) => g.dispose());
  _spriteGeoCache.clear();
  _blockGeoCache.forEach((g) => g.dispose());
  _blockGeoCache.clear();
}

// ---------------------------------------------------------------------------
// Stack decoration: count, durability bar, enchantment glint
// ---------------------------------------------------------------------------

let _glintCanvas = null;
let _glintCtx = null;

/** Builds the moving sheen, masked to the icon's own alpha. */
function glintLayer(icon) {
  if (!_glintCanvas || _glintCanvas.width !== ICON) {
    _glintCanvas = makeCanvas(ICON, ICON);
    _glintCtx = ctx2d(_glintCanvas);
  }
  const g = _glintCtx;
  g.setTransform(1, 0, 0, 1, 0, 0);
  g.globalCompositeOperation = 'source-over';
  g.clearRect(0, 0, ICON, ICON);

  const t = (typeof performance !== 'undefined' ? performance.now() : Date.now()) * 0.00035;
  const phase = ((t % 1) + 1) % 1;
  const off = (phase * 2 - 0.5) * ICON;
  const grad = g.createLinearGradient(off - ICON * 0.5, -ICON * 0.4, off + ICON * 0.35, ICON * 0.9);
  grad.addColorStop(0.00, 'rgba(120,40,255,0)');
  grad.addColorStop(0.35, 'rgba(150,60,255,0.85)');
  grad.addColorStop(0.50, 'rgba(220,180,255,1)');
  grad.addColorStop(0.65, 'rgba(150,60,255,0.85)');
  grad.addColorStop(1.00, 'rgba(120,40,255,0)');
  g.fillStyle = grad;
  g.fillRect(0, 0, ICON, ICON);

  g.globalCompositeOperation = 'destination-in';
  g.drawImage(icon, 0, 0, ICON, ICON);
  g.globalCompositeOperation = 'source-over';
  return _glintCanvas;
}

/** Maximum durability of a stack's item, 0 when it is not damageable. */
function maxDamageOf(name) {
  const it = getItem(name);
  return it ? (it.durability | 0) : 0;
}

/** Vanilla's green-to-red durability colour: hsv(remaining/3, 1, 1). */
function durabilityColor(frac) {
  const [r, g, b] = hsvToRgb(clamp(frac, 0, 1) / 3, 1, 1);
  return 'rgb(' + Math.round(r * 255) + ',' + Math.round(g * 255) + ',' + Math.round(b * 255) + ')';
}

/**
 * Normalises the shapes a "stack" can arrive in: a stack object, a bare item
 * name, or an empty slot. A zero count counts as empty, like vanilla.
 */
function readStack(stack) {
  if (!stack) return null;
  if (typeof stack === 'string') return { item: stack, count: 1, damage: 0 };
  if (!stack.item || (stack.count | 0) <= 0) return null;
  return stack;
}

/**
 * Draws a stack into a 2D context: icon, enchantment shimmer, durability bar
 * and the count in the bottom-right with a hard shadow.
 * @param {CanvasRenderingContext2D} ctx destination context
 * @param {object|string|null} stack item stack ({item, count, damage, ...})
 * @param {number} x left edge in context units
 * @param {number} y top edge
 * @param {number} size icon edge length
 */
export function drawStack(ctx, stack, x, y, size = 32) {
  const s = readStack(stack);
  if (!s || !ctx) return;
  const icon = itemIcon(s.item);
  ctx.save();
  ctx.imageSmoothingEnabled = false;
  ctx.drawImage(icon, x, y, size, size);

  if (isEnchanted(s)) {
    ctx.globalCompositeOperation = 'lighter';
    ctx.globalAlpha = 0.5;
    ctx.drawImage(glintLayer(icon), x, y, size, size);
    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = 'source-over';
  }

  // Durability bar: 13 wide, 2 tall, two pixels in from the bottom-left.
  const max = maxDamageOf(s.item);
  const dmg = s.damage | 0;
  if (max > 0 && dmg > 0) {
    const u = size / 16;
    const bx = x + 2 * u, by = y + 13 * u, bw = 13 * u, bh = 2 * u;
    const frac = clamp(1 - dmg / max, 0, 1);
    ctx.fillStyle = '#000000';
    ctx.fillRect(bx, by, bw, bh);
    ctx.fillStyle = durabilityColor(frac);
    ctx.fillRect(bx, by, Math.max(0, Math.round(bw * frac)), Math.max(1, bh - u));
  }

  const count = s.count | 0;
  if (count > 1 || s.showCount) {
    const label = count > 999 ? Math.floor(count / 1000) + 'k' : String(count);
    const fs = Math.max(6, Math.round(size * 0.5));
    const off = Math.max(1, Math.round(size / 16));
    ctx.font = fs + 'px ' + MC_FONT;
    ctx.textAlign = 'right';
    ctx.textBaseline = 'alphabetic';
    const tx = x + size - off;
    const ty = y + size - off;
    ctx.fillStyle = '#3f3f3f';
    ctx.fillText(label, tx + off, ty + off);
    ctx.fillStyle = '#ffffff';
    ctx.fillText(label, tx, ty);
  }
  ctx.restore();
}

// ---------------------------------------------------------------------------
// Tooltips + DOM element
// ---------------------------------------------------------------------------

/**
 * Tooltip lines for a stack: display name in its rarity colour, enchantments,
 * durability, and the headline tool/armour numbers. Kept private on purpose -
 * inventory.js owns the canonical version for gameplay text.
 */
function tooltipLines(s) {
  const item = getItem(s.item);
  const lines = [];
  const name = s.name || (item ? item.display : prettyName(s.item));
  lines.push({ text: name, color: RARITY_COLOR[item ? item.rarity : 'common'] || '#ffffff' });

  for (const e of listEnchantments(s)) {
    const label = prettyName(e.name);
    lines.push({ text: e.level > 1 ? label + ' ' + e.level : label, color: '#a8a8ff' });
  }

  if (item && item.tool) {
    const t = item.tool;
    if (t.damage) lines.push({ text: t.damage.toFixed(1) + ' Attack Damage', color: '#5555ff' });
    if (t.attackSpeed) lines.push({ text: t.attackSpeed.toFixed(1) + ' Attack Speed', color: '#5555ff' });
  }
  if (item && item.armor) {
    lines.push({ text: '+' + item.armor.defense + ' Armor', color: '#5555ff' });
    if (item.armor.toughness) lines.push({ text: '+' + item.armor.toughness + ' Armor Toughness', color: '#5555ff' });
  }
  if (item && item.food) {
    lines.push({ text: item.food.hunger + ' Hunger', color: '#aaaaaa' });
  }

  const max = item ? (item.durability | 0) : 0;
  if (max > 0 && (s.damage | 0) > 0) {
    lines.push({ text: 'Durability: ' + (max - (s.damage | 0)) + ' / ' + max, color: '#ffffff' });
  }
  lines.push({ text: s.item, color: '#555555' });
  return lines;
}

/**
 * A DOM element for one stack, ready to drop inside a `.mc-slot`.
 * Structure matches src/ui/style.css: a `.stack-icon` wrapper holding the icon
 * canvas plus the optional `.slot-count`, `.slot-durability` and `.stack-glint`
 * children. The tooltip is attached as `data-tooltip` (JSON) and
 * `data-tooltip-text` (plain lines).
 * @param {object|string|null} stack
 * @param {number} size pixel size of the icon (clamped to the slot by CSS)
 * @returns {HTMLElement} the wrapper element (empty div for an empty stack)
 */
export function stackElement(stack, size = 32) {
  const el = document.createElement('div');
  el.className = 'stack-icon';
  const s = readStack(stack);
  if (!s) { el.dataset.empty = '1'; return el; }

  const item = getItem(s.item);
  el.style.position = 'relative';
  el.style.width = size + 'px';
  el.style.height = size + 'px';
  el.style.maxWidth = '100%';
  el.style.maxHeight = '100%';
  el.dataset.item = s.item;
  el.dataset.count = String(s.count | 0);
  el.dataset.rarity = item ? item.rarity : 'common';
  const lines = tooltipLines(s);
  el.dataset.tooltip = JSON.stringify(lines);
  el.dataset.tooltipText = lines.map((l) => l.text).join('\n');

  const canvas = document.createElement('canvas');
  canvas.width = ICON;
  canvas.height = ICON;
  canvas.className = 'pixel';
  canvas.style.width = '100%';
  canvas.style.height = '100%';
  canvas.style.display = 'block';
  const g = ctx2d(canvas);
  g.drawImage(itemIcon(s.item), 0, 0, ICON, ICON);
  el.appendChild(canvas);

  if (isEnchanted(s)) {
    const glint = document.createElement('div');
    glint.className = 'stack-glint';
    el.appendChild(glint);
  }

  const max = item ? (item.durability | 0) : 0;
  const dmg = s.damage | 0;
  if (max > 0 && dmg > 0) {
    const frac = clamp(1 - dmg / max, 0, 1);
    const bar = document.createElement('div');
    bar.className = 'slot-durability';
    const fill = document.createElement('div');
    fill.className = 'slot-durability-fill';
    fill.style.setProperty('--dura', String(frac));
    fill.style.setProperty('--dura-color', durabilityColor(frac));
    bar.appendChild(fill);
    el.appendChild(bar);
  }

  const count = s.count | 0;
  if (count > 1) {
    const span = document.createElement('span');
    span.className = 'slot-count';
    span.textContent = count > 999 ? Math.floor(count / 1000) + 'k' : String(count);
    el.appendChild(span);
  }
  return el;
}

// ===========================================================================
// Three.js geometry for the held-item view
// ===========================================================================

const _blockGeoCache = new Map();    // block name -> BufferGeometry
const _spriteGeoCache = new Map();   // texture name -> BufferGeometry

/** Corner positions of one box face, wound CCW as seen from outside. */
function faceCorners(f, x0, y0, z0, x1, y1, z1) {
  switch (f) {
    case FACE_DOWN:  return [x0, y0, z0, x1, y0, z0, x1, y0, z1, x0, y0, z1];
    case FACE_UP:    return [x0, y1, z1, x1, y1, z1, x1, y1, z0, x0, y1, z0];
    case FACE_NORTH: return [x0, y0, z0, x0, y1, z0, x1, y1, z0, x1, y0, z0];
    case FACE_SOUTH: return [x1, y0, z1, x1, y1, z1, x0, y1, z1, x0, y0, z1];
    case FACE_WEST:  return [x0, y0, z1, x0, y1, z1, x0, y1, z0, x0, y0, z0];
    default:         return [x1, y0, z0, x1, y1, z0, x1, y1, z1, x1, y0, z1];
  }
}

/** Tile-space uv (0..1) of a corner on a given face. */
function faceUV(f, x, y, z, out) {
  if (f === FACE_DOWN || f === FACE_UP) { out[0] = x; out[1] = z; }
  else if (f === FACE_NORTH || f === FACE_SOUTH) { out[0] = x; out[1] = 1 - y; }
  else { out[0] = z; out[1] = 1 - y; }
  return out;
}

const FACE_NORMAL = [
  [0, -1, 0], [0, 1, 0], [0, 0, -1], [0, 0, 1], [-1, 0, 0], [1, 0, 0],
];

/**
 * Builds the held-item geometry for a block: every box of its icon shape,
 * with atlas uvs, face shading and biome tint baked into vertex colours.
 * Centred on the origin so the caller can just rotate the group.
 */
function blockGeometry(def) {
  const boxes = shapeFor(def);
  const override = def.model === 'bed' ? bedTextures(def.name) : null;
  const pos = [];
  const nrm = [];
  const uvs = [];
  const col = [];
  const idx = [];
  const uvTmp = [0, 0];
  let base = 0;

  for (const box of boxes) {
    const [x0, y0, z0, x1, y1, z1] = box;
    for (let f = 0; f < 6; f++) {
      let texName;
      if (override) texName = (f === FACE_UP || f === FACE_DOWN) ? override.top : override.side;
      else texName = resolveTexture(getTexture(def.id, 0, f), f);
      const uv = Atlas.uv(texName);
      const shade = FACE_SHADE[f];
      const tint = tintFor(def, f);
      const tr = tint ? ((tint >> 16) & 255) / 255 : 1;
      const tg = tint ? ((tint >> 8) & 255) / 255 : 1;
      const tb = tint ? (tint & 255) / 255 : 1;
      const c = faceCorners(f, x0, y0, z0, x1, y1, z1);
      const n = FACE_NORMAL[f];
      for (let k = 0; k < 4; k++) {
        const vx = c[k * 3], vy = c[k * 3 + 1], vz = c[k * 3 + 2];
        pos.push(vx - 0.5, vy - 0.5, vz - 0.5);
        nrm.push(n[0], n[1], n[2]);
        faceUV(f, vx, vy, vz, uvTmp);
        uvs.push(uv.u0 + (uv.u1 - uv.u0) * uvTmp[0], uv.v0 + (uv.v1 - uv.v0) * uvTmp[1]);
        col.push(shade * tr, shade * tg, shade * tb);
      }
      idx.push(base, base + 1, base + 2, base, base + 2, base + 3);
      base += 4;
    }
  }

  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('normal', new THREE.Float32BufferAttribute(nrm, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
  g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
  g.setIndex(idx);
  g.computeBoundingSphere();
  return g;
}

/** Cached block geometry. */
function getBlockGeometry(def) {
  let g = _blockGeoCache.get(def.name);
  if (g) return g;
  g = blockGeometry(def);
  _blockGeoCache.set(def.name, g);
  return g;
}

const SPRITE_DEPTH = 1 / 16;

/**
 * Extrudes a 16x16 item sprite into a real solid: a front and a back quad plus
 * one side quad per exposed pixel edge, greedily merged into runs. This is what
 * makes a sword in the hand read as a thin slab of metal rather than a decal.
 */
function spriteGeometry(texName) {
  const data = tilePixels(texName);
  const uv = Atlas.uv(texName);
  const du = uv.u1 - uv.u0, dv = uv.v1 - uv.v0;
  const hd = SPRITE_DEPTH * 0.5;
  const pos = [];
  const nrm = [];
  const uvs = [];
  const col = [];
  const idx = [];
  let base = 0;

  const opaque = (x, y) => (x < 0 || y < 0 || x > 15 || y > 15) ? false : data[(y * TILE + x) * 4 + 3] >= 128;
  const px2x = (v) => v / TILE - 0.5;
  const py2y = (v) => 0.5 - v / TILE;
  const uAt = (v) => uv.u0 + du * (v / TILE);
  const vAt = (v) => uv.v0 + dv * (v / TILE);

  const quad = (a, b, c, d, n, uva, uvb, uvc, uvd, shade) => {
    pos.push(a[0], a[1], a[2], b[0], b[1], b[2], c[0], c[1], c[2], d[0], d[1], d[2]);
    for (let k = 0; k < 4; k++) { nrm.push(n[0], n[1], n[2]); col.push(shade, shade, shade); }
    uvs.push(uva[0], uva[1], uvb[0], uvb[1], uvc[0], uvc[1], uvd[0], uvd[1]);
    idx.push(base, base + 1, base + 2, base, base + 2, base + 3);
    base += 4;
  };

  // Front (+Z) and back (-Z) faces cover the whole tile; alpha testing carves
  // the silhouette out of them for free.
  quad(
    [-0.5, -0.5, hd], [0.5, -0.5, hd], [0.5, 0.5, hd], [-0.5, 0.5, hd],
    [0, 0, 1],
    [uv.u0, uv.v1], [uv.u1, uv.v1], [uv.u1, uv.v0], [uv.u0, uv.v0], 1.0,
  );
  quad(
    [0.5, -0.5, -hd], [-0.5, -0.5, -hd], [-0.5, 0.5, -hd], [0.5, 0.5, -hd],
    [0, 0, -1],
    [uv.u1, uv.v1], [uv.u0, uv.v1], [uv.u0, uv.v0], [uv.u1, uv.v0], 0.85,
  );

  // Vertical edges: -X (left) and +X (right).
  for (let x = 0; x < TILE; x++) {
    for (const dir of [-1, 1]) {
      let y = 0;
      while (y < TILE) {
        if (!(opaque(x, y) && !opaque(x + dir, y))) { y++; continue; }
        let y1 = y;
        while (y1 + 1 < TILE && opaque(x, y1 + 1) && !opaque(x + dir, y1 + 1)) y1++;
        const px = dir < 0 ? px2x(x) : px2x(x + 1);
        const yTop = py2y(y), yBot = py2y(y1 + 1);
        const uu = uAt(x + 0.5);
        const vTop = vAt(y + 0.02), vBot = vAt(y1 + 0.98);
        const n = [dir, 0, 0];
        if (dir < 0) {
          quad([px, yBot, -hd], [px, yBot, hd], [px, yTop, hd], [px, yTop, -hd], n,
            [uu, vBot], [uu, vBot], [uu, vTop], [uu, vTop], 0.7);
        } else {
          quad([px, yBot, hd], [px, yBot, -hd], [px, yTop, -hd], [px, yTop, hd], n,
            [uu, vBot], [uu, vBot], [uu, vTop], [uu, vTop], 0.7);
        }
        y = y1 + 1;
      }
    }
  }

  // Horizontal edges: -Y (top row of a run) and +Y (bottom).
  for (let y = 0; y < TILE; y++) {
    for (const dir of [-1, 1]) {
      let x = 0;
      while (x < TILE) {
        if (!(opaque(x, y) && !opaque(x, y + dir))) { x++; continue; }
        let x1 = x;
        while (x1 + 1 < TILE && opaque(x1 + 1, y) && !opaque(x1 + 1, y + dir)) x1++;
        const py = dir < 0 ? py2y(y) : py2y(y + 1);
        const xa = px2x(x), xb = px2x(x1 + 1);
        const vv = vAt(y + 0.5);
        const ua = uAt(x + 0.02), ub = uAt(x1 + 0.98);
        const n = [0, -dir, 0];
        if (dir < 0) {
          quad([xa, py, -hd], [xb, py, -hd], [xb, py, hd], [xa, py, hd], n,
            [ua, vv], [ub, vv], [ub, vv], [ua, vv], 0.78);
        } else {
          quad([xa, py, hd], [xb, py, hd], [xb, py, -hd], [xa, py, -hd], n,
            [ua, vv], [ub, vv], [ub, vv], [ua, vv], 0.62);
        }
        x = x1 + 1;
      }
    }
  }

  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('normal', new THREE.Float32BufferAttribute(nrm, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
  g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
  g.setIndex(idx);
  g.computeBoundingSphere();
  return g;
}

/** Cached extruded sprite geometry. */
function getSpriteGeometry(texName) {
  let g = _spriteGeoCache.get(texName);
  if (g) return g;
  g = spriteGeometry(texName);
  _spriteGeoCache.set(texName, g);
  return g;
}

/**
 * A skin-mapped box, vanilla unwrap order, in block units. Used for the arm.
 * `w/h/d` are skin pixels; the box hangs down from the origin (the shoulder).
 */
function skinBoxGeometry(w, h, d, u, v, texW, texH) {
  const S = 1 / 16;
  const x0 = -w * 0.5 * S, x1 = w * 0.5 * S;
  const y0 = -h * S, y1 = 0;
  const z0 = -d * 0.5 * S, z1 = d * 0.5 * S;
  const rects = [
    [u, v + d, d, h],                 // +X
    [u + d + w, v + d, d, h],         // -X
    [u + d, v, w, d],                 // +Y
    [u + d + w, v, w, d],             // -Y
    [u + d, v + d, w, h],             // -Z
    [u + d + w + d, v + d, w, h],     // +Z
  ];
  // corner order per face, matching each rect's (0,0),(1,0),(1,1),(0,1)
  const corners = [
    [[x1, y1, z1], [x1, y1, z0], [x1, y0, z0], [x1, y0, z1]],   // +X
    [[x0, y1, z0], [x0, y1, z1], [x0, y0, z1], [x0, y0, z0]],   // -X
    [[x1, y1, z0], [x0, y1, z0], [x0, y1, z1], [x1, y1, z1]],   // +Y
    [[x1, y0, z1], [x0, y0, z1], [x0, y0, z0], [x1, y0, z0]],   // -Y
    [[x1, y1, z0], [x0, y1, z0], [x0, y0, z0], [x1, y0, z0]],   // -Z
    [[x0, y1, z1], [x1, y1, z1], [x1, y0, z1], [x0, y0, z1]],   // +Z
  ];
  const normals = [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, -1], [0, 0, 1]];
  const shade = [0.62, 0.62, 1.0, 0.5, 0.86, 0.86];
  const pos = [], nrm = [], uvs = [], col = [], idx = [];
  let base = 0;
  for (let f = 0; f < 6; f++) {
    const r = rects[f], c = corners[f], n = normals[f], sh = shade[f];
    const eu = 0.016, ev = 0.016;
    const uu0 = (r[0] + eu) / texW, uu1 = (r[0] + r[2] - eu) / texW;
    const vv0 = (r[1] + ev) / texH, vv1 = (r[1] + r[3] - ev) / texH;
    const fuv = [[uu0, vv0], [uu1, vv0], [uu1, vv1], [uu0, vv1]];
    for (let k = 0; k < 4; k++) {
      pos.push(c[k][0], c[k][1], c[k][2]);
      nrm.push(n[0], n[1], n[2]);
      uvs.push(fuv[k][0], fuv[k][1]);
      col.push(sh, sh, sh);
    }
    idx.push(base, base + 1, base + 2, base, base + 2, base + 3);
    base += 4;
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('normal', new THREE.Float32BufferAttribute(nrm, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
  g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
  g.setIndex(idx);
  g.computeBoundingSphere();
  return g;
}

// ---------------------------------------------------------------------------
// Player state probes. player.js is written independently, so every field is
// read defensively - a missing one degrades the animation, never crashes it.
// ---------------------------------------------------------------------------

function heldStackOf(player) {
  if (!player) return null;
  let s = null;
  try {
    if (typeof player.getHeldItem === 'function') s = player.getHeldItem();
    else if (player.inventory && typeof player.inventory.getSelected === 'function') s = player.inventory.getSelected();
    else if (player.heldItem) s = player.heldItem;
  } catch (err) { s = null; }
  if (!s || !s.item || (s.count | 0) <= 0) return null;
  return s;
}

function viewBobbingEnabled() {
  const s = Game.settings;
  if (!s) return true;
  try {
    const v = typeof s.get === 'function' ? s.get('viewBobbing') : (s.values && s.values.viewBobbing);
    return v !== false;
  } catch (err) { return true; }
}

/** World light at the player's eye, mapped to a 0..1 material brightness. */
function eyeBrightness(player) {
  const w = (player && player.world) || Game.world;
  if (!w || typeof w.getLight !== 'function' || !player) return 1;
  try {
    const x = Math.floor(player.x);
    const y = Math.floor(player.y + (player.eyeHeight || PLAYER_EYE));
    const z = Math.floor(player.z);
    const l = clamp(w.getLight(x, y, z), 0, 15) / 15;
    return 0.25 + 0.75 * Math.pow(l, 0.65);
  } catch (err) { return 1; }
}

// ---------------------------------------------------------------------------
// HeldItemView
// ---------------------------------------------------------------------------

const SWING_TIME = 0.28;    // seconds for a full swing arc (~6 ticks)
const EQUIP_TIME = 0.13;    // seconds for the item to drop out / come back up
const BOB_MAX = 0.11;       // matches vanilla's `player.bob` ceiling
const DEG = Math.PI / 180;

/**
 * The first-person view model: whatever the player is holding, parented to the
 * camera, animated for swinging, equipping, eating, drawing a bow, raising a
 * shield and walking.
 */
export class HeldItemView {
  /** @param {THREE.Camera} camera the first-person camera to parent onto */
  constructor(camera) {
    this.camera = camera || null;
    this.group = new THREE.Group();
    this.group.name = 'held_item_view';
    this.group.frustumCulled = false;
    this.group.renderOrder = 900;
    if (this.camera) this.camera.add(this.group);

    this.pivot = new THREE.Group();       // animation transform
    this.pivot.frustumCulled = false;
    this.group.add(this.pivot);
    this.model = new THREE.Group();       // static pose of the item itself
    this.model.frustumCulled = false;
    this.pivot.add(this.model);

    this.mesh = null;
    this.glintMesh = null;
    this._armGeo = null;
    this.kind = 'none';                   // 'block' | 'sprite' | 'arm' | 'none'
    this.currentName = null;
    this.currentEnchanted = false;
    this.pendingStack = null;
    this.lowering = false;

    this.swinging = false;
    this.swingProgress = 0;
    this.equip = 1;                       // 1 = fully lowered, 0 = ready
    this.bobPhase = 0;
    this.bobAmount = 0;
    this.brightness = 1;
    this.enabled = true;
    this.age = 0;

    this._mats = null;
    this._built = false;
    this._euler = new THREE.Euler();
    this._lastPlayer = null;

    // Breaking a block always swings the arm, even if nothing calls swing()
    // explicitly. Other swings (attacks, misses) come through swing().
    this._offBreak = Game.on('blockbreak', (x, y, z, id, breaker) => {
      if (!breaker || breaker === this._lastPlayer) this.swing();
    });
  }

  // -- materials -----------------------------------------------------------

  _materials() {
    if (!this._mats) {
      const atlasTex = Atlas.texture || null;
      this._mats = {
        block: new THREE.MeshBasicMaterial({
          map: atlasTex, vertexColors: true, alphaTest: 0.5,
          side: THREE.FrontSide, transparent: false, fog: false,
        }),
        sprite: new THREE.MeshBasicMaterial({
          map: atlasTex, vertexColors: true, alphaTest: 0.5,
          side: THREE.DoubleSide, transparent: false, fog: false,
        }),
        arm: new THREE.MeshBasicMaterial({
          map: null, vertexColors: true, alphaTest: 0.5,
          side: THREE.DoubleSide, transparent: false, fog: false,
        }),
        // Sampled through the same atlas map so the shimmer follows the item's
        // silhouette instead of squaring off around its bounding box.
        glint: new THREE.MeshBasicMaterial({
          map: atlasTex, color: 0x8844ff, transparent: true, opacity: 0.22,
          alphaTest: 0.5, depthWrite: false, blending: THREE.AdditiveBlending,
          side: THREE.DoubleSide, fog: false,
        }),
      };
    }
    // The atlas may not have been built when this view was constructed.
    if (!this._mats.block.map && Atlas.texture) {
      this._mats.block.map = Atlas.texture;
      this._mats.sprite.map = Atlas.texture;
      this._mats.glint.map = Atlas.texture;
      this._mats.block.needsUpdate = true;
      this._mats.sprite.needsUpdate = true;
      this._mats.glint.needsUpdate = true;
    }
    if (!this._mats.arm.map) {
      try {
        this._mats.arm.map = getSkinTexture('player');
        this._mats.arm.needsUpdate = true;
      } catch (err) { /* skins unavailable: the arm stays untextured */ }
    }
    return this._mats;
  }

  // -- model building ------------------------------------------------------

  _clearModel() {
    while (this.model.children.length) this.model.remove(this.model.children[0]);
    this.mesh = null;
    this.glintMesh = null;
  }

  /** Rebuilds the view model for a stack (null = bare arm). */
  _build(stack) {
    this._clearModel();
    const mats = this._materials();
    this.currentName = stack ? stack.item : null;
    this.currentEnchanted = stack ? isEnchanted(stack) : false;

    if (!stack) {
      this.kind = 'arm';
      const geo = this._armGeometry();
      const mesh = new THREE.Mesh(geo, mats.arm);
      mesh.frustumCulled = false;
      mesh.renderOrder = 900;
      this.mesh = mesh;
      this.model.add(mesh);
      this._poseArm();
      this._built = true;
      return;
    }

    const item = getItem(stack.item);
    const def = item && item.block ? blockByName(item.block) : null;
    const solid = def && def.id > 0 && !FLAT_MODELS.has(def.model) && def.model !== 'door';

    let geo, mat;
    if (solid) {
      this.kind = 'block';
      geo = getBlockGeometry(def);
      mat = mats.block;
    } else {
      this.kind = 'sprite';
      geo = getSpriteGeometry(spriteTextureName(item, def));
      mat = mats.sprite;
    }
    const mesh = new THREE.Mesh(geo, mat);
    mesh.frustumCulled = false;
    mesh.renderOrder = 900;
    this.mesh = mesh;
    this.model.add(mesh);

    if (this.currentEnchanted) {
      const glint = new THREE.Mesh(geo, mats.glint);
      glint.frustumCulled = false;
      glint.renderOrder = 901;
      glint.scale.setScalar(1.02);
      this.glintMesh = glint;
      this.model.add(glint);
    }

    if (this.kind === 'block') this._poseBlock();
    else this._poseSprite();
    this._built = true;
  }

  _armGeometry() {
    if (!this._armGeo) this._armGeo = skinBoxGeometry(4, 12, 4, 40, 16, 64, 64);
    return this._armGeo;
  }

  /** Vanilla-ish `firstperson_righthand` pose for a block. */
  _poseBlock() {
    this.model.position.set(0, 0, 0);
    this.model.rotation.set(0.12, Math.PI * 0.25, 0);
    this.model.scale.setScalar(0.38);
  }

  /** Handheld pose: sprite plane turned slightly and tilted like a tool. */
  _poseSprite() {
    this.model.position.set(0, -0.02, 0);
    this.model.rotation.set(0, -Math.PI * 0.11, Math.PI * 0.16);
    this.model.scale.setScalar(0.48);
  }

  /**
   * The bare arm hangs from the origin (the shoulder) and is swung forward and
   * inward so it enters the frame from the bottom-right corner.
   */
  _poseArm() {
    this.model.position.set(-0.04, 0.12, 0.06);
    this.model.rotation.set(1.0, 0.15, -0.45);
    this.model.scale.setScalar(1);
  }

  // -- public API ----------------------------------------------------------

  /** Starts (or restarts, when it is nearly done) the swing animation. */
  swing() {
    if (!this.swinging || this.swingProgress > 0.45) {
      this.swinging = true;
      this.swingProgress = 0;
    }
  }

  /** Hides or shows the whole view (third person, spectator, screenshots). */
  setVisible(v) { this.group.visible = !!v; }

  /** Detaches from the camera and frees the per-view materials. */
  dispose() {
    if (this._offBreak) { this._offBreak(); this._offBreak = null; }
    this._clearModel();
    if (this.group.parent) this.group.parent.remove(this.group);
    if (this._mats) for (const k of Object.keys(this._mats)) this._mats[k].dispose();
    this._mats = null;
    if (this._armGeo) { this._armGeo.dispose(); this._armGeo = null; }
  }

  /**
   * Advances every animation and syncs the model with the held stack.
   * @param {object} player the local player
   * @param {number} dt seconds since the last frame
   */
  update(player, dt) {
    const step = clamp(dt || 0, 0, 0.1);
    this.age += step;
    this._lastPlayer = player || null;

    // Some players drive the arm themselves; mirror that flag if it appears.
    if (player && player.swinging === true && !this.swinging) this.swing();

    // The camera only renders its children when it is in the scene graph.
    if (this.camera && !this.camera.parent && Game.scene) Game.scene.add(this.camera);

    // main.js may park the F5 camera mode on Game.perspective; 0 / absent is
    // first person, which is the only mode that shows a hand.
    const perspective = Game.perspective | 0;
    const spectator = !!(player && player.gameMode === 'spectator');
    const visible = this.enabled && perspective === 0 && !spectator;
    this.group.visible = visible;
    if (!visible) return;

    const stack = heldStackOf(player);
    const name = stack ? stack.item : null;
    const ench = stack ? isEnchanted(stack) : false;

    // --- equip animation: lower the old item, swap, raise the new one ------
    if (!this._built) {
      this._build(stack);
      this.equip = 1;
    } else if (!this.lowering && (name !== this.currentName || ench !== this.currentEnchanted)) {
      this.lowering = true;
      this.pendingStack = stack;
    }
    if (this.lowering) {
      this.pendingStack = stack;
      this.equip = Math.min(1, this.equip + step / EQUIP_TIME);
      if (this.equip >= 1) {
        this._build(this.pendingStack);
        this.lowering = false;
      }
    } else {
      this.equip = Math.max(0, this.equip - step / EQUIP_TIME);
    }

    // --- swing ------------------------------------------------------------
    if (this.swinging) {
      this.swingProgress += step / SWING_TIME;
      if (this.swingProgress >= 1) { this.swingProgress = 0; this.swinging = false; }
    }

    // --- walk bob ---------------------------------------------------------
    const vx = player ? (player.vx || 0) : 0;
    const vz = player ? (player.vz || 0) : 0;
    const speed = Math.hypot(vx, vz);
    const onGround = player ? player.onGround !== false : true;
    // Vanilla's `player.bob` tops out around 0.1, and its phase advances with
    // walkDist (distance * 0.6), which is what makes the hand sway per step.
    const target = viewBobbingEnabled()
      ? clamp(speed / WALK_SPEED, 0, 1) * BOB_MAX * (onGround ? 1 : 0.35)
      : 0;
    this.bobAmount += (target - this.bobAmount) * Math.min(1, step * 9);
    this.bobPhase += speed * step * 0.6;

    // --- brightness -------------------------------------------------------
    const b = eyeBrightness(player);
    this.brightness += (b - this.brightness) * Math.min(1, step * 6);
    const mats = this._materials();
    const c = this.brightness;
    mats.block.color.setRGB(c, c, c);
    mats.sprite.color.setRGB(c, c, c);
    mats.arm.color.setRGB(c, c, c);
    if (this.glintMesh) {
      mats.glint.opacity = 0.14 + 0.12 * (0.5 + 0.5 * Math.sin(this.age * 3.1));
    }

    this._applyTransform(player, stack);
  }

  // -- transform stack -----------------------------------------------------

  _applyTransform(player, stack) {
    const i = 1;                       // right hand
    const item = stack ? getItem(stack.item) : null;
    const useAction = item ? item.useAction : null;
    const usingNow = !!(player && player.usingItem) && !!useAction;
    const useTicks = player ? Math.max(0, player.useTicks | 0) : 0;

    // Rest pose (vanilla applyItemArmTransform).
    let px = i * 0.56;
    let py = -0.52 - this.equip * 0.6;
    let pz = -0.72;
    let rx = 0, ry = 0, rz = 0;
    let scale = 1;

    if (this.kind === 'arm') { px = i * 0.52; py = -0.62 - this.equip * 0.6; pz = -0.55; }

    // --- walk bob (same shape as vanilla bobView) --------------------------
    if (this.bobAmount > 0.0005) {
      const a = this.bobAmount;
      const ph = this.bobPhase * Math.PI;
      px += Math.sin(ph) * a * 0.5;
      py += -Math.abs(Math.cos(ph) * a);
      rz += Math.sin(ph) * a * DEG * 3;
      rx += Math.abs(Math.cos(ph - 0.2) * a) * DEG * 5;
    }

    // --- use animations ---------------------------------------------------
    if (usingNow && (useAction === 'eat' || useAction === 'drink')) {
      // Vanilla applyEatTransform, but composed additively onto our rest pose
      // instead of wrapping it, so the food is raised to the mouth rather than
      // flung off the right edge of the screen.
      const dur = Math.max(1, item.useDuration || 32);
      const remaining = Math.max(0, dur - useTicks);
      const f1 = clamp(remaining / dur, 0, 1);
      if (f1 < 0.8) py += Math.abs(Math.cos((remaining / 4) * Math.PI) * 0.1);
      const f3 = 1 - Math.pow(f1, 27);
      px += f3 * -0.20 * i;
      py += f3 * -0.06;
      pz += f3 * 0.20;
      ry += i * f3 * 0.70;
      rx += f3 * 0.35;
      rz += i * f3 * 0.30;
    } else if (usingNow && (useAction === 'bow' || useAction === 'crossbow')) {
      // Pull the bow into the middle of the screen as the charge builds.
      let charge = clamp(useTicks / 20, 0, 1);
      charge = clamp((charge * charge + charge * 2) / 3, 0, 1);
      px += -0.279 * i - charge * 0.09 * i;
      py += 0.183;
      pz += 0.157 + charge * 0.05;
      rx += -0.243;
      ry += i * 0.616 - i * 0.7854;
      rz += i * -0.171;
      scale *= 1 + charge * 0.08;
      if (charge > 0.1) {
        // The classic little wobble once the bow is nearly drawn.
        py += Math.sin((useTicks - 2) * 1.3) * (charge - 0.1) * 0.012;
      }
    } else if (usingNow && useAction === 'block') {
      // Shield raised across the body.
      px += -0.24 * i;
      py += 0.06;
      pz += 0.16;
      ry += i * -0.55;
      rx += 0.12;
      rz += i * -0.2;
      scale *= 1.06;
    } else if (usingNow && useAction === 'spyglass') {
      px += -0.44 * i;
      py += 0.22;
      pz += 0.24;
      ry += i * -0.28;
    }

    // --- swing ------------------------------------------------------------
    const s = this.swinging ? clamp(this.swingProgress, 0, 1) : 0;
    if (s > 0) {
      const f1 = Math.sin(Math.sqrt(s) * Math.PI);
      const f2 = Math.sin(s * s * Math.PI);
      px += -0.4 * f1 * i;
      py += 0.2 * Math.sin(Math.sqrt(s) * Math.PI * 2);
      pz += -0.2 * f2;
      ry += i * (f2 * -0.35);
      rz += i * f1 * -0.35;
      rx += f1 * -1.4;
    }

    this.pivot.position.set(px, py, pz);
    this._euler.set(rx, ry, rz, 'YXZ');
    this.pivot.rotation.copy(this._euler);
    this.pivot.scale.setScalar(scale);
  }
}

export default HeldItemView;
