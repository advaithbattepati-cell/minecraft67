// ============================================================================
// effects.js - The status effect registry.
//
// Every potion effect, beacon effect and mob-inflicted debuff in the game lives
// here. Effects are stored on an entity as `entity.effects`, a
// `Map<name, { level, ticks, ambient }>` (see entity.js). `level` is the
// vanilla *amplifier*: 0 means "Speed I", 1 means "Speed II". `ticks` is the
// remaining duration; a negative value means infinite.
//
// The registry never touches the DOM, three.js or the world at module scope, so
// tools/validate.mjs can import it in plain Node. Anything that needs a mob, a
// block id or a particle reaches for it lazily from inside a handler.
//
// Modifier convention (`def.modifiers`):
//   speed, attackSpeed, dig, swim  -> fractional change *per level*, so the
//                                     multiplier is 1 + value * (amplifier + 1)
//   damage, maxHealth, jump, luck  -> flat amount added *per level*
//   knockbackResist, resist        -> 0..1 added per level, clamped by helpers
// The helper functions at the bottom of this file apply that convention for
// you; prefer them over reading `modifiers` by hand.
// ============================================================================
import { MAX_AIR, MAX_HEALTH, MAX_HUNGER, GRAVITY, TICKS_PER_SECOND } from '../core/constants.js';
import { clamp, approach, prettyName, roman, rgbToHex } from '../core/util.js';
import { Game } from '../core/game.js';

// ---------------------------------------------------------------------------
// Registry storage
// ---------------------------------------------------------------------------

/** name -> effect definition. */
export const EFFECTS = {};
/** Registration-ordered list of every effect name. */
export const EFFECT_NAMES = [];
/** Sparse array indexed by the vanilla numeric effect id. */
export const EFFECT_BY_ID = [];

const NOOP = () => {};

const DEFAULT_MODIFIERS = {
  speed: 0,            // movement speed, fractional per level
  damage: 0,           // flat melee damage per level
  attackSpeed: 0,      // attack cooldown speed, fractional per level
  maxHealth: 0,        // flat max health per level
  knockbackResist: 0,  // 0..1 per level
  dig: 0,              // block breaking speed, fractional per level
  jump: 0,             // jump velocity, fractional per level
  swim: 0,             // swim speed, fractional per level
  luck: 0,             // loot table luck, flat per level
  resist: 0,           // incoming damage reduction, 0..1 per level
};

/**
 * Registers a status effect. Returns the definition. Registering the same name
 * twice keeps the first definition.
 */
export function defineEffect(name, def = {}) {
  const existing = EFFECTS[name];
  if (existing) return existing;
  const category = def.category || 'beneficial';
  const e = {
    id: def.id !== undefined ? def.id : EFFECT_NAMES.length + 1,
    name,
    display: def.display || prettyName(name),
    color: def.color !== undefined ? def.color : 0xffffff,
    category,                                   // beneficial | harmful | neutral
    beneficial: category === 'beneficial',
    harmful: category === 'harmful',
    instant: !!def.instant,
    duration: def.duration !== undefined ? def.duration : 3600,
    maxLevel: def.maxLevel !== undefined ? def.maxLevel : 3,   // max amplifier
    particles: def.particles !== false,         // shows swirling particles
    curative: def.curative !== false,           // milk / honey can wash it off
    modifiers: Object.assign({}, DEFAULT_MODIFIERS, def.modifiers),
    onApply: def.onApply || NOOP,
    onRemove: def.onRemove || NOOP,
    onTick: def.onTick || NOOP,
    onDeath: def.onDeath || null,               // fired once when the carrier dies
    immune: def.immune || null,                 // (entity) => true when it cannot be applied
  };
  EFFECTS[name] = e;
  EFFECT_NAMES.push(name);
  EFFECT_BY_ID[e.id] = e;
  return e;
}

/** Effect definition by name, or undefined. */
export function getEffectDef(name) { return EFFECTS[name]; }
/** Alias of getEffectDef, for symmetry with the other registries. */
export function effectByName(name) { return EFFECTS[name]; }
/** True when `name` is a registered effect. */
export function effectExists(name) { return !!EFFECTS[name]; }
/** Effect definition by numeric id (1 = speed, 2 = slowness, ...). */
export function effectById(id) { return EFFECT_BY_ID[id]; }

// ---------------------------------------------------------------------------
// Entity plumbing
//
// `entity.effects` is normally a Map, but these helpers also cope with a plain
// object so that a partially-built entity (or a save file) never crashes a tick.
// ---------------------------------------------------------------------------

const isMap = (m) => !!m && typeof m.get === 'function' && typeof m.set === 'function';

/** The live state record for one effect on an entity, or null. */
function stateOf(entity, name) {
  const m = entity && entity.effects;
  if (!m) return null;
  const st = isMap(m) ? m.get(name) : m[name];
  return st || null;
}
function eachEffect(entity, cb) {
  const m = entity && entity.effects;
  if (!m) return;
  if (isMap(m)) { m.forEach((st, name) => cb(name, st)); return; }
  for (const k in m) cb(k, m[k]);
}
function deleteState(entity, name) {
  const m = entity && entity.effects;
  if (!m) return;
  if (isMap(m)) m.delete(name); else delete m[name];
}
function putState(entity, name, st) {
  let m = entity.effects;
  if (!m) { m = new Map(); entity.effects = m; }
  if (isMap(m)) m.set(name, st); else m[name] = st;
}
function effectCount(entity) {
  const m = entity && entity.effects;
  if (!m) return 0;
  if (isMap(m)) return m.size;
  return Object.keys(m).length;
}
const levelOf = (st) => (st ? (st.level !== undefined ? st.level : (st.amplifier || 0)) : 0);

// ---------------------------------------------------------------------------
// Damage / healing plumbing
// ---------------------------------------------------------------------------

const UNDEAD_TYPES = new Set([
  'zombie', 'zombie_villager', 'husk', 'drowned', 'skeleton', 'stray', 'bogged',
  'wither_skeleton', 'zombified_piglin', 'phantom', 'zoglin', 'skeleton_horse',
  'zombie_horse', 'wither', 'giant',
]);
const POISON_IMMUNE_TYPES = new Set(['spider', 'cave_spider', 'witch', 'iron_golem', 'snow_golem', 'armor_stand']);
const NON_LIVING_TYPES = new Set(['item', 'xp_orb', 'tnt', 'falling_block', 'arrow', 'boat', 'minecart', 'armor_stand']);

/** True when the entity counts as undead (immune to poison/regen, hurt by healing). */
export function isUndead(entity) {
  if (!entity) return false;
  if (entity.undead !== undefined) return !!entity.undead;
  const d = entity.def || entity.mobDef || entity.definition;
  if (d && d.undead !== undefined) return !!d.undead;
  return UNDEAD_TYPES.has(entity.type);
}

/** A damage source object in the shape combat.js uses. */
export function effectDamageSource(type, entity = null) {
  return {
    type, entity, direct: null, amount: 0,
    bypassArmor: true, bypassCooldown: true, bypassInvulnerable: false,
    fire: type === 'on_fire', magic: true, projectile: false, effect: true,
  };
}

const isProtected = (e) =>
  e.invulnerable === true || e.gameMode === 'creative' || e.gameMode === 'spectator';

/**
 * Damage from a status effect. Effect damage ignores invulnerability frames in
 * vanilla, so when `hurt()` refuses the hit we take the health off directly.
 */
function effectHurt(entity, amount, type) {
  if (!entity || amount <= 0 || entity.dead || entity.removed) return false;
  if (isProtected(entity)) return false;
  const src = effectDamageSource(type, null);
  src.amount = amount;
  const h0 = entity.health, a0 = entity.absorption || 0;
  if (typeof entity.hurt === 'function') {
    try { entity.hurt(amount, src); } catch (e) { console.warn('[effects] hurt failed', e); }
  }
  if (entity.health === h0 && (entity.absorption || 0) === a0) {
    let left = amount;
    if (entity.absorption > 0) {
      const eaten = Math.min(entity.absorption, left);
      entity.absorption -= eaten;
      left -= eaten;
    }
    if (left > 0) {
      entity.health = Math.max(0, h0 - left);
      entity.hurtTime = Math.max(entity.hurtTime || 0, 10);
      entity.lastDamageSource = src;
      if (entity.health <= 0 && typeof entity.kill === 'function') entity.kill();
    }
  }
  return true;
}

/** Healing from a status effect. */
function effectHeal(entity, amount) {
  if (!entity || amount <= 0 || entity.dead) return;
  if (typeof entity.heal === 'function') { entity.heal(amount); return; }
  const max = entity.maxHealth || MAX_HEALTH;
  entity.health = Math.min(max, (entity.health || 0) + amount);
}

/** Vanilla food exhaustion, with a fallback that drains saturation then hunger. */
function addExhaustion(entity, amount) {
  if (typeof entity.addExhaustion === 'function') { entity.addExhaustion(amount); return; }
  if (entity.hunger === undefined) return;   // not a player, nothing to drain
  entity.exhaustion = (entity.exhaustion || 0) + amount;
  while (entity.exhaustion >= 4) {
    entity.exhaustion -= 4;
    if ((entity.saturation || 0) > 0) entity.saturation = Math.max(0, entity.saturation - 1);
    else entity.hunger = Math.max(0, (entity.hunger || 0) - 1);
  }
}

// ---------------------------------------------------------------------------
// Lazy cross-module access. Importing these at module scope would drag the
// renderer (and a DOM) into `node tools/validate.mjs`.
// ---------------------------------------------------------------------------

const MOD = {
  mobs: () => import('../entity/mobs.js'),
  blocks: () => import('../world/blocks.js'),
};
const warned = new Set();
function withMod(loader, fn) {
  let p;
  try { p = loader(); } catch (e) { p = Promise.reject(e); }
  p.then(
    (m) => { try { fn(m); } catch (e) { console.warn('[effects] handler failed', e); } },
    (e) => { const k = String(e && e.message); if (!warned.has(k)) { warned.add(k); console.warn('[effects] module unavailable', e); } },
  );
}

/** Spawns a coloured puff of particles on an entity, when a renderer exists. */
function burst(entity, color, type = 'magic', count = 6) {
  const p = Game.particles;
  if (!p || typeof p.spawn !== 'function' || !entity) return;
  p.spawn(type, entity.x, entity.y + (entity.height || 1.8) * 0.6, entity.z, {
    count, spread: (entity.width || 0.6) * 0.6, color, life: 0.7, size: 0.11, gravity: 0,
  });
}

/** Spawns a mob next to an entity (used by infestation / oozing). */
function spawnNear(entity, mobName, count, opts) {
  const world = entity && entity.world;
  if (!world) return;
  const { x, y, z } = entity;
  withMod(MOD.mobs, (m) => {
    if (typeof m.createMob !== 'function') return;
    for (let i = 0; i < count; i++) {
      const a = (i / count) * Math.PI * 2;
      const mob = m.createMob(mobName, world, x + Math.cos(a) * 0.6, y, z + Math.sin(a) * 0.6, opts || {});
      if (!mob) continue;
      const known = world.entitiesById && world.entitiesById.has ? world.entitiesById.has(mob.id) : false;
      if (!known && typeof world.addEntity === 'function') world.addEntity(mob);
    }
  });
}

// ===========================================================================
// The effects. Ids, colours and timings follow Minecraft 1.20/1.21.
// ===========================================================================

// --- 1..5 movement, mining and melee modifiers -----------------------------

defineEffect('speed', {
  id: 1, color: 0x7cafc6, category: 'beneficial', duration: 3600, maxLevel: 4,
  modifiers: { speed: 0.20 },
});

defineEffect('slowness', {
  id: 2, color: 0x5a6c81, category: 'harmful', duration: 1800, maxLevel: 5,
  modifiers: { speed: -0.15 },
});

defineEffect('haste', {
  id: 3, color: 0xd9c043, category: 'beneficial', duration: 3600, maxLevel: 2,
  modifiers: { dig: 0.20, attackSpeed: 0.10 },
});

defineEffect('mining_fatigue', {
  id: 4, color: 0x4a4217, category: 'harmful', duration: 1800, maxLevel: 3,
  // The real curve is 0.3^(level+1); `dig` here is only the naive linear hint,
  // miningSpeedMultiplier() below implements the exponential version.
  modifiers: { dig: -0.7, attackSpeed: -0.10 },
});

defineEffect('strength', {
  id: 5, color: 0x932423, category: 'beneficial', duration: 3600, maxLevel: 4,
  modifiers: { damage: 3 },
});

// --- 6..7 the two instant effects ------------------------------------------

/** Instant Health: 4 x 2^level, but undead take 6 x 2^level instead. */
function applyInstantHealth(entity, level) {
  const power = Math.pow(2, level);
  if (isUndead(entity)) effectHurt(entity, 6 * power, 'magic');
  else { effectHeal(entity, 4 * power); burst(entity, 0xf82423, 'heart', 4); }
}
/** Instant Damage: 6 x 2^level, but undead are healed by it. */
function applyInstantDamage(entity, level) {
  const power = Math.pow(2, level);
  if (isUndead(entity)) { effectHeal(entity, 6 * power); burst(entity, 0xf82423, 'heart', 4); }
  else { effectHurt(entity, 6 * power, 'magic'); burst(entity, 0x430a09, 'damage', 6); }
}

defineEffect('instant_health', {
  id: 6, color: 0xf82423, category: 'beneficial', instant: true, duration: 1, maxLevel: 1,
  onApply: applyInstantHealth,
  onTick: applyInstantHealth,
});

defineEffect('instant_damage', {
  id: 7, color: 0x430a09, category: 'harmful', instant: true, duration: 1, maxLevel: 1,
  onApply: applyInstantDamage,
  onTick: applyInstantDamage,
});

// --- 8..9 jumping and the screen warp --------------------------------------

defineEffect('jump_boost', {
  id: 8, color: 0x22ff4c, category: 'beneficial', duration: 3600, maxLevel: 4,
  // Also cancels (level + 1) blocks of fall damage - see fallDamageReduction().
  modifiers: { jump: 0.10 },
});

defineEffect('nausea', {
  id: 9, color: 0x551d4a, category: 'harmful', duration: 300, maxLevel: 0,
  onTick(entity, level, ticks) {
    // Ramps the screen-warp strength the renderer reads, and eases off over the
    // last three seconds so the wobble does not stop dead. tickEffects() fades
    // the field back to zero once the effect is gone.
    const target = ticks < 60 ? ticks / 60 : 1;
    entity.nausea = approach(entity.nausea || 0, target * (1 + level * 0.25), 0.02);
  },
});

// --- 10..12 regeneration, resistance, fire ---------------------------------

defineEffect('regeneration', {
  id: 10, color: 0xcd5cab, category: 'beneficial', duration: 900, maxLevel: 4,
  onTick(entity, level, ticks) {
    const interval = Math.max(1, 50 >> level);
    if (ticks % interval !== 0) return;
    const max = entity.maxHealth || MAX_HEALTH;
    if (entity.health >= max) return;
    effectHeal(entity, 1);
    burst(entity, 0xcd5cab, 'heart', 1);
  },
  immune: (e) => isUndead(e),
});

defineEffect('resistance', {
  id: 11, color: 0x99453a, category: 'beneficial', duration: 3600, maxLevel: 4,
  modifiers: { resist: 0.20, knockbackResist: 0.05 },
});

defineEffect('fire_resistance', {
  id: 12, color: 0xe49a3a, category: 'beneficial', duration: 3600, maxLevel: 0,
  onApply(entity) { entity.fireResistant = true; entity.fireTicks = 0; },
  onTick(entity) {
    entity.fireResistant = true;
    if (entity.fireTicks > 0) { entity.fireTicks = 0; burst(entity, 0xe49a3a, 'smoke', 1); }
  },
  onRemove(entity) { if (!entity.fireImmune) entity.fireResistant = false; },
});

// --- 13..16 breathing and vision -------------------------------------------

defineEffect('water_breathing', {
  id: 13, color: 0x2e5299, category: 'beneficial', duration: 3600, maxLevel: 0,
  onTick(entity) {
    entity.airSupply = MAX_AIR;
    entity.canBreatheUnderwater = true;
  },
  onRemove(entity) { if (!entity.waterMob) entity.canBreatheUnderwater = false; },
});

defineEffect('invisibility', {
  id: 14, color: 0x7f8392, category: 'beneficial', duration: 3600, maxLevel: 0,
  onApply(entity) { entity.invisible = true; burst(entity, 0x7f8392, 'cloud', 6); },
  onTick(entity) { entity.invisible = true; },
  onRemove(entity) { entity.invisible = false; },
});

defineEffect('blindness', {
  id: 15, color: 0x1f1f23, category: 'harmful', duration: 400, maxLevel: 0,
  onTick(entity) {
    // Requests a darkening; tickEffects() resolves it against night vision.
    entity._fxBrightDown = Math.min(entity._fxBrightDown || 0, -0.95);
    entity.blinded = true;
  },
  onRemove(entity) { entity.blinded = false; },
});

defineEffect('night_vision', {
  id: 16, color: 0x1f1fa1, category: 'beneficial', duration: 3600, maxLevel: 0,
  onTick(entity, level, ticks) {
    // Vanilla flickers over the last ten seconds of the effect.
    const v = ticks > 200 ? 1 : 0.15 + 0.85 * Math.abs(Math.cos((200 - ticks) * 0.11));
    entity._fxBrightUp = Math.max(entity._fxBrightUp || 0, v);
  },
});

// --- 17..20 the food and damage-over-time effects --------------------------

defineEffect('hunger', {
  id: 17, color: 0x587653, category: 'harmful', duration: 600, maxLevel: 3,
  onTick(entity, level) {
    addExhaustion(entity, 0.005 * (level + 1));
  },
});

defineEffect('weakness', {
  id: 18, color: 0x484d48, category: 'harmful', duration: 1800, maxLevel: 2,
  modifiers: { damage: -4 },
});

defineEffect('poison', {
  id: 19, color: 0x4e9331, category: 'harmful', duration: 900, maxLevel: 4,
  onTick(entity, level, ticks) {
    const interval = Math.max(1, 25 >> level);
    if (ticks % interval !== 0) return;
    if (entity.health > 1) effectHurt(entity, 1, 'poison');   // poison never kills
    if ((ticks & 15) === 0) burst(entity, 0x4e9331, 'magic', 2);
  },
  immune: (e) => isUndead(e) || POISON_IMMUNE_TYPES.has(e.type),
});

defineEffect('wither', {
  id: 20, color: 0x352a27, category: 'harmful', duration: 800, maxLevel: 2,
  onTick(entity, level, ticks) {
    const interval = Math.max(1, 40 >> level);
    if (ticks % interval !== 0) return;
    effectHurt(entity, 1, 'wither');                          // wither does kill
    burst(entity, 0x352a27, 'smoke', 2);
  },
  immune: (e) => e.type === 'wither' || e.type === 'wither_skeleton',
});

// --- 21..23 health pools and food ------------------------------------------

/** Idempotent: re-applying at any level never compounds the bonus. */
function applyHealthBoost(entity, level) {
  // Remember the unboosted maximum once, so upgrading the level (or reloading a
  // save) rebuilds the total from the same base.
  if (entity._baseMaxHealth === undefined) {
    entity._baseMaxHealth = Math.max(1, (entity.maxHealth || MAX_HEALTH) - (entity._healthBoost || 0));
  }
  const bonus = 4 * (level + 1);
  entity._healthBoost = bonus;
  entity.maxHealth = entity._baseMaxHealth + bonus;
}

defineEffect('health_boost', {
  id: 21, color: 0xf87d23, category: 'beneficial', duration: 3600, maxLevel: 4,
  modifiers: { maxHealth: 4 },
  onApply: applyHealthBoost,
  onTick(entity, level) {
    // Self-healing: an entity that pushed the effect straight into its map
    // without going through addEffect() still gets the extra hearts.
    if (entity._healthBoost !== 4 * (level + 1)) applyHealthBoost(entity, level);
    const max = entity.maxHealth || MAX_HEALTH;
    if (entity.health > max) entity.health = max;
  },
  onRemove(entity) {
    const base = entity._baseMaxHealth !== undefined
      ? entity._baseMaxHealth
      : Math.max(1, (entity.maxHealth || MAX_HEALTH) - (entity._healthBoost || 0));
    entity._healthBoost = 0;
    entity._baseMaxHealth = undefined;
    entity.maxHealth = base;
    if (entity.health > entity.maxHealth) entity.health = entity.maxHealth;
  },
});

defineEffect('absorption', {
  id: 22, color: 0x2552a5, category: 'beneficial', duration: 2400, maxLevel: 4,
  onApply(entity, level) {
    const cap = 4 * (level + 1);
    entity.maxAbsorption = cap;
    entity.absorption = Math.max(entity.absorption || 0, cap);
    const st = stateOf(entity, 'absorption');
    if (st) st.granted = true;
  },
  onTick(entity, level) {
    // The pool never refills on its own, but the HUD needs the cap to know how
    // many yellow hearts to draw. The one-shot grant also covers entities that
    // wrote the effect straight into their map.
    const cap = 4 * (level + 1);
    entity.maxAbsorption = cap;
    const st = stateOf(entity, 'absorption');
    if (st && !st.granted) { st.granted = true; entity.absorption = Math.max(entity.absorption || 0, cap); }
  },
  onRemove(entity) { entity.absorption = 0; entity.maxAbsorption = 0; },
});

defineEffect('saturation', {
  id: 23, color: 0xf82423, category: 'beneficial', duration: 1, maxLevel: 1,
  onTick(entity, level) {
    if (entity.hunger === undefined) return;
    const n = level + 1;
    entity.hunger = Math.min(MAX_HUNGER, entity.hunger + n);
    entity.saturation = Math.min(entity.hunger, (entity.saturation || 0) + n * 2);
  },
});

// --- 24..25 glowing and levitation -----------------------------------------

defineEffect('glowing', {
  id: 24, color: 0x94a061, category: 'neutral', duration: 3600, maxLevel: 0,
  onApply(entity) { entity.glowing = true; },
  onTick(entity) { entity.glowing = true; },
  onRemove(entity) { entity.glowing = false; },
});

defineEffect('levitation', {
  id: 25, color: 0xceffff, category: 'harmful', duration: 200, maxLevel: 4,
  onTick(entity, level) {
    // Vanilla drifts towards 0.05 * (level + 1) blocks per tick. Our velocities
    // are blocks per second and a full tick of gravity lands between our ticks,
    // so the target carries that tick of gravity as compensation.
    const target = 0.9 * (level + 1) + GRAVITY / TICKS_PER_SECOND;
    entity.vy += (target - entity.vy) * 0.5;
    entity.fallDistance = 0;
    entity.onGround = false;
  },
});

// --- 26..28 luck and the feather-fall effect -------------------------------

defineEffect('luck', {
  id: 26, color: 0x339900, category: 'beneficial', duration: 6000, maxLevel: 4,
  modifiers: { luck: 1 },
});

defineEffect('unluck', {
  id: 27, color: 0xc0a44d, category: 'harmful', duration: 6000, maxLevel: 4,
  modifiers: { luck: -1 },
});

defineEffect('slow_falling', {
  id: 28, color: 0xffefd1, category: 'beneficial', duration: 1800, maxLevel: 0,
  onTick(entity) {
    // A tick of gravity lands between our ticks, so the clamp sits well above
    // the speed we actually want the fall to look like.
    const cap = -1.2;
    if (entity.vy < cap) entity.vy = cap;
    if (entity.vy < 0) entity.fallDistance = 0;
    entity.slowFalling = true;
  },
  onRemove(entity) { entity.slowFalling = false; },
});

// --- 29..30 the ocean effects ----------------------------------------------

defineEffect('conduit_power', {
  id: 29, color: 0x1dc2d1, category: 'beneficial', duration: 3600, maxLevel: 2,
  modifiers: { dig: 0.20, swim: 0.20 },
  onTick(entity) {
    entity.airSupply = MAX_AIR;
    entity.canBreatheUnderwater = true;
    if (entity.inWater) entity._fxBrightUp = Math.max(entity._fxBrightUp || 0, 0.6);
  },
  onRemove(entity) { if (!entity.waterMob) entity.canBreatheUnderwater = false; },
});

defineEffect('dolphins_grace', {
  id: 30, color: 0x88a3be, category: 'beneficial', duration: 200, maxLevel: 0,
  display: "Dolphin's Grace",
  modifiers: { swim: 0.60 },
  onTick(entity) {
    if (!entity.inWater) return;
    // Accelerates the swimmer up to roughly 6 blocks/s, then stops pushing.
    const sp = Math.hypot(entity.vx, entity.vz);
    if (sp > 0.05 && sp < 6) { entity.vx *= 1.04; entity.vz *= 1.04; }
    if (((entity._fxTick | 0) & 7) === 0) burst(entity, 0x88a3be, 'bubble', 1);
  },
});

// --- 31..35 the raid / trial omens -----------------------------------------

defineEffect('bad_omen', {
  id: 31, color: 0x0b6138, category: 'neutral', duration: 120000, maxLevel: 4,
  curative: true, particles: false,
  onApply(entity, level) { entity.badOmen = level + 1; },
  onTick(entity, level) { entity.badOmen = level + 1; },
  onRemove(entity) { entity.badOmen = 0; },
});

defineEffect('hero_of_the_village', {
  id: 32, color: 0x44ff44, category: 'beneficial', duration: 48000, maxLevel: 4,
  onApply(entity, level) { entity.heroOfTheVillage = level + 1; },
  onTick(entity, level) { entity.heroOfTheVillage = level + 1; },
  onRemove(entity) { entity.heroOfTheVillage = 0; },
});

defineEffect('darkness', {
  id: 33, color: 0x292721, category: 'harmful', duration: 300, maxLevel: 0,
  curative: false,
  onTick(entity, level, ticks) {
    // A slow pulse: fade in over ~22 ticks, hold, then fade back out.
    const phase = (ticks % 55) / 55;
    const pulse = phase < 0.4 ? phase / 0.4 : 1 - (phase - 0.4) / 0.6;
    entity._fxBrightDown = Math.min(entity._fxBrightDown || 0, -(0.35 + 0.65 * pulse));
  },
});

defineEffect('trial_omen', {
  id: 34, color: 0x16a6a6, category: 'neutral', duration: 18000, maxLevel: 4,
  particles: false,
  onApply(entity, level) { entity.trialOmen = level + 1; },
  onTick(entity, level) { entity.trialOmen = level + 1; },
  onRemove(entity) { entity.trialOmen = 0; },
});

defineEffect('raid_omen', {
  id: 35, color: 0xe45c5c, category: 'neutral', duration: 600, maxLevel: 4,
  particles: false,
  onApply(entity, level) { entity.raidOmen = level + 1; },
  onTick(entity, level) { entity.raidOmen = level + 1; },
  onRemove(entity) { entity.raidOmen = 0; },
});

// --- 36..39 the 1.21 "on death" effects ------------------------------------

defineEffect('wind_charged', {
  id: 36, color: 0xbdc9ff, category: 'harmful', duration: 3600, maxLevel: 0,
  onTick(entity) { entity.windCharged = true; },
  onRemove(entity) { entity.windCharged = false; },
  onDeath(entity) {
    // A wind burst that shoves everything nearby away from the corpse.
    const world = entity.world;
    burst(entity, 0xbdc9ff, 'cloud', 20);
    if (!world || typeof world.entitiesNear !== 'function') return;
    const list = world.entitiesNear(entity.x, entity.y, entity.z, 3.5) || [];
    for (const other of list) {
      if (other === entity) continue;
      const dx = other.x - entity.x, dz = other.z - entity.z;
      const d = Math.hypot(dx, dz) || 0.001;
      if (typeof other.knockback === 'function') other.knockback(dx / d, dz / d, 1.2);
      else { other.vx += (dx / d) * 6; other.vz += (dz / d) * 6; }
      other.vy = Math.max(other.vy, 6);
      other.fallDistance = 0;
    }
  },
});

defineEffect('weaving', {
  id: 37, color: 0x7b6c57, category: 'harmful', duration: 3600, maxLevel: 0,
  modifiers: { speed: -0.05 },
  onTick(entity) { entity.webWalk = true; },      // moves freely through cobwebs
  onRemove(entity) { entity.webWalk = false; },
  onDeath(entity) {
    const world = entity.world;
    if (!world || typeof world.setBlock !== 'function') return;
    const bx = Math.floor(entity.x), by = Math.floor(entity.y), bz = Math.floor(entity.z);
    withMod(MOD.blocks, (b) => {
      const web = b.blockByName ? b.blockByName('cobweb') : null;
      if (!web) return;
      for (let i = 0; i < 3 + ((bx ^ bz) & 3); i++) {
        const x = bx + ((i * 7 + 1) % 3) - 1;
        const y = by + ((i * 5) % 2);
        const z = bz + ((i * 3 + 2) % 3) - 1;
        if (world.isAir && world.isAir(x, y, z)) world.setBlock(x, y, z, web.id, 0, 3);
      }
    });
  },
});

defineEffect('oozing', {
  id: 38, color: 0x99ff63, category: 'harmful', duration: 3600, maxLevel: 0,
  onTick(entity) { entity.oozing = true; },
  onRemove(entity) { entity.oozing = false; },
  onDeath(entity) {
    burst(entity, 0x99ff63, 'slime', 12);
    spawnNear(entity, 'slime', 2, { size: 2 });
  },
});

defineEffect('infestation', {
  id: 39, color: 0x8ca08c, category: 'harmful', duration: 3600, maxLevel: 0,
  onTick(entity, level, ticks) {
    // 10% chance per hit taken to spit out a silverfish.
    const st = stateOf(entity, 'infestation');
    if (!st) return;
    if (st.lastHealth === undefined) { st.lastHealth = entity.health; return; }
    if (entity.health < st.lastHealth) {
      const roll = ((ticks * 2654435761) >>> 0) / 4294967296;
      if (roll < 0.1 * (level + 1)) {
        spawnNear(entity, 'silverfish', 1, {});
        burst(entity, 0x8ca08c, 'dust', 6);
      }
    }
    st.lastHealth = entity.health;
  },
});

// ===========================================================================
// Driving effects on an entity
// ===========================================================================

const EPS = 1e-3;
const snap = (v) => (Math.abs(v) < EPS ? 0 : v);

/**
 * Resolves the fields the renderer and HUD read from the per-tick requests the
 * individual effects made. Blindness and darkness always beat night vision.
 */
function updateDerived(entity) {
  const up = entity._fxBrightUp || 0;
  const down = entity._fxBrightDown || 0;
  const target = down < 0 ? down : up;
  entity.brightness = snap(approach(entity.brightness || 0, target, 0.12));
  if (!stateOf(entity, 'nausea')) entity.nausea = snap(approach(entity.nausea || 0, 0, 0.02));
  entity.invisible = !!stateOf(entity, 'invisibility');
  entity.glowing = !!stateOf(entity, 'glowing');
  entity._fxDirty = true;
}

/** Fades the derived fields back to neutral once the last effect has expired. */
function decayDerived(entity) {
  if (!entity._fxDirty) return;
  entity.brightness = snap(approach(entity.brightness || 0, 0, 0.12));
  entity.nausea = snap(approach(entity.nausea || 0, 0, 0.02));
  entity.invisible = false;
  entity.glowing = false;
  if (!entity.brightness && !entity.nausea) entity._fxDirty = false;
}

/**
 * Runs one tick of every effect on `entity`, counts durations down, fires the
 * apply/remove hooks and refreshes the derived fields (brightness, nausea,
 * invisible, glowing). Called once per tick from entity.js.
 */
export function tickEffects(entity) {
  if (!entity) return;
  entity._fxTick = (entity._fxTick | 0) + 1;
  if (effectCount(entity) === 0) { decayDerived(entity); return; }

  const dead = entity.dead === true || entity.health <= 0;
  entity._fxBrightUp = 0;
  entity._fxBrightDown = 0;
  const expired = [];

  eachEffect(entity, (name, st) => {
    const def = EFFECTS[name];
    if (!def || !st) { expired.push(name); return; }
    const level = levelOf(st);

    // A one-shot effect that somehow ended up in the map: fire and drop it.
    if (def.instant) { if (!dead) def.onApply(entity, level); expired.push(name); return; }

    st.elapsed = (st.elapsed | 0) + 1;
    const infinite = st.ticks < 0 || st.infinite === true;
    // Vanilla passes the *remaining* duration to the per-tick hook, which is why
    // regeneration/poison/wither can use `ticks % interval === 0` as a timer.
    const remaining = infinite ? 0x3fffffff - st.elapsed : st.ticks;

    if (dead) {
      if (def.onDeath && !st.died) { st.died = true; def.onDeath(entity, level); }
    } else {
      def.onTick(entity, level, remaining);
    }

    if (!infinite) {
      st.ticks--;
      if (st.ticks <= 0) expired.push(name);
    }
  });

  for (let i = 0; i < expired.length; i++) {
    const name = expired[i];
    const st = stateOf(entity, name);
    const def = EFFECTS[name];
    deleteState(entity, name);
    if (def && st && !def.instant) def.onRemove(entity, levelOf(st));
  }

  updateDerived(entity);

  // Ambient swirl in the blended effect colour. Beacon ("ambient") effects pull
  // it half as hard, and an invisible entity shows nothing at all.
  if ((entity._fxTick & 7) === 0 && !entity.invisible && effectCount(entity) > 0) {
    const c = effectColor(entity.effects);
    if (c) burst(entity, c, 'magic', 1);
  }
}

/**
 * Applies a single tick of one named effect to an entity, ignoring whether the
 * entity actually carries it. Instant effects fire their whole payload.
 */
export function applyEffectTick(entity, name, level = 0) {
  const def = EFFECTS[name];
  if (!def || !entity) return false;
  if (def.instant) { def.onApply(entity, level); return true; }
  const st = stateOf(entity, name);
  def.onTick(entity, level, st ? Math.max(1, st.ticks) : 1);
  return true;
}

/** Fires the death hooks (oozing, weaving, wind charged) for a dying entity. */
export function triggerDeathEffects(entity) {
  if (!entity || effectCount(entity) === 0) return;
  eachEffect(entity, (name, st) => {
    const def = EFFECTS[name];
    if (!def || !def.onDeath || !st || st.died) return;
    st.died = true;
    def.onDeath(entity, levelOf(st));
  });
}

// ===========================================================================
// Applying and removing
// ===========================================================================

/** True when `name` can legally be applied to `entity` right now. */
export function canApplyEffect(entity, name) {
  const def = EFFECTS[name];
  if (!def || !entity) return false;
  if (entity.removed) return false;
  if (entity.type === 'ender_dragon' && name !== 'glowing') return false;
  if (NON_LIVING_TYPES.has(entity.type) && name !== 'glowing') return false;
  if (def.immune && def.immune(entity)) return false;
  return true;
}

/**
 * Adds (or upgrades) an effect on an entity, following vanilla's stacking
 * rules: a stronger effect always wins, an equal one wins only when it lasts
 * longer. Pass `ticks = -1` for an infinite effect. Returns true when applied.
 */
export function addEffect(entity, name, ticks, level = 0, opts = {}) {
  const def = EFFECTS[name];
  if (!def || !entity) return false;
  if (!canApplyEffect(entity, name)) return false;
  const amp = Math.max(0, level | 0);
  const dur = (ticks === undefined || ticks === null) ? effectDuration(name, amp) : ticks | 0;
  if (def.instant) { def.onApply(entity, amp); return true; }

  const prev = stateOf(entity, name);
  if (prev) {
    const pAmp = levelOf(prev);
    if (pAmp > amp) return false;
    if (pAmp === amp && (prev.ticks < 0 || (dur >= 0 && prev.ticks >= dur))) return false;
    def.onRemove(entity, pAmp);
  }
  putState(entity, name, {
    level: amp,
    ticks: dur,
    ambient: !!opts.ambient,
    showParticles: opts.showParticles !== false,
    showIcon: opts.showIcon !== false,
    elapsed: 0,
  });
  def.onApply(entity, amp);
  return true;
}

/** Removes one effect, firing its cleanup hook. Returns true when it was there. */
export function removeEffect(entity, name) {
  const st = stateOf(entity, name);
  if (!st) return false;
  deleteState(entity, name);
  const def = EFFECTS[name];
  if (def) def.onRemove(entity, levelOf(st));
  return true;
}

/**
 * Clears every curable effect (what a bucket of milk does). Pass
 * `onlyHarmful = true` for honey-bottle style cleansing.
 */
export function clearEffects(entity, onlyHarmful = false) {
  if (!entity || effectCount(entity) === 0) return 0;
  const names = [];
  eachEffect(entity, (name) => {
    const def = EFFECTS[name];
    if (!def || !def.curative) return;
    if (onlyHarmful && !def.harmful) return;
    names.push(name);
  });
  for (const n of names) removeEffect(entity, n);
  return names.length;
}

/** True when the entity currently carries the effect. */
export function hasEffect(entity, name) { return !!stateOf(entity, name); }
/** Human-facing level: 1 for "Speed I", 0 when the effect is absent. */
export function effectLevel(entity, name) {
  const st = stateOf(entity, name);
  return st ? levelOf(st) + 1 : 0;
}
/** Raw amplifier: 0 for "Speed I", -1 when the effect is absent. */
export function effectAmplifier(entity, name) {
  const st = stateOf(entity, name);
  return st ? levelOf(st) : -1;
}
/** Remaining duration in ticks (-1 for infinite, 0 when absent). */
export function effectTicks(entity, name) {
  const st = stateOf(entity, name);
  return st ? st.ticks : 0;
}

// ===========================================================================
// Queries used by the rest of the game
// ===========================================================================

/** True when the named effect is a good one (unknown and neutral effects are not). */
export function isBeneficial(name) {
  const def = EFFECTS[name];
  return !!def && def.beneficial;
}

/** True when the named effect is a debuff. */
export function isHarmful(name) {
  const def = EFFECTS[name];
  return !!def && def.harmful;
}

/**
 * Default duration in ticks for a potion of this effect at the given level.
 * Level II potions last half as long, exactly like vanilla brewing.
 */
export function effectDuration(name, level = 0) {
  const def = EFFECTS[name];
  if (!def) return 0;
  if (def.instant) return 1;
  const base = def.duration || 3600;
  return level > 0 ? Math.max(20, Math.floor(base / 2)) : base;
}

/**
 * Blended particle colour for an entity's effects, as a 0xRRGGBB integer.
 * Accepts a Map, a plain object, an array of entries, or the entity itself.
 * Returns 0 when nothing visible is active.
 */
export function effectColor(effectsMap) {
  let r = 0, g = 0, b = 0, total = 0;
  const consider = (name, st) => {
    const def = EFFECTS[name];
    if (!def || !def.particles) return;
    if (st && st.showParticles === false) return;
    const level = levelOf(st);
    const w = (st && st.ambient ? 0.5 : 1) * (level + 1);
    r += ((def.color >> 16) & 255) * w;
    g += ((def.color >> 8) & 255) * w;
    b += (def.color & 255) * w;
    total += w;
  };

  let src = effectsMap;
  if (src && src.effects) src = src.effects;          // an entity was passed in
  if (!src) return 0;
  if (Array.isArray(src)) {
    for (const e of src) {
      if (Array.isArray(e)) consider(e[0], e[1]);
      else if (e && typeof e === 'object') consider(e.name, e);
      else if (typeof e === 'string') consider(e, null);
    }
  } else if (isMap(src)) {
    src.forEach((st, name) => consider(name, st));
  } else if (typeof src === 'object') {
    for (const k in src) consider(k, src[k]);
  }
  if (total <= 0) return 0;
  return rgbToHex((r / total) / 255, (g / total) / 255, (b / total) / 255);
}

/** Every active effect on an entity, sorted for display. */
export function activeEffects(entity) {
  const out = [];
  eachEffect(entity, (name, st) => {
    const def = EFFECTS[name];
    if (!def || !st) return;
    out.push({ name, def, level: levelOf(st) + 1, amplifier: levelOf(st), ticks: st.ticks, ambient: !!st.ambient });
  });
  out.sort((a, b) => (a.def.beneficial === b.def.beneficial ? a.def.id - b.def.id : (a.def.beneficial ? -1 : 1)));
  return out;
}

/** "Strength II" for a name and amplifier. */
export function effectDisplayName(name, level = 0) {
  const def = EFFECTS[name];
  const base = def ? def.display : prettyName(name);
  return level > 0 ? base + ' ' + roman(level + 1) : base;
}

/** "1:30" for a tick count; "**:**" for an infinite effect. */
export function formatEffectTime(ticks) {
  if (ticks < 0) return '**:**';
  const s = Math.floor(ticks / TICKS_PER_SECOND);
  return Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0');
}

/** Tooltip/HUD lines for the effects on an entity. */
export function effectTooltipLines(entity) {
  return activeEffects(entity).map((e) => ({
    text: effectDisplayName(e.name, e.amplifier) + '  ' + formatEffectTime(e.ticks),
    color: e.def.beneficial ? '#7cafc6' : (e.def.harmful ? '#fc5454' : '#cccccc'),
  }));
}

// ===========================================================================
// Modifier helpers - the numbers the movement, combat and mining code want
// ===========================================================================

/** Sum of one modifier key over every active effect, scaled by level. */
export function effectModifier(entity, key) {
  let sum = 0;
  eachEffect(entity, (name, st) => {
    const def = EFFECTS[name];
    if (!def || !st) return;
    const v = def.modifiers[key];
    if (v) sum += v * (levelOf(st) + 1);
  });
  return sum;
}

/** Movement speed multiplier from speed/slowness. Never negative. */
export function speedMultiplier(entity) {
  return clamp(1 + effectModifier(entity, 'speed'), 0, 8);
}

/** Flat melee damage added by strength/weakness. */
export function attackDamageBonus(entity) {
  return effectModifier(entity, 'damage');
}

/** Attack-cooldown speed multiplier from haste/mining fatigue. */
export function attackSpeedMultiplier(entity) {
  return clamp(1 + effectModifier(entity, 'attackSpeed'), 0.1, 8);
}

/** Extra max health granted by health boost. */
export function maxHealthBonus(entity) {
  return effectModifier(entity, 'maxHealth');
}

/** 0..1 knockback resistance granted by resistance. */
export function knockbackResistance(entity) {
  return clamp(effectModifier(entity, 'knockbackResist'), 0, 1);
}

/** Incoming-damage multiplier from resistance (0 = immune, Resistance V). */
export function damageMultiplier(entity) {
  return clamp(1 - effectModifier(entity, 'resist'), 0, 1);
}

const FATIGUE_FACTOR = [0.3, 0.09, 0.0027, 0.00081];

/** Block-breaking speed multiplier from haste, conduit power and fatigue. */
export function miningSpeedMultiplier(entity) {
  let m = 1;
  const haste = effectAmplifier(entity, 'haste');
  if (haste >= 0) m *= 1 + 0.2 * (haste + 1);
  const conduit = effectAmplifier(entity, 'conduit_power');
  if (conduit >= 0 && entity.inWater) m *= 1 + 0.2 * (conduit + 1);
  const fatigue = effectAmplifier(entity, 'mining_fatigue');
  if (fatigue >= 0) m *= FATIGUE_FACTOR[Math.min(fatigue, FATIGUE_FACTOR.length - 1)];
  return m;
}

/** Jump velocity multiplier from jump boost. */
export function jumpMultiplier(entity) {
  return clamp(1 + effectModifier(entity, 'jump'), 0.25, 4);
}

/** Blocks of fall distance cancelled by jump boost / slow falling. */
export function fallDamageReduction(entity) {
  if (hasEffect(entity, 'slow_falling')) return Infinity;
  const jb = effectAmplifier(entity, 'jump_boost');
  return jb >= 0 ? jb + 1 : 0;
}

/** Swim speed multiplier from dolphin's grace and conduit power. */
export function swimSpeedMultiplier(entity) {
  return clamp(1 + effectModifier(entity, 'swim'), 0.25, 4);
}

/** Loot-table luck from luck / bad luck. */
export function luckBonus(entity) {
  return effectModifier(entity, 'luck');
}

/** Extra light the renderer should mix in: +1 night vision, -1 blindness. */
export function brightnessOf(entity) {
  return entity ? (entity.brightness || 0) : 0;
}

// ===========================================================================
// Persistence
// ===========================================================================

/** Plain-object form of an entity's effects, for save.js. */
export function serializeEffects(entity) {
  const out = [];
  eachEffect(entity, (name, st) => {
    if (!EFFECTS[name] || !st) return;
    out.push({ name, level: levelOf(st), ticks: st.ticks, ambient: !!st.ambient });
  });
  return out;
}

/** Restores serialized effects onto an entity, re-running their apply hooks. */
export function deserializeEffects(entity, data) {
  if (!entity) return;
  entity.effects = new Map();
  entity._healthBoost = 0;
  entity._baseMaxHealth = undefined;
  if (!Array.isArray(data)) return;
  for (const e of data) {
    const def = EFFECTS[e && e.name];
    if (!def || def.instant) continue;
    const amp = Math.max(0, e.level | 0);
    // The saved maxHealth already includes any health boost, so tell the hook
    // how much of it is ours before it recomputes the base value.
    if (def.modifiers.maxHealth) entity._healthBoost = def.modifiers.maxHealth * (amp + 1);
    putState(entity, e.name, {
      level: amp,
      ticks: e.ticks === undefined ? def.duration : e.ticks | 0,
      ambient: !!e.ambient,
      showParticles: true,
      showIcon: true,
      elapsed: 0,
    });
    def.onApply(entity, amp);
  }
}

/** Total number of registered effects. Handy for the debug overlay. */
export const EFFECT_COUNT = EFFECT_NAMES.length;

export default EFFECTS;
