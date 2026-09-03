// ============================================================================
// lighting.js - Sky + block light propagation.
//
// Two independent 4-bit channels live in `chunk.light`: (sky << 4) | block.
// Both are flood filled with explicit BFS queues (see LightQueue below); there
// is no recursion anywhere in this file, so a lava lake next to a cave system
// cannot blow the JS stack.
//
// Propagation rules (Minecraft 1.20 behaviour):
//
//   * Entering a block costs `max(1, filter)` light levels, where `filter` is
//     the block's light absorption (15 for anything opaque). So air and glass
//     cost 1, ice costs 3, water costs 1, stone swallows everything.
//   * Sky light is the exception in exactly one direction: a cell holding the
//     full 15 pours straight down into a block that absorbs nothing at all
//     with NO attenuation. That is what makes a sunlit shaft stay bright all
//     the way to bedrock while a cell lit sideways (<= 14) fades with depth.
//     Sideways and upward sky light always pays the normal cost, which is why
//     it gets dark under an overhang.
//   * Removal is the classic two phase algorithm: unset the region the source
//     used to own, collecting every cell whose light survived the sweep, then
//     re-propagate from those survivors. Emitters found inside the erased
//     region put themselves straight back into the add queue.
//
// Work is queued, not performed, by the mutators. `processLightQueue()` drains
// with a millisecond budget so a 500-block explosion cannot stall a frame; the
// chunks whose light actually changed are marked dirty when the drain stops so
// the mesher only rebuilds what moved.
//
// Chunks that are not loaded yet are simply skipped. Their coordinates are
// remembered in a pending set, and `relightChunkBorders()` re-seeds both sides
// of every shared face when the chunk finally shows up.
// ============================================================================

import { WORLD_HEIGHT, ID_MASK, MAX_LIGHT, MAX_BLOCK_ID } from '../core/constants.js';
import { BLOCKS } from './blocks.js';

// Face order matches FACE_* in constants.js: down, up, north, south, west, east.
const DX = new Int8Array([0, 0, 0, 0, -1, 1]);
const DY = new Int8Array([-1, 1, 0, 0, 0, 0]);
const DZ = new Int8Array([0, 0, -1, 1, 0, 0]);
const F_DOWN = 0;

/** Light spread never crosses these; kept as a local alias for speed. */
const OPAQUE = 15;

/** Milliseconds a chunk's initial light pass may spend draining the queues. */
const INIT_DRAIN_MS = 10;
/** Milliseconds spent inline by updateLight when the backlog is small. */
const INLINE_DRAIN_MS = 2;
/** Above this many queued cells, updateLight defers everything to the driver. */
const INLINE_QUEUE_LIMIT = 6000;
/** Queue capacity kept between bursts; anything larger is released when idle. */
const QUEUE_IDLE_CAP = 8192;

const nowMs = (typeof performance !== 'undefined' && performance && performance.now)
  ? () => performance.now()
  : () => Date.now();

// ---------------------------------------------------------------------------
// Per-block lookup tables
//
// The registry is a few hundred plain objects; chasing `.opaque` / `.filter`
// per neighbour visit costs more than the flood fill itself. Everything the
// inner loops need is flattened into typed arrays indexed by block id. The
// tables are sized to the whole id space so no bounds check is ever needed on
// a value read out of a chunk, however corrupt.
// ---------------------------------------------------------------------------

const TABLE_SIZE = MAX_BLOCK_ID + 1;
/** Light levels absorbed by the block, 0..15 (15 = fully opaque). */
const FILTER = new Uint8Array(TABLE_SIZE);
/** Cost to enter the block: max(1, FILTER). */
const COST = new Uint8Array(TABLE_SIZE);
/** 1 when full-strength sky light falls through the block untouched. */
const SKY_FREE = new Uint8Array(TABLE_SIZE);
/** Constant light emission, 0..15. */
const EMIT = new Uint8Array(TABLE_SIZE);
/** Emission of the "lit" metadata variant, or -1 when the block has none. */
const LIT_LIGHT = new Int8Array(TABLE_SIZE);
/** Metadata bit that selects the lit variant. */
const LIT_BIT = new Uint8Array(TABLE_SIZE);

// Blocks with filter 0 that are nevertheless solid enough to break the sunlit
// column. Vanilla gives all of these an opacity of 1: they cost a light level
// like air, but they stop the free vertical fall, so a slab roof or a shut
// trapdoor actually shades the room underneath.
const SKY_OCCLUDING_MODELS = new Set([
  'slab', 'stairs', 'door', 'trapdoor', 'chest', 'piston', 'piston_head',
  'anvil', 'hopper', 'cauldron', 'bed', 'farmland', 'path', 'layer', 'carpet',
  'cactus',
]);

let tableLength = -1;

/** (Re)builds the block lookup tables when the registry has grown. */
function ensureTables() {
  if (tableLength === BLOCKS.length) return;
  FILTER.fill(0);
  COST.fill(1);
  SKY_FREE.fill(1);
  EMIT.fill(0);
  LIT_LIGHT.fill(-1);
  LIT_BIT.fill(0);
  for (let id = 0; id < BLOCKS.length && id < TABLE_SIZE; id++) {
    const d = BLOCKS[id];
    if (!d) continue;                       // registry hole: behaves like air
    let f = d.opaque ? OPAQUE : (d.filter | 0);
    if (f < 0) f = 0; else if (f > OPAQUE) f = OPAQUE;
    FILTER[id] = f;
    COST[id] = f < 1 ? 1 : f;
    SKY_FREE[id] = f === 0 && !SKY_OCCLUDING_MODELS.has(d.model) ? 1 : 0;
    let e = d.light | 0;
    if (e < 0) e = 0; else if (e > MAX_LIGHT) e = MAX_LIGHT;
    EMIT[id] = e;
    if (d.litLight !== null && d.litLight !== undefined) {
      let lv = d.litLight | 0;
      if (lv < 0) lv = 0; else if (lv > MAX_LIGHT) lv = MAX_LIGHT;
      LIT_LIGHT[id] = lv;
      LIT_BIT[id] = (d.litBit | 0) & 15;
    }
  }
  tableLength = BLOCKS.length;
}

/**
 * Emission of a packed block value, honouring lit metadata variants
 * (redstone lamps, lit furnaces, glow berries).
 */
function emissionOf(value) {
  const id = value & ID_MASK;
  const lit = LIT_LIGHT[id];
  if (lit >= 0 && (((value >>> 12) & 15) & LIT_BIT[id]) !== 0) return lit;
  return EMIT[id];
}

// ---------------------------------------------------------------------------
// Queue
// ---------------------------------------------------------------------------

/**
 * A growable FIFO of (x, y, z, level) tuples backed by one Int32Array ring
 * buffer. Packing world coordinates into a single word is impossible (x and z
 * are unbounded), so four slots per entry it is - still allocation free once
 * the buffer has grown to the working set.
 */
class LightQueue {
  /** @param {number} capacity initial number of entries (rounded up to 2^n) */
  constructor(capacity = 1024) {
    let cap = 16;
    while (cap < capacity) cap <<= 1;
    this.cap = cap;
    this.mask = cap - 1;
    this.buf = new Int32Array(cap * 4);
    this.head = 0;
    this.tail = 0;
    this.count = 0;
    // Fields written by pop(); reading them avoids allocating a result object.
    this.px = 0; this.py = 0; this.pz = 0; this.pv = 0;
  }

  /** Number of queued entries. */
  get size() { return this.count; }

  /** Appends one cell. */
  push(x, y, z, v) {
    if (this.count === this.cap) this._grow();
    const i = (this.tail & this.mask) << 2;
    const b = this.buf;
    b[i] = x; b[i + 1] = y; b[i + 2] = z; b[i + 3] = v;
    this.tail = (this.tail + 1) & 0x3fffffff;
    this.count++;
  }

  /** Pops into px/py/pz/pv. Returns false when empty. */
  pop() {
    if (this.count === 0) return false;
    const i = (this.head & this.mask) << 2;
    const b = this.buf;
    this.px = b[i]; this.py = b[i + 1]; this.pz = b[i + 2]; this.pv = b[i + 3];
    this.head = (this.head + 1) & 0x3fffffff;
    this.count--;
    return true;
  }

  /** Drops every entry without releasing the buffer. */
  clear() { this.head = 0; this.tail = 0; this.count = 0; }

  /** Releases an oversized buffer once the burst that needed it is over. */
  trim() {
    if (this.count === 0 && this.cap > QUEUE_IDLE_CAP) {
      this.cap = QUEUE_IDLE_CAP;
      this.mask = this.cap - 1;
      this.buf = new Int32Array(this.cap * 4);
      this.head = 0; this.tail = 0;
    }
  }

  _grow() {
    const ncap = this.cap << 1;
    const nb = new Int32Array(ncap * 4);
    for (let k = 0; k < this.count; k++) {
      const si = ((this.head + k) & this.mask) << 2;
      const di = k << 2;
      nb[di] = this.buf[si];
      nb[di + 1] = this.buf[si + 1];
      nb[di + 2] = this.buf[si + 2];
      nb[di + 3] = this.buf[si + 3];
    }
    this.buf = nb;
    this.cap = ncap;
    this.mask = ncap - 1;
    this.head = 0;
    this.tail = this.count;
  }
}

// ---------------------------------------------------------------------------
// Per-world state
// ---------------------------------------------------------------------------

// Kept off the World object so nothing here shows up in a save file and two
// worlds (overworld + nether) never share a queue.
const STATES = new WeakMap();

/** Lazily creates the queue set for a world. */
function getState(world) {
  let st = STATES.get(world);
  if (!st) {
    st = {
      skyAdd: new LightQueue(2048),
      skyRemove: new LightQueue(512),
      blockAdd: new LightQueue(1024),
      blockRemove: new LightQueue(512),
      // chunk -> border mask (1 -x, 2 +x, 4 -z, 8 +z) of the faces touched
      touched: new Map(),
      lastChunk: null,
      lastMask: 0,
      // chunk keys the flood wanted to enter but that are not loaded yet
      pending: new Set(),
      work: 0,
    };
    STATES.set(world, st);
  }
  return st;
}

/** True when any channel still has queued work. */
function hasWork(st) {
  return st.blockRemove.count > 0 || st.blockAdd.count > 0
    || st.skyRemove.count > 0 || st.skyAdd.count > 0;
}

// ---------------------------------------------------------------------------
// Chunk lookup with a small direct-mapped cache
// ---------------------------------------------------------------------------

const CACHE_MASK = 15;
const cacheCx = new Int32Array(16);
const cacheCz = new Int32Array(16);
const cacheChunk = new Array(16).fill(null);
let cacheWorld = null;

/** Drops the chunk cache. Called whenever the loaded set may have changed. */
function invalidateCache() {
  cacheWorld = null;
  for (let i = 0; i < 16; i++) { cacheCx[i] = 0x7fffffff; cacheChunk[i] = null; }
}
invalidateCache();

/** Raw chunk lookup that tolerates a partially built World. */
function lookupChunk(world, cx, cz) {
  if (!world) return null;
  let c = null;
  if (typeof world.getChunk === 'function') c = world.getChunk(cx, cz, false);
  else if (world.chunks && typeof world.chunks.get === 'function') c = world.chunks.get(cx + ',' + cz);
  if (!c) return null;
  // A chunk object that exists but holds no terrain yet is treated as absent:
  // lighting it would be thrown away by initSkyLight the moment it generates.
  if (c.generated === false && c.empty) return null;
  return c;
}

/** Cached chunk lookup by chunk coordinates. Returns null when not loaded. */
function chunkAt(world, cx, cz) {
  if (world !== cacheWorld) { invalidateCache(); cacheWorld = world; }
  const h = ((cx * 31) ^ (cz * 17)) & CACHE_MASK;
  if (cacheCx[h] === cx && cacheCz[h] === cz) return cacheChunk[h];
  const c = lookupChunk(world, cx, cz);
  cacheCx[h] = cx;
  cacheCz[h] = cz;
  cacheChunk[h] = c;
  return c;
}

/** Packs chunk coordinates into a non-negative number for the pending set. */
const chunkKeyNum = (cx, cz) => (((cx + 0x8000) & 0xffff) * 0x10000) + ((cz + 0x8000) & 0xffff);

/** Remembers that light wanted to enter a chunk that is not loaded. */
function notePending(st, cx, cz) {
  if (st.pending.size < 4096) st.pending.add(chunkKeyNum(cx, cz));
}

// ---------------------------------------------------------------------------
// Dirty tracking
// ---------------------------------------------------------------------------

/**
 * Records that `chunk` changed, plus which of its borders were touched. The
 * single-entry write-behind makes the common case (thousands of writes into
 * the same chunk) a pointer compare instead of a Map hash.
 */
function touchChunk(st, chunk, mask) {
  chunk.dirty = true;
  if (chunk === st.lastChunk) { st.lastMask |= mask; return; }
  commitTouch(st);
  st.lastChunk = chunk;
  st.lastMask = mask;
}

/** Flushes the write-behind slot into the touched map. */
function commitTouch(st) {
  const c = st.lastChunk;
  if (!c) return;
  const prev = st.touched.get(c) || 0;
  st.touched.set(c, prev | st.lastMask);
  st.lastChunk = null;
  st.lastMask = 0;
}

/** touchChunk() for a write at local coordinates, deriving the border mask. */
function markLocal(st, chunk, lx, lz) {
  let m = 0;
  if (lx === 0) m = 1; else if (lx === 15) m = 2;
  if (lz === 0) m |= 4; else if (lz === 15) m |= 8;
  touchChunk(st, chunk, m);
}

/** Marks one neighbouring chunk for a remesh (its smooth light sampled ours). */
function dirtyNeighbor(world, cx, cz) {
  if (world && typeof world._dirtyChunk === 'function') { world._dirtyChunk(cx, cz); return; }
  const c = chunkAt(world, cx, cz);
  if (c) c.dirty = true;
}

/**
 * Marks every chunk whose light changed since the last flush, together with
 * the neighbours that share a touched border (their vertex light samples
 * across the seam, so they have to be rebuilt too).
 * @returns {number} chunks marked
 */
function flushDirty(world, st) {
  commitTouch(st);
  if (st.touched.size === 0) return 0;
  let n = 0;
  for (const entry of st.touched) {
    const c = entry[0];
    const m = entry[1];
    c.dirty = true;
    n++;
    if (world && typeof world._notifyRenderer === 'function') world._notifyRenderer(c.cx, c.cz);
    if (!m) continue;
    const cx = c.cx, cz = c.cz;
    if (m & 1) dirtyNeighbor(world, cx - 1, cz);
    if (m & 2) dirtyNeighbor(world, cx + 1, cz);
    if (m & 4) dirtyNeighbor(world, cx, cz - 1);
    if (m & 8) dirtyNeighbor(world, cx, cz + 1);
    if ((m & 1) && (m & 4)) dirtyNeighbor(world, cx - 1, cz - 1);
    if ((m & 1) && (m & 8)) dirtyNeighbor(world, cx - 1, cz + 1);
    if ((m & 2) && (m & 4)) dirtyNeighbor(world, cx + 1, cz - 1);
    if ((m & 2) && (m & 8)) dirtyNeighbor(world, cx + 1, cz + 1);
  }
  st.touched.clear();
  return n;
}

// ---------------------------------------------------------------------------
// Cell helpers
// ---------------------------------------------------------------------------

/** Local index inside a chunk for world x/y/z. */
const cellIndex = (x, y, z) => (y << 8) | ((z & 15) << 4) | (x & 15);

// ---------------------------------------------------------------------------
// Block light mutators
// ---------------------------------------------------------------------------

/**
 * Flood-fill block light from a source. Raises the cell to `level` when it is
 * darker and queues the spread; call processLightQueue() to finish the work.
 * @returns {boolean} true when the cell got brighter
 */
export function addBlockLight(world, x, y, z, level) {
  ensureTables();
  if (y < 0 || y >= WORLD_HEIGHT) return false;
  let lv = level | 0;
  if (lv <= 0) return false;
  if (lv > MAX_LIGHT) lv = MAX_LIGHT;
  const chunk = chunkAt(world, x >> 4, z >> 4);
  if (!chunk) return false;
  const st = getState(world);
  const i = cellIndex(x, y, z);
  const cur = chunk.light[i] & 15;
  if (cur >= lv) {
    // Already at least this bright, but the source may still have neighbours
    // to reach (it was added before its surroundings existed).
    st.blockAdd.push(x, y, z, cur);
    return false;
  }
  chunk.light[i] = (chunk.light[i] & 0xf0) | lv;
  markLocal(st, chunk, x & 15, z & 15);
  st.blockAdd.push(x, y, z, lv);
  return true;
}

/**
 * Removes the block light a source used to own. Phase one erases the region,
 * phase two (inside the drain) re-propagates from every cell that survived.
 * @returns {number} the level that was removed
 */
export function removeBlockLight(world, x, y, z) {
  ensureTables();
  if (y < 0 || y >= WORLD_HEIGHT) return 0;
  const chunk = chunkAt(world, x >> 4, z >> 4);
  if (!chunk) return 0;
  const st = getState(world);
  const i = cellIndex(x, y, z);
  const cur = chunk.light[i] & 15;
  if (cur === 0) return 0;
  chunk.light[i] &= 0xf0;
  markLocal(st, chunk, x & 15, z & 15);
  st.blockRemove.push(x, y, z, cur);
  return cur;
}

/** Queues the six neighbours of a cell as re-propagation sources. */
function seedNeighbors(world, st, x, y, z, sky, block) {
  for (let f = 0; f < 6; f++) {
    const ny = y + DY[f];
    if (ny < 0 || ny >= WORLD_HEIGHT) continue;
    const nx = x + DX[f], nz = z + DZ[f];
    const c = chunkAt(world, nx >> 4, nz >> 4);
    if (!c) { notePending(st, nx >> 4, nz >> 4); continue; }
    const l = c.light[cellIndex(nx, ny, nz)];
    if (sky && ((l >> 4) & 15) > 1) st.skyAdd.push(nx, ny, nz, (l >> 4) & 15);
    if (block && (l & 15) > 1) st.blockAdd.push(nx, ny, nz, l & 15);
  }
}

// ---------------------------------------------------------------------------
// Sky light
// ---------------------------------------------------------------------------

/**
 * Re-runs the vertical sun beam for one column from `topY` downwards and
 * queues the difference against what is stored. Cells that gained light are
 * raised and pushed as sources; cells that lost it are erased and pushed as
 * removals (any light they legitimately received sideways comes straight back
 * through the two-phase removal). Stops once the beam is dead and the column
 * below is already dark.
 */
function resetSkyColumn(world, st, x, z, topY) {
  const chunk = chunkAt(world, x >> 4, z >> 4);
  if (!chunk) return 0;
  let y0 = topY;
  if (y0 >= WORLD_HEIGHT) y0 = WORLD_HEIGHT - 1;
  if (y0 < 0) return 0;
  const blocks = chunk.blocks;
  const light = chunk.light;
  const lx = x & 15, lz = z & 15;
  const ci = (lz << 4) | lx;
  // Light arriving from above. Outside the world that is full daylight.
  let level = y0 >= WORLD_HEIGHT - 1 ? MAX_LIGHT : (light[((y0 + 1) << 8) | ci] >> 4) & 15;
  let changed = 0;
  for (let y = y0; y >= 0; y--) {
    const i = (y << 8) | ci;
    const id = blocks[i] & ID_MASK;
    if (!(level === MAX_LIGHT && SKY_FREE[id])) {
      const c = COST[id];
      level = level > c ? level - c : 0;
    }
    const stored = (light[i] >> 4) & 15;
    if (stored < level) {
      light[i] = (light[i] & 0x0f) | (level << 4);
      markLocal(st, chunk, lx, lz);
      st.skyAdd.push(x, y, z, level);
      changed++;
    } else if (stored > level) {
      light[i] &= 0x0f;
      markLocal(st, chunk, lx, lz);
      st.skyRemove.push(x, y, z, stored);
      changed++;
    } else if (level === 0) {
      break;    // beam is dead and this cell was already dark
    }
  }
  return changed;
}

/**
 * Top-down sky pass for a whole chunk followed by a horizontal spread seed,
 * so daylight bleeds sideways under overhangs instead of stopping at the
 * column that owns it. Also re-seeds the chunk's light emitters and both
 * sides of its four borders, then drains what it can within a small budget.
 *
 * Safe to call on an already-lit chunk: the sky channel is fully recomputed
 * and the block channel is only ever raised.
 * @returns {number} cells processed by the drain
 */
export function initSkyLight(world, chunk) {
  if (!world || !chunk) return 0;
  ensureTables();
  invalidateCache();
  const st = getState(world);
  const blocks = chunk.blocks;
  const light = chunk.light;
  const baseX = chunk.cx << 4;
  const baseZ = chunk.cz << 4;

  // --- phase 1: the vertical beam, one column at a time --------------------
  let topOcc = -1;                      // highest y anywhere that is below 15
  for (let ci = 0; ci < 256; ci++) {
    let level = MAX_LIGHT;
    let dropped = -1;
    for (let y = WORLD_HEIGHT - 1; y >= 0; y--) {
      const i = (y << 8) | ci;
      const id = blocks[i] & ID_MASK;
      if (!(level === MAX_LIGHT && SKY_FREE[id])) {
        const c = COST[id];
        level = level > c ? level - c : 0;
      }
      light[i] = (light[i] & 0x0f) | (level << 4);
      if (level < MAX_LIGHT && dropped < 0) dropped = y;
      if (level === 0) {
        // Nothing below can be reached from above; anything down there has to
        // arrive sideways, which phase 2 and the BFS take care of.
        for (let y2 = y - 1; y2 >= 0; y2--) light[(y2 << 8) | ci] &= 0x0f;
        break;
      }
    }
    if (dropped > topOcc) topOcc = dropped;
  }

  // --- phase 2: seed the horizontal spread ---------------------------------
  // Only cells that sit next to a darker neighbour can push light, and above
  // `topOcc` the whole chunk is a uniform 15, so the scan stops there.
  for (let y = topOcc; y >= 0; y--) {
    const yb = y << 8;
    for (let z = 0; z < 16; z++) {
      const zb = yb | (z << 4);
      for (let x = 0; x < 16; x++) {
        const i = zb | x;
        const v = (light[i] >> 4) & 15;
        if (v <= 1) continue;
        const t = v - 1;                 // best a neighbour could receive
        let seed = false;
        if (x > 0) {
          const j = i - 1;
          if (FILTER[blocks[j] & ID_MASK] < OPAQUE && ((light[j] >> 4) & 15) < t) seed = true;
        }
        if (!seed && x < 15) {
          const j = i + 1;
          if (FILTER[blocks[j] & ID_MASK] < OPAQUE && ((light[j] >> 4) & 15) < t) seed = true;
        }
        if (!seed && z > 0) {
          const j = i - 16;
          if (FILTER[blocks[j] & ID_MASK] < OPAQUE && ((light[j] >> 4) & 15) < t) seed = true;
        }
        if (!seed && z < 15) {
          const j = i + 16;
          if (FILTER[blocks[j] & ID_MASK] < OPAQUE && ((light[j] >> 4) & 15) < t) seed = true;
        }
        if (seed) st.skyAdd.push(baseX + x, y, baseZ + z, v);
      }
    }
  }

  seedBlockEmitters(world, st, chunk);
  relightChunkBorders(world, chunk);

  chunk.lit = true;
  touchChunk(st, chunk, 15);
  return drain(world, st, INIT_DRAIN_MS);
}

/** Puts every light-emitting block in the chunk back into the add queue. */
function seedBlockEmitters(world, st, chunk) {
  const blocks = chunk.blocks;
  const light = chunk.light;
  const baseX = chunk.cx << 4;
  const baseZ = chunk.cz << 4;
  const counts = chunk.sectionCounts;
  const sections = counts ? counts.length : WORLD_HEIGHT >> 4;
  for (let s = 0; s < sections; s++) {
    if (counts && counts[s] === 0) continue;      // whole 16-tall slab is air
    const y0 = s << 4;
    const y1 = Math.min(y0 + 16, WORLD_HEIGHT);
    for (let y = y0; y < y1; y++) {
      const yb = y << 8;
      for (let ci = 0; ci < 256; ci++) {
        const i = yb | ci;
        const v = blocks[i];
        if ((v & ID_MASK) === 0) continue;
        const e = emissionOf(v);
        if (e === 0) continue;
        if ((light[i] & 15) < e) {
          light[i] = (light[i] & 0xf0) | e;
          markLocal(st, chunk, ci & 15, (ci >> 4) & 15);
        }
        st.blockAdd.push(baseX + (ci & 15), y, baseZ + ((ci >> 4) & 15), e);
      }
    }
  }
}

/**
 * Re-seeds both sides of the four vertical faces this chunk shares with its
 * neighbours. Called when a chunk finishes generating so light that stopped at
 * the world edge flows in, and so its own light escapes into what was already
 * there. Neighbours that are still missing are remembered as pending.
 * @returns {number} cells queued
 */
export function relightChunkBorders(world, chunk) {
  if (!world || !chunk) return 0;
  ensureTables();
  invalidateCache();
  const st = getState(world);
  st.pending.delete(chunkKeyNum(chunk.cx, chunk.cz));

  const myX = chunk.cx << 4;
  const myZ = chunk.cz << 4;
  let seeded = 0;

  for (let d = 0; d < 4; d++) {
    const ncx = chunk.cx + (d === 0 ? -1 : d === 1 ? 1 : 0);
    const ncz = chunk.cz + (d === 2 ? -1 : d === 3 ? 1 : 0);
    const nb = lookupChunk(world, ncx, ncz);
    if (!nb) { notePending(st, ncx, ncz); continue; }
    // A generated-but-unlit neighbour is skipped on purpose: its own light
    // pass is still coming and will call back here, and flooding a chunk that
    // is about to be recomputed from scratch is pure waste.
    if (nb.lit === false) { notePending(st, ncx, ncz); continue; }
    const nbX = ncx << 4;
    const nbZ = ncz << 4;

    for (let t = 0; t < 16; t++) {
      let mx, mz, nx, nz;
      if (d === 0) { mx = 0; mz = t; nx = 15; nz = t; }
      else if (d === 1) { mx = 15; mz = t; nx = 0; nz = t; }
      else if (d === 2) { mx = t; mz = 0; nx = t; nz = 15; }
      else { mx = t; mz = 15; nx = t; nz = 0; }

      const mci = (mz << 4) | mx;
      const nci = (nz << 4) | nx;
      const mwx = myX + mx, mwz = myZ + mz;
      const nwx = nbX + nx, nwz = nbZ + nz;

      for (let y = 0; y < WORLD_HEIGHT; y++) {
        const mi = (y << 8) | mci;
        const ni = (y << 8) | nci;
        const ml = chunk.light[mi];
        const nl = nb.light[ni];
        const mSky = (ml >> 4) & 15, nSky = (nl >> 4) & 15;
        const mBlk = ml & 15, nBlk = nl & 15;
        const mOpen = FILTER[chunk.blocks[mi] & ID_MASK] < OPAQUE;
        const nOpen = FILTER[nb.blocks[ni] & ID_MASK] < OPAQUE;
        // Horizontal spread always costs at least one level, so a cell can
        // only push when it beats its counterpart by more than that.
        if (nOpen) {
          if (mSky > nSky + 1) { st.skyAdd.push(mwx, y, mwz, mSky); seeded++; }
          if (mBlk > nBlk + 1) { st.blockAdd.push(mwx, y, mwz, mBlk); seeded++; }
        }
        if (mOpen) {
          if (nSky > mSky + 1) { st.skyAdd.push(nwx, y, nwz, nSky); seeded++; }
          if (nBlk > mBlk + 1) { st.blockAdd.push(nwx, y, nwz, nBlk); seeded++; }
        }
      }
    }
  }
  return seeded;
}

/**
 * Throws away a chunk's light and rebuilds it from scratch: sky columns,
 * horizontal spread, emitters and both sides of every border.
 * @returns {number} cells processed by the drain
 */
export function recalcChunkLight(world, chunk) {
  if (!world || !chunk) return 0;
  ensureTables();
  invalidateCache();
  const st = getState(world);
  // Light this chunk used to push into its neighbours is still sitting there
  // and nothing else will ever take it back, so queue a removal for every
  // border cell before the data disappears. Survivors re-fill the hole during
  // the drain, which leaves the neighbours exactly as bright as they deserve.
  seedBorderRemovals(world, st, chunk);
  chunk.light.fill(0);
  chunk.lit = false;
  return initSkyLight(world, chunk);
}

/** Queues a removal for every border cell of a chunk that is about to be wiped. */
function seedBorderRemovals(world, st, chunk) {
  const myX = chunk.cx << 4;
  const myZ = chunk.cz << 4;
  for (let d = 0; d < 4; d++) {
    const ncx = chunk.cx + (d === 0 ? -1 : d === 1 ? 1 : 0);
    const ncz = chunk.cz + (d === 2 ? -1 : d === 3 ? 1 : 0);
    const nb = lookupChunk(world, ncx, ncz);
    if (!nb || nb.lit === false) continue;
    for (let t = 0; t < 16; t++) {
      let mx, mz;
      if (d === 0) { mx = 0; mz = t; }
      else if (d === 1) { mx = 15; mz = t; }
      else if (d === 2) { mx = t; mz = 0; }
      else { mx = t; mz = 15; }
      const ci = (mz << 4) | mx;
      const wx = myX + mx, wz = myZ + mz;
      for (let y = 0; y < WORLD_HEIGHT; y++) {
        const l = chunk.light[(y << 8) | ci];
        const sky = (l >> 4) & 15;
        const blk = l & 15;
        if (sky > 1) st.skyRemove.push(wx, y, wz, sky);
        if (blk > 1) st.blockRemove.push(wx, y, wz, blk);
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Incremental updates
// ---------------------------------------------------------------------------

/**
 * Incremental update after a block change at (x, y, z). Handles all four
 * cases - emitter added, emitter removed, opacity raised, opacity lowered -
 * and re-runs the sky column whenever the block's light behaviour changed.
 * The block value itself must already be written into the chunk.
 * @returns {number} cells processed by the inline drain
 */
export function updateLight(world, x, y, z, oldId, newId) {
  if (!world) return 0;
  ensureTables();
  invalidateCache();
  if (y < 0 || y >= WORLD_HEIGHT) return 0;
  const chunk = chunkAt(world, x >> 4, z >> 4);
  if (!chunk) return 0;

  const st = getState(world);
  const i = cellIndex(x, y, z);
  const value = chunk.blocks[i];
  const oid = (oldId | 0) & ID_MASK;
  const nid = (newId | 0) & ID_MASK;

  const oldFilter = FILTER[oid];
  const newFilter = FILTER[nid];
  const skyBehaviourChanged = oldFilter !== newFilter || SKY_FREE[oid] !== SKY_FREE[nid];

  const storedBlock = chunk.light[i] & 15;
  const newEmit = emissionOf(value);
  let oldEmit = EMIT[oid];
  // Metadata-only switches (a redstone lamp going dark, a furnace going out)
  // arrive with oldId === newId, so the old emission has to be recovered from
  // what the cell is currently storing.
  if (LIT_LIGHT[oid] >= 0 && storedBlock > oldEmit) oldEmit = storedBlock;

  // --- block light ---------------------------------------------------------
  const lostEmitter = oldEmit > 0 && newEmit < oldEmit;
  if (storedBlock > 0 && (lostEmitter || newFilter > oldFilter)) {
    chunk.light[i] &= 0xf0;
    markLocal(st, chunk, x & 15, z & 15);
    st.blockRemove.push(x, y, z, storedBlock);
  }
  if (newEmit > 0) addBlockLight(world, x, y, z, newEmit);

  // --- sky light -----------------------------------------------------------
  if (skyBehaviourChanged) resetSkyColumn(world, st, x, z, y);

  // A block became more transparent: whatever surrounds it can now flow in.
  if (newFilter < oldFilter || (SKY_FREE[nid] && !SKY_FREE[oid])) {
    seedNeighbors(world, st, x, y, z, true, true);
  }

  // Small edits finish immediately so a placed torch lights the room on the
  // same frame; a storm of edits is left to the per-frame driver.
  if (queuedCells(st) <= INLINE_QUEUE_LIMIT) return drain(world, st, INLINE_DRAIN_MS);
  flushDirty(world, st);
  return 0;
}

/** Total number of cells waiting in all four queues. */
function queuedCells(st) {
  return st.blockRemove.count + st.blockAdd.count + st.skyRemove.count + st.skyAdd.count;
}

// ---------------------------------------------------------------------------
// The flood fill
// ---------------------------------------------------------------------------

/**
 * Phase two of a removal: erase everything dimmer than what we took away and
 * collect the survivors as re-propagation sources.
 */
function drainRemove(world, st, q, addQ, isSky, deadline) {
  const shift = isSky ? 4 : 0;
  const keep = isSky ? 0x0f : 0xf0;
  let work = 0;
  while (q.pop()) {
    const x = q.px, y = q.py, z = q.pz, old = q.pv;
    for (let f = 0; f < 6; f++) {
      const ny = y + DY[f];
      if (ny < 0 || ny >= WORLD_HEIGHT) continue;
      const nx = x + DX[f], nz = z + DZ[f];
      const ncx = nx >> 4, ncz = nz >> 4;
      const c = chunkAt(world, ncx, ncz);
      if (!c) { notePending(st, ncx, ncz); continue; }
      const i = (ny << 8) | ((nz & 15) << 4) | (nx & 15);
      const cur = (c.light[i] >> shift) & 15;
      if (cur === 0) continue;
      // A full-strength sun beam feeds the cell below at full strength, so the
      // usual "strictly dimmer" test would stop the erase dead at the first
      // step down the shaft.
      const sunBeam = isSky && f === F_DOWN && old === MAX_LIGHT && cur === MAX_LIGHT;
      if (cur < old || sunBeam) {
        const emit = isSky ? 0 : emissionOf(c.blocks[i]);
        if (emit > 0 && emit >= cur) {
          // The cell is its own source: nothing to erase, re-light from it.
          addQ.push(nx, ny, nz, emit);
          continue;
        }
        c.light[i] = (c.light[i] & keep) | (emit << shift);
        markLocal(st, c, nx & 15, nz & 15);
        if (emit > 0) addQ.push(nx, ny, nz, emit);
        q.push(nx, ny, nz, cur);
      } else {
        // Survived: it is lit by something else and has to fill the hole back.
        addQ.push(nx, ny, nz, cur);
      }
    }
    work++;
    if ((work & 255) === 0 && nowMs() > deadline) break;
  }
  return work;
}

/** Breadth-first spread of one channel from every queued source. */
function drainAdd(world, st, q, isSky, deadline) {
  const shift = isSky ? 4 : 0;
  const keep = isSky ? 0x0f : 0xf0;
  let work = 0;
  while (q.pop()) {
    const x = q.px, y = q.py, z = q.pz;
    const cx = x >> 4, cz = z >> 4;
    const home = chunkAt(world, cx, cz);
    if (!home) continue;
    // Re-read instead of trusting the queued level: a removal pass may have
    // erased or a brighter source may have overwritten this cell since.
    const level = (home.light[(y << 8) | ((z & 15) << 4) | (x & 15)] >> shift) & 15;
    if (level <= 1) continue;
    for (let f = 0; f < 6; f++) {
      const ny = y + DY[f];
      if (ny < 0 || ny >= WORLD_HEIGHT) continue;
      const nx = x + DX[f], nz = z + DZ[f];
      let c;
      if (f < 2) {
        c = home;                       // straight up/down never leaves the chunk
      } else {
        const ncx = nx >> 4, ncz = nz >> 4;
        c = chunkAt(world, ncx, ncz);
        if (!c) { notePending(st, ncx, ncz); continue; }
      }
      const i = (ny << 8) | ((nz & 15) << 4) | (nx & 15);
      const id = c.blocks[i] & ID_MASK;
      let target;
      if (isSky && f === F_DOWN && level === MAX_LIGHT && SKY_FREE[id]) {
        target = MAX_LIGHT;             // sunlight falls for free
      } else {
        const cost = COST[id];
        if (cost >= level) continue;
        target = level - cost;
      }
      if (target <= 0) continue;
      if (((c.light[i] >> shift) & 15) >= target) continue;
      c.light[i] = (c.light[i] & keep) | (target << shift);
      markLocal(st, c, nx & 15, nz & 15);
      q.push(nx, ny, nz, target);
    }
    work++;
    if ((work & 255) === 0 && nowMs() > deadline) break;
  }
  return work;
}

/**
 * Runs the four queues in the only order that converges in one pass:
 * erase before fill, block light before sky light.
 */
function drain(world, st, budgetMs) {
  const deadline = budgetMs === Infinity ? Infinity : nowMs() + budgetMs;
  let work = 0;
  if (st.blockRemove.count) work += drainRemove(world, st, st.blockRemove, st.blockAdd, false, deadline);
  if (st.blockAdd.count) work += drainAdd(world, st, st.blockAdd, false, deadline);
  if (st.skyRemove.count) work += drainRemove(world, st, st.skyRemove, st.skyAdd, true, deadline);
  if (st.skyAdd.count) work += drainAdd(world, st, st.skyAdd, true, deadline);
  st.work += work;
  flushDirty(world, st);
  if (!hasWork(st)) {
    st.blockRemove.trim(); st.blockAdd.trim(); st.skyRemove.trim(); st.skyAdd.trim();
  }
  return work;
}

/**
 * Drains queued propagation work with a time budget in milliseconds and marks
 * every chunk whose light changed for a remesh. Call it once per frame.
 * @returns {number} cells processed
 */
export function processLightQueue(world, budgetMs = 4) {
  if (!world) return 0;
  const st = STATES.get(world);
  if (!st || !hasWork(st)) return 0;
  ensureTables();
  invalidateCache();
  return drain(world, st, budgetMs);
}

// ---------------------------------------------------------------------------
// Sampling
// ---------------------------------------------------------------------------

/**
 * Per-vertex light for the mesher. (x, y, z) is a lattice point - the corner
 * shared by the eight blocks spanning (x-1..x, y-1..y, z-1..z). Opaque cells
 * are ignored so a vertex against a wall keeps the brightness of the open air
 * beside it instead of averaging in the darkness inside the wall.
 * @returns {number} packed (sky << 4) | block, both 0..15
 */
export function getSmoothLight(world, x, y, z) {
  ensureTables();
  const bx = Math.floor(x), by = Math.floor(y), bz = Math.floor(z);
  let skySum = 0, blockSum = 0, n = 0;
  for (let dy = -1; dy <= 0; dy++) {
    const cy = by + dy;
    if (cy < 0) continue;
    for (let dz = -1; dz <= 0; dz++) {
      for (let dx = -1; dx <= 0; dx++) {
        const cx = bx + dx, cz = bz + dz;
        if (cy >= WORLD_HEIGHT) { skySum += MAX_LIGHT; n++; continue; }
        const c = chunkAt(world, cx >> 4, cz >> 4);
        if (!c) continue;
        const i = (cy << 8) | ((cz & 15) << 4) | (cx & 15);
        if (FILTER[c.blocks[i] & ID_MASK] >= OPAQUE) continue;
        const l = c.light[i];
        skySum += (l >> 4) & 15;
        blockSum += l & 15;
        n++;
      }
    }
  }
  if (n === 0) {
    // Fully enclosed corner: fall back to the cell the vertex belongs to.
    if (by >= WORLD_HEIGHT) return MAX_LIGHT << 4;
    const c = chunkAt(world, bx >> 4, bz >> 4);
    if (!c || by < 0) return 0;
    return c.light[cellIndex(bx, by, bz)];
  }
  const sky = ((skySum / n) + 0.5) | 0;
  const blk = ((blockSum / n) + 0.5) | 0;
  return ((sky & 15) << 4) | (blk & 15);
}

/**
 * Diagnostics for the F3 overlay: how much light work is still outstanding.
 * @returns {{sky:number, block:number, pending:number, total:number, done:number}}
 */
export function lightStats(world) {
  const st = world ? STATES.get(world) : null;
  if (!st) return { sky: 0, block: 0, pending: 0, total: 0, done: 0 };
  const sky = st.skyAdd.count + st.skyRemove.count;
  const block = st.blockAdd.count + st.blockRemove.count;
  return { sky, block, pending: st.pending.size, total: sky + block, done: st.work };
}

/** Drops every queued update for a world (used when a dimension is unloaded). */
export function clearLightQueue(world) {
  const st = world ? STATES.get(world) : null;
  if (!st) return;
  st.skyAdd.clear(); st.skyRemove.clear();
  st.blockAdd.clear(); st.blockRemove.clear();
  st.touched.clear();
  st.lastChunk = null;
  st.lastMask = 0;
  st.pending.clear();
  invalidateCache();
}

export default {
  addBlockLight,
  removeBlockLight,
  initSkyLight,
  updateLight,
  processLightQueue,
  recalcChunkLight,
  relightChunkBorders,
  getSmoothLight,
  lightStats,
  clearLightQueue,
};
