// ============================================================================
// spawning.js - Natural mob spawning, despawning and monster spawners.
//
// The shape of the vanilla algorithm, kept intact:
//
//   1. Pick a random chunk inside the 8-chunk (128 block) spawn radius around a
//      player, then a random column inside it, then walk down from a random
//      height until a spot with a floor under it turns up.
//   2. Refuse anything closer than 24 blocks to a player or to the world spawn.
//   3. Roll one mob from the biome's weighted table for that category.
//   4. Run the full spawn-condition check (dimension, y band, biome, light,
//      headroom, medium, the block underneath) at that spot.
//   5. Spawn a pack of `group[0]..group[1]` mobs with a small random spread,
//      re-checking every member.
//
// Per-category caps are counted over the whole loaded world and scaled by how
// much of a 17x17 chunk area is actually loaded, so a small render distance
// does not drown the player in zombies.
//
// Passive animals do not use that loop at all: like vanilla they arrive with
// the chunk (`spawnInitialAnimals`). `trySpawnMobs` also runs that pass lazily
// for populated chunks that never had one, so animals exist whether or not
// worldgen calls it. The chunk carries an `animalsSpawned` flag, so whichever
// caller gets there first wins and every later one is a no-op.
//
// Every cross-module call is optional-chained or wrapped: a missing particle
// system or a half-written neighbour must never stop mobs from spawning.
// ============================================================================

import { Game } from '../core/game.js';
import {
  WORLD_HEIGHT, SEA_LEVEL, DIFFICULTY, DIM_OVERWORLD, DIM_END,
} from '../core/constants.js';
import { clamp } from '../core/util.js';
import { RNG, hash3 } from '../core/rng.js';
import { getBlock as blockDef, blockByName } from '../world/blocks.js';
import { BIOMES, getBiome as biomeById } from '../world/biomes.js';
import { MOBS, createMob, mobsForBiome } from './mobs.js';

const flr = Math.floor;
const TAU = Math.PI * 2;

// ---------------------------------------------------------------------------
// Tuning
// ---------------------------------------------------------------------------

/** Vanilla per-category mob caps, before the loaded-area scale factor. */
export const SPAWN_CAPS = Object.freeze({
  hostile: 70,
  passive: 10,
  ambient: 15,
  water: 5,
});

/** Chunks either side of the player that natural spawning considers. */
const SPAWN_CHUNK_RADIUS = 8;                  // 128 blocks
/** Area the vanilla caps are expressed for: a 17x17 chunk square. */
const SPAWN_CHUNK_AREA = 17 * 17;              // 289
/** Nothing spawns naturally this close to a player or to the world spawn. */
const NO_SPAWN_RADIUS = 24;
/** Beyond this a non-persistent mob vanishes immediately. */
const DESPAWN_INSTANT = 128;
/** Between this and DESPAWN_INSTANT it vanishes on a dice roll. */
const DESPAWN_RANDOM = 32;
/**
 * despawnCheck runs every 40 ticks from world.tick, and vanilla rolls 1/800 per
 * tick, so one roll of 1/20 per call reproduces the same half-life.
 */
const RANDOM_DESPAWN_CHANCE = 1 / 20;
/** A mob has to have existed this long before the random roll applies. */
const DESPAWN_MIN_AGE = 600;

/** Pack attempts per call, per category. trySpawnMobs runs once a second. */
const ATTEMPTS = { hostile: 32, water: 10, ambient: 6 };
/** Hard ceiling on how many mobs one call may add per category. */
const PER_CALL = { hostile: 14, water: 6, ambient: 4 };
/** Condition-check options for the natural loop; see spawnPack for why. */
const SPAWN_CHECK_OPTS = Object.freeze({ ignoreDimension: true });
/** Horizontal jitter applied to the members of one pack. */
const PACK_SPREAD = 2.5;
/** How far down the column the floor search is allowed to walk. */
const GROUND_SEARCH_DEPTH = 48;

/** Ticks awake before phantoms start hunting (three in-game days). */
const PHANTOM_INSOMNIA = 72000;
/** Chance per spawn cycle that an eligible sleepless player draws phantoms. */
const PHANTOM_CHANCE = 0.06;

/** Baby chance for hostile mobs that have a baby form (vanilla zombies: 5%). */
const HOSTILE_BABY_CHANCE = 0.05;
/** Baby chance inside a worldgen animal herd. */
const ANIMAL_BABY_CHANCE = 0.1;

/** Spawner defaults, matching the vanilla block entity. */
const SPAWNER_DEFAULTS = {
  delay: 20, minDelay: 200, maxDelay: 800,
  spawnCount: 4, maxNearby: 6, requiredPlayerRange: 16, spawnRange: 4,
};

/** Surfaces no mob will ever stand on, whatever their collision box says. */
const BAD_SURFACES = new Set(['barrier', 'structure_void', 'light', 'moving_piston']);
/** Blocks that make a cell unsafe to materialise inside. */
const HAZARDS = new Set([
  'fire', 'soul_fire', 'cobweb', 'nether_portal', 'end_portal', 'end_gateway',
  'sweet_berry_bush', 'powder_snow', 'wither_rose',
]);
/** Mobs that stay put once they exist, however far the player wanders. */
const NEVER_DESPAWN = new Set([
  'villager', 'wandering_trader', 'trader_llama', 'iron_golem', 'snow_golem',
  'armor_stand', 'allay', 'sniffer', 'camel', 'warden', 'elder_guardian',
  'shulker', 'ender_dragon', 'wither',
]);

// ---------------------------------------------------------------------------
// Small shared helpers
// ---------------------------------------------------------------------------

/** Difficulty for this world, preferring a per-world override over Game. */
function difficultyOf(world) {
  const d = world && world.difficulty;
  if (typeof d === 'number') return d;
  try {
    const g = Game.difficulty;
    return typeof g === 'number' ? g : DIFFICULTY.NORMAL;
  } catch {
    return DIFFICULTY.NORMAL;
  }
}

/** Accepts a mob name or a definition and returns the definition (or null). */
function resolveDef(mobDef) {
  if (!mobDef) return null;
  if (typeof mobDef === 'string') return MOBS[mobDef] || null;
  return mobDef.spawn ? mobDef : (mobDef.name ? MOBS[mobDef.name] || null : null);
}

/**
 * Which cap a mob counts against.
 *
 * `def.category` describes *behaviour* ('neutral' covers endermen, wolves and
 * piglins alike), so it cannot decide the cap on its own: an enderman must
 * count as a monster and a wolf must not. The biome tables already draw that
 * line, so they are indexed once - hostile first, so a mob listed twice lands
 * in the stricter bucket - and the behavioural category is only the fallback.
 */
const CAP_ORDER = ['hostile', 'water', 'ambient', 'passive'];
let _capCategory = null;

function capCategoryFor(name, def) {
  if (!_capCategory) {
    _capCategory = new Map();
    try {
      for (let c = 0; c < CAP_ORDER.length; c++) {
        const cat = CAP_ORDER[c];
        for (let i = 0; i < BIOMES.length; i++) {
          const b = BIOMES[i];
          const list = b && b.mobs && b.mobs[cat];
          if (!list) continue;
          for (let k = 0; k < list.length; k++) {
            const e = list[k];
            const n = Array.isArray(e) ? e[0] : (e && (e.mob || e.name)) || e;
            if (typeof n === 'string' && !_capCategory.has(n)) _capCategory.set(n, cat);
          }
        }
      }
    } catch { /* a half-built biome registry just means more fallbacks */ }
  }
  const hit = name ? _capCategory.get(name) : undefined;
  if (hit) return hit;
  const c = def ? def.category : null;
  return c === 'neutral' ? 'passive' : c;
}

/** Category a live entity counts against. */
function categoryOf(e) {
  if (e.spawnCategory) return e.spawnCategory;
  return capCategoryFor(e.type || e.mobName, e.def);
}

/** True when this mob lives in a fluid rather than standing on blocks. */
function isAquatic(def) {
  if (def.waterMob) return true;
  if (def.category === 'water') return true;
  const b = def.spawn && def.spawn.block;
  return b === 'water' && !def.flying;
}

/** Spawns particles when the particle system is up. Never throws. */
function particles(type, x, y, z, opts) {
  try { Game.particles?.spawn?.(type, x, y, z, opts || {}); } catch { /* optional */ }
}

/** Long-lived per-world RNG for the spawn loop. */
const _rngs = new WeakMap();
function rngFor(world) {
  let r = _rngs.get(world);
  if (!r) {
    r = new RNG(hash3((world && world.seed) | 0, 0x5a7c, 0x17e5, 0x2b1c) || 1);
    _rngs.set(world, r);
  }
  return r;
}

/** Biome definition at a column, or null when it cannot be resolved. */
function biomeOf(world, x, z) {
  try {
    if (world.biomeAt) return world.biomeAt(x, z);
    if (world.getBiome) return biomeById(world.getBiome(x, z));
  } catch { /* unloaded or half-built */ }
  return null;
}

// ---------------------------------------------------------------------------
// Block predicates
// ---------------------------------------------------------------------------

/** A block a mob may stand on: full-cube collision, not a fluid, not glowing. */
function isSpawnableGround(id) {
  if (!id) return false;
  const d = blockDef(id);
  if (!d || !d.solid || d.liquid) return false;
  if (d.collision !== 'full') return false;
  if (d.light >= 14) return false;                  // vanilla: emission < 14
  if (BAD_SURFACES.has(d.name)) return false;
  if (d.name.length > 7 && d.name.endsWith('_leaves')) return false;
  return true;
}

/** True when an entity can occupy this cell: no collision and no fluid. */
function isFreeCell(world, x, y, z) {
  const id = world.getBlock(x, y, z);
  if (!id) return true;
  const d = blockDef(id);
  if (!d) return true;
  if (d.liquid) return false;
  if (HAZARDS.has(d.name)) return false;
  return !(d.solid && d.collision !== 'none');
}

/**
 * Light level the spawn rules are tested against. Overworld and Nether go
 * through World.getLight, whose sky term is already scaled by the time of day -
 * that is what makes hostiles a night-and-caves affair. The End's sky term is
 * pure ambience rather than daylight, so only block light counts there, which
 * is what lets endermen spawn on the main island at all.
 */
function spawnLightAt(world, x, y, z) {
  try {
    if (world.dimension === DIM_END) {
      return world.getBlockLight ? world.getBlockLight(x, y, z) : 0;
    }
    return world.getLight ? world.getLight(x, y, z) : 0;
  } catch {
    return 0;
  }
}

/** True when this cell holds a fluid (water anywhere, lava in the Nether). */
function isFluidAt(world, x, y, z) {
  const d = blockDef(world.getBlock(x, y, z));
  return !!d && !!d.liquid;
}

/**
 * The whole body has to fit: every cell the AABB touches must be free of
 * collision and, unless the mob is aquatic, free of fluid too.
 */
function areaClear(world, def, x, y, z, aquatic) {
  const hw = Math.max(0.15, (def.width || 0.6) / 2);
  const h = Math.max(0.5, def.height || 1);
  const x0 = flr(x - hw + 1e-4), x1 = flr(x + hw - 1e-4);
  const z0 = flr(z - hw + 1e-4), z1 = flr(z + hw - 1e-4);
  const y0 = flr(y + 1e-4), y1 = flr(y + h - 1e-4);
  if (y0 < 1 || y1 >= WORLD_HEIGHT) return false;
  for (let yy = y0; yy <= y1; yy++) {
    for (let zz = z0; zz <= z1; zz++) {
      for (let xx = x0; xx <= x1; xx++) {
        const id = world.getBlock(xx, yy, zz);
        if (!id) continue;
        const d = blockDef(id);
        if (!d) continue;
        if (d.liquid) {
          if (aquatic && d.liquid === 'water') continue;
          return false;
        }
        if (HAZARDS.has(d.name)) return false;
        if (d.solid && d.collision !== 'none') return false;
      }
    }
  }
  return true;
}

/**
 * The medium check: aquatic mobs need their fluid, lava walkers need lava
 * underfoot, flyers need nothing, everything else needs a solid floor - and,
 * when the definition names one, that exact block.
 */
function supportOk(world, def, bx, by, bz, aquatic) {
  const sp = def.spawn || {};
  const req = sp.block;
  if (aquatic) {
    const d = blockDef(world.getBlock(bx, by, bz));
    const want = req === 'lava' ? 'lava' : 'water';
    return !!d && d.liquid === want;
  }
  if (req === 'water' || req === 'lava') {
    const below = blockDef(world.getBlock(bx, by - 1, bz));
    return !!below && below.liquid === req;
  }
  if (def.flying) return true;
  const belowId = world.getBlock(bx, by - 1, bz);
  if (!isSpawnableGround(belowId)) return false;
  if (req) {
    const want = blockByName(req);
    if (want && belowId !== want.id) return false;
  }
  return true;
}

// ---------------------------------------------------------------------------
// Per-mob extra rules that do not fit in the generic definition fields
// ---------------------------------------------------------------------------

/** Husks, strays and phantoms only spawn under an open sky. */
function needsSky(world, def, x, y, z) {
  return world.canSeeSky ? !!world.canSeeSky(x, y, z) : true;
}

/**
 * Slimes: swamp surface at night, or a "slime chunk" below y=40 at any light.
 * The chunk hash is derived from the world seed exactly like vanilla's, just
 * with this project's hash function.
 */
function slimeRule(world, def, x, y, z) {
  if (y < 40) {
    const cx = x >> 4, cz = z >> 4;
    return (hash3((world.seed | 0) ^ 0x3ad8025f, cx, cz, 0) % 10) === 0;
  }
  if (y < 50 || y > 70) return false;
  const b = biomeOf(world, x, z);
  if (!b || (b.category !== 'swamp' && b.name.indexOf('swamp') < 0)) return false;
  return world.isNight ? !!world.isNight() : true;
}

const EXTRA_RULES = {
  husk: needsSky,
  stray: needsSky,
  phantom: needsSky,
  slime: slimeRule,
};

// ---------------------------------------------------------------------------
// Spawn condition check
// ---------------------------------------------------------------------------

/**
 * Can `mobDef` legally appear standing at (x, y, z)?
 *
 * Checks dimension, y band, biome list, difficulty, body clearance, headroom,
 * the medium/floor underneath, the light level and any per-mob extra rule.
 * The 24-block player exclusion is deliberately *not* here: it belongs to the
 * natural spawn loop, not to spawners or commands.
 *
 * @param {object} world
 * @param {object|string} mobDef definition from MOBS, or a mob name
 * @param {number} x @param {number} y @param {number} z feet position
 * @param {object} [opts] ignoreLight / ignoreY / ignoreBiome / ignoreSupport /
 *                        ignoreDifficulty / ignoreDimension escape hatches
 * @returns {boolean}
 */
export function canSpawnAt(world, mobDef, x, y, z, opts = {}) {
  const def = resolveDef(mobDef);
  if (!world || !def) return false;
  const sp = def.spawn || {};

  if (!opts.ignoreDimension && sp.dimension && sp.dimension !== world.dimension) return false;

  const bx = flr(x), by = flr(y), bz = flr(z);
  if (by < 1 || by >= WORLD_HEIGHT - 1) return false;

  if (!opts.ignoreY && sp.y && (by < sp.y[0] || by > sp.y[1])) return false;

  if (!opts.ignoreDifficulty
    && (def.category === 'hostile' || def.category === 'boss')
    && difficultyOf(world) === DIFFICULTY.PEACEFUL) return false;

  // Never spawn into a chunk that has not been generated: every block read
  // there would come back as air and the mob would fall out of the world.
  const chunk = world.getChunk ? world.getChunk(bx >> 4, bz >> 4) : null;
  if (!chunk || chunk.generated === false) return false;

  if (!opts.ignoreBiome && sp.biomes && sp.biomes.length) {
    const b = biomeOf(world, bx, bz);
    if (!b || sp.biomes.indexOf(b.name) < 0) return false;
  }

  const aquatic = isAquatic(def);
  if (!areaClear(world, def, x, y, z, aquatic)) return false;
  if (!opts.ignoreSupport && !supportOk(world, def, bx, by, bz, aquatic)) return false;

  if (!opts.ignoreLight && sp.light) {
    const light = spawnLightAt(world, bx, by, bz);
    if (light < sp.light[0] - 1e-6 || light > sp.light[1] + 1e-6) return false;
  }

  const extra = EXTRA_RULES[def.name];
  if (extra) {
    try { if (!extra(world, def, bx, by, bz)) return false; } catch { /* be permissive */ }
  }
  return true;
}

// ---------------------------------------------------------------------------
// Caps
// ---------------------------------------------------------------------------

/**
 * The current cap for one spawn category, scaled by how much of a 17x17 chunk
 * area is actually loaded. Returns 0 when the category cannot spawn at all
 * (hostiles on peaceful).
 * @param {object} world
 * @param {string} category 'hostile' | 'passive' | 'ambient' | 'water'
 * @returns {number}
 */
export function mobCap(world, category) {
  const base = SPAWN_CAPS[category];
  if (!base) return 0;
  if (category === 'hostile' && difficultyOf(world) === DIFFICULTY.PEACEFUL) return 0;
  const loaded = world && world.chunks ? world.chunks.size : 0;
  const f = clamp(loaded / SPAWN_CHUNK_AREA, 0.25, 1);
  return Math.max(1, Math.round(base * f));
}

/**
 * How many naturally-spawned mobs of a category are alive in this world.
 * Persistent, named and tamed mobs are excluded, exactly like vanilla's cap
 * accounting, so a farm full of named cows never blocks new spawns.
 * @param {object} world
 * @param {string} category
 * @returns {number}
 */
export function countMobs(world, category) {
  if (!world || !world.entities) return 0;
  const list = world.entities;
  let n = 0;
  for (let i = 0; i < list.length; i++) {
    const e = list[i];
    if (!e || e.removed || !e.isMob) continue;
    if (e.persistent || e.customName || e.tamed) continue;
    if (categoryOf(e) !== category) continue;
    n++;
  }
  return n;
}

// ---------------------------------------------------------------------------
// Position search
// ---------------------------------------------------------------------------

/**
 * Walks down from `yStart` until a cell with a floor under it and enough room
 * above shows up. Returns the feet y, or -1.
 */
function descendToGround(world, x, yStart, z, maxSteps) {
  let steps = 0;
  const top = Math.min(yStart, WORLD_HEIGHT - 3);
  for (let y = top; y > 1 && steps < maxSteps; y--, steps++) {
    if (!isSpawnableGround(world.getBlock(x, y - 1, z))) continue;
    if (!isFreeCell(world, x, y, z)) continue;
    if (!isFreeCell(world, x, y + 1, z)) continue;
    return y;
  }
  return -1;
}

/** Random candidate position inside one chunk, or null when nothing fits. */
function findSpawnPosition(world, category, cx, cz, rng) {
  const x = (cx << 4) + rng.int(16);
  const z = (cz << 4) + rng.int(16);
  let top = SEA_LEVEL;
  try { top = world.getHeight ? world.getHeight(x, z) : SEA_LEVEL; } catch { top = SEA_LEVEL; }
  top = clamp(top | 0, 2, WORLD_HEIGHT - 3);

  if (category === 'water') {
    // Lava counts too: the Nether's "water" table is where striders live.
    const hi = Math.max(2, Math.min(world.dimension === DIM_OVERWORLD ? SEA_LEVEL + 1 : WORLD_HEIGHT - 3, top));
    for (let i = 0; i < 10; i++) {
      const y = 1 + rng.int(hi);
      if (isFluidAt(world, x, y, z)) return { x, y, z };
    }
    return null;
  }

  // Start from a random height in the column - underground more often than not,
  // which is what fills caves - and fall to the first standable spot.
  const start = 1 + rng.int(Math.max(2, top + 3));
  const y = descendToGround(world, x, start, z, GROUND_SEARCH_DEPTH);
  if (y < 0) return null;
  return { x, y, z };
}

/**
 * Refreshes the shared player scratch list. Both entry points call this once
 * per invocation so the inner loops never re-allocate an array per candidate.
 */
const _playerScratch = [];
function collectPlayers(world, hint) {
  _playerScratch.length = 0;
  let list = null;
  try { list = world.getPlayers ? world.getPlayers() : null; } catch { list = null; }
  if (list) {
    for (let i = 0; i < list.length; i++) {
      const p = list[i];
      if (p && !p.removed) _playerScratch.push(p);
    }
  }
  if (!_playerScratch.length && hint && !hint.removed) _playerScratch.push(hint);
  return _playerScratch;
}

/**
 * The 24-block exclusion around players and the world spawn, plus the 128-block
 * outer limit that keeps spawns inside the simulated area.
 */
function positionAllowed(world, players, x, y, z) {
  if (!players.length) return false;
  let inRange = false;
  const near = NO_SPAWN_RADIUS * NO_SPAWN_RADIUS;
  const far = DESPAWN_INSTANT * DESPAWN_INSTANT;
  for (let i = 0; i < players.length; i++) {
    const p = players[i];
    const dx = p.x - x, dy = p.y - y, dz = p.z - z;
    const d = dx * dx + dy * dy + dz * dz;
    if (d < near) return false;
    if (d <= far) inRange = true;
  }
  if (!inRange) return false;
  const sp = world.spawnPoint;
  if (sp) {
    const dx = sp.x - x, dy = sp.y - y, dz = sp.z - z;
    if (dx * dx + dy * dy + dz * dz < near) return false;
  }
  return true;
}

// ---------------------------------------------------------------------------
// Biome spawn tables
// ---------------------------------------------------------------------------

const _tableCache = new Map();

/** Weighted, pre-filtered spawn table for one biome + category + dimension. */
function spawnTable(biome, category, dimension) {
  const key = (biome ? biome.id : -1) + '|' + category + '|' + dimension;
  const hit = _tableCache.get(key);
  if (hit) return hit;
  let raw = [];
  try { raw = mobsForBiome(biome || 0, category) || []; } catch { raw = []; }
  const out = [];
  for (let i = 0; i < raw.length; i++) {
    const e = raw[i];
    const def = e.def || MOBS[e.name];
    if (!def) continue;
    const sp = def.spawn || {};
    if (sp.natural === false) continue;
    const weight = e.weight | 0;
    if (weight <= 0) continue;
    // A biome that names a mob outright wins over the mob's own `dimension`
    // field - that is how endermen end up in the End without being re-declared.
    if (!biome && sp.dimension && sp.dimension !== dimension) continue;
    const group = sp.group || [1, 1];
    const min = Math.max(1, e.min ?? group[0] ?? 1);
    const max = Math.max(min, e.max ?? group[1] ?? min);
    out.push({ name: e.name, def, weight, min, max });
  }
  _tableCache.set(key, out);
  return out;
}

// ---------------------------------------------------------------------------
// Natural spawning
// ---------------------------------------------------------------------------

/** Creates one mob, returning it or null. Never throws. */
function makeMob(world, name, x, y, z, rng, opts) {
  try {
    const o = opts || {};
    if (o.yaw === undefined) o.yaw = rng.float(0, TAU);
    const m = createMob(name, world, x, y, z, o);
    if (m && o.spawnCategory) m.spawnCategory = o.spawnCategory;
    return m || null;
  } catch (e) {
    console.error('[spawning] createMob failed for ' + name, e);
    return null;
  }
}

/**
 * One pack attempt: a random chunk, a random column, a weighted mob and a
 * group of them with a small spread. Returns how many actually spawned.
 */
function spawnPack(world, player, players, category, rng, budget) {
  const pcx = flr(player.x) >> 4;
  const pcz = flr(player.z) >> 4;
  const cx = pcx + rng.range(-SPAWN_CHUNK_RADIUS, SPAWN_CHUNK_RADIUS);
  const cz = pcz + rng.range(-SPAWN_CHUNK_RADIUS, SPAWN_CHUNK_RADIUS);
  const chunk = world.getChunk ? world.getChunk(cx, cz) : null;
  if (!chunk || !chunk.generated) return 0;

  const pos = findSpawnPosition(world, category, cx, cz, rng);
  if (!pos) return 0;

  const px = pos.x + 0.5, pz = pos.z + 0.5;
  if (!positionAllowed(world, players, px, pos.y, pz)) return 0;

  const table = spawnTable(biomeOf(world, pos.x, pos.z), category, world.dimension);
  if (!table.length) return 0;
  const entry = rng.pickWeighted(table);
  if (!entry) return 0;

  // The biome table has already vetted the dimension pairing (a biome that
  // lists a mob outranks that mob's own `spawn.dimension`), so skip that test.
  const check = SPAWN_CHECK_OPTS;
  let baseY = pos.y;
  if (!canSpawnAt(world, entry.def, px, baseY, pz, check)) {
    // Striders walk on the lava rather than in it, so retry one block up.
    if (category !== 'water' || !canSpawnAt(world, entry.def, px, baseY + 1, pz, check)) return 0;
    baseY += 1;
  }

  const size = Math.min(budget, rng.range(entry.min, entry.max));
  const baby = !!entry.def.babyForm && category === 'hostile';
  let spawned = 0;
  for (let i = 0; i < size; i++) {
    let sx = px, sy = baseY, sz = pz, ok = i === 0;
    // The pack leader uses the validated spot; the rest scatter around it.
    for (let t = 0; !ok && t < 5; t++) {
      sx = px + rng.float(-PACK_SPREAD, PACK_SPREAD);
      sz = pz + rng.float(-PACK_SPREAD, PACK_SPREAD);
      const bx = flr(sx), bz = flr(sz);
      if (category === 'water') {
        sy = baseY + rng.range(-1, 1);
      } else {
        const gy = descendToGround(world, bx, baseY + 2, bz, 5);
        if (gy < 0) continue;
        sy = gy;
      }
      if (!positionAllowed(world, players, sx, sy, sz)) continue;
      ok = canSpawnAt(world, entry.def, sx, sy, sz, check);
    }
    if (!ok) continue;
    const m = makeMob(world, entry.name, sx, sy, sz, rng, {
      baby: baby && rng.chance(HOSTILE_BABY_CHANCE),
      spawnCategory: category,
    });
    if (m) spawned++;
  }
  return spawned;
}

/**
 * The natural spawn cycle. Called from World.tick roughly once a second for the
 * nearest player. Hostiles run on a fast cadence (they are the ones gated by
 * darkness), water and ambient mobs trickle; passive animals arrive with their
 * chunk instead. Returns how many mobs were added.
 * @param {object} world
 * @param {object} player
 * @returns {number}
 */
export function trySpawnMobs(world, player) {
  if (!world || !world.chunks || world.chunks.size === 0) return 0;
  if (world.gameRules && world.gameRules.doMobSpawning === false) return 0;
  let p = player;
  if (!p || p.removed) p = world.getPlayers ? world.getPlayers()[0] : null;
  if (!p) return 0;

  const rng = rngFor(world);
  const players = collectPlayers(world, p);
  let total = 0;

  // Chunks that reached the player without ever getting their worldgen animal
  // pass get one now, a few at a time so it never spikes a frame.
  total += runPendingAnimalPasses(world, p, rng);

  // Monster spawners are ticked from here so dungeons work even if no other
  // module drives block entities; spawnFromSpawner de-duplicates by tick.
  tickSpawners(world, p);

  const peaceful = difficultyOf(world) === DIFFICULTY.PEACEFUL;
  const cats = ['hostile', 'water', 'ambient'];
  for (let c = 0; c < cats.length; c++) {
    const category = cats[c];
    if (peaceful && category === 'hostile') continue;
    const cap = mobCap(world, category);
    if (cap <= 0) continue;
    const alive = countMobs(world, category);
    if (alive >= cap) continue;
    let budget = Math.min(PER_CALL[category], cap - alive);
    const attempts = ATTEMPTS[category];
    for (let i = 0; i < attempts && budget > 0; i++) {
      const n = spawnPack(world, p, players, category, rng, budget);
      budget -= n;
      total += n;
    }
  }

  if (world.dimension === DIM_OVERWORLD) {
    try { total += spawnPhantoms(world, p); } catch (e) { console.error('[spawning] phantoms', e); }
  }
  return total;
}

// ---------------------------------------------------------------------------
// Worldgen animal pass
// ---------------------------------------------------------------------------

/**
 * The one-off herd of animals a chunk is born with. Vanilla rolls this at
 * generation time, ignores light and ignores the mob cap; a generous soft cap
 * is kept here so a reloaded world cannot pile herds on top of each other.
 * Sets `chunk.animalsSpawned` so it only ever runs once per chunk.
 * @param {object} world
 * @param {object} chunk
 * @param {RNG} [rng] deterministic per-chunk RNG; one is derived when omitted
 * @returns {number} mobs spawned
 */
export function spawnInitialAnimals(world, chunk, rng = null) {
  if (!world || !chunk || chunk.animalsSpawned) return 0;
  chunk.animalsSpawned = true;
  if (world.dimension !== DIM_OVERWORLD) return 0;
  if (chunk.generated === false) return 0;

  const r = rng || new RNG(hash3((world.seed | 0) ^ 0x105ee, chunk.cx, chunk.cz, 0x21) || 1);

  let biome = null;
  try {
    biome = chunk.getBiome ? biomeById(chunk.getBiome(8, 8)) : null;
  } catch { biome = null; }
  if (!biome) biome = biomeOf(world, (chunk.cx << 4) + 8, (chunk.cz << 4) + 8);
  if (!biome) return 0;

  if (!r.chance(biome.spawnChance ?? 0.1)) return 0;

  // Soft cap: the pass ignores the live cap like vanilla, but not forever.
  if (countMobs(world, 'passive') >= mobCap(world, 'passive') * 2) return 0;

  const table = spawnTable(biome, 'passive', world.dimension);
  if (!table.length) return 0;
  const entry = r.pickWeighted(table);
  if (!entry) return 0;

  const ox = chunk.cx << 4, oz = chunk.cz << 4;
  const hx = r.int(16), hz = r.int(16);
  const size = r.range(entry.min, entry.max);
  const opts = { ignoreLight: true, ignoreDifficulty: true, ignoreDimension: true };
  let spawned = 0;

  for (let i = 0; i < size; i++) {
    for (let t = 0; t < 6; t++) {
      const lx = clamp(hx + r.range(-4, 4), 0, 15);
      const lz = clamp(hz + r.range(-4, 4), 0, 15);
      const x = ox + lx, z = oz + lz;
      let top = SEA_LEVEL;
      try { top = world.getHeight(x, z) | 0; } catch { top = SEA_LEVEL; }
      top = clamp(top, 2, WORLD_HEIGHT - 3);
      const y = descendToGround(world, x, top + 1, z, 6);
      if (y < 0) continue;
      if (!canSpawnAt(world, entry.def, x + 0.5, y, z + 0.5, opts)) continue;
      const m = makeMob(world, entry.name, x + 0.5, y, z + 0.5, r, {
        baby: !!entry.def.babyForm && r.chance(ANIMAL_BABY_CHANCE),
        spawnCategory: 'passive',
      });
      if (m) spawned++;
      break;
    }
  }
  return spawned;
}

/**
 * Runs the worldgen animal pass for a couple of nearby chunks that never had
 * one. Kept at least three chunks away so herds do not pop in under the
 * player's nose.
 */
function runPendingAnimalPasses(world, player, rng) {
  if (world.dimension !== DIM_OVERWORLD) return 0;
  const pcx = flr(player.x) >> 4, pcz = flr(player.z) >> 4;
  let done = 0, spawned = 0;
  for (let i = 0; i < 20 && done < 3; i++) {
    const dx = rng.range(-6, 6), dz = rng.range(-6, 6);
    if (Math.abs(dx) < 3 && Math.abs(dz) < 3) continue;
    const c = world.getChunk ? world.getChunk(pcx + dx, pcz + dz) : null;
    if (!c || !c.generated || !c.populated || c.animalsSpawned) continue;
    done++;
    try { spawned += spawnInitialAnimals(world, c, null); } catch (e) {
      console.error('[spawning] initial animals', e);
    }
  }
  return spawned;
}

// ---------------------------------------------------------------------------
// Phantoms
// ---------------------------------------------------------------------------

const _insomnia = new WeakMap();

/** Advances (or resets) a player's time-since-rest counter and returns it. */
function advanceInsomnia(world, player) {
  const now = (world.totalTime | 0);
  let rec = _insomnia.get(player);
  if (!rec) { rec = { ticks: 0, last: now }; _insomnia.set(player, rec); }
  let d = now - rec.last;
  if (d < 0) d = 0;
  if (d > 200) d = 200;                 // a long pause must not skip three days
  rec.last = now;
  if (player.sleeping || player.dead) rec.ticks = 0;
  else rec.ticks += d;
  return rec.ticks;
}

/**
 * Phantoms: a flight of 1..4 spawns high above a player who has been awake for
 * three in-game days, at night, under an open sky. Spawning resets the clock.
 * @param {object} world
 * @param {object} player
 * @returns {number} phantoms spawned
 */
export function spawnPhantoms(world, player) {
  if (!world || !player) return 0;
  if (world.dimension !== DIM_OVERWORLD) return 0;
  const def = MOBS.phantom;
  if (!def) return 0;

  const awake = advanceInsomnia(world, player);
  const diff = difficultyOf(world);
  if (diff === DIFFICULTY.PEACEFUL) return 0;
  if (awake < PHANTOM_INSOMNIA) return 0;
  if (world.isNight && !world.isNight()) return 0;

  const bx = flr(player.x), by = flr(player.y), bz = flr(player.z);
  if (world.canSeeSky && !world.canSeeSky(bx, by, bz)) return 0;

  const cap = mobCap(world, 'hostile');
  if (cap <= 0 || countMobs(world, 'hostile') >= cap) return 0;

  const rng = rngFor(world);
  if (!rng.chance(PHANTOM_CHANCE)) return 0;

  const cx = bx + rng.range(-6, 6) + 0.5;
  const cz = bz + rng.range(-6, 6) + 0.5;
  const cy = clamp(by + 20 + rng.int(15), 2, WORLD_HEIGHT - 4);
  const opts = { ignoreLight: true, ignoreY: true, ignoreSupport: true };
  const n = rng.range(1, Math.max(1, 1 + (diff | 0)));

  let spawned = 0;
  for (let i = 0; i < n; i++) {
    const x = cx + rng.float(-3, 3);
    const y = clamp(cy + rng.float(-2, 2), 2, WORLD_HEIGHT - 4);
    const z = cz + rng.float(-3, 3);
    if (!canSpawnAt(world, def, x, y, z, opts)) continue;
    const m = makeMob(world, 'phantom', x, y, z, rng, null);
    if (m) spawned++;
  }
  if (spawned) {
    const rec = _insomnia.get(player);
    if (rec) rec.ticks = 0;
  }
  return spawned;
}

// ---------------------------------------------------------------------------
// Monster spawners
// ---------------------------------------------------------------------------

/** Picks the next spawner delay from its configured band. */
function resetSpawnerDelay(be, rng) {
  const lo = be.minDelay ?? SPAWNER_DEFAULTS.minDelay;
  const hi = Math.max(lo, be.maxDelay ?? SPAWNER_DEFAULTS.maxDelay);
  return rng.range(lo, hi);
}

/**
 * Ticks one monster spawner block entity: the 16-block player check, the
 * spinning preview data the renderer reads, the smoke/flame ambience, four
 * spawn attempts inside a 4-block radius and a fresh 200..800 tick delay.
 *
 * Safe to call from more than one driver: the elapsed time is derived from
 * `world.totalTime`, so a second call in the same tick does nothing.
 *
 * @param {object} world
 * @param {number} x @param {number} y @param {number} z block position
 * @param {object} be the spawner block entity record
 * @returns {number} mobs spawned this call
 */
export function spawnFromSpawner(world, x, y, z, be) {
  if (!world || !be || !be.mob) return 0;

  const now = (world.totalTime | 0);
  let ticks = be._spawnerTick === undefined ? 1 : now - be._spawnerTick;
  if (ticks <= 0) return 0;
  if (ticks > 100) ticks = 100;
  be._spawnerTick = now;

  const cx = x + 0.5, cy = y + 0.5, cz = z + 0.5;
  const range = be.requiredPlayerRange ?? SPAWNER_DEFAULTS.requiredPlayerRange;
  const player = world.nearestPlayer ? world.nearestPlayer(cx, cy, cz, range) : null;

  if (be.delay === undefined || be.delay === null) be.delay = SPAWNER_DEFAULTS.delay;
  if (be.spin === undefined) { be.spin = 0; be.prevSpin = 0; }

  if (!player) {
    // Dormant: the preview stops turning but keeps its last angle.
    be.prevSpin = be.spin;
    be.active = false;
    return 0;
  }

  // --- spinning mob preview (degrees; renderers interpolate prev -> spin) ---
  be.active = true;
  be.displayMob = be.mob;
  be.prevSpin = be.spin;
  be.spin = (be.spin + (1000 / (Math.max(be.delay, 0) + 200)) * ticks) % 360;

  const rng = rngFor(world);
  if (rng.chance(0.6)) {
    particles('smoke', cx + (rng.next() - 0.5) * 0.9, y + 0.2 + rng.next() * 0.7, cz + (rng.next() - 0.5) * 0.9, { count: 1 });
    particles('flame', cx + (rng.next() - 0.5) * 0.8, y + 0.2 + rng.next() * 0.6, cz + (rng.next() - 0.5) * 0.8, { count: 1 });
  }

  if (be.delay > 0) {
    be.delay -= ticks;
    if (be.delay > 0) return 0;
  }

  const def = MOBS[be.mob];
  if (!def) { be.delay = resetSpawnerDelay(be, rng); return 0; }

  const spawnRange = be.spawnRange ?? SPAWNER_DEFAULTS.spawnRange;
  const maxNearby = be.maxNearby ?? SPAWNER_DEFAULTS.maxNearby;

  // Vanilla counts the same mob type inside a box twice the spawn range.
  let nearby = 0;
  try {
    const list = world.entitiesNear
      ? world.entitiesNear(cx, cy, cz, spawnRange * 2 + 1)
      : [];
    for (let i = 0; i < list.length; i++) {
      const e = list[i];
      if (e && !e.removed && e.type === be.mob) nearby++;
    }
  } catch { nearby = 0; }
  if (nearby >= maxNearby) { be.delay = resetSpawnerDelay(be, rng); return 0; }

  const count = be.spawnCount ?? SPAWNER_DEFAULTS.spawnCount;
  const opts = { ignoreY: true, ignoreBiome: true, ignoreSupport: true, ignoreDimension: true };
  let spawned = 0;
  for (let i = 0; i < count; i++) {
    const sx = cx + (rng.next() - rng.next()) * spawnRange;
    const sz = cz + (rng.next() - rng.next()) * spawnRange;
    const sy = y + rng.int(3) - 1;
    if (!canSpawnAt(world, def, sx, sy, sz, opts)) continue;
    const m = makeMob(world, be.mob, sx, sy, sz, rng, { fromSpawner: true });
    if (!m) continue;
    spawned++;
    particles('cloud', sx, sy + def.height * 0.5, sz, { count: 8, spread: 0.5 });
    particles('smoke', sx, sy + 0.3, sz, { count: 4, spread: 0.4 });
  }

  // Vanilla only re-rolls the long delay when something actually spawned;
  // a short retry keeps a blocked spawner from re-scanning every single tick.
  be.delay = spawned > 0 ? resetSpawnerDelay(be, rng) : 10;
  return spawned;
}

/** Drives every spawner in the chunks around the player. */
function tickSpawners(world, player) {
  const a = blockByName('spawner'), b = blockByName('trial_spawner');
  const idA = a ? a.id : -1, idB = b ? b.id : -1;
  const pcx = flr(player.x) >> 4, pcz = flr(player.z) >> 4;
  for (let dz = -2; dz <= 2; dz++) {
    for (let dx = -2; dx <= 2; dx++) {
      const c = world.getChunk ? world.getChunk(pcx + dx, pcz + dz) : null;
      if (!c || !c.blockEntities || c.blockEntities.size === 0) continue;
      for (const [i, be] of c.blockEntities) {
        if (!be || !be.mob) continue;
        const x = (c.cx << 4) + (i & 15);
        const y = i >> 8;
        const z = (c.cz << 4) + ((i >> 4) & 15);
        const id = world.getBlock(x, y, z);
        if (id !== idA && id !== idB) continue;
        try { spawnFromSpawner(world, x, y, z, be); } catch (e) {
          console.error('[spawning] spawner failed', e);
        }
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Despawning
// ---------------------------------------------------------------------------

/** Named, tamed, leashed, spawner-persisted and structural mobs stay forever. */
function canDespawn(e) {
  if (e.persistent || e.customName || e.tamed || e.leashedTo) return false;
  if (e.noDespawn || e.persistenceRequired) return false;
  const def = e.def;
  if (!def) return false;
  if (def.boss || def.category === 'boss') return false;
  if (NEVER_DESPAWN.has(def.name)) return false;
  return true;
}

/** Distance-squared from an entity to the closest player, or -1 when none. */
function playerDistSq(players, e) {
  let best = -1;
  for (let i = 0; i < players.length; i++) {
    const p = players[i];
    if (!p || p.removed) continue;
    const dx = p.x - e.x, dy = p.y - e.y, dz = p.z - e.z;
    const d = dx * dx + dy * dy + dz * dz;
    if (best < 0 || d < best) best = d;
  }
  return best;
}

/**
 * Removes mobs that have wandered out of relevance: instantly past 128 blocks,
 * on a dice roll between 32 and 128 once they have existed long enough, and
 * never for named, tamed, leashed or persistence-required mobs.
 * @param {object} world
 * @param {object} player the player World.tick picked; other players count too
 * @returns {number} mobs removed
 */
export function despawnCheck(world, player) {
  if (!world || !world.entities) return 0;
  const list = world.entities;
  if (!list.length) return 0;
  const players = collectPlayers(world, player);
  const rng = rngFor(world);
  const peaceful = difficultyOf(world) === DIFFICULTY.PEACEFUL;
  if (!players.length && !peaceful) return 0;
  const instant = DESPAWN_INSTANT * DESPAWN_INSTANT;
  const rand = DESPAWN_RANDOM * DESPAWN_RANDOM;
  let removed = 0;

  for (let i = 0; i < list.length; i++) {
    const e = list[i];
    if (!e || e.removed || !e.isMob) continue;

    // Peaceful wipes monsters out wherever they are, name tag or not - the one
    // rule that overrides persistence, exactly like vanilla.
    if (peaceful && !e.def?.boss && categoryOf(e) === 'hostile') {
      try { e.remove(); } catch { e.removed = true; }
      removed++;
      continue;
    }
    if (!canDespawn(e)) continue;

    const d = playerDistSq(players, e);
    if (d < 0) continue;                       // nobody around: leave it alone

    if (d > instant) {
      try { e.remove(); } catch { e.removed = true; }
      removed++;
      continue;
    }
    if (d > rand
      && (e.noDespawnTicks ?? e.age ?? 0) > DESPAWN_MIN_AGE
      && rng.chance(RANDOM_DESPAWN_CHANCE)) {
      try { e.remove(); } catch { e.removed = true; }
      removed++;
    }
  }
  return removed;
}

export default {
  trySpawnMobs, despawnCheck, spawnFromSpawner, canSpawnAt,
  spawnInitialAnimals, mobCap, countMobs, spawnPhantoms, SPAWN_CAPS,
};
