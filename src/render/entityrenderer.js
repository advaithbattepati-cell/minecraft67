// ============================================================================
// entityrenderer.js - three.js lifecycle for every entity (CONTRACT.md §16).
//
// One record per live entity, keyed by entity id. Each frame the renderer
//   1. walks world.entities, creating records for newcomers,
//   2. interpolates position/rotation, poses the box model, hangs the extras
//      (name tag, fire, shadow, glow, leash, held item, armour, hitbox) on it,
//   3. frustum-culls, and
//   4. reaps records whose entity vanished, disposing what it owns.
//
// LOOK CONVENTION
// ---------------
// The game's yaw is Minecraft's: forward = (-sin yaw, 0, cos yaw), yaw grows
// clockwise. three.js rotates the other way, so a model that faces -Z needs
//     group.rotation.y = PI - yaw
// which is exactly the conversion player.js applies to the camera. The same
// mirror flips the sign of every head/body yaw delta and of pitch, so the
// entity handed to `animateModel` is a prototype-linked proxy with those four
// angles negated. Everything else on the entity reads straight through.
//
// OWNERSHIP
// ---------
// Geometry that depends only on a size or a block id is cached at module scope
// and never disposed; anything allocated per record (model instances, tinted
// materials, name-tag sprites, line geometry) is disposed when the record dies.
// Cross-module calls are wrapped, because a half-finished neighbour must cost
// one entity, not the whole scene.
// ============================================================================
import * as THREE from 'three';

import { Game } from '../core/game.js';
import { clamp, angleDiff } from '../core/util.js';
import {
  TICK_MS, WORLD_HEIGHT,
  FACE_DOWN, FACE_UP, FACE_NORTH, FACE_SOUTH, FACE_WEST, FACE_EAST,
} from '../core/constants.js';
import { buildModel, animateModel, disposeModel } from './models.js';
import { Atlas } from './atlas.js';
import { itemIcon } from './itemrender.js';
import { getBlock, getTexture } from '../world/blocks.js';
import { getItem } from '../item/items.js';

const TICK_SECONDS = TICK_MS / 1000;
const PI = Math.PI;

// ---------------------------------------------------------------------------
// Module-level switches the F3 overlay drives
// ---------------------------------------------------------------------------

let _hitboxDebug = false;
let _renderCount = 0;

/**
 * Turns the wireframe hitbox overlay on or off. The F3 overlay calls this.
 * @param {boolean} on
 * @returns {boolean} the flag as it now stands
 */
export function setHitboxDebug(on) {
  _hitboxDebug = !!on;
  return _hitboxDebug;
}

/**
 * How many entities survived culling on the most recent frame.
 * @returns {number}
 */
export function entityRenderCount() {
  return _renderCount;
}

// ---------------------------------------------------------------------------
// Tiny helpers
// ---------------------------------------------------------------------------

/** Reads a setting without ever throwing when settings are not up yet. */
function setting(key, dflt) {
  try {
    const v = Game.settings && Game.settings.get(key);
    return v === undefined || v === null ? dflt : v;
  } catch (err) {
    return dflt;
  }
}

function canvasOf(w, h) {
  const c = typeof document !== 'undefined' ? document.createElement('canvas') : null;
  if (!c) return null;
  c.width = w; c.height = h;
  return c;
}

/** Deterministic LCG so every procedural texture is identical every run. */
function lcg(seed) {
  let s = seed >>> 0;
  return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; };
}

function nearestTexture(canvas, srgb) {
  const t = new THREE.CanvasTexture(canvas);
  t.magFilter = THREE.NearestFilter;
  t.minFilter = THREE.NearestFilter;
  t.generateMipmaps = false;
  t.wrapS = THREE.ClampToEdgeWrapping;
  t.wrapT = THREE.ClampToEdgeWrapping;
  if (srgb && THREE.SRGBColorSpace) t.colorSpace = THREE.SRGBColorSpace;
  t.needsUpdate = true;
  return t;
}

// ---------------------------------------------------------------------------
// Shared procedural textures
// ---------------------------------------------------------------------------

const FIRE_FRAMES = 8;
let _fireTex = null;

/** A vertical strip of `FIRE_FRAMES` hand-drawn flames, animated by uv offset. */
function fireTexture() {
  if (_fireTex) return _fireTex;
  const W = 32, H = 32;
  const c = canvasOf(W, H * FIRE_FRAMES);
  if (!c) return null;
  const g = c.getContext('2d');
  const rnd = lcg(0x5eed1e);
  for (let f = 0; f < FIRE_FRAMES; f++) {
    const oy = f * H;
    const phase = (f / FIRE_FRAMES) * PI * 2;
    for (let x = 0; x < W; x++) {
      const nx = ((x + 0.5) / W) * 2 - 1;                 // -1 .. 1
      // Full height across the middle, tapering only over the outer sliver,
      // so the sheet reads as a wall of flame rather than a candle.
      const edge = clamp(1 - Math.pow(Math.abs(nx) / 0.96, 3), 0, 1);
      const lick = Math.sin(phase + nx * 5) * 0.5 + Math.sin(phase * 1.7 - nx * 11) * 0.28;
      const h = clamp(edge * (0.84 + lick * 0.15), 0, 1) * H;
      if (h < 1) continue;
      const fade = clamp(1.3 - Math.abs(nx) * 0.85, 0, 1);
      for (let y = H - 1; y >= 0; y--) {
        const up = H - 1 - y;
        if (up > h) break;
        const t = up / h;                                 // 0 at the base, 1 at the tip
        if (t > 0.9 && rnd() < 0.5) continue;             // ragged tip
        let col;
        if (t < 0.16) col = '#fffbcf';
        else if (t < 0.4) col = '#ffdc44';
        else if (t < 0.67) col = '#f89b1c';
        else if (t < 0.87) col = '#e05c12';
        else col = '#b8300a';
        g.globalAlpha = clamp((1 - t * 0.3 - rnd() * 0.1) * fade, 0.08, 1);
        g.fillStyle = col;
        g.fillRect(x, oy + y, 1, 1);
      }
    }
  }
  g.globalAlpha = 1;
  const tex = nearestTexture(c, true);
  tex.repeat.set(1, 1 / FIRE_FRAMES);
  _fireTex = tex;
  return tex;
}

let _softTex = null;
/** A soft radial blob, reused for shadows, glows and XP orbs. */
function softTexture() {
  if (_softTex) return _softTex;
  const N = 64;
  const c = canvasOf(N, N);
  if (!c) return null;
  const g = c.getContext('2d');
  const grd = g.createRadialGradient(N / 2, N / 2, 0, N / 2, N / 2, N / 2);
  grd.addColorStop(0, 'rgba(255,255,255,1)');
  grd.addColorStop(0.45, 'rgba(255,255,255,0.82)');
  grd.addColorStop(0.78, 'rgba(255,255,255,0.24)');
  grd.addColorStop(1, 'rgba(255,255,255,0)');
  g.fillStyle = grd;
  g.fillRect(0, 0, N, N);
  const t = new THREE.CanvasTexture(c);
  t.magFilter = THREE.LinearFilter;
  t.minFilter = THREE.LinearFilter;
  t.generateMipmaps = false;
  t.needsUpdate = true;
  _softTex = t;
  return t;
}

// ---------------------------------------------------------------------------
// Shared geometry
// ---------------------------------------------------------------------------

let _quadGeo = null;
function quadGeometry() {
  if (!_quadGeo) _quadGeo = new THREE.PlaneGeometry(1, 1);
  return _quadGeo;
}

let _groundQuadGeo = null;
/** A unit quad lying in the XZ plane, facing +Y. */
function groundQuadGeometry() {
  if (!_groundQuadGeo) {
    _groundQuadGeo = new THREE.PlaneGeometry(1, 1);
    _groundQuadGeo.rotateX(-PI / 2);
  }
  return _groundQuadGeo;
}

let _edgesGeo = null;
/** Unit cube edges centred on the origin, for the hitbox overlay. */
function edgesGeometry() {
  if (!_edgesGeo) {
    const box = new THREE.BoxGeometry(1, 1, 1);
    _edgesGeo = new THREE.EdgesGeometry(box);
    box.dispose();
  }
  return _edgesGeo;
}

// Minecraft's per-face directional shading, baked into vertex colours so an
// unlit MeshBasicMaterial still reads as a solid box.
const BOX_FACE_SHADE = [0.62, 0.62, 1.0, 0.5, 0.86, 0.86];   // +X -X +Y -Y +Z -Z
const _boxGeoCache = new Map();

/**
 * A box with directional shading baked into vertex colours. Cached by size.
 * @param {number} w @param {number} h @param {number} d
 * @returns {THREE.BufferGeometry}
 */
function shadedBox(w, h, d) {
  const key = `${w.toFixed(4)}|${h.toFixed(4)}|${d.toFixed(4)}`;
  let g = _boxGeoCache.get(key);
  if (g) return g;
  g = new THREE.BoxGeometry(w, h, d);
  const col = new Float32Array(24 * 3);
  for (let f = 0; f < 6; f++) {
    const s = BOX_FACE_SHADE[f];
    for (let i = 0; i < 4; i++) {
      const k = (f * 4 + i) * 3;
      col[k] = s; col[k + 1] = s; col[k + 2] = s;
    }
  }
  g.setAttribute('color', new THREE.BufferAttribute(col, 3));
  _boxGeoCache.set(key, g);
  return g;
}

// --- textured block cubes ---------------------------------------------------
// u x v === n for every face, so the TL,BL,BR,TR winding is front-facing and
// the texture's top edge lands on the face's top edge.
const CUBE_FACES = [
  { f: FACE_DOWN, n: [0, -1, 0], u: [-1, 0, 0], v: [0, 0, -1], shade: 0.5 },
  { f: FACE_UP, n: [0, 1, 0], u: [-1, 0, 0], v: [0, 0, 1], shade: 1.0 },
  { f: FACE_NORTH, n: [0, 0, -1], u: [-1, 0, 0], v: [0, 1, 0], shade: 0.8 },
  { f: FACE_SOUTH, n: [0, 0, 1], u: [1, 0, 0], v: [0, 1, 0], shade: 0.8 },
  { f: FACE_WEST, n: [-1, 0, 0], u: [0, 0, 1], v: [0, 1, 0], shade: 0.6 },
  { f: FACE_EAST, n: [1, 0, 0], u: [0, 0, -1], v: [0, 1, 0], shade: 0.6 },
];
const CORNERS = [[-1, 1], [-1, -1], [1, -1], [1, 1]];   // TL, BL, BR, TR

const _blockGeoCache = new Map();

/**
 * A unit cube textured from the atlas for one block value. Used by falling
 * blocks, primed TNT, minecart contents and blocks held in a mob's hand.
 * @param {number} id block id
 * @param {number} meta block metadata
 * @returns {THREE.BufferGeometry}
 */
function blockCubeGeometry(id, meta) {
  const key = id + ':' + meta;
  let geo = _blockGeoCache.get(key);
  if (geo) return geo;

  const position = new Float32Array(72);
  const normal = new Float32Array(72);
  const color = new Float32Array(72);
  const uv = new Float32Array(48);
  const index = new Uint16Array(36);
  let vi = 0, ui = 0, ii = 0, base = 0;

  for (let i = 0; i < 6; i++) {
    const F = CUBE_FACES[i];
    let rect = { u0: 0, v0: 0, u1: 1, v1: 1 };
    try {
      const texName = getTexture(id, meta, F.f);
      rect = Atlas.uv(texName) || rect;
    } catch (err) {
      // Missing atlas or block registry: fall back to the whole atlas tile 0.
    }
    const uvc = [
      [rect.u0, rect.v0], [rect.u0, rect.v1], [rect.u1, rect.v1], [rect.u1, rect.v0],
    ];
    for (let k = 0; k < 4; k++) {
      const su = CORNERS[k][0], sv = CORNERS[k][1];
      position[vi] = 0.5 * (F.n[0] + F.u[0] * su + F.v[0] * sv);
      position[vi + 1] = 0.5 * (F.n[1] + F.u[1] * su + F.v[1] * sv);
      position[vi + 2] = 0.5 * (F.n[2] + F.u[2] * su + F.v[2] * sv);
      normal[vi] = F.n[0]; normal[vi + 1] = F.n[1]; normal[vi + 2] = F.n[2];
      color[vi] = F.shade; color[vi + 1] = F.shade; color[vi + 2] = F.shade;
      vi += 3;
      uv[ui] = uvc[k][0]; uv[ui + 1] = uvc[k][1];
      ui += 2;
    }
    index[ii++] = base; index[ii++] = base + 1; index[ii++] = base + 2;
    index[ii++] = base; index[ii++] = base + 2; index[ii++] = base + 3;
    base += 4;
  }

  geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(position, 3));
  geo.setAttribute('normal', new THREE.BufferAttribute(normal, 3));
  geo.setAttribute('color', new THREE.BufferAttribute(color, 3));
  geo.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  geo.setIndex(new THREE.BufferAttribute(index, 1));
  geo.computeBoundingSphere();
  geo.computeBoundingBox();
  _blockGeoCache.set(key, geo);
  return geo;
}

/** A fresh material sampling the block atlas. One per record, so it can tint. */
function blockMaterial() {
  const m = new THREE.MeshBasicMaterial({
    vertexColors: true,
    alphaTest: 0.1,
    side: THREE.FrontSide,
    fog: true,
  });
  m.userData.atlas = true;
  ensureAtlasMap(m);
  return m;
}

/** Attaches the atlas map once it exists, in case a record outran buildAtlas. */
function ensureAtlasMap(m) {
  if (!m || m.map) return;
  if (Atlas && Atlas.texture) { m.map = Atlas.texture; m.needsUpdate = true; }
}

// ---------------------------------------------------------------------------
// Item icon textures
// ---------------------------------------------------------------------------

const _iconTexCache = new Map();

/** Cached THREE texture for an item's 2D icon canvas. Never throws. */
function iconTexture(itemName) {
  const key = itemName || 'air';
  if (_iconTexCache.has(key)) return _iconTexCache.get(key);
  let tex = null;
  try {
    const c = itemIcon(key);
    if (c && c.width) tex = nearestTexture(c, true);
  } catch (err) {
    tex = null;
  }
  _iconTexCache.set(key, tex);
  return tex;
}

/** A double-sided quad showing an item icon. */
function itemQuad(itemName) {
  const mat = new THREE.MeshBasicMaterial({
    map: iconTexture(itemName),
    transparent: true,
    alphaTest: 0.32,
    side: THREE.DoubleSide,
    depthWrite: true,
    fog: true,
  });
  const mesh = new THREE.Mesh(quadGeometry(), mat);
  mesh.frustumCulled = false;
  return mesh;
}

// ---------------------------------------------------------------------------
// Name tags
// ---------------------------------------------------------------------------

const _tagTexCache = new Map();

/** Bakes a name-tag canvas (dark plate + white label). Cached by text. */
function nameTagTexture(text) {
  const key = String(text);
  const hit = _tagTexCache.get(key);
  if (hit !== undefined) return hit;
  let entry = null;
  const probe = canvasOf(8, 8);
  if (probe) {
    const pad = 12;
    const font = 'bold 34px system-ui, "Segoe UI", Roboto, Helvetica, Arial, sans-serif';
    const pctx = probe.getContext('2d');
    pctx.font = font;
    const w = Math.min(768, Math.ceil(pctx.measureText(key).width) + pad * 2);
    const h = 56;
    const c = canvasOf(w, h);
    const g = c.getContext('2d');
    g.clearRect(0, 0, w, h);
    g.fillStyle = 'rgba(0,0,0,0.32)';
    g.fillRect(0, 0, w, h);
    g.font = font;
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    g.fillStyle = 'rgba(0,0,0,0.65)';
    g.fillText(key, w / 2 + 2, h / 2 + 2);
    g.fillStyle = '#ffffff';
    g.fillText(key, w / 2, h / 2);
    const t = new THREE.CanvasTexture(c);
    t.magFilter = THREE.LinearFilter;
    t.minFilter = THREE.LinearFilter;
    t.generateMipmaps = false;
    if (THREE.SRGBColorSpace) t.colorSpace = THREE.SRGBColorSpace;
    t.needsUpdate = true;
    entry = { texture: t, aspect: w / h };
  }
  _tagTexCache.set(key, entry);
  return entry;
}

// ---------------------------------------------------------------------------
// Colours
// ---------------------------------------------------------------------------

const ARMOR_TINTS = [
  ['netherite', 0x4a4247], ['diamond', 0x6fe8d6], ['golden', 0xf6d33c], ['gold', 0xf6d33c],
  ['iron', 0xd9d9d9], ['chainmail', 0x9a9a9a], ['leather', 0xa9714b], ['turtle', 0x54a34a],
];

/** Flat colour used for a worn armour piece. */
function armorColor(stack) {
  const name = (stack && stack.item) || '';
  if (stack && typeof stack.color === 'number') return stack.color;
  for (let i = 0; i < ARMOR_TINTS.length; i++) {
    if (name.indexOf(ARMOR_TINTS[i][0]) === 0) return ARMOR_TINTS[i][1];
  }
  return 0xb6b6b6;
}

const GLOW_COLORS = {
  spectral: 0xf2e58a,
  glowing: 0xa8ecff,
};

// ---------------------------------------------------------------------------
// Entity introspection
// ---------------------------------------------------------------------------

const SLOT_INDEX = { head: 0, chest: 1, legs: 2, feet: 3, mainhand: 4, offhand: 5 };

/**
 * Reads one equipment slot. Mobs keep an object keyed by slot name, the player
 * and plain living entities keep a six-element array; both shapes work here.
 * @param {object} e @param {string} slot 'head'|'chest'|'legs'|'feet'|'mainhand'|'offhand'
 * @returns {object|null} an item stack or null
 */
function equipOf(e, slot) {
  try {
    const eq = e.equipment;
    if (eq && !Array.isArray(eq) && typeof eq === 'object') {
      const s = eq[slot];
      if (s !== undefined) return s && s.item ? s : null;
    }
    if (typeof e.getEquipment === 'function') {
      const s = e.getEquipment(SLOT_INDEX[slot]);
      if (s && s.item) return s;
      return null;
    }
    if (Array.isArray(eq)) {
      const s = eq[SLOT_INDEX[slot]];
      return s && s.item ? s : null;
    }
  } catch (err) {
    /* an entity with an exotic inventory simply renders bare */
  }
  return null;
}

/** A stable string for the six equipment slots, so changes trigger a rebuild. */
function equipSignature(e) {
  let sig = '';
  for (const slot in SLOT_INDEX) {
    const s = equipOf(e, slot);
    sig += (s ? s.item : '-') + ',';
  }
  return sig;
}

/** Which rendering path an entity takes. */
function kindOf(e) {
  const model = e.model;
  if (model === 'xp_orb' || e.type === 'xp_orb' || e.type === 'experience_orb') return 'orb';
  if (e.renderBlock || model === 'block') return 'block';
  if (model === 'end_crystal' || e.type === 'end_crystal') return 'crystal';
  if (e.type === 'item' || (model === 'item' && e.stack !== undefined && !e.projectile)) return 'item';
  if (e.projectile || e.billboard || model === 'projectile') {
    return (e.renderItem || e.itemName) ? 'projectile' : 'none';
  }
  if (model === 'leash_knot') return 'knot';
  if (model === 'painting') return 'painting';
  if (model === 'item_frame') return 'frame';
  // An entity that only claims the shared 'item' billboard but carries nothing
  // to draw (an area-effect cloud, say) is left to particles.js.
  if (model === 'item') return (e.renderItem || e.itemName) ? 'projectile' : 'none';
  return 'model';
}

/** Model name for the box-model path. */
function modelNameOf(e) {
  return e.modelName || (typeof e.model === 'string' ? e.model : null) || e.mobName || e.type || 'humanoid';
}

/** Skin name for the box-model path. */
function skinNameOf(e) {
  return e.skinName || e.skin || e.mobName || e.type || 'player';
}

/** Only humanoid-shaped models get armour and hand items. */
function isHumanoidInstance(inst) {
  const p = inst && inst.parts;
  return !!(p && p.head && p.body && (p.right_arm || p.left_arm));
}

// ---------------------------------------------------------------------------
// Geometry helpers for attachments
// ---------------------------------------------------------------------------

function partBounds(obj) {
  if (!obj || !obj.geometry) return null;
  const g = obj.geometry;
  if (!g.boundingBox) g.computeBoundingBox();
  return g.boundingBox;
}

/**
 * Adds an inflated shaded box over part of a model part, used for armour.
 * @param {THREE.Object3D} parent the model part to clad
 * @param {number} t0 lower fraction of the part's height (0 = bottom)
 * @param {number} t1 upper fraction
 * @param {number} inflate world-space padding
 * @param {number} color base colour
 * @param {Array} sink array collecting the created meshes/materials
 */
function cladPart(parent, t0, t1, inflate, color, sink) {
  const bb = partBounds(parent);
  if (!bb) return null;
  const sx = bb.max.x - bb.min.x;
  const sy = bb.max.y - bb.min.y;
  const sz = bb.max.z - bb.min.z;
  if (!(sy > 0)) return null;
  const y0 = bb.min.y + sy * t0;
  const y1 = bb.min.y + sy * t1;
  const geo = shadedBox(sx + inflate * 2, (y1 - y0) + inflate * 2, sz + inflate * 2);
  const mat = new THREE.MeshBasicMaterial({ vertexColors: true, fog: true });
  mat.color.setHex(color);
  const mesh = new THREE.Mesh(geo, mat);
  mesh.position.set((bb.min.x + bb.max.x) / 2, (y0 + y1) / 2, (bb.min.z + bb.max.z) / 2);
  mesh.frustumCulled = false;
  parent.add(mesh);
  sink.push({ mesh, mat, base: new THREE.Color(color), parent });
  return mesh;
}

/** Puts an item in a model part's hand. */
function attachHandItem(parent, stack, left, sink) {
  const bb = partBounds(parent);
  if (!bb || !stack || !stack.item) return null;
  const def = (() => { try { return getItem(stack.item); } catch (err) { return null; } })();
  const cx = (bb.min.x + bb.max.x) / 2;
  const cz = (bb.min.z + bb.max.z) / 2;
  const hy = bb.min.y;

  let mesh = null;
  const base = new THREE.Color(1, 1, 1);
  const blockName = def && def.block;
  if (blockName) {
    let bid = 0;
    try { bid = blockIdFromName(blockName); } catch (err) { bid = 0; }
    if (bid > 0) {
      const mat = blockMaterial();
      mesh = new THREE.Mesh(blockCubeGeometry(bid, 0), mat);
      mesh.scale.setScalar(0.38);
      mesh.position.set(cx, hy + 0.1, cz - 0.04);
      mesh.rotation.set(0, left ? -0.35 : 0.35, 0);
      sink.push({ mesh, mat, base, parent });
    }
  }
  if (!mesh) {
    const q = itemQuad(stack.item);
    q.scale.setScalar(0.62);
    q.position.set(cx, hy + 0.12, cz - 0.02);
    q.rotation.set(0, PI / 2, left ? 0.25 : -0.25);
    mesh = q;
    sink.push({ mesh, mat: q.material, base, parent });
  }
  mesh.frustumCulled = false;
  parent.add(mesh);
  return mesh;
}

let _blockNameIds = null;
/** Lazily built name -> id map, so held blocks do not need blocks.js internals. */
function blockIdFromName(name) {
  if (!_blockNameIds) {
    _blockNameIds = new Map();
    for (let id = 1; id < 4096; id++) {
      let def = null;
      try { def = getBlock(id); } catch (err) { break; }
      if (!def || !def.name || def.name === 'air') continue;
      if (!_blockNameIds.has(def.name)) _blockNameIds.set(def.name, id);
    }
  }
  return _blockNameIds.get(name) || 0;
}

// ---------------------------------------------------------------------------
// The renderer
// ---------------------------------------------------------------------------

const _tmpV = new THREE.Vector3();
const _tmpV2 = new THREE.Vector3();
const _tmpQ = new THREE.Quaternion();
const _tmpSphere = new THREE.Sphere();
const _tmpMat = new THREE.Matrix4();

export class EntityRenderer {
  /**
   * @param {THREE.Scene} scene the scene entities are added to
   */
  constructor(scene) {
    this.scene = scene || null;

    /** Everything this renderer owns hangs off one group, so clear() is cheap. */
    this.root = new THREE.Group();
    this.root.name = 'entities';
    this.root.frustumCulled = false;
    if (this.scene && typeof this.scene.add === 'function') this.scene.add(this.root);

    /** @type {Map<number, object>} entity id -> record */
    this.records = new Map();

    this.frame = 0;
    this.rendered = 0;
    this.maxDistance = 96;

    this._sinceTick = 0;
    this._lastTick = -1;
    this._frustum = new THREE.Frustum();
    this._fireFrame = 0;
    this._fireTimer = 0;
    this._warned = new Set();
  }

  /** Logs a cross-module failure once per site, then keeps quiet. */
  _warn(site, err) {
    if (this._warned.has(site)) return;
    this._warned.add(site);
    console.warn('[entityrenderer] ' + site, err);
  }

  // -------------------------------------------------------------------------
  // Frame entry point
  // -------------------------------------------------------------------------

  /**
   * Syncs three.js objects with `world.entities`, animates them and culls.
   * @param {object} world the active World
   * @param {number} dt seconds since the previous frame
   * @param {THREE.Camera} camera the render camera
   */
  update(world, dt, camera) {
    if (!world || !Array.isArray(world.entities)) return;
    const cam = camera || Game.camera || null;
    const step = dt > 0 ? Math.min(dt, 0.1) : 0;

    // --- tick partial ------------------------------------------------------
    // main.js runs the fixed tick loop before this call, so a change in
    // Game.ticks marks the start of a fresh tick window.
    const ticks = Game.ticks | 0;
    if (ticks !== this._lastTick) { this._lastTick = ticks; this._sinceTick = 0; }
    this._sinceTick += step;
    const partial = clamp(this._sinceTick / TICK_SECONDS, 0, 1);

    // --- animated fire strip ----------------------------------------------
    this._fireTimer += step;
    while (this._fireTimer > 0.055) {
      this._fireTimer -= 0.055;
      this._fireFrame = (this._fireFrame + 1) % FIRE_FRAMES;
    }

    // --- view state --------------------------------------------------------
    const player = Game.player || null;
    let firstPerson = false;
    if (cam && player) {
      const eyeY = player.y + (player.eyeHeight || 1.62);
      const dx = cam.position.x - player.x;
      const dy = cam.position.y - eyeY;
      const dz = cam.position.z - player.z;
      firstPerson = (dx * dx + dy * dy + dz * dz) < 0.5625;   // player.js uses 0.75 blocks
    }

    const rd = setting('renderDistance', 8);
    this.maxDistance = clamp((Number(rd) || 8) * 16, 48, 160);
    const maxSq = this.maxDistance * this.maxDistance;

    if (cam) {
      // The renderer refreshes matrixWorldInverse during render(), which is
      // after this call, so do it here to cull against *this* frame's view.
      cam.updateMatrixWorld();
      cam.matrixWorldInverse.copy(cam.matrixWorld).invert();
      _tmpMat.multiplyMatrices(cam.projectionMatrix, cam.matrixWorldInverse);
      this._frustum.setFromProjectionMatrix(_tmpMat);
      _tmpQ.copy(cam.quaternion).invert();
    }

    const camX = cam ? cam.position.x : (player ? player.x : 0);
    const camY = cam ? cam.position.y : (player ? player.y : 0);
    const camZ = cam ? cam.position.z : (player ? player.z : 0);

    const shadowsOn = setting('entityShadows', true) !== false;
    const fancy = setting('fancyGraphics', true) !== false;

    this.frame++;
    let rendered = 0;

    const list = world.entities;
    for (let i = 0; i < list.length; i++) {
      const e = list[i];
      if (!e || e.removed) continue;
      if (e === player && firstPerson) continue;
      if (e.world && e.world !== world) continue;

      const dx = e.x - camX, dy = e.y - camY, dz = e.z - camZ;
      const dsq = dx * dx + dy * dy + dz * dz;
      if (dsq > maxSq) continue;

      let rec = this.records.get(e.id);
      if (!rec || rec.entity !== e) {
        if (rec) this._destroy(rec);
        rec = this._create(e);
        if (!rec) continue;
        this.records.set(e.id, rec);
      }
      rec.lastSeen = this.frame;

      // --- frustum culling ---------------------------------------------------
      // Done before the animation work, on the raw position: interpolation
      // moves an entity by well under the sphere's padding, and skipping the
      // pose/attachment pass for off-screen mobs is most of the saving.
      let visible = true;
      if (cam) {
        const w = Math.max(0.4, e.width || 0.6);
        const h = Math.max(0.4, e.height || 1.8);
        _tmpSphere.center.set(e.x, e.y + h * 0.5, e.z);
        _tmpSphere.radius = Math.max(w, h) * 0.75 + 1;
        visible = this._frustum.intersectsSphere(_tmpSphere);
      }
      rec.group.visible = visible;
      if (rec.leash) rec.leash.visible = visible;
      if (!visible) continue;
      rendered++;

      try {
        this._sync(rec, e, world, step, partial, cam, shadowsOn, fancy, Math.sqrt(dsq));
      } catch (err) {
        this._warn('sync:' + rec.kind, err);
        rec.group.visible = false;
      }
    }

    // --- reap --------------------------------------------------------------
    for (const [id, rec] of this.records) {
      if (rec.lastSeen === this.frame) continue;
      rec.group.visible = false;
      if (rec.leash) rec.leash.visible = false;
      // A little hysteresis, so an entity dancing on the distance limit does
      // not rebuild its model every other frame.
      if (this.frame - rec.lastSeen > 40 || rec.entity.removed) {
        this._destroy(rec);
        this.records.delete(id);
      }
    }

    this.rendered = rendered;
    _renderCount = rendered;
    try { Game.stats.entitiesRendered = rendered; } catch (err) { /* stats are optional */ }
  }

  // -------------------------------------------------------------------------
  // Record lifecycle
  // -------------------------------------------------------------------------

  /** Builds the three.js objects for one entity. */
  _create(e) {
    const kind = kindOf(e);
    const group = new THREE.Group();
    group.name = 'e' + e.id;
    group.frustumCulled = false;
    this.root.add(group);

    const rec = {
      entity: e,
      id: e.id,
      kind,
      group,
      body: null,          // the rotating/animated child
      inst: null,          // models.js instance, when kind === 'model'
      anim: null,          // prototype-linked proxy handed to animateModel
      mats: [],            // every material this record owns and must dispose
      bodyMats: [],        // the subset tinted by light / hurt / death fade
      geos: [],            // geometry this record owns and must dispose
      attach: [],          // armour / held items: { mesh, mat, base, parent }
      equipSig: '',
      modelKey: '',
      blockKey: '',
      itemKey: '',
      shadow: null,
      groundY: undefined,   // cached blob-shadow height
      groundFrame: -1000,
      groundX: 0, groundZ: 0, groundEyeY: 0,
      fire: null,
      tag: null,
      tagText: '',
      glow: null,
      glowKey: '',
      hitbox: null,
      leash: null,
      leashPos: null,
      lastSeen: 0,
      rx: e.x, ry: e.y, rz: e.z,
    };

    try {
      switch (kind) {
        case 'model': this._buildModelBody(rec, e); break;
        case 'item': this._buildItemBody(rec, e); break;
        case 'orb': this._buildOrbBody(rec, e); break;
        case 'block': this._buildBlockBody(rec, e); break;
        case 'crystal': this._buildCrystalBody(rec, e); break;
        case 'projectile': this._buildProjectileBody(rec, e); break;
        case 'frame': this._buildFrameBody(rec, e); break;
        case 'painting': this._buildPaintingBody(rec, e); break;
        case 'knot': this._buildKnotBody(rec, e); break;
        default: break;
      }
    } catch (err) {
      this._warn('create:' + kind, err);
    }
    return rec;
  }

  /** Frees everything a record owns and unhooks it from the scene. */
  _destroy(rec) {
    if (!rec) return;
    try {
      this._clearAttachments(rec);
      if (rec.inst) disposeModel(rec.inst);
      if (rec.glow) this._clearGlow(rec);
      for (let i = 0; i < rec.mats.length; i++) {
        const m = rec.mats[i];
        if (m && typeof m.dispose === 'function') m.dispose();
      }
      for (let i = 0; i < rec.geos.length; i++) {
        const g = rec.geos[i];
        if (g && typeof g.dispose === 'function') g.dispose();
      }
      if (rec.tag && rec.tag.material) rec.tag.material.dispose();
      if (rec.leash) {
        if (rec.leash.geometry) rec.leash.geometry.dispose();
        if (rec.leash.material) rec.leash.material.dispose();
        this.root.remove(rec.leash);
      }
      rec.group.clear();
      this.root.remove(rec.group);
    } catch (err) {
      this._warn('destroy', err);
    }
    rec.mats = [];
    rec.bodyMats = [];
    rec.geos = [];
    rec.attach = [];
    rec.inst = null;
    rec.body = null;
    rec.leash = null;
  }

  /** Drops the materials belonging to the body mesh, keeping the extras'. */
  _disposeBodyMats(rec) {
    for (let i = 0; i < rec.bodyMats.length; i++) {
      const m = rec.bodyMats[i];
      const k = rec.mats.indexOf(m);
      if (k >= 0) rec.mats.splice(k, 1);
      if (m && typeof m.dispose === 'function') m.dispose();
    }
    rec.bodyMats.length = 0;
  }

  /** Drops every model instance and mesh. Called on a dimension change. */
  clear() {
    for (const rec of this.records.values()) this._destroy(rec);
    this.records.clear();
    this.rendered = 0;
    _renderCount = 0;
  }

  /** Tears the renderer down completely. */
  dispose() {
    this.clear();
    if (this.scene && typeof this.scene.remove === 'function') this.scene.remove(this.root);
  }

  // -------------------------------------------------------------------------
  // Body builders
  // -------------------------------------------------------------------------

  _buildModelBody(rec, e) {
    const model = modelNameOf(e);
    const skin = skinNameOf(e);
    rec.modelKey = model + '|' + skin;
    let inst = null;
    try {
      inst = buildModel(model, skin);
    } catch (err) {
      this._warn('buildModel:' + model, err);
      inst = null;
    }
    if (!inst || !inst.group) return;
    rec.inst = inst;
    rec.body = inst.group;
    rec.body.frustumCulled = false;
    rec.group.add(rec.body);
    // The animation proxy: same entity, mirrored angles (see the header note).
    rec.anim = Object.create(e);
  }

  _buildItemBody(rec, e) {
    const stack = e.stack || null;
    const name = (stack && stack.item) || 'stone';
    rec.itemKey = name + '#' + ((stack && stack.count) | 0);
    const holder = new THREE.Group();
    holder.frustumCulled = false;

    const count = stack ? (stack.count | 0) : 1;
    const copies = count >= 48 ? 4 : count >= 32 ? 3 : count >= 16 ? 2 : 1;
    const tex = iconTexture(name);
    const mat = new THREE.MeshBasicMaterial({
      map: tex, transparent: true, alphaTest: 0.32, side: THREE.DoubleSide, fog: true,
    });
    mat.userData.alwaysTransparent = true;
    rec.mats.push(mat);
    rec.bodyMats.push(mat);
    for (let i = 0; i < copies; i++) {
      const m = new THREE.Mesh(quadGeometry(), mat);
      m.frustumCulled = false;
      m.position.set((i % 2) * 0.055 - 0.02, 0, Math.floor(i / 2) * 0.055 - 0.02);
      m.scale.setScalar(0.5);
      holder.add(m);
    }
    holder.position.y = 0.16;
    rec.body = holder;
    rec.group.add(holder);
  }

  _buildOrbBody(rec, e) {
    const mat = new THREE.SpriteMaterial({
      map: softTexture(),
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      fog: true,
    });
    mat.color.setHex(0xa6f04a);
    rec.mats.push(mat);
    rec.orbMat = mat;
    const s = new THREE.Sprite(mat);
    s.frustumCulled = false;
    s.position.y = 0.22;
    rec.body = s;
    rec.group.add(s);
  }

  _buildBlockBody(rec, e) {
    const id = e.blockId | 0;
    const meta = e.blockMeta | 0;
    rec.blockKey = id + ':' + meta;
    const mat = blockMaterial();
    rec.mats.push(mat);
    rec.blockMat = mat;
    const mesh = new THREE.Mesh(blockCubeGeometry(id > 0 ? id : 1, meta), mat);
    mesh.frustumCulled = false;
    // The cube geometry is centred; a falling block's origin is its corner.
    mesh.position.set(0, (e.height || 0.98) * 0.5, 0);
    mesh.scale.setScalar(e.width || 0.98);
    rec.body = mesh;
    rec.group.add(mesh);
  }

  _buildCrystalBody(rec, e) {
    const holder = new THREE.Group();
    holder.frustumCulled = false;

    const shellMat = new THREE.MeshBasicMaterial({
      vertexColors: true, transparent: true, opacity: 0.55, depthWrite: false, fog: true,
    });
    shellMat.color.setHex(0xe9b7ff);
    const coreMat = new THREE.MeshBasicMaterial({ vertexColors: true, fog: true });
    coreMat.color.setHex(0xfff0b0);
    shellMat.userData.alwaysTransparent = true;
    rec.mats.push(shellMat, coreMat);
    rec.shellMat = shellMat;
    rec.coreMat = coreMat;

    const shell = new THREE.Mesh(shadedBox(1.35, 1.35, 1.35), shellMat);
    shell.frustumCulled = false;
    shell.name = 'shell';
    const core = new THREE.Mesh(shadedBox(0.55, 0.55, 0.55), coreMat);
    core.frustumCulled = false;
    core.name = 'core';
    holder.add(shell, core);

    if (e.showBase !== false) {
      const baseId = blockIdFromName('bedrock');
      const baseMat = blockMaterial();
      rec.mats.push(baseMat);
      rec.crystalBaseMat = baseMat;
      const base = new THREE.Mesh(blockCubeGeometry(baseId > 0 ? baseId : 1, 0), baseMat);
      base.frustumCulled = false;
      base.scale.set(1.5, 0.4, 1.5);
      base.position.y = -1.0;
      base.name = 'base';
      holder.add(base);
    }
    holder.position.y = 1.1;
    rec.body = holder;
    rec.group.add(holder);
  }

  _buildProjectileBody(rec, e) {
    const name = e.renderItem || e.itemName || 'arrow';
    rec.itemKey = name;
    const q = itemQuad(name);
    q.material.userData.alwaysTransparent = true;
    rec.mats.push(q.material);
    q.scale.setScalar(e.renderScale || 0.6);
    rec.body = q;
    rec.group.add(q);
    rec.arrowLike = /arrow|trident/.test(String(name));
  }

  _buildFrameBody(rec, e) {
    const holder = new THREE.Group();
    holder.frustumCulled = false;
    const woodId = blockIdFromName('oak_planks');
    const mat = blockMaterial();
    rec.mats.push(mat);
    rec.bodyMats.push(mat);
    const frame = new THREE.Mesh(blockCubeGeometry(woodId > 0 ? woodId : 1, 0), mat);
    frame.frustumCulled = false;
    frame.scale.set(1, 1, 0.08);
    holder.add(frame);
    if (e.stack && e.stack.item) {
      const q = itemQuad(e.stack.item);
      q.material.userData.alwaysTransparent = true;
      rec.mats.push(q.material);
      rec.bodyMats.push(q.material);
      q.scale.setScalar(0.62);
      q.position.z = -0.07;
      q.name = 'frameitem';
      holder.add(q);
    }
    holder.position.y = 0.25;
    rec.body = holder;
    rec.group.add(holder);
  }

  _buildPaintingBody(rec, e) {
    const w = e.artWidth || 1, h = e.artHeight || 1;
    const woodId = blockIdFromName('oak_planks');
    const mat = blockMaterial();
    rec.mats.push(mat);
    rec.bodyMats.push(mat);
    const mesh = new THREE.Mesh(blockCubeGeometry(woodId > 0 ? woodId : 1, 0), mat);
    mesh.frustumCulled = false;
    mesh.scale.set(w, h, 0.07);
    rec.body = mesh;
    rec.group.add(mesh);
  }

  _buildKnotBody(rec, e) {
    const mat = new THREE.MeshBasicMaterial({ vertexColors: true, fog: true });
    mat.color.setHex(0x6b5030);
    mat.userData.base = new THREE.Color(0x6b5030);
    rec.mats.push(mat);
    rec.bodyMats.push(mat);
    const mesh = new THREE.Mesh(shadedBox(0.24, 0.24, 0.24), mat);
    mesh.frustumCulled = false;
    mesh.position.y = 0.25;
    rec.body = mesh;
    rec.group.add(mesh);
  }

  // -------------------------------------------------------------------------
  // Per-frame sync
  // -------------------------------------------------------------------------

  _sync(rec, e, world, dt, partial, cam, shadowsOn, fancy, distance) {
    // --- interpolation -----------------------------------------------------
    // main.js drives update() every frame, which snapshots px/py/pz at the top
    // of the frame; those entities are already at their final position, so the
    // blend factor is 1. An entity the world only ticked still holds a
    // previous-tick snapshot, and there the tick partial is exactly right.
    const a = e._updatedSinceTick ? 1 : partial;
    const px = e.px !== undefined ? e.px : e.x;
    const py = e.py !== undefined ? e.py : e.y;
    const pz = e.pz !== undefined ? e.pz : e.z;
    const x = px + (e.x - px) * a;
    const y = py + (e.y - py) * a;
    const z = pz + (e.z - pz) * a;
    rec.rx = x; rec.ry = y; rec.rz = z;
    rec.group.position.set(x, y, z);

    const prevYaw = e.prevYaw !== undefined ? e.prevYaw : (e.yaw || 0);
    const yaw = (e.yaw || 0);
    const iYaw = prevYaw + angleDiff(prevYaw, yaw) * a;
    // Only living entities and vehicles actually maintain bodyYaw/headYaw;
    // everything else leaves them at their constructor zero, which would pin
    // the model facing south.
    const tracksBody = e.living === true || e.isMob === true || e.isPlayer === true
      || e.isVehicle === true;
    const bodyYaw = tracksBody && typeof e.bodyYaw === 'number' ? e.bodyYaw : iYaw;
    const headYaw = tracksBody && typeof e.headYaw === 'number' ? e.headYaw : bodyYaw;
    const prevPitch = e.prevPitch !== undefined ? e.prevPitch : (e.pitch || 0);
    const iPitch = prevPitch + (((e.pitch || 0) - prevPitch) * a);

    // --- light and damage tint --------------------------------------------
    const light = this._lightAt(world, x, y + (e.height || 1) * 0.5, z);
    const hurt = clamp((e.hurtTime || 0) / Math.max(1, e.maxHurtTime || 10), 0, 1);
    const dying = clamp((e.deathTime || 0) / 20, 0, 1);
    const invisible = this._isInvisible(e);
    let alpha = 1 - dying * 0.85;
    if (invisible) alpha = e.isPlayer ? 0.14 : 0;

    switch (rec.kind) {
      case 'model':
        this._syncModel(rec, e, iYaw, bodyYaw, headYaw, iPitch, partial, light, hurt, alpha, invisible);
        break;
      case 'item':
        this._syncItem(rec, e, partial, light, hurt, alpha);
        break;
      case 'orb':
        this._syncOrb(rec, e, partial, light);
        break;
      case 'block':
        this._syncBlock(rec, e, iYaw, light, hurt, alpha);
        break;
      case 'crystal':
        this._syncCrystal(rec, e, partial, light);
        break;
      case 'projectile':
        this._syncProjectile(rec, e, cam, light, alpha);
        break;
      case 'frame':
      case 'painting':
      case 'knot':
        if (rec.body) rec.body.rotation.set(0, PI - (e.yaw || 0), 0);
        this._tintOwned(rec, light, hurt, alpha);
        break;
      default:
        break;
    }

    // --- shared extras -----------------------------------------------------
    this._syncFire(rec, e, cam, fancy);
    this._syncGlow(rec, e, light);
    this._syncNameTag(rec, e, cam, distance);
    this._syncShadow(rec, e, world, x, y, z, shadowsOn && distance < SHADOW_DISTANCE, light);
    this._syncLeash(rec, e, x, y, z, partial);
    this._syncHitbox(rec, e);
  }

  /** Block light at a position, mapped to a 0..1 brightness multiplier. */
  _lightAt(world, x, y, z) {
    let l = 15;
    try {
      if (typeof world.getLight === 'function') {
        l = world.getLight(Math.floor(x), Math.floor(clamp(y, 0, WORLD_HEIGHT - 1)), Math.floor(z));
      }
    } catch (err) {
      l = 15;
    }
    const n = clamp((Number(l) || 0) / 15, 0, 1);
    const bright = clamp(Number(setting('brightness', 0.5)) || 0.5, 0, 1);
    // Never fully black: vanilla keeps a floor so mobs stay readable in caves.
    return clamp(0.16 + 0.1 * bright + 0.78 * Math.pow(n, 1.25), 0.1, 1);
  }

  _isInvisible(e) {
    try {
      if (e.invisible) return true;
      if (typeof e.hasEffect === 'function') return e.hasEffect('invisibility');
    } catch (err) { /* not every entity carries effects */ }
    return false;
  }

  // --- box models ----------------------------------------------------------

  _syncModel(rec, e, iYaw, bodyYaw, headYaw, pitch, partial, light, hurt, alpha, invisible) {
    // A mob can change model or skin at runtime (a sheep is sheared, a wolf
    // gets angry); rebuild only when the pair actually changes.
    const key = modelNameOf(e) + '|' + skinNameOf(e);
    if (key !== rec.modelKey) {
      this._clearAttachments(rec);
      this._clearGlow(rec);
      if (rec.inst) disposeModel(rec.inst);
      rec.inst = null; rec.body = null; rec.equipSig = '';
      this._buildModelBody(rec, e);
    }
    const inst = rec.inst;
    if (!inst || !rec.body) return;

    rec.body.rotation.set(0, PI - bodyYaw, 0);
    const s = (e.sizeScale && e.sizeScale > 0) ? e.sizeScale : 1;
    rec.body.scale.setScalar(s);

    // Mirror the angles into three's handedness for the model animator.
    const anim = rec.anim || (rec.anim = Object.create(e));
    anim.yaw = -iYaw;
    anim.bodyYaw = -bodyYaw;
    anim.headYaw = -headYaw;
    anim.pitch = -pitch;
    anim.headPitch = -(e.headPitch !== undefined && e.headPitch !== null ? e.headPitch : pitch);

    try {
      animateModel(inst, anim, partial);
    } catch (err) {
      this._warn('animateModel:' + rec.modelKey, err);
    }

    // Equipment. Rebuilt only when a slot actually changes.
    if (isHumanoidInstance(inst)) {
      const sig = equipSignature(e);
      if (sig !== rec.equipSig) {
        rec.equipSig = sig;
        this._clearAttachments(rec);
        this._buildEquipment(rec, e, inst);
      }
    } else if (rec.attach.length) {
      this._clearAttachments(rec);
      rec.equipSig = '';
    }

    // Invisibility hides the body but leaves the armour and hand items on.
    this._tintMaterials(inst.materials, light, hurt, alpha);
    this._tintAttachments(rec, light, hurt, invisible ? 1 : alpha);
  }

  _buildEquipment(rec, e, inst) {
    const p = inst.parts;
    const sink = rec.attach;
    const head = equipOf(e, 'head');
    const chest = equipOf(e, 'chest');
    const legs = equipOf(e, 'legs');
    const feet = equipOf(e, 'feet');

    try {
      // A cap rather than a full box, so the mob's face still reads through it.
      if (head && p.head) cladPart(p.head, 0.46, 1, 0.06, armorColor(head), sink);
      if (chest) {
        if (p.body) cladPart(p.body, 0.34, 1, 0.05, armorColor(chest), sink);
        if (p.right_arm) cladPart(p.right_arm, 0.5, 1, 0.05, armorColor(chest), sink);
        if (p.left_arm) cladPart(p.left_arm, 0.5, 1, 0.05, armorColor(chest), sink);
      }
      if (legs) {
        if (p.body) cladPart(p.body, 0, 0.34, 0.038, armorColor(legs), sink);
        if (p.right_leg) cladPart(p.right_leg, 0.42, 1, 0.038, armorColor(legs), sink);
        if (p.left_leg) cladPart(p.left_leg, 0.42, 1, 0.038, armorColor(legs), sink);
      }
      if (feet) {
        if (p.right_leg) cladPart(p.right_leg, 0, 0.32, 0.055, armorColor(feet), sink);
        if (p.left_leg) cladPart(p.left_leg, 0, 0.32, 0.055, armorColor(feet), sink);
      }
    } catch (err) {
      this._warn('armour', err);
    }

    try {
      const main = equipOf(e, 'mainhand');
      const off = equipOf(e, 'offhand');
      if (main && p.right_arm) attachHandItem(p.right_arm, main, false, sink);
      if (off && p.left_arm) attachHandItem(p.left_arm, off, true, sink);
    } catch (err) {
      this._warn('helditem', err);
    }
  }

  _clearAttachments(rec) {
    for (let i = 0; i < rec.attach.length; i++) {
      const a = rec.attach[i];
      if (!a) continue;
      if (a.parent && a.mesh) a.parent.remove(a.mesh);
      if (a.mat && typeof a.mat.dispose === 'function') a.mat.dispose();
    }
    rec.attach.length = 0;
  }

  _tintAttachments(rec, light, hurt, alpha) {
    for (let i = 0; i < rec.attach.length; i++) {
      const a = rec.attach[i];
      if (!a || !a.mat) continue;
      if (a.mat.userData.atlas) ensureAtlasMap(a.mat);
      let r = light, g = light, b = light;
      if (hurt > 0) {
        r = Math.min(1, light + 0.5 * hurt);
        g = light * (1 - 0.6 * hurt);
        b = light * (1 - 0.6 * hurt);
      }
      a.mat.color.setRGB(a.base.r * r, a.base.g * g, a.base.b * b);
      this._applyAlpha(a.mat, alpha);
    }
  }

  /** Applies light + hurt flash + death fade to a list of materials. */
  _tintMaterials(mats, light, hurt, alpha) {
    if (!mats) return;
    let r = light, g = light, b = light;
    if (hurt > 0) {
      r = Math.min(1, light + 0.5 * hurt);
      g = light * (1 - 0.6 * hurt);
      b = light * (1 - 0.6 * hurt);
    }
    for (let i = 0; i < mats.length; i++) {
      const m = mats[i];
      if (!m || !m.color) continue;
      if (m.userData.atlas) ensureAtlasMap(m);
      const base = m.userData.base;
      if (base) m.color.setRGB(base.r * r, base.g * g, base.b * b);
      else m.color.setRGB(r, g, b);
      this._applyAlpha(m, alpha);
    }
  }

  _applyAlpha(m, alpha) {
    if (alpha < 0.999) {
      if (!m.transparent) m.transparent = true;
      m.opacity = Math.max(0, alpha);
      m.depthWrite = alpha > 0.6;
    } else if (m.transparent && m.userData.alwaysTransparent !== true) {
      m.transparent = false;
      m.opacity = 1;
      m.depthWrite = true;
    }
  }

  /** Tint helper for the record's own (non-model) body materials. */
  _tintOwned(rec, light, hurt, alpha) {
    this._tintMaterials(rec.bodyMats, light, hurt, alpha);
  }

  // --- dropped items -------------------------------------------------------

  _syncItem(rec, e, partial, light, hurt, alpha) {
    const stack = e.stack || null;
    const key = ((stack && stack.item) || 'air') + '#' + ((stack && stack.count) | 0);
    if (key !== rec.itemKey) {
      // The stack changed under us (a merge, or a pickup partial). Rebuild the
      // billboard but leave the shadow/fire/glow materials alone.
      if (rec.body) rec.group.remove(rec.body);
      this._disposeBodyMats(rec);
      this._buildItemBody(rec, e);
    }
    if (!rec.body) return;
    const spin = e.spinAngle !== undefined ? e.spinAngle : (e.age || 0) * 0.06;
    const bob = e.bobOffset !== undefined ? e.bobOffset : Math.sin((e.age || 0) * 0.12) * 0.06;
    rec.body.rotation.y = spin;
    rec.body.position.y = 0.16 + bob;
    rec.body.scale.setScalar(e.renderScale || 1);
    this._tintMaterials(rec.bodyMats, light, hurt, alpha);
  }

  // --- XP orbs -------------------------------------------------------------

  _syncOrb(rec, e, partial, light) {
    if (!rec.body) return;
    const t = (e.age || 0) + partial;
    const pulse = 0.85 + Math.sin(t * 0.35 + (e.hoverStart || 0)) * 0.15;
    const s = (e.renderScale || 0.6) * 0.85 * pulse;
    rec.body.scale.set(s, s, 1);
    rec.body.position.y = 0.22 + (e.bobOffset || 0);
    const m = rec.orbMat;
    if (m && m.color) {
      // Orbs glow on their own, so light only dims them a little.
      const k = 0.55 + 0.45 * light;
      m.color.setRGB(0.65 * k, 0.94 * k, 0.29 * k);
      m.opacity = 0.75 + 0.25 * pulse;
    }
  }

  // --- falling blocks, TNT -------------------------------------------------

  _syncBlock(rec, e, yaw, light, hurt, alpha) {
    const key = (e.blockId | 0) + ':' + (e.blockMeta | 0);
    if (key !== rec.blockKey && rec.body) {
      rec.blockKey = key;
      rec.body.geometry = blockCubeGeometry((e.blockId | 0) > 0 ? (e.blockId | 0) : 1, e.blockMeta | 0);
    }
    if (!rec.body) return;
    rec.body.position.set(0, (e.height || 0.98) * 0.5, 0);
    rec.body.scale.setScalar(e.width || 0.98);

    // Primed TNT flashes white on a two-tick cadence as the fuse runs out.
    let flash = 0;
    if (e.type === 'tnt' || e.fuse !== undefined) {
      const fuse = e.fuse !== undefined ? e.fuse : e.fuseTicks;
      if (fuse !== undefined && fuse >= 0 && (Math.floor(fuse / 2) & 1) === 0) flash = 0.85;
    }
    const m = rec.blockMat;
    if (m && m.color) {
      ensureAtlasMap(m);
      let r = light, g = light, b = light;
      if (hurt > 0) { r = Math.min(1, light + 0.5 * hurt); g = light * 0.4; b = light * 0.4; }
      if (flash > 0) { r = r + (1 - r) * flash; g = g + (1 - g) * flash; b = b + (1 - b) * flash; }
      m.color.setRGB(r, g, b);
      this._applyAlpha(m, alpha);
    }
  }

  // --- end crystals --------------------------------------------------------

  _syncCrystal(rec, e, partial, light) {
    if (!rec.body) return;
    const t = (e.age || 0) + partial;
    const spin = e.spinAngle !== undefined ? e.spinAngle : t * 0.05;
    const bob = e.bobOffset !== undefined ? e.bobOffset : Math.sin(t * 0.06) * 0.2;
    rec.body.position.y = 1.1 + bob;
    for (let i = 0; i < rec.body.children.length; i++) {
      const c = rec.body.children[i];
      if (c.name === 'shell') {
        c.rotation.y = spin;
        c.rotation.x = 0.35;
        c.rotation.z = 0.35;
      } else if (c.name === 'core') {
        c.rotation.y = -spin * 1.7;
        c.rotation.x = -spin * 0.8;
        const s = 1 + Math.sin(t * 0.12) * 0.08;
        c.scale.setScalar(s);
      }
    }
    const k = 0.55 + 0.45 * light;
    if (rec.shellMat) rec.shellMat.color.setRGB(0.91 * k, 0.72 * k, 1.0 * k);
    if (rec.coreMat) rec.coreMat.color.setRGB(1.0, 0.94 * k, 0.69 * k);
    if (rec.crystalBaseMat) {
      ensureAtlasMap(rec.crystalBaseMat);
      rec.crystalBaseMat.color.setRGB(light, light, light);
    }
  }

  // --- projectiles ---------------------------------------------------------

  _syncProjectile(rec, e, cam, light, alpha) {
    const name = e.renderItem || e.itemName || 'arrow';
    if (name !== rec.itemKey && rec.body) {
      rec.itemKey = name;
      const t = iconTexture(name);
      rec.body.material.map = t;
      rec.body.material.needsUpdate = true;
      rec.arrowLike = /arrow|trident/.test(String(name));
    }
    if (!rec.body) return;
    rec.body.scale.setScalar(e.renderScale || 0.6);
    rec.group.position.y += (e.height || 0.25) * 0.5;

    if (cam) {
      rec.body.quaternion.copy(cam.quaternion);
      // An arrow in flight should point where it is going: roll the billboard
      // so the icon's long axis lines up with the velocity on screen.
      if (rec.arrowLike && !e.inGround && !e.stuck) {
        _tmpV.set(e.vx || 0, e.vy || 0, e.vz || 0);
        if (_tmpV.lengthSq() > 0.05) {
          _tmpV.applyQuaternion(_tmpQ);
          rec.body.rotateZ(Math.atan2(_tmpV.y, _tmpV.x) + PI / 4);
        }
      }
    }
    const m = rec.body.material;
    if (m && m.color) {
      const k = e.spectral ? 1 : light;
      m.color.setRGB(k, k, k);
      this._applyAlpha(m, alpha);
    }
  }

  // --- fire ----------------------------------------------------------------

  _syncFire(rec, e, cam, fancy) {
    const burning = (e.fireTicks | 0) > 0 && !e.fireImmune;
    if (!burning) {
      if (rec.fire) rec.fire.visible = false;
      return;
    }
    if (!rec.fire) {
      const tex = fireTexture();
      if (!tex) return;
      const mat = new THREE.MeshBasicMaterial({
        map: tex,
        transparent: true,
        alphaTest: 0.06,
        depthWrite: false,
        side: THREE.DoubleSide,
        fog: true,
      });
      mat.userData.alwaysTransparent = true;
      rec.mats.push(mat);
      rec.fireMat = mat;
      const g = new THREE.Group();
      g.frustumCulled = false;
      // Two crossed quads, exactly like vanilla's entity fire.
      for (let i = 0; i < 2; i++) {
        const q = new THREE.Mesh(quadGeometry(), mat);
        q.frustumCulled = false;
        q.rotation.y = i * (PI / 2);
        g.add(q);
      }
      rec.fire = g;
      rec.group.add(g);
    }
    rec.fire.visible = true;
    const w = Math.max(0.75, (e.width || 0.6) * 1.55);
    const h = Math.max(1.0, (e.height || 1.8) * 1.12 + 0.25);
    rec.fire.scale.set(w, h, w);
    rec.fire.position.set(0, h * 0.5 - 0.08, 0);
    // Face the crossed quads roughly at the viewer so neither reads edge-on.
    if (cam) {
      _tmpV2.set(cam.position.x - rec.rx, 0, cam.position.z - rec.rz);
      if (_tmpV2.lengthSq() > 1e-4) rec.fire.rotation.y = Math.atan2(_tmpV2.x, _tmpV2.z) + PI / 4;
    }
    const mat = rec.fireMat;
    if (mat && mat.map) {
      mat.map.offset.y = 1 - (this._fireFrame + 1) / FIRE_FRAMES;
      mat.opacity = fancy ? 0.94 : 0.8;
    }
  }

  // --- glow ----------------------------------------------------------------

  _syncGlow(rec, e, light) {
    let color = 0;
    try {
      if (e.spectral) color = GLOW_COLORS.spectral;
      else if (e.glowing) color = GLOW_COLORS.glowing;
      else if (typeof e.hasEffect === 'function' && e.hasEffect('glowing')) color = GLOW_COLORS.glowing;
    } catch (err) { color = 0; }

    const key = color ? String(color) : '';
    if (key === rec.glowKey) {
      if (rec.glow && rec.glow.sprite) {
        // Keep the fallback aura sized and gently pulsing.
        const s = Math.max(e.width || 0.5, e.height || 0.5) * 1.4 + 0.3;
        rec.glow.sprite.scale.set(s, s, 1);
        rec.glow.sprite.position.y = (e.height || 0.5) * 0.5;
        rec.glow.mat.opacity = 0.28 + 0.1 * Math.sin((e.age || 0) * 0.2);
      }
      return;
    }
    this._clearGlow(rec);
    rec.glowKey = key;
    if (!color) return;

    // A back-facing shell parented to each model part follows the animation
    // for free; entities without a box model get a soft additive aura.
    if (rec.inst && rec.inst.group) {
      // An additive back-facing shell over every part. Depth testing is off so
      // a glowing mob shows through walls the way vanilla's outline does, and
      // the slight inflation gives thin limbs a halo they would not get from a
      // silhouette alone.
      const mat = new THREE.MeshBasicMaterial({
        side: THREE.BackSide,
        transparent: true,
        opacity: 0.3,
        depthWrite: false,
        depthTest: false,
        blending: THREE.AdditiveBlending,
        fog: false,
      });
      mat.color.setHex(color);
      const shells = [];
      rec.inst.group.traverse((o) => {
        if (!o.isMesh || o.userData.glowShell) return;
        shells.push(o);
      });
      for (let i = 0; i < shells.length; i++) {
        const src = shells[i];
        const m = new THREE.Mesh(src.geometry, mat);
        m.userData.glowShell = true;
        m.frustumCulled = false;
        m.scale.setScalar(1.1);
        m.renderOrder = 800;
        src.add(m);
      }
      rec.glow = { mat, shells };
      rec.mats.push(mat);
    } else if (rec.body) {
      const mat = new THREE.SpriteMaterial({
        map: softTexture(),
        transparent: true,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
        opacity: 0.3,
        fog: false,
      });
      mat.color.setHex(color);
      const sprite = new THREE.Sprite(mat);
      sprite.frustumCulled = false;
      rec.group.add(sprite);
      rec.glow = { mat, sprite };
      rec.mats.push(mat);
    }
  }

  _clearGlow(rec) {
    const g = rec.glow;
    if (!g) { rec.glowKey = ''; return; }
    if (g.shells) {
      for (let i = 0; i < g.shells.length; i++) {
        const src = g.shells[i];
        for (let k = src.children.length - 1; k >= 0; k--) {
          if (src.children[k].userData.glowShell) src.remove(src.children[k]);
        }
      }
    }
    if (g.sprite) rec.group.remove(g.sprite);
    if (g.mat) {
      const i = rec.mats.indexOf(g.mat);
      if (i >= 0) rec.mats.splice(i, 1);
      g.mat.dispose();
    }
    rec.glow = null;
    rec.glowKey = '';
  }

  // --- name tags -----------------------------------------------------------

  _nameFor(e) {
    if (e.customName) return String(e.customName);
    if (e.nameTag) return String(e.nameTag);
    if (e.isPlayer || e === Game.player) {
      const n = Game.playerName;
      return typeof n === 'string' && n ? n : 'Player';
    }
    return null;
  }

  _syncNameTag(rec, e, cam, distance) {
    let text = null;
    // Bosses get a boss bar instead; a nameless mob gets nothing.
    if (!(e.def && e.def.boss)) text = this._nameFor(e);
    if (text && distance > 48) text = null;

    if (!text) {
      if (rec.tag) rec.tag.visible = false;
      return;
    }
    if (text !== rec.tagText) {
      if (rec.tag) {
        rec.group.remove(rec.tag);
        if (rec.tag.material) rec.tag.material.dispose();
        rec.tag = null;
      }
      rec.tagText = text;
      const entry = nameTagTexture(text);
      if (!entry) return;
      const mat = new THREE.SpriteMaterial({
        map: entry.texture,
        transparent: true,
        depthTest: false,
        depthWrite: false,
        fog: false,
      });
      const sprite = new THREE.Sprite(mat);
      sprite.frustumCulled = false;
      sprite.renderOrder = 900;
      sprite.userData.aspect = entry.aspect;
      rec.group.add(sprite);
      rec.tag = sprite;
    }
    if (!rec.tag) return;
    rec.tag.visible = true;
    // Grow a little with distance so a far-off label stays legible.
    const h = 0.28 * (1 + clamp(distance, 0, 48) * 0.035);
    rec.tag.scale.set(h * (rec.tag.userData.aspect || 3), h, 1);
    rec.tag.position.set(0, (e.height || 1.8) + 0.55, 0);
    if (rec.tag.material) rec.tag.material.opacity = clamp(1.1 - distance / 60, 0.25, 1);
  }

  // --- blob shadow ---------------------------------------------------------

  _syncShadow(rec, e, world, x, y, z, enabled, light) {
    if (!enabled || !rec.body || e.noShadow || rec.kind === 'painting' || rec.kind === 'frame') {
      if (rec.shadow) rec.shadow.visible = false;
      return;
    }
    // The downward scan is the one genuinely expensive thing per entity, so
    // cache it and only redo it when the entity has actually moved.
    let gy = rec.groundY;
    if (gy === undefined || this.frame - rec.groundFrame > 6
      || Math.abs(x - rec.groundX) > 0.4 || Math.abs(z - rec.groundZ) > 0.4
      || Math.abs(y - rec.groundEyeY) > 1) {
      gy = groundYUnder(world, x, y, z);
      rec.groundY = gy;
      rec.groundX = x; rec.groundZ = z; rec.groundEyeY = y;
      rec.groundFrame = this.frame;
    }
    if (gy === null) {
      if (rec.shadow) rec.shadow.visible = false;
      return;
    }
    if (!rec.shadow) {
      const mat = new THREE.MeshBasicMaterial({
        map: softTexture(),
        transparent: true,
        depthWrite: false,
        color: 0x000000,
        opacity: 0.4,
        fog: true,
      });
      mat.userData.alwaysTransparent = true;
      rec.mats.push(mat);
      const mesh = new THREE.Mesh(groundQuadGeometry(), mat);
      mesh.frustumCulled = false;
      mesh.renderOrder = 2;
      rec.shadow = mesh;
      rec.shadowMat = mat;
      rec.group.add(mesh);
    }
    rec.shadow.visible = true;
    const size = clamp(Math.max(e.width || 0.6, 0.35) * 2.1, 0.4, 8);
    rec.shadow.scale.set(size, 1, size);
    // The shadow lives in world space; cancel the group's own Y offset.
    rec.shadow.position.set(0, (gy + 0.015) - y, 0);
    const height = clamp(y - gy, 0, 3);
    if (rec.shadowMat) rec.shadowMat.opacity = clamp(0.48 * (1 - height / 3) * (0.4 + 0.6 * light), 0, 0.5);
  }

  // --- leash ---------------------------------------------------------------

  _syncLeash(rec, e, x, y, z, partial) {
    const holder = e.leashedTo || e.leashHolder || null;
    if (!holder || holder.removed) {
      if (rec.leash) rec.leash.visible = false;
      return;
    }
    if (!rec.leash) {
      const pts = new Float32Array((LEASH_SEGMENTS + 1) * 3);
      const geo = new THREE.BufferGeometry();
      geo.setAttribute('position', new THREE.BufferAttribute(pts, 3));
      const mat = new THREE.LineBasicMaterial({ color: 0x5c4632, fog: true });
      const line = new THREE.Line(geo, mat);
      line.frustumCulled = false;
      rec.leash = line;
      rec.leashPos = pts;
      this.root.add(line);
    }
    rec.leash.visible = true;
    const ax = x, ay = y + (e.height || 1) * 0.82, az = z;
    const bx = holder.x, by = holder.y + (holder.height || 1) * 0.55, bz = holder.z;
    const dist = Math.hypot(bx - ax, by - ay, bz - az);
    const sag = Math.min(1.1, dist * 0.16);
    const pos = rec.leashPos;
    for (let i = 0; i <= LEASH_SEGMENTS; i++) {
      const t = i / LEASH_SEGMENTS;
      const k = i * 3;
      pos[k] = ax + (bx - ax) * t;
      pos[k + 1] = ay + (by - ay) * t - Math.sin(t * PI) * sag;
      pos[k + 2] = az + (bz - az) * t;
    }
    rec.leash.geometry.attributes.position.needsUpdate = true;
    rec.leash.geometry.computeBoundingSphere();
  }

  // --- hitbox overlay ------------------------------------------------------

  _syncHitbox(rec, e) {
    if (!_hitboxDebug) {
      if (rec.hitbox) rec.hitbox.visible = false;
      return;
    }
    if (!rec.hitbox) {
      const mat = new THREE.LineBasicMaterial({ color: 0xffffff, depthTest: false, fog: false });
      rec.mats.push(mat);
      const box = new THREE.LineSegments(edgesGeometry(), mat);
      box.frustumCulled = false;
      box.renderOrder = 950;
      rec.hitbox = box;
      rec.hitboxMat = mat;
      rec.group.add(box);
    }
    rec.hitbox.visible = true;
    const w = Math.max(0.05, e.width || 0.6);
    const h = Math.max(0.05, e.height || 1.8);
    rec.hitbox.scale.set(w, h, w);
    rec.hitbox.position.set(0, h * 0.5, 0);
    if (rec.hitboxMat) {
      // Red while hurt, yellow for whatever is targeting the player, else white.
      if ((e.hurtTime | 0) > 0) rec.hitboxMat.color.setHex(0xff4040);
      else if (e.target && e.target === Game.player) rec.hitboxMat.color.setHex(0xffd24a);
      else rec.hitboxMat.color.setHex(0xffffff);
    }
  }
}

const LEASH_SEGMENTS = 14;
/** Blob shadows stop being worth their downward block scan past this range. */
const SHADOW_DISTANCE = 40;

/**
 * Highest solid surface directly under a point, searching at most 24 blocks.
 * @returns {number|null} the Y a shadow should sit on, or null when unsupported
 */
function groundYUnder(world, x, y, z) {
  if (!world || typeof world.isSolid !== 'function') return null;
  const fx = Math.floor(x), fz = Math.floor(z);
  let yy = Math.floor(y + 0.02);
  if (yy >= WORLD_HEIGHT) yy = WORLD_HEIGHT - 1;
  const min = Math.max(0, yy - 24);
  try {
    for (; yy >= min; yy--) {
      if (world.isSolid(fx, yy, fz)) return yy + 1;
    }
  } catch (err) {
    return null;
  }
  return null;
}

export default EntityRenderer;
