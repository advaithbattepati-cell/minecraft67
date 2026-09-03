// ============================================================================
// world.js - The chunk manager and the heart of the simulation.
//
// The World owns:
//   * the loaded Chunk map and the streaming pipeline (generate -> populate ->
//     light), budgeted so main.js can spend a few milliseconds per frame on it,
//   * every block read/write in the game. setBlock/setRaw is the single choke
//     point: it maintains the chunk summaries, kicks lighting, marks meshes
//     dirty, fires events, notifies the six neighbours and schedules fluid /
//     redstone ticks,
//   * entities, indexed by a per-chunk spatial hash so an AABB query costs
//     O(cells) instead of O(entities),
//   * the day/night cycle, weather, lightning, scheduled ticks and random ticks.
//
// Cross-module dependencies that would otherwise form an import cycle
// (lighting, blockupdate, redstone, spawning, mesher, worldgen, mobs) are
// pulled in with dynamic imports kicked off at module scope. Every use site
// degrades gracefully when a module is missing, so a broken sibling module
// never takes the world down with it.
// ============================================================================

import {
  WORLD_HEIGHT, SEA_LEVEL,
  ID_MASK, packBlock,
  FACE_DIRS, FACE_NAMES, FACE_DOWN, FACE_UP, FACE_NORTH, FACE_SOUTH, FACE_WEST, FACE_EAST,
  DIM_OVERWORLD, DIM_NETHER, DIM_END, DIFFICULTY, DEFAULT_RENDER_DISTANCE,
} from '../core/constants.js';
import { clamp, chunkKey, AABB, approach } from '../core/util.js';
import { RNG, Noise, hash3 } from '../core/rng.js';
import { Game } from '../core/game.js';
import {
  B, getBlock, blockByName,
  isSolid as blockIsSolid, isOpaque as blockIsOpaque, isLiquid as blockIsLiquid,
  lightEmission, lightFilter as blockLightFilter,
} from './blocks.js';
import { Chunk, SECTION_COUNT } from './chunk.js';
import { getBiome as biomeById } from './biomes.js';

const flr = Math.floor;
const now = (typeof performance !== 'undefined' && performance.now)
  ? () => performance.now()
  : () => Date.now();

/** Block id used for the infinite floor below y=0. */
const BEDROCK_ID = B.BEDROCK ?? 1;
const WATER_ID = B.WATER ?? 0;
const LAVA_ID = B.LAVA ?? 0;
const FIRE_ID = B.FIRE ?? 0;

/** How deep a chain of setBlock -> neighborUpdate -> setBlock may go. */
const MAX_UPDATE_DEPTH = 48;
/** Hard cap on randomTick() calls in a single world tick. */
const MAX_RANDOM_TICKS = 4096;
/** Hard cap on scheduled ticks executed in a single world tick. */
const MAX_SCHEDULED_TICKS = 8192;
/** Chunks within this radius of a player are simulated (random ticks, spawning). */
const SIMULATION_RADIUS = 8;

// ---------------------------------------------------------------------------
// Lazily resolved sibling modules
// ---------------------------------------------------------------------------
let _lighting = null;
let _blockupdate = null;
let _redstone = null;
let _spawning = null;
let _mesher = null;
let _worldgen = null;
let _mobs = null;
let _depsStarted = false;

/**
 * Starts the dynamic imports for every sibling module the world talks to.
 * Called once at module scope so the promises have resolved long before the
 * first chunk is generated; nothing here touches `Game`.
 */
function loadDeps() {
  if (_depsStarted) return;
  _depsStarted = true;
  const grab = (path, assign) => {
    try {
      import(path).then((m) => { assign(m); }).catch(() => { /* optional */ });
    } catch { /* environments without dynamic import */ }
  };
  grab('./lighting.js', (m) => { _lighting = m; });
  grab('./blockupdate.js', (m) => { _blockupdate = m; });
  grab('./redstone.js', (m) => { _redstone = m; });
  grab('../entity/spawning.js', (m) => { _spawning = m; });
  grab('../render/mesher.js', (m) => { _mesher = m; });
  grab('./worldgen.js', (m) => { _worldgen = m; });
  grab('../entity/mobs.js', (m) => { _mobs = m; });
}
loadDeps();

// ---------------------------------------------------------------------------
// Small shared helpers
// ---------------------------------------------------------------------------

/** Numeric id for a block name, or `fallback` when the name is unknown. */
function idByName(name, fallback = 0) {
  const d = blockByName(name);
  return d ? d.id : fallback;
}

/** True when an entity can stand inside this block (air, plants, ...). */
function isPassable(id) {
  if (id === 0) return true;
  const d = getBlock(id);
  return !d.solid || d.collision === 'none';
}

/** Ticks between fluid spread steps for a liquid block. */
function fluidDelay(id, dimension) {
  const d = getBlock(id);
  if (d.liquid === 'water') return 5;
  if (d.liquid === 'lava') return dimension === DIM_NETHER ? 10 : 30;
  return 0;
}

// Fallback collision/selection boxes, used until render/mesher.js resolves.
const FULL_BOX = [0, 0, 0, 1, 1, 1];
const SCRATCH_BOX = new AABB();

/**
 * Collision boxes for a block in world space. Prefers mesher.blockBoxes() and
 * falls back to a shape derived from the block definition.
 * @returns {AABB[]}
 */
function boxesFor(id, meta, x, y, z) {
  if (_mesher && typeof _mesher.blockBoxes === 'function') {
    try {
      const r = _mesher.blockBoxes(id, meta, x, y, z);
      if (r && r.length !== undefined) return r;
    } catch { /* fall through to the built-in shapes */ }
  }
  const d = getBlock(id);
  let raw = d.boxes;
  if (!raw || !raw.length) {
    switch (d.collision) {
      case 'none':
        raw = d.model === 'cross' || d.model === 'crop'
          ? [[0.2, 0, 0.2, 0.8, 0.9, 0.8]]
          : [[0.05, 0, 0.05, 0.95, 0.95, 0.95]];
        break;
      case 'half':
        raw = (meta & 1) ? [[0, 0.5, 0, 1, 1, 1]] : [[0, 0, 0, 1, 0.5, 1]];
        break;
      case 'thin':
        raw = [[0, 0, 0, 1, 0.0625, 1]];
        break;
      default:
        raw = [FULL_BOX];
    }
  }
  const out = [];
  for (let i = 0; i < raw.length; i++) {
    const b = raw[i];
    out.push(new AABB(x + b[0], y + b[1], z + b[2], x + b[3], y + b[4], z + b[5]));
  }
  return out;
}

/**
 * Slab-method ray/box test that also reports which face was entered.
 * Writes { t, axis, sgn } into `out`; returns false when there is no hit.
 */
function rayBoxFace(ox, oy, oz, dx, dy, dz, box, out) {
  let tmin = 0, tmax = Infinity, axis = -1, sgn = -1;
  const o = [ox, oy, oz], d = [dx, dy, dz];
  const lo = [box.x0, box.y0, box.z0], hi = [box.x1, box.y1, box.z1];
  for (let i = 0; i < 3; i++) {
    if (Math.abs(d[i]) < 1e-9) {
      if (o[i] < lo[i] || o[i] > hi[i]) return false;
      continue;
    }
    const inv = 1 / d[i];
    let t0 = (lo[i] - o[i]) * inv;
    let t1 = (hi[i] - o[i]) * inv;
    if (t0 > t1) { const t = t0; t0 = t1; t1 = t; }
    if (t0 > tmin) { tmin = t0; axis = i; sgn = d[i] > 0 ? -1 : 1; }
    if (t1 < tmax) tmax = t1;
    if (tmin > tmax) return false;
  }
  if (tmax < 0) return false;
  if (axis < 0) {
    // Origin already inside the box: bounce back along the dominant axis.
    const ax = Math.abs(dx), ay = Math.abs(dy), az = Math.abs(dz);
    axis = ax >= ay && ax >= az ? 0 : ay >= az ? 1 : 2;
    sgn = (axis === 0 ? dx : axis === 1 ? dy : dz) > 0 ? -1 : 1;
  }
  out.t = tmin;
  out.axis = axis;
  out.sgn = sgn;
  return true;
}

// axis + sign -> FACE_* constant
const FACE_FROM_AXIS = [
  [FACE_WEST, FACE_EAST],   // x: -x face, +x face
  [FACE_DOWN, FACE_UP],
  [FACE_NORTH, FACE_SOUTH],
];

const RAY_SCRATCH = { t: 0, axis: -1, sgn: -1 };

/** Fills `out` with an entity's bounding box, tolerating partial entities. */
function entityBox(e, out) {
  if (typeof e.aabb === 'function') {
    try {
      const b = e.aabb(out);
      if (b && b.x1 !== undefined) return b;
    } catch { /* fall through */ }
  }
  const hw = (e.width !== undefined ? e.width : 0.6) / 2;
  const h = e.height !== undefined ? e.height : 1.8;
  return out.set(e.x - hw, e.y, e.z - hw, e.x + hw, e.y + h, e.z + hw);
}

// ---------------------------------------------------------------------------
// Fallback terrain generator
// ---------------------------------------------------------------------------

/**
 * A very small stand-in generator used when world/worldgen.js is unavailable.
 * It produces plain but playable terrain so the game never boots into a void.
 */
class FallbackGenerator {
  constructor(seed, dimension) {
    this.seed = seed >>> 0;
    this.dimension = dimension || DIM_OVERWORLD;
    this.noise = new Noise(hash3(this.seed, 7, 13, 29));
    this.detail = new Noise(hash3(this.seed, 31, 17, 5));
  }

  /** Surface height at a world column. */
  heightAt(x, z) {
    if (this.dimension === DIM_NETHER) return 70;
    if (this.dimension === DIM_END) {
      const d = Math.hypot(x, z);
      return d < 60 ? 62 : 0;
    }
    const base = this.noise.fbm2(x * 0.008, z * 0.008, 4);
    const rough = this.detail.fbm2(x * 0.05, z * 0.05, 3) * 3;
    return clamp(Math.round(SEA_LEVEL + 3 + base * 16 + rough), 2, WORLD_HEIGHT - 12);
  }

  /** Always plains-ish; the real generator maps climate properly. */
  biomeAt() { return 0; }

  /** Fills a chunk with terrain. */
  generateChunk(chunk) {
    const stone = idByName(this.dimension === DIM_NETHER ? 'netherrack'
      : this.dimension === DIM_END ? 'end_stone' : 'stone', 1);
    const dirt = idByName('dirt', stone);
    const grass = idByName(this.dimension === DIM_OVERWORLD ? 'grass_block' : 'netherrack', stone);
    const sand = idByName('sand', dirt);
    const ox = chunk.cx << 4, oz = chunk.cz << 4;
    const blocks = chunk.blocks;
    for (let lz = 0; lz < 16; lz++) {
      for (let lx = 0; lx < 16; lx++) {
        const h = this.heightAt(ox + lx, oz + lz);
        const ci = (lz << 4) | lx;
        for (let y = 0; y <= h && y < WORLD_HEIGHT; y++) {
          let id = stone;
          if (y === 0) id = BEDROCK_ID;
          else if (y === h) id = h <= SEA_LEVEL ? sand : grass;
          else if (y > h - 4) id = dirt;
          blocks[(y << 8) | ci] = packBlock(id, 0);
        }
        if (this.dimension === DIM_OVERWORLD) {
          for (let y = h + 1; y <= SEA_LEVEL; y++) blocks[(y << 8) | ci] = packBlock(WATER_ID, 0);
        } else if (this.dimension === DIM_NETHER) {
          for (let y = 1; y <= 31 && y <= h; y++) {
            if ((blocks[(y << 8) | ci] & ID_MASK) === 0) blocks[(y << 8) | ci] = packBlock(LAVA_ID, 0);
          }
        }
        chunk.biomes[ci] = 0;
      }
    }
    chunk.recomputeHeightmap();
    chunk.generated = true;
  }

  /** Nothing to decorate. */
  populateChunk(chunk) { chunk.populated = true; }

  /** Picks the first solid column at the origin. */
  findSpawn(world) {
    for (let r = 0; r < 64; r++) {
      for (let i = -r; i <= r; i++) {
        const cands = [[i, -r], [i, r], [-r, i], [r, i]];
        for (const [dx, dz] of cands) {
          const h = this.heightAt(dx, dz);
          if (h > SEA_LEVEL) return { x: dx + 0.5, y: h + 1, z: dz + 0.5 };
        }
      }
    }
    return { x: 0.5, y: SEA_LEVEL + 2, z: 0.5 };
  }
}

// ---------------------------------------------------------------------------
// Fallback lighting
// ---------------------------------------------------------------------------

/**
 * A cheap column-only sky light pass plus emitter seeding. Used until
 * world/lighting.js resolves so freshly generated chunks are never pitch black.
 */
function fallbackInitSkyLight(world, chunk) {
  const blocks = chunk.blocks;
  const light = chunk.light;
  light.fill(0);
  for (let ci = 0; ci < 256; ci++) {
    let level = 15;
    for (let y = WORLD_HEIGHT - 1; y >= 0; y--) {
      const i = (y << 8) | ci;
      const id = blocks[i] & ID_MASK;
      if (id !== 0) {
        const f = blockLightFilter(id);
        level = f >= 15 ? 0 : Math.max(0, level - Math.max(1, f));
      }
      light[i] = (level << 4) | (light[i] & 15);
      if (level === 0) break;
    }
  }
  // Seed emitters. No horizontal spread here; lighting.js does the real work.
  for (let i = 0; i < blocks.length; i++) {
    const v = blocks[i];
    const id = v & ID_MASK;
    if (id === 0) continue;
    const e = lightEmission(id, (v >>> 12) & 15);
    if (e > 0) light[i] = (light[i] & 0xf0) | e;
  }
  chunk.lit = true;
}

/** Re-runs the column sky pass around a changed block. */
function fallbackUpdateLight(world, x, y, z) {
  const chunk = world.chunkAt(x, z);
  if (!chunk) return;
  const lx = x - (chunk.cx << 4), lz = z - (chunk.cz << 4);
  const ci = (lz << 4) | lx;
  const blocks = chunk.blocks, light = chunk.light;
  let level = 15;
  for (let yy = WORLD_HEIGHT - 1; yy >= 0; yy--) {
    const i = (yy << 8) | ci;
    const id = blocks[i] & ID_MASK;
    if (id !== 0) {
      const f = blockLightFilter(id);
      level = f >= 15 ? 0 : Math.max(0, level - Math.max(1, f));
    }
    const emit = id === 0 ? 0 : lightEmission(id, (blocks[i] >>> 12) & 15);
    light[i] = (level << 4) | Math.max(emit, light[i] & 15);
  }
}

// ---------------------------------------------------------------------------
// World
// ---------------------------------------------------------------------------

/**
 * One dimension's worth of loaded world: chunks, entities, time and weather.
 */
export class World {
  /**
   * @param {{seed?:number|string, dimension?:string, generator?:object}} opts
   */
  constructor({ seed = 0, dimension = DIM_OVERWORLD, generator = null } = {}) {
    this.seed = typeof seed === 'string' ? (hash3(0, seed.length, 0, 0) >>> 0) : (seed >>> 0);
    this.dimension = dimension;
    this.generator = generator || createFallbackGenerator(this.seed, dimension);

    /** @type {Map<string, Chunk>} */
    this.chunks = new Map();
    /** @type {Array<object>} */
    this.entities = [];
    /** @type {Map<number, object>} */
    this.entitiesById = new Map();
    /** chunkKey -> Set<Entity>, the spatial hash backing entitiesInAABB. */
    this._entityCells = new Map();
    // One-entry chunk lookup memo: block reads walk the same column over and
    // over, and this keeps getRaw() off the string-keyed Map most of the time.
    this._lc = null; this._lcx = 0x7fffffff; this._lcz = 0x7fffffff; this._lcSize = -1;
    this._removedCount = 0;
    this._nextLocalId = 1;

    // --- time & weather ----------------------------------------------------
    this.time = 1000;                 // day time, 0..23999
    this.totalTime = 0;               // monotonic tick counter
    this.weather = {
      rain: 0, thunder: 0,
      rainTicks: 24000 + (this.seed % 12000),
      thunderTicks: 60000 + (this.seed % 24000),
      raining: false, thundering: false,
    };
    this.lightningTicks = 0;          // >0 for a few ticks after a strike (sky.js reads it)
    this.spawnPoint = { x: 0, y: SEA_LEVEL + 1, z: 0 };

    // --- rules -------------------------------------------------------------
    this.randomTickSpeed = 3;
    this.gameRules = {
      doDaylightCycle: true,
      doWeatherCycle: dimension === DIM_OVERWORLD,
      doMobSpawning: true,
      doFireTick: true,
      mobGriefing: true,
      keepInventory: false,
      doTileDrops: true,
    };

    // --- scheduling --------------------------------------------------------
    /** @type {Array<{x:number,y:number,z:number,id:number,due:number}>} min-heap */
    this._scheduled = [];
    this._scheduledKeys = new Set();

    // --- streaming ---------------------------------------------------------
    this._pending = [];               // jobs, best priority last (popped first)
    this._pendingMap = new Map();
    this._pendingSorted = true;

    this.rng = new RNG(hash3(this.seed, 0x5eed, dimension.length, 3));
    this._updateDepth = 0;
    this._streamTimer = 0;
    this._spawnTimer = 0;
    this._pruneTimer = 0;
    this._despawnTimer = 0;
    this.stats = { generated: 0, populated: 0, lit: 0, unloaded: 0 };
  }

  // =========================================================================
  // Chunks
  // =========================================================================

  /** Chunk at chunk coords, optionally creating an empty one. */
  getChunk(cx, cz, create = false) {
    const k = chunkKey(cx, cz);
    let c = this.chunks.get(k);
    if (!c && create) {
      c = new Chunk(cx, cz, this);
      this.chunks.set(k, c);
      this._invalidateChunkMemo();
    }
    return c || null;
  }

  /** Memoised chunk lookup by chunk coords. Returns null when not loaded. */
  _chunkFor(cx, cz) {
    if (cx === this._lcx && cz === this._lcz && this._lcSize === this.chunks.size) return this._lc;
    const c = this.chunks.get(chunkKey(cx, cz)) || null;
    this._lcx = cx; this._lcz = cz; this._lc = c; this._lcSize = this.chunks.size;
    return c;
  }

  _invalidateChunkMemo() {
    this._lc = null; this._lcx = 0x7fffffff; this._lcz = 0x7fffffff; this._lcSize = -1;
  }

  /** True when a chunk object exists (generated or not). */
  hasChunk(cx, cz) {
    return this.chunks.has(chunkKey(cx, cz));
  }

  /** True when the chunk exists and has terrain in it. */
  isChunkGenerated(cx, cz) {
    const c = this._chunkFor(cx, cz);
    return !!(c && c.generated);
  }

  /** True when the chunk is generated, populated and lit. */
  isChunkReady(cx, cz) {
    const c = this._chunkFor(cx, cz);
    return !!(c && c.generated && c.populated && c.lit);
  }

  /** Chunk containing a world column, or null. */
  chunkAt(x, z) {
    return this._chunkFor(flr(x) >> 4, flr(z) >> 4);
  }

  /**
   * Runs the whole generate -> populate -> light pipeline for one chunk and
   * returns it. Blocking; use queueChunk()/processChunkQueue() on the hot path.
   */
  ensureChunk(cx, cz) {
    let guard = 8;
    let c = this.getChunk(cx, cz, true);
    while (guard-- > 0 && !(c.generated && c.populated && c.lit)) {
      if (!this._stepChunk(cx, cz, Infinity)) break;
      c = this.getChunk(cx, cz, true);
    }
    this._dropPending(chunkKey(cx, cz));
    return c;
  }

  /**
   * Advances one chunk by a single pipeline stage.
   * @returns {boolean} false when the stage had to be abandoned for budget.
   */
  _stepChunk(cx, cz, deadline) {
    const c = this.getChunk(cx, cz, true);
    if (!c.generated) { this._generateChunk(c); return true; }
    if (!c.populated) {
      // Populate needs the 3x3 neighbourhood to hold terrain so trees and
      // structures may spill across the border.
      for (let dz = -1; dz <= 1; dz++) {
        for (let dx = -1; dx <= 1; dx++) {
          if (dx === 0 && dz === 0) continue;
          const n = this.getChunk(cx + dx, cz + dz, true);
          if (n.generated) continue;
          if (now() > deadline) return false;
          this._generateChunk(n);
        }
      }
      this._populateChunk(c);
      return true;
    }
    if (!c.lit) { this._lightChunk(c); return true; }
    return true;
  }

  /** Runs terrain generation for a chunk. */
  _generateChunk(chunk) {
    try {
      this.generator.generateChunk(chunk, this);
    } catch (e) {
      console.error('[world] generateChunk failed', chunk.cx, chunk.cz, e);
    }
    chunk.generated = true;
    chunk.recomputeHeightmap();
    chunk.dirty = true;
    this.stats.generated++;
  }

  /** Runs decoration/structures for a chunk whose neighbours already exist. */
  _populateChunk(chunk) {
    try {
      this.generator.populateChunk(chunk, this);
    } catch (e) {
      console.error('[world] populateChunk failed', chunk.cx, chunk.cz, e);
    }
    chunk.populated = true;
    // Features may write straight into chunk.blocks, so re-derive summaries.
    chunk.recomputeHeightmap();
    chunk.dirty = true;
    this.stats.populated++;
  }

  /** Runs the initial light pass and dirties the neighbours that border it. */
  _lightChunk(chunk) {
    if (_lighting && typeof _lighting.initSkyLight === 'function') {
      try {
        _lighting.initSkyLight(this, chunk);
      } catch (e) {
        console.error('[world] initSkyLight failed', chunk.cx, chunk.cz, e);
        fallbackInitSkyLight(this, chunk);
      }
    } else {
      fallbackInitSkyLight(this, chunk);
    }
    chunk.lit = true;
    chunk.dirty = true;
    this.stats.lit++;
    for (let i = 0; i < 4; i++) {
      const d = FACE_DIRS[i + 2];
      const n = this.chunks.get(chunkKey(chunk.cx + d[0], chunk.cz + d[2]));
      if (n && n.lit) n.dirty = true;
    }
    this._notifyRenderer(chunk.cx, chunk.cz);
  }

  /** Drops a chunk from memory, handing it to the save manager first. */
  unloadChunk(cx, cz) {
    const k = chunkKey(cx, cz);
    const c = this.chunks.get(k);
    if (!c) return false;
    if (c.modified) {
      try { Game.save?.markChunkModified?.(c); } catch { /* optional */ }
    }
    this.chunks.delete(k);
    this._invalidateChunkMemo();
    this._dropPending(k);
    try { Game.chunkRenderer?.removeChunk?.(cx, cz); } catch { /* optional */ }
    Game.emit('chunkunload', cx, cz, this);
    this.stats.unloaded++;
    return true;
  }

  /** Adds a chunk object built elsewhere (save.js) to the loaded set. */
  addChunk(chunk) {
    if (!chunk) return null;
    chunk.world = this;
    this.chunks.set(chunkKey(chunk.cx, chunk.cz), chunk);
    this._invalidateChunkMemo();
    chunk.dirty = true;
    this._dropPending(chunkKey(chunk.cx, chunk.cz));
    return chunk;
  }

  // ---- streaming queue ----------------------------------------------------

  /**
   * Requests that a chunk be brought all the way up to "ready". Lower
   * `priority` numbers are handled first (pass a squared distance).
   */
  queueChunk(cx, cz, priority = 0) {
    const k = chunkKey(cx, cz);
    if (this.isChunkReady(cx, cz)) return false;
    const existing = this._pendingMap.get(k);
    if (existing) {
      if (priority < existing.priority) { existing.priority = priority; this._pendingSorted = false; }
      return false;
    }
    const job = { cx, cz, priority, key: k };
    this._pendingMap.set(k, job);
    this._pending.push(job);
    this._pendingSorted = false;
    return true;
  }

  /** Number of chunks waiting in the streaming queue. */
  get pendingCount() { return this._pending.length; }

  /**
   * Spends up to `budgetMs` milliseconds advancing queued chunks.
   * @returns {number} pipeline stages completed.
   */
  processChunkQueue(budgetMs = 4) {
    if (this._pending.length === 0) return 0;
    if (!this._pendingSorted) {
      // Worst priority first so pop() takes the best job.
      this._pending.sort((a, b) => b.priority - a.priority);
      this._pendingSorted = true;
    }
    const t0 = now();
    const deadline = t0 + budgetMs;
    let done = 0;
    while (this._pending.length > 0) {
      if (done > 0 && now() >= deadline) break;
      const job = this._pending.pop();
      this._pendingMap.delete(job.key);
      let ok = true;
      try {
        ok = this._stepChunk(job.cx, job.cz, deadline);
      } catch (e) {
        console.error('[world] chunk step failed', job.cx, job.cz, e);
        ok = true;                       // do not spin on a broken chunk
      }
      done++;
      if (this.isChunkReady(job.cx, job.cz)) continue;
      // Not finished: push it straight back on top so the next stage runs now
      // rather than a frame later. `_pendingSorted` stays true because a
      // re-pushed job is already the best one in the queue.
      this._pendingMap.set(job.key, job);
      this._pending.push(job);
      if (!ok) break;                    // the stage itself ran out of budget
    }
    return done;
  }

  /** Forgets a queued job (because the chunk became ready or went away). */
  _dropPending(key) {
    const job = this._pendingMap.get(key);
    if (!job) return;
    this._pendingMap.delete(key);
    const i = this._pending.indexOf(job);
    if (i >= 0) this._pending.splice(i, 1);
  }

  /** Queues every chunk inside `radius` of a column, nearest first. */
  requestArea(cx, cz, radius) {
    const r2 = radius * radius;
    for (let dz = -radius; dz <= radius; dz++) {
      for (let dx = -radius; dx <= radius; dx++) {
        const d2 = dx * dx + dz * dz;
        if (d2 > r2) continue;
        if (this.isChunkReady(cx + dx, cz + dz)) continue;
        this.queueChunk(cx + dx, cz + dz, d2);
      }
    }
  }

  /** Unloads chunks further than `radius` chunks from every player. */
  pruneChunks(radius, maxUnloads = 8) {
    if (this.chunks.size === 0) return 0;
    const players = this.getPlayers();
    if (players.length === 0) return 0;
    const r2 = radius * radius;
    let removed = 0;
    for (const c of this.chunks.values()) {
      if (removed >= maxUnloads) break;
      let keep = false;
      for (let i = 0; i < players.length; i++) {
        const p = players[i];
        const dx = c.cx - (flr(p.x) >> 4);
        const dz = c.cz - (flr(p.z) >> 4);
        if (dx * dx + dz * dz <= r2) { keep = true; break; }
      }
      if (keep) continue;
      this.unloadChunk(c.cx, c.cz);
      removed++;
    }
    return removed;
  }

  // =========================================================================
  // Blocks
  // =========================================================================

  /**
   * Packed block value (id | meta<<12). Bedrock below the world, air above it,
   * air in unloaded chunks - so no caller ever needs a bounds check.
   */
  getRaw(x, y, z) {
    y = flr(y);
    if (y < 0) return packBlock(BEDROCK_ID, 0);
    if (y >= WORLD_HEIGHT) return 0;
    x = flr(x); z = flr(z);
    const c = this._chunkFor(x >> 4, z >> 4);
    if (!c) return 0;
    return c.blocks[(y << 8) | ((z & 15) << 4) | (x & 15)];
  }

  /** Numeric block id at a world position. */
  getBlock(x, y, z) { return this.getRaw(x, y, z) & ID_MASK; }

  /** Metadata nibble at a world position. */
  getMeta(x, y, z) { return (this.getRaw(x, y, z) >>> 12) & 15; }

  /** Block definition at a world position (never undefined). */
  getBlockDef(x, y, z) { return getBlock(this.getRaw(x, y, z) & ID_MASK); }

  /**
   * The one and only block mutator.
   * flags bit0 = update lighting + mark meshes dirty, bit1 = notify neighbours,
   * bit2 = suppress the 'blockchange' event.
   * @returns {boolean} true when something actually changed.
   */
  setBlock(x, y, z, id, meta = 0, flags = 3) {
    return this.setRaw(x, y, z, packBlock(id, meta), flags);
  }

  /** setBlock() taking an already packed value. */
  setRaw(x, y, z, value, flags = 3) {
    x = flr(x); y = flr(y); z = flr(z);
    if (y < 0 || y >= WORLD_HEIGHT) return false;
    const cx = x >> 4, cz = z >> 4;
    const chunk = this._chunkFor(cx, cz);
    if (!chunk) return false;                  // never write into unloaded space

    const lx = x & 15, lz = z & 15;
    value &= 0xffff;
    const prev = chunk.blocks[(y << 8) | (lz << 4) | lx];
    if (prev === value) return false;

    const oldId = prev & ID_MASK, newId = value & ID_MASK;

    chunk.set(lx, y, lz, value);               // maintains heightmap + counters

    // Block entities belong to a block id; a different block loses its record.
    if (oldId !== newId) {
      const oldDef = getBlock(oldId);
      if (oldDef.entityType) chunk.removeBlockEntity(lx, y, lz);
      const newDef = getBlock(newId);
      if (newDef.entityType && !chunk.getBlockEntity(lx, y, lz)) {
        chunk.setBlockEntity(lx, y, lz, { type: newDef.entityType, block: newDef.name, x, y, z });
      }
    }

    if (flags & 1) {
      // A meta-only change still matters here: lit furnaces and redstone lamps
      // switch their emission with the metadata bit.
      this._updateLight(x, y, z, oldId, newId);
      this.markDirty(x, y, z);
    }

    if (!(flags & 4)) Game.emit('blockchange', x, y, z, oldId, newId, prev, value);

    if (flags & 2) this._afterChange(x, y, z, oldId, newId);
    return true;
  }

  /** Rewrites only the metadata nibble of a block. */
  setMeta(x, y, z, meta, flags = 3) {
    const v = this.getRaw(x, y, z);
    if ((v & ID_MASK) === 0) return false;
    return this.setRaw(x, y, z, (v & ID_MASK) | ((meta & 15) << 12), flags);
  }

  /** Lighting hand-off, with a column fallback while lighting.js loads. */
  _updateLight(x, y, z, oldId, newId) {
    if (_lighting && typeof _lighting.updateLight === 'function') {
      try {
        _lighting.updateLight(this, x, y, z, oldId, newId);
        return;
      } catch (e) {
        console.error('[world] updateLight failed', e);
      }
    }
    fallbackUpdateLight(this, x, y, z);
  }

  /**
   * Neighbour notification plus fluid/redstone scheduling. Depth-guarded so a
   * cascade of updates can never blow the stack.
   */
  _afterChange(x, y, z, oldId, newId) {
    if (this._updateDepth >= MAX_UPDATE_DEPTH) return;
    this._updateDepth++;
    try {
      // Freshly placed fluids and their liquid neighbours need a spread tick.
      if (newId !== 0) {
        const d = fluidDelay(newId, this.dimension);
        if (d > 0) this.scheduleTick(x, y, z, d, newId);
      }
      for (let f = 0; f < 6; f++) {
        const dir = FACE_DIRS[f];
        const nx = x + dir[0], ny = y + dir[1], nz = z + dir[2];
        if (ny < 0 || ny >= WORLD_HEIGHT) continue;
        const nid = this.getBlock(nx, ny, nz);
        if (nid !== 0) {
          const fd = fluidDelay(nid, this.dimension);
          if (fd > 0) this.scheduleTick(nx, ny, nz, fd, nid);
          const ndef = getBlock(nid);
          if (ndef.gravity) this.scheduleTick(nx, ny, nz, 2, nid);
        }
        if (_blockupdate && typeof _blockupdate.neighborUpdate === 'function') {
          try {
            _blockupdate.neighborUpdate(this, nx, ny, nz, x, y, z);
          } catch (e) {
            console.error('[world] neighborUpdate failed', nx, ny, nz, e);
          }
        }
      }
      if (_redstone && typeof _redstone.updateRedstone === 'function') {
        try { _redstone.updateRedstone(this, x, y, z); } catch (e) { console.error('[world] updateRedstone failed', e); }
      }
    } finally {
      this._updateDepth--;
    }
  }

  /** Flags the containing chunk - and any chunk sharing the touched border. */
  markDirty(x, y, z) {
    x = flr(x); y = flr(y); z = flr(z);
    const cx = x >> 4, cz = z >> 4;
    const c = this._chunkFor(cx, cz);
    if (c) { c.dirty = true; this._notifyRenderer(cx, cz); }
    const lx = x & 15, lz = z & 15;
    if (lx === 0) this._dirtyChunk(cx - 1, cz);
    else if (lx === 15) this._dirtyChunk(cx + 1, cz);
    if (lz === 0) this._dirtyChunk(cx, cz - 1);
    else if (lz === 15) this._dirtyChunk(cx, cz + 1);
    // Corners share a vertical edge with two diagonal neighbours.
    if ((lx === 0 || lx === 15) && (lz === 0 || lz === 15)) {
      this._dirtyChunk(cx + (lx === 0 ? -1 : 1), cz + (lz === 0 ? -1 : 1));
    }
  }

  _dirtyChunk(cx, cz) {
    const c = this._chunkFor(cx, cz);
    if (!c) return;
    c.dirty = true;
    this._notifyRenderer(cx, cz);
  }

  _notifyRenderer(cx, cz) {
    const r = Game.chunkRenderer;
    if (r && typeof r.setChunkDirty === 'function') {
      try { r.setChunkDirty(cx, cz); } catch { /* optional */ }
    }
  }

  // ---- block predicates ---------------------------------------------------

  /** True when the block at this position collides. */
  isSolid(x, y, z) { return blockIsSolid(this.getBlock(x, y, z)); }
  /** True when the block hides faces and blocks light. */
  isOpaque(x, y, z) { return blockIsOpaque(this.getBlock(x, y, z)); }
  /** True when nothing is here. */
  isAir(x, y, z) { return this.getBlock(x, y, z) === 0; }
  /** True for water and lava. */
  isLiquid(x, y, z) { return blockIsLiquid(this.getBlock(x, y, z)); }
  /** True when a block can be placed over what is already here. */
  isReplaceable(x, y, z) {
    const id = this.getBlock(x, y, z);
    return id === 0 || getBlock(id).replaceable;
  }

  // ---- light --------------------------------------------------------------

  /** Combined render light 0..15: max(sky * daylight, block light). */
  getLight(x, y, z) {
    x = flr(x); y = flr(y); z = flr(z);
    if (y < 0) return 0;
    if (y >= WORLD_HEIGHT) return 15;
    const c = this._chunkFor(x >> 4, z >> 4);
    if (!c) return 15;
    const l = c.light[(y << 8) | ((z & 15) << 4) | (x & 15)];
    const sky = ((l >> 4) & 15) * this.skyLightFactor();
    const block = l & 15;
    return sky > block ? sky : block;
  }

  /** Raw stored sky light 0..15 (not scaled by the time of day). */
  getSkyLight(x, y, z) {
    x = flr(x); y = flr(y); z = flr(z);
    if (y < 0) return 0;
    if (y >= WORLD_HEIGHT) return 15;
    const c = this._chunkFor(x >> 4, z >> 4);
    if (!c) return 15;
    return (c.light[(y << 8) | ((z & 15) << 4) | (x & 15)] >> 4) & 15;
  }

  /** Emitted/propagated block light 0..15. */
  getBlockLight(x, y, z) {
    x = flr(x); y = flr(y); z = flr(z);
    if (y < 0 || y >= WORLD_HEIGHT) return 0;
    const c = this._chunkFor(x >> 4, z >> 4);
    if (!c) return 0;
    return c.light[(y << 8) | ((z & 15) << 4) | (x & 15)] & 15;
  }

  /** Writes both light channels directly (lighting.js uses the chunk API). */
  setLight(x, y, z, sky, block) {
    const c = this.chunkAt(x, z);
    if (!c) return;
    c.setLight(flr(x) & 15, flr(y), flr(z) & 15, sky, block);
  }

  // ---- columns ------------------------------------------------------------

  /** Biome id at a world column. */
  getBiome(x, z) {
    const c = this.chunkAt(x, z);
    if (!c) {
      try { return this.generator.biomeAt(flr(x), flr(z)) | 0; } catch { return 0; }
    }
    return c.biomes[((flr(z) & 15) << 4) | (flr(x) & 15)];
  }

  /** Biome definition at a world column. */
  biomeAt(x, z) { return biomeById(this.getBiome(x, z)); }

  /** Overwrites the biome id of a column. */
  setBiome(x, z, id) {
    const c = this.chunkAt(x, z);
    if (c) c.setBiome(flr(x) & 15, flr(z) & 15, id);
  }

  /** Highest non-air y plus one. 0 for an empty or unloaded column. */
  getHeight(x, z) {
    const c = this.chunkAt(x, z);
    if (!c) {
      try { return this.generator.heightAt(flr(x), flr(z)) | 0; } catch { return SEA_LEVEL; }
    }
    return c.heightmap[((flr(z) & 15) << 4) | (flr(x) & 15)];
  }

  /** Y of the topmost solid block in a column, or -1. */
  getTopSolid(x, z) {
    const c = this.chunkAt(x, z);
    if (!c) return -1;
    const lx = flr(x) & 15, lz = flr(z) & 15;
    for (let y = Math.min(WORLD_HEIGHT - 1, c.heightmap[(lz << 4) | lx]); y >= 0; y--) {
      const id = c.blocks[(y << 8) | (lz << 4) | lx] & ID_MASK;
      if (id !== 0 && blockIsSolid(id) && !blockIsLiquid(id)) return y;
    }
    return -1;
  }

  /** True when nothing opaque stands between this block and the sky. */
  canSeeSky(x, y, z) {
    const c = this.chunkAt(x, z);
    if (!c) return true;
    return flr(y) >= c.heightmap[((flr(z) & 15) << 4) | (flr(x) & 15)];
  }

  // ---- block entities -----------------------------------------------------

  /** Block entity record at a position, or undefined. */
  getBlockEntity(x, y, z) {
    const c = this.chunkAt(x, z);
    return c ? c.getBlockEntity(flr(x) & 15, flr(y), flr(z) & 15) : undefined;
  }

  /** Attaches a block entity record. */
  setBlockEntity(x, y, z, obj) {
    const c = this.chunkAt(x, z);
    return c ? c.setBlockEntity(flr(x) & 15, flr(y), flr(z) & 15, obj) : undefined;
  }

  /** Removes a block entity record. */
  removeBlockEntity(x, y, z) {
    const c = this.chunkAt(x, z);
    return c ? c.removeBlockEntity(flr(x) & 15, flr(y), flr(z) & 15) : false;
  }

  // =========================================================================
  // Entities
  // =========================================================================

  /** Registers an entity and indexes it in the spatial hash. */
  addEntity(e) {
    if (!e) return null;
    if (e.id === undefined || e.id === null) e.id = -(this._nextLocalId++);
    if (this.entitiesById.has(e.id) && this.entitiesById.get(e.id) === e) return e;
    // Moving between dimensions: the previous world defers its removal to the
    // next sweep, and that sweep keys off e.removed, which we clear two lines
    // down. Detach eagerly or the entity sits in both lists and gets ticked by
    // both - every round trip through a portal added another copy of the player.
    const prev = e.world;
    if (prev && prev !== this && typeof prev.detachEntity === 'function') prev.detachEntity(e);
    e.world = this;
    e.removed = false;
    this.entities.push(e);
    this.entitiesById.set(e.id, e);
    this._cellAdd(e);
    Game.emit('entityspawn', e);
    return e;
  }

  /**
   * Drops an entity from this world immediately rather than at the next sweep.
   * Replaces the array instead of splicing it, so a tick loop already iterating
   * the old array finishes undisturbed.
   */
  detachEntity(e) {
    if (!e) return false;
    const i = this.entities.indexOf(e);
    if (i >= 0) this.entities = this.entities.filter((x) => x !== e);
    this._cellRemove(e);
    if (this.entitiesById.get(e.id) === e) this.entitiesById.delete(e.id);
    return i >= 0;
  }

  /** Flags an entity as removed and unlinks it from the indexes. */
  removeEntity(e) {
    if (!e) return false;
    const known = this.entitiesById.get(e.id);
    e.removed = true;
    // Detach from the array here rather than waiting for the next sweep. The
    // sweep keys off e.removed, and anything that re-adds the entity elsewhere
    // clears that flag first, which left the entity stranded in both lists.
    this.detachEntity(e);
    if (known === e) {
      this._removedCount++;
      Game.emit('entityremove', e);
      return true;
    }
    return false;
  }

  /** Entity with this id, or undefined. */
  getEntity(id) { return this.entitiesById.get(id); }

  _cellKeyFor(e) { return chunkKey(flr(e.x) >> 4, flr(e.z) >> 4); }

  _cellAdd(e) {
    const k = this._cellKeyFor(e);
    let set = this._entityCells.get(k);
    if (!set) { set = new Set(); this._entityCells.set(k, set); }
    set.add(e);
    e._cellKey = k;
  }

  _cellRemove(e) {
    const k = e._cellKey;
    if (k === undefined) return;
    const set = this._entityCells.get(k);
    if (set) {
      set.delete(e);
      if (set.size === 0) this._entityCells.delete(k);
    }
    e._cellKey = undefined;
  }

  /** Re-buckets an entity that moved. Cheap when it stayed in its chunk. */
  onEntityMoved(e) {
    if (e.removed) return;
    const k = this._cellKeyFor(e);
    if (k === e._cellKey) return;
    this._cellRemove(e);
    this._cellAdd(e);
  }

  /**
   * Visits every entity bucketed in the chunk range covering a box.
   * The 1-block margin covers entities whose bucket is one tick stale.
   */
  _forEachInRange(x0, z0, x1, z1, fn) {
    const cx0 = flr(x0 - 1) >> 4, cx1 = flr(x1 + 1) >> 4;
    const cz0 = flr(z0 - 1) >> 4, cz1 = flr(z1 + 1) >> 4;
    for (let cz = cz0; cz <= cz1; cz++) {
      for (let cx = cx0; cx <= cx1; cx++) {
        const set = this._entityCells.get(chunkKey(cx, cz));
        if (!set) continue;
        for (const e of set) fn(e);
      }
    }
  }

  /**
   * Every entity whose bounding box intersects `box`.
   * @returns {Array<object>}
   */
  entitiesInAABB(box, filter = null) {
    const out = [];
    this._forEachInRange(box.x0, box.z0, box.x1, box.z1, (e) => {
      if (e.removed) return;
      if (filter && !filter(e)) return;
      const b = entityBox(e, SCRATCH_BOX);
      if (b.x0 < box.x1 && b.x1 > box.x0 && b.y0 < box.y1 && b.y1 > box.y0 &&
          b.z0 < box.z1 && b.z1 > box.z0) out.push(e);
    });
    return out;
  }

  /**
   * Every entity whose feet are within `radius` of a point.
   * @returns {Array<object>}
   */
  entitiesNear(x, y, z, radius, filter = null) {
    const out = [];
    const r2 = radius * radius;
    this._forEachInRange(x - radius, z - radius, x + radius, z + radius, (e) => {
      if (e.removed) return;
      if (filter && !filter(e)) return;
      const dx = e.x - x, dy = e.y - y, dz = e.z - z;
      if (dx * dx + dy * dy + dz * dz <= r2) out.push(e);
    });
    return out;
  }

  /** Closest entity within `radius`, or null. */
  nearestEntity(x, y, z, radius, filter = null) {
    let best = null, bestD = radius * radius;
    this._forEachInRange(x - radius, z - radius, x + radius, z + radius, (e) => {
      if (e.removed) return;
      if (filter && !filter(e)) return;
      const dx = e.x - x, dy = e.y - y, dz = e.z - z;
      const d = dx * dx + dy * dy + dz * dz;
      if (d < bestD) { bestD = d; best = e; }
    });
    return best;
  }

  /** Every player-ish entity currently in this world. */
  getPlayers() {
    const out = [];
    for (let i = 0; i < this.entities.length; i++) {
      const e = this.entities[i];
      if (!e.removed && (e.isPlayer || e.type === 'player')) out.push(e);
    }
    if (out.length === 0) {
      const p = Game.player;
      if (p && !p.removed && p.world === this) out.push(p);
    }
    return out;
  }

  /** Closest player within `radius` (Infinity by default), or null. */
  nearestPlayer(x, y, z, radius = Infinity) {
    const players = this.getPlayers();
    let best = null, bestD = radius * radius;
    for (let i = 0; i < players.length; i++) {
      const p = players[i];
      const dx = p.x - x, dy = p.y - y, dz = p.z - z;
      const d = dx * dx + dy * dy + dz * dz;
      if (d < bestD) { bestD = d; best = p; }
    }
    return best;
  }

  /** Drops entities flagged `removed` out of the flat list. */
  _reapEntities() {
    if (this._removedCount <= 0) return;
    const src = this.entities;
    const out = [];
    for (let i = 0; i < src.length; i++) {
      const e = src[i];
      if (e.removed) {
        this._cellRemove(e);
        // Entities that set `removed` themselves never went through
        // removeEntity(), so drop their id here too.
        if (this.entitiesById.get(e.id) === e) this.entitiesById.delete(e.id);
        continue;
      }
      out.push(e);
    }
    this.entities = out;
    this._removedCount = 0;
  }

  // =========================================================================
  // Raycasting
  // =========================================================================

  /**
   * Amanatides & Woo voxel traversal against per-block collision boxes.
   * @returns {null|{x:number,y:number,z:number,face:number,faceName:string,
   *   nx:number,ny:number,nz:number,blockId:number,meta:number,
   *   px:number,py:number,pz:number,distance:number}}
   *
   * opts.fluids     - also hit water/lava
   * opts.solidOnly  - skip blocks whose collision is 'none' (plants, torches)
   * opts.filter     - (id, meta, x, y, z) => boolean, overrides the above
   */
  raycast(ox, oy, oz, dx, dy, dz, maxDist = 5, opts = { fluids: false }) {
    const len = Math.hypot(dx, dy, dz);
    if (!(len > 1e-9) || !(maxDist > 0)) return null;
    dx /= len; dy /= len; dz /= len;

    const fluids = !!(opts && opts.fluids);
    const solidOnly = !!(opts && opts.solidOnly);
    const filter = opts && typeof opts.filter === 'function' ? opts.filter : null;

    let x = flr(ox), y = flr(oy), z = flr(oz);
    const stepX = dx > 0 ? 1 : dx < 0 ? -1 : 0;
    const stepY = dy > 0 ? 1 : dy < 0 ? -1 : 0;
    const stepZ = dz > 0 ? 1 : dz < 0 ? -1 : 0;
    const tDeltaX = stepX !== 0 ? Math.abs(1 / dx) : Infinity;
    const tDeltaY = stepY !== 0 ? Math.abs(1 / dy) : Infinity;
    const tDeltaZ = stepZ !== 0 ? Math.abs(1 / dz) : Infinity;
    let tMaxX = stepX > 0 ? (x + 1 - ox) / dx : stepX < 0 ? (x - ox) / dx : Infinity;
    let tMaxY = stepY > 0 ? (y + 1 - oy) / dy : stepY < 0 ? (y - oy) / dy : Infinity;
    let tMaxZ = stepZ > 0 ? (z + 1 - oz) / dz : stepZ < 0 ? (z - oz) / dz : Infinity;

    let t = 0;
    let guard = Math.ceil(maxDist * 3) + 8;
    while (t <= maxDist && guard-- > 0) {
      if (y >= 0 && y < WORLD_HEIGHT) {
        const v = this.getRaw(x, y, z);
        const id = v & ID_MASK;
        if (id !== 0) {
          const def = getBlock(id);
          const meta = (v >>> 12) & 15;
          let testable;
          if (filter) testable = !!filter(id, meta, x, y, z);
          else if (def.liquid) testable = fluids;
          else if (def.collision === 'none') testable = !solidOnly;
          else testable = true;
          if (testable) {
            const boxes = boxesFor(id, meta, x, y, z);
            let bestT = Infinity, bestAxis = -1, bestSgn = -1;
            for (let i = 0; i < boxes.length; i++) {
              if (!rayBoxFace(ox, oy, oz, dx, dy, dz, boxes[i], RAY_SCRATCH)) continue;
              if (RAY_SCRATCH.t < bestT) {
                bestT = RAY_SCRATCH.t; bestAxis = RAY_SCRATCH.axis; bestSgn = RAY_SCRATCH.sgn;
              }
            }
            if (bestAxis >= 0 && bestT <= maxDist) {
              const face = FACE_FROM_AXIS[bestAxis][bestSgn > 0 ? 1 : 0];
              const dir = FACE_DIRS[face];
              return {
                x, y, z,
                face,
                faceName: FACE_NAMES[face],
                nx: dir[0], ny: dir[1], nz: dir[2],
                blockId: id,
                meta,
                px: ox + dx * bestT,
                py: oy + dy * bestT,
                pz: oz + dz * bestT,
                distance: bestT,
              };
            }
          }
        }
      }
      // Advance to the next voxel boundary.
      if (tMaxX < tMaxY) {
        if (tMaxX < tMaxZ) { x += stepX; t = tMaxX; tMaxX += tDeltaX; }
        else { z += stepZ; t = tMaxZ; tMaxZ += tDeltaZ; }
      } else if (tMaxY < tMaxZ) {
        y += stepY; t = tMaxY; tMaxY += tDeltaY;
      } else {
        z += stepZ; t = tMaxZ; tMaxZ += tDeltaZ;
      }
      if (!isFinite(t)) break;
    }
    return null;
  }

  /**
   * First entity hit along a ray. Used together with raycast() for targeting.
   * @returns {null|{entity:object, distance:number}}
   */
  raycastEntity(ox, oy, oz, dx, dy, dz, maxDist = 5, filter = null) {
    const len = Math.hypot(dx, dy, dz);
    if (!(len > 1e-9)) return null;
    dx /= len; dy /= len; dz /= len;
    const pad = 0.3;
    const box = new AABB(
      Math.min(ox, ox + dx * maxDist) - pad, Math.min(oy, oy + dy * maxDist) - pad,
      Math.min(oz, oz + dz * maxDist) - pad, Math.max(ox, ox + dx * maxDist) + pad,
      Math.max(oy, oy + dy * maxDist) + pad, Math.max(oz, oz + dz * maxDist) + pad,
    );
    const list = this.entitiesInAABB(box, filter);
    let best = null, bestT = maxDist;
    const scratch = new AABB();
    for (let i = 0; i < list.length; i++) {
      const e = list[i];
      const b = entityBox(e, scratch).clone().expand(0.1, 0.1, 0.1);
      if (!rayBoxFace(ox, oy, oz, dx, dy, dz, b, RAY_SCRATCH)) continue;
      if (RAY_SCRATCH.t < bestT) { bestT = RAY_SCRATCH.t; best = e; }
    }
    return best ? { entity: best, distance: bestT } : null;
  }

  /**
   * Every block collision box overlapping a bounding box, in world space.
   * @returns {AABB[]}
   */
  getCollisionBoxes(box, out = []) {
    const x0 = flr(box.x0), x1 = flr(box.x1);
    const y0 = flr(box.y0), y1 = flr(box.y1);
    const z0 = flr(box.z0), z1 = flr(box.z1);
    for (let y = y0; y <= y1; y++) {
      if (y < 0 || y >= WORLD_HEIGHT) continue;
      for (let z = z0; z <= z1; z++) {
        for (let x = x0; x <= x1; x++) {
          const v = this.getRaw(x, y, z);
          const id = v & ID_MASK;
          if (id === 0) continue;
          const def = getBlock(id);
          if (!def.solid || def.collision === 'none') continue;
          const boxes = boxesFor(id, (v >>> 12) & 15, x, y, z);
          for (let i = 0; i < boxes.length; i++) {
            const b = boxes[i];
            if (b.x0 < box.x1 && b.x1 > box.x0 && b.y0 < box.y1 && b.y1 > box.y0 &&
                b.z0 < box.z1 && b.z1 > box.z0) out.push(b);
          }
        }
      }
    }
    return out;
  }

  // =========================================================================
  // Scheduled ticks (min-heap keyed on due time)
  // =========================================================================

  /**
   * Queues a scheduled block tick. `id` is the block expected to still be
   * there when it fires; a mismatch quietly cancels the tick.
   */
  scheduleTick(x, y, z, delayTicks, id) {
    x = flr(x); y = flr(y); z = flr(z);
    if (y < 0 || y >= WORLD_HEIGHT) return false;
    const key = x + ',' + y + ',' + z + ',' + (id | 0);
    if (this._scheduledKeys.has(key)) return false;
    this._scheduledKeys.add(key);
    const item = { x, y, z, id: id | 0, due: this.totalTime + Math.max(1, delayTicks | 0), key };
    const heap = this._scheduled;
    heap.push(item);
    let i = heap.length - 1;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (heap[i].due >= heap[p].due) break;
      const tmp = heap[i]; heap[i] = heap[p]; heap[p] = tmp;
      i = p;
    }
    return true;
  }

  /** True when this exact tick is already queued. */
  isTickScheduled(x, y, z, id) {
    return this._scheduledKeys.has(flr(x) + ',' + flr(y) + ',' + flr(z) + ',' + (id | 0));
  }

  _popScheduled() {
    const heap = this._scheduled;
    const top = heap[0];
    const last = heap.pop();
    if (heap.length > 0) {
      heap[0] = last;
      let i = 0;
      for (;;) {
        const l = 2 * i + 1, r = l + 1;
        let m = i;
        if (l < heap.length && heap[l].due < heap[m].due) m = l;
        if (r < heap.length && heap[r].due < heap[m].due) m = r;
        if (m === i) break;
        const tmp = heap[i]; heap[i] = heap[m]; heap[m] = tmp;
        i = m;
      }
    }
    this._scheduledKeys.delete(top.key);
    return top;
  }

  /** Fires every scheduled tick that has come due. */
  _runScheduledTicks() {
    const heap = this._scheduled;
    let n = 0;
    while (heap.length > 0 && heap[0].due <= this.totalTime && n < MAX_SCHEDULED_TICKS) {
      const item = this._popScheduled();
      n++;
      const cur = this.getBlock(item.x, item.y, item.z);
      if (item.id > 0 && cur !== item.id) continue;     // block changed; cancel
      if (!this.chunkAt(item.x, item.z)) continue;      // chunk unloaded
      if (_blockupdate && typeof _blockupdate.scheduledTick === 'function') {
        try {
          _blockupdate.scheduledTick(this, item.x, item.y, item.z, cur);
        } catch (e) {
          console.error('[world] scheduledTick failed', item.x, item.y, item.z, e);
        }
      }
    }
    return n;
  }

  // =========================================================================
  // Time, weather and the main tick
  // =========================================================================

  /** True during the vanilla daylight window. */
  isDay() {
    const t = this.time % 24000;
    return t < 12542 || t > 23460;
  }

  /** True when mobs may spawn in the open. */
  isNight() { return !this.isDay(); }

  /**
   * 0..1 multiplier applied to stored sky light, with smooth dawn/dusk ramps
   * and a dip while it rains or thunders.
   */
  skyLightFactor() {
    if (this.dimension === DIM_NETHER) return 0;
    if (this.dimension === DIM_END) return 0.5;
    const frac = ((this.time % 24000) + 24000) % 24000 / 24000;
    // Vanilla's celestial angle: a slightly eased version of the raw fraction.
    let a = frac - 0.25;
    if (a < 0) a += 1;
    const angle = a + ((1 - Math.cos(a * Math.PI)) / 2 - a) / 3;
    // 0 at noon, 1 in the dead of night.
    const darkness = clamp(1 - (Math.cos(angle * Math.PI * 2) * 2 + 0.5), 0, 1);
    let f = 1 - darkness * (11 / 15);           // night floors out at 4/15
    const w = this.weather;
    f *= 1 - w.rain * 0.3125;
    f *= 1 - w.thunder * 0.3125;
    return clamp(f, 0, 1);
  }

  /** Sets the day time, keeping it inside 0..23999. */
  setTime(t) {
    this.time = ((flr(t) % 24000) + 24000) % 24000;
  }

  /** Starts or stops rain immediately. */
  setRaining(on, ticks = 12000) {
    const w = this.weather;
    w.raining = !!on;
    w.rainTicks = Math.max(1, ticks | 0);
    if (!on) { w.thundering = false; w.thunderTicks = Math.max(w.thunderTicks, ticks); }
  }

  /** Starts or stops a thunderstorm (implies rain). */
  setThundering(on, ticks = 12000) {
    const w = this.weather;
    w.thundering = !!on;
    w.thunderTicks = Math.max(1, ticks | 0);
    if (on) { w.raining = true; w.rainTicks = Math.max(w.rainTicks, ticks); }
  }

  /** True when rain is falling at this column (dimension + biome aware). */
  isRainingAt(x, y, z) {
    if (this.weather.rain <= 0.05) return false;
    if (this.dimension !== DIM_OVERWORLD) return false;
    if (!this.canSeeSky(x, y, z)) return false;
    const b = this.biomeAt(x, z);
    if (!b || b.precipitation === 'none') return false;
    if (b.precipitation === 'snow') return false;   // snow, not rain
    return this.getTopSolid(x, z) < flr(y);
  }

  _tickWeather() {
    const w = this.weather;
    if (this.dimension !== DIM_OVERWORLD) {
      w.rain = 0; w.thunder = 0; w.raining = false; w.thundering = false;
      return;
    }
    if (this.gameRules.doWeatherCycle) {
      if (--w.rainTicks <= 0) {
        w.raining = !w.raining;
        // Vanilla: 0.5-10 minutes of rain, 10-140 minutes of clear sky.
        w.rainTicks = w.raining ? this.rng.range(12000, 24000) : this.rng.range(12000, 180000);
      }
      if (--w.thunderTicks <= 0) {
        w.thundering = !w.thundering;
        w.thunderTicks = w.thundering ? this.rng.range(3600, 15600) : this.rng.range(12000, 180000);
      }
    }
    const rainTarget = w.raining ? 1 : 0;
    const thunderTarget = (w.raining && w.thundering) ? 1 : 0;
    w.rain = approach(w.rain, rainTarget, 0.01);
    w.thunder = approach(w.thunder, thunderTarget, 0.01);
    if (this.lightningTicks > 0) this.lightningTicks--;
    if (w.thunder > 0.1 && w.rain > 0.1) this._tickLightning();
  }

  /** Rolls for lightning strikes near the players during a thunderstorm. */
  _tickLightning() {
    const players = this.getPlayers();
    if (players.length === 0) return;
    // Vanilla rolls 1/100000 per loaded chunk per tick.
    const chunks = Math.min(this.chunks.size, 1024);
    if (this.rng.next() > (chunks * this.weather.thunder) / 100000) return;
    const p = players[this.rng.int(players.length)];
    const cx = (flr(p.x) >> 4) + this.rng.range(-6, 6);
    const cz = (flr(p.z) >> 4) + this.rng.range(-6, 6);
    const c = this._chunkFor(cx, cz);
    if (!c || !c.generated) return;
    const lx = this.rng.int(16), lz = this.rng.int(16);
    const x = (cx << 4) + lx, z = (cz << 4) + lz;
    const y = this.getTopSolid(x, z) + 1;
    if (y <= 0 || y >= WORLD_HEIGHT) return;
    const biome = this.biomeAt(x, z);
    if (biome && biome.precipitation === 'none') return;
    this.strikeLightning(x, y, z);
  }

  /**
   * Spawns a lightning bolt: fire, damage, mob conversions and the odd
   * skeleton horse trap on hard difficulty.
   */
  strikeLightning(x, y, z, effectOnly = false) {
    x = flr(x); y = clamp(flr(y), 0, WORLD_HEIGHT - 1); z = flr(z);
    this.lightningTicks = 8;
    Game.emit('lightning', x, y, z, this);
    try { Game.audio?.playAt?.('thunder', x, y, z, 1, 0.8 + this.rng.next() * 0.4); } catch { /* optional */ }
    try { Game.particles?.spawn?.('flame', x + 0.5, y + 0.5, z + 0.5, { count: 12, spread: 0.6 }); } catch { /* optional */ }
    if (effectOnly) return;

    // Fire on the ground when the rules allow it.
    if (this.gameRules.doFireTick && this.gameRules.mobGriefing && FIRE_ID) {
      if (this.getBlock(x, y, z) === 0 && blockIsSolid(this.getBlock(x, y - 1, z))) {
        this.setBlock(x, y, z, FIRE_ID, 0, 3);
      }
    }

    const hit = this.entitiesNear(x, y, z, 3.5);
    for (let i = 0; i < hit.length; i++) {
      const e = hit[i];
      const converted = this._convertOnLightning(e);
      if (converted) continue;
      try { e.hurt?.(5, { type: 'lightning', fire: false, magic: false, entity: null }); } catch { /* optional */ }
      if (e.fireTicks !== undefined) e.fireTicks = Math.max(e.fireTicks, 160);
    }

    // Skeleton horse traps: hard difficulty only, and rarely.
    if (Game.difficulty === DIFFICULTY.HARD && this.rng.next() < 0.1) {
      this._spawnMob('skeleton_horse', x + 0.5, y, z + 0.5);
    }
  }

  /** Applies lightning's mob transformations. Returns true when handled. */
  _convertOnLightning(e) {
    const t = e && e.type;
    if (!t) return false;
    if (t === 'creeper') { e.charged = true; e.powered = true; return true; }
    if (t === 'pig') return !!this._replaceMob(e, 'zombified_piglin');
    if (t === 'villager') return !!this._replaceMob(e, 'witch');
    if (t === 'mooshroom') { e.variant = e.variant === 'brown' ? 'red' : 'brown'; return true; }
    if (t === 'turtle') return false;
    return false;
  }

  /** Creates a mob through mobs.js, if that module is available. */
  _spawnMob(name, x, y, z, opts) {
    if (!_mobs || typeof _mobs.createMob !== 'function') return null;
    try {
      const m = _mobs.createMob(name, this, x, y, z, opts || {});
      if (m && !this.entitiesById.has(m.id)) this.addEntity(m);
      return m;
    } catch (e) {
      console.error('[world] createMob failed', name, e);
      return null;
    }
  }

  /** Swaps one mob for another at the same spot (lightning transformations). */
  _replaceMob(old, name) {
    const m = this._spawnMob(name, old.x, old.y, old.z);
    if (!m) return null;
    m.yaw = old.yaw; m.pitch = old.pitch;
    if (old.baby !== undefined) m.baby = old.baby;
    this.removeEntity(old);
    return m;
  }

  // ---- random ticks -------------------------------------------------------

  _runRandomTicks() {
    const speed = this.randomTickSpeed | 0;
    if (speed <= 0) return 0;
    if (!_blockupdate || typeof _blockupdate.randomTick !== 'function') return 0;
    const players = this.getPlayers();
    if (players.length === 0) return 0;
    const rng = this.rng;
    let calls = 0;
    for (const c of this.chunks.values()) {
      if (calls >= MAX_RANDOM_TICKS) break;
      if (!c.generated || c.empty) continue;
      let near = false;
      for (let i = 0; i < players.length; i++) {
        const dx = c.cx - (flr(players[i].x) >> 4);
        const dz = c.cz - (flr(players[i].z) >> 4);
        if (dx * dx + dz * dz <= SIMULATION_RADIUS * SIMULATION_RADIUS) { near = true; break; }
      }
      if (!near) continue;
      const ox = c.cx << 4, oz = c.cz << 4;
      for (let s = 0; s < SECTION_COUNT; s++) {
        if (c.sectionCounts[s] === 0) continue;
        for (let i = 0; i < speed; i++) {
          const r = (rng.next() * 0xffffff) | 0;
          const lx = r & 15, lz = (r >> 4) & 15, ly = (s << 4) | ((r >> 8) & 15);
          calls++;
          try {
            _blockupdate.randomTick(this, c, rng, ox + lx, ly, oz + lz);
          } catch (e) {
            console.error('[world] randomTick failed', e);
            return calls;
          }
        }
      }
    }
    return calls;
  }

  // ---- entities -----------------------------------------------------------

  _tickEntities() {
    const list = this.entities;
    for (let i = 0; i < list.length; i++) {
      const e = list[i];
      if (e.removed) continue;
      try {
        if (typeof e.tick === 'function') e.tick();
      } catch (err) {
        console.error('[world] entity tick failed', e.type, err);
      }
      if (e.removed) { this._removedCount++; continue; }
      this.onEntityMoved(e);
    }
  }

  _tickSpawning() {
    if (!this.gameRules.doMobSpawning) return;
    if (!_spawning) return;
    const player = this.nearestPlayer(this.spawnPoint.x, this.spawnPoint.y, this.spawnPoint.z) || this.getPlayers()[0];
    if (!player) return;
    if (this._spawnTimer <= 0) {
      this._spawnTimer = 20;
      if (typeof _spawning.trySpawnMobs === 'function') {
        try { _spawning.trySpawnMobs(this, player); } catch (e) { console.error('[world] trySpawnMobs failed', e); }
      }
    }
    if (this._despawnTimer <= 0) {
      this._despawnTimer = 40;
      if (typeof _spawning.despawnCheck === 'function') {
        try { _spawning.despawnCheck(this, player); } catch (e) { console.error('[world] despawnCheck failed', e); }
      }
    }
  }

  /** Keeps the chunks around every player queued and prunes the far ones. */
  _tickStreaming() {
    if (this._streamTimer > 0) return;
    this._streamTimer = 10;
    let dist = DEFAULT_RENDER_DISTANCE;
    try {
      const v = Game.settings?.get?.('renderDistance');
      if (typeof v === 'number' && v > 0) dist = v | 0;
    } catch { /* optional */ }
    const players = this.getPlayers();
    for (let i = 0; i < players.length; i++) {
      const p = players[i];
      this.requestArea(flr(p.x) >> 4, flr(p.z) >> 4, dist);
    }
    if (this._pruneTimer <= 0) {
      this._pruneTimer = 20;
      // Walking across a chunk border strands a whole row of chunks, so the
      // unload budget has to outpace the streaming radius.
      this.pruneChunks(dist + 3, 32);
    }
  }

  /**
   * One 1/20s simulation step: time, weather, scheduled and random ticks,
   * entities, mob spawning and the block-update driver.
   * @param {number} dt seconds represented by this tick (1/20 normally)
   */
  tick(dt = 0.05) {
    this.totalTime++;
    if (this.gameRules.doDaylightCycle) {
      this.time = (this.time + 1) % 24000;
    }
    if (this._streamTimer > 0) this._streamTimer--;
    if (this._spawnTimer > 0) this._spawnTimer--;
    if (this._despawnTimer > 0) this._despawnTimer--;
    if (this._pruneTimer > 0) this._pruneTimer--;

    this._tickWeather();
    this._runScheduledTicks();
    this._runRandomTicks();

    if (_blockupdate && typeof _blockupdate.tickWorldBlocks === 'function') {
      try { _blockupdate.tickWorldBlocks(this, dt); } catch (e) { console.error('[world] tickWorldBlocks failed', e); }
    }
    if (_redstone && typeof _redstone.tickRedstone === 'function') {
      try { _redstone.tickRedstone(this); } catch (e) { console.error('[world] tickRedstone failed', e); }
    }

    this._tickEntities();
    this._tickSpawning();
    this._tickStreaming();
    this._reapEntities();
  }

  // =========================================================================
  // Misc
  // =========================================================================

  /** Loaded chunk count. */
  get chunkCount() { return this.chunks.size; }

  /** Rough memory/entity snapshot for the F3 overlay. */
  debugInfo() {
    return {
      dimension: this.dimension,
      chunks: this.chunks.size,
      pending: this._pending.length,
      entities: this.entities.length,
      scheduled: this._scheduled.length,
      time: this.time,
      rain: this.weather.rain,
      thunder: this.weather.thunder,
    };
  }

  /** Drops every chunk and entity (used when switching or closing a world). */
  clear() {
    for (const c of this.chunks.values()) {
      try { Game.chunkRenderer?.removeChunk?.(c.cx, c.cz); } catch { /* optional */ }
    }
    this.chunks.clear();
    this._invalidateChunkMemo();
    this.entities.length = 0;
    this.entitiesById.clear();
    this._entityCells.clear();
    this._scheduled.length = 0;
    this._scheduledKeys.clear();
    this._pending.length = 0;
    this._pendingMap.clear();
    this._removedCount = 0;
  }
}

// ---------------------------------------------------------------------------
// Module-level helpers
// ---------------------------------------------------------------------------

/** Builds a generator: worldgen.js when it is loaded, else the stand-in. */
function createFallbackGenerator(seed, dimension) {
  if (_worldgen && typeof _worldgen.createGenerator === 'function') {
    try {
      const g = _worldgen.createGenerator(seed, dimension);
      if (g && typeof g.generateChunk === 'function') return g;
    } catch (e) {
      console.error('[world] createGenerator failed', e);
    }
  }
  return new FallbackGenerator(seed, dimension);
}

/**
 * Convenience constructor used by main.js, save.js and the console: makes a
 * World with the right generator for `dimension`.
 */
export function createWorld(seed, dimension = DIM_OVERWORLD) {
  const s = typeof seed === 'string' ? hash3(0, seed.length, 1, 2) : (seed >>> 0);
  return new World({ seed: s, dimension, generator: createFallbackGenerator(s, dimension) });
}

/**
 * Lowest y at which an entity of standing height 2 can be placed in a column:
 * solid non-liquid floor below, two passable blocks above. -1 when none exists.
 */
export function getSpawnableY(world, x, z) {
  x = flr(x); z = flr(z);
  const top = clamp(world.getHeight(x, z) + 1, 1, WORLD_HEIGHT - 2);
  for (let y = top; y >= 1; y--) {
    const below = world.getBlock(x, y - 1, z);
    if (below === 0) continue;
    const bd = getBlock(below);
    if (!bd.solid || bd.liquid || bd.collision === 'none') continue;
    if (bd.name === 'lava' || bd.name === 'fire' || bd.name === 'magma_block' ||
        bd.name === 'cactus' || bd.name === 'campfire') continue;
    const a = world.getBlock(x, y, z);
    const b = world.getBlock(x, y + 1, z);
    if (isPassable(a) && isPassable(b) && !blockIsLiquid(a) && !blockIsLiquid(b)) return y;
  }
  return -1;
}

export default World;
