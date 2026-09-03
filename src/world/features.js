// ============================================================================
// features.js - Trees, ores, plants and small decorations (CONTRACT.md §6).
//
// Everything in here is a "feature": a function that tries to place one piece
// of scenery at a world position and answers whether it succeeded. Biomes name
// features as 'name:count' strings; decorateChunk() parses those, picks valid
// columns inside the chunk being populated, and runs them.
//
// Determinism rules that the rest of worldgen relies on:
//   * every placement RNG is derived from (world.seed, chunk.cx, chunk.cz,
//     feature name, feature index) - never from a shared stream, so changing
//     the order of one biome's feature list cannot shift another chunk;
//   * writes are clamped to the 3x3 chunk neighbourhood that world.js
//     guarantees is generated before populate runs;
//   * writes go through world.setBlock(..., flags 0) so no lighting update,
//     neighbour notification or block tick fires while terrain is being built.
// ============================================================================
import { WORLD_HEIGHT, SEA_LEVEL, HFACE_DIRS } from '../core/constants.js';
import { clamp } from '../core/util.js';
import { RNG, hash3, hashString } from '../core/rng.js';
import { BLOCKS, BLOCK_BY_NAME, getBlock } from './blocks.js';
import { getBiome } from './biomes.js';

// ---------------------------------------------------------------------------
// Block id lookup
// ---------------------------------------------------------------------------

// flags = 0: no lighting pass, no neighbour updates, during generation.
const GEN = 0;

const _idCache = new Map();
const _warned = new Set();

/** Numeric id for a block name, memoised. Unknown names resolve to air. */
function bid(name) {
  let v = _idCache.get(name);
  if (v !== undefined) return v;
  const def = BLOCK_BY_NAME.get(name);
  if (def) v = def.id;
  else {
    v = 0;
    if (!_warned.has(name)) { _warned.add(name); console.warn('[features] unknown block:', name); }
  }
  _idCache.set(name, v);
  return v;
}

let _sets = null;
/** Lazily built id sets. Never touched at module-evaluation time. */
function S() {
  if (_sets) return _sets;
  const of = (...names) => {
    const s = new Set();
    for (const n of names) { const d = BLOCK_BY_NAME.get(n); if (d) s.add(d.id); }
    return s;
  };
  const leaves = new Set();
  const soft = new Set();          // things a tree may grow straight through
  const terracotta = new Set();
  for (const d of BLOCKS) {
    if (!d || d.id === 0) continue;
    if (d.name.endsWith('_leaves')) leaves.add(d.id);
    if (d.name === 'terracotta' || d.name.endsWith('_terracotta')) terracotta.add(d.id);
    if (!d.solid || d.replaceable || d.model === 'cross' || d.model === 'vine' ||
        d.model === 'carpet' || d.model === 'layer' || d.model === 'flat') soft.add(d.id);
  }
  const dirtLike = of('grass_block', 'dirt', 'coarse_dirt', 'podzol', 'mycelium', 'rooted_dirt',
    'moss_block', 'farmland', 'dirt_path', 'mud', 'muddy_mangrove_roots', 'clay');
  const stone = of('stone', 'granite', 'diorite', 'andesite', 'deepslate', 'tuff', 'calcite',
    'dripstone_block', 'cobblestone', 'gravel');
  const sandy = of('sand', 'red_sand', 'sandstone', 'red_sandstone', 'gravel');
  for (const t of terracotta) sandy.add(t);

  _sets = {
    leaves, soft, terracotta, dirtLike, stone, sandy,
    // ground a normal tree accepts
    treeSoil: of('grass_block', 'dirt', 'coarse_dirt', 'podzol', 'mycelium', 'rooted_dirt',
      'moss_block', 'farmland', 'mud', 'muddy_mangrove_roots'),
    // ground a small plant accepts
    plantSoil: of('grass_block', 'dirt', 'coarse_dirt', 'podzol', 'mycelium', 'rooted_dirt',
      'moss_block', 'farmland', 'mud'),
    grassOnly: of('grass_block', 'moss_block', 'podzol', 'mycelium'),
    netherSoil: of('netherrack', 'crimson_nylium', 'warped_nylium', 'soul_sand', 'soul_soil',
      'basalt', 'blackstone', 'magma_block'),
    // ore hosts
    oreHost: of('stone', 'granite', 'diorite', 'andesite', 'deepslate', 'tuff', 'calcite',
      'dripstone_block'),
    blobHost: of('stone', 'granite', 'diorite', 'andesite', 'tuff'),
    netherHost: of('netherrack', 'basalt', 'blackstone', 'crimson_nylium', 'warped_nylium',
      'soul_soil', 'magma_block'),
    springHost: of('stone', 'granite', 'diorite', 'andesite', 'deepslate', 'tuff', 'netherrack',
      'basalt', 'blackstone', 'dirt', 'sandstone', 'red_sandstone', 'gravel', 'calcite',
      'dripstone_block'),
    diskHost: of('dirt', 'grass_block', 'coarse_dirt', 'podzol', 'sand', 'red_sand', 'gravel',
      'clay', 'mud', 'stone', 'mycelium'),
  };
  return _sets;
}

// ---------------------------------------------------------------------------
// Bounded writing
// ---------------------------------------------------------------------------

// While a chunk is being decorated we refuse writes outside its 3x3
// neighbourhood; those chunks are the only ones world.js guarantees exist.
let _bx0 = -Infinity, _bz0 = -Infinity, _bx1 = Infinity, _bz1 = Infinity;

function pushBounds(cx, cz) {
  const saved = [_bx0, _bz0, _bx1, _bz1];
  _bx0 = (cx - 1) << 4; _bz0 = (cz - 1) << 4;
  _bx1 = ((cx + 2) << 4) - 1; _bz1 = ((cz + 2) << 4) - 1;
  return saved;
}
function popBounds(saved) { _bx0 = saved[0]; _bz0 = saved[1]; _bx1 = saved[2]; _bz1 = saved[3]; }

/** Guarded block write. Returns true when the world actually changed. */
function set(world, x, y, z, id, meta = 0) {
  if (y < 1 || y >= WORLD_HEIGHT) return false;
  if (x < _bx0 || x > _bx1 || z < _bz0 || z > _bz1) return false;
  return world.setBlock(x, y, z, id, meta, GEN);
}

const gid = (world, x, y, z) => world.getBlock(x, y, z);

/** True when this position holds nothing worth protecting (air, plants, water). */
function isSoft(world, x, y, z) {
  const b = gid(world, x, y, z);
  return b === 0 || S().soft.has(b) || S().leaves.has(b);
}
function isAirLike(world, x, y, z) {
  const b = gid(world, x, y, z);
  return b === 0 || S().soft.has(b);
}
function isWater(world, x, y, z) {
  const d = getBlock(gid(world, x, y, z));
  return d.liquid === 'water';
}
function isOpaqueAt(world, x, y, z) {
  const b = gid(world, x, y, z);
  if (b === 0) return false;
  const d = getBlock(b);
  return d.opaque && d.solid;
}

/** Places a block only where something soft already is (never carves terrain). */
function setSoft(world, x, y, z, id, meta = 0) {
  if (!isSoft(world, x, y, z)) return false;
  return set(world, x, y, z, id, meta);
}
/** Leaves never overwrite logs or solid terrain. */
function setLeaf(world, x, y, z, id, meta = 0) {
  const b = gid(world, x, y, z);
  if (b !== 0 && !S().soft.has(b)) return false;
  return set(world, x, y, z, id, meta);
}

// ---------------------------------------------------------------------------
// Column scanning
// ---------------------------------------------------------------------------

const _col = { y: -1, id: 0, waterY: -1, fluid: 0 };

/**
 * Walks a column downward and reports the topmost real ground block, the
 * highest liquid above it, and that liquid's id. y = -1 means "no ground".
 */
function scanColumn(world, x, z) {
  _col.y = -1; _col.id = 0; _col.waterY = -1; _col.fluid = 0;
  let y = world.getHeight(x, z);
  if (y > WORLD_HEIGHT - 1) y = WORLD_HEIGHT - 1;
  const s = S();
  for (; y >= 0; y--) {
    const b = gid(world, x, y, z);
    if (b === 0) continue;
    const d = getBlock(b);
    if (d.liquid) { if (_col.waterY < 0) { _col.waterY = y; _col.fluid = b; } continue; }
    if (s.soft.has(b) || s.leaves.has(b)) continue;
    _col.y = y; _col.id = b;
    return _col;
  }
  return _col;
}

/** Y of the first free block above solid ground in this column, or -1. */
function surfaceY(world, x, z) {
  const c = scanColumn(world, x, z);
  return c.y < 0 ? -1 : c.y + 1;
}

/** Scans down from y for a cave floor (solid block with air above). Returns floor y or -1. */
function findFloor(world, x, y, z, maxDrop = 32) {
  let yy = Math.min(y, WORLD_HEIGHT - 2);
  for (let i = 0; i < maxDrop && yy > 1; i++, yy--) {
    if (isAirLike(world, x, yy, z) && !isAirLike(world, x, yy - 1, z)) return yy - 1;
  }
  return -1;
}

/** Scans up from y for a cave ceiling (solid block with air below). Returns ceiling y or -1. */
function findCeiling(world, x, y, z, maxRise = 32) {
  let yy = Math.max(y, 1);
  for (let i = 0; i < maxRise && yy < WORLD_HEIGHT - 1; i++, yy++) {
    if (isAirLike(world, x, yy, z) && !isAirLike(world, x, yy + 1, z)) return yy + 1;
  }
  return -1;
}

/**
 * Is there head room for a trunk of `height` and a canopy of `radius`?
 * The tested volume tapers like a real tree: just the trunk at the base, a
 * one-block margin along the bole, the full canopy width only near the top.
 * A straight box here would reject every tree standing on a slope.
 */
function spaceClear(world, x, y, z, height, radius, allowWater = false) {
  if (y + height >= WORLD_HEIGHT - 1) return false;
  const flareAt = Math.max(1, height - 4);
  for (let dy = 0; dy < height; dy++) {
    const r = dy === 0 ? 0 : dy < flareAt ? Math.min(1, radius) : radius;
    for (let dz = -r; dz <= r; dz++) {
      for (let dx = -r; dx <= r; dx++) {
        const b = gid(world, x + dx, y + dy, z + dz);
        if (b === 0) continue;
        const d = getBlock(b);
        if (d.liquid) { if (allowWater) continue; return false; }
        if (S().soft.has(b) || S().leaves.has(b)) continue;
        return false;
      }
    }
  }
  return true;
}

function soilAt(world, x, y, z, allowed) { return allowed.has(gid(world, x, y, z)); }

/** Grass turns to dirt under a big trunk, exactly like vanilla. */
function rootDirt(world, x, y, z, dirtId) {
  const b = gid(world, x, y, z);
  if (S().treeSoil.has(b) && b !== dirtId) set(world, x, y, z, dirtId, 0);
}

// ---------------------------------------------------------------------------
// Shape primitives
// ---------------------------------------------------------------------------

/**
 * One round leaf layer. The shape is a square with rounded corners (so the
 * axis tips at +-r survive), and `trim` is the chance that a diagonal shoulder
 * cell is dropped - that is what gives vanilla canopies their ragged edge.
 */
function leafDisc(world, cx, y, cz, r, leaf, rng, trim = 0) {
  if (r < 0) return;
  const lim = r * r + r;
  for (let dz = -r; dz <= r; dz++) {
    const az = dz < 0 ? -dz : dz;
    for (let dx = -r; dx <= r; dx++) {
      const ax = dx < 0 ? -dx : dx;
      if (dx * dx + dz * dz > lim) continue;
      const shoulder = (ax === r || az === r) && ax + az > r;
      if (trim > 0 && shoulder && rng.next() < trim) continue;
      setLeaf(world, cx + dx, y, cz + dz, leaf);
    }
  }
}

/** Squashed ellipsoid of leaves, used for canopy clusters. */
function leafBlob(world, cx, cy, cz, r, leaf, rng, squash = 0.75, trim = 0.25) {
  const ry = Math.max(1, Math.round(r * squash));
  for (let dy = -ry; dy <= ry; dy++) {
    for (let dz = -r; dz <= r; dz++) {
      for (let dx = -r; dx <= r; dx++) {
        const fy = dy / (ry + 0.35), fx = dx / (r + 0.35), fz = dz / (r + 0.35);
        const d = fx * fx + fy * fy + fz * fz;
        if (d > 1) continue;
        if (d > 0.55 && rng.next() < trim) continue;
        setLeaf(world, cx + dx, cy + dy, cz + dz, leaf);
      }
    }
  }
}

/** Straight run of logs. axis: 0 = y, 1 = x, 2 = z (the 'column' model meta). */
function logColumn(world, x, y, z, height, log, axis = 0) {
  for (let i = 0; i < height; i++) setSoft(world, x, y + i, z, log, axis);
}

/** Bresenham-ish log line from a to b; picks the log axis per step. */
function logLine(world, x0, y0, z0, x1, y1, z1, log) {
  const dx = x1 - x0, dy = y1 - y0, dz = z1 - z0;
  const steps = Math.max(Math.abs(dx), Math.abs(dy), Math.abs(dz));
  if (steps === 0) { setSoft(world, x0, y0, z0, log, 0); return; }
  const adx = Math.abs(dx), ady = Math.abs(dy), adz = Math.abs(dz);
  const axis = ady >= adx && ady >= adz ? 0 : adx >= adz ? 1 : 2;
  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    setSoft(world, Math.round(x0 + dx * t), Math.round(y0 + dy * t), Math.round(z0 + dz * t), log, axis);
  }
}

// Vine metadata: one bit per horizontal face, indexed like HFACE_*
// (0 = north/-Z, 1 = east/+X, 2 = south/+Z, 3 = west/-X). The bit marks the
// side the vine is hanging off, i.e. where its supporting block is.
const VINE_BIT = [1, 2, 4, 8];

/** Hangs a curtain of vines downward from (x,y,z) against face `hface`. */
function hangVines(world, x, y, z, maxLen, hface, rng, vineId) {
  const d = HFACE_DIRS[hface];
  let placed = 0;
  for (let i = 0; i < maxLen; i++) {
    const yy = y - i;
    if (yy < 1) break;
    if (!isAirLike(world, x, yy, z)) break;
    if (!isOpaqueAt(world, x + d[0], yy, z + d[2]) && !S().leaves.has(gid(world, x + d[0], yy, z + d[2]))) break;
    if (!set(world, x, yy, z, vineId, VINE_BIT[hface])) break;
    placed++;
    if (i > 1 && rng.next() < 0.25) break;
  }
  return placed > 0;
}

/** Drapes vines off the outside of a canopy. */
function drapeCanopy(world, cx, cy, cz, r, rng, vineId, maxLen = 6) {
  for (let hf = 0; hf < 4; hf++) {
    const d = HFACE_DIRS[hf];
    for (let k = 0; k < 6; k++) {
      const along = rng.range(-r, r);
      const x = cx + (d[0] !== 0 ? d[0] * (r + 1) : along);
      const z = cz + (d[2] !== 0 ? d[2] * (r + 1) : along);
      const y = cy - rng.int(3);
      // the vine hangs on the face pointing back at the canopy
      hangVines(world, x, y, z, rng.range(2, maxLen), (hf + 2) & 3, rng, vineId);
    }
  }
}

// ---------------------------------------------------------------------------
// Feature registry
// ---------------------------------------------------------------------------

/** name -> function(world, x, y, z, rng, args) -> boolean */
export const FEATURES = new Map();

// How decorateChunk should choose a y for each feature.
const FEATURE_MODE = new Map();

/** Registers a feature generator under a name. */
export function registerFeature(name, fn) {
  FEATURES.set(name, fn);
  if (!FEATURE_MODE.has(name)) FEATURE_MODE.set(name, 'surface');
  return fn;
}

/** Internal: register with an explicit y-selection mode. */
function def(name, mode, fn) {
  FEATURE_MODE.set(name, mode);
  return registerFeature(name, fn);
}

/**
 * Runs one feature. Never throws: a broken feature must not abort chunk
 * generation. Returns whether anything was placed.
 */
export function placeFeature(name, world, x, y, z, rng, args) {
  const fn = FEATURES.get(name);
  if (!fn || !world) return false;
  const r = rng || new RNG(hash3((world.seed | 0) ^ 0x1234, x, y, z));
  try {
    return !!fn(world, x | 0, y | 0, z | 0, r, args || null);
  } catch (e) {
    console.error('[features] "' + name + '" failed at', x, y, z, e);
    return false;
  }
}

// ===========================================================================
// TREES
// ===========================================================================

// Oak: 4-6 logs, two wide layers with trimmed corners then a small crown.
const OAK_LAYERS = [[-3, 2, 0.45], [-2, 2, 0.45], [-1, 1, 0], [0, 1, 0.2], [1, 1, 0.85]];

function smallTree(world, x, y, z, rng, o) {
  const log = bid(o.log), leaf = bid(o.leaves);
  const soil = o.soil || S().treeSoil;
  if (!soilAt(world, x, y - 1, z, soil)) return false;
  const h = o.height || rng.range(o.minH, o.maxH);
  if (!spaceClear(world, x, y, z, h + 2, 2, !!o.water)) return false;
  const top = y + h - 1;
  const layers = o.layers || OAK_LAYERS;
  for (const [dy, r, trim] of layers) {
    const yy = top + dy;
    if (yy <= y) continue;
    leafDisc(world, x, yy, z, r, leaf, rng, trim);
  }
  logColumn(world, x, y, z, h, log, 0);
  rootDirt(world, x, y - 1, z, bid('dirt'));
  if (o.vines) drapeCanopy(world, x, top - 1, z, 2, rng, bid('vine'), o.vineLen || 6);
  if (o.beehive && rng.next() < 0.05) {
    // A bee nest tucked under the canopy on a random side.
    const hf = rng.int(4), d = HFACE_DIRS[hf];
    setSoft(world, x + d[0], top - 2, z + d[2], bid('bee_nest'), hf);
  }
  return true;
}

def('oak_tree', 'surface', (world, x, y, z, rng) =>
  smallTree(world, x, y, z, rng, { log: 'oak_log', leaves: 'oak_leaves', minH: 4, maxH: 6, beehive: true }));

def('birch_tree', 'surface', (world, x, y, z, rng) =>
  smallTree(world, x, y, z, rng, { log: 'birch_log', leaves: 'birch_leaves', minH: 5, maxH: 7, beehive: true }));

const TALL_BIRCH_LAYERS = [[-4, 2, 0.6], [-3, 2, 0.4], [-2, 2, 0.4], [-1, 1, 0], [0, 1, 0.2], [1, 1, 0.85]];
def('tall_birch_tree', 'surface', (world, x, y, z, rng) =>
  smallTree(world, x, y, z, rng, {
    log: 'birch_log', leaves: 'birch_leaves', minH: 8, maxH: 11, layers: TALL_BIRCH_LAYERS,
  }));

def('swamp_tree', 'surface', (world, x, y, z, rng) => {
  // Swamp oaks stand with their feet in the water and trail vines everywhere.
  const soil = S().treeSoil;
  let base = y;
  if (isWater(world, x, base, z)) base = y; // trunk starts in the water column
  if (!soilAt(world, x, base - 1, z, soil) && !soilAt(world, x, base - 1, z, S().dirtLike)) return false;
  return smallTree(world, x, base, z, rng, {
    log: 'oak_log', leaves: 'oak_leaves', minH: 5, maxH: 7, water: true, vines: true, vineLen: 8,
  });
});

def('big_oak_tree', 'surface', (world, x, y, z, rng, args) => {
  // "Fancy" oak: a tall trunk with 3-5 branches, each ending in a leaf cluster.
  const log = bid((args && args.log) || 'oak_log');
  const leaf = bid((args && args.leaves) || 'oak_leaves');
  if (!soilAt(world, x, y - 1, z, S().treeSoil)) return false;
  const h = rng.range(9, 14);
  if (!spaceClear(world, x, y, z, h + 4, 3)) return false;
  const top = y + h;
  logColumn(world, x, y, z, h, log, 0);
  rootDirt(world, x, y - 1, z, bid('dirt'));

  const branches = rng.range(3, 5);
  const start = y + Math.floor(h * 0.45);
  for (let i = 0; i < branches; i++) {
    const by = rng.range(start, top - 1);
    const ang = rng.next() * Math.PI * 2;
    const len = rng.range(2, 4);
    const ex = x + Math.round(Math.cos(ang) * len);
    const ez = z + Math.round(Math.sin(ang) * len);
    const ey = by + rng.range(1, 3);
    logLine(world, x, by, z, ex, ey, ez, log);
    leafBlob(world, ex, ey + 1, ez, rng.range(2, 3), leaf, rng, 0.7, 0.3);
  }
  leafBlob(world, x, top, z, 3, leaf, rng, 0.7, 0.25);
  leafDisc(world, x, top + 2, z, 1, leaf, rng, 0.6);
  return true;
});
FEATURES.set('fancy_oak_tree', FEATURES.get('big_oak_tree'));
FEATURE_MODE.set('fancy_oak_tree', 'surface');

def('spruce_tree', 'surface', (world, x, y, z, rng) => {
  // Layered cone: the radius steps outward as we walk down from the tip.
  const log = bid('spruce_log'), leaf = bid('spruce_leaves');
  if (!soilAt(world, x, y - 1, z, S().treeSoil)) return false;
  const h = rng.range(6, 10);
  if (!spaceClear(world, x, y, z, h + 2, 3)) return false;
  const top = y + h;
  const bare = 1 + rng.int(2);
  const maxR = 2 + rng.int(2);
  let r = 0;
  for (let yy = top; yy >= y + bare; yy--) {
    leafDisc(world, x, yy, z, r, leaf, rng, r >= 2 ? 0.3 : 0);
    if (r < maxR && ((top - yy) & 1) === 1) r++;
    else if (yy === y + bare + 1) r = Math.max(0, r - 1);
  }
  setLeaf(world, x, top + 1, z, leaf);
  logColumn(world, x, y, z, h, log, 0);
  rootDirt(world, x, y - 1, z, bid('dirt'));
  return true;
});

def('pine_tree', 'surface', (world, x, y, z, rng) => {
  // Bare trunk with a compact crown at the very top.
  const log = bid('spruce_log'), leaf = bid('spruce_leaves');
  if (!soilAt(world, x, y - 1, z, S().treeSoil)) return false;
  const h = rng.range(9, 14);
  if (!spaceClear(world, x, y, z, h + 2, 3)) return false;
  const top = y + h;
  const crown = rng.range(4, 6);
  const maxR = rng.range(2, 3);
  for (let i = 0; i <= crown; i++) {
    let r = i === 0 ? 0 : Math.min(maxR, Math.ceil(i / 2));
    if (i === crown) r = Math.max(0, r - 1);     // pinch the skirt back in
    leafDisc(world, x, top - i, z, r, leaf, rng, r >= 2 ? 0.25 : 0);
  }
  setLeaf(world, x, top + 1, z, leaf);
  logColumn(world, x, y, z, h, log, 0);
  rootDirt(world, x, y - 1, z, bid('dirt'));
  return true;
});

/** Shared 2x2-trunk giant. Used by mega spruce and mega jungle. */
function megaTree(world, x, y, z, rng, o) {
  const log = bid(o.log), leaf = bid(o.leaves);
  const soil = S().treeSoil;
  for (let dz = 0; dz < 2; dz++) {
    for (let dx = 0; dx < 2; dx++) {
      if (!soilAt(world, x + dx, y - 1, z + dz, soil)) return false;
    }
  }
  const h = rng.range(o.minH, o.maxH);
  if (!spaceClear(world, x, y, z, h + 3, o.radius + 1)) return false;

  // Trunk + a ring of podzol / dirt under it.
  for (let dz = 0; dz < 2; dz++) {
    for (let dx = 0; dx < 2; dx++) {
      logColumn(world, x + dx, y, z + dz, h, log, 0);
      rootDirt(world, x + dx, y - 1, z + dz, bid(o.ground || 'dirt'));
    }
  }
  if (o.ground) {
    for (let dz = -2; dz <= 3; dz++) {
      for (let dx = -2; dx <= 3; dx++) {
        if (rng.next() < 0.5) continue;
        const gy = y - 1;
        if (S().grassOnly.has(gid(world, x + dx, gy, z + dz))) set(world, x + dx, gy, z + dz, bid(o.ground), 0);
      }
    }
  }

  const top = y + h - 1;
  if (o.cone) {
    // Mega spruce: a big stepped cone starting a third of the way up.
    let r = 0;
    const bottom = y + Math.floor(h * 0.35);
    for (let yy = top + 1; yy >= bottom; yy--) {
      leafDisc(world, x, yy, z, r, leaf, rng, r >= 3 ? 0.35 : 0.1);
      if (r > 0) leafDisc(world, x + 1, yy, z + 1, r, leaf, rng, r >= 3 ? 0.35 : 0.1);
      if (r < o.radius && ((top + 1 - yy) % 2) === 1) r++;
    }
    setLeaf(world, x, top + 2, z, leaf);
    setLeaf(world, x + 1, top + 2, z + 1, leaf);
  } else {
    // Mega jungle: heavy crown plus mid-height branch clusters.
    leafBlob(world, x, top + 1, z, o.radius, leaf, rng, 0.55, 0.3);
    leafBlob(world, x + 1, top + 1, z + 1, o.radius, leaf, rng, 0.55, 0.3);
    const branches = rng.range(2, 4);
    for (let i = 0; i < branches; i++) {
      const by = rng.range(y + Math.floor(h * 0.5), top - 2);
      const hf = rng.int(4), d = HFACE_DIRS[hf];
      const len = rng.range(2, 4);
      const ex = x + d[0] * len + (d[0] > 0 ? 1 : 0);
      const ez = z + d[2] * len + (d[2] > 0 ? 1 : 0);
      logLine(world, x + (d[0] > 0 ? 1 : 0), by, z + (d[2] > 0 ? 1 : 0), ex, by + 1, ez, log);
      leafBlob(world, ex, by + 2, ez, 2, leaf, rng, 0.6, 0.3);
    }
  }

  if (o.vines) {
    const vine = bid('vine');
    for (let i = 0; i < 40; i++) {
      const hf = rng.int(4), d = HFACE_DIRS[hf];
      const along = rng.int(2);
      const tx = x + (d[0] !== 0 ? (d[0] > 0 ? 2 : -1) : along);
      const tz = z + (d[2] !== 0 ? (d[2] > 0 ? 2 : -1) : along);
      const ty = rng.range(y + 1, top);
      hangVines(world, tx, ty, tz, rng.range(2, 8), (hf + 2) & 3, rng, vine);
    }
    drapeCanopy(world, x, top, z, o.radius, rng, vine, 9);
  }
  if (o.cocoa) scatterCocoa(world, x, y, z, h, rng, 2);
  return true;
}

def('mega_spruce_tree', 'surface', (world, x, y, z, rng) =>
  megaTree(world, x, y, z, rng, {
    log: 'spruce_log', leaves: 'spruce_leaves', minH: 13, maxH: 20, radius: 4,
    cone: true, ground: 'podzol', vines: false,
  }));

def('mega_jungle_tree', 'surface', (world, x, y, z, rng) =>
  megaTree(world, x, y, z, rng, {
    log: 'jungle_log', leaves: 'jungle_leaves', minH: 12, maxH: 19, radius: 4,
    cone: false, vines: true, cocoa: true,
  }));

/** Cocoa pods stuck on the sides of a jungle trunk. */
function scatterCocoa(world, x, y, z, h, rng, width = 1) {
  const cocoa = bid('cocoa');
  const tries = rng.range(1, 4);
  for (let i = 0; i < tries; i++) {
    const hf = rng.int(4), d = HFACE_DIRS[hf];
    const along = width > 1 ? rng.int(width) : 0;
    const tx = x + (d[0] !== 0 ? (d[0] > 0 ? width : -1) : along);
    const tz = z + (d[2] !== 0 ? (d[2] > 0 ? width : -1) : along);
    const ty = y + rng.range(2, Math.max(2, h - 2));
    if (!isAirLike(world, tx, ty, tz)) continue;
    set(world, tx, ty, tz, cocoa, rng.int(3));
  }
}

def('jungle_tree', 'surface', (world, x, y, z, rng) => {
  const log = bid('jungle_log'), leaf = bid('jungle_leaves');
  if (!soilAt(world, x, y - 1, z, S().treeSoil)) return false;
  const h = rng.range(7, 12);
  if (!spaceClear(world, x, y, z, h + 3, 2)) return false;
  const top = y + h - 1;
  leafDisc(world, x, top - 2, z, 2, leaf, rng, 0.4);
  leafDisc(world, x, top - 1, z, 2, leaf, rng, 0.3);
  leafDisc(world, x, top, z, 1, leaf, rng, 0.1);
  leafDisc(world, x, top + 1, z, 1, leaf, rng, 0.7);
  // one side branch, jungle style
  if (rng.next() < 0.6) {
    const hf = rng.int(4), d = HFACE_DIRS[hf];
    const by = rng.range(y + 3, top - 2);
    logLine(world, x, by, z, x + d[0] * 2, by + 1, z + d[2] * 2, log);
    leafBlob(world, x + d[0] * 2, by + 2, z + d[2] * 2, 2, leaf, rng, 0.6, 0.3);
  }
  logColumn(world, x, y, z, h, log, 0);
  rootDirt(world, x, y - 1, z, bid('dirt'));
  drapeCanopy(world, x, top - 1, z, 2, rng, bid('vine'), 8);
  const vine = bid('vine');
  for (let i = 0; i < 8; i++) {
    const hf = rng.int(4), d = HFACE_DIRS[hf];
    hangVines(world, x + d[0], rng.range(y + 1, top), z + d[2], rng.range(1, 5), (hf + 2) & 3, rng, vine);
  }
  scatterCocoa(world, x, y, z, h, rng, 1);
  return true;
});

def('acacia_tree', 'surface', (world, x, y, z, rng) => {
  // Straight for a while, then a hard lean, then a flat parasol canopy.
  const log = bid('acacia_log'), leaf = bid('acacia_leaves');
  if (!soilAt(world, x, y - 1, z, S().treeSoil)) return false;
  const straight = rng.range(3, 5);
  const lean = rng.range(2, 4);
  if (!spaceClear(world, x, y, z, straight + lean + 3, 3)) return false;
  logColumn(world, x, y, z, straight, log, 0);
  rootDirt(world, x, y - 1, z, bid('dirt'));

  const hf = rng.int(4), d = HFACE_DIRS[hf];
  let tx = x, tz = z, ty = y + straight - 1;
  for (let i = 0; i < lean; i++) {
    // step out one and up one; every other step also gains a vertical log so
    // the bole reads as a diagonal rather than a staircase of single blocks
    tx += d[0]; tz += d[2]; ty += 1;
    setSoft(world, tx, ty, tz, log, d[0] !== 0 ? 1 : 2);
    if (i !== lean - 1 && (i & 1) === 0) {
      ty += 1;
      setSoft(world, tx, ty, tz, log, 0);
    }
  }
  // wide flat crown at the tip
  leafDisc(world, tx, ty + 1, tz, 3, leaf, rng, 0.35);
  leafDisc(world, tx, ty + 2, tz, 2, leaf, rng, 0.5);
  leafDisc(world, tx, ty, tz, 2, leaf, rng, 0.75);

  // a second, lower arm on the opposite side
  if (rng.next() < 0.6) {
    const hf2 = (hf + 2) & 3, d2 = HFACE_DIRS[hf2];
    let ax = x, az = z, ay = y + straight - 2;
    const alen = rng.range(1, 3);
    for (let i = 0; i < alen; i++) {
      ax += d2[0]; az += d2[2]; ay++;
      setSoft(world, ax, ay, az, log, d2[0] !== 0 ? 1 : 2);
    }
    leafDisc(world, ax, ay + 1, az, 2, leaf, rng, 0.4);
    leafDisc(world, ax, ay + 2, az, 1, leaf, rng, 0.5);
  }
  return true;
});

def('dark_oak_tree', 'surface', (world, x, y, z, rng) => {
  const log = bid('dark_oak_log'), leaf = bid('dark_oak_leaves');
  const soil = S().treeSoil;
  for (let dz = 0; dz < 2; dz++) {
    for (let dx = 0; dx < 2; dx++) if (!soilAt(world, x + dx, y - 1, z + dz, soil)) return false;
  }
  const h = rng.range(6, 9);
  if (!spaceClear(world, x, y, z, h + 3, 3)) return false;
  const top = y + h - 1;
  for (let dz = 0; dz < 2; dz++) {
    for (let dx = 0; dx < 2; dx++) {
      logColumn(world, x + dx, y, z + dz, h, log, 0);
      rootDirt(world, x + dx, y - 1, z + dz, bid('dirt'));
    }
  }
  // Wide, flat, slightly ragged canopy sitting on top of the 2x2 trunk.
  for (let dz = -2; dz <= 3; dz++) {
    for (let dx = -2; dx <= 3; dx++) {
      const ex = Math.max(0, Math.abs(dx - 0.5) - 0.5) + Math.max(0, Math.abs(dz - 0.5) - 0.5);
      if (ex > 3) continue;
      if (ex > 2 && rng.next() < 0.5) continue;
      setLeaf(world, x + dx, top, z + dz, leaf);
      setLeaf(world, x + dx, top - 1, z + dz, leaf);
    }
  }
  for (let dz = -1; dz <= 2; dz++) {
    for (let dx = -1; dx <= 2; dx++) {
      if (rng.next() < 0.3) continue;
      setLeaf(world, x + dx, top + 1, z + dz, leaf);
    }
  }
  // a couple of stumpy side branches
  for (let i = 0; i < 2; i++) {
    const hf = rng.int(4), d = HFACE_DIRS[hf];
    const by = rng.range(y + 2, top - 1);
    setSoft(world, x + (d[0] > 0 ? 2 : d[0]), by, z + (d[2] > 0 ? 2 : d[2]), log, d[0] !== 0 ? 1 : 2);
  }
  return true;
});

def('mangrove_tree', 'surface', (world, x, y, z, rng) => {
  // Trunk lifted on a tangle of stilt roots, propagules under the canopy.
  const log = bid('mangrove_log'), leaf = bid('mangrove_leaves');
  const roots = bid('mangrove_roots'), propagule = bid('mangrove_propagule');
  const okGround = new Set([...S().treeSoil, bid('mud'), bid('clay'), bid('sand'), bid('muddy_mangrove_roots')]);
  if (!okGround.has(gid(world, x, y - 1, z))) return false;
  const lift = rng.range(1, 3);
  const h = rng.range(5, 8);
  if (!spaceClear(world, x, y, z, lift + h + 3, 3, true)) return false;

  // stilt roots: 5-8 legs sloping outward and down to the ground
  const legs = rng.range(5, 8);
  for (let i = 0; i < legs; i++) {
    const ang = (i / legs) * Math.PI * 2 + rng.float(-0.4, 0.4);
    const rx = x + Math.round(Math.cos(ang) * rng.float(1, 2.2));
    const rz = z + Math.round(Math.sin(ang) * rng.float(1, 2.2));
    for (let yy = y + lift; yy >= y - 3; yy--) {
      const b = gid(world, rx, yy, rz);
      const d = getBlock(b);
      if (b !== 0 && !d.liquid && !S().soft.has(b)) break;
      set(world, rx, yy, rz, roots, 0);
    }
    // knit the leg back to the trunk
    logLine(world, rx, y + lift, rz, x, y + lift + 1, z, roots);
  }
  // and a core of roots straight down, so the trunk never floats
  for (let yy = y + lift; yy >= y - 3; yy--) {
    const b = gid(world, x, yy, z);
    const bd = getBlock(b);
    if (b !== 0 && !bd.liquid && !S().soft.has(b)) break;
    set(world, x, yy, z, roots, 0);
  }
  const base = y + lift;
  logColumn(world, x, base, z, h, log, 0);
  const top = base + h - 1;
  leafBlob(world, x, top + 1, z, 3, leaf, rng, 0.6, 0.3);
  leafDisc(world, x, top + 3, z, 1, leaf, rng, 0.5);
  // hanging propagules under the outer canopy
  for (let i = 0; i < 8; i++) {
    const dx = rng.range(-3, 3), dz = rng.range(-3, 3);
    const px = x + dx, pz = z + dz;
    for (let yy = top + 1; yy > top - 3; yy--) {
      if (S().leaves.has(gid(world, px, yy, pz)) && isAirLike(world, px, yy - 1, pz)) {
        set(world, px, yy - 1, pz, propagule, rng.int(4));
        break;
      }
    }
  }
  drapeCanopy(world, x, top, z, 3, rng, bid('vine'), 5);
  return true;
});

def('cherry_tree', 'surface', (world, x, y, z, rng) => {
  // Pink canopy made of overlapping clusters, with drooping fringes.
  const log = bid('cherry_log'), leaf = bid('cherry_leaves');
  if (!soilAt(world, x, y - 1, z, S().treeSoil)) return false;
  const h = rng.range(6, 9);
  if (!spaceClear(world, x, y, z, h + 4, 4)) return false;
  logColumn(world, x, y, z, h, log, 0);
  rootDirt(world, x, y - 1, z, bid('dirt'));
  const top = y + h - 1;

  const arms = rng.range(2, 4);
  const centers = [[x, top + 2, z, 3]];
  for (let i = 0; i < arms; i++) {
    const ang = (i / arms) * Math.PI * 2 + rng.float(-0.5, 0.5);
    const len = rng.range(2, 3);
    const ex = x + Math.round(Math.cos(ang) * len);
    const ez = z + Math.round(Math.sin(ang) * len);
    const ey = top - rng.int(2);
    logLine(world, x, top - 1, z, ex, ey + 1, ez, log);
    centers.push([ex, ey + 2, ez, rng.range(2, 3)]);
  }
  for (const [cx, cy, cz, r] of centers) leafBlob(world, cx, cy, cz, r, leaf, rng, 0.55, 0.3);
  // drooping clusters: single leaf columns dangling off the canopy underside
  for (let i = 0; i < 14; i++) {
    const c = centers[rng.int(centers.length)];
    const dx = rng.range(-c[3], c[3]), dz = rng.range(-c[3], c[3]);
    const px = c[0] + dx, pz = c[2] + dz;
    for (let yy = c[1]; yy > c[1] - 3; yy--) {
      if (S().leaves.has(gid(world, px, yy, pz)) && isAirLike(world, px, yy - 1, pz)) {
        const drop = rng.range(1, 3);
        for (let k = 1; k <= drop; k++) setLeaf(world, px, yy - k, pz, leaf);
        break;
      }
    }
  }
  return true;
});

def('azalea_tree', 'under', (world, x, y, z, rng) => {
  // Lush-cave azalea: rooted dirt bulb, short trunk, azalea foliage, moss skirt.
  const floor = findFloor(world, x, y, z, 40);
  if (floor < 2) return false;
  const base = floor + 1;
  if (!spaceClear(world, x, base, z, 6, 2)) return false;
  const rooted = bid('rooted_dirt'), log = bid('oak_log');
  const az = bid('azalea_leaves'), fl = bid('flowering_azalea_leaves');
  const moss = bid('moss_block'), carpet = bid('moss_carpet');

  for (let dz = -2; dz <= 2; dz++) {
    for (let dx = -2; dx <= 2; dx++) {
      const d2 = dx * dx + dz * dz;
      if (d2 > 5) continue;
      const b = gid(world, x + dx, floor, z + dz);
      if (b !== 0 && !getBlock(b).liquid) set(world, x + dx, floor, z + dz, d2 <= 1 ? rooted : moss, 0);
      if (d2 > 1 && rng.next() < 0.5) setSoft(world, x + dx, floor + 1, z + dz, carpet, 0);
      if (d2 <= 2 && rng.next() < 0.4) set(world, x + dx, floor - 1, z + dz, rooted, 0);
    }
  }
  const h = rng.range(2, 3);
  logColumn(world, x, base, z, h, log, 0);
  const top = base + h - 1;
  for (let dy = 0; dy <= 2; dy++) {
    const r = dy === 2 ? 1 : 2;
    for (let dz = -r; dz <= r; dz++) {
      for (let dx = -r; dx <= r; dx++) {
        if (dx * dx + dz * dz > r * r + 1) continue;
        if (rng.next() < 0.2) continue;
        setLeaf(world, x + dx, top + dy, z + dz, rng.next() < 0.3 ? fl : az);
      }
    }
  }
  // roots dangling below if the bulb overhangs
  const hr = bid('hanging_roots');
  for (let i = 0; i < 4; i++) {
    const dx = rng.range(-2, 2), dz = rng.range(-2, 2);
    if (isAirLike(world, x + dx, floor - 1, z + dz)) setSoft(world, x + dx, floor - 1, z + dz, hr, 0);
  }
  return true;
});
FEATURES.set('azalea', FEATURES.get('azalea_tree'));
FEATURE_MODE.set('azalea', 'under');

// ---- huge mushrooms -------------------------------------------------------

def('huge_red_mushroom', 'surface', (world, x, y, z, rng) => {
  const stem = bid('mushroom_stem'), cap = bid('red_mushroom_block');
  const soil = new Set([...S().treeSoil, bid('mycelium'), bid('podzol'), bid('crimson_nylium')]);
  if (!soil.has(gid(world, x, y - 1, z))) return false;
  const h = rng.range(4, 7);
  if (!spaceClear(world, x, y, z, h + 3, 3)) return false;
  logColumn(world, x, y, z, h, stem, 0);
  const top = y + h;
  // skirt ring, dome, crown
  for (let dz = -2; dz <= 2; dz++) {
    for (let dx = -2; dx <= 2; dx++) {
      const edge = Math.abs(dx) === 2 || Math.abs(dz) === 2;
      const corner = Math.abs(dx) === 2 && Math.abs(dz) === 2;
      if (corner) continue;
      if (edge) setSoft(world, x + dx, top - 1, z + dz, cap, 0);
      setSoft(world, x + dx, top, z + dz, cap, 0);
    }
  }
  for (let dz = -1; dz <= 1; dz++) {
    for (let dx = -1; dx <= 1; dx++) setSoft(world, x + dx, top + 1, z + dz, cap, 0);
  }
  return true;
});

def('huge_brown_mushroom', 'surface', (world, x, y, z, rng) => {
  const stem = bid('mushroom_stem'), cap = bid('brown_mushroom_block');
  const soil = new Set([...S().treeSoil, bid('mycelium'), bid('podzol')]);
  if (!soil.has(gid(world, x, y - 1, z))) return false;
  const h = rng.range(4, 6);
  if (!spaceClear(world, x, y, z, h + 2, 4)) return false;
  logColumn(world, x, y, z, h, stem, 0);
  const top = y + h;
  for (let dz = -3; dz <= 3; dz++) {
    for (let dx = -3; dx <= 3; dx++) {
      const d = Math.abs(dx) + Math.abs(dz);
      if (d > 4 || (Math.abs(dx) === 3 && Math.abs(dz) === 3)) continue;
      setSoft(world, x + dx, top, z + dz, cap, 0);
    }
  }
  return true;
});

/** Crimson / warped huge fungus. */
function hugeFungus(world, x, y, z, rng, kind) {
  const stem = bid(kind === 'crimson' ? 'crimson_stem' : 'warped_stem');
  const wart = bid(kind === 'crimson' ? 'nether_wart_block' : 'warped_wart_block');
  const shroom = bid('shroomlight');
  const nylium = bid(kind === 'crimson' ? 'crimson_nylium' : 'warped_nylium');
  const ground = gid(world, x, y - 1, z);
  if (ground !== nylium && ground !== bid('netherrack') && ground !== bid('soul_soil')) return false;
  const h = rng.range(5, 11);
  if (!spaceClear(world, x, y, z, h + 3, 3)) return false;
  logColumn(world, x, y, z, h, stem, 0);
  const top = y + h - 1;
  const r = rng.range(2, 3);
  for (let dy = 0; dy <= 2; dy++) {
    const rr = dy === 2 ? r - 1 : r;
    for (let dz = -rr; dz <= rr; dz++) {
      for (let dx = -rr; dx <= rr; dx++) {
        const d2 = dx * dx + dz * dz;
        if (d2 > rr * rr + 1) continue;
        if (dy === 0 && d2 <= 1) continue;           // hollow underside near the stem
        if (dy < 2 && d2 < (rr - 1) * (rr - 1)) continue;
        const b = rng.next() < 0.11 ? shroom : wart;
        setSoft(world, x + dx, top + dy, z + dz, b, 0);
      }
    }
  }
  // vines under the cap
  const vine = bid(kind === 'crimson' ? 'weeping_vines' : 'twisting_vines');
  const plant = bid(kind === 'crimson' ? 'weeping_vines_plant' : 'twisting_vines_plant');
  for (let i = 0; i < 8; i++) {
    const dx = rng.range(-r, r), dz = rng.range(-r, r);
    const px = x + dx, pz = z + dz;
    if (isAirLike(world, px, top - 1, pz) && !isAirLike(world, px, top, pz)) {
      const len = rng.range(1, 4);
      for (let k = 1; k <= len; k++) {
        if (!isAirLike(world, px, top - k, pz)) break;
        set(world, px, top - k, pz, k === len ? vine : plant, 0);
      }
    }
  }
  return true;
}

def('fungus_crimson', 'surface', (world, x, y, z, rng) => {
  if (rng.next() < 0.12) return hugeFungus(world, x, y, z, rng, 'crimson');
  return netherFloorPlant(world, x, y, z, rng, ['crimson_fungus', 'crimson_roots'], 'crimson_nylium');
});
def('fungus_warped', 'surface', (world, x, y, z, rng) => {
  if (rng.next() < 0.12) return hugeFungus(world, x, y, z, rng, 'warped');
  return netherFloorPlant(world, x, y, z, rng, ['warped_fungus', 'warped_roots', 'nether_sprouts'], 'warped_nylium');
});

function netherFloorPlant(world, x, y, z, rng, names, nylium) {
  const ok = new Set([bid(nylium), bid('netherrack'), bid('crimson_nylium'), bid('warped_nylium'), bid('soul_soil')]);
  let placed = false;
  for (let i = 0; i < 20; i++) {
    const px = x + rng.range(-3, 3), pz = z + rng.range(-3, 3);
    const py = surfaceY(world, px, pz);
    if (py < 1) continue;
    if (!ok.has(gid(world, px, py - 1, pz))) continue;
    if (!isAirLike(world, px, py, pz)) continue;
    if (set(world, px, py, pz, bid(names[rng.int(names.length)]), 0)) placed = true;
  }
  return placed;
}

// ===========================================================================
// SMALL PLANTS
// ===========================================================================

/** Places a two-block-tall plant; meta bit 3 marks the upper half. */
function setTall(world, x, y, z, id) {
  if (!isAirLike(world, x, y, z) || !isAirLike(world, x, y + 1, z)) return false;
  if (!set(world, x, y, z, id, 0)) return false;
  set(world, x, y + 1, z, id, 8);
  return true;
}

/** Scatters small plants over a disc, checking the ground under each. */
function patch(world, x, y, z, rng, o) {
  const soil = o.soil || S().plantSoil;
  const radius = o.radius || 4;
  const tries = o.tries || 24;
  let placed = 0;
  for (let i = 0; i < tries; i++) {
    const px = x + rng.range(-radius, radius);
    const pz = z + rng.range(-radius, radius);
    const py = surfaceY(world, px, pz);
    if (py < 1 || py >= WORLD_HEIGHT - 2) continue;
    if (Math.abs(py - y) > (o.slope ?? 3)) continue;
    if (!soil.has(gid(world, px, py - 1, pz))) continue;
    if (!isAirLike(world, px, py, pz)) continue;
    const pick = o.pick(rng);
    if (!pick) continue;
    if (pick.tall) { if (setTall(world, px, py, pz, bid(pick.name))) placed++; }
    else if (set(world, px, py, pz, bid(pick.name), pick.meta || 0)) placed++;
  }
  return placed > 0;
}

const GRASS_ONE = { name: 'short_grass' };
const TALLGRASS_TWO = { name: 'tall_grass', tall: true };
const FERN_ONE = { name: 'fern' };
const LARGEFERN_TWO = { name: 'large_fern', tall: true };

def('grass_patch', 'surface', (world, x, y, z, rng) =>
  patch(world, x, y, z, rng, {
    tries: 26, radius: 5, soil: S().grassOnly,
    pick: (r) => (r.next() < 0.08 ? FERN_ONE : GRASS_ONE),
  }));

def('tall_grass_patch', 'surface', (world, x, y, z, rng) =>
  patch(world, x, y, z, rng, {
    tries: 14, radius: 4, soil: S().grassOnly,
    pick: (r) => (r.next() < 0.15 ? LARGEFERN_TWO : TALLGRASS_TWO),
  }));

def('fern_patch', 'surface', (world, x, y, z, rng) =>
  patch(world, x, y, z, rng, {
    tries: 20, radius: 5, soil: S().grassOnly,
    pick: (r) => (r.next() < 0.2 ? LARGEFERN_TWO : FERN_ONE),
  }));

// The twelve small flowers plus the four two-block ones.
const FLOWERS = ['dandelion', 'poppy', 'blue_orchid', 'allium', 'azure_bluet', 'red_tulip',
  'orange_tulip', 'white_tulip', 'pink_tulip', 'oxeye_daisy', 'cornflower', 'lily_of_the_valley'];
const TALL_FLOWERS = ['sunflower', 'lilac', 'rose_bush', 'peony'];
const PLAINS_FLOWERS = ['dandelion', 'poppy', 'azure_bluet', 'red_tulip', 'orange_tulip',
  'white_tulip', 'pink_tulip', 'oxeye_daisy', 'cornflower'];
const DEFAULT_FLOWERS = ['dandelion', 'poppy', 'oxeye_daisy', 'cornflower', 'azure_bluet'];

function flowerPatch(world, x, y, z, rng, pool, tallChance, tallPool) {
  // One patch keeps a single dominant species, vanilla style.
  const main = pool[rng.int(pool.length)];
  return patch(world, x, y, z, rng, {
    tries: 20, radius: 4, soil: S().grassOnly,
    pick: (r) => {
      if (tallChance > 0 && r.next() < tallChance) {
        return { name: tallPool[r.int(tallPool.length)], tall: true };
      }
      return { name: r.next() < 0.7 ? main : pool[r.int(pool.length)] };
    },
  });
}

def('flower_default', 'surface', (world, x, y, z, rng) =>
  flowerPatch(world, x, y, z, rng, DEFAULT_FLOWERS, 0.04, TALL_FLOWERS));
def('flower_plains', 'surface', (world, x, y, z, rng) =>
  flowerPatch(world, x, y, z, rng, PLAINS_FLOWERS, 0.08, ['sunflower']));
def('flower_forest', 'surface', (world, x, y, z, rng) =>
  flowerPatch(world, x, y, z, rng, FLOWERS, 0.22, ['lilac', 'rose_bush', 'peony']));
def('flower_swamp', 'surface', (world, x, y, z, rng) =>
  flowerPatch(world, x, y, z, rng, ['blue_orchid', 'blue_orchid', 'dandelion'], 0, TALL_FLOWERS));

def('dead_bush', 'surface', (world, x, y, z, rng) => {
  const soil = new Set([...S().sandy, bid('dirt'), bid('coarse_dirt'), bid('terracotta'),
    bid('red_sand'), bid('sand'), bid('podzol'), bid('grass_block')]);
  for (const t of S().terracotta) soil.add(t);
  return patch(world, x, y, z, rng, {
    tries: 8, radius: 4, soil, pick: () => ({ name: 'dead_bush' }),
  });
});

def('sweet_berry_bush', 'surface', (world, x, y, z, rng) =>
  patch(world, x, y, z, rng, {
    tries: 8, radius: 4, soil: S().grassOnly,
    pick: (r) => ({ name: 'sweet_berry_bush', meta: r.range(2, 3) }),
  }));

def('cactus', 'surface', (world, x, y, z, rng) => {
  const cactus = bid('cactus');
  const sand = new Set([bid('sand'), bid('red_sand')]);
  let placed = false;
  for (let i = 0; i < 10; i++) {
    const px = x + rng.range(-4, 4), pz = z + rng.range(-4, 4);
    const py = surfaceY(world, px, pz);
    if (py < 1) continue;
    if (!sand.has(gid(world, px, py - 1, pz))) continue;
    // cacti need clear sides
    let blocked = false;
    for (let f = 0; f < 4; f++) {
      const d = HFACE_DIRS[f];
      if (!isAirLike(world, px + d[0], py, pz + d[2])) { blocked = true; break; }
    }
    if (blocked) continue;
    const h = rng.range(1, 3);
    for (let k = 0; k < h; k++) {
      if (!isAirLike(world, px, py + k, pz)) break;
      if (set(world, px, py + k, pz, cactus, 0)) placed = true;
    }
  }
  return placed;
});

def('sugar_cane', 'surface', (world, x, y, z, rng) => {
  const cane = bid('sugar_cane');
  const soil = new Set([bid('grass_block'), bid('dirt'), bid('coarse_dirt'), bid('sand'),
    bid('red_sand'), bid('podzol'), bid('mud'), bid('moss_block')]);
  let placed = false;
  for (let i = 0; i < 12; i++) {
    const px = x + rng.range(-4, 4), pz = z + rng.range(-4, 4);
    const py = surfaceY(world, px, pz);
    if (py < 1) continue;
    if (!soil.has(gid(world, px, py - 1, pz))) continue;
    if (!isAirLike(world, px, py, pz)) continue;
    // must touch water on at least one side, at ground level
    let wet = false;
    for (let f = 0; f < 4 && !wet; f++) {
      const d = HFACE_DIRS[f];
      if (isWater(world, px + d[0], py - 1, pz + d[2])) wet = true;
    }
    if (!wet) continue;
    const h = rng.range(2, 4);
    for (let k = 0; k < h; k++) {
      if (!isAirLike(world, px, py + k, pz)) break;
      if (set(world, px, py + k, pz, cane, k === h - 1 ? rng.int(8) : 0)) placed = true;
    }
  }
  return placed;
});

def('bamboo', 'surface', (world, x, y, z, rng) => {
  const bam = bid('bamboo');
  const soil = new Set([bid('grass_block'), bid('dirt'), bid('coarse_dirt'), bid('sand'),
    bid('podzol'), bid('gravel'), bid('mycelium'), bid('moss_block')]);
  let placed = false;
  const stalks = rng.range(1, 4);
  for (let i = 0; i < stalks; i++) {
    const px = x + rng.range(-4, 4), pz = z + rng.range(-4, 4);
    const py = surfaceY(world, px, pz);
    if (py < 1) continue;
    if (!soil.has(gid(world, px, py - 1, pz))) continue;
    const h = rng.range(5, 13);
    for (let k = 0; k < h; k++) {
      if (!isAirLike(world, px, py + k, pz)) break;
      // meta 1 on the top segments so the mesher/ticker can tell leaf sections apart
      if (set(world, px, py + k, pz, bam, k >= h - 2 ? 1 : 0)) placed = true;
    }
  }
  return placed;
});

/** Pumpkins and melons: a handful of gourds with a stem beside them. */
function gourdPatch(world, x, y, z, rng, fruit, stem) {
  const f = bid(fruit), st = bid(stem);
  let placed = false;
  for (let i = 0; i < 8; i++) {
    const px = x + rng.range(-4, 4), pz = z + rng.range(-4, 4);
    const py = surfaceY(world, px, pz);
    if (py < 1) continue;
    if (!S().grassOnly.has(gid(world, px, py - 1, pz))) continue;
    if (!isAirLike(world, px, py, pz)) continue;
    if (set(world, px, py, pz, f, rng.int(4))) placed = true;
    if (rng.next() < 0.35) {
      const d = HFACE_DIRS[rng.int(4)];
      const sx = px + d[0], sz = pz + d[2];
      if (isAirLike(world, sx, py, sz) && S().grassOnly.has(gid(world, sx, py - 1, sz))) {
        set(world, sx, py, sz, st, 7);
      }
    }
  }
  return placed;
}
def('pumpkin_patch', 'surface', (world, x, y, z, rng) =>
  gourdPatch(world, x, y, z, rng, 'pumpkin', 'pumpkin_stem'));
def('melon_patch', 'surface', (world, x, y, z, rng) =>
  gourdPatch(world, x, y, z, rng, 'melon', 'melon_stem'));

def('lily_pad', 'water_top', (world, x, y, z, rng) => {
  const pad = bid('lily_pad');
  let placed = false;
  for (let i = 0; i < 10; i++) {
    const px = x + rng.range(-4, 4), pz = z + rng.range(-4, 4);
    const c = scanColumn(world, px, pz);
    if (c.waterY < 0 || c.waterY <= c.y) continue;
    if (!isWater(world, px, c.waterY, pz)) continue;
    if (!isAirLike(world, px, c.waterY + 1, pz)) continue;
    if (set(world, px, c.waterY + 1, pz, pad, 0)) placed = true;
  }
  return placed;
});

// ---- underwater -----------------------------------------------------------

def('seagrass', 'water', (world, x, y, z, rng) => {
  const sg = bid('seagrass'), tall = bid('tall_seagrass');
  let placed = false;
  for (let i = 0; i < 24; i++) {
    const px = x + rng.range(-6, 6), pz = z + rng.range(-6, 6);
    const c = scanColumn(world, px, pz);
    if (c.y < 0 || c.waterY <= c.y) continue;
    const py = c.y + 1;
    if (!isWater(world, px, py, pz)) continue;
    if (rng.next() < 0.3 && isWater(world, px, py + 1, pz)) {
      if (set(world, px, py, pz, tall, 0)) { set(world, px, py + 1, pz, tall, 8); placed = true; }
    } else if (set(world, px, py, pz, sg, 0)) placed = true;
  }
  return placed;
});

def('kelp', 'water', (world, x, y, z, rng) => {
  const plant = bid('kelp_plant'), tip = bid('kelp');
  let placed = false;
  for (let i = 0; i < 8; i++) {
    const px = x + rng.range(-5, 5), pz = z + rng.range(-5, 5);
    const c = scanColumn(world, px, pz);
    if (c.y < 0 || c.waterY <= c.y + 1) continue;
    const bottom = c.y + 1;
    const room = c.waterY - bottom;
    if (room < 2) continue;
    const h = Math.min(room, rng.range(3, 14));
    for (let k = 0; k < h; k++) {
      if (!isWater(world, px, bottom + k, pz)) break;
      if (set(world, px, bottom + k, pz, k === h - 1 ? tip : plant, k === h - 1 ? rng.int(16) : 0)) placed = true;
    }
  }
  return placed;
});

const CORAL_KINDS = ['tube', 'brain', 'bubble', 'fire', 'horn'];

def('coral_reef', 'water', (world, x, y, z, rng) => {
  const c0 = scanColumn(world, x, z);
  if (c0.y < 0 || c0.waterY <= c0.y + 1) return false;
  const base = c0.y + 1;
  const kind = CORAL_KINDS[rng.int(CORAL_KINDS.length)];
  const blockId = bid(kind + '_coral_block');
  const r = rng.range(2, 3);
  let placed = false;
  // mound of coral blocks
  for (let dy = 0; dy < 3; dy++) {
    const rr = r - dy;
    if (rr < 0) break;
    for (let dz = -rr; dz <= rr; dz++) {
      for (let dx = -rr; dx <= rr; dx++) {
        if (dx * dx + dz * dz > rr * rr + 1) continue;
        if (rng.next() < 0.2) continue;
        const px = x + dx, py = base + dy, pz = z + dz;
        if (!isWater(world, px, py, pz) && gid(world, px, py, pz) !== 0) continue;
        const k = rng.next() < 0.25 ? CORAL_KINDS[rng.int(CORAL_KINDS.length)] : kind;
        if (set(world, px, py, pz, bid(k + '_coral_block'), 0)) placed = true;
      }
    }
  }
  // corals and fans sprouting off the mound
  for (let i = 0; i < 26; i++) {
    const px = x + rng.range(-r - 1, r + 1), pz = z + rng.range(-r - 1, r + 1);
    for (let py = base + 3; py > base - 1; py--) {
      const below = gid(world, px, py - 1, pz);
      if (below === 0 || !isWater(world, px, py, pz)) continue;
      const bd = getBlock(below);
      if (!bd.solid || bd.liquid) continue;
      const k = CORAL_KINDS[rng.int(CORAL_KINDS.length)];
      const t = rng.next();
      const name = t < 0.45 ? k + '_coral' : k + '_coral_fan';
      if (set(world, px, py, pz, bid(name), 0)) placed = true;
      break;
    }
  }
  // wall fans on the flanks
  for (let i = 0; i < 10; i++) {
    const hf = rng.int(4), d = HFACE_DIRS[hf];
    const px = x + d[0] * (r + 1), pz = z + d[2] * (r + 1);
    const py = base + rng.int(3);
    if (!isWater(world, px, py, pz)) continue;
    if (!isOpaqueAt(world, px - d[0], py, pz - d[2])) continue;
    const k = CORAL_KINDS[rng.int(CORAL_KINDS.length)];
    if (set(world, px, py, pz, bid(k + '_coral_wall_fan'), (hf + 2) & 3)) placed = true;
  }
  return placed;
});

// ===========================================================================
// TERRAIN DECORATION
// ===========================================================================

def('ice_spike', 'surface', (world, x, y, z, rng) => {
  const ice = bid('packed_ice');
  const ok = new Set([bid('snow_block'), bid('snow'), bid('ice'), bid('packed_ice'),
    bid('grass_block'), bid('dirt'), bid('gravel'), bid('stone'), bid('powder_snow')]);
  if (!ok.has(gid(world, x, y - 1, z))) return false;
  const h = rng.range(7, 20);
  if (y + h >= WORLD_HEIGHT - 2) return false;
  const baseR = h > 14 ? 2 : 1;
  for (let dy = 0; dy < h; dy++) {
    const t = dy / h;
    const r = Math.max(0, Math.round(baseR * (1 - t * t)));
    for (let dz = -r; dz <= r; dz++) {
      for (let dx = -r; dx <= r; dx++) {
        if (dx * dx + dz * dz > r * r + (r > 1 ? 1 : 0)) continue;
        setSoft(world, x + dx, y + dy, z + dz, ice, 0);
      }
    }
  }
  // a wider skirt of packed ice around the foot
  if (baseR > 1) {
    for (let dz = -2; dz <= 2; dz++) {
      for (let dx = -2; dx <= 2; dx++) {
        if (dx * dx + dz * dz > 5) continue;
        if (rng.next() < 0.4) continue;
        setSoft(world, x + dx, y, z + dz, ice, 0);
      }
    }
  }
  return true;
});

def('amethyst_geode', 'under', (world, x, y, z, rng) => {
  const basalt = bid('smooth_basalt'), calcite = bid('calcite');
  const amethyst = bid('amethyst_block'), budding = bid('budding_amethyst');
  const buds = [bid('small_amethyst_bud'), bid('medium_amethyst_bud'),
    bid('large_amethyst_bud'), bid('amethyst_cluster')];
  const cy = clamp(y, 8, 48);
  const R = rng.range(5, 7);
  if (cy - R < 2 || cy + R > WORLD_HEIGHT - 2) return false;
  const seed = hash3((world.seed | 0) ^ 0x9e35, x, cy, z);
  const buddingCells = [];
  for (let dy = -R; dy <= R; dy++) {
    for (let dz = -R; dz <= R; dz++) {
      for (let dx = -R; dx <= R; dx++) {
        // jittered radius so the shell is lumpy rather than a perfect ball
        const jitter = ((hash3(seed, dx, dy, dz) & 255) / 255) * 0.9;
        const d = Math.sqrt(dx * dx + dy * dy + dz * dz) + jitter;
        const px = x + dx, py = cy + dy, pz = z + dz;
        if (d > R) continue;
        const cur = gid(world, px, py, pz);
        if (cur !== 0 && getBlock(cur).liquid) continue;
        if (d > R - 1.0) set(world, px, py, pz, basalt, 0);
        else if (d > R - 2.0) set(world, px, py, pz, calcite, 0);
        else if (d > R - 3.0) {
          const bud = rng.next() < 0.22;
          set(world, px, py, pz, bud ? budding : amethyst, 0);
          if (bud) buddingCells.push(px, py, pz);
        } else set(world, px, py, pz, 0, 0);
      }
    }
  }
  // crystals growing inward off the budding blocks
  const FACES = [[0, 1, 0], [0, -1, 0], [0, 0, -1], [0, 0, 1], [-1, 0, 0], [1, 0, 0]];
  for (let i = 0; i < buddingCells.length; i += 3) {
    const px = buddingCells[i], py = buddingCells[i + 1], pz = buddingCells[i + 2];
    for (let f = 0; f < 6; f++) {
      if (rng.next() > 0.45) continue;
      const d = FACES[f];
      const nx = px + d[0], ny = py + d[1], nz = pz + d[2];
      if (gid(world, nx, ny, nz) !== 0) continue;
      set(world, nx, ny, nz, buds[rng.int(buds.length)], f);
    }
  }
  return true;
});

def('dripstone_cluster', 'under', (world, x, y, z, rng) => {
  const point = bid('pointed_dripstone'), block = bid('dripstone_block');
  let placed = false;
  for (let i = 0; i < 14; i++) {
    const px = x + rng.range(-6, 6), pz = z + rng.range(-6, 6);
    const py = clamp(y + rng.range(-4, 4), 3, WORLD_HEIGHT - 4);
    if (!isAirLike(world, px, py, pz)) continue;
    const ceil = findCeiling(world, px, py, pz, 12);
    const floor = findFloor(world, px, py, pz, 12);
    if (rng.bool() && ceil > 0) {
      // stalactite: thick at the roof, tapering to a tip
      if (rng.next() < 0.4) set(world, px, ceil, pz, block, 0);
      const len = rng.range(1, 5);
      for (let k = 1; k <= len; k++) {
        const yy = ceil - k;
        if (!isAirLike(world, px, yy, pz)) break;
        const thick = k === len ? 0 : k === len - 1 ? 1 : k === 1 ? 3 : 2;
        if (set(world, px, yy, pz, point, 1 | (thick << 1))) placed = true;
      }
    } else if (floor > 0) {
      // stalagmite: thick at the ground, tapering upward
      if (rng.next() < 0.4) set(world, px, floor, pz, block, 0);
      const len = rng.range(1, 4);
      for (let k = 1; k <= len; k++) {
        const yy = floor + k;
        if (!isAirLike(world, px, yy, pz)) break;
        const thick = k === len ? 0 : k === len - 1 ? 1 : k === 1 ? 3 : 2;
        if (set(world, px, yy, pz, point, thick << 1)) placed = true;
      }
    }
  }
  return placed;
});

def('lush_cave_patch', 'under', (world, x, y, z, rng) => {
  const moss = bid('moss_block'), carpet = bid('moss_carpet');
  const vinesPlant = bid('cave_vines_plant'), vinesTip = bid('cave_vines');
  const floor = findFloor(world, x, y, z, 40);
  if (floor < 2) return false;
  let placed = false;
  const r = rng.range(3, 5);
  for (let dz = -r; dz <= r; dz++) {
    for (let dx = -r; dx <= r; dx++) {
      const d2 = dx * dx + dz * dz;
      if (d2 > r * r) continue;
      const px = x + dx, pz = z + dz;
      const fy = findFloor(world, px, floor + 3, pz, 8);
      if (fy < 2) continue;
      const cur = gid(world, px, fy, pz);
      if (cur === 0 || getBlock(cur).liquid) continue;
      if (set(world, px, fy, pz, moss, 0)) placed = true;
      const t = rng.next();
      if (t < 0.3) setSoft(world, px, fy + 1, pz, carpet, 0);
      else if (t < 0.4) setSoft(world, px, fy + 1, pz, bid('short_grass'), 0);
      else if (t < 0.44) setSoft(world, px, fy + 1, pz, bid('small_dripleaf'), rng.int(4));
      else if (t < 0.47) setSoft(world, px, fy + 1, pz, bid('big_dripleaf'), rng.int(4));
      else if (t < 0.5) setSoft(world, px, fy + 1, pz, bid('flowering_azalea'), 0);
      else if (t < 0.52) setSoft(world, px, fy + 1, pz, bid('azalea'), 0);
    }
  }
  // glow berries dangling from whatever ceiling is overhead
  for (let i = 0; i < 9; i++) {
    const px = x + rng.range(-r, r), pz = z + rng.range(-r, r);
    const ceil = findCeiling(world, px, floor + 1, pz, 24);
    if (ceil < 3) continue;
    if (rng.next() < 0.3) set(world, px, ceil, pz, moss, 0);
    if (rng.next() < 0.06) { setSoft(world, px, ceil - 1, pz, bid('spore_blossom'), 0); continue; }
    const len = rng.range(1, 7);
    for (let k = 1; k <= len; k++) {
      const yy = ceil - k;
      if (!isAirLike(world, px, yy, pz)) break;
      // meta bit 3 lights the vine up (glow berries)
      const lit = rng.next() < 0.35 ? 8 : 0;
      if (set(world, px, yy, pz, k === len ? vinesTip : vinesPlant, lit)) placed = true;
    }
  }
  return placed;
});

def('sculk_patch', 'under', (world, x, y, z, rng) => {
  const sculk = bid('sculk'), vein = bid('sculk_vein');
  const floor = findFloor(world, x, y, z, 40);
  if (floor < 2) return false;
  let placed = false;
  const r = rng.range(2, 5);
  for (let dz = -r; dz <= r; dz++) {
    for (let dx = -r; dx <= r; dx++) {
      const d2 = dx * dx + dz * dz;
      if (d2 > r * r) continue;
      if (d2 > (r - 1) * (r - 1) && rng.next() < 0.5) continue;
      const px = x + dx, pz = z + dz;
      const fy = findFloor(world, px, floor + 3, pz, 6);
      if (fy < 2) continue;
      const cur = gid(world, px, fy, pz);
      if (cur === 0 || getBlock(cur).liquid) continue;
      if (set(world, px, fy, pz, sculk, 0)) placed = true;
      const t = rng.next();
      if (t < 0.03) set(world, px, fy + 1, pz, bid('sculk_catalyst'), 0);
      else if (t < 0.07) set(world, px, fy + 1, pz, bid('sculk_sensor'), 0);
      else if (t < 0.09) set(world, px, fy + 1, pz, bid('sculk_shrieker'), 0);
      else if (t < 0.2) setSoft(world, px, fy + 1, pz, vein, VINE_BIT[rng.int(4)]);
    }
  }
  // veins creeping up the surrounding walls
  for (let i = 0; i < 12; i++) {
    const px = x + rng.range(-r - 1, r + 1), pz = z + rng.range(-r - 1, r + 1);
    const py = floor + rng.range(1, 3);
    if (!isAirLike(world, px, py, pz)) continue;
    for (let f = 0; f < 4; f++) {
      const d = HFACE_DIRS[f];
      if (isOpaqueAt(world, px + d[0], py, pz + d[2]) && rng.next() < 0.5) {
        if (set(world, px, py, pz, vein, VINE_BIT[f])) placed = true;
        break;
      }
    }
  }
  return placed;
});

def('fossil', 'under', (world, x, y, z, rng) => {
  // A buried spine with ribs, mostly bone with a little coal ore mixed in.
  const bone = bid('bone_block'), coal = bid('coal_ore');
  const cy = clamp(y, 6, 40);
  const host = S().oreHost;
  const horiz = rng.bool();
  const len = rng.range(6, 12);
  const axis = horiz ? 1 : 2;
  let any = false;
  const canCarve = (px, py, pz) => {
    const b = gid(world, px, py, pz);
    return b === 0 || host.has(b) || S().dirtLike.has(b);
  };
  for (let i = 0; i < len; i++) {
    const px = horiz ? x + i : x;
    const pz = horiz ? z : z + i;
    if (!canCarve(px, cy, pz)) continue;
    if (set(world, px, cy, pz, rng.next() < 0.1 ? coal : bone, axis)) any = true;
    if (i % 2 === 0) {
      const ribH = rng.range(2, 3);
      for (const s of [-1, 1]) {
        for (let k = 1; k <= ribH; k++) {
          const rx = horiz ? px : px + s * k;
          const rz = horiz ? pz + s * k : pz;
          const ry = cy + (k === ribH ? 1 : 0);
          if (!canCarve(rx, ry, rz)) break;
          set(world, rx, ry, rz, rng.next() < 0.08 ? coal : bone, horiz ? 2 : 1);
        }
      }
    }
  }
  return any;
});

def('glow_lichen', 'under', (world, x, y, z, rng) => {
  const lichen = bid('glow_lichen');
  let placed = false;
  for (let i = 0; i < 20; i++) {
    const px = x + rng.range(-6, 6), pz = z + rng.range(-6, 6);
    const py = clamp(y + rng.range(-6, 6), 2, WORLD_HEIGHT - 3);
    if (!isAirLike(world, px, py, pz)) continue;
    let mask = 0;
    for (let f = 0; f < 4; f++) {
      const d = HFACE_DIRS[f];
      if (isOpaqueAt(world, px + d[0], py, pz + d[2])) mask |= VINE_BIT[f];
    }
    if (mask === 0) continue;
    // keep it sparse and mostly single-sided
    if (rng.next() < 0.5) {
      const keep = [1, 2, 4, 8].filter((b) => mask & b);
      mask = keep[rng.int(keep.length)];
    }
    if (set(world, px, py, pz, lichen, mask)) placed = true;
  }
  return placed;
});

def('vines', 'surface', (world, x, y, z, rng) => {
  const vine = bid('vine');
  let placed = false;
  for (let i = 0; i < 14; i++) {
    const px = x + rng.range(-6, 6), pz = z + rng.range(-6, 6);
    const hf = rng.int(4), d = HFACE_DIRS[hf];
    const top = Math.min(WORLD_HEIGHT - 2, y + 22);
    for (let py = top; py >= Math.max(2, y - 12); py--) {
      if (!isAirLike(world, px, py, pz)) continue;
      const nb = gid(world, px + d[0], py, pz + d[2]);
      if (nb === 0) continue;
      const nd = getBlock(nb);
      if (!(nd.opaque && nd.solid) && !S().leaves.has(nb)) continue;
      if (hangVines(world, px, py, pz, rng.range(2, 9), hf, rng, vine)) placed = true;
      break;
    }
  }
  return placed;
});

// ---- nether ---------------------------------------------------------------

def('nether_wart_patch', 'surface', (world, x, y, z, rng) => {
  const soul = bid('soul_sand'), wart = bid('nether_wart');
  let placed = false;
  const r = rng.range(2, 4);
  for (let dz = -r; dz <= r; dz++) {
    for (let dx = -r; dx <= r; dx++) {
      if (dx * dx + dz * dz > r * r) continue;
      const px = x + dx, pz = z + dz;
      const py = surfaceY(world, px, pz);
      if (py < 1) continue;
      const below = gid(world, px, py - 1, pz);
      if (!S().netherSoil.has(below)) continue;
      if (set(world, px, py - 1, pz, soul, 0)) placed = true;
      if (rng.next() < 0.4 && isAirLike(world, px, py, pz)) set(world, px, py, pz, wart, rng.int(4));
    }
  }
  return placed;
});

def('weeping_vines', 'under', (world, x, y, z, rng) => {
  const tip = bid('weeping_vines'), body = bid('weeping_vines_plant');
  let placed = false;
  for (let i = 0; i < 6; i++) {
    const px = x + rng.range(-5, 5), pz = z + rng.range(-5, 5);
    const ceil = findCeiling(world, px, clamp(y, 2, WORLD_HEIGHT - 4), pz, 20);
    if (ceil < 3) continue;
    const len = rng.range(2, 8);
    for (let k = 1; k <= len; k++) {
      const yy = ceil - k;
      if (!isAirLike(world, px, yy, pz)) break;
      if (set(world, px, yy, pz, k === len ? tip : body, 0)) placed = true;
    }
  }
  return placed;
});

def('twisting_vines', 'surface', (world, x, y, z, rng) => {
  const tip = bid('twisting_vines'), body = bid('twisting_vines_plant');
  let placed = false;
  for (let i = 0; i < 5; i++) {
    const px = x + rng.range(-5, 5), pz = z + rng.range(-5, 5);
    const py = surfaceY(world, px, pz);
    if (py < 1) continue;
    if (!S().netherSoil.has(gid(world, px, py - 1, pz))) continue;
    const len = rng.range(2, 6);
    for (let k = 0; k < len; k++) {
      if (!isAirLike(world, px, py + k, pz)) break;
      if (set(world, px, py + k, pz, k === len - 1 ? tip : body, 0)) placed = true;
    }
  }
  return placed;
});

def('basalt_pillar', 'surface', (world, x, y, z, rng) => {
  const basalt = bid('basalt'), magma = bid('magma_block');
  if (!S().netherSoil.has(gid(world, x, y - 1, z))) return false;
  const h = rng.range(3, 10);
  const r = h > 6 ? 1 : 0;
  for (let dy = 0; dy < h; dy++) {
    const rr = dy > h * 0.6 ? 0 : r;
    for (let dz = -rr; dz <= rr; dz++) {
      for (let dx = -rr; dx <= rr; dx++) {
        if (dx * dx + dz * dz > rr * rr + 1) continue;
        if (dy > 0 && rng.next() < 0.08) continue;
        // pillars are column blocks: meta 0 keeps the basalt grain vertical
        setSoft(world, x + dx, y + dy, z + dz, rng.next() < 0.04 ? magma : basalt, 0);
      }
    }
  }
  return true;
});

def('soul_fire', 'surface', (world, x, y, z, rng) => {
  const fire = bid('soul_fire');
  const ok = new Set([bid('soul_sand'), bid('soul_soil')]);
  let placed = false;
  for (let i = 0; i < 6; i++) {
    const px = x + rng.range(-4, 4), pz = z + rng.range(-4, 4);
    const py = surfaceY(world, px, pz);
    if (py < 1) continue;
    if (!ok.has(gid(world, px, py - 1, pz))) continue;
    if (!isAirLike(world, px, py, pz)) continue;
    if (set(world, px, py, pz, fire, 0)) placed = true;
  }
  return placed;
});

// ---- end ------------------------------------------------------------------

def('chorus_plant', 'surface', (world, x, y, z, rng) => {
  const stem = bid('chorus_plant'), flower = bid('chorus_flower');
  if (gid(world, x, y - 1, z) !== bid('end_stone')) return false;
  if (!isAirLike(world, x, y, z)) return false;

  const grow = (px, py, pz, height, depth) => {
    if (depth > 6 || py >= WORLD_HEIGHT - 2) { setSoft(world, px, py, pz, flower, 5); return; }
    const run = rng.range(1, Math.max(1, 4 - depth));
    for (let k = 0; k < run; k++) {
      if (!isAirLike(world, px, py + k, pz)) return;
      setSoft(world, px, py + k, pz, stem, 0);
    }
    const ny = py + run;
    if (depth >= height || rng.next() < 0.25) {
      setSoft(world, px, ny, pz, flower, rng.int(5));
      return;
    }
    setSoft(world, px, ny, pz, stem, 0);
    let grown = 0;
    const arms = rng.range(1, 3);
    for (let a = 0; a < arms; a++) {
      const d = HFACE_DIRS[rng.int(4)];
      const bx = px + d[0], bz = pz + d[2];
      if (!isAirLike(world, bx, ny, bz)) continue;
      setSoft(world, bx, ny, bz, stem, 0);
      grow(bx, ny + 1, bz, height, depth + 1);
      grown++;
    }
    // a stem that could not branch anywhere still has to end in a flower
    if (grown === 0) setSoft(world, px, ny + 1, pz, flower, rng.int(5));
  };
  grow(x, y, z, rng.range(2, 5), 0);
  return true;
});

// ---- springs and disks ----------------------------------------------------

function spring(world, x, y, z, rng, fluidName) {
  const fluid = bid(fluidName);
  const host = S().springHost;
  for (let i = 0; i < 24; i++) {
    const py = y - i;
    if (py < 6) break;
    if (!host.has(gid(world, x, py + 1, z))) continue;
    if (!host.has(gid(world, x, py - 1, z))) continue;
    const cur = gid(world, x, py, z);
    if (cur !== 0 && !host.has(cur)) continue;
    let air = 0, rock = 0;
    for (let f = 0; f < 4; f++) {
      const d = HFACE_DIRS[f];
      const b = gid(world, x + d[0], py, z + d[2]);
      if (b === 0) air++;
      else if (host.has(b)) rock++;
    }
    if (air >= 1 && rock >= 3) return set(world, x, py, z, fluid, 0);
  }
  return false;
}
def('spring_water', 'under', (world, x, y, z, rng) => spring(world, x, y, z, rng, 'water'));
def('spring_lava', 'under', (world, x, y, z, rng) => spring(world, x, y, z, rng, 'lava'));

function disk(world, x, y, z, rng, blockName) {
  // Vanilla only drops disks in shallow water; keep them near sea level.
  const c = scanColumn(world, x, z);
  if (c.y < 0) return false;
  if (c.y > SEA_LEVEL + 2) return false;
  const mat = bid(blockName);
  const host = S().diskHost;
  const r = rng.range(2, 4);
  const depth = rng.range(1, 3);
  let placed = false;
  for (let dz = -r; dz <= r; dz++) {
    for (let dx = -r; dx <= r; dx++) {
      if (dx * dx + dz * dz > r * r) continue;
      const px = x + dx, pz = z + dz;
      const cc = scanColumn(world, px, pz);
      if (cc.y < 0 || cc.y > SEA_LEVEL + 2) continue;
      for (let k = 0; k < depth; k++) {
        const py = cc.y - k;
        if (py < 2) break;
        if (!host.has(gid(world, px, py, pz))) break;
        if (set(world, px, py, pz, mat, 0)) placed = true;
      }
    }
  }
  return placed;
}
def('disk_sand', 'shore', (world, x, y, z, rng) => disk(world, x, y, z, rng, 'sand'));
def('disk_clay', 'shore', (world, x, y, z, rng) => disk(world, x, y, z, rng, 'clay'));
def('disk_gravel', 'shore', (world, x, y, z, rng) => disk(world, x, y, z, rng, 'gravel'));

// ===========================================================================
// ORES
// ===========================================================================

/** Samples a y from an ore's vertical distribution. */
function sampleY(rng, d) {
  switch (d.t) {
    case 'tri': {
      const a = rng.range(d.min, d.max), b = rng.range(d.min, d.max);
      return (a + b) >> 1;
    }
    case 'peak': {
      const a = rng.range(-d.spread, d.spread), b = rng.range(-d.spread, d.spread);
      return clamp(d.peak + ((a + b) >> 1), d.min, d.max);
    }
    default:
      return rng.range(d.min, d.max);
  }
}

/**
 * Minecraft-style ore vein: a short line segment with spheres of varying
 * radius swept along it, so veins are elongated rather than ball-shaped.
 */
function oreBlob(world, x, y, z, n, baseId, deepId, rng, replace) {
  if (n < 1) n = 1;
  const deepslate = bid('deepslate');
  const ang = rng.next() * Math.PI;
  const spread = n / 8;
  const sx = Math.sin(ang) * spread, sz = Math.cos(ang) * spread;
  const ax = x + sx, bx2 = x - sx;
  const az = z + sz, bz2 = z - sz;
  const ay = y + rng.int(3) - 2, by2 = y + rng.int(3) - 2;
  let placed = 0;
  for (let i = 0; i <= n; i++) {
    const t = i / n;
    const cx = ax + (bx2 - ax) * t;
    const cy = ay + (by2 - ay) * t;
    const cz = az + (bz2 - az) * t;
    const size = ((Math.sin(Math.PI * t) + 1) * rng.next() * n / 16 + 1) / 2;
    if (size <= 0) continue;
    const x0 = Math.floor(cx - size), x1 = Math.floor(cx + size);
    const y0 = Math.floor(cy - size), y1 = Math.floor(cy + size);
    const z0 = Math.floor(cz - size), z1 = Math.floor(cz + size);
    for (let bx = x0; bx <= x1; bx++) {
      const fx = (bx + 0.5 - cx) / size;
      if (fx * fx >= 1) continue;
      for (let by = y0; by <= y1; by++) {
        if (by < 1 || by >= WORLD_HEIGHT) continue;
        const fy = (by + 0.5 - cy) / size;
        if (fx * fx + fy * fy >= 1) continue;
        for (let bz = z0; bz <= z1; bz++) {
          const fz = (bz + 0.5 - cz) / size;
          if (fx * fx + fy * fy + fz * fz >= 1) continue;
          const cur = gid(world, bx, by, bz);
          if (!replace.has(cur)) continue;
          const useDeep = cur === deepslate || by < 16;
          if (set(world, bx, by, bz, useDeep ? deepId : baseId, 0)) placed++;
        }
      }
    }
  }
  return placed > 0;
}

// Per-chunk ore budget. `skip` throws away that fraction of the attempts, the
// way vanilla's discard_chance_on_air_exposure thins out the huge upper bands.
const OVERWORLD_ORES = [
  { b: 'coal_ore', d: 'deepslate_coal_ore', n: 8, s: [10, 17], y: { t: 'tri', min: 0, max: 96 } },
  { b: 'coal_ore', d: 'deepslate_coal_ore', n: 6, s: [8, 15], y: { t: 'uni', min: 58, max: 126 } },
  { b: 'iron_ore', d: 'deepslate_iron_ore', n: 6, s: [6, 10], y: { t: 'peak', peak: 16, spread: 22, min: 1, max: 52 } },
  { b: 'iron_ore', d: 'deepslate_iron_ore', n: 6, s: [3, 6], y: { t: 'uni', min: 1, max: 60 }, skip: 0.4 },
  { b: 'iron_ore', d: 'deepslate_iron_ore', n: 7, s: [5, 9], y: { t: 'uni', min: 74, max: 126 }, skip: 0.6 },
  { b: 'copper_ore', d: 'deepslate_copper_ore', n: 8, s: [6, 14], y: { t: 'peak', peak: 48, spread: 26, min: 14, max: 88 } },
  { b: 'gold_ore', d: 'deepslate_gold_ore', n: 4, s: [4, 9], y: { t: 'peak', peak: 12, spread: 18, min: 1, max: 32 } },
  { b: 'redstone_ore', d: 'deepslate_redstone_ore', n: 5, s: [4, 10], y: { t: 'uni', min: 1, max: 16 } },
  { b: 'redstone_ore', d: 'deepslate_redstone_ore', n: 4, s: [4, 8], y: { t: 'peak', peak: 2, spread: 12, min: 1, max: 14 } },
  { b: 'lapis_ore', d: 'deepslate_lapis_ore', n: 2, s: [3, 7], y: { t: 'peak', peak: 1, spread: 16, min: 1, max: 30 } },
  { b: 'lapis_ore', d: 'deepslate_lapis_ore', n: 4, s: [3, 6], y: { t: 'uni', min: 1, max: 48 }, skip: 0.7 },
  { b: 'diamond_ore', d: 'deepslate_diamond_ore', n: 3, s: [3, 8], y: { t: 'peak', peak: 1, spread: 14, min: 1, max: 16 }, skip: 0.35 },
  { b: 'diamond_ore', d: 'deepslate_diamond_ore', n: 1, s: [6, 12], y: { t: 'uni', min: 1, max: 12 }, skip: 0.85 },
];

const OVERWORLD_BLOBS = [
  { b: 'dirt', n: 6, s: [18, 30], y: { t: 'uni', min: 2, max: 118 } },
  { b: 'gravel', n: 6, s: [18, 30], y: { t: 'uni', min: 2, max: 110 } },
  { b: 'granite', n: 5, s: [18, 30], y: { t: 'uni', min: 2, max: 80 } },
  { b: 'diorite', n: 5, s: [18, 30], y: { t: 'uni', min: 2, max: 80 } },
  { b: 'andesite', n: 5, s: [18, 30], y: { t: 'uni', min: 2, max: 80 } },
  { b: 'tuff', n: 2, s: [12, 24], y: { t: 'uni', min: 1, max: 18 } },
  { b: 'clay', n: 1, s: [10, 20], y: { t: 'uni', min: 1, max: 64 }, skip: 0.55 },
];

const NETHER_ORES = [
  { b: 'nether_quartz_ore', n: 16, s: [8, 14], y: { t: 'uni', min: 10, max: 114 } },
  { b: 'nether_gold_ore', n: 10, s: [6, 12], y: { t: 'uni', min: 10, max: 114 } },
  { b: 'ancient_debris', n: 1, s: [1, 3], y: { t: 'peak', peak: 15, spread: 7, min: 8, max: 22 }, skip: 0.35 },
  { b: 'ancient_debris', n: 1, s: [1, 2], y: { t: 'uni', min: 8, max: 118 }, skip: 0.9 },
  { b: 'magma_block', n: 4, s: [10, 20], y: { t: 'uni', min: 26, max: 38 } },
  { b: 'blackstone', n: 2, s: [10, 20], y: { t: 'uni', min: 5, max: 30 } },
];

// Chunks whose ore pass already ran. worldgen.populateChunk calls generateOres
// and decorateChunk in sequence, but an integrator may call only one of them,
// so decorateChunk runs ores too and this guard keeps veins from doubling up.
const _oredChunks = new WeakSet();

/**
 * Places every ore vein and stone blob for one chunk. Deterministic in
 * (world.seed, chunk.cx, chunk.cz), and a no-op the second time it is called
 * for the same chunk. Called by worldgen.populateChunk.
 */
export function generateOres(chunk, world, rng) {
  if (!chunk || !world) return;
  if (_oredChunks.has(chunk)) return;
  _oredChunks.add(chunk);
  const cx = chunk.cx, cz = chunk.cz;
  const saved = pushBounds(cx, cz);
  try {
    const seed = (world.seed | 0);
    const r = new RNG(hash3(seed ^ 0x0e21a7, cx, cz, 0x51ced));
    const ox = cx << 4, oz = cz << 4;
    const dim = world.dimension;

    if (dim === 'nether') {
      const host = S().netherHost;
      for (const c of NETHER_ORES) {
        const id0 = bid(c.b);
        for (let i = 0; i < c.n; i++) {
          if (c.skip && r.next() < c.skip) continue;
          const x = ox + r.int(16), z = oz + r.int(16);
          const y = sampleY(r, c.y);
          oreBlob(world, x, y, z, r.range(c.s[0], c.s[1]), id0, id0, r, host);
        }
      }
      return;
    }
    if (dim === 'end') return;   // the End has no ore

    const host = S().oreHost;
    const blobHost = S().blobHost;
    for (const c of OVERWORLD_BLOBS) {
      const id0 = bid(c.b);
      for (let i = 0; i < c.n; i++) {
        if (c.skip && r.next() < c.skip) continue;
        const x = ox + r.int(16), z = oz + r.int(16);
        const y = sampleY(r, c.y);
        oreBlob(world, x, y, z, r.range(c.s[0], c.s[1]), id0, id0, r, blobHost);
      }
    }
    for (const c of OVERWORLD_ORES) {
      const id0 = bid(c.b), id1 = bid(c.d);
      for (let i = 0; i < c.n; i++) {
        if (c.skip && r.next() < c.skip) continue;
        const x = ox + r.int(16), z = oz + r.int(16);
        const y = sampleY(r, c.y);
        oreBlob(world, x, y, z, r.range(c.s[0], c.s[1]), id0, id1, r, host);
      }
    }

    // Biome-gated extras: emeralds only in the mountains, extra gold in badlands.
    const centre = getBiome(chunk.biomes[(8 << 4) | 8]);
    if (centre && centre.category === 'mountain') {
      const em = bid('emerald_ore'), dem = bid('deepslate_emerald_ore');
      for (let i = 0; i < 9; i++) {
        const x = ox + r.int(16), z = oz + r.int(16);
        const y = sampleY(r, { t: 'tri', min: 20, max: 118 });
        oreBlob(world, x, y, z, r.range(1, 3), em, dem, r, host);
      }
    }
    if (centre && centre.name.indexOf('badlands') >= 0) {
      const go = bid('gold_ore'), dgo = bid('deepslate_gold_ore');
      for (let i = 0; i < 20; i++) {
        const x = ox + r.int(16), z = oz + r.int(16);
        const y = sampleY(r, { t: 'uni', min: 32, max: 80 });
        oreBlob(world, x, y, z, r.range(4, 9), go, dgo, r, host);
      }
    }
  } finally {
    popBounds(saved);
  }
}

/** A single ore vein as a normal feature (handy for structures / debugging). */
def('ore', 'under', (world, x, y, z, rng, args) => {
  const name = (args && args.block) || 'coal_ore';
  const deep = (args && args.deepslate) || ('deepslate_' + name);
  const size = (args && args.size) || rng.range(6, 12);
  const host = world.dimension === 'nether' ? S().netherHost : S().oreHost;
  return oreBlob(world, x, y, z, size, bid(name), bid(BLOCK_BY_NAME.has(deep) ? deep : name), rng, host);
});

// ===========================================================================
// decorateChunk
// ===========================================================================

/** Picks the y a feature should be tried at, given its placement mode. */
function chooseY(world, x, z, mode, rng) {
  if (mode === 'any') return rng.range(2, WORLD_HEIGHT - 4);
  const c = scanColumn(world, x, z);
  switch (mode) {
    case 'surface': {
      if (c.y < 0) return -1;
      if (c.waterY > c.y) return -1;             // submerged: not a land spot
      return c.y + 1;
    }
    case 'water': {
      if (c.y < 0 || c.waterY <= c.y) return -1;
      return c.y + 1;
    }
    case 'shore': {
      // riverbeds and beaches: wet or dry, but only near sea level
      if (c.y < 0 || c.y > SEA_LEVEL + 3) return -1;
      return c.y + 1;
    }
    case 'water_top': {
      if (c.waterY < 0 || c.waterY <= c.y) return -1;
      return c.waterY;
    }
    case 'under': {
      const top = c.y < 0 ? SEA_LEVEL : c.y;
      const hi = Math.max(4, Math.min(top - 2, WORLD_HEIGHT - 6));
      if (hi <= 4) return -1;
      return rng.range(3, hi);
    }
    default:
      return c.y < 0 ? -1 : c.y + 1;
  }
}

/**
 * Runs every feature listed by the biomes present in this chunk.
 *
 * Each biome contributes in proportion to how many of the chunk's 256 columns
 * it actually owns, and every attempt lands on a column belonging to that
 * biome - so a chunk straddling a border decorates each half correctly.
 *
 * Called by worldgen.populateChunk once the 3x3 neighbourhood exists.
 */
export function decorateChunk(chunk, world, rng) {
  if (!chunk || !world) return;
  const cx = chunk.cx, cz = chunk.cz;
  const saved = pushBounds(cx, cz);
  try {
    generateOres(chunk, world, rng);

    const seed = (world.seed | 0);
    // Bucket the columns by biome id.
    const buckets = new Map();
    for (let i = 0; i < 256; i++) {
      const b = chunk.biomes[i];
      let a = buckets.get(b);
      if (!a) { a = []; buckets.set(b, a); }
      a.push(i);
    }
    const ids = Array.from(buckets.keys()).sort((a, b) => a - b);

    for (const bId of ids) {
      const cols = buckets.get(bId);
      const biome = getBiome(bId);
      if (!biome || !biome.features || biome.features.length === 0) continue;
      const share = cols.length / 256;

      for (let fi = 0; fi < biome.features.length; fi++) {
        const entry = biome.features[fi];
        if (typeof entry !== 'string') continue;
        const colon = entry.indexOf(':');
        const name = colon < 0 ? entry : entry.slice(0, colon);
        const fn = FEATURES.get(name);
        if (!fn) continue;
        let per = colon < 0 ? 1 : parseFloat(entry.slice(colon + 1));
        if (!(per > 0)) continue;

        // One independent stream per (chunk, biome, feature): reordering a
        // biome's list can never disturb another feature's placements.
        const r = new RNG(hash3(hash3(seed ^ 0x5f3a91, cx, cz, bId), hashString(name), fi, 0x9e3779b1));

        let n = per * share;
        let tries = Math.floor(n);
        if (r.next() < n - tries) tries++;
        if (tries <= 0) continue;
        if (tries > 96) tries = 96;               // sanity clamp

        const mode = FEATURE_MODE.get(name) || 'surface';
        for (let t = 0; t < tries; t++) {
          const li = cols[r.int(cols.length)];
          const x = (cx << 4) + (li & 15);
          const z = (cz << 4) + ((li >> 4) & 15);
          const y = chooseY(world, x, z, mode, r);
          if (y < 1 || y >= WORLD_HEIGHT - 2) continue;
          try {
            fn(world, x, y, z, r, null);
          } catch (e) {
            console.error('[features] "' + name + '" failed at', x, y, z, e);
          }
        }
      }
    }
  } finally {
    popBounds(saved);
  }
}
