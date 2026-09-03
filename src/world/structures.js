// ============================================================================
// structures.js - Villages, temples, dungeons, fortresses ... (CONTRACT.md §7)
//
// Placement uses the standard Minecraft "spaced grid" rule: the world is cut
// into `spacing x spacing` chunk regions, a region-seeded RNG picks an offset
// inside the region (triangular distribution, so starts drift toward the
// middle), and the structure begins in exactly that chunk if the biome there
// is on the allow list. That makes `structureAt()` a pure function of
// (seed, cx, cz) - which is what /locate and nearestStructure() rely on.
//
// Building is piece-based. A structure emits a list of pieces; every piece
// carries a world origin, a rotation and a local bounding box. A piece is
// rendered once per chunk it overlaps, clipped to that chunk, and pieces whose
// chunks are not loaded yet are parked in PENDING so the neighbouring chunk
// finishes them when it generates. Piece builders must therefore be
// deterministic and must not read blocks they wrote themselves - terrain
// heights come from generator.heightAt(), which works for unloaded columns.
// ============================================================================
import {
  WORLD_HEIGHT, SEA_LEVEL, DIM_OVERWORLD, DIM_NETHER, DIM_END,
} from '../core/constants.js';
import { clamp } from '../core/util.js';
import { RNG, hash3 } from '../core/rng.js';
import { BLOCK_BY_NAME } from './blocks.js';

// ---------------------------------------------------------------------------
// Optional sibling modules. loot.js and mobs.js are written by other passes;
// structures must still generate (with fallback loot, without mobs) if either
// is missing. The imports are kicked off here and re-tried on demand so the
// "lazy import inside generate()" rule holds without making callers async.
// ---------------------------------------------------------------------------
let _loot = null;
let _mobs = null;
let _lootTried = false;
let _mobsTried = false;

function needLoot() {
  if (_loot || _lootTried) return _loot;
  _lootTried = true;
  try { import('../item/loot.js').then((m) => { _loot = m; }).catch(() => {}); } catch { /* no dynamic import */ }
  return _loot;
}
function needMobs() {
  if (_mobs || _mobsTried) return _mobs;
  _mobsTried = true;
  try {
    import('../entity/mobs.js').then((m) => { _mobs = m; flushMobQueue(); }).catch(() => {});
  } catch { /* no dynamic import */ }
  return _mobs;
}
needLoot();
needMobs();

// ---------------------------------------------------------------------------
// Block ids
// ---------------------------------------------------------------------------
const GEN = 0;                    // setBlock flags while generating: silent
const _idCache = new Map();
const _warned = new Set();

/** Numeric id for a block name, memoised. Unknown names resolve to air. */
function bid(name) {
  let v = _idCache.get(name);
  if (v !== undefined) return v;
  const d = BLOCK_BY_NAME.get(name);
  if (d) v = d.id;
  else {
    v = 0;
    if (!_warned.has(name)) { _warned.add(name); console.warn('[structures] unknown block:', name); }
  }
  _idCache.set(name, v);
  return v;
}

const AIR = 0;

/** Accepts a block name or an already-resolved numeric id. */
const idOf = (v) => (typeof v === 'number' ? v : bid(v));

// ---------------------------------------------------------------------------
// Loot
// ---------------------------------------------------------------------------
// Small hand-rolled tables used when item/loot.js has not loaded (or does not
// know the table). Entries are [item, min, max, weight].
const FALLBACK_LOOT = {
  village_house: [['bread', 1, 4, 10], ['wheat_seeds', 1, 3, 8], ['iron_ingot', 1, 2, 3],
    ['emerald', 1, 2, 2], ['oak_sapling', 1, 2, 5], ['stick', 1, 3, 6], ['apple', 1, 2, 4]],
  village_weaponsmith: [['iron_ingot', 1, 3, 8], ['diamond', 1, 1, 2], ['iron_sword', 1, 1, 3],
    ['iron_pickaxe', 1, 1, 3], ['obsidian', 3, 7, 3], ['gold_ingot', 1, 3, 4], ['bread', 1, 3, 6]],
  village_temple: [['emerald', 1, 3, 5], ['gold_ingot', 1, 2, 3], ['redstone', 1, 4, 6],
    ['lapis_lazuli', 1, 4, 4], ['bread', 1, 3, 6]],
  desert_pyramid: [['gold_ingot', 2, 7, 5], ['bone', 4, 6, 8], ['gunpowder', 1, 8, 8],
    ['rotten_flesh', 3, 7, 8], ['emerald', 1, 3, 4], ['diamond', 1, 3, 2],
    ['iron_ingot', 1, 5, 6], ['golden_apple', 1, 1, 2], ['enchanted_book', 1, 1, 3],
    ['saddle', 1, 1, 3], ['iron_horse_armor', 1, 1, 1]],
  jungle_temple: [['diamond', 1, 3, 2], ['iron_ingot', 1, 5, 6], ['gold_ingot', 2, 7, 5],
    ['bamboo', 1, 3, 6], ['emerald', 1, 3, 4], ['bone', 4, 6, 8], ['rotten_flesh', 3, 7, 8],
    ['saddle', 1, 1, 3], ['enchanted_book', 1, 1, 2]],
  jungle_temple_dispenser: [['arrow', 2, 7, 30]],
  igloo_chest: [['apple', 1, 3, 6], ['coal', 1, 4, 8], ['gold_nugget', 1, 3, 4],
    ['stone_axe', 1, 1, 2], ['emerald', 1, 1, 1], ['wheat', 2, 3, 6], ['golden_apple', 1, 1, 1]],
  pillager_outpost: [['crossbow', 1, 1, 2], ['arrow', 2, 7, 8], ['wheat', 3, 5, 7],
    ['potato', 2, 5, 7], ['carrot', 3, 5, 7], ['dark_oak_log', 2, 3, 4],
    ['iron_ingot', 1, 2, 3], ['tripwire_hook', 1, 1, 2]],
  woodland_mansion: [['diamond', 1, 3, 2], ['gold_ingot', 1, 3, 4], ['iron_ingot', 1, 5, 6],
    ['emerald', 1, 3, 3], ['enchanted_book', 1, 1, 3], ['golden_apple', 1, 1, 2],
    ['bread', 1, 3, 6], ['redstone', 1, 4, 5], ['lead', 1, 1, 3]],
  monster_room: [['saddle', 1, 1, 6], ['golden_apple', 1, 1, 2], ['bread', 1, 1, 6],
    ['wheat', 1, 4, 6], ['gunpowder', 1, 4, 6], ['string', 1, 4, 6], ['redstone', 1, 4, 6],
    ['iron_ingot', 1, 4, 5], ['bucket', 1, 1, 2], ['enchanted_book', 1, 1, 2],
    ['name_tag', 1, 1, 2], ['bone', 1, 3, 6]],
  abandoned_mineshaft: [['rail', 4, 8, 20], ['powered_rail', 1, 4, 5], ['detector_rail', 1, 4, 5],
    ['torch', 1, 16, 15], ['bread', 1, 3, 15], ['iron_ingot', 1, 5, 10], ['gold_ingot', 1, 3, 5],
    ['diamond', 1, 2, 3], ['lapis_lazuli', 1, 4, 5], ['redstone', 4, 9, 5],
    ['melon_seeds', 2, 4, 5], ['pumpkin_seeds', 2, 4, 5], ['name_tag', 1, 1, 3],
    ['golden_apple', 1, 1, 1]],
  stronghold_corridor: [['iron_ingot', 1, 5, 10], ['gold_ingot', 1, 3, 5], ['redstone', 4, 9, 5],
    ['bread', 1, 3, 15], ['apple', 1, 3, 15], ['iron_pickaxe', 1, 1, 5], ['ender_pearl', 1, 1, 3],
    ['enchanted_book', 1, 1, 3], ['saddle', 1, 1, 3]],
  stronghold_crossing: [['iron_ingot', 1, 5, 10], ['gold_ingot', 1, 3, 5], ['redstone', 4, 9, 5],
    ['coal', 3, 8, 10], ['bread', 1, 3, 15], ['apple', 1, 3, 15], ['iron_pickaxe', 1, 1, 5]],
  stronghold_library: [['book', 1, 3, 20], ['paper', 2, 7, 20], ['map', 1, 1, 5],
    ['compass', 1, 1, 5], ['enchanted_book', 1, 1, 10], ['bread', 1, 3, 15]],
  ruined_portal: [['obsidian', 1, 2, 40], ['flint_and_steel', 1, 1, 40], ['fire_charge', 1, 1, 40],
    ['gold_nugget', 4, 24, 40], ['gold_ingot', 1, 2, 15], ['golden_apple', 1, 1, 15],
    ['golden_sword', 1, 1, 5], ['golden_helmet', 1, 1, 5], ['bell', 1, 1, 5],
    ['flint', 1, 1, 40], ['iron_nugget', 9, 18, 40]],
  shipwreck_map: [['map', 1, 1, 12], ['compass', 1, 1, 8], ['paper', 1, 10, 20],
    ['clock', 1, 1, 8], ['feather', 1, 5, 20], ['book', 1, 5, 5]],
  shipwreck_supply: [['bread', 1, 3, 10], ['rotten_flesh', 1, 3, 10], ['carrot', 1, 4, 10],
    ['potato', 2, 6, 10], ['wheat', 8, 21, 10], ['gunpowder', 1, 5, 5], ['tnt', 1, 2, 3],
    ['leather_helmet', 1, 1, 3], ['leather_chestplate', 1, 1, 3], ['bamboo', 1, 3, 5],
    ['coal', 2, 8, 6], ['paper', 1, 12, 8]],
  shipwreck_treasure: [['iron_ingot', 1, 5, 90], ['gold_ingot', 1, 5, 10], ['emerald', 1, 5, 40],
    ['diamond', 1, 1, 5], ['experience_bottle', 1, 1, 5], ['lapis_lazuli', 1, 10, 20],
    ['gold_nugget', 1, 10, 10], ['iron_nugget', 1, 10, 50], ['nautilus_shell', 1, 1, 5]],
  buried_treasure: [['heart_of_the_sea', 1, 1, 1], ['iron_ingot', 1, 4, 20], ['gold_ingot', 1, 4, 10],
    ['tnt', 1, 2, 5], ['emerald', 4, 8, 5], ['diamond', 1, 2, 5], ['prismarine_crystals', 1, 5, 5],
    ['cooked_cod', 2, 4, 15], ['cooked_salmon', 2, 4, 15], ['leather_chestplate', 1, 1, 5]],
  underwater_ruin_small: [['coal', 1, 4, 10], ['wheat', 2, 3, 10], ['gold_nugget', 1, 3, 10],
    ['emerald', 1, 1, 5], ['leather_helmet', 1, 1, 5], ['stone_axe', 1, 1, 5],
    ['fishing_rod', 1, 1, 5], ['map', 1, 1, 5]],
  underwater_ruin_big: [['gold_ingot', 1, 2, 5], ['emerald', 1, 2, 5], ['diamond', 1, 1, 1],
    ['coal', 1, 4, 10], ['wheat', 2, 3, 10], ['golden_apple', 1, 1, 2], ['map', 1, 1, 5],
    ['enchanted_book', 1, 1, 5]],
  ocean_monument: [['prismarine_shard', 2, 5, 12], ['prismarine_crystals', 1, 3, 8],
    ['gold_block', 1, 1, 1], ['cooked_cod', 2, 4, 8], ['sponge', 1, 2, 4]],
  nether_bridge: [['diamond', 1, 3, 5], ['iron_ingot', 1, 5, 5], ['gold_ingot', 1, 3, 15],
    ['golden_sword', 1, 1, 5], ['golden_chestplate', 1, 1, 5], ['flint_and_steel', 1, 1, 5],
    ['nether_wart', 3, 7, 5], ['saddle', 1, 1, 10], ['obsidian', 2, 4, 5],
    ['gold_nugget', 4, 24, 10]],
  bastion_treasure: [['netherite_ingot', 1, 1, 5], ['diamond', 2, 6, 10], ['gold_ingot', 4, 9, 15],
    ['gold_block', 1, 2, 8], ['ancient_debris', 1, 2, 6], ['crying_obsidian', 1, 3, 10],
    ['enchanted_book', 1, 1, 8], ['golden_apple', 1, 1, 6], ['spectral_arrow', 6, 12, 10]],
  bastion_other: [['gold_nugget', 2, 8, 20], ['gold_ingot', 1, 3, 15], ['crying_obsidian', 1, 2, 10],
    ['obsidian', 1, 2, 10], ['string', 2, 4, 10], ['arrow', 5, 17, 10],
    ['iron_nugget', 2, 8, 15], ['golden_carrot', 1, 3, 10], ['magma_cream', 1, 2, 10]],
  end_city_treasure: [['diamond', 2, 7, 5], ['iron_ingot', 4, 8, 10], ['gold_ingot', 2, 7, 15],
    ['emerald', 2, 6, 10], ['beetroot_seeds', 1, 10, 5], ['saddle', 1, 1, 3],
    ['diamond_sword', 1, 1, 3], ['diamond_chestplate', 1, 1, 3], ['iron_pickaxe', 1, 1, 5],
    ['enchanted_book', 1, 1, 5], ['golden_apple', 1, 1, 3]],
  ancient_city: [['echo_shard', 1, 3, 8], ['disc_fragment_5', 1, 1, 4], ['sculk_catalyst', 1, 2, 4],
    ['enchanted_book', 1, 1, 10], ['diamond', 1, 3, 6], ['iron_ingot', 1, 5, 10],
    ['soul_torch', 1, 4, 10], ['candle', 1, 4, 8], ['sculk', 4, 10, 6],
    ['compass', 1, 1, 3], ['name_tag', 1, 1, 4], ['golden_apple', 1, 1, 3]],
  ancient_city_ice_box: [['ice', 1, 3, 10], ['packed_ice', 1, 2, 5], ['snowball', 1, 8, 10],
    ['cooked_beef', 1, 3, 8]],
  trail_ruins_common: [['emerald', 1, 2, 8], ['wheat', 1, 4, 10], ['stick', 1, 4, 10],
    ['brick', 1, 3, 8], ['string', 1, 4, 8], ['coal', 1, 3, 8], ['wooden_hoe', 1, 1, 4]],
  trail_ruins_rare: [['gold_ingot', 1, 2, 4], ['diamond', 1, 1, 2], ['enchanted_book', 1, 1, 4],
    ['music_disc_relic', 1, 1, 2], ['emerald', 2, 5, 6]],
  witch_hut: [['glass_bottle', 1, 3, 10], ['spider_eye', 1, 3, 10], ['sugar', 1, 3, 8],
    ['glowstone_dust', 1, 3, 6], ['redstone', 1, 4, 6], ['gunpowder', 1, 3, 8]],
  desert_well: [['gold_nugget', 1, 4, 8], ['emerald', 1, 2, 4], ['bone', 1, 4, 8],
    ['dead_bush', 1, 2, 6], ['sand', 4, 12, 10]],
  fossil: [['bone', 4, 10, 12], ['coal', 1, 4, 8]],
  default: [['bread', 1, 3, 10], ['iron_ingot', 1, 3, 6], ['coal', 1, 5, 8],
    ['gold_ingot', 1, 2, 4], ['emerald', 1, 2, 3], ['stick', 1, 4, 8]],
};

/** Rolls the fallback table when item/loot.js cannot answer. */
function fallbackLoot(table, rng) {
  const entries = FALLBACK_LOOT[table] || FALLBACK_LOOT.default;
  const n = rng.range(3, 6);
  const out = [];
  let total = 0;
  for (const e of entries) total += e[3];
  for (let i = 0; i < n; i++) {
    let r = rng.next() * total;
    let pick = entries[entries.length - 1];
    for (const e of entries) { r -= e[3]; if (r <= 0) { pick = e; break; } }
    out.push({ item: pick[0], count: rng.range(pick[1], pick[2]), damage: 0 });
  }
  return out;
}

/**
 * Chest contents for a loot table. Delegates to item/loot.js when it is
 * available and falls back to a small built-in table otherwise.
 */
function rollLoot(table, rng) {
  const m = needLoot();
  if (m && typeof m.chestLoot === 'function') {
    try {
      const r = m.chestLoot(table, rng);
      if (Array.isArray(r) && r.length) return r;
    } catch (e) { console.warn('[structures] loot table failed:', table, e); }
  }
  return fallbackLoot(table, rng);
}

// ---------------------------------------------------------------------------
// Mobs
// ---------------------------------------------------------------------------
const _mobQueue = [];

/** Spawns queued mobs once entity/mobs.js finishes loading. */
function flushMobQueue() {
  if (!_mobs || typeof _mobs.createMob !== 'function') return;
  while (_mobQueue.length) {
    const q = _mobQueue.shift();
    if (!q.world || !q.world.chunks) continue;
    doSpawn(q.world, q.name, q.x, q.y, q.z, q.opts);
  }
}

function doSpawn(world, name, x, y, z, opts) {
  try {
    const e = _mobs.createMob(name, world, x, y, z, opts || {});
    if (!e) return null;
    if (opts) for (const k of Object.keys(opts)) { if (e[k] === undefined) e[k] = opts[k]; }
    if (opts && opts.persistent !== false) e.persistent = true;
    world.addEntity(e);
    return e;
  } catch (e) {
    console.warn('[structures] could not spawn', name, e);
    return null;
  }
}

/** Spawns a structure mob, deferring until entity/mobs.js is ready. */
function spawnMob(world, name, x, y, z, opts = null) {
  if (!world) return null;
  needMobs();
  if (_mobs && typeof _mobs.createMob === 'function') return doSpawn(world, name, x, y, z, opts);
  if (_mobQueue.length < 512) _mobQueue.push({ world, name, x, y, z, opts });
  return null;
}

// ---------------------------------------------------------------------------
// Terrain sampling
// ---------------------------------------------------------------------------
/** First free y above the terrain at a column - works for unloaded chunks. */
function surfaceY(world, x, z) {
  const g = world && world.generator;
  if (g && typeof g.heightAt === 'function') {
    try { return clamp(g.heightAt(x | 0, z | 0) | 0, 1, WORLD_HEIGHT - 1); } catch { /* fall through */ }
  }
  const h = world ? world.getHeight(x, z) : SEA_LEVEL;
  return clamp(h | 0, 1, WORLD_HEIGHT - 1);
}

/** Average / spread of the surface over a footprint; used to level a build. */
function surveyGround(world, x0, z0, x1, z1, step = 2) {
  let sum = 0, n = 0, min = WORLD_HEIGHT, max = 0;
  for (let z = z0; z <= z1; z += step) {
    for (let x = x0; x <= x1; x += step) {
      const h = surfaceY(world, x, z);
      sum += h; n++;
      if (h < min) min = h;
      if (h > max) max = h;
    }
  }
  return { avg: n ? Math.round(sum / n) : SEA_LEVEL, min, max, spread: max - min };
}

/** Biome name at a world column (null when unknown). */
function biomeNameAt(world, x, z) {
  try {
    const b = world.biomeAt(x, z);
    return b ? b.name : null;
  } catch { return null; }
}

// ---------------------------------------------------------------------------
// Rotation. A piece is authored in local (u, v) space where at rot 0
// +u = east (+X) and +v = south (+Z). Rotating by r steps 90 degrees so that
// +u follows HFACE_DIRS[(r + 1) & 3], which makes horizontal facing metadata
// map with a simple (facing + rot) & 3.
// ---------------------------------------------------------------------------
const UX = [1, 0, -1, 0], UZ = [0, 1, 0, -1];
const VX = [0, -1, 0, 1], VZ = [1, 0, -1, 0];

/** Builds a piece record with a world-space bounding box for chunk routing. */
function piece(kind, x, y, z, rot, u0, v0, u1, v1, o = null) {
  const r = rot & 3;
  const xs = [
    x + u0 * UX[r] + v0 * VX[r], x + u1 * UX[r] + v0 * VX[r],
    x + u0 * UX[r] + v1 * VX[r], x + u1 * UX[r] + v1 * VX[r],
  ];
  const zs = [
    z + u0 * UZ[r] + v0 * VZ[r], z + u1 * UZ[r] + v0 * VZ[r],
    z + u0 * UZ[r] + v1 * VZ[r], z + u1 * UZ[r] + v1 * VZ[r],
  ];
  return {
    kind, x, y, z, rot: r, o,
    bx0: Math.min(xs[0], xs[1], xs[2], xs[3]), bx1: Math.max(xs[0], xs[1], xs[2], xs[3]),
    bz0: Math.min(zs[0], zs[1], zs[2], zs[3]), bz1: Math.max(zs[0], zs[1], zs[2], zs[3]),
  };
}

// ---------------------------------------------------------------------------
// Build - a clipped writer for one (piece, chunk) pair.
// ---------------------------------------------------------------------------
class Build {
  constructor(world, cx, cz) {
    this.world = world;
    this.seed = (world.seed | 0) ^ 0x5c0f;
    this.cx = cx; this.cz = cz;
    this.minX = cx << 4; this.minZ = cz << 4;
    this.maxX = this.minX + 15; this.maxZ = this.minZ + 15;
    const c = world.getChunk(cx, cz);
    this.chunk = c;
    // A chunk that has already been lit is on screen: those writes must dirty
    // the mesh, while freshly generated chunks are meshed later anyway.
    this.flags = c && c.lit ? 1 : GEN;
    this.ox = 0; this.oy = 0; this.oz = 0; this.rot = 0;
    this.primary = false;
    this.o = {};
    this.rng = new RNG(1);
  }

  /** Points the writer at a piece. Re-seeds the deterministic piece RNG. */
  place(p) {
    this.ox = p.x; this.oy = p.y; this.oz = p.z; this.rot = p.rot & 3;
    this.o = p.o || {};
    this.rng = new RNG(hash3(this.seed, p.x, (p.y << 2) | p.rot, p.z));
    this.primary = (p.x >> 4) === this.cx && (p.z >> 4) === this.cz;
    return this;
  }

  // ---- coordinate mapping -------------------------------------------------
  wx(u, v) { return this.ox + u * UX[this.rot] + v * VX[this.rot]; }
  wz(u, v) { return this.oz + u * UZ[this.rot] + v * VZ[this.rot]; }
  /** Local horizontal facing -> world horizontal facing. */
  hf(f) { return (f + this.rot) & 3; }
  /** Local column axis (0 y, 1 x, 2 z) -> world axis. */
  ax(a) { return a === 0 ? 0 : (this.rot & 1) ? (a === 1 ? 2 : 1) : a; }
  /** Deterministic 0..1 value tied to a local position (clip-independent). */
  prand(u, y, v) { return hash3(this.seed ^ 0x77, this.wx(u, v), this.oy + y, this.wz(u, v)) / 4294967296; }

  // ---- writes -------------------------------------------------------------
  set(u, y, v, id, meta = 0) {
    const x = this.wx(u, v);
    if (x < this.minX || x > this.maxX) return false;
    const z = this.wz(u, v);
    if (z < this.minZ || z > this.maxZ) return false;
    const yy = this.oy + y;
    if (yy < 0 || yy >= WORLD_HEIGHT) return false;
    return this.world.setBlock(x, yy, z, id, meta, this.flags);
  }
  /** Reads a block id in local space (0 when the column is not loaded). */
  get(u, y, v) { return this.world.getBlock(this.wx(u, v), this.oy + y, this.wz(u, v)); }
  /** Surface height (first free y) at a local column, in local y. */
  ground(u, v) { return surfaceY(this.world, this.wx(u, v), this.wz(u, v)) - this.oy; }

  /** True when a local box could touch this chunk at all. */
  touches(u0, v0, u1, v1) {
    const a = this.wx(u0, v0), b = this.wx(u1, v0), c = this.wx(u0, v1), d = this.wx(u1, v1);
    if (Math.max(a, b, c, d) < this.minX || Math.min(a, b, c, d) > this.maxX) return false;
    const e = this.wz(u0, v0), f = this.wz(u1, v0), g = this.wz(u0, v1), h = this.wz(u1, v1);
    if (Math.max(e, f, g, h) < this.minZ || Math.min(e, f, g, h) > this.maxZ) return false;
    return true;
  }

  fill(u0, y0, v0, u1, y1, v1, id, meta = 0) {
    if (u0 > u1) { const t = u0; u0 = u1; u1 = t; }
    if (v0 > v1) { const t = v0; v0 = v1; v1 = t; }
    if (y0 > y1) { const t = y0; y0 = y1; y1 = t; }
    if (!this.touches(u0, v0, u1, v1)) return;
    for (let v = v0; v <= v1; v++) {
      for (let u = u0; u <= u1; u++) {
        const x = this.wx(u, v); if (x < this.minX || x > this.maxX) continue;
        const z = this.wz(u, v); if (z < this.minZ || z > this.maxZ) continue;
        for (let y = y0; y <= y1; y++) {
          const yy = this.oy + y;
          if (yy < 0 || yy >= WORLD_HEIGHT) continue;
          this.world.setBlock(x, yy, z, id, meta, this.flags);
        }
      }
    }
  }

  /** Weighted per-cell fill. Choices are [id, meta, weight] - positional RNG. */
  fillMix(u0, y0, v0, u1, y1, v1, choices) {
    if (!this.touches(Math.min(u0, u1), Math.min(v0, v1), Math.max(u0, u1), Math.max(v0, v1))) return;
    let total = 0;
    for (const c of choices) total += c[2];
    for (let v = Math.min(v0, v1); v <= Math.max(v0, v1); v++) {
      for (let u = Math.min(u0, u1); u <= Math.max(u0, u1); u++) {
        const x = this.wx(u, v); if (x < this.minX || x > this.maxX) continue;
        const z = this.wz(u, v); if (z < this.minZ || z > this.maxZ) continue;
        for (let y = Math.min(y0, y1); y <= Math.max(y0, y1); y++) {
          const yy = this.oy + y;
          if (yy < 0 || yy >= WORLD_HEIGHT) continue;
          let r = (hash3(this.seed ^ 0x51a, x, yy, z) / 4294967296) * total;
          let pick = choices[choices.length - 1];
          for (const c of choices) { r -= c[2]; if (r <= 0) { pick = c; break; } }
          if (pick[0] >= 0) this.world.setBlock(x, yy, z, pick[0], pick[1], this.flags);
        }
      }
    }
  }

  /** Hollow shell: walls plus floor and ceiling. */
  box(u0, y0, v0, u1, y1, v1, id, meta = 0) {
    this.fill(u0, y0, v0, u1, y0, v1, id, meta);
    this.fill(u0, y1, v0, u1, y1, v1, id, meta);
    this.walls(u0, y0, v0, u1, y1, v1, id, meta);
  }
  /** The four vertical faces of a box. */
  walls(u0, y0, v0, u1, y1, v1, id, meta = 0) {
    this.fill(u0, y0, v0, u1, y1, v0, id, meta);
    this.fill(u0, y0, v1, u1, y1, v1, id, meta);
    this.fill(u0, y0, v0, u0, y1, v1, id, meta);
    this.fill(u1, y0, v0, u1, y1, v1, id, meta);
  }
  clear(u0, y0, v0, u1, y1, v1) { this.fill(u0, y0, v0, u1, y1, v1, AIR, 0); }

  /** Digs out everything above the footprint so a build is never buried. */
  clearAbove(u0, v0, u1, v1, height) {
    for (let v = Math.min(v0, v1); v <= Math.max(v0, v1); v++) {
      for (let u = Math.min(u0, u1); u <= Math.max(u0, u1); u++) {
        const x = this.wx(u, v); if (x < this.minX || x > this.maxX) continue;
        const z = this.wz(u, v); if (z < this.minZ || z > this.maxZ) continue;
        const top = Math.max(this.oy + height, surfaceY(this.world, x, z) + 1);
        for (let y = this.oy; y <= top; y++) {
          if (y < 0 || y >= WORLD_HEIGHT) continue;
          this.world.setBlock(x, y, z, AIR, 0, this.flags);
        }
      }
    }
  }

  /** Extends a footprint down to the terrain so the build is never floating. */
  foundation(u0, v0, u1, v1, id, meta = 0, maxDrop = 12) {
    for (let v = Math.min(v0, v1); v <= Math.max(v0, v1); v++) {
      for (let u = Math.min(u0, u1); u <= Math.max(u0, u1); u++) {
        const x = this.wx(u, v); if (x < this.minX || x > this.maxX) continue;
        const z = this.wz(u, v); if (z < this.minZ || z > this.maxZ) continue;
        const g = surfaceY(this.world, x, z);
        const bottom = Math.max(1, Math.min(g - 1, this.oy - maxDrop));
        for (let y = this.oy - 1; y >= bottom; y--) this.world.setBlock(x, y, z, id, meta, this.flags);
      }
    }
  }

  // ---- furniture ----------------------------------------------------------
  /** Wall torch on the face pointing in local direction f (0 N, 1 E, 2 S, 3 W). */
  torch(u, y, v, f, name = 'wall_torch') { this.set(u, y, v, bid(name), this.hf(f) + 1); }
  standTorch(u, y, v, name = 'torch') { this.set(u, y, v, bid(name), 0); }
  /** Two-block door; facing is the direction the door looks toward. */
  door(u, y, v, f, name = 'oak_door', open = false) {
    const id = bid(name), wf = this.hf(f), o = open ? 8 : 0;
    this.set(u, y, v, id, (wf << 1) | o);
    this.set(u, y + 1, v, id, 1 | (wf << 1) | o);
  }
  /** Bed with the head one step along local facing f. */
  bed(u, y, v, f, color = 'red') {
    const id = bid(color + '_bed'), wf = this.hf(f);
    const d = HDX[wf], e = HDZ[wf];
    const x = this.wx(u, v), z = this.wz(u, v), yy = this.oy + y;
    if (x >= this.minX && x <= this.maxX && z >= this.minZ && z <= this.maxZ) {
      this.world.setBlock(x, yy, z, id, wf, this.flags);
    }
    if (x + d >= this.minX && x + d <= this.maxX && z + e >= this.minZ && z + e <= this.maxZ) {
      this.world.setBlock(x + d, yy, z + e, id, wf | 4, this.flags);
    }
  }
  /** Chest with loot. Only the owning chunk rolls the table. */
  chest(u, y, v, f, table, name = 'chest') {
    const x = this.wx(u, v), z = this.wz(u, v), yy = this.oy + y;
    if (x < this.minX || x > this.maxX || z < this.minZ || z > this.maxZ) return;
    this.world.setBlock(x, yy, z, bid(name), this.hf(f), this.flags);
    const be = this.world.getBlockEntity(x, yy, z);
    if (!be) return;
    const r = new RNG(hash3(this.seed ^ 0xc4e5, x, yy, z));
    const items = new Array(27).fill(null);
    const rolled = rollLoot(table, r);
    const slots = [];
    for (let i = 0; i < 27; i++) slots.push(i);
    r.shuffle(slots);
    for (let i = 0; i < rolled.length && i < 27; i++) items[slots[i]] = rolled[i];
    be.items = items;
    be.lootTable = table;
  }
  /** Monster spawner cycling one mob type. */
  spawner(u, y, v, mob) {
    const x = this.wx(u, v), z = this.wz(u, v), yy = this.oy + y;
    if (x < this.minX || x > this.maxX || z < this.minZ || z > this.maxZ) return;
    this.world.setBlock(x, yy, z, bid('spawner'), 0, this.flags);
    const be = this.world.getBlockEntity(x, yy, z);
    if (!be) return;
    be.mob = mob;
    be.delay = 20;
    be.minDelay = 200;
    be.maxDelay = 800;
    be.spawnCount = 4;
    be.maxNearby = 6;
    be.requiredPlayerRange = 16;
    be.spawnRange = 4;
  }
  /** Spawns a mob at a local position - once, from the piece's own chunk. */
  mob(u, y, v, name, opts = null) {
    if (!this.primary) return;
    spawnMob(this.world, name, this.wx(u, v) + 0.5, this.oy + y, this.wz(u, v) + 0.5, opts);
  }
  /** Rail with a straight shape aligned to the local u (0) or v (1) axis. */
  rail(u, y, v, along = 0, name = 'rail') {
    // shape 0 = north/south (z), 1 = east/west (x)
    const worldAlongX = (along === 0) ? ((this.rot & 1) === 0) : ((this.rot & 1) === 1);
    this.set(u, y, v, bid(name), worldAlongX ? 1 : 0);
  }
  /** Upright log/pillar with the correct axis metadata. */
  pillar(u, y0, v, y1, block) {
    this.fill(u, y0, v, u, y1, v, idOf(block), 0);
  }
  /** Horizontal log along the local u (1) or v (2) axis. */
  beam(u0, y, v0, u1, v1, block, axis) {
    this.fill(u0, y, v0, u1, y, v1, idOf(block), this.ax(axis));
  }
  /** Stairs facing local direction f, optionally upside down. */
  stair(u, y, v, name, f, upsideDown = false) {
    this.set(u, y, v, bid(name), this.hf(f) | (upsideDown ? 4 : 0));
  }
  slab(u, y, v, name, top = false) { this.set(u, y, v, bid(name), top ? 1 : 0); }
}

const HDX = [0, 1, 0, -1];   // HFACE 0 north, 1 east, 2 south, 3 west
const HDZ = [-1, 0, 1, 0];

// ---------------------------------------------------------------------------
// Piece registry - kind -> build(b) using b.o for options.
// ---------------------------------------------------------------------------
const PIECES = Object.create(null);

/** Renders one piece into one chunk. Never throws. */
function buildPiece(world, p, cx, cz) {
  const fn = PIECES[p.kind];
  if (!fn) return;
  const b = new Build(world, cx, cz);
  b.place(p);
  try { fn(b); } catch (e) { console.error('[structures] piece "' + p.kind + '" failed', e); }
  if (b.chunk) b.chunk.dirty = true;
}

// ---------------------------------------------------------------------------
// Pending pieces: work parked for chunks that are not generated yet.
// ---------------------------------------------------------------------------
const PENDING = new Map();     // 'dim|cx,cz' -> piece[]
const PENDING_LIMIT = 6000;

const pkey = (dim, cx, cz) => dim + '|' + cx + ',' + cz;

function addPending(dim, cx, cz, p) {
  const k = pkey(dim, cx, cz);
  let a = PENDING.get(k);
  if (!a) {
    if (PENDING.size >= PENDING_LIMIT) {
      // Oldest first: chunks that far away are not coming back soon.
      const first = PENDING.keys().next();
      if (!first.done) PENDING.delete(first.value);
    }
    a = [];
    PENDING.set(k, a);
  }
  if (a.length < 400) a.push(p);
}

/** Renders (and forgets) any pieces parked for a chunk. */
function drainPending(world, cx, cz) {
  const k = pkey(world.dimension || DIM_OVERWORLD, cx, cz);
  const a = PENDING.get(k);
  if (!a) return;
  PENDING.delete(k);
  for (let i = 0; i < a.length; i++) buildPiece(world, a[i], cx, cz);
}

/**
 * Routes a list of pieces: draw immediately into every generated chunk they
 * touch, park the rest. Pieces are clipped, so a piece may be drawn many times.
 */
function emitPieces(world, pieces) {
  const dim = world.dimension || DIM_OVERWORLD;
  for (let i = 0; i < pieces.length; i++) {
    const p = pieces[i];
    const c0x = p.bx0 >> 4, c1x = p.bx1 >> 4, c0z = p.bz0 >> 4, c1z = p.bz1 >> 4;
    for (let cz = c0z; cz <= c1z; cz++) {
      for (let cx = c0x; cx <= c1x; cx++) {
        if (world.isChunkGenerated && world.isChunkGenerated(cx, cz)) buildPiece(world, p, cx, cz);
        else addPending(dim, cx, cz, p);
      }
    }
  }
}

/** Drops every parked piece - used when a world is thrown away. */
export function clearPendingStructures() { PENDING.clear(); }

// ---------------------------------------------------------------------------
// Registry and grid placement
// ---------------------------------------------------------------------------
export const STRUCTURES = new Map();
const SCATTERED = [];          // structures rolled per chunk instead of per region
// structureAt returns the first match, so the rarest structures are tested
// first: a mansion must never be shadowed by a mineshaft that shares a chunk.
const ORDER = [];

/**
 * Registers a structure.
 * @param {string} name canonical snake_case name
 * @param {object} def { spacing, separation, salt, dimension, biomes, generate }
 */
export function registerStructure(name, def) {
  const d = {
    name,
    spacing: def.spacing || 32,
    separation: def.separation || 8,
    salt: (def.salt | 0) || 0,
    dimension: def.dimension || DIM_OVERWORLD,
    biomes: def.biomes || null,
    minY: def.minY === undefined ? null : def.minY,
    maxY: def.maxY === undefined ? null : def.maxY,
    fixed: def.fixed || null,
    scatter: def.scatter || 0,
    scatterChance: def.scatterChance || 0,
    display: def.display || name.replace(/_/g, ' '),
    generate: def.generate || (() => {}),
  };
  if (d.separation >= d.spacing) d.separation = d.spacing - 1;
  d.biomeSet = d.biomes ? new Set(d.biomes) : null;
  STRUCTURES.set(name, d);
  if (d.scatter) SCATTERED.push(d);
  else {
    ORDER.push(d);
    ORDER.sort((a, c) => (c.fixed ? 1 : 0) - (a.fixed ? 1 : 0) || c.spacing - a.spacing);
  }
  return d;
}

/** The chunk in region (rx, rz) that a structure would start in. */
function regionStart(seed, def, rx, rz) {
  const range = Math.max(1, def.spacing - def.separation);
  const r = new RNG(hash3((seed | 0) ^ def.salt, rx, rz, def.salt || 0x1f));
  // Triangular offset: like vanilla, starts cluster toward the region middle.
  const ou = ((r.int(range) + r.int(range)) / 2) | 0;
  const ov = ((r.int(range) + r.int(range)) / 2) | 0;
  return [rx * def.spacing + ou, rz * def.spacing + ov];
}

/** True when this exact chunk is the grid start for a structure. */
function startsHere(seed, def, cx, cz) {
  if (def.fixed) return cx === def.fixed[0] && cz === def.fixed[1];
  const rx = Math.floor(cx / def.spacing), rz = Math.floor(cz / def.spacing);
  const s = regionStart(seed, def, rx, rz);
  return s[0] === cx && s[1] === cz;
}

/** Per-chunk hit test for scattered structures (dungeons). */
function scatterHits(seed, def, cx, cz) {
  const out = [];
  const r = new RNG(hash3((seed | 0) ^ def.salt, cx, cz, 0x5ca7));
  for (let i = 0; i < def.scatter; i++) {
    const u = r.int(16), v = r.int(16), y = r.range(6, 90);
    if (r.next() < def.scatterChance) out.push([u, y, v]);
  }
  return out;
}

/**
 * The structure that should start in this chunk, or null. Pure in its
 * arguments so /locate can probe chunks that were never generated.
 */
export function structureAt(seed, cx, cz, dimension = DIM_OVERWORLD, biomeName = null) {
  for (const def of ORDER) {
    if (def.dimension && def.dimension !== dimension) continue;
    if (!startsHere(seed, def, cx, cz)) continue;
    if (def.biomeSet && biomeName && !def.biomeSet.has(biomeName)) continue;
    return def;
  }
  return null;
}

/**
 * Called by worldgen.populateChunk. Finishes any structure pieces parked for
 * this chunk, then starts whatever structure the grid says belongs here.
 */
export function generateStructures(chunk, world, rng) {
  if (!chunk || !world) return;
  const dim = world.dimension || DIM_OVERWORLD;
  const seed = world.seed | 0;
  const cx = chunk.cx, cz = chunk.cz;

  drainPending(world, cx, cz);

  const biome = biomeNameAt(world, (cx << 4) + 8, (cz << 4) + 8);
  const def = structureAt(seed, cx, cz, dim, biome);
  if (def) {
    const r = new RNG(hash3(seed ^ (def.salt || 0x33), cx, cz, 0x51ce));
    try { def.generate(world, cx, cz, r); } catch (e) {
      console.error('[structures] "' + def.name + '" failed at chunk', cx, cz, e);
    }
  }

  for (const s of SCATTERED) {
    if (s.dimension && s.dimension !== dim) continue;
    if (s.biomeSet && biome && !s.biomeSet.has(biome)) continue;
    const hits = scatterHits(seed, s, cx, cz);
    for (const h of hits) {
      const r = new RNG(hash3(seed ^ s.salt, (cx << 4) + h[0], h[1], (cz << 4) + h[2]));
      try { s.generate(world, cx, cz, r, h); } catch (e) {
        console.error('[structures] "' + s.name + '" failed', e);
      }
    }
  }
}

/**
 * Nearest start of a named structure to a world position. Used by /locate.
 * @returns {{name:string,x:number,y:number,z:number,distance:number}|null}
 */
export function nearestStructure(world, name, x, z, maxRadius = 6400) {
  const def = STRUCTURES.get(name);
  if (!def || !world) return null;
  const dim = world.dimension || DIM_OVERWORLD;
  if (def.dimension && def.dimension !== dim) return null;
  const seed = world.seed | 0;
  const at = (bx, bz) => {
    const y = surfaceY(world, bx, bz);
    return { name, x: bx, y, z: bz, distance: Math.hypot(bx - x, bz - z) };
  };

  if (def.fixed) {
    const bx = (def.fixed[0] << 4) + 8, bz = (def.fixed[1] << 4) + 8;
    const hit = at(bx, bz);
    return hit.distance <= maxRadius ? hit : null;
  }

  const cx0 = Math.floor(x / 16), cz0 = Math.floor(z / 16);

  if (def.scatter) {
    const maxC = Math.max(1, Math.ceil(maxRadius / 16));
    for (let ring = 0; ring <= maxC; ring++) {
      let best = null;
      for (let dz = -ring; dz <= ring; dz++) {
        for (let dx = -ring; dx <= ring; dx++) {
          if (Math.max(Math.abs(dx), Math.abs(dz)) !== ring) continue;
          const cx = cx0 + dx, cz = cz0 + dz;
          if (def.biomeSet) {
            const bn = biomeNameAt(world, (cx << 4) + 8, (cz << 4) + 8);
            if (bn && !def.biomeSet.has(bn)) continue;
          }
          const hits = scatterHits(seed, def, cx, cz);
          if (!hits.length) continue;
          const h = at((cx << 4) + hits[0][0], (cz << 4) + hits[0][2]);
          if (!best || h.distance < best.distance) best = h;
        }
      }
      if (best && best.distance <= maxRadius) return best;
    }
    return null;
  }

  const rx0 = Math.floor(cx0 / def.spacing), rz0 = Math.floor(cz0 / def.spacing);
  const maxRing = Math.max(1, Math.ceil(maxRadius / (16 * def.spacing)) + 1);
  let best = null;
  for (let ring = 0; ring <= maxRing; ring++) {
    for (let dz = -ring; dz <= ring; dz++) {
      for (let dx = -ring; dx <= ring; dx++) {
        if (Math.max(Math.abs(dx), Math.abs(dz)) !== ring) continue;
        const s = regionStart(seed, def, rx0 + dx, rz0 + dz);
        const bx = (s[0] << 4) + 8, bz = (s[1] << 4) + 8;
        if (def.biomeSet) {
          const bn = biomeNameAt(world, bx, bz);
          if (bn && !def.biomeSet.has(bn)) continue;
        }
        const h = at(bx, bz);
        if (h.distance > maxRadius) continue;
        if (!best || h.distance < best.distance) best = h;
      }
    }
    // One extra ring past the first hit, so a closer neighbour region wins.
    if (best && ring > 0) return best;
  }
  return best;
}

// ===========================================================================
// VILLAGE
// ===========================================================================
const VILLAGE_STYLES = {
  plains: {
    wall: 'oak_planks', log: 'oak_log', stairs: 'oak_stairs', slab: 'oak_slab',
    door: 'oak_door', glass: 'glass_pane', floor: 'oak_planks', base: 'cobblestone',
    fence: 'oak_fence', path: 'dirt_path', light: 'torch', bed: 'red',
    flatRoof: false, crop: 'wheat',
  },
  desert: {
    wall: 'sandstone', log: 'cut_sandstone', stairs: 'sandstone_stairs', slab: 'sandstone_slab',
    door: 'acacia_door', glass: 'glass_pane', floor: 'smooth_sandstone', base: 'sandstone',
    fence: 'acacia_fence', path: 'dirt_path', light: 'torch', bed: 'orange',
    flatRoof: true, crop: 'wheat',
  },
  savanna: {
    wall: 'acacia_planks', log: 'acacia_log', stairs: 'acacia_stairs', slab: 'acacia_slab',
    door: 'acacia_door', glass: 'glass_pane', floor: 'acacia_planks', base: 'cobblestone',
    fence: 'acacia_fence', path: 'dirt_path', light: 'torch', bed: 'orange',
    flatRoof: true, crop: 'beetroots',
  },
  taiga: {
    wall: 'spruce_planks', log: 'spruce_log', stairs: 'spruce_stairs', slab: 'spruce_slab',
    door: 'spruce_door', glass: 'glass_pane', floor: 'spruce_planks', base: 'cobblestone',
    fence: 'spruce_fence', path: 'dirt_path', light: 'torch', bed: 'white',
    flatRoof: false, crop: 'potatoes',
  },
  snowy: {
    wall: 'spruce_planks', log: 'spruce_log', stairs: 'spruce_stairs', slab: 'spruce_slab',
    door: 'spruce_door', glass: 'glass_pane', floor: 'spruce_planks', base: 'cobblestone',
    fence: 'spruce_fence', path: 'dirt_path', light: 'torch', bed: 'light_blue',
    flatRoof: false, crop: 'carrots',
  },
};

const VILLAGE_BIOME_STYLE = {
  desert: 'desert', badlands: 'desert', eroded_badlands: 'desert', wooded_badlands: 'desert',
  savanna: 'savanna', savanna_plateau: 'savanna', windswept_savanna: 'savanna',
  taiga: 'taiga', old_growth_pine_taiga: 'taiga', old_growth_spruce_taiga: 'taiga',
  snowy_plains: 'snowy', snowy_taiga: 'snowy', ice_spikes: 'snowy', grove: 'snowy',
};

const VILLAGE_BIOMES = [
  'plains', 'sunflower_plains', 'meadow', 'forest', 'flower_forest', 'birch_forest',
  'desert', 'savanna', 'savanna_plateau', 'taiga', 'old_growth_pine_taiga',
  'old_growth_spruce_taiga', 'snowy_plains', 'snowy_taiga', 'grove',
];

const HOUSE_VARIANTS = [
  { kind: 'home', prof: 'farmer', loot: 'village_house', w: 7, d: 6, h: 3 },
  { kind: 'home', prof: 'shepherd', loot: 'village_house', w: 6, d: 6, h: 3 },
  { kind: 'smith', prof: 'weaponsmith', loot: 'village_weaponsmith', w: 8, d: 7, h: 4 },
  { kind: 'butcher', prof: 'butcher', loot: 'village_house', w: 7, d: 7, h: 3 },
  { kind: 'library', prof: 'librarian', loot: 'village_house', w: 8, d: 6, h: 4 },
  { kind: 'temple', prof: 'cleric', loot: 'village_temple', w: 6, d: 7, h: 4 },
  { kind: 'home', prof: 'fisherman', loot: 'village_house', w: 6, d: 7, h: 3 },
  { kind: 'smith', prof: 'toolsmith', loot: 'village_weaponsmith', w: 7, d: 7, h: 3 },
  { kind: 'home', prof: 'cartographer', loot: 'village_house', w: 7, d: 5, h: 3 },
  { kind: 'butcher', prof: 'leatherworker', loot: 'village_house', w: 6, d: 6, h: 3 },
  { kind: 'library', prof: 'mason', loot: 'village_house', w: 7, d: 6, h: 3 },
  { kind: 'home', prof: 'fletcher', loot: 'village_house', w: 6, d: 5, h: 3 },
];

/** World origin so that local (u, v) of a rotated piece lands on (x, z). */
function anchor(x, z, rot, u, v) {
  return [x - u * UX[rot] - v * VX[rot], z - u * UZ[rot] - v * VZ[rot]];
}
/** Rotation whose local +u points along horizontal facing d. */
const rotForDir = (d) => (d + 3) & 3;

// ---- well -----------------------------------------------------------------
PIECES.village_well = (b) => {
  const m = VILLAGE_STYLES[b.o.style] || VILLAGE_STYLES.plains;
  const stone = bid('cobblestone'), mossy = bid('mossy_cobblestone');
  const water = bid('water'), slab = bid('cobblestone_slab');
  b.clearAbove(-3, -3, 3, 3, 6);
  b.foundation(-3, -3, 3, 3, stone, 0, 10);
  // Paved apron.
  b.fillMix(-3, -1, -3, 3, -1, 3, [[stone, 0, 6], [mossy, 0, 2], [bid(m.path), 0, 3]]);
  // Well shaft.
  b.fill(-1, -1, -1, 1, -1, 1, water, 0);
  b.fill(-1, -2, -1, 1, -2, 1, water, 0);
  b.fill(-1, -3, -1, 1, -3, 1, stone, 0);
  // Rim and corner posts.
  b.fillMix(-2, 0, -2, 2, 0, 2, [[stone, 0, 5], [mossy, 0, 2]]);
  b.fill(-1, 0, -1, 1, 0, 1, water, 0);
  for (const [u, v] of [[-2, -2], [2, -2], [-2, 2], [2, 2]]) b.fill(u, 1, v, u, 3, v, stone, 0);
  b.fill(-2, 4, -2, 2, 4, 2, slab, 0);
  // Village bell on a short post beside the well.
  b.fill(4, 0, 0, 4, 1, 0, bid(m.log), 0);
  b.set(4, 2, 0, bid('bell'), 0);
  b.torch(-2, 4, -2, 0);
  if (b.primary) {
    b.mob(0, 1, 4, 'iron_golem');
    b.mob(-4, 1, 0, 'cat');
  }
};

// ---- roads ----------------------------------------------------------------
PIECES.village_road = (b) => {
  const path = bid(b.o.path), base = bid(b.o.base), len = b.o.len;
  for (let u = 0; u < len; u++) {
    for (let v = -1; v <= 1; v++) {
      const x = b.wx(u, v); if (x < b.minX || x > b.maxX) continue;
      const z = b.wz(u, v); if (z < b.minZ || z > b.maxZ) continue;
      const g = clamp(surfaceY(b.world, x, z), b.oy - 4, b.oy + 4);
      if (g - 1 > 0) b.world.setBlock(x, g - 1, z, path, 0, b.flags);
      for (let k = 0; k < 3; k++) b.world.setBlock(x, g + k, z, AIR, 0, b.flags);
      for (let y = g - 2; y > g - 5 && y > 0; y--) {
        if (b.world.getBlock(x, y, z) === 0) b.world.setBlock(x, y, z, base, 0, b.flags);
      }
    }
  }
};

// ---- lamp post ------------------------------------------------------------
PIECES.village_lamp = (b) => {
  const m = VILLAGE_STYLES[b.o.style] || VILLAGE_STYLES.plains;
  const g = b.ground(0, 0);
  b.fill(0, g, 0, 0, g + 2, 0, bid(m.fence), 0);
  b.set(0, g + 3, 0, bid('glowstone'), 0);
  b.set(0, g + 4, 0, bid(m.slab), 1);
};

// ---- farm -----------------------------------------------------------------
PIECES.village_farm = (b) => {
  const m = VILLAGE_STYLES[b.o.style] || VILLAGE_STYLES.plains;
  const w = b.o.w, d = b.o.d;
  const fence = bid(m.fence), farm = bid('farmland'), water = bid('water');
  const crop = bid(m.crop), dirt = bid('dirt');
  b.clearAbove(-1, -1, w, d, 4);
  b.foundation(-1, -1, w, d, dirt, 0, 8);
  b.fill(-1, -1, -1, w, -1, d, dirt, 0);
  b.fill(-1, 0, -1, w, 0, d, AIR, 0);
  // Fence ring with a gap in the middle of the near side.
  b.fill(-1, 0, -1, w, 0, -1, fence, 0);
  b.fill(-1, 0, d, w, 0, d, fence, 0);
  b.fill(-1, 0, -1, -1, 0, d, fence, 0);
  b.fill(w, 0, -1, w, 0, d, fence, 0);
  b.set((w >> 1), 0, -1, AIR, 0);
  // Alternating crop beds with an irrigation channel every third row.
  for (let v = 0; v < d; v++) {
    if (v % 3 === 1) {
      b.fill(0, -1, v, w - 1, -1, v, water, 0);
      continue;
    }
    for (let u = 0; u < w; u++) {
      b.set(u, -1, v, farm, 7);
      const r = b.prand(u, 0, v);
      if (r < 0.85) b.set(u, 0, v, crop, Math.min(7, Math.floor(r * 9)));
    }
  }
  b.set(w - 1, 0, d - 1, bid('composter'), 0);
  if (b.primary) b.mob(1, 1, 1, 'villager', { profession: 'farmer' });
};

// ---- house ----------------------------------------------------------------
PIECES.village_house = (b) => {
  const o = b.o, m = VILLAGE_STYLES[o.style] || VILLAGE_STYLES.plains;
  const w = o.w, d = o.d, h = o.h;
  const wall = bid(m.wall), log = bid(m.log), floor = bid(m.floor);
  const base = bid(m.base), glass = bid(m.glass), slabId = bid(m.slab);
  const stairsId = bid(m.stairs);

  b.clearAbove(-1, -1, w, d, h + 6);
  b.foundation(0, 0, w - 1, d - 1, base, 0, 12);

  b.fill(0, -1, 0, w - 1, -1, d - 1, base, 0);
  b.fill(0, 0, 0, w - 1, 0, d - 1, floor, 0);
  b.walls(0, 1, 0, w - 1, h, d - 1, wall, 0);
  b.fill(1, 1, 1, w - 2, h, d - 2, AIR, 0);
  // Corner posts.
  for (const [u, v] of [[0, 0], [w - 1, 0], [0, d - 1], [w - 1, d - 1]]) b.fill(u, 1, v, u, h, v, log, 0);

  // Windows: every other column on the long walls, plus one each side.
  for (let u = 2; u < w - 2; u += 2) {
    b.set(u, 2, 0, glass, 0);
    b.set(u, 2, d - 1, glass, 0);
  }
  for (let v = 2; v < d - 2; v += 2) {
    b.set(0, 2, v, glass, 0);
    b.set(w - 1, 2, v, glass, 0);
  }

  // Door in the middle of the front (local north) wall, with a step outside.
  const du = w >> 1;
  b.door(du, 1, 0, 0, m.door);
  b.set(du, 0, -1, bid(m.path), 0);
  b.torch(du - 1, 3, 0, 0);
  b.torch(du + 1, 3, 0, 0);

  // Roof.
  if (m.flatRoof) {
    b.fill(-1, h + 1, -1, w, h + 1, d, wall, 0);
    b.fill(-1, h + 2, -1, w, h + 2, -1, slabId, 0);
    b.fill(-1, h + 2, d, w, h + 2, d, slabId, 0);
    b.fill(-1, h + 2, -1, -1, h + 2, d, slabId, 0);
    b.fill(w, h + 2, -1, w, h + 2, d, slabId, 0);
    b.set(1, h + 2, 1, bid(m.light === 'torch' ? 'torch' : m.light), 0);
  } else {
    const half = Math.floor((d + 2) / 2);
    for (let k = 0; k < half; k++) {
      const y = h + 1 + k, a = -1 + k, c = d - k;
      if (a > c) break;
      if (a === c) { b.fill(-1, y, a, w, y, a, slabId, 0); break; }
      b.fill(-1, y, a, w, y, a, stairsId, b.hf(0));
      b.fill(-1, y, c, w, y, c, stairsId, b.hf(2));
      if (c - a === 1) break;
      // Gable ends close the attic; the middle stays hollow.
      b.fill(0, y, a + 1, 0, y, c - 1, wall, 0);
      b.fill(w - 1, y, a + 1, w - 1, y, c - 1, wall, 0);
      if (c - a === 2) b.fill(1, y, a + 1, w - 2, y, a + 1, slabId, 0);
    }
  }

  // Interior fit-out.
  const light = bid(m.light === 'torch' ? 'torch' : m.light);
  b.set(1, 1, 1, light, 0);
  switch (o.kind) {
    case 'smith':
      b.set(1, 1, d - 2, bid('furnace'), b.hf(2));
      b.set(2, 1, d - 2, bid('furnace'), b.hf(2));
      b.set(3, 1, d - 2, bid('smithing_table'), 0);
      b.set(w - 2, 1, d - 2, bid('anvil'), b.hf(1));
      b.set(w - 2, 1, 1, bid('grindstone'), b.hf(3));
      b.chest(w - 3, 1, d - 2, 0, o.loot);
      b.set(w - 2, 1, 2, bid('cauldron'), 0);
      break;
    case 'butcher':
      b.set(1, 1, d - 2, bid('smoker'), b.hf(2));
      b.set(2, 1, d - 2, bid('crafting_table'), 0);
      b.set(w - 2, 1, d - 2, bid('cauldron'), 0);
      b.chest(w - 2, 1, 1, 0, o.loot);
      b.bed(1, 1, 2, 2, m.bed);
      break;
    case 'library':
      b.fill(1, 1, d - 2, w - 2, 2, d - 2, bid('bookshelf'), 0);
      b.set(w >> 1, 1, d - 2, bid('lectern'), b.hf(0));
      b.set(1, 1, 1, bid('crafting_table'), 0);
      b.chest(w - 2, 1, 1, 0, o.loot);
      b.bed(w - 2, 1, d - 3, 0, m.bed);
      break;
    case 'temple':
      b.set(w >> 1, 1, d - 2, bid('brewing_stand'), 0);
      b.set((w >> 1) - 1, 1, d - 2, bid('cauldron'), 0);
      b.fill(1, 1, d - 3, 1, 1, d - 2, bid(m.slab), 1);
      b.chest(w - 2, 1, 1, 0, o.loot);
      b.set(1, 1, 1, bid('glowstone'), 0);
      break;
    default:
      b.bed(1, 1, d - 3, 2, m.bed);
      b.set(w - 2, 1, d - 2, bid('crafting_table'), 0);
      b.chest(w - 2, 1, 1, 0, o.loot);
      b.set(w - 3, 1, d - 2, bid('furnace'), b.hf(2));
      b.set(2, 1, 1, bid('flower_pot'), 0);
      break;
  }

  if (b.primary) {
    b.mob(du, 1, 2, 'villager', { profession: o.prof });
    if (b.rng.chance(0.4)) b.mob(du - 1, 1, 2, 'villager', { profession: 'nitwit' });
  }
};

registerStructure('village', {
  spacing: 32, separation: 8, salt: 0x0be7, dimension: DIM_OVERWORLD, biomes: VILLAGE_BIOMES,
  generate(world, cx, cz, rng) {
    const bx = (cx << 4) + 8, bz = (cz << 4) + 8;
    const biome = biomeNameAt(world, bx, bz);
    const style = VILLAGE_BIOME_STYLE[biome] || 'plains';
    const m = VILLAGE_STYLES[style];
    const g = surveyGround(world, bx - 26, bz - 26, bx + 26, bz + 26, 4);
    if (g.spread > 16 || g.avg <= SEA_LEVEL) return;      // too steep or drowned
    const y = g.avg;
    const out = [];
    out.push(piece('village_well', bx, y, bz, 0, -4, -4, 4, 4, { style }));

    const dirs = rng.shuffle([0, 1, 2, 3]).slice(0, rng.range(3, 4));
    const slots = [];
    for (const dir of dirs) {
      const len = rng.range(16, 28);
      const rot = rotForDir(dir);
      const [ax, az] = anchor(bx + HDX[dir] * 3, bz + HDZ[dir] * 3, rot, 0, 0);
      for (let s = 0; s < len; s += 8) {
        const seg = Math.min(8, len - s);
        const sx = ax + HDX[dir] * s, sz = az + HDZ[dir] * s;
        out.push(piece('village_road', sx, y, sz, rot, 0, -1, seg - 1, 1,
          { len: seg, path: m.path, base: m.base }));
      }
      // Building plots hang off both sides of the arm.
      for (let s = 6; s < len - 2; s += 7) {
        for (const side of [(dir + 1) & 3, (dir + 3) & 3]) {
          if (rng.chance(0.28)) continue;
          slots.push({ dir, side, dist: s + rng.int(3) });
        }
      }
      if (rng.chance(0.6)) {
        const lx = bx + HDX[dir] * (len - 2) + HDX[(dir + 1) & 3] * 2;
        const lz = bz + HDZ[dir] * (len - 2) + HDZ[(dir + 1) & 3] * 2;
        out.push(piece('village_lamp', lx, y, lz, 0, 0, 0, 0, 0, { style }));
      }
    }

    rng.shuffle(slots);
    const want = rng.range(8, 12);
    const variants = rng.shuffle(HOUSE_VARIANTS.slice());
    let placed = 0, farms = 0;
    const taken = [];
    for (const s of slots) {
      if (placed >= want) break;
      const v = variants[placed % variants.length];
      const makeFarm = farms < 2 && placed >= 3 && rng.chance(0.34);
      const wid = makeFarm ? 7 : v.w, dep = makeFarm ? 6 : v.d;
      // Front centre of the plot, three blocks off the road edge.
      const fx = bx + HDX[s.dir] * s.dist + HDX[s.side] * 3;
      const fz = bz + HDZ[s.dir] * s.dist + HDZ[s.side] * 3;
      let clash = false;
      for (const t of taken) if (Math.abs(t[0] - fx) < wid + 2 && Math.abs(t[1] - fz) < dep + 2) clash = true;
      if (clash) continue;
      const gg = surveyGround(world, fx - wid, fz - dep, fx + wid, fz + dep, 2);
      if (gg.spread > 8) continue;
      taken.push([fx, fz]);
      const rot = (s.side + 2) & 3;
      const [ox, oz] = anchor(fx, fz, rot, wid >> 1, 0);
      if (makeFarm) {
        out.push(piece('village_farm', ox, gg.avg, oz, rot, -2, -2, wid + 1, dep + 1,
          { style, w: wid, d: dep }));
        farms++;
      } else {
        out.push(piece('village_house', ox, gg.avg, oz, rot, -2, -2, wid + 1, dep + 3,
          { style, w: v.w, d: v.d, h: v.h, kind: v.kind, prof: v.prof, loot: v.loot }));
      }
      placed++;
    }
    emitPieces(world, out);
  },
});

// ===========================================================================
// DESERT PYRAMID
// ===========================================================================
PIECES.desert_pyramid = (b) => {
  const sand = bid('sandstone'), cut = bid('cut_sandstone'), chis = bid('chiseled_sandstone');
  const orange = bid('orange_terracotta'), blue = bid('blue_terracotta');
  const slab = bid('sandstone_slab'), stairs = bid('sandstone_stairs');

  b.clearAbove(-11, -11, 11, 11, 14);
  b.foundation(-10, -10, 10, 10, sand, 0, 14);

  // Stepped body.
  for (let k = 0; k <= 9; k++) {
    const r = 10 - k;
    b.fill(-r, k, -r, r, k, r, sand, 0);
    if (k > 0 && k < 9) b.fill(-r + 1, k, -r + 1, r - 1, k, r - 1, k % 2 ? cut : sand, 0);
  }
  // Hollow the main chamber under the cap.
  b.fill(-5, 1, -5, 5, 4, 5, AIR, 0);
  b.fill(-5, 0, -5, 5, 0, 5, cut, 0);
  b.fill(-5, 5, -5, 5, 5, 5, sand, 0);
  // Entrance corridor through the north face.
  b.fill(-1, 1, -10, 1, 3, -5, AIR, 0);
  b.fill(-1, 0, -10, 1, 0, -5, cut, 0);
  b.stair(0, 4, -10, 'sandstone_stairs', 2, true);
  // Twin front towers with the classic orange/blue banding.
  for (const u of [-8, 8]) {
    b.fill(u - 1, 0, -10, u + 1, 6, -8, sand, 0);
    b.fill(u, 1, -9, u, 5, -9, AIR, 0);
    b.fill(u - 1, 7, -10, u + 1, 7, -8, orange, 0);
    b.fill(u - 1, 8, -10, u + 1, 8, -8, sand, 0);
    b.set(u, 9, -9, chis, 0);
    b.fill(u - 1, 9, -10, u - 1, 9, -8, slab, 0);
    b.fill(u + 1, 9, -10, u + 1, 9, -8, slab, 0);
  }
  // Front face motif.
  for (const u of [-4, 4]) {
    b.fill(u - 1, 2, -10, u + 1, 2, -10, orange, 0);
    b.set(u, 3, -10, blue, 0);
    b.fill(u - 1, 4, -10, u + 1, 4, -10, orange, 0);
  }
  b.set(0, 5, -10, chis, 0);
  b.fill(-10, 0, -10, -10, 0, 10, cut, 0);
  b.fill(10, 0, -10, 10, 0, 10, cut, 0);
  // The tell-tale blue tile in the floor, right above the treasure room.
  b.fill(-1, 0, -1, 1, 0, 1, blue, 0);
  b.set(0, 0, 0, orange, 0);
  b.standTorch(-4, 1, -4);
  b.standTorch(4, 1, -4);
  b.standTorch(-4, 1, 4);
  b.standTorch(4, 1, 4);
  b.set(0, 4, 0, stairs, 0);

  // ---- hidden treasure room --------------------------------------------
  const fy = -9;
  b.fill(-5, fy - 3, -5, 5, fy + 5, 5, sand, 0);
  b.fill(-4, fy + 1, -4, 4, fy + 4, 4, AIR, 0);
  b.fill(-4, fy, -4, 4, fy, 4, cut, 0);
  b.fillMix(-4, fy, -4, 4, fy, 4, [[cut, 0, 6], [orange, 0, 2], [blue, 0, 1]]);
  b.fill(-4, fy + 5, -4, 4, fy + 5, 4, sand, 0);
  // Shaft up to the marked floor tile so the room is reachable by digging.
  b.fill(0, fy + 5, 0, 0, -1, 0, sand, 0);
  // The trap: nine TNT under a stone pressure plate in a pit.
  b.fill(-1, fy - 1, -1, 1, fy - 1, 1, bid('tnt'), 0);
  b.fill(-1, fy, -1, 1, fy, 1, cut, 0);
  b.set(0, fy, 0, bid('stone_pressure_plate'), 0);
  b.fill(-1, fy + 1, -1, 1, fy + 1, 1, AIR, 0);
  // Four chests around the plate, each looking inward.
  b.chest(-2, fy + 1, 0, 1, 'desert_pyramid');
  b.chest(2, fy + 1, 0, 3, 'desert_pyramid');
  b.chest(0, fy + 1, -2, 2, 'desert_pyramid');
  b.chest(0, fy + 1, 2, 0, 'desert_pyramid');
  b.set(-4, fy + 1, -4, bid('chiseled_sandstone'), 0);
};

registerStructure('desert_pyramid', {
  spacing: 32, separation: 8, salt: 0x14ce, dimension: DIM_OVERWORLD,
  biomes: ['desert'],
  generate(world, cx, cz) {
    const bx = (cx << 4) + 8, bz = (cz << 4) + 8;
    const g = surveyGround(world, bx - 10, bz - 10, bx + 10, bz + 10, 3);
    if (g.spread > 10) return;
    emitPieces(world, [piece('desert_pyramid', bx, g.avg, bz, 0, -11, -11, 11, 11)]);
  },
});

// ===========================================================================
// JUNGLE TEMPLE
// ===========================================================================
PIECES.jungle_temple = (b) => {
  const cob = bid('cobblestone'), moss = bid('mossy_cobblestone');
  const MIX = [[cob, 0, 5], [moss, 0, 5]];
  const stairs = bid('cobblestone_stairs'), vine = bid('vine');

  b.clearAbove(-1, -1, 12, 16, 14);
  b.foundation(0, 0, 11, 15, cob, 0, 14);

  // Shell.
  b.fillMix(0, -1, 0, 11, -1, 15, MIX);
  b.fillMix(0, 0, 0, 11, 8, 15, MIX);
  b.fill(1, 0, 1, 10, 3, 14, AIR, 0);
  b.fillMix(1, 4, 1, 10, 4, 14, MIX);
  b.fill(1, 5, 1, 10, 7, 14, AIR, 0);
  b.fillMix(1, 8, 1, 10, 8, 14, MIX);
  // Ground-floor doorway and windows.
  b.fill(4, 1, 0, 7, 3, 0, AIR, 0);
  b.fill(4, 1, -1, 7, 3, -1, AIR, 0);
  for (const v of [4, 8, 12]) {
    b.fill(0, 2, v, 0, 3, v, AIR, 0);
    b.fill(11, 2, v, 11, 3, v, AIR, 0);
  }
  // Roof crenellations + creeper of vines.
  for (let u = 0; u <= 11; u += 2) {
    b.set(u, 9, 0, moss, 0);
    b.set(u, 9, 15, moss, 0);
  }
  for (let v = 0; v <= 15; v += 2) {
    b.set(0, 9, v, moss, 0);
    b.set(11, 9, v, moss, 0);
  }
  for (let v = 1; v < 15; v++) {
    if (b.prand(0, 6, v) < 0.4) b.set(-1, 6, v, vine, 1);
    if (b.prand(11, 6, v) < 0.4) b.set(12, 6, v, vine, 4);
  }
  // Staircase to the upper floor.
  for (let k = 0; k < 4; k++) {
    b.stair(9, 1 + k, 3 + k, 'cobblestone_stairs', 2);
    b.fill(9, 5, 3 + k, 9, 5, 3 + k, AIR, 0);
  }
  b.fill(8, 5, 6, 10, 5, 7, AIR, 0);

  // ---- arrow trap corridor: tripwire between two hooks, dispensers behind --
  b.fill(2, 1, 10, 9, 3, 13, AIR, 0);
  b.fill(2, 0, 10, 9, 0, 13, moss, 0);
  b.set(1, 1, 11, bid('dispenser'), b.hf(1));
  b.set(1, 1, 12, bid('dispenser'), b.hf(1));
  b.set(10, 1, 11, bid('dispenser'), b.hf(3));
  for (const dp of [[1, 11], [1, 12], [10, 11]]) {
    const x = b.wx(dp[0], dp[1]), z = b.wz(dp[0], dp[1]), y = b.oy + 1;
    if (x >= b.minX && x <= b.maxX && z >= b.minZ && z <= b.maxZ) {
      const be = b.world.getBlockEntity(x, y, z);
      if (be) {
        const r = new RNG(hash3(b.seed ^ 0xd15, x, y, z));
        const items = new Array(9).fill(null);
        const rolled = rollLoot('jungle_temple_dispenser', r);
        for (let i = 0; i < rolled.length && i < 9; i++) items[i] = rolled[i];
        be.items = items;
      }
    }
  }
  b.set(2, 1, 11, bid('tripwire_hook'), b.hf(3));
  b.fill(3, 1, 11, 8, 1, 11, bid('tripwire'), 0);
  b.set(9, 1, 11, bid('tripwire_hook'), b.hf(1));
  b.fill(2, 0, 11, 9, 0, 11, bid('redstone_wire'), 0);
  b.chest(5, 1, 13, 0, 'jungle_temple');

  // ---- lever puzzle: three levers, a piston door and the prize -------------
  b.fill(2, 1, 2, 5, 3, 5, AIR, 0);
  b.fill(1, 1, 2, 1, 1, 4, bid('mossy_cobblestone'), 0);
  for (let k = 0; k < 3; k++) b.set(1, 2, 2 + k, bid('lever'), b.hf(1));
  b.fill(2, 0, 2, 5, 0, 5, cob, 0);
  b.fill(2, 1, 5, 4, 1, 5, bid('redstone_wire'), 0);
  b.set(5, 1, 5, bid('sticky_piston'), 1);
  b.set(5, 2, 5, bid('mossy_cobblestone'), 0);
  b.chest(4, 1, 2, 2, 'jungle_temple');
  b.set(2, 1, 4, bid('redstone_torch'), 0);

  // Upper floor: an altar and a view over the canopy.
  b.fill(2, 5, 2, 9, 7, 13, AIR, 0);
  b.fill(4, 5, 6, 7, 5, 9, moss, 0);
  b.set(5, 6, 7, bid('chiseled_stone_bricks'), 0);
  b.set(6, 6, 8, bid('chiseled_stone_bricks'), 0);
  b.standTorch(5, 7, 7);
  b.stair(3, 5, 5, 'mossy_cobblestone_stairs', 0);
  b.stair(8, 5, 10, 'mossy_cobblestone_stairs', 2);
  b.set(2, 6, 2, stairs, b.hf(0));
};

registerStructure('jungle_temple', {
  spacing: 32, separation: 8, salt: 0x51a2, dimension: DIM_OVERWORLD,
  biomes: ['jungle', 'sparse_jungle', 'bamboo_jungle'],
  generate(world, cx, cz) {
    const bx = (cx << 4) + 4, bz = (cz << 4) + 4;
    const g = surveyGround(world, bx, bz, bx + 11, bz + 15, 3);
    if (g.spread > 9) return;
    emitPieces(world, [piece('jungle_temple', bx, g.avg, bz, 0, -1, -1, 12, 16)]);
  },
});

// ===========================================================================
// WITCH HUT
// ===========================================================================
PIECES.witch_hut = (b) => {
  const plank = bid('spruce_planks'), log = bid('spruce_log'), slab = bid('spruce_slab');
  const stairs = bid('spruce_stairs'), fence = bid('spruce_fence');
  b.clearAbove(-1, -1, 7, 9, 9);
  // Stilts down into the swamp.
  for (const [u, v] of [[1, 1], [5, 1], [1, 7], [5, 7], [3, 1], [3, 7]]) {
    for (let y = -1; y >= -8; y--) {
      const x = b.wx(u, v), z = b.wz(u, v);
      if (x < b.minX || x > b.maxX || z < b.minZ || z > b.maxZ) break;
      if (b.oy + y < 1) break;
      b.world.setBlock(x, b.oy + y, z, log, 0, b.flags);
      if (b.oy + y <= surfaceY(b.world, x, z) - 1) break;
    }
  }
  b.fill(0, 0, 0, 6, 0, 8, plank, 0);
  b.walls(0, 1, 0, 6, 3, 8, plank, 0);
  b.fill(1, 1, 1, 5, 3, 7, AIR, 0);
  for (const [u, v] of [[0, 0], [6, 0], [0, 8], [6, 8]]) b.fill(u, 1, v, u, 3, v, log, 0);
  // Open porch side and a railing.
  b.fill(2, 1, 0, 4, 2, 0, AIR, 0);
  b.set(2, 1, 0, fence, 0);
  b.set(4, 1, 0, fence, 0);
  // Windows.
  b.set(0, 2, 4, AIR, 0);
  b.set(6, 2, 4, AIR, 0);
  // Roof.
  b.fill(-1, 4, -1, 7, 4, 9, plank, 0);
  b.fill(-1, 5, -1, 7, 5, -1, stairs, b.hf(0));
  b.fill(-1, 5, 9, 7, 5, 9, stairs, b.hf(2));
  b.fill(-1, 5, 0, -1, 5, 8, stairs, b.hf(3));
  b.fill(7, 5, 0, 7, 5, 8, stairs, b.hf(1));
  b.fill(0, 5, 0, 6, 5, 8, slab, 0);
  // Furniture.
  b.set(1, 1, 6, bid('cauldron'), 0);
  b.set(5, 1, 6, bid('crafting_table'), 0);
  b.set(3, 1, 7, bid('flower_pot'), 0);
  b.set(1, 1, 1, bid('spruce_fence'), 0);
  b.set(1, 2, 1, bid('red_mushroom'), 0);
  b.chest(5, 1, 1, 3, 'witch_hut');
  b.torch(3, 3, 8, 2);
  if (b.primary) {
    b.mob(3, 1, 4, 'witch');
    b.mob(2, 1, 5, 'cat', { variant: 'black' });
  }
};

registerStructure('witch_hut', {
  spacing: 32, separation: 8, salt: 0x7a1c, dimension: DIM_OVERWORLD,
  biomes: ['swamp', 'mangrove_swamp'],
  generate(world, cx, cz) {
    const bx = (cx << 4) + 4, bz = (cz << 4) + 4;
    const y = Math.max(SEA_LEVEL + 2, surveyGround(world, bx, bz, bx + 6, bz + 8, 2).avg + 1);
    emitPieces(world, [piece('witch_hut', bx, y, bz, 0, -1, -1, 7, 9)]);
  },
});

// ===========================================================================
// IGLOO
// ===========================================================================
PIECES.igloo = (b) => {
  const snow = bid('snow_block'), ice = bid('ice'), pane = bid('light_blue_stained_glass_pane');
  b.clearAbove(-5, -5, 5, 5, 7);
  b.foundation(-4, -4, 4, 4, snow, 0, 8);
  // Dome: a discrete hemisphere of snow with a hollow interior.
  for (let y = 0; y <= 4; y++) {
    for (let v = -4; v <= 4; v++) {
      for (let u = -4; u <= 4; u++) {
        const d = Math.sqrt(u * u + v * v + y * y * 1.35);
        if (d > 4.35) continue;
        b.set(u, y, v, d > 3.3 ? snow : AIR, 0);
      }
    }
  }
  b.fill(-3, -1, -3, 3, -1, 3, snow, 0);
  b.fill(-2, 0, -2, 2, 0, 2, bid('white_carpet'), 0);
  b.set(0, 3, 0, ice, 0);
  b.set(2, 2, -2, pane, 0);
  // Entrance tunnel to the south.
  b.fill(0, 0, 4, 0, 1, 6, AIR, 0);
  b.fill(-1, 0, 4, -1, 2, 6, snow, 0);
  b.fill(1, 0, 4, 1, 2, 6, snow, 0);
  b.fill(-1, 2, 4, 1, 2, 6, snow, 0);
  b.fill(-1, -1, 4, 1, -1, 6, snow, 0);
  // Furniture.
  b.bed(-2, 1, -1, 2, 'red');
  b.set(2, 1, 1, bid('furnace'), b.hf(3));
  b.set(2, 1, 2, bid('crafting_table'), 0);
  b.set(-2, 1, 2, bid('redstone_torch'), 0);
  b.set(0, 1, -3, bid('white_carpet'), 0);

  if (b.o.basement) {
    const fy = -8;
    // Trapdoor + ladder shaft hidden beneath the carpet.
    b.set(1, 0, 2, bid('spruce_trapdoor'), 4);
    b.fill(1, fy + 1, 2, 1, -1, 2, AIR, 0);
    for (let y = fy + 1; y <= -1; y++) b.set(1, y, 3, bid('ladder'), b.hf(0));
    // Laboratory.
    b.fill(-4, fy - 1, -4, 4, fy + 5, 4, bid('stone_bricks'), 0);
    b.fill(-3, fy + 1, -3, 3, fy + 3, 3, AIR, 0);
    b.fillMix(-3, fy, -3, 3, fy, 3, [[bid('stone_bricks'), 0, 6], [bid('mossy_stone_bricks'), 0, 2],
      [bid('cracked_stone_bricks'), 0, 2]]);
    b.fill(1, fy + 1, 2, 1, fy + 3, 3, AIR, 0);
    b.set(-2, fy + 1, -2, bid('brewing_stand'), 0);
    b.set(-1, fy + 1, -2, bid('cauldron'), 0);
    b.chest(0, fy + 1, -2, 2, 'igloo_chest');
    b.standTorch(3, fy + 1, 3);
    b.standTorch(-3, fy + 1, 3);
    // Two cells, one villager and one zombie villager, split by iron bars.
    b.fill(-3, fy + 1, 1, -1, fy + 3, 3, bid('stone_bricks'), 0);
    b.fill(-3, fy + 1, 2, -1, fy + 2, 3, AIR, 0);
    b.fill(-3, fy + 1, 1, -1, fy + 2, 1, bid('iron_bars'), 0);
    b.set(-2, fy + 1, 1, bid('iron_bars'), 0);
    b.set(-2, fy, 2, bid('red_carpet'), 0);
    b.fill(2, fy + 1, 1, 3, fy + 3, 3, bid('stone_bricks'), 0);
    b.fill(2, fy + 1, 2, 3, fy + 2, 3, AIR, 0);
    b.fill(2, fy + 1, 1, 3, fy + 2, 1, bid('iron_bars'), 0);
    if (b.primary) {
      b.mob(-2, fy + 1, 2, 'zombie_villager');
      b.mob(2, fy + 1, 2, 'villager', { profession: 'cleric' });
    }
  }
};

registerStructure('igloo', {
  spacing: 28, separation: 8, salt: 0x19100, dimension: DIM_OVERWORLD,
  biomes: ['snowy_plains', 'snowy_taiga', 'snowy_slopes', 'grove', 'ice_spikes'],
  generate(world, cx, cz, rng) {
    const bx = (cx << 4) + 8, bz = (cz << 4) + 8;
    const g = surveyGround(world, bx - 5, bz - 5, bx + 5, bz + 6, 2);
    if (g.spread > 5 || g.avg <= SEA_LEVEL) return;
    emitPieces(world, [piece('igloo', bx, g.avg, bz, rng.int(4), -5, -5, 5, 7,
      { basement: rng.chance(0.5) })]);
  },
});

// ===========================================================================
// PILLAGER OUTPOST
// ===========================================================================
PIECES.pillager_outpost = (b) => {
  const log = bid('dark_oak_log'), plank = bid('dark_oak_planks');
  const fence = bid('dark_oak_fence'), stairs = bid('dark_oak_stairs'), slab = bid('dark_oak_slab');
  b.clearAbove(-4, -4, 4, 4, 18);
  b.foundation(-3, -3, 3, 3, bid('cobblestone'), 0, 14);
  b.fill(-3, -1, -3, 3, -1, 3, bid('cobblestone'), 0);

  // Four corner columns rising the full height of the tower.
  for (const [u, v] of [[-3, -3], [3, -3], [-3, 3], [3, 3]]) b.fill(u, 0, v, u, 12, v, log, 0);
  // Three enclosed floors.
  for (let f = 0; f < 3; f++) {
    const y = f * 4;
    b.fill(-3, y, -3, 3, y, 3, plank, 0);
    b.walls(-3, y + 1, -3, 3, y + 3, 3, plank, 0);
    b.fill(-2, y + 1, -2, 2, y + 3, 2, AIR, 0);
    // Arrow slits.
    b.set(0, y + 2, -3, AIR, 0);
    b.set(0, y + 2, 3, AIR, 0);
    b.set(-3, y + 2, 0, AIR, 0);
    b.set(3, y + 2, 0, AIR, 0);
    b.set(2, y + 1, 2, AIR, 0);              // ladder shaft
    b.set(2, y + 2, 2, AIR, 0);
    b.set(2, y + 3, 2, AIR, 0);
    b.set(2, y + 4, 2, AIR, 0);
    for (let k = 1; k <= 4; k++) b.set(2, y + k, 2, bid('ladder'), b.hf(0));
    b.torch(-2, y + 3, -2, 0);
  }
  // Ground floor entrance.
  b.fill(0, 1, -3, 0, 2, -3, AIR, 0);
  // Battlement and overhanging roof.
  b.fill(-4, 12, -4, 4, 12, 4, plank, 0);
  b.fill(-4, 13, -4, 4, 13, -4, fence, 0);
  b.fill(-4, 13, 4, 4, 13, 4, fence, 0);
  b.fill(-4, 13, -4, -4, 13, 4, fence, 0);
  b.fill(4, 13, -4, 4, 13, 4, fence, 0);
  b.fill(-2, 13, -2, 2, 16, 2, AIR, 0);
  b.fill(-2, 16, -2, 2, 16, 2, plank, 0);
  b.fill(-3, 15, -3, 3, 15, -3, stairs, b.hf(0));
  b.fill(-3, 15, 3, 3, 15, 3, stairs, b.hf(2));
  b.fill(-3, 15, -2, -3, 15, 2, stairs, b.hf(3));
  b.fill(3, 15, -2, 3, 15, 2, stairs, b.hf(1));
  b.fill(-2, 17, -2, 2, 17, 2, slab, 0);
  for (const [u, v] of [[-2, -2], [2, -2], [-2, 2], [2, 2]]) b.fill(u, 13, v, u, 15, v, log, 0);
  b.set(0, 13, 0, bid('white_banner'), 0);

  // Cage beside the tower.
  b.fill(6, 0, 0, 8, 0, 2, plank, 0);
  b.walls(6, 1, 0, 8, 3, 2, fence, 0);
  b.fill(6, 4, 0, 8, 4, 2, fence, 0);
  b.fill(7, 1, 1, 7, 3, 1, AIR, 0);
  // Tent and campfire.
  b.fill(-8, 0, -2, -5, 0, 1, bid('white_wool'), 0);
  b.set(-6, 0, 3, bid('campfire'), 0);
  b.chest(-8, 1, 1, 1, 'pillager_outpost');
  b.chest(1, 1, 1, 0, 'pillager_outpost');

  if (b.primary) {
    b.mob(0, 1, 0, 'pillager');
    b.mob(0, 5, 0, 'pillager');
    b.mob(0, 13, 0, 'pillager');
    b.mob(-6, 1, 0, 'pillager');
    b.mob(7, 1, 1, 'allay');
  }
};

registerStructure('pillager_outpost', {
  spacing: 32, separation: 8, salt: 0x9111, dimension: DIM_OVERWORLD,
  biomes: ['plains', 'sunflower_plains', 'desert', 'savanna', 'savanna_plateau', 'taiga',
    'snowy_plains', 'snowy_taiga', 'meadow', 'grove', 'windswept_hills', 'old_growth_pine_taiga'],
  generate(world, cx, cz, rng) {
    const bx = (cx << 4) + 8, bz = (cz << 4) + 8;
    const g = surveyGround(world, bx - 8, bz - 5, bx + 8, bz + 5, 2);
    if (g.spread > 10 || g.avg <= SEA_LEVEL) return;
    emitPieces(world, [piece('pillager_outpost', bx, g.avg, bz, rng.int(4), -9, -5, 9, 5)]);
  },
});

// ===========================================================================
// DUNGEON (scattered)
// ===========================================================================
const DUNGEON_MOBS = ['zombie', 'skeleton', 'spider'];

PIECES.dungeon = (b) => {
  const r = b.o.r;                       // half width: 2 or 3
  const cob = bid('cobblestone'), moss = bid('mossy_cobblestone');
  const MIX = [[cob, 0, 5], [moss, 0, 4]];
  b.fillMix(-r - 1, -1, -r - 1, r + 1, 4, r + 1, MIX);
  b.fill(-r, 1, -r, r, 3, r, AIR, 0);
  b.fillMix(-r, 0, -r, r, 0, r, MIX);
  b.fillMix(-r - 1, 4, -r - 1, r + 1, 4, r + 1, MIX);
  b.spawner(0, 1, 0, b.o.mob);
  // One or two chests hugging a wall, never in a corner.
  b.chest(-r + 1, 1, -r, 2, 'monster_room');
  if (b.o.two) b.chest(r - 1, 1, r, 0, 'monster_room');
  b.set(-r, 1, r, bid('cobweb'), 0);
  b.set(r, 1, -r, bid('cobweb'), 0);
};

registerStructure('dungeon', {
  spacing: 4, separation: 1, salt: 0xd0e6, dimension: DIM_OVERWORLD,
  scatter: 8, scatterChance: 0.035,
  generate(world, cx, cz, rng, hit) {
    if (!hit) return;
    const x = (cx << 4) + hit[0], z = (cz << 4) + hit[2];
    const y = hit[1];
    const top = surfaceY(world, x, z);
    if (y > top - 8 || y < 5) return;
    // Only carve where there is something to carve into, and let the room
    // touch at least a little open space so it can be found.
    let air = 0, solid = 0;
    for (let dz = -2; dz <= 2; dz++) {
      for (let dx = -2; dx <= 2; dx++) {
        const px = x + dx, pz = z + dz;
        if ((px >> 4) !== cx || (pz >> 4) !== cz) continue;
        if (world.getBlock(px, y + 1, pz) === 0) air++; else solid++;
        if (world.getBlock(px, y - 1, pz) !== 0) solid++;
      }
    }
    if (solid < 8) return;
    if (air > 18) return;
    const r = rng.chance(0.4) ? 3 : 2;
    emitPieces(world, [piece('dungeon', x, y, z, 0, -r - 1, -r - 1, r + 1, r + 1,
      { r, mob: rng.pick(DUNGEON_MOBS), two: rng.chance(0.5) })]);
  },
});

// ===========================================================================
// MINESHAFT
// ===========================================================================
PIECES.mineshaft_corridor = (b) => {
  const plank = bid('oak_planks'), fence = bid('oak_fence'), log = bid('oak_log');
  const len = b.o.len;
  b.fill(0, 0, -1, len - 1, 2, 1, AIR, 0);
  // Floor: plank walkway with the occasional gap over a void.
  for (let u = 0; u < len; u++) {
    for (let v = -1; v <= 1; v++) {
      if (b.prand(u, -1, v) < 0.82) b.set(u, -1, v, plank, 0);
    }
  }
  // Supports every five blocks: two posts and a beam.
  for (let u = 0; u < len; u++) {
    if (u % 5 !== 2) continue;
    b.fill(u, 0, -1, u, 1, -1, fence, 0);
    b.fill(u, 0, 1, u, 1, 1, fence, 0);
    b.beam(u, 2, -1, u, 1, log, 2);
    if (b.prand(u, 3, 0) < 0.35) b.torch(u, 2, -1, 3);
  }
  // Rails down the middle, powered every so often.
  for (let u = 0; u < len; u++) {
    if (b.prand(u, 0, 0) < 0.12) continue;
    b.rail(u, 0, 0, 0, b.prand(u, 1, 0) < 0.1 ? 'powered_rail' : 'rail');
  }
  // Cobwebs and cave-ins.
  for (let u = 0; u < len; u++) {
    for (let v = -1; v <= 1; v++) {
      for (let y = 0; y <= 2; y++) {
        if (b.prand(u, y + 10, v) < 0.035) b.set(u, y, v, bid('cobweb'), 0);
      }
    }
  }
  if (b.o.chest) {
    b.chest(Math.max(1, len - 2), 0, 1, 0, 'abandoned_mineshaft');
    b.rail(Math.max(1, len - 2), 0, 0, 0);
  }
  if (b.o.spider) {
    b.fill(1, 0, -1, 3, 2, 1, bid('cobweb'), 0);
    b.spawner(2, 0, 0, 'cave_spider');
    if (b.primary) b.mob(1, 0, 0, 'cave_spider');
  }
};

PIECES.mineshaft_room = (b) => {
  const plank = bid('oak_planks'), fence = bid('oak_fence');
  b.fill(-3, 0, -3, 3, 3, 3, AIR, 0);
  b.fillMix(-3, -1, -3, 3, -1, 3, [[plank, 0, 6], [bid('dirt'), 0, 2], [AIR, 0, 1]]);
  for (const [u, v] of [[-3, -3], [3, -3], [-3, 3], [3, 3]]) b.fill(u, 0, v, u, 2, v, fence, 0);
  b.fill(-3, 3, -3, 3, 3, 3, plank, 0);
  b.standTorch(-2, 0, -2);
  b.standTorch(2, 0, 2);
  b.chest(0, 0, 2, 0, 'abandoned_mineshaft');
  for (let i = 0; i < 6; i++) {
    const u = -3 + (i * 7919) % 7, v = -3 + (i * 104729) % 7;
    if (b.prand(u, 1, v) < 0.5) b.set(u, 1, v, bid('cobweb'), 0);
  }
};

PIECES.mineshaft_shaft = (b) => {
  // A vertical link between two corridor levels, with a ladder.
  const h = b.o.h;
  b.fill(-1, 0, -1, 1, h, 1, AIR, 0);
  b.fill(-1, -1, -1, 1, -1, 1, bid('oak_planks'), 0);
  for (let y = 0; y <= h; y++) b.set(0, y, 1, bid('ladder'), b.hf(0));
  b.fill(-1, h + 1, -1, 1, h + 1, 1, bid('oak_planks'), 0);
};

registerStructure('mineshaft', {
  spacing: 16, separation: 5, salt: 0x3157, dimension: DIM_OVERWORLD,
  biomes: null,
  generate(world, cx, cz, rng) {
    const bx = (cx << 4) + 8, bz = (cz << 4) + 8;
    const top = surveyGround(world, bx - 8, bz - 8, bx + 8, bz + 8, 4).min;
    const badlands = (biomeNameAt(world, bx, bz) || '').indexOf('badlands') >= 0;
    let y = badlands ? Math.min(top - 6, rng.range(50, 70)) : rng.range(16, 40);
    y = clamp(y, 8, top - 6);
    if (y < 8) return;
    const out = [];
    // Grow a corridor graph from the origin: each open end may push forward,
    // turn, branch or terminate in a room.
    let ends = [{ x: bx, y, z: bz, dir: rng.int(4), depth: 0 }];
    let budget = 44;
    while (ends.length && budget > 0) {
      const e = ends.shift();
      if (e.depth > 7) continue;
      const rot = rotForDir(e.dir);
      const len = rng.range(5, 9);
      const spider = rng.chance(0.11);
      out.push(piece('mineshaft_corridor', e.x, e.y, e.z, rot, 0, -2, len, 2, {
        len, chest: rng.chance(0.22), spider,
      }));
      budget--;
      const nx = e.x + HDX[e.dir] * len, nz = e.z + HDZ[e.dir] * len;
      const roll = rng.next();
      if (roll < 0.18 && budget > 2) {
        out.push(piece('mineshaft_room', nx, e.y, nz, 0, -4, -4, 4, 4));
        budget--;
        for (const d of [0, 1, 2, 3]) {
          if (d === ((e.dir + 2) & 3) || rng.chance(0.45)) continue;
          ends.push({ x: nx + HDX[d] * 4, y: e.y, z: nz + HDZ[d] * 4, dir: d, depth: e.depth + 1 });
        }
      } else if (roll < 0.34 && budget > 2 && e.y > 14) {
        const h = rng.range(4, 7);
        out.push(piece('mineshaft_shaft', nx, e.y - h, nz, rot, -2, -2, 2, 2, { h }));
        budget--;
        ends.push({ x: nx, y: e.y - h, z: nz, dir: rng.int(4), depth: e.depth + 1 });
      } else {
        // Always keep driving forward early on, so a mineshaft is never a stub.
        if (e.depth < 3 || rng.chance(0.72)) ends.push({ x: nx, y: e.y, z: nz, dir: e.dir, depth: e.depth + 1 });
        if (rng.chance(0.45)) {
          const d = rng.chance(0.5) ? (e.dir + 1) & 3 : (e.dir + 3) & 3;
          ends.push({ x: nx, y: e.y, z: nz, dir: d, depth: e.depth + 1 });
        }
      }
    }
    emitPieces(world, out);
  },
});

// ===========================================================================
// STRONGHOLD
// ===========================================================================
// Every stronghold room is built from the same weathered stone-brick palette.
const SB_MIX = () => [
  [bid('stone_bricks'), 0, 10], [bid('mossy_stone_bricks'), 0, 3],
  [bid('cracked_stone_bricks'), 0, 3], [bid('stone_bricks'), 0, 2],
];

PIECES.sh_corridor = (b) => {
  const len = b.o.len;
  b.fillMix(-2, -1, -2, len, 5, 2, SB_MIX());
  b.fill(0, 0, -1, len - 1, 3, 1, AIR, 0);
  for (let u = 1; u < len; u += 4) {
    b.torch(u, 2, -2, 2);
    b.torch(u, 2, 2, 0);
  }
  if (b.o.cell) {
    // A short barred alcove off the side of the run.
    b.fill(2, 0, 2, 3, 2, 3, AIR, 0);
    b.fill(2, 0, 2, 3, 2, 2, bid('iron_bars'), 0);
    b.set(2, 0, 2, bid('iron_door'), b.hf(2) << 1);
    b.set(2, 1, 2, bid('iron_door'), 1 | (b.hf(2) << 1));
  }
  if (b.o.chest) b.chest(len - 2, 0, 1, 0, 'stronghold_corridor');
};

PIECES.sh_crossing = (b) => {
  b.fillMix(-3, -1, -3, 3, 5, 3, SB_MIX());
  b.fill(-2, 0, -2, 2, 3, 2, AIR, 0);
  // Openings on all four sides.
  b.fill(-1, 0, -3, 1, 2, -3, AIR, 0);
  b.fill(-1, 0, 3, 1, 2, 3, AIR, 0);
  b.fill(-3, 0, -1, -3, 2, 1, AIR, 0);
  b.fill(3, 0, -1, 3, 2, 1, AIR, 0);
  b.standTorch(-2, 0, -2);
  b.standTorch(2, 0, 2);
  if (b.o.chest) b.chest(2, 0, -2, 2, 'stronghold_crossing');
};

PIECES.sh_stairs = (b) => {
  // Spiral staircase dropping one level per quarter turn.
  const drop = b.o.drop;
  b.fillMix(-3, -drop - 2, -3, 3, 4, 3, SB_MIX());
  b.fill(-2, -drop, -2, 2, 3, 2, AIR, 0);
  const ring = [[-2, -2], [-1, -2], [0, -2], [1, -2], [2, -2], [2, -1], [2, 0], [2, 1],
    [2, 2], [1, 2], [0, 2], [-1, 2], [-2, 2], [-2, 1], [-2, 0], [-2, -1]];
  for (let i = 0, y = 3; i < drop * 2 && y > -drop; i++, y--) {
    const p = ring[i % ring.length];
    b.set(p[0], y, p[1], bid('stone_brick_stairs'), b.hf(i & 3));
    b.set(p[0], y - 1, p[1], bid('stone_bricks'), 0);
  }
  b.fill(-1, -drop, -1, 1, -drop, 1, bid('stone_bricks'), 0);
  b.fill(-1, -drop + 1, -3, 1, -drop + 3, -3, AIR, 0);
  b.standTorch(0, -drop + 1, 0);
};

PIECES.sh_library = (b) => {
  const shelf = bid('bookshelf'), plank = bid('oak_planks'), fence = bid('oak_fence');
  b.fillMix(-1, -1, -1, 14, 9, 12, SB_MIX());
  b.fill(0, 0, 0, 13, 7, 11, AIR, 0);
  b.fill(0, -1, 0, 13, -1, 11, bid('stone_bricks'), 0);
  // Ground-floor stacks.
  for (let u = 2; u <= 11; u += 3) {
    b.fill(u, 0, 1, u, 2, 3, shelf, 0);
    b.fill(u, 0, 8, u, 2, 10, shelf, 0);
  }
  b.fill(0, 0, 0, 0, 3, 11, shelf, 0);
  b.fill(13, 0, 0, 13, 3, 11, shelf, 0);
  // Upper gallery.
  b.fill(1, 4, 1, 12, 4, 2, plank, 0);
  b.fill(1, 4, 9, 12, 4, 10, plank, 0);
  b.fill(1, 4, 3, 1, 4, 8, plank, 0);
  b.fill(12, 4, 3, 12, 4, 8, plank, 0);
  b.fill(1, 5, 2, 12, 5, 2, fence, 0);
  b.fill(1, 5, 9, 12, 5, 9, fence, 0);
  for (let u = 3; u <= 10; u += 3) {
    b.fill(u, 5, 1, u, 6, 1, shelf, 0);
    b.fill(u, 5, 10, u, 6, 10, shelf, 0);
  }
  for (let y = 0; y <= 4; y++) b.set(12, y, 8, bid('ladder'), b.hf(3));
  // Chandeliers hung from the ceiling.
  for (const [u, v] of [[4, 5], [9, 6]]) {
    b.fill(u, 5, v, u, 7, v, fence, 0);
    b.set(u, 4, v, bid('torch'), 0);
    b.set(u - 1, 5, v, fence, 0);
    b.set(u + 1, 5, v, fence, 0);
    b.torch(u - 1, 4, v, 3);
    b.torch(u + 1, 4, v, 1);
  }
  // Cobwebs in the corners and two chests.
  for (let i = 0; i < 26; i++) {
    const u = 1 + ((i * 7) % 12), v = 1 + ((i * 5) % 10), y = (i % 3) + 1;
    if (b.prand(u, y, v) < 0.3) b.set(u, y, v, bid('cobweb'), 0);
  }
  b.chest(6, 0, 6, 0, 'stronghold_library');
  b.chest(7, 5, 5, 2, 'stronghold_library');
  b.fill(6, 0, 5, 7, 0, 6, bid('oak_planks'), 0);
  b.fill(0, 0, 5, 0, 2, 6, AIR, 0);
};

PIECES.sh_prison = (b) => {
  const bars = bid('iron_bars');
  b.fillMix(-1, -1, -1, 10, 6, 10, SB_MIX());
  b.fill(0, 0, 0, 9, 4, 9, AIR, 0);
  b.fill(0, -1, 0, 9, -1, 9, bid('stone_bricks'), 0);
  // Three cells along the far wall.
  for (let i = 0; i < 3; i++) {
    const v = 1 + i * 3;
    b.fill(6, 0, v, 8, 3, v + 1, AIR, 0);
    b.fill(6, 0, v - 1, 8, 3, v - 1, bid('stone_bricks'), 0);
    b.fill(6, 0, v, 6, 2, v + 1, bars, 0);
    b.set(6, 0, v, bid('iron_door'), b.hf(3) << 1);
    b.set(6, 1, v, bid('iron_door'), 1 | (b.hf(3) << 1));
    b.set(8, 0, v + 1, bid('cobweb'), 0);
  }
  b.torch(2, 3, 0, 2);
  b.torch(2, 3, 9, 0);
  b.chest(1, 0, 8, 3, 'stronghold_corridor');
  b.fill(0, 0, 4, 0, 2, 5, AIR, 0);
  b.fill(9, 0, 4, 9, 2, 5, AIR, 0);
};

PIECES.sh_fountain = (b) => {
  b.fillMix(-1, -1, -1, 10, 8, 10, SB_MIX());
  b.fill(0, 0, 0, 9, 6, 9, AIR, 0);
  b.fill(0, -1, 0, 9, -1, 9, bid('stone_bricks'), 0);
  // Sunken pool with a chiselled centrepiece.
  b.fill(3, -1, 3, 6, -1, 6, bid('water'), 0);
  b.fill(4, 0, 4, 5, 1, 5, bid('chiseled_stone_bricks'), 0);
  b.set(4, 2, 4, bid('water'), 0);
  b.fill(2, 0, 2, 7, 0, 2, bid('stone_brick_slab'), 0);
  b.fill(2, 0, 7, 7, 0, 7, bid('stone_brick_slab'), 0);
  for (const [u, v] of [[1, 1], [8, 1], [1, 8], [8, 8]]) {
    b.fill(u, 0, v, u, 5, v, bid('stone_brick_wall'), 0);
    b.standTorch(u, 6, v);
  }
  b.fill(0, 0, 4, 0, 2, 5, AIR, 0);
  b.fill(9, 0, 4, 9, 2, 5, AIR, 0);
  b.fill(4, 0, 0, 5, 2, 0, AIR, 0);
};

PIECES.sh_portal = (b) => {
  const sb = bid('stone_bricks');
  b.fillMix(-1, -2, -1, 12, 9, 12, SB_MIX());
  b.fill(0, 0, 0, 11, 7, 11, AIR, 0);
  b.fillMix(0, -1, 0, 11, -1, 11, SB_MIX());
  // Descending entry stair on the near wall.
  for (let k = 0; k < 4; k++) {
    b.fill(4, 3 - k, k, 7, 3 - k, k, bid('stone_brick_stairs'), b.hf(2));
    b.fill(4, 2 - k, k, 7, 2 - k, k, sb, 0);
  }
  b.fill(4, 4, 0, 7, 6, 0, AIR, 0);
  // Lava moat beneath the portal platform.
  b.fill(3, -1, 3, 8, -1, 8, bid('lava'), 0);
  b.fill(4, 0, 4, 7, 0, 7, sb, 0);
  b.fill(3, 0, 3, 8, 0, 3, bid('stone_brick_slab'), 0);
  b.fill(3, 0, 8, 8, 0, 8, bid('stone_brick_slab'), 0);
  b.fill(3, 0, 4, 3, 0, 7, bid('stone_brick_slab'), 0);
  b.fill(8, 0, 4, 8, 0, 7, bid('stone_brick_slab'), 0);
  // Twelve frames around a 3x3 opening; a few already hold an eye.
  const frame = bid('end_portal_frame');
  const ring = [];
  for (let i = 0; i < 3; i++) {
    ring.push([4 + i, 3, 2]);            // north edge, facing south
    ring.push([4 + i, 8, 0]);            // south edge, facing north
    ring.push([3, 4 + i, 1]);            // west edge, facing east
    ring.push([8, 4 + i, 3]);            // east edge, facing west
  }
  for (let i = 0; i < ring.length; i++) {
    const [u, v, f] = ring[i];
    const eye = b.rng.chance(0.11) ? 4 : 0;
    b.set(u, 1, v, frame, b.hf(f) | eye);
  }
  b.fill(4, 1, 4, 6, 1, 6, AIR, 0);
  // Silverfish spawner on its own little podium.
  b.fill(1, 0, 1, 2, 1, 2, sb, 0);
  b.spawner(1, 2, 1, 'silverfish');
  b.chest(10, 0, 10, 3, 'stronghold_crossing');
  b.standTorch(10, 0, 1);
  b.standTorch(1, 0, 10);
  b.fill(0, 4, 5, 0, 6, 6, AIR, 0);
};

registerStructure('stronghold', {
  spacing: 40, separation: 12, salt: 0x57e0, dimension: DIM_OVERWORLD, biomes: null,
  generate(world, cx, cz, rng) {
    const bx = (cx << 4) + 8, bz = (cz << 4) + 8;
    const top = surveyGround(world, bx - 20, bz - 20, bx + 20, bz + 20, 6).min;
    let y = clamp(rng.range(16, 34), 10, top - 16);
    if (y < 10) return;
    const out = [];
    let ends = [{ x: bx, y, z: bz, dir: rng.int(4), depth: 0 }];
    let portalDone = false;
    let budget = 26;
    while (ends.length && budget > 0) {
      const e = ends.shift();
      const rot = rotForDir(e.dir);
      const roll = rng.next();
      const forward = (nx, nz, ny, d, dep) => ends.push({ x: nx, y: ny, z: nz, dir: d, depth: dep });

      if (!portalDone && (e.depth >= 3 || budget <= 4)) {
        // Portal room, anchored so its entry stair meets the corridor.
        out.push(piece('sh_portal', e.x, e.y, e.z, rot, -1, -6, 12, 12, null));
        portalDone = true;
        budget -= 3;
        continue;
      }
      if (roll < 0.40 || e.depth === 0) {
        const len = rng.range(6, 12);
        out.push(piece('sh_corridor', e.x, e.y, e.z, rot, -2, -2, len + 1, 2, {
          len, chest: rng.chance(0.3), cell: rng.chance(0.25),
        }));
        budget--;
        const nx = e.x + HDX[e.dir] * len, nz = e.z + HDZ[e.dir] * len;
        forward(nx, nz, e.y, e.dir, e.depth + 1);
      } else if (roll < 0.55) {
        out.push(piece('sh_crossing', e.x, e.y, e.z, rot, -4, -4, 4, 4, { chest: rng.chance(0.5) }));
        budget--;
        for (const d of [e.dir, (e.dir + 1) & 3, (e.dir + 3) & 3]) {
          if (rng.chance(0.35)) continue;
          forward(e.x + HDX[d] * 4, e.z + HDZ[d] * 4, e.y, d, e.depth + 1);
        }
      } else if (roll < 0.68 && e.y > 14) {
        const drop = rng.range(5, 8);
        out.push(piece('sh_stairs', e.x, e.y, e.z, rot, -4, -4, 4, 4, { drop }));
        budget--;
        forward(e.x - HDX[e.dir] * 4, e.z - HDZ[e.dir] * 4, e.y - drop, (e.dir + 2) & 3, e.depth + 1);
      } else if (roll < 0.80) {
        out.push(piece('sh_library', e.x, e.y, e.z, rot, -2, -2, 15, 13, null));
        budget -= 3;
        forward(e.x + HDX[e.dir] * 15, e.z + HDZ[e.dir] * 15, e.y, e.dir, e.depth + 1);
      } else if (roll < 0.90) {
        out.push(piece('sh_prison', e.x, e.y, e.z, rot, -2, -2, 11, 11, null));
        budget -= 2;
        forward(e.x + HDX[e.dir] * 11, e.z + HDZ[e.dir] * 11, e.y, e.dir, e.depth + 1);
      } else {
        out.push(piece('sh_fountain', e.x, e.y, e.z, rot, -2, -2, 11, 11, null));
        budget -= 2;
        forward(e.x + HDX[e.dir] * 11, e.z + HDZ[e.dir] * 11, e.y, e.dir, e.depth + 1);
      }
    }
    if (!portalDone) out.push(piece('sh_portal', bx, y, bz + 16, 0, -1, -6, 12, 12, null));
    emitPieces(world, out);
  },
});

// ===========================================================================
// RUINED PORTAL / DESERT WELL / FOSSIL / TRAIL RUINS / GEODE
// ===========================================================================
PIECES.ruined_portal = (b) => {
  const obs = bid('obsidian'), cry = bid('crying_obsidian'), nr = bid('netherrack');
  const w = b.o.w, h = b.o.h;
  b.clearAbove(-3, -2, w + 2, 4, h + 3);
  // Netherrack apron with a few fires still burning.
  for (let v = -2; v <= 4; v++) {
    for (let u = -3; u <= w + 2; u++) {
      const r = b.prand(u, -1, v);
      if (r < 0.55) {
        b.set(u, -1, v, nr, 0);
        if (r < 0.06) b.set(u, 0, v, bid('fire'), 0);
        else if (r < 0.10) b.set(u, 0, v, bid('magma_block'), 0);
      }
    }
  }
  // Frame: some blocks missing, some weeping.
  const put = (u, y) => {
    const r = b.prand(u, y, 0);
    if (r < 0.22) return;                       // eroded away
    b.set(u, y, 0, r < 0.35 ? cry : obs, 0);
  };
  for (let u = 0; u < w; u++) { put(u, 0); put(u, h - 1); }
  for (let y = 1; y < h - 1; y++) { put(0, y); put(w - 1, y); }
  b.fill(1, 1, 0, w - 2, h - 2, 0, AIR, 0);
  // Gold-block cache and lava pocket, the way a ruin looks after the fire.
  b.set(w + 1, 0, 2, bid('gold_block'), 0);
  b.set(-2, 0, 2, bid('lava'), 0);
  b.fill(-1, -1, 3, 1, -1, 3, bid('blackstone'), 0);
  b.chest(w + 1, 0, -1, 2, 'ruined_portal');
};

registerStructure('ruined_portal', {
  spacing: 20, separation: 6, salt: 0x2170, dimension: DIM_OVERWORLD, biomes: null,
  generate(world, cx, cz, rng) {
    const bx = (cx << 4) + 8, bz = (cz << 4) + 8;
    const g = surveyGround(world, bx - 3, bz - 2, bx + 8, bz + 4, 2);
    if (g.spread > 12) return;
    const w = rng.range(4, 5), h = rng.range(4, 6);
    emitPieces(world, [piece('ruined_portal', bx, g.avg, bz, rng.int(4), -4, -3, w + 3, 5,
      { w, h })]);
  },
});

PIECES.desert_well = (b) => {
  const ss = bid('sandstone'), slab = bid('sandstone_slab'), water = bid('water');
  b.clearAbove(-3, -3, 3, 3, 6);
  b.foundation(-2, -2, 2, 2, ss, 0, 8);
  b.fill(-2, -1, -2, 2, -1, 2, ss, 0);
  b.fill(-1, -1, -1, 1, -4, 1, water, 0);
  b.fill(-1, -5, -1, 1, -5, 1, ss, 0);
  b.fill(-2, 0, -2, 2, 0, 2, slab, 0);
  b.fill(-1, 0, -1, 1, 0, 1, water, 0);
  for (const [u, v] of [[-1, -1], [1, -1], [-1, 1], [1, 1]]) b.fill(u, 1, v, u, 3, v, ss, 0);
  b.fill(-1, 4, -1, 1, 4, 1, slab, 0);
  b.set(0, -3, 0, bid('suspicious_sand'), 0);
  b.chest(2, 1, 2, 0, 'desert_well');
};

registerStructure('desert_well', {
  spacing: 12, separation: 4, salt: 0xde5e, dimension: DIM_OVERWORLD, biomes: ['desert'],
  generate(world, cx, cz, rng) {
    if (!rng.chance(0.35)) return;
    const bx = (cx << 4) + 8, bz = (cz << 4) + 8;
    const g = surveyGround(world, bx - 2, bz - 2, bx + 2, bz + 2, 1);
    if (g.spread > 2) return;
    emitPieces(world, [piece('desert_well', bx, g.avg, bz, 0, -3, -3, 3, 3)]);
  },
});

PIECES.fossil = (b) => {
  const bone = bid('bone_block'), coal = bid('coal_ore');
  const spine = b.o.len;
  // A spine with ribs curling up on both sides.
  for (let u = 0; u < spine; u++) {
    b.set(u, 0, 0, bone, b.ax(1));
    if (b.prand(u, 0, 0) < 0.12) b.set(u, 0, 0, coal, 0);
    if (u % 2 === 0 && u > 0 && u < spine - 1) {
      for (let k = 1; k <= 3; k++) {
        if (b.prand(u, k, 1) < 0.18) continue;
        b.set(u, k - 1, k, bone, b.ax(2));
        b.set(u, k - 1, -k, bone, b.ax(2));
      }
      b.set(u, 3, 3, bone, 0);
      b.set(u, 3, -3, bone, 0);
    }
  }
  b.fill(0, 1, 0, 1, 2, 0, bone, 0);       // skull
  b.set(0, 2, 1, bone, b.ax(2));
  b.set(0, 2, -1, bone, b.ax(2));
};

registerStructure('fossil', {
  spacing: 16, separation: 5, salt: 0xf055, dimension: DIM_OVERWORLD,
  biomes: ['desert', 'badlands', 'eroded_badlands', 'wooded_badlands', 'swamp', 'mangrove_swamp'],
  generate(world, cx, cz, rng) {
    const bx = (cx << 4) + 8, bz = (cz << 4) + 8;
    const top = surveyGround(world, bx - 6, bz - 4, bx + 6, bz + 4, 3).min;
    const y = clamp(rng.range(top - 26, top - 8), 6, 100);
    if (y >= top - 6) return;
    const len = rng.range(9, 13);
    emitPieces(world, [piece('fossil', bx - (len >> 1), y, bz, rng.int(4), -1, -4, len, 4, { len })]);
  },
});

PIECES.trail_ruins = (b) => {
  const brick = bid('mud_bricks'), gravel = bid('suspicious_gravel');
  const pack = bid('packed_mud'), slab = bid('mud_brick_slab');
  const w = b.o.w, d = b.o.d;
  // Half-buried courtyard: the top layer is gone, so it sits under the soil.
  for (let v = 0; v < d; v++) {
    for (let u = 0; u < w; u++) {
      const r = b.prand(u, 0, v);
      if (r < 0.14) continue;
      b.set(u, 0, v, r < 0.5 ? brick : pack, 0);
      if (r > 0.9) b.set(u, 1, v, slab, 0);
    }
  }
  // Walls of a lost building, and the buried caches archaeologists look for.
  b.fill(0, 1, 0, 0, 2, d - 1, brick, 0);
  b.fill(w - 1, 1, 0, w - 1, 2, d - 1, brick, 0);
  for (let i = 0; i < 6; i++) {
    const u = 1 + ((i * 5) % Math.max(1, w - 2));
    const v = 1 + ((i * 3) % Math.max(1, d - 2));
    b.set(u, -1, v, gravel, 0);
  }
  b.set(2, 1, 2, bid('decorated_pot'), 0);
  b.set(w - 3, 1, d - 3, bid('decorated_pot'), 0);
  b.chest(1, 1, 1, 0, 'trail_ruins_common');
  b.chest(w - 2, 1, d - 2, 2, 'trail_ruins_rare');
};

registerStructure('trail_ruins', {
  spacing: 34, separation: 8, salt: 0x74a1, dimension: DIM_OVERWORLD,
  biomes: ['taiga', 'snowy_taiga', 'old_growth_pine_taiga', 'old_growth_spruce_taiga',
    'jungle', 'desert'],
  generate(world, cx, cz, rng) {
    const bx = (cx << 4) + 8, bz = (cz << 4) + 8;
    const g = surveyGround(world, bx - 8, bz - 8, bx + 8, bz + 8, 3);
    if (g.spread > 6 || g.avg <= SEA_LEVEL) return;
    const w = rng.range(9, 14), d = rng.range(9, 14);
    emitPieces(world, [piece('trail_ruins', bx - (w >> 1), g.avg - 2, bz - (d >> 1), rng.int(4),
      -1, -1, w, d, { w, d })]);
  },
});

PIECES.amethyst_geode = (b) => {
  const r = b.o.r;
  const amethyst = bid('amethyst_block'), budding = bid('budding_amethyst');
  const calcite = bid('calcite'), basalt = bid('smooth_basalt'), cluster = bid('amethyst_cluster');
  for (let y = -r - 2; y <= r + 2; y++) {
    for (let v = -r - 2; v <= r + 2; v++) {
      for (let u = -r - 2; u <= r + 2; u++) {
        const d = Math.sqrt(u * u + y * y + v * v) + (b.prand(u, y, v) - 0.5) * 0.9;
        if (d > r + 2) continue;
        if (d > r + 1) b.set(u, y, v, basalt, 0);
        else if (d > r) b.set(u, y, v, calcite, 0);
        else if (d > r - 1) b.set(u, y, v, b.prand(u, y + 40, v) < 0.16 ? budding : amethyst, 0);
        else b.set(u, y, v, AIR, 0);
      }
    }
  }
  for (let i = 0; i < 24; i++) {
    const u = -r + ((i * 7) % (2 * r)), v = -r + ((i * 5) % (2 * r));
    const y = -r + 1 + ((i * 3) % (2 * r - 1));
    if (b.prand(u, y + 90, v) < 0.35) b.set(u, y, v, cluster, 0);
  }
};

registerStructure('amethyst_geode', {
  spacing: 18, separation: 6, salt: 0xa14e, dimension: DIM_OVERWORLD, biomes: null,
  generate(world, cx, cz, rng) {
    if (!rng.chance(0.5)) return;
    const bx = (cx << 4) + 8, bz = (cz << 4) + 8;
    const top = surveyGround(world, bx - 6, bz - 6, bx + 6, bz + 6, 4).min;
    const r = rng.range(4, 6);
    const y = clamp(rng.range(8, 42), r + 4, top - r - 4);
    if (y <= r + 4) return;
    emitPieces(world, [piece('amethyst_geode', bx, y, bz, 0, -r - 2, -r - 2, r + 2, r + 2, { r })]);
  },
});

// ===========================================================================
// ANCIENT CITY
// ===========================================================================
PIECES.ancient_city = (b) => {
  const tile = bid('deepslate_tiles'), brick = bid('deepslate_bricks');
  const pol = bid('polished_deepslate'), sculk = bid('sculk');
  const basalt = bid('smooth_basalt'), lantern = bid('soul_lantern');
  const MIX = [[tile, 0, 10], [brick, 0, 6], [bid('cracked_deepslate_tiles'), 0, 4],
    [bid('cracked_deepslate_bricks'), 0, 3], [sculk, 0, 3]];
  const W = 30, D = 26, H = 12;

  // Cavernous hall.
  b.fill(-1, -1, -1, W, H + 1, D, bid('deepslate'), 0);
  b.fill(0, 0, 0, W - 1, H, D - 1, AIR, 0);
  b.fillMix(0, -1, 0, W - 1, -1, D - 1, MIX);
  b.fillMix(0, H, 0, W - 1, H, D - 1, MIX);
  b.walls(0, 0, 0, W - 1, H, D - 1, brick, 0);

  // Colonnade.
  for (let u = 4; u < W - 3; u += 6) {
    for (let v = 4; v < D - 3; v += 7) {
      b.fill(u, 0, v, u, H - 1, v, pol, 0);
      b.set(u, H - 1, v, basalt, 0);
      b.set(u + 1, H - 2, v, bid('deepslate_tile_stairs'), b.hf(1));
      b.set(u - 1, H - 2, v, bid('deepslate_tile_stairs'), b.hf(3));
      b.set(u, 4, v + 1, lantern, 0);
    }
  }
  // Sculk growth creeping over the floor, with sensors and shriekers.
  for (let v = 1; v < D - 1; v++) {
    for (let u = 1; u < W - 1; u++) {
      const r = b.prand(u, 0, v);
      if (r < 0.30) b.set(u, -1, v, sculk, 0);
      if (r > 0.985) b.set(u, 0, v, bid('sculk_shrieker'), 0);
      else if (r > 0.965) b.set(u, 0, v, bid('sculk_sensor'), 0);
      else if (r > 0.955) b.set(u, 0, v, bid('sculk_catalyst'), 0);
      else if (r > 0.94) b.set(u, 0, v, bid('sculk_vein'), 0);
    }
  }
  // Central altar: a reinforced-deepslate plinth ringed by soul fire.
  const au = W >> 1, av = D >> 1;
  b.fill(au - 3, 0, av - 3, au + 3, 0, av + 3, pol, 0);
  b.fill(au - 2, 1, av - 2, au + 2, 1, av + 2, brick, 0);
  b.fill(au - 1, 2, av - 1, au + 1, 2, av + 1, bid('reinforced_deepslate'), 0);
  b.set(au, 3, av, bid('sculk_catalyst'), 0);
  for (const [du, dv] of [[-2, -2], [2, -2], [-2, 2], [2, 2]]) {
    b.fill(au + du, 1, av + dv, au + du, 4, av + dv, pol, 0);
    b.set(au + du, 5, av + dv, bid('soul_lantern'), 0);
    b.set(au + du, 2, av + dv + (dv > 0 ? -1 : 1), bid('soul_fire'), 0);
  }
  b.set(au - 1, 3, av, bid('candle'), 0);
  b.set(au + 1, 3, av, bid('candle'), 0);
  b.chest(au, 3, av - 2, 0, 'ancient_city');
  b.chest(au, 3, av + 2, 2, 'ancient_city');

  // Side chambers with more loot and a frozen ice box.
  b.fill(2, 0, 2, 6, 4, 6, AIR, 0);
  b.walls(2, 0, 2, 6, 4, 6, brick, 0);
  b.fill(2, 0, 4, 2, 2, 4, AIR, 0);
  b.chest(4, 0, 4, 0, 'ancient_city');
  b.fill(W - 7, 0, D - 7, W - 3, 3, D - 3, bid('blue_ice'), 0);
  b.fill(W - 6, 1, D - 6, W - 4, 2, D - 4, AIR, 0);
  b.chest(W - 5, 1, D - 5, 0, 'ancient_city_ice_box');
  // Ruined ribs of the outer structure and a way in from above.
  b.fill(W >> 1, H, 1, W >> 1, H + 4, 1, AIR, 0);
  for (let k = 0; k < 6; k++) b.set((W >> 1) + 1, H + k, 1, bid('ladder'), b.hf(0));

  if (b.primary) {
    b.mob(au, 1, av + 5, 'warden');
  }
};

registerStructure('ancient_city', {
  spacing: 48, separation: 16, salt: 0xacc1, dimension: DIM_OVERWORLD,
  biomes: ['deep_dark'],
  generate(world, cx, cz, rng) {
    const bx = (cx << 4) - 8, bz = (cz << 4) - 8;
    const top = surveyGround(world, bx, bz, bx + 30, bz + 26, 6).min;
    const y = clamp(rng.range(6, 14), 4, Math.max(5, top - 20));
    if (y + 16 > top) return;
    emitPieces(world, [piece('ancient_city', bx, y, bz, 0, -2, -2, 31, 27)]);
  },
});

// ===========================================================================
// OCEAN MONUMENT
// ===========================================================================
PIECES.ocean_monument = (b) => {
  const pris = bid('prismarine'), brick = bid('prismarine_bricks');
  const dark = bid('dark_prismarine'), lamp = bid('sea_lantern'), water = bid('water');
  const MIX = [[pris, 0, 8], [brick, 0, 6], [dark, 0, 3]];
  const W = 22, D = 22, H = 14;

  b.fillMix(0, 0, 0, W - 1, H - 1, D - 1, MIX);
  // Hollow the three interior levels, keeping structural cross-walls.
  for (let f = 0; f < 3; f++) {
    const y0 = 1 + f * 4;
    b.fill(2, y0, 2, W - 3, y0 + 2, D - 3, water, 0);
    b.fill(10, y0, 2, 11, y0 + 2, D - 3, brick, 0);
    b.fill(2, y0, 10, W - 3, y0 + 2, 11, brick, 0);
    b.fill(6, y0, 6, 6, y0 + 2, 6, dark, 0);
    b.fill(W - 7, y0, D - 7, W - 7, y0 + 2, D - 7, dark, 0);
    // Doorways through the cross-walls.
    b.fill(10, y0, 5, 11, y0 + 1, 6, water, 0);
    b.fill(10, y0, D - 7, 11, y0 + 1, D - 6, water, 0);
    b.fill(5, y0, 10, 6, y0 + 1, 11, water, 0);
    b.fill(W - 7, y0, 10, W - 6, y0 + 1, 11, water, 0);
    b.set(4, y0 + 2, 4, lamp, 0);
    b.set(W - 5, y0 + 2, D - 5, lamp, 0);
    b.set(4, y0 + 2, D - 5, lamp, 0);
    b.set(W - 5, y0 + 2, 4, lamp, 0);
  }
  // Entrances on all four faces at the base.
  b.fill(9, 1, 0, 12, 3, 0, water, 0);
  b.fill(9, 1, D - 1, 12, 3, D - 1, water, 0);
  b.fill(0, 1, 9, 0, 3, 12, water, 0);
  b.fill(W - 1, 1, 9, W - 1, 3, 12, water, 0);

  // Four wings, each a stepped tower off a corner.
  for (const [wu, wv] of [[-5, 3], [W, 3], [-5, D - 8], [W, D - 8]]) {
    b.fillMix(wu, 0, wv, wu + 4, 7, wv + 4, MIX);
    b.fill(wu + 1, 1, wv + 1, wu + 3, 5, wv + 3, water, 0);
    b.set(wu + 2, 6, wv + 2, lamp, 0);
  }
  // Roof terrace and the crowning spire.
  b.fillMix(1, H, 1, W - 2, H, D - 2, MIX);
  b.fill(8, H + 1, 8, 13, H + 5, 13, brick, 0);
  b.fill(9, H + 1, 9, 12, H + 4, 12, water, 0);
  b.set(10, H + 6, 10, lamp, 0);
  b.set(11, H + 6, 11, lamp, 0);

  // Treasure room: eight gold blocks in a dark prismarine vault.
  const ty = 1 + 8, tu = 9, tv = 9;
  b.fill(tu - 1, ty - 1, tv - 1, tu + 3, ty + 3, tv + 3, dark, 0);
  b.fill(tu, ty, tv, tu + 2, ty + 2, tv + 2, water, 0);
  b.fill(tu, ty, tv, tu + 1, ty + 1, tv + 1, bid('gold_block'), 0);
  b.set(tu + 2, ty, tv + 2, lamp, 0);
  b.chest(tu + 2, ty, tv, 0, 'ocean_monument');

  if (b.primary) {
    b.mob(11, 10, 11, 'elder_guardian');
    b.mob(4, 3, 4, 'elder_guardian');
    b.mob(W - 5, 3, D - 5, 'elder_guardian');
    for (let i = 0; i < 8; i++) b.mob(3 + (i * 3) % 16, 2 + (i % 3) * 4, 3 + (i * 5) % 16, 'guardian');
  }
};

registerStructure('ocean_monument', {
  spacing: 32, separation: 6, salt: 0x0cea, dimension: DIM_OVERWORLD,
  biomes: ['ocean', 'deep_ocean', 'cold_ocean', 'deep_cold_ocean', 'lukewarm_ocean',
    'deep_lukewarm_ocean', 'frozen_ocean', 'deep_frozen_ocean'],
  generate(world, cx, cz) {
    const bx = (cx << 4) - 3, bz = (cz << 4) - 3;
    const g = surveyGround(world, bx, bz, bx + 22, bz + 22, 4);
    if (g.avg > SEA_LEVEL - 10 || g.spread > 22) return;    // needs deep water
    emitPieces(world, [piece('ocean_monument', bx, g.min - 1, bz, 0, -6, -1, 27, 23)]);
  },
});

// ===========================================================================
// OCEAN RUINS / SHIPWRECK / BURIED TREASURE
// ===========================================================================
PIECES.ocean_ruins = (b) => {
  const warm = b.o.warm;
  const main = bid(warm ? 'sandstone' : 'stone_bricks');
  const alt = bid(warm ? 'cut_sandstone' : 'mossy_stone_bricks');
  const crack = bid(warm ? 'chiseled_sandstone' : 'cracked_stone_bricks');
  const MIX = [[main, 0, 8], [alt, 0, 4], [crack, 0, 3], [-1, 0, 5]];
  const w = b.o.w, d = b.o.d, h = b.o.h;
  b.fillMix(0, -1, 0, w - 1, -1, d - 1, [[main, 0, 8], [alt, 0, 4]]);
  b.fillMix(0, 0, 0, w - 1, h, 0, MIX);
  b.fillMix(0, 0, d - 1, w - 1, h, d - 1, MIX);
  b.fillMix(0, 0, 0, 0, h, d - 1, MIX);
  b.fillMix(w - 1, 0, 0, w - 1, h, d - 1, MIX);
  for (let v = 1; v < d - 1; v++) {
    for (let u = 1; u < w - 1; u++) {
      const r = b.prand(u, 0, v);
      if (r < 0.25) b.set(u, 0, v, alt, 0);
      else if (r > 0.94) b.set(u, 0, v, bid('sea_pickle'), 0);
      else if (r > 0.88) b.set(u, 0, v, bid('seagrass'), 0);
    }
  }
  b.chest(w >> 1, 0, d >> 1, 0, b.o.big ? 'underwater_ruin_big' : 'underwater_ruin_small');
  b.set(1, 0, 1, bid('magma_block'), 0);
  if (b.primary) {
    b.mob(2, 1, 2, 'drowned');
    if (b.o.big) b.mob(w - 2, 1, d - 2, 'drowned');
  }
};

registerStructure('ocean_ruins', {
  spacing: 20, separation: 8, salt: 0x0ce1, dimension: DIM_OVERWORLD,
  biomes: ['ocean', 'deep_ocean', 'cold_ocean', 'deep_cold_ocean', 'lukewarm_ocean',
    'deep_lukewarm_ocean', 'warm_ocean', 'frozen_ocean', 'deep_frozen_ocean'],
  generate(world, cx, cz, rng) {
    const bx = (cx << 4) + 4, bz = (cz << 4) + 4;
    const g = surveyGround(world, bx - 4, bz - 4, bx + 10, bz + 10, 3);
    if (g.avg > SEA_LEVEL - 3) return;
    const warm = (biomeNameAt(world, bx, bz) || '').indexOf('warm') >= 0;
    const big = rng.chance(0.35);
    const w = big ? rng.range(9, 13) : rng.range(5, 8);
    const d = big ? rng.range(9, 13) : rng.range(5, 8);
    const out = [];
    out.push(piece('ocean_ruins', bx, g.min, bz, rng.int(4), -1, -1, w, d,
      { w, d, h: big ? 4 : 2, warm, big }));
    // Ruins come in clusters.
    const extra = rng.range(1, 3);
    for (let i = 0; i < extra; i++) {
      const ex = bx + rng.range(-12, 12), ez = bz + rng.range(-12, 12);
      const eg = surveyGround(world, ex - 3, ez - 3, ex + 5, ez + 5, 2);
      if (eg.avg > SEA_LEVEL - 3) continue;
      const ew = rng.range(4, 7), ed = rng.range(4, 7);
      out.push(piece('ocean_ruins', ex, eg.min, ez, rng.int(4), -1, -1, ew, ed,
        { w: ew, d: ed, h: rng.range(1, 3), warm, big: false }));
    }
    emitPieces(world, out);
  },
});

PIECES.shipwreck = (b) => {
  const plank = bid(b.o.dark ? 'dark_oak_planks' : 'oak_planks');
  const log = bid(b.o.dark ? 'dark_oak_log' : 'oak_log');
  const stairs = bid(b.o.dark ? 'dark_oak_stairs' : 'oak_stairs');
  const fence = bid(b.o.dark ? 'dark_oak_fence' : 'oak_fence');
  const L = 20, Wd = 7;
  // Hull: a tapered box, half of it broken away.
  for (let u = 0; u < L; u++) {
    const taper = u < 3 ? (3 - u) : (u > L - 4 ? u - (L - 4) : 0);
    const v0 = taper, v1 = Wd - 1 - taper;
    if (v0 > v1) continue;
    for (let v = v0; v <= v1; v++) {
      const rot = b.prand(u, 0, v);
      if (rot < b.o.decay) continue;
      b.set(u, 0, v, plank, 0);
      if (v === v0 || v === v1) {
        b.fill(u, 1, v, u, 3, v, plank, 0);
        if (b.prand(u, 4, v) > 0.55) b.set(u, 4, v, fence, 0);
      }
      if (u === 0 || u === L - 1) b.fill(u, 1, v, u, 3, v, plank, 0);
    }
  }
  b.fill(1, 4, 1, L - 2, 4, Wd - 2, AIR, 0);
  // Deck and cabin.
  b.fill(2, 4, 1, L - 3, 4, Wd - 2, plank, 0);
  b.fill(L - 8, 5, 1, L - 3, 8, Wd - 2, plank, 0);
  b.fill(L - 7, 5, 2, L - 4, 7, Wd - 3, AIR, 0);
  b.fill(L - 8, 9, 1, L - 3, 9, Wd - 2, stairs, b.hf(0));
  // Masts.
  for (const u of [5, 12]) {
    b.fill(u, 5, 3, u, 11, 3, log, 0);
    b.fill(u - 1, 9, 3, u + 1, 9, 3, fence, 0);
  }
  // The three holds: map room, supply hold, treasure.
  b.chest(L - 5, 5, 3, 0, 'shipwreck_map');
  b.chest(3, 1, 3, 0, 'shipwreck_supply');
  b.chest(4, 1, 2, 2, 'shipwreck_treasure');
  b.set(2, 1, 4, bid('barrel'), 0);
  b.set(L - 6, 5, 2, bid('crafting_table'), 0);
  if (b.primary && b.o.underwater) b.mob(6, 2, 3, 'drowned');
};

registerStructure('shipwreck', {
  spacing: 24, separation: 4, salt: 0x5417, dimension: DIM_OVERWORLD,
  biomes: ['ocean', 'deep_ocean', 'cold_ocean', 'deep_cold_ocean', 'lukewarm_ocean',
    'deep_lukewarm_ocean', 'warm_ocean', 'frozen_ocean', 'deep_frozen_ocean',
    'beach', 'snowy_beach', 'stony_shore'],
  generate(world, cx, cz, rng) {
    const bx = (cx << 4), bz = (cz << 4);
    const g = surveyGround(world, bx, bz, bx + 20, bz + 8, 3);
    if (g.spread > 8) return;
    emitPieces(world, [piece('shipwreck', bx, g.min, bz, rng.int(4), -1, -1, 21, 8, {
      dark: rng.chance(0.5), decay: rng.float(0.05, 0.35), underwater: g.avg < SEA_LEVEL - 2,
    })]);
  },
});

PIECES.buried_treasure = (b) => {
  b.chest(0, 0, 0, 0, 'buried_treasure');
  b.set(0, 1, 0, bid('sand'), 0);
  b.set(1, 0, 0, bid('sandstone'), 0);
  b.set(-1, 0, 0, bid('sandstone'), 0);
  b.set(0, 0, 1, bid('sandstone'), 0);
  b.set(0, 0, -1, bid('sandstone'), 0);
  b.set(0, -1, 0, bid('sandstone'), 0);
};

registerStructure('buried_treasure', {
  spacing: 6, separation: 1, salt: 0xb0a7, dimension: DIM_OVERWORLD,
  biomes: ['beach', 'snowy_beach', 'stony_shore'],
  generate(world, cx, cz, rng) {
    if (!rng.chance(0.5)) return;
    const bx = (cx << 4) + 9, bz = (cz << 4) + 9;
    const g = surfaceY(world, bx, bz);
    const y = Math.max(3, g - rng.range(2, 5));
    emitPieces(world, [piece('buried_treasure', bx, y, bz, 0, -1, -1, 1, 1)]);
  },
});

// ===========================================================================
// WOODLAND MANSION
// ===========================================================================
const MANSION_ROOMS = ['bedroom', 'dining', 'library', 'storage', 'altar', 'hall', 'hall'];

PIECES.woodland_mansion = (b) => {
  const plank = bid('dark_oak_planks'), log = bid('dark_oak_log');
  const stairs = bid('dark_oak_stairs'), slab = bid('dark_oak_slab');
  const fence = bid('dark_oak_fence'), cob = bid('cobblestone');
  const wool = bid('red_carpet'), glass = bid('glass_pane');
  const CW = 7, CD = 7, COLS = 5, ROWS = 4;
  const W = CW * COLS, D = CD * ROWS;                    // 35 x 28
  const floors = b.o.floors;

  b.clearAbove(-2, -2, W + 1, D + 1, floors * 6 + 8);
  b.foundation(-1, -1, W, D, cob, 0, 14);
  b.fill(-1, -1, -1, W, -1, D, cob, 0);

  for (let f = 0; f < floors; f++) {
    const y0 = f * 6;
    // Third storey only covers the middle of the plan, giving a stepped roof.
    const u0 = f === 2 ? CW : 0, u1 = f === 2 ? W - CW - 1 : W - 1;
    const v0 = f === 2 ? 0 : 0, v1 = f === 2 ? D - CD - 1 : D - 1;

    b.fill(u0, y0, v0, u1, y0, v1, plank, 0);
    b.fill(u0, y0 + 1, v0, u1, y0 + 5, v1, AIR, 0);
    b.walls(u0, y0 + 1, v0, u1, y0 + 5, v1, plank, 0);
    // Corner and pier logs.
    for (let u = u0; u <= u1; u += CW) {
      b.fill(u, y0 + 1, v0, u, y0 + 5, v0, log, 0);
      b.fill(u, y0 + 1, v1, u, y0 + 5, v1, log, 0);
    }
    for (let v = v0; v <= v1; v += CD) {
      b.fill(u0, y0 + 1, v, u0, y0 + 5, v, log, 0);
      b.fill(u1, y0 + 1, v, u1, y0 + 5, v, log, 0);
    }
    // Windows all round.
    for (let u = u0 + 3; u < u1; u += CW) {
      b.fill(u, y0 + 2, v0, u, y0 + 3, v0, glass, 0);
      b.fill(u, y0 + 2, v1, u, y0 + 3, v1, glass, 0);
    }
    for (let v = v0 + 3; v < v1; v += CD) {
      b.fill(u0, y0 + 2, v, u0, y0 + 3, v, glass, 0);
      b.fill(u1, y0 + 2, v, u1, y0 + 3, v, glass, 0);
    }

    // Room grid.
    for (let j = 0; j * CD + CD <= v1 - v0 + 1; j++) {
      for (let i = 0; i * CW + CW <= u1 - u0 + 1; i++) {
        const ru = u0 + i * CW, rv = v0 + j * CD;
        const r = b.prand(ru, y0 + 1, rv);
        const secret = f === 1 && r > 0.93;
        const kind = secret ? 'treasure' : MANSION_ROOMS[Math.floor(r * MANSION_ROOMS.length) % MANSION_ROOMS.length];
        if (kind === 'hall' && !secret) {
          b.fill(ru + 1, y0 + 1, rv + 1, ru + CW - 1, y0 + 5, rv + CD - 1, AIR, 0);
          if ((i + j) % 3 === 0) {
            b.fill(ru + 3, y0 + 1, rv + 3, ru + 3, y0 + 5, rv + 3, log, 0);
            b.set(ru + 3, y0 + 5, rv + 3, bid('glowstone'), 0);
          }
          continue;
        }
        // Partition walls with a doorway, except for the sealed vaults.
        b.walls(ru, y0 + 1, rv, ru + CW - 1, y0 + 5, rv + CD - 1, plank, 0);
        b.fill(ru + 1, y0 + 1, rv + 1, ru + CW - 2, y0 + 5, rv + CD - 2, AIR, 0);
        if (!secret) {
          const side = Math.floor(r * 4) & 3;
          if (side === 0) b.fill(ru + 3, y0 + 1, rv, ru + 3, y0 + 2, rv, AIR, 0);
          else if (side === 1) b.fill(ru + CW - 1, y0 + 1, rv + 3, ru + CW - 1, y0 + 2, rv + 3, AIR, 0);
          else if (side === 2) b.fill(ru + 3, y0 + 1, rv + CD - 1, ru + 3, y0 + 2, rv + CD - 1, AIR, 0);
          else b.fill(ru, y0 + 1, rv + 3, ru, y0 + 2, rv + 3, AIR, 0);
        }
        b.torch(ru + 1, y0 + 3, rv + 1, 0);

        switch (kind) {
          case 'bedroom':
            b.bed(ru + 2, y0 + 1, rv + 2, 2, 'red');
            b.set(ru + 4, y0 + 1, rv + 2, bid('dark_oak_slab'), 0);
            b.chest(ru + 5, y0 + 1, rv + 5, 0, 'woodland_mansion');
            b.fill(ru + 2, y0 + 1, rv + 4, ru + 4, y0 + 1, rv + 5, wool, 0);
            break;
          case 'dining':
            b.fill(ru + 2, y0 + 1, rv + 2, ru + 4, y0 + 1, rv + 4, plank, 0);
            b.fill(ru + 2, y0 + 2, rv + 2, ru + 4, y0 + 2, rv + 4, slab, 0);
            b.stair(ru + 1, y0 + 1, rv + 3, 'dark_oak_stairs', 1);
            b.stair(ru + 5, y0 + 1, rv + 3, 'dark_oak_stairs', 3);
            b.set(ru + 3, y0 + 3, rv + 3, bid('torch'), 0);
            break;
          case 'library':
            b.fill(ru + 1, y0 + 1, rv + 1, ru + 1, y0 + 3, rv + CD - 2, bid('bookshelf'), 0);
            b.fill(ru + CW - 2, y0 + 1, rv + 1, ru + CW - 2, y0 + 3, rv + CD - 2, bid('bookshelf'), 0);
            b.set(ru + 3, y0 + 1, rv + 3, bid('lectern'), b.hf(0));
            b.chest(ru + 3, y0 + 1, rv + 5, 0, 'woodland_mansion');
            break;
          case 'storage':
            b.fill(ru + 1, y0 + 1, rv + 1, ru + 2, y0 + 2, rv + 2, bid('barrel'), 0);
            b.chest(ru + 5, y0 + 1, rv + 1, 2, 'woodland_mansion');
            b.set(ru + 5, y0 + 1, rv + 5, bid('crafting_table'), 0);
            b.set(ru + 4, y0 + 1, rv + 5, bid('cobweb'), 0);
            break;
          case 'treasure':
            b.fill(ru + 1, y0 + 1, rv + 1, ru + CW - 2, y0 + 1, rv + CD - 2, wool, 0);
            b.chest(ru + 2, y0 + 1, rv + 2, 0, 'woodland_mansion');
            b.chest(ru + 4, y0 + 1, rv + 4, 2, 'woodland_mansion');
            b.set(ru + 3, y0 + 1, rv + 3, bid('diamond_block'), 0);
            b.set(ru + 3, y0 + 2, rv + 3, bid('cobweb'), 0);
            b.set(ru + 1, y0 + 3, rv + 5, bid('cobweb'), 0);
            break;
          default: {   // 'altar' - the illager shrine
            b.fill(ru + 1, y0 + 1, rv + 1, ru + CW - 2, y0 + 1, rv + CD - 2, wool, 0);
            b.fill(ru + 3, y0 + 1, rv + 3, ru + 3, y0 + 2, rv + 3, log, 0);
            b.set(ru + 3, y0 + 3, rv + 3, bid('dark_oak_pressure_plate'), 0);
            b.set(ru + 2, y0 + 1, rv + 3, fence, 0);
            b.set(ru + 4, y0 + 1, rv + 3, fence, 0);
            b.torch(ru + 2, y0 + 2, rv + 3, 0);
            if (b.primary) b.mob(ru + 3, y0 + 1, rv + 5, f === 0 ? 'vindicator' : 'evoker');
            break;
          }
        }
        if (b.primary && !secret && b.prand(ru + 2, y0 + 4, rv + 2) > 0.7) {
          b.mob(ru + 3, y0 + 1, rv + 3, b.prand(ru, y0, rv) > 0.5 ? 'vindicator' : 'evoker');
        }
      }
    }

    // Grand staircase in the middle column of the plan.
    if (f < floors - 1) {
      const su = CW * 2 + 1, sv = CD + 1;
      b.fill(su, y0 + 1, sv, su + 4, y0 + 6, sv + 4, AIR, 0);
      for (let k = 0; k < 5; k++) {
        b.fill(su, y0 + 1 + k, sv + k, su + 4, y0 + 1 + k, sv + k, stairs, b.hf(2));
        b.fill(su, y0 + k, sv + k, su + 4, y0 + k, sv + k, plank, 0);
      }
      b.fill(su, y0 + 6, sv, su + 4, y0 + 6, sv + 3, AIR, 0);
    }
  }

  // Entrance porch.
  const eu = W >> 1;
  b.fill(eu - 1, 1, 0, eu + 1, 3, 0, AIR, 0);
  b.door(eu, 1, 0, 0, 'dark_oak_door');
  b.door(eu - 1, 1, 0, 0, 'dark_oak_door');
  b.set(eu + 1, 1, 0, plank, 0);
  b.fill(eu - 2, 0, -2, eu + 2, 0, -1, cob, 0);
  b.fill(eu - 2, 1, -2, eu - 2, 3, -2, log, 0);
  b.fill(eu + 2, 1, -2, eu + 2, 3, -2, log, 0);
  b.fill(eu - 2, 4, -2, eu + 2, 4, 0, slab, 0);
  b.torch(eu - 2, 3, -1, 3);
  b.torch(eu + 2, 3, -1, 1);

  // Roofs: a flat leaded deck with a stair parapet on every storey step.
  const cap = (u0, v0, u1, v1, y) => {
    b.fill(u0, y, v0, u1, y, v1, plank, 0);
    b.fill(u0 - 1, y + 1, v0 - 1, u1 + 1, y + 1, v0 - 1, stairs, b.hf(0));
    b.fill(u0 - 1, y + 1, v1 + 1, u1 + 1, y + 1, v1 + 1, stairs, b.hf(2));
    b.fill(u0 - 1, y + 1, v0, u0 - 1, y + 1, v1, stairs, b.hf(3));
    b.fill(u1 + 1, y + 1, v0, u1 + 1, y + 1, v1, stairs, b.hf(1));
    b.fill(u0, y + 1, v0, u1, y + 1, v1, slab, 0);
  };
  if (floors >= 3) {
    cap(0, 0, W - 1, D - 1, 12);
    cap(CW, 0, W - CW - 1, D - CD - 1, 18);
  } else {
    cap(0, 0, W - 1, D - 1, floors * 6);
  }

  if (b.primary) {
    b.mob(eu, 1, 4, 'vindicator');
    b.mob(eu + 3, 1, 8, 'vindicator');
    b.mob(eu - 3, 7, 8, 'evoker');
  }
};

registerStructure('woodland_mansion', {
  spacing: 80, separation: 20, salt: 0x0a51, dimension: DIM_OVERWORLD,
  biomes: ['dark_forest'],
  generate(world, cx, cz) {
    const bx = (cx << 4) - 8, bz = (cz << 4) - 6;
    const g = surveyGround(world, bx, bz, bx + 35, bz + 28, 4);
    if (g.spread > 14 || g.avg <= SEA_LEVEL) return;
    emitPieces(world, [piece('woodland_mansion', bx, g.avg, bz, 0, -3, -3, 37, 30,
      { floors: 3 })]);
  },
});

// ===========================================================================
// NETHER FORTRESS
// ===========================================================================
PIECES.nf_bridge = (b) => {
  const nb = bid('nether_bricks'), fence = bid('nether_brick_fence');
  const stairs = bid('nether_brick_stairs'), len = b.o.len;
  b.fill(-2, 0, -2, len - 1, 4, 2, AIR, 0);
  b.fill(-2, -1, -2, len - 1, -1, 2, nb, 0);
  b.fill(-2, 0, -2, len - 1, 1, -2, fence, 0);
  b.fill(-2, 0, 2, len - 1, 1, 2, fence, 0);
  // Piers reaching down toward the lava sea every few blocks.
  for (let u = 0; u < len; u += 5) {
    b.fill(u, -2, -2, u, -6, -2, nb, 0);
    b.fill(u, -2, 2, u, -6, 2, nb, 0);
    b.set(u, 2, -2, nb, 0);
    b.set(u, 2, 2, nb, 0);
    b.stair(u, 2, -1, 'nether_brick_stairs', 2);
    b.stair(u, 2, 1, 'nether_brick_stairs', 0);
  }
  if (b.o.fire) b.set(len >> 1, 0, 0, bid('fire'), 0);
};

PIECES.nf_corridor = (b) => {
  const nb = bid('nether_bricks'), len = b.o.len;
  b.fill(-2, -1, -2, len - 1, 5, 2, nb, 0);
  b.fill(0, 0, -1, len - 1, 3, 1, AIR, 0);
  for (let u = 1; u < len; u += 4) {
    b.set(u, 2, -2, bid('nether_brick_fence'), 0);
    b.set(u, 2, 2, bid('nether_brick_fence'), 0);
  }
  if (b.o.chest) b.chest(len - 2, 0, 1, 0, 'nether_bridge');
  if (b.primary && b.o.mobs) {
    b.mob(1, 0, 0, 'wither_skeleton');
    b.mob(len - 2, 0, 0, 'zombified_piglin');
  }
};

PIECES.nf_blaze = (b) => {
  const nb = bid('nether_bricks'), fence = bid('nether_brick_fence');
  b.fill(-1, -1, -1, 9, 8, 9, AIR, 0);
  b.fill(-1, -1, -1, 9, -1, 9, nb, 0);
  b.walls(-1, 0, -1, 9, 6, 9, fence, 0);
  b.fill(-1, 7, -1, 9, 7, 9, nb, 0);
  // Stepped podium with the spawner on top.
  b.fill(2, 0, 2, 6, 0, 6, nb, 0);
  b.fill(3, 1, 3, 5, 1, 5, nb, 0);
  b.spawner(4, 2, 4, 'blaze');
  b.fill(0, 0, 4, 0, 2, 5, AIR, 0);
  b.chest(1, 0, 8, 2, 'nether_bridge');
  b.set(8, 0, 1, bid('fire'), 0);
  if (b.primary) { b.mob(2, 1, 7, 'blaze'); b.mob(7, 1, 2, 'blaze'); }
};

PIECES.nf_wart = (b) => {
  const nb = bid('nether_bricks'), soul = bid('soul_sand'), wart = bid('nether_wart');
  b.fill(-1, -1, -1, 11, 6, 9, nb, 0);
  b.fill(0, 0, 0, 10, 4, 8, AIR, 0);
  for (let j = 0; j < 2; j++) {
    const v = 1 + j * 4;
    b.fill(1, -1, v, 9, -1, v + 2, soul, 0);
    for (let vv = v; vv < v + 3; vv++) {
      for (let u = 1; u <= 9; u++) {
        if (b.prand(u, 0, vv) < 0.8) b.set(u, 0, vv, wart, Math.floor(b.prand(u, 1, vv) * 4));
      }
    }
  }
  b.fill(0, 0, 4, 10, 2, 4, AIR, 0);
  b.chest(5, 0, 0, 0, 'nether_bridge');
  b.chest(9, 0, 8, 2, 'nether_bridge');
  b.set(0, 3, 4, bid('nether_brick_fence'), 0);
  if (b.primary) b.mob(5, 1, 4, 'wither_skeleton');
};

PIECES.nf_stairs = (b) => {
  const nb = bid('nether_bricks'), drop = b.o.drop;
  b.fill(-2, -drop - 1, -2, 6, 5, 2, nb, 0);
  for (let k = 0; k <= drop; k++) {
    b.fill(0, -k, -1, 1, -k + 3, 1, AIR, 0);
    b.fill(0, -k - 1, -1, 1, -k - 1, 1, nb, 0);
    b.stair(0, -k, 0, 'nether_brick_stairs', 1);
  }
  b.fill(2, -drop, -1, 6, -drop + 3, 1, AIR, 0);
};

registerStructure('nether_fortress', {
  spacing: 27, separation: 4, salt: 0xf027, dimension: DIM_NETHER, biomes: null,
  generate(world, cx, cz, rng) {
    const bx = (cx << 4) + 8, bz = (cz << 4) + 8;
    let y = rng.range(48, 68);
    const out = [];
    let ends = [{ x: bx, y, z: bz, dir: rng.int(4), depth: 0 }];
    let budget = 30, blaze = 0, wart = 0;
    while (ends.length && budget > 0) {
      const e = ends.shift();
      if (e.depth > 6) continue;
      const rot = rotForDir(e.dir);
      const roll = rng.next();
      const step = (n, d, dep) => ends.push({ x: e.x + HDX[d] * n, y: e.y, z: e.z + HDZ[d] * n, dir: d, depth: dep });
      if (roll < 0.40) {
        const len = rng.range(8, 14);
        out.push(piece('nf_bridge', e.x, e.y, e.z, rot, -3, -3, len, 3,
          { len, fire: rng.chance(0.3) }));
        step(len, e.dir, e.depth + 1);
        if (rng.chance(0.3)) step(len, (e.dir + 1) & 3, e.depth + 1);
      } else if (roll < 0.62) {
        const len = rng.range(7, 12);
        out.push(piece('nf_corridor', e.x, e.y, e.z, rot, -3, -3, len, 3,
          { len, chest: rng.chance(0.35), mobs: rng.chance(0.5) }));
        step(len, e.dir, e.depth + 1);
        if (rng.chance(0.35)) step(len - 2, (e.dir + 3) & 3, e.depth + 1);
      } else if (roll < 0.74 && blaze < 2) {
        out.push(piece('nf_blaze', e.x, e.y, e.z, rot, -2, -2, 10, 10));
        blaze++; budget -= 2;
        step(10, e.dir, e.depth + 1);
      } else if (roll < 0.86 && wart < 2) {
        out.push(piece('nf_wart', e.x, e.y, e.z, rot, -2, -2, 12, 10));
        wart++; budget -= 2;
        step(12, e.dir, e.depth + 1);
      } else {
        const drop = rng.range(4, 8);
        if (e.y - drop < 36) { step(6, e.dir, e.depth + 1); budget--; continue; }
        out.push(piece('nf_stairs', e.x, e.y, e.z, rot, -3, -3, 7, 3, { drop }));
        ends.push({ x: e.x + HDX[e.dir] * 6, y: e.y - drop, z: e.z + HDZ[e.dir] * 6, dir: e.dir, depth: e.depth + 1 });
      }
      budget--;
    }
    emitPieces(world, out);
  },
});

// ===========================================================================
// BASTION REMNANT
// ===========================================================================
PIECES.bastion_remnant = (b) => {
  const bs = bid('blackstone'), pol = bid('polished_blackstone');
  const pbb = bid('polished_blackstone_bricks'), gild = bid('gilded_blackstone');
  const basalt = bid('basalt'), chain = bid('chain');
  const MIX = [[bs, 0, 8], [pol, 0, 5], [pbb, 0, 5], [bid('cracked_polished_blackstone_bricks'), 0, 3],
    [gild, 0, 1]];
  const W = 21, D = 21;

  // Rampart platform, eroded at the edges.
  for (let v = 0; v < D; v++) {
    for (let u = 0; u < W; u++) {
      const edge = Math.min(u, v, W - 1 - u, D - 1 - v);
      if (edge === 0 && b.prand(u, 0, v) < 0.45) continue;
      b.fill(u, -6, v, u, 0, v, bs, 0);
      b.set(u, 0, v, b.prand(u, 1, v) < 0.12 ? gild : pol, 0);
    }
  }
  b.fillMix(1, 1, 1, W - 2, 1, D - 2, [[pbb, 0, 6], [pol, 0, 4], [-1, 0, 3]]);
  b.fill(2, 2, 2, W - 3, 7, D - 3, AIR, 0);
  // Outer wall with crenellations.
  b.walls(1, 2, 1, W - 2, 6, D - 2, pbb, 0);
  for (let u = 1; u < W - 1; u += 2) {
    b.set(u, 7, 1, pol, 0);
    b.set(u, 7, D - 2, pol, 0);
  }
  for (let v = 1; v < D - 1; v += 2) {
    b.set(1, 7, v, pol, 0);
    b.set(W - 2, 7, v, pol, 0);
  }
  b.fill(W >> 1, 2, 1, (W >> 1) + 1, 4, 1, AIR, 0);
  // Basalt columns holding a bridge across the courtyard.
  for (const u of [5, W - 6]) {
    b.fill(u, 2, 5, u, 9, 5, basalt, 0);
    b.fill(u, 2, D - 6, u, 9, D - 6, basalt, 0);
    b.set(u, 10, 5, chain, 0);
  }
  b.fill(5, 9, 5, W - 6, 9, D - 6, pbb, 0);
  b.fill(6, 10, 6, W - 7, 10, D - 7, AIR, 0);
  // Treasure hoard: gold blocks under a gilded floor.
  b.fill(8, 2, 8, 12, 2, 12, gild, 0);
  b.fill(9, 3, 9, 11, 4, 11, bid('gold_block'), 0);
  b.chest(8, 3, 8, 0, 'bastion_treasure');
  b.chest(12, 3, 12, 2, 'bastion_treasure');
  b.chest(3, 2, 3, 0, 'bastion_other');
  b.chest(W - 4, 2, D - 4, 2, 'bastion_other');
  b.set(4, 2, D - 4, bid('lodestone'), 0);
  b.set(10, 10, 10, bid('magma_block'), 0);
  b.set(3, 3, 3, bid('soul_lantern'), 0);
  // Hoglin stable pen.
  b.fill(14, 2, 3, 18, 2, 7, bid('soul_soil'), 0);
  b.walls(14, 3, 3, 18, 4, 7, bid('polished_blackstone_brick_wall'), 0);
  if (b.primary) {
    b.mob(10, 3, 4, 'piglin');
    b.mob(6, 3, 12, 'piglin');
    b.mob(W - 6, 3, 8, 'piglin_brute');
    b.mob(10, 11, 10, 'piglin');
    b.mob(16, 3, 5, 'hoglin');
  }
};

registerStructure('bastion_remnant', {
  spacing: 27, separation: 4, salt: 0xba57, dimension: DIM_NETHER, biomes: null,
  generate(world, cx, cz, rng) {
    const bx = (cx << 4) - 2, bz = (cz << 4) - 2;
    const y = clamp(rng.range(52, 74), 40, 100);
    emitPieces(world, [piece('bastion_remnant', bx, y, bz, rng.int(4), -1, -1, 22, 22)]);
  },
});

// ===========================================================================
// END CITY (+ SHIP) AND THE OBSIDIAN PILLARS
// ===========================================================================
PIECES.ec_tower = (b) => {
  const pur = bid('purpur_block'), pil = bid('purpur_pillar');
  const stairs = bid('purpur_stairs'), rod = bid('end_rod');
  const wall = bid('end_stone_bricks');
  const levels = b.o.levels;
  b.fill(0, -8, 0, 10, -1, 10, wall, 0);         // plinth into the island
  for (let f = 0; f < levels; f++) {
    const y0 = f * 5;
    b.fill(0, y0, 0, 10, y0, 10, pur, 0);
    b.walls(0, y0 + 1, 0, 10, y0 + 4, 10, pur, 0);
    b.fill(1, y0 + 1, 1, 9, y0 + 4, 9, AIR, 0);
    for (const [u, v] of [[0, 0], [10, 0], [0, 10], [10, 10]]) b.fill(u, y0 + 1, v, u, y0 + 4, v, pil, 0);
    // Windows.
    b.fill(5, y0 + 2, 0, 5, y0 + 3, 0, AIR, 0);
    b.fill(5, y0 + 2, 10, 5, y0 + 3, 10, AIR, 0);
    b.fill(0, y0 + 2, 5, 0, y0 + 3, 5, AIR, 0);
    b.fill(10, y0 + 2, 5, 10, y0 + 3, 5, AIR, 0);
    // Interior stair up to the next level.
    b.fill(2, y0 + 5, 2, 4, y0 + 5, 4, AIR, 0);
    for (let k = 0; k < 4; k++) b.stair(2 + k, y0 + 1 + k, 2, 'purpur_stairs', 1);
    b.set(1, y0 + 1, 9, rod, 0);
    b.set(9, y0 + 1, 1, rod, 0);
    if (f > 0) b.chest(8, y0 + 1, 8, 2, 'end_city_treasure');
    if (b.primary) b.mob(5, y0 + 1, 5, 'shulker');
  }
  // Crown.
  const ty = levels * 5;
  b.fill(0, ty, 0, 10, ty, 10, pur, 0);
  b.fill(-1, ty + 1, -1, 11, ty + 1, -1, stairs, b.hf(0));
  b.fill(-1, ty + 1, 11, 11, ty + 1, 11, stairs, b.hf(2));
  b.fill(-1, ty + 1, 0, -1, ty + 1, 10, stairs, b.hf(3));
  b.fill(11, ty + 1, 0, 11, ty + 1, 10, stairs, b.hf(1));
  b.set(5, ty + 1, 5, rod, 0);
  b.chest(3, ty + 1, 3, 0, 'end_city_treasure');
  if (b.primary) b.mob(5, ty + 1, 5, 'shulker');
};

PIECES.ec_ship = (b) => {
  const pur = bid('purpur_block'), pil = bid('purpur_pillar');
  const stairs = bid('purpur_stairs'), slab = bid('purpur_slab');
  const rod = bid('end_rod'), bricks = bid('end_stone_bricks');
  const L = 22, Wd = 9;
  // Hull.
  for (let u = 0; u < L; u++) {
    const taper = u < 4 ? 4 - u : (u > L - 5 ? u - (L - 5) : 0);
    const v0 = taper, v1 = Wd - 1 - taper;
    if (v0 > v1) continue;
    b.fill(u, 0, v0, u, 0, v1, pur, 0);
    b.fill(u, 1, v0, u, 3, v0, pur, 0);
    b.fill(u, 1, v1, u, 3, v1, pur, 0);
    b.fill(u, 4, v0, u, 4, v1, pur, 0);
    b.fill(u, 1, v0 + 1, u, 3, v1 - 1, AIR, 0);
  }
  b.fill(2, 4, 2, L - 3, 4, Wd - 3, AIR, 0);
  b.fill(2, 4, 2, L - 3, 4, Wd - 3, pur, 0);
  // Deck rail and mast.
  for (let u = 1; u < L - 1; u += 2) {
    b.set(u, 5, 1, slab, 0);
    b.set(u, 5, Wd - 2, slab, 0);
  }
  b.fill(11, 5, 4, 11, 14, 4, pil, 0);
  b.fill(9, 12, 4, 13, 12, 4, pur, 0);
  b.set(11, 15, 4, rod, 0);
  // Stern cabin with the treasure and the elytra.
  b.fill(L - 7, 5, 2, L - 2, 9, Wd - 3, pur, 0);
  b.fill(L - 6, 5, 3, L - 3, 8, Wd - 4, AIR, 0);
  b.chest(L - 4, 5, 3, 2, 'end_city_treasure');
  b.set(L - 6, 5, 3, bid('brewing_stand'), 0);
  b.set(L - 5, 5, 3, bid('purpur_slab'), 0);
  // The elytra hangs on the back wall of the cabin.
  const ex = b.wx(L - 5, Wd - 4), ez = b.wz(L - 5, Wd - 4), ey = b.oy + 6;
  if (ex >= b.minX && ex <= b.maxX && ez >= b.minZ && ez <= b.maxZ) {
    b.world.setBlock(ex, ey, ez, bid('chest'), b.hf(0), b.flags);
    const be = b.world.getBlockEntity(ex, ey, ez);
    if (be) {
      const items = new Array(27).fill(null);
      items[13] = { item: 'elytra', count: 1, damage: 0 };
      be.items = items;
      be.display = 'item_frame';
      be.frameItem = { item: 'elytra', count: 1, damage: 0 };
    }
  }
  // Two dragon-head towers on the prow.
  for (const v of [2, Wd - 3]) {
    b.fill(1, 5, v, 1, 8, v, pil, 0);
    b.set(1, 9, v, bid('dragon_head'), 0);
    b.set(2, 7, v, stairs, b.hf(1));
  }
  b.fill(0, -3, 0, 0, -1, Wd - 1, bricks, 0);
  if (b.primary) {
    b.mob(L - 5, 6, 4, 'shulker');
    b.mob(4, 5, 4, 'shulker');
  }
};

registerStructure('end_city', {
  spacing: 20, separation: 11, salt: 0xe0c1, dimension: DIM_END,
  biomes: ['end_highlands', 'end_midlands'],
  generate(world, cx, cz, rng) {
    const bx = (cx << 4) + 2, bz = (cz << 4) + 2;
    const g = surveyGround(world, bx, bz, bx + 11, bz + 11, 3);
    if (g.avg < 12 || g.spread > 6) return;      // needs solid island under it
    const out = [];
    const levels = rng.range(2, 4);
    out.push(piece('ec_tower', bx, g.avg, bz, rng.int(4), -2, -2, 12, 12, { levels }));
    // Satellite towers, and one ship moored off the tallest one.
    const n = rng.range(1, 3);
    for (let i = 0; i < n; i++) {
      const d = rng.int(4);
      const tx = bx + HDX[d] * 14, tz = bz + HDZ[d] * 14;
      const tg = surveyGround(world, tx, tz, tx + 11, tz + 11, 3);
      if (tg.avg < 12 || tg.spread > 8) continue;
      out.push(piece('ec_tower', tx, tg.avg, tz, rng.int(4), -2, -2, 12, 12,
        { levels: rng.range(1, 3) }));
    }
    const sd = rng.int(4);
    out.push(piece('ec_ship', bx + HDX[sd] * 16, g.avg + levels * 5 - 4, bz + HDZ[sd] * 16,
      rng.int(4), -1, -1, 23, 10));
    emitPieces(world, out);
  },
});

PIECES.end_pillar = (b) => {
  const obs = bid('obsidian'), bars = bid('iron_bars');
  const r = b.o.r, h = b.o.h;
  for (let y = -6; y <= h; y++) {
    for (let v = -r; v <= r; v++) {
      for (let u = -r; u <= r; u++) {
        if (u * u + v * v > r * r + r * 0.5) continue;
        b.set(u, y, v, obs, 0);
      }
    }
  }
  b.set(0, h + 1, 0, bid('bedrock'), 0);
  if (b.o.caged) {
    // Iron-bar cage around the crystal, like the taller pillars have.
    for (let v = -1; v <= 1; v++) {
      for (let u = -1; u <= 1; u++) {
        if (u === 0 && v === 0) continue;
        b.fill(u, h + 1, v, u, h + 4, v, bars, 0);
      }
    }
    b.fill(-1, h + 5, -1, 1, h + 5, 1, bars, 0);
  }
  if (b.primary) b.mob(0, h + 2, 0, 'end_crystal', { beamTarget: true });
};

registerStructure('obsidian_pillars', {
  spacing: 4096, separation: 1, salt: 0x0b51, dimension: DIM_END, fixed: [0, 0], biomes: null,
  generate(world, cx, cz, rng) {
    const out = [];
    for (let i = 0; i < 10; i++) {
      const a = (i / 10) * Math.PI * 2;
      const dist = 43;
      const px = Math.round(Math.cos(a) * dist), pz = Math.round(Math.sin(a) * dist);
      const base = surfaceY(world, px, pz);
      const h = 22 + ((i * 7) % 4) * 4;
      const r = 2 + (i % 3);
      out.push(piece('end_pillar', px, clamp(base, 30, 70), pz, 0, -r - 1, -r - 1, r + 1, r + 1,
        { r, h: Math.min(h, WORLD_HEIGHT - 12 - base), caged: i % 3 === 0 }));
    }
    emitPieces(world, out);
  },
});

/** Every registered structure name, in placement-priority order. */
export const STRUCTURE_NAMES = [];
for (const name of STRUCTURES.keys()) STRUCTURE_NAMES.push(name);

export default STRUCTURES;
