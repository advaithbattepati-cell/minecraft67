// ============================================================================
// loot.js - Block drops, mob drops and chest loot tables.
//
// Three entry points matter to the rest of the game:
//   blockDrops(world, x, y, z, id, meta, tool, player) -> ItemStack[]
//   mobDrops(mob, source, looting)                     -> ItemStack[]
//   chestLoot(tableName, rng)                          -> ItemStack[]
//
// Block drops are *routed through the block definition's own `drops` field*
// (see world/blocks.js) - this module supplies the silk-touch / fortune /
// tool-tier context those functions read, and applies the standard vanilla
// fortune formulas for the plain string and array drop shapes that blocks.js
// leaves to us.
//
// Nothing here touches the DOM, three.js or Game.* at module scope, so
// tools/validate.mjs can import it in plain Node.
// ============================================================================
import { RNG } from '../core/rng.js';
import { clamp } from '../core/util.js';
import { getBlock } from '../world/blocks.js';
import { getItem } from './items.js';
import { stack as mkStack } from './inventory.js';
import {
  ENCHANTMENT_LIST, applyEnchant, enchantWithLevels, randomBookEnchant,
  applicableEnchantments, getEnchant,
} from './enchanting.js';

// ---------------------------------------------------------------------------
// Lazy sibling modules
//
// entity/mobs.js pulls in the whole entity graph, and entity.js already
// dynamically imports *us*. Resolving MOBS lazily keeps loot.js cheap to load
// and free of static cycles; every caller hands us a live mob anyway, so the
// registry is only a fallback for `mobDrops('zombie', ...)`.
// ---------------------------------------------------------------------------
let _mobs = null;
let _mobsTried = false;
function mobRegistry() {
  if (_mobs || _mobsTried) return _mobs;
  _mobsTried = true;
  try { import('../entity/mobs.js').then((m) => { _mobs = m; }).catch(() => { /* optional */ }); }
  catch { /* no dynamic import */ }
  return _mobs;
}

// ---------------------------------------------------------------------------
// RNG plumbing. Callers pass an RNG, a bare function, a numeric seed or
// nothing at all; everything downstream wants the RNG interface.
// ---------------------------------------------------------------------------

// One shared generator for callers that do not supply their own. Block breaks
// happen on the hot path, so we must not allocate an RNG per drop.
let _sharedRng = null;
function sharedRng() {
  if (!_sharedRng) _sharedRng = new RNG(((Math.random() * 0x7fffffff) | 0) || 1);
  return _sharedRng;
}

/** Coerces whatever the caller gave us into something with the RNG API. */
function wrapRng(rng) {
  if (rng && typeof rng.next === 'function' && typeof rng.range === 'function') return rng;
  if (typeof rng === 'function') {
    const r = new RNG(1);
    r.next = rng;
    return r;
  }
  if (typeof rng === 'number') return new RNG(rng >>> 0 || 1);
  if (rng && typeof rng.next === 'function') {
    // An RNG-ish object missing the convenience helpers.
    const r = new RNG(1);
    r.next = () => rng.next();
    return r;
  }
  return sharedRng();
}

/** Inclusive integer in [min, max]. */
function rInt(r, min, max) {
  if (max === undefined || max === null) max = min;
  if (min >= max) return min | 0;
  return (min | 0) + Math.floor(r.next() * ((max | 0) - (min | 0) + 1));
}

/** Resolves a count spec: a number, `[min, max]` or `{min, max}`. */
function countOf(spec, r, fallback = 1) {
  if (spec === undefined || spec === null) return fallback;
  if (typeof spec === 'number') return spec | 0;
  if (Array.isArray(spec)) return rInt(r, spec[0], spec.length > 1 ? spec[1] : spec[0]);
  if (typeof spec === 'object') return rInt(r, spec.min | 0, spec.max === undefined ? spec.min | 0 : spec.max | 0);
  return fallback;
}

/** Weighted pick over entries carrying a numeric `weight`. */
function pickWeighted(entries, r) {
  let total = 0;
  for (let i = 0; i < entries.length; i++) total += entries[i].weight > 0 ? entries[i].weight : 0;
  if (total <= 0) return null;
  let x = r.next() * total;
  for (let i = 0; i < entries.length; i++) {
    const w = entries[i].weight > 0 ? entries[i].weight : 0;
    x -= w;
    if (x <= 0) return entries[i];
  }
  return entries[entries.length - 1];
}

// ---------------------------------------------------------------------------
// Stack construction
// ---------------------------------------------------------------------------

/** Maximum stack size for an item name. */
function maxStack(name) {
  const d = getItem(name);
  const n = d && d.stack ? d.stack | 0 : 64;
  return n > 0 ? n : 64;
}

/** Full durability of an item name, 0 when it has none. */
function durabilityOf(name) {
  const d = getItem(name);
  return d && d.durability ? d.durability | 0 : 0;
}

/**
 * Builds one ItemStack through inventory.stack(), tolerating a missing
 * inventory implementation by degrading to the plain stack shape.
 */
function st(item, count = 1, extra = null) {
  if (!item) return null;
  const n = count | 0;
  if (n <= 0) return null;
  let s = null;
  try { s = mkStack(item, n, extra); } catch { s = null; }
  if (!s) s = { item, count: n, damage: 0 };
  if (s.count !== n) s.count = n;
  if (s.damage === undefined) s.damage = 0;
  return s;
}

/** Pushes `count` of `item` onto `out`, splitting at the max stack size. */
function push(out, item, count, extra = null) {
  let n = count | 0;
  if (!item || n <= 0) return out;
  const cap = maxStack(item);
  while (n > 0) {
    const take = Math.min(cap, n);
    const s = st(item, take, extra);
    if (s) out.push(s);
    n -= take;
  }
  return out;
}

/** Converts one of blocks.js's `{item, count, damage}` literals into a stack. */
function fromRaw(raw) {
  if (!raw) return null;
  if (typeof raw === 'string') return st(raw, 1);
  if (!raw.item) return null;
  const s = st(raw.item, raw.count === undefined ? 1 : raw.count);
  if (!s) return null;
  if (raw.damage) s.damage = raw.damage | 0;
  if (raw.enchants || raw.enchantments) {
    const src = raw.enchants || raw.enchantments;
    for (const k of Object.keys(src)) applyEnchant(s, k, src[k]);
  }
  if (raw.extra && typeof raw.extra === 'object') Object.assign(s, raw.extra);
  return s;
}

// ---------------------------------------------------------------------------
// Enchantment helpers
// ---------------------------------------------------------------------------

/**
 * Enchants a stack the way loot tables do.
 * With a `level` it runs the vanilla "enchant with levels" roll (treasure
 * enchantments included, as loot chests allow them). Without one it picks a
 * single applicable enchantment at a random legal level.
 */
export function enchantRandomly(stack, rng, level) {
  if (!stack || !stack.item) return stack;
  const r = wrapRng(rng);
  if (level !== undefined && level !== null && (level | 0) > 0) {
    try { return enchantWithLevels(stack, level | 0, r, true); } catch { /* fall through */ }
  }
  const name = stack.item;
  if (name === 'book' || name === 'enchanted_book') {
    const e = randomBookEnchant(r, true);
    if (e) applyEnchant(stack, e.name, e.level);
    return stack;
  }
  let pool = [];
  try { pool = applicableEnchantments(name, true); } catch { pool = []; }
  if (!pool.length) pool = ENCHANTMENT_LIST.filter((e) => !e.curse);
  if (!pool.length) return stack;
  const chosen = pickWeighted(pool.map((e) => ({ weight: e.weight || 1, def: e })), r);
  const def = chosen ? chosen.def : pool[0];
  if (def) applyEnchant(stack, def.name, rInt(r, 1, def.maxLevel || 1));
  return stack;
}

/** Rolls a random durability loss in [minPct, maxPct] of the item's max. */
function applyDamage(stack, spec, r) {
  if (!stack || !spec) return stack;
  const max = durabilityOf(stack.item);
  if (max <= 1) return stack;
  const lo = Array.isArray(spec) ? spec[0] : 0;
  const hi = Array.isArray(spec) ? (spec.length > 1 ? spec[1] : spec[0]) : spec;
  const frac = lo + (hi - lo) * r.next();
  stack.damage = clamp(Math.floor(frac * (max - 1)), 0, max - 1);
  return stack;
}

// ===========================================================================
// 1. Block drops
// ===========================================================================

// Which tool kinds can stand in for another. Shears cut cobwebs, and a sword
// counts as shears for the plant blocks vanilla lets swords harvest.
const TOOL_SUBSTITUTES = {
  sword: ['shears'],
  shears: ['sword'],
};

/** Vanilla ore fortune: count * (1 + max(0, randInt(fortune + 2) - 1)). */
function fortuneOre(count, fortune, r) {
  const f = fortune | 0;
  if (f <= 0 || count <= 0) return count;
  let bonus = Math.floor(r.next() * (f + 2)) - 1;
  if (bonus < 0) bonus = 0;
  return count * (bonus + 1);
}

/**
 * Vanilla `binomial_with_bonus_count`: `extra + fortune` Bernoulli trials at
 * probability `p`, each success adding one. Used by crops and grass seeds.
 */
function fortuneBinomial(count, fortune, r, p = 0.5714286, extra = 3) {
  const trials = (extra | 0) + (fortune | 0);
  let n = count | 0;
  for (let i = 0; i < trials; i++) if (r.next() < p) n++;
  return n;
}

/** Vanilla `uniform_bonus_count`: adds 0..fortune*multiplier, optional cap. */
function fortuneUniform(count, fortune, r, multiplier = 1, cap = 0) {
  const f = fortune | 0;
  if (f <= 0) return count;
  let n = (count | 0) + Math.floor(r.next() * (f * multiplier + 1));
  if (cap > 0 && n > cap) n = cap;
  return n;
}

/** Reads the tool kind / tier out of whatever the caller passed as `tool`. */
function toolInfo(tool) {
  let name = null;
  let stack = null;
  if (typeof tool === 'string') name = tool;
  else if (tool && typeof tool === 'object') {
    stack = tool;
    name = tool.item || tool.name || null;
  }
  if (!name) return { name: null, stack: null, kind: null, tier: -1, speed: 1 };
  const def = getItem(name);
  const t = def && def.tool ? def.tool : null;
  return {
    name,
    stack,
    kind: t ? t.kind : null,
    tier: t ? (t.tier === undefined ? 0 : t.tier) : -1,
    speed: t && t.speed ? t.speed : 1,
  };
}

/**
 * True when this tool is good enough for the block to drop anything.
 * Blocks without `requiresTool` always drop; blocks with it need the right
 * tool kind at or above the block's tier.
 */
export function canHarvest(blockDef, tool) {
  if (!blockDef) return true;
  if (!blockDef.requiresTool) return true;
  const info = toolInfo(tool);
  const need = blockDef.tool;
  if (!need) return true;
  if (!info.kind) return false;
  if (info.kind !== need) {
    const subs = TOOL_SUBSTITUTES[need];
    if (!subs || subs.indexOf(info.kind) < 0) return false;
  }
  // Golden tools sit at tier 0 but mine like stone; the registry already
  // encodes that, so a plain numeric compare is enough.
  return info.tier >= (blockDef.tier | 0);
}

// Items whose block source is an ore: the classic fortune multiplier applies
// when blocks.js hands us a bare string instead of a drop function.
const ORE_PRODUCTS = new Set([
  'coal', 'diamond', 'emerald', 'lapis_lazuli', 'redstone', 'quartz', 'amethyst_shard',
  'raw_iron', 'raw_copper', 'raw_gold', 'nether_quartz',
]);

/** Picks the vanilla fortune formula for a generic (non-function) drop. */
function applyGenericFortune(blockDef, item, count, fortune, r) {
  if ((fortune | 0) <= 0) return count;
  if (blockDef && /_ore$/.test(blockDef.name) && item !== blockDef.name) {
    return fortuneOre(count, fortune, r);
  }
  if (ORE_PRODUCTS.has(item)) return fortuneOre(count, fortune, r);
  if (/_seeds$/.test(item)) return fortuneBinomial(count, fortune, r);
  return count;
}

/**
 * Every stack a block yields when broken.
 *
 * `tool` may be an ItemStack, an item name or null. `player` is optional and
 * only consulted for the creative-mode short circuit.
 *
 * @returns {Array} freshly built ItemStacks (possibly empty)
 */
export function blockDrops(world, x, y, z, id, meta = 0, tool = null, player = null) {
  const def = typeof id === 'object' && id ? id : getBlock(id);
  if (!def || def.air) return [];
  if (player && (player.gameMode === 'creative' || player.gameMode === 'spectator')) return [];

  const info = toolInfo(tool);
  const stack = info.stack;
  const silkTouch = stack ? getEnchant(stack, 'silk_touch') > 0 : false;
  const fortune = stack ? getEnchant(stack, 'fortune') | 0 : 0;
  const r = wrapRng(world && world.lootRng ? world.lootRng : null);

  if (!canHarvest(def, tool)) return [];

  const ctx = {
    block: def,
    blockId: def.id,
    id: def.id,
    name: def.name,
    meta: meta | 0,
    tool: info.kind,
    toolName: info.name,
    toolStack: stack,
    tier: info.tier,
    fortune,
    silkTouch,
    rng: r,
    world,
    x, y, z,
    player,
  };

  const drops = def.drops;
  const out = [];

  if (typeof drops === 'function') {
    // blocks.js owns the whole roll (ores, leaves, crops, silk-touch swaps).
    let raw = null;
    try { raw = drops(ctx); } catch (e) { console.error('[loot] block drop function failed for', def.name, e); }
    if (!raw) return out;
    if (!Array.isArray(raw)) raw = [raw];
    for (let i = 0; i < raw.length; i++) {
      const entry = raw[i];
      if (!entry) continue;
      const item = typeof entry === 'string' ? entry : entry.item;
      if (!item) continue;
      const n = typeof entry === 'string' ? 1 : (entry.count === undefined ? 1 : entry.count | 0);
      if (n <= 0) continue;
      const s = fromRaw(typeof entry === 'string' ? { item, count: 1 } : entry);
      if (!s) continue;
      // Split oversize results (fortune on melons can push past a stack).
      if (s.count > maxStack(s.item)) push(out, s.item, s.count);
      else out.push(s);
    }
    return out;
  }

  if (typeof drops === 'string') {
    const n = applyGenericFortune(def, drops, 1, fortune, r);
    push(out, drops, n);
    return out;
  }

  if (Array.isArray(drops)) {
    for (let i = 0; i < drops.length; i++) {
      const e = drops[i];
      if (!e) continue;
      const item = typeof e === 'string' ? e : e.item;
      if (!item) continue;
      if (typeof e === 'string') { push(out, item, 1); continue; }
      // Silk touch may be explicitly required or explicitly forbidden.
      if (e.silkOnly && !silkTouch) continue;
      if (e.noSilk && silkTouch) continue;
      let chance = e.chance === undefined ? 1 : e.chance;
      if (chance < 1 && fortune > 0) {
        // `apply_bonus` on a chance entry raises the odds, never past 1.
        chance = Math.min(1, chance * (1 + fortune * (e.fortuneChance === undefined ? 0 : e.fortuneChance)));
      }
      if (chance < 1 && r.next() >= chance) continue;
      let n = countOf(e.count, r, 1);
      if (e.fortune === 'ore') n = fortuneOre(n, fortune, r);
      else if (e.fortune === 'binomial') n = fortuneBinomial(n, fortune, r);
      else if (e.fortune === 'uniform') n = fortuneUniform(n, fortune, r, e.multiplier || 1, e.cap || 0);
      else n = applyGenericFortune(def, item, n, fortune, r);
      push(out, item, n);
    }
    return out;
  }

  return out;
}

/**
 * Experience a block drops when mined without silk touch.
 * Blocks carry an `xp: [min, max]` band in the registry (ores, spawners).
 */
export function blockXP(id, tool = null, rng = null) {
  const def = typeof id === 'object' && id ? id : getBlock(id);
  if (!def || !def.xp) return 0;
  const stack = tool && typeof tool === 'object' ? tool : null;
  if (stack && (getEnchant(stack, 'silk_touch') > 0)) return 0;
  const r = wrapRng(rng);
  const band = def.xp;
  if (Array.isArray(band)) return rInt(r, band[0] | 0, band[1] === undefined ? band[0] | 0 : band[1] | 0);
  return band | 0;
}

// ===========================================================================
// 2. Mob drops
// ===========================================================================

// Raw meat cooks when the mob dies on fire.
const COOKED = {
  porkchop: 'cooked_porkchop', beef: 'cooked_beef', chicken: 'cooked_chicken',
  mutton: 'cooked_mutton', rabbit: 'cooked_rabbit', cod: 'cooked_cod',
  salmon: 'cooked_salmon', potato: 'baked_potato',
};

// Heads a charged-creeper explosion knocks loose.
const MOB_HEADS = {
  skeleton: 'skeleton_skull',
  wither_skeleton: 'wither_skeleton_skull',
  zombie: 'zombie_head',
  creeper: 'creeper_head',
  piglin: 'piglin_head',
  zombified_piglin: 'piglin_head',
  player: 'player_head',
  ender_dragon: 'dragon_head',
};

// The discs a skeleton-killed creeper can leave behind.
const MUSIC_DISCS = [
  'music_disc_13', 'music_disc_cat', 'music_disc_blocks', 'music_disc_chirp',
  'music_disc_far', 'music_disc_mall', 'music_disc_mellohi', 'music_disc_stal',
  'music_disc_strad', 'music_disc_ward', 'music_disc_11', 'music_disc_wait',
];

const SKELETAL = new Set(['skeleton', 'stray', 'bogged', 'wither_skeleton']);
const EQUIPMENT_SLOTS = ['mainhand', 'offhand', 'head', 'chest', 'legs', 'feet'];

/** Pulls the definition out of a live mob, a name, or a raw definition. */
function mobDefOf(mob) {
  if (!mob) return null;
  if (typeof mob === 'string') {
    const reg = mobRegistry();
    return reg && reg.MOBS ? reg.MOBS[mob] || null : null;
  }
  if (mob.def) return mob.def;
  if (mob.name && mob.drops !== undefined) return mob;      // already a definition
  const reg = mobRegistry();
  const key = mob.type || mob.mobName || mob.name;
  return reg && reg.MOBS && key ? reg.MOBS[key] || null : null;
}

/** True when a player (or a player's projectile) landed the killing blow. */
function killedByPlayer(source) {
  if (!source) return false;
  const e = source.entity;
  if (e && (e.isPlayer || e.type === 'player')) return true;
  const d = source.direct;
  if (d) {
    if (d.isPlayer || d.type === 'player') return true;
    const shooter = d.shooter || d.owner;
    if (shooter && (shooter.isPlayer || shooter.type === 'player')) return true;
  }
  return false;
}

/** The entity that actually caused the death (arrow shooter included). */
function killerOf(source) {
  if (!source) return null;
  const d = source.direct;
  if (d && (d.shooter || d.owner)) return d.shooter || d.owner;
  return source.entity || d || null;
}

/** True for a death caused by a charged creeper's blast. */
function chargedCreeperBlast(source) {
  if (!source) return false;
  if (source.type !== 'explosion' && source.type !== 'creeper' && source.type !== 'blast') return false;
  const e = source.entity || (source.direct && source.direct.owner) || null;
  if (!e) return false;
  if (e.type !== 'creeper') return false;
  return !!(e.charged || e.powered);
}

/**
 * Everything a dying mob leaves behind: table drops, rare drops, worn
 * equipment, held items and the species-specific extras.
 *
 * @param {object|string} mob   the dying mob (or a registry name)
 * @param {object} source       damage source, `{ type, entity, direct, ... }`
 * @param {number} looting      Looting level of the killer's weapon
 * @returns {Array} ItemStacks
 */
export function mobDrops(mob, source = null, looting = 0) {
  const def = mobDefOf(mob);
  const live = mob && typeof mob === 'object' && mob.def ? mob : (mob && typeof mob === 'object' && mob.type ? mob : null);
  const name = (live && (live.type || live.mobName)) || (typeof mob === 'string' ? mob : (def ? def.name : null));
  if (!def && !name) return [];

  const r = wrapRng(live && live.rng ? live.rng : null);
  const loot = Math.max(0, looting | 0);
  const playerKill = killedByPlayer(source);
  const burning = !!(live && live.fireTicks > 0);
  const baby = !!(live && live.baby);
  const out = [];

  const emit = (item, count, extra) => {
    if (!item || count <= 0) return;
    let it = item;
    if (burning && COOKED[it]) it = COOKED[it];
    push(out, it, count, extra || null);
  };

  // ---- table drops -------------------------------------------------------
  if (def && (!baby || def.babyDrops)) {
    const list = def.drops || [];
    for (let i = 0; i < list.length; i++) {
      const d = list[i];
      if (!d || !d.item) continue;
      if (d.playerOnly && !playerKill) continue;
      if (d.chance !== undefined && r.next() >= d.chance) continue;
      let n = d.min === undefined ? 1 : rInt(r, d.min, d.max === undefined ? d.min : d.max);
      if (d.looting && loot > 0) n += rInt(r, 0, d.looting * loot);
      emit(typeof d.item === 'function' ? d.item(live) : d.item, n, d.extra);
    }

    // Rare drops are vanilla's `killed_by_player` pool.
    const rare = def.rareDrops || [];
    for (let i = 0; i < rare.length; i++) {
      const d = rare[i];
      if (!d || !d.item) continue;
      // Vanilla gates the rare pool behind `killed_by_player`; a table entry
      // can opt out with `playerOnly: false` (mob-vs-mob farms).
      if (!playerKill && d.playerOnly !== false) continue;
      const chance = (d.chance === undefined ? 0.025 : d.chance) + loot * (d.lootingBonus === undefined ? 0.01 : d.lootingBonus);
      if (r.next() >= chance) continue;
      const n = d.min === undefined ? 1 : rInt(r, d.min, d.max === undefined ? d.min : d.max);
      emit(typeof d.item === 'function' ? d.item(live) : d.item, n, d.extra);
    }
  }

  // ---- worn gear ---------------------------------------------------------
  // Vanilla: 8.5% per slot, +1 percentage point per Looting level.
  if (live && live.equipment) {
    for (let i = 0; i < EQUIPMENT_SLOTS.length; i++) {
      const slot = EQUIPMENT_SLOTS[i];
      const s = live.equipment[slot];
      if (!s || !s.item) continue;
      const chances = live.dropChances || null;
      const base = chances && chances[slot] !== undefined ? chances[slot] : 0.085;
      if (base < 1 && r.next() >= base + loot * 0.01) continue;
      const copy = st(s.item, 1);
      if (!copy) continue;
      // Gear falls off worn: keep any damage it already had, else scuff it.
      const max = durabilityOf(s.item);
      if (s.damage) copy.damage = s.damage | 0;
      else if (max > 1) copy.damage = Math.floor(r.next() * (max * 0.75));
      const ench = s.enchants || s.enchantments;
      if (ench) for (const k of Object.keys(ench)) applyEnchant(copy, k, ench[k]);
      out.push(copy);
    }
  }

  // ---- species-specific behaviour ----------------------------------------
  switch (name) {
    case 'sheep':
      if (live && !live.sheared && !baby) emit(`${(live && live.woolColor) || 'white'}_wool`, 1);
      break;

    case 'mooshroom': {
      // A mooshroom carries its mushrooms with it; shearing it first takes them.
      if (live && !live.sheared && !baby) {
        const kind = live.variant === 'brown' ? 'brown_mushroom' : 'red_mushroom';
        emit(kind, rInt(r, 1, 2) + (loot > 0 ? rInt(r, 0, loot) : 0));
      }
      break;
    }

    case 'snow_golem':
      // The definition already lists snowballs; nothing extra.
      break;

    case 'iron_golem':
      // Safety net when a caller hands us a bare golem entity with no def.
      if (!def) { emit('iron_ingot', rInt(r, 3, 5)); emit('poppy', rInt(r, 0, 2)); }
      break;

    case 'slime':
      if (!live || (live.slimeSize | 0) <= 1) emit('slimeball', rInt(r, 0, 2) + (loot > 0 ? rInt(r, 0, loot) : 0));
      break;

    case 'magma_cube':
      if (!live || (live.slimeSize | 0) <= 1) emit('magma_cream', rInt(r, 0, 1) + (loot > 0 ? rInt(r, 0, loot) : 0));
      break;

    case 'creeper': {
      // A creeper finished off by any skeleton's arrow drops a music disc.
      const killer = killerOf(source);
      if (killer && SKELETAL.has(killer.type)) {
        emit(MUSIC_DISCS[Math.floor(r.next() * MUSIC_DISCS.length)], 1);
      }
      break;
    }

    case 'wither':
      if (!def || !def.drops || !def.drops.length) emit('nether_star', 1);
      break;

    case 'ender_dragon':
      // The egg spawns on the exit portal; the stack here is what a caller
      // that collects drops directly (structure tests, /kill) should receive.
      emit('dragon_egg', 1);
      break;

    case 'fox': {
      const held = live && live.equipment ? live.equipment.mainhand : null;
      if (held && held.item) { out.push(st(held.item, held.count || 1)); }
      break;
    }

    case 'turtle':
      if (live && live.hasScute) emit('turtle_scute', 1);
      break;

    case 'armor_stand':
      if (!def || !def.drops || !def.drops.length) emit('armor_stand', 1);
      break;

    default:
      break;
  }

  // Saddles, chests and horse armour a tamed animal was wearing.
  if (live) {
    if (live.saddled && name !== 'ravager') emit('saddle', 1);
    if (live.chested) emit('chest', 1);
    if (live.horseArmor) emit(typeof live.horseArmor === 'string' ? live.horseArmor : live.horseArmor.item, 1);
    if (live.carriedBlock) emit(live.carriedBlock, 1);
  }

  // A charged creeper's blast knocks the victim's head clean off.
  if (chargedCreeperBlast(source)) {
    const head = MOB_HEADS[name];
    if (head) emit(head, 1);
  }

  return out;
}

/** Experience orbs a mob is worth to a player kill. */
export function mobXP(mob, source = null) {
  const def = mobDefOf(mob);
  if (!def) return 0;
  const live = mob && typeof mob === 'object' ? mob : null;
  if (!killedByPlayer(source) && !(live && live.fromSpawner) && !def.alwaysDropsXp) return 0;
  const base = def.xp | 0;
  if (live && live.baby && !def.boss) return Math.ceil(base * 2.5);
  return base;
}

// ===========================================================================
// 3. Chest loot tables
// ===========================================================================

/**
 * Table shape:
 *   { name, pools: [ { rolls, bonusRolls, entries: [entry] } ] }
 * Entry:
 *   { item, weight, count, chance, damage, enchant, empty }
 *   `enchant` is a level number (vanilla `enchant_with_levels`), the string
 *   'random' (`enchant_randomly`) or `{ name, level }`.
 *
 * Compact literal form used below: `[item, weight, min, max, opts]`.
 */
export const LOOT_TABLES = {};
/** Alternate spellings that resolve onto a real table. */
export const LOOT_TABLE_ALIASES = {};
/** Every canonical table name, registration order. */
export const LOOT_TABLE_NAMES = [];

/** Normalises one compact entry literal into an entry object. */
function entry(e) {
  if (!e) return null;
  if (Array.isArray(e)) {
    const [item, weight = 1, min = 1, max = min, opts = null] = e;
    const out = { item, weight, count: [min, max === undefined ? min : max] };
    if (opts) Object.assign(out, opts);
    return out;
  }
  if (typeof e === 'string') return { item: e, weight: 1, count: [1, 1] };
  const out = Object.assign({ weight: 1, count: [1, 1] }, e);
  return out;
}

/** Builds a pool: `rolls` is a number or `[min, max]`. */
function pool(rolls, entries, bonusRolls = 0) {
  return { rolls, bonusRolls, entries: entries.map(entry).filter(Boolean) };
}

/** Registers a loot table under `name` plus any `aliases`. */
function defineLootTable(name, pools, aliases = null) {
  const table = { name, pools };
  LOOT_TABLES[name] = table;
  LOOT_TABLE_NAMES.push(name);
  if (aliases) for (const a of aliases) LOOT_TABLE_ALIASES[a] = name;
  return table;
}

/** Resolves a table by name, following aliases. Returns null when unknown. */
export function getLootTable(name) {
  if (!name) return null;
  const direct = LOOT_TABLES[name];
  if (direct) return direct;
  const alias = LOOT_TABLE_ALIASES[name];
  return alias ? LOOT_TABLES[alias] || null : null;
}

// --- shorthand for enchanted gear entries ----------------------------------
const EN = (level) => ({ enchant: level });
const DMG = (lo, hi) => ({ damage: [lo, hi] });

// ---------------------------------------------------------------------------
// 3a. Dungeons, mineshafts, strongholds
// ---------------------------------------------------------------------------

defineLootTable('simple_dungeon', [
  pool([1, 3], [
    ['saddle', 20],
    ['golden_apple', 15],
    ['enchanted_golden_apple', 2],
    ['music_disc_13', 15],
    ['music_disc_cat', 15],
    ['name_tag', 20],
    ['golden_horse_armor', 10],
    ['iron_horse_armor', 15],
    ['diamond_horse_armor', 5],
    ['book', 10, 1, 1, EN(30)],
  ]),
  pool([1, 4], [
    ['iron_ingot', 10, 1, 4],
    ['gold_ingot', 5, 1, 4],
    ['bread', 20],
    ['wheat', 20, 1, 4],
    ['bucket', 10],
    ['redstone', 15, 1, 4],
    ['coal', 15, 1, 4],
    ['melon_seeds', 10, 2, 4],
    ['pumpkin_seeds', 10, 2, 4],
    ['beetroot_seeds', 10, 2, 4],
  ]),
  pool(3, [
    ['bone', 10, 1, 8],
    ['gunpowder', 10, 1, 8],
    ['rotten_flesh', 10, 1, 8],
    ['string', 10, 1, 8],
  ]),
], ['dungeon', 'monster_room', 'spawner_chest']);

defineLootTable('abandoned_mineshaft', [
  pool(1, [
    ['name_tag', 30],
    ['golden_apple', 20],
    ['enchanted_golden_apple', 1],
    ['book', 10, 1, 1, EN(30)],
    ['iron_pickaxe', 5, 1, 1, DMG(0.1, 0.6)],
    ['empty', 30, 1, 1, { empty: true }],
  ]),
  pool([2, 4], [
    ['iron_ingot', 10, 1, 5],
    ['gold_ingot', 5, 1, 3],
    ['redstone', 5, 4, 9],
    ['lapis_lazuli', 5, 4, 9],
    ['diamond', 3, 1, 2],
    ['coal', 10, 3, 8],
    ['bread', 15, 1, 3],
    ['melon_seeds', 10, 2, 4],
    ['pumpkin_seeds', 10, 2, 4],
    ['beetroot_seeds', 10, 2, 4],
  ]),
  pool(3, [
    ['rail', 20, 4, 8],
    ['powered_rail', 5, 1, 4],
    ['detector_rail', 5, 1, 4],
    ['activator_rail', 5, 1, 4],
    ['torch', 15, 1, 16],
    ['cobweb', 5, 1, 2],
  ]),
], ['mineshaft', 'mineshaft_corridor']);

defineLootTable('stronghold_library', [
  pool([2, 10], [
    ['book', 20, 1, 3],
    ['paper', 20, 2, 7],
    ['map', 1],
    ['compass', 1],
    ['empty', 10, 1, 1, { empty: true }],
  ]),
  pool([1, 5], [
    ['book', 10, 1, 1, EN(30)],
    ['empty', 5, 1, 1, { empty: true }],
  ]),
], ['stronghold_library_chest']);

defineLootTable('stronghold_corridor', [
  pool([2, 3], [
    ['ender_pearl', 10],
    ['diamond', 3],
    ['iron_ingot', 10, 1, 5],
    ['gold_ingot', 5, 1, 3],
    ['redstone', 5, 4, 9],
    ['bread', 15, 1, 3],
    ['apple', 15, 1, 3],
    ['iron_pickaxe', 5, 1, 1, DMG(0.1, 0.6)],
    ['iron_sword', 5, 1, 1, DMG(0.1, 0.6)],
    ['iron_chestplate', 5, 1, 1, DMG(0.1, 0.6)],
    ['iron_helmet', 5, 1, 1, DMG(0.1, 0.6)],
    ['iron_leggings', 5, 1, 1, DMG(0.1, 0.6)],
    ['iron_boots', 5, 1, 1, DMG(0.1, 0.6)],
    ['golden_apple', 1],
    ['saddle', 1],
    ['iron_horse_armor', 1],
    ['golden_horse_armor', 1],
    ['diamond_horse_armor', 1],
    ['book', 1, 1, 1, EN(30)],
  ]),
]);

defineLootTable('stronghold_crossing', [
  pool([1, 4], [
    ['iron_ingot', 10, 1, 5],
    ['gold_ingot', 5, 1, 3],
    ['redstone', 5, 4, 9],
    ['coal', 10, 3, 8],
    ['bread', 15, 1, 3],
    ['apple', 15, 1, 3],
    ['iron_pickaxe', 1, 1, 1, DMG(0.1, 0.6)],
    ['book', 1, 1, 1, EN(30)],
  ]),
]);

// ---------------------------------------------------------------------------
// 3b. Villages - one table per profession, plus the biome house variants
// ---------------------------------------------------------------------------

const VILLAGE_STAPLES = [
  ['bread', 12, 1, 3],
  ['wheat', 10, 1, 5],
  ['wheat_seeds', 10, 1, 3],
  ['apple', 8, 1, 3],
  ['potato', 8, 1, 5],
  ['carrot', 8, 1, 5],
  ['beetroot_seeds', 6, 1, 5],
  ['stick', 6, 1, 3],
  ['emerald', 2, 1, 2],
  ['iron_ingot', 2, 1, 2],
];

/** A village table: the staples plus whatever the profession keeps around. */
function villageTable(name, extras, rolls = [3, 8], aliases = null) {
  return defineLootTable(name, [pool(rolls, VILLAGE_STAPLES.concat(extras))], aliases);
}

villageTable('village_house', [
  ['oak_sapling', 5, 1, 2],
  ['torch', 4, 1, 3],
  ['flower_pot', 2],
  ['book', 2],
  ['feather', 3, 1, 3],
  ['oak_log', 3, 1, 3],
], [3, 8], ['village_plains_house', 'village_savanna_house', 'village_desert_house', 'village_snowy_house', 'village_taiga_house']);

villageTable('village_weaponsmith', [
  ['diamond', 1, 1, 3],
  ['iron_ingot', 5, 1, 5],
  ['gold_ingot', 2, 1, 3],
  ['iron_pickaxe', 5, 1, 1, DMG(0.05, 0.5)],
  ['iron_sword', 5, 1, 1, DMG(0.05, 0.5)],
  ['iron_helmet', 3, 1, 1, DMG(0.05, 0.5)],
  ['iron_chestplate', 3, 1, 1, DMG(0.05, 0.5)],
  ['iron_leggings', 3, 1, 1, DMG(0.05, 0.5)],
  ['iron_boots', 3, 1, 1, DMG(0.05, 0.5)],
  ['obsidian', 5, 3, 7],
  ['saddle', 1],
  ['iron_horse_armor', 1],
], [3, 8], ['village_armorer', 'village_smith']);

villageTable('village_toolsmith', [
  ['diamond', 1],
  ['iron_ingot', 5, 1, 5],
  ['iron_pickaxe', 5, 1, 1, DMG(0.05, 0.5)],
  ['iron_shovel', 5, 1, 1, DMG(0.05, 0.5)],
  ['iron_axe', 4, 1, 1, DMG(0.05, 0.5)],
  ['stone_pickaxe', 8],
  ['stone_axe', 8],
  ['coal', 8, 1, 3],
  ['flint', 6, 1, 3],
]);

villageTable('village_temple', [
  ['redstone', 4, 1, 4],
  ['lapis_lazuli', 3, 1, 3],
  ['gold_ingot', 2, 1, 3],
  ['glass_bottle', 3, 1, 2],
  ['book', 2],
  ['rotten_flesh', 3, 1, 3],
], [3, 7], ['village_cleric', 'village_church']);

villageTable('village_butcher', [
  ['porkchop', 8, 1, 3],
  ['beef', 8, 1, 3],
  ['chicken', 6, 1, 3],
  ['mutton', 6, 1, 3],
  ['coal', 8, 1, 4],
]);

villageTable('village_shepherd', [
  ['white_wool', 8, 1, 3],
  ['black_wool', 4],
  ['brown_wool', 4],
  ['gray_wool', 4],
  ['shears', 3, 1, 1, DMG(0.05, 0.5)],
  ['string', 6, 1, 4],
]);

villageTable('village_fisher', [
  ['cod', 8, 1, 3],
  ['salmon', 6, 1, 3],
  ['fishing_rod', 3, 1, 1, DMG(0.1, 0.6)],
  ['barrel', 3],
  ['water_bucket', 2],
  ['string', 6, 1, 4],
], [3, 8], ['village_fisherman']);

villageTable('village_fletcher', [
  ['arrow', 10, 2, 6],
  ['feather', 10, 1, 4],
  ['flint', 8, 1, 3],
  ['bow', 3, 1, 1, DMG(0.1, 0.6)],
  ['string', 8, 1, 4],
]);

villageTable('village_cartographer', [
  ['map', 6],
  ['paper', 10, 1, 5],
  ['compass', 4],
  ['book', 5],
  ['glass_pane', 5, 1, 3],
]);

villageTable('village_mason', [
  ['clay_ball', 8, 1, 3],
  ['brick', 8, 1, 3],
  ['stone', 8, 1, 4],
  ['smooth_stone', 6, 1, 3],
  ['flower_pot', 4],
]);

villageTable('village_tannery', [
  ['leather', 10, 1, 4],
  ['leather_helmet', 3, 1, 1, DMG(0.1, 0.6)],
  ['leather_chestplate', 3, 1, 1, DMG(0.1, 0.6)],
  ['leather_leggings', 3, 1, 1, DMG(0.1, 0.6)],
  ['leather_boots', 3, 1, 1, DMG(0.1, 0.6)],
  ['cauldron', 2],
], [3, 8], ['village_leatherworker']);

villageTable('village_librarian', [
  ['book', 10, 1, 3],
  ['paper', 10, 2, 6],
  ['bookshelf', 4],
  ['book', 2, 1, 1, EN(20)],
  ['ink_sac', 4, 1, 3],
]);

// ---------------------------------------------------------------------------
// 3c. Desert pyramid, jungle temple, igloo, witch hut, wells
// ---------------------------------------------------------------------------

defineLootTable('desert_pyramid', [
  pool([2, 4], [
    ['diamond', 5, 1, 3],
    ['iron_ingot', 15, 1, 5],
    ['gold_ingot', 15, 2, 7],
    ['emerald', 15, 1, 3],
    ['bone', 25, 4, 6],
    ['spider_eye', 25, 1, 3],
    ['rotten_flesh', 25, 3, 7],
    ['saddle', 20],
    ['iron_horse_armor', 15],
    ['golden_horse_armor', 10],
    ['diamond_horse_armor', 5],
    ['book', 20, 1, 1, EN(30)],
    ['golden_apple', 20],
    ['enchanted_golden_apple', 2],
  ]),
  pool(4, [
    ['bone', 10, 1, 8],
    ['rotten_flesh', 10, 1, 8],
    ['gunpowder', 10, 1, 8],
    ['sand', 10, 1, 8],
    ['string', 10, 1, 8],
  ]),
]);

defineLootTable('desert_pyramid_archaeology', [
  pool(1, [
    ['archer_pottery_sherd', 2],
    ['miner_pottery_sherd', 2],
    ['prize_pottery_sherd', 2],
    ['skull_pottery_sherd', 2],
    ['diamond', 1],
    ['gunpowder', 3, 1, 3],
    ['tnt', 1],
    ['emerald', 2],
  ]),
], ['suspicious_sand_desert_pyramid']);

defineLootTable('jungle_temple', [
  pool([2, 6], [
    ['diamond', 3, 1, 3],
    ['iron_ingot', 10, 1, 5],
    ['gold_ingot', 15, 2, 7],
    ['emerald', 15, 1, 3],
    ['bamboo', 12, 1, 3],
    ['bone', 20, 4, 6],
    ['rotten_flesh', 16, 3, 7],
    ['saddle', 3],
    ['iron_horse_armor', 1],
    ['golden_horse_armor', 1],
    ['diamond_horse_armor', 1],
    ['book', 1, 1, 1, EN(30)],
    ['cocoa_beans', 8, 1, 3],
  ]),
]);

defineLootTable('jungle_temple_dispenser', [
  pool(2, [['arrow', 30, 2, 7]]),
]);

defineLootTable('igloo_chest', [
  pool(1, [
    ['apple', 1, 1, 3],
    ['coal', 1, 1, 4],
    ['gold_nugget', 1, 1, 3],
    ['stone_axe', 1, 1, 1, DMG(0.1, 0.6)],
    ['emerald', 1],
    ['wheat', 1, 2, 3],
  ]),
  pool(1, [
    ['golden_apple', 1],
  ]),
], ['igloo']);

defineLootTable('igloo_basement', [
  pool([2, 4], [
    ['golden_apple', 4],
    ['potion_weakness', 6],
    ['emerald', 4],
    ['gold_nugget', 8, 1, 4],
    ['coal', 8, 1, 4],
    ['apple', 8, 1, 3],
    ['wheat', 8, 2, 3],
    ['stone_axe', 4, 1, 1, DMG(0.1, 0.6)],
    ['brewing_stand', 2],
  ]),
], ['igloo_basement_chest']);

defineLootTable('witch_hut', [
  pool([2, 5], [
    ['glass_bottle', 10, 1, 3],
    ['spider_eye', 10, 1, 3],
    ['sugar', 8, 1, 3],
    ['glowstone_dust', 6, 1, 3],
    ['redstone', 6, 1, 4],
    ['gunpowder', 8, 1, 3],
    ['brown_mushroom', 6, 1, 3],
    ['red_mushroom', 6, 1, 3],
    ['potion_water', 4],
    ['cauldron', 1],
  ]),
], ['swamp_hut']);

defineLootTable('desert_well', [
  pool([1, 3], [
    ['gold_nugget', 8, 1, 4],
    ['emerald', 4, 1, 2],
    ['bone', 8, 1, 4],
    ['dead_bush', 6, 1, 2],
    ['sand', 10, 4, 12],
    ['brick', 4, 1, 3],
    ['suspicious_stew', 2],
  ]),
]);

defineLootTable('fossil', [
  pool([1, 3], [
    ['bone', 12, 4, 10],
    ['coal', 8, 1, 4],
    ['bone_meal', 6, 1, 5],
  ]),
]);

// ---------------------------------------------------------------------------
// 3d. Pillager outpost, woodland mansion
// ---------------------------------------------------------------------------

defineLootTable('pillager_outpost', [
  pool([1, 3], [
    ['dark_oak_log', 4, 2, 3],
    ['potato', 7, 2, 5],
    ['wheat', 7, 3, 5],
    ['carrot', 7, 3, 5],
    ['iron_ingot', 3, 1, 2],
    ['tripwire_hook', 2, 1, 2],
    ['crossbow', 2, 1, 1, { damage: [0.1, 0.6], enchant: 15 }],
    ['book', 1, 1, 1, EN(30)],
    ['arrow', 6, 2, 7],
  ]),
  pool(1, [
    ['bread', 10, 1, 3],
    ['experience_bottle', 2],
    ['emerald', 3, 1, 2],
    ['empty', 6, 1, 1, { empty: true }],
  ]),
], ['pillager_outpost_chest']);

defineLootTable('woodland_mansion', [
  pool([1, 3], [
    ['lead', 20],
    ['golden_apple', 15],
    ['enchanted_golden_apple', 2],
    ['music_disc_13', 15],
    ['music_disc_cat', 15],
    ['name_tag', 20],
    ['chainmail_chestplate', 10, 1, 1, DMG(0.1, 0.6)],
    ['diamond_hoe', 15],
    ['diamond_chestplate', 5, 1, 1, { damage: [0.1, 0.5], enchant: 30 }],
    ['book', 10, 1, 1, EN(30)],
  ]),
  pool([1, 4], [
    ['iron_ingot', 10, 1, 5],
    ['gold_ingot', 5, 1, 3],
    ['bread', 20, 1, 3],
    ['wheat', 20, 1, 4],
    ['bucket', 10],
    ['redstone', 15, 1, 4],
    ['coal', 15, 1, 4],
    ['melon_seeds', 10, 2, 4],
    ['pumpkin_seeds', 10, 2, 4],
    ['beetroot_seeds', 10, 2, 4],
  ]),
  pool(3, [
    ['bone', 10, 1, 8],
    ['gunpowder', 10, 1, 8],
    ['rotten_flesh', 10, 1, 8],
    ['string', 10, 1, 8],
  ]),
], ['mansion', 'woodland_mansion_chest']);

// ---------------------------------------------------------------------------
// 3e. Oceans: monument, ruins, shipwrecks, buried treasure
// ---------------------------------------------------------------------------

defineLootTable('ocean_monument', [
  pool([2, 4], [
    ['prismarine_shard', 12, 2, 5],
    ['prismarine_crystals', 8, 1, 3],
    ['sponge', 4, 1, 2],
    ['cooked_cod', 8, 2, 4],
    ['cooked_salmon', 6, 2, 4],
    ['sea_lantern', 4, 1, 2],
    ['gold_block', 1],
    ['heart_of_the_sea', 1],
    ['nautilus_shell', 3],
  ]),
], ['monument', 'ocean_monument_treasure']);

defineLootTable('underwater_ruin_small', [
  pool([1, 3], [
    ['coal', 10, 1, 4],
    ['wheat', 10, 2, 3],
    ['gold_nugget', 10, 1, 3],
    ['emerald', 5],
    ['leather_helmet', 5, 1, 1, { damage: [0.1, 0.7], enchant: 'random' }],
    ['stone_axe', 5, 1, 1, DMG(0.1, 0.7)],
    ['fishing_rod', 5, 1, 1, DMG(0.1, 0.7)],
    ['map', 5],
    ['rotten_flesh', 8, 1, 3],
  ]),
], ['ocean_ruin_small', 'underwater_ruin']);

defineLootTable('underwater_ruin_big', [
  pool([2, 4], [
    ['gold_ingot', 5, 1, 2],
    ['emerald', 5, 1, 2],
    ['diamond', 1],
    ['coal', 10, 1, 4],
    ['wheat', 10, 2, 3],
    ['golden_apple', 2],
    ['map', 5],
    ['book', 5, 1, 1, EN(20)],
    ['golden_helmet', 3, 1, 1, { damage: [0.1, 0.7], enchant: 'random' }],
    ['fishing_rod', 5, 1, 1, DMG(0.1, 0.7)],
  ]),
], ['ocean_ruin_big']);

defineLootTable('shipwreck_supply', [
  pool([3, 10], [
    ['paper', 8, 1, 12],
    ['potato', 7, 2, 6],
    ['poisonous_potato', 7, 1, 3],
    ['carrot', 7, 4, 8],
    ['wheat', 7, 8, 21],
    ['coal', 6, 2, 8],
    ['rotten_flesh', 5, 5, 24],
    ['bamboo', 5, 1, 3],
    ['pumpkin', 3, 1, 3],
    ['gunpowder', 5, 1, 5],
    ['tnt', 1, 1, 2],
    ['leather_helmet', 3, 1, 1, DMG(0.1, 0.8)],
    ['leather_chestplate', 3, 1, 1, DMG(0.1, 0.8)],
    ['leather_leggings', 3, 1, 1, DMG(0.1, 0.8)],
    ['leather_boots', 3, 1, 1, DMG(0.1, 0.8)],
    ['suspicious_stew', 2],
  ]),
], ['shipwreck']);

defineLootTable('shipwreck_treasure', [
  pool([3, 6], [
    ['iron_ingot', 90, 1, 5],
    ['gold_ingot', 10, 1, 5],
    ['emerald', 40, 1, 5],
    ['diamond', 5],
    ['experience_bottle', 5],
    ['lapis_lazuli', 20, 1, 10],
    ['gold_nugget', 10, 1, 10],
    ['iron_nugget', 50, 1, 10],
    ['nautilus_shell', 5],
    ['bell', 2],
    ['name_tag', 3],
  ]),
]);

defineLootTable('shipwreck_map', [
  pool(1, [['map', 1]]),
  pool(3, [
    ['compass', 8],
    ['map', 12],
    ['clock', 8],
    ['paper', 20, 1, 10],
    ['feather', 20, 1, 5],
    ['book', 5, 1, 5],
  ]),
]);

defineLootTable('buried_treasure', [
  pool(1, [['heart_of_the_sea', 1]]),
  pool([5, 8], [
    ['iron_ingot', 20, 1, 4],
    ['gold_ingot', 10, 1, 4],
    ['tnt', 5, 1, 2],
  ]),
  pool([1, 3], [
    ['emerald', 5, 4, 8],
    ['diamond', 5, 1, 2],
    ['prismarine_crystals', 5, 1, 5],
  ]),
  pool([0, 1], [
    ['leather_chestplate', 1],
    ['iron_sword', 1],
  ]),
  pool(2, [
    ['cooked_cod', 1, 2, 4],
    ['cooked_salmon', 1, 2, 4],
  ]),
]);

// ---------------------------------------------------------------------------
// 3f. Nether: fortresses and bastions
// ---------------------------------------------------------------------------

defineLootTable('nether_bridge', [
  pool([2, 4], [
    ['diamond', 5, 1, 3],
    ['iron_ingot', 5, 1, 5],
    ['gold_ingot', 15, 1, 3],
    ['golden_sword', 5, 1, 1, DMG(0.1, 0.6)],
    ['golden_chestplate', 5, 1, 1, DMG(0.1, 0.6)],
    ['flint_and_steel', 5, 1, 1, DMG(0.1, 0.6)],
    ['nether_wart', 5, 3, 7],
    ['saddle', 10],
    ['golden_horse_armor', 8],
    ['obsidian', 5, 2, 4],
    ['gold_nugget', 10, 4, 24],
  ]),
], ['nether_fortress', 'nether_fortress_chest']);

defineLootTable('bastion_treasure', [
  pool(3, [
    ['netherite_ingot', 15],
    ['ancient_debris', 12, 1, 2],
    ['netherite_scrap', 8, 1, 2],
    ['diamond_sword', 6, 1, 1, { damage: [0, 0.25], enchant: 30 }],
    ['diamond_chestplate', 6, 1, 1, { damage: [0, 0.25], enchant: 30 }],
    ['diamond_helmet', 6, 1, 1, { damage: [0, 0.25], enchant: 30 }],
    ['diamond_leggings', 6, 1, 1, { damage: [0, 0.25], enchant: 30 }],
    ['diamond_boots', 6, 1, 1, { damage: [0, 0.25], enchant: 30 }],
    ['diamond_pickaxe', 6, 1, 1, { damage: [0, 0.25], enchant: 30 }],
    ['diamond', 10, 2, 6],
    ['gold_block', 8, 1, 2],
    ['netherite_upgrade_smithing_template', 4],
  ]),
  pool([3, 4], [
    ['gold_ingot', 15, 4, 9],
    ['spectral_arrow', 10, 6, 12],
    ['crying_obsidian', 10, 1, 3],
    ['gilded_blackstone', 10, 1, 3],
    ['book', 8, 1, 1, EN(30)],
    ['iron_ingot', 12, 2, 6],
  ]),
  pool([2, 3], [
    ['golden_carrot', 12, 8, 17],
    ['golden_apple', 6],
    ['cooked_porkchop', 12, 4, 8],
    ['crossbow', 4, 1, 1, { damage: [0.1, 0.5], enchant: 20 }],
    ['string', 10, 3, 8],
  ]),
]);

defineLootTable('bastion_other', [
  pool([3, 4], [
    ['gold_nugget', 20, 2, 8],
    ['gold_ingot', 15, 1, 3],
    ['crying_obsidian', 10, 1, 2],
    ['obsidian', 10, 1, 2],
    ['string', 10, 2, 4],
    ['arrow', 10, 5, 17],
    ['iron_nugget', 15, 2, 8],
    ['golden_carrot', 10, 1, 3],
    ['magma_cream', 10, 1, 2],
    ['chain', 8, 1, 4],
    ['bone', 8, 1, 3],
    ['glowstone_dust', 6, 1, 4],
  ]),
  pool([1, 2], [
    ['golden_axe', 6, 1, 1, { damage: [0.1, 0.6], enchant: 20 }],
    ['golden_sword', 6, 1, 1, { damage: [0.1, 0.6], enchant: 20 }],
    ['golden_helmet', 6, 1, 1, { damage: [0.1, 0.6], enchant: 20 }],
    ['golden_chestplate', 6, 1, 1, { damage: [0.1, 0.6], enchant: 20 }],
    ['crossbow', 4, 1, 1, DMG(0.1, 0.6)],
    ['empty', 12, 1, 1, { empty: true }],
  ]),
], ['bastion_generic']);

defineLootTable('bastion_bridge', [
  pool([2, 3], [
    ['gold_ingot', 15, 1, 5],
    ['iron_ingot', 10, 1, 5],
    ['crying_obsidian', 10, 1, 3],
    ['obsidian', 8, 1, 3],
    ['lodestone', 3],
    ['arrow', 10, 5, 17],
    ['spectral_arrow', 6, 2, 8],
    ['crossbow', 4, 1, 1, { damage: [0.1, 0.6], enchant: 20 }],
    ['golden_apple', 4],
    ['gold_block', 3, 1, 2],
  ]),
]);

defineLootTable('bastion_hoglin_stable', [
  pool([3, 4], [
    ['gold_ingot', 15, 1, 5],
    ['gold_nugget', 20, 2, 8],
    ['porkchop', 12, 2, 6],
    ['cooked_porkchop', 10, 2, 6],
    ['saddle', 6],
    ['leather', 10, 2, 6],
    ['string', 10, 2, 6],
    ['crying_obsidian', 8, 1, 3],
    ['gilded_blackstone', 6, 1, 3],
    ['golden_hoe', 4, 1, 1, { damage: [0.1, 0.6], enchant: 20 }],
    ['diamond_shovel', 2, 1, 1, { damage: [0.1, 0.5], enchant: 30 }],
  ]),
]);

// ---------------------------------------------------------------------------
// 3g. The End
// ---------------------------------------------------------------------------

defineLootTable('end_city_treasure', [
  pool([2, 6], [
    ['diamond', 5, 2, 7],
    ['iron_ingot', 10, 4, 8],
    ['gold_ingot', 15, 2, 7],
    ['emerald', 10, 2, 6],
    ['beetroot_seeds', 5, 1, 10],
    ['saddle', 3],
    ['iron_sword', 3, 1, 1, { damage: [0, 0.25], enchant: 30 }],
    ['diamond_sword', 3, 1, 1, { damage: [0, 0.25], enchant: 30 }],
    ['iron_pickaxe', 3, 1, 1, { damage: [0, 0.25], enchant: 30 }],
    ['diamond_pickaxe', 3, 1, 1, { damage: [0, 0.25], enchant: 30 }],
    ['iron_chestplate', 3, 1, 1, { damage: [0, 0.25], enchant: 30 }],
    ['diamond_chestplate', 3, 1, 1, { damage: [0, 0.25], enchant: 30 }],
    ['iron_helmet', 3, 1, 1, { damage: [0, 0.25], enchant: 30 }],
    ['diamond_helmet', 3, 1, 1, { damage: [0, 0.25], enchant: 30 }],
    ['iron_leggings', 3, 1, 1, { damage: [0, 0.25], enchant: 30 }],
    ['diamond_leggings', 3, 1, 1, { damage: [0, 0.25], enchant: 30 }],
    ['iron_boots', 3, 1, 1, { damage: [0, 0.25], enchant: 30 }],
    ['diamond_boots', 3, 1, 1, { damage: [0, 0.25], enchant: 30 }],
    ['iron_shovel', 3, 1, 1, { damage: [0, 0.25], enchant: 30 }],
    ['golden_apple', 3],
  ]),
], ['end_city', 'end_city_ship']);

// ---------------------------------------------------------------------------
// 3h. Ruined portals, ancient cities, trail ruins
// ---------------------------------------------------------------------------

defineLootTable('ruined_portal', [
  pool([4, 8], [
    ['obsidian', 40, 1, 2],
    ['flint', 40],
    ['iron_nugget', 40, 9, 18],
    ['flint_and_steel', 40, 1, 1, DMG(0.1, 0.6)],
    ['fire_charge', 40],
    ['gold_nugget', 40, 4, 24],
    ['gold_ingot', 15, 1, 2],
    ['golden_apple', 15],
    ['golden_axe', 15, 1, 1, { damage: [0.1, 0.6], enchant: 20 }],
    ['golden_sword', 15, 1, 1, { damage: [0.1, 0.6], enchant: 20 }],
    ['golden_hoe', 15, 1, 1, { damage: [0.1, 0.6], enchant: 20 }],
    ['golden_shovel', 15, 1, 1, { damage: [0.1, 0.6], enchant: 20 }],
    ['golden_pickaxe', 15, 1, 1, { damage: [0.1, 0.6], enchant: 20 }],
    ['golden_helmet', 15, 1, 1, { damage: [0.1, 0.6], enchant: 20 }],
    ['golden_chestplate', 15, 1, 1, { damage: [0.1, 0.6], enchant: 20 }],
    ['golden_leggings', 15, 1, 1, { damage: [0.1, 0.6], enchant: 20 }],
    ['golden_boots', 15, 1, 1, { damage: [0.1, 0.6], enchant: 20 }],
    ['glistering_melon_slice', 5, 4, 12],
    ['bell', 1],
    ['enchanted_golden_apple', 1],
  ]),
], ['ruined_portal_chest']);

defineLootTable('ancient_city', [
  pool([1, 4], [
    ['music_disc_otherside', 1],
    ['echo_shard', 4, 1, 3],
    ['disc_fragment_5', 4],
    ['sculk_catalyst', 4, 1, 2],
    ['book', 10, 1, 1, EN(30)],
    ['diamond', 6, 1, 3],
    ['iron_ingot', 10, 1, 5],
    ['soul_torch', 10, 1, 4],
    ['candle', 8, 1, 4],
    ['sculk', 6, 4, 10],
    ['compass', 3],
    ['name_tag', 4],
    ['golden_apple', 3],
    ['enchanted_golden_apple', 1],
    ['ward_armor_trim_smithing_template', 2],
    ['silence_armor_trim_smithing_template', 1],
  ]),
  pool([1, 3], [
    ['bone', 10, 1, 8],
    ['soul_soil', 8, 1, 4],
    ['coal', 8, 1, 6],
    ['glow_berries', 6, 1, 15],
    ['potion_regeneration', 3],
    ['experience_bottle', 4, 1, 3],
    ['empty', 10, 1, 1, { empty: true }],
  ]),
], ['ancient_city_chest']);

defineLootTable('ancient_city_ice_box', [
  pool([3, 6], [
    ['ice', 10, 1, 3],
    ['packed_ice', 5, 1, 2],
    ['snowball', 10, 1, 8],
    ['cooked_beef', 8, 1, 3],
    ['cooked_porkchop', 6, 1, 3],
    ['cake', 2],
  ]),
]);

defineLootTable('trail_ruins_common', [
  pool([1, 3], [
    ['emerald', 8, 1, 2],
    ['wheat', 10, 1, 4],
    ['stick', 10, 1, 4],
    ['brick', 8, 1, 3],
    ['string', 8, 1, 4],
    ['coal', 8, 1, 3],
    ['wooden_hoe', 4],
    ['blue_dye', 4, 1, 2],
    ['yellow_dye', 4, 1, 2],
    ['lead', 3],
    ['candle', 4, 1, 2],
    ['flower_pot', 3],
  ]),
], ['trail_ruins', 'trail_ruins_archaeology_common']);

defineLootTable('trail_ruins_rare', [
  pool(1, [
    ['music_disc_relic', 2],
    ['angler_pottery_sherd', 3],
    ['archer_pottery_sherd', 3],
    ['blade_pottery_sherd', 3],
    ['brewer_pottery_sherd', 3],
    ['burn_pottery_sherd', 3],
    ['danger_pottery_sherd', 3],
    ['explorer_pottery_sherd', 3],
    ['friend_pottery_sherd', 3],
    ['heart_pottery_sherd', 3],
    ['heartbreak_pottery_sherd', 3],
    ['howl_pottery_sherd', 3],
    ['miner_pottery_sherd', 3],
    ['mourner_pottery_sherd', 3],
    ['plenty_pottery_sherd', 3],
    ['prize_pottery_sherd', 3],
    ['sheaf_pottery_sherd', 3],
    ['shelter_pottery_sherd', 3],
    ['skull_pottery_sherd', 3],
    ['snort_pottery_sherd', 3],
    ['dune_armor_trim_smithing_template', 2],
    ['coast_armor_trim_smithing_template', 2],
    ['wild_armor_trim_smithing_template', 2],
    ['rib_armor_trim_smithing_template', 2],
    ['gold_ingot', 4, 1, 2],
    ['diamond', 2],
  ]),
], ['trail_ruins_archaeology_rare']);

// ---------------------------------------------------------------------------
// 3i. Bonus chest
// ---------------------------------------------------------------------------

defineLootTable('spawn_bonus_chest', [
  pool([1, 3], [
    ['stone_axe', 1],
    ['wooden_axe', 3],
    ['stone_pickaxe', 1],
    ['wooden_pickaxe', 3],
  ]),
  pool([1, 4], [
    ['apple', 3, 1, 2],
    ['bread', 3, 1, 2],
    ['salmon', 3, 1, 2],
  ]),
  pool([1, 4], [
    ['oak_log', 10, 1, 3],
    ['spruce_log', 10, 1, 3],
    ['birch_log', 10, 1, 3],
    ['oak_planks', 10, 1, 3],
    ['stick', 4, 1, 12],
  ]),
], ['bonus_chest']);

defineLootTable('default', [
  pool([2, 4], [
    ['bread', 10, 1, 3],
    ['iron_ingot', 6, 1, 3],
    ['coal', 8, 1, 5],
    ['gold_ingot', 4, 1, 2],
    ['emerald', 3, 1, 2],
    ['stick', 8, 1, 4],
    ['string', 6, 1, 4],
    ['bone', 6, 1, 4],
  ]),
]);

// ---------------------------------------------------------------------------
// 3j. Fishing
// ---------------------------------------------------------------------------

const FISH_POOL = [
  { item: 'cod', weight: 60 },
  { item: 'salmon', weight: 25 },
  { item: 'tropical_fish', weight: 2 },
  { item: 'pufferfish', weight: 13 },
].map(entry);

const TREASURE_POOL = [
  { item: 'bow', weight: 1, damage: [0.25, 0.75], enchant: 'random' },
  { item: 'enchanted_book', weight: 1, enchant: 'random' },
  { item: 'fishing_rod', weight: 1, damage: [0.25, 0.75], enchant: 'random' },
  { item: 'name_tag', weight: 1 },
  { item: 'nautilus_shell', weight: 1 },
  { item: 'saddle', weight: 1 },
].map(entry);

const JUNK_POOL = [
  { item: 'lily_pad', weight: 17 },
  { item: 'leather_boots', weight: 10, damage: [0, 0.9] },
  { item: 'leather', weight: 10 },
  { item: 'bone', weight: 10 },
  { item: 'potion_water', weight: 10 },
  { item: 'string', weight: 5 },
  { item: 'fishing_rod', weight: 2, damage: [0, 0.9] },
  { item: 'bowl', weight: 10 },
  { item: 'stick', weight: 5 },
  { item: 'ink_sac', weight: 1, count: [10, 10] },
  { item: 'tripwire_hook', weight: 10 },
  { item: 'rotten_flesh', weight: 10 },
].map(entry);

defineLootTable('fishing_fish', [{ rolls: 1, bonusRolls: 0, entries: FISH_POOL }]);
defineLootTable('fishing_treasure', [{ rolls: 1, bonusRolls: 0, entries: TREASURE_POOL }]);
defineLootTable('fishing_junk', [{ rolls: 1, bonusRolls: 0, entries: JUNK_POOL }]);
// A plain `fishing` roll (no luck, open water) for callers that just want fish.
defineLootTable('fishing', [{ rolls: 1, bonusRolls: 0, entries: FISH_POOL }]);

// ---------------------------------------------------------------------------
// 3k. Piglin bartering
// ---------------------------------------------------------------------------

const BARTER_POOL = [
  { item: 'book', weight: 5, enchant: { name: 'soul_speed', level: [1, 3] } },
  { item: 'iron_boots', weight: 8, enchant: { name: 'soul_speed', level: [1, 3] } },
  { item: 'potion_fire_resistance', weight: 10 },
  { item: 'splash_potion_fire_resistance', weight: 10 },
  { item: 'water_bucket', weight: 10 },
  { item: 'iron_nugget', weight: 10, count: [9, 36] },
  { item: 'ender_pearl', weight: 10, count: [2, 4] },
  { item: 'string', weight: 20, count: [3, 9] },
  { item: 'quartz', weight: 20, count: [5, 12] },
  { item: 'obsidian', weight: 40 },
  { item: 'crying_obsidian', weight: 40, count: [1, 3] },
  { item: 'fire_charge', weight: 40 },
  { item: 'leather', weight: 40, count: [2, 4] },
  { item: 'soul_sand', weight: 40, count: [2, 8] },
  { item: 'nether_brick', weight: 40, count: [2, 8] },
  { item: 'gravel', weight: 40, count: [8, 16] },
  { item: 'iron_ingot', weight: 10 },
].map(entry);

defineLootTable('piglin_bartering', [{ rolls: 1, bonusRolls: 0, entries: BARTER_POOL }], ['bartering']);

// ===========================================================================
// 4. Rolling tables
// ===========================================================================

/** Turns one table entry into stacks and appends them to `out`. */
function rollEntry(out, e, r) {
  if (!e || e.empty || !e.item) return out;
  const item = e.item;
  const n = countOf(e.count, r, 1);
  if (n <= 0) return out;

  const needsUnique = e.damage || e.enchant || maxStack(item) === 1;
  if (!needsUnique) { push(out, item, n); return out; }

  // Damaged / enchanted results are always separate stacks.
  for (let i = 0; i < n; i++) {
    const s = st(item, 1);
    if (!s) break;
    if (e.damage) applyDamage(s, e.damage, r);
    if (e.enchant !== undefined && e.enchant !== null) {
      if (typeof e.enchant === 'number') enchantRandomly(s, r, e.enchant);
      else if (e.enchant === 'random') enchantRandomly(s, r);
      else if (typeof e.enchant === 'object' && e.enchant.name) {
        const lv = Array.isArray(e.enchant.level)
          ? rInt(r, e.enchant.level[0], e.enchant.level[1])
          : (e.enchant.level || 1);
        applyEnchant(s, e.enchant.name, lv);
      }
    }
    if (e.extra && typeof e.extra === 'object') Object.assign(s, e.extra);
    out.push(s);
  }
  return out;
}

// Unknown table names are reported once each; a structure that asks for a
// table nobody wrote should be visible, but not spam the console per chest.
const _warnedTables = new Set();

/**
 * Rolls a named chest loot table.
 * @param {string} tableName one of `LOOT_TABLES` (aliases accepted)
 * @param {object} rng       an RNG (or seed / function); optional
 * @returns {Array} ItemStacks, in roll order
 */
export function chestLoot(tableName, rng) {
  const table = getLootTable(tableName);
  const r = wrapRng(rng);
  if (!table) {
    if (tableName && !_warnedTables.has(tableName)) {
      _warnedTables.add(tableName);
      console.warn('[loot] unknown loot table:', tableName);
    }
    return chestLoot('default', r);
  }
  const out = [];
  for (let p = 0; p < table.pools.length; p++) {
    const pl = table.pools[p];
    if (!pl.entries.length) continue;
    let n = countOf(pl.rolls, r, 1);
    if (pl.bonusRolls) n += countOf(pl.bonusRolls, r, 0);
    for (let i = 0; i < n; i++) {
      const e = pickWeighted(pl.entries, r);
      rollEntry(out, e, r);
    }
  }
  return out;
}

/**
 * Rolls `tableName` and scatters the result across empty slots of a container.
 * Accepts an `Inventory` (size / get / set) or a plain array of slots.
 * @returns {number} how many stacks were actually placed
 */
export function fillChest(inventory, tableName, rng) {
  if (!inventory) return 0;
  const r = wrapRng(rng);
  const items = chestLoot(tableName, r);
  if (!items.length) return 0;

  const isArray = Array.isArray(inventory);
  const size = isArray ? inventory.length : (inventory.size | 0) || (inventory.slots ? inventory.slots.length : 27);
  const getAt = (i) => (isArray ? inventory[i] : (typeof inventory.get === 'function' ? inventory.get(i) : (inventory.slots ? inventory.slots[i] : null)));
  const setAt = (i, s) => {
    if (isArray) { inventory[i] = s; return; }
    if (typeof inventory.set === 'function') { inventory.set(i, s); return; }
    if (inventory.slots) inventory.slots[i] = s;
  };

  const free = [];
  for (let i = 0; i < size; i++) if (!getAt(i)) free.push(i);
  if (!free.length) return 0;
  r.shuffle(free);

  let placed = 0;
  for (let i = 0; i < items.length && i < free.length; i++) {
    setAt(free[i], items[i]);
    placed++;
  }
  return placed;
}

// ===========================================================================
// 5. Fishing
// ===========================================================================

// Vanilla's three fishing sub-pools, with the quality bias luck shifts.
const FISHING_POOLS = [
  { name: 'junk', weight: 10, quality: -2, entries: JUNK_POOL, openWaterOnly: false },
  { name: 'treasure', weight: 5, quality: 2, entries: TREASURE_POOL, openWaterOnly: true },
  { name: 'fish', weight: 85, quality: -1, entries: FISH_POOL, openWaterOnly: false },
];

/**
 * Rolls what a fishing rod catches.
 * `luck` is Luck of the Sea plus the Luck effect; `openWater` gates the
 * treasure pool exactly like vanilla.
 * @returns {Array} usually a single ItemStack
 */
export function fishingLoot(rng, luck = 0, openWater = true) {
  const r = wrapRng(rng);
  const l = Number.isFinite(luck) ? luck : 0;
  const choices = [];
  for (let i = 0; i < FISHING_POOLS.length; i++) {
    const p = FISHING_POOLS[i];
    if (p.openWaterOnly && !openWater) continue;
    const w = Math.max(0, Math.floor(p.weight + p.quality * l));
    if (w <= 0) continue;
    choices.push({ weight: w, poolRef: p });
  }
  if (!choices.length) return [];
  const chosen = pickWeighted(choices, r);
  const poolDef = chosen ? chosen.poolRef : FISHING_POOLS[2];

  // Luck also biases the entries inside the chosen pool.
  const weighted = poolDef.entries.map((e) => ({
    weight: Math.max(1, Math.floor((e.weight || 1) + (e.quality || 0) * l)),
    ref: e,
  }));
  const pick = pickWeighted(weighted, r);
  const out = [];
  rollEntry(out, pick ? pick.ref : poolDef.entries[0], r);
  return out;
}

// ===========================================================================
// 6. Piglin bartering
// ===========================================================================

/**
 * One piglin barter result for a gold ingot.
 * @returns {Array} a single ItemStack
 */
export function barteringLoot(rng) {
  const r = wrapRng(rng);
  const e = pickWeighted(BARTER_POOL, r);
  const out = [];
  rollEntry(out, e, r);
  return out;
}

// ===========================================================================
// 7. Misc helpers other modules may want
// ===========================================================================

/**
 * Loot a mob drops when sheared rather than killed (sheep wool, mooshroom
 * mushrooms, snow golem pumpkin, bogged mushrooms).
 * @returns {Array} ItemStacks
 */
export function shearDrops(mob, rng = null) {
  const def = mobDefOf(mob);
  if (!def || !def.shearDrops) return [];
  const r = wrapRng(rng || (mob && mob.rng));
  const out = [];
  for (const d of def.shearDrops) {
    if (!d) continue;
    const item = typeof d.item === 'function' ? d.item(mob) : d.item;
    if (!item) continue;
    push(out, item, rInt(r, d.min === undefined ? 1 : d.min, d.max === undefined ? (d.min === undefined ? 1 : d.min) : d.max));
  }
  return out;
}

/**
 * The blocks a container spills when it is broken - used by blockupdate.js for
 * chests, furnaces, hoppers and shulker boxes.
 * @returns {Array} ItemStacks (the container plus its contents)
 */
export function containerDrops(world, x, y, z, id, meta = 0) {
  const out = blockDrops(world, x, y, z, id, meta, null, null);
  const be = world && typeof world.getBlockEntity === 'function' ? world.getBlockEntity(x, y, z) : null;
  const items = be && be.items ? be.items : null;
  if (!items) return out;
  for (let i = 0; i < items.length; i++) {
    const s = items[i];
    if (s && s.item && s.count > 0) out.push(s);
  }
  return out;
}

/** Human-readable list of every registered table; handy for /loot and tests. */
export function lootTableNames() {
  return LOOT_TABLE_NAMES.slice();
}

export default LOOT_TABLES;
