// ============================================================================
// combat.js - Damage, knockback, explosions, projectiles and lightning.
//
// This module owns the *rules* of a fight. It deliberately keeps no state of
// its own: every function takes the entities and the world it needs, so the
// player, mobs, projectiles, TNT and the chat commands can all share one
// implementation of "what does this hit actually do?".
//
// The damage pipeline, in the order vanilla applies it:
//
//   1. eligibility        dead / removed / creative / spectator / invulnerable
//   2. immunities         fire-immune vs a fire source, undead vs poison, ...
//   3. difficulty         mob damage against a player scales with difficulty
//   4. shield             a blocked hit is cancelled outright (and can disable
//                         the shield when the attacker swings an axe)
//   5. i-frames           10 ticks; inside them only a *bigger* hit lands, and
//                         only for the difference
//   6. armour             damage * (1 - min(20, max(a/5, a - d/(2+t/4)))/25)
//   7. protection         damage * (1 - min(20, EPF)/25)
//   8. resistance         damage * (1 - 0.2 * level)
//   9. absorption         eaten from the yellow hearts first
//  10. health, thorns, knockback, hurt animation, death -> drops + xp
//
// Velocities everywhere in this project are **blocks per second**, so vanilla's
// per-tick numbers are multiplied by 20 (TICKS_PER_SECOND) on the way in.
// ============================================================================
import {
  TICKS_PER_SECOND, WORLD_HEIGHT, MAX_AIR, MAX_ABSORPTION, DIFFICULTY,
  DIM_OVERWORLD, DIM_NETHER,
} from '../core/constants.js';
import { AABB, clamp, lerp } from '../core/util.js';
import { RNG } from '../core/rng.js';
import { Game } from '../core/game.js';
import { getBlock, blockByName } from '../world/blocks.js';
import { getItem } from '../item/items.js';
import { damageStack } from '../item/inventory.js';
import { blockDrops } from '../item/loot.js';
import {
  getEnchant, bonusDamage, maceDamageBonus, damageReduction, protectionPoints,
  thornsDamage, knockbackBonus, fireAspectSeconds, powerBonus, efficiencyBonus,
  respirationBonusTicks,
} from '../item/enchanting.js';
import {
  damageMultiplier, knockbackResistance, attackDamageBonus, attackSpeedMultiplier,
  triggerDeathEffects, isUndead,
} from '../item/effects.js';

// ---------------------------------------------------------------------------
// Lazily resolved siblings.
//
// projectiles.js, itementity.js and mobs.js all import this file back (or sit
// above it in the graph), so they are pulled in dynamically. The promises land
// long before the first punch is thrown; every call site degrades gracefully.
// ---------------------------------------------------------------------------
const MOD = { projectiles: null, itementity: null, mobs: null };
let _depsStarted = false;

function loadDeps() {
  if (_depsStarted) return;
  _depsStarted = true;
  const grab = (path, key) => {
    try {
      import(path).then((m) => { MOD[key] = m; }).catch(() => { /* optional */ });
    } catch { /* environment without dynamic import */ }
  };
  grab('./projectiles.js', 'projectiles');
  grab('./itementity.js', 'itementity');
  grab('./mobs.js', 'mobs');
}
loadDeps();

// ---------------------------------------------------------------------------
// Tunables
// ---------------------------------------------------------------------------

/** Ticks of invulnerability after a hit lands. */
export const HURT_RESISTANT_TICKS = 10;
/** Base melee knockback, in vanilla blocks-per-tick units. */
const BASE_KNOCKBACK = 0.4;
/** Shield disable, in ticks (5 seconds). */
const SHIELD_DISABLE_TICKS = 100;
/** Ticks a shield must be held up before it actually blocks. */
const SHIELD_WARMUP_TICKS = 5;
/** Muzzle velocity of a fully drawn bow, blocks per second (3 blocks/tick). */
export const ARROW_SPEED = 60;
/** Vanilla's per-axis spread constant, radians of jitter per inaccuracy point. */
const INACCURACY_UNIT = 0.0172275;
/** Explosion ray march step, in blocks. */
const RAY_STEP = 0.3;
/** Strength bled off per ray step even through open air. */
const RAY_DECAY = 0.22500001;
/** Lightning damage, in half-hearts. */
const LIGHTNING_DAMAGE = 5;
/** Radius, in blocks, within which a bolt hurts. */
const LIGHTNING_RADIUS = 3.5;

/** Fallback randomness for callers that hand us no world and no rng. */
const FALLBACK_RNG = new RNG(0xc0ffee);

// Block ids resolved once; blocks.js is a static import so its registry is
// complete before this module body runs.
const idOf = (name) => { const d = blockByName(name); return d ? d.id : -1; };
const ID_FIRE = idOf('fire');
const ID_TNT = idOf('tnt');
const ID_LIGHTNING_ROD = idOf('lightning_rod');

/** Blocks an explosion must never remove, whatever its power. */
const INDESTRUCTIBLE = new Set([
  'bedrock', 'barrier', 'structure_void', 'structure_block', 'jigsaw', 'command_block',
  'chain_command_block', 'repeating_command_block', 'end_portal', 'end_portal_frame',
  'end_gateway', 'nether_portal', 'light', 'moving_piston', 'reinforced_deepslate',
]);

/** Damage types that ignore armour entirely. */
const BYPASS_ARMOR = new Set([
  'out_of_world', 'void', 'starve', 'drown', 'dry_out', 'wither', 'wither_effect', 'magic',
  'indirect_magic', 'poison', 'kill', 'generic_kill', 'freeze', 'fly_into_wall',
  'sonic_boom', 'in_wall', 'cramming', 'thorns', 'effect', 'dragon_breath', 'bad_respawn_point',
]);
/** Damage types that ignore *everything*, including resistance and protection. */
const BYPASS_ALL = new Set(['out_of_world', 'void', 'kill', 'generic_kill', 'bad_respawn_point']);
/** Damage types that are fire, for fire resistance and Fire Protection. */
const FIRE_TYPES = new Set([
  'in_fire', 'on_fire', 'fire', 'lava', 'hot_floor', 'burn', 'campfire', 'magma',
  'fireball', 'small_fireball', 'blaze_fireball', 'unattributed_fireball',
]);
/** Damage types that count as magic for the Protection maths. */
const MAGIC_TYPES = new Set([
  'magic', 'indirect_magic', 'wither', 'wither_effect', 'potion', 'thorns', 'dragon_breath',
  'effect', 'sonic_boom', 'poison', 'harm',
]);
/** Damage types carried by something flying through the air. */
const PROJECTILE_TYPES = new Set([
  'arrow', 'projectile', 'thrown', 'trident', 'fireball', 'small_fireball',
  'dragon_fireball', 'wither_skull', 'shulker_bullet', 'llama_spit', 'snowball', 'egg',
  'spectral_arrow', 'firework', 'wind_charge', 'mob_projectile',
]);
/** Damage types produced by a blast. */
const EXPLOSION_TYPES = new Set(['explosion', 'creeper', 'tnt', 'bed', 'blast', 'firework', 'end_crystal']);
/** Damage types a shield cannot stop. */
const BYPASS_SHIELD = new Set([
  'out_of_world', 'void', 'starve', 'drown', 'wither', 'wither_effect', 'magic', 'poison',
  'fall', 'in_wall', 'suffocate', 'cramming', 'freeze', 'lightning', 'sonic_boom',
  'on_fire', 'in_fire', 'lava', 'hot_floor', 'effect', 'dragon_breath', 'thorns', 'kill',
]);
/** Damage types the game scales by world difficulty when a player is hit. */
const DIFFICULTY_SCALED = new Set([
  'mob', 'mob_attack', 'mob_projectile', 'sting', 'arrow', 'trident', 'fireball',
  'small_fireball', 'wither_skull', 'dragon_breath', 'explosion', 'creeper', 'tnt',
  'magic', 'indirect_magic', 'thrown', 'llama_spit', 'shulker_bullet', 'sonic_boom',
]);

// Scratch objects: combat runs inside the tick loop, so nothing here allocates
// per hit beyond the damage-source record itself.
const _boxA = new AABB();
const _boxB = new AABB();

// ---------------------------------------------------------------------------
// Tiny shared helpers
// ---------------------------------------------------------------------------

/** Plays a positional sound if the audio engine is up. Never throws. */
function playAt(world, name, x, y, z, volume = 1, pitch = 1) {
  if (!name) return;
  try { Game.audio?.playAt?.(name, x, y, z, volume, pitch); } catch { /* audio is optional */ }
}

/** Spawns particles if the particle system is up. Never throws. */
function particles(type, x, y, z, opts) {
  try { Game.particles?.spawn?.(type, x, y, z, opts || {}); } catch { /* optional */ }
}

/** Block-shard particles for a block an explosion just removed. */
function blockDebris(x, y, z, id) {
  const p = Game.particles;
  if (!p) return;
  try {
    if (typeof p.blockBreak === 'function') { p.blockBreak(x, y, z, id); return; }
    p.spawn?.('block', x + 0.5, y + 0.5, z + 0.5, { count: 4, spread: 0.6, blockId: id });
  } catch { /* optional */ }
}

/** The randomness a world (or an entity) carries, with a global fallback. */
function rngOf(host) {
  if (host && host.rng && typeof host.rng.next === 'function') return host.rng;
  return FALLBACK_RNG;
}

/** Eye-height Y of any entity, players included. */
function eyeY(e) {
  return e.y + (e.eyeHeight !== undefined ? e.eyeHeight : (e.height || 1) * 0.85);
}

/** Vertical centre of an entity's body. */
function centreY(e) {
  return e.y + (e.height || 1) * 0.5;
}

/** Fills `out` with an entity's world-space bounding box. */
function entityBox(e, out) {
  const b = out || new AABB();
  const hw = (e.width || 0.6) * 0.5;
  const h = e.height || 1.8;
  return b.set(e.x - hw, e.y, e.z - hw, e.x + hw, e.y + h, e.z + hw);
}

/** True for a player in creative or spectator mode. */
function isProtectedMode(e) {
  const m = e && e.gameMode;
  return m === 'creative' || m === 'spectator';
}

/** True when nothing about this entity can burn. */
function fireImmune(e) {
  if (!e) return true;
  if (e.fireImmune || e.fireResistant) return true;
  if (e.def && e.def.fireImmune) return true;
  if (typeof e.hasEffect === 'function' && e.hasEffect('fire_resistance')) return true;
  return isProtectedMode(e);
}

/**
 * The four armour stacks of an entity as a plain array.
 * LivingEntity indexes `equipment` numerically while Mob keys it by slot name,
 * so both shapes are read here rather than assumed anywhere downstream.
 */
export function armorStacksOf(entity) {
  if (!entity) return EMPTY_ARMOR;
  const eq = entity.equipment;
  if (Array.isArray(eq)) return [eq[0] || null, eq[1] || null, eq[2] || null, eq[3] || null];
  if (eq && typeof eq === 'object') {
    return [eq.head || null, eq.chest || null, eq.legs || null, eq.feet || null];
  }
  if (entity.inventory && typeof entity.inventory.getArmor === 'function') {
    try {
      return [
        entity.inventory.getArmor(0) || null, entity.inventory.getArmor(1) || null,
        entity.inventory.getArmor(2) || null, entity.inventory.getArmor(3) || null,
      ];
    } catch { /* fall through */ }
  }
  return EMPTY_ARMOR;
}
const EMPTY_ARMOR = [null, null, null, null];

/** Main-hand stack of any entity shape. */
export function heldItemOf(entity) {
  if (!entity) return null;
  if (typeof entity.getHeldItem === 'function') {
    try { const s = entity.getHeldItem(); if (s && s.item) return s; } catch { /* fall through */ }
  }
  const eq = entity.equipment;
  if (Array.isArray(eq) && eq[4] && eq[4].item) return eq[4];
  if (eq && typeof eq === 'object' && eq.mainhand && eq.mainhand.item) return eq.mainhand;
  return null;
}

/** Off-hand stack of any entity shape. */
export function offhandItemOf(entity) {
  if (!entity) return null;
  if (typeof entity.getOffhandItem === 'function') {
    try { const s = entity.getOffhandItem(); if (s && s.item) return s; } catch { /* fall through */ }
  }
  const eq = entity.equipment;
  if (Array.isArray(eq) && eq[5] && eq[5].item) return eq[5];
  if (eq && typeof eq === 'object' && eq.offhand && eq.offhand.item) return eq.offhand;
  return null;
}

/** Total armour points, folding in worn pieces. */
function armorPointsOf(entity) {
  if (!entity) return 0;
  if (typeof entity.getArmorPoints === 'function') {
    try { const v = entity.getArmorPoints(); if (typeof v === 'number') return Math.max(0, v); } catch { /* fall through */ }
  }
  let pts = entity.armor || 0;
  const list = armorStacksOf(entity);
  for (let i = 0; i < 4; i++) {
    const s = list[i];
    if (!s || !s.item) continue;
    const d = getItem(s.item);
    if (d.armor) pts += d.armor.defense || 0;
  }
  return Math.max(0, pts);
}

/** Armour toughness, which softens the big-hit penalty. */
function toughnessOf(entity) {
  if (!entity) return 0;
  if (typeof entity.getArmorToughness === 'function') {
    try { const v = entity.getArmorToughness(); if (typeof v === 'number') return Math.max(0, v); } catch { /* fall through */ }
  }
  let t = entity.armorToughness || 0;
  const list = armorStacksOf(entity);
  for (let i = 0; i < 4; i++) {
    const s = list[i];
    if (!s || !s.item) continue;
    const d = getItem(s.item);
    if (d.armor) t += d.armor.toughness || 0;
  }
  return Math.max(0, t);
}

/**
 * Wears every worn armour piece by a quarter of the damage it just stopped,
 * with a floor of one point - vanilla's `hurtArmor`.
 */
function wearArmor(entity, amount) {
  if (!entity || !(amount > 0)) return;
  if (entity.gameMode === 'creative' || entity.gameMode === 'spectator') return;
  const wear = Math.max(1, Math.floor(amount / 4));
  const eq = entity.equipment;
  const slots = Array.isArray(eq) ? [0, 1, 2, 3] : ['head', 'chest', 'legs', 'feet'];
  if (!eq || typeof eq !== 'object') return;
  for (let i = 0; i < slots.length; i++) {
    const s = eq[slots[i]];
    if (!s || !s.item) continue;
    if (!getItem(s.item).armor) continue;
    try {
      const left = damageStack(s, wear, entity);
      if (!left) eq[slots[i]] = null;
    } catch { /* durability is optional */ }
  }
}

/** True when mobs are allowed to rearrange the terrain in this world. */
function griefingAllowed(world) {
  return !world || !world.gameRules || world.gameRules.mobGriefing !== false;
}

/** Monotonic tick counter of a world, used for cooldown expiries. */
function worldTicks(world) {
  if (world && typeof world.totalTime === 'number') return world.totalTime;
  return Game.ticks || 0;
}

// ===========================================================================
// Damage sources
// ===========================================================================

/**
 * Builds a damage source in the canonical shape every other module reads.
 * @param {string} type registry-style name: 'player_attack', 'arrow', 'lava', ...
 * @param {object|null} entity the entity ultimately responsible (the archer)
 * @param {object|null} direct the thing that physically touched the target (the arrow)
 * @param {object|null} extra fields to merge over the derived defaults
 */
export function damageSource(type, entity = null, direct = null, extra = null) {
  const t = typeof type === 'string' && type ? type : 'generic';
  const fire = FIRE_TYPES.has(t);
  const magic = MAGIC_TYPES.has(t);
  const projectile = PROJECTILE_TYPES.has(t);
  const explosion = EXPLOSION_TYPES.has(t);
  const attacker = entity || direct || null;
  const src = {
    type: t,
    entity: attacker,
    direct: direct || entity || null,
    amount: 0,
    // reduction switches
    bypassArmor: BYPASS_ARMOR.has(t) || BYPASS_ALL.has(t),
    bypassMagic: BYPASS_ALL.has(t),
    bypassResistance: BYPASS_ALL.has(t),
    bypassCooldown: false,
    bypassInvulnerable: BYPASS_ALL.has(t),
    bypassShield: BYPASS_SHIELD.has(t),
    bypassCreative: BYPASS_ALL.has(t),
    // classification
    fire, magic, projectile, explosion,
    fall: t === 'fall' || t === 'fly_into_wall',
    effect: t === 'effect' || t === 'poison' || t === 'wither_effect',
    // knockback control
    knockback: undefined,
    noKnockback: false,
    knockedBack: false,
    scalesWithDifficulty: DIFFICULTY_SCALED.has(t) ||
      !!(attacker && !attacker.isPlayer && attacker.type !== 'player' && attacker.isMob),
  };
  if (extra) for (const k in extra) src[k] = extra[k];
  return src;
}

/** Accepts a source object, a bare type string or null and always yields a source. */
export function asDamageSource(source, fallbackType = 'generic') {
  if (!source) return damageSource(fallbackType);
  if (typeof source === 'string') return damageSource(source);
  if (typeof source !== 'object') return damageSource(fallbackType);
  if (typeof source.type !== 'string') source.type = fallbackType;
  // Sources built by other modules only set the fields they cared about; fill
  // in the rest so the pipeline below never reads undefined.
  if (source.bypassArmor === undefined) source.bypassArmor = BYPASS_ARMOR.has(source.type);
  if (source.bypassMagic === undefined) source.bypassMagic = BYPASS_ALL.has(source.type);
  if (source.bypassResistance === undefined) source.bypassResistance = BYPASS_ALL.has(source.type);
  if (source.fire === undefined) source.fire = FIRE_TYPES.has(source.type);
  if (source.magic === undefined) source.magic = MAGIC_TYPES.has(source.type);
  if (source.projectile === undefined) source.projectile = PROJECTILE_TYPES.has(source.type);
  if (source.explosion === undefined) source.explosion = EXPLOSION_TYPES.has(source.type);
  if (source.bypassShield === undefined) source.bypassShield = BYPASS_SHIELD.has(source.type);
  if (source.bypassInvulnerable === undefined) source.bypassInvulnerable = BYPASS_ALL.has(source.type);
  if (source.bypassCreative === undefined) source.bypassCreative = BYPASS_ALL.has(source.type);
  if (source.direct === undefined) source.direct = source.entity || null;
  if (source.scalesWithDifficulty === undefined) {
    const a = source.entity;
    source.scalesWithDifficulty = DIFFICULTY_SCALED.has(source.type) ||
      !!(a && !a.isPlayer && a.type !== 'player' && a.isMob);
  }
  return source;
}

/** World position a hit came from, used for the shield angle test. */
function sourcePosition(source, target) {
  const e = (source && (source.direct || source.entity)) || null;
  if (e && typeof e.x === 'number') return { x: e.x, y: centreY(e), z: e.z };
  if (source && typeof source.x === 'number' && typeof source.z === 'number') {
    return { x: source.x, y: source.y !== undefined ? source.y : centreY(target), z: source.z };
  }
  return null;
}

// ===========================================================================
// Difficulty
// ===========================================================================

/** Numeric difficulty 0..3, preferring a per-world override over the session. */
function difficultyId(world) {
  if (world && typeof world.difficulty === 'number') return clamp(world.difficulty | 0, 0, 3);
  const d = Game.difficulty;
  return typeof d === 'number' ? clamp(d | 0, 0, 3) : DIFFICULTY.NORMAL;
}

/**
 * Vanilla's "local difficulty": 0 on peaceful, ~0.75 / ~1.5 / ~2.25 for
 * easy / normal / hard on a fresh world, creeping up towards 1.5 / 3 / 4.5 as
 * the world ages and with the moon phase. Spawning, mob gear rolls and the
 * fire chance of an explosion all read it.
 * @returns {number} 0 .. 6.75
 */
export function difficultyScale(world) {
  const id = difficultyId(world);
  if (id <= DIFFICULTY.PEACEFUL) return 0;
  const hard = id === DIFFICULTY.HARD;
  const age = world && typeof world.totalTime === 'number' ? world.totalTime : (Game.ticks || 0);
  // Age contributes over the first ~20 in-game hours, then saturates.
  const ageFactor = clamp((age - 72000) / 1440000, 0, 1) * 0.25;
  let f = 0.75 + ageFactor;
  // Moon phase: full moon nights are the dangerous ones.
  const day = world && typeof world.totalTime === 'number' ? Math.floor(world.totalTime / 24000) : 0;
  const moon = MOON_BRIGHTNESS[((day % 8) + 8) % 8];
  let bonus = clamp(age / 3600000, 0, 1) * (hard ? 1 : 0.75);
  bonus += clamp(moon * 0.5, 0, ageFactor);
  if (id === DIFFICULTY.EASY) bonus *= 0.5;
  return id * (f + bonus);
}
/** Vanilla moon-phase brightness, index 0 = full moon. */
const MOON_BRIGHTNESS = [1, 0.75, 0.5, 0.25, 0, 0.25, 0.5, 0.75];

/**
 * Vanilla's player-side difficulty curve. Easy halves big hits, hard adds 50%.
 * Only applied to sources flagged `scalesWithDifficulty`.
 */
function scaleForPlayer(amount, world) {
  const id = difficultyId(world);
  if (id === DIFFICULTY.PEACEFUL) return 0;
  if (id === DIFFICULTY.EASY) return Math.min(amount / 2 + 1, amount);
  if (id === DIFFICULTY.HARD) return amount * 1.5;
  return amount;
}

// ===========================================================================
// Targeting rules
// ===========================================================================

/**
 * True when `attacker` is allowed to damage `target` at all: alive, not a
 * protected player, not its own owner, not a member of the same species.
 * Everything that picks a victim - AI targeting, sweeping, explosions - runs
 * through here so friendly fire behaves consistently.
 */
export function canHarm(attacker, target) {
  if (!target || target.removed) return false;
  if (target.dead) return false;
  if (typeof target.health === 'number' && target.health <= 0) return false;
  if (target.isAlive && typeof target.isAlive === 'function' && !target.isAlive()) return false;
  if (isProtectedMode(target)) return false;
  if (target.invulnerable) return false;
  // Non-living scenery (dropped items, xp orbs) is not "harmed", it is destroyed.
  if (target.type === 'xp_orb') return false;
  if (!attacker) return true;
  if (attacker === target) return false;
  if (attacker.removed) return false;

  const targetsPlayer = !!(target.isPlayer || target.type === 'player');
  const attackerIsPlayer = !!(attacker.isPlayer || attacker.type === 'player');

  // Peaceful disarms every hostile mob.
  if (!attackerIsPlayer && targetsPlayer) {
    const world = target.world || attacker.world;
    if (difficultyId(world) === DIFFICULTY.PEACEFUL &&
        (attacker.category === 'hostile' || attacker.category === 'boss')) return false;
  }
  // Tamed animals never bite the hand that feeds them.
  if (attacker.tamed && attacker.owner && attacker.owner === target) return false;
  if (target.tamed && target.owner && target.owner === attacker && !attackerIsPlayer) return false;
  // Same species (and the same team of illagers) hold their fire.
  if (!attackerIsPlayer && !targetsPlayer && attacker.type && attacker.type === target.type) {
    if (!(attacker.def && attacker.def.friendlyFire)) return false;
  }
  if (attacker.def && target.def && attacker.def.illager && target.def.illager) return false;
  return true;
}

// ===========================================================================
// Reduction maths
// ===========================================================================

/**
 * Vanilla's armour formula. `armor` points are worth 4% each, but a big hit
 * punches through them unless toughness props them up.
 *   damage * (1 - min(20, max(armor/5, armor - damage/(2 + toughness/4))) / 25)
 */
export function armorDamageReduction(damage, armor, toughness = 0) {
  if (!(armor > 0) || !(damage > 0)) return Math.max(0, damage);
  const effective = clamp(
    Math.min(20, Math.max(armor / 5, armor - damage / (2 + toughness / 4))), 0, 20,
  );
  return damage * (1 - effective / 25);
}

/**
 * Fraction removed by the armour's protection enchantments, capped at 20 EPF
 * (so 0.8 at most). Feather Falling, Blast, Fire and Projectile Protection all
 * fold in through enchanting.js.
 */
export function enchantProtection(target, source) {
  const stacks = armorStacksOf(target);
  if (!stacks[0] && !stacks[1] && !stacks[2] && !stacks[3]) return 0;
  try { return clamp(damageReduction(stacks, source), 0, 0.8); } catch { return 0; }
}

/** Incoming-damage multiplier from the Resistance effect. 0 means immune. */
export function resistanceMultiplier(target) {
  try { return clamp(damageMultiplier(target), 0, 1); } catch { return 1; }
}

/**
 * Runs stages 6-8 of the pipeline: armour, protection enchantments, then the
 * resistance effect. Exposed so the HUD and tooltips can preview a hit without
 * dealing one.
 * @returns {number} the damage that will actually reach absorption and health
 */
export function reduceDamage(target, amount, source = null) {
  const src = asDamageSource(source);
  let dmg = amount;
  if (!(dmg > 0)) return 0;
  if (BYPASS_ALL.has(src.type)) return dmg;

  if (!src.bypassArmor) {
    dmg = armorDamageReduction(dmg, armorPointsOf(target), toughnessOf(target));
  }
  if (!src.bypassResistance) dmg *= resistanceMultiplier(target);
  if (dmg <= 0) return 0;
  if (!src.bypassMagic) dmg *= 1 - enchantProtection(target, src);
  return Math.max(0, dmg);
}

// ===========================================================================
// Shields
// ===========================================================================

/** Ticks left on an entity's shield cooldown, 0 when it is ready. */
export function shieldCooldownRemaining(entity) {
  if (!entity) return 0;
  const until = entity.shieldDisabledUntil;
  if (typeof until !== 'number') return Math.max(0, entity.shieldCooldown | 0);
  const now = worldTicks(entity.world);
  return Math.max(0, until - now);
}

/** The shield stack an entity is currently holding up, or null. */
function activeShield(entity) {
  if (!entity || entity.blocking !== true) return null;
  if (shieldCooldownRemaining(entity) > 0) return null;
  if (typeof entity.useTicks === 'number' && entity.useTicks < SHIELD_WARMUP_TICKS) return null;
  const isShield = (s) => !!(s && s.item && getItem(s.item).useAction === 'block');
  if (isShield(entity.usingItem)) return entity.usingItem;
  const off = offhandItemOf(entity);
  if (isShield(off)) return off;
  const main = heldItemOf(entity);
  if (isShield(main)) return main;
  return null;
}

/**
 * True when the raised shield actually covers this hit: vanilla projects the
 * attacker-to-victim vector onto the horizontal plane and requires it to point
 * into the victim's face.
 */
export function isBlocking(entity, source) {
  const shield = activeShield(entity);
  if (!shield) return false;
  const src = asDamageSource(source);
  if (src.bypassShield) return false;
  // Piercing arrows go straight through a shield.
  const direct = src.direct;
  if (direct && (direct.pierce > 0 || direct.piercing > 0)) return false;

  const pos = sourcePosition(src, entity);
  if (!pos) return false;
  // View vector, flattened. yaw 0 looks towards +Z in this project.
  const vx = -Math.sin(entity.yaw || 0);
  const vz = Math.cos(entity.yaw || 0);
  let tx = entity.x - pos.x, tz = entity.z - pos.z;
  const len = Math.hypot(tx, tz);
  if (len < 1e-4) return false;
  tx /= len; tz /= len;
  return tx * vx + tz * vz < 0;
}

/**
 * Consumes a blocked hit: shield durability, the block sound, a shove back at
 * the attacker, and the axe-swing that disables the shield for five seconds.
 */
function consumeBlock(target, amount, src) {
  const shield = activeShield(target);
  const world = target.world;
  playAt(world, 'shield_block', target.x, centreY(target), target.z, 0.9, 0.8 + Math.random() * 0.4);
  particles('block', target.x, centreY(target), target.z, { count: 4, spread: 0.4 });

  if (shield && amount >= 3) {
    const wear = 1 + Math.floor(amount);
    try { damageStack(shield, wear, target); } catch { /* durability is optional */ }
  }

  const attacker = src.direct || src.entity;
  if (attacker && attacker !== target && typeof attacker.x === 'number') {
    // Melee attackers bounce off the boss of the shield.
    if (!src.projectile && typeof attacker.knockback === 'function') {
      try { attacker.knockback(target.x - attacker.x, target.z - attacker.z, 0.5); } catch { /* optional */ }
    }
    // An axe (or a mace) shatters the guard.
    const weapon = heldItemOf(src.entity);
    const kind = weapon && weapon.item ? (getItem(weapon.item).tool || {}).kind : null;
    if (kind === 'axe' || kind === 'mace') {
      let chance = 0.25 + efficiencyBonus(weapon) * 0.05;
      if (src.entity && src.entity.sprinting) chance += 0.75;
      if (Math.random() < chance) disableShield(target);
    }
  }
  // Arrows and fireballs bounce off instead of stopping dead.
  if (src.projectile && src.direct && src.direct !== src.entity) {
    deflectProjectile(src.direct, target, { power: 0.35, reown: false });
  }
  target.hurtTime = Math.max(target.hurtTime | 0, 3);
  target.maxHurtTime = Math.max(target.maxHurtTime | 0, 3);
  return true;
}

/** Puts a shield on its 5-second cooldown and drops the guard. */
export function disableShield(entity) {
  if (!entity) return;
  entity.shieldDisabledUntil = worldTicks(entity.world) + SHIELD_DISABLE_TICKS;
  entity.shieldCooldown = SHIELD_DISABLE_TICKS;
  entity.blocking = false;
  if (entity.usingItem && entity.usingItem.item &&
      getItem(entity.usingItem.item).useAction === 'block') {
    entity.usingItem = null;
    entity.useTicks = 0;
  }
  try { entity.setCooldown?.('shield', SHIELD_DISABLE_TICKS); } catch { /* optional */ }
  playAt(entity.world, 'shield_break', entity.x, centreY(entity), entity.z, 0.8, 0.9);
}

// ===========================================================================
// damageEntity - the whole pipeline
// ===========================================================================

/**
 * Applies damage to an entity, running the full vanilla pipeline.
 * @param {object} target anything with health
 * @param {number} amount half-hearts, before any reduction
 * @param {object|string|null} source a damage source (see `damageSource`)
 * @returns {boolean} true when health or absorption actually moved
 */
export function damageEntity(target, amount, source = null) {
  if (!target || target.removed) return false;
  const src = asDamageSource(source);
  src.amount = amount;

  // --- 1. eligibility ------------------------------------------------------
  if (target.dead) return false;
  if (typeof target.health === 'number' && target.health <= 0) return false;
  if (target.invulnerable && !src.bypassInvulnerable) return false;
  if (target.gameMode === 'spectator') return false;
  if (target.gameMode === 'creative' && !src.bypassCreative) return false;
  if (target.teleporting) return false;            // an enderman mid-blink
  if (!(amount > 0)) return false;

  // --- 2. immunities -------------------------------------------------------
  if (src.fire && fireImmune(target)) return false;
  if (src.type === 'poison' && isUndead(target)) return false;
  if (src.type === 'drown' && (target.canBreatheUnderwater || target.waterMob)) return false;

  const world = target.world || (src.entity && src.entity.world) || Game.world;
  const targetIsPlayer = !!(target.isPlayer || target.type === 'player');

  // --- mob species hook (endermen blink out, witches shrug off magic) -------
  // mobs.js gives every definition a no-argument default that returns false;
  // only a hook that actually declares parameters is treated as a real veto.
  const hook = target.def && target.def.onHurt;
  if (typeof hook === 'function' && hook.length > 0) {
    try {
      const r = hook(target, amount, src);
      if (r === false) return false;
      if (typeof r === 'number') {
        amount = r;
        if (!(amount > 0)) return false;
      }
    } catch (e) { console.error('[combat] onHurt hook failed for', target.type, e); }
  }

  // --- 3. difficulty -------------------------------------------------------
  if (targetIsPlayer && src.scalesWithDifficulty) {
    amount = scaleForPlayer(amount, world);
    if (!(amount > 0)) return false;
  }

  // --- 4. shield -----------------------------------------------------------
  if (isBlocking(target, src)) {
    consumeBlock(target, amount, src);
    return false;
  }

  // --- 5. invulnerability frames ------------------------------------------
  const hurtTime = target.hurtTime | 0;
  const lastAmount = target.lastDamageAmount || 0;
  if (!src.bypassCooldown && hurtTime > HURT_RESISTANT_TICKS / 2) {
    // A stronger hit still lands, but only for the difference.
    if (amount <= lastAmount) return false;
    amount -= lastAmount;
    target.lastDamageAmount = lastAmount + amount;
  } else {
    target.lastDamageAmount = amount;
  }

  // --- 6/7/8. armour, protection, resistance -------------------------------
  const reduced = reduceDamage(target, amount, src);
  if (!(reduced > 0)) {
    // Fully absorbed: still flinch, so the player can see the armour working.
    target.hurtTime = HURT_RESISTANT_TICKS;
    target.maxHurtTime = HURT_RESISTANT_TICKS;
    playAt(world, 'attack_nodamage', target.x, centreY(target), target.z, 0.6, 1);
    return false;
  }

  // --- 9. absorption then health ------------------------------------------
  let remaining = reduced;
  let dealt = 0;
  if (target.absorption > 0) {
    const eaten = Math.min(target.absorption, remaining);
    target.absorption -= eaten;
    remaining -= eaten;
    dealt += eaten;
    if (target.absorption <= 0) target.absorption = 0;
  }
  if (remaining > 0) {
    const before = target.health;
    target.health = Math.max(0, before - remaining);
    dealt += before - target.health;
  }
  if (dealt <= 0) return false;

  // --- 10. reactions -------------------------------------------------------
  target.lastDamageSource = src;
  if (!src.bypassCooldown) {
    target.hurtTime = HURT_RESISTANT_TICKS;
    target.maxHurtTime = HURT_RESISTANT_TICKS;
  } else if ((target.hurtTime | 0) <= 0) {
    target.hurtTime = 5;
    target.maxHurtTime = 5;
  }

  const attacker = src.entity || src.direct || null;
  if (attacker && attacker !== target && typeof attacker.x === 'number') {
    target.hurtDir = Math.atan2(attacker.z - target.z, attacker.x - target.x);
    target.lastAttacker = attacker;
    target.lastAttackedTicks = 0;
    target.lastHurtBy = attacker;
    target.lastHurtByTicks = 100;
    // Aggro. Passive mobs bolt instead of fighting back.
    if (typeof target.shouldRetaliate === 'function') {
      try { if (target.shouldRetaliate(attacker)) target.setTarget?.(attacker); } catch { /* optional */ }
    }
    if (target.def && target.def.category === 'passive') target.panicTicks = Math.max(target.panicTicks | 0, 100);
    if (target.sitting) target.sitting = false;
  }

  // Armour wears out as it works, a quarter of the damage it stopped.
  if (!src.bypassArmor) wearArmor(target, amount);

  // Thorns pays the attacker back out of the armour. Vanilla credits the
  // shooter, not the arrow, so `entity` is used rather than `direct`.
  const reflectTo = src.entity || src.direct;
  if (reflectTo && reflectTo !== target && !src.thorns && typeof reflectTo.health === 'number') {
    let thorns = 0;
    try { thorns = thornsDamage(armorStacksOf(target), rngOf(target)); } catch { thorns = 0; }
    if (thorns > 0) {
      damageEntity(reflectTo, thorns, damageSource('thorns', target, target, {
        magic: true, bypassArmor: true, bypassCooldown: true, thorns: true, noKnockback: true,
      }));
    }
  }

  // Knockback. `knockedBack` keeps this from stacking with entity.js's own
  // shove if both paths ever run for the same hit.
  if (attacker && !src.noKnockback && !src.knockedBack && attacker !== target) {
    src.knockedBack = true;
    const strength = src.knockback !== undefined ? src.knockback : BASE_KNOCKBACK;
    applyKnockback(target, attacker.x, centreY(attacker), attacker.z, strength);
  }

  // Hurt animation, sound, red flash.
  const hurtSound = (target.def && target.def.sounds && target.def.sounds.hurt) ||
    target.hurtSound || (targetIsPlayer ? 'player_hurt' : 'hurt');
  playAt(world, hurtSound, target.x, centreY(target), target.z, 0.9,
    1 + (Math.random() - 0.5) * 0.2);
  particles('damage', target.x, centreY(target), target.z, { count: 4, spread: (target.width || 0.6) });
  if (typeof target.limbSwingAmount === 'number') {
    target.limbSwingAmount = Math.max(target.limbSwingAmount, 0.35);
  }
  if (targetIsPlayer) {
    try { target.addExhaustion?.(0.1); } catch { /* optional */ }
    Game.emit('playerhurt', dealt, src);
  }
  Game.emit('entityhurt', target, dealt, src);

  // --- death ---------------------------------------------------------------
  if (target.health <= 0) {
    if (!tryTotemOfUndying(target, src)) routeDeath(target, src);
  }
  return true;
}

/**
 * Totem of Undying: consumes a totem held in either hand, leaves the entity on
 * half a heart and hands out the vanilla cocktail of effects.
 * @returns {boolean} true when death was cancelled
 */
function tryTotemOfUndying(target, src) {
  if (src && (src.type === 'out_of_world' || src.type === 'void' || src.type === 'kill')) return false;
  const hands = [heldItemOf(target), offhandItemOf(target)];
  let totem = null;
  for (const s of hands) if (s && s.item === 'totem_of_undying') { totem = s; break; }
  if (!totem) return false;

  totem.count = Math.max(0, (totem.count | 0) - 1);
  if (totem.count <= 0) {
    // Clear the emptied stack out of whichever slot held it.
    const eq = target.equipment;
    if (Array.isArray(eq)) { for (let i = 0; i < eq.length; i++) if (eq[i] === totem) eq[i] = null; }
    else if (eq && typeof eq === 'object') { for (const k in eq) if (eq[k] === totem) eq[k] = null; }
    const inv = target.inventory;
    if (inv && typeof inv.size === 'number' && typeof inv.get === 'function') {
      for (let i = 0; i < inv.size; i++) if (inv.get(i) === totem) { inv.set(i, null); break; }
    }
  }

  target.health = 1;
  target.absorption = Math.max(target.absorption || 0, 2);
  try {
    target.addEffect?.('regeneration', 900, 1);
    target.addEffect?.('absorption', 100, 1);
    target.addEffect?.('fire_resistance', 800, 0);
  } catch { /* effects are optional */ }
  target.fireTicks = 0;
  target.hurtTime = HURT_RESISTANT_TICKS;
  target.maxHurtTime = HURT_RESISTANT_TICKS;
  playAt(target.world, 'totem_use', target.x, centreY(target), target.z, 1, 1);
  particles('totem', target.x, centreY(target), target.z, { count: 40, spread: 1, life: 1.6 });
  Game.emit('totem', target);
  return true;
}

/**
 * Routes a lethal hit into drops, experience and the death animation. Mobs own
 * a richer routine (species hook, looting-aware drops); everything else goes
 * through the standard `kill()`.
 */
function routeDeath(target, src) {
  target.health = 0;
  target.lastDamageSource = src;
  if (!target.dead && typeof target.handleDeath === 'function') {
    try { target.handleDeath(src); } catch (e) { console.error('[combat] handleDeath failed', e); }
    try { triggerDeathEffects(target); } catch { /* optional */ }
    // Stop LivingEntity.kill() from rolling a second set of drops.
    target.deathLootDropped = true;
  }
  if (!target.dead && typeof target.kill === 'function') {
    try { target.kill(src); } catch (e) { console.error('[combat] kill failed', e); }
  }
  if (!target.dead) {
    target.dead = true;
    Game.emit('entitydeath', target, src);
  }
  if (target.isPlayer || target.type === 'player') Game.emit('playerdeath', src);
}

// ===========================================================================
// Knockback
// ===========================================================================

/**
 * Shoves `target` away from the point (sx, sy, sz).
 * @param {object} target
 * @param {number} sx @param {number} sy @param {number} sz source position
 * @param {number} strength vanilla units (0.4 = a plain melee hit)
 * @param {boolean} [vertical] use the full 3D direction (explosions) instead of
 *        vanilla's horizontal-only melee shove
 * @returns {boolean} true when the target actually moved
 */
export function applyKnockback(target, sx, sy, sz, strength = BASE_KNOCKBACK, vertical = false) {
  if (!target || target.removed) return false;
  if (target.gameMode === 'spectator') return false;

  let resist = 0;
  try {
    resist = typeof target.getKnockbackResist === 'function'
      ? target.getKnockbackResist() : (target.knockbackResist || 0);
    resist += knockbackResistance(target);
  } catch { resist = target.knockbackResist || 0; }
  strength *= 1 - clamp(resist, 0, 1);
  if (!(strength > 0)) return false;

  let dx = target.x - sx;
  let dz = target.z - sz;
  const s = strength * TICKS_PER_SECOND;      // vanilla blocks/tick -> blocks/s

  if (vertical) {
    let dy = centreY(target) - sy;
    let len = Math.sqrt(dx * dx + dy * dy + dz * dz);
    if (len < 1e-4) {
      const a = Math.random() * Math.PI * 2;
      dx = Math.cos(a); dy = 0.5; dz = Math.sin(a);
      len = Math.sqrt(dx * dx + dy * dy + dz * dz);
    }
    target.vx += (dx / len) * s;
    target.vy += (dy / len) * s;
    target.vz += (dz / len) * s;
    if (target.vy > 24) target.vy = 24;
    target.onGround = false;
    target.fallDistance = 0;
    return true;
  }

  let len = Math.sqrt(dx * dx + dz * dz);
  if (len < 1e-4) {
    // Hit from directly above or below: pick a direction so the victim never
    // welds itself to the attacker.
    const a = Math.random() * Math.PI * 2;
    dx = Math.cos(a); dz = Math.sin(a); len = 1;
  }
  target.vx = target.vx * 0.5 + (dx / len) * s;
  target.vz = target.vz * 0.5 + (dz / len) * s;
  if (target.onGround) {
    target.vy = Math.min(8, target.vy * 0.5 + s);
    target.onGround = false;
  }
  return true;
}

// ===========================================================================
// Melee
// ===========================================================================

/** 0..1 charge of the attacker's swing timer; 1 is a full-strength hit. */
function attackStrengthOf(attacker) {
  if (!attacker) return 1;
  if (typeof attacker.getAttackStrength === 'function') {
    try {
      const v = attacker.getAttackStrength();
      if (typeof v === 'number' && isFinite(v)) return clamp(v, 0, 1);
    } catch { /* fall through */ }
  }
  if (typeof attacker.attackStrengthScale === 'number') return clamp(attacker.attackStrengthScale, 0, 1);
  if (typeof attacker.attackCooldown === 'number') {
    const period = Math.max(1, TICKS_PER_SECOND / Math.max(0.1, attackSpeedOf(attacker)));
    return clamp(1 - attacker.attackCooldown / period, 0, 1);
  }
  return 1;
}

/** Swings per second of the held weapon, after haste / mining fatigue. */
export function attackSpeedOf(attacker, stack = undefined) {
  const held = stack === undefined ? heldItemOf(attacker) : stack;
  let base = 4;                                  // bare hands
  if (held && held.item) {
    const tool = getItem(held.item).tool;
    if (tool && tool.attackSpeed) base = tool.attackSpeed;
  } else if (attacker && typeof attacker.attackSpeed === 'number' && !attacker.isPlayer) {
    base = attacker.attackSpeed;
  }
  let mult = 1;
  try { mult = attackSpeedMultiplier(attacker); } catch { mult = 1; }
  return Math.max(0.1, base * mult);
}

/** Raw weapon damage before effects, charge and criticals. */
function baseAttackDamage(attacker, held) {
  if (held && held.item) {
    const tool = getItem(held.item).tool;
    if (tool && typeof tool.damage === 'number' && tool.damage > 0) return tool.damage;
  }
  if (!attacker) return 1;
  if (attacker.isPlayer || attacker.type === 'player') return 1;   // bare fist
  if (typeof attacker.attackDamage === 'number' && attacker.attackDamage > 0) return attacker.attackDamage;
  if (attacker.def && typeof attacker.def.damage === 'number') return attacker.def.damage;
  return 1;
}

/** Vanilla's critical-hit conditions: falling, uncharged by sprinting, unimpeded. */
function isCriticalHit(attacker, target, charge) {
  if (!attacker || charge <= 0.9) return false;
  if (attacker.onGround) return false;
  if (!(attacker.fallDistance > 0) && !(attacker.vy < -0.1)) return false;
  if (attacker.onClimbable || attacker.inWater || attacker.submerged) return false;
  if (attacker.sprinting) return false;
  if (attacker.riding) return false;
  if (typeof attacker.hasEffect === 'function' && attacker.hasEffect('blindness')) return false;
  if (!target || target.health === undefined) return false;
  return true;
}

/**
 * Everything about one melee swing, without applying it. Callers that only
 * want the number use `computeDamage`.
 * @returns {{damage:number, base:number, bonus:number, charge:number,
 *            crit:boolean, sweep:boolean, knockback:number, fireSeconds:number}}
 */
export function computeAttack(attacker, target, stack = undefined) {
  const held = stack === undefined ? heldItemOf(attacker) : stack;
  // Only players pay the attack-cooldown tax; mobs swing at flat damage.
  const isPlayer = !!(attacker && (attacker.isPlayer || attacker.type === 'player'));
  const charge = isPlayer ? attackStrengthOf(attacker) : 1;

  // Weapon damage, then strength / weakness as flat attribute modifiers.
  let base = baseAttackDamage(attacker, held);
  try { base += attackDamageBonus(attacker); } catch { /* effects optional */ }
  if (base < 0) base = 0;

  // Sharpness, Smite, Bane of Arthropods and Impaling.
  let bonus = 0;
  try { bonus = held ? bonusDamage(held, target) : 0; } catch { bonus = 0; }

  // The cooldown curve: a fresh swing is worth 20%, a full one 100%.
  base *= 0.2 + charge * charge * 0.8;
  bonus *= charge;

  const crit = isPlayer && isCriticalHit(attacker, target, charge);
  if (crit) base *= 1.5;

  let damage = base + bonus;
  // The mace pays out for the height you dropped from.
  try { damage += maceDamageBonus(held, attacker ? attacker.fallDistance || 0 : 0); } catch { /* optional */ }
  if (damage < 0) damage = 0;

  // Sweeping needs a fully charged sword swing from a standing start.
  const kind = held && held.item ? (getItem(held.item).tool || {}).kind : null;
  const speed = attacker ? Math.hypot(attacker.vx || 0, attacker.vz || 0) : 0;
  const sweep = isPlayer && charge > 0.9 && !crit && kind === 'sword' &&
    !attacker.sprinting && !!attacker.onGround && speed < 3.5;

  let kb = BASE_KNOCKBACK;
  try { kb += knockbackBonus(held) * 0.5; } catch { /* optional */ }
  if (attacker && attacker.sprinting) kb += 0.5;

  let fireSeconds = 0;
  try { fireSeconds = fireAspectSeconds(held); } catch { fireSeconds = 0; }
  if (attacker && attacker.fireTicks > 0 && !fireImmune(attacker) && fireSeconds <= 0) fireSeconds = 2;

  return { damage, base, bonus, charge, crit, sweep, knockback: kb, fireSeconds, stack: held };
}

/**
 * Damage one melee swing would deal, in half-hearts.
 * @param {object} attacker
 * @param {object} target
 * @param {object} [stack] the weapon; defaults to the attacker's main hand
 */
export function computeDamage(attacker, target, stack = undefined) {
  return computeAttack(attacker, target, stack).damage;
}

/**
 * The complete melee attack: damage, criticals, sweeping, fire aspect, the
 * weapon's own hit hook and the attack cooldown reset.
 * @returns {boolean} true when the hit landed
 */
export function meleeAttack(attacker, target, stack = undefined) {
  if (!attacker || !target) return false;
  if (!canHarm(attacker, target)) return false;

  const info = computeAttack(attacker, target, stack);
  const held = info.stack;
  const world = attacker.world || target.world;

  try { attacker.swingArm?.(); } catch { /* optional */ }
  try { attacker.resetAttackCooldown?.(); } catch { /* optional */ }

  if (!(info.damage > 0)) {
    playAt(world, 'attack_nodamage', target.x, centreY(target), target.z, 0.8, 1);
    return false;
  }

  const src = damageSource(
    attacker.isPlayer || attacker.type === 'player' ? 'player_attack' : 'mob_attack',
    attacker, attacker, { knockback: info.knockback },
  );
  const landed = damageEntity(target, info.damage, src);

  if (!landed) {
    playAt(world, 'attack_nodamage', target.x, centreY(target), target.z, 0.8, 1);
    return false;
  }

  if (info.crit) {
    playAt(world, 'attack_crit', target.x, centreY(target), target.z, 1, 1);
    particles('crit', target.x, centreY(target), target.z, { count: 10, spread: 0.5 });
  } else if (attacker.sprinting) {
    playAt(world, 'attack_knockback', target.x, centreY(target), target.z, 1, 1);
  } else {
    playAt(world, 'attack_hit', target.x, centreY(target), target.z, 1, 1);
  }

  if (info.fireSeconds > 0) setOnFire(target, info.fireSeconds);
  if (info.sweep) sweepAttack(attacker, target, info.damage, held);

  // The weapon's own hook (durability, custom effects).
  if (held && held.item) {
    try { getItem(held.item).onHitEntity?.(attacker, target, held); } catch (e) {
      console.error('[combat] onHitEntity failed', held.item, e);
    }
  }
  try { attacker.addExhaustion?.(0.1); } catch { /* optional */ }
  // Sprint attacks cost the sprint, exactly like vanilla.
  if (attacker.sprinting && !info.crit) attacker.sprinting = false;
  try { attacker.def?.onAttack?.(attacker, target); } catch { /* optional */ }
  return true;
}

/**
 * A charged sword swing hits everything standing around the primary target for
 * 1 + sweepingEdge/(sweepingEdge+1) * damage, with a knock-back and the sweep
 * particle arc.
 * @returns {number} how many extra entities were hit
 */
export function sweepAttack(attacker, target, damage, stack = undefined) {
  const world = attacker && attacker.world;
  if (!world || typeof world.entitiesInAABB !== 'function') return 0;
  const held = stack === undefined ? heldItemOf(attacker) : stack;

  let ratio = 0;
  try {
    const lv = getEnchant(held, 'sweeping_edge') || getEnchant(held, 'sweeping');
    if (lv > 0) ratio = lv / (lv + 1);
  } catch { ratio = 0; }
  const sweepDamage = 1 + ratio * damage;

  const box = entityBox(target, _boxA).clone().expand(1, 0.25, 1);
  const list = world.entitiesInAABB(box, (e) => e !== attacker && e !== target && !e.removed);
  let hits = 0;
  for (let i = 0; i < list.length; i++) {
    const e = list[i];
    if (typeof e.health !== 'number') continue;
    if (!canHarm(attacker, e)) continue;
    const dx = e.x - attacker.x, dy = e.y - attacker.y, dz = e.z - attacker.z;
    if (dx * dx + dy * dy + dz * dz > 9) continue;
    applyKnockback(e, attacker.x, centreY(attacker), attacker.z, 0.4);
    damageEntity(e, sweepDamage, damageSource('player_attack', attacker, attacker, {
      knockback: 0, noKnockback: true,
    }));
    hits++;
  }

  playAt(world, 'attack_sweep', attacker.x, centreY(attacker), attacker.z, 1, 1);
  // The arc lands one block in front of the swinger.
  const fx = attacker.x - Math.sin(attacker.yaw || 0);
  const fz = attacker.z + Math.cos(attacker.yaw || 0);
  particles('sweep', fx, attacker.y + (attacker.height || 1.8) * 0.5, fz, { count: 1, size: 1.4 });
  return hits;
}

/** Sets an entity alight for at least `seconds`, respecting fire immunity. */
export function setOnFire(entity, seconds) {
  if (!entity || fireImmune(entity)) return false;
  if (typeof entity.setOnFire === 'function') {
    try { entity.setOnFire(seconds); return true; } catch { /* fall through */ }
  }
  const ticks = Math.round(seconds * TICKS_PER_SECOND);
  if (ticks > (entity.fireTicks | 0)) entity.fireTicks = ticks;
  return true;
}

// ===========================================================================
// Ranged
// ===========================================================================

/** Spawns a projectile through projectiles.js. Returns the entity or null. */
function spawnProjectile(type, world, shooter, x, y, z, dx, dy, dz, opts) {
  const p = MOD.projectiles;
  if (!p || typeof p.spawnProjectile !== 'function') return null;
  try { return p.spawnProjectile(type, world, shooter, x, y, z, dx, dy, dz, opts || {}); } catch (e) {
    console.error('[combat] spawnProjectile failed', type, e);
    return null;
  }
}

/** Vanilla's `triangle(mode, deviation)`: a triangular jitter around a value. */
function triangle(rng, mode, deviation) {
  return mode + deviation * (rng.next() - rng.next());
}

/**
 * Fires an arrow from a bow (or a mob's ranged attack).
 * @param {object} world
 * @param {object} shooter the archer
 * @param {number} power 0..1 bow charge; 1 is a fully drawn bow
 * @param {object} [opts] { type, item, dx/dy/dz or target, inaccuracy, critical,
 *                          bow, damage, pickup, playSound }
 * @returns {object|null} the arrow entity, when projectiles.js is available
 */
export function shootArrow(world, shooter, power = 1, opts = {}) {
  const o = opts || {};
  const w = world || (shooter && shooter.world) || Game.world;
  if (!w || !shooter) return null;

  const charge = clamp(power, 0, 1);
  const type = o.type || 'arrow';
  const bow = o.bow !== undefined ? o.bow : heldItemOf(shooter);
  const rng = rngOf(shooter) === FALLBACK_RNG ? rngOf(w) : rngOf(shooter);
  const shooterIsPlayer = !!(shooter.isPlayer || shooter.type === 'player');

  // --- direction ----------------------------------------------------------
  let dx, dy, dz;
  if (o.dx !== undefined || o.dy !== undefined || o.dz !== undefined) {
    dx = o.dx || 0; dy = o.dy || 0; dz = o.dz || 0;
  } else if (o.target) {
    const t = o.target;
    dx = t.x - shooter.x;
    dy = (t.y + (t.height || 1) / 3) - (eyeY(shooter) - 0.1);
    dz = t.z - shooter.z;
    // Lob the shot so it arrives at chest height rather than at the feet.
    dy += Math.hypot(dx, dz) * 0.2;
  } else {
    const cp = Math.cos(shooter.pitch || 0);
    dx = -Math.sin(shooter.yaw || 0) * cp;
    dy = -Math.sin(shooter.pitch || 0);
    dz = Math.cos(shooter.yaw || 0) * cp;
  }
  let len = Math.sqrt(dx * dx + dy * dy + dz * dz);
  if (!(len > 1e-6)) { dx = 0; dy = 0; dz = 1; len = 1; }
  dx /= len; dy /= len; dz /= len;

  // --- inaccuracy ---------------------------------------------------------
  // Players shoot straight; mobs get worse the easier the difficulty is.
  const inaccuracy = o.inaccuracy !== undefined
    ? o.inaccuracy
    : (shooterIsPlayer ? 1 : Math.max(0, 14 - difficultyId(w) * 4));
  if (inaccuracy > 0) {
    const dev = INACCURACY_UNIT * inaccuracy;
    dx = triangle(rng, dx, dev);
    dy = triangle(rng, dy, dev);
    dz = triangle(rng, dz, dev);
    const l2 = Math.sqrt(dx * dx + dy * dy + dz * dz) || 1;
    dx /= l2; dy /= l2; dz /= l2;
  }

  // --- velocity -----------------------------------------------------------
  // A fully drawn player bow launches at 3 blocks/tick; a mob's bow at 1.6.
  const muzzle = o.speed !== undefined ? o.speed : (shooterIsPlayer ? ARROW_SPEED : 32);
  const speed = muzzle * (o.fullSpeed ? 1 : charge);
  const vx = dx * speed, vy = dy * speed, vz = dz * speed;

  // --- enchantments -------------------------------------------------------
  let powerLevel = 0, punch = 0, flame = 0, pierce = 0, infinity = 0;
  try {
    powerLevel = getEnchant(bow, 'power');
    punch = getEnchant(bow, 'punch');
    flame = getEnchant(bow, 'flame');
    pierce = getEnchant(bow, 'piercing');
    infinity = getEnchant(bow, 'infinity');
  } catch { /* enchantments optional */ }

  // Vanilla arrow damage: 2 per block/tick of velocity, so a full draw is 6.
  const perTick = speed / TICKS_PER_SECOND;
  let damage = o.damage !== undefined ? o.damage : perTick * 2;
  if (powerLevel > 0) damage += powerBonus(bow) * damage;
  // The critical bonus itself is rolled at impact by projectiles.js.
  const critical = o.critical !== undefined ? o.critical : charge >= 1;

  const spawnOpts = Object.assign({
    power: charge,
    critical,
    damage,
    baseDamage: damage,
    knockback: punch,
    punch,
    flame: flame > 0,
    pierce,
    piercing: pierce,
    infinity: infinity > 0,
    item: o.item || (type === 'arrow' ? 'arrow' : type),
    owner: shooter,
    shooter,
    pickup: o.pickup !== undefined ? o.pickup : (infinity > 0 ? 'creative' : 'allowed'),
  }, o.extra || null);

  const ox = shooter.x;
  const oy = eyeY(shooter) - 0.1;
  const oz = shooter.z;
  const arrow = spawnProjectile(type, w, shooter, ox, oy, oz, vx, vy, vz, spawnOpts);

  if (arrow) {
    // Belt and braces: projectiles.js may not read every option name.
    if (arrow.damage === undefined || arrow.damage === 0) arrow.damage = damage;
    if (arrow.baseDamage === undefined) arrow.baseDamage = damage;
    if (punch > 0 && !arrow.knockback) arrow.knockback = punch;
    if (critical) arrow.critical = true;
    if (flame > 0) arrow.fireTicks = Math.max(arrow.fireTicks | 0, 100);
    if (pierce > 0 && !arrow.pierce) arrow.pierce = pierce;
    if (!arrow.owner) arrow.owner = shooter;
    if (!arrow.shooter) arrow.shooter = shooter;
  }

  if (o.playSound) {
    playAt(w, 'bow', shooter.x, eyeY(shooter), shooter.z, 1,
      1 / (rng.next() * 0.4 + 1.2) + charge * 0.5);
  }
  return arrow;
}

/**
 * Bats a projectile away: ghast fireballs punched back at their owner, arrows
 * ricocheting off a shield.
 * @param {object} projectile the thing in flight
 * @param {object} deflector whoever hit it
 * @param {object} [opts] { power, reown }
 * @returns {boolean} true when the projectile was actually turned around
 */
export function deflectProjectile(projectile, deflector, opts = {}) {
  if (!projectile || projectile.removed) return false;
  if (projectile.deflectable === false) return false;
  const o = opts || {};
  const power = o.power !== undefined ? o.power : 1;
  const rng = rngOf(projectile);

  const speed = Math.sqrt(
    (projectile.vx || 0) ** 2 + (projectile.vy || 0) ** 2 + (projectile.vz || 0) ** 2,
  );
  let dx, dy, dz;
  if (deflector && typeof deflector.yaw === 'number' && o.reown !== false) {
    // Aimed back along the deflector's line of sight.
    const cp = Math.cos(deflector.pitch || 0);
    dx = -Math.sin(deflector.yaw || 0) * cp;
    dy = -Math.sin(deflector.pitch || 0);
    dz = Math.cos(deflector.yaw || 0) * cp;
  } else {
    // Simple bounce with a little scatter.
    dx = -(projectile.vx || 0); dy = -(projectile.vy || 0); dz = -(projectile.vz || 0);
    const l = Math.sqrt(dx * dx + dy * dy + dz * dz) || 1;
    dx /= l; dy /= l; dz /= l;
    dx += (rng.next() - 0.5) * 0.2;
    dy += (rng.next() - 0.5) * 0.2;
    dz += (rng.next() - 0.5) * 0.2;
    const l2 = Math.sqrt(dx * dx + dy * dy + dz * dz) || 1;
    dx /= l2; dy /= l2; dz /= l2;
  }

  const newSpeed = Math.max(speed, 12) * power;
  projectile.vx = dx * newSpeed;
  projectile.vy = dy * newSpeed;
  projectile.vz = dz * newSpeed;
  projectile.yaw = Math.atan2(-dx, dz);
  projectile.pitch = -Math.asin(clamp(dy, -1, 1));
  projectile.inGround = false;
  projectile.stuck = false;
  projectile.life = 0;
  if (o.reown !== false && deflector) {
    projectile.owner = deflector;
    projectile.shooter = deflector;
    projectile.deflectedBy = deflector;
  }
  playAt(projectile.world, 'arrow_hit', projectile.x, projectile.y, projectile.z, 0.6, 1.4);
  particles('crit', projectile.x, projectile.y, projectile.z, { count: 4, spread: 0.2 });
  return true;
}

// ===========================================================================
// Explosions
// ===========================================================================

/** Blast resistance of a block, matching vanilla's per-block numbers. */
function blastResistance(def) {
  if (!def || def.air) return 0;
  const r = def.resistance;
  return typeof r === 'number' && r >= 0 ? r : 0;
}

/** True when an explosion must leave this block exactly where it is. */
function indestructible(def) {
  if (!def || def.air) return true;
  if (def.hardness < 0) return true;              // bedrock, barriers, portals
  if (def.liquid) return true;                    // water and lava are never blown up
  return INDESTRUCTIBLE.has(def.name);
}

/**
 * Fraction of an entity's bounding box with unobstructed line of sight to the
 * blast centre. Vanilla samples a grid across the box and casts one ray per
 * sample.
 */
function seenFraction(world, cx, cy, cz, e) {
  if (!world || typeof world.raycast !== 'function') return 1;
  const box = entityBox(e, _boxB);
  const w = box.x1 - box.x0, h = box.y1 - box.y0, d = box.z1 - box.z0;
  const sx = 1 / (w * 2 + 1);
  const sy = 1 / (h * 2 + 1);
  const sz = 1 / (d * 2 + 1);
  if (!(sx > 0) || !(sy > 0) || !(sz > 0)) return 0;
  const ox = (1 - Math.floor(1 / sx) * sx) * 0.5;
  const oz = (1 - Math.floor(1 / sz) * sz) * 0.5;

  let hits = 0, total = 0;
  for (let fx = 0; fx <= 1.0001; fx += sx) {
    for (let fy = 0; fy <= 1.0001; fy += sy) {
      for (let fz = 0; fz <= 1.0001; fz += sz) {
        const px = lerp(box.x0, box.x1, Math.min(fx, 1)) + ox;
        const py = lerp(box.y0, box.y1, Math.min(fy, 1));
        const pz = lerp(box.z0, box.z1, Math.min(fz, 1)) + oz;
        total++;
        let rx = cx - px, ry = cy - py, rz = cz - pz;
        const dist = Math.sqrt(rx * rx + ry * ry + rz * rz);
        if (dist < 1e-4) { hits++; continue; }
        rx /= dist; ry /= dist; rz /= dist;
        let hit = null;
        try {
          hit = world.raycast(px, py, pz, rx, ry, rz, dist, { fluids: false, solidOnly: true });
        } catch { hit = null; }
        if (!hit || hit.distance >= dist - 0.05) hits++;
        if (total > 512) return hits / total;      // sanity valve for huge entities
      }
    }
  }
  return total > 0 ? hits / total : 0;
}

/** Drops one item stack into the world through itementity.js. */
function dropStack(world, x, y, z, s, vx = 0, vy = 2, vz = 0) {
  if (!s || !s.item || (s.count | 0) <= 0) return;
  const it = MOD.itementity;
  if (!it || typeof it.dropItem !== 'function') return;
  try { it.dropItem(world, x, y, z, s, vx, vy, vz); } catch { /* optional */ }
}

/** Lights a TNT block that an explosion caught, so blasts chain. */
function primeTnt(world, x, y, z, rng, igniter) {
  const it = MOD.itementity;
  const fuse = 10 + rng.int(30);          // vanilla: random 1/8..1/4 of 80 ticks
  if (it) {
    try {
      if (typeof it.primeTNT === 'function') { it.primeTNT(world, x, y, z, fuse, igniter); return true; }
      if (typeof it.TNTEntity === 'function') {
        const t = new it.TNTEntity(world, x + 0.5, y, z + 0.5, igniter || null);
        t.fuse = fuse;
        t.fuseTicks = fuse;
        world.addEntity?.(t);
        return true;
      }
    } catch { /* fall through to a plain removal */ }
  }
  return false;
}

/**
 * A real explosion: 1352 rays cast from the centre out through the faces of a
 * 16x16x16 cube, each bleeding strength against the blast resistance of every
 * block it crosses. Blocks the rays outlive are removed (with a 1/power chance
 * of dropping), entities are damaged by distance *and* exposure, and anything
 * still standing gets shoved.
 *
 * @param {object} world
 * @param {number} x @param {number} y @param {number} z blast centre
 * @param {number} power 3 = creeper, 4 = TNT, 6 = charged creeper, 7 = wither
 * @param {object} [opts] { fire, breakBlocks, source, entity, damage, radius, silent }
 * @returns {{x:number,y:number,z:number,power:number,blocks:number,entities:number}|null}
 */
export function explode(world, x, y, z, power, opts = { fire: false, breakBlocks: true }) {
  if (!world || !(power > 0)) return null;
  const o = opts || {};
  const fire = !!o.fire;
  const breakBlocks = o.breakBlocks !== false;
  const owner = o.source || o.entity || null;
  const rng = o.rng || rngOf(world);
  // A blast wider than this cannot be packed into the relative position key
  // below, and nothing in the game legitimately asks for one.
  power = Math.min(power, 32);
  const radius = o.radius !== undefined ? o.radius : power * 2;

  // --- 1. block destruction -----------------------------------------------
  /** @type {Set<number>} positions relative to the centre, packed into one int */
  const affected = new Set();
  const bx0 = Math.floor(x), by0 = Math.floor(y), bz0 = Math.floor(z);
  const key = (bx, by, bz) =>
    ((bx - bx0 + 64) & 0x7f) | (((by - by0 + 64) & 0x7f) << 7) | (((bz - bz0 + 64) & 0x7f) << 14);

  for (let ix = 0; ix < 16; ix++) {
    for (let iy = 0; iy < 16; iy++) {
      for (let iz = 0; iz < 16; iz++) {
        // Only the shell of the cube: 1352 rays, exactly like vanilla.
        if (ix !== 0 && ix !== 15 && iy !== 0 && iy !== 15 && iz !== 0 && iz !== 15) continue;
        let dx = ix / 15 * 2 - 1;
        let dy = iy / 15 * 2 - 1;
        let dz = iz / 15 * 2 - 1;
        const len = Math.sqrt(dx * dx + dy * dy + dz * dz) || 1;
        dx = (dx / len) * RAY_STEP;
        dy = (dy / len) * RAY_STEP;
        dz = (dz / len) * RAY_STEP;

        let strength = power * (0.7 + rng.next() * 0.6);
        let px = x, py = y, pz = z;
        let guard = 256;
        while (strength > 0 && guard-- > 0) {
          const cx = Math.floor(px), cy = Math.floor(py), cz = Math.floor(pz);
          if (cy < 0 || cy >= WORLD_HEIGHT) break;
          const id = world.getBlock(cx, cy, cz);
          if (id !== 0) {
            const def = getBlock(id);
            strength -= (blastResistance(def) + 0.3) * RAY_STEP;
            if (strength > 0 && !indestructible(def)) affected.add(key(cx, cy, cz));
          }
          strength -= RAY_DECAY;
          px += dx; py += dy; pz += dz;
        }
      }
    }
  }

  // --- 2. entity damage ----------------------------------------------------
  const src = damageSource('explosion', owner, owner, {
    explosion: true, bypassCooldown: false, scalesWithDifficulty: true, noKnockback: true,
  });
  const box = _boxA.set(x - radius - 1, y - radius - 1, z - radius - 1,
    x + radius + 1, y + radius + 1, z + radius + 1);
  let victims = [];
  try {
    victims = typeof world.entitiesInAABB === 'function'
      ? world.entitiesInAABB(box, (e) => !e.removed)
      : (world.entities || []);
  } catch { victims = []; }

  let hurtCount = 0;
  for (let i = 0; i < victims.length; i++) {
    const e = victims[i];
    if (!e || e.removed) continue;
    if (e.explosionImmune || (e.def && e.def.explosionImmune)) continue;
    if (e.gameMode === 'spectator') continue;

    const ex = e.x, ey = eyeY(e), ez = e.z;
    const dx = ex - x, dy = ey - y, dz = ez - z;
    const dist = Math.sqrt(dx * dx + dy * dy + dz * dz);
    if (dist > radius || dist <= 0) continue;
    const norm = dist / radius;

    const seen = seenFraction(world, x, y, z, e);
    const impact = (1 - norm) * seen;
    if (impact <= 0) continue;

    const dmg = Math.floor((impact * impact + impact) / 2 * 7 * radius + 1);

    // Dropped items and orbs are destroyed rather than "hurt".
    if (e.type === 'item' || e.type === 'xp_orb' || e.type === 'falling_block') {
      e.health = (e.health === undefined ? 5 : e.health) - dmg;
      if (e.health <= 0) { try { e.remove?.(); } catch { /* optional */ } e.removed = true; }
      continue;
    }

    if (typeof e.health === 'number' && damageEntity(e, dmg, src)) hurtCount++;

    // Knockback, dampened by Blast Protection.
    let kb = impact;
    try {
      const epf = protectionPoints(armorStacksOf(e), src);
      if (epf > 0) kb *= 1 - Math.min(20, epf) / 25;
    } catch { /* optional */ }
    if (kb > 0 && !e.removed) applyKnockback(e, x, y, z, kb, true);
  }

  // --- 3. remove the blocks and roll their drops ---------------------------
  let broken = 0;
  if (breakBlocks && affected.size) {
    const dropChance = power > 1 ? 1 / power : 1;
    for (const k of affected) {
      const bx = (k & 0x7f) - 64 + bx0;
      const by = ((k >> 7) & 0x7f) - 64 + by0;
      const bz = ((k >> 14) & 0x7f) - 64 + bz0;
      const raw = world.getRaw ? world.getRaw(bx, by, bz) : 0;
      const id = raw & 0x0fff;
      if (id === 0) continue;
      const meta = (raw >>> 12) & 15;
      const def = getBlock(id);
      if (indestructible(def)) continue;

      // TNT is lit rather than shattered, so blasts chain.
      if (id === ID_TNT) {
        world.setBlock(bx, by, bz, 0, 0, 3);
        primeTnt(world, bx, by, bz, rng, owner);
        broken++;
        continue;
      }

      // Chests and furnaces spill their contents.
      spillContainer(world, bx, by, bz);

      if (rng.next() <= dropChance && (!world.gameRules || world.gameRules.doTileDrops !== false)) {
        let stacks = null;
        try { stacks = blockDrops(world, bx, by, bz, id, meta, null, null); } catch { stacks = null; }
        if (stacks) {
          for (let s = 0; s < stacks.length; s++) {
            dropStack(world, bx + 0.5, by + 0.5, bz + 0.5, stacks[s],
              (rng.next() - 0.5) * 2, 1.5 + rng.next(), (rng.next() - 0.5) * 2);
          }
        }
      }
      world.setBlock(bx, by, bz, 0, 0, 3);
      broken++;

      // Scattered fire, but only on top of something that will hold it.
      if (fire && ID_FIRE >= 0 && rng.next() < 1 / 3) {
        const below = world.getBlock(bx, by - 1, bz);
        const holds = below !== 0 &&
          (typeof world.isSolid === 'function' ? world.isSolid(bx, by - 1, bz) : true);
        if (holds) world.setBlock(bx, by, bz, ID_FIRE, 0, 3);
      }

      // A little block debris, thinned out so a big blast is not a particle storm.
      if ((broken & 7) === 0) blockDebris(bx, by, bz, id);
    }
  }

  // --- 4. presentation -----------------------------------------------------
  if (!o.silent) {
    playAt(world, 'explode', x, y, z, 4, (1 + (rng.next() - rng.next()) * 0.2) * 0.7);
    particles('explosion', x, y, z, { count: 1, size: power, spread: power * 0.4 });
    const puffs = Math.min(48, Math.round(power * 8));
    for (let i = 0; i < puffs; i++) {
      const a = rng.next() * Math.PI * 2;
      const r = rng.next() * power * 0.9;
      particles('smoke',
        x + Math.cos(a) * r, y + (rng.next() - 0.3) * power * 0.6, z + Math.sin(a) * r,
        { count: 1, size: 1 + rng.next(), life: 1.2 + rng.next() });
    }
  }
  Game.emit('explosion', world, x, y, z, power);

  return { x, y, z, power, blocks: broken, entities: hurtCount };
}

/** Spills a container's contents when its block is destroyed. */
function spillContainer(world, x, y, z) {
  if (typeof world.getBlockEntity !== 'function') return;
  let be = null;
  try { be = world.getBlockEntity(x, y, z); } catch { be = null; }
  if (!be) return;
  const inv = be.inventory || be.items || be.container;
  if (!inv) return;
  try {
    if (Array.isArray(inv)) {
      for (let i = 0; i < inv.length; i++) if (inv[i]) dropStack(world, x + 0.5, y + 0.5, z + 0.5, inv[i], 0, 1.5, 0);
      inv.length = 0;
    } else if (typeof inv.size === 'number' && typeof inv.get === 'function') {
      for (let i = 0; i < inv.size; i++) {
        const s = inv.get(i);
        if (s) { dropStack(world, x + 0.5, y + 0.5, z + 0.5, s, 0, 1.5, 0); inv.set(i, null); }
      }
    }
  } catch { /* containers are optional */ }
}

// ===========================================================================
// Lightning
// ===========================================================================

/** Finds a lightning rod that should soak the strike, or null. */
function findLightningRod(world, x, y, z) {
  if (ID_LIGHTNING_ROD < 0 || typeof world.getBlock !== 'function') return null;
  let best = null, bestD = Infinity;
  for (let dx = -6; dx <= 6; dx++) {
    for (let dz = -6; dz <= 6; dz++) {
      for (let dy = -4; dy <= 8; dy++) {
        const bx = x + dx, by = y + dy, bz = z + dz;
        if (by < 0 || by >= WORLD_HEIGHT) continue;
        if (world.getBlock(bx, by, bz) !== ID_LIGHTNING_ROD) continue;
        const d = dx * dx + dy * dy + dz * dz;
        if (d < bestD) { bestD = d; best = { x: bx, y: by + 1, z: bz }; }
      }
    }
  }
  return best;
}

/**
 * Calls down a bolt: light, thunder, a fire on the ground, 5 damage to
 * everything nearby, and the four vanilla mob transformations.
 * @param {object} world
 * @param {number} x @param {number} y @param {number} z
 * @param {object} [opts] { effectOnly, cause, skipRod }
 * @returns {number} how many entities the bolt touched
 */
export function lightningStrike(world, x, y, z, opts = {}) {
  if (!world) return 0;
  const o = opts || {};
  const rng = rngOf(world);
  x = Math.floor(x); z = Math.floor(z);
  y = clamp(Math.floor(y), 0, WORLD_HEIGHT - 1);

  // A lightning rod within range takes the hit instead.
  if (!o.skipRod) {
    const rod = findLightningRod(world, x, y, z);
    if (rod) { x = rod.x; y = clamp(rod.y, 0, WORLD_HEIGHT - 1); z = rod.z; }
  }

  world.lightningTicks = 8;
  playAt(world, 'thunder', x, y, z, 4, 0.8 + rng.next() * 0.4);
  playAt(world, 'lightning_strike', x, y, z, 2, 0.9 + rng.next() * 0.2);
  for (let i = 0; i < 24; i++) {
    particles('flame', x + 0.5 + (rng.next() - 0.5) * 0.6, y + i * 0.5, z + 0.5 + (rng.next() - 0.5) * 0.6,
      { count: 1, size: 1.5, life: 0.4 });
  }
  Game.emit('lightning', x, y, z, world);
  if (o.effectOnly) return 0;

  // Scorched ground.
  if (ID_FIRE >= 0 && world.gameRules && world.gameRules.doFireTick && griefingAllowed(world)) {
    if (world.getBlock(x, y, z) === 0 && world.isSolid?.(x, y - 1, z)) {
      world.setBlock(x, y, z, ID_FIRE, 0, 3);
    }
  }

  const src = damageSource('lightning', o.cause || null, null, {
    bypassArmor: false, bypassCooldown: true, scalesWithDifficulty: false,
  });
  let touched = 0;
  let list = [];
  try { list = world.entitiesNear(x + 0.5, y, z + 0.5, LIGHTNING_RADIUS); } catch { list = []; }
  for (let i = 0; i < list.length; i++) {
    const e = list[i];
    if (!e || e.removed) continue;
    if (convertOnLightning(world, e)) { touched++; continue; }
    if (typeof e.health === 'number') {
      damageEntity(e, LIGHTNING_DAMAGE, src);
      touched++;
    }
    if (!fireImmune(e)) e.fireTicks = Math.max(e.fireTicks | 0, 160);
  }

  // Skeleton horse traps, on hard only and rarely.
  if (difficultyId(world) === DIFFICULTY.HARD && rng.next() < 0.1) {
    spawnMob(world, 'skeleton_horse', x + 0.5, y, z + 0.5, { trap: true });
  }
  return touched;
}

/** Applies lightning's mob transformations. Returns true when handled. */
function convertOnLightning(world, e) {
  const t = e && e.type;
  if (!t) return false;
  if (t === 'creeper') { e.charged = true; e.powered = true; return true; }
  if (t === 'pig') return !!replaceMob(world, e, 'zombified_piglin');
  if (t === 'villager') return !!replaceMob(world, e, 'witch');
  if (t === 'mooshroom') { e.variant = e.variant === 'brown' ? 'red' : 'brown'; return true; }
  return false;
}

/** Creates a mob through mobs.js, when that module is available. */
function spawnMob(world, name, x, y, z, opts) {
  const m = MOD.mobs;
  if (!m || typeof m.createMob !== 'function') return null;
  try {
    const mob = m.createMob(name, world, x, y, z, opts || {});
    if (mob && world.entitiesById && !world.entitiesById.has(mob.id)) world.addEntity(mob);
    return mob;
  } catch (e) { console.error('[combat] createMob failed', name, e); return null; }
}

/** Swaps one mob for another in place (lightning transformations). */
function replaceMob(world, old, name) {
  const m = spawnMob(world, name, old.x, old.y, old.z, { persistent: old.persistent });
  if (!m) return null;
  m.yaw = old.yaw; m.pitch = old.pitch;
  if (old.baby !== undefined && m.baby !== undefined) m.baby = old.baby;
  try { world.removeEntity(old); } catch { old.removed = true; }
  return m;
}

// ===========================================================================
// Environmental damage drivers
// ===========================================================================

/**
 * One tick of burning: tops the timer up from fire and lava, deals a heart a
 * second, and puts the fire out in water or rain.
 *
 * `Entity.tick()` runs its own copy of this, so this export is for entities
 * that are not `Entity` subclasses (and for tests). It is guarded against
 * running twice in the same tick.
 * @returns {boolean} true when the entity took burn damage this tick
 */
export function fireTick(entity) {
  if (!entity || entity.removed || entity.dead) return false;
  const age = entity.age | 0;
  if (entity._combatFireTick === age) return false;
  entity._combatFireTick = age;

  const immune = fireImmune(entity);
  if (immune) { entity.fireTicks = 0; entity._lavaBurnTimer = 0; return false; }

  let hurt = false;
  // Standing in lava tops the timer up and burns for 4 every half second.
  if (entity.inLava) {
    setOnFire(entity, 15);
    entity._lavaBurnTimer = (entity._lavaBurnTimer | 0) - 1;
    if (entity._lavaBurnTimer <= 0) {
      entity._lavaBurnTimer = 10;
      hurt = damageEntity(entity, 4, damageSource('lava', null, null, { bypassCooldown: true })) || hurt;
    }
  } else {
    entity._lavaBurnTimer = 0;
  }

  if ((entity.fireTicks | 0) <= 0) return hurt;

  if (entity.inWater || entity.submerged) { entity.fireTicks = 0; return hurt; }
  const w = entity.world;
  if (w && canRainExtinguish(w) && typeof w.isRainingAt === 'function') {
    let raining = false;
    try {
      raining = w.isRainingAt(Math.floor(entity.x), Math.floor(entity.y), Math.floor(entity.z));
    } catch { raining = false; }
    if (raining) {
      entity.fireTicks = 0;
      playAt(w, 'extinguish', entity.x, centreY(entity), entity.z, 0.5, 1.2);
      return hurt;
    }
  }

  entity.fireTicks--;
  if ((entity.fireTicks % 20) === 0) {
    hurt = damageEntity(entity, 1, damageSource('on_fire', null, null, { bypassCooldown: true })) || hurt;
  }
  if ((entity.fireTicks & 3) === 0) {
    particles('flame', entity.x, centreY(entity), entity.z, { count: 1, spread: entity.width || 0.6, vy: 0.4 });
  }
  return hurt;
}

/**
 * One tick of breathing: drains the air bar under water, drowns for 2 a second
 * when it runs out, and refills it in air. Water mobs suffocate the other way
 * round.
 *
 * As with `fireTick`, `Entity.tick()` already does this for `Entity`
 * subclasses; this export exists for everything else.
 * @returns {boolean} true when the entity took drowning damage this tick
 */
export function drownTick(entity) {
  if (!entity || entity.removed || entity.dead) return false;
  const age = entity.age | 0;
  if (entity._combatDrownTick === age) return false;
  entity._combatDrownTick = age;

  if (isProtectedMode(entity) || entity.invulnerable) return false;

  let maxAir = entity.maxAirSupply || MAX_AIR;
  try {
    const helmet = armorStacksOf(entity)[0];
    maxAir += respirationBonusTicks(helmet);
  } catch { /* optional */ }
  if (entity.airSupply === undefined) entity.airSupply = maxAir;

  const waterMob = !!(entity.waterMob || (entity.def && entity.def.waterMob));
  const drowning = waterMob
    ? (!entity.inWater && !entity.canBreatheUnderwater)
    : (entity.submerged && !entity.canBreatheUnderwater);

  if (drowning) {
    // Respiration gives a per-tick chance to skip the drain entirely.
    let skip = false;
    try {
      const resp = getEnchant(armorStacksOf(entity)[0], 'respiration');
      skip = resp > 0 && Math.random() < resp / (resp + 1);
    } catch { skip = false; }
    if (!skip) entity.airSupply--;

    if (entity.airSupply <= 0) {
      entity.airSupply = 0;
      entity._combatDrownTimer = (entity._combatDrownTimer | 0) + 1;
      if (entity._combatDrownTimer >= 20) {
        entity._combatDrownTimer = 0;
        return damageEntity(entity, 2, damageSource(waterMob ? 'dry_out' : 'drown', null, null, {
          bypassArmor: true, bypassCooldown: true,
        }));
      }
      if ((age & 3) === 0 && !waterMob) {
        particles('bubble', entity.x, eyeY(entity), entity.z, { count: 2, spread: 0.3, vy: 0.5 });
      }
    }
    return false;
  }

  entity._combatDrownTimer = 0;
  if (entity.airSupply < maxAir) entity.airSupply = Math.min(maxAir, entity.airSupply + 4);
  if (entity.airSupply > maxAir) entity.airSupply = maxAir;
  return false;
}

// ===========================================================================
// Convenience wrappers used by the UI and the chat commands
// ===========================================================================

/** Heals an entity, capped by its max health. Returns how much went in. */
export function healEntity(entity, amount) {
  if (!entity || entity.dead || !(amount > 0)) return 0;
  const max = entity.maxHealth || 20;
  const before = entity.health;
  entity.health = Math.min(max, before + amount);
  const healed = entity.health - before;
  if (healed > 0) particles('heart', entity.x, centreY(entity), entity.z, { count: 2, spread: 0.4 });
  return healed;
}

/** Grants absorption hearts, capped the way the effect does. */
export function addAbsorption(entity, amount, cap = MAX_ABSORPTION) {
  if (!entity || !(amount > 0)) return 0;
  const before = entity.absorption || 0;
  entity.absorption = Math.min(cap, before + amount);
  return entity.absorption - before;
}

/** Kills an entity outright, bypassing armour, shields and i-frames. */
export function killEntity(entity, cause = null) {
  if (!entity || entity.removed) return false;
  return damageEntity(entity, Math.max(1000, (entity.health || 20) + (entity.absorption || 0)),
    damageSource('kill', cause, cause, {
      bypassArmor: true, bypassMagic: true, bypassResistance: true, bypassCooldown: true,
      bypassInvulnerable: true, bypassCreative: true, bypassShield: true, noKnockback: true,
    }));
}

/**
 * Damage from the void, used when something falls out of the world. Kept here
 * so the "nothing survives this" rules live in one place.
 */
export function voidDamage(entity, amount = 4) {
  return damageEntity(entity, amount, damageSource('out_of_world', null, null, {
    bypassArmor: true, bypassMagic: true, bypassResistance: true, bypassCooldown: true,
    bypassInvulnerable: true, bypassCreative: true, bypassShield: true, noKnockback: true,
  }));
}

/** Dimension-aware helper: the Nether has no rain to put fires out. */
export function canRainExtinguish(world) {
  return !!world && world.dimension !== DIM_NETHER && world.dimension !== 'end';
}

/** True when this world is the overworld, where lightning can strike. */
export function canLightningStrike(world) {
  return !!world && world.dimension === DIM_OVERWORLD;
}

export default {
  damageEntity, explode, applyKnockback, computeDamage, computeAttack, meleeAttack,
  sweepAttack, shootArrow, deflectProjectile, damageSource, canHarm, difficultyScale,
  fireTick, drownTick, lightningStrike, isBlocking, disableShield, reduceDamage,
  armorDamageReduction, healEntity, killEntity, voidDamage, setOnFire,
};
