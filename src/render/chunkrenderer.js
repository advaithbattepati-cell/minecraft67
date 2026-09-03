// ============================================================================
// chunkrenderer.js - three.js chunk mesh lifecycle.
//
// Owns exactly three materials (one per render pass), a Map of live chunk
// meshes, the dirty-chunk meshing budget, per-chunk frustum/distance culling,
// the animated-texture uniform, and the two cursor overlays (block selection
// outline + block breaking cracks).
//
// Design notes
//  - The mesher emits WORLD-space positions, so every chunk mesh sits at the
//    scene origin and we do our own culling with a cached bounding box.
//  - Geometry is never mutated in place: three tracks GL buffers per
//    BufferAttribute, so swapping attributes on a live geometry leaks. We
//    dispose the whole geometry and build a new one instead.
//  - Animated tiles (water, lava, fire, portals) live in their own atlas tiles.
//    The fragment shader turns the interpolated UV back into a tile index and,
//    for the handful of animated base tiles, adds the current frame's tile
//    offset. Nothing has to be re-meshed for water to flow.
// ============================================================================
import * as THREE from 'three';

import { Game } from '../core/game.js';
import {
  DEFAULT_RENDER_DISTANCE, MIN_RENDER_DISTANCE, MAX_RENDER_DISTANCE,
  CHUNK_X, CHUNK_Z, WORLD_HEIGHT,
} from '../core/constants.js';
import { chunkKey, clamp } from '../core/util.js';
import { RNG } from '../core/rng.js';
import { Atlas, ANIMATED, buildAtlas } from './atlas.js';
import { meshChunk, selectionBoxes } from './mesher.js';

const PASSES = ['opaque', 'cutout', 'translucent'];

// Live chunk meshes across every ChunkRenderer instance (the F3 overlay and
// the automated tests both want this number).
let _liveMeshes = 0;
let _warnedShader = false;

/** How many chunk meshes are currently uploaded to the GPU. */
export function chunkMeshCount() { return _liveMeshes; }

// ---------------------------------------------------------------------------
// Atlas access
// ---------------------------------------------------------------------------
/** The atlas texture, building the atlas on demand if boot skipped it. */
function atlasTexture() {
  if (Atlas && Atlas.texture) return Atlas.texture;
  try {
    const a = buildAtlas();
    if (a && a.texture) return a.texture;
  } catch (e) {
    console.error('[chunkrenderer] atlas unavailable', e);
  }
  return null;
}

// ---------------------------------------------------------------------------
// Animated tiles
// ---------------------------------------------------------------------------
/**
 * Flattens render/atlas.js's ANIMATED table into a per-frame lookup:
 * { base: tileIndexOfFrame0, fps, du: Float32Array, dv: Float32Array }.
 */
function collectAnimations() {
  const out = [];
  if (!ANIMATED) return out;
  const cols = (Atlas && Atlas.cols) || 64;
  for (const name of Object.keys(ANIMATED)) {
    const a = ANIMATED[name];
    if (!a || !Array.isArray(a.frames) || a.frames.length < 2) continue;
    const first = a.frames[0] | 0;
    const n = a.frames.length;
    const du = new Float32Array(n);
    const dv = new Float32Array(n);
    for (let f = 0; f < n; f++) {
      const t = a.frames[f] | 0;
      du[f] = ((t % cols) - (first % cols)) / cols;
      dv[f] = (((t / cols) | 0) - ((first / cols) | 0)) / cols;
    }
    out.push({ name, base: first, fps: a.fps > 0 ? a.fps : 8, frames: n, du, dv });
  }
  // Deterministic order keeps the generated GLSL (and its program cache key)
  // stable between runs.
  out.sort((p, q) => p.base - q.base);
  return out;
}

/**
 * Replacement for three's <map_fragment> that shifts animated tiles. Returns
 * null when the atlas registered no animations at all.
 */
function animatedMapChunk(anims, cols) {
  if (!anims.length) return null;
  let lo = anims[0].base, hi = anims[0].base;
  let chain = '';
  for (let i = 0; i < anims.length; i++) {
    const b = anims[i].base;
    if (b < lo) lo = b;
    if (b > hi) hi = b;
    chain += `      ${i ? 'else ' : ''}if ( mcTile == ${b.toFixed(1)} ) mcUv += uAnimOffset[ ${i} ];\n`;
  }
  const C = cols.toFixed(1);
  return `#ifdef USE_MAP
    vec2 mcUv = vMapUv;
    float mcTile = floor( mcUv.y * ${C} ) * ${C} + floor( mcUv.x * ${C} );
    if ( mcTile >= ${lo.toFixed(1)} && mcTile <= ${hi.toFixed(1)} ) {
${chain}    }
    vec4 sampledDiffuseColor = texture2D( map, mcUv );
    diffuseColor *= sampledDiffuseColor;
  #endif`;
}

// ---------------------------------------------------------------------------
// Break-overlay textures: ten procedurally cracked 16x16 tiles.
// ---------------------------------------------------------------------------
const CRACK_STAGES = 10;
let _crackTextures = null;

function makeCanvas(w, h) {
  if (typeof document !== 'undefined' && document.createElement) {
    const c = document.createElement('canvas');
    c.width = w; c.height = h;
    return c;
  }
  if (typeof OffscreenCanvas !== 'undefined') return new OffscreenCanvas(w, h);
  return null;
}

/**
 * Builds the ten destroy_stage textures. One crack skeleton is generated once
 * and each stage reveals the pixels within a growing radius, so the cracks
 * spread out from the middle of the face exactly like vanilla's.
 */
function crackTextures() {
  if (_crackTextures) return _crackTextures;
  const size = 16;
  const rng = new RNG('destroy_stage');
  const pts = [];
  const cx = size / 2, cy = size / 2;
  const arms = 9;
  for (let i = 0; i < arms; i++) {
    let a = (i / arms) * Math.PI * 2 + rng.float(-0.4, 0.4);
    let x = cx + rng.float(-1.5, 1.5);
    let y = cy + rng.float(-1.5, 1.5);
    const len = rng.range(7, 13);
    for (let s = 0; s < len; s++) {
      a += rng.float(-0.6, 0.6);
      x += Math.cos(a);
      y += Math.sin(a);
      if (x < 0 || y < 0 || x > size - 0.01 || y > size - 0.01) break;
      const px = x | 0, py = y | 0;
      const r = Math.hypot(px + 0.5 - cx, py + 0.5 - cy);
      pts.push(px, py, r, 0.74);
      // Short side chips make the crack read as broken rock, not a scribble.
      if (rng.chance(0.3)) {
        const bx = px + (rng.bool() ? 1 : -1);
        const by = py + (rng.bool() ? 1 : -1);
        if (bx >= 0 && by >= 0 && bx < size && by < size) pts.push(bx, by, r + 0.7, 0.34);
      }
    }
  }
  const maxR = 11.5;
  const out = [];
  for (let s = 0; s < CRACK_STAGES; s++) {
    const canvas = makeCanvas(size, size);
    if (!canvas) break;
    const ctx = canvas.getContext('2d');
    ctx.clearRect(0, 0, size, size);
    const limit = ((s + 1) / CRACK_STAGES) * maxR;
    for (let i = 0; i < pts.length; i += 4) {
      if (pts[i + 2] > limit) continue;
      ctx.fillStyle = 'rgba(0,0,0,' + pts[i + 3] + ')';
      ctx.fillRect(pts[i], pts[i + 1], 1, 1);
    }
    const tex = new THREE.CanvasTexture(canvas);
    tex.magFilter = THREE.NearestFilter;
    tex.minFilter = THREE.NearestFilter;
    tex.generateMipmaps = false;
    tex.wrapS = THREE.ClampToEdgeWrapping;
    tex.wrapT = THREE.ClampToEdgeWrapping;
    tex.needsUpdate = true;
    out.push(tex);
  }
  _crackTextures = out;
  return out;
}

// ---------------------------------------------------------------------------
// Shared unit geometries for the overlays (0..1 block space).
// ---------------------------------------------------------------------------
let _unitBox = null;
function unitBoxGeometry() {
  if (!_unitBox) _unitBox = new THREE.BoxGeometry(1, 1, 1).translate(0.5, 0.5, 0.5);
  return _unitBox;
}

let _unitEdges = null;
function unitEdgeGeometry() {
  if (_unitEdges) return _unitEdges;
  const c = [
    [0, 0, 0], [1, 0, 0], [1, 0, 1], [0, 0, 1],
    [0, 1, 0], [1, 1, 0], [1, 1, 1], [0, 1, 1],
  ];
  const edges = [
    [0, 1], [1, 2], [2, 3], [3, 0],
    [4, 5], [5, 6], [6, 7], [7, 4],
    [0, 4], [1, 5], [2, 6], [3, 7],
  ];
  const pos = new Float32Array(edges.length * 6);
  let p = 0;
  for (const [a, b] of edges) {
    pos[p++] = c[a][0]; pos[p++] = c[a][1]; pos[p++] = c[a][2];
    pos[p++] = c[b][0]; pos[p++] = c[b][1]; pos[p++] = c[b][2];
  }
  _unitEdges = new THREE.BufferGeometry();
  _unitEdges.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  return _unitEdges;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
const _tmpDir = new THREE.Vector3();
const RAY_OPTS = { fluids: false };

function nowMs() {
  return (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now();
}

/** Coerces whatever the caller passed into [x0,y0,z0,x1,y1,z1] tuples. */
function normalizeBoxes(v) {
  if (!v) return null;
  const out = [];
  const push = (b) => {
    if (!b) return;
    if (Array.isArray(b) && b.length >= 6 && typeof b[0] === 'number') {
      out.push([b[0], b[1], b[2], b[3], b[4], b[5]]);
    } else if (typeof b.x0 === 'number') {
      out.push([b.x0, b.y0, b.z0, b.x1, b.y1, b.z1]);
    } else if (typeof b.min === 'object' && typeof b.max === 'object') {
      out.push([b.min.x, b.min.y, b.min.z, b.max.x, b.max.y, b.max.z]);
    } else if (typeof b.x === 'number' && typeof b.y === 'number' && typeof b.z === 'number') {
      // A raycast hit: use the rendered shape of the block it names.
      const id = b.blockId != null ? b.blockId : (Game.world ? Game.world.getBlock(b.x, b.y, b.z) : 0);
      const meta = b.meta != null ? b.meta : (Game.world ? Game.world.getMeta(b.x, b.y, b.z) : 0);
      let boxes = null;
      try { boxes = selectionBoxes(id, meta, Math.floor(b.x), Math.floor(b.y), Math.floor(b.z)); } catch { boxes = null; }
      if (boxes && boxes.length) for (const q of boxes) push(q);
      else out.push([Math.floor(b.x), Math.floor(b.y), Math.floor(b.z),
        Math.floor(b.x) + 1, Math.floor(b.y) + 1, Math.floor(b.z) + 1]);
    }
  };
  if (Array.isArray(v) && v.length && (typeof v[0] === 'object' || Array.isArray(v[0]))) {
    for (const b of v) push(b);
  } else {
    push(v);
  }
  return out.length ? out : null;
}

// ===========================================================================
// ChunkRenderer
// ===========================================================================
export class ChunkRenderer {
  /**
   * @param {THREE.Scene} scene the scene chunk meshes are added to
   */
  constructor(scene) {
    this.scene = scene || null;

    this.group = new THREE.Group();
    this.group.name = 'chunks';
    this.group.matrixAutoUpdate = false;
    if (this.scene) this.scene.add(this.group);

    this.overlay = new THREE.Group();
    this.overlay.name = 'block-cursor';
    this.overlay.matrixAutoUpdate = false;
    if (this.scene) this.scene.add(this.overlay);

    // ---- fog ---------------------------------------------------------
    // sky.js drives colour and distance when it is present; until then we
    // own a sensible default so the horizon is never a hard cut.
    this.fog = new THREE.Fog(0xa8c8f0, 32, 160);
    this._ownsFog = false;
    if (this.scene && !this.scene.fog) {
      this.scene.fog = this.fog;
      this._ownsFog = true;
    }

    // ---- materials ---------------------------------------------------
    this._anims = collectAnimations();
    this._animOffsets = this._anims.map(() => new THREE.Vector2(0, 0));
    this._animFrame = new Int32Array(this._anims.length).fill(-1);
    this._shaders = [];
    this.materials = this._createMaterials();

    // ---- chunk bookkeeping -------------------------------------------
    /** @type {Map<string, {cx:number,cz:number,meshes:object,version:number,box:THREE.Box3,cx0:number,cz0:number}>} */
    this.chunks = new Map();
    this.meshes = this.chunks;          // alias: the contract names the map loosely
    this._world = null;
    this._buckets = [];
    for (let i = 0; i <= MAX_RENDER_DISTANCE + 2; i++) this._buckets.push([]);

    this.renderDistance = DEFAULT_RENDER_DISTANCE;
    try {
      const v = Game.settings && Game.settings.get ? Game.settings.get('renderDistance') : null;
      if (typeof v === 'number' && v > 0) this.setRenderDistance(v);
    } catch { /* settings are optional */ }

    this._frustum = new THREE.Frustum();
    this._projScreen = new THREE.Matrix4();
    this._stats = { rendered: 0, meshed: 0, queued: 0, loaded: 0, meshes: 0, triangles: 0, meshMs: 0 };

    // ---- cursor overlays ---------------------------------------------
    this._selBoxes = null;
    this._breakBoxes = null;
    this._breakStage = -1;
    this._break = { x: 0, y: 0, z: 0 };
    this._autoSelection = true;         // until somebody calls setSelection()
    this._autoBreak = true;             // until somebody calls setBreakProgress()
    this._lines = [];
    this._cracks = [];
    this._lineMaterial = new THREE.LineBasicMaterial({
      color: 0xffffff, transparent: true, opacity: 0.55,
      depthTest: true, depthWrite: false, fog: false,
    });
    this._crackMaterial = new THREE.MeshBasicMaterial({
      map: null, transparent: true, opacity: 1, depthWrite: false, fog: false,
      polygonOffset: true, polygonOffsetFactor: -3, polygonOffsetUnits: -3,
      side: THREE.FrontSide,
    });
    this._disposed = false;
  }

  // -------------------------------------------------------------------
  // Materials
  // -------------------------------------------------------------------
  _createMaterials() {
    const map = atlasTexture();
    const cols = (Atlas && Atlas.cols) || 64;
    const animChunk = animatedMapChunk(this._anims, cols);
    const offsets = this._animOffsets;
    const shaders = this._shaders;

    const hook = (mat) => {
      if (!animChunk) return mat;
      mat.onBeforeCompile = (shader) => {
        shader.uniforms.uAnimOffset = { value: offsets };
        shader.fragmentShader = `uniform vec2 uAnimOffset[ ${offsets.length} ];\n` + shader.fragmentShader;
        const patched = shader.fragmentShader.replace('#include <map_fragment>', animChunk);
        if (patched === shader.fragmentShader && !_warnedShader) {
          _warnedShader = true;
          console.warn('[chunkrenderer] could not patch <map_fragment>; water and lava will not flow');
        }
        shader.fragmentShader = patched;
        shaders.push(shader);
      };
      // Every chunk material injects identical code, so they can share one
      // compiled program.
      mat.customProgramCacheKey = () => 'mc67-chunk-anim';
      return mat;
    };

    const opaque = hook(new THREE.MeshBasicMaterial({
      map, vertexColors: true, fog: true, side: THREE.FrontSide,
    }));
    opaque.name = 'chunk_opaque';

    const cutout = hook(new THREE.MeshBasicMaterial({
      map, vertexColors: true, fog: true,
      transparent: false, alphaTest: 0.5, side: THREE.DoubleSide,
    }));
    cutout.name = 'chunk_cutout';

    const translucent = hook(new THREE.MeshBasicMaterial({
      map, vertexColors: true, fog: true,
      transparent: true, opacity: 1, depthWrite: false, side: THREE.DoubleSide,
    }));
    translucent.name = 'chunk_translucent';

    return { opaque, cutout, translucent };
  }

  /** Advances every animated tile and pushes the offsets into the shaders. */
  _updateAnimation() {
    const anims = this._anims;
    if (!anims.length) return;
    let t = Game.time;
    if (typeof t !== 'number' || !isFinite(t)) t = nowMs() / 1000;
    for (let i = 0; i < anims.length; i++) {
      const a = anims[i];
      let f = Math.floor(t * a.fps) % a.frames;
      if (f < 0) f += a.frames;
      if (this._animFrame[i] === f) continue;
      this._animFrame[i] = f;
      this._animOffsets[i].set(a.du[f], a.dv[f]);
    }
  }

  /** Mirrors sky.js's fog into the scene fog our materials read. */
  _syncFog() {
    const scene = this.scene;
    if (!scene) return;
    if (!scene.fog) { scene.fog = this.fog; this._ownsFog = true; }
    if (scene.fog !== this.fog) return;     // sky.js installed its own

    const far = Math.max(32, this.renderDistance * CHUNK_X * 0.95);
    const sky = Game.sky;
    let handled = false;
    if (sky) {
      try {
        const c = sky.fogColor;
        if (c != null) {
          if (c.isColor) this.fog.color.copy(c);
          else if (typeof c === 'number') this.fog.color.setHex(c);
          handled = true;
        }
        if (typeof sky.fogNear === 'number' && typeof sky.fogFar === 'number') {
          this.fog.near = sky.fogNear;
          this.fog.far = sky.fogFar;
          return;
        }
        const dense = typeof sky.fogDensity === 'number' ? clamp(sky.fogDensity, 0, 1) : 0;
        this.fog.far = far * (1 - dense * 0.65);
        this.fog.near = this.fog.far * (dense > 0.5 ? 0.05 : 0.62);
        if (handled) return;
      } catch { /* sky is optional */ }
    }
    this.fog.far = far;
    this.fog.near = far * 0.62;
    if (!handled && !sky && Game.renderer) {
      // No sky module yet: at least match the clear colour to the fog so the
      // horizon does not show a hard seam.
      try { Game.renderer.setClearColor(this.fog.color, 1); } catch { /* optional */ }
    }
  }

  // -------------------------------------------------------------------
  // Public API
  // -------------------------------------------------------------------
  /** Clamps and stores the render distance in chunks. */
  setRenderDistance(n) {
    const v = clamp(Math.round(Number(n) || DEFAULT_RENDER_DISTANCE), MIN_RENDER_DISTANCE, MAX_RENDER_DISTANCE);
    this.renderDistance = v;
    return v;
  }

  /** Forces a chunk to be re-meshed on the next update(). */
  setChunkDirty(cx, cz) {
    const e = this.chunks.get(chunkKey(cx, cz));
    if (e) e.version = -1;
  }

  /** Drops a chunk's meshes and frees their GPU buffers. */
  removeChunk(cx, cz) {
    const key = chunkKey(cx, cz);
    const e = this.chunks.get(key);
    if (!e) return false;
    this._disposeEntry(e);
    this.chunks.delete(key);
    return true;
  }

  /** Removes every chunk mesh (dimension change, world unload). */
  clear() {
    for (const e of this.chunks.values()) this._disposeEntry(e);
    this.chunks.clear();
    this._world = null;
    this._selBoxes = null;
    this._breakBoxes = null;
    this._breakStage = -1;
    this._applyOverlays();
  }

  /** Live counters for the F3 overlay. */
  get stats() {
    const s = this._stats;
    s.loaded = this.chunks.size;
    return s;
  }

  /**
   * Meshes dirty chunks nearest the player first, uploads them, prunes chunks
   * outside the render distance and culls the rest.
   * @param {object} world  active World
   * @param {object} player the local player (may be null before spawn)
   * @param {number} budgetMs milliseconds this frame may spend meshing
   */
  update(world, player, budgetMs = 8) {
    if (this._disposed || !world) return;
    if (this._world !== world) {
      this.clear();
      this._world = world;
    }

    this._updateAnimation();
    this._syncFog();

    const camera = Game.camera;
    let px = 0, py = 64, pz = 0;
    if (player) { px = player.x; py = player.y; pz = player.z; }
    else if (camera) { px = camera.position.x; py = camera.position.y; pz = camera.position.z; }

    const pcx = Math.floor(px / CHUNK_X);
    const pcz = Math.floor(pz / CHUNK_Z);

    this._prune(world, pcx, pcz);
    const t0 = nowMs();
    this._meshBudget(world, pcx, pcz, budgetMs);
    this._stats.meshMs = nowMs() - t0;
    this._cull(camera, px, py, pz);
    this._updateCursor(world, player, camera);

    // Feed the shared counters the debug overlay reads.
    try {
      Game.stats.chunksRendered = this._stats.rendered;
      Game.stats.chunksQueued = this._stats.queued;
      Game.stats.meshMs = this._stats.meshMs;
    } catch { /* stats are optional */ }
  }

  // -------------------------------------------------------------------
  // Meshing
  // -------------------------------------------------------------------
  /** Unloads meshes for chunks that left the render distance or the world. */
  _prune(world, pcx, pcz) {
    const keep = this.renderDistance + 2;
    for (const [key, e] of this.chunks) {
      const dx = e.cx - pcx, dz = e.cz - pcz;
      if (Math.abs(dx) <= keep && Math.abs(dz) <= keep && world.chunks.has(key)) continue;
      this._disposeEntry(e);
      this.chunks.delete(key);
    }
  }

  /**
   * Bucketed nearest-first pass over the dirty chunks. Buckets are indexed by
   * Chebyshev chunk distance, which is a good enough ordering and costs no
   * comparison sort per frame.
   */
  _meshBudget(world, pcx, pcz, budgetMs) {
    const rd = this.renderDistance;
    const buckets = this._buckets;
    for (let i = 0; i < buckets.length; i++) buckets[i].length = 0;

    let queued = 0;
    for (const chunk of world.chunks.values()) {
      const dx = chunk.cx - pcx, dz = chunk.cz - pcz;
      const d = Math.abs(dx) > Math.abs(dz) ? Math.abs(dx) : Math.abs(dz);
      if (d > rd) continue;
      if (!chunk.generated || !chunk.lit) continue;
      const key = chunkKey(chunk.cx, chunk.cz);
      const e = this.chunks.get(key);
      if (e && !chunk.dirty && e.version === chunk.meshVersion) continue;
      queued++;
      if (d < buckets.length) buckets[d].push(chunk);
    }
    this._stats.queued = queued;

    const deadline = nowMs() + Math.max(1, budgetMs);
    let meshed = 0;
    outer:
    for (let d = 0; d < buckets.length; d++) {
      const list = buckets[d];
      for (let i = 0; i < list.length; i++) {
        if (meshed > 0 && nowMs() >= deadline) break outer;
        this._meshChunk(world, list[i]);
        meshed++;
      }
    }
    this._stats.meshed = meshed;
  }

  /** Builds (or rebuilds) the three pass meshes for one chunk. */
  _meshChunk(world, chunk) {
    const key = chunkKey(chunk.cx, chunk.cz);
    let data = null;
    try {
      data = meshChunk(world, chunk);
    } catch (err) {
      console.error('[chunkrenderer] meshChunk failed at', chunk.cx, chunk.cz, err);
      data = null;
    }
    chunk.dirty = false;
    chunk.meshVersion = (chunk.meshVersion | 0) + 1;

    let e = this.chunks.get(key);
    const isNew = !e;
    if (e) this._disposeMeshes(e);
    else {
      e = {
        cx: chunk.cx, cz: chunk.cz, key,
        meshes: { opaque: null, cutout: null, translucent: null },
        version: -1,
        box: new THREE.Box3(),
        empty: true,
        centerX: chunk.cx * CHUNK_X + CHUNK_X / 2,
        centerY: WORLD_HEIGHT / 2,
        centerZ: chunk.cz * CHUNK_Z + CHUNK_Z / 2,
        visible: false,
      };
      this.chunks.set(key, e);
    }
    e.version = chunk.meshVersion;

    const box = e.box;
    box.makeEmpty();
    let any = false;
    if (data) {
      for (let p = 0; p < PASSES.length; p++) {
        const pass = PASSES[p];
        const geoData = data[pass];
        if (!geoData || !geoData.index || geoData.index.length === 0) continue;
        const geo = this._buildGeometry(geoData);
        if (!geo) continue;
        const mesh = new THREE.Mesh(geo, this.materials[pass]);
        mesh.frustumCulled = false;       // we cull whole chunks ourselves
        mesh.matrixAutoUpdate = false;
        mesh.updateMatrix();
        mesh.name = pass + ' ' + key;
        mesh.userData.pass = pass;
        this.group.add(mesh);
        e.meshes[pass] = mesh;
        _liveMeshes++;
        if (geo.boundingBox) box.union(geo.boundingBox);
        any = true;
      }
    }
    if (!any) {
      box.min.set(chunk.cx * CHUNK_X, 0, chunk.cz * CHUNK_Z);
      box.max.set(chunk.cx * CHUNK_X + CHUNK_X, 0, chunk.cz * CHUNK_Z + CHUNK_Z);
    } else {
      // A margin covers the one-frame lag between our cull and the camera
      // update, so chunks never pop in at the edge of the screen.
      box.expandByScalar(6);
    }
    e.empty = !any;
    e.centerY = any ? (box.min.y + box.max.y) * 0.5 : 64;

    // A freshly loaded chunk changes the border faces of the chunks that were
    // meshed while it was still missing, so nudge its neighbours once.
    if (isNew) {
      for (let i = 0; i < 4; i++) {
        const nx = chunk.cx + (i === 0 ? -1 : i === 1 ? 1 : 0);
        const nz = chunk.cz + (i === 2 ? -1 : i === 3 ? 1 : 0);
        const n = this.chunks.get(chunkKey(nx, nz));
        if (n) n.version = -1;
      }
    }
  }

  /** Uploads one pass's typed arrays into a fresh BufferGeometry. */
  _buildGeometry(d) {
    try {
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.BufferAttribute(d.position, 3));
      g.setAttribute('normal', new THREE.BufferAttribute(d.normal, 3));
      g.setAttribute('uv', new THREE.BufferAttribute(d.uv, 2));
      g.setAttribute('color', new THREE.BufferAttribute(d.color, 3));
      g.setIndex(new THREE.BufferAttribute(d.index, 1));
      g.computeBoundingBox();
      g.computeBoundingSphere();
      return g;
    } catch (err) {
      console.error('[chunkrenderer] geometry upload failed', err);
      return null;
    }
  }

  /** Detaches and frees a chunk's meshes without touching the entry itself. */
  _disposeMeshes(e) {
    for (let p = 0; p < PASSES.length; p++) {
      const m = e.meshes[PASSES[p]];
      if (!m) continue;
      this.group.remove(m);
      if (m.geometry) m.geometry.dispose();
      e.meshes[PASSES[p]] = null;
      _liveMeshes--;
    }
  }

  _disposeEntry(e) {
    this._disposeMeshes(e);
    e.version = -1;
  }

  // -------------------------------------------------------------------
  // Culling and translucent ordering
  // -------------------------------------------------------------------
  _cull(camera, px, py, pz) {
    const far = (this.renderDistance + 0.5) * CHUNK_X;
    const far2 = far * far;
    let rendered = 0, drawn = 0, tris = 0;
    let frustum = null;
    if (camera) {
      try {
        camera.updateMatrixWorld();
        this._projScreen.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
        this._frustum.setFromProjectionMatrix(this._projScreen);
        frustum = this._frustum;
      } catch { frustum = null; }
    }

    for (const e of this.chunks.values()) {
      let visible = !e.empty;
      let dist = 0;
      if (visible) {
        const dx = e.centerX - px, dz = e.centerZ - pz;
        const d2 = dx * dx + dz * dz;
        if (d2 > far2) visible = false;
        else if (frustum && !frustum.intersectsBox(e.box)) visible = false;
        else {
          const dy = e.centerY - py;
          dist = Math.sqrt(d2 + dy * dy);
        }
      }
      e.visible = visible;
      if (visible) rendered++;
      for (let p = 0; p < PASSES.length; p++) {
        const m = e.meshes[PASSES[p]];
        if (!m) continue;
        m.visible = visible;
        if (!visible) continue;
        // Every chunk mesh sits at the scene origin, so three's own depth sort
        // cannot tell them apart: order them by chunk distance explicitly.
        // Solid passes go near-to-far (early-z rejects the overdraw behind
        // them), the translucent pass far-to-near so water layers blend right.
        m.renderOrder = p === 2 ? -Math.round(dist * 4) : Math.round(dist * 4);
        drawn++;
        const idx = m.geometry && m.geometry.index;
        if (idx) tris += idx.count / 3;
      }
    }
    this._stats.rendered = rendered;
    this._stats.meshes = drawn;
    this._stats.triangles = tris;
  }

  // -------------------------------------------------------------------
  // Block cursor: selection outline + breaking cracks
  // -------------------------------------------------------------------
  /**
   * Sets the white selection outline.
   * @param {null|object|Array} boxesOrNull AABBs (world space), a raycast hit,
   *        or null to hide the outline. Calling this at all disables the
   *        built-in automatic outline.
   */
  setSelection(boxesOrNull) {
    this._autoSelection = false;
    this._selBoxes = normalizeBoxes(boxesOrNull);
    this._applyOverlays();
  }

  /**
   * Shows the breaking crack overlay on one block.
   * @param {number} x @param {number} y @param {number} z
   * @param {number} stage 0..9, or < 0 / null to hide. Calling this disables
   *        the built-in automatic crack overlay.
   */
  setBreakProgress(x, y, z, stage) {
    this._autoBreak = false;
    this._setBreak(x, y, z, stage);
    this._applyOverlays();
  }

  _setBreak(x, y, z, stage) {
    const s = stage == null ? -1 : Math.floor(stage);
    if (s < 0 || x == null) {
      this._breakBoxes = null;
      this._breakStage = -1;
      return;
    }
    const bx = Math.floor(x), by = Math.floor(y), bz = Math.floor(z);
    this._breakStage = clamp(s, 0, CRACK_STAGES - 1);
    if (this._breakBoxes && this._break.x === bx && this._break.y === by && this._break.z === bz) return;
    this._break.x = bx; this._break.y = by; this._break.z = bz;
    const world = this._world || Game.world;
    let id = 0, meta = 0;
    try {
      if (world) { id = world.getBlock(bx, by, bz); meta = world.getMeta(bx, by, bz); }
    } catch { id = 0; }
    let boxes = null;
    try { boxes = selectionBoxes(id, meta, bx, by, bz); } catch { boxes = null; }
    this._breakBoxes = (boxes && boxes.length)
      ? boxes.map((b) => [b.x0, b.y0, b.z0, b.x1, b.y1, b.z1])
      : [[bx, by, bz, bx + 1, by + 1, bz + 1]];
  }

  /** Derives the cursor from the player when nobody else drives it. */
  _updateCursor(world, player, camera) {
    if (!this._autoSelection && !this._autoBreak) return;

    let hit = null;
    const spectator = (() => { try { return Game.isSpectator(); } catch { return false; } })();
    if (player && !spectator && !player.dead && player.hitResult) {
      // player.js already raycast for us this frame; do not pay for a second one.
      hit = player.hitResult.block || null;
    } else if (player && !spectator && !player.dead) {
      let ox = player.x, oy = player.y + (player.eyeHeight != null ? player.eyeHeight : 1.62), oz = player.z;
      let dx, dy, dz;
      if (camera) {
        camera.getWorldDirection(_tmpDir);
        dx = _tmpDir.x; dy = _tmpDir.y; dz = _tmpDir.z;
      } else {
        const cp = Math.cos(player.pitch || 0);
        dx = -Math.sin(player.yaw || 0) * cp;
        dy = Math.sin(player.pitch || 0);
        dz = -Math.cos(player.yaw || 0) * cp;
      }
      let reach = 4.5;
      try { if (typeof player.getReach === 'function') reach = player.getReach(); } catch { reach = 4.5; }
      try {
        hit = world.raycast(ox, oy, oz, dx, dy, dz, reach, RAY_OPTS);
      } catch { hit = null; }
    }

    if (this._autoSelection) {
      if (hit) {
        let boxes = null;
        try { boxes = selectionBoxes(hit.blockId, hit.meta, hit.x, hit.y, hit.z); } catch { boxes = null; }
        this._selBoxes = (boxes && boxes.length)
          ? boxes.map((b) => [b.x0, b.y0, b.z0, b.x1, b.y1, b.z1])
          : [[hit.x, hit.y, hit.z, hit.x + 1, hit.y + 1, hit.z + 1]];
      } else {
        this._selBoxes = null;
      }
    }

    if (this._autoBreak) {
      const t = player && player.breakTarget;
      const prog = player ? player.breakProgress : 0;
      if (t && typeof prog === 'number' && prog > 0) {
        const tx = t.x != null ? t.x : t[0];
        const ty = t.y != null ? t.y : t[1];
        const tz = t.z != null ? t.z : t[2];
        this._setBreak(tx, ty, tz, Math.min(CRACK_STAGES - 1, Math.floor(prog * CRACK_STAGES)));
      } else {
        this._setBreak(null, null, null, -1);
      }
    }

    this._applyOverlays();
  }

  /** Pushes the current selection/break boxes onto the pooled overlay meshes. */
  _applyOverlays() {
    const pad = 0.0025;
    const sel = this._selBoxes;
    const n = sel ? sel.length : 0;
    for (let i = 0; i < n; i++) {
      const b = sel[i];
      const m = this._lineAt(i);
      m.position.set(b[0] - pad, b[1] - pad, b[2] - pad);
      m.scale.set(
        Math.max(1e-4, b[3] - b[0] + pad * 2),
        Math.max(1e-4, b[4] - b[1] + pad * 2),
        Math.max(1e-4, b[5] - b[2] + pad * 2),
      );
      m.updateMatrix();
      m.visible = true;
    }
    for (let i = n; i < this._lines.length; i++) this._lines[i].visible = false;

    const stage = this._breakStage;
    const brk = stage >= 0 ? this._breakBoxes : null;
    const bn = brk ? brk.length : 0;
    if (bn > 0) {
      const texs = crackTextures();
      const tex = texs[clamp(stage, 0, texs.length - 1)] || null;
      const had = this._crackMaterial.map;
      if (had !== tex) {
        this._crackMaterial.map = tex;
        // Only a null <-> texture transition changes the shader defines;
        // swapping one crack stage for the next must not recompile.
        if (!had || !tex) this._crackMaterial.needsUpdate = true;
      }
    }
    const bpad = 0.006;
    for (let i = 0; i < bn; i++) {
      const b = brk[i];
      const m = this._crackAt(i);
      m.position.set(b[0] - bpad, b[1] - bpad, b[2] - bpad);
      m.scale.set(
        Math.max(1e-4, b[3] - b[0] + bpad * 2),
        Math.max(1e-4, b[4] - b[1] + bpad * 2),
        Math.max(1e-4, b[5] - b[2] + bpad * 2),
      );
      m.updateMatrix();
      m.visible = true;
    }
    for (let i = bn; i < this._cracks.length; i++) this._cracks[i].visible = false;
  }

  _lineAt(i) {
    let m = this._lines[i];
    if (!m) {
      m = new THREE.LineSegments(unitEdgeGeometry(), this._lineMaterial);
      m.frustumCulled = false;
      m.matrixAutoUpdate = false;
      m.renderOrder = 5000;
      this.overlay.add(m);
      this._lines[i] = m;
    }
    return m;
  }

  _crackAt(i) {
    let m = this._cracks[i];
    if (!m) {
      m = new THREE.Mesh(unitBoxGeometry(), this._crackMaterial);
      m.frustumCulled = false;
      m.matrixAutoUpdate = false;
      m.renderOrder = 4000;
      this.overlay.add(m);
      this._cracks[i] = m;
    }
    return m;
  }

  // -------------------------------------------------------------------
  /** Releases every GPU resource this renderer owns. */
  dispose() {
    this.clear();
    this._disposed = true;
    if (this.scene) {
      this.scene.remove(this.group);
      this.scene.remove(this.overlay);
      if (this._ownsFog && this.scene.fog === this.fog) this.scene.fog = null;
    }
    for (const k of PASSES) {
      const m = this.materials[k];
      if (m) m.dispose();
    }
    this._lineMaterial.dispose();
    this._crackMaterial.dispose();
    this._lines.length = 0;
    this._cracks.length = 0;
  }
}

export default ChunkRenderer;
