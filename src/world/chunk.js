// ============================================================================
// chunk.js - One 16 x 128 x 16 column of the world.
//
// Storage is three flat typed arrays laid out y-major (see chunkIndex in
// constants.js): index = (y << 8) | (z << 4) | x. That ordering makes vertical
// column scans (heightmap, sky light) walk with a constant stride of 256 and
// keeps horizontal slices contiguous, which is what the mesher wants.
//
// Everything here is deliberately allocation-free on the hot path: accessors
// take primitives, return primitives, and the only objects a Chunk ever
// allocates after construction are block-entity records handed to it.
//
// Two derived summaries are maintained incrementally by set():
//   * heightmap[z*16+x] - highest non-air y plus one (0 for an empty column)
//   * sectionCounts[y>>4] - non-air block count per 16-tall section, which
//     gives the mesher and the lighting engine a cheap "skip this slab" test.
// `empty` is the whole-chunk version of that counter.
// ============================================================================
import {
  CHUNK_AREA,
  CHUNK_VOLUME,
  WORLD_HEIGHT,
  ID_MASK,
  packBlock,
  packLight,
} from '../core/constants.js';

/** Height of a light/mesh section in blocks. */
export const SECTION_HEIGHT = 16;
/** Number of sections stacked in one chunk (128 / 16 = 8). */
export const SECTION_COUNT = WORLD_HEIGHT / SECTION_HEIGHT;

// Scratch flag array reused by fillRegion. Chunks are only mutated from the
// main thread, one call at a time, so a module-level scratch buffer is safe and
// keeps bulk fills allocation-free.
const FILL_COLUMN_FLAGS = new Uint8Array(CHUNK_AREA);

/**
 * A single loaded chunk: blocks, light, heightmap, biomes and block entities.
 */
export class Chunk {
  /**
   * @param {number} cx chunk x (world x >> 4)
   * @param {number} cz chunk z (world z >> 4)
   * @param {object|null} world owning World, or null for a detached chunk
   */
  constructor(cx, cz, world = null) {
    this.cx = cx | 0;
    this.cz = cz | 0;
    this.world = world;
    /** @type {string} 'cx,cz' - handy as a Map key, matches util.chunkKey */
    this.key = this.cx + ',' + this.cz;

    this.blocks = new Uint16Array(CHUNK_VOLUME);   // id | meta << 12
    this.light = new Uint8Array(CHUNK_VOLUME);     // sky << 4 | block
    this.heightmap = new Uint8Array(CHUNK_AREA);   // highest non-air y + 1
    this.biomes = new Uint8Array(CHUNK_AREA);      // biome id per column
    this.blockEntities = new Map();                // localIndex -> object

    // --- derived counters, kept in sync by set()/fillRegion() ---------------
    /** @type {Uint16Array} non-air blocks per 16-tall section (max 4096 each) */
    this.sectionCounts = new Uint16Array(SECTION_COUNT);
    /** @type {number} total non-air blocks in the chunk */
    this.nonAirCount = 0;

    // --- lifecycle flags ---------------------------------------------------
    this.generated = false;   // terrain written
    this.populated = false;   // trees/ores/structures placed
    this.lit = false;         // initial sky light pass done
    this.dirty = true;        // needs remeshing
    this.meshVersion = 0;     // bumped every time a mesh is built from this data
    this.empty = true;        // contains nothing but air (mesher fast path)

    // --- bookkeeping used by world.js / save.js -----------------------------
    this.modified = false;    // changed since it was last written to disk
    this.lastUse = 0;         // ms timestamp, for unload heuristics
  }

  /** World x of this chunk's local x=0 column. */
  get originX() { return this.cx << 4; }
  /** World z of this chunk's local z=0 column. */
  get originZ() { return this.cz << 4; }

  // -- block access ----------------------------------------------------------

  /** Packed value (id | meta<<12) at local coords; 0 when out of range. */
  get(x, y, z) {
    if (x < 0 || x > 15 || z < 0 || z > 15 || y < 0 || y >= WORLD_HEIGHT) return 0;
    return this.blocks[(y << 8) | (z << 4) | x];
  }

  /** Block id only (0 = air, also 0 out of range). */
  getId(x, y, z) {
    if (x < 0 || x > 15 || z < 0 || z > 15 || y < 0 || y >= WORLD_HEIGHT) return 0;
    return this.blocks[(y << 8) | (z << 4) | x] & ID_MASK;
  }

  /** Metadata nibble only (0..15). */
  getMeta(x, y, z) {
    if (x < 0 || x > 15 || z < 0 || z > 15 || y < 0 || y >= WORLD_HEIGHT) return 0;
    return (this.blocks[(y << 8) | (z << 4) | x] >>> 12) & 15;
  }

  /** Packed value by raw local index, no bounds check. Hot path only. */
  getIndex(i) { return this.blocks[i]; }

  /**
   * Writes a packed block value. Returns the previous packed value.
   * Keeps heightmap, per-section counters and the `empty` flag correct.
   */
  set(x, y, z, value) {
    if (x < 0 || x > 15 || z < 0 || z > 15 || y < 0 || y >= WORLD_HEIGHT) return 0;
    const blocks = this.blocks;
    const i = (y << 8) | (z << 4) | x;
    const prev = blocks[i];
    value &= 0xffff;
    if (prev === value) return prev;
    blocks[i] = value;
    this.dirty = true;
    this.modified = true;

    const wasAir = (prev & ID_MASK) === 0;
    const nowAir = (value & ID_MASK) === 0;
    if (wasAir === nowAir) return prev;   // meta-only change: summaries unaffected

    const s = y >> 4;
    if (nowAir) {
      if (this.sectionCounts[s] > 0) this.sectionCounts[s]--;
      if (this.nonAirCount > 0) this.nonAirCount--;
      this.empty = this.nonAirCount === 0;
      // Only the topmost block of a column can lower the heightmap.
      const ci = (z << 4) | x;
      if (this.heightmap[ci] === y + 1) {
        let ny = y - 1;
        while (ny >= 0 && (blocks[(ny << 8) | ci] & ID_MASK) === 0) ny--;
        this.heightmap[ci] = ny + 1;
      }
    } else {
      this.sectionCounts[s]++;
      this.nonAirCount++;
      this.empty = false;
      const ci = (z << 4) | x;
      if (y + 1 > this.heightmap[ci]) this.heightmap[ci] = y + 1;
    }
    return prev;
  }

  /** Convenience wrapper around set() taking id + meta separately. */
  setId(x, y, z, id, meta = 0) {
    return this.set(x, y, z, packBlock(id, meta));
  }

  /** True when the local coords fall inside this chunk. */
  contains(x, y, z) {
    return x >= 0 && x < 16 && z >= 0 && z < 16 && y >= 0 && y < WORLD_HEIGHT;
  }

  // -- light -----------------------------------------------------------------

  /** Packed light byte: (sky << 4) | block. */
  getLight(x, y, z) {
    if (x < 0 || x > 15 || z < 0 || z > 15 || y < 0 || y >= WORLD_HEIGHT) return 0;
    return this.light[(y << 8) | (z << 4) | x];
  }

  /** Writes both light channels at once. */
  setLight(x, y, z, sky, block) {
    if (x < 0 || x > 15 || z < 0 || z > 15 || y < 0 || y >= WORLD_HEIGHT) return;
    this.light[(y << 8) | (z << 4) | x] = packLight(sky, block);
  }

  /** Sky light level 0..15. */
  getSky(x, y, z) {
    if (x < 0 || x > 15 || z < 0 || z > 15 || y < 0 || y >= WORLD_HEIGHT) return 0;
    return (this.light[(y << 8) | (z << 4) | x] >> 4) & 15;
  }

  /** Emitted/propagated block light level 0..15. */
  getBlockLight(x, y, z) {
    if (x < 0 || x > 15 || z < 0 || z > 15 || y < 0 || y >= WORLD_HEIGHT) return 0;
    return this.light[(y << 8) | (z << 4) | x] & 15;
  }

  /** Sets only the sky channel, preserving block light. */
  setSky(x, y, z, v) {
    if (x < 0 || x > 15 || z < 0 || z > 15 || y < 0 || y >= WORLD_HEIGHT) return;
    const i = (y << 8) | (z << 4) | x;
    this.light[i] = ((v & 15) << 4) | (this.light[i] & 15);
  }

  /** Sets only the block channel, preserving sky light. */
  setBlockLight(x, y, z, v) {
    if (x < 0 || x > 15 || z < 0 || z > 15 || y < 0 || y >= WORLD_HEIGHT) return;
    const i = (y << 8) | (z << 4) | x;
    this.light[i] = (this.light[i] & 0xf0) | (v & 15);
  }

  /** Overwrites every light byte (used before a full relight). */
  fillLight(sky = 0, block = 0) {
    this.light.fill(packLight(sky, block));
  }

  // -- biomes ----------------------------------------------------------------

  /** Biome id for a column. */
  getBiome(x, z) {
    if (x < 0 || x > 15 || z < 0 || z > 15) return 0;
    return this.biomes[(z << 4) | x];
  }

  /** Sets the biome id for a column. */
  setBiome(x, z, id) {
    if (x < 0 || x > 15 || z < 0 || z > 15) return;
    this.biomes[(z << 4) | x] = id & 255;
  }

  // -- heightmap -------------------------------------------------------------

  /** Highest non-air y plus one for a column (0 when the column is all air). */
  heightAt(x, z) {
    if (x < 0 || x > 15 || z < 0 || z > 15) return 0;
    return this.heightmap[(z << 4) | x];
  }

  /**
   * Rebuilds heightmap, per-section counters, nonAirCount and `empty` from the
   * block array. Call after bulk writes that bypassed set().
   */
  recomputeHeightmap() {
    const blocks = this.blocks;
    const hm = this.heightmap;
    const counts = this.sectionCounts;
    counts.fill(0);
    let total = 0;
    for (let z = 0; z < 16; z++) {
      for (let x = 0; x < 16; x++) {
        const ci = (z << 4) | x;
        let h = 0;
        for (let y = WORLD_HEIGHT - 1; y >= 0; y--) {
          if ((blocks[(y << 8) | ci] & ID_MASK) !== 0) {
            if (h === 0) h = y + 1;
            counts[y >> 4]++;
            total++;
          }
        }
        hm[ci] = h;
      }
    }
    this.nonAirCount = total;
    this.empty = total === 0;
    return hm;
  }

  // -- block entities --------------------------------------------------------

  /** Block entity record at local coords, or undefined. */
  getBlockEntity(x, y, z) {
    if (x < 0 || x > 15 || z < 0 || z > 15 || y < 0 || y >= WORLD_HEIGHT) return undefined;
    return this.blockEntities.get((y << 8) | (z << 4) | x);
  }

  /**
   * Attaches a block entity. World coordinates are stamped onto the record
   * when it does not already carry them, so consumers can move it around
   * without re-deriving its position.
   */
  setBlockEntity(x, y, z, obj) {
    if (x < 0 || x > 15 || z < 0 || z > 15 || y < 0 || y >= WORLD_HEIGHT) return undefined;
    const i = (y << 8) | (z << 4) | x;
    if (obj == null) { this.blockEntities.delete(i); this.modified = true; return undefined; }
    if (typeof obj === 'object') {
      if (obj.x === undefined) obj.x = (this.cx << 4) + x;
      if (obj.y === undefined) obj.y = y;
      if (obj.z === undefined) obj.z = (this.cz << 4) + z;
    }
    this.blockEntities.set(i, obj);
    this.modified = true;
    return obj;
  }

  /** Detaches a block entity. Returns true when one was present. */
  removeBlockEntity(x, y, z) {
    if (x < 0 || x > 15 || z < 0 || z > 15 || y < 0 || y >= WORLD_HEIGHT) return false;
    const removed = this.blockEntities.delete((y << 8) | (z << 4) | x);
    if (removed) this.modified = true;
    return removed;
  }

  /** Iterates block entities as fn(x, y, z, obj) with local coords. */
  forEachBlockEntity(fn) {
    for (const [i, obj] of this.blockEntities) {
      fn(i & 15, i >> 8, (i >> 4) & 15, obj);
    }
  }

  // -- bulk helpers ----------------------------------------------------------

  /**
   * Fills an inclusive local box with a packed block value. Coordinates are
   * clamped to the chunk, order-independent. Returns how many cells changed.
   */
  fillRegion(x0, y0, z0, x1, y1, z1, value) {
    let ax = x0 < x1 ? x0 : x1, bx = x0 < x1 ? x1 : x0;
    let ay = y0 < y1 ? y0 : y1, by = y0 < y1 ? y1 : y0;
    let az = z0 < z1 ? z0 : z1, bz = z0 < z1 ? z1 : z0;
    if (ax < 0) ax = 0; if (bx > 15) bx = 15;
    if (az < 0) az = 0; if (bz > 15) bz = 15;
    if (ay < 0) ay = 0; if (by > WORLD_HEIGHT - 1) by = WORLD_HEIGHT - 1;
    if (ax > bx || ay > by || az > bz) return 0;

    const blocks = this.blocks;
    const counts = this.sectionCounts;
    value &= 0xffff;
    const nowAir = (value & ID_MASK) === 0;
    let changed = 0;
    let deltaTotal = 0;
    // Track which columns need their heightmap re-derived; a Uint8 flag array
    // of 256 entries is cheaper than a Set and avoids garbage.
    const touched = FILL_COLUMN_FLAGS;
    touched.fill(0);

    for (let y = ay; y <= by; y++) {
      const yBase = y << 8;
      const s = y >> 4;
      for (let z = az; z <= bz; z++) {
        const rowBase = yBase | (z << 4);
        for (let x = ax; x <= bx; x++) {
          const i = rowBase | x;
          const prev = blocks[i];
          if (prev === value) continue;
          blocks[i] = value;
          changed++;
          const wasAir = (prev & ID_MASK) === 0;
          if (wasAir !== nowAir) {
            if (nowAir) { if (counts[s] > 0) counts[s]--; deltaTotal--; }
            else { counts[s]++; deltaTotal++; }
            touched[(z << 4) | x] = 1;
          }
        }
      }
    }

    if (changed) {
      this.dirty = true;
      this.modified = true;
      this.nonAirCount += deltaTotal;
      if (this.nonAirCount < 0) this.nonAirCount = 0;
      this.empty = this.nonAirCount === 0;
      for (let ci = 0; ci < CHUNK_AREA; ci++) {
        if (!touched[ci]) continue;
        let h = 0;
        for (let y = WORLD_HEIGHT - 1; y >= 0; y--) {
          if ((blocks[(y << 8) | ci] & ID_MASK) !== 0) { h = y + 1; break; }
        }
        this.heightmap[ci] = h;
      }
    }
    return changed;
  }

  /** Total number of non-air blocks currently stored. O(1). */
  countNonAir() {
    return this.nonAirCount;
  }

  /** Non-air blocks inside one 16-tall section. */
  sectionNonAir(sectionY) {
    if (sectionY < 0 || sectionY >= SECTION_COUNT) return 0;
    return this.sectionCounts[sectionY];
  }

  /**
   * True when a 16-tall section holds nothing but air. The mesher and the
   * lighting engine use this to skip whole slabs.
   */
  isEmptySection(sectionY) {
    if (sectionY < 0 || sectionY >= SECTION_COUNT) return true;
    return this.sectionCounts[sectionY] === 0;
  }

  /**
   * Visits every non-air block in y-major order as fn(x, y, z, value).
   * Empty sections are skipped wholesale. Returning `false` from fn stops the
   * iteration early.
   */
  forEachBlock(fn) {
    if (this.empty) return;
    const blocks = this.blocks;
    for (let s = 0; s < SECTION_COUNT; s++) {
      if (this.sectionCounts[s] === 0) continue;
      const y0 = s << 4, y1 = y0 + 16;
      for (let y = y0; y < y1; y++) {
        const yBase = y << 8;
        for (let z = 0; z < 16; z++) {
          const rowBase = yBase | (z << 4);
          for (let x = 0; x < 16; x++) {
            const v = blocks[rowBase | x];
            if ((v & ID_MASK) === 0) continue;
            if (fn(x, y, z, v) === false) return;
          }
        }
      }
    }
  }

  /**
   * Copies a whole vertical column into `out` (a Uint16Array of WORLD_HEIGHT).
   * Allocates one only when `out` is omitted. Returns the array.
   */
  getColumn(x, z, out) {
    const dst = out && out.length >= WORLD_HEIGHT ? out : new Uint16Array(WORLD_HEIGHT);
    if (x < 0 || x > 15 || z < 0 || z > 15) {
      dst.fill(0, 0, WORLD_HEIGHT);
      return dst;
    }
    const blocks = this.blocks;
    const ci = (z << 4) | x;
    for (let y = 0; y < WORLD_HEIGHT; y++) dst[y] = blocks[(y << 8) | ci];
    return dst;
  }

  /** Marks the chunk (and its stored data) as needing a remesh. */
  markDirty() {
    this.dirty = true;
    this.modified = true;
  }

  /** Resets everything to air. Keeps cx/cz/world. */
  clear() {
    this.blocks.fill(0);
    this.light.fill(0);
    this.heightmap.fill(0);
    this.sectionCounts.fill(0);
    this.blockEntities.clear();
    this.nonAirCount = 0;
    this.empty = true;
    this.generated = false;
    this.populated = false;
    this.lit = false;
    this.dirty = true;
    this.modified = true;
  }

  // -- persistence -----------------------------------------------------------

  /**
   * Plain object for save.js. The typed arrays are handed over by reference;
   * IndexedDB structured-clones them, so no copy is needed here.
   */
  serialize() {
    return {
      cx: this.cx,
      cz: this.cz,
      blocks: this.blocks,
      light: this.light,
      heightmap: this.heightmap,
      biomes: this.biomes,
      blockEntities: this.blockEntities,
      generated: this.generated,
      populated: this.populated,
      lit: this.lit,
    };
  }

  /**
   * Rebuilds a Chunk from serialize() output (or a structured clone of it).
   * Tolerates plain arrays and a missing/short heightmap.
   */
  static deserialize(obj, world = null) {
    const c = new Chunk(obj?.cx | 0, obj?.cz | 0, world);
    if (!obj) return c;

    c.blocks = adoptTyped(obj.blocks, Uint16Array, CHUNK_VOLUME);
    c.light = adoptTyped(obj.light, Uint8Array, CHUNK_VOLUME);
    c.biomes = adoptTyped(obj.biomes, Uint8Array, CHUNK_AREA);

    if (obj.blockEntities instanceof Map) {
      c.blockEntities = obj.blockEntities;
    } else if (Array.isArray(obj.blockEntities)) {
      c.blockEntities = new Map(obj.blockEntities);
    } else if (obj.blockEntities && typeof obj.blockEntities === 'object') {
      c.blockEntities = new Map();
      for (const k of Object.keys(obj.blockEntities)) {
        c.blockEntities.set(+k, obj.blockEntities[k]);
      }
    }

    c.generated = !!obj.generated;
    c.populated = !!obj.populated;
    c.lit = !!obj.lit;

    // The heightmap and the section counters are always re-derived rather than
    // trusted: it costs one pass over the block array and it repairs chunks
    // written by an older save format.
    c.recomputeHeightmap();
    c.dirty = true;
    c.modified = false;
    return c;
  }
}


/** Wraps or copies `src` into a typed array of exactly `len` elements. */
function adoptTyped(src, Ctor, len) {
  if (src instanceof Ctor && src.length === len) return src;
  const out = new Ctor(len);
  if (!src) return out;
  const n = Math.min(len, src.length | 0);
  for (let i = 0; i < n; i++) out[i] = src[i];
  return out;
}

export default Chunk;
