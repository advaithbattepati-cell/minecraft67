// ============================================================================
// blockupdate.js - Everything that makes the world move on its own.
//
// Five entry points, all called by world.js (see CONTRACT.md section 9):
//
//   neighborUpdate()  a neighbour changed: re-check support, fire, portals
//   randomTick()      ~3 blocks per subchunk per tick: growth, decay, weather
//   scheduledTick()   a queued tick came due: fluids, gravity, buttons
//   tickWorldBlocks() the per-tick driver: budgets, entity pushes, snowfall
//   onBlockPlaced() / onBlockBroken() / useBlock()
//
// Fluid metadata follows the mesher's convention exactly:
//   level  = meta & 7   (0 = source, 1..7 = flowing, higher number = thinner)
//   falling = meta & 8          (a falling column, always rendered full height)
//
// Nothing here reads `Game.*` at module scope, and every cross-module call is
// guarded so half-finished siblings cannot blank the screen.
// ============================================================================

import {
  WORLD_HEIGHT, ID_MASK, SEA_LEVEL,
  FACE_DIRS, FACE_DOWN,
  HFACE_DIRS, DIM_OVERWORLD, DIM_NETHER, DIM_END,
} from '../core/constants.js';
import { clamp } from '../core/util.js';
import { Game } from '../core/game.js';
import {
  BLOCKS, blockByName, getBlock,
  isSolid as blockIsSolid,
} from './blocks.js';
import { getItem } from '../item/items.js';
import {
  stack as mkStack, isEmpty, damageStack, giveOrDrop, copyStack, maxStackSize,
} from '../item/inventory.js';
import { blockDrops } from '../item/loot.js';
import { smeltResult, smeltXp, fuelTicks, fuelRemainder, KIND_TIME } from '../item/smelting.js';

const flr = Math.floor;

// ---------------------------------------------------------------------------
// Lazily-resolved siblings. Entity-heavy modules stay out of the static graph
// so this file can also be imported by tooling that has no DOM.
// ---------------------------------------------------------------------------
let _itementity = null;
let _combat = null;
let _features = null;
let _mobs = null;
let _depsStarted = false;

function loadDeps() {
  if (_depsStarted) return;
  _depsStarted = true;
  const grab = (path, assign) => {
    try { import(path).then(assign).catch(() => { /* optional */ }); } catch { /* no dynamic import */ }
  };
  grab('../entity/itementity.js', (m) => { _itementity = m; });
  grab('../entity/combat.js', (m) => { _combat = m; });
  grab('./features.js', (m) => { _features = m; });
  grab('../entity/mobs.js', (m) => { _mobs = m; });
}
loadDeps();

// ---------------------------------------------------------------------------
// Tiny helpers
// ---------------------------------------------------------------------------

const _idCache = new Map();
/** Numeric id for a block name (0 when the block does not exist). */
function bid(name) {
  let v = _idCache.get(name);
  if (v === undefined) {
    const d = blockByName(name);
    v = d ? d.id : 0;
    _idCache.set(name, v);
  }
  return v;
}
/** Registry name of a block id. */
function bname(id) { return getBlock(id).name; }
function playAt(world, x, y, z, name, volume = 1, pitch = 1) {
  const a = Game.audio;
  if (!a) return;
  try {
    if (a.playAt) a.playAt(name, x + 0.5, y + 0.5, z + 0.5, volume, pitch);
    else if (a.play) a.play(name, { volume, pitch, x: x + 0.5, y: y + 0.5, z: z + 0.5 });
  } catch { /* audio is optional */ }
}

function particlesAt(type, x, y, z, opts) {
  const p = Game.particles;
  if (!p || !p.spawn) return;
  try { p.spawn(type, x, y, z, opts || {}); } catch { /* optional */ }
}

/** Sound group name a block uses for dig/place/step. */
function soundGroup(def) { return def && def.sound ? def.sound : 'stone'; }

/** Drops one item stack into the world as an entity (falls back to nothing). */
function spawnStack(world, x, y, z, s) {
  if (!s || !s.item || s.count <= 0) return;
  if (_itementity && _itementity.dropItem) {
    try { _itementity.dropItem(world, x, y, z, s, 0, 0.12, 0); return; } catch { /* fall through */ }
  }
}

/** Drops a plain item by name. */
function dropNamed(world, x, y, z, item, count = 1) {
  if (!item || count <= 0) return;
  spawnStack(world, x + 0.5, y + 0.5, z + 0.5, mkStack(item, count));
}

/** Loot-table drops for a block, guarded. */
function naturalDrops(world, x, y, z, id, meta) {
  if (!world.gameRules || world.gameRules.doTileDrops === false) return [];
  try {
    const out = blockDrops(world, x, y, z, id, meta, null, null);
    return out || [];
  } catch {
    const d = getBlock(id);
    return typeof d.drops === 'string' ? [mkStack(d.drops, 1)] : [];
  }
}

/**
 * Removes a block the way the world would: drops, particles, sound.
 * Used by fluids, support checks, fire and leaf decay.
 */
function breakNaturally(world, x, y, z, drop = true) {
  const raw = world.getRaw(x, y, z);
  const id = raw & ID_MASK;
  if (id === 0) return false;
  const meta = (raw >>> 12) & 15;
  const def = getBlock(id);
  if (drop) {
    const stacks = naturalDrops(world, x, y, z, id, meta);
    for (let i = 0; i < stacks.length; i++) spawnStack(world, x + 0.5, y + 0.5, z + 0.5, stacks[i]);
  }
  dropContainerContents(world, x, y, z);
  const p = Game.particles;
  if (p && p.blockBreak) { try { p.blockBreak(x, y, z, id); } catch { /* optional */ } }
  playAt(world, x, y, z, 'dig_' + soundGroup(def), 0.7, 0.9);
  world.setBlock(x, y, z, 0, 0, 3);
  return true;
}

/** True when this block has no collision at all (plants, torches, rails, dust). */
function isFlimsy(def) {
  if (!def || def.air) return false;
  if (def.liquid) return false;
  return !def.solid || def.collision === 'none';
}

/** True when a fluid may wash this block away. */
function fluidCanDestroy(world, x, y, z, def) {
  return isFlimsy(def) && def.hardness >= 0;
}

/**
 * Blocks that Minecraft waterlogs instead of washing away: an ocean plant shares
 * its cell with the water around it. We have no general waterlogging, so water
 * treats these cells as already full - it neither fills nor destroys them, but
 * still flows through. Without this every water update eats the kelp forest it
 * is standing in, which drops thousands of items and buries the tick budget.
 */
let WATERLOGGED = null;
function waterloggedIds() {
  if (WATERLOGGED) return WATERLOGGED;
  WATERLOGGED = new Set();
  for (const d of BLOCKS) {
    if (!d) continue;
    const n = d.name;
    const aquatic = n === 'kelp' || n === 'kelp_plant' || n === 'seagrass' || n === 'tall_seagrass'
      || n === 'sea_pickle' || n === 'bubble_column'
      || (!n.startsWith('dead_') && (n.endsWith('_coral') || n.endsWith('_coral_fan') || n.endsWith('_coral_wall_fan')));
    if (aquatic) WATERLOGGED.add(d.id);
  }
  return WATERLOGGED;
}
/** True when this block already contains water and must not be flooded. */
function holdsWater(id) { return waterloggedIds().has(id); }

// ---------------------------------------------------------------------------
// Cached block-id sets, built on first use so blocks.js is fully registered.
// ---------------------------------------------------------------------------

let ID = null;
function ids() {
  if (ID) return ID;
  ID = {
    air: 0,
    water: bid('water'),
    lava: bid('lava'),
    fire: bid('fire'),
    soul_fire: bid('soul_fire'),
    stone: bid('stone'),
    cobblestone: bid('cobblestone'),
    obsidian: bid('obsidian'),
    basalt: bid('basalt'),
    dirt: bid('dirt'),
    grass_block: bid('grass_block'),
    farmland: bid('farmland'),
    dirt_path: bid('dirt_path'),
    podzol: bid('podzol'),
    mycelium: bid('mycelium'),
    sand: bid('sand'),
    red_sand: bid('red_sand'),
    snow: bid('snow'),
    snow_block: bid('snow_block'),
    ice: bid('ice'),
    frosted_ice: bid('frosted_ice'),
    packed_ice: bid('packed_ice'),
    netherrack: bid('netherrack'),
    magma_block: bid('magma_block'),
    soul_sand: bid('soul_sand'),
    soul_soil: bid('soul_soil'),
    cactus: bid('cactus'),
    sugar_cane: bid('sugar_cane'),
    bamboo: bid('bamboo'),
    bamboo_sapling: bid('bamboo_sapling'),
    kelp: bid('kelp'),
    kelp_plant: bid('kelp_plant'),
    vine: bid('vine'),
    cocoa: bid('cocoa'),
    nether_wart: bid('nether_wart'),
    sweet_berry_bush: bid('sweet_berry_bush'),
    chorus_flower: bid('chorus_flower'),
    chorus_plant: bid('chorus_plant'),
    end_stone: bid('end_stone'),
    melon: bid('melon'),
    pumpkin: bid('pumpkin'),
    melon_stem: bid('melon_stem'),
    pumpkin_stem: bid('pumpkin_stem'),
    attached_melon_stem: bid('attached_melon_stem'),
    attached_pumpkin_stem: bid('attached_pumpkin_stem'),
    turtle_egg: bid('turtle_egg'),
    budding_amethyst: bid('budding_amethyst'),
    small_amethyst_bud: bid('small_amethyst_bud'),
    medium_amethyst_bud: bid('medium_amethyst_bud'),
    large_amethyst_bud: bid('large_amethyst_bud'),
    amethyst_cluster: bid('amethyst_cluster'),
    sculk: bid('sculk'),
    sculk_vein: bid('sculk_vein'),
    sculk_catalyst: bid('sculk_catalyst'),
    pointed_dripstone: bid('pointed_dripstone'),
    cauldron: bid('cauldron'),
    water_cauldron: bid('water_cauldron'),
    lava_cauldron: bid('lava_cauldron'),
    powder_snow_cauldron: bid('powder_snow_cauldron'),
    powder_snow: bid('powder_snow'),
    composter: bid('composter'),
    tnt: bid('tnt'),
    nether_portal: bid('nether_portal'),
    flower_pot: bid('flower_pot'),
    cake: bid('cake'),
    jukebox: bid('jukebox'),
    note_block: bid('note_block'),
    lectern: bid('lectern'),
    bell: bid('bell'),
    campfire: bid('campfire'),
    soul_campfire: bid('soul_campfire'),
    respawn_anchor: bid('respawn_anchor'),
    dragon_egg: bid('dragon_egg'),
    moss_block: bid('moss_block'),
    clay: bid('clay'),
    mud: bid('mud'),
    glass: bid('glass'),
    hay_block: bid('hay_block'),
    cave_vines: bid('cave_vines'),
    cave_vines_plant: bid('cave_vines_plant'),
    twisting_vines: bid('twisting_vines'),
    twisting_vines_plant: bid('twisting_vines_plant'),
    weeping_vines: bid('weeping_vines'),
    weeping_vines_plant: bid('weeping_vines_plant'),
    brown_mushroom: bid('brown_mushroom'),
    red_mushroom: bid('red_mushroom'),
    lily_pad: bid('lily_pad'),
  };
  return ID;
}

let LOG_IDS = null, LEAF_IDS = null, SOIL_IDS = null;
let NEEDS_SUPPORT = null, INFINIBURN = null;

function sets() {
  if (LOG_IDS) return;
  LOG_IDS = new Set();
  LEAF_IDS = new Set();
  SOIL_IDS = new Set();
  INFINIBURN = new Set();
  NEEDS_SUPPORT = new Uint8Array(BLOCKS.length);

  for (let i = 0; i < BLOCKS.length; i++) {
    const d = BLOCKS[i];
    if (!d) continue;
    const n = d.name;
    if (/_log$|_wood$|_stem$|_hyphae$/.test(n) && n !== 'bamboo_stem') LOG_IDS.add(i);
    if (n === 'mangrove_roots' || n === 'muddy_mangrove_roots') LOG_IDS.add(i);
    if (/_leaves$/.test(n)) LEAF_IDS.add(i);
    if (SUPPORT_MODELS.has(d.model) || SUPPORT_NAMES.has(n)) NEEDS_SUPPORT[i] = 1;
  }
  for (const n of ['dirt', 'grass_block', 'coarse_dirt', 'rooted_dirt', 'podzol', 'mycelium',
    'farmland', 'dirt_path', 'moss_block', 'mud', 'muddy_mangrove_roots', 'clay']) {
    const v = bid(n); if (v) SOIL_IDS.add(v);
  }
  for (const n of ['netherrack', 'magma_block']) {
    const v = bid(n); if (v) INFINIBURN.add(v);
  }
}

/** Models whose blocks fall off when their support disappears. */
const SUPPORT_MODELS = new Set([
  'cross', 'crop', 'torch', 'ladder', 'rail', 'flat', 'vine', 'layer', 'carpet',
  'sign', 'wall_sign', 'button', 'lever', 'skull', 'pot', 'door', 'bed', 'cactus',
]);
const SUPPORT_NAMES = new Set([
  'snow', 'sugar_cane', 'cactus', 'bamboo', 'bamboo_sapling', 'kelp', 'kelp_plant',
  'chorus_flower', 'chorus_plant', 'sea_pickle', 'lily_pad', 'turtle_egg', 'sniffer_egg',
  'nether_wart', 'cocoa', 'sweet_berry_bush', 'cave_vines', 'cave_vines_plant',
  'twisting_vines', 'twisting_vines_plant', 'weeping_vines', 'weeping_vines_plant',
  'hanging_roots', 'glow_lichen', 'sculk_vein', 'big_dripleaf_stem', 'small_dripleaf',
  'redstone_wire', 'repeater', 'comparator', 'tripwire', 'cake', 'moss_carpet',
]);

// ---------------------------------------------------------------------------
// Per-tick budgeting
// ---------------------------------------------------------------------------

const FLUID_BUDGET = 768;        // fluid spread steps per world tick

let _fluidWork = 0;
let _beSweep = 0;
let _snowTimer = 0;

// ---------------------------------------------------------------------------
// Block-entity shadow map.
//
// world.setBlock() drops the block-entity record before onBlockBroken() runs,
// so the container contents would be gone by the time we could spill them.
// Holding a *reference* to the record keeps them reachable: nothing copies it,
// so it still carries whatever the screen last put in it.
// ---------------------------------------------------------------------------
const _beShadow = new Map();
const BE_SHADOW_MAX = 4096;

function beKey(x, y, z) { return x + ',' + y + ',' + z; }

/** Remembers a block entity so its contents survive the block being removed. */
function rememberBlockEntity(world, x, y, z) {
  let be;
  try { be = world.getBlockEntity(x, y, z); } catch { return null; }
  if (!be) return null;
  if (_beShadow.size > BE_SHADOW_MAX) _beShadow.clear();
  _beShadow.set(beKey(x, y, z), be);
  return be;
}

/** The live or last-seen block entity at a position. */
function knownBlockEntity(world, x, y, z) {
  let be = null;
  try { be = world.getBlockEntity(x, y, z); } catch { /* ignore */ }
  return be || _beShadow.get(beKey(x, y, z)) || null;
}

/** Spills a container's contents on the ground, once. */
function dropContainerContents(world, x, y, z) {
  const be = knownBlockEntity(world, x, y, z);
  _beShadow.delete(beKey(x, y, z));
  if (!be || !be.items) return;
  const items = be.items;
  for (let i = 0; i < items.length; i++) {
    const s = items[i];
    if (s && s.item && s.count > 0) spawnStack(world, x + 0.5, y + 0.5, z + 0.5, copyStack(s));
    items[i] = null;
  }
}

/** Walks the block entities of chunks near a player so the shadow map stays warm. */
function sweepBlockEntities(world) {
  let players = [];
  try { players = world.getPlayers ? world.getPlayers() : []; } catch { return; }
  if (!players.length) return;
  const px = flr(players[0].x) >> 4, pz = flr(players[0].z) >> 4;
  for (const c of world.chunks.values()) {
    if (!c.blockEntities || c.blockEntities.size === 0) continue;
    const dx = c.cx - px, dz = c.cz - pz;
    if (dx * dx + dz * dz > 100) continue;
    const ox = c.cx << 4, oz = c.cz << 4;
    for (const [i, be] of c.blockEntities) {
      if (!be || !be.items) continue;
      const lx = i & 15, lz = (i >> 4) & 15, ly = i >> 8;
      _beShadow.set(beKey(ox + lx, ly, oz + lz), be);
    }
  }
  if (_beShadow.size > BE_SHADOW_MAX) _beShadow.clear();
}

// ===========================================================================
// 1. FLUIDS
// ===========================================================================

// Horizontal neighbour offsets, in the order north, south, west, east.
const HDIRS = [[0, -1], [0, 1], [-1, 0], [1, 0]];
const HOPP = [1, 0, 3, 2];

/** Ticks between spread steps for a fluid, matching world.js. */
function fluidDelay(world, id) {
  const d = getBlock(id);
  if (d.liquid === 'water') return 5;
  if (d.liquid === 'lava') return world.dimension === DIM_NETHER ? 10 : 30;
  return 5;
}

/** How much the level drops per horizontal step. */
function fluidDrop(world, id) {
  const d = getBlock(id);
  if (d.liquid === 'lava' && world.dimension !== DIM_NETHER) return 2;   // lava spreads 3
  return 1;                                                              // water / nether lava: 7
}

/** True when a fluid may occupy this cell (air, plants, snow, ...). */
function fluidCanReplace(world, x, y, z, fluidId) {
  const raw = world.getRaw(x, y, z);
  const id = raw & ID_MASK;
  if (id === 0) return true;
  if (id === fluidId) return false;
  const d = getBlock(id);
  if (d.liquid) return false;
  if (fluidId === ids().water && holdsWater(id)) return false;   // already waterlogged
  if (d.hardness < 0) return false;              // bedrock, portals
  if (d.replaceable) return true;
  return isFlimsy(d);
}

/** True when a fluid can path through this cell (already-fluid included). */
function flowPassable(world, x, y, z, fluidId) {
  const id = world.getBlock(x, y, z);
  if (id === fluidId) return true;
  if (fluidId === ids().water && holdsWater(id)) return true;    // water flows through kelp
  return fluidCanReplace(world, x, y, z, fluidId);
}

/**
 * Vanilla's recursive "how far to the nearest hole" search, depth-capped at 4.
 * Returns the number of steps, or 1000 when nothing downhill was found.
 */
function flowCost(world, x, y, z, dist, from, fluidId) {
  let cost = 1000;
  for (let i = 0; i < 4; i++) {
    if (i === from) continue;
    const nx = x + HDIRS[i][0], nz = z + HDIRS[i][1];
    if (!flowPassable(world, nx, y, nz, fluidId)) continue;
    if (flowPassable(world, nx, y - 1, nz, fluidId)) return dist;
    if (dist >= 4) continue;
    const c = flowCost(world, nx, y, nz, dist + 1, HOPP[i], fluidId);
    if (c < cost) cost = c;
  }
  return cost;
}

const _flowCosts = [0, 0, 0, 0];

/**
 * Fills `_flowCosts` with the downhill distance in each horizontal direction
 * and returns the smallest one. 1000 means "nowhere downhill nearby".
 */
function optimalFlowDirections(world, x, y, z, fluidId) {
  let min = 1000;
  for (let i = 0; i < 4; i++) {
    _flowCosts[i] = 1000;
    const nx = x + HDIRS[i][0], nz = z + HDIRS[i][1];
    if (!flowPassable(world, nx, y, nz, fluidId)) continue;
    if (flowPassable(world, nx, y - 1, nz, fluidId)) _flowCosts[i] = 0;
    else _flowCosts[i] = flowCost(world, nx, y, nz, 1, HOPP[i], fluidId);
    if (_flowCosts[i] < min) min = _flowCosts[i];
  }
  return min;
}

/** Writes a fluid into a cell, washing away whatever flimsy thing was there. */
function placeFluid(world, x, y, z, fluidId, meta) {
  const raw = world.getRaw(x, y, z);
  const id = raw & ID_MASK;
  if (id !== 0) {
    const d = getBlock(id);
    if (d.liquid) return false;
    if (fluidId === ids().water && holdsWater(id)) return false;  // already waterlogged
    if (fluidCanDestroy(world, x, y, z, d)) breakNaturally(world, x, y, z);
    else if (!d.replaceable) return false;
  }
  return world.setBlock(x, y, z, fluidId, meta & 15, 3);
}

/**
 * Lava that touches water turns to stone: a source becomes obsidian, a flowing
 * block becomes cobblestone. Returns true when the lava was consumed.
 */
function lavaMix(world, x, y, z, meta) {
  const I = ids();
  if (!I.water) return false;
  let touch = false;
  for (let f = 0; f < 6; f++) {
    const d = FACE_DIRS[f];
    if (world.getBlock(x + d[0], y + d[1], z + d[2]) === I.water) { touch = true; break; }
  }
  if (!touch) return false;
  const source = (meta & 7) === 0;
  const out = source ? (I.obsidian || I.stone) : (I.cobblestone || I.stone);
  world.setBlock(x, y, z, out, 0, 3);
  fizzle(world, x, y, z);
  return true;
}

/**
 * Water meeting lava. Flowing water over a lava source makes stone; anything
 * else hands the decision to lavaMix on the lava's own block.
 */
function waterMix(world, x, y, z, meta) {
  const I = ids();
  if (!I.lava) return false;
  for (let f = 0; f < 6; f++) {
    const d = FACE_DIRS[f];
    const nx = x + d[0], ny = y + d[1], nz = z + d[2];
    if (world.getBlock(nx, ny, nz) !== I.lava) continue;
    const lm = world.getMeta(nx, ny, nz);
    if (f === FACE_DOWN && (lm & 7) === 0 && (meta & 7) !== 0) {
      world.setBlock(nx, ny, nz, I.stone, 0, 3);
      fizzle(world, nx, ny, nz);
      return true;
    }
    if (lavaMix(world, nx, ny, nz, lm)) return true;
  }
  return false;
}

function fizzle(world, x, y, z) {
  playAt(world, x, y, z, 'fizz', 0.5, 2.6 + Math.random() * 0.8);
  particlesAt('smoke', x + 0.5, y + 1.0, z + 0.5, { count: 8, spread: 0.4, vy: 0.4 });
}

/**
 * One spread step for a fluid block. This is the heart of the module: level
 * recalculation, source formation, water/lava mixing and the downhill search.
 */
function updateFluid(world, x, y, z, id) {
  const I = ids();
  const def = getBlock(id);
  if (!def.liquid) return;
  const raw = world.getRaw(x, y, z);
  if ((raw & ID_MASK) !== id) return;
  let meta = (raw >>> 12) & 15;
  let level = meta & 7;
  const isWater = def.liquid === 'water';
  const drop = fluidDrop(world, id);
  const delay = fluidDelay(world, id);

  // --- water/lava contact -------------------------------------------------
  if (isWater) { if (waterMix(world, x, y, z, meta)) return; }
  else if (lavaMix(world, x, y, z, meta)) return;

  // --- recompute our own level from the neighbours -------------------------
  // Everything except a true source has to justify its existence every tick,
  // which is what makes water drain away when you break its source.
  if ((meta & 15) !== 0) {
    let best = 8;
    let sources = 0;
    for (let i = 0; i < 4; i++) {
      const nx = x + HDIRS[i][0], nz = z + HDIRS[i][1];
      if (world.getBlock(nx, y, nz) !== id) continue;
      const nm = world.getMeta(nx, y, nz);
      const nl = (nm & 8) ? 0 : (nm & 7);
      if ((nm & 15) === 0) sources++;
      if (nl + drop < best) best = nl + drop;
    }
    const fedFromAbove = world.getBlock(x, y + 1, z) === id;
    const belowId = world.getBlock(x, y - 1, z);
    let newMeta;
    if (fedFromAbove) {
      newMeta = 8;                                   // a falling column is always full
    } else if (isWater && sources >= 2 && (blockIsSolid(belowId) || belowId === id)) {
      newMeta = 0;                                   // two sources and a floor: infinite water
    } else if (best <= 7) {
      newMeta = best;
    } else {
      world.setBlock(x, y, z, 0, 0, 3);              // nothing feeds this block any more
      return;
    }
    if (newMeta !== meta) {
      world.setBlock(x, y, z, id, newMeta, 3);       // the write reschedules us
      return;
    }
    meta = newMeta;
    level = meta & 7;
  }

  // --- straight down ------------------------------------------------------
  if (y > 0) {
    const belowId = world.getBlock(x, y - 1, z);
    if (belowId === id) {
      const bm = world.getMeta(x, y - 1, z);
      // Only flowing fluid below becomes "falling". A source below stays a
      // source: an ocean is a stack of source blocks, and flagging them all
      // falling rewrote 7000 blocks on load (churning every ocean chunk's mesh)
      // and stopped water refilling a hole broken out of it.
      if ((bm & 15) !== 0 && (bm & 8) === 0) world.setBlock(x, y - 1, z, id, 8, 3);
      return;                       // falling fluid does not spread sideways
    }
    if (fluidCanReplace(world, x, y - 1, z, id)) {
      if (!isWater && belowId === I.water) { lavaMix(world, x, y, z, meta); return; }
      if (isWater && belowId === I.lava) { waterMix(world, x, y, z, meta); return; }
      placeFluid(world, x, y - 1, z, id, 8);
      world.scheduleTick(x, y - 1, z, delay, id);
      return;
    }
  }

  // --- horizontally, preferring whatever leads downhill --------------------
  const nextLevel = (meta & 8) ? drop : level + drop;
  if (nextLevel > 7) return;

  const min = optimalFlowDirections(world, x, y, z, id);
  for (let i = 0; i < 4; i++) {
    if (_flowCosts[i] !== min) continue;
    const nx = x + HDIRS[i][0], nz = z + HDIRS[i][1];
    const nid = world.getBlock(nx, y, nz);
    if (nid === id) {
      const nm = world.getMeta(nx, y, nz);
      if ((nm & 8) === 0 && (nm & 7) > nextLevel) {
        world.setBlock(nx, y, nz, id, nextLevel, 3);
      }
      continue;
    }
    if (!isWater && nid === I.water) { world.setBlock(nx, y, nz, I.cobblestone || I.stone, 0, 3); fizzle(world, nx, y, nz); continue; }
    if (isWater && nid === I.lava) { lavaMix(world, nx, y, nz, world.getMeta(nx, y, nz)); continue; }
    if (!fluidCanReplace(world, nx, y, nz, id)) continue;
    if (placeFluid(world, nx, y, nz, id, nextLevel)) world.scheduleTick(nx, y, nz, delay, id);
  }
}

/** Entry point used by scheduledTick with the per-tick fluid budget applied. */
function fluidTick(world, x, y, z, id) {
  if (_fluidWork >= FLUID_BUDGET) {
    // Over budget: push the work into the next tick rather than cascading now.
    world.scheduleTick(x, y, z, 2, id);
    return;
  }
  _fluidWork++;
  updateFluid(world, x, y, z, id);
}

/**
 * Nudges entities along with the flow. Vanilla adds ~0.014 per fluid block
 * intersected in the direction of the level gradient.
 */
function pushEntitiesInFluids(world) {
  const list = world.entities;
  if (!list || !list.length) return;
  const I = ids();
  for (let i = 0; i < list.length; i++) {
    const e = list[i];
    if (!e || e.removed || e.noClip) continue;
    if (!e.inWater && !e.inLava) continue;
    const x = flr(e.x), y = flr(e.y + 0.1), z = flr(e.z);
    const id = world.getBlock(x, y, z);
    if (id !== I.water && id !== I.lava) continue;
    const meta = world.getMeta(x, y, z);
    const own = (meta & 8) ? 0 : (meta & 7);
    let dx = 0, dz = 0;
    for (let d = 0; d < 4; d++) {
      const nx = x + HDIRS[d][0], nz = z + HDIRS[d][1];
      const nid = world.getBlock(nx, y, nz);
      let diff;
      if (nid === id) {
        const nm = world.getMeta(nx, y, nz);
        diff = ((nm & 8) ? 0 : (nm & 7)) - own;
      } else if (!blockIsSolid(nid)) {
        // Open air beside the flow: treat it as the steepest downhill there is.
        diff = flowPassable(world, nx, y - 1, nz, id) ? 8 - own : 0;
      } else continue;
      if (diff > 0) { dx += HDIRS[d][0] * diff; dz += HDIRS[d][1] * diff; }
    }
    const len = Math.hypot(dx, dz);
    if (len < 1e-4) continue;
    const scale = (id === I.lava ? 0.0046 : 0.014) * 20;   // per second
    e.vx += (dx / len) * scale;
    e.vz += (dz / len) * scale;
  }
}

// ===========================================================================
// 2. GRAVITY
// ===========================================================================

/** True when a falling block can pass through whatever is here. */
function fallThrough(world, x, y, z) {
  if (y < 0) return false;
  const id = world.getBlock(x, y, z);
  if (id === 0) return true;
  const d = getBlock(id);
  if (d.liquid) return true;
  if (d.name === 'fire' || d.name === 'soul_fire') return true;
  return isFlimsy(d) && d.replaceable;
}

/** Turns an unsupported gravity block into a FallingBlock entity. */
function tryFall(world, x, y, z, id) {
  if (y <= 0) return false;
  if (!fallThrough(world, x, y - 1, z)) return false;
  if (_itementity && _itementity.spawnFallingBlock) {
    try {
      if (_itementity.spawnFallingBlock(world, x, y, z)) return true;
    } catch { /* fall through to the teleport fallback */ }
  }
  // No entity module: slide the block down one step so piles still settle.
  const meta = world.getMeta(x, y, z);
  world.setBlock(x, y, z, 0, 0, 3);
  world.setBlock(x, y - 1, z, id, meta, 3);
  return true;
}

// ===========================================================================
// 3. SUPPORT CHECKS
// ===========================================================================

/** Whether a block can be attached to the top of whatever is at (x, y, z). */
function solidTop(world, x, y, z) {
  const raw = world.getRaw(x, y, z);
  const id = raw & ID_MASK;
  if (id === 0) return false;
  const d = getBlock(id);
  if (d.liquid || !d.solid) return false;
  if (d.collision === 'full') return true;
  const m = (raw >>> 12) & 15;
  if (d.model === 'slab') return (m & 1) !== 0;         // only an upper slab has a full top
  if (d.model === 'stairs') return (m & 4) !== 0;       // ...and only upside-down stairs
  if (d.model === 'farmland' || d.model === 'path') return true;
  return false;
}

/** Whether a wall-mounted block may cling to (x, y, z). */
function solidSide(world, x, y, z) {
  const id = world.getBlock(x, y, z);
  if (id === 0) return false;
  const d = getBlock(id);
  return d.solid && (d.collision === 'full' || d.collision === 'half') && !d.liquid;
}

const PLANT_SOIL = new Set(['dirt', 'grass_block', 'coarse_dirt', 'rooted_dirt', 'podzol',
  'mycelium', 'farmland', 'moss_block', 'mud', 'muddy_mangrove_roots']);
const NETHER_SOIL = new Set(['crimson_nylium', 'warped_nylium', 'netherrack', 'soul_sand',
  'soul_soil', 'warped_wart_block', 'nether_wart_block']);
const SAND_SOIL = new Set(['sand', 'red_sand', 'suspicious_sand']);

/**
 * True when the block at (x, y, z) still has whatever it needs underneath or
 * behind it. `false` means neighborUpdate will pop it off.
 */
function canSurvive(world, x, y, z, id, meta, def) {
  const name = def.name;
  const belowId = world.getBlock(x, y - 1, z);
  const belowName = bname(belowId);

  switch (name) {
    case 'cactus': {
      if (!SAND_SOIL.has(belowName) && belowId !== id) return false;
      for (let i = 0; i < 4; i++) {
        const nid = world.getBlock(x + HDIRS[i][0], y, z + HDIRS[i][1]);
        const nd = getBlock(nid);
        if (nid !== 0 && nd.solid && nd.collision !== 'none') return false;
      }
      return true;
    }
    case 'sugar_cane': {
      if (belowId === id) return true;
      if (!PLANT_SOIL.has(belowName) && !SAND_SOIL.has(belowName)) return false;
      const I = ids();
      for (let i = 0; i < 4; i++) {
        const nx = x + HDIRS[i][0], nz = z + HDIRS[i][1];
        const nb = world.getBlock(nx, y - 1, nz);
        if (nb === I.water || getBlock(nb).name === 'frosted_ice') return true;
      }
      return false;
    }
    case 'bamboo':
    case 'bamboo_sapling':
      return belowId === id || PLANT_SOIL.has(belowName) || SAND_SOIL.has(belowName) ||
        belowName === 'bamboo' || belowName === 'gravel';
    case 'nether_wart':
      return belowName === 'soul_sand';
    case 'chorus_flower':
    case 'chorus_plant': {
      if (belowName === 'end_stone' || belowId === ids().chorus_plant) return true;
      for (let i = 0; i < 4; i++) {
        if (world.getBlock(x + HDIRS[i][0], y, z + HDIRS[i][1]) === ids().chorus_plant) return true;
      }
      return false;
    }
    case 'kelp':
    case 'kelp_plant': {
      const I = ids();
      return belowId === I.kelp || belowId === I.kelp_plant || blockIsSolid(belowId);
    }
    case 'lily_pad':
      return belowId === ids().water;
    case 'snow':
      return solidTop(world, x, y - 1, z) || getBlock(belowId).model === 'layer';
    case 'cocoa': {
      const d = HFACE_DIRS[meta >> 2 & 3] || HFACE_DIRS[0];
      const host = world.getBlock(x - d[0], y, z - d[2]);
      return LOG_IDS.has(host) || host !== 0;
    }
    case 'cave_vines':
    case 'cave_vines_plant':
    case 'weeping_vines':
    case 'weeping_vines_plant':
    case 'hanging_roots': {
      const above = world.getBlock(x, y + 1, z);
      return above === id || solidTop(world, x, y + 1, z) || blockIsSolid(above);
    }
    case 'twisting_vines':
    case 'twisting_vines_plant':
      return belowId === id || blockIsSolid(belowId);
    case 'sweet_berry_bush':
      return PLANT_SOIL.has(belowName);
    case 'turtle_egg':
    case 'sniffer_egg':
      return blockIsSolid(belowId);
    case 'cake':
      return blockIsSolid(belowId);
    default: break;
  }

  switch (def.model) {
    case 'crop':
      return belowName === 'farmland' || belowName === 'soul_sand' || PLANT_SOIL.has(belowName);
    case 'cross': {
      // The upper half of a two-block plant sits on its own lower half.
      if (belowId === id) return true;
      if (NETHER_SOIL.has(belowName) || PLANT_SOIL.has(belowName) || SAND_SOIL.has(belowName)) return true;
      if (name === 'seagrass' || name === 'tall_seagrass') return blockIsSolid(belowId);
      // Anything else with a full top face is fair game: worldgen scatters
      // plants over gravel, terracotta and nylium and they must not vanish.
      return solidTop(world, x, y - 1, z);
    }
    case 'layer':
    case 'carpet':
      return blockIsSolid(belowId) && belowId !== 0;
    case 'torch':
    case 'button':
    case 'lever': {
      const m = meta & 7;
      if (m === 0) return solidTop(world, x, y - 1, z);
      if (m === 5) return solidSide(world, x, y + 1, z);
      const d = HFACE_DIRS[(m - 1) & 3];
      return solidSide(world, x - d[0], y, z - d[2]);
    }
    case 'ladder': {
      const d = HFACE_DIRS[meta & 3];
      return solidSide(world, x - d[0], y, z - d[2]);
    }
    case 'rail':
    case 'flat':
      return blockIsSolid(belowId) && belowId !== 0;
    case 'vine': {
      // Deliberately forgiving about *which* side the metadata claims: vines,
      // glow lichen and sculk veins are placed by several different modules and
      // only need something to cling to.
      if (world.getBlock(x, y + 1, z) === id) return true;
      for (let i = 0; i < 4; i++) {
        const d = VINE_DIRS[i];
        if (solidSide(world, x + d[0], y, z + d[1])) return true;
      }
      return blockIsSolid(world.getBlock(x, y + 1, z)) || solidTop(world, x, y - 1, z);
    }
    case 'sign':
      return blockIsSolid(belowId);
    case 'wall_sign': {
      const d = HFACE_DIRS[meta & 3];
      return solidSide(world, x - d[0], y, z - d[2]);
    }
    case 'pot':
      // Brewing stands and decorated pots stand on their own; the eggs that
      // share this model are handled by name above.
      return true;
    case 'door': {
      if (meta & 1) return world.getBlock(x, y - 1, z) === id;
      return world.getBlock(x, y + 1, z) === id && blockIsSolid(belowId);
    }
    case 'bed': {
      const d = HFACE_DIRS[meta & 3] || [0, 0, 0];
      const head = (meta & 4) !== 0;
      const ox = head ? x - d[0] : x + d[0];
      const oz = head ? z - d[2] : z + d[2];
      return world.getBlock(ox, y, oz) === id;
    }
    default:
      return true;
  }
}

// vine meta bit order used by the mesher: 1 south(+Z), 2 west(-X), 4 north(-Z), 8 east(+X)
const VINE_DIRS = [[0, 1], [-1, 0], [0, -1], [1, 0]];

// ===========================================================================
// 4. PLANT / TERRAIN GROWTH (random ticks)
// ===========================================================================

function blockLight(world, x, y, z) {
  try { return world.getBlockLight(x, y, z) | 0; } catch { return 0; }
}
/** Sky light after the day/night multiplier - what a plant actually "sees". */
function daylightAt(world, x, y, z) {
  let s = 0;
  try { s = world.getSkyLight(x, y, z) | 0; } catch { s = 15; }
  let f = 1;
  try { f = world.skyLightFactor ? world.skyLightFactor() : 1; } catch { f = 1; }
  return Math.max(s * f, blockLight(world, x, y, z));
}

/** Vanilla's farmland-based crop growth speed. */
function cropGrowthSpeed(world, x, y, z) {
  let points = 1;
  const I = ids();
  for (let dz = -1; dz <= 1; dz++) {
    for (let dx = -1; dx <= 1; dx++) {
      const id = world.getBlock(x + dx, y - 1, z + dz);
      let p = 0;
      if (id === I.farmland) p = (world.getMeta(x + dx, y - 1, z + dz) & 7) > 0 ? 3 : 1;
      if (p > 0 && (dx !== 0 && dz !== 0)) p /= 4;
      points += p;
    }
  }
  // Crops planted in a row grow slower than crops in a checkerboard.
  const nWE = world.getBlock(x - 1, y, z) === world.getBlock(x, y, z) ||
    world.getBlock(x + 1, y, z) === world.getBlock(x, y, z);
  const nNS = world.getBlock(x, y, z - 1) === world.getBlock(x, y, z) ||
    world.getBlock(x, y, z + 1) === world.getBlock(x, y, z);
  if (nWE && nNS) points /= 2;
  return points;
}

const MAX_STAGE = {
  wheat: 7, carrots: 7, potatoes: 7, beetroots: 3, torchflower_crop: 2, pitcher_crop: 4,
  nether_wart: 3, melon_stem: 7, pumpkin_stem: 7, cocoa: 2, sweet_berry_bush: 3,
};

function tickCrop(world, x, y, z, id, meta, def, rng) {
  const max = MAX_STAGE[def.name] !== undefined ? MAX_STAGE[def.name] : 7;
  const stage = meta & 7;
  if (stage >= max) {
    if (def.name === 'melon_stem' || def.name === 'pumpkin_stem') spawnGourd(world, x, y, z, def.name, rng);
    return;
  }
  if (def.name !== 'nether_wart' && daylightAt(world, x, y + 1, z) < 9) return;
  const speed = def.name === 'nether_wart' ? 10 : cropGrowthSpeed(world, x, y, z);
  const chance = def.name === 'nether_wart' ? 0.1 : 1 / (flr(25 / speed) + 1);
  if (rng.next() >= chance) return;
  world.setBlock(x, y, z, id, stage + 1, 3);
}

function spawnGourd(world, x, y, z, stemName, rng) {
  const I = ids();
  const fruit = stemName === 'melon_stem' ? I.melon : I.pumpkin;
  if (!fruit) return;
  const attached = stemName === 'melon_stem' ? I.attached_melon_stem : I.attached_pumpkin_stem;
  const order = [0, 1, 2, 3];
  const start = rng.int(4);
  for (let k = 0; k < 4; k++) {
    const i = order[(start + k) & 3];
    const nx = x + HDIRS[i][0], nz = z + HDIRS[i][1];
    if (world.getBlock(nx, y, nz) === fruit) return;      // already fruited
  }
  for (let k = 0; k < 4; k++) {
    const i = order[(start + k) & 3];
    const nx = x + HDIRS[i][0], nz = z + HDIRS[i][1];
    const here = world.getBlock(nx, y, nz);
    if (here !== 0 && !getBlock(here).replaceable) continue;
    const soil = bname(world.getBlock(nx, y - 1, nz));
    if (!PLANT_SOIL.has(soil)) continue;
    world.setBlock(nx, y, nz, fruit, 0, 3);
    if (attached) world.setBlock(x, y, z, attached, (i === 0 ? 0 : i === 1 ? 2 : i === 2 ? 3 : 1), 3);
    return;
  }
}

const SAPLING_TREES = {
  oak_sapling: { normal: 'oak_tree', fancy: 'big_oak_tree', fancyChance: 0.1 },
  birch_sapling: { normal: 'birch_tree', fancy: 'tall_birch_tree', fancyChance: 0.06 },
  spruce_sapling: { normal: 'spruce_tree', big: 'mega_spruce_tree', alt: 'pine_tree', altChance: 0.4 },
  jungle_sapling: { normal: 'jungle_tree', big: 'mega_jungle_tree' },
  acacia_sapling: { normal: 'acacia_tree' },
  dark_oak_sapling: { big: 'dark_oak_tree', requiresBig: true },
  cherry_sapling: { normal: 'cherry_tree' },
  mangrove_propagule: { normal: 'mangrove_tree' },
  azalea: { normal: 'azalea_tree' },
  flowering_azalea: { normal: 'azalea_tree' },
  crimson_fungus: { normal: 'fungus_crimson' },
  warped_fungus: { normal: 'fungus_warped' },
};

/** Finds the lower-left corner of a 2x2 patch of the same sapling, or null. */
function find2x2(world, x, y, z, id) {
  for (let ox = -1; ox <= 0; ox++) {
    for (let oz = -1; oz <= 0; oz++) {
      if (world.getBlock(x + ox, y, z + oz) === id &&
        world.getBlock(x + ox + 1, y, z + oz) === id &&
        world.getBlock(x + ox, y, z + oz + 1) === id &&
        world.getBlock(x + ox + 1, y, z + oz + 1) === id) {
        return { x: x + ox, z: z + oz };
      }
    }
  }
  return null;
}

function tickSapling(world, x, y, z, id, meta, def, rng) {
  if (daylightAt(world, x, y + 1, z) < 9) return;
  if ((meta & 8) === 0) { world.setBlock(x, y, z, id, meta | 8, 3); return; }
  if (rng.next() > 0.45) return;
  growTree(world, x, y, z, id, def.name, rng);
}

/** Replaces a sapling (or a 2x2 of them) with a real tree feature. */
function growTree(world, x, y, z, id, name, rng) {
  const spec = SAPLING_TREES[name];
  if (!spec || !_features || !_features.placeFeature) return false;

  const quad = spec.big ? find2x2(world, x, y, z, id) : null;
  let feature = spec.normal;
  let cells = [{ x, z }];
  if (quad && spec.big) {
    feature = spec.big;
    cells = [
      { x: quad.x, z: quad.z }, { x: quad.x + 1, z: quad.z },
      { x: quad.x, z: quad.z + 1 }, { x: quad.x + 1, z: quad.z + 1 },
    ];
  } else if (spec.requiresBig) {
    return false;                                   // dark oak needs the 2x2
  } else if (spec.fancy && rng.next() < (spec.fancyChance || 0)) {
    feature = spec.fancy;
  } else if (spec.alt && rng.next() < (spec.altChance || 0)) {
    feature = spec.alt;
  }
  if (!feature) return false;

  // Clear the saplings first: the tree features test the space they need.
  const saved = [];
  for (const c of cells) {
    saved.push({ x: c.x, z: c.z, raw: world.getRaw(c.x, y, c.z) });
    world.setBlock(c.x, y, c.z, 0, 0, 1);
  }
  const base = quad && spec.big ? quad : { x, z };
  let ok = false;
  try { ok = _features.placeFeature(feature, world, base.x, y, base.z, rng, { sapling: true }); } catch { ok = false; }
  if (!ok) {
    for (const s of saved) world.setRaw(s.x, y, s.z, s.raw, 1);
    return false;
  }
  return true;
}

/** Grass and mycelium spread onto bare dirt and die when covered. */
function tickSpreadingSoil(world, x, y, z, id, meta, def, rng) {
  const I = ids();
  const aboveId = world.getBlock(x, y + 1, z);
  const aboveDef = getBlock(aboveId);
  // Buried or drowned: back to plain dirt.
  if (aboveDef.filter >= 2 && !aboveDef.liquid) { world.setBlock(x, y, z, I.dirt, 0, 3); return; }
  if (aboveDef.liquid === 'water' && (world.getMeta(x, y + 1, z) & 7) === 0 && def.name !== 'mycelium') {
    world.setBlock(x, y, z, I.dirt, 0, 3);
    return;
  }
  if (daylightAt(world, x, y + 1, z) < 4) {
    if (blockLight(world, x, y + 1, z) < 4 && aboveDef.filter > 0) world.setBlock(x, y, z, I.dirt, 0, 3);
    return;
  }
  if (daylightAt(world, x, y + 1, z) < 9) return;
  for (let i = 0; i < 4; i++) {
    const tx = x + rng.range(-1, 1);
    const ty = y + rng.range(-3, 1);
    const tz = z + rng.range(-1, 1);
    if (ty < 1 || ty >= WORLD_HEIGHT - 1) continue;
    if (world.getBlock(tx, ty, tz) !== I.dirt) continue;
    const overId = world.getBlock(tx, ty + 1, tz);
    const over = getBlock(overId);
    if (over.filter >= 2 && !over.liquid) continue;
    if (over.liquid) continue;
    if (daylightAt(world, tx, ty + 1, tz) < 4) continue;
    world.setBlock(tx, ty, tz, id, 0, 3);
  }
}

/** Farmland dries out, and reverts to dirt when nothing is planted on it. */
function tickFarmland(world, x, y, z, id, meta, def, rng) {
  const I = ids();
  let wet = false;
  for (let dz = -4; dz <= 4 && !wet; dz++) {
    for (let dx = -4; dx <= 4 && !wet; dx++) {
      for (let dy = 0; dy <= 1; dy++) {
        const b = world.getBlock(x + dx, y + dy, z + dz);
        if (b === I.water || b === I.frosted_ice) { wet = true; break; }
      }
    }
  }
  let moisture = meta & 7;
  if (wet || world.isRainingAt?.(x, y + 1, z)) {
    if (moisture !== 7) world.setBlock(x, y, z, id, 7, 3);
    return;
  }
  if (moisture > 0) { world.setBlock(x, y, z, id, moisture - 1, 3); return; }
  const above = world.getBlock(x, y + 1, z);
  if (above !== 0 && getBlock(above).model === 'crop') return;   // crops keep it tilled
  world.setBlock(x, y, z, I.dirt, 0, 3);
}

/** Sugar cane, cactus and bamboo: grow up to their height limit. */
function tickColumnPlant(world, x, y, z, id, meta, def, rng) {
  const name = def.name;
  const maxHeight = name === 'bamboo' ? 16 : 3;
  if (world.getBlock(x, y + 1, z) !== 0) return;

  let below = 1;
  while (below < maxHeight && world.getBlock(x, y - below, z) === id) below++;
  if (below >= maxHeight) return;

  const age = meta & 15;
  if (age < 15) { world.setBlock(x, y, z, id, age + 1, 3); return; }
  world.setBlock(x, y, z, id, 0, 3);
  if (name === 'bamboo' && daylightAt(world, x, y + 1, z) < 9) return;
  world.setBlock(x, y + 1, z, id, 0, 3);
  if (name === 'cactus') particlesAt('block', x + 0.5, y + 1.5, z + 0.5, { count: 2, block: id });
}

/** Bamboo saplings become bamboo. */
function tickBambooSapling(world, x, y, z, id, meta, def, rng) {
  const I = ids();
  if (!I.bamboo) return;
  if (world.getBlock(x, y + 1, z) !== 0) return;
  if (daylightAt(world, x, y + 1, z) < 9) return;
  if (rng.next() > 0.15) return;
  world.setBlock(x, y, z, I.bamboo, 0, 3);
}

/** Kelp grows upward through water to a hard height limit. */
function tickKelp(world, x, y, z, id, meta, def, rng) {
  const I = ids();
  if (rng.next() > 0.14) return;
  if (world.getBlock(x, y + 1, z) !== I.water) return;
  if ((world.getMeta(x, y + 1, z) & 7) !== 0) return;
  let height = 1;
  while (height < 26 && (world.getBlock(x, y - height, z) === I.kelp || world.getBlock(x, y - height, z) === I.kelp_plant)) height++;
  if (height >= 26) return;
  if (I.kelp_plant && id === I.kelp) world.setBlock(x, y, z, I.kelp_plant, 0, 3);
  world.setBlock(x, y + 1, z, I.kelp || id, 0, 3);
}

/** Nether vines creep along their axis. */
function tickNetherVine(world, x, y, z, id, meta, def, rng) {
  if (rng.next() > 0.1) return;
  const down = def.name.startsWith('weeping');
  const ty = down ? y - 1 : y + 1;
  if (ty < 1 || ty >= WORLD_HEIGHT - 1) return;
  if (world.getBlock(x, ty, z) !== 0) return;
  let length = 0;
  while (length < 25 && world.getBlock(x, down ? y + length + 1 : y - length - 1, z) === id) length++;
  if (length >= 25) return;
  world.setBlock(x, ty, z, id, 0, 3);
}

/** Cave vines grow down and occasionally sprout glow berries. */
function tickCaveVine(world, x, y, z, id, meta, def, rng) {
  const I = ids();
  if (rng.next() > 0.11) return;
  if ((meta & 8) === 0 && rng.next() < 0.11) { world.setBlock(x, y, z, id, meta | 8, 3); return; }
  if (y <= 1) return;
  if (world.getBlock(x, y - 1, z) !== 0) return;
  let length = 0;
  while (length < 20 && (world.getBlock(x, y + length + 1, z) === I.cave_vines || world.getBlock(x, y + length + 1, z) === I.cave_vines_plant)) length++;
  if (length >= 20) return;
  if (I.cave_vines_plant && id === I.cave_vines) world.setBlock(x, y, z, I.cave_vines_plant, meta, 3);
  world.setBlock(x, y - 1, z, I.cave_vines || id, 0, 3);
}

/** Vines creep downwards and sideways onto solid faces. */
function tickVine(world, x, y, z, id, meta, def, rng) {
  if (rng.next() > 0.25) return;
  // Downwards first: a vine hanging in open air simply extends.
  if (y > 1 && world.getBlock(x, y - 1, z) === 0 && meta !== 0) {
    world.setBlock(x, y - 1, z, id, meta, 3);
    return;
  }
  // Sideways onto a neighbouring wall.
  const dir = rng.int(4);
  const d = VINE_DIRS[dir];
  const nx = x + d[0], nz = z + d[1];
  if (world.getBlock(nx, y, nz) !== 0) return;
  let m = 0;
  for (let i = 0; i < 4; i++) {
    const dd = VINE_DIRS[i];
    if (solidSide(world, nx + dd[0], y, nz + dd[1])) m |= 1 << i;
  }
  if (m === 0) {
    if (!solidTop(world, nx, y + 1, nz)) return;
    m = meta;
  }
  world.setBlock(nx, y, nz, id, m & 15, 3);
}

/** Cocoa pods ripen on jungle logs. */
function tickCocoa(world, x, y, z, id, meta, def, rng) {
  const stage = meta & 3;
  if (stage >= 2) return;
  if (rng.next() > 0.2) return;
  world.setBlock(x, y, z, id, (meta & ~3) | (stage + 1), 3);
}

/** Sweet berries ripen through four stages in decent light. */
function tickBerries(world, x, y, z, id, meta, def, rng) {
  const stage = meta & 3;
  if (stage >= 3) return;
  if (daylightAt(world, x, y + 1, z) < 9) return;
  if (rng.next() > 0.2) return;
  world.setBlock(x, y, z, id, stage + 1, 3);
}

/** Chorus flowers climb and branch out over the end islands. */
function tickChorusFlower(world, x, y, z, id, meta, def, rng) {
  const I = ids();
  const age = meta & 7;
  if (age >= 5) return;
  if (world.getBlock(x, y + 1, z) !== 0) return;
  if (y + 1 >= WORLD_HEIGHT - 2) return;

  const belowId = world.getBlock(x, y - 1, z);
  let height = 0;
  if (belowId === I.chorus_plant) {
    while (height < 4 && world.getBlock(x, y - height - 1, z) === I.chorus_plant) height++;
  }
  const onEndStone = belowId === I.end_stone;
  if (!onEndStone && belowId !== I.chorus_plant) return;

  if (rng.next() < 0.5 && (onEndStone || height < 4)) {
    // Grow straight up.
    world.setBlock(x, y, z, I.chorus_plant, 0, 3);
    world.setBlock(x, y + 1, z, id, age, 3);
    return;
  }
  // Branch sideways, or die back into a plant segment.
  let branched = false;
  for (let i = 0; i < 4; i++) {
    if (rng.next() > 0.25) continue;
    const nx = x + HDIRS[i][0], nz = z + HDIRS[i][1];
    if (world.getBlock(nx, y, nz) !== 0) continue;
    if (world.getBlock(nx, y - 1, nz) !== 0) continue;
    world.setBlock(nx, y, nz, id, age + 1, 3);
    branched = true;
  }
  world.setBlock(x, y, z, branched ? I.chorus_plant : id, branched ? 0 : 5, 3);
}

/** Leaves without a log within six blocks fall apart. */
function tickLeafDecay(world, x, y, z, id, meta, def, rng) {
  if (meta & 8) return;                              // player-placed: persistent
  if (leafHasLog(world, x, y, z)) return;
  particlesAt('block', x + 0.5, y + 0.5, z + 0.5, { count: 6, block: id, spread: 0.4 });
  breakNaturally(world, x, y, z);
}

const _leafSeen = new Set();
const _leafQueue = [];

/** Bounded flood fill through leaves looking for a log within six steps. */
function leafHasLog(world, x, y, z) {
  sets();
  _leafSeen.clear();
  _leafQueue.length = 0;
  _leafQueue.push(x, y, z, 0);
  _leafSeen.add(x + ',' + y + ',' + z);
  let head = 0, visited = 0;
  while (head < _leafQueue.length && visited < 600) {
    const cx = _leafQueue[head++], cy = _leafQueue[head++], cz = _leafQueue[head++], d = _leafQueue[head++];
    visited++;
    for (let f = 0; f < 6; f++) {
      const dir = FACE_DIRS[f];
      const nx = cx + dir[0], ny = cy + dir[1], nz = cz + dir[2];
      if (ny < 0 || ny >= WORLD_HEIGHT) continue;
      const nid = world.getBlock(nx, ny, nz);
      if (LOG_IDS.has(nid)) return true;
      if (d + 1 > 6 || !LEAF_IDS.has(nid)) continue;
      const k = nx + ',' + ny + ',' + nz;
      if (_leafSeen.has(k)) continue;
      _leafSeen.add(k);
      _leafQueue.push(nx, ny, nz, d + 1);
    }
  }
  return false;
}

/** Mushrooms creep through the dark. */
function tickMushroom(world, x, y, z, id, meta, def, rng) {
  if (rng.next() > 0.16) return;
  if (daylightAt(world, x, y, z) > 12) {
    // Too bright to survive unless it stands on podzol or mycelium.
    const under = bname(world.getBlock(x, y - 1, z));
    if (under !== 'podzol' && under !== 'mycelium' && !under.startsWith('nether')) {
      if (daylightAt(world, x, y, z) > 13) breakNaturally(world, x, y, z);
      return;
    }
  }
  // No more than five in a 9x3x9 box, like vanilla.
  let count = 0;
  for (let dy = -1; dy <= 1; dy++) {
    for (let dz = -4; dz <= 4; dz++) {
      for (let dx = -4; dx <= 4; dx++) {
        if (world.getBlock(x + dx, y + dy, z + dz) === id && ++count > 4) return;
      }
    }
  }
  const tx = x + rng.range(-3, 3), ty = y + rng.range(-1, 1), tz = z + rng.range(-3, 3);
  if (ty < 1 || ty >= WORLD_HEIGHT - 1) return;
  if (world.getBlock(tx, ty, tz) !== 0) return;
  if (daylightAt(world, tx, ty, tz) > 12) return;
  const soil = bname(world.getBlock(tx, ty - 1, tz));
  if (!PLANT_SOIL.has(soil) && !NETHER_SOIL.has(soil) && soil !== 'stone') return;
  world.setBlock(tx, ty, tz, id, 0, 3);
}

/** Turtle eggs crack in three stages, then hatch on sand. */
function tickTurtleEgg(world, x, y, z, id, meta, def, rng) {
  if (!SAND_SOIL.has(bname(world.getBlock(x, y - 1, z)))) return;
  const isDay = world.isDay ? world.isDay() : true;
  if (rng.next() > (isDay ? 0.02 : 0.08)) return;
  const stage = (meta >> 2) & 3;
  const eggs = (meta & 3) + 1;
  if (stage < 2) {
    world.setBlock(x, y, z, id, ((stage + 1) << 2) | (meta & 3), 3);
    playAt(world, x, y, z, 'turtle_egg_crack', 0.7, 0.9 + rng.next() * 0.2);
    return;
  }
  world.setBlock(x, y, z, 0, 0, 3);
  playAt(world, x, y, z, 'turtle_egg_hatch', 0.7, 1);
  if (_mobs && _mobs.createMob) {
    for (let i = 0; i < eggs; i++) {
      try {
        const m = _mobs.createMob('turtle', world, x + 0.5, y, z + 0.5, { baby: true });
        if (m) { m.baby = true; if (!world.entitiesById.has(m.id)) world.addEntity(m); }
      } catch { /* optional */ }
    }
  }
}

/** Budding amethyst grows clusters on its exposed faces. */
function tickBudding(world, x, y, z, id, meta, def, rng) {
  if (rng.next() > 0.2) return;
  const I = ids();
  const f = rng.int(6);
  const d = FACE_DIRS[f];
  const nx = x + d[0], ny = y + d[1], nz = z + d[2];
  if (ny < 0 || ny >= WORLD_HEIGHT) return;
  const cur = world.getBlock(nx, ny, nz);
  let next = 0;
  if (cur === 0 || cur === I.water) next = I.small_amethyst_bud;
  else if (cur === I.small_amethyst_bud) next = I.medium_amethyst_bud;
  else if (cur === I.medium_amethyst_bud) next = I.large_amethyst_bud;
  else if (cur === I.large_amethyst_bud) next = I.amethyst_cluster;
  if (!next) return;
  world.setBlock(nx, ny, nz, next, f, 3);
  playAt(world, nx, ny, nz, 'place_amethyst', 0.5, 1.2);
}

/** Sculk catalysts convert the ground around them. */
function tickSculkCatalyst(world, x, y, z, id, meta, def, rng) {
  const I = ids();
  if (!I.sculk) return;
  if (rng.next() > 0.35) return;
  for (let attempt = 0; attempt < 6; attempt++) {
    const tx = x + rng.range(-3, 3), ty = y + rng.range(-2, 2), tz = z + rng.range(-3, 3);
    if (ty < 1 || ty >= WORLD_HEIGHT - 1) continue;
    const tid = world.getBlock(tx, ty, tz);
    if (tid === 0 || tid === I.sculk) continue;
    const td = getBlock(tid);
    if (!td.solid || td.hardness < 0 || td.liquid) continue;
    if (!SOIL_IDS.has(tid) && td.name !== 'stone' && td.name !== 'deepslate' && td.name !== 'gravel' &&
      td.name !== 'sand' && td.name !== 'tuff' && !td.name.endsWith('_terracotta')) continue;
    if (world.getBlock(tx, ty + 1, tz) !== 0) continue;
    world.setBlock(tx, ty, tz, I.sculk, 0, 3);
    if (I.sculk_vein && rng.next() < 0.25 && world.getBlock(tx, ty + 1, tz) === 0) {
      world.setBlock(tx, ty + 1, tz, I.sculk_vein, 1, 3);
    }
    playAt(world, tx, ty, tz, 'place_sculk', 0.4, 0.8 + rng.next() * 0.4);
    return;
  }
}

/** Stalactites drip into the cauldron below them. */
function tickDripstone(world, x, y, z, id, meta, def, rng) {
  const I = ids();
  if (rng.next() > 0.17) return;
  // Only the tip of a downward-pointing stalactite drips.
  if (world.getBlock(x, y - 1, z) === id) return;
  let topY = y;
  while (topY < WORLD_HEIGHT - 1 && world.getBlock(x, topY + 1, z) === id) topY++;
  const sourceId = world.getBlock(x, topY + 2, z);
  const water = sourceId === I.water, lava = sourceId === I.lava;
  if (!water && !lava) return;
  particlesAt(water ? 'drip_water' : 'drip_lava', x + 0.5, y - 0.05, z + 0.5, { count: 1 });
  for (let dy = 1; dy <= 11; dy++) {
    const cy = y - dy;
    if (cy < 1) return;
    const cid = world.getBlock(x, cy, z);
    if (cid === 0) continue;
    if (cid === I.cauldron) {
      world.setBlock(x, cy, z, water ? I.water_cauldron : I.lava_cauldron, water ? 1 : 3, 3);
      playAt(world, x, cy, z, water ? 'bucket_empty' : 'bucket_empty_lava', 0.4, 1.4);
    } else if (water && cid === I.water_cauldron) {
      const lv = world.getMeta(x, cy, z) & 3;
      if (lv < 3) world.setBlock(x, cy, z, I.water_cauldron, lv + 1, 3);
    }
    return;
  }
}

/** Unwaxed copper slowly oxidises. */
const OXIDATION = new Map([
  ['copper_block', 'exposed_copper'], ['exposed_copper', 'weathered_copper'],
  ['weathered_copper', 'oxidized_copper'],
  ['cut_copper', 'exposed_cut_copper'], ['exposed_cut_copper', 'weathered_cut_copper'],
  ['weathered_cut_copper', 'oxidized_cut_copper'],
  ['cut_copper_stairs', 'exposed_cut_copper_stairs'], ['exposed_cut_copper_stairs', 'weathered_cut_copper_stairs'],
  ['weathered_cut_copper_stairs', 'oxidized_cut_copper_stairs'],
  ['cut_copper_slab', 'exposed_cut_copper_slab'], ['exposed_cut_copper_slab', 'weathered_cut_copper_slab'],
  ['weathered_cut_copper_slab', 'oxidized_cut_copper_slab'],
]);

function tickCopper(world, x, y, z, id, meta, def, rng) {
  const next = OXIDATION.get(def.name);
  if (!next) return;
  if (rng.next() > 0.011) return;
  const nid = bid(next);
  if (nid) world.setBlock(x, y, z, nid, meta, 3);
}

// ===========================================================================
// 5. FIRE
// ===========================================================================

/** Highest flammability among the six neighbours of a cell. */
function neighbourEncouragement(world, x, y, z) {
  let best = 0;
  for (let f = 0; f < 6; f++) {
    const d = FACE_DIRS[f];
    const id = world.getBlock(x + d[0], y + d[1], z + d[2]);
    const fl = getBlock(id).flammable | 0;
    if (fl > best) best = fl;
  }
  return best;
}

/** True when at least one neighbour of a fire block can burn. */
function anyFlammableNeighbour(world, x, y, z) {
  for (let f = 0; f < 6; f++) {
    const d = FACE_DIRS[f];
    if (getBlock(world.getBlock(x + d[0], y + d[1], z + d[2])).flammable > 0) return true;
  }
  return false;
}

function rainingAt(world, x, y, z) {
  try { return !!(world.isRainingAt && world.isRainingAt(x, y, z)); } catch { return false; }
}

/** Tries to burn one block away, replacing it with fire or air. */
function tryBurnBlock(world, x, y, z, chance, age, rng) {
  const id = world.getBlock(x, y, z);
  if (id === 0) return;
  const def = getBlock(id);
  const fl = def.flammable | 0;
  if (fl <= 0) return;
  // blocks.js stores one number (vanilla's "encouragement"); vanilla's separate
  // burn odds run about four times higher, so scale it here.
  if (rng.int(chance) >= fl * 4) return;
  if (world.gameRules && world.gameRules.mobGriefing === false) return;
  const I = ids();
  if (rng.int(age + 10) < 5 && !rainingAt(world, x, y, z)) {
    world.setBlock(x, y, z, I.fire, Math.min(15, age + rng.int(5) / 4 | 0), 3);
  } else {
    world.setBlock(x, y, z, 0, 0, 3);
  }
}

function tickFire(world, x, y, z, id, meta, def, rng) {
  const I = ids();
  if (world.gameRules && world.gameRules.doFireTick === false) return;
  const age = meta & 15;
  const belowId = world.getBlock(x, y - 1, z);
  const eternal = INFINIBURN.has(belowId);
  const soul = def.name === 'soul_fire';

  if (soul) {
    // Soul fire only ever needs its soul soil; it never spreads.
    const bn = bname(belowId);
    if (bn !== 'soul_sand' && bn !== 'soul_soil') world.setBlock(x, y, z, 0, 0, 3);
    return;
  }

  if (rainingAt(world, x, y, z) && !eternal) {
    world.setBlock(x, y, z, 0, 0, 3);
    playAt(world, x, y, z, 'fizz', 0.4, 2.2);
    return;
  }

  if (age < 15 && rng.next() < 0.66) {
    world.setBlock(x, y, z, id, age + 1, 3);
  }

  if (!eternal) {
    const supported = blockIsSolid(belowId) || anyFlammableNeighbour(world, x, y, z);
    if (!supported) { world.setBlock(x, y, z, 0, 0, 3); return; }
    if (age >= 15 && getBlock(belowId).flammable === 0 && rng.next() < 0.25) {
      world.setBlock(x, y, z, 0, 0, 3);
      return;
    }
  }

  if (world.gameRules && world.gameRules.mobGriefing === false) return;

  // Eat the neighbours.
  tryBurnBlock(world, x + 1, y, z, 300, age, rng);
  tryBurnBlock(world, x - 1, y, z, 300, age, rng);
  tryBurnBlock(world, x, y, z + 1, 300, age, rng);
  tryBurnBlock(world, x, y, z - 1, 300, age, rng);
  tryBurnBlock(world, x, y - 1, z, 250, age, rng);
  tryBurnBlock(world, x, y + 1, z, 250, age, rng);

  // Jump to nearby air, more easily upwards, less easily in wet biomes.
  let humid = 0;
  try {
    const b = world.biomeAt(x, z);
    if (b && b.downfall > 0.6) humid = 1;
  } catch { /* biome optional */ }
  const rain = world.weather ? world.weather.rain : 0;

  for (let dx = -1; dx <= 1; dx++) {
    for (let dz = -1; dz <= 1; dz++) {
      for (let dy = -1; dy <= 4; dy++) {
        if (dx === 0 && dy === 0 && dz === 0) continue;
        const tx = x + dx, ty = y + dy, tz = z + dz;
        if (ty < 1 || ty >= WORLD_HEIGHT - 1) continue;
        if (world.getBlock(tx, ty, tz) !== 0) continue;
        const enc = neighbourEncouragement(world, tx, ty, tz);
        if (enc <= 0) continue;
        let k = 100;
        if (dy > 1) k += (dy - 1) * 100;
        const chance = flr((enc + 40 + 7 * 2) / (age + 30));
        if (chance <= 0) continue;
        if (rng.int(k) > chance) continue;
        if (rainingAt(world, tx, ty, tz)) continue;
        if (humid && rng.next() < 0.5 + rain * 0.4) continue;
        const newAge = Math.min(15, age + (rng.int(5) / 4 | 0));
        world.setBlock(tx, ty, tz, I.fire, newAge, 3);
      }
    }
  }
}

/** Lava on the surface occasionally sets flammable neighbours alight. */
function lavaFireCheck(world, x, y, z, rng) {
  if (world.gameRules && world.gameRules.doFireTick === false) return;
  const I = ids();
  if (!I.fire) return;
  for (let i = 0; i < 3; i++) {
    const tx = x + rng.range(-1, 1), ty = y + rng.range(0, 1), tz = z + rng.range(-1, 1);
    if (ty < 1 || ty >= WORLD_HEIGHT - 1) continue;
    if (world.getBlock(tx, ty, tz) !== 0) continue;
    if (neighbourEncouragement(world, tx, ty, tz) <= 0) continue;
    world.setBlock(tx, ty, tz, I.fire, 0, 3);
    return;
  }
}

// ===========================================================================
// 6. ICE AND SNOW
// ===========================================================================

/** Biome temperature at a column, defaulting to temperate. */
function temperatureAt(world, x, y, z) {
  let b = null;
  try { b = world.biomeAt(x, z); } catch { b = null; }
  if (!b) return 0.8;
  let t = b.temperature !== undefined ? b.temperature : 0.8;
  // Vanilla drops the temperature with altitude above sea level.
  if (y > SEA_LEVEL + 4) t -= (y - SEA_LEVEL - 4) * 0.00125 * 8;
  return t;
}

/** Still water freezes in cold biomes when it is dark and hemmed in. */
function tickWaterFreeze(world, x, y, z, id, meta, def, rng) {
  if ((meta & 15) !== 0) return;                   // sources only
  if (world.dimension !== DIM_OVERWORLD) return;
  if (y + 1 >= WORLD_HEIGHT) return;
  const above = world.getBlock(x, y + 1, z);
  if (above !== 0 && getBlock(above).filter > 0) return;   // must be an open surface
  if (temperatureAt(world, x, y, z) > 0.15) return;
  // Vanilla only looks at *block* light here, which is why lakes freeze over
  // in broad daylight but not next to a torch.
  if (blockLight(world, x, y + 1, z) >= 10) return;
  const I = ids();
  if (I.ice) world.setBlock(x, y, z, I.ice, 0, 3);
}

/** Ice melts near torches and other bright light. */
function tickIceMelt(world, x, y, z, id, meta, def, rng) {
  const I = ids();
  if (blockLight(world, x, y + 1, z) <= 11) return;
  if (world.dimension === DIM_NETHER) { world.setBlock(x, y, z, 0, 0, 3); return; }
  world.setBlock(x, y, z, I.water || 0, 0, 3);
}

/** Frosted ice (frost walker) fades in a few stages. */
function tickFrostedIce(world, x, y, z, id, meta, def, rng) {
  const I = ids();
  const age = meta & 3;
  if (blockLight(world, x, y + 1, z) > 11 || rng.next() < 0.25) {
    if (age >= 3) { world.setBlock(x, y, z, I.water || 0, 0, 3); return; }
    world.setBlock(x, y, z, id, age + 1, 3);
  }
}

/** Snow layers melt in warm light. */
function tickSnowMelt(world, x, y, z, id, meta, def, rng) {
  if (blockLight(world, x, y + 1, z) > 11 || temperatureAt(world, x, y, z) > 1.0) {
    breakNaturally(world, x, y, z, false);
    dropNamed(world, x, y, z, 'snowball', (meta & 7) + 1);
  }
}

/**
 * Snowfall and rain effects on a handful of random columns near the players.
 * Vanilla does this in its own weather pass rather than through random ticks.
 */
function tickWeatherBlocks(world, rng) {
  if (world.dimension !== DIM_OVERWORLD) return;
  const w = world.weather;
  if (!w || w.rain <= 0.2) return;
  const I = ids();
  let players = [];
  try { players = world.getPlayers ? world.getPlayers() : []; } catch { return; }
  if (!players.length) return;
  const p = players[rng.int(players.length)];
  const bx = flr(p.x), bz = flr(p.z);

  for (let i = 0; i < 8; i++) {
    const x = bx + rng.range(-24, 24);
    const z = bz + rng.range(-24, 24);
    if (!world.chunkAt(x, z)) continue;
    const y = world.getHeight(x, z);
    if (y <= 0 || y >= WORLD_HEIGHT - 1) continue;
    let biome = null;
    try { biome = world.biomeAt(x, z); } catch { biome = null; }
    if (!biome || biome.precipitation === 'none') continue;
    const snowy = biome.precipitation === 'snow' || temperatureAt(world, x, y, z) < 0.15;

    if (snowy) {
      // Pile up snow layers on flat ground.
      const under = world.getBlock(x, y - 1, z);
      const here = world.getBlock(x, y, z);
      if (here === I.snow) {
        const layers = world.getMeta(x, y, z) & 7;
        if (layers < 7 && rng.next() < 0.25) world.setBlock(x, y, z, I.snow, layers + 1, 3);
      } else if (here === 0 && I.snow && solidTop(world, x, y - 1, z) &&
        blockLight(world, x, y, z) < 10 && under !== I.ice) {
        world.setBlock(x, y, z, I.snow, 0, 3);
      }
      // Exposed water at the surface skims over with ice.
      if (world.getBlock(x, y - 1, z) === I.water && (world.getMeta(x, y - 1, z) & 15) === 0 &&
        blockLight(world, x, y, z) < 10 && I.ice) {
        world.setBlock(x, y - 1, z, I.ice, 0, 3);
      }
    } else {
      // Rain fills cauldrons and puts out fires.
      const here = world.getBlock(x, y, z);
      if (here === I.fire) world.setBlock(x, y, z, 0, 0, 3);
      const cid = world.getBlock(x, y - 1, z);
      if (cid === I.cauldron && I.water_cauldron && rng.next() < 0.05) {
        world.setBlock(x, y - 1, z, I.water_cauldron, 1, 3);
      } else if (cid === I.water_cauldron && rng.next() < 0.05) {
        const lv = world.getMeta(x, y - 1, z) & 3;
        if (lv < 3) world.setBlock(x, y - 1, z, I.water_cauldron, lv + 1, 3);
      }
    }
  }
}

// ===========================================================================
// 7. RANDOM TICK DISPATCH
// ===========================================================================

let RANDOM_HANDLERS = null;

function buildRandomHandlers() {
  if (RANDOM_HANDLERS) return RANDOM_HANDLERS;
  sets();
  const m = new Map();
  const put = (name, fn) => { const v = bid(name); if (v) m.set(v, fn); };

  for (const n of ['wheat', 'carrots', 'potatoes', 'beetroots', 'torchflower_crop', 'pitcher_crop',
    'nether_wart', 'melon_stem', 'pumpkin_stem']) put(n, tickCrop);

  for (const n of Object.keys(SAPLING_TREES)) put(n, tickSapling);

  put('grass_block', tickSpreadingSoil);
  put('mycelium', tickSpreadingSoil);
  put('podzol', tickSpreadingSoil);
  put('farmland', tickFarmland);
  put('sugar_cane', tickColumnPlant);
  put('cactus', tickColumnPlant);
  put('bamboo', tickColumnPlant);
  put('bamboo_sapling', tickBambooSapling);
  put('kelp', tickKelp);
  put('kelp_plant', tickKelp);
  put('vine', tickVine);
  put('cocoa', tickCocoa);
  put('sweet_berry_bush', tickBerries);
  put('chorus_flower', tickChorusFlower);
  put('brown_mushroom', tickMushroom);
  put('red_mushroom', tickMushroom);
  put('turtle_egg', tickTurtleEgg);
  put('budding_amethyst', tickBudding);
  put('sculk_catalyst', tickSculkCatalyst);
  put('pointed_dripstone', tickDripstone);
  put('fire', tickFire);
  put('soul_fire', tickFire);
  put('water', tickWaterFreeze);
  put('ice', tickIceMelt);
  put('frosted_ice', tickFrostedIce);
  put('snow', tickSnowMelt);
  put('twisting_vines', tickNetherVine);
  put('weeping_vines', tickNetherVine);
  put('cave_vines', tickCaveVine);
  put('cave_vines_plant', tickCaveVine);
  for (const name of OXIDATION.keys()) put(name, tickCopper);
  for (const lid of LEAF_IDS) m.set(lid, tickLeafDecay);

  RANDOM_HANDLERS = m;
  return m;
}

// ===========================================================================
// 8. CONTAINERS AND BLOCK ENTITIES
// ===========================================================================

/** How many slots each container block entity gets. */
const CONTAINER_SIZE = {
  chest: 27, trapped_chest: 27, ender_chest: 27, barrel: 27,
  furnace: 3, blast_furnace: 3, smoker: 3,
  dispenser: 9, dropper: 9, hopper: 5,
  brewing_stand: 5, beehive: 0, bee_nest: 0, lectern: 0,
  chiseled_bookshelf: 6, decorated_pot: 1, campfire: 4, soul_campfire: 4, jukebox: 1,
};

/** Screen name a block opens when right-clicked. */
const SCREEN_FOR_BLOCK = {
  crafting_table: 'crafting',
  furnace: 'furnace', blast_furnace: 'furnace', smoker: 'furnace',
  chest: 'chest', trapped_chest: 'chest', ender_chest: 'chest', barrel: 'chest',
  enchanting_table: 'enchanting',
  anvil: 'anvil', chipped_anvil: 'anvil', damaged_anvil: 'anvil',
  brewing_stand: 'brewing', beacon: 'beacon', loom: 'loom',
  stonecutter: 'stonecutter', grindstone: 'grindstone',
  smithing_table: 'smithing', cartography_table: 'cartography',
  hopper: 'hopper', dispenser: 'dispenser', dropper: 'dispenser',
  chiseled_bookshelf: 'chest',
};

/**
 * Blocks that need a record even though blocks.js gives them no `entityType`:
 * they still have to remember something across ticks.
 */
const EXTRA_BLOCK_ENTITIES = {
  campfire: 'campfire', soul_campfire: 'campfire',
  chiseled_bookshelf: 'chest', decorated_pot: 'chest', composter: 'composter',
};

/** Creates or tops up the block entity record a container needs. */
function ensureBlockEntity(world, x, y, z, id) {
  const def = getBlock(id);
  const type = def.entityType || EXTRA_BLOCK_ENTITIES[def.name] || null;
  if (!type) return null;
  let be = null;
  try { be = world.getBlockEntity(x, y, z); } catch { /* ignore */ }
  if (!be) {
    be = { type, block: def.name, x, y, z };
    try { world.setBlockEntity(x, y, z, be); } catch { return null; }
  }
  be.type = type;
  be.block = def.name;
  const size = CONTAINER_SIZE[def.name] !== undefined
    ? CONTAINER_SIZE[def.name]
    : (def.name.endsWith('_shulker_box') || def.name === 'shulker_box' ? 27 : 0);
  if (size > 0 && !be.items) be.items = new Array(size).fill(null);
  if (type === 'furnace') {
    if (be.burnTime === undefined) be.burnTime = 0;
    if (be.fuelTime === undefined) be.fuelTime = 0;
    if (be.cookTime === undefined) be.cookTime = 0;
    if (be.xp === undefined) be.xp = 0;
    be.kind = def.name === 'furnace' ? 'furnace' : def.name;
  }
  if (type === 'sign' && !be.lines) be.lines = ['', '', '', ''];
  if (type === 'note_block' && be.note === undefined) be.note = 0;
  if (type === 'jukebox' && be.record === undefined) be.record = null;
  if (type === 'lectern' && be.book === undefined) be.book = null;
  if (type === 'campfire' && !be.cooking) be.cooking = [null, null, null, null];
  _beShadow.set(beKey(x, y, z), be);
  return be;
}

function openScreen(name, ctx) {
  const ui = Game.ui;
  if (!ui || !ui.screens || typeof ui.screens.open !== 'function') return false;
  try { ui.screens.open(name, ctx); return true; } catch (e) {
    console.error('[blockupdate] open screen failed', name, e);
    return false;
  }
}

// ===========================================================================
// 9. RIGHT-CLICK INTERACTIONS
// ===========================================================================

function heldOf(player, hand) {
  if (!player) return null;
  if (hand === 'offhand' && player.getOffhandItem) return player.getOffhandItem();
  return player.getHeldItem ? player.getHeldItem() : null;
}

function isCreative(player) {
  return !!(player && (player.gameMode === 'creative' || player.gameMode === 'spectator'));
}

/** Removes a stack from the player's inventory once it is used up. */
function clearStack(player, s) {
  if (!player) return;
  if (typeof player.clearStack === 'function') { try { player.clearStack(s); return; } catch { /* fall through */ } }
  const inv = player.inventory;
  if (!inv) return;
  for (let i = 0; i < inv.size; i++) if (inv.get(i) === s) { inv.set(i, null); return; }
}

function shrink(player, s, n = 1) {
  if (!s || isCreative(player)) return;
  s.count -= n;
  if (s.count <= 0) clearStack(player, s);
  else if (player.inventory && player.inventory.markChanged) player.inventory.markChanged(-1);
}

function wear(player, s, n = 1) {
  if (!s || isCreative(player)) return;
  try { damageStack(s, n, player); } catch { /* optional */ }
}

function give(player, s) {
  if (!player || !s) return;
  try { giveOrDrop(player, s); } catch { /* optional */ }
}

/** Tool kind of the held stack ('axe', 'hoe', 'shovel', ...) or null. */
function toolKind(s) {
  if (isEmpty(s)) return null;
  const d = getItem(s.item);
  return d && d.tool ? d.tool.kind : null;
}

const STRIP_MAP = new Map();
const SCRAPE_MAP = new Map([
  ['oxidized_copper', 'weathered_copper'], ['weathered_copper', 'exposed_copper'], ['exposed_copper', 'copper_block'],
  ['oxidized_cut_copper', 'weathered_cut_copper'], ['weathered_cut_copper', 'exposed_cut_copper'], ['exposed_cut_copper', 'cut_copper'],
  ['oxidized_cut_copper_stairs', 'weathered_cut_copper_stairs'], ['weathered_cut_copper_stairs', 'exposed_cut_copper_stairs'], ['exposed_cut_copper_stairs', 'cut_copper_stairs'],
  ['oxidized_cut_copper_slab', 'weathered_cut_copper_slab'], ['weathered_cut_copper_slab', 'exposed_cut_copper_slab'], ['exposed_cut_copper_slab', 'cut_copper_slab'],
]);
let _stripBuilt = false;
function buildStripMap() {
  if (_stripBuilt) return;
  _stripBuilt = true;
  for (let i = 0; i < BLOCKS.length; i++) {
    const d = BLOCKS[i];
    if (!d) continue;
    const n = d.name;
    if (n.startsWith('stripped_')) continue;
    const s = 'stripped_' + n;
    if (blockByName(s)) STRIP_MAP.set(n, s);
  }
}

const TILLABLE = new Set(['dirt', 'grass_block', 'dirt_path', 'coarse_dirt', 'rooted_dirt', 'mycelium', 'podzol']);
const PATHABLE = new Set(['grass_block', 'dirt', 'coarse_dirt', 'podzol', 'mycelium', 'rooted_dirt']);

/** Plants a flower-pot's contents; meta 1..15 index into this list. */
const POTTED = ['dandelion', 'poppy', 'blue_orchid', 'allium', 'azure_bluet', 'red_tulip',
  'orange_tulip', 'white_tulip', 'pink_tulip', 'oxeye_daisy', 'cornflower',
  'lily_of_the_valley', 'brown_mushroom', 'red_mushroom', 'dead_bush'];

/** Items a composter accepts, with their fill chance. */
const COMPOSTABLE = new Map([
  ['beetroot_seeds', 0.3], ['dried_kelp', 0.3], ['short_grass', 0.3], ['kelp', 0.3],
  ['melon_seeds', 0.3], ['pumpkin_seeds', 0.3], ['sweet_berries', 0.3], ['wheat_seeds', 0.3],
  ['glow_berries', 0.3], ['moss_carpet', 0.3], ['hanging_roots', 0.3], ['small_dripleaf', 0.3],
  ['dried_kelp_block', 0.5], ['tall_grass', 0.5], ['flowering_azalea_leaves', 0.5],
  ['cactus', 0.5], ['dandelion', 0.65], ['poppy', 0.65], ['blue_orchid', 0.65],
  ['allium', 0.65], ['azure_bluet', 0.65], ['red_tulip', 0.65], ['orange_tulip', 0.65],
  ['white_tulip', 0.65], ['pink_tulip', 0.65], ['oxeye_daisy', 0.65], ['cornflower', 0.65],
  ['lily_of_the_valley', 0.65], ['wither_rose', 0.65], ['sunflower', 0.65], ['lilac', 0.65],
  ['rose_bush', 0.65], ['peony', 0.65], ['fern', 0.65], ['large_fern', 0.65],
  ['apple', 0.65], ['beetroot', 0.65], ['carrot', 0.65], ['melon_slice', 0.65],
  ['potato', 0.65], ['wheat', 0.65], ['sugar_cane', 0.5], ['vine', 0.5],
  ['lily_pad', 0.65], ['melon', 0.85], ['pumpkin', 0.85], ['bread', 0.85],
  ['baked_potato', 0.85], ['cookie', 0.85], ['hay_block', 0.85], ['brown_mushroom', 0.65],
  ['red_mushroom', 0.65], ['mushroom_stem', 0.65], ['nether_wart', 0.65],
  ['cake', 1.0], ['pumpkin_pie', 1.0],
]);

const DYE_COLORS = ['white', 'orange', 'magenta', 'light_blue', 'yellow', 'lime', 'pink',
  'gray', 'light_gray', 'cyan', 'purple', 'blue', 'brown', 'green', 'red', 'black'];
const DYE_HEX = [0xf9fffe, 0xf9801d, 0xc74ebd, 0x3ab3da, 0xfed83d, 0x80c71f, 0xf38baa,
  0x474f52, 0x9d9d97, 0x169c9c, 0x8932b8, 0x3c44aa, 0x835432, 0x5e7c16, 0xb02e26, 0x1d1d21];

/**
 * The block's own right-click behaviour.
 * @returns {boolean} true when the click was consumed
 */
export function useBlock(world, x, y, z, player, hand, face, hitX, hitY, hitZ) {
  if (!world) return false;
  const raw = world.getRaw(x, y, z);
  const id = raw & ID_MASK;
  if (id === 0) return false;
  const meta = (raw >>> 12) & 15;
  const def = getBlock(id);
  const name = def.name;
  const held = heldOf(player, hand);
  const heldName = isEmpty(held) ? null : held.item;
  const I = ids();

  // ---- doors, trapdoors, fence gates -------------------------------------
  if (def.model === 'door') {
    if (name.startsWith('iron')) return false;                   // redstone only
    const open = (meta & 8) !== 0;
    const baseY = (meta & 1) ? y - 1 : y;
    for (let i = 0; i < 2; i++) {
      const yy = baseY + i;
      if (world.getBlock(x, yy, z) !== id) continue;
      const m = world.getMeta(x, yy, z);
      world.setBlock(x, yy, z, id, open ? (m & ~8) : (m | 8), 3);
    }
    playAt(world, x, y, z, open ? 'door_close' : 'door_open', 0.9, 1);
    return true;
  }
  if (def.model === 'trapdoor' || def.model === 'fence_gate') {
    if (name.startsWith('iron')) return false;
    const open = (meta & 4) !== 0;
    world.setBlock(x, y, z, id, open ? (meta & ~4) : (meta | 4), 3);
    const wood = def.model === 'fence_gate';
    playAt(world, x, y, z, open
      ? (wood ? 'fence_gate_close' : 'trapdoor_close')
      : (wood ? 'fence_gate_open' : 'trapdoor_open'), 0.8, 1.05);
    return true;
  }

  // ---- buttons and levers -------------------------------------------------
  if (def.model === 'button') {
    if (meta & 8) return true;
    world.setBlock(x, y, z, id, meta | 8, 3);
    playAt(world, x, y, z, name.indexOf('stone') >= 0 || name.indexOf('blackstone') >= 0 ? 'button_stone' : 'button_wood', 0.5, 0.6);
    world.scheduleTick(x, y, z, name.indexOf('stone') >= 0 ? 20 : 30, id);
    return true;
  }
  if (def.model === 'lever') {
    world.setBlock(x, y, z, id, meta ^ 8, 3);
    playAt(world, x, y, z, 'lever', 0.4, (meta & 8) ? 0.5 : 0.6);
    return true;
  }

  // ---- beds ---------------------------------------------------------------
  if (def.model === 'bed') {
    if (world.dimension === DIM_NETHER || world.dimension === DIM_END) {
      world.setBlock(x, y, z, 0, 0, 3);
      const d = HFACE_DIRS[meta & 3] || [0, 0, 0];
      const head = (meta & 4) !== 0;
      const ox = head ? x - d[0] : x + d[0];
      const oz = head ? z - d[2] : z + d[2];
      if (world.getBlock(ox, y, oz) === id) world.setBlock(ox, y, oz, 0, 0, 3);
      if (_combat && _combat.explode) {
        try { _combat.explode(world, x + 0.5, y + 0.5, z + 0.5, 5, { fire: true, breakBlocks: true }); } catch { /* optional */ }
      }
      return true;
    }
    if (player && typeof player.sleepIn === 'function') {
      try { return !!player.sleepIn(x, y, z); } catch { return true; }
    }
    Game.toast('You can only sleep at night');
    return true;
  }

  // ---- containers and workstations ---------------------------------------
  const screen = SCREEN_FOR_BLOCK[name] ||
    (name.endsWith('_shulker_box') || name === 'shulker_box' ? 'chest' : null);
  if (screen) {
    ensureBlockEntity(world, x, y, z, id);
    const ctx = { x, y, z, player, block: name, world };
    if (screen === 'chest') {
      const pair = doubleChestPartner(world, x, y, z, id);
      if (pair) { ctx.pair = pair; ensureBlockEntity(world, pair.x, pair.y, pair.z, id); }
    }
    if (openScreen(screen, ctx)) {
      if (screen === 'chest') playAt(world, x, y, z, name === 'barrel' ? 'barrel_open' : 'chest_open', 0.6, 0.95);
      else if (screen === 'enchanting') playAt(world, x, y, z, 'enchant_table_use', 0.5, 1);
      return true;
    }
    return false;
  }

  // ---- jukebox ------------------------------------------------------------
  if (id === I.jukebox) {
    const be = ensureBlockEntity(world, x, y, z, id);
    if (be && be.record) {
      dropNamed(world, x, y + 1, z, be.record, 1);
      be.record = null;
      world.setBlock(x, y, z, id, 0, 3);
      playAt(world, x, y, z, 'jukebox_eject', 0.8, 1);
      Game.audio?.stop?.('record');
      return true;
    }
    if (heldName && heldName.startsWith('music_disc_')) {
      if (be) be.record = heldName;
      world.setBlock(x, y, z, id, 1, 3);
      shrink(player, held, 1);
      playAt(world, x, y, z, heldName, 1, 1);
      Game.toast('Now playing: ' + getItem(heldName).display);
      return true;
    }
    return false;
  }

  // ---- note block ---------------------------------------------------------
  if (id === I.note_block) {
    const be = ensureBlockEntity(world, x, y, z, id);
    const note = be ? ((be.note | 0) + 1) % 25 : 0;
    if (be) be.note = note;
    const instrument = noteInstrument(world, x, y - 1, z);
    playAt(world, x, y, z, instrument, 0.8, Math.pow(2, (note - 12) / 12));
    particlesAt('note', x + 0.5, y + 1.2, z + 0.5, { count: 1 });
    return true;
  }

  // ---- composter ----------------------------------------------------------
  if (id === I.composter) {
    const level = meta & 7;
    if (level === 7) {
      world.setBlock(x, y, z, id, 0, 3);
      dropNamed(world, x, y + 1, z, 'bone_meal', 1);
      playAt(world, x, y, z, 'composter_empty', 0.8, 1);
      return true;
    }
    if (!heldName) return false;
    const chance = COMPOSTABLE.get(heldName);
    if (chance === undefined) return false;
    shrink(player, held, 1);
    if (Math.random() < chance) {
      const next = Math.min(7, level + 1);
      world.setBlock(x, y, z, id, next, 3);
      playAt(world, x, y, z, next === 7 ? 'composter_ready' : 'composter_fill', 0.8, 1);
      particlesAt('cloud', x + 0.5, y + 0.9, z + 0.5, { count: 4, spread: 0.3 });
    } else {
      playAt(world, x, y, z, 'composter_fill', 0.6, 0.9);
    }
    return true;
  }

  // ---- cauldrons ----------------------------------------------------------
  if (id === I.cauldron || id === I.water_cauldron || id === I.lava_cauldron || id === I.powder_snow_cauldron) {
    if (useCauldron(world, x, y, z, player, held, id, meta)) return true;
    return false;
  }

  // ---- campfire cooking ---------------------------------------------------
  if (id === I.campfire || id === I.soul_campfire) {
    if (isEmpty(held)) return false;
    const r = smeltResult('campfire', heldName) || smeltResult('smoker', heldName);
    if (!r) return false;
    const be = ensureBlockEntity(world, x, y, z, id);
    if (!be) return false;
    if (!be.cooking) be.cooking = [null, null, null, null];
    for (let i = 0; i < 4; i++) {
      if (be.cooking[i]) continue;
      be.cooking[i] = { item: heldName, ticks: 600, output: r.output };
      shrink(player, held, 1);
      playAt(world, x, y, z, 'place_wood', 0.6, 1.2);
      return true;
    }
    return false;
  }

  // ---- bell ---------------------------------------------------------------
  if (id === I.bell) {
    playAt(world, x, y, z, 'bell_use', 1, 1);
    particlesAt('note', x + 0.5, y + 0.8, z + 0.5, { count: 2 });
    return true;
  }

  // ---- lectern ------------------------------------------------------------
  if (id === I.lectern) {
    const be = ensureBlockEntity(world, x, y, z, id);
    if (be && be.book) {
      if (!openScreen('book', { x, y, z, player, book: be.book, lectern: true })) {
        give(player, be.book);
        be.book = null;
        world.setBlock(x, y, z, id, meta & ~4, 3);
      }
      return true;
    }
    if (heldName === 'written_book' || heldName === 'writable_book' || heldName === 'book') {
      if (be) be.book = copyStack(held);
      shrink(player, held, 1);
      world.setBlock(x, y, z, id, meta | 4, 3);
      playAt(world, x, y, z, 'book_page_turn', 0.8, 1);
      return true;
    }
    return false;
  }

  // ---- respawn anchor -----------------------------------------------------
  if (id === I.respawn_anchor) {
    const charges = meta & 7;
    if (heldName === 'glowstone' && charges < 4) {
      shrink(player, held, 1);
      const n = charges + 1;
      world.setBlock(x, y, z, id, n | 8, 3);
      playAt(world, x, y, z, 'respawn_anchor_charge', 1, 1);
      return true;
    }
    if (charges > 0) {
      if (world.dimension === DIM_NETHER) {
        if (player) player.respawnPoint = { x: x + 0.5, y: y + 1, z: z + 0.5, dimension: DIM_NETHER };
        Game.toast('Respawn point set');
        playAt(world, x, y, z, 'respawn_anchor_charge', 0.6, 1.4);
      } else if (_combat && _combat.explode) {
        world.setBlock(x, y, z, 0, 0, 3);
        try { _combat.explode(world, x + 0.5, y + 0.5, z + 0.5, 5, { fire: true, breakBlocks: true }); } catch { /* optional */ }
      }
      return true;
    }
    return false;
  }

  // ---- TNT ----------------------------------------------------------------
  if (id === I.tnt && (heldName === 'flint_and_steel' || heldName === 'fire_charge')) {
    world.setBlock(x, y, z, 0, 0, 3);
    if (_itementity && _itementity.primeTNT) {
      try { _itementity.primeTNT(world, x, y, z, 80, player); } catch { /* optional */ }
    }
    playAt(world, x, y, z, 'fuse', 1, 1);
    if (heldName === 'fire_charge') shrink(player, held, 1); else wear(player, held, 1);
    return true;
  }

  // ---- dragon egg teleports when poked ------------------------------------
  if (id === I.dragon_egg) {
    for (let i = 0; i < 32; i++) {
      const tx = x + Math.floor(Math.random() * 31) - 15;
      const ty = clamp(y + Math.floor(Math.random() * 15) - 7, 1, WORLD_HEIGHT - 2);
      const tz = z + Math.floor(Math.random() * 31) - 15;
      if (world.getBlock(tx, ty, tz) !== 0) continue;
      world.setBlock(x, y, z, 0, 0, 3);
      world.setBlock(tx, ty, tz, id, meta, 3);
      particlesAt('portal', x + 0.5, y + 0.5, z + 0.5, { count: 24, spread: 0.8 });
      return true;
    }
    return true;
  }

  // ---- cake ---------------------------------------------------------------
  if (id === I.cake) {
    const bites = meta & 7;
    if (!player) return false;
    if (player.hunger !== undefined && player.hunger >= 20 && !isCreative(player)) return false;
    if (typeof player.addHunger === 'function') player.addHunger(2, 0.1);
    else if (player.hunger !== undefined) {
      player.hunger = Math.min(20, player.hunger + 2);
      player.saturation = Math.min(player.hunger, (player.saturation || 0) + 0.4);
    }
    playAt(world, x, y, z, 'eat', 0.7, 1);
    if (bites >= 6) world.setBlock(x, y, z, 0, 0, 3);
    else world.setBlock(x, y, z, id, bites + 1, 3);
    return true;
  }

  // ---- flower pot ---------------------------------------------------------
  if (id === I.flower_pot) {
    const cur = meta & 15;
    if (cur > 0) {
      dropNamed(world, x, y + 1, z, POTTED[cur - 1], 1);
      world.setBlock(x, y, z, id, 0, 3);
      playAt(world, x, y, z, 'dig_grass', 0.5, 1.2);
      return true;
    }
    if (!heldName) return false;
    const idx = POTTED.indexOf(heldName);
    if (idx < 0) return false;
    world.setBlock(x, y, z, id, idx + 1, 3);
    shrink(player, held, 1);
    playAt(world, x, y, z, 'place_grass', 0.6, 1.1);
    return true;
  }

  // ---- tools on blocks ----------------------------------------------------
  const kind = toolKind(held);
  if (kind === 'axe') {
    buildStripMap();
    const strip = STRIP_MAP.get(name);
    if (strip) {
      world.setBlock(x, y, z, bid(strip), meta, 3);
      playAt(world, x, y, z, 'axe_strip', 1, 1);
      wear(player, held, 1);
      return true;
    }
    if (name.startsWith('waxed_')) {
      const un = name.slice(6);
      if (blockByName(un)) {
        world.setBlock(x, y, z, bid(un), meta, 3);
        playAt(world, x, y, z, 'axe_wax_off', 1, 1);
        particlesAt('crit', x + 0.5, y + 0.5, z + 0.5, { count: 6, spread: 0.4 });
        wear(player, held, 1);
        return true;
      }
    }
    const scraped = SCRAPE_MAP.get(name);
    if (scraped) {
      world.setBlock(x, y, z, bid(scraped), meta, 3);
      playAt(world, x, y, z, 'axe_scrape', 1, 1);
      particlesAt('crit', x + 0.5, y + 0.5, z + 0.5, { count: 6, spread: 0.4 });
      wear(player, held, 1);
      return true;
    }
    return false;
  }
  if (kind === 'hoe' && TILLABLE.has(name) && face !== FACE_DOWN) {
    if (!emptyAbove(world, x, y, z)) return false;
    const out = (name === 'coarse_dirt' || name === 'rooted_dirt') ? 'dirt' : 'farmland';
    world.setBlock(x, y, z, bid(out), 0, 3);
    if (name === 'rooted_dirt') dropNamed(world, x, y + 1, z, 'hanging_roots', 1);
    playAt(world, x, y, z, 'hoe_till', 1, 1);
    wear(player, held, 1);
    return true;
  }
  if (kind === 'shovel' && PATHABLE.has(name) && face !== FACE_DOWN) {
    if (!emptyAbove(world, x, y, z)) return false;
    world.setBlock(x, y, z, I.dirt_path || bid('dirt_path'), 0, 3);
    playAt(world, x, y, z, 'shovel_flatten', 1, 1);
    wear(player, held, 1);
    return true;
  }
  if (heldName === 'honeycomb' && !name.startsWith('waxed_') && blockByName('waxed_' + name)) {
    world.setBlock(x, y, z, bid('waxed_' + name), meta, 3);
    playAt(world, x, y, z, 'place_copper', 1, 1);
    particlesAt('dust', x + 0.5, y + 0.5, z + 0.5, { count: 8, color: 0xdba213, spread: 0.4 });
    shrink(player, held, 1);
    return true;
  }

  return false;
}

/** True when nothing solid sits on top of a block (hoe / shovel guard). */
function emptyAbove(world, x, y, z) {
  const id = world.getBlock(x, y + 1, z);
  if (id === 0) return true;
  const d = getBlock(id);
  return d.replaceable && !d.liquid;
}

/** Note block instrument from the block underneath it. */
function noteInstrument(world, x, y, z) {
  const d = getBlock(world.getBlock(x, y, z));
  const s = d.sound;
  if (s === 'wood') return 'note_bass';
  if (s === 'sand' || s === 'gravel') return 'note_snare';
  if (s === 'glass') return 'note_hat';
  if (s === 'stone' || s === 'deepslate' || s === 'basalt') return 'note_basedrum';
  if (s === 'metal') return 'note_iron_xylophone';
  if (s === 'wool') return 'note_guitar';
  if (d.name === 'hay_block') return 'note_banjo';
  if (d.name === 'clay') return 'note_flute';
  if (d.name === 'bone_block') return 'note_xylophone';
  if (d.name === 'gold_block') return 'note_bell';
  if (d.name === 'packed_ice') return 'note_chime';
  if (d.name === 'emerald_block') return 'note_bit';
  if (d.name === 'pumpkin') return 'note_didgeridoo';
  return 'note_harp';
}

/** The other half of a double chest, or null. */
function doubleChestPartner(world, x, y, z, id) {
  const d = getBlock(id);
  if (d.name !== 'chest' && d.name !== 'trapped_chest') return null;
  for (let i = 0; i < 4; i++) {
    const nx = x + HDIRS[i][0], nz = z + HDIRS[i][1];
    if (world.getBlock(nx, y, nz) === id) return { x: nx, y, z: nz };
  }
  return null;
}

/** Fill, empty and dye interactions for all four cauldron blocks. */
function useCauldron(world, x, y, z, player, held, id, meta) {
  const I = ids();
  const item = isEmpty(held) ? null : held.item;
  const level = id === I.cauldron ? 0 : ((meta & 3) || 3);

  if (item === 'water_bucket' && id === I.cauldron) {
    world.setBlock(x, y, z, I.water_cauldron, 3, 3);
    if (!isCreative(player)) { shrink(player, held, 1); give(player, mkStack('bucket', 1)); }
    playAt(world, x, y, z, 'bucket_empty', 0.8, 1);
    return true;
  }
  if (item === 'lava_bucket' && id === I.cauldron) {
    world.setBlock(x, y, z, I.lava_cauldron, 3, 3);
    if (!isCreative(player)) { shrink(player, held, 1); give(player, mkStack('bucket', 1)); }
    playAt(world, x, y, z, 'bucket_empty_lava', 0.8, 1);
    return true;
  }
  if (item === 'powder_snow_bucket' && id === I.cauldron) {
    world.setBlock(x, y, z, I.powder_snow_cauldron, 3, 3);
    if (!isCreative(player)) { shrink(player, held, 1); give(player, mkStack('bucket', 1)); }
    playAt(world, x, y, z, 'bucket_empty', 0.8, 1);
    return true;
  }
  if (item === 'bucket' && level >= 3) {
    const filled = id === I.water_cauldron ? 'water_bucket'
      : id === I.lava_cauldron ? 'lava_bucket'
        : id === I.powder_snow_cauldron ? 'powder_snow_bucket' : null;
    if (!filled) return false;
    world.setBlock(x, y, z, I.cauldron, 0, 3);
    if (!isCreative(player)) { shrink(player, held, 1); give(player, mkStack(filled, 1)); }
    playAt(world, x, y, z, filled === 'lava_bucket' ? 'bucket_fill_lava' : 'bucket_fill', 0.8, 1);
    return true;
  }
  if (item === 'glass_bottle' && id === I.water_cauldron && level > 0) {
    setCauldronLevel(world, x, y, z, level - 1);
    if (!isCreative(player)) { shrink(player, held, 1); give(player, mkStack('potion', 1, { potion: 'water' })); }
    playAt(world, x, y, z, 'bucket_fill', 0.6, 1.3);
    return true;
  }
  if (item === 'potion' && id === I.cauldron) {
    world.setBlock(x, y, z, I.water_cauldron, 1, 3);
    if (!isCreative(player)) { shrink(player, held, 1); give(player, mkStack('glass_bottle', 1)); }
    playAt(world, x, y, z, 'bucket_empty', 0.6, 1.2);
    return true;
  }
  if (id === I.water_cauldron && level > 0 && item) {
    // A dip in the cauldron washes leather clean...
    if (item.startsWith('leather_') && held.color !== undefined) {
      delete held.color;
      setCauldronLevel(world, x, y, z, level - 1);
      playAt(world, x, y, z, 'bucket_fill', 0.5, 1.4);
      return true;
    }
    // ...and a dye plus a cauldron of water colours whatever leather is worn.
    if (item.endsWith('_dye')) {
      const target = findLeather(player);
      if (target && dyeInCauldron(target, item)) {
        shrink(player, held, 1);
        setCauldronLevel(world, x, y, z, level - 1);
        playAt(world, x, y, z, 'bucket_fill', 0.6, 1.5);
        particlesAt('dust', x + 0.5, y + 0.9, z + 0.5, { count: 8, spread: 0.3, color: target.color });
        return true;
      }
      return false;
    }
    // Banners lose their topmost pattern.
    if (item.endsWith('_banner') && held.patterns && held.patterns.length) {
      held.patterns.pop();
      setCauldronLevel(world, x, y, z, level - 1);
      playAt(world, x, y, z, 'bucket_fill', 0.5, 1.3);
      return true;
    }
  }
  if (id === I.lava_cauldron && player && player.hurt) {
    try { player.hurt(2, { type: 'lava', fire: true }); } catch { /* optional */ }
    return false;
  }
  return false;
}

function setCauldronLevel(world, x, y, z, level) {
  const I = ids();
  if (level <= 0) world.setBlock(x, y, z, I.cauldron, 0, 3);
  else world.setBlock(x, y, z, I.water_cauldron, level & 3, 3);
}

/** The first leather item the player has equipped or in hand, or null. */
function findLeather(player) {
  const inv = player && player.inventory;
  if (!inv) return null;
  if (typeof inv.getArmor === 'function') {
    for (let i = 0; i < 4; i++) {
      const s = inv.getArmor(i);
      if (s && s.item && s.item.startsWith('leather_')) return s;
    }
  }
  for (let i = 0; i < inv.size; i++) {
    const s = inv.get(i);
    if (s && s.item && s.item.startsWith('leather_')) return s;
  }
  return null;
}

/** Dyeing leather armour in a cauldron, exposed for the item hooks that need it. */
function dyeInCauldron(stack, dyeName) {
  const i = DYE_COLORS.indexOf(dyeName.replace(/_dye$/, ''));
  if (i < 0) return false;
  stack.color = DYE_HEX[i];
  return true;
}

// ===========================================================================
// 10. PLACE / BREAK
// ===========================================================================

/** The blocks a two-block structure needs its partner for. */
function placeSecondHalf(world, x, y, z, id, meta) {
  const def = getBlock(id);
  if (def.model === 'door' && world.getBlock(x, y + 1, z) !== id) {
    if (y + 1 < WORLD_HEIGHT && getBlock(world.getBlock(x, y + 1, z)).replaceable) {
      world.setBlock(x, y + 1, z, id, meta | 1, 3);
    }
  } else if (def.model === 'bed') {
    const d = HFACE_DIRS[meta & 3] || [0, 0, 0];
    const hx = x + d[0], hz = z + d[2];
    if ((meta & 4) === 0 && world.getBlock(hx, y, hz) !== id &&
      getBlock(world.getBlock(hx, y, hz)).replaceable) {
      world.setBlock(hx, y, hz, id, (meta & 3) | 4, 3);
    }
  } else if (TALL_PLANTS.has(def.name)) {
    if (world.getBlock(x, y + 1, z) !== id && getBlock(world.getBlock(x, y + 1, z)).replaceable) {
      world.setBlock(x, y + 1, z, id, meta | 8, 3);
    }
  }
}

const TALL_PLANTS = new Set(['sunflower', 'lilac', 'rose_bush', 'peony', 'tall_grass', 'large_fern',
  'tall_seagrass', 'pitcher_plant', 'big_dripleaf']);

/**
 * Post-placement bookkeeping: block entities, second halves, farmland damage
 * and the leaf "persistent" flag.
 */
export function onBlockPlaced(world, x, y, z, id, meta, placer) {
  if (!world) return;
  sets();
  const def = getBlock(id);
  if (!def || def.air) return;

  // Player-placed leaves must never decay.
  if (LEAF_IDS.has(id) && placer && !(meta & 8)) {
    world.setBlock(x, y, z, id, meta | 8, 1);
    meta |= 8;
  }

  placeSecondHalf(world, x, y, z, id, meta);

  if (def.entityType) {
    const be = ensureBlockEntity(world, x, y, z, id);
    if (be && placer) be.owner = placer.name || 'player';
  }

  // Stepping on farmland with a block ruins it.
  const belowId = world.getBlock(x, y - 1, z);
  if (belowId === ids().farmland && def.solid && def.collision === 'full') {
    world.setBlock(x, y - 1, z, ids().dirt, 0, 3);
  }

  if (def.gravity) world.scheduleTick(x, y, z, 2, id);
  if (def.liquid) world.scheduleTick(x, y, z, fluidDelay(world, id), id);
  if (!canSurvive(world, x, y, z, id, meta, def)) breakNaturally(world, x, y, z);

  rememberBlockEntity(world, x, y, z);
}

/**
 * Post-break bookkeeping: spill containers, remove the other half of doors,
 * beds and tall plants, and knock loose whatever was leaning on the block.
 */
export function onBlockBroken(world, x, y, z, id, meta, breaker) {
  if (!world) return;
  sets();
  const def = getBlock(id);
  if (!def) return;

  dropContainerContents(world, x, y, z);
  try { world.removeBlockEntity(x, y, z); } catch { /* already gone */ }
  _beShadow.delete(beKey(x, y, z));

  // Second halves. The player module clears most of these already, so each
  // branch checks before it writes.
  if (def.model === 'door') {
    const otherY = (meta & 1) ? y - 1 : y + 1;
    if (world.getBlock(x, otherY, z) === id) world.setBlock(x, otherY, z, 0, 0, 3);
  } else if (def.model === 'bed') {
    const d = HFACE_DIRS[meta & 3] || [0, 0, 0];
    const head = (meta & 4) !== 0;
    const ox = head ? x - d[0] : x + d[0];
    const oz = head ? z - d[2] : z + d[2];
    if (world.getBlock(ox, y, oz) === id) world.setBlock(ox, y, oz, 0, 0, 3);
  } else if (TALL_PLANTS.has(def.name)) {
    if (world.getBlock(x, y + 1, z) === id) world.setBlock(x, y + 1, z, 0, 0, 3);
    if (world.getBlock(x, y - 1, z) === id) world.setBlock(x, y - 1, z, 0, 0, 3);
  }

  // Columns of sugar cane, cactus, bamboo and kelp collapse from the break up.
  const I = ids();
  if (id === I.sugar_cane || id === I.cactus || id === I.bamboo ||
    id === I.kelp || id === I.kelp_plant || id === I.cave_vines || id === I.cave_vines_plant) {
    for (let dy = 1; dy < 32; dy++) {
      const above = world.getBlock(x, y + dy, z);
      if (above !== id && !(id === I.kelp && above === I.kelp_plant)) break;
      breakNaturally(world, x, y + dy, z);
    }
  }

  // Anything that was leaning on this block.
  checkAttachedNeighbours(world, x, y, z);
}

/** Pops off attached blocks around a position whose support just vanished. */
function checkAttachedNeighbours(world, x, y, z) {
  for (let f = 0; f < 6; f++) {
    const d = FACE_DIRS[f];
    const nx = x + d[0], ny = y + d[1], nz = z + d[2];
    if (ny < 0 || ny >= WORLD_HEIGHT) continue;
    const raw = world.getRaw(nx, ny, nz);
    const nid = raw & ID_MASK;
    if (nid === 0) continue;
    if (!NEEDS_SUPPORT[nid]) continue;
    const nd = getBlock(nid);
    if (!canSurvive(world, nx, ny, nz, nid, (raw >>> 12) & 15, nd)) breakNaturally(world, nx, ny, nz);
  }
}

// ===========================================================================
// 11. THE FOUR WORLD HOOKS
// ===========================================================================

/**
 * A neighbour of (x, y, z) changed. Re-checks support, fire, farmland and
 * nether portals; fluids and gravity are scheduled by world.js itself.
 */
export function neighborUpdate(world, x, y, z, fromX, fromY, fromZ) {
  if (!world) return;
  const raw = world.getRaw(x, y, z);
  const id = raw & ID_MASK;
  if (id === 0) return;
  sets();
  const meta = (raw >>> 12) & 15;
  const def = getBlock(id);
  const I = ids();

  if (NEEDS_SUPPORT[id] && !canSurvive(world, x, y, z, id, meta, def)) {
    breakNaturally(world, x, y, z);
    return;
  }

  // Farmland with something solid on top turns straight back into dirt.
  if (id === I.farmland) {
    const above = world.getBlock(x, y + 1, z);
    if (above !== 0) {
      const ad = getBlock(above);
      if (ad.solid && ad.collision === 'full') world.setBlock(x, y, z, I.dirt, 0, 3);
    }
    return;
  }

  if (id === I.fire || id === I.soul_fire) {
    const below = world.getBlock(x, y - 1, z);
    if (id === I.soul_fire) {
      const bn = bname(below);
      if (bn !== 'soul_sand' && bn !== 'soul_soil') world.setBlock(x, y, z, 0, 0, 3);
      return;
    }
    if (!blockIsSolid(below) && !anyFlammableNeighbour(world, x, y, z)) {
      world.setBlock(x, y, z, 0, 0, 3);
    }
    return;
  }

  // A broken portal frame collapses the whole portal.
  if (id === I.nether_portal) {
    if (!portalIntact(world, x, y, z)) removePortal(world, x, y, z);
    return;
  }

  // Concrete powder sets when it touches water.
  if (def.gravity && def.name.endsWith('_concrete_powder')) {
    for (let f = 0; f < 6; f++) {
      const d = FACE_DIRS[f];
      if (world.getBlock(x + d[0], y + d[1], z + d[2]) === I.water) {
        const solidName = def.name.replace('_powder', '');
        const sid = bid(solidName);
        if (sid) { world.setBlock(x, y, z, sid, 0, 3); return; }
      }
    }
  }

  if (def.liquid) world.scheduleTick(x, y, z, fluidDelay(world, id), id);
  else if (def.gravity) world.scheduleTick(x, y, z, 2, id);
}

/** True when a nether portal block still has frame or portal on both sides. */
function portalIntact(world, x, y, z) {
  const I = ids();
  const ok = (bx, by, bz) => {
    const b = world.getBlock(bx, by, bz);
    return b === I.nether_portal || b === I.obsidian || b === bid('crying_obsidian');
  };
  const axisX = world.getBlock(x - 1, y, z) === I.nether_portal || world.getBlock(x + 1, y, z) === I.nether_portal;
  if (axisX) return ok(x - 1, y, z) && ok(x + 1, y, z) && ok(x, y - 1, z) && ok(x, y + 1, z);
  return ok(x, y, z - 1) && ok(x, y, z + 1) && ok(x, y - 1, z) && ok(x, y + 1, z);
}

/** Flood-fills a broken portal away, bounded so a bug cannot run forever. */
function removePortal(world, x, y, z) {
  const I = ids();
  const queue = [x, y, z];
  const seen = new Set([x + ',' + y + ',' + z]);
  let head = 0, n = 0;
  while (head < queue.length && n < 256) {
    const cx = queue[head++], cy = queue[head++], cz = queue[head++];
    if (world.getBlock(cx, cy, cz) !== I.nether_portal) continue;
    world.setBlock(cx, cy, cz, 0, 0, 3);
    n++;
    for (let f = 0; f < 6; f++) {
      const d = FACE_DIRS[f];
      const nx = cx + d[0], ny = cy + d[1], nz = cz + d[2];
      const k = nx + ',' + ny + ',' + nz;
      if (seen.has(k)) continue;
      seen.add(k);
      queue.push(nx, ny, nz);
    }
  }
}

/**
 * A random block in a loaded subchunk. world.js passes an explicit position;
 * the contract's three-argument form picks one itself.
 */
export function randomTick(world, chunk, rng, x, y, z) {
  if (!world || !chunk) return;
  const r = rng || world.rng;
  if (x === undefined) {
    const n = (r.next() * 0xffffff) | 0;
    x = (chunk.cx << 4) + (n & 15);
    z = (chunk.cz << 4) + ((n >> 4) & 15);
    y = (n >> 8) % WORLD_HEIGHT;
  }
  const raw = world.getRaw(x, y, z);
  const id = raw & ID_MASK;
  if (id === 0) return;
  const def = getBlock(id);
  if (!def.ticksRandomly) {
    // Fluids are not flagged for random ticks, but they still freeze and burn.
    if (def.liquid === 'water') tickWaterFreeze(world, x, y, z, id, (raw >>> 12) & 15, def, r);
    else if (def.liquid === 'lava' && world.dimension !== DIM_END &&
      world.getBlock(x, y + 1, z) === 0) lavaFireCheck(world, x, y, z, r);
    return;
  }
  const handlers = buildRandomHandlers();
  const fn = handlers.get(id);
  if (!fn) return;
  fn(world, x, y, z, id, (raw >>> 12) & 15, def, r);
}

/**
 * A scheduled tick came due. Fluids, falling blocks and button release all
 * arrive here; the id argument is whatever is actually in the world now.
 */
export function scheduledTick(world, x, y, z, id) {
  if (!world || !id) return;
  sets();
  const def = getBlock(id);
  if (def.liquid) { fluidTick(world, x, y, z, id); return; }
  if (def.gravity) { tryFall(world, x, y, z, id); return; }
  if (def.model === 'button') {
    const meta = world.getMeta(x, y, z);
    if (meta & 8) {
      world.setBlock(x, y, z, id, meta & ~8, 3);
      playAt(world, x, y, z, def.name.indexOf('stone') >= 0 ? 'button_stone' : 'button_wood', 0.5, 0.5);
    }
    return;
  }
  const I = ids();
  if (id === I.fire || id === I.soul_fire) {
    tickFire(world, x, y, z, id, world.getMeta(x, y, z), def, world.rng);
    return;
  }
  // Anything else scheduled just gets its support re-checked.
  const meta = world.getMeta(x, y, z);
  if (NEEDS_SUPPORT[id] && !canSurvive(world, x, y, z, id, meta, def)) breakNaturally(world, x, y, z);
}

/**
 * The per-tick driver: resets the fluid budget, pushes entities along with the
 * current, runs weather effects and keeps the container shadow map warm.
 */
export function tickWorldBlocks(world, dt) {
  if (!world) return;
  loadDeps();
  sets();
  _fluidWork = 0;

  const rng = world.rng;

  try { pushEntitiesInFluids(world); } catch (e) { console.error('[blockupdate] fluid push failed', e); }

  if (--_snowTimer <= 0) {
    _snowTimer = 20;
    try { tickWeatherBlocks(world, rng); } catch (e) { console.error('[blockupdate] weather blocks failed', e); }
  }

  if (--_beSweep <= 0) {
    _beSweep = 60;
    try { sweepBlockEntities(world); } catch { /* optional */ }
  }

  try { tickCampfires(world); } catch { /* optional */ }
  try { tickFurnaces(world); } catch (e) { console.error('[blockupdate] furnaces', e); }
}

let _campfireTimer = 0;

/** Advances campfire cook timers and pops the finished food out. */
/**
 * Advances every loaded furnace, blast furnace and smoker.
 *
 * This used to live only in the furnace screen's update, so a furnace stopped
 * smelting the moment the player closed it - you had to stand and watch your
 * iron cook. The screen now only draws; the world owns the simulation.
 */
function tickFurnaces(world) {
  if (_beShadow.size === 0) return;
  for (const [key, be] of _beShadow) {
    if (!be || be.type !== 'furnace') continue;
    // world.setBlock creates a bare stub record; the slots only appear when
    // something opens the furnace. Fill them in so a placed furnace is tickable.
    if (!be.items) be.items = [null, null, null];
    const parts = key.split(',');
    const x = +parts[0], y = +parts[1], z = +parts[2];
    const id = world.getBlock(x, y, z);
    const def = getBlock(id);
    if (!def || def.entityType !== 'furnace') continue;
    tickOneFurnace(world, be, x, y, z, def);
  }
}

/** One furnace's burn and cook step. Mirrors vanilla's ordering. */
function tickOneFurnace(world, be, x, y, z, def) {
  const kind = be.kind || (def.name === 'blast_furnace' || def.name === 'smoker' ? def.name : 'furnace');
  const items = be.items;
  const input = items[0], fuel = items[1], out = items[2];
  const wasLit = (be.burnTime | 0) > 0;

  const recipe = input ? smeltResult(kind, input.item) : null;
  const made = recipe ? (recipe.count || 1) : 0;
  const canCook = !!recipe && (!out
    || (out.item === recipe.output && (out.count | 0) + made <= maxStackSize(out)));

  if (be.burnTime > 0) be.burnTime--;

  if (be.burnTime <= 0 && canCook && fuel) {
    const ticks = fuelTicks(fuel.item);
    if (ticks > 0) {
      be.burnTime = ticks;
      be.fuelTime = ticks;
      const rem = fuelRemainder(fuel.item);
      if ((fuel.count | 0) <= 1) items[1] = rem ? mkStack(rem, 1) : null;
      else fuel.count -= 1;
    }
  }

  if (be.burnTime > 0 && canCook) {
    be.cookTime = (be.cookTime | 0) + 1;
    const need = recipe.time || KIND_TIME[kind] || 200;
    if (be.cookTime >= need) {
      be.cookTime = 0;
      if (out) out.count = (out.count | 0) + made;
      else items[2] = mkStack(recipe.output, made);
      if ((input.count | 0) <= 1) items[0] = null;
      else input.count -= 1;
      be.xp = (be.xp || 0) + (smeltXp(kind, input.item) || 0) * made;
    }
  } else if (be.cookTime > 0) {
    be.cookTime = Math.max(0, be.cookTime - 2);
  }

  // Keep the block's lit variant in step so the world shows which furnaces run.
  const lit = (be.burnTime | 0) > 0;
  if (lit !== wasLit) {
    const want = blockByName(lit ? def.name + '_lit' : String(def.name).replace(/_lit$/, ''));
    if (want && want.id !== def.id) {
      world.setBlock(x, y, z, want.id, world.getMeta(x, y, z), 1);
    }
  }
}

function tickCampfires(world) {
  if (--_campfireTimer > 0) return;
  _campfireTimer = 10;
  if (_beShadow.size === 0) return;
  const I = ids();
  for (const [key, be] of _beShadow) {
    if (!be || !be.cooking) continue;
    const parts = key.split(',');
    const x = +parts[0], y = +parts[1], z = +parts[2];
    const id = world.getBlock(x, y, z);
    if (id !== I.campfire && id !== I.soul_campfire) {
      // world.setRaw only clears records for blocks with a declared entityType,
      // so a campfire that has been mined leaves one behind. Drop it here.
      be.cooking = null;
      _beShadow.delete(key);
      try { world.removeBlockEntity(x, y, z); } catch { /* already gone */ }
      continue;
    }
    for (let i = 0; i < be.cooking.length; i++) {
      const slot = be.cooking[i];
      if (!slot) continue;
      slot.ticks -= 10;
      if (slot.ticks > 0) continue;
      be.cooking[i] = null;
      dropNamed(world, x, y + 1, z, slot.output, 1);
      playAt(world, x, y, z, 'fire', 0.4, 1.4);
    }
    particlesAt('campfire_smoke', x + 0.5, y + 0.8, z + 0.5, { count: 1, vy: 0.4 });
  }
}

// ---------------------------------------------------------------------------
// Extras other modules may find useful. Not part of the contract's required
// surface, but harmless and cheap to expose.
// ---------------------------------------------------------------------------
export {
  breakNaturally, canSurvive, ensureBlockEntity, dyeInCauldron,
  growTree, updateFluid, doubleChestPartner,
};

export default {
  neighborUpdate, randomTick, scheduledTick, tickWorldBlocks,
  onBlockPlaced, onBlockBroken, useBlock,
};
